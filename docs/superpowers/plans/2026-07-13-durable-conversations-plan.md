# Durable Conversations + Chat QoL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make D1 the source of truth for conversations (localStorage demoted to cache), and add stop-generation, auto thread titles, message actions (copy / edit-and-resend / regenerate), thread search, and export/import.

**Spec:** docs/superpowers/specs/2026-07-13-durable-conversations-design.md

**Architecture:** New `threads`/`messages` D1 tables scoped by `owner_email` (from the existing Access middleware in `worker/index.ts`). Client keeps its current localStorage flow untouched for reads/writes, and adds a sync layer: a debounced write-through queue pushing full threads to `PUT /api/threads/:id` after mutations settle, plus a start-up reconcile from `GET /api/threads`. Message actions use linear semantics (edit truncates the tail and replays; regenerate replaces the last assistant reply). No branching.

**Tech Stack:** TypeScript, Cloudflare Workers (`worker/`), React + Vite (`src/`), no test framework, no new dependencies.

## Global Constraints

- No new npm dependencies. No new env vars.
- All new `/api/*` routes go through the existing `resolveUserEmail` gate in `worker/index.ts` `route()` — handlers receive `userEmail` like `handleMemoryList` does. Ownership violations return **404** (not 403) so thread ids don't leak existence.
- Client SSE chat contract is untouched. Sync never runs mid-stream: push only after a message is complete (send committed, stream `onDone`, edit/regenerate committed, title set, thread deleted).
- Full-thread replace on PUT: server upserts the thread row and delete-reinserts its messages in one `env.DB.batch()`. Idempotent, last-write-wins by `updated_at`.
- **No test runner exists in this repo.** Each task's gate is `npm run build` (tsc -b) plus the manual smoke check named in the task. Do not add a test framework.
- Follow existing code patterns: `json`/`jsonError` helpers as in `worker/memory-routes.ts`, storage key conventions as in `src/state/storage.ts`.

---

## File Structure

- `worker/thread-routes.ts` (create) — CRUD handlers + SQL for threads/messages.
- `worker/title.ts` (create) — `POST /api/title` handler (MiniMax-M2.7, non-streaming).
- `worker/index.ts` (modify) — route the new endpoints.
- `migrations/` or equivalent (create SQL) — threads/messages tables.
- `src/api/threads.ts` (create) — fetch wrappers for the new endpoints.
- `src/state/sync.ts` (create) — dirty-set + debounced push queue + reconcile.
- `src/state/useThreads.ts` (modify) — mark-dirty hooks on mutations; truncate/replace helpers for message actions; `syncState` per thread.
- `src/App.tsx` (modify) — AbortController for stop; auto-title call; edit/regenerate handlers; boot-time reconcile.
- `src/ui/Composer.tsx` (modify) — send button becomes Stop while streaming.
- `src/ui/MessageList.tsx` (modify) — per-message action row (copy / edit / regenerate).
- `src/ui/ThreadDrawer.tsx` (modify) — search input + "not synced" dot.
- Settings component (modify) — Export / Import buttons.
- `src/App.css` (modify) — styles for actions row, search input, sync dot.

---

## Task 1: D1 schema

