import type { Env } from "./types";
import { embed } from "./embed";

// Single fixed namespace since v1 has no login/multi-user accounts.
const NAMESPACE = "default";
const RETRIEVAL_TOP_K = 5;
const RETRIEVAL_MIN_SCORE = 0.5;
const DEDUP_SCORE_THRESHOLD = 0.93;

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

export async function retrieveMemories(env: Env, queryText: string): Promise<string | null> {
  if (!queryText.trim()) return null;
  const vector = await embed(env, queryText);
  const results = await env.VECTORIZE.query(vector, {
    topK: RETRIEVAL_TOP_K,
    returnMetadata: "all",
    filter: { namespace: NAMESPACE },
  });
  const facts = results.matches
    .filter((m) => m.score >= RETRIEVAL_MIN_SCORE)
    .map((m) => (m.metadata as { text?: string } | undefined)?.text)
    .filter((t): t is string => !!t);
  if (facts.length === 0) return null;
  return facts.map((f) => `- ${f}`).join("\n");
}

export async function ingestExchange(
  env: Env,
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

    const dupCheck = await env.VECTORIZE.query(vector, {
      topK: 1,
      returnMetadata: "none",
      filter: { namespace: NAMESPACE },
    });
    if ((dupCheck.matches[0]?.score ?? 0) >= DEDUP_SCORE_THRESHOLD) {
      continue; // near-duplicate of an existing memory
    }

    const id = crypto.randomUUID();
    const createdAt = Math.floor(Date.now() / 1000);

    await env.VECTORIZE.insert([{ id, values: vector, metadata: { namespace: NAMESPACE, text: fact } }]);
    await env.DB.prepare(
      "INSERT INTO memory_facts (id, namespace, text, source, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(id, NAMESPACE, fact, "chat", createdAt)
      .run();

    added.push(fact);
  }

  return { added };
}

export async function listMemories(env: Env): Promise<MemoryFactRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, namespace, text, source, created_at FROM memory_facts WHERE namespace = ? ORDER BY created_at DESC",
  )
    .bind(NAMESPACE)
    .all<MemoryFactRow>();
  return results;
}

export async function deleteMemory(env: Env, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM memory_facts WHERE id = ? AND namespace = ?").bind(id, NAMESPACE).run();
  await env.VECTORIZE.deleteByIds([id]);
}

export async function clearMemories(env: Env): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id FROM memory_facts WHERE namespace = ?")
    .bind(NAMESPACE)
    .all<{ id: string }>();
  const ids = results.map((r) => r.id);
  if (ids.length > 0) {
    await env.VECTORIZE.deleteByIds(ids);
  }
  await env.DB.prepare("DELETE FROM memory_facts WHERE namespace = ?").bind(NAMESPACE).run();
}
