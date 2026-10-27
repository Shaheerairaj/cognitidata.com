// The fake backend, exercised through the frontend's own clients (streamSSE, runRegistrySearch,
// fetchReviewRows, the api.ts helpers) so these assert exactly the shapes the UI parses.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bulkDeleteHotels, editHotelField, fetchHotelsByIds, fetchTeaser, saveContacts, saveOutreachField,
} from "../api";
import { streamSSE } from "../chat_stream";
import { fetchReviewRows, postReviewDecision } from "../registry_review";
import { previewBbox, previewQuery, runRegistrySearch, type RegistryDone } from "../registry_search";
import { OFF_SCRIPT_REPLY, demoFetch, setDemoSpeed } from "./server";
import { CHAT, loadDb, type Wire } from "./store";
import areas from "./data/areas.json";

const ORIGIN = "http://demo.local";
const PUBLIC = resolve(process.cwd(), "public");
const realFetch = globalThis.fetch;

beforeAll(() => {
  setDemoSpeed(0);
  // the "network" behind the fake server: just the static files in public/
  const staticFetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    try {
      return new Response(readFileSync(resolve(PUBLIC, `.${url.pathname}`)));
    } catch {
      return new Response("not found", { status: 404 });
    }
  }) as typeof fetch;
  globalThis.fetch = demoFetch(staticFetch, ORIGIN);
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

type F = Record<string, any>;
async function frames(path: string, body: unknown): Promise<F[]> {
  const out: F[] = [];
  let fail: string | null = null;
  await streamSSE<F>(path, body, (f) => out.push(f), (m) => { fail = m; });
  if (fail) throw new Error(fail);
  return out;
}
const post = (path: string, body: unknown, method = "POST") =>
  fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const ad = (areas as Record<string, { bbox: number[]; geocode: any[] }>)["Abu Dhabi"].geocode[0];

describe("registry", () => {
  it("previews a demo city from the recorded geocoder output, and nothing else", async () => {
    const c = await previewQuery("abu");
    expect(c[0]).toMatchObject({ label: "Abu Dhabi", context: expect.any(String), bbox: expect.any(Array) });
    expect(c[0].polygon?.type).toBe("Polygon");
    expect(await previewQuery("Paris")).toEqual([]);
    expect((await previewQuery("yas")).map((x) => x.label)).toContain("Yas Island");
    expect((await post("/api/registry/preview", {})).status).toBe(422);
  });

  it("returns the real coverage stats for a bbox (covered → est 0)", async () => {
    const f = await previewBbox(ad.bbox);
    expect(f).toEqual({
      cells_total: expect.any(Number), cells_fresh: 0, known_places: expect.any(Number), est_seconds: 0,
    });
    expect(f.known_places).toBeGreaterThan(0);
  });

  it("serves the stored hotels inside an area (polygon applied)", async () => {
    let done: RegistryDone<Wire> | null = null;
    let err: string | null = null;
    await runRegistrySearch<Wire>({ bbox: ad.bbox, label: "Abu Dhabi", polygon: ad.polygon }, {
      onStatus: () => {}, onHotels: () => {}, onDone: (d) => { done = d; }, onError: (m) => { err = m; },
    });
    expect(err).toBeNull();
    const d = done as unknown as RegistryDone<Wire>;
    expect(d).toMatchObject({ type: "done", market: "Abu Dhabi", status: "ok", query_count: 0, narrowing_suggestions: [] });
    expect(d.hotels.length).toBeGreaterThan(50);
    expect(d.unique_count).toBe(d.hotels.length);
    expect(d.hotels.every((h) => h.lat != null && h.lng != null && h.id && "ownerName" in h)).toBe(true);
  });

  it("serves a pin radius, and says the demo's coverage for an empty area", async () => {
    let pin: RegistryDone<Wire> | null = null;
    await runRegistrySearch<Wire>({ lat: 45.65, lng: 13.77, radiusKm: 3, label: "Trieste" }, {
      onStatus: () => {}, onHotels: () => {}, onDone: (d) => { pin = d; }, onError: () => {},
    });
    expect((pin as unknown as RegistryDone<Wire>).hotels.length).toBeGreaterThan(5);

    const statuses: string[] = [];
    let empty: RegistryDone<Wire> | null = null;
    await runRegistrySearch<Wire>({ lat: 48.85, lng: 2.35, radiusKm: 3, label: "Paris" }, {
      onStatus: (m) => statuses.push(m), onHotels: () => {}, onDone: (d) => { empty = d; }, onError: () => {},
    });
    expect(statuses.join(" ")).toContain("This demo covers Abu Dhabi, Casablanca, Trieste and Lecce");
    expect((empty as unknown as RegistryDone<Wire>).hotels).toEqual([]);
  });

  it("rejects an area that is too large (422, like the real validator)", async () => {
    const big = (areas as Record<string, { geocode: any[] }>)["Abu Dhabi"].geocode[1];
    let err: string | null = null;
    await runRegistrySearch({ bbox: big.bbox, label: "x", polygon: null }, {
      onStatus: () => {}, onHotels: () => {}, onDone: () => {}, onError: (m) => { err = m; },
    });
    expect(err).toContain("422");
  });

  it("lists review rows and applies a decision", async () => {
    const params = { bbox: ad.bbox as [number, number, number, number], label: "Abu Dhabi", polygon: null };
    const rows = await fetchReviewRows(params);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ id: expect.any(String), name: expect.any(String), reason: expect.any(String) });
    const res = await postReviewDecision(rows[0], "keep");
    expect(res).toEqual({ results: [{ gers_id: rows[0].id, decision: "keep", ok: true }], twin_conflicts: [] });
    expect((await fetchReviewRows(params)).some((r) => r.id === rows[0].id)).toBe(false);
  });
});

