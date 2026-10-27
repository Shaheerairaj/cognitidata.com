// The demo's fake backend. `installDemoServer()` wraps window.fetch: every `/api/*` (and
// `/health`) request is answered here, in the browser, from the bundled JSON — nothing leaves the
// page and no paid API is ever called. Everything else (map tiles, fonts) goes to the real fetch.
//
// The spec is the real backend (backend/app/main.py + helpers): request validation, response JSON
// and SSE frame sequences are reproduced so the UI behaves exactly as it does against FastAPI.
// Streaming endpoints return a text/event-stream Response whose body emits `data: <json>\n\n`
// frames with small delays, so progress looks live. Enrichment and outreach are REPLAYS of the
// recorded results; a hotel with no recorded result says "not part of this demo" (never a fake
// "searched, found nothing").

import {
  bestCandidate, buildEml, classifyLeads, emlFilename, emlRecipients, hotelsToTemplateCsv,
  isTemplateHeader, parseTemplate, rowsFromCsv, zipStore, type Existing,
} from "./ports";
import {
  CHAT, defaultTeaserUrl, STORAGE_KEY, addAlias, deleteRows, getSettings, loadDb, patchPlace, putRow,
  putSettings, setUploadedTeaser, uploadedTeaser, type ChatEntry, type Db, type Place, type Wire,
} from "./store";

export { teaserUrl } from "./store";

export const DEMO_CITIES = ["Abu Dhabi", "Casablanca", "Trieste", "Lecce"];
const DEMO_CITY_LINE = "This demo covers Abu Dhabi, Casablanca, Trieste and Lecce";
export const OFF_SCRIPT_REPLY =
  "This is a demo with recorded answers — try one of the suggested questions, or search Abu Dhabi, Casablanca, Trieste or Lecce.";

// ── pacing ────────────────────────────────────────────────────────────────────
let speed = 1; // tests set 0 so streams resolve instantly
export function setDemoSpeed(s: number): void {
  speed = s;
}
const sleep = (ms: number) => (ms * speed > 0 ? new Promise((r) => setTimeout(r, ms * speed)) : Promise.resolve());
const today = () => new Date().toISOString().slice(0, 10);
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
const runId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`).replace(/-/g, "").slice(0, 12);

// ── response helpers ─────────────────────────────────────────────────────────
type Frame = Record<string, unknown>;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const detail = (status: number, msg: string) => json({ detail: msg }, status);
// FastAPI/pydantic validation errors are 422 with a list of {loc, msg}.
const invalid = (msg: string) => json({ detail: [{ type: "value_error", loc: ["body"], msg }] }, 422);
class Invalid extends Error {}

function sse(frames: AsyncGenerator<Frame>): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      try {
        const { value, done } = await frames.next();
        if (done) ctrl.close();
        else ctrl.enqueue(enc.encode(`data: ${JSON.stringify(value)}\n\n`));
      } catch (e) {
        ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ type: "error", message: String(e) })}\n\n`));
        ctrl.close();
      }
    },
    cancel() {
      void frames.return(undefined);
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

const isUuid = (s: unknown) =>
  typeof s === "string" && /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(s);

async function body(req: Request): Promise<Record<string, any>> {
  try {
    const b = await req.json();
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error();
    return b;
  } catch {
    throw new Invalid("JSON body required");
  }
}

// ── geometry (registry.py / registry_ingest.py) ──────────────────────────────
type BBox = [number, number, number, number];
const CELL_DEG = 0.25;

export function cellsForBbox(w: number, s: number, e: number, n: number): string[] {
  const out: string[] = [];
  for (let la = Math.floor(s / CELL_DEG); la <= Math.floor(n / CELL_DEG); la++)
    for (let lo = Math.floor(w / CELL_DEG); lo <= Math.floor(e / CELL_DEG); lo++) out.push(`${la}:${lo}`);
  return out;
}

function pinBbox(lat: number, lng: number, radiusKm: number): BBox {
  const dlat = radiusKm / 111.0;
  const dlng = radiusKm / (111.0 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return [lng - dlng, lat - dlat, lng + dlng, lat + dlat];
}

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const r = (d: number) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function polygonRings(g: any): number[][][][] | null {
  if (!g || !g.coordinates) return null;
  if (g.type === "Polygon" && g.coordinates.length) return [g.coordinates];
  if (g.type === "MultiPolygon" && g.coordinates.length) return g.coordinates;
  return null;
}

function inPolygons(lng: number, lat: number, multipoly: number[][][][]): boolean {
  for (const rings of multipoly) {
    let inside = false;
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[(i - 1 + ring.length) % ring.length];
        const [x2, y2] = ring[i];
        if (y1 > lat !== y2 > lat && lng < ((x2 - x1) * (lat - y1)) / (y2 - y1) + x1) inside = !inside;
      }
    }
    if (inside) return true;
  }
  return false;
}

function validateAreaBbox(bbox: unknown): BBox {
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every((v) => typeof v === "number"))
    throw new Invalid("bbox must be [w, s, e, n]");
  const [w, s, e, n] = bbox as BBox;
  if (w >= e || s >= n) throw new Invalid("bbox is degenerate — w must be < e and s < n");
  if (w < -180 || e > 180) throw new Invalid("scan area would cross the ±180° antimeridian — move the area away from the date line");
  if (n >= 85 || s <= -85) throw new Invalid("scan area would reach ±85° latitude — move the area away from the poles");
  const edgeKm = Math.max((n - s) * 111.0, (e - w) * 111.0 * Math.cos((((s + n) / 2) * Math.PI) / 180));
  if (edgeKm > 60) throw new Invalid("area too large — its longer edge exceeds ~60 km; zoom in or pick a smaller area");
  return [w, s, e, n];
}

