import { apiUrl, withSession } from "./api";
import { streamSSE } from "./chat_stream";

// Registry discovery (ADR-079 map-first): the pure logic behind the map-first flow —
// suggestion/facts preview calls, the confirm card's wording, bbox-handle math, pin-state
// derivation, progress-frame reduction, and the SSE runner for POST /api/registry/search
// (shared contract with the backend, built in parallel — do not deviate from the wire
// shapes here). Kept React/maplibre-free so it's unit-testable.

// 30 km radius = 60 km across — the same cap as a drawn area's edge (_AREA_MAX_EDGE_KM). The
// 1 km floor: the scan works in ~28 km cells, so a smaller pin costs no less, it only shows
// fewer hotels.
export const MIN_RADIUS_KM = 1;
export const MAX_RADIUS_KM = 30;
export const DEFAULT_RADIUS_KM = 3;

// The slider is logarithmic: city-scale radii (1–6 km) get the first half of the track,
// the large ones the rest. Positions are 0..SLIDER_STEPS.
export const SLIDER_STEPS = 100;
const LOG_SPAN = Math.log(MAX_RADIUS_KM / MIN_RADIUS_KM);

export function sliderToKm(pos: number): number {
  const km = MIN_RADIUS_KM * Math.exp((pos / SLIDER_STEPS) * LOG_SPAN);
  const rounded = km < 10 ? Math.round(km * 2) / 2 : Math.round(km);
  return Math.min(MAX_RADIUS_KM, Math.max(MIN_RADIUS_KM, rounded));
}

export function kmToSlider(km: number): number {
  const c = Math.min(MAX_RADIUS_KM, Math.max(MIN_RADIUS_KM, km));
  return Math.round((Math.log(c / MIN_RADIUS_KM) / LOG_SPAN) * SLIDER_STEPS);
}

// The circle's size as the user sees it on the map: its width.
export const radiusLabel = (km: number): string => {
  const across = km * 2;
  return `${Number.isInteger(across) ? across : across.toFixed(1)} km across`;
};

export type ScanParams = { lat: number; lng: number; radiusKm: number; label: string };
// Area mode (map-first): the confirmed bbox (plus the polygon when the suggestion carried one).
export type BBox = [number, number, number, number]; // [w, s, e, n]
export type AreaParams = { bbox: BBox; label: string; polygon: GeoJSON.Geometry | null };
export type SearchParams = ScanParams | AreaParams;
const isArea = (p: SearchParams): p is AreaParams => "bbox" in p;

export const clampRadius = (km: number): number =>
  Number.isFinite(km) ? Math.min(MAX_RADIUS_KM, Math.max(MIN_RADIUS_KM, km)) : DEFAULT_RADIUS_KM;

// A dropped pin needs a non-empty area name (it becomes the market label on the resulting
// rows) — mirrors the server's 422 validation.
export const canScan = (pin: { lng: number; lat: number } | null, label: string): boolean =>
  pin != null && label.trim().length > 0;

// The visible radius ring around the pin, as a GeoJSON polygon for a maplibre fill/line
// source. Equirectangular approximation on a 6371 km sphere — plenty at the 30 km cap.
const KM_PER_DEG_LAT = (Math.PI * 6371) / 180;
export function circlePolygon(lng: number, lat: number, radiusKm: number, steps = 64) {
  const dLat = radiusKm / KM_PER_DEG_LAT;
  const dLng = radiusKm / (KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
  const ring: [number, number][] = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    ring.push([lng + dLng * Math.cos(t), lat + dLat * Math.sin(t)]);
  }
  ring.push([...ring[0]]); // close the ring exactly (no float drift)
  return {
    type: "Feature" as const,
    properties: {},
    geometry: { type: "Polygon" as const, coordinates: [ring] },
  };
}

