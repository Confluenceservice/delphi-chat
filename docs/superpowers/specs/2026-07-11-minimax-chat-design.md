# MiniMax Chat — Mobile-Friendly Claude-style App

> **Status:** original v1 design, 2026-07-11. Two locked decisions below were
> later superseded (auth and memory scoping) and are struck through inline.
> For current behaviour see the README; for what changed and why, see the
> durable-conversations, web-search, and memory-reconciliation designs in this
> directory.

## Context

Build a mobile-friendly chat app in the style of Claude, powered by the **MiniMax**
model family (Token Plan subscription key). Target is a **responsive PWA now, iOS
wrapper later**. v1 delivers streaming chat + full voice loop (read-aloud TTS, mic
STT, hands-free conversation mode) + cross-conversation memory. Image and music
generation are deliberately deferred.

MiniMax exposes an **OpenAI-compatible** chat API with SSE streaming, tools, and
vision, plus a TTS endpoint — but **no native speech-to-text**, so STT uses a
third-party ASR. The MiniMax key must never reach the browser (no permissive CORS),
so a thin backend proxies all provider calls and holds secrets.

### Locked decisions
- **Platform:** mobile-first responsive PWA (React). iOS native later.
- **v1 scope:** streaming chat (M3/M2.7) + image/file input to chat + TTS + STT +
  conversation mode + cross-conversation memory. No image/music gen, no barge-in in v1.
- **STT:** cloud ASR via backend. Default Groq `whisper-large-v3-turbo`; provider +
  key env-swappable (OpenAI Whisper as drop-in alt).
- **Backend/host:** single Cloudflare Worker with Static Assets — serves the built
  PWA and `/api/*`. One `wrangler deploy`.
- **Users:** ~~personal, no login~~ — **superseded.** The app is now behind
  Cloudflare Access; every `/api/*` request carries a verified Access JWT and the
  email claim is the per-user partition key. Subscription key stays server-side.
  Conversations are in D1 (see the durable-conversations design), with browser
  storage as the client-side cache.
- **Memory:** all-Cloudflare, no extra vendor — Vectorize (embeddings) + D1 (fact
  text/metadata) + Workers AI embeddings + MiniMax-M3 fact extraction.
  ~~Single fixed namespace (`default`) since no login.~~ **Superseded:** facts are
  scoped per user by `user_email` in D1, and the Vectorize `namespace` metadata
  field carries the user's email. The `default` constant survives only as a
  vestigial D1 column value.

## Architecture

```
Browser PWA (React+Vite+TS)  ──same-origin──►  Cloudflare Worker
  chat UI / voice loop / local storage            /api/chat           → retrieve memories → MiniMax /v1/chat/completions (SSE passthrough)
                                                  /api/tts            → MiniMax /v1/t2a_v2 (mp3)
                                                  /api/stt            → Groq/OpenAI Whisper (multipart audio → transcript)
                                                  /api/memory/ingest  → MiniMax extract facts → Workers AI embed → Vectorize + D1
                                                  /api/memory         → list / delete facts (Settings UI)
                                                  static assets (built SPA + manifest + SW)
                                                    │
                                                    ├── Vectorize index (fact embeddings, bge-m3 1024-dim)
                                                    ├── D1 (fact text + metadata + namespace)
                                                    └── Workers AI (@cf/baai/bge-m3 embeddings)
```

- Worker injects `Authorization: Bearer <key>` server-side; browser never sees keys.
- Same-origin ⇒ no CORS config needed.
- Secrets via `wrangler secret`: `MINIMAX_API_KEY` (Token-Plan subscription key),
  `ASR_API_KEY`. Vars: `MINIMAX_BASE_URL` (default `https://api.minimax.io`),
  `MINIMAX_GROUP_ID` (optional; append `?GroupId=` only if set), `ASR_PROVIDER`
  (`groq`|`openai`), `ASR_BASE_URL`, `ASR_MODEL`.
- Bindings in `wrangler.toml`: `[ai]` (Workers AI), `[[vectorize]]` (index
  `minimax-memory`), `[[d1_databases]]` (memory facts). No extra vendor key for memory.

## Endpoints (Worker)

