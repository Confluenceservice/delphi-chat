import type { Env } from "./types";
import { embed } from "./embed";

// D1 `namespace` column is vestigial from the pre-auth design; the real
// per-user partition is user_email. For Vectorize (dedup only), we scope by
// the *indexed* namespace field set to the user's email — Vectorize refuses to
// filter on un-indexed metadata, and only `namespace` has a metadata index.
const NAMESPACE = "default";
const DEDUP_SCORE_THRESHOLD = 0.93;
// Personal app with a small fact set per user: inject them all every turn
// rather than semantically retrieving a subset, so the assistant reliably
// knows the user regardless of how the current message is phrased.
const MAX_INJECTED_FACTS = 40;

export interface MemoryFactRow {
  id: string;
  namespace: string;
  text: string;
  source: string | null;
  created_at: number;
}

// MiniMax-M3 wraps reasoning in <think>...</think> even in non-streaming calls.
function stripThinking(raw: string): string {
  const withoutClosed = raw.replace(/<think>[\s\S]*?<\/think>/g, "");
  const openIdx = withoutClosed.indexOf("<think>");
  const visible = openIdx === -1 ? withoutClosed : withoutClosed.slice(0, openIdx);
  return visible.trim();
}

async function callMiniMaxNonStreaming(env: Env, prompt: string): Promise<string> {
  const url = new URL(`${env.MINIMAX_BASE_URL}/v1/chat/completions`);
  if (env.MINIMAX_GROUP_ID) {
    url.searchParams.set("GroupId", env.MINIMAX_GROUP_ID);
  }
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.MINIMAX_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "MiniMax-M3",
      messages: [{ role: "user", content: prompt }],
      stream: false,
    }),
  });
  if (!response.ok) {
    throw new Error(`MiniMax extraction call failed: ${response.status}`);
  }
  const data = await response.json<{ choices?: { message?: { content?: string } }[] }>();
  const raw = data.choices?.[0]?.message?.content ?? "";
  return stripThinking(raw);
}

function parseFactsJson(text: string): string[] {
  let cleaned = text.trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) cleaned = fenced[1].trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return parsed.filter((f): f is string => typeof f === "string" && f.trim().length > 0);
    }
  } catch {
    // model didn't return valid JSON — treat as no facts rather than erroring the chat turn
  }
  return [];
}

// Read the user's stored facts straight from D1 (reliably partitioned by
// user_email) and return them all, most-recent first. No embedding or vector
// query on the read path — that avoids the metadata-filter pitfall entirely
// and makes recall independent of the current message's phrasing.
export async function retrieveMemories(env: Env, userEmail: string): Promise<string | null> {
  const { results } = await env.DB.prepare(
    "SELECT text FROM memory_facts WHERE user_email = ? ORDER BY created_at DESC LIMIT ?",
  )
    .bind(userEmail, MAX_INJECTED_FACTS)
    .all<{ text: string }>();
  if (!results.length) return null;
  return results.map((r) => `- ${r.text}`).join("\n");
}

export async function ingestExchange(
  env: Env,
  userEmail: string,
  userText: string,
  assistantText: string,
): Promise<{ added: string[] }> {
  const prompt = `Extract durable facts or preferences about the user from this exchange that would be useful to remember in future, unrelated conversations (e.g. their name, location, dietary restrictions, job, ongoing projects, stated preferences). Ignore anything transient or specific only to this one exchange.

Return ONLY a JSON array of short fact strings, one per fact. Return an empty array [] if there is nothing durable worth remembering.

User: ${userText}
Assistant: ${assistantText}`;

  const raw = await callMiniMaxNonStreaming(env, prompt);
  const candidates = parseFactsJson(raw);
  if (candidates.length === 0) return { added: [] };

  const added: string[] = [];
  for (const fact of candidates) {
    const vector = await embed(env, fact);

    // Dedup per-user via the indexed `namespace` field set to the user's email.
    const dupCheck = await env.VECTORIZE.query(vector, {
      topK: 1,
      returnMetadata: "none",
      filter: { namespace: userEmail },
    });
    if ((dupCheck.matches[0]?.score ?? 0) >= DEDUP_SCORE_THRESHOLD) {
      continue; // near-duplicate of an existing memory
    }

    const id = crypto.randomUUID();
    const createdAt = Math.floor(Date.now() / 1000);

    await env.VECTORIZE.insert([
      { id, values: vector, metadata: { namespace: userEmail, text: fact } },
    ]);
    await env.DB.prepare(
      "INSERT INTO memory_facts (id, namespace, text, source, created_at, user_email) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(id, NAMESPACE, fact, "chat", createdAt, userEmail)
      .run();

    added.push(fact);
  }

  return { added };
}

export async function listMemories(env: Env, userEmail: string): Promise<MemoryFactRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, namespace, text, source, created_at FROM memory_facts WHERE namespace = ? AND user_email = ? ORDER BY created_at DESC",
  )
    .bind(NAMESPACE, userEmail)
    .all<MemoryFactRow>();
  return results;
}

export async function deleteMemory(env: Env, userEmail: string, id: string): Promise<void> {
  const result = await env.DB.prepare("DELETE FROM memory_facts WHERE id = ? AND namespace = ? AND user_email = ?")
    .bind(id, NAMESPACE, userEmail)
    .run();
  if (result.meta.changes > 0) {
    await env.VECTORIZE.deleteByIds([id]);
  }
}

export async function clearMemories(env: Env, userEmail: string): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id FROM memory_facts WHERE namespace = ? AND user_email = ?")
    .bind(NAMESPACE, userEmail)
    .all<{ id: string }>();
  const ids = results.map((r) => r.id);
  if (ids.length > 0) {
    await env.VECTORIZE.deleteByIds(ids);
  }
  await env.DB.prepare("DELETE FROM memory_facts WHERE namespace = ? AND user_email = ?")
    .bind(NAMESPACE, userEmail)
    .run();
}
