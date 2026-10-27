// Chat-thread + inline-artifact model (Option C, ADR-008).
// A thread is a flat list of turns. An assistant turn may carry one inline ARTIFACT
// that renders as a self-contained card in the stream. Artifacts are EXTENSIBLE:
// `hotel-results` is the first kind; add more (lookup-answer, enrich-summary,
// teaser-preview) as a new member of the `Artifact` union with its own renderer.

// The canonical owner-type taxonomy (ADR-044) — kept in lockstep with backend enrich._OwnerType
// (family | individual | institutional | government | chain). A runtime array so the dossier edit
// select and the live-set owner-type filter share ONE source of truth (ADR-063 Tier 2).
export const OWNER_TYPES = ["family", "individual", "institutional", "government", "chain"] as const;
export type OwnerType = (typeof OWNER_TYPES)[number];

// Apollo corporate-contact enrichment (ADR-047): one decision-maker at an institutional/government owner.
export type OwnerContact = {
  name: string;
  title: string | null;
  email: string | null;
  emailStatus: string | null;
  linkedin: string | null;
  phone: string | null;
};

// Mirrors the /api/search wire shape: city/country may be null/absent, keys may be
// null, and ownerType is a free string (the backend emits arbitrary owner-type
// labels, not just the OwnerType union below).
export type Confidence = "high" | "medium" | "low";

// Per-field provenance recorded by on-selection enrichment (ADR-015): confidence +
// source URLs. Keyed by enriched field; `owner` covers the ownerName/ownerType pair.
export type FieldProv = { confidence: Confidence; sources: string[] };
export type ProvKey = "keys" | "residences" | "brand" | "operator" | "amenities" | "owner";

// ADR-110 — what the owner hunt found on the way: a ranked cast of related entities + the best
// lead when it abstained. camelCase mirror of the stored `metadata.owner_research` blob (see
// reach.ts `ownerResearchFromStored`); null when the recipe hunt never ran on the row.
export type CastRole =
  | "owner" | "previous_owner" | "operator" | "brand" | "asset_manager" | "developer"
  | "site_company" | "controlling_party" | "person";
export type CastEntry = {
  entity: string;
  role: CastRole;
  evidence: string | null;
  source: string;
  asOf: string | null;
};
export type BestLead = { entity: string; role: CastRole; whyNot: string };
export type OwnerResearch = {
  researchedAt: string | null;
  brief: string | null;
  stopped: "confirmed" | "converged" | "capped" | null;
  asOf: string | null;
  confidence: Confidence | null;
  evidence: string | null;
  sources: string[];
  cast: CastEntry[];
  bestLead: BestLead | null;
};

export type Hotel = {
  id: string;
  name: string;
  city?: string | null;
  country?: string | null;
  keys?: number | null;
  residences?: number | null;
  brand?: string | null; // ADR-091 — verified brand_clean (displayed)
  brandRaw?: string | null; // ADR-091 — raw noisy metadata.brand (provenance only)
  operator?: string | null;
  amenityTags?: string[];
  ownerName?: string | null;
  ownerType?: string | null;
  ownerEmail?: string | null;
  ownerPhone?: string | null;
  ownerLinkedin?: string | null;
  ownerReachVia?: string | null;
  ownerContacts?: OwnerContact[] | null;
  ownerResearch?: OwnerResearch | null; // ADR-110
  // Provenance for fields filled by enrichment (absent ⇒ from discovery / unenriched).
  prov?: Partial<Record<ProvKey, FieldProv>>;
};

export type HotelResultsArtifact = {
  kind: "hotel-results";
  title: string;
  hotels: Hotel[];
  ownerFillRate: number; // 0..1 — share of rows with an owner recorded
};

// LOOKUP · aggregate (ADR-019): a stat answer to a count/aggregate question. `stats` is the
// single result row (column → value); `answer` is the natural-language summary.
export type LookupAnswerArtifact = {
  kind: "lookup-answer";
  answer: string;
  stats: Record<string, string | number | null>;
  sql: string;
};

// LOOKUP · entity (ADR-019): one hotel's full detail (a read view).
export type HotelDetail = {
  id: string | null;
  name: string;
  city: string | null;
  country: string | null;
  keys: number | null;
  residences: number | null;
  brand: string | null; // ADR-091 — verified brand_clean (displayed)
  brandRaw?: string | null; // ADR-091 — raw noisy metadata.brand (provenance only)
  segment: string | null;
  operator: string | null;
  ownerName: string | null;
  ownerType: string | null;
  ownerEmail: string | null;
  ownerPhone: string | null;
  ownerLinkedin: string | null;
  ownerReachVia: string | null;
  ownerContacts?: OwnerContact[] | null;
  ownerResearch?: OwnerResearch | null; // ADR-110
  status: string | null;
  amenities: string[];
};

export type HotelDetailArtifact = { kind: "hotel-detail"; hotel: HotelDetail };

// Discriminated union — extend here for new inline artifact kinds.
export type Artifact = HotelResultsArtifact | LookupAnswerArtifact | HotelDetailArtifact;

export type Turn =
  | { id: string; role: "user"; text: string }
  | {
      id: string;
      role: "assistant";
      text: string;
      tag?: "SEARCH" | "LOOKUP" | "ENRICH";
      status?: "running" | "done";
      artifact?: Artifact;
    };
