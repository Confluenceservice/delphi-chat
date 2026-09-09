# Swift Native Client — Design

Date: 2026-09-09
Status: Proposed (design only, not implemented)

## Goal

Replace the React web client with a native SwiftUI app for iOS and macOS that
uses Apple's on-device Foundation Model where it helps, keeps the Cloudflare
Worker as the grounded-inference and sync backend, and moves the entire audio
stack on-device.

Four motivations, all stated by the user, all load-bearing:

1. **Voice UX** — `ConversationMode` and the mic are constrained by the browser.
2. **Offline capability** — read threads and get useful answers with no network.
3. **Privacy / local inference** — personal turns need not reach a third party.
4. **Cost reduction** — titles and memory extraction burn a paid call per turn.

A thin native client over the existing API satisfies only (1). This design is
local-first because (2) and (3) require it.

## Verification debt

This design rests on claims about iOS/macOS 26–27 APIs that could not be
confirmed from primary documentation — Apple's developer pages do not render for
automated fetch, and the secondary sources available disagree in places. **Every
claim marked ⚠️ below must be confirmed in Phase 0 before code depends on it.**
One source's sample API (`FoundationModels.generate(fallback:)`) does not match
Apple's session-based style and was treated as unreliable and discarded.

## What exists today

| Area | File | Note |
|---|---|---|
| Chat stream | `worker/chat.ts` | SSE; emits a `{kb:…}` preamble, content deltas, a `{sources:…}` flush, `[DONE]` |
| Web search | `worker/chat-anthropic.ts` | MiniMax Anthropic endpoint, `web_search_20250305` |
| System prompt | `worker/persona.ts:109` | six blocks: search affordance, memory, evidence, persona, memory context, mode |
| KB retrieval | `worker/corpus.ts` | Vectorize, `KB_TOP_K = 4` |
| Embeddings | `worker/embed.ts` | Workers AI `@cf/baai/bge-m3` |
| Auth | `worker/auth.ts:93` | reads `Cf-Access-Jwt-Assertion`; `DEV_USER_EMAIL` fallback at `:100` |
| Thread persistence | `worker/thread-routes.ts:133` | `PUT` deletes all messages and re-inserts — whole-thread replace |
| Client sync | `src/state/sync.ts` | D1 is truth, localStorage is cache, dirty set, 2s debounce |
| Audio | `src/audio/{vad,recorder,player}.ts` | browser VAD, recorder, player |
| STT | `worker/stt.ts` | Groq `whisper-large-v3-turbo` via `ASR_*` |
| TTS | `worker/tts.ts` | MiniMax `/v1/t2a_v2`, hex audio, `base_resp` envelope |
| Rendering | `src/ui/AssistantBody.tsx` | markdown, `[n]` → `#kb-cite-n`, expandable excerpts |

24 API routes exist (17 exact-match plus 7 parameterized). All sit behind
Access middleware in `worker/index.ts`.

## Constraints that shape the design

- **On-device context is 4,096 tokens, fixed.** `buildSystemPrompt` assembles six
  blocks before any conversation history; `worker/chat.ts` sends full history on
  every request. That does not fit. The on-device model therefore cannot serve
  the existing prompt architecture — it needs its own, smaller one.
- **Vectorize is server-only.** KB retrieval and memory retrieval cannot move
  on-device. On-device turns are ungrounded turns.
- **`PUT /api/threads/:id` is whole-thread replace, last-writer-wins.** Any
  local-first sync must add a conflict check; it cannot merge per message.
- **Apple Foundation Models device floor** ⚠️ — iOS/macOS 26+, Apple
  Intelligence-capable hardware. `SystemLanguageModel.availability` must gate
  every local path, with the Worker as fallback.
- **Private Cloud Compute runs Apple's models only.** Third-party providers
  conform to `LanguageModel` and run on their own infrastructure. PCC is not a
  hosting option for someone else's model. ⚠️ PCC's availability and limits for
  third-party apps are contradicted across sources — see Phase 4.

## Architecture

