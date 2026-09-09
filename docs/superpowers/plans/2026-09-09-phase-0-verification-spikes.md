# Phase 0 Verification Spikes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert every ⚠️-marked claim in the Swift native client design into a
signature verified against the real iOS 27 SDK or a live Cloudflare endpoint,
recorded in `delphi-apple/API-NOTES.md` and proven by a compiling probe.

**Architecture:** Each spike produces two artifacts: a prose finding in
`API-NOTES.md`, and a Swift probe in `spikes/` that uses the API exactly as the
note claims. The probe *is* the test — if a note is wrong, the probe fails to
type-check. Probes compile against the iOS 27 SDK on `mac-mini.local` over SSH,
because the local machine has Command Line Tools only. No production code is
written in Phase 0.

**Tech Stack:** Swift 6.4, Xcode 27 / iOS 27 SDK (remote), `swift-api-digester`,
`swiftc -typecheck`, `curl`, `wrangler d1 execute`.

**Spec:** `docs/superpowers/specs/2026-09-09-swift-native-client-design.md`

## Global Constraints

- **Two repos.** Probes, notes, and scripts land in
  `Confluenceservice/delphi-apple` (private, cloned at `/Users/thomasb/delphi-apple`).
  Specs and plans stay in `Confluenceservice/delphi-chat`.
- **Deployment floor:** iOS 27.0 / macOS 27.0. Probes target
  `arm64-apple-ios27.0`.
- **Build host:** `mac-mini.local` — macOS 27.0, Xcode 27.0 (build 27A5228h),
  iOS 27.0 SDK. The local machine has Command Line Tools only and **cannot**
  compile against the iOS SDK.
- **No production code in Phase 0.** Everything under `spikes/` is throwaway and
  labelled as such.
- **A finding is not verified until a probe type-checks.** Symbol presence in an
  API dump is evidence, not proof.
- **Never commit a token, client secret, or `oauth:` value.** Spike 2 writes
  secrets to `.env.local`, which is gitignored in Task 1.

---

### Task 1: Repo scaffold and remote build tooling

Every later task depends on this. Nothing here is throwaway.

**Files:**
- Create: `/Users/thomasb/delphi-apple/README.md`
- Create: `/Users/thomasb/delphi-apple/.gitignore`
- Create: `/Users/thomasb/delphi-apple/API-NOTES.md`
- Create: `/Users/thomasb/delphi-apple/bin/remote-swift`
- Create: `/Users/thomasb/delphi-apple/bin/dump-api`
- Create: `/Users/thomasb/delphi-apple/spikes/probe000_toolchain.swift`

**Interfaces:**
- Produces: `bin/remote-swift <file.swift>` — type-checks one Swift file against
  the iOS 27 SDK on the remote host; exit 0 on success, non-zero with compiler
  diagnostics on failure. Every later task uses this as its test command.
- Produces: `bin/dump-api <ModuleName> <out.json>` — writes a
  `swift-api-digester` SDK dump for one module.

- [ ] **Step 1: Write the failing test — a probe that must compile**

```bash
mkdir -p /Users/thomasb/delphi-apple/{bin,spikes}
cat > /Users/thomasb/delphi-apple/spikes/probe000_toolchain.swift <<'EOF'
// THROWAWAY — Phase 0 spike. Proves the remote iOS 27 toolchain works.
import FoundationModels

@available(iOS 27.0, macOS 27.0, *)
func probeToolchain() {
    _ = SystemLanguageModel.self
}
EOF
```

- [ ] **Step 2: Run it to make sure it fails**

`bin/remote-swift` does not exist yet.

Run: `/Users/thomasb/delphi-apple/bin/remote-swift spikes/probe000_toolchain.swift`
Expected: FAIL — `No such file or directory`

- [ ] **Step 3: Write the minimal implementation**

