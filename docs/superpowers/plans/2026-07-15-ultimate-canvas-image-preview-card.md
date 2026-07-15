# Ultimate Canvas Image Preview Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make image nodes show only a compact filename above a full, uncropped preview that fills the remaining ratio-sized card.

**Architecture:** Keep the existing result markup and persisted status data intact. Add image-node-specific CSS grid rules so filename, preview, and optional selected actions occupy explicit rows; hide the descriptive status only in the compact image card and remove the preview's small fixed height cap.

**Tech Stack:** Static HTML/CSS/JavaScript, TypeScript smoke scripts, PostCSS safe parser, Playwright browser QA.

## Global Constraints

- Preserve ratio-derived image and video node dimensions.
- Preserve the fixed 640px desktop prompt-panel dimensions.
- Render the entire source image with `object-fit: contain`; do not crop it.
- Keep uploaded status in node state and save/restore data, but do not display it in the compact image result card.
- Do not read or modify `.env`, admin API settings, provider secrets, credit rules, or database schema.
- Do not invoke text, image, or video generation during verification.

---

### Task 1: Compact Image Result Layout

**Files:**
- Modify: `scripts/ultimate-canvas-result-layout-smoke.ts`
- Modify: `public/tools/ultimate-canvas/styles.css`

**Interfaces:**
- Consumes: Existing `.node-type-image`, `.generation-result-region`, `.generated-reference-card`, `.generated-frame-preview`, and `.generated-action-row` markup.
- Produces: An image-only three-row result grid with a hidden description and a full-height contained preview.

- [ ] **Step 1: Write the failing layout assertions**

Add the following assertions after the shared generated-reference-card assertion in `scripts/ultimate-canvas-result-layout-smoke.ts`:

```ts
const imageResultCard = ruleWith([
  '.node-type-image .generation-result-region:not(:empty) .generated-reference-card',
]);
assertDeclarations(imageResultCard, {
  display: 'grid',
  'grid-template-rows': 'auto minmax(0, 1fr) auto',
  gap: '8px',
  'justify-content': 'stretch',
});

const imageResultDescription = ruleWith([
  '.node-type-image .generation-result-region:not(:empty) .generated-reference-card p',
]);
assertDeclarations(imageResultDescription, { display: 'none' });

const imageResultPreview = ruleWith([
  '.canvas-node.node-type-image .generation-result-region:not(:empty) .generated-frame-preview',
]);
assertDeclarations(imageResultPreview, {
  width: '100%',
  height: '100%',
  'min-height': '0',
  'max-height': 'none',
  'margin-top': '0',
  'object-fit': 'contain',
});
```

- [ ] **Step 2: Run the focused smoke test and verify RED**

Run:

```powershell
npx tsx scripts/ultimate-canvas-result-layout-smoke.ts
```

Expected: FAIL because the current image result card does not set `display: grid` and the current preview still has a fixed `max-height`.

- [ ] **Step 3: Implement the minimal image-only CSS**

In `public/tools/ultimate-canvas/styles.css`, keep the shared result-card sizing rules and add these image-specific declarations after them:

```css
.node-type-image .generation-result-region:not(:empty) .generated-reference-card {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    gap: 8px;
    justify-content: stretch;
}

.node-type-image .generation-result-region:not(:empty) .generated-reference-card strong {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.node-type-image .generation-result-region:not(:empty) .generated-reference-card p {
    display: none;
}

.canvas-node.node-type-image .generation-result-region:not(:empty) .generated-frame-preview {
    width: 100%;
    height: 100%;
    min-height: 0;
    max-height: none;
    margin-top: 0;
    object-fit: contain;
}
```

Do not change `.node-card` dimensions, generation-node ratio variables, prompt-panel sizing, or video preview rules.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```powershell
npx tsx scripts/ultimate-canvas-result-layout-smoke.ts
npx tsx scripts/ultimate-canvas-generation-node-interactions-smoke.ts
git diff --check
```

Expected: both smoke scripts print their `passed` messages and `git diff --check` exits 0.

- [ ] **Step 5: Commit the tested layout change**

```powershell
git add -- public/tools/ultimate-canvas/styles.css scripts/ultimate-canvas-result-layout-smoke.ts
git commit -m "fix: expand image node previews"
```

Expected: one commit containing only the CSS and focused regression test.

---

### Task 2: Browser Acceptance and Handoff Receipt

**Files:**
- Modify: `docs/handoffs/ultimate-canvas-implementation-report.md`

**Interfaces:**
- Consumes: Task 1's committed image result layout and the existing local preview server.
- Produces: Visual acceptance evidence and an updated implementation receipt.

- [ ] **Step 1: Start or reuse the local preview server without generation**

Run:

```powershell
node scripts/ultimate-canvas-preview-server.mjs 4400
```

Expected: `http://127.0.0.1:4400/tools/ultimate-canvas/index.html` responds successfully in preview mode. Do not pass `--mock-generation`.

- [ ] **Step 2: Verify the image node visually in the browser**

At a desktop viewport, select the uploaded image node and verify:

```text
- only the filename is visible above the preview;
- the upload status is not visible in the compact card;
- the full source image is visible with no crop;
- the preview uses the card's remaining height;
- selected action buttons remain usable;
- the prompt panel remains 640px wide and centered;
- changing or restoring the node ratio does not change the prompt-panel ratio.
```

Repeat at `390 x 844` and confirm the card and prompt panel have no horizontal page overflow. Reset the temporary viewport after verification.

- [ ] **Step 3: Run the full canvas verification suite**

Run:

```powershell
Get-ChildItem scripts -Filter 'ultimate-canvas-*-smoke.ts' | Sort-Object Name | ForEach-Object { npx tsx $_.FullName; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
npx tsc --noEmit --pretty false
node --check public/tools/ultimate-canvas/app.js
node --check public/tools/ultimate-canvas/canvas-engine.js
git diff --check
```

Expected: every command exits 0. Record any pre-existing warning separately; do not claim a pass for a command that fails.

- [ ] **Step 4: Update the handoff receipt**

Append a dated section to `docs/handoffs/ultimate-canvas-implementation-report.md` containing:

```markdown
## Image preview card optimization (2026-07-15)

- Goal: compact uploaded/generated image cards so only the filename precedes a full uncropped preview.
- Files changed: `public/tools/ultimate-canvas/styles.css`, `scripts/ultimate-canvas-result-layout-smoke.ts`, design/plan documents, and this report.
- Verification: list each command from Step 3 and its actual result, plus desktop/mobile browser measurements.
- Real generation: not invoked.
- Points consumed: 0.
- Protected areas: `.env`, admin settings, provider secrets, credit core logic, and database schema were not read or changed.
- Remaining work: deployment to SD2 and production visual confirmation, unless completed in this run.
```

- [ ] **Step 5: Commit the receipt and push the branch**

```powershell
git add -- docs/handoffs/ultimate-canvas-implementation-report.md
git commit -m "docs: record image preview card verification"
git pull --rebase origin teammate/ultimate-canvas-complete
git push origin teammate/ultimate-canvas-complete
```

Expected: local and remote `teammate/ultimate-canvas-complete` point to the same final commit.
