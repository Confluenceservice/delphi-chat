import type { Env } from "./types";
import { retrieveMemories } from "./memory";
import { buildSystemPrompt, getPersona } from "./persona";
import { handleChatWithSearch } from "./chat-anthropic";

interface ChatRequestBody {
  model: string;
  messages: unknown[];
  memory?: boolean;
}

export async function handleChat(request: Request, env: Env, userEmail: string): Promise<Response> {
  if (!env.MINIMAX_API_KEY) {
    return jsonError("MINIMAX_API_KEY not configured", 500);
  }

  let body: ChatRequestBody;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  if (!body.model || !Array.isArray(body.messages)) {
    return jsonError("Body must include { model, messages }", 400);
  }

  const messages = [...body.messages];
  const memoryEnabled = body.memory !== false;

  const [persona, memoryContext] = await Promise.all([
    getPersona(env, userEmail).catch(() => ""),
    memoryEnabled ? retrieveMemories(env, userEmail).catch(() => null) : Promise.resolve(null),
  ]);

  // Text-only turns get web search via the Anthropic endpoint. Image turns fall
  // back to the OpenAI-compatible passthrough (vision + web_search unconfirmed),
  // so only text turns advertise the search capability in the system prompt.
  const webSearch = !hasImageContent(messages);
  const systemPrompt = buildSystemPrompt({ persona, memoryEnabled, memoryContext, webSearch });

  if (webSearch) {
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

  if (upstream.status === 429) {
    return jsonError(
      "Token Plan quota reached — retry after the 5h/weekly window resets.",
      429,
    );
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return jsonError(`MiniMax chat request failed: ${text || upstream.statusText}`, upstream.status);
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function hasImageContent(messages: unknown[]): boolean {
  return messages.some((m) => {
    const content = (m as { content?: unknown })?.content;
    return (
      Array.isArray(content) &&
      content.some((part) => (part as { type?: string })?.type === "image_url")
    );
  });
}
