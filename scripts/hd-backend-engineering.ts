// Offline HD backend gates. All data/process fixtures use new private roots;
// no SQL, provider requests, application service or production path is opened.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mock } from 'node:test';
import sharp from 'sharp';
import * as runner from '../src/lib/media/hd-image-processor';

async function main() {
  const applicationRoot = process.cwd();
  Object.assign(process.env, { NODE_ENV: 'test' });
  delete process.env.HD_DERIVATIVES_ROOT;
  const evidenceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sd2-hd-backend-'));
  await fs.chmod(evidenceRoot, 0o700);
  process.env.DATABASE_URL = 'file:' + path.join(evidenceRoot, 'unused-private.db');
// Complete authoritative lookup fixture: scheduler ownership is exercised
// without opening the application's SQL database.
let ownerBindings: Array<{ id: string; owner_id: string; original_url: string; status?: string; type?: string }> = [];
let referenceBindings: Array<{ id: string; owner_user_id: string; url: string }> = [];
let ownerReads: Array<{ table: string; kind: string; rows: number }> = [];
(globalThis as unknown as { hdReadonlyDb?: unknown }).hdReadonlyDb = {
  asset: {
    findMany: async (args?: { where?: { status?: string; type?: string; original_url?: { in?: string[]; endsWith?: string } } }) => {
      const filter = args?.where?.original_url;
      const rows = ownerBindings.map(row => ({ status: 'active', type: 'image', ...row })).filter(row => (!args?.where?.status || row.status === args.where.status) && (!args?.where?.type || row.type === args.where.type)
        && (!filter?.in || filter.in.includes(row.original_url)) && (!filter?.endsWith || row.original_url.endsWith(filter.endsWith)));
      ownerReads.push({ table: 'asset', kind: 'many', rows: rows.length }); return rows;
    },
    findFirst: async (args: { where: { id: string; owner_id: string } }) => {
      const row = ownerBindings.find(value => value.id === args.where.id && value.owner_id === args.where.owner_id);
      ownerReads.push({ table: 'asset', kind: 'one', rows: row ? 1 : 0 }); return row || null;
    },
  },
  referenceImage: {
    findMany: async () => { ownerReads.push({ table: 'reference', kind: 'many', rows: referenceBindings.length }); return referenceBindings; },
    findFirst: async (args: { where: { id: string; owner_user_id: string } }) => {
      const row = referenceBindings.find(value => value.id === args.where.id && value.owner_user_id === args.where.owner_user_id);
      ownerReads.push({ table: 'reference', kind: 'one', rows: row ? 1 : 0 }); return row || null;
    },
  }, imageStudioTask: { findFirst: async () => null },
  $disconnect: async () => {},
};
  const core = await import('../src/lib/media/hd-derivatives');
  const storage = await import('../src/lib/media/hd-storage-root');
  const results: Array<{ name: string; passed: boolean; error?: string }> = [];
  const safeCapacity = async () => ({ rootFree: 10 * 1024 ** 3, dataFree: 20 * 1024 ** 3,
    rootReserve: 512000 * 1024, dataReserve: 2 * 1024 ** 3, separateDataMount: true, safe: true });
  const processJob = (key: string, options: Parameters<typeof core.processHdJob>[2] = {}) => core.processHdJob(key, undefined, {
    capacity: safeCapacity, processor: (request, processorOptions) => runner.runHdImageProcessor(request, { ...processorOptions, applicationRoot }), ...options,
  });
  const check = async (name: string, action: () => Promise<void> | void) => {
    try { await action(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) }); }
    finally { process.chdir(applicationRoot); delete process.env.HD_DERIVATIVES_ROOT; }
  };
  const fixture = async () => {
    ownerBindings = []; referenceBindings = []; ownerReads = [];
    const directory = await fs.mkdtemp(path.join(evidenceRoot, 'case-'));
    await fs.chmod(directory, 0o700);
    await fs.mkdir(path.join(directory, 'public/uploads'), { recursive: true });
    await fs.mkdir(path.join(directory, 'storage/hd-derivatives'), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(directory, 'src/lib/media'), { recursive: true });
    await fs.copyFile(path.join(applicationRoot, 'src/lib/media/hd-encoder.ts'), path.join(directory, 'src/lib/media/hd-encoder.ts'));
    process.chdir(directory); return directory;
  };
  const image = async (name: string) => {
    const file = path.join(process.cwd(), 'public/uploads', name + '.png');
    await sharp({ create: { width: 128, height: 96, channels: 4, background: { r: 45, g: 84, b: 152, alpha: 0.5 } } }).png().toFile(file);
    return { file, source: '/uploads/' + name + '.png' };
  };
  const waitFor = async (condition: () => Promise<boolean>, timeoutMs = 10_000) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error('fixture_condition_timeout');
  };
  const exists = (file: string) => fs.stat(file).then(() => true).catch(error => { if (error.code === 'ENOENT') return false; throw error; });

  await check('E01 production resolver requires exact explicit canonical root', () => {
    const root = storage.HD_CANONICAL_ROOT;
    for (const value of [undefined, '', '/tmp/hd', root + '/', root + '/..']) {
      assert.throws(() => storage.resolveHdDirectory({ env: { NODE_ENV: 'production', ...(value === undefined ? {} : { HD_DERIVATIVES_ROOT: value }) } }), /hd_storage_configuration/);
    }
    for (const cwd of ['/release/one', '/release/two']) assert.equal(storage.resolveHdDirectory({ cwd, env: { NODE_ENV: 'production', HD_DERIVATIVES_ROOT: root } }), root);
    assert.equal(storage.hdDataMountRecorded('12 1 8:1 / /data rw - ext4 /dev/data rw'), true);
    assert.equal(storage.hdDataMountRecorded('12 1 8:1 / /data-pretend rw - ext4 /dev/data rw'), false);
  });
  await check('E01 two real release cwd roots reuse the exact ready key and bytes', async () => {
    const first = await fixture(); const original = await image('same');
    const fixedRoot = path.join(first, 'storage/hd-derivatives'); process.env.HD_DERIVATIVES_ROOT = fixedRoot;
    const identity = (await core.hdRequestIdentity(original.source, false))!;
    const encoder = await import('../src/lib/media/hd-encoder');
    assert.equal(encoder.hdEncoderParameters('avif').effort, 6);
    assert.equal(encoder.hdEncoderParameters('avif', 'hd-avif-e4-v1').effort, 4);
    assert.equal(encoder.hdEncoderParameters('webp', 'hd-avif-e4-v1').effort, 6);
    assert.throws(() => encoder.hdEncoderStrategy('unknown'), /invalid_hd_encoder_strategy/);
    assert.notEqual((await core.hdRequestIdentity(original.source, false, 'hd-avif-e4-v1'))!.key, identity.key);
    const job = (await core.requestHd(original.source, core.HD_PRIORITY.new, false))!;
    await processJob(job.key);
    const ready = (await core.readHdJob(job.key))!; assert.equal(ready.status, 'ready');
    const bytes = await fs.readFile(path.join(fixedRoot, ready.file!));
    const second = await fs.mkdtemp(path.join(evidenceRoot, 'release-'));
    await fs.mkdir(path.join(second, 'public'), { recursive: true });
    await fs.symlink(path.join(first, 'public/uploads'), path.join(second, 'public/uploads'));
    process.chdir(second);
    const secondIdentity = (await core.hdRequestIdentity(original.source, false))!;
    assert.equal(secondIdentity.key, identity.key); assert.equal(secondIdentity.current.file, identity.current.file);
    assert.equal(core.hdDirectory(), fixedRoot); assert.equal(core.hdWorkerLockPath(), path.join(first, 'storage/hd-worker.lock'));
    const reused = (await core.requestHd(original.source, core.HD_PRIORITY.viewer, false))!;
    assert.equal(reused.status, 'ready'); assert.equal(reused.attempts, ready.attempts);
    assert.deepEqual(await fs.readFile(path.join(fixedRoot, reused.file!)), bytes);
    await fs.chmod(fixedRoot, 0o777);
    await assert.rejects(storage.assertHdStorageRoot(), /hd_storage_owner/);
    await fs.chmod(fixedRoot, 0o700);
  });
  await check('HD01 library upgrade reuses ready output and preserves source/recipe boundaries', async () => {
    await fixture(); const original = await image('library-upgrade');
    const currentLibrary = sharp.versions.sharp;
    let job: Awaited<ReturnType<typeof core.requestHd>>;
    try {
      sharp.versions.sharp = 'fixture-previous-library';
      job = await core.requestHd(original.source, 0, false);
    } finally { sharp.versions.sharp = currentLibrary; }
    assert.ok(job);
    assert.notEqual((await core.hdRequestIdentity(original.source, false))!.key, job.key);
    assert.equal((await core.requestHd(original.source, 1, false))!.key, job.key, 'in-flight old key is not duplicated');
    await processJob(job.key);
    const ready = (await core.lookupHd(original.source))!;
    assert.equal(ready.status, 'ready'); assert.equal(ready.key, job.key);
    const before = await fs.readFile(path.join(core.hdDirectory(), ready.file!));
    assert.equal((await core.requestHd(original.source, 1, false))!.attempts, ready.attempts);
    assert.deepEqual(await fs.readFile(path.join(core.hdDirectory(), ready.file!)), before);
    assert.equal((await core.listHdJobs()).length, 1);
    assert.notEqual((await core.requestHd(original.source, 0, true))!.key, job.key, 'text preservation is a separate recipe');
    const other = await image('other-source');
    assert.equal(await core.lookupHd(other.source), null, 'same dimensions do not authorize another source');
    await fs.truncate(path.join(core.hdDirectory(), ready.file!), 1);
    assert.equal((await core.lookupHd(original.source))!.reason, 'published_integrity');
    await sharp({ create: { width: 64, height: 64, channels: 3, background: 'red' } }).png().toFile(original.file);
    assert.equal(await core.lookupHd(original.source), null, 'changed original cannot reuse an old-version output');
  });
  await check('E04 temporary viewing preserves the job role and durable scheduler identity', async () => {
    await fixture(); const original = await image('priority');
    const initial = (await core.requestHd(original.source, 0, false))!;
    const token = randomUUID();
    const viewer = (await core.requestHd(original.source, 1, false, undefined, { requesterId: 'viewer-a', viewToken: token }))!;
    assert.equal(viewer.key, initial.key); assert.equal(viewer.priority, 0); assert.equal(viewer.queueRole, 'new');
    assert.equal((await core.requestHd(original.source, 0, false))!.queueRole, 'new');
    const scheduling = await import('../src/lib/media/hd-scheduler');
    const state = await scheduling.readHdScheduler();
    assert.equal(state.entries[viewer.key].homeBucket, 'system:legacy');
    assert.equal(state.entries[viewer.key].interests.length, 1);
    assert.equal(state.entries[viewer.key].interests[0].token, token);
    assert.equal(state.entries[viewer.key].interests[0].expiresAt - state.entries[viewer.key].interests[0].writtenAt, 45000);
    assert.equal((await scheduling.claimHdScheduledJob(await core.listHdJobs()))?.key, viewer.key);
    await scheduling.finishHdScheduledClaim(viewer, viewer.key);
    assert.equal((await scheduling.readHdScheduler()).globalTurn, 0, 'unstarted claim does not consume a turn');
    const legacy = { ...viewer, queueRole: undefined, priority: 0 };
    assert.equal(core.hdQueueRole(legacy), 'new');
    assert.equal(core.hdQueueRole({ ...legacy, priority: 1 }), 'viewer');
    assert.equal(core.hdQueueRole({ ...legacy, priority: 2 }), 'historical');
    assert.equal(core.hdQueueRole({ ...legacy, priority: 3 }), 'historical');
    await fixture();
    const a1 = await image('owner-a-1'), a2 = await image('owner-a-2'), b1 = await image('owner-b-1');
    ownerBindings = [a1, a2, b1].map((value, index) => ({ id: String(index), owner_id: index < 2 ? 'owner-a' : 'owner-b', original_url: value.source }));
    const queued = await Promise.all([a1, a2, b1].map(value => core.requestHd(value.source, 0, false)));
    const first = (await scheduling.claimHdScheduledJob(await core.listHdJobs()))!;
    const firstState = await scheduling.readHdScheduler(), firstBucket = firstState.entries[first.key].homeBucket;
    const started = { ...first, status: 'running' as const, attempts: first.attempts + 1, executionId: randomUUID() };
    await core.atomicHdJson(path.join(core.hdDirectory(), first.key + '.json'), started);
    await scheduling.markHdScheduledAttempt(started);
    const completed = { ...started, status: 'skipped' as const, reason: 'source_incompatible' };
    await core.atomicHdJson(path.join(core.hdDirectory(), first.key + '.json'), completed);
    await scheduling.finishHdScheduledClaim(completed, first.key);
    const second = (await scheduling.claimHdScheduledJob(await core.listHdJobs()))!;
    const secondState = await scheduling.readHdScheduler();
    assert.notEqual(secondState.entries[second.key].homeBucket, firstBucket, 'another ready owner gets the next turn');
    assert.equal(secondState.globalTurn, 1); assert.equal(queued.filter(Boolean).length, 3);
    await scheduling.finishHdScheduledClaim(second, second.key);

  });
  await check('HD03 owner facts use bounded reads, validate the file and preserve frozen ownership', async () => {
    await fixture(); const original = await image('known-owner');
    const unrelated = () => Array.from({ length: 2000 }, (_, index) => ({ id: `archive-${index}`, owner_id: 'another-owner', original_url: `/uploads/archive-${index}.png` }));
    ownerBindings = [...unrelated(), { id: 'target', owner_id: 'actual-owner', original_url: original.source }];
    const job = (await core.requestHd(original.source, 0, false, undefined, { owner: { kind: 'asset', id: 'target', ownerId: 'actual-owner' } }))!;
    const scheduler = await import('../src/lib/media/hd-scheduler');
    assert.equal((await scheduler.readHdScheduler()).entries[job.key].ownerEvidence.ownerId, 'actual-owner');
    assert.deepEqual(ownerReads, [{ table: 'asset', kind: 'one', rows: 1 }]);
    await scheduler.registerHdScheduling(job, { owner: { kind: 'asset', id: 'archive-0', ownerId: 'another-owner' } });
    assert.equal((await scheduler.readHdScheduler()).entries[job.key].ownerEvidence.ownerId, 'actual-owner');
    assert.equal(ownerReads.length, 1, 'A frozen owner must not be rebound or queried again');

    await fixture(); const target = await image('correct-source'), other = await image('other-owner-source');
    ownerBindings = [...unrelated(), { id: 'actual', owner_id: 'actual-owner', original_url: target.source }, { id: 'wrong', owner_id: 'wrong-owner', original_url: other.source }];
    const corrected = (await core.requestHd(target.source, 0, false, undefined, { owner: { kind: 'asset', id: 'wrong', ownerId: 'wrong-owner' } }))!;
    assert.equal((await scheduler.readHdScheduler()).entries[corrected.key].ownerEvidence.ownerId, 'actual-owner');
    assert.deepEqual(ownerReads, [{ table: 'asset', kind: 'one', rows: 1 }, { table: 'asset', kind: 'many', rows: 1 }]);

    await fixture(); const reference = await image('standalone-reference'); ownerBindings = unrelated();
    referenceBindings = [{ id: 'reference', owner_user_id: 'reference-owner', url: reference.source }];
    const referenced = (await core.requestHd(reference.source, 0, false, undefined, { owner: { kind: 'reference', id: 'reference', ownerId: 'reference-owner' } }))!;
    assert.equal((await scheduler.readHdScheduler()).entries[referenced.key].ownerEvidence.kind, 'reference');
    assert.deepEqual(ownerReads, [{ table: 'reference', kind: 'one', rows: 1 }]);

    await fixture(); const legacy = await image('legacy-domain');
    ownerBindings = [...unrelated(), { id: 'legacy', owner_id: 'legacy-owner', original_url: `https://sd2.youdoodesign.com${legacy.source}` }];
    const recovered = (await core.requestHd(legacy.source, 0, false))!;
    assert.equal((await scheduler.readHdScheduler()).entries[recovered.key].ownerEvidence.ownerId, 'legacy-owner');
    assert.deepEqual(ownerReads, [{ table: 'asset', kind: 'many', rows: 1 }]);

    await fixture(); const current = await image('hidden-owner-candidate');
    ownerBindings = [{ id: 'hidden', owner_id: 'hidden-owner', original_url: current.source, status: 'hidden' },
      { id: 'video', owner_id: 'video-owner', original_url: current.source, type: 'video' },
      { id: 'active', owner_id: 'active-owner', original_url: current.source }];
    const active = (await core.requestHd(current.source, 0, false))!;
    assert.equal((await scheduler.readHdScheduler()).entries[active.key].ownerEvidence.ownerId, 'active-owner');
    assert.deepEqual(ownerReads, [{ table: 'asset', kind: 'many', rows: 3 }]);
  });
  await check('E02 unexplained final file is preserved and blocks a second publication', async () => {
    await fixture(); const original = await image('conflict'), job = (await core.requestHd(original.source, 0, false))!;
    const file = path.join(core.hdDirectory(), job.key + '.webp'), preserved = Buffer.from('unexplained existing output');
    await fs.writeFile(file, preserved, { mode: 0o600 });
    await assert.rejects(processJob(job.key), /hd_publish_unknown/);
    assert.deepEqual(await fs.readFile(file), preserved); assert.equal((await core.readHdJob(job.key))!.attempts, 0);
    assert.equal((await core.hdControl()).state, 'hard_pause');
  });
  await check('E04 continuous viewer/new/history arrivals all receive bounded opportunities', () => {
    const base = { source: '/uploads/fixture.png', version: 'v', policy: core.HD_POLICY, status: 'queued' as const,
      attempts: 0, preserveText: false, updatedAt: new Date().toISOString() };
    const jobs = [{ ...base, key: 'a'.repeat(64), priority: 1 }, { ...base, key: 'b'.repeat(64), priority: 0 },
      { ...base, key: 'c'.repeat(64), priority: 3, batch: 'old' }];
    let fairness = { consecutiveViewer: 0, consecutiveForeground: 0 };
    const last: Record<string, number> = { viewer: 0, new: 0, historical: 0 };
    const counts: Record<string, number> = { viewer: 0, new: 0, historical: 0 };
    for (let opportunity = 1; opportunity <= 60; opportunity++) {
      const job = core.selectHdJob(jobs, fairness, 'old')!;
      const role = core.hdQueueRole(job); counts[role]++; last[role] = opportunity;
      fairness = core.nextHdFairness(fairness, job);
      for (const role of Object.keys(last)) assert.ok(opportunity - last[role] <= 5, role + ' starved');
    }
    assert.ok(counts.viewer > counts.new); assert.ok(counts.new > 0); assert.ok(counts.historical >= 10);
  });
  await check('E05 actual live manifest lease returns contention without attempt or global pause', async () => {
    await fixture(); const original = await image('lease'); const job = (await core.requestHd(original.source, 0, false))!;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const lease = core.withHdLease(job.key, async () => { entered(); await gate; });
    await started;
    assert.equal(await processJob(job.key), null); assert.equal((await core.readHdJob(job.key))!.attempts, 0);
    assert.equal((await core.hdControl()).paused, false);
    release(); await lease; await processJob(job.key); assert.equal((await core.readHdJob(job.key))!.status, 'ready');
  });
  const hangingScript = path.join(evidenceRoot, 'hang-with-descendant.cjs');
  await fs.writeFile(hangingScript, `const {spawn}=require('node:child_process');process.on('disconnect',()=>process.exit(0));process.once('message',r=>{spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.send({protocol:r.protocol,type:'stage',key:r.key,executionId:r.executionId,sourceVersion:r.sourceVersion,stage:'reading'});setInterval(()=>{},1000);});`, { mode: 0o600 });
  const shortLimits = { ...runner.HD_IMAGE_LIMITS, readingMs: 750, wallMs: 5_000, terminateMs: 1_000 };
  await check('E06 timeout proves child/group exit; three bounded attempts do not stop next image', async () => {
    await fixture(); const original = await image('timeout'), good = await image('after-timeout');
    const job = (await core.requestHd(original.source, 0, false))!;
    let clock = Date.now(); const executions: Array<Parameters<typeof runner.assertHdExecutionExited>[0]> = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      await processJob(job.key, { clock: () => clock, processor: (request, options) => runner.runHdImageProcessor(request, {
        ...options, applicationRoot, script: hangingScript, limits: shortLimits,
        onSpawn: async identity => { executions.push(identity); await options?.onSpawn?.(identity); },
      }) });
      const result = (await core.readHdJob(job.key))!;
      assert.equal(result.attempts, attempt); assert.equal(result.errorKind, 'encode_timeout'); assert.ok(result.executionExitedAt);
      const recorded = result.attemptHistory![attempt - 1];
      assert.equal(recorded.executionId, executions[attempt - 1].executionId);
      assert.deepEqual(recorded.processor, executions[attempt - 1]);
      assert.equal(recorded.groupExit?.executionId, recorded.executionId);
      assert.equal(recorded.groupExit?.evidenceKind, 'process-group-gone');
      if (recorded.childClose) { assert.equal(recorded.childClose.executionId, recorded.executionId); assert.ok(recorded.childClose.observedAt); }
      assert.equal(result.status, attempt < 3 ? 'queued' : 'failed'); assert.equal((await core.hdControl()).paused, false);
      if (attempt < 3) { assert.ok(result.retryAt); clock = Date.parse(result.retryAt!) + 1; }
    }
    assert.equal(new Set(executions.map(value => value.pid)).size, 3);
    for (const execution of executions) await runner.assertHdExecutionExited(execution);
    const failed = (await core.readHdJob(job.key))!; assert.equal(core.isHdRetryableFailure(failed), true);
    await processJob(job.key); assert.equal((await core.readHdJob(job.key))!.attempts, 3);
    const next = (await core.requestHd(good.source, 0, false))!;
    await processJob(next.key); assert.equal((await core.readHdJob(next.key))!.status, 'ready');
  });
  await check('E06 spawn identity is durable before work; failed spawn write stops the actual group without dispatch', async () => {
    await fixture(); const original = await image('spawn-write'), job = (await core.requestHd(original.source, 0, false))!;
    const marker = path.join(evidenceRoot, 'spawn-work-' + randomUUID()), script = path.join(evidenceRoot, 'spawn-write-' + randomUUID() + '.cjs');
    await fs.writeFile(script, `process.once('message',()=>{require('node:fs').writeFileSync(${JSON.stringify(marker)},'dispatched')});setInterval(()=>{},1000);`, { mode: 0o600 });
    const rename = fs.rename, manifest = path.join(core.hdDirectory(), job.key + '.json'); let refused = false;
    let actualIdentity: runner.HdProcessorIdentity | undefined;
    fs.rename = async function (from, to) {
      if (!refused && to === manifest) {
        const value = JSON.parse(await fs.readFile(String(from), 'utf8'));
        if (value.processor) { refused = true; throw Object.assign(new Error('synthetic_spawn_manifest_write_failed'), { code: 'ENOSPC' }); }
      }
      return rename(from, to);
    };
    try {
      await processJob(job.key, { processor: (request, options) => runner.runHdImageProcessor(request, {
        ...options, applicationRoot, script, limits: shortLimits,
        onSpawn: async identity => { actualIdentity = identity; await options?.onSpawn?.(identity); },
      }) });
    } finally { fs.rename = rename; }
    assert.equal(refused, true); assert.ok(actualIdentity); await runner.assertHdExecutionExited(actualIdentity!);
    assert.equal(await exists(marker), false);
    const failed = (await core.readHdJob(job.key))!;
    assert.equal(failed.status, 'failed'); assert.equal(failed.diagnostic?.code, 'ENOSPC');
    assert.deepEqual(failed.attemptHistory![0].processor, actualIdentity);
    assert.equal(failed.attemptHistory![0].groupExit?.evidenceKind, 'process-group-gone');
  });
  await check('E06 real nonzero close and delayed original close never overwrite a later attempt', async () => {
    await fixture(); const original = await image('late-close'), job = (await core.requestHd(original.source, 0, false))!;
    let lateClose: runner.HdChildClose | undefined;
    let lateWriter: NonNullable<Parameters<typeof runner.runHdImageProcessor>[1]>['onClose'];
    await processJob(job.key, { processor: (request, options) => {
      lateWriter = options?.onClose;
      return runner.runHdImageProcessor(request, { ...options, applicationRoot, script: hangingScript, limits: shortLimits,
        onSpawn: async identity => {
          await options?.onSpawn?.(identity);
          const durable = (await core.readHdJob(job.key))!;
          assert.deepEqual(durable.attemptHistory![0].processor, identity); assert.equal(durable.attemptHistory![0].executionId, request.executionId);
        }, onClose: async value => { lateClose = value; },
      });
    } });
    const first = (await core.readHdJob(job.key))!;
    assert.ok(first.attemptHistory![0].groupExit); assert.equal(first.attemptHistory![0].childClose, undefined);
    await waitFor(async () => Boolean(lateClose));
    assert.ok(lateClose!.signal || lateClose!.code !== 0);
    await processJob(job.key, { clock: () => Date.parse(first.retryAt!) + 1 });
    const latest = (await core.readHdJob(job.key))!; assert.equal(latest.status, 'ready'); assert.equal(latest.attempts, 2);
    const latestAttempt = JSON.stringify(latest.attemptHistory![1]);
    await lateWriter!(lateClose!);
    const after = (await core.readHdJob(job.key))!;
    assert.equal(after.executionId, latest.executionId); assert.deepEqual(after.processor, latest.processor);
    assert.equal(after.executionExitedAt, latest.executionExitedAt); assert.equal(after.updatedAt, latest.updatedAt);
    assert.equal(JSON.stringify(after.attemptHistory![1]), latestAttempt);
    assert.deepEqual(after.attemptHistory![0].childClose, lateClose);
    assert.equal(after.attemptHistory![0].executionId, first.executionId);
    const script = path.join(evidenceRoot, 'nonzero-' + randomUUID() + '.cjs');
    await fs.writeFile(script, "process.once('message',()=>process.exit(7));", { mode: 0o600 });
    const work = path.join(evidenceRoot, 'nonzero-work-' + randomUUID()); await fs.mkdir(work, { mode: 0o700 });
    let close: runner.HdChildClose | undefined, group: runner.HdGroupExit | undefined;
    const executionId = randomUUID();
    await assert.rejects(runner.runHdImageProcessor({ protocol: runner.HD_IMAGE_PROTOCOL, key: job.key, executionId,
      sourceVersion: job.version, inputFile: original.file, workDirectory: work, preserveText: false },
    // This case proves exit code 7, not startup latency; timeout/termination still use shortLimits above.
    { applicationRoot, script, limits: { ...shortLimits, readingMs: 5_000, wallMs: 10_000 }, onClose: async value => { close = value; }, onGroupExit: async value => { group = value; } }), /hd_child_abnormal_exit/);
    assert.equal(close?.code, 7); assert.equal(close?.signal, null); assert.equal(close?.executionId, executionId);
    assert.equal(group?.evidenceKind, 'process-group-gone');
  });
  await check('E06 mismatched execution response is killed and hard protected', async () => {
    await fixture(); const original = await image('wrong-generation'), job = (await core.requestHd(original.source, 0, false))!;
    const script = path.join(evidenceRoot, 'wrong-generation.cjs');
    await fs.writeFile(script, `process.once('message',r=>{process.send({protocol:r.protocol,type:'stage',key:r.key,executionId:'00000000-0000-0000-0000-000000000000',sourceVersion:r.sourceVersion,stage:'reading'});setInterval(()=>{},1000)});`, { mode: 0o600 });
    await processJob(job.key, { processor: (request, options) => runner.runHdImageProcessor(request, { ...options, applicationRoot, script, limits: shortLimits }) });
    assert.equal((await core.readHdJob(job.key))!.status, 'failed'); assert.equal((await core.hdControl()).state, 'hard_pause');
    await assert.rejects(core.retryHdKey(job.key, job.version), /hd_hard_pause_requires_review/);
  });
  await check('E06 supervisor crash disconnects actual child; PID/group exit is confirmed', async () => {
    const directory = await fs.realpath(await fixture()); const original = await image('orphan');
    const identity = (await core.hdRequestIdentity(original.source, false))!;
    const workDirectory = path.join(directory, 'private-child'); await fs.mkdir(workDirectory, { mode: 0o700 });
    const identityFile = path.join(directory, 'child-identity.json'), prepared = path.join(directory, 'prepared');
    const holder = path.join(evidenceRoot, 'holder.mts');
    const request = { protocol: runner.HD_IMAGE_PROTOCOL, key: identity.key, executionId: randomUUID(), sourceVersion: identity.current.version,
      inputFile: identity.current.file, workDirectory, preserveText: false };
    await fs.writeFile(holder, `import fs from 'node:fs/promises';import {createRequire} from 'node:module';const {runHdImageProcessor}=createRequire(${JSON.stringify(pathToFileURL(path.join(applicationRoot, 'package.json')).href)})(${JSON.stringify(path.join(applicationRoot, 'src/lib/media/hd-image-processor.ts'))});await runHdImageProcessor(${JSON.stringify(request)},{applicationRoot:${JSON.stringify(applicationRoot)},onSpawn:async i=>{await fs.writeFile(${JSON.stringify(identityFile)},JSON.stringify(i))},onPrepared:async()=>{await fs.writeFile(${JSON.stringify(prepared)},'prepared');return new Promise(()=>{})}});`, { mode: 0o600 });
    const loader = createRequire(path.join(applicationRoot, 'package.json')).resolve('tsx');
    const parent = spawn(process.execPath, ['--import', loader, holder], { stdio: ['ignore', 'ignore', 'pipe'] });
    let holderError = '';
    parent.stderr.on('data', chunk => { holderError = (holderError + String(chunk)).slice(-2000); });
    const exited = new Promise<void>((resolve, reject) => { parent.once('error', reject); parent.once('exit', () => resolve()); });
    try {
      await waitFor(() => {
        if (parent.exitCode !== null || parent.signalCode !== null) throw new Error('hd_fixture_holder_exited: ' + holderError);
        return exists(prepared);
      }, runner.HD_IMAGE_LIMITS.readingMs);
      const child = JSON.parse(await fs.readFile(identityFile, 'utf8'));
      parent.kill('SIGKILL'); await exited;
      // Passive exit proof first: assertHdExecutionExited may terminate a known
      // old Linux group, so it alone would not prove the disconnect handler.
      await waitFor(async () => {
        try {
          process.kill(child.pid, 0);
          if (process.platform !== 'linux') return false;
          const stat = await fs.readFile('/proc/' + child.pid + '/stat', 'utf8');
          return ['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]);
        } catch (error) { return ['ESRCH', 'ENOENT'].includes((error as NodeJS.ErrnoException).code || ''); }
      });
      await runner.assertHdExecutionExited(child);
      assert.equal(await exists(path.join(workDirectory, 'output.avif')), false);
      assert.equal(await exists(path.join(workDirectory, 'output.webp')), false);
    } finally { if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL'); await exited; }
  });
  await check('E07 fresh source change before publication rejects old output without rewriting source', async () => {
    await fixture(); const original = await image('changed'); const job = (await core.requestHd(original.source, 0, false))!;
    const bytes = await fs.readFile(original.file);
    await processJob(job.key, { beforePublish: async () => { await new Promise(resolve => setTimeout(resolve, 5)); await fs.writeFile(original.file, bytes); } });
    const after = (await core.readHdJob(job.key))!; assert.equal(after.status, 'skipped'); assert.equal(after.reason, 'source_changed');
    assert.equal(await exists(path.join(core.hdDirectory(), job.key + '.webp')), false);
    assert.deepEqual(await fs.readFile(original.file), bytes); assert.equal((await core.hdControl()).paused, false);
  });
  await check('E07 ready-before-receipt-clear recovers once and persists verification process identity', async () => {
    await fixture(); const original = await image('ready-receipt'), job = (await core.requestHd(original.source, 0, false))!;
    await processJob(job.key);
    const ready = (await core.readHdJob(job.key))!; assert.equal(ready.status, 'ready');
    const originalAttempt = JSON.stringify(ready.attemptHistory);
    const file = path.join(core.hdDirectory(), ready.file!), bytes = await fs.readFile(file);
    const receipt = path.join(core.hdDirectory(), job.key + '.publish.json');
    await core.atomicHdJson(receipt, { protocol: 'hd-publish-v2', executionId: ready.executionId, sourceVersion: ready.version, job: ready, temporary: '' });
    const selected = core.selectHdJob(await core.listHdJobs(), 0, 'old')!;
    assert.equal(selected.key, ready.key); assert.equal(selected.publicationPending, true);
    let observedVerification = false, verificationClose: runner.HdChildClose | undefined;
    let verificationWriter: NonNullable<Parameters<typeof runner.runHdImageProcessor>[1]>['onClose'];
    await processJob(job.key, { capacity: async () => { throw new Error('must-not-reencode'); }, processor: (request, options) => {
      verificationWriter = options?.onClose;
      return runner.runHdImageProcessor(request, {
      ...options, applicationRoot, onSpawn: async identity => {
        await options?.onSpawn?.(identity);
        const durable = (await core.readHdJob(job.key))!;
        assert.equal(durable.processor?.pid, identity.pid); assert.equal(durable.processor?.startTicks, identity.startTicks);
        assert.equal(durable.processor?.executionId, request.executionId); assert.equal(durable.executionId, ready.executionId);
        const verification = durable.verificationHistory![durable.verificationHistory!.length - 1];
        assert.equal(verification.executionId, request.executionId); assert.equal(verification.sourceVersion, ready.version);
        assert.equal(verification.operation, 'validate'); assert.deepEqual(verification.processor, identity);
        assert.notEqual(durable.processor?.executionId, durable.executionId); observedVerification = true;
      },
      onClose: async value => { verificationClose = value; },
    }); } });
    assert.equal(observedVerification, true); assert.equal((await core.readHdJob(job.key))!.attempts, ready.attempts);
    await waitFor(async () => Boolean(verificationClose));
    const beforeLate = (await core.readHdJob(job.key))!;
    assert.equal(beforeLate.verificationHistory![0].childClose, undefined);
    await verificationWriter!(verificationClose!);
    const recovered = (await core.readHdJob(job.key))!, verification = recovered.verificationHistory![0];
    assert.equal(JSON.stringify(recovered.attemptHistory), originalAttempt);
    assert.ok(verification.finishedAt); assert.equal(verification.childClose?.code, 0); assert.equal(verification.childClose?.signal, null);
    assert.equal(verification.groupExit?.executionId, verification.executionId); assert.equal(verification.groupExit?.evidenceKind, 'process-group-gone');
    assert.equal(recovered.executionId, ready.executionId); assert.deepEqual(recovered.processor, ready.processor);
    assert.equal(recovered.updatedAt, beforeLate.updatedAt); assert.equal(recovered.executionExitedAt, beforeLate.executionExitedAt);
    assert.equal(await exists(receipt), false); assert.deepEqual(await fs.readFile(file), bytes);
    const duplicate = { ...recovered, verificationHistory: [...recovered.verificationHistory!, { ...verification }] };
    await core.atomicHdJson(path.join(core.hdDirectory(), job.key + '.json'), duplicate);
    await assert.rejects(core.readHdJob(job.key), /invalid_hd_manifest/);
    await core.atomicHdJson(path.join(core.hdDirectory(), job.key + '.json'), recovered);
    const originalOnlySource = '/uploads/verification-original.png', originalOnlyFile = path.join(process.cwd(), 'public' + originalOnlySource);
    await sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 11, g: 32, b: 53 } } }).png().toFile(originalOnlyFile);
    const originalOnly = (await core.requestHd(originalOnlySource, 0, false))!; await processJob(originalOnly.key);
    const originalReady = (await core.readHdJob(originalOnly.key))!; assert.equal(originalReady.format, 'original');
    const originalBytes = await fs.readFile(originalOnlyFile), originalAttempts = JSON.stringify(originalReady.attemptHistory);
    const originalReceipt = path.join(core.hdDirectory(), originalOnly.key + '.publish.json');
    await core.atomicHdJson(originalReceipt, { protocol: 'hd-publish-v2', executionId: originalReady.executionId,
      sourceVersion: originalReady.version, job: originalReady, temporary: '' });
    await processJob(originalOnly.key, { processor: (request, options) => {
      assert.equal(request.operation, 'verify-original');
      return runner.runHdImageProcessor(request, { ...options, applicationRoot, onSpawn: async identity => {
        await options?.onSpawn?.(identity);
        const durable = (await core.readHdJob(originalOnly.key))!;
        assert.equal(durable.verificationHistory![0].operation, 'verify-original');
        assert.deepEqual(durable.verificationHistory![0].processor, identity);
      } });
    } });
    const originalRecovered = (await core.readHdJob(originalOnly.key))!, originalVerification = originalRecovered.verificationHistory![0];
    assert.equal(originalRecovered.attempts, originalReady.attempts); assert.equal(JSON.stringify(originalRecovered.attemptHistory), originalAttempts);
    assert.equal(originalVerification.childClose?.code, 0); assert.equal(originalVerification.childClose?.signal, null);
    assert.equal(originalVerification.groupExit?.executionId, originalVerification.executionId); assert.ok(originalVerification.finishedAt);
    assert.deepEqual(await fs.readFile(originalOnlyFile), originalBytes);
    await core.atomicHdJson(receipt, { protocol: 'hd-publish-v2', executionId: recovered.executionId,
      sourceVersion: recovered.version, job: recovered, temporary: '' });
    const rename = fs.rename, manifest = path.join(core.hdDirectory(), job.key + '.json'); let refused = false;
    let failedVerification: runner.HdProcessorIdentity | undefined;
    fs.rename = async function (from, to) {
      if (!refused && to === manifest) {
        const value = JSON.parse(await fs.readFile(String(from), 'utf8'));
        if (value.verificationHistory?.length === 2 && value.verificationHistory[1].processor) {
          refused = true; throw Object.assign(new Error('synthetic_verification_spawn_write_failed'), { code: 'ENOSPC' });
        }
      }
      return rename(from, to);
    };
    try {
      await assert.rejects(processJob(job.key, { processor: (request, options) => runner.runHdImageProcessor(request, {
        ...options, applicationRoot, onSpawn: async identity => { failedVerification = identity; await options?.onSpawn?.(identity); },
      }) }), error => (error as NodeJS.ErrnoException).code === 'ENOSPC');
    } finally { fs.rename = rename; }
    assert.equal(refused, true); assert.ok(failedVerification); await runner.assertHdExecutionExited(failedVerification!);
    const failed = (await core.readHdJob(job.key))!;
    assert.equal(failed.attempts, recovered.attempts); assert.equal(JSON.stringify(failed.attemptHistory), originalAttempt);
    assert.deepEqual(failed.verificationHistory![1].processor, failedVerification);
    assert.equal(failed.verificationHistory![1].groupExit?.evidenceKind, 'process-group-gone');
    assert.equal(await exists(receipt), true); assert.deepEqual(await fs.readFile(file), bytes);
  });
  await check('E08 unknown process identity never authorizes kill or another encoder', async () => {
    await assert.rejects(runner.assertHdExecutionExited({ pid: process.pid, groupId: process.pid, host: os.hostname(), startTicks: '0', executionId: randomUUID() }), /hd_child_exit_unknown/);
    assert.equal(process.kill(process.pid, 0), true);
  });
  await check('E08 source boundary is global protection and never publishes a derivative', async () => {
    const directory = await fixture(); const original = await image('outside'); const job = (await core.requestHd(original.source, 0, false))!;
    const outside = path.join(directory, 'outside.png'); await fs.copyFile(original.file, outside);
    await fs.unlink(original.file); await fs.symlink(outside, original.file);
    await processJob(job.key);
    assert.equal((await core.readHdJob(job.key))!.status, 'failed'); assert.equal((await core.hdControl()).state, 'hard_pause');
    assert.equal(await exists(path.join(core.hdDirectory(), job.key + '.publish.json')), false);
  });
  await check('HD03 idle work does not read 1670 archives or rewrite scheduler; full reconciliation recovers missing hint', async () => {
    await fixture();
    const scheduler = await import('../src/lib/media/hd-scheduler');
    await scheduler.seedHdSchedulerFairness({ consecutiveViewer: 0, consecutiveForeground: 0 });
    const archive = Array.from({ length: 1670 }, (_, index) => ({ key: index.toString(16).padStart(64, '0'),
      source: '/uploads/archive-' + index + '.png', version: 'fixture-archive', policy: core.HD_POLICY,
      priority: 3, attempts: 1, preserveText: false, status: 'ready', format: 'original',
      bytes: 1, width: 1, height: 1, updatedAt: new Date().toISOString() }));
    for (let offset = 0; offset < archive.length; offset += 64) await Promise.all(archive.slice(offset, offset + 64)
      .map(job => fs.writeFile(path.join(core.hdDirectory(), job.key + '.json'), JSON.stringify(job))));
    const schedulerFile = path.join(core.hdDirectory(), 'scheduler-v1.json');
    const before = await fs.readFile(schedulerFile, 'utf8'), beforeStat = await fs.stat(schedulerFile);
    const reader = fs.readFile.bind(fs);
    let manifestReads = 0;
    const spy = mock.method(fs, 'readFile', (...args: Parameters<typeof fs.readFile>) => {
      if (/[/\\][a-f0-9]{64}\.json$/.test(String(args[0]))) manifestReads++;
      return reader(...args);
    });
    try {
      for (let index = 0; index < 3; index++) {
        const jobs = await scheduler.listHdScheduledJobs();
        assert.deepEqual(jobs, []);
        assert.equal(await scheduler.claimHdScheduledJob(jobs), null);
      }
      assert.equal(manifestReads, 0);
    } finally { spy.mock.restore(); }
    assert.equal(await fs.readFile(schedulerFile, 'utf8'), before);
    assert.equal((await fs.stat(schedulerFile)).ino, beforeStat.ino);
    const original = await image('reconcile-unindexed');
    ownerBindings = [{ id: 'fixture-owner-asset', owner_id: 'fixture-owner', original_url: original.source }];
    const job = (await core.requestHd(original.source, 0, false))!;
    const state = await scheduler.readHdScheduler();
    delete state.entries[job.key];
    await core.atomicHdJson(schedulerFile, state);
    assert.deepEqual(await scheduler.listHdScheduledJobs(), []);
    const all = await core.listHdJobs();
    assert.equal(all.length, 1671);
    assert.equal((await scheduler.claimHdScheduledJob(all))!.key, job.key);
    await scheduler.finishHdScheduledClaim(await core.readHdJob(job.key), job.key);
    // A registration arriving after a completed-history snapshot must survive.
    const second = await image('concurrent-registration');
    ownerBindings.push({ id: 'second-fixture-asset', owner_id: 'fixture-owner', original_url: second.source });
    const newJob = (await core.requestHd(second.source, 0, false))!;
    await scheduler.synchronizeHdScheduler(archive as Awaited<ReturnType<typeof core.listHdJobs>>);
    assert.ok((await scheduler.readHdScheduler()).entries[newJob.key]);
  });
  await check('HD03 A has frozen q90/e4 identity; legacy results and alpha protection survive strategy switches', async () => {
    await fixture();
    const encoder = await import('../src/lib/media/hd-encoder');
    const prior = process.env.HD_ENCODER_STRATEGY;
    try {
      const file = path.join(process.cwd(), 'public/uploads', 'a-recipe.png');
      const pixels = Buffer.alloc(256 * 192 * 3);
      let seed = 123456789;
      for (let index = 0; index < pixels.length; index++) {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; pixels[index] = seed & 255;
      }
      await sharp(pixels, { raw: { width: 256, height: 192, channels: 3 } }).png().toFile(file);
      const source = '/uploads/a-recipe.png', original = await fs.readFile(file);
      ownerBindings = [{ id: 'a-fixture-asset', owner_id: 'fixture-owner', original_url: source }];
      process.env.HD_ENCODER_STRATEGY = 'hd-avif-q90-e4-v1';
      const job = (await core.requestHd(source, 0, false))!;
      assert.equal(job.encoderStrategy, 'hd-avif-q90-e4-v1');
      assert.notEqual(job.key, (await core.hdRequestIdentity(source, false))!.key);
      assert.deepEqual(encoder.hdEncoderParameters('avif', job.encoderStrategy), { format: 'avif', lossless: false,
        effort: 4, orientation: 'auto', bitdepth: 8, quality: 90, chromaSubsampling: '4:4:4' });
      assert.equal(encoder.hdEncoderParameters('avif', 'hd-legacy-e6-v1').quality, 95);
      assert.equal(encoder.hdEncoderParameters('avif', 'hd-avif-e4-v1').quality, 95);
      assert.deepEqual(encoder.hdEncoderParameters('webp', job.encoderStrategy), encoder.hdEncoderParameters('webp'));
      await processJob(job.key);
      const ready = (await core.readHdJob(job.key))!;
      assert.equal(ready.status, 'ready');
      assert.equal(ready.format, 'avif', 'the combined-body fixture must actually publish compressed bytes');
      assert.equal(ready.width, 256); assert.equal(ready.height, 192);
      assert.deepEqual(await fs.readFile(file), original);
      const { authorizedImageResponse } = await import('../src/lib/media/authorized-image-response');
      const response = await authorizedImageResponse(new Request('https://fixture.invalid/api/image', {
        headers: { 'x-image-read-intent': 'status' },
      }), source, 'hd-description', 'image/png');
      const description = await response.json();
      assert.equal(response.status, 200); assert.equal(description.status, 'ready');
      assert.equal(description.encodingStrategy, undefined, 'Old open tabs must accept the optional recipe metadata');
      assert.equal(description.representationVersion, await core.hdRepresentationVersion(source, ready));
      const combined = await authorizedImageResponse(new Request('https://fixture.invalid/api/image', {
        headers: { 'X-Image-Read-Intent': 'status', 'X-Image-Accept': 'hd-open-v1' },
      }), source, 'hd-description', 'image/png');
      assert.equal(combined.headers.get('Content-Type'), ready.mime);
      const combinedDescription = JSON.parse(combined.headers.get('X-Image-HD-Description') || 'null');
      assert.equal(combinedDescription.sourceVersion, ready.version);
      assert.equal(combinedDescription.representationVersion, description.representationVersion);
      assert.equal(combined.headers.get('X-Image-Representation-Version'), description.representationVersion);
      assert.deepEqual(Buffer.from(await combined.arrayBuffer()), await fs.readFile(path.join(core.hdDirectory(), ready.file!)),
        'negotiated readonly Work-style reads deliver the exact published bytes');
      assert.match(combined.headers.get('Cache-Control')!, /private.*no-store/);
      for (const request of [new Request('https://fixture.invalid/api/image', { method: 'HEAD', headers: { 'X-Image-Accept': 'hd-open-v1' } }),
        new Request('https://fixture.invalid/api/image', { headers: { 'X-Image-Accept': 'hd-open-v1', 'X-Image-Read-Intent': 'prefetch' } })]) {
        const readonly = await authorizedImageResponse(request, source, 'hd-description', 'image/png');
        assert.equal(readonly.headers.get('X-Image-HD-Description'), null);
        assert.match(readonly.headers.get('Content-Type')!, /application\/json/);
        await readonly.body?.cancel();
      }
      const smallSource = '/uploads/combined-original.png';
      await sharp({ create: { width: 8, height: 8, channels: 3, background: '#999' } }).png().toFile(path.join(process.cwd(), 'public', smallSource));
      ownerBindings.push({ id: 'combined-original-asset', owner_id: 'fixture-owner', original_url: smallSource });
      const small = (await core.requestHd(smallSource, 0, false))!; await processJob(small.key);
      assert.equal((await core.readHdJob(small.key))?.format, 'original');
      const originalDescription = await authorizedImageResponse(new Request('https://fixture.invalid/api/image', {
        headers: { 'X-Image-Accept': 'hd-open-v1' },
      }), smallSource, 'hd-description', 'image/png');
      assert.equal(originalDescription.headers.get('X-Image-HD-Description'), null);
      assert.equal((await originalDescription.json()).original, true, 'raw fallback stays an explicit JSON choice, not a second hidden original body');
      process.env.HD_ENCODER_STRATEGY = 'hd-legacy-e6-v1';
      const reused = (await core.requestHd(source, 0, false))!;
      assert.equal(reused.key, ready.key); assert.equal(reused.attempts, ready.attempts);
      const alpha = await image('a-alpha');
      ownerBindings.push({ id: 'a-alpha-asset', owner_id: 'fixture-owner', original_url: alpha.source });
      const legacy = (await core.requestHd(alpha.source, 0, false))!;
      await processJob(legacy.key);
      process.env.HD_ENCODER_STRATEGY = 'hd-avif-q90-e4-v1';
      assert.equal((await core.requestHd(alpha.source, 0, false))!.key, legacy.key);
    } finally {
      if (prior === undefined) delete process.env.HD_ENCODER_STRATEGY; else process.env.HD_ENCODER_STRATEGY = prior;
    }
  });
  await check('HD03 WebP profile coexists with AVIF and preserves exact pinned reads', async () => {
    await fixture();
    const encoder = await import('../src/lib/media/hd-encoder');
    const strategy = encoder.hdEncoderStrategy('hd-webp-q93-e4-v1');
    const file = path.join(process.cwd(), 'public/uploads/webp-profile.png');
    const pixels = Buffer.alloc(256 * 192 * 3);
    let seed = 987654321;
    for (let index = 0; index < pixels.length; index++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; pixels[index] = seed & 255;
    }
    await sharp(pixels, { raw: { width: 256, height: 192, channels: 3 } }).png().toFile(file);
    const source = '/uploads/webp-profile.png', original = await fs.readFile(file);
    ownerBindings = [{ id: 'webp-profile-asset', owner_id: 'fixture-owner', original_url: source }];
    const legacy = (await core.requestHd(source, 0, false, undefined, undefined, 'hd-legacy-e6-v1'))!;
    await processJob(legacy.key);
    // Keep a real immutable output under an older-library key. A new direct
    // profile must not make this previously issued representation disappear.
    const oldManifest = (await core.readHdJob(legacy.key))!, oldKey = 'b'.repeat(64);
    await fs.rename(path.join(core.hdDirectory(), oldManifest.file!), path.join(core.hdDirectory(), oldKey + '.avif'));
    await core.atomicHdJson(path.join(core.hdDirectory(), oldKey + '.json'), { ...oldManifest, key: oldKey, file: oldKey + '.avif' });
    await fs.unlink(path.join(core.hdDirectory(), legacy.key + '.json'));
    const oldReady = (await core.lookupHd(source))!, oldVersion = (await core.hdRepresentationVersion(source, oldReady))!;
    assert.equal(oldReady.format, 'avif');
    const oldBytes = await fs.readFile(path.join(core.hdDirectory(), oldReady.file!));
    const queued = (await core.requestHd(source, 0, false, undefined, undefined, strategy))!;
    assert.notEqual(queued.key, legacy.key);
    assert.equal(queued.version, oldReady.version);
    assert.equal((await core.lookupHd(source))?.key, oldReady.key, 'a pending upgrade must keep the existing ready image');
    assert.equal((await core.requestHd(source, 0, false))?.key, oldReady.key, 'ordinary reads must not start another upgrade');
    await processJob(queued.key);
    const ready = (await core.lookupHd(source))!;
    assert.equal(ready.key, queued.key); assert.equal(ready.format, 'webp');
    assert.equal(ready.width, 256); assert.equal(ready.height, 192);
    assert.deepEqual(ready.parameters, { format: 'webp', lossless: false, effort: 4, orientation: 'auto', bitdepth: 8, quality: 93, smartSubsample: true });
    assert.equal((await core.lookupHd(source, oldVersion))?.key, oldReady.key);
    assert.deepEqual(await fs.readFile(path.join(core.hdDirectory(), oldReady.file!)), oldBytes);
    assert.deepEqual(await fs.readFile(file), original);
    const { authorizedImageResponse } = await import('../src/lib/media/authorized-image-response');
    const oldResponse = await authorizedImageResponse(new Request('https://fixture.invalid/image?hd-version=' + encodeURIComponent(oldReady.version)
      + '&hd-representation=' + encodeURIComponent(oldVersion)), source, 'hd', 'image/png');
    assert.equal(oldResponse.status, 200); assert.equal(oldResponse.headers.get('Content-Type'), 'image/avif');
    assert.deepEqual(Buffer.from(await oldResponse.arrayBuffer()), oldBytes);
    const oldHead = await authorizedImageResponse(new Request('https://fixture.invalid/image?hd-version=' + encodeURIComponent(oldReady.version)
      + '&hd-representation=' + encodeURIComponent(oldVersion), { method: 'HEAD' }), source, 'hd-download', 'image/png');
    assert.equal(oldHead.status, 200); assert.equal(oldHead.headers.get('Content-Type'), 'image/avif');
    assert.equal(oldHead.headers.get('X-Image-Representation-Version'), oldVersion);
    const current = await authorizedImageResponse(new Request('https://fixture.invalid/image', {
      headers: { 'X-Image-Read-Intent': 'status', 'X-Image-Accept': 'hd-open-v1' },
    }), source, 'hd-description', 'image/png');
    assert.equal(current.headers.get('Content-Type'), 'image/webp');
    assert.deepEqual(Buffer.from(await current.arrayBuffer()), await fs.readFile(path.join(core.hdDirectory(), ready.file!)));
    const description = await authorizedImageResponse(new Request('https://fixture.invalid/image', { method: 'HEAD' }), source, 'hd-description', 'image/png');
    assert.equal(description.headers.get('X-Image-HD-Description'), null);
    const json = await authorizedImageResponse(new Request('https://fixture.invalid/image', { headers: { 'X-Image-Read-Intent': 'status' } }), source, 'hd-description', 'image/png');
    assert.equal((await json.json()).encodingStrategy, undefined, 'old open tabs must accept the optional descriptor fields');
    const absent = await authorizedImageResponse(new Request('https://fixture.invalid/image?hd-representation=hd-representation-v1:' + '0'.repeat(64)), source, 'hd', 'image/png');
    assert.equal(absent.status, 409, 'an unknown representation must not receive another profile');
    await sharp({ create: { width: 32, height: 32, channels: 3, background: '#222' } }).png().toFile(file);
    const changed = await authorizedImageResponse(new Request('https://fixture.invalid/image?hd-version=' + encodeURIComponent(oldReady.version)
      + '&hd-representation=' + encodeURIComponent(oldVersion)), source, 'hd', 'image/png');
    assert.equal(changed.status, 409, 'keeping old profiles must not bypass a changed original');
  });
  await check('HD03 WebP profile keeps a smaller JPEG original', async () => {
    await fixture();
    const source = '/uploads/small-original.jpg', file = path.join(process.cwd(), 'public', source);
    const pixels = Buffer.alloc(512 * 512 * 3);
    for (let index = 0; index < pixels.length; index++) pixels[index] = (index * 37 + (index >>> 5)) % 256;
    await sharp(pixels, { raw: { width: 512, height: 512, channels: 3 } }).jpeg({ quality: 25 }).toFile(file);
    const original = await fs.readFile(file);
    ownerBindings.push({ id: 'small-original', owner_id: 'fixture-owner', original_url: source });
    const job = (await core.requestHd(source, 0, false, undefined, undefined, 'hd-webp-q93-e4-v1'))!;
    let encodedBytes = 0;
    await processJob(job.key, { processor: async (request, options) => {
      const result = await runner.runHdImageProcessor(request, { ...options, applicationRoot });
      encodedBytes = result.bytes!; return result;
    } });
    assert.ok(encodedBytes > original.length, 'exercise a real size increase');
    const ready = (await core.readHdJob(job.key))!;
    assert.equal(ready.status, 'ready'); assert.equal(ready.format, 'original');
    assert.equal(ready.reason, 'original_smaller'); assert.equal(ready.mime, 'image/jpeg');
    assert.equal(ready.bytes, original.length); assert.equal(ready.file, undefined);
    assert.deepEqual(await fs.readFile(file), original);
    const { authorizedImageResponse } = await import('../src/lib/media/authorized-image-response');
    const description = await authorizedImageResponse(new Request('https://fixture.invalid/image', {
      headers: { 'X-Image-Read-Intent': 'status', 'X-Image-Accept': 'hd-open-v1' },
    }), source, 'hd-description', 'image/jpeg');
    assert.equal(description.headers.get('Content-Type'), 'application/json');
    const descriptor = await description.json();
    assert.equal(descriptor.original, true); assert.equal(descriptor.bytes, original.length);
    const response = await authorizedImageResponse(new Request('https://fixture.invalid/image?hd-version=' + encodeURIComponent(ready.version)), source, 'hd', 'image/jpeg');
    assert.equal(response.status, 200); assert.equal(response.headers.get('Content-Type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
  });
  await check('HD03 WebP profile keeps alpha and text outputs lossless', async () => {
    await fixture();
    const encoder = await import('../src/lib/media/hd-encoder');
    const strategy = encoder.hdEncoderStrategy('hd-webp-q93-e4-v1');
    for (const preserveText of [false, true]) {
      const source = '/uploads/protected-' + preserveText + '.png', file = path.join(process.cwd(), 'public', source);
      const pixels = Buffer.alloc(128 * 96 * (preserveText ? 3 : 4));
      for (let index = 0; index < pixels.length; index++) pixels[index] = (index * 37 + (index >>> 5)) % 256;
      await sharp(pixels, { raw: { width: 128, height: 96, channels: preserveText ? 3 : 4 } }).png({ compressionLevel: 0 }).toFile(file);
      const original = await fs.readFile(file);
      ownerBindings.push({ id: 'protected-' + preserveText, owner_id: 'fixture-owner', original_url: source });
      const job = (await core.requestHd(source, 0, preserveText, undefined, undefined, strategy))!;
      await processJob(job.key);
      const ready = (await core.readHdJob(job.key))!;
      assert.equal(ready.status, 'ready'); assert.equal(ready.format, 'webp');
      assert.deepEqual(ready.parameters, { format: 'webp', lossless: true, effort: 4, orientation: 'auto', bitdepth: 8 });
      const output = path.join(core.hdDirectory(), ready.file!);
      const decoded = await sharp(output).raw().toBuffer(), input = await sharp(file).raw().toBuffer();
      if (preserveText) assert.deepEqual(decoded, input);
      else {
        assert.equal(decoded.length, input.length);
        for (let index = 0; index < input.length; index += 4) {
          assert.equal(decoded[index + 3], input[index + 3], 'the alpha channel must remain exact');
          // libwebp lossless normalizes invisible RGB at alpha=0 by default:
          // https://developers.google.com/speed/webp/docs/cwebp#lossless_options
          if (input[index + 3]) assert.deepEqual(decoded.subarray(index, index + 3), input.subarray(index, index + 3));
        }
      }
      assert.deepEqual(await fs.readFile(file), original);
    }
  });
  process.chdir(applicationRoot);
  await (await import('../src/lib/media/hd-readonly-db')).hdReadonlyDb.$disconnect();
  const summary = { completed: true, checks: results.map(value => value.name), results, total: results.length,
    passed: results.filter(value => value.passed).length, evidenceRoot, productionWrites: 0, providerRequests: 0, dbQueries: 0 };
  await fs.writeFile(path.join(evidenceRoot, 'results.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(summary)); process.exitCode = summary.passed === summary.total ? 0 : 1;
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
