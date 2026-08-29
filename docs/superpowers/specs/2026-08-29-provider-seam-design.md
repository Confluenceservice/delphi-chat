# Chat Provider Seam — Design

Date: 2026-08-29
Status: Proposed (design only, not implemented)

## Goal

Let the chat model come from any OpenAI-compatible provider (OpenRouter first)
without giving up MiniMax voice or web search. Today five worker files reach for
`MINIMAX_*` directly; this pulls the chat-shaped calls behind one seam and leaves
the MiniMax-only features where they are.

## What is and isn't coupled today

| Area | File | Coupling |
|---|---|---|
| Chat stream | `worker/chat.ts` | **Thin** — `/v1/chat/completions`, `Bearer`, `stream: true`. Standard OpenAI shape. |
| Title generation | `worker/title.ts` | **Thin**, but model ID `MiniMax-M2.7` is hardcoded in source. |
| Memory extraction | `worker/memory.ts` | **Thin**, but model ID `MiniMax-M3` is hardcoded, and output parsing strips `<think>` blocks. |
| Web search | `worker/chat-anthropic.ts` | **Welded** — `/anthropic/v1/messages` + `web_search_20250305`. MiniMax-only. |
| TTS | `worker/tts.ts`, `src/data/voices.ts` | **Welded** — `/v1/t2a_v2`, hex audio, `base_resp` envelope, MiniMax System Voice IDs. |
| Model list | `src/state/types.ts` | Hardcoded `MODELS` array. |
| STT | `worker/stt.ts` | **Already abstracted** — `ASR_PROVIDER` / `ASR_BASE_URL` / `ASR_MODEL`. |
| Embeddings | `worker/embed.ts` | **Already provider-free** — Workers AI `@cf/baai/bge-m3`. |

`worker/stt.ts` is the precedent. This design copies its shape rather than
inventing a new one.

## Constraint that shapes the design

Two features have no OpenRouter equivalent and must stay on MiniMax:

- **TTS** — OpenRouter is text-only. There is nothing to swap to.
- **Web search** — MiniMax exposes it as a server-side tool on its Anthropic
  endpoint. OpenRouter's equivalent (`:online` suffix / web plugin) is a
  different request shape *and* a different response shape.

So the seam is **not** "replace MiniMax". It is "chat is pluggable; voice and
search remain MiniMax capabilities that are present or absent". A deployment
with `CHAT_PROVIDER=openrouter` and no MiniMax key is a valid, degraded config:
text chat works, read-aloud and citations do not.

This is the single most important consequence to design for, because the code
currently assumes a MiniMax key implies all four capabilities.

## Decisions

- **Two independent provider slots, not one.** `CHAT_*` covers chat, titles, and
  memory extraction. `MINIMAX_*` is retained and reinterpreted as the *voice and
  search* provider. They are configured separately and may point at different
  vendors, or one may be absent.
- **Capability detection, not provider branching.** Nothing downstream asks
  "is this MiniMax?". It asks "is search available?" / "is TTS available?".
  Adding a third provider later touches config, not call sites.
- **`webSearch` is already the right seam.** `worker/chat.ts` computes a
  `webSearch` boolean that gates *both* the Anthropic routing *and* whether
  `buildSystemPrompt` advertises search to the model. Extending that one
  predicate with a capability check propagates correctly with no other change.
- **No provider-abstraction class hierarchy.** Both chat providers speak the
  same OpenAI wire format; the only differences are base URL, auth header, and
  two optional headers. A small request-builder function is sufficient. (YAGNI —
  revisit if a third provider needs a genuinely different shape.)
- **Model list moves server-side.** The worker knows which provider is
  configured, so it is the only thing that can name valid models.
- **Backward compatible by default.** With only `MINIMAX_*` set and no `CHAT_*`,
  behaviour is byte-identical to today.

## Architecture

```
                        ┌── CHAT_PROVIDER (openrouter | minimax | openai-compatible)
                        │     /v1/chat/completions
  /api/chat ────────────┤     used by: chat.ts, title.ts, memory.ts
  /api/title            │
  /api/memory/ingest    │
                        └── capability: search? ──no──▶ plain completions passthrough
                                                 └─yes─▶ chat-anthropic.ts (MiniMax only)

  /api/tts ─────────────── MINIMAX_* (unchanged; 501 when unconfigured)
  /api/stt ─────────────── ASR_* (unchanged, already abstracted)
  embeddings ───────────── Workers AI (unchanged)
```

## Components

### 1. Config resolver — `worker/provider.ts` (new)

Single place that reads `Env` and answers what is configured. ~40 lines.

```ts
export interface ChatProvider {
  baseUrl: string;
  apiKey: string;
  groupId?: string;          // MiniMax-only query param
  extraHeaders: Record<string, string>;
  utilityModel: string;      // titles + memory extraction
  supportsSearch: boolean;   // MiniMax Anthropic endpoint available
}

export function chatProvider(env: Env): ChatProvider | null;
export function ttsAvailable(env: Env): boolean;
```

Resolution order: use `CHAT_*` when `CHAT_API_KEY` is set; otherwise fall back to
`MINIMAX_*` so existing deployments keep working untouched. `supportsSearch` is
true only when the resolved chat provider is MiniMax **and** a MiniMax key
exists.

For OpenRouter, `extraHeaders` carries `HTTP-Referer` and `X-Title` (OpenRouter
uses them for attribution and rate-limit tiering); `groupId` is unset, so the
`GroupId` query param is simply not appended.

### 2. Request builder — `worker/provider.ts` (same file)

