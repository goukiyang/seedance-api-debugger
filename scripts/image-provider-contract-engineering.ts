import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import https, { type RequestOptions } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { mock } from 'node:test';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import sharp from 'sharp';
import * as ts from 'typescript';
import { traceFixture, sha256 } from './image-trace-engineering-fixture';
import type { StudioAsyncAccepted } from '../src/lib/image-studio/provider';

const sourcePaths = ['scripts/image-trace-engineering-fixture.ts', 'scripts/process-image-studio.ts', 'src/lib/image-studio/provider.ts',
  'src/lib/image-studio/provider-wait.ts', 'src/lib/image-studio/delivery.ts', 'src/lib/image-studio/async-recovery.ts',
  'src/lib/image-studio/worker.ts', 'src/lib/image-studio/worker-mode.ts', 'src/lib/image-studio/tasks.ts', 'src/lib/image-studio/response-diagnostics.ts',
  'src/lib/image-studio/response-evidence.ts', 'src/lib/image-generation/output-plan.ts',
  'src/lib/image-studio/dimension-rejection.ts', 'src/lib/image-studio/dimension-mismatch.ts', 'src/lib/image-studio/output.ts',
  'src/app/image-studio/studio.tsx', 'src/app/image-studio/output-plan-view.tsx',
  'src/app/image-studio/batch-results.tsx', 'src/lib/image-studio/context-version.ts',
  'src/lib/media/hd-directory.ts', 'src/lib/media/hd-derivatives.ts'];
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
  'normal_provider_polling_keeps_real_wait_ui_while_long_invalid_paused_and_checking_remain_special',
  'rate_v3_core_repair_active_single_get_and_dual_namespace_claim_keep_frozen_accounting',
  'invalid_provider_ui_dates_never_reach_single_or_batch_date_rendering',
  'actual_worker_startup_hold_keeps_heartbeat_only_and_accepted_only_publishes_no_pricing_readiness',
  'hd_directory_resolver_uses_only_frozen_server_config_and_rejects_invalid_explicit_paths',
];

