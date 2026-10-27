// Pure ports of the backend helpers the demo server needs, kept line-for-line close to the
// Python so the behaviour matches: dedup.py (best_candidate), leads.py (template path + CSV
// export), eml.py (Outlook drafts) and a tiny store-only zip writer.

// ── dedup.py ────────────────────────────────────────────────────────────────
const NAME_STOPWORDS =
  /\b(hotel|hotels|the|resort|resorts|spa|golf|grupo|group|by|and|collection|apartments|residences|residence|suites|suite|a)\b/g;
const COUNTRY_ALIASES: Record<string, string> = {
  uae: "united arab emirates",
  usa: "united states", us: "united states",
  "united states of america": "united states",
  uk: "united kingdom",
  ksa: "saudi arabia",
};
const KNOWN_OVERLAP = 0.8;
const AMBIGUOUS_OVERLAP = 0.5;

const stripAccents = (s: string) => s.normalize("NFD").replace(/\p{Mn}/gu, "");

function norm(s: string | null | undefined, dropStopwords: boolean): string {
  let t = stripAccents((s ?? "").toLowerCase());
  t = t.replace(/\(.*?\)/g, " ");
  if (dropStopwords) t = t.replace(NAME_STOPWORDS, " ");
  t = t.replace(/[^a-z0-9 ]/g, " ");
  return t.replace(/\s+/g, " ").trim();
}

const normCountry = (c: string | null | undefined) => {
  const n = norm(c, false);
  return COUNTRY_ALIASES[n] ?? n;
};

export function dedupKey(name: string, city: string | null, country: string | null, locality: string | null = null): string {
  const nc = norm(city, false);
  const nco = normCountry(country);
  const nl = norm(locality, false);
  let nn = norm(name, true);
  const rawCo = norm(country, false);
  const loc = new Set([...nc.split(" "), ...nco.split(" "), ...rawCo.split(" "), ...nl.split(" ")].filter(Boolean));
  if (loc.size) {
    const stripped = nn.split(" ").filter((t) => t && !loc.has(t)).join(" ");
    if (stripped) nn = stripped;
  }
  return [nn, nc, nco].join("|");
}

const nameTokens = (name: string) => new Set(norm(name, true).split(" ").filter(Boolean));

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export type Existing = { hotel_id: string; name: string; city: string | null; country: string | null };
export type MatchLabel = "known" | "ambiguous" | "new";

export function bestCandidate(
  name: string, city: string | null, country: string | null, existing: Existing[],
): [MatchLabel, Existing | null, number] {
  const key = dedupKey(name, city, country);
  const cc = normCountry(country);
  const toks = nameTokens(name);
  let best = 0;
  let bestRow: Existing | null = null;
  for (const e of existing) {
    if (dedupKey(e.name ?? "", e.city, e.country) === key) return ["known", e, 1];
    if (normCountry(e.country) !== cc) continue;
    const s = jaccard(toks, nameTokens(e.name ?? ""));
    if (s > best) { best = s; bestRow = e; }
  }
  if (best >= KNOWN_OVERLAP) return ["known", bestRow, best];
  if (best >= AMBIGUOUS_OVERLAP) return ["ambiguous", bestRow, best];
  return ["new", null, best];
}

// ── leads.py (Path A — the deterministic template) ───────────────────────────
export const TEMPLATE_COLUMNS = [
  "name", "city", "country", "locality", "segment", "key_count",
  "brand", "affiliation", "website",
  "owner_name", "owner_email", "owner_phone", "owner_linkedin", "source_url", "notes",
];
const IDENTITY_COLS = new Set(["name", "city", "country"]);

export type LeadCandidate = {
  name: string;
  city: string | null;
  country: string | null;
  locality: string | null;
  fields: Record<string, string | number>;
  extra: Record<string, string>;
  normalizations: { field: string; from: string; to: string }[];
  cellErrors: { row: number; column: string; value: string; reason: string }[];
};

