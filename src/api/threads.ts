import type { Thread } from "../state/types";

export interface RemoteThreadMeta {
  id: string;
  title: string;
  model: string;
  createdAt: number;
  updatedAt: number;
}

export async function listRemoteThreads(): Promise<RemoteThreadMeta[]> {
  const res = await fetch("/api/threads");
  if (!res.ok) throw new Error(`thread list failed (${res.status})`);
  const data = (await res.json()) as { threads: RemoteThreadMeta[] };
  return data.threads ?? [];
}

export async function getRemoteThread(id: string): Promise<Thread> {
  const res = await fetch(`/api/threads/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`thread fetch failed (${res.status})`);
  return (await res.json()) as Thread;
}

export async function putRemoteThread(thread: Thread): Promise<void> {
  const res = await fetch(`/api/threads/${encodeURIComponent(thread.id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(thread),
  });
  if (!res.ok) throw new Error(`thread save failed (${res.status})`);
}

export async function deleteRemoteThread(id: string): Promise<void> {
  const res = await fetch(`/api/threads/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(`thread delete failed (${res.status})`);
}

export async function fetchTitle(user: string, assistant: string): Promise<string | null> {
  try {
    const res = await fetch("/api/title", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user, assistant }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { title: string | null };
    return data.title ?? null;
  } catch {
    return null;
  }
}
