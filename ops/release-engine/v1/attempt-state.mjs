import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ReleaseEngineError, releaseError } from './release-errors.mjs';

export const ATTEMPT_STATE_SCHEMA = 'sd2-release-attempt-state.v1';
export const ATTEMPT_EVENT_SCHEMA = 'sd2-release-attempt-event.v1';
export const TASK_STATE_SCHEMA = 'sd2-release-task-state.v1';

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TASK = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const PHASE = /^[a-z][a-z0-9_-]{0,63}$/;
const TERMINAL = new Set(['succeeded', 'failed', 'rolled_back', 'stopped']);
const RESERVED_EVENTS = new Set(['attempt_started', 'window_refreshed', 'owner_takeover', 'phase_intent', 'phase_result', 'attempt_finished', 'failure_continued', 'restored_original_continued']);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function fail(category, code, kind, id, reason, nextStep, options) {
  throw new ReleaseEngineError(releaseError({ category, code, object: { kind, id }, reason, nextStep }), options);
}

function assertBindingEqual(actual, expected, code, label, attemptId) {
  try { assert.deepEqual(actual, expected); }
  catch (cause) {
    fail('input_permanent', code, 'attempt', attemptId,
      `${label} differs from the immutable identity recorded for this attempt.`,
      'Use the exact recorded binding or start a new attempt after the current attempt reaches a proven terminal state.', { cause });
  }
}

function exactKeys(value, expected, name) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${name} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${name} has unexpected or missing fields`);
  return value;
}

function safeJson(value, name, maximum = 256 * 1024) {
  const text = JSON.stringify(value);
  assert.ok(text && Buffer.byteLength(text) <= maximum, `${name} exceeds its bounded JSON budget`);
  assert.equal(JSON.stringify(JSON.parse(text)), text, `${name} is not stable JSON data`);
  return value;
}

function iso(now) {
  assert.ok(Number.isSafeInteger(now) && now > 0);
  return new Date(now).toISOString();
}

function validateOwner(value) {
  exactKeys(value, ['pid', 'host', 'kernelStartTicks', 'token'], 'controller owner');
  assert.ok(Number.isSafeInteger(value.pid) && value.pid > 1);
  assert.ok(typeof value.host === 'string' && value.host.length > 0 && value.host.length <= 255 && !/[\x00-\x20/\\]/.test(value.host));
  assert.match(value.kernelStartTicks, /^\d+$/);
  assert.match(value.token, UUID);
  return value;
}

function validateEngine(value) {
  exactKeys(value, ['schema', 'version', 'sha256'], 'engine identity');
  assert.equal(value.schema, 'sd2-release-engine-identity.v1');
  assert.match(value.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  assert.match(value.sha256, HASH);
  return value;
}

function validateManifestIdentity(value) {
  exactKeys(value, ['schema', 'file', 'sha256'], 'manifest identity');
  assert.equal(value.schema, 'sd2-release-manifest-identity.v1');
  assert.ok(path.isAbsolute(value.file)); assert.match(value.sha256, HASH);
  return value;
}

function validateArtifact(value, kind) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${kind} artifact identity must be an object`);
  if (value.schema === 'sd2-release-artifact-input.v1') {
    exactKeys(value, ['schema', 'kind', 'source', 'version', 'sourceManifestSha256', 'buildInputsSha256'], `${kind} artifact input`);
    assert.match(value.buildInputsSha256, HASH);
  } else {
    exactKeys(value, ['schema', 'kind', 'source', 'version', 'build', 'sourceManifestSha256', 'compiledTreeSha256',
      'immutableSuccessSha256'], `${kind} artifact identity`);
    assert.equal(value.schema, 'sd2-release-artifact-identity.v1');
    assert.ok(typeof value.build === 'string' && value.build.length > 0 && value.build.length <= 256);
    for (const key of ['compiledTreeSha256', 'immutableSuccessSha256']) assert.match(value[key], HASH);
  }
  assert.equal(value.kind, kind);
  assert.match(value.source, /^[a-f0-9]{40}$/);
  assert.ok(typeof value.version === 'string' && value.version.length > 0 && value.version.length <= 128);
  assert.match(value.sourceManifestSha256, HASH);
  return value;
}

function validateArtifacts(value) {
  exactKeys(value, ['main', 'guard'], 'artifact pair');
  validateArtifact(value.main, 'main'); validateArtifact(value.guard, 'guard');
  assert.equal(value.main.schema, value.guard.schema, 'Main and guard artifact identities must be at the same lifecycle boundary');
  assert.notEqual(value.main.source, value.guard.source);
  return value;
}

function validateWindow(value, attemptId, runId, now, requireFresh = true) {
  exactKeys(value, ['schema', 'attemptId', 'runId', 'file', 'sha256', 'observedAt', 'expiresAt'], 'window reference');
  assert.equal(value.schema, 'sd2-release-window-reference.v1');
  assert.equal(value.attemptId, attemptId); assert.equal(value.runId, runId);
  assert.ok(path.isAbsolute(value.file)); assert.match(value.sha256, HASH);
  assert.ok(Number.isSafeInteger(value.observedAt) && Number.isSafeInteger(value.expiresAt) && value.observedAt <= value.expiresAt);
  assert.ok(value.observedAt <= now, 'Window evidence comes from the future');
  if (requireFresh) assert.ok(now < value.expiresAt, 'Window evidence is stale');
  return value;
}

function validateScene(value, name) {
  exactKeys(value, ['schema', 'capturedAt', 'sha256', 'facts'], name);
  assert.equal(value.schema, 'sd2-release-scene-summary.v1');
  assert.ok(Number.isSafeInteger(value.capturedAt) && value.capturedAt > 0); assert.match(value.sha256, HASH);
  assert.ok(value.facts && typeof value.facts === 'object' && !Array.isArray(value.facts));
  safeJson(value.facts, `${name} facts`, 128 * 1024);
  return value;
}

function validateChild(value) {
  if (value === null) return value;
  exactKeys(value, ['status', 'signal', 'error'], 'child result');
  assert.ok(value.status === null || Number.isSafeInteger(value.status));
  assert.ok(value.signal === null || typeof value.signal === 'string');
  if (value.error !== null) {
    exactKeys(value.error, ['code', 'message'], 'child error');
    assert.ok(value.error.code === null || typeof value.error.code === 'string');
    assert.ok(typeof value.error.message === 'string' && value.error.message.length <= 4000);
  }
  return value;
}

function validatePathRoot(root) {
  assert.ok(path.isAbsolute(root)); assert.equal(fs.realpathSync(root), root);
  const stat = fs.lstatSync(root);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && !(stat.mode & 0o077));
  return root;
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function mkdirExclusive(directory, mode = 0o700) {
  fs.mkdirSync(directory, { mode }); syncDirectory(path.dirname(directory));
  assert.equal(fs.realpathSync(directory), directory);
  const stat = fs.lstatSync(directory);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o777) === mode);
  return directory;
}