export function isTemplateHeader(header: string[]): boolean {
  const n = header.map((h) => (h ?? "").trim().toLowerCase());
  if (!n.includes("name") || !n.length) return false;
  return n.filter((h) => TEMPLATE_COLUMNS.includes(h)).length / n.length >= 0.6;
}

// A small RFC-4180 reader (quotes, doubled quotes, CR/LF) — what Python's csv.reader does here.
export function rowsFromCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export function parseTemplate(rows: string[][]): LeadCandidate[] {
  if (!rows.length) return [];
  const header = rows[0].map((h) => (h ?? "").trim().toLowerCase());
  const out: LeadCandidate[] = [];
  rows.slice(1).forEach((raw, idx) => {
    const rI = idx + 2;
    const cells: Record<string, string> = {};
    header.forEach((h, i) => { cells[h] = i < raw.length ? raw[i] : ""; });
    const name = (cells.name ?? "").trim();
    if (!name) return;
    const lead: LeadCandidate = {
      name, city: (cells.city ?? "").trim() || null, country: (cells.country ?? "").trim() || null,
      locality: null, fields: {}, extra: {}, normalizations: [], cellErrors: [],
    };
    for (const [col, v] of Object.entries(cells)) {
      const val = (v ?? "").trim();
      if (!val || IDENTITY_COLS.has(col)) continue;
      if (col === "key_count") {
        const n = Number(val);
        if (val !== "" && Number.isFinite(n)) lead.fields.key_count = Math.trunc(n);
        else lead.cellErrors.push({ row: rI, column: "key_count", value: val, reason: "not an integer" });
      } else if (TEMPLATE_COLUMNS.includes(col)) lead.fields[col] = val;
      else lead.extra[col] = val;
    }
    out.push(lead);
  });
  return out;
}

export function classifyLeads(leads: LeadCandidate[], existing: Existing[]) {
  return leads.map((lead, i) => {
    const [label, row, score] = bestCandidate(lead.name, lead.city, lead.country, existing);
    return {
      tempId: `l${i + 1}`, name: lead.name, city: lead.city, country: lead.country,
      locality: lead.locality, fields: lead.fields, extra: lead.extra,
      normalizations: lead.normalizations, cellErrors: lead.cellErrors,
      classification: label,
      match: row ? { hotel_id: row.hotel_id, name: row.name, score: Math.round(score * 100) / 100 } : null,
    };
  });
}

// hotels_to_template_csv over WIRE rows (the demo keeps no raw DB rows): the same columns, read
// from the wire fields that mirror them. Python's csv.writer: minimal quoting, CRLF lines.
const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const WIRE_FOR_COLUMN: Record<string, string> = {
  name: "name", city: "city", country: "country", locality: "locality", segment: "segment",
  key_count: "keys", brand: "brand", affiliation: "brandAffiliation", website: "officialWebsite",
  owner_name: "ownerName", owner_email: "ownerEmail", owner_phone: "ownerPhone",
  owner_linkedin: "ownerLinkedin", source_url: "source", notes: "notes",
};
export function hotelsToTemplateCsv(rows: Record<string, unknown>[]): string {
  const lines = [TEMPLATE_COLUMNS.join(",")];
  for (const r of rows) lines.push(TEMPLATE_COLUMNS.map((c) => csvCell(r[WIRE_FOR_COLUMN[c]])).join(","));
  return lines.join("\r\n") + "\r\n";
}

// ── eml.py ──────────────────────────────────────────────────────────────────
export const ATTACHMENT_NAME = "Cognitidata.pdf";

type Contact = { name?: string | null; email?: string | null };

export function emailableContacts(row: { ownerContacts?: Contact[] | null; ownerEmail?: string | null }): [string | null, string][] {
  const out: [string | null, string][] = [];
  const seen = new Set<string>();
  for (const c of row.ownerContacts ?? []) {
    const email = (c.email ?? "").trim();
    if (email && !seen.has(email.toLowerCase())) {
      seen.add(email.toLowerCase());
      out.push([(c.name ?? "").trim() || null, email]);
    }
  }
  const scalar = (row.ownerEmail ?? "").trim();
  if (scalar && !seen.has(scalar.toLowerCase())) out.push([null, scalar]);
  return out;
}

