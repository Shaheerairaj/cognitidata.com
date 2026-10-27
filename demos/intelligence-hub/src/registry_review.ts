// The review band (ADR-083) — the ambiguous rows the ingest pipeline holds back for a human
// call. This module is the pure core: the reason → plain-language question + choices mapping
// (mocks: review-options.html option A) and the /review/decide payload builder. Fetch helpers
// live at the bottom; the pure parts are unit-tested.
import { apiUrl, withSession } from "./api";
import type { SearchParams } from "./registry_search";

// the closed vocabulary locked in ADR-083 — new demotion sources must extend it explicitly
export type ReviewReason =
  | "duplicate"
  | "not_lodging"
  | "location_mismatch"
  | "possibly_closed"
  | "twin_conflict";

export type ReviewDecision = "merge" | "keep" | "not_hotel" | "closed";

// the canonical row a duplicate/twin_conflict may merge into
export type ReviewCandidate = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  keys?: number | null;
  locality?: string | null;
  ownerName?: string | null;
  website?: string | null;
};

// A "40 m apart" / "1.2 km apart" label between two points — the key evidence for a merge call.
export function distanceLabel(aLat: number, aLng: number, bLat: number, bLng: number): string {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  const m = 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  return m < 1000 ? `${Math.round(m)} m apart` : `${(m / 1000).toFixed(1)} km apart`;
}

// one open review row (wire shape from POST /api/registry/review)
export type ReviewRow = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  reason: ReviewReason;
  detail?: string | null;
  candidate?: ReviewCandidate | null;
  // the thin data we have on a held-back row (it isn't enriched) — shown in the review table
  locality?: string | null;
  category?: string | null;
  brand?: string | null;
  website?: string | null;
  socials?: string[] | null; // facebook / instagram / … links — real evidence for the call
  address?: string | null;
  phone?: string | null;
};

// A short platform label for a social URL (the review table renders these as links).
export function socialLabel(url: string): string {
  const u = url.toLowerCase();
  if (u.includes("facebook.") || u.includes("fb.")) return "Facebook";
  if (u.includes("instagram.")) return "Instagram";
  if (u.includes("twitter.") || u.includes("x.com")) return "X";
  if (u.includes("tiktok.")) return "TikTok";
  if (u.includes("youtube.") || u.includes("youtu.be")) return "YouTube";
  if (u.includes("linkedin.")) return "LinkedIn";
  return "Social";
}

export type ReviewChoice = { label: string; decision: ReviewDecision; primary?: boolean };

// A short "why it's here" label for the review table's flag column (plain words, not schema).
export function reviewReasonLabel(reason: ReviewReason | string): string {
  switch (reason) {
    case "duplicate":
    case "twin_conflict":
      return "Possible duplicate";
    case "not_lodging":
      return "Might not be a hotel";
    case "location_mismatch":
      return "May be in another place";
    case "possibly_closed":
      return "May have closed";
    default:
      return "Needs a look";
  }
}

// The plain-language question + choices for a row's reason. Decisions are always in the user's
// words, never the schema's; the primary choice is the pipeline's best guess. The "merge" choice
// is gated on a resolved `candidate` (ADR-083 handoff note 1: /review omits candidate when the
// strong twin can't be resolved by name — offering merge then would no-op).
export function reviewPrompt(row: ReviewRow, market: string): { question: string; choices: ReviewChoice[] } {
  switch (row.reason) {
    case "duplicate":
    case "twin_conflict": {
      const choices: ReviewChoice[] = [];
      if (row.candidate) choices.push({ label: "Same place — merge", decision: "merge", primary: true });
      choices.push({ label: row.candidate ? "They're different" : "Keep it", decision: "keep", primary: !row.candidate });
      choices.push({ label: "Not a hotel", decision: "not_hotel" });
      return { question: "Is this the same place you already have?", choices };
    }
    case "not_lodging":
      return {
        question: "Is this a hotel you'd pursue?",
        choices: [
          { label: "Yes, keep it", decision: "keep", primary: true },
          { label: "Not a hotel", decision: "not_hotel" },
        ],
      };
    case "location_mismatch":
      return {
        question: `Is this really in ${market}?`,
        choices: [
          { label: "Yes, it belongs here", decision: "keep", primary: true },
          { label: "Wrong place — remove", decision: "not_hotel" },
        ],
      };
    case "possibly_closed":
      return {
        question: "Has this closed?",
        choices: [
          { label: "Still open", decision: "keep", primary: true },
          { label: "Closed", decision: "closed" },
        ],
      };
    default:
      // Never return undefined — the backend's review_reason can carry an out-of-vocab value
      // (the singleton screen stores the LLM's raw reason), and a missing prompt would crash
      // the card. Fall back to the safe keep/not-a-hotel pair.
      return {
        question: "Is this a hotel you'd pursue?",
        choices: [
          { label: "Yes, keep it", decision: "keep", primary: true },
          { label: "Not a hotel", decision: "not_hotel" },
        ],
      };
  }
}

// the /api/registry/review/decide request body; the canonical id rides only on a merge
export function decidePayload(
  row: ReviewRow,
  decision: ReviewDecision,
): { gers_id: string; decision: ReviewDecision; canonical_gers_id?: string } {
  if (decision === "merge" && row.candidate) {
    return { gers_id: row.id, decision, canonical_gers_id: row.candidate.id };
  }
  return { gers_id: row.id, decision };
}

export type ReviewDecisionResult = {
  results: { gers_id: string; decision: ReviewDecision; ok: boolean; error?: string }[];
  twin_conflicts: { alias: string; canonical: string }[];
};

// The /api/registry/review request body: the scan's geometry minus the label, in the backend's
// snake_case (pin `{lat,lng,radius_km}` OR area `{bbox,polygon}`).
export function reviewRequestBody(params: SearchParams): Record<string, unknown> {
  return "bbox" in params
    ? { bbox: params.bbox, polygon: params.polygon }
    : { lat: params.lat, lng: params.lng, radius_km: params.radiusKm };
}

// ── fetch helpers (bind to the ADR-083 endpoints; backend Phases B–C serve them) ──
export async function fetchReviewRows(params: SearchParams): Promise<ReviewRow[]> {
  const res = await fetch(apiUrl("/api/registry/review"), {
    method: "POST",
    headers: { "content-type": "application/json", ...withSession() },
    body: JSON.stringify(reviewRequestBody(params)),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { rows?: ReviewRow[] };
  return data.rows ?? [];
}

// /review/decide is a BATCH endpoint (ADR-083): one transaction over many decisions.
export async function postReviewDecisions(
  items: { row: ReviewRow; decision: ReviewDecision }[],
): Promise<ReviewDecisionResult> {
  const decisions = items.map(({ row, decision }) => decidePayload(row, decision));
  const res = await fetch(apiUrl("/api/registry/review/decide"), {
    method: "POST",
    headers: { "content-type": "application/json", ...withSession() },
    body: JSON.stringify({ decisions }),
  });
  if (!res.ok) throw new Error(`review decision failed (${res.status})`);
  return (await res.json()) as ReviewDecisionResult;
}

export const postReviewDecision = (row: ReviewRow, decision: ReviewDecision): Promise<ReviewDecisionResult> =>
  postReviewDecisions([{ row, decision }]);
