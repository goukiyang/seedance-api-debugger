// Offline engineering matrix. Every write is confined to fresh private temp
// roots; no application DB queries, browser, provider, service or network calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from '../src/lib/media/sharp';
import { mock } from 'node:test';
import * as runner from '../src/lib/media/hd-image-processor';
import type { HdControl, HdResourceSample } from '../src/lib/media/hd-resource-state';
import { HD_CONTROL_PROTOCOL, HD_RESOURCE_POLICY, classifyHdResources, hdResourceTransition } from '../src/lib/media/hd-resource-state';

async function main() {
const applicationRoot = process.cwd();
Object.assign(process.env, { NODE_ENV: 'test' });
delete process.env.HD_DERIVATIVES_ROOT;
const evidenceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sd2-hd-stability-'));
await fs.chmod(evidenceRoot, 0o700);
// Set before importing the repository. The suite does not execute any SQL.
process.env.DATABASE_URL = `file:${path.join(evidenceRoot, 'unused-private.db')}`;
// Complete authoritative lookup fixture: scheduler ownership is exercised
// without opening the application's SQL database.
const { hdReadRepository } = await import('../src/lib/media/hd-readonly-db');
mock.method(hdReadRepository, 'assetsAtUrls', async () => []);
mock.method(hdReadRepository, 'referencesAtUrls', async () => []);
mock.method(hdReadRepository, 'nextAssets', async () => []);
mock.method(hdReadRepository, 'nextTasks', async () => []);
mock.method(hdReadRepository, 'close', async () => {});
const moduleCore = await import('../src/lib/media/hd-derivatives');
const core = { ...moduleCore, processHdJob: (...args: Parameters<typeof moduleCore.processHdJob>) => moduleCore.processHdJob(args[0], args[1], {
  ...args[2], processor: (request, options) => runner.runHdImageProcessor(request, { ...options, applicationRoot }),
}) };
const discovery = await import('../src/lib/media/hd-discovery');
const results: Array<{ name: string; passed: boolean; error?: string; directory?: string }> = [];
let clock = Date.now();
const safeCapacity = async () => ({ rootFree: 10 * 1024 ** 3, dataFree: 20 * 1024 ** 3,
  rootReserve: 512000 * 1024, dataReserve: 2 * 1024 ** 3, separateDataMount: true, safe: true });
const observed = (load1 = 1, overrides: Partial<HdResourceSample> = {}): HdResourceSample => classifyHdResources({
  checkedAt: new Date(clock).toISOString(), load1, cpuCount: 4, availableMemory: 4 * 1024 ** 3, capacitySafe: true, ...overrides,
}, false);
const active = (): HdControl => ({ paused: false, state: 'active', revision: 0, token: 'fixture', protocol: HD_CONTROL_PROTOCOL });
const transition = (value: HdControl, sample: HdResourceSample, manual = false): HdControl => {
  const next = hdResourceTransition(value, sample, clock, manual);
  return next ? { ...next, token: value.token } : value;
};
async function check(name: string, run: () => Promise<void> | void) {
  try { await run(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) }); }
}
async function inPrivateRoot(name: string, run: () => Promise<void>) {
  const directory = await fs.mkdtemp(path.join(evidenceRoot, 'case-'));
  await fs.chmod(directory, 0o700);
  await fs.mkdir(path.join(directory, '.media/uploads'), { recursive: true });
  await fs.mkdir(path.join(directory, 'storage/hd-derivatives'), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(directory, 'src/lib/media'), { recursive: true });
  await fs.copyFile(path.join(applicationRoot, 'src/lib/media/hd-derivatives.ts'), path.join(directory, 'src/lib/media/hd-derivatives.ts'));
  await fs.copyFile(path.join(applicationRoot, 'src/lib/media/hd-encoder.ts'), path.join(directory, 'src/lib/media/hd-encoder.ts'));
  process.chdir(directory); clock = Date.now();
  await check(name, run);
  results[results.length - 1].directory = directory;
  process.chdir(applicationRoot);
}
async function image(name: string, alpha: 'none' | 'opaque' | 'transparent' = 'none') {
  const width = 128, height = 96, channels = alpha === 'none' ? 3 : 4;
  const bytes = Buffer.alloc(width * height * channels);
  for (let pixel = 0; pixel < width * height; pixel++) {
    bytes[pixel * channels] = (pixel * 13) % 256;
    bytes[pixel * channels + 1] = (Math.floor(pixel / width) * 7) % 256;
    bytes[pixel * channels + 2] = 93;
    if (channels === 4) bytes[pixel * channels + 3] = alpha === 'transparent' && pixel % 3 === 0 ? 80 : 255;
  }
  const file = path.join(process.cwd(), '.media/uploads', `${name}.png`);
  await sharp(bytes, { raw: { width, height, channels: channels as 3 | 4 } }).png().toFile(file);
  return { file, source: `/uploads/${name}.png` };
}
async function recheck(load1 = 1, overrides: Partial<HdResourceSample> = {}, allowManualResume = false) {
  const value = observed(load1, overrides);
  return core.recheckHdResources({ sample: async () => value, clock: () => clock, allowManualResume });
}
async function settleWait() {
  for (const offset of [0, 15_000, 30_000]) {
    const start = clock; clock = start + offset;
    await recheck();
  }
}

