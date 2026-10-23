import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import * as engineContext from './engine-context.mjs';
import { readTypedJson } from './typed-files.mjs';
import { classifyReleaseError, ReleaseEngineError } from './release-errors.mjs';
import {
  assertAttemptBindings,
  createControllerOwner,
  finishAttempt,
  finishPhase,
  inspectControllerOwner,
  readAttempt,
  recordAttemptEvent,
  startAttempt,
  startPhase,
  takeoverAttempt,
} from './attempt-state.mjs';
import { ENGINE_VERSION } from './engine-version.mjs';

export const RELEASE_BATCH_SCHEMA = 'sd2-release-batch.v1';
export const RELEASE_PHASES = Object.freeze([
  'capture', 'preflight', 'admission', 'adopt', 'prepare', 'guard-build', 'main-build', 'verify', 'arm', 'switch', 'proof',
]);
export const NATIVE_FIXTURES = Object.freeze([
  'release-protection-engineering.mjs', 'guard-recovery-engineering.mjs', 'candidate-reuse-engineering.mjs',
  'retired-hd-cache-engineering.mjs', 'hd-closed-cache-engineering.mjs', 'cutover-driver-engineering.mjs',
  'cutover-safety-engineering.mjs', 'hd-storage-preflight-engineering.mjs', 'certificate-engineering.mjs',
  'usage-role-engineering.mjs', 'preflight-resume-engineering.mjs', 'normal-continuation-engineering.mjs',
  'candidate-lifecycle-engineering.mjs', 'deployed-usage-schema-engineering.mjs', 'runtime-source-engineering.mjs',
  'canvas-batch-schema-engineering.mjs', 'multiview-works-engineering.mjs', 'attempt-state-engineering.mjs',
  'release-entry-engineering.mjs',
]);

