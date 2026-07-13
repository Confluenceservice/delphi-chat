# Durable Conversations + Chat Quality-of-Life — Design

Date: 2026-07-13
Status: Draft (for review)

## Context

Two related upgrades, inspired by what LibreChat does well but scoped to Delphi
Chat's single-user, one-Worker, simple-UI philosophy:

1. **Durable conversations.** Threads currently live only in `localStorage`.
   Browsers treat that as disposable: iOS Safari evicts all site storage after
   ~7 days of non-use for non-installed sites, "Clear History and Website Data"
   wipes it, and ITP can purge it independently of app deploys. Result: chats
   vanish. Fix: make the existing **D1** database the source of truth, with
   localStorage demoted to a fast-load/offline cache.
2. **Per-message and per-thread smarts** (the LibreChat-adopted set): auto
   thread titles, stop generation, message actions (copy / edit-and-resend /
   regenerate, linear semantics — no branching tree), thread search, and
   export/import.

### Locked decisions

- **Server storage: D1** (already bound for memory facts). Not IndexedDB —
  IndexedDB is still device-bound and evictable; it only solves the size
  problem, not the durability problem. D1 also opens the door to cross-device
  later.
- **Sync model: write-through, last-write-wins.** Single user, no CRDTs, no
  merge UI. localStorage stays as cache so the app opens instantly and works
  offline; D1 is truth.
- **Linear history only.** Edit-and-resend truncates everything after the
  edited message and replays. Regenerate replaces the last assistant reply.
  No LibreChat-style fork trees — that's where their UI complexity lives.
- **Access control: already solved.** Cloudflare Access protects the app;
  `worker/auth.ts` verifies the `Cf-Access-Jwt-Assertion` JWT on `/api/*` and
  `resolveUserEmail` yields a verified identity. No new auth work. The
  verified **email becomes the owner key** on threads (`owner_email` column),
  so server-side conversations are scoped per identity from day one and
  multi-user "just works" later. Reuses the same pattern as memory namespacing.
- **Images:** attached images are data URLs today. v1 stores them inline in
  the message row **if** they fit D1 bound-parameter limits (verify during
  implementation; downscale client-side at attach time to ≤~1MP JPEG as a
  safety net). R2 offload is deliberately deferred — note it as follow-up if
  limits bite.

## Architecture

```
Browser PWA                          Cloudflare Worker
  useThreads (state)                   /api/threads        GET  → thread metadata list
    │  mutations                       /api/threads/:id    GET  → full thread (messages)
    ▼                                  /api/threads/:id    PUT  → upsert thread + messages
  storage.ts                           /api/threads/:id    DEL  → delete thread
    ├─ localStorage cache (instant)    /api/title          POST → M2.7 ≤6-word title
    └─ syncQueue ──debounced──────────►      │
         (push on complete message,          ▼
          retry on reconnect)              D1: threads, messages tables
```

- **Truth:** D1. **Cache:** localStorage (unchanged format).
- **Write path:** after a mutation settles (user message appended, stream
  `onDone`, title set, edit/regenerate committed), enqueue the thread id; a
  debounced (~2 s) worker pushes `PUT /api/threads/:id` with the **full thread
  JSON**. Server transactionally upserts the thread row and delete-reinserts
  its messages. Full-replace is wasteful in theory, trivial and idempotent in
  practice at personal scale. Never sync mid-stream.
- **Read path:** on app start, render from localStorage immediately, then
  `GET /api/threads`; reconcile by `updated_at` (server newer → refresh cache
  and UI). Thread bodies fetched lazily on open if not cached.
- **Offline:** pending pushes persist in the queue (localStorage) and retry
  when `ConnectionBanner` reports reconnect. Failure is silent-with-indicator
  (small "not synced" dot on the thread row), never a blocking error.
- **Migration:** first load with a valid token and empty D1 → push all local
  threads up. No flag day; the cache format doesn't change.

## D1 schema

```sql
CREATE TABLE threads (
  id          TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,             -- from resolveUserEmail (CF Access)
  title       TEXT NOT NULL,
  model      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE messages (
  id         TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,          -- order within thread
  role       TEXT NOT NULL,             -- 'user' | 'assistant'
  content    TEXT NOT NULL,
  images     TEXT,                      -- JSON array of data URLs, nullable
  sources    TEXT,                      -- JSON array of {title,url}, nullable
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_messages_thread ON messages(thread_id, seq);
```