await check('normal resources admit; spike waits; wait state is safe for old worker', () => {
  let value = transition(active(), observed()); assert.equal(value.paused, false);
  value = transition(value, observed(7)); assert.equal(value.state, 'resource_wait');
  assert.equal(value.paused, true); assert.equal(value.reason, 'resource_wait');
  assert.ok(value.wait); assert.equal(value.wait!.stableSamples, 0);
});
await check('persistent busy checks have finite 5–60s backoff; no automatic admission', () => {
  let value = active();
  for (let iteration = 0; iteration < 20; iteration++) {
    value = transition(value, observed(8));
    const delay = Date.parse(value.wait!.nextCheckAt) - clock;
    assert.ok(delay >= HD_RESOURCE_POLICY.minimumCheckMs && delay <= HD_RESOURCE_POLICY.maximumCheckMs);
    assert.equal(value.paused, true); clock += delay;
  }
});
await check('stable recovery requires separated samples and a full stable window', () => {
  let value = transition(active(), observed(8)); clock += 5000;
  value = transition(value, observed()); assert.equal(value.paused, true);
  value = transition(value, observed()); assert.equal(value.wait!.stableSamples, 1);
  clock += 15_000; value = transition(value, observed()); assert.equal(value.paused, true);
  clock += 15_000; value = transition(value, observed()); assert.equal(value.paused, false);
});
await check('threshold oscillation and recovery gaps reset stability', () => {
  let value = transition(active(), observed(7));
  clock += 20_000; value = transition(value, observed(4.2)); assert.equal(value.wait!.stableSamples, 1);
  clock += 20_000; value = transition(value, observed(4.7)); assert.equal(value.wait!.stableSamples, 0);
  clock += 20_000; value = transition(value, observed(4.2)); assert.equal(value.paused, true);
  clock += 100_000; value = transition(value, observed(4.2)); assert.equal(value.wait!.stableSamples, 1);
});
await check('memory hysteresis; unavailable sampling holds claims; stale sampling cannot release', () => {
  const lowMemory = transition(active(), observed(1, { availableMemory: 0.5 * 1024 ** 3 })); assert.equal(lowMemory.state, 'resource_wait');
  const belowExit = transition(lowMemory, observed(1, { availableMemory: 1.1 * 1024 ** 3 })); assert.equal(belowExit.wait!.stableSamples, 0);
  const unknown = transition(active(), observed(1, { availableMemory: null })); assert.equal(unknown.resource!.result, 'unknown'); assert.equal(unknown.paused, true);
  const stale = transition(active(), observed(1, { checkedAt: new Date(clock - 20_000).toISOString() })); assert.equal(stale.paused, true);
});
await check('disk/unknown storage are hard stops; manual/integrity stops never auto-release', () => {
  for (const capacitySafe of [false, null]) assert.equal(transition(active(), observed(1, { capacitySafe })).state, 'hard_pause');
  for (const reason of ['admin_pause', 'output_integrity', 'capacity_guard', 'unknown_protection']) {
    const value: HdControl = { ...active(), paused: true, reason, state: reason === 'admin_pause' ? 'manual_pause' : 'hard_pause' };
    assert.deepEqual(transition(value, observed()), value);
  }
});
await check('legacy load stop migrates only after safe fresh sampling and stable recovery', () => {
  let value: HdControl = { ...active(), protocol: undefined, paused: true, reason: 'load_guard', state: 'hard_pause' };
  value = transition(value, observed(8)); assert.equal(value.reason, 'load_guard'); assert.equal(value.paused, true);
  clock += 60_000; value = transition(value, observed()); assert.equal(value.state, 'resource_wait'); assert.equal(value.paused, true);
  clock += 15_000; value = transition(value, observed()); assert.equal(value.paused, true);
  clock += 15_000; value = transition(value, observed()); assert.equal(value.state, 'active');
});

