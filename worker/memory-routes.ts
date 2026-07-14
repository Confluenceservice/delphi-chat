import type { Env } from "./types";
import { clearMemories, deleteMemory, ingestExchange, listMemories } from "./memory";

interface IngestBody {
  user: string;
  assistant: string;
}

export async function handleMemoryIngest(request: Request, env: Env, userEmail: string): Promise<Response> {
  let body: IngestBody;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }
  if (!body.user || !body.assistant) {
    return jsonError("Body must include { user, assistant }", 400);
  }

  try {
    const { added, updated, deleted } = await ingestExchange(env, userEmail, body.user, body.assistant);
    return json({ added, updated, deleted });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Memory ingest failed", 500);
  }
}

export async function handleMemoryList(env: Env, userEmail: string): Promise<Response> {
  const facts = await listMemories(env, userEmail);
  return json({ facts });
}

export async function handleMemoryDelete(id: string, env: Env, userEmail: string): Promise<Response> {
  await deleteMemory(env, userEmail, id);
  return json({ ok: true });
}

export async function handleMemoryClear(env: Env, userEmail: string): Promise<Response> {
  await clearMemories(env, userEmail);
  return json({ ok: true });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
