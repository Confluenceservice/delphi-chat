import type { Thread } from "./types";
import {
  deleteRemoteThread,
  getRemoteThread,
  listRemoteThreads,
  putRemoteThread,
} from "../api/threads";

/**
 * Write-through sync: D1 is the source of truth, localStorage is the cache.
 * Mutations mark a thread dirty; a debounced flush pushes full threads.
 * Never called mid-stream — only on settled mutations.
 */

const DIRTY_KEY = "minimax-chat:sync-dirty";
const DELETES_KEY = "minimax-chat:sync-deletes";
const DEBOUNCE_MS = 2000;

export type SyncStatus = "pending" | "synced" | "error";
export type SyncStateMap = Record<string, SyncStatus>;

type Listener = (state: SyncStateMap) => void;

let threadSource: (id: string) => Thread | undefined = () => undefined;
let dirty = new Set<string>(loadSet(DIRTY_KEY));
let pendingDeletes = new Set<string>(loadSet(DELETES_KEY));
const state: SyncStateMap = {};
const listeners = new Set<Listener>();
let timer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

for (const id of dirty) state[id] = "pending";

/** useThreads registers a getter so flush always reads the latest state. */
export function registerThreadSource(fn: (id: string) => Thread | undefined): void {
  threadSource = fn;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  listener({ ...state });
  return () => listeners.delete(listener);
}

export function markDirty(threadId: string): void {
  dirty.add(threadId);
  persistSet(DIRTY_KEY, dirty);
  setStatus(threadId, "pending");
  scheduleFlush();
}

export function markDeleted(threadId: string): void {
  dirty.delete(threadId);
  persistSet(DIRTY_KEY, dirty);
  pendingDeletes.add(threadId);
  persistSet(DELETES_KEY, pendingDeletes);
  delete state[threadId];
  notify();
  scheduleFlush(0);
}

export function scheduleFlush(delay: number = DEBOUNCE_MS): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void flush(), delay);
}

export async function flush(): Promise<void> {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  try {
    for (const id of [...pendingDeletes]) {
      try {
        await deleteRemoteThread(id);
        pendingDeletes.delete(id);
        persistSet(DELETES_KEY, pendingDeletes);
      } catch {
        // keep queued; retried on next flush
      }
    }
    for (const id of [...dirty]) {
      const thread = threadSource(id);
      if (!thread) {
        dirty.delete(id);
        persistSet(DIRTY_KEY, dirty);
        continue;
      }
      try {
        await putRemoteThread(thread);
        dirty.delete(id);
        persistSet(DIRTY_KEY, dirty);
        setStatus(id, "synced");
      } catch {
        setStatus(id, "error");
      }
    }
  } finally {
    flushing = false;
  }
  if (dirty.size > 0 || pendingDeletes.size > 0) scheduleFlush(30_000);
}

/**
 * Boot reconcile. Remote-newer/remote-only threads are fetched and handed to
 * `upsert`; local-only threads are marked dirty (first-run migration falls out
 * of this for free).
 */
export async function reconcile(
  localThreads: Thread[],
  upsert: (thread: Thread) => void,
): Promise<void> {
  let remote;
  try {
    remote = await listRemoteThreads();
  } catch {
    return; // offline or error: local cache remains authoritative for now
  }

  const localById = new Map(localThreads.map((t) => [t.id, t]));
  const remoteIds = new Set(remote.map((r) => r.id));

  for (const meta of remote) {
    if (pendingDeletes.has(meta.id)) continue; // deleted locally, not yet flushed
    const local = localById.get(meta.id);
    if (!local || (meta.updatedAt ?? 0) > (local.updatedAt ?? 0)) {
      try {
        const full = await getRemoteThread(meta.id);
        upsert(full);
        setStatus(meta.id, "synced");
      } catch {
        // skip; next boot retries
      }
    } else if (!dirty.has(meta.id)) {
      setStatus(meta.id, "synced");
    }
  }

  for (const local of localThreads) {
    if (!remoteIds.has(local.id)) markDirty(local.id);
  }
  scheduleFlush(0);
}

function setStatus(id: string, status: SyncStatus): void {
  if (state[id] === status) return;
  state[id] = status;
  notify();
}

function notify(): void {
  const snapshot = { ...state };
  for (const l of listeners) l(snapshot);
}

function loadSet(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistSet(key: string, set: Set<string>): void {
  localStorage.setItem(key, JSON.stringify([...set]));
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => scheduleFlush(0));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") scheduleFlush(0);
  });
}
