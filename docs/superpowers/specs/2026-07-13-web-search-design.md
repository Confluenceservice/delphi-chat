# Web Search Integration — Design

Date: 2026-07-13
Status: Approved (design), pending implementation plan

## Goal

Add web search to Delphi Chat using MiniMax's `web_search` server tool, so the
model can answer questions needing fresh/live information and cite its sources.

## Constraint that shapes the design

MiniMax's `web_search` server tool is **only** available on the Anthropic
Messages endpoint (`/anthropic/v1/messages`), **not** on the OpenAI-compatible
`/v1/chat/completions` endpoint the app currently uses.

Differences between the two endpoints:

| | Current path | web_search path |
|---|---|---|
| endpoint | `/v1/chat/completions` | `/anthropic/v1/messages` |
| auth header | `Authorization: Bearer <key>` | `x-api-key: <key>` + `anthropic-version: 2023-06-01` |
| request | `messages` (incl. system message), `stream` | `system` (top-level), `messages`, `max_tokens`, `tools`, `stream` |
| tool declaration | n/a | `tools: [{ type: "web_search_20250305", name: "web_search" }]` |
| streaming response | `choices[].delta.content` | Anthropic named events + content blocks |

The model runs the search server-side within a single request — no client/worker
tool round-trip.

## Decisions (from brainstorming)

- **Trigger: always on** — web search is enabled for all eligible chats; the
  model decides when to actually search. No per-message toggle, no UI control.
- **Routing: hybrid** — text-only messages go through the Anthropic + web_search
  path; messages containing images fall back to the current chat/completions
  passthrough (unchanged). Rationale: MiniMax vision + web_search compatibility
  is undocumented/unconfirmed, and the fallback also avoids OpenAI→Anthropic
  image-block conversion. "Always on" therefore applies to all text chat; image
  chats degrade gracefully to current behavior.
- **Citations: sources list under the reply** — worker extracts
  `web_search_tool_result` URLs/titles and delivers them to the client, which
  renders a compact "Sources" block below the assistant message.
- **Streaming preserved** — worker translates Anthropic SSE into the app's
  existing OpenAI-style `choices.delta` SSE shape so the client stream parser is
  largely unchanged (one addition for sources).

## Architecture

The **worker is the single translation layer**. The client `streamChat` parser
keeps consuming OpenAI-style `data: {choices:[{delta:{content}}]}` chunks plus a
new `data: {sources:[...]}` chunk and the terminal `data: [DONE]`.

```
client ──POST /api/chat {model,messages,memory}──▶ worker handleChat
                                                      │
                              has image parts? ──yes──┤──▶ /v1/chat/completions (current, passthrough)
                                                      │
                                              no ─────┴──▶ /anthropic/v1/messages (+ web_search)
                                                              │  Anthropic SSE
                                                              ▼
                                                    worker SSE adapter (TransformStream)
                                                              │  OpenAI-style SSE + sources event
                                                              ▼
                                                            client
```

## Components

### 1. Routing — `worker/chat.ts` (modified)

`handleChat`:
1. Build `systemPrompt` and message array as today (persona + memory).
2. Detect whether any message `content` contains an `image_url` part.
3. **Images present** → existing chat/completions path, unchanged.
4. **Text only** → delegate to the new Anthropic helper (below).
5. Keep existing 429 and error-envelope handling.

### 2. Request translation — `worker/chat-anthropic.ts` (new)

Builds and sends the Anthropic Messages request:

- Body:
  - `model`: `body.model` (default `MiniMax-M3`)
  - `max_tokens`: `8192`
  - `system`: the persona/memory system prompt (top-level field, **not** a
    system message inside `messages`)
  - `messages`: the user/assistant turns; string content passes through as-is.
    The injected system message is removed (moved to `system`).
  - `tools`: `[{ type: "web_search_20250305", name: "web_search" }]`
  - `stream`: `true`
- Headers: `x-api-key: MINIMAX_API_KEY`, `anthropic-version: 2023-06-01`,
  `Content-Type: application/json`. No `Authorization: Bearer`.
- `GroupId` query param: not required for this endpoint; omit.
- Reuses `MINIMAX_API_KEY` and `MINIMAX_BASE_URL` env vars. No new env vars.

### 3. Response adapter — `worker/chat-anthropic.ts` (new, same file)

A `TransformStream` consumes Anthropic named SSE events and emits the app's SSE
shape:

