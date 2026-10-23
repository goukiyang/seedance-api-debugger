import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import * as engineContext from './engine-context.mjs';
import { readTypedJson, readTypedFile, assertTypedFileUnchanged } from './typed-files.mjs';
import { classifyReleaseError, ReleaseEngineError } from './release-errors.mjs';
import {
  assertAttemptBindings,
  continueFailedAttempt,
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
const PREPARE_TAIL_SCHEMA = 'sd2-release-prepare-tail-continuation.v1';
const PREPARE_TAIL_PROOF_SCHEMA = 'sd2-release-prepare-tail-proof.v1';
const PREPARE_TAIL_CONTROLLERS = Object.freeze(['release-entry.mjs', 'candidate.mjs', 'candidate-inputs.mjs',
  'release-entry-engineering.mjs', 'candidate-lifecycle-engineering.mjs']);
const GUARD_TAIL_SCHEMA = 'sd2-release-guard-build-tail-continuation.v1';
const GUARD_TAIL_PROOF = 'sd2-release-guard-build-tail-proof.v1';
const GUARD_TAIL_RETRY_SCHEMA = 'sd2-release-guard-build-tail-retry.v1';
const GUARD_TAIL_RETRY_PROOF = 'sd2-release-guard-build-tail-retry-proof.v1';
const READER_SUCCESSOR_SCHEMA = 'sd2-release-reader-successor.v1';
const READER_SUCCESSOR_PROOF = 'sd2-release-reader-successor-proof.v1';
const ARM_PAIR_REPAIR_SCHEMA = 'sd2-release-arm-pair-repair.v1';
const ARM_PAIR_REPAIR_PROOF = 'sd2-release-arm-pair-repair-proof.v1';
export const ARM_PAIR_REPAIR_ORIGIN = Object.freeze({
  runId: 'f5646431-2d69-44f6-9c62-5994432f3ade', taskId: '22b243fa-7def-4142-a5ef-7b7e0101740e',
  terminalEventSha256: 'f2e04870ae2b4a71972d7103d65e2205e8c57b0e3bcd166546e8c18f2548edbd',
  phaseResultEventSha256: '2f5a6251592a8a96dcc8800201853d7b8082064fd79ac1068c1b8c5e5f6b66b0',
  readerProofSha256: 'bca81224d9ddef6769eb58c3efe2a5703949a752cd32568496e3f12da9a81892',
  candidateObservationProofSha256: '6752e462489b047dfce1ad73a80e7182f3219b1b39a2dbf1f32aaf6ad3af5c3e',
  predecessorControllerSetSha256: 'cdc7ea696bec5545ccc2b83617e5720a62a817c08cdf58e657b0d49c2677b14c',
});
const ARM_PAIR_REPAIR_CONTROLLERS = Object.freeze(['release-entry.mjs', 'candidate-evidence.mjs', 'release.mjs',
  'pricing-start-pair.mjs', 'switch.mjs', 'cutover-driver.mjs', 'guard-recovery.mjs',
  'release-entry-engineering.mjs', 'candidate-lifecycle-engineering.mjs', 'cutover-driver-engineering.mjs']);
export const READER_SUCCESSOR_PHASES = Object.freeze(['verify', 'arm', 'switch', 'proof', 'recovery']);
const READER_SUCCESSOR_CONTROLLERS = Object.freeze(['release-entry.mjs', 'candidate-evidence.mjs', 'release.mjs',
  'candidate.mjs', 'candidate-inputs.mjs', 'cutover-driver.mjs', 'cutover-safety.mjs', 'release-entry-engineering.mjs',
  'candidate-lifecycle-engineering.mjs', 'cutover-driver-engineering.mjs', 'cutover-safety-engineering.mjs', 'hd-release-safety-engineering.mjs']);
const OBSERVATION_PROTECTION_FIELDS = Object.freeze(['databaseIdentity', 'files', 'marker', 'otherServices',
  'settingsSha256', 'protectedTasks', 'protectedFailedVideo']);
export const GUARD_BUILD_TAIL_PHASES = Object.freeze(['guard-build', 'main-build', 'verify', 'arm', 'switch', 'proof', 'recovery']);
const GUARD_TAIL_CONTROLLERS = Object.freeze(['release-entry.mjs', 'attempt-state.mjs', 'release.mjs',
  'release-entry-engineering.mjs', 'attempt-state-engineering.mjs', 'candidate.mjs', 'candidate-evidence.mjs',
  'candidate-reuse.mjs', 'candidate-inputs.mjs', 'candidate-lifecycle-engineering.mjs', 'switch.mjs', 'hd-compiled-cache.mjs',
  'hd-storage-preflight.mjs', 'hd-closed-cache-engineering.mjs', 'hd-storage-preflight-engineering.mjs']);

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
  const reused = value?.schema === 'sd2-release-package-request.v2';
  exactKeys(value, ['schema', 'repoRoot', 'mainSource', 'guardSource', 'outputRoot', ...(reused ? ['originalBuilds'] : [])], 'release package request');
  assert.ok(reused || value.schema === 'sd2-release-package-request.v1');
  if (reused) {
    exactKeys(value.originalBuilds, ['directory', 'sourceRun', 'manifestSha256', 'mainSha256', 'guardSha256'], 'original full-build package');
    safeAbsolute(value.originalBuilds.directory, 'original build package directory'); assert.match(value.originalBuilds.sourceRun, UUID);
    for (const key of ['manifestSha256', 'mainSha256', 'guardSha256']) assert.match(value.originalBuilds[key], HASH);
  }
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
  assert.ok(NATIVE_FIXTURES.includes(name) || name === 'full-release-engineering.mjs', 'Native bootstrap fixture is not in the reviewed 19-file allowlist');
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

export function validatePrepareTailContinuation(value) {
  exactKeys(value, ['schema', 'terminalEventSha256', 'phaseResultEventSha256', 'childReceiptSha256',
    'processorControllerSetSha256', 'mainPreparedSha256', 'guardInputSha256'], 'prepare-tail continuation');
  assert.equal(value.schema, PREPARE_TAIL_SCHEMA);
  for (const [key, hash] of Object.entries(value)) if (key !== 'schema') assert.match(hash, HASH);
  return value;
}

export function assertPrepareTailControllerDifference(original, processor) {
  assert.deepEqual(Object.keys(processor).sort(), Object.keys(original).sort(), 'Prepare-tail processor must retain the entire original module set');
  const changed = {};
  for (const name of Object.keys(original).sort()) {
    assert.equal(path.basename(name), name); assert.ok(name.endsWith('.mjs'));
    assert.match(original[name], HASH); assert.match(processor[name], HASH);
    if (original[name] !== processor[name]) {
      assert.ok(PREPARE_TAIL_CONTROLLERS.includes(name), 'Unreviewed prepare-tail processor difference: ' + name);
      changed[name] = { originalSha256: original[name], processorSha256: processor[name] };
    }
  }
  assert.ok(changed['release-entry.mjs'] && changed['candidate.mjs'], 'Prepare-tail requires the actual new entry and candidate handlers');
  return changed;
}

function stableControllerHashes(directory) {
  safeAbsolute(directory, 'controller directory'); assert.equal(fs.realpathSync(directory), directory);
  const stat = fs.lstatSync(directory);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && !(stat.mode & 0o077));
  const names = fs.readdirSync(directory).filter(name => name.endsWith('.mjs')).sort(), result = {};
  assert.ok(names.length > 0 && names.length <= 256);
  for (const name of names) {
    const file = path.join(directory, name), before = fs.lstatSync(file);
    assert.equal(fs.realpathSync(file), file);
    assert.ok(before.isFile() && !before.isSymbolicLink() && before.uid === 0 && before.nlink === 1
      && !(before.mode & 0o022) && before.size > 0 && before.size <= 32 * 1024 * 1024);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd), bytes = fs.readFileSync(fd), after = fs.fstatSync(fd), named = fs.lstatSync(file);
      for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs']) {
        assert.equal(opened[key], before[key]); assert.equal(after[key], before[key]); assert.equal(named[key], before[key]);
      }
      result[name] = digest(bytes);
    } finally { fs.closeSync(fd); }
  }
  assert.deepEqual(fs.readdirSync(directory).filter(name => name.endsWith('.mjs')).sort(), names);
  assert.equal(fs.realpathSync(directory), directory);
  for (const key of ['dev', 'ino', 'uid', 'gid', 'mode']) assert.equal(fs.lstatSync(directory)[key], stat[key]);
  return result;
}

function prepareTailProcessor(batch, processorControllerSetSha256) {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  const processor = { ...batch.engine, controllerSetSha256: processorControllerSetSha256,
    root: `${batch.projectRoot}/release-engines/${ENGINE_VERSION}-${processorControllerSetSha256}` };
  validateEngine(processor, batch.projectRoot); assert.equal(here, processor.root);
  assert.notEqual(processor.root, batch.engine.root, 'Never replace the original frozen engine');
  const originalHashes = stableControllerHashes(batch.engine.root), processorHashes = stableControllerHashes(processor.root);
  assert.equal(digest(JSON.stringify(originalHashes)), batch.engine.controllerSetSha256, 'Original frozen engine bytes changed');
  assert.equal(digest(JSON.stringify(processorHashes)), processor.controllerSetSha256, 'Prepare-tail processor bytes changed');
  return { processor, changedControllers: assertPrepareTailControllerDifference(originalHashes, processorHashes) };
}

function prepareTailFailure(batch, loaded, request, inspectOwner) {
  validatePrepareTailContinuation(request);
  const terminalIndex = loaded.events.findIndex(item => item.sha256 === request.terminalEventSha256);
  assert.ok(terminalIndex >= 3, 'Original failed prepare terminal is missing');
  const terminal = loaded.events[terminalIndex], result = loaded.events[terminalIndex - 1], exit = loaded.events[terminalIndex - 2];
  assert.equal(terminal.value.kind, 'attempt_finished'); assert.equal(terminal.value.outcome, 'failed');
  assert.equal(result.sha256, request.phaseResultEventSha256); assert.equal(result.value.kind, 'phase_result');
  assert.equal(result.value.phase, 'prepare'); assert.equal(result.value.outcome, 'failed');
  assert.equal(terminal.value.previousSha256, result.sha256); assert.equal(result.value.previousSha256, exit.sha256);
  assert.equal(exit.value.kind, 'observation'); assert.equal(exit.value.name, 'phase_child_exit');
  assert.equal(exit.value.value.phase, 'prepare'); assert.equal(exit.value.value.intentSha256, result.value.intentSha256);
  assert.equal(exit.value.value.receiptSha256, request.childReceiptSha256);
  assert.equal(exit.value.value.receiptFile, childReceiptFile(loaded, 'prepare', result.value.intentSha256));
  const original = { events: loaded.events.slice(0, terminalIndex + 1) };
  assert.equal(nextReleasePhase(original), 'prepare');
  assert.equal(original.events.some(item => item.value.kind === 'phase_intent'
    && RELEASE_PHASES.indexOf(item.value.phase) > RELEASE_PHASES.indexOf('prepare')), false);
  assert.equal(switchBoundaryFacts(original).effectsStarted, false);
  const saved = readChildReceipt(exit.value.value.receiptFile, 'prepare', result.value.intentSha256);
  assert.equal(saved.saved.sha256, request.childReceiptSha256);
  assert.deepEqual(saved.child, exit.value.value.child); assert.deepEqual(saved.child, result.value.child);
  assert.ok(Number.isSafeInteger(saved.child.status) && saved.child.status > 0, 'Prepare-tail requires a real failed child exit');
  assert.equal(saved.child.signal, null); assert.equal(saved.child.error, null);
  assert.deepEqual(result.value.owner, terminal.value.owner); assert.deepEqual(exit.value.owner, terminal.value.owner);
  assert.equal(inspectOwner(terminal.value.owner), 'dead', 'Original prepare controller must be proven dead');
  const processFile = childProcessFile(loaded, 'prepare', result.value.intentSha256), processDocument = rootDocument(processFile, 32768);
  const child = processDocument.value, invocationFile = path.join(loaded.place.attempt, `prepare-${result.value.intentSha256}.invocation.json`);
  assert.equal(child.schema, 'sd2-release-child-process.v1'); assert.equal(child.invocationFile, invocationFile);
  const invocationDocument = rootDocument(invocationFile, 256 * 1024), invocation = validateInvocation(invocationDocument.value, invocationFile);
  assert.equal(child.invocationSha256, digest(invocationDocument.bytes)); assert.equal(invocation.processFile, processFile);
  assert.equal(invocation.batchFile, loaded.header.manifest.file); assert.equal(invocation.phase, 'prepare');
  assert.equal(invocation.taskRoot, `${batch.projectRoot}/release-tasks`);
  assert.equal(invocation.taskId, batch.taskId); assert.equal(invocation.attemptId, batch.attemptId);
  assert.deepEqual(invocation.owner, terminal.value.owner); assert.equal(child.owner.token, invocation.owner.token);
  assert.equal(inspectOwner(child.owner), 'dead', 'Original prepare child must be proven dead');
  assert.equal(result.value.after.facts.files['main-prepared.json']?.sha256, request.mainPreparedSha256);
  assert.equal(result.value.after.facts.files['guard-prepared.json'], null);
  assert.equal(terminal.value.after.facts.files['main-prepared.json']?.sha256, request.mainPreparedSha256);
  return { terminal, result, processReceiptSha256: digest(processDocument.bytes), invocationSha256: digest(invocationDocument.bytes) };
}

function assertPrepareTailInputs(batch, request, scene) {
  const manifest = assertManifest(batch), stage = path.dirname(batch.manifestFile);
  assert.ok(manifest.fullRelease && !manifest.reuseBuilds, 'Prepare-tail is restricted to the original FULL input build');
  assert.equal(batch.artifacts.main.schema, 'sd2-release-artifact-input.v1');
  assert.equal(scene.facts.effectsStarted, false); assert.equal(scene.facts.switchComplete, false);
  for (const name of ['guard-prepared.json', 'main-build.json', 'guard-build.json', 'main-immutable-success.json',
    'guard-immutable-success.json', 'fixed-guard-recovery.json', 'switch-before.json', 'pricing-pair-published.json', 'switch-complete.json'])
    assert.equal(fs.lstatSync(path.join(stage, name), { throwIfNoEntry: false }), undefined, 'Prepare-tail must precede build and switching: ' + name);
  verifyBuildInputIdentity(batch);
  const main = rootDocument(path.join(stage, 'main-prepared.json'), 32 * 1024 * 1024);
  assert.equal(digest(main.bytes), request.mainPreparedSha256); assert.equal(main.value.label, 'main');
  assert.equal(main.value.runId, batch.runId); assert.equal(main.value.manifestSha256, digest(rootDocument(batch.manifestFile, 32 * 1024 * 1024).bytes));
  assert.equal(main.value.sourceManifestSha256, batch.artifacts.main.sourceManifestSha256);
  for (const kind of ['main', 'guard']) {
    const candidate = manifest[kind]; safeAbsolute(candidate.root, kind + ' candidate root');
    assert.equal(candidate.source, batch.artifacts[kind].source); assert.equal(candidate.version, batch.artifacts[kind].version);
    const preparedRoot = path.join(candidate.root, '.role-tests', `pricing-prepared-${batch.runId}`);
    assert.equal(fs.lstatSync(path.join(preparedRoot, '.pricing-gate-claim'), { throwIfNoEntry: false }), undefined, 'Candidate build input was already consumed');
    assert.ok(typeof candidate.buildDist === 'string' && path.basename(candidate.buildDist) === candidate.buildDist);
    assert.equal(fs.lstatSync(path.join(candidate.root, candidate.buildDist), { throwIfNoEntry: false }), undefined, 'Candidate already has build output');
  }
  const guardInputFile = path.join(manifest.guard.root, '.role-tests', `pricing-prepared-${batch.runId}`, 'candidate-inputs.json');
  const guard = rootDocument(guardInputFile, 32 * 1024 * 1024);
  assert.equal(fs.lstatSync(guardInputFile).mode & 0o777, 0o444); assert.equal(digest(guard.bytes), request.guardInputSha256);
  assert.equal(guard.value.schema, 'rate-impl2-candidate-inputs.v1'); assert.equal(guard.value.runId, batch.runId);
  assert.equal(guard.value.source, manifest.guard.source); assert.equal(guard.value.candidateRoot, manifest.guard.root);
  assert.equal(guard.value.buildsRun, false); assert.equal(guard.value.productionDatabaseCopied, false); assert.equal(guard.value.servicesChanged, false);
  return manifest;
}

