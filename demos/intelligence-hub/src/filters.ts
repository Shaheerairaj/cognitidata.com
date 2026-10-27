// Client-owned three-state filtering (ADR-030, ports backend `planner.apply_filters` / ADR-025).
//
// Filtering moved off the server: the live set is filtered here so UI controls re-filter
// instantly with no round-trip. A filter on an unmeasured (NULL) attribute leaves the row a
// surfaced *candidate* ("unknown"), greying only confirmed misses — auto-enrich (ADR-027) then
// fills NULLs and rows reclassify live. `fail` dominates → `unknown` → `pass`.

export type FilterOp = ">=" | "<=" | "=" | "ilike" | "in";
// `company` is a filter-only convenience (not a row field): it matches a company name against the
// operator brand OR the owner, so "Aldar" surfaces hotels Aldar OWNS even when they fly another
// brand. `name` (ADR-086) is a CLIENT-ONLY UI filter over the hotel name — the chat planner never
// emits it, and Workbench strips it from the chat live-set payload (the backend FilterAttr Literal
// doesn't include it). Everything else is kept in lockstep with planner.py FilterAttr.
export type FilterAttr = "keys" | "residences" | "segment" | "brand" | "ownerName" | "ownerType" | "brandAffiliation" | "company" | "name";
export type Filter = { attr: FilterAttr; op: FilterOp; value: number | string | string[]; label: string };
export type FilterState = "pass" | "fail" | "unknown";

// The fields the evaluator reads off a row (a Row in Workbench is a superset). `name` is optional
// so test fixtures needn't set it; real rows always carry it.
export type FilterableRow = {
  keys: number | null;
  residences: number | null;
  segment: string | null;
  brand: string | null;
  ownerName: string | null;
  ownerType: string | null;
  brandAffiliation?: string | null; // ADR-084 — optional so fixtures needn't set it
  name?: string | null;
};

// One row against one filter. NULL is `unknown` (not yet measured — ADR-025), never a miss.
export function evalOne(row: FilterableRow, f: Filter): FilterState {
  // `company` (filter-only, no row field): match the name against BOTH owner and brand. Pass on
  // any match; if nothing known matches but a candidate field is still NULL it may yet match →
  // unknown (ADR-025 candidate); fail only when every candidate field is known and misses.
  if (f.attr === "company") {
    const needle = String(f.value).toLowerCase();
    const fields = [row.ownerName, row.brand];
    if (fields.some((x) => x != null && x.toLowerCase().includes(needle))) return "pass";
    return fields.some((x) => x == null) ? "unknown" : "fail";
  }
  const v = row[f.attr];
  if (v == null) return "unknown";
  if (f.op === ">=") return (v as number) >= (f.value as number) ? "pass" : "fail";
  if (f.op === "<=") return (v as number) <= (f.value as number) ? "pass" : "fail";
  if (f.op === "=") return v === f.value ? "pass" : "fail";
  if (f.op === "in") {
    const hay = String(v).toLowerCase();
    const opts = (f.value as string[]).map((x) => String(x).toLowerCase());
    return opts.length === 0 || opts.some((x) => hay.includes(x)) ? "pass" : "fail";
  }
  // ilike — substring match (case-insensitive)
  return String(v).toLowerCase().includes(String(f.value).toLowerCase()) ? "pass" : "fail";
}

// A row against the whole filter set: `fail` dominates (any known miss greys it, even if another
// attr is unknown); else any NULL on a filtered attr → `unknown`; else `pass`. `reason` carries
// the failed filter's label and is set ONLY on `fail`.
export function classify(row: FilterableRow, filters: Filter[]): { state: FilterState; reason: string | null } {
  let sawUnknown = false;
  for (const f of filters) {
    const s = evalOne(row, f);
    if (s === "fail") return { state: "fail", reason: f.label };
    if (s === "unknown") sawUnknown = true;
  }
  return sawUnknown ? { state: "unknown", reason: null } : { state: "pass", reason: null };
}

