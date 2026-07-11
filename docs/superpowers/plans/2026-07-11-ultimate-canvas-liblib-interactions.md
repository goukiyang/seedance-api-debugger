# Ultimate Canvas Liblib-Style Interactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the existing image and video canvas nodes with Liblib-style interaction behavior while preserving the current `CanvasEngine`, sd2 APIs, permissions, and visual language.

**Architecture:** Keep the existing static HTML/JavaScript canvas. Add one pure interaction-contract module for capability normalization, mode availability, reference roles, prompt camera lines, serialization safety, and polling delays. Extend `CanvasEngine` only with public connection/selection methods and resize-driven path updates; keep DOM interaction orchestration in `app.js`, and isolate multi-task scheduling in a small coordinator module.

**Tech Stack:** Vanilla JavaScript UMD modules, existing `CanvasEngine`, Next.js 14 API routes, TypeScript smoke tests with `tsx`, CSS, in-app browser QA.

## Global Constraints

- Preserve the existing `CanvasEngine`; do not migrate to React Flow.
- Preserve current sd2 branding and all same-origin `/api/...` generation routes.
- Normal authenticated users must work without an admin role or permission bypass.
- Do not read or modify `.env`, admin API settings, provider secrets, point freeze/deduct/refund rules, or database schema.
- Do not add UI for mark, effects, role libraries, or other actions without an existing sd2 backend meaning.
- All visible controls must be actionable or explicitly disabled with a visible reason.
- Keep generation results and editable controls in the same node.
- Video cost estimation is the final, lowest-priority task and must not block generation when unavailable.
- Follow TDD for every task: add the assertion, run it and observe the expected failure, implement the minimum behavior, then rerun the focused and regression tests.

---

### Task 1: Pure Interaction Contracts

**Files:**
- Create: `public/tools/ultimate-canvas/generation-node-interactions.js`
- Create: `scripts/ultimate-canvas-generation-node-interactions-smoke.ts`
- Modify: `public/tools/ultimate-canvas/index.html`

**Interfaces:**
- Produces `window.UltimateCanvasGenerationInteractions` and CommonJS exports.
- Produces `normalizeCapabilities(kind, capability)`.
- Produces `modeOptions(kind, capability, referenceCount)`.
- Produces `referenceRole(mode, index)`.
- Produces `replaceCameraLine(prompt, cameraText)`.
- Produces `sanitizeSerializable(value)`.
- Produces `pollDelay(attempt, errorCount, hidden)`.

- [ ] **Step 1: Write the failing interaction contract smoke test**

Create `scripts/ultimate-canvas-generation-node-interactions-smoke.ts` with these behavioral assertions:

```ts
import assert from 'node:assert/strict';

const interactions = require('../public/tools/ultimate-canvas/generation-node-interactions.js');

const videoCapability = interactions.normalizeCapabilities('video', {
  interaction: {
    modes: ['text-to-video', 'image-to-video', 'first-last-frame-video'],
    ratios: ['16:9', '9:16'],
    durations: [5, 10],
    resolutions: ['720p', '1080p'],
    supports_audio: true,
    supports_last_frame: true,
    supports_watermark: false,
    max_reference_images: 2,
  },
});

assert.deepEqual(videoCapability.durations, [5, 10]);
assert.equal(videoCapability.supportsWatermark, false);

const withoutReferences = interactions.modeOptions('video', videoCapability, 0);
assert.equal(withoutReferences.find((item: any) => item.id === 'text-to-video').enabled, true);
assert.equal(withoutReferences.find((item: any) => item.id === 'image-to-video').enabled, false);
assert.match(withoutReferences.find((item: any) => item.id === 'image-to-video').reason, /1/);

const withTwoReferences = interactions.modeOptions('video', videoCapability, 2);
assert.equal(withTwoReferences.find((item: any) => item.id === 'first-last-frame-video').enabled, true);
assert.equal(interactions.referenceRole('first-last-frame-video', 0), '首帧');
assert.equal(interactions.referenceRole('first-last-frame-video', 1), '尾帧');

assert.equal(
  interactions.replaceCameraLine('产品缓慢旋转\n运镜：镜头前推', '镜头环绕主体'),
  '产品缓慢旋转\n运镜：镜头环绕主体',
);
assert.equal(
  interactions.replaceCameraLine('产品缓慢旋转', '镜头环绕主体'),
  '产品缓慢旋转\n运镜：镜头环绕主体',
);

assert.deepEqual(
  interactions.sanitizeSerializable({ keep: 'https://example.com/a.png', remove: 'blob:temp', nested: ['data:image/png;base64,x', 3] }),
  { keep: 'https://example.com/a.png', remove: '', nested: ['', 3] },
);

assert.equal(interactions.pollDelay(1, 0, false), 3000);
assert.equal(interactions.pollDelay(20, 0, false), 8000);
assert.equal(interactions.pollDelay(2, 3, false), 15000);
assert.equal(interactions.pollDelay(2, 0, true), 15000);

console.log('ultimate-canvas-generation-node-interactions-smoke passed');
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npx tsx scripts/ultimate-canvas-generation-node-interactions-smoke.ts
```