function actualWaitUi(root: string, mismatchDisposition: (value: string | null | undefined) => boolean) {
  const filename = path.join(root, 'src/app/image-studio/studio.tsx');
  const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const planFilename = path.join(root, 'src/app/image-studio/output-plan-view.tsx');
  const planSource = ts.createSourceFile(planFilename, readFileSync(planFilename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const dateHelper = planSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'imageProviderCheckTime');
  assert.ok(dateHelper, 'Single and batch views must share a bounded date reader');
  const names = new Set(['studioTaskAsyncRecovery', 'studioTaskProviderCheck', 'studioTaskProviderWait', 'studioTaskHasViewableImage', 'studioTaskPhase']);
  const helpers = source.statements.filter(node => ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text));
  assert.equal(helpers.length, names.size);
  const declarations: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node) => { if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'ownResults') declarations.push(node); ts.forEachChild(node, visit); };
  visit(source); assert.equal(declarations.length, 1);
  const map = declarations[0].initializer; assert.ok(map && ts.isCallExpression(map));
  const callback = map.arguments[0]; assert.ok(callback && ts.isArrowFunction(callback) && ts.isBlock(callback.body));
  const statements = callback.body.statements.filter(ts.isVariableStatement);
  assert.deepEqual(statements.flatMap(statement => statement.declarationList.declarations.map(value => value.name.getText(source))),
    ['image', 'asyncRecovery', 'providerCheck', 'pending']);
  const returned = callback.body.statements.find(ts.isReturnStatement); assert.ok(returned?.expression);
  let expression = returned.expression;
  while (ts.isSatisfiesExpression(expression) || ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression)) expression = expression.expression;
  assert.ok(ts.isObjectLiteralExpression(expression));
  const fields = expression.properties.filter(property => (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
    && ['pending', 'generationWait'].includes(property.name.getText(source)));
  assert.equal(fields.length, 2);
  // Compile original AST-selected helpers and consumer expressions; no copied
  // progress formula, component platform, browser or alternate threshold.
  const input = `${dateHelper.getText(planSource).replace(/^export\s+/, '')}\n${helpers.map(node => node.getText(source)).join('\n')}\nfunction readWaitUi(task) {\n${statements.map(node => node.getText(source)).join('\n')}\nreturn {${fields.map(node => node.getText(source)).join(',\n')}};\n}\nglobalThis.waitUi = { read: readWaitUi, wait: studioTaskProviderWait, phase: studioTaskPhase, checkTime: imageProviderCheckTime };`;
  const compiled = ts.transpileModule(input, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const sandbox = vm.createContext({ Date, resultError: '', studioOutputMismatchDisposition: mismatchDisposition,
    studioTaskPreviewState: () => { throw new Error('Polling fixture has no output image'); } });
  vm.runInContext(compiled.outputText, sandbox, { filename: 'actual-studio-wait-consumer.js', timeout: 5000 });
  return sandbox.waitUi as { read(task: unknown): { pending: boolean; generationWait?: { taskKey: string; acceptedAt?: number; phase?: string } };
    wait(task: unknown): number | null; phase(task: unknown): string; checkTime(value: unknown, now?: number): number | null };
}

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
      unit_credits: 5, billing_mode: 'fixed', billing_scope: 'synthetic-scope', billing_status: id.startsWith('rate-') ? 'rate_channel_unmatched' : 'channel_unmatched',
      status: id.startsWith('rate-') ? 'rate_channel_running' : 'channel_running',
      freeze_snapshot: '[]', lease_token: `lease-${id}`, lease_until: new Date(clock + 600000),
      snapshot_json: JSON.stringify({ requestId: `request-${id}`, ratioContractVersion: version, outputPlan,
        imageChannel: { channelId, configRevision } }) } });
    await delivery.beginStudioRequest(task); await delivery.setStudioUnsentRequestState(task, 'attempted'); return task;
  };
  const response = () => new Response(null, { status: 202, headers: { 'x-oneapi-request-id': 'gateway-synthetic', 'x-request-id': 'upstream-synthetic' } });
  const storage = (id: string, billing: boolean, name: string) => path.join(fixture.directory, 'storage', billing ? 'studio-billing' : 'studio-delivery', id, name);
  const faults = ['pending-request', 'pending-billing', 'request', 'request-billing', 'async', 'async-billing', 'database'] as const;
  for (const prefix of ['', 'rate-']) for (const stage of faults) {
    const task = await make(`${prefix}partial-${stage}`);
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
  const { studioTaskDTOs } = await import('../src/lib/image-studio/tasks');
  const { studioProviderWaitBlocked } = await import('../src/lib/image-studio/provider-wait');
  const { studioOutputMismatchDisposition } = await import('../src/lib/image-studio/dimension-mismatch');
  const waitUi = actualWaitUi(fixture.root, studioOutputMismatchDisposition);
  const projectionCases: Array<{ name: string; wait: ReturnType<typeof parseWait>; special: boolean }> = [
    { name: 'no-header', wait: {}, special: false },
    { name: 'ordinary-2s', wait: parseWait(new Headers(), { poll_after_ms: 2000 }, clock), special: false },
    { name: 'ordinary-reader-ceiling-30s', wait: parseWait(new Headers(), { poll_after_ms: 30000 }, clock), special: false },
    { name: 'longer-than-old-reader', wait: parseWait(new Headers(), { poll_after_ms: 30001 }, clock), special: true },
    { name: 'invalid-conservative', wait: parseWait(new Headers({ 'retry-after': 'invalid' }), null, clock), special: true },
  ];
  const projectionEvidence: Array<{ name: string; providerCheck: string | null; pending: boolean; generationWait: boolean }> = [];
  const snapshotReads = async () => ({ tasks: await db.imageStudioTask.findMany({ orderBy: { id: 'asc' } }),
    settings: await db.platformSetting.findMany({ orderBy: { key: 'asc' } }),
    account: await db.creditAccount.findUniqueOrThrow({ where: { user_id: owner } }), ledger: await db.creditLedger.findMany({ orderBy: { id: 'asc' } }) });
  for (const sample of projectionCases) {
    const activeTask = await make(`projection-${sample.name}`);
    const accepted = await delivery.recordStudioAsyncAcceptance(activeTask, response(), { taskId: `provider-${activeTask.id}`, ...sample.wait });
    assert.ok(accepted);
    const current = await db.imageStudioTask.findUniqueOrThrow({ where: { id: activeTask.id } });
    const files = [false, true].flatMap(billing => ['request.json', 'async.json'].map(name => storage(current.id, billing, name)));
    const filesBefore = await Promise.all(files.map(file => fs.readFile(file, 'utf8')));
    const before = await snapshotReads();
    const callsBefore: number = calls.length;
    const check = await recovery.readStudioActiveProviderCheck(current);
    const status = await delivery.studioDeliveryStatus(current);
    const dto = (await studioTaskDTOs(owner, false, [current]))[0]; assert.ok(dto.delivery);
    assert.equal(status.phase, 'provider'); assert.equal(status.acceptedAt, accepted.acceptedAt);
    assert.equal(dto.delivery.phase, 'provider'); assert.equal(dto.delivery.acceptedAt, accepted.acceptedAt);
    const ui = waitUi.read(dto);
    if (sample.special) {
      assert.equal(check?.state, 'waiting'); assert.equal(dto.delivery.providerCheck?.state, 'waiting');
      assert.equal(ui.pending, false); assert.equal(ui.generationWait, undefined);
      assert.equal(waitUi.phase(dto), '等待供应商允许核对');
      assert.equal(waitUi.wait(dto), sample.name === 'invalid-conservative' ? null : accepted.providerNotBefore);
    } else {
      assert.equal(check, null); assert.equal('providerCheck' in status, false); assert.equal('providerCheck' in dto.delivery, false);
      assert.equal(ui.pending, true); assert.ok(ui.generationWait);
      assert.equal(ui.generationWait.taskKey, current.id); assert.equal(ui.generationWait.acceptedAt, accepted.acceptedAt);
      assert.equal(ui.generationWait.phase, 'provider'); assert.equal(waitUi.phase(dto), '生成中');
      assert.equal(waitUi.wait(dto), null, 'Normal raw notBefore must not expose a manual-check time');
      if (accepted.providerNotBefore) assert.equal(studioProviderWaitBlocked(accepted, clock), true,
        'Display filtering must not release the real network notBefore gate');
    }
    if (sample.name === 'no-header') {
      const restoreClock = clock;
      try {
        clock = accepted.acceptedAt + 24 * 60 * 60_000 + 1;
        assert.equal((await recovery.readStudioActiveProviderCheck(current))?.state, 'paused');
        const paused = (await studioTaskDTOs(owner, false, [current]))[0];
        assert.equal(paused.delivery?.providerCheck?.state, 'paused');
        assert.equal(waitUi.read(paused).pending, false); assert.equal(waitUi.read(paused).generationWait, undefined);
        assert.equal(waitUi.phase(paused), '自动核对已暂停');
      } finally { clock = restoreClock; }
    }
    assert.deepEqual(await snapshotReads(), before, 'Pure reads/UI projection cannot write tasks, permits, settings or money');
    assert.deepEqual(await Promise.all(files.map(file => fs.readFile(file, 'utf8'))), filesBefore);
    assert.equal(await delivery.readStudioCorePending(current), null);
    assert.equal(await db.platformSetting.count({ where: { key: `studio_async_active_recheck_v1:${current.id}` } }), 0);
    assert.equal(calls.length, callsBefore);
    projectionEvidence.push({ name: sample.name, providerCheck: check?.state || null, pending: ui.pending, generationWait: Boolean(ui.generationWait) });
    if (sample.name === 'invalid-conservative') {
      assert.equal(await recovery.releaseStudioAsyncSlot(current, accepted, 'provider_unconfirmed', 'uncertain'), true);
      const detached = await db.imageStudioTask.findUniqueOrThrow({ where: { id: current.id } });
      const key = `studio_async_recovery_v1:${current.id}`;
      const recoveryBefore = await db.platformSetting.findUniqueOrThrow({ where: { key } });
      const record = JSON.parse(recoveryBefore.value_json);
      assert.ok(record.nextCheckAt >= Number(accepted.providerNotBefore)); assert.equal(record.attempts, 0);
      const detachedBefore = await snapshotReads(), restoreClock = clock;
      try {
        for (const observedAt of [clock, Number(accepted.providerNotBefore) + 1]) {
          clock = observedAt;
          const view = await recovery.readStudioAsyncRecovery(detached); assert.ok(view);
          assert.equal(view.canRequestRecheck, false); assert.equal(view.nextCheckAt, null);
          assert.equal('providerNotBefore' in view, false, 'An invalid instruction has no promised check time, even after its conservative date');
          const dto = (await studioTaskDTOs(owner, false, [detached]))[0];
          assert.equal(dto.delivery?.asyncRecovery?.nextCheckAt, null);
          assert.equal(waitUi.wait(dto), null);
          const detachedUi = waitUi.read(dto);
          assert.equal(detachedUi.pending, false); assert.equal(waitUi.phase(dto), '结果待核对');
          assert.equal((await recovery.requestStudioAsyncRecheck(owner, detached.id, view.binding)).scheduled, false);
          const preserved = await delivery.readStudioAsyncReceipt(detached); assert.ok(preserved);
          assert.equal(preserved.providerNotBefore, accepted.providerNotBefore);
          assert.equal(preserved.providerWaitSource, 'invalid-conservative');
          assert.equal(studioProviderWaitBlocked(preserved, clock), true);
          assert.deepEqual(await db.platformSetting.findUniqueOrThrow({ where: { key } }), recoveryBefore);
          assert.deepEqual(await snapshotReads(), detachedBefore);
          assert.deepEqual(await Promise.all(files.map(file => fs.readFile(file, 'utf8'))), filesBefore);
          assert.equal(calls.length, callsBefore);
          projectionEvidence.push({ name: `detached-invalid-${observedAt > Number(accepted.providerNotBefore) ? 'after' : 'before'}-conservative-date`,
            providerCheck: null, pending: detachedUi.pending, generationWait: Boolean(detachedUi.generationWait) });
        }
      } finally { clock = restoreClock; }
    }
  }
  const manualEvidence: Array<{ taskId: string; gets: number }> = [];
  let manualGets = 0;
  for (const activeId of ['active-original-check', 'rate-active-original-check']) {
  const active = await make(activeId);
  const manualNotBefore = clock + 86400000 + 120000;
  await delivery.recordStudioAsyncAcceptance(active, response(), { taskId: `provider-${activeId}`,
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
  let taskManualGets = 0;
  const manualTransport: typeof fetch = async (url, init) => {
    assert.equal(init?.method, 'GET'); assert.equal(new URL(String(url)).pathname.split('/').at(-1), `provider-${activeId}`);
    assert.equal(new URL(String(url)).search, '?view=summary'); taskManualGets++; manualGets++;
    return new Response(JSON.stringify({ task_id: `provider-${activeId}`, status: 'success', assets: [] }), { headers: { 'content-type': 'application/json' } });
  };
  const manualQuery = { ...params, signal: signal(), resumeAsync: { taskId: `provider-${activeId}` }, asyncQueryMode: 'single' as const,
    automaticQueryDeadlineAt: clock - 1 };
  await assert.rejects(provider.requestStudioImages(manualQuery, manualTransport)); assert.equal(taskManualGets, 0);
  assert.equal(await recovery.consumeStudioActiveRecheck(owned), true);
  assert.equal((await recovery.readStudioActiveProviderCheck(owned))?.state, 'checking');
  const checkingDto = (await studioTaskDTOs(owner, false, [owned]))[0];
  assert.equal(checkingDto.delivery?.providerCheck?.state, 'checking');
  assert.equal(waitUi.read(checkingDto).pending, false); assert.equal(waitUi.read(checkingDto).generationWait, undefined);
  assert.equal(waitUi.phase(checkingDto), '正在核对原任务');
  const originalReceipt = await delivery.readStudioAsyncReceipt(owned); assert.ok(originalReceipt);
  await assert.rejects(provider.requestStudioImages({ ...manualQuery, manualAsyncQuery: true, singleTaskGet: true,
    onAsyncProgress: async progress => { await delivery.recordStudioAsyncProgress(owned, originalReceipt, progress); } }, manualTransport),
  (error: unknown) => error instanceof provider.StudioProviderError && error.code === 'async_result_ready');
  assert.equal(taskManualGets, 1); assert.equal(await recovery.consumeStudioActiveRecheck(owned), false);
  assert.equal((await delivery.readStudioAsyncReceipt(owned))?.resultReady, true);
  for (const billing of [false, true]) {
    const persisted = JSON.parse(await fs.readFile(storage(owned.id, billing, 'async.json'), 'utf8'));
    assert.equal(persisted.resultReady, true);
  }
  assert.equal(await delivery.readStudioCorePending(owned), null);
  assert.equal(await recovery.readStudioActiveRecheck(owned), false); // A crash after consumption cannot issue a second GET.
  await recovery.completeStudioActiveRecheck(owned);
  await db.imageStudioTask.update({ where: { id: active.id }, data: { lease_token: null, lease_until: null } });
  assert.equal((await recovery.requestStudioAsyncRecheck(owner, active.id, `request-${active.id}`)).scheduled, false);
  clock += 300001;
  assert.equal((await recovery.readStudioActiveProviderCheck(await db.imageStudioTask.findUniqueOrThrow({ where: { id: active.id } })))?.canRequestRecheck, true);
  assert.equal(await db.creditLedger.count(), 0); assert.equal(await db.asset.count(), 0);
  manualEvidence.push({ taskId: activeId, gets: taskManualGets });
  }
  fixture.check(expectedChecks[11]);
  // Keep prior synthetic cases out of this real worker/restart scenario.
  await db.imageStudioTask.updateMany({ data: { lease_until: new Date(clock + 365 * 86400000) } });
  for (const row of await db.platformSetting.findMany({ where: { OR: [{ key: { startsWith: 'studio_async_recovery_v1:' } }, { key: { startsWith: 'studio_pricing_async_recovery_v1:' } }] } })) {
    await db.platformSetting.update({ where: { id: row.id }, data: { value_json: JSON.stringify({ ...JSON.parse(row.value_json),
      state: 'stopped', stopCode: 'auto_budget', manualOnce: false, leaseToken: null, leaseUntil: null }) } });
  }
  const namespaceEvidence: Array<{ taskId: string; namespace: string; claimedStatus: string }> = [];
  const namespaceTasks = new Map<string, Awaited<ReturnType<typeof make>>>();
  for (const id of ['claim-namespace-original', 'rate-claim-namespace-original']) {
    const task = await make(id);
    const receipt = await delivery.recordStudioAsyncAcceptance(task, response(), { taskId: `provider-${id}`, pollAfterMs: 2000 });
    assert.ok(receipt); assert.equal(await recovery.releaseStudioAsyncSlot(task, receipt, 'provider_unconfirmed', 'uncertain'), true);
    const namespace = id.startsWith('rate-') ? 'studio_pricing_async_recovery_v1:' : 'studio_async_recovery_v1:';
    const row = await db.platformSetting.findUniqueOrThrow({ where: { key: namespace + id } });
    await db.platformSetting.update({ where: { id: row.id }, data: { value_json: JSON.stringify({ ...JSON.parse(row.value_json), nextCheckAt: clock - 1 }) } });
    namespaceTasks.set(id, task);
  }
  const namespaceLedgerBefore = await db.creditLedger.count();
  for (let pass = 0; pass < 6 && namespaceEvidence.length < 2; pass++) {
    const claimed = await recovery.claimStudioAsyncRecovery({ acceptedOnly: true });
    if (!claimed) continue;
    const original = namespaceTasks.get(claimed.task.id); assert.ok(original);
    assert.equal(namespaceEvidence.some(item => item.taskId === claimed.task.id), false);
    const namespace = claimed.task.id.startsWith('rate-') ? 'studio_pricing_async_recovery_v1:' : 'studio_async_recovery_v1:';
    assert.equal(claimed.task.status, claimed.task.id.startsWith('rate-') ? 'rate_uncertain' : 'uncertain');
    for (const field of ['owner_id', 'fingerprint', 'snapshot_json', 'billing_contract_json', 'freeze_snapshot'] as const) assert.equal(claimed.task[field], original[field]);
    namespaceEvidence.push({ taskId: claimed.task.id, namespace, claimedStatus: claimed.task.status });
    const row = await db.platformSetting.findUniqueOrThrow({ where: { key: namespace + claimed.task.id } });
    await db.platformSetting.update({ where: { id: row.id }, data: { value_json: JSON.stringify({ ...JSON.parse(row.value_json),
      state: 'stopped', stopCode: 'auto_budget', manualOnce: false, leaseToken: null, leaseUntil: null }) } });
    await db.imageStudioTask.update({ where: { id: claimed.task.id }, data: { lease_until: new Date(clock + 365 * 86400000) } });
  }
  assert.equal(namespaceEvidence.length, 2); assert.equal(await db.creditLedger.count(), namespaceLedgerBefore);
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
  const { parseImageBillingContract } = await import('../src/lib/image-studio/billing-contract');
  const { imageOutputPlanHash } = await import('../src/lib/image-generation/output-plan');
  const originalPlan = resolveImageOutputPlan({ model, resolution: '1K', ratio: '1:1' });
  const originalId = 'original-v3-async', scope = imageBillingScope(settings);
  const billingContract = fixedImageBillingContract({ scope, model, credits: 5, specification: sha256('synthetic-original-specification') });
  assert.ok(parseImageBillingContract(JSON.stringify(billingContract)), 'Synthetic original billing seed must satisfy the real frozen-contract reader');
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
  fixture.check(expectedChecks[14]);
  assert.equal(manualGets, 2); assert.equal(manualEvidence.length, 2);
  assert.equal(namespaceEvidence.length, 2);
  fixture.check(expectedChecks[15]);
  const invalidDates = [undefined, null, '', '1700000000000', NaN, Infinity, -Infinity, -1, 0, clock,
    Number.MAX_SAFE_INTEGER, 8_640_000_000_000_001, clock + 0.5];
  for (const value of invalidDates) {
    assert.equal(waitUi.checkTime(value, clock), null);
    assert.equal(waitUi.wait({ delivery: { providerCheck: { availableAt: value } } }), null);
  }
  for (const value of [clock + 1, 8_640_000_000_000_000]) {
    assert.equal(waitUi.checkTime(value, clock), value); assert.doesNotThrow(() => new Date(value).toISOString());
  }
  const batchSource = readFileSync(path.join(fixture.root, 'src/app/image-studio/batch-results.tsx'), 'utf8');
  assert.match(batchSource, /imageProviderCheckTime\(item\.delivery\?\.providerCheck\?\.availableAt\)/);
  assert.doesNotMatch(batchSource, /new Date\(item\.delivery(?:\?|\.)/);
  fixture.check(expectedChecks[16]);
  const processFile = path.join(fixture.root, 'scripts/process-image-studio.ts');
  const processAst = ts.createSourceFile(processFile, readFileSync(processFile, 'utf8'), ts.ScriptTarget.Latest, true);
  const mainFunction = processAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'main');
  assert.ok(mainFunction && ts.isFunctionDeclaration(mainFunction) && mainFunction.body);
  const readinessNames = new Set(['pricingCapability', 'renewReadiness']);
  const readinessDeclarations = mainFunction.body.statements.filter(ts.isVariableStatement).filter(statement =>
    statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && readinessNames.has(declaration.name.text)));
  assert.equal(readinessDeclarations.length, 2);
  const startupReadiness = mainFunction.body.statements.find(node => ts.isIfStatement(node)
    && node.expression.getText(processAst) === '!acceptedOnly' && node.thenStatement.getText(processAst).includes('await renewReadiness()'));
  assert.ok(startupReadiness, 'Use the actual startup readiness branch');
  const readinessCode = ts.transpileModule(`(async () => { ${readinessDeclarations.map(node => node.getText(processAst)).join('\n')}\n${startupReadiness.getText(processAst)} })()`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const readinessEvidence: Array<Record<string, unknown>> = [];
  for (const state of [{ acceptedOnly: false, initialHold: false }, { acceptedOnly: false, initialHold: true }, { acceptedOnly: true, initialHold: false }]) {
    let captures = 0, renewals = 0;
    const rowsBefore = await db.platformSetting.findMany({ orderBy: { key: 'asc' } });
    const sandbox = vm.createContext({ ...state, source: 'c'.repeat(40), workerId: 'actual-readiness-fixture', loadedModuleSha, prisma: db,
      capturePricingWorkerCapability: () => { captures++; return { source: 'c'.repeat(40) }; },
      renewPricingWorkerCapability: async () => { renewals++; },
      publishStudioWorkerReadiness: (input: Parameters<typeof modes.publishStudioWorkerReadiness>[0]) => modes.publishStudioWorkerReadiness(input, db) });
    await vm.runInContext(readinessCode, sandbox, { filename: 'actual-worker-startup-readiness.js', timeout: 5000 });
    assert.equal(captures, state.acceptedOnly ? 0 : 1); assert.equal(renewals, state.acceptedOnly ? 0 : 1);
    if (state.acceptedOnly) assert.deepEqual(await db.platformSetting.findMany({ orderBy: { key: 'asc' } }), rowsBefore);
    assert.equal(modes.studioWorkerBillingEnabled(state), !state.acceptedOnly && !state.initialHold);
    readinessEvidence.push({ ...state, captures, renewals });
  }
  fixture.check(expectedChecks[17]);
  const { CANONICAL_HD_DIRECTORY, resolveHdDirectory, hdDirectory } = await import('../src/lib/media/hd-directory');
  assert.equal(CANONICAL_HD_DIRECTORY, '/data/video-api-debugger/var-lib/storage/hd-derivatives');
  for (const root of ['/data/hd-resolver-fixture-a', '/data/hd-resolver-fixture-b']) {
    assert.equal(resolveHdDirectory({ root, mode: 'production', env: { HD_DERIVATIVES_ROOT: CANONICAL_HD_DIRECTORY } }), CANONICAL_HD_DIRECTORY);
    assert.throws(() => resolveHdDirectory({ root, mode: 'production', env: {} }));
    for (const mode of ['test', 'development']) {
      assert.equal(resolveHdDirectory({ root, mode, env: {} }), path.join(root, 'storage', 'hd-derivatives'));
      assert.equal(resolveHdDirectory({ root, mode, env: { HD_DERIVATIVES_ROOT: CANONICAL_HD_DIRECTORY } }), CANONICAL_HD_DIRECTORY);
    }
    for (const invalid of ['', ' ', ` ${CANONICAL_HD_DIRECTORY}`, '/data/another-project/hd-derivatives',
      'storage/hd-derivatives', `${CANONICAL_HD_DIRECTORY}/`, `${CANONICAL_HD_DIRECTORY}/../hd-derivatives`]) {
      for (const mode of ['production', 'test', 'development']) {
        assert.throws(() => resolveHdDirectory({ root, mode, env: { HD_DERIVATIVES_ROOT: invalid } }));
      }
    }
  }
  const frozenHdDirectory = hdDirectory();
  assert.equal(Reflect.apply(hdDirectory, undefined, [{ root: '/http-caller', mode: 'test',
    env: { HD_DERIVATIVES_ROOT: '/http-caller-selected' }, HD_DERIVATIVES_ROOT: '/http-caller-selected' }]), frozenHdDirectory);
  const savedHdEnv = process.env.HD_DERIVATIVES_ROOT, savedMode = process.env.NODE_ENV;
  try {
    process.env.HD_DERIVATIVES_ROOT = '/http-caller-selected'; Object.assign(process.env, { NODE_ENV: 'production' });
    assert.equal(hdDirectory(), frozenHdDirectory, 'The real zero-argument wrapper captures server configuration once');
  } finally {
    if (savedHdEnv === undefined) delete process.env.HD_DERIVATIVES_ROOT; else process.env.HD_DERIVATIVES_ROOT = savedHdEnv;
    if (savedMode === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV'); else Object.assign(process.env, { NODE_ENV: savedMode });
  }
  fixture.check(expectedChecks[18]);
  await fixture.finish({ negativeChecks: ['legacy_wait_schema_rejected', 'conflicting_core_accounting_copy_rejected'], calls,
    manualOriginalGets: manualGets, manualEvidence, namespaceEvidence, readinessEvidence,
    hdDirectoryEvidence: { pureResolverOnly: true, canonical: CANONICAL_HD_DIRECTORY, frozenHdDirectory, filesystemCalls: 0 },
    initialHoldDispatchCalls: heldCalls, originalCalls, cancellationEvidence, billingModes, projectionEvidence,
    originalSettlementCount: await db.creditLedger.count({ where: { idempotency_key: `image-studio:settle:${originalId}` } }) });
}

main().catch(error => { console.error(error); process.exit(1); });
