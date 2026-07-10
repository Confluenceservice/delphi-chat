import type { Thread } from "./types";

const THREADS_KEY = "minimax-chat:threads";
const ACTIVE_THREAD_KEY = "minimax-chat:active-thread";

export function loadThreads(): Thread[] {
  try {
    const raw = localStorage.getItem(THREADS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveThreads(threads: Thread[]): void {
  localStorage.setItem(THREADS_KEY, JSON.stringify(threads));
}

export function loadActiveThreadId(): string | null {
  return localStorage.getItem(ACTIVE_THREAD_KEY);
}

export function saveActiveThreadId(id: string | null): void {
  if (id) {
    localStorage.setItem(ACTIVE_THREAD_KEY, id);
  } else {
    localStorage.removeItem(ACTIVE_THREAD_KEY);
  }
}
