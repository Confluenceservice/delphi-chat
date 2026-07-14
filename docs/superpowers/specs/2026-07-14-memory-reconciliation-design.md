# Memory Reconciliation (ADD / UPDATE / DELETE) — Design

Date: 2026-07-14
Status: Draft (for review)
Touches: `worker/memory.ts`, extraction prompt, migration 0007

## Context

Ingest today is append-only with dedup: extract candidate facts → embed →
Vectorize similarity check (≥ 0.93 → skip) → insert. Two failure modes:

1. **Stale facts never die.** "Lives in Wellington" and "Lives in Auckland"
   are not near-duplicates (similarity ~0.8), so both get stored and both get
   injected every turn. The model sees contradictory facts and picks one at
   random.
2. **Negations are invisible.** "I'm not vegetarian anymore" produces no
   durable fact under the current extraction prompt, so "User is vegetarian"
   lives forever.

This is the same problem Mem0 solves with a two-phase pipeline: extract
candidates, then run one LLM *reconciliation* pass that sees the candidates
alongside the most-similar existing memories and decides ADD / UPDATE /
DELETE / NONE per candidate. We adopt that shape, sized for this app.

### Locked decisions

- **Reconcile in one LLM call per exchange, not per fact.** Candidates are
  already batched from one exchange; similar existing facts are fetched per
  candidate and merged into a single prompt. One extra MiniMax call per
  ingest, total (extraction + reconciliation = 2 calls, vs 1 today).
- **Keep the cheap dedup fast-path.** If a candidate's top match scores
  ≥ 0.93, drop it before reconciliation. Saves tokens on the common
  "user repeats themselves" case; the reconciler only sees genuinely new or
  conflicting material.
- **UPDATE rewrites in place, keeping the row id.** D1: `UPDATE ... SET
  text, updated_at`. Vectorize: `upsert()` with the same id overwrites the
  vector — no delete+reinsert dance, and ids stay stable for the
  MemoryPanel and future shared-spaces re-namespacing.
