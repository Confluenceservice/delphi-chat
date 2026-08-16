import type { Env } from "./types";

/**
 * Durable conversations: D1-backed thread CRUD, scoped to the Access
 * identity (userEmail) resolved by the router. Ownership violations
 * return 404 — never 403 — so thread ids don't leak existence.
 */

interface CorpusSourcePayload {
  docId: string;
  title: string;
  origin: "seed" | "community";
  chunk: string;
  index: number;
}

interface ThreadMessagePayload {
  id: string;
  role: string;
  content: string;
  images?: string[];
  sources?: { title: string; url: string }[];
  createdAt?: number;
  mode?: "answer" | "tutor";
  grounded?: boolean;
  corpusSources?: CorpusSourcePayload[];
  kbSuggested?: boolean;
}

interface ThreadPayload {
  id: string;
  title: string;
  model: string;
  createdAt: number;
  updatedAt?: number;
  messages: ThreadMessagePayload[];
}

const MAX_BATCH_STATEMENTS = 90;

export async function handleThreadList(env: Env, userEmail: string): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, title, model, created_at, updated_at
     FROM threads WHERE owner_email = ?
     ORDER BY updated_at DESC`,
  )
    .bind(userEmail)
    .all();

  const threads = (results ?? []).map((row) => ({
    id: row.id as string,
    title: row.title as string,
    model: row.model as string,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  }));
  return json({ threads });
}

export async function handleThreadGet(id: string, env: Env, userEmail: string): Promise<Response> {
  const thread = await env.DB.prepare(
    `SELECT id, title, model, created_at, updated_at
     FROM threads WHERE id = ? AND owner_email = ?`,
  )
    .bind(id, userEmail)
    .first();

  if (!thread) return jsonError("Not found", 404);

  const { results } = await env.DB.prepare(
    `SELECT id, role, content, images, sources, created_at, mode, grounded, corpus_sources, kb_suggested
     FROM messages WHERE thread_id = ? ORDER BY seq ASC`,
  )
    .bind(id)
    .all();

  const messages = (results ?? []).map((row) => ({
    id: row.id as string,
    role: row.role as string,
    content: row.content as string,
    images: parseJsonColumn<string[]>(row.images),
    sources: parseJsonColumn<{ title: string; url: string }[]>(row.sources),
    createdAt: row.created_at as number,
    mode: (row.mode as string | null) ?? undefined,
    grounded: row.grounded === null || row.grounded === undefined ? undefined : Boolean(row.grounded),
    corpusSources: parseJsonColumn<CorpusSourcePayload[]>(row.corpus_sources),
    kbSuggested: row.kb_suggested === null || row.kb_suggested === undefined ? undefined : Boolean(row.kb_suggested),
  }));

  return json({
    id: thread.id,
    title: thread.title,
    model: thread.model,
    createdAt: thread.created_at,
    updatedAt: thread.updated_at,
    messages,
  });
}

export async function handleThreadPut(
  id: string,
  request: Request,
  env: Env,
  userEmail: string,
): Promise<Response> {
  let body: ThreadPayload;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }
  if (!body || body.id !== id || typeof body.title !== "string" || !Array.isArray(body.messages)) {
    return jsonError("Body must be a thread whose id matches the URL", 400);
  }

  const notOwner = await ownedByAnother(env, id, userEmail);
  if (notOwner) return jsonError("Not found", 404);

  const now = Date.now();
  const updatedAt = body.updatedAt ?? now;

  // Upsert the thread row first so the FK target exists, then replace messages.
  const statements = [
    env.DB.prepare(
      `INSERT INTO threads (id, owner_email, title, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         model = excluded.model,
         updated_at = excluded.updated_at
       WHERE threads.owner_email = excluded.owner_email`,
    ).bind(id, userEmail, body.title, body.model ?? "", body.createdAt ?? now, updatedAt),
    env.DB.prepare(`DELETE FROM messages WHERE thread_id = ?`).bind(id),
    ...body.messages.map((m, seq) =>
      env.DB.prepare(
        `INSERT INTO messages (id, thread_id, seq, role, content, images, sources, created_at, mode, grounded, corpus_sources, kb_suggested)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        m.id,
        id,
        seq,
        m.role,
        m.content ?? "",
        m.images && m.images.length > 0 ? JSON.stringify(m.images) : null,
        m.sources && m.sources.length > 0 ? JSON.stringify(m.sources) : null,
        m.createdAt ?? now,
        m.mode ?? null,
        m.grounded === undefined ? null : m.grounded ? 1 : 0,
        m.corpusSources && m.corpusSources.length > 0 ? JSON.stringify(m.corpusSources) : null,
        m.kbSuggested === undefined ? null : m.kbSuggested ? 1 : 0,
      ),
    ),
  ];

  try {
    // D1 batches run in a transaction. Very long threads exceed batch limits,
    // so chunk; the first chunk (upsert + delete + first messages) carries the
    // consistency-critical part, later chunks are pure inserts.
    for (let i = 0; i < statements.length; i += MAX_BATCH_STATEMENTS) {
      await env.DB.batch(statements.slice(i, i + MAX_BATCH_STATEMENTS));
    }
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Thread save failed", 500);
  }

  return json({ ok: true, updatedAt });
}

export async function handleThreadDelete(id: string, env: Env, userEmail: string): Promise<Response> {
  const notOwner = await ownedByAnother(env, id, userEmail);
  if (notOwner) return jsonError("Not found", 404);

  // Delete messages explicitly rather than relying on FK cascade config.
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM messages WHERE thread_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM threads WHERE id = ? AND owner_email = ?`).bind(id, userEmail),
  ]);
  return json({ ok: true });
}

/** True if the thread exists and belongs to someone else. */
async function ownedByAnother(env: Env, id: string, userEmail: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT owner_email FROM threads WHERE id = ?`).bind(id).first();
  return !!row && row.owner_email !== userEmail;
}

function parseJsonColumn<T>(value: unknown): T | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
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