Same D1 database as memory facts — one binding, separate tables.

## Feature specs (quality-of-life set)

### Auto thread titles
After the **first** assistant reply completes, client calls
`POST /api/title { user, assistant }`. Worker prompts `MiniMax-M2.7`:
"Summarize this exchange as a chat title, ≤6 words, no quotes." Updates thread
title → drawer re-renders → sync. Falls back silently to the current
first-40-chars behavior on error. Never re-titles after a manual rename
(add `titleEdited` flag on Thread).

### Stop generation
`streamChat` already accepts `signal`. Add an `AbortController` per send in
`App.tsx`; while `streaming`, the composer's send button becomes a Stop button
(icon swap, same position — zero new UI surface). Abort keeps partial text,
runs `onDone` cleanup, skips memory ingest.

### Message actions (long-press / hover menu)
- **Copy** — `navigator.clipboard.writeText` on the stripped content.
- **Edit & resend** (user messages) — composer pre-fills the text; on send,
  truncate the thread at that message (remove it and everything after) and
  replay through `handleSend`. Linear semantics, one confirm-free gesture.
- **Regenerate** (last assistant message only) — remove it, re-call
  `streamChat` with the same history.
All three route through existing `useThreads` mutations + sync queue.

### Thread search
Input at the top of `ThreadDrawer`. Client-side, case-insensitive filter over
titles **and** message content of cached threads. No server index, no
Meilisearch — this is the payoff of small personal scale.

### Export / import
Settings → "Export chats": download `delphi-threads-<date>.json` (the full
Thread[] shape). "Import": file picker, merge by thread id (imported wins on
conflict), then sync everything up. Doubles as the disaster-recovery story.

## Milestones (each independently verifiable)

1. **D1 threads backend** — schema + `/api/threads*` CRUD, gated by the
   existing Access middleware and scoped to `resolveUserEmail`. Done when: an
   authenticated request round-trips a thread; a request for another owner's
   thread id returns 404.
2. **Client sync** — sync queue, write-through, start-up reconcile, migration
   push, "not synced" indicator. Done when: clear all site data in the
   browser, reload, re-auth through Access → all chats reappear.
3. **Stop + auto-titles** — Done when: Stop halts a stream keeping partial
   text; a new chat gets a sensible ≤6-word title after the first reply.
4. **Message actions** — Done when: edit a mid-thread user message → tail is
   replaced by a fresh reply; regenerate swaps the last answer; copy works on
   iOS.
5. **Search + export/import** — Done when: drawer filters as you type; export
   → wipe → import restores everything.

## Verification

- **Durability (the headline test):** chat on the phone → Settings → Safari →
  Clear History and Website Data → reopen PWA → Access login → threads intact.
- **Dev:** `wrangler dev` with `DEV_USER_EMAIL` in `.dev.vars` exercises the
  owner-scoped paths locally (same fallback the memory endpoints use).
- **Offline:** airplane mode → send fails gracefully, edits queue → reconnect
  → dot clears, D1 matches.
- **Limits:** attach a large photo → confirm downscale keeps the PUT under D1
  parameter limits; log and placeholder (`[image too large to sync]`) if not.
- **Two-device smoke (bonus):** log in on the laptop with the same Access
  identity → phone's threads appear (last-write-wins on concurrent edits).

## Consistency housekeeping (ride-along, optional)

Memory facts are **already email-scoped** in `worker/memory.ts` (D1
`user_email` column; Vectorize dedup filtered on `namespace` metadata set to
the email). Two cleanups can ride along with Milestone 1:

- Migration to drop the vestigial `namespace` column from `memory_facts` and
  remove the `NAMESPACE = "default"` constant from the four queries that still
  bind it. Cosmetic; no behavior change.
- Update `2026-07-11-minimax-chat-design.md` ("no login", "single fixed
  namespace") to reflect the Access + per-email reality, so future specs
  aren't misled by stale docs.

## Explicitly out of scope

Fork/branch trees, multi-user accounts, R2 image offload, server-side search
index, real-time multi-device sync (polling on app-open is enough), presets UI
beyond a custom-instructions textarea (can ride along later).
