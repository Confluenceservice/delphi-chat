import type { Env } from "./types";
import {
  HttpError,
  approveQueueItem,
  dismissQueueItem,
  deleteCorpusDoc,
  listCorpusDocs,
  listQueue,
  suggestForKb,
  type ChatMode,
} from "./corpus";
import { seedCorpus } from "./kb-seed";

interface SuggestBody {
  question: string;
  answer: string;
  mode: ChatMode;
}

export async function handleKbSuggest(request: Request, env: Env, userEmail: string): Promise<Response> {
  let body: SuggestBody;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }
  if (!body.question || !body.answer) {
    return jsonError("Body must include { question, answer }", 400);
  }
  const mode: ChatMode = body.mode === "tutor" ? "tutor" : "answer";

  const id = await suggestForKb(env, userEmail, { question: body.question, answer: body.answer, mode });
  return json({ id });
}

export async function handleKbQueueList(env: Env): Promise<Response> {
  const items = await listQueue(env);
  return json({ items });
}

export async function handleKbApprove(id: string, env: Env, adminEmail: string): Promise<Response> {
  try {
    const result = await approveQueueItem(env, adminEmail, id);
    return json(result);
  } catch (err) {
    if (err instanceof HttpError) return jsonError(err.message, err.status);
    return jsonError(err instanceof Error ? err.message : "Approve failed", 500);
  }
}

export async function handleKbDismiss(id: string, env: Env, adminEmail: string): Promise<Response> {
  try {
    await dismissQueueItem(env, adminEmail, id);
    return json({ ok: true });
  } catch (err) {
    if (err instanceof HttpError) return jsonError(err.message, err.status);
    return jsonError(err instanceof Error ? err.message : "Dismiss failed", 500);
  }
}

export async function handleKbDocsList(env: Env): Promise<Response> {
  const docs = await listCorpusDocs(env);
  return json({ docs });
}

export async function handleKbDocDelete(id: string, env: Env): Promise<Response> {
  await deleteCorpusDoc(env, id);
  return json({ ok: true });
}

export async function handleKbSeed(env: Env): Promise<Response> {
  const result = await seedCorpus(env);
  return json(result);
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