- **DELETE requires an explicit contradiction.** The reconciler may only
  delete when the new information negates the old ("no longer X", "sold the
  Y"). Ambiguity → ADD. Losing a true fact is worse than carrying a
  redundant one at this scale.
- **Extraction prompt must surface changes.** Reconciliation can only act on
  what extraction emits, so the extraction prompt gains: *"Also extract
  statements that change or revoke previously true facts (e.g. 'user is no
  longer vegetarian', 'user moved from Wellington to Auckland')."* Without
  this, DELETE/UPDATE never trigger.
- **Injection order becomes `updated_at DESC`.** An updated fact is fresh
  again; recency ordering should reflect the edit, not the original insert.

## Schema (migration 0007)

```sql
ALTER TABLE memory_facts ADD COLUMN updated_at INTEGER;
UPDATE memory_facts SET updated_at = created_at;
```

(`updated_at` nullable for the ALTER; backfilled, and always written by new
code. D1/SQLite can't add NOT NULL with non-constant default.)

## Pipeline (`ingestExchange` rewrite)

```
extract candidates (1 LLM call, prompt now includes change/negation clause)
  │
  ├─ for each candidate: embed → Vectorize topK 5, filter namespace=email,
  │     returnMetadata "all"
  │        score ≥ 0.93 → drop candidate (fast-path dedup)
  │        score ≥ 0.70 → collect {id, text} as "related existing memory"
  │
  ├─ no survivors → done
  ├─ survivors but zero related memories → plain ADD for all (skip LLM call)
  │
  └─ reconcile (1 LLM call): candidates + related memories → decisions[]
        ADD    {text}          → insert D1 + Vectorize (as today)
        UPDATE {targetId,text} → D1 UPDATE text/updated_at;
                                 Vectorize upsert same id, new vector+metadata
        DELETE {targetId}      → D1 DELETE; Vectorize deleteByIds
        NONE                   → skip
```

### Reconciliation prompt (sketch)

```
You maintain a user's long-term memory. Reconcile NEW candidate facts
against EXISTING memories.

EXISTING (id: text):
m1: Lives in Wellington
m2: Is vegetarian

NEW candidates:
- Moved to Auckland last month
- Has a golden retriever

Rules:
- UPDATE an existing memory when the new fact supersedes it (moves, job
  changes, preference changes). Write the merged, current fact.
- DELETE only when the new fact explicitly negates an existing one and
  nothing replaces it ("is no longer vegetarian" with no new diet).
- ADD when the fact is new and coexists with everything ("has a dog" does
  not conflict with "has a cat").
- NONE when it duplicates an existing memory.

Return ONLY a JSON array:
[{"action":"UPDATE","targetId":"m1","text":"Lives in Auckland (moved from
Wellington, 2026)"},
 {"action":"ADD","text":"Has a golden retriever"}]
```

Note the m1-style aliases: short ids in the prompt, mapped back to real
UUIDs in code, so the model never has to reproduce a UUID correctly.

### Code sketch (`worker/memory.ts`)

```ts
type Decision =
  | { action: "ADD"; text: string }
  | { action: "UPDATE"; targetId: string; text: string }
  | { action: "DELETE"; targetId: string }
  | { action: "NONE" };

const RELATED_SCORE_THRESHOLD = 0.7; // below this, existing facts aren't shown to the reconciler

export async function ingestExchange(env, userEmail, userText, assistantText) {
  const candidates = parseFactsJson(await callMiniMaxNonStreaming(env, extractionPrompt));
  if (!candidates.length) return { added: [], updated: [], deleted: [] };

  // Phase 1: embed once per candidate, gather related existing memories.
  const survivors: { text: string; vector: number[] }[] = [];
  const related = new Map<string, string>(); // id -> text (dedup across candidates)
  for (const text of candidates) {
    const vector = await embed(env, text);
    const { matches } = await env.VECTORIZE.query(vector, {
      topK: 5, returnMetadata: "all", filter: { namespace: userEmail },
    });
    if ((matches[0]?.score ?? 0) >= DEDUP_SCORE_THRESHOLD) continue; // fast-path
    for (const m of matches) {
      if (m.score >= RELATED_SCORE_THRESHOLD)
        related.set(m.id, String(m.metadata?.text ?? ""));
    }
    survivors.push({ text, vector });
  }
  if (!survivors.length) return { added: [], updated: [], deleted: [] };

  // Phase 2: reconcile (skip the LLM call when nothing can conflict).
  const decisions: Decision[] = related.size
    ? parseDecisions(await callMiniMaxNonStreaming(env, reconcilePrompt(survivors, related)))
    : survivors.map((s) => ({ action: "ADD", text: s.text }));

  // Phase 3: apply. Re-embed UPDATE texts (reconciler may have merged wording).
  for (const d of decisions) {
    if (d.action === "ADD")     await addFact(env, userEmail, d.text /*, reuse vector if unchanged */);
    if (d.action === "UPDATE")  await updateFact(env, userEmail, d.targetId, d.text);
    if (d.action === "DELETE")  await deleteMemory(env, userEmail, d.targetId);
  }
  ...
}

async function updateFact(env, userEmail, id, text) {
  const res = await env.DB.prepare(
    "UPDATE memory_facts SET text = ?, updated_at = ? WHERE id = ? AND user_email = ?",
  ).bind(text, now(), id, userEmail).run();
  if (res.meta.changes === 0) return; // reconciler hallucinated an id — ignore
  await env.VECTORIZE.upsert([
    { id, values: await embed(env, text), metadata: { namespace: userEmail, text } },
  ]);
}
```

Guardrails in `parseDecisions`: unknown `action` → NONE; `targetId` not in
the alias map → downgrade UPDATE to ADD, drop DELETE. The D1 `WHERE
user_email = ?` clause is the hard backstop — the model can never touch
another user's rows regardless of what id it emits.

## Cost & failure notes

- Steady state: 2 non-streaming MiniMax calls per ingest (extraction +
  reconciliation), reconciliation skipped when no related memories exist.
  Embeddings: one per candidate + one per UPDATE.
- Reconciliation failure (bad JSON, timeout) → fall back to today's
  behavior: plain ADD of all survivors. Memory degrades to append-only,
  never loses data.
- D1 write + Vectorize upsert are not transactional. Order writes D1-first;
  a crash between them leaves a stale vector whose id still resolves to the
  corrected D1 row — retrieval reads text from D1, so injected facts stay
  correct; only dedup/related matching sees slightly stale vectors.

## Verification

1. **UPDATE:** seed "Lives in Wellington"; say "we moved to Auckland last
   month" → list shows one location fact, Auckland; Wellington gone.
2. **DELETE:** seed "Is vegetarian"; say "I'm not vegetarian anymore, eating
   everything again" → fact removed (or replaced by the new diet, also
   acceptable).
3. **Coexist:** seed "Has a cat named Miso"; say "we got a golden retriever"
   → both facts present.
4. **Dedup fast-path:** repeat "I live in Auckland" → no reconciliation call
   (log it), no new row.
5. **Fallback:** force reconciler to return garbage → facts still ADDed,
   chat turn unaffected.

## Explicitly out of scope

Fact history/undo (a `memory_facts_history` table is the natural v2 if
UPDATE/DELETE ever misfire in practice), temporal validity ranges
(Graphiti-style "valid from/until"), applying reconciliation to shared
spaces (needs the attribution rules from the shared-spaces spec first),
semantic retrieval at read time (inject-all is still right at ≤40 facts).