const here = path.dirname(fileURLToPath(import.meta.url));
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[a-f0-9]{12}$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function exactKeys(value, expected, name) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${name} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${name} has unexpected or missing fields`);
  return value;
}

function safeAbsolute(value, name) {
  assert.ok(typeof value === 'string' && path.isAbsolute(value) && path.resolve(value) === value && value.length <= 4096,
    `${name} must be a normalized absolute path`);
  return value;
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeJsonExclusive(file, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(file));
  return { file, sha256: digest(bytes), bytes: bytes.length };
}

function rootDocument(file, maximumBytes = 1024 * 1024) {
  return readTypedJson({ file: safeAbsolute(file, 'root JSON path'), category: 'root_control', maximumBytes });
}
function rootJson(file, maximumBytes = 1024 * 1024) { return rootDocument(file, maximumBytes).value; }

function localDocument(file, maximumBytes) {
  safeAbsolute(file, 'local control path'); assert.equal(fs.realpathSync(file), file);
  const before = fs.lstatSync(file), uid = process.getuid();
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.uid === uid
    && !(before.mode & 0o022) && before.size > 0 && before.size <= maximumBytes,
  'Local control input must be one canonical, single-link, current-user file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'uid', 'gid', 'mode', 'nlink']) assert.equal(opened[key], before[key]);
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
    for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'uid', 'gid', 'mode', 'nlink']) assert.equal(after[key], before[key]);
    const linked = fs.lstatSync(file);
    assert.ok(linked.isFile() && !linked.isSymbolicLink()); assert.equal(linked.dev, before.dev); assert.equal(linked.ino, before.ino);
    return { value: JSON.parse(bytes), bytes };
  } finally { fs.closeSync(fd); }
}

export function validatePackageRequest(value) {
  exactKeys(value, ['schema', 'repoRoot', 'mainSource', 'guardSource', 'outputRoot'], 'release package request');
  assert.equal(value.schema, 'sd2-release-package-request.v1');
  for (const key of ['repoRoot', 'outputRoot']) safeAbsolute(value[key], key);
  assert.match(value.mainSource, /^[a-f0-9]{40}$/); assert.match(value.guardSource, /^[a-f0-9]{40}$/);
  assert.notEqual(value.mainSource, value.guardSource); return value;
}

export async function packageReleaseCandidates(contextFile, requestFile) {
  const context = localDocument(contextFile, 256 * 1024).value;
  assert.equal(context.schema, 'sd2-release-context.v1');
  assert.ok(context.contract && typeof context.contract === 'object' && !Array.isArray(context.contract));
  const request = validatePackageRequest(localDocument(requestFile, 64 * 1024).value);
  engineContext.configureReleaseContext(context);
  const { packageRateCandidates } = await import('./package-candidates.mjs');
  return packageRateCandidates(request);
}

function installedControllerHashes(directory = here) {
  assert.equal(fs.realpathSync(directory), directory);
  const stat = fs.lstatSync(directory); assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && !(stat.mode & 0o022));
  return Object.fromEntries(fs.readdirSync(directory).filter(name => name.endsWith('.mjs')).sort()
    .map(name => [name, digest(fs.readFileSync(path.join(directory, name)))]));
}

export function validateNativeFixture(name) {
  assert.ok(NATIVE_FIXTURES.includes(name), 'Native bootstrap fixture is not in the reviewed 19-file allowlist');
  assert.equal(path.basename(name), name); return name;
}

export async function invokeNativeFixture({ contextFile, fixture, args = [] }) {
  const context = rootJson(contextFile, 256 * 1024); assert.equal(context.schema, 'sd2-release-context.v1');
  assert.ok(context.contract && typeof context.contract === 'object' && !Array.isArray(context.contract));
  const engine = context.contract.engine; assert.ok(engine && typeof engine === 'object');
  assert.equal(engine.schema, 'sd2-release-engine.v1'); assert.equal(engine.version, ENGINE_VERSION); assert.equal(engine.root, here);
  assert.equal(digest(JSON.stringify(installedControllerHashes())), engine.controllerSetSha256,
    'Installed controller bytes differ from the context-locked engine identity');
  validateNativeFixture(fixture); assert.ok(Array.isArray(args) && args.length <= 128);
  for (const value of args) assert.ok(typeof value === 'string' && value.length <= 4096 && !value.includes('\0'));
  engineContext.configureReleaseContext(context);
  const file = path.join(here, fixture); process.argv = [process.execPath, file, ...args];
  await import(pathToFileURL(file).href);
}

function validateEngine(value, projectRoot) {
  exactKeys(value, ['schema', 'version', 'controllerSetSha256', 'root'], 'release engine');
  assert.equal(value.schema, 'sd2-release-engine.v1');
  assert.equal(value.version, ENGINE_VERSION); assert.match(value.controllerSetSha256, HASH);
  assert.equal(value.root, `${projectRoot}/release-engines/${value.version}-${value.controllerSetSha256}`);
  return value;
}

function validateArtifact(value, kind) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  if (value.schema === 'sd2-release-artifact-input.v1') {
    exactKeys(value, ['schema', 'kind', 'source', 'version', 'sourceManifestSha256', 'buildInputsSha256'], `${kind} input artifact`);
    assert.match(value.buildInputsSha256, HASH);
  } else {
    exactKeys(value, ['schema', 'kind', 'source', 'version', 'build', 'sourceManifestSha256', 'compiledTreeSha256',
      'immutableSuccessSha256'], `${kind} built artifact`);
    assert.equal(value.schema, 'sd2-release-artifact-identity.v1');
    assert.ok(typeof value.build === 'string' && value.build.length > 0 && value.build.length <= 256);
    assert.match(value.compiledTreeSha256, HASH); assert.match(value.immutableSuccessSha256, HASH);
  }
  assert.equal(value.kind, kind); assert.match(value.source, /^[a-f0-9]{40}$/);
  assert.ok(typeof value.version === 'string' && value.version.length > 0 && value.version.length <= 128);
  assert.match(value.sourceManifestSha256, HASH);
  return value;
}

function validateArtifacts(value) {
  exactKeys(value, ['main', 'guard'], 'release artifact pair');
  validateArtifact(value.main, 'main'); validateArtifact(value.guard, 'guard');
  assert.equal(value.main.schema, value.guard.schema); assert.notEqual(value.main.source, value.guard.source);
  return value;
}

export function validateReleaseBatch(value, batchFile) {
  exactKeys(value, ['schema', 'project', 'projectRoot', 'taskId', 'attemptId', 'runId', 'engine', 'contextFile', 'seedFile',
    'manifestFile', 'artifacts', 'phases'], 'release batch');
  assert.equal(value.schema, RELEASE_BATCH_SCHEMA); assert.equal(value.project, 'video-api-debugger');
  safeAbsolute(value.projectRoot, 'project root'); assert.match(value.taskId, UUID); assert.match(value.attemptId, UUID);
  assert.equal(value.runId, value.attemptId); validateEngine(value.engine, value.projectRoot);
  for (const key of ['contextFile', 'seedFile', 'manifestFile']) safeAbsolute(value[key], key);
  assert.equal(value.manifestFile, `${value.projectRoot}/release-staging/${value.runId}/manifest.json`);
  assert.equal(path.dirname(value.seedFile), path.dirname(value.manifestFile));
  assert.deepEqual(value.phases, RELEASE_PHASES); validateArtifacts(value.artifacts);
  if (batchFile) {
    safeAbsolute(batchFile, 'batch file');
    assert.equal(path.dirname(batchFile), path.dirname(value.manifestFile), 'Attempt batch must live in its immutable stage');
  }
  return value;
}

export function readReleaseBatch(batchFile) {
  return validateReleaseBatch(rootJson(batchFile), batchFile);
}

function operation(batch) {
  return { schema: 'sd2-release-operation.v1', taskId: batch.taskId, attemptId: batch.attemptId,
    taskRoot: `${batch.projectRoot}/release-tasks/${batch.taskId}` };
}

function assertContext(batch, batchFile = null) {
  const value = rootJson(batch.contextFile, 256 * 1024);
  assert.equal(value.schema, 'sd2-release-context.v1');
  assert.ok(value.contract && typeof value.contract === 'object' && !Array.isArray(value.contract));
  assert.deepEqual(value.contract.engine, batch.engine); assert.deepEqual(value.contract.operation, operation(batch));
  if (value.contract.batchFile !== undefined) assert.equal(value.contract.batchFile, batchFile);
  if (value.contract.batchSha256 !== undefined) {
    assert.ok(batchFile); assert.equal(value.contract.batchSha256, digest(rootDocument(batchFile, 1024 * 1024).bytes));
  }
  return value;
}

function assertSeed(batch) {
  const seed = rootJson(batch.seedFile, 1024 * 1024);
  assert.equal(seed.runId, batch.runId); assert.deepEqual(seed.engine, batch.engine); assert.deepEqual(seed.operation, operation(batch));
  return seed;
}

function assertManifest(batch) {
  const value = rootJson(batch.manifestFile, 32 * 1024 * 1024);
  assert.equal(value.runId, batch.runId); assert.equal(value.stage, path.dirname(batch.manifestFile));
  assert.deepEqual(value.engine, batch.engine); assert.deepEqual(value.operation, operation(batch));
  return value;
}

function parseTime(value, name) {
  const result = typeof value === 'number' ? value : Date.parse(value);
  assert.ok(Number.isSafeInteger(result) && result > 0, `${name} is invalid`); return result;
}

export function releaseWindowReference(batch, windowFile, now = Date.now()) {
  assert.equal(windowFile, path.join(path.dirname(batch.manifestFile), 'window.json'),
    'Release window must be the one business consumers read from this attempt stage');
  const document = rootDocument(windowFile, 256 * 1024), { value, bytes } = document;
  assert.equal(value.runId, batch.runId);
  if (value.project !== undefined) assert.equal(value.project, batch.project);
  if (value.mainSource !== undefined) assert.equal(value.mainSource, batch.artifacts.main.source);
  if (value.guardSource !== undefined) assert.equal(value.guardSource, batch.artifacts.guard.source);
  const observedAt = parseTime(value.observedAt ?? value.issuedAt, 'window observation time');
  const expiresAt = value.expiresAt === undefined ? observedAt + 300_000 : parseTime(value.expiresAt, 'window expiry');
  assert.ok(observedAt <= now && now < expiresAt && expiresAt - observedAt <= 300_000, 'Release window is stale or over-broad');
  const sha256 = digest(bytes), evidenceDirectory = path.join(path.dirname(batch.manifestFile), 'window-evidence');
  if (!fs.existsSync(evidenceDirectory)) { fs.mkdirSync(evidenceDirectory, { mode: 0o700 }); syncDirectory(path.dirname(evidenceDirectory)); }
  assert.equal(fs.realpathSync(evidenceDirectory), evidenceDirectory); const directory = fs.lstatSync(evidenceDirectory);
  assert.ok(directory.isDirectory() && !directory.isSymbolicLink() && directory.uid === 0 && (directory.mode & 0o777) === 0o700);
  const evidenceFile = path.join(evidenceDirectory, `${sha256}.json`);
  if (fs.existsSync(evidenceFile)) assert.deepEqual(rootDocument(evidenceFile, 256 * 1024).bytes, bytes,
    'Existing immutable window evidence differs from its content address');
  else {
    const fd = fs.openSync(evidenceFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    syncDirectory(evidenceDirectory);
  }
  const evidence = fs.lstatSync(evidenceFile);
  assert.ok(evidence.isFile() && !evidence.isSymbolicLink() && evidence.uid === 0 && evidence.nlink === 1
    && (evidence.mode & 0o777) === 0o600);
  return { schema: 'sd2-release-window-reference.v1', attemptId: batch.attemptId, runId: batch.runId,
    file: evidenceFile, sha256, observedAt, expiresAt };
}

function assertApproval(batch, approvalFile, now = Date.now()) {
  const document = rootDocument(approvalFile, 256 * 1024), { value, bytes } = document;
  assert.equal(value.runId, batch.runId);
  const issuedAt = parseTime(value.issuedAt, 'approval issue time'), expiresAt = parseTime(value.expiresAt, 'approval expiry');
  assert.ok(issuedAt <= now && now < expiresAt && expiresAt - issuedAt <= 300_000, 'Release approval is stale or over-broad');
  assert.equal(path.dirname(approvalFile), path.dirname(batch.manifestFile));
  return { value, file: approvalFile, sha256: digest(bytes) };
}

function markerIdentity(stage, name) {
  const file = path.join(stage, name);
  if (!fs.existsSync(file)) return null;
  const maximumBytes = name.endsWith('-immutable-success.json') ? 128 * 1024 * 1024 : 32 * 1024 * 1024;
  const document = rootDocument(file, maximumBytes);
  return { bytes: document.bytes.length, sha256: digest(document.bytes) };
}

const SCENE_MARKERS = Object.freeze([
  'manifest.json', 'capture.json', 'native-control-preflight/batch.json', 'native-control-preflight/receipt.json',
  'main-prepared.json', 'guard-prepared.json',
  'main-build.json', 'guard-build.json', 'main-immutable-success.json', 'guard-immutable-success.json',
  'fixed-guard-recovery.json', 'switch-before.json', 'ingress-503-switch.json', 'pricing-pair-published.json',
  'switch-complete.json', 'guard-recovery-complete.json',
]);

export function captureReleaseScene(batch, now = Date.now()) {
  const stage = path.dirname(batch.manifestFile), files = Object.fromEntries(SCENE_MARKERS.map(name => [name, markerIdentity(stage, name)]));
  const dynamic = fs.existsSync(stage) ? fs.readdirSync(stage).filter(name => /^(?:natural-stop|usage-role-transition|nginx-.*-installed)/.test(name)).sort() : [];
  const switchComplete = Boolean(files['switch-complete.json']);
  const effectsStarted = dynamic.length > 0 || ['ingress-503-switch.json', 'pricing-pair-published.json']
    .some(name => Boolean(files[name]));
  const facts = { stage, files, dynamic, effectsStarted, switchComplete,
    fixedGuardRecoveryAvailable: Boolean(files['fixed-guard-recovery.json']) };
  return { schema: 'sd2-release-scene-summary.v1', capturedAt: now, sha256: digest(JSON.stringify(facts)), facts };
}

export function releaseChildAction(phase) {
  assert.ok(RELEASE_PHASES.includes(phase));
  return Object.freeze({ phase, kind: phase === 'guard-build' ? 'guard' : phase === 'main-build' ? 'main' : null });
}

async function callReleasePhase(release, phase, batch) {
  if (phase === 'capture') return release.capture(batch.seedFile);
  if (phase === 'admission') return release.execute('admission', batch.manifestFile);
  if (phase === 'prepare') return { main: await release.execute('prepare', batch.manifestFile, 'main'),
    guard: await release.execute('prepare', batch.manifestFile, 'guard') };
  if (phase === 'guard-build') return release.execute('build', batch.manifestFile, 'guard');
  if (phase === 'main-build') return release.execute('build', batch.manifestFile, 'main');
  if (phase === 'verify') return { main: await release.execute('verify', batch.manifestFile, 'main'),
    guard: await release.execute('verify', batch.manifestFile, 'guard') };
  if (phase === 'arm') return release.execute('arm', batch.manifestFile);
  if (phase === 'proof') {
    const proof = await release.execute('proof', batch.manifestFile);
    const publicProof = await release.execute('public', batch.manifestFile, 'main');
    return { ...proof, public: publicProof };
  }
  return release.execute(phase, batch.manifestFile);
}

function validateInvocation(value, invocationFile) {
  exactKeys(value, ['schema', 'batchFile', 'phase', 'taskRoot', 'taskId', 'attemptId', 'owner', 'processFile'], 'phase invocation');
  assert.equal(value.schema, 'sd2-release-phase-invocation.v1'); safeAbsolute(value.batchFile, 'batch file');
  assert.ok(RELEASE_PHASES.includes(value.phase) || value.phase === 'recovery');
  safeAbsolute(value.taskRoot, 'task root'); assert.match(value.taskId, UUID); assert.match(value.attemptId, UUID);
  assert.ok(value.owner && typeof value.owner === 'object' && !Array.isArray(value.owner));
  safeAbsolute(value.processFile, 'child process receipt');
  safeAbsolute(invocationFile, 'phase invocation file'); return value;
}

async function readOwnProcessReceipt(invocation, invocationFile) {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(invocation.processFile) && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 10));
  const value = rootJson(invocation.processFile, 32 * 1024);
  assert.equal(value.schema, 'sd2-release-child-process.v1'); assert.equal(value.invocationFile, invocationFile);
  assert.equal(value.invocationSha256, digest(rootDocument(invocationFile, 256 * 1024).bytes));
  assert.equal(value.owner.pid, process.pid); assert.equal(value.owner.host, os.hostname());
  return value;
}

export async function invokeReleaseChild({ invocationFile }) {
  const invocation = validateInvocation(rootJson(invocationFile, 256 * 1024), invocationFile);
  await readOwnProcessReceipt(invocation, invocationFile);
  const { batchFile, phase } = invocation, batch = readReleaseBatch(batchFile);
  assert.equal(invocation.taskRoot, `${batch.projectRoot}/release-tasks`);
  assert.equal(invocation.taskId, batch.taskId); assert.equal(invocation.attemptId, batch.attemptId);
  assert.ok(RELEASE_PHASES.includes(phase) || phase === 'recovery');
  const context = assertContext(batch, batchFile);
  if (phase === 'capture') assertSeed(batch); else assertManifest(batch);
  engineContext.configureReleaseContext(context);
  if (phase === 'switch') {
    assert.equal(typeof engineContext.configureBoundaryRecorder, 'function', 'Shared switch requires the durable boundary recorder');
    engineContext.configureBoundaryRecorder(async record => {
      assert.equal(record.schema, 'sd2-release-boundary.v1'); assert.equal(record.taskId, batch.taskId);
      assert.equal(record.attemptId, batch.attemptId); assert.equal(record.runId, batch.runId);
      assert.deepEqual(record.engine, batch.engine);
      assert.ok(['preparation', 'drain', 'publish', 'health', 'reopen'].includes(record.name));
      assert.ok(['intent', 'result'].includes(record.edge));
      const manifestSha256 = digest(rootDocument(batch.manifestFile, 32 * 1024 * 1024).bytes);
      return recordAttemptEvent({ root: invocation.taskRoot, taskId: batch.taskId, attemptId: batch.attemptId,
        owner: invocation.owner, name: 'switch_boundary', value: { ...record, manifestSha256,
          operation: operation(batch) }, now: Date.now() });
    });
  }
  const release = await import('./release.mjs');
  return phase === 'recovery' ? release.execute('recovery', batch.manifestFile) : callReleasePhase(release, phase, batch);
}

function normalizeChild(result) {
  return { status: result.status ?? null, signal: result.signal ?? null,
    error: result.error ? { code: result.error.code === undefined ? null : String(result.error.code), message: String(result.error.message).slice(0, 4000) } : null };
}

function childReceiptFile(loaded, phase, intentSha256) {
  return path.join(loaded.place.attempt, `${phase}-${intentSha256}.child.json`);
}

function childProcessFile(loaded, phase, intentSha256) {
  return path.join(loaded.place.attempt, `${phase}-${intentSha256}.process.json`);
}

function kernelStartTicks(pid) {
  const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'), fields = text.slice(text.lastIndexOf(')') + 2).split(/\s+/);
  assert.match(fields[19], /^\d+$/); return fields[19];
}

async function defaultRunChild({ batchFile, phase, loaded, intentSha256, owner, batch }) {
  const processFile = childProcessFile(loaded, phase, intentSha256);
  const invocation = { schema: 'sd2-release-phase-invocation.v1', batchFile, phase,
    taskRoot: `${batch.projectRoot}/release-tasks`, taskId: batch.taskId, attemptId: batch.attemptId, owner, processFile };
  const invocationFile = path.join(loaded.place.attempt, `${phase}-${intentSha256}.invocation.json`);
  const invocationSaved = writeJsonExclusive(invocationFile, invocation), startedAt = Date.now();
  const childProcess = spawn(process.execPath, [path.join(here, 'release-entry.mjs'), 'child', invocationFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' },
  });
  assert.ok(Number.isSafeInteger(childProcess.pid) && childProcess.pid > 1, 'Release child did not obtain a process identity');
  const childOwner = { pid: childProcess.pid, host: os.hostname(), kernelStartTicks: kernelStartTicks(childProcess.pid), token: owner.token };
  writeJsonExclusive(processFile, { schema: 'sd2-release-child-process.v1', invocationFile,
    invocationSha256: invocationSaved.sha256, owner: childOwner });
  const output = await new Promise(resolve => {
    const stdout = [], stderr = []; let bytes = 0, originalError = null, settled = false;
    const collect = target => chunk => {
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) {
        originalError ||= Object.assign(new Error('Release child output exceeded its fixed bound'), { code: 'ENOBUFS' });
        childProcess.kill('SIGTERM'); return;
      }
      target.push(chunk);
    };
    childProcess.stdout.on('data', collect(stdout)); childProcess.stderr.on('data', collect(stderr));
    childProcess.once('error', error => { originalError ||= error; });
    const timer = setTimeout(() => { originalError ||= Object.assign(new Error('Release child exceeded its execution bound'),
      { code: 'ETIMEDOUT' }); childProcess.kill('SIGTERM'); }, 45 * 60_000);
    childProcess.once('close', (status, signal) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ status, signal, error: originalError, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
  const child = normalizeChild(output), receipt = { schema: 'sd2-release-phase-child.v1', phase, intentSha256,
    startedAt, finishedAt: Date.now(), child, stdout: output.stdout, stderr: output.stderr };
  const saved = writeJsonExclusive(childReceiptFile(loaded, phase, intentSha256), receipt);
  return { child, receipt, saved };
}

function readChildReceipt(file, phase, intentSha256) {
  const document = rootDocument(file, 64 * 1024 * 1024), { value, bytes } = document;
  assert.equal(value.schema, 'sd2-release-phase-child.v1'); assert.equal(value.phase, phase); assert.equal(value.intentSha256, intentSha256);
  exactKeys(value.child, ['status', 'signal', 'error'], 'preserved child result');
  return { child: value.child, receipt: value, saved: { file, sha256: digest(bytes), bytes: bytes.length } };
}

function parseChildOutput(receipt) {
  const text = receipt.stdout.trim(); assert.ok(text.length > 0, 'Successful release child returned no JSON result');
  const value = JSON.parse(text); assert.ok(value && typeof value === 'object'); return value;
}

function requireMarker(stage, name) {
  const value = markerIdentity(stage, name); assert.ok(value, `Required phase receipt is missing: ${name}`); return value;
}

function assertCandidateArtifact(batch, kind, value, immutable) {
  const artifact = batch.artifacts[kind], build = value.originalBuild || value;
  assert.equal(build.source, artifact.source); assert.equal(build.version, artifact.version);
  assert.equal(build.sourceManifestSha256, artifact.sourceManifestSha256); assert.match(build.compiledTreeSha256, HASH);
  if (artifact.schema === 'sd2-release-artifact-identity.v1') {
    assert.equal(build.build, artifact.build); assert.equal(build.compiledTreeSha256, artifact.compiledTreeSha256);
    assert.equal(immutable.sha256, artifact.immutableSuccessSha256);
  }
  return value;
}

function candidateEvidence(batch, kind) {
  const manifest = assertManifest(batch), stage = path.dirname(batch.manifestFile);
  if (!manifest.reuseBuilds) {
    const file = path.join(stage, `${kind}-build.json`), document = rootDocument(file, 32 * 1024 * 1024), value = document.value;
    assert.equal(value.schema, 'rate-impl2-candidate-build.v1'); assert.equal(value.label, kind);
    assert.equal(value.runId, batch.runId); assert.equal(value.source, batch.artifacts[kind].source);
    assert.equal(value.version, batch.artifacts[kind].version); assert.deepEqual(value.engine, batch.engine);
    const immutable = requireMarker(stage, `${kind}-immutable-success.json`); assertCandidateArtifact(batch, kind, value, immutable);
    return { value, file, sha256: digest(document.bytes), reused: false, immutable };
  }
  const pin = manifest.reuseBuilds[kind];
  assert.ok(pin && typeof pin === 'object' && !Array.isArray(pin)); safeAbsolute(pin.file, `${kind} original immutable success`);
  assert.match(pin.sha256, HASH);
  const original = rootDocument(pin.file, 128 * 1024 * 1024); assert.equal(digest(original.bytes), pin.sha256);
  assert.equal(original.value.schema, 'sd2-immutable-successful-build.v1'); assert.equal(original.value.kind, kind);
  assert.equal(original.value.sourceRun, manifest.reuseBuilds.sourceRun);
  const file = path.join(stage, `${kind}-candidate-reuse.json`), document = rootDocument(file, 128 * 1024 * 1024), value = document.value;
  assert.equal(value.schema, 'sd2-candidate-build-reuse.v1'); assert.equal(value.label, kind);
  assert.equal(value.runId, batch.runId); assert.equal(value.source, batch.artifacts[kind].source);
  assert.equal(value.version, batch.artifacts[kind].version); assert.equal(value.originalSuccessFile, pin.file);
  assert.equal(value.originalSuccessSha256, pin.sha256); assert.equal(value.newCompilationClaimed, false);
  assert.equal(value.exitCode, 0); assert.equal(value.verifiedSourceAndGates, true); assert.deepEqual(value.engine, batch.engine);
  assert.deepEqual(value.originalBuild, original.value.originalReceipt);
  const immutable = { file: pin.file, sha256: pin.sha256, bytes: original.bytes.length };
  assertCandidateArtifact(batch, kind, value, immutable);
  return { value, file, sha256: digest(document.bytes), reused: true, immutable };
}

export function postcheckReleasePhase({ batch, phase, receipt }) {
  assert.equal(receipt.child.status, 0); assert.equal(receipt.child.signal, null); assert.equal(receipt.child.error, null);
  const output = parseChildOutput(receipt), stage = path.dirname(batch.manifestFile);
  if (phase === 'capture') { assertManifest(batch); requireMarker(stage, 'capture.json'); }
  else if (phase === 'preflight') requireMarker(stage, 'native-control-preflight/batch.json');
  else if (phase === 'admission') requireMarker(stage, 'native-control-preflight/receipt.json');
  else if (phase === 'prepare') {
    if (assertManifest(batch).reuseBuilds) {
      for (const kind of ['main', 'guard']) assert.deepEqual(output[kind], candidateEvidence(batch, kind).value);
    } else { requireMarker(stage, 'main-prepared.json'); requireMarker(stage, 'guard-prepared.json'); }
  }
  else if (phase === 'guard-build') assert.deepEqual(output, candidateEvidence(batch, 'guard').value);
  else if (phase === 'main-build') assert.deepEqual(output, candidateEvidence(batch, 'main').value);
  else if (phase === 'verify') { assert.ok(output.main && output.guard); }
  else if (phase === 'arm') requireMarker(stage, 'fixed-guard-recovery.json');
  else if (phase === 'switch') requireMarker(stage, 'switch-complete.json');
  else if (phase === 'proof') {
    assert.equal(output.schema, 'rate-impl2-switch-proof.v1'); assert.equal(output.runId, batch.runId);
    const expected = candidateEvidence(batch, 'main').value;
    assert.equal(output.public?.schema, 'rate-impl2-public-proof.v1'); assert.equal(output.public.runId, batch.runId);
    assert.equal(output.public.manifestSha256, digest(rootDocument(batch.manifestFile, 32 * 1024 * 1024).bytes));
    assert.equal(output.public.source, expected.source); assert.equal(output.public.version, expected.version);
    assert.equal(output.public.build, expected.build); assert.deepEqual(assertManifest(batch).engine, batch.engine);
    requireMarker(stage, 'main-public-proof.json');
  }
  else if (phase === 'recovery') assert.ok(output.completed === true || output.recovered === true || output.schema);
  return output;
}

function capsuleFromBuilds(batch) {
  return Object.fromEntries(['main', 'guard'].map(kind => {
    const evidence = candidateEvidence(batch, kind), build = evidence.reused ? evidence.value.originalBuild : evidence.value;
    assert.equal(build.source, batch.artifacts[kind].source); assert.equal(build.version, batch.artifacts[kind].version);
    assert.equal(build.sourceManifestSha256, batch.artifacts[kind].sourceManifestSha256); assert.equal(build.exitCode, 0);
    return [kind, { schema: 'sd2-release-artifact-identity.v1', kind, source: build.source, version: build.version,
      build: build.build, sourceManifestSha256: build.sourceManifestSha256, compiledTreeSha256: build.compiledTreeSha256,
      immutableSuccessSha256: evidence.immutable.sha256 }];
  }));
}

function verifyBuildInputIdentity(batch) {
  const stage = path.dirname(batch.manifestFile), manifests = {};
  for (const kind of ['main', 'guard']) {
    const file = path.join(stage, kind, 'source-manifest.json'), document = rootDocument(file, 32 * 1024 * 1024);
    assert.equal(digest(document.bytes), batch.artifacts[kind].sourceManifestSha256,
      `${kind} source manifest differs from the attempt-bound build input`);
    const value = document.value; assert.equal(value.kind, kind); assert.equal(value.source, batch.artifacts[kind].source);
    assert.equal(value.version, batch.artifacts[kind].version); manifests[kind] = { file, sha256: digest(document.bytes) };
  }
  return { artifacts: batch.artifacts, sourceManifests: manifests };
}

export function nextReleasePhase(loaded) {
  const succeeded = new Set(loaded.events.filter(item => item.value.kind === 'phase_result' && item.value.outcome === 'succeeded')
    .map(item => item.value.phase));
  return RELEASE_PHASES.find(phase => !succeeded.has(phase)) || null;
}

export function releaseResumeDecision({ ownerStatus, activePhase, effectsStarted, switchComplete, childReceiptPresent }) {
  assert.ok(['alive', 'dead', 'unknown'].includes(ownerStatus));
  if (ownerStatus !== 'dead') return { action: 'refuse', reason: ownerStatus === 'alive' ? 'owner_alive' : 'owner_unknown' };
  if (!activePhase) return { action: 'takeover', reason: 'dead_owner_no_active_phase' };
  if (childReceiptPresent) return { action: 'takeover_reconcile', reason: 'durable_child_exit' };
  if (activePhase === 'switch' && effectsStarted && !switchComplete)
    return { action: 'takeover_recover', reason: 'interrupted_switch_effects_started' };
  return { action: 'takeover_stop_or_refuse', reason: 'original_child_exit_missing' };
}

function switchBoundaryFacts(loaded) {
  const boundaries = loaded.events.filter(item => item.value.kind === 'observation' && item.value.name === 'switch_boundary')
    .map(item => item.value.value);
  const pending = new Set(), effects = new Set();
  for (const boundary of boundaries) {
    const key = boundary.name;
    if (boundary.edge === 'intent') { pending.add(key); if (key !== 'preparation') effects.add(key); }
    else pending.delete(key);
  }
  return { boundaries, pending: [...pending].sort(), effects: [...effects].sort(),
    effectsStarted: pending.size > 0 || effects.size > 0 };
}

export async function runPhaseTransaction({ phase, loaded, owner, before, kernel, executeChild, persistChild, postcheck, after,
  now = Date.now() }) {
  const intent = kernel.startPhase({ phase, dependencyEventSha256: loaded.derivedState.lastEventSha256, before, now });
  let result;
  try { result = await executeChild({ phase, intentSha256: intent.eventSha256 }); }
  catch (error) {
    const child = { status: null, signal: null, error: { code: error.code ? String(error.code) : null,
      message: String(error.message || error).slice(0, 4000) } };
    result = { child, receipt: { schema: 'sd2-release-phase-child.v1', phase, intentSha256: intent.eventSha256,
      startedAt: now, finishedAt: Date.now(), child, stdout: '', stderr: '' } };
  }
  const saved = await persistChild({ phase, intentSha256: intent.eventSha256, result });
  await kernel.recordChild({ name: 'phase_child_exit', value: { phase, intentSha256: intent.eventSha256,
    receiptFile: saved.file, receiptSha256: saved.sha256, child: result.child }, now: Math.max(now + 1, Date.now()) });
  let outcome = 'failed', postcheckError = null;
  if (result.child.status === 0 && result.child.signal === null && result.child.error === null) {
    try { await postcheck({ phase, receipt: result.receipt, saved }); outcome = 'succeeded'; }
    catch (error) { postcheckError = error; }
  }
  const finalScene = await after({ phase, outcome, postcheckError });
  const finished = kernel.finishPhase({ phase, intentSha256: intent.eventSha256, outcome,
    child: result.child, after: finalScene, now: Math.max(now + 2, Date.now()) });
  if (postcheckError) throw postcheckError;
  if (outcome !== 'succeeded') {
    const error = new Error(`Release phase ${phase} child did not exit successfully`); error.code = 'ECHILD'; error.child = result.child; throw error;
  }
  return { intent, child: result.child, saved, finished };
}

function kernelBindings(batchFile, batch) {
  const bytes = rootDocument(batchFile, 1024 * 1024).bytes;
  return { engine: { schema: 'sd2-release-engine-identity.v1', version: batch.engine.version, sha256: batch.engine.controllerSetSha256 },
    manifest: { schema: 'sd2-release-manifest-identity.v1', file: batchFile, sha256: digest(bytes) },
    artifacts: batch.artifacts };
}

function ownerLease(loaded) {
  const file = path.join(loaded.place.attempt, 'owner.lock');
  if (!fs.existsSync(file)) return null;
  const document = rootDocument(file, 16 * 1024), { value, bytes } = document;
  return { file, value, sha256: digest(bytes) };
}

function childProcessOwner(file) {
  const value = rootJson(file, 32 * 1024);
  assert.equal(value.schema, 'sd2-release-child-process.v1');
  assert.ok(value.owner && typeof value.owner === 'object' && !Array.isArray(value.owner));
  return value.owner;
}

export function createReleaseController(overrides = {}) {
  const deps = { now: () => Date.now(), createOwner: createControllerOwner, inspectOwner: inspectControllerOwner,
    scene: captureReleaseScene, runChild: defaultRunChild, postcheck: postcheckReleasePhase, ...overrides };
  const taskRoot = batch => `${batch.projectRoot}/release-tasks`;

  function ensureTaskRoot(batch) {
    const root = taskRoot(batch);
    if (!fs.existsSync(root)) { fs.mkdirSync(root, { mode: 0o700 }); syncDirectory(path.dirname(root)); }
    assert.equal(fs.realpathSync(root), root); const stat = fs.lstatSync(root);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o077) === 0,
      'Release task root must be a private root-owned directory');
    return root;
  }

  function load(batchFile, batch) {
    return readAttempt({ root: taskRoot(batch), taskId: batch.taskId, attemptId: batch.attemptId });
  }

  function status(batchFile) {
    const batch = readReleaseBatch(batchFile), loaded = load(batchFile, batch), lease = ownerLease(loaded);
    const ownerStatus = lease ? deps.inspectOwner(lease.value.owner) : (loaded.derivedState.terminal ? 'none' : 'unknown');
    return { schema: 'sd2-release-status.v1', taskId: batch.taskId, attemptId: batch.attemptId,
      status: loaded.derivedState.status, ownerStatus, activePhase: loaded.derivedState.activePhase,
      lastPhase: loaded.derivedState.lastPhase, nextPhase: nextReleasePhase(loaded), terminal: loaded.derivedState.terminal,
      eventHead: loaded.derivedState.lastEventSha256 };
  }

  function inspect(batchFile) {
    const summary = status(batchFile), batch = readReleaseBatch(batchFile), loaded = load(batchFile, batch);
    return { ...summary, events: loaded.events.map(item => ({ sequence: item.value.sequence, kind: item.value.kind,
      phase: item.value.phase || null, name: item.value.name || null, outcome: item.value.outcome || null, sha256: item.sha256 })) };
  }

  function start(batchFile, windowFile) {
    const batch = readReleaseBatch(batchFile); assertContext(batch, batchFile); assertSeed(batch);
    ensureTaskRoot(batch);
    const owner = deps.createOwner(), now = deps.now(), window = releaseWindowReference(batch, windowFile, now), before = deps.scene(batch, now);
    const bindings = kernelBindings(batchFile, batch);
    return startAttempt({ root: taskRoot(batch), taskId: batch.taskId, attemptId: batch.attemptId, runId: batch.runId,
      owner, ...bindings, window, before, now, inspectOwner: deps.inspectOwner });
  }

  function acquire(batchFile, windowFile) {
    const batch = readReleaseBatch(batchFile), loaded = load(batchFile, batch), bindings = kernelBindings(batchFile, batch);
    assert.equal(loaded.derivedState.status, 'running', 'Only a running attempt may be resumed or advanced');
    assertAttemptBindings(loaded, bindings);
    const lease = ownerLease(loaded); assert.ok(lease, 'Running attempt has no exact owner lease');
    const ownerStatus = deps.inspectOwner(lease.value.owner), now = deps.now(), window = releaseWindowReference(batch, windowFile, now);
    const scene = deps.scene(batch, now), childFile = loaded.derivedState.activePhase
      ? childReceiptFile(loaded, loaded.derivedState.activePhase.phase, loaded.derivedState.activePhase.intentSha256) : null;
    const processFile = loaded.derivedState.activePhase
      ? childProcessFile(loaded, loaded.derivedState.activePhase.phase, loaded.derivedState.activePhase.intentSha256) : null;
    if (childFile && !fs.existsSync(childFile) && processFile && fs.existsSync(processFile)) {
      const childStatus = deps.inspectOwner(childProcessOwner(processFile));
      if (childStatus !== 'dead') {
        const code = childStatus === 'alive' ? 'EBUSY' : 'ENODATA';
        throw new ReleaseEngineError(classifyReleaseError(Object.assign(new Error(`release_child_${childStatus}`), { code }), {
          phase: 'resume', object: { kind: 'release_child', id: batch.attemptId }, verifiedBusy: childStatus === 'alive',
          busyEvidence: childStatus === 'alive' ? `processFile=${path.basename(processFile)}` : undefined }));
      }
    }
    const boundary = switchBoundaryFacts(loaded), effectsStarted = scene.facts.effectsStarted || boundary.effectsStarted;
    const interruptedSwitch = loaded.derivedState.activePhase?.phase === 'switch'
      || (loaded.derivedState.lastPhase?.phase === 'switch' && loaded.derivedState.lastPhase.outcome !== 'succeeded');
    const resumablePhase = loaded.derivedState.activePhase?.phase || (interruptedSwitch ? 'switch' : null);
    const decision = releaseResumeDecision({ ownerStatus, activePhase: resumablePhase,
      effectsStarted, switchComplete: scene.facts.switchComplete,
      childReceiptPresent: Boolean(childFile && fs.existsSync(childFile)) });
    if (decision.action === 'refuse') throw new ReleaseEngineError(classifyReleaseError(Object.assign(new Error(decision.reason),
      { code: ownerStatus === 'alive' ? 'EBUSY' : 'ENODATA' }), { phase: 'resume', object: { kind: 'attempt', id: batch.attemptId },
      verifiedBusy: ownerStatus === 'alive', busyEvidence: ownerStatus === 'alive' ? `pid=${lease.value.owner.pid};host=${lease.value.owner.host}` : undefined }));
    const owner = deps.createOwner();
    takeoverAttempt({ root: taskRoot(batch), taskId: batch.taskId, attemptId: batch.attemptId, owner,
      priorLeaseSha256: lease.sha256, ...bindings, window, now, inspectOwner: deps.inspectOwner });
    recordAttemptEvent({ root: taskRoot(batch), taskId: batch.taskId, attemptId: batch.attemptId, owner,
      name: 'resume_scene', value: scene, now: Math.max(now + 1, deps.now()) });
    return { batch, owner, decision, loaded: load(batchFile, batch), scene, childFile, boundary };
  }

  async function reconcileActive(batchFile, acquired) {
    const { batch, owner, decision, childFile } = acquired, loaded = load(batchFile, batch), active = loaded.derivedState.activePhase;
    if (!active && decision.action !== 'takeover_recover') return { resolved: true, loaded };
    const common = { root: taskRoot(batch), taskId: batch.taskId, attemptId: batch.attemptId, owner };
    if (decision.action === 'takeover_reconcile') {
      const saved = readChildReceipt(childFile, active.phase, active.intentSha256);
      if (!loaded.events.some(item => item.value.kind === 'observation' && item.value.value?.receiptSha256 === saved.saved.sha256))
        recordAttemptEvent({ ...common, name: 'phase_child_exit', value: { phase: active.phase, intentSha256: active.intentSha256,
          receiptFile: saved.saved.file, receiptSha256: saved.saved.sha256, child: saved.child }, now: deps.now() });
      let outcome = 'failed', error = null;
      if (saved.child.status === 0 && saved.child.signal === null && saved.child.error === null) {
        try { deps.postcheck({ batch, phase: active.phase, receipt: saved.receipt, saved: saved.saved }); outcome = 'succeeded'; }
        catch (failure) { error = failure; }
      }
      const after = deps.scene(batch, deps.now());
      finishPhase({ ...common, phase: active.phase, intentSha256: active.intentSha256, outcome, child: saved.child,
        after, now: deps.now() });
      if (outcome === 'succeeded' && active.phase === 'main-build'
        && batch.artifacts.main.schema === 'sd2-release-artifact-input.v1')
        recordAttemptEvent({ ...common, name: 'artifact_capsule', value: capsuleFromBuilds(batch), now: deps.now() });
      if (outcome === 'succeeded' && active.phase === 'proof')
        finishAttempt({ ...common, outcome: 'succeeded', after, now: deps.now() });
      if (outcome === 'failed') {
        const current = load(batchFile, batch), boundary = switchBoundaryFacts(current);
        if (!(active.phase === 'switch' && (after.facts.effectsStarted || boundary.effectsStarted)))
          finishAttempt({ ...common, outcome: 'failed', after, now: deps.now() });
      }
      if (error) throw error;
      return { resolved: true, loaded: load(batchFile, batch) };
    }
    if (decision.action === 'takeover_recover') {
      assert.equal(acquired.scene.facts.fixedGuardRecoveryAvailable, true,
        'Effectful interrupted switch has no fixed guard recovery authority');
      if (active) finishPhase({ ...common, phase: active.phase, intentSha256: active.intentSha256, outcome: 'interrupted', child: null,
        after: acquired.scene, now: deps.now() });
      if (!acquired.scene.facts.files['guard-recovery-complete.json']) await execute(batchFile, acquired, 'recovery');
      finishAttempt({ ...common, outcome: 'rolled_back', after: deps.scene(batch, deps.now()), now: deps.now() });
      return { resolved: true, recovered: true, loaded: load(batchFile, batch) };
    }
    if (decision.action === 'takeover_stop_or_refuse') {
      const intent = loaded.events.find(item => item.sha256 === active.intentSha256)?.value;
      const unchanged = intent?.before?.sha256 === acquired.scene.sha256;
      if (unchanged) {
        finishPhase({ ...common, phase: active.phase, intentSha256: active.intentSha256, outcome: 'interrupted', child: null,
          after: acquired.scene, now: deps.now() });
        finishAttempt({ ...common, outcome: 'stopped', after: acquired.scene, now: deps.now() });
        return { resolved: true, stoppedForFreshAttempt: true, loaded: load(batchFile, batch) };
      }
      const error = new Error('Original child exit is missing and the fresh scene differs from phase intent; dependent work remains stopped');
      error.code = 'ENODATA'; throw error;
    }
    return { resolved: false, loaded };
  }

  async function execute(batchFile, acquired, phase) {
    const { batch, owner } = acquired;
    const common = { root: taskRoot(batch), taskId: batch.taskId, attemptId: batch.attemptId, owner };
    if (phase === 'guard-build') recordAttemptEvent({ ...common, name: 'build_input_identity',
      value: verifyBuildInputIdentity(batch), now: deps.now() });
    const loaded = load(batchFile, batch), before = deps.scene(batch, deps.now());
    const kernel = {
      startPhase: input => startPhase({ ...common, ...input }),
      recordChild: input => recordAttemptEvent({ ...common, ...input }),
      finishPhase: input => finishPhase({ ...common, ...input }),
    };
    const result = await runPhaseTransaction({ phase, loaded, owner, before, kernel,
      executeChild: input => deps.runChild({ ...input, batchFile, batch, loaded, owner }),
      persistChild: ({ intentSha256, result: child }) => child.saved
        || writeJsonExclusive(childReceiptFile(loaded, phase, intentSha256), child.receipt),
      postcheck: ({ receipt, saved }) => deps.postcheck({ batch, phase, receipt, saved }),
      after: () => deps.scene(batch, deps.now()), now: deps.now() });
    if (phase === 'main-build' && batch.artifacts.main.schema === 'sd2-release-artifact-input.v1')
      recordAttemptEvent({ ...common, name: 'artifact_capsule', value: capsuleFromBuilds(batch), now: deps.now() });
    if (phase === 'proof') finishAttempt({ ...common, outcome: 'succeeded', after: deps.scene(batch, deps.now()), now: deps.now() });
    return result;
  }

  async function run(batchFile, windowFile, requestedPhase = null, approvalFile = null) {
    const acquired = acquire(batchFile, windowFile);
    const reconciled = await reconcileActive(batchFile, acquired);
    if (reconciled.recovered || reconciled.stoppedForFreshAttempt) return reconciled;
    const loaded = load(batchFile, acquired.batch), phase = nextReleasePhase(loaded);
    assert.ok(phase, 'Release attempt has no remaining phase');
    if (requestedPhase !== null) assert.equal(requestedPhase, phase, 'Requested phase is not the next immutable phase');
    if (['arm', 'switch'].includes(phase)) {
      assert.ok(approvalFile, `${phase} requires an explicit fresh approval file`); assertApproval(acquired.batch, approvalFile, deps.now());
    }
    try { return await execute(batchFile, { ...acquired, loaded }, phase); }
    catch (error) {
      const current = load(batchFile, acquired.batch), scene = deps.scene(acquired.batch, deps.now());
      const boundary = switchBoundaryFacts(current);
      if (current.derivedState.activePhase === null && !(phase === 'switch' && (scene.facts.effectsStarted || boundary.effectsStarted)))
        finishAttempt({ root: taskRoot(acquired.batch), taskId: acquired.batch.taskId, attemptId: acquired.batch.attemptId,
          owner: acquired.owner, outcome: 'failed', after: scene, now: deps.now() });
      throw error;
    }
  }

  async function resume(batchFile, windowFile) {
    const acquired = acquire(batchFile, windowFile);
    return reconcileActive(batchFile, acquired);
  }

  return { start, run, resume, status, inspect };
}

export function validateEngineInstall(value) {
  exactKeys(value, ['schema', 'projectRoot', 'sourceRoot', 'engine', 'privateSha256'], 'engine installation');
  assert.equal(value.schema, 'sd2-release-engine-install.v1'); safeAbsolute(value.projectRoot, 'project root');
  safeAbsolute(value.sourceRoot, 'engine source root'); validateEngine(value.engine, value.projectRoot);
  assert.ok(value.privateSha256 && typeof value.privateSha256 === 'object' && !Array.isArray(value.privateSha256));
  assert.ok(Object.keys(value.privateSha256).length > 0 && Object.keys(value.privateSha256).length <= 256);
  for (const [file, sha256] of Object.entries(value.privateSha256)) {
    assert.equal(path.basename(file), file); assert.ok(file.endsWith('.mjs')); assert.match(sha256, HASH);
  }
  assert.equal(digest(JSON.stringify(value.privateSha256)), value.engine.controllerSetSha256);
  return value;
}

function verifyInstalledEngine(input) {
  assert.equal(fs.realpathSync(input.engine.root), input.engine.root); const directory = fs.lstatSync(input.engine.root);
  assert.ok(directory.isDirectory() && !directory.isSymbolicLink() && directory.uid === 0 && (directory.mode & 0o077) === 0);
  const names = fs.readdirSync(input.engine.root).filter(name => name.endsWith('.mjs')).sort();
  assert.deepEqual(names, Object.keys(input.privateSha256).sort());
  for (const name of names) {
    const file = path.join(input.engine.root, name), stat = fs.lstatSync(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 && stat.nlink === 1 && !(stat.mode & 0o022));
    assert.equal(digest(fs.readFileSync(file)), input.privateSha256[name]);
  }
  return true;
}

export function installReleaseEngine(installFile) {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  const input = validateEngineInstall(rootJson(installFile, 1024 * 1024)), parent = path.dirname(input.engine.root);
  if (fs.existsSync(input.engine.root)) { verifyInstalledEngine(input); return { installed: false, reused: true, engine: input.engine }; }
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { mode: 0o700 });
  assert.equal(fs.realpathSync(input.sourceRoot), input.sourceRoot); const sourceDirectory = fs.lstatSync(input.sourceRoot);
  assert.ok(sourceDirectory.isDirectory() && !sourceDirectory.isSymbolicLink() && sourceDirectory.uid === 0 && !(sourceDirectory.mode & 0o022));
  const temporary = path.join(parent, `.install-${randomUUID()}`); fs.mkdirSync(temporary, { mode: 0o700 });
  for (const [name, expected] of Object.entries(input.privateSha256)) {
    const source = path.join(input.sourceRoot, name), stat = fs.lstatSync(source);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 && stat.nlink === 1 && !(stat.mode & 0o022));
    const fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); let bytes;
    try { assert.equal(fs.fstatSync(fd).ino, stat.ino); bytes = fs.readFileSync(fd); assert.equal(fs.fstatSync(fd).ino, stat.ino); }
    finally { fs.closeSync(fd); }
    assert.equal(digest(bytes), expected);
    fs.writeFileSync(path.join(temporary, name), bytes, { flag: 'wx', mode: 0o600 });
  }
  fs.renameSync(temporary, input.engine.root); syncDirectory(parent); verifyInstalledEngine(input);
  return { installed: true, reused: false, engine: input.engine };
}

function print(value) { process.stdout.write(JSON.stringify(value) + '\n'); }

export async function releaseEntryCli(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (command === 'package' && args.length === 2) return print(await packageReleaseCandidates(args[0], args[1]));
  if (command === 'native' && args.length >= 2) return invokeNativeFixture({ contextFile: args[0], fixture: args[1], args: args.slice(2) });
  if (command === 'child' && args.length === 1) return print(await invokeReleaseChild({ invocationFile: args[0] }));
  if (command === 'install-engine' && args.length === 1) return print(installReleaseEngine(args[0]));
  const controller = createReleaseController();
  if (command === 'start' && args.length === 2) return print(controller.start(args[0], args[1]).derivedState);
  if (command === 'status' && args.length === 1) return print(controller.status(args[0]));
  if (command === 'inspect' && args.length === 1) return print(controller.inspect(args[0]));
  if (command === 'resume' && args.length === 2) return print(await controller.resume(args[0], args[1]));
  if (command === 'run' && args.length >= 2 && args.length <= 4)
    return print(await controller.run(args[0], args[1], args[2] || null, args[3] || null));
  throw new Error('Usage: release-entry.mjs package CONTEXT.json REQUEST.json | native CONTEXT.json FIXTURE.mjs [...args] | install-engine INSTALL.json | start BATCH.json WINDOW.json | status BATCH.json | inspect BATCH.json | resume BATCH.json WINDOW.json | run BATCH.json WINDOW.json [PHASE [APPROVAL.json]]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  releaseEntryCli().catch(error => {
    const record = error?.releaseError || classifyReleaseError(error, { phase: process.argv[2] || 'entry' });
    process.stderr.write(JSON.stringify({ error: record, cause: String(error) }) + '\n'); process.exitCode = 1;
  });
}
