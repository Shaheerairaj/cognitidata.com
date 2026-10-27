import { Fragment, type Dispatch, type PointerEvent as ReactPointerEvent, type ReactNode, type SetStateAction, useEffect, useRef, useState } from "react";
import "./workbench.css";
import {
  apiUrl, bulkDeleteHotels, editHotelField, exportOutreach, fetchTeaser, fetchHotelsByIds,
  saveContacts, saveOutreachField, teaserFileUrl, teaserPreviewSrc, withSession, type TeaserMeta,
} from "./api";
import {
  exportTargets, outreachBlockers, recipientLabel,
  withEditedField,
  type OutreachEditableField, type OutreachPackage,
} from "./outreach";
import {
  classify, passingIds, matchRank, estMinutes, ownerUnresolved, ownerToResearch, ownerStatus,
  ownerCooldownUntil, factAge,
  reviewsStatus, contactsStatus, factsAttempted, enrichPending, noHotelData, applyAttempted, applyClassified, shouldShowResearching,
  contactCards, type OwnerContact, applyContactOp, applyOperations, applySelectionOps,
  enrichJobSummary, gapCounts, filterSignature, showGapDivider,
  affiliationLabel, affiliationTooltip, AFFILIATION_OPTS,
  type Filter, type FilterState, type FilterOp, type FilterAttr, type Operation, type EnrichKind, type KindSummary, type UserContact, type AttemptedMap,
} from "./filters";
import { appendToken, appendConfirm, releasesComposer, streamSSE, type Turn } from "./chat_stream";
import {
  DEFAULT_RADIUS_KM, SLIDER_STEPS, cellProgress, clampRadius, kmToSlider, radiusLabel, sliderToKm,
  googleMapsUrl, mergeBarProgress, moveActive, ownerResearched, pinState, previewBbox,
  previewQuery, reduceProgress, resetViewTarget, runRegistrySearch, timeProgress,
  type Candidate, type PreviewFacts, type Progress, type SearchParams,
} from "./registry_search";
import { AddLeads } from "./components/AddLeads";
import { demoSuggestions, resetDemo } from "./demo/server";
import { AssistantRail } from "./components/AssistantRail";
import { Tour } from "./components/Tour";
import { fetchReviewRows, postReviewDecision, postReviewDecisions, type ReviewDecision, type ReviewRow } from "./registry_review";
import { ReviewTable } from "./components/ReviewTable";
import { DETENT_PCT, nextDetent, snapDetent, type Detent } from "./layout";
import { MarketMap, areaBbox, type MapArea, type MapPinDatum } from "./components/MarketMap";
import { clear as clearSession, load as loadSession, save as saveSession } from "./session";
import { Markdown } from "./components/Markdown";
import { OWNER_TYPES, type OwnerResearch } from "./types";
import { HINT, LABEL, ownerResearchFromStored, reachRows, type ReachRow } from "./reach";
import { exportQuery } from "./leads";

// Two-pane "workbench" for the packed-query → cost-ordered plan → live-set owner research flow.
// Faithful port of funnel-workspace.html (home → rail+grid → dossier slide-over), with the
// mock's STATIC `H` array replaced by LIVE SSE off the backend (ADR-021 — one entry point):
//
//   POST /api/chat  {text}   → route, then the chosen branch INLINE:
//       plan   → plan + status + hotels + (done | error)          [fills the workspace]
//       lookup → lookup_result                                    [answered on the home screen]
//       other  → message                                          [answered on the home screen]
//   POST /api/enrich/job {hotels, kinds} → unified enrichment job over the target rows, running
//       the chosen kinds (owner [+ its contact phase, ADR-114] → contacts → reviews) in one single-flight pass (ADR-050, "Enrich" popover)
//
// Both stream text/event-stream; we consume them with the streamSSE idiom: fetch POST →
// res.body.getReader() → TextDecoder → buffer + split on "\n\n" → strip "data: " → JSON.parse.
//
// ADR-030: filtering is CLIENT-OWNED. The server serves the raw universe; the client runs the
// single three-state engine (`filters.ts`) over a live `Filter[]` that chat predicates only
// SEED. Owner research is a live-set action targeting checked rows (else the filtered live set),
// so there is no server `gate` frame anymore.
//
// Convertibility (Cognitidata-fit) scoring is a DEFERRED slice — the Convert column is always "·",
// and survivors sort by keys desc (never by a score). The dossier shows only real data we
// have (name/keys/city, and once enriched: owner/ownerType + owner.sources), plus one honest
// "arrive in a later slice" line. Nothing about a resolution chain / why-now / portfolio is
// fabricated.

type CostTier = "free" | "cheap" | "owner";
type Confidence = "high" | "medium" | "low";
// ADR-050 — "What guests say" structured themes: top-3 liked / top-3 disliked, most-mentioned first.
type ReviewTheme = { theme: string; detail: string; source: string | null };
type ReviewThemes = { liked: ReviewTheme[]; disliked: ReviewTheme[] };

// ── wire frames (ADR-021: one /api/chat stream — route, then the chosen branch inline) ──
type RouteFrame = { type: "route"; intent: string };
type LookupResultFrame = {
  type: "lookup_result";
  shape: string;
  answer: string;
  sql?: string;
  stats?: Record<string, unknown>;
  hotels?: HotelWire[];
};
type MessageFrame = { type: "message"; text: string };

// Chat-over-the-live-set (read-only): the workbench chat returns a `refine` operations frame, or —
// for an `ask` — a stream of plain-text `token` frames (ADR-021). The `Operation` reducer lives in
// filters.ts; the token-accumulation reducer (`appendToken`) lives in chat_stream.ts (both pure,
// unit-tested). SortKey is declared below.
type RefineFrame = { type: "refine"; reply: string; operations: Operation[]; coverage?: string | null };
type TokenFrame = { type: "token"; text: string };
type ActFrame = { type: "act"; reply: string; operations: Operation[]; stagedAction: "ownerResearch" | null };

type Predicate = { term: string; resolvesTo: string; costTier: CostTier };
type PlanStep = { idx: number; name: string; note: string; costTier: CostTier };

type HotelWire = {
  id: string;
  name: string;
  city: string | null;
  country: string | null;
  segment: string | null;
  keys: number | null;
  residences: number | null;
  brand: string | null; // ADR-091 — verified brand_clean (the displayed brand; blank when null)
  brandRaw?: string | null; // ADR-091 — noisy raw metadata.brand, provenance/tooltip only
  ownerName: string | null;
  ownerEmail: string | null;
  ownerPhone: string | null;
  ownerLinkedin: string | null;
  ownerReachVia: string | null;
  ownerType: string | null;
  brandAffiliation?: string | null; // ADR-084 — brand/regional_chain/independent/unresolved
  affiliationSource?: string | null; // ADR-084 — the URL backing the affiliation verdict (dossier link)
  amenities: string[] | null;
  source?: string | null; // source_url — where the hotel was found (ADR-033 dossier link)
  officialWebsite?: string | null; // the hotel's own site (extracted, else heuristic from source)
  ownerSources?: string[] | null; // owner provenance links (metadata.enrichment.owner.sources)
  ownerConf?: Confidence | null; // owner confidence, from the same provenance block
  ownerAttemptedAt?: string | null; // when owner research last ran — drives status + re-research TTL (ADR-038)
  reviewsAttemptedAt?: string | null; // when reviews refresh last ran — 30-day TTL (ADR-049)
  factsAttemptedAt?: string | null; // when the facts phase last ran — drives "tried, none found" (ADR-064)
  contactsAttemptedAt?: string | null; // when the contacts phase last ran — drives "tried, none found" (ADR-064)
  ownerContacts?: OwnerContact[] | null;
  userContacts?: UserContact[] | null;
  ownerResearch?: OwnerResearch | null; // ADR-110 — the owner hunt's cast + best lead (null until the recipe ran)
  // ADR-039 — reviews & rates, seeded from the DB so the dossier shows them on load (not only on live refresh)
  starRating?: number | null;
  bookingRating?: number | null;
  bookingReviews?: number | null;
  reviewThemes?: ReviewThemes | null;
  reviewSummary?: string | null;
  roomCategories?: { category: string; priceFrom: string | null }[] | null;
  reviewSources?: string[] | null;
  outreach?: OutreachPackage | null; // ADR-062 — generated outreach package
  // ADR-030: NO filterState/reason — the client classifies rows from its own filter set.
  new?: boolean; // ADR-023: surfaced by the coverage web-sweep, not in the DB yet
  updatedAt?: string | null; // ADR-023: when the row's facts were last written (detail freshness)
  // ADR-079 map-first: rows MAY carry coordinates — map pins come from these; null = no pin.
  lat?: number | null;
  lng?: number | null;
};

// ADR-030: a structured chat-predicate seed for the UI filter controls (mirrors plan.cheap_filters).
type CheapFilterWire = { attr: Filter["attr"]; op: Filter["op"]; value: number | string; label: string };

type PlanFrame =
  | {
      type: "plan";
      universe: { city: string; country: string; segment?: string | null; locality?: string | null };
      predicates: Predicate[];
      steps: PlanStep[];
      cheapFilters?: CheapFilterWire[]; // ADR-030: structured seeds for the UI filter controls
    }
  | { type: "status"; stageIdx: number; message: string }
  | {
      type: "hotels";
      universeCount?: number;
      hotels: HotelWire[]; // ADR-030: raw rows — no server-side filter state
      append?: boolean; // ADR-023: append (don't replace) — the sweep's new hotels
    }
  | {
      type: "done";
      fromMemory?: boolean;
      status?: string;
      narrowing_suggestions?: string[];
      message?: string;
    }
  // ADR-027: basics auto-enrich in the background after the serve; rows reclassify live (client)
  | { type: "enriching"; count: number }
  | { type: "enriched"; hotel_id: string; fields: Record<string, EnrichField> }
  | { type: "enrich_done"; count: number; error?: boolean }
  | { type: "error"; message: string };

// Everything the single /api/chat stream can emit (ADR-021); refine/token are the read-only
// chat-over-the-live-set turns (carve/order, and the streamed interrogate answer) added on top of
// search/lookup/other. The rail's `Turn` model lives in chat_stream.ts.
type ChatStreamFrame = RouteFrame | PlanFrame | LookupResultFrame | MessageFrame | RefineFrame | TokenFrame | ActFrame;

type EnrichField = { value: number | string | string[]; confidence: Confidence; sources: string[] };
type EnrichFrame =
  | { type: "status"; hotel_id?: string; message: string }
  | { type: "phase"; kind: "owner" | "contacts" | "reviews"; count: number }
  | { type: "enriched"; hotel_id: string; hops?: number; fields: Record<string, EnrichField> }
  | { type: "done"; owner?: number; contacts?: number; reviews?: number; count?: number; attempted: AttemptedMap }
  | { type: "error"; message: string };

// The outreach batch job's SSE frames (ADR-062 phase 2) — consumed by runOutreachJob.
type OutreachFrame =
  | { type: "status"; message: string }
  | { type: "phase"; kind: "outreach"; count: number }
  | { type: "outreach"; hotel_id: string; package: OutreachPackage }
  | { type: "done"; generated: number; skipped: number; failed: number }
  | { type: "error"; message: string };

// ── local row + state model ─────────────────────────────────────────────────
export type Row = {
  id: string;
  name: string;
  city: string | null;
  country: string | null;
  segment: string | null;
  keys: number | null;
  residences: number | null;
  brand: string | null; // ADR-091 — verified brand_clean (the displayed brand; blank when null)
  brandRaw?: string | null; // ADR-091 — noisy raw metadata.brand, provenance/tooltip only
  ownerName: string | null;
  ownerEmail: string | null;
  ownerPhone: string | null;
  ownerLinkedin: string | null;
  ownerReachVia: string | null;
  ownerType: string | null;
  brandAffiliation?: string | null; // ADR-084 — brand/regional_chain/independent/unresolved
  affiliationSource?: string | null; // ADR-084 — the URL backing the affiliation verdict (dossier link)
  brandClassifiedAt?: string | null; // ADR-084 — when the classify pass ran on this row (distinguishes
                                     // classified-but-unresolved from never-classified; persisted in the snapshot)
  amenities: string[] | null;
  source?: string | null; // source_url — where the hotel was found (ADR-033 dossier link)
  officialWebsite?: string | null; // the hotel's own site (extracted, else heuristic from source)
  isNew?: boolean; // surfaced by the coverage web-sweep (ADR-023)
  updatedAt?: string | null; // facts last written — detail-freshness signal (ADR-023)
  // owner provenance — seeded from the DB on load (ADR-033) and refreshed live on enrich:
  ownerConf?: Confidence | null;
  ownerSources?: string[];
  ownerAttemptedAt?: string | null; // owner-research status + re-research TTL (ADR-038)
  ownerContacts?: OwnerContact[] | null;
  userContacts?: UserContact[] | null;
  ownerResearch?: OwnerResearch | null; // ADR-110 — feeds the dossier's "Who to reach" list
  enriched?: boolean;
  // ADR-039 — reviews & rates
  starRating?: number | null;
  bookingRating?: number | null;
  bookingReviews?: number | null;
  reviewThemes?: ReviewThemes | null;
  reviewSummary?: string | null;
  roomCategories?: { category: string; priceFrom: string | null }[] | null;
  reviewSources?: string[] | null;
  reviewsAttemptedAt?: string | null; // ADR-049 — reviews refresh status + 30-day TTL
  outreach?: OutreachPackage | null; // ADR-062 — generated outreach package (review room)
  factsAttemptedAt?: string | null; // ADR-064 — facts phase attempt → "tried, none found" for facts fields
  contactsAttemptedAt?: string | null; // ADR-064 — contacts phase attempt → "tried, none found" for contacts
  lat?: number | null; // ADR-079 map-first — the row's pin (null = no pin)
  lng?: number | null;
};

// ADR-030: a raw Row + its CLIENT-computed three-state classification against the live filter
// set. `dropped`/`unknown`/`reason` are derived (never stored), so the set re-filters instantly.
type ClassifiedRow = Row & {
  state: FilterState; // pass | unknown | fail — matched-first ordering keys off this
  dropped: boolean; // confirmed-fail — a KNOWN value that misses the filter; greyed (ADR-025)
  reason: string | null;
};

type OwnerStage = "queued" | "running" | "done" | "skipped";

// Progress-strip model (ADR-031): the one in-flight action, derived from existing state.
// `done`/`total` present ⇒ determinate bar; absent ⇒ indeterminate shimmer.
type Activity = {
  kind: "classify" | "sweep" | "enrich" | "owner";
  label: string;
  sub?: string;
  done?: number;
  total?: number;
  tone: "accent" | "owner";
};
type ActivityDone = { label: string; summary: string; tone: "accent" | "owner" };

// ADR-064 job-toast copy: per kind, distinguish "ran but found nothing" (the phase completed on
// ≥1 hotel — attempted non-empty — yet the count is 0) from "nothing to run" (attempted empty →
// the kind never fired). A positive count reads as "N owners" etc.
function enrichDoneSummary(
  counts: { owner?: number; contacts?: number; reviews?: number },
  attempted: AttemptedMap,
): string {
  const part = (label: string, count: number | undefined, ran: number): string | null => {
    if (count && count > 0) return `${count} ${label}`;
    if (ran > 0) return `${label}: none found`;
    return null; // kind didn't run → omit
  };
  const parts = [
    part("owners", counts.owner, attempted.owner.length),
    part("contacts", counts.contacts, attempted.contacts.length),
    part("reviews", counts.reviews, attempted.reviews.length),
  ].filter(Boolean) as string[];
  return parts.join(" · ") || "nothing to run";
}

// The SSE reader (streamSSE) lives in chat_stream.ts — shared with the registry pin-scan runner.

// Wire row → local Row, shared by typed search's `hotels` frames and the registry scan
// (ADR-079 phase 3 — the pin scan returns exactly the same wire shape).
const wireToRow = (h: HotelWire): Row => ({
  id: h.id,
  name: h.name,
  city: h.city,
  country: h.country,
  segment: h.segment,
  keys: h.keys,
  residences: h.residences,
  brand: h.brand,
  brandRaw: h.brandRaw,
  ownerName: h.ownerName,
  ownerEmail: h.ownerEmail,
  ownerPhone: h.ownerPhone,
  ownerLinkedin: h.ownerLinkedin,
  ownerReachVia: h.ownerReachVia,
  ownerType: h.ownerType,
  brandAffiliation: h.brandAffiliation,
  affiliationSource: h.affiliationSource ?? null,
  amenities: h.amenities,
  source: h.source ?? null,
  officialWebsite: h.officialWebsite ?? null,
  ownerAttemptedAt: h.ownerAttemptedAt ?? null,
  reviewsAttemptedAt: h.reviewsAttemptedAt ?? null,
  factsAttemptedAt: h.factsAttemptedAt ?? null,
  contactsAttemptedAt: h.contactsAttemptedAt ?? null,
  ownerContacts: h.ownerContacts ?? null,
  ownerResearch: h.ownerResearch ?? null, // ADR-110
  // seed owner provenance from the DB so the dossier's links/confidence show on load
  // (ADR-033); a live enrich frame later overwrites these for freshly-resolved rows
  ownerSources: h.ownerSources ?? undefined,
  ownerConf: h.ownerConf ?? undefined,
  // ADR-039 — seed reviews & rates from the DB so the dossier renders them on load;
  // a live reviews-refresh frame (ADR-049) later overwrites these for freshly-refreshed rows
  starRating: h.starRating ?? null,
  bookingRating: h.bookingRating ?? null,
  bookingReviews: h.bookingReviews ?? null,
  reviewThemes: h.reviewThemes ?? null,
  reviewSummary: h.reviewSummary ?? null,
  roomCategories: h.roomCategories ?? null,
  reviewSources: h.reviewSources ?? null,
  isNew: Boolean(h.new),
  updatedAt: h.updatedAt ?? null,
  outreach: h.outreach ?? null, // ADR-062 — stored packages light up the review room
  lat: h.lat ?? null, // ADR-079 map-first — pins come from these
  lng: h.lng ?? null,
});

const confDots = (c: Confidence | null | undefined): number =>
  c === "high" ? 3 : c === "medium" ? 2 : c === "low" ? 1 : 0;

// Medium-confidence owners are right about 6 in 10 (100-hotel calibration, 2026-09-23; high is
// 96%). The dots alone don't say that, so medium gets a visible "unconfirmed" tag + tooltip in
// the table and the dossier. High/low/absent render nothing (low never reaches the client — the
// gate rejects it).
export const OWNER_UNCONFIRMED_TIP =
  "Medium confidence — about 6 in 10 are right. Check the sources before contacting.";
export function OwnerConfTag({ conf }: { conf: Confidence | null | undefined }) {
  if (conf !== "medium") return null;
  return <span className="own-unconf" title={OWNER_UNCONFIRMED_TIP}>unconfirmed</span>;
}

// Sortable table columns → the row value each sorts on (numbers sort numerically, nulls last).
type SortKey = "name" | "keys" | "stars" | "rating" | "brand" | "affiliation" | "ownerType" | "ownerName" | "ownerEmail" | "amenities";
const SORT_ACCESSORS: Record<SortKey, (r: Row) => string | number | null> = {
  name: (r) => r.name,
  keys: (r) => r.keys, // the combined Keys / Residences column sorts on keys
  stars: (r) => r.starRating ?? null,
  rating: (r) => r.bookingRating ?? null,
  brand: (r) => r.brand,
  affiliation: (r) => r.brandAffiliation ?? null,
  ownerType: (r) => r.ownerType,
  ownerName: (r) => r.ownerName,
  ownerEmail: (r) => r.ownerEmail,
  amenities: (r) => r.amenities?.length ?? null,
};
const NUMERIC_SORT = new Set<SortKey>(["keys", "stars", "rating", "amenities"]);

// ── ADR-086: column-header filtering (Model A) ────────────────────────────────
// One table describing every column: how it sorts and (if filterable) how its funnel popover
// edits the client filter set. v1 filterable columns all reuse existing FilterAttrs, so the
// three-state engine (filters.ts) is untouched. `cost: "research"` marks a paid-enrichment
// column (◷) — filtering it leaves un-enriched rows as "unknown" (kept), not dropped.
// Display labels live here too. The ownerType grid column was removed, but the "Owner category"
// label is kept: the chat planner can still emit an ownerType filter, which renders as a
// remove-only chip (no column popover to edit it) using this label — the stored field/taxonomy is
// unchanged. Affiliation (branded/independent) is deferred to ADR-084.
const ATTR_LABEL: Record<string, string> = {
  name: "Hotel", keys: "Keys", residences: "Residences", brand: "Brand",
  ownerType: "Owner category", ownerName: "Owner", segment: "Segment", company: "Company",
  brandAffiliation: "Affiliation",
};
// Filter attrs the chat planner doesn't understand: client-only UI filters, stripped from the
// chat live-set payload (the backend FilterAttr Literal would 422 on them). `name` (ADR-086) and
// `segment` are client-only — the backend FilterAttr omits both (segment is set at search time via
// the universe, never a chat refine filter — ADR-030/063). ADR-087: brandAffiliation is now a
// planner-emittable attr ("independent" → the ADR-084 signal), so it rides the payload normally.
const CLIENT_ONLY_ATTRS = new Set<FilterAttr>(["name", "segment"]);
type ColFilter =
  | { kind: "range"; ranges: { attr: FilterAttr; label: string }[] }
  | { kind: "enum"; attr: FilterAttr; opts: readonly string[] }
  | { kind: "text"; attr: FilterAttr };
// `popRight` anchors the funnel popover to the header's right edge (right-side columns would
// otherwise overflow the horizontally-scrolling grid and get clipped).
type ColDef = { id: string; sortKey: SortKey; label: string; numeric?: boolean; cost?: "research"; popRight?: boolean; filter?: ColFilter };
const COLUMNS: ColDef[] = [
  { id: "name", sortKey: "name", label: "Hotel", filter: { kind: "text", attr: "name" } },
  { id: "keys", sortKey: "keys", label: "Keys / Res", numeric: true,
    filter: { kind: "range", ranges: [{ attr: "keys", label: "Keys" }, { attr: "residences", label: "Residences" }] } },
  { id: "stars", sortKey: "stars", label: "Class", numeric: true },
  { id: "rating", sortKey: "rating", label: "Guest rating", numeric: true },
  { id: "brand", sortKey: "brand", label: "Brand", filter: { kind: "text", attr: "brand" } },
  { id: "affiliation", sortKey: "affiliation", label: "Affiliation",
    filter: { kind: "enum", attr: "brandAffiliation", opts: AFFILIATION_OPTS } },
  { id: "ownerName", sortKey: "ownerName", label: "Owner", cost: "research", popRight: true,
    filter: { kind: "text", attr: "ownerName" } },
  { id: "ownerEmail", sortKey: "ownerEmail", label: "Owner email" },
  { id: "amenities", sortKey: "amenities", label: "Amenities" },
];
// The FilterAttrs a column's funnel owns (for the "active" header state + editable chips).
const colAttrs = (c: ColDef): FilterAttr[] =>
  !c.filter ? [] : c.filter.kind === "range" ? c.filter.ranges.map((r) => r.attr) : [c.filter.attr];
// Reverse map: which column popover edits a given attr (segment/company have no column → chip is
// remove-only). Built once from COLUMNS.
const ATTR_TO_COL: Record<string, string> = Object.fromEntries(
  COLUMNS.flatMap((c) => colAttrs(c).map((a) => [a, c.id])),
);

// A compact chip label for one chat operation (what a refine turn did to the grid).
function opChipLabel(op: Operation): string {
  switch (op.type) {
    case "addFilter": return `filter · ${op.filter.label}`;
    case "removeFilter": return `removed · ${op.attr}`;
    case "clearFilters": return "cleared filters";
    case "setSort": return `sort · ${op.key} ${op.dir === "asc" ? "↑" : "↓"}`;
    case "setSelection": return `select · ${op.ids.length} rows`;
    case "clearSelection": return "cleared selection";
  }
}