function prepareTailProofFile(loaded, sha256) { assert.match(sha256, HASH); return path.join(loaded.place.attempt, `prepare-tail-${sha256}.json`); }

function readPrepareTailProof(batch, batchFile, loaded) {
  const continuations = loaded.events.filter(item => item.value.kind === 'failure_continued');
  assert.equal(continuations.length, 1, 'Prepare-tail requires its sole exact failed-attempt continuation');
  const continued = continuations[0], sha256 = continued.value.failureReceiptSha256;
  const file = prepareTailProofFile(loaded, sha256), document = rootDocument(file, 1024 * 1024), proof = document.value;
  assert.equal(digest(document.bytes), sha256);
  exactKeys(proof, ['schema', 'taskId', 'attemptId', 'runId', 'batchFile', 'batchSha256', 'contextSha256', 'seedSha256',
    'manifestSha256', 'artifactsSha256', 'engine', 'processor', 'changedControllers', 'request', 'processReceiptSha256',
    'invocationSha256', 'observedAt'], 'prepare-tail proof');
  assert.equal(proof.schema, PREPARE_TAIL_PROOF_SCHEMA); assert.equal(proof.taskId, batch.taskId);
  assert.equal(proof.attemptId, batch.attemptId); assert.equal(proof.runId, batch.runId); assert.equal(proof.batchFile, batchFile);
  assert.equal(proof.batchSha256, digest(rootDocument(batchFile).bytes));
  assert.equal(proof.contextSha256, digest(rootDocument(batch.contextFile, 256 * 1024).bytes));
  assert.equal(proof.seedSha256, digest(rootDocument(batch.seedFile).bytes));
  assert.equal(proof.manifestSha256, digest(rootDocument(batch.manifestFile, 32 * 1024 * 1024).bytes));
  assert.equal(proof.artifactsSha256, digest(JSON.stringify(batch.artifacts))); assert.deepEqual(proof.engine, batch.engine);
  validatePrepareTailContinuation(proof.request);
  const identity = prepareTailProcessor(batch, proof.request.processorControllerSetSha256);
  assert.deepEqual(proof.processor, identity.processor); assert.deepEqual(proof.changedControllers, identity.changedControllers);
  const failure = prepareTailFailure(batch, loaded, proof.request, inspectControllerOwner);
  assert.equal(continued.value.previousTerminalSha256, failure.terminal.sha256);
  assert.equal(continued.value.previousSha256, failure.terminal.sha256);
  assert.equal(proof.processReceiptSha256, failure.processReceiptSha256); assert.equal(proof.invocationSha256, failure.invocationSha256);
  assertAttemptBindings(loaded, kernelBindings(batchFile, batch));
  assert.equal(nextReleasePhase(loaded), 'prepare'); assert.equal(switchBoundaryFacts(loaded).effectsStarted, false);
  assertPrepareTailInputs(batch, proof.request, captureReleaseScene(batch));
  return { proof, file, sha256 };
}

export function assertPrepareTailChildRoute(phase, originalRoot, processorRoot, proof) {
  if (processorRoot === originalRoot) return false;
  assert.equal(phase, 'prepare', 'Non-prepare phases must use the original frozen release entry');
  assert.ok(proof && proof.schema === PREPARE_TAIL_PROOF_SCHEMA, 'Changed entry requires the journal-bound prepare-tail proof');
  assert.equal(proof.engine.root, originalRoot); assert.equal(proof.processor.root, processorRoot);
  return true;
}

export function validateGuardBuildTailContinuation(value) {
  exactKeys(value, ['schema', 'terminalEventSha256', 'phaseResultEventSha256', 'childReceiptSha256',
    'processorControllerSetSha256', 'mainPreparedSha256', 'guardPreparedSha256', 'buildCommandSha256', 'buildLogSha256',
    'packageJsonSha256', 'buildIdSha256', 'observedCompiledTreeSha256', 'imageGateReceiptSha256', 'pricingGateReceiptSha256', 'observedAt'], 'guard-build tail continuation');
  assert.equal(value.schema, GUARD_TAIL_SCHEMA);
  for (const [key, hash] of Object.entries(value)) if (!['schema', 'observedAt'].includes(key)) assert.match(hash, HASH);
  assert.equal(typeof value.observedAt, 'string'); parseTime(value.observedAt, 'retained build observation'); return value;
}

export function assertGuardBuildTailControllerDifference(original, processor) {
  assert.deepEqual(Object.keys(original).sort(), Object.keys(processor).sort(), 'Guard-tail retains the original complete module set');
  const changed = {};
  for (const name of Object.keys(original).sort()) {
    assert.equal(path.basename(name), name); assert.ok(name.endsWith('.mjs')); assert.match(original[name], HASH); assert.match(processor[name], HASH);
    if (original[name] !== processor[name]) {
      assert.ok(GUARD_TAIL_CONTROLLERS.includes(name), 'Unreviewed guard-tail processor difference: ' + name);
      changed[name] = { originalSha256: original[name], processorSha256: processor[name] };
    }
  }
  for (const name of ['release-entry.mjs', 'attempt-state.mjs', 'release.mjs', 'candidate.mjs', 'hd-compiled-cache.mjs'])
    assert.ok(changed[name], 'Guard-tail requires its actual new handler/reader: ' + name);
  return changed;
}

function guardBuildTailProcessor(batch, hash, { directory = here, requireHere = true } = {}) {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  const processor = { ...batch.engine, controllerSetSha256: hash, root: `${batch.projectRoot}/release-engines/${ENGINE_VERSION}-${hash}` };
  validateEngine(processor, batch.projectRoot); assert.equal(directory, processor.root);
  if (requireHere) assert.equal(here, directory);
  assert.notEqual(directory, batch.engine.root);
  const original = stableControllerHashes(batch.engine.root), processorControllers = stableControllerHashes(directory);
  assert.equal(digest(JSON.stringify(original)), batch.engine.controllerSetSha256);
  assert.equal(digest(JSON.stringify(processorControllers)), hash);
  return { processor, processorControllers, changedControllers: assertGuardBuildTailControllerDifference(original, processorControllers) };
}

function guardBuildTailFailure(batch, loaded, request, inspectOwner) {
  validateGuardBuildTailContinuation(request);
  const index = loaded.events.findIndex(item => item.sha256 === request.terminalEventSha256);
  assert.ok(index >= 3); const terminal = loaded.events[index], result = loaded.events[index - 1], exit = loaded.events[index - 2];
  assert.equal(terminal.value.kind, 'attempt_finished'); assert.equal(terminal.value.outcome, 'failed');
  assert.equal(result.sha256, request.phaseResultEventSha256); assert.equal(result.value.kind, 'phase_result');
  assert.equal(result.value.phase, 'guard-build'); assert.equal(result.value.outcome, 'failed');
  assert.equal(terminal.value.previousSha256, result.sha256); assert.equal(result.value.previousSha256, exit.sha256);
  assert.equal(exit.value.kind, 'observation'); assert.equal(exit.value.name, 'phase_child_exit'); assert.equal(exit.value.value.phase, 'guard-build');
  assert.equal(exit.value.value.intentSha256, result.value.intentSha256);
  assert.equal(exit.value.value.receiptFile, childReceiptFile(loaded, 'guard-build', result.value.intentSha256));
  assert.equal(exit.value.value.receiptSha256, request.childReceiptSha256);
  const original = { events: loaded.events.slice(0, index + 1) };
  assert.equal(nextReleasePhase(original), 'guard-build'); assert.equal(switchBoundaryFacts(original).effectsStarted, false);
  assert.equal(original.events.some(item => item.value.kind === 'phase_intent'
    && RELEASE_PHASES.indexOf(item.value.phase) > RELEASE_PHASES.indexOf('guard-build')), false);
  const child = readChildReceipt(exit.value.value.receiptFile, 'guard-build', result.value.intentSha256);
  assert.equal(child.saved.sha256, request.childReceiptSha256); assert.deepEqual(child.child, result.value.child);
  assert.deepEqual(child.child, exit.value.value.child);
  assert.ok(Number.isSafeInteger(child.child.status) && child.child.status > 0); assert.equal(child.child.signal, null); assert.equal(child.child.error, null);
  assert.deepEqual(exit.value.owner, terminal.value.owner); assert.deepEqual(result.value.owner, terminal.value.owner);
  assert.equal(inspectOwner(terminal.value.owner), 'dead', 'Original failed guard controller must be dead');
  const processFile = childProcessFile(loaded, 'guard-build', result.value.intentSha256), processDocument = rootDocument(processFile, 32768);
  const processReceipt = processDocument.value, invocationFile = path.join(loaded.place.attempt, `guard-build-${result.value.intentSha256}.invocation.json`);
  assert.equal(processReceipt.schema, 'sd2-release-child-process.v1'); assert.equal(processReceipt.invocationFile, invocationFile);
  const invocationDocument = rootDocument(invocationFile, 256 * 1024), invocation = validateInvocation(invocationDocument.value, invocationFile);
  assert.equal(processReceipt.invocationSha256, digest(invocationDocument.bytes)); assert.equal(invocation.processFile, processFile);
  assert.equal(invocation.batchFile, loaded.header.manifest.file); assert.equal(invocation.phase, 'guard-build');
  assert.equal(invocation.taskRoot, `${batch.projectRoot}/release-tasks`); assert.equal(invocation.taskId, batch.taskId); assert.equal(invocation.attemptId, batch.attemptId);
  assert.deepEqual(invocation.owner, terminal.value.owner); assert.equal(processReceipt.owner.token, invocation.owner.token);
  assert.equal(inspectOwner(processReceipt.owner), 'dead', 'Original guard child must be dead');
  for (const name of ['main', 'guard']) assert.equal(result.value.after.facts.files[`${name}-prepared.json`]?.sha256, request[`${name}PreparedSha256`]);
  return { terminal, result, processReceiptSha256: digest(processDocument.bytes), invocationSha256: digest(invocationDocument.bytes) };
}

function guardBuildTailSnapshot(batch, request, { initial = false } = {}) {
  const m = assertManifest(batch), stage = path.dirname(batch.manifestFile);
  assert.ok(m.fullRelease && !m.reuseBuilds); assert.equal(batch.artifacts.guard.schema, 'sd2-release-artifact-input.v1');
  verifyBuildInputIdentity(batch);
  if (initial) {
    const scene = captureReleaseScene(batch); assert.equal(scene.facts.effectsStarted, false); assert.equal(scene.facts.switchComplete, false);
    for (const name of ['guard-build.json', 'guard-immutable-success.json', 'guard-build-failed.json', 'main-build.json', 'main-build-command.json',
      'main-build.log', 'main-immutable-success.json', 'fixed-guard-recovery.json', 'switch-before.json', 'switch-complete.json'])
      assert.equal(fs.lstatSync(path.join(stage, name), { throwIfNoEntry: false }), undefined, 'Guard-tail cannot replace existing build/publication evidence: ' + name);
    assert.equal(fs.lstatSync(path.join(m.main.root, m.main.buildDist), { throwIfNoEntry: false }), undefined, 'Main compilation already started');
    assert.equal(fs.lstatSync(path.join(m.main.root, '.role-tests', `pricing-prepared-${batch.runId}`, '.pricing-gate-claim'),
      { throwIfNoEntry: false }), undefined, 'Main gate inputs were already consumed');
  }
  const inputs = {}, read = (name, file, expected, category = 'root_control', expectedUid) => {
    const value = readTypedFile({ file: safeAbsolute(file, name), category, expectedUid, maximumBytes: 64 * 1024 * 1024 });
    assert.equal(digest(value.bytes), expected, 'Retained guard-tail input changed: ' + name);
    inputs[name] = { file, sha256: expected, snapshot: value.snapshot }; return value.bytes;
  };
  const mainPrepared = JSON.parse(read('mainPrepared', stage + '/main-prepared.json', request.mainPreparedSha256));
  const guardPrepared = JSON.parse(read('guardPrepared', stage + '/guard-prepared.json', request.guardPreparedSha256));
  for (const [kind, value] of [['main', mainPrepared], ['guard', guardPrepared]]) {
    assert.equal(value.runId, batch.runId); assert.equal(value.label, kind); assert.equal(value.candidateRoot, m[kind].root);
    assert.equal(value.sourceManifestSha256, batch.artifacts[kind].sourceManifestSha256);
    assert.equal(value.manifestSha256, digest(rootDocument(batch.manifestFile, 32 * 1024 * 1024).bytes));
  }
  const inputFile = path.join(m.guard.root, '.role-tests', `pricing-prepared-${batch.runId}`, 'candidate-inputs.json');
  const originalInput = rootJson(inputFile, 65536), uid = originalInput.uid;
  assert.equal(originalInput.candidateRoot, m.guard.root); assert.equal(originalInput.source, batch.artifacts.guard.source);
  assert.equal(originalInput.runId, batch.runId); assert.ok(Number.isSafeInteger(uid) && uid > 0);
  const commandFile = stage + '/guard-build-command.json', command = JSON.parse(read('buildCommand', commandFile, request.buildCommandSha256));
  assert.equal(command.schema, 'sd2-original-build-command.v1'); assert.equal(command.label, 'guard'); assert.equal(command.runId, batch.runId);
  assert.equal(command.source, batch.artifacts.guard.source); assert.equal(command.manifestSha256, guardPrepared.manifestSha256);
  assert.equal(command.status, 0); assert.equal(command.signal, null); assert.equal(command.error, null); assert.equal(command.errorCode, null);
  assert.equal(command.originalExitRecordedBeforePostchecks, true);
  assert.ok(Number.isSafeInteger(command.startedAt) && command.startedAt > 0 && Number.isSafeInteger(command.finishedAt)
    && command.finishedAt >= command.startedAt && command.finishedAt <= parseTime(request.observedAt, 'build observation'));
  assert.equal(command.buildEnvironmentSha256, digest(JSON.stringify(guardPrepared.buildEnv)));
  const logFile = stage + '/guard-build.log'; assert.equal(command.logFile, logFile); assert.equal(command.logSha256, request.buildLogSha256);
  const lines = read('buildLog', logFile, request.buildLogSha256).toString('utf8').split(/\r?\n/);
  const gate = (prefix, name, hash, schema) => {
    const matches = lines.filter(line => line.startsWith(prefix)); assert.equal(matches.length, 1, 'One original npm invocation must emit exactly one ' + name);
    const file = safeAbsolute(matches[0].slice(prefix.length), name);
    assert.ok(file.startsWith(m.guard.root + '/.role-tests/'));
    const value = JSON.parse(read(name, file, hash, 'app', uid));
    assert.equal(value.schema, schema); assert.equal(value.completed, true); assert.equal(value.runId, batch.runId); assert.equal(value.candidateRoot, m.guard.root);
    return file;
  };
  const imageGateReceiptFile = gate('IMAGE_RECOVERY_GATE_RECEIPT=', 'imageGateReceipt', request.imageGateReceiptSha256, 'image-recovery-build-gate.v1');
  const pricingGateReceiptFile = gate('PRICING_POLICY_GATE_RECEIPT=', 'pricingGateReceipt', request.pricingGateReceiptSha256, 'pricing-policy-build-gate.v1');
  const pkg = JSON.parse(read('packageJson', m.guard.root + '/package.json', request.packageJsonSha256, 'app', uid));
  assert.equal(pkg.version, batch.artifacts.guard.version);
  const build = read('buildId', path.join(m.guard.root, m.guard.buildDist, 'BUILD_ID'), request.buildIdSha256, 'app', uid).toString('utf8').trim();
  assert.ok(build.length > 0 && build.length <= 256);
  const tree = {}, visit = relative => {
    const file = path.join(m.guard.root, m.guard.buildDist, relative), stat = fs.lstatSync(file);
    assert.equal(fs.realpathSync(file), file); assert.ok(!stat.isSymbolicLink());
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(relative, name));
    else tree[relative] = readTypedFile({ file, category: 'app', expectedUid: uid, maximumBytes: 512 * 1024 * 1024 }).snapshot.sha256;
  };
  visit('server'); visit('static');
  for (const name of fs.readdirSync(path.join(m.guard.root, m.guard.buildDist)).filter(name => name === 'BUILD_ID' || name.endsWith('.json')).sort()) visit(name);
  assert.equal(digest(JSON.stringify(Object.fromEntries(Object.entries(tree).sort(([a], [b]) => a.localeCompare(b))))), request.observedCompiledTreeSha256);
  return { inputs, originalBuild: { startedAt: command.startedAt, finishedAt: command.finishedAt, build,
    buildCommandFile: commandFile, buildLogFile: logFile, imageGateReceiptFile, pricingGateReceiptFile },
    originalCompiledSnapshotUnavailable: true };
}

