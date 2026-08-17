# Ultimate Canvas Ratio-Aware Node Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resize image/video cards from their selected generation ratio, keep the prompt panel's original 640px desktop layout unchanged, and move video task actions into a `更多` menu in the prompt toolbar.

**Architecture:** Add pure ratio and task-action helpers to the existing generation interaction module. `app.js` derives presentation from already-persisted node settings, writes dimensions to the existing node DOM, and extends the existing single-generation-popover flow for task actions. CSS consumes derived dimensions and keeps prompt panels independent from media ratio.

**Tech Stack:** Browser JavaScript, CSS custom properties, existing CanvasEngine, Node/tsx semantic smoke tests, Next.js 14 build.

## Global Constraints

- Work only in the existing Ultimate Canvas workflow; do not add a second generation flow.
- Desktop node-card long edge is exactly `350px`; narrow viewports cap it at `window.innerWidth - 24`.
- Prompt/settings panels retain the original `640px` desktop width and natural height, keep the existing `min(640px, calc(100vw - 24px))` narrow-viewport cap, and never receive a media aspect ratio.
- Invalid or missing ratios fall back to `16:9`.
- Video task actions leave the media card and appear only through the prompt-toolbar `更多` menu.
- Preserve normal-user permissions and existing task-state gating.
- Do not read or modify `.env`, API/admin settings, provider secrets, credit rules, database schema, backend generation/pricing/provider routes, package metadata, or lockfiles.
- Do not run online generation or paid retry during verification.

---

### Task 1: Pure Ratio Dimension Contract

**Files:**
- Modify: `public/tools/ultimate-canvas/generation-node-interactions.js`
- Test: `scripts/smoke/ultimate-canvas-generation-node-interactions-smoke.ts`
- Test: `scripts/smoke/ultimate-canvas-result-layout-smoke.ts`

**Interfaces:**
- Produces: `generationNodeDimensions(ratio, longEdge = 350)` returning `{ ratio, numerator, denominator, width, height }`.
- Consumes: the existing supported ratio set `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16`.

- [ ] **Step 1: Write the failing ratio tests**

Add executable assertions before production changes:

```ts
assert.deepEqual(interactions.generationNodeDimensions('16:9'), {
  ratio: '16:9', numerator: 16, denominator: 9, width: 350, height: 196.875,
});
assert.deepEqual(interactions.generationNodeDimensions('9:16'), {
  ratio: '9:16', numerator: 9, denominator: 16, width: 196.875, height: 350,
});
assert.deepEqual(interactions.generationNodeDimensions('1:1'), {
  ratio: '1:1', numerator: 1, denominator: 1, width: 350, height: 350,
});
assert.deepEqual(interactions.generationNodeDimensions('9:16', 296), {
  ratio: '9:16', numerator: 9, denominator: 16, width: 166.5, height: 296,
});
assert.equal(interactions.generationNodeDimensions('bad').ratio, '16:9');
assert.equal(interactions.generationNodeDimensions('16:9', 0).width, 350);
```

- [ ] **Step 2: Run the focused smoke and verify RED**

Run: `npx tsx scripts/smoke/ultimate-canvas-generation-node-interactions-smoke.ts`

Expected: FAIL because `generationNodeDimensions` is not exported.

- [ ] **Step 3: Implement and export the pure helper**

Add the helper beside the existing generation interaction constants:

```js
const GENERATION_RATIOS = Object.freeze({
    '21:9': [21, 9], '16:9': [16, 9], '4:3': [4, 3],
    '1:1': [1, 1], '3:4': [3, 4], '9:16': [9, 16]
});

function generationNodeDimensions(ratio, longEdge = 350) {
    const normalizedRatio = Object.hasOwn(GENERATION_RATIOS, clean(ratio)) ? clean(ratio) : '16:9';
    const [numerator, denominator] = GENERATION_RATIOS[normalizedRatio];
    const edge = Number.isFinite(Number(longEdge)) && Number(longEdge) > 0 ? Number(longEdge) : 350;
    const scale = edge / Math.max(numerator, denominator);
    const round = value => Math.round(value * 1000) / 1000;
    return {
        ratio: normalizedRatio,
        numerator,
        denominator,
        width: round(numerator * scale),
        height: round(denominator * scale)
    };
}
```

Add `generationNodeDimensions` to the returned public API.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```powershell
npx tsx scripts/smoke/ultimate-canvas-generation-node-interactions-smoke.ts
npx tsx scripts/smoke/ultimate-canvas-result-layout-smoke.ts
```

Expected: both exit 0.

- [ ] **Step 5: Commit Task 1**

```powershell
git add public/tools/ultimate-canvas/generation-node-interactions.js scripts/smoke/ultimate-canvas-generation-node-interactions-smoke.ts scripts/smoke/ultimate-canvas-result-layout-smoke.ts
git commit -m "feat: add canvas ratio dimension contract"
```

