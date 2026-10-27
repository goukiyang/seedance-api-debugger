import { setFixtureDatabase } from './fixtures/database-client';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import http, { type IncomingMessage } from 'node:http';
import https, { type RequestOptions } from 'node:https';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { mock } from 'node:test';
import sharp from '../src/lib/media/sharp';
import type { ImageStudioTask } from '@prisma/client';
import type { StudioPollDiagnostics } from '../src/lib/image-studio/provider';

// An unresolved Promise does not keep Node alive. Early event-loop exhaustion is failure.
process.exitCode = 1;

/** Offline recovery/lease evidence only; never accepts a database or provider from the caller. */
async function main() {
  const startedAt = new Date().toISOString();
  const root = realpathSync(process.cwd());
  const runId = process.env.IMAGE_RECOVERY_GATE_RUN_ID;
  assert.ok(runId && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(runId),
    'IMAGE_RECOVERY_GATE_RUN_ID must identify this run with a UUID');
  // Captured only by this synthetic fixture's private gate log; no response text or credentials.
  const markPhase = (phase: string, syntheticCase?: string) => console.error('[image-recovery-fixture-phase]',
    JSON.stringify({ synthetic: true, phase, syntheticCase, at: new Date().toISOString() }));
  const fixturePath = path.join(root, 'scripts/image-studio-recovery-fairness-engineering.ts');
  const workerPath = path.join(root, 'src/lib/image-studio/worker.ts');
  const providerPath = path.join(root, 'src/lib/image-studio/provider.ts');
  const sourceSha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
  const fixtureSha256 = sourceSha256(fixturePath), workerSha256 = sourceSha256(workerPath), providerSha256 = sourceSha256(providerPath);
  const scratch = path.join(root, '.role-tests');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(path.join(scratch, 'image-recovery-fairness-'));
  const databasePath = path.join(directory, 'synthetic.db');
  assert.ok(realpathSync(directory).startsWith(realpathSync(scratch) + path.sep));
  assert.equal(Reflect.get(globalThis, 'prisma'), undefined, 'Start in a fresh process before importing application modules');
  process.env.DATABASE_URL = `file:${databasePath}`;
  Object.assign(process.env, { NODE_ENV: 'test' });
  Reflect.set(globalThis, 'AsyncLocalStorage', AsyncLocalStorage);
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) if (process.env[key]) env[key] = process.env[key]!;
  Object.assign(env, { DATABASE_URL: process.env.DATABASE_URL, PRISMA_GENERATE_SKIP_AUTOINSTALL: '1', NEXT_TELEMETRY_DISABLED: '1' });
  markPhase('isolated_schema_start');
  const schemaLog = execFileSync(process.execPath, [path.join(root, 'node_modules/prisma/build/index.js'), 'db', 'push',
    '--skip-generate', '--schema', path.join(root, 'prisma/schema.prisma')], { cwd: directory, env, encoding: 'utf8', timeout: 120000 });
  writeFileSync(path.join(directory, 'schema.log'), schemaLog, { mode: 0o600 });
  markPhase('isolated_schema_complete');

  const { PrismaClient } = await import('@prisma/client');
  const database = new PrismaClient();
  const selected: string[] = [];
  let competeFor: string | null = null;
  // Observe the real SQLite query and, in one case, acquire a competing lease
  // after selection but before the production updateMany CAS. No worker hook.
  const observedDatabase = database.$extends({ query: { imageStudioTask: {
    async findMany({ args, query }) {
      const rows = await query(args);
      if (args.take === 1 && args.where?.lease_until) {
        for (const row of rows) {
          assert.ok(typeof row.id === 'string', 'Recovery selection must return a task ID');
          selected.push(row.id);
        }
        if (competeFor && rows[0]?.id === competeFor) {
          const id = competeFor; competeFor = null;
          await database.imageStudioTask.update({ where: { id }, data: {
            lease_token: 'synthetic-competing-worker', lease_until: new Date(Date.now() + 600_000),
          } });
        }
      }
      return rows;
    },
  } } });
  setFixtureDatabase(observedDatabase);
  const originalCwd = process.cwd();
  process.chdir(directory);
  const checks: string[] = [];
  const queries: Array<{ providerTaskId: string; view: 'summary' | 'result' }> = [];
  const outputs = new Map<string, Buffer>();
  const interrupted = new Set(['provider-old-a', 'provider-old-b']);
  const pendingIoTimers = new Set<NodeJS.Timeout>();
  const pendingIoFailures: string[] = [];
  let forbiddenCalls = 0;
  let completed = false;
  const blocked = () => { forbiddenCalls++; throw new Error('Real network and generation are prohibited in recovery engineering'); };
  mock.method(globalThis, 'fetch', blocked);
  mock.method(http, 'request', blocked);
  mock.method(http, 'get', blocked);
  mock.method(https, 'get', blocked);
  mock.method(dns, 'lookup', async (hostname: string) => {
    assert.equal(hostname, 'recovery-fixture.invalid');
    return [{ address: '1.1.1.1', family: 4 }];
  });
  // Keep the production two-second first poll. Only shorten the sixty-second
  // query window; lease ageing below separately models its elapsed wall time.
  const realAbortTimeout = AbortSignal.timeout;
  mock.method(AbortSignal, 'timeout', (ms: number) => realAbortTimeout(ms === 60_000 ? 3000 : ms));
  mock.method(https, 'request', (url: URL, options: RequestOptions, onResponse: (response: IncomingMessage) => void) => {
    if (options.method !== 'GET' || url.hostname !== 'recovery-fixture.invalid') return blocked();
    const match = /^\/v1\/images\/tasks\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
    assert.ok(match, 'Recovery may only query a stored provider task');
    const providerTaskId = match[1];
    assert.ok(interrupted.has(providerTaskId) || outputs.has(providerTaskId));
    assert.equal((options.headers as Record<string, string>).authorization, 'Bearer synthetic-not-a-credential');
    assert.ok(url.search === '?view=summary' || url.search === '');
    const signal = options.signal; assert.ok(signal);
    const request = new EventEmitter() as EventEmitter & { end: () => void };
    let abort: (() => void) | undefined;
    // A real socket is referenced while pending; this fake request needs the same liveness.
    // The bounded timer also fails the fixture if its original-query abort never arrives.
    const pendingIo = setTimeout(() => {
      pendingIoFailures.push(providerTaskId);
      request.emit('error', Object.assign(new Error('Synthetic pending HTTPS exceeded ten seconds'), { code: 'FIXTURE_PENDING_IO_TIMEOUT' }));
    }, 10_000);
    pendingIo.ref();
    pendingIoTimers.add(pendingIo);
    const cleanup = () => {
      clearTimeout(pendingIo); pendingIoTimers.delete(pendingIo);
      if (abort) signal.removeEventListener('abort', abort);
    };
    request.once('error', cleanup);
    request.end = () => queueMicrotask(() => {
      queries.push({ providerTaskId, view: url.search ? 'summary' : 'result' });
      if (interrupted.has(providerTaskId)) {
        abort = () => { request.emit('error', Object.assign(new Error('Synthetic original-query interruption'), { code: 'ABORT_ERR' })); };
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
        return;
      }
      const response = new PassThrough() as PassThrough & { statusCode: number; headers: Record<string, string> };
      response.statusCode = 200; response.headers = { 'content-type': 'application/json' };
      response.once('end', cleanup); response.once('close', cleanup); response.once('error', cleanup);
      onResponse(response as unknown as IncomingMessage);
      response.end(JSON.stringify(url.search ? { task_id: providerTaskId, status: 'success', assets: [] }
        : { data: [{ b64_json: outputs.get(providerTaskId)!.toString('base64') }] }));
    });
    return request;
  });

  try {
    const { prisma } = await import('../src/lib/prisma');
    assert.equal(prisma, observedDatabase, 'Production recovery must use only the fresh isolated SQLite client');
    const { recoverStudioTasks } = await import('../src/lib/image-studio/worker');
    const { finishStudioTask } = await import('../src/lib/image-studio/tasks');
    const delivery = await import('../src/lib/image-studio/delivery');
    assert.equal(await database.imageStudioTask.count(), 0);
    assert.equal(await database.user.count(), 0);
    const owner = 'recovery-fixture-owner', model = 'gpt-image-2.5-sunburst';
    const channelId = `image-${randomUUID()}`, configRevision = randomUUID();
    await database.user.create({ data: { id: owner, name: 'Synthetic recovery owner', username: owner,
      email: `${owner}@isolated.invalid`, password_hash: 'synthetic-not-a-login' } });
    await database.creditAccount.create({ data: { user_id: owner, balance: 93, frozen_credits: 7 } });
    await database.platformSetting.create({ data: { key: `image_generation_channel_version_v1:${channelId}:${configRevision}`,
      value_json: JSON.stringify({ version: 1, channelId, configRevision, label: 'Isolated channel', supplierName: 'Isolated fixture',
        supplierKind: 'other', protocol: 'openai_images', managedChannel: true,
        settings: { provider: 'managed', enabled: true, base_url: 'https://recovery-fixture.invalid', api_key: 'synthetic-not-a-credential', default_model: model },
        modelCapabilities: { [model]: { enabled: true, protocol: 'openai_images', billingMode: 'fixed', fixedPoints: 1,
          qualities: null, resolutions: null, ratios: null, maxReferences: null } } }) } });
    const createdBase = Date.now() - 3 * 86400_000;
    const leaseBase = Date.now() - 600_000;
    const frozen = (row: ImageStudioTask) => ({ id: row.id, owner: row.owner_id, model: row.model, prompt: row.prompt,
      context: row.context, fingerprint: row.fingerprint, snapshot: row.snapshot_json, references: row.reference_ids,
      credits: row.unit_credits, freeze: row.freeze_snapshot, scope: row.billing_scope, contract: row.billing_contract_json });
    const makeTask = async (id: string, createdAt: number, leaseUntil: number, color: number) => {
      markPhase('synthetic_task_create_start', id);
      const task = await database.imageStudioTask.create({ data: { id, owner_id: owner, batch_id: id, ordinal: 1,
        fingerprint: `frozen-${id}`, prompt: 'Synthetic frozen prompt', context: 'Synthetic frozen context', revision: 1,
        model, reference_ids: '[]', unit_credits: 1, freeze_snapshot: JSON.stringify([{ source_type: 'balance', amount: 1 }]),
        billing_mode: 'fixed', billing_status: 'channel_unmatched', status: 'channel_running',
        snapshot_json: JSON.stringify({ imageChannel: { channelId, configRevision } }), error: 'Original query retained',
        created_at: new Date(createdAt), lease_until: new Date(leaseUntil), lease_token: `dead-worker-${id}` } });
      markPhase('synthetic_task_row_created', id);
      await database.creditHold.create({ data: { business_type: 'image', business_id: id, payer_type: 'user', payer_id: owner,
        operator_id: owner, amount: task.unit_credits, freeze_snapshot: task.freeze_snapshot || '[]', opening_receipt: '{}' } });
      const providerTaskId = `provider-${id}`;
      markPhase('synthetic_async_receipt_start', id);
      await delivery.createStudioAsyncReceipt(task, { taskId: providerTaskId, pollAfterMs: 2000 });
      markPhase('synthetic_async_receipt_complete', id);
      if (!interrupted.has(providerTaskId)) outputs.set(providerTaskId,
        await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: color, g: 90, b: 120 } } }).png().toBuffer());
      markPhase('synthetic_task_prepared', id);
      return task;
    };
    const ids = ['old-a', 'old-b', 'new-a', 'new-b', 'new-c', 'new-d', 'new-e'];
    const originals: ImageStudioTask[] = [];
    for (let i = 0; i < ids.length; i++) originals.push(await makeTask(ids[i], createdBase + i * 1000, leaseBase + i * 1000, 20 + i));
    // Equivalent elapsed-time fixture only: subtract the same minute from every
    // active lease. Relative priority is unchanged, but a just-retained old task
    // is expired again, reproducing the real sixty-second-query/30s-delay trap.
    const ageActiveLeases = async () => {
      const rows = await database.imageStudioTask.findMany({ where: { status: { in: ['running', 'channel_running'] }, lease_until: { not: null } } });
      for (const row of rows) await database.imageStudioTask.update({ where: { id: row.id }, data: { lease_until: new Date(row.lease_until!.getTime() - 60_000) } });
    };
    for (let i = 0; i < ids.length; i++) {
      if (i) await ageActiveLeases();
      if (i === 2) {
        const historical = await database.imageStudioTask.findFirst({ where: { status: 'channel_running', lease_until: { lt: new Date() } }, orderBy: { created_at: 'asc' } });
        assert.equal(historical?.id, 'old-a', 'Creation-first selection would repeat an old task before the five untouched tasks');
        checks.push('isolated_creation_first_counterexample_repeats_old_task_after_two_slow_queries');
      }
      markPhase('original_recovery_start', ids[i]);
      await recoverStudioTasks();
      markPhase('original_recovery_complete', ids[i]);
      assert.deepEqual(pendingIoFailures, [], 'Synthetic pending HTTPS must settle within ten seconds');
      assert.equal(selected[selected.length - 1], ids[i]);
      assert.equal(selected.length, i + 1, 'Each production recovery still selects at most one task');
      const row = await database.imageStudioTask.findUniqueOrThrow({ where: { id: ids[i] } });
      assert.deepEqual(frozen(row), frozen(originals[i]));
      if (i < 2) {
        assert.equal(row.status, 'channel_running'); assert.equal(row.asset_id, null);
        assert.equal(row.billing_status, 'channel_unmatched'); assert.equal(row.finished_at, null);
        assert.notEqual(row.lease_token, originals[i].lease_token);
        assert.ok(row.lease_until!.getTime() > Date.now());
        assert.equal((await delivery.readStudioAsyncReceipt(row))?.providerTaskId, `provider-${ids[i]}`);
        assert.equal(await database.creditLedger.count(), 0, 'Interrupted original queries do not release or settle frozen credits');
        assert.equal((await database.creditAccount.findUniqueOrThrow({ where: { user_id: owner } })).frozen_credits, 7);
      } else {
        assert.equal(row.status, 'succeeded'); assert.ok(row.asset_id); assert.equal(row.error, null);
        const asset = await database.asset.findUniqueOrThrow({ where: { id: row.asset_id! } });
        assert.equal(asset.owner_id, owner); assert.equal(asset.status, 'active'); assert.equal(asset.mime_type, 'image/png');
        assert.equal((await sharp(readFileSync(path.join(directory, '.media', asset.original_url))).metadata()).width, 16);
        assert.equal(await finishStudioTask(originals[i], 'uncertain'), false, 'A stale original lease cannot undo the delivered result');
      }
    }
    assert.deepEqual(selected, ids);
    for (const id of ids.slice(2)) assert.deepEqual(queries.filter(query => query.providerTaskId === `provider-${id}`).map(query => query.view), ['summary', 'result']);
    assert.equal(await database.creditLedger.count({ where: { type: 'task_success_deduct' } }), 5);
    assert.equal((await database.creditAccount.findUniqueOrThrow({ where: { user_id: owner } })).frozen_credits, 2);
    checks.push('real_recovery_rotates_seven_expired_leases_preserves_unknowns_then_original_get_decodes_publishes_and_settles_once');

    // Isolate tie/CAS cases without making the two unknown originals terminal.
    await database.imageStudioTask.updateMany({ where: { id: { in: ids.slice(0, 2) } }, data: { lease_until: new Date(Date.now() + 600_000) } });
    await database.creditAccount.update({ where: { user_id: owner }, data: { frozen_credits: { increment: 5 } } });
    const tieLease = Date.now() - 10_000;
    await makeTask('tie-z', createdBase, tieLease, 60);
    await makeTask('tie-b', createdBase + 1000, tieLease, 61);
    await makeTask('tie-a', createdBase + 1000, tieLease, 62);
    const live = await makeTask('live', createdBase - 1000, Date.now() + 600_000, 63);
    for (const expected of ['tie-z', 'tie-a', 'tie-b']) {
      markPhase('tie_recovery_start', expected);
      await recoverStudioTasks(); assert.equal(selected[selected.length - 1], expected);
      markPhase('tie_recovery_complete', expected);
      assert.deepEqual(pendingIoFailures, [], 'Synthetic pending HTTPS must settle within ten seconds');
    }
    const liveAfter = await database.imageStudioTask.findUniqueOrThrow({ where: { id: live.id } });
    assert.equal(liveAfter.lease_token, live.lease_token); assert.deepEqual(frozen(liveAfter), frozen(live));
    assert.equal(queries.some(query => query.providerTaskId === 'provider-live'), false);
    checks.push('equal_expired_deadline_orders_created_at_then_id_and_does_not_claim_live_lease');

    const race = await makeTask('race', createdBase, Date.now() - 10_000, 64);
    competeFor = race.id;
    const beforeQueries = queries.length;
    markPhase('competing_recovery_start', race.id);
    await recoverStudioTasks();
    markPhase('competing_recovery_complete', race.id);
    const competed = await database.imageStudioTask.findUniqueOrThrow({ where: { id: race.id } });
    assert.equal(competed.lease_token, 'synthetic-competing-worker'); assert.equal(competed.status, 'channel_running');
    assert.deepEqual(frozen(competed), frozen(race)); assert.equal(queries.length, beforeQueries);
    assert.equal(await finishStudioTask(race, 'uncertain'), false);
    const beforeIdle = selected.length;
    markPhase('idle_recovery_start');
    await recoverStudioTasks();
    markPhase('idle_recovery_complete');
    assert.equal(selected.length, beforeIdle); assert.equal(queries.length, beforeQueries);
    assert.equal(forbiddenCalls, 0);
    assert.equal(await database.creditLedger.count({ where: { type: 'task_success_deduct' } }), 8);
    assert.equal((await database.creditAccount.findUniqueOrThrow({ where: { user_id: owner } })).frozen_credits, 4);
    checks.push('real_sqlite_competing_claim_loses_cas_without_query_refund_repost_or_duplicate_settlement');
    markPhase('original_recovery_assertions_complete');

    // Exercise the real original-task poll with only an in-memory read-only transport.
    // These facts do not prove an HTTP request was sent or diagnose DNS/TCP/TLS.
    const { requestStudioImages, StudioProviderError } = await import('../src/lib/image-studio/provider');
    const pollTaskId = 'provider-old-a';
    const sensitive = 'https://private.invalid/original?token=synthetic-sensitive BODY-synthetic-sensitive';
    const noPoll: StudioPollDiagnostics = { scope: 'original_task_poll_window', phaseAtStop: 'waiting', lastAttemptPhase: null,
      getTransportCalls: 0, lastHttpStatus: null, lastProviderStatus: null, lastErrorCategory: null };
    const pollFailure = async (reply: () => Response, code: string, expected: StudioPollDiagnostics, signal = new AbortController().signal) => {
      const syntheticCase = `${code}:${expected.lastErrorCategory || expected.lastProviderStatus || 'none'}`;
      markPhase('poll_diagnostic_start', syntheticCase);
      let transportCalls = 0;
      const readOnlyTransport: typeof fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        assert.equal(init?.method, 'GET', 'Original-task diagnostics must never submit a generation POST');
        assert.equal(url.origin, 'https://recovery-fixture.invalid');
        assert.equal(url.pathname, `/v1/images/tasks/${pollTaskId}`);
        assert.equal(url.search, '?view=summary');
        transportCalls++;
        return reply();
      };
      await assert.rejects(() => requestStudioImages({ baseUrl: 'https://recovery-fixture.invalid', apiKey: 'synthetic-not-a-credential',
        model, protocol: 'openai_images', prompt: '', count: 1, images: [], signal,
        resumeAsync: { taskId: pollTaskId, pollAfterMs: 2000 } }, readOnlyTransport), error => {
        assert.ok(error instanceof StudioProviderError);
        assert.equal(error.stage, 'response'); assert.equal(error.code, code); assert.equal(error.retryable, true);
        assert.equal(error.status, undefined, 'Window diagnostics do not replace the existing business status');
        assert.ok(error.poll);
        assert.deepEqual(Object.keys(error.poll).sort(), Object.keys(noPoll).sort(), 'Poll diagnostics have a fixed private shape');
        assert.deepEqual(error.poll, expected);
        assert.equal(error.poll.getTransportCalls, transportCalls, 'Count only calls actually made to the supplied transport');
        const serialized = JSON.stringify(error.poll);
        for (const secret of [sensitive, 'private.invalid', 'synthetic-sensitive', 'BODY-', 'synthetic-not-a-credential']) {
          assert.equal(serialized.includes(secret), false, 'Poll diagnostics must not contain raw transport text, URLs or credentials');
        }
        return true;
      });
      assert.equal(transportCalls, expected.getTransportCalls);
      markPhase('poll_diagnostic_complete', syntheticCase);
    };
    const alreadyAborted = new AbortController(); alreadyAborted.abort();
    await pollFailure(() => { assert.fail('An already-aborted original query must make zero transport calls'); },
      'async_query_interrupted', noPoll, alreadyAborted.signal);
    await pollFailure(() => { throw new Error(sensitive); }, 'async_query_interrupted',
      { ...noPoll, getTransportCalls: 1, lastAttemptPhase: 'summary_request', lastErrorCategory: 'transport_or_abort' });
    await pollFailure(() => new Response(sensitive, { status: 503 }), 'async_query_interrupted',
      { ...noPoll, getTransportCalls: 1, lastAttemptPhase: 'summary_request', lastHttpStatus: 503, lastErrorCategory: 'http_non_success' });
    await pollFailure(() => new Response(JSON.stringify({ task_id: pollTaskId, status: sensitive, message: sensitive }), { status: 200 }),
      'async_query_unconfirmed', { ...noPoll, getTransportCalls: 1, lastAttemptPhase: 'summary_body', lastHttpStatus: 200 });
    await pollFailure(() => new Response(JSON.stringify({ task_id: pollTaskId, status: 'pending', message: sensitive }), { status: 200 }),
      'async_pending', { ...noPoll, getTransportCalls: 1, lastAttemptPhase: 'summary_body', lastHttpStatus: 200, lastProviderStatus: 'pending' });
    await pollFailure(() => new Response(`invalid JSON ${sensitive}`, { status: 200 }), 'async_query_interrupted',
      { ...noPoll, getTransportCalls: 1, lastAttemptPhase: 'summary_body', lastHttpStatus: 200, lastErrorCategory: 'invalid_or_oversize_response' });
    checks.push('original_poll_diagnostics_are_bounded_factual_and_private');
    assert.equal(checks.length, 5);
    assert.equal(selected.length, 11);
    assert.equal(queries.length, 18);
    assert.equal(forbiddenCalls, 0);
    assert.deepEqual(pendingIoFailures, [], 'Synthetic pending HTTPS must settle within ten seconds');
    assert.equal(pendingIoTimers.size, 0, 'All synthetic HTTPS I/O must finish before success');
    assert.equal(sourceSha256(fixturePath), fixtureSha256, 'Fixture source must remain unchanged throughout this run');
    assert.equal(sourceSha256(workerPath), workerSha256, 'Worker source must remain unchanged throughout this run');
    assert.equal(sourceSha256(providerPath), providerSha256, 'Provider source must remain unchanged throughout this run');
    completed = true;
  } finally {
    markPhase('cleanup_start');
    for (const timer of Array.from(pendingIoTimers)) clearTimeout(timer);
    pendingIoTimers.clear();
    mock.restoreAll();
    await database.$disconnect();
    process.chdir(originalCwd);
    markPhase('cleanup_complete');
    const receipt = path.join(directory, 'receipt.json');
    const finishedAt = new Date().toISOString();
    markPhase('receipt_write_start');
    writeFileSync(receipt, JSON.stringify({ schema: 'image-recovery-fairness-engineering.v1', runId, fixtureSha256, workerSha256, providerSha256,
      startedAt, finishedAt, synthetic: true, databasePath,
      checks, selected, queries, forbiddenCalls, completed, productionWrites: 0, paidRequests: 0, browserRuns: 0,
      scope: 'Real recovery selection/CAS and local PNG delivery against fresh SQLite, simulated original-task HTTP only; not real image-generation acceptance.' }, null, 2), { mode: 0o600 });
    markPhase('receipt_write_complete');
    console.log(`Image recovery fairness engineering receipt: ${receipt}`);
  }
}

void main().then(() => { process.exitCode = 0; }).catch(error => { console.error(error); process.exitCode = 1; });
