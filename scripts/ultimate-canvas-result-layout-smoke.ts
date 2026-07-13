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

const baseCards = ruleWith(['.node-type-video .node-card', '.node-type-image .node-card']);
assertDeclarations(baseCards, { width: '350px', height: '240px' });

const emptySelectedCards = ruleWith([
  '.canvas-node.selected.node-type-video .node-card',
  '.canvas-node.selected.node-type-image .node-card',
]);
assertDeclarations(emptySelectedCards, { width: '350px', 'max-width': '350px', height: '240px' });

const selectedBodies = ruleWith([
  '.canvas-node.selected.node-type-video .node-body',
  '.canvas-node.selected.node-type-image .node-body',
]);
assertDeclarations(selectedBodies, { 'min-height': '208px' });

const selectedPlaceholders = ruleWith([
  '.canvas-node.selected.node-type-video .card-preview-placeholder',
  '.canvas-node.selected.node-type-image .card-preview-placeholder',
]);
assertDeclarations(selectedPlaceholders, { height: '130px' });

const selectedResultSelectors = [
  '.canvas-node.selected.node-type-video .node-card:has([data-generation-result-region]:not(:empty))',
  '.canvas-node.selected.node-type-image .node-card:has([data-generation-result-region]:not(:empty))',
];
assertDeclarations(ruleWith(selectedResultSelectors), { height: '240px', 'min-height': '240px' });

const selectedResultBodies = selectedResultSelectors.map(selector => `${selector} .node-body`);
assertDeclarations(ruleWith(selectedResultBodies), { height: '100%', 'min-height': '208px' });

assertDeclarations(ruleWith(['.generated-reference-card']), {
  'box-sizing': 'border-box',
});

const selectedResultCards = selectedResultSelectors.map(selector => `${selector} .generated-reference-card`);
assertDeclarations(ruleWith(selectedResultCards), { height: '100%', 'min-height': '0', padding: '10px' });

const selectedActions = ruleWith([
  '.canvas-node.selected.node-type-video .generated-action-row',
  '.canvas-node.selected.node-type-image .generated-action-row',
]);
assertDeclarations(selectedActions, { display: 'flex' });
assertDeclarations(selectedActions, {
  'flex-wrap': 'nowrap',
  'overflow-x': 'auto',
  'overflow-y': 'hidden',
  height: '24px',
  'min-height': '24px',
  flex: '0 0 24px',
});

const unselectedActions = ruleWith([
  '.canvas-node:not(.selected).node-type-video .generated-action-row',
  '.canvas-node:not(.selected).node-type-image .generated-action-row',
]);
assertDeclarations(unselectedActions, { display: 'none' });

assertDeclarations(ruleWith(['.generated-frame-preview']), {
  flex: '0 1 auto',
  'max-height': '260px',
  'object-fit': 'contain',
});

const selectedResultPreviews = selectedResultSelectors.map(selector => `${selector} .generated-frame-preview`);
assertDeclarations(ruleWith(selectedResultPreviews), {
  'min-height': '0',
  'max-height': '92px',
  'margin-top': '8px',
});

assertDeclarations(ruleWith(['.node-video-props']), {
  'margin-left': 'calc((350px - 640px) / 2)',
});
assertDeclarations(ruleWith(['.node-image-props']), {
  'margin-left': 'calc((350px - 640px) / 2)',
});

assertDeclarations(ruleWith(['.node-connector']), {
  width: '20px',
  height: '20px',
  top: '50%',
});

let mobileMedia: any = null;
css.walkAtRules('media', (atRule: any) => {
  if (atRule.params === '(max-width: 720px)') mobileMedia = atRule;
});
assert.ok(mobileMedia, 'missing 720px mobile layout rule');
const mobileSelectedCards = ruleWith([
  '.node-type-video .node-card',
  '.node-type-image .node-card',
], mobileMedia);
assertDeclarations(mobileSelectedCards, {
  width: 'min(350px, calc(100vw - 24px))',
  'max-width': 'min(350px, calc(100vw - 24px))',
});
assert.equal(Math.min(350, 390 - 24), 350, '390px viewport keeps the selected card at its compact width');

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

console.log('ultimate-canvas-result-layout-smoke passed');
