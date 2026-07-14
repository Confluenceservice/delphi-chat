import type { Env } from "./types";
import { embed } from "./embed";

// D1 `namespace` column is vestigial from the pre-auth design; the real
// per-user partition is user_email. For Vectorize (dedup only), we scope by
// the *indexed* namespace field set to the user's email — Vectorize refuses to
// filter on un-indexed metadata, and only `namespace` has a metadata index.
const NAMESPACE = "default";
const DEDUP_SCORE_THRESHOLD = 0.93;
// Below this similarity, an existing fact isn't related enough to show the
// reconciler — it can't sensibly UPDATE/DELETE against unrelated material.
const RELATED_SCORE_THRESHOLD = 0.7;
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
  updated_at: number | null;
}

type Decision =
  | { action: "ADD"; text: string }
  | { action: "UPDATE"; targetId: string; text: string }
  | { action: "DELETE"; targetId: string }
  | { action: "NONE" };

function now(): number {
  return Math.floor(Date.now() / 1000);
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

function stripFence(text: string): string {
  const cleaned = text.trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1].trim() : cleaned;
}

function parseFactsJson(text: string): string[] {
  try {
    const parsed = JSON.parse(stripFence(text));
    if (Array.isArray(parsed)) {
      return parsed.filter((f): f is string => typeof f === "string" && f.trim().length > 0);
    }
  } catch {
    // model didn't return valid JSON — treat as no facts rather than erroring the chat turn
  }
  return [];
}

// Parse the reconciler's decisions. Guardrails: unknown action -> NONE;
// UPDATE/DELETE whose targetId isn't a known alias are downgraded (UPDATE ->
// ADD, DELETE dropped) so a hallucinated id can never touch an arbitrary row.
// The alias map translates the short m1/m2 ids the model saw back to real UUIDs.
function parseDecisions(text: string, aliasToId: Map<string, string>): Decision[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(text));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const decisions: Decision[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const d = raw as Record<string, unknown>;
    const action = typeof d.action === "string" ? d.action.toUpperCase() : "";
    const text = typeof d.text === "string" ? d.text.trim() : "";
    const realId = typeof d.targetId === "string" ? aliasToId.get(d.targetId) : undefined;

    if (action === "ADD") {
      if (text) decisions.push({ action: "ADD", text });
    } else if (action === "UPDATE") {
      if (realId && text) decisions.push({ action: "UPDATE", targetId: realId, text });
      else if (text) decisions.push({ action: "ADD", text }); // unknown id -> keep the info as new
    } else if (action === "DELETE") {
      if (realId) decisions.push({ action: "DELETE", targetId: realId });
      // unknown id -> drop; never guess which row to delete
    }
    // NONE / unknown action -> skip
  }
  return decisions;
}

function reconcilePrompt(survivors: string[], aliasEntries: { alias: string; text: string }[]): string {
  const existing = aliasEntries.map((e) => `${e.alias}: ${e.text}`).join("\n");
  const candidates = survivors.map((t) => `- ${t}`).join("\n");
  return `You maintain a user's long-term memory. Reconcile NEW candidate facts against EXISTING memories.

EXISTING (id: text):
${existing}

NEW candidates:
${candidates}

Rules:
- UPDATE an existing memory when a new fact supersedes it (moves, job changes, preference changes). Write the merged, current fact.
- DELETE only when a new fact explicitly negates an existing one and nothing replaces it ("is no longer vegetarian" with no new diet).
- ADD when the fact is new and coexists with everything ("has a dog" does not conflict with "has a cat").
- NONE when it duplicates an existing memory.
- When in doubt, prefer ADD over DELETE — losing a true fact is worse than keeping a redundant one.

Return ONLY a JSON array of decisions, e.g.:
[{"action":"UPDATE","targetId":"m1","text":"Lives in Auckland (moved from Wellington, 2026)"},
 {"action":"ADD","text":"Has a golden retriever"},
 {"action":"DELETE","targetId":"m2"}]`;
}

// Read the user's stored facts straight from D1 (reliably partitioned by
// user_email) and return them all, most-recently-touched first. An updated
// fact is fresh again, so order by updated_at (falling back to created_at for
// any pre-migration row). No embedding or vector query on the read path.
export async function retrieveMemories(env: Env, userEmail: string): Promise<string | null> {
  const { results } = await env.DB.prepare(
    "SELECT text FROM memory_facts WHERE user_email = ? ORDER BY COALESCE(updated_at, created_at) DESC LIMIT ?",
  )
    .bind(userEmail, MAX_INJECTED_FACTS)
    .all<{ text: string }>();
  if (!results.length) return null;
  return results.map((r) => `- ${r.text}`).join("\n");
}