// The pin's circle as a bbox — what the facts preview is asked about in pin mode.
export function circleBbox(lng: number, lat: number, radiusKm: number): BBox {
  const dLat = radiusKm / KM_PER_DEG_LAT;
  const dLng = radiusKm / (KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}

// ── preview (shared contract: POST /api/registry/preview, two body modes) ───
export type Candidate = {
  label: string;
  context: string;
  lat: number;
  lng: number;
  bbox: BBox;
  polygon: GeoJSON.Geometry | null;
};
export type PreviewFacts = {
  cells_total: number;
  cells_fresh: number;
  known_places: number;
  est_seconds: number; // 0 = ready now
};

async function postPreview<T>(body: unknown): Promise<T> {
  const res = await fetch(apiUrl("/api/registry/preview"), {
    method: "POST",
    headers: withSession({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Preview failed (${res.status}).`);
  return (await res.json()) as T;
}

export const previewQuery = async (query: string): Promise<Candidate[]> =>
  (await postPreview<{ candidates: Candidate[] }>({ query })).candidates;

export const previewBbox = (bbox: BBox): Promise<PreviewFacts> => postPreview<PreviewFacts>({ bbox });

// The confirm card shows NO wait-estimate or hotel-count line — the pre-scan numbers set the
// wrong expectation (est is a rough guess; the count is unverified Overture places), so we
// don't surface them at all. `est_seconds` is still fetched (previewBbox) and used only to pace
// the finding bar during the scan; it is never shown as a recommendation.

// ── bbox corner-handle math (the confirm screen's drag handles) ──────────────
export type Corner = "nw" | "ne" | "sw" | "se";
export function dragCorner(bbox: BBox, corner: Corner, lng: number, lat: number): BBox {
  let [w, s, e, n] = bbox;
  if (corner === "nw" || corner === "sw") w = lng;
  if (corner === "ne" || corner === "se") e = lng;
  if (corner === "nw" || corner === "ne") n = lat;
  if (corner === "sw" || corner === "se") s = lat;
  // A handle dragged past its opposite edge swaps roles — the bbox stays normalized.
  return [Math.min(w, e), Math.min(s, n), Math.max(w, e), Math.max(s, n)];
}

export const cornerPos = (bbox: BBox, corner: Corner): [number, number] => {
  const [w, s, e, n] = bbox;
  return corner === "nw" ? [w, n] : corner === "ne" ? [e, n] : corner === "sw" ? [w, s] : [e, s];
};

// ── pin-state derivation (map pins mirror the client's three-state classify) ─
// faded  = confirmed-fail against the current filters (greyed row);
// hollow = not confirmed yet — unmeasured for the filter, or owner not researched;
// solid  = passes the filters AND has been researched;
// review = a held-back review-band row (ADR-083) — a hollow amber ◌, not part of the served set.
export type PinState = "solid" | "hollow" | "faded" | "review";
export function pinState(state: "pass" | "unknown" | "fail", researched: boolean): PinState {
  if (state === "fail") return "faded";
  if (state === "unknown" || !researched) return "hollow";
  return "solid";
}

// "Researched" for pin/status purposes: an owner on file, or an owner hunt that already ran.
export const ownerResearched = (r: {
  ownerName: string | null;
  ownerAttemptedAt?: string | null;
}): boolean => r.ownerName != null || r.ownerAttemptedAt != null;

// ── the calm list's one plain-word status sentence per row ──────────────────
// ("Possibly closed" is deliberately absent — no wire field carries it yet.)
export function statusSentence(
  r: { ownerName: string | null; ownerType: string | null; ownerAttemptedAt?: string | null },
  researching = false,
): string {
  if (researching) return "Researching owner…";
  if (r.ownerName) return r.ownerType ? `${r.ownerType} · ${r.ownerName}` : r.ownerName;
  if (r.ownerAttemptedAt) return r.ownerType ? `${r.ownerType} · no owner found` : "No owner found";
  return r.ownerType ? `${r.ownerType} · owner not researched yet` : "Not researched yet";
}

// ── progress-frame reduction (the finding strip's counter) ──────────────────
export type Progress = { found: number; cellsDone: number; cellsTotal: number };
export function reduceProgress(
  prev: Progress | null,
  f: { found: number; cells_done: number; cells_total: number },
): Progress {
  // `found` is cumulative per the contract — never let a late/out-of-order frame tick it down.
  return {
    found: Math.max(prev?.found ?? 0, f.found),
    cellsDone: Math.max(prev?.cellsDone ?? 0, f.cells_done),
    cellsTotal: f.cells_total > 0 ? f.cells_total : prev?.cellsTotal ?? 0,
  };
}

// ── map reset control (feedback #2) ──────────────────────────────────────────
// The ◎ button's target is state-dependent: ask → the initial world view; confirm →
// re-center the chosen area; work → frame every pin (falling back to the area, then
// the world, when there's nothing to frame). Pure so the targeting logic is testable.
export const WORLD_VIEW = { center: [20, 22] as [number, number], zoom: 1.6 };

export type ResetTarget = { kind: "world" } | { kind: "bounds"; bbox: BBox };

export function pinsBbox(pins: { lng: number; lat: number }[]): BBox | null {
  if (pins.length === 0) return null;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of pins) {
    w = Math.min(w, p.lng);
    e = Math.max(e, p.lng);
    s = Math.min(s, p.lat);
    n = Math.max(n, p.lat);
  }
  return [w, s, e, n];
}

export function resetViewTarget(
  phase: "home" | "work",
  areaBox: BBox | null,
  pins: { lng: number; lat: number }[],
): ResetTarget {
  if (phase === "work") {
    const pb = pinsBbox(pins);
    if (pb) return { kind: "bounds", bbox: pb };
  }
  return areaBox ? { kind: "bounds", bbox: areaBox } : { kind: "world" };
}

// ── the dossier's Google Maps link (feedback #11) ─────────────────────────────
// Prefer a "<name>, <city>" text query so Maps resolves the *labelled* place even when the
// stored coordinates are slightly off (a coordinate pin never resolves to the business, so a
// small error lands on empty map). Fall back to raw lat,lng only when no name is on file — a
// bare city query is worse than the coordinates.
export const googleMapsUrl = (
  lat: number,
  lng: number,
  name?: string | null,
  place?: string | null,
): string => {
  const label = name?.trim();
  const query = label
    ? encodeURIComponent([label, place?.trim()].filter(Boolean).join(", "))
    : `${lat},${lng}`;
  return `https://www.google.com/maps/search/?api=1&query=${query}`;
};

// ── the finding bar (hybrid time+signal progress) ─────────────────────────────
// A fresh scan front-loads ONE combined S3 fetch before any per-cell `progress` frame
// arrives — cells_done/cells_total sits at 0 for most of the wall time, then jumps. A bar
// driven purely by frames would be dishonest, so it's hybrid: TIME eases it toward 85%
// over the preview's est_seconds (never further on time alone); real frames map
// cells_done/cells_total onto the 85–98% band; merging only ever snaps FORWARD.
// `done` ends the strip (→100%) as before. All pure, so the targeting is testable.
export const BAR_TIME_CAP = 85; // % reachable on time alone
export const BAR_FRAME_CAP = 98; // % reachable on frames — only done gets 100
export const DEFAULT_EXPECTED_SECONDS = 60; // fallback when no preview estimate exists

// Ease-out over the expected duration: fast early, slow late, capped at BAR_TIME_CAP.
export function timeProgress(elapsedSec: number, expectedSec: number): number {
  const total = expectedSec > 0 ? expectedSec : DEFAULT_EXPECTED_SECONDS;
  const t = Math.min(1, Math.max(0, elapsedSec) / total);
  return BAR_TIME_CAP * (1 - (1 - t) * (1 - t));
}

// A real progress frame's position on the 85–98 band (null when cells_total is unknown).
export function cellProgress(cellsDone: number, cellsTotal: number): number | null {
  if (cellsTotal <= 0) return null;
  const frac = Math.min(1, Math.max(0, cellsDone / cellsTotal));
  return BAR_TIME_CAP + (BAR_FRAME_CAP - BAR_TIME_CAP) * frac;
}

// Snap-forward merge: the bar never moves backward, and never passes 98 before done.
export function mergeBarProgress(prevPct: number, timePct: number, framePct: number | null): number {
  return Math.min(BAR_FRAME_CAP, Math.max(prevPct, timePct, framePct ?? 0));
}

// ── suggestion-list keyboard nav (arrow keys wrap; -1 = nothing active) ──────
export function moveActive(count: number, active: number, delta: 1 | -1): number {
  if (count === 0) return -1;
  if (active < 0) return delta === 1 ? 0 : count - 1;
  return (active + delta + count) % count;
}

// ── wire frames (shared contract) ────────────────────────────────────────────
// Terminal done frame — `hotels` is the full set, `market` echoes the label. Generic over the
// hotel wire shape: it's exactly what typed search returns, and that type lives with its
// consumer (Workbench), not here.
export type RegistryDone<H> = {
  type: "done";
  market: string;
  status: string;
  unique_count: number;
  query_count: number;
  narrowing_suggestions: string[];
  hotels: H[];
};

export type ProgressFrame = { type: "progress"; found: number; cells_done: number; cells_total: number };

type RegistryFrame<H> =
  | { type: "status"; message: string }
  | { type: "hotels"; hotels: H[] }
  | ProgressFrame
  | RegistryDone<H>
  | { type: "error"; message: string }
  // ADR-027: the background auto-enrich (keys/facts) pass runs after the set lands, on the same
  // stream — 0..n enriched frames patch a row's freshly-measured fields live; enriching/enrich_done
  // bracket the run. Without these handlers the key counts written to the DB never surface until a
  // second search re-reads them.
  | { type: "enriching"; count: number }
  | { type: "enriched"; hotel_id: string; fields: Record<string, unknown> }
  // `attempted` = the ids the facts pass ran on (stamped factsAttemptedAt so an empty field reads
  // "none found", not "enrich"). On error the backend omits it — a cut-short pass claims no ids.
  | { type: "enrich_done"; count: number; error?: boolean; attempted: string[] }
  // ADR-084: brand-affiliation classification runs after the set lands — 0..n classified
  // frames update rows live; classifying/classify_done bracket the run for an in-flight signal.
  // `attempted` = the ids classified (omitted on error, same rationale as enrich_done).
  | { type: "classifying"; count: number }
  | { type: "classified"; hotel_id: string; brandAffiliation: string; brandClean?: string | null }
  | { type: "classify_done"; count: number; error?: boolean; attempted?: string[] };

export type RegistryHandlers<H> = {
  onStatus: (message: string) => void; // 0..n progress lines (scans can run 30s–3min)
  onProgress?: (p: ProgressFrame) => void; // 0..n cumulative counters (drives the finding strip)
  onHotels: (hotels: H[]) => void; // 0..n incremental sets — handled like typed search's
  onDone: (done: RegistryDone<H>) => void; // terminal: land the rows + unlock
  onError: (message: string) => void; // terminal (frame, HTTP failure, or transport): surface + unlock
  // ADR-027: optional — background auto-enrich progress/patches (mirrors the classify handlers)
  onEnriching?: (count: number) => void;
  onEnriched?: (p: { hotelId: string; fields: Record<string, unknown> }) => void;
  onEnrichDone?: (p: { count: number; error?: boolean; attempted?: string[] }) => void;
  // ADR-084: optional — background classification progress/patches, mirrors onProgress/onHotels
  onClassifying?: (count: number) => void;
  onClassified?: (p: { hotelId: string; brandAffiliation: string; brandClean?: string | null }) => void;
  onClassifyDone?: (p: { count?: number; attempted?: string[] }) => void;
};

export async function runRegistrySearch<H>(
  params: SearchParams,
  handlers: RegistryHandlers<H>,
): Promise<void> {
  const body = isArea(params)
    ? { bbox: params.bbox, label: params.label, polygon: params.polygon }
    : { lat: params.lat, lng: params.lng, radius_km: params.radiusKm, label: params.label };
  await streamSSE<RegistryFrame<H>>(
    apiUrl("/api/registry/search"),
    body,
    (frame) => {
      switch (frame.type) {
        case "status":
          handlers.onStatus(frame.message);
          break;
        case "progress":
          handlers.onProgress?.(frame);
          break;
        case "hotels":
          handlers.onHotels(frame.hotels);
          break;
        case "done":
          handlers.onDone(frame);
          break;
        case "error":
          handlers.onError(frame.message);
          break;
        case "enriching":
          handlers.onEnriching?.(frame.count);
          break;
        case "enriched":
          handlers.onEnriched?.({ hotelId: frame.hotel_id, fields: frame.fields });
          break;
        case "enrich_done":
          handlers.onEnrichDone?.({ count: frame.count, error: frame.error, attempted: frame.attempted });
          break;
        case "classifying":
          handlers.onClassifying?.(frame.count);
          break;
        case "classified":
          handlers.onClassified?.({ hotelId: frame.hotel_id, brandAffiliation: frame.brandAffiliation, brandClean: frame.brandClean });
          break;
        case "classify_done":
          handlers.onClassifyDone?.({ attempted: frame.attempted });
          break;
      }
    },
    handlers.onError,
  );
}