Expected: FAIL with `Cannot find module '../public/tools/ultimate-canvas/generation-node-interactions.js'`.

- [ ] **Step 3: Implement the pure UMD module**

Create a UMD/CommonJS file following `generation-node-workflow.js`. Define immutable defaults and return new arrays/objects. The mode table must be:

```js
const MODE_DEFINITIONS = {
  image: [
    { id: 'text-to-image', label: '文生图', minimumReferences: 0, maximumReferences: 10 },
    { id: 'image-to-image', label: '图生图', minimumReferences: 1, maximumReferences: 10 },
    { id: 'upscale-image', label: '高清修复', minimumReferences: 1, maximumReferences: 1 },
    { id: 'first-frame-draft', label: '首帧草图', minimumReferences: 0, maximumReferences: 10 },
    { id: 'last-frame-draft', label: '尾帧草图', minimumReferences: 0, maximumReferences: 10 },
  ],
  video: [
    { id: 'text-to-video', label: '文生视频', minimumReferences: 0, maximumReferences: 9 },
    { id: 'all-reference-video', label: '全部参考', minimumReferences: 1, maximumReferences: 9 },
    { id: 'image-to-video', label: '图生视频', minimumReferences: 1, maximumReferences: 9 },
    { id: 'first-frame-video', label: '首帧视频', minimumReferences: 1, maximumReferences: 1 },
    { id: 'first-last-frame-video', label: '首尾帧', minimumReferences: 1, maximumReferences: 2 },
    { id: 'image-reference-video', label: '图片参考', minimumReferences: 1, maximumReferences: 9 },
    { id: 'smart-multi-frame-video', label: '智能多帧', minimumReferences: 2, maximumReferences: 9 },
  ],
};
```

`normalizeCapabilities` must consume `capability.interaction`, filter invalid values, and fall back to the existing broad sd2 values. `modeOptions` must only return IDs named in `capability.modes`, set `enabled`, and set a Chinese `reason` when references are insufficient or exceed the maximum. `sanitizeSerializable` must recurse through arrays and plain objects without mutating input. `pollDelay` must return 15 seconds when hidden, otherwise error backoff capped at 20 seconds, otherwise 3/5/8 seconds by attempt.

Load the module before `generation-node-workflow.js` in `index.html` with cache key `20260711-liblib-interactions`.

- [ ] **Step 4: Run the focused test and syntax check**

Run:

```powershell
node --check public/tools/ultimate-canvas/generation-node-interactions.js
npx tsx scripts/ultimate-canvas-generation-node-interactions-smoke.ts
```

Expected: both commands PASS.

- [ ] **Step 5: Commit Task 1**

```powershell
git add public/tools/ultimate-canvas/generation-node-interactions.js public/tools/ultimate-canvas/index.html scripts/ultimate-canvas-generation-node-interactions-smoke.ts
git commit -m "feat: add canvas interaction contracts"
```

---

### Task 2: Bootstrap-Driven Interaction Capabilities

**Files:**
- Modify: `src/app/api/tools/ultimate-canvas/bootstrap/route.ts`
- Modify: `public/tools/ultimate-canvas/generation-node-workflow.js`
- Modify: `scripts/ultimate-canvas-preview-server.mjs`
- Modify: `scripts/ultimate-canvas-preview-api-smoke.ts`
- Modify: `scripts/ultimate-canvas-generation-node-interactions-smoke.ts`
- Modify: `scripts/ultimate-canvas-generation-node-workflow-smoke.ts`

**Interfaces:**
- Extends `capabilities.image.interaction` and `capabilities.video.interaction`.
- Does not expose provider secrets or admin setting names.
- `app.js` will consume this shape in Task 4.

- [ ] **Step 1: Add failing API assertions**

Extend the preview API smoke test to assert:

```ts
assert.deepEqual(bootstrap.capabilities.video.interaction.ratios, ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']);
assert.deepEqual(bootstrap.capabilities.video.interaction.durations, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
assert.deepEqual(bootstrap.capabilities.video.interaction.resolutions, ['480p', '720p', '1080p']);
assert.equal(bootstrap.capabilities.video.interaction.max_reference_images, 9);
assert.equal(bootstrap.capabilities.video.interaction.supports_audio, true);
assert.ok(bootstrap.capabilities.video.interaction.modes.includes('first-last-frame-video'));
assert.deepEqual(bootstrap.capabilities.image.interaction.size_options, ['1K', '2K']);
```

Extend the interaction smoke source assertions to require the production bootstrap route to contain `interaction`, `DURATION_OPTIONS`, `RESOLUTION_OPTIONS`, and `RATIO_OPTIONS`.

Extend the generation workflow smoke to assert that `smart-multi-frame-video` maps to `smart_multi_frame`, requires at least 2 references, accepts at most 9, and preserves ordered `reference_image_ids`.

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
npx tsx scripts/ultimate-canvas-preview-api-smoke.ts
npx tsx scripts/ultimate-canvas-generation-node-interactions-smoke.ts
```

Expected: FAIL because `capabilities.video.interaction` is undefined.

- [ ] **Step 3: Return safe capability metadata**

Import the existing public option constants from `@/types` and add:

```ts
interaction: {
  modes: [
    'text-to-video',
    'all-reference-video',
    'image-to-video',
    'first-frame-video',
    'first-last-frame-video',
    'image-reference-video',
    'smart-multi-frame-video',
  ],
  ratios: RATIO_OPTIONS,
  durations: DURATION_OPTIONS,
  resolutions: RESOLUTION_OPTIONS,
  supports_audio: true,
  supports_last_frame: true,
  supports_watermark: true,
  max_reference_images: 9,
},
```

For image capability add:

```ts
interaction: {
  modes: ['text-to-image', 'image-to-image', 'upscale-image', 'first-frame-draft', 'last-frame-draft'],
  ratios: RATIO_OPTIONS,
  size_options: imageModelCapabilities(imageSettings.provider).size_options,
  max_outputs_per_request: imageModelCapabilities(imageSettings.provider).max_outputs_per_request,
  max_reference_images: imageModelCapabilities(imageSettings.provider).reference_image_limit,
},
```

Mirror the same response shape in the local preview server. Do not add model keys, provider URLs, or pricing values.

Add this real backend-supported mode to `VIDEO_MODES` in `generation-node-workflow.js`:

```js
'smart-multi-frame-video': {
  generationMode: 'smart_multi_frame',
  minimumReferences: 2,
  maximumReferences: 9,
},
```

- [ ] **Step 4: Rerun capability tests**

Run:

```powershell
npx tsx scripts/ultimate-canvas-preview-api-smoke.ts
npx tsx scripts/ultimate-canvas-generation-node-interactions-smoke.ts
npx tsx scripts/ultimate-canvas-generation-node-workflow-smoke.ts
npx tsc --noEmit --pretty false
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```powershell
git add src/app/api/tools/ultimate-canvas/bootstrap/route.ts public/tools/ultimate-canvas/generation-node-workflow.js scripts/ultimate-canvas-preview-server.mjs scripts/ultimate-canvas-preview-api-smoke.ts scripts/ultimate-canvas-generation-node-interactions-smoke.ts scripts/ultimate-canvas-generation-node-workflow-smoke.ts
git commit -m "feat: expose canvas interaction capabilities"
```

---

### Task 3: Expandable Nodes and Stable Connection APIs

**Files:**
- Modify: `public/tools/ultimate-canvas/canvas-engine.js`
- Modify: `public/tools/ultimate-canvas/styles.css`
- Modify: `scripts/ultimate-canvas-generation-node-interactions-smoke.ts`

**Interfaces:**
- Produces `engine.selectNode(nodeId)`.
- Produces `engine.connectNodes(fromId, toId)`.
- Produces `engine.disconnectNodes(fromId, toId)`.
- Produces `engine.disconnectIncoming(nodeId)`.
- Produces `engine.onConnectionDeleted` and `engine.onNodeDeleted` callbacks.
- Keeps existing private methods working for existing call sites.

- [ ] **Step 1: Add failing engine source assertions**

Assert that the engine source contains:

```ts
contains(engineSource, 'connectNodes(fromId, toId)', 'engine exposes public connection creation');
contains(engineSource, 'disconnectNodes(fromId, toId)', 'engine exposes public connection removal');
contains(engineSource, 'disconnectIncoming(nodeId)', 'engine can clear target references');
contains(engineSource, 'selectNode(nodeId)', 'app can return selection to the target node');
contains(engineSource, 'new ResizeObserver', 'node size changes update edge paths');
contains(engineSource, 'this.onConnectionDeleted', 'connection removals notify persistence');
```

