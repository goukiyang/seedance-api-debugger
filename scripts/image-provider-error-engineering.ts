import { setFixtureDatabase } from './fixtures/database-client';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import path from 'node:path';
import { mock } from 'node:test';
import { StudioImageDownloadError } from '../src/lib/image-studio/media';

const sourcePaths = ['src/lib/image-studio/provider.ts', 'src/lib/image-studio/worker.ts',
  'src/lib/image-studio/provider-error-diagnostics.ts', 'src/lib/image-studio/provider-error-evidence.ts'];
const expectedChecks = ['post_errors_preserve_transport_and_safe_serialized_metadata',
  'summary_failed_uncertain_and_original_identity', 'result_errors_and_resume_never_fabricate_post',
  'bounded_error_body_cancellation_and_native_compatibility', 'large_success_download_and_callback_failures_preserve_business',
  'positive_allowlist_rejects_private_echo_and_malicious_fields', 'aggregate_preserves_first_latest_counts_and_limits',
  'sqlite_binding_lease_cas_and_read_projection', 'diagnostic_write_failure_isolated_from_original_business',
  'three_worker_generate_paths_and_local_validation_bound'];
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
process.exitCode = 1;
let fixturePhase = 'setup', fixtureSettled = false;
process.once('beforeExit', () => {
  if (!fixtureSettled) console.error('[image-provider-error-fixture] incomplete_before_exit', fixturePhase);
});

