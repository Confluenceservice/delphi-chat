# Phase 1A — Client Spine (data, transport, sync) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the headless Swift core of the native client — wire models,
SwiftData cache, HTTP + SSE transport, and a port of `src/state/sync.ts` — and
prove it against the real Worker rather than only against a mock.

**Architecture:** One SwiftPM library, `DelphiKit`, containing every piece of
logic that does not need a screen or a device. It is tested with `swift test`
running on the macOS 27 build host over SSH — no simulator, no signing, no
Xcode project. Platform services (Keychain, web auth, reachability) are reached
through protocols so the tested module stays free of platform-conditional
imports and keeps cross-compiling for iOS. App targets, UI, audio and titles are
*not* in this plan; see the decomposition index below.

**Tech Stack:** Swift 6.4 (Swift 6 language mode), SwiftPM, `Testing`
(swift-testing), SwiftData, `URLSession`, `Network.NWPathMonitor`.

**Spec:** `docs/superpowers/specs/2026-09-09-swift-native-client-design.md`

---

## Phase 1 decomposition — read this before assuming scope

Phase 1 in the spec ("native shell, provably equivalent") covers Managed OAuth,
SwiftData, ported sync, the native audio stack, `swift-markdown-ui` rendering,
and Foundation Model titles, across two platforms. That is several independent
subsystems, and the spec says so itself: *"Phase 1 alone is substantial."* It is
therefore split into four plans. **This document is 1A only.**

| Plan | Scope | Depends on |
|---|---|---|
| **1A — client spine** (this plan) | SwiftPM package and remote test tooling; wire models; SwiftData cache; HTTP client + connection state; threads API; SSE chat stream; `<think>` stripping; the `sync.ts` port; the refresh-grant exercise; the Worker fail-closed fix; one real end-to-end pass | — |
| **1B — auth in Swift** | DCR per-install-vs-per-user decision (gates Logout); PKCE + `ASWebAuthenticationSession`; Keychain token store; coalescing refresh actor; revocation and logout | 1A tasks 1, 2, 6 |
| **1C — audio** | `SpeechAnalyzer` / `SpeechTranscriber` / `SpeechDetector` verification spike **first** (§3 is the least-verified section of the spec), then STT, VAD, `AVSpeechSynthesizer` TTS, Aura opt-in, `ConversationMode`, voice reset | 1A task 1 |
| **1D — UI port + titles** | iOS/macOS app targets, thread drawer, message list, composer, `swift-markdown-ui` `AssistantBody` equivalent with `[n]` citations and excerpt panels, connection banner and retry; the remaining thin API clients — `/api/memory` ingest and the settings list/delete/clear (`src/api/memory.ts`), `/api/persona` GET/PUT, `/api/voice` GET/PUT, and the two in-scope KB routes (`POST /api/kb/suggest`, `GET /api/kb/docs`); measure on-device titles against `POST /api/title` the way spike 5 measured extraction | 1A, 1B, 1C |

**Route coverage across the four plans.** Of the 24 routes, 1A touches four
(`GET /api/threads`, `GET|PUT|DELETE /api/threads/:id`) plus `POST /api/chat`
and `POST /api/title`; 1B touches none (Access endpoints are not Worker routes);
1C replaces `/api/stt` and `/api/tts` with on-device equivalents and keeps
`/api/voice`; 1D covers memory, persona, voice and the two KB routes. The five
moderation KB routes stay web-and-admin-only by an explicit scope cut in §5, and
`/api/admin/audit` is not ported. Nothing is unassigned.

Two spec items are deliberately **not** in any 1A task and must not be invented
into one:

- **The `LanguageModel` / `LanguageModelExecutor` conformance wrapper.** Spike 1
  verified it and the spec calls it "startable today", but Phase 1 sends every
  chat turn to the Worker, so a plain `URLSession` SSE client is sufficient and
  the wrapper is not needed until Phase 3 adds a second engine. What 1A *does*
  honour now is spike 1's seam rule, so the later wrap is mechanical: a
  credential is resolved **inside** the call, never captured up front.
- **Anything on-device** — no `FoundationModels` import appears in 1A.

---

## Global Constraints

Every task's requirements implicitly include this section. Values are copied
verbatim from the spec and from `delphi-apple/API-NOTES.md`.

- **Deployment floor: iOS 27.0 / macOS 27.0.** The package declares
  `platforms: [.macOS("27.0"), .iOS("27.0")]`.
- **Swift 6 language mode, strict concurrency.** `swift-tools-version: 6.2`
  gives this by default. `UnavailableReason`-style non-frozen enums need
  `@unknown default`, which is an error rather than a warning here.
- **Build host:** `mac-mini.local` — macOS 27.0, Xcode 27.0 (build `27A5228h`),
  Swift 6.4. **The local machine has Command Line Tools only and cannot compile
  against the iOS SDK.** Every build and every test runs there over SSH.
  Override with `REMOTE_SWIFT_HOST`.
- **Two repos.** Swift code lands in `Confluenceservice/delphi-apple` (private,
  cloned at `/Users/thomasb/delphi-apple`). Specs and plans stay in
  `Confluenceservice/delphi-chat`. **Any change to an `/api/*` request or
  response shape requires a matching commit in both repos, cross-referenced by
  SHA in the message.** There is no schema generator.
- **`API-NOTES.md` is authoritative over the commit log.** Where a commit
  subject and `API-NOTES.md` disagree about what Phase 0 established, the file
  wins. Commit `29d1199`'s subject is known to overclaim and is not being
  rewritten.
- **Never commit a token, client id, client secret, or any `oauth:` value.**
  `.env.local*` and `.oauth-*` are gitignored, including the `.tmp` siblings the
  OAuth scripts write through.
- **`expires_in` is `900`** — fifteen minutes, exactly the configured
  `access_token_lifetime`, *for this deployment's present configuration*.
- **Proactive refresh before opening a chat stream:** if expiry is under ~60s,
  refresh first. A long SSE response that 401s mid-stream cannot be blindly
  retried, because tokens are already rendered and a retry duplicates them.
- **Keychain accessibility is `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`**
  (1B implements it; 1A only defines the protocol it sits behind).
- **`prefersEphemeralWebBrowserSession = true`** on `ASWebAuthenticationSession`
  (1B) — a shared Safari cookie can otherwise sign in the wrong account
  silently.
- **Never byte-compare the `resource` value sent against the one echoed back.**
  The request sent `https://maxi.mystuff.website`; the token response returned
  `"https://maxi.mystuff.website/"`. They differ by a trailing slash on the only
  path that has ever been run.
- **Sync constants are user-visible and are pinned by tests, not comments:**
  debounce `2000ms`, post-flush retry `30_000ms`.
- **Phase 1 sync is whole-thread `PUT`, last-writer-wins.**
  `If-Unmodified-Since`, `409`, conflict forks and tombstone tables are
  **Phase 2** and must not appear in 1A. The `PUT` response body
  (`{ok: true, updatedAt}`) is ignored in Phase 1, exactly as the web client
  ignores it.
- **The credential seam rule (spike 1):** whatever supplies a bearer token to a
  request must be resolved at call time, never captured at construction time.
- **`/api/stt` and `/api/tts` must never be called by the native client.** No 1A
  code path may reach them.

---

## File Structure

All paths are relative to `/Users/thomasb/delphi-apple` unless the task says
otherwise. Files that change together live together; the split is by
responsibility, not by layer.

| File | Responsibility |
|---|---|
| `Package.swift` | One library target `DelphiKit`, one test target |
| `bin/_remote-sync.sh` | Shared rsync-to-build-host helper, sourced by the two scripts below |
| `bin/remote-test` | `swift test` on the build host — the TDD cycle |
| `bin/remote-build-ios` | Cross-compiles the package for `arm64-apple-ios27.0` — the "stays iOS-clean" gate |
| `Sources/DelphiKit/Model/WireTypes.swift` | `Thread`, `Message`, `Source`, `CorpusSource`, `Role`, `ChatMode` — the exact JSON contract |
| `Sources/DelphiKit/Model/StoreModels.swift` | `@Model ThreadRecord`, `@Model MessageRecord` — the SwiftData cache |
| `Sources/DelphiKit/Model/StoreMapping.swift` | `ThreadRecord` ⇄ `Thread` conversion, `seq` ordering |
| `Sources/DelphiKit/Model/ThreadStore.swift` | Cache operations: load all, upsert, delete, active-thread id |
| `Sources/DelphiKit/Net/HTTPTransport.swift` | `HTTPTransport` protocol + `URLSessionTransport` + `MockTransport` |
| `Sources/DelphiKit/Net/TokenProviding.swift` | `TokenProviding` protocol — the call-time credential seam |
| `Sources/DelphiKit/Net/ConnectionStore.swift` | Port of `src/state/connectionStore.ts` |
| `Sources/DelphiKit/Net/APIClient.swift` | Port of `src/api/http.ts`: bearer injection + connection-state side effects |
| `Sources/DelphiKit/Net/ThreadsAPI.swift` | Port of `src/api/threads.ts` |
| `Sources/DelphiKit/Net/SSELineParser.swift` | Chunk → line buffering, split-boundary safe |
| `Sources/DelphiKit/Net/ChatStream.swift` | Port of `src/api/chat.ts`: the three payload shapes |
| `Sources/DelphiKit/Text/Thinking.swift` | Port of `src/lib/thinking.ts` |
| `Sources/DelphiKit/Sync/Reachability.swift` | `ReachabilityProviding` protocol + `NWPathMonitor` implementation |
| `Sources/DelphiKit/Sync/SyncEngine.swift` | Port of `src/state/sync.ts` as an actor |
| `Tests/DelphiKitTests/…` | Mirrors the above, one test file per source file |
| `Sources/LiveE2E/main.swift` | Drives the live Worker through `DelphiKit` (Task 11) |
| `Tests/DelphiKitTests/Fixtures/thread_wire.json` | Real captured `GET /api/threads/:id` body, a SwiftPM resource (Task 11) |
| `Tests/DelphiKitTests/Fixtures/chat_stream.sse` | Real captured `/api/chat` SSE transcript (Task 11) |

**Naming note.** `Thread` collides with `Foundation.Thread`. This was probed on
the build host on 2026-09-10: an unqualified `Thread(id:)` in a test module that
imports both `Foundation` and `DelphiKit` resolves to `DelphiKit.Thread` and
compiles clean — the explicit import shadows the Foundation class. So the tests
in this plan work as written. Any reference to the Foundation class must be
spelled `Foundation.Thread`. Do not rename the wire type; its name is part of
the port's readability against `src/state/types.ts`.

---

### Task 1: SwiftPM package and remote build/test tooling

Every later task's test command comes from here. Nothing in this task is
throwaway except the canary, which Task 5 deletes by name.

**Planning already ran this probe.** On 2026-09-10 a throwaway package with a
`@Model` and an in-memory `ModelContainer` round-trip was built and tested on
`mac-mini.local` via `swift test`, and cross-compiled for
`arm64-apple-ios27.0`. Both passed (test build 6.6s; iOS build 1.0s). So the
expected outcomes below are observed, not hoped for. If they do not reproduce,
stop and re-plan — the whole task breakdown assumes this cycle.

**Files:**
- Create: `Package.swift`
- Create: `bin/_remote-sync.sh`
- Create: `bin/remote-test`
- Create: `bin/remote-build-ios`
- Create: `Sources/DelphiKit/ToolchainCanary.swift`
- Test: `Tests/DelphiKitTests/ToolchainCanaryTests.swift`

**Interfaces:**
- Produces: `bin/remote-test [args…]` — rsyncs the package to the build host and
  runs `swift test`, forwarding any arguments. Exit 0 on pass. **This is the
  test command for every later task.**
- Produces: `bin/remote-build-ios` — cross-compiles `DelphiKit` for
  `arm64-apple-ios27.0`. Exit 0 on success. **Every later task runs this too**,
  because `swift test` runs on macOS and would not catch a macOS-only import.

**On scoping test runs.** Every task below runs the whole suite, which builds in
about seven seconds on the build host. That is deliberate: a per-task filter can
only ever hide a regression another task caused. If you want to scope while
iterating, `bin/remote-test --filter <SourceFileName>` works — swift-testing
test IDs embed the source file, so a file name is a valid filter even though
these tests are free functions — and a filter matching nothing prints
`warning: No matching test cases were run` rather than passing silently. Both
behaviours were probed on the build host on 2026-09-10. Never use a filter for a
task's final gate.

- [ ] **Step 1: Write the failing test**

```bash
mkdir -p /Users/thomasb/delphi-apple/{Sources/DelphiKit,Tests/DelphiKitTests}
cd /Users/thomasb/delphi-apple

cat > Sources/DelphiKit/ToolchainCanary.swift <<'EOF'
import Foundation
import SwiftData

/// CANARY — proves the SwiftData macro, the model container and the remote
/// `swift test` cycle all work. Task 5 deletes this file once the real models
/// exist. It is referenced by nothing else.
@Model
public final class CanaryRecord {
    @Attribute(.unique) public var id: String
    public var value: Int?

    public init(id: String, value: Int? = nil) {
        self.id = id
        self.value = value
    }
}
EOF

cat > Tests/DelphiKitTests/ToolchainCanaryTests.swift <<'EOF'
import Foundation
import SwiftData
import Testing
@testable import DelphiKit

@Test @MainActor func canaryRoundTripsThroughAnInMemoryContainer() throws {
    let container = try ModelContainer(
        for: CanaryRecord.self,
        configurations: ModelConfiguration(isStoredInMemoryOnly: true),
    )
    let context = container.mainContext
    context.insert(CanaryRecord(id: "c1", value: 42))
    try context.save()

    let fetched = try context.fetch(FetchDescriptor<CanaryRecord>())
    #expect(fetched.count == 1)
    #expect(fetched.first?.value == 42)
}
EOF
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd /Users/thomasb/delphi-apple && bin/remote-test`
Expected: FAIL — `bin/remote-test: No such file or directory`. Neither the
script nor `Package.swift` exists yet.

- [ ] **Step 3: Write the minimal implementation**

```bash
cd /Users/thomasb/delphi-apple

cat > Package.swift <<'EOF'
// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "DelphiKit",
    platforms: [.macOS("27.0"), .iOS("27.0")],
    products: [
        .library(name: "DelphiKit", targets: ["DelphiKit"]),
    ],
    targets: [
        .target(name: "DelphiKit"),
        // Task 11 drives the real Worker through this. It must be a real
        // executable target inside Sources/, because anything under spikes/ is
        // excluded from the rsync to the build host and invisible to SwiftPM.
        .executableTarget(name: "live-e2e", dependencies: ["DelphiKit"], path: "Sources/LiveE2E"),
        .testTarget(name: "DelphiKitTests", dependencies: ["DelphiKit"]),
    ],
)
EOF

mkdir -p Sources/LiveE2E
cat > Sources/LiveE2E/main.swift <<'EOF'
// Placeholder until Task 11 fills this in. An executableTarget with no
// main.swift fails to build, and every task after this one runs the build.
print("live-e2e: not implemented until Phase 1A task 11")
EOF

cat > bin/_remote-sync.sh <<'EOF'
#!/usr/bin/env bash
# Shared by bin/remote-test and bin/remote-build-ios.
# Mirrors the package to the build host. The local machine has Command Line
# Tools only and has no iOS SDK, so nothing is ever built locally.
#
# --delete keeps the remote tree honest about deleted files. Excluded paths are
# NOT deleted on the receiver (that would need --delete-excluded), which is why
# the remote .build/ directory survives and rebuilds stay incremental.
HOST="${REMOTE_SWIFT_HOST:-mac-mini.local}"
REMOTE_DIR="/tmp/delphi-apple-pkg"

remote_sync() {
  local root
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  ssh -o BatchMode=yes "$HOST" "mkdir -p $REMOTE_DIR"
  rsync -a --delete \
    --exclude '.git/' \
    --exclude '.build/' \
    --exclude '.env.local*' \
    --exclude '.oauth-*' \
    --exclude '.superpowers/' \
    --exclude 'spikes/' \
    "$root/" "$HOST:$REMOTE_DIR/"
}
EOF

cat > bin/remote-test <<'EOF'
#!/usr/bin/env bash
# Run the DelphiKit test suite on the remote build host (macOS 27).
# Any arguments are forwarded to `swift test`, e.g.
#   bin/remote-test --filter SyncEngineTests
set -euo pipefail
# shellcheck source=_remote-sync.sh
source "$(dirname "$0")/_remote-sync.sh"
remote_sync
ssh -o BatchMode=yes "$HOST" "cd $REMOTE_DIR && swift test $*"
EOF

cat > bin/remote-build-ios <<'EOF'
#!/usr/bin/env bash
# Cross-compile DelphiKit for the iOS 27 SDK on the remote build host.
# `swift test` runs on macOS, so it cannot catch a macOS-only import; this can.
set -euo pipefail
# shellcheck source=_remote-sync.sh
source "$(dirname "$0")/_remote-sync.sh"
remote_sync
ssh -o BatchMode=yes "$HOST" "
  set -euo pipefail
  cd $REMOTE_DIR
  SDK=\$(xcrun --sdk iphoneos --show-sdk-path)
  swift build --triple arm64-apple-ios27.0 -Xswiftc -sdk -Xswiftc \"\$SDK\"
"
echo "OK: DelphiKit builds for arm64-apple-ios27.0"
EOF

chmod +x bin/remote-test bin/remote-build-ios
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `cd /Users/thomasb/delphi-apple && bin/remote-test`
Expected: `✔ Test canaryRoundTripsThroughAnInMemoryContainer() passed` and
`✔ Test run with 1 test in 0 suites passed`.

Run: `cd /Users/thomasb/delphi-apple && bin/remote-build-ios`
Expected: `Build complete!` then `OK: DelphiKit builds for arm64-apple-ios27.0`

- [ ] **Step 5: Commit**

```bash
cd /Users/thomasb/delphi-apple
git add Package.swift bin/_remote-sync.sh bin/remote-test bin/remote-build-ios \
        Sources/DelphiKit/ToolchainCanary.swift Sources/LiveE2E/main.swift \
        Tests/DelphiKitTests/ToolchainCanaryTests.swift
