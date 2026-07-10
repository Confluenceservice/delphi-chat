import type { Env } from "./types";
import { clearMemories, deleteMemory, ingestExchange, listMemories } from "./memory";

interface IngestBody {
  user: string;
  assistant: string;
}

export async function handleMemoryIngest(request: Request, env: Env): Promise<Response> {
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
    const { added } = await ingestExchange(env, body.user, body.assistant);
    return json({ added });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Memory ingest failed", 500);
  }
}

export async function handleMemoryList(env: Env): Promise<Response> {
  const facts = await listMemories(env);
  return json({ facts });
}

export async function handleMemoryDelete(id: string, env: Env): Promise<Response> {
  await deleteMemory(env, id);
  return json({ ok: true });
}

export async function handleMemoryClear(env: Env): Promise<Response> {
  await clearMemories(env);
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
