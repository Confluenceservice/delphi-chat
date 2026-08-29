# Delphi Chat

Mobile-friendly chat app powered by the MiniMax model family (Token Plan). React +
Vite frontend, single Cloudflare Worker backend (chat proxy, TTS, STT, memory,
knowledge base).

Test push-to-talk, read-aloud, and conversation mode on the deployed Access-protected
custom domain (see `routes` in `wrangler.toml`) — `wrangler dev` on localhost can't be
reached from a phone, and mic/service-worker access needs a secure context.

## Architecture

One Worker serves everything. The `[assets]` binding serves the built SPA; anything
under `/api/*` is handled by `worker/index.ts`, which dispatches on path. Same
origin throughout, so there is no CORS config and provider keys never reach the
browser.

```
Browser SPA (React + Vite)
      │  same-origin fetch
      ▼
Cloudflare Worker  ──▶ Access JWT verification (every /api/* request)
      │
      ├── /api/chat ──┬── text turn  ──▶ MiniMax /anthropic/v1/messages (+ web_search)
      │               └── image turn ──▶ MiniMax /v1/chat/completions
      ├── /api/tts ──────────────────▶ MiniMax /v1/t2a_v2
      ├── /api/stt ──────────────────▶ Groq (or OpenAI) Whisper
      │
      ├── D1          threads, messages, memory facts, persona, voice,
      │               knowledge base, review queue, audit log
      ├── Vectorize   one index, partitioned by `namespace` metadata
      └── Workers AI  @cf/baai/bge-m3 embeddings (1024-dim)
```

**Authentication.** Every `/api/*` request must carry a Cloudflare Access JWT in
`Cf-Access-Jwt-Assertion`. `worker/auth.ts` verifies it against the team's JWKS
(cached one hour per isolate) and checks algorithm, expiry, issuer, audience, and
that an email claim is present. No valid token means 401 — there is no unauthenticated
path to any provider. Locally, `DEV_USER_EMAIL` stands in for a verified email.

**Per-user isolation.** The verified email is the partition key everywhere:
`threads.owner_email`, `memory_facts.user_email`, and the Vectorize `namespace`
metadata field. One user cannot read another's threads or memories.

**Vectorize partitioning.** Personal memory and the shared knowledge base live in
the *same* index, separated by the indexed `namespace` field — set to the user's
email for memory, and to the literal `kb` for the knowledge base. Emails always
contain `@`, so the two can never collide.

**Admin.** `ADMIN_EMAILS` is a comma-separated allowlist. Admins can read the audit
log and manage the knowledge base; everything else is per-user.

## Features

**Chat.** Streaming SSE responses, model picker (`MiniMax-M3`, `MiniMax-M2.7`),
image input for vision turns, and reasoning blocks rendered separately from the
answer (`<think>` content is split out by `src/lib/thinking.ts`).

**Web search.** Always on for text-only turns — the model decides when to search,
and cited sources render under the reply. Turns containing images fall back to the
plain completions endpoint and have no search. The system prompt only advertises
search when it is actually available, so the model never claims it looked something
up when it couldn't.

**Voice.** Read-aloud via MiniMax TTS with a per-user voice preference, push-to-talk
transcription via Whisper, and a hands-free conversation mode with voice activity
detection.

**Memory.** After each exchange the model extracts candidate facts, which are
embedded and reconciled against what is already stored: near-identical facts
(cosine ≥ 0.93) are dropped as duplicates, and related ones (≥ 0.7) are shown to a
reconciliation pass that decides ADD, UPDATE, or DELETE — so "I moved to Berlin"
updates the old city rather than accumulating a contradiction. Relevant facts are
retrieved and injected into the system prompt each turn. If reconciliation fails,
it degrades to append-only rather than losing the fact.

**Threads.** Conversations persist in D1, scoped to the owning email. The client
keeps its localStorage flow and syncs write-through after each completed message,
reconciling from the server on startup. Titles are generated automatically from the
first exchange. Threads can be exported to JSON.

**Persona.** A per-user custom system prompt (up to 2000 characters) prepended to
every turn.

**Knowledge base and tutor mode.** An org-wide grounded corpus, separate from
personal memory. On each turn the top 4 matching excerpts above a 0.5 cosine score
are injected as evidence with `[n]` citations; below that threshold the turn falls
back to general knowledge. Two answer modes: **Answer** (direct, lead with the
conclusion) and **Tutor** (why it matters, numbered steps, jargon defined inline,
and a two-minute exercise). Any user can suggest a question/answer pair for the
corpus; suggestions land in a review queue that only admins can approve or dismiss.
A seed corpus of AI-literacy documents ships with the app.

