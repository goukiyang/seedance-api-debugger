import assert from 'node:assert/strict';

export const oldEarly = "  assert.equal(exists('/data/video-api-debugger/controls/raw-upload-recovery-v1.json'), false);";
export const newEarly = "  inspectRecoveryCertificate(m, before, { phase: 'early-original' });";
export const oldObserve = `      const certificateFile = '/data/video-api-debugger/controls/raw-upload-recovery-v1.json';
      if (exists(certificateFile)) {
        const certificate = json(certificateFile); assert.equal(certificate.runId, m.runId);
        assert.equal(certificate.guardSource, m.guardSource); assert.equal(verified.originalPair, false);
      }`;
export const newObserve = `      const certificateState = inspectRecoveryCertificate(m, before);
      if (certificateState.createdByThisRun) assert.equal(verified.originalPair, false);`;
export const oldState = 'return { certificate: exists(certificateFile), startIntent: intent, originalPair: verified.originalPair,';
export const newState = 'return { certificate: certificateState.createdByThisRun, startIntent: intent, originalPair: verified.originalPair,';

export function patchSwitch(source) {
  let result = source;
  for (const [from, to] of [[oldEarly, newEarly], [oldObserve, newObserve], [oldState, newState]]) {
    assert.equal(result.split(from).length, 2, 'Patch must match exactly one reviewed original fragment');
    result = result.replace(from, to);
  }
  return "import { inspectRecoveryCertificate } from './certificate.mjs';\n" + result;
}
