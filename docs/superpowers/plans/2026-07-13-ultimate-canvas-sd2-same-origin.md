# Ultimate Canvas SD2 Same-Origin Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the existing Ultimate Canvas so its deployed SD2 build uses only authenticated same-origin business APIs, clearly distinguishes real SD2 from the local Mock preview, and is ready for ordinary-account production acceptance.

**Architecture:** Keep the current canvas UI and relative `/api/...` request flow. Add one small browser-side backend contract module that validates API endpoints against the current origin, centralizes authentication/permission error copy, and derives the visible backend mode; then wire existing bootstrap, generation, upload, save, and polling paths through that contract. The SD2 bootstrap route reports a non-secret runtime marker, while the local preview server reports `mock` explicitly.

**Tech Stack:** Next.js 14 App Router, TypeScript, browser JavaScript modules, Node.js smoke tests via `tsx`, existing SD2 authentication/project/video-card/credits/provider services.

## Global Constraints

- Target branch: `teammate/ultimate-canvas-complete`.
- Target origin: `https://sd2.youdoodesign.com`.
- Keep the current Ultimate Canvas UI and node workflow; do not create a second canvas or generation flow.
- All model calls must use SD2 business APIs; no third-party API key, custom provider URL, or browser-side token.
- Ordinary logged-in accounts must work without admin elevation.
- Do not read or modify `.env`, admin API settings, provider secret configuration, credits core logic, or database schema.
- Keep `scripts/ultimate-canvas-preview-server.mjs` as a local no-points Mock server; do not use it as production proof.
- Automated verification must not create paid image or video tasks.
- Real paid generation is triggered only by an explicit user click in the deployed SD2 page and must be recorded in the implementation report.

---

## File Structure

- Create `public/tools/ultimate-canvas/backend-contract.js`: pure endpoint, backend-mode, and request-error boundary helpers usable in browser and Node tests.
- Create `scripts/smoke/ultimate-canvas-same-origin-backend-smoke.ts`: focused regression coverage for endpoint policy, script order, runtime markers, and production/Mock separation.
- Modify `public/tools/ultimate-canvas/index.html`: load the backend contract before generation and app scripts.
- Modify `public/tools/ultimate-canvas/generation-api.js`: sanitize configured endpoints before fallback submission.
- Modify `public/tools/ultimate-canvas/app.js`: route capability endpoints, status polling, JSON requests, visible backend status, and HTTP errors through the contract.
- Modify `src/app/api/tools/ultimate-canvas/bootstrap/route.ts`: expose the non-secret SD2 same-origin runtime marker.
- Modify `src/app/api/tools/ultimate-canvas/generate/route.ts`: replace admin-directed provider configuration copy with ordinary-user-safe copy.
- Modify `scripts/ultimate-canvas-preview-server.mjs`: expose `backend.mode = "mock"` in local bootstrap payloads.
- Modify `scripts/smoke/ultimate-canvas-preview-api-smoke.ts`: assert the preview server identifies itself as Mock.
- Modify `scripts/smoke/ultimate-canvas-normal-user-access-smoke.ts`: lock the ordinary-user-safe error and real backend marker.
- Modify `docs/handoffs/ultimate-canvas-implementation-report.md`: record files, commands, live calls, points, protected areas, remaining deployment work, and risks.

---

### Task 1: Add the Same-Origin Backend Contract

**Files:**
- Create: `public/tools/ultimate-canvas/backend-contract.js`
- Create: `scripts/smoke/ultimate-canvas-same-origin-backend-smoke.ts`
- Modify: `public/tools/ultimate-canvas/index.html:303-312`

**Interfaces:**
- Produces: `window.UltimateCanvasBackendContract` and CommonJS export with `resolveApiEndpoint(candidate, fallback, origin)`, `resolveTaskStatusEndpoint(template, taskId, origin)`, `backendStatus(bootstrap)`, and `requestErrorMessage(status, payload)`.
- Consumes: browser `URL`, `window.location.origin`, and bootstrap `backend.mode` only.

- [ ] **Step 1: Write the failing backend contract smoke test**

