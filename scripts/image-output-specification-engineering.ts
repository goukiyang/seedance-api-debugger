import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { SessionUser } from '../src/lib/auth/session';
import { traceFixture, sha256 } from './image-trace-engineering-fixture';

const sourcePaths = ['scripts/image-trace-engineering-fixture.ts', 'scripts/image-canvas-quote-fixture.ts', 'src/lib/image-generation/output-plan.ts',
  'src/lib/image-generation/resolution.ts', 'src/lib/image-studio/ratios.ts', 'src/lib/integrations/image-generation.ts',
  'src/lib/image-studio/tasks.ts', 'src/lib/image-studio/billing-quote.ts', 'src/lib/image-studio/billing-quote-service.ts',
  'src/lib/image-studio/billing-quote-store.ts', 'src/lib/image-studio/batch-billing-quote.ts', 'src/lib/template-studio/validation.ts',
  'src/lib/image-studio/batches.ts', 'src/lib/image-studio/batch-contract.ts', 'src/lib/image-studio/modules.ts', 'src/lib/avatar-random/service.ts',
  'src/app/api/assets/generate/route.ts', 'src/lib/image-studio/provider.ts',
  'src/lib/image-studio/shared-contract.ts', 'src/lib/image-studio/shared-types.ts', 'src/lib/image-studio/read-snapshot.ts',
  'src/lib/image-studio/worker.ts', 'src/lib/image-studio/async-recovery.ts', 'src/lib/image-studio/queue-capacity.ts',
  'src/lib/image-studio/provider-wait.ts', 'src/lib/image-studio/worker-mode.ts', 'src/lib/tools/toolflow-runtime.ts',
  'src/lib/tools/toolflow.ts', 'src/app/api/tools/ultimate-canvas/flows/[id]/quote/route.ts', 'public/tools/ultimate-canvas/toolflow-workflow.js',
  'public/tools/ultimate-canvas/canvas-styles.js', 'public/tools/ultimate-canvas/node-pricing.js', 'public/tools/ultimate-canvas/app.js'];
const expectedChecks = [
  'new_2k_reference_and_all_standard_ratios_keep_pixel_budget',
  'four_extreme_2k_ratios_fit_real_domain_and_4k_conflicts_reject',
  'explicit_native_halfk_and_legacy_sizes_are_preserved',
  'saved_version_and_public_plan_are_strict_and_private',
  'new_and_legacy_wire_serialization_use_the_frozen_plan',
  'old_request_key_returns_original_without_repricing_or_writing',
  'fixed_and_actual_quote_plan_hashes_reject_legacy_or_changed_authorization',
  'old_parent_prepared_and_unprepared_items_keep_legacy_after_restart',
  'new_batch_auto_is_resolved_independently_for_each_source',
  'saved_avatar_plan_keeps_legacy_quote_without_new_reservation',
  'new_writer_requires_current_worker_and_helper_only_changes_reject',
  'legacy_synchronous_quote_uses_real_preparation_branch_without_post_or_writes',
  'toolflow_new_known_and_future_auto_freeze_actual_plans_and_reject_old_quote_or_changed_inputs',
  'toolflow_legacy_prepared_and_unprepared_runs_keep_frozen_sizes_without_migration',
  'toolflow_unknown_task_blocks_retry_and_redispatch_without_another_freeze_or_post',
  'canvas_fixed_ordinary_and_style_keep_plan_quote_token_and_original_confirmation_count',
  'canvas_actual_original_confirmation_and_max_authorization_are_unchanged',
  'canvas_role_context_and_unknown_job_identity_survive_query_only_reentry_without_repost',
  'versioned_batch_quote_canonical_keys_preserve_array_order_and_reject_changed_authorization',
  'toolflow_authenticated_frozen_channels_create_only_with_fresh_configuration_and_unchanged_quote_identity',
];