// The search/review geometry: area {bbox, polygon?} or pin {lat, lng, radius_km}.
type Geo = { bbox: BBox; polygon: any | null; pin: { lat: number; lng: number; radiusKm: number } | null };
function parseGeo(b: Record<string, any>): Geo {
  const pin = [b.lat, b.lng, b.radius_km];
  if (b.bbox != null) {
    if (pin.some((v) => v != null)) throw new Invalid("provide either lat/lng/radius_km (pin mode) or bbox (area mode), not both");
    return { bbox: validateAreaBbox(b.bbox), polygon: b.polygon ?? null, pin: null };
  }
  if (b.polygon != null) throw new Invalid("polygon applies to area (bbox) mode only");
  if (pin.some((v) => typeof v !== "number")) throw new Invalid("provide lat/lng/radius_km (pin mode) or bbox (area mode)");
  const [lat, lng, r] = pin as number[];
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180 || r <= 0 || r > 30) throw new Invalid("pin out of range");
  const bb = pinBbox(lat, lng, r);
  if (bb[0] < -180 || bb[2] > 180) throw new Invalid("scan area would cross the ±180° antimeridian — move the pin away from the date line");
  if (bb[3] >= 85 || bb[1] <= -85) throw new Invalid("scan area would reach ±85° latitude — move the pin away from the poles");
  return { bbox: bb, polygon: null, pin: { lat, lng, radiusKm: r } };
}

function inGeo(lat: number | null | undefined, lng: number | null | undefined, g: Geo): boolean {
  if (lat == null || lng == null) return false;
  const [w, s, e, n] = g.bbox;
  if (lat < s || lat > n || lng < w || lng > e) return false;
  if (g.pin) return haversineM(g.pin.lat, g.pin.lng, lat, lng) <= g.pin.radiusKm * 1000;
  const rings = polygonRings(g.polygon);
  return rings ? inPolygons(lng, lat, rings) : true;
}

// ── text folding (case / accents / punctuation) ──────────────────────────────
export const fold = (s: string | null | undefined) =>
  (s ?? "").normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const keysDesc = (a: Wire, b: Wire) => (b.keys ?? -1) - (a.keys ?? -1);

// ═══ registry: preview / search / review ══════════════════════════════════════

// Latin-script localities with a few pinned hotels — offered as preview candidates alongside the
// cities' recorded geocoder results ("Yas Island", "Anfa").
function localityCandidates(db: Db) {
  const groups = new Map<string, { city: string; label: string; pts: [number, number][] }>();
  for (const r of db.rows.values()) {
    const lf = fold(r.locality);
    if (!lf || r.lat == null || lf === fold(r.city) || !/^[\x00-\x7f]+$/.test(r.locality)) continue;
    const k = `${r.city}|${lf}`;
    const g = groups.get(k) ?? { city: r.city as string, label: r.locality as string, pts: [] as [number, number][] };
    g.pts.push([r.lng, r.lat]);
    groups.set(k, g);
  }
  const out: { city: string; cand: any }[] = [];
  for (const g of groups.values()) {
    if (g.pts.length < 3) continue;
    const lngs = g.pts.map((p) => p[0]);
    const lats = g.pts.map((p) => p[1]);
    const pad = 0.01;
    const label = g.label === g.label.toUpperCase() ? g.label.charAt(0) + g.label.slice(1).toLowerCase() : g.label;
    const area = db.areas[g.city];
    out.push({
      city: g.city,
      cand: {
        label,
        context: area?.geocode?.[0]?.context ?? g.city,
        lat: lats.reduce((a, b) => a + b, 0) / lats.length,
        lng: lngs.reduce((a, b) => a + b, 0) / lngs.length,
        bbox: [Math.min(...lngs) - pad, Math.min(...lats) - pad, Math.max(...lngs) + pad, Math.max(...lats) + pad],
        polygon: null,
      },
    });
  }
  return out;
}

function previewQuery(db: Db, query: string) {
  const q = fold(query);
  const wordHit = (target: string) => {
    const t = fold(target);
    return t.startsWith(q) || (q.length >= 3 && q.startsWith(t)) || (q.length >= 3 && t.split(" ").some((w) => w.startsWith(q)));
  };
  const out: any[] = [];
  for (const [city, area] of Object.entries(db.areas)) if (wordHit(city)) out.push(...area.geocode);
  for (const l of localityCandidates(db)) if (wordHit(l.cand.label)) out.push(l.cand);
  return out.slice(0, 5);
}

function previewBbox(db: Db, bbox: BBox) {
  const [w, s, e, n] = bbox;
  const cells = cellsForBbox(w, s, e, n);
  const fresh = cells.filter((c) => !db.coveredCells.has(c)).length;
  const known = db.places.filter(
    (p) => p.band === "ingest" && !p.vanished_at && p.lat >= s && p.lat <= n && p.lng >= w && p.lng <= e,
  ).length;
  return { cells_total: cells.length, cells_fresh: fresh, known_places: known, est_seconds: fresh * 50 };
}

async function registryPreview(db: Db, req: Request) {
  const b = await body(req);
  const extra = Object.keys(b).filter((k) => k !== "query" && k !== "bbox");
  if (extra.length) return invalid(`extra inputs are not permitted: ${extra.join(", ")}`);
  if ((b.query == null) === (b.bbox == null)) return invalid("provide exactly one of 'query' or 'bbox'");
  if (b.query != null) {
    if (typeof b.query !== "string" || !b.query.trim()) return invalid("query must be non-empty");
    await sleep(250); // a geocoder round-trip
    return json({ candidates: previewQuery(db, b.query) });
  }
  if (!Array.isArray(b.bbox) || b.bbox.length !== 4) return invalid("bbox must be [w, s, e, n]");
  return json(previewBbox(db, b.bbox as BBox));
}

async function* registryStream(db: Db, g: Geo, label: string): AsyncGenerator<Frame> {
  // A covered area serves straight from the database — the real path emits no scan status, only
  // the terminal `done` with the stored rows (their registry pins as lat/lng).
  const hotels = [...db.rows.values()].filter((r) => inGeo(r.lat, r.lng, g));
  if (hotels.length === 0) {
    // The real stream would scan an uncovered area; the demo has no data there — say so plainly.
    yield { type: "status", message: `${DEMO_CITY_LINE} — there are no hotels here in the demo data.` };
    await sleep(3500);
  } else {
    await sleep(1400);
  }
  yield {
    type: "done", market: label, status: "ok", unique_count: hotels.length, query_count: 0,
    narrowing_suggestions: [], hotels,
  };
  // The real stream then runs the paid auto-enrich + brand-classify passes over stale rows; the
  // demo never implies live spend, so they are skipped (the stream simply closes).
}

