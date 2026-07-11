import type { Env } from "./types";
import { retrieveMemories } from "./memory";
import { buildSystemPrompt, getPersona } from "./persona";

interface ChatRequestBody {
  model: string;
  messages: unknown[];
  memory?: boolean;
}

interface ChatMessageShape {
  role?: string;
  content?: string | { type?: string; text?: string }[];
}

function extractLatestUserText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as ChatMessageShape;
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .filter((part) => part?.type === "text" && part.text)
        .map((part) => part.text)
        .join(" ");
    }
  }
  return "";
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

  const latestUserText = memoryEnabled ? extractLatestUserText(messages) : "";
  const [persona, memoryContext] = await Promise.all([
    getPersona(env, userEmail).catch(() => ""),
    latestUserText ? retrieveMemories(env, userEmail, latestUserText).catch(() => null) : Promise.resolve(null),
  ]);

  const systemPrompt = buildSystemPrompt({ persona, memoryEnabled, memoryContext });
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