// Matched-first ordering: confirmed matches rank above unmeasured candidates, which rank above
// confirmed misses. The live list sorts on this BEFORE the column sort, so a chat filter puts the
// rows that meet the criteria (per the data at hand) on top instead of scattering them among
// unknowns. With no filters every row classifies `pass`, so the rank is a no-op.
export function matchRank(state: FilterState): number {
  return state === "pass" ? 0 : state === "unknown" ? 1 : 2;
}

// The ids of rows that CONFIRMED-match the filter set (state === "pass") — used to auto-select the
// matches when a chat filter applies, so it's visually clear which rows the criteria picked out.
// Only `pass` (never the unmeasured `unknown` candidates); no filters → no criteria → empty set.
export function passingIds<T extends FilterableRow & { id: string }>(rows: T[], filters: Filter[]): Set<string> {
  if (filters.length === 0) return new Set();
  return new Set(rows.filter((r) => classify(r, filters).state === "pass").map((r) => r.id));
}

// ── enrichment-gap divider (spec 2026-07-07) ──────────────────────────────────────────────────
// The divider is NOT a message — it's derived state of the filtered view, rendered as a table row
// at the pass/unknown boundary ("{pass} match · {unknown} not yet enriched for this filter"). It
// dissolves on its own as `enriched` frames reclassify rows (ADR-030) and is dismissable per
// filter set: ✕ stores the signature of the ACTIVE filters, so changing them re-shows the gap.
export type GapCounts = { pass: number; unknown: number; fail: number };

export function gapCounts(states: FilterState[]): GapCounts {
  const c: GapCounts = { pass: 0, unknown: 0, fail: 0 };
  for (const s of states) c[s]++;
  return c;
}

// Stable, order-insensitive identity of the active predicates. Labels are display-only (the same
// predicate can arrive worded differently from chat vs the rail) and are excluded.
export function filterSignature(filters: Filter[]): string {
  return filters
    .map((f) => `${f.attr}|${f.op}|${JSON.stringify(f.value)}`)
    .sort()
    .join("&");
}

export function showGapDivider(filters: Filter[], counts: GapCounts, dismissedSig: string | null): boolean {
  return filters.length > 0 && counts.unknown > 0 && filterSignature(filters) !== dismissedSig;
}

// ── owner-research time model (ADR-030; the cost model left the UI per ADR-065) ──────────────
export const SECONDS_PER_HOTEL = 10; // wall-clock guess under bounded concurrency

export const estMinutes = (n: number): number => (n ? Math.max(1, Math.round((n * SECONDS_PER_HOTEL) / 60)) : 0);

// The rows an owner run would actually research — those with no owner on file yet.
export function ownerUnresolved<T extends { ownerName: string | null; ownerType: string | null }>(rows: T[]): T[] {
  return rows.filter((r) => !r.ownerName || !r.ownerType);
}

// ── owner-research status (ADR-038) ──────────────────────────────────────────────────────────
// Three states for the Owner column, derived (never stored): an owner on file → "resolved"; else a
// prior owner-research attempt (owner_attempted_at) → "not_found" ('No owner found'); else "pending".
export type OwnerStatus = "resolved" | "not_found" | "pending";
export function ownerStatus(r: { ownerName: string | null; ownerAttemptedAt?: string | null }): OwnerStatus {
  if (r.ownerName) return "resolved";
  return r.ownerAttemptedAt ? "not_found" : "pending";
}

// ── generalised tried-but-empty status per kind (ADR-064) ──────────────────────────────────────
// Same three states as ownerStatus, one per enrichment kind: data present → "resolved"; else a
// prior attempt stamp → "not_found" ('searched, none found'); else "pending" (never looked). The
// dossier reads these to distinguish "we tried and found nothing" from "not researched yet".
export type EnrichStatus = "resolved" | "not_found" | "pending";