async function registrySearch(db: Db, req: Request) {
  const b = await body(req);
  if (typeof b.label !== "string" || !b.label.trim()) return invalid("label must be non-empty");
  const g = parseGeo(b);
  return sse(registryStream(db, g, b.label.trim()));
}

function reviewRowsFor(db: Db, g: Geo) {
  const aliased = new Set(db.persisted.aliases.map(([a]) => a));
  const ingest = db.places.filter((p) => p.band === "ingest" && !p.vanished_at && p.name && inGeo(p.lat, p.lng, g));
  const byNorm = new Map<string, Place>();
  for (const h of ingest) if (!byNorm.has(fold(h.name).replace(/ /g, ""))) byNorm.set(fold(h.name).replace(/ /g, ""), h);
  return db.places
    .filter((p) => p.name && (p.band === "review" || p.vanished_at) && p.review_reason !== "closed"
      && !aliased.has(p.gers_id) && inGeo(p.lat, p.lng, g))
    .map((p) => {
      const reason = p.vanished_at ? "possibly_closed" : (p.review_reason || "not_lodging");
      const item: Record<string, unknown> = {
        id: p.gers_id, name: p.name, lat: p.lat, lng: p.lng, reason, detail: p.review_detail,
        locality: p.locality, category: p.category, brand: p.brand,
        website: p.websites?.[0] ?? null, socials: p.socials ?? [], address: p.address, phone: p.phones?.[0] ?? null,
      };
      if (reason === "duplicate" && p.review_detail) {
        const c = byNorm.get(fold(p.review_detail).replace(/ /g, ""));
        if (c) item.candidate = { id: c.gers_id, name: c.name, lat: c.lat, lng: c.lng, locality: c.locality, website: c.websites?.[0] ?? null };
      }
      return item;
    });
}

async function registryReview(db: Db, req: Request) {
  const b = await body(req);
  const g = parseGeo(b);
  const rows = reviewRowsFor(db, g);
  return json({ rows, count: rows.length });
}

async function registryDecide(db: Db, req: Request) {
  const b = await body(req);
  if (!Array.isArray(b.decisions) || b.decisions.length === 0) return invalid("decisions must hold at least 1 item");
  const results: Record<string, unknown>[] = [];
  for (const d of b.decisions) {
    if (!d || typeof d.gers_id !== "string" || !["merge", "keep", "not_hotel", "closed"].includes(d.decision))
      return invalid("each decision needs gers_id and a decision of merge/keep/not_hotel/closed");
  }
  for (const d of b.decisions) {
    if (d.decision === "merge") {
      if (!d.canonical_gers_id) {
        results.push({ gers_id: d.gers_id, decision: "merge", ok: false, error: "merge requires a candidate" });
        continue;
      }
      addAlias(db, d.gers_id, d.canonical_gers_id);
    } else if (d.decision === "keep") {
      patchPlace(db, d.gers_id, { band: "ingest", review_reason: null, review_detail: null });
    } else if (d.decision === "closed") {
      patchPlace(db, d.gers_id, { review_reason: "closed" });
    } else {
      patchPlace(db, d.gers_id, { band: null, review_reason: null, review_detail: null, vanished_at: null });
    }
    results.push({ gers_id: d.gers_id, decision: d.decision, ok: true });
  }
  return json({ results, twin_conflicts: [] });
}

// ═══ enrichment replay ═════════════════════════════════════════════════════════

// The stored owner-research blob (snake_case) the `enriched` frame carries — the inverse of the
// wire mapping (hotels.owner_research_to_wire); the client converts it back.
function researchToStored(r: any) {
  if (!r) return null;
  return {
    researched_at: r.researchedAt, brief: r.brief, stopped: r.stopped, as_of: r.asOf,
    confidence: r.confidence, evidence: r.evidence, sources: r.sources ?? [],
    cast: (r.cast ?? []).map((c: any) => ({ entity: c.entity, role: c.role, evidence: c.evidence, source: c.source, as_of: c.asOf })),
    best_lead: r.bestLead ? { entity: r.bestLead.entity, role: r.bestLead.role, why_not: r.bestLead.whyNot } : null,
  };
}

const isChain = (t: string | null | undefined) => (t ?? "").trim().toLowerCase() === "chain";
const suggestedOwner = (research: any): string | null => {
  const lead = research?.bestLead;
  if (!lead || !String(lead.entity ?? "").trim() || ["operator", "brand"].includes(lead.role)) return null;
  return String(lead.entity).trim();
};
const fld = (value: unknown, confidence = "medium", sources: string[] = []) => ({ value, confidence, sources });

const hasOwnerResult = (r: Wire) => Boolean(r.ownerName || r.ownerResearch || r.ownerAttemptedAt);
const hasContactResult = (r: Wire) =>
  Boolean((r.ownerContacts?.length ?? 0) > 0 || r.ownerEmail || r.ownerPhone || r.ownerLinkedin || r.ownerReachVia || r.ownerResearch);
const hasReviewResult = (r: Wire) =>
  Boolean(r.reviewsAttemptedAt || r.bookingRating != null || r.starRating != null || r.reviewThemes || r.reviewSummary || (r.roomCategories?.length ?? 0) > 0);

function ownerFields(r: Wire) {
  const conf = r.ownerConf ?? "medium";
  const f: Record<string, unknown> = {};
  if (r.ownerName) f.owner = fld(r.ownerName, conf, r.ownerSources ?? []);
  if (r.ownerType) f.ownerType = fld(r.ownerType, conf, r.ownerSources ?? []);
  if (r.ownerResearch) f.ownerResearch = fld(researchToStored(r.ownerResearch), conf);
  return f;
}

function contactFields(r: Wire) {
  const f: Record<string, unknown> = {};
  if ((r.ownerContacts?.length ?? 0) > 0) f.ownerContacts = fld(r.ownerContacts);
  for (const k of ["ownerEmail", "ownerPhone", "ownerLinkedin", "ownerReachVia"]) if (r[k]) f[k] = fld(r[k]);
  f.contactResearch = fld({ replayed: true });
  return f;
}