git commit -m "build: DelphiKit package with remote test and iOS build tooling

Phase 1A task 1. The local machine has Command Line Tools only, so the test
cycle is `swift test` on mac-mini.local over SSH. A SwiftData canary proves the
macro and model container work in a non-Xcode build; Task 5 deletes it."
```

---

### Task 2: Exercise the refresh grant

**No Swift.** This is an operational task that must land before 1B designs the
coalescing refresh actor. The spec is explicit: *"Exercise it in the first
Phase 1 auth task, before the actor's behaviour hardens around a guess."*
A refresh token was **issued** on 2026-09-10 and its shape is known;
`grant_type=refresh_token` has **never been posted**. Issuance is not exercise.

Whether it succeeds or fails, the outcome is a finding. A `400` is as
informative as a `200` — it would mean the refresh path costs an interactive
sign-in too, which changes 1B's design and the cost model in the spec.

**Files:**
- Create: `/Users/thomasb/delphi-apple/spikes/oauth/refresh.sh`
- Modify: `/Users/thomasb/delphi-apple/API-NOTES.md` — new subsection under
  "Spike 2", titled `#### 12. The refresh grant, exercised`
- Modify (only if the result changes a claim):
  `docs/superpowers/specs/2026-09-09-swift-native-client-design.md` §4 "Token
  lifecycle" and the "Still not established" list

**Interfaces:**
- Produces: a recorded, dated finding stating whether
  `grant_type=refresh_token` is accepted for this public client, whether the
  refresh token rotates on use, and what `expires_in` comes back. 1B consumes
  it.

- [ ] **Step 1: Write the script**

Follow the redaction discipline the other `spikes/oauth/*.sh` scripts already
use: secrets go to gitignored files, stdout carries shape only.

```bash
cat > /Users/thomasb/delphi-apple/spikes/oauth/refresh.sh <<'EOF'
#!/usr/bin/env bash
# THROWAWAY — Phase 1A task 2. Exercises grant_type=refresh_token, which spike 2
# obtained a token for but never posted.
#
# SECRETS: reads the refresh token from .oauth-token.json (gitignored) and
# writes the new response to .oauth-token-refreshed.json (gitignored by the
# .oauth-* pattern). stdout carries only status, non-credential fields, and
# lengths/prefix-presence for credentials. Never `cat` the raw response.
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/.env.local"
: "${OAUTH_CLIENT_ID:?run register-client.sh first}"

OLD="$ROOT/.oauth-token.json"
NEW="$ROOT/.oauth-token-refreshed.json"
[ -f "$OLD" ] || { echo "no $OLD — run exchange.sh first" >&2; exit 2; }

REFRESH=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["refresh_token"])' "$OLD")

http_code=$(curl -s -o "$NEW" -w '%{http_code}' \
  -X POST "${TEAM_DOMAIN}/cdn-cgi/access/oauth/token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "grant_type=refresh_token" \
  --data-urlencode "refresh_token=${REFRESH}" \
  --data-urlencode "client_id=${OAUTH_CLIENT_ID}")

echo "POST ${TEAM_DOMAIN}/cdn-cgi/access/oauth/token (grant_type=refresh_token) -> HTTP ${http_code}"
if [ "$http_code" != "200" ]; then
  echo "--- error body (no token issued, so nothing to redact) ---"
  cat "$NEW"; echo
  exit 1
fi

python3 - "$OLD" "$NEW" <<'PY'
import json, sys
old = json.load(open(sys.argv[1]))
new = json.load(open(sys.argv[2]))
CRED = {"access_token", "refresh_token", "id_token"}
print("--- refresh response, keys and shapes ---")
for k in sorted(new):
    v = new[k]
    if k in CRED:
        s = str(v)
        pfx = 'prefix "oauth:" present' if s.startswith("oauth:") else 'no "oauth:" prefix'
        print(f"  {k}: [{k} redacted, {len(s)} chars, {pfx}]")
    else:
        print(f"  {k}: {json.dumps(v)}")
print("--- rotation ---")
if "refresh_token" in new:
    rotated = new["refresh_token"] != old.get("refresh_token")
    print(f"  refresh_token returned; rotated on use: {rotated}")
else:
    print("  no refresh_token in response: the original stays valid or nothing was returned")
print("--- end ---")
PY
EOF
chmod +x /Users/thomasb/delphi-apple/spikes/oauth/refresh.sh
```

- [ ] **Step 2: Run it**

```bash
cd /Users/thomasb/delphi-apple && spikes/oauth/refresh.sh
```

Record the exact stdout. Three outcomes, all of them findings:

| Result | What it means for 1B |
|---|---|
| `200` with a new access token, no `refresh_token` in the response | The original refresh token stays valid; the actor stores one long-lived refresh token |
| `200` with a **different** `refresh_token` | Rotation on use: the actor must persist the new one atomically or the next refresh fails |
| non-`200` | The refresh grant is unusable for this public client. **Every** fresh token costs an interactive sign-in; 1B's actor degrades to a sign-in prompt, and the spec's cost model needs updating |

- [ ] **Step 3: Write the finding into `API-NOTES.md`**

Append a `#### 12. The refresh grant, exercised` subsection to the Spike 2
entry. Follow that entry's existing conventions exactly:
- label the evidence class — this is **live-probe-verified** for the behaviour
  and **http-trace-evidence** for any quoted body;
- print the command that produced it above each block;
- mark elisions as `[... N lines elided: what they were ...]`;
- replace secrets with a bracketed placeholder naming the value's shape, never
  a truncated prefix;
- carry the standing "as of 2026-09-10, against this deployment's
  configuration" caveat that every live-probe claim in that file carries.

State plainly whichever of the three outcomes occurred, and delete "the refresh
grant" from Spike 2's "still open" list, since it is no longer open.

- [ ] **Step 4: Update the spec only if a claim changed**

If the grant works, §4's "Still not established" list loses its refresh-grant
clause and the Risks section's *"The refresh grant has never been exercised"*
bullet is rewritten to say what was observed. If it fails, the spec's repeated
"batch the end-to-end runs, each costs a sign-in" cost model becomes permanent
rather than provisional, and §2's *"A refresh actor is no longer dead code"*
paragraph must be corrected.

Do not touch the spec if the result changed nothing.

- [ ] **Step 5: Commit — both repos if the spec moved**

```bash
cd /Users/thomasb/delphi-apple
git add spikes/oauth/refresh.sh API-NOTES.md
git commit -m "spike(2): exercise the refresh grant — issuance was not exercise

Phase 1A task 2. grant_type=refresh_token had never been posted; the finding is
recorded under Spike 2 as live-probe-verified. 1B's refresh actor is designed
against this rather than against an assumption."
```

If the spec changed, commit it in `delphi-chat` too and cross-reference both
SHAs in each message, per the two-repo discipline.

---

### Task 3: Make the Worker fail closed

**No Swift. Different repo. No test framework.** `resolveUserEmail` falls back
to `env.DEV_USER_EMAIL` whenever Access verification returns null, so a missing
or misconfigured `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` opens all 24 routes
to an unauthenticated caller. The spec: *"Required change, before any build
ships… This is not a Phase 2 item."*

`DEV_USER_EMAIL` is currently absent from the deployment, so the hazard is
latent rather than live — but that is a fact about configuration, not about the
code, and one dashboard edit reinstates it silently.

**`delphi-chat` has no test runner.** `package.json` declares `dev`, `build`,
`lint`, `preview` and `deploy`, and there is no vitest or jest configuration
anywhere in the repo. Standing one up for a single function is out of scope, so
this task is gated the way that repo already gates Worker behaviour — `wrangler
dev` plus `curl`, exactly as `docs/superpowers/plans/2026-07-13-durable-conversations-plan.md:94`
does.

**A second reason to do this early, worth stating in the commit message.** After
this change the fallback cannot supply an identity **by construction** rather
than by current configuration. That strengthens §4's assertion-header
inference, one of whose links is today the mutable fact that `DEV_USER_EMAIL`
is unset.

**Files:**
- Modify: `worker/auth.ts:100-103` (`resolveUserEmail`)
- Modify: `worker/types.ts` — add `ALLOW_DEV_USER?: string` to `Env`
- Modify: `README.md:231` (the environment table) and `README.md:249` (the local
  development instructions)

**Interfaces:**
- Produces: `resolveUserEmail(request, env)` returns the Access-verified email;
  otherwise `env.DEV_USER_EMAIL` **only when `env.ALLOW_DEV_USER === "true"`**;
  otherwise `null`. Callers are unchanged — `worker/index.ts:59-62` already 401s
  on `null`.

**Why the opt-in is a separate variable rather than a check that Access is
configured.** Local development runs `wrangler dev`, where Access is *not*
configured and `CF_ACCESS_*` is legitimately absent — that is precisely when the
fallback is wanted. Gating on "Access is configured" would therefore break local
dev entirely. Gating on an explicit `ALLOW_DEV_USER` that only ever appears in
`.dev.vars` keeps local dev working and cannot be true by accident in
production.

- [ ] **Step 1: Write the failing check**

The check is a request that must be refused. With `DEV_USER_EMAIL` set and
`ALLOW_DEV_USER` unset, an unauthenticated call must 401 — today it returns 200,
which is the vulnerability.

```bash
cd /Users/thomasb/delphi-chat
cp .dev.vars .dev.vars.backup 2>/dev/null || true
cat > .dev.vars <<'EOF'
DEV_USER_EMAIL=someone@example.com
EOF
npx wrangler dev --port 8787 &
WRANGLER_PID=$!
sleep 6
curl -s -o /dev/null -w 'unauthenticated GET /api/threads -> %{http_code}\n' \
  http://127.0.0.1:8787/api/threads
```

- [ ] **Step 2: Run it to make sure it fails**

Expected **before** the fix: `unauthenticated GET /api/threads -> 200`.

That 200 *is* the bug: no Access header was sent, no Access variable is
configured, and the Worker served the route anyway as
`someone@example.com`. Leave `wrangler dev` running for Step 4.

- [ ] **Step 3: Write the minimal implementation**

Replace `resolveUserEmail` at `worker/auth.ts:100-103`:

```ts
export async function resolveUserEmail(request: Request, env: Env): Promise<string | null> {
  const verified = await getUserEmail(request, env);
  if (verified) return verified;

  // Fail closed. The dev fallback requires an explicit opt-in that only ever
  // lives in .dev.vars, so a missing or misconfigured CF_ACCESS_* pair returns
  // 401 instead of opening all 24 routes to an unauthenticated caller.
  if (env.ALLOW_DEV_USER !== "true") return null;

  return env.DEV_USER_EMAIL || null;
}
```

Add to `Env` in `worker/types.ts`:

```ts
  /** Local development only. Must never be set on a deployed environment. */
  ALLOW_DEV_USER?: string;
```

- [ ] **Step 4: Run the check and make sure it passes**

```bash
# Same .dev.vars as Step 1 — DEV_USER_EMAIL set, ALLOW_DEV_USER absent.
curl -s -o /dev/null -w 'no opt-in  -> %{http_code}\n' \
  http://127.0.0.1:8787/api/threads

kill $WRANGLER_PID
cat > .dev.vars <<'EOF'
DEV_USER_EMAIL=someone@example.com
ALLOW_DEV_USER=true
EOF
npx wrangler dev --port 8787 &
WRANGLER_PID=$!
sleep 6
curl -s -o /dev/null -w 'with opt-in -> %{http_code}\n' \
  http://127.0.0.1:8787/api/threads
kill $WRANGLER_PID
mv .dev.vars.backup .dev.vars 2>/dev/null || rm -f .dev.vars
```

Expected:
```
no opt-in  -> 401
with opt-in -> 200
```

The first line is the security fix. The second proves local development still
works, which is the whole reason the opt-in is a separate variable.

- [ ] **Step 5: Update the README and commit**

Two places document the old behaviour and would now be wrong. At
`README.md:231` the environment table gains a row, and at `README.md:249` the
local-development instructions gain the second variable:

```
| `ALLOW_DEV_USER` | `.dev.vars` | local only | Must be `"true"` for `DEV_USER_EMAIL` to be honoured. Never set it on a deployed environment — it re-opens every route to unauthenticated callers |
```

and

