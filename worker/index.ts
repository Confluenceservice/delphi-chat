import type { Env } from "./types";
import { handleChat } from "./chat";
import { handleTts } from "./tts";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/chat" && request.method === "POST") {
      return handleChat(request, env);
    }

    if (url.pathname === "/api/tts" && request.method === "POST") {
      return handleTts(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};
