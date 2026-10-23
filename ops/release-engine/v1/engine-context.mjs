import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ENGINE_VERSION } from './engine-version.mjs';

const CONTEXT = Symbol.for('sd2.release-engine.context.v1');
const BOUNDARY_RECORDER = Symbol.for('sd2.release-engine.boundary-recorder.v1');
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[a-f0-9]{12}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function configureReleaseContext(value) {
  assert.equal(globalThis[CONTEXT], undefined, 'Release context cannot be replaced in a running process');
  assert.equal(value?.schema, 'sd2-release-context.v1');
  assert.ok(value.contract && typeof value.contract === 'object' && !Array.isArray(value.contract));
  globalThis[CONTEXT] = freeze(structuredClone(value));
  return globalThis[CONTEXT];
}
export const currentReleaseContext = () => globalThis[CONTEXT] || null;
export function configureBoundaryRecorder(recorder) {
  assert.equal(globalThis[BOUNDARY_RECORDER], undefined, 'A live attempt recorder cannot be replaced');
  assert.equal(typeof recorder, 'function'); globalThis[BOUNDARY_RECORDER] = recorder;
}
export async function releaseBoundary(m, name, edge, facts = {}) {
  if (!isSharedEngine(m)) return;
  assertSharedEngineContext(m);
  assert.ok(['preparation', 'drain', 'publish', 'health', 'reopen'].includes(name));
  assert.ok(['intent', 'result'].includes(edge));
  const recorder = globalThis[BOUNDARY_RECORDER];
  assert.equal(typeof recorder, 'function', 'Shared effects require the durable owning-attempt recorder');
  return recorder({ schema: 'sd2-release-boundary.v1', taskId: m.operation.taskId,
    attemptId: m.operation.attemptId, runId: m.runId, engine: m.engine,
    name, edge, observedAt: new Date().toISOString(), facts });
}
export const isSharedEngine = m => m?.engine?.schema === 'sd2-release-engine.v1';
export function assertSharedEngineContext(m) {
  assert.equal(isSharedEngine(m), true);
  assert.equal(m.engine.version, ENGINE_VERSION);
  assert.match(m.engine.controllerSetSha256 || '', HASH);
  assert.equal(m.engine.controllerSetSha256, digest(JSON.stringify(m.privateSha256)));
  assert.equal(m.engine.root, m.projectRoot + '/release-engines/' + ENGINE_VERSION + '-' + m.engine.controllerSetSha256);
  assert.equal(path.resolve(m.engine.root), m.engine.root);
  assert.equal(m.operation?.schema, 'sd2-release-operation.v1');
  assert.match(m.operation.taskId || '', UUID);
  assert.equal(m.operation.attemptId, m.runId);
  assert.equal(m.stage, m.projectRoot + '/release-staging/' + m.operation.attemptId);
  assert.equal(m.operation.taskRoot, m.projectRoot + '/release-tasks/' + m.operation.taskId);
  return m.engine;
}
export function engineDirectory(m) {
  if (!isSharedEngine(m)) return m.stage + '/fix01-release';
  return assertSharedEngineContext(m).root;
}
