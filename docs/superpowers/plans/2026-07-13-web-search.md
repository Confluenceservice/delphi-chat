# Web Search Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route text-only chats through MiniMax's Anthropic Messages endpoint with the `web_search` server tool and render cited sources under each reply.

**Architecture:** The Cloudflare worker is the single translation layer. Text-only messages go to `/anthropic/v1/messages` with `web_search` enabled; the worker converts the Anthropic named-event SSE stream back into the app's existing OpenAI-style `choices.delta` SSE (plus one new `sources` event). Image messages fall back to the current `/v1/chat/completions` passthrough unchanged. The React client parser stays on the OpenAI shape and gains one `onSources` callback.

**Tech Stack:** TypeScript, Cloudflare Workers (`worker/`), React + Vite (`src/`), no test framework, no new dependencies.

## Global Constraints

- No new npm dependencies. No new env vars — reuse `MINIMAX_API_KEY` and `MINIMAX_BASE_URL`.
- Model: default `MiniMax-M3` (whatever `body.model` is). `max_tokens: 8192`.
- Web search tool declaration, exact: `{ "type": "web_search_20250305", "name": "web_search" }`.
- Anthropic request headers, exact: `x-api-key: <MINIMAX_API_KEY>`, `anthropic-version: 2023-06-01`, `Content-Type: application/json`. No `Authorization: Bearer` on the Anthropic path.
- Client SSE contract is unchanged: text chunks are `data: {"choices":[{"delta":{"content":"..."}}]}`, terminal marker is `data: [DONE]`. The only addition is `data: {"sources":[{"title":"...","url":"..."}]}` emitted once before `[DONE]`.
- **No test runner exists in this repo.** Each task's gate is `npm run build` (TypeScript type-check via `tsc -b`) plus the manual smoke check named in the task. Do not add a test framework.

---

## File Structure

- `worker/chat.ts` (modify) — route between the image passthrough path and the new search path; extract the existing completions call into a helper.
- `worker/chat-anthropic.ts` (create) — build the Anthropic request, and the pure SSE adapter that converts Anthropic events to the app's SSE shape.
- `src/api/chat.ts` (modify) — add `onSources` callback and parse the `sources` event.
- `src/state/types.ts` (modify) — add `Source` type and `Message.sources`.
- `src/state/useThreads.ts` (modify) — add `setMessageSources`.
- `src/App.tsx` (modify) — wire `onSources` into the `streamChat` call.
- `src/ui/MessageList.tsx` (modify) — render the sources list.
- `src/App.css` (modify) — sources list styling.

---

## Task 1: Worker — Anthropic request + SSE adapter

**Files:**
- Create: `worker/chat-anthropic.ts`
- Reference: `worker/chat.ts:11-76`, `worker/types.ts`

**Interfaces:**
- Consumes: `Env` from `./types` (has `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`).
- Produces:
  - `interface AnthropicSource { title: string; url: string }`
  - `function anthropicToAppSSE(upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array>` — pure transform, no network.
  - `function handleChatWithSearch(env: Env, model: string, system: string, messages: unknown[]): Promise<Response>` — fetches the Anthropic endpoint and returns a `text/event-stream` Response whose body is the adapted stream.

- [ ] **Step 1: Create the file with the request builder + adapter**

Create `worker/chat-anthropic.ts`:

