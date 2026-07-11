# MiniMax Chat

Mobile-friendly chat app powered by the MiniMax model family (Token Plan). React +
Vite frontend, single Cloudflare Worker backend (chat proxy, TTS, STT, memory).

**Live:** the deployed custom domain — open this on your phone to
test push-to-talk, read-aloud, and conversation mode; `wrangler dev` on localhost
can't be reached from a phone and mic/service-worker access needs a secure context.

See `docs/superpowers/specs/2026-07-11-minimax-chat-design.md` for the full design.

## Setup

1. Install deps:
   ```
   npm install
   ```
2. Set secrets (never commit these):
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
3. Optional vars in `wrangler.toml` (`MINIMAX_GROUP_ID`, `ASR_PROVIDER`, `ASR_BASE_URL`, `ASR_MODEL`).
4. `workers_dev` is set to `false` in `wrangler.toml` so the app is only reachable
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
