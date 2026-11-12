import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ENGINE_VERSION } from './engine-version.mjs';
import { digest, SEAMLESS_CONTROL } from './seamless-policy.mjs';
import { createNativeSeamlessDriver, prepareSeamlessPlan, rootBytes, writeExclusive, processIdentity } from './seamless-web.mjs';

export const SEAMLESS_STEPS = Object.freeze(['preflight', 'prepare', 'cutToCandidate', 'drainOriginal',
  'publishCanonical', 'startCanonical', 'cutToCanonical', 'retireCandidate']);

// Actual order is shared by production and offline engineering fixtures.
// Every native operation is idempotent/CAS checked; write intent before effects.
export async function runSeamlessDelivery(driver, store) {
  let state = store.read() || { schema: 'sd2-seamless-state.v1', runId: driver.plan.runId,
    completed: [], status: 'running', databaseRestored: false };
  assert.equal(state.runId, driver.plan.runId); assert.equal(state.schema, 'sd2-seamless-state.v1');
  assert.deepEqual(state.completed, SEAMLESS_STEPS.slice(0, state.completed.length));
  if (state.status === 'recovered') return state;
  for (const step of SEAMLESS_STEPS.slice(state.completed.length)) {
    state = { ...state, status: 'running', activeStep: step }; store.write(state);
    try {
      const result = await driver[step]();
      state = { ...state, completed: [...state.completed, step], activeStep: null,
        status: step === 'retireCandidate' ? 'complete' : 'running', lastResult: result };
      store.write(state);
    } catch (error) {
      const live = await driver.publicHealthy();
      // Long requests are a pending retirement, never permission to kill them.
      // An available public target remains serving even if this controller exits.
      state = { ...state, status: error.code === 'SEAMLESS_PENDING' && live ? 'pending' : 'failed',
        activeStep: step, error: String(error.message || error), publicHealthy: live, databaseRestored: false };
      store.write(state);
      if (!live && state.completed.includes('prepare')) {
        try { state = { ...state, status: 'recovered', recovery: await driver.recoverGuard() }; store.write(state); }
        catch (recovery) { state = { ...state, recoveryError: String(recovery.message || recovery) }; store.write(state); }
      }
      return state;
    }
  }
  return state;
}

function assertInstalledSelf() {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  const here = path.dirname(fileURLToPath(import.meta.url));
  assert.equal(fs.realpathSync(here), here);
  const prefix = '/data/video-api-debugger/release-engines/' + ENGINE_VERSION + '-';
  assert.ok(here.startsWith(prefix) && /^[a-f0-9]{64}$/.test(here.slice(prefix.length)), 'Use the frozen installed engine');
  const s = fs.lstatSync(here); assert.equal(s.uid, 0); assert.equal(s.mode & 0o077, 0);
  const hashes = Object.fromEntries(fs.readdirSync(here).filter(n => n.endsWith('.mjs')).sort().map(n => [n, digest(rootBytes(here + '/' + n))]));
  assert.equal(digest(JSON.stringify(hashes)), here.slice(prefix.length));
}

export function prepareSeamless(capsuleFile) { assertInstalledSelf(); return prepareSeamlessPlan(capsuleFile); }
export function seamlessStatus(planFile) {
  assertInstalledSelf(); const plan = JSON.parse(rootBytes(planFile));
  const file = plan.stage + '/seamless-state.json';
  return fs.existsSync(file) ? JSON.parse(rootBytes(file)) : { schema: 'sd2-seamless-state.v1', runId: plan.runId, status: 'prepared', completed: [] };
}
export async function releaseSeamless(planFile, { resume = false } = {}) {
  assertInstalledSelf(); const driver = createNativeSeamlessDriver(planFile), p = driver.plan;
  const gid = fs.statSync('/data/video-api-debugger/controls/pricing-writer-v1/writer-start-guard.mjs').gid;
  if (!fs.existsSync(SEAMLESS_CONTROL)) { fs.mkdirSync(SEAMLESS_CONTROL, { mode: 0o750 }); fs.chownSync(SEAMLESS_CONTROL, 0, gid); }
  const activeFile = SEAMLESS_CONTROL + '/active.json', lockFile = SEAMLESS_CONTROL + '/controller.json';
  const reference = { runId: p.runId, planFile, planSha256: digest(rootBytes(planFile)) };
  if (fs.existsSync(activeFile)) assert.deepEqual(JSON.parse(rootBytes(activeFile)), reference, 'Another delivery is still active');
  else writeExclusive(activeFile, JSON.stringify(reference) + '\n');
  if (fs.existsSync(lockFile)) {
    assert.equal(resume, true, 'Use resume-release for an interrupted controller');
    const old = JSON.parse(rootBytes(lockFile)); assert.equal(old.host, os.hostname()); assert.equal(old.runId, p.runId);
    let live = false;
    try { live = processIdentity(old.pid).startTicks === old.startTicks; }
    catch (e) { if (!['ENOENT', 'ESRCH'].includes(e.code)) throw e; }
    assert.equal(live, false, 'Original controller is still alive');
    fs.unlinkSync(lockFile);
  }
  const owner = { runId: p.runId, host: os.hostname(), pid: process.pid, startTicks: processIdentity(process.pid).startTicks, token: randomUUID() };
  writeExclusive(lockFile, JSON.stringify(owner) + '\n');
  const stateFile = p.stage + '/seamless-state.json';
  const store = { read: () => fs.existsSync(stateFile) ? JSON.parse(rootBytes(stateFile)) : null,
    write: value => {
      const temporary = stateFile + '.' + owner.token; writeExclusive(temporary, JSON.stringify(value, null, 2) + '\n');
      fs.renameSync(temporary, stateFile);
      const d = fs.openSync(p.stage, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
    } };
  try {
    const state = await runSeamlessDelivery(driver, store);
    if (state.status === 'complete' || state.completed.length === 0 && state.activeStep === 'preflight') {
      assert.deepEqual(JSON.parse(rootBytes(activeFile)), reference); fs.unlinkSync(activeFile);
    }
    return state;
  } finally { assert.deepEqual(JSON.parse(rootBytes(lockFile)), owner); fs.unlinkSync(lockFile); }
}
