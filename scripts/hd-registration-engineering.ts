import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { mock } from 'node:test';
import sharp from '../src/lib/media/sharp';

process.exitCode = 1;

/** Real SQLite settlement and HD registration, confined to a fresh private root. */
async function main() {
  const applicationRoot = await fs.realpath(process.cwd());
  const runId = process.env.IMAGE_RECOVERY_GATE_RUN_ID;
  assert.match(runId || '', /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sd2-hd-registration-'));
  await fs.chmod(directory, 0o700);
  const oldUmask = process.umask(0o077);
  const require = createRequire(import.meta.url);
  const databasePath = path.join(directory, 'synthetic.db');
  assert.equal(Reflect.get(globalThis, 'prisma'), undefined);
  delete process.env.HD_DERIVATIVES_ROOT; delete process.env.HD_DERIVATIVES_DIR;
  process.env.DATABASE_URL = `file:${databasePath}`;
  process.env.HD_DERIVATIVES_ROOT = path.join(directory, 'storage/hd-derivatives');
  Object.assign(process.env, { NODE_ENV: 'test' });
  Reflect.set(globalThis, 'AsyncLocalStorage', AsyncLocalStorage);
  await fs.mkdir(process.env.HD_DERIVATIVES_ROOT, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(directory, 'public/uploads'), { recursive: true });
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL,
    PRISMA_GENERATE_SKIP_AUTOINSTALL: '1', NEXT_TELEMETRY_DISABLED: '1' };
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) if (process.env[name]) env[name] = process.env[name];
  const prismaCli = path.join(path.dirname(require.resolve('prisma/package.json')), 'build/index.js');
  const schemaLog = execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate', '--schema',
    path.join(applicationRoot, 'prisma/schema.prisma')], { cwd: directory, env, encoding: 'utf8', timeout: 120000 });
  await fs.writeFile(path.join(directory, 'schema.log'), schemaLog, { mode: 0o600 });
  const { prisma } = require('../src/lib/prisma') as typeof import('../src/lib/prisma');
  const { hdReadonlyDb } = require('../src/lib/media/hd-readonly-db') as typeof import('../src/lib/media/hd-readonly-db');
  const core = require('../src/lib/media/hd-derivatives') as typeof import('../src/lib/media/hd-derivatives');
  const { registerCommittedStudioHd } = require('../src/lib/media/hd-registration') as typeof import('../src/lib/media/hd-registration');
  const { finishStudioTask } = require('../src/lib/image-studio/tasks') as typeof import('../src/lib/image-studio/tasks');
  const { finishRejectedStudioDimensions } = require('../src/lib/image-studio/dimension-rejection') as typeof import('../src/lib/image-studio/dimension-rejection');
  const { prepareStudioOutput } = require('../src/lib/image-studio/output') as typeof import('../src/lib/image-studio/output');
  const { beginStudioRequest } = require('../src/lib/image-studio/delivery') as typeof import('../src/lib/image-studio/delivery');
  const { registerHdDiscovery } = require('../src/lib/media/hd-discovery') as typeof import('../src/lib/media/hd-discovery');
  const checks: string[] = [];
  let forbiddenCalls = 0;
  const blocked = () => { forbiddenCalls++; throw Error('External requests prohibited in HD registration fixture'); };
  mock.method(globalThis, 'fetch', blocked); mock.method(http, 'request', blocked); mock.method(http, 'get', blocked);
  mock.method(https, 'request', blocked); mock.method(https, 'get', blocked);
  process.chdir(directory);
  try {
    await prisma.user.create({ data: { id: 'hd-owner', name: 'Synthetic HD owner', username: 'hd-owner',
      email: 'hd-owner@isolated.invalid', password_hash: 'synthetic-not-a-password' } });
    await prisma.creditAccount.create({ data: { user_id: 'hd-owner', balance: 100, frozen_credits: 5 } });
    const original = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 41, g: 93, b: 120 } } }).png().toBuffer();
    const createTask = (id: string, unitCredits = 0) => prisma.imageStudioTask.create({ data: {
      id, batch_id: id, owner_id: 'hd-owner', ordinal: 1, fingerprint: `synthetic-${id}`, prompt: '', context: '', revision: 0,
      model: 'gpt-image-2.5-flare', reference_ids: '[]', unit_credits: unitCredits, status: 'running',
      lease_token: `lease-${id}`, lease_until: new Date(Date.now() + 600_000),
      ...(unitCredits ? { freeze_snapshot: JSON.stringify([{ source_type: 'balance', amount: unitCredits }]) } : {}),
    } });
    const snapshot = async (taskId: string) => JSON.stringify({
      task: await prisma.imageStudioTask.findUniqueOrThrow({ where: { id: taskId } }),
      account: await prisma.creditAccount.findUniqueOrThrow({ where: { user_id: 'hd-owner' } }),
      ledger: await prisma.creditLedger.findMany({ where: { related_task_id: taskId }, orderBy: { id: 'asc' } }),
    });
    const task = await createTask('hd-commit', 5);
    const prepared = await prepareStudioOutput(original, task, { width: 16, height: 16 }, async () => {});
    prepared.metadata_json = JSON.stringify({ preserveText: true });
    const before = await snapshot(task.id);
    assert.equal(await registerCommittedStudioHd(task.id), false);
    await assert.rejects(prisma.$transaction(async tx => {
      assert.equal(await finishStudioTask(task, 'succeeded', { preparedAsset: prepared }, tx), true);
      assert.equal(await tx.creditLedger.count({ where: { related_task_id: task.id } }), 1);
      assert.equal((await core.listHdJobs()).length, 0, 'No registration inside the outer transaction');
      throw Error('synthetic_outer_rollback');
    }), /synthetic_outer_rollback/);
    assert.equal(await snapshot(task.id), before);
    assert.equal(await prisma.asset.count(), 0);
    assert.equal(await registerCommittedStudioHd(task.id), false);
    assert.equal((await core.listHdJobs()).length, 0);
    checks.push('outer_transaction_rollback_never_registers_or_changes_settlement');

    assert.equal(await finishStudioTask(task, 'succeeded', { preparedAsset: prepared }), true);
    const committed = await snapshot(task.id);
    assert.equal(await registerCommittedStudioHd(task.id), true);
    const [job] = await core.listHdJobs(); assert.ok(job); assert.equal(job.preserveText, true);
    assert.equal(job.source, prepared.original_url); assert.equal(job.attempts, 0);
    const compressed = await sharp(original).webp({ lossless: true }).toBuffer();
    const file = `${job.key}.webp`;
    await fs.writeFile(path.join(core.hdDirectory(), file), compressed, { mode: 0o600 });
    const ready = { ...job, status: 'ready' as const, file, format: 'webp' as const, mime: 'image/webp', bytes: compressed.length,
      width: 16, height: 16, updatedAt: new Date().toISOString() };
    await core.atomicHdJson(path.join(core.hdDirectory(), `${job.key}.json`), ready);
    assert.equal(await registerCommittedStudioHd(task.id), true);
    assert.deepEqual(await core.readHdJob(job.key), ready, 'Existing ready result is reused without another encode');
    assert.equal((await core.listHdJobs()).length, 1);
    assert.deepEqual(await fs.readFile(path.join(directory, 'public', prepared.original_url)), original);
    assert.equal(await snapshot(task.id), committed);
    assert.equal(await finishStudioTask(task, 'succeeded', { preparedAsset: prepared }), false);
    assert.equal(await prisma.creditLedger.count({ where: { related_task_id: task.id, type: 'task_success_deduct' } }), 1);
    checks.push('committed_output_reuses_ready_preserves_original_and_single_settlement');

    // Fail the original read after a real task/asset commit; it must never undo
    // the delivery. The existing discovery entry point then supplies the miss.
    const missingTask = await createTask('hd-registration-miss');
    const missingBytes = await sharp(original).tint({ r: 130, g: 91, b: 70 }).png().toBuffer();
    const missingPrepared = await prepareStudioOutput(missingBytes, missingTask, { width: 16, height: 16 }, async () => {});
    assert.equal(await finishStudioTask(missingTask, 'succeeded', { preparedAsset: missingPrepared }), true);
    const delivered = await snapshot(missingTask.id);
    const sourceFile = path.join(directory, 'public', missingPrepared.original_url);
    await fs.rename(sourceFile, `${sourceFile}.held`);
    const logs: string[] = [];
    const logMock = mock.method(console, 'error', (...args: unknown[]) => { logs.push(args.join(' ')); });
    assert.equal(await registerCommittedStudioHd(missingTask.id), false);
    logMock.mock.restore();
    assert.equal(await snapshot(missingTask.id), delivered);
    assert.ok(logs.length > 0); assert.ok(logs.every(line => !line.includes(directory) && !line.includes(missingPrepared.original_url)));
    await fs.rename(`${sourceFile}.held`, sourceFile);
    const discovered = await registerHdDiscovery({ id: missingTask.id, source: missingPrepared.original_url, preserveText: false });
    assert.equal(discovered.durable, true); assert.ok(discovered.job);
    assert.equal(await snapshot(missingTask.id), delivered);
    checks.push('registration_failure_is_private_and_discovery_repairs_without_task_or_billing_mutation');

    const mismatchTask = await createTask('hd-retained-native');
    const active = await prisma.imageStudioTask.update({ where: { id: mismatchTask.id }, data: { output_size: '32x32' } });
    await beginStudioRequest(active);
    assert.equal(await finishRejectedStudioDimensions(active, original), true);
    const retained = await prisma.imageStudioTask.findUniqueOrThrow({ where: { id: active.id } });
    assert.equal(retained.status, 'uncertain'); assert.ok(retained.asset_id);
    const retainedAsset = await prisma.asset.findUniqueOrThrow({ where: { id: retained.asset_id! } });
    assert.ok((await core.listHdJobs()).some(item => item.source === retainedAsset.original_url));
    assert.deepEqual(await fs.readFile(path.join(directory, 'public', retainedAsset.original_url)), original);
    const failedTask = await createTask('hd-retained-failed');
    const retainedData = { ...prepared, id: `studio-${failedTask.id}`, metadata_json: JSON.stringify({ preserveText: true }) };
    const usage = { studioDelivery: { code: 'generated_dimensions_mismatch', originalSha256: createHash('sha256').update(original).digest('hex'),
      originalBytes: original.length, validation: { originalFormat: 'png', storedFormat: 'png', width: 16, height: 16, requestedSize: '32x32' } } };
    assert.equal(await finishStudioTask(failedTask, 'failed', { retainedAsset: retainedData, usage }), true);
    assert.equal(await registerCommittedStudioHd(failedTask.id), true);
    const plainFailed = await createTask('hd-plain-failed');
    assert.equal(await finishStudioTask(plainFailed, 'failed', { assetId: retained.asset_id! }), true);
    assert.equal(await registerCommittedStudioHd(plainFailed.id), false, 'Generic failed assets are not retained output');
    await prisma.imageStudioTask.update({ where: { id: failedTask.id }, data: { deleted_at: new Date() } });
    assert.equal(await registerCommittedStudioHd(failedTask.id), false, 'A hidden task is not restored by registration');
    checks.push('real_dimension_retention_commits_before_registration_and_failed_uncertain_predicates_hold');

    const worker = await fs.readFile(path.join(applicationRoot, 'src/lib/image-studio/worker.ts'), 'utf8');
    assert.equal((worker.match(/await registerCommittedStudioHd\(task\.id\)/g) || []).length, 2);
    assert.equal(checks.length, 4);
    assert.equal(forbiddenCalls, 0);
    const receipt = { schema: 'hd-registration-engineering.v1', runId, completed: true, checks, total: checks.length,
      passed: checks.length, productionWrites: 0, paidRequests: 0, browserRuns: 0, forbiddenCalls };
    await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt), { mode: 0o600 });
    console.log(JSON.stringify(receipt));
  } finally {
    mock.restoreAll(); await prisma.$disconnect(); await hdReadonlyDb.$disconnect();
    process.chdir(applicationRoot); process.umask(oldUmask);
  }
}

void main().then(() => { process.exitCode = 0; }).catch(error => { console.error(error); process.exitCode = 1; });
