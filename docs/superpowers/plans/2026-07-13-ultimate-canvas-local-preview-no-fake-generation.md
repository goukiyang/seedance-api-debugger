# Ultimate Canvas Local Preview Without Fake Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the default local Ultimate Canvas preview refuse fake generation while retaining deterministic generation lifecycle coverage behind an explicit `--mock-generation` test flag.

**Architecture:** The frontend backend contract will distinguish production SD2, local preview without generation, and explicit test Mock. The preview server will default to preview mode, expose fixture-backed canvas data, and reject generation-related requests with HTTP 503 plus `REAL_BACKEND_REQUIRED`; automated lifecycle tests will opt into the existing in-memory generation behavior with a command-line flag.

**Tech Stack:** Next.js 14, browser JavaScript modules, Node.js HTTP preview server, TypeScript smoke scripts, PostCSS/source assertions, in-app browser QA.

## Global Constraints

- Production remains `{ mode: "sd2", transport: "same-origin", mock: false }` and all production model calls remain same-origin.
- Default local preview must not return fake text, generated images, video task IDs, successful video results, point estimates, or paid retry results.
- Test Mock may be enabled only by the literal `--mock-generation` command-line flag, never by an environment variable.
- Do not proxy local requests to `https://sd2.youdoodesign.com`.
- Do not bypass ordinary-user authorization or introduce admin behavior.
- Do not read or modify `.env`, admin API settings, provider secrets, credit core logic, or database schema.
- Do not call real text, image, or video generation while implementing or verifying this plan.
- Update `docs/handoffs/ultimate-canvas-implementation-report.md` with exact validation and point-consumption facts.

## File Map

- `public/tools/ultimate-canvas/backend-contract.js`: validates backend metadata and maps it to a safe UI status.
- `public/tools/ultimate-canvas/app.js`: uses capability messages when image/video generation is disabled.
- `public/tools/ultimate-canvas/index.html`: cache-busts changed frontend modules.
- `scripts/ultimate-canvas-preview-server.mjs`: serves local fixtures, selects preview or explicit test Mock mode, and owns the 503 rejection contract.
- `scripts/ultimate-canvas-preview-no-generation-smoke.ts`: new default-mode API regression coverage.
- `scripts/ultimate-canvas-preview-api-smoke.ts`: existing lifecycle coverage, changed to opt into test Mock explicitly.
- `scripts/ultimate-canvas-same-origin-backend-smoke.ts`: backend-state, endpoint-contract, and production-safety coverage.
- `scripts/ultimate-canvas-context-rules-smoke.ts`: frontend cache-key assertion.
- `scripts/ultimate-canvas-generation-node-interactions-smoke.ts`: frontend cache-key assertion.
- `scripts/ultimate-canvas-generation-node-workflow-smoke.ts`: disabled capability message and cache-key assertions.
- `scripts/ultimate-canvas-video-card-workflow-smoke.ts`: frontend cache-key assertion.
- `docs/handoffs/ultimate-canvas-implementation-report.md`: delivery receipt and safety record.

---

### Task 1: Add The Non-Generating Preview Backend State

**Files:**
- Modify: `public/tools/ultimate-canvas/backend-contract.js:93-106`
- Modify: `public/tools/ultimate-canvas/app.js:3757-3791`
- Modify: `public/tools/ultimate-canvas/index.html:305-312`
- Modify: `scripts/ultimate-canvas-same-origin-backend-smoke.ts:15-35`
- Modify: `scripts/ultimate-canvas-generation-node-workflow-smoke.ts`
- Modify: `scripts/ultimate-canvas-context-rules-smoke.ts`
- Modify: `scripts/ultimate-canvas-generation-node-interactions-smoke.ts`
- Modify: `scripts/ultimate-canvas-video-card-workflow-smoke.ts`

**Interfaces:**
- Consumes: Bootstrap metadata `{ mode, transport, mock }` and capability `{ enabled, message }` objects.
- Produces: `backendStatus(bootstrap) -> { mode: "preview" | "mock" | "sd2" | "unverified", label: string, isReal: boolean }` and consistent disabled capability messages.

- [ ] **Step 1: Write failing backend-state and message assertions**

In `scripts/ultimate-canvas-same-origin-backend-smoke.ts`, add the preview state before the existing Mock and SD2 assertions:

```ts
assert.deepEqual(contract.backendStatus({
  backend: { mode: 'preview', transport: 'same-origin', mock: false },
}), {
  mode: 'preview', label: '未连接 SD2', isReal: false,
});

assert.deepEqual(contract.backendStatus({
  backend: { mode: 'preview', transport: 'same-origin', mock: true },
}), {
  mode: 'unverified', label: '后端状态未验证', isReal: false,
});
```

