// The demo's in-memory "database": seeded from the bundled JSON (src/demo/data), with every user
// mutation (edits, deletes, review decisions, outreach edits, settings, committed leads, replayed
// enrichment) written through to localStorage under one key so it survives a reload. "Reset demo"
// clears that key.
//
// The data files load lazily (dynamic import → their own chunks) on the first /api call, so the
// app shell and map render before ~4 MB of JSON is parsed.

import chatEntries from "./data/chat.json";

export const STORAGE_KEY = "cognitidata_demo_state";

export type Wire = Record<string, any> & { id: string; name: string };
export type Place = {
  gers_id: string; name: string | null; lat: number; lng: number; category: string | null;
  brand: string | null; websites: string[] | null; phones: string[] | null; emails: string[] | null;
  socials: string[] | null; address: string | null; locality: string | null; country: string | null;
  band: string | null; review_reason: string | null; review_detail: string | null; vanished_at: string | null;
};
export type ChatEntry = {
  id: string; question: string; match?: string[] | null; kind: "ask" | "lookup";
  answer: string; hotelIds?: string[] | null; city?: string | null;
};
export type Area = { bbox: [number, number, number, number]; geocode: any[] };

type Persisted = {
  v: 1;
  rows: Record<string, Wire>; // full current row for every hotel a user action touched (or added)
  deleted: string[];
  places: Record<string, Partial<Place>>; // review-decision overrides on registry places
  aliases: [string, string][]; // human merges (alias → canonical)
  settings: { right_to_win: string; copy_prompt: string } | null;
};

export const CHAT: ChatEntry[] = chatEntries as ChatEntry[];

// The fields a withheld row starts without (owner research + its contacts phase, and reviews).
const OWNER_FIELDS = [
  "ownerName", "ownerType", "ownerEmail", "ownerPhone", "ownerLinkedin", "ownerReachVia",
  "ownerContacts", "ownerResearch", "ownerSources", "ownerConf", "ownerAttemptedAt",
];
const REVIEW_FIELDS = [
  "starRating", "bookingRating", "bookingReviews", "reviewThemes", "reviewSummary",
  "roomCategories", "reviewSources", "reviewsAttemptedAt",
];

export type Db = {
  original: Map<string, Wire>; // the recorded results — what an enrichment replay plays back
  rows: Map<string, Wire>; // current state, insertion order = data order
  places: Place[];
  placeById: Map<string, Place>;
  coveredCells: Set<string>;
  areas: Record<string, Area>;
  defaultSettings: { right_to_win: string; copy_prompt: string };
  persisted: Persisted;
};

let dbPromise: Promise<Db> | null = null;

export function loadDb(): Promise<Db> {
  dbPromise ??= seed();
  return dbPromise;
}

// Tests reset between cases.
export function resetDbForTests(): void {
  dbPromise = null;
}

function readPersisted(): Persisted {
  const empty: Persisted = { v: 1, rows: {}, deleted: [], places: {}, aliases: [], settings: null };
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const p = JSON.parse(raw);
    return p && p.v === 1 ? { ...empty, ...p } : empty;
  } catch {
    return empty;
  }
}

export function persist(db: Db): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(db.persisted));
  } catch {
    /* storage full or blocked — the session keeps working in memory */
  }
}

// FNV-1a — a stable pick of which rows start "not researched yet".
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