function reviewFields(r: Wire) {
  const src = r.reviewSources ?? [];
  const f: Record<string, unknown> = {};
  if (r.starRating != null) f.starRating = fld(r.starRating, "high", src);
  if (r.bookingRating != null) f.bookingRating = fld(r.bookingRating, "high", src);
  if (r.bookingReviews != null) f.bookingReviews = fld(r.bookingReviews, "high", src);
  if (r.reviewThemes) f.reviewThemes = fld(r.reviewThemes, "medium", src);
  if (r.reviewSummary) f.reviewSummary = fld(r.reviewSummary, "medium", src);
  if (r.roomCategories?.length) f.roomCategories = fld(r.roomCategories, "medium", src);
  return f;
}

const OWNER_KEYS = ["ownerName", "ownerType", "ownerResearch", "ownerSources", "ownerConf"];
const CONTACT_KEYS = ["ownerContacts", "ownerEmail", "ownerPhone", "ownerLinkedin", "ownerReachVia"];
const REVIEW_KEYS = ["starRating", "bookingRating", "bookingReviews", "reviewThemes", "reviewSummary", "roomCategories", "reviewSources"];
const pick = (r: Wire, keys: string[]) => Object.fromEntries(keys.map((k) => [k, r[k] ?? null]));

const notInDemo = (id: string, name: string): Frame => ({
  type: "status", hotel_id: id, message: `${name}: not part of this demo — no recorded research to replay`,
});

function stale(at: string | null | undefined, days = 30): boolean {
  if (!at) return true;
  const t = Date.parse(String(at).slice(0, 10));
  return Number.isNaN(t) || t <= Date.now() - days * 86_400_000;
}

type Ref = { id: string; name: string; ownerName?: string | null; ownerType?: string | null; reviewsAttemptedAt?: string | null };

async function* enrichJobStream(db: Db, hotels: Ref[], kinds: string[]): AsyncGenerator<Frame> {
  const attempted: Record<string, string[]> = { owner: [], facts: [], contacts: [], reviews: [] };
  const summary = { owner: 0, contacts: 0, reviews: 0 };
  // a few seconds per hotel, but a big selection still finishes in well under a minute
  const step = Math.min(1300, Math.max(300, 30000 / Math.max(1, hotels.length * kinds.length * 3)));
  const update = (id: string, patch: Record<string, unknown>) => {
    const cur = db.rows.get(id);
    if (cur) putRow(db, { ...cur, ...patch });
  };

  if (kinds.includes("owner") && hotels.length) {
    yield { type: "phase", kind: "owner", count: hotels.length };
    for (const h of hotels) {
      const rec = db.original.get(h.id);
      yield { type: "status", hotel_id: h.id, message: `Enriching ${h.name}…` };
      await sleep(step);
      if (!rec || !db.rows.has(h.id) || !hasOwnerResult(rec)) {
        yield notInDemo(h.id, h.name);
        continue;
      }
      yield { type: "status", hotel_id: h.id, message: `Owner hunt: ${h.name}…` };
      await sleep(step * 1.6);
      yield { type: "enriched", hotel_id: h.id, hops: 2 + (h.id.charCodeAt(0) % 4), fields: ownerFields(rec) };
      attempted.owner.push(h.id);
      attempted.facts.push(h.id);
      update(h.id, { ...pick(rec, OWNER_KEYS), ownerAttemptedAt: today(), factsAttemptedAt: today(), enriched: true });
      const target = rec.ownerName || suggestedOwner(rec.ownerResearch);
      if (target && !isChain(rec.ownerType)) {
        yield { type: "status", hotel_id: h.id, message: `Finding contacts for ${target}…` };
        await sleep(step);
        yield { type: "enriched", hotel_id: h.id, fields: contactFields(rec) };
        attempted.contacts.push(h.id);
        update(h.id, { ...pick(rec, CONTACT_KEYS), contactsAttemptedAt: today() });
      }
    }
    summary.owner = attempted.owner.length;
    summary.contacts = attempted.contacts.length;
  }

  if (kinds.includes("contacts")) {
    const already = new Set(attempted.contacts);
    const recipe = hotels.filter((h) => {
      if (already.has(h.id)) return false;
      if ((h.ownerName ?? "").trim()) return !isChain(h.ownerType) && stale(db.rows.get(h.id)?.contactsAttemptedAt);
      return suggestedOwner(db.rows.get(h.id)?.ownerResearch) != null && stale(db.rows.get(h.id)?.contactsAttemptedAt);
    });
    if (recipe.length) {
      yield { type: "phase", kind: "contacts", count: recipe.length };
      for (const h of recipe) {
        const rec = db.original.get(h.id);
        const who = h.ownerName || suggestedOwner(db.rows.get(h.id)?.ownerResearch) || h.name;
        yield { type: "status", hotel_id: h.id, message: `Finding contacts for ${who}…` };
        await sleep(step * 1.4);
        if (!rec || !db.rows.has(h.id) || !hasContactResult(rec)) {
          yield notInDemo(h.id, h.name);
          continue;
        }
        yield { type: "enriched", hotel_id: h.id, fields: contactFields(rec) };
        attempted.contacts.push(h.id);
        update(h.id, { ...pick(rec, CONTACT_KEYS), contactsAttemptedAt: today() });
      }
      summary.contacts = new Set(attempted.contacts).size;
    }
  }

  if (kinds.includes("reviews")) {
    const eligible = hotels.filter((h) => stale(h.reviewsAttemptedAt));
    if (eligible.length) {
      yield { type: "phase", kind: "reviews", count: eligible.length };
      for (const h of eligible) {
        const rec = db.original.get(h.id);
        yield { type: "status", hotel_id: h.id, message: `Reviews & rates: ${h.name}…` };
        await sleep(step * 1.4);
        if (!rec || !db.rows.has(h.id) || !hasReviewResult(rec)) {
          yield notInDemo(h.id, h.name);
          continue;
        }
        yield { type: "enriched", hotel_id: h.id, fields: reviewFields(rec) };
        attempted.reviews.push(h.id);
        update(h.id, { ...pick(rec, REVIEW_KEYS), reviewsAttemptedAt: today() });
      }
      summary.reviews = attempted.reviews.length;
    }
  }

  yield { type: "done", ...summary, attempted };
}

async function enrichJob(db: Db, req: Request) {
  const b = await body(req);
  if (!Array.isArray(b.hotels) || !b.hotels.every((h: any) => h && typeof h.id === "string" && typeof h.name === "string"))
    return invalid("hotels must be a list of {id, name, …}");
  if (!Array.isArray(b.kinds) || !b.kinds.every((k: unknown) => k === "owner" || k === "contacts" || k === "reviews"))
    return invalid("kinds must be a list of 'owner' | 'contacts' | 'reviews'");
  return sse(enrichJobStream(db, b.hotels, b.kinds));
}

