import { apiFetch } from "./http";

export interface MemoryFact {
  id: string;
  namespace: string;
  text: string;
  source: string | null;
  created_at: number;
}

export function ingestMemory(user: string, assistant: string): void {
  // Fire-and-forget: memory extraction shouldn't block or fail the chat turn.
  apiFetch("/api/memory/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user, assistant }),
  }).catch(() => {});
}

export async function listMemories(): Promise<MemoryFact[]> {
  const response = await apiFetch("/api/memory");
  if (!response.ok) throw new Error(`Failed to load memories (${response.status})`);
  const data = await response.json();
  return data.facts ?? [];
}

export async function deleteMemoryFact(id: string): Promise<void> {
  const response = await apiFetch(`/api/memory/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(`Failed to delete memory (${response.status})`);
}

export async function clearAllMemories(): Promise<void> {
  const response = await apiFetch("/api/memory", { method: "DELETE" });
  if (!response.ok) throw new Error(`Failed to clear memories (${response.status})`);
}
