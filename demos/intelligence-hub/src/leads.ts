// Manual lead ingestion — pure helpers for the AddLeads slide-over (ADR-046).
// Wire contract: docs/superpowers/specs/2026-06-28-manual-lead-ingestion-design.md.
// parse → review-gate → commit. These are the testable pieces; the slide-over UI
// (components/AddLeads.tsx) is the shell around them.

// Canonical template columns — MUST match backend leads.TEMPLATE_COLUMNS.
export const TEMPLATE_COLUMNS = [
  "name", "city", "country", "locality", "segment", "key_count",
  "brand", "affiliation", "website",
  "owner_name", "owner_email", "owner_phone", "owner_linkedin", "source_url", "notes",
] as const;

export type Classification = "new" | "known" | "ambiguous";
export type Match = { hotel_id: string; name: string; score: number } | null;
export type Normalization = { field: string; from: string; to: string };
export type CellError = { row: number; column: string; value: string; reason: string };

// One row of the /api/leads/parse response.
export type ParsedLead = {
  tempId: string;
  name: string;
  city: string | null;
  country: string | null;
  fields: Record<string, string | number>;
  extra: Record<string, string>;
  normalizations: Normalization[];
  cellErrors?: CellError[];
  classification: Classification;
  match: Match;
};

export type ParseResponse = {
  run_id: string;
  mode: "template" | "llm" | "llm-fallback";
  summary: { new: number; known: number; ambiguous: number };
  truncated: boolean;
  dropped?: number;
  leads: ParsedLead[];
};

// What the user decides per row in the review gate. `skip` drops the row from the commit.
export type Resolution = "insert" | "merge" | "skip";

// One row of the /api/leads/commit request.
export type LeadCommit = {
  name: string;
  city: string | null;
  country: string | null;
  fields: Record<string, string | number>;
  extra: Record<string, string>;
  action: "insert" | "merge";
  matchHotelId: string | null;
};
export type CommitRequest = { addedBy: string; leads: LeadCommit[] };
export type CommitResponse = {
  run_id: string;
  inserted: number;
  merged: number;
  committed: { hotel_id: string; name: string; action: string }[];
};

// The default action for a row before the user overrides it: known → merge (it's the same
// hotel), new / ambiguous → insert (create-new is the safe default; merging is the user's call).
export function defaultResolution(lead: ParsedLead): "insert" | "merge" {
  return lead.classification === "known" && lead.match ? "merge" : "insert";
}

// CSV template (canonical header row only) — Path A accepts .csv, so this needs no xlsx library.
export function templateCsv(): string {
  return TEMPLATE_COLUMNS.join(",") + "\n";
}

const resolutionOf = (lead: ParsedLead, resolutions: Record<string, Resolution>): Resolution =>
  resolutions[lead.tempId] ?? defaultResolution(lead);

// Turn the reviewed rows + per-row resolutions into the commit payload. Skipped rows are dropped;
// merge carries the matched hotel id (null when there's no match — the UI only offers merge when
// a match exists, so the backend's merge-needs-id guard won't trip in practice).
export function buildCommitPayload(
  addedBy: string,
  leads: ParsedLead[],
  resolutions: Record<string, Resolution>,
): CommitRequest {
  const out: LeadCommit[] = [];
  for (const lead of leads) {
    const action = resolutionOf(lead, resolutions);
    if (action === "skip") continue;
    out.push({
      name: lead.name,
      city: lead.city,
      country: lead.country,
      fields: lead.fields,
      extra: lead.extra,
      action,
      matchHotelId: action === "merge" ? (lead.match?.hotel_id ?? null) : null,
    });
  }
  return { addedBy, leads: out };
}

// Footer tallies for the commit button. Skips are surfaced so nothing silently vanishes.
export function commitCounts(
  leads: ParsedLead[],
  resolutions: Record<string, Resolution>,
): { insert: number; merge: number; skip: number } {
  const counts = { insert: 0, merge: 0, skip: 0 };
  for (const lead of leads) counts[resolutionOf(lead, resolutions)] += 1;
  return counts;
}

// Build the /api/leads/export query string. With `ids` (selected rows), the backend exports just
// those and ignores the market fields; without it, the whole market (segment included so the
// export matches the segment-scoped on-screen list). Empty/null fields are omitted.
export function exportQuery(m: {
  city: string; country?: string | null; segment?: string | null; locality?: string | null;
  ids?: string[];
}): string {
  const p = new URLSearchParams({ city: m.city });
  if (m.country) p.set("country", m.country);
  if (m.segment) p.set("segment", m.segment);
  if (m.locality) p.set("locality", m.locality);
  if (m.ids && m.ids.length > 0) p.set("ids", m.ids.join(","));
  return p.toString();
}
