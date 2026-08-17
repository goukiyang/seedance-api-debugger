# Ultimate Canvas Generation Nodes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing image and video canvas nodes complete real sd2 generation surfaces, including references, settings, submission, polling, results, retry, and persistence.

**Architecture:** Add one small browser/CommonJS contract module for deterministic mode mapping, validation, request construction, and response normalization. Keep DOM ownership in the existing `CanvasEngine` and `app.js`; use current canvas connections as the reference graph and current same-origin sd2 endpoints as the only model boundary.

**Tech Stack:** Vanilla JavaScript, existing CanvasEngine, Next.js 14 API routes, TypeScript smoke scripts, local in-memory preview server.

## Global Constraints

- Enhance the current image/video nodes in place; do not add a page, workflow, or embedded React generator.
- Production model calls use only sd2 same-origin `/api/...` routes.
- Ordinary accounts use existing project, video-card, task, asset, and credit permissions.
- Do not read or modify `.env`, admin API settings, credit core logic, provider secrets, `package.json`, lockfiles, or database schema.
- Every visible generation-node command must work or be explicitly disabled with a reason.
- Automated tests use local mock data and must not consume real points.

---

### Task 1: Generation Node Contracts

**Files:**
- Create: `public/tools/ultimate-canvas/generation-node-workflow.js`
- Create: `scripts/smoke/ultimate-canvas-generation-node-workflow-smoke.ts`
- Modify: `public/tools/ultimate-canvas/index.html`

**Interfaces:**
- Produces: `UltimateCanvasGenerationNodes.imageRequest(input)`, `videoRequest(input)`, `validateImage(input)`, `validateVideo(input)`, `normalizeImageResult(result)`, `normalizeVideoCreate(result)`, `normalizeVideoStatus(result)`.
- Consumes: project/video-card/branch/document context, node settings, and ordered reference IDs from `app.js`.

- [ ] **Step 1: Write the failing contract smoke**

Assert exact image actions, video generation modes, settings, context fields, reference ordering, source metadata, and normalized asset/task identifiers.

```ts
assert.deepEqual(workflow.videoRequest({
  mode: 'first-last-frame-video', prompt: 'move', projectId: 'p', cardId: 'c',
  nodeId: 'n', referenceImageIds: ['first', 'last'], settings: { ratio: '9:16', duration: 5, resolution: '720p' },
}), {
  url: '/api/tasks/create', method: 'POST', payload: expectFirstLastFramePayload,
});
```

- [ ] **Step 2: Run the smoke and verify RED**

Run: `npx tsx scripts/smoke/ultimate-canvas-generation-node-workflow-smoke.ts`

Expected: FAIL because `generation-node-workflow.js` does not exist.

- [ ] **Step 3: Implement the UMD/CommonJS contract module**

Implement whitelisted image/video modes, validation, request payloads, result normalization, and no provider/key/base-URL fields.

- [ ] **Step 4: Load the module before `app.js` and verify GREEN**