Change the explicit Mock expectation to label `测试 Mock`. Keep the production SD2 assertion unchanged.

In `scripts/ultimate-canvas-generation-node-workflow-smoke.ts`, assert that disabled image and video branches use their capability-specific message before the generic safe message:

```ts
assert.match(appSource, /capabilities\.image\?\.message\s*\|\|\s*window\.UltimateCanvasBackendContract\.SAFE_UNAVAILABLE_MESSAGE/);
assert.match(appSource, /capabilities\.video\?\.message\s*\|\|\s*window\.UltimateCanvasBackendContract\.SAFE_UNAVAILABLE_MESSAGE/);
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
npx tsx scripts/ultimate-canvas-same-origin-backend-smoke.ts
npx tsx scripts/ultimate-canvas-generation-node-workflow-smoke.ts
```

Expected: the first command fails because preview metadata maps to `unverified`; the second fails because image/video disabled branches ignore the capability message.

- [ ] **Step 3: Implement the preview state and capability message flow**

Add this branch before Mock and SD2 in `backendStatus`:

```js
if (backend?.mode === 'preview'
    && backend.transport === 'same-origin'
    && backend.mock === false) {
    return { mode: 'preview', label: '未连接 SD2', isReal: false };
}
```

Change the explicit Mock label to `测试 Mock`.

In `generationContextReadiness`, change the disabled image and video messages to:

```js
message: capabilities.image?.message
    || window.UltimateCanvasBackendContract.SAFE_UNAVAILABLE_MESSAGE
```

and:

```js
message: capabilities.video?.message
    || window.UltimateCanvasBackendContract.SAFE_UNAVAILABLE_MESSAGE
```

Update `backend-contract.js` and `app.js` cache keys in `index.html` to `20260713-no-fake-preview`, and update the four cache-key smoke assertions listed in this task.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```powershell
npx tsx scripts/ultimate-canvas-same-origin-backend-smoke.ts
npx tsx scripts/ultimate-canvas-generation-node-workflow-smoke.ts
npx tsx scripts/ultimate-canvas-context-rules-smoke.ts
npx tsx scripts/ultimate-canvas-generation-node-interactions-smoke.ts
npx tsx scripts/ultimate-canvas-video-card-workflow-smoke.ts
```

Expected: all five commands exit 0.

- [ ] **Step 5: Commit Task 1**

```powershell
git add public/tools/ultimate-canvas/backend-contract.js public/tools/ultimate-canvas/app.js public/tools/ultimate-canvas/index.html scripts/ultimate-canvas-same-origin-backend-smoke.ts scripts/ultimate-canvas-generation-node-workflow-smoke.ts scripts/ultimate-canvas-context-rules-smoke.ts scripts/ultimate-canvas-generation-node-interactions-smoke.ts scripts/ultimate-canvas-video-card-workflow-smoke.ts
git commit -m "feat: distinguish local preview from test mock"
```

---

### Task 2: Disable Fake Generation By Default In The Preview Server

**Files:**
- Modify: `scripts/ultimate-canvas-preview-server.mjs:6-10, 226-275, 361-435, 437-917`
- Create: `scripts/ultimate-canvas-preview-no-generation-smoke.ts`
- Modify: `scripts/ultimate-canvas-preview-api-smoke.ts:6-12, 54-70`
- Modify: `scripts/ultimate-canvas-same-origin-backend-smoke.ts:168-236`

**Interfaces:**
- Consumes: Optional literal CLI flag `--mock-generation`.
- Produces: Default bootstrap `{ mode: "preview", transport: "same-origin", mock: false }`; explicit test bootstrap `{ mode: "mock", transport: "same-origin", mock: true }`; `sendRealBackendRequired(response)` returning HTTP 503 and `{ error: "REAL_BACKEND_REQUIRED", message: string }`.

- [ ] **Step 1: Add the default no-generation smoke in RED state**

Create `scripts/ultimate-canvas-preview-no-generation-smoke.ts` with a random local port and start the server without any extra flag:

```ts
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const port = 46000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['scripts/ultimate-canvas-preview-server.mjs', String(port)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
```

Use a request helper that returns `{ status, data }` without throwing on non-2xx responses. Assert:

```ts
const bootstrap = await request('GET', '/api/tools/ultimate-canvas/bootstrap');
assert.equal(bootstrap.status, 200);
assert.deepEqual(bootstrap.data.backend, {
  mode: 'preview', transport: 'same-origin', mock: false,
});
assert.equal(bootstrap.data.capabilities.text.enabled, false);
assert.equal(bootstrap.data.capabilities.image.enabled, false);
assert.equal(bootstrap.data.capabilities.video.enabled, false);

for (const attempt of [
  ['POST', '/api/tools/ultimate-canvas/generate', { kind: 'text', prompt: 'test' }],
  ['POST', '/api/assets/generate', { input: { prompt: 'test' } }],
  ['POST', '/api/tasks/create', { prompt: 'test' }],
  ['GET', '/api/tasks/estimate?resolution=720p&duration=5'],
  ['POST', '/api/video/retry/task-opening-1', {}],
  ['GET', '/api/video/status/task-opening-1?refresh=true'],
  ['GET', '/api/video/thumbnail/task-opening-1'],
] as const) {
  const result = await request(attempt[0], attempt[1], attempt[2]);
  assert.equal(result.status, 503);
  assert.equal(result.data.error, 'REAL_BACKEND_REQUIRED');
  assert.match(result.data.message, /未连接 SD2/);
  assert.doesNotMatch(JSON.stringify(result.data), /task-mock-|asset-generated-|result_video_url/);
}
```

Also request `/api/video-cards/card-opening/tasks` and assert the returned task list is empty in default preview mode.

Always kill the child process in `finally`.

- [ ] **Step 2: Make the existing lifecycle smoke explicitly request test Mock**

Change the spawn arguments in `scripts/ultimate-canvas-preview-api-smoke.ts` to:

```ts
[
  'scripts/ultimate-canvas-preview-server.mjs',
  String(port),
  '--mock-generation',
]
```

Keep its existing bootstrap expectation `{ mode: 'mock', transport: 'same-origin', mock: true }` and generation lifecycle assertions.

- [ ] **Step 3: Run both preview smokes and verify RED/GREEN split**

Run:

```powershell
npx tsx scripts/ultimate-canvas-preview-no-generation-smoke.ts
npx tsx scripts/ultimate-canvas-preview-api-smoke.ts
```

Expected before server implementation: the new default smoke fails because bootstrap still reports Mock and generation succeeds; the existing lifecycle smoke remains GREEN after adding the flag.

- [ ] **Step 4: Implement explicit runtime mode and stable 503 errors**

At the top of `ultimate-canvas-preview-server.mjs`, add:

```js
const mockGenerationEnabled = process.argv.includes('--mock-generation');
const realBackendRequiredMessage = '本地预览未连接 SD2，真实生成请使用已部署的同源应用。';
```

Add a response helper beside `sendJson`:

```js
function sendRealBackendRequired(response) {
  return sendJson(response, {
    error: 'REAL_BACKEND_REQUIRED',
    message: realBackendRequiredMessage,
  }, 503);
}
```

Make `cardTasks(cardId)` and branch task summaries use no tasks when `mockGenerationEnabled` is false:

```js
function visibleVideoTasks() {
  return mockGenerationEnabled ? videoTasks : [];
}

function cardTasks(cardId) {
  return visibleVideoTasks().filter((task) => task.video_card_id === cardId);
}
```

Use `visibleVideoTasks()` in `normalizeBranch` and the video-card task list response.

Build bootstrap mode and capabilities from the flag:

```js
const backend = mockGenerationEnabled
  ? { mode: 'mock', transport: 'same-origin', mock: true }
  : { mode: 'preview', transport: 'same-origin', mock: false };
const generationMessage = mockGenerationEnabled
  ? '测试 Mock 可用'
  : realBackendRequiredMessage;
```

Set `text.enabled`, `image.enabled`, and `video.enabled` to `mockGenerationEnabled`, retain their existing endpoint and interaction metadata, and set each capability message to `generationMessage`.

Before handling each generation-related route, return `sendRealBackendRequired(response)` when the flag is false. Cover:

```text
POST /api/tools/ultimate-canvas/generate
POST /api/assets/generate
GET  /api/tasks/estimate
POST /api/tasks/create
POST /api/video/retry/:taskId
GET  /api/video/status/:taskId
GET  /api/video/thumbnail/:taskId
```

Do not gate document save/restore, fixture library reads, context switching, canvas layout endpoints, or local reference upload.

- [ ] **Step 5: Update source-contract assertions**

In `scripts/ultimate-canvas-same-origin-backend-smoke.ts`, replace the single preview-server Mock source assertion with assertions for:

```ts
assert.match(previewServerSource, /process\.argv\.includes\('--mock-generation'\)/);
assert.match(previewServerSource, /mode: 'preview',\s*transport: 'same-origin',\s*mock: false/);
assert.match(previewServerSource, /mode: 'mock',\s*transport: 'same-origin',\s*mock: true/);
assert.match(previewServerSource, /REAL_BACKEND_REQUIRED/);
assert.doesNotMatch(previewServerSource, /process\.env\.[A-Z0-9_]*MOCK/);
```

- [ ] **Step 6: Run Task 2 tests and verify GREEN**

Run:

```powershell
npx tsx scripts/ultimate-canvas-preview-no-generation-smoke.ts
npx tsx scripts/ultimate-canvas-preview-api-smoke.ts
npx tsx scripts/ultimate-canvas-same-origin-backend-smoke.ts
```

Expected: all three commands exit 0. The first reports default preview rejection, the second reports explicit test Mock lifecycle success, and the third reports contract success.

- [ ] **Step 7: Commit Task 2**

```powershell
git add scripts/ultimate-canvas-preview-server.mjs scripts/ultimate-canvas-preview-no-generation-smoke.ts scripts/ultimate-canvas-preview-api-smoke.ts scripts/ultimate-canvas-same-origin-backend-smoke.ts
git commit -m "fix: disable fake preview generation by default"
```

---

### Task 3: Browser QA, Full Verification, And Delivery Receipt

**Files:**
- Modify: `docs/handoffs/ultimate-canvas-implementation-report.md`

**Interfaces:**
- Consumes: Default preview mode from Task 2.
- Produces: Browser evidence, final verification evidence, and a complete delivery record.

- [ ] **Step 1: Start default local preview without the test flag**

Run:

```powershell
node scripts/ultimate-canvas-preview-server.mjs 4400
```

Expected: the page is available at `http://127.0.0.1:4400/tools/ultimate-canvas/index.html`; server startup output identifies preview mode and does not claim test Mock generation is enabled.

- [ ] **Step 2: Verify default browser behavior**

In the in-app browser:

- Reload the local canvas.
- Confirm the context badge displays `未连接 SD2` and does not display `本地 Mock` or `测试 Mock`.
- Create or select an image node, enter a prompt, and click its generate command.
- Confirm the node remains non-successful, no fake asset appears, and the existing error surface displays the capability message mentioning `未连接 SD2`.
- Repeat with a video node and confirm no fake task ID, pending poll, result video, or fake thumbnail appears.
- Confirm the canvas remains usable for node selection, connections, property panels, and save/restore fixtures.
- Confirm browser console warning/error count remains zero after expected handled failures.

- [ ] **Step 3: Run the full automated suite**

Run:

```powershell
Get-ChildItem scripts -Filter 'ultimate-canvas-*-smoke.ts' | Sort-Object Name | ForEach-Object { npx tsx $_.FullName; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
node --check public/tools/ultimate-canvas/backend-contract.js
node --check public/tools/ultimate-canvas/app.js
node --check scripts/ultimate-canvas-preview-server.mjs
npx tsc --noEmit --pretty false
npm run lint
npm run build
git diff --check 9937708..HEAD
```

Expected: 13/13 Ultimate Canvas smoke scripts pass; all syntax and TypeScript checks exit 0; lint and build exit 0 with only existing repository warnings; task-scoped diff check exits 0.

- [ ] **Step 4: Update the implementation report**

Append a dated section to `docs/handoffs/ultimate-canvas-implementation-report.md` containing:

1. Goal and selected explicit-test-flag approach.
2. Exact files changed and each file's responsibility.
3. RED/GREEN commands and results.
4. Default preview browser evidence.
5. Full verification commands and results.
6. Real text/image/video generation: no.
7. Points consumed: 0.
8. Protected areas touched: no.
9. Remaining work: deploy/push and real ordinary-account verification on SD2.
10. Risk: test Mock remains available only through `--mock-generation`; production remains authoritative.

- [ ] **Step 5: Stop the owned preview process and commit the receipt**

Verify the process command line contains `ultimate-canvas-preview-server.mjs 4400` before stopping it. Then run:

```powershell
git add docs/handoffs/ultimate-canvas-implementation-report.md
git commit -m "docs: record no-fake-preview verification"
```

- [ ] **Step 6: Final review and delivery**

Request an independent review of `9937708..HEAD`. Resolve all Critical and Important findings, rerun the complete verification command, merge locally into `teammate/ultimate-canvas-complete` if implementation used a worktree branch, attempt the authorized remote push, and regenerate `E:\Ultimate-canvas\ultimate-canvas-complete-final.patch` if push remains blocked.
