# Swift Native Client — Design

Date: 2026-09-09
Revised: 2026-09-10 — reconciled against Phase 0 (task 8), then again the same
day when spike 2's human sign-in closed the last open gate
Status: Proposed (design only, not implemented). All six Phase 0 spikes have
returned and **none is outstanding**; several questions were established as
needing a device rather than answered. Read "Phase 0 outcome and the Phase 1
go/no-go" below before building against any section.

## Goal

Replace the React web client with a native SwiftUI app for iOS and macOS that
uses Apple's on-device Foundation Model where it helps, keeps the Cloudflare
Worker as the grounded-inference and sync backend, and moves the entire audio
stack on-device.

Four motivations, all stated by the user, all load-bearing:

1. **Voice UX** — `ConversationMode` and the mic are constrained by the browser.
2. **Offline capability** — read threads and get useful answers with no network.
3. **Privacy / local inference** — personal turns need not reach a third party.
   Phase 0 narrowed what this can mean for *image* turns: see the note below.
4. **Cost reduction** — titles and memory extraction burn a paid call per turn.
   Phase 0 measured extraction and it does not pay for itself on-device; see §2.

A thin native client over the existing API satisfies only (1). This design is
local-first because (2) and (3) require it.

**Qualification on (3), established in Phase 0 (spike 4).** Routing a turn to
the Worker does not keep its content out of Foundation Models. An image-bearing
turn is representable in a `Transcript` as
`Transcript.Segment.attachment(…)` → `Transcript.Attachment.image(…)`, and a
custom `LanguageModelExecutor` — which is exactly how this design wraps the
Worker (§2) — is handed the transcript. On an image turn the Worker executor
therefore *receives* the image and has to encode it for the Worker itself. The
privacy claim that survives is "the turn does not reach a third-party inference
provider", not "the turn never enters Foundation Models". Probe-verified;
`delphi-apple/API-NOTES.md`, spike 4, "The transcript-level image path".

## Phase 0 outcome and the Phase 1 go/no-go

Phase 0 ran six numbered verification spikes — plan tasks 2 through 7, plus a
harness task and two rounds of quote-verification tooling — against the real
iOS 27.0 SDK (Xcode 27.0, build 27A5228h) and the live Cloudflare deployment.
The evidence is recorded in `Confluenceservice/delphi-apple`, file
`API-NOTES.md`, one entry per spike, with retained control probes and a
mechanical quote verifier (`bin/verify-quotes`). That file is the authority;
this section summarises it and this spec has been rewritten to match it.
**No unverified-claim markers remain.** The spec carried **nine** marked
claims before this reconciliation. Eleven is the raw ⚠️ glyph count and is the
wrong number: one glyph was the legend sentence explaining what the marker
meant, and one was the spec's own self-tally, which said six and was also
wrong. Nine is the count of substantive marked claims. Every claim below is now
either established, explicitly not established, or falsified and rewritten.
(Derive it rather than trusting this sentence — `git show 251ac80:docs/superpowers/specs/2026-09-09-swift-native-client-design.md | grep -n '⚠️'`
prints the ten marked *lines*; one of them carries two markers, giving eleven
glyphs, and two of those eleven are the legend and the self-tally. Read the
lines and classify them yourself rather than taking any of these four numbers
on trust — the reason this sentence needed fixing is that a glyph count was
reported as a claim count.)

| Spike | Question | Outcome |
|---|---|---|
| 1 | Can a custom conformance wrap the Worker as a `LanguageModel`? | **Yes**, probe-verified. §2's architecture stands. `CoreAILanguageModel` does not exist and is withdrawn. |
| 2 | Access Managed OAuth end to end | **Yes.** The sign-in happened; a token was issued, the origin accepted it, the Worker ran and `audit_log` recorded a real identity. §4's central claim — `worker/auth.ts` needs no changes — **holds**. One qualification: assertion-header delivery is **inferred from a chain, not observed**. |
| 3 | `contextSize` / `tokenCount(for:)` usable for a pre-generation budget | **Yes** — but the window is **runtime-discovered**, not the fixed 4,096 this spec asserted. |
| 4 | Foundation Models vision | **API-level yes.** "Assume text-only" is **falsified**. Whether the on-device model *declares* `.vision` is unestablished. |
| 5 | On-device `@Generable` memory extraction vs today's extractor | **Measured NO-GO.** And the defect that motivated the move did not occur once in 96 baseline calls. |
| 6 | Private Cloud Compute usable by third-party apps | **API-level yes.** Promote out of speculative Phase 4, sequenced behind a device spike. Runtime access unestablished. |

The tooling tasks produced `bin/verify-quotes`, which mechanically re-derives
quoted compiler diagnostics and `.swiftinterface` excerpts in `API-NOTES.md`
against their real sources and names every block it could *not* check. They
produced no design claim; they are why the claims above can be re-checked
rather than believed.

### Verdict: **GO for Phase 1**, no longer gated.

**The gate is closed.** It was §4's core claim — that Access converts a Managed
OAuth bearer token into a `Cf-Access-Jwt-Assertion` header at the origin, so
`worker/auth.ts` is untouched. On 2026-09-10 a person signed in, the exchange
ran, and the token was presented to `GET /api/threads`. The Worker returned
`200` with its own JSON body, and `audit_log` recorded the signed-in user's
real SSO address. Every item this section previously listed as unconfirmed is
answered: token issuance, `expires_in` (`900`, exactly the configured 15
minutes), the `oauth:` prefix (present on the access token *and* the refresh
token), refresh-token issuance, origin acceptance, and the `audit_log`
identity. **`worker/auth.ts` needed no changes, and that is now a finding
rather than an assumption.**

**One claim inside that result is weaker than the others, and must be cited as
such: the assertion header was never observed.** Nothing read
`Cf-Access-Jwt-Assertion`. That it reaches the origin is **inferred from a
chain**: the `200` means `resolveUserEmail` returned non-null
(`worker/index.ts:59-62` 401s otherwise); `DEV_USER_EMAIL` is absent from the
deployment as both secret and `[vars]`, so the fallback branch could not have
supplied it; therefore the value came from `getUserEmail`
(`worker/auth.ts:93-97`), which reads that header at `worker/auth.ts:94` and
returns null without it. `API-NOTES.md` labels this **mechanism-reasoning**,
the class it already uses for exactly this shape of argument, which ranks below
every observed class in that file. The chain is checkable link by link; none of
the links is the header, and one of them — `DEV_USER_EMAIL`'s absence — is a
mutable deployment fact rather than a property of the code. Do not restate it
as "verified".

