import type { Env } from "./types";

/**
 * POST /api/title { user, assistant } -> { title: string | null }
 * One cheap non-streaming MiniMax-M2.7 call. Failures return { title: null }
 * with status 200 so the client falls back silently to its default title.
 */

const TITLE_SYSTEM =
  "Write a chat title for this exchange. At most 6 words. " +
  "No quotes, no trailing punctuation. Reply with the title only.";

export async function handleTitle(request: Request, env: Env): Promise<Response> {
  let body: { user?: string; assistant?: string };
  try {
    body = await request.json();
  } catch {
    return json({ title: null });
  }
  if (!body.user || !body.assistant) return json({ title: null });

  try {
    const upstream = await fetch(`${env.MINIMAX_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.MINIMAX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "MiniMax-M2.7",
        messages: [
          { role: "system", content: TITLE_SYSTEM },
          {
            role: "user",
            content: `User: ${body.user.slice(0, 1000)}\n\nAssistant: ${body.assistant.slice(0, 1000)}`,
          },
        ],
        stream: false,
        temperature: 0.3,
        max_tokens: 64,
      }),
    });

    if (!upstream.ok) return json({ title: null });

    const data = (await upstream.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const raw = data.choices?.[0]?.message?.content ?? "";
    const title = cleanTitle(raw);
    return json({ title: title || null });
  } catch {
    return json({ title: null });
  }
}

function cleanTitle(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .trim()
    .replace(/^["'\u201c\u2018]+|["'\u201d\u2019]+$/g, "")
    .replace(/[.!?\s]+$/g, "")
    .slice(0, 60);
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