describe("chat", () => {
  it("streams a recorded ask answer and selects its hotels on screen", async () => {
    const e = CHAT.find((x) => x.kind === "ask" && (x.hotelIds?.length ?? 0) > 0)!;
    const liveSet = { market: e.city, rows: e.hotelIds!.map((id) => ({ id })) };
    const f = await frames("/api/chat", { text: e.question.toUpperCase() + "!!", liveSet });
    expect(f[0]).toEqual({ type: "route", intent: "ask" });
    expect(f.filter((x) => x.type === "token").map((x) => x.text).join("")).toBe(e.answer);
    expect(f.find((x) => x.type === "act")?.operations[0].type).toBe("setSelection");
    expect(f.at(-1)).toEqual({ type: "done" });
  });

  it("answers a recorded lookup (by a match phrase) and lands its rows in the table", async () => {
    const e = CHAT.find((x) => x.kind === "lookup" && (x.hotelIds?.length ?? 0) > 0)!;
    const f = await frames("/api/chat", { text: e.match![0] });
    expect(f.map((x) => x.type)).toEqual(["route", "lookup_result", "hotels", "done"]);
    expect(f[1]).toMatchObject({ shape: "list", answer: e.answer });
    expect(f[2].hotels.length).toBeGreaterThan(0);
  });

  it("routes a place search like the real plan branch", async () => {
    const f = await frames("/api/chat", { text: "hotels in Lecce" });
    expect(f.map((x) => x.type)).toEqual(["route", "plan", "status", "hotels", "done"]);
    expect(f[0].intent).toBe("plan");
    expect(f[1].universe).toMatchObject({ city: "Lecce", country: "Italy" });
    expect(f[3].universeCount).toBe(f[3].hotels.length);
    expect(f[3].hotels.every((h: Wire) => h.city === "Lecce")).toBe(true);
    expect(f[4]).toEqual({ type: "done", fromMemory: true });
  });

  it("gives the demo reply to anything off-script", async () => {
    const f = await frames("/api/chat", { text: "What's the weather in Rome?" });
    expect(f[0]).toEqual({ type: "route", intent: "other" });
    expect(f.filter((x) => x.type === "token").map((x) => x.text).join("")).toBe(OFF_SCRIPT_REPLY);
  });
});