Add CSS assertions for `.canvas-node.selected`, `.canvas-node:not(.selected) .node-generation-expanded`, and `.canvas-node.is-reference-compatible`.

- [ ] **Step 2: Run and verify RED**

Run:

```powershell
npx tsx scripts/ultimate-canvas-generation-node-interactions-smoke.ts
```

Expected: FAIL on the first missing public engine method.

- [ ] **Step 3: Add public engine methods and resize observation**

Implement public wrappers with these contracts:

```js
selectNode(nodeId) {
  if (!this.nodes.has(nodeId)) return false;
  this._selectNode(nodeId);
  return true;
}

connectNodes(fromId, toId) {
  if (!this.nodes.has(fromId) || !this.nodes.has(toId) || fromId === toId) return false;
  const before = this.connections.length;
  this._createConnection(fromId, toId);
  return this.connections.length > before;
}

disconnectNodes(fromId, toId) {
  const removed = this.connections.filter(item => item.from === fromId && item.to === toId);
  if (!removed.length) return false;
  removed.forEach(item => document.getElementById(item.lineId)?.remove());
  this.connections = this.connections.filter(item => !(item.from === fromId && item.to === toId));
  removed.forEach(item => this.onConnectionDeleted?.(item.from, item.to));
  this._updateConnections();
  return true;
}

disconnectIncoming(nodeId) {
  const incoming = this.connections.filter(item => item.to === nodeId);
  incoming.forEach(item => this.disconnectNodes(item.from, item.to));
  return incoming.length;
}
```

Create one `ResizeObserver` in the constructor when available. Observe every new `.canvas-node`, unobserve on delete/restore, and call `_updateConnections()` from one queued `requestAnimationFrame` callback. Preserve the existing shared canvas/SVG transform.

- [ ] **Step 4: Add selected/compact CSS state**

Give image and video nodes a compact unselected presentation and a selected maximum width of 620px. Keep port dimensions fixed. Do not remove controls from the DOM; hide `.node-generation-expanded` when unselected so form state survives selection changes.

- [ ] **Step 5: Run focused and existing engine tests**

Run:

```powershell
node --check public/tools/ultimate-canvas/canvas-engine.js
npx tsx scripts/ultimate-canvas-generation-node-interactions-smoke.ts
npx tsx scripts/ultimate-canvas-complete-smoke.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```powershell
git add public/tools/ultimate-canvas/canvas-engine.js public/tools/ultimate-canvas/styles.css scripts/ultimate-canvas-generation-node-interactions-smoke.ts
git commit -m "feat: add expandable canvas node foundation"
```

---

### Task 4: Mode, Specification, and Camera Popovers

**Files:**
- Modify: `public/tools/ultimate-canvas/canvas-engine.js`
- Modify: `public/tools/ultimate-canvas/app.js`
- Modify: `public/tools/ultimate-canvas/styles.css`
- Modify: `public/tools/ultimate-canvas/index.html`
- Modify: `scripts/ultimate-canvas-generation-node-interactions-smoke.ts`

**Interfaces:**
- Adds `openGenerationPopover(nodeId, kind, anchor)` and `closeGenerationPopover()` in `app.js`.
- Adds `renderModePopover(node)`, `renderSpecPopover(node)`, and `renderCameraPopover(node)`.
- Consumes `UltimateCanvasGenerationInteractions.normalizeCapabilities` and `modeOptions`.

- [ ] **Step 1: Add failing popover assertions**

Require source markers for:

```ts
contains(engineSource, 'data-generation-popover="mode"', 'node exposes one mode trigger');
contains(engineSource, 'data-generation-popover="spec"', 'node exposes one specification trigger');
contains(appSource, 'function openGenerationPopover', 'app owns one anchored popover');
contains(appSource, 'function closeGenerationPopover', 'popover has one cleanup path');
contains(appSource, "case 'Escape'", 'Escape closes generation popovers');
contains(stylesSource, '.generation-popover', 'popover has viewport-safe styling');
excludes(engineSource, 'data-video-mode=', 'video generation modes are not permanently spread across the node');
```

- [ ] **Step 2: Run and verify RED**

Run the interaction smoke. Expected: FAIL because the popover triggers and controller are absent.

- [ ] **Step 3: Replace permanent controls with compact triggers**

In image/video templates, wrap editable controls in `.node-generation-expanded`. Replace video tab rows and permanent settings panels with:

```html
<button type="button" class="generation-summary-button" data-generation-popover="mode" aria-expanded="false">
  <span data-generation-mode-label>文生视频</span>