```
  SwiftUI app (iOS 26+ / macOS 26+, shared core)
    │
    ├── LanguageModelSession
    │     ├── SystemLanguageModel        on-device, 4k, offline, free
    │     └── WorkerLanguageModel        /api/chat — grounded, search, images
    │           (Phase 4: PrivateCloudComputeLanguageModel)
    │
    ├── SpeechAnalyzer
    │     ├── SpeechTranscriber          replaces /api/stt + Groq
    │     └── SpeechDetector             replaces src/audio/vad.ts
    │
    ├── AVSpeechSynthesizer              replaces MiniMax TTS (default)
    │     └── opt-in: @cf/deepgram/aura-2-en via Worker
    │
    ├── SwiftData                        threads, messages, tombstones
    │     └── sync ⇄ D1 via /api/threads
    │
    └── Access Managed OAuth (PKCE)      Authorization: Bearer oauth:…

  Cloudflare Worker (unchanged except where noted)
    ├── /api/chat        grounded inference, web search, images
    ├── /api/threads     sync target
    ├── /api/memory      Vectorize retrieval + ingest
    ├── /api/kb/*        knowledge base
    └── Vectorize, D1, Workers AI embeddings
```

## 1. Data model and sync

### Shapes

`Thread` and `Message` (`src/state/types.ts:18-38`) become SwiftData `@Model`
classes. `sources`, `corpusSources`, and `images` are already JSON-serialized
into D1 columns, so they map to arrays of `Codable` structs with no wire change.
`Thread.model` is a plain `String`; threads created under any previous provider
keep opening. **No D1 migration is required for Phases 1–3.**

### Phase 1 — port today's model unchanged

D1 stays the source of truth; SwiftData is the cache. `src/state/sync.ts` is
reimplemented as a Swift actor with identical semantics: dirty set, 2s debounce,
full-thread `PUT`, and the same `pending`/`synced`/`error` states driving the
same UI affordance.

This is deliberately not an improvement. Phase 1 must be provably equivalent to
the web app, or a port bug is indistinguishable from a design bug.

### Phase 2 — invert to local-first

SwiftData becomes truth; D1 becomes a replica pushed to on mutation and pulled
from on cold start. Two additive Worker changes:

- `GET /api/threads` already returns `updated_at`. The client sends
  `If-Unmodified-Since: <updatedAt>` on `PUT`; the Worker returns **409** when D1
  is newer. Today's blind overwrite becomes a detectable conflict.
- On 409 the device keeps its version and **forks the server copy into a new
  thread titled `<title> (conflict)`**, then tells the user. A turn is never
  silently discarded.

Deletes move from a localStorage set to a SwiftData tombstone table, so a delete
survives app termination mid-flush.

**Out of scope:** per-message merge or CRDT. Whole-thread replace is adequate for
one person on two devices who is not editing the same thread offline
simultaneously.

## 2. Inference

### Explicit routing, visible engine

A heuristic router that silently substitutes a weaker model would be the worst
possible failure mode: the user cannot tell why an answer got worse. Routing is
therefore determined by observable conditions, and **the UI always shows which
engine answered.**

| Condition | Engine | User loses |
|---|---|---|
| Offline | on-device | KB citations, web search, long context |
| Private mode (explicit toggle) | on-device | same, by choice |
| Turn needs KB or web search | Worker | — |
| Turn contains images | Worker | — (⚠️ FM vision unconfirmed; assume text-only) |
| `SystemLanguageModel.availability` == unavailable | Worker | — (safe to hide) |
| Otherwise, online | Worker | — |

**Rejected:** routing locally when no KB match. The client cannot know whether
KB matched without a server round-trip — `corpusExcerpts` comes from Vectorize.
Any router guessing at grounding is guessing.

### `LanguageModel` conformances ⚠️

The Worker is wrapped as a `LanguageModel` conformance so all engines are driven
through one `LanguageModelSession`. Streaming, prompt assembly, and cancellation
are written once, and Phase 4 becomes a new conformance rather than a rewrite.

⚠️ Phase 0 must confirm the `LanguageModel` / `LanguageModelExecutor` protocol
shape, and whether `CoreAILanguageModel` is the intended first-party way to wrap
an owned HTTP backend. If the protocol is unusable for this, fall back to a
plain Swift protocol with the same three conformances; nothing else changes.

### Two prompt builders

