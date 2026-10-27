// Persists the Workbench working session to localStorage so a refresh — or opening the app in
// another tab — restores it exactly, instead of dropping the user back on the home screen. A
// new session begins only when the user returns home (see Workbench `goHome`). This module owns
// only the mechanism: a single versioned JSON blob, with safe (never-throwing) I/O. It is
// generic and decoupled from the app's field types — the caller hands it a plain-JSON payload
// (Workbench converts its one Set field to an array first). Distinct from `kh_session_id` in
// api.ts, which is an unrelated backend-log correlation id in sessionStorage.

const KEY = "kh_workbench_snapshot";
export const SCHEMA_VERSION = 1;

export type SnapshotStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

// The subset of Storage we use; defaults to localStorage when available, else null (e.g. the
// node test env, or a browser with storage disabled).
function defaultStore(): SnapshotStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function serialize<T>(state: T): string {
  return JSON.stringify({ version: SCHEMA_VERSION, state });
}

export function deserialize<T>(raw: string | null): T | null {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== SCHEMA_VERSION) return null;
    return parsed.state as T;
  } catch {
    return null;
  }
}

export function load<T>(storage: SnapshotStore | null = defaultStore()): T | null {
  if (!storage) return null;
  try {
    return deserialize<T>(storage.getItem(KEY));
  } catch {
    return null;
  }
}

export function save<T>(state: T, storage: SnapshotStore | null = defaultStore()): void {
  if (!storage) return;
  try {
    storage.setItem(KEY, serialize(state));
  } catch {
    // quota exceeded / storage unavailable — stay in memory; never crash the app.
  }
}

export function clear(storage: SnapshotStore | null = defaultStore()): void {
  if (!storage) return;
  try {
    storage.removeItem(KEY);
  } catch {
    // ignore
  }
}