// Reviews resolved when ANY review datum is on file (ADR-039 fields).
export function reviewsStatus(r: {
  bookingRating?: number | null;
  starRating?: number | null;
  reviewThemes?: unknown | null;
  reviewSummary?: string | null;
  roomCategories?: { category: string; priceFrom: string | null }[] | null;
  reviewsAttemptedAt?: string | null;
}): EnrichStatus {
  const has =
    r.bookingRating != null ||
    r.starRating != null ||
    !!r.reviewThemes ||
    !!r.reviewSummary ||
    (r.roomCategories?.length ?? 0) > 0;
  if (has) return "resolved";
  return r.reviewsAttemptedAt ? "not_found" : "pending";
}

// Contacts resolved when an ENRICHMENT-sourced contact exists — the stored contacts list OR any
// scalar owner channel. `userContacts` are user-added, NOT enrichment, so they never count.
export function contactsStatus(r: {
  ownerContacts?: OwnerContact[] | null;
  userContacts?: UserContact[] | null; // accepted but ignored — user-added, not enrichment-sourced
  ownerEmail?: string | null;
  ownerPhone?: string | null;
  ownerLinkedin?: string | null;
  ownerReachVia?: string | null;
  contactsAttemptedAt?: string | null;
}): EnrichStatus {
  const has =
    (r.ownerContacts?.length ?? 0) > 0 ||
    !!r.ownerEmail || !!r.ownerPhone || !!r.ownerLinkedin || !!r.ownerReachVia;
  if (has) return "resolved";
  return r.contactsAttemptedAt ? "not_found" : "pending";
}

// Facts don't map to a single value, so a plain "was it attempted" boolean is cleaner than a
// three-state: true → the facts phase ran, so an empty field means "not found" (not "not looked").
export function factsAttempted(r: { factsAttemptedAt?: string | null }): boolean {
  return !!r.factsAttemptedAt;
}

// ── header "to enrich" chips (ADR-102) ─────────────────────────────────────────────────────────
// A row is a to-do for a kind ONLY while that enrichment never ran ("pending") — a prior attempt
// that found nothing is "not_found" and deliberately excluded: "we tried, none found" ≠ "to enrich".
export function enrichPending(
  kind: EnrichKind,
  r: Parameters<typeof ownerStatus>[0] &
    Parameters<typeof contactsStatus>[0] &
    Parameters<typeof reviewsStatus>[0],
): boolean {
  const s = kind === "owner" ? ownerStatus(r) : kind === "contacts" ? contactsStatus(r) : reviewsStatus(r);
  return s === "pending";
}

// ── row-level "no hotel data" badge (ADR-082) ──────────────────────────────────────────────────
// The facts phase ran and EVERY facts field came back empty — the Overture hotel-family noise
// class (bars, residential communities, junk records). One badge says it once instead of five
// grey cells saying it five times; it's the row-level "this probably isn't a hotel" signal.
export function noHotelData(r: {
  factsAttemptedAt?: string | null;
  keys: number | null;
  residences: number | null;
  brand: string | null;
  amenities: string[] | null;
}): boolean {
  return (
    !!r.factsAttemptedAt &&
    r.keys == null && r.residences == null && !r.brand && (r.amenities?.length ?? 0) === 0
  );
}

// How long before a 'No owner found' row is offered for re-research (owner research is the PAID
// step, so we don't re-hunt it every search — ADR-038, sibling of ENRICH_TTL).
export const OWNER_TTL_DAYS = 30;

export const DETAIL_TTL_DAYS = 90; // facts older than this are flagged stale (ADR-023 detail freshness)

// Relative age of a hotel's facts from its `updatedAt`; null when unknown / freshly swept. `stale`
// once older than DETAIL_TTL_DAYS — drives BOTH the dossier "may be stale" note and the live-set
// row marker (ADR-023). `now` is injectable for tests.
export function factAge(
  updatedAt: string | null | undefined, now: Date = new Date(),
): { label: string; stale: boolean } | null {
  if (!updatedAt) return null;
  const then = new Date(updatedAt).getTime();
  if (Number.isNaN(then)) return null;
  const days = Math.floor((now.getTime() - then) / 86_400_000);
  const label = days < 1 ? "today" : days < 60 ? `${days}d ago` : `${Math.round(days / 30)}mo ago`;
  return { label, stale: days > DETAIL_TTL_DAYS };
}