// ═══ outreach ══════════════════════════════════════════════════════════════════

function validIds(b: Record<string, any>): string[] | Response {
  if (!Array.isArray(b.ids)) return invalid("ids must be a list");
  if (b.ids.length === 0) return detail(400, "no hotel ids given");
  for (const id of b.ids) if (!isUuid(id)) return detail(400, `malformed hotel id: '${id}'`);
  return b.ids as string[];
}

async function* outreachStream(db: Db, ids: string[]): AsyncGenerator<Frame> {
  const rows = ids.map((id) => db.rows.get(id)).filter((r): r is Wire => Boolean(r));
  const skipped = ids.length - rows.length;
  let generated = 0;
  let failed = 0;
  yield { type: "phase", kind: "outreach", count: rows.length };
  const step = Math.min(2600, Math.max(700, 25000 / Math.max(1, rows.length)));
  for (const row of rows) {
    await sleep(step);
    const recorded = db.original.get(row.id)?.outreach;
    if (!recorded) {
      failed += 1; // the real per-lead failure frame, with the honest reason
      yield { type: "status", message: `Outreach failed for ${row.name} — not part of this demo (no recorded draft)` };
      continue;
    }
    const pkg = { ...recorded, generated_at: nowIso() };
    delete (pkg as Record<string, unknown>).edited_fields;
    delete (pkg as Record<string, unknown>).edited_at;
    putRow(db, { ...row, outreach: pkg });
    generated += 1;
    yield { type: "outreach", hotel_id: row.id, package: pkg };
  }
  yield { type: "done", generated, skipped, failed };
}

async function outreachJob(db: Db, req: Request) {
  const ids = validIds(await body(req));
  return ids instanceof Response ? ids : sse(outreachStream(db, ids));
}

export function mergeOutreachEdit(pkg: Record<string, any>, field: string, value: string) {
  return {
    ...pkg,
    content: { ...pkg.content, [field]: value },
    edited_fields: [...(pkg.edited_fields ?? []).filter((f: string) => f !== field), field],
    edited_at: nowIso(),
  };
}

async function outreachEdit(db: Db, req: Request, id: string) {
  const b = await body(req);
  if (typeof b.field !== "string" || typeof b.value !== "string") return invalid("field and value are required strings");
  if (!["email_subject", "email_body"].includes(b.field)) return detail(400, `field not editable: '${b.field}'`);
  const row = db.rows.get(id);
  if (!row?.outreach) return detail(404, "no outreach package for that hotel");
  const pkg = mergeOutreachEdit(row.outreach, b.field, b.value);
  putRow(db, { ...row, outreach: pkg });
  return json({ ok: true, package: pkg });
}

let fetchStatic: (path: string) => Promise<Response> = (path) => fetch(path);