function guardBuildTailProofFile(loaded, hash) { assert.match(hash, HASH); return path.join(loaded.place.attempt, `guard-build-tail-${hash}.json`); }

export function validateGuardBuildTailRetry(value) {
  exactKeys(value, ['schema', 'originalContinuationSha256', 'terminalEventSha256', 'phaseResultEventSha256', 'childReceiptSha256',
    'processorControllerSetSha256', 'hdCompiledCacheSha256', 'observedAt'], 'single guard-tail postcheck retry');
  assert.equal(value.schema, GUARD_TAIL_RETRY_SCHEMA);
  for (const [key, hash] of Object.entries(value)) if (!['schema', 'observedAt'].includes(key)) assert.match(hash, HASH);
  assert.equal(typeof value.observedAt, 'string'); parseTime(value.observedAt, 'retry observation'); return value;
}

export function assertGuardBuildTailRetryFailure(receipt) {
  assert.equal(receipt.schema, 'sd2-release-phase-child.v1'); assert.equal(receipt.phase, 'guard-build');
  assert.equal(receipt.child.status, 1); assert.equal(receipt.child.signal, null); assert.equal(receipt.child.error, null);
  assert.equal(typeof receipt.stderr, 'string');
  const failure = JSON.parse(receipt.stderr); exactKeys(failure, ['error', 'cause'], 'proven guard-tail postcheck failure');
  assert.deepEqual(failure.error, { schema: 'sd2-release-error.v1', category: 'internal_failure', code: 'unclassified_internal_failure',
    object: { kind: 'release_operation', id: 'child' },
    reason: 'An unclassified release-engine failure occurred; the original exception remains in the private attempt evidence.',
    nextStep: 'Stop dependent or side-effecting work and inspect the preserved attempt evidence.', retryable: false, stop: true });
  assert.equal(typeof failure.cause, 'string');
  const lines = failure.cause.split('\n');
  assert.equal(lines[0], 'AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:');
  assert.equal(lines[1], '+ actual - expected ... Lines skipped'); assert.equal(lines[2], '');
  assert.equal(lines[3], '  ['); assert.equal(lines.at(-1), '  ]');
  assert.deepEqual(lines.slice(2).filter(line => /^[ \t]*[+-]/.test(line)), ["+   'src/lib/hooks/useWorkspace.ts',"],
    'Only the proven single upload-source addition may be retried');
}

export function assertGuardBuildTailRetryControllerDifference(original, processor) {
  assert.deepEqual(Object.keys(original).sort(), Object.keys(processor).sort()); const changed = {};
  const allowed = GUARD_TAIL_CONTROLLERS.filter(name => !name.startsWith('hd-'));
  for (const name of Object.keys(original).sort()) {
    assert.match(original[name], HASH); assert.match(processor[name], HASH);
    if (original[name] !== processor[name]) {
      assert.ok(allowed.includes(name), 'A postcheck retry cannot replace the successful HD probe implementation: ' + name);
      changed[name] = { originalSha256: original[name], processorSha256: processor[name] };
    }
  }
  for (const name of ['release-entry.mjs', 'attempt-state.mjs', 'candidate.mjs', 'candidate-evidence.mjs']) assert.ok(changed[name]);
  return changed;
}

