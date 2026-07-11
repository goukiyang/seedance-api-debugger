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
assertDeclarations(emptySelectedCards, { width: '620px', 'max-width': '620px', height: '350px' });

const selectedResultSelectors = [
  '.canvas-node.selected.node-type-video .node-card:has([data-generation-result-region]:not(:empty))',
  '.canvas-node.selected.node-type-image .node-card:has([data-generation-result-region]:not(:empty))',
];
assertDeclarations(ruleWith(selectedResultSelectors), { height: 'auto', 'min-height': '350px' });

const selectedResultBodies = selectedResultSelectors.map(selector => `${selector} .node-body`);
assertDeclarations(ruleWith(selectedResultBodies), { height: 'auto' });

assertDeclarations(ruleWith(['.generated-reference-card']), {
  'box-sizing': 'border-box',
  height: 'auto',
});

const selectedActions = ruleWith([
  '.canvas-node.selected.node-type-video .generated-action-row',
  '.canvas-node.selected.node-type-image .generated-action-row',
]);
assertDeclarations(selectedActions, { display: 'flex' });

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
  '.canvas-node.selected.node-type-video .node-card',
  '.canvas-node.selected.node-type-image .node-card',
], mobileMedia);
assertDeclarations(mobileSelectedCards, {
  width: 'calc(100vw - 24px)',
  'max-width': 'calc(100vw - 24px)',
});
assert.equal(390 - 24, 366, '390px viewport leaves 12px on each side of the selected card');
selectedResultSelectors.forEach(selector => {
  assert.ok(selectors(mobileSelectedCards).some(candidate => selector.startsWith(candidate)), 'mobile selected-card cap also applies to nonempty result cards');
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

console.log('ultimate-canvas-result-layout-smoke passed');