`buildSystemPrompt` cannot fit 4,096 alongside history. The local builder is a
separate, smaller function — not a parameterization of the server one:

- **drops** the web-search affordance block, the evidence block, and all `[n]`
  citation rules. An on-device turn has no numbered excerpts and must never be
  taught the `[n]` grammar. This is the citation-collision fix.
- **keeps** persona, a candor rule, and the `Verify:` line. The ungrounded rules
  already written at `persona.ts:74-83` are reused verbatim rather than
  reinvented.
- **trims** memory context to top-N facts rather than all matches.

`buildModeBlock` (answer/tutor) applies to both builders. Mode is orthogonal to
engine.

### Budget enforcement

Before each on-device turn: `tokenCount(for:)` ⚠️ the assembled prompt, subtract
from `contextSize` ⚠️, reserve headroom for the reply, then drop oldest history
turns until it fits. **If the prompt alone exceeds budget with zero history,
refuse locally and say so.** The user's own question is never silently
truncated.

### Foundation Model jobs that run on every route

- **Titles** — replaces `POST /api/title` and its hardcoded `MiniMax-M2.7`.
- **Memory extraction** — replaces `worker/memory.ts`'s hardcoded `MiniMax-M3`,
  using `@Generable` guided generation instead of `parseFactsJson`, which today
  returns empty on parse failure and degrades silently. Structured decoding
  should be strictly better; Phase 0 spike 5 measures it rather than assuming.
- Extracted facts still `POST /api/memory/ingest`, so Vectorize remains the
  retrieval index. Extraction is local; storage stays server-side.

### Explicitly parked

Which provider backs the Worker's `/api/chat`. That is the separate, still
unwritten de-MiniMax spec. The native client calls `/api/chat` and does not care.

## 3. Audio

| Today | Native | Effect |
|---|---|---|
| `POST /api/stt` → Groq | `SpeechTranscriber` | offline, free, no network in path |
| `src/audio/vad.ts` | `SpeechDetector` | native VAD, no tab-lifecycle fight |
| `POST /api/tts` → MiniMax | `AVSpeechSynthesizer` | offline, free |

`SpeechAnalyzer` and its modules ship on iOS/iPadOS/macOS/tvOS/visionOS 26. Not
watchOS — hence watchOS is out of scope.

### TTS: on-device default, Aura opt-in

| | `AVSpeechSynthesizer` | `@cf/deepgram/aura-2-en` via Worker |
|---|---|---|
| Offline | yes | no |
| Cost | free | per-character |
| Privacy | nothing leaves device | reply text goes to Worker |
| Quality | adequate | markedly better, ~40 named voices |

Default on-device; expose Aura as a per-user quality opt-in. Either way MiniMax
TTS dies — `/v1/t2a_v2`, the hex-audio decode, and the `base_resp` envelope all go.

### Voice catalog

`0004_user_voice.sql` stores MiniMax System Voice IDs, meaningless to both
replacements, and no mapping exists. **Do not map.** On first native launch,
reset the stored voice to the platform default and prompt the user to pick once.
`/api/voice` GET/PUT keep working; only the value space changes.

### ConversationMode

The largest native win, and the set of things a browser cannot do:

- `AVAudioSession` with `.playAndRecord`, `.duckOthers`, Bluetooth route
  handling for AirPods
- background audio mode, so a reply finishes when the screen locks
- interruption handling — a phone call mid-reply resumes cleanly
- **barge-in**: `SpeechDetector` stays live during synthesis; user speech stops
  playback and starts capture

## 4. Auth and networking

### Flow

`ASWebAuthenticationSession` → Access **Managed OAuth** (PKCE, RFC 8707 public
client, no client secret) → opaque token `oauth:…` → every request carries
`Authorization: Bearer oauth:…`. Cloudflare resolves the token at the edge and
forwards `Cf-Access-Jwt-Assertion` to the origin, so **`worker/auth.ts` is
untouched** and the audit log at `worker/index.ts:39` keeps recording a real
email per request.

Set `prefersEphemeralWebBrowserSession = true`; a shared Safari cookie can
otherwise sign in the wrong account silently.

### Redirect URI

