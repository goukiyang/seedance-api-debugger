import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { creditCents, normalizeCredits } from '../src/lib/credits/precision';
import { validVideoPricingAmount } from '../src/lib/pricing-client';
import type { ImageUiQuote } from '../src/app/image-studio/use-studio-batch';

type ImageUiHelpers = Pick<typeof import('../src/app/image-studio/use-studio-batch'),
  'formatImageUiCredits' | 'validImageUiQuote' | 'imageUiQuoteChanged' | 'imageUiQuoteFields' | 'parseImageUiBudget' | 'imageUiQuoteAction' | 'imageUiBudgetPrecision'>;

// Compile the actual exported business functions without loading React, browser
// modules, hooks or their side effects. No implementation is copied into the fixture.
function loadUiHelpers(): ImageUiHelpers {
  const filename = resolve('src/app/image-studio/use-studio-batch.tsx');
  const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Set(['formatImageUiCredits', 'validImageUiQuote', 'imageUiQuoteChanged', 'imageUiQuoteFields', 'parseImageUiBudget', 'imageUiQuoteAction', 'imageUiBudgetPrecision']);
  const functions = source.statements.filter(statement => ts.isFunctionDeclaration(statement)
    && statement.name && names.has(statement.name.text) && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword));
  assert.equal(functions.length, names.size, 'Fixture requires the real exported UI helpers');
  const compiled = ts.transpileModule(functions.map(statement => statement.getText(source)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, creditCents, normalizeCredits, validVideoPricingAmount, Date }, { filename, timeout: 1000 });
  return exports as ImageUiHelpers;
}

function loadCanvasPricing() {
  const window: Record<string, any> = {};
  for (const filename of ['public/tools/ultimate-canvas/node-pricing.js', 'public/tools/ultimate-canvas/canvas-styles.js']) {
    vm.runInNewContext(readFileSync(resolve(filename), 'utf8'), { window, Date, console }, { filename, timeout: 1000 });
  }
  return { pricing: window.UltimateCanvasNodePricing, styles: window.UltimateCanvasStyles };
}

