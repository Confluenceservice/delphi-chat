import type { Env } from "./types";
import { getPersona, setPersona } from "./persona";

export async function handlePersonaGet(env: Env, userEmail: string): Promise<Response> {
  const persona = await getPersona(env, userEmail);
  return json({ persona });
}

export async function handlePersonaPut(request: Request, env: Env, userEmail: string): Promise<Response> {
  let body: { persona?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }
  if (typeof body.persona !== "string") {
    return jsonError("Body must include { persona: string }", 400);
  }
  await setPersona(env, userEmail, body.persona);
  return json({ ok: true });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
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