// The date a 'No owner found' row becomes eligible for automatic re-research (attemptedAt +
// OWNER_TTL_DAYS). Null when never attempted (already eligible) or the stamp is unparseable — the
// dossier then falls back to the generic "after a cooldown" copy. (ADR-063 polish.)
export function ownerCooldownUntil(
  attemptedAt: string | null | undefined, ttlDays: number = OWNER_TTL_DAYS,
): Date | null {
  if (!attemptedAt) return null;
  const t = new Date(attemptedAt).getTime();
  if (Number.isNaN(t)) return null;
  return new Date(t + ttlDays * 86_400_000);
}

// The rows an owner-research run on the FILTERED set would actually (re)hunt: unresolved AND either
// never attempted or attempted longer than OWNER_TTL_DAYS ago. Explicit selection bypasses this
// (the caller passes the checked rows straight to ownerUnresolved to force a re-hunt).
export function ownerToResearch<
  T extends { ownerName: string | null; ownerType: string | null; ownerAttemptedAt?: string | null },
>(rows: T[], today: Date = new Date(), ttlDays: number = OWNER_TTL_DAYS): T[] {
  const cutoff = today.getTime() - ttlDays * 86_400_000;
  return ownerUnresolved(rows).filter((r) => {
    if (!r.ownerAttemptedAt) return true; // never researched → eligible
    const t = new Date(r.ownerAttemptedAt).getTime();
    return Number.isNaN(t) || t <= cutoff; // re-eligible only once past the TTL window
  });
}

// ── reviews & rates refresh (ADR-049) ─────────────────────────────────────────────────────────
// Reviews left the automatic enrich pass and became a gated bulk action with its own 30-day TTL.
// The run uses Anthropic web_search (~4 turns/hotel), so re-spend is throttled to once/month/row.
export const REVIEWS_TTL_DAYS = 30;

// The selected rows a reviews refresh would actually re-run: never attempted, or attempted longer
// than REVIEWS_TTL_DAYS ago. An all-fresh selection returns [] → the UI shows "all fresh".
export function reviewsToRefresh<T extends { reviewsAttemptedAt?: string | null }>(
  rows: T[],
  today: Date = new Date(),
  ttlDays: number = REVIEWS_TTL_DAYS,
): T[] {
  const cutoff = today.getTime() - ttlDays * 86_400_000;
  return rows.filter((r) => {
    if (!r.reviewsAttemptedAt) return true; // never refreshed → eligible
    const t = new Date(r.reviewsAttemptedAt).getTime();
    return Number.isNaN(t) || t <= cutoff;
  });
}

// ── unified enrichment job (ADR-050) ──────────────────────────────────────────────────────────
// Per-kind eligible counts for the Enrich popover (cost labels removed per ADR-065). owner mirrors
// Workbench's target rule: explicit selection re-hunts all unresolved; the filtered set skips
// owners researched within TTL.
export type EnrichKind = "owner" | "contacts" | "reviews";
export type KindSummary = { eligible: number };
export const CORPORATE_OWNER_TYPES = new Set(["institutional", "government"]);

export function enrichJobSummary<
  T extends {
    ownerName: string | null;
    ownerType: string | null;
    ownerAttemptedAt?: string | null;
    reviewsAttemptedAt?: string | null;
  },
>(
  targets: T[],
  explicitSelection: boolean,
  today: Date = new Date(),
): { owner: KindSummary; contacts: KindSummary; reviews: KindSummary } {
  const ownerRows = explicitSelection ? ownerUnresolved(targets) : ownerToResearch(targets, today);
  const corp = targets.filter(
    (r) => r.ownerName && CORPORATE_OWNER_TYPES.has((r.ownerType ?? "").toLowerCase()),
  );
  const reviewRows = reviewsToRefresh(targets, today);
  return {
    owner: { eligible: ownerRows.length },
    contacts: { eligible: corp.length },
    reviews: { eligible: reviewRows.length },
  };
}