| Anthropic event | Block / delta | Worker emits |
|---|---|---|
| `content_block_delta` | `text_delta.text` | `data: {choices:[{delta:{content: text}}]}` |
| `content_block_delta` | `thinking_delta.thinking` | same shape, wrapped in `<think>…</think>` |
| `content_block_start` / delta | `server_tool_use` (search query) | ignore |
| `content_block_start` | `web_search_tool_result` | collect `{title, url}[]` into a buffer; emit nothing |
| `message_stop` (or stream end) | — | emit `data: {"sources":[...]}` (if any), then `data: [DONE]` |

Details:
- **Sources buffer**: accumulate results across the stream; dedup by `url`;
  flush once at `message_stop`. Empty buffer → no sources event.
- **`<think>` continuity**: only `thinking_delta` deltas get wrapped. Open the
  `<think>` tag on the first thinking delta of a reasoning run and close it when
  the first following `text_delta` arrives, so the client's `thinking.ts`
  stripper sees a well-formed inline block. `text_delta` content is passed raw
  (never double-wrapped).
- **Always terminate**: `[DONE]` is emitted on every completion path (including
  tool-only or empty turns) so the client's `onDone` fires and clears the
  streaming state.

### 4. Client stream — `src/api/chat.ts` (modified)

- Add optional callback to `StreamChatParams`:
  `onSources?: (sources: { title: string; url: string }[]) => void`.
- In the SSE parse loop, before the `choices` check:
  ```ts
  if (parsed.sources) { onSources?.(parsed.sources); continue; }
  ```

### 5. Message model — `src/state/types.ts` (modified)

Add to `Message`:
```ts
sources?: { title: string; url: string }[];
```
Threads already serialize `Message[]` to local storage (`src/state/storage.ts`),
so sources persist across reloads with no storage change.

### 6. Thread state — `src/state/useThreads.ts` (modified)

`updateMessage` currently accepts `(threadId, messageId, content)`. Add a
sibling `setMessageSources(threadId, messageId, sources)` that patches the
`sources` field on the target message (keeps `updateMessage`'s content-only
contract intact).

### 7. Wiring — `src/App.tsx` (modified)

In the `streamChat` call, add:
```ts
onSources: (s) => setMessageSources(t.id, assistantId, s),
```

### 8. UI — `src/ui/MessageList.tsx` (+ CSS) (modified)

After the assistant `m.content` block, render when `m.sources?.length`:
```tsx
{m.role === "assistant" && m.sources?.length ? (
  <ul className="message__sources">
    {m.sources.map((s) => (
      <li key={s.url}>
        <a href={s.url} target="_blank" rel="noopener noreferrer">
          {s.title || s.url}
        </a>
      </li>
    ))}
  </ul>
) : null}
```
Add a small, muted CSS block with a "Sources" label.

## Error handling

- **Non-OK upstream**: read the Anthropic error body, return the app's existing
  `jsonError(message, status)` shape so the client surfaces it unchanged. Keep
  the 429 "Token Plan quota reached" message.
- **Mid-stream Anthropic `error` event**: emit one
  `data: {choices:[{delta:{content: "⚠️ …"}}]}` chunk, then `data: [DONE]`.
- **Abort**: client abort is already handled; ensure the `TransformStream`
  propagates cancellation to the upstream fetch when the client disconnects.

## Edge cases

- **No search performed**: no `web_search_tool_result` blocks → empty buffer →
  no sources event → UI unchanged. Correct.
- **Tool-only / empty assistant turn**: still emit `[DONE]` so streaming clears.
- **Duplicate source URLs**: dedup by `url` in the worker buffer.
- **Reasoning as raw text vs thinking blocks**: only wrap `thinking_delta`; pass
  `text_delta` raw to avoid double-wrapping.

## Verification

1. `npm run build` (type-check worker + client) passes.
2. Text prompt needing fresh info (e.g. "latest X news") → streams answer,
   Sources list renders, persists across reload.
3. Text prompt not needing search → normal answer, no sources block.
4. Image message → still works via chat/completions path, no regression.
5. Error paths → bad key / 429 surface cleanly in the UI.

## Out of scope (YAGNI)

- Per-message web-search toggle or Settings switch.
- Inline footnote-style citations.
- OpenAI→Anthropic image-block conversion (only needed for pure always-on).
- `web_search` config tuning (max_uses / result count) — not exposed by MiniMax.

## Open risk

MiniMax vision + web_search compatibility is unconfirmed. The hybrid routing
sidesteps it: if it turns out vision *does* work with web_search, the image
branch can later be merged into the Anthropic path. No design change needed to
ship.