</button>
<button type="button" class="generation-summary-button" data-generation-popover="spec" aria-expanded="false">
  <span data-generation-spec>16:9 · 720p · 5s</span>
</button>
```

The model label remains read-only while bootstrap exposes one model. Keep prompt optimization, reference, camera, and submit controls.

- [ ] **Step 4: Implement one anchored popover controller**

Create a single `.generation-popover` appended to `document.body`. Store `{nodeId, kind, anchor}` in `canvasRuntime.generationPopover`. Position from `anchor.getBoundingClientRect()`, clamp left/top to 12px and right/bottom to viewport minus 12px, and close on outside pointer down, Escape, selection change, canvas pan/zoom, or resize.

Mode rows come from `modeOptions`. Disabled rows have `disabled`, `aria-disabled="true"`, and a `<small>` reason. Spec controls come from normalized capability arrays and write `node.data.imageSettings` or `node.data.videoSettings`. Camera rows call the existing preset selection path and use `replaceCameraLine` so only one `运镜：` line remains.

- [ ] **Step 5: Add responsive styling**

Style a restrained dark popover with maximum width `min(420px, calc(100vw - 24px))`, maximum height `min(560px, calc(100vh - 24px))`, internal scrolling, 8px or smaller corners, and a one-column mobile spec grid at 720px.

- [ ] **Step 6: Run focused regressions**

Run:

```powershell
node --check public/tools/ultimate-canvas/app.js
node --check public/tools/ultimate-canvas/canvas-engine.js
npx tsx scripts/ultimate-canvas-generation-node-interactions-smoke.ts
npx tsx scripts/ultimate-canvas-generation-node-workflow-smoke.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 4**

```powershell
git add public/tools/ultimate-canvas/app.js public/tools/ultimate-canvas/canvas-engine.js public/tools/ultimate-canvas/styles.css public/tools/ultimate-canvas/index.html scripts/ultimate-canvas-generation-node-interactions-smoke.ts
git commit -m "feat: add canvas generation popovers"
```

---

### Task 5: Canvas Reference Selection and Dynamic Mode Gating

**Files:**
- Modify: `public/tools/ultimate-canvas/app.js`
- Modify: `public/tools/ultimate-canvas/canvas-engine.js`
- Modify: `public/tools/ultimate-canvas/styles.css`
- Modify: `scripts/ultimate-canvas-generation-node-interactions-smoke.ts`
- Modify: `scripts/ultimate-canvas-preview-api-smoke.ts`

**Interfaces:**
- Adds `startReferenceSelection(targetNodeId)`.
- Adds `finishReferenceSelection(options)`.
- Adds `selectCanvasReference(sourceNodeId)`.
- Adds `removeGenerationReference(targetNodeId, sourceNodeId)`.
- Stores only durable connections/reference order; selection mode is transient.

- [ ] **Step 1: Add failing reference interaction assertions**

Assert source contains:

```ts
contains(appSource, 'function startReferenceSelection', 'reference command enters canvas selection mode');
contains(appSource, 'function finishReferenceSelection', 'reference mode has one cleanup path');
contains(appSource, 'function selectCanvasReference', 'compatible canvas nodes can be selected');
contains(appSource, 'function removeGenerationReference', 'individual references can be removed');
contains(appSource, '从画布选择参考', 'reference mode has visible status text');
contains(stylesSource, '.is-reference-compatible', 'compatible nodes are highlighted');
contains(stylesSource, '.is-reference-incompatible', 'incompatible nodes are visibly disabled');
contains(appSource, 'referenceRole(', 'first and last frames derive from ordered references');
```

Add a preview save/restore assertion that two incoming connections preserve order.

- [ ] **Step 2: Run and verify RED**

Run the interaction and preview API smokes. Expected: FAIL on missing selection-mode functions/order assertion.

- [ ] **Step 3: Implement the transient selection state**

Add `canvasRuntime.referenceSelection = null`. Starting selection stores the target node ID and previous selected ID, closes popovers, adds a top-center status bar, and marks image nodes:

```js
{
  targetNodeId,
  previousSelectedNodeId,
  maximumReferences,
  startedAt: Date.now(),
}
```

Use the engine selection callback to intercept a compatible image node while selection mode is active. A compatible image must have a stored `referenceImageId`. Duplicate nodes are ignored. At the maximum, leave selection mode and show the maximum reason. After each successful selection, call `engine.connectNodes(sourceNodeId, targetNodeId)`, return selection to the target, rerender controls, and schedule save.