describe("enrichment replay", () => {
  it("replays recorded owner + contacts, and skips hotels with nothing recorded", async () => {
    const db = await loadDb();
    const withheld = [...db.rows.values()].find((r) => !r.ownerName && db.original.get(r.id)?.ownerName
      && db.original.get(r.id)?.ownerType !== "chain")!;
    const blank = [...db.rows.values()].find((r) => !db.original.get(r.id)?.ownerResearch
      && !db.original.get(r.id)?.ownerName && !db.original.get(r.id)?.ownerAttemptedAt)!;
    expect(withheld).toBeTruthy();
    const f = await frames("/api/enrich/job", {
      hotels: [withheld, blank].map((r) => ({ id: r.id, name: r.name, ownerName: r.ownerName, ownerType: r.ownerType })),
      kinds: ["owner"],
    });
    expect(f[0]).toEqual({ type: "phase", kind: "owner", count: 2 });
    const owner = f.find((x) => x.type === "enriched" && x.fields.owner);
    expect(owner).toMatchObject({ hotel_id: withheld.id, fields: { owner: { value: db.original.get(withheld.id)!.ownerName } } });
    expect(owner!.fields.ownerResearch.value).toHaveProperty("cast");
    expect(f.some((x) => x.type === "status" && x.hotel_id === blank.id && /not part of this demo/.test(x.message))).toBe(true);
    const done = f.at(-1)!;
    expect(done.type).toBe("done");
    expect(done.attempted.owner).toEqual([withheld.id]);
    expect(Object.keys(done.attempted).sort()).toEqual(["contacts", "facts", "owner", "reviews"]);
    // the replayed result sticks
    expect((await fetchHotelsByIds([withheld.id]))[0]).toMatchObject({ ownerName: db.original.get(withheld.id)!.ownerName });
  });

  it("replays recorded reviews", async () => {
    const db = await loadDb();
    const r = [...db.rows.values()].find((x) => x.bookingRating != null)!;
    const f = await frames("/api/enrich/job", { hotels: [{ id: r.id, name: r.name, reviewsAttemptedAt: null }], kinds: ["reviews"] });
    expect(f.find((x) => x.type === "enriched")?.fields.bookingRating.value).toBe(r.bookingRating);
    expect(f.at(-1)!.attempted.reviews).toEqual([r.id]);
  });

  it("422s an unknown kind; active is never running", async () => {
    expect((await post("/api/enrich/job", { hotels: [], kinds: ["facts"] })).status).toBe(422);
    expect(await (await fetch("/api/enrich/active")).json()).toEqual({ active: false });
  });
});

describe("outreach", () => {
  it("streams recorded packages, fails package-less hotels, merges edits and exports", async () => {
    const db = await loadDb();
    const withPkg = [...db.rows.values()].filter((r) => db.original.get(r.id)?.outreach).slice(0, 2);
    const without = [...db.rows.values()].find((r) => !db.original.get(r.id)?.outreach)!;
    const f = await frames("/api/outreach/job", { ids: [withPkg[0].id, without.id] });
    expect(f[0]).toEqual({ type: "phase", kind: "outreach", count: 2 });
    expect(f.find((x) => x.type === "outreach")).toMatchObject({ hotel_id: withPkg[0].id, package: { content: expect.any(Object) } });
    expect(f.some((x) => x.type === "status" && /Outreach failed for .*not part of this demo/.test(x.message))).toBe(true);
    expect(f.at(-1)).toEqual({ type: "done", generated: 1, skipped: 0, failed: 1 });
    expect((await post("/api/outreach/job", { ids: [] })).status).toBe(400);

    const pkg = await saveOutreachField(withPkg[0].id, "email_subject", "Hello there");
    expect(pkg.content.email_subject).toBe("Hello there");
    expect(pkg.edited_fields).toEqual(["email_subject"]);
    expect(pkg.edited_at).toBeTruthy();

    const one = await post("/api/outreach/export", { ids: [withPkg[0].id] });
    expect(one.headers.get("content-type")).toBe("message/rfc822");
    const eml = await one.text();
    expect(eml).toContain("X-Unsent: 1");
    expect(eml).toContain("Subject: Hello there");
    expect(eml).toContain('filename="Cognitidata.pdf"');
    const zip = new Uint8Array(await (await post("/api/outreach/export", { ids: withPkg.map((r) => r.id) })).arrayBuffer());
    expect(String.fromCharCode(zip[0], zip[1])).toBe("PK");
    expect((await post("/api/outreach/export", { ids: [without.id] })).status).toBe(404);
  });
});

