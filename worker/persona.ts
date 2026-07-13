import type { Env } from "./types";

export const MAX_PERSONA_LENGTH = 2000;

export async function getPersona(env: Env, userEmail: string): Promise<string> {
  const row = await env.DB.prepare("SELECT persona FROM user_settings WHERE user_email = ?")
    .bind(userEmail)
    .first<{ persona: string | null }>();
  return row?.persona ?? "";
}

export async function setPersona(env: Env, userEmail: string, persona: string): Promise<void> {
  const trimmed = persona.slice(0, MAX_PERSONA_LENGTH);
  await env.DB.prepare(
    `INSERT INTO user_settings (user_email, persona, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(user_email) DO UPDATE SET persona = excluded.persona, updated_at = excluded.updated_at`,
  )
    .bind(userEmail, trimmed, Math.floor(Date.now() / 1000))
    .run();
}

export async function getVoiceId(env: Env, userEmail: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT voice_id FROM user_settings WHERE user_email = ?")
    .bind(userEmail)
    .first<{ voice_id: string | null }>();
  return row?.voice_id ?? null;
}

export async function setVoiceId(env: Env, userEmail: string, voiceId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO user_settings (user_email, voice_id, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(user_email) DO UPDATE SET voice_id = excluded.voice_id, updated_at = excluded.updated_at`,
  )
    .bind(userEmail, voiceId, Math.floor(Date.now() / 1000))
    .run();
}

/**
 * Assemble the single authoritative system prompt for a chat turn: a base
 * identity that makes the model aware it has a persistent long-term memory,
 * the user's custom persona (if any), and the facts retrieved for this turn
 * (if memory is enabled and any matched).
 */
export function buildSystemPrompt(opts: {
  persona: string;
  memoryEnabled: boolean;
  memoryContext: string | null;
  webSearch: boolean;
}): string {
  const parts: string[] = [];

  if (opts.webSearch) {
    parts.push(
      "You can search the web for current information. Use it whenever a question " +
        "involves recent events, current facts, prices, schedules, or anything " +
        "time-sensitive or that you are unsure about, and cite the sources you find. " +
        "Never claim you cannot access the internet.",
    );
  }

  if (opts.memoryEnabled) {
    parts.push(
      "You have a persistent long-term memory of facts the user has shared with you across past conversations. " +
        "When relevant remembered facts are provided below, use them naturally to personalize your response — " +
        "do not announce that you are recalling them, and do not claim you lack memory of past conversations.",
    );
  } else {
    parts.push("You are a helpful assistant.");
  }

  if (opts.persona.trim()) {
    parts.push(`The user has configured how you should behave:\n${opts.persona.trim()}`);
  }

  if (opts.memoryContext) {
    parts.push(`Relevant things you remember about the user:\n${opts.memoryContext}`);
  }

  return parts.join("\n\n");
}