Finish on Escape, explicit exit, target deletion, project/video-card switch, or successful max count. “返回节点” selects the target without ending mode; “退出” ends it.

- [ ] **Step 4: Render ordered removable chips and gate controls**

Each chip includes preview, title, `referenceRole(mode, index)`, and an icon-only remove button with tooltip. Removing calls `engine.disconnectNodes`. Recompute mode options whenever a connection changes. Disable invalid mode rows and disable submit when the selected mode is invalid; set the node status text to the first reason.

Keep the existing global asset-library auto-connect route operational by calling the public engine connection method.

- [ ] **Step 5: Run tests**

Run:

```powershell
npx tsx scripts/ultimate-canvas-generation-node-interactions-smoke.ts
npx tsx scripts/ultimate-canvas-preview-api-smoke.ts
npx tsx scripts/ultimate-canvas-generation-node-workflow-smoke.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 5**

```powershell
git add public/tools/ultimate-canvas/app.js public/tools/ultimate-canvas/canvas-engine.js public/tools/ultimate-canvas/styles.css scripts/ultimate-canvas-generation-node-interactions-smoke.ts scripts/ultimate-canvas-preview-api-smoke.ts
git commit -m "feat: add canvas reference selection mode"
```

---

### Task 6: Same-Node Results, Compact Quick Actions, and Persistence Safety

**Files:**
- Modify: `public/tools/ultimate-canvas/app.js`
- Modify: `public/tools/ultimate-canvas/canvas-engine.js`
- Modify: `public/tools/ultimate-canvas/styles.css`
- Modify: `scripts/ultimate-canvas-generation-node-interactions-smoke.ts`
- Modify: `scripts/ultimate-canvas-preview-api-smoke.ts`

**Interfaces:**
- `decorateGeneratedNode` updates the media/result region only.
- Compact quick actions select and configure a node; they never submit.
- `canvasDocumentPayload` uses `sanitizeSerializable` before JSON serialization.

- [ ] **Step 1: Add failing same-node assertions**

Assert:

```ts
contains(engineSource, 'data-generation-quick-mode', 'compact nodes expose quick mode choices');
contains(appSource, 'function applyGenerationQuickMode', 'quick choices only configure the node');
contains(appSource, 'sanitizeSerializable', 'canvas documents remove transient local URLs');
contains(appSource, 'data-generated-image-action="regenerate"', 'image results remain regeneratable');
contains(appSource, 'data-generation-submit', 'result nodes retain their generation submit control');
```

In the preview API smoke, pass a document containing `blob:` and `data:` values through `sanitizeSerializable` before POST, then assert the saved/restored JSON contains empty strings. The document API remains a storage boundary; sanitization belongs to the canvas client.

- [ ] **Step 2: Run and verify RED**

Run the interaction and preview API smokes. Expected: FAIL on quick-mode/sanitization behavior.

- [ ] **Step 3: Implement compact quick actions**

Unselected empty image nodes show `文字生成图片` and `使用参考图`; unselected empty video nodes show `首帧生成视频` and `首尾帧生成视频`. `applyGenerationQuickMode(nodeId, mode)` must select the node, set `node.data.mode`, render controls, open reference selection when the mode requires input, and schedule save. It must never call a generation endpoint.

- [ ] **Step 4: Preserve result and editor regions together**

Refactor `decorateGeneratedNode` to update a dedicated `[data-generation-result-region]` inside the node card without replacing `.node-generation-expanded`. Image/video status actions remain above the editable prompt when selected. Regenerate reuses the same node ID. “生成视频” creates and connects one downstream video node.

- [ ] **Step 5: Sanitize durable document JSON**

Before `JSON.stringify`, call `sanitizeSerializable` on the payload returned by `canvasDocumentPayload`. Do not mutate live node data. Keep HTTP(S), relative `/api/...`, IDs, numeric values, booleans, and null unchanged.

- [ ] **Step 6: Run tests**

Run:

```powershell
npx tsx scripts/ultimate-canvas-generation-node-interactions-smoke.ts
npx tsx scripts/ultimate-canvas-preview-api-smoke.ts
npx tsx scripts/ultimate-canvas-complete-smoke.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 6**

```powershell
git add public/tools/ultimate-canvas/app.js public/tools/ultimate-canvas/canvas-engine.js public/tools/ultimate-canvas/styles.css scripts/ultimate-canvas-generation-node-interactions-smoke.ts scripts/ultimate-canvas-preview-api-smoke.ts
git commit -m "feat: keep canvas results editable in place"
```

---

### Task 7: One Canvas-Level Video Polling Coordinator