Note also what the `audit_log` row can and cannot carry. Access delivers the
same assertion header for a cookie-authenticated *browser* request, and the web
app hits the same route — so a row with a real email proves some request
carried a verified assertion, not that this one did. The row's contribution is
the identity *value*; the load-bearing observation is the `200` with a
Worker-shaped body.

**Startable today, and nothing waits on anything:** the `LanguageModel`
conformance architecture (§2, spike 1), the native audio stack (§3, untouched
by any spike), `swift-markdown-ui` rendering (§5), and — now — SwiftData and
the ported sync semantics (§1). See the next paragraph for the one thing that
changed about §1 and the one thing that did not.

**§1 keeps its "build against a mock" label, and the reason for it has
changed.** The mock stays because it is the right development substrate:
offline work, unit tests and CI cannot reach an Access-protected route, and a
deterministic transport is what a port-fidelity test wants anyway. What is
withdrawn is the sentence that said this work **"cannot be exercised against
the real Worker at all"** — that is now false. A real token reaches the origin
and comes back with a real Worker response.

So the constraint moved from a **gate** to a **cost**. End-to-end exercise is
possible; each round of it needs a fresh 15-minute token, and a fresh token
needs an interactive human sign-in, because the refresh grant has been *issued*
but never *exercised* (see §2's note). Consequence for §1's "provably
equivalent to the web app" requirement: it is no longer unprovable until some
future event. It is provable now, in batches, at the price of a sign-in — and
"sync is correct" should not be claimed on mock evidence alone, because a port
bug and a mock-fidelity bug remain indistinguishable until something has
actually crossed the wire.

**Removed from Phase 1 scope on measured evidence:** moving memory extraction
on-device (§2, spike 5). Extraction stays server-side. This is a scope
reduction, not a gate.

**Still needing an executable spike before §2's on-device path can be
finalised** (Phase 3, not Phase 1): the real context window on a real iPhone,
whether `contextSize` is a total or input-only budget, and whether the
on-device model declares `.vision`. None of these blocks Phase 1, because
Phase 1 sends every chat turn to the Worker.

**Open, not blocking, and not to be invented:** whether PCC requires an
entitlement or provisioning-profile capability (not expressible in a
`.swiftinterface`); PCC's context window, quota size and cadence, and which
error vocabulary it throws.

### Carried-over items, with an owner each

Two things came out of Phase 0 owned by nobody, each recorded somewhere a
Phase 1 reader would not open. Both are restated here, in the file Phase 1 does
read, with a named owner and a definition of done.

**1. Two orphaned Dynamic Client Registration records on the Access tenant.**
Spike 2 registered two DCR clients and there is no known way to remove them:
the `revocation_endpoint` that discovery advertises revokes *tokens*, not
*registrations*.
*Owner:* the Cloudflare Access tenant operator. **The free ride is gone.** This
item was previously scheduled to ride along with the gate-closing sign-in, at
no extra cost; that sign-in has now happened and this was not done during it, so
it needs its own console session. It also grew by one: the flow has since been
run again, and each `register-client.sh` run leaves another undeletable
record.
*Done when:* §4's per-install-versus-per-user registration question is answered
in writing (per-install registration means these records accumulate forever,
one per reinstall, with no cleanup story), **and** either a deletion path is
found and written into §4, or unbounded accumulation is accepted explicitly
with a stated bound on how bad it gets.
*This gates §4's Logout section*, which today raises the question and answers
nothing. Per-install registration must not ship before it is answered.

**2. Commit `29d1199`'s subject line overclaims, permanently.** It reads
"4,096 is a back-deploy fallback, not the iOS 27 value". The established
finding is weaker: 4,096 is **not established as** the iOS 27 value, which is a
different and weaker claim than asserting the iOS 27 value differs from 4,096.
That commit is in shared history and is not being rewritten to fix a message,
so the subject stays wrong forever; the correction currently exists only inside
`API-NOTES.md`'s spike 3 entry, reachable from nothing a reader of this spec
would open.
*Owner:* anyone citing the context-window finding during Phase 1 — which, per
§2's budget-enforcement section, is anyone touching the budget code.
*Done when:* the claim is cited from `API-NOTES.md` rather than from the commit
log. **Where the two disagree, `API-NOTES.md` is authoritative over the commit
log.** This project's git history is not a source for what Phase 0 established.

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

- **On-device context is a runtime-discovered window, not a fixed 4,096.**
  *Corrected in Phase 0 (spike 3); this spec previously asserted "4,096 tokens,
  fixed" and built three separate decisions on it.* The literal `4096` occurs
  exactly once in the whole shipped `FoundationModels` framework, inside a
  `@backDeployed(before: iOS 26.4)` fallback body — a path that runs only on OS
  versions below 26.4 and therefore cannot execute on the iOS 27 SDK's own
  declarations. On iOS 27 `contextSize` is read from the model instance at run
  time. **What Phase 0 does *not* claim: that the real number differs from
  4,096.** One runtime read on the build host (macOS 27.0, Apple Silicon Mac
  mini, spike 5) returned 4,096; that is one host, and the iPhone value is
  unmeasured. `bin/remote-swift` only type-checks, so no Phase 0 spike could
  measure it on a phone.

  The consequence for this design is that the window is an *input*, not a
  constant: everything downstream (the two prompt builders, history trimming,
  and "KB-grounded turns stay on the server") is stated below as a policy that
  holds for any window at or above a floor the app discovers, rather than as
  arithmetic against 4,096.
- **Vectorize is server-only.** KB retrieval and memory retrieval cannot move
  on-device. On-device turns are ungrounded turns.
- **`PUT /api/threads/:id` is whole-thread replace, last-writer-wins.** Any
  local-first sync must add a conflict check; it cannot merge per message.
- **Availability must gate every local path, and `availability` is an *instance*
  member.** *Corrected in Phase 0 (spike 3); this spec previously wrote it as a
  static.* The gate is `SystemLanguageModel.default.availability`;
  `SystemLanguageModel.availability` does not compile ("instance member
  'availability' cannot be used on type 'SystemLanguageModel'", pinned by
  control probe `probe003_control_b.swift`). `UnavailableReason` is **not
  frozen**, so a `switch` needs `@unknown default` — a warning today, an error
  under the Swift 6 language mode a real app target would use. §2 states below
  what an unrecognised reason does.

  What Phase 0 did *not* establish: which hardware answers `.available`. No
  spike enumerated devices. The build host answered `.available` (spike 5), and
  that is the only device datum in evidence.
- **The Foundation Models surface this design uses is annotated iOS 27.0 /
  macOS 27.0.** `Attachment<ImageAttachmentContent>` and every
  `PrivateCloudCompute*` declaration read `@available(iOS 27.0, macOS 27.0,
  visionOS 27.0, watchOS 27.0, *)` with `@available(tvOS, unavailable)` — that
  is Apple's own `.swiftinterface` text, quoted in `API-NOTES.md`. This spec's
  architecture block still says iOS/macOS 26+ because `SpeechAnalyzer` and the
  base session API are on 26 and **no spike tested the 26 surface**; Phase 0
  probes targeted `arm64-apple-ios27.0` only. Whether the product's deployment
  floor should move to 27 is an open decision, not a Phase 0 finding — but the
  vision path and the PCC tier are unavailable below 27 either way.
- **Private Cloud Compute is a first-class engine, and it is Apple's model.**
  *Corrected in Phase 0 (spike 6); this spec previously deferred PCC to a
  speculative Phase 4 on the strength of a report calling it "severely limited
  for third-party developers".* That report is **falsified as a statement about
  API access**: `PrivateCloudComputeLanguageModel` is a `final public class`
  with a public no-argument `convenience init()`, conforms to `LanguageModel`,
  and backs the same generic `LanguageModelSession` as every other engine — no
  `@_spi`, no restricted availability, no entitlement expressed anywhere in the
  SDK. It is **not falsified as a statement about runtime access**, which is a
  different claim this spike could not reach; in particular a `.swiftinterface`
  cannot express an entitlement requirement at all, so "no app gate is
  expressible in the SDK surface" is not the same as "no app gate exists".
  The initializer takes no arguments and no model parameter, so at the API level
  PCC remains Apple's model, not a hosting option for someone else's. See
  Phase 4.

## Architecture

```
  SwiftUI app (iOS 26+ / macOS 26+, shared core)
    │
    ├── LanguageModelSession
    │     ├── SystemLanguageModel        on-device, runtime-sized window,
    │     │                              offline, free
    │     ├── WorkerLanguageModel        /api/chat — grounded, search, images
    │     └── PrivateCloudComputeLanguageModel
    │                                    iOS 27+; gated on a device spike,
    │                                    not on further SDK reading
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
    └── Access Managed OAuth (PKCE,      Authorization: Bearer <access token>
          public client, RFC 8707        (`oauth:`-prefixed, expires_in 900,
          `resource` param required)      refresh token issued; §4)

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

**Build this against a mock transport; prove it against the real Worker.** The
mock is the development substrate — offline work, unit tests and CI cannot
reach an Access-protected route. But since 2026-09-10 the real path *is*
exercisable: a bearer token reaches the origin and `/api/threads` answers with
real Worker JSON. Do not declare the port equivalent on mock evidence alone,
because that is precisely the case where a port bug and a mock-fidelity bug
look the same. The cost of a real run is one 15-minute token and one
interactive sign-in (§4), so batch them rather than skipping them.

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
| Turn contains images, model declares `.vision` | on-device or Worker, by the other rows | see below |
| Turn contains images, model does not declare `.vision` | Worker | — |
| `SystemLanguageModel.default.availability` != `.available` | Worker | — (safe to hide) |
| Otherwise, online | Worker | — |

**Rejected:** routing locally when no KB match. The client cannot know whether
KB matched without a server round-trip — `corpusExcerpts` comes from Vectorize.
Any router guessing at grounding is guessing.

#### The image rows changed, and why — spike 4

The previous single row read *"Turn contains images → Worker, FM vision
unconfirmed; assume text-only"*. **That justification is falsified.** Foundation
Models has a first-class image-prompt path on the iOS 27.0 SDK:
`Attachment<ImageAttachmentContent>` is constructible from a `CGImage`,
`CIImage`, `CVPixelBuffer`, or image `URL` — **all four initializers are
probe-verified** — conforms to `PromptRepresentable`, and composes into a
`Prompt` alongside text with no image-specific call. `.vision` is a real,
declarable `LanguageModelCapabilities.Capability`.

What replaces the row is **not** "images now go on-device". It is a runtime
branch, and it costs the app a path it did not previously need:

- Decide with `SystemLanguageModel.default.capabilities.contains(.vision)` at
  routing time. **This is a runtime value no type-check probe can read** — the
  interface getter has no body and carries neither `@inlinable` nor
  `@backDeployed` — so nothing in Phase 0 says any shipping device answers
  `true`. That measurement is an executable spike, scheduled in Phase 3.
- Catch `LanguageModelError.unsupportedCapability` as the fallback to the
  Worker. The error's shape is probe-verified (payload carries `capability`,
  `debugDescription`, `metadata`); **which call sites actually throw it is
  not** — whether a model lacking `.vision` throws, drops the attachment, or
  traps is an open question spikes 1 and 4 both left open.
- **The app therefore needs both a local image path and the Worker fallback**,
  where before it needed only the latter. Building only the fallback is still a
  valid product choice — but it is now a choice, not a consequence of the API.

If the on-device model turns out not to declare `.vision`, the Worker route is
the only route in practice. That would be the right outcome for a reason this
spec has not yet established, which is why the reason it used to give has been
deleted rather than reworded.

Note also, for §2's privacy story rather than its routing: `tokenCount(for:)`
accepts a multimodal `Prompt`, so the budget check below needs no separate
text-only path — but what it *reports* for an image is unmeasured, and an image
plausibly costs a large, resolution-dependent number of tokens.

### `LanguageModel` conformances — established (spike 1)

The Worker is wrapped as a `LanguageModel` conformance so all engines are driven
through one `LanguageModelSession`. Streaming, prompt assembly, and cancellation
are written once, and adding an engine is a new conformance rather than a
rewrite.

**Verified in Phase 0.** A hand-rolled `WorkerLanguageModel` /
`WorkerExecutor` pair conforming to Apple's `LanguageModel` and
`LanguageModelExecutor` type-checks against the iOS 27.0 SDK and constructs a
shared `LanguageModelSession`, with real streaming on both sides. Two control
probes — each deleting one required member — confirm the conformance check is
genuinely enforced rather than vacuously satisfied. **No plain-Swift-protocol
fallback is needed**, and the fallback clause this section used to carry is
withdrawn along with the `CoreAILanguageModel` claim, which does not exist in
`FoundationModels` at all.

**One consequence that shapes §4.** The framework instantiates the executor, not
the app: `LanguageModel` exposes only `executorConfiguration` as a value, and
`LanguageModelExecutor`'s sole initializer is
`init(configuration: Configuration) throws` where
`Configuration: Hashable, Sendable`. So every piece of backend wiring must
either be a `Hashable & Sendable` value baked in up front (the endpoint URL —
probe-verified to survive the protocol boundary and still be readable inside
`respond`), or fetched from inside `respond` at call time. **A rotating bearer
token is the second kind**: it cannot be baked into `Configuration`, and §4's
refresh actor must be reachable from inside `respond`.

**A refresh actor is no longer dead code, and the refresh *protocol* is no
longer unobserved either.** This paragraph previously said refresh-token
issuance was unconfirmed, so an actor written then might have had nothing to
refresh with — settled by spike 2's exchange, which returned a refresh token
(71 characters, carrying the same `oauth:` prefix as the access token)
alongside a 900-second access token. It then said the grant itself was
unexercised, so the actor would have to guess at rotation — settled by Phase
1A task 2 (2026-09-10; `API-NOTES.md` §12), which posted
`grant_type=refresh_token` for the first time. It returned `200`: no
`client_secret`, `expires_in` `900` again, and a **different** `refresh_token`
on every call. There *is* something to serialise, refreshing is the intended
mechanism rather than re-running the authorization leg, and §4's coalescing
refresh actor has a real job with a real, observed contract.

**Build the actor to persist the rotated refresh token atomically, not to
guess at rotation.** That was the open question; it is closed, and the answer
is rotation-on-use, so losing the new token after a successful refresh is the
failure mode to design against, not an edge case to defer. What is *not*
settled is whether the pre-refresh token keeps working for any interval after
rotation — nothing has measured that, and the actor should not assume it
does.

The seam rule from spike 1 stands unchanged and is independent of all of this:
whatever supplies a credential to `respond` must be resolved at call time
rather than captured in `Configuration`. That is a property of the framework,
probe-verified, and it holds whatever the token mechanism turns out to be.

**Open, and not compile-checkable:** whether cancellation propagates from the
session to the executor's `Task`. Needs an executable spike; not a Phase 0
blocker and not a Phase 1 blocker.

### Two prompt builders

*The premise here changed in Phase 0 and the conclusion is now weaker.* This
section used to justify the split arithmetically — "`buildSystemPrompt` cannot
fit 4,096 alongside history". Since the window is runtime-discovered (see
Constraints), **that arithmetic is no longer available**: the spec cannot assert
that the server prompt does not fit, because it does not know the number.

The split survives on two grounds that do not depend on the window at all, and
those are now the stated reasons:

1. **Correctness, not size.** The server builder teaches the `[n]` citation
   grammar and the evidence block. An on-device turn has no numbered excerpts,
   so a model taught that grammar would emit citations pointing at nothing. This
   is the citation-collision fix and it would be right at any window size.
2. **A separate builder is what makes trimming expressible.** History trimming
   needs a prompt whose fixed part is known and small; parameterizing the server
   builder would leave the fixed part variable.

**Gated on the executable spike:** whether the *server* prompt would in fact
overflow the real on-device window. If the measured window turns out to be large
enough, the size argument for the split disappears — reasons 1 and 2 do not, so
the design does not change, but the spec should stop implying an arithmetic it
has not run.

The local builder is a separate, smaller function — not a parameterization of
the server one:

- **drops** the web-search affordance block, the evidence block, and all `[n]`
  citation rules. An on-device turn has no numbered excerpts and must never be
  taught the `[n]` grammar. This is the citation-collision fix.
- **keeps** persona, a candor rule, and the `Verify:` line. The ungrounded rules
  already written at `persona.ts:74-83` are reused verbatim rather than
  reinvented.
- **trims** memory context to top-N facts rather than all matches.

`buildModeBlock` (answer/tutor) applies to both builders. Mode is orthogonal to
engine.

### Budget enforcement — load-bearing, and `async throws`

Before each on-device turn: count the assembled prompt with
`tokenCount(for:)`, subtract from the model's `contextSize`, reserve headroom
for the reply, then drop oldest history turns until it fits. **If the prompt
alone exceeds budget with zero history, refuse locally and say so.** The user's
own question is never silently truncated.

Phase 0 (spike 3) verified this sequence compiles and runs in that order against
the real SDK — availability check, token counts, arithmetic, refuse-or-construct
— with no generation call anywhere in the path. It also corrected the shape:

- **`tokenCount(for:)` is `async` *and* `throws`, in all five overloads.** The
  budget check therefore **cannot be a synchronous guard**; it is an
  `async throws` call on the routing path, and the router must have somewhere to
  put the thrown error. Pinned by control probe `probe003_control_c.swift`.
- **`contextSize` is a synchronous, non-throwing *instance* property of the
  model**, not of the session — `LanguageModelSession` has none. Read it off the
  same instance the session is built on. Pinned by `probe003_control_d.swift`.
- **`PrivateCloudComputeLanguageModel.contextSize` is `get async throws`.** So
  any abstraction that budgets across engines must itself be `async throws`,
  even though the on-device property is not.

**This check is the only reliable overflow detector, which promotes it from a
refinement to a requirement.** Spike 5 sent an 18,615-token prompt to the
on-device model and got `refusal`, **not** `contextSizeExceeded`. A client
therefore cannot detect overflow by catching the error; if the pre-generation
count is skipped, an over-long turn is indistinguishable from a guardrail
refusal. The previous wording treated this check as a nicety.

**Assumption the arithmetic rests on, established by nothing.**
`contextSize - prompt - reserve` assumes `contextSize` is the **total** window
covering input and output, not an input-only budget. Nothing in the SDK settles
it. The whole refusal calculation depends on it, so the executable spike that
measures the window must answer this at the same time.

**Unrecognised availability reasons.** `UnavailableReason` is not frozen. The
defined behaviour for a reason this app does not recognise is **fall back to the
Worker and label the engine**, not surface a first-class error — an unknown
reason means "local is not usable", which is exactly the Worker's condition.

### Foundation Model jobs that run on every route

**Titles — still proposed, unmeasured.** Replacing `POST /api/title` and its
hardcoded `MiniMax-M2.7` with an on-device generation. **No Phase 0 spike tested
title generation.** Spike 5 measured memory extraction only, and its result does
not transfer: a title is one short generation over a truncated thread, not a
structured extraction over a whole exchange. This stays in Phase 1 as a
proposal, and the first thing Phase 1 should do with it is measure it the way
spike 5 measured extraction.

**Memory extraction — measured NO-GO. It stays on the server.** This is the
largest single change Phase 0 made to this spec.

- **Measured worse on the axis that matters.** Same 32 real exchanges, three
  runs each: on-device extracted a mean of **23.0 facts per run against the
  current extractor's 40.7** (57%), and had **4 hard failures per run against
  0** — 3 `refusal`, 1 `contextSizeExceeded` — the *same four exchanges every
  run*, including the two richest in the sample. Two exchanges the current
  extractor always mined, on-device never did; the reverse set is empty. It is
  not "roughly similar"; it is deterministically worse.
- **The defect that motivated the move did not occur.** This section previously
  argued that `parseFactsJson` "returns empty on parse failure and degrades
  silently", and that guided generation would be strictly better. Across **all
  96 baseline calls** every outcome was `ok` or `empty-array` — never a parse
  failure, never a non-array, never an HTTP error. **The silent-empty failure
  mode never fired.** The move was commissioned to fix a defect that measurement
  says does not happen, and that reasoning is withdrawn rather than reworded.
- **Two quality regressions a count hides.** On-device output drifts to
  schema-shaped strings (`"Location: Auckland"`) where the current extractor
  writes sentences (`"User is located in Auckland"`) — those strings are
  embedded, deduped at `DEDUP_SCORE_THRESHOLD = 0.93`, and injected verbatim
  into every chat turn, so a wholesale change of register is a behavioural
  change downstream, not a cosmetic one. And it produced facts about the wrong
  subject (`"My knowledge cutoff is January 2026."` as a durable fact about the
  *user*).
- **What on-device does win, stated so the tradeoff is visible:** 4.7× faster at
  the median, and free per call. Neither is the axis the decision was made on.
- **Limits of the result, so it is not over-cited.** N = 32 exchanges, 8
  threads, one user, on a Mac mini rather than a phone. That sample can falsify
  "at least as good"; it could not have established it. Only phase 1 of the
  pipeline was measured — embedding, Vectorize dedup and the reconciler are
  untouched by this verdict.
- **What would reopen it**, as scope for a later spike and not as a hedge on
  this one: chunking or map-reduce so a long exchange is never sent whole (the
  two over-window exchanges account for the largest losses); session
  `instructions` or few-shot examples, re-tuning both sides symmetrically or the
  comparison is void; or a hybrid that tries on-device first and falls back to
  the Worker on `refusal`, `contextSizeExceeded`, or an empty result on a long
  exchange. None of these is measured.
- One finding worth carrying beyond extraction: the deterministic `refusal` was
  narrowed to the assistant's own explanation of what a model hallucination is —
  routine content for *this* app. What trips the guardrail is not established,
  and it has no counterpart on the server extractor.

Because extraction stays server-side, `worker/memory.ts` and
`POST /api/memory/ingest` are unchanged, and the native client keeps calling
them. Vectorize remains the retrieval index either way.

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

**No Phase 0 spike touched the audio stack.** Every claim in §3 still rests on
secondary reading, not on a probe against the SDK — which, now that §4 has been
exercised end to end, makes this the least-verified section of the design.
Nothing here has been contradicted and none of it gates anything else, but the
first Phase 1 task in this area should confirm the
`SpeechAnalyzer` / `SpeechTranscriber` / `SpeechDetector` surface the same way
spikes 1 and 3 confirmed `FoundationModels`, before the audio port is written
against it.

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

### Verification state of this section — read first

Spike 2 ran this flow end to end against the real deployment on 2026-09-10,
including the human sign-in the earlier revision of this section was waiting
on. **A token was issued, the origin accepted it, the Worker ran, and
`audit_log` recorded the signed-in user's real SSO address.** This section is
no longer a gate on Phase 1.

The labels below are still not decoration. One central claim is **inferred, not
observed**, and several secondary ones remain **unverified** — issuance settled
them less completely than it looks. Read all three groups rather than the first;
the third is not a leftovers list.

**Established, live-probe-verified — before the sign-in:**

- **Dynamic Client Registration works unauthenticated.** `POST` to the
  registration endpoint returns `201` with **no `client_secret`** and no
  registration access token. The app can register itself; nothing has to be
  provisioned by hand and no client id needs shipping in the binary.
- **The client can be a true public client with no on-device secret.**
  Discovery advertises `"none"` for client authentication — and also a
  `revocation_endpoint`, which the logout step below now uses rather than
  assumes.
- **The client need not hardcode its authorization server.** The `401` from a
  protected route carries a resolvable RFC 9728 `resource_metadata` URL; the
  client reads `authorization_servers` from that document and fetches discovery
  from there. This is a better shape than the one this spec originally
  specified, which baked in the team domain.
- **A loopback redirect is accepted** (RFC 8252), registered with
  `allowed_uris: []`.
- **`DEV_USER_EMAIL` is set on the deployment neither as a secret nor as a
  var** — checked deliberately *before* running the flow, because if it happened
  to equal the sign-in address the identity test at the end would have been
  unfalsifiable.

**Established, live-probe-verified — after the sign-in (2026-09-10):**

- **The token endpoint accepts a public client** presenting `client_id`,
  `code`, `redirect_uri` and `code_verifier` with no secret. `200`.
- **`expires_in` is `900`** — exactly the 15-minute `access_token_lifetime` the
  application is configured for. The number in "Token lifecycle" below is no
  longer an assumption.
- **The `oauth:` prefix is real**, and it is on the refresh token as well as
  the access token. It previously appeared only in the spike brief.
- **A refresh token is issued.** 71 characters. Discovery listing
  `refresh_token` under `grant_types_supported` was a statement about the
  grant; this is the issuance.
- **The origin accepts the token.** `GET /api/threads` with
  `Authorization: Bearer <token>` and no cookie returned `200` with the
  Worker's own JSON body (`{"threads":[]}` — an empty array is a correct
  response for an account with no threads, and the status is what carries the
  finding). An Access edge rejection does not look like this.
- **`audit_log` carries a real identity.** The top `GET /api/threads` `200`
  rows bear the signed-in user's real SSO address.

**Inferred, not observed — the one claim in this section that is derived rather
than seen:** that Access delivers `Cf-Access-Jwt-Assertion` to the origin.
Nothing read the header. The chain is: `200` ⇒ `resolveUserEmail` returned
non-null (`worker/index.ts:59-62` 401s otherwise) ⇒ with `DEV_USER_EMAIL`
absent the fallback branch cannot supply a value ⇒ the value came from
`getUserEmail` (`worker/auth.ts:93-97`), which reads the header at
`worker/auth.ts:94` and returns null without it, after `RS256` /`iss` /`aud`
/expiry verification (`worker/auth.ts:48-91`). `API-NOTES.md` labels this
**mechanism-reasoning** and ranks it below every observed class in that file.
Read the chain and classify the links yourself rather than taking a tally: most
of them are readings of Worker source in another repository, at a commit that
can move, and one — `DEV_USER_EMAIL`'s absence — is a live fact about a
*mutable* deployment configuration rather than a property of the code. None of
them is the header. Cite it as inferred.

Note what the `audit_log` row cannot do: Access delivers the same header for a
cookie-authenticated browser session, and the web app hits the same route, so a
row with a real email shows *some* request carried a verified assertion, not
that this one did. The row supplies the identity value; the `200` carries the
finding.

**Now established (Phase 1A task 2, 2026-09-10; `API-NOTES.md` §12):** the
refresh grant. `grant_type=refresh_token` was posted for the first time and
returned `200` for this public client — no `client_secret`, `expires_in`
`900` again, and a **different** `refresh_token` on every call. See "Token
lifecycle" below for what that means for the actor.

**Still not established:** **revocation** — the endpoint is advertised and
the logout step below uses it, but nothing has been posted to it; **the
`resource` parameter's accepted forms and audience semantics** — see the Flow
section; **scopes** — `scopes_supported` is absent from discovery and the
token response returned `scope: ""`, which establishes only that none was
sent and none demanded; and, narrower than before but still open, **whether
the pre-refresh refresh token is invalidated immediately or survives a grace
window** — confirming either costs a second live refresh call, which the
spike that exercised the grant deliberately did not make.

### Flow

`ASWebAuthenticationSession` → Access **Managed OAuth** (PKCE, public client
registered by DCR, no client secret) → an access token → every request carries
`Authorization: Bearer <token>`.

**The authorize request requires an RFC 8707 `resource` parameter.** *This was
missing from this spec and from the spike brief, and it is not optional.* A
textbook PKCE authorize request — `response_type`, `client_id`, `redirect_uri`,
`state`, `code_challenge`, `code_challenge_method` — never reaches a login page:
it redirects straight back with `error=invalid_target`,
`error_description=No resource parameter found`. Adding
`&resource=https://maxi.mystuff.website` makes the same request reach the login
page.

*Still open, and the sign-in did not close it:* whether the value must be the
origin or may be the fuller resource string the RFC 9728 metadata names
(`…/api/threads`), and whether the issued token is audience-restricted to it.
Only the origin form has ever been sent, and a negative audience test needs a
second protected resource, which this tenant does not have.

**What the token response did add: it echoes a `resource` field, normalised.**
The request sent `https://maxi.mystuff.website`; the response returned
`"https://maxi.mystuff.website/"`. That is evidence the authorization server
canonicalises a resource to an origin form, and it is not a settlement of
either half of the open question above — a hint about normalisation is not a
demonstration that the path-bearing form is rejected. **Concretely, and this is
an implementation rule rather than an open question: the client must not
byte-compare the `resource` it sent against the one it gets back.** The two
differ by a trailing slash on the one path that has actually been run.

**Verified, and the core claim of this section:** that Cloudflare resolves the
token at the edge and lets the Worker see a real user identity, so
`worker/auth.ts` is untouched and the audit log at `worker/index.ts:39` keeps
recording a real email per request. A bearer-token `GET /api/threads` returned
`200` with the Worker's own JSON and produced an `audit_log` row bearing the
signed-in user's real SSO address. **`worker/auth.ts` was not modified.** The
delivery of `Cf-Access-Jwt-Assertion` specifically is *inferred* from that
result rather than observed — see "Verification state" above for the chain, and
cite it as inferred.

One correction to how this was tested, worth keeping: an unauthenticated `401`
from `/api/threads` proves only that **Access enforces at the edge**. It comes
from Access, not from the Worker, which never runs — so it is not evidence
about `worker/auth.ts` at all. What settled it was the `200` from a
token-bearing, cookie-free request: given `DEV_USER_EMAIL` is absent, the
Worker cannot return `200` without having resolved an identity from a verified
Access JWT.

Set `prefersEphemeralWebBrowserSession = true`; a shared Safari cookie can
otherwise sign in the wrong account silently.

### Redirect URI

**Changed by Phase 0.** This spec originally specified an HTTPS relay on the
app's own domain that `302`s to a custom scheme. That is rejected by Cloudflare
*and* circular — the app's domain is the one Access protects. **Use a loopback
redirect (RFC 8252)**, which spike 2 registered successfully. The Managed
Challenge / Bot Fight Mode exemption the relay design needed goes away with the
relay.

### Token lifecycle

**The lifetime is confirmed: `expires_in` is `900`.** Fifteen minutes, exactly
the configured `access_token_lifetime`. This section once stated 5–15 minutes as
though observed, was corrected to "unknown", and is now a real number. "Short,
refresh on the hot path" is the right design and the figure to design against
is 900 seconds — for this deployment's present configuration, which one
dashboard edit changes.

- Keychain, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` — background sync
  works with the device locked; the token never syncs to another device.
- Refresh serialized through an actor with **request coalescing**: ten
  concurrent 401s produce one refresh. **There is a refresh token to
  serialize** — one is issued alongside the access token, 71 characters, with
  the same `oauth:` prefix. **The refresh grant has been exercised (Phase 1A
  task 2, 2026-09-10; `API-NOTES.md` §12).** `grant_type=refresh_token` was
  posted for the first time and returned `200`: no `client_secret` required,
  `expires_in` `900` again, and — the load-bearing fact for this actor —
  **the refresh token rotates on use.** The actor must persist the new
  refresh token atomically with, or before, discarding the old one: losing it
  after a successful refresh leaves no valid refresh token at all, only a
  spent one. Whether the pre-refresh token is invalidated immediately or
  survives a grace window is still unverified — that would cost a second live
  refresh call, which was deliberately not made.
- **Proactive refresh before opening a chat stream.** A long SSE response that
  401s mid-stream cannot be blindly retried, because tokens are already rendered
  and a retry duplicates them. If expiry is under ~60s, refresh first.
- **The token cannot live in the executor's `Configuration`.** Spike 1
  established that the framework constructs `LanguageModelExecutor` itself, from
  a `Hashable & Sendable` `Configuration` fixed at construction time. A rotating
  bearer token is not that. `WorkerExecutor.respond` must reach this refresh
  actor at call time — the same way it would reach the Keychain — rather than
  capturing a token up front. This is a real constraint on how §2's conformance
  is wired, discovered by a probe rather than assumed.

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

Clears the Keychain, revokes the token at the **`revocation_endpoint` the
discovery document advertises** (confirmed present by spike 2; this section
previously assumed a revocation path existed — note that nothing has ever been
*posted* to it, so the endpoint's behaviour is unexercised), hits
`/cdn-cgi/access/logout`,
and offers to wipe the local SwiftData store rather than leaving thread history
on a signed-out device.

**Note for the operator, from spike 2:** the registration endpoint has no known
deletion path — `revocation_endpoint` revokes *tokens*, not *registrations* —
and two DCR client records now exist on the tenant from the spike. If the app
registers per install, orphaned client records accumulate with no cleanup story.
That is not a blocker, but it is not designed either, and this spec does not
claim to have solved it.

### Security: fail closed

`resolveUserEmail` (`worker/auth.ts:100`) falls back to `env.DEV_USER_EMAIL`
whenever Access verification returns null. If `CF_ACCESS_TEAM_DOMAIN` or
`CF_ACCESS_AUD` is unset or misconfigured, every unauthenticated request resolves
to that identity and all 24 routes open.

**Required change, before any build ships:** the Worker must return 401 rather
than fall back when the Access vars are missing. This is not a Phase 2 item.

Spike 2 confirmed `DEV_USER_EMAIL` is currently absent from the deployment —
neither a secret nor a `[vars]` entry — so the fallback has nothing to fall back
*to* today. That is a fact about the deployment's present configuration, not a
property of the code: one dashboard edit reinstates the hazard silently. The
code change is still required.

**That absence now carries a second load.** It is one of the links in the
inference that Access delivers `Cf-Access-Jwt-Assertion` to the origin (see
"Verification state" above): with nothing to fall back to, a `200` cannot have
come from the fallback path. So setting `DEV_USER_EMAIL` on this deployment
would not merely reopen the security hazard — it would retroactively break the
only evidence Phase 0 has for §4's central claim. If it is ever set, the
verification has to be redone against a deployment where it is not.

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
| PCC (Phase 4) | no | **never mentioned** | required | no, by this app's design |

The PCC row says "by this app's design" deliberately. Spike 6 corrected an
assumption this spec used to make: the SDK does **not** close the tool path for
PCC — `LanguageModelSession(model:tools:instructions:)` accepts `[any Tool]` for
a PCC-backed session exactly as for any other engine, and `.toolCalling` is a
declarable capability. Whether a deployed PCC model honours tool calls is a
runtime read, not an API-level prohibition. **"PCC cannot use tools" must not be
recorded as an SDK fact.** What is true is that this app's knowledge base lives
in Vectorize behind the Worker, so a PCC turn is ungrounded for the same reason
an on-device turn is.

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

Repo layout: **two repos.** The Swift client lives in
`Confluenceservice/delphi-apple` (private); the Worker, web app, specs, and plans
stay in `Confluenceservice/delphi-chat` (public).

Drift mitigation, since the contract now spans repos:
- Specs and plans have one home: `delphi-chat/docs/superpowers/`. The Swift repo
  never forks them; its README links to them by path and commit.
- `delphi-apple/API-NOTES.md` records verified Apple API signatures (Phase 0).
- Any change to an `/api/*` request or response shape requires a matching commit
  in both repos, referenced by SHA in the message. There is no schema generator;
  this is a discipline, and the spec says so plainly rather than pretending
  otherwise.

### Phase 0 — verification spikes, no production code — **complete**

| # | Question | Outcome | Where it landed |
|---|---|---|---|
| 1 | `LanguageModel` / `LanguageModelExecutor` shape; can it wrap the Worker? | **yes**, probe-verified. `CoreAILanguageModel` does not exist — withdrawn | §2 conformances |
| 2 | Managed OAuth end to end | **yes** — token issued, origin accepted it, `audit_log` identity real; assertion-header delivery inferred, not observed | §4; no longer a gate |
| 3 | `contextSize` / `tokenCount(for:)` | **yes**, and the window is runtime-discovered, not 4,096 | Constraints, §2 budget |
| 4 | FM vision — text-only or multimodal? | **multimodal at the API level**; "assume text-only" falsified | §2 routing, motivation (3) |
| 5 | `@Generable` extraction vs `parseFactsJson` | **NO-GO**, measured; and the motivating defect never fired | §2 FM jobs; cut from Phase 1 |
| 6 | PCC third-party availability and limits | **API-level yes**; runtime access unestablished | Constraints, Phase 4 |

The evidence is in `delphi-apple/API-NOTES.md`, one entry per spike, with
retained control probes and `bin/verify-quotes`. **Phase 0 has no remaining
work**; the sign-in it was waiting on happened on 2026-09-10, and the procedure
for re-running that flow is in that file under spike 2, "How it was run, and how
to re-run it". Re-running it costs another human sign-in — there is no
unattended path to a fresh token, and the refresh grant that might provide one
has not been exercised.

**Executable spikes Phase 0 could not run**, because `bin/remote-swift` only
type-checks and no signed device build existed. These are carried, not dropped:

- Read `contextSize` on a real iPhone, and settle whether it is a total or
  input-only budget (§2 budget enforcement depends on the answer).
- Read `SystemLanguageModel.default.capabilities.contains(.vision)` on a real
  device (§2 image routing depends on the answer).
- The PCC device spike; entry criteria are listed under Phase 4.
- Cancellation propagation from session to executor `Task`.

### Phase 1 — native shell, provably equivalent

Managed OAuth, SwiftData as cache, ported `sync.ts` semantics, native audio
stack, `swift-markdown-ui` rendering, and Foundation Model for **titles only**.
Chat goes to the Worker only.

**Changed by Phase 0:** memory extraction is **out of Phase 1 scope** and stays
on the server. Spike 5 measured the on-device version as materially worse, and
found that the silent-parse-failure defect it was meant to fix does not occur.
Titles remain in scope but are **unmeasured** — no spike tested them — so Phase 1
should measure titles before shipping them, not after.

**Gated on:** nothing. The Access sign-in that gated the auth portion happened
on 2026-09-10 and §4's central claim holds — `worker/auth.ts` needs no changes.
The audio stack, sync, rendering and the conformance architecture were never
gated and remain unblocked.

**One cost to plan for, not a gate.** Exercising anything auth-bearing against
the real Worker consumes a 15-minute token, and a fresh token needs an
interactive human sign-in (the refresh grant is issued but unexercised — §2).
Routine development and CI still run against a mock; batch the end-to-end runs.

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

**Starts with the two executable spikes Phase 0 could not run** — the real
context window (and whether it is total or input-only), and whether the on-device
model declares `.vision`. Both are cheap once a device build exists, and both
change what this phase builds: the first sets the trimming policy, the second
decides whether a local image path is worth writing.

**Done when:** airplane mode produces a useful, clearly-labeled, uncited answer,
and never silently truncates the user's question.

### Phase 4 — Private Cloud Compute — promoted out of speculation

*Rewritten after spike 6.* This phase was conditional on "spike 6 confirming PCC
is usable by third-party apps", and it now reads as a real tier sequenced behind
a device spike rather than a speculative one behind further SDK reading. The
"severely limited for third-party developers" report is **falsified as a
statement about API access** and **not** as a statement about runtime access —
which is the distinction that decides how this phase is gated.

Mechanically it is what this spec promised: a new conformance and one new rung
on the ladder. `PrivateCloudComputeLanguageModel` conforms to `LanguageModel`,
takes a no-argument `init()`, and backs the same `LanguageModelSession`. Its
executor is a concrete public struct with the same
`Configuration: Hashable & Sendable` shape spike 1's Worker executor had to
supply. That is the payoff for the conformance architecture, and it is now
probe-verified rather than assumed.

**Two claims this section used to make are withdrawn as unfounded:**

- **"~32,000-token tier."** No such constant exists anywhere in the SDK.
  `contextSize` on PCC is declared `Int` and is `get async throws` — a runtime
  read on a real device, and nobody has made one. The number is unknown.
- **"private and free."** The SDK models a `QuotaUsage` with a status
  (`.belowLimit` / `.limitReached`), an "approaching the limit" flag, an
  optional reset `Date`, and a `LimitIncreaseSuggestion` whose only member is
  `show()`. That shape is more consistent with a metered free tier than with a
  developer allow-list — but **that is an argument from API shape, not a
  statement about Apple's terms.** No cadence and no number is verified;
  "a daily cap under the App Store Small Business Program" is *not* verified by
  anything here, and the SDK is not a place where it could be.

**Entry criteria — a device spike, not more reading.** Nothing further is
learnable from the SDK surface. The spike must return: (a) `isAvailable` on a
real device with a signed build; (b) one successful `respond(to:)`; (c) the
value of `try await model.contextSize`; (d) an observed `quotaUsage`, including
whether `resetDate` reveals a cadence; (e) whether a provisioning-profile
capability had to be enabled to sign the build. **Until (a), (b) and (e) come
back, the client must treat PCC as a tier that may be permanently unavailable at
runtime and must degrade to the Worker.** A `.swiftinterface` cannot express an
entitlement requirement at all, so the absence of one in the SDK is not evidence
that none is required.

**Error handling gains a second vocabulary.** `PrivateCloudComputeLanguageModel.Error`
is a distinct type from `LanguageModelError`, with `networkFailure`,
`quotaLimitReached` and `serviceUnavailable`; `quotaLimitReached` carries its own
`resetDate` and `limitIncreaseSuggestion`, so the recovery affordance is
reachable from the thrown error rather than only from polling. **Which of the two
types a PCC-backed `respond(to:)` actually throws is not visible from the SDK** —
every overload declares plain untyped `async throws` — so the engine layer must
catch both. `.quotaLimitReached` is the tier-demotion signal.

**Also established:** PCC conforms to `Observation.Observable`, so a SwiftUI view
can track `availability` and `quotaUsage` without polling; and every PCC
declaration is `@available(tvOS, unavailable)`, recorded so a later
platform-expansion decision does not have to re-derive it.

Where PCC sits on the ladder is unchanged in kind: it has no access to this app's
Vectorize KB (see §5), so it does not replace the Worker — it fills the gap
between the on-device window and paid grounded inference. What that gap *is*
cannot be stated until (c) comes back.

## Testing

The conformance protocol is the leverage: a mock `LanguageModel` makes the whole
chat pipeline testable with no network and no model.

- Mock conformance for routing, budget enforcement, and prompt-builder selection.
  Budget enforcement is `async throws` (§2), so the mock and its tests are too.
- Recorded-SSE fixture replay for all three payload shapes
- A `<think>` test with tags deliberately split across chunk boundaries
- Sync conflict tests: 409 handling, tombstone replay after termination
- A test that a turn exceeding the discovered window is **refused**, not
  truncated and not left to the error case — spike 5 showed an over-window prompt
  returns `refusal`, not `contextSizeExceeded`, so only the pre-generation check
  catches it
- The spike-5 comparison harness (`delphi-apple/spikes/`, 32 real exchanges) is
  the template for measuring titles in Phase 1, and for re-testing extraction if
  anyone reopens it
- **At least one end-to-end sync pass against the real Worker**, not only the
  mock — a real Access token to `/api/threads`, whole-thread `PUT` and `GET`,
  compared against the web app's behaviour. This became possible on 2026-09-10
  and it is what turns §1's "provably equivalent" from an aspiration into a
  test. It costs an interactive sign-in per 15-minute token, so it is a batched
  manual pass, not a CI job.

## Risks

- **§4's assertion-header claim is inferred, not observed.** No longer a gate —
  the flow ran end to end on 2026-09-10 and the origin accepted the token — but
  nothing ever read `Cf-Access-Jwt-Assertion`. The claim rests on a chain (§4,
  "Verification state") built from readings of Worker source at a commit that
  can move, plus one *mutable* deployment configuration (`DEV_USER_EMAIL`'s
  absence). The residual risk is that a change to any link
  invalidates the conclusion silently. Reading the header directly, once a
  device build can log it, would retire this risk cheaply.
- **The refresh grant rotates on use, and losing the rotated token is the
  failure mode to design against.** Exercised in the first Phase 1 auth task
  (2026-09-10, `API-NOTES.md` §12): `grant_type=refresh_token` returned `200`
  for this public client, with a **different** `refresh_token` on every call.
  §4's refresh actor must persist the rotated token atomically; a crash
  between a successful refresh and saving its result strands the client with
  a spent refresh token and no fallback but an interactive sign-in. Whether
  the pre-refresh token is invalidated immediately or survives a grace window
  is still unverified — testing that costs a second live call, which this
  spike deliberately did not make.
- **Runtime facts the SDK cannot supply.** The context window, whether it is a
  total or input-only budget, whether the on-device model declares `.vision`,
  whether PCC works at all on a device, and whether PCC needs an entitlement —
  none of these is readable from a `.swiftinterface`, and each has a design
  decision resting on it. Type-check verification has been taken as far as it
  goes; everything remaining needs a device.
- **Sync inversion with live data** (Phase 2) — the only step that can lose a
  user's turns.
- **`DEV_USER_EMAIL` fallback** — must fail closed before any build ships.
  Currently absent from the deployment, which is a configuration fact, not a
  code fix.
- **A guardrail that refuses ordinary content for this app.** Spike 5 found a
  deterministic on-device `refusal` on the assistant's own explanation of model
  hallucination — routine subject matter here. The cause is not established. Any
  on-device path (Phase 3) must assume some fraction of ordinary turns will be
  refused for reasons the client cannot anticipate, and must degrade visibly.
- **Scope.** Four phases, two platforms, a new auth flow, a full UI port. Phase 1
  alone is substantial. Nothing here should be read as a short project.

## Out of scope

watchOS (no `SpeechAnalyzer`), widgets, Shortcuts / App Intents, push
notifications, multi-user sharing, per-message CRDT sync, KB moderation in
native, and the parked de-MiniMax provider work
(`2026-08-29-provider-seam-design.md`, still Proposed).
