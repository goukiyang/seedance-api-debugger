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
import sharp from '../src/lib/media/sharp';
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
let ownerBindings: Array<{ id: string; owner_id: string; original_url: string }> = [];
(globalThis as unknown as { hdReadonlyDb?: unknown }).hdReadonlyDb = {
  asset: { findMany: async () => ownerBindings, findFirst: async () => null },
  referenceImage: { findMany: async () => [] }, imageStudioTask: { findFirst: async () => null },
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
    ownerBindings = [];
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
    const directory = await fixture(); const original = await image('orphan');
    const identity = (await core.hdRequestIdentity(original.source, false))!;
    const workDirectory = path.join(directory, 'private-child'); await fs.mkdir(workDirectory, { mode: 0o700 });
    const identityFile = path.join(directory, 'child-identity.json'), prepared = path.join(directory, 'prepared');
    const holder = path.join(evidenceRoot, 'holder.mts');
    const request = { protocol: runner.HD_IMAGE_PROTOCOL, key: identity.key, executionId: randomUUID(), sourceVersion: identity.current.version,
      inputFile: identity.current.file, workDirectory, preserveText: false };
    await fs.writeFile(holder, `import fs from 'node:fs/promises';import processor from ${JSON.stringify(pathToFileURL(path.join(applicationRoot, 'src/lib/media/hd-image-processor.ts')).href)};await processor.runHdImageProcessor(${JSON.stringify(request)},{applicationRoot:${JSON.stringify(applicationRoot)},onSpawn:async i=>{await fs.writeFile(${JSON.stringify(identityFile)},JSON.stringify(i))},onPrepared:async()=>{await fs.writeFile(${JSON.stringify(prepared)},'prepared');return new Promise(()=>{})}});`, { mode: 0o600 });
    const loader = createRequire(path.join(applicationRoot, 'package.json')).resolve('tsx');
    const parent = spawn(process.execPath, ['--import', loader, holder], { stdio: ['ignore', 'ignore', 'pipe'] });
    let parentError = '';
    parent.stderr.on('data', chunk => { parentError = (parentError + chunk.toString()).slice(-8192); });
    const exited = new Promise<void>((resolve, reject) => { parent.once('error', reject); parent.once('exit', () => resolve()); });
    try {
      await waitFor(async () => {
        if (await exists(prepared)) return true;
        if (parent.exitCode !== null || parent.signalCode !== null) {
          throw new Error(`fixture_holder_exited:${parent.exitCode}:${parent.signalCode}:${parentError}`);
        }
        return false;
      });
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
  process.chdir(applicationRoot);
  await (await import('../src/lib/media/hd-readonly-db')).hdReadonlyDb.$disconnect();
  const summary = { completed: true, checks: results.map(value => value.name), results, total: results.length,
    passed: results.filter(value => value.passed).length, evidenceRoot, productionWrites: 0, providerRequests: 0, dbQueries: 0 };
  await fs.writeFile(path.join(evidenceRoot, 'results.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(summary)); process.exitCode = summary.passed === summary.total ? 0 : 1;
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