**Files:**
- Create: `public/tools/ultimate-canvas/generation-task-coordinator.js`
- Create: `scripts/ultimate-canvas-generation-task-coordinator-smoke.ts`
- Modify: `public/tools/ultimate-canvas/index.html`
- Modify: `public/tools/ultimate-canvas/app.js`
- Modify: `scripts/ultimate-canvas-generation-node-interactions-smoke.ts`

**Interfaces:**
- Produces `createGenerationTaskCoordinator(options)`.
- Coordinator methods: `register(taskId, nodeId)`, `unregister(taskId)`, `clear()`, `has(taskId)`, `size()`, `runNow()`.
- `options`: `fetchStatus`, `onStatus`, `onError`, `isNodeAlive`, `isHidden`, `setTimer`, `clearTimer`, `delayFor`.

- [ ] **Step 1: Write a failing coordinator smoke test**

Create a deterministic test with injected timers and fetch function:

```ts
import assert from 'node:assert/strict';

const { createGenerationTaskCoordinator } = require('../public/tools/ultimate-canvas/generation-task-coordinator.js');

const statuses: string[] = [];
const calls: string[] = [];
let timer: (() => void) | null = null;
const coordinator = createGenerationTaskCoordinator({
  fetchStatus: async (taskId: string) => {
    calls.push(taskId);
    return { id: taskId, local_status: taskId === 'done' ? 'succeeded' : 'running' };
  },
  onStatus: (_nodeId: string, task: any) => statuses.push(task.local_status),
  onError: () => {},
  isNodeAlive: () => true,
  isHidden: () => false,
  setTimer: (callback: () => void) => { timer = callback; return 1; },
  clearTimer: () => { timer = null; },
  delayFor: () => 3000,
});

coordinator.register('done', 'node-1');
coordinator.register('running', 'node-2');
await coordinator.runNow();
assert.deepEqual(calls.sort(), ['done', 'running']);
assert.deepEqual(statuses.sort(), ['running', 'succeeded']);
assert.equal(coordinator.has('done'), false);
assert.equal(coordinator.has('running'), true);
assert.equal(typeof timer, 'function');
coordinator.clear();
assert.equal(coordinator.size(), 0);
assert.equal(timer, null);
```

- [ ] **Step 2: Run and verify RED**

Run:

```powershell
npx tsx scripts/ultimate-canvas-generation-task-coordinator-smoke.ts
```

Expected: FAIL with missing module.

- [ ] **Step 3: Implement the coordinator**

Use one timer for the coordinator. Each cycle snapshots active entries and calls `Promise.allSettled`. A terminal status (`succeeded`, `failed`, `cancelled`) unregisters that task after delivering `onStatus`. A missing node unregisters without fetch. One rejected fetch increments only that entry’s error count and calls `onError`; other tasks continue. Schedule the next timer with the minimum delay returned for active entries.

- [ ] **Step 4: Integrate with `app.js`**

Load the module before `app.js`. Replace per-task timer state in `pollVideoTask` with coordinator registration. `hydrateNodeViews` registers all nonterminal task nodes. Node deletion, context switch, and terminal status unregister. `stopAllVideoPolling` delegates to `coordinator.clear()`.

- [ ] **Step 5: Run coordinator and regression tests**

Run:

```powershell
node --check public/tools/ultimate-canvas/generation-task-coordinator.js
npx tsx scripts/ultimate-canvas-generation-task-coordinator-smoke.ts
npx tsx scripts/ultimate-canvas-generation-node-interactions-smoke.ts
npx tsx scripts/ultimate-canvas-preview-api-smoke.ts
npx tsx scripts/ultimate-canvas-generation-node-workflow-smoke.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 7**

```powershell
git add public/tools/ultimate-canvas/generation-task-coordinator.js public/tools/ultimate-canvas/index.html public/tools/ultimate-canvas/app.js scripts/ultimate-canvas-generation-task-coordinator-smoke.ts scripts/ultimate-canvas-generation-node-interactions-smoke.ts
git commit -m "feat: coordinate canvas task polling"
```

---

### Task 8: Lowest-Priority Cost Display, Browser QA, and Delivery Report

**Files:**
- Modify: `public/tools/ultimate-canvas/app.js`
- Modify: `public/tools/ultimate-canvas/styles.css`
- Modify: `public/tools/ultimate-canvas/index.html`
- Modify: `scripts/ultimate-canvas-preview-server.mjs`
- Modify: `scripts/ultimate-canvas-preview-api-smoke.ts`
- Modify: `scripts/ultimate-canvas-generation-node-interactions-smoke.ts`
- Modify: `docs/handoffs/ultimate-canvas-implementation-report.md`

**Interfaces:**
- Adds debounced `scheduleVideoEstimate(nodeId)`.
- Calls existing `/api/tasks/estimate?resolution=...&duration=...` only for video.
- Estimate failure is informational and never disables submit.

- [ ] **Step 1: Add failing estimate assertions**

Assert preview API returns `estimatedCost` for `/api/tasks/estimate`, and source contains:

```ts
contains(appSource, 'function scheduleVideoEstimate', 'video settings request a debounced estimate');
contains(appSource, "'/api/tasks/estimate'", 'estimate uses the existing sd2 endpoint');
contains(appSource, '预计', 'successful estimates are labeled clearly');
contains(appSource, '提交后由后台计算', 'estimate failure remains nonblocking');
```

- [ ] **Step 2: Run and verify RED**

Run the interaction and preview API smokes. Expected: FAIL because the preview endpoint/UI estimate handler is absent.

- [ ] **Step 3: Add the lowest-priority estimate display**

Debounce by 350ms per node. Fetch the existing endpoint with URL search params. Abort the previous estimate request for that node. On success store only `estimatedCost` and the settings signature in transient runtime state, render `预计 N 点`, and do not persist pricing formulas. On failure render `提交后由后台计算`. Image nodes continue to show `后台计费` until a stable image estimate endpoint exists.

Mirror `/api/tasks/estimate` in the preview server with `{ estimatedCost: Math.ceil(duration * 3) }` for browser QA only.

- [ ] **Step 4: Update all cache keys and report**

Set `styles.css`, `canvas-engine.js`, `generation-node-interactions.js`, `generation-node-workflow.js`, `generation-task-coordinator.js`, and `app.js` to cache key `20260711-liblib-interactions`. Update the implementation report with modified files, commands, results, real-call status, point usage, protected areas, unfinished online QA, and risks.

- [ ] **Step 5: Run the complete automated suite**

Run:

```powershell
git diff --check
node --check public/tools/ultimate-canvas/app.js
node --check public/tools/ultimate-canvas/canvas-engine.js
node --check public/tools/ultimate-canvas/generation-node-interactions.js
node --check public/tools/ultimate-canvas/generation-node-workflow.js
node --check public/tools/ultimate-canvas/generation-task-coordinator.js
node --check scripts/ultimate-canvas-preview-server.mjs
npx tsx scripts/ultimate-canvas-generation-node-interactions-smoke.ts
npx tsx scripts/ultimate-canvas-generation-task-coordinator-smoke.ts
npx tsx scripts/ultimate-canvas-generation-node-workflow-smoke.ts
npx tsx scripts/ultimate-canvas-preview-api-smoke.ts
npx tsx scripts/ultimate-canvas-complete-smoke.ts
npx tsx scripts/ultimate-canvas-normal-user-access-smoke.ts
npx tsx scripts/ultimate-canvas-context-rules-smoke.ts
npx tsx scripts/ultimate-canvas-video-card-workflow-smoke.ts
npx tsc --noEmit --pretty false
npm run lint
npm run build
```

Expected: all commands exit 0. Existing unrelated lint warnings may remain documented; no new warnings may come from modified files.

- [ ] **Step 6: Run browser QA on the preview server**

Start or restart:

```powershell
node scripts/ultimate-canvas-preview-server.mjs 4399
```

Verify the nine browser acceptance steps from the design: compact/expanded nodes, canvas reference selection, disabled modes/reasons, one popover/Escape, same-node image result, connected video creation, refresh polling recovery, 390px viewport, and zero new console errors/warnings. Do not call online sd2 or consume points.

- [ ] **Step 7: Commit Task 8**

```powershell
git add public/tools/ultimate-canvas/app.js public/tools/ultimate-canvas/styles.css public/tools/ultimate-canvas/index.html scripts/ultimate-canvas-preview-server.mjs scripts/ultimate-canvas-preview-api-smoke.ts scripts/ultimate-canvas-generation-node-interactions-smoke.ts docs/handoffs/ultimate-canvas-implementation-report.md
git commit -m "feat: complete canvas interaction workflow"
```

- [ ] **Step 8: Push or regenerate fallback patch**

Attempt:

```powershell
git push origin teammate/ultimate-canvas-complete
```

If GitHub still returns 403, regenerate `E:\Ultimate-canvas\ultimate-canvas-complete-final.patch` from `origin/teammate/ultimate-canvas-complete..HEAD`, validate it with `git apply --check --reverse --binary`, and report its SHA-256.
