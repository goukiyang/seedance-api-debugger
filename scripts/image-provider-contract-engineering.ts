import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import https, { type RequestOptions } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { mock } from 'node:test';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import sharp from 'sharp';
import { traceFixture, sha256 } from './image-trace-engineering-fixture';
import type { StudioAsyncAccepted } from '../src/lib/image-studio/provider';

const sourcePaths = ['scripts/image-trace-engineering-fixture.ts', 'scripts/process-image-studio.ts', 'src/lib/image-studio/provider.ts',
  'src/lib/image-studio/provider-wait.ts', 'src/lib/image-studio/delivery.ts', 'src/lib/image-studio/async-recovery.ts',
  'src/lib/image-studio/worker.ts', 'src/lib/image-studio/worker-mode.ts', 'src/lib/image-studio/tasks.ts', 'src/lib/image-studio/response-diagnostics.ts',
  'src/lib/image-studio/response-evidence.ts', 'src/lib/image-generation/output-plan.ts',
  'src/lib/image-studio/dimension-rejection.ts', 'src/lib/image-studio/dimension-mismatch.ts', 'src/lib/image-studio/output.ts'];
const expectedChecks = [
  'gzip_deflate_brotli_decode_preserves_body_and_removes_stale_headers',
  'bad_stream_wire_decoded_limits_length_abort_and_timeout_reject',
  'retry_after_seconds_date_body_and_invalid_values_use_receive_clock',
  'long_202_wait_survives_observation_failure_without_early_get',
  'non_json_429_503_persist_header_wait_and_original_get_only',
  'core_partial_request_async_and_database_writes_repair_both_copies_after_restart',
  'core_owner_original_id_and_billing_identity_conflicts_fail_closed',
  'durable_wait_survives_restart_manual_check_and_local_backoff',
  'wait_beyond_auto_deadline_stops_without_spending_attempts_or_money',
  'old_v1_receipt_stays_readable_and_optional_diagnostics_are_private',
  'guard_accepted_only_requires_shared_drain_and_never_dispatches_new_work_or_global_billing',
  'active_wait_manual_original_check_requires_time_owner_lease_cas_and_single_consumption',
  'original_v3_202_restart_uses_same_get_identity_and_settles_once_without_repost',
  'original_v3_unknown_keeps_reservation_but_fresh_and_late_complete_mismatch_refund_once_and_keep_image',
];