async function seed(): Promise<Db> {
  const [hotels, outreach, places, areas, cells, settings] = await Promise.all([
    import("./data/hotels.json").then((m) => m.default as unknown as Wire[]),
    import("./data/outreach.json").then((m) => m.default as unknown as Record<string, any>),
    import("./data/places.json").then((m) => m.default as unknown as Place[]),
    import("./data/areas.json").then((m) => m.default as unknown as Record<string, Area>),
    import("./data/cells.json").then((m) => m.default as unknown as { cell_id: string }[]),
    // stored as the settings table's rows ({text}); the endpoint serves the flattened text
    import("./data/settings.json").then((m) => {
      const t = (v: any): string => (typeof v === "string" ? v : v?.text ?? "");
      const raw = m.default as Record<string, unknown>;
      return { right_to_win: t(raw.right_to_win), copy_prompt: t(raw.copy_prompt) };
    }),
  ]);
  const persisted = readPersisted();

  // Rows a recorded chat answer or an outreach package points at keep their stored research, so
  // those answers and the review room stay consistent with the table.
  const referenced = new Set<string>(Object.keys(outreach));
  for (const e of CHAT) for (const id of e.hotelIds ?? []) referenced.add(id);

  const original = new Map<string, Wire>();
  const rows = new Map<string, Wire>();
  const deleted = new Set(persisted.deleted);
  for (const h of hotels) {
    const rec: Wire = { ...h, outreach: outreach[h.id] ?? h.outreach ?? null };
    original.set(h.id, rec);
    if (deleted.has(h.id)) continue;
    // Roughly one in four fully researched rows starts as "not researched yet", so running
    // enrichment on them replays their recorded owner, contacts and reviews live.
    const withhold = !referenced.has(h.id) && rec.ownerName && rec.ownerResearch && hash(h.id) % 4 === 0;
    let row = rec;
    if (withhold) {
      row = { ...rec };
      for (const f of [...OWNER_FIELDS, ...REVIEW_FIELDS]) row[f] = null;
    }
    rows.set(h.id, persisted.rows[h.id] ?? row);
  }
  // rows a user added (committed leads) live only in the persisted overrides
  for (const [id, r] of Object.entries(persisted.rows)) {
    if (!rows.has(id) && !deleted.has(id)) rows.set(id, r);
  }

  const placeList = places.map((p) => ({ ...p, ...(persisted.places[p.gers_id] ?? {}) }) as Place);
  return {
    original,
    rows,
    places: placeList,
    placeById: new Map(placeList.map((p) => [p.gers_id, p])),
    coveredCells: new Set(cells.map((c) => c.cell_id)),
    areas,
    defaultSettings: settings,
    persisted,
  };
}

// ── write helpers (each persists) ────────────────────────────────────────────
export function putRow(db: Db, row: Wire): void {
  db.rows.set(row.id, row);
  db.persisted.rows[row.id] = row;
  persist(db);
}

export function deleteRows(db: Db, ids: string[]): string[] {
  const gone = ids.filter((id) => db.rows.has(id));
  for (const id of gone) {
    db.rows.delete(id);
    delete db.persisted.rows[id];
    if (!db.persisted.deleted.includes(id)) db.persisted.deleted.push(id);
  }
  persist(db);
  return gone;
}

export function patchPlace(db: Db, gersId: string, patch: Partial<Place>): void {
  const p = db.placeById.get(gersId);
  if (p) Object.assign(p, patch);
  db.persisted.places[gersId] = { ...(db.persisted.places[gersId] ?? {}), ...patch };
  persist(db);
}

export function addAlias(db: Db, alias: string, canonical: string): void {
  if (!db.persisted.aliases.some(([a]) => a === alias)) db.persisted.aliases.push([alias, canonical]);
  persist(db);
}

export function getSettings(db: Db) {
  return db.persisted.settings ?? db.defaultSettings;
}

export function putSettings(db: Db, s: { right_to_win: string; copy_prompt: string }): void {
  db.persisted.settings = s;
  persist(db);
}

// ── the teaser PDF (ADR-126) ──────────────────────────────────────────────────
// The default teaser is the static file named in the theme; an upload replaces it for this browser session
// only (kept in memory as an object URL, not persisted).
export type TeaserMeta = { filename: string; size: number; uploaded_at: string };
let uploaded: { meta: TeaserMeta; bytes: Uint8Array; url: string | null } | null = null;

// Which file is the teaser comes from the theme (--teaser-pdf in public/theme.css).
export function defaultTeaserUrl(): string {
  const v = typeof document === "undefined" ? "" :
    getComputedStyle(document.documentElement).getPropertyValue("--teaser-pdf").trim().replace(/^["']|["']$/g, "");
  return import.meta.env.BASE_URL + (v || "teaser.pdf").replace(/^\//, "");
}

export function uploadedTeaser() {
  return uploaded;
}

export function setUploadedTeaser(meta: TeaserMeta, bytes: Uint8Array): void {
  if (uploaded?.url) URL.revokeObjectURL(uploaded.url);
  let url: string | null = null;
  try {
    url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
  } catch {
    url = null; // non-browser (tests)
  }
  uploaded = { meta, bytes, url };
}

export function clearUploadedTeaserForTests(): void {
  uploaded = null;
}

// What api.ts's teaser URL helpers return: an <a href>/<iframe src> can't go through the patched
// fetch, so they point straight at the static file (or the uploaded blob).
export function teaserUrl(): string {
  return uploaded?.url ?? defaultTeaserUrl();
}
