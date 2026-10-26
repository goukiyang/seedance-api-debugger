import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const safeParser = require('next/dist/compiled/postcss-safe-parser');
const interactions = require('../public/tools/ultimate-canvas/generation-node-interactions.js');

const css = safeParser(readFileSync('public/tools/ultimate-canvas/styles.css', 'utf8'));

function selectors(rule: any): string[] {
  return rule.selectors.map((selector: string) => selector.trim());
}

function ruleWith(requiredSelectors: string[], root: any = css): any {
  let match: any = null;
  root.walkRules((rule: any) => {
    if (root === css && rule.parent !== css) return;
    const actual = selectors(rule);
    if (requiredSelectors.every(selector => actual.includes(selector))) match = rule;
  });
  assert.ok(match, `missing CSS rule for ${requiredSelectors.join(', ')}`);
  return match;
}

function declarations(rule: any): Map<string, string> {
  const values = new Map<string, string>();
  rule.walkDecls((declaration: any) => values.set(declaration.prop, declaration.value));
  return values;
}

function assertDeclarations(rule: any, expected: Record<string, string>) {
  const actual = declarations(rule);
  Object.entries(expected).forEach(([property, value]) => {
    assert.equal(actual.get(property), value, `${rule.selector} must set ${property}: ${value}`);
  });
}

function mediaRuleWith(params: string): any {
  let match: any = null;
  css.walkAtRules('media', (atRule: any) => {
    if (atRule.params.trim() === params) match = atRule;
  });
  assert.ok(match, `missing CSS media rule for ${params}`);
  return match;
}

const portraitCardWidth = interactions.generationNodeDimensions('9:16').width;
const desktopPanelWidth = 640;
const portraitOverflow = (desktopPanelWidth - portraitCardWidth) / 2;
assert.equal(portraitCardWidth, 196.875);
assert.equal(portraitOverflow, 221.5625);
assert.equal(-portraitOverflow + desktopPanelWidth / 2, portraitCardWidth / 2);

const landscapeCardWidth = interactions.generationNodeDimensions('16:9').width;
const landscapeOverflow = (desktopPanelWidth - landscapeCardWidth) / 2;
assert.equal(landscapeOverflow, 145);
assert.equal(-landscapeOverflow + desktopPanelWidth / 2, landscapeCardWidth / 2);

const mobilePanelWidth = Math.min(640, 390 - 24);
assert.equal(mobilePanelWidth, 366);

const desktopImageLongEdge = interactions.generationNodeLongEdge('image', 1200);
const desktopImageLandscape = interactions.generationNodeDimensions('21:9', desktopImageLongEdge);
assert.equal(desktopImageLongEdge, desktopPanelWidth);
assert.equal(desktopImageLandscape.width, desktopPanelWidth, 'landscape image card aligns with the prompt panel width');
assert.equal(desktopImageLandscape.height, 274.286);

const desktopVideoLongEdge = interactions.generationNodeLongEdge('video', 1200);
const desktopVideoLandscape = interactions.generationNodeDimensions('21:9', desktopVideoLongEdge);
assert.equal(desktopVideoLongEdge, desktopPanelWidth);
assert.equal(desktopVideoLandscape.width, desktopPanelWidth, 'landscape video card aligns with the prompt panel width');
assert.equal(desktopVideoLandscape.height, 274.286);

const generationNodes = ruleWith(['.generation-node']);
assertDeclarations(generationNodes, { width: 'var(--generation-node-width, 350px)' });

const baseCards = ruleWith(['.generation-node .node-card']);
assertDeclarations(baseCards, {
  width: 'var(--generation-node-width, 350px)',
  height: 'var(--generation-node-height, 196.875px)',
});

const cardBodies = ruleWith(['.generation-node .node-body']);
assertDeclarations(cardBodies, {
  height: '100%',
  'min-height': '0',
  overflow: 'hidden',
  'border-radius': 'inherit',
  background: 'transparent',
});

const resultRegions = ruleWith(['.generation-node .generation-result-region:not(:empty)']);
assertDeclarations(resultRegions, {
  height: '100%',
  'min-height': '0',
  overflow: 'hidden',
  'border-radius': 'inherit',
  background: 'transparent',
});

css.walkRules((rule: any) => {
  const selectedCardRule = selectors(rule).some(selector =>
    selector.includes('.canvas-node.selected') && selector.endsWith('.node-card')
  );
  if (!selectedCardRule) return;
  const selectedDeclarations = declarations(rule);
  for (const property of ['width', 'height', 'min-height', 'max-width']) {
    assert.equal(selectedDeclarations.has(property), false, `${rule.selector} must not change selected card ${property}`);
  }
});

assertDeclarations(ruleWith(['.generated-reference-card']), {
  'box-sizing': 'border-box',
});

