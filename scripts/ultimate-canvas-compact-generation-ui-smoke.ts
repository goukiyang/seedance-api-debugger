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
assert.ok(engine.includes('generation-empty-state'));
assert.ok(engine.includes('data-generation-quick-mode="image-to-image"'));
assert.ok(engine.includes('data-generation-quick-mode="upscale-image"'));
assert.ok(engine.includes('data-generation-quick-mode="first-frame-video"'));
assert.ok(engine.includes('data-generation-quick-mode="first-last-frame-video"'));
assert.match(engine, /canvas-node node-type-\$\{type\}\$\{type === 'image' \|\| type === 'video' \? ' generation-node' : ''\}/,
  'only image and video wrappers opt into the generation-node layout');
assert.ok(engine.includes('<div class="node-card">'), 'node-card remains the universal outer shell');
assert.ok(!engine.includes('generation-card'), 'generation nodes do not add a second outer card shell');

assert.ok(!styles.includes('.canvas-node.selected .generation-quick-modes,'),
  'selection keeps the empty-state actions visible');
assert.match(styles, /\.generation-editor-footer\s*\{[\s\S]*?display:\s*grid;/);
assert.match(styles, /\.generation-reference-list\[hidden\]\s*\{[\s\S]*?display:\s*none;/);
assert.match(styles, /\.generation-node \.node-card\s*\{[\s\S]*?width:\s*var\(--generation-node-width, 350px\);/,
  'generation node dimensions are centralized on the shared outer-card selector');
assert.match(styles, /\.generation-node \.node-body\s*\{[\s\S]*?height:\s*100%;/,
  'generation node body layout is centralized on the shared selector');
assert.ok(!styles.includes('.generation-card'), 'styles do not create a second generation card shell');
assert.doesNotMatch(styles, /\.node-type-(?:image|video)\s+\.generation-(?:quick-modes|empty-state|editor|editor-footer)/,
  'image and video do not duplicate generation visual-state styles');
assert.ok(app.includes('referenceList.hidden = references.length === 0'));
assert.ok(app.includes('referenceList.innerHTML = references.length'));
assert.ok(app.includes('function generationChoiceGroup'));
assert.ok(app.includes('function applyGenerationSettingChoice'));
assert.ok(app.includes("scheduleCanvasSave(`${node.type}_settings_change`)"));
assert.match(styles, /\.generation-choice-grid\s*\{[\s\S]*?display:\s*grid;/);
assert.match(styles, /\.generation-choice-button\[aria-pressed="true"\]/);

console.log('ultimate-canvas-compact-generation-ui-smoke passed');
