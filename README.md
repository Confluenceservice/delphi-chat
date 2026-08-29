# Delphi Chat

Mobile-friendly chat app powered by the MiniMax model family (Token Plan). React +
Vite frontend, single Cloudflare Worker backend (chat proxy, TTS, STT, memory).

Test push-to-talk, read-aloud, and conversation mode on the deployed Access-protected
custom domain (see `routes` in `wrangler.toml`) — `wrangler dev` on localhost can't be
reached from a phone, and mic/service-worker access needs a secure context.

See `docs/superpowers/specs/2026-07-11-minimax-chat-design.md` for the full design.

## Model dependencies

Seven capabilities across three providers. Two of them are MiniMax-specific and
are the reason this is not simply "swap the base URL":

| Capability | Provider | Config | Swappable |
|---|---|---|---|
| Chat streaming | MiniMax `/v1/chat/completions` | `MINIMAX_API_KEY`, `MINIMAX_BASE_URL` | **Yes** — standard OpenAI shape, any compatible endpoint |
| Chat titles | MiniMax, model hardcoded (`MiniMax-M2.7`) | same | Yes, once the model ID moves to config |
| Memory extraction | MiniMax, model hardcoded (`MiniMax-M3`) | same | Yes, same caveat; also strips `<think>` blocks |
| Web search | MiniMax `/anthropic/v1/messages`, `web_search` server tool | same | **No** — MiniMax-only endpoint and response shape |
| Text-to-speech | MiniMax `/v1/t2a_v2` | same | **No** — MiniMax voice IDs, hex audio, `base_resp` envelope |
| Speech-to-text | Groq (default) or OpenAI Whisper | `ASR_PROVIDER`, `ASR_BASE_URL`, `ASR_MODEL`, `ASR_API_KEY` | **Already abstracted** |
| Embeddings | Cloudflare Workers AI `@cf/baai/bge-m3` | `[ai]` binding | Provider-free |

Practical consequence: pointing chat at another provider (OpenRouter, OpenAI,
a local endpoint) is a contained change, but web search and read-aloud have no
equivalent there and would stay on MiniMax or be lost. `worker/stt.ts` is the
existing template for how a provider seam should look here.

Selectable chat models live in `MODELS` in `src/state/types.ts`.
See `docs/superpowers/specs/2026-08-29-provider-seam-design.md` for a design that
makes the chat provider pluggable while keeping voice and search on MiniMax.

## Setup

1. Install deps:
   ```
   npm install
   ```
2. Create your config from the template:
   ```
   cp wrangler.example.toml wrangler.toml
   ```
   `wrangler.toml` is gitignored because it holds account-specific values. Fill in
   the two placeholders: `routes.pattern` (the custom domain serving this Worker —
   the zone must already exist on your account) and `d1_databases.database_id`
   (from `npx wrangler d1 create minimax-chat-memory`, or `npx wrangler d1 info
   minimax-chat-memory` for an existing database).
3. Set secrets (never commit these):
   ```
   npx wrangler secret put MINIMAX_API_KEY      # MiniMax Token Plan subscription key
   npx wrangler secret put ASR_API_KEY          # Groq (default) or OpenAI Whisper key
   npx wrangler secret put CF_ACCESS_TEAM_DOMAIN # e.g. https://yourteam.cloudflareaccess.com
   npx wrangler secret put CF_ACCESS_AUD        # Access Application Audience (AUD) tag
   npx wrangler secret put ADMIN_EMAILS         # comma-separated emails allowed to hit /api/admin/*
   ```
   `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` are required — without them the Worker
   cannot verify `Cf-Access-Jwt-Assertion` and every `/api/*` request is rejected as
   unauthorized. Find both in the Cloudflare Zero Trust dashboard under
   Access > Applications > (this app) > Overview.
4. Optional vars in `wrangler.toml` (`MINIMAX_GROUP_ID`, `ASR_PROVIDER`, `ASR_BASE_URL`, `ASR_MODEL`).
5. `workers_dev` is set to `false` in `wrangler.toml` so the app is only reachable
   through the Access-protected custom domain — do not re-enable it without also
   protecting the workers.dev route in Access.

## Develop

```
npm run build   # builds the SPA into dist/
npx wrangler dev
```

Wrangler serves the built SPA and `/api/*` from one process (rebuild after frontend
changes, or run `npm run build -- --watch` alongside `wrangler dev`).

## Local development auth

CF Access is not available in `wrangler dev`. Set `DEV_USER_EMAIL=you@example.com` in
`.dev.vars` to simulate an authenticated user.

## Deploy

```
npm run build
npx wrangler deploy
```
