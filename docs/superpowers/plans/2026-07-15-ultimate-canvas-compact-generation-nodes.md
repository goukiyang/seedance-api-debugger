# Ultimate Canvas Compact Generation Nodes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the existing image and video canvas nodes into one compact preview-and-editor interaction while preserving every real sd2 generation, reference, polling, and persistence path.

**Architecture:** Keep `CanvasEngine` and the existing `data-generation-*` delegated event contract. Replace only the image/video templates and presentation, render capability-backed specification choices as anchored tile controls, and move generated-result actions out of the media frame into contextual popovers. Existing same-origin submit payloads and saved node settings remain unchanged.

**Tech Stack:** Static HTML/CSS/JavaScript, Node/TypeScript smoke scripts, PostCSS safe parser, Next.js 14, in-app browser QA.

## Global Constraints

- Modify the existing Ultimate Canvas in place; do not create another canvas or generation flow.
- Show only controls backed by current real behavior.
- Preserve ratio-derived image and video node dimensions.
- Keep the prompt editor at a fixed responsive width independent of media ratio.
- Preserve same-origin sd2 upload, image generation, video generation, task polling, save, and restore contracts.
- Keep normal-account access; do not route behavior through admin-only paths.
- Do not read or modify `.env`, admin API settings, provider keys, credit rules, or database schema.
- Do not invoke paid text, image, or video generation during verification.

---

### Task 1: Compact Shared Node and Editor Structure

**Files:**
- Create: `scripts/ultimate-canvas-compact-generation-ui-smoke.ts`
- Modify: `public/tools/ultimate-canvas/canvas-engine.js:501-509`
- Modify: `public/tools/ultimate-canvas/canvas-engine.js:787-858`
- Modify: `public/tools/ultimate-canvas/app.js:3091-3150`
- Modify: `public/tools/ultimate-canvas/styles.css:1165-1185`
- Modify: `public/tools/ultimate-canvas/styles.css:1675-1868`

**Interfaces:**
- Consumes: Existing quick-mode IDs, `data-generation-command`, `data-generation-popover`, `data-generation-reference-list`, `data-generation-submit`, and prompt textarea selectors.
- Produces: Shared `.generation-empty-state`, `.generation-editor-toolbar`, `.generation-editor-footer`, and hidden-empty reference-list structure for image and video nodes.

- [ ] **Step 1: Write the failing compact-structure smoke test**

Create `scripts/ultimate-canvas-compact-generation-ui-smoke.ts` with:

```ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const engine = readFileSync('public/tools/ultimate-canvas/canvas-engine.js', 'utf8');
const app = readFileSync('public/tools/ultimate-canvas/app.js', 'utf8');
const styles = readFileSync('public/tools/ultimate-canvas/styles.css', 'utf8');

const videoStart = engine.indexOf("if (type === 'video') return `");
const imageStart = engine.indexOf("if (type === 'image') return `", videoStart);
const directorStart = engine.indexOf("if (type === 'director') return `", imageStart);
assert.ok(videoStart >= 0 && imageStart > videoStart && directorStart > imageStart);

const videoTemplate = engine.slice(videoStart, imageStart);
const imageTemplate = engine.slice(imageStart, directorStart);
for (const [kind, template] of [['video', videoTemplate], ['image', imageTemplate]] as const) {
  const toolbar = template.indexOf('generation-editor-toolbar');
  const references = template.indexOf('data-generation-reference-list');
  const textarea = template.indexOf(`${kind}-props-textarea`);
  const footer = template.indexOf('generation-editor-footer');
  assert.ok(toolbar >= 0, `${kind} has the compact toolbar`);
  assert.ok(toolbar < references && references < textarea && textarea < footer,
    `${kind} editor order is toolbar, references, prompt, footer`);
  assert.ok(template.includes('data-generation-popover="mode"'));
  assert.ok(template.includes('data-generation-popover="spec"'));
  assert.ok(template.includes('data-generation-submit'));
  assert.ok(template.includes('data-generation-reference-list hidden'));
}

assert.ok(!imageTemplate.includes('data-generation-command="disconnect-references"'));
assert.ok(!videoTemplate.includes('data-generation-command="disconnect-references"'));
assert.ok(engine.includes('class="generation-empty-state"'));
assert.ok(engine.includes('data-generation-quick-mode="image-to-image"'));
assert.ok(engine.includes('data-generation-quick-mode="upscale-image"'));
assert.ok(engine.includes('data-generation-quick-mode="first-frame-video"'));
assert.ok(engine.includes('data-generation-quick-mode="first-last-frame-video"'));
assert.ok(!styles.includes('.canvas-node.selected .generation-quick-modes,'),
  'selection keeps the empty-state actions visible');