const probeIdentity = stat => Object.fromEntries(['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].map(key => [key, stat[key]]));
function guardBuildTailRetrySnapshot(batch, request) {
  const m = assertManifest(batch), stage = path.dirname(batch.manifestFile), hdInputs = {};
  const receiptFile = stage + '/guard-hd-compiled-cache.json';
  const receiptRead = readTypedFile({ file: receiptFile, category: 'root_control' });
  assert.equal(receiptRead.snapshot.sha256, request.hdCompiledCacheSha256);
  const receipt = JSON.parse(receiptRead.bytes), prepared = rootJson(stage + '/guard-prepared.json');
  const input = rootJson(prepared.receipt), uid = input.uid;
  assert.ok(Number.isSafeInteger(uid) && uid > 0); assert.equal(input.candidateRoot, m.guard.root); assert.equal(input.runId, m.runId);
  assert.equal(receipt.schema, 'sd2-hd-compiled-cache.v2'); assert.equal(receipt.runId, m.runId); assert.equal(receipt.kind, 'guard');
  assert.equal(receipt.noBusinessWorkDispatched, true); assert.equal(receipt.descriptor.sourceRoot, m.guard.root);
  assert.equal(receipt.descriptor.source, m.guard.source); assert.equal(receipt.sourceManifestSha256, batch.artifacts.guard.sourceManifestSha256);
  const commandFile = stage + '/guard-hd-compile-command.json', commandRead = readTypedFile({ file: commandFile, category: 'root_control' });
  assert.equal(commandRead.snapshot.sha256, receipt.commandReceiptSha256); assert.deepEqual(JSON.parse(commandRead.bytes), receipt.command);
  assert.equal(receipt.command.status, 1); assert.equal(receipt.command.expectedUnusedChildExit, 1);
  assert.equal(receipt.command.signal, null); assert.equal(receipt.command.error, null); assert.equal(receipt.command.errorCode, null);
  assert.equal(receipt.command.ipcChannel, false); assert.equal(receipt.command.workMessagesSent, 0);
  assert.ok(receipt.command.finishedAt - receipt.command.startedAt >= 10000);
  const logFile = stage + '/guard-hd-compile.log'; assert.equal(receipt.command.logFile, logFile);
  assert.equal(fs.realpathSync(logFile), logFile); const logBefore = fs.lstatSync(logFile);
  assert.ok(logBefore.isFile() && !logBefore.isSymbolicLink() && logBefore.uid === 0 && logBefore.nlink === 1 && !(logBefore.mode & 0o022));
  assert.equal(logBefore.size, 0);
  const fd = fs.openSync(logFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    assert.deepEqual(probeIdentity(fs.fstatSync(fd)), probeIdentity(logBefore));
    const bytes = fs.readFileSync(fd); assert.equal(bytes.length, 0); assert.equal(digest(bytes), receipt.command.logSha256);
    assert.deepEqual(probeIdentity(fs.fstatSync(fd)), probeIdentity(logBefore));
    assert.deepEqual(probeIdentity(fs.lstatSync(logFile)), probeIdentity(logBefore));
  } finally { fs.closeSync(fd); }
  hdInputs.receipt = { file: receiptFile, sha256: receiptRead.snapshot.sha256, snapshot: receiptRead.snapshot };
  hdInputs.command = { file: commandFile, sha256: commandRead.snapshot.sha256, snapshot: commandRead.snapshot };
  hdInputs.log = { file: logFile, sha256: receipt.command.logSha256,
    snapshot: { schema: 'sd2-empty-hd-probe-log.v1', identity: probeIdentity(logBefore) } };
  const directory = safeAbsolute(receipt.probeDirectory, 'successful probe directory');
  assert.equal(path.dirname(directory), prepared.preparedRoot);
  assert.match(path.basename(directory), /^hd-compile-probe-tail-[a-f0-9]+$/);
  const directories = {}, files = {}, device = fs.statSync('/data').dev;
  assert.notEqual(device, fs.statSync('/').dev);
  const walk = relative => {
    const file = path.join(directory, relative), before = fs.lstatSync(file);
    assert.equal(fs.realpathSync(file), file); assert.ok(before.isDirectory() && !before.isSymbolicLink() && before.uid === uid
      && before.dev === device && !(before.mode & 0o022));
    directories[relative] = probeIdentity(before); const names = fs.readdirSync(file).sort();
    for (const name of names) {
      const child = path.join(file, name), key = path.join(relative, name), stat = fs.lstatSync(child);
      assert.ok(!stat.isSymbolicLink());
      if (stat.isDirectory()) walk(key);
      else files[key] = readTypedFile({ file: child, category: 'app', expectedUid: uid, maximumBytes: 8 * 1024 * 1024 }).snapshot;
    }
    assert.deepEqual(fs.readdirSync(file).sort(), names); assert.deepEqual(probeIdentity(fs.lstatSync(file)), directories[relative]);
  };
  walk(''); assert.equal(directories[''].mode & 0o777, 0o700);
  const expected = receipt.descriptor.entries.map(entry => {
    assert.ok(entry.cacheFile.startsWith(directory + path.sep)); const key = path.relative(directory, entry.cacheFile);
    assert.equal(files[key]?.sha256, entry.cacheSha256); assert.equal(files[key]?.identity.size, entry.cacheBytes); return key;
  }).sort();
  assert.deepEqual(Object.keys(files).sort(), expected);
  const probeSnapshot = { directory, directories, files };
  return { hdCompiledCache: { file: receiptFile, sha256: receiptRead.snapshot.sha256, schema: receipt.schema }, hdInputs,
    probeSnapshot: { ...probeSnapshot, sha256: digest(JSON.stringify(probeSnapshot)) } };
}

function guardBuildTailRetryProofFile(loaded, hash) { assert.match(hash, HASH); return path.join(loaded.place.attempt, `guard-build-tail-retry-${hash}.json`); }

export function assertGuardBuildTailPhase(phase, state) {
  assert.ok(GUARD_BUILD_TAIL_PHASES.includes(phase), 'Phase is outside the guard-tail processor reader contract');
  if (phase === 'guard-build') assert.equal(state.status, 'pending', 'Guard compilation/tail cannot be replayed');
  else assert.equal(state.status, 'completed', 'The guard tail must complete before later phases');
}

function readGuardBuildTailProof(batch, batchFile, loaded, phase,
  { retryAdmission = false, readerAdmission = false, armPairAdmission = false } = {}) {
  const binding = loaded.derivedState.guardBuildTail; assert.ok(binding);
  const retryBinding = loaded.derivedState.guardBuildTailRetry;
  const readerEvents = loaded.events.filter(item => item.value.kind === 'observation' && item.value.name === 'reader_successor');
  const repairEvents = loaded.events.filter(item => item.value.kind === 'observation' && item.value.name === 'arm_pair_repair');
  assert.ok(repairEvents.length <= 1, 'The arm-pair failure has only one authorized repair');
  if (armPairAdmission) assert.equal(repairEvents.length, 0);
  assert.ok(readerEvents.length <= 1, 'A reader successor cannot recursively authorize another successor');
  if (readerAdmission) assert.equal(readerEvents.length, 0);
  if (readerEvents.length) assertReaderSuccessorPhase(phase);
  if (retryAdmission) { assert.equal(binding.status, 'failed'); assert.equal(retryBinding, undefined); }
  else assertGuardBuildTailPhase(phase, retryBinding || binding);
  const event = loaded.events.find(item => item.sha256 === binding.continuationEventSha256);
  assert.equal(event?.value.kind, 'failure_continued'); assert.equal(event.value.failureReceiptSha256, binding.proofSha256);
  const file = guardBuildTailProofFile(loaded, binding.proofSha256), doc = rootDocument(file, 1024 * 1024), proof = doc.value;
  assert.equal(digest(doc.bytes), binding.proofSha256); assert.equal(proof.schema, GUARD_TAIL_PROOF);
  validateGuardBuildTailContinuation(proof.request);
  for (const name of ['taskId', 'attemptId', 'runId']) assert.equal(proof[name], batch[name]);
  assert.equal(proof.batchFile, batchFile); assert.equal(proof.batchSha256, digest(rootDocument(batchFile).bytes));
  assert.equal(proof.contextSha256, digest(rootDocument(batch.contextFile, 256 * 1024).bytes));
  assert.equal(proof.seedSha256, digest(rootDocument(batch.seedFile).bytes));
  assert.equal(proof.manifestSha256, digest(rootDocument(batch.manifestFile, 32 * 1024 * 1024).bytes));
  assert.equal(proof.artifactsSha256, digest(JSON.stringify(batch.artifacts))); assert.deepEqual(proof.engine, batch.engine);
  const identity = guardBuildTailProcessor(batch, binding.processorControllerSetSha256,
    { directory: proof.processor.root, requireHere: !retryBinding && !retryAdmission });
  for (const name of ['processor', 'processorControllers', 'changedControllers']) assert.deepEqual(proof[name], identity[name]);
  assert.equal(proof.request.processorControllerSetSha256, binding.processorControllerSetSha256);
  const failure = guardBuildTailFailure(batch, loaded, proof.request, inspectControllerOwner);
  assert.equal(event.value.previousTerminalSha256, failure.terminal.sha256); assert.equal(event.value.previousSha256, failure.terminal.sha256);
  assert.equal(proof.processReceiptSha256, failure.processReceiptSha256); assert.equal(proof.invocationSha256, failure.invocationSha256);
  const retained = guardBuildTailSnapshot(batch, proof.request);
  assert.deepEqual(proof.originalBuild, retained.originalBuild); assert.equal(proof.originalCompiledSnapshotUnavailable, true);
  // Retained evidence is read afresh; observedAt describes first tail observation,
  // never an unavailable successful-build-time compiled snapshot.
  for (const name of Object.keys(retained.inputs)) {
    assert.equal(proof.inputs[name].file, retained.inputs[name].file); assert.equal(proof.inputs[name].sha256, retained.inputs[name].sha256);
    for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'])
      assert.equal(proof.inputs[name].snapshot.identity[key], retained.inputs[name].snapshot.identity[key]);
  }
  assertAttemptBindings(loaded, kernelBindings(batchFile, batch));
  const runtime = { schema: 'sd2-release-guard-build-tail-runtime.v1', phase, proofFile: file, continuationSha256: binding.proofSha256, proof };
  if (retryBinding) runtime.retry = readGuardBuildTailRetryProof(batch, batchFile, loaded, runtime,
    { predecessorRead: readerAdmission || readerEvents.length === 1 });
  if (readerEvents.length) {
    runtime.reader = readReaderSuccessorProof(batch, batchFile, loaded, runtime, readerEvents[0],
      { predecessorRead: armPairAdmission || repairEvents.length === 1 });
    runtime.candidateObservation = readCandidateObservationProof(batch, loaded, runtime, readerEvents[0]);
  }
  if (repairEvents.length) runtime.armPairRepair = readArmPairRepairProof(batch, batchFile, loaded, runtime, repairEvents[0]);
  return runtime;
}

function readGuardBuildTailRetryProof(batch, batchFile, loaded, original, { predecessorRead = false } = {}) {
  const binding = loaded.derivedState.guardBuildTailRetry, file = guardBuildTailRetryProofFile(loaded, binding.proofSha256);
  const doc = rootDocument(file, 1024 * 1024), proof = doc.value; assert.equal(digest(doc.bytes), binding.proofSha256);
  assert.equal(proof.schema, GUARD_TAIL_RETRY_PROOF); validateGuardBuildTailRetry(proof.request);
  assert.equal(proof.originalContinuationSha256, original.continuationSha256); assert.equal(proof.originalProofFile, original.proofFile);
  assert.equal(proof.originalObservedAt, original.proof.observedAt);
  for (const key of ['taskId', 'attemptId', 'runId', 'batchFile', 'batchSha256', 'contextSha256', 'seedSha256', 'manifestSha256', 'artifactsSha256'])
    assert.equal(proof[key], original.proof[key]);
  assert.deepEqual(proof.engine, batch.engine);
  const identity = guardBuildTailProcessor(batch, binding.processorControllerSetSha256,
    { directory: proof.processor.root, requireHere: !predecessorRead });
  for (const key of ['processor', 'processorControllers', 'changedControllers']) assert.deepEqual(proof[key], identity[key]);
  assert.deepEqual(proof.retryControllerChanges, assertGuardBuildTailRetryControllerDifference(original.proof.processorControllers, identity.processorControllers));
  assert.equal(proof.request.originalContinuationSha256, original.continuationSha256);
  assert.equal(proof.request.processorControllerSetSha256, binding.processorControllerSetSha256);
  const request = { ...original.proof.request, terminalEventSha256: proof.request.terminalEventSha256,
    phaseResultEventSha256: proof.request.phaseResultEventSha256, childReceiptSha256: proof.request.childReceiptSha256 };
  const failure = guardBuildTailFailure(batch, loaded, request, inspectControllerOwner);
  const child = readChildReceipt(childReceiptFile(loaded, 'guard-build', failure.result.value.intentSha256), 'guard-build', failure.result.value.intentSha256);
  assertGuardBuildTailRetryFailure(child.receipt);
  assert.equal(binding.originalFailureResultSha256, failure.result.sha256);
  const event = loaded.events.find(item => item.sha256 === binding.continuationEventSha256);
  assert.equal(event?.value.kind, 'failure_continued'); assert.equal(event.value.previousTerminalSha256, failure.terminal.sha256);
  assert.equal(event.value.failureReceiptSha256, binding.proofSha256);
  assert.equal(proof.processReceiptSha256, failure.processReceiptSha256); assert.equal(proof.invocationSha256, failure.invocationSha256);
  const snapshot = guardBuildTailRetrySnapshot(batch, proof.request);
  for (const key of ['hdCompiledCache', 'hdInputs', 'probeSnapshot']) assert.deepEqual(proof[key], snapshot[key]);
  return { schema: 'sd2-release-guard-build-tail-retry-runtime.v1', proofFile: file, proofSha256: binding.proofSha256, proof };
}

export function validateReaderSuccessor(value) {
  exactKeys(value, ['schema', 'predecessorControllerSetSha256', 'originalContinuationSha256', 'retryProofSha256',
    'eventHeadSha256', 'processorControllerSetSha256', 'observedAt'], 'successful-build reader successor');
  assert.equal(value.schema, READER_SUCCESSOR_SCHEMA);
  for (const key of ['predecessorControllerSetSha256', 'originalContinuationSha256', 'retryProofSha256', 'eventHeadSha256',
    'processorControllerSetSha256']) assert.match(value[key], HASH);
  assert.notEqual(value.predecessorControllerSetSha256, value.processorControllerSetSha256);
  assert.equal(typeof value.observedAt, 'string'); parseTime(value.observedAt, 'reader observation'); return value;
}

export function assertReaderSuccessorControllerDifference(predecessor, processor) {
  assert.deepEqual(Object.keys(predecessor).sort(), Object.keys(processor).sort()); const changed = {};
  for (const name of Object.keys(predecessor).sort()) {
    assert.equal(path.basename(name), name); assert.ok(name.endsWith('.mjs'));
    assert.match(predecessor[name], HASH); assert.match(processor[name], HASH);
    if (predecessor[name] !== processor[name]) {
      assert.ok(READER_SUCCESSOR_CONTROLLERS.includes(name), 'Unreviewed successful-build reader difference: ' + name);
      changed[name] = { predecessorSha256: predecessor[name], processorSha256: processor[name] };
    }
  }
  for (const name of ['release-entry.mjs', 'candidate-evidence.mjs', 'release.mjs']) assert.ok(changed[name]);
  return changed;
}

export function assertReaderSuccessorPhase(phase) {
  assert.ok(READER_SUCCESSOR_PHASES.includes(phase), 'A reader successor has no preparation or compilation authority');
}

export function assertReaderSuccessorAdmission(loaded, request, scene) {
  validateReaderSuccessor(request); const state = loaded.derivedState;
  assert.equal(state.status, 'running'); assert.equal(state.activePhase, null);
  assert.equal(state.lastEventSha256, request.eventHeadSha256);
  const next = nextReleasePhase(loaded); assert.ok(['verify', 'arm'].includes(next));
  const completedBoundary = next === 'arm' ? 'verify' : 'main-build';
  assert.equal(state.lastPhase?.phase, completedBoundary); assert.equal(state.lastPhase.outcome, 'succeeded');
  assert.equal(state.guardBuildTail?.proofSha256, request.originalContinuationSha256);
  assert.equal(state.guardBuildTailRetry?.proofSha256, request.retryProofSha256); assert.equal(state.guardBuildTailRetry.status, 'completed');
  assert.equal(state.guardBuildTailRetry.processorControllerSetSha256, request.predecessorControllerSetSha256);
  assert.equal(scene.facts.effectsStarted, false); assert.equal(scene.facts.switchComplete, false);
  for (const name of ['fixed-guard-recovery.json', 'switch-before.json', 'switch-complete.json', 'ingress-503-switch.json',
    'pricing-pair-published.json', 'guard-recovery-complete.json']) assert.equal(Boolean(scene.facts.files?.[name]), false);
  assert.equal(switchBoundaryFacts(loaded).effectsStarted, false);
  assert.equal(loaded.events.some(item => item.value.kind === 'observation'
    && ['reader_successor', 'candidate_observation'].includes(item.value.name)), false);
  assert.equal(loaded.events.some(item => item.value.kind === 'phase_intent'
    && RELEASE_PHASES.indexOf(item.value.phase) > RELEASE_PHASES.indexOf(completedBoundary)), false);
  for (const phase of ['guard-build', 'main-build', ...(next === 'arm' ? ['verify'] : [])]) {
    const successes = loaded.events.filter(item => item.value.kind === 'phase_result' && item.value.phase === phase && item.value.outcome === 'succeeded');
    assert.equal(successes.length, 1); assert.deepEqual(successes[0].value.child, { status: 0, signal: null, error: null });
  }
  assert.equal(loaded.events.filter(item => item.value.kind === 'observation' && item.value.name === 'artifact_capsule').length, 1);
}

function readerSuccessorProcessor(batch, predecessor, hash, { directory = here, requireHere = true } = {}) {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  const processor = { ...batch.engine, controllerSetSha256: hash, root: `${batch.projectRoot}/release-engines/${ENGINE_VERSION}-${hash}` };
  validateEngine(processor, batch.projectRoot); assert.equal(processor.root, directory);
  if (requireHere) assert.equal(directory, here);
  assert.notEqual(processor.root, predecessor.processor.root);
  const processorControllers = stableControllerHashes(directory);
  assert.equal(digest(JSON.stringify(processorControllers)), hash);
  return { processor, processorControllers,
    changedControllers: assertReaderSuccessorControllerDifference(predecessor.processorControllers, processorControllers) };
}

function readerSuccessorProofFile(loaded, hash) {
  assert.match(hash, HASH); return path.join(loaded.place.attempt, `reader-successor-${hash}.json`);
}

function readerSuccessorBuildSnapshot(batch, kind, runtime) {
  const m = assertManifest(batch), c = m[kind], stage = path.dirname(batch.manifestFile), inputs = {};
  const read = (name, file, category = 'root_control', expectedUid) => {
    const result = readTypedFile({ file: safeAbsolute(file, name), category, expectedUid, maximumBytes: 128 * 1024 * 1024 });
    inputs[name] = { file, sha256: result.snapshot.sha256, snapshot: result.snapshot }; return result.bytes;
  };
  const receiptFile = stage + '/' + kind + '-build.json', receipt = JSON.parse(read('build', receiptFile));
  const capsule = JSON.parse(read('capsule', stage + '/' + kind + '-immutable-success.json'));
  const prepared = JSON.parse(read('prepared', stage + '/' + kind + '-prepared.json'));
  const input = JSON.parse(read('candidateInputs', prepared.receipt)); const uid = input.uid;
  assert.ok(Number.isSafeInteger(uid) && uid > 0); assert.equal(input.runId, batch.runId);
  assert.equal(input.source, c.source); assert.equal(input.candidateRoot, c.root);
  assert.equal(prepared.candidateRoot, c.root); assert.equal(prepared.source, c.source); assert.equal(prepared.runId, batch.runId);
  assert.equal(receipt.schema, kind === 'guard' ? 'sd2-candidate-build-tail.v1' : 'rate-impl2-candidate-build.v1');
  assert.equal(capsule.schema, kind === 'guard' ? 'sd2-immutable-successful-build-tail.v1' : 'sd2-immutable-successful-build.v1');
  assert.equal(capsule.kind, kind); assert.equal(capsule.sourceRun, batch.runId);
  assert.equal(capsule.originalReceiptFile, receiptFile); assert.equal(capsule.originalReceiptSha256, inputs.build.sha256);
  assert.deepEqual(capsule.originalReceipt, receipt); assert.equal(capsule.originalPreparedSha256, inputs.prepared.sha256);
  assert.equal(capsule.originalManifestSha256, digest(rootDocument(batch.manifestFile, 32 * 1024 * 1024).bytes));
  assert.deepEqual(capsule.originalPrivateSha256, m.privateSha256);
  assert.equal(capsule.originalTimesChanged, false); assert.equal(capsule.newCompilationClaimed, false);
  assert.equal(capsule.originallyVerifiedWithinThirtyMinuteGate, kind !== 'guard');
  for (const key of ['source', 'version', 'runId']) assert.equal(receipt[key], key === 'runId' ? batch.runId : batch.artifacts[kind][key]);
  assert.equal(receipt.label, kind); assert.equal(receipt.exitCode, 0); assert.equal(receipt.verifiedSourceAndGates, true);
  assert.deepEqual(receipt.engine, batch.engine); assert.deepEqual(receipt.operation, operation(batch));
  assert.equal(receipt.preparedSha256, inputs.prepared.sha256);
  assert.equal(receipt.sourceManifestSha256, batch.artifacts[kind].sourceManifestSha256);
  assert.equal(digest(read('sourceManifest', c.sourceManifest)), receipt.sourceManifestSha256);
  assert.equal(capsule.originalSourceManifestSha256, receipt.sourceManifestSha256);
  const command = JSON.parse(read('command', stage + '/' + kind + '-build-command.json'));
  assert.equal(command.schema, 'sd2-original-build-command.v1'); assert.equal(command.label, kind); assert.equal(command.runId, batch.runId);
  assert.equal(command.source, c.source); assert.equal(command.manifestSha256, receipt.manifestSha256);
  assert.equal(command.status, 0); assert.equal(command.signal, null); assert.equal(command.error, null); assert.equal(command.errorCode, null);
  assert.equal(command.originalExitRecordedBeforePostchecks, true);
  assert.equal(command.startedAt, receipt.startedAt); assert.equal(command.finishedAt, receipt.finishedAt);
  assert.equal(command.buildEnvironmentSha256, digest(JSON.stringify(prepared.buildEnv)));
  const logFile = stage + '/' + kind + '-build.log'; assert.equal(receipt.logFile, logFile); assert.equal(command.logFile, logFile);
  const lines = read('log', logFile).toString('utf8').split(/\r?\n/);
  assert.equal(inputs.log.sha256, command.logSha256); assert.equal(inputs.log.sha256, receipt.logSha256);
  for (const [name, prefix] of [['imageGate', 'IMAGE_RECOVERY_GATE_RECEIPT='], ['pricingGate', 'PRICING_POLICY_GATE_RECEIPT=']]) {
    const matches = lines.filter(line => line.startsWith(prefix)); assert.equal(matches.length, 1);
    const file = safeAbsolute(matches[0].slice(prefix.length), name); assert.ok(file.startsWith(c.root + '/.role-tests/'));
    const gate = JSON.parse(read(name, file, 'app', uid)); assert.equal(gate.completed, true); assert.equal(gate.runId, batch.runId);
    assert.equal(gate.candidateRoot, c.root); if (name === 'imageGate') assert.equal(file, receipt.gateReceipt);
  }
  const pkg = JSON.parse(read('package', c.root + '/package.json', 'app', uid)); assert.equal(pkg.version, receipt.version);
  assert.equal(read('buildId', path.join(c.root, c.buildDist, 'BUILD_ID'), 'app', uid).toString('utf8').trim(), receipt.build);
  if (kind === 'guard') {
    assert.deepEqual(capsule.tailPostchecks, receipt.tailPostchecks);
    assert.equal(receipt.tailPostchecks.continuationSha256, runtime.continuationSha256);
    assert.equal(receipt.tailPostchecks.retryProofSha256, runtime.retry.proofSha256);
    assert.equal(receipt.tailPostchecks.retryProofFile, runtime.retry.proofFile);
    assert.equal(inputs.command.sha256, runtime.proof.request.buildCommandSha256);
  }
  return { inputs, build: receipt.build, source: receipt.source, version: receipt.version, startedAt: receipt.startedAt,
    finishedAt: receipt.finishedAt, compiledTreeSha256: receipt.compiledTreeSha256, originalTimesChanged: false };
}

function readerSuccessorChildSnapshot(batch, loaded, kind, inspectOwner) {
  const phase = kind + '-build', result = loaded.events.find(item => item.value.kind === 'phase_result'
    && item.value.phase === phase && item.value.outcome === 'succeeded'); assert.ok(result);
  const intent = result.value.intentSha256, file = childReceiptFile(loaded, phase, intent);
  const child = readChildReceipt(file, phase, intent); assert.deepEqual(child.child, { status: 0, signal: null, error: null });
  assert.deepEqual(child.child, result.value.child);
  assert.deepEqual(parseChildOutput(child.receipt), rootJson(path.dirname(batch.manifestFile) + '/' + kind + '-build.json', 32 * 1024 * 1024));
  const exited = loaded.events.find(item => item.value.kind === 'observation' && item.value.name === 'phase_child_exit'
    && item.value.value.intentSha256 === intent); assert.ok(exited);
  assert.equal(exited.value.value.phase, phase); assert.equal(result.value.previousSha256, exited.sha256);
  assert.equal(exited.value.value.receiptFile, file); assert.equal(exited.value.value.receiptSha256, child.saved.sha256);
  assert.deepEqual(exited.value.value.child, child.child);
  const processFile = childProcessFile(loaded, phase, intent), processDocument = rootDocument(processFile, 32768);
  const invocationFile = path.join(loaded.place.attempt, `${phase}-${intent}.invocation.json`), invocationDocument = rootDocument(invocationFile, 256 * 1024);
  const invocation = validateInvocation(invocationDocument.value, invocationFile);
  assert.equal(processDocument.value.schema, 'sd2-release-child-process.v1'); assert.equal(processDocument.value.invocationFile, invocationFile);
  assert.equal(processDocument.value.invocationSha256, invocationDocument.snapshot.sha256);
  assert.equal(invocation.batchFile, loaded.header.manifest.file); assert.equal(invocation.phase, phase);
  assert.equal(invocation.taskRoot, `${batch.projectRoot}/release-tasks`);
  assert.equal(invocation.taskId, batch.taskId); assert.equal(invocation.attemptId, batch.attemptId);
  assert.equal(invocation.processFile, processFile); assert.deepEqual(invocation.owner, result.value.owner);
  assert.equal(processDocument.value.owner.token, invocation.owner.token);
  assert.equal(inspectOwner(processDocument.value.owner), 'dead', 'A reader cannot take over a live or unknown build child');
  return { resultSha256: result.sha256, child: { file, sha256: child.saved.sha256, snapshot: rootDocument(file, 64 * 1024 * 1024).snapshot },
    process: { file: processFile, sha256: processDocument.snapshot.sha256, snapshot: processDocument.snapshot },
    invocation: { file: invocationFile, sha256: invocationDocument.snapshot.sha256, snapshot: invocationDocument.snapshot } };
}

function readReaderSuccessorProof(batch, batchFile, loaded, runtime, event, { predecessorRead = false } = {}) {
  const reference = event.value.value; exactKeys(reference, ['schema', 'proofFile', 'proofSha256'], 'reader authorization reference');
  assert.equal(reference.schema, 'sd2-release-reader-successor-reference.v1');
  assert.equal(reference.proofFile, readerSuccessorProofFile(loaded, reference.proofSha256));
  const document = rootDocument(reference.proofFile, 4 * 1024 * 1024), proof = document.value;
  assert.equal(document.snapshot.sha256, reference.proofSha256); assert.equal(proof.schema, READER_SUCCESSOR_PROOF);
  validateReaderSuccessor(proof.request); assert.equal(proof.originalContinuationSha256, runtime.continuationSha256);
  assert.equal(proof.retryProofSha256, runtime.retry.proofSha256); assert.equal(proof.originalProofFile, runtime.proofFile);
  assert.equal(proof.retryProofFile, runtime.retry.proofFile);
  for (const key of ['runId', 'taskId', 'attemptId', 'batchFile', 'batchSha256', 'contextSha256', 'seedSha256', 'manifestSha256', 'artifactsSha256'])
    assert.equal(proof[key], runtime.retry.proof[key]);
  assert.deepEqual(proof.engine, batch.engine); assert.deepEqual(proof.predecessorProcessor, runtime.retry.proof.processor);
  assert.equal(proof.buildAuthority, false);
  assert.equal(proof.request.predecessorControllerSetSha256, proof.predecessorProcessor.controllerSetSha256);
  assert.equal(proof.request.originalContinuationSha256, runtime.continuationSha256); assert.equal(proof.request.retryProofSha256, runtime.retry.proofSha256);
  const identity = readerSuccessorProcessor(batch, runtime.retry.proof, proof.request.processorControllerSetSha256,
    { directory: proof.processor.root, requireHere: !predecessorRead });
  for (const key of ['processor', 'processorControllers', 'changedControllers']) assert.deepEqual(proof[key], identity[key]);
  const eventIndex = loaded.events.findIndex(item => item.sha256 === event.sha256), takeover = loaded.events[eventIndex - 1];
  assert.equal(takeover?.value.kind, 'owner_takeover'); assert.equal(takeover.value.previousSha256, proof.request.eventHeadSha256);
  assert.equal(proof.eventHeadSha256, takeover.sha256);
  assert.equal(takeover.value.previousLeaseSha256, proof.previousLeaseSha256); assert.deepEqual(takeover.value.previousOwner, proof.previousOwner);
  assert.equal(event.value.previousSha256, takeover.sha256); assert.deepEqual(event.value.owner, takeover.value.owner);
  for (const kind of ['main', 'guard']) {
    assert.deepEqual(proof.successfulArtifacts[kind], readerSuccessorBuildSnapshot(batch, kind, runtime));
    assert.deepEqual(proof.completedChildren[kind], readerSuccessorChildSnapshot(batch, loaded, kind, inspectControllerOwner));
  }
  return { schema: 'sd2-release-reader-successor-runtime.v1', proofFile: reference.proofFile, proofSha256: reference.proofSha256, proof };
}

function candidateObservationProofFile(loaded, hash) {
  assert.match(hash, HASH); return path.join(loaded.place.attempt, `candidate-observation-${hash}.json`);
}

function readCandidateObservationProof(batch, loaded, runtime, readerEvent) {
  const events = loaded.events.filter(item => item.value.kind === 'observation' && item.value.name === 'candidate_observation');
  assert.equal(events.length, 1, 'The reader requires its separate complete candidate observation');
  const event = events[0], reference = event.value.value;
  exactKeys(reference, ['schema', 'proofFile', 'proofSha256'], 'candidate observation reference');
  assert.equal(reference.schema, 'sd2-release-candidate-observation-reference.v1');
  assert.equal(reference.proofFile, candidateObservationProofFile(loaded, reference.proofSha256));
  const document = rootDocument(reference.proofFile, 1024 * 1024), proof = document.value;
  assert.equal(document.snapshot.sha256, reference.proofSha256); assert.equal(proof.schema, 'sd2-release-candidate-observation-proof.v1');
  assert.equal(event.value.previousSha256, readerEvent.sha256); assert.deepEqual(event.value.owner, readerEvent.value.owner);
  for (const key of ['runId', 'taskId', 'attemptId', 'manifestSha256', 'originalContinuationSha256', 'retryProofSha256', 'eventHeadSha256'])
    assert.equal(proof[key], runtime.reader.proof[key]);
  assert.deepEqual(proof.engine, batch.engine); assert.equal(proof.readerProofSha256, runtime.reader.proofSha256);
  assert.equal(proof.verifier.file, path.join(runtime.reader.proof.predecessorProcessor.root, 'candidate-reuse.mjs'));
  assert.equal(proof.verifier.sha256, runtime.retry.proof.processorControllers['candidate-reuse.mjs']);
  assert.equal(proof.verifier.method, 'verifyOriginalSuccess');
  assert.ok(Number.isSafeInteger(proof.verifier.startedAt) && proof.verifier.startedAt > 0
    && Number.isSafeInteger(proof.verifier.finishedAt) && proof.verifier.finishedAt >= proof.verifier.startedAt);
  assert.equal(proof.observedAt, proof.verifier.finishedAt); assert.equal(proof.expiresAt, proof.observedAt + 1800000);
  assert.equal(proof.protectionComparison, 'assertProtection'); assert.deepEqual(proof.protectionFields, OBSERVATION_PROTECTION_FIELDS);
  assert.match(proof.protectionSha256, HASH);
  for (const name of ['readOnly', 'newCompilationClaimed', 'originalTimesChanged', 'continuousUnchangedIntervalClaimed'])
    assert.equal(proof[name], name === 'readOnly');
  for (const kind of ['main', 'guard']) {
    const artifact = runtime.reader.proof.successfulArtifacts[kind], value = proof.candidates[kind];
    assert.equal(value.capsuleFile, artifact.inputs.capsule.file); assert.equal(value.capsuleSha256, artifact.inputs.capsule.sha256);
    assert.equal(value.receiptFile, artifact.inputs.build.file); assert.equal(value.receiptSha256, artifact.inputs.build.sha256);
    assert.equal(value.snapshotSha256, digest(JSON.stringify(rootJson(value.capsuleFile, 128 * 1024 * 1024).snapshot)));
  }
  return { schema: 'sd2-release-candidate-observation-runtime.v1', proofFile: reference.proofFile, proofSha256: reference.proofSha256, proof };
}

export function validateArmPairRepair(value) {
  exactKeys(value, ['schema', 'terminalEventSha256', 'phaseResultEventSha256', 'childReceiptSha256', 'readerProofSha256',
    'candidateObservationProofSha256', 'processorControllerSetSha256', 'approvalFile', 'approvalSha256', 'windowSha256', 'observedAt'],
  'single failed arm-pair repair');
  assert.equal(value.schema, ARM_PAIR_REPAIR_SCHEMA);
  for (const key of ['terminalEventSha256', 'phaseResultEventSha256', 'childReceiptSha256', 'readerProofSha256',
    'candidateObservationProofSha256', 'processorControllerSetSha256', 'approvalSha256', 'windowSha256']) assert.match(value[key], HASH);
  for (const key of ['terminalEventSha256', 'phaseResultEventSha256', 'readerProofSha256', 'candidateObservationProofSha256'])
    assert.equal(value[key], ARM_PAIR_REPAIR_ORIGIN[key]);
  safeAbsolute(value.approvalFile, 'arm-pair approval'); assert.equal(typeof value.observedAt, 'string');
  parseTime(value.observedAt, 'arm-pair repair observation'); return value;
}

export function assertArmPairRepairFailure(receipt) {
  assert.equal(receipt.schema, 'sd2-release-phase-child.v1'); assert.equal(receipt.phase, 'arm');
  assert.deepEqual(receipt.child, { status: 1, signal: null, error: null });
  assert.equal(typeof receipt.stderr, 'string'); const failure = JSON.parse(receipt.stderr);
  exactKeys(failure, ['error', 'cause'], 'original arm-pair child failure');
  assert.deepEqual(failure.error, { schema: 'sd2-release-error.v1', category: 'internal_failure', code: 'unclassified_internal_failure',
    object: { kind: 'release_operation', id: 'child' },
    reason: 'An unclassified release-engine failure occurred; the original exception remains in the private attempt evidence.',
    nextStep: 'Stop dependent or side-effecting work and inspect the preserved attempt evidence.', retryable: false, stop: true });
  assert.equal(failure.cause, "AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:\n\n  assert.ok(['rate-impl2-candidate-build.v1', 'sd2-candidate-build-reuse.v1'].includes(proof?.schema))\n");
}

export function assertArmPairRepairControllerDifference(predecessor, processor) {
  assert.deepEqual(Object.keys(predecessor).sort(), Object.keys(processor).sort()); const changed = {};
  for (const name of Object.keys(predecessor).sort()) {
    assert.equal(path.basename(name), name); assert.ok(name.endsWith('.mjs'));
    assert.match(predecessor[name], HASH); assert.match(processor[name], HASH);
    if (predecessor[name] !== processor[name]) {
      assert.ok(ARM_PAIR_REPAIR_CONTROLLERS.includes(name), 'Unreviewed arm-pair repair difference: ' + name);
      changed[name] = { predecessorSha256: predecessor[name], processorSha256: processor[name] };
    }
  }
  for (const name of ARM_PAIR_REPAIR_CONTROLLERS.slice(0, 7)) assert.ok(changed[name], 'The reviewed pair/reader repairs must be present: ' + name);
  return changed;
}

export function assertArmPairRepairAdmission(loaded, request, scene) {
  validateArmPairRepair(request); const state = loaded.derivedState;
  assert.equal(state.status, 'failed'); assert.equal(state.activePhase, null); assert.equal(nextReleasePhase(loaded), 'arm');
  assert.equal(state.lastPhase?.phase, 'arm'); assert.equal(state.lastPhase.outcome, 'failed');
  assert.equal(state.lastPhase.resultSha256, request.phaseResultEventSha256);
  assert.equal(state.terminal?.eventSha256, request.terminalEventSha256); assert.equal(state.lastEventSha256, request.terminalEventSha256);
  assert.equal(loaded.events.some(item => item.value.kind === 'observation' && item.value.name === 'arm_pair_repair'), false);
  assert.equal(loaded.events.some(item => item.value.kind === 'phase_intent'
    && RELEASE_PHASES.indexOf(item.value.phase) > RELEASE_PHASES.indexOf('arm')), false);
  assert.equal(scene.facts.effectsStarted, false); assert.equal(scene.facts.switchComplete, false);
  assert.equal(switchBoundaryFacts(loaded).effectsStarted, false);
  for (const name of ['arm-before.json', 'fixed-guard-recovery.json', 'switch-before.json', 'switch-complete.json',
    'ingress-503-switch.json', 'pricing-pair-published.json', 'guard-recovery-complete.json'])
    assert.equal(Boolean(scene.facts.files?.[name]), false);
}

function armPairRepairScene(batch, now, capture = captureReleaseScene) {
  const scene = capture(batch, now), file = path.join(path.dirname(batch.manifestFile), 'arm-before.json');
  assert.equal(fs.lstatSync(file, { throwIfNoEntry: false }), undefined, 'The failed arm must not have created its before-state');
  return scene;
}

function armPairRepairFailureSnapshot(batch, loaded, request, inspectOwner) {
  const index = loaded.events.findIndex(item => item.sha256 === request.terminalEventSha256); assert.ok(index >= 3);
  const terminal = loaded.events[index], result = loaded.events[index - 1], exit = loaded.events[index - 2];
  assert.equal(terminal.value.kind, 'attempt_finished'); assert.equal(terminal.value.outcome, 'failed');
  assert.equal(result.sha256, request.phaseResultEventSha256); assert.equal(result.value.kind, 'phase_result');
  assert.equal(result.value.phase, 'arm'); assert.equal(result.value.outcome, 'failed');
  assert.equal(terminal.value.previousSha256, result.sha256); assert.equal(result.value.previousSha256, exit.sha256);
  assert.equal(exit.value.kind, 'observation'); assert.equal(exit.value.name, 'phase_child_exit'); assert.equal(exit.value.value.phase, 'arm');
  for (const value of [terminal.value.after, result.value.after]) {
    assert.equal(value.facts.effectsStarted, false); assert.equal(value.facts.switchComplete, false);
    for (const name of ['fixed-guard-recovery.json', 'switch-before.json', 'switch-complete.json', 'ingress-503-switch.json',
      'pricing-pair-published.json', 'guard-recovery-complete.json']) assert.equal(Boolean(value.facts.files?.[name]), false);
  }
  const intent = result.value.intentSha256, childFile = childReceiptFile(loaded, 'arm', intent);
  assert.equal(exit.value.value.intentSha256, intent); assert.equal(exit.value.value.receiptFile, childFile);
  assert.equal(exit.value.value.receiptSha256, request.childReceiptSha256);
  const child = readChildReceipt(childFile, 'arm', intent); assert.equal(child.saved.sha256, request.childReceiptSha256);
  assertArmPairRepairFailure(child.receipt); assert.deepEqual(result.value.child, child.child); assert.deepEqual(exit.value.value.child, child.child);
  assert.deepEqual(result.value.owner, terminal.value.owner); assert.deepEqual(exit.value.owner, terminal.value.owner);
  assert.equal(inspectOwner(terminal.value.owner), 'dead', 'Original failed arm owner must be dead');
  const processFile = childProcessFile(loaded, 'arm', intent), processDocument = rootDocument(processFile, 32768);
  const invocationFile = path.join(loaded.place.attempt, `arm-${intent}.invocation.json`), invocationDocument = rootDocument(invocationFile, 256 * 1024);
  const invocation = validateInvocation(invocationDocument.value, invocationFile);
  assert.equal(processDocument.value.schema, 'sd2-release-child-process.v1'); assert.equal(processDocument.value.invocationFile, invocationFile);
  assert.equal(processDocument.value.invocationSha256, invocationDocument.snapshot.sha256);
  assert.equal(invocation.batchFile, loaded.header.manifest.file); assert.equal(invocation.phase, 'arm');
  assert.equal(invocation.taskRoot, `${batch.projectRoot}/release-tasks`); assert.equal(invocation.taskId, batch.taskId);
  assert.equal(invocation.attemptId, batch.attemptId); assert.equal(invocation.processFile, processFile);
  assert.deepEqual(invocation.owner, terminal.value.owner); assert.equal(processDocument.value.owner.token, invocation.owner.token);
  assert.equal(inspectOwner(processDocument.value.owner), 'dead', 'Original failed arm child must be dead');
  const evidence = (file, expected) => {
    const value = readTypedFile({ file, category: 'root_control', maximumBytes: 64 * 1024 * 1024 });
    if (expected) assert.equal(value.snapshot.sha256, expected);
    return { file, sha256: value.snapshot.sha256, snapshot: value.snapshot };
  };
  return { failureIntentSha256: intent, failure: {
    terminal: evidence(path.join(loaded.place.events, String(terminal.value.sequence).padStart(6, '0') + '.json'), terminal.sha256),
    result: evidence(path.join(loaded.place.events, String(result.value.sequence).padStart(6, '0') + '.json'), result.sha256),
    child: evidence(childFile, request.childReceiptSha256), process: evidence(processFile), invocation: evidence(invocationFile),
  } };
}

function armPairRepairProcessor(batch, predecessor, hash) {
  assert.equal(predecessor.processor.controllerSetSha256, ARM_PAIR_REPAIR_ORIGIN.predecessorControllerSetSha256);
  const processor = { ...batch.engine, controllerSetSha256: hash, root: `${batch.projectRoot}/release-engines/${ENGINE_VERSION}-${hash}` };
  validateEngine(processor, batch.projectRoot); assert.equal(processor.root, here); assert.notEqual(processor.root, predecessor.processor.root);
  const processorControllers = stableControllerHashes(here); assert.equal(digest(JSON.stringify(processorControllers)), hash);
  return { processor, processorControllers,
    changedControllers: assertArmPairRepairControllerDifference(predecessor.processorControllers, processorControllers) };
}

function armPairRepairProofFile(loaded, hash) {
  assert.match(hash, HASH); return path.join(loaded.place.attempt, `arm-pair-repair-${hash}.json`);
}

function readArmPairRepairProof(batch, batchFile, loaded, runtime, event) {
  assert.ok(['arm', 'switch', 'proof', 'recovery'].includes(runtime.phase), 'Arm-pair repair cannot repeat verify or build work');
  assert.equal(batch.runId, ARM_PAIR_REPAIR_ORIGIN.runId); assert.equal(batch.taskId, ARM_PAIR_REPAIR_ORIGIN.taskId);
  const reference = event.value.value; exactKeys(reference, ['schema', 'proofFile', 'proofSha256'], 'arm-pair repair reference');
  assert.equal(reference.schema, 'sd2-release-arm-pair-repair-reference.v1');
  assert.equal(reference.proofFile, armPairRepairProofFile(loaded, reference.proofSha256));
  const document = rootDocument(reference.proofFile, 4 * 1024 * 1024), proof = document.value;
  assert.equal(document.snapshot.sha256, reference.proofSha256); assert.equal(proof.schema, ARM_PAIR_REPAIR_PROOF);
  validateArmPairRepair(proof.request);
  for (const key of ['runId', 'taskId', 'attemptId', 'batchFile', 'batchSha256', 'contextSha256', 'seedSha256', 'manifestSha256', 'artifactsSha256'])
    assert.equal(proof[key], runtime.reader.proof[key]);
  assert.deepEqual(proof.engine, batch.engine); assert.deepEqual(proof.predecessorProcessor, runtime.reader.proof.processor);
  assert.equal(proof.originalReaderProofFile, runtime.reader.proofFile); assert.equal(proof.originalReaderProofSha256, runtime.reader.proofSha256);
  assert.equal(proof.candidateObservationProofFile, runtime.candidateObservation.proofFile);
  assert.equal(proof.candidateObservationProofSha256, runtime.candidateObservation.proofSha256);
  assert.equal(proof.request.readerProofSha256, runtime.reader.proofSha256);
  assert.equal(proof.request.candidateObservationProofSha256, runtime.candidateObservation.proofSha256);
  const identity = armPairRepairProcessor(batch, runtime.reader.proof, proof.request.processorControllerSetSha256);
  for (const key of ['processor', 'processorControllers', 'changedControllers']) assert.deepEqual(proof[key], identity[key]);
  const continued = loaded.events.filter(item => item.value.kind === 'failure_continued' && item.value.failureReceiptSha256 === reference.proofSha256);
  assert.equal(continued.length, 1); const continuation = continued[0];
  assert.equal(continuation.value.previousTerminalSha256, proof.request.terminalEventSha256);
  assert.equal(continuation.value.previousSha256, proof.request.terminalEventSha256); assert.equal(continuation.value.continuation, undefined);
  assert.equal(event.value.previousSha256, continuation.sha256); assert.deepEqual(event.value.owner, continuation.value.owner);
  const failed = armPairRepairFailureSnapshot(batch, loaded, proof.request, inspectControllerOwner);
  assert.equal(proof.failureIntentSha256, failed.failureIntentSha256);
  assert.deepEqual(Object.keys(proof.failure).sort(), Object.keys(failed.failure).sort());
  for (const [name, current] of Object.entries(failed.failure)) {
    const original = proof.failure[name]; assert.equal(original.file, current.file); assert.equal(original.sha256, current.sha256);
    assert.equal(original.snapshot.requestedPath, original.file); assert.equal(original.snapshot.sha256, original.sha256);
    assertTypedFileUnchanged(original.snapshot);
  }
  assert.equal(proof.approvalFile, path.join(path.dirname(batch.manifestFile), 'hd-release-safety-approval-arm-pair-r01.json'));
  assert.equal(proof.approvalFile, proof.request.approvalFile); assert.equal(proof.approvalSha256, proof.request.approvalSha256);
  const approval = rootDocument(proof.approvalFile, 256 * 1024); assert.equal(approval.snapshot.sha256, proof.approvalSha256);
  assert.equal(proof.approvalSnapshot.requestedPath, proof.approvalFile); assert.equal(proof.approvalSnapshot.sha256, proof.approvalSha256);
  assertTypedFileUnchanged(proof.approvalSnapshot);
  assert.equal(proof.windowSha256, proof.request.windowSha256);
  assert.equal(proof.windowFile, path.join(path.dirname(batch.manifestFile), 'window-evidence', proof.windowSha256 + '.json'));
  const window = rootDocument(proof.windowFile, 256 * 1024); assert.equal(window.snapshot.sha256, proof.windowSha256);
  assert.equal(proof.windowSnapshot.requestedPath, proof.windowFile); assert.equal(proof.windowSnapshot.sha256, proof.windowSha256);
  assertTypedFileUnchanged(proof.windowSnapshot);
  for (const key of ['originalTimesChanged', 'newCompilationClaimed', 'candidateObservationRenewed']) assert.equal(proof[key], false);
  for (const kind of ['main', 'guard']) assert.deepEqual(proof.successfulArtifacts[kind], runtime.reader.proof.successfulArtifacts[kind]);
  return { schema: 'sd2-release-arm-pair-repair-runtime.v1', proofFile: reference.proofFile, proofSha256: reference.proofSha256, proof };
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
  let tail = null, guardBuildTail = null;
  if (here !== batch.engine.root) {
    const loaded = readAttempt({ root: `${batch.projectRoot}/release-tasks`, taskId: batch.taskId, attemptId: batch.attemptId });
    assert.equal(loaded.derivedState.activePhase?.phase, phase);
    assert.equal(invocationFile, path.join(loaded.place.attempt, `${phase}-${loaded.derivedState.activePhase.intentSha256}.invocation.json`));
    assert.deepEqual(invocation.owner, loaded.derivedState.owner);
    if (loaded.derivedState.guardBuildTail) guardBuildTail = readGuardBuildTailProof(batch, batchFile, loaded, phase);
    else {
      assert.equal(phase, 'prepare', 'Changed entry may only execute the bound prepare tail');
      tail = readPrepareTailProof(batch, batchFile, loaded);
    }
  }
  if (!guardBuildTail) assertPrepareTailChildRoute(phase, batch.engine.root, here, tail?.proof);
  engineContext.configureReleaseContext(guardBuildTail ? { ...context, guardBuildTail } : context);
  if (guardBuildTail && phase === 'guard-build') {
    const { completeSuccessfulGuardBuildTail } = await import('./candidate.mjs');
    assert.equal(typeof completeSuccessfulGuardBuildTail, 'function');
    return completeSuccessfulGuardBuildTail(assertManifest(batch), guardBuildTail);
  }
  if (tail) {
    const { resumePrepareTail } = await import('./candidate.mjs');
    assert.equal(typeof resumePrepareTail, 'function');
    return resumePrepareTail(assertManifest(batch), { mainPreparedSha256: tail.proof.request.mainPreparedSha256,
      guardInputSha256: tail.proof.request.guardInputSha256, continuationSha256: tail.sha256 });
  }
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
  let tail = null;
  if (here !== batch.engine.root) {
    if (loaded.derivedState.guardBuildTail) readGuardBuildTailProof(batch, batchFile, loaded, phase);
    else {
      assert.equal(phase, 'prepare', 'Changed entry may only start the bound prepare-tail child');
      tail = readPrepareTailProof(batch, batchFile, loaded);
    }
  }
  if (!loaded.derivedState.guardBuildTail) assertPrepareTailChildRoute(phase, batch.engine.root, here, tail?.proof);
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
    if (value.schema === 'sd2-candidate-build-tail.v1') {
      assert.equal(kind, 'guard');
      const loaded = readAttempt({ root: `${batch.projectRoot}/release-tasks`, taskId: batch.taskId, attemptId: batch.attemptId });
      const status = loaded.derivedState.guardBuildTailRetry?.status ?? loaded.derivedState.guardBuildTail?.status;
      const repaired = loaded.events.some(item => item.value.kind === 'observation' && item.value.name === 'arm_pair_repair');
      const phase = status === 'pending' ? 'guard-build' : repaired
        ? loaded.derivedState.activePhase?.phase || nextReleasePhase(loaded) || 'proof' : 'verify';
      const runtime = readGuardBuildTailProof(batch, loaded.header.manifest.file, loaded, phase);
      assert.equal(value.tailPostchecks.continuationSha256, runtime.continuationSha256);
      assert.equal(value.tailPostchecks.proofFile, runtime.proofFile); assert.equal(value.helperProbePhase, 'prepare');
      assert.equal(value.tailPostchecks.retainedOriginalCommand, true);
      assert.equal(value.tailPostchecks.originalCompiledSnapshotUnavailable, true);
      assert.equal(value.tailPostchecks.originalBuildCommandSha256, runtime.proof.request.buildCommandSha256);
      if (runtime.retry) {
        assert.equal(value.tailPostchecks.retryProofSha256, runtime.retry.proofSha256);
        assert.equal(value.tailPostchecks.retryProofFile, runtime.retry.proofFile);
      }
      assert.equal(value.startedAt, runtime.proof.originalBuild.startedAt); assert.equal(value.finishedAt, runtime.proof.originalBuild.finishedAt);
      assert.equal(value.build, runtime.proof.originalBuild.build);
      const capsule = rootJson(path.join(stage, 'guard-immutable-success.json'), 128 * 1024 * 1024);
      assert.equal(capsule.schema, 'sd2-immutable-successful-build-tail.v1'); assert.equal(capsule.kind, 'guard');
      assert.equal(capsule.sourceRun, batch.runId); assert.deepEqual(capsule.originalReceipt, value);
      assert.equal(capsule.originalReceiptSha256, digest(document.bytes));
      assert.equal(capsule.originallyVerifiedWithinThirtyMinuteGate, false);
      assert.equal(capsule.originalTimesChanged, false); assert.equal(capsule.newCompilationClaimed, false);
      assert.deepEqual(capsule.tailPostchecks, value.tailPostchecks);
    } else assert.equal(value.schema, 'rate-impl2-candidate-build.v1');
    assert.equal(value.label, kind);
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
    } else {
      requireMarker(stage, 'main-prepared.json'); requireMarker(stage, 'guard-prepared.json');
      if (here !== batch.engine.root) {
        assert.deepEqual(output.main, rootJson(path.join(stage, 'main-prepared.json'), 32 * 1024 * 1024));
        assert.deepEqual(output.guard, rootJson(path.join(stage, 'guard-prepared.json'), 32 * 1024 * 1024));
      }
    }
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
    if (phase === 'guard-build') {
      let identity;
      try { identity = verifyBuildInputIdentity(batch); }
      catch (error) { error.preChildFailure = 'build_input_identity'; throw error; }
      recordAttemptEvent({ ...common, name: 'build_input_identity', value: identity, now: deps.now() });
    }
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
    if (deps.runChild === defaultRunChild) {
      const batch = readReleaseBatch(batchFile);
      if (here !== batch.engine.root) {
        const loaded = load(batchFile, batch), phase = nextReleasePhase(loaded);
        if (loaded.derivedState.guardBuildTail) readGuardBuildTailProof(batch, batchFile, loaded, phase);
        else {
          assert.equal(phase, 'prepare', 'Continue later phases using the original frozen release entry');
          readPrepareTailProof(batch, batchFile, loaded);
        }
      }
    }
    const acquired = acquire(batchFile, windowFile);
    const reconciled = await reconcileActive(batchFile, acquired);
    if (reconciled.recovered || reconciled.stoppedForFreshAttempt) return reconciled;
    const loaded = load(batchFile, acquired.batch), phase = nextReleasePhase(loaded);
    assert.ok(phase, 'Release attempt has no remaining phase');
    if (requestedPhase !== null) assert.equal(requestedPhase, phase, 'Requested phase is not the next immutable phase');
    if (['arm', 'switch'].includes(phase)) {
      assert.ok(approvalFile, `${phase} requires an explicit fresh approval file`); assertApproval(acquired.batch, approvalFile, deps.now());
      if (phase === 'arm' && loaded.events.some(item => item.value.kind === 'observation' && item.value.name === 'arm_pair_repair')) {
        const runtime = readGuardBuildTailProof(acquired.batch, batchFile, loaded, phase), repair = runtime.armPairRepair.proof;
        assert.equal(approvalFile, repair.approvalFile);
        assert.equal(rootDocument(approvalFile, 256 * 1024).snapshot.sha256, repair.approvalSha256);
        assert.equal(rootDocument(windowFile, 256 * 1024).snapshot.sha256, repair.windowSha256);
      }
    }
    try { return await execute(batchFile, { ...acquired, loaded }, phase); }
    catch (error) {
      const current = load(batchFile, acquired.batch), scene = deps.scene(acquired.batch, deps.now());
      const boundary = switchBoundaryFacts(current);
      if (error.preChildFailure === 'build_input_identity' && phase === 'guard-build'
        && current.derivedState.activePhase === null && !scene.facts.effectsStarted && !boundary.effectsStarted) {
        const value = { schema: 'sd2-release-pre-child-failure.v1', phase, gate: 'build_input_identity',
          taskId: acquired.batch.taskId, attemptId: acquired.batch.attemptId,
          batchSha256: kernelBindings(batchFile, acquired.batch).manifest.sha256,
          eventHead: current.derivedState.lastEventSha256, noChildStarted: true, effectsStarted: false,
          originalError: String(error), observedAt: new Date(deps.now()).toISOString() };
        const saved = writeJsonExclusive(path.join(current.place.attempt, 'pre-child-' + value.eventHead + '.json'), value);
        recordAttemptEvent({ root: taskRoot(acquired.batch), taskId: acquired.batch.taskId, attemptId: acquired.batch.attemptId,
          owner: acquired.owner, name: 'pre_child_failure', value: { file: saved.file, sha256: saved.sha256 }, now: deps.now() });
      }
      if (current.derivedState.activePhase === null && !(phase === 'switch' && (scene.facts.effectsStarted || boundary.effectsStarted)))
        finishAttempt({ root: taskRoot(acquired.batch), taskId: acquired.batch.taskId, attemptId: acquired.batch.attemptId,
          owner: acquired.owner, outcome: 'failed', after: scene, now: deps.now() });
      throw error;
    }
  }

  async function authorizeReaderSuccessor(batchFile, windowFile, requestFile) {
    const batch = readReleaseBatch(batchFile), context = assertContext(batch, batchFile);
    assertSeed(batch); const manifest = assertManifest(batch), loaded = load(batchFile, batch);
    const request = validateReaderSuccessor(rootJson(requestFile, 16384)), now = deps.now(), scene = deps.scene(batch, now);
    assertReaderSuccessorAdmission(loaded, request, scene);
    const observed = parseTime(request.observedAt, 'reader request observation');
    assert.ok(observed <= now && now - observed < 300000, 'Reader request must bind the current completed attempt');
    const bindings = kernelBindings(batchFile, batch); assertAttemptBindings(loaded, bindings);
    const lease = ownerLease(loaded); assert.ok(lease); assert.equal(deps.inspectOwner(lease.value.owner), 'dead');
    const runtime = readGuardBuildTailProof(batch, batchFile, loaded, 'verify', { readerAdmission: true });
    assert.ok(runtime.retry); const predecessor = runtime.retry.proof;
    assert.equal(predecessor.processor.controllerSetSha256, request.predecessorControllerSetSha256);
    const identity = readerSuccessorProcessor(batch, predecessor, request.processorControllerSetSha256);
    const completedChildren = Object.fromEntries(['main', 'guard'].map(kind => [kind, readerSuccessorChildSnapshot(batch, loaded, kind, deps.inspectOwner)]));
    const successfulArtifacts = Object.fromEntries(['main', 'guard'].map(kind => [kind, readerSuccessorBuildSnapshot(batch, kind, runtime)]));
    const capsuleEvent = loaded.events.find(item => item.value.kind === 'observation' && item.value.name === 'artifact_capsule');
    for (const kind of ['main', 'guard']) {
      const value = successfulArtifacts[kind], capsule = capsuleEvent.value.value[kind];
      assert.equal(capsule.build, value.build); assert.equal(capsule.compiledTreeSha256, value.compiledTreeSha256);
      assert.equal(capsule.immutableSuccessSha256, value.inputs.capsule.sha256);
    }
    const verifierFile = path.join(predecessor.processor.root, 'candidate-reuse.mjs');
    const verifierRead = readTypedFile({ file: verifierFile, category: 'root_control' });
    assert.equal(verifierRead.snapshot.sha256, predecessor.processorControllers['candidate-reuse.mjs']);
    // This command only observes retained builds. The predecessor's complete
    // snapshot verifier is used with its original, already validated runtime.
    engineContext.configureReleaseContext({ ...context, guardBuildTail: runtime });
    const { verifyOriginalSuccess } = await import(pathToFileURL(verifierFile).href);
    const { readProtection, assertProtection } = await import(pathToFileURL(path.join(predecessor.processor.root, 'common.mjs')).href);
    assert.equal(typeof verifyOriginalSuccess, 'function'); assert.equal(typeof readProtection, 'function'); assert.equal(typeof assertProtection, 'function');
    const startedAt = deps.now(), before = readProtection(manifest), verified = {};
    for (const kind of ['main', 'guard']) {
      verified[kind] = verifyOriginalSuccess(manifest, kind);
      assert.deepEqual(verified[kind], rootJson(successfulArtifacts[kind].inputs.capsule.file, 128 * 1024 * 1024));
      assert.deepEqual(successfulArtifacts[kind], readerSuccessorBuildSnapshot(batch, kind, runtime));
    }
    const after = readProtection(manifest); assertProtection(before, after);
    const projection = value => Object.fromEntries(OBSERVATION_PROTECTION_FIELDS.map(key => [key, value[key]]));
    assert.deepEqual(projection(before), projection(after));
    const protectionSha256 = digest(JSON.stringify(projection(before))), finishedAt = deps.now();
    const current = load(batchFile, batch); assert.equal(current.derivedState.lastEventSha256, request.eventHeadSha256);
    assertReaderSuccessorAdmission(current, request, deps.scene(batch, finishedAt));
    assert.equal(deps.inspectOwner(lease.value.owner), 'dead');
    for (const kind of ['main', 'guard']) assert.deepEqual(completedChildren[kind], readerSuccessorChildSnapshot(batch, current, kind, deps.inspectOwner));
    const owner = deps.createOwner(), window = releaseWindowReference(batch, windowFile, finishedAt);
    const takeover = takeoverAttempt({ root: taskRoot(batch), taskId: batch.taskId, attemptId: batch.attemptId, owner,
      priorLeaseSha256: lease.sha256, ...bindings, window, now: finishedAt, inspectOwner: deps.inspectOwner });
    assert.equal(takeover.event.previousSha256, request.eventHeadSha256);
    const proof = { schema: READER_SUCCESSOR_PROOF, request, eventHeadSha256: takeover.eventSha256,
      originalContinuationSha256: runtime.continuationSha256, originalProofFile: runtime.proofFile,
      retryProofSha256: runtime.retry.proofSha256, retryProofFile: runtime.retry.proofFile,
      predecessorProcessor: predecessor.processor, previousOwner: lease.value.owner, previousLeaseSha256: lease.sha256,
      ...Object.fromEntries(['runId', 'taskId', 'attemptId', 'batchFile', 'batchSha256', 'contextSha256', 'seedSha256', 'manifestSha256', 'artifactsSha256']
        .map(key => [key, predecessor[key]])), engine: batch.engine, ...identity, successfulArtifacts, completedChildren,
      observedAt: new Date(deps.now()).toISOString(), buildAuthority: false };
    const proofSha256 = digest(Buffer.from(JSON.stringify(proof, null, 2) + '\n'));
    const saved = writeJsonExclusive(readerSuccessorProofFile(loaded, proofSha256), proof); assert.equal(saved.sha256, proofSha256);
    const observation = { schema: 'sd2-release-candidate-observation-proof.v1', engine: batch.engine,
      runId: batch.runId, taskId: batch.taskId, attemptId: batch.attemptId, manifestSha256: proof.manifestSha256,
      originalContinuationSha256: runtime.continuationSha256, retryProofSha256: runtime.retry.proofSha256,
      readerProofSha256: proofSha256, eventHeadSha256: proof.eventHeadSha256,
      observedAt: finishedAt, expiresAt: finishedAt + 1800000,
      verifier: { file: verifierFile, sha256: verifierRead.snapshot.sha256, method: 'verifyOriginalSuccess', startedAt, finishedAt },
      protectionComparison: 'assertProtection', protectionFields: OBSERVATION_PROTECTION_FIELDS, protectionSha256,
      candidates: Object.fromEntries(['main', 'guard'].map(kind => [kind, {
        capsuleFile: successfulArtifacts[kind].inputs.capsule.file, capsuleSha256: successfulArtifacts[kind].inputs.capsule.sha256,
        receiptFile: successfulArtifacts[kind].inputs.build.file, receiptSha256: successfulArtifacts[kind].inputs.build.sha256,
        snapshotSha256: digest(JSON.stringify(verified[kind].snapshot)) }])),
      readOnly: true, newCompilationClaimed: false, originalTimesChanged: false, continuousUnchangedIntervalClaimed: false };
    const observationSha256 = digest(Buffer.from(JSON.stringify(observation, null, 2) + '\n'));
    const observedFile = writeJsonExclusive(candidateObservationProofFile(loaded, observationSha256), observation);
    assert.equal(observedFile.sha256, observationSha256);
    const common = { root: taskRoot(batch), taskId: batch.taskId, attemptId: batch.attemptId, owner };
    const recorded = recordAttemptEvent({ ...common, name: 'reader_successor', value: {
      schema: 'sd2-release-reader-successor-reference.v1', proofFile: saved.file, proofSha256 }, now: deps.now() });
    assert.equal(recorded.event.previousSha256, proof.eventHeadSha256);
    const candidateRecorded = recordAttemptEvent({ ...common, name: 'candidate_observation', value: {
      schema: 'sd2-release-candidate-observation-reference.v1', proofFile: observedFile.file, proofSha256: observationSha256 }, now: deps.now() });
    return { reader: saved, candidateObservation: observedFile, processor: identity.processor, eventHead: candidateRecorded.eventSha256 };
  }

  function continueFailed(batchFile, windowFile, failureFile) {
    const batch = readReleaseBatch(batchFile); assertContext(batch, batchFile); assertSeed(batch); assertManifest(batch);
    const loaded = load(batchFile, batch), request = rootJson(failureFile, 16384);
    if (request.schema === ARM_PAIR_REPAIR_SCHEMA) {
      validateArmPairRepair(request); assert.equal(batch.runId, ARM_PAIR_REPAIR_ORIGIN.runId); assert.equal(batch.taskId, ARM_PAIR_REPAIR_ORIGIN.taskId);
      const now = deps.now(), before = armPairRepairScene(batch, now, deps.scene);
      assertArmPairRepairAdmission(loaded, request, before);
      const observed = parseTime(request.observedAt, 'repair observation');
      assert.ok(observed <= now && now - observed < 300000, 'The repair request needs a fresh no-effects observation');
      const runtime = readGuardBuildTailProof(batch, batchFile, loaded, 'arm', { armPairAdmission: true });
      assert.equal(runtime.reader.proofSha256, request.readerProofSha256);
      assert.equal(runtime.candidateObservation.proofSha256, request.candidateObservationProofSha256);
      const identity = armPairRepairProcessor(batch, runtime.reader.proof, request.processorControllerSetSha256);
      const failed = armPairRepairFailureSnapshot(batch, loaded, request, deps.inspectOwner);
      const bindings = kernelBindings(batchFile, batch); assertAttemptBindings(loaded, bindings);
      assert.equal(request.approvalFile, path.join(path.dirname(batch.manifestFile), 'hd-release-safety-approval-arm-pair-r01.json'));
      assert.equal(assertApproval(batch, request.approvalFile, now).sha256, request.approvalSha256);
      assert.equal(rootDocument(windowFile, 256 * 1024).snapshot.sha256, request.windowSha256);
      const window = releaseWindowReference(batch, windowFile, now); assert.equal(window.sha256, request.windowSha256);
      const approval = rootDocument(request.approvalFile, 256 * 1024), windowDocument = rootDocument(window.file, 256 * 1024);
      const current = load(batchFile, batch), finalNow = deps.now(), fresh = armPairRepairScene(batch, finalNow, deps.scene);
      assertArmPairRepairAdmission(current, request, fresh); assert.equal(fresh.sha256, before.sha256);
      assert.equal(assertApproval(batch, request.approvalFile, finalNow).sha256, request.approvalSha256);
      assert.ok(finalNow < window.expiresAt); assert.deepEqual(failed, armPairRepairFailureSnapshot(batch, current, request, deps.inspectOwner));
      const proof = { schema: ARM_PAIR_REPAIR_PROOF, request,
        ...Object.fromEntries(['runId', 'taskId', 'attemptId', 'batchFile', 'batchSha256', 'contextSha256', 'seedSha256', 'manifestSha256', 'artifactsSha256']
          .map(key => [key, runtime.reader.proof[key]])), engine: batch.engine,
        originalReaderProofFile: runtime.reader.proofFile, originalReaderProofSha256: runtime.reader.proofSha256,
        candidateObservationProofFile: runtime.candidateObservation.proofFile,
        candidateObservationProofSha256: runtime.candidateObservation.proofSha256,
        predecessorProcessor: runtime.reader.proof.processor, ...identity, ...failed,
        successfulArtifacts: runtime.reader.proof.successfulArtifacts,
        approvalFile: request.approvalFile, approvalSha256: request.approvalSha256, approvalSnapshot: approval.snapshot,
        windowFile: window.file, windowSha256: request.windowSha256, windowSnapshot: windowDocument.snapshot,
        beforeSceneSha256: fresh.sha256, observedAt: new Date(finalNow).toISOString(), originalTimesChanged: false,
        newCompilationClaimed: false, candidateObservationRenewed: false };
      const hash = digest(Buffer.from(JSON.stringify(proof, null, 2) + '\n'));
      const saved = writeJsonExclusive(armPairRepairProofFile(loaded, hash), proof); assert.equal(saved.sha256, hash);
      const owner = deps.createOwner(), continued = continueFailedAttempt({ root: taskRoot(batch), taskId: batch.taskId,
        attemptId: batch.attemptId, owner, ...bindings, window, terminalEventSha256: request.terminalEventSha256,
        failureReceiptSha256: hash, before: fresh, now: finalNow, inspectOwner: deps.inspectOwner });
      const recorded = recordAttemptEvent({ root: taskRoot(batch), taskId: batch.taskId, attemptId: batch.attemptId, owner,
        name: 'arm_pair_repair', value: { schema: 'sd2-release-arm-pair-repair-reference.v1', proofFile: saved.file, proofSha256: hash }, now: deps.now() });
      assert.equal(recorded.event.previousSha256, continued.eventSha256);
      return { continuation: saved, processor: identity.processor, eventHead: recorded.eventSha256 };
    }
    if (request.schema === GUARD_TAIL_RETRY_SCHEMA) {
      validateGuardBuildTailRetry(request);
      assert.equal(loaded.derivedState.status, 'failed'); assert.equal(loaded.derivedState.activePhase, null);
      assert.equal(loaded.events.at(-1).sha256, request.terminalEventSha256); assert.equal(nextReleasePhase(loaded), 'guard-build');
      assert.equal(loaded.derivedState.guardBuildTail?.status, 'failed'); assert.equal(loaded.derivedState.guardBuildTailRetry, undefined);
      assert.equal(request.originalContinuationSha256, loaded.derivedState.guardBuildTail.proofSha256);
      assert.equal(request.phaseResultEventSha256, loaded.derivedState.guardBuildTail.resultSha256);
      assert.equal(loaded.events.some(item => item.value.name === 'artifact_capsule'), false);
      const bindings = kernelBindings(batchFile, batch); assertAttemptBindings(loaded, bindings);
      const original = readGuardBuildTailProof(batch, batchFile, loaded, 'guard-build', { retryAdmission: true });
      const failedRequest = { ...original.proof.request, terminalEventSha256: request.terminalEventSha256,
        phaseResultEventSha256: request.phaseResultEventSha256, childReceiptSha256: request.childReceiptSha256 };
      const failure = guardBuildTailFailure(batch, loaded, failedRequest, deps.inspectOwner);
      const child = readChildReceipt(childReceiptFile(loaded, 'guard-build', failure.result.value.intentSha256), 'guard-build', failure.result.value.intentSha256);
      assertGuardBuildTailRetryFailure(child.receipt);
      const identity = guardBuildTailProcessor(batch, request.processorControllerSetSha256);
      const retryControllerChanges = assertGuardBuildTailRetryControllerDifference(original.proof.processorControllers, identity.processorControllers);
      guardBuildTailSnapshot(batch, original.proof.request, { initial: true });
      const snapshot = guardBuildTailRetrySnapshot(batch, request), now = deps.now(), observed = parseTime(request.observedAt, 'retry observation');
      assert.ok(observed <= now && now - observed < 300000, 'Retry requires a fresh retained-evidence observation');
      const scene = deps.scene(batch, now); assert.equal(scene.facts.effectsStarted, false); assert.equal(scene.facts.switchComplete, false);
      assert.equal(switchBoundaryFacts(loaded).effectsStarted, false);
      const owner = deps.createOwner(), window = releaseWindowReference(batch, windowFile, now);
      const proof = { schema: GUARD_TAIL_RETRY_PROOF, originalContinuationSha256: original.continuationSha256,
        originalProofFile: original.proofFile, originalObservedAt: original.proof.observedAt,
        taskId: batch.taskId, attemptId: batch.attemptId, runId: batch.runId, batchFile,
        batchSha256: bindings.manifest.sha256, contextSha256: original.proof.contextSha256, seedSha256: original.proof.seedSha256,
        manifestSha256: original.proof.manifestSha256, artifactsSha256: original.proof.artifactsSha256, engine: batch.engine,
        ...identity, retryControllerChanges, request, ...snapshot,
        processReceiptSha256: failure.processReceiptSha256, invocationSha256: failure.invocationSha256, observedAt: new Date(now).toISOString() };
      const hash = digest(Buffer.from(JSON.stringify(proof, null, 2) + '\n'));
      const saved = writeJsonExclusive(guardBuildTailRetryProofFile(loaded, hash), proof); assert.equal(saved.sha256, hash);
      const result = continueFailedAttempt({ root: taskRoot(batch), taskId: batch.taskId, attemptId: batch.attemptId,
        owner, ...bindings, window, terminalEventSha256: request.terminalEventSha256, failureReceiptSha256: hash,
        continuation: { schema: 'sd2-release-guard-build-tail-retry-binding.v1', phase: 'guard-build', proofSha256: hash,
          processorControllerSetSha256: identity.processor.controllerSetSha256,
          originalContinuationSha256: original.continuationSha256, originalFailureResultSha256: failure.result.sha256 },
        before: scene, now, inspectOwner: deps.inspectOwner });
      return { ...result, continuation: saved, processor: identity.processor };
    }
    if (request.schema === GUARD_TAIL_SCHEMA) {
      validateGuardBuildTailContinuation(request);
      assert.equal(loaded.derivedState.status, 'failed'); assert.equal(loaded.derivedState.activePhase, null);
      assert.equal(loaded.events.at(-1).sha256, request.terminalEventSha256); assert.equal(nextReleasePhase(loaded), 'guard-build');
      assert.equal(loaded.derivedState.guardBuildTail, undefined);
      assert.equal(loaded.events.some(item => item.value.name === 'artifact_capsule'), false);
      const bindings = kernelBindings(batchFile, batch); assertAttemptBindings(loaded, bindings);
      const failure = guardBuildTailFailure(batch, loaded, request, deps.inspectOwner);
      const identity = guardBuildTailProcessor(batch, request.processorControllerSetSha256), now = deps.now();
      const observed = parseTime(request.observedAt, 'retained build observation');
      assert.ok(observed <= now && now - observed < 300000, 'Retained compiled output needs a fresh observation');
      const retained = guardBuildTailSnapshot(batch, request, { initial: true }), scene = deps.scene(batch, now);
      assert.equal(scene.facts.effectsStarted, false); assert.equal(scene.facts.switchComplete, false);
      assert.equal(switchBoundaryFacts(loaded).effectsStarted, false);
      const owner = deps.createOwner(), window = releaseWindowReference(batch, windowFile, now);
      const proof = { schema: GUARD_TAIL_PROOF, taskId: batch.taskId, attemptId: batch.attemptId, runId: batch.runId,
        batchFile, batchSha256: bindings.manifest.sha256, contextSha256: digest(rootDocument(batch.contextFile, 256 * 1024).bytes),
        seedSha256: digest(rootDocument(batch.seedFile).bytes), manifestSha256: digest(rootDocument(batch.manifestFile, 32 * 1024 * 1024).bytes),
        artifactsSha256: digest(JSON.stringify(batch.artifacts)), engine: batch.engine, ...identity, request, ...retained,
        processReceiptSha256: failure.processReceiptSha256, invocationSha256: failure.invocationSha256,
        observedAt: new Date(now).toISOString() };
      const hash = digest(Buffer.from(JSON.stringify(proof, null, 2) + '\n'));
      const saved = writeJsonExclusive(guardBuildTailProofFile(loaded, hash), proof); assert.equal(saved.sha256, hash);
      const result = continueFailedAttempt({ root: taskRoot(batch), taskId: batch.taskId, attemptId: batch.attemptId,
        owner, ...bindings, window, terminalEventSha256: request.terminalEventSha256, failureReceiptSha256: hash,
        continuation: { schema: 'sd2-release-guard-build-tail-binding.v1', phase: 'guard-build', proofSha256: hash,
          processorControllerSetSha256: identity.processor.controllerSetSha256 },
        before: scene, now, inspectOwner: deps.inspectOwner });
      return { ...result, continuation: saved, processor: identity.processor };
    }
    if (request.schema === PREPARE_TAIL_SCHEMA) {
      validatePrepareTailContinuation(request);
      assert.equal(loaded.derivedState.status, 'failed'); assert.equal(loaded.derivedState.activePhase, null);
      assert.equal(loaded.events.at(-1).sha256, request.terminalEventSha256);
      assert.equal(loaded.events.some(item => item.value.kind === 'failure_continued'), false, 'Prepare-tail continuation may not recursively retry');
      const bindings = kernelBindings(batchFile, batch); assertAttemptBindings(loaded, bindings);
      const failure = prepareTailFailure(batch, loaded, request, deps.inspectOwner);
      const identity = prepareTailProcessor(batch, request.processorControllerSetSha256);
      const now = deps.now(), scene = deps.scene(batch, now);
      assertPrepareTailInputs(batch, request, scene);
      assert.equal(failure.result.value.after.facts.files['manifest.json']?.sha256,
        digest(rootDocument(batch.manifestFile, 32 * 1024 * 1024).bytes));
      const owner = deps.createOwner(), window = releaseWindowReference(batch, windowFile, now);
      const proof = { schema: PREPARE_TAIL_PROOF_SCHEMA, taskId: batch.taskId, attemptId: batch.attemptId, runId: batch.runId,
        batchFile, batchSha256: bindings.manifest.sha256, contextSha256: digest(rootDocument(batch.contextFile, 256 * 1024).bytes),
        seedSha256: digest(rootDocument(batch.seedFile).bytes), manifestSha256: digest(rootDocument(batch.manifestFile, 32 * 1024 * 1024).bytes),
        artifactsSha256: digest(JSON.stringify(batch.artifacts)), engine: batch.engine, ...identity, request,
        processReceiptSha256: failure.processReceiptSha256, invocationSha256: failure.invocationSha256, observedAt: new Date(now).toISOString() };
      const proofSha256 = digest(Buffer.from(JSON.stringify(proof, null, 2) + '\n'));
      const saved = writeJsonExclusive(prepareTailProofFile(loaded, proofSha256), proof);
      assert.equal(saved.sha256, proofSha256);
      const result = continueFailedAttempt({ root: taskRoot(batch), taskId: batch.taskId, attemptId: batch.attemptId,
        owner, ...bindings, window, terminalEventSha256: request.terminalEventSha256,
        failureReceiptSha256: saved.sha256, before: scene, now, inspectOwner: deps.inspectOwner });
      return { ...result, continuation: saved, processor: identity.processor };
    }
    exactKeys(request, ['schema', 'terminalEventSha256', 'failureReceiptSha256'], 'pre-child failure continuation');
    assert.equal(request.schema, 'sd2-release-failed-continuation.v1');
    assert.equal(loaded.derivedState.status, 'failed'); assert.equal(nextReleasePhase(loaded), 'guard-build');
    assert.equal(loaded.derivedState.lastPhase?.phase, 'prepare'); assert.equal(loaded.derivedState.lastPhase?.outcome, 'succeeded');
    const terminal = loaded.events.at(-1), failure = loaded.events.at(-2);
    assert.equal(terminal.value.kind, 'attempt_finished'); assert.equal(terminal.value.outcome, 'failed');
    assert.equal(terminal.sha256, request.terminalEventSha256);
    assert.equal(failure.value.kind, 'observation'); assert.equal(failure.value.name, 'pre_child_failure');
    const receipt = rootDocument(failure.value.value.file, 32768);
    assert.equal(digest(receipt.bytes), request.failureReceiptSha256); assert.equal(failure.value.value.sha256, request.failureReceiptSha256);
    assert.equal(receipt.value.schema, 'sd2-release-pre-child-failure.v1');
    assert.equal(receipt.value.taskId, batch.taskId); assert.equal(receipt.value.attemptId, batch.attemptId);
    assert.equal(receipt.value.phase, 'guard-build'); assert.equal(receipt.value.gate, 'build_input_identity');
    assert.equal(receipt.value.noChildStarted, true); assert.equal(receipt.value.effectsStarted, false);
    const bindings = kernelBindings(batchFile, batch); assert.equal(receipt.value.batchSha256, bindings.manifest.sha256);
    assert.equal(failure.value.previousSha256, receipt.value.eventHead);
    assert.equal(receipt.value.file, undefined);
    const scene = deps.scene(batch, deps.now()); assert.equal(scene.facts.effectsStarted, false); assert.equal(scene.facts.switchComplete, false);
    assert.equal(switchBoundaryFacts(loaded).effectsStarted, false);
    verifyBuildInputIdentity(batch); // Exact original raw source-manifest digest, never a new createdAt projection.
    const owner = deps.createOwner(), now = deps.now(), window = releaseWindowReference(batch, windowFile, now);
    return continueFailedAttempt({ root: taskRoot(batch), taskId: batch.taskId, attemptId: batch.attemptId,
      owner, ...bindings, window, terminalEventSha256: request.terminalEventSha256,
      failureReceiptSha256: request.failureReceiptSha256, before: scene, now, inspectOwner: deps.inspectOwner });
  }

  async function resume(batchFile, windowFile) {
    if (deps.runChild === defaultRunChild) {
      const batch = readReleaseBatch(batchFile);
      if (here !== batch.engine.root) {
        const loaded = load(batchFile, batch);
        if (loaded.derivedState.guardBuildTail) readGuardBuildTailProof(batch, batchFile, loaded, nextReleasePhase(loaded));
        else {
          assert.equal(nextReleasePhase(loaded), 'prepare', 'Continue later phases using the original frozen release entry');
          readPrepareTailProof(batch, batchFile, loaded);
        }
      }
    }
    const acquired = acquire(batchFile, windowFile);
    return reconcileActive(batchFile, acquired);
  }

  return { start, run, resume, continueFailed, authorizeReaderSuccessor, status, inspect };
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
  if (command === 'continue-failed' && args.length === 3) return print(controller.continueFailed(args[0], args[1], args[2]));
  if (command === 'authorize-reader-successor' && args.length === 3)
    return print(await controller.authorizeReaderSuccessor(args[0], args[1], args[2]));
  if (command === 'resume' && args.length === 2) return print(await controller.resume(args[0], args[1]));
  if (command === 'run' && args.length >= 2 && args.length <= 4)
    return print(await controller.run(args[0], args[1], args[2] || null, args[3] || null));
  throw new Error('Usage: release-entry.mjs package CONTEXT.json REQUEST.json | native CONTEXT.json FIXTURE.mjs [...args] | install-engine INSTALL.json | start BATCH.json WINDOW.json | status BATCH.json | inspect BATCH.json | resume BATCH.json WINDOW.json | continue-failed BATCH.json WINDOW.json FAILURE.json | authorize-reader-successor BATCH.json WINDOW.json REQUEST.json | run BATCH.json WINDOW.json [PHASE [APPROVAL.json]]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  releaseEntryCli().catch(error => {
    const record = error?.releaseError || classifyReleaseError(error, { phase: process.argv[2] || 'entry' });
    process.stderr.write(JSON.stringify({ error: record, cause: String(error) }) + '\n'); process.exitCode = 1;
  });
}