async function main() {
  const root = realpathSync(process.cwd()), runId = process.env.IMAGE_RECOVERY_GATE_RUN_ID;
  assert.match(runId || '', /^[a-f0-9-]{36}$/i);
  const startedAt = new Date().toISOString(), previousUmask = process.umask(0o077);
  const sourceSha256 = Object.fromEntries(sourcePaths.map(file => [file, sha(readFileSync(path.join(root, file)))]));
  const fixtureSha256 = sha(readFileSync(path.join(root, 'scripts/image-provider-error-engineering.ts')));
  const scratch = path.join(root, '.role-tests'); mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(path.join(scratch, 'image-provider-error-')), databasePath = path.join(directory, 'synthetic.db');
  process.env.DATABASE_URL = `file:${databasePath}`; Reflect.set(process.env, 'NODE_ENV', 'test');
  const require = createRequire(import.meta.url), prismaPackage = require.resolve('prisma/package.json');
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL, PRISMA_GENERATE_SKIP_AUTOINSTALL: '1' };
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) if (process.env[name]) env[name] = process.env[name];
  execFileSync(process.execPath, [path.join(path.dirname(prismaPackage), 'build/index.js'), 'db', 'push', '--skip-generate',
    '--schema', path.join(root, 'prisma/schema.prisma')], { cwd: directory, env, encoding: 'utf8', timeout: 120000 });
  assert.equal(statSync(databasePath).mode & 0o777, 0o600);
  const { PrismaClient } = await import('@prisma/client'); const db = new PrismaClient(); setFixtureDatabase(db);
  process.chdir(directory);
  let forbiddenCalls = 0, completed = false;
  const blocked = () => { forbiddenCalls++; throw new Error('Synthetic fixture network forbidden'); };
  mock.method(globalThis, 'fetch', blocked); mock.method(http, 'request', blocked); mock.method(http, 'get', blocked);
  mock.method(https, 'request', blocked); mock.method(https, 'get', blocked); mock.method(dns, 'lookup', blocked);
  const checks: string[] = [];
  try {
    const diagnostics = await import('../src/lib/image-studio/provider-error-diagnostics');
    const { requestStudioImages, StudioProviderError } = await import('../src/lib/image-studio/provider');
    const evidence = await import('../src/lib/image-studio/provider-error-evidence');
    const delivery = await import('../src/lib/image-studio/delivery');
    type Observation = import('../src/lib/image-studio/provider-error-diagnostics').StudioProviderErrorObservation;
    type Params = Parameters<typeof requestStudioImages>[0];
    const secret = 'SYNTHETIC_PRIVATE_PROMPT_echo_https://private.invalid/token_ABC_base64_AAAA';
    const initial: Params = { baseUrl: 'https://supplier.fixture.invalid', apiKey: 'synthetic-key', provider: 'ai_media_vip',
      protocol: 'openai_images', model: 'gpt-image-2.5-sunburst', prompt: secret, count: 1, images: [], size: '2048x2048',
      ratio: '1:1', ratioContractVersion: 2, quality: 'max', signal: AbortSignal.timeout(30000) };
    const safeError = (reason = 'service_http_429') => ({ reason_code: reason, cause_confirmed: false, error_stage: 'service',
      attempt: 3, image_retry_count: 2, recovery_count: 1, client_dropped: false, code: secret, type: secret, message: secret,
      prompt: secret, url: secret, token: secret, image: secret });
    const run = async (params: Params, replies: Array<() => Response>, callback?: (value: Observation) => Promise<void>) => {
      const observed: Observation[] = [], calls: Array<{ method: string; path: string }> = []; let cursor = 0, error: unknown, result: unknown;
      const fetcher = (async (url: URL | RequestInfo, init?: RequestInit) => {
        const parsed = new URL(String(url)); calls.push({ method: init?.method || 'GET', path: `${parsed.pathname}${parsed.search}` });
        assert.ok(cursor < replies.length, 'No added supplier calls'); return replies[cursor++]();
      }) as typeof fetch;
      try { result = await requestStudioImages({ ...params, onProviderErrorDiagnostics: async value => {
        observed.push(value); await callback?.(value);
      } }, fetcher); } catch (value) { error = value; }
      assert.equal(cursor, replies.length); assert.ok(!JSON.stringify(observed).includes(secret));
      return { observed, calls, error, result };
    };
    const boundedErrorRun = async (label: string, params: Params, replies: Array<() => Response>) => {
      fixturePhase = label;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([run(params, replies), new Promise<never>((_resolve, reject) => {
          watchdog = setTimeout(() => {
            console.error('[image-provider-error-fixture] read_watchdog', label);
            reject(new Error('synthetic_error_read_exceeded_3000ms'));
          }, 3000);
          watchdog.ref();
        })]);
      } finally { if (watchdog) clearTimeout(watchdog); fixturePhase = 'assertions'; }
    };
    for (const status of [400, 429, 500, 503]) {
      const result = await run(initial, [() => Response.json({ status: 'failed', safe_error: safeError(`service_http_${status}`) }, { status })]);
      assert.ok(result.error instanceof StudioProviderError); assert.equal(result.error.code, 'http_error'); assert.equal(result.error.status, status);
      assert.equal(result.error.retryable, false); assert.deepEqual(result.calls.map(call => call.method), ['POST']);
      const observation = result.observed[0]; assert.equal(observation.event.providerReasonCode, `service_http_${status}`);
      assert.equal(observation.event.providerCauseConfirmed, false); assert.equal(observation.event.attempt, 3);
      assert.deepEqual(observation.request, { dispatchObserved: true, endpointKind: 'generations', protocol: 'openai_images',
        model: initial.model, sentModel: initial.model, quality: 'max', size: '2048x2048', ratio: '1:1', n: 1, referenceCount: 0 });
    }
    checks.push('post_errors_preserve_transport_and_safe_serialized_metadata');

    const resumed: Params = { ...initial, prompt: '', images: [], size: undefined, quality: undefined,
      resumeAsync: { taskId: 'synthetic-original-provider-task' }, asyncQueryMode: 'single' };
    for (const status of ['failed', 'uncertain']) {
      const result = await run(resumed, [() => Response.json({ task_id: resumed.resumeAsync!.taskId, status, safe_error: safeError('service_http_503') })]);
      assert.ok(result.error instanceof StudioProviderError); assert.equal(result.error.code, status === 'failed' ? 'async_failed' : 'async_unconfirmed');
      assert.equal(result.observed[0].event.transportHttpStatus, 200); assert.equal(result.observed[0].event.providerStatus, status);
      assert.equal(result.observed[0].event.identityEvidence, 'verified'); assert.equal(result.calls.length, 1);
    }
    const conflict = await run(resumed, [() => Response.json({ task_id: 'other-task', status: 'failed', safe_error: safeError() })]);
    assert.ok(conflict.error instanceof StudioProviderError); assert.equal(conflict.error.code, 'async_task_identity_conflict');
    assert.equal(conflict.observed[0].event.identityEvidence, 'conflict'); assert.equal(conflict.observed[0].event.providerReasonCode, null);
    const missingIdentity = await run(resumed, [() => Response.json({ status: 'failed', safe_error: safeError() })]);
    assert.equal(missingIdentity.observed[0].event.identityEvidence, 'not_independently_verified');
    const pending = await run(resumed, [() => Response.json({ task_id: resumed.resumeAsync!.taskId, status: 'pending' })]);
    assert.equal(pending.observed.length, 0); assert.ok(pending.error instanceof StudioProviderError); assert.equal(pending.error.code, 'async_pending');
    checks.push('summary_failed_uncertain_and_original_identity');

    const notFound = await run(resumed, [() => Response.json({ message: secret }, { status: 404 })]);
    assert.ok(notFound.error instanceof StudioProviderError); assert.equal(notFound.error.code, 'async_query_interrupted'); assert.equal(notFound.error.retryable, true);
    assert.deepEqual(notFound.calls.map(call => call.method), ['GET']);
    const request = notFound.observed[0].request; assert.equal(request.dispatchObserved, false);
    for (const field of ['sentModel', 'quality', 'size', 'ratio', 'n', 'referenceCount'] as const) assert.equal(request[field], null);
    const resultError = await run(resumed, [() => Response.json({ task_id: resumed.resumeAsync!.taskId, status: 'success' }),
      () => Response.json({ task_id: resumed.resumeAsync!.taskId, safe_error: safeError('service_http_503') }, { status: 503 })]);
    assert.ok(resultError.error instanceof StudioProviderError); assert.equal(resultError.error.code, 'async_query_interrupted'); assert.equal(resultError.error.retryable, true);
    assert.deepEqual(resultError.calls.map(call => call.method), ['GET', 'GET']); assert.equal(resultError.observed.at(-1)?.event.phase, 'result');
    const resultHtml = await run(resumed, [() => Response.json({ task_id: resumed.resumeAsync!.taskId, status: 'success' }), () => new Response('<html>synthetic</html>')]);
    assert.ok(resultHtml.error instanceof StudioProviderError); assert.equal(resultHtml.error.code, 'invalid_or_oversize_response');
    checks.push('result_errors_and_resume_never_fabricate_post');

    for (const response of [() => new Response('<html>synthetic</html>', { status: 503 }), () => new Response(null, { status: 503 })]) {
      const result = await run(initial, [response]); assert.ok(result.error instanceof StudioProviderError); assert.equal(result.error.code, 'http_error');
    }
    let canceled = 0;
    const huge = await run(initial, [() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65537)); }, cancel() { canceled++; } }), { status: 503 })]);
    assert.equal(huge.observed[0].event.bodyRead, 'oversize'); assert.equal(canceled, 1);
    const began = Date.now();
    const stalled = await boundedErrorRun('stalled_body', initial, [() => new Response(new ReadableStream({ pull() { return new Promise<void>(() => {}); }, cancel() { canceled++; } }), { status: 503 })]);
    assert.equal(stalled.observed[0].event.bodyRead, 'timeout'); assert.ok(Date.now() - began < 3000); assert.equal(canceled, 2);
    let preAbortedCanceled = 0;
    const preAborted = await boundedErrorRun('pre_aborted_body', { ...initial, signal: AbortSignal.abort() }, [() => new Response(new ReadableStream({
      pull() { return new Promise<void>(() => {}); }, cancel() { preAbortedCanceled++; },
    }), { status: 503 })]);
    assert.ok(preAborted.error instanceof StudioProviderError); assert.equal(preAborted.error.code, 'http_error');
    assert.equal(preAborted.error.status, 503); assert.equal(preAborted.error.retryable, false);
    assert.equal(preAborted.observed[0].event.bodyRead, 'timeout'); assert.equal(preAbortedCanceled, 1);
    const originalAbort = new AbortController(); let forwardedCanceled = 0;
    const forwarded = await boundedErrorRun('original_abort_during_read', { ...initial, signal: originalAbort.signal }, [() => new Response(new ReadableStream({
      pull() { originalAbort.abort(); return new Promise<void>(() => {}); }, cancel() { forwardedCanceled++; },
    }, { highWaterMark: 0 }), { status: 503 })]);
    assert.ok(forwarded.error instanceof StudioProviderError); assert.equal(forwarded.error.code, 'http_error');
    assert.equal(forwarded.observed[0].event.bodyRead, 'timeout'); assert.equal(forwardedCanceled, 1);
    let pendingCancelCalls = 0;
    const pendingCancel = await boundedErrorRun('cancel_never_settles', initial, [() => new Response(new ReadableStream({
      pull() { return new Promise<void>(() => {}); }, cancel() { pendingCancelCalls++; return new Promise<void>(() => {}); },
    }), { status: 503 })]);
    assert.ok(pendingCancel.error instanceof StudioProviderError); assert.equal(pendingCancel.error.code, 'http_error');
    assert.equal(pendingCancel.error.status, 503); assert.equal(pendingCancel.error.retryable, false);
    assert.equal(pendingCancel.observed[0].event.bodyRead, 'timeout'); assert.equal(pendingCancelCalls, 1);
    let teeSourceCanceled = 0;
    const [teeBody, unreadSibling] = new ReadableStream<Uint8Array>({
      pull() { return new Promise<void>(() => {}); }, cancel() { teeSourceCanceled++; },
    }).tee();
    try {
      const tee = await boundedErrorRun('tee_sibling_unfinished', initial, [() => new Response(teeBody, { status: 503 })]);
      assert.ok(tee.error instanceof StudioProviderError); assert.equal(tee.error.code, 'http_error');
      assert.equal(tee.error.status, 503); assert.equal(tee.error.retryable, false);
      assert.equal(tee.observed[0].event.bodyRead, 'timeout'); assert.equal(teeSourceCanceled, 0);
    } finally { void unreadSibling.cancel().catch(() => {}); }
    const lockedResponse = new Response('synthetic', { status: 503 }), heldReader = lockedResponse.body!.getReader();
    try {
      const locked = await boundedErrorRun('body_reader_already_locked', initial, [() => lockedResponse]);
      assert.ok(locked.error instanceof StudioProviderError); assert.equal(locked.error.code, 'http_error');
      assert.equal(locked.observed[0].event.bodyRead, 'read_error');
    } finally { void heldReader.cancel().catch(() => {}); }
    const native: Params = { ...initial, provider: 'musk', protocol: 'gemini_native', model: 'gemini-3-pro-image-preview', size: '2K', quality: 'auto' };
    const nativeError = await run(native, [() => Response.json({ error: { message: secret, code: 429 } }, { status: 429 })]);
    assert.ok(nativeError.error instanceof StudioProviderError); assert.equal(nativeError.error.code, 'http_error');
    const nativeHtml = await run(native, [() => new Response('<html>synthetic</html>', { status: 503 })]);
    assert.ok(nativeHtml.error instanceof StudioProviderError); assert.equal(nativeHtml.error.code, 'invalid_or_oversize_response');
    let nativeObservedBytes: number | null = null;
    const nativeHuge = await run({ ...native, recordResponseEvidence: async observation => { nativeObservedBytes = observation.observation.responseBytes; } },
      [() => new Response(new Uint8Array(1024 * 1024), { status: 503 })]);
    assert.ok(nativeHuge.error instanceof StudioProviderError); assert.equal(nativeHuge.error.code, 'http_error'); assert.equal(nativeObservedBytes, 65536);
    checks.push('bounded_error_body_cancellation_and_native_compatibility');

    const large = await run(initial, [() => Response.json({ data: [{ b64_json: 'A'.repeat(80000) }] })]);
    assert.equal(large.error, undefined); assert.equal((large.result as { images: string[] }).images[0].length, 80000);
    const callbackFailure = await run(initial, [() => Response.json({ safe_error: safeError() }, { status: 429 })], async () => { throw new Error(secret); });
    assert.ok(callbackFailure.error instanceof StudioProviderError); assert.equal(callbackFailure.error.code, 'http_error');
    let requests = 0;
    await assert.rejects(requestStudioImages(initial, (async () => { requests++; return Response.json({ data: [{ url: 'https://image.fixture.invalid/output.png' }] }); }) as typeof fetch,
      async () => { throw new StudioImageDownloadError('download_timeout', 503, true); }), (error: unknown) => {
      assert.ok(error instanceof StudioProviderError); assert.equal(error.code, 'download_timeout'); assert.equal(error.status, 503); assert.equal(error.retryable, true); return true;
    });
    assert.equal(requests, 1);
    const durableFailure = new Error('synthetic original response durability failed');
    const business = await run({ ...initial, recordResponse: async () => { throw durableFailure; } }, [() => new Response('{}', { status: 429 })]);
    assert.equal(business.error, durableFailure);
    checks.push('large_success_download_and_callback_failures_preserve_business');

    const malicious = JSON.parse(JSON.stringify({ status: secret, safe_error: { ...safeError(secret), attempt: 1e100, image_retry_count: {},
      cause_confirmed: secret, error_stage: secret, message: secret.repeat(100) }, extra: secret }));
    Object.defineProperty(malicious, '__proto__', { value: { message: secret }, enumerable: true });
    let accessorCalls = 0; const accessor = {}; Object.defineProperty(accessor, 'message', { get() { accessorCalls++; return secret; } });
    const sanitized = diagnostics.buildStudioProviderErrorEvent({ phase: 'summary', dispatchObserved: false, payload: malicious });
    assert.ok(!JSON.stringify(sanitized).includes(secret)); assert.equal(sanitized.providerReasonCode, null); assert.equal(sanitized.attempt, null);
    assert.equal(sanitized.imageRetryCount, null); assert.equal(sanitized.providerCauseConfirmed, null);
    diagnostics.buildStudioProviderErrorEvent({ phase: 'summary', dispatchObserved: false, payload: { safe_error: accessor } });
    assert.equal(accessorCalls, 0);
    assert.equal(diagnostics.sanitizeStudioProviderErrorRequest({ dispatchObserved: true, sentModel: secret }).sentModel, null);
    assert.equal(diagnostics.sanitizeStudioProviderErrorRequest({ dispatchObserved: true, size: '0.5K' }).size, '0.5K');
    assert.equal(diagnostics.sanitizeStudioProviderErrorFrozen({ expectedSize: '0.5K' }).expectedSize, '0.5K');
    for (const value of ['444:601', '744:1049', '82:111', '677:947', '99998:99999']) {
      assert.equal(diagnostics.sanitizeStudioProviderErrorRequest({ dispatchObserved: true, ratio: value }).ratio, value);
      assert.equal(diagnostics.sanitizeStudioProviderErrorFrozen({ requestedRatio: value }).requestedRatio, value);
    }
    for (const value of ['1:99999', '99999:1', '1:1\nsecret', secret, '100000:100001']) {
      assert.equal(diagnostics.sanitizeStudioProviderErrorRequest({ dispatchObserved: true, ratio: value }).ratio, null);
    }
    checks.push('positive_allowlist_rejects_private_echo_and_malicious_fields');

    const binding = { taskId: 'synthetic-task', ownerId: 'synthetic-owner', fingerprint: sha('synthetic-task'), channelId: 'shared',
      configRevision: randomUUID(), localRequestId: randomUUID(), providerTaskId: 'synthetic-original-provider-task' };
    const frozen = diagnostics.sanitizeStudioProviderErrorFrozen({ model: initial.model, resolution: '2K', requestedRatio: '1:1', resolvedRatio: '1:1', expectedSize: initial.size });
    const firstEvent = diagnostics.buildStudioProviderErrorEvent({ phase: 'summary', dispatchObserved: false, transportHttpStatus: 200,
      payload: { status: 'uncertain', safe_error: safeError() }, observedAt: '2026-10-22T00:00:00.000Z' });
    let aggregate = diagnostics.mergeStudioProviderErrorDiagnostics(null, binding, frozen, { request: notFound.observed[0].request, event: firstEvent });
    for (let index = 0; index < 30; index++) aggregate = diagnostics.mergeStudioProviderErrorDiagnostics(aggregate, binding, frozen,
      { request: notFound.observed[0].request, event: diagnostics.buildStudioProviderErrorEvent({ phase: 'summary', dispatchObserved: false,
        transportHttpStatus: 400 + index, observedAt: `2026-10-22T00:01:${String(index).padStart(2, '0')}.000Z`, localCode: 'async_query_interrupted' }) });
    assert.ok(aggregate.events.some(event => event.providerReasonCode === 'service_http_429'));
    assert.ok(aggregate.events.some(event => event.transportHttpStatus === 429)); assert.equal(aggregate.events.length, 16); assert.equal(aggregate.omittedEvents, 15);
    aggregate = diagnostics.mergeStudioProviderErrorDiagnostics(aggregate, binding, frozen, { request: notFound.observed[0].request, event: firstEvent });
    assert.equal(aggregate.events.find(event => event.providerReasonCode === 'service_http_429')?.occurrences, 2);
    assert.ok(Buffer.byteLength(JSON.stringify(aggregate)) <= 65536); assert.ok(aggregate.events.every(event => Buffer.byteLength(JSON.stringify(event)) <= 4096));
    aggregate.events[0].occurrences = 1_000_000;
    aggregate = diagnostics.mergeStudioProviderErrorDiagnostics(aggregate, binding, frozen, { request: notFound.observed[0].request, event: firstEvent });
    assert.equal(aggregate.events[0].occurrences, 1_000_000);
    checks.push('aggregate_preserves_first_latest_counts_and_limits');

    const task = await db.imageStudioTask.create({ data: { id: binding.taskId, batch_id: 'synthetic-batch', owner_id: binding.ownerId,
      ordinal: 1, fingerprint: binding.fingerprint, prompt: '', context: '', revision: 1, model: initial.model,
      quality: 'max', snapshot_json: JSON.stringify({ requestId: binding.localRequestId, resolution: '2K', resolvedAspectRatio: '1:1',
        imageChannel: { channelId: binding.channelId, configRevision: binding.configRevision } }), aspect_ratio: '1:1', output_size: initial.size,
      reference_ids: '[]', unit_credits: 1, status: 'channel_running', lease_token: 'synthetic-lease', lease_until: new Date(Date.now() + 120000) } });
    await delivery.beginStudioRequest(task); await delivery.createStudioAsyncReceipt(task, { taskId: binding.providerTaskId });
    const originalTask = await db.imageStudioTask.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal((await evidence.readStudioProviderErrorDiagnostics(task.id)).state, 'not_collected');
    await evidence.recordStudioProviderErrorDiagnostics(task, { request: callbackFailure.observed[0].request, event: firstEvent });
    await evidence.recordStudioProviderErrorDiagnostics(task, notFound.observed[0]);
    const read = await evidence.readStudioProviderErrorDiagnostics(task.id); assert.equal(read.state, 'recorded');
    assert.equal(read.diagnostics?.request.referenceCount, 0); assert.equal(read.diagnostics?.request.dispatchObserved, true);
    assert.ok(read.diagnostics?.events.some(event => event.providerReasonCode === 'service_http_429'));
    assert.deepEqual(await db.imageStudioTask.findUniqueOrThrow({ where: { id: task.id } }), originalTask);
    await assert.rejects(evidence.recordStudioProviderErrorDiagnostics({ ...task, owner_id: 'other-owner' }, notFound.observed[0]));
    await assert.rejects(evidence.recordStudioProviderErrorDiagnostics({ ...task, id: 'other-task' }, notFound.observed[0]));
    const key = `image_provider_error_v1:${task.id}`, saved = await db.platformSetting.findUniqueOrThrow({ where: { key } });
    await db.platformSetting.update({ where: { key }, data: { value_json: JSON.stringify({ ...read.diagnostics, binding: { ...binding, ownerId: 'other-owner' } }) } });
    assert.equal((await evidence.readStudioProviderErrorDiagnostics(task.id)).state, 'unavailable');
    await db.platformSetting.update({ where: { key }, data: { value_json: '{invalid' } });
    assert.equal((await evidence.readStudioProviderErrorDiagnostics(task.id)).state, 'unavailable');
    const poisoned = { ...read.diagnostics!, extra: secret, frozen: { ...frozen, model: secret }, request: { ...read.diagnostics!.request, sentModel: secret },
      events: read.diagnostics!.events.map(event => ({ ...event, summary: secret, stack: secret, prompt: secret })) };
    await db.platformSetting.update({ where: { key }, data: { value_json: JSON.stringify(poisoned) } });
    const projected = await evidence.readStudioProviderErrorDiagnostics(task.id); assert.equal(projected.state, 'recorded'); assert.ok(!JSON.stringify(projected).includes(secret));
    await db.platformSetting.update({ where: { key }, data: { value_json: saved.value_json } });
    await db.imageStudioTask.update({ where: { id: task.id }, data: { lease_until: new Date(Date.now() - 1) } });
    await assert.rejects(evidence.recordStudioProviderErrorDiagnostics(task, notFound.observed[0]));
    const fresh = await db.imageStudioTask.update({ where: { id: task.id }, data: { lease_token: 'new-synthetic-lease', lease_until: new Date(Date.now() + 120000) } });
    await assert.rejects(evidence.recordStudioProviderErrorDiagnostics(task, notFound.observed[0]));
    const originalTransaction = db.$transaction.bind(db) as (...args: any[]) => Promise<any>; let casAttempts = 0;
    const casMock = mock.method(db, '$transaction', (async (work: (tx: any) => Promise<unknown>, options: unknown) => originalTransaction(async (tx: any) => work({
      imageStudioTask: tx.imageStudioTask, platformSetting: { findUnique: tx.platformSetting.findUnique.bind(tx.platformSetting),
        create: tx.platformSetting.create.bind(tx.platformSetting), updateMany: async (args: unknown) => {
          casAttempts++; return casAttempts === 1 ? { count: 0 } : tx.platformSetting.updateMany(args);
        } },
    }), options)) as typeof db.$transaction);
    await evidence.recordStudioProviderErrorDiagnostics(fresh, notFound.observed[0]); assert.equal(casAttempts, 2); casMock.mock.restore();
    // Independent real SQLite CAS rejects an update prepared against an older concurrent value.
    const stale = await db.platformSetting.findUniqueOrThrow({ where: { key } });
    await evidence.recordStudioProviderErrorDiagnostics(fresh, { request: notFound.observed[0].request, event: firstEvent });
    assert.equal((await db.platformSetting.updateMany({ where: { id: stale.id, value_json: stale.value_json }, data: { value_json: stale.value_json } })).count, 0);
    assert.equal((await evidence.readStudioProviderErrorDiagnostics(task.id)).state, 'recorded');
    checks.push('sqlite_binding_lease_cas_and_read_projection');

    const warnings: string[] = [], warnMock = mock.method(console, 'warn', (...values: unknown[]) => { warnings.push(values.map(value => String(value)).join(' ')); });
    const writeMock = mock.method(db, '$transaction', (async () => { throw new Error(secret); }) as typeof db.$transaction);
    const failure = await run(initial, [() => Response.json({ safe_error: safeError() }, { status: 429 })], evidence.createStudioProviderErrorRecorder(fresh));
    assert.ok(failure.error instanceof StudioProviderError); assert.equal(failure.error.code, 'http_error'); assert.equal(failure.error.retryable, false);
    assert.ok(warnings.some(value => value.includes('capture_unavailable') && value.includes(task.id))); assert.ok(!warnings.join('').includes(secret));
    writeMock.mock.restore(); warnMock.mock.restore();
    assert.equal(await db.creditLedger.count(), 0); assert.equal(await db.costLedger.count(), 0);
    checks.push('diagnostic_write_failure_isolated_from_original_business');

    const workerSource = readFileSync(path.join(root, 'src/lib/image-studio/worker.ts'), 'utf8');
    assert.equal((workerSource.match(/onProviderErrorDiagnostics: providerDiagnostics\.observe/g) || []).length, 3);
    assert.equal((workerSource.match(/providerDiagnostics\.local\('validation'/g) || []).length, 2);
    assert.equal((workerSource.match(/observedValidation = value/g) || []).length, 2);
    const validationEvent = diagnostics.buildStudioProviderErrorEvent({ phase: 'validation', dispatchObserved: false,
      localCode: 'generated_dimensions_mismatch', expectedSize: '1856x2464', actualWidth: 1536, actualHeight: 2048 });
    await evidence.recordStudioProviderErrorDiagnostics(fresh, { request: notFound.observed[0].request, event: validationEvent });
    const dimensions = (await evidence.readStudioProviderErrorDiagnostics(fresh.id)).diagnostics!.events.find(event => event.phase === 'validation');
    assert.deepEqual([dimensions?.expectedSize, dimensions?.actualWidth, dimensions?.actualHeight], ['1856x2464', 1536, 2048]);
    checks.push('three_worker_generate_paths_and_local_validation_bound');

    assert.deepEqual(checks, expectedChecks); assert.equal(forbiddenCalls, 0);
    for (const [file, digest] of Object.entries(sourceSha256)) assert.equal(sha(readFileSync(path.join(root, file))), digest);
    completed = true;
    const receipt = path.join(directory, 'receipt.json');
    writeFileSync(receipt, JSON.stringify({ schema: 'image-provider-error-engineering.v1', synthetic: true, completed, runId,
      startedAt, finishedAt: new Date().toISOString(), fixtureSha256, sourceSha256, checks,
      forbiddenCalls, productionWrites: 0, paidRequests: 0, browserRuns: 0,
      scope: 'Synthetic provider replies and isolated SQLite only; no real supplier or browser acceptance.' }, null, 2), { mode: 0o600 });
    console.log(`Image provider error engineering receipt: ${receipt}`);
  } finally {
    fixturePhase = 'disconnect';
    await db.$disconnect(); mock.restoreAll(); process.chdir(root); process.umask(previousUmask);
    // Retain the private synthetic receipt for the build gate; no production files are removed.
    await fs.access(directory);
  }
}
void main().then(() => { fixtureSettled = true; process.exitCode = 0; }).catch(error => {
  fixtureSettled = true;
  const locations = error instanceof Error ? (error.stack || '').split('\n').filter(line => /^\s+at\s/.test(line)).slice(0, 4) : [];
  console.error('Image provider error engineering failed', locations); process.exitCode = 1;
});