```
CF Access is not available in `wrangler dev`. Set `DEV_USER_EMAIL=you@example.com`
**and** `ALLOW_DEV_USER=true` in `.dev.vars`. Without the second variable the
Worker fails closed and every `/api/*` route returns 401.
```

```bash
cd /Users/thomasb/delphi-chat
git add worker/auth.ts worker/types.ts README.md
git commit -m "fix(auth): fail closed when Access verification returns null

resolveUserEmail fell back to DEV_USER_EMAIL unconditionally, so an unset or
misconfigured CF_ACCESS_TEAM_DOMAIN or CF_ACCESS_AUD opened all 24 routes to an
unauthenticated caller. The fallback now requires an explicit ALLOW_DEV_USER
opt-in that only ever lives in .dev.vars.

Required by the Swift native client design before any build ships. It also
hardens spec §4's assertion-header inference: the fallback can no longer supply
an identity by construction, where previously that rested on the mutable fact
that DEV_USER_EMAIL happens to be unset on the deployment."
```

---

### Task 4: Wire models

These types are the JSON contract with `worker/thread-routes.ts`. Port fidelity
lives or dies here, and three asymmetries between `src/state/types.ts` and the
wire are easy to get wrong. Each has a test below.

**Asymmetry 1 — `titleEdited` is client-only.** It is declared on `Thread` in
`src/state/types.ts:37` but is absent from `ThreadPayload`
(`worker/thread-routes.ts:29-36`). Never send it; never expect it back.

**Asymmetry 2 — per-message `createdAt` is on the wire but not in the TypeScript
type, and it must still round-trip.** `handleThreadGet` emits
`createdAt: row.created_at` for every message (`worker/thread-routes.ts:83`),
and `handleThreadPut` writes `m.createdAt ?? now`
(`worker/thread-routes.ts:145`). `src/state/types.ts:20-28` does not declare it —
but the JS object returned by `getRemoteThread` is a plain parsed JSON object, so
the property rides along at runtime and is sent straight back on the next `PUT`.
**A strict port that models only the declared fields would silently reset every
message's `createdAt` to `Date.now()` on every single sync.** Model it as
`createdAt: Int?` and round-trip it.

**Asymmetry 3 — absent means absent, never null.** `parseJsonColumn`
(`worker/thread-routes.ts:187-194`) returns `undefined`, and `JSON.stringify`
omits undefined keys — so the wire carries no nulls. Swift's synthesized
`Encodable` uses `encodeIfPresent` for Optionals, which matches; the test below
pins it, because it is load-bearing rather than incidental.

**Files:**
- Create: `Sources/DelphiKit/Model/WireTypes.swift`
- Test: `Tests/DelphiKitTests/WireTypesTests.swift`

**Interfaces:**
- Produces: `public struct Thread: Codable, Hashable, Sendable` with
  `id: String`, `title: String`, `model: String`, `createdAt: Int`,
  `updatedAt: Int?`, `titleEdited: Bool?` (never encoded), `messages: [Message]`
- Produces: `public struct Message: Codable, Hashable, Sendable` with
  `id: String`, `role: Role`, `content: String`, `images: [String]?`,
  `sources: [Source]?`, `createdAt: Int?`, `mode: ChatMode?`, `grounded: Bool?`,
  `corpusSources: [CorpusSource]?`, `kbSuggested: Bool?`
- Produces: `public struct Source`, `public struct CorpusSource`,
  `public enum Role: String`, `public enum ChatMode: String`,
  `public enum CorpusOrigin: String`
- Produces: `public enum Wire` with `static let encoder: JSONEncoder` and
  `static let decoder: JSONDecoder`. Every later task encodes and decodes
  through these, so key order and date handling are decided once.

- [ ] **Step 1: Write the failing test**

```swift
// Tests/DelphiKitTests/WireTypesTests.swift
import Foundation
import Testing
@testable import DelphiKit

/// Byte-shape oracle. Mirrors what `handleThreadGet` emits
/// (`worker/thread-routes.ts:77-97`): optional fields are omitted, never null,
/// and every message carries `createdAt`.
private let sampleThreadJSON = """
{"id":"t1","title":"Hello","model":"MiniMax-M3","createdAt":1757462400000,\
"updatedAt":1757462500000,"messages":[\
{"id":"m0","role":"user","content":"hi","createdAt":1757462400001},\
{"id":"m1","role":"assistant","content":"hello","createdAt":1757462400002,\
"mode":"answer","grounded":true,\
"sources":[{"title":"T","url":"https://example.test"}],\
"corpusSources":[{"docId":"d1","title":"Doc","origin":"seed","chunk":"c","index":0}]}]}
"""

@Test func decodesAThreadFromTheWire() throws {
    let thread = try Wire.decoder.decode(Thread.self, from: Data(sampleThreadJSON.utf8))
    #expect(thread.id == "t1")
    #expect(thread.createdAt == 1_757_462_400_000)
    #expect(thread.messages.count == 2)
    #expect(thread.messages[0].role == .user)
    #expect(thread.messages[0].createdAt == 1_757_462_400_001)
    #expect(thread.messages[1].mode == .answer)
    #expect(thread.messages[1].grounded == true)
    #expect(thread.messages[1].sources?.first?.url == "https://example.test")
    #expect(thread.messages[1].corpusSources?.first?.origin == .seed)
    #expect(thread.messages[1].kbSuggested == nil)
}

@Test func encodingOmitsAbsentKeysRatherThanEmittingNull() throws {
    let thread = Thread(
        id: "t1", title: "Hello", model: "MiniMax-M3",
        createdAt: 1, updatedAt: nil,
        messages: [Message(id: "m0", role: .user, content: "hi")],
    )
    let json = String(decoding: try Wire.encoder.encode(thread), as: UTF8.self)
    #expect(!json.contains("null"))
    #expect(!json.contains("updatedAt"))
    #expect(!json.contains("sources"))
    #expect(!json.contains("kbSuggested"))
}

@Test func titleEditedIsNeverEncodedAndNeverDecoded() throws {
    var thread = Thread(id: "t1", title: "Hello", model: "m", createdAt: 1, messages: [])
    thread.titleEdited = true
    let json = String(decoding: try Wire.encoder.encode(thread), as: UTF8.self)
    #expect(!json.contains("titleEdited"))

    let round = try Wire.decoder.decode(
        Thread.self,
        from: Data(#"{"id":"t1","title":"H","model":"m","createdAt":1,"titleEdited":true,"messages":[]}"#.utf8),
    )
    #expect(round.titleEdited == nil)
}

/// The trap: a port that drops per-message `createdAt` resets every message's
/// timestamp to `Date.now()` on the server on every PUT
/// (`worker/thread-routes.ts:145`, `m.createdAt ?? now`).
@Test func perMessageCreatedAtSurvivesADecodeEncodeRoundTrip() throws {
    let thread = try Wire.decoder.decode(Thread.self, from: Data(sampleThreadJSON.utf8))
    let json = String(decoding: try Wire.encoder.encode(thread), as: UTF8.self)
    #expect(json.contains("1757462400001"))
    #expect(json.contains("1757462400002"))
}
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bin/remote-test`
Expected: FAIL — `cannot find 'Wire' in scope`, `cannot find type 'Thread'`.

- [ ] **Step 3: Write the minimal implementation**

```swift
// Sources/DelphiKit/Model/WireTypes.swift
import Foundation

/// The JSON contract with `worker/thread-routes.ts`. Field names and
/// optionality mirror `delphi-chat/src/state/types.ts`, with two documented
/// departures — see `Message.createdAt` and `Thread.titleEdited`.

public enum Role: String, Codable, Hashable, Sendable {
    case user, assistant, system
}

public enum ChatMode: String, Codable, Hashable, Sendable {
    case answer, tutor
}

public enum CorpusOrigin: String, Codable, Hashable, Sendable {
    case seed, community
}

public struct Source: Codable, Hashable, Sendable {
    public var title: String
    public var url: String

    public init(title: String, url: String) {
        self.title = title
        self.url = url
    }
}

public struct CorpusSource: Codable, Hashable, Sendable {
    public var docId: String
    public var title: String
    public var origin: CorpusOrigin
    public var chunk: String
    public var index: Int

    public init(docId: String, title: String, origin: CorpusOrigin, chunk: String, index: Int) {
        self.docId = docId
        self.title = title
        self.origin = origin
        self.chunk = chunk
        self.index = index
    }
}

public struct Message: Codable, Hashable, Sendable {
    public var id: String
    public var role: Role
    public var content: String
    public var images: [String]?
    public var sources: [Source]?
    /// Not declared in `src/state/types.ts`, but present on the wire in both
    /// directions. The web client preserves it only because its threads are
    /// untyped parsed JSON. Dropping it here would reset every message's
    /// timestamp on every PUT.
    public var createdAt: Int?
    public var mode: ChatMode?
    public var grounded: Bool?
    public var corpusSources: [CorpusSource]?
    public var kbSuggested: Bool?

    public init(
        id: String,
        role: Role,
        content: String,
        images: [String]? = nil,
        sources: [Source]? = nil,
        createdAt: Int? = nil,
        mode: ChatMode? = nil,
        grounded: Bool? = nil,
        corpusSources: [CorpusSource]? = nil,
        kbSuggested: Bool? = nil,
    ) {
        self.id = id
        self.role = role
        self.content = content
        self.images = images
        self.sources = sources
        self.createdAt = createdAt
        self.mode = mode
        self.grounded = grounded
        self.corpusSources = corpusSources
        self.kbSuggested = kbSuggested
    }
}

public struct Thread: Codable, Hashable, Sendable {
    public var id: String
    public var title: String
    public var model: String
    /// Milliseconds since the epoch — `Date.now()` on the web side.
    public var createdAt: Int
    public var updatedAt: Int?
    /// Client-only. Absent from `ThreadPayload`, so it is excluded from
    /// `CodingKeys` and therefore never encoded and never decoded.
    public var titleEdited: Bool?
    public var messages: [Message]

    private enum CodingKeys: String, CodingKey {
        case id, title, model, createdAt, updatedAt, messages
    }

    public init(
        id: String,
        title: String,
        model: String,
        createdAt: Int,
        updatedAt: Int? = nil,
        titleEdited: Bool? = nil,
        messages: [Message],
    ) {
        self.id = id
        self.title = title
        self.model = model
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.titleEdited = titleEdited
        self.messages = messages
    }
}

/// Thread metadata as returned by `GET /api/threads`
/// (`worker/thread-routes.ts:49-56`). `updatedAt` is non-optional there.
public struct ThreadMeta: Codable, Hashable, Sendable {
    public var id: String
    public var title: String
    public var model: String
    public var createdAt: Int
    public var updatedAt: Int
}

/// One encoder and one decoder for the whole package, so wire behaviour is
/// decided in a single place. Defaults are deliberate: no key conversion (the
/// wire is already camelCase) and no date strategy (timestamps are plain
/// integer milliseconds, never `Date`).
public enum Wire {
    public static let encoder = JSONEncoder()
    public static let decoder = JSONDecoder()
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `bin/remote-test`
Expected: PASS, four tests.

Run: `bin/remote-build-ios`
Expected: `OK: DelphiKit builds for arm64-apple-ios27.0`

- [ ] **Step 5: Commit**

```bash
cd /Users/thomasb/delphi-apple
git add Sources/DelphiKit/Model/WireTypes.swift Tests/DelphiKitTests/WireTypesTests.swift
git commit -m "feat(model): wire types matching worker/thread-routes.ts

Phase 1A task 4. Three asymmetries against src/state/types.ts are pinned by
tests: titleEdited is client-only and never encoded, per-message createdAt is on
the wire and must round-trip or the server resets it on every PUT, and absent
optional fields are omitted rather than nulled."
```

---

### Task 5: SwiftData cache

SwiftData is the **cache**, not the source of truth, for all of Phase 1 — D1
stays authoritative and the inversion is Phase 2. This task ports the role
`src/state/storage.ts` plays: hold threads locally so the app opens instantly
and survives being killed.

**Three SwiftData behaviours this design depends on were verified on the build
host on 2026-09-10.** Do not re-derive them from memory:

1. A Codable value-type array (`[Source]?`) persists and round-trips as a plain
   stored attribute. No JSON-string column is needed.
2. `@Relationship(deleteRule: .cascade)` deletes the messages with the thread.
3. `@Attribute(.unique)` **upserts**: inserting a second `ThreadRecord` with an
   existing `id` and saving leaves one row carrying the *newer* values. That is
   exactly the whole-thread-replace semantic this port wants.

**And one that bites:** a SwiftData to-many relationship is a **set, not a
list** — the probe inserted `m1` before `m0` and got them back in `seq` order,
which is coincidence, not a guarantee. **Every read of `messages` must sort by
`seq`.** Message order is user-visible chat order; unordered reads would shuffle
a conversation.

**Files:**
- Create: `Sources/DelphiKit/Model/StoreModels.swift`
- Create: `Sources/DelphiKit/Model/StoreMapping.swift`
- Create: `Sources/DelphiKit/Model/ThreadStore.swift`
- Delete: `Sources/DelphiKit/ToolchainCanary.swift`
- Delete: `Tests/DelphiKitTests/ToolchainCanaryTests.swift`
- Test: `Tests/DelphiKitTests/ThreadStoreTests.swift`

**Interfaces:**
- Produces: `@Model public final class ThreadRecord` and
  `@Model public final class MessageRecord`
- Produces: `public extension ThreadRecord { convenience init(_ thread: Thread); func apply(_ thread: Thread); func toWire() -> Thread }`
- Produces: `@MainActor public final class ThreadStore` with
  `init(container: ModelContainer)`,
  `static func inMemory() throws -> ThreadStore`,
  `func loadAll() throws -> [Thread]`,
  `func thread(id: String) throws -> Thread?`,
  `func upsert(_ thread: Thread) throws`,
  `func delete(id: String) throws`,
  `var activeThreadID: String?` (persisted via `UserDefaults`, mirroring
  `loadActiveThreadId` / `saveActiveThreadId` at `src/state/storage.ts:22-30`)

- [ ] **Step 1: Write the failing test**

```swift
// Tests/DelphiKitTests/ThreadStoreTests.swift
import Foundation
import Testing
@testable import DelphiKit

@MainActor
private func makeStore() throws -> ThreadStore { try ThreadStore.inMemory() }

private func sampleThread(id: String = "t1", title: String = "Hello") -> Thread {
    Thread(
        id: id, title: title, model: "MiniMax-M3",
        createdAt: 1_000, updatedAt: 2_000,
        messages: [
            Message(id: "m0", role: .user, content: "hi", createdAt: 1_001),
            Message(
                id: "m1", role: .assistant, content: "hello", createdAt: 1_002,
                mode: .answer, grounded: true,
                corpusSources: [CorpusSource(docId: "d1", title: "Doc", origin: .seed, chunk: "c", index: 0)],
            ),
        ],
    )
}

@Test @MainActor func upsertThenLoadRoundTripsEveryField() throws {
    let store = try makeStore()
    try store.upsert(sampleThread())

    let loaded = try #require(try store.thread(id: "t1"))
    #expect(loaded == sampleThread())
}

@Test @MainActor func messagesComeBackInSeqOrderNotInsertionOrder() throws {
    let store = try makeStore()
    var thread = sampleThread()
    thread.messages = [
        Message(id: "z", role: .user, content: "first"),
        Message(id: "a", role: .assistant, content: "second"),
        Message(id: "m", role: .user, content: "third"),
    ]
    try store.upsert(thread)

    let loaded = try #require(try store.thread(id: "t1"))
    #expect(loaded.messages.map(\.content) == ["first", "second", "third"])
}

@Test @MainActor func upsertReplacesTheWholeThreadRatherThanMerging() throws {
    let store = try makeStore()
    try store.upsert(sampleThread())

    var shorter = sampleThread(title: "Renamed")
    shorter.messages = [Message(id: "m0", role: .user, content: "hi", createdAt: 1_001)]
    try store.upsert(shorter)

    let loaded = try #require(try store.thread(id: "t1"))
    #expect(loaded.title == "Renamed")
    #expect(loaded.messages.count == 1)
    #expect(try store.loadAll().count == 1)
}

@Test @MainActor func deleteRemovesTheThreadAndItsMessages() throws {
    let store = try makeStore()
    try store.upsert(sampleThread())
    try store.delete(id: "t1")

    #expect(try store.thread(id: "t1") == nil)
    #expect(try store.loadAll().isEmpty)
    #expect(try store.orphanMessageCount() == 0)
}

@Test @MainActor func loadAllIsOrderedByUpdatedAtDescendingLikeTheWorker() throws {
    let store = try makeStore()
    var older = sampleThread(id: "old"); older.updatedAt = 10
    var newer = sampleThread(id: "new"); newer.updatedAt = 99
    try store.upsert(older)
    try store.upsert(newer)

    #expect(try store.loadAll().map(\.id) == ["new", "old"])
}
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bin/remote-test`
Expected: FAIL — `cannot find 'ThreadStore' in scope`.

- [ ] **Step 3: Write the minimal implementation**

```swift
// Sources/DelphiKit/Model/StoreModels.swift
import Foundation
import SwiftData

/// SwiftData is the cache for all of Phase 1; D1 is the source of truth.
/// The inversion is Phase 2 and nothing here anticipates it.
@Model
public final class ThreadRecord {
    @Attribute(.unique) public var id: String
    public var title: String
    public var model: String
    public var createdAt: Int
    public var updatedAt: Int?
    public var titleEdited: Bool

    /// A to-many relationship is a set, not a list. Read it through
    /// `orderedMessages`, never directly.
    @Relationship(deleteRule: .cascade, inverse: \MessageRecord.thread)
    public var messages: [MessageRecord] = []

    public init(
        id: String, title: String, model: String,
        createdAt: Int, updatedAt: Int?, titleEdited: Bool,
    ) {
        self.id = id
        self.title = title
        self.model = model
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.titleEdited = titleEdited
    }

    public var orderedMessages: [MessageRecord] {
        messages.sorted { $0.seq < $1.seq }
    }
}

@Model
public final class MessageRecord {
    public var id: String
    /// Position in the conversation. The wire has no such field — order is
    /// implied by array position on the client and by the `seq` column on the
    /// server (`worker/thread-routes.ts:137`). This carries it across a store
    /// that does not preserve order.
    public var seq: Int
    public var role: String
    public var content: String
    public var images: [String]?
    public var sources: [Source]?
    public var createdAt: Int?
    public var mode: String?
    public var grounded: Bool?
    public var corpusSources: [CorpusSource]?
    public var kbSuggested: Bool?
    public var thread: ThreadRecord?

    public init(
        id: String, seq: Int, role: String, content: String,
        images: [String]?, sources: [Source]?, createdAt: Int?,
        mode: String?, grounded: Bool?, corpusSources: [CorpusSource]?,
        kbSuggested: Bool?,
    ) {
        self.id = id
        self.seq = seq
        self.role = role
        self.content = content
        self.images = images
        self.sources = sources
        self.createdAt = createdAt
        self.mode = mode
        self.grounded = grounded
        self.corpusSources = corpusSources
        self.kbSuggested = kbSuggested
    }
}
```

```swift
// Sources/DelphiKit/Model/StoreMapping.swift
import Foundation
import SwiftData

extension MessageRecord {
    convenience init(_ message: Message, seq: Int) {
        self.init(
            id: message.id,
            seq: seq,
            role: message.role.rawValue,
            content: message.content,
            images: message.images,
            sources: message.sources,
            createdAt: message.createdAt,
            mode: message.mode?.rawValue,
            grounded: message.grounded,
            corpusSources: message.corpusSources,
            kbSuggested: message.kbSuggested,
        )
    }

    /// An unrecognised role falls back to `.assistant` rather than throwing.
    /// The store is a cache: a row it cannot fully interpret is still better
    /// rendered than dropped, and the server copy remains authoritative.
    func toWire() -> Message {
        Message(
            id: id,
            role: Role(rawValue: role) ?? .assistant,
            content: content,
            images: images,
            sources: sources,
            createdAt: createdAt,
            mode: mode.flatMap(ChatMode.init(rawValue:)),
            grounded: grounded,
            corpusSources: corpusSources,
            kbSuggested: kbSuggested,
        )
    }
}

extension ThreadRecord {
    convenience init(_ thread: Thread) {
        self.init(
            id: thread.id, title: thread.title, model: thread.model,
            createdAt: thread.createdAt, updatedAt: thread.updatedAt,
            titleEdited: thread.titleEdited ?? false,
        )
    }

    func toWire() -> Thread {
        Thread(
            id: id, title: title, model: model,
            createdAt: createdAt, updatedAt: updatedAt,
            titleEdited: titleEdited ? true : nil,
            messages: orderedMessages.map { $0.toWire() },
        )
    }
}
```

```swift
// Sources/DelphiKit/Model/ThreadStore.swift
import Foundation
import SwiftData

/// The local cache. Mirrors what `src/state/storage.ts` does for the web
/// client: hold threads so the app opens instantly and survives termination.
@MainActor
public final class ThreadStore {
    private let container: ModelContainer
    private var context: ModelContext { container.mainContext }
    private let defaults: UserDefaults
    private static let activeThreadKey = "delphi:active-thread"

    public init(container: ModelContainer, defaults: UserDefaults = .standard) {
        self.container = container
        self.defaults = defaults
    }

    public static func inMemory() throws -> ThreadStore {
        let container = try ModelContainer(
            for: ThreadRecord.self, MessageRecord.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true),
        )
        let defaults = UserDefaults(suiteName: "delphi.tests.\(UUID().uuidString)") ?? .standard
        return ThreadStore(container: container, defaults: defaults)
    }

    /// Ordered newest-first, matching `GET /api/threads`
    /// (`worker/thread-routes.ts:44`, `ORDER BY updated_at DESC`).
    public func loadAll() throws -> [Thread] {
        let records = try context.fetch(FetchDescriptor<ThreadRecord>())
        return records
            .sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
            .map { $0.toWire() }
    }

    public func thread(id: String) throws -> Thread? {
        try record(id: id)?.toWire()
    }

    /// Whole-thread replace, mirroring `PUT /api/threads/:id`
    /// (`worker/thread-routes.ts:133`), which deletes every message row and
    /// re-inserts. Messages are never merged per id.
    public func upsert(_ thread: Thread) throws {
        if let existing = try record(id: thread.id) {
            for message in existing.messages { context.delete(message) }
            existing.messages = []
            existing.title = thread.title
            existing.model = thread.model
            existing.createdAt = thread.createdAt
            existing.updatedAt = thread.updatedAt
            existing.titleEdited = thread.titleEdited ?? false
            attach(thread.messages, to: existing)
        } else {
            let record = ThreadRecord(thread)
            context.insert(record)
            attach(thread.messages, to: record)
        }
        try context.save()
    }

    public func delete(id: String) throws {
        guard let record = try record(id: id) else { return }
        context.delete(record)
        try context.save()
    }

    public var activeThreadID: String? {
        get { defaults.string(forKey: Self.activeThreadKey) }
        set {
            if let newValue {
                defaults.set(newValue, forKey: Self.activeThreadKey)
            } else {
                defaults.removeObject(forKey: Self.activeThreadKey)
            }
        }
    }

    /// Test hook: proves the cascade rule actually fired.
    public func orphanMessageCount() throws -> Int {
        try context.fetch(FetchDescriptor<MessageRecord>()).count
    }

    private func record(id: String) throws -> ThreadRecord? {
        var descriptor = FetchDescriptor<ThreadRecord>(
            predicate: #Predicate { $0.id == id },
        )
        descriptor.fetchLimit = 1
        return try context.fetch(descriptor).first
    }

    private func attach(_ messages: [Message], to record: ThreadRecord) {
        for (seq, message) in messages.enumerated() {
            let row = MessageRecord(message, seq: seq)
            row.thread = record
            context.insert(row)
        }
    }
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

```bash
rm Sources/DelphiKit/ToolchainCanary.swift Tests/DelphiKitTests/ToolchainCanaryTests.swift
bin/remote-test
bin/remote-build-ios
```
Expected: all `ThreadStoreTests` and `WireTypesTests` pass; the canary is gone.

- [ ] **Step 5: Commit**

```bash
cd /Users/thomasb/delphi-apple
git add -A Sources/DelphiKit Tests/DelphiKitTests
git commit -m "feat(store): SwiftData thread cache with seq-ordered messages

Phase 1A task 5. SwiftData is the cache and D1 stays authoritative for all of
Phase 1. A to-many relationship is a set, so MessageRecord carries an explicit
seq and every read sorts by it; unordered reads would shuffle a conversation.
upsert is whole-thread replace, matching PUT /api/threads/:id.

Removes the task 1 toolchain canary, which has served its purpose."
```

---

### Task 6: HTTP transport, credential seam, connection state

Ports `src/api/http.ts` and `src/state/connectionStore.ts`. Two design rules
come from Phase 0 rather than from the web code:

- **The credential seam (spike 1).** The token is fetched **inside** each
  request through `TokenProviding`, never captured when the client is built.
  Spike 1 established that the Foundation Models framework constructs a
  `LanguageModelExecutor` itself from a `Hashable & Sendable` `Configuration`
  fixed at construction time, and a rotating bearer token cannot live there.
  Honouring the rule now makes the Phase 3 wrap mechanical. It costs nothing.
- **Everything network-facing goes through `HTTPTransport`**, so tests never
  touch the network and `MockTransport` is the substrate for tasks 7, 9 and 10.

**Files:**
- Create: `Sources/DelphiKit/Net/HTTPTransport.swift`
- Create: `Sources/DelphiKit/Net/TokenProviding.swift`
- Create: `Sources/DelphiKit/Net/ConnectionStore.swift`
- Create: `Sources/DelphiKit/Net/APIClient.swift`
- Test: `Tests/DelphiKitTests/APIClientTests.swift`

**Interfaces:**
- Produces: `public protocol HTTPTransport: Sendable` with
  `func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)` and
  `func stream(_ request: URLRequest) async throws -> (AsyncThrowingStream<Data, any Error>, HTTPURLResponse)`
- Produces: `public struct URLSessionTransport: HTTPTransport` and
  `public final class MockTransport: HTTPTransport, @unchecked Sendable` with
  `func enqueue(status: Int, body: Data)`,
  `func enqueueStream(status: Int, chunks: [Data])`,
  `func enqueueFailure(_ error: any Error)`,
  `var recordedRequests: [URLRequest]`
- Produces: `public protocol TokenProviding: Sendable { func currentToken() async throws -> String? }`
  and `public struct StaticTokenProvider: TokenProviding`
- Produces: `@MainActor @Observable public final class ConnectionStore` with
  `var authExpired: Bool`, `var disconnected: Bool`, `func markAuthExpired()`,
  `func markDisconnected()`, `func markConnected()`
- Produces: `public struct APIClient: Sendable` with
  `init(baseURL: URL, transport: any HTTPTransport, tokens: any TokenProviding, connection: ConnectionStore)`,
  `func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)`,
  `func stream(_ request: URLRequest) async throws -> (AsyncThrowingStream<Data, any Error>, HTTPURLResponse)`,
  `func request(_ method: String, _ path: String, body: Data?) -> URLRequest`

- [ ] **Step 1: Write the failing test**

```swift
// Tests/DelphiKitTests/APIClientTests.swift
import Foundation
import Testing
@testable import DelphiKit

@MainActor
private func makeClient(
    transport: MockTransport,
    token: String? = "tok-1",
) -> (APIClient, ConnectionStore) {
    let connection = ConnectionStore()
    let client = APIClient(
        baseURL: URL(string: "https://maxi.mystuff.website")!,
        transport: transport,
        tokens: StaticTokenProvider(token: token),
        connection: connection,
    )
    return (client, connection)
}

@Test @MainActor func attachesTheBearerTokenToEveryRequest() async throws {
    let transport = MockTransport()
    transport.enqueue(status: 200, body: Data("{}".utf8))
    let (client, _) = makeClient(transport: transport)

    _ = try await client.send(client.request("GET", "/api/threads", body: nil))

    let sent = try #require(transport.recordedRequests.first)
    #expect(sent.value(forHTTPHeaderField: "Authorization") == "Bearer tok-1")
}

/// The seam rule from spike 1: the token is read per request, not captured.
@Test @MainActor func readsTheTokenAtCallTimeSoRotationIsPickedUp() async throws {
    let transport = MockTransport()
    transport.enqueue(status: 200, body: Data("{}".utf8))
    transport.enqueue(status: 200, body: Data("{}".utf8))

    let rotating = RotatingTokenProvider(tokens: ["first", "second"])
    let connection = ConnectionStore()
    let client = APIClient(
        baseURL: URL(string: "https://maxi.mystuff.website")!,
        transport: transport,
        tokens: rotating,
        connection: connection,
    )

    _ = try await client.send(client.request("GET", "/api/threads", body: nil))
    _ = try await client.send(client.request("GET", "/api/threads", body: nil))

    #expect(transport.recordedRequests[0].value(forHTTPHeaderField: "Authorization") == "Bearer first")
    #expect(transport.recordedRequests[1].value(forHTTPHeaderField: "Authorization") == "Bearer second")
}

@Test @MainActor func a401MarksAuthExpired() async throws {
    let transport = MockTransport()
    transport.enqueue(status: 401, body: Data())
    let (client, connection) = makeClient(transport: transport)

    _ = try await client.send(client.request("GET", "/api/threads", body: nil))
    #expect(connection.authExpired)
    #expect(!connection.disconnected)
}

@Test @MainActor func a403MarksAuthExpired() async throws {
    let transport = MockTransport()
    transport.enqueue(status: 403, body: Data())
    let (client, connection) = makeClient(transport: transport)

    _ = try await client.send(client.request("GET", "/api/threads", body: nil))
    #expect(connection.authExpired)
}

@Test @MainActor func aSuccessClearsBothFlags() async throws {
    let transport = MockTransport()
    transport.enqueue(status: 200, body: Data("{}".utf8))
    let (client, connection) = makeClient(transport: transport)
    connection.markAuthExpired()
    connection.markDisconnected()

    _ = try await client.send(client.request("GET", "/api/threads", body: nil))
    #expect(!connection.authExpired)
    #expect(!connection.disconnected)
}

/// `src/api/http.ts:8-13` marks disconnected on a thrown request, except on
/// abort, and rethrows either way.
@Test @MainActor func aTransportFailureMarksDisconnectedAndRethrows() async throws {
    let transport = MockTransport()
    transport.enqueueFailure(URLError(.notConnectedToInternet))
    let (client, connection) = makeClient(transport: transport)

    await #expect(throws: URLError.self) {
        _ = try await client.send(client.request("GET", "/api/threads", body: nil))
    }
    #expect(connection.disconnected)
}

@Test @MainActor func aCancellationDoesNotMarkDisconnected() async throws {
    let transport = MockTransport()
    transport.enqueueFailure(CancellationError())
    let (client, connection) = makeClient(transport: transport)

    await #expect(throws: CancellationError.self) {
        _ = try await client.send(client.request("GET", "/api/threads", body: nil))
    }
    #expect(!connection.disconnected)
}

@Test @MainActor func omitsTheAuthorizationHeaderWhenThereIsNoToken() async throws {
    let transport = MockTransport()
    transport.enqueue(status: 200, body: Data("{}".utf8))
    let (client, _) = makeClient(transport: transport, token: nil)

    _ = try await client.send(client.request("GET", "/api/threads", body: nil))
    #expect(transport.recordedRequests[0].value(forHTTPHeaderField: "Authorization") == nil)
}

private struct RotatingTokenProvider: TokenProviding {
    let tokens: [String]
    private let index = Counter()
    func currentToken() async throws -> String? { tokens[index.next()] }
}

private final class Counter: @unchecked Sendable {
    private var value = 0
    private let lock = NSLock()
    func next() -> Int {
        lock.lock(); defer { lock.unlock() }
        defer { value += 1 }
        return value
    }
}
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bin/remote-test`
Expected: FAIL — `cannot find 'APIClient' in scope`.

- [ ] **Step 3: Write the minimal implementation**

```swift
// Sources/DelphiKit/Net/HTTPTransport.swift
import Foundation

/// Every network call in DelphiKit goes through this, so tests never reach the
/// network and the mock is the development substrate the spec asks for.
public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
    func stream(
        _ request: URLRequest,
    ) async throws -> (AsyncThrowingStream<Data, any Error>, HTTPURLResponse)
}

public struct URLSessionTransport: HTTPTransport {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        return (data, http)
    }

    public func stream(
        _ request: URLRequest,
    ) async throws -> (AsyncThrowingStream<Data, any Error>, HTTPURLResponse) {
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        let stream = AsyncThrowingStream<Data, any Error> { continuation in
            let task = Task {
                do {
                    // Yield line by line. The SSE framing is line-oriented and
                    // `SSELineParser` re-splits anyway, so this only has to be
                    // faithful, not chunk-identical to the network.
                    for try await line in bytes.lines {
                        continuation.yield(Data((line + "\n").utf8))
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
        return (stream, http)
    }
}

public final class MockTransport: HTTPTransport, @unchecked Sendable {
    private enum Response {
        case data(status: Int, body: Data)
        case stream(status: Int, chunks: [Data])
        case failure(any Error)
        case blocking(status: Int, body: Data, gate: RequestGate)
    }

    private let lock = NSLock()
    private var queue: [Response] = []
    private var requests: [URLRequest] = []

    public init() {}

    public var recordedRequests: [URLRequest] {
        lock.lock(); defer { lock.unlock() }
        return requests
    }

    public func enqueue(status: Int, body: Data) {
        lock.lock(); defer { lock.unlock() }
        queue.append(.data(status: status, body: body))
    }

    public func enqueueStream(status: Int, chunks: [Data]) {
        lock.lock(); defer { lock.unlock() }
        queue.append(.stream(status: status, chunks: chunks))
    }

    public func enqueueFailure(_ error: any Error) {
        lock.lock(); defer { lock.unlock() }
        queue.append(.failure(error))
    }

    /// Parks the request inside the transport until the gate is released, so a
    /// test can observe what happens while a call is genuinely in flight.
    public func enqueueBlocking(status: Int, body: Data, gate: RequestGate) {
        lock.lock(); defer { lock.unlock() }
        queue.append(.blocking(status: status, body: body, gate: gate))
    }

    private func next(for request: URLRequest) throws -> Response {
        lock.lock(); defer { lock.unlock() }
        requests.append(request)
        guard !queue.isEmpty else {
            throw URLError(.resourceUnavailable)
        }
        return queue.removeFirst()
    }

    private func http(_ request: URLRequest, _ status: Int) -> HTTPURLResponse {
        HTTPURLResponse(
            url: request.url ?? URL(string: "https://invalid.test")!,
            statusCode: status,
            httpVersion: "HTTP/2",
            headerFields: nil,
        )!
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        switch try next(for: request) {
        case let .data(status, body):
            return (body, http(request, status))
        case let .stream(status, chunks):
            return (chunks.reduce(into: Data()) { $0 += $1 }, http(request, status))
        case let .failure(error):
            throw error
        case let .blocking(status, body, gate):
            await gate.requestArrived()
            await gate.waitForRelease()
            return (body, http(request, status))
        }
    }

    public func stream(
        _ request: URLRequest,
    ) async throws -> (AsyncThrowingStream<Data, any Error>, HTTPURLResponse) {
        switch try next(for: request) {
        case let .stream(status, chunks):
            let stream = AsyncThrowingStream<Data, any Error> { continuation in
                for chunk in chunks { continuation.yield(chunk) }
                continuation.finish()
            }
            return (stream, http(request, status))
        case let .data(status, body):
            let stream = AsyncThrowingStream<Data, any Error> { continuation in
                continuation.yield(body)
                continuation.finish()
            }
            return (stream, http(request, status))
        case let .failure(error):
            throw error
        case let .blocking(status, body, gate):
            await gate.requestArrived()
            await gate.waitForRelease()
            let stream = AsyncThrowingStream<Data, any Error> { continuation in
                continuation.yield(body)
                continuation.finish()
            }
            return (stream, http(request, status))
        }
    }
}

/// Lets a test park a request inside the transport and release it on demand.
/// Ships in the library rather than the test target because `MockTransport`
/// does, and the two are only useful together.
public actor RequestGate {
    private var arrived: CheckedContinuation<Void, Never>?
    private var released: CheckedContinuation<Void, Never>?
    private var hasArrived = false
    private var isReleased = false

    public init() {}

    func requestArrived() {
        hasArrived = true
        arrived?.resume()
        arrived = nil
    }

    public func waitUntilRequestArrived() async {
        if hasArrived { return }
        await withCheckedContinuation { arrived = $0 }
    }

    func waitForRelease() async {
        if isReleased { return }
        await withCheckedContinuation { released = $0 }
    }

    public func release() {
        isReleased = true
        released?.resume()
        released = nil
    }
}
```

```swift
// Sources/DelphiKit/Net/TokenProviding.swift
import Foundation

/// The credential seam. Spike 1 established that a rotating bearer token
/// cannot be baked into a value fixed at construction time, so it is resolved
/// per call. `nil` means "no credential available"; the request goes out
/// without an `Authorization` header and Access answers 401.
public protocol TokenProviding: Sendable {
    func currentToken() async throws -> String?
}

/// Used by tests and by the Task 11 end-to-end pass, which reads a token
/// obtained through `spikes/oauth/`. Phase 1B replaces it with the Keychain
/// store and the coalescing refresh actor.
public struct StaticTokenProvider: TokenProviding {
    private let token: String?

    public init(token: String?) {
        self.token = token
    }

    public func currentToken() async throws -> String? { token }
}
```

```swift
// Sources/DelphiKit/Net/ConnectionStore.swift
import Foundation

/// Port of `src/state/connectionStore.ts`. The web version also holds the last
/// failed request for a retry button; that belongs with the UI and lands in
/// Phase 1D, so it is deliberately absent here.
@MainActor
@Observable
public final class ConnectionStore {
    public private(set) var authExpired = false
    public private(set) var disconnected = false

    public init() {}

    public func markAuthExpired() { authExpired = true }

    public func markDisconnected() { disconnected = true }

    public func markConnected() {
        authExpired = false
        disconnected = false
    }
}
```

```swift
// Sources/DelphiKit/Net/APIClient.swift
import Foundation

/// Port of `src/api/http.ts`. Adds the bearer token the web client never
/// needed — the browser carried an Access cookie instead.
public struct APIClient: Sendable {
    private let baseURL: URL
    private let transport: any HTTPTransport
    private let tokens: any TokenProviding
    private let connection: ConnectionStore

    public init(
        baseURL: URL,
        transport: any HTTPTransport,
        tokens: any TokenProviding,
        connection: ConnectionStore,
    ) {
        self.baseURL = baseURL
        self.transport = transport
        self.tokens = tokens
        self.connection = connection
    }

    /// `path` is expected to be **already percent-encoded** — `ThreadsAPI`
    /// encodes thread ids the way `encodeURIComponent` does. Assigning
    /// `percentEncodedPath` preserves that; `URL.appending(path:)` would
    /// re-encode the `%` and turn `t%201` into `t%25201`.
    public func request(_ method: String, _ path: String, body: Data?) -> URLRequest {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.percentEncodedPath = path
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let authorized = try await authorize(request)
        do {
            let (data, response) = try await transport.send(authorized)
            await note(response.statusCode)
            return (data, response)
        } catch {
            try await noteFailure(error)
            throw error
        }
    }

    public func stream(
        _ request: URLRequest,
    ) async throws -> (AsyncThrowingStream<Data, any Error>, HTTPURLResponse) {
        let authorized = try await authorize(request)
        do {
            let (stream, response) = try await transport.stream(authorized)
            await note(response.statusCode)
            return (stream, response)
        } catch {
            try await noteFailure(error)
            throw error
        }
    }

    /// Resolved per call, never captured — spike 1's seam rule.
    private func authorize(_ request: URLRequest) async throws -> URLRequest {
        var authorized = request
        if let token = try await tokens.currentToken() {
            authorized.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return authorized
    }

    @MainActor
    private func note(_ status: Int) {
        if status == 401 || status == 403 {
            connection.markAuthExpired()
        } else {
            connection.markConnected()
        }
    }

    /// `src/api/http.ts:10` skips the disconnect marker on abort, because a
    /// cancelled request says nothing about connectivity.
    private func noteFailure(_ error: any Error) async throws {
        if error is CancellationError { return }
        if let urlError = error as? URLError, urlError.code == .cancelled { return }
        await MainActor.run { connection.markDisconnected() }
    }
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `bin/remote-test` then `bin/remote-build-ios`
Expected: PASS, eight tests, and a clean iOS build.

- [ ] **Step 5: Commit**

```bash
cd /Users/thomasb/delphi-apple
git add Sources/DelphiKit/Net Tests/DelphiKitTests/APIClientTests.swift
git commit -m "feat(net): HTTP transport, call-time credential seam, connection state

Phase 1A task 6. Ports src/api/http.ts and src/state/connectionStore.ts. The
bearer token is resolved inside each request rather than captured at
construction, per spike 1: the Foundation Models framework builds an executor
from a Configuration fixed up front, and a rotating token cannot live there.
Honouring the rule now makes the Phase 3 LanguageModel wrap mechanical."
```

---

### Task 7: Threads API client

Ports `src/api/threads.ts` — five calls, each with the web client's exact error
behaviour. Two details are easy to lose and are pinned by tests: a `404` on
delete is **success** (`src/api/threads.ts:35`), and `fetchTitle` **swallows
every error and returns nil** (`src/api/threads.ts:40-51`) because a missing
title must never break a send.

**Files:**
- Create: `Sources/DelphiKit/Net/ThreadsAPI.swift`
- Test: `Tests/DelphiKitTests/ThreadsAPITests.swift`

**Interfaces:**
- Produces: `public struct ThreadsAPI: Sendable` with `init(client: APIClient)`,
  `func list() async throws -> [ThreadMeta]`,
  `func get(id: String) async throws -> Thread`,
  `func put(_ thread: Thread) async throws`,
  `func delete(id: String) async throws`,
  `func title(user: String, assistant: String) async -> String?`
- Produces: `public enum APIError: Error, Equatable { case status(Int, operation: String) }`

- [ ] **Step 1: Write the failing test**

```swift
// Tests/DelphiKitTests/ThreadsAPITests.swift
import Foundation
import Testing
@testable import DelphiKit

@MainActor
private func makeAPI(_ transport: MockTransport) -> ThreadsAPI {
    ThreadsAPI(client: APIClient(
        baseURL: URL(string: "https://maxi.mystuff.website")!,
        transport: transport,
        tokens: StaticTokenProvider(token: "tok"),
        connection: ConnectionStore(),
    ))
}

@Test @MainActor func listUnwrapsTheThreadsEnvelope() async throws {
    let transport = MockTransport()
    transport.enqueue(status: 200, body: Data("""
    {"threads":[{"id":"t1","title":"A","model":"m","createdAt":1,"updatedAt":2}]}
    """.utf8))

    let metas = try await makeAPI(transport).list()
    #expect(metas.map(\.id) == ["t1"])
    #expect(transport.recordedRequests[0].url?.path == "/api/threads")
}

@Test @MainActor func listOfAnEmptyAccountReturnsAnEmptyArray() async throws {
    let transport = MockTransport()
    transport.enqueue(status: 200, body: Data(#"{"threads":[]}"#.utf8))
    #expect(try await makeAPI(transport).list().isEmpty)
}

@Test @MainActor func listThrowsOnANonSuccessStatus() async throws {
    let transport = MockTransport()
    transport.enqueue(status: 500, body: Data())
    await #expect(throws: APIError.status(500, operation: "thread list")) {
        _ = try await makeAPI(transport).list()
    }
}

@Test @MainActor func putSendsTheWholeThreadAsJSONToTheIdPath() async throws {
    let transport = MockTransport()
    transport.enqueue(status: 200, body: Data(#"{"ok":true,"updatedAt":9}"#.utf8))
    let thread = Thread(id: "t 1", title: "A", model: "m", createdAt: 1, messages: [])

    try await makeAPI(transport).put(thread)

    let sent = transport.recordedRequests[0]
    #expect(sent.httpMethod == "PUT")
    // The id is percent-encoded, matching encodeURIComponent at
    // src/api/threads.ts:26.
    #expect(sent.url?.absoluteString.hasSuffix("/api/threads/t%201") == true)
    let body = try #require(sent.httpBody)
    let decoded = try Wire.decoder.decode(Thread.self, from: body)
    #expect(decoded == thread)
}

/// `src/api/threads.ts:35` — `!res.ok && res.status !== 404` — a delete of a
/// thread the server already lost is a success, not an error.
@Test @MainActor func deleteTreatsA404AsSuccess() async throws {
    let transport = MockTransport()
    transport.enqueue(status: 404, body: Data())
    try await makeAPI(transport).delete(id: "gone")
}

@Test @MainActor func deleteThrowsOnOtherFailures() async throws {
    let transport = MockTransport()
    transport.enqueue(status: 500, body: Data())
    await #expect(throws: APIError.status(500, operation: "thread delete")) {
        try await makeAPI(transport).delete(id: "t1")
    }
}

@Test @MainActor func titleReturnsNilRatherThanThrowingOnAnyFailure() async throws {
    let transport = MockTransport()
    transport.enqueue(status: 500, body: Data())
    #expect(await makeAPI(transport).title(user: "u", assistant: "a") == nil)

    let broken = MockTransport()
    broken.enqueueFailure(URLError(.timedOut))
    #expect(await makeAPI(broken).title(user: "u", assistant: "a") == nil)

    let nullTitle = MockTransport()
    nullTitle.enqueue(status: 200, body: Data(#"{"title":null}"#.utf8))
    #expect(await makeAPI(nullTitle).title(user: "u", assistant: "a") == nil)
}

@Test @MainActor func titleReturnsTheStringOnSuccess() async throws {
    let transport = MockTransport()
    transport.enqueue(status: 200, body: Data(#"{"title":"A good name"}"#.utf8))
    #expect(await makeAPI(transport).title(user: "u", assistant: "a") == "A good name")
}
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bin/remote-test`
Expected: FAIL — `cannot find 'ThreadsAPI' in scope`.

- [ ] **Step 3: Write the minimal implementation**

```swift
// Sources/DelphiKit/Net/ThreadsAPI.swift
import Foundation

public enum APIError: Error, Equatable {
    case status(Int, operation: String)
}

/// Port of `src/api/threads.ts`.
public struct ThreadsAPI: Sendable {
    private let client: APIClient

    public init(client: APIClient) {
        self.client = client
    }

    public func list() async throws -> [ThreadMeta] {
        let (data, response) = try await client.send(
            client.request("GET", "/api/threads", body: nil),
        )
        guard (200 ..< 300).contains(response.statusCode) else {
            throw APIError.status(response.statusCode, operation: "thread list")
        }
        return try Wire.decoder.decode(ThreadListEnvelope.self, from: data).threads
    }

    public func get(id: String) async throws -> Thread {
        let (data, response) = try await client.send(
            client.request("GET", path(id), body: nil),
        )
        guard (200 ..< 300).contains(response.statusCode) else {
            throw APIError.status(response.statusCode, operation: "thread fetch")
        }
        return try Wire.decoder.decode(Thread.self, from: data)
    }

    public func put(_ thread: Thread) async throws {
        let body = try Wire.encoder.encode(thread)
        let (_, response) = try await client.send(
            client.request("PUT", path(thread.id), body: body),
        )
        guard (200 ..< 300).contains(response.statusCode) else {
            throw APIError.status(response.statusCode, operation: "thread save")
        }
        // The `{ok, updatedAt}` body is ignored, exactly as the web client
        // ignores it. It becomes load-bearing in Phase 2's conflict check.
    }

    public func delete(id: String) async throws {
        let (_, response) = try await client.send(
            client.request("DELETE", path(id), body: nil),
        )
        let ok = (200 ..< 300).contains(response.statusCode) || response.statusCode == 404
        guard ok else {
            throw APIError.status(response.statusCode, operation: "thread delete")
        }
    }

    /// Never throws. A title is a nicety and must not break a send.
    public func title(user: String, assistant: String) async -> String? {
        do {
            let body = try Wire.encoder.encode(TitleRequest(user: user, assistant: assistant))
            let (data, response) = try await client.send(
                client.request("POST", "/api/title", body: body),
            )
            guard (200 ..< 300).contains(response.statusCode) else { return nil }
            return try Wire.decoder.decode(TitleResponse.self, from: data).title
        } catch {
            return nil
        }
    }

    /// Matches `encodeURIComponent` at `src/api/threads.ts:20`.
    private func path(_ id: String) -> String {
        let encoded = id.addingPercentEncoding(
            withAllowedCharacters: .urlPathComponentAllowed,
        ) ?? id
        return "/api/threads/\(encoded)"
    }
}

private struct ThreadListEnvelope: Decodable {
    var threads: [ThreadMeta]

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // `data.threads ?? []` at `src/api/threads.ts:16`.
        threads = try container.decodeIfPresent([ThreadMeta].self, forKey: .threads) ?? []
    }

    private enum CodingKeys: String, CodingKey { case threads }
}

private struct TitleRequest: Encodable {
    var user: String
    var assistant: String
}

private struct TitleResponse: Decodable {
    var title: String?
}

extension CharacterSet {
    /// `encodeURIComponent` escapes everything except
    /// `A-Z a-z 0-9 - _ . ! ~ * ' ( )`.
    static let urlPathComponentAllowed = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()",
    )
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `bin/remote-test` then `bin/remote-build-ios`
Expected: PASS, eight tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/thomasb/delphi-apple
git add Sources/DelphiKit/Net/ThreadsAPI.swift Tests/DelphiKitTests/ThreadsAPITests.swift
git commit -m "feat(net): threads API client ported from src/api/threads.ts

Phase 1A task 7. Two behaviours the web client depends on are pinned by tests: a
404 on delete is success, and title() swallows every error and returns nil so a
missing title never breaks a send."
```

---

### Task 8: `<think>` stripping

**Read this before writing code — the spec is misleading here.** Spec §4's SSE
section says `src/lib/thinking.ts` *"ports as a streaming state machine"*. The
current implementation is **not** a state machine: `stripThinking` is a pure
function over the **whole accumulated raw string**, called at
`src/App.tsx:99` and `:111`. It survives tags split across chunk boundaries
precisely *because* it re-runs over everything each time, never over a single
chunk.

Port it as a pure function and re-derive from the accumulated buffer. A
per-chunk state machine would have to separately track "have I emitted
non-whitespace yet" to reproduce the `trimStart()` at
`src/lib/thinking.ts:7`, and Phase 1 requires provable equivalence, not a
behaviour change. If a later phase wants incremental stripping, that is a
measured change with its own tests.

**Files:**
- Create: `Sources/DelphiKit/Text/Thinking.swift`
- Test: `Tests/DelphiKitTests/ThinkingTests.swift`

**Interfaces:**
- Produces: `public func stripThinking(_ raw: String) -> String`
- Produces: `public struct ThinkingAccumulator: Sendable` with
  `mutating func append(_ delta: String)`, `var visible: String`,
  `var raw: String`

- [ ] **Step 1: Write the failing test**

```swift
// Tests/DelphiKitTests/ThinkingTests.swift
import Foundation
import Testing
@testable import DelphiKit

@Test func removesACompletedThinkBlock() {
    #expect(stripThinking("<think>reasoning</think>Answer") == "Answer")
}

@Test func removesSeveralCompletedBlocks() {
    #expect(stripThinking("<think>a</think>One<think>b</think>Two") == "OneTwo")
}

@Test func hidesAnUnclosedTrailingBlock() {
    #expect(stripThinking("Visible<think>still thinking") == "Visible")
}

@Test func aBlockSpanningNewlinesIsStillRemoved() {
    #expect(stripThinking("<think>line one\nline two\n</think>Answer") == "Answer")
}

@Test func leadingWhitespaceIsTrimmedButTrailingIsNot() {
    // `trimStart()` at src/lib/thinking.ts:7 — leading only.
    #expect(stripThinking("<think>x</think>\n\n  Answer  ") == "Answer  ")
}

@Test func plainTextIsUnchanged() {
    #expect(stripThinking("Just an answer") == "Just an answer")
}

@Test func matchingIsNonGreedySoTwoBlocksDoNotCollapseIntoOne() {
    #expect(stripThinking("<think>a</think>KEEP<think>b</think>") == "KEEP")
}

/// The reason this is a whole-buffer function rather than a per-chunk one.
@Test func accumulatorHandlesATagSplitAcrossChunkBoundaries() {
    var accumulator = ThinkingAccumulator()
    for chunk in ["<thi", "nk>hidden re", "asoning</thi", "nk>Visible ", "answer"] {
        accumulator.append(chunk)
    }
    #expect(accumulator.visible == "Visible answer")
    #expect(accumulator.raw == "<think>hidden reasoning</think>Visible answer")
}

@Test func accumulatorHidesPartialOpeningTagWhileItArrives() {
    var accumulator = ThinkingAccumulator()
    accumulator.append("Answer so far")
    #expect(accumulator.visible == "Answer so far")
    accumulator.append("<think>new thought")
    #expect(accumulator.visible == "Answer so far")
    accumulator.append("</think> and more")
    #expect(accumulator.visible == "Answer so far and more")
}
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bin/remote-test`
Expected: FAIL — `cannot find 'stripThinking' in scope`.

- [ ] **Step 3: Write the minimal implementation**

```swift
// Sources/DelphiKit/Text/Thinking.swift
import Foundation

/// Port of `src/lib/thinking.ts`. MiniMax-M3 emits reasoning inline as
/// `<think>…</think>` before the real answer.
///
/// Deliberately a pure function over the whole accumulated string rather than
/// an incremental parser: that is what makes a tag split across two SSE chunks
/// come out right, and it is what the web client does.
public func stripThinking(_ raw: String) -> String {
    let withoutClosed = raw.replacing(/<think>[\s\S]*?<\/think>/, with: "")
    let visible: Substring
    if let open = withoutClosed.range(of: "<think>") {
        visible = withoutClosed[withoutClosed.startIndex ..< open.lowerBound]
    } else {
        visible = withoutClosed[...]
    }
    // `String.trimStart()` — leading whitespace only, trailing preserved.
    return String(visible.drop(while: \.isWhitespace))
}

/// Accumulates raw SSE deltas and re-derives the visible text from the whole
/// buffer each time, which is the only reason split tags work.
public struct ThinkingAccumulator: Sendable {
    public private(set) var raw = ""
    public private(set) var visible = ""

    public init() {}

    public mutating func append(_ delta: String) {
        raw += delta
        visible = stripThinking(raw)
    }
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `bin/remote-test` then `bin/remote-build-ios`
Expected: PASS, nine tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/thomasb/delphi-apple
git add Sources/DelphiKit/Text/Thinking.swift Tests/DelphiKitTests/ThinkingTests.swift
git commit -m "feat(text): port <think> stripping as a whole-buffer function

Phase 1A task 8. The spec describes this as a streaming state machine; the
implementation being ported is not one. src/lib/thinking.ts is a pure function
over the accumulated string, and that is exactly why a tag split across two SSE
chunks comes out right. Ported as-is, with a split-boundary test."
```

---

### Task 9: SSE chat stream client

Ports `src/api/chat.ts`. The line buffering at `src/api/chat.ts:80-84` — append
to a buffer, split on `\n`, keep the last (possibly incomplete) element — is the
part that must be exact, because SSE frames do not align with network chunks.

**Four fidelity details, each with a test:**

1. Only lines whose **trimmed** form starts with `data:` are considered
   (`src/api/chat.ts:88`); everything else, including SSE comments and blank
   separator lines, is skipped.
2. `[DONE]` ends the stream immediately and nothing after it is read
   (`src/api/chat.ts:91-94`).
3. A malformed JSON payload is **silently ignored**, not an error
   (`src/api/chat.ts:105-107`).
4. **An empty-string delta is skipped.** `src/api/chat.ts:104` reads
   `if (delta) onDelta(delta)`, and `""` is falsy in JavaScript. A Swift port
   written as `if let delta` would emit empty deltas the web client never emits.

**Files:**
- Create: `Sources/DelphiKit/Net/SSELineParser.swift`
- Create: `Sources/DelphiKit/Net/ChatStream.swift`
- Test: `Tests/DelphiKitTests/SSELineParserTests.swift`
- Test: `Tests/DelphiKitTests/ChatStreamTests.swift`

**Interfaces:**
- Produces: `public struct SSELineParser: Sendable` with
  `mutating func push(_ data: Data) -> [String]` and
  `mutating func flush() -> [String]`
- Produces: `public enum ChatEvent: Sendable, Equatable` with cases
  `kb(KbMeta)`, `delta(String)`, `sources([Source])`, `done`
- Produces: `public struct KbMeta: Codable, Hashable, Sendable` with
  `mode: ChatMode`, `grounded: Bool`, `sources: [CorpusSource]`
- Produces: `public struct ChatRequest: Encodable, Sendable` with
  `model: String`, `messages: [ChatWireMessage]`, `memory: Bool`, `mode: ChatMode`
- Produces: `public struct ChatStream: Sendable` with `init(client: APIClient)`
  and `func send(_ request: ChatRequest) -> AsyncThrowingStream<ChatEvent, any Error>`

- [ ] **Step 1: Write the failing test**

```swift
// Tests/DelphiKitTests/SSELineParserTests.swift
import Foundation
import Testing
@testable import DelphiKit

@Test func returnsOnlyCompleteLinesAndHoldsThePartialTail() {
    var parser = SSELineParser()
    #expect(parser.push(Data("alpha\nbra".utf8)) == ["alpha"])
    #expect(parser.push(Data("vo\ncharlie\n".utf8)) == ["bravo", "charlie"])
    #expect(parser.push(Data("".utf8)) == [])
}

@Test func flushYieldsAnyUnterminatedTail() {
    var parser = SSELineParser()
    _ = parser.push(Data("alpha\npartial".utf8))
    #expect(parser.flush() == ["partial"])
    #expect(parser.flush() == [])
}

@Test func survivesAMultiByteCharacterSplitAcrossChunks() {
    var parser = SSELineParser()
    let bytes = Array("é\n".data(using: .utf8)!)
    #expect(parser.push(Data(bytes[0 ..< 1])) == [])
    #expect(parser.push(Data(bytes[1...])) == ["é"])
}
```

```swift
// Tests/DelphiKitTests/ChatStreamTests.swift
import Foundation
import Testing
@testable import DelphiKit

@MainActor
private func collect(chunks: [String]) async throws -> [ChatEvent] {
    let transport = MockTransport()
    transport.enqueueStream(status: 200, chunks: chunks.map { Data($0.utf8) })
    let stream = ChatStream(client: APIClient(
        baseURL: URL(string: "https://maxi.mystuff.website")!,
        transport: transport,
        tokens: StaticTokenProvider(token: "tok"),
        connection: ConnectionStore(),
    ))
    var events: [ChatEvent] = []
    for try await event in stream.send(.init(
        model: "MiniMax-M3",
        messages: [.init(role: "user", content: .text("hi"))],
        memory: true,
        mode: .answer,
    )) {
        events.append(event)
    }
    return events
}

@Test @MainActor func parsesThePreambleDeltasAndSourcesInOrder() async throws {
    let events = try await collect(chunks: [
        #"data: {"kb":{"mode":"answer","grounded":true,"sources":[{"docId":"d","title":"T","origin":"seed","chunk":"c","index":0}]}}"# + "\n",
        #"data: {"choices":[{"delta":{"content":"Hel"}}]}"# + "\n",
        #"data: {"choices":[{"delta":{"content":"lo"}}]}"# + "\n",
        #"data: {"sources":[{"title":"S","url":"https://e.test"}]}"# + "\n",
        "data: [DONE]\n",
    ])

    #expect(events.count == 5)
    guard case let .kb(meta) = events[0] else { Issue.record("expected kb"); return }
    #expect(meta.grounded)
    #expect(meta.mode == .answer)
    #expect(events[1] == .delta("Hel"))
    #expect(events[2] == .delta("lo"))
    #expect(events[3] == .sources([Source(title: "S", url: "https://e.test")]))
    #expect(events[4] == .done)
}

@Test @MainActor func reassemblesAPayloadSplitAcrossNetworkChunks() async throws {
    let events = try await collect(chunks: [
        #"data: {"choices":[{"delta":{"co"#,
        #"ntent":"split"}}]}"# + "\n",
        "data: [DONE]\n",
    ])
    #expect(events == [.delta("split"), .done])
}

@Test @MainActor func skipsBlankLinesCommentsAndNonDataLines() async throws {
    let events = try await collect(chunks: [
        "\n: keep-alive comment\nevent: message\n",
        #"data: {"choices":[{"delta":{"content":"x"}}]}"# + "\n",
        "data: [DONE]\n",
    ])
    #expect(events == [.delta("x"), .done])
}

@Test @MainActor func ignoresAMalformedPayloadRatherThanFailing() async throws {
    let events = try await collect(chunks: [
        "data: {not json at all\n",
        #"data: {"choices":[{"delta":{"content":"ok"}}]}"# + "\n",
        "data: [DONE]\n",
    ])
    #expect(events == [.delta("ok"), .done])
}

/// `src/api/chat.ts:104` is `if (delta)`, and "" is falsy in JavaScript.
@Test @MainActor func skipsEmptyStringDeltas() async throws {
    let events = try await collect(chunks: [
        #"data: {"choices":[{"delta":{"content":""}}]}"# + "\n",
        #"data: {"choices":[{"delta":{"role":"assistant"}}]}"# + "\n",
        #"data: {"choices":[{"delta":{"content":"real"}}]}"# + "\n",
        "data: [DONE]\n",
    ])
    #expect(events == [.delta("real"), .done])
}

@Test @MainActor func stopsAtDoneAndIgnoresAnythingAfterIt() async throws {
    let events = try await collect(chunks: [
        "data: [DONE]\n",
        #"data: {"choices":[{"delta":{"content":"late"}}]}"# + "\n",
    ])
    #expect(events == [.done])
}

@Test @MainActor func finishesWithDoneWhenTheStreamEndsWithoutTheSentinel() async throws {
    // `src/api/chat.ts:110` calls onDone() after the read loop ends.
    let events = try await collect(chunks: [
        #"data: {"choices":[{"delta":{"content":"x"}}]}"# + "\n",
    ])
    #expect(events == [.delta("x"), .done])
}

@Test @MainActor func aNonSuccessStatusThrowsBeforeAnyEvent() async throws {
    let transport = MockTransport()
    transport.enqueue(status: 500, body: Data(#"{"error":"upstream exploded"}"#.utf8))
    let stream = ChatStream(client: APIClient(
        baseURL: URL(string: "https://maxi.mystuff.website")!,
        transport: transport,
        tokens: StaticTokenProvider(token: "tok"),
        connection: ConnectionStore(),
    ))

    await #expect(throws: ChatStreamError.self) {
        for try await _ in stream.send(.init(
            model: "m", messages: [], memory: true, mode: .answer,
        )) {}
    }
}
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bin/remote-test`
Expected: FAIL — `cannot find 'SSELineParser' in scope`.

- [ ] **Step 3: Write the minimal implementation**

```swift
// Sources/DelphiKit/Net/SSELineParser.swift
import Foundation

/// Line buffering for an SSE body, ported from `src/api/chat.ts:80-84`:
/// append, split on newline, keep the last element as the incomplete tail.
///
/// Buffers `Data` rather than `String` so a multi-byte character split across
/// two network chunks is not corrupted — a hazard the JavaScript version avoids
/// only because `TextDecoder({stream: true})` does the same thing internally.
public struct SSELineParser: Sendable {
    private var buffer = Data()
    private static let newline = UInt8(ascii: "\n")

    public init() {}

    public mutating func push(_ data: Data) -> [String] {
        buffer.append(data)
        var lines: [String] = []
        while let index = buffer.firstIndex(of: Self.newline) {
            let line = buffer[buffer.startIndex ..< index]
            lines.append(String(decoding: line, as: UTF8.self))
            buffer = buffer[buffer.index(after: index)...]
        }
        return lines
    }

    /// Any unterminated tail left when the body ends.
    public mutating func flush() -> [String] {
        guard !buffer.isEmpty else { return [] }
        let tail = String(decoding: buffer, as: UTF8.self)
        buffer = Data()
        return [tail]
    }
}
```

```swift
// Sources/DelphiKit/Net/ChatStream.swift
import Foundation

public struct KbMeta: Codable, Hashable, Sendable {
    public var mode: ChatMode
    public var grounded: Bool
    public var sources: [CorpusSource]

    public init(mode: ChatMode, grounded: Bool, sources: [CorpusSource]) {
        self.mode = mode
        self.grounded = grounded
        self.sources = sources
    }
}

public enum ChatEvent: Sendable, Equatable {
    case kb(KbMeta)
    case delta(String)
    case sources([Source])
    case done
}

public enum ChatStreamError: Error, Equatable {
    case status(Int, message: String?)
}

/// The `/api/chat` request body. `content` is either a plain string or the
/// multimodal parts array — `worker/chat.ts:101-113` accepts both.
public struct ChatWireMessage: Encodable, Sendable {
    public enum Content: Encodable, Sendable {
        case text(String)
        case parts([ContentPart])

        public func encode(to encoder: any Encoder) throws {
            var container = encoder.singleValueContainer()
            switch self {
            case let .text(value): try container.encode(value)
            case let .parts(value): try container.encode(value)
            }
        }
    }

    public struct ContentPart: Encodable, Sendable {
        public var type: String
        public var text: String?
        public var imageURL: ImageURL?

        public struct ImageURL: Encodable, Sendable {
            public var url: String
            public init(url: String) { self.url = url }
        }

        private enum CodingKeys: String, CodingKey {
            case type, text
            case imageURL = "image_url"
        }

        public static func text(_ value: String) -> ContentPart {
            ContentPart(type: "text", text: value, imageURL: nil)
        }

        public static func image(dataURL: String) -> ContentPart {
            ContentPart(type: "image_url", text: nil, imageURL: ImageURL(url: dataURL))
        }
    }

    public var role: String
    public var content: Content

    public init(role: String, content: Content) {
        self.role = role
        self.content = content
    }
}

public struct ChatRequest: Encodable, Sendable {
    public var model: String
    public var messages: [ChatWireMessage]
    public var memory: Bool
    public var mode: ChatMode

    public init(model: String, messages: [ChatWireMessage], memory: Bool, mode: ChatMode) {
        self.model = model
        self.messages = messages
        self.memory = memory
        self.mode = mode
    }
}

/// Port of `src/api/chat.ts`. The web version takes callbacks; this yields an
/// `AsyncThrowingStream` so cancellation is structured.
public struct ChatStream: Sendable {
    private let client: APIClient

    public init(client: APIClient) {
        self.client = client
    }

    public func send(_ request: ChatRequest) -> AsyncThrowingStream<ChatEvent, any Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let body = try Wire.encoder.encode(request)
                    let (bytes, response) = try await client.stream(
                        client.request("POST", "/api/chat", body: body),
                    )
                    guard (200 ..< 300).contains(response.statusCode) else {
                        continuation.finish(throwing: ChatStreamError.status(
                            response.statusCode, message: nil,
                        ))
                        return
                    }

                    var parser = SSELineParser()
                    for try await chunk in bytes {
                        for line in parser.push(chunk) {
                            if emit(line, to: continuation) { return }
                        }
                    }
                    for line in parser.flush() {
                        if emit(line, to: continuation) { return }
                    }
                    // `src/api/chat.ts:110` — a stream that ends without the
                    // sentinel still completes normally.
                    continuation.yield(.done)
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Returns true when the stream is finished and reading must stop.
    private func emit(
        _ line: String,
        to continuation: AsyncThrowingStream<ChatEvent, any Error>.Continuation,
    ) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("data:") else { return false }
        let payload = trimmed.dropFirst(5).trimmingCharacters(in: .whitespacesAndNewlines)

        if payload == "[DONE]" {
            continuation.yield(.done)
            continuation.finish()
            return true
        }

        guard let data = payload.data(using: .utf8) else { return false }

        if let envelope = try? Wire.decoder.decode(KbEnvelope.self, from: data),
           let kb = envelope.kb {
            continuation.yield(.kb(kb))
            return false
        }
        if let envelope = try? Wire.decoder.decode(SourcesEnvelope.self, from: data),
           let sources = envelope.sources {
            continuation.yield(.sources(sources))
            return false
        }
        if let envelope = try? Wire.decoder.decode(DeltaEnvelope.self, from: data),
           let content = envelope.choices?.first?.delta?.content,
           // `if (delta)` at src/api/chat.ts:104 — "" is falsy.
           !content.isEmpty {
            continuation.yield(.delta(content))
        }
        // Anything else, malformed included, is ignored.
        return false
    }
}

private struct KbEnvelope: Decodable {
    var kb: KbMeta?
}

private struct SourcesEnvelope: Decodable {
    var sources: [Source]?
}

private struct DeltaEnvelope: Decodable {
    struct Choice: Decodable {
        struct Delta: Decodable { var content: String? }
        var delta: Delta?
    }

    var choices: [Choice]?
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `bin/remote-test` then `bin/remote-build-ios`
Expected: PASS, twelve tests total.

- [ ] **Step 5: Commit**

```bash
cd /Users/thomasb/delphi-apple
git add Sources/DelphiKit/Net/SSELineParser.swift Sources/DelphiKit/Net/ChatStream.swift \
        Tests/DelphiKitTests/SSELineParserTests.swift Tests/DelphiKitTests/ChatStreamTests.swift
git commit -m "feat(net): SSE chat stream client with the three payload shapes

Phase 1A task 9. Ports src/api/chat.ts. Line buffering holds an incomplete tail
so a payload split across network chunks reassembles, and the parser buffers
bytes rather than characters so a split multi-byte character is not corrupted.
Empty-string deltas are skipped, matching `if (delta)` in the web client."
```

---

### Task 10: The sync engine

The equivalence centrepiece. `src/state/sync.ts` is 173 lines and every branch
is user-visible, so **the test list below is derived from that file's branches,
not from the Swift implementation.** Each test cites the line it pins. Writing
tests from the Swift code instead would prove only that the code does what it
does.

Spec §1: *"This is deliberately not an improvement. Phase 1 must be provably
equivalent to the web app, or a port bug is indistinguishable from a design
bug."* Resist every urge to fix what looks like a flaw — the `error` status
leaving a thread dirty forever, the 30-second retry loop, the lack of a backoff.
They are the behaviour under test.

**Two substitutions, both forced by the platform:**

| Web | Swift | Why |
|---|---|---|
| `navigator.onLine` (`sync.ts:66`) | `ReachabilityProviding` over `NWPathMonitor` | No `navigator` |
| `window` `online` + `visibilitychange` (`sync.ts:167-172`) | `func applicationDidBecomeActive()` and `func connectivityRestored()` | No DOM events; 1D wires them to `scenePhase` |

**Timing.** The debounce and retry intervals are injectable so tests run in
milliseconds, and the **production constants are asserted directly** so the
injection cannot quietly change behaviour.

**Files:**
- Create: `Sources/DelphiKit/Sync/Reachability.swift`
- Create: `Sources/DelphiKit/Sync/SyncEngine.swift`
- Test: `Tests/DelphiKitTests/SyncEngineTests.swift`

**Interfaces:**
- Produces: `public protocol ReachabilityProviding: Sendable { var isOnline: Bool { get } }`,
  `public struct NetworkReachability: ReachabilityProviding`,
  `public final class StubReachability: ReachabilityProviding, @unchecked Sendable`
- Produces: `public enum SyncStatus: String, Sendable { case pending, synced, error }`
- Produces: `public protocol SyncPersistence: Sendable` with
  `func loadDirty() -> [String]`, `func saveDirty([String])`,
  `func loadDeletes() -> [String]`, `func saveDeletes([String])`
  (`UserDefaultsSyncPersistence` is the shipping implementation — it replaces
  the two `localStorage` keys at `sync.ts:15-16`)
- Produces: `public actor SyncEngine` with
  `init(api: ThreadsAPI, store: ThreadStore, persistence: any SyncPersistence, reachability: any ReachabilityProviding, debounce: Duration = SyncEngine.defaultDebounce, retry: Duration = SyncEngine.defaultRetry)`,
  `static let defaultDebounce: Duration`, `static let defaultRetry: Duration`,
  `func markDirty(_ threadID: String)`, `func markDeleted(_ threadID: String)`,
  `func scheduleFlush(after: Duration?)`, `func flush() async`,
  `func reconcile() async`, `func status(of: String) -> SyncStatus?`,
  `func statuses() -> [String: SyncStatus]`,
  `func applicationDidBecomeActive()`, `func connectivityRestored()`

- [ ] **Step 1: Write the failing test**

```swift
// Tests/DelphiKitTests/SyncEngineTests.swift
//
// Every test cites the line of delphi-chat/src/state/sync.ts it pins.
import Foundation
import Testing
@testable import DelphiKit

@MainActor
private struct Harness {
    let engine: SyncEngine
    let transport: MockTransport
    let store: ThreadStore
    let reachability: StubReachability
    let persistence: InMemorySyncPersistence
}

@MainActor
private func makeHarness(debounce: Duration = .milliseconds(20)) throws -> Harness {
    let transport = MockTransport()
    let store = try ThreadStore.inMemory()
    let reachability = StubReachability(isOnline: true)
    let persistence = InMemorySyncPersistence()
    let api = ThreadsAPI(client: APIClient(
        baseURL: URL(string: "https://maxi.mystuff.website")!,
        transport: transport,
        tokens: StaticTokenProvider(token: "tok"),
        connection: ConnectionStore(),
    ))
    let engine = SyncEngine(
        api: api, store: store, persistence: persistence,
        reachability: reachability,
        debounce: debounce, retry: .milliseconds(50),
    )
    return Harness(
        engine: engine, transport: transport, store: store,
        reachability: reachability, persistence: persistence,
    )
}

private func sample(_ id: String, updatedAt: Int = 100) -> Thread {
    Thread(
        id: id, title: "T-\(id)", model: "MiniMax-M3",
        createdAt: 1, updatedAt: updatedAt,
        messages: [Message(id: "m0", role: .user, content: "hi", createdAt: 2)],
    )
}

/// sync.ts:15-17 — the two debounce constants are user-visible behaviour.
@Test func productionIntervalsMatchTheWebClient() {
    #expect(SyncEngine.defaultDebounce == .milliseconds(2000))
    #expect(SyncEngine.defaultRetry == .milliseconds(30_000))
}

/// sync.ts:45-50 — markDirty sets pending and schedules a debounced flush.
@Test @MainActor func markDirtySetsPendingThenSyncedAfterAFlush() async throws {
    let h = try makeHarness()
    try h.store.upsert(sample("t1"))
    h.transport.enqueue(status: 200, body: Data(#"{"ok":true}"#.utf8))

    await h.engine.markDirty("t1")
    #expect(await h.engine.status(of: "t1") == .pending)

    await h.engine.flush()
    #expect(await h.engine.status(of: "t1") == .synced)
    #expect(h.transport.recordedRequests.contains { $0.httpMethod == "PUT" })
}

/// sync.ts:52-60 — a delete drops the thread from dirty, queues a tombstone,
/// REMOVES the status entry entirely, and flushes immediately.
@Test @MainActor func markDeletedRemovesTheStatusEntryAndFlushesAtOnce() async throws {
    let h = try makeHarness()
    try h.store.upsert(sample("t1"))
    await h.engine.markDirty("t1")

    h.transport.enqueue(status: 200, body: Data())
    await h.engine.markDeleted("t1")
    await h.engine.flush()

    #expect(await h.engine.status(of: "t1") == nil)
    #expect(h.persistence.loadDeletes().isEmpty)
    #expect(h.transport.recordedRequests.contains { $0.httpMethod == "DELETE" })
}

/// sync.ts:66 — a flush while offline is a no-op; nothing is consumed.
@Test @MainActor func flushDoesNothingWhileOffline() async throws {
    let h = try makeHarness()
    try h.store.upsert(sample("t1"))
    h.reachability.isOnline = false

    await h.engine.markDirty("t1")
    await h.engine.flush()

    #expect(h.transport.recordedRequests.isEmpty)
    #expect(await h.engine.status(of: "t1") == .pending)
}

/// sync.ts:87-89 — a failed PUT sets error AND leaves the thread dirty, so the
/// retry loop picks it up. Not a bug to fix in Phase 1.
@Test @MainActor func aFailedPutSetsErrorAndKeepsTheThreadDirty() async throws {
    let h = try makeHarness()
    try h.store.upsert(sample("t1"))
    h.transport.enqueue(status: 500, body: Data())

    await h.engine.markDirty("t1")
    await h.engine.flush()

    #expect(await h.engine.status(of: "t1") == .error)
    #expect(h.persistence.loadDirty() == ["t1"])
}

/// sync.ts:78-82 — a dirty id with no thread behind it is dropped silently.
@Test @MainActor func aDirtyIdWithNoThreadIsDroppedWithoutARequest() async throws {
    let h = try makeHarness()
    await h.engine.markDirty("ghost")
    await h.engine.flush()

    #expect(h.transport.recordedRequests.isEmpty)
    #expect(h.persistence.loadDirty().isEmpty)
}

/// sync.ts:73-75 — a failed DELETE stays queued for the next flush.
@Test @MainActor func aFailedDeleteStaysQueued() async throws {
    let h = try makeHarness()
    try h.store.upsert(sample("t1"))
    h.transport.enqueue(status: 500, body: Data())

    await h.engine.markDeleted("t1")
    await h.engine.flush()
    #expect(h.persistence.loadDeletes() == ["t1"])

    h.transport.enqueue(status: 200, body: Data())
    await h.engine.flush()
    #expect(h.persistence.loadDeletes().isEmpty)
}

/// sync.ts:63-65 — the reentrancy guard. A second flush *while the first is
/// still in flight* is a no-op rather than a duplicate PUT.
///
/// Two `async let` calls would not test this: the second may simply land after
/// the first finished, at which point `dirty` is empty and the assertion holds
/// whether or not the guard exists. The transport therefore parks inside the
/// PUT until the test releases it, so the second `flush()` provably arrives
/// while `t1` is still dirty. This is the port's only concurrency invariant.
@Test @MainActor func aFlushDuringAnInFlightFlushIsANoOp() async throws {
    let h = try makeHarness()
    try h.store.upsert(sample("t1"))

    let gate = RequestGate()
    h.transport.enqueueBlocking(status: 200, body: Data(#"{"ok":true}"#.utf8), gate: gate)

    await h.engine.markDirty("t1")
    let first = Task { await h.engine.flush() }
    await gate.waitUntilRequestArrived()

    // The first flush is parked inside the transport, t1 still dirty.
    await h.engine.flush()
    await gate.release()
    await first.value

    #expect(h.transport.recordedRequests.filter { $0.httpMethod == "PUT" }.count == 1)
}

/// sync.ts:23-24, 30 — the dirty set and tombstones survive a restart, and
/// restored dirty ids come back as pending.
@Test @MainActor func dirtyAndDeletedSetsSurviveARestart() async throws {
    let h = try makeHarness()
    try h.store.upsert(sample("t1"))
    await h.engine.markDirty("t1")
    h.reachability.isOnline = false
    await h.engine.markDeleted("t2")

    let restarted = SyncEngine(
        api: ThreadsAPI(client: APIClient(
            baseURL: URL(string: "https://maxi.mystuff.website")!,
            transport: h.transport,
            tokens: StaticTokenProvider(token: "tok"),
            connection: ConnectionStore(),
        )),
        store: h.store,
        persistence: h.persistence,
        reachability: h.reachability,
        debounce: .milliseconds(20), retry: .milliseconds(50),
    )
    #expect(await restarted.status(of: "t1") == .pending)
    #expect(h.persistence.loadDeletes() == ["t2"])
}

/// sync.ts:112-115 — a failed list leaves the local cache authoritative and
/// changes nothing.
@Test @MainActor func reconcileGivesUpQuietlyWhenTheListFails() async throws {
    let h = try makeHarness()
    try h.store.upsert(sample("t1"))
    h.transport.enqueueFailure(URLError(.notConnectedToInternet))

    await h.engine.reconcile()
    #expect(await h.engine.status(of: "t1") == nil)
}

/// sync.ts:122 — a thread deleted locally but not yet flushed is not resurrected
/// by a reconcile.
@Test @MainActor func reconcileSkipsLocallyDeletedThreads() async throws {
    let h = try makeHarness()
    h.reachability.isOnline = false
    await h.engine.markDeleted("t1")
    h.reachability.isOnline = true

    h.transport.enqueue(status: 200, body: Data(#"""
    {"threads":[{"id":"t1","title":"Remote","model":"m","createdAt":1,"updatedAt":999}]}
    """#.utf8))

    await h.engine.reconcile()
    #expect(try h.store.thread(id: "t1") == nil)
}

/// sync.ts:124-132 — remote-newer and remote-only threads are fetched whole and
/// upserted.
@Test @MainActor func reconcilePullsRemoteNewerAndRemoteOnlyThreads() async throws {
    let h = try makeHarness()
    try h.store.upsert(sample("stale", updatedAt: 1))

    h.transport.enqueue(status: 200, body: Data(#"""
    {"threads":[{"id":"stale","title":"R","model":"m","createdAt":1,"updatedAt":50},
                {"id":"fresh","title":"R2","model":"m","createdAt":1,"updatedAt":60}]}
    """#.utf8))
    h.transport.enqueue(status: 200, body: Data(#"""
    {"id":"stale","title":"Remote wins","model":"m","createdAt":1,"updatedAt":50,"messages":[]}
    """#.utf8))
    h.transport.enqueue(status: 200, body: Data(#"""
    {"id":"fresh","title":"Brand new","model":"m","createdAt":1,"updatedAt":60,"messages":[]}
    """#.utf8))

    await h.engine.reconcile()

    #expect(try h.store.thread(id: "stale")?.title == "Remote wins")
    #expect(try h.store.thread(id: "fresh")?.title == "Brand new")
    #expect(await h.engine.status(of: "stale") == .synced)
}

/// sync.ts:133-134 — a local thread that is newer and not dirty is just marked
/// synced, with no fetch.
@Test @MainActor func reconcileMarksLocalNewerThreadsSyncedWithoutFetching() async throws {
    let h = try makeHarness()
    try h.store.upsert(sample("t1", updatedAt: 900))
    h.transport.enqueue(status: 200, body: Data(#"""
    {"threads":[{"id":"t1","title":"R","model":"m","createdAt":1,"updatedAt":5}]}
    """#.utf8))

    await h.engine.reconcile()

    #expect(await h.engine.status(of: "t1") == .synced)
    #expect(h.transport.recordedRequests.count == 1)
    #expect(try h.store.thread(id: "t1")?.title == "T-t1")
}

/// sync.ts:138-140 — a local-only thread is pushed. This is also the first-run
/// migration path, which falls out for free.
@Test @MainActor func reconcileMarksLocalOnlyThreadsDirty() async throws {
    let h = try makeHarness()
    try h.store.upsert(sample("local-only"))
    h.transport.enqueue(status: 200, body: Data(#"{"threads":[]}"#.utf8))

    await h.engine.reconcile()
    #expect(await h.engine.status(of: "local-only") == .pending)
    #expect(h.persistence.loadDirty() == ["local-only"])
}

/// sync.ts:167-172 — the two wake-up entry points both flush immediately.
@Test @MainActor func foregroundAndConnectivityRestoredBothFlush() async throws {
    let h = try makeHarness()
    try h.store.upsert(sample("t1"))
    h.reachability.isOnline = false
    await h.engine.markDirty("t1")
    await h.engine.flush()
    #expect(h.transport.recordedRequests.isEmpty)

    h.reachability.isOnline = true
    h.transport.enqueue(status: 200, body: Data(#"{"ok":true}"#.utf8))
    await h.engine.connectivityRestored()
    try await Task.sleep(for: .milliseconds(120))
    #expect(await h.engine.status(of: "t1") == .synced)

    try h.store.upsert(sample("t2"))
    h.transport.enqueue(status: 200, body: Data(#"{"ok":true}"#.utf8))
    await h.engine.markDirty("t2")
    await h.engine.applicationDidBecomeActive()
    try await Task.sleep(for: .milliseconds(120))
    #expect(await h.engine.status(of: "t2") == .synced)
}

private final class InMemorySyncPersistence: SyncPersistence, @unchecked Sendable {
    private let lock = NSLock()
    private var dirty: [String] = []
    private var deletes: [String] = []

    func loadDirty() -> [String] { lock.lock(); defer { lock.unlock() }; return dirty }
    func saveDirty(_ ids: [String]) { lock.lock(); defer { lock.unlock() }; dirty = ids }
    func loadDeletes() -> [String] { lock.lock(); defer { lock.unlock() }; return deletes }
    func saveDeletes(_ ids: [String]) { lock.lock(); defer { lock.unlock() }; deletes = ids }
}
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bin/remote-test`
Expected: FAIL — `cannot find 'SyncEngine' in scope`.

- [ ] **Step 3: Write the minimal implementation**

```swift
// Sources/DelphiKit/Sync/Reachability.swift
import Foundation
import Network

/// Stands in for `navigator.onLine` (`src/state/sync.ts:66`).
public protocol ReachabilityProviding: Sendable {
    var isOnline: Bool { get }
}

public final class NetworkReachability: ReachabilityProviding, @unchecked Sendable {
    private let monitor = NWPathMonitor()
    private let lock = NSLock()
    private var online = true

    public init() {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            lock.lock()
            online = path.status == .satisfied
            lock.unlock()
        }
        monitor.start(queue: DispatchQueue(label: "delphi.reachability"))
    }

    public var isOnline: Bool {
        lock.lock(); defer { lock.unlock() }
        return online
    }
}

public final class StubReachability: ReachabilityProviding, @unchecked Sendable {
    private let lock = NSLock()
    private var value: Bool

    public init(isOnline: Bool) { value = isOnline }

    public var isOnline: Bool {
        get { lock.lock(); defer { lock.unlock() }; return value }
        set { lock.lock(); defer { lock.unlock() }; value = newValue }
    }
}
```

```swift
// Sources/DelphiKit/Sync/SyncEngine.swift
import Foundation

public enum SyncStatus: String, Sendable, Equatable {
    case pending, synced, error
}

/// Replaces the two `localStorage` keys at `src/state/sync.ts:15-16`.
public protocol SyncPersistence: Sendable {
    func loadDirty() -> [String]
    func saveDirty(_ ids: [String])
    func loadDeletes() -> [String]
    func saveDeletes(_ ids: [String])
}

public struct UserDefaultsSyncPersistence: SyncPersistence {
    private let defaults: UserDefaults
    private static let dirtyKey = "delphi:sync-dirty"
    private static let deletesKey = "delphi:sync-deletes"

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func loadDirty() -> [String] {
        defaults.stringArray(forKey: Self.dirtyKey) ?? []
    }

    public func saveDirty(_ ids: [String]) {
        defaults.set(ids, forKey: Self.dirtyKey)
    }

    public func loadDeletes() -> [String] {
        defaults.stringArray(forKey: Self.deletesKey) ?? []
    }

    public func saveDeletes(_ ids: [String]) {
        defaults.set(ids, forKey: Self.deletesKey)
    }
}

/// Port of `src/state/sync.ts`. Write-through: D1 is the source of truth,
/// SwiftData is the cache. Mutations mark a thread dirty; a debounced flush
/// pushes whole threads. Never called mid-stream — only on settled mutations.
///
/// Behaviour is deliberately identical to the web client, including the parts
/// that look like flaws (an errored thread stays dirty forever; the retry has
/// no backoff). Phase 1 must be provably equivalent, so these are under test
/// rather than under repair.
public actor SyncEngine {
    public static let defaultDebounce: Duration = .milliseconds(2000)
    public static let defaultRetry: Duration = .milliseconds(30_000)

    private let api: ThreadsAPI
    private let store: ThreadStore
    private let persistence: any SyncPersistence
    private let reachability: any ReachabilityProviding
    private let debounce: Duration
    private let retry: Duration

    private var dirty: Set<String>
    private var pendingDeletes: Set<String>
    private var state: [String: SyncStatus] = [:]
    private var flushTask: Task<Void, Never>?
    private var flushing = false

    public init(
        api: ThreadsAPI,
        store: ThreadStore,
        persistence: any SyncPersistence,
        reachability: any ReachabilityProviding,
        debounce: Duration = SyncEngine.defaultDebounce,
        retry: Duration = SyncEngine.defaultRetry,
    ) {
        self.api = api
        self.store = store
        self.persistence = persistence
        self.reachability = reachability
        self.debounce = debounce
        self.retry = retry
        dirty = Set(persistence.loadDirty())
        pendingDeletes = Set(persistence.loadDeletes())
        // `for (const id of dirty) state[id] = "pending"` — sync.ts:30.
        for id in dirty { state[id] = .pending }
    }

    public func status(of threadID: String) -> SyncStatus? { state[threadID] }

    public func statuses() -> [String: SyncStatus] { state }

    public func markDirty(_ threadID: String) {
        dirty.insert(threadID)
        persistence.saveDirty(Array(dirty))
        state[threadID] = .pending
        scheduleFlush(after: nil)
    }

    public func markDeleted(_ threadID: String) {
        dirty.remove(threadID)
        persistence.saveDirty(Array(dirty))
        pendingDeletes.insert(threadID)
        persistence.saveDeletes(Array(pendingDeletes))
        // The status entry is deleted outright, not set to a value — sync.ts:57.
        state[threadID] = nil
        // Deliberately does NOT touch the local store: `markDeleted` in
        // sync.ts:52-60 only queues the tombstone, and the caller removes the
        // thread from local state. 1D's view model does the same.
        scheduleFlush(after: .zero)
    }

    public func scheduleFlush(after delay: Duration?) {
        let interval = delay ?? debounce
        flushTask?.cancel()
        flushTask = Task { [weak self] in
            if interval > .zero {
                try? await Task.sleep(for: interval)
            }
            guard !Task.isCancelled else { return }
            await self?.flush()
        }
    }

    public func applicationDidBecomeActive() { scheduleFlush(after: .zero) }

    public func connectivityRestored() { scheduleFlush(after: .zero) }

    public func flush() async {
        // sync.ts:65 — the reentrancy and offline guards, in that order.
        guard !flushing, reachability.isOnline else { return }
        flushing = true

        for id in pendingDeletes {
            do {
                try await api.delete(id: id)
                pendingDeletes.remove(id)
                persistence.saveDeletes(Array(pendingDeletes))
            } catch {
                // Keep queued; retried on the next flush — sync.ts:74.
            }
        }

        for id in dirty {
            guard let thread = try? await store.threadSynchronously(id: id) else {
                // A dirty id with nothing behind it is dropped — sync.ts:79-82.
                dirty.remove(id)
                persistence.saveDirty(Array(dirty))
                continue
            }
            do {
                try await api.put(thread)
                dirty.remove(id)
                persistence.saveDirty(Array(dirty))
                state[id] = .synced
            } catch {
                // Errored threads stay dirty on purpose — sync.ts:88.
                state[id] = .error
            }
        }

        flushing = false

        if !dirty.isEmpty || !pendingDeletes.isEmpty {
            scheduleFlush(after: retry)
        }
    }

    /// Boot reconcile — sync.ts:105-142.
    public func reconcile() async {
        let remote: [ThreadMeta]
        do {
            remote = try await api.list()
        } catch {
            // Offline or error: the local cache stays authoritative — sync.ts:113.
            return
        }

        let local = (try? await store.allSynchronously()) ?? []
        let localByID = Dictionary(uniqueKeysWithValues: local.map { ($0.id, $0) })
        let remoteIDs = Set(remote.map(\.id))

        for meta in remote {
            if pendingDeletes.contains(meta.id) { continue }
            let mine = localByID[meta.id]
            if mine == nil || meta.updatedAt > (mine?.updatedAt ?? 0) {
                do {
                    let full = try await api.get(id: meta.id)
                    try await store.upsertSynchronously(full)
                    state[meta.id] = .synced
                } catch {
                    // Skip; the next boot retries — sync.ts:130.
                }
            } else if !dirty.contains(meta.id) {
                state[meta.id] = .synced
            }
        }

        for thread in local where !remoteIDs.contains(thread.id) {
            markDirty(thread.id)
        }

        scheduleFlush(after: .zero)
    }
}
```

**`ThreadStore` is `@MainActor` and `SyncEngine` is an actor**, so the store
calls above need main-actor hops. Add these three thin wrappers to
`ThreadStore` in the same step, and use them from the engine:

```swift
// Append to Sources/DelphiKit/Model/ThreadStore.swift
public extension ThreadStore {
    nonisolated func threadSynchronously(id: String) async throws -> Thread? {
        try await MainActor.run { try self.thread(id: id) }
    }

    nonisolated func allSynchronously() async throws -> [Thread] {
        try await MainActor.run { try self.loadAll() }
    }

    nonisolated func upsertSynchronously(_ thread: Thread) async throws {
        try await MainActor.run { try self.upsert(thread) }
    }

    nonisolated func deleteSynchronously(id: String) async throws {
        try await MainActor.run { try self.delete(id: id) }
    }
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `bin/remote-test` then `bin/remote-build-ios`
Expected: PASS — fifteen sync tests and the whole suite green.

- [ ] **Step 5: Commit**

```bash
cd /Users/thomasb/delphi-apple
git add Sources/DelphiKit/Sync Sources/DelphiKit/Model/ThreadStore.swift \
        Tests/DelphiKitTests/SyncEngineTests.swift
git commit -m "feat(sync): port src/state/sync.ts as an actor

Phase 1A task 10. Every test cites the line of sync.ts it pins, so this is a
port rather than a reimplementation. Behaviour that looks like a flaw is
preserved deliberately — an errored thread stays dirty, the retry has no
backoff — because Phase 1 must be provably equivalent to the web client or a
port bug is indistinguishable from a design bug."
```

---

### Task 11: One end-to-end pass against the real Worker

Everything above is proven against `MockTransport`. That is the right
development substrate, and it is **not** sufficient evidence — spec §1: *"Do not
declare the port equivalent on mock evidence alone, because that is precisely
the case where a port bug and a mock-fidelity bug look the same."*

This became possible on 2026-09-10, when a bearer token was accepted by the
origin and `/api/threads` answered with real Worker JSON. It costs **one
interactive human sign-in per 15-minute token**, so it is a batched manual pass,
never a CI job.

**Do not skip this task and do not simulate it.** Its whole value is that
nothing in it is mocked.

**Prerequisites:**
- Tasks 1 and 4–10 complete and green.
- A signed-in token. If Task 2 found the refresh grant works, use
  `spikes/oauth/refresh.sh`; otherwise run `spikes/oauth/authorize-url.sh` and
  `spikes/oauth/exchange.sh` for a fresh interactive sign-in.
- **Use a throwaway thread id.** This writes to the operator's real D1. Never
  `PUT` over a real thread.

**Files:**
- Modify: `Sources/LiveE2E/main.swift` — replaces the Task 1 placeholder
- Modify: `Package.swift` — the test target gains `resources: [.copy("Fixtures")]`
- Create: `Tests/DelphiKitTests/Fixtures/thread_wire.json` — a real captured `GET` body
- Create: `Tests/DelphiKitTests/Fixtures/chat_stream.sse` — a real captured SSE transcript
- Modify: `API-NOTES.md` — new entry, `### Phase 1A — the ported client against
  the live Worker`
- Test: `Tests/DelphiKitTests/LiveFixtureTests.swift`

**Why the fixtures live under `Tests/` and not under `spikes/`.**
`bin/_remote-sync.sh` excludes `spikes/`, so anything there never reaches the
build host and a `#filePath`-relative lookup would resolve to a path that does
not exist. As SwiftPM resources they are copied into the test bundle and read
through `Bundle.module`, which makes the replay hermetic. Both the resource
lookup and the executable target were probed on the build host on 2026-09-10.

**Interfaces:**
- Produces: `Tests/DelphiKitTests/Fixtures/thread_wire.json`, replayed by
  `LiveFixtureTests` forever after, so the wire shape stays pinned by real bytes
  rather than by bytes this plan invented.

- [ ] **Step 1: Write the live exercise**

Replace the Task 1 placeholder. The file must be named `main.swift` — top-level
statements are only allowed there — and the target is run with
`swift run live-e2e`.

```swift
// Sources/LiveE2E/main.swift
// Phase 1A task 11. Drives DelphiKit against the live Worker with a real Access
// token. Run on the build host; needs ACCESS_TOKEN in the environment. Never
// commit the token.
//
// Writes and then deletes ONE throwaway thread. It never touches a real one.
import Foundation
import DelphiKit

let token = ProcessInfo.processInfo.environment["ACCESS_TOKEN"]!
let origin = URL(string: "https://maxi.mystuff.website")!
let threadID = "e2e-\(UUID().uuidString)"

// Top-level code in main.swift is already main-actor isolated, and
// ConnectionStore's init is @MainActor rather than async — so no `await` here.
let connection = ConnectionStore()
let client = APIClient(
    baseURL: origin,
    transport: URLSessionTransport(),
    tokens: StaticTokenProvider(token: token),
    connection: connection,
)
let api = ThreadsAPI(client: client)

// 1. LIST — the call spike 2 proved returns 200 with a Worker-shaped body.
let before = try await api.list()
print("LIST ok: \(before.count) threads")

// 2. PUT a throwaway thread.
let now = Int(Date().timeIntervalSince1970 * 1000)
let thread = Thread(
    id: threadID, title: "phase-1a e2e", model: "MiniMax-M3",
    createdAt: now, updatedAt: now,
    messages: [
        Message(id: "m0", role: .user, content: "ping", createdAt: now),
        Message(
            id: "m1", role: .assistant, content: "pong", createdAt: now + 1,
            sources: [Source(title: "S", url: "https://example.test")],
            mode: .answer, grounded: false,
        ),
    ],
)
try await api.put(thread)
print("PUT ok")

// 3. GET it back and compare field by field. This is the equivalence check the
//    mock cannot make.
let fetched = try await api.get(id: threadID)
print("GET ok")
print("ROUND-TRIP IDENTICAL: \(fetched == thread)")
if fetched != thread {
    print("  local : \(thread)")
    print("  remote: \(fetched)")
}

// 4. Capture the raw bytes as a fixture.
let (raw, _) = try await client.send(
    client.request("GET", "/api/threads/\(threadID)", body: nil),
)
try raw.write(to: URL(fileURLWithPath: "Tests/DelphiKitTests/Fixtures/thread_wire.json"))
print("captured \(raw.count) bytes of real wire JSON")

// 5. DELETE, and confirm it is gone.
try await api.delete(id: threadID)
let after = try await api.list()
print("DELETE ok; thread present after delete: \(after.contains { $0.id == threadID })")
```

- [ ] **Step 2: Run it against the live deployment**

First declare the fixtures directory as a resource, or the build fails once the
replay test lands. In `Package.swift`:

```swift
        .testTarget(
            name: "DelphiKitTests",
            dependencies: ["DelphiKit"],
            resources: [.copy("Fixtures")],
        ),
```

```bash
cd /Users/thomasb/delphi-apple
mkdir -p Tests/DelphiKitTests/Fixtures
# Obtain a token first — refresh.sh if task 2 showed the grant works, otherwise
# authorize-url.sh + exchange.sh with an interactive sign-in.
source .env.local
# This one runs LOCALLY, not through bin/remote-test: it needs the live token
# and outbound network, and it writes the fixtures into the working tree.
ACCESS_TOKEN="$ACCESS_TOKEN" swift run live-e2e
```

The local machine has no iOS SDK but `swift run` here targets macOS only, so it
builds locally. If the local toolchain refuses, rsync the tree to the build host
and run it there instead — the token travels in the environment, never in a
file.

Expected: every line prints `ok`, `ROUND-TRIP IDENTICAL: true`, and
`thread present after delete: false`.

**If `ROUND-TRIP IDENTICAL` is false, stop.** That is a real port bug and it is
exactly what this task exists to find. The likely causes, in order:
per-message `createdAt` not surviving (Task 4's asymmetry 2), an optional field
encoded as `null` where the server omits it (asymmetry 3), or `titleEdited`
leaking onto the wire (asymmetry 1). Fix the model, not the test.

- [ ] **Step 3: Capture a real SSE transcript**

```bash
curl -N -X POST "https://maxi.mystuff.website/api/chat" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"model":"MiniMax-M3","messages":[{"role":"user","content":"Say hello in five words."}],"memory":false,"mode":"answer"}' \
  | tee Tests/DelphiKitTests/Fixtures/chat_stream.sse
```

Review the captured file before committing it: it contains a real model reply
and a real `{kb:…}` preamble. Remove nothing structural, but if the reply or the
KB excerpts carry personal content, re-run the capture with a blander prompt
rather than hand-editing the transcript.

- [ ] **Step 4: Pin both fixtures with a replay test**

```swift
// Tests/DelphiKitTests/LiveFixtureTests.swift
import Foundation
import Testing
@testable import DelphiKit

/// Replays bytes captured from the live Worker, so the wire contract is pinned
/// by real bytes rather than by bytes this test invented. The fixtures are
/// committed as SwiftPM resources; these tests need no network.
private struct MissingFixture: Error { let name: String }

private func fixture(_ name: String, _ ext: String) throws -> Data {
    // A plain throw rather than `#require`: this is a helper outside any test
    // body, and a thrown error fails the calling test just as clearly.
    guard let url = Bundle.module.url(forResource: "Fixtures/\(name)", withExtension: ext) else {
        throw MissingFixture(name: "\(name).\(ext)")
    }
    return try Data(contentsOf: url)
}

@Test func decodesTheRealThreadBodyAndReEncodesItIdentically() throws {
    let raw = try fixture("thread_wire", "json")
    let thread = try Wire.decoder.decode(Thread.self, from: raw)
    let reEncoded = try Wire.encoder.encode(thread)

    // Compare as parsed objects, not bytes: key order is not part of the
    // contract, but the set of keys and every value is.
    let original = try JSONSerialization.jsonObject(with: raw) as! NSDictionary
    let round = try JSONSerialization.jsonObject(with: reEncoded) as! NSDictionary
    #expect(original == round)
}

@Test @MainActor func replaysTheRealSSETranscript() async throws {
    let raw = try fixture("chat_stream", "sse")
    let transport = MockTransport()
    // Feed it in small chunks to exercise the split-boundary path.
    let chunks = stride(from: 0, to: raw.count, by: 17).map { offset in
        raw[raw.index(raw.startIndex, offsetBy: offset) ..< raw.index(
            raw.startIndex, offsetBy: min(offset + 17, raw.count),
        )]
    }.map { Data($0) }
    transport.enqueueStream(status: 200, chunks: chunks)

    let stream = ChatStream(client: APIClient(
        baseURL: URL(string: "https://maxi.mystuff.website")!,
        transport: transport,
        tokens: StaticTokenProvider(token: "tok"),
        connection: ConnectionStore(),
    ))

    var deltas = ""
    var sawDone = false
    for try await event in stream.send(.init(
        model: "MiniMax-M3", messages: [], memory: false, mode: .answer,
    )) {
        switch event {
        case let .delta(text): deltas += text
        case .done: sawDone = true
        case .kb, .sources: break
        }
    }

    #expect(sawDone)
    #expect(!deltas.isEmpty)
    // The reply must survive <think> stripping as real text.
    #expect(!stripThinking(deltas).isEmpty)
}
```

Run: `bin/remote-test`
Expected: PASS, both tests.

- [ ] **Step 5: Record the finding and commit**

Add an entry to `API-NOTES.md` — a new `###` section after Spike 6, titled
`### Phase 1A — the ported client against the live Worker`. Follow the file's
conventions: name the evidence class (**live-probe-verified** for the round
trip, **http-trace-evidence** for any quoted body), print the command above each
block, mark elisions, and carry the "as of <date>, against this deployment's
configuration" caveat.

State plainly:
- that `list`, `get`, `put` and `delete` were exercised by the **ported Swift
  client** rather than by `curl`, and what each returned;
- whether the decode/encode round trip was byte-equivalent as parsed JSON, and
  if it was not, what differed and what was changed to fix it;
- that the fixtures are committed and which test replays them.

Do **not** write that sync is "verified" in general. What this establishes is
that the four thread routes round-trip correctly through this client, once, on
one account.

```bash
cd /Users/thomasb/delphi-apple
git add Package.swift Sources/LiveE2E/main.swift \
        Tests/DelphiKitTests/Fixtures/thread_wire.json \
        Tests/DelphiKitTests/Fixtures/chat_stream.sse \
        Tests/DelphiKitTests/LiveFixtureTests.swift API-NOTES.md
git commit -m "test(e2e): prove the ported client against the live Worker

Phase 1A task 11. list/get/put/delete exercised by DelphiKit itself, not curl,
with a real Access token. The captured GET body and SSE transcript are committed
as fixtures and replayed by LiveFixtureTests, so the wire contract stays pinned
by real bytes rather than by bytes a test invented.

Scope of the claim: four routes, one account, one run — not a general proof that
sync is correct."
```

---

## Definition of done for Phase 1A

- [ ] `bin/remote-test` is green and `bin/remote-build-ios` succeeds.
- [ ] Every branch of `src/state/sync.ts` has a test that cites its line.
- [ ] The refresh grant has been **posted**, not merely issued, and the outcome
      is recorded in `API-NOTES.md` under Spike 2.
- [ ] `resolveUserEmail` fails closed, with a test, committed in `delphi-chat`.
- [ ] One end-to-end pass against the real Worker has run, and its fixtures are
      committed and replayed by a test.
- [ ] No `FoundationModels` import exists anywhere in `DelphiKit`.
- [ ] Nothing in `DelphiKit` calls `/api/stt` or `/api/tts`.

**Not done, and not in scope:** app targets, any SwiftUI view, the audio stack,
titles, the `LanguageModel` conformance, and Phase 2's conflict detection. Those
are plans 1B, 1C and 1D.

## Notes for whoever writes plan 1B

Three things surfaced while planning 1A that 1B owns:

1. **The DCR orphan problem is growing, and it is 1B's entry criterion.** Two
   undeletable client registrations exist on the Access tenant, and each
   `register-client.sh` run leaves another — including any run this plan's Task
   2 or Task 11 triggers. The `revocation_endpoint` revokes *tokens*, not
   *registrations*. **1B must answer per-install versus per-user registration in
   writing, in spec §4, before it writes any registration code**, because
   per-install means unbounded accumulation with no cleanup story and the spec
   makes this a gate on the Logout section. It is deliberately not in 1A's
   definition of done: 1A registers no clients.
2. **The Keychain cannot be tested headlessly the way everything else in 1A
   can.** A `swift test` process on the build host has no entitlement, so
   data-protection Keychain calls are expected to fail there. Put the real
   Keychain behind the same protocol shape `TokenProviding` already uses, test
   the logic against a fake, and exercise the real implementation from the app
   target in 1D.
3. **`StaticTokenProvider` is the seam 1B replaces.** Nothing else in `DelphiKit`
   knows how a token is obtained, so the refresh actor drops in behind
   `TokenProviding` with no change to `APIClient`, `ThreadsAPI` or `ChatStream`.
