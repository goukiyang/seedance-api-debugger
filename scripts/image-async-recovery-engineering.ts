import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import http, { type IncomingMessage } from 'node:http';
import https, { type RequestOptions } from 'node:https';
import { createRequire } from 'node:module';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { mock } from 'node:test';
import sharp from 'sharp';
import type { ImageStudioTask } from '@prisma/client';

process.exitCode = 1;
const markPhase = (phase: string, syntheticCase?: string) => console.error('[image-async-recovery-fixture-phase]',
  JSON.stringify({ synthetic: true, phase, syntheticCase, at: new Date().toISOString() }));
// Keep unresolved asynchronous setup alive, but never let a stalled fixture report success.
const fixtureDeadline = setTimeout(() => { markPhase('fixture_180s_timeout'); process.exit(1); }, 180000);
fixtureDeadline.ref();
const sourcePaths = ['src/lib/image-studio/worker.ts', 'src/lib/image-studio/provider.ts', 'src/lib/image-studio/tasks.ts',
  'src/lib/image-studio/async-recovery.ts', 'src/lib/image-studio/delivery.ts', 'src/lib/image-studio/queue-capacity.ts',
  'src/lib/image-studio/synchronous-admission.ts', 'src/app/api/image-studio/tasks/route.ts'];
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const expectedChecks = ['explicit_provider_states_release_without_refund', 'owner_shared_capacity_includes_synchronous_running',
  'expiry_timeout_and_non_summary_404_do_not_release', 'two_independent_original_summary_404_observations',
  'original_get_delivers_once_preserving_frozen_identity', 'durable_claim_cas_restart_and_bounded_fair_scan',
  'manual_once_after_auto_budget_keeps_limits', 'legacy_identity_and_partial_checkpoint_fail_closed'];
type SyntheticRecord = { state: string; attempts: number; releasedAt: number; deadlineAt: number; nextCheckAt: number;
  lastRequestedAt: number; leaseToken: string | null; leaseUntil: number | null; manualOnce: boolean; manualChecks: number;
  stopCode?: string; [key: string]: unknown };