function readBytes(file, maximum = 1024 * 1024) {
  assert.equal(fs.realpathSync(file), file);
  const before = fs.lstatSync(file);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.uid === 0 && before.nlink === 1 && !(before.mode & 0o022)
    && before.size > 0 && before.size <= maximum);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'uid', 'gid', 'mode', 'nlink']) assert.equal(opened[key], before[key]);
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
    for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'uid', 'gid', 'mode', 'nlink']) assert.equal(after[key], before[key]);
    assert.equal(fs.lstatSync(file).ino, before.ino); return bytes;
  } finally { fs.closeSync(fd); }
}

function readJson(file, maximum) { return JSON.parse(readBytes(file, maximum)); }

function writeExclusiveJson(file, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(file)); return digest(bytes);
}

function writeCasJson(file, value, expectedSha256) {
  if (fs.existsSync(file)) {
    const before = readBytes(file); assert.equal(digest(before), expectedSha256, 'Attempt state CAS conflict');
  } else assert.equal(expectedSha256, null, 'Attempt state disappeared before CAS update');
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file); syncDirectory(path.dirname(file)); return digest(bytes);
}

function locations(root, taskId, attemptId = null) {
  assert.match(taskId, TASK); if (attemptId !== null) assert.match(attemptId, UUID);
  const task = path.join(validatePathRoot(root), taskId);
  const attempt = attemptId === null ? null : path.join(task, 'attempts', attemptId);
  return { root, task, attempts: path.join(task, 'attempts'), attempt, events: attempt && path.join(attempt, 'events') };
}

function processTicks(pid) {
  const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = text.slice(text.lastIndexOf(')') + 2).split(/\s+/);
  assert.match(fields[19], /^\d+$/); return { state: fields[0], ticks: fields[19] };
}

export function createControllerOwner() {
  assert.equal(process.platform, 'linux', 'Native controller identity requires Linux procfs');
  const current = processTicks(process.pid);
  assert.ok(!['Z', 'X', 'x'].includes(current.state));
  return validateOwner({ pid: process.pid, host: os.hostname(), kernelStartTicks: current.ticks, token: randomUUID() });
}

export function inspectControllerOwner(owner) {
  validateOwner(owner);
  if (owner.host !== os.hostname()) return 'unknown';
  try {
    const current = processTicks(owner.pid);
    return current.ticks === owner.kernelStartTicks && !['Z', 'X', 'x'].includes(current.state) ? 'alive' : 'dead';
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return 'dead';
    return 'unknown';
  }
}