assert.match(styles, /\.generation-editor-footer\s*\{[\s\S]*?display:\s*grid;/);
assert.match(styles, /\.generation-reference-list\[hidden\]\s*\{[\s\S]*?display:\s*none;/);
assert.ok(app.includes('referenceList.hidden = references.length === 0'));
assert.ok(app.includes("referenceList.innerHTML = references.length"));

console.log('ultimate-canvas-compact-generation-ui-smoke passed');
```

- [ ] **Step 2: Run the focused smoke test and verify RED**

Run:

```powershell
npx tsx scripts/ultimate-canvas-compact-generation-ui-smoke.ts
```

Expected: FAIL because compact classes, the new quick-mode choices, and hidden empty-reference behavior do not exist yet.

- [ ] **Step 3: Replace the empty preview markup with the compact structure**

In `_buildNode`, replace `generationBody` with this complete branch:

```js
const generationBody = type === 'image' || type === 'video' ? `
    <div class="generation-quick-modes generation-empty-state" data-generation-quick-modes>
        <div class="generation-empty-icon" aria-hidden="true">
            ${type === 'image'
                ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></svg>'
                : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="m8 5 11 7-11 7V5Z"/></svg>'}
        </div>
        <div class="generation-empty-actions">
            <span class="generation-empty-label">尝试</span>
            ${type === 'image' ? `
                <button type="button" data-generation-quick-mode="image-to-image">图生图</button>
                <button type="button" data-generation-quick-mode="upscale-image">图片高清</button>` : `
                <button type="button" data-generation-quick-mode="first-last-frame-video">首尾帧生成</button>
                <button type="button" data-generation-quick-mode="first-frame-video">首帧生成</button>`}
        </div>
    </div>
    <div class="generation-result-region" data-generation-result-region></div>` : body;
```

- [ ] **Step 4: Replace both editor templates with one information hierarchy**

Replace the video branch with:

```js
if (type === 'video') return `
    <div class="node-video-props node-generation-expanded generation-editor" data-generation-editor="video">
        <button class="video-props-expand" data-prompt-expand title="展开提示词" aria-label="展开提示词">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/></svg>
        </button>
        <div class="generation-node-toolbar generation-editor-toolbar">
            <button type="button" class="generation-command" data-generation-command="select-reference">+ 参考</button>
            <button type="button" class="generation-command" data-generation-command="optimize-prompt">优化</button>
            <button type="button" class="generation-command" data-generation-command="camera-presets"
                    data-generation-popover="camera" aria-expanded="false">运镜</button>
        </div>
        <div class="generation-reference-list" data-generation-reference-list hidden></div>
        <textarea class="video-props-textarea" placeholder="描述想要生成的画面，@ 引用素材"></textarea>
        <div class="generation-editor-footer video-props-footer">
            <div class="video-model-info">
                <svg class="model-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H3v-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V3h4v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></svg>
                <span data-generation-model-label>默认视频 API</span>
            </div>
            <div class="generation-summary-row">
                <button type="button" class="generation-summary-button" data-generation-popover="mode" aria-expanded="false">
                    <span data-generation-mode-label>文生视频</span>
                </button>
                <button type="button" class="generation-summary-button" data-generation-command="toggle-settings"
                        data-generation-settings="video" data-generation-popover="spec" aria-expanded="false">
                    <span data-generation-spec>16:9 · 720p · 5s</span>
                </button>
            </div>
            <div class="video-footer-right">
                <span class="cost-label" data-generation-cost title="费用由后台计算">后台计费</span>
                <button class="submit-btn" data-generation-submit title="生成视频" aria-label="生成视频">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
                </button>
            </div>
        </div>
    </div>`;
```

Replace the image branch with:

```js
if (type === 'image') return `
    <div class="node-image-props node-generation-expanded generation-editor" data-generation-editor="image">
        <button class="video-props-expand" data-prompt-expand title="展开提示词" aria-label="展开提示词">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/></svg>
        </button>
        <div class="generation-node-toolbar generation-editor-toolbar image-generation-toolbar">
            <button type="button" class="generation-command" data-generation-command="select-reference">+ 参考</button>
        </div>
        <div class="generation-reference-list" data-generation-reference-list hidden></div>
        <textarea class="image-props-textarea" placeholder="描述想要生成的图像，@ 引用素材"></textarea>
        <div class="generation-editor-footer image-props-footer">
            <div class="video-model-info">
                <svg class="model-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></svg>
                <span data-generation-model-label>图形生成</span>
            </div>
            <div class="generation-summary-row">
                <button type="button" class="generation-summary-button" data-generation-popover="mode" aria-expanded="false">
                    <span data-generation-mode-label>文生图</span>
                </button>
                <button type="button" class="generation-summary-button" data-generation-command="toggle-settings"
                        data-generation-settings="image" data-generation-popover="spec" aria-expanded="false">
                    <span data-generation-spec>16:9 · 1K · 1张</span>
                </button>
            </div>
            <div class="video-footer-right">
                <span class="cost-label" data-generation-cost title="费用由后台计算">后台计费</span>
                <button class="submit-btn" data-generation-submit title="生成图片" aria-label="生成图片">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
                </button>
            </div>
        </div>
    </div>`;
```

Do not add unsupported style, effects, subject, character-library, or storyboard buttons.

- [ ] **Step 5: Hide the reference strip when it has no items**

Replace the reference rendering block in `renderGenerationNodeControls` with:

```js
if (referenceList) {
    referenceList.hidden = references.length === 0;
    referenceList.innerHTML = references.length
        ? references.map((item, index) => `
            <span class="generation-reference-item ${item.available ? '' : 'is-unavailable'}" title="${escapeHtml(item.available ? item.title : `${item.title} 尚未入库`)}">
                ${item.preview ? `<img src="${escapeHtml(item.preview)}" alt="">` : '<span class="generation-reference-thumb"></span>'}
                <strong>${escapeHtml(item.title)}</strong>
                <span>${item.available
                    ? escapeHtml(window.UltimateCanvasGenerationInteractions.referenceRole(nodeMode, index))
                    : '未入库'}</span>
                <button type="button" class="generation-reference-remove" data-generation-reference-remove="${escapeHtml(item.nodeId)}"
                    title="移除参考图" aria-label="移除参考图">&times;</button>
            </span>`).join('')
        : '';
}
```

- [ ] **Step 6: Add the compact shared styles**

Replace the old quick-mode grid and image/video footer layout with these shared rules:

```css
.generation-quick-modes {
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    width: 100%;
    height: 100%;
    min-height: 0;
    padding: 24px;
    box-sizing: border-box;
}
.node-body:has(.generation-result-region:not(:empty)) .generation-quick-modes { display: none; }
.generation-empty-icon { display: grid; place-items: center; color: var(--text-dim); }
.generation-empty-icon svg { width: 54px; height: 54px; }
.generation-empty-actions { display: grid; justify-items: start; gap: 4px; }
.generation-empty-label { color: var(--text-tertiary); font-size: 12px; margin-bottom: 2px; }
.generation-quick-modes button {
    min-height: 30px; padding: 4px 8px; border: 0; border-radius: 5px;
    background: transparent; color: var(--text-primary); font: inherit;
    font-size: 12px; font-weight: 600; cursor: pointer;
}
.generation-quick-modes button:hover { background: var(--bg-hover); }

.generation-editor { overflow: hidden; }
.generation-editor-toolbar { padding: 12px 16px 4px; border: 0; overflow-x: auto; }
.generation-editor-toolbar .generation-command { border: 0; background: var(--bg-hover); }
.generation-reference-list[hidden] { display: none; }
.generation-editor .image-props-textarea,
.generation-editor .video-props-textarea {
    width: calc(100% - 32px); min-height: 136px; max-height: 220px;
    margin: 8px 16px 12px; padding: 0; box-sizing: border-box;
}
.generation-editor-footer {
    display: grid;
    grid-template-columns: minmax(0, auto) minmax(0, 1fr) auto;
    align-items: center; gap: 8px; padding: 10px 16px; border-top: 0;
}
.generation-editor-footer .generation-summary-row { padding: 0; border: 0; min-width: 0; }
.generation-editor-footer .video-footer-right { justify-self: end; }
.generation-editor-footer .cost-label { color: var(--text-dim); font-size: 11px; }
```

Add this narrow-viewport rule so summary controls use the first row and model/submit controls use the second row without horizontal overflow:

```css
@media (max-width: 720px) {
    .generation-editor-footer { grid-template-columns: minmax(0, 1fr) auto; }
    .generation-editor-footer .generation-summary-row {
        grid-column: 1 / -1; grid-row: 1; max-width: 100%; overflow: hidden;
    }
    .generation-editor-footer .video-model-info { grid-column: 1; grid-row: 2; min-width: 0; }
    .generation-editor-footer .video-footer-right { grid-column: 2; grid-row: 2; }
}
```

- [ ] **Step 7: Run focused tests and commit the shared structure**

Run:

```powershell
npx tsx scripts/ultimate-canvas-compact-generation-ui-smoke.ts
npx tsx scripts/ultimate-canvas-generation-node-interactions-smoke.ts
npx tsx scripts/ultimate-canvas-result-layout-smoke.ts
node --check public/tools/ultimate-canvas/canvas-engine.js
node --check public/tools/ultimate-canvas/app.js
git diff --check
```

Expected: all scripts print `passed`; syntax and diff checks exit 0.

Commit:

```powershell
git add -- public/tools/ultimate-canvas/canvas-engine.js public/tools/ultimate-canvas/app.js public/tools/ultimate-canvas/styles.css scripts/ultimate-canvas-compact-generation-ui-smoke.ts
git commit -m "feat: compact image and video generation editors"
```

---

### Task 2: Capability-backed Tile Specification Popover

**Files:**
- Modify: `scripts/ultimate-canvas-generation-node-interactions-smoke.ts`
- Modify: `scripts/ultimate-canvas-compact-generation-ui-smoke.ts`
- Modify: `public/tools/ultimate-canvas/app.js:3188-3242`
- Modify: `public/tools/ultimate-canvas/app.js:4139-4175`
- Modify: `public/tools/ultimate-canvas/styles.css:1869-1962`

**Interfaces:**
- Consumes: `normalizeCapabilities()`, `generationSettingsForNode()`, existing image/video settings objects, and anchored generation popovers.
- Produces: `generationChoiceGroup()`, `applyGenerationSettingChoice()`, and buttons using `data-generation-setting-choice` plus `data-generation-value`.

- [ ] **Step 1: Change the popover smoke harness to require tiles**

In the existing specification-popover harness, assert:

```ts
assert.ok(specPopoverElement.innerHTML.includes('data-generation-setting-choice="ratio"'));
assert.ok(specPopoverElement.innerHTML.includes('data-generation-value="21:9"'));
assert.ok(specPopoverElement.innerHTML.includes('aria-pressed="true"'));
assert.ok(specPopoverElement.innerHTML.includes('data-generation-setting-choice="size"'));
assert.ok(specPopoverElement.innerHTML.includes('data-generation-value="2K"'));
assert.ok(specPopoverElement.innerHTML.includes('data-generation-setting-choice="count"'));
assert.ok(specPopoverElement.innerHTML.includes('data-generation-value="3"'));
assert.ok(!specPopoverElement.innerHTML.includes('<select'));
```

Add source assertions to `ultimate-canvas-compact-generation-ui-smoke.ts`:

```ts
assert.ok(app.includes('function generationChoiceGroup'));
assert.ok(app.includes('function applyGenerationSettingChoice'));
assert.ok(app.includes("scheduleCanvasSave(`${node.type}_settings_change`)"));
assert.match(styles, /\.generation-choice-grid\s*\{[\s\S]*?display:\s*grid;/);
assert.match(styles, /\.generation-choice-button\[aria-pressed="true"\]/);
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
npx tsx scripts/ultimate-canvas-generation-node-interactions-smoke.ts
npx tsx scripts/ultimate-canvas-compact-generation-ui-smoke.ts
```

Expected: FAIL because the popover still renders native selects and has no tile-choice event path.

- [ ] **Step 3: Render capability options as semantic tile buttons**

Replace `generationSelect()` and `renderSpecPopover()` with complete helpers following this contract:

```js
function generationChoiceGroup(name, label, values, selected, format = value => String(value)) {
    return `<section class="generation-choice-section" data-generation-choice-section="${escapeHtml(name)}">
        <h3>${escapeHtml(label)}</h3>
        <div class="generation-choice-grid">
            ${values.map(value => {
                const raw = String(value);
                const active = raw === String(selected);
                const ratio = name === 'ratio' && /^\d+:\d+$/.test(raw)
                    ? `<span class="generation-ratio-glyph" style="--generation-choice-ratio:${raw.replace(':', ' / ')}" aria-hidden="true"></span>`
                    : '';
                return `<button type="button" class="generation-choice-button" data-generation-setting-choice="${escapeHtml(name)}"
                    data-generation-value="${escapeHtml(raw)}" aria-pressed="${active}">${ratio}<span>${escapeHtml(format(value))}</span></button>`;
            }).join('')}
        </div>
    </section>`;
}

function renderSpecPopover(node) {
    const settings = generationSettingsForNode(node);
    const capability = window.UltimateCanvasGenerationInteractions.normalizeCapabilities(
        node.type, canvasRuntime.bootstrap?.capabilities?.[node.type]
    );
    if (node.type === 'image') {
        const sizeControl = capability.sizeOptions.length
            ? generationChoiceGroup('size', '尺寸', capability.sizeOptions, settings.size)
            : `<section class="generation-choice-section"><h3>尺寸</h3><div class="generation-spec-static">${escapeHtml(capability.fixedSize || '不可用')}</div></section>`;
        const counts = Array.from({ length: settings.maximumCount }, (_, index) => index + 1);
        return `<div class="generation-popover-spec" data-generation-settings="image">
            ${generationChoiceGroup('ratio', '比例', capability.ratios, settings.ratio)}
            ${sizeControl}
            ${generationChoiceGroup('count', '生成数量', counts, settings.count, value => `${value}张`)}
        </div>`;
    }
    return `<div class="generation-popover-spec" data-generation-settings="video">
        ${generationChoiceGroup('ratio', '比例', capability.ratios, settings.ratio)}
        ${generationChoiceGroup('duration', '时长', capability.durations, settings.duration, value => `${value}s`)}
        ${generationChoiceGroup('resolution', '清晰度', capability.resolutions, settings.resolution)}
        ${capability.supportsAudio ? generationChoiceGroup('generateAudio', '生成声音', [true, false], settings.generateAudio, value => value ? '开启' : '关闭') : ''}
        ${capability.supportsLastFrame ? generationChoiceGroup('returnLastFrame', '返回尾帧', [true, false], settings.returnLastFrame, value => value ? '开启' : '关闭') : ''}
        ${capability.supportsWatermark ? generationChoiceGroup('watermark', '水印', [true, false], settings.watermark, value => value ? '开启' : '关闭') : ''}
    </div>`;
}
```

- [ ] **Step 4: Apply one clicked setting without rebuilding the payload contract**

Add:

```js
function applyGenerationSettingChoice(node, name, rawValue) {
    const current = generationSettingsForNode(node);
    if (node.type === 'image') {
        const allowed = new Set(['ratio', 'size', 'count']);
        if (!allowed.has(name)) return false;
        node.data = {
            ...node.data,
            imageSettings: {
                ratio: name === 'ratio' ? rawValue : current.ratio,
                size: name === 'size' ? rawValue : current.size,
                count: name === 'count' ? Number(rawValue) : current.count
            }
        };
    } else if (node.type === 'video') {
        const allowed = new Set(['ratio', 'duration', 'resolution', 'generateAudio', 'returnLastFrame', 'watermark']);
        if (!allowed.has(name)) return false;
        const booleanValue = rawValue === 'true';
        node.data = {
            ...node.data,
            videoSettings: {
                ratio: name === 'ratio' ? rawValue : current.ratio,
                duration: name === 'duration' ? Number(rawValue) : current.duration,
                resolution: name === 'resolution' ? rawValue : current.resolution,
                generateAudio: name === 'generateAudio' ? booleanValue : current.generateAudio,
                returnLastFrame: name === 'returnLastFrame' ? booleanValue : current.returnLastFrame,
                watermark: name === 'watermark' ? booleanValue : current.watermark
            }
        };
    } else return false;
    renderGenerationNodeControls(node.id);
    scheduleCanvasSave(`${node.type}_settings_change`);
    return true;
}
```

Add this delegated click handler so a choice is accepted only from the currently open specification popover:

```js
document.addEventListener('click', event => {
    const choice = event.target.closest('[data-generation-setting-choice]');
    const state = canvasRuntime.generationPopover;
    if (!choice || state?.kind !== 'spec' || !state.element?.contains(choice)) return;
    const node = engine.nodes.get(state.nodeId);
    const panel = choice.closest('[data-generation-settings]');
    if (!node || panel?.dataset.generationSettings !== node.type) return;
    event.preventDefault();
    event.stopPropagation();
    applyGenerationSettingChoice(
        node,
        choice.dataset.generationSettingChoice,
        choice.dataset.generationValue
    );
});
```

Confirm the old native controls are gone:

```powershell
rg -n 'data-generation-setting="' public/tools/ultimate-canvas/app.js
```

Expected: no matches. Then remove the old change-event handler that read native selects and checkboxes.

- [ ] **Step 5: Style the popover as stable tiles**

Use:

```css
.generation-popover-spec { display: grid; gap: 16px; width: min(420px, calc(100vw - 42px)); }
.generation-choice-section { display: grid; gap: 8px; }
.generation-choice-section h3 { margin: 0; color: var(--text-tertiary); font-size: 12px; font-weight: 500; }
.generation-choice-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(74px, 1fr)); gap: 8px; }
.generation-choice-button {
    min-width: 0; min-height: 54px; display: grid; place-items: center; align-content: center; gap: 6px;
    padding: 8px; border: 1px solid var(--border-node); border-radius: 7px;
    background: var(--bg-input); color: var(--text-secondary); font: inherit; cursor: pointer;
}
.generation-choice-button:hover,
.generation-choice-button[aria-pressed="true"] { border-color: var(--text-primary); color: var(--text-primary); background: var(--bg-active); }
.generation-ratio-glyph { width: 22px; max-height: 16px; aspect-ratio: var(--generation-choice-ratio); border: 1.5px solid currentColor; border-radius: 2px; }
.generation-spec-static { min-height: 38px; display: grid; place-items: center; border: 1px solid var(--border-node); border-radius: 7px; background: var(--bg-input); }
```

- [ ] **Step 6: Run focused tests and commit the popover**

Run:

```powershell
npx tsx scripts/ultimate-canvas-generation-node-interactions-smoke.ts
npx tsx scripts/ultimate-canvas-compact-generation-ui-smoke.ts
node --check public/tools/ultimate-canvas/app.js
git diff --check
```

Expected: both smoke scripts pass and no native `<select>` remains in the generation specification popover.

Commit:

```powershell
git add -- public/tools/ultimate-canvas/app.js public/tools/ultimate-canvas/styles.css scripts/ultimate-canvas-generation-node-interactions-smoke.ts scripts/ultimate-canvas-compact-generation-ui-smoke.ts
git commit -m "feat: add compact generation specification tiles"
```

---

### Task 3: Unobstructed Results, Status, and Contextual Actions

**Files:**
- Modify: `scripts/ultimate-canvas-result-layout-smoke.ts`
- Modify: `scripts/ultimate-canvas-generation-node-interactions-smoke.ts`
- Modify: `public/tools/ultimate-canvas/app.js:3248-3351`
- Modify: `public/tools/ultimate-canvas/app.js:3425-3441`
- Modify: `public/tools/ultimate-canvas/app.js:5862-5891`
- Modify: `public/tools/ultimate-canvas/styles.css:728-745`
- Modify: `public/tools/ultimate-canvas/styles.css:1527-1614`

**Interfaces:**
- Consumes: Existing generated image action event delegation, video task action model, result URLs stored in node data, `.generation-node-toolbar`, and `.node-card`.
- Produces: Image `result-actions` popover, shared compact `more` trigger, result cards with media-only body, and a one-line card status overlay.

- [ ] **Step 1: Write failing result-layout and action assertions**

Change result-layout expectations to require both node types to use a two-row result grid and no inline action row:

```ts
const compactResults = ruleWith([
  '.node-type-video .generation-result-region:not(:empty) .generated-reference-card',
  '.node-type-image .generation-result-region:not(:empty) .generated-reference-card',
]);
assertDeclarations(compactResults, {
  display: 'grid',
  'grid-template-rows': 'auto minmax(0, 1fr)',
  gap: '8px',
  height: '100%',
  'min-height': '0',
});
assertDeclarations(ruleWith([
  '.node-type-video .generation-result-region:not(:empty) .generated-reference-card p',
  '.node-type-image .generation-result-region:not(:empty) .generated-reference-card p',
]), { display: 'none' });
assertDeclarations(ruleWith([
  '.node-type-video .generation-result-region:not(:empty) .generated-frame-preview',
  '.node-type-image .generation-result-region:not(:empty) .generated-frame-preview',
]), { width: '100%', height: '100%', 'object-fit': 'contain' });
```

Add source assertions:

```ts
assert.ok(appSource.includes('function imageResultActionsForNode'));
assert.ok(appSource.includes("data-generation-popover = 'result-actions'"));
assert.ok(appSource.includes("kind === 'result-actions' ? renderImageResultActionsPopover"));
assert.ok(!appSource.slice(appSource.indexOf('function decorateGeneratedNode'), appSource.indexOf('function createDirectorOutput'))
  .includes('generated-action-row'));
assert.ok(appSource.includes("const card = nodeEl.querySelector('.node-card')"));
assert.ok(appSource.includes('card.append(status)'));
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
npx tsx scripts/ultimate-canvas-result-layout-smoke.ts
npx tsx scripts/ultimate-canvas-generation-node-interactions-smoke.ts
```

Expected: FAIL because image actions still live inside the preview and statuses still prepend the editor.

- [ ] **Step 3: Add image result actions to the contextual popover path**

Add these functions beside the existing video task-action functions:

```js
function imageResultActionsForNode(node, overrides = {}) {
    if (node?.type !== 'image') return null;
    const data = node.data || {};
    const result = data.generationResult || {};
    const imageUrl = overrides.imageUrl ?? data.originalUrl ?? data.imageUrl ?? data.previewImage
        ?? result.original_url ?? result.originalUrl ?? result.image_url ?? result.imageUrl;
    if (!imageUrl) return null;
    return {
        imageUrl,
        downloadUrl: overrides.downloadUrl ?? data.originalUrl ?? imageUrl
    };
}

function syncImageResultActionsTrigger(nodeEl, node, overrides = {}) {
    const toolbar = nodeEl?.querySelector('.generation-node-toolbar');
    const existing = toolbar?.querySelector('[data-generation-popover="result-actions"]');
    if (existing && canvasRuntime.generationPopover?.anchor === existing) closeGenerationPopover();
    existing?.remove();
    const actions = imageResultActionsForNode(node, overrides);
    if (!toolbar || !actions) return;
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'generation-command generation-task-more generation-icon-command';
    trigger.dataset.generationPopover = 'result-actions';
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-label', '更多操作');
    trigger.title = '更多操作';
    trigger.textContent = '•••';
    trigger._generationResultActions = actions;
    toolbar.appendChild(trigger);
}

function renderImageResultActionsPopover(node, actionModel = null) {
    const actions = actionModel || imageResultActionsForNode(node);
    if (!actions) return '';
    return `<div class="generation-popover-list generation-task-action-menu">
        <a data-generated-image-action="open" href="${escapeHtml(actions.imageUrl)}" target="_blank" rel="noreferrer">打开原图</a>
        <a data-generated-image-action="download" href="${escapeHtml(actions.downloadUrl)}" download>下载</a>
        <button type="button" data-generated-image-action="regenerate" data-node-id="${escapeHtml(node.id)}">再次生成</button>
        <button type="button" data-generated-image-action="create-video" data-node-id="${escapeHtml(node.id)}">生成视频</button>
    </div>`;
}
```

At the end of `renderGenerationNodeControls`, replace the single video sync call with:

```js
syncImageResultActionsTrigger(nodeEl, node);
syncVideoTaskActionsTrigger(nodeEl, node);
```

Extend the `openGenerationPopover` renderer chain with:

```js
element.innerHTML = kind === 'mode' ? renderModePopover(node)
    : kind === 'spec' ? renderSpecPopover(node)
        : kind === 'camera' ? renderCameraPopover(node)
            : kind === 'result-actions' ? renderImageResultActionsPopover(node, anchor._generationResultActions)
                : kind === 'task-actions' ? renderVideoTaskActionsPopover(node, anchor._generationTaskActions)
                    : '';
```

After updating the result region in `decorateGeneratedNode`, call:

```js
syncImageResultActionsTrigger(nodeEl, node, options);
if (node?.type === 'video') syncVideoTaskActionsTrigger(nodeEl, node, options);
```

The existing `syncVideoTaskActionsTrigger` remains the video task-detail path.

- [ ] **Step 4: Make generated result markup media-first**

Replace the body passed to `updateGenerationResultRegion` with:

```js
window.UltimateCanvasGenerationInteractions.updateGenerationResultRegion(nodeEl, `
    <div class="generated-reference-card">
        <strong class="generated-result-title">${escapeHtml(title)}</strong>
        ${previewImage
            ? `<img class="generated-frame-preview" src="${escapeHtml(previewImage)}" alt="${escapeHtml(title)}">`
            : '<div class="generated-frame-lines"></div>'}
    </div>`);
syncImageResultActionsTrigger(nodeEl, node, options);
if (node?.type === 'video') syncVideoTaskActionsTrigger(nodeEl, node, options);
```

Do not render description paragraphs, expand buttons, or action rows inside the preview card. The prompt editor already owns its expand button.

- [ ] **Step 5: Move generation status to a compact card overlay**

Replace `setNodeGenerationStatus` with:

```js
function setNodeGenerationStatus(nodeEl, state, message) {
    if (!nodeEl) return;
    const card = nodeEl.querySelector('.node-card');
    if (!card) return;
    let status = card.querySelector(':scope > .node-generation-status');
    if (!message) {
        status?.remove();
        return;
    }
    if (!status) {
        status = document.createElement('div');
        card.append(status);
    }
    status.className = `node-generation-status ${state || 'info'}`;
    status.textContent = message;
    status.title = message;
}
```

Style `.node-generation-status` as an absolutely positioned, single-line pill at the bottom-right of `.node-card`, with `max-width: calc(100% - 20px)`, ellipsis, no border-bottom, and a z-index above media but below connectors.

- [ ] **Step 6: Apply the shared result grid and full media sizing**

Use shared image/video rules:

```css
.node-type-video .generation-result-region:not(:empty) .generated-reference-card,
.node-type-image .generation-result-region:not(:empty) .generated-reference-card {
    display: grid; grid-template-rows: auto minmax(0, 1fr); gap: 8px;
    height: 100%; min-height: 0; padding: 10px; overflow: hidden;
}
.generated-result-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.node-type-video .generation-result-region:not(:empty) .generated-reference-card p,
.node-type-image .generation-result-region:not(:empty) .generated-reference-card p { display: none; }
.node-type-video .generation-result-region:not(:empty) .generated-frame-preview,
.node-type-image .generation-result-region:not(:empty) .generated-frame-preview {
    width: 100%; height: 100%; min-height: 0; max-height: none; margin: 0; object-fit: contain;
}
```

Remove selected/unselected `.generated-action-row` sizing rules because result actions now live in popovers.

- [ ] **Step 7: Run focused tests and commit result cleanup**

Run:

```powershell
npx tsx scripts/ultimate-canvas-result-layout-smoke.ts
npx tsx scripts/ultimate-canvas-generation-node-interactions-smoke.ts
npx tsx scripts/ultimate-canvas-compact-generation-ui-smoke.ts
node --check public/tools/ultimate-canvas/app.js
git diff --check
```

Expected: all smoke tests pass, result previews contain no inline action row, and status creation targets the card.

Commit:

```powershell
git add -- public/tools/ultimate-canvas/app.js public/tools/ultimate-canvas/styles.css scripts/ultimate-canvas-result-layout-smoke.ts scripts/ultimate-canvas-generation-node-interactions-smoke.ts
git commit -m "feat: streamline generated media cards"
```

---

### Task 4: Full Verification, Visual Acceptance, and Handoff

**Files:**
- Modify: `docs/handoffs/ultimate-canvas-implementation-report.md`

**Interfaces:**
- Consumes: Tasks 1-3 and the existing no-generation local preview server.
- Produces: Desktop/mobile acceptance evidence, repository verification results, final receipt, and pushed branch.

- [ ] **Step 1: Run the complete repository verification**

Run:

```powershell
Get-ChildItem scripts -Filter 'ultimate-canvas-*-smoke.ts' | Sort-Object Name | ForEach-Object { npx tsx $_.FullName; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
npx tsc --noEmit --pretty false
node --check public/tools/ultimate-canvas/app.js
node --check public/tools/ultimate-canvas/canvas-engine.js
npm run lint
npm run build
git diff --check
```

Expected: every command exits 0. Record framework warnings separately without treating them as failures.

- [ ] **Step 2: Start the local preview without generation**

Run the existing preview server on an unused loopback port without `--mock-generation` or any generation flag:

```powershell
node scripts/ultimate-canvas-preview-server.mjs 4401
```

Expected: `http://127.0.0.1:4401/tools/ultimate-canvas/index.html` loads the current canvas UI. The preview server must not synthesize image or video results.

- [ ] **Step 3: Verify image and video states in the browser**

At a desktop viewport, verify:

```text
- empty image and video cards show centered media icons and two compact quick actions;
- selecting either card does not resize it and keeps empty-state actions visible;
- both editors use toolbar -> references (only when present) -> textarea -> footer order;
- only real controls are visible;
- mode and specification controls open anchored popovers;
- ratio, size/resolution, duration, audio, watermark, and count choices follow bootstrap capabilities;
- changing a ratio immediately updates the media card, not the prompt editor dimensions;
- generated/uploaded images remain fully visible with object-fit contain;
- media actions appear in More popovers and do not consume preview height;
- status messages are compact overlays and long messages ellipsize;
- no labels, controls, media, connectors, or popovers overlap.
```

Repeat at `390 x 844` and `320 x 720`. Confirm there is no horizontal page overflow and the longest visible Chinese labels remain inside their controls.

- [ ] **Step 4: Update the required handoff receipt**

Append a dated section to `docs/handoffs/ultimate-canvas-implementation-report.md` covering:

```markdown
## Compact image and video generation nodes (2026-07-15)

- Goal and approved real-function-first layout.
- Exact files changed and each file's responsibility.
- Every verification command and its actual result.
- Desktop and narrow-viewport browser checks.
- Real text/image/video generation invoked: no.
- Points consumed: 0.
- Protected areas touched: no; list `.env`, admin settings, provider keys, credit core logic, and database schema explicitly.
- Remaining work and deployment risk.
```

- [ ] **Step 5: Commit documentation, rebase, and push**

Run:

```powershell
git add -- docs/handoffs/ultimate-canvas-implementation-report.md
git commit -m "docs: record compact generation node verification"
git pull --rebase origin teammate/ultimate-canvas-complete
git push origin teammate/ultimate-canvas-complete
git status --short --branch
```

Expected: local and remote `teammate/ultimate-canvas-complete` point at the same final commit and the working tree is clean.