Create `scripts/smoke/ultimate-canvas-same-origin-backend-smoke.ts` with the exact contract cases:

```ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const contract = require('../public/tools/ultimate-canvas/backend-contract.js');
const origin = 'https://sd2.youdoodesign.com';

assert.equal(contract.resolveApiEndpoint('/api/assets/generate', '/api/fallback', origin), '/api/assets/generate');
assert.equal(
  contract.resolveApiEndpoint('https://sd2.youdoodesign.com/api/tasks/create?source=canvas', '/api/fallback', origin),
  '/api/tasks/create?source=canvas',
);
assert.equal(
  contract.resolveApiEndpoint('https://example.invalid/api/tasks/create', '/api/tasks/create', origin),
  '/api/tasks/create',
);
assert.equal(contract.resolveApiEndpoint('/admin/integrations', '/api/fallback', origin), '/api/fallback');
assert.equal(
  contract.resolveTaskStatusEndpoint('/api/video/status/:taskId?refresh=true', 'task/a', origin),
  '/api/video/status/task%2Fa?refresh=true',
);
assert.deepEqual(contract.backendStatus({ backend: { mode: 'mock' } }), {
  mode: 'mock', label: '本地 Mock', isReal: false,
});
assert.deepEqual(contract.backendStatus({ backend: { mode: 'sd2' } }), {
  mode: 'sd2', label: 'SD2 真实后端', isReal: true,
});
assert.equal(contract.requestErrorMessage(401, {}), '登录已失效，请重新登录后继续。');
assert.equal(contract.requestErrorMessage(403, { error: '无权访问当前项目' }), '无权访问当前项目');

const indexSource = readFileSync('public/tools/ultimate-canvas/index.html', 'utf8');
assert.ok(indexSource.indexOf('backend-contract.js') < indexSource.indexOf('generation-api.js'));
assert.ok(indexSource.indexOf('backend-contract.js') < indexSource.indexOf('app.js'));

console.log('ultimate-canvas-same-origin-backend-smoke passed');
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx tsx scripts/smoke/ultimate-canvas-same-origin-backend-smoke.ts
```

Expected: FAIL because `public/tools/ultimate-canvas/backend-contract.js` does not exist.

- [ ] **Step 3: Implement the minimal backend contract module**

Create `public/tools/ultimate-canvas/backend-contract.js` as a UMD-style pure module matching existing canvas helpers:

```js
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.UltimateCanvasBackendContract = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const DEFAULT_STATUS_TEMPLATE = '/api/video/status/:taskId?refresh=true';

    function clean(value) {
        return typeof value === 'string' ? value.trim() : '';
    }

    function resolveApiEndpoint(candidate, fallback, origin) {
        const safeFallback = clean(fallback);
        try {
            const base = new URL(clean(origin));
            const resolved = new URL(clean(candidate) || safeFallback, base);
            if (resolved.origin !== base.origin || !resolved.pathname.startsWith('/api/')) return safeFallback;
            return `${resolved.pathname}${resolved.search}`;
        } catch {
            return safeFallback;
        }
    }

    function resolveTaskStatusEndpoint(template, taskId, origin) {
        const encodedTaskId = encodeURIComponent(clean(taskId));
        const fallback = DEFAULT_STATUS_TEMPLATE.replace(':taskId', encodedTaskId);
        const candidate = (clean(template) || DEFAULT_STATUS_TEMPLATE).replace(':taskId', encodedTaskId);
        return resolveApiEndpoint(candidate, fallback, origin);
    }

    function backendStatus(bootstrap) {
        const mode = bootstrap?.backend?.mode === 'mock' ? 'mock' : 'sd2';
        return mode === 'mock'
            ? { mode, label: '本地 Mock', isReal: false }
            : { mode, label: 'SD2 真实后端', isReal: true };
    }

    function requestErrorMessage(status, payload) {
        const detail = clean(payload?.message) || clean(payload?.error);
        if (status === 401) return '登录已失效，请重新登录后继续。';
        if (status === 403) return detail || '当前账号没有操作此项目或视频卡的权限。';
        return detail || `请求失败：${status}`;
    }

    return { resolveApiEndpoint, resolveTaskStatusEndpoint, backendStatus, requestErrorMessage };
});
```