await inPrivateRoot('durable waiting survives restart and manual pause wins resource recovery', async () => {
  await recheck(8); const waiting = await core.hdControl();
  assert.equal(waiting.paused, true); assert.equal(waiting.protocol, HD_CONTROL_PROTOCOL);
  assert.deepEqual((await core.hdControl()).wait, waiting.wait);
  await core.setHdControl(true, 'admin_pause', waiting.token);
  await recheck(); assert.equal((await core.hdControl()).reason, 'admin_pause');
  await recheck(8, {}, true); assert.equal((await core.hdControl()).state, 'resource_wait');
  await core.setHdControl(true, 'admin_pause'); await settleWait(); assert.equal((await core.hdControl()).state, 'manual_pause');
});
await inPrivateRoot('unknown sampling does not claim; persisted stable wait resumes the original queue', async () => {
  const input = await image('wait-restart'); const job = (await core.requestHd(input.source, 0, false))!;
  await recheck(1, { availableMemory: null });
  await core.processHdJob(job.key, undefined, { capacity: safeCapacity });
  assert.equal((await core.readHdJob(job.key))!.attempts, 0);
  clock += 5000; await recheck(); const stable = await core.hdControl(); assert.equal(stable.state, 'resource_wait');
  clock += 15_000; await recheck(); assert.equal((await core.hdControl()).paused, true);
  clock += 15_000; await recheck(); assert.equal((await core.hdControl()).state, 'active');
  await core.processHdJob(job.key, undefined, { capacity: safeCapacity }); assert.equal((await core.readHdJob(job.key))!.status, 'ready');
});
await inPrivateRoot('late checks cannot overwrite admin or a new hard pause; CAS rejects stale token', async () => {
  for (const reason of ['admin_pause', 'output_integrity']) {
    await fs.unlink(path.join(core.hdDirectory(), 'control.json')).catch(() => {});
    let release!: (value: HdResourceSample) => void, entered!: () => void;
    const sampling = new Promise<HdResourceSample>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const before = await core.hdControl();
    const checking = core.recheckHdResources({ sample: () => { entered(); return sampling; }, clock: () => clock });
    await started; await core.setHdControl(true, reason);
    release(observed()); const result = await checking;
    assert.equal(result.conflict, true); assert.equal(result.control.reason, reason);
    await assert.rejects(core.setHdControl(true, 'admin_pause', before.token), /hd_control_conflict/);
  }
});
await inPrivateRoot('legacy bytes acquire revisions; busy old state remains safe; hard recheck rejects', async () => {
  const file = path.join(core.hdDirectory(), 'control.json');
  await core.atomicHdJson(file, { paused: true, reason: 'load_guard', updatedAt: new Date(clock).toISOString() });
  const legacy = await core.hdControl(); assert.equal(legacy.revision, 0);
  await recheck(8); const busy = await core.hdControl(); assert.equal(busy.reason, 'load_guard'); assert.ok(busy.revision > 0);
  clock += 60_000; await recheck(); assert.equal((await core.hdControl()).state, 'resource_wait');
  await core.setHdControl(true, 'output_integrity');
  await assert.rejects(core.recheckHdResources({ sample: async () => observed(), clock: () => clock }), /hd_hard_pause_requires_review/);
  await core.setHdControl(true, 'admin_pause'); assert.equal((await core.hdControl()).reason, 'output_integrity');
});
await inPrivateRoot('discovery persists missing/unreadable/remote outcomes before cursor; bounded retry', async () => {
  const missing = { id: 'asset-missing', source: '/uploads/missing.png', preserveText: false };
  const cursor = { at: new Date(clock).toISOString(), id: missing.id };
  const registered = await discovery.commitHdDiscoveryItem('assets', cursor, missing, { clock: () => clock });
  assert.equal(registered.durable, true); assert.equal(registered.isolated, true);
  assert.deepEqual((await discovery.readHdDiscoveryCheckpoint()).assets, cursor);
  for (let iteration = 0; iteration < 4; iteration++) {
    clock += 31 * 60_000;
    await discovery.registerHdDiscovery(missing, { clock: () => clock });
  }
  const item = (await discovery.listHdIsolations()).find(value => value.id === missing.id)!;
  assert.equal(item.attempts, HD_RESOURCE_POLICY.isolationRetries); assert.equal(item.retryAt, undefined);
  await discovery.registerHdDiscovery({ id: 'unreadable', source: '/uploads/unreadable.png', preserveText: false },
    { request: async () => { throw new Error('source_unreadable'); } });
  await discovery.registerHdDiscovery({ id: 'remote', source: 'https://example.invalid/image.png', preserveText: false });
  assert.equal((await discovery.listHdIsolations()).length, 3);
});
await inPrivateRoot('unknown DB/shared permission/lease errors do not advance discovery; registration conflict stays pending', async () => {
  const before = await discovery.readHdDiscoveryCheckpoint();
  await core.atomicHdJson(path.join(core.hdDirectory(), 'discovery.json'), before);
  for (const message of ['database_unavailable', 'EACCES_shared', 'hd_lease_conflict', 'output_integrity']) {
    await assert.rejects(discovery.commitHdDiscoveryItem('assets', { at: new Date(clock).toISOString(), id: message },
      { id: message, source: '/uploads/file.png', preserveText: false }, { request: async () => { throw new Error(message); } }), new RegExp(message));
    assert.deepEqual(await discovery.readHdDiscoveryCheckpoint(), before);
  }
  const pending = await discovery.commitHdDiscoveryItem('assets', { at: new Date(clock).toISOString(), id: 'pending' },
    { id: 'pending', source: '/uploads/file.png', preserveText: false }, { request: async () => { throw new Error('hd_registration_pending'); } });
  assert.equal(pending.durable, false); assert.deepEqual(await discovery.readHdDiscoveryCheckpoint(), before);
});
await inPrivateRoot('shared directories require traversal; denied shared access is hard and never per-image isolation', async () => {
  const modes: number[] = [];
  await core.assertHdDirectoryAccess(async (_target, mode = 0) => { modes.push(mode); });
  assert.deepEqual(modes, [core.HD_UPLOAD_DIRECTORY_ACCESS, core.HD_OUTPUT_DIRECTORY_ACCESS]);
  assert.equal(core.HD_UPLOAD_DIRECTORY_ACCESS, 5); assert.equal(core.HD_OUTPUT_DIRECTORY_ACCESS, 7);
  const sharedDenied = async () => core.assertHdDirectoryAccess(async () => {
    throw Object.assign(new Error('shared_directory_not_traversable'), { code: 'EACCES' });
  });
  await assert.rejects(discovery.commitHdDiscoveryItem('assets', { at: new Date(clock).toISOString(), id: 'shared-denied' },
    { id: 'shared-denied', source: '/uploads/file.png', preserveText: false }, { request: async () => { await sharedDenied(); return null; } }), /shared_directory_not_traversable/);
  assert.equal((await discovery.listHdIsolations()).length, 0);
  await recheck(1, { capacitySafe: null }); assert.equal((await core.hdControl()).state, 'hard_pause');
  assert.equal((await core.hdControl()).reason, 'storage_check_unknown');
});
await inPrivateRoot('resource wait permits bounded discovery; good/missing/transparent entries remain independent', async () => {
  const good = await image('good'), transparent = await image('transparent', 'transparent');
  await recheck(8);
  const found = await discovery.withHdDiscovery(async () => {
    for (const [index, source] of Array.from([good.source, '/uploads/missing.png', transparent.source].entries())) {
      await discovery.commitHdDiscoveryItem('assets', { at: new Date(clock).toISOString(), id: `asset-${index}` },
        { id: `asset-${index}`, source, preserveText: false });
    }
    return 3;
  });
  assert.equal(found, 3); assert.equal((await core.listHdJobs()).length, 2); assert.equal((await discovery.listHdIsolations()).length, 1);
  await core.setHdControl(true, 'admin_pause');
  assert.equal(await discovery.withHdDiscovery(async () => { throw new Error('must-not-run'); }), null);
});
await inPrivateRoot('ready registration de-duplicates across discovery restart/version overlap', async () => {
  const good = await image('good'); const job = (await core.requestHd(good.source, 0, false))!;
  await core.processHdJob(job.key, undefined, { capacity: safeCapacity });
  const ready = (await core.readHdJob(job.key))!; assert.equal(ready.status, 'ready');
  for (let index = 0; index < 3; index++) {
    await discovery.registerHdDiscovery({ id: 'same-asset', source: good.source, preserveText: false });
    await core.processHdJob(job.key, undefined, { capacity: safeCapacity });
  }
  assert.equal((await core.readHdJob(job.key))!.attempts, ready.attempts); assert.equal((await core.listHdJobs()).length, 1);
  const originalStat = await fs.stat(good.file); assert.equal(ready.version, `${originalStat.dev}:${originalStat.ino}:${originalStat.size}:${originalStat.mtimeMs}:${originalStat.ctimeMs}`);
});
await inPrivateRoot('missing/incompatible source does not stop good work; transparent and opaque alpha preserve integrity', async () => {
  const missing = await image('missing'), good = await image('good'), transparent = await image('alpha', 'transparent'), opaque = await image('opaque', 'opaque');
  const missingJob = (await core.requestHd(missing.source, 0, false))!; await fs.unlink(missing.file);
  await core.processHdJob(missingJob.key, undefined, { capacity: safeCapacity });
  const isolated = (await core.readHdJob(missingJob.key))!; assert.equal(isolated.reason, 'source_missing'); assert.ok(isolated.retryAt);
  assert.equal((await core.hdControl()).paused, false);
  for (const input of [good, transparent, opaque]) {
    const job = (await core.requestHd(input.source, 0, false))!;
    await core.processHdJob(job.key, undefined, { capacity: safeCapacity });
    const ready = (await core.readHdJob(job.key))!;
    assert.equal(ready.status, 'ready'); assert.equal(ready.integrity!.version, core.HD_VALIDATION_VERSION); assert.deepEqual(ready.integrity!.failedChecks, []);
    if (input === transparent || input === opaque) assert.equal(ready.format, 'webp');
  }
  await fs.writeFile(path.join(process.cwd(), '.media/uploads/invalid.png'), 'not an image');
  const incompatible = (await core.requestHd('/uploads/invalid.png', 0, false))!;
  await core.processHdJob(incompatible.key, undefined, { capacity: safeCapacity });
  assert.equal((await core.readHdJob(incompatible.key))!.status, 'skipped'); assert.equal((await core.hdControl()).paused, false);
});
await inPrivateRoot('real integrity mismatch never publishes ready and cannot be resource-resumed', async () => {
  const good = await image('integrity');
  const bad = path.join(process.cwd(), 'bad.webp'); await sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } }).webp().toFile(bad);
  const job = (await core.requestHd(good.source, 0, false))!;
  await core.processHdJob(job.key, undefined, { capacity: safeCapacity,
    validate: (input, meta, _output, format) => core.validateHdOutput(input, meta, bad, format) });
  const failed = (await core.readHdJob(job.key))!; assert.equal(failed.status, 'failed'); assert.equal(failed.reason, 'output_integrity');
  assert.ok(failed.integrity!.failedChecks.includes('width')); assert.equal((await core.hdControl()).reason, 'output_integrity');
  await assert.rejects(recheck(), /hd_hard_pause_requires_review/);
});
await inPrivateRoot('unclassified decode/processing failure remains global hard protection', async () => {
  const input = await image('unclassified'); const job = (await core.requestHd(input.source, 0, false))!;
  await core.processHdJob(job.key, undefined, { capacity: safeCapacity, validate: async () => { throw new Error('unclassified_decode_failure'); } });
  assert.equal((await core.readHdJob(job.key))!.status, 'failed');
  assert.equal((await core.hdControl()).reason, 'worker_integrity_failure');
  await assert.rejects(recheck(), /hd_hard_pause_requires_review/);
});
await inPrivateRoot('new hard pause during encode wins final publication; lease conflict never steals unknown owner', async () => {
  const good = await image('publish-held'); const job = (await core.requestHd(good.source, 0, false))!;
  await core.processHdJob(job.key, undefined, { capacity: safeCapacity, beforePublish: () => core.setHdControl(true, 'output_integrity').then(() => {}) });
  assert.equal((await core.readHdJob(job.key))!.status, 'queued'); assert.equal((await core.hdControl()).reason, 'output_integrity');
  const lock = path.join(core.hdDirectory(), `${'a'.repeat(64)}.lock`); await fs.mkdir(lock);
  await fs.utimes(lock, new Date(Date.now() - 20_000), new Date(Date.now() - 20_000));
  await assert.rejects(core.withHdLease('a'.repeat(64), async () => true), /hd_lease_conflict/);
  assert.ok((await fs.stat(lock)).isDirectory());
});
await inPrivateRoot('processing restart keeps history; publish-before-manifest restart registers without re-encoding', async () => {
  const good = await image('restart'); const job = (await core.requestHd(good.source, 0, false))!;
  await core.atomicHdJson(path.join(core.hdDirectory(), `${job.key}.json`), { ...job, status: 'running', attempts: 1,
    attemptHistory: [{ attempt: 1, startedAt: new Date(clock - 60_000).toISOString(), sourceVersion: job.version, status: 'running' }] });
  await core.processHdJob(job.key, undefined, { capacity: safeCapacity });
  const ready = (await core.readHdJob(job.key))!;
  assert.equal(ready.status, 'ready'); assert.equal(ready.attempts, 2); assert.equal(ready.attemptHistory![0].reason, 'worker_interrupted');
  await core.atomicHdJson(path.join(core.hdDirectory(), `${job.key}.json`), { ...ready, status: 'running' });
  await core.atomicHdJson(path.join(core.hdDirectory(), `${job.key}.publish.json`), { job: ready, temporary: '' });
  await core.processHdJob(job.key, undefined, { capacity: async () => { throw new Error('must-not-encode'); } });
  assert.equal((await core.readHdJob(job.key))!.status, 'ready'); assert.equal((await core.readHdJob(job.key))!.attempts, ready.attempts);
  await assert.rejects(fs.stat(path.join(core.hdDirectory(), `${job.key}.publish.json`)), /ENOENT/);
});
await inPrivateRoot('publish receipt before rename survives restart; missing durable output is never declared ready', async () => {
  const input = await image('rename-restart', 'transparent'); const job = (await core.requestHd(input.source, 0, false))!;
  await core.processHdJob(job.key, undefined, { capacity: safeCapacity });
  const ready = (await core.readHdJob(job.key))!; assert.equal(ready.format, 'webp');
  const temporary = `${ready.file}.12345678-1234-1234-1234-123456789abc.tmp`;
  await fs.rename(path.join(core.hdDirectory(), ready.file!), path.join(core.hdDirectory(), temporary));
  await core.atomicHdJson(path.join(core.hdDirectory(), `${job.key}.json`), { ...ready, status: 'running' });
  await core.atomicHdJson(path.join(core.hdDirectory(), `${job.key}.publish.json`), { job: ready, temporary });
  await core.processHdJob(job.key, undefined, { capacity: async () => { throw new Error('must-not-encode'); } });
  assert.equal((await core.readHdJob(job.key))!.attempts, ready.attempts); assert.equal((await core.readHdJob(job.key))!.status, 'ready');
  await fs.unlink(path.join(core.hdDirectory(), ready.file!));
  await core.atomicHdJson(path.join(core.hdDirectory(), `${job.key}.json`), { ...ready, status: 'running' });
  await core.atomicHdJson(path.join(core.hdDirectory(), `${job.key}.publish.json`), { job: ready, temporary });
  await assert.rejects(core.processHdJob(job.key, undefined, { capacity: safeCapacity }));
  assert.notEqual((await core.readHdJob(job.key))!.status, 'ready'); assert.equal((await core.hdControl()).paused, true);
});
await inPrivateRoot('known live lease is respected; proven dead local owner can be recovered without touching jobs', async () => {
  const key = 'c'.repeat(64), lock = path.join(core.hdDirectory(), `${key}.lock`);
  await fs.mkdir(lock);
  await core.atomicHdJson(path.join(lock, 'owner.json'), { pid: process.pid, host: os.hostname(), token: 'live-fixture' });
  assert.equal(await core.withHdLease(key, async () => { throw new Error('must-not-run'); }), null);
  // Obtain a genuinely exited local PID, rather than guessing a missing process.
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error('private_fixture_process_failed'))); });
  await core.atomicHdJson(path.join(lock, 'owner.json'), { pid: child.pid, host: os.hostname(), token: 'dead-fixture' });
  assert.equal(await core.withHdLease(key, async () => 'recovered'), 'recovered');
  await assert.rejects(fs.stat(lock), /ENOENT/); assert.equal((await core.listHdJobs()).length, 0);
});
await check('fairness keeps each fifth opportunity for old batch; isolated waits do not block good work', () => {
  const base = { source: '/uploads/fixture.png', version: 'version', policy: core.HD_POLICY, status: 'queued' as const,
    attempts: 0, preserveText: false, updatedAt: new Date(clock).toISOString() };
  const newer = { ...base, key: 'a'.repeat(64), priority: 0 };
  const older = { ...base, key: 'b'.repeat(64), priority: 3, batch: 'old' };
  for (const opportunity of [0, 1, 2, 3]) assert.equal(core.selectHdJob([older, newer], opportunity, 'old')!.key, newer.key);
  assert.equal(core.selectHdJob([older, newer], 4, 'old')!.key, older.key);
  assert.equal(core.selectHdJob([{ ...newer, retryAt: new Date(clock + 60_000).toISOString() }, older], 0, 'old', clock)!.key, older.key);
});
await inPrivateRoot('legacy discovery boundary replays safely; malformed checkpoint never silently resets', async () => {
  const checkpoint = path.join(core.hdDirectory(), 'discovery.json');
  await core.atomicHdJson(checkpoint, { since: new Date(clock).toISOString() });
  assert.equal(Date.parse((await discovery.readHdDiscoveryCheckpoint()).assets.at), clock - 1000);
  await core.atomicHdJson(checkpoint, { since: 'invalid' });
  await assert.rejects(discovery.readHdDiscoveryCheckpoint(), /invalid_discovery_checkpoint/);
});
process.chdir(applicationRoot);
await hdReadRepository.close();
mock.restoreAll();
const summary = { completed: true, checks: results.map(result => result.name), results, evidenceRoot, total: results.length, passed: results.filter(result => result.passed).length,
  productionWrites: 0, providerRequests: 0, dbQueries: 0 };
await fs.writeFile(path.join(evidenceRoot, 'results.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
console.log(JSON.stringify(summary));
process.exitCode = results.every(result => result.passed) ? 0 : 1;
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