describe("settings", () => {
  it("reads and writes the outreach settings with the real slot check", async () => {
    const s = await (await fetch("/api/settings/outreach")).json();
    expect(s).toEqual({ right_to_win: expect.any(String), copy_prompt: expect.any(String) });
    expect((await post("/api/settings/outreach", { right_to_win: "x", copy_prompt: "no slots" }, "PUT")).status).toBe(400);
    const ok = await post("/api/settings/outreach", { right_to_win: " RTW ", copy_prompt: s.copy_prompt }, "PUT");
    expect((await ok.json()).right_to_win).toBe("RTW");
  });

  it("has a teaser, and only takes a PDF upload", async () => {
    expect(await fetchTeaser()).toMatchObject({ filename: expect.any(String), size: expect.any(Number) });
    const fd = new FormData();
    fd.append("file", new Blob(["hello"]), "x.pdf");
    expect((await fetch("/api/settings/teaser", { method: "POST", body: fd })).status).toBe(400);
    const pdf = await fetch("/api/settings/teaser/file");
    expect(new TextDecoder().decode((await pdf.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
  });
});

describe("leads", () => {
  const sample = readFileSync(resolve(PUBLIC, "sample-leads.csv"), "utf8");
  const parse = (content: string, name = "leads.csv") => {
    const fd = new FormData();
    fd.append("addedBy", "Demo");
    fd.append("file", new Blob([content]), name);
    return fetch("/api/leads/parse", { method: "POST", body: fd });
  };

  it("parses the template CSV and classifies against stored hotels", async () => {
    const data = await (await parse(sample)).json();
    expect(data.mode).toBe("template");
    expect(data.leads).toHaveLength(8);
    expect(data.summary.known).toBeGreaterThanOrEqual(4);
    expect(data.summary.new).toBeGreaterThanOrEqual(3);
    expect(data.leads[0]).toMatchObject({ tempId: "l1", classification: "known", match: { hotel_id: expect.any(String) } });
  });

  it("refuses a non-template CSV with a clear message", async () => {
    const res = await parse("Hotel,Town\nFoo,Bar\n");
    expect(res.status).toBe(400);
    expect((await res.json()).detail).toMatch(/template/);
  });

  it("commits a new lead and exports the market as template CSV", async () => {
    const res = await post("/api/leads/commit", {
      addedBy: "Demo",
      leads: [{ name: "Brand New Test Hotel", city: "Lecce", country: "Italy", fields: { key_count: 12 }, extra: {}, action: "insert", matchHotelId: null }],
    });
    const c = await res.json();
    expect(c).toMatchObject({ inserted: 1, merged: 0, committed: [{ name: "Brand New Test Hotel", action: "inserted" }] });
    const [row] = await fetchHotelsByIds([c.committed[0].hotel_id]);
    expect(row).toMatchObject({ name: "Brand New Test Hotel", city: "Lecce", keys: 12 });
    const dup = await post("/api/leads/commit", { addedBy: "Demo", leads: [{ name: "Brand New Test Hotel", city: "Lecce", country: "Italy", fields: {}, extra: {}, action: "insert", matchHotelId: null }] });
    expect(dup.status).toBe(400);
    const csv = await (await fetch("/api/leads/export?city=Lecce")).text();
    expect(csv.split("\r\n")[0]).toBe("name,city,country,locality,segment,key_count,brand,affiliation,website,owner_name,owner_email,owner_phone,owner_linkedin,source_url,notes");
    expect(csv).toContain("Brand New Test Hotel");
  });
});

describe("hotels", () => {
  it("edits fields and contacts with the real validation, and deletes", async () => {
    const db = await loadDb();
    const r = [...db.rows.values()][5];
    expect((await editHotelField(r.id, "key_count", "120")).keys).toBe(120);
    await expect(editHotelField(r.id, "owner_type", "pirate")).rejects.toThrow(/owner_type must be one of/);
    await expect(editHotelField(r.id, "city", "x")).rejects.toThrow(/not editable/);
    const uc = [{ id: "u1", source: "user", name: "Jane Doe", title: "GM", email: "jane@example.com" }];
    expect((await saveContacts(r.id, uc as never)).userContacts).toEqual(uc);
    await bulkDeleteHotels([r.id]);
    expect(await fetchHotelsByIds([r.id])).toEqual([]);
    await expect(bulkDeleteHotels(["not-a-uuid"])).rejects.toThrow(/malformed/);
  });

  it("answers /health and 404s anything unknown", async () => {
    expect(await (await fetch("/health")).json()).toEqual({ status: "ok" });
    expect((await fetch("/api/nope")).status).toBe(404);
  });
});