- [ ] **Step 4: Load the contract before consumers**

Insert immediately before `generation-api.js` in `public/tools/ultimate-canvas/index.html`:

```html
<script src="backend-contract.js?v=20260713-sd2-same-origin"></script>
```

- [ ] **Step 5: Run the focused test and verify GREEN**

Run:

```bash
npx tsx scripts/smoke/ultimate-canvas-same-origin-backend-smoke.ts
```

Expected: `ultimate-canvas-same-origin-backend-smoke passed`.

- [ ] **Step 6: Commit Task 1**

```bash
git add public/tools/ultimate-canvas/backend-contract.js public/tools/ultimate-canvas/index.html scripts/smoke/ultimate-canvas-same-origin-backend-smoke.ts
git commit -m "feat: add canvas same-origin backend contract"
```

---

### Task 2: Wire Every Runtime Endpoint Through the Contract

**Files:**
- Modify: `public/tools/ultimate-canvas/generation-api.js:1-55`
- Modify: `public/tools/ultimate-canvas/app.js:83-150,751-823,1433-1474,3527-3565,3995-4015`
- Test: `scripts/smoke/ultimate-canvas-same-origin-backend-smoke.ts`

**Interfaces:**
- Consumes: `UltimateCanvasBackendContract.resolveApiEndpoint`, `resolveTaskStatusEndpoint`, `backendStatus`, and `requestErrorMessage` from Task 1.
- Produces: sanitized generation endpoints, same-origin JSON requests, ordinary-user-safe HTTP errors, explicit runtime badge text, and sanitized task polling URLs.

- [ ] **Step 1: Extend the smoke test with failing runtime wiring assertions**

Append:

```ts
const appSource = readFileSync('public/tools/ultimate-canvas/app.js', 'utf8');
const generationApiSource = readFileSync('public/tools/ultimate-canvas/generation-api.js', 'utf8');

assert.ok(appSource.includes('function backendEndpoint(candidate, fallback)'));
assert.ok(appSource.includes('UltimateCanvasBackendContract.resolveApiEndpoint'));
assert.ok(appSource.includes('UltimateCanvasBackendContract.resolveTaskStatusEndpoint'));
assert.ok(appSource.includes('UltimateCanvasBackendContract.requestErrorMessage'));
assert.ok(appSource.includes('UltimateCanvasBackendContract.backendStatus(data)'));
assert.ok(generationApiSource.includes('UltimateCanvasBackendContract.resolveApiEndpoint'));
assert.ok(!appSource.includes("descriptor.url = capabilities.image?.endpoint || descriptor.url"));
assert.ok(!appSource.includes("descriptor.url = capabilities.video?.endpoint || descriptor.url"));
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx tsx scripts/smoke/ultimate-canvas-same-origin-backend-smoke.ts
```

Expected: FAIL on the first missing runtime wiring assertion.

- [ ] **Step 3: Add the app endpoint boundary**

Add near `configureGenerationEndpoints()` in `app.js`:

```js
function backendEndpoint(candidate, fallback) {
    return window.UltimateCanvasBackendContract.resolveApiEndpoint(
        candidate,
        fallback,
        window.location.origin
    );
}
```

Use it for all capability-controlled endpoints:

```js
text: backendEndpoint(capabilities.text?.endpoint, '/api/tools/ultimate-canvas/generate'),
script: backendEndpoint(capabilities.text?.endpoint, '/api/tools/ultimate-canvas/generate'),
image: backendEndpoint(capabilities.image?.endpoint, '/api/assets/generate'),
video: backendEndpoint(capabilities.video?.endpoint, '/api/tasks/create')
```

Replace image/video adapter overrides with:

```js
descriptor.url = backendEndpoint(capabilities.image?.endpoint, descriptor.url);
descriptor.url = backendEndpoint(capabilities.video?.endpoint, descriptor.url);
```

Use the same helper for prompt enhancement and text/script adapter calls.

- [ ] **Step 4: Enforce same-origin JSON requests and normalize errors**