// ── in-session tried-but-empty stamping (ADR-064) ──────────────────────────────────────────────
// The `done` SSE frame's `attempted` map: per kind, the hotel_ids whose phase RAN TO COMPLETION
// this run (empty list = kind didn't run; a hotel lost to a cap/exception is NOT listed).
export type AttemptedMap = { owner: string[]; facts: string[]; contacts: string[]; reviews: string[] };

type StampableRow = {
  id: string;
  ownerName: string | null;
  ownerEmail?: string | null;
  ownerPhone?: string | null;
  ownerLinkedin?: string | null;
  ownerReachVia?: string | null;
  ownerContacts?: OwnerContact[] | null;
  bookingRating?: number | null;
  starRating?: number | null;
  reviewThemes?: unknown | null;
  reviewSummary?: string | null;
  roomCategories?: { category: string; priceFrom: string | null }[] | null;
  ownerAttemptedAt?: string | null;
  factsAttemptedAt?: string | null;
  reviewsAttemptedAt?: string | null;
  contactsAttemptedAt?: string | null;
};

// On `done`: for each attempted id whose kind data is STILL empty, stamp the matching *AttemptedAt
// = today locally (mirrors what the backend persisted) so the "tried — none found" copy shows in
// session. Kinds whose data already arrived are left alone (they resolved, not "none found").
// facts is a plain attempted flag — stamped whenever the facts phase completed on the row.
// NEVER call this from the `error` branch (nothing was completed).
export function applyAttempted<T extends StampableRow>(rows: T[], attempted: AttemptedMap, today: string): T[] {
  const owner = new Set(attempted.owner);
  const facts = new Set(attempted.facts);
  const contacts = new Set(attempted.contacts);
  const reviews = new Set(attempted.reviews);
  if (owner.size + facts.size + contacts.size + reviews.size === 0) return rows;
  return rows.map((r) => {
    let next = r;
    if (owner.has(r.id) && ownerStatus(r) !== "resolved") next = { ...next, ownerAttemptedAt: today };
    if (facts.has(r.id)) next = { ...next, factsAttemptedAt: today };
    if (contacts.has(r.id) && contactsStatus(r) !== "resolved") next = { ...next, contactsAttemptedAt: today };
    if (reviews.has(r.id) && reviewsStatus(r) !== "resolved") next = { ...next, reviewsAttemptedAt: today };
    return next;
  });
}

// ADR-084 classify pass: on classify_done, stamp brandClassifiedAt = today for each attempted id
// (the ids the classifier ran on) so a classified-but-unresolved row is distinguishable from one
// never classified — and the saved snapshot restores that distinction. An empty list (the error
// frame omits `attempted`) is a no-op: NEVER stamp when nothing completed.
export function applyClassified<T extends { id: string; brandClassifiedAt?: string | null }>(
  rows: T[], attempted: string[], today: string,
): T[] {
  if (attempted.length === 0) return rows;
  const ids = new Set(attempted);
  return rows.map((r) => (ids.has(r.id) ? { ...r, brandClassifiedAt: today } : r));
}

// Bug-2 scoping: the owner-column "researching…" label shows only when a run is active AND the row
// was one of that run's targets (snapshotted at job start) — not for every owner-less row.
export function shouldShowResearching(
  row: { id: string },
  ownerStage: "queued" | "running" | "done" | "skipped",
  researchingIds: Set<string>,
): boolean {
  return ownerStage === "running" && researchingIds.has(row.id);
}

// ── owner contact helpers ─────────────────────────────────────────────────────
export type ContactItem = { kind: "email" | "phone" | "linkedin" | "reach"; label: string; href?: string };