// The assistant panel's empty-state hint chips come from the demo's recorded questions
// (demoSuggestions) — click one to drop it into the rail chatbox.

export default function Workbench() {
  // ── Session persistence (full-snapshot restore across refresh + tabs) ──
  // The durable working state, mirrored to localStorage. `selectedIds` persists as an array
  // (Sets are not JSON-serializable). Transient/in-flight fields are deliberately NOT persisted
  // so a restored session comes back clean (no stuck progress). A new session starts only on
  // goHome (return to the home/search screen). See session.ts.
  type Snapshot = {
    phase: "home" | "work" | "outreach";
    rows: Row[];
    universeCount: number;
    place: { city: string; country: string; locality: string | null } | null;
    filters: Filter[];
    selectedIds: string[];
    sort: { key: SortKey; dir: "asc" | "desc" };
    tableFilter: string;
    hideDropped: boolean;
    thread: Turn[];
    segment: string | null;
    steps: PlanStep[];
    doneInfo: {
      fromMemory?: boolean;
      status?: string;
      narrowing?: string[];
      message?: string;
    } | null;
    openId: string | null;
    reviewLeadId?: string | null; // ADR-062 — the lead open in the outreach review room
    reviewIds?: string[]; // ADR-065 — the review set (leads brought over by the Outreach button)
    // ADR-079 map-first — the searched area (recenters the resident map on restore) + view prefs
    area?: MapArea | null;
    railOpen?: boolean;
    detent?: Detent;
  };
  const [restored] = useState(() => loadSession<Snapshot>());

  const [phase, setPhase] = useState<"home" | "work" | "outreach">(restored?.phase ?? "home");
  const [pending, setPending] = useState(false);  // classifying a typed turn, before the route frame
  // One chat turn at a time: locked from submit until the set is on screen (releasesComposer).
  // Prevents the mid-sweep race where a turn sent over an empty grid ships no liveSet and the
  // router downgrades a refine to a DB lookup.
  const [chatBusy, setChatBusy] = useState(false);
  const [sweeping, setSweeping] = useState(false);  // a coverage web-sweep is running (ADR-023)
  const [scanning, setScanning] = useState(false);  // a registry search is streaming (the finding moment)
  const [classifying, setClassifying] = useState(false);  // ADR-084: brand-affiliation classify pass running

  // ── map-first discovery state (ADR-079) ──────────────────────────────────
  // Home walks ask → confirm → finding on the resident map; `area` null = ask,
  // set = confirm, `scanning` = finding. Results land → phase "work" (map stays on top).
  const [marketQuery, setMarketQuery] = useState("");
  const [suggest, setSuggest] = useState<{ items: Candidate[]; active: number }>({ items: [], active: -1 });
  const suggestSeq = useRef(0); // drops stale preview responses (fast typing)
  const [area, setArea] = useState<MapArea | null>(restored?.area ?? null);
  // The map flies only when this changes — handle drags reshape the bbox without minting one.
  const [fitKey, setFitKey] = useState<string | null>(restored?.area ? "restored" : null);
  const [facts, setFacts] = useState<PreviewFacts | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null); // the finding strip's counter
  // The finding bar (hybrid time+signal): time eases it toward 85% over the preview's
  // est_seconds (fallback 60 s); real progress frames snap it FORWARD onto the 85–98 band;
  // done resolves the strip. scanMeta is stamped when the scan starts.
  const [barPct, setBarPct] = useState(0);
  const scanMeta = useRef<{ start: number; expected: number }>({ start: 0, expected: 0 });
  // map⇄list divider detent (mock 24) — replaces the old binary map-collapse
  const [detent, setDetent] = useState<Detent>(restored?.detent ?? "balanced");
  // the collapsible left assistant rail (mock 24); open by default
  const [railOpen, setRailOpen] = useState(restored?.railOpen ?? true);
  const [seenAnswers, setSeenAnswers] = useState(0); // hub turns already seen → the badge count
  // ADR-083 — the review band: ambiguous rows held back from the served set, fetched after a
  // scan lands. `reviewOpen` gates the focused one-at-a-time decision flow (D3). Not persisted:
  // the queue is re-derivable from the area, and decisions mutate it server-side.
  const [reviewBand, setReviewBand] = useState<ReviewRow[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const reviewFocusSeq = useRef(0); // mints a fresh map-fly key each time a review row is clicked
  const [hoverId, setHoverId] = useState<string | null>(null); // row hover ↔ pin highlight
  // Row click = focus (feedback #10): the map flies to the pin and it stays lit until the
  // next focus. `mapFocus` mints a key per click so re-clicking the same row re-flies.
  const [focusId, setFocusId] = useState<string | null>(null);
  const [mapFocus, setMapFocus] = useState<{ lng: number; lat: number; key: string } | null>(null);
  const [leadCard, setLeadCard] = useState<{ id: string; x: number; y: number } | null>(null);

  // the resolved place (from the /api/chat route frame)
  const [place, setPlace] = useState<{ city: string; country: string; locality: string | null } | null>(restored?.place ?? null);

  // plan content (rendered in the workspace rail — no separate plan screen)
  const [steps, setSteps] = useState<PlanStep[]>(restored?.steps ?? []);
  const [segment, setSegment] = useState<string | null>(restored?.segment ?? null);

  // work-phase content
  const [rows, setRows] = useState<Row[]>(restored?.rows ?? []);
  const [universeCount, setUniverseCount] = useState(restored?.universeCount ?? 0);
  // A restored working set is a snapshot from when it was saved; re-read its rows from the database
  // once so enrichment written since (another tab, a job, a script) shows — a free DB read, never a
  // search. On failure the snapshot stands. A pin the stored row lacks keeps the snapshot's.
  useEffect(() => {
    const ids = (restored?.rows ?? []).map((r) => r.id);
    if (ids.length === 0) return;
    let live = true;
    fetchHotelsByIds(ids)
      .then((hotels) => {
        if (!live) return;
        const fresh = new Map((hotels as HotelWire[]).map((h) => [h.id, wireToRow(h)]));
        setRows((prev) => prev.map((r) => {
          const f = fresh.get(r.id);
          return f ? { ...r, ...f, lat: f.lat ?? r.lat, lng: f.lng ?? r.lng } : r;
        }));
      })
      .catch(() => { /* keep the snapshot */ });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [ownerStage, setOwnerStage] = useState<OwnerStage>("queued");
  // ADR-030: client-owned filter set (seeded by the plan frame, edited by the UI controls)
  const [filters, setFilters] = useState<Filter[]>(restored?.filters ?? []);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set(restored?.selectedIds ?? []));
  const [doneInfo, setDoneInfo] = useState<{
    fromMemory?: boolean;
    status?: string;
    narrowing?: string[];
    message?: string;
  } | null>(restored?.doneInfo ?? null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // ── Layer-1 guided tour (ADR-090) ─────────────────────────────────────────
  // Auto-plays on every *new* market's work phase; a persistent mute (kh_tour_muted) is the
  // opt-out ("Don't show again"), and the top-bar ? replays it and clears the mute.
  const TOUR_MUTED_KEY = "kh_tour_muted";
  const tourMuted = () => {
    try { return localStorage.getItem(TOUR_MUTED_KEY) === "1"; } catch { return false; }
  };
  const [tourOpen, setTourOpen] = useState(false);
  // The market the tour last auto-played for — so it fires on a genuinely new market but not on a
  // mere re-entry into work (e.g. Back from outreach). Seeded from a restored work session so a
  // reload on the same market doesn't replay. Keyed on the place/area label ("new market").
  const tourMarket = useRef<string | null>(
    restored?.phase === "work" ? (restored?.place?.city ?? restored?.area?.label ?? null) : null,
  );
  const startTour = () => {
    try { localStorage.removeItem(TOUR_MUTED_KEY); } catch { /* ignore */ }
    setTourOpen(true);
  };
  const muteTour = () => {
    try { localStorage.setItem(TOUR_MUTED_KEY, "1"); } catch { /* ignore */ }
    setTourOpen(false);
  };
  useEffect(() => {
    if (phase !== "work") return;
    const key = place?.city ?? area?.label ?? null;
    if (!key || key === tourMarket.current) return;
    tourMarket.current = key;
    if (!tourMuted()) setTourOpen(true);
  }, [phase, place?.city]);

  // confirm-gated delete — one row (✕) or the selected set (top-bar button) (ADR-057)
  const [pendingDelete, setPendingDelete] = useState<{ ids: string[]; label: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [hideDropped, setHideDropped] = useState(restored?.hideDropped ?? false);
  // ✕ on the gap divider — keyed to the active filter signature, deliberately NOT persisted to the
  // session (the gap is still true after a refresh; re-dismissing is cheap). Spec 2026-07-07.
  const [dismissedGapSig, setDismissedGapSig] = useState<string | null>(null);
  // ADR-027: basics auto-enrich in the background after the serve; track in-flight progress for the loader
  const [enriching, setEnriching] = useState<{ total: number; done: number } | null>(null);
  const [tableFilter, setTableFilter] = useState(restored?.tableFilter ?? ""); // client-side quick-filter over the loaded set
  // ADR-102: header chip toggle — narrows the TABLE to rows whose <kind> enrichment never ran
  // ("pending"). Table-only (pins untouched); deliberately not persisted and not a Filter[].
  const [pendingView, setPendingView] = useState<EnrichKind | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>(restored?.sort ?? { key: "ownerName", dir: "asc" });
  // The rail conversation (chat over the live set). `liveView` mirrors the on-screen visible/sorted
  // rows so a chat turn can send the set exactly as the user sees it (built in the render body).
  const [thread, setThread] = useState<Turn[]>(restored?.thread ?? []);
  const liveView = useRef<{ rows: Row[]; market: string }>({ rows: [], market: "" });
  const [openId, setOpenId] = useState<string | null>(restored?.openId ?? null);
  const [addLeadsOpen, setAddLeadsOpen] = useState(false); // ADR-046 — manual lead-ingestion slide-over
  const [recentlyResolved, setRecentlyResolved] = useState<Set<string>>(new Set());
  // Progress strip (the single in-flight action): the current enriched hotel (sub-step), owner
  // research done/total, and a transient green "done" flash after a run finishes.
  const [enrichCurrentId, setEnrichCurrentId] = useState<string | null>(null);
  const [ownerProgress, setOwnerProgress] = useState<{ done: number; total: number } | null>(null);
  // Bug-2 (ADR-064): the owner-run's target ids, snapshotted at job start — the "researching…" label
  // is scoped to these so non-targeted owner-less rows keep their true state during a run.
  const [researchingIds, setResearchingIds] = useState<Set<string>>(new Set());
  const [activityDone, setActivityDone] = useState<ActivityDone | null>(null);
  const doneT = useRef<number | null>(null);
  const [enrichJobRunning, setEnrichJobRunning] = useState(false);
  // Server-truth background-enrichment indicator: a reloaded page has no SSE stream, but
  // the backend may still be mid-enrichment. Polled every 5 s in the work phase; feeds the
  // activity strip's last-resort branch (background work must never be silent).
  const [serverEnrich, setServerEnrich] = useState<
    { active: boolean; label?: string; done?: number; total?: number } | null>(null);
  useEffect(() => {
    if (phase !== "work") return;
    let stop = false;
    const poll = async () => {
      try {
        const res = await fetch(apiUrl("/api/enrich/active"), { headers: withSession() });
        if (res.ok && !stop) setServerEnrich(await res.json());
      } catch { /* transient — keep the last answer */ }
    };
    poll();
    const t = window.setInterval(poll, 5000);
    return () => { stop = true; window.clearInterval(t); };
  }, [phase]);
  // ADR-062 — outreach batch job + review room
  const [outreachRunning, setOutreachRunning] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false); // ADR-071 — outreach settings takeover
  const [outreachProgress, setOutreachProgress] = useState<{ done: number; total: number } | null>(null);
  const [reviewLeadId, setReviewLeadId] = useState<string | null>(restored?.reviewLeadId ?? null);
  // ADR-065 — the review set: the leads the Outreach button brought over (replaced per click),
  // plus the queue's generate-selection (transient, not persisted).
  const [reviewIds, setReviewIds] = useState<string[]>(restored?.reviewIds ?? []);
  // Export selection inside the review room (checkboxes pick which leads the zip includes) —
  // transient, defaults to everything each time a new set is brought over.
  const [exportIds, setExportIds] = useState<string[]>(restored?.reviewIds ?? []);
  // ADR-126 — the static teaser previewed beside the email; export is off without one.
  // Re-read on entering the review room and on closing Settings (where it is uploaded).
  const [teaser, setTeaser] = useState<TeaserMeta | null | undefined>(undefined); // undefined = loading
  useEffect(() => {
    if (phase !== "outreach" || settingsOpen) return;
    fetchTeaser().then(setTeaser).catch(() => setTeaser(null));
  }, [phase, settingsOpen]);
  const noTeaser = teaser === null;
  useEffect(() => { setExportIds(reviewIds); }, [reviewIds]);

  // ── review band (ADR-083) ──────────────────────────────────────────────────
  // The table closes once the queue empties (every row decided).
  useEffect(() => {
    if (reviewOpen && reviewBand.length === 0) setReviewOpen(false);
  }, [reviewOpen, reviewBand.length]);
  // Re-derive the review band after a reload — it isn't persisted (the queue is re-fetchable
  // from the restored area, and decisions mutate it server-side). Runs once on mount.
  useEffect(() => {
    const a = restored?.area;
    if (restored?.phase !== "work" || !a) return;
    const params: SearchParams = a.kind === "place"
      ? { bbox: a.bbox, label: a.label, polygon: a.polygon }
      : { lat: a.lat, lng: a.lng, radiusKm: a.radiusKm, label: a.label };
    fetchReviewRows(params).then(setReviewBand).catch(() => { /* leave the band empty */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the session on any durable-state change. On the home screen there is no session to
  // keep, so clear instead — this is what makes "return home" start a fresh session.
  // `selectedIds` is serialized as an array (Sets are not JSON-serializable).
  useEffect(() => {
    if (phase === "home") {
      clearSession();
      return;
    }
    saveSession<Snapshot>({
      phase,
      rows,
      universeCount,
      place,
      filters,
      selectedIds: [...selectedIds],
      sort,
      tableFilter,
      hideDropped,
      thread,
      segment,
      steps,
      doneInfo,
      openId,
      reviewLeadId,
      reviewIds,
      area,
      railOpen,
      detent,
    });
  }, [
    phase, rows, universeCount, place, filters, selectedIds, sort,
    tableFilter, hideDropped, thread, segment, steps, doneInfo, openId, reviewLeadId,
    reviewIds, area, railOpen, detent,
  ]);

  // The assistant chatbox (lives in the rail, with the conversation). Submitting sends the turn
  // via goPlan and clears the box. It's the one command surface — there is no list omnibox.
  const [chatDraft, setChatDraft] = useState("");
  const chatComposerRef = useRef<HTMLInputElement>(null);
  const submitChat = () => {
    const text = chatDraft.trim();
    if (!text || chatBusy) return;
    setChatDraft("");
    goPlan(text);
  };

  // Apply one review decision (ADR-083): drop the row from the queue optimistically and post it.
  // The queue-empty effect closes the flow; the index stays put and points at the next row.
  const chooseReview = (row: ReviewRow, decision: ReviewDecision) => {
    setReviewBand((band) => band.filter((r) => r.id !== row.id)); // optimistic — the row leaves the table
    postReviewDecision(row, decision).catch((e: Error) =>
      setErrorMsg(`Couldn’t save that review decision — ${e.message}`));
  };
  // Clicking a row in the review table flies the map to its ◌ pin and lights it.
  const focusReviewRow = (row: ReviewRow) => {
    setMapFocus({ lng: row.lng, lat: row.lat, key: `rev:${row.id}:${(reviewFocusSeq.current += 1)}` });
    setHoverId(`review:${row.id}`);
  };

  // Brief accent wash on a row whose owner just resolved (cleared after the anim).
  const flashResolved = (id: string) => {
    setRecentlyResolved((prev) => new Set(prev).add(id));
    window.setTimeout(
      () => setRecentlyResolved((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      }),
      1200,
    );
  };

  // Green "done" flash on the progress strip after a run finishes (replaces completion toasts).
  const flashDone = (label: string, summary: string, tone: "accent" | "owner") => {
    setActivityDone({ label, summary, tone });
    if (doneT.current) window.clearTimeout(doneT.current);
    doneT.current = window.setTimeout(() => setActivityDone(null), 2600);
  };

  const goHome = () => {
    clearSession();
    setPhase("home");
    setScanning(false);
    setMarketQuery("");
    setSuggest({ items: [], active: -1 });
    setArea(null);
    // mint a fresh fitKey (not null) so the persistent map flies back to the world view —
    // it survives the phase change, so clearing state alone would leave the camera parked
    // on the old market. With area now null, MarketMap reads this as the "start over" signal.
    setFitKey(`home:${Date.now()}`);
    setFacts(null);
    setProgress(null);
    setLeadCard(null);
    setHoverId(null);
    setFocusId(null);
    setMapFocus(null);
    setRailOpen(true);
    setSeenAnswers(0);
    setPlace(null);
    setSteps([]);
    setRows([]);
    setUniverseCount(0);
    setStatusMsg(null);
    setOwnerStage("queued");
    setFilters([]);
    setSelectedIds(new Set());
    setDoneInfo(null);
    setErrorMsg(null);
    setHideDropped(false);
    setOpenId(null);
    setPending(false);
    setEnrichCurrentId(null);
    setOwnerProgress(null);
    setActivityDone(null);
    setOutreachRunning(false);
    setOutreachProgress(null);
    setReviewLeadId(null);
    setReviewIds([]);
    setReviewBand([]); // the held-back rows ride the map as pins (ADR-083) — clear them too
  };

  // ADR-021: one /api/chat call per query. Classify, then render the chosen branch's frames by
  // type — `plan` fills the workspace; `lookup`/`other` answer on the home screen. The client
  // never inspects an intent to fire a second request, so no branch can strand the UI.
  // A fresh search wipes the prior set; a refine/ask turn must NOT (it operates on the set in
  // place). So the reset is deferred until we know the turn is a new search (the `route` frame on
  // the workbench) — except on the home screen, where there's nothing to preserve.
  const resetForNewSearch = () => {
    setArea(null);
    setFitKey(null);
    setFacts(null);
    setProgress(null);
    setLeadCard(null);
    setHoverId(null);
    setFocusId(null);
    setMapFocus(null);
    setPlace(null);
    setSegment(null);
    setSteps([]);
    setRows([]);
    setUniverseCount(0);
    setStatusMsg(null);
    setOwnerStage("queued");
    setFilters([]);
    setSelectedIds(new Set());
    setDoneInfo(null);
    setErrorMsg(null);
    setOpenId(null);
    setHideDropped(false);
    setEnriching(null);
    setEnrichCurrentId(null);
    setOwnerProgress(null);
    setActivityDone(null);
    setSweeping(false);
    setScanning(false);
    setClassifying(false);
    setThread([]); // a new search starts a fresh conversation
    setChatDraft(""); // don't leave a half-typed message in the rail chatbox
  };

  const goPlan = async (override: string) => {
    const text = override.trim();
    if (!text || chatBusy) return;
    setChatBusy(true);

    // In the workbench with a set on screen, the turn may be a read-only refine/ask over it — send
    // the set and DON'T reset yet. On home, reset upfront and show the "thinking" indicator.
    const inWork = phase === "work" && liveView.current.rows.length > 0;
    if (inWork) {
      setThread((t) => [...t, { role: "user", text }]);
    } else {
      resetForNewSearch();
    }
    setErrorMsg(null);
    setPending(true);

    const liveSet = inWork
      ? {
          market: liveView.current.market,
          rows: liveView.current.rows.map((r) => ({
            id: r.id, name: r.name, keys: r.keys, residences: r.residences, segment: r.segment,
            brand: r.brand, ownerName: r.ownerName, ownerType: r.ownerType, ownerEmail: r.ownerEmail,
            ownerPhone: r.ownerPhone, ownerLinkedin: r.ownerLinkedin, ownerReachVia: r.ownerReachVia,
            amenities: r.amenities, city: r.city,
            brandAffiliation: r.brandAffiliation, // ADR-084
          })),
          // ADR-086: strip client-only filter attrs (e.g. name) — the backend FilterAttr Literal
          // rejects them. The chat still sees every predicate the planner can reason about.
          filters: filters.filter((f) => !CLIENT_ONLY_ATTRS.has(f.attr)),
          sort,
          selected: Array.from(selectedIds),
          shown: liveView.current.rows.length,
          universe: universeCount,
          // Enrichment-gap awareness (spec 2026-07-07): the exact divider counts + whether an
          // enrichment is running, so the answerer can caveat partial data instead of presenting
          // a half-enriched set as complete.
          ...(filters.length > 0 ? { filterCounts } : {}),
          enrichmentInFlight,
          classificationInFlight,
        }
      : undefined;

    await streamSSE<ChatStreamFrame>(
      apiUrl("/api/chat"),
      { text, ...(liveSet ? { liveSet } : {}) },
      (frame) => {
        // Re-open the composer as soon as the turn's outcome is on screen — the authoritative
        // hotels frame (plan), or the terminal done/error. NOT stream close: auto-enrich holds
        // the plan stream open for minutes after the set has landed.
        if (releasesComposer(frame.type)) setChatBusy(false);
        switch (frame.type) {
          case "route":
            setPending(false);
            // plan → open/refresh the workspace (a NEW search; reset now if we deferred it).
            if (frame.intent === "plan") {
              if (inWork) resetForNewSearch();
              setPhase("work");
            }
            break;
          case "refine": {
            // carve/order: apply the operations to the client filter/sort view, then log the turn.
            const next = applyOperations(filters, sort, frame.operations);
            setFilters(next.filters);
            setSort({ key: next.sort.key as SortKey, dir: next.sort.dir });
            // If the turn changed the FILTER (not a pure sort), select the rows that now confirmed-
            // match so it's visually clear which the criteria picked out (passes only; "clear
            // filters" → empty selection). A sort-only refine leaves any manual selection alone.
            const touchedFilters = frame.operations.some(
              (o) => o.type === "addFilter" || o.type === "removeFilter" || o.type === "clearFilters",
            );
            if (touchedFilters) setSelectedIds(passingIds(rows, next.filters));
            setThread((t) => [...t, {
              role: "hub", kind: "refine", text: frame.reply,
              operations: frame.operations, coverage: frame.coverage,
            }]);
            break;
          }
          case "act": {
            // Selection ops apply to the client selection (validated against on-screen rows);
            // any filter/sort ops apply to the view. A staged action pushes a confirm card.
            const validIds = new Set(liveView.current.rows.map((r) => r.id));
            const nextSel = applySelectionOps(selectedIds, frame.operations, validIds);
            setSelectedIds(nextSel);
            const next = applyOperations(filters, sort, frame.operations);
            setFilters(next.filters);
            setSort({ key: next.sort.key as SortKey, dir: next.sort.dir });
            // Backstop for the backend's explicit-selection rule: if a run is staged but id
            // validation dropped everything (the model named rows not on screen), push back
            // instead of staging the whole set.
            if (frame.stagedAction === "ownerResearch" && nextSel.size === 0) {
              setThread((t) => [...t, {
                role: "hub", kind: "text",
                text: "Nothing is selected — pick the hotels you want first (or tell me which to select), then I'll run owner research on them.",
              }]);
              break;
            }
            setThread((t) => {
              let nt: typeof t = [...t, {
                role: "hub", kind: "refine", text: frame.reply,
                operations: frame.operations, coverage: null,
              }];
              if (frame.stagedAction) nt = appendConfirm(nt, frame.stagedAction);
              return nt;
            });
            break;
          }
          case "token":
            // interrogate: the answer over the on-screen rows, streamed token-by-token. Each delta
            // extends one growing hub bubble (appendToken); never touches the set. The preceding
            // `user` turn separates it from the prior answer, so the first token opens a fresh bubble.
            setThread((t) => appendToken(t, frame.text));
            break;
          case "plan": {
            setSteps(frame.steps);
            setSegment(frame.universe.segment ?? null);
            setPlace({
              city: frame.universe.city,
              country: frame.universe.country,
              locality: frame.universe.locality ?? null,
            });
            // ADR-030: seed the client filter set from the structured cheapFilters. Segment is NOT
            // seeded — it defines the universe (applied server-side, sparse-tolerantly) and is a
            // mostly-NULL column, so filtering on it would wrongly tag every untagged row "unmeasured".
            // The UI controls (keys/ownerType) edit these; any other seed rides along as a chip.
            const seeded: Filter[] = [];
            for (const cf of frame.cheapFilters ?? []) {
              seeded.push({ attr: cf.attr, op: cf.op, value: cf.value, label: cf.label });
            }
            setFilters(seeded);
            break;
          }
          case "status":
            setStatusMsg(frame.message);
            if (frame.message.toLowerCase().includes("searching the web")) setSweeping(true);
            break;
          case "hotels": {
            // ADR-030: raw rows only — classification (dropped/unknown/reason) is computed client-side
            const mapped: Row[] = frame.hotels.map(wireToRow);
            if (frame.append) {
              // ADR-023: the coverage sweep's genuinely-new hotels — append, don't replace
              setRows((prev) => [...prev, ...mapped]);
              setUniverseCount((prev) => prev + mapped.length);
            } else {
              setRows(mapped);
              if (frame.universeCount !== undefined) setUniverseCount(frame.universeCount);
            }
            break;
          }
          case "enriching": // ADR-027: background basic-enrich started
            setEnriching({ total: frame.count, done: 0 });
            break;
          case "enriched": {
            // ADR-030/027: a freshly-measured row — apply resolved facts; the row reclassifies
            // live because dropped/unknown/reason are derived from these values, not stored.
            const keys = frame.fields.keys;
            const brand = frame.fields.brand;
            const owner = frame.fields.owner;
            const ownerType = frame.fields.ownerType;
            const ownerEmail = frame.fields.ownerEmail;
            const ownerPhone = frame.fields.ownerPhone;
            const ownerLinkedin = frame.fields.ownerLinkedin;
            const ownerReachVia = frame.fields.ownerReachVia;
            const ownerContacts = frame.fields.ownerContacts;
            setRows((prev) =>
              prev.map((r) =>
                r.id === frame.hotel_id
                  ? {
                      ...r,
                      keys: keys ? (keys.value as number) : r.keys,
                      // ADR-091: the facts pass emits the RAW brand → brandRaw (provenance). The
                      // displayed `brand` is the clean value, set only by the classify pass.
                      brandRaw: brand ? (brand.value as string) : r.brandRaw,
                      ownerName: owner ? (owner.value as string) : r.ownerName,
                      ownerType: ownerType ? (ownerType.value as string) : r.ownerType,
                      ownerEmail: ownerEmail ? (ownerEmail.value as string) : r.ownerEmail,
                      ownerPhone: ownerPhone ? (ownerPhone.value as string) : r.ownerPhone,
                      ownerLinkedin: ownerLinkedin ? (ownerLinkedin.value as string) : r.ownerLinkedin,
                      ownerReachVia: ownerReachVia ? (ownerReachVia.value as string) : r.ownerReachVia,
                      ownerContacts: ownerContacts ? (ownerContacts.value as unknown as Row["ownerContacts"]) : r.ownerContacts,
                      enriched: true,
                    }
                  : r,
              ),
            );
            if (owner) flashResolved(frame.hotel_id);
            setEnrichCurrentId(frame.hotel_id);
            setEnriching((e) => (e ? { ...e, done: e.done + 1 } : e));
            break;
          }
          case "enrich_done":
            setEnriching(null);
            setEnrichCurrentId(null);
            // ADR-063: distinguish a failed auto-enrich from "found nothing" — an errored run leaves
            // rows un-stamped, so tell the user rather than flashing a clean "0 measured".
            if (frame.error) {
              setErrorMsg("Auto-enrichment didn't finish — some details may be missing. Try again shortly.");
            } else {
              flashDone("Basics enriched", `${frame.count} measured`, "accent");
            }
            break;
          case "lookup_result":
            // a question over existing data — answered in the assistant panel (map-first: the
            // home screen no longer hosts chat, so every answer lands in the thread)
            setThread((t) => [...t, { role: "hub", kind: "text", text: frame.answer }]);
            break;
          case "message":
            setThread((t) => [...t, { role: "hub", kind: "text", text: frame.text }]);
            break;
          case "done":
            setSweeping(false);
            // a plan `done` (cached/no-owner/too_broad) carries these; a bare lookup/other
            // `done` is just a terminator we can ignore.
            if (frame.fromMemory !== undefined || frame.status !== undefined) {
              setDoneInfo({
                fromMemory: frame.fromMemory,
                status: frame.status,
                narrowing: frame.narrowing_suggestions,
                message: frame.message,
              });
            }
            break;
          case "error":
            setPending(false);
            setSweeping(false);
            setErrorMsg(frame.message);
            break;
        }
      },
      (msg) => {
        setPending(false);
        setErrorMsg(msg);
      },
    );
    setChatBusy(false); // stream closed (or transport error) — never leave the composer locked
  };

  // ── map-first discovery (ADR-079) ─────────────────────────────────────────

  // Suggestions as you type (debounced ~300 ms): POST /api/registry/preview {query}.
  // A sequence counter drops stale responses; failures stay quiet (suggestions are best-effort).
  useEffect(() => {
    if (phase !== "home" || area !== null) return;
    const q = marketQuery.trim();
    if (q.length < 2) {
      setSuggest({ items: [], active: -1 });
      return;
    }
    const seq = ++suggestSeq.current;
    const t = window.setTimeout(() => {
      previewQuery(q)
        .then((items) => {
          if (suggestSeq.current === seq) setSuggest({ items, active: items.length ? 0 : -1 });
        })
        .catch(() => {});
    }, 300);
    return () => window.clearTimeout(t);
  }, [marketQuery, phase, area]);

  // The confirm card's facts line: POST /api/registry/preview {bbox} for the current area,
  // re-fetched (debounced) as the corner handles reshape the bbox.
  useEffect(() => {
    if (phase !== "home" || !area || scanning) return;
    setFacts(null);
    let stale = false;
    const t = window.setTimeout(() => {
      previewBbox(areaBbox(area))
        .then((f) => { if (!stale) setFacts(f); })
        .catch(() => {}); // no facts line — the Find button still works
    }, 300);
    return () => {
      stale = true;
      window.clearTimeout(t);
    };
  }, [area, phase, scanning]);

  // The finding bar's TIME leg: while scanning, tick the ease-out toward 85% (~4×/s).
  // Reduced motion keeps the bar — it IS the progress information — the CSS just stops
  // smoothing the steps. Frame-based snaps merge in the effect below.
  useEffect(() => {
    if (!scanning) return;
    const tick = () =>
      setBarPct((prev) =>
        mergeBarProgress(
          prev,
          timeProgress((Date.now() - scanMeta.current.start) / 1000, scanMeta.current.expected),
          null,
        ),
      );
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [scanning]);

  // The finding bar's SIGNAL leg: each progress frame maps cells_done/cells_total onto
  // the 85–98 band and only ever snaps the bar forward (never backward).
  useEffect(() => {
    if (!scanning || !progress) return;
    setBarPct((prev) => mergeBarProgress(prev, 0, cellProgress(progress.cellsDone, progress.cellsTotal)));
  }, [scanning, progress]);

  // Escape backs out of the confirm moment to the search field (the card's ✕ does the same).
  useEffect(() => {
    if (phase !== "home" || !area || scanning) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") clearArea(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, area, scanning]);

  const pickCandidate = (c: Candidate) => {
    setSuggest({ items: [], active: -1 });
    setErrorMsg(null);
    setArea({ kind: "place", label: c.label, bbox: c.bbox, polygon: c.polygon });
    setFitKey(`place:${c.label}:${c.bbox.join(",")}`); // fly to the picked area
  };

  // Clicking the map drops a pin — same flow, the pin (plus its radius circle) is the area.
  // Another click while confirming a pin just moves it.
  const dropPin = (p: { lng: number; lat: number }) => {
    setErrorMsg(null);
    setSuggest({ items: [], active: -1 });
    setArea((prev) => ({
      kind: "pin",
      lat: p.lat,
      lng: p.lng,
      radiusKm: prev?.kind === "pin" ? clampRadius(prev.radiusKm) : DEFAULT_RADIUS_KM, // an old 0.5 km pin lifts to the 1 km floor
      label: prev?.kind === "pin" ? prev.label : "Pinned area",
    }));
    setFitKey(`pin:${p.lng.toFixed(3)},${p.lat.toFixed(3)}`);
  };

  const clearArea = () => {
    setArea(null);
    setFacts(null);
    setErrorMsg(null);
  };

  // Find hotels: POST /api/registry/search (area or pin mode per the shared contract) and
  // watch it work — progress frames tick the finding strip, incremental hotels frames light
  // pins as they land, done lands the set in the work phase. An error surfaces on the confirm
  // card and unlocks for another try.
  const goRegistryScan = async () => {
    if (!area || chatBusy || scanning) return;
    const label = area.label.trim() || "Pinned area";
    const params: SearchParams =
      area.kind === "place"
        ? { bbox: area.bbox, label, polygon: area.polygon }
        : { lat: area.lat, lng: area.lng, radiusKm: area.radiusKm, label };
    setChatBusy(true);
    setErrorMsg(null);
    setRows([]);
    setUniverseCount(0);
    setFilters([]);
    setSelectedIds(new Set());
    setThread([]);
    setDoneInfo(null);
    setProgress(null);
    setReviewBand([]);
    setReviewOpen(false);
    // the finding bar's expected duration = the confirm card's estimate (pin mode included —
    // `facts` is previewed off areaBbox for both modes); timeProgress falls back to 60 s on 0
    scanMeta.current = { start: Date.now(), expected: facts?.est_seconds ?? 0 };
    setBarPct(0);
    setScanning(true);
    setPlace({ city: label, country: "", locality: null });
    setStatusMsg(`Finding hotels in ${label}…`);
    await runRegistrySearch<HotelWire>(params, {
      onStatus: (message) => setStatusMsg(message),
      onProgress: (p) => setProgress((prev) => reduceProgress(prev, p)),
      // incremental sets replace, exactly like typed search's non-append hotels frames —
      // the pins alight on the map while the strip counts
      onHotels: (hotels) => {
        setRows(hotels.map(wireToRow));
        setUniverseCount(hotels.length);
      },
      onDone: (done) => {
        setChatBusy(false);
        setScanning(false);
        setStatusMsg(null);
        setProgress(null);
        setRows(done.hotels.map(wireToRow));
        setUniverseCount(done.unique_count);
        setDoneInfo({ status: done.status, narrowing: done.narrowing_suggestions });
        setPhase("work");
        // the ambiguous residue held back from this area (ADR-083) — a quiet queue, never blocks
        fetchReviewRows(params).then(setReviewBand).catch(() => setReviewBand([]));
      },
      onError: (message) => {
        setChatBusy(false);
        setScanning(false);
        setStatusMsg(null);
        setProgress(null);
        setErrorMsg(message); // surfaces on the confirm card — the area is still set
      },
      // ADR-027: the post-done auto-enrich (keys/facts) pass patches rows live — mirror the plan
      // stream's `enriched` handling so key counts appear as they're measured, not only on a re-search.
      onEnriching: (count) => setEnriching({ total: count, done: 0 }),
      onEnriched: ({ hotelId, fields }) => {
        const f = fields as Record<string, { value: unknown } | undefined>;
        setRows((prev) =>
          prev.map((r) => {
            if (r.id !== hotelId) return r;
            const next: Row = { ...r, enriched: true };
            if (f.keys) next.keys = f.keys.value as number;
            if (f.residences) next.residences = f.residences.value as number;
            if (f.brand) next.brandRaw = f.brand.value as string; // ADR-091: facts pass → raw brand
            if (f.officialWebsite) next.officialWebsite = f.officialWebsite.value as string;
            if (f.owner) next.ownerName = f.owner.value as string;
            if (f.ownerType) next.ownerType = f.ownerType.value as string;
            return next;
          }),
        );
        if (f.owner) flashResolved(hotelId);
        setEnrichCurrentId(hotelId);
        setEnriching((e) => (e ? { ...e, done: e.done + 1 } : e));
      },
      onEnrichDone: ({ count, error, attempted }) => {
        setEnrichCurrentId(null);
        if (error) {
          // NEVER stamp attempted on error — a cut-short pass must not claim "found nothing".
          setEnriching(null);
          setErrorMsg("Auto-enrichment didn't finish — some details may be missing. Try again shortly.");
        } else {
          // ADR-064: stamp factsAttemptedAt for the ids the facts pass ran on, so an empty field
          // reads "none found" — not the sticky "enrich". Do NOT clear the loader here: the
          // brand/affiliation classify pass still runs after this on the SAME stream, so the pill
          // stays up (continuous progress) until classify_done clears it.
          const today = new Date().toISOString().slice(0, 10);
          setRows((prev) =>
            applyAttempted(prev, { owner: [], facts: attempted ?? [], contacts: [], reviews: [] }, today));
          flashDone("Basics enriched", `${count} measured`, "accent");
        }
      },
      // ADR-084: brand-affiliation classification runs in the background after done (like
      // auto-enrich) — classifying/classify_done bracket it for the chat live-set signal, and
      // each classified frame patches that row's Affiliation live.
      onClassifying: () => setClassifying(true),
      onClassified: ({ hotelId, brandAffiliation, brandClean }) =>
        // ADR-091: the classify pass also fills the displayed brand (brand_clean); undefined means
        // the frame carried none, so keep the existing value.
        setRows((prev) => prev.map((r) => (r.id === hotelId
          ? { ...r, brandAffiliation, brand: brandClean !== undefined ? (brandClean ?? null) : r.brand }
          : r))),
      onClassifyDone: ({ attempted }) => {
        // Stamp brandClassifiedAt for the classified ids (an error frame omits `attempted` → no-op),
        // then clear the loader — this is the TRUE end of the post-scan enrich→classify pipeline.
        const today = new Date().toISOString().slice(0, 10);
        setRows((prev) => applyClassified(prev, attempted ?? [], today));
        setEnriching(null);
        setEnrichCurrentId(null);
        setClassifying(false);
      },
    });
    setChatBusy(false); // stream closed (or transport error) — never leave the flow locked
    setScanning(false);
    // Safety net: the stream closed, so nothing is enriching/classifying — clear any lingering
    // pill (a stream that ends without classify_done must not strand the "Enriching basics" loader).
    setEnriching(null);
    setEnrichCurrentId(null);
    setClassifying(false);
  };

  // ── unified enrich-job action (ADR-050) ──────────────────────────────────
  // Single handler for all three enrichment kinds; POSTs to /api/enrich/job and applies
  // whatever fields each `enriched` frame carries. Drives ownerStage for the Funnel rail.
  const runEnrichJob = async (kinds: EnrichKind[], targets: Row[]) => {
    if (kinds.length === 0 || targets.length === 0) return;
    setEnrichJobRunning(true);
    setStatusMsg("Enriching…");
    if (kinds.includes("owner")) {
      setOwnerStage("running");
      setOwnerProgress({ done: 0, total: targets.length });
      // Bug-2: only these rows should show "researching…" — not every owner-less row on screen.
      setResearchingIds(new Set(targets.map((t) => t.id)));
    }
    const payload = {
      hotels: targets.map((r) => ({
        id: r.id, name: r.name, city: r.city, country: r.country,
        ownerName: r.ownerName, ownerType: r.ownerType,
        ownerAttemptedAt: r.ownerAttemptedAt ?? null,
        reviewsAttemptedAt: r.reviewsAttemptedAt ?? null,
      })),
      kinds,
    };
    const PHASE_MSG: Record<string, string> = {
      owner: "Researching owners & contacts…", contacts: "Finding contacts…", reviews: "Refreshing reviews & rates…",
    };
    await streamSSE<EnrichFrame>(
      apiUrl("/api/enrich/job"),
      payload,
      (frame) => {
        if (frame.type === "status") {
          setStatusMsg(frame.message);
        } else if (frame.type === "phase") {
          setStatusMsg(PHASE_MSG[frame.kind] ?? "Enriching…");
        } else if (frame.type === "enriched") {
          const f = frame.fields;
          setRows((prev) =>
            prev.map((r) => {
              if (r.id !== frame.hotel_id) return r;
              const next = { ...r, enriched: true };
              if (f.owner) { next.ownerName = f.owner.value as string; next.ownerConf = f.owner.confidence; next.ownerSources = f.owner.sources; }
              if (f.ownerType) next.ownerType = f.ownerType.value as string;
              if (f.ownerEmail) next.ownerEmail = f.ownerEmail.value as string;
              if (f.ownerPhone) next.ownerPhone = f.ownerPhone.value as string;
              if (f.ownerLinkedin) next.ownerLinkedin = f.ownerLinkedin.value as string;
              if (f.ownerReachVia) next.ownerReachVia = f.ownerReachVia.value as string;
              if (f.ownerContacts) next.ownerContacts = f.ownerContacts.value as unknown as Row["ownerContacts"];
              // ADR-110: the frame carries the STORED snake_case blob; convert to the wire shape
              if (f.ownerResearch) next.ownerResearch = ownerResearchFromStored(f.ownerResearch.value);
              if (f.starRating) next.starRating = f.starRating.value as number;
              if (f.bookingRating) { next.bookingRating = f.bookingRating.value as number; next.reviewSources = f.bookingRating.sources; }
              if (f.bookingReviews) next.bookingReviews = f.bookingReviews.value as number;
              // ADR-050: structured review themes (with the ADR-039 paragraph kept as fallback)
              if (f.reviewThemes) next.reviewThemes = f.reviewThemes.value as unknown as Row["reviewThemes"];
              if (f.reviewSummary) next.reviewSummary = f.reviewSummary.value as string;
              if (f.roomCategories) next.roomCategories = f.roomCategories.value as unknown as Row["roomCategories"];
              if (f.bookingRating || f.reviewSummary || f.reviewThemes) next.reviewsAttemptedAt = new Date().toISOString().slice(0, 10);
              return next;
            }),
          );
          if (f.owner) {
            flashResolved(frame.hotel_id);
            setOwnerProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
          }
        } else if (frame.type === "done") {
          setEnrichJobRunning(false);
          setStatusMsg(null);
          setResearchingIds(new Set());
          if (kinds.includes("owner")) {
            setOwnerStage("done");
            setOwnerProgress(null);
          }
          // ADR-064: stamp *AttemptedAt in-session for each attempted id that came back empty, so the
          // "tried — none found" copy shows immediately (mirrors what the backend just persisted).
          const attempted = frame.attempted;
          const today = new Date().toISOString().slice(0, 10);
          setRows((prev) => applyAttempted(prev, attempted, today));
          flashDone("Enrichment done", enrichDoneSummary(frame, attempted), "owner");
        } else if (frame.type === "error") {
          // NEVER stamp attempted on error — a cut-short run must not claim "found nothing".
          setEnrichJobRunning(false);
          setStatusMsg(null);
          setResearchingIds(new Set());
          if (kinds.includes("owner")) {
            setOwnerStage("queued");
            setOwnerProgress(null);
          }
          setErrorMsg(frame.message);
        }
      },
      (msg) => {
        setEnrichJobRunning(false);
        setResearchingIds(new Set());
        if (kinds.includes("owner")) {
          setOwnerStage("queued");
          setOwnerProgress(null);
        }
        setErrorMsg(msg);
      },
    );
  };

  // ADR-027: basics auto-enrich in the background on the /api/chat stream (handled in goPlan's
  // frame switch) — no manual "Resolve" trigger.

  // ADR-062: the outreach batch job — POST the selected ids, attach each streamed package to its
  // row, then land in the review room. Regenerate (single lead) reuses the same runner.
  const runOutreachJob = async (targetRows: Row[]) => {
    const ids = targetRows.map((r) => r.id);
    if (ids.length === 0 || outreachRunning || enrichJobRunning) return;
    setOutreachRunning(true);
    setStatusMsg("Generating outreach…");
    let firstId: string | null = null;
    await streamSSE<OutreachFrame>(
      apiUrl("/api/outreach/job"),
      { ids },
      (frame) => {
        if (frame.type === "status") {
          setStatusMsg(frame.message);
        } else if (frame.type === "phase") {
          setOutreachProgress({ done: 0, total: frame.count });
          setStatusMsg(`Generating outreach (${frame.count})…`);
        } else if (frame.type === "outreach") {
          firstId ??= frame.hotel_id;
          setRows((prev) => prev.map((r) => (r.id === frame.hotel_id ? { ...r, outreach: frame.package } : r)));
          setOutreachProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
        } else if (frame.type === "done") {
          setOutreachRunning(false);
          setOutreachProgress(null);
          setStatusMsg(null);
          const parts = [
            `${frame.generated} generated`,
            frame.skipped ? `${frame.skipped} skipped (no owner)` : "",
            frame.failed ? `${frame.failed} failed` : "",
          ].filter(Boolean);
          flashDone("Outreach ready", parts.join(" · "), "accent");
          if (frame.generated > 0) {
            setPhase("outreach");
            setReviewLeadId((prev) => prev ?? firstId);
          }
        } else if (frame.type === "error") {
          setOutreachRunning(false);
          setOutreachProgress(null);
          setStatusMsg(null);
          setErrorMsg(frame.message);
        }
      },
      (msg) => {
        setOutreachRunning(false);
        setOutreachProgress(null);
        setStatusMsg(null);
        setErrorMsg(msg);
      },
    );
  };

  // Persist one asset edit: optimistic package swap, server write, revert on failure (the
  // ADR-060 dossier-edit idiom). Returns whether the save stuck (the editor shows a retry cue).
  const saveOutreachEdit = async (row: Row, field: OutreachEditableField, value: string): Promise<boolean> => {
    const prev = row.outreach;
    if (!prev) return false;
    const setPkg = (pkg: OutreachPackage | null | undefined) =>
      setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, outreach: pkg } : r)));
    setPkg(withEditedField(prev, field, value));
    try {
      setPkg(await saveOutreachField(row.id, field, value));
      return true;
    } catch {
      setPkg(prev);
      return false;
    }
  };

  const fileSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  // ── derived view data ───────────────────────────────────────────────────
  // ADR-030: classify every row CLIENT-SIDE against the live filter set. Live = pass + unknown
  // (ADR-025): everything not confirmed-fail is surfaced; only confirmed-fail rows are greyed.
  // Recomputed on every render, so editing a filter or an `enriched` frame re-filters instantly.
  const classified: ClassifiedRow[] = rows.map((r) => {
    const { state, reason } = classify(r, filters);
    return { ...r, state, dropped: state === "fail", reason };
  });
  // A client-side quick-filter narrows the loaded set; clickable headers sort it.
  const q = tableFilter.trim().toLowerCase();
  const quickFiltered = q
    ? classified.filter((r) =>
        [r.name, r.city, r.country, r.segment, r.brand, r.ownerName, r.ownerType, r.ownerEmail,
         r.keys, r.residences, ...(r.amenities ?? [])]
          .filter((v) => v != null)
          .join(" ")
          .toLowerCase()
          .includes(q),
      )
    : classified;
  // ADR-102: chip counts are computed BEFORE the chip's own filter so toggling one never changes
  // the numbers; over the non-dropped rows (the live set the user is working).
  const chipBase = quickFiltered.filter((r) => !r.dropped);
  const pendingCounts: Record<EnrichKind, number> = {
    owner: chipBase.filter((r) => enrichPending("owner", r)).length,
    contacts: chipBase.filter((r) => enrichPending("contacts", r)).length,
    reviews: chipBase.filter((r) => enrichPending("reviews", r)).length,
  };
  const visible = pendingView
    ? quickFiltered.filter((r) => enrichPending(pendingView, r))
    : quickFiltered;
  const cmp = (a: ClassifiedRow, b: ClassifiedRow) => {
    const va = SORT_ACCESSORS[sort.key](a);
    const vb = SORT_ACCESSORS[sort.key](b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1; // nulls always last, regardless of direction
    if (vb == null) return -1;
    const mul = sort.dir === "asc" ? 1 : -1;
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * mul;
    return String(va).localeCompare(String(vb)) * mul;
  };
  // Matched-first: confirmed matches (pass) above unmeasured candidates (unknown), the column
  // sort within each group — so a filter shows the rows meeting the criteria on top instead of
  // scattering them among unenriched rows. No filters → every row is pass → pure column sort.
  const live = visible
    .filter((r) => !r.dropped)
    .slice()
    .sort((a, b) => matchRank(a.state) - matchRank(b.state) || cmp(a, b));
  // Mirror the on-screen set so a chat turn sends exactly what the user sees (post-filter, sorted).
  liveView.current = { rows: live, market: place?.city ?? "" };
  const dropped = visible.filter((r) => r.dropped).slice().sort(cmp); // confirmed-fail only
  // Enrichment-gap divider (spec 2026-07-07): derived, never a message — counts over exactly what's
  // on screen, rendered at the pass/unknown boundary, dissolving as rows reclassify to 0 unknowns.
  const filterCounts = gapCounts(visible.map((r) => r.state));
  const gapVisible = showGapDivider(filters, filterCounts, dismissedGapSig);
  const gapIndex = live.findIndex((r) => r.state === "unknown");
  // Chat awareness (same spec): is any enrichment running right now? The workbench holds every
  // operation's SSE stream, so this is local knowledge. Sweep is excluded — the ADR-073 composer
  // lock means no chat turn can be sent mid-sweep.
  const enrichmentInFlight = ownerStage === "running" || enriching != null || enrichJobRunning || classifying;
  // ADR-084: is the background brand-affiliation classify pass running right now? Same
  // rationale as enrichmentInFlight — the answerer should caveat unresolved Affiliation values.
  const classificationInFlight = classifying;

  // ── map pins (ADR-079): pins are the classified rows with coordinates ──────
  // state drives the pin's stroke ring + opacity (never its fill): solid/hollow = passes /
  // not-yet-confirmed · faded = filtered out · review = held-back band. Fill is reserved for
  // hover — the lit pin fills orange; a lit row lights its pin and vice versa.
  const pinData: MapPinDatum[] = classified
    .filter((r) => r.lat != null && r.lng != null)
    .map((r) => ({ id: r.id, lng: r.lng!, lat: r.lat!, state: pinState(r.state, ownerResearched(r)) }))
    // the held-back review-band rows ride the map as hollow amber ◌ (ADR-083); id is prefixed
    // so a pin-click can route to the review flow instead of a lead card.
    .concat(
      reviewBand.map((r) => ({ id: `review:${r.id}`, lng: r.lng, lat: r.lat, state: "review" as const })),
    );
  // The ◎ reset-view target (feedback #2): world on ask, the area on confirm, all pins at work.
  const resetTarget = resetViewTarget(
    phase === "home" ? "home" : "work",
    area ? areaBbox(area) : null,
    pinData,
  );
  // Row click = focus (feedback #10): light the pin and fly the map to it. The dossier now
  // opens only from the name link (or the pin card's "Open dossier").
  const focusRow = (r: Row) => {
    setFocusId(r.id);
    if (r.lat != null && r.lng != null) {
      setMapFocus({ lng: r.lng, lat: r.lat, key: `${r.id}:${Date.now()}` });
    }
  };
  const leadRow = leadCard ? classified.find((r) => r.id === leadCard.id) ?? null : null;
  // Demo: the suggestion chips are the recorded questions for the markets on screen.
  const suggestions = demoSuggestions(rows.map((r) => r.city));
  const asked = new Set(thread.filter((t) => t.role === "user").map((t) => t.text));
  // Assistant panel badge: hub turns that arrived while the panel was closed.
  const hubCount = thread.filter((t) => t.role === "hub").length;
  const answerBadge = railOpen ? 0 : Math.max(0, hubCount - seenAnswers);
  // While the panel is open every answer counts as seen the moment it lands.
  useEffect(() => {
    if (railOpen) setSeenAnswers(hubCount);
  }, [railOpen, hubCount]);

  // Confirm-gated hard delete (one row or the selected set): backend snapshots each row to
  // deleted_hotels then removes them; on success drop them from local state and clear the
  // selection so they leave the live set immediately (ADR-057).
  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const gone = new Set(pendingDelete.ids);
    setDeleting(true);
    try {
      await bulkDeleteHotels(pendingDelete.ids);
      setRows((prev) => prev.filter((r) => !gone.has(r.id)));
      setSelectedIds((prev) => new Set([...prev].filter((id) => !gone.has(id))));
      setPendingDelete(null);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Delete failed.");
    } finally {
      setDeleting(false);
    }
  };
  // ADR-085: export via the backend template-format endpoint so the file round-trips through Add
  // leads as all-duplicates. Exports the checked rows when any are selected, else the whole market
  // (not just the loaded/filtered rows).
  const exportMarketCsv = async () => {
    if (!place?.city) return;
    const ids = selectedIds.size > 0 ? [...selectedIds] : undefined;
    const qs = exportQuery({ city: place.city, country: place.country, segment, locality: place.locality, ids });
    const resp = await fetch(apiUrl(`/api/leads/export?${qs}`), withSession({}));
    if (!resp.ok) return;
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = ids ? "kh-leads-selection.csv" : `kh-leads-${fileSlug(place.city)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
  // Live set = everything not confirmed-fail (pass + not-yet-measured candidates), greyed misses
  // counted separately. The "unmeasured" candidate distinction is no longer surfaced in the UI.
  // ADR-102: per-kind "to enrich" chips (pending only — never "tried, none found"); clicking one
  // toggles the pendingView table narrowing. Hidden at zero unless it's the active chip.
  const CHIP_LABELS: Record<EnrichKind, string> = {
    owner: "owners", contacts: "contacts", reviews: "reviews & rates",
  };
  // no "contacts to enrich" chip: owner research covers contacts (ADR-114)
  const chips = (["owner", "reviews"] as EnrichKind[])
    .filter((k) => pendingCounts[k] > 0 || pendingView === k)
    .map((k) => (
      <button
        key={k}
        className={`pending-chip${pendingView === k ? " on" : ""}`}
        aria-pressed={pendingView === k}
        title={pendingView === k ? "Show all rows again" : `Show only rows where ${CHIP_LABELS[k]} enrichment hasn't run`}
        onClick={() => setPendingView((v) => (v === k ? null : k))}
      >
        {pendingCounts[k]} {CHIP_LABELS[k]} to enrich{pendingView === k ? <span className="pc-x" aria-hidden> ✕</span> : null}
      </button>
    ));
  const breakdown = (
    <>
      {/* match count from chipBase so an active chip never shrinks it */}
      <b>{chipBase.length}</b> match
      {dropped.length > 0 ? <> · {dropped.length} filtered out</> : null}
      {chips.length > 0 ? <> · {chips}</> : null}
    </>
  );

  // ── owner-research target (ADR-030) ───────────────────────────────────────
  // The filtered live set = the full set minus confirmed-fails (selection ignores the quick-filter
  // so a checked row off-screen still counts). Target = checked rows if any, else the filtered live.
  // Explicit selection WINS over the filter (ADR-030): a checked row is researched even if a filter
  // would grey it — so select from the whole classified set, not just the live survivors.
  const filteredLive = classified.filter((r) => !r.dropped);
  const checked = classified.filter((r) => selectedIds.has(r.id));
  const targets: ClassifiedRow[] = checked.length > 0 ? checked : filteredLive;
  // ADR-065: the review queue is the set the Outreach button brought over (kept in row order),
  // generated or not — generation now happens from inside the review room.
  const reviewRows = rows.filter((r) => reviewIds.includes(r.id));
  const reviewLead = reviewRows.find((r) => r.id === reviewLeadId) ?? reviewRows[0] ?? null;
  // ADR-038: on the filtered set, skip owner-less rows researched within OWNER_TTL (don't re-pay
  // the hunt every search). Explicit selection forces a re-hunt, so checked rows ignore the TTL.
  const toResearch = checked.length > 0 ? ownerUnresolved(targets) : ownerToResearch(targets);
  const targetMinutes = estMinutes(toResearch.length);

  const openRow = openId ? classified.find((r) => r.id === openId) ?? null : null;

  // ── dossier field-patch + contact-overlay handlers ────────────────────────
  // Both are optimistic: update rows state immediately, call the API, revert on error.
  // No wireToRow mapper — we update only the specific field(s) we changed (Row is a superset of
  // HotelWire, the server returns the full wire but we don't need it for the re-render).
  const fieldMap: Record<string, keyof Row> = {
    name: "name", key_count: "keys", segment: "segment",
    owner_name: "ownerName", owner_type: "ownerType",
    // ADR-063: widened editable set (plain-fact metadata fields)
    brand: "brand", residence_count: "residences", official_website: "officialWebsite",
  };
  const handlePatch = async (id: string, field: string, value: unknown) => {
    const rowKey = fieldMap[field];
    if (rowKey) {
      setRows((rs) => rs.map((r) => r.id === id ? { ...r, [rowKey]: value } : r));
    }
    try {
      await editHotelField(id, field, value);
    } catch {
      // revert: only revert if rowKey is known; an unknown field had no optimistic update to undo
      if (rowKey) {
        setRows((rs) => rs.map((r) => r.id === id ? { ...r, [rowKey]: rows.find((x) => x.id === id)?.[rowKey] } : r));
      }
    }
  };
  const handleSaveContacts = async (id: string, overlay: UserContact[]) => {
    setRows((rs) => rs.map((r) => r.id === id ? { ...r, userContacts: overlay } : r));
    try {
      await saveContacts(id, overlay);
    } catch {
      const prev = rows.find((r) => r.id === id)?.userContacts ?? null;
      setRows((rs) => rs.map((r) => r.id === id ? { ...r, userContacts: prev } : r));
    }
  };

  // ── progress strip (ADR-031) ──────────────────────────────────────────────
  // One in-flight action at a time (single-flight, ADR-027), derived from existing state in
  // priority order. Determinate (done/total) for enrich + owner; indeterminate for classify +
  // sweep. The sub-step is the live specific — current hotel for enrich, the status line for
  // owner/sweep — and is omitted (never faked) when there's nothing specific to show.
  const enrichName = enrichCurrentId ? rows.find((r) => r.id === enrichCurrentId)?.name ?? null : null;
  const activity: Activity | null = pending
    ? { kind: "classify", label: "Reading your query", sub: "Classifying your query…", tone: "accent" }
    : scanning
      // ADR-079 — a registry search (30s–3min on a fresh area); sub carries the backend's
      // streamed status line. Reuses the sweep kind: same indeterminate shimmer semantics.
      ? { kind: "sweep", label: `Finding hotels in ${area?.label ?? place?.city ?? "the area"}`, sub: statusMsg ?? undefined, tone: "accent" }
    : ownerStage === "running"
      ? { kind: "owner", label: "Resolving owners", sub: statusMsg ?? undefined,
          done: ownerProgress?.done, total: ownerProgress?.total, tone: "owner" }
      : enriching
        ? { kind: "enrich", label: "Enriching basics", sub: enrichName ?? undefined,
            done: enriching.done, total: enriching.total, tone: "accent" }
        // a manual job WITHOUT the owner kind (reviews/contacts-only) matched no branch and
        // ran invisibly — and the queued-behind-single-flight wait surfaces here via statusMsg
        : enrichJobRunning
          ? { kind: "enrich", label: "Enriching selected properties",
              sub: statusMsg ?? undefined, tone: "owner" }
          : sweeping
            ? { kind: "sweep", label: "Searching the web", sub: statusMsg ?? undefined, tone: "accent" }
            // server-truth fallback: a reloaded page has no stream, but the backend may still
            // be mid-enrichment — /api/enrich/active keeps background work visible
            : serverEnrich?.active
              ? { kind: "enrich", label: serverEnrich.label ?? "Enrichment running in the background",
                  done: serverEnrich.done, total: serverEnrich.total, tone: "accent" }
              : null;
  const toggleSort = (key: SortKey) =>
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: NUMERIC_SORT.has(key) ? "desc" : "asc" });

  // ── filter controls (ADR-086) — per-column funnel popovers + editable chips ──
  // The three-state filter set stays client-owned (ADR-030); the UI now edits it column by
  // column from the headers instead of the old two-slot FilterBar. `openCol` is the id of the
  // column whose funnel popover is open (a header funnel or an editable chip opens it).
  const [openCol, setOpenCol] = useState<string | null>(null);
  // Filter mode (ADR-086 refinement): the header funnels are hidden until the Filter button
  // reveals them (a filtered column keeps its funnel so its predicate stays editable).
  const [filterOpen, setFilterOpen] = useState(false);
  const toggleFilterMode = () => setFilterOpen((v) => { if (v) setOpenCol(null); return !v; });
  const boundVal = (attr: FilterAttr, op: ">=" | "<=") =>
    filters.find((f) => f.attr === attr && f.op === op)?.value as number | undefined;
  const enumSel = (attr: FilterAttr) =>
    (filters.find((f) => f.attr === attr && f.op === "in")?.value as string[] | undefined) ?? [];
  const textVal = (attr: FilterAttr) =>
    (filters.find((f) => f.attr === attr && f.op === "ilike")?.value as string | undefined) ?? "";
  const opGlyph = (op: FilterOp) => (op === ">=" ? "≥" : op === "<=" ? "≤" : op);
  // Replace the `>=`/`<=` bound on a numeric attr (n===null clears it).
  const setRange = (attr: FilterAttr, op: ">=" | "<=", n: number | null) =>
    setFilters((fs) => {
      const rest = fs.filter((f) => !(f.attr === attr && f.op === op));
      if (n == null || Number.isNaN(n)) return rest;
      return [...rest, { attr, op, value: n, label: `${ATTR_LABEL[attr] ?? attr} ${opGlyph(op)} ${n}` }];
    });
  // Replace the `in` multi-select on an enum attr (empty selection clears it).
  const setEnum = (attr: FilterAttr, values: string[]) =>
    setFilters((fs) => {
      const rest = fs.filter((f) => !(f.attr === attr && f.op === "in"));
      if (values.length === 0) return rest;
      return [...rest, { attr, op: "in", value: values, label: `${ATTR_LABEL[attr] ?? attr}: ${values.join(", ")}` }];
    });
  const toggleEnumVal = (attr: FilterAttr, v: string) => {
    const cur = enumSel(attr);
    setEnum(attr, cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]);
  };
  // Replace the `ilike` substring filter on a text attr (empty clears it).
  const setText = (attr: FilterAttr, v: string) =>
    setFilters((fs) => {
      const rest = fs.filter((f) => !(f.attr === attr && f.op === "ilike"));
      return v.trim() ? [...rest, { attr, op: "ilike", value: v.trim(), label: `${ATTR_LABEL[attr] ?? attr}: ${v.trim()}` }] : rest;
    });
  const removeFilter = (target: Filter) => setFilters((fs) => fs.filter((f) => f !== target));
  const openChip = (f: Filter) => { const col = ATTR_TO_COL[f.attr]; if (col) setOpenCol(col); };
  const clearFilters = () => { setFilters([]); setOpenCol(null); };
  const filterCtl: FilterCtl = { boundVal, setRange, enumSel, toggleEnumVal, textVal, setText };

  // ── row selection (ADR-030) ───────────────────────────────────────────────
  const toggleSelect = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  // Select-all toggles the (quick-filtered) live rows on screen.
  const liveIds = live.map((r) => r.id);
  const allSelected = liveIds.length > 0 && liveIds.every((id) => selectedIds.has(id));
  const toggleSelectAll = () =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allSelected) liveIds.forEach((id) => next.delete(id));
      else liveIds.forEach((id) => next.add(id));
      return next;
    });

  const topChips = [
    place?.city && { cls: "loc", text: place.locality ? `${place.locality}, ${place.city}` : place.city },
    segment && { cls: "", text: segment },
  ].filter(Boolean) as { cls: string; text: string }[];

  // Divider drag (mock 24): map height follows the pointer, snapping to the nearest detent.
  const startDividerDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const main = e.currentTarget.parentElement;
    if (!main) return;
    const rect = main.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const pct = ((ev.clientY - rect.top) / rect.height) * 100;
      setDetent(snapDetent(Math.max(0, Math.min(100, pct))));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // The clear-cut duplicates the assistant can merge in one batch (Option-C-in-A: hand back the
  // obvious lookalikes so the user only decides the genuine maybes). Needs a resolved candidate.
  const reviewMergeable = reviewBand.filter(
    (r) => (r.reason === "duplicate" || r.reason === "twin_conflict") && r.candidate,
  );
  const mergeLookalikes = () => {
    const items = reviewMergeable.map((row) => ({ row, decision: "merge" as ReviewDecision }));
    const ids = new Set(reviewMergeable.map((r) => r.id));
    setReviewBand((band) => band.filter((r) => !ids.has(r.id)));
    postReviewDecisions(items).catch((e: Error) =>
      setErrorMsg(`Couldn’t merge the lookalikes — ${e.message}`));
  };

  // The assistant conversation, rendered inside the collapsible left rail (mock 24).
  const assistantThread = (
    <div className="thread">
      {reviewMergeable.length > 0 && (
        <div className="turn hub review-nudge">
          <div className="who">assistant</div>
          <div className="atext">
            I set aside <b>{reviewBand.length}</b> I wasn’t sure about.{" "}
            <b>{reviewMergeable.length}</b> look like duplicates you already have — want me to
            merge those and leave you the {reviewBand.length - reviewMergeable.length} real maybes?
          </div>
          <button className="btn sm review-nudge-cta" onClick={mergeLookalikes}>
            Merge the {reviewMergeable.length} lookalike{reviewMergeable.length === 1 ? "" : "s"}
          </button>
        </div>
      )}
      {thread.length === 0 && !pending && activity === null && !sweeping && !errorMsg ? (
        <div className="turn hub intro">
          <div className="who">assistant</div>
          <div className="atext">
            You can ask me anything you like about the live set — filter it, sort it,
            or get a read on who to approach. Try one of these:
          </div>
          <div className="intro-ex">
            {suggestions.map((ex) => (
              <button
                key={ex}
                className="ex-chip"
                onClick={() => {
                  setChatDraft(ex);
                  chatComposerRef.current?.focus();
                }}
              >
                {ex}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {thread.map((t, i) =>
        t.role === "user" ? (
          <div className="turn user" key={i}>
            <div className="ubub">{t.text}</div>
          </div>
        ) : t.kind === "refine" ? (
          <div className="turn hub" key={i}>
            <div className="who">assistant</div>
            <div className="atext"><Markdown body={t.text} /></div>
            <div className="ops">
              {t.operations.map((op, j) => (
                <span className="opchip" key={j}>{opChipLabel(op)}</span>
              ))}
            </div>
            {t.coverage ? <div className="coverage">⚠ {t.coverage}</div> : null}
          </div>
        ) : t.kind === "confirm" ? (
          <div className="turn hub" key={i}>
            <div className="who">assistant</div>
            <div className="confirm-card">
              <div className="cc-meta">
                {toResearch.length > 0
                  ? `${toResearch.length} need an owner · ~${targetMinutes} min`
                  : "Every selected row already has an owner on file."}
              </div>
              {t.resolved ? (
                <div className="cc-resolved">
                  {t.resolved === "confirmed" ? "Running owner research…" : "Cancelled."}
                </div>
              ) : (
                <div className="cc-btns">
                  <button
                    className="btn warn sm"
                    disabled={toResearch.length === 0}
                    onClick={() => {
                      setThread((ts) => ts.map((x, k) =>
                        k === i && x.role === "hub" && x.kind === "confirm"
                          ? { ...x, resolved: "confirmed" } : x));
                      runEnrichJob(["owner"], targets);
                    }}
                  >
                    Confirm — run owner research
                  </button>
                  <button
                    className="btn ghost sm"
                    onClick={() => setThread((ts) => ts.map((x, k) =>
                      k === i && x.role === "hub" && x.kind === "confirm"
                        ? { ...x, resolved: "cancelled" } : x))}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="turn hub" key={i}>
            <div className="who">assistant</div>
            <div className="atext"><Markdown body={t.text} /></div>
          </div>
        ),
      )}
      {pending || activity !== null || sweeping ? (
        <div className="turn hub run">
          <div className="who">assistant</div>
          <div className="funnel">
            <Funnel
              steps={steps}
              universeCount={universeCount}
              liveCount={filteredLive.length}
              ownerStage={ownerStage}
              statusMsg={statusMsg}
              doneInfo={doneInfo}
              errorMsg={errorMsg}
            />
          </div>
        </div>
      ) : errorMsg ? (
        <div className="turn hub">
          <div className="atext err">{errorMsg}</div>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="wb">
      <div className="app">
        <header className="topbar">
          <div className="brand" onClick={goHome}>
            <span className="mk">◆</span> Cognitidata{" "}
            <span className="brand-sub">Intelligence Hub</span>
          </div>
          {phase !== "home" && (
            <div className="query">
              <span className="qlabel">SWEEP</span>
              {topChips.map((c, i) => (
                <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: "calc(7px * var(--space))" }}>
                  <span className={`qchip ${c.cls}`}>{c.text}</span>
                  {i < topChips.length - 1 && <span className="qcaret">·</span>}
                </span>
              ))}
            </div>
          )}
          <span className="spacer" />
          {/* ADR-065: CSV export + delete are live-set actions — hidden in the review room (the
              review page exports outreach assets instead, and permits no deletion). */}
          {phase === "work" && (
            <button
              className="topdel"
              disabled={selectedIds.size === 0}
              title={
                selectedIds.size === 0
                  ? "Select rows to delete"
                  : `Delete ${selectedIds.size} selected`
              }
              onClick={() =>
                setPendingDelete({
                  ids: [...selectedIds],
                  label: `${selectedIds.size} hotel${selectedIds.size === 1 ? "" : "s"}`,
                })
              }
            >
              Delete{selectedIds.size > 0 ? ` (${selectedIds.size})` : ""}
            </button>
          )}
          <button className="newsweep" data-tour="addleads" onClick={() => setAddLeadsOpen(true)}>
            ＋ Add leads
          </button>
          <button
            className="newsweep"
            data-tour="export"
            onClick={exportMarketCsv}
            disabled={!place?.city}
            title={!place?.city
              ? "Search a market first, then export it"
              : selectedIds.size > 0
                ? `Export ${selectedIds.size} selected to CSV`
                : "Export every hotel in this market to a template-format CSV"}
          >
            {selectedIds.size > 0 ? `Export selected (${selectedIds.size})` : "Export market (CSV)"}
          </button>
          {/* ADR-079 map-first: restart the flow from anywhere. Deviation from the mock's
              one-field-does-all — a new-market search is NOT routed through chat, it returns
              to the map's ask moment (this also starts a fresh session, absorbing the old
              "New Session" button). */}
          {phase !== "home" && (
            <button className="newsweep" data-tour="search" onClick={goHome} title="Start over — search a new market on the map">
              ⌕ Search a market
            </button>
          )}
          {/* ADR-090 — replay the guided tour (and clear the "don't show again" mute). */}
          {phase === "work" && (
            <button
              className="newsweep"
              title="Replay the guided tour"
              aria-label="replay tour"
              onClick={startTour}
            >
              ?
            </button>
          )}
          {/* ADR-071 — outreach settings live behind the global gear, reachable from every
              screen (like New Session), not buried in the live-set toolbar. */}
          <button
            className="newsweep"
            title="Clear every change made in this demo and start fresh"
            onClick={() => {
              if (window.confirm("Reset the demo? This clears your edits, decisions and searches.")) resetDemo();
            }}
          >
            Reset demo
          </button>
          <span className="top-divider" />
          <button
            className={`gearbtn${settingsOpen ? " active" : ""}`}
            title="Outreach settings"
            aria-label="outreach settings"
            onClick={() => setSettingsOpen((v) => !v)}
          >
            ⚙
          </button>
        </header>

        <div className="stage-area">
          {/* ADR-071 — settings overlay the stage (which stays mounted underneath), so Close
              lands back on the exact screen the user left, scroll and all. */}
          {settingsOpen && <SettingsPage onClose={() => setSettingsOpen(false)} />}
          {/* ═════ OUTREACH REVIEW ROOM (ADR-062 phase 3, Concept A) ═════ */}
          {phase === "outreach" && (
            <section className="review">
              <aside className="rq">
                <button className="btn back-live" onClick={() => setPhase("work")}>
                  Back to live set
                </button>
                <div className="rq-head">
                  <div className="rq-title tight">Outreach review</div>
                  <div className="rq-sub mono">
                    {reviewRows.length} lead{reviewRows.length === 1 ? "" : "s"}
                    {(() => {
                      const n = reviewRows.filter((r) => r.outreach?.edited_fields?.length).length;
                      return n ? ` · ${n} edited` : "";
                    })()}
                    {outreachProgress ? ` · generating ${outreachProgress.done}/${outreachProgress.total}` : ""}
                  </div>
                </div>
                <div className="rq-list">
                  {reviewRows.map((r) => {
                    return (
                      <div className={`rq-item${reviewLead?.id === r.id ? " on" : ""}`} key={r.id}>
                        <input
                          type="checkbox"
                          className="rq-cb"
                          checked={exportIds.includes(r.id)}
                          onChange={() =>
                            setExportIds((prev) =>
                              prev.includes(r.id) ? prev.filter((id) => id !== r.id) : [...prev, r.id],
                            )
                          }
                          aria-label={`include ${r.name} in the zip export`}
                          title="Include this lead in Export .eml"
                        />
                        <button
                          className="rq-card"
                          onClick={() => setReviewLeadId(r.id)}
                        >
                          <span className="rq-body">
                            <div className="rq-name">{r.name}</div>
                            <div className="rq-owner">{r.ownerName ?? "—"}</div>
                            <div className="rq-chips">
                              {r.outreach ? (
                                <>
                                  {recipientLabel(r.outreach) && (
                                    <span className="rq-chip owner">{recipientLabel(r.outreach)}</span>
                                  )}
                                  {r.outreach.edited_fields?.length
                                    ? <span className="rq-chip edited">✎ edited</span>
                                    : <span className="rq-chip ready">✓ ready</span>}
                                </>
                              ) : (
                                <span className="rq-chip pending">not generated</span>
                              )}
                            </div>
                          </span>
                        </button>
                      </div>
                    );
                  })}
                  {reviewRows.length === 0 && (
                    <div className="rq-empty">
                      Nothing in review yet — select leads in the live set and hit
                      <b> Outreach (N)</b>.
                    </div>
                  )}
                </div>
                <div className="rq-foot">
                  <button
                    className="btn accent"
                    disabled={reviewRows.length === 0 || outreachRunning}
                    title="Generates for every lead in review — the selection happened on the live set (ADR-069)"
                    onClick={() => {
                      const edited = reviewRows.filter((r) => r.outreach?.edited_fields?.length).length;
                      if (edited && !window.confirm(
                        `${edited} lead${edited === 1 ? "'s assets were" : "s' assets were"} hand-edited. Regenerating overwrites the edits. Continue?`,
                      )) return;
                      runOutreachJob(reviewRows);
                    }}
                  >
                    {outreachRunning ? <><span className="spin" /> Generating…</> : `Generate (${reviewRows.length})`}
                  </button>
                  <button
                    className="btn"
                    disabled={noTeaser || exportTargets(reviewRows, exportIds).length === 0}
                    title={noTeaser
                      ? "Upload a teaser PDF in Settings first"
                      : "One Outlook draft per ticked lead, teaser PDF attached"}
                    onClick={() => {
                      const targetRows = exportTargets(reviewRows, exportIds);
                      exportOutreach(targetRows.map((r) => r.id),
                        targetRows.length === 1 ? targetRows[0].name : place?.city ?? "leads")
                        .catch((e: Error) => setErrorMsg(e.message));
                    }}
                  >
                    Export .eml ({exportTargets(reviewRows, exportIds).length})
                  </button>
                  <div className="rq-note">one Outlook draft per ticked lead · teaser PDF attached</div>
                </div>
              </aside>
              <div className="rd">
                {reviewLead?.outreach ? (
                  <>
                    <div className="rd-head">
                      <h3 className="tight">{reviewLead.name}</h3>
                      <span className="rq-chip owner">{recipientLabel(reviewLead.outreach) ?? reviewLead.ownerName ?? "—"}</span>
                      <span className="spacer" />
                      <button
                        className="btn sm"
                        disabled={outreachRunning}
                        onClick={() => {
                          const edited = reviewLead.outreach?.edited_fields?.length;
                          if (edited && !window.confirm(
                            "This lead's assets were hand-edited. Regenerating overwrites the edits. Continue?",
                          )) return;
                          runOutreachJob([reviewLead]);
                        }}
                      >
                        {outreachRunning ? <><span className="spin" /> Generating…</> : "⟳ Regenerate"}
                      </button>
                      <button
                        className="btn sm accent"
                        disabled={noTeaser}
                        title={noTeaser ? "Upload a teaser PDF in Settings first" : "Outlook draft, teaser PDF attached"}
                        onClick={() =>
                          exportOutreach([reviewLead.id], reviewLead.name)
                            .catch((e: Error) => setErrorMsg(e.message))
                        }
                      >
                        Download .eml
                      </button>
                    </div>
                    <OutreachEditor
                      key={`${reviewLead.id}:${reviewLead.outreach.generated_at}`}
                      row={reviewLead}
                      busy={outreachRunning}
                      teaser={teaser}
                      onSave={saveOutreachEdit}
                    />
                  </>
                ) : reviewLead ? (
                  <div className="rd-empty">
                    <b>{reviewLead.name}</b> has no outreach assets yet — hit <b>Generate</b> to
                    create them for every lead in review.
                  </div>
                ) : (
                  <div className="rd-empty">Select a lead from the list.</div>
                )}
              </div>
            </section>
          )}

          {/* ═════ MAP-FIRST DISCOVERY + WORKSPACE (ADR-079) ═════
              One resident map under the whole flow: full-bleed behind ask → confirm → finding
              on home, then ~40% height (collapsible) above the calm list in the work phase. */}
          {(phase === "home" || phase === "work") && (
            <section className={`mf ${phase === "home" ? "mf-home" : "mf-work"}`}>
              {phase === "work" && (
                <AssistantRail
                  open={railOpen}
                  onToggle={() => setRailOpen((v) => !v)}
                  badge={answerBadge}
                  footer={
                    <>
                    {/* demo: the next recorded questions, once the conversation has started */}
                    {thread.length > 0 && !chatBusy && (
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "calc(6px * var(--space))", marginBottom: "calc(10px * var(--space))" }}>
                        {suggestions.filter((q) => !asked.has(q)).slice(0, 2).map((q) => (
                          <button key={q} className="ex-chip" style={{ fontSize: 12, padding: "calc(5px * var(--space)) calc(9px * var(--space))" }}
                            onClick={() => { setChatDraft(q); chatComposerRef.current?.focus(); }}>
                            {q}
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="mf-rail-composer">
                      <input
                        ref={chatComposerRef}
                        value={chatDraft}
                        onChange={(e) => setChatDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") submitChat();
                        }}
                        disabled={chatBusy}
                        placeholder={chatBusy
                          ? "Working — one message at a time…"
                          : "Ask about the live set…"}
                        aria-label="ask the assistant"
                      />
                    </div>
                    </>
                  }
                >
                  {assistantThread}
                </AssistantRail>
              )}
              <div className="mf-main">
              <div className="mf-map" style={phase === "work" ? { height: `${DETENT_PCT[detent]}%` } : undefined}>
                <MarketMap
                  area={area}
                  fitKey={fitKey}
                  pins={pinData}
                  hoverId={hoverId ?? focusId}
                  pulsing={scanning}
                  editable={phase === "home" && !scanning}
                  resetTarget={resetTarget}
                  focus={mapFocus}
                  onMapClick={
                    phase === "home"
                      ? !scanning && (!area || area.kind === "pin")
                        ? dropPin
                        : undefined
                      : () => setLeadCard(null)
                  }
                  onBboxDrag={
                    // Feedback #3: the FIRST handle drag replaces the geocoder polygon with the
                    // adjusted rectangle — permanently for this selection — so the glow and the
                    // eventual /api/registry/search body always agree ("polygon": null).
                    phase === "home" && !scanning
                      ? (bbox) => setArea((a) => (a?.kind === "place" ? { ...a, bbox, polygon: null } : a))
                      : undefined
                  }
                  onPinClick={
                    phase === "work"
                      ? (id, point) => {
                          // a review-band pin (id "review:<gers>") opens the triage flow, not a lead card
                          if (id.startsWith("review:")) setReviewOpen(true);
                          else setLeadCard({ id, x: point.x, y: point.y });
                        }
                      : undefined
                  }
                  onPinHover={phase === "work" ? setHoverId : undefined}
                />

                {/* moment 1 · ask */}
                {phase === "home" && !area && !scanning && (
                  <div className="mf-ask">
                    <h3 className="tight">Search a market</h3>
                    <div className="mf-field">
                      <input
                        autoFocus
                        value={marketQuery}
                        onChange={(e) => setMarketQuery(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                            e.preventDefault();
                            setSuggest((s) => ({
                              ...s,
                              active: moveActive(s.items.length, s.active, e.key === "ArrowDown" ? 1 : -1),
                            }));
                          } else if (e.key === "Enter" && suggest.active >= 0 && suggest.items[suggest.active]) {
                            pickCandidate(suggest.items[suggest.active]);
                          }
                        }}
                        placeholder="Search a city, island, or neighborhood"
                        aria-label="search a market"
                      />
                    </div>
                    {suggest.items.length > 0 && (
                      <div className="mf-sugg" role="listbox" aria-label="market suggestions">
                        {suggest.items.map((c, i) => (
                          <button
                            key={`${c.label}:${c.context}:${i}`}
                            role="option"
                            aria-selected={i === suggest.active}
                            className={`mf-srow${i === suggest.active ? " on" : ""}`}
                            onMouseEnter={() => setSuggest((s) => ({ ...s, active: i }))}
                            onClick={() => pickCandidate(c)}
                          >
                            <b>{c.label}</b>
                            <span>{c.context}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="mf-hint">…or click the map to drop a pin</div>
                  </div>
                )}

                {/* moment 2 · confirm — one card, one button */}
                {phase === "home" && area && !scanning && (
                  <div className="mf-confirm" role="dialog" aria-label="confirm area">
                    <button className="mf-x" onClick={clearArea} aria-label="back to search">✕</button>
                    {area.kind === "pin" ? (
                      <input
                        className="mf-label-in tight"
                        value={area.label}
                        onChange={(e) => setArea({ ...area, label: e.target.value })}
                        aria-label="area name"
                      />
                    ) : (
                      <h4 className="tight">{area.label}</h4>
                    )}
                    {/* Logarithmic track (fine control at city scale); the size reads as the
                        circle's width, capped at 60 km across like a drawn area. */}
                    {area.kind === "pin" && (
                      <label className="mf-radius">
                        Size
                        <input
                          type="range"
                          min={0}
                          max={SLIDER_STEPS}
                          step={1}
                          value={kmToSlider(area.radiusKm)}
                          onChange={(e) => setArea({ ...area, radiusKm: sliderToKm(Number(e.target.value)) })}
                          aria-label="pin radius"
                          aria-valuetext={radiusLabel(area.radiusKm)}
                        />
                        <span className="mf-radius-v">{radiusLabel(area.radiusKm)}</span>
                      </label>
                    )}
                    <button className="mf-cta" onClick={goRegistryScan} disabled={chatBusy}>
                      Find hotels
                    </button>
                    {area.kind === "place" && (
                      <div className="mf-alt">Drag the corners of the area to focus it</div>
                    )}
                    {errorMsg && <div className="mf-err">⚠ {errorMsg}</div>}
                  </div>
                )}

                {/* moment 3 · finding — the pulse lives on the map; this strip counts, and the
                    hybrid bar under it shows honest progress (time-eased to 85%, frames 85–98%) */}
                {phase === "home" && scanning && (
                  <div className="mf-finding" role="status">
                    <span className="mf-dot" />
                    <b>Finding hotels in {area?.label ?? "the area"}</b>
                    <span className="mf-count mono">
                      {progress ? `${progress.found.toLocaleString("en-US")} so far` : "starting…"}
                    </span>
                    {statusMsg && <span className="mf-sub">{statusMsg}</span>}
                    <span className="mf-bar" aria-hidden="true" data-testid="finding-bar">
                      <i style={{ width: `${barPct}%` }} />
                    </span>
                  </div>
                )}

                {/* work: bulk actions exist only while something is selected (dock over the map).
                    Feedback #9: the dock carries the FULL Enrich menu (per-kind eligibility
                    gating intact), not a lone owner-research shortcut. */}
                {phase === "work" && selectedIds.size > 0 && (
                  <SelectionDock
                    count={selectedIds.size}
                    onClear={() => setSelectedIds(new Set())}
                    enrich={
                      <EnrichMenu
                        summary={enrichJobSummary(targets, checked.length > 0)}
                        running={enrichJobRunning}
                        enriching={Boolean(enriching)}
                        onRun={(kinds) => runEnrichJob(kinds, targets)}
                      />
                    }
                    outreach={
                      <OutreachMenu
                        checkedRows={checked}
                        reviewCount={reviewRows.length}
                        running={outreachRunning}
                        busy={enrichJobRunning || Boolean(enriching)}
                        onGoReview={(rs) => {
                          setReviewIds(rs.map((r) => r.id));
                          setReviewLeadId(rs[0]?.id ?? null);
                          setPhase("outreach");
                          const edited = rs.filter((r) => r.outreach?.edited_fields?.length).length;
                          if (edited && !window.confirm(
                            `${edited} lead${edited === 1 ? "'s assets were" : "s' assets were"} hand-edited. Regenerating overwrites the edits. Continue?`,
                          )) return;
                          runOutreachJob(rs);
                        }}
                        onOpenReview={() => setPhase("outreach")}
                        onDownload={(rows) => {
                          exportOutreach(rows.map((r) => r.id), rows.length === 1 ? rows[0].name : place?.city ?? "leads")
                            .catch((e: Error) => setErrorMsg(e.message));
                        }}
                      />
                    }
                  />
                )}

                {/* work: a pin is a lead — the small card with the two decision numbers */}
                {phase === "work" && leadRow && leadCard && (
                  <div
                    className="mf-lead"
                    style={{ left: Math.max(8, leadCard.x - 130), top: Math.max(8, leadCard.y + 14) }}
                  >
                    <button className="mf-x" onClick={() => setLeadCard(null)} aria-label="close lead card">✕</button>
                    <h4 className="tight">{leadRow.name}</h4>
                    <div className="mf-lead-meta">
                      {[leadRow.ownerType, leadRow.city].filter(Boolean).join(" · ") || "—"}
                    </div>
                    <div className="mf-lead-facts">
                      <div><b>{leadRow.keys ?? "—"}</b><span>keys</span></div>
                      <div><b>{leadRow.bookingRating != null ? leadRow.bookingRating.toFixed(1) : "—"}</b><span>guest rating</span></div>
                      <div><b>{leadRow.ownerName ?? "—"}</b><span>owner</span></div>
                    </div>
                    <div className="mf-lead-row">
                      <button
                        className="mf-pill primary"
                        onClick={() => {
                          setOpenId(leadRow.id);
                          setLeadCard(null);
                        }}
                      >
                        Open dossier
                      </button>
                      <button className="mf-pill" onClick={() => toggleSelect(leadRow.id)}>
                        {selectedIds.has(leadRow.id) ? "Deselect" : "Select"}
                      </button>
                    </div>
                  </div>
                )}

              </div>

              {/* review band (ADR-083) — the banner opens a table of everything awaiting human
                  validation: the reason each is flagged, the data we have, decision inline */}
              {phase === "work" && reviewOpen && reviewBand.length > 0 && (
                <ReviewTable
                  rows={reviewBand}
                  market={place?.city ?? "this area"}
                  onDecide={chooseReview}
                  onFocusRow={focusReviewRow}
                  onClose={() => setReviewOpen(false)}
                />
              )}

              {/* the draggable map⇄list divider — detents: map / balanced / list (mock 24) */}
              {phase === "work" && (
                <div
                  className="mf-divider"
                  role="separator"
                  aria-label="Resize map"
                  aria-orientation="horizontal"
                  aria-valuenow={DETENT_PCT[detent]}
                  tabIndex={0}
                  onPointerDown={startDividerDrag}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowUp") { e.preventDefault(); setDetent((d) => nextDetent(d, 1)); }
                    if (e.key === "ArrowDown") { e.preventDefault(); setDetent((d) => nextDetent(d, -1)); }
                  }}
                />
              )}

              {/* the calm workspace below the resident map */}
              {phase === "work" && (
              <div className="mf-listwrap">
                {/* No list omnibox: the rail chatbox owns the conversation, the topbar
                    "Search a market" starts a new scan, and the list's own "Filter rows…" does
                    quick filtering. An error must never hide behind a collapsed rail, so it
                    surfaces here too. */}
                {errorMsg && !railOpen && <div className="mf-errbar">⚠ {errorMsg}</div>}
                <ActivityStrip activity={activity} done={activityDone} />

                {/* ONE list (feedback #7): every column, sorting, the quick filter, selection,
                    stale/outreach pills and the gap divider — the old full table restyled into
                    the calm list's visual language. Pins and rows are the same objects: hovering
                    either side lights the other; clicking a row focuses its pin (feedback #10). */}
                <div className="grid-head">
                  <div>
                    <div className="grid-title tight">Live set</div>
                    <div className="grid-sub" data-tour="breakdown">
                      {rows.length === 0 && !doneInfo && !errorMsg
                        ? "Reading your query…"
                        : doneInfo?.fromMemory
                          ? (
                            <>
                              {breakdown} · served from memory
                            </>
                          )
                          : breakdown}
                    </div>
                  </div>
                  <div className="grid-tools">
                    {rows.length > 0 && (
                      <button
                        className={`btn sm tbl-filterbtn${filterOpen ? " on" : ""}`}
                        aria-pressed={filterOpen}
                        onClick={toggleFilterMode}
                      >
                        <span className="tfb-ic" aria-hidden>▾</span> Filter{filters.length ? ` · ${filters.length}` : ""}
                      </button>
                    )}
                    <input
                      className="tbl-filter"
                      value={tableFilter}
                      onChange={(e) => setTableFilter(e.target.value)}
                      placeholder="Filter rows…"
                      aria-label="filter rows"
                    />
                    {dropped.length > 0 && (
                      <button
                        className="btn outline sm"
                        onClick={() => setHideDropped((v) => !v)}
                      >
                        {hideDropped ? "Show filtered" : "Hide filtered"}
                      </button>
                    )}
                    {rows.length > 0 && (
                      <span className="tour-anchor" data-tour="enrich">
                      <EnrichMenu
                        summary={enrichJobSummary(targets, checked.length > 0)}
                        running={enrichJobRunning}
                        enriching={Boolean(enriching)}
                        onRun={(kinds) => runEnrichJob(kinds, targets)}
                      />
                      </span>
                    )}
                    {rows.length > 0 && (
                      <span className="tour-anchor" data-tour="outreach">
                      <OutreachMenu
                        checkedRows={checked}
                        reviewCount={reviewRows.length}
                        running={outreachRunning}
                        busy={enrichJobRunning || Boolean(enriching)}
                        onGoReview={(rs) => {
                          setReviewIds(rs.map((r) => r.id));
                          setReviewLeadId(rs[0]?.id ?? null);
                          setPhase("outreach");
                          // Generation kicks off right away — the review room opens to watch it
                          // land. Cancelling the overwrite confirm still opens the room, ungenerated.
                          const edited = rs.filter((r) => r.outreach?.edited_fields?.length).length;
                          if (edited && !window.confirm(
                            `${edited} lead${edited === 1 ? "'s assets were" : "s' assets were"} hand-edited. Regenerating overwrites the edits. Continue?`,
                          )) return;
                          runOutreachJob(rs);
                        }}
                        onOpenReview={() => setPhase("outreach")}
                        onDownload={(rows) => {
                          exportOutreach(rows.map((r) => r.id), rows.length === 1 ? rows[0].name : place?.city ?? "leads")
                            .catch((e: Error) => setErrorMsg(e.message));
                        }}
                      />
                      </span>
                    )}
                  </div>
                </div>
                {rows.length > 0 && filters.length > 0 && (
                  <div className="flt-strip">
                    {filters.map((f, i) => {
                      const editable = !!ATTR_TO_COL[f.attr];
                      return (
                        <span
                          key={i}
                          className={`fchip${editable ? " editable" : ""}`}
                          onClick={editable ? () => openChip(f) : undefined}
                          role={editable ? "button" : undefined}
                          aria-label={editable ? f.label : undefined}
                          tabIndex={editable ? 0 : undefined}
                        >
                          <span className="fchip-lab">{f.label}</span>
                          <button
                            className="fchip-x"
                            aria-label={`remove ${f.label}`}
                            onClick={(e) => { e.stopPropagation(); removeFilter(f); }}
                          >
                            ✕
                          </button>
                        </span>
                      );
                    })}
                    <button className="btn ghost sm fclear" onClick={clearFilters}>Clear</button>
                  </div>
                )}
                <div className="grid-scroll">
                  <table className="htbl">
                    <thead>
                      <tr>
                        <th className="cbcol">
                          <input
                            type="checkbox"
                            className="rowcb"
                            checked={allSelected}
                            onChange={toggleSelectAll}
                            aria-label="select all live rows"
                          />
                        </th>
                        {COLUMNS.map((c) => (
                          <HeaderCell
                            key={c.id}
                            col={c}
                            sort={sort}
                            onSort={toggleSort}
                            active={filters.some((f) => colAttrs(c).includes(f.attr))}
                            open={openCol === c.id}
                            filterOpen={filterOpen}
                            onOpen={setOpenCol}
                            ctl={filterCtl}
                          />
                        ))}
                        <th className="actcol" aria-label="row actions" />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.length === 0 && !errorMsg && (
                        <tr>
                          <td colSpan={10} style={{ padding: "calc(34px * var(--space)) calc(12px * var(--space))", color: "var(--ink-3)" }}>
                            {pending || chatBusy || scanning ? "Reading your query…" : "No hotels here yet."}
                          </td>
                        </tr>
                      )}
                      {rows.length > 0 && live.length === 0 && !errorMsg && (
                        <tr>
                          <td colSpan={10} style={{ padding: "calc(34px * var(--space)) calc(12px * var(--space))", color: "var(--ink-3)" }}>
                            Nothing matches the current filters.
                          </td>
                        </tr>
                      )}
                      {live.map((h, i) => (
                        <Fragment key={h.id}>
                          {gapVisible && i === gapIndex && (
                            <tr className="grouprule gaprule">
                              <td colSpan={10}>
                                <span>
                                  {filterCounts.pass} match · {filterCounts.unknown} not yet enriched
                                  for this filter
                                </span>
                                <button
                                  className="gapdismiss"
                                  title="Dismiss for this filter"
                                  onClick={() => setDismissedGapSig(filterSignature(filters))}
                                >
                                  ✕
                                </button>
                              </td>
                            </tr>
                          )}
                          <HotelRow
                            h={h}
                            live
                            recently={recentlyResolved.has(h.id)}
                            ownerStage={ownerStage}
                            researchingIds={researchingIds}
                            selected={selectedIds.has(h.id)}
                            lit={(hoverId ?? focusId) === h.id}
                            onHover={setHoverId}
                            onSelect={() => toggleSelect(h.id)}
                            onFocus={() => focusRow(h)}
                            onOpen={() => setOpenId(h.id)}
                            onDelete={() => setPendingDelete({ ids: [h.id], label: h.name })}
                          />
                        </Fragment>
                      ))}
                      {!hideDropped && dropped.length > 0 && (
                        <tr className="grouprule">
                          <td colSpan={10}>
                            <span>Filtered out · {dropped.length} — kept visible</span>
                          </td>
                        </tr>
                      )}
                      {!hideDropped &&
                        dropped.map((h) => (
                          <HotelRow
                            key={h.id}
                            h={h}
                            live={false}
                            recently={false}
                            ownerStage={ownerStage}
                            researchingIds={researchingIds}
                            selected={selectedIds.has(h.id)}
                            lit={(hoverId ?? focusId) === h.id}
                            onHover={setHoverId}
                            onSelect={() => toggleSelect(h.id)}
                            onFocus={() => focusRow(h)}
                            onOpen={() => setOpenId(h.id)}
                            onDelete={() => setPendingDelete({ ids: [h.id], label: h.name })}
                          />
                        ))}
                    </tbody>
                  </table>
                </div>

                {/* the quiet review line (ADR-083 / mock review-options.html option A) — the
                    ambiguous few sit under the trusted list; never nags, one tap opens triage */}
                {reviewBand.length > 0 && (
                  <button className="mf-reviewline" onClick={() => setReviewOpen(true)}>
                    <span className="chev">⌄</span>
                    <span>
                      <b>{reviewBand.length}</b> more we weren’t sure about
                      <span className="mf-review-map"> · ◌ on the map</span>
                    </span>
                    <span className="go">Review them ›</span>
                  </button>
                )}

              </div>
              )}
              </div>
            </section>
          )}
        </div>

        {/* dossier slide-over */}
        <div className={`scrim${openRow ? " on" : ""}`} onClick={() => setOpenId(null)} />
        <aside className={`dossier${openRow ? " on" : ""}`} aria-hidden={!openRow}>
          {openRow && (
            <Dossier
              h={openRow}
              onClose={() => setOpenId(null)}
              onPatch={handlePatch}
              onSaveContacts={handleSaveContacts}
              onFindContacts={(id) => {
                // ADR-110/114/116: the owner row's per-hotel re-run of phase 3 — the contact recipe (if
                // not tried in 30 days) then Apollo on the card's people of interest
                const target = rows.find((r) => r.id === id);
                if (target) void runEnrichJob(["contacts"], [target]);
              }}
              findingContacts={enrichJobRunning}
              onOpenReview={(id) => {
                setReviewIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
                setReviewLeadId(id);
                setOpenId(null);
                setPhase("outreach");
              }}
            />
          )}
        </aside>

        {/* delete confirm gate (ADR-057) */}
        {pendingDelete && (
          <div className="scrim on" onClick={() => !deleting && setPendingDelete(null)}>
            <div className="confirm-modal" role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
              <div className="cm-title">
                {pendingDelete.ids.length > 1 ? "Delete these hotels?" : "Delete this hotel?"}
              </div>
              <div className="cm-body">
                <b>{pendingDelete.label}</b> will be permanently removed from the database. A
                recovery snapshot is kept, but{" "}
                {pendingDelete.ids.length > 1 ? "they disappear" : "it disappears"} from every
                market view.
              </div>
              <div className="cc-btns">
                <button type="button" className="btn warn sm" disabled={deleting} onClick={confirmDelete}>
                  {deleting ? "Deleting…" : "Delete permanently"}
                </button>
                <button type="button" className="btn ghost sm" disabled={deleting} onClick={() => setPendingDelete(null)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* add-leads slide-over (ADR-046) */}
        <div className={`scrim${addLeadsOpen ? " on" : ""}`} onClick={() => setAddLeadsOpen(false)} />
        <aside className={`addleads${addLeadsOpen ? " on" : ""}`} aria-hidden={!addLeadsOpen}>
          {addLeadsOpen && (
            <AddLeads
              market={place}
              onClose={() => setAddLeadsOpen(false)}
              onCommitted={() => { if (place?.city) goPlan(place.city); }}
            />
          )}
        </aside>

        {/* ADR-090 — Layer-1 guided tour overlay (auto-plays on each new market; ? replays it) */}
        <Tour open={tourOpen} onClose={() => setTourOpen(false)} onMute={muteTour} />

      </div>
    </div>
  );
}

// ── funnel rail ─────────────────────────────────────────────────────────────
// ADR-030: a status display only — the funnel reflects the universe → live-set narrowing and the
// owner step's state. The owner-research controls live in the Enrich toolbar popover (ADR-050).
function Funnel(props: {
  steps: PlanStep[];
  universeCount: number;
  liveCount: number;
  ownerStage: OwnerStage;
  statusMsg: string | null;
  doneInfo: { fromMemory?: boolean; status?: string; narrowing?: string[]; message?: string } | null;
  errorMsg: string | null;
}) {
  const { steps, universeCount, liveCount, ownerStage, statusMsg, doneInfo, errorMsg } = props;

  const width = (n: number) =>
    universeCount > 0 ? Math.max(14, Math.round((n / universeCount) * 100)) : 100;

  if (errorMsg) {
    return <div className="stage-note" style={{ color: "var(--danger-ink)" }}>⚠ {errorMsg}</div>;
  }

  if (steps.length === 0) {
    // No plan yet — a typed search still classifying, or a pin scan (which never gets a plan
    // frame; ADR-079 phase 3): surface the streamed progress line while the scan runs.
    return (
      <div className="stage-note">
        <span className="spin ac" /> {statusMsg ?? "Reading your query…"}
      </div>
    );
  }

  // The owner step is always the last (costTier === "owner"); the rest are free/cheap and
  // have already run by the time the grid is populated.
  const ownerStep = steps.find((s) => s.costTier === "owner");
  const upstream = steps.filter((s) => s.costTier !== "owner");

  return (
    <>
      {upstream.map((s, i) => {
        const isLast = i === upstream.length - 1;
        const count = isLast ? liveCount : universeCount;
        const of = isLast && universeCount ? universeCount : undefined;
        return (
          <div className="stage done" key={s.idx}>
            <span className="node" />
            <div className="stage-top">
              <div>
                <span className="stage-idx mono">{String(s.idx).padStart(2, "0")}</span>
                <span className="stage-name">{s.name}</span>
              </div>
            </div>
            <div className="fbar-wrap">
              <div className="fbar" style={{ width: `${width(count)}%` }}>
                <i />
                <span className="cnt">
                  {count} <small>{of ? `of ${of}` : "found"}</small>
                </span>
              </div>
            </div>
            <div className="stage-note">{s.note}</div>
          </div>
        );
      })}

      {ownerStep && (
        <OwnerStageView
          step={ownerStep}
          stage={ownerStage}
          liveCount={liveCount}
          width={width(liveCount)}
          statusMsg={statusMsg}
        />
      )}

      {/* done notices (cached / too-broad) */}
      {doneInfo?.status === "too_broad" && doneInfo.narrowing && doneInfo.narrowing.length > 0 && (
        <div className="stage-note" style={{ marginTop: "calc(12px * var(--space))" }}>
          <b>Too broad to research exhaustively.</b> Try narrowing it:{" "}
          {doneInfo.narrowing.join(", ")}.
        </div>
      )}
      {doneInfo?.message && doneInfo.status !== "too_broad" && (
        <div className="stage-note" style={{ marginTop: "calc(12px * var(--space))" }}>
          {doneInfo.message}
        </div>
      )}
    </>
  );
}

// The owner step in the funnel — pure status (queued / running / done / skipped). No gate UI.
function OwnerStageView(props: {
  step: PlanStep;
  stage: OwnerStage;
  liveCount: number;
  width: number;
  statusMsg: string | null;
}) {
  const { step, stage, liveCount, width, statusMsg } = props;
  const idx = String(step.idx).padStart(2, "0");

  if (stage === "running") {
    return (
      <div className="stage running">
        <span className="node" />
        <div className="stage-top">
          <div>
            <span className="stage-idx mono">{idx}</span>
            <span className="stage-name">{step.name}</span>
          </div>
          <span className="cost owner">
            <span className="spin" />
          </span>
        </div>
        <div className="fbar-wrap">
          <div className="fbar" style={{ width: `${width}%` }}>
            <i />
            <span className="cnt">…</span>
          </div>
        </div>
        <div className="stage-note">
          {statusMsg ?? `Tracing ownership across ${liveCount} properties…`}
        </div>
      </div>
    );
  }

  if (stage === "skipped") {
    return (
      <div className="stage skipped">
        <span className="node" />
        <div className="stage-top">
          <div>
            <span className="stage-idx mono">{idx}</span>
            <span className="stage-name">{step.name}</span>
          </div>
          <span className="cost owner">skipped</span>
        </div>
        <div className="stage-note">Skipped — owners left unresolved.</div>
      </div>
    );
  }

  if (stage === "done") {
    return (
      <div className="stage done">
        <span className="node" />
        <div className="stage-top">
          <div>
            <span className="stage-idx mono">{idx}</span>
            <span className="stage-name">{step.name}</span>
          </div>
          <span className="cost owner">resolved</span>
        </div>
        <div className="stage-note">Owners resolved on the targeted set.</div>
      </div>
    );
  }

  // queued — owner research not run yet; the Enrich toolbar popover drives it
  return (
    <div className="stage">
      <span className="node" />
      <div className="stage-top">
        <div>
          <span className="stage-idx mono">{idx}</span>
          <span className="stage-name">{step.name}</span>
        </div>
        <span className="cost owner">owner research</span>
      </div>
      <div className="stage-note">{step.note}</div>
    </div>
  );
}

// ── selection dock (ADR-079) — bulk actions exist only while something is selected ──
// Floats over the map (or over the list when the map is collapsed). Feedback #9: it carries
// the full Enrich popover (facts/owner/contacts/reviews, eligibility-gated) — not a lone
// owner-research shortcut — plus the existing Outreach flow and Clear. Purely presentational.
function SelectionDock(props: {
  count: number;
  onClear: () => void;
  enrich: ReactNode;
  outreach: ReactNode;
}) {
  const { count, onClear, enrich, outreach } = props;
  return (
    <div className="mf-dock" role="toolbar" aria-label="selection actions">
      <b>{count} selected</b>
      {enrich}
      {outreach}
      <button className="mf-pill" onClick={onClear}>Clear</button>
    </div>
  );
}

// ── filter bar (ADR-030) — keys range · ownerType, plus chips + Clear ───────────────
// ── progress strip (ADR-031) ─────────────────────────────────────────────────
// The single home for in-flight progress, between the table header and the filters. Shows the
// current action's label + sub-step + count + a bar (determinate when total is known, animated
// shimmer otherwise). On completion it flashes green with a one-line summary, then fades.
function ActivityStrip({ activity, done }: { activity: Activity | null; done: ActivityDone | null }) {
  if (!activity && !done) return null;

  // Active activity wins over a lingering done-flash (a new run can start within the flash window).
  if (!activity && done) {
    return (
      <div className={`actstrip done ${done.tone}`}>
        <div className="as-row">
          <span className="as-ic"><span className="as-check">✓</span></span>
          <div className="as-main">
            <div className="as-label">{done.label}</div>
            <div className="as-sub">{done.summary}</div>
          </div>
        </div>
        <div className="pbar as-pbar"><i style={{ width: "100%" }} /></div>
      </div>
    );
  }

  const a = activity!;
  const determinate = a.total != null && a.total > 0;
  const pct = determinate ? Math.min(100, Math.round((a.done! / a.total!) * 100)) : 0;
  const owner = a.tone === "owner";
  return (
    <div className={`actstrip${owner ? " owner" : ""}`}>
      <div className="as-row">
        <span className="as-ic"><span className={`spin${owner ? "" : " ac"}`} /></span>
        <div className="as-main">
          <div className="as-label">{a.label}</div>
          {a.sub ? <div className="as-sub">{a.sub}</div> : null}
        </div>
        <span className="as-spacer" />
        {determinate ? <span className="as-count"><b>{Math.min(a.done!, a.total!)}</b> / {a.total}</span> : null}
      </div>
      <div className={`pbar as-pbar${owner ? " owner" : ""}${determinate ? "" : " indet"}`}>
        <i style={determinate ? { width: `${pct}%` } : undefined} />
      </div>
    </div>
  );
}

// ── ADR-086: column-header filtering (Model A) ───────────────────────────────
// The setters/getters a funnel popover needs, bundled so HeaderCell takes one prop.
type FilterCtl = {
  boundVal: (a: FilterAttr, op: ">=" | "<=") => number | undefined;
  setRange: (a: FilterAttr, op: ">=" | "<=", n: number | null) => void;
  enumSel: (a: FilterAttr) => string[];
  toggleEnumVal: (a: FilterAttr, v: string) => void;
  textVal: (a: FilterAttr) => string;
  setText: (a: FilterAttr, v: string) => void;
};

// A column header: the label sorts (click), the ▾ funnel (filterable columns only) opens a
// per-column filter popover. The two targets are separate elements so they never collide.
// `◷` marks a paid-enrichment column (Owner).
function HeaderCell(props: {
  col: ColDef;
  sort: { key: SortKey; dir: "asc" | "desc" };
  onSort: (k: SortKey) => void;
  active: boolean;
  open: boolean;
  filterOpen: boolean;
  onOpen: (id: string | null) => void;
  ctl: FilterCtl;
}) {
  const { col, sort, onSort, active, open, filterOpen, onOpen, ctl } = props;
  const sorted = sort.key === col.sortKey;
  // The funnel shows in filter mode, or on a column that already has a filter (keep it editable).
  const showFunnel = !!col.filter && (filterOpen || active);
  return (
    <th
      className={`sortable${col.numeric ? " num" : ""}${sorted ? " sorted" : ""}${active ? " filtered" : ""}`}
      aria-sort={sorted ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <span className="th-in">
        <button className="th-sort" onClick={() => onSort(col.sortKey)}>
          {col.label}
          {col.cost === "research" && (
            <span
              className="paidmk"
              title="Fills after paid enrichment — filtered rows stay “unknown” (kept, not dropped) until you run it"
            >
              ◷
            </span>
          )}
          <span className="sort-ind">{sorted ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}</span>
        </button>
        {showFunnel && (
          <button
            className={`th-funnel${active ? " on" : ""}`}
            aria-label={`Filter ${col.label}`}
            aria-expanded={open}
            onClick={(e) => { e.stopPropagation(); onOpen(open ? null : col.id); }}
          >
            ▾
          </button>
        )}
      </span>
      {open && col.filter && <FilterPopover col={col} ctl={ctl} onClose={() => onOpen(null)} />}
    </th>
  );
}

// The per-column filter editor. Filters apply live (no Apply button); a full-screen backdrop
// dismisses. Range → min/max per numeric attr; enum → option toggles; text → substring.
function FilterPopover(props: { col: ColDef; ctl: FilterCtl; onClose: () => void }) {
  const { col, ctl, onClose } = props;
  const f = col.filter!;
  return (
    <>
      <button className="fpop-backdrop" aria-hidden tabIndex={-1} onClick={onClose} />
      <div className={`fpop${col.popRight ? " right" : ""}`} role="dialog" aria-label={`Filter ${col.label}`} onClick={(e) => e.stopPropagation()}>
        <div className="fpop-title">Filter · {col.label}</div>
        {col.cost === "research" && (
          <div className="fpop-note">
            ◷ Fills after paid enrichment — matching rows stay “unknown” (kept, not dropped) until you run it.
          </div>
        )}
        {f.kind === "range" &&
          f.ranges.map((r) => (
            <div className="fpop-row" key={r.attr}>
              <span className="flab">{r.label}</span>
              <input
                type="number"
                className="fnum"
                placeholder="min"
                aria-label={`minimum ${r.label}`}
                value={ctl.boundVal(r.attr, ">=") ?? ""}
                onChange={(e) => ctl.setRange(r.attr, ">=", e.target.value === "" ? null : Number(e.target.value))}
              />
              <span className="fdash">–</span>
              <input
                type="number"
                className="fnum"
                placeholder="max"
                aria-label={`maximum ${r.label}`}
                value={ctl.boundVal(r.attr, "<=") ?? ""}
                onChange={(e) => ctl.setRange(r.attr, "<=", e.target.value === "" ? null : Number(e.target.value))}
              />
            </div>
          ))}
        {f.kind === "enum" && (
          <div className="fopts">
            {f.opts.map((o) => (
              <button
                key={o}
                className={`fopt${ctl.enumSel(f.attr).includes(o) ? " on" : ""}`}
                onClick={() => ctl.toggleEnumVal(f.attr, o)}
              >
                {f.attr === "brandAffiliation" ? affiliationLabel(o) : o}
              </button>
            ))}
          </div>
        )}
        {f.kind === "text" && (
          <input
            className="ftext"
            placeholder={`${col.label} contains…`}
            aria-label={`${col.label} contains`}
            defaultValue={ctl.textVal(f.attr)}
            onChange={(e) => ctl.setText(f.attr, e.target.value)}
          />
        )}
        <div className="fpop-foot">
          <button className="btn ghost sm" onClick={onClose}>Done</button>
        </div>
      </div>
    </>
  );
}

// ── unified enrich popover (ADR-050) ─────────────────────────────────────────
// Toolbar button + dropdown: per-kind checkboxes with eligible count + cost from enrichJobSummary.
// Default all-unchecked; Run enabled only when a checked kind has eligible work.
function EnrichMenu(props: {
  summary: ReturnType<typeof enrichJobSummary>;
  running: boolean;
  enriching: boolean;
  onRun: (kinds: EnrichKind[]) => void;
}) {
  const { summary, running, enriching, onRun } = props;
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<EnrichKind>>(new Set());
  // ADR-114 (the team 2026-09-25): one button — owner research runs the contact search as its
  // phase 3, so the separate "Corporate contacts" row is gone. ADR-116: Apollo runs inside that
  // phase too; the dossier's "Find decision-makers" is the per-hotel re-run of the same phase.
  const kindRows: { kind: EnrichKind; label: string; s: KindSummary; zeroReason: string }[] = [
    { kind: "owner", label: "Owner & contact research", s: summary.owner, zeroReason: "all owners on file" },
    { kind: "reviews", label: "Reviews & rates", s: summary.reviews, zeroReason: "all fresh (30d)" },
  ];
  const toggle = (k: EnrichKind) =>
    setPicked((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const runnable = [...picked].filter((k) => kindRows.find((r) => r.kind === k)!.s.eligible > 0);
  return (
    <div className="enrich-menu">
      <button className="btn sm" onClick={() => setOpen((o) => !o)} disabled={enriching || running}>
        {running ? <><span className="spin" /> Enriching…</> : "Enrich ▾"}
      </button>
      {open && (
        <div className="em-pop">
          <div className="em-kinds">
            {kindRows.map(({ kind, label, s, zeroReason }) => (
              <label key={kind} className={`em-row${s.eligible === 0 ? " off" : ""}`}>
                <input type="checkbox" disabled={s.eligible === 0}
                  checked={picked.has(kind)} onChange={() => toggle(kind)} />
                <span className="em-lab">{label}</span>
                <span className="em-meta">{s.eligible === 0 ? zeroReason : `${s.eligible}`}</span>
              </label>
            ))}
          </div>
          <div className="em-foot">
            <span />
            <button className="btn warn sm" disabled={runnable.length === 0}
              onClick={() => { setOpen(false); onRun(runnable); }}>
              Run
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── outreach button + generate prompt (ADR-065) ────────────────────────────
// The popover's Generate button brings the selection into the review room AND starts generation
// in one click. With nothing selected the toolbar button reopens the existing review set.
// ── outreach settings page (ADR-071) — full-page takeover over whatever screen the user was
// on. It never touches `phase`, so Close always lands back exactly where they were (home or
// the live set). Two team-edited canvases over GET/PUT /api/settings/outreach: the free-text
// right-to-win context and the copy agent's system prompt. ──────────────────────────────────
type OutreachSettings = { right_to_win: string; copy_prompt: string };

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

// ── teaser PDF section (ADR-126) — pure helpers, exported for tests ─────────────────────────
// IMMEDIATE-APPLY: an upload replaces the one teaser on success; none of it touches the page's
// draft/saved/dirty machinery.
const TEASER_MAX_BYTES = 20 * 1024 * 1024;

export const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

// Upload date for the card — UTC so the label matches the server's timestamp.
export const formatUploadedAt = (iso: string): string => {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};

// Checked before upload so a wrong file never travels; the server checks again.
export function teaserProblem(f: { name: string; type: string; size: number }): string | null {
  const isPdf = f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
  if (!isPdf) return "The teaser must be a PDF — export the deck as PDF first.";
  if (f.size > TEASER_MAX_BYTES) return `This PDF is ${formatBytes(f.size)}; the limit is 20 MB.`;
  return null;
}

// FastAPI errors carry {detail}; surface that verbatim.
export async function uploadErrorDetail(
  res: { status: number; json: () => Promise<unknown> },
  action: string,
): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string } | null;
  return body?.detail ?? `${action} failed (${res.status}).`;
}

export async function postTeaser(file: File): Promise<TeaserMeta> {
  const problem = teaserProblem(file);
  if (problem) throw new Error(problem);
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(apiUrl("/api/settings/teaser"), { method: "POST", body: fd });
  if (!res.ok) throw new Error(await uploadErrorDetail(res, "Upload"));
  return ((await res.json()) as { teaser: TeaserMeta }).teaser;
}

function SettingsPage(props: { onClose: () => void }) {
  const { onClose } = props;
  const [saved, setSaved] = useState<OutreachSettings | null>(null);
  const [draft, setDraft] = useState<OutreachSettings | null>(null);
  const [pane, setPane] = useState<"rtw" | "agent" | "teaser">("rtw");
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Teaser PDF (ADR-126) — immediate-apply; deliberately OUTSIDE saved/draft/dirty.
  const [teaser, setTeaser] = useState<TeaserMeta | null | undefined>(undefined); // undefined = loading
  const [teaserErr, setTeaserErr] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    fetch(apiUrl("/api/settings/outreach"))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((j: OutreachSettings) => { setSaved(j); setDraft(j); })
      .catch((e: Error) => setErr(`Couldn't load: ${e.message}`));
    fetchTeaser().then(setTeaser).catch((e: Error) => setTeaserErr(e.message));
  }, []);
  const onPickTeaser = (file: File | undefined) => {
    if (!file || uploading) return;
    setUploading(true); setTeaserErr(null);
    postTeaser(file)
      .then(setTeaser)
      .catch((e: Error) => setTeaserErr(e.message))
      .finally(() => setUploading(false));
  };
  const dirtyRtw = !!saved && !!draft && draft.right_to_win !== saved.right_to_win;
  const dirtyAgent = !!saved && !!draft && draft.copy_prompt !== saved.copy_prompt;
  const anyDirty = dirtyRtw || dirtyAgent;
  const close = () => {
    if (anyDirty && !window.confirm("Discard unsaved changes?")) return;
    onClose();
  };
  const save = () => {
    if (!draft) return;
    setSaving(true); setErr(null);
    fetch(apiUrl("/api/settings/outreach"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    }).then(async (r) => {
      if (!r.ok) throw new Error(((await r.json()) as { detail?: string }).detail ?? `${r.status}`);
      return r.json();
    }).then((j: OutreachSettings) => { setSaved(j); setDraft(j); })
      .catch((e: Error) => setErr(`Couldn't save: ${e.message}`))
      .finally(() => setSaving(false));
  };
  return (
    <div className="stg-page" role="dialog" aria-modal="true">
      <div className="stg-head">
        <div className="stg-head-inner">
          <div className="stg-title"><span className="kick">OUTREACH</span> Settings</div>
          <span className="spacer" />
          {err && <span className="stg-err">{err}</span>}
          {anyDirty && <span className="stg-unsaved">Unsaved changes</span>}
          <button className="btn ghost sm" disabled={!anyDirty || saving} onClick={() => setDraft(saved)}>
            Discard
          </button>
          <button className="btn accent sm" disabled={!anyDirty || saving} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button className="btn sm" title="Back to where you were" onClick={close}>Close</button>
        </div>
      </div>
      <div className="stg-body">
        <div className="stg-rail">
          <div className="stg-group">Outreach</div>
          <button className={`stg-item${pane === "rtw" ? " on" : ""}${dirtyRtw ? " dirty" : ""}`}
            onClick={() => setPane("rtw")}>
            <span className="t">✳ Right-to-win<span className="dot" /></span>
            <span className="d">Why Cognitidata wins — the proof the emails may draw on</span>
          </button>
          <button className={`stg-item${pane === "agent" ? " on" : ""}${dirtyAgent ? " dirty" : ""}`}
            onClick={() => setPane("agent")}>
            <span className="t">✍ Copy agent<span className="dot" /></span>
            <span className="d">System prompt of the agent that writes the emails</span>
          </button>
          <button className={`stg-item${pane === "teaser" ? " on" : ""}`}
            onClick={() => setPane("teaser")}>
            <span className="t">▤ Teaser PDF<span className="dot" /></span>
            <span className="d">The deck attached to every outreach email</span>
          </button>
          <div className="stg-railfoot">
            Edits apply from the <b>next generation run</b> — emails already in review are
            untouched. Nothing is ever sent automatically.
          </div>
        </div>
        {pane === "rtw" ? (
          <div className="stg-pane">
            <h1>Right <em>to win</em></h1>
            <div className="stg-sub">
              Everything the email generator is allowed to say about Cognitidata — social
              proof, portfolio facts, results, positioning. Free-form: write it the way you'd
              brief a new BD hire. The generator picks the 1–2 points that fit each lead.{" "}
              <b>Keep every claim verified.</b>
            </div>
            <textarea
              className="stg-canvas"
              spellCheck={false}
              aria-label="right-to-win context"
              value={draft?.right_to_win ?? ""}
              disabled={!draft}
              placeholder={draft ? "" : "Loading…"}
              onChange={(e) => draft && setDraft({ ...draft, right_to_win: e.target.value })}
            />
            <div className="stg-meta">
              <span />
              <span>{draft ? `${wordCount(draft.right_to_win)} words` : ""}</span>
            </div>
          </div>
        ) : pane === "agent" ? (
          <div className="stg-pane">
            <h1>Copy <em>agent</em></h1>
            <div className="stg-sub">
              The system prompt of the agent that writes every outreach email. It reads the
              lead's dossier and the right-to-win context, then drafts the email under these
              instructions. The <span className="code">{"{fit} {args} {register} {lead}"}</span>{" "}
              slots are filled by the system and must stay in.
            </div>
            <div className="stg-power">
              ⚠ <span><b>Power tool.</b> A one-word change here shifts every email generated
              from now on. Test on one lead in the review room before a batch run.</span>
            </div>
            <textarea
              className="stg-canvas mono"
              spellCheck={false}
              aria-label="copy agent system prompt"
              value={draft?.copy_prompt ?? ""}
              disabled={!draft}
              placeholder={draft ? "" : "Loading…"}
              onChange={(e) => draft && setDraft({ ...draft, copy_prompt: e.target.value })}
            />
            <div className="stg-meta">
              <span />
              <span>{draft ? `${wordCount(draft.copy_prompt)} words` : ""}</span>
            </div>
          </div>
        ) : (
          <div className="stg-pane">
            <h1>Teaser <em>PDF</em></h1>
            <div className="stg-sub">
              The deck attached, as it is, to every outreach email. One at a time — uploading a
              new PDF replaces the current one. PDF only, up to 20 MB. <b>Changes apply
              immediately</b> — Save/Discard above don't touch this section.
            </div>
            {teaserErr && <div className="stg-tpl-err">{teaserErr}</div>}
            <div className="stg-tpl-card">
              {teaser === undefined && <div className="ph">Loading…</div>}
              {teaser === null && (
                <div className="ph">No teaser uploaded yet. Outreach export is off until one is.</div>
              )}
              {teaser && (
                <>
                  <div className="f">{teaser.filename}</div>
                  <div className="m">{formatBytes(teaser.size)} · uploaded {formatUploadedAt(teaser.uploaded_at)}</div>
                </>
              )}
            </div>
            <div className="stg-tpl-actions">
              <input
                ref={fileRef}
                type="file"
                accept="application/pdf,.pdf"
                hidden
                aria-label="teaser PDF file"
                onChange={(e) => { onPickTeaser(e.target.files?.[0]); e.target.value = ""; }}
              />
              <button className="btn accent sm" disabled={teaser === undefined || uploading}
                onClick={() => fileRef.current?.click()}>
                {uploading ? "Uploading…" : teaser ? "Replace PDF" : "Upload PDF"}
              </button>
              {teaser && <a className="btn ghost sm" href={teaserFileUrl(true)}>Download</a>}
            </div>
            {teaser && (
              <iframe
                className="stg-teaser-frame"
                title="teaser PDF preview"
                src={teaserPreviewSrc(teaser)}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function OutreachMenu(props: {
  checkedRows: Row[];
  reviewCount: number; // the current review set — shortcut back into the review room
  running: boolean;
  busy: boolean; // another job (enrich/auto-enrich) is in flight — backend is single-flight
  onGoReview: (rows: Row[]) => void;
  onOpenReview: () => void;
  onDownload: (rows: Row[]) => void; // ADR-069 — bulk zip straight from the live set
}) {
  const { checkedRows, reviewCount, running, busy, onGoReview, onOpenReview, onDownload } = props;
  const withAssets = checkedRows.filter((r) => r.outreach);
  const [open, setOpen] = useState(false);
  // ADR-066 readiness gate: EVERY selected lead must have owner research + contact enrichment
  // run at least once (found-nothing counts). One blocked lead blocks the whole move.
  const blocked = checkedRows
    .map((r) => ({ row: r, blockers: outreachBlockers(r) }))
    .filter((b) => b.blockers.length > 0);
  return (
    <div className="enrich-menu">
      <button
        className="btn sm"
        disabled={busy || running || (checkedRows.length === 0 && reviewCount === 0)}
        title={checkedRows.length === 0 && reviewCount === 0 ? "Select rows to take to outreach review" : undefined}
        onClick={() => {
          if (checkedRows.length === 0) onOpenReview();
          else setOpen((o) => !o);
        }}
      >
        {running ? <><span className="spin" /> Outreach…</> : `Outreach${checkedRows.length ? ` (${checkedRows.length})` : ""}`}
      </button>
      {open && (
        <div className="em-pop om-pop">
          <div className="om-title">Generate outreach assets</div>
          <div className="om-sub">
            Generates a personalized email + teaser per lead and opens the review
            room — <b>nothing is sent</b>.
          </div>
          {blocked.length > 0 ? (
            <div className="om-err">
              <div className="om-err-t">
                Can't move to outreach — {blocked.length} of {checkedRows.length} selected{" "}
                lead{blocked.length === 1 ? " is" : "s are"} missing required enrichment (it must
                have run at least once, even if nothing was found):
              </div>
              <ul>
                {blocked.slice(0, 5).map(({ row, blockers }) => (
                  <li key={row.id}>
                    <b>{row.name}</b> — {blockers.join(" and ")} not run
                  </li>
                ))}
                {blocked.length > 5 && <li>…and {blocked.length - 5} more</li>}
              </ul>
              <div className="om-err-h">
                Run <b>Enrich ▾</b> (Owner &amp; contact research) on these leads first,
                or drop them from the selection.
              </div>
            </div>
          ) : (
            <div className="om-facts">
              <div className="om-fact"><span>Ready for outreach</span><b>{checkedRows.length} of {checkedRows.length} selected</b></div>
            </div>
          )}
          <div className="em-foot">
            <span />
            {withAssets.length > 0 && (
              <button
                className="btn sm"
                title="One Outlook draft per lead (teaser PDF attached), for the selected leads that already have assets"
                onClick={() => { setOpen(false); onDownload(withAssets); }}
              >
                Download emails ({withAssets.length})
              </button>
            )}
            <button
              className="btn warn sm"
              disabled={blocked.length > 0}
              onClick={() => { setOpen(false); onGoReview(checkedRows); }}
            >
              Generate ({checkedRows.length})
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── outreach asset editor (review room detail pane) ────────────────────────
// Remounted per lead+generation via key=, so local drafts always seed from the current package.
function OutreachEditor(props: {
  row: Row;
  busy: boolean;
  teaser: TeaserMeta | null | undefined; // undefined = loading (ADR-126)
  onSave: (row: Row, field: OutreachEditableField, value: string) => Promise<boolean>;
}) {
  const { row, busy, teaser, onSave } = props;
  const pkg = row.outreach!;
  const c = pkg.content;
  const [subject, setSubject] = useState(c.email_subject);
  const [body, setBody] = useState(c.email_body);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const edited = new Set(pkg.edited_fields ?? []);
  const save = async (field: OutreachEditableField, value: string, orig: string) => {
    if (value === orig) return;
    setSaveErr((await onSave(row, field, value)) ? null : "Save failed — edit again to retry.");
  };
  const copy = (text: string) => { void navigator.clipboard?.writeText(text); };
  return (
    <>
      {saveErr && <div className="rd-err">{saveErr}</div>}
      <div className="rd-scroll">
      <div className="oe-card">
        <div className="oe-head">
          <span className="oe-t">Email</span>
          {edited.has("email_subject") || edited.has("email_body")
            ? <span className="rq-chip edited">✎ edited</span> : <span className="rq-chip ready">✓ ready</span>}
          <span className="spacer" />
          <button className="btn ghost sm" onClick={() => copy(`${subject}\n\n${body}`)}>Copy</button>
        </div>
        <input
          className="oe-subject"
          value={subject}
          disabled={busy}
          onChange={(e) => setSubject(e.target.value)}
          onBlur={() => save("email_subject", subject, c.email_subject)}
          aria-label="email subject"
        />
        <textarea
          className="oe-body"
          rows={12}
          value={body}
          disabled={busy}
          onChange={(e) => setBody(e.target.value)}
          onBlur={() => save("email_body", body, c.email_body)}
          aria-label="email body"
        />
        <div className="oe-cue">Edits save when you click away. Regenerate asks before overwriting them.</div>
      </div>
      <div className="oe-card oe-teaser">
        <div className="oe-head">
          <span className="oe-t">Teaser</span>
          {teaser && <span className="rq-chip ready">{teaser.filename}</span>}
          <span className="spacer" />
          {teaser && <a className="btn ghost sm" href={teaserFileUrl(true)}>PDF</a>}
        </div>
        {teaser === undefined && <div className="oe-cue">Loading the teaser…</div>}
        {teaser === null && (
          <div className="oe-teaser-empty">
            No teaser uploaded — add one in <b>Settings → Teaser PDF</b>. Export is off until then.
          </div>
        )}
        {teaser && (
          <iframe
            className="oe-teaser-frame"
            title="teaser preview"
            src={teaserPreviewSrc(teaser)}
          />
        )}
      </div>
      </div>
    </>
  );
}

// ── grid row ──────────────────────────────────────────────────────────────
// Feedback #10: clicking the row FOCUSES it (the map flies to its pin) — the dossier opens
// only from the name link (or the pin popup's "Open dossier"). Hover is shared with the map.
function HotelRow(props: {
  h: ClassifiedRow;
  live: boolean;
  recently: boolean;
  ownerStage: OwnerStage;
  researchingIds: Set<string>;
  selected: boolean;
  lit: boolean;
  onHover: (id: string | null) => void;
  onSelect: () => void;
  onFocus: () => void;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const { h, live, recently, ownerStage, researchingIds, selected, lit, onHover, onSelect, onFocus, onOpen, onDelete } = props;
  const dots = confDots(h.ownerConf);
  const age = factAge(h.updatedAt);  // ADR-023: surface facts staleness in the table, not just the dossier

  return (
    <tr
      className={`${live ? "live" : "dropped"}${recently ? " resolved" : ""}${selected ? " picked" : ""}${lit ? " lit" : ""}`}
      onClick={onFocus}
      onMouseEnter={() => onHover(h.id)}
      onMouseLeave={() => onHover(null)}
    >
      <td className="cbcol" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          className="rowcb"
          checked={selected}
          onChange={onSelect}
          aria-label={`select ${h.name}`}
        />
      </td>
      <td>
        <div className="row-name">
          <button
            type="button"
            className="namelink"
            title="Open the dossier"
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
          >
            {h.name}
          </button>
          {h.isNew && (
            <span
              style={{
                marginLeft: "calc(6px * var(--space))",
                fontSize: 9,
                fontWeight: 600,
                color: "var(--ok-ink)",
                background: "var(--ok-tint)",
                borderRadius: "var(--radius-pill)",
                padding: "calc(1px * var(--space)) calc(6px * var(--space))",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              new
            </span>
          )}
          {age?.stale && (
            <span
              title={`Facts updated ${age.label} — may be stale; select and re-enrich to refresh`}
              style={{
                marginLeft: "calc(6px * var(--space))",
                fontSize: 9,
                fontWeight: 600,
                color: "var(--warn-ink)",
                background: "var(--warn-tint)",
                borderRadius: "var(--radius-pill)",
                padding: "calc(1px * var(--space)) calc(6px * var(--space))",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              stale
            </span>
          )}
          {noHotelData(h) && (
            <span
              className="nodata-badge"
              title="Enrichment ran and found no hotel data (keys, brand, amenities) — this may not be a hotel"
            >
              no hotel data
            </span>
          )}
          {h.outreach && (
            <span
              title={`Outreach assets created ${h.outreach.generated_at.slice(0, 10)} — open the dossier or the review room to view them`}
              style={{
                marginLeft: "calc(6px * var(--space))",
                fontSize: 9,
                fontWeight: 600,
                color: "var(--accent-ink)",
                background: "var(--accent-tint)",
                borderRadius: "var(--radius-pill)",
                padding: "calc(1px * var(--space)) calc(6px * var(--space))",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              outreach
            </span>
          )}
        </div>
        <div className="row-seg">
          {h.city ?? ""}
          {!live && h.reason ? (
            <>
              {h.city ? " · " : ""}
              <span className="reason">{h.reason}</span>
            </>
          ) : null}
        </div>
      </td>
      <td className="num">
        {h.keys == null && h.residences == null
          ? (factsAttempted(h)
              ? <NoneFound checkedAt={h.factsAttemptedAt} what="keys or residences" />
              : <NeedsEnrichment what="keys or residences" />)
          : <>{h.keys ?? "—"} / {h.residences ?? "—"}</>}
      </td>
      <td><Stars n={h.starRating} checkedAt={h.reviewsAttemptedAt} /></td>
      <td><Rating score={h.bookingRating} count={h.bookingReviews} checkedAt={h.reviewsAttemptedAt} /></td>
      <td>{h.brand ?? (factsAttempted(h) ? <NoneFound checkedAt={h.factsAttemptedAt} what="brand" /> : <NeedsEnrichment what="brand" />)}</td>
      <td>
        <span title={affiliationTooltip(h.brandAffiliation)}>{affiliationLabel(h.brandAffiliation)}</span>
      </td>
      <td>
        <OwnerCell h={h} live={live} ownerStage={ownerStage} researchingIds={researchingIds} dots={dots} />
      </td>
      <td>
        {h.ownerEmail ? (
          <a className="cell-link" href={`mailto:${h.ownerEmail}`} onClick={(e) => e.stopPropagation()}>
            {h.ownerEmail}
          </a>
        ) : (
          "—"
        )}
      </td>
      <td>
        {(h.amenities?.length ?? 0) === 0
          ? (factsAttempted(h)
              ? <NoneFound checkedAt={h.factsAttemptedAt} what="amenities" />
              : <NeedsEnrichment what="amenities" />)
          : <Amenities tags={h.amenities} />}
      </td>
      <td className="actcol" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="row-del"
          aria-label={`delete ${h.name}`}
          title="Delete this row"
          onClick={onDelete}
        >
          ✕
        </button>
      </td>
    </tr>
  );
}

// ADR-039 — star class glyphs: filled count = starRating; muted em-dash when unknown.
// ADR-082 — "ran, nothing found" cell marker: a dash invites the user to run enrichment; this
// tells them not to bother. Tooltip carries the attempt date so staleness is one hover away.
function NoneFound({ checkedAt, what }: { checkedAt?: string | null; what: string }) {
  const when = checkedAt ? ` ${new Date(checkedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : "";
  return (
    <span className="none-found" title={`Checked${when} — no ${what} found`}>
      none found
    </span>
  );
}

// ADR-089 (Proposed) — the empty-cell vocabulary's third state. A bare "—" reads as "no value"
// and hides the honest fact that the field is enrichable but not yet enriched; NoneFound covers
// "ran, nothing there". This is the middle case: enrichable + not yet attempted → a compact,
// muted "enrich" token (kept short so a mostly-empty pre-enrichment grid doesn't turn noisy).
function NeedsEnrichment({ what }: { what: string }) {
  return (
    <span className="needs-enrich" title={`Not yet enriched — run enrichment to fill ${what}`}>
      enrich
    </span>
  );
}

function Stars({ n, checkedAt }: { n?: number | null; checkedAt?: string | null }) {
  if (!n && checkedAt) return <NoneFound checkedAt={checkedAt} what="star rating" />;
  if (!n) return <NeedsEnrichment what="the class rating" />;
  return (
    <span className="stars">
      {[1, 2, 3, 4, 5].map((i) => (
        <i key={i} className={i <= n ? "on" : ""}>★</i>
      ))}
    </span>
  );
}

// ADR-050 — label a per-theme reference link by its host so users can verify the theme themselves.
function refLabel(url: string): string {
  if (/booking\./i.test(url)) return "Booking";
  if (/tripadvisor\./i.test(url)) return "Tripadvisor";
  if (/google\./i.test(url)) return "Google";
  return "Source";
}

// ADR-050 — "What guests say": top-3 liked / top-3 disliked themes, each with evidence + a link.
function GuestThemes({ themes }: { themes: ReviewThemes }) {
  const groups = [
    { polarity: "love" as const, label: "Guests love", glyph: "▲", items: themes.liked },
    { polarity: "gripe" as const, label: "Common complaints", glyph: "▼", items: themes.disliked },
  ].filter((g) => g.items.length > 0);
  if (groups.length === 0) return null;
  return (
    <div className="says">
      {groups.map((g) => (
        <div className="tgroup" key={g.polarity}>
          <div className={`tg-h ${g.polarity}`}>
            <span className="dot">{g.glyph}</span> {g.label}
          </div>
          <div className={`tlist ${g.polarity}`}>
            {g.items.map((t, i) => (
              <div className="titem" key={i}>
                <div>
                  <div className="theme">{t.theme}</div>
                  {t.detail && <div className="ev">{t.detail}</div>}
                </div>
                {t.source && (
                  <a className="ref" href={t.source} target="_blank" rel="noreferrer">
                    {refLabel(t.source)} <span className="go">↗</span>
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ADR-039 — Booking.com guest rating; single ink color (no good/bad tinting). "filling…" when absent.
function Rating({ score, count, checkedAt }: { score?: number | null; count?: number | null; checkedAt?: string | null }) {
  if (score == null && checkedAt) return <NoneFound checkedAt={checkedAt} what="guest rating" />;
  if (score == null) return <NeedsEnrichment what="the guest rating" />;
  return (
    <span className="rate">
      <span className="sc">{score.toFixed(1)}</span>
      <span className="out">/10</span>
      {count != null && <span className="ct">{count.toLocaleString()}</span>}
    </span>
  );
}

// Compact amenity chips: first two + "+N more", or an em-dash when none.
function Amenities({ tags }: { tags: string[] | null }) {
  if (!tags || tags.length === 0) return <>—</>;
  const head = tags.slice(0, 2);
  const extra = tags.length - head.length;
  return (
    <span className="amenities" title={tags.join(", ")}>
      {head.map((t) => (
        <span key={t} className="amenity-chip">{t}</span>
      ))}
      {extra > 0 ? <span className="amenity-more">+{extra}</span> : null}
    </span>
  );
}

function OwnerCell(props: { h: ClassifiedRow; live: boolean; ownerStage: OwnerStage; researchingIds: Set<string>; dots: number }) {
  const { h, live, ownerStage, researchingIds, dots } = props;
  if (!live) return <span className="own-pending">— not researched</span>;
  if (!h.ownerName) {
    // Bug-2 (ADR-064): only rows this run actually targeted show "researching…"; others fall through
    // to their true owner status. (Was: every owner-less row keyed off the global running flag.)
    if (shouldShowResearching(h, ownerStage, researchingIds)) return <span className="own-pending">researching…</span>;
    // ADR-038: distinguish "we looked, found nothing" from "not yet looked" via owner_attempted_at.
    return ownerStatus(h) === "not_found"
      ? <span className="own-none">no owner found</span>
      : <span className="own-pending">pending owner research</span>;
  }
  return (
    <div className="own-cell">
      <span className="own-name">{h.ownerName}</span>
      <span className={`conf c${dots}`}>
        <i />
        <i />
        <i />
      </span>
      <OwnerConfTag conf={h.ownerConf} />
    </div>
  );
}

// Strip protocol / www and trim a long URL for a readable, clickable source label.
const prettyUrl = (u: string) => {
  const s = u.replace(/^https?:\/\//, "").replace(/^www\./, "");
  return s.length > 64 ? s.slice(0, 63) + "…" : s;
};

// A small clipboard-copy icon button (ADR-063): copies `text`, flips to ✓ for ~1.2s. Used on
// contact email/phone so BD can grab a value without click-through. No-ops where the Clipboard API
// is unavailable (older browsers / insecure origin).
function CopyBtn({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="ic-btn"
      title={`Copy ${label ?? "to clipboard"}`}
      aria-label={`Copy ${label ?? "to clipboard"}`}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? "✓" : "⧉"}
    </button>
  );
}

// Inline click-to-edit for a single property field. Renders the value with a hover ✎; clicking
// swaps to an input; Enter/blur saves (calls onSave), Esc cancels. When `options` is given the
// editor is a <select> constrained to that taxonomy (ADR-063 Tier 2 — e.g. owner_type), and
// picking an option commits immediately. Optimistic save is owned by the parent (it updates row
// state, then reverts on a thrown error).
function EditableField(props: {
  value: string | number | null;
  onSave: (next: string) => void | Promise<void>;
  type?: "text" | "number";
  options?: readonly string[];
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(props.value ?? ""));
  if (!editing) {
    return (
      <span className="editable" onClick={() => { setDraft(String(props.value ?? "")); setEditing(true); }}>
        <span className="ev">{props.value ?? <span className="val missing">—</span>}</span>
        <span className="pencil" aria-label="Edit">✎</span>
      </span>
    );
  }
  // `raw` lets the select pass its chosen value directly (draft state updates async).
  const commit = (raw?: string) => {
    setEditing(false);
    // Clearing is not allowed (ADR-060 Q6): an emptied field reverts to its current value rather
    // than saving a blank. Only a changed, non-empty value is persisted.
    const next = (raw ?? draft).trim();
    if (next === "" || next === String(props.value ?? "")) return;
    void props.onSave(next);
  };
  if (props.options) {
    return (
      <select
        className="edit-in"
        autoFocus
        value={draft}
        onChange={(e) => commit(e.target.value)}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => { if (e.key === "Escape") setEditing(false); }}
      >
        <option value="" disabled>Select…</option>
        {props.options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  return (
    <input
      className="edit-in"
      type={props.type ?? "text"}
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setEditing(false);
      }}
    />
  );
}

// One label/value row in the grouped Property list; "none on file" when the value is absent.
function PRow({ k, v, tried }: { k: string; v: string | null; tried?: boolean }) {
  // ADR-064: when the facts phase ran but the field is empty, say "Not found" (searched, nothing)
  // rather than the neutral "none on file" (never looked).
  return (
    <div className="prow">
      <span className="pk">{k}</span>
      <span className="pv">{v ?? <span className="missing">{tried ? "Not found" : "none on file"}</span>}</span>
    </div>
  );
}

// Inline card editor (add-card form + edit-card form) — hoisted out of Dossier's render body so
// React sees a stable component identity and never remounts it mid-keystroke (Fix: stabilize
// CardEditor — previously defined as a const inside Dossier, causing remounts on every re-render).
function CardEditor(props: {
  cardDraft: Partial<OwnerContact>;
  setCardDraft: Dispatch<SetStateAction<Partial<OwnerContact>>>;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { cardDraft, setCardDraft, onSave, onCancel } = props;
  return (
    <div className="card-editor">
      {(["name", "title", "email", "phone", "linkedin"] as const).map((field) => (
        <div className="ce-row" key={field}>
          <span className="ce-label">{field}</span>
          <input
            className="ce-input"
            type="text"
            placeholder={field}
            value={(cardDraft as Record<string, string | null | undefined>)[field] ?? ""}
            onChange={(e) => setCardDraft((d) => ({ ...d, [field]: e.target.value || null }))}
          />
        </div>
      ))}
      <div className="ce-actions">
        <button className="btn sm" onClick={onSave}>Save</button>
        <button className="btn ghost sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ── dossier slide-over — full hotel detail on current data ───────────────────
// Property is organized into labelled groups (Size / Classification / Location); amenities are
// legible pills; ownership shows the operator + owner result with confidence and clickable owner
// sources ("how we found it"); entities lists the operator + owner with contact. Inline editing,
// the step-by-step research trail (dead-ends), related entities (consultant/contractor) and the
// convertibility score are backend-dependent follow-ups — not rendered here (no dead controls).
function Dossier(props: {
  h: Row;
  onClose: () => void;
  onPatch: (id: string, field: string, value: unknown) => Promise<void>;
  onSaveContacts: (id: string, overlay: UserContact[]) => Promise<void>;
  onFindContacts?: (id: string) => void; // ADR-110/114 — the owner row's "Find decision-makers" (per-hotel contacts pull)
  findingContacts?: boolean;
  onOpenReview: (id: string) => void; // ADR-065 addendum — jump into the review room on this lead
}) {
  const { h, onClose } = props;
  const age = factAge(h.updatedAt);
  const amenities = h.amenities ?? [];
  // ADR-064 tried-but-empty states per kind
  const revStatus = reviewsStatus(h);
  const factsTried = factsAttempted(h);

  return (
    <>
      <div className="dos-head">
        <div className="dos-top">
          <div>
            {h.brand && <span className="dos-eyebrow">{h.brand} · operated</span>}
            <div className="dos-name tight">
              <EditableField value={h.name}
                onSave={(v) => props.onPatch(h.id, "name", v || h.name)} />
            </div>
          </div>
          <button className="x" onClick={onClose} aria-label="close">✕</button>
        </div>
      </div>

      <div className="dos-body">
        {/* Property — grouped key/value */}
        <div className="dsec">
          <div className="dsec-h">Property <span className="ln" /></div>
          <div className="proplist">
            <div className="propgrp">
              <div className="gh">Size</div>
              <div className="prow">
                <span className="pk">Keys</span>
                <span className="pv">
                  <EditableField value={h.keys ?? null} type="number"
                    onSave={(v) => props.onPatch(h.id, "key_count", v === "" ? null : Number(v))} />
                </span>
              </div>
              <div className="prow">
                <span className="pk">Residences</span>
                <span className="pv">
                  <EditableField value={h.residences ?? null} type="number"
                    onSave={(v) => props.onPatch(h.id, "residence_count", v === "" ? null : Number(v))} />
                </span>
              </div>
            </div>
            <div className="propgrp">
              <div className="gh">Classification</div>
              <div className="prow">
                <span className="pk">Segment</span>
                <span className="pv">
                  <EditableField value={h.segment ?? null}
                    onSave={(v) => props.onPatch(h.id, "segment", v || null)} />
                </span>
              </div>
              <div className="prow">
                <span className="pk">Operator / brand</span>
                <span className="pv">
                  <EditableField value={h.brand ?? null}
                    onSave={(v) => props.onPatch(h.id, "brand", v || null)} />
                  {/* ADR-091: show the raw extractor value as provenance when it differs from the
                      verified clean brand — helps BD spot noisy source data. */}
                  {h.brandRaw && h.brandRaw !== h.brand && (
                    <span className="prov-note" title="Raw brand from the source extractor (unverified)">
                      raw: {h.brandRaw}
                    </span>
                  )}
                </span>
              </div>
              {/* ADR-084 — the brand-affiliation verdict + the URL that backs it (bug 4). The
                  source link mirrors the Source/website links below; shown only when on file. */}
              <div className="prow">
                <span className="pk">Affiliation</span>
                <span className="pv">
                  <span title={affiliationTooltip(h.brandAffiliation)}>{affiliationLabel(h.brandAffiliation)}</span>
                  {h.affiliationSource && (
                    <a
                      href={h.affiliationSource}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="Open affiliation source"
                      style={{ marginLeft: "calc(6px * var(--space))", color: "var(--accent-ink)", textDecoration: "none" }}
                    >
                      ↗
                    </a>
                  )}
                </span>
              </div>
            </div>
            <div className="propgrp">
              <div className="gh">Location &amp; freshness</div>
              <PRow k="City" v={h.city} />
              <PRow k="Country" v={h.country} />
              {/* Feedback #11 — only when the row carries coordinates (wire may send null). */}
              {h.lat != null && h.lng != null && (
                <div className="prow">
                  <span className="pk">Map</span>
                  <span className="pv">
                    <a
                      href={googleMapsUrl(h.lat, h.lng, h.name, h.city)}
                      target="_blank"
                      rel="noopener"
                      style={{ color: "var(--accent-ink)", textDecoration: "none" }}
                    >
                      Open in Google Maps ↗
                    </a>
                  </span>
                </div>
              )}
              {/* ADR-063: official website is editable; the ↗ opens it when a URL is on file. */}
              <div className="prow">
                <span className="pk">Official website</span>
                <span className="pv">
                  <EditableField value={h.officialWebsite ?? null}
                    onSave={(v) => props.onPatch(h.id, "official_website", v || null)} />
                  {h.officialWebsite && (
                    <a
                      href={h.officialWebsite}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="Open website"
                      style={{ marginLeft: "calc(6px * var(--space))", color: "var(--accent-ink)", textDecoration: "none" }}
                    >
                      ↗
                    </a>
                  )}
                </span>
              </div>
              {h.source && (
                <div className="prow">
                  <span className="pk">Source</span>
                  <a
                    className="pv"
                    href={h.source}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: "var(--accent-ink)", textDecoration: "none" }}
                  >
                    {prettyUrl(h.source)} ↗
                  </a>
                </div>
              )}
              <div className="prow">
                <span className="pk">Facts updated</span>
                <span className="pv" style={age?.stale ? { color: "var(--warn-ink)" } : undefined}>
                  {age ? `${age.label}${age.stale ? " · may be stale" : ""}` : "—"}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Amenities — ADR-064: show a muted "Not found" once the facts phase has run */}
        {(amenities.length > 0 || factsTried) && (
          <div className="dsec">
            <div className="dsec-h">Amenities <span className="ln" /></div>
            {amenities.length > 0 ? (
              <div className="am-list">
                {amenities.map((a) => (
                  <span className="am-item" key={a}>{a}</span>
                ))}
              </div>
            ) : (
              <div className="dos-later">No amenities found.</div>
            )}
          </div>
        )}

        {/* Reviews & rates (ADR-039) — always rendered; ADR-064 three-state when empty */}
        <div className="dsec">
          <div className="dsec-h">Reviews &amp; rates <span className="ln" /></div>
          {revStatus === "not_found" ? (
            <div className="dos-later">Reviews &amp; rates refreshed — none found.</div>
          ) : revStatus === "pending" ? (
            <div className="dos-later">Reviews &amp; rates not refreshed yet — run it from the live set.</div>
          ) : (
          <>
            {(h.bookingRating != null || h.starRating != null) && (
              <div className="verdict">
                {h.bookingRating != null && (
                  <span className="vscore">
                    <span className="big">{h.bookingRating.toFixed(1)}<small> /10</small></span>
                  </span>
                )}
                <span className="vmeta">
                  {h.starRating != null && <Stars n={h.starRating} />}
                  <span className="vct">
                    {[
                      h.bookingReviews != null ? `${h.bookingReviews.toLocaleString()} reviews` : null,
                      h.starRating != null ? `${h.starRating}-star` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                {h.bookingRating != null && (
                  <span className="vmeta vmeta-r">
                    <span className="src">Booking.com</span>
                  </span>
                )}
              </div>
            )}

            {h.reviewThemes ? (
              <GuestThemes themes={h.reviewThemes} />
            ) : h.reviewSummary ? (
              <div className="themes">
                <div className="qh">What guests say</div>
                <p>{h.reviewSummary}</p>
              </div>
            ) : null}

            {(h.reviewSources?.length ?? 0) > 0 && (
              <>
                <div className="trail-h">Sources used for reviews research</div>
                <div className="trail">
                  {h.reviewSources!.map((s, i) => (
                    <a className="srccard" href={s} target="_blank" rel="noreferrer" key={i}>
                      <span className="ur">{prettyUrl(s)}</span>
                      <span className="go">↗</span>
                    </a>
                  ))}
                </div>
              </>
            )}

            {(h.roomCategories?.length ?? 0) > 0 && (
              <>
                <div className="trail-h">Room categories</div>
                <div className="mini">
                  {h.roomCategories!.map((c, i) => (
                    <div className="r" key={i}>
                      <span className="nm">{c.category}</span>
                      <span className="pr">
                        {c.priceFrom ?? <span className="none">no price shown</span>}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="roomnote">
                  Per-room pricing is date-specific and rarely published — shown only when the page states one.
                </div>
              </>
            )}
            <div className="hops">via web search · refreshed at most every 30 days</div>
          </>
          )}
        </div>

        {/* Who to reach (ADR-110) — one ranked list: owner (or best lead), then the cast */}
        <WhoToReach h={h} onPatch={props.onPatch} onSaveContacts={props.onSaveContacts}
          onFindContacts={props.onFindContacts} findingContacts={props.findingContacts} />

        {/* Outreach — assets exist (ADR-065 addendum): summary + jump into the review room, which
            stays the single place assets render and edit. */}
        {h.outreach && (
          <div className="dsec">
            <div className="dsec-h">Outreach <span className="ln" /></div>
            <div className="dos-outreach">
              <div className="do-meta mono">
                Assets ready · {h.outreach.generated_at.slice(0, 10)}
                {h.outreach.edited_fields?.length ? " · ✎ edited" : ""}
              </div>
              <div className="do-subject">“{h.outreach.content.email_subject}”</div>
              <div className="do-actions">
                <button className="btn sm accent" onClick={() => props.onOpenReview(h.id)}>
                  Open in review
                </button>
                <button
                  className="btn sm"
                  onClick={() =>
                    exportOutreach([h.id], h.name)
                      .catch((e: Error) => window.alert(e.message))
                  }
                >
                  Download .eml
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ── Who to reach (ADR-110) ──────────────────────────────────────────────────
// One ranked list replacing "Ownership & owner links", "Contacts" and "Entities & people":
// row 1 is the owner (editable as before; else the best lead, amber "Possible owner"), then
// parent / asset manager / operator / people, with brand / previous owner / developer / website
// company folded under "More". Each row: bold role chip, the name, one plain hint line, and a
// "Sources (n)" disclosure. Nothing else — no evidence quotes, years, stop reason or counts.
// The Contacts block (ADR-054 merge + edit + add, unchanged in behaviour) sits under row 1 only.
const REACH_MORE_LABEL = (n: number) => `More · ${n} other ${n === 1 ? "entity" : "entities"}`;

function ReachSources({ links }: { links: string[] }) {
  if (links.length === 0) return null;
  return (
    <details className="srcs">
      <summary>Sources ({links.length})</summary>
      <div className="links">
        {links.map((u) => (
          <a href={u} target="_blank" rel="noreferrer" key={u}><span>{prettyUrl(u)}</span>↗</a>
        ))}
      </div>
    </details>
  );
}

export function WhoToReach(props: {
  h: Row;
  onPatch: (id: string, field: string, value: unknown) => Promise<void>;
  onSaveContacts: (id: string, overlay: UserContact[]) => Promise<void>;
  onFindContacts?: (id: string) => void;
  findingContacts?: boolean;
}) {
  const { h } = props;
  // contact card inline edit state
  const [editingCardId, setEditingCardId] = useState<string | null | undefined>(null);
  const [cardDraft, setCardDraft] = useState<Partial<OwnerContact>>({});
  const hasOwner = Boolean(h.ownerName);
  const ot = (h.ownerType ?? "").toLowerCase();
  // ADR-120: with no owner on file, the best lead stands in as the suggested owner — unless it is the
  // operator (Cognitidata's competitor) or a brand — and phase 3 reaches it too.
  const lead = h.ownerResearch?.bestLead ?? null;
  const suggested = !hasOwner && lead != null && lead.role !== "operator" && lead.role !== "brand";
  const reachable = hasOwner ? ot !== "chain" : suggested; // ADR-116: phase 3 (recipe + Apollo) for every non-chain owner
  const contactStatus = contactsStatus(h);
  const dots = confDots(h.ownerConf);
  // ADR-063: when a 'no owner found' row becomes eligible for automatic re-research.
  const ownerCooldown = ownerCooldownUntil(h.ownerAttemptedAt);
  const ownerCooldownStr = ownerCooldown?.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const { rows, more } = reachRows(h);

  const contactsBlock = () => {
    const cards = contactCards(h);
    const overlay: UserContact[] = h.userContacts ?? [];
    const editable = (c: OwnerContact) => c.source === "web" || c.source === "user";
    const sourceLabel = (s?: string | null) =>
      s === "apollo" ? "Apollo" : s === "web" ? "web" : s === "user" ? "added" : "";

    const startEditCard = (c: OwnerContact) => {
      setEditingCardId(c.id);
      setCardDraft({ name: c.name, title: c.title, email: c.email, phone: c.phone, linkedin: c.linkedin });
    };
    const saveEditCard = async (c: OwnerContact) => {
      const updated: UserContact = { ...c, ...cardDraft, source: "user" };
      setEditingCardId(null);
      setCardDraft({});
      await props.onSaveContacts(h.id, applyContactOp(overlay, { type: "edit", card: updated }));
    };
    const addCard = async () => {
      const card: UserContact = {
        id: `user-${crypto.randomUUID()}`,
        source: "user",
        name: cardDraft.name ?? null,
        title: cardDraft.title ?? null,
        email: cardDraft.email ?? null,
        emailStatus: null,
        linkedin: cardDraft.linkedin ?? null,
        phone: cardDraft.phone ?? null,
        confidence: null,
        sources: null,
      };
      setEditingCardId(null);
      setCardDraft({});
      await props.onSaveContacts(h.id, applyContactOp(overlay, { type: "add", card }));
    };

    return (
      <div className="reach-contacts">
        <div className="ch">Contacts{cards.length > 0 && <span className="cnt">· {cards.length}</span>}</div>
        {cards.length === 0 && editingCardId !== "new" && (
          <div className="nocontacts">
            {/* ADR-064: distinguish "search ran, nobody found" (not_found) from "never run"
                (pending). A pending non-chain owner offers the per-hotel phase-3 run — the
                contact recipe then Apollo on the people of interest (ADR-116); a chain owner
                is the competitor and gets no contact search. */}
            {contactStatus === "not_found" ? (
              "No contacts found — search ran but turned up nobody."
            ) : reachable ? (
              <>
                <span>No contacts yet.</span>
                {props.onFindContacts ? (
                  <button className="cta primary" disabled={props.findingContacts}
                    onClick={() => props.onFindContacts!(h.id)}>
                    {props.findingContacts ? "Finding…" : "Find decision-makers"}
                  </button>
                ) : (
                  <span> Run owner & contact research from the live set.</span>
                )}
              </>
            ) : (
              "No direct contact details found."
            )}
          </div>
        )}
        {cards.length > 0 && (
          <div className="dm-list">
            {cards.map((c, i) => (
              <div className="dm-card" key={c.id ?? i}>
                <div className="dm-cardhead">
                  {c.source && <span className={`srcchip src-${c.source}`}>{sourceLabel(c.source)}</span>}
                  {c.email && c.emailStatus === "verified" && (
                    <span className="dm-badge verified" title="Verified email">✓ verified</span>
                  )}
                  {editable(c) && editingCardId !== c.id && (
                    <span className="card-actions">
                      <button className="ic-btn" title="Edit" onClick={() => startEditCard(c)}>✎</button>
                      <button className="ic-btn del" title="Delete"
                        onClick={() => props.onSaveContacts(h.id, applyContactOp(overlay, { type: "delete", id: c.id }))}>✕</button>
                    </span>
                  )}
                </div>
                {editingCardId === c.id ? (
                  <CardEditor cardDraft={cardDraft} setCardDraft={setCardDraft} onSave={() => saveEditCard(c)} onCancel={() => { setEditingCardId(null); setCardDraft({}); }} />
                ) : (
                  <>
                    {c.name && <div className="dm-name">{c.name}</div>}
                    {c.title && <div className="dm-title">{c.title}</div>}
                    {c.location && (
                      <div className={`dm-loc${c.locality ? ` loc-${c.locality}` : ""}`}>
                        {c.location}{c.locality === "city" ? " · same city" : c.locality === "country" ? " · same country" : ""}
                      </div>
                    )}
                    <div className="dm-contacts">
                      <div className="dmc">
                        <span className="ic">✉</span>
                        {c.email ? (
                          <><a href={`mailto:${c.email}`}>{c.email}</a><CopyBtn text={c.email} label="email" /></>
                        ) : (
                          <span className="val missing">no email found</span>
                        )}
                        {c.email && c.confidence && (
                          <span className="cmeta">
                            <span className={`conf c${confDots(c.confidence)}`}><i /><i /><i /></span>
                            {c.sources && c.sources[0] && (
                              <a className="srclink" href={c.sources[0]} target="_blank" rel="noreferrer">source ↗</a>
                            )}
                          </span>
                        )}
                      </div>
                      <div className="dmc">
                        <span className="ic">☎</span>
                        {c.phone ? (
                          <><a href={`tel:${c.phone}`}>{c.phone}</a><CopyBtn text={c.phone} label="phone" /></>
                        ) : (
                          <span className="val missing">no phone found</span>
                        )}
                      </div>
                    </div>
                    {c.linkedin && (
                      <div className="dm-foot">
                        <a className="dm-link" href={c.linkedin} target="_blank" rel="noreferrer">LinkedIn ↗</a>
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
        )}
        {editingCardId === "new" ? (
          <CardEditor cardDraft={cardDraft} setCardDraft={setCardDraft} onSave={addCard} onCancel={() => { setEditingCardId(null); setCardDraft({}); }} />
        ) : (
          <button className="add-contact-btn" onClick={() => { setCardDraft({}); setEditingCardId("new"); }}>
            + Add contact
          </button>
        )}
        {h.ownerReachVia && (
          <div className="reach-note"><b>Reach via:</b> {h.ownerReachVia}</div>
        )}
      </div>
    );
  };

  // One row. `i` is the rank (null inside More). Row 1 is bigger; a lead row is amber; a
  // person row has no anchor of any kind (name + role text only — ADR-110 personal-data rule).
  const renderRow = (r: ReachRow, i: number | null) => {
    const top = i === 0;
    const chip = r.kind === "owner" ? "owner" : r.kind === "lead" ? "lead" : "";
    return (
      <div className={`reach-row${top ? " top" : ""}${r.kind === "lead" ? " lead" : ""}`} key={`${r.kind}-${r.role}-${r.entity}`}>
        <div className="n">{i == null ? "" : i + 1}</div>
        <div className="m">
          <span className={`role-chip${chip ? ` ${chip}` : ""}`}>{r.kind === "lead" ? "Possible owner" : LABEL[r.role]}</span>
          {r.kind === "owner" ? (
            <>
              <div className="big">
                <EditableField value={h.ownerName}
                  onSave={(v) => props.onPatch(h.id, "owner_name", v || null)} />
              </div>
              <div className="sub">
                <EditableField value={h.ownerType ?? null} options={OWNER_TYPES}
                  onSave={(v) => props.onPatch(h.id, "owner_type", v || null)} />
                {dots > 0 && <span className={`conf c${dots}`}><i /><i /><i /></span>}
                <OwnerConfTag conf={h.ownerConf} />
              </div>
              <div className="hint">{HINT.owner}{h.ownerConf === "medium" && <> · <b>not yet confirmed</b></>}</div>
            </>
          ) : (
            <>
              <div className={`big${i == null ? " sm" : ""}`}>{r.entity}</div>
              <div className="hint">{r.kind === "lead" ? <><b>{LABEL[r.role]}</b> · {HINT[r.role]}</> : r.hint}</div>
            </>
          )}
          {r.role !== "person" && <ReachSources links={r.sources} />}
          {((r.kind === "owner" && hasOwner) || (r.kind === "lead" && suggested)) && contactsBlock()}
        </div>
      </div>
    );
  };

  return (
    <div className="dsec">
      <div className="dsec-h">Who to reach <span className="ln" /></div>
      {rows.length === 0 ? (
        ownerStatus(h) === "not_found" ? (
          <div className="dos-later">No owner found — research ran but didn't identify an owner. {ownerCooldownStr ? `Automatic re-research available ${ownerCooldownStr}` : "It'll be offered for re-research after a cooldown"}, or select it in the live set to re-run now.</div>
        ) : (
          <div className="dos-later">Owner not researched yet — run owner research from the live set.</div>
        )
      ) : (
        <div className="reach">
          {/* No owner and no lead but a cast/brand: the status line stands in for row 1 */}
          {rows[0].kind === "cast" && (
            <div className="dos-later" style={{ marginBottom: "calc(10px * var(--space))" }}>
              {ownerStatus(h) === "not_found"
                ? <>No owner found — research ran but didn't identify an owner. {ownerCooldownStr ? `Automatic re-research available ${ownerCooldownStr}` : "It'll be offered for re-research after a cooldown"}, or select it in the live set to re-run now.</>
                : "Owner not researched yet — run owner research from the live set."}
            </div>
          )}
          {rows.map((r, i) => renderRow(r, i))}
          {more.length > 0 && (
            <details className="reach-more">
              <summary>{REACH_MORE_LABEL(more.length)}</summary>
              {more.map((r) => renderRow(r, null))}
            </details>
          )}
        </div>
      )}
    </div>
  );
}
