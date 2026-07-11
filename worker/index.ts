import type { Env } from "./types";
import { resolveUserEmail } from "./auth";
import { handleChat } from "./chat";
import { handleTts } from "./tts";
import { handleStt } from "./stt";
import { handleMemoryClear, handleMemoryDelete, handleMemoryIngest, handleMemoryList } from "./memory-routes";

async function logRequest(
  env: Env,
  userEmail: string | null,
  request: Request,
  start: number,
  status: number,
  error?: string,
) {
  try {
    const url = new URL(request.url);
    await env.DB.prepare(
      `INSERT INTO audit_log (user_email, method, path, status, duration_ms, error)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(userEmail, request.method, url.pathname, status, Date.now() - start, error ?? null)
      .run();
  } catch {
    // never let audit logging break the main response
  }
}

async function handleAuditList(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare("SELECT * FROM audit_log ORDER BY ts DESC LIMIT 100").all();
  return new Response(JSON.stringify({ entries: results }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname.startsWith("/api/")) {
    const userEmail = resolveUserEmail(request, env);
    if (!userEmail) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      return handleChat(request, env, userEmail);
    }

    if (url.pathname === "/api/tts" && request.method === "POST") {
      return handleTts(request, env);
    }

    if (url.pathname === "/api/stt" && request.method === "POST") {
      return handleStt(request, env);
    }

    if (url.pathname === "/api/memory/ingest" && request.method === "POST") {
      return handleMemoryIngest(request, env, userEmail);
    }

    if (url.pathname === "/api/memory" && request.method === "GET") {
      return handleMemoryList(env, userEmail);
    }

    if (url.pathname === "/api/memory" && request.method === "DELETE") {
      return handleMemoryClear(env, userEmail);
    }

    if (url.pathname === "/api/admin/audit" && request.method === "GET") {
      return handleAuditList(env);
    }

    const memoryIdMatch = url.pathname.match(/^\/api\/memory\/([^/]+)$/);
    if (memoryIdMatch && request.method === "DELETE") {
      return handleMemoryDelete(decodeURIComponent(memoryIdMatch[1]), env, userEmail);
    }
  }

  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const start = Date.now();
    const userEmail = resolveUserEmail(request, env);
    let status = 500;
    let errorMessage: string | undefined;

    try {
      const response = await route(request, env, url);
      status = response.status;
      return response;
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      return new Response("Internal Server Error", { status: 500 });
    } finally {
      await logRequest(env, userEmail, request, start, status, errorMessage);
    }
  },
};
