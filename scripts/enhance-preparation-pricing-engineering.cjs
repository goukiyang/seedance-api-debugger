const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = process.env.ENGINEERING_SOURCE_ROOT || process.cwd();
function select(file, names) {
 const source = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
 return source.statements.filter(n => (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && names.includes(n.name?.text)
  || ts.isVariableStatement(n) && n.declarationList.declarations.some(d => names.includes(d.name.getText(source))))
  .map(n => n.getText(source).replace(/^export /, '')).join('\n');
}
const source = [select('src/lib/creation/contract.ts', ['CreationError', 'creationIdentity']),
 select('src/lib/tasks/enhance-video-create.ts', ['enhanceVideoSourcePricing', 'assertEnhanceVideoSourceTaskAllowed']),
 select('src/lib/pricing/frozen-charge.ts', ['PricingChargeError']),
 select('src/lib/pricing/video.ts', ['quoteVideoPricing', 'videoPricingIdentity', 'requireVideoPricingRevision', 'videoPricingError']),
 select('src/lib/creation/intents.ts', ['INPUT_FIELDS', 'normalizeVideoCreationSpec', 'prepareVideoCreationIntent']),
 select('src/lib/creation/http.ts', ['creationHttp']),
 'globalThis.run = prepareVideoCreationIntent; globalThis.http = creationHttp; globalThis.PriceError = PricingChargeError;'].join('\n');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const checks = [];
function setup(overrides = {}) {
 const quotes = [], reads = [], charges = []; let transaction = 0;
 const boundary = new Error('ENGINEERING_REACHED_WRITE_BOUNDARY');
 const sourceTask = { local_status: 'succeeded', provider: 'seedance', raw_status_response: JSON.stringify({ data: { fps: 48, duration: 15.125 } }) };
 const sandbox = { Buffer, Date, Error, Number, JSON, Object, Math,
  prisma: { videoCreationIntent: { findUnique: async () => overrides.previous || null }, $transaction: async () => { transaction++; throw boundary; } },
  assertVideoCreationReady: async () => {}, assertNoPreparationRejection: async () => {},
  applyCanvasReferenceInputs: body => body, resolveCanvasReferenceInputs: async () => null,
  resolveMultiviewActionVideoInput: async () => null, assertVideoPromptGroupSurface: () => [],
  readCreationContext: async () => ({ project: { type: 'personal' }, payer: { kind: 'user', id: 'fixture-user' } }),
  creationParent: () => null, assertCreationLineageUnlocked: async () => {},
  readCreationSource: async (db, user, id) => { reads.push(id); if (overrides.forbidden) throw new Error('source access denied'); return { ...sourceTask, ...overrides.sourceTask }; },
  pricingFingerprint: value => JSON.stringify(value), creationSpecHash: value => JSON.stringify(value), creditCents: value => value * 100,
  resolveVideoPricingContext: async () => ({}), projectIntent: async (user, intent) => intent,
  isSeedanceVideoDuration: () => true, calculateEstimatedCost: () => ({}), calculateH3EstimatedCost: () => ({}), calculateEnhanceVideoEstimatedCost: () => ({}),
  normalizeDecimal: value => String(Number(value)), roundDecimal: value => Number(value).toFixed(3), multiplyDecimal: values => values.reduce((a,b) => a * Number(b), 1), normalizeCredits: value => value,
  videoPricingRequiresContext: async () => false,
  quotePricingCharge: async (identity, quantity) => { quotes.push({ identity, quantity }); return { charge: { mode: 'custom', baseCny: '0.025', pointsPerCny: '10', quantity, revision: 'fixture-price', ruleId: 'fixture-rule', identity }, credits: Number(quantity) * 0.25 }; },
  frozenPricingCredits: charge => (charges.push(charge), { credits: Number(charge.quantity) * 0.25, exactCredits: String(Number(charge.quantity) * 0.25) }),
  getSession: async () => ({ id: 'fixture-user', status: 'active' }), AuthError: class extends Error {}, VideoPromptGroupError: class extends Error {},
  NextResponse: { json: (body, init = {}) => ({ body, status: init.status || 200 }) } };
 vm.runInNewContext(code, sandbox);
 return { sandbox, quotes, reads, boundary, charges, get transaction() { return transaction; } };
}
const body = { request_id: 'fixture-request', action: 'enhance', entry: 'enhance', project_id: 'fixture-project',
 provider: 'volcengine_mediakit', model: 'enhance-video', duration: 15, resolution: '1080p', tool_version: 'standard',
 fps: null, source_task_id: 'fixture-source', sourceFps: 120, sourceDuration: 999, pricing_revision: 'fixture-price' };
(async () => {
 const original = setup(); await assert.rejects(original.sandbox.run({ id: 'fixture-user' }, body), error => error === original.boundary);
 assert.equal(original.transaction, 1); assert.deepEqual(original.reads, ['fixture-source']);
 assert.equal(original.quotes.at(-1).identity.specifications.fpsTier, 'gt30'); assert.equal(original.charges[0].quantity, '15.125');
 checks.push('no_interpolation_preparation_reads_authorized_original_fps_instead_of_failing_before_intent');
 const selected = setup(); await assert.rejects(selected.sandbox.run({}, { ...body, fps: 60 }), error => error === selected.boundary);
 assert.equal(selected.quotes.at(-1).identity.specifications.fpsTier, 'gt30'); assert.equal(selected.charges[0].quantity, '15.125');
 checks.push('selected_output_fps_keeps_its_tier_and_server_source_duration_is_used');
 const unknown = setup({ sourceTask: { raw_status_response: '{}' } });
 await assert.rejects(unknown.sandbox.run({}, body), error => error.code === 'pricing_quote_changed');
 assert.equal(unknown.transaction, 0);
 checks.push('unknown_source_fps_remains_an_explicit_pricing_rejection_without_creating_anything');
 const forbidden = setup({ forbidden: true }); await assert.rejects(forbidden.sandbox.run({}, body), /access denied/); assert.equal(forbidden.quotes.length, 0); assert.equal(forbidden.transaction, 0);
 checks.push('source_access_rejection_stops_before_quoting_or_writing');
 const accepted = setup({ previous: { state: 'accepted', id: 'original-intent' } }); const acceptedResult = await accepted.sandbox.run({}, body);
 assert.equal(acceptedResult.id, 'original-intent'); assert.equal(accepted.reads.length, 0); assert.equal(accepted.transaction, 0);
 checks.push('accepted_original_is_read_without_repreparing_or_repricing');
 const regular = setup(); await assert.rejects(regular.sandbox.run({}, { ...body, action: 'generate', entry: 'ordinary', provider: 'seedance', model: 'seedance-2.0', duration: 5 }), error => error === regular.boundary);
 assert.equal(regular.reads.length, 0); assert.equal(regular.quotes[0].identity.kind, 'video');
 checks.push('ordinary_preparation_does_not_read_enhance_metadata');
 const mapping = setup(); const failure = await mapping.sandbox.http(async () => { throw new mapping.sandbox.PriceError('Source frame rate required'); });
 assert.equal(failure.status, 409); assert.equal(failure.body.code, 'pricing_quote_changed'); assert.equal(failure.body.error, 'Source frame rate required');
 const unknownFailure = await mapping.sandbox.http(async () => { throw new Error('private internal detail'); }); assert.equal(unknownFailure.status, 503); assert.equal(unknownFailure.body.code, 'creation_result_unknown'); assert.ok(!unknownFailure.body.error.includes('private'));
 checks.push('known_pricing_errors_keep_their_real_status_while_unknown_errors_remain_protected');
 console.log(JSON.stringify({ task: 'ENHANCE-PRICE01', checks, productionWrites: 0, paidRequests: 0, remoteNetworkRequests: 0 }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
