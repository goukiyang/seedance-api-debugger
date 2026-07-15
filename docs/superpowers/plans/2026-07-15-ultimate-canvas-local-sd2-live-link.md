# Ultimate Canvas Local SD2 Live Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in localhost runtime that logs an ordinary user into SD2 and exercises the real Ultimate Canvas upload, generation, persistence, and polling APIs through a fixed same-origin proxy.

**Architecture:** Keep local canvas assets and existing relative endpoint contracts. Use a strict streaming proxy for canvas APIs, and relay a state-validated, single-use Feishu authorization code from the deployed callback to an exact loopback callback where the existing SD2 `login-by-code` endpoint creates the localhost session.

**Tech Stack:** Node.js `http`/`https`, existing static Ultimate Canvas JavaScript, Next.js 14 SD2 APIs, TypeScript smoke scripts.

## Global Constraints

- Target branch: `teammate/ultimate-canvas-complete`.
- Backend origin: `https://sd2.youdoodesign.com`.
- Keep the existing canvas and generation payloads; do not create a second flow.
- All model calls go through SD2 APIs; do not use third-party keys.
- Use ordinary account authentication; do not introduce admin bypasses.
- Do not read or modify `.env`, admin API settings, provider secrets, credits core logic, or database schema.
- Default local preview must remain unable to spend points.
- Automated verification must not submit paid text, image, or video generation.

---

### Task 1: Streaming SD2 Proxy Contract

**Files:**
- Create: `scripts/lib/ultimate-canvas-sd2-proxy.mjs`
- Create: `scripts/ultimate-canvas-sd2-live-proxy-smoke.ts`

**Interfaces:**
- Produces: `SD2_CANVAS_PROXY_PATHS`, `isAllowedSd2CanvasPath(pathname)`, and `proxySd2CanvasRequest(request, response, options)`.
- Consumes: a fixed `origin`, Node `IncomingMessage`, and `ServerResponse`.

- [ ] **Step 1: Write the failing proxy smoke test**

Create a fake upstream server and assert that login returns an unchanged `Set-Cookie`, a later request forwards `session=live-token`, POST payload and query survive, a ranged media response remains 206, and `/api/admin/settings` is rejected without reaching upstream.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx tsx scripts/ultimate-canvas-sd2-live-proxy-smoke.ts`  
Expected: FAIL because `scripts/lib/ultimate-canvas-sd2-proxy.mjs` does not exist.

- [ ] **Step 3: Implement the minimal allowlist and streaming proxy**

Implement exact prefix matching, select `http` or `https` from the configured origin, rewrite `host`, `origin`, and `referer`, remove hop-by-hop headers, stream both directions, preserve status/headers, and return JSON 502 only on transport failure.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npx tsx scripts/ultimate-canvas-sd2-live-proxy-smoke.ts`  
Expected: `ultimate-canvas-sd2-live-proxy-smoke passed`.

### Task 2: Opt-in Preview Server Live Mode

**Files:**
- Modify: `scripts/ultimate-canvas-preview-server.mjs`
- Modify: `scripts/ultimate-canvas-preview-no-generation-smoke.ts`
- Modify: `scripts/ultimate-canvas-preview-api-smoke.ts`

**Interfaces:**
- Consumes: `proxySd2CanvasRequest()` from Task 1.
- Produces: CLI flag `--sd2-live`, local route `/__sd2-login`, and unchanged default/Mock behavior.

- [ ] **Step 1: Extend preview smoke tests before implementation**

Assert that conflicting `--mock-generation --sd2-live` flags fail, default bootstrap remains `preview`, Mock bootstrap remains `mock`, and source wiring pins live mode to `https://sd2.youdoodesign.com` with no Mock fallback.

- [ ] **Step 2: Run both preview tests and verify RED**

Run: `npx tsx scripts/ultimate-canvas-preview-no-generation-smoke.ts; npx tsx scripts/ultimate-canvas-preview-api-smoke.ts`  
Expected: FAIL on missing live-mode assertions.

- [ ] **Step 3: Add mode selection, login page, and proxy dispatch**

Parse `--sd2-live`, reject conflicting flags, redirect unauthenticated canvas HTML requests to `/__sd2-login`, render an account/password form posting to proxied `/api/auth/login`, proxy only allowed paths before local fixture routing, and label startup output `SD2 LIVE`.

- [ ] **Step 4: Run preview and proxy tests and verify GREEN**

Run: `npx tsx scripts/ultimate-canvas-sd2-live-proxy-smoke.ts; npx tsx scripts/ultimate-canvas-preview-no-generation-smoke.ts; npx tsx scripts/ultimate-canvas-preview-api-smoke.ts`  
Expected: all three scripts pass.

### Task 3: Documentation and End-to-End Verification

**Files:**
- Modify: `docs/handoffs/ultimate-canvas-implementation-report.md`

**Interfaces:**
- Documents: `node scripts/ultimate-canvas-preview-server.mjs 4402 --sd2-live` and the no-paid-generation verification boundary.

