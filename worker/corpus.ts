import type { Env } from "./types";
import { embed } from "./embed";

// Shared org-wide knowledge base, fully separate from the personal memory
// store in memory.ts (different tables, different Vectorize partition).
// Reuses the same Vectorize index as memory — same embedding model/dims —
// partitioned by the one indexed metadata field, `namespace`, set to this
// constant. Emails always contain "@", so this can never collide with a
// user's memory partition (see memory.ts:4-8 for the analogous reasoning).
const KB_NAMESPACE = "kb";
const KB_TOP_K = 4;
// Below this cosine score, an excerpt isn't relevant enough to ground the
// answer — the turn falls back to the general-knowledge prompt instead.
// Tune against the seed corpus; bge-m3 off-topic pairs can score ~0.4-0.5.
const KB_MIN_SCORE = 0.5;

export type KbOrigin = "seed" | "community";
export type ChatMode = "answer" | "tutor";

export interface CorpusExcerpt {
  docId: string;
  title: string;
  origin: KbOrigin;
  chunk: string;
  index: number; // 1-based, matches the [n] citation shown to the model/user
}

export interface KbDocSummary {
  id: string;
  title: string;
  origin: KbOrigin;
  created_by: string | null;
  created_at: number;
  chunk_count: number;
}

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

function now(): number {
  return Math.floor(Date.now() / 1000);
}

// Retrieve grounding excerpts for a turn. Vector metadata carries the doc
// title/origin/text, so this needs zero D1 reads on the hot chat path.
export async function retrieveCorpus(
  env: Env,
  query: string,
  k: number = KB_TOP_K,
): Promise<CorpusExcerpt[]> {
  const vector = await embed(env, query);
  const { matches } = await env.VECTORIZE.query(vector, {
    topK: k,
    returnMetadata: "all",
    filter: { namespace: KB_NAMESPACE },
  });

  const excerpts: CorpusExcerpt[] = [];
  let index = 1;
  for (const m of matches) {
    if ((m.score ?? 0) < KB_MIN_SCORE) continue;
    const meta = m.metadata as { docId?: string; title?: string; origin?: string; text?: string } | undefined;
    if (!meta?.text) continue;
    excerpts.push({
      docId: String(meta.docId ?? ""),
      title: String(meta.title ?? ""),
      origin: meta.origin === "community" ? "community" : "seed",
      chunk: meta.text,
      index: index++,
    });
  }
  return excerpts;
}

// Insert a doc + its chunks. Vectorize writes can fail independently of D1;
// on failure, compensating-delete the D1 rows so approve/seed stays retryable
// rather than leaving an orphaned doc with no vectors.
export async function addCorpusDoc(
  env: Env,
  opts: { title: string; origin: KbOrigin; createdBy: string | null; chunks: string[] },
): Promise<string> {
  const docId = crypto.randomUUID();
  const ts = now();
  const chunkRows = opts.chunks.map((text, seq) => ({ id: crypto.randomUUID(), seq, text }));

  await env.DB.batch([
    env.DB.prepare("INSERT INTO kb_docs (id, title, origin, created_by, created_at) VALUES (?, ?, ?, ?, ?)").bind(
      docId,
      opts.title,
      opts.origin,
      opts.createdBy,
      ts,
    ),
    ...chunkRows.map((c) =>
      env.DB.prepare("INSERT INTO kb_chunks (id, doc_id, seq, text, created_at) VALUES (?, ?, ?, ?, ?)").bind(
        c.id,
        docId,
        c.seq,
        c.text,
        ts,
      ),
    ),
  ]);

  try {
    for (const c of chunkRows) {
      const vector = await embed(env, c.text);
      await env.VECTORIZE.insert([
        { id: c.id, values: vector, metadata: { namespace: KB_NAMESPACE, docId, title: opts.title, origin: opts.origin, text: c.text } },
      ]);
    }
  } catch (err) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM kb_chunks WHERE doc_id = ?").bind(docId),
      env.DB.prepare("DELETE FROM kb_docs WHERE id = ?").bind(docId),
    ]);
    throw err;
  }

  return docId;
}

export async function deleteCorpusDoc(env: Env, docId: string): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id FROM kb_chunks WHERE doc_id = ?")
    .bind(docId)
    .all<{ id: string }>();
  const ids = results.map((r) => r.id);
  if (ids.length > 0) {
    await env.VECTORIZE.deleteByIds(ids);
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM kb_chunks WHERE doc_id = ?").bind(docId),
    env.DB.prepare("DELETE FROM kb_docs WHERE id = ?").bind(docId),
  ]);
}

export async function listCorpusDocs(env: Env): Promise<KbDocSummary[]> {
  const { results } = await env.DB.prepare(
    `SELECT d.id, d.title, d.origin, d.created_by, d.created_at, COUNT(c.id) AS chunk_count
     FROM kb_docs d LEFT JOIN kb_chunks c ON c.doc_id = d.id
     GROUP BY d.id ORDER BY d.created_at DESC`,
  ).all<KbDocSummary>();
  return results;
}

export async function suggestForKb(
  env: Env,
  userEmail: string,
  opts: { question: string; answer: string; mode: ChatMode },
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO kb_queue (id, question, answer, mode, suggested_by, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
  )
    .bind(id, opts.question, opts.answer, opts.mode, userEmail, now())
    .run();
  return id;
}

export async function listQueue(env: Env): Promise<KbQueueItem[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, question, answer, mode, suggested_by, status, created_at, reviewed_by, reviewed_at
     FROM kb_queue ORDER BY (status = 'pending') DESC, created_at DESC`,
  ).all<KbQueueItem>();
  return results;
}

// Strip UI scaffolding so the stored doc is clean prose: citation markers
// and the Try it / Verify coaching lines.
export function cleanAnswerForCorpus(answer: string): string {
  return answer
    .split("\n")
    .filter((l) => !l.trim().startsWith("Try it:") && !l.trim().startsWith("Verify:"))
    .join("\n")
    .replace(/\[\d+\]/g, "")
    .replace(/\*\*/g, "")
    .trim();
}

function titleFromQuestion(question: string): string {
  return question.length > 70 ? question.slice(0, 67) + "…" : question;
}

export async function approveQueueItem(env: Env, adminEmail: string, id: string): Promise<{ docId: string }> {
  const item = await env.DB.prepare("SELECT * FROM kb_queue WHERE id = ?").bind(id).first<KbQueueItem>();
  if (!item) throw new HttpError(404, "Queue item not found");
  if (item.status !== "pending") throw new HttpError(409, "Queue item already reviewed");

  const cleaned = cleanAnswerForCorpus(item.answer);
  const docId = await addCorpusDoc(env, {
    title: titleFromQuestion(item.question),
    origin: "community",
    createdBy: item.suggested_by,
    chunks: [cleaned],
  });

  await env.DB.prepare("UPDATE kb_queue SET status = 'approved', reviewed_by = ?, reviewed_at = ? WHERE id = ?")
    .bind(adminEmail, now(), id)
    .run();

  return { docId };
}

export async function dismissQueueItem(env: Env, adminEmail: string, id: string): Promise<void> {
  const res = await env.DB.prepare(
    "UPDATE kb_queue SET status = 'dismissed', reviewed_by = ?, reviewed_at = ? WHERE id = ? AND status = 'pending'",
  )
    .bind(adminEmail, now(), id)
    .run();
  if (res.meta.changes === 0) throw new HttpError(409, "Queue item already reviewed");
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