**Audit log.** Every `/api/*` request is recorded with user, method, path, status,
duration, and error. Logging failures never break the response. Admins read the
last 100 entries.

### Settings panel

| Section | What it does |
|---|---|
| Persona | Edit the custom system prompt |
| Voice | Pick the TTS voice, with preview |
| What Delphi remembers | List, delete individual facts, or clear all memory |
| Conversations | Thread management and JSON export |
| Account | Signed-in identity |

## API

All routes require a valid Access JWT. "Admin" additionally requires the caller's
email to be in `ADMIN_EMAILS`.

| Route | Method | Access | Purpose |
|---|---|---|---|
| `/api/chat` | POST | user | Streaming chat, with memory + KB grounding |
| `/api/title` | POST | user | Generate a thread title |
| `/api/tts` | POST | user | Text to speech (mp3) |
| `/api/stt` | POST | user | Speech to text |
| `/api/threads` | GET | user | List own threads |
| `/api/threads/:id` | GET/PUT/DELETE | user (owner) | Read, upsert, delete a thread |
| `/api/memory` | GET/DELETE | user | List own memory facts; DELETE clears all of them |
| `/api/memory/ingest` | POST | user | Extract and reconcile facts from an exchange |
| `/api/memory/:id` | DELETE | user | Forget one fact |
| `/api/persona` | GET/PUT | user | Read/write custom system prompt |
| `/api/voice` | GET/PUT | user | Read/write TTS voice preference |
| `/api/kb/suggest` | POST | user | Suggest a Q&A pair for the knowledge base |
| `/api/kb/queue` | GET | **admin** | List pending suggestions |
| `/api/kb/queue/:id/approve` | POST | **admin** | Approve into the corpus |
| `/api/kb/queue/:id/dismiss` | POST | **admin** | Reject a suggestion |
| `/api/kb/docs` | GET | **admin** | List corpus documents |
| `/api/kb/docs/:id` | DELETE | **admin** | Delete a corpus document |
| `/api/kb/seed` | POST | **admin** | Load the seed corpus (idempotent) |
| `/api/admin/audit` | GET | **admin** | Last 100 audit entries |

## Model dependencies

Seven capabilities across three providers. Two of them — web search and
text-to-speech — have no equivalent outside MiniMax, which is why moving off it
is not simply "swap the base URL":

| Capability | Provider | Config | Swappable |
|---|---|---|---|
| Chat streaming | MiniMax `/v1/chat/completions` | `MINIMAX_API_KEY`, `MINIMAX_BASE_URL` | **Yes** — standard OpenAI shape, any compatible endpoint |
| Chat titles | MiniMax, model hardcoded (`MiniMax-M2.7`) | same | Yes, once the model ID moves to config |
| Memory extraction | MiniMax, model hardcoded (`MiniMax-M3`) | same | Yes, same caveat; also strips `<think>` blocks |
| Web search | MiniMax `/anthropic/v1/messages`, `web_search` server tool | same | **No** — MiniMax-only endpoint and response shape |
| Text-to-speech | MiniMax `/v1/t2a_v2` | same | **No** — MiniMax voice IDs, hex audio, `base_resp` envelope |
| Speech-to-text | Groq (default) or OpenAI Whisper | `ASR_PROVIDER`, `ASR_BASE_URL`, `ASR_MODEL`, `ASR_API_KEY` | **Already abstracted** |
| Embeddings | Cloudflare Workers AI `@cf/baai/bge-m3` | `[ai]` binding | Provider-free |

Practical consequence: pointing chat at another provider (OpenRouter, OpenAI,
a local endpoint) is a contained change, but web search and read-aloud have no
equivalent there and would stay on MiniMax or be lost. `worker/stt.ts` is the
existing template for how a provider seam should look here.

Selectable chat models live in `MODELS` in `src/state/types.ts`.
See `docs/superpowers/specs/2026-08-29-provider-seam-design.md` for a design that
makes the chat provider pluggable while keeping voice and search on MiniMax.

## Setup

1. Install deps:
   ```
   npm install
   ```
2. Create the D1 database and the Vectorize index:
   ```
   npx wrangler d1 create minimax-chat-memory
   npx wrangler vectorize create minimax-memory --dimensions 1024 --metric cosine
   ```
   The dimensions must match the embedding model (`@cf/baai/bge-m3`, 1024-dim).
   A mismatch fails at query time, not at creation.