```bash
cat > /Users/thomasb/delphi-apple/bin/remote-swift <<'EOF'
#!/usr/bin/env bash
# Type-check one Swift file against the iOS 27 SDK on the remote build host.
# Local machine has Command Line Tools only and has no iOS SDK.
set -euo pipefail

HOST="${REMOTE_SWIFT_HOST:-mac-mini.local}"
REMOTE_DIR="/tmp/delphi-apple-spikes"
SRC="$1"

[ -f "$SRC" ] || { echo "no such file: $SRC" >&2; exit 2; }

ssh -o BatchMode=yes "$HOST" "mkdir -p $REMOTE_DIR"
rsync -q "$SRC" "$HOST:$REMOTE_DIR/"
ssh -o BatchMode=yes "$HOST" "
  set -euo pipefail
  cd $REMOTE_DIR
  xcrun swiftc -typecheck \
    -sdk \$(xcrun --sdk iphoneos --show-sdk-path) \
    -target arm64-apple-ios27.0 \
    $(basename "$SRC")
"
echo "OK: $(basename "$SRC") type-checks against iOS 27"
EOF

cat > /Users/thomasb/delphi-apple/bin/dump-api <<'EOF'
#!/usr/bin/env bash
# Dump a framework's public API surface from the iOS 27 SDK on the build host.
# Usage: bin/dump-api FoundationModels /tmp/fm-ios27.json
set -euo pipefail

HOST="${REMOTE_SWIFT_HOST:-mac-mini.local}"
MODULE="$1"
OUT="$2"

ssh -o BatchMode=yes "$HOST" "
  set -euo pipefail
  xcrun swift-api-digester -dump-sdk -module $MODULE \
    -o /tmp/${MODULE}-ios27.json \
    -sdk \$(xcrun --sdk iphoneos --show-sdk-path) \
    -target arm64-apple-ios27.0
"
scp -q "$HOST:/tmp/${MODULE}-ios27.json" "$OUT"
echo "wrote $OUT ($(wc -c < "$OUT") bytes)"
EOF

chmod +x /Users/thomasb/delphi-apple/bin/remote-swift \
         /Users/thomasb/delphi-apple/bin/dump-api
```

- [ ] **Step 4: Run the test and make sure it passes**

Run:
```bash
cd /Users/thomasb/delphi-apple && bin/remote-swift spikes/probe000_toolchain.swift
```
Expected: `OK: probe000_toolchain.swift type-checks against iOS 27`

If it fails with `error: cannot find 'SystemLanguageModel' in scope`, the
availability annotation or the target triple is wrong — fix before continuing.
Every later task is blocked on this passing.

- [ ] **Step 5: Write the supporting files**

