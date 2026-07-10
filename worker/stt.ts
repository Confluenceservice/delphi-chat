import type { Env } from "./types";

export async function handleStt(request: Request, env: Env): Promise<Response> {
  if (!env.ASR_API_KEY) {
    return jsonError("ASR_API_KEY not configured", 500);
  }

  let incoming: FormData;
  try {
    incoming = await request.formData();
  } catch {
    return jsonError("Expected multipart/form-data with an audio file", 400);
  }

  const file = incoming.get("file");
  if (!(file instanceof Blob)) {
    return jsonError("Missing 'file' field", 400);
  }

  const outgoing = new FormData();
  const filename = file instanceof File ? file.name : "audio.webm";
  outgoing.append("file", file, filename);
  outgoing.append("model", env.ASR_MODEL);

  const upstream = await fetch(`${env.ASR_BASE_URL}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.ASR_API_KEY}` },
    body: outgoing,
  });

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    return jsonError(`ASR request failed: ${text || upstream.statusText}`, upstream.status);
  }

  const payload = await upstream.json<{ text?: string }>();
  return new Response(JSON.stringify({ text: payload.text ?? "" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
