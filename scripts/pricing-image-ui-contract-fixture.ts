import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { creditCents, normalizeCredits } from '../src/lib/credits/precision';
import { validVideoPricingAmount } from '../src/lib/pricing-client';
import type { ImageUiQuote } from '../src/app/image-studio/use-studio-batch';
import type { CanvasImageModelOption } from '../src/lib/pricing/image-option-contract';

type ImageUiHelpers = Pick<typeof import('../src/app/image-studio/use-studio-batch'),
  'formatImageUiCredits' | 'validImageUiQuote' | 'imageUiQuoteChanged' | 'imageUiQuoteFields' | 'parseImageUiBudget' | 'imageUiQuoteAction' | 'imageUiBudgetPrecision'>;
type CanvasMenuOption = { value: string; label: string; disabled?: boolean };
type CanvasMenuState = { valid: boolean; selectedModel: string; rows: Array<{
  model: string; label: string; selected: boolean; disabled: boolean; status: string; detail: string;
}> };

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
  const window: {
    UltimateCanvasNodePricing?: {
      formatCredits(value: number): string;
      fullQuoteRequired(projection: object): boolean;
      validFullQuote(quote: unknown, projection: object, now: number): boolean;
      validModelOption(option: unknown): option is CanvasImageModelOption;
      modelMenuState(options: readonly CanvasMenuOption[], modelOptions: unknown, selectedModel: string, count: number): CanvasMenuState;
      validImageProjection(quote: unknown, payload: { project_id: string; model: string; count: number; channelId?: string }, expectedChannelId: string | undefined, now: number): boolean;
    };
    UltimateCanvasStyles?: {
      billingQuoteFields(quote: ImageUiQuote): { billingQuoteId: string; maxEstimatedCost: number; pricingRevision?: string };
    };
  } = {};
  for (const filename of ['public/tools/ultimate-canvas/node-pricing.js', 'public/tools/ultimate-canvas/canvas-styles.js']) {
    vm.runInNewContext(readFileSync(resolve(filename), 'utf8'), { window, Date, console }, { filename, timeout: 1000 });
  }
  assert.ok(window.UltimateCanvasNodePricing);
  assert.ok(window.UltimateCanvasStyles);
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
  assert.ok('billingQuoteId' in fields && 'maxEstimatedCost' in fields);
  assert.equal(fields.billingQuoteId, fixed.billingQuoteId);
  assert.equal(fields.pricingRevision, fixed.pricingRevision);
  assert.equal(fields.maxEstimatedCost, 0.6, 'Uses server total without integer ceil');
  assert.deepEqual(fields.imageChannel, fixed.imageChannel);
  const actualFields = ui.imageUiQuoteFields(actual), legacyFields = ui.imageUiQuoteFields(legacy);
  assert.ok('maxEstimatedCost' in actualFields);
  assert.ok('maxEstimatedCost' in legacyFields);
  assert.equal(actualFields.maxEstimatedCost, 3.03);
  assert.equal(legacyFields.maxEstimatedCost, 0.45);
  const batch: ImageUiQuote = { ...fixed, billingQuoteId: undefined, batchQuoteId: 'batch-quote' };
  const batchFields = ui.imageUiQuoteFields(batch, true);
  assert.ok('batchQuoteId' in batchFields && 'budget' in batchFields);
  assert.equal(batchFields.batchQuoteId, 'batch-quote');
  assert.equal(batchFields.budget, 0.6);
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

  let menuAssertions = 0;
  const expectMenu = (value: unknown, expected: unknown, message: string) => { assert.equal(value, expected, message); menuAssertions += 1; };
  const fixedOption: CanvasImageModelOption = { model: 'fixed-model', label: 'Fixed model', status: 'estimate', reason: null, reasonText: null,
    count: 3, chargeEnabled: false, unitCredits: 0.2, estimatedCredits: 0.6, billingMode: 'fixed', actualQuoteRequired: false,
    estimateSource: 'channel_contract', creditPrecision: 0.1, pricingRevision: 'rate-r1', pricingQuoteRequired: true };
  const unavailable: CanvasImageModelOption = { ...fixedOption, model: 'unavailable-model', status: 'unavailable', reason: 'provider_unavailable',
    reasonText: '当前供应商暂不可用', unitCredits: null, estimatedCredits: null };
  const freeOption: CanvasImageModelOption = { ...fixedOption, model: 'free-model', unitCredits: 0, estimatedCredits: 0 };
  const actualOption: CanvasImageModelOption = { ...fixedOption, model: 'actual-model', billingMode: 'actual', actualQuoteRequired: true,
    unitCredits: null, estimatedCredits: null, creditPrecision: 0.01, pricingRevision: undefined, pricingQuoteRequired: false };
  for (const option of [fixedOption, unavailable, freeOption, actualOption]) {
    expectMenu(pricing.validModelOption(option), true, `Valid read-only candidate: ${option.model}`);
    expectMenu(pricing.validFullQuote(option, projection, now), false, 'A candidate is never a full authorization quote');
  }
  const invalidOptions: unknown[] = [null, {}, { ...fixedOption, status: 'ready' }, { ...fixedOption, chargeEnabled: true },
    { ...fixedOption, count: 0 }, { ...fixedOption, count: 1.5 }, { ...fixedOption, count: 9 },
    { ...fixedOption, unitCredits: null }, { ...fixedOption, estimatedCredits: null },
    { ...fixedOption, unitCredits: undefined }, { ...fixedOption, estimatedCredits: undefined },
    { ...fixedOption, unitCredits: '0.2' }, { ...fixedOption, estimatedCredits: '0.6' },
    { ...fixedOption, unitCredits: -1 }, { ...fixedOption, estimatedCredits: NaN },
    { ...fixedOption, unitCredits: Infinity }, { ...fixedOption, estimatedCredits: 10000000.01 },
    { ...fixedOption, unitCredits: 0.15, estimatedCredits: 0.45 }, { ...fixedOption, estimatedCredits: 0.5 },
    { ...fixedOption, creditPrecision: 1 }, { ...fixedOption, reason: 'provider_unavailable' },
    { ...fixedOption, pricingRevision: undefined }, { ...fixedOption, estimateSource: 'assumed' },
    { ...unavailable, unitCredits: 0.2 }, { ...unavailable, estimatedCredits: 0.6 },
    { ...unavailable, unitCredits: 0, estimatedCredits: 0 }, { ...unavailable, reason: '' },
    { ...unavailable, reason: null }, { ...unavailable, reasonText: '' }, { ...unavailable, reasonText: null },
    { ...unavailable, reasonText: undefined }, { ...unavailable, reasonText: ' \t ' },
    { ...unavailable, reasonText: 'unsafe\u0000text' }, { ...actualOption, unitCredits: 0 },
    { ...actualOption, estimatedCredits: 0 }, { ...actualOption, unitCredits: 0.2, estimatedCredits: 0.6 },
    { ...actualOption, actualQuoteRequired: false }, { ...fixedOption, actualQuoteRequired: true }];
  for (const option of invalidOptions) expectMenu(pricing.validModelOption(option), false, 'Malformed candidate status/price/reason must reject');
  for (const field of ['billingQuoteId', 'batchQuoteId', 'maxEstimatedCost', 'billingContract', 'pricingCharge', 'imageChannel', 'proof']) {
    expectMenu(pricing.validModelOption({ ...fixedOption, [field]: 'not-menu-data' }), false, 'Menu candidates cannot carry authorization or channel bindings');
  }
  expectMenu(pricing.validModelOption({ ...fixedOption, unitCredits: 0.15, estimatedCredits: 0.45, creditPrecision: 0.01 }), true,
    'Legal legacy hundredths remain displayable');
  const nativeOptions = Object.freeze([
    { value: fixedOption.model, label: 'Native fixed label' }, { value: unavailable.model, label: 'Native unavailable label' },
    { value: freeOption.model, label: 'Native free label' }, { value: actualOption.model, label: 'Native actual label' },
    { value: 'missing-model', label: 'Missing candidate' }, { value: 'native-disabled', label: 'Disabled locally', disabled: true },
  ]);
  const candidates = Object.freeze([actualOption, freeOption, unavailable, fixedOption,
    { ...fixedOption, model: 'server-extra' }, { ...fixedOption, model: 'native-disabled' }]);
  const settings = Object.freeze({ model: unavailable.model, quality: 'high', resolution: '2K', channelId: 'original' });
  const originalInputs = JSON.stringify([nativeOptions, candidates, settings]);
  const menu = pricing.modelMenuState(nativeOptions, candidates, settings.model, 3);
  expectMenu(menu.valid, true, 'Shuffled server candidates match by model, not index');
  expectMenu(menu.rows.length, nativeOptions.length, 'Server-only candidates never expand native select options');
  expectMenu(menu.rows.some(row => row.model === 'server-extra'), false, 'Server-only old model is not inserted');
  expectMenu(menu.rows[0].detail, '0.2 点/张', 'Fixed price belongs to its matching model');
  expectMenu(menu.rows[0].label, 'Native fixed label', 'Keep the original allowed option label');
  expectMenu(menu.rows[1].detail, unavailable.reasonText, 'Unavailable reason is visible');
  expectMenu(menu.rows[1].disabled, true, 'Unavailable row cannot be chosen');
  expectMenu(menu.rows[1].selected, true, 'Currently selected unavailable model stays selected');
  expectMenu(menu.selectedModel, settings.model, 'No fallback model is chosen');
  expectMenu(menu.rows.filter(row => row.selected).length, 1, 'No second model becomes selected');
  expectMenu(menu.rows[2].detail, '0 点/张', 'Confirmed fixed zero is not an unknown price');
  expectMenu(menu.rows[2].disabled, false, 'Legal fixed zero remains selectable');
  expectMenu(menu.rows[3].detail, '按实际费用计费', 'Actual candidate does not show a fixed estimate');
  expectMenu(menu.rows[3].disabled, false, 'Actual candidates may be chosen, but still need a full quote');
  expectMenu(menu.rows[4].disabled, true, 'Missing candidate is never assumed usable');
  expectMenu(menu.rows[4].detail, '费用待确认', 'Missing candidate is not shown as zero');
  expectMenu(menu.rows[5].disabled, true, 'Server price cannot override native disabled state');
  expectMenu(JSON.stringify([nativeOptions, candidates, settings]), originalInputs, 'Model, quality, resolution, channel and source inputs stay unchanged');
  for (const modelOptions of [undefined, [], [fixedOption, fixedOption], [...candidates, { ...actualOption, unitCredits: 0 }]]) {
    const refused = pricing.modelMenuState(nativeOptions, modelOptions, settings.model, 3);
    expectMenu(refused.valid, false, 'Missing, duplicate or malformed candidate lists reject');
    expectMenu(refused.rows.every(row => row.disabled), true, 'Rejected candidates cannot enable a click');
    expectMenu(refused.selectedModel, settings.model, 'Rejected response preserves the selected model');
  }
  expectMenu(pricing.modelMenuState(nativeOptions, candidates, settings.model, 2).valid, false, 'Candidates for another count reject');
  const malicious = '<img src=x onerror="throw new Error(1)"><script>bad()</script>';
  const textMenu = pricing.modelMenuState(nativeOptions, [{ ...unavailable, label: malicious, reasonText: malicious }], settings.model, 3);
  expectMenu(textMenu.rows[1].label, 'Native unavailable label', 'Server markup cannot replace the native model label');
  expectMenu(textMenu.rows[1].detail, malicious, 'Reason remains literal text for the real textContent renderer');
  expectMenu(textMenu.rows[1].disabled, true, 'Malicious text cannot make an unavailable row usable');

  const payload = { project_id: 'project-a', model: fixedOption.model, count: 3, channelId: 'original' };
  const channel = { channelId: 'model-default', configRevision: '12345678-1234-4234-8234-123456789abc' };
  const canvasProjection = { ...fixedOption, kind: 'image', projectId: payload.project_id, channelId: 'original', revision: 4,
    expiresAt: fixed.expiresAt, imageChannel: channel, modelOptions: candidates };
  expectMenu(pricing.validImageProjection(canvasProjection, payload, 'original', now), true,
    'Original follows the model default; snapshot need not literally be original');
  expectMenu(pricing.validImageProjection(canvasProjection, payload, channel.channelId, now), true,
    'Known effective model-default channel stays bound');
  expectMenu(pricing.validImageProjection(canvasProjection, payload, 'another-default', now), false,
    'A concrete effective-channel mismatch still rejects');
  expectMenu(pricing.validImageProjection({ ...canvasProjection, imageChannel: undefined }, payload, 'original', now), true,
    'Legacy original without a managed snapshot remains valid');
  expectMenu(pricing.validImageProjection({ ...canvasProjection, imageChannel: undefined }, payload, channel.channelId, now), false,
    'Known managed default cannot lose its channel binding');
  const { channelId: _selector, ...implicitPayload } = payload;
  expectMenu(pricing.validImageProjection(canvasProjection, implicitPayload, undefined, now), true,
    'A channel snapshot alone is not proof that the user explicitly chose a supplier');
  expectMenu(pricing.validImageProjection(canvasProjection, implicitPayload, channel.channelId, now), true,
    'An implicit route can still retain a known effective binding');
  expectMenu(pricing.validImageProjection(canvasProjection, implicitPayload, 'another-default', now), false,
    'Known implicit effective binding cannot mismatch');
  const explicit = { ...payload, channelId: channel.channelId };
  expectMenu(pricing.validImageProjection({ ...canvasProjection, channelId: channel.channelId }, explicit, channel.channelId, now), true,
    'Explicit concrete channel remains supported');
  expectMenu(pricing.validImageProjection(canvasProjection, explicit, channel.channelId, now), false,
    'Explicit request selector mismatch rejects');
  expectMenu(pricing.validImageProjection({ ...canvasProjection, channelId: channel.channelId,
    imageChannel: { ...channel, channelId: 'wrong-channel' } }, explicit, channel.channelId, now), false,
    'Explicit snapshot mismatch rejects');
  for (const invalid of [{ ...canvasProjection, modelOptions: [fixedOption, fixedOption] }, { ...canvasProjection, modelOptions: [actualOption] },
    { ...canvasProjection, estimatedCredits: 0.5 }, { ...canvasProjection, revision: 4.5 },
    { ...canvasProjection, count: 2 }, { ...canvasProjection, projectId: 'project-b' },
    { ...canvasProjection, expiresAt: new Date(now - 1).toISOString() },
    { ...canvasProjection, imageChannel: { ...channel, configRevision: 'invalid' } }]) {
    expectMenu(pricing.validImageProjection(invalid, payload, 'original', now), false, 'Strict selected projection binding rejects stale or malformed data');
  }
  const actualProjection = { ...canvasProjection, ...actualOption };
  const actualPayload = { ...payload, model: actualOption.model };
  expectMenu(pricing.validImageProjection(actualProjection, actualPayload, 'original', now), true, 'Actual projection keeps both candidate prices null');
  expectMenu(pricing.fullQuoteRequired(actualProjection), true, 'Actual menu projection still requires full authorization');
  expectMenu(pricing.validFullQuote(actualProjection, actualProjection, now), false, 'Actual projection is not a full quote');
  expectMenu(pricing.validImageProjection({ ...actualProjection, estimatedCredits: 0.6 }, actualPayload, 'original', now), false,
    'Actual selected projection cannot retain a fixed estimate');
  const unavailableProjection = { ...canvasProjection, ...unavailable };
  expectMenu(pricing.validImageProjection(unavailableProjection, { ...payload, model: unavailable.model }, 'original', now), true,
    'Valid unavailable projection may be displayed without authorizing generation');
  expectMenu(pricing.validImageProjection({ ...unavailableProjection, unitCredits: 0.2 }, { ...payload, model: unavailable.model }, 'original', now), false,
    'Unavailable selected projection cannot retain an old price');
  return { completed: true as const, checks: [
    { id: 'G11' as const, assertions: 17 + menuAssertions, evidence: ['Executed real image UI quote/request helpers and canvas quote fields; server totals and pricing revision/proof retained for fixed, actual and legacy contracts.',
      'Executed actual canvas validModelOption/modelMenuState/validImageProjection exports: nullable unavailable and actual prices, legal fixed zero, reason text, native option range and selection preservation, malformed/duplicate/missing candidates, literal malicious text and original/concrete channel semantics.'] },
    { id: 'G13' as const, assertions: 12, evidence: ['Executed real scoped quote action gate and canvas full-quote validator: changed actor/document/input, missing proof, expiration and revision mismatch cannot submit.'] },
    { id: 'G17' as const, assertions: 10, evidence: ['Executed real pending-request query action and quote-change comparison; lower/same-total revised quotes require re-quote, request identity and original inputs remain unchanged. No worker or settlement claim.'] },
    { id: 'G21' as const, assertions: 39, evidence: ['Executed actual UI format/parse/validation functions with 0.1 new prices, 0.01 legacy values, 100.15 balance, unmigrated integer/mixed decimal budgets, invalid precision and upper limits. No browser, provider, network or database.'] },
  ] };
}