function ownerEqual(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function eventFiles(events) {
  if (!fs.existsSync(events)) return [];
  return fs.readdirSync(events).filter(file => /^\d{6}\.json$/.test(file)).sort();
}

function initialDerived(header) {
  return { schema: ATTEMPT_STATE_SCHEMA, taskId: header.taskId, attemptId: header.attemptId, runId: header.runId,
    status: 'new', owner: null, currentWindow: null, activePhase: null, lastPhase: null, terminal: null,
    lastSequence: 0, lastEventSha256: null, updatedAt: header.createdAt };
}

export function validateRestoredOriginalBinding(value) {
  exactKeys(value, ['schema', 'closureProofFile', 'closureProofSha256', 'phaseResultSha256', 'restoredBaselineSha256'], 'restored original continuation binding');
  assert.equal(value.schema, 'sd2-release-restored-original-binding.v1');
  for (const key of ['closureProofSha256', 'phaseResultSha256', 'restoredBaselineSha256']) assert.match(value[key], HASH);
  assert.ok(path.isAbsolute(value.closureProofFile) && path.resolve(value.closureProofFile) === value.closureProofFile);
  assert.equal(path.basename(value.closureProofFile), 'restored-original-closure-' + value.closureProofSha256 + '.json');
  return value;
}
function restoredOriginalClosure(reference, state) {
  exactKeys(reference, ['schema', 'proofFile', 'proofSha256'], 'restored original closure reference');
  assert.equal(reference.schema, 'sd2-release-restored-original-closure-reference.v1'); assert.match(reference.proofSha256, HASH);
  assert.ok(path.isAbsolute(reference.proofFile) && path.resolve(reference.proofFile) === reference.proofFile);
  assert.equal(path.basename(reference.proofFile), 'restored-original-closure-' + reference.proofSha256 + '.json');
  assert.equal(path.basename(path.dirname(reference.proofFile)), state.attemptId);
  assert.equal(path.basename(path.dirname(path.dirname(reference.proofFile))), 'attempts');
  assert.equal(path.basename(path.dirname(path.dirname(path.dirname(reference.proofFile)))), state.taskId);
  const raw = readBytes(reference.proofFile, 4 * 1024 * 1024), proof = JSON.parse(raw);
  assert.equal(digest(raw), reference.proofSha256); assert.equal(proof.schema, 'sd2-release-restored-original-closure-proof.v1');
  for (const key of ['taskId', 'attemptId', 'runId']) assert.equal(proof[key], state[key]);
  assert.equal(proof.failedPhaseResultSha256, state.lastPhase?.resultSha256);
  assert.equal(state.lastPhase?.phase, 'switch'); assert.equal(state.lastPhase?.outcome, 'failed');
  for (const [key, value] of Object.entries({ completed: true, originalPairRestored: true, effectsStarted: true,
    pairPublished: false, schemaPublished: false, newWriterStarted: false })) assert.equal(proof[key], value);
  for (const prefix of ['restorationReceipt', 'restoredBaseline']) {
    assert.ok(path.isAbsolute(proof[prefix + 'File'])); assert.match(proof[prefix + 'Sha256'], HASH);
    assert.equal(digest(readBytes(proof[prefix + 'File'], 4 * 1024 * 1024)), proof[prefix + 'Sha256']);
  }
  const restored = readJson(proof.restorationReceiptFile, 4 * 1024 * 1024);
  assert.equal(restored.runId, state.runId); assert.equal(restored.schema, 'controlled-hd-drain-original-restoration.v1');
  for (const [key, value] of Object.entries({ completed: true, originalPairUnchanged: true, businessDataRestored: false, policiesRestored: true }))
    assert.equal(restored[key], value);
  assert.equal(restored.restored.exactOriginalBytesRestored, true); assert.equal(restored.restored.runtimeRestorationVerified, true);
  const baseline = readJson(proof.restoredBaselineFile, 4 * 1024 * 1024);
  assert.equal(baseline.schema, 'sd2-release-restored-original-baseline.v1'); assert.equal(baseline.runId, state.runId);
  assert.equal(baseline.manifestSha256, proof.manifestSha256); assert.equal(baseline.restorationReceiptSha256, proof.restorationReceiptSha256);
  assert.deepEqual(baseline.newLiveSnapshot, proof.newLiveSnapshot);
  assert.deepEqual(Object.keys(baseline.newLiveSnapshot).sort(), ['web', 'image', 'hd', 'works', 'role', 'template'].sort());
  for (const live of Object.values(baseline.newLiveSnapshot)) {
    assert.ok(Number.isSafeInteger(live.pid) && live.pid > 1); assert.match(live.invocation, /^[a-f0-9]{32}$/);
    assert.match(live.kernelStartTicks, /^\d+$/); assert.match(live.execMainStartTimestampMonotonic, /^\d+$/);
    assert.ok(path.isAbsolute(live.root)); assert.match(live.source, /^[a-f0-9]{40}$/);
    assert.ok(typeof live.version === 'string' && live.version && typeof live.build === 'string' && live.build);
  }
  return { reference, proof, baseline };
}
function assertRestoredContinuationScene(before) {
  validateScene(before, 'restored original continuation before summary');
  assert.equal(before.facts.effectsStarted, true, 'Historical maintenance effects remain recorded');
  assert.equal(before.facts.switchComplete, false);
  for (const name of ['pricing-pair-published.json', 'pricing-start-intent.json', 'full-schema-ready.json',
    'canvas-batch-schema-ready.json', 'raw-upload-recovery-published.json', 'guard-recovery-start-intent.json', 'guard-recovery-complete.json'])
    { assert.equal(Object.hasOwn(before.facts.files || {}, name), true, 'Restored continuation needs an explicit current marker observation: ' + name);
      assert.equal(Boolean(before.facts.files[name]), false, 'Restoration cannot admit an existing published/new-writer effect: ' + name); }
}

function applyEvent(state, event, hash) {
  assert.equal(event.schema, ATTEMPT_EVENT_SCHEMA); assert.equal(event.taskId, state.taskId);
  assert.equal(event.attemptId, state.attemptId); assert.equal(event.runId, state.runId);
  assert.equal(event.sequence, state.lastSequence + 1); assert.equal(event.previousSha256, state.lastEventSha256);
  validateOwner(event.owner);
  if (event.kind === 'attempt_started') {
    exactKeys(event, ['schema', 'taskId', 'attemptId', 'runId', 'sequence', 'previousSha256', 'at', 'atIso', 'owner', 'kind', 'window'], 'attempt started event');
    assert.equal(state.status, 'new'); assert.equal(event.sequence, 1); validateWindow(event.window, state.attemptId, state.runId, event.at, false);
    state.status = 'running'; state.owner = event.owner; state.currentWindow = event.window;
  } else if (event.kind === 'window_refreshed') {
    exactKeys(event, ['schema', 'taskId', 'attemptId', 'runId', 'sequence', 'previousSha256', 'at', 'atIso', 'owner', 'kind', 'window'], 'window refreshed event');
    assert.equal(state.status, 'running'); assert.equal(state.activePhase, null); assert.ok(ownerEqual(event.owner, state.owner));
    validateWindow(event.window, state.attemptId, state.runId, event.at, false); state.currentWindow = event.window;
  } else if (event.kind === 'owner_takeover') {
    exactKeys(event, ['schema', 'taskId', 'attemptId', 'runId', 'sequence', 'previousSha256', 'at', 'atIso', 'owner', 'kind',
      'previousOwner', 'previousLeaseSha256', 'window'], 'owner takeover event');
    assert.equal(state.status, 'running'); assert.ok(ownerEqual(event.previousOwner, state.owner));
    validateOwner(event.previousOwner); assert.match(event.previousLeaseSha256, HASH);
    state.owner = event.owner; validateWindow(event.window, state.attemptId, state.runId, event.at, false); state.currentWindow = event.window;
  } else if (event.kind === 'phase_intent') {
    exactKeys(event, ['schema', 'taskId', 'attemptId', 'runId', 'sequence', 'previousSha256', 'at', 'atIso', 'owner', 'kind',
      'phase', 'dependencyEventSha256', 'before'], 'phase intent event');
    assert.equal(state.status, 'running'); assert.equal(state.activePhase, null); assert.ok(ownerEqual(event.owner, state.owner));
    assert.match(event.phase, PHASE); assert.equal(event.dependencyEventSha256, state.lastEventSha256);
    if (state.guardBuildTail) {
      const tail = state.guardBuildTailRetry || state.guardBuildTail;
      if (tail.status === 'pending') assert.equal(event.phase, 'guard-build', 'The bound guard tail must finish before later phases');
      else assert.notEqual(event.phase, 'guard-build', 'A completed or failed guard tail cannot be replayed');
    }
    validateScene(event.before, 'phase before summary');
    state.activePhase = { phase: event.phase, intentSha256: hash, sequence: event.sequence };
  } else if (event.kind === 'phase_result') {
    exactKeys(event, ['schema', 'taskId', 'attemptId', 'runId', 'sequence', 'previousSha256', 'at', 'atIso', 'owner', 'kind',
      'phase', 'intentSha256', 'outcome', 'child', 'after'], 'phase result event');
    assert.equal(state.status, 'running'); assert.ok(ownerEqual(event.owner, state.owner)); assert.ok(state.activePhase);
    assert.equal(event.phase, state.activePhase.phase); assert.equal(event.intentSha256, state.activePhase.intentSha256);
    assert.ok(['succeeded', 'failed', 'interrupted', 'not_applicable'].includes(event.outcome)); validateChild(event.child);
    validateScene(event.after, 'phase after summary');
    state.lastPhase = { phase: event.phase, outcome: event.outcome, intentSha256: event.intentSha256, resultSha256: hash };
    if (state.guardBuildTail && event.phase === 'guard-build') {
      const key = state.guardBuildTailRetry ? 'guardBuildTailRetry' : 'guardBuildTail';
      assert.equal(state[key].status, 'pending');
      state[key] = { ...state[key], status: event.outcome === 'succeeded' ? 'completed' : 'failed', resultSha256: hash };
    }
    state.activePhase = null;
  } else if (event.kind === 'attempt_finished') {
    exactKeys(event, ['schema', 'taskId', 'attemptId', 'runId', 'sequence', 'previousSha256', 'at', 'atIso', 'owner', 'kind',
      'outcome', 'after'], 'attempt finished event');
    assert.equal(state.status, 'running'); assert.equal(state.activePhase, null); assert.ok(ownerEqual(event.owner, state.owner));
    assert.ok(TERMINAL.has(event.outcome)); validateScene(event.after, 'attempt after summary');
    state.status = event.outcome; state.terminal = { outcome: event.outcome, eventSha256: hash };
  } else if (event.kind === 'failure_continued') {
    exactKeys(event, ['schema', 'taskId', 'attemptId', 'runId', 'sequence', 'previousSha256', 'at', 'atIso', 'owner', 'kind',
      'previousTerminalSha256', 'failureReceiptSha256', 'window', 'before', ...(event.continuation === undefined ? [] : ['continuation'])], 'failed attempt continuation');
    assert.equal(state.status, 'failed'); assert.equal(state.activePhase, null);
    assert.equal(state.terminal.eventSha256, event.previousTerminalSha256);
    assert.equal(state.lastEventSha256, event.previousTerminalSha256); assert.match(event.failureReceiptSha256, HASH);
    validateWindow(event.window, state.attemptId, state.runId, event.at, false); validateScene(event.before, 'continuation before summary');
    assert.equal(event.before.facts.effectsStarted, false); assert.equal(event.before.facts.switchComplete, false);
    if (event.continuation !== undefined) {
      const retry = event.continuation.schema === 'sd2-release-guard-build-tail-retry-binding.v1';
      if (retry) assertGuardBuildTailRetryState(state, event.continuation); else {
        validateGuardBuildTailBinding(event.continuation); assert.equal(state.guardBuildTail, undefined);
      }
      assert.equal(state.lastPhase?.phase, 'guard-build');
      assert.equal(state.lastPhase?.outcome, 'failed'); assert.equal(event.continuation.proofSha256, event.failureReceiptSha256);
      state[retry ? 'guardBuildTailRetry' : 'guardBuildTail'] = { ...event.continuation, continuationEventSha256: hash,
        originalTerminalEventSha256: event.previousTerminalSha256, status: 'pending', resultSha256: null };
    }
    state.status = 'running'; state.terminal = null; state.owner = event.owner; state.currentWindow = event.window;
  } else if (event.kind === 'restored_original_continued') {
    exactKeys(event, ['schema', 'taskId', 'attemptId', 'runId', 'sequence', 'previousSha256', 'at', 'atIso', 'owner', 'kind',
      'previousTerminalSha256', 'failureReceiptSha256', 'window', 'before', 'restoration'], 'restored original continuation event');
    assert.equal(state.status, 'failed'); assert.equal(state.activePhase, null);
    assert.equal(state.terminal.eventSha256, event.previousTerminalSha256); assert.equal(state.lastEventSha256, event.previousTerminalSha256);
    assert.match(event.failureReceiptSha256, HASH); validateRestoredOriginalBinding(event.restoration);
    validateWindow(event.window, state.attemptId, state.runId, event.at, false); assertRestoredContinuationScene(event.before);
    const closure = state.restoredOriginalClosure; assert.ok(closure && closure.consumed === false, 'A restored original proof is consumed only once');
    assert.equal(event.restoration.closureProofFile, closure.proofFile); assert.equal(event.restoration.closureProofSha256, closure.proofSha256);
    assert.equal(event.restoration.phaseResultSha256, state.lastPhase.resultSha256);
    assert.equal(event.restoration.restoredBaselineSha256, closure.restoredBaselineSha256);
    restoredOriginalClosure({ schema: 'sd2-release-restored-original-closure-reference.v1', proofFile: closure.proofFile, proofSha256: closure.proofSha256 }, state);
    state.restoredOriginalClosure = { ...closure, consumed: true };
    state.restoredOriginalContinuation = { schema: 'sd2-release-restored-original-continuation-binding.v1',
      proofSha256: event.failureReceiptSha256, closureProofSha256: closure.proofSha256, eventSha256: hash };
    state.status = 'running'; state.terminal = null; state.owner = event.owner; state.currentWindow = event.window;
  } else if (event.kind === 'observation') {
    exactKeys(event, ['schema', 'taskId', 'attemptId', 'runId', 'sequence', 'previousSha256', 'at', 'atIso', 'owner', 'kind',
      'name', 'value'], 'observation event');
    assert.equal(state.status, 'running'); assert.ok(ownerEqual(event.owner, state.owner));
    assert.match(event.name, PHASE); safeJson(event.value, 'observation value', 128 * 1024);
    if (event.name === 'restored_original_closure') {
      assert.equal(state.restoredOriginalClosure, undefined, 'Only this single restored-original closure is permitted');
      assert.equal(state.activePhase, null); const { proof } = restoredOriginalClosure(event.value, state);
      state.restoredOriginalClosure = { proofFile: event.value.proofFile, proofSha256: event.value.proofSha256,
        phaseResultSha256: proof.failedPhaseResultSha256, restoredBaselineSha256: proof.restoredBaselineSha256, consumed: false };
    }

  } else assert.fail('Unknown attempt event kind');
  state.lastSequence = event.sequence; state.lastEventSha256 = hash; state.updatedAt = event.atIso;
  return state;
}

function validateHeader(header) {
  exactKeys(header, ['schema', 'taskId', 'attemptId', 'runId', 'createdAt', 'createdAtIso', 'engine', 'manifest', 'artifacts', 'window', 'before'], 'attempt header');
  assert.equal(header.schema, 'sd2-release-attempt.v1'); assert.match(header.taskId, TASK);
  assert.match(header.attemptId, UUID); assert.equal(header.runId, header.attemptId);
  assert.ok(Number.isSafeInteger(header.createdAt) && header.createdAt > 0); assert.equal(header.createdAtIso, iso(header.createdAt));
  validateEngine(header.engine); validateManifestIdentity(header.manifest); validateArtifacts(header.artifacts);
  validateWindow(header.window, header.attemptId, header.runId, header.createdAt, false); validateScene(header.before, 'attempt before summary');
  return header;
}

export function validateAttempt({ root, taskId, attemptId, allowStaleHead = false }) {
  const place = locations(root, taskId, attemptId);
  assert.equal(fs.realpathSync(place.attempt), place.attempt);
  const header = validateHeader(readJson(path.join(place.attempt, 'attempt.json')));
  assert.equal(header.taskId, taskId); assert.equal(header.attemptId, attemptId);
  let derived = initialDerived(header);
  const events = [];
  for (const [index, file] of eventFiles(place.events).entries()) {
    assert.equal(file, String(index + 1).padStart(6, '0') + '.json', 'Attempt journal has a gap or reordered file');
    const bytes = readBytes(path.join(place.events, file)), event = JSON.parse(bytes), hash = digest(bytes);
    assert.equal(event.atIso, iso(event.at)); derived = applyEvent(derived, event, hash); events.push({ file, sha256: hash, value: event });
  }
  assert.ok(events.length > 0 && events[0].value.kind === 'attempt_started');
  const stateFile = path.join(place.attempt, 'state.json'), stateBytes = readBytes(stateFile), state = JSON.parse(stateBytes);
  const headCurrent = JSON.stringify(state) === JSON.stringify(derived);
  if (!allowStaleHead) assert.equal(headCurrent, true, 'Attempt state head differs from its immutable journal');
  return { place, header, state, stateSha256: digest(stateBytes), derivedState: derived, headCurrent, events };
}

export const readAttempt = validateAttempt;

function validateLease(value, taskId, attemptId) {
  exactKeys(value, ['schema', 'taskId', 'attemptId', 'owner'], 'attempt owner lease');
  assert.equal(value.schema, 'sd2-release-attempt-owner.v1'); assert.equal(value.taskId, taskId); assert.equal(value.attemptId, attemptId);
  validateOwner(value.owner); return value;
}

function ownerLeaseFile(place) { return path.join(place.attempt, 'owner.lock'); }

function assertLease(place, owner) {
  const file = ownerLeaseFile(place);
  if (!fs.existsSync(file)) fail('evidence_missing', 'attempt_owner_lease_missing', 'attempt', path.basename(place.attempt),
    'The active attempt has no durable controller-owner lease.', 'Recover the exact owner lease or stop the attempt; do not infer ownership.');
  const bytes = readBytes(file, 16384), lease = validateLease(JSON.parse(bytes), path.basename(place.task), path.basename(place.attempt));
  if (!ownerEqual(lease.owner, owner)) fail('busy_retryable', 'attempt_owned_by_other_controller', 'attempt', path.basename(place.attempt),
    'Another controller token owns this attempt.', 'Wait for that exact owner or perform an explicit dead-owner takeover with matching lease evidence.');
  return { file, bytes, sha256: digest(bytes), lease };
}

function appendEvent(loaded, owner, body, now) {
  assertLease(loaded.place, owner);
  assert.equal(loaded.headCurrent, true, 'Repair the durable head before appending another event');
  assert.equal(loaded.derivedState.status, 'running');
  const sequence = loaded.derivedState.lastSequence + 1;
  assert.ok(sequence <= 999999, 'Attempt journal reached its fixed event bound');
  const event = { schema: ATTEMPT_EVENT_SCHEMA, taskId: loaded.header.taskId, attemptId: loaded.header.attemptId,
    runId: loaded.header.runId, sequence, previousSha256: loaded.derivedState.lastEventSha256,
    at: now, atIso: iso(now), owner, ...body };
  const file = path.join(loaded.place.events, String(sequence).padStart(6, '0') + '.json');
  if (event.kind === 'observation' && event.name === 'restored_original_closure')
    applyEvent(structuredClone(loaded.derivedState), event, digest(Buffer.from(JSON.stringify(event, null, 2) + '\n')));
  const hash = writeExclusiveJson(file, event), next = applyEvent(structuredClone(loaded.derivedState), event, hash);
  writeCasJson(path.join(loaded.place.attempt, 'state.json'), next, loaded.stateSha256);
  return { event, eventSha256: hash, state: next };
}

function taskLock(task, owner, takeover, inspectOwner) {
  const file = path.join(task, 'task.mutation.lock');
  if (fs.existsSync(file)) {
    const bytes = readBytes(file, 16384), prior = JSON.parse(bytes), priorSha = digest(bytes);
    exactKeys(prior, ['schema', 'owner'], 'task mutation lease'); assert.equal(prior.schema, 'sd2-release-task-mutation.v1'); validateOwner(prior.owner);
    if (!takeover || takeover.leaseSha256 !== priorSha) fail('busy_retryable', 'task_mutation_owned', 'task', path.basename(task),
      'The task mutation lease is already owned.', 'Wait for the owner or provide exact dead-owner takeover evidence.');
    const status = inspectOwner(prior.owner);
    if (status === 'alive') fail('busy_retryable', 'task_mutation_owner_alive', 'task', path.basename(task),
      'The prior task mutator is still alive.', 'Wait for the active owner; do not start a competing attempt.');
    if (status !== 'dead') fail('evidence_missing', 'task_mutation_owner_unknown', 'task', path.basename(task),
      'The prior task mutator cannot be proven dead.', 'Obtain authoritative host/process evidence before takeover.');
    const preserved = `${file}.dead-${priorSha}.json`;
    assert.equal(fs.existsSync(preserved), false); fs.renameSync(file, preserved); syncDirectory(task);
  }
  const lease = { schema: 'sd2-release-task-mutation.v1', owner };
  const sha256 = writeExclusiveJson(file, lease);
  return { file, sha256, release() {
    const bytes = readBytes(file, 16384); assert.equal(digest(bytes), sha256); assert.ok(ownerEqual(JSON.parse(bytes).owner, owner));
    fs.unlinkSync(file); syncDirectory(task);
  } };
}

export function createAttemptIdentity(taskId) {
  assert.match(taskId, TASK); const attemptId = randomUUID(); return { taskId, attemptId, runId: attemptId };
}

export function startAttempt({ root, taskId, attemptId, runId, owner, engine, manifest, artifacts, window, before,
  now = Date.now(), inspectOwner = inspectControllerOwner, taskLockTakeover = null }) {
  assert.match(taskId, TASK); assert.match(attemptId, UUID); assert.equal(runId, attemptId); validateOwner(owner);
  validateEngine(engine); validateManifestIdentity(manifest); validateArtifacts(artifacts);
  validateWindow(window, attemptId, runId, now, true); validateScene(before, 'attempt before summary');
  const place = locations(root, taskId, attemptId);
  if (!fs.existsSync(place.task)) mkdirExclusive(place.task);
  if (!fs.existsSync(place.attempts)) mkdirExclusive(place.attempts);
  const lock = taskLock(place.task, owner, taskLockTakeover, inspectOwner);
  try {
    const taskFile = path.join(place.task, 'task.json'); let prior = null, priorTaskState = null, priorSha = null;
    if (fs.existsSync(taskFile)) {
      const bytes = readBytes(taskFile), value = JSON.parse(bytes); priorSha = digest(bytes);
      exactKeys(value, ['schema', 'taskId', 'sequence', 'latestAttemptId', 'previousSha256'], 'task state');
      assert.equal(value.schema, TASK_STATE_SCHEMA); assert.equal(value.taskId, taskId); assert.match(value.latestAttemptId, UUID);
      assert.ok(Number.isSafeInteger(value.sequence) && value.sequence > 0);
      if (value.sequence === 1) assert.equal(value.previousSha256, null); else assert.match(value.previousSha256, HASH);
      priorTaskState = value;
      prior = validateAttempt({ root, taskId, attemptId: value.latestAttemptId });
      if (!TERMINAL.has(prior.derivedState.status)) {
        const ownerStatus = fs.existsSync(ownerLeaseFile(prior.place)) ? inspectOwner(validateLease(JSON.parse(readBytes(ownerLeaseFile(prior.place))), taskId, value.latestAttemptId).owner) : 'unknown';
        if (ownerStatus === 'alive') fail('busy_retryable', 'previous_attempt_active', 'attempt', value.latestAttemptId,
          'The latest attempt still has a live controller.', 'Finish or stop the latest attempt before creating another attempt.');
        fail('evidence_missing', 'previous_attempt_not_terminal', 'attempt', value.latestAttemptId,
          'The latest attempt is not terminal and its safe owner outcome is not resolved.', 'Take over the same attempt with exact dead-owner evidence, then finish or recover it before starting a new attempt.');
      }
    }
    assert.equal(fs.existsSync(place.attempt), false, 'Attempt identifiers are immutable and cannot be reused');
    mkdirExclusive(place.attempt); mkdirExclusive(place.events);
    const header = { schema: 'sd2-release-attempt.v1', taskId, attemptId, runId, createdAt: now, createdAtIso: iso(now),
      engine, manifest, artifacts, window, before };
    writeExclusiveJson(path.join(place.attempt, 'attempt.json'), header);
    writeExclusiveJson(ownerLeaseFile(place), { schema: 'sd2-release-attempt-owner.v1', taskId, attemptId, owner });
    const started = { schema: ATTEMPT_EVENT_SCHEMA, taskId, attemptId, runId, sequence: 1, previousSha256: null,
      at: now, atIso: iso(now), owner, kind: 'attempt_started', window };
    const eventSha256 = writeExclusiveJson(path.join(place.events, '000001.json'), started);
    const state = applyEvent(initialDerived(header), started, eventSha256);
    writeExclusiveJson(path.join(place.attempt, 'state.json'), state);
    const taskState = { schema: TASK_STATE_SCHEMA, taskId, sequence: (priorTaskState?.sequence || 0) + 1,
      latestAttemptId: attemptId, previousSha256: priorSha };
    writeCasJson(taskFile, taskState, priorSha);
    return validateAttempt({ root, taskId, attemptId });
  } finally { lock.release(); }
}

export function refreshAttemptWindow({ root, taskId, attemptId, owner, window, now = Date.now() }) {
  const loaded = validateAttempt({ root, taskId, attemptId });
  assert.equal(loaded.derivedState.activePhase, null, 'A window cannot be replaced during an active phase');
  validateWindow(window, attemptId, loaded.header.runId, now, true);
  return appendEvent(loaded, owner, { kind: 'window_refreshed', window }, now);
}

export function startPhase({ root, taskId, attemptId, owner, phase, dependencyEventSha256, before, now = Date.now() }) {
  assert.match(phase, PHASE); assert.match(dependencyEventSha256, HASH); validateScene(before, 'phase before summary');
  const loaded = validateAttempt({ root, taskId, attemptId });
  // Reject an unauthorized tail transition before an immutable event is written.
  if (loaded.derivedState.guardBuildTail) {
    const tail = loaded.derivedState.guardBuildTailRetry || loaded.derivedState.guardBuildTail;
    if (tail.status === 'pending') assert.equal(phase, 'guard-build');
    else assert.notEqual(phase, 'guard-build');
  }
  validateWindow(loaded.derivedState.currentWindow, attemptId, loaded.header.runId, now, true);
  if (loaded.derivedState.lastEventSha256 !== dependencyEventSha256) fail('evidence_missing', 'phase_dependency_changed', 'phase', phase,
    'The attempt advanced after this phase dependency was captured.', 'Reload the attempt and decide from the new durable state; do not append a late intent.');
  return appendEvent(loaded, owner, { kind: 'phase_intent', phase, dependencyEventSha256, before }, now);
}

export function finishPhase({ root, taskId, attemptId, owner, phase, intentSha256, outcome, child, after, now = Date.now() }) {
  assert.match(phase, PHASE); assert.match(intentSha256, HASH); validateChild(child); validateScene(after, 'phase after summary');
  assert.ok(['succeeded', 'failed', 'interrupted', 'not_applicable'].includes(outcome));
  if (outcome === 'succeeded') assert.ok(child && child.status === 0 && child.signal === null && child.error === null,
    'Successful phase must preserve an original zero child exit');
  const loaded = validateAttempt({ root, taskId, attemptId });
  if (!loaded.derivedState.activePhase || loaded.derivedState.activePhase.intentSha256 !== intentSha256)
    fail('evidence_missing', 'late_or_unknown_phase_result', 'phase', phase,
      'The result does not match the currently active immutable phase intent.',
      'Preserve the late receipt outside state; never overwrite an existing result or apply it to a newer phase.');
  return appendEvent(loaded, owner, { kind: 'phase_result', phase, intentSha256, outcome, child, after }, now);
}

export function recordAttemptEvent({ root, taskId, attemptId, owner, name, value, now = Date.now() }) {
  assert.match(name, PHASE); safeJson(value, 'observation value', 128 * 1024);
  const loaded = validateAttempt({ root, taskId, attemptId });
  if (name === 'artifact_capsule') {
    validateArtifacts(value);
    assert.equal(value.main.schema, 'sd2-release-artifact-identity.v1', 'Artifact capsule must contain real completed-build identities');
    assert.equal(loaded.header.artifacts.main.schema, 'sd2-release-artifact-input.v1',
      'Only an input-bound build attempt may record its completed artifact capsule');
    assert.equal(loaded.derivedState.lastPhase?.outcome, 'succeeded',
      'Artifact capsule requires a preceding successful phase result');
    if (loaded.events.some(item => item.value.kind === 'observation' && item.value.name === 'artifact_capsule'))
      fail('input_permanent', 'artifact_capsule_already_recorded', 'attempt', attemptId,
        'This attempt already has an immutable completed-artifact capsule.',
        'Read and use the existing capsule; never overwrite it or append a competing build identity.');
    const projection = pair => Object.fromEntries(['main', 'guard'].map(kind => [kind, {
      kind, source: pair[kind].source, version: pair[kind].version, sourceManifestSha256: pair[kind].sourceManifestSha256,
    }]));
    assertBindingEqual(projection(value), projection(loaded.header.artifacts), 'artifact_capsule_source_drift',
      'Completed artifact source identity', attemptId);
  }
  return appendEvent(loaded, owner, { kind: 'observation', name, value }, now);
}

export function finishAttempt({ root, taskId, attemptId, owner, outcome, after, now = Date.now() }) {
  assert.ok(TERMINAL.has(outcome)); validateScene(after, 'attempt after summary');
  const loaded = validateAttempt({ root, taskId, attemptId });
  assert.equal(loaded.derivedState.activePhase, null, 'An attempt cannot finish while a phase is unresolved');
  const result = appendEvent(loaded, owner, { kind: 'attempt_finished', outcome, after }, now);
  const lease = assertLease(loaded.place, owner), archived = path.join(loaded.place.attempt, `owner-final-${lease.sha256}.json`);
  assert.equal(fs.existsSync(archived), false); fs.renameSync(lease.file, archived); syncDirectory(loaded.place.attempt);
  return result;
}

export function takeoverAttempt({ root, taskId, attemptId, owner, priorLeaseSha256, engine, manifest, artifacts, window,
  now = Date.now(), inspectOwner = inspectControllerOwner }) {
  validateOwner(owner); assert.match(priorLeaseSha256, HASH); validateEngine(engine); validateManifestIdentity(manifest);
  validateArtifacts(artifacts); validateWindow(window, attemptId, attemptId, now, true);
  const loaded = validateAttempt({ root, taskId, attemptId, allowStaleHead: true });
  assert.equal(loaded.derivedState.status, 'running');
  assertBindingEqual(engine, loaded.header.engine, 'attempt_engine_drift', 'Engine identity', attemptId);
  assertBindingEqual(manifest, loaded.header.manifest, 'attempt_manifest_drift', 'Manifest identity', attemptId);
  assertBindingEqual(artifacts, loaded.header.artifacts, 'attempt_artifact_drift', 'Artifact identity', attemptId);
  const oldFile = ownerLeaseFile(loaded.place);
  if (!fs.existsSync(oldFile)) fail('evidence_missing', 'takeover_owner_lease_missing', 'attempt', attemptId,
    'The prior controller lease is missing.', 'Recover the exact lease; do not invent an owner or original exit.');
  const oldBytes = readBytes(oldFile, 16384), oldSha = digest(oldBytes), oldLease = validateLease(JSON.parse(oldBytes), taskId, attemptId);
  assert.equal(oldSha, priorLeaseSha256, 'Dead-owner takeover lease CAS mismatch');
  const status = inspectOwner(oldLease.owner);
  if (status === 'alive') fail('busy_retryable', 'takeover_owner_alive', 'attempt', attemptId,
    'The prior controller process is still alive.', 'Wait for it or stop it through the reviewed controller path; do not take over.');
  if (status !== 'dead') fail('evidence_missing', 'takeover_owner_unknown', 'attempt', attemptId,
    'The prior controller identity cannot be proven dead.', 'Obtain host and kernel start-token evidence before takeover.');
  const archived = `${oldFile}.dead-${oldSha}.json`; assert.equal(fs.existsSync(archived), false);
  fs.renameSync(oldFile, archived); syncDirectory(loaded.place.attempt);
  writeExclusiveJson(oldFile, { schema: 'sd2-release-attempt-owner.v1', taskId, attemptId, owner });
  let stateSha = loaded.stateSha256;
  if (!loaded.headCurrent) {
    stateSha = writeCasJson(path.join(loaded.place.attempt, 'state.json'), loaded.derivedState, loaded.stateSha256);
  }
  const current = validateAttempt({ root, taskId, attemptId });
  assert.equal(current.stateSha256, stateSha);
  const sequence = current.derivedState.lastSequence + 1;
  assert.ok(sequence <= 999999, 'Attempt journal reached its fixed event bound');
  const event = { schema: ATTEMPT_EVENT_SCHEMA, taskId, attemptId, runId: current.header.runId, sequence,
    previousSha256: current.derivedState.lastEventSha256, at: now, atIso: iso(now), owner, kind: 'owner_takeover',
    previousOwner: oldLease.owner, previousLeaseSha256: oldSha, window };
  const eventSha256 = writeExclusiveJson(path.join(current.place.events, String(sequence).padStart(6, '0') + '.json'), event);
  const next = applyEvent(structuredClone(current.derivedState), event, eventSha256);
  writeCasJson(path.join(current.place.attempt, 'state.json'), next, current.stateSha256);
  return { event, eventSha256, state: next, archivedLease: archived };
}

export function validateGuardBuildTailBinding(value) {
  exactKeys(value, ['schema', 'phase', 'proofSha256', 'processorControllerSetSha256'], 'guard build-tail binding');
  assert.equal(value.schema, 'sd2-release-guard-build-tail-binding.v1'); assert.equal(value.phase, 'guard-build');
  assert.match(value.proofSha256, HASH); assert.match(value.processorControllerSetSha256, HASH); return value;
}

export function validateGuardBuildTailRetryBinding(value) {
  exactKeys(value, ['schema', 'phase', 'proofSha256', 'processorControllerSetSha256', 'originalContinuationSha256',
    'originalFailureResultSha256'], 'guard build-tail single retry');
  assert.equal(value.schema, 'sd2-release-guard-build-tail-retry-binding.v1'); assert.equal(value.phase, 'guard-build');
  for (const key of ['proofSha256', 'processorControllerSetSha256', 'originalContinuationSha256', 'originalFailureResultSha256']) assert.match(value[key], HASH);
  return value;
}

function assertGuardBuildTailRetryState(state, value) {
  validateGuardBuildTailRetryBinding(value);
  assert.equal(state.guardBuildTailRetry, undefined, 'Only one failed-tail postcheck retry is authorized');
  assert.equal(state.guardBuildTail?.status, 'failed');
  assert.equal(state.guardBuildTail.proofSha256, value.originalContinuationSha256);
  assert.equal(state.guardBuildTail.resultSha256, value.originalFailureResultSha256);
  assert.equal(state.lastPhase?.resultSha256, value.originalFailureResultSha256);
}

export function continueFailedAttempt({ root, taskId, attemptId, owner, engine, manifest, artifacts, window,
  terminalEventSha256, failureReceiptSha256, before, continuation, now = Date.now(), inspectOwner = inspectControllerOwner }) {
  const loaded = validateAttempt({ root, taskId, attemptId }); validateOwner(owner);
  assertAttemptBindings(loaded, { engine, manifest, artifacts });
  assert.equal(loaded.derivedState.status, 'failed'); assert.equal(loaded.derivedState.activePhase, null);
  assert.equal(loaded.derivedState.lastEventSha256, terminalEventSha256);
  assert.equal(loaded.derivedState.terminal.eventSha256, terminalEventSha256);
  validateWindow(window, attemptId, attemptId, now, true); validateScene(before, 'continuation before summary');
  assert.equal(before.facts.effectsStarted, false); assert.equal(before.facts.switchComplete, false);
  assert.match(failureReceiptSha256, HASH);
  if (continuation !== undefined) {
    if (continuation.schema === 'sd2-release-guard-build-tail-retry-binding.v1') assertGuardBuildTailRetryState(loaded.derivedState, continuation);
    else { validateGuardBuildTailBinding(continuation); assert.equal(loaded.derivedState.guardBuildTail, undefined); }
    assert.equal(continuation.proofSha256, failureReceiptSha256); assert.equal(loaded.derivedState.lastPhase?.phase, 'guard-build');
    assert.equal(loaded.derivedState.lastPhase?.outcome, 'failed'); assert.notEqual(continuation.processorControllerSetSha256, engine.sha256);
  }
  const task = readJson(path.join(loaded.place.task, 'task.json'));
  assert.equal(task.latestAttemptId, attemptId, 'A superseded attempt cannot be continued');
  assert.equal(fs.existsSync(ownerLeaseFile(loaded.place)), false);
  const priorOwner = loaded.derivedState.owner;
  assert.equal(inspectOwner(priorOwner), 'dead', 'Original failed controller must be proven dead');
  const priorLease = fs.readdirSync(loaded.place.attempt).filter(name => /^owner-final-[a-f0-9]{64}\.json$/.test(name))
    .map(name => ({ name, bytes: readBytes(path.join(loaded.place.attempt, name), 16384) }))
    .find(item => ownerEqual(validateLease(JSON.parse(item.bytes), taskId, attemptId).owner, priorOwner));
  assert.ok(priorLease, 'Original terminal owner lease is missing');
  assert.equal(priorLease.name, 'owner-final-' + digest(priorLease.bytes) + '.json');
  writeExclusiveJson(ownerLeaseFile(loaded.place), { schema: 'sd2-release-attempt-owner.v1', taskId, attemptId, owner });
  const sequence = loaded.derivedState.lastSequence + 1; assert.ok(sequence <= 999999);
  const event = { schema: ATTEMPT_EVENT_SCHEMA, taskId, attemptId, runId: attemptId, sequence,
    previousSha256: terminalEventSha256, at: now, atIso: iso(now), owner, kind: 'failure_continued',
    previousTerminalSha256: terminalEventSha256, failureReceiptSha256, window, before,
    ...(continuation === undefined ? {} : { continuation }) };
  const eventSha256 = writeExclusiveJson(path.join(loaded.place.events, String(sequence).padStart(6, '0') + '.json'), event);
  const next = applyEvent(structuredClone(loaded.derivedState), event, eventSha256);
  writeCasJson(path.join(loaded.place.attempt, 'state.json'), next, loaded.stateSha256);
  return { event, eventSha256, state: next };
}

export function continueRestoredOriginalAttempt({ root, taskId, attemptId, owner, engine, manifest, artifacts, window,
  terminalEventSha256, failureReceiptSha256, before, restoration, now = Date.now(), inspectOwner = inspectControllerOwner }) {
  const loaded = validateAttempt({ root, taskId, attemptId }); validateOwner(owner);
  assertAttemptBindings(loaded, { engine, manifest, artifacts });
  assert.equal(loaded.derivedState.status, 'failed'); assert.equal(loaded.derivedState.activePhase, null);
  assert.equal(loaded.derivedState.lastEventSha256, terminalEventSha256);
  assert.equal(loaded.derivedState.terminal.eventSha256, terminalEventSha256);
  validateWindow(window, attemptId, attemptId, now, true); validateScene(before, 'continuation before summary');
  assertRestoredContinuationScene(before); validateRestoredOriginalBinding(restoration);
  const closure = loaded.derivedState.restoredOriginalClosure; assert.ok(closure && closure.consumed === false);
  assert.equal(restoration.closureProofFile, closure.proofFile); assert.equal(restoration.closureProofSha256, closure.proofSha256);
  assert.equal(restoration.phaseResultSha256, loaded.derivedState.lastPhase.resultSha256);
  assert.equal(restoration.restoredBaselineSha256, closure.restoredBaselineSha256);
  restoredOriginalClosure({ schema: 'sd2-release-restored-original-closure-reference.v1', proofFile: closure.proofFile, proofSha256: closure.proofSha256 }, loaded.derivedState);
  assert.match(failureReceiptSha256, HASH);
  const task = readJson(path.join(loaded.place.task, 'task.json'));
  assert.equal(task.latestAttemptId, attemptId, 'A superseded attempt cannot be continued');
  assert.equal(fs.existsSync(ownerLeaseFile(loaded.place)), false);
  const priorOwner = loaded.derivedState.owner;
  assert.equal(inspectOwner(priorOwner), 'dead', 'Original failed controller must be proven dead');
  const priorLease = fs.readdirSync(loaded.place.attempt).filter(name => /^owner-final-[a-f0-9]{64}\.json$/.test(name))
    .map(name => ({ name, bytes: readBytes(path.join(loaded.place.attempt, name), 16384) }))
    .find(item => ownerEqual(validateLease(JSON.parse(item.bytes), taskId, attemptId).owner, priorOwner));
  assert.ok(priorLease, 'Original terminal owner lease is missing');
  assert.equal(priorLease.name, 'owner-final-' + digest(priorLease.bytes) + '.json');
  writeExclusiveJson(ownerLeaseFile(loaded.place), { schema: 'sd2-release-attempt-owner.v1', taskId, attemptId, owner });
  const sequence = loaded.derivedState.lastSequence + 1; assert.ok(sequence <= 999999);
  const event = { schema: ATTEMPT_EVENT_SCHEMA, taskId, attemptId, runId: attemptId, sequence,
    previousSha256: terminalEventSha256, at: now, atIso: iso(now), owner, kind: 'restored_original_continued',
    previousTerminalSha256: terminalEventSha256, failureReceiptSha256, window, before,
    restoration };
  const eventSha256 = writeExclusiveJson(path.join(loaded.place.events, String(sequence).padStart(6, '0') + '.json'), event);
  const next = applyEvent(structuredClone(loaded.derivedState), event, eventSha256);
  writeCasJson(path.join(loaded.place.attempt, 'state.json'), next, loaded.stateSha256);
  return { event, eventSha256, state: next };
}

export function assertAttemptBindings(loaded, { engine, manifest, artifacts }) {
  assertBindingEqual(validateEngine(engine), loaded.header.engine, 'attempt_engine_drift', 'Engine identity', loaded.header.attemptId);
  assertBindingEqual(validateManifestIdentity(manifest), loaded.header.manifest, 'attempt_manifest_drift', 'Manifest identity', loaded.header.attemptId);
  assertBindingEqual(validateArtifacts(artifacts), loaded.header.artifacts, 'attempt_artifact_drift', 'Artifact identity', loaded.header.attemptId);
  return true;
}

export function isReservedAttemptEvent(kind) { return RESERVED_EVENTS.has(kind); }
