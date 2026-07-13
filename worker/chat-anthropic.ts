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
      if (inThink) {
        controller.enqueue(contentChunk("</think>"));
        inThink = false;
      }
      const msg = json.error?.message ?? "web search stream error";
      controller.enqueue(contentChunk(`\n\n⚠️ ${msg}`));
    }
  }

  function processLine(
    line: string,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return; // skip "event:" and blanks
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") return;
    try {
      handleEvent(JSON.parse(data), controller);
    } catch {
      // ignore malformed chunk
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
        // Process any trailing buffered line (stream may end without a
        // final "\n\n"), then finish.
        buffer += DECODER.decode();
        if (buffer) processLine(buffer, controller);
        finish(controller);
        controller.close();
        return;
      }
      buffer += DECODER.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        processLine(line, controller);
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
