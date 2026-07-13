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

function panelGeometry(cardWidth: number, panelWidth = 350) {
  const inset = (cardWidth - panelWidth) / 2;
  return {
    leftOverflow: Math.max(0, -inset),
    rightOverflow: Math.max(0, -inset),
    cardCenter: cardWidth / 2,
    panelCenter: inset + panelWidth / 2,
  };
}

assert.deepEqual(panelGeometry(interactions.generationNodeDimensions('9:16').width), {
  leftOverflow: 76.5625,
  rightOverflow: 76.5625,
  cardCenter: 98.4375,
  panelCenter: 98.4375,
}, '9:16 panels overflow symmetrically while preserving the media-card center');
assert.deepEqual(panelGeometry(interactions.generationNodeDimensions('16:9').width), {
  leftOverflow: 0,
  rightOverflow: 0,
  cardCenter: 175,
  panelCenter: 175,
}, '16:9 panels remain centered without horizontal overflow');

const generationNodes = ruleWith(['.canvas-node.node-type-video', '.canvas-node.node-type-image']);
assertDeclarations(generationNodes, { width: 'var(--generation-node-width, 350px)' });

const baseCards = ruleWith(['.node-type-video .node-card', '.node-type-image .node-card']);
assertDeclarations(baseCards, {
  width: 'var(--generation-node-width, 350px)',
  height: 'var(--generation-node-height, 196.875px)',
});

const cardBodies = ruleWith([
  '.node-type-video .node-body',
  '.node-type-image .node-body',
]);
assertDeclarations(cardBodies, { height: '100%', 'min-height': '0', overflow: 'hidden' });

const resultRegions = ruleWith([
  '.node-type-video .generation-result-region:not(:empty)',
  '.node-type-image .generation-result-region:not(:empty)',
]);
assertDeclarations(resultRegions, { height: '100%', 'min-height': '0', overflow: 'hidden' });

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
  '.node-type-video .generation-result-region:not(:empty) .generated-reference-card',
  '.node-type-image .generation-result-region:not(:empty) .generated-reference-card',
]), { height: '100%', 'min-height': '0', padding: '10px' });

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

assertDeclarations(ruleWith(['.node-video-props', '.node-image-props']), {
  width: '350px',
  'margin-left': '0',
  left: '50%',
  transform: 'translateX(-50%)',
});

assertDeclarations(ruleWith(['.node-connector']), {
  width: '20px',
  height: '20px',
  top: '50%',
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