/** Actual SQLite/worker/provider/settlement, with only supplier transport and elapsed time simulated. */
async function main() {
  const root = realpathSync(process.cwd()), startedAt = new Date().toISOString();
  const baseline = process.argv.includes('--baseline'), runId = process.env.IMAGE_RECOVERY_GATE_RUN_ID;
  assert.ok(runId && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(runId), 'A gate UUID is required');
  const sourceSha256 = Object.fromEntries(sourcePaths.filter(file => !baseline || existsSync(path.join(root, file)))
    .map(file => [file, sha(readFileSync(path.join(root, file)))]));
  const fixtureSha256 = sha(readFileSync(path.join(root, 'scripts/image-async-recovery-engineering.ts')));
  const previousUmask = process.umask(0o077);
  const scratch = path.join(root, '.role-tests'); mkdirSync(scratch, { recursive: true, mode: 0o700 });
  assert.ok(lstatSync(scratch).isDirectory() && !lstatSync(scratch).isSymbolicLink());
  const directory = mkdtempSync(path.join(scratch, 'image-async-recovery-')), databasePath = path.join(directory, 'synthetic.db');
  assert.ok(realpathSync(directory).startsWith(realpathSync(scratch) + path.sep));
  assert.equal(Reflect.get(globalThis, 'prisma'), undefined);
  process.env.DATABASE_URL = `file:${databasePath}`; Object.assign(process.env, { NODE_ENV: 'test' });
  Reflect.set(globalThis, 'AsyncLocalStorage', AsyncLocalStorage);
  const require = createRequire(import.meta.url), prismaPackage = require.resolve('prisma/package.json');
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL, PRISMA_GENERATE_SKIP_AUTOINSTALL: '1' };
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) if (process.env[name]) env[name] = process.env[name];
  markPhase('isolated_schema_start');
  const schemaLog = execFileSync(process.execPath, [path.join(path.dirname(prismaPackage), 'build/index.js'), 'db', 'push',
    '--skip-generate', '--schema', path.join(root, 'prisma/schema.prisma')], { cwd: directory, env, encoding: 'utf8', timeout: 120000 });
  writeFileSync(path.join(directory, 'schema.log'), schemaLog, { mode: 0o600 });
  markPhase('isolated_schema_complete');
  assert.equal(statSync(databasePath).mode & 0o777, 0o600);
  const { PrismaClient } = await import('@prisma/client'); const db = new PrismaClient();
  let competeKey: string | null = null;
  const observed = db.$extends({ query: { platformSetting: { async findMany({ args, query }) {
    const rows = await query(args);
    if (competeKey) for (const row of rows) if (typeof row.key === 'string' && row.key === competeKey && typeof row.value_json === 'string') {
      competeKey = null;
      await db.platformSetting.update({ where: { key: row.key }, data: { value_json: JSON.stringify({ ...JSON.parse(row.value_json), lastRequestedAt: Date.now() + 1 }) } });
    }
    return rows;
  } } } });
  Reflect.set(globalThis, 'prisma', observed);
  process.chdir(directory);
  const checks: string[] = [], queries: Array<{ id: string; path: string }> = [];
  const recordCheck = (name: string) => { checks.push(name); markPhase('check_complete', name); };
  const statuses = new Map<string, string>(), png = await sharp({ create: { width: 16, height: 16, channels: 3,
    background: { r: 41, g: 93, b: 120 } } }).png().toBuffer();
  let forbiddenCalls = 0, completed = false, clock = Date.now();
  const timers = new Set<NodeJS.Timeout>();
  const pendingIoFailures: string[] = [];
  const blocked = () => { forbiddenCalls++; throw new Error('External network/generation prohibited'); };
  mock.method(globalThis, 'fetch', blocked); mock.method(http, 'request', blocked); mock.method(http, 'get', blocked); mock.method(https, 'get', blocked);
  mock.method(dns, 'lookup', async (hostname: string) => { if (hostname !== 'async-fixture.invalid') return blocked(); return [{ address: '1.1.1.1', family: 4 }]; });
  const timeout = AbortSignal.timeout;
  mock.method(AbortSignal, 'timeout', (ms: number) => timeout(ms === 60000 ? 3000 : ms));
  mock.method(Date, 'now', () => clock);
  mock.method(https, 'request', (url: URL, options: RequestOptions, onResponse: (response: IncomingMessage) => void) => {
    if (url.hostname !== 'async-fixture.invalid' || options.method !== 'GET') return blocked();
    const match = /^\/v1\/images\/tasks\/(provider-[a-zA-Z0-9-]+)$/.exec(url.pathname); assert.ok(match);
    const id = match[1], status = statuses.get(id); assert.ok(status, 'Only a fixture original ID is allowed');
    assert.ok(url.search === '?view=summary' || url.search === '');
    assert.equal(new Headers(options.headers as Record<string, string>).get('authorization'), 'Bearer synthetic-not-a-credential');
    const request = new EventEmitter() as EventEmitter & { end: () => void }, signal = options.signal; assert.ok(signal);
    const ref = setTimeout(() => { pendingIoFailures.push(id); request.emit('error', new Error('Synthetic I/O exceeded ten seconds')); }, 10000);
    ref.ref(); timers.add(ref);
    let response: (PassThrough & { statusCode: number; headers: Record<string, string> }) | undefined;
    let body: NodeJS.Immediate | undefined;
    let aborted = false;
    const abort = () => {
      if (aborted) return;
      aborted = true; response?.destroy();
      request.emit('error', Object.assign(new Error('Synthetic request aborted'), { code: 'ABORT_ERR' }));
    };
    const cleanup = () => {
      clearTimeout(ref); timers.delete(ref);
      if (body) { clearImmediate(body); body = undefined; }
      signal.removeEventListener('abort', abort);
    };
    request.once('error', cleanup); signal.addEventListener('abort', abort, { once: true });
    request.end = () => queueMicrotask(() => {
      if (signal.aborted) { abort(); return; }
      queries.push({ id, path: url.pathname + url.search });
      if (status === 'hang') return;
      response = new PassThrough() as PassThrough & { statusCode: number; headers: Record<string, string> };
      response.statusCode = status === 'summary404' && url.search || status === 'result404' && !url.search ? 404 : 200;
      response.headers = { 'content-type': 'application/json' };
      response.once('end', cleanup); response.once('close', cleanup); response.once('error', cleanup);
      onResponse(response as unknown as IncomingMessage);
      // Deliver body bytes on a separate I/O turn, as opposed to buffering them
      // inside the promise-resolution microtask. In Node20 the latter creates
      // an artificial toWeb/cancel race absent from the real HTTP control.
      // A canceled response must never receive a pending synthetic body.
      const output = response;
      body = setImmediate(() => {
        body = undefined;
        if (signal.aborted) { abort(); return; }
        if (!output.destroyed) output.end(JSON.stringify(url.search
          ? { task_id: id, status: status === 'result404' ? 'success' : status, assets: [] }
          : { data: [{ b64_json: png.toString('base64') }] }));
      });
    });
    return request;
  });
  const summary: Record<string, unknown> = {};
  try {
    const { prisma } = await import('../src/lib/prisma'); assert.equal(prisma, observed);
    const { recoverStudioTasks } = await import('../src/lib/image-studio/worker');
    const { finishStudioTask } = await import('../src/lib/image-studio/tasks');
    const delivery = await import('../src/lib/image-studio/delivery');
    const owner = 'async-fixture-owner', model = 'gpt-image-2.5-sunburst', channelId = `image-${randomUUID()}`, configRevision = randomUUID();
    await db.user.create({ data: { id: owner, name: 'Isolated owner', username: owner, email: `${owner}@fixture.invalid`,
      password_hash: 'synthetic-not-a-login', role: 'admin', account_type: 'internal' } });
    await db.creditAccount.create({ data: { user_id: owner, balance: 100, frozen_credits: 0 } });
    await db.platformSetting.create({ data: { key: `image_generation_channel_version_v1:${channelId}:${configRevision}`, value_json: JSON.stringify({
      version: 1, channelId, configRevision, label: 'Fixture', supplierName: 'Fixture', supplierKind: 'other', protocol: 'openai_images', managedChannel: true,
      settings: { provider: 'managed', enabled: true, base_url: 'https://async-fixture.invalid', api_key: 'synthetic-not-a-credential', default_model: model },
      modelCapabilities: { [model]: { enabled: true, protocol: 'openai_images', billingMode: 'fixed', fixedPoints: 1,
        qualities: null, resolutions: null, ratios: null, maxReferences: null } },
    }) } });
    const fresh = (id: string) => db.imageStudioTask.findUniqueOrThrow({ where: { id } });
    const freeze = (task: ImageStudioTask) => [task.id, task.owner_id, task.batch_id, task.fingerprint, task.model, task.prompt, task.context,
      task.snapshot_json, task.reference_ids, task.quality, task.aspect_ratio, task.output_size, task.unit_credits,
      task.freeze_snapshot, task.billing_mode, task.billing_scope, task.billing_contract_json, task.deleted_at];
    const originals: ImageStudioTask[] = [];
    const make = async (id: string, status: string, acceptedAge = 0, expired = false) => {
      const task = await db.imageStudioTask.create({ data: { id, owner_id: owner, batch_id: id, ordinal: 1, fingerprint: `frozen-${id}`,
        prompt: 'Original prompt', context: 'Original context', revision: 1, model, reference_ids: '[]', unit_credits: 1,
        freeze_snapshot: JSON.stringify([{ source_type: 'balance', amount: 1 }]), status: 'channel_running', billing_mode: 'fixed', billing_status: 'channel_unmatched',
        snapshot_json: JSON.stringify({ requestId: `request-original-${id}`, imageChannel: { channelId, configRevision } }),
        deleted_at: id === 'original-0' ? new Date(clock - 5000) : null, lease_token: `old-${id}`, lease_until: new Date(1000),
        created_at: new Date(clock - acceptedAge - 10000) } });
      await db.creditAccount.update({ where: { user_id: owner }, data: { balance: { decrement: 1 }, frozen_credits: { increment: 1 } } });
      await delivery.beginStudioRequest(task); await delivery.setStudioUnsentRequestState(task, 'attempted');
      const receipt = await delivery.createStudioAsyncReceipt(task, { taskId: `provider-${id}`, pollAfterMs: 2000,
        ...(expired ? { expiresAt: new Date(clock - 1000).toISOString() } : {}) });
      if (acceptedAge) for (const base of ['studio-delivery', 'studio-billing']) {
        const file = path.join(directory, 'storage', base, id, 'async.json');
        writeFileSync(file, JSON.stringify({ ...receipt, acceptedAt: clock - acceptedAge }), { mode: 0o600 });
      }
      statuses.set(`provider-${id}`, status); originals.push(task); return task;
    };
    if (baseline) {
      const original = await make('baseline', 'uncertain'); await recoverStudioTasks();
      assert.equal((await fresh(original.id)).status, 'channel_running');
      assert.equal(await db.creditLedger.count(), 0); assert.equal(await db.asset.count(), 0);
      assert.ok(queries.length > 0); recordCheck('baseline_explicit_unknown_retains_execution_slot');
      summary.baselineCounterexample = true;
    } else {
      const recovery = await import('../src/lib/image-studio/async-recovery');
      const rkey = (id: string) => `studio_async_recovery_v1:${id}`;
      const record = async (id: string): Promise<SyntheticRecord> => JSON.parse((await db.platformSetting.findUniqueOrThrow({ where: { key: rkey(id) } })).value_json);
      const patch = async (id: string, changes: Partial<SyntheticRecord>) => db.platformSetting.update({ where: { key: rkey(id) }, data: { value_json: JSON.stringify({ ...await record(id), ...changes }) } });
      const waitAll = async () => { const rows = await db.platformSetting.findMany({ where: { key: { startsWith: 'studio_async_recovery_v1:' } } });
        for (const row of rows) { const value = JSON.parse(row.value_json); if (value.state === 'scheduled') await db.platformSetting.update({ where: { id: row.id }, data: { value_json: JSON.stringify({ ...value, nextCheckAt: clock + 3600000 }) } }); } };
      const runUntil = async (condition: () => Promise<boolean>, limit = 12) => { for (let n = 0; n < limit; n++) { if (await condition()) return; await recoverStudioTasks(); } assert.ok(await condition(), 'Bounded actual recovery must make progress'); };
      const states = ['uncertain', 'paused', 'canceled', 'client_disconnected'];
      markPhase('provider_state_release_cases');
      for (let n = 0; n < 8; n++) { const task = await make(`original-${n}`, states[n % 4]); await recoverStudioTasks();
        const current = await fresh(task.id); assert.equal(current.status, 'uncertain'); assert.deepEqual(freeze(current), freeze(task));
        const saved = await record(task.id); assert.equal(saved.attempts, 0); assert.equal(saved.state, 'scheduled');
        assert.equal(saved.deadlineAt - saved.releasedAt, 86400000); }
      assert.equal(await db.creditLedger.count(), 0); assert.equal((await db.creditAccount.findUniqueOrThrow({ where: { user_id: owner } })).frozen_credits, 8);
      recordCheck('explicit_provider_states_release_without_refund');

      const { reserveImageStudioQueueCapacity, QueueCapacityError } = await import('../src/lib/image-studio/queue-capacity');
      assert.equal((await db.$transaction(tx => reserveImageStudioQueueCapacity(tx, owner, 8))).allowed, true);
      for (let n = 0; n < 8; n++) await db.imageStudioTask.create({ data: { id: `new-slot-${n}`, owner_id: owner, batch_id: 'new-slots', ordinal: n,
        fingerprint: `slot-${n}`, prompt: '', context: '', revision: 1, model, reference_ids: '[]', unit_credits: 0, status: 'queued' } });
      await assert.rejects(db.$transaction(tx => reserveImageStudioQueueCapacity(tx, owner, 1)), QueueCapacityError);
      await db.imageStudioTask.delete({ where: { id: 'new-slot-7' } });
      const { createSynchronousImageAdmission } = await import('../src/lib/image-studio/synchronous-admission');
      const sync = await db.$transaction(tx => createSynchronousImageAdmission(tx, { ownerId: owner, requestId: 'sync-fixture-original', fingerprint: 'sync-frozen', count: 1, model, scope: 'fixture' }));
      await assert.rejects(db.$transaction(tx => reserveImageStudioQueueCapacity(tx, owner, 1)), QueueCapacityError);
      await db.platformSetting.delete({ where: { key: sync.key } }); await db.imageStudioTask.deleteMany({ where: { batch_id: 'new-slots' } });
      recordCheck('owner_shared_capacity_includes_synchronous_running');

      for (const [id, state, expired] of [['timeout', 'hang', false], ['expiry', 'running', true], ['dispatching', 'dispatching', false], ['result404', 'result404', true]] as const) {
        const task = await make(id, state, 0, expired); await recoverStudioTasks(); assert.equal((await fresh(id)).status, 'channel_running');
        assert.equal(await recovery.readStudioAsyncRecovery(await fresh(id)), null);
        await db.imageStudioTask.update({ where: { id }, data: { status: 'uncertain', lease_token: null, lease_until: null } });
        assert.deepEqual(freeze(await fresh(id)), freeze(task));
      }
      recordCheck('expiry_timeout_and_non_summary_404_do_not_release');

      const missing = await make('missing', 'summary404', 90000000, true); await recoverStudioTasks();
      assert.equal((await fresh(missing.id)).status, 'channel_running');
      const observationKey = `studio_async_observation_v1:${missing.id}`;
      const first = JSON.parse((await db.platformSetting.findUniqueOrThrow({ where: { key: observationKey } })).value_json); assert.equal(first.count, 1);
      const currentMissing = await fresh(missing.id), missingReceipt = await delivery.readStudioAsyncReceipt(currentMissing); assert.ok(missingReceipt);
      assert.equal(await recovery.observeStudioAsyncQueryUnavailable(currentMissing, missingReceipt, { code: 'async_query_interrupted',
        poll: { summaryNotFound: true, lastHttpStatus: 404, lastAttemptPhase: 'summary_request' } }), false);
      assert.equal(JSON.parse((await db.platformSetting.findUniqueOrThrow({ where: { key: observationKey } })).value_json).count, 1);
      clock += 31000; await db.imageStudioTask.update({ where: { id: missing.id }, data: { lease_until: new Date(1000) } }); await recoverStudioTasks();
      assert.equal((await fresh(missing.id)).status, 'uncertain'); assert.equal((await record(missing.id)).reason, 'query_unavailable');
      recordCheck('two_independent_original_summary_404_observations');

      await waitAll(); clock += 301000;
      for (let n = 0; n < 13; n++) await db.platformSetting.create({ data: { key: `studio_async_recovery_v1:000-invalid-${n}`, value_json: '{"state":"scheduled"}' } });
      await patch('original-0', { nextCheckAt: 0 }); statuses.set('provider-original-0', 'success');
      for (let n = 0; n < 8 && (await fresh('original-0')).status !== 'succeeded'; n++) {
        await db.platformSetting.create({ data: { key: `studio_async_recovery_v1:zzz-tail-${n}`, value_json: '{"state":"scheduled"}' } }); await recoverStudioTasks();
      }
      const delivered = await fresh('original-0'); assert.equal(delivered.status, 'succeeded'); assert.ok(delivered.asset_id); assert.ok(delivered.deleted_at);
      const deliveredAsset = await db.asset.findUniqueOrThrow({ where: { id: delivered.asset_id } }); assert.equal(deliveredAsset.hash, sha(png));
      assert.deepEqual(freeze(delivered), freeze(originals[0])); assert.equal(await db.creditLedger.count({ where: { related_task_id: delivered.id } }), 1);
      assert.equal(await finishStudioTask(originals[0], 'succeeded'), false);
      assert.equal((await record(delivered.id)).state, 'complete');
      recordCheck('original_get_delivers_once_preserving_frozen_identity');

      await waitAll(); await patch('original-1', { nextCheckAt: 0 }); competeKey = rkey('original-1');
      for (let n = 0; n < 6 && competeKey; n++) await recovery.claimStudioAsyncRecovery();
      assert.equal(competeKey, null); assert.equal((await fresh('original-1')).lease_token, null); assert.equal((await record('original-1')).attempts, 0);
      let claimed = null;
      for (let n = 0; n < 6 && !claimed; n++) claimed = await recovery.claimStudioAsyncRecovery();
      assert.ok(claimed && claimed.task.id === 'original-1');
      await db.imageStudioTask.update({ where: { id: claimed.task.id }, data: { lease_until: new Date(1000) } });
      await patch(claimed.task.id, { leaseUntil: 1000, nextCheckAt: 0 });
      const child = `const {createRequire}=require('node:module');const req=createRequire(${JSON.stringify(path.join(root, 'package.json'))});
        globalThis.AsyncLocalStorage=req('node:async_hooks').AsyncLocalStorage;Date.now=()=>Number(process.env.SYNTHETIC_NOW);
        const block=()=>{throw Error('restart network forbidden')};globalThis.fetch=block;for(const name of ['node:http','node:https']){const x=req(name);x.request=block;x.get=block;}req('node:dns/promises').lookup=block;
        process.chdir(${JSON.stringify(directory)});const r=req(${JSON.stringify(path.join(root, 'src/lib/image-studio/async-recovery.ts'))});const {prisma}=req(${JSON.stringify(path.join(root, 'src/lib/prisma.ts'))});
        (async()=>{try{let c=null;for(let i=0;i<6&&!c;i++)c=await r.claimStudioAsyncRecovery();if(!c||c.task.id!=='original-1')throw Error('restart claim missing');console.log(JSON.stringify({id:c.task.id,token:c.task.lease_token}));}finally{await prisma.$disconnect()}})().catch(e=>{console.error(e);process.exitCode=1});`;
      const output = execFileSync(process.execPath, ['--import', 'tsx', '-e', child], { cwd: root, env: { ...env, SYNTHETIC_NOW: String(clock) }, encoding: 'utf8', timeout: 20000 });
      const restarted = JSON.parse(output.trim()); assert.equal(restarted.id, claimed.task.id); assert.notEqual(restarted.token, claimed.task.lease_token);
      assert.equal(await finishStudioTask(claimed.task, 'succeeded'), false); assert.equal((await record(claimed.task.id)).attempts, 2);
      await db.imageStudioTask.update({ where: { id: claimed.task.id }, data: { lease_until: new Date(1000) } }); await patch(claimed.task.id, { leaseUntil: 1000, nextCheckAt: 0 });
      statuses.set('provider-original-1', 'success'); await runUntil(async () => (await fresh('original-1')).status === 'succeeded');
      assert.equal(await db.creditLedger.count({ where: { related_task_id: 'original-1' } }), 1);
      recordCheck('durable_claim_cas_restart_and_bounded_fair_scan');

      await waitAll(); await patch('original-2', { state: 'stopped', stopCode: 'auto_budget', attempts: 12, lastRequestedAt: clock - 301000 });
      let view = await recovery.readStudioAsyncRecovery(await fresh('original-2')); assert.ok(view?.canRequestRecheck);
      const deadline = view.deadlineAt, beforeManual = queries.length;
      await assert.rejects(recovery.requestStudioAsyncRecheck('other-owner', 'original-2', view.binding), recovery.StudioAsyncRecoveryError);
      await assert.rejects(recovery.requestStudioAsyncRecheck(owner, 'original-2', 'not-the-original-binding'), recovery.StudioAsyncRecoveryError);
      const queued = await recovery.requestStudioAsyncRecheck(owner, 'original-2', view.binding); assert.equal(queued.scheduled, true);
      assert.equal((await recovery.requestStudioAsyncRecheck(owner, 'original-2', view.binding)).scheduled, false); assert.equal(queries.length, beforeManual);
      statuses.set('provider-original-2', 'running'); await runUntil(async () => (await record('original-2')).manualChecks === 1 && !(await record('original-2')).manualOnce);
      let saved = await record('original-2'); assert.equal(saved.state, 'stopped'); assert.equal(saved.attempts, 12); assert.equal(saved.deadlineAt, deadline);
      assert.equal(queries.filter(q => q.id === 'provider-original-2').length, 2, 'One initial JSON status plus exactly one manual summary GET');
      assert.equal((await recovery.readStudioAsyncRecovery(await fresh('original-2')))?.canRequestRecheck, false);
      clock += 301000; view = await recovery.readStudioAsyncRecovery(await fresh('original-2')); assert.ok(view?.canRequestRecheck);
      await recovery.requestStudioAsyncRecheck(owner, 'original-2', view.binding); statuses.set('provider-original-2', 'success');
      await runUntil(async () => (await fresh('original-2')).status === 'succeeded'); saved = await record('original-2');
      assert.equal(saved.attempts, 12); assert.equal(saved.manualChecks, 2); assert.equal(saved.deadlineAt, deadline);
      assert.equal(await db.creditLedger.count({ where: { related_task_id: 'original-2' } }), 1);

      // Exercise the real twelfth claim, then crash after (or before) durable local output.
      // Restart must consume only a complete checkpoint, never a thirteenth GET.
      for (const id of ['original-6', 'original-7']) {
        await waitAll(); await patch(id, { attempts: 11, nextCheckAt: 0 });
        let held = null;
        for (let n = 0; n < 8 && !held; n++) held = await recovery.claimStudioAsyncRecovery();
        assert.ok(held && held.task.id === id && !held.localOnly && !held.manualOnce);
        assert.equal((await record(id)).attempts, 12);
        if (id === 'original-6') await delivery.createStudioBase64Delivery(held.task, png.toString('base64'), {});
        await db.imageStudioTask.update({ where: { id }, data: { lease_until: new Date(1000) } });
        await patch(id, { leaseUntil: 1000, nextCheckAt: 0 });
        const beforeCheckpoint = queries.length, beforeDeadline = (await record(id)).deadlineAt;
        await runUntil(async () => id === 'original-6' ? (await fresh(id)).status === 'succeeded' : (await record(id)).state === 'stopped');
        assert.equal(queries.length, beforeCheckpoint); assert.equal((await record(id)).attempts, 12);
        assert.equal((await record(id)).deadlineAt, beforeDeadline);
        assert.equal(await finishStudioTask(held.task, 'succeeded'), false);
        if (id === 'original-6') {
          const task = await fresh(id); assert.ok(task.asset_id);
          assert.equal((await db.asset.findUniqueOrThrow({ where: { id: task.asset_id } })).hash, sha(png));
          assert.equal(await db.creditLedger.count({ where: { related_task_id: id } }), 1);
        } else {
          assert.equal((await fresh(id)).status, 'uncertain'); assert.equal((await record(id)).stopCode, 'auto_budget');
          assert.equal(await db.creditLedger.count({ where: { related_task_id: id } }), 0);
        }
      }

      // Settle known failure and reject a partial checkpoint before advancing the
      // synthetic clock beyond every original automatic observation deadline.
      await waitAll(); await patch('original-4', { nextCheckAt: 0 }); statuses.set('provider-original-4', 'failed');
      await runUntil(async () => (await fresh('original-4')).status === 'failed');
      assert.equal(await db.creditLedger.count({ where: { related_task_id: 'original-4', type: 'task_failed_refund' } }), 1);
      await patch('original-5', { nextCheckAt: 0 });
      writeFileSync(path.join(directory, 'storage/studio-delivery/original-5/source.json'), '{"broken":true}', { mode: 0o600 });
      await runUntil(async () => (await record('original-5')).state === 'stopped');
      assert.equal(await db.creditLedger.count({ where: { related_task_id: 'original-5' } }), 0);

      // Age the clock, not the immutable release/deadline fields. The production
      // worker must stop the expired automatic claim before making another GET.
      const beforeExpiry = await record('original-3'), expiryQueries = queries.length;
      clock = beforeExpiry.deadlineAt + 1; await waitAll(); await patch('original-3', { nextCheckAt: 0 });
      await runUntil(async () => (await record('original-3')).state === 'stopped');
      assert.equal(queries.length, expiryQueries); assert.equal((await record('original-3')).stopCode, 'deadline');
      assert.equal((await record('original-3')).releasedAt, beforeExpiry.releasedAt);
      assert.equal((await record('original-3')).deadlineAt, beforeExpiry.deadlineAt);
      clock += 301000; await waitAll();
      view = await recovery.readStudioAsyncRecovery(await fresh('original-3')); assert.ok(view?.canRequestRecheck);
      await recovery.requestStudioAsyncRecheck(owner, 'original-3', view.binding);
      let manualClaim = null; for (let n = 0; n < 8 && !manualClaim; n++) manualClaim = await recovery.claimStudioAsyncRecovery();
      assert.ok(manualClaim?.manualOnce && manualClaim.task.id === 'original-3');
      const crashQueryCount = queries.length;
      await db.imageStudioTask.update({ where: { id: 'original-3' }, data: { lease_until: new Date(1000) } }); await patch('original-3', { leaseUntil: 1000, nextCheckAt: 0 });
      for (let n = 0; n < 6; n++) await recovery.claimStudioAsyncRecovery();
      assert.equal(queries.length, crashQueryCount); assert.equal((await record('original-3')).manualOnce, false);
      assert.equal((await record('original-3')).state, 'stopped'); assert.equal((await record('original-3')).manualChecks, 1);
      assert.equal((await record('original-3')).releasedAt, beforeExpiry.releasedAt);
      assert.equal((await record('original-3')).deadlineAt, beforeExpiry.deadlineAt);
      recordCheck('manual_once_after_auto_budget_keeps_limits');

      await waitAll();
      const beforeLegacy = queries.length;
      const native = await db.imageStudioTask.create({ data: { id: 'legacy-native', owner_id: owner, batch_id: 'legacy', ordinal: 1,
        fingerprint: 'legacy', prompt: '', context: '', revision: 1, model: 'gemini-nano-banana-2.1', reference_ids: '[]', unit_credits: 0, status: 'uncertain' } });
      assert.equal(await recovery.readStudioAsyncRecovery(native), null); assert.equal(await finishStudioTask(native, 'succeeded'), false);
      await assert.rejects(recovery.requestStudioAsyncRecheck(owner, native.id, 'legacy'), recovery.StudioAsyncRecoveryError);
      for (let n = 0; n < 4; n++) await recoverStudioTasks(); assert.equal(queries.length, beforeLegacy);

      // Filesystem evidence failure must deny query authority without deleting
      // the only complete local output. Run cleanup only after old file cases.
      markPhase('checkpoint_retention_with_unreadable_receipts');
      await waitAll();
      const retentionOriginal = await make('checkpoint-retention', 'uncertain');
      await recoverStudioTasks();
      const retentionTask = await fresh(retentionOriginal.id);
      assert.equal(retentionTask.status, 'uncertain'); assert.equal((await record(retentionTask.id)).state, 'scheduled');
      await delivery.createStudioBase64Delivery(retentionTask, png.toString('base64'), {});
      const deliveryDirectory = path.join(directory, 'storage', 'studio-delivery', retentionTask.id);
      const billingDirectory = path.join(directory, 'storage', 'studio-billing', retentionTask.id);
      const sourceFile = path.join(deliveryDirectory, 'source.json'), imageFile = path.join(deliveryDirectory, 'image.part');
      const sourceBytes = readFileSync(sourceFile), imageBytes = readFileSync(imageFile);
      assert.deepEqual(imageBytes, png); assert.equal(JSON.parse(sourceBytes.toString()).complete, true);
      const requestBytes = readFileSync(path.join(deliveryDirectory, 'request.json'));
      const receipts = [deliveryDirectory, billingDirectory].map(base => {
        const file = path.join(base, 'async.json'); return { file, bytes: readFileSync(file) };
      });
      for (const receipt of receipts) writeFileSync(receipt.file, '{invalid-json', { mode: 0o600 });
      assert.equal(await recovery.readStudioAsyncRecovery(retentionTask), null);
      assert.equal(await recovery.retainStudioAsyncCheckpoint(retentionTask), true);
      utimesSync(deliveryDirectory, new Date(1000), new Date(1000));
      const retainedQueryCount = queries.length, cleanupAt = clock + 300001;
      assert.equal(process.cwd(), directory);
      await delivery.cleanupStudioDeliveries(cleanupAt);
      assert.deepEqual(readFileSync(sourceFile), sourceBytes); assert.deepEqual(readFileSync(imageFile), imageBytes);
      assert.equal(queries.length, retainedQueryCount); assert.equal((await fresh(retentionTask.id)).status, 'uncertain');
      for (const receipt of receipts) writeFileSync(receipt.file, receipt.bytes, { mode: 0o600 });
      assert.ok(await recovery.readStudioAsyncRecovery(retentionTask));
      await patch(retentionTask.id, { state: 'stopped', stopCode: 'auto_budget', attempts: 12, lastRequestedAt: clock - 301000 });
      const retentionView = await recovery.readStudioAsyncRecovery(retentionTask); assert.ok(retentionView?.canRequestRecheck);
      const manualRetention = await recovery.requestStudioAsyncRecheck(owner, retentionTask.id, retentionView.binding);
      assert.equal(manualRetention.scheduled, true); assert.ok('recovery' in manualRetention);
      assert.equal(manualRetention.recovery.state, 'scheduled');
      assert.equal((await record(retentionTask.id)).state, 'stopped');
      assert.equal(await recovery.retainStudioAsyncCheckpoint(retentionTask), true);
      await delivery.cleanupStudioDeliveries(cleanupAt + 300001);
      assert.deepEqual(readFileSync(imageFile), imageBytes);
      // Isolate the ordinary stopped/non-pending retention case after proving
      // that a real manual request protects bytes while awaiting its lease.
      await patch(retentionTask.id, { manualOnce: false });
      assert.equal(await recovery.retainStudioAsyncCheckpoint(retentionTask), false);
      await delivery.cleanupStudioDeliveries(cleanupAt + 600002);
      assert.equal(existsSync(deliveryDirectory), false, 'Stopped temporary delivery still follows the original retention policy');
      assert.deepEqual(readFileSync(path.join(billingDirectory, 'async.json')), receipts[1].bytes);
      assert.deepEqual(readFileSync(path.join(billingDirectory, 'request.json')), requestBytes);
      assert.equal(queries.length, retainedQueryCount);
      assert.equal(await db.creditLedger.count({ where: { related_task_id: retentionTask.id } }), 0);
      summary.unreadableReceiptKeptCompleteCheckpoint = true; summary.manualPendingKeptCompleteCheckpoint = true;
      summary.stoppedTemporaryCheckpointCleaned = true;

      for (const task of originals) assert.deepEqual(freeze(await fresh(task.id)), freeze(task));
      summary.originalsCompared = originals.length;
      summary.successSettlements = await db.imageStudioTask.count({ where: { status: 'succeeded' } });
      summary.knownFailureRefunds = await db.creditLedger.count({ where: { type: 'task_failed_refund' } });
      assert.equal(summary.successSettlements, 4); assert.equal(summary.knownFailureRefunds, 1);
      assert.equal(await db.creditLedger.count(), 5, 'Four original settlements and one known-failure refund only');
      for (const task of originals) if ((await fresh(task.id)).status === 'uncertain') {
        assert.equal(await db.creditLedger.count({ where: { related_task_id: task.id } }), 0, 'Unknown results must keep their reserve');
      }
      const recoveryRows = await db.platformSetting.findMany({ where: { key: { startsWith: 'studio_async_recovery_v1:' } } });
      const recoveryRecords = recoveryRows.map(row => JSON.parse(row.value_json) as Partial<SyntheticRecord>);
      summary.maxAutomaticAttempts = Math.max(...recoveryRecords.map(value => value.attempts || 0));
      summary.manualChecks = recoveryRecords.reduce((total, value) => total + (value.manualChecks || 0), 0);
      assert.equal(summary.maxAutomaticAttempts, 12); assert.equal(summary.manualChecks, 3);
      summary.manualCrashDidNotRequery = true; summary.checkpointBudgetCrashCases = 2;
      recordCheck('legacy_identity_and_partial_checkpoint_fail_closed');
    }
    assert.deepEqual(checks, baseline ? ['baseline_explicit_unknown_retains_execution_slot'] : expectedChecks);
    assert.equal(forbiddenCalls, 0); assert.equal(timers.size, 0); assert.deepEqual(pendingIoFailures, []);
    assert.ok(queries.length > 0, 'No empty run can complete this fixture');
    summary.simulatedOriginalGetCalls = queries.length;
    completed = true;
  } finally {
    mock.restoreAll(); for (const timer of Array.from(timers)) clearTimeout(timer); await db.$disconnect(); process.chdir(root);
    for (const [file, digest] of Object.entries(sourceSha256)) assert.equal(sha(readFileSync(path.join(root, file))), digest, `${file} changed during this run`);
    assert.equal(sha(readFileSync(path.join(root, 'scripts/image-async-recovery-engineering.ts'))), fixtureSha256, 'Fixture changed during this run');
    const receipt = path.join(directory, 'receipt.json');
    writeFileSync(receipt, JSON.stringify({ schema: 'image-async-recovery-engineering.v1', synthetic: true, runId,
      mode: baseline ? 'baseline' : 'verify', startedAt, finishedAt: new Date().toISOString(), completed, fixtureSha256, sourceSha256,
      checks, summary, forbiddenCalls, productionWrites: 0, paidRequests: 0, browserRuns: 0,
      dependency: { node: process.versions.node, prisma: require('prisma/package.json').version, tsx: require('tsx/package.json').version,
        prismaClientRoot: realpathSync(path.dirname(require.resolve('@prisma/client/package.json'))) }, databasePath,
      scope: 'Isolated original-GET scheduling/SQLite/PNG/one-time settlement; no actual supplier, generation POST, production changes or browser.' }, null, 2), { mode: 0o600, flag: 'wx' });
    assert.equal(statSync(receipt).mode & 0o777, 0o600); process.umask(previousUmask);
    if (completed) console.log(`Image async recovery engineering receipt: ${receipt}`);
  }
}
void main().then(() => { process.exitCode = 0; }).catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => { clearTimeout(fixtureDeadline); });