---

### Task 2: Ratio-Aware Cards and Unchanged Prompt Panels

**Files:**
- Modify: `public/tools/ultimate-canvas/app.js:3057-3129, 4088-4089`
- Modify: `public/tools/ultimate-canvas/styles.css:1517-1610, 1682-1795, 2144-2160, 3943-4026`
- Test: `scripts/smoke/ultimate-canvas-result-layout-smoke.ts`
- Test: `scripts/smoke/ultimate-canvas-generation-node-interactions-smoke.ts`

**Interfaces:**
- Consumes: `generationNodeDimensions(ratio, longEdge)` from Task 1.
- Produces: CSS variables `--generation-node-width`, `--generation-node-height`, and `data-generation-ratio` on each image/video `.canvas-node`.

- [ ] **Step 1: Write failing DOM/CSS contract assertions**

Assert the production source calls the helper and writes both CSS variables:

```ts
contains(appSource, 'generationNodeDimensions(settings.ratio, generationNodeLongEdge())', 'render derives card dimensions from current settings');
contains(appSource, "setProperty('--generation-node-width'", 'render writes node width');
contains(appSource, "setProperty('--generation-node-height'", 'render writes node height');
```

Update the AST-based CSS smoke to require:

```ts
assertDeclarations(baseCards, {
  width: 'var(--generation-node-width, 350px)',
  height: 'var(--generation-node-height, 196.875px)',
});
assertDeclarations(ruleWith(['.node-video-props', '.node-image-props']), {
  width: '640px',
  'margin-left': '0',
  left: '50%',
  transform: 'translateX(-50%)',
});
```

Also reject selected-only width/height declarations and require the card body/result region to fill the derived card without changing selection size.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx tsx scripts/smoke/ultimate-canvas-result-layout-smoke.ts`

Expected: FAIL because cards still use fixed `350x240` dimensions and panels are not centered with `left: 50%`.

- [ ] **Step 3: Apply dimensions during existing renders**

Add these functions in `app.js` near `generationSettingsForNode`:

```js
function generationNodeLongEdge() {
    return Math.max(1, Math.min(350, window.innerWidth - 24));
}