**Files:**
- Create: migration SQL (follow the repo's existing convention — if a `migrations/` directory with numbered files exists, add the next number; otherwise apply via `wrangler d1 execute DB --file=...` and commit the file under `migrations/` anyway for the record).

- [ ] **Step 1: Write the migration**

```sql
CREATE TABLE threads (
  id          TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  title       TEXT NOT NULL,
  model       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_threads_owner ON threads(owner_email, updated_at DESC);

CREATE TABLE messages (
  id         TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  images     TEXT,
  sources    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_messages_thread ON messages(thread_id, seq);
```

- [ ] **Step 2: Apply locally and remotely** (`--local` for `wrangler dev`, then remote). Verify with `wrangler d1 execute ... --command "SELECT name FROM sqlite_master"` that both tables exist.

- [ ] **Step 3: Commit** — `git commit -m "feat: D1 schema for durable conversations"`

---

## Task 2: Worker — thread CRUD

**Files:**
- Create: `worker/thread-routes.ts`
- Modify: `worker/index.ts`
- Reference: `worker/memory-routes.ts` (handler/json patterns), `worker/types.ts` (`Env`)

**Interfaces:**
- `GET /api/threads` → `{ threads: [{ id, title, model, createdAt, updatedAt }] }` (owner's, newest first, no messages)
- `GET /api/threads/:id` → full thread incl. `messages: [{ id, role, content, images?, sources?, createdAt }]` ordered by `seq`; 404 if absent or not owner's
- `PUT /api/threads/:id` → body is the full client Thread JSON; upsert thread row (owner = caller) + delete-reinsert messages via `env.DB.batch()`; reject with 404 if the id exists under a different owner
- `DELETE /api/threads/:id` → same ownership rule; cascade removes messages

- [ ] **Step 1: Implement handlers** in `worker/thread-routes.ts`. `seq` = array index on write. `images`/`sources` JSON-stringified when present, NULL otherwise. Batch order: `DELETE FROM messages WHERE thread_id=?` → thread `INSERT ... ON CONFLICT(id) DO UPDATE` (guard `owner_email` in the WHERE of the update) → one `INSERT` per message (chunk the batch if a thread exceeds ~90 statements).
- [ ] **Step 2: Route** in `worker/index.ts` inside the authed block, matching `/api/threads` exactly and `/api/threads/<id>` by prefix, passing `userEmail`.
- [ ] **Step 3: Gate** — `npm run build`; then with `wrangler dev` + `DEV_USER_EMAIL`, curl a PUT→GET→list→DELETE round-trip. Change `DEV_USER_EMAIL` and confirm the other user's GET returns 404.
- [ ] **Step 4: Commit**

---

## Task 3: Worker — auto-title endpoint

**Files:**
- Create: `worker/title.ts`
- Modify: `worker/index.ts`
- Reference: `worker/chat.ts` for the chat/completions call shape and error envelope

**Interfaces:**
- `POST /api/title` body `{ user, assistant }` → `{ title }`

- [ ] **Step 1: Implement** — non-streaming `POST {MINIMAX_BASE_URL}/v1/chat/completions`, model `MiniMax-M2.7`, system: "Write a chat title for this exchange. At most 6 words. No quotes, no trailing punctuation. Reply with the title only." Truncate result to 60 chars; on any upstream error return `{ title: null }` with status 200 (client falls back silently).
- [ ] **Step 2: Route + gate** — `npm run build`; curl returns a sensible title for a sample exchange.
- [ ] **Step 3: Commit**

---

## Task 4: Client — sync engine

**Files:**
- Create: `src/api/threads.ts`, `src/state/sync.ts`
- Modify: `src/state/useThreads.ts`
- Reference: `src/state/storage.ts` (key conventions), `src/api/memory.ts` (fetch wrapper style)

**Interfaces:**
- `sync.markDirty(threadId)` — adds to a persisted dirty set (localStorage, same key prefix as existing storage) and schedules a debounced (2 s) flush.
- `sync.flush()` — for each dirty id: read thread from local state, `PUT /api/threads/:id`; on success clear from dirty set; on failure keep it (retried on next flush / reconnect / app focus).
- `sync.deleteRemote(threadId)` — immediate DELETE, queued the same way if offline.
- `sync.reconcile(localThreads)` — `GET /api/threads`; for each remote thread newer than local (or missing locally) fetch the body and merge into state; push local threads missing remotely (first-run migration falls out of this for free).
- `useThreads` exposes `syncState: Record<threadId, "synced"|"pending"|"error">` for the UI.

- [ ] **Step 1: Implement `src/api/threads.ts`** (list/get/put/del wrappers, credentials/same-origin as existing api modules).
- [ ] **Step 2: Implement `src/state/sync.ts`** as above. Listen for `online` and `visibilitychange` to trigger flush.
- [ ] **Step 3: Hook `markDirty`** into every settled mutation in `useThreads` (create thread, append complete message, rename, delete → `deleteRemote`). Do **not** hook streaming token updates.
- [ ] **Step 4: Call `reconcile`** once on app boot in `App.tsx` after local threads load.
- [ ] **Step 5: Gate** — `npm run build`; manual: chat in `wrangler dev`+vite, then clear site data, reload → threads reappear. Airplane-mode a send → edit persists locally, dot pending → back online → flush clears it.
- [ ] **Step 6: Commit**

---

## Task 5: Stop generation + auto-titles wiring

**Files:**
- Modify: `src/App.tsx`, `src/ui/Composer.tsx`, `src/App.css`
- Reference: `src/api/chat.ts` (`streamChat` already accepts `signal`)

- [ ] **Step 1: Stop** — create an `AbortController` per send in `App.tsx`, pass `signal` to `streamChat`; Composer receives `streaming` + `onStop`, and the send button swaps to a Stop icon (square) while streaming. Abort keeps the partial text, runs the normal `onDone` finalization, and **skips memory ingest** for that turn.
- [ ] **Step 2: Auto-title** — in the send flow, when a thread's first assistant reply completes and the thread has no custom title (add a `titleEdited` flag to `Thread`, set by manual rename), call `/api/title` and apply the result via the existing rename mutation (which marks dirty). Silent fallback on `title: null`.
- [ ] **Step 3: Gate** — `npm run build`; Stop halts mid-stream keeping partial text; a fresh chat gets a ≤6-word title; a manually renamed thread never gets re-titled.
- [ ] **Step 4: Commit**

---

## Task 6: Message actions (copy / edit-and-resend / regenerate)

**Files:**
- Modify: `src/ui/MessageList.tsx`, `src/state/useThreads.ts`, `src/App.tsx`, `src/App.css`

- [ ] **Step 1: `useThreads` helpers** — `truncateFrom(threadId, messageId)` (remove that message and everything after) and `dropLastAssistant(threadId)`. Both mark dirty.
- [ ] **Step 2: UI** — compact action row under each bubble (visible on tap/hover, matching the app's minimal style): Copy on all messages (`navigator.clipboard.writeText`, brief "Copied" affordance); Edit on user messages; Regenerate on the last assistant message only.
- [ ] **Step 3: Wiring in `App.tsx`** — Edit: prefill the Composer with the message text (and images if present), stash the target id; on send, `truncateFrom(target)` then run the normal send path. Regenerate: `dropLastAssistant`, then re-invoke the stream with the existing history.
- [ ] **Step 4: Gate** — `npm run build`; edit a mid-thread user message → tail replaced by a fresh reply; regenerate swaps the last answer; copy works on iOS Safari. Sync dot cycles pending→synced after each.
- [ ] **Step 5: Commit**

---

## Task 7: Thread search + export/import + sync dot

**Files:**
- Modify: `src/ui/ThreadDrawer.tsx`, Settings component, `src/App.css`

- [ ] **Step 1: Search** — input at the top of the drawer; case-insensitive filter over thread titles **and** message content from local state. Empty query = current list.
- [ ] **Step 2: Sync dot** — small dot on thread rows when `syncState` is `pending`/`error` (title attribute explains).
- [ ] **Step 3: Export** — Settings button: serialize all threads to `delphi-threads-<yyyy-mm-dd>.json`, download via Blob URL.
- [ ] **Step 4: Import** — file input; parse, merge by thread id (imported wins), mark all imported dirty so they push to D1.
- [ ] **Step 5: Gate** — `npm run build`; filter narrows as you type; export → clear site data → import → everything back locally **and** re-synced.
- [ ] **Step 6: Commit**

---

## Task 8 (ride-along, optional): memory namespace cleanup + doc truth

- [ ] Migration dropping the vestigial `namespace` column from `memory_facts`; remove the `NAMESPACE` constant and its bindings from the four queries in `worker/memory.ts`. Gate: `npm run build` + memory list/ingest smoke unchanged.
- [ ] Update `docs/superpowers/specs/2026-07-11-minimax-chat-design.md` to reflect Cloudflare Access + per-email scoping (remove "no login" / "single fixed namespace").
- [ ] Commit.

---

## Final verification (from the spec)

- Clear History and Website Data on the phone → reopen PWA → Access login → all threads intact.
- Airplane-mode edits queue and flush on reconnect; D1 matches.
- Oversized image attach: confirm the PUT succeeds or degrades to a `[image too large to sync]` placeholder — log which D1 parameter limit applies and note it in the spec.