type Address = { name: string | null; addr: string };

function addresses(name: string | null, field: string): Address[] {
  return field.split(/[;,\s]+/).filter((p) => p && /^[^@\s]+@[^@\s]+$/.test(p)).map((addr) => ({ name, addr }));
}

export function emlRecipients(
  row: { ownerContacts?: Contact[] | null; ownerEmail?: string | null },
  pkg: { recipient?: { name?: string | null } | null },
): [Address | null, Address[]] {
  const greeted = (pkg.recipient?.name ?? "").trim().toLowerCase();
  const contacts = emailableContacts(row);
  let idx = contacts.findIndex(([n]) => greeted && (n ?? "").toLowerCase() === greeted);
  if (idx < 0) idx = 0;
  const ordered = [...contacts.slice(idx, idx + 1), ...contacts.slice(0, idx), ...contacts.slice(idx + 1)];
  const addrs = ordered.flatMap(([n, e]) => addresses(n, e));
  if (!addrs.length) return [null, []];
  return [addrs[0], addrs.slice(1)];
}

const isAscii = (s: string) => /^[\x00-\x7f]*$/.test(s);
const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const utf8 = (s: string) => new TextEncoder().encode(s);
const wrap76 = (s: string) => s.replace(/.{1,76}/g, "$&\r\n");
// RFC 2047 encoded-word for a non-ASCII header value (what Python's policy.SMTP emits).
const encWord = (s: string) => (isAscii(s) ? s : `=?utf-8?b?${b64(utf8(s))}?=`);

function formatAddress(a: Address): string {
  if (!a.name) return a.addr;
  const display = isAscii(a.name)
    ? (/[()<>@,;:\\".[\]]/.test(a.name) ? `"${a.name.replace(/(["\\])/g, "\\$1")}"` : a.name)
    : encWord(a.name);
  return `${display} <${a.addr}>`;
}

// The Outlook draft: To/Cc/Subject/plain body, the teaser PDF attached, CRLF throughout.
export function buildEml(to: Address | null, cc: Address[], subject: string, body: string, pdf: Uint8Array): Uint8Array {
  const boundary = `===============${Math.floor(Math.random() * 1e18).toString().padStart(19, "0")}==`;
  const head: string[] = ["X-Unsent: 1"];
  if (to) head.push(`To: ${formatAddress(to)}`);
  if (cc.length) head.push(`Cc: ${cc.map(formatAddress).join(", ")}`);
  head.push(`Subject: ${encWord(subject.split(/\s+/).filter(Boolean).join(" "))}`);
  head.push("MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="${boundary}"`);
  const text = body.replace(/\r?\n/g, "\r\n");
  const textPart = isAscii(text)
    ? ['Content-Type: text/plain; charset="utf-8"', "Content-Transfer-Encoding: 7bit", "", text]
    : ['Content-Type: text/plain; charset="utf-8"', "Content-Transfer-Encoding: base64", "", wrap76(b64(utf8(text))).trimEnd()];
  const pdfPart = [
    "Content-Type: application/pdf", "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${ATTACHMENT_NAME}"`, "MIME-Version: 1.0", "",
    wrap76(b64(pdf)).trimEnd(),
  ];
  const msg = [
    ...head, "", `--${boundary}`, ...textPart, `--${boundary}`, ...pdfPart, `--${boundary}--`, "",
  ].join("\r\n");
  return utf8(msg);
}

export function emlFilename(hotelName: string | null | undefined): string {
  const clean = (hotelName ?? "").replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
  return `${clean || "outreach"}.eml`;
}

// ── a store-only zip (no compression, no dependency) ──────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zipStore(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = utf8(f.name);
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint32(14, crc, true);
    local.setUint32(18, f.data.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, f.data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, f.data.length, true);
    cen.setUint32(24, f.data.length, true);
    cen.setUint16(28, name.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const cenSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cenSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}