function applyGenerationNodeDimensions(nodeEl, settings) {
    const dimensions = window.UltimateCanvasGenerationInteractions
        .generationNodeDimensions(settings?.ratio, generationNodeLongEdge());
    nodeEl.style.setProperty('--generation-node-width', `${dimensions.width}px`);
    nodeEl.style.setProperty('--generation-node-height', `${dimensions.height}px`);
    nodeEl.dataset.generationRatio = dimensions.ratio;
    return dimensions;
}
```

Call `applyGenerationNodeDimensions(nodeEl, settings)` immediately after `generationSettingsForNode(node)` in `renderGenerationNodeControls`.

Replace the current resize listener with one requestAnimationFrame-coalesced rerender:

```js
let generationResizeFrame = 0;
window.addEventListener('resize', () => {
    closeGenerationPopover();
    window.cancelAnimationFrame(generationResizeFrame);
    generationResizeFrame = window.requestAnimationFrame(renderAllGenerationNodeControls);
});
```

- [ ] **Step 4: Make CSS consume dimensions and isolate panel size**

Replace fixed card sizing with:

```css
.node-type-video .node-card,
.node-type-image .node-card {
    width: var(--generation-node-width, 350px);
    height: var(--generation-node-height, 196.875px);
}
```

Remove selected-only card dimension overrides. Set `.node-body` and nonempty `.generation-result-region` to `height: 100%; min-height: 0; overflow: hidden`. Keep generated media `object-fit: contain` and constrain top metadata with ellipsis.

Unify prompt panels:

```css
.node-video-props,
.node-image-props {
    width: 640px;
    max-width: min(640px, calc(100vw - 24px));
    margin-top: 16px;
    margin-left: 0;
    left: 50%;
    transform: translateX(-50%);
}
```

Preserve the existing desktop row and toolbar layout; retain existing narrow-viewport wrapping only. Do not apply `aspect-ratio` to prompt panels.

- [ ] **Step 5: Verify focused and interaction smokes**

Run:

```powershell
npx tsx scripts/smoke/ultimate-canvas-result-layout-smoke.ts
npx tsx scripts/smoke/ultimate-canvas-generation-node-interactions-smoke.ts
npx tsx scripts/smoke/ultimate-canvas-complete-smoke.ts
```

Expected: all exit 0.

- [ ] **Step 6: Commit Task 2**

```powershell
git add public/tools/ultimate-canvas/app.js public/tools/ultimate-canvas/styles.css scripts/smoke/ultimate-canvas-result-layout-smoke.ts scripts/smoke/ultimate-canvas-generation-node-interactions-smoke.ts
git commit -m "feat: size canvas nodes from generation ratio"
```

---

### Task 3: Prompt-Toolbar Video Task Menu

**Files:**
- Modify: `public/tools/ultimate-canvas/generation-node-interactions.js`
- Modify: `public/tools/ultimate-canvas/app.js:1882-1998, 3057-3256, 3968-4089, 5753-5802`
- Modify: `public/tools/ultimate-canvas/styles.css:1838-1968`
- Test: `scripts/smoke/ultimate-canvas-generation-node-interactions-smoke.ts`
- Test: `scripts/smoke/ultimate-canvas-result-layout-smoke.ts`

**Interfaces:**
- Produces: `videoTaskActionAvailability(context)` returning URLs and permission-gated command booleans.
- Produces: `renderVideoTaskActionsPopover(node)` and a `[data-generation-popover="task-actions"]` trigger in the existing prompt toolbar.
- Produces: `syncVideoTaskActionsTrigger(nodeEl, node, overrides = {})` so both control rerenders and result decoration keep the trigger current.
- Reuses: existing `[data-generated-task-retry]` and `[data-generated-task-version]` delegated handlers.

- [ ] **Step 1: Write failing action-availability and source assertions**

Add pure behavior tests:

```ts
assert.deepEqual(interactions.videoTaskActionAvailability({
  taskId: 'task-1', status: 'succeeded', previewUrl: '/play', downloadUrl: '/download', canRetry: true, canManage: true,
}), {
  taskId: 'task-1', detailUrl: '/tasks?task=task-1', previewUrl: '/play', downloadUrl: '/download', canRetry: true, canMarkVersion: true,
});
assert.equal(interactions.videoTaskActionAvailability({ taskId: '', status: 'succeeded' }), null);
assert.equal(interactions.videoTaskActionAvailability({ taskId: 'task-2', status: 'running', canRetry: true }).canRetry, false);
assert.equal(interactions.videoTaskActionAvailability({ taskId: 'task-3', status: 'failed', canRetry: true }).canRetry, true);
```

Add source/markup assertions proving:

- `decorateGeneratedNode` no longer inserts `taskActions` or `generatedButtons` into `.generated-reference-card`.
- The video prompt toolbar renders `更多` with `data-generation-popover="task-actions"` after `清空参考`.
- `openGenerationPopover` has an explicit `task-actions` rendering branch.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx tsx scripts/smoke/ultimate-canvas-generation-node-interactions-smoke.ts`

Expected: FAIL because `videoTaskActionAvailability` and the task-actions popover do not exist.

- [ ] **Step 3: Implement the pure permission/state model**

Add and export:

```js
function videoTaskActionAvailability(context = {}) {
    const taskId = clean(context.taskId);
    if (!taskId) return null;
    const status = normalizedGenerationStatus(context.status);
    const terminal = ['succeeded', 'failed', 'cancelled'].includes(status);
    return {
        taskId,
        detailUrl: `/tasks?task=${encodeURIComponent(taskId)}`,
        previewUrl: clean(context.previewUrl),
        downloadUrl: clean(context.downloadUrl),
        canRetry: context.canRetry === true && terminal,
        canMarkVersion: context.canManage === true && status === 'succeeded'
    };
}
```

- [ ] **Step 4: Render the `更多` trigger and menu through the existing popover**

Create `videoTaskActionsForNode(node, overrides = {})` in `app.js`. It reads `node.data.taskId`, `generationStatus`, `videoPreviewUrl`, `videoDownloadUrl`, and fallbacks from `node.data.generationResult` (`play_url`, `playUrl`, `result_video_url`, `resultVideoUrl`, `download_url`, `downloadUrl`). Explicit `decorateGeneratedNode` options override stored URLs. It also reads selected card detail/summary permissions and calls the pure helper.

In `renderGenerationNodeControls`, remove any previous task trigger, then append this button to the video `.generation-node-toolbar` when actions exist:

```html
<button type="button" class="generation-command generation-task-more"
        data-generation-popover="task-actions" aria-expanded="false">更多</button>
```

Add `renderVideoTaskActionsPopover(node)` returning one `.generation-popover-list.generation-task-action-menu` with:

- anchors for detail, preview, and download;
- retry using `data-generated-task-retry`, `data-node-id`, and `data-card-id`;
- candidate/best/final using the existing `data-generated-task-version`, `data-task-id`, `data-node-id`, and `data-card-id` attributes.

Add the explicit branch in `openGenerationPopover` and reject unknown kinds with empty markup:

```js
element.innerHTML = kind === 'mode' ? renderModePopover(node)
    : kind === 'spec' ? renderSpecPopover(node)
        : kind === 'camera' ? renderCameraPopover(node)
            : kind === 'task-actions' ? renderVideoTaskActionsPopover(node)
                : '';
```