export function ownerContactItems(r: {
  ownerEmail?: string | null;
  ownerPhone?: string | null;
  ownerLinkedin?: string | null;
  ownerReachVia?: string | null;
}): ContactItem[] {
  const items: ContactItem[] = [];
  if (r.ownerEmail) items.push({ kind: "email", label: r.ownerEmail, href: `mailto:${r.ownerEmail}` });
  if (r.ownerPhone) items.push({ kind: "phone", label: r.ownerPhone, href: `tel:${r.ownerPhone}` });
  if (r.ownerLinkedin) items.push({ kind: "linkedin", label: "LinkedIn", href: r.ownerLinkedin });
  if (r.ownerReachVia) items.push({ kind: "reach", label: r.ownerReachVia });
  return items;
}

// ── unified owner-contact card model (ADR-054) ───────────────────────────────
export type ContactSource = "apollo" | "web" | "user";
export type OwnerContact = {
  id?: string | null;
  source?: ContactSource | null;
  name: string | null;
  title: string | null;
  email: string | null;
  emailStatus: string | null;
  linkedin: string | null;
  phone: string | null;
  confidence?: "high" | "medium" | "low" | null;
  sources?: string[] | null;
  // ADR-121: where Apollo places the person ("Madrid, Spain") and how near that is to the hotel
  location?: string | null;
  locality?: "city" | "country" | "elsewhere" | null;
};

// A user-overlay entry: an added card (new id, source:"user"), an override of a machine card
// (same id, edited fields), or a suppression ({id, deleted:true}).
export type UserContact = OwnerContact & { deleted?: boolean };

// Merge the machine list (Apollo + web, enrichment-owned) with the user overlay: drop suppressed
// machine cards, apply overrides by id, append user-added cards (ids absent from the machine list).
export function mergeContacts(machine: OwnerContact[], overlay: UserContact[]): OwnerContact[] {
  if (overlay.length === 0) return machine; // empty overlay → identity
  const suppressed = new Set(overlay.filter((o) => o.deleted).map((o) => o.id));
  const overrides = new Map(overlay.filter((o) => !o.deleted).map((o) => [o.id, o]));
  const machineIds = new Set(machine.map((c) => c.id));
  const kept = machine
    .filter((c) => !suppressed.has(c.id))
    .map((c) => (overrides.has(c.id) ? { ...c, ...overrides.get(c.id)! } : c));
  const added = overlay.filter((o) => !o.deleted && !machineIds.has(o.id));
  return [...kept, ...added];
}

// The dossier Contacts block reads ONE list regardless of owner type. Prefer the stored
// ownerContacts list (Apollo decision-makers OR the web-hunt family contacts); else synthesise a
// single card from the scalar owner_* columns (rows enriched before list-storage landed); else [].
export function contactCards(r: {
  ownerContacts?: OwnerContact[] | null;
  userContacts?: UserContact[] | null;
  ownerEmail?: string | null;
  ownerPhone?: string | null;
  ownerLinkedin?: string | null;
}): OwnerContact[] {
  let machine: OwnerContact[] = [];
  if (r.ownerContacts && r.ownerContacts.length > 0) {
    machine = r.ownerContacts;
  } else if (r.ownerEmail || r.ownerPhone || r.ownerLinkedin) {
    // legacy scalar-only contact — rendered read-only (no id/source -> no edit controls)
    machine = [{
      id: null, source: null, name: null, title: null,
      email: r.ownerEmail ?? null, emailStatus: null,
      linkedin: r.ownerLinkedin ?? null, phone: r.ownerPhone ?? null,
      confidence: null, sources: null,
    }];
  }
  return mergeContacts(machine, r.userContacts ?? []);
}

export type ContactOp =
  | { type: "add"; card: UserContact }
  | { type: "edit"; card: UserContact }
  | { type: "delete"; id: string | null | undefined };

