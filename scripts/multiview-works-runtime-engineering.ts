import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, lchown, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const FIXTURE_ROOT_BASE = '/data/video-api-debugger-engineering';
const MANAGED_RELEASE_BASE = '/data/video-api-debugger/managed-releases';

function safeFailure(error: unknown) {
  const value = error && typeof error === 'object' ? error as { name?: unknown; code?: unknown; stack?: unknown } : null;
  const name = typeof value?.name === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value.name)
    ? value.name : 'Error';
  const code = typeof value?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(value.code)
    ? value.code : 'ISOLATED_RUNTIME_FIXTURE_FAILED';
  const location = typeof value?.stack === 'string'
    ? value.stack.match(/(?:scripts\/multiview-works-runtime-engineering\.ts|src\/lib\/video\/multiview-works-runtime\.ts):\d+:\d+/)?.[0] || null
    : null;
  return { name, code, location };
}

async function isolatedFixtureRoot(sourceRoot: string) {
  const source = path.basename(sourceRoot);
  assert.match(source, /^[a-f0-9]{40}$/);
  assert.equal(sourceRoot, path.join(MANAGED_RELEASE_BASE, source));
  const configured = process.env.MULTIVIEW_PRIVATE_FIXTURE_ROOT;
  assert.ok(configured && path.isAbsolute(configured) && path.normalize(configured) === configured);
  const relative = path.relative(FIXTURE_ROOT_BASE, configured);
  const parts = relative.split(path.sep);
  const runId = process.env.IMAGE_RECOVERY_GATE_RUN_ID;
  assert.ok(runId && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(runId));
  const current = relative === `private-${runId}-${source}`;
  const legacy = parts.length === 2 && parts[0] === runId && parts[1] === source;
  assert.ok(current || legacy, 'Private fixture must match the exact run and source');
  const runRoot = path.join(FIXTURE_ROOT_BASE, runId);
  for (const directory of ['/data', FIXTURE_ROOT_BASE, ...(legacy ? [runRoot] : []), configured]) {
    const info = await lstat(directory);
    assert.ok(info.isDirectory() && !info.isSymbolicLink());
    assert.equal(await realpath(directory), directory);
  }
  const uid = typeof process.geteuid === 'function' ? process.geteuid() : null;
  assert.ok(uid !== null);
  const [dataInfo, systemInfo, fixtureInfo] = await Promise.all([stat('/data'), stat('/'), stat(configured)]);
  assert.notEqual(dataInfo.dev, systemInfo.dev);
  assert.equal(fixtureInfo.dev, dataInfo.dev);
  assert.equal(fixtureInfo.uid, uid);
  assert.equal(fixtureInfo.mode & 0o777, 0o700);
  return configured;
}

/** This separate mode uses real root-owned links; it never relaxes production ownership checks. */
async function checkBuildAliases() {
  if (typeof process.geteuid !== 'function' || process.geteuid() !== 0) {
    console.error(JSON.stringify({ schema: 'isolated-multiview-works-runtime.v1', mode: 'build-alias', completed: false,
      runtimeUnsupported: 'root_owned_build_alias_fixture_requires_root' }));
    process.exitCode = 2; return;
  }
  const scratch = path.join(await realpath(process.cwd()), '.role-tests');
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(scratch, 'multiview-works-runtime-build-'));
  process.env.DATABASE_URL = `file:${path.join(directory, 'unused-synthetic.db')}`;
  const { readMultiviewWorksBuildId } = await import('../src/lib/video/multiview-works-runtime');
  const checks: string[] = [], evidencePath = path.join(directory, 'receipt.json');
  let completed = false;
  try {
    for (const scenario of ['fixed-root-owned-alias', 'wrong-literal-target', 'linked-candidate', 'writable-candidate', 'writable-build', 'non-root-alias']) {
      const root = path.join(directory, scenario), candidate = path.join(root, '.next-prod-candidate');
      await mkdir(root, { mode: 0o700 });
      const actualTarget = scenario === 'wrong-literal-target' || scenario === 'linked-candidate'
        ? path.join(root, '.other-build') : candidate;
      await mkdir(actualTarget, { mode: 0o755 });
      await chmod(actualTarget, 0o755);
      await writeFile(path.join(actualTarget, 'BUILD_ID'), 'synthetic_build_v1\n', { flag: 'wx', mode: 0o644 });
      await chmod(path.join(actualTarget, 'BUILD_ID'), 0o644);
      if (scenario === 'linked-candidate') await symlink('.other-build', candidate);
      const alias = path.join(root, '.next-prod');
      await symlink(scenario === 'wrong-literal-target' ? '.other-build' : '.next-prod-candidate', alias);
      if (scenario === 'writable-candidate') await chmod(candidate, 0o777);
      if (scenario === 'writable-build') await chmod(path.join(candidate, 'BUILD_ID'), 0o666);
      if (scenario === 'non-root-alias') await lchown(alias, 1004, 1004);
      if (scenario === 'fixed-root-owned-alias') {
        const info = await lstat(alias);
        assert.ok(info.isSymbolicLink()); assert.equal(info.uid, 0); assert.equal(info.nlink, 1);
        assert.equal(info.mode & 0o777, 0o777);
        assert.equal(await readMultiviewWorksBuildId(root), 'synthetic_build_v1');
      } else {
        // optional development discovery must not turn a present unsafe alias into a missing build.
        await assert.rejects(readMultiviewWorksBuildId(root));
        await assert.rejects(readMultiviewWorksBuildId(root, true));
      }
      checks.push(scenario);
    }
    completed = true;
  } finally {
    await writeFile(evidencePath, JSON.stringify({ schema: 'isolated-multiview-works-runtime.v1', mode: 'build-alias',
      completed, checks, production: false, workConsumed: 0, providerCalls: 0, evidencePath }, null, 2), { mode: 0o600 });
  }
  console.log(JSON.stringify({ schema: 'isolated-multiview-works-runtime.v1', mode: 'build-alias', completed, checks, evidencePath }));
}