One helper both `chat.ts` and the utility callers use, so auth/header/query
differences live in exactly one place:

```ts
export function chatCompletionsRequest(
  p: ChatProvider,
  body: unknown,
): { url: string; init: RequestInit };
```

### 3. Chat routing — `worker/chat.ts` (modified)

Three changes:

- `MINIMAX_API_KEY` guard becomes `chatProvider(env)` null-check, error text
  `"No chat provider configured"`.
- The URL/header block (lines ~54–66) is replaced by `chatCompletionsRequest`.
- The capability check folds into the existing predicate:

```ts
const webSearch = !hasImageContent(messages) && provider.supportsSearch;
```

`buildSystemPrompt` already receives `webSearch` and stops advertising search
when it is false, so a non-MiniMax provider is never told it has a tool it
lacks. No change to `worker/persona.ts`.

### 4. Utility calls — `worker/title.ts`, `worker/memory.ts` (modified)

Replace the hardcoded `"MiniMax-M2.7"` / `"MiniMax-M3"` with
`provider.utilityModel`, and the inline fetch with `chatCompletionsRequest`.
`callMiniMaxNonStreaming` in `memory.ts` is renamed `callChatNonStreaming`.

Keep `stripThinking()` and `src/lib/thinking.ts` unchanged — a `<think>`
stripper is a no-op against providers that do not emit those tags, and removing
it would break MiniMax-M3. See Open risks for the OpenRouter reasoning case.

### 5. TTS availability — `worker/tts.ts` (modified)

Guard becomes `ttsAvailable(env)`; when false, return **501** with
`{ error: "TTS not configured" }` rather than today's 500. The client treats 501
as "hide the feature" instead of "something broke".

### 6. Model list — `GET /api/models` (new, `worker/index.ts` + `worker/provider.ts`)

Returns `{ models: string[], default: string, capabilities: { search, tts } }`
derived from a `CHAT_MODELS` comma-separated var (falling back to the current
MiniMax pair). Behind the existing Access middleware like every other route.

### 7. Client model state — `src/state/types.ts`, `src/ui/Settings.tsx` (modified)

`MODELS` stops being a `const` tuple and becomes state fetched once from
`/api/models`, with the current hardcoded pair as the offline fallback.
`Thread.model` is already a plain `string`, so threads created under a previous
provider keep rendering and are never invalidated.

`capabilities.tts === false` hides the read-aloud control and conversation mode
rather than letting them fail at click time.

## Config

New, all optional:

| Key | Kind | Meaning |
|---|---|---|
| `CHAT_API_KEY` | secret | Chat provider key. Its presence activates the `CHAT_*` path. |
| `CHAT_BASE_URL` | var | e.g. `https://openrouter.ai/api` |
| `CHAT_MODELS` | var | Comma-separated list offered in the UI. |
| `CHAT_UTILITY_MODEL` | var | Cheap model for titles + memory extraction. |
| `CHAT_APP_URL`, `CHAT_APP_NAME` | var | OpenRouter `HTTP-Referer` / `X-Title`. |

Unchanged: `MINIMAX_*` (now voice + search), `ASR_*`, Access vars.

## Error handling

- No chat provider configured → 500, `"No chat provider configured"`.
- Chat provider 429 → existing quota message, but only phrase it as "Token Plan"
  when the provider is MiniMax; otherwise a generic rate-limit message.
- TTS requested with no MiniMax key → 501 (see §5).
- Search unavailable → silently uses the plain completions path. Not an error;
  the model is simply never told it can search.

## Verification

- **Regression:** with only `MINIMAX_*` set, chat, titles, memory, search
  citations, and TTS all behave exactly as before. This is the gate — the seam
  must be invisible to the existing deployment.
- **OpenRouter chat:** set `CHAT_*` at OpenRouter, leave `MINIMAX_*` set.
  Streaming works, titles generate, memory facts extract. Sources never appear
  (search off). Read-aloud still works via MiniMax.
- **Chat-only deployment:** `CHAT_*` set, `MINIMAX_*` unset. Text chat works;
  `/api/tts` returns 501; mic and read-aloud controls are hidden, not broken.
- **Prompt hygiene:** with search off, confirm the system prompt contains no
  search affordance — the model must not claim it looked something up.
- **Thread compatibility:** a thread created with `MiniMax-M3` still opens and
  continues after switching providers.

## Out of scope (YAGNI)

Per-thread or per-message provider choice; automatic failover between providers;
OpenRouter's `:online` search plugin (different response shape — its own design
if wanted); routing TTS to a non-MiniMax vendor; cost/token accounting per
provider; renaming the `minimax-chat:` localStorage keys or the Worker name.

## Open risks

- **Reasoning-token shape.** OpenRouter reasoning models return reasoning in a
  separate `reasoning` field rather than inline `<think>` tags. The client's
  thinking stripper will not surface it — reasoning simply won't display. This
  degrades quietly rather than breaking, but it means the thinking UI is
  MiniMax-specific until a follow-up handles the field.
- **`utilityModel` quality.** Memory extraction depends on the model returning
  parseable JSON. A weaker or chattier utility model degrades memory quality
  silently — `parseFactsJson` already returns empty on failure. Worth logging a
  parse-failure counter before trusting a new utility model.
- **Fallback ambiguity.** "Use `CHAT_*` if `CHAT_API_KEY` is set" is implicit.
  A half-configured deployment (`CHAT_BASE_URL` set, key missing) silently uses
  MiniMax. Consider failing loudly on partial `CHAT_*` config.