3. Create your config from the template:
   ```
   cp wrangler.example.toml wrangler.toml
   ```
   `wrangler.toml` is gitignored because it holds account-specific values. Fill in
   the two placeholders: `routes.pattern` (the custom domain serving this Worker —
   the zone must already exist on your account) and `d1_databases.database_id`
   (printed by `d1 create` above, or `npx wrangler d1 info minimax-chat-memory`
   for an existing database).
4. Apply the schema:
   ```
   npx wrangler d1 migrations apply minimax-chat-memory --remote
   ```
   Eight migrations create the memory, settings, voice, audit, threads, and
   knowledge-base tables. Without this every `/api/*` call fails at runtime — the
   deploy itself still succeeds, so the breakage shows up only when the app is used.

   > On an **existing** database, run `npx wrangler d1 migrations list` first.
   > If the `d1_migrations` tracking table has drifted from the files on disk,
   > applying blind will try to re-run migrations whose tables already exist.
5. Set secrets (never commit these):
   ```
   npx wrangler secret put MINIMAX_API_KEY      # MiniMax Token Plan subscription key
   npx wrangler secret put ASR_API_KEY          # Groq (default) or OpenAI Whisper key
   npx wrangler secret put CF_ACCESS_TEAM_DOMAIN # e.g. https://yourteam.cloudflareaccess.com
   npx wrangler secret put CF_ACCESS_AUD        # Access Application Audience (AUD) tag
   npx wrangler secret put ADMIN_EMAILS         # comma-separated emails allowed to hit admin routes
   ```
   `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` are required — without them the Worker
   cannot verify `Cf-Access-Jwt-Assertion` and every `/api/*` request is rejected as
   unauthorized. Find both in the Cloudflare Zero Trust dashboard under
   Access > Applications > (this app) > Overview.
6. Optional vars in `wrangler.toml` (`MINIMAX_GROUP_ID`, `ASR_PROVIDER`, `ASR_BASE_URL`, `ASR_MODEL`).
7. `workers_dev` is set to `false` in `wrangler.toml` so the app is only reachable
   through the Access-protected custom domain — do not re-enable it without also
   protecting the workers.dev route in Access.
8. After the first deploy, load the seed knowledge base by calling
   `POST /api/kb/seed` as an admin. It is idempotent — running it twice is a no-op.

### Configuration reference

| Key | Kind | Required | Purpose |
|---|---|---|---|
| `MINIMAX_API_KEY` | secret | yes | Chat, web search, TTS |
| `MINIMAX_BASE_URL` | var | yes | Defaults to `https://api.minimax.io` |
| `MINIMAX_GROUP_ID` | var | no | Appended as `?GroupId=` when set |
| `ASR_API_KEY` | secret | yes | Speech-to-text provider key |
| `ASR_PROVIDER` | var | no | `groq` (default) or `openai` |
| `ASR_BASE_URL` | var | no | ASR endpoint base |
| `ASR_MODEL` | var | no | e.g. `whisper-large-v3-turbo` |
| `CF_ACCESS_TEAM_DOMAIN` | secret | yes | Access JWT issuer |
| `CF_ACCESS_AUD` | secret | yes | Access application audience tag |
| `ADMIN_EMAILS` | secret | no | Comma-separated admin allowlist |
| `DEV_USER_EMAIL` | `.dev.vars` | local only | Stands in for a verified email |

## Develop

```
npm run build   # builds the SPA into dist/
npx wrangler dev
```

Wrangler serves the built SPA and `/api/*` from one process (rebuild after frontend
changes, or run `npm run build -- --watch` alongside `wrangler dev`).

Note that `wrangler dev` in local mode cannot reach Vectorize at all, so memory
retrieval and knowledge-base grounding degrade to empty results locally. Chat,
threads, persona, and TTS/STT work normally.

## Local development auth

CF Access is not available in `wrangler dev`. Set `DEV_USER_EMAIL=you@example.com` in
`.dev.vars` to simulate an authenticated user. Put that email in `ADMIN_EMAILS` too
if you need the admin routes locally.

## Deploy

```
npm run build
npx wrangler deploy
```

## Design docs

`docs/superpowers/specs/` holds the design history — the original app design, then
durable conversations, shared memory spaces, web search, memory reconciliation, and
the proposed chat provider seam. They record why things are built the way they are;
this README is the current-state reference.
