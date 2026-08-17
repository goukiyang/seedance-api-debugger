# Ultimate Canvas Video Controls Footer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the video mode and specification buttons from the top of the selected video editor into the center of its footer without changing their behavior.

**Architecture:** Reuse the existing `.generation-summary-row` and all `data-generation-*` hooks, but place that row between model information and submit controls in the video footer. Scope new grid and responsive declarations to `.video-props-footer` so the image editor's top summary row is unchanged.

**Tech Stack:** Static HTML templates in JavaScript, CSS, Node/TypeScript semantic smoke tests, local preview server, in-app browser QA.

## Global Constraints

- Preserve existing video mode/specification popovers, state updates, payloads, backend endpoints, pricing, authentication, and persistence.
- Do not duplicate the controls or introduce a second state source.
- Do not change the image node footer or image summary layout.
- Desktop footer order is model information, generation settings, then cost and submit controls.
- Narrow layouts may use two rows, but must not overlap or push submit controls outside the editor.

---

### Task 1: Move Video Settings Into the Footer

**Files:**
- Modify: `scripts/smoke/ultimate-canvas-result-layout-smoke.ts`
- Modify: `scripts/smoke/ultimate-canvas-generation-node-workflow-smoke.ts`
- Modify: `scripts/smoke/ultimate-canvas-context-rules-smoke.ts`
- Modify: `scripts/smoke/ultimate-canvas-video-card-workflow-smoke.ts`
- Modify: `public/tools/ultimate-canvas/canvas-engine.js:787-822`
- Modify: `public/tools/ultimate-canvas/styles.css:1732-1754,1800-1806,2140-2144`
- Modify: `public/tools/ultimate-canvas/index.html:11,304`

**Interfaces:**
- Consumes: Existing `data-generation-popover`, `data-generation-command`, `data-generation-settings`, `data-generation-mode-label`, and `data-generation-spec` event hooks.
- Produces: One `.generation-summary-row` inside `.video-props-footer`, centered between `.video-model-info` and `.video-footer-right`.

- [ ] **Step 1: Write the failing semantic layout and cache tests**

Add source-order assertions to `ultimate-canvas-result-layout-smoke.ts`:

```ts
const engineSource = readFileSync('public/tools/ultimate-canvas/canvas-engine.js', 'utf8');
const videoTemplateStart = engineSource.indexOf("if (type === 'video') return `");
const imageTemplateStart = engineSource.indexOf("if (type === 'image') return `", videoTemplateStart);
const videoTemplate = engineSource.slice(videoTemplateStart, imageTemplateStart);
const toolbarStart = videoTemplate.indexOf('class="generation-node-toolbar"');
const footerStart = videoTemplate.indexOf('class="video-props-footer"');
const modelStart = videoTemplate.indexOf('class="video-model-info"', footerStart);
const summaryStart = videoTemplate.indexOf('class="generation-summary-row"');
const footerRightStart = videoTemplate.indexOf('class="video-footer-right"', footerStart);

assert.ok(toolbarStart < footerStart, 'video toolbar remains above the footer');
assert.ok(footerStart < modelStart, 'video model remains inside the footer');
assert.ok(modelStart < summaryStart, 'video settings follow the model label');
assert.ok(summaryStart < footerRightStart, 'video settings precede cost and submit controls');
```

Add CSS assertions:

```ts
assertDeclarations(ruleWith(['.video-props-footer']), {
  display: 'grid',
  'grid-template-columns': 'minmax(0, 1fr) auto minmax(0, 1fr)',
});
assertDeclarations(ruleWith(['.video-props-footer .generation-summary-row']), {
  padding: '0',
  'border-bottom': '0',
  'justify-self': 'center',
});
assertDeclarations(ruleWith(['.video-props-footer .video-footer-right']), {
  'justify-self': 'end',
});
```

Update the existing `styles.css` and `canvas-engine.js` cache assertions across the three listed workflow/context smoke files to `20260713-video-footer-controls`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
npx tsx scripts/smoke/ultimate-canvas-result-layout-smoke.ts
npx tsx scripts/smoke/ultimate-canvas-generation-node-workflow-smoke.ts
npx tsx scripts/smoke/ultimate-canvas-context-rules-smoke.ts
npx tsx scripts/smoke/ultimate-canvas-video-card-workflow-smoke.ts
```

Expected: at least the layout smoke fails because the summary occurs before the footer and the footer still uses flex; cache tests fail because `index.html` still uses `20260711-liblib-interactions`.

- [ ] **Step 3: Move the existing markup and add scoped footer layout**

In the video template, remove the summary row above `.generation-node-toolbar` and insert the unchanged row after `.video-model-info` inside `.video-props-footer`:

```html
<div class="video-props-footer">
    <div class="video-model-info">
        <span class="model-icon">📊</span>
        <span>默认视频 API</span>
    </div>
    <div class="generation-summary-row">
        <button type="button" class="generation-summary-button" data-generation-popover="mode" aria-expanded="false">
            <span data-generation-mode-label>文生视频</span>
        </button>
        <button type="button" class="generation-summary-button" data-generation-command="toggle-settings" data-generation-settings="video" data-generation-popover="spec" aria-expanded="false">
            <span data-generation-spec>16:9 · 720p · 5s</span>
        </button>
    </div>
    <div class="video-footer-right">
        <span class="cost-label" data-generation-cost>后台计费</span>
        <button class="submit-btn" data-generation-submit title="生成视频">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
        </button>
    </div>
</div>
```

Change the footer CSS to a centered three-column grid and scope the summary reset:

```css
.video-props-footer {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    align-items: center;
    padding: 10px 16px;
    border-top: 1px solid var(--border-node);
    gap: 8px;
}
.video-props-footer .generation-summary-row {
    min-width: 0;
    padding: 0;
    border-bottom: 0;
    justify-self: center;
}
.video-props-footer .video-footer-right { justify-self: end; }
```

Under `@media (max-width: 720px)`, place the summary across the first row and keep model/actions on the second row:

```css
.video-props-footer { grid-template-columns: minmax(0, 1fr) auto; }
.video-props-footer .generation-summary-row {
    grid-column: 1 / -1;
    grid-row: 1;
    max-width: 100%;
}
.video-props-footer .video-model-info { grid-column: 1; grid-row: 2; }
.video-props-footer .video-footer-right { grid-column: 2; grid-row: 2; }
```

Update only the `styles.css` and `canvas-engine.js` query values in `index.html` to `20260713-video-footer-controls`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same four smoke commands from Step 2.

Expected: all four print their `passed` message and exit 0.

- [ ] **Step 5: Run implementation regression checks**

Run:

```powershell
node --check public/tools/ultimate-canvas/canvas-engine.js
npx tsx scripts/smoke/ultimate-canvas-generation-node-interactions-smoke.ts
npx tsx scripts/smoke/ultimate-canvas-generation-task-coordinator-smoke.ts
npx tsc --noEmit --pretty false
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 6: Commit the tested layout change**

```powershell
git add public/tools/ultimate-canvas/canvas-engine.js public/tools/ultimate-canvas/styles.css public/tools/ultimate-canvas/index.html scripts/smoke/ultimate-canvas-result-layout-smoke.ts scripts/smoke/ultimate-canvas-generation-node-workflow-smoke.ts scripts/smoke/ultimate-canvas-context-rules-smoke.ts scripts/smoke/ultimate-canvas-video-card-workflow-smoke.ts
git commit -m "fix: move video settings into footer"
```

### Task 2: Browser QA and Delivery Receipt

**Files:**
- Modify: `docs/handoffs/ultimate-canvas-implementation-report.md`

**Interfaces:**
- Consumes: The footer markup and responsive rules from Task 1.
- Produces: Recorded desktop/narrow viewport evidence and final verification results.

- [ ] **Step 1: Start the local Mock preview**

Run:

```powershell
node scripts/ultimate-canvas-preview-server.mjs 4400
```

Expected: `/tools/ultimate-canvas/index.html` is available at `http://127.0.0.1:4400` and remains explicitly labeled as local Mock.

- [ ] **Step 2: Verify desktop interaction in the in-app browser**

At a desktop viewport, select a video node and confirm:

- No mode/specification row appears above the toolbar.
- Footer horizontal order is model, mode/specification buttons, cost/submit.
- Clicking the mode button opens the existing mode popover.
- Clicking the specification button opens the existing specification popover.
- Changing a visible option updates the same button label.

- [ ] **Step 3: Verify narrow layout**

At a 390px viewport, confirm the setting buttons occupy the footer's first row, model and submit controls remain on the second row, the document has no horizontal overflow, and both popovers stay within the viewport.

- [ ] **Step 4: Update the implementation report**

Append a dated subsection recording the three changed production files, four updated smoke files, RED/GREEN evidence, desktop/narrow browser checks, no real generation, zero point consumption, and no changes to `.env`, admin settings, provider secrets, credits logic, or database schema.

- [ ] **Step 5: Run the final verification suite**

Run:

```powershell
Get-ChildItem scripts -Filter 'ultimate-canvas-*-smoke.ts' | Sort-Object Name | ForEach-Object { npx tsx $_.FullName; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
node --check public/tools/ultimate-canvas/canvas-engine.js
node --check public/tools/ultimate-canvas/app.js
npx tsc --noEmit --pretty false
npm run lint
npm run build
git diff --check
```

Expected: 12/12 canvas smoke scripts, syntax checks, TypeScript, lint, build, and diff check exit 0; existing repository warnings may remain unchanged.

- [ ] **Step 6: Commit the receipt**

```powershell
git add docs/handoffs/ultimate-canvas-implementation-report.md
git commit -m "docs: record video footer controls verification"
```