```ts
import type { Env } from "./types";

export interface AnthropicSource {
  title: string;
  url: string;
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

function sseData(payload: unknown): Uint8Array {
  return ENCODER.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function contentChunk(text: string): Uint8Array {
  return sseData({ choices: [{ delta: { content: text } }] });
}

/**
 * Convert a MiniMax Anthropic-Messages SSE stream into the app's OpenAI-style
 * SSE stream. Text and thinking deltas become choices.delta.content chunks
 * (thinking wrapped in <think>...</think> so the client stripper works);
 * web_search_tool_result blocks are collected and flushed once as a single
 * {sources:[...]} event just before [DONE].
 */
export function anthropicToAppSSE(
  upstream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  let buffer = "";
  let inThink = false;
  const sources: AnthropicSource[] = [];
  const seenUrls = new Set<string>();

  function collectResults(block: any): void {
    const results = Array.isArray(block?.content) ? block.content : [];
    for (const r of results) {
      const url = typeof r?.url === "string" ? r.url : "";
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);
      sources.push({ title: typeof r?.title === "string" ? r.title : url, url });
    }
  }

  function handleEvent(
    json: any,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void {
    const type = json?.type;
    if (type === "content_block_start") {
      if (json.content_block?.type === "web_search_tool_result") {
        collectResults(json.content_block);
      }
      return;
    }
    if (type === "content_block_delta") {
      const delta = json.delta ?? {};
      if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        if (!inThink) {
          controller.enqueue(contentChunk("<think>"));
          inThink = true;
        }
        controller.enqueue(contentChunk(delta.thinking));
        return;
      }
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        if (inThink) {
          controller.enqueue(contentChunk("</think>"));
          inThink = false;
        }
        controller.enqueue(contentChunk(delta.text));
      }
      return;
    }
    if (type === "error") {
      const msg = json.error?.message ?? "web search stream error";
      controller.enqueue(contentChunk(`\n\n⚠️ ${msg}`));
    }
  }

  function finish(controller: ReadableStreamDefaultController<Uint8Array>): void {
    if (inThink) {
      controller.enqueue(contentChunk("</think>"));
      inThink = false;
    }
    if (sources.length > 0) {
      controller.enqueue(sseData({ sources }));
    }
    controller.enqueue(ENCODER.encode("data: [DONE]\n\n"));
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        // Flush any trailing buffered line, then finish.
        buffer += DECODER.decode();
        finish(controller);
        controller.close();
        return;
      }
      buffer += DECODER.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue; // skip "event:" and blanks
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          handleEvent(JSON.parse(data), controller);
        } catch {
          // ignore malformed chunk
        }
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
}

export async function handleChatWithSearch(
  env: Env,
  model: string,
  system: string,
  messages: unknown[],
): Promise<Response> {
  const upstream = await fetch(`${env.MINIMAX_BASE_URL}/anthropic/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": env.MINIMAX_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      system,
      messages,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      stream: true,
    }),
  });

  if (upstream.status === 429) {
    return new Response(
      JSON.stringify({
        error: "Token Plan quota reached — retry after the 5h/weekly window resets.",
      }),
      { status: 429, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return new Response(
      JSON.stringify({
        error: `MiniMax web search request failed: ${text || upstream.statusText}`,
      }),
      { status: upstream.status, headers: { "Content-Type": "application/json" } },
    );
  }

  return new Response(anthropicToAppSSE(upstream.body), {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
```

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: PASS (no type errors). `worker/chat-anthropic.ts` compiles; it is not yet imported anywhere, which is fine.

- [ ] **Step 3: Manual adapter smoke (pure function, no network)**

In a browser devtools console or a scratch REPL that can import the transform, feed a hand-built Anthropic stream and confirm output. Minimal check without a runner: temporarily paste the sample below into a scratch `.ts` scratchpad file, or trust the end-to-end check in Task 5. Sample input events (one per `data:` line) and expected emitted chunks:

Input events:
```
{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"pondering"}}
{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}
{"type":"content_block_start","content_block":{"type":"web_search_tool_result","content":[{"type":"web_search_result","title":"T","url":"https://a.test"},{"type":"web_search_result","title":"T2","url":"https://a.test"}]}}
{"type":"message_stop"}
```
Expected emitted `data:` payloads in order:
```
{"choices":[{"delta":{"content":"<think>"}}]}
{"choices":[{"delta":{"content":"pondering"}}]}
{"choices":[{"delta":{"content":"</think>"}}]}
{"choices":[{"delta":{"content":"Hello"}}]}
{"sources":[{"title":"T","url":"https://a.test"}]}
[DONE]
```
Note the dedup: the duplicate `https://a.test` appears once. If you cannot run this in isolation, rely on Task 5's live check.

- [ ] **Step 4: Commit**

```bash
git add worker/chat-anthropic.ts
git commit -m "feat: worker anthropic web_search request + SSE adapter"
```

---

## Task 2: Worker — route text vs image in handleChat

**Files:**
- Modify: `worker/chat.ts`

**Interfaces:**
- Consumes: `handleChatWithSearch` from `./chat-anthropic` (Task 1).
- Produces: routing behavior — image messages keep the current `/v1/chat/completions` passthrough; text-only messages use `handleChatWithSearch`.

- [ ] **Step 1: Add the import and image detector**

At the top of `worker/chat.ts`, add to the imports:

```ts
import { handleChatWithSearch } from "./chat-anthropic";
```

Add this helper near the bottom of the file (next to `jsonError`):

```ts
function hasImageContent(messages: unknown[]): boolean {
  return messages.some((m) => {
    const content = (m as { content?: unknown })?.content;
    return (
      Array.isArray(content) &&
      content.some((part) => (part as { type?: string })?.type === "image_url")
    );
  });
}
```

- [ ] **Step 2: Branch after building the system prompt**

In `handleChat`, the current code (lines ~35-54) builds `systemPrompt`, unshifts a system message, then fetches chat/completions. Replace from the `const systemPrompt = ...` line through the end of the `upstream` fetch block with:

```ts
  const systemPrompt = buildSystemPrompt({ persona, memoryEnabled, memoryContext });

  // Text-only turns get web search via the Anthropic endpoint. Image turns fall
  // back to the OpenAI-compatible passthrough (vision + web_search unconfirmed).
  if (!hasImageContent(messages)) {
    return handleChatWithSearch(env, body.model, systemPrompt, messages);
  }

  messages.unshift({ role: "system", content: systemPrompt });

  const url = new URL(`${env.MINIMAX_BASE_URL}/v1/chat/completions`);
  if (env.MINIMAX_GROUP_ID) {
    url.searchParams.set("GroupId", env.MINIMAX_GROUP_ID);
  }

  const upstream = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.MINIMAX_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: body.model,
      messages,
      stream: true,
    }),
  });
```

Leave the existing 429 handling, `!upstream.ok` handling, and the final `return new Response(upstream.body, ...)` exactly as they are below this block.

- [ ] **Step 3: Type-check**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Manual smoke (worker path selection)**

Run: `npx wrangler dev` (or the project's dev command). Send a text-only chat and confirm in the network tab the worker responds `text/event-stream` and the reply renders. Send an image chat and confirm it still works. (Full source rendering is verified in Task 5.)

- [ ] **Step 5: Commit**

```bash
git add worker/chat.ts
git commit -m "feat: route text chats to web_search, images to completions"
```

---

## Task 3: Client — Message.sources type + onSources parsing

**Files:**
- Modify: `src/state/types.ts`
- Modify: `src/api/chat.ts`

**Interfaces:**
- Produces:
  - `interface Source { title: string; url: string }` exported from `src/state/types.ts`; `Message.sources?: Source[]`.
  - `StreamChatParams.onSources?: (sources: { title: string; url: string }[]) => void` in `src/api/chat.ts`.

- [ ] **Step 1: Add the Source type and Message field**

In `src/state/types.ts`, add after the `Role` type and update `Message`:

```ts
export interface Source {
  title: string;
  url: string;
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  images?: string[]; // data URLs, attached by the user
  sources?: Source[]; // web_search results, attached to assistant replies
}
```

- [ ] **Step 2: Add onSources to streamChat**

In `src/api/chat.ts`, add to `StreamChatParams` (after `onDelta`):

```ts
  onSources?: (sources: { title: string; url: string }[]) => void;
```

Add `onSources` to the destructured params in the `streamChat` signature:

```ts
export async function streamChat({
  model,
  messages,
  memory,
  onDelta,
  onSources,
  onDone,
  onError,
  signal,
}: StreamChatParams): Promise<void> {
```

Inside the parse loop, immediately after `const parsed = JSON.parse(data);` and before the `const delta` line, add:

```ts
          if (Array.isArray(parsed.sources)) {
            onSources?.(parsed.sources);
            continue;
          }
```

- [ ] **Step 3: Type-check**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/state/types.ts src/api/chat.ts
git commit -m "feat: client Message.sources type and onSources stream callback"
```

---

## Task 4: Client — thread state setMessageSources + App wiring

**Files:**
- Modify: `src/state/useThreads.ts`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `Source` type (Task 3), `onSources` callback (Task 3).
- Produces: `setMessageSources(threadId: string, messageId: string, sources: Source[]): void` returned from `useThreads`.

- [ ] **Step 1: Add setMessageSources to useThreads**

In `src/state/useThreads.ts`, import `Source` (add to the existing type import from `./types` / `./storage` — wherever `Message`/`Thread` come from):

```ts
import type { Source } from "./types";
```
(If types are imported from another module, match that path; the `Source` type lives in `src/state/types.ts`.)

Add this callback right after the existing `updateMessage` definition:

```ts
  const setMessageSources = useCallback(
    (threadId: string, messageId: string, sources: Source[]) => {
      setThreads((prev) =>
        prev.map((t) => {
          if (t.id !== threadId) return t;
          return {
            ...t,
            messages: t.messages.map((m) =>
              m.id === messageId ? { ...m, sources } : m,
            ),
          };
        }),
      );
    },
    [],
  );
```

Add `setMessageSources` to the returned object (next to `updateMessage`):

```ts
    updateMessage,
    setMessageSources,
    newId,
```

- [ ] **Step 2: Pull setMessageSources into App and wire the callback**

In `src/App.tsx`, add `setMessageSources` to the destructured `useThreads()` result (next to `updateMessage` around line 40):

```ts
    updateMessage,
    setMessageSources,
```

In the `streamChat` call inside `handleSend`, add `onSources` after `onDelta`:

```ts
      onSources: (sources) => setMessageSources(t.id, assistantId, sources),
```

- [ ] **Step 3: Type-check**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/state/useThreads.ts src/App.tsx
git commit -m "feat: persist web_search sources onto assistant messages"
```

---

## Task 5: UI — render sources list + verification

**Files:**
- Modify: `src/ui/MessageList.tsx`
- Modify: `src/App.css`

**Interfaces:**
- Consumes: `Message.sources` (Task 3), populated via Task 4.

- [ ] **Step 1: Render the sources list**

In `src/ui/MessageList.tsx`, inside the assistant bubble, immediately after the closing `</ReactMarkdown>` and before the `m.role === "assistant" && m.content && (...)` speak button block, add:

```tsx
            {m.role === "assistant" && m.sources && m.sources.length > 0 && (
              <div className="message__sources">
                <span className="message__sources-label">Sources</span>
                <ul>
                  {m.sources.map((s) => (
                    <li key={s.url}>
                      <a href={s.url} target="_blank" rel="noopener noreferrer">
                        {s.title || s.url}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
```

- [ ] **Step 2: Add CSS**

In `src/App.css`, near the other `.message__` rules (after `.message__image` around line 329), add:

```css
.message__sources {
  margin-top: 0.75rem;
  padding-top: 0.5rem;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  font-size: 0.8rem;
}

.message__sources-label {
  display: block;
  margin-bottom: 0.25rem;
  opacity: 0.6;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 0.7rem;
}

.message__sources ul {
  margin: 0;
  padding-left: 1.1rem;
}

.message__sources li {
  margin: 0.15rem 0;
}

.message__sources a {
  color: inherit;
  opacity: 0.85;
}

.message__sources a:hover {
  opacity: 1;
}
```

- [ ] **Step 3: Type-check and build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: End-to-end manual verification**

Run the app against the deployed/dev worker and check all five spec cases:

1. Text prompt needing fresh info (e.g. "what are the latest headlines about X today"): reply streams, a **Sources** list renders below it, links open in a new tab.
2. Reload the page: the sources list persists on the stored assistant message.
3. Text prompt not needing search (e.g. "write a haiku about rain"): normal reply, **no** Sources block.
4. Image message (attach a picture, ask about it): still answered via the completions path, no regression, no sources.
5. Error path: with an invalid/quota-exhausted key, the error surfaces cleanly in the UI (banner / ⚠️ text), streaming state clears.

Also confirm reasoning still collapses: if the model emits `<think>` content it is stripped from the visible answer as before.

- [ ] **Step 5: Commit**

```bash
git add src/ui/MessageList.tsx src/App.css
git commit -m "feat: render web_search sources under assistant replies"
```

---

## Self-Review

**Spec coverage:**
- Anthropic endpoint + web_search tool → Task 1. ✅
- Hybrid routing (text vs image) → Task 2. ✅
- SSE adapter (text/thinking/`web_search_tool_result` → app SSE + sources event) → Task 1. ✅
- `<think>` continuity + dedup + always-`[DONE]` → Task 1 (`inThink` state, `seenUrls`, `finish`). ✅
- Client `onSources` + `Message.sources` → Task 3. ✅
- Thread persistence via `setMessageSources` (rides existing storage serialization) → Task 4. ✅
- Sources list UI + CSS → Task 5. ✅
- Error handling (429, non-OK, mid-stream `error`) → Task 1 (`handleChatWithSearch` + adapter `error` case). ✅
- Verification cases → Task 5 Step 4. ✅
- No new deps / env vars → honored throughout. ✅

**Placeholder scan:** No TBD/TODO; all code shown in full. The one soft spot is Task 1 Step 3 (isolated adapter smoke) which may be skipped in favor of Task 5's live check — this is acknowledged, not a hidden gap.

**Type consistency:** `AnthropicSource`/`Source` share `{ title: string; url: string }` shape; the `sources` event payload, `onSources` param, `setMessageSources` arg, and `Message.sources` all use the same shape. `handleChatWithSearch(env, model, system, messages)` signature matches its call site in Task 2.

## Open risk (from spec)

MiniMax vision + web_search compatibility is unconfirmed; the hybrid routing sidesteps it. If confirmed later, the Task 2 image branch can be folded into the Anthropic path (needs OpenAI→Anthropic image-block conversion) — no other change required.