Run: `node --check public/tools/ultimate-canvas/generation-node-workflow.js` and `npx tsx scripts/smoke/ultimate-canvas-generation-node-workflow-smoke.ts`.

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add public/tools/ultimate-canvas/generation-node-workflow.js public/tools/ultimate-canvas/index.html scripts/smoke/ultimate-canvas-generation-node-workflow-smoke.ts
git commit -m "feat: add canvas generation node contracts"
```

### Task 2: Functional Node Controls

**Files:**
- Modify: `public/tools/ultimate-canvas/canvas-engine.js`
- Modify: `public/tools/ultimate-canvas/styles.css`
- Test: `scripts/smoke/ultimate-canvas-generation-node-workflow-smoke.ts`

**Interfaces:**
- Produces stable `data-generation-*` controls consumed by `app.js`.
- Consumes bootstrap labels and node data during hydration.

- [ ] **Step 1: Add failing source assertions**

Require image/video settings panels, ordered reference strips, prompt optimization, camera presets, asset selection, retry, result actions, and no old inert labels.

- [ ] **Step 2: Run the smoke and verify RED**

Expected: FAIL on missing `data-generation-settings`, `data-generation-reference-list`, and command attributes.

- [ ] **Step 3: Replace static controls with explicit node controls**

Image nodes expose modes, reference selection, settings, prompt, generation, and result actions. Video nodes expose modes, prompt optimization, camera presets, reference selection, settings, and generation. Settings use native `select`, checkbox, and number controls.

- [ ] **Step 4: Add bounded responsive styles**

Keep controls within the existing 640px panel; use a single column below 720px and stable preview/reference dimensions.

- [ ] **Step 5: Verify and commit**

```powershell
node --check public/tools/ultimate-canvas/canvas-engine.js
npx tsx scripts/smoke/ultimate-canvas-generation-node-workflow-smoke.ts
git add public/tools/ultimate-canvas/canvas-engine.js public/tools/ultimate-canvas/styles.css scripts/smoke/ultimate-canvas-generation-node-workflow-smoke.ts
git commit -m "feat: add functional generation node controls"
```

### Task 3: Image Node Real Workflow

**Files:**
- Modify: `public/tools/ultimate-canvas/app.js`
- Test: `scripts/smoke/ultimate-canvas-generation-node-workflow-smoke.ts`

**Interfaces:**
- Consumes `UltimateCanvasGenerationNodes.imageRequest()` and direct incoming image connections.
- Produces persisted image settings and asset identifiers for downstream video nodes.

- [ ] **Step 1: Add failing image workflow assertions**

Require settings persistence, ordered reference collection, material-panel targeting, request dispatch through the contract module, normalized result writeback, open/download/regenerate, and create-connected-video actions.

- [ ] **Step 2: Run the smoke and verify RED**

Expected: FAIL because the handlers and request module calls are absent.

- [ ] **Step 3: Implement image state, validation, and request dispatch**

Store `imageSettings = { ratio, size, count }`, mode, prompt, and reference summary in node data. Validate `image-to-image` and `upscale-image` require an incoming `reference_image_id`.

- [ ] **Step 4: Implement asset selection and result actions**

Selecting an existing asset while a target node is active creates an image node and connection. Success writes asset/reference/workspace IDs and URLs. “生成视频” creates and connects a video node.

- [ ] **Step 5: Verify and commit**

```powershell
node --check public/tools/ultimate-canvas/app.js
npx tsx scripts/smoke/ultimate-canvas-generation-node-workflow-smoke.ts
git add public/tools/ultimate-canvas/app.js scripts/smoke/ultimate-canvas-generation-node-workflow-smoke.ts
git commit -m "feat: complete canvas image generation node"
```

### Task 4: Video Node Real Workflow

**Files:**
- Modify: `public/tools/ultimate-canvas/app.js`
- Test: `scripts/smoke/ultimate-canvas-generation-node-workflow-smoke.ts`

**Interfaces:**
- Consumes `UltimateCanvasGenerationNodes.videoRequest()` and ordered image reference IDs.
- Produces persisted task identity/status/result and restartable polling.

- [ ] **Step 1: Add failing video workflow assertions**

Require mode persistence, video settings, ordered first/last frames, prompt optimization, camera preset persistence, real create request, normalized status, retry/regenerate, and restored polling.

- [ ] **Step 2: Run the smoke and verify RED**

Expected: FAIL on missing handlers and contract calls.

- [ ] **Step 3: Implement video settings and references**

Store `videoSettings = { ratio, duration, resolution, generateAudio, returnLastFrame, watermark }`. Render connected image references in connection order and validate mode-specific minimums.

- [ ] **Step 4: Implement prompt tools and task lifecycle**

Optimization calls `/api/tools/ultimate-canvas/generate` with `kind: text`, writes returned text back, and leaves it editable. Camera presets append deterministic prompt text. Task creation and polling use normalized contract results and retain inputs after errors.

- [ ] **Step 5: Implement result and retry actions**

Show task details, play, download, frozen points, regenerate, and terminal state. Regenerate creates a new idempotent request from the same node settings rather than hiding the original input.

- [ ] **Step 6: Verify and commit**

```powershell
node --check public/tools/ultimate-canvas/app.js
npx tsx scripts/smoke/ultimate-canvas-generation-node-workflow-smoke.ts
git add public/tools/ultimate-canvas/app.js scripts/smoke/ultimate-canvas-generation-node-workflow-smoke.ts
git commit -m "feat: complete canvas video generation node"
```

### Task 5: Local API and Restore Integration

**Files:**
- Modify: `scripts/ultimate-canvas-preview-server.mjs`
- Modify: `scripts/smoke/ultimate-canvas-preview-api-smoke.ts`
- Modify: `scripts/smoke/ultimate-canvas-complete-smoke.ts`

**Interfaces:**
- Preview server mirrors only the same-origin contracts needed by the page.
- Smoke verifies document restore includes node settings, image assets, and video task state.

- [ ] **Step 1: Add failing preview API assertions**

Assert image payload/action/settings/references, video payload/settings/references, running-to-succeeded status, and document save/restore.

- [ ] **Step 2: Run and verify RED**

Run: `npx tsx scripts/smoke/ultimate-canvas-preview-api-smoke.ts`.

Expected: FAIL on missing captured request fields or response metadata.

- [ ] **Step 3: Extend preview server memory responses**

Record submitted image/video payloads, return complete image asset identifiers/URLs, and expose task state transitions without network or points.

- [ ] **Step 4: Verify all canvas smokes and commit**

```powershell
npx tsx scripts/smoke/ultimate-canvas-generation-node-workflow-smoke.ts
npx tsx scripts/smoke/ultimate-canvas-preview-api-smoke.ts
npx tsx scripts/smoke/ultimate-canvas-complete-smoke.ts
npx tsx scripts/smoke/ultimate-canvas-normal-user-access-smoke.ts
npx tsx scripts/smoke/ultimate-canvas-context-rules-smoke.ts
git add scripts/ultimate-canvas-preview-server.mjs scripts/smoke/ultimate-canvas-preview-api-smoke.ts scripts/smoke/ultimate-canvas-complete-smoke.ts
git commit -m "test: verify canvas generation node lifecycle"
```

### Task 6: Browser QA and Delivery

**Files:**
- Modify: `docs/handoffs/ultimate-canvas-implementation-report.md`

**Interfaces:**
- Delivers verified local UI, final report, local branch commits, and a complete patch when push is unavailable.

- [ ] **Step 1: Restart local preview and test the existing canvas**

Create one image node and one video node. Exercise modes, settings, references, image result, video submission, polling, terminal result, regenerate, save, reload, and restored state.

- [ ] **Step 2: Check desktop and mobile layout**

Verify no page-level horizontal overflow and no control overlap at the default viewport and 390x844.

- [ ] **Step 3: Run final verification**

```powershell
git diff --check
node --check public/tools/ultimate-canvas/app.js
node --check public/tools/ultimate-canvas/canvas-engine.js
node --check public/tools/ultimate-canvas/generation-node-workflow.js
npx tsc --noEmit --pretty false
npm run lint
npm run build
```

- [ ] **Step 4: Update report and commit**

State exactly whether online generation ran, whether points were used, and confirm protected files were untouched.

- [ ] **Step 5: Push or regenerate the complete patch**

Attempt `git push origin teammate/ultimate-canvas-complete`. On 403, preserve the branch and regenerate `E:\Ultimate-canvas\ultimate-canvas-complete-final.patch`, then verify reverse application and SHA256.
