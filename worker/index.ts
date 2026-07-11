import type { Env } from "./types";
import { resolveUserEmail } from "./auth";
import { handleChat } from "./chat";
import { handleTts } from "./tts";
import { handleStt } from "./stt";
import { handleMemoryClear, handleMemoryDelete, handleMemoryIngest, handleMemoryList } from "./memory-routes";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

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

      const memoryIdMatch = url.pathname.match(/^\/api\/memory\/([^/]+)$/);
      if (memoryIdMatch && request.method === "DELETE") {
        return handleMemoryDelete(decodeURIComponent(memoryIdMatch[1]), env, userEmail);
      }
    }

    return env.ASSETS.fetch(request);
  },
};
