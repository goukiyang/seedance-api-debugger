import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { mock } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { assertPricingWriterIsolation } from '../src/lib/pricing/isolation';
import {
  assertPricingImageConsumerReady, capturePricingWorkerCapability, renewPricingWorkerCapability,
  revokePricingWorkerCapability, pricingRuntimeModuleHashes, PRICING_IMAGE_CAPABILITY_KEY,
  type PricingWorkerCapability,
} from '../src/lib/pricing/runtime';

type Options = { databasePath: string; runtimeRoot: string; source: string };
type ProcEvidence = { pid: number; parentPid: number; start: string; state: string; uid: number; stat: string };
type Result = {
  completed: true;
  checks: Array<{ id: 'G19'; assertions: number; evidence: string[] }>;
  processEvidence: { worker: ProcEvidence; parent: ProcEvidence; controller?: ProcEvidence; parentSignalZero: 'EPERM';
    capability: PricingWorkerCapability; reader: { workerId: string; source: string; expiresAt: string } };
};

function environment(message: string): Error {
  return Object.assign(new Error(`pricing_fixture_environment: ${message}`), { code: 'pricing_fixture_environment' });
}
function inside(file: string, root: string) { return file.startsWith(`${root}${path.sep}`); }
function errorCode(error: unknown) { return error && typeof error === 'object' && 'code' in error ? error.code : undefined; }
function proc(pid: number): ProcEvidence {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  assert.ok(stat.startsWith(`${pid} (`) && /^\d+$/.test(fields[19] || '') && /^\d+$/.test(fields[1] || ''));
  return { pid, parentPid: Number(fields[1]), start: fields[19], state: fields[0], uid: fs.lstatSync(`/proc/${pid}`).uid, stat };
}
function marker(root: string) {
  assertPricingWriterIsolation(root);
  const file = path.join(root, 'storage/image-studio-drain'), stat = fs.lstatSync(file);
  return { file, uid: stat.uid, mode: stat.mode, ino: stat.ino, nlink: stat.nlink,
    sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
}
function blockNetwork() {
  let calls = 0;
  const blocked = (): never => { calls++; throw new Error('Parent identity fixture forbids all network calls'); };
  const controls = [mock.method(globalThis, 'fetch', blocked), mock.method(http, 'request', blocked),
    mock.method(http, 'get', blocked), mock.method(https, 'request', blocked), mock.method(https, 'get', blocked)];
  return { assertUnused: () => assert.equal(calls, 0), restore: () => controls.forEach(control => control.mock.restore()) };
}
async function waitFor(check: () => boolean, milliseconds: number, description: string) {
  const end = Date.now() + milliseconds;
  while (!check()) {
    if (Date.now() >= end) throw environment(description);
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  }
}
function json<T>(file: string): T { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; }
function writeJson(file: string, value: unknown) {
  const pending = `${file}.pending`;
  assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(pending, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  fs.renameSync(pending, file);
}

async function isolatedDatabase(databasePath: string) {
  const db = new PrismaClient({ datasources: { db: { url: `file:${databasePath}` } } });
  try {
    const databases = await db.$queryRawUnsafe<Array<{ name: string; file: string }>>('PRAGMA database_list');
    assert.equal(fs.realpathSync(databases.find(row => row.name === 'main')?.file || ''), databasePath);
    const tables = await db.$queryRawUnsafe<Array<{ name: string }>>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
    assert.ok(tables.length > 0, 'Lead must provide an initialized empty schema');
    for (const table of tables) {
      assert.match(table.name, /^[A-Za-z_][A-Za-z0-9_]*$/);
      if (table.name === '_prisma_migrations') continue;
      const rows = await db.$queryRawUnsafe<Array<{ count: bigint }>>(`SELECT COUNT(*) AS count FROM "${table.name}"`);
      assert.equal(String(rows[0].count), '0', `Dedicated fixture table must be empty: ${table.name}`);
    }
    return db;
  } catch (error) { await db.$disconnect(); throw error; }
}

async function child(options: Options, directory: string, db: PrismaClient): Promise<Result> {
  await waitFor(() => process.ppid === 1, 5000, `Actual child PPID is ${process.ppid}, not 1; a subreaper or sandbox prevents this scenario`);
  const worker = proc(process.pid);
  let parent: ProcEvidence;
  try { parent = proc(1); }
  catch (error) { throw environment(`Cannot read the actual PID 1 identity: ${String(error)}`); }
  assert.equal(worker.parentPid, 1); assert.equal(worker.uid, process.getuid!());
  assert.ok(worker.uid > 0);
  if (parent.uid !== 0) throw environment('Actual PID 1 is not root-owned; root-parent scenario is unavailable');
  let signalZero: unknown;
  try { process.kill(1, 0); } catch (error) { signalZero = errorCode(error); }
  if (signalZero !== 'EPERM') throw environment(`Actual non-root signal 0 to PID 1 returned ${String(signalZero)}; EPERM scenario is unavailable`);
  const capability = capturePricingWorkerCapability(options.source);
  assert.equal(capability.instance.pid, worker.pid); assert.equal(capability.instance.start, worker.start);
  assert.equal(capability.instance.cwd, options.runtimeRoot); assert.equal(capability.instance.parentPid, 1);
  assert.deepEqual(capability.parent, { pid: 1, start: parent.start });
  await renewPricingWorkerCapability(db, capability);
  const reader = await assertPricingImageConsumerReady(db);
  assert.equal(reader.workerId, capability.workerId);
  await assert.rejects(() => renewPricingWorkerCapability(db, { ...capability, parent: { ...capability.parent, start: `${parent.start}0` } }));
  await assert.rejects(() => renewPricingWorkerCapability(db, { ...capability, parent: { pid: worker.pid, start: worker.start } }));
  assert.equal((await assertPricingImageConsumerReady(db)).workerId, capability.workerId);
  const result: Result = { completed: true, checks: [{ id: 'G19', assertions: 12, evidence: [
    'Actual non-root orphan reached PPID 1; real /proc/1/stat supplied root PID/start despite actual kill(1, 0)=EPERM. No parent cwd was read.',
    'Actual capture -> renew -> reader completed on the isolated DB and original immutable marker; tampered parent start/PID could not renew or replace the receipt.',
  ] }], processEvidence: { worker, parent, parentSignalZero: 'EPERM', capability, reader } };
  writeJson(path.join(directory, 'ready.json'), result);
  try { await waitFor(() => fs.existsSync(path.join(directory, 'release')), 15000, 'Controller did not release the bounded child'); }
  finally { await revokePricingWorkerCapability(db, capability); }
  return result;
}

async function stopChild(identity: ProcEvidence) {
  const live = () => {
    try {
      const current = proc(identity.pid);
      if (current.start !== identity.start || current.uid !== identity.uid) throw environment('Child PID was reused; refuse to signal a different process');
      return !['Z', 'X', 'x'].includes(current.state);
    } catch (error) { if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ESRCH') return false; throw error; }
  };
  if (!live()) return;
  try { process.kill(identity.pid, 'SIGTERM'); }
  catch (error) { if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ESRCH') return; throw error; }
  try { await waitFor(() => !live(), 1500, 'Child did not stop after SIGTERM'); }
  catch (error) {
    if (!live()) return;
    try { process.kill(identity.pid, 'SIGKILL'); }
    catch (killError) { if (errorCode(killError) === 'ENOENT' || errorCode(killError) === 'ESRCH') return; throw killError; }
    await waitFor(() => !live(), 1500, 'Child did not stop after bounded SIGKILL cleanup');
  }
}

/** No import-time execution. The lead supplies a fresh schema DB and a complete,
 * root-prepared candidate runtime under .role-tests; this fixture installs neither. */
export async function runPricingParentIdentityContractFixture(options: Options): Promise<Result> {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function' || process.getuid() === 0) {
    throw environment('Requires real Linux execution as the non-root build user; no uid/PPID/proc simulation');
  }
  const candidateRoot = fs.realpathSync(process.env.PRICING_PARENT_IDENTITY_CANDIDATE_ROOT || process.cwd());
  const roleRoot = path.join(candidateRoot, '.role-tests');
  assert.equal(fs.realpathSync(roleRoot), roleRoot);
  const runtimeRoot = fs.realpathSync(options.runtimeRoot), databasePath = fs.realpathSync(options.databasePath);
  assert.equal(runtimeRoot, options.runtimeRoot); assert.equal(databasePath, options.databasePath);
  assert.ok(path.isAbsolute(runtimeRoot) && path.isAbsolute(databasePath) && inside(runtimeRoot, roleRoot) && inside(databasePath, roleRoot));
  assert.match(options.source, /^[a-f0-9]{40}$/);
  assert.equal(fs.readFileSync(path.join(candidateRoot, '.deployed-commit'), 'utf8').trim(), options.source);
  assert.equal(fs.readFileSync(path.join(runtimeRoot, '.deployed-commit'), 'utf8').trim(), options.source);
  assert.deepEqual(pricingRuntimeModuleHashes(runtimeRoot), pricingRuntimeModuleHashes(candidateRoot), 'Use the exact candidate runtime source, never a substituted implementation');
  const rootStat = fs.lstatSync(runtimeRoot), dbStat = fs.lstatSync(databasePath);
  assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink() && rootStat.uid === process.getuid());
  assert.ok(dbStat.isFile() && !dbStat.isSymbolicLink() && dbStat.nlink === 1 && dbStat.uid === process.getuid()
    && !(dbStat.mode & 0o077), 'A dedicated non-root-owned private database file is required');
  assert.equal(fs.readFileSync(databasePath).subarray(0, 16).toString(), 'SQLite format 3\0');
  const markerBefore = marker(runtimeRoot), previousCwd = process.cwd(), network = blockNetwork();
  let db: PrismaClient | undefined, directory: string | undefined, spawned: ProcEvidence | undefined;
  let completed = false;
  try {
    process.chdir(runtimeRoot);
    db = await isolatedDatabase(databasePath);
    const childDirectory = process.env.PRICING_PARENT_IDENTITY_CHILD_DIR;
    if (childDirectory) {
      assert.equal(fs.realpathSync(childDirectory), childDirectory);
      assert.equal(path.dirname(childDirectory), runtimeRoot);
      assert.ok(path.basename(childDirectory).startsWith('pricing-parent-identity-'));
      return await child({ ...options, runtimeRoot, databasePath }, childDirectory, db);
    }
    directory = fs.mkdtempSync(path.join(runtimeRoot, 'pricing-parent-identity-'));
    fs.chmodSync(directory, 0o700);
    const log = path.join(directory, 'child.log'), resultFile = path.join(directory, 'finished.json');
    const failureFile = path.join(directory, 'failure.json'), pidFile = path.join(directory, 'spawned.json');
    const input = { databasePath, runtimeRoot, source: options.source };
    const childCode = `
      import fs from 'node:fs';
      const deadline = setTimeout(() => process.exit(1), 25000);
      const write = (file, value) => {
        fs.writeFileSync(file + '.pending', JSON.stringify(value), { mode: 0o600, flag: 'wx' });
        fs.renameSync(file + '.pending', file);
      };
      try {
        const loaded = await import(${JSON.stringify(pathToFileURL(path.join(candidateRoot, 'scripts/pricing-parent-identity-fixture.ts')).href)});
        const run = loaded.runPricingParentIdentityContractFixture || loaded.default?.runPricingParentIdentityContractFixture;
        if (typeof run !== 'function') throw new Error('Candidate fixture export unavailable');
        const result = await run(${JSON.stringify(input)});
        write(${JSON.stringify(resultFile)}, result);
      } catch (error) {
        write(${JSON.stringify(failureFile)}, { message: String(error), stack: error?.stack, code: error?.code });
        process.exitCode = 1;
      } finally { clearTimeout(deadline); }
    `;
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', DATABASE_URL: `file:${databasePath}`, TMPDIR: directory, TSX_DISABLE_CACHE: '1',
      PRICING_PARENT_IDENTITY_CANDIDATE_ROOT: candidateRoot, PRICING_PARENT_IDENTITY_CHILD_DIR: directory };
    for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ']) if (process.env[key]) env[key] = process.env[key];
    // A real short-lived relay exits; Linux must genuinely reparent the detached
    // same-user child to PID 1. A subreaper is an environment gap, not a substitute.
    const relayCode = `
      const fs = require('node:fs'), { spawn } = require('node:child_process');
      const fd = fs.openSync(${JSON.stringify(log)}, 'wx', 0o600);
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', ${JSON.stringify(childCode)}],
        { cwd: ${JSON.stringify(runtimeRoot)}, env: process.env, detached: true, stdio: ['ignore', fd, fd] });
      child.on('error', error => { console.error(error); process.exitCode = 1; });
      child.once('spawn', () => {
        const stat = fs.readFileSync('/proc/' + child.pid + '/stat', 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/);
        fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ pid: child.pid, parentPid: Number(fields[1]),
          start: fields[19], state: fields[0], uid: fs.lstatSync('/proc/' + child.pid).uid, stat }), { mode: 0o600, flag: 'wx' });
        fs.closeSync(fd); child.unref();
      });
    `;
    const relay = spawnSync(process.execPath, ['--eval', relayCode], { cwd: runtimeRoot, env, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
    if (fs.existsSync(pidFile)) spawned = json<ProcEvidence>(pidFile);
    if (relay.error || relay.signal || relay.status !== 0 || !spawned) throw environment(`Real relay failed: ${relay.error?.message || relay.stderr || relay.signal || relay.status}`);
    const assertChildHealthy = () => {
      if (!fs.existsSync(failureFile)) return;
      const failure = json<{ message: string; stack?: string; code?: string }>(failureFile);
      if (failure.code === 'pricing_fixture_environment') throw environment(failure.message);
      throw new Error(`Actual PPID1 child contract failed; diagnostics retained at ${directory}`, { cause: failure });
    };
    await waitFor(() => {
      assertChildHealthy();
      return fs.existsSync(path.join(directory!, 'ready.json'));
    }, 15000, 'Real PPID1 child never reached capture/renew/reader; inspect the Linux reparenting and proc permissions');
    const ready = json<Result>(path.join(directory, 'ready.json'));
    assert.equal(ready.completed, true); assert.equal(ready.processEvidence.worker.pid, spawned.pid);
    assert.equal(ready.processEvidence.worker.start, spawned.start);
    assert.equal(ready.processEvidence.worker.parentPid, 1); assert.equal(ready.processEvidence.parent.pid, 1);
    assert.equal(ready.processEvidence.parentSignalZero, 'EPERM');
    const accepted = await assertPricingImageConsumerReady(db);
    assert.equal(accepted.workerId, ready.processEvidence.capability.workerId);
    const row = await db.platformSetting.findUniqueOrThrow({ where: { key: PRICING_IMAGE_CAPABILITY_KEY } });
    const captured = ready.processEvidence.capability;
    let assertions = 7;
    const refuse = async (value: PricingWorkerCapability) => {
      await db!.platformSetting.update({ where: { id: row.id }, data: { value_json: JSON.stringify(value) } });
      try { await assert.rejects(() => assertPricingImageConsumerReady(db!)); assertions++; }
      finally { await db!.platformSetting.update({ where: { id: row.id }, data: { value_json: row.value_json } }); }
    };
    await refuse({ ...captured, parent: { ...captured.parent, start: `${captured.parent.start}0` } });
    const controller = proc(process.pid);
    await refuse({ ...captured, parent: { pid: controller.pid, start: controller.start } });
    await refuse({ ...captured, instance: { ...captured.instance, parentPid: controller.pid } });
    await refuse({ ...captured, instance: { ...captured.instance, start: `${captured.instance.start}0` } });
    await refuse({ ...captured, instance: { ...captured.instance, cwd: directory } });
    await refuse({ ...captured, loadedModuleSha: { ...captured.loadedModuleSha, 'src/lib/pricing/runtime.ts': '0'.repeat(64) } });
    await refuse({ ...captured, expiresAt: new Date(0).toISOString() });
    assert.equal((await assertPricingImageConsumerReady(db)).workerId, captured.workerId); assertions++;
    writeJson(path.join(directory, 'release'), { release: true });
    await waitFor(() => {
      assertChildHealthy();
      return fs.existsSync(resultFile);
    }, 10000, 'Child did not revoke its capability and finish');
    const finished = json<Result>(resultFile);
    assert.equal(finished.completed, true);
    await assert.rejects(() => assertPricingImageConsumerReady(db!)); assertions += 2;
    completed = true;
    return { completed: true, checks: [{ id: 'G19', assertions: assertions + finished.checks[0].assertions,
      evidence: [...finished.checks[0].evidence,
        'A separate actual controller reader accepted the live PPID1 child; real parent PID/start, worker parent/start/cwd, module hash and TTL mutations all rejected; original receipt remained readable after restoration.',
        'The real child revoked its receipt before exit; no fake uid/PPID/proc/stat/kill, network, provider generation, production DB or marker rewrite was used. Temporary child files are bounded to the supplied .role-tests runtime and removed after process cleanup.',
      ] }], processEvidence: { ...finished.processEvidence, controller, reader: accepted } };
  } finally {
    let childStopped = false;
    try {
      if (spawned) await stopChild(spawned);
      childStopped = true;
    } finally {
      try {
        if (db) await db.$disconnect();
        network.assertUnused();
        assert.deepEqual(marker(runtimeRoot), markerBefore, 'Original root/immutable marker must remain untouched');
        assert.deepEqual(pricingRuntimeModuleHashes(runtimeRoot), pricingRuntimeModuleHashes(candidateRoot));
      } finally {
        network.restore(); process.chdir(previousCwd);
        if (directory && childStopped && completed) fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  }
}