- [ ] **Step 1: Update the handoff report**

Record every changed file, commands and results, whether a real login/bootstrap/save/upload was exercised, whether generation was submitted, point consumption, protected areas untouched, remaining risks, and deployment notes.

- [ ] **Step 2: Run all automated verification**

Run all `scripts/ultimate-canvas-*-smoke.ts`, `npx tsc --noEmit --pretty false`, JavaScript syntax checks, `npm run lint`, `npm run build`, and `git diff --check`.  
Expected: all commands exit 0; lint may retain only pre-existing warnings.

- [ ] **Step 3: Run browser verification without paid generation**

Start live mode on an unused port, log in through `/__sd2-login`, open the canvas, and verify `SD2 真实后端`, real project/video-card data, point balance, asset library, upload, and save/restore. Do not click a text/image/video submit action.

- [ ] **Step 4: Final diff and safety audit**

Confirm no `.env`, admin settings, provider secrets, credits core files, or schema files changed; confirm the default preview still returns `REAL_BACKEND_REQUIRED` for generation.

### Task 4: Feishu Loopback Login Relay

**Files:**
- Create: `src/lib/auth/feishu-local-relay.ts`
- Create: `scripts/ultimate-canvas-feishu-local-relay-smoke.ts`
- Modify: `src/app/api/auth/feishu/callback/route.ts`
- Modify: `scripts/lib/ultimate-canvas-sd2-proxy.mjs`
- Modify: `scripts/ultimate-canvas-preview-server.mjs`
- Modify: `scripts/ultimate-canvas-preview-no-generation-smoke.ts`

**Interfaces:**
- Produces: `parseFeishuLocalRelay(next)` and `buildFeishuLocalCallbackUrl(relay, result)` for the deployed callback.
- Consumes: the existing OAuth state and `/api/auth/feishu/login-by-code` endpoint.
- Produces: local routes `/__sd2-login` and `/__sd2-feishu-callback`, a browser-bound relay nonce, and a one-time exchange permit for strict proxy access to `/api/auth/feishu/login-by-code`.

- [x] **Step 1: Write failing loopback and preview tests**

Assert that only `http://127.0.0.1:<1024-65535>/__sd2-feishu-callback`, `localhost`, and `::1` are accepted; external hosts, HTTPS, user info, fragments, wrong paths, and invalid ports are rejected. Assert that the deployed callback relays only after state verification, the local login page points to deployed Feishu authorize, the callback removes the code from history before exchange, and the proxy permits only `login-by-code` from the Feishu auth family.

- [x] **Step 2: Run focused tests and verify RED**

Run: `npx tsx scripts/ultimate-canvas-feishu-local-relay-smoke.ts; npx tsx scripts/ultimate-canvas-preview-no-generation-smoke.ts; npx tsx scripts/ultimate-canvas-sd2-live-proxy-smoke.ts`
Expected: FAIL because the relay helper, callback branch, Feishu login UI, and allowlist entry do not exist.

- [x] **Step 3: Implement the minimal state-validated relay**

Add a pure strict loopback parser/builder, branch in the deployed callback before `loginWithFeishuCode`, relay cancellation errors locally when state is valid, and add the primary Feishu login link and no-referrer local callback page. Bind the callback to the initiating local browser with a five-minute host-only `HttpOnly` cookie and in-memory nonce. After that binding is consumed, issue a separate 60-second one-time permit and require exact local Host/Origin, `POST`, `application/json`, and the permit before proxying JSON `{ code }` to SD2. Remove the query from browser history immediately, strip the local permit before forwarding, and never log code/session values.

- [x] **Step 4: Run focused tests and verify GREEN**

Run the three focused smoke scripts, `npx tsc --noEmit --pretty false`, both changed-file syntax checks, and `git diff --check`.
Expected: every command exits 0.

### Task 5: Authenticated Browser Acceptance and Final Report

**Files:**
- Modify: `docs/handoffs/ultimate-canvas-implementation-report.md`

**Interfaces:**
- Verifies: deployed Feishu callback support, localhost session establishment, real SD2 bootstrap/data/upload/save/restore, and zero paid generation.

- [ ] **Step 1: Deploy or confirm the callback commit is live**

Verify the deployed SD2 authorize/callback path contains the loopback relay support before attempting localhost login.

- [ ] **Step 2: Complete Feishu login through localhost**

Start `node scripts/ultimate-canvas-preview-server.mjs 4402 --sd2-live`, use the Feishu button, return through `/__sd2-feishu-callback`, and confirm the browser reaches the canvas with `SD2 真实后端`.

- [ ] **Step 3: Verify real non-generation workflows**

Confirm real project/video-card context, point balance, asset library, one permitted upload, document save, reload, and restore. Do not click text, image, or video generation submit.

- [ ] **Step 4: Finalize the implementation report and verification**

Record live actions, whether any generation ran, exact point consumption, all automated commands, lint environment caveat if still present, protected files untouched, deployment dependency, remaining risks, and final commit range.