At the start of `requestJson` resolve the URL and reject invalid targets before `fetch`:

```js
const requestUrl = backendEndpoint(url, '');
if (!requestUrl) {
    const error = new Error('请求地址不是允许的 SD2 同源接口。');
    error.status = 400;
    throw error;
}
```

Fetch `requestUrl` and replace ad-hoc error selection with:

```js
const message = window.UltimateCanvasBackendContract.requestErrorMessage(res.status, data);
```

Keep `error.response` and `error.status` unchanged so existing UI handling and retries continue to work.

- [ ] **Step 5: Sanitize fallback generation API configuration**

In `generation-api.js`, normalize every endpoint received by `mergeConfig`:

```js
function safeEndpoint(value) {
    return window.UltimateCanvasBackendContract.resolveApiEndpoint(
        value,
        '',
        window.location.origin
    );
}

function mergeConfig(next = {}) {
    if (next.endpoints) {
        state.endpoints = {
            ...state.endpoints,
            ...Object.fromEntries(Object.entries(next.endpoints).map(([key, value]) => [key, safeEndpoint(value)]))
        };
    }
    if (next.headers) state.headers = { ...state.headers, ...next.headers };
}
```

Do not add any token, API key, or base URL support.

- [ ] **Step 6: Sanitize video polling and show the runtime badge**

Replace `videoStatusUrl(taskId)` with:

```js
function videoStatusUrl(taskId) {
    return window.UltimateCanvasBackendContract.resolveTaskStatusEndpoint(
        canvasRuntime.bootstrap?.capabilities?.video?.status_endpoint_template,
        taskId,
        window.location.origin
    );
}
```

In `renderRuntimeContextControls(data)`, derive:

```js
const backend = window.UltimateCanvasBackendContract.backendStatus(data);
```

Use `backend.label` for the successful `contextStatus` branch so production displays `SD2 真实后端` and local preview displays `本地 Mock`.

- [ ] **Step 7: Run focused and existing lifecycle tests**

Run:

```bash
npx tsx scripts/smoke/ultimate-canvas-same-origin-backend-smoke.ts
npx tsx scripts/smoke/ultimate-canvas-generation-lifecycle-smoke.ts
npx tsx scripts/smoke/ultimate-canvas-generation-task-coordinator-smoke.ts
npx tsx scripts/smoke/ultimate-canvas-generation-node-workflow-smoke.ts
```

Expected: all four tests print `passed`.

- [ ] **Step 8: Commit Task 2**

```bash
git add public/tools/ultimate-canvas/app.js public/tools/ultimate-canvas/generation-api.js scripts/smoke/ultimate-canvas-same-origin-backend-smoke.ts
git commit -m "feat: enforce canvas same-origin API routing"
```

---

### Task 3: Mark Real SD2 and Mock Environments Explicitly

**Files:**
- Modify: `src/app/api/tools/ultimate-canvas/bootstrap/route.ts:320-400`
- Modify: `src/app/api/tools/ultimate-canvas/generate/route.ts:195-206`
- Modify: `scripts/ultimate-canvas-preview-server.mjs:361-433`
- Modify: `scripts/smoke/ultimate-canvas-preview-api-smoke.ts:1-120`
- Modify: `scripts/smoke/ultimate-canvas-normal-user-access-smoke.ts:35-70`
- Test: `scripts/smoke/ultimate-canvas-same-origin-backend-smoke.ts`

**Interfaces:**
- Produces: bootstrap `backend: { mode, transport, mock }` metadata with no secrets.
- Consumes: Task 2 badge rendering and Task 1 `backendStatus()`.

- [ ] **Step 1: Add failing metadata and ordinary-user copy assertions**

Append to `ultimate-canvas-same-origin-backend-smoke.ts`:

```ts
const bootstrapRoute = readFileSync('src/app/api/tools/ultimate-canvas/bootstrap/route.ts', 'utf8');
const previewServer = readFileSync('scripts/ultimate-canvas-preview-server.mjs', 'utf8');
const textRoute = readFileSync('src/app/api/tools/ultimate-canvas/generate/route.ts', 'utf8');

assert.ok(bootstrapRoute.includes("mode: 'sd2'"));
assert.ok(bootstrapRoute.includes("transport: 'same-origin'"));
assert.ok(bootstrapRoute.includes('mock: false'));
assert.ok(previewServer.includes("mode: 'mock'"));
assert.ok(previewServer.includes('mock: true'));
assert.ok(!textRoute.includes('请先到后台 API 设置完成配置'));
```

In `ultimate-canvas-preview-api-smoke.ts`, assert:

```ts
assert.deepEqual(bootstrap.backend, {
  mode: 'mock',
  transport: 'same-origin',
  mock: true,
});
```

In `ultimate-canvas-normal-user-access-smoke.ts`, require the production marker and forbid admin-directed copy.

- [ ] **Step 2: Run the three focused tests and verify RED**

Run:

```bash
npx tsx scripts/smoke/ultimate-canvas-same-origin-backend-smoke.ts
npx tsx scripts/smoke/ultimate-canvas-preview-api-smoke.ts
npx tsx scripts/smoke/ultimate-canvas-normal-user-access-smoke.ts
```

Expected: at least the runtime metadata assertions fail.

- [ ] **Step 3: Add the production bootstrap marker**

Add at the top level of the bootstrap response object:

```ts
backend: {
  mode: 'sd2',
  transport: 'same-origin',
  mock: false,
},
```

Do not include provider settings, hostnames, cookies, tokens, API keys, or database information.

- [ ] **Step 4: Add the local Mock marker**

Add to the top level returned by `bootstrapPayload()`:

```js
backend: {
  mode: 'mock',
  transport: 'same-origin',
  mock: true,
},
```

Keep all local preview generation behavior Mock and zero-points.

- [ ] **Step 5: Replace admin-directed text capability copy**

In `src/app/api/tools/ultimate-canvas/generate/route.ts`, replace the `503` message with:

```ts
{ error: '文本生成能力暂不可用，请稍后联系管理员。' }
```

Do not change provider readiness logic or settings access.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
npx tsx scripts/smoke/ultimate-canvas-same-origin-backend-smoke.ts
npx tsx scripts/smoke/ultimate-canvas-preview-api-smoke.ts
npx tsx scripts/smoke/ultimate-canvas-normal-user-access-smoke.ts
```

Expected: all three tests print `passed`.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/app/api/tools/ultimate-canvas/bootstrap/route.ts src/app/api/tools/ultimate-canvas/generate/route.ts scripts/ultimate-canvas-preview-server.mjs scripts/smoke/ultimate-canvas-preview-api-smoke.ts scripts/smoke/ultimate-canvas-normal-user-access-smoke.ts scripts/smoke/ultimate-canvas-same-origin-backend-smoke.ts
git commit -m "feat: identify canvas backend runtime"
```

---

### Task 4: Full Verification, SD2 Acceptance Handoff, and Report

**Files:**
- Modify: `docs/handoffs/ultimate-canvas-implementation-report.md`
- Regenerate outside repository: `E:/Ultimate-canvas/ultimate-canvas-complete-final.patch` when push is unavailable.

**Interfaces:**
- Consumes: all implementation tasks and the existing implementation report format.
- Produces: reproducible verification evidence, an ordinary-account SD2 acceptance checklist, and a complete patch fallback.

- [ ] **Step 1: Run every Ultimate Canvas smoke test**

Run:

