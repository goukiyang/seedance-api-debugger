# Ultimate Canvas Local SD2 Live Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in localhost runtime that logs an ordinary user into SD2 and exercises the real Ultimate Canvas upload, generation, persistence, and polling APIs through a fixed same-origin proxy.

**Architecture:** Keep local canvas assets and existing relative endpoint contracts. Extract a small streaming reverse-proxy module with a strict canvas API allowlist, then let the preview server select default, Mock, or fixed-origin SD2 live mode and provide a localhost login bridge.

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
