import type { Env } from "./types";
import { getVoiceId } from "./persona";

interface TtsRequestBody {
  text: string;
  voice_id?: string;
  model?: string;
}

const DEFAULT_TTS_MODEL = "speech-2.6-hd";
const DEFAULT_VOICE_ID = "English_ManWithDeepVoice";

export async function handleTts(request: Request, env: Env, userEmail: string): Promise<Response> {
  if (!env.MINIMAX_API_KEY) {
    return jsonError("MINIMAX_API_KEY not configured", 500);
  }

  let body: TtsRequestBody;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  if (!body.text || !body.text.trim()) {
    return jsonError("Body must include non-empty { text }", 400);
  }

  // voice_id in the request (used by the Settings preview) wins; otherwise the
  // user's saved voice; otherwise the default.
  const voiceId = body.voice_id ?? (await getVoiceId(env, userEmail).catch(() => null)) ?? DEFAULT_VOICE_ID;

  const url = new URL(`${env.MINIMAX_BASE_URL}/v1/t2a_v2`);
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
      model: body.model ?? DEFAULT_TTS_MODEL,
      text: body.text,
      stream: false,
      output_format: "hex",
      voice_setting: {
        voice_id: voiceId,
        speed: 1,
        vol: 1,
        pitch: 0,
      },
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: "mp3",
        channel: 1,
      },
    }),
  });

  if (upstream.status === 429) {
    return jsonError(
      "Token Plan quota reached — retry after the 5h/weekly window resets.",
      429,
    );
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    return jsonError(`MiniMax TTS request failed: ${text || upstream.statusText}`, upstream.status);
  }

  const payload = await upstream.json<{
    data?: { audio?: string; status?: number };
    base_resp?: { status_code?: number; status_msg?: string };
  }>();

  const statusCode = payload.base_resp?.status_code;
  if (statusCode !== undefined && statusCode !== 0) {
    return jsonError(`MiniMax TTS error: ${payload.base_resp?.status_msg ?? statusCode}`, 502);
  }

  const hex = payload.data?.audio;
  if (!hex) {
    return jsonError("MiniMax TTS response had no audio data", 502);
  }

  const bytes = hexToBytes(hex);
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
    },
  });
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