Close the popover when a generated retry/version command is chosen and when a task link is activated. Existing outside-pointer, Escape, node-selection, wheel, and resize closures remain unchanged.

- [ ] **Step 5: Remove video task controls from media-card markup**

In `decorateGeneratedNode`, retain `imageActions` but remove `taskActions` and `generatedButtons` from the generated-reference-card template. After updating the result region, call `syncVideoTaskActionsTrigger(nodeEl, node, options)` for video nodes so refresh, restore, polling, and initial submission paths update the `更多` trigger even when they do not call the full control renderer afterward. Preserve all node task data and current permission rules; presentation is the only change.

- [ ] **Step 6: Style the red-box placement and menu**

Add:

```css
.generation-task-more { margin-left: auto; }
.generation-task-action-menu { min-width: 190px; }
.generation-task-action-menu a,
.generation-task-action-menu button { width: 100%; justify-content: flex-start; }
```

Use existing popover colors, radius, focus, hover, and viewport positioning. Do not add a second menu container or overlay system.

- [ ] **Step 7: Verify focused smokes**

Run:

```powershell
npx tsx scripts/smoke/ultimate-canvas-generation-node-interactions-smoke.ts
npx tsx scripts/smoke/ultimate-canvas-result-layout-smoke.ts
npx tsx scripts/smoke/ultimate-canvas-video-card-workflow-smoke.ts
```

Expected: all exit 0; task actions are absent from media-card markup and present in the task popover contract.

- [ ] **Step 8: Commit Task 3**

```powershell
git add public/tools/ultimate-canvas/generation-node-interactions.js public/tools/ultimate-canvas/app.js public/tools/ultimate-canvas/styles.css scripts/smoke/ultimate-canvas-generation-node-interactions-smoke.ts scripts/smoke/ultimate-canvas-result-layout-smoke.ts
git commit -m "feat: move video task actions into prompt menu"
```

---

### Task 4: Full Verification, Browser Acceptance, and Delivery

**Files:**
- Modify: `docs/handoffs/ultimate-canvas-implementation-report.md`
- Regenerate: `E:\Ultimate-canvas\ultimate-canvas-complete-final.patch`

**Interfaces:**
- Consumes: completed ratio sizing, fixed prompt panel, and task menu from Tasks 1-3.
- Produces: verified branch commit, updated handoff report, and validated full patch.

- [ ] **Step 1: Run all automated checks**

Run all 11 smoke scripts, then:

```powershell
npx tsc --noEmit --pretty false
npm run lint
npm run build
git diff --check
```

Expected: all commands exit 0. Existing unrelated lint warnings may remain; Ultimate Canvas changes add no new warnings.

- [ ] **Step 2: Perform desktop browser acceptance**

Using the local preview only:

1. Set a video node to `16:9`, `1:1`, and `9:16`; confirm dimensions are `350x196.875`, `350x350`, and `196.875x350` before canvas zoom.
2. Select and deselect each node; dimensions must not change.
3. Confirm the prompt panel remains 640px wide on desktop and centered under the card.
4. Confirm the video result card contains no task links/buttons.
5. Click prompt-toolbar `更多`; verify detail/preview/download and permitted retry/version actions.
6. Close with outside click and Escape; verify a second generation popover replaces the first.
7. Confirm connectors remain centered after ratio changes.

Expected: all checks pass and browser warning/error log is empty.

- [ ] **Step 3: Perform 390px browser acceptance**

Set viewport to `390x844`, fit the canvas, and verify:

- document client width equals scroll width (`390`);
- long edge remains `350`;
- prompt panel uses the existing `366px` viewport cap and remains centered;
- task menu stays inside 12px viewport margins.

Reset the viewport afterward.

- [ ] **Step 4: Update the handoff report**

Append a dated section recording:

- root cause and final layout rules;
- exact files changed;
- TDD RED/GREEN evidence;
- automated and browser commands/results;
- no real generation and zero points;
- protected areas untouched;
- remote push status and patch path.

- [ ] **Step 5: Commit documentation and regenerate the full patch**

```powershell
git add docs/handoffs/ultimate-canvas-implementation-report.md
git commit -m "docs: record ratio node browser acceptance"
git diff --binary origin/teammate/ultimate-canvas-complete..HEAD --output=E:/Ultimate-canvas/ultimate-canvas-complete-final.patch
git apply --check --reverse --binary E:/Ultimate-canvas/ultimate-canvas-complete-final.patch
Get-FileHash E:/Ultimate-canvas/ultimate-canvas-complete-final.patch -Algorithm SHA256
```

Expected: commit succeeds, reverse patch check exits 0, and SHA-256 is reported.