async function teaserBytes(): Promise<Uint8Array> {
  const up = uploadedTeaser();
  if (up) return up.bytes;
  const res = await fetchStatic(defaultTeaserUrl());
  if (!res.ok) throw new Error(`teaser PDF unreadable (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

const disposition = (kind: string, filename: string) => {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "").replace(/"/g, "").trim() || "file";
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
};

async function outreachExport(db: Db, req: Request) {
  const ids = validIds(await body(req));
  if (ids instanceof Response) return ids;
  let pdf: Uint8Array;
  try {
    pdf = await teaserBytes();
  } catch (e) {
    return detail(502, String((e as Error).message));
  }
  const used = new Set<string>();
  const leads: { name: string; row: Wire }[] = [];
  for (const id of ids) {
    const row = db.rows.get(id);
    if (!row?.outreach) continue;
    let name = emlFilename(row.name);
    const stem = name.slice(0, -4);
    for (let n = 2; used.has(name); n++) name = `${stem} (${n}).eml`;
    used.add(name);
    leads.push({ name, row });
  }
  if (!leads.length) return detail(404, "no outreach package for those hotels");
  const eml = (row: Wire) => {
    const content = row.outreach.content ?? {};
    const [to, cc] = emlRecipients(row as any, row.outreach);
    return buildEml(to, cc, content.email_subject ?? "", content.email_body ?? "", pdf);
  };
  if (leads.length === 1) {
    return new Response(eml(leads[0].row) as BodyInit, {
      headers: { "content-type": "message/rfc822", "content-disposition": disposition("attachment", leads[0].name) },
    });
  }
  const zip = zipStore(leads.map((l) => ({ name: l.name, data: eml(l.row) })));
  return new Response(zip as BodyInit, {
    headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="outreach-emails.zip"' },
  });
}

// ═══ settings ══════════════════════════════════════════════════════════════════

const REQUIRED_SLOTS = ["{fit}", "{args}", "{register}", "{lead}"];

async function putOutreachSettings(db: Db, req: Request) {
  const b = await body(req);
  if (typeof b.right_to_win !== "string" || typeof b.copy_prompt !== "string")
    return invalid("right_to_win and copy_prompt are required strings");
  const prompt = b.copy_prompt.trim();
  if (!prompt) return detail(400, "the copy agent prompt can't be empty");
  const missing = REQUIRED_SLOTS.filter((s) => !prompt.includes(s));
  if (missing.length) return detail(400, `the copy agent prompt must keep the slots: ${missing.join(", ")}`);
  const s = { right_to_win: b.right_to_win.trim(), copy_prompt: prompt };
  putSettings(db, s);
  return json(s);
}

let defaultTeaserSize: number | null = null;
async function teaserMeta() {
  const up = uploadedTeaser();
  if (up) return up.meta;
  defaultTeaserSize ??= (await teaserBytes()).length;
  return { filename: "Cognitidata Teaser.pdf", size: defaultTeaserSize, uploaded_at: "2026-10-01T09:00:00+00:00" };
}

async function postTeaser(req: Request) {
  let file: FormDataEntryValue | null;
  try {
    file = (await req.formData()).get("file");
  } catch {
    return invalid("file is required");
  }
  if (!file || typeof file === "string") return invalid("file is required");
  const data = new Uint8Array(await file.arrayBuffer());
  if (data.length > 20 * 1024 * 1024) return detail(400, "the teaser PDF exceeds the 20 MB limit");
  if (new TextDecoder().decode(data.subarray(0, 5)) !== "%PDF-") return detail(400, "not a PDF file — export the deck as PDF first");
  const meta = { filename: file.name || "teaser.pdf", size: data.length, uploaded_at: nowIso() };
  setUploadedTeaser(meta, data);
  return json({ teaser: meta });
}

async function teaserFile(url: URL) {
  const data = await teaserBytes();
  const meta = await teaserMeta();
  const download = ["1", "true"].includes(url.searchParams.get("download") ?? "");
  return new Response(data as BodyInit, {
    headers: { "content-type": "application/pdf", "content-disposition": disposition(download ? "attachment" : "inline", meta.filename) },
  });
}

// ═══ leads ═════════════════════════════════════════════════════════════════════

const existingRows = (db: Db): Existing[] =>
  [...db.rows.values()].map((r) => ({ hotel_id: r.id, name: r.name, city: r.city, country: r.country }));

const NOT_TEMPLATE =
  "The demo accepts the lead template CSV only (download the template, or try sample-leads.csv). Free text and other layouts go to an AI parser in the live app.";

async function leadsParse(db: Db, req: Request) {
  let fd: FormData;
  try {
    fd = await req.formData();
  } catch {
    return invalid("addedBy is required");
  }
  const addedBy = fd.get("addedBy");
  if (typeof addedBy !== "string") return invalid("addedBy is required");
  const text = fd.get("text");
  const file = fd.get("file");
  if (file && typeof file !== "string" && !/\.(csv|txt)$/i.test(file.name || ""))
    return detail(400, "Unsupported file type — upload a .csv (or paste the rows).");
  const raw = file && typeof file !== "string" ? await file.text() : null;
  if (!(typeof text === "string" && text.trim()) && !raw) return detail(400, "Provide text or a file.");
  const rows = rowsFromCsv(raw ?? String(text));
  if (!rows.length || !isTemplateHeader(rows[0])) return detail(400, NOT_TEMPLATE);
  const leads = classifyLeads(parseTemplate(rows), existingRows(db));
  const summary = { new: 0, known: 0, ambiguous: 0 };
  for (const l of leads) summary[l.classification] += 1;
  return json({ run_id: runId(), mode: "template", summary, truncated: false, dropped: 0, leads });
}

const OWNER_TYPES = ["family", "individual", "institutional", "government", "chain"];
// hotels.write_user_fields: user field → the wire field it shows up as
const FIELD_TO_WIRE: Record<string, string> = {
  name: "name", city: "city", country: "country", segment: "segment", key_count: "keys",
  owner_name: "ownerName", owner_type: "ownerType", locality: "locality", brand: "brand",
  owner_email: "ownerEmail", owner_phone: "ownerPhone", owner_linkedin: "ownerLinkedin",
  source_url: "source", residence_count: "residences", official_website: "officialWebsite",
};

function writeUserFields(row: Wire, fields: Record<string, unknown>): Wire {
  const next: Wire = { ...row };
  for (const [name, value] of Object.entries(fields)) {
    if (value == null) continue;
    if (name === "notes") { next.notes = value; continue; }
    const w = FIELD_TO_WIRE[name];
    if (!w) continue;
    if (name === "owner_type" && !OWNER_TYPES.includes(String(value)))
      throw new Invalid(`owner_type must be one of ${JSON.stringify([...OWNER_TYPES].sort())}`);
    next[w] = value;
  }
  next.updatedAt = nowIso();
  return next;
}

function blankRow(db: Db, id: string): Wire {
  const sample = db.original.values().next().value as Wire;
  const row = Object.fromEntries(Object.keys(sample).map((k) => [k, null])) as Wire;
  return { ...row, id, name: "" };
}

async function leadsCommit(db: Db, req: Request) {
  const b = await body(req);
  if (typeof b.addedBy !== "string" || !Array.isArray(b.leads)) return invalid("addedBy and leads are required");
  for (const l of b.leads) {
    if (!l || typeof l.name !== "string" || !["insert", "merge"].includes(l.action)) return invalid("each lead needs a name and an action");
    if (l.action === "merge" && l.matchHotelId && !isUuid(l.matchHotelId))
      return detail(400, `matchHotelId is not a valid uuid: '${l.matchHotelId}'`);
  }
  const existing = existingRows(db);
  for (const l of b.leads) {
    if (l.action === "insert" && bestCandidate(l.name, l.city ?? null, l.country ?? null, existing)[0] === "known")
      return detail(400, `'${l.name}' already exists in the database — merge or skip instead`);
    if (l.action === "merge") {
      if (!l.matchHotelId) return detail(400, "merge action requires matchHotelId");
      if (!db.rows.has(l.matchHotelId)) return detail(400, `unknown matchHotelId: ${l.matchHotelId}`);
    }
  }
  let inserted = 0;
  let merged = 0;
  const committed: { hotel_id: string; name: string; action: string }[] = [];
  try {
    const writes: Wire[] = [];
    for (const l of b.leads) {
      const fields = { ...(l.fields ?? {}) };
      if (l.action === "insert") {
        const id = crypto.randomUUID();
        writes.push(writeUserFields(blankRow(db, id), { ...fields, name: l.name, city: l.city, country: l.country, locality: l.locality }));
        inserted += 1;
        committed.push({ hotel_id: id, name: l.name, action: "inserted" });
      } else {
        writes.push(writeUserFields(db.rows.get(l.matchHotelId)!, fields));
        merged += 1;
        committed.push({ hotel_id: l.matchHotelId, name: l.name, action: "merged" });
      }
    }
    for (const w of writes) putRow(db, w); // whole batch or nothing
  } catch (e) {
    return detail(400, (e as Error).message);
  }
  return json({ run_id: runId(), inserted, merged, committed });
}

function marketRows(db: Db, city: string, country?: string | null, segment?: string | null, locality?: string | null): Wire[] {
  const eq = (a: unknown, b: string) => String(a ?? "").toLowerCase() === b.toLowerCase();
  return [...db.rows.values()]
    .filter((r) => eq(r.city, city))
    .filter((r) => !country || eq(r.country, country))
    .filter((r) => !segment || r.segment == null || String(r.segment).toLowerCase().includes(segment.toLowerCase()))
    .filter((r) => !locality || eq(r.locality, locality))
    .sort(keysDesc);
}

function leadsExport(db: Db, url: URL) {
  const p = url.searchParams;
  const city = p.get("city");
  if (!city) return json({ detail: [{ type: "missing", loc: ["query", "city"], msg: "Field required" }] }, 422);
  const ids = (p.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const rows = ids.length
    ? ids.map((id) => db.rows.get(id)).filter((r): r is Wire => Boolean(r))
    : marketRows(db, city, p.get("country"), p.get("segment"), p.get("locality"));
  const slug = ids.length ? "selection" : city.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "market";
  return new Response(hotelsToTemplateCsv(rows), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="kh-leads-${slug}.csv"` },
  });
}