async function main() {
  const fixture = await traceFixture({ file: 'scripts/image-provider-contract-engineering.ts',
    schema: 'image-provider-contract-engineering.v1', marker: 'Image provider contract engineering receipt: ',
    sources: sourcePaths, checks: expectedChecks });
  const provider = await import('../src/lib/image-studio/provider');
  const delivery = await import('../src/lib/image-studio/delivery');
  const recovery = await import('../src/lib/image-studio/async-recovery');
  let clock = Date.now(); mock.method(Date, 'now', () => clock);
  const signal = () => AbortSignal.timeout(5000);
  const plain = Buffer.from(JSON.stringify({ task_id: 'provider-synthetic', status: 'pending', text: 'x'.repeat(4096) }));
  const encoded = (bytes: Buffer, encoding: string, length = true) => new Response(Uint8Array.from(bytes).buffer, { status: 200,
    headers: { 'content-type': 'application/json', 'content-encoding': encoding, ...(length ? { 'content-length': String(bytes.length) } : {}) } });
  for (const [encoding, encode] of [['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync]] as const) {
    const response = provider.decodeStudioProviderResponse(encoded(encode(plain), encoding), signal());
    assert.equal(response.headers.has('content-encoding'), false); assert.equal(response.headers.has('content-length'), false);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), plain);
  }
  fixture.check(expectedChecks[0]);
  const compressed = gzipSync(plain);
  await assert.rejects(async () => provider.decodeStudioProviderResponse(encoded(Buffer.from('broken'), 'gzip'), signal()).arrayBuffer());
  await assert.rejects(async () => provider.decodeStudioProviderResponse(encoded(compressed, 'gzip', false), signal(), { compressedBytes: compressed.length - 1 }).arrayBuffer());
  await assert.rejects(async () => provider.decodeStudioProviderResponse(encoded(compressed, 'gzip'), signal(), { decodedBytes: plain.length - 1 }).arrayBuffer());
  assert.throws(() => provider.decodeStudioProviderResponse(encoded(compressed, 'gzip'), signal(), { compressedBytes: compressed.length - 1 }));
  await assert.rejects(async () => provider.decodeStudioProviderResponse(new Response(Uint8Array.from(compressed).buffer, { headers: {
    'content-encoding': 'gzip', 'content-length': String(compressed.length + 1) } }), signal()).arrayBuffer());
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(async () => provider.decodeStudioProviderResponse(encoded(compressed, 'gzip'), aborted.signal).arrayBuffer());
  await assert.rejects(async () => provider.decodeStudioProviderResponse(new Response(new ReadableStream({ start() {} }), {
    headers: { 'content-encoding': 'gzip' } }), signal(), { timeoutMs: 5 }).arrayBuffer());
  const cancellationEvidence: Array<{ mode: string; sourceCancelCount: number }> = [];
  for (const mode of ['mid-abort', 'body-cancel']) {
    let sourceCancelCount = 0, started = false, sawPull!: () => void;
    const pulled = new Promise<void>(resolve => { sawPull = resolve; });
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (started) return;
        started = true;
        controller.enqueue(Uint8Array.from(compressed.subarray(0, 10))); sawPull();
        // No end-of-stream: abort/cancel must reach this actual original source.
      },
      cancel() { sourceCancelCount++; },
    });
    const abort = new AbortController();
    const decoded = provider.decodeStudioProviderResponse(new Response(source, { headers: { 'content-encoding': 'gzip' } }), abort.signal);
    const reader = decoded.body!.getReader();
    if (mode === 'mid-abort') {
      const reading = reader.read();
      await pulled; abort.abort();
      await assert.rejects(reading);
    } else {
      await pulled; await reader.cancel('synthetic consumer cancellation');
    }
    reader.releaseLock();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(sourceCancelCount, 1, 'The real original response stream must be cancelled exactly once');
    cancellationEvidence.push({ mode, sourceCancelCount });
    const afterCancel = provider.decodeStudioProviderResponse(encoded(compressed, 'gzip'), signal());
    assert.deepEqual(Buffer.from(await afterCancel.arrayBuffer()), plain, 'A subsequent decode still completes normally');
  }
  fixture.check(expectedChecks[1]);
  const parseWait = provider.parseStudioProviderWait;
  const wait120 = parseWait(new Headers({ 'retry-after': '120' }), { poll_after_ms: 30000 }, clock);
  assert.equal(wait120.providerNotBefore, clock + 120000);
  const date = new Date(Math.floor(clock / 1000) * 1000 + 180000).toUTCString();
  assert.equal(parseWait(new Headers({ 'retry-after': date }), null, clock).providerNotBefore, Date.parse(date));
  assert.equal(parseWait(new Headers({ 'retry-after': '10' }), { poll_after_ms: 240000 }, clock).providerNotBefore, clock + 240000);
  for (const invalid of ['nonsense', '999999999999999999999999', 'Fri, 01 Jan 9999 00:00:00 GMT']) {
    assert.ok(Number(parseWait(new Headers({ 'retry-after': invalid }), null, clock).providerNotBefore) >= clock + 86400000);
  }
  fixture.check(expectedChecks[2]);
  const model = 'gpt-image-2.5-sunburst';
  const { resolveImageOutputPlan } = await import('../src/lib/image-generation/output-plan');
  const outputPlan = resolveImageOutputPlan({ model, resolution: '2K', ratio: '1:1' });
  const params = { baseUrl: 'https://provider-fixture.invalid', apiKey: 'synthetic-not-a-credential', model,
    protocol: 'openai_images' as const, prompt: 'Synthetic', count: 1, images: [], signal: signal(), ratio: '1:1', size: outputPlan.outputSize,
    ratioContractVersion: 3 as const, outputPlan, now: () => clock, wait: async (ms: number) => { clock += ms; } };
  const calls: Array<{ method: string; path: string }> = [];
  let accepted: StudioAsyncAccepted | undefined;
  const post202: typeof fetch = async (url, init) => {
    calls.push({ method: String(init?.method), path: String(url) }); assert.equal(init?.method, 'POST');
    return new Response(Uint8Array.from(gzipSync(Buffer.from(JSON.stringify({ task_id: 'provider-synthetic', poll_after_ms: 2000 })))).buffer, { status: 202,
      headers: { 'content-encoding': 'gzip', 'retry-after': '120', 'x-request-id': 'upstream-synthetic' } });
  };
  await assert.rejects(provider.requestStudioImages({ ...params, recordResponse: async () => { throw new Error('synthetic-observation-write'); },
    onAsyncAccepted: async value => { accepted = value; } }, post202), (error: unknown) => error instanceof provider.StudioProviderError && error.code === 'async_provider_wait');
  assert.equal(accepted?.taskId, 'provider-synthetic'); assert.equal(accepted?.providerNotBefore, clock + 120000);
  assert.equal(calls.length, 1);
  fixture.check(expectedChecks[3]);
  for (const status of [429, 503]) {
    const progress: import('../src/lib/image-studio/provider').StudioAsyncAccepted[] = [];
    const getOnly: typeof fetch = async (url, init) => { calls.push({ method: String(init?.method), path: String(url) });
      assert.equal(init?.method, 'GET'); assert.match(String(url), /\/provider-synthetic\?view=summary$/);
      return new Response('<html>not JSON</html>', { status, headers: { 'retry-after': '120' } }); };
    await assert.rejects(provider.requestStudioImages({ ...params, resumeAsync: { taskId: 'provider-synthetic' }, asyncQueryMode: 'single',
      onAsyncProgress: async value => { progress.push(value); } }, getOnly));
    assert.equal(progress[0]?.providerNotBefore, clock + 120000);
  }
  fixture.check(expectedChecks[4]);

  const { db } = fixture, owner = 'trace-provider-owner', channelId = `image-${randomUUID()}`, configRevision = randomUUID();
  await db.user.create({ data: { id: owner, name: 'Synthetic', username: owner, email: `${owner}@fixture.invalid`,
    password_hash: 'not-a-login', role: 'admin', account_type: 'internal' } });
  await db.creditAccount.create({ data: { user_id: owner, balance: 100, frozen_credits: 0 } });
  const make = async (id: string, version = 3) => {
    const task = await db.imageStudioTask.create({ data: { id, owner_id: owner, batch_id: id, ordinal: 0, fingerprint: `frozen-${id}`,
      model, prompt: 'Original synthetic', context: 'Original context', revision: 0, reference_ids: '[]', output_size: outputPlan.outputSize,
      unit_credits: 5, billing_mode: 'fixed', billing_scope: 'synthetic-scope', billing_status: 'channel_unmatched', status: 'channel_running',
      freeze_snapshot: '[]', lease_token: `lease-${id}`, lease_until: new Date(clock + 600000),
      snapshot_json: JSON.stringify({ requestId: `request-${id}`, ratioContractVersion: version, outputPlan,
        imageChannel: { channelId, configRevision } }) } });
    await delivery.beginStudioRequest(task); await delivery.setStudioUnsentRequestState(task, 'attempted'); return task;
  };
  const response = () => new Response(null, { status: 202, headers: { 'x-oneapi-request-id': 'gateway-synthetic', 'x-request-id': 'upstream-synthetic' } });
  const storage = (id: string, billing: boolean, name: string) => path.join(fixture.directory, 'storage', billing ? 'studio-billing' : 'studio-delivery', id, name);
  const faults = ['pending-request', 'pending-billing', 'request', 'request-billing', 'async', 'async-billing', 'database'] as const;
  for (const stage of faults) {
    const task = await make(`partial-${stage}`);
    await assert.rejects(delivery.recordStudioAsyncAcceptance(task, response(), { taskId: `provider-${stage}`, ...wait120 },
      { fault: at => { if (at === stage) throw new Error(`synthetic-${stage}`); } }));
    assert.ok(await delivery.readStudioCorePending(task));
    await delivery.repairStudioCoreReceipt(await db.imageStudioTask.findUniqueOrThrow({ where: { id: task.id } }));
    assert.equal(await delivery.readStudioCorePending(task), null);
    for (const billing of [false, true]) {
      const request = JSON.parse(await fs.readFile(storage(task.id, billing, 'request.json'), 'utf8'));
      const async = JSON.parse(await fs.readFile(storage(task.id, billing, 'async.json'), 'utf8'));
      assert.equal(request.gatewayRequestId, 'gateway-synthetic'); assert.equal(async.providerTaskId, `provider-${stage}`);
      assert.equal(async.providerNotBefore, wait120.providerNotBefore); assert.ok(async.pollAfterMs <= 30000);
    }
    assert.equal((await db.imageStudioTask.findUniqueOrThrow({ where: { id: task.id } })).gateway_request_id, 'gateway-synthetic');
  }
  fixture.check(expectedChecks[5]);
  const conflict = await make('identity-conflict');
  await assert.rejects(delivery.recordStudioAsyncAcceptance(conflict, response(), { taskId: 'provider-conflict' },
    { fault: stage => { if (stage === 'database') throw new Error('synthetic-database'); } }));
  await assert.rejects(delivery.repairStudioCoreReceipt({ ...conflict, owner_id: 'different-owner' }));
  const wrongAsync = JSON.parse(await fs.readFile(storage(conflict.id, true, 'async.json'), 'utf8'));
  await fs.writeFile(storage(conflict.id, true, 'async.json'), JSON.stringify({ ...wrongAsync, providerTaskId: 'different-original' }), { mode: 0o600 });
  await assert.rejects(delivery.repairStudioCoreReceipt(conflict), delivery.StudioCoreReceiptError);
  fixture.check(expectedChecks[6]);

  const task = await make('long-wait'), notBefore = clock + 3600000;
  const receipt = await delivery.recordStudioAsyncAcceptance(task, response(), { taskId: 'provider-long-wait', providerNotBefore: notBefore,
    providerWaitSource: 'retry-after-seconds' });
  assert.ok(receipt); assert.equal(await recovery.releaseStudioAsyncSlot(task, receipt, 'provider_unconfirmed', 'uncertain'), true);
  const recoveryKey = `studio_async_recovery_v1:${task.id}`;
  const readRecovery = async () => JSON.parse((await db.platformSetting.findUniqueOrThrow({ where: { key: recoveryKey } })).value_json);
  clock += 600000;
  const manual = await recovery.requestStudioAsyncRecheck(owner, task.id, `request-${task.id}`);
  assert.equal(manual.scheduled, false);
  for (let n = 0; n < 3; n++) assert.equal(await recovery.claimStudioAsyncRecovery(), null);
  assert.equal((await readRecovery()).attempts, 0);
  assert.equal((await delivery.readStudioAsyncReceipt(await db.imageStudioTask.findUniqueOrThrow({ where: { id: task.id } })))?.providerNotBefore, notBefore);
  const frozenWait = await delivery.readStudioAsyncReceipt(task); assert.ok(frozenWait);
  await delivery.updateStudioAsyncReceipt(frozenWait, { providerNotBefore: clock + 30000, providerWaitSource: 'body' });
  assert.equal((await delivery.readStudioAsyncReceipt(task))?.providerNotBefore, notBefore);
  // Negative: a v1 sidecar cannot silently accept a new-contract long wait.
  const primary = storage(task.id, false, 'async.json');
  const valid = await fs.readFile(primary, 'utf8');
  await fs.writeFile(primary, JSON.stringify({ ...JSON.parse(valid), schema: 'image.async-receipt.v1' }), { mode: 0o600 });
  await assert.rejects(delivery.readStudioAsyncReceipt(task)); await fs.writeFile(primary, valid, { mode: 0o600 });
  fixture.check(expectedChecks[7]);
  const beyond = await make('beyond-budget');
  const beyondReceipt = await delivery.recordStudioAsyncAcceptance(beyond, response(), { taskId: 'provider-beyond-budget',
    providerNotBefore: clock + 2 * 86400000, providerWaitSource: 'retry-after-seconds' });
  assert.ok(beyondReceipt); assert.equal(await recovery.releaseStudioAsyncSlot(beyond, beyondReceipt, 'provider_unconfirmed', 'uncertain'), true);
  clock += 86400001;
  for (let n = 0; n < 3; n++) await recovery.claimStudioAsyncRecovery();
  const budget = JSON.parse((await db.platformSetting.findUniqueOrThrow({ where: { key: `studio_async_recovery_v1:${beyond.id}` } })).value_json);
  assert.equal(budget.state, 'stopped'); assert.equal(budget.attempts, 0);
  assert.equal(await db.creditLedger.count(), 0); assert.equal(await db.asset.count(), 0);
  fixture.check(expectedChecks[8]);
  const old = await make('old-v1', 2), oldReceipt = await delivery.createStudioAsyncReceipt(old, { taskId: 'provider-old', pollAfterMs: 120000 });
  assert.equal(oldReceipt.schema, 'image.async-receipt.v1'); assert.equal(oldReceipt.pollAfterMs, 30000);
  assert.equal((await delivery.readStudioAsyncReceipt(old))?.providerTaskId, 'provider-old');
  const { buildStudioResponseDiagnostics } = await import('../src/lib/image-studio/response-diagnostics');
  const secret = 'PRIVATE_SENTINEL_SIGNED_URL_PROMPT_TOKEN';
  const diagnostic = buildStudioResponseDiagnostics({ error: { code: 429, message: secret, safe_error: secret }, prompt: secret, url: `https://secret.invalid/${secret}` },
    { httpStatus: 429, contentType: 'application/json', responseBytes: 10, responseSha256: 'a'.repeat(64), bodyComplete: true, parseOutcome: 'valid_json' });
  assert.equal(JSON.stringify(diagnostic).includes(secret), false); assert.ok(Buffer.byteLength(JSON.stringify(diagnostic)) <= 32768);
  const optionalFailure = await provider.requestStudioImages({ ...params, signal: signal(),
    recordResponseDiagnostics: async () => { throw new Error('synthetic-optional-diagnostic-failure'); } },
    async () => new Response(JSON.stringify({ data: [{ b64_json: 'AAAA' }] }), { headers: { 'content-type': 'application/json' } }));
  assert.deepEqual(optionalFailure.images, ['AAAA']);
  fixture.check(expectedChecks[9]);
  const modes = await import('../src/lib/image-studio/worker-mode');
  const billingModes = [
    { acceptedOnly: false, initialHold: false, expected: true },
    { acceptedOnly: false, initialHold: true, expected: false },
    { acceptedOnly: true, initialHold: false, expected: false },
    { acceptedOnly: true, initialHold: true, expected: false },
  ].map(input => {
    const enabled = modes.studioWorkerBillingEnabled(input);
    assert.equal(enabled, input.expected, 'Only ordinary main mode may start global billing work');
    return { ...input, enabled };
  });
  assert.throws(() => modes.assertStudioWorkerMode({ version: '0.95.4+trace03-guard.1', acceptedOnlyEnv: '0', draining: true }));
  assert.throws(() => modes.assertStudioWorkerMode({ version: '0.95.4+trace03-guard.1', acceptedOnlyEnv: '1', draining: false }));
  const mode = modes.assertStudioWorkerMode({ version: '0.95.4+trace03-guard.1', acceptedOnlyEnv: '1', draining: true });
  const cycles: string[] = [];
  await modes.runStudioWorkerCycle({ ...mode, draining: () => true, stopping: () => false,
    recover: async options => { assert.equal(options.acceptedOnly, true); cycles.push('accepted-recovery'); },
    dispatchBatches: async () => { cycles.push('new-batch'); }, dispatchToolflows: async () => { cycles.push('new-toolflow'); },
    processQueued: async () => { cycles.push('new-queued'); } });
  assert.deepEqual(cycles, ['accepted-recovery']);
  const initialHold = modes.assertStudioWorkerMode({ version: '0.95.5', acceptedOnlyEnv: '0', releaseHoldEnv: '1', draining: true });
  assert.equal(initialHold.initialHold, true);
  const { STUDIO_SHARED_WORKER_KEY, STUDIO_SHARED_WORKER_FILES } = await import('../src/lib/image-studio/tasks');
  const loadedModuleSha = Object.fromEntries(STUDIO_SHARED_WORKER_FILES.map(file => [file, sha256(readFileSync(path.join(fixture.root, file)))]));
  assert.equal(await modes.publishStudioWorkerReadiness({ acceptedOnly: initialHold.acceptedOnly, workerId: 'synthetic-startup-hold',
    source: 'a'.repeat(40), loadedModuleSha, now: clock }, db), true);
  const heartbeatRow = await db.platformSetting.findUniqueOrThrow({ where: { key: STUDIO_SHARED_WORKER_KEY } });
  const visibleHeartbeat = JSON.parse(heartbeatRow.value_json);
  assert.equal(visibleHeartbeat.source, 'a'.repeat(40)); assert.deepEqual(visibleHeartbeat.loadedModuleSha, loadedModuleSha);
  assert.equal(Date.parse(visibleHeartbeat.expiresAt), clock + 90000);
  assert.equal(await modes.publishStudioWorkerReadiness({ acceptedOnly: true, workerId: 'guard-does-not-admit',
    source: 'b'.repeat(40), loadedModuleSha, now: clock }, db), false);
  assert.equal((await db.platformSetting.findUniqueOrThrow({ where: { key: STUDIO_SHARED_WORKER_KEY } })).value_json, heartbeatRow.value_json);
  const heldCalls: string[] = [];
  assert.equal(await modes.runStudioWorkerCycle({ ...initialHold, draining: () => true, stopping: () => false,
    recover: async () => { heldCalls.push('recover'); }, dispatchBatches: async () => { heldCalls.push('batch'); },
    dispatchToolflows: async () => { heldCalls.push('toolflow'); }, processQueued: async () => { heldCalls.push('new-work'); } }), true);
  assert.deepEqual(heldCalls, []);
  const queued = await make('guard-queued');
  assert.equal(await delivery.hasStudioAcceptedRecoveryIdentity(queued), false);
  const nativeWithoutIdentity = await make('guard-native-no-id', 2);
  await delivery.recordStudioResponse(nativeWithoutIdentity, response());
  const nativeTask = await db.imageStudioTask.update({ where: { id: nativeWithoutIdentity.id },
    data: { model: 'gemini-3-pro-image-preview', output_size: '2K' } });
  assert.equal(await delivery.hasStudioAcceptedRecoveryIdentity(nativeTask), false);
  fixture.check(expectedChecks[10]);
  const active = await make('active-original-check');
  const manualNotBefore = clock + 86400000 + 120000;
  await delivery.recordStudioAsyncAcceptance(active, response(), { taskId: 'provider-active-original',
    providerNotBefore: manualNotBefore, providerWaitSource: 'retry-after-seconds' });
  await db.imageStudioTask.update({ where: { id: active.id }, data: { lease_token: null, lease_until: new Date(manualNotBefore) } });
  clock += 86400001;
  assert.equal((await recovery.requestStudioAsyncRecheck(owner, active.id, `request-${active.id}`)).scheduled, false);
  assert.equal((await recovery.readStudioActiveProviderCheck(await db.imageStudioTask.findUniqueOrThrow({ where: { id: active.id } })))?.state, 'waiting');
  await assert.rejects(recovery.requestStudioAsyncRecheck('different-owner', active.id, `request-${active.id}`));
  clock = manualNotBefore + 1;
  await assert.rejects(recovery.requestStudioAsyncRecheck(owner, active.id, 'wrong-original-key'));
  await db.imageStudioTask.update({ where: { id: active.id }, data: { lease_token: 'busy-lease', lease_until: new Date(clock + 60000) } });
  assert.equal((await recovery.requestStudioAsyncRecheck(owner, active.id, `request-${active.id}`)).scheduled, false);
  await db.imageStudioTask.update({ where: { id: active.id }, data: { lease_token: null } });
  assert.equal((await recovery.requestStudioAsyncRecheck(owner, active.id, `request-${active.id}`)).scheduled, true);
  const unclaimed = await db.imageStudioTask.findUniqueOrThrow({ where: { id: active.id } });
  assert.equal(await recovery.readStudioActiveRecheck(unclaimed), true);
  assert.equal(await recovery.consumeStudioActiveRecheck(unclaimed), false);
  assert.equal((await db.imageStudioTask.updateMany({ where: { id: active.id, lease_token: null, lease_until: unclaimed.lease_until },
    data: { lease_token: 'manual-cas-lease', lease_until: new Date(clock + 60000) } })).count, 1);
  const owned = await db.imageStudioTask.findUniqueOrThrow({ where: { id: active.id } });
  let manualGets = 0;
  const manualTransport: typeof fetch = async (url, init) => {
    assert.equal(init?.method, 'GET'); assert.match(String(url), /\/provider-active-original\?view=summary$/); manualGets++;
    return new Response(JSON.stringify({ task_id: 'provider-active-original', status: 'success', assets: [] }), { headers: { 'content-type': 'application/json' } });
  };
  const manualQuery = { ...params, signal: signal(), resumeAsync: { taskId: 'provider-active-original' }, asyncQueryMode: 'single' as const,
    automaticQueryDeadlineAt: clock - 1 };
  await assert.rejects(provider.requestStudioImages(manualQuery, manualTransport)); assert.equal(manualGets, 0);
  assert.equal(await recovery.consumeStudioActiveRecheck(owned), true);
  const originalReceipt = await delivery.readStudioAsyncReceipt(owned); assert.ok(originalReceipt);
  await assert.rejects(provider.requestStudioImages({ ...manualQuery, manualAsyncQuery: true, singleTaskGet: true,
    onAsyncProgress: async progress => { await delivery.updateStudioAsyncReceipt(originalReceipt, progress); } }, manualTransport),
  (error: unknown) => error instanceof provider.StudioProviderError && error.code === 'async_result_ready');
  assert.equal(manualGets, 1); assert.equal(await recovery.consumeStudioActiveRecheck(owned), false);
  assert.equal((await delivery.readStudioAsyncReceipt(owned))?.resultReady, true);
  assert.equal(await recovery.readStudioActiveRecheck(owned), false); // A crash after consumption cannot issue a second GET.
  await recovery.completeStudioActiveRecheck(owned);
  await db.imageStudioTask.update({ where: { id: active.id }, data: { lease_token: null, lease_until: null } });
  assert.equal((await recovery.requestStudioAsyncRecheck(owner, active.id, `request-${active.id}`)).scheduled, false);
  clock += 300001;
  assert.equal((await recovery.readStudioActiveProviderCheck(await db.imageStudioTask.findUniqueOrThrow({ where: { id: active.id } })))?.canRequestRecheck, true);
  assert.equal(await db.creditLedger.count(), 0); assert.equal(await db.asset.count(), 0);
  fixture.check(expectedChecks[11]);
  // Keep prior synthetic cases out of this real worker/restart scenario.
  await db.imageStudioTask.updateMany({ data: { lease_until: new Date(clock + 365 * 86400000) } });
  for (const row of await db.platformSetting.findMany({ where: { key: { startsWith: 'studio_async_recovery_v1:' } } })) {
    await db.platformSetting.update({ where: { id: row.id }, data: { value_json: JSON.stringify({ ...JSON.parse(row.value_json),
      state: 'stopped', stopCode: 'auto_budget', manualOnce: false, leaseToken: null, leaseUntil: null }) } });
  }
  const { DEFAULT_STUDIO_PRICES } = await import('../src/lib/image-studio/settings');
  await db.platformSetting.create({ data: { key: 'gpt_image_studio_v1', value_json: JSON.stringify({ context: '', model, revision: 0,
    prices: { ...DEFAULT_STUDIO_PRICES, [model]: 5 } }) } });
  await db.platformSetting.create({ data: { key: 'image_generation_api_v1', value_json: JSON.stringify({ enabled: true, provider: 'musk',
    base_url: 'https://provider-fixture.invalid', api_key: 'synthetic-not-a-credential', default_model: model,
    supports_text_to_image: true, supports_image_to_image: true, supports_async_task: true }) } });
  const integration = await import('../src/lib/integrations/image-generation');
  const imageChannel = await integration.captureImageGenerationChannel(model, 'original');
  const settings = await integration.resolveImageGenerationChannelSnapshot(imageChannel, db, false, model);
  const { imageBillingScope } = await import('../src/lib/image-studio/billing-scope');
  const { fixedImageBillingContract } = await import('../src/lib/image-studio/billing-quote');
  const { imageOutputPlanHash } = await import('../src/lib/image-generation/output-plan');
  const originalPlan = resolveImageOutputPlan({ model, resolution: '1K', ratio: '1:1' });
  const originalId = 'original-v3-async', scope = imageBillingScope(settings);
  const billingContract = fixedImageBillingContract({ scope, model, credits: 5, specification: 'synthetic-original-specification' });
  const original = await db.imageStudioTask.create({ data: { id: originalId, owner_id: owner, batch_id: originalId, ordinal: 0,
    fingerprint: 'frozen-original-v3', model, prompt: 'Synthetic original', context: 'Original frozen context', revision: 0,
    reference_ids: '[]', output_size: originalPlan.outputSize, aspect_ratio: '1:1', unit_credits: 5,
    status: 'queued', billing_mode: 'fixed', billing_scope: scope, billing_status: 'awaiting_response',
    billing_contract_json: JSON.stringify(billingContract), freeze_snapshot: JSON.stringify([{ source_type: 'balance', amount: 5 }]),
    snapshot_json: JSON.stringify({ requestId: 'request-original-v3-async', ratioContractVersion: 3, outputPlan: originalPlan,
      outputPlanHash: imageOutputPlanHash(originalPlan), resolvedAspectRatio: '1:1', imageChannel, referenceImages: [] }) } });
  await db.creditAccount.update({ where: { user_id: owner }, data: { balance: { decrement: 5 }, frozen_credits: { increment: 5 } } });
  await db.creditLedger.create({ data: { user_id: owner, type: 'task_freeze', amount: -5, balance_before: 100, balance_after: 95,
    frozen_before: 0, frozen_after: 5, related_task_id: originalId, idempotency_key: `image-studio:freeze:${originalId}` } });
  const originalCalls: Array<{ method: string; path: string }> = [];
  const worker = await import('../src/lib/image-studio/worker');
  const initialTransport: typeof fetch = async (url, init) => {
    assert.equal(init?.method, 'POST'); originalCalls.push({ method: 'POST', path: String(url) });
    return new Response(JSON.stringify({ task_id: 'provider-original-v3', poll_after_ms: 2000 }), { status: 202,
      headers: { 'retry-after': '120', 'x-oneapi-request-id': 'gateway-original-v3' } });
  };
  const { claimStudioTask } = await import('../src/lib/image-studio/tasks');
  const claimedOriginal = await claimStudioTask(); assert.equal(claimedOriginal?.id, originalId); assert.ok(claimedOriginal);
  const executeOriginal: typeof provider.requestStudioImages = params => provider.requestStudioImages({ ...params, now: () => clock,
    wait: async ms => { clock += ms; } }, initialTransport);
  await worker.executeFrozenStudioTask(claimedOriginal, executeOriginal, { acceptedOnly: true });
  assert.equal(originalCalls.length, 0, 'A guard cannot submit an unaccepted original task');
  await db.imageStudioTask.update({ where: { id: nativeWithoutIdentity.id }, data: { lease_until: new Date(1) } });
  await worker.recoverStudioTasks({ acceptedOnly: true });
  assert.equal(originalCalls.length, 0); assert.equal(await db.creditLedger.count(), 1);
  await db.imageStudioTask.update({ where: { id: nativeWithoutIdentity.id }, data: { lease_until: new Date(clock + 365 * 86400000) } });
  await worker.executeFrozenStudioTask(claimedOriginal, executeOriginal);
  const waitingOriginal = await db.imageStudioTask.findUniqueOrThrow({ where: { id: originalId } });
  assert.equal(waitingOriginal.status, 'running'); assert.equal(waitingOriginal.billing_settled_at, null);
  assert.equal((await db.creditAccount.findUniqueOrThrow({ where: { user_id: owner } })).frozen_credits, 5);
  const acceptedOriginal = await delivery.readStudioAsyncReceipt(waitingOriginal); assert.ok(acceptedOriginal);
  assert.equal(acceptedOriginal.providerTaskId, 'provider-original-v3'); assert.ok(Number(acceptedOriginal.providerNotBefore) >= clock + 120000);
  const frozenOriginal = (task: typeof original) => [task.id, task.owner_id, task.batch_id, task.fingerprint, task.snapshot_json,
    task.output_size, task.aspect_ratio, task.unit_credits, task.freeze_snapshot, task.billing_contract_json];
  assert.deepEqual(frozenOriginal(waitingOriginal), frozenOriginal(original));
  clock = Number(acceptedOriginal.providerNotBefore) + 1;
  const png = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: { r: 40, g: 90, b: 130 } } }).png().toBuffer();
  mock.method(dns, 'lookup', async (hostname: string) => hostname === 'provider-fixture.invalid'
    ? [{ address: '1.1.1.1', family: 4 }] : fixture.blocked());
  mock.method(https, 'request', (url: URL, options: RequestOptions, respond: (response: IncomingMessage) => void) => {
    if (url.hostname !== 'provider-fixture.invalid' || options.method !== 'GET'
      || url.pathname !== '/v1/images/tasks/provider-original-v3' || !['?view=summary', ''].includes(url.search)) return fixture.blocked();
    const request = new EventEmitter() as EventEmitter & { end: () => void };
    request.end = () => queueMicrotask(() => {
      originalCalls.push({ method: 'GET', path: url.pathname + url.search });
      const response = new PassThrough() as PassThrough & { statusCode: number; headers: Record<string, string> };
      response.statusCode = 200; response.headers = { 'content-type': 'application/json' }; respond(response as unknown as IncomingMessage);
      setImmediate(() => response.end(JSON.stringify(url.search ? { task_id: 'provider-original-v3', status: 'success', assets: [] }
        : { data: [{ b64_json: png.toString('base64') }] })));
    }); return request;
  });
  await db.imageStudioTask.update({ where: { id: originalId }, data: { lease_until: new Date(1) } });
  await worker.recoverStudioTasks();
  const completedOriginal = await db.imageStudioTask.findUniqueOrThrow({ where: { id: originalId } });
  assert.equal(completedOriginal.status, 'succeeded'); assert.equal(completedOriginal.actual_credits, 5);
  assert.deepEqual(frozenOriginal(completedOriginal), frozenOriginal(original));
  assert.equal(await db.creditLedger.count({ where: { idempotency_key: `image-studio:settle:${originalId}` } }), 1);
  assert.equal(originalCalls.filter(call => call.method === 'POST').length, 1);
  assert.equal(originalCalls.filter(call => call.method === 'GET').length, 2);
  const resultAsset = await db.asset.findUniqueOrThrow({ where: { id: completedOriginal.asset_id! } });
  assert.equal(resultAsset.status, 'active'); assert.equal(resultAsset.owner_id, owner);
  assert.deepEqual(await fs.readFile(path.join(fixture.directory, 'public', resultAsset.original_url)), png);
  await worker.recoverStudioTasks();
  assert.equal(originalCalls.length, 3); assert.equal(await db.creditLedger.count({ where: { related_task_id: originalId } }), 2);
  assert.equal((await db.creditAccount.findUniqueOrThrow({ where: { user_id: owner } })).frozen_credits, 0);
  fixture.check(expectedChecks[12]);
  const { finishStudioTask } = await import('../src/lib/image-studio/tasks');
  const dimension = await import('../src/lib/image-studio/dimension-rejection');
  const { studioTaskHasViewableOutput } = await import('../src/lib/image-studio/dimension-mismatch');
  const seedOriginal = async (id: string) => {
    const before = await db.creditAccount.findUniqueOrThrow({ where: { user_id: owner } });
    const allocations = [{ source_type: 'balance', amount: 5 }];
    const task = await db.imageStudioTask.create({ data: { ...original, id, batch_id: id, fingerprint: `frozen-${id}`,
      snapshot_json: JSON.stringify({ ...JSON.parse(original.snapshot_json!), requestId: `request-${id}` }),
      status: 'running', lease_token: `lease-${id}`, lease_until: new Date(clock + 600000) } });
    await db.creditAccount.update({ where: { user_id: owner }, data: { balance: { decrement: 5 }, frozen_credits: { increment: 5 } } });
    await db.creditLedger.create({ data: { user_id: owner, type: 'task_freeze', amount: -5, balance_before: before.balance,
      balance_after: before.balance - 5, frozen_before: before.frozen_credits, frozen_after: before.frozen_credits + 5,
      related_task_id: id, idempotency_key: `image-studio:freeze:${id}`, metadata_json: JSON.stringify({ allocations }) } });
    await delivery.beginStudioRequest(task); await delivery.setStudioUnsentRequestState(task, 'attempted');
    await delivery.recordStudioAsyncAcceptance(task, response(), { taskId: `provider-${id}`, pollAfterMs: 2000 });
    return await db.imageStudioTask.findUniqueOrThrow({ where: { id } });
  };
  const unknown = await seedOriginal('original-v3-unknown');
  assert.equal(await finishStudioTask(unknown, 'uncertain', { error: 'Synthetic original acceptance remains unknown' }), true);
  const unknownAfter = await db.imageStudioTask.findUniqueOrThrow({ where: { id: unknown.id } });
  assert.equal(unknownAfter.billing_settled_at, null); assert.equal(unknownAfter.actual_credits, null);
  assert.equal(await db.creditLedger.count({ where: { related_task_id: unknown.id } }), 1);
  const mismatchPng = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 70, g: 50, b: 10 } } }).png().toBuffer();
  for (const [format, bytes] of [['png', mismatchPng], ['jpeg', await sharp(png).jpeg().toBuffer()]] as const) for (const late of [false, true]) {
    let mismatch = await seedOriginal(`original-v3-${late ? 'late' : 'fresh'}-${format}-mismatch`);
    if (late) {
      const receipt = await delivery.readStudioAsyncReceipt(mismatch); assert.ok(receipt);
      assert.equal(await recovery.releaseStudioAsyncSlot(mismatch, receipt, 'provider_unconfirmed', 'uncertain'), true);
      const key = `studio_async_recovery_v1:${mismatch.id}`, row = await db.platformSetting.findUniqueOrThrow({ where: { key } });
      clock += 10000;
      await db.platformSetting.update({ where: { key }, data: { value_json: JSON.stringify({ ...JSON.parse(row.value_json), nextCheckAt: clock - 1 }) } });
      let claim: Awaited<ReturnType<typeof recovery.claimStudioAsyncRecovery>> = null;
      for (let pass = 0; pass < 3 && !claim; pass++) claim = await recovery.claimStudioAsyncRecovery();
      assert.equal(claim?.task.id, mismatch.id); assert.ok(claim); mismatch = claim.task;
    }
    const frozenBefore = frozenOriginal(mismatch);
    assert.equal(await dimension.finishRejectedStudioDimensions(mismatch, bytes), true);
    const ended = await db.imageStudioTask.findUniqueOrThrow({ where: { id: mismatch.id } });
    assert.equal(ended.status, 'uncertain'); assert.equal(ended.actual_credits, 0); assert.ok(ended.billing_settled_at);
    assert.equal(studioTaskHasViewableOutput(ended), true); assert.deepEqual(frozenOriginal(ended), frozenBefore);
    const kept = await db.asset.findUniqueOrThrow({ where: { id: ended.asset_id! } });
    assert.equal(kept.owner_id, owner); assert.equal(kept.status, 'active'); assert.equal(kept.hash, sha256(bytes));
    assert.equal(kept.mime_type, format === 'jpeg' ? 'image/jpeg' : 'image/png');
    assert.deepEqual(await fs.readFile(path.join(fixture.directory, 'public', kept.original_url)), bytes);
    assert.deepEqual(await dimension.readRetainedStudioDimensionOriginal(ended), bytes);
    const ledger = await db.creditLedger.findMany({ where: { related_task_id: mismatch.id }, orderBy: { id: 'asc' } });
    assert.equal(ledger.length, 2); assert.equal(ledger.filter(row => row.type === 'task_failed_refund' && row.amount === 5).length, 1);
    await assert.rejects(dimension.finishRejectedStudioDimensions(ended, bytes));
    assert.deepEqual(await db.creditLedger.findMany({ where: { related_task_id: mismatch.id }, orderBy: { id: 'asc' } }), ledger);
  }
  assert.equal((await db.creditAccount.findUniqueOrThrow({ where: { user_id: owner } })).frozen_credits, 5);
  assert.equal(await db.creditLedger.count({ where: { related_task_id: unknown.id, type: 'task_failed_refund' } }), 0);
  assert.equal(originalCalls.length, 3, 'Mismatch retention and late completion never submit or query a provider');
  fixture.check(expectedChecks[13]);
  await fixture.finish({ negativeChecks: ['legacy_wait_schema_rejected', 'conflicting_core_accounting_copy_rejected'], calls,
    manualOriginalGets: manualGets, initialHoldDispatchCalls: heldCalls, originalCalls, cancellationEvidence, billingModes,
    originalSettlementCount: await db.creditLedger.count({ where: { idempotency_key: `image-studio:settle:${originalId}` } }) });
}

main().catch(error => { console.error(error); process.exit(1); });