Register an HTTPS callback on the app's own domain that does nothing but `302`
to `myapp://oauth/callback`. The relay must not store the code, exchange the
token, or hold a secret — PKCE and state verification stay on the device.

**That callback path must be exempt from Managed Challenge and Bot Fight Mode.**
A challenge page rendered inside `ASWebAuthenticationSession` halts authorization
halfway with no useful error.

### Token lifecycle

Access tokens are short by design (5–15 min recommended against 1–2 week grant
sessions), so refresh is on the hot path:

- Keychain, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` — background sync
  works with the device locked; the token never syncs to another device.
- Refresh serialized through an actor with **request coalescing**: ten
  concurrent 401s produce one refresh.
- **Proactive refresh before opening a chat stream.** A long SSE response that
  401s mid-stream cannot be blindly retried, because tokens are already rendered
  and a retry duplicates them. If expiry is under ~60s, refresh first.

### SSE client

`URLSession.bytes(for:)` as an `AsyncSequence` with a line-buffered `data:`
parser handling three payload shapes:

| Payload | Source | Handling |
|---|---|---|
| `{kb:{mode,grounded,sources}}` | preamble, `worker/chat.ts:46` | attach before any token |
| `choices[].delta.content` | body | append, strip `<think>…</think>` |
| `{sources:[{title,url}]}` | flushed before `[DONE]` | attach web citations |

`<think>` stripping (`src/lib/thinking.ts`) ports as a streaming state machine.
The tags can split across chunk boundaries; the current implementation handles
this and a naive port would not.

### Logout

Clears the Keychain, revokes the OAuth grant, hits `/cdn-cgi/access/logout`, and
offers to wipe the local SwiftData store rather than leaving thread history on a
signed-out device.

### Security: fail closed

`resolveUserEmail` (`worker/auth.ts:100`) falls back to `env.DEV_USER_EMAIL`
whenever Access verification returns null. If `CF_ACCESS_TEAM_DOMAIN` or
`CF_ACCESS_AUD` is unset or misconfigured, every unauthenticated request resolves
to that identity and all 24 routes open.

**Required change, before any build ships:** `DEV_USER_EMAIL` must be absent in
production, and the Worker must return 401 rather than fall back when the Access
vars are missing. This is not a Phase 2 item.

## 5. Knowledge base, search, and grounding

KB retrieval stays entirely server-side — it needs Vectorize plus
`@cf/baai/bge-m3`, neither of which has an on-device equivalent worth building.
This is a deliberate ceiling: **on-device turns are ungrounded turns**, and the
UI says so.

### Grounding block by engine

| Engine | Evidence block | `[n]` grammar | `Verify:` line | Web search |
|---|---|---|---|---|
| Worker, KB matched | yes, `KB_TOP_K = 4` | taught | no | yes |
| Worker, no match | no | forbidden | required | yes |
| On-device | no | **never mentioned** | required | no |

### Cached citations survive offline

`corpusSources` and `sources` are stored on the message and persisted in D1
columns, so an old grounded reply renders its excerpts and links with no network.
Only *new* turns lose grounding. This falls out of the data model; nothing to
build.

### Rendering

`AssistantBody.tsx` does three things SwiftUI does not do for free: markdown with
code blocks and tables, `[n]` → tappable citation anchors, and an expandable
per-excerpt panel with `origin` badges. SwiftUI's `AttributedString` markdown
handles inline styling only.

**Use `swift-markdown-ui` with a custom inline transformer for `[n]`. Not a
`WKWebView`** — a web view would port the CSS for free but breaks text
selection, Dynamic Type, and VoiceOver, undercutting the reason for going native.

### Web search

Unchanged and invisible to the client. It happens inside `/api/chat`; the app
consumes the `{sources:[{title,url}]}` event. Whatever the de-MiniMax spec later
decides about search providers, the native client needs no change.

### KB admin scope cut

Native v1 ships two of the seven KB routes: inline `POST /api/kb/suggest` from a
message (the `kbSuggested` flag already models this) and read-only
`GET /api/kb/docs`. The moderation queue — `queue`, `approve`, `dismiss`,
`seed`, `docs/:id DELETE` — stays web-and-admin-only. Building a moderation UI
twice for one admin is not worth it.

### Optional: local memory cache (Phase 3)

Memory facts are small per-user D1 rows. Syncing them into SwiftData would let
on-device turns use personal context with no server call, which is the strongest
form of the privacy motivation. Retrieval would be recency-plus-keyword locally
versus semantic online, so answers differ by engine. This is the one place two
retrieval implementations are acceptable, and it is optional.

## 6. Phasing

Repo layout: same repo, new `apple/` directory. The API contract, the specs, and
the Worker move together; a separate repo would let the contract drift.

### Phase 0 — verification spikes, no production code

| # | Question | How | Gates |
|---|---|---|---|
| 1 | `LanguageModel` / `LanguageModelExecutor` shape; can `CoreAILanguageModel` wrap the Worker? | Xcode 27 SDK, WWDC26 session 339 | whole architecture |
| 2 | Managed OAuth: dynamic client registration, real token lifetimes, `Cf-Access-Jwt-Assertion` reaching origin | curl; no Swift needed | §4 |
| 3 | `contextSize` / `tokenCount(for:)` on the OS floor | SDK | §2 budget enforcement |
| 4 | FM vision — text-only or multimodal? | SDK | image-turn routing |
| 5 | `@Generable` extraction vs `parseFactsJson`, measured on real threads | offline harness | FM memory extraction |
| 6 | PCC third-party availability and limits | SDK + docs | Phase 4 only |

Spike 2 requires no Swift and de-risks the most. Do it first.

### Phase 1 — native shell, provably equivalent

Managed OAuth, SwiftData as cache, ported `sync.ts` semantics, native audio
stack, `swift-markdown-ui` rendering, Foundation Model for titles and memory
extraction. Chat goes to the Worker only.

**Done when:** every user-visible behavior matches the web app, and `/api/stt`
and `/api/tts` are never called by the native client.

### Phase 2 — invert sync

SwiftData becomes truth. `If-Unmodified-Since` on `PUT /api/threads/:id`, 409
from the Worker, conflict fork on the client, tombstone table for deletes.

**Done when:** two devices editing the same thread offline both retain their
turns, with a visible conflict thread. Requires a D1 backup and a staged
rollout — this is the only step that can lose data.

### Phase 3 — offline chat

On-device engine behind the explicit ladder, local prompt builder, token-budget
enforcement with oldest-turn trimming, engine indicator in the UI. Optionally the
local memory cache.

**Done when:** airplane mode produces a useful, clearly-labeled, uncited answer,
and never silently truncates the user's question.

### Phase 4 — Private Cloud Compute

Only if spike 6 confirms it is usable by third-party apps. A new conformance and
one new rung on the ladder; nothing else changes. That is the payoff for the
conformance architecture.

PCC would add a ~32,000-token ⚠️ tier that is private and free ⚠️ but has **no
access to Vectorize KB or web search** — so it does not replace the Worker, it
fills the gap between 4k on-device and paid grounded inference.

## Testing

The conformance protocol is the leverage: a mock `LanguageModel` makes the whole
chat pipeline testable with no network and no model.

- Mock conformance for routing, budget enforcement, and prompt-builder selection
- Recorded-SSE fixture replay for all three payload shapes
- A `<think>` test with tags deliberately split across chunk boundaries
- Sync conflict tests: 409 handling, tombstone replay after termination
- Extraction comparison harness (spike 5) run against real thread data

## Risks

- **Verification debt.** Six ⚠️ claims. Phase 0 converts them; nothing may be
  built on a secondary source.
- **Sync inversion with live data** (Phase 2) — the only step that can lose a
  user's turns.
- **`DEV_USER_EMAIL` fallback** — must fail closed before any build ships.
- **Foundation Model extraction quality** — silent degradation if worse than
  today. Spike 5 measures rather than assumes.
- **Scope.** Four phases, two platforms, a new auth flow, a full UI port. Phase 1
  alone is substantial. Nothing here should be read as a short project.

## Out of scope

watchOS (no `SpeechAnalyzer`), widgets, Shortcuts / App Intents, push
notifications, multi-user sharing, per-message CRDT sync, KB moderation in
native, and the parked de-MiniMax provider work
(`2026-08-29-provider-seam-design.md`, still Proposed).