async function main() {
  const fixture = await traceFixture({ file: 'scripts/image-output-specification-engineering.ts',
    schema: 'image-output-specification-engineering.v1', marker: 'Image output specification engineering receipt: ',
    sources: sourcePaths, checks: expectedChecks });
  const plans = await import('../src/lib/image-generation/output-plan');
  const ratios = await import('../src/lib/image-studio/ratios');
  const { requestStudioImages } = await import('../src/lib/image-studio/provider');
  const { imageOutputSize } = await import('../src/lib/image-generation/resolution');
  const model = 'gpt-image-2.5-sunburst';
  const resolve = (ratio: string, resolution = '2K', extra: Partial<Parameters<typeof plans.resolveImageOutputPlan>[0]> = {}) =>
    plans.resolveImageOutputPlan({ model, resolution, ratio, ...extra });
  const assertPixelBudget = (size: string, ratio: string) => {
    const [width, height] = size.split('x').map(Number), [rw, rh] = ratio.split(':').map(Number);
    assert.ok(width % 16 === 0 && height % 16 === 0 && Math.max(width, height) <= 3840);
    assert.ok(width * height >= 4194304 * .95 && width * height <= 4194304, `${ratio} must retain its 2K pixel budget`);
    assert.ok(Math.abs(width / height / (rw / rh) - 1) <= .005, `${ratio} must retain its intended ratio`);
  };
  const referencePlan = resolve('58:77', '2K', { requestedRatio: 'auto', aspectRatioSource: 'reference' });
  for (const ratio of [...ratios.STUDIO_RATIOS.filter(value => value !== '4:1'), '58:77']) assertPixelBudget(resolve(ratio).outputSize, ratio);
  assert.notEqual(referencePlan.outputSize, '928x1232');
  fixture.check(expectedChecks[0]);
  const extremes = ['21:9', '9:21', '3:1', '1:3'];
  for (const ratio of extremes) assertPixelBudget(resolve(ratio).outputSize, ratio);
  for (const ratio of ['2:1', '1:2', ...extremes]) assert.throws(() => resolve(ratio, '4K'));
  fixture.check(expectedChecks[1]);
  assert.equal(resolve('58:77', '2K', { ratioContractVersion: 2 }).outputSize, '928x1232');
  assert.equal(resolve('58:77', '2K', { explicitSize: '1856x2464' }).outputSize, '1856x2464');
  for (const resolution of ['1K', '2K', '4K']) {
    const native = plans.resolveImageOutputPlan({ model: 'gemini-3-pro-image-preview', resolution, ratio: '58:77', native: true });
    assert.equal(native.outputSize, resolution); assert.equal(native.width, null); assert.equal(native.wireMode, 'native');
  }
  assert.equal(imageOutputSize('gemini-3.1-flash-image-preview', '0.5K', '1:1'), '0.5K');
  assert.equal(resolve('1:1', '0.5K').outputSize, ratios.legacyStudioRatioSize('1:1', '0.5K'));
  fixture.check(expectedChecks[2]);
  assert.equal(plans.savedImageRatioContractVersion({}), 2);
  assert.equal(plans.savedImageRatioContractVersion({ ratioContractVersion: 3 }), 3);
  assert.throws(() => plans.savedImageRatioContractVersion({ ratioContractVersion: 99 }));
  const publicPlan = plans.publicImageOutputPlan({ ...referencePlan, api_key: 'secret', providerUrl: 'https://secret.invalid', owner: 'secret' });
  assert.ok(publicPlan); assert.equal(JSON.stringify(publicPlan).includes('secret'), false);
  assert.equal(plans.imageOutputPlanHash(referencePlan), plans.imageOutputPlanHash({ ...referencePlan }));
  assert.notEqual(plans.imageOutputPlanHash(referencePlan), plans.imageOutputPlanHash({ ...referencePlan, outputSize: '928x1232' }));
  fixture.check(expectedChecks[3]);
  let synchronousPosts = 0;
  const synchronousSubmit = async () => { synchronousPosts++; return { submitted: true }; };
  const synchronousQuote = await plans.withSynchronousImageOutputPlan<Record<string, unknown>>({ quote: true, outputPlan: referencePlan, model, count: 1 },
    synchronousSubmit, value => ({ ...value }));
  assert.equal(synchronousPosts, 0); assert.equal(synchronousQuote.quoteOnly, true); assert.equal(synchronousQuote.submitted, false);
  assert.deepEqual(synchronousQuote.outputPlan, plans.publicImageOutputPlan(referencePlan));
  await plans.withSynchronousImageOutputPlan({ quote: false, outputPlan: referencePlan, model, count: 1 }, synchronousSubmit, () => ({ submitted: false }));
  assert.equal(synchronousPosts, 1);
  const wire: Array<Record<string, unknown>> = [];
  const transport: typeof fetch = async (_input, init) => {
    assert.equal(init?.method, 'POST'); wire.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ data: [{ b64_json: 'AAAA' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await requestStudioImages({ baseUrl: 'https://wire-fixture.invalid', apiKey: 'synthetic-not-a-credential', protocol: 'openai_images',
    model, prompt: 'Synthetic', count: 1, images: [], signal: AbortSignal.timeout(5000), ratio: '58:77', size: referencePlan.outputSize,
    ratioContractVersion: 3, outputPlan: referencePlan }, transport);
  await requestStudioImages({ baseUrl: 'https://wire-fixture.invalid', apiKey: 'synthetic-not-a-credential', protocol: 'openai_images',
    model, prompt: 'Synthetic', count: 1, images: [], signal: AbortSignal.timeout(5000), ratio: '58:77', size: '928x1232', ratioContractVersion: 2 }, transport);
  assert.equal(wire[0].size, referencePlan.outputSize); assert.equal('ratio' in wire[0], false);
  assert.equal(wire[1].size, '928x1232'); assert.equal(wire[1].ratio, '58:77');
  fixture.check(expectedChecks[4]);

  const { db } = fixture, owner = 'trace-spec-owner';
  await db.user.create({ data: { id: owner, name: 'Synthetic', username: owner, email: `${owner}@fixture.invalid`,
    password_hash: 'not-a-login', role: 'admin', account_type: 'internal' } });
  await db.creditAccount.create({ data: { user_id: owner, balance: 1000, frozen_credits: 0 } });
  const requestId = randomUUID(), batchId = sha256(`${owner}:${requestId}`);
  const original = await db.imageStudioTask.create({ data: { id: `${batchId}-0`, owner_id: owner, batch_id: batchId, ordinal: 0,
    fingerprint: 'original-frozen', prompt: 'Original', context: 'Original context', revision: 0, model, reference_ids: '[]',
    unit_credits: 5, status: 'uncertain', output_size: '928x1232', snapshot_json: JSON.stringify({ requestId, sharedLive: { protocol: 'shared-live-v1' } }),
    freeze_snapshot: '[]' } });
  const { submitStudioBatch } = await import('../src/lib/image-studio/tasks');
  assert.equal(await submitStudioBatch(owner, { requestId, prompt: 'Changed request must not replace accepted identity' }), batchId);
  assert.deepEqual(await db.imageStudioTask.findUniqueOrThrow({ where: { id: original.id } }), original);
  assert.equal(await db.creditLedger.count(), 0);
  fixture.check(expectedChecks[5]);

  // The remaining checks enter the real quote, batch preparation and avatar paths.
  const batchFingerprintEvidence = await verifySavedPlans(fixture, owner, model);
  assert.equal(synchronousPosts, 1); fixture.check(expectedChecks[11]);
  const toolFlowQuoteEvidence = await verifyToolFlows(fixture, owner, model);
  const { verifyCanvasQuoteContract } = await import('./image-canvas-quote-fixture');
  const canvasQuoteEvidence = await verifyCanvasQuoteContract(fixture.root, plans.publicImageOutputPlan(referencePlan)!, fixture.check);
  fixture.check(expectedChecks[18]);
  fixture.check(expectedChecks[19]);
  assert.throws(() => assertPixelBudget(ratios.legacyStudioRatioSize('58:77', '2K')!, '58:77'));
  await fixture.finish({ negativeChecks: ['legacy_gcd_rejected_by_current_pixel_budget', 'legacy_batch_object_key_order_rejects_equivalent_submission',
    'toolflow_quote_hmac_and_fresh_context_reject_changed_intent'], canvasQuoteEvidence, batchFingerprintEvidence, toolFlowQuoteEvidence,
    wire: wire.map(body => ({ size: body.size, ratio: body.ratio })) });
}

async function verifyToolFlows(fixture: Awaited<ReturnType<typeof traceFixture>>, owner: string, model: string) {
  const { db } = fixture, flows = await import('../src/lib/tools/toolflow-runtime');
  const user = await db.user.findUniqueOrThrow({ where: { id: owner } }) as SessionUser;
  const assets = await db.asset.findMany({ where: { owner_id: owner }, orderBy: { file_name: 'asc' } });
  assert.equal(assets.length, 2);
  const ids = [assets[0].id], nextIds = [assets[1].id];
  const graph = { version: 1, nodes: [
    { id: 'input', type: 'flow-input', x: 0, y: 0, data: {} },
    { id: 'image', type: 'flow-template', x: 1, y: 0, data: { source: 'system', prompt: 'Synthetic', model, resolution: '2K', ratio: 'auto' } },
    { id: 'future', type: 'flow-template', x: 2, y: 0, data: { source: 'system', prompt: 'Synthetic future', model, resolution: '2K', ratio: 'auto' } },
    { id: 'output', type: 'flow-output', x: 3, y: 0, data: {} },
  ], connections: [{ from: 'input', to: 'image' }, { from: 'image', to: 'future' }, { from: 'future', to: 'output' }] };
  const flow = await db.toolFlow.create({ data: { owner_id: owner, name: 'Synthetic new flow', status: 'active', graph_json: JSON.stringify(graph) } });
  const quote = await flows.getToolFlowQuote(user, flow.id, ids);
  assert.equal(quote.ratioContractVersion, 3); assert.deepEqual(quote.inputAssetIds, ids); assert.equal(quote.estimatedCredits, 10);
  assert.equal(quote.steps[0].outputPlan?.resolvedRatio, '58:77'); assert.equal(quote.steps[1].outputPlan, null);
  assert.deepEqual(quote.steps[1].outputIntent, { resolution: '2K', requestedRatio: 'auto' });
  const proof = flows.createToolFlowQuoteProof(owner, quote);
  const oldQuote = { ...quote }; delete oldQuote.ratioContractVersion;
  await assert.rejects(flows.createToolFlowRun(user, flow.id, ids, oldQuote, flows.createToolFlowQuoteProof(owner, oldQuote)));
  await assert.rejects(flows.createToolFlowRun(user, flow.id, nextIds, quote, proof));
  assert.equal(await db.toolFlowRun.count(), 0); assert.equal(await db.creditLedger.count(), 0);
  const baselineTasks = await db.imageStudioTask.count(), baselineAccount = await db.creditAccount.findUniqueOrThrow({ where: { user_id: owner } });
  const rejected: string[] = [];
  const rejectQuote = async (name: string, value: typeof quote, signed = proof) => {
    await assert.rejects(flows.createToolFlowRun(user, flow.id, ids, value, signed), name);
    assert.equal(await db.toolFlowRun.count(), 0); assert.equal(await db.imageStudioTask.count(), baselineTasks);
    assert.equal(await db.creditLedger.count(), 0);
    assert.deepEqual(await db.creditAccount.findUniqueOrThrow({ where: { user_id: owner } }), baselineAccount);
    rejected.push(name);
  };
  assert.ok(quote.steps[0].imageChannel); assert.ok(quote.steps[0].outputPlan);
  const changedChannel = structuredClone(quote);
  changedChannel.steps[0].imageChannel = { ...quote.steps[0].imageChannel, configRevision: randomUUID() };
  await rejectQuote('channel_tamper_with_original_hmac', changedChannel);
  const changedPlan = structuredClone(quote);
  changedPlan.steps[0].outputPlan = { ...quote.steps[0].outputPlan, outputSize: '1024x1024' };
  await rejectQuote('plan_tamper_with_original_hmac', changedPlan);
  await rejectQuote('input_tamper_with_original_hmac', { ...quote, inputAssetIds: nextIds });
  const apiSetting = await db.platformSetting.findUniqueOrThrow({ where: { key: 'image_generation_api_v1' } });
  await db.platformSetting.update({ where: { id: apiSetting.id }, data: { value_json: JSON.stringify({ ...JSON.parse(apiSetting.value_json), base_url: 'https://changed-fixture.invalid' }) } });
  try { await rejectQuote('real_original_configuration_changed', quote); }
  finally { await db.platformSetting.update({ where: { id: apiSetting.id }, data: { value_json: apiSetting.value_json } }); }
  await db.toolFlow.update({ where: { id: flow.id }, data: { version: flow.version + 1 } });
  try { await rejectQuote('real_flow_version_changed', quote); }
  finally { await db.toolFlow.update({ where: { id: flow.id }, data: { version: flow.version } }); }
  const other = await db.user.create({ data: { id: 'trace-toolflow-other-owner', name: 'Synthetic other owner', username: 'trace-toolflow-other-owner',
    email: 'trace-toolflow-other-owner@fixture.invalid', password_hash: 'not-a-login', role: 'admin', account_type: 'internal' } });
  await db.toolFlow.update({ where: { id: flow.id }, data: { owner_id: other.id } });
  try { await rejectQuote('real_flow_owner_changed', quote); }
  finally { await db.toolFlow.update({ where: { id: flow.id }, data: { owner_id: owner } }); }
  const expiredQuote = { ...quote, expiresAt: new Date(Date.now() - 1).toISOString() };
  await rejectQuote('authentic_but_expired_quote', expiredQuote, flows.createToolFlowQuoteProof(owner, expiredQuote));
  for (const [name, steps] of [
    ['missing_authenticated_node', quote.steps.slice(1)],
    ['duplicate_authenticated_node', [quote.steps[0], quote.steps[0]]],
    ['reordered_authenticated_nodes', [...quote.steps].reverse()],
  ] as const) {
    const malformed = { ...quote, steps: [...steps] };
    await rejectQuote(name, malformed, flows.createToolFlowQuoteProof(owner, malformed));
  }
  const run = await flows.createToolFlowRun(user, flow.id, ids, quote, proof);
  assert.equal(JSON.parse(run.snapshot_json).ratioContractVersion, 3);
  const first = await db.imageStudioTask.findFirstOrThrow({ where: { tool_flow_run_id: run.id, tool_flow_node_id: 'image' } });
  const firstSnapshot = JSON.parse(first.snapshot_json!);
  assert.equal(first.unit_credits, 5); assert.equal(firstSnapshot.outputPlan.resolvedRatio, '58:77');
  assert.deepEqual(firstSnapshot.imageChannel, quote.steps[0].imageChannel);
  assert.equal(firstSnapshot.outputPlan.outputSize, first.output_size); assert.match(firstSnapshot.outputPlanHash, /^[a-f0-9]{64}$/);
  assert.equal(await db.imageStudioTask.count({ where: { tool_flow_run_id: run.id, tool_flow_node_id: 'future' } }), 0);
  // The next node receives a real result's dimensions, never the quote-time input's assumed shape.
  await db.imageStudioTask.update({ where: { id: first.id }, data: { status: 'succeeded', asset_id: assets[1].id } });
  await flows.completeToolFlowTask(first.id); await flows.advanceToolFlowRun(run.id);
  const future = await db.imageStudioTask.findFirstOrThrow({ where: { tool_flow_run_id: run.id, tool_flow_node_id: 'future' } });
  assert.equal(JSON.parse(future.snapshot_json!).outputPlan.resolvedRatio, '16:9'); assert.equal(future.unit_credits, 5);
  assert.deepEqual(JSON.parse(future.snapshot_json!).imageChannel, quote.steps[1].imageChannel);
  const publicRun = await flows.getToolFlowRun(user, run.id);
  for (const node of publicRun.node_runs) if (JSON.parse(node.result_json || '{}').outputPlans) {
    const publicPlans = JSON.stringify(JSON.parse(node.result_json!).outputPlans);
    assert.equal(publicPlans.includes('outputPlanHash'), false); assert.equal(publicPlans.includes('algorithmRevision'), false);
  }
  fixture.check(expectedChecks[12]);

  const legacyGraph = { version: 1, nodes: [graph.nodes[0], { ...graph.nodes[1], data: { source: 'system', prompt: 'Legacy synthetic', model, ratio: '58:77', size: '928x1232' } }, graph.nodes[3]],
    connections: [{ from: 'input', to: 'image' }, { from: 'image', to: 'output' }] };
  const legacyFlow = await db.toolFlow.create({ data: { owner_id: owner, name: 'Synthetic old flow', graph_json: JSON.stringify(legacyGraph) } });
  const legacy = await db.toolFlowRun.create({ data: { flow_id: legacyFlow.id, owner_id: owner, flow_version: 1, status: 'running',
    snapshot_json: JSON.stringify({ schema: 'toolflow.v1', flow_id: legacyFlow.id, flow_owner_id: owner, version: 1, name: legacyFlow.name,
      project_id: null, graph: legacyGraph, input_asset_ids: ids }), node_runs: { create: legacyGraph.nodes.map(node => ({ node_id: node.id,
      status: node.id === 'input' ? 'succeeded' : 'pending', output_asset_ids: node.id === 'input' ? JSON.stringify(ids) : '[]',
      result_json: node.id === 'input' ? JSON.stringify({ succeededAssetIds: ids }) : null })) } } });
  const oldSnapshot = legacy.snapshot_json;
  await flows.advanceToolFlowRun(legacy.id);
  const prepared = await db.imageStudioTask.findFirstOrThrow({ where: { tool_flow_run_id: legacy.id } });
  assert.equal(prepared.output_size, '928x1232'); assert.equal(JSON.parse(prepared.snapshot_json!).ratioContractVersion, undefined);
  await flows.advanceToolFlowRun(legacy.id);
  assert.deepEqual(await db.imageStudioTask.findUniqueOrThrow({ where: { id: prepared.id } }), prepared);
  assert.equal((await db.toolFlowRun.findUniqueOrThrow({ where: { id: legacy.id } })).snapshot_json, oldSnapshot);
  assert.equal(await db.imageStudioTask.count({ where: { tool_flow_run_id: legacy.id } }), 1);
  fixture.check(expectedChecks[13]);

  await db.imageStudioTask.update({ where: { id: future.id }, data: { status: 'uncertain' } });
  await flows.completeToolFlowTask(future.id);
  const node = await db.toolFlowNodeRun.findUniqueOrThrow({ where: { run_id_node_id: { run_id: run.id, node_id: 'future' } } });
  assert.equal(node.status, 'running'); assert.equal(JSON.parse(node.result_json!).failedTaskIds.includes(future.id), false);
  const money = await db.creditAccount.findUniqueOrThrow({ where: { user_id: owner } });
  const ledgers = await db.creditLedger.findMany({ orderBy: { id: 'asc' } }), taskCount = await db.imageStudioTask.count();
  await assert.rejects(flows.updateToolFlowRun(user, run.id, { action: 'retry', nodeId: 'future' }));
  // A stale failed UI projection also cannot bypass the authoritative task identity guard.
  await db.toolFlowNodeRun.update({ where: { id: node.id }, data: { status: 'failed' } });
  await assert.rejects(flows.updateToolFlowRun(user, run.id, { action: 'retry', nodeId: 'future' }));
  await db.toolFlowNodeRun.update({ where: { id: node.id }, data: { status: 'pending' } });
  await flows.advanceToolFlowRun(run.id);
  assert.equal((await db.toolFlowNodeRun.findUniqueOrThrow({ where: { id: node.id } })).status, 'running');
  assert.equal(await db.imageStudioTask.count(), taskCount);
  assert.deepEqual(await db.creditLedger.findMany({ orderBy: { id: 'asc' } }), ledgers);
  assert.deepEqual(await db.creditAccount.findUniqueOrThrow({ where: { user_id: owner } }), money);
  assert.equal((await db.toolFlowRun.findUniqueOrThrow({ where: { id: run.id } })).frozen_credits, 5);
  fixture.check(expectedChecks[14]);
  return { authenticatedFrozenChannelsPreserved: true, futureAutoQuotedPlan: null, rejected, rejectedNewRuns: 0, rejectedNewTasks: 0, rejectedNewLedgerEntries: 0 };
}

async function verifySavedPlans(fixture: Awaited<ReturnType<typeof traceFixture>>, owner: string, model: string) {
  const { db } = fixture;
  const { DEFAULT_STUDIO_PRICES } = await import('../src/lib/image-studio/settings');
  await db.platformSetting.create({ data: { key: 'gpt_image_studio_v1', value_json: JSON.stringify({ context: '', model, revision: 0,
    prices: { ...DEFAULT_STUDIO_PRICES, [model]: 5 } }) } });
  await db.platformSetting.create({ data: { key: 'image_generation_api_v1', value_json: JSON.stringify({ enabled: true,
    provider: 'musk', base_url: 'https://spec-fixture.invalid', api_key: 'synthetic-not-a-credential', default_model: model,
    supports_text_to_image: true, supports_image_to_image: true }) } });
  const { defaultStudioModuleId, validStudioModuleId } = await import('../src/lib/image-studio/modules');
  const moduleId = defaultStudioModuleId(owner);
  assert.equal(validStudioModuleId(moduleId, owner), true);
  await db.imageStudioModule.create({ data: { id: moduleId, owner_id: owner, name: 'Synthetic', model, resolution: '2K', aspect_ratio: 'auto' } });
  const { resolveImageOutputPlan, imageOutputPlanHash } = await import('../src/lib/image-generation/output-plan');
  const { assertImageQuoteOutputPlan } = await import('../src/lib/image-studio/billing-quote-store');
  const plan = resolveImageOutputPlan({ model, resolution: '2K', ratio: '58:77' });
  for (const mode of ['fixed', 'actual']) {
    const quote = { ratioContractVersion: 3 as const, outputPlans: [plan], outputPlanHashes: [imageOutputPlanHash(plan)], contract: { mode } };
    assert.doesNotThrow(() => assertImageQuoteOutputPlan(quote, { ratioContractVersion: 3, outputPlans: [plan], outputPlanHashes: [imageOutputPlanHash(plan)] }));
    assert.throws(() => assertImageQuoteOutputPlan({}, { ratioContractVersion: 3, outputPlans: [plan], outputPlanHashes: [imageOutputPlanHash(plan)] }));
    assert.throws(() => assertImageQuoteOutputPlan({ ...quote, outputPlanHashes: ['0'.repeat(64)] }, { ratioContractVersion: 3, outputPlans: [plan], outputPlanHashes: [imageOutputPlanHash(plan)] }));
  }
  fixture.check(expectedChecks[6]);
  // Real parent continuation is exercised with persisted prepared/unprepared data.
  const { updateStudioBatch, createStudioBatch } = await import('../src/lib/image-studio/batches');
  const { prepareImageBillingQuote } = await import('../src/lib/image-studio/billing-quote-service');
  const oldId = sha256('trace-old-parent'), preparedKey = `studio_batch_item_v1:${oldId}:1`;
  const baseInput = { requestId: randomUUID(), prompt: 'Synthetic', count: 1, revision: 0, referenceIds: [],
    moduleId, model, quality: 'auto', resolution: '2K', aspectRatio: '58:77' };
  const parent = { version: 1, id: oldId, ownerId: owner, requestId: baseInput.requestId, fingerprint: 'frozen-parent',
    moduleId, moduleName: 'Synthetic', state: 'blocked', note: '', createdAt: new Date().toISOString(), total: 2,
    budget: 10, committedCredits: 0, unitCredits: 5, prepared: 1, input: baseInput,
    items: [1, 2].map(ordinal => ({ ordinal, sourceName: `source-${ordinal}`, taskId: null, attempt: 0, prepared: ordinal === 1, cancelled: false })) };
  const { submitStudioBatch } = await import('../src/lib/image-studio/tasks');
  let prepared: Record<string, unknown> | undefined;
  await submitStudioBatch(owner, { ...baseInput, requestId: randomUUID() }, undefined,
    { batchItem: true, ratioContractVersion: 2, save: async (_tx, task) => { prepared = task as unknown as Record<string, unknown>; } });
  assert.ok(prepared); prepared.id = `${oldId}-1-a0`; prepared.batch_id = oldId; prepared.ordinal = 1;
  await db.platformSetting.create({ data: { key: preparedKey, value_json: JSON.stringify(prepared) } });
  const before = (await db.platformSetting.findUniqueOrThrow({ where: { key: preparedKey } })).value_json;
  await db.platformSetting.create({ data: { key: `studio_batch_v1:${owner}:${oldId}`, value_json: JSON.stringify(parent) } });
  await updateStudioBatch(owner, { id: oldId, action: 'prepare' });
  assert.equal((await db.platformSetting.findUniqueOrThrow({ where: { key: preparedKey } })).value_json, before);
  const second = JSON.parse((await db.platformSetting.findUniqueOrThrow({ where: { key: `studio_batch_item_v1:${oldId}:2` } })).value_json);
  assert.equal(second.output_size, '928x1232'); assert.equal(JSON.parse(second.snapshot_json).ratioContractVersion, 2);
  await updateStudioBatch(owner, { id: oldId, action: 'pause' }); await updateStudioBatch(owner, { id: oldId, action: 'resume' });
  assert.equal((await db.platformSetting.findUniqueOrThrow({ where: { key: preparedKey } })).value_json, before);
  fixture.check(expectedChecks[7]);
  const sources = [];
  for (const [index, width, height] of [[0, 580, 770], [1, 1600, 900]]) {
    const asset = await db.asset.create({ data: { owner_id: owner, type: 'image', original_url: `/uploads/assets/synthetic-${index}.png`,
      file_name: `synthetic-${index}.png`, mime_type: 'image/png', width, height, file_size: 100 } });
    sources.push({ name: asset.file_name, assetId: asset.id });
  }
  const newBody = { ...baseInput, requestId: randomUUID(), aspectRatio: 'auto', referenceIds: sources.map(source => source.assetId), sources, budget: 10 };
  const { quoteStudioBatch } = await import('../src/lib/image-studio/batch-billing-quote');
  const newQuote = await quoteStudioBatch(owner, newBody);
  const { STUDIO_SHARED_WORKER_KEY, STUDIO_SHARED_WORKER_FILES, assertSharedStudioWorkerReady } = await import('../src/lib/image-studio/tasks');
  const heartbeat = { protocol: 'shared-live-v1', expiresAt: new Date(Date.now() + 600000).toISOString(),
    loadedModuleSha: Object.fromEntries(STUDIO_SHARED_WORKER_FILES.map(file => [file, sha256(readFileSync(path.join(fixture.root, file)))])) };
  await db.platformSetting.create({ data: { key: STUDIO_SHARED_WORKER_KEY, value_json: JSON.stringify(heartbeat) } });
  const fingerprint = await verifyBatchQuoteFingerprint(fixture, owner, newBody, newQuote);
  const newId = await createStudioBatch(owner, fingerprint.creationBody);
  const newItems = await Promise.all([1, 2].map(ordinal => db.platformSetting.findUniqueOrThrow({ where: { key: `studio_batch_item_v1:${newId}:${ordinal}` } })));
  const newPlans = newItems.map(row => JSON.parse(JSON.parse(row.value_json).snapshot_json).outputPlan);
  assert.equal(newPlans[0].resolvedRatio, '58:77'); assert.equal(newPlans[1].resolvedRatio, '16:9');
  assert.notEqual(newPlans[0].outputSize, newPlans[1].outputSize);
  fixture.check(expectedChecks[8]);
  const avatar = await import('../src/lib/avatar-random/service');
  const avatarStore = await import('../src/lib/avatar-random/store');
  const avatarPlan = await avatar.prepareAvatarPlan(owner, { rules: { description: '', people: 1, candidates: 1,
    intensity: 'standard', choices: {}, locks: {} }, model, quality: 'auto', resolution: '2K' });
  const avatarKey = avatarStore.avatarPlanKey(owner, avatarPlan), row = await db.platformSetting.findUniqueOrThrow({ where: { key: avatarKey } });
  const legacyAvatar = JSON.parse(row.value_json);
  delete legacyAvatar.ratioContractVersion; delete legacyAvatar.outputPlan; delete legacyAvatar.outputPlanHash;
  await db.platformSetting.update({ where: { key: avatarKey }, data: { value_json: JSON.stringify(legacyAvatar) } });
  const quote = await avatar.quoteAvatarPlan(owner, avatarPlan.id);
  assert.equal(quote.ratioContractVersion, 2);
  assert.equal((await db.platformSetting.findUniqueOrThrow({ where: { key: avatarKey } })).value_json, JSON.stringify(legacyAvatar));
  assert.equal(await db.creditLedger.count(), 0); assert.equal((await db.creditAccount.findUniqueOrThrow({ where: { user_id: owner } })).frozen_credits, 0);
  assert.equal(typeof prepareImageBillingQuote, 'function');
  fixture.check(expectedChecks[9]);
  for (const changed of ['src/lib/image-studio/worker.ts', 'src/lib/image-generation/output-plan.ts', 'src/lib/template-studio/validation.ts']) {
    await db.platformSetting.update({ where: { key: STUDIO_SHARED_WORKER_KEY }, data: { value_json: JSON.stringify({ ...heartbeat,
      loadedModuleSha: { ...heartbeat.loadedModuleSha, [changed]: '0'.repeat(64) } }) } });
    await assert.rejects(db.$transaction(tx => assertSharedStudioWorkerReady(tx)));
  }
  await db.platformSetting.update({ where: { key: STUDIO_SHARED_WORKER_KEY }, data: { value_json: JSON.stringify(heartbeat) } });
  await db.$transaction(tx => assertSharedStudioWorkerReady(tx));
  fixture.check(expectedChecks[10]);
  return fingerprint.evidence;
}

async function verifyBatchQuoteFingerprint(fixture: Awaited<ReturnType<typeof traceFixture>>, owner: string,
  body: Record<string, unknown> & { sources: Array<{ name: string; assetId: string }>; referenceIds: string[] },
  quote: { batchQuoteId?: string | null; imageChannel?: { channelId: string; configRevision: string } }) {
  const { batchQuoteFingerprint, consumeBatchQuote } = await import('../src/lib/image-studio/batch-billing-quote');
  const { db } = fixture;
  assert.equal('channelId' in body, false); assert.equal('imageChannel' in body, false);
  assert.ok(quote.batchQuoteId); assert.ok(quote.imageChannel);
  const channel = quote.imageChannel;
  const creationBody = Object.fromEntries(Object.entries({ ...body, batchQuoteId: quote.batchQuoteId,
    imageChannel: { configRevision: channel.configRevision, channelId: channel.channelId }, fingerprintVersion: 1 })
    .reverse().map(([key, value]) => [key, key === 'sources' ? body.sources.map(source => ({ assetId: source.assetId, name: source.name })) : value]));
  assert.equal('channelId' in creationBody, false, 'Do not hide the real quote/create channel insertion path');
  assert.equal(batchQuoteFingerprint(body, channel), batchQuoteFingerprint(creationBody, channel));
  assert.notEqual(batchQuoteFingerprint(body, channel, 1), batchQuoteFingerprint(creationBody, channel, 1));
  const key = `image_batch_billing_quote_v1:${owner}:${quote.batchQuoteId}`;
  const saved = await db.platformSetting.findUniqueOrThrow({ where: { key } });
  const stored = JSON.parse(saved.value_json) as Record<string, unknown>;
  assert.equal(stored.fingerprintVersion, 2); assert.equal(stored.ratioContractVersion, 3);
  assert.equal(stored.fingerprint, batchQuoteFingerprint(body, channel, 2));
  const tasksBefore = await db.imageStudioTask.count(), ledgerBefore = await db.creditLedger.count();
  const rejected: string[] = [];
  const reject = async (name: string, input: Record<string, unknown>, actor = owner, savedValue?: string) => {
    if (savedValue !== undefined) await db.platformSetting.update({ where: { id: saved.id }, data: { value_json: savedValue } });
    await assert.rejects(db.$transaction(tx => consumeBatchQuote(tx, actor, input)), name);
    assert.equal((await db.platformSetting.findUniqueOrThrow({ where: { id: saved.id } })).value_json, savedValue ?? saved.value_json,
      'A refused consumer must preserve its exact quote');
    assert.equal(await db.imageStudioTask.count(), tasksBefore); assert.equal(await db.creditLedger.count(), ledgerBefore);
    if (savedValue !== undefined) await db.platformSetting.update({ where: { id: saved.id }, data: { value_json: saved.value_json } });
    rejected.push(name);
  };
  await reject('source_array_order', { ...creationBody, sources: [...body.sources].reverse() });
  await reject('reference_array_order', { ...creationBody, referenceIds: [...body.referenceIds].reverse() });
  await reject('channel_identity', { ...creationBody, imageChannel: { ...channel, channelId: 'banana' } });
  await reject('channel_config_revision', { ...creationBody, imageChannel: { ...channel, configRevision: randomUUID() } });
  await reject('insufficient_budget', { ...creationBody, budget: 9 });
  await reject('other_owner', creationBody, 'trace-spec-other-owner');
  await reject('quality_intent', { ...creationBody, quality: 'high' });
  await reject('resolution_intent', { ...creationBody, resolution: '1K' });
  await reject('stored_owner', creationBody, owner, JSON.stringify({ ...stored, owner: 'trace-spec-other-owner' }));
  await reject('unknown_saved_fingerprint_version', creationBody, owner, JSON.stringify({ ...stored, fingerprintVersion: 99 }));
  const changedPlan = JSON.parse(saved.value_json) as { outputPlans: Array<Record<string, unknown>> };
  changedPlan.outputPlans[0].outputSize = '928x1232';
  await reject('changed_plan_without_matching_hash', creationBody, owner, JSON.stringify(changedPlan));
  const legacyRatio: Record<string, unknown> = { ...stored, ratioContractVersion: 2 }; delete legacyRatio.outputPlans; delete legacyRatio.outputPlanHashes;
  await reject('new_create_refuses_legacy_ratio_quote', creationBody, owner, JSON.stringify(legacyRatio));

  // A real persisted quote without a fingerprint version retains its exact v1 reader.
  const legacyId = randomUUID(), legacyKey = `image_batch_billing_quote_v1:${owner}:${legacyId}`;
  const legacyStored: Record<string, unknown> = { ...stored, fingerprint: batchQuoteFingerprint(body, channel, 1) }; delete legacyStored.fingerprintVersion;
  await db.platformSetting.create({ data: { key: legacyKey, value_json: JSON.stringify(legacyStored) } });
  await assert.rejects(db.$transaction(tx => consumeBatchQuote(tx, owner, { ...creationBody, batchQuoteId: legacyId })));
  assert.ok(await db.platformSetting.findUnique({ where: { key: legacyKey } }));
  const exactLegacyBody = { ...body, batchQuoteId: legacyId };
  const legacyConsumed = await db.$transaction(tx => consumeBatchQuote(tx, owner, exactLegacyBody));
  assert.equal(legacyConsumed.total, 10); assert.equal(await db.platformSetting.findUnique({ where: { key: legacyKey } }), null);
  assert.equal((await db.platformSetting.findUniqueOrThrow({ where: { id: saved.id } })).value_json, saved.value_json);
  return { creationBody, evidence: { fingerprintVersion: 2, equivalentObjectKeysAccepted: true, clientFingerprintVersionIgnored: true,
    quoteChannelOmitted: true, createOnlySameImageChannel: true, legacyMissingVersionReader: 1, rejected } };
}

main().catch(error => { console.error(error); process.exit(1); });