async function addFact(
  env: Env,
  userEmail: string,
  text: string,
  vector: number[],
): Promise<void> {
  const id = crypto.randomUUID();
  const ts = now();
  await env.VECTORIZE.insert([{ id, values: vector, metadata: { namespace: userEmail, text } }]);
  await env.DB.prepare(
    "INSERT INTO memory_facts (id, namespace, text, source, created_at, updated_at, user_email) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, NAMESPACE, text, "chat", ts, ts, userEmail)
    .run();
}

// Rewrite a fact in place, keeping its id stable (MemoryPanel keys, future
// re-namespacing). D1 first, then Vectorize upsert — a crash between the two
// leaves a stale vector whose id still resolves to the corrected D1 row, and
// retrieval reads text from D1, so injected facts stay correct.
async function updateFact(env: Env, userEmail: string, id: string, text: string): Promise<void> {
  const res = await env.DB.prepare(
    "UPDATE memory_facts SET text = ?, updated_at = ? WHERE id = ? AND user_email = ?",
  )
    .bind(text, now(), id, userEmail)
    .run();
  if (res.meta.changes === 0) return; // reconciler referenced a row that isn't this user's — ignore
  await env.VECTORIZE.upsert([
    { id, values: await embed(env, text), metadata: { namespace: userEmail, text } },
  ]);
}

export async function ingestExchange(
  env: Env,
  userEmail: string,
  userText: string,
  assistantText: string,
): Promise<{ added: string[]; updated: string[]; deleted: string[] }> {
  const empty = { added: [] as string[], updated: [] as string[], deleted: [] as string[] };

  const prompt = `Extract durable facts or preferences about the user from this exchange that would be useful to remember in future, unrelated conversations (e.g. their name, location, dietary restrictions, job, ongoing projects, stated preferences). Ignore anything transient or specific only to this one exchange.

Also extract statements that CHANGE or REVOKE a previously true fact (e.g. "user is no longer vegetarian", "user moved from Wellington to Auckland", "user finished the thesis they were writing"). Phrase these as the new current state.

Return ONLY a JSON array of short fact strings, one per fact. Return an empty array [] if there is nothing durable worth remembering.

User: ${userText}
Assistant: ${assistantText}`;

  const candidates = parseFactsJson(await callMiniMaxNonStreaming(env, prompt));
  if (candidates.length === 0) return empty;

  // Phase 1: embed once per candidate; drop exact dupes, collect related
  // existing memories for anything that survives.
  const survivors: { text: string; vector: number[] }[] = [];
  const related = new Map<string, string>(); // real id -> text (deduped across candidates)
  for (const text of candidates) {
    const vector = await embed(env, text);
    const { matches } = await env.VECTORIZE.query(vector, {
      topK: 5,
      returnMetadata: "all",
      filter: { namespace: userEmail },
    });
    if ((matches[0]?.score ?? 0) >= DEDUP_SCORE_THRESHOLD) continue; // fast-path dedup
    for (const m of matches) {
      if ((m.score ?? 0) >= RELATED_SCORE_THRESHOLD) {
        related.set(m.id, String(m.metadata?.text ?? ""));
      }
    }
    survivors.push({ text, vector });
  }
  if (survivors.length === 0) return empty;

  // Phase 2: reconcile. Skip the LLM call when nothing can conflict.
  let decisions: Decision[];
  if (related.size === 0) {
    decisions = survivors.map((s) => ({ action: "ADD", text: s.text }));
  } else {
    // Short aliases (m1, m2, …) so the model never has to reproduce a UUID.
    const aliasToId = new Map<string, string>();
    const aliasEntries: { alias: string; text: string }[] = [];
    let n = 1;
    for (const [id, text] of related) {
      const alias = `m${n++}`;
      aliasToId.set(alias, id);
      aliasEntries.push({ alias, text });
    }
    try {
      const raw = await callMiniMaxNonStreaming(env, reconcilePrompt(survivors.map((s) => s.text), aliasEntries));
      decisions = parseDecisions(raw, aliasToId);
    } catch {
      // Reconciliation failed (timeout/bad response) — degrade to append-only.
      decisions = survivors.map((s) => ({ action: "ADD", text: s.text }));
    }
  }

  // Phase 3: apply. Reuse the phase-1 vector for a plain ADD of an unchanged
  // candidate; re-embed when the reconciler merged/rewrote the wording.
  const vectorByText = new Map(survivors.map((s) => [s.text, s.vector]));
  const added: string[] = [];
  const updated: string[] = [];
  const deleted: string[] = [];
  for (const d of decisions) {
    if (d.action === "ADD") {
      const vector = vectorByText.get(d.text) ?? (await embed(env, d.text));
      await addFact(env, userEmail, d.text, vector);
      added.push(d.text);
    } else if (d.action === "UPDATE") {
      await updateFact(env, userEmail, d.targetId, d.text);
      updated.push(d.text);
    } else if (d.action === "DELETE") {
      await deleteMemory(env, userEmail, d.targetId);
      deleted.push(d.targetId);
    }
  }

  return { added, updated, deleted };
}

export async function listMemories(env: Env, userEmail: string): Promise<MemoryFactRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, namespace, text, source, created_at, updated_at FROM memory_facts WHERE namespace = ? AND user_email = ? ORDER BY COALESCE(updated_at, created_at) DESC",
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