// ═══ hotels ════════════════════════════════════════════════════════════════════

async function hotelsByIds(db: Db, req: Request) {
  const b = await body(req);
  if (!Array.isArray(b.ids)) return invalid("ids must be a list");
  const ids = [...new Set(b.ids as string[])].filter(isUuid).slice(0, 2000);
  return json({ hotels: ids.map((id) => db.rows.get(id)).filter(Boolean) });
}

async function hotelsDelete(db: Db, req: Request) {
  const b = await body(req);
  if (!Array.isArray(b.ids)) return invalid("ids must be a list");
  if (b.ids.length === 0) return detail(400, "no hotel ids given");
  for (const id of b.ids) if (!isUuid(id)) return detail(400, `malformed hotel id: '${id}'`);
  const deleted = deleteRows(db, b.ids);
  return json({ deleted, count: deleted.length });
}

const EDITABLE_FIELDS = ["name", "key_count", "segment", "owner_name", "owner_type", "brand", "residence_count", "official_website"];

async function editField(db: Db, req: Request, id: string) {
  const b = await body(req);
  if (typeof b.field !== "string" || !("value" in b)) return invalid("field and value are required");
  let value = b.value;
  if (!EDITABLE_FIELDS.includes(b.field)) return detail(400, `field '${b.field}' is not editable`);
  if (value == null || (typeof value === "string" && !value.trim())) return detail(400, `field '${b.field}' cannot be cleared`);
  if (b.field === "owner_type" && !OWNER_TYPES.includes(value))
    return detail(400, `owner_type must be one of ${JSON.stringify([...OWNER_TYPES].sort())}`);
  if (b.field === "key_count") {
    const n = typeof value === "number" ? value : Number(String(value).trim());
    if (!Number.isInteger(n)) return detail(400, `invalid literal for int() with base 10: '${value}'`);
    if (n < 0 || n > 2_147_483_647) return detail(400, `key_count out of range for int4: ${n}`);
    value = n;
  }
  const row = db.rows.get(id);
  if (!row) return detail(404, "hotel not found");
  const next = writeUserFields(row, { [b.field]: value });
  putRow(db, next);
  return json({ hotel: next });
}

async function editContacts(db: Db, req: Request, id: string) {
  const b = await body(req);
  if (!Array.isArray(b.userContacts)) return invalid("userContacts must be a list");
  const row = db.rows.get(id);
  if (!row) return detail(404, "hotel not found");
  const apollo = new Set((row.ownerContacts ?? []).filter((c: any) => (c.source ?? "apollo") === "apollo").map((c: any) => c.id));
  for (const e of b.userContacts) if (e && apollo.has(e.id)) return detail(400, `contact '${e.id}' is Apollo-sourced and immutable`);
  const next = { ...row, userContacts: b.userContacts, updatedAt: nowIso() };
  putRow(db, next);
  return json({ hotel: next });
}

// ═══ chat ══════════════════════════════════════════════════════════════════════

export function findChatEntry(text: string): ChatEntry | null {
  const t = fold(text);
  if (!t) return null;
  for (const e of CHAT) {
    if (fold(e.question) === t) return e;
    for (const m of e.match ?? []) {
      const fm = fold(m);
      if (fm && (fm === t || ` ${t} `.includes(` ${fm} `))) return e;
    }
  }
  return null;
}

// The suggestion chips for the assistant rail: the recorded questions for the markets on screen,
// plus the cross-market ones.
export function demoSuggestions(cities: (string | null | undefined)[]): string[] {
  const on = new Set(cities.filter(Boolean).map((c) => fold(c)));
  return CHAT.filter((e) => !e.city || on.has(fold(e.city))).map((e) => e.question);
}

// A plain place search ("Lecce", "hotels in Yas Island") — the market/plan route. Anything with
// more words than a place + search filler is NOT treated as a search (the real router is an LLM;
// a question that merely mentions a city must not wipe the set).
const FILLER = new Set("show me find search for the all hotels hotel properties property in around near market markets list load open go to of a please".split(" "));
function detectPlace(db: Db, text: string): { city: string; country: string; locality: string | null } | null {
  const t = fold(text);
  const tryPlace = (name: string) => {
    const f = fold(name);
    if (!f || !` ${t} `.includes(` ${f} `)) return false;
    return ` ${t} `.replace(` ${f} `, " ").trim().split(" ").filter((w) => w && !FILLER.has(w)).length === 0;
  };
  for (const l of localityCandidates(db)) {
    if (tryPlace(l.cand.label)) return { city: l.city, country: countryOf(db, l.city), locality: l.cand.label };
  }
  for (const city of DEMO_CITIES) if (tryPlace(city)) return { city, country: countryOf(db, city), locality: null };
  return null;
}

function countryOf(db: Db, city: string): string {
  const ctx = db.areas[city]?.geocode?.[0]?.context ?? "";
  return ctx.split(",").pop()?.trim() || "";
}

// Model-like token deltas: a couple of words at a time.
function tokens(text: string): string[] {
  return text.match(/\S+\s*|\s+/g)?.reduce<string[]>((acc, w, i) => {
    if (i % 2 === 0) acc.push(w);
    else acc[acc.length - 1] += w;
    return acc;
  }, []) ?? [];
}