```powershell
$files = Get-ChildItem scripts -Filter 'ultimate-canvas-*-smoke.ts' | Sort-Object Name
foreach ($file in $files) {
  npx tsx $file.FullName
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

Expected: all smoke tests, including `ultimate-canvas-same-origin-backend-smoke.ts`, print `passed` and exit `0`.

- [ ] **Step 2: Run syntax, type, lint, build, and diff checks**

Run each command separately:

```bash
node --check public/tools/ultimate-canvas/backend-contract.js
node --check public/tools/ultimate-canvas/generation-api.js
node --check public/tools/ultimate-canvas/app.js
node --check public/tools/ultimate-canvas/canvas-engine.js
npx tsc --noEmit --pretty false
npm run lint
npm run build
git diff --check
```

Expected: exit `0` for every command. Existing unrelated lint warnings may remain, but there must be no lint errors.

- [ ] **Step 3: Verify the local preview remains visibly Mock**

Start the existing preview server and open:

```text
http://127.0.0.1:4399/tools/ultimate-canvas/index.html
```

Expected:

- Header status reads `本地 Mock`.
- Bootstrap reports `backend.mode = "mock"`.
- Text/image/video preview submissions return local Mock results and consume zero points.
- No request is sent to `sd2.youdoodesign.com` from the local preview page.

- [ ] **Step 4: Push or prepare the deployment patch**

Attempt:

```bash
git push origin teammate/ultimate-canvas-complete
```

Expected when authorized: branch push succeeds and the SD2 deployment owner can deploy that branch.

If GitHub returns `403`, generate and validate the complete patch:

```powershell
git diff --binary origin/teammate/ultimate-canvas-complete..HEAD --output=E:\Ultimate-canvas\ultimate-canvas-complete-final.patch
git apply --check --reverse --binary E:\Ultimate-canvas\ultimate-canvas-complete-final.patch
Get-FileHash -Algorithm SHA256 E:\Ultimate-canvas\ultimate-canvas-complete-final.patch
```

Expected: reverse apply check exits `0`, and the SHA256 is recorded in the report.

- [ ] **Step 5: Perform non-paid SD2 same-origin acceptance after deployment**

Using an ordinary logged-in test account, open:

```text
https://sd2.youdoodesign.com/tools/ultimate-canvas
```

Verify without creating paid image/video tasks:

1. Page and iframe load without `401` or `403`.
2. Header status reads `SD2 真实后端`.
3. `GET /api/tools/ultimate-canvas/bootstrap` reports `backend.mode = "sd2"` and only relative `/api/...` generation endpoints.
4. Project/video-card choices and point balance match the ordinary generation page.
5. Saving and refreshing restores nodes, connections, viewport, active node, and saved task identifiers.
6. Upload uses `/api/tools/ultimate-canvas/upload` and writes back real asset/reference/workspace IDs.
7. Browser console has no new errors and the network log contains no third-party model endpoint.

Do not claim text/image/video real generation was verified unless the user manually triggered it and the resulting task/asset identifiers were observed.

- [ ] **Step 6: Record paid-generation acceptance only when explicitly performed**

If the user manually triggers real generation on the deployed page, record separately for text, image, and video:

- Request endpoint and resulting SD2 task/asset ID.
- Final status (`succeeded`, `failed`, or `cancelled`).
- Whether points were frozen, charged, or refunded.
- Whether the result wrote back to the originating node after context validation.

Do not include cookies, tokens, provider request bodies, API keys, or signed URL secrets in the report.

- [ ] **Step 7: Update the implementation report**

Append a section titled `## SD2 同源真实后端接入（2026-07-13）` to `docs/handoffs/ultimate-canvas-implementation-report.md` covering all required receipt fields:

```markdown
### 本次目标理解
### 实际修改文件及逐文件说明
### 验证命令与结果
### 真实文字、图片、视频调用情况
### 点数消耗情况
### 受保护区域确认
### 未完成内容
### 风险与下一步
```

State explicitly that `.env`, admin API settings, provider secret configuration, credits core rules, and database schema were not read or modified.

- [ ] **Step 8: Commit Task 4**

```bash
git add docs/handoffs/ultimate-canvas-implementation-report.md
git commit -m "docs: report sd2 same-origin canvas integration"
```

---

## Plan Completion Check

Before declaring implementation complete:

- Confirm production endpoints are same-origin and limited to `/api/...`.
- Confirm local preview is visibly and structurally marked Mock.
- Confirm ordinary users retain login, project, video-card, and point rules without admin elevation.
- Confirm save, upload, text, image, video, and polling code paths remain the existing canvas paths.
- Confirm no protected files or subsystems were touched.
- Confirm live paid-generation claims are backed by an explicit user action and observed SD2 identifiers.
- Confirm the implementation report and patch fallback are current.
