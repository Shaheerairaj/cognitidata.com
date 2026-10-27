// ADR-110 — "Who to reach": the ranked list of leads the dossier shows, built from the owner
// columns (row 1, source of truth) plus `ownerResearch` (the cast + best lead the owner hunt
// found on the way). Pure; the section component in Workbench.tsx renders what this returns.
import type { BestLead, CastEntry, CastRole, Confidence, OwnerResearch } from "./types";

export const LABEL: Record<CastRole, string> = {
  owner: "Owner", controlling_party: "Parent", asset_manager: "Asset manager", operator: "Operator",
  brand: "Brand", previous_owner: "Previous owner", developer: "Developer",
  site_company: "Website company", person: "Contact",
};
export const HINT: Record<CastRole, string> = {
  owner: "Owns the property", controlling_party: "Controls the owner",
  asset_manager: "Holds or manages the asset", operator: "Runs the hotel", brand: "The flag it flies",
  previous_owner: "Owned it before", developer: "Built it",
  site_company: "Named on the website's legal notice", person: "Works there",
};

const ROLES = new Set<string>(Object.keys(LABEL));
const STOPS = new Set(["confirmed", "converged", "capped"]);
const CONFS = new Set(["high", "medium", "low"]);
const STAGE = ["controlling_party", "asset_manager", "operator", "person"] as const;
const MORE = ["brand", "previous_owner", "developer", "site_company"] as const;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const role = (v: unknown): CastRole | null => (typeof v === "string" && ROLES.has(v) ? (v as CastRole) : null);
const norm = (s: string) => s.trim().toLowerCase();

// The STORED snake_case blob (`metadata.owner_research`, as the live SSE frame carries it) →
// the camelCase wire type. Missing keys become null/[]; anything that is not an object with a
// list-shaped `cast` is garbage → null.
export function ownerResearchFromStored(v: unknown): OwnerResearch | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.cast !== undefined && !Array.isArray(o.cast)) return null;
  const cast: CastEntry[] = [];
  for (const raw of (o.cast as unknown[] | undefined) ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    const r = role(c.role);
    const entity = str(c.entity);
    if (!r || !entity) continue;
    cast.push({ entity, role: r, evidence: str(c.evidence), source: str(c.source) ?? "", asOf: str(c.as_of) });
  }
  let bestLead: BestLead | null = null;
  if (o.best_lead && typeof o.best_lead === "object") {
    const b = o.best_lead as Record<string, unknown>;
    const r = role(b.role);
    const entity = str(b.entity);
    if (r && entity) bestLead = { entity, role: r, whyNot: str(b.why_not) ?? "" };
  }
  const stopped = str(o.stopped);
  const confidence = str(o.confidence);
  return {
    researchedAt: str(o.researched_at),
    brief: str(o.brief),
    stopped: stopped && STOPS.has(stopped) ? (stopped as OwnerResearch["stopped"]) : null,
    asOf: str(o.as_of),
    confidence: confidence && CONFS.has(confidence) ? (confidence as Confidence) : null,
    evidence: str(o.evidence),
    sources: strList(o.sources),
    cast,
    bestLead,
  };
}

export type ReachRow = {
  kind: "owner" | "lead" | "cast";
  role: CastRole;
  entity: string;
  sources: string[]; // deduped, in order; always [] for a person
  hint: string; // the plain one-liner (a person's evidence text, else HINT[role]); the component adds bold parts
};

export type ReachInput = {
  ownerName: string | null;
  ownerType?: string | null;
  ownerConf?: Confidence | null;
  ownerSources?: string[] | null;
  brand?: string | null;
  ownerResearch?: OwnerResearch | null;
};

const uniq = (xs: (string | null | undefined)[]): string[] => Array.from(new Set(xs.filter((x): x is string => Boolean(x))));

// Row 1 = the owner (else the best lead); an owner AND a lead puts the lead second; then the
// cast in stage order, then the rest under More. Every entity is shown once (case-insensitive).
// With no research (or an empty cast) the brand stands in as the Operator row — today's content.
export function reachRows(h: ReachInput): { rows: ReachRow[]; more: ReachRow[] } {
  const cast = h.ownerResearch?.cast ?? [];
  const lead = h.ownerResearch?.bestLead ?? null;
  const by = (r: CastRole) => cast.filter((c) => c.role === r);
  const shown = new Set<string>();
  const seen = (e: string) => shown.has(norm(e));
  const rows: ReachRow[] = [];
  const push = (list: ReachRow[], row: ReachRow) => { shown.add(norm(row.entity)); list.push(row); };

  if (h.ownerName) {
    push(rows, {
      kind: "owner", role: "owner", entity: h.ownerName, hint: HINT.owner,
      sources: uniq([...(h.ownerSources ?? []), ...by("owner").filter((c) => norm(c.entity) === norm(h.ownerName!)).map((c) => c.source)]),
    });
  }
  if (lead && !seen(lead.entity)) {
    push(rows, {
      kind: "lead", role: lead.role, entity: lead.entity, hint: HINT[lead.role],
      sources: uniq(cast.filter((c) => norm(c.entity) === norm(lead.entity)).map((c) => c.source)),
    });
  }
  const castRow = (c: CastEntry): ReachRow => ({
    kind: "cast", role: c.role, entity: c.entity,
    sources: c.role === "person" ? [] : uniq([c.source]),
    hint: c.role === "person" ? (c.evidence || HINT.person) : HINT[c.role],
  });
  for (const r of STAGE) for (const c of by(r)) if (!seen(c.entity)) push(rows, castRow(c));
  const more: ReachRow[] = [];
  for (const r of MORE) for (const c of by(r)) if (!seen(c.entity)) push(more, castRow(c));

  if (cast.length === 0 && h.brand && !seen(h.brand)) {
    push(rows, { kind: "cast", role: "operator", entity: h.brand, sources: [], hint: HINT.operator });
  }
  return { rows, more };
}