- `POST /api/chat` — body `{ model, messages }` (messages may include `image_url`
  content parts for vision). **Memory retrieval seam:** embed the latest user turn
  (Workers AI) → Vectorize top-k (k≈5, namespace `default`) → fetch fact texts from
  D1 → inject as a system message ("Relevant things you remember about the user: …")
  ahead of the user messages. Then call MiniMax chat with `stream:true` and pipe the
  SSE straight through (`text/event-stream`). Map MiniMax 429/quota-exhausted to a
  clean JSON error the UI shows ("Token Plan quota reached — retry after the 5h/weekly
  window").
- `POST /api/tts` — body `{ text, voice_id, model }`. Calls `/v1/t2a_v2`
  non-streaming, `audio_setting.format=mp3`, returns `audio/mpeg` bytes (or the
  MiniMax URL). Sentence-chunking is a later optimization, not v1.
- `POST /api/stt` — multipart audio blob → forward to ASR provider
  (`/audio/transcriptions`, model from env) → return `{ text }`.
- `POST /api/memory/ingest` — body `{ user, assistant }` (last exchange). Called by
  the frontend after an assistant reply completes. Steps: MiniMax-M3 prompt "extract
  durable facts/preferences about the user as a JSON array; empty if none" → for each
  fact, embed + Vectorize similarity check to dedup near-duplicates → upsert new
  facts to Vectorize + insert D1 row `{ id, namespace, text, created_at, source }`.
- `GET /api/memory` — list stored facts (Settings UI). `DELETE /api/memory/:id` —
  forget one; `DELETE /api/memory` — clear all.

## Frontend layout

```
src/
  api/            chat.ts (SSE reader), tts.ts, stt.ts, memory.ts (ingest, list/delete)
  audio/          recorder.ts (MediaRecorder, iOS-aware mime), player.ts (unlockable <audio>), vad.ts (@ricky0123/vad-web)
  state/          store.ts (threads, settings), storage.ts (localStorage/IndexedDB)
  ui/             ChatView, MessageList, Composer, MicButton, ConversationMode, ModelPicker, Settings (+ MemoryPanel)
  main.tsx, App.tsx
public/           manifest.webmanifest, icons, sw (via vite-plugin-pwa)
worker/           index.ts (router), chat.ts, tts.ts, stt.ts, memory.ts (ingest/retrieve/list/delete), embed.ts
wrangler.toml     (+ ai / vectorize / d1 bindings)
```

- **Chat UI:** message list with markdown + code highlighting, streaming assistant
  bubbles, attach image/file → vision content parts. Model picker (`MiniMax-M3`
  default, `MiniMax-M2.7`).
- **SSE reader** (`api/chat.ts`): parse `chat.completion.chunk` deltas, append tokens
  live, handle `[DONE]` and error frames.
- **TTS read-aloud:** per-message speaker button → `/api/tts` → play via unlockable
  audio element.
- **STT push-to-talk:** `MicButton` records (check `MediaRecorder.isTypeSupported`;
  iOS Safari → `audio/mp4`/AAC, else `audio/webm`) → `/api/stt` → transcript into
  composer.
- **Conversation mode (turn-based):** tap to start (unlocks audio). Loop: VAD
  listens → on speech-end, send segment to `/api/stt` → send transcript to
  `/api/chat` → on full reply, `/api/tts` → pause mic/VAD during playback → on
  `ended`, resume listening. No barge-in in v1 (avoids TTS-into-mic echo on mobile).
  Visible states: listening / thinking / speaking; stop button.
- **Persistence:** thread list + messages + settings in localStorage (IndexedDB if
  size grows). No server state.
- **PWA:** `vite-plugin-pwa` — manifest, installable, offline app shell. Mobile-first
  CSS, safe-area insets, large tap targets.

## Milestones (each independently verifiable)

1. **Scaffold + streaming chat MVP** — Vite React TS app + Worker w/ Static Assets;
   `/api/chat` SSE passthrough (retrieval seam stubbed/no-op); chat UI streams M3
   replies; model picker; local thread persistence. Done when: type a message on
   phone-width viewport, tokens stream in, reload keeps history.
2. **Vision + TTS** — image/file attach into chat; `/api/tts` + per-message
   read-aloud with unlockable audio. Done when: send an image and get a response;
   tap speaker, hear mp3.
3. **STT push-to-talk** — recorder (iOS-aware mime) + `/api/stt`. Done when: hold
   mic, speak, transcript appears and sends.
4. **Conversation-mode spike (de-risk early)** — minimal turn-based VAD loop on a
   real iPhone to surface iOS audio/echo/format issues before polishing. Done when:
   one full hands-free round trip works on iOS Safari.
5. **Conversation mode polish + PWA** — state UI, stop/interrupt, error/quota
   handling, `vite-plugin-pwa`, manifest/icons, install + offline shell, mobile UX
   pass. Done when: installable on phone, multi-turn hands-free conversation is
   stable.
6. **Memory backend** — Vectorize index + D1 schema + Workers AI embeddings; wire
   retrieval into `/api/chat` and `/api/memory/ingest` (extract + dedup + store).
   Done when: a fact stated in one thread is retrieved and used in a new thread.
7. **Memory UI + transparency** — MemoryPanel in Settings: list/delete facts, memory
   on/off toggle. Done when: remembered facts are visible and individually deletable.

## Key libraries
- `react`, `vite`, `typescript`, `vite-plugin-pwa`
- `@ricky0123/vad-web` (Silero VAD in-browser) for conversation-mode turn detection
- markdown: `react-markdown` + `rehype`/`shiki` (or `highlight.js`)
- Worker: plain fetch (no framework); OpenAI-compatible bodies, so no SDK needed
- Memory: Cloudflare Vectorize + D1 + Workers AI (`@cf/baai/bge-m3`, 1024-dim,
  multilingual) — all via native bindings, no library

## Setup prerequisites
1. MiniMax Token Plan subscription key → `wrangler secret put MINIMAX_API_KEY`.
2. ASR key (Groq default) → `wrangler secret put ASR_API_KEY`; set
   `ASR_PROVIDER`/`ASR_MODEL` vars.
3. Optional `MINIMAX_GROUP_ID` if the account requires it.

## Verification
- **Local:** `wrangler dev` serves SPA + `/api/*` (Vectorize/D1/AI bindings work in
  dev). Test chat streaming, image input, TTS playback, STT transcription with real
  keys.
- **Memory:** in thread A say "I'm vegetarian and live in Lisbon"; open a new thread
  B and ask "suggest dinner" → reply reflects the stored facts. Confirm facts appear
  in the Memory panel and delete works.
- **Mobile:** open `wrangler dev` tunnel (or deploy) on an actual iPhone — verify
  streaming, TTS autoplay after gesture, MediaRecorder format, and the milestone-4
  conversation spike on iOS Safari specifically (the highest-risk surface).
- **Quota:** simulate a MiniMax 429 → confirm UI shows the quota message, not a
  crash.
- **Deploy:** `wrangler deploy`; smoke-test all flows on the live URL.