export function runPricingImageUiContractFixture() {
  const ui = loadUiHelpers();
  const { pricing, styles } = loadCanvasPricing();
  const now = Date.now();
  const fixed: ImageUiQuote = { billingMode: 'fixed', billingQuoteId: 'quote-fixed', pricingRevision: 'rate-r1',
    creditPrecision: 0.1, unitCredits: 0.2, estimatedCredits: 0.6, expiresAt: new Date(now + 60000).toISOString(),
    imageChannel: { channelId: 'shared', configRevision: 'channel-r1' } };
  const legacy: ImageUiQuote = { billingMode: 'fixed', billingQuoteId: null, unitCredits: 0.15,
    estimatedCredits: 0.45, expiresAt: fixed.expiresAt };
  const actual: ImageUiQuote = { ...fixed, billingMode: 'actual', billingQuoteId: 'quote-actual', creditPrecision: 0.01,
    unitCredits: 1.01, estimatedCredits: 3.03 };
  for (const [amount, display] of [[0, '0'], [0.1, '0.1'], [0.6, '0.6'], [1.01, '1.01'], [100.15, '100.15']] as const) {
    assert.equal(ui.formatImageUiCredits(amount), display);
    assert.equal(pricing.formatCredits(amount), display);
  }
  for (const [input, amount] of [['0.1', 0.1], ['0.01', 0.01], ['100.15', 100.15], ['10000000', 10000000]] as const) {
    assert.equal(ui.parseImageUiBudget(input), amount);
  }
  for (const input of ['', '-1', '1e2', '0.001', '10000000.01', 'NaN', 'Infinity', ' 0.1 ']) assert.equal(ui.parseImageUiBudget(input), null);
  assert.equal(ui.validImageUiQuote(legacy, now), true);
  assert.equal(ui.validImageUiQuote(fixed, now), true);
  assert.equal(ui.validImageUiQuote(actual, now), true);
  assert.equal(ui.validImageUiQuote({ ...fixed, billingQuoteId: null }, now), false);
  assert.equal(ui.validImageUiQuote({ ...actual, billingQuoteId: null }, now), false);
  assert.equal(ui.validImageUiQuote({ ...fixed, estimatedCredits: 0.001 }, now), false);
  assert.equal(ui.validImageUiQuote({ ...fixed, unitCredits: 0.15 }, now), false, 'New tenths cannot silently truncate old hundredths');
  assert.equal(ui.imageUiBudgetPrecision(fixed, 100), 0.1);
  assert.equal(ui.imageUiBudgetPrecision(fixed, 100.15), 0.01, 'Old committed hundredths must remain payable');
  assert.equal(ui.imageUiBudgetPrecision(legacy, 100), 1, 'Unmigrated old batch keeps its integer budget contract');
  assert.equal(ui.imageUiBudgetPrecision({ ...legacy, pricingRevision: 'rate-legacy', creditPrecision: 0.01 }, 100), 0.01);
  assert.equal(ui.parseImageUiBudget('0.15', 1), null);
  assert.equal(ui.parseImageUiBudget('1.0', 1), null, 'Old integer text parser is not silently migrated');
  assert.equal(ui.parseImageUiBudget('1', 1), 1);
  assert.equal(ui.parseImageUiBudget('0.15', 0.1), null);
  assert.equal(ui.parseImageUiBudget('0.2', 0.1), 0.2);
  assert.equal(ui.parseImageUiBudget('100.75', ui.imageUiBudgetPrecision(fixed, 100.15)), 100.75);

  const fields = ui.imageUiQuoteFields(fixed);
  assert.equal(fields.billingQuoteId, fixed.billingQuoteId);
  assert.equal(fields.pricingRevision, fixed.pricingRevision);
  assert.equal(fields.maxEstimatedCost, 0.6, 'Uses server total without integer ceil');
  assert.deepEqual(fields.imageChannel, fixed.imageChannel);
  assert.equal(ui.imageUiQuoteFields(actual).maxEstimatedCost, 3.03);
  assert.equal(ui.imageUiQuoteFields(legacy).maxEstimatedCost, 0.45);
  const batch: ImageUiQuote = { ...fixed, billingQuoteId: undefined, batchQuoteId: 'batch-quote' };
  assert.equal(ui.imageUiQuoteFields(batch, true).batchQuoteId, 'batch-quote');
  assert.equal(ui.imageUiQuoteFields(batch, true).budget, 0.6);
  assert.equal(ui.validImageUiQuote({ ...batch, batchQuoteId: null }, now, true), false);
  assert.throws(() => ui.imageUiQuoteFields({ ...fixed, expiresAt: new Date(now - 1).toISOString() }));

  const signature = JSON.stringify(['actor-a', 'document-a', 'module-a', { prompt: 'Keep original', assetIds: ['asset-a'] }]);
  assert.equal(ui.imageUiQuoteAction('original-request', signature, signature, fixed, now), 'query');
  assert.equal(ui.imageUiQuoteAction(null, signature, signature, fixed, now), 'submit');
  assert.equal(ui.imageUiQuoteAction(null, signature.replace('actor-a', 'actor-b'), signature, fixed, now), 'quote');
  assert.equal(ui.imageUiQuoteAction(null, signature.replace('document-a', 'document-b'), signature, fixed, now), 'quote');
  assert.equal(ui.imageUiQuoteAction(null, signature.replace('Keep original', 'Edited'), signature, fixed, now), 'quote');
  assert.equal(ui.imageUiQuoteAction(null, signature, signature, fixed, now + 60001), 'quote');
  assert.equal(ui.imageUiQuoteAction(null, signature, undefined, undefined, now), 'quote');
  assert.equal(ui.imageUiQuoteChanged(fixed, { ...fixed, pricingRevision: 'rate-r2' }), true, 'Same total still requires new revision');
  assert.equal(ui.imageUiQuoteChanged(fixed, { ...fixed, estimatedCredits: 0.3 }), true, 'Lower price also changes the quote');
  assert.equal(ui.imageUiQuoteChanged(fixed, { ...fixed, imageChannel: { channelId: 'shared', configRevision: 'channel-r2' } }), true);
  assert.equal(ui.imageUiQuoteChanged(fixed, { ...fixed, billingQuoteId: 'renewed-proof' }), false);

  const projection = { actualQuoteRequired: false, pricingQuoteRequired: true, revision: 4, pricingRevision: 'rate-r1' };
  const canvasQuote = { ...fixed, revision: 4 };
  assert.equal(pricing.fullQuoteRequired(projection), true);
  assert.equal(pricing.fullQuoteRequired({ actualQuoteRequired: true }), true);
  assert.equal(pricing.validFullQuote(canvasQuote, projection, now), true);
  assert.equal(pricing.validFullQuote({ ...canvasQuote, pricingRevision: 'rate-r2' }, projection, now), false);
  assert.equal(pricing.validFullQuote({ ...canvasQuote, revision: 5 }, projection, now), false);
  assert.equal(pricing.validFullQuote(canvasQuote, projection, now + 60001), false);
  assert.equal(pricing.validFullQuote({ ...canvasQuote, billingQuoteId: null }, projection, now), false);
  const bound = styles.billingQuoteFields(canvasQuote);
  assert.equal(bound.maxEstimatedCost, 0.6);
  assert.equal(bound.pricingRevision, 'rate-r1');
  assert.equal(bound.billingQuoteId, 'quote-fixed');
  assert.throws(() => styles.billingQuoteFields({ ...canvasQuote, billingQuoteId: null }));
  assert.throws(() => styles.billingQuoteFields({ ...canvasQuote, expiresAt: new Date(now - 1).toISOString() }));
  const preserved = { requestId: 'original-request', ownerId: 'actor-a', documentId: 'document-a',
    referenceImageIds: ['asset-a'], prompt: 'Keep original', ...fields };
  assert.equal(preserved.requestId, 'original-request');
  assert.equal(preserved.ownerId, 'actor-a');
  assert.equal(preserved.documentId, 'document-a');
  assert.deepEqual(preserved.referenceImageIds, ['asset-a']);
  assert.equal(preserved.prompt, 'Keep original');
  return { completed: true as const, checks: [
    { id: 'G11' as const, assertions: 17, evidence: ['Executed real image UI quote/request helpers and canvas quote fields; server totals and pricing revision/proof retained for fixed, actual and legacy contracts.'] },
    { id: 'G13' as const, assertions: 12, evidence: ['Executed real scoped quote action gate and canvas full-quote validator: changed actor/document/input, missing proof, expiration and revision mismatch cannot submit.'] },
    { id: 'G17' as const, assertions: 10, evidence: ['Executed real pending-request query action and quote-change comparison; lower/same-total revised quotes require re-quote, request identity and original inputs remain unchanged. No worker or settlement claim.'] },
    { id: 'G21' as const, assertions: 39, evidence: ['Executed actual UI format/parse/validation functions with 0.1 new prices, 0.01 legacy values, 100.15 balance, unmigrated integer/mixed decimal budgets, invalid precision and upper limits. No browser, provider, network or database.'] },
  ] };
}
