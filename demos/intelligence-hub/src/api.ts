// Single place that resolves API call URLs. Locally VITE_API_BASE_URL is unset, so
// requests stay same-origin (`/api/...`) and flow through the Vite dev proxy. In
// production (Render two-service deploy) it is set to the backend origin at build time,
// e.g. https://api.example.com, making the SPA call cross-origin.
const BASE = import.meta.env.VITE_API_BASE_URL ?? "";

export const apiUrl = (path: string): string => `${BASE}${path}`;

// Stable per-browser-session id, sent on every API call as the X-Session-Id header so the
// backend can correlate everything one user did across operations in the logs (ADR-058).
// Persisted in sessionStorage (survives reloads; a new tab/window starts a fresh session).
function makeSessionId(): string {
  try {
    const KEY = "kh_session_id";
    let id = sessionStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return "-"; // no storage/crypto (non-browser env) — fall back to the backend's default
  }
}

export const sessionId = makeSessionId();

// Merge the session header into any fetch headers (call sites pass plain header objects).
export function withSession(headers: Record<string, string> = {}): Record<string, string> {
  return { ...headers, "X-Session-Id": sessionId };
}

// The stored rows for a restored working set — a pure DB read, no search or enrichment. The caller
// maps them to its Row. Throws on a failed request; the caller keeps what it had.
export async function fetchHotelsByIds(ids: string[]): Promise<unknown[]> {
  const res = await fetch(apiUrl("/api/hotels/by-ids"), {
    method: "POST",
    headers: withSession({ "Content-Type": "application/json" }),
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw new Error(`hotels/by-ids ${res.status}`);
  const body = (await res.json()) as { hotels?: unknown[] };
  return body.hotels ?? [];
}

// Confirm-gated hard delete of one or many live-set rows (the backend snapshots each to
// deleted_hotels for recovery before removing it). Throws with the server's detail on failure.
export async function bulkDeleteHotels(ids: string[]): Promise<void> {
  const res = await fetch(apiUrl("/api/hotels/delete"), {
    method: "POST",
    headers: withSession({ "Content-Type": "application/json" }),
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail ?? `Delete failed (${res.status}).`);
  }
}

import type { UserContact } from "./filters";

// The server returns the full updated wire row under { hotel }. Kept loose here; Workbench casts
// to its Row/HotelWire at the call site.
type HotelWirePayload = Record<string, any>;

async function postJson(path: string, method: "PATCH" | "PUT", body: unknown): Promise<HotelWirePayload> {
  const res = await fetch(apiUrl(path), {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => null);
    throw new Error(b?.detail ?? `Request failed (${res.status}).`);
  }
  const data = await res.json();
  return data.hotel;
}

// Edit one property field from the dossier (verified-provenance write). Returns the updated row.
export function editHotelField(id: string, field: string, value: unknown): Promise<HotelWirePayload> {
  return postJson(`/api/hotels/${id}/fields`, "PATCH", { field, value });
}

// Replace the user contact overlay for one hotel (whole overlay). Returns the updated row.
export function saveContacts(id: string, userContacts: UserContact[]): Promise<HotelWirePayload> {
  return postJson(`/api/hotels/${id}/contacts`, "PUT", { userContacts });
}

import type { OutreachEditableField, OutreachPackage } from "./outreach";
import { teaserUrl } from "./demo/store";

// Persist one edit to a generated outreach asset (ADR-062 phase 3). Returns the updated package
// (edited_fields + edited_at stamped server-side). Throws with the server's detail on failure.
export async function saveOutreachField(
  id: string,
  field: OutreachEditableField,
  value: string,
): Promise<OutreachPackage> {
  const res = await fetch(apiUrl(`/api/outreach/${id}`), {
    method: "PATCH",
    headers: withSession({ "Content-Type": "application/json" }),
    body: JSON.stringify({ field, value }),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => null);
    throw new Error(b?.detail ?? `Save failed (${res.status}).`);
  }
  return (await res.json()).package as OutreachPackage;
}

// Fetch a binary download and hand it to the browser as a saved file.
async function fetchDownload(path: string, init: RequestInit, filename: string): Promise<void> {
  const res = await fetch(apiUrl(path), init);
  if (!res.ok) {
    const b = await res.json().catch(() => null);
    throw new Error(b?.detail ?? `Download failed (${res.status}).`);
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "lead";

// The one static teaser PDF (ADR-126).
export type TeaserMeta = { filename: string; size: number; uploaded_at: string };

export async function fetchTeaser(): Promise<TeaserMeta | null> {
  const res = await fetch(apiUrl("/api/settings/teaser"));
  if (!res.ok) throw new Error(`Couldn't load the teaser (${res.status}).`);
  return ((await res.json()) as { teaser: TeaserMeta | null }).teaser;
}

// Demo: an <a href>/<iframe src> can't go through the patched fetch, so these point straight at
// the static /teaser.pdf (or the session's uploaded blob) instead of /api/settings/teaser/file.
export const teaserFileUrl = (_download = false): string => teaserUrl();

// The preview iframe's src. The version sits in the QUERY (a fragment-only change doesn't reload
// an iframe), so a replaced PDF shows at once; the fragment only sets the viewer up.
export const teaserPreviewSrc = (t: TeaserMeta): string =>
  `${teaserUrl()}${teaserUrl().startsWith("blob:") ? "" : `?v=${encodeURIComponent(t.uploaded_at)}`}#view=FitH&navpanes=0`;

// One lead → "<Hotel>.eml" (mirrors the backend's eml_filename); several → a zip.
export function exportFilename(count: number, label: string): string {
  if (count === 1) {
    const clean = label.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
    return `${clean || "outreach"}.eml`;
  }
  return `outreach-${slug(label)}.zip`;
}

// Outlook drafts (ADR-126): one lead → <Hotel>.eml, several → a zip of them.
export function exportOutreach(ids: string[], label: string): Promise<void> {
  return fetchDownload(
    "/api/outreach/export",
    {
      method: "POST",
      headers: withSession({ "Content-Type": "application/json" }),
      body: JSON.stringify({ ids }),
    },
    exportFilename(ids.length, label),
  );
}
