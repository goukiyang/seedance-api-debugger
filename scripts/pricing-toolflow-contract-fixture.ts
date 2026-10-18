import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SessionUser } from '@/lib/auth/session';
import type { PricingAdminAction, PricingAdminPreviewInput } from '@/lib/pricing/admin-contract';
import type { ToolFlowGraph } from '@/lib/tools/toolflow';

export type PricingToolflowFixtureOptions = {
  databasePath: string;
  runtimeRoot: string;
  source: string;
};

/** The lead supplies an empty schema, a source-complete isolated runtime and its
 * real isolation marker. This module never runs on import or calls a provider. */
export async function runPricingToolflowContractFixture(options: PricingToolflowFixtureOptions) {
  const database = fs.realpathSync(options.databasePath);
  const runtimeRoot = fs.realpathSync(options.runtimeRoot);
  const temporary = fs.realpathSync(os.tmpdir());
  const allowed = (value: string) => value.startsWith(`${temporary}${path.sep}`)
    || value.includes(`${path.sep}.role-tests${path.sep}`);
  if (!path.isAbsolute(options.databasePath) || !path.isAbsolute(options.runtimeRoot)
    || !allowed(database) || !allowed(runtimeRoot)
    || !path.basename(database).includes('pricing-toolflow-fixture')
    || !['pricing-toolflow-fixture-runtime', 'pricing-legacy-fixture-runtime'].includes(path.basename(runtimeRoot))
    || process.env.DATABASE_URL !== `file:${database}` || !/^[a-f0-9]{40}$/.test(options.source)) {
    throw new Error('Explicit isolated pricing-toolflow-fixture DB/runtime/source and matching DATABASE_URL required');
  }
  const previousCwd = process.cwd();
  const previousSecret = process.env.SESSION_SECRET;
  const previousFetch = globalThis.fetch;
  let providerCalls = 0;
  process.chdir(runtimeRoot);
  process.env.SESSION_SECRET = 'pricing-toolflow-fixture-signature-not-a-production-secret';
  globalThis.fetch = async () => { providerCalls += 1; throw new Error('No network calls permitted by toolflow contract fixture'); };
  const evidence: string[] = [];
  let release: (() => Promise<void>) | undefined;
  try {
    const { prisma } = await import('@/lib/prisma');
    const databases = await prisma.$queryRawUnsafe<Array<{ name: string; file: string }>>('PRAGMA database_list');
    if (fs.realpathSync(databases.find(item => item.name === 'main')?.file || '') !== database) throw new Error('Loaded Prisma client is not bound to the isolated fixture DB');
    if (await prisma.user.count() || await prisma.platformSetting.count() || await prisma.toolFlowRun.count()
      || await prisma.imageStudioTask.count() || await prisma.creditLedger.count()) throw new Error('Fixture DB must be empty and schema-initialized by the lead');
    const { assertPricingWriterIsolation } = await import('@/lib/pricing/isolation');
    assertPricingWriterIsolation();
    const { capturePricingWorkerCapability, renewPricingWorkerCapability, revokePricingWorkerCapability } = await import('@/lib/pricing/runtime');
    const capability = capturePricingWorkerCapability(options.source);
    const renew = () => renewPricingWorkerCapability(prisma, capability);
    release = () => revokePricingWorkerCapability(prisma, capability);
    await renew();
    const runtime = await import('@/lib/tools/toolflow-runtime');
    const { claimStudioTask, finishStudioTask } = await import('@/lib/image-studio/tasks');
    const { creditCents } = await import('@/lib/credits/precision');
    const { getAdminPricingSnapshot, previewAdminPricing, saveAdminPricing } = await import('@/lib/pricing/policy');
    const { getImageStudioSettings, saveImageStudioSettingsInTx, IMAGE_STUDIO_SETTING_KEY, DEFAULT_STUDIO_PRICES } = await import('@/lib/image-studio/settings');
    const { IMAGE_GENERATION_API_SETTING_KEY, DEFAULT_IMAGE_GENERATION_API_SETTINGS } = await import('@/lib/integrations/image-generation');
    const model = 'gpt-image-2';
    const actor = await prisma.user.create({ data: { name: 'Toolflow pricing fixture', username: randomUUID(),
      email: `${randomUUID()}@fixture.invalid`, password_hash: 'not-a-login-credential', role: 'admin', account_type: 'internal', status: 'active',
      credit_account: { create: { balance: 100.15 } } } });
    const user = actor as SessionUser;
    const input = await prisma.asset.create({ data: { owner_id: user.id, type: 'image', status: 'active',
      original_url: 'https://fixture.invalid/input.png', mime_type: 'image/png', width: 64, height: 64 } });
    await prisma.platformSetting.create({ data: { key: IMAGE_STUDIO_SETTING_KEY, value_json: JSON.stringify({
      context: 'Accepted parent context', model, revision: 1, prices: { ...DEFAULT_STUDIO_PRICES, [model]: 20 },
    }) } });
    await prisma.platformSetting.create({ data: { key: IMAGE_GENERATION_API_SETTING_KEY, value_json: JSON.stringify({
      ...DEFAULT_IMAGE_GENERATION_API_SETTINGS, enabled: true, provider: 'musk',
      base_url: 'https://fixture.invalid', api_key: 'toolflow-fixture-not-a-provider-key', default_model: model,
    }) } });
    let policy = await getAdminPricingSnapshot(actor, prisma);
    const imageRow = policy.rows.find(row => row.identity.kind === 'image' && row.identity.channelId === 'shared'
      && row.identity.modelId === model && row.identity.billingMode === 'fixed');
    assert.ok(imageRow);
    const save = async (action: PricingAdminAction) => {
      await renew();
      const request: PricingAdminPreviewInput = { expectedRevision: policy.revision, catalogFingerprint: policy.catalogFingerprint, action };
      const preview = await previewAdminPricing(actor, request, prisma);
      const operation = await saveAdminPricing(actor, { ...request, operationId: randomUUID(), previewToken: preview.previewToken }, prisma);
      assert.equal(operation.state, 'succeeded'); assert.ok(operation.snapshot); policy = operation.snapshot!;
    };
    await save({ kind: 'save', changes: { standards: { site_base_cny: '1.0' }, rows: [{ id: imageRow.id, mode: 'follow',
      base: { currency: 'CNY', amount: '0.15', unit: 'image', source: { type: 'admin_defined', reference: 'isolated toolflow fixture', note: '' } } }] } });

    const graph = (count: number, delayed = false): ToolFlowGraph => ({ version: 1,
      nodes: [
        { id: 'input', type: 'flow-input', x: 0, y: 0, data: {} },
        { id: 'first', type: 'flow-template', x: 1, y: 0, data: { source: 'system', model, prompt: 'Original input', count, ratio: '1:1' } },
        ...(delayed ? [
          { id: 'confirm', type: 'flow-confirm', x: 2, y: 0, data: {} },
          { id: 'late', type: 'flow-template', x: 3, y: 0, data: { source: 'system', model, prompt: 'Original downstream', count, ratio: '1:1' } },
        ] : []),
        { id: 'output', type: 'flow-output', x: 4, y: 0, data: {} },
      ], connections: delayed ? [{ from: 'input', to: 'first' }, { from: 'first', to: 'confirm' },
        { from: 'confirm', to: 'late' }, { from: 'late', to: 'output' }] : [{ from: 'input', to: 'first' }, { from: 'first', to: 'output' }],
    });
    const makeFlow = (count: number, delayed = false, owner = user) => prisma.toolFlow.create({ data: {
      owner_id: owner.id, name: 'Toolflow contract fixture', graph_json: JSON.stringify(graph(count, delayed)), status: 'active',
    } });
    const submit = async (flowId: string, owner = user) => {
      await renew();
      const quote = await runtime.getToolFlowQuote(owner, flowId);
      return { quote, run: await runtime.createToolFlowRun(owner, flowId, [input.id], quote, runtime.createToolFlowQuoteProof(owner.id, quote)) };
    };
    const account = async (owner = user) => prisma.creditAccount.findUniqueOrThrow({ where: { user_id: owner.id } });
    const rawRun = (id: string) => prisma.toolFlowRun.findUniqueOrThrow({ where: { id }, include: { node_runs: true } });
    const tasks = (runId: string, nodeId?: string) => prisma.imageStudioTask.findMany({
      where: { tool_flow_run_id: runId, ...(nodeId ? { tool_flow_node_id: nodeId } : {}) }, orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    });
    const complete = async (expectedRun: string, outcome: 'succeeded' | 'failed') => {
      await renew();
      const claimed = await claimStudioTask();
      assert.ok(claimed); assert.equal(claimed.tool_flow_run_id, expectedRun);
      const output = outcome === 'succeeded' ? await prisma.asset.create({ data: { owner_id: claimed.owner_id,
        type: 'image', status: 'active', original_url: `https://fixture.invalid/${claimed.id}.png`, mime_type: 'image/png', width: 64, height: 64 } }) : null;
      // Synthetic delivery exercises the actual lease/CAS/settlement path, not a provider or media acceptance.
      assert.equal(await finishStudioTask(claimed, outcome, output ? { assetId: output.id } : { error: 'isolated fixture failure' }), true);
      assert.equal(await finishStudioTask(claimed, outcome, output ? { assetId: output.id } : {}), false, 'the real finish CAS settles at most once');
      await runtime.completeToolFlowTask(claimed.id);
      return output?.id;
    };

    const flow = await makeFlow(3, true);
    const accepted = await submit(flow.id);
    assert.equal(accepted.quote.estimatedCredits, 1.2); assert.equal(accepted.quote.steps[0].unitCredits, 0.2);
    const initial = await rawRun(accepted.run.id);
    assert.equal(initial.status, 'rate_running');
    assert.equal(initial.node_runs.find(node => node.node_id === 'late')?.status, 'rate_pending');
    const frozen = JSON.parse(initial.snapshot_json);
    assert.ok(frozen.node_contracts.first.billingContract.pricing.binding.configFingerprint);
    assert.equal(JSON.stringify(accepted.run).includes('configFingerprint'), false);
    assert.equal(JSON.stringify(await runtime.listToolFlowRuns(user)).includes('configFingerprint'), false);
    const initialTasks = await tasks(initial.id, 'first');
    assert.equal(initialTasks.length, 3);
    assert.ok(initialTasks.every(task => task.status === 'rate_queued' && task.billing_status === 'rate_awaiting_response' && task.unit_credits === 0.2));
    const duplicate = await runtime.createToolFlowRun(user, flow.id, [input.id], accepted.quote, runtime.createToolFlowQuoteProof(user.id, accepted.quote));
    assert.equal(duplicate.id, initial.id); assert.equal((await tasks(initial.id)).length, 3);
    await assert.rejects(() => runtime.createToolFlowRun(user, flow.id, [input.id], { ...accepted.quote, estimatedCredits: 0 }, runtime.createToolFlowQuoteProof(user.id, accepted.quote)));
    evidence.push('G11: actual quote/create use the shared policy, sum three separately rounded 0.2-point images to 0.6, freeze private states and exclude binding from run/list DTOs; duplicate acceptance creates no extra children');

    const stale = await runtime.getToolFlowQuote(user, flow.id);
    await save({ kind: 'save', changes: { rows: [{ id: imageRow.id, mode: 'custom', customPointsPerCny: '2.0' }] } });
    await assert.rejects(() => runtime.createToolFlowRun(user, flow.id, [input.id], stale, runtime.createToolFlowQuoteProof(user.id, stale)));
    assert.equal((await runtime.getToolFlowQuote(user, flow.id)).steps[0].unitCredits, 0.3);
    const settings = await getImageStudioSettings();
    await prisma.$transaction(tx => saveImageStudioSettingsInTx(tx, { ...settings, context: 'New context must not replace accepted context' }, user.id));
    const selected: string[] = [];
    for (let index = 0; index < 3; index += 1) selected.push((await complete(initial.id, 'succeeded'))!);
    await runtime.advanceToolFlowRun(initial.id);
    assert.equal((await runtime.getToolFlowRun(user, initial.id)).status, 'waiting_confirmation');
    await runtime.updateToolFlowRun(user, initial.id, { action: 'decision', node_id: 'confirm', selected_asset_ids: selected, confirmed: true });
    const late = await tasks(initial.id, 'late');
    assert.equal(late.length, 3);
    for (const task of late) {
      const snapshot = JSON.parse(task.snapshot_json!);
      assert.equal(task.unit_credits, 0.2); assert.equal(task.context, 'Accepted parent context');
      assert.equal(snapshot.billingContract.pricing.revision, frozen.node_contracts.late.billingContract.pricing.revision);
      assert.deepEqual(snapshot.imageChannel, frozen.node_contracts.late.imageChannel);
    }
    await runtime.updateToolFlowRun(user, initial.id, { action: 'cancel' });
    assert.ok((await tasks(initial.id, 'late')).every(task => task.status === 'cancelled'));
    assert.equal(creditCents((await account()).balance), 9955); assert.equal(creditCents((await account()).frozen_credits), 0);
    const finalParent = await rawRun(initial.id);
    assert.equal(creditCents(finalParent.actual_credits!), 60); assert.equal(creditCents(finalParent.frozen_credits!), 0);
    assert.deepEqual(JSON.parse(finalParent.snapshot_json).node_contracts, frozen.node_contracts);
    evidence.push('G17/G21: a real accepted parent keeps price, prompt/context, API-version handle and quantity after policy/settings changes; late children use the old revision and cancellation refunds only their original 0.6-point reservation');

    const retryFlow = await makeFlow(3);
    const retryRun = (await submit(retryFlow.id)).run;
    for (let index = 0; index < 3; index += 1) await complete(retryRun.id, 'failed');
    await save({ kind: 'save', changes: { rows: [{ id: imageRow.id, mode: 'custom', customPointsPerCny: '0.7' }] } });
    await assert.rejects(() => runtime.updateToolFlowRun(user, retryRun.id, { action: 'retry', node_id: 'first' }));
    for (let round = 0; round < 8; round += 1) {
      await renew();
      const quote = await runtime.getToolFlowQuote(user, retryFlow.id, { runId: retryRun.id, nodeId: 'first' });
      assert.equal(quote.estimatedCredits, 0.3); assert.equal(quote.steps[0].unitCredits, 0.1);
      const proof = runtime.createToolFlowQuoteProof(user.id, quote);
      await runtime.updateToolFlowRun(user, retryRun.id, { action: 'retry', node_id: 'first', quote }, proof);
      const count = (await tasks(retryRun.id)).length;
      await runtime.updateToolFlowRun(user, retryRun.id, { action: 'retry', node_id: 'first', quote }, proof);
      assert.equal((await tasks(retryRun.id)).length, count);
      for (let index = 0; index < 3; index += 1) await complete(retryRun.id, 'failed');
      assert.equal(creditCents((await account()).balance), 9955);
      assert.equal(creditCents((await account()).frozen_credits), 0);
    }
    const retryPublic = await runtime.getToolFlowRun(user, retryRun.id);
    const retrySnapshot = JSON.parse(retryPublic.snapshot_json);
    assert.equal(retrySnapshot.billing_quote.estimatedCredits, 0.9);
    assert.equal(retrySnapshot.retry_receipts.first.length, 8);
    assert.equal(JSON.stringify(retryPublic).includes('binding'), false);
    assert.equal(creditCents((await rawRun(retryRun.id)).estimated_credits!), 330);
    evidence.push('G17/G21: explicit retry separately quotes/accepts current prices, preserves the original parent contract, exposes separate amounts and deduplicates the same retry; eight real three-child freeze/refund cycles conserve cents and parent estimates');
    const successfulRetryQuote = await runtime.getToolFlowQuote(user, retryFlow.id, { runId: retryRun.id, nodeId: 'first' });
    await runtime.updateToolFlowRun(user, retryRun.id, { action: 'retry', node_id: 'first', quote: successfulRetryQuote }, runtime.createToolFlowQuoteProof(user.id, successfulRetryQuote));
    for (let index = 0; index < 3; index += 1) await complete(retryRun.id, 'succeeded');
    assert.equal((await runtime.getToolFlowRun(user, retryRun.id)).status, 'succeeded');
    assert.equal(JSON.parse((await rawRun(retryRun.id)).node_runs.find(node => node.node_id === 'output')!.output_asset_ids).length, 3);
    assert.equal(creditCents((await account()).balance), 9925);
    evidence.push('G17: a successful explicit retry reopens only never-dispatched empty downstream nodes and reaches the real final-output path without rerunning accepted descendants');

    const capacityFlow = await makeFlow(8);
    const blocking = (await submit(capacityFlow.id)).run;
    const waitingFlow = await makeFlow(1);
    const waiting = (await submit(waitingFlow.id)).run;
    assert.equal((await tasks(waiting.id)).length, 0);
    assert.equal((await rawRun(waiting.id)).node_runs.find(node => node.node_id === 'first')?.status, 'rate_pending');
    await runtime.dispatchWaitingToolFlowRuns();
    assert.equal((await tasks(waiting.id)).length, 0);
    await runtime.updateToolFlowRun(user, blocking.id, { action: 'cancel' });
    await runtime.dispatchWaitingToolFlowRuns();
    assert.equal((await tasks(waiting.id)).length, 1);
    await runtime.updateToolFlowRun(user, waiting.id, { action: 'cancel' });
    assert.equal(creditCents((await account()).balance), 9925);
    evidence.push('G11/G17/G21: actual capacity admission counts all eight private queued tasks, freezes no waiting child and the original bounded dispatcher admits it after cancellation without changing the accepted price');

    const unknownFlow = await makeFlow(1);
    const unknown = (await submit(unknownFlow.id)).run;
    const unknownTask = (await tasks(unknown.id))[0];
    // Seed a durable provider-unknown observation, then exercise only the real retry guard.
    await prisma.imageStudioTask.update({ where: { id: unknownTask.id }, data: { status: 'rate_uncertain' } });
    await prisma.toolFlowNodeRun.update({ where: { run_id_node_id: { run_id: unknown.id, node_id: 'first' } }, data: { status: 'failed' } });
    const beforeUnknown = await account();
    await assert.rejects(() => runtime.getToolFlowQuote(user, unknownFlow.id, { runId: unknown.id, nodeId: 'first' }));
    assert.equal((await tasks(unknown.id)).length, 1);
    assert.equal(creditCents((await account()).frozen_credits), creditCents(beforeUnknown.frozen_credits));
    await runtime.updateToolFlowRun(user, unknown.id, { action: 'cancel' });
    assert.equal((await tasks(unknown.id))[0].status, 'rate_uncertain');
    assert.equal(creditCents((await account()).frozen_credits), creditCents(beforeUnknown.frozen_credits));
    evidence.push('G17: a seeded durable unknown is rejected by the actual retry-quote path and cancellation neither resubmits it nor releases its original reservation');

    const legacyFlow = await makeFlow(1);
    const legacyGraph = graph(1);
    const legacy = await prisma.toolFlowRun.create({ data: { flow_id: legacyFlow.id, owner_id: user.id, flow_version: 1,
      snapshot_json: JSON.stringify({ schema: 'toolflow.v1', flow_id: legacyFlow.id, flow_owner_id: user.id, version: 1,
        graph: legacyGraph, input_asset_ids: [input.id] }),
      node_runs: { create: legacyGraph.nodes.map(node => ({ node_id: node.id,
        status: node.type === 'flow-input' ? 'succeeded' : 'pending', output_asset_ids: node.type === 'flow-input' ? JSON.stringify([input.id]) : '[]' })) },
    } });
    await runtime.advanceToolFlowRun(legacy.id);
    assert.equal((await rawRun(legacy.id)).status, 'paused'); assert.equal((await tasks(legacy.id)).length, 0);
    evidence.push('G17: an old parent missing its accepted node contract is preserved and paused, never upgraded by inventing a current-price child');

    const smallActor = await prisma.user.create({ data: { name: 'Cent balance fixture', username: randomUUID(),
      email: `${randomUUID()}@fixture.invalid`, password_hash: 'not-a-login-credential', role: 'admin', account_type: 'internal', status: 'active',
      credit_account: { create: { balance: 0.15 } } } });
    const smallUser = smallActor as SessionUser;
    const smallInput = await prisma.asset.create({ data: { owner_id: smallUser.id, type: 'image', status: 'active', original_url: 'https://fixture.invalid/small.png' } });
    const smallFlow = await makeFlow(1, false, smallUser);
    const smallQuote = await runtime.getToolFlowQuote(smallUser, smallFlow.id);
    const smallRun = await runtime.createToolFlowRun(smallUser, smallFlow.id, [smallInput.id], smallQuote, runtime.createToolFlowQuoteProof(smallUser.id, smallQuote));
    await complete(smallRun.id, 'succeeded');
    assert.equal(creditCents((await account(smallUser)).balance), 5);
    assert.equal(creditCents((await account(smallUser)).frozen_credits), 0);
    assert.equal(creditCents((await rawRun(smallRun.id)).actual_credits!), 10);
    const settledIds = (await prisma.creditLedger.findMany({ where: { type: { in: ['task_success_deduct', 'task_failed_refund'] } }, select: { related_task_id: true } })).map(row => row.related_task_id);
    assert.equal(new Set(settledIds).size, settledIds.length);
    assert.equal(providerCalls, 0);
    evidence.push('G21: actual allocation/finish/ledger preserve 0.05 from an old 0.15 balance after a new 0.1 charge, with no double settlement; no provider or browser was called');
    return { fixture: 'pricing-toolflow-contract', groups: ['G11', 'G17', 'G21'], evidence,
      databasePath: database, runtimeRoot, providerCalls,
      exclusions: ['No real provider generation, media delivery or browser acceptance', 'Synthetic terminal deliveries only; lead owns integration/build verification'] };
  } finally {
    try { await release?.(); } finally {
      globalThis.fetch = previousFetch;
      if (previousSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = previousSecret;
      process.chdir(previousCwd);
    }
  }
}