assertDeclarations(ruleWith([
  '.generation-node .generation-result-region:not(:empty) .generated-reference-card',
]), {
  position: 'relative',
  width: '100%',
  height: '100%',
  'min-height': '0',
  padding: '0',
  border: '0',
  'border-radius': 'inherit',
  background: 'transparent',
  'box-shadow': 'none',
});
assertDeclarations(ruleWith([
  '.generation-node .node-body:has(.generation-result-region:not(:empty))',
]), { padding: '0' });
assertDeclarations(ruleWith([
  '.generation-node .generation-result-region:not(:empty) .generated-reference-card p',
]), { display: 'none' });
assertDeclarations(ruleWith(['.generated-result-title']), {
  position: 'absolute',
  top: '10px',
  left: '10px',
  'z-index': '2',
});
assertDeclarations(ruleWith([
  '.generation-node .generation-result-region:not(:empty) .generated-frame-preview',
]), {
  width: '100%',
  height: '100%',
  border: '0',
  'border-radius': 'inherit',
  background: 'transparent',
  'object-fit': 'contain',
  'user-select': 'none',
  '-webkit-user-drag': 'none',
});
assertDeclarations(ruleWith([
  '.generation-node .generation-result-region:not(:empty) .generated-result-placeholder',
]), {
  display: 'block',
  width: '100%',
  height: '100%',
  margin: '0',
  border: '0',
  'border-radius': 'inherit',
  background: 'transparent',
});

const selectedActions = ruleWith(['.generation-node.selected .generated-action-row']);
assertDeclarations(selectedActions, { display: 'flex' });
assertDeclarations(selectedActions, {
  'flex-wrap': 'nowrap',
  'overflow-x': 'auto',
  'overflow-y': 'hidden',
  height: '24px',
  'min-height': '24px',
  flex: '0 0 24px',
});

const unselectedActions = ruleWith(['.generation-node:not(.selected) .generated-action-row']);
assertDeclarations(unselectedActions, { display: 'none' });

assertDeclarations(ruleWith(['.generated-frame-preview']), {
  flex: '0 1 auto',
  'max-height': '260px',
  'object-fit': 'contain',
  'user-select': 'none',
  '-webkit-user-select': 'none',
  '-webkit-user-drag': 'none',
});

assertDeclarations(ruleWith(['.generation-editor']), {
  width: '640px',
  'max-width': 'min(640px, calc(100vw - 24px))',
  'margin-left': '0',
  left: '50%',
  transform: 'translateX(-50%)',
});

const engineSource = readFileSync('public/tools/ultimate-canvas/canvas-engine.js', 'utf8');
const videoTemplateStart = engineSource.indexOf("if (type === 'video') return `");
const imageTemplateStart = engineSource.indexOf("if (type === 'image') return `", videoTemplateStart);
assert.ok(videoTemplateStart >= 0, 'video template must exist');
assert.ok(imageTemplateStart >= 0, 'image template must delimit the video template');
assert.ok(videoTemplateStart < imageTemplateStart, 'video template must precede the image template');
const videoTemplate = engineSource.slice(videoTemplateStart, imageTemplateStart);
const toolbarStart = videoTemplate.indexOf('generation-editor-toolbar');
const footerStart = videoTemplate.indexOf('generation-editor-footer');
const modelStart = videoTemplate.indexOf('class="video-model-info"');
const summaryStart = videoTemplate.indexOf('class="generation-summary-row"');
const footerRightStart = videoTemplate.indexOf('class="video-footer-right"');

assert.ok(toolbarStart >= 0, 'video toolbar must exist in the video template');
assert.ok(footerStart >= 0, 'video footer must exist in the video template');
assert.ok(modelStart >= 0, 'video model label must exist in the video template');
assert.ok(summaryStart >= 0, 'video summary row must exist in the video template');
assert.ok(footerRightStart >= 0, 'video footer actions must exist in the video template');
assert.equal(
  videoTemplate.match(/class="generation-summary-row"/g)?.length ?? 0,
  1,
  'video template must contain exactly one generation summary row',
);

assert.ok(toolbarStart < footerStart, 'video toolbar remains above the footer');
assert.ok(footerStart < modelStart, 'video model remains inside the footer');
assert.ok(modelStart < summaryStart, 'video settings follow the model label');
assert.ok(summaryStart < footerRightStart, 'video settings precede cost and submit controls');

assertDeclarations(ruleWith(['.generation-editor-footer']), {
  display: 'grid',
  'grid-template-columns': 'minmax(0, auto) minmax(0, 1fr) auto',
});
assertDeclarations(ruleWith(['.generation-editor-footer .generation-summary-row']), {
  padding: '0',
  border: '0',
});
assertDeclarations(ruleWith(['.generation-editor-footer .video-footer-right']), {
  'justify-self': 'end',
});

const mobileLayout = mediaRuleWith('(max-width: 720px)');
assertDeclarations(ruleWith(['.generation-editor-footer'], mobileLayout), {
  'grid-template-columns': 'minmax(0, 1fr) auto',
});
assertDeclarations(ruleWith(['.generation-editor-footer .generation-summary-row'], mobileLayout), {
  'grid-column': '1 / -1',
  'grid-row': '1',
  'max-width': '100%',
});
assertDeclarations(ruleWith(['.generation-editor-footer .video-model-info'], mobileLayout), {
  'grid-column': '1',
  'grid-row': '2',
  'min-width': '0',
});
assertDeclarations(ruleWith(['.generation-editor-footer .video-footer-right'], mobileLayout), {
  'grid-column': '2',
  'grid-row': '2',
});

