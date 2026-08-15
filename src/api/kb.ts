import { apiFetch } from "./http";
import type { ChatMode } from "../state/types";

export interface KbQueueItem {
  id: string;
  question: string;
  answer: string;
  mode: ChatMode;
  suggested_by: string;
  status: "pending" | "approved" | "dismissed";
  created_at: number;
  reviewed_by: string | null;
  reviewed_at: number | null;
}

export interface KbDocSummary {
  id: string;
  title: string;
  origin: "seed" | "community";
  created_by: string | null;
  created_at: number;
  chunk_count: number;
}

export function suggestForKb(question: string, answer: string, mode: ChatMode): void {
  // Fire-and-forget: suggesting shouldn't block or fail the chat UI.
  apiFetch("/api/kb/suggest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, answer, mode }),
  }).catch(() => {});
}

/** Throws with a distinguishable status so callers can tell "not admin" apart from other failures. */
class ApiStatusError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function listKbQueue(): Promise<KbQueueItem[]> {
  const response = await apiFetch("/api/kb/queue");
  if (!response.ok) throw new ApiStatusError(response.status, `Failed to load queue (${response.status})`);
  const data = await response.json();
  return data.items ?? [];
}

export async function approveKbItem(id: string): Promise<void> {
  const response = await apiFetch(`/api/kb/queue/${encodeURIComponent(id)}/approve`, { method: "POST" });
  if (!response.ok) throw new Error(`Failed to approve (${response.status})`);
}

export async function dismissKbItem(id: string): Promise<void> {
  const response = await apiFetch(`/api/kb/queue/${encodeURIComponent(id)}/dismiss`, { method: "POST" });
  if (!response.ok) throw new Error(`Failed to dismiss (${response.status})`);
}

export async function listKbDocs(): Promise<KbDocSummary[]> {
  const response = await apiFetch("/api/kb/docs");
  if (!response.ok) throw new ApiStatusError(response.status, `Failed to load docs (${response.status})`);
  const data = await response.json();
  return data.docs ?? [];
}

export async function deleteKbDoc(id: string): Promise<void> {
  const response = await apiFetch(`/api/kb/docs/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(`Failed to delete doc (${response.status})`);
}

export async function seedKb(): Promise<{ seeded: boolean; count: number }> {
  const response = await apiFetch("/api/kb/seed", { method: "POST" });
  if (!response.ok) throw new Error(`Failed to seed (${response.status})`);
  return response.json();
}

export function isForbidden(err: unknown): boolean {
  return err instanceof ApiStatusError && err.status === 403;
}