async function* chatStream(db: Db, text: string, liveSet: any): AsyncGenerator<Frame> {
  await sleep(700); // the router's classify call
  const entry = findChatEntry(text);
  if (entry) {
    const rows = (entry.hotelIds ?? []).map((id) => db.rows.get(id)).filter((r): r is Wire => Boolean(r));
    if (entry.kind === "lookup") {
      yield { type: "route", intent: "lookup" };
      await sleep(900);
      yield { type: "lookup_result", shape: "list", answer: entry.answer, sql: "-- recorded demo answer", hotels: rows };
      // the result rows land in the table
      if (rows.length) yield { type: "hotels", universeCount: rows.length, hotels: rows };
      yield { type: "done" };
      return;
    }
    yield { type: "route", intent: "ask" };
    for (const tk of tokens(entry.answer)) {
      yield { type: "token", text: tk };
      await sleep(35);
    }
    // the hotels the answer is about: select the ones on screen
    const onScreen = new Set<string>((liveSet?.rows ?? []).map((r: any) => r.id));
    const ids = rows.map((r) => r.id).filter((id) => onScreen.has(id));
    if (ids.length) {
      yield {
        type: "act", reply: `Selected ${ids.length} hotel${ids.length === 1 ? "" : "s"}.`,
        operations: [{ type: "setSelection", ids }], stagedAction: null,
      };
    }
    yield { type: "done" };
    return;
  }

  const place = detectPlace(db, text);
  if (place) {
    yield { type: "route", intent: "plan" };
    const universe = { city: place.city, country: place.country, segment: null, locality: place.locality };
    yield {
      type: "plan", universe, cheapFilters: [],
      predicates: [{ term: place.city, resolvesTo: "Sets the search area", costTier: "free" }],
      steps: [{ idx: 1, name: `Find hotels in ${place.city}`, note: "Broad sweep — defines the universe to filter down from", costTier: "free" }],
    };
    await sleep(600);
    const rows = marketRows(db, place.city, null, null, place.locality);
    if (!rows.length) {
      yield { type: "done", fromMemory: false, message: `No stored hotels for ${place.city} — search that area on the map to scan it.` };
      return;
    }
    yield { type: "status", stageIdx: 1, message: "Loaded from memory" };
    yield { type: "hotels", universeCount: rows.length, hotels: rows };
    yield { type: "done", fromMemory: true };
    return;
  }

  yield { type: "route", intent: "other" };
  for (const tk of tokens(OFF_SCRIPT_REPLY)) {
    yield { type: "token", text: tk };
    await sleep(30);
  }
  yield { type: "done" };
}

async function chat(db: Db, req: Request) {
  const b = await body(req);
  if (typeof b.text !== "string") return invalid("text is required");
  return sse(chatStream(db, b.text, b.liveSet ?? null));
}

// ═══ router ════════════════════════════════════════════════════════════════════

export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const m = req.method.toUpperCase();
  try {
    if (path === "/health" && m === "GET") return json({ status: "ok" });
    const db = await loadDb();
    if (m === "POST" && path === "/api/registry/preview") return await registryPreview(db, req);
    if (m === "POST" && path === "/api/registry/search") return await registrySearch(db, req);
    if (m === "POST" && path === "/api/registry/review") return await registryReview(db, req);
    if (m === "POST" && path === "/api/registry/review/decide") return await registryDecide(db, req);
    if (m === "GET" && path === "/api/enrich/active") return json({ active: false });
    if (m === "POST" && path === "/api/enrich/job") return await enrichJob(db, req);
    if (m === "POST" && path === "/api/outreach/job") return await outreachJob(db, req);
    if (m === "POST" && path === "/api/outreach/export") return await outreachExport(db, req);
    let hit = path.match(/^\/api\/outreach\/([^/]+)$/);
    if (m === "PATCH" && hit) return await outreachEdit(db, req, decodeURIComponent(hit[1]));
    if (m === "GET" && path === "/api/settings/outreach") return json(getSettings(db));
    if (m === "PUT" && path === "/api/settings/outreach") return await putOutreachSettings(db, req);
    if (m === "GET" && path === "/api/settings/teaser") return json({ teaser: await teaserMeta() });
    if (m === "POST" && path === "/api/settings/teaser") return await postTeaser(req);
    if (m === "GET" && path === "/api/settings/teaser/file") return await teaserFile(url);
    if (m === "POST" && path === "/api/leads/parse") return await leadsParse(db, req);
    if (m === "POST" && path === "/api/leads/commit") return await leadsCommit(db, req);
    if (m === "GET" && path === "/api/leads/export") return leadsExport(db, url);
    if (m === "POST" && path === "/api/hotels/by-ids") return await hotelsByIds(db, req);
    if (m === "POST" && path === "/api/hotels/delete") return await hotelsDelete(db, req);
    hit = path.match(/^\/api\/hotels\/([^/]+)\/fields$/);
    if (m === "PATCH" && hit) return await editField(db, req, decodeURIComponent(hit[1]));
    hit = path.match(/^\/api\/hotels\/([^/]+)\/contacts$/);
    if (m === "PUT" && hit) return await editContacts(db, req, decodeURIComponent(hit[1]));
    if (m === "POST" && path === "/api/chat") return await chat(db, req);
    return detail(404, "Not Found");
  } catch (e) {
    if (e instanceof Invalid) return invalid(e.message);
    return detail(500, `demo server error: ${(e as Error).message}`);
  }
}

// A fetch that answers `/api/*` and `/health` on `origin` itself and passes everything else on.
export function demoFetch(realFetch: typeof fetch, origin: string): typeof fetch {
  fetchStatic = (path) => realFetch(new URL(path, origin).href);
  return async (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, origin);
    if (url.origin === new URL(origin).origin && (url.pathname.startsWith("/api/") || url.pathname === "/health")) {
      const req = input instanceof Request ? new Request(input, init) : new Request(url.href, init);
      return handle(req);
    }
    return realFetch(input, init);
  };
}

export function installDemoServer(): void {
  window.fetch = demoFetch(window.fetch.bind(window), window.location.origin);
  void loadDb(); // start parsing the data while the map loads
}

// "Reset demo": drop every change (the demo store + the app's own working-set keys) and reload.
export function resetDemo(): void {
  for (const k of [STORAGE_KEY, "kh_workbench_snapshot", "kh_tour_muted"]) {
    try { localStorage.removeItem(k); } catch { /* storage blocked */ }
  }
  try { sessionStorage.removeItem("kh_session_id"); } catch { /* storage blocked */ }
  window.location.reload();
}