```bash
cat > /Users/thomasb/delphi-apple/.gitignore <<'EOF'
.DS_Store
.env.local
*.xcuserstate
xcuserdata/
DerivedData/
build/
/tmp-api-dumps/
EOF

cat > /Users/thomasb/delphi-apple/README.md <<'EOF'
# delphi-apple

Native SwiftUI client (iOS + macOS) for delphi-chat.

The design and implementation plans live in the backend repo and are the
source of truth. This repo never forks them:

- Spec: `Confluenceservice/delphi-chat` →
  `docs/superpowers/specs/2026-09-09-swift-native-client-design.md`
- Plans: `Confluenceservice/delphi-chat` → `docs/superpowers/plans/`

`API-NOTES.md` records Apple API signatures verified against the real iOS 27
SDK. Anything not in that file has not been verified.

## Build host

The iOS SDK is not installed on the primary dev machine. Probes and builds run
on `mac-mini.local` (macOS 27.0, Xcode 27.0) over SSH:

    bin/remote-swift spikes/probeNNN_name.swift
    bin/dump-api FoundationModels /tmp/fm.json

Override the host with `REMOTE_SWIFT_HOST`.

## Contract discipline

Any change to an `/api/*` request or response shape needs a matching commit in
both repos, cross-referenced by SHA. There is no schema generator.
EOF

cat > /Users/thomasb/delphi-apple/API-NOTES.md <<'EOF'
# Verified Apple API Notes

Every entry here was verified against the **iOS 27.0 SDK** (Xcode 27.0, build
27A5228h) on `mac-mini.local`, and is backed by a probe in `spikes/` that
type-checks. Symbol presence in an API dump is evidence, not proof — only a
compiling probe promotes a claim to verified.

Format per entry: claim, verdict, exact signature, probe file, spec impact.

## Status

| Spike | Claim | Verdict |
|---|---|---|
| 1 | `LanguageModel` / `LanguageModelExecutor` can wrap an HTTP backend | pending |
| 2 | Access Managed OAuth yields `Cf-Access-Jwt-Assertion` at origin | pending |
| 3 | `contextSize` / `tokenCount(for:)` exist and are usable for budgeting | pending |
| 4 | Foundation Models vision support | pending |
| 5 | `@Generable` extraction beats `parseFactsJson` | pending |
| 6 | Private Cloud Compute usable by third-party apps | pending |

## Entries

_None yet._
EOF
```

- [ ] **Step 6: Commit**

```bash
cd /Users/thomasb/delphi-apple
git add -A
git commit -m "chore: scaffold repo with remote iOS 27 build tooling

Local machine has Command Line Tools only, so probes type-check against
the iOS 27 SDK on mac-mini.local over SSH. bin/remote-swift is the test
command for every Phase 0 spike.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push -u origin main
```

---

### Task 2: Spike 2 — Access Managed OAuth end-to-end

Ordered first because it needs no Swift, no Xcode, and no Apple API, and it
de-risks the whole of spec §4. If Managed OAuth does not deliver
`Cf-Access-Jwt-Assertion` to the origin, the native client cannot call any of
the 24 routes and the design needs rework before a line of Swift is written.

**Files:**
- Create: `/Users/thomasb/delphi-apple/spikes/oauth/authorize-url.sh`
- Create: `/Users/thomasb/delphi-apple/spikes/oauth/exchange.sh`
- Create: `/Users/thomasb/delphi-apple/spikes/oauth/verify-identity.sh`
- Modify: `/Users/thomasb/delphi-apple/API-NOTES.md`

**Interfaces:**
- Consumes: nothing from Task 1 except the repo and `.gitignore`.
- Produces: a verified answer to "does a Bearer `oauth:` token reach
  `worker/auth.ts:93` as a real user identity?" — recorded in `API-NOTES.md`.

- [ ] **Step 1: Human step — create the OAuth client**

This cannot be scripted. In the Cloudflare Zero Trust dashboard, on the Access
application protecting the app's domain, enable **Managed OAuth** and add a
client with redirect URI `https://<app-domain>/oauth/callback/delphi-apple`.

Record the issued client ID into `.env.local` (gitignored):

```bash
cat > /Users/thomasb/delphi-apple/.env.local <<'EOF'
APP_DOMAIN=<your-app-domain>
TEAM_DOMAIN=https://<your-team>.cloudflareaccess.com
OAUTH_CLIENT_ID=<client-id-from-dashboard>
OAUTH_REDIRECT_URI=https://<your-app-domain>/oauth/callback/delphi-apple
EOF
```

Fill the three placeholders from the dashboard and from `wrangler.toml`
(`routes.pattern` is the app domain). Do not commit this file.

- [ ] **Step 2: Write the failing test — verify identity with no token**

```bash
mkdir -p /Users/thomasb/delphi-apple/spikes/oauth
cat > /Users/thomasb/delphi-apple/spikes/oauth/verify-identity.sh <<'EOF'
#!/usr/bin/env bash
# THROWAWAY — Phase 0 spike 2.
# Calls an Access-protected route with a Managed OAuth bearer token and reports
# the HTTP status. Pass the token as $1, or set ACCESS_TOKEN.
set -euo pipefail
source "$(dirname "$0")/../../.env.local"
TOKEN="${1:-${ACCESS_TOKEN:-}}"

curl -s -o /tmp/spike2-body.json -w '%{http_code}\n' \
  -H "Authorization: Bearer ${TOKEN}" \
  "https://${APP_DOMAIN}/api/threads"
EOF
chmod +x /Users/thomasb/delphi-apple/spikes/oauth/verify-identity.sh
```

- [ ] **Step 3: Run it to make sure it fails**

Run:
```bash
cd /Users/thomasb/delphi-apple && spikes/oauth/verify-identity.sh not-a-real-token
```
Expected: `302` or `403` — Access rejects the request. **A `200` here is a
finding, not a pass**: it would mean the deployment is falling through to
`DEV_USER_EMAIL` (`worker/auth.ts:100`) and is currently open. Stop and record
that as a security finding before continuing.

- [ ] **Step 4: Implement the PKCE flow**

```bash
cat > /Users/thomasb/delphi-apple/spikes/oauth/authorize-url.sh <<'EOF'
#!/usr/bin/env bash
# THROWAWAY — Phase 0 spike 2. Prints an authorize URL and saves the verifier.
set -euo pipefail
source "$(dirname "$0")/../../.env.local"

VERIFIER=$(openssl rand -base64 60 | tr -d '\n=+/' | cut -c1-64)
CHALLENGE=$(printf '%s' "$VERIFIER" | openssl dgst -binary -sha256 \
  | openssl base64 | tr '+/' '-_' | tr -d '=\n')
STATE=$(openssl rand -hex 16)

printf '%s' "$VERIFIER" > /tmp/spike2-verifier
printf '%s' "$STATE"    > /tmp/spike2-state

echo "Open this URL in a browser, sign in, then copy the ?code= value:"
echo
echo "${TEAM_DOMAIN}/cdn-cgi/access/sso/oauth2/authorize?response_type=code&client_id=${OAUTH_CLIENT_ID}&redirect_uri=${OAUTH_REDIRECT_URI}&state=${STATE}&code_challenge=${CHALLENGE}&code_challenge_method=S256"
EOF

cat > /Users/thomasb/delphi-apple/spikes/oauth/exchange.sh <<'EOF'
#!/usr/bin/env bash
# THROWAWAY — Phase 0 spike 2. Exchanges an authorization code for a token.
set -euo pipefail
source "$(dirname "$0")/../../.env.local"
CODE="$1"
VERIFIER=$(cat /tmp/spike2-verifier)

curl -s -X POST "${TEAM_DOMAIN}/cdn-cgi/access/sso/oauth2/token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "code=${CODE}" \
  --data-urlencode "client_id=${OAUTH_CLIENT_ID}" \
  --data-urlencode "redirect_uri=${OAUTH_REDIRECT_URI}" \
  --data-urlencode "code_verifier=${VERIFIER}"
echo
EOF

chmod +x /Users/thomasb/delphi-apple/spikes/oauth/authorize-url.sh \
         /Users/thomasb/delphi-apple/spikes/oauth/exchange.sh
```

The exact authorize and token paths are the one unverified part of this task.
If they 404, find the real ones from the Access application's OIDC discovery
document and correct both scripts:

```bash
source /Users/thomasb/delphi-apple/.env.local
curl -s "${TEAM_DOMAIN}/cdn-cgi/access/sso/oauth2/.well-known/openid-configuration" | head -40
```

- [ ] **Step 5: Run the flow and verify identity reaches the origin**

```bash
cd /Users/thomasb/delphi-apple
spikes/oauth/authorize-url.sh          # open URL, sign in, copy the code
spikes/oauth/exchange.sh <code>        # prints JSON with access_token
spikes/oauth/verify-identity.sh <access_token>
```
Expected: `200`, and `/tmp/spike2-body.json` contains the signed-in user's
threads.

Then confirm the origin saw the *right* identity — the audit log is more
reliable than `wrangler tail`:

```bash
cd /Users/thomasb/delphi-chat
npx wrangler d1 execute minimax-chat-memory --remote \
  --command "SELECT user_email, method, path, status, ts FROM audit_log ORDER BY ts DESC LIMIT 5"
```
Expected: a `GET /api/threads` row with **your real email**, not `DEV_USER_EMAIL`.

- [ ] **Step 6: Record the finding and commit**

Append to `API-NOTES.md` under `## Entries`: the working authorize/token URLs,
the observed `expires_in`, the token prefix format, whether refresh tokens are
issued, and the exact audit-log row proving identity. Flip spike 2's row in the
status table to `verified` or `blocked`.

```bash
cd /Users/thomasb/delphi-apple
git add API-NOTES.md spikes/oauth
git commit -m "spike(2): verify Access Managed OAuth reaches origin identity

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push
```

---

### Task 3: Spike 1 — `LanguageModel` protocol shape

**Files:**
- Create: `/Users/thomasb/delphi-apple/spikes/probe001_language_model.swift`
- Modify: `/Users/thomasb/delphi-apple/API-NOTES.md`

**Interfaces:**
- Consumes: `bin/remote-swift`, `bin/dump-api` from Task 1.
- Produces: the decision recorded in `API-NOTES.md` — whether spec §2's
  `WorkerLanguageModel` conformance is built on Apple's `LanguageModel`
  protocol or on a plain Swift protocol.

- [ ] **Step 1: Extract the real signatures**

```bash
cd /Users/thomasb/delphi-apple
bin/dump-api FoundationModels /tmp/fm-ios27.json
python3 - <<'EOF'
import json
d = json.load(open('/tmp/fm-ios27.json'))
def walk(n, depth=0):
    name = n.get('printedName') or n.get('name') or ''
    kind = n.get('declKind') or n.get('kind') or ''
    if any(k in name for k in ('LanguageModel', 'Executor')):
        print(f"{'  '*depth}{kind:16} {name}")
    for c in n.get('children', []):
        walk(c, depth+1)
walk(d)
EOF
```

Read the output. The protocol requirements it prints are the contract the probe
must satisfy.

- [ ] **Step 2: Write the failing probe**

Write `spikes/probe001_language_model.swift` declaring a struct that conforms to
`LanguageModel` and an executor conforming to `LanguageModelExecutor`, using the
associated types, initializers, and methods printed in Step 1. The body may
`fatalError()` — this probe tests that the *shape* compiles, not that it runs.
Mark it `// THROWAWAY — Phase 0 spike 1.` and gate it with
`@available(iOS 27.0, macOS 27.0, *)`.

The probe must exercise three things, because these are what spec §2 depends on:
async streaming output, cancellation, and construction of a
`LanguageModelSession` backed by the custom conformance.

- [ ] **Step 3: Run it to make sure it fails**

Run: `bin/remote-swift spikes/probe001_language_model.swift`
Expected: FAIL, listing unimplemented protocol requirements. Those diagnostics
are the real contract — better than any documentation.

- [ ] **Step 4: Satisfy the requirements until it passes**

Add the missing members named by the compiler. Do not guess; each error names
exactly what is missing.

Run: `bin/remote-swift spikes/probe001_language_model.swift`
Expected: `OK: probe001_language_model.swift type-checks against iOS 27`

- [ ] **Step 5: Record the finding and commit**

In `API-NOTES.md`, record the full protocol requirement list, the streaming
type, and a one-line verdict: **can a custom conformance wrap an HTTP backend,
yes or no.** If no, note what blocks it — spec §2 then falls back to a plain
Swift protocol, and spec §6 Phase 4 loses its "new conformance" cheapness.

```bash
cd /Users/thomasb/delphi-apple
git add API-NOTES.md spikes/probe001_language_model.swift
git commit -m "spike(1): verify LanguageModel protocol shape against iOS 27 SDK

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push
```

---

### Task 4: Spike 3 — context budget API

Spec §2 requires refusing a local turn when the prompt alone exceeds budget.
That requires both `contextSize` and `tokenCount(for:)` to be callable before
generation starts.

**Files:**
- Create: `/Users/thomasb/delphi-apple/spikes/probe003_context_budget.swift`
- Modify: `/Users/thomasb/delphi-apple/API-NOTES.md`

**Interfaces:**
- Consumes: `bin/remote-swift`, and the availability pattern proven in Task 1.
- Produces: the exact budgeting call sequence spec §2 will implement.

- [ ] **Step 1: Extract the signatures**

```bash
cd /Users/thomasb/delphi-apple
[ -f /tmp/fm-ios27.json ] || bin/dump-api FoundationModels /tmp/fm-ios27.json
python3 - <<'EOF'
import json
d = json.load(open('/tmp/fm-ios27.json'))
def walk(n):
    name = n.get('printedName') or ''
    if any(k in name for k in ('contextSize', 'tokenCount', 'availability', 'Availability')):
        print(f"{n.get('declKind') or n.get('kind'):16} {name}")
    for c in n.get('children', []):
        walk(c)
walk(d)
EOF
```

- [ ] **Step 2: Write the failing probe**

`spikes/probe003_context_budget.swift` must, using only the signatures from
Step 1:

1. switch exhaustively over `SystemLanguageModel.availability` and its
   unavailable-reason cases,
2. read `contextSize`,
3. call `tokenCount(for:)` on a prompt string,
4. compute `contextSize - promptTokens - replyReserve` and return a Bool.

Mark `// THROWAWAY — Phase 0 spike 3.`

- [ ] **Step 3: Run it to make sure it fails**

Run: `bin/remote-swift spikes/probe003_context_budget.swift`
Expected: FAIL — wrong member names, wrong types, or a non-exhaustive switch.

- [ ] **Step 4: Correct until it passes**

Run: `bin/remote-swift spikes/probe003_context_budget.swift`
Expected: `OK: probe003_context_budget.swift type-checks against iOS 27`

- [ ] **Step 5: Record the finding and commit**

Record in `API-NOTES.md`: whether `contextSize` is a constant or per-session,
whether `tokenCount(for:)` is throwing or async, the enumerated unavailability
reasons, and the **measured** context size on this SDK. The spec asserts 4,096;
if the SDK reports something else, say so — that changes spec §2's whole
premise and must be raised, not quietly absorbed.

```bash
cd /Users/thomasb/delphi-apple
git add API-NOTES.md spikes/probe003_context_budget.swift
git commit -m "spike(3): verify context budget API and measured context size

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push
```

---

### Task 5: Spike 4 — vision support

Spec §2 routes every image turn to the Worker on the assumption that Foundation
Models is text-only. If that is wrong, the routing table gets simpler.

**Files:**
- Create: `/Users/thomasb/delphi-apple/spikes/probe004_vision.swift`
- Modify: `/Users/thomasb/delphi-apple/API-NOTES.md`

**Interfaces:**
- Consumes: `bin/remote-swift`.
- Produces: a yes/no that either confirms or deletes the "images → Worker" row
  in spec §2's routing table.

- [ ] **Step 1: Search the dump for image-capable prompt types**

```bash
cd /Users/thomasb/delphi-apple
[ -f /tmp/fm-ios27.json ] || bin/dump-api FoundationModels /tmp/fm-ios27.json
python3 - <<'EOF'
import json
d = json.load(open('/tmp/fm-ios27.json'))
def walk(n):
    name = n.get('printedName') or ''
    if any(k in name.lower() for k in ('image', 'vision', 'multimodal', 'cgimage', 'attachment')):
        print(f"{n.get('declKind') or n.get('kind'):16} {name}")
    for c in n.get('children', []):
        walk(c)
walk(d)
EOF
```

- [ ] **Step 2: Write the probe**

If Step 1 returns image-capable prompt types, write
`spikes/probe004_vision.swift` constructing a prompt containing an image using
those exact types. If Step 1 returns nothing, write the probe as a documented
negative: a comment recording the exact search performed and its empty result,
plus a text-only prompt construction that compiles, so the file still builds.

- [ ] **Step 3: Run it**

Run: `bin/remote-swift spikes/probe004_vision.swift`
Expected: PASS in both the positive and negative case — the probe encodes
whichever reality Step 1 found.

- [ ] **Step 4: Record the finding and commit**

`API-NOTES.md` gets an explicit verdict: **vision supported / not supported**,
with the search that established it. Update spec §2's routing table in
`delphi-chat` in the same session if the answer is "supported", and reference
that commit's SHA here.

```bash
cd /Users/thomasb/delphi-apple
git add API-NOTES.md spikes/probe004_vision.swift
git commit -m "spike(4): determine Foundation Models vision support

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push
```

---

### Task 6: Spike 6 — Private Cloud Compute availability

The dump already shows 355 `PrivateCloudCompute*` symbol occurrences, which
contradicts the "severely limited for third-party developers" report the spec
cites. This task settles it.

**Files:**
- Create: `/Users/thomasb/delphi-apple/spikes/probe006_pcc.swift`
- Modify: `/Users/thomasb/delphi-apple/API-NOTES.md`

**Interfaces:**
- Consumes: `bin/remote-swift`, and the session construction proven in Task 3.
- Produces: the decision on whether PCC stays Phase 4 or is promoted.

- [ ] **Step 1: Extract the PCC surface**

```bash
cd /Users/thomasb/delphi-apple
[ -f /tmp/fm-ios27.json ] || bin/dump-api FoundationModels /tmp/fm-ios27.json
python3 - <<'EOF'
import json
d = json.load(open('/tmp/fm-ios27.json'))
seen = set()
def walk(n):
    name = n.get('printedName') or ''
    if 'PrivateCloudCompute' in name and name not in seen:
        seen.add(name)
        print(f"{n.get('declKind') or n.get('kind'):16} {name}")
    for c in n.get('children', []):
        walk(c)
walk(d)
EOF
```

- [ ] **Step 2: Write the failing probe**

`spikes/probe006_pcc.swift` constructs a `LanguageModelSession` backed by the
PCC model using the exact types from Step 1, reads its `contextSize`, and
switches over its availability cases. Mark `// THROWAWAY — Phase 0 spike 6.`

- [ ] **Step 3: Run it to make sure it fails**

Run: `bin/remote-swift spikes/probe006_pcc.swift`
Expected: FAIL initially — wrong initializer or availability shape.

- [ ] **Step 4: Correct until it passes**

Run: `bin/remote-swift spikes/probe006_pcc.swift`
Expected: `OK: probe006_pcc.swift type-checks against iOS 27`

A compile failure that cannot be resolved — for example a required entitlement
the SDK will not accept, or an unavailable initializer — **is the finding**.
Record it and stop; do not work around it.

- [ ] **Step 5: Record the finding and commit**

`API-NOTES.md` records: PCC context size as reported by the SDK, any entitlement
in the type's availability annotations, the availability cases, and a verdict on
whether spec §6 Phase 4 should be promoted. Note explicitly that type-checking
proves the API exists, **not** that requests succeed at runtime or that the free
tier applies — those need a device test, which is out of Phase 0 scope.

```bash
cd /Users/thomasb/delphi-apple
git add API-NOTES.md spikes/probe006_pcc.swift
git commit -m "spike(6): determine Private Cloud Compute availability to third-party apps

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push
```

---

### Task 7: Spike 5 — `@Generable` extraction quality

The heaviest spike, and the only one that measures behaviour rather than shape.
Spec §2 replaces `worker/memory.ts`'s JSON-parsing extractor with `@Generable`
guided generation; `parseFactsJson` returns empty on failure, so a regression
here degrades memory silently.

**Files:**
- Create: `/Users/thomasb/delphi-apple/spikes/probe005_extraction.swift`
- Create: `/Users/thomasb/delphi-apple/spikes/fixtures/threads.json`
- Modify: `/Users/thomasb/delphi-apple/API-NOTES.md`

**Interfaces:**
- Consumes: `bin/remote-swift` for the type-check; a real device or macOS run
  for the measurement.
- Produces: a go/no-go on moving memory extraction on-device.

- [ ] **Step 1: Export real thread fixtures**

```bash
mkdir -p /Users/thomasb/delphi-apple/spikes/fixtures
cd /Users/thomasb/delphi-chat
npx wrangler d1 execute minimax-chat-memory --remote --json \
  --command "SELECT thread_id, role, content FROM messages ORDER BY thread_id, seq LIMIT 400" \
  > /Users/thomasb/delphi-apple/spikes/fixtures/threads.json
```

Review the file before committing it. It contains real conversation content in a
repo that is private but shared — redact anything that should not live there,
or reduce the `LIMIT` until the sample is safe.

- [ ] **Step 2: Capture the current extractor's baseline**

Read `worker/memory.ts` and record, in `API-NOTES.md`, the exact extraction
prompt and the JSON shape `parseFactsJson` expects. The `@Generable` struct must
produce the same fact shape, or `POST /api/memory/ingest` breaks.

- [ ] **Step 3: Write the failing probe**

`spikes/probe005_extraction.swift` declares a `@Generable` struct mirroring that
fact shape, loads `fixtures/threads.json`, and runs guided generation per
thread. Mark `// THROWAWAY — Phase 0 spike 5.`

- [ ] **Step 4: Run it to make sure it fails, then passes**

Run: `bin/remote-swift spikes/probe005_extraction.swift`
Expected: FAIL first on `@Generable` macro requirements, then
`OK: probe005_extraction.swift type-checks against iOS 27`

- [ ] **Step 5: Measure, don't assume**

Run the probe as an executable on `mac-mini.local` against the fixtures. For
each thread, record: facts extracted, malformed outputs, and wall-clock time.
Compare against the same threads' existing rows:

```bash
cd /Users/thomasb/delphi-chat
npx wrangler d1 execute minimax-chat-memory --remote \
  --command "SELECT COUNT(*) AS facts, user_email FROM memory_facts GROUP BY user_email"
```

- [ ] **Step 6: Record the verdict and commit**

`API-NOTES.md` gets a table: fact count, malformed rate, and latency for both
extractors. The verdict is **go only if on-device extraction is at least as good
as the current one.** "Roughly similar" is a no-go — the current extractor's
silent-empty failure mode means a regression would not be noticed in production.

```bash
cd /Users/thomasb/delphi-apple
git add API-NOTES.md spikes/probe005_extraction.swift spikes/fixtures/threads.json
git commit -m "spike(5): measure @Generable extraction against current extractor

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push
```

---

### Task 8: Reconcile the spec with the findings

Phase 0's actual deliverable is a spec that no longer contains unverified
claims. This task is not optional bookkeeping — Phase 1 reads the spec, not
`API-NOTES.md`.

**Files:**
- Modify: `/Users/thomasb/delphi-chat/docs/superpowers/specs/2026-09-09-swift-native-client-design.md`
- Modify: `/Users/thomasb/delphi-apple/API-NOTES.md`

**Interfaces:**
- Consumes: all six verdicts from Tasks 2–7.
- Produces: a spec with zero ⚠️ markers, and an explicit go/no-go for Phase 1.

- [ ] **Step 1: Confirm every spike has a verdict**

```bash
grep -n "pending" /Users/thomasb/delphi-apple/API-NOTES.md
```
Expected: no output. Any `pending` row means Phase 0 is not done.

- [ ] **Step 2: Remove each ⚠️ from the spec**

```bash
grep -n "⚠️" /Users/thomasb/delphi-chat/docs/superpowers/specs/2026-09-09-swift-native-client-design.md
```

Replace each marked claim with the verified fact and a reference to the probe
that proves it. A claim that came back **false** does not get deleted quietly —
rewrite the affected section and note what changed, so the next reader sees the
correction rather than a design that silently shifted.

- [ ] **Step 3: Re-check the design against contradicted claims**

For each falsified claim, confirm the sections that depended on it still hold:

| If falsified | Re-examine |
|---|---|
| `LanguageModel` cannot wrap HTTP | §2 conformance architecture, §6 Phase 4 |
| Context size ≠ 4,096 | §2 budget enforcement, the whole local-prompt premise |
| Vision supported | §2 routing table |
| PCC usable | §6 phase order — Phase 4 may move earlier |
| Extraction worse | §2 "FM jobs that run on every route" |
| Managed OAuth broken | §4 entirely; Phase 1 is blocked |

This is a design change, not friction. If any row fires, stop and re-plan that
section rather than patching around it.

- [ ] **Step 4: Commit both repos, cross-referenced**

```bash
cd /Users/thomasb/delphi-chat
git add docs/superpowers/specs/2026-09-09-swift-native-client-design.md
git commit -m "docs: reconcile Swift client spec with Phase 0 findings

All six Phase 0 spikes resolved; no unverified claims remain. Probes in
Confluenceservice/delphi-apple back every signature.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push
```

Then record that SHA in `API-NOTES.md`, commit, and push `delphi-apple`.

- [ ] **Step 5: State the Phase 1 go/no-go**

Write the recommendation at the top of `API-NOTES.md`: proceed to Phase 1, or
which spec section needs redesign first. Phase 1 does not start until this line
exists.

---

## Notes for the executor

- **Never invent an Apple API.** Every signature comes from the dump or a
  compiler diagnostic. If neither has it, the answer is "not available", and
  that is a finding worth recording.
- **A failing probe is a result, not a blocker.** The point of Phase 0 is to
  find falsified claims cheaply.
- **`bin/remote-swift` is the only test command** for Swift tasks. If it breaks,
  fix Task 1 before continuing.
- The spec's own §6 lists spike 2 as the one to do first. This plan orders it
  that way; keep it there.
