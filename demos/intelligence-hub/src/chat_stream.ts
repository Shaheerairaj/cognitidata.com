import type { Operation } from "./filters";
import { withSession } from "./api";

// The chat rail's conversation model + the streaming reducer for the `ask` answer (ADR-021).
// Kept in its own pure module (no React/CSS) so the token-accumulation logic is unit-testable.

// SSE reader — the one streaming idiom every call site shares (chat/enrich/outreach in
// Workbench, the ADR-079 registry pin-scan runner): POST, read the byte stream, split on the
// \n\n frame delimiter (buffering partials), strip the "data: " prefix, JSON.parse, dispatch.
export async function streamSSE<T>(
  url: string,
  body: unknown,
  onFrame: (frame: T) => void,
  onFail: (msg: string) => void,
) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: withSession({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      onFail(`Request failed — the backend returned ${res.status} ${res.statusText}.`);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = raw.startsWith("data: ") ? raw.slice(6) : raw.replace(/^data:\s?/, "");
        if (!line.trim()) continue;
        try {
          onFrame(JSON.parse(line) as T);
        } catch {
          // skip an unparseable frame rather than crash
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onFail(`Could not reach the backend (${msg}).`);
  }
}

// One entry in the rail conversation thread. A hub turn may carry op chips (refine) or be a
// plain-text bubble — the streamed `ask` answer accumulates into a single `text` turn.
export type Turn =
  | { role: "user"; text: string }
  | { role: "hub"; kind: "text"; text: string }
  | { role: "hub"; kind: "refine"; text: string; operations: Operation[]; coverage?: string | null }
  | { role: "hub"; kind: "confirm"; action: "ownerResearch"; resolved?: "confirmed" | "cancelled" };

// Push a staged-action confirm turn (the human spend gate lives in the rail). The card reads the
// live target count/cost at render time, so the turn itself only carries the action + resolution.
export function appendConfirm(thread: Turn[], action: "ownerResearch"): Turn[] {
  return [...thread, { role: "hub", kind: "confirm", action }];
}

// Append one streamed `ask` token to the thread: extend the trailing in-progress hub-text bubble
// if the last turn is one, else start a fresh bubble. Pure — the whole streaming UX is this reducer
// applied per `token` frame. A `user` turn (pushed when a new turn is sent) naturally separates two
// consecutive answers, so the next token starts its own bubble.
export function appendToken(thread: Turn[], text: string): Turn[] {
  const last = thread[thread.length - 1];
  if (last && last.role === "hub" && last.kind === "text") {
    return [...thread.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...thread, { role: "hub", kind: "text", text }];
}

// Chat is one turn at a time: the composer locks at submit and re-opens only when the turn's
// outcome is on screen. For a plan turn on an empty market that's the authoritative `hotels`
// frame (post-dedup-gate) — NOT stream close, which auto-enrich holds open for minutes. Without
// this lock, a message typed mid-sweep sees zero rows, ships no liveSet, and the router silently
// downgrades a refine to a DB lookup (the Naples race, 2026-07-06).
export function releasesComposer(frameType: string): boolean {
  return frameType === "hotels" || frameType === "done" || frameType === "error";
}