// Pure reducer over the user overlay. add/edit upsert by id; delete records a suppression. Always
// returns a new array. The caller persists the result via PUT /api/hotels/{id}/contacts.
export function applyContactOp(overlay: UserContact[], op: ContactOp): UserContact[] {
  switch (op.type) {
    case "add":
    case "edit": {
      const rest = overlay.filter((o) => o.id !== op.card.id);
      return [...rest, op.card];
    }
    case "delete": {
      const rest = overlay.filter((o) => o.id !== op.id);
      return [...rest, { id: op.id, deleted: true } as UserContact];
    }
  }
}

// ── chat-over-the-live-set operations (read-only carve/order) ────────────────────────────────
// The backend chat emits these; the client applies them to its own filter + sort view (ADR-030).
// `key`/`dir` are kept loose (string) here — Workbench owns the strict SortKey and casts at the
// boundary (the backend only emits valid keys). Pure: a (filters, sort) → (filters, sort) reducer.
export type SortDir = "asc" | "desc";
export type SortView = { key: string; dir: SortDir };
export type Operation =
  | { type: "addFilter"; filter: Filter }
  | { type: "removeFilter"; attr: FilterAttr }
  | { type: "clearFilters" }
  | { type: "setSort"; key: string; dir: SortDir }
  | { type: "setSelection"; ids: string[] }
  | { type: "clearSelection" };

// Apply one operation. addFilter REPLACES any existing chip on the same attr (a column filters on
// one predicate at a time, mirroring the keys-bound control), so re-filtering an attr updates it.
export function applyOperation(
  state: { filters: Filter[]; sort: SortView },
  op: Operation,
): { filters: Filter[]; sort: SortView } {
  switch (op.type) {
    case "addFilter":
      return {
        ...state,
        filters: [...state.filters.filter((f) => f.attr !== op.filter.attr), op.filter],
      };
    case "removeFilter":
      return { ...state, filters: state.filters.filter((f) => f.attr !== op.attr) };
    case "clearFilters":
      return { ...state, filters: [] };
    case "setSort":
      return { ...state, sort: { key: op.key, dir: op.dir } };
    case "setSelection":
    case "clearSelection":
      return state; // selection lives in its own Set — see applySelectionOps
  }
}

// Fold a batch of operations left-to-right.
export function applyOperations(
  filters: Filter[],
  sort: SortView,
  ops: Operation[],
): { filters: Filter[]; sort: SortView } {
  return ops.reduce(applyOperation, { filters, sort });
}

// Apply chat selection operations to the client's selection Set (separate from filter/sort state).
// setSelection REPLACES the selection (the model unions itself when asked to "also select…");
// ids are validated against the on-screen rows so a hallucinated id can never select nothing/wrong.
export function applySelectionOps(
  selected: Set<string>,
  ops: Operation[],
  validIds: Set<string>,
): Set<string> {
  let next = selected;
  for (const op of ops) {
    if (op.type === "setSelection") {
      next = new Set(op.ids.filter((id) => validIds.has(id)));
    } else if (op.type === "clearSelection") {
      next = new Set();
    }
  }
  return next;
}

// ── ADR-084 brand affiliation display ───────────────────────────────────────────────────────
export const AFFILIATION_OPTS = ["brand", "regional_chain", "independent", "unresolved"] as const;

export function affiliationLabel(v: string | null | undefined): string {
  switch (v) {
    case "brand": return "Brand";
    case "regional_chain": return "Regional chain";
    case "independent": return "Independent";
    case "unresolved": return "Could not find";
    default: return "—"; // null: not yet classified
  }
}

// Convertibility tooltip per bucket (ADR-084) — what the label MEANS in BD terms, not jargon.
export function affiliationTooltip(v: string | null | undefined): string {
  switch (v) {
    case "brand": return "Flagged under a global or soft brand (Marriott, Hilton, IHG…). Contract-locked — cold conversion target.";
    case "regional_chain": return "Self-standing regional group under its own name. Portfolio conversion play — warm target.";
    case "independent": return "No brand. Cleanest conversion target; check the operator to see if a third party runs it.";
    case "unresolved": return "Operator/brand could not be determined — not yet classified, not a signal of independence.";
    default: return "Not yet classified.";
  }
}