for (const selectorsToCheck of [
  ['.generation-summary-row'],
  ['.generation-node-toolbar'],
]) {
  assert.equal(
    declarations(ruleWith(selectorsToCheck)).has('flex-wrap'),
    false,
    `${selectorsToCheck.join(', ')} must retain the desktop single-row layout`,
  );
}

assertDeclarations(ruleWith(['.node-connector']), {
    width: '20px',
    height: '20px',
    top: '50%',
});

assertDeclarations(ruleWith(['.generation-task-more']), { 'margin-left': 'auto' });
assertDeclarations(ruleWith(['.generation-task-action-menu']), { 'min-width': '190px' });
assertDeclarations(ruleWith([
  '.generation-task-action-menu a',
  '.generation-task-action-menu button',
]), {
  display: 'flex',
  width: '100%',
  'justify-content': 'flex-start',
  'min-height': '32px',
  padding: '6px 10px',
  border: '1px solid transparent',
  'border-radius': '6px',
  background: 'transparent',
  color: 'var(--text-secondary)',
  'text-decoration': 'none',
  cursor: 'pointer',
});

assertDeclarations(ruleWith([
  '.generation-task-action-menu a:hover',
  '.generation-task-action-menu button:hover',
]), {
  border: '1px solid var(--border-node)',
  background: 'var(--bg-active)',
  color: 'var(--text-primary)',
});

const generatedResultAction = { id: 'generated-result-action', enabled: true };
const resultRegion = {
  id: 'result-region',
  markup: '<button>old</button>',
  actions: [] as Array<{ id: string; enabled: boolean }>,
  set innerHTML(value: string) {
    this.markup = value;
    this.actions = value.includes('data-generated-result-action') ? [generatedResultAction] : [];
  },
  get innerHTML() {
    return this.markup;
  },
};
const editor = { id: 'same-node-editor', value: 'keep prompt' };
const submit = { id: 'same-node-submit', disabled: false };
const nodeState = { resultRegion, editor, submit };
const nodeStub = {
  querySelector(selector: string) {
    if (selector === '[data-generation-result-region]') return nodeState.resultRegion;
    if (selector === '.node-generation-expanded') return nodeState.editor;
    if (selector === '[data-generation-submit]') return nodeState.submit;
    return null;
  },
};

assert.equal(interactions.updateGenerationResultRegion(nodeStub, '<button data-generated-result-action>new result action</button>'), true);
assert.equal(resultRegion.innerHTML, '<button data-generated-result-action>new result action</button>');
assert.equal(nodeStub.querySelector('[data-generation-result-region]'), resultRegion, 'result region identity is retained');
assert.equal(resultRegion.actions[0], generatedResultAction, 'updated result actions remain present in result state');
assert.equal(nodeStub.querySelector('.node-generation-expanded'), editor, 'same-node editor identity is retained');
assert.equal(nodeStub.querySelector('[data-generation-submit]'), submit, 'same-node submit identity is retained');
assert.equal(editor.value, 'keep prompt');
assert.equal(submit.disabled, false);

const appSource = readFileSync('public/tools/ultimate-canvas/app.js', 'utf8');
assert.ok(
  appSource
    .slice(appSource.indexOf('function decorateGeneratedNode'), appSource.indexOf('function createDirectorOutput'))
    .includes('draggable="false"'),
  'generated result images disable browser-native image dragging',
);

const nodeCardDragStart = engineSource.indexOf("wrap.querySelector('.node-card').addEventListener('mousedown'");
const nodeCardDragEnd = engineSource.indexOf('// Select', nodeCardDragStart);
assert.ok(nodeCardDragStart >= 0 && nodeCardDragEnd > nodeCardDragStart, 'node-card drag handler must exist');
const nodeCardDragSource = engineSource.slice(nodeCardDragStart, nodeCardDragEnd);
const leftButtonGuardIndex = nodeCardDragSource.indexOf('if (e.button !== 0) return;');
const preventDefaultIndex = nodeCardDragSource.indexOf('e.preventDefault();');
const dragInitializationIndex = nodeCardDragSource.indexOf('this.isDraggingNode = true');
assert.ok(leftButtonGuardIndex >= 0 && leftButtonGuardIndex < preventDefaultIndex,
  'node-card dragging ignores non-left mouse buttons before cancelling native behavior');
assert.ok(preventDefaultIndex >= 0 && preventDefaultIndex < dragInitializationIndex,
  'node-card dragging cancels native image selection before moving the node');
assert.ok(nodeCardDragSource.includes('textarea, input, select, button, a, [contenteditable]'),
  'interactive controls inside node cards remain excluded from node dragging');

console.log('ultimate-canvas-result-layout-smoke passed');