/** Linux-only synthetic filesystem/real flock proof. No work or provider is consumed. */
async function main() {
  if (process.platform !== 'linux') {
    console.error(JSON.stringify({ schema: 'isolated-multiview-works-runtime.v1', completed: false,
      runtimeUnsupported: 'linux_proc_locks_and_system_flock_required' }));
    process.exitCode = 2; return;
  }
  try {
    await access('/usr/bin/flock', constants.X_OK); await access('/proc/locks', constants.R_OK);
    await access('/proc/self/fd', constants.R_OK);
  } catch {
    console.error(JSON.stringify({ schema: 'isolated-multiview-works-runtime.v1', completed: false,
      runtimeUnsupported: 'linux_proc_locks_and_system_flock_unavailable' }));
    process.exitCode = 2; return;
  }
  Object.assign(process.env, { NODE_ENV: 'test' });
  Reflect.set(globalThis, 'AsyncLocalStorage', AsyncLocalStorage);
  globalThis.fetch = async () => { throw new Error('External requests prohibited in isolated works runtime fixture'); };
  if (process.argv.includes('--build-alias-fixture')) { await checkBuildAliases(); return; }
  const childIndex = process.argv.indexOf('--runtime-fixture-child');
  const waitFor = async (check: () => Promise<boolean>, maximum = 16000) => {
    const until = Date.now() + maximum;
    while (Date.now() < until) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('runtime_fixture_condition_deadline_exceeded');
  };
  if (childIndex >= 0) {
    const directory = process.argv[childIndex + 1], scenario = process.argv[childIndex + 2];
    assert.ok(directory && path.isAbsolute(directory));
    const sourceRoot = await realpath(process.cwd());
    const fixtureRoot = await isolatedFixtureRoot(sourceRoot);
    assert.ok((await realpath(directory)).startsWith(fixtureRoot + path.sep));
    assert.ok(path.basename(path.dirname(directory)).startsWith('multiview-works-runtime-'));
    process.env.DATABASE_URL = `file:${path.join(directory, 'unused-synthetic.db')}`;
    const runtime = await import('../src/lib/video/multiview-works-runtime');
    const lockPath = path.join(directory, 'consumer.lock');
    const root = path.join(directory, scenario === 'symlink' ? 'runtime-alias' : 'runtime');
    let failures = 0;
    if (['unlocked', 'symlink', 'permissions'].includes(scenario)) {
      await assert.rejects(runtime.startMultiviewWorksRuntime({ lockPath, fixtureRoot: root, onFailure: () => { failures++; } }));
      assert.equal((await readdir(path.join(directory, 'runtime'))).includes('runtime.json'), false);
      console.log(JSON.stringify({ scenario, rejected: true, pid: process.pid })); return;
    }
    const controller = await runtime.startMultiviewWorksRuntime({ lockPath, fixtureRoot: root, onFailure: () => { failures++; } });
    try {
    const runtimeFile = path.join(root, 'runtime.json');
    const first = JSON.parse(await readFile(runtimeFile, 'utf8'));
    assert.equal(first.schema, 'multiview.works.v1'); assert.equal(first.protocol, first.schema);
    assert.equal(first.state, 'active'); assert.equal(first.pid, process.pid); assert.equal(first.parentPid, process.ppid);
    assert.equal(first.sourceRoot, await realpath(process.cwd()));
    assert.equal((await lstat(runtimeFile)).mode & 0o777, 0o600);
    const allowed = ['schema', 'protocol', 'state', 'pid', 'parentPid', 'sourceRoot', 'source', 'version', 'build', 'startedAt', 'heartbeatAt', 'loadedModuleSha'];
    assert.deepEqual(Object.keys(first).sort(), allowed.sort());
    for (const file of runtime.MULTIVIEW_WORKS_RUNTIME_SOURCES) {
      assert.equal(first.loadedModuleSha[file], createHash('sha256').update(await readFile(path.join(first.sourceRoot, file))).digest('hex'));
    }
    if (scenario === 'heartbeat-failure') {
      await unlink(runtimeFile); await mkdir(runtimeFile, { mode: 0o700 });
      await waitFor(async () => failures > 0);
      assert.equal(failures, 1); assert.throws(() => controller.assertHealthy());
      await assert.rejects(controller.stop());
      assert.equal((await readdir(root)).filter(file => file.endsWith('.tmp')).length, 0);
      console.log(JSON.stringify({ scenario, failedClosed: true, pid: process.pid })); return;
    }
    if (scenario === 'heartbeat') {
      await waitFor(async () => JSON.parse(await readFile(runtimeFile, 'utf8')).heartbeatAt !== first.heartbeatAt);
      const heartbeat = JSON.parse(await readFile(runtimeFile, 'utf8'));
      assert.equal(heartbeat.state, 'active'); assert.equal(heartbeat.startedAt, first.startedAt);
    }
    for (let index = 0; index < 20; index++) controller.markStopping();
    await Promise.all([controller.stop(), controller.stop()]);
    const stopped = JSON.parse(await readFile(runtimeFile, 'utf8'));
    assert.equal(stopped.state, 'stopped'); assert.equal(stopped.pid, first.pid); assert.equal(stopped.startedAt, first.startedAt);
    assert.deepEqual(stopped.loadedModuleSha, first.loadedModuleSha); assert.equal(failures, 0);
    assert.equal((await readdir(root)).filter(file => file.endsWith('.tmp')).length, 0);
    console.log(JSON.stringify({ scenario, stopped: true, pid: process.pid, heartbeatChecked: scenario === 'heartbeat' }));
    return;
    } finally { await controller.stop().catch(() => {}); }
  }

  const sourceRoot = await realpath(process.cwd()), scratch = path.join(sourceRoot, '.role-tests');
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  await chmod(scratch, 0o700);
  const fixtureRoot = await isolatedFixtureRoot(sourceRoot);
  const directory = await mkdtemp(path.join(fixtureRoot, 'multiview-works-runtime-'));
  const evidenceDirectory = await mkdtemp(path.join(scratch, 'multiview-works-runtime-evidence-'));
  const checks: string[] = [];
  const evidencePath = path.join(evidenceDirectory, 'receipt.json');
  let completed = false, failure: ReturnType<typeof safeFailure> | null = null;
  try {
    for (const scenario of ['once', 'heartbeat', 'heartbeat-failure', 'unlocked', 'symlink', 'permissions']) {
      const scenarioRoot = path.join(directory, scenario), outputRoot = path.join(scenarioRoot, 'runtime');
      await mkdir(outputRoot, { recursive: true, mode: 0o700 });
      await chmod(scenarioRoot, 0o700); await chmod(outputRoot, scenario === 'permissions' ? 0o755 : 0o700);
      if (scenario === 'symlink') await symlink(outputRoot, path.join(scenarioRoot, 'runtime-alias'));
      const lock = await open(path.join(scenarioRoot, 'consumer.lock'), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        const childArgv = [process.execPath, ...process.execArgv, path.join(sourceRoot, 'scripts/multiview-works-runtime-engineering.ts'),
          '--runtime-fixture-child', scenarioRoot, scenario];
        const command = scenario === 'unlocked' ? childArgv[0] : '/usr/bin/flock';
        const arguments_ = scenario === 'unlocked' ? childArgv.slice(1)
          : ['--exclusive', '--nonblock', '--no-fork', '/proc/self/fd/3', ...childArgv];
        const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
          const child = spawn(command, arguments_, { cwd: sourceRoot, stdio: ['ignore', 'pipe', 'pipe', lock.fd] });
          let stdout = '', stderr = '';
          const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('runtime_fixture_child_deadline_exceeded')); }, 30000);
          child.stdout!.on('data', data => { stdout += String(data); });
          child.stderr!.on('data', data => { stderr += String(data); });
          child.once('error', error => { clearTimeout(timeout); reject(error); });
          child.once('exit', code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
        });
        assert.equal(result.code, 0, result.stderr);
        const childReceipt = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
        assert.equal(childReceipt.scenario, scenario);
        checks.push(scenario);
      } finally { await lock.close(); }
    }
    completed = true;
  } catch (error) {
    failure = safeFailure(error);
    throw error;
  } finally {
    // Keep the private isolated evidence for the batch receipt; no production cleanup.
    await writeFile(evidencePath, JSON.stringify({ schema: 'isolated-multiview-works-runtime.v1', completed, checks,
      production: false, workConsumed: 0, providerCalls: 0, evidencePath, ...(failure ? { failure } : {}) }, null, 2), { mode: 0o600 });
  }
  console.log(JSON.stringify({ schema: 'isolated-multiview-works-runtime.v1', completed, checks, evidencePath }));
}
void main().catch(error => {
  console.error(JSON.stringify({ schema: 'isolated-multiview-works-runtime.v1', completed: false, failure: safeFailure(error) }));
  process.exitCode = 1;
});
