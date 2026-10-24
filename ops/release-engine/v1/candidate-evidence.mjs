import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isSharedEngine, engineDirectory, rootFile, sha, call } from './common.mjs';
import { currentReleaseContext } from './engine-context.mjs';
import { readAttempt } from './attempt-state.mjs';
import { assertTypedFileUnchanged } from './typed-files.mjs';

export const REUSE_SCHEMA = 'sd2-candidate-build-reuse.v1';
export const GUARD_BUILD_TAIL_SCHEMA = 'sd2-candidate-build-tail.v1';
export const CANDIDATE_OBSERVATION_SCHEMA = 'sd2-release-candidate-observation-proof.v1';
const READER_PHASES = ['verify', 'arm', 'switch', 'proof', 'recovery'];
const PROTECTION_FIELDS = ['databaseIdentity', 'files', 'marker', 'otherServices', 'settingsSha256', 'protectedTasks', 'protectedFailedVideo'];
const TAIL_PHASES = ['guard-build', 'main-build', 'verify', 'arm', 'switch', 'proof', 'recovery'];

function processorBytes(value, m) {
  assert.ok(value.processor && value.processorControllers);
  assert.notEqual(value.processor.root, engineDirectory(m));
  assert.deepEqual(Object.keys(value.processorControllers).sort(), Object.keys(m.privateSha256).sort());
  assert.equal(sha(JSON.stringify(value.processorControllers)), value.processor.controllerSetSha256);
  assert.deepEqual(fs.readdirSync(value.processor.root).filter(name => name.endsWith('.mjs')).sort(), Object.keys(value.processorControllers).sort());
  for (const [name, expected] of Object.entries(value.processorControllers)) {
    assert.equal(path.basename(name), name); assert.match(expected, /^[a-f0-9]{64}$/);
    assert.equal(sha(rootFile(value.processor.root + '/' + name)), expected, 'Compatible reader bytes changed: ' + name);
  }
}
function runtimeRootProof(reference, prefix, schema, m) {
  assert.match(reference.proofSha256 || '', /^[a-f0-9]{64}$/);
  const expected = m.operation.taskRoot + '/attempts/' + m.runId + '/' + prefix + reference.proofSha256 + '.json';
  assert.equal(reference.proofFile, expected);
  const bytes = rootFile(expected, 8 * 1024 * 1024), proof = JSON.parse(bytes);
  assert.equal(sha(bytes), reference.proofSha256); assert.deepEqual(proof, reference.proof); assert.equal(proof.schema, schema);
  assert.equal(proof.runId, m.runId); assert.equal(proof.taskId, m.operation.taskId); assert.equal(proof.attemptId, m.operation.attemptId);
  assert.deepEqual(proof.engine, m.engine); assert.equal(proof.manifestSha256, sha(rootFile(m.stage + '/manifest.json')));
  return proof;
}
function successorJournal(m, runtime) {
  const loaded = readAttempt({ root: m.projectRoot + '/release-tasks', taskId: m.operation.taskId, attemptId: m.runId });
  assert.equal(loaded.headCurrent, true); assert.equal(loaded.derivedState.status, 'running');
  if (loaded.derivedState.activePhase) assert.equal(loaded.derivedState.activePhase.phase, runtime.phase);
  const reader = runtime.reader, proof = reader.proof;
  const records = loaded.events.filter(item => item.value.kind === 'observation' && item.value.name === 'reader_successor');
  assert.equal(records.length, 1, 'A successor reader requires its unique owning journal observation');
  const observed = records[0];
  assert.deepEqual(observed.value.value, { schema: 'sd2-release-reader-successor-reference.v1', proofFile: reader.proofFile, proofSha256: reader.proofSha256 });
  assert.equal(observed.value.previousSha256, proof.eventHeadSha256);
  const takeover = loaded.events.find(item => item.sha256 === proof.eventHeadSha256);
  assert.ok(takeover && takeover.value.kind === 'owner_takeover');
  assert.equal(takeover.value.previousSha256, proof.request.eventHeadSha256);
  assert.equal(loaded.events[loaded.events.indexOf(observed) - 1]?.sha256, takeover.sha256);
  assert.deepEqual(observed.value.owner, takeover.value.owner);
  assert.equal(takeover.value.previousLeaseSha256, proof.previousLeaseSha256);
  assert.deepEqual(takeover.value.previousOwner, proof.previousOwner);
  const main = loaded.events.filter(item => item.value.kind === 'phase_result' && item.value.phase === 'main-build'
    && item.value.sequence < takeover.value.sequence).at(-1);
  assert.ok(main && main.value.outcome === 'succeeded', 'Only a completed successful main build may authorize a read-only successor');
  assert.equal((loaded.derivedState.guardBuildTailRetry || loaded.derivedState.guardBuildTail)?.status, 'completed');
  return { loaded, readerRecord: observed };
}
function assertArmPairRepair(m, runtime, predecessor) {
  const reference = runtime.armPairRepair;
  assert.equal(reference.schema, 'sd2-release-arm-pair-repair-runtime.v1');
  assert.ok(['arm', 'switch', 'proof', 'recovery'].includes(runtime.phase));
  const proof = runtimeRootProof(reference, 'arm-pair-repair-', 'sd2-release-arm-pair-repair-proof.v1', m);
  assert.equal(proof.originalReaderProofFile, runtime.reader.proofFile);
  assert.equal(proof.originalReaderProofSha256, runtime.reader.proofSha256);
  assert.equal(proof.candidateObservationProofFile, runtime.candidateObservation.proofFile);
  assert.equal(proof.candidateObservationProofSha256, runtime.candidateObservation.proofSha256);
  assert.equal(proof.request.readerProofSha256, runtime.reader.proofSha256);
  assert.equal(proof.request.candidateObservationProofSha256, runtime.candidateObservation.proofSha256);
  assert.deepEqual(proof.predecessorProcessor, predecessor.processor);
  assert.equal(proof.request.processorControllerSetSha256, proof.processor.controllerSetSha256);
  processorBytes(proof, m);
  const allowed = new Set(['release-entry.mjs', 'candidate-evidence.mjs', 'release.mjs', 'pricing-start-pair.mjs',
    'switch.mjs', 'cutover-driver.mjs', 'guard-recovery.mjs', 'release-entry-engineering.mjs',
    'candidate-lifecycle-engineering.mjs', 'cutover-driver-engineering.mjs']);
  for (const [name, digest] of Object.entries(proof.processorControllers))
    if (digest !== predecessor.processorControllers[name]) assert.ok(allowed.has(name), 'Unreviewed arm pair repair controller: ' + name);
  assert.equal(proof.approvalFile, m.stage + '/hd-release-safety-approval-arm-pair-r01.json');
  assert.equal(proof.approvalFile, proof.request.approvalFile);
  assert.equal(proof.approvalSha256, proof.request.approvalSha256);
  assert.equal(proof.windowSha256, proof.request.windowSha256);
  assert.equal(proof.windowFile, m.stage + '/window-evidence/' + proof.windowSha256 + '.json');
  assert.equal(assertTypedFileUnchanged(proof.windowSnapshot).sha256, proof.windowSha256);
  assert.equal(assertTypedFileUnchanged(proof.approvalSnapshot).sha256, proof.approvalSha256);
  const approval = JSON.parse(rootFile(proof.approvalFile));
  assert.equal(approval.runId, m.runId); assert.equal(approval.manifestSha256, proof.manifestSha256);
  assert.equal(approval.windowSha256, proof.windowSha256);
  const { loaded } = successorJournal(m, runtime);
  const records = loaded.events.filter(item => item.value.kind === 'observation' && item.value.name === 'arm_pair_repair');
  assert.equal(records.length, 1);
  const observed = records[0];
  assert.deepEqual(observed.value.value, { schema: 'sd2-release-arm-pair-repair-reference.v1',
    proofFile: reference.proofFile, proofSha256: reference.proofSha256 });
  const continued = loaded.events.find(item => item.sha256 === observed.value.previousSha256);
  assert.equal(continued?.value.kind, 'failure_continued');
  assert.equal(continued.value.failureReceiptSha256, reference.proofSha256);
  assert.equal(continued.value.previousTerminalSha256, proof.request.terminalEventSha256);
  assert.equal(continued.value.previousSha256, proof.request.terminalEventSha256);
  assert.equal(continued.value.continuation, undefined);
  assert.deepEqual(observed.value.owner, continued.value.owner);
  for (const name of ['terminal', 'result', 'child', 'process', 'invocation']) {
    const value = proof.failure[name];
    const attempt = m.operation.taskRoot + '/attempts/' + m.runId;
    if (['terminal', 'result'].includes(name)) {
      assert.equal(path.dirname(value.file), attempt + '/events'); assert.match(path.basename(value.file), /^\d{6}\.json$/);
    } else assert.equal(value.file, attempt + '/arm-' + proof.failureIntentSha256 + '.'
      + ({ child: 'child', process: 'process', invocation: 'invocation' })[name] + '.json');
    assert.equal(value.snapshot.requestedPath, value.file);
    assert.equal(assertTypedFileUnchanged(value.snapshot).sha256, value.sha256, 'Original arm failure record changed: ' + name);
  }
  assert.equal(proof.failure.terminal.sha256, proof.request.terminalEventSha256);
  assert.equal(proof.failure.result.sha256, proof.request.phaseResultEventSha256);
  assert.equal(proof.failure.child.sha256, proof.request.childReceiptSha256);
  assert.equal(loaded.events[loaded.events.indexOf(observed) - 1]?.sha256, continued.sha256);
  return proof;
}

function assertArmProcessorRepair(m, runtime, predecessor) {
  const reference = runtime.armProcessorRepair;
  assert.equal(reference.schema, 'sd2-release-arm-processor-repair-runtime.v1');
  assert.ok(['arm', 'switch', 'proof', 'recovery'].includes(runtime.phase));
  const proof = runtimeRootProof(reference, 'arm-processor-repair-', 'sd2-release-arm-processor-repair-proof.v1', m);
  assert.equal(proof.originalArmPairRepairProofFile, runtime.armPairRepair.proofFile);
  assert.equal(proof.originalArmPairRepairProofSha256, runtime.armPairRepair.proofSha256);
  assert.equal(proof.request.armPairRepairProofSha256, runtime.armPairRepair.proofSha256);
  assert.deepEqual(proof.predecessorProcessor, predecessor.processor);
  assert.equal(proof.request.processorControllerSetSha256, proof.processor.controllerSetSha256);
  processorBytes(proof, m);
  const allowed = new Set(['release-entry.mjs', 'candidate-evidence.mjs', 'candidate-inputs.mjs', 'release.mjs',
    'release-entry-engineering.mjs', 'candidate-lifecycle-engineering.mjs']);
  for (const [name, digest] of Object.entries(proof.processorControllers))
    if (digest !== predecessor.processorControllers[name]) assert.ok(allowed.has(name), 'Unreviewed arm processor repair controller: ' + name);
  assert.equal(proof.approvalFile, m.stage + '/hd-release-safety-approval-arm-processor-r01.json');
  assert.equal(proof.approvalFile, proof.request.approvalFile);
  assert.equal(proof.approvalSha256, proof.request.approvalSha256);
  assert.equal(proof.windowSha256, proof.request.windowSha256);
  assert.equal(proof.windowFile, m.stage + '/window-evidence/' + proof.windowSha256 + '.json');
  assert.equal(proof.approvalSnapshot.requestedPath, proof.approvalFile);
  assert.equal(proof.windowSnapshot.requestedPath, proof.windowFile);
  assert.equal(assertTypedFileUnchanged(proof.windowSnapshot).sha256, proof.windowSha256);
  assert.equal(assertTypedFileUnchanged(proof.approvalSnapshot).sha256, proof.approvalSha256);
  const approval = JSON.parse(rootFile(proof.approvalFile));
  assert.equal(approval.runId, m.runId); assert.equal(approval.manifestSha256, proof.manifestSha256);
  assert.equal(approval.windowSha256, proof.windowSha256);
  const { loaded } = successorJournal(m, runtime);
  const records = loaded.events.filter(item => item.value.kind === 'observation' && item.value.name === 'arm_processor_repair');
  assert.equal(records.length, 1); const observed = records[0];
  assert.deepEqual(observed.value.value, { schema: 'sd2-release-arm-processor-repair-reference.v1', proofFile: reference.proofFile, proofSha256: reference.proofSha256 });
  const continued = loaded.events.find(item => item.sha256 === observed.value.previousSha256);
  assert.equal(continued?.value.kind, 'failure_continued'); assert.equal(continued.value.failureReceiptSha256, reference.proofSha256);
  assert.equal(continued.value.previousTerminalSha256, proof.request.terminalEventSha256);
  assert.equal(continued.value.previousSha256, proof.request.terminalEventSha256); assert.equal(continued.value.continuation, undefined);
  assert.deepEqual(observed.value.owner, continued.value.owner);
  for (const name of ['terminal', 'result', 'child', 'process', 'invocation']) {
    const value = proof.failure[name], attempt = m.operation.taskRoot + '/attempts/' + m.runId;
    if (['terminal', 'result'].includes(name)) { assert.equal(path.dirname(value.file), attempt + '/events'); assert.match(path.basename(value.file), /^\d{6}\.json$/); }
    else assert.equal(value.file, attempt + '/arm-' + proof.failureIntentSha256 + '.' + name + '.json');
    assert.equal(value.snapshot.requestedPath, value.file);
    assert.equal(assertTypedFileUnchanged(value.snapshot).sha256, value.sha256);
  }
  assert.equal(proof.failure.terminal.sha256, proof.request.terminalEventSha256);
  assert.equal(proof.failure.result.sha256, proof.request.phaseResultEventSha256);
  assert.equal(proof.failure.child.sha256, proof.request.childReceiptSha256);
  return proof;
}

function verifySwitchAdmissionRepair(m, runtime, predecessor) {
  const reference = runtime.switchAdmissionRepair;
  assert.equal(reference.schema, 'sd2-release-switch-admission-repair-runtime.v1');
  assert.ok(['switch', 'proof', 'recovery'].includes(runtime.phase), 'An armed switch continuation cannot rearm or rebuild');
  const proof = runtimeRootProof(reference, 'switch-admission-repair-', 'sd2-release-switch-admission-repair-proof.v1', m);
  assert.equal(proof.originalArmProcessorRepairProofFile, runtime.armProcessorRepair.proofFile);
  assert.equal(proof.originalArmProcessorRepairProofSha256, runtime.armProcessorRepair.proofSha256);
  assert.equal(proof.request.armProcessorRepairProofSha256, runtime.armProcessorRepair.proofSha256);
  assert.deepEqual(proof.predecessorProcessor, predecessor.processor);
  assert.equal(proof.request.processorControllerSetSha256, proof.processor.controllerSetSha256);
  processorBytes(proof, m);
  const allowed = new Set(['release-entry.mjs', 'candidate-evidence.mjs', 'release.mjs', 'switch.mjs',
    'cutover-driver.mjs', 'cutover-safety.mjs', 'guard-recovery.mjs', 'normal-continuation.mjs', 'candidate-inputs.mjs',
    'release-entry-engineering.mjs', 'candidate-lifecycle-engineering.mjs', 'cutover-driver-engineering.mjs', 'cutover-safety-engineering.mjs']);
  for (const [name, digest] of Object.entries(proof.processorControllers))
    if (digest !== predecessor.processorControllers[name]) assert.ok(allowed.has(name), 'Unreviewed armed switch continuation controller: ' + name);
  assert.equal(proof.originalFixedGuardFile, m.stage + '/fixed-guard-recovery.json');
  assert.equal(proof.originalSwitchBeforeFile, m.stage + '/switch-before.json');
  assert.equal(proof.originalFixedGuardSha256, proof.request.originalFixedGuardSha256);
  assert.equal(proof.originalSwitchBeforeSha256, proof.request.originalSwitchBeforeSha256);
  assert.equal(proof.originalFixedGuardSnapshot.requestedPath, proof.originalFixedGuardFile);
  assert.equal(proof.originalSwitchBeforeSnapshot.requestedPath, proof.originalSwitchBeforeFile);
  assert.equal(assertTypedFileUnchanged(proof.originalFixedGuardSnapshot).sha256, proof.originalFixedGuardSha256);
  assert.equal(assertTypedFileUnchanged(proof.originalSwitchBeforeSnapshot).sha256, proof.originalSwitchBeforeSha256);
  assert.ok(call('lsattr', ['-d', '--', proof.originalFixedGuardFile]).split(/\s+/)[0].includes('i'));
  const fixed = JSON.parse(rootFile(proof.originalFixedGuardFile, 8 * 1024 * 1024));
  assert.equal(fixed.manifestSha256, proof.manifestSha256); assert.equal(fixed.runId, m.runId);
  assert.equal(proof.oldGuardApprovalFile, runtime.armProcessorRepair.proof.approvalFile);
  assert.equal(proof.oldGuardApprovalSha256, runtime.armProcessorRepair.proof.approvalSha256);
  assert.equal(sha(rootFile(proof.oldGuardApprovalFile)), proof.oldGuardApprovalSha256);
  assert.equal(fixed.approvalReceiptSha256, proof.oldGuardApprovalSha256);
  assert.equal(fixed.originalWindowSha256, proof.oldGuardWindowSha256);
  assert.equal(proof.oldGuardWindowFile, m.stage + '/window-evidence/' + proof.oldGuardWindowSha256 + '.json');
  assert.equal(sha(rootFile(proof.oldGuardWindowFile)), proof.oldGuardWindowSha256);
  assert.equal(JSON.parse(rootFile(proof.oldGuardApprovalFile)).windowSha256, proof.oldGuardWindowSha256);
  assert.ok(['hd-release-safety-approval-switch-admission-r01.json', 'hd-release-safety-approval-switch-admission-r02.json'].map(name => m.stage + '/' + name).includes(proof.approvalFile));
  assert.equal(proof.candidateObservationProofFile, runtime.candidateReobservation.proofFile);
  assert.equal(proof.candidateObservationProofSha256, runtime.candidateReobservation.proofSha256);
  assert.equal(proof.approvalFile, proof.request.approvalFile); assert.equal(proof.approvalSha256, proof.request.approvalSha256);
  assert.equal(proof.windowSha256, proof.request.windowSha256);
  assert.equal(proof.windowFile, m.stage + '/window-evidence/' + proof.windowSha256 + '.json');
  assert.equal(proof.approvalSnapshot.requestedPath, proof.approvalFile); assert.equal(proof.windowSnapshot.requestedPath, proof.windowFile);
  assert.equal(assertTypedFileUnchanged(proof.approvalSnapshot).sha256, proof.approvalSha256);
  assert.equal(assertTypedFileUnchanged(proof.windowSnapshot).sha256, proof.windowSha256);
  const approval = JSON.parse(rootFile(proof.approvalFile));
  assert.equal(approval.runId, m.runId); assert.equal(approval.manifestSha256, proof.manifestSha256);
  assert.equal(approval.windowSha256, proof.windowSha256);
  const { loaded } = successorJournal(m, runtime);
  const records = loaded.events.filter(item => item.value.kind === 'observation' && item.value.name === 'switch_admission_repair');
  assert.equal(records.length, 1); const observed = records[0];
  assert.deepEqual(observed.value.value, { schema: 'sd2-release-switch-admission-repair-reference.v1', proofFile: reference.proofFile, proofSha256: reference.proofSha256 });
  const continued = loaded.events.find(item => item.sha256 === observed.value.previousSha256);
  assert.equal(continued?.value.kind, 'failure_continued'); assert.equal(continued.value.failureReceiptSha256, reference.proofSha256);
  assert.equal(continued.value.previousTerminalSha256, proof.request.terminalEventSha256);
  assert.equal(continued.value.previousSha256, proof.request.terminalEventSha256); assert.equal(continued.value.continuation, undefined);
  assert.deepEqual(observed.value.owner, continued.value.owner);
  for (const name of ['terminal', 'result', 'child', 'process', 'invocation']) {
    const value = proof.failure[name], attempt = m.operation.taskRoot + '/attempts/' + m.runId;
    if (['terminal', 'result'].includes(name)) { assert.equal(path.dirname(value.file), attempt + '/events'); assert.match(path.basename(value.file), /^\d{6}\.json$/); }
    else assert.equal(value.file, attempt + '/switch-' + proof.failureIntentSha256 + '.' + name + '.json');
    assert.equal(value.snapshot.requestedPath, value.file); assert.equal(assertTypedFileUnchanged(value.snapshot).sha256, value.sha256);
  }
  assert.equal(proof.failure.terminal.sha256, proof.request.terminalEventSha256);
  assert.equal(proof.failure.result.sha256, proof.request.phaseResultEventSha256); assert.equal(proof.failure.child.sha256, proof.request.childReceiptSha256);
  return proof;
}

function verifySwitchTypedRepair(m, runtime, predecessor, { scanStage = false, ownerStage = false, windowStage = false } = {}) {
  const parent = windowStage ? runtime.switchOwnerRepair : ownerStage ? runtime.switchScanRepair : scanStage ? runtime.switchTypedRepair : runtime.switchAdmissionRepair;
  const prefix = windowStage ? 'switch-window-repair' : ownerStage ? 'switch-owner-repair' : scanStage ? 'switch-scan-repair' : 'switch-typed-repair';
  const reference = windowStage ? runtime.switchWindowRepair : ownerStage ? runtime.switchOwnerRepair : scanStage ? runtime.switchScanRepair : runtime.switchTypedRepair;
  const originalPrefix = windowStage ? 'originalSwitchOwnerRepair' : ownerStage ? 'originalSwitchScanRepair' : scanStage ? 'originalSwitchTypedRepair' : 'originalSwitchAdmissionRepair';
  const requestKey = windowStage ? 'switchOwnerRepairProofSha256' : ownerStage ? 'switchScanRepairProofSha256' : scanStage ? 'switchTypedRepairProofSha256' : 'switchAdmissionRepairProofSha256';
  assert.equal(reference.schema, 'sd2-release-' + prefix + '-runtime.v1');
  assert.ok(['switch', 'proof', 'recovery'].includes(runtime.phase));
  const proof = runtimeRootProof(reference, prefix + '-', 'sd2-release-' + prefix + '-proof.v1', m);
  assert.equal(proof[originalPrefix + 'ProofFile'], parent.proofFile);
  assert.equal(proof[originalPrefix + 'ProofSha256'], parent.proofSha256);
  assert.equal(proof.request[requestKey], parent.proofSha256);
  assert.equal(proof.originalCandidateSwitchObservationProofFile, runtime.candidateSwitchObservation.proofFile);
  assert.equal(proof.originalCandidateSwitchObservationProofSha256, runtime.candidateSwitchObservation.proofSha256);
  if (windowStage) {
    assert.equal(proof.originalCandidateSwitchOwnerObservationProofFile, runtime.candidateSwitchOwnerObservation.proofFile);
    assert.equal(proof.originalCandidateSwitchOwnerObservationProofSha256, runtime.candidateSwitchOwnerObservation.proofSha256);
    assert.equal(proof.request.candidateSwitchOwnerObservationProofSha256, runtime.candidateSwitchOwnerObservation.proofSha256);
    assert.equal(sha(rootFile(proof.originalCandidateSwitchOwnerObservationProofFile)), proof.originalCandidateSwitchOwnerObservationProofSha256);
  } else assert.equal(proof.request.candidateSwitchObservationProofSha256, runtime.candidateSwitchObservation.proofSha256);
  assert.equal(sha(rootFile(proof.originalCandidateSwitchObservationProofFile)), proof.originalCandidateSwitchObservationProofSha256);
  assert.deepEqual(proof.predecessorProcessor, predecessor.processor);
  assert.equal(proof.request.processorControllerSetSha256, proof.processor.controllerSetSha256); processorBytes(proof, m);
  const allowed = new Set(['release-entry.mjs', 'release-entry-engineering.mjs', 'candidate-evidence.mjs',
    'release.mjs', 'switch.mjs', 'candidate-lifecycle-engineering.mjs',
    ...((scanStage || ownerStage) ? ['hd-storage-preflight.mjs', 'hd-storage-preflight-engineering.mjs'] : []),
    ...(ownerStage ? ['candidate-inputs.mjs'] : [])]);
  for (const [name, digest] of Object.entries(proof.processorControllers))
    if (digest !== predecessor.processorControllers[name]) assert.ok(allowed.has(name), 'Unreviewed typed switch repair controller: ' + name);
  for (const key of ['originalArmProcessorRepairProofFile', 'originalArmProcessorRepairProofSha256',
    'originalFixedGuardFile', 'originalFixedGuardSha256', 'originalFixedGuardSnapshot', 'originalFixedGuardAttributes',
    'originalSwitchBeforeFile', 'originalSwitchBeforeSha256', 'originalSwitchBeforeSnapshot',
    'originalGuardArmedFile', 'originalGuardArmedSha256', 'originalGuardArmedSnapshot',
    'oldGuardApprovalFile', 'oldGuardApprovalSha256', 'oldGuardApprovalSnapshot',
    'oldGuardWindowFile', 'oldGuardWindowSha256', 'oldGuardWindowSnapshot', 'liveSnapshot', 'liveSnapshotSha256',
    'candidateObservationProofFile', 'candidateObservationProofSha256',
    ...((scanStage || ownerStage || windowStage) ? ['originalSwitchAdmissionRepairProofFile', 'originalSwitchAdmissionRepairProofSha256'] : []),
    ...((ownerStage || windowStage) ? ['originalSwitchTypedRepairProofFile', 'originalSwitchTypedRepairProofSha256'] : []),
    ...(windowStage ? ['originalSwitchScanRepairProofFile', 'originalSwitchScanRepairProofSha256', 'strictResultFile', 'strictResultSha256', 'strictResultSnapshot'] : []),
    'originalTimesChanged', 'newCompilationClaimed', 'originalSwitchBeforeReplaced', 'candidateObservationRenewed'])
    assert.deepEqual(proof[key], predecessor[key], 'Typed repair changed retained switch authority: ' + key);
  assert.equal(proof.refusalLogFile, m.stage + '/normal-switch-refusal-' + parent.proofSha256 + '.log');
  assert.equal(proof.refusalLogSha256, proof.request.refusalLogSha256);
  assert.equal(proof.refusalLogSnapshot.requestedPath, proof.refusalLogFile);
  assert.equal(assertTypedFileUnchanged(proof.refusalLogSnapshot).sha256, proof.refusalLogSha256);
  if (ownerStage) {
    assert.equal(proof.strictResultFile, m.stage + '/hd-discovery-admission-strict-result-1-' + parent.proofSha256 + '.json');
    assert.equal(proof.strictResultSha256, proof.request.strictResultSha256);
    assert.equal(proof.strictResultSnapshot.requestedPath, proof.strictResultFile);
    assert.equal(assertTypedFileUnchanged(proof.strictResultSnapshot).sha256, proof.strictResultSha256);
  }
  if (windowStage) for (const [field, name, requestKey] of [
    ['originalHdBefore', 'hd-reconciliation-before.json', 'originalHdBeforeSha256'],
    ['originalNginxMaster', 'nginx-master.json', 'originalNginxMasterSha256'],
  ]) {
    assert.equal(proof[field + 'File'], m.stage + '/' + name);
    assert.equal(proof[field + 'Sha256'], proof.request[requestKey]);
    assert.equal(proof[field + 'Snapshot'].requestedPath, proof[field + 'File']);
    assert.equal(assertTypedFileUnchanged(proof[field + 'Snapshot']).sha256, proof[field + 'Sha256']);
  }
  assert.ok(['r01', 'r02'].map(round => m.stage + '/hd-release-safety-approval-'
    + (windowStage ? 'switch-window' : ownerStage ? 'switch-owner' : scanStage ? 'switch-scan' : 'switch-typed') + '-' + round + '.json').includes(proof.approvalFile));
  assert.equal(proof.approvalFile, proof.request.approvalFile); assert.equal(proof.approvalSha256, proof.request.approvalSha256);
  assert.equal(proof.windowSha256, proof.request.windowSha256);
  assert.equal(proof.windowFile, m.stage + '/window-evidence/' + proof.windowSha256 + '.json');
  assert.equal(proof.approvalSnapshot.requestedPath, proof.approvalFile); assert.equal(proof.windowSnapshot.requestedPath, proof.windowFile);
  assert.equal(assertTypedFileUnchanged(proof.approvalSnapshot).sha256, proof.approvalSha256);
  assert.equal(assertTypedFileUnchanged(proof.windowSnapshot).sha256, proof.windowSha256);
  const approval = JSON.parse(rootFile(proof.approvalFile));
  assert.equal(approval.runId, m.runId); assert.equal(approval.manifestSha256, proof.manifestSha256); assert.equal(approval.windowSha256, proof.windowSha256);
  const { loaded } = successorJournal(m, runtime);
  const records = loaded.events.filter(item => item.value.kind === 'observation' && item.value.name === (windowStage ? 'switch_window_repair' : ownerStage ? 'switch_owner_repair' : scanStage ? 'switch_scan_repair' : 'switch_typed_repair'));
  assert.equal(records.length, 1); const observed = records[0];
  assert.deepEqual(observed.value.value, { schema: 'sd2-release-' + prefix + '-reference.v1', proofFile: reference.proofFile, proofSha256: reference.proofSha256 });
  const continued = loaded.events.find(item => item.sha256 === observed.value.previousSha256);
  assert.equal(continued?.value.kind, 'failure_continued'); assert.equal(continued.value.failureReceiptSha256, reference.proofSha256);
  assert.equal(continued.value.previousTerminalSha256, proof.request.terminalEventSha256);
  assert.equal(continued.value.previousSha256, proof.request.terminalEventSha256); assert.equal(continued.value.continuation, undefined);
  assert.deepEqual(observed.value.owner, continued.value.owner);
  for (const name of ['terminal', 'result', 'child', 'process', 'invocation']) {
    const value = proof.failure[name], attempt = m.operation.taskRoot + '/attempts/' + m.runId;
    if (['terminal', 'result'].includes(name)) { assert.equal(path.dirname(value.file), attempt + '/events'); assert.match(path.basename(value.file), /^\d{6}\.json$/); }
    else assert.equal(value.file, attempt + '/switch-' + proof.failureIntentSha256 + '.' + name + '.json');
    assert.equal(value.snapshot.requestedPath, value.file); assert.equal(assertTypedFileUnchanged(value.snapshot).sha256, value.sha256);
  }
  assert.equal(proof.failure.terminal.sha256, proof.request.terminalEventSha256);
  assert.equal(proof.failure.result.sha256, proof.request.phaseResultEventSha256); assert.equal(proof.failure.child.sha256, proof.request.childReceiptSha256);
  return proof;
}

function verifyRestoredOriginalRepair(m, runtime, predecessor) {
  const reference = runtime.restoredOriginalRepair;
  assert.equal(reference.schema, 'sd2-release-restored-original-repair-runtime.v1');
  assert.ok(['switch', 'proof', 'recovery'].includes(runtime.phase));
  const proof = runtimeRootProof(reference, 'restored-original-repair-', 'sd2-release-restored-original-repair-proof.v1', m);
  assert.equal(proof.originalSwitchWindowRepairProofFile, runtime.switchWindowRepair.proofFile);
  assert.equal(proof.originalSwitchWindowRepairProofSha256, runtime.switchWindowRepair.proofSha256);
  assert.deepEqual(proof.predecessorProcessor, predecessor.processor); processorBytes(proof, m);
  const allowed = new Set(['release-entry.mjs', 'release-entry-engineering.mjs', 'candidate-evidence.mjs', 'candidate-inputs.mjs',
    'attempt-state.mjs', 'attempt-state-engineering.mjs', 'release.mjs', 'switch.mjs', 'candidate-lifecycle-engineering.mjs',
    'hd-storage-preflight.mjs', 'hd-storage-preflight-engineering.mjs', 'retired-hd-cache.mjs', 'retired-hd-cache-engineering.mjs',
    'usage-role-control.mjs', 'usage-role-engineering.mjs', 'cutover-safety.mjs', 'cutover-safety-engineering.mjs', 'normal-continuation.mjs', 'normal-continuation-engineering.mjs']);
  for (const [name, digest] of Object.entries(proof.processorControllers))
    if (digest !== predecessor.processorControllers[name]) assert.ok(allowed.has(name), 'Unreviewed restored-original processor difference: ' + name);
  const closureReference = runtime.restoredOriginalClosure;
  assert.equal(closureReference.schema, 'sd2-release-restored-original-closure-runtime.v1');
  const closure = runtimeRootProof(closureReference, 'restored-original-closure-', 'sd2-release-restored-original-closure-proof.v1', m);
  assert.equal(proof.restoredOriginalClosureProofFile, closureReference.proofFile);
  assert.equal(proof.restoredOriginalClosureProofSha256, closureReference.proofSha256);
  assert.equal(proof.request.closureProofSha256, closureReference.proofSha256);
  assert.deepEqual(closure.processor, proof.processor); assert.deepEqual(closure.processorControllers, proof.processorControllers);
  for (const [key, value] of Object.entries({ completed: true, originalPairRestored: true, effectsStarted: true,
    pairPublished: false, schemaPublished: false, newWriterStarted: false })) assert.equal(closure[key], value);
  for (const name of ['restoredBaseline', 'restoredSwitchBefore']) {
    assert.equal(proof[name + 'File'], closure[name + 'File']); assert.equal(proof[name + 'Sha256'], closure[name + 'Sha256']);
    const snapshot = proof[name + 'Snapshot']; assert.equal(snapshot.requestedPath, proof[name + 'File']);
    assert.equal(assertTypedFileUnchanged(snapshot).sha256, proof[name + 'Sha256']);
  }
  const baseline = JSON.parse(rootFile(proof.restoredBaselineFile));
  assert.equal(baseline.schema, 'sd2-release-restored-original-baseline.v1'); assert.equal(baseline.runId, m.runId);
  assert.equal(baseline.manifestSha256, proof.manifestSha256);
  assert.deepEqual(baseline.newLiveSnapshot, proof.newLiveSnapshot); assert.deepEqual(proof.newLiveSnapshot, closure.newLiveSnapshot);
  assert.deepEqual(proof.restoredLiveSnapshot, closure.restoredLiveSnapshot);
  assert.equal(baseline.restoredSwitchBeforeFile, proof.restoredSwitchBeforeFile);
  assert.equal(baseline.restoredSwitchBeforeSha256, proof.restoredSwitchBeforeSha256);
  const before = JSON.parse(rootFile(proof.restoredSwitchBeforeFile, 8 * 1024 * 1024));
  assert.equal(before.schema, 'rate-impl2-switch-before.v1'); assert.equal(before.runId, m.runId); assert.equal(before.manifestSha256, proof.manifestSha256);
  assert.deepEqual(Object.keys(proof.newLiveSnapshot).sort(), ['web', 'image', 'hd', 'works', 'role', 'template'].sort());
  for (const [role, live] of Object.entries(proof.newLiveSnapshot)) {
    for (const key of ['unit', 'root', 'source', 'version', 'build']) assert.equal(live[key], m.live[role][key], 'Restored live source authority changed: ' + role + ':' + key);
    assert.ok(Number.isSafeInteger(live.pid) && live.pid > 1); assert.match(live.invocation, /^[a-f0-9]{32}$/);
    assert.match(live.kernelStartTicks, /^\d+$/); assert.match(live.execMainStartTimestampMonotonic, /^\d+$/);
    if (before.writers[role]) {
      assert.equal(Number(before.writers[role].MainPID), live.pid); assert.equal(before.writers[role].InvocationID, live.invocation);
      assert.equal(before.writers[role].WorkingDirectory, live.root);
    }
  }
  assert.equal(Number(before.roleControl.state.MainPID), proof.newLiveSnapshot.role.pid);
  assert.equal(before.roleControl.state.InvocationID, proof.newLiveSnapshot.role.invocation);
  assert.match(proof.maintenanceOperationId, /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][0-9a-f]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.notEqual(proof.maintenanceOperationId, m.runId);
  for (const key of ['originalFixedGuardFile', 'originalFixedGuardSha256', 'originalFixedGuardSnapshot', 'originalFixedGuardAttributes',
    'originalSwitchBeforeFile', 'originalSwitchBeforeSha256', 'originalSwitchBeforeSnapshot',
    'oldGuardApprovalFile', 'oldGuardApprovalSha256', 'oldGuardApprovalSnapshot', 'oldGuardWindowFile', 'oldGuardWindowSha256', 'oldGuardWindowSnapshot',
    'liveSnapshot', 'liveSnapshotSha256', 'originalTimesChanged', 'newCompilationClaimed', 'originalSwitchBeforeReplaced'])
    assert.deepEqual(proof[key], predecessor[key], 'Restored continuation changed original frozen authority: ' + key);
  assert.equal(proof.request.processorControllerSetSha256, proof.processor.controllerSetSha256);
  assert.equal(proof.approvalFile, proof.request.approvalFile); assert.equal(proof.approvalSha256, proof.request.approvalSha256);
  assert.ok(['r01', 'r02'].some(round => proof.approvalFile === m.stage + '/hd-release-safety-approval-restored-original-' + round + '.json'));
  assert.equal(assertTypedFileUnchanged(proof.approvalSnapshot).sha256, proof.approvalSha256);
  assert.equal(proof.windowSha256, proof.request.windowSha256); assert.equal(proof.windowFile, m.stage + '/window-evidence/' + proof.windowSha256 + '.json');
  assert.equal(assertTypedFileUnchanged(proof.windowSnapshot).sha256, proof.windowSha256);
  const { loaded } = successorJournal(m, runtime);
  const records = loaded.events.filter(item => item.value.kind === 'observation' && item.value.name === 'restored_original_repair');
  assert.equal(records.length, 1); const observed = records[0];
  assert.deepEqual(observed.value.value, { schema: 'sd2-release-restored-original-repair-reference.v1', proofFile: reference.proofFile, proofSha256: reference.proofSha256 });
  const continued = loaded.events.find(item => item.sha256 === observed.value.previousSha256);
  assert.equal(continued?.value.kind, 'restored_original_continued'); assert.equal(continued.value.failureReceiptSha256, reference.proofSha256);
  assert.equal(continued.value.previousTerminalSha256, proof.request.terminalEventSha256);
  assert.equal(continued.value.restoration.closureProofSha256, closureReference.proofSha256);
  assert.equal(continued.value.restoration.restoredBaselineSha256, proof.restoredBaselineSha256);
  assert.equal(continued.value.before.facts.effectsStarted, true); assert.equal(continued.value.before.facts.switchComplete, false);
  assert.deepEqual(observed.value.owner, continued.value.owner);
  assert.equal(loaded.derivedState.restoredOriginalClosure.consumed, true);
  return proof;
}

function verifyGuardRecoveryRepair(m, runtime, predecessor) {
  const reference = runtime.guardRecoveryRepair; assert.equal(reference.schema, 'sd2-release-guard-recovery-repair-runtime.v1');
  assert.ok(['switch', 'recovery'].includes(runtime.phase), 'Guard recovery repair cannot execute another application phase');
  const proof = runtimeRootProof(reference, 'guard-recovery-repair-', 'sd2-release-guard-recovery-repair-proof.v1', m);
  assert.equal(proof.originalRestoredOriginalRepairProofFile, runtime.restoredOriginalRepair.proofFile);
  assert.equal(proof.originalRestoredOriginalRepairProofSha256, runtime.restoredOriginalRepair.proofSha256);
  assert.equal(proof.originalRestoredOriginalClosureProofFile, runtime.restoredOriginalClosure.proofFile);
  assert.equal(proof.originalRestoredOriginalClosureProofSha256, runtime.restoredOriginalClosure.proofSha256);
  assert.deepEqual(proof.predecessorProcessor, predecessor.processor); processorBytes(proof, m);
  const allowed = new Set(['release-entry.mjs', 'release-entry-engineering.mjs', 'candidate-evidence.mjs', 'release.mjs',
    'canvas-batch-schema.mjs', 'canvas-batch-schema-engineering.mjs', 'deployed-usage-schema.mjs', 'deployed-usage-schema-engineering.mjs',
    'candidate-lifecycle-engineering.mjs', 'switch.mjs']);
  for (const [name, hash] of Object.entries(proof.processorControllers))
    if (hash !== predecessor.processorControllers[name]) assert.ok(allowed.has(name), 'Unreviewed guard recovery processor difference: ' + name);
  for (const name of ['guardRecoveryFailure', 'switchFailure', 'originalFixedGuard', 'publishedPair', 'fullSchemaReady', 'window']) {
    const snapshot = proof[name + 'Snapshot']; assert.equal(snapshot.requestedPath, proof[name + 'File']);
    assert.equal(assertTypedFileUnchanged(snapshot).sha256, proof[name + 'Sha256']);
  }
  assert.equal(proof.originalFixedGuardFile, predecessor.originalFixedGuardFile);
  assert.equal(proof.originalFixedGuardSha256, predecessor.originalFixedGuardSha256);
  assert.equal(proof.publishedPairFile, m.stage + '/pricing-pair-published.json');
  assert.equal(proof.fullSchemaReadyFile, m.stage + '/full-schema-ready.json');
  assert.equal(proof.newWriterStartAbsent, true); assert.equal(proof.recoveryOnly, true);
  const { loaded } = successorJournal(m, runtime);
  const records = loaded.events.filter(item => item.value.kind === 'observation' && item.value.name === 'guard_recovery_repair');
  assert.equal(records.length, 1); const observed = records[0];
  assert.deepEqual(observed.value.value, { schema: 'sd2-release-guard-recovery-repair-reference.v1', proofFile: reference.proofFile, proofSha256: reference.proofSha256 });
  assert.equal(observed.value.previousSha256, proof.takeoverEventSha256);
  const takeover = loaded.events.find(item => item.sha256 === proof.takeoverEventSha256);
  assert.equal(takeover?.value.kind, 'owner_takeover'); assert.equal(takeover.value.previousSha256, proof.request.phaseResultEventSha256);
  assert.deepEqual(takeover.value.owner, observed.value.owner);
  return proof;
}

function verifyGuardHeartbeatRepair(m, runtime, predecessor) {
  assert.equal(runtime.phase, 'recovery');
  const reference = runtime.guardHeartbeatRepair;
  assert.equal(reference.schema, 'sd2-release-guard-heartbeat-repair-runtime.v1');
  const proof = runtimeRootProof(reference, 'guard-heartbeat-repair-', 'sd2-release-guard-heartbeat-repair-proof.v1', m);
  assert.equal(proof.originalGuardRecoveryRepairProofFile, runtime.guardRecoveryRepair.proofFile);
  assert.equal(proof.originalGuardRecoveryRepairProofSha256, runtime.guardRecoveryRepair.proofSha256);
  assert.deepEqual(proof.predecessorProcessor, predecessor.processor); processorBytes(proof, m);
  const allowed = new Set(['release-entry.mjs', 'release-entry-engineering.mjs', 'candidate-evidence.mjs', 'release.mjs',
    'switch.mjs', 'full-release-contract.mjs', 'full-release-engineering.mjs', 'candidate-lifecycle-engineering.mjs']);
  for (const [name, hash] of Object.entries(proof.processorControllers))
    if (hash !== predecessor.processorControllers[name]) assert.ok(allowed.has(name), 'Unreviewed heartbeat recovery processor difference: ' + name);
  for (const name of ['guardRecoveryResumeFailure', 'originalRecoveryResume', 'originalFixedGuard', 'publishedPair', 'fullSchemaReady', 'window']) {
    const snapshot = proof[name + 'Snapshot']; assert.equal(snapshot.requestedPath, proof[name + 'File']);
    assert.equal(assertTypedFileUnchanged(snapshot).sha256, proof[name + 'Sha256']);
  }
  assert.equal(proof.guardRecoveryResumeFailureFile, m.stage + '/guard-recovery-resume-failed-882d6126-6a46-4065-b653-7e690f8623f2.json');
  assert.equal(proof.guardRecoveryResumeFailureSha256, '57d6aac94097ada524e4c027388855606866da562283a980af68991f5454e6ed');
  assert.equal(proof.originalRecoveryResumeFile, m.stage + '/guard-recovery-resume-d67c13d8-c9f0-475d-aa07-b9513acd2509.json');
  assert.equal(proof.originalRecoveryResumeSha256, '61bde2d4196ae5fa8505d6947cb5519b67bd29659e92b9eeb4a6676c50c1217b');
  const completed = proof.completedFullSchemaHeartbeat;
  assert.equal(completed.schema, 'sd2-completed-full-schema-heartbeat-verification.v1');
  assert.equal(completed.runId, m.runId); assert.equal(completed.source, m.mainSource); assert.equal(completed.guardSource, m.guardSource);
  assert.equal(completed.manifestSha256, proof.manifestSha256); assert.equal(completed.heartbeatKey, 'periodic_credit_worker');
  assert.equal(completed.originalTablesUnchangedExceptPeriodicCreditHeartbeat, true);
  assert.equal(completed.databaseWrites, 0); assert.equal(completed.ddlExecuted, false);
  assert.equal(proof.recoveryOnly, true); assert.equal(proof.continueMain, false); assert.equal(proof.newWriterStartAbsent, true);
  const { loaded } = successorJournal(m, runtime);
  const records = loaded.events.filter(item => item.value.kind === 'observation' && item.value.name === 'guard_heartbeat_repair');
  assert.equal(records.length, 1); const observed = records[0];
  assert.deepEqual(observed.value.value, { schema: 'sd2-release-guard-heartbeat-repair-reference.v1', proofFile: reference.proofFile, proofSha256: reference.proofSha256 });
  assert.equal(observed.value.previousSha256, proof.takeoverEventSha256);
  const takeover = loaded.events.find(item => item.sha256 === proof.takeoverEventSha256);
  assert.equal(takeover?.value.kind, 'owner_takeover'); assert.equal(takeover.value.previousSha256, proof.request.phaseResultEventSha256);
  assert.deepEqual(takeover.value.owner, observed.value.owner);
  return proof;
}

export function guardBuildTailRuntime(m) {
  const context = currentReleaseContext(), runtime = context?.guardBuildTail;
  if (!runtime) return null;
  assert.equal(runtime.schema, 'sd2-release-guard-build-tail-runtime.v1');
  assert.ok(TAIL_PHASES.includes(runtime.phase));
  assert.match(runtime.continuationSha256 || '', /^[a-f0-9]{64}$/);
  const bytes = rootFile(runtime.proofFile), proof = JSON.parse(bytes);
  assert.equal(sha(bytes), runtime.continuationSha256); assert.deepEqual(proof, runtime.proof);
  assert.equal(proof.schema, 'sd2-release-guard-build-tail-proof.v1');
  assert.equal(proof.runId, m.runId); assert.equal(proof.taskId, m.operation.taskId);
  assert.equal(proof.attemptId, m.operation.attemptId); assert.deepEqual(proof.engine, m.engine);
  assert.equal(proof.manifestSha256, sha(rootFile(m.stage + '/manifest.json')));
  assert.equal(proof.engine.root, engineDirectory(m)); assert.equal(proof.originalCompiledSnapshotUnavailable, true);
  processorBytes(proof, m); let active = proof;
  if (runtime.retry) {
    const retry = runtime.retry;
    assert.equal(retry.schema, 'sd2-release-guard-build-tail-retry-runtime.v1');
    assert.match(retry.proofSha256 || '', /^[a-f0-9]{64}$/);
    const retryBytes = rootFile(retry.proofFile), retryProof = JSON.parse(retryBytes);
    assert.equal(sha(retryBytes), retry.proofSha256); assert.deepEqual(retryProof, retry.proof);
    assert.equal(retryProof.schema, 'sd2-release-guard-build-tail-retry-proof.v1');
    assert.equal(retryProof.originalContinuationSha256, runtime.continuationSha256); assert.equal(retryProof.originalProofFile, runtime.proofFile);
    for (const name of ['runId', 'taskId', 'attemptId', 'manifestSha256']) assert.equal(retryProof[name], proof[name]);
    assert.deepEqual(retryProof.engine, proof.engine); processorBytes(retryProof, m); active = retryProof;
  }
  if (runtime.reader) {
    assert.ok(READER_PHASES.includes(runtime.phase), 'A successor reader cannot build or finish a build tail');
    assert.deepEqual(context.contract.engine, m.engine); assert.deepEqual(context.contract.operation, m.operation);
    assert.equal(runtime.reader.schema, 'sd2-release-reader-successor-runtime.v1');
    const reader = runtimeRootProof(runtime.reader, 'reader-successor-', 'sd2-release-reader-successor-proof.v1', m);
    assert.equal(reader.originalContinuationSha256, runtime.continuationSha256);
    assert.equal(reader.retryProofSha256, runtime.retry?.proofSha256 || null);
    assert.deepEqual(reader.predecessorProcessor, active.processor);
    assert.equal(reader.buildAuthority, false);
    assert.equal(reader.originalProofFile, runtime.proofFile); assert.equal(reader.retryProofFile, runtime.retry?.proofFile);
    assert.equal(reader.request.predecessorControllerSetSha256, active.processor.controllerSetSha256);
    assert.equal(reader.request.processorControllerSetSha256, reader.processor.controllerSetSha256);
    assert.equal(reader.request.originalContinuationSha256, runtime.continuationSha256);
    assert.equal(reader.request.retryProofSha256, runtime.retry?.proofSha256 || null);
    for (const name of ['batchFile', 'batchSha256', 'contextSha256', 'seedSha256', 'artifactsSha256']) assert.equal(reader[name], active[name]);
    processorBytes(reader, m); successorJournal(m, runtime); active = reader;
  } else assert.equal(runtime.candidateObservation, undefined, 'Independent observation requires its authorized reader');
  if (runtime.armPairRepair) {
    assert.ok(runtime.reader && runtime.candidateObservation, 'Arm pair repair must retain the original reader and observation');
    active = assertArmPairRepair(m, runtime, active);
  }
  if (runtime.armProcessorRepair) {
    assert.ok(runtime.armPairRepair, 'The processor repair must retain the consumed arm pair repair');
    active = assertArmProcessorRepair(m, runtime, active);
  }
  if (runtime.switchAdmissionRepair) {
    assert.ok(runtime.armProcessorRepair, 'The armed switch continuation must retain all earlier repair proofs');
    active = verifySwitchAdmissionRepair(m, runtime, active);
  }
  if (runtime.switchTypedRepair) {
    assert.ok(runtime.switchAdmissionRepair && runtime.candidateSwitchObservation, 'Typed switch repair must retain consumed admission and observation');
    active = verifySwitchTypedRepair(m, runtime, active);
  }
  if (runtime.switchScanRepair) {
    assert.ok(runtime.switchTypedRepair && runtime.candidateSwitchObservation, 'Scan repair must retain the consumed typed proof and candidate observation');
    active = verifySwitchTypedRepair(m, runtime, active, { scanStage: true });
  }
  if (runtime.switchOwnerRepair) {
    assert.ok(runtime.switchScanRepair && runtime.candidateSwitchObservation, 'Owner repair retains the consumed scan proof and candidate observation');
    active = verifySwitchTypedRepair(m, runtime, active, { ownerStage: true });
  }
  if (runtime.switchWindowRepair) {
    assert.ok(runtime.switchOwnerRepair && runtime.candidateSwitchOwnerObservation, 'Window repair retains its exact owner repair and full candidate observation');
    active = verifySwitchTypedRepair(m, runtime, active, { windowStage: true });
  }
  if (runtime.restoredOriginalRepair) {
    assert.ok(runtime.switchWindowRepair && runtime.restoredOriginalClosure, 'Restored repair retains the exact effectful failure and closed original restoration');
    active = verifyRestoredOriginalRepair(m, runtime, active);
  }
  if (runtime.guardRecoveryRepair) {
    assert.ok(runtime.restoredOriginalRepair, 'Guard recovery retains the actual restored continuation and effectful failure');
    active = verifyGuardRecoveryRepair(m, runtime, active);
  }
  if (runtime.guardHeartbeatRepair) {
    assert.ok(runtime.guardRecoveryRepair, 'Heartbeat recovery retains the consumed recovery proof and exact failed child');
    active = verifyGuardHeartbeatRepair(m, runtime, active);
  }
  assert.equal(path.dirname(fileURLToPath(import.meta.url)), active.processor.root);
  return runtime;
}

export function candidateCompatibilityDirectory(m) {
  const runtime = guardBuildTailRuntime(m);
  return ((runtime?.phase === 'recovery' ? runtime.guardHeartbeatRepair?.proof || runtime.guardRecoveryRepair?.proof : null) || runtime?.restoredOriginalRepair?.proof || runtime?.switchWindowRepair?.proof || runtime?.switchOwnerRepair?.proof || runtime?.switchScanRepair?.proof || runtime?.switchTypedRepair?.proof || runtime?.switchAdmissionRepair?.proof || runtime?.armProcessorRepair?.proof || runtime?.armPairRepair?.proof || runtime?.reader?.proof || runtime?.retry?.proof || runtime?.proof)?.processor.root || engineDirectory(m);
}

export function hdMaintenanceApprovalFile(m) {
  const runtime = guardBuildTailRuntime(m);
  return runtime?.restoredOriginalRepair?.proof.approvalFile || runtime?.switchWindowRepair?.proof.approvalFile || runtime?.switchOwnerRepair?.proof.approvalFile || runtime?.switchScanRepair?.proof.approvalFile || runtime?.switchTypedRepair?.proof.approvalFile || runtime?.switchAdmissionRepair?.proof.approvalFile || runtime?.armProcessorRepair?.proof.approvalFile || runtime?.armPairRepair?.proof.approvalFile || m.stage + '/hd-release-safety-approval.json';
}

export function assertSwitchAdmissionRepair(m) {
  const runtime = guardBuildTailRuntime(m);
  return runtime?.restoredOriginalRepair?.proof || runtime?.switchWindowRepair?.proof || runtime?.switchOwnerRepair?.proof || runtime?.switchScanRepair?.proof || runtime?.switchTypedRepair?.proof || runtime?.switchAdmissionRepair?.proof || null;
}
export function guardRecoveryApprovalFile(m) {
  const runtime = guardBuildTailRuntime(m);
  return runtime?.restoredOriginalRepair?.proof.oldGuardApprovalFile || runtime?.switchWindowRepair?.proof.oldGuardApprovalFile || runtime?.switchOwnerRepair?.proof.oldGuardApprovalFile || runtime?.switchScanRepair?.proof.oldGuardApprovalFile || runtime?.switchTypedRepair?.proof.oldGuardApprovalFile || runtime?.switchAdmissionRepair?.proof.oldGuardApprovalFile || runtime?.armProcessorRepair?.proof.approvalFile
    || runtime?.armPairRepair?.proof.approvalFile || m.stage + '/hd-release-safety-approval.json';
}

export function operationalLive(m, role) {
  const runtime = guardBuildTailRuntime(m), proof = runtime?.restoredOriginalRepair?.proof;
  if (!proof) return m.live?.[role];
  assert.ok(Object.hasOwn(proof.newLiveSnapshot, role));
  return proof.newLiveSnapshot[role];
}
export function operationalRecordName(m, name) {
  assert.match(name, /^[a-zA-Z0-9_.-]+$/);
  const runtime = guardBuildTailRuntime(m), repair = runtime?.restoredOriginalRepair;
  return repair ? name + '-' + repair.proofSha256 : name;
}
export function operationalBeforeFile(m) {
  const runtime = guardBuildTailRuntime(m);
  return runtime?.restoredOriginalRepair?.proof.restoredSwitchBeforeFile || m.stage + '/switch-before.json';
}
export function operationalNginxRunId(m) {
  const runtime = guardBuildTailRuntime(m);
  return runtime?.restoredOriginalRepair?.proof.maintenanceOperationId || m.runId;
}
export function operationalNginxStage(m) {
  const runtime = guardBuildTailRuntime(m), repair = runtime?.restoredOriginalRepair;
  return repair ? m.stage + '/nginx-restored-' + repair.proofSha256 : m.stage;
}

export function assertGuardBuildTailObservation(value, m, now = Date.now(), { requireFresh = true } = {}) {
  const runtime = guardBuildTailRuntime(m);
  assert.ok(runtime, 'Guard tail evidence requires its journal-bound compatible reader');
  const tail = value.tailPostchecks, request = runtime.proof.request;
  assert.equal(value.schema, GUARD_BUILD_TAIL_SCHEMA); assert.equal(value.label, 'guard');
  assert.equal(value.helperProbePhase, 'prepare');
  assert.equal(tail?.schema, 'sd2-guard-build-tail-seal.v1');
  assert.equal(tail.continuationSha256, runtime.continuationSha256); assert.equal(tail.proofFile, runtime.proofFile);
  if (runtime.retry) {
    assert.equal(tail.retryProofSha256, runtime.retry.proofSha256);
    assert.equal(tail.retryProofFile, runtime.retry.proofFile);
    const retryObservedAt = Date.parse(runtime.retry.proof.observedAt);
    assert.ok(Number.isSafeInteger(retryObservedAt) && tail.observedAt >= retryObservedAt);
  } else {
    assert.equal(tail.retryProofSha256, undefined); assert.equal(tail.retryProofFile, undefined);
  }
  assert.equal(tail.retainedOriginalCommand, true); assert.equal(tail.originalCompiledSnapshotUnavailable, true);
  assert.equal(tail.originalBuildCommandSha256, request.buildCommandSha256);
  assert.equal(value.logSha256, request.buildLogSha256);
  assert.equal(value.compiledTreeSha256, request.observedCompiledTreeSha256);
  assert.equal(value.startedAt, runtime.proof.originalBuild.startedAt);
  assert.equal(value.finishedAt, runtime.proof.originalBuild.finishedAt);
  assert.equal(value.build, runtime.proof.originalBuild.build);
  const requestObservedAt = typeof request.observedAt === 'number' ? request.observedAt : Date.parse(request.observedAt);
  assert.ok(Number.isSafeInteger(requestObservedAt));
  assert.ok(Number.isSafeInteger(tail.observedAt) && tail.observedAt >= value.finishedAt
    && tail.observedAt >= requestObservedAt && tail.observedAt <= now);
  assert.equal(tail.expiresAt, tail.observedAt + 1800000);
  if (requireFresh) assert.ok(now < tail.expiresAt, 'Guard tail observation expired; do not relabel its original successful command');
  return tail;
}

// A reader authorization never changes freshness. This independent root
// observation binds the full predecessor-verified immutable snapshots and the
// original receipts, while explicitly making no continuous-interval claim.
export function assertCandidateObservation(value, m, kind, now = Date.now()) {
  if (!isSharedEngine(m) || m.reuseBuilds) return null;
  const runtime = guardBuildTailRuntime(m);
  let reference = runtime?.candidateSwitchObservation || runtime?.candidateReobservation || runtime?.candidateObservation;
  if (!reference) return null;
  assert.ok(['main', 'guard'].includes(kind)); assert.ok(runtime.reader);
  assert.equal(reference.schema, 'sd2-release-candidate-observation-runtime.v1');
  let proof = runtimeRootProof(reference, 'candidate-observation-', CANDIDATE_OBSERVATION_SCHEMA, m);
  assert.equal(proof.originalContinuationSha256, runtime.continuationSha256);
  assert.equal(proof.retryProofSha256, runtime.retry?.proofSha256 || null);
  assert.equal(proof.readerProofSha256, runtime.reader.proofSha256);
  const { loaded, readerRecord } = successorJournal(m, runtime);
  const originalReference = runtime.candidateObservation;
  const original = runtimeRootProof(originalReference, 'candidate-observation-', CANDIDATE_OBSERVATION_SCHEMA, m);
  const observations = loaded.events.filter(item => item.value.kind === 'observation' && item.value.name === 'candidate_observation');
  assert.equal(observations.length, 1);
  const journal = observations[0]; assert.ok(journal.value.sequence > readerRecord.value.sequence);
  assert.equal(journal.value.previousSha256, readerRecord.sha256); assert.deepEqual(journal.value.owner, readerRecord.value.owner);
  assert.deepEqual(journal.value.value, { schema: 'sd2-release-candidate-observation-reference.v1', proofFile: originalReference.proofFile, proofSha256: originalReference.proofSha256 });
  assert.equal(original.eventHeadSha256, runtime.reader.proof.eventHeadSha256);
  let verifierProcessor = runtime.retry?.proof || runtime.proof;
  if (runtime.candidateReobservation) {
    assert.ok(runtime.armProcessorRepair, 'A repeated observation belongs only to the exact processor repair');
    const priorReference = runtime.candidateReobservation;
    const prior = runtimeRootProof(priorReference, 'candidate-observation-', CANDIDATE_OBSERVATION_SCHEMA, m);
    assert.notEqual(priorReference.proofSha256, originalReference.proofSha256);
    assert.equal(prior.previousObservationProofSha256, originalReference.proofSha256);
    assert.equal(prior.armProcessorRepairProofSha256, runtime.armProcessorRepair.proofSha256);
    const fresh = loaded.events.filter(item => item.value.kind === 'observation' && item.value.name === 'candidate_reobservation');
    assert.equal(fresh.length, 1); const event = fresh[0];
    assert.deepEqual(event.value.value, { schema: 'sd2-release-candidate-observation-reference.v1', proofFile: priorReference.proofFile, proofSha256: priorReference.proofSha256 });
    assert.equal(event.value.previousSha256, prior.eventHeadSha256);
    const head = loaded.events[loaded.events.indexOf(event) - 1]; assert.equal(head.sha256, prior.eventHeadSha256);
    assert.deepEqual(event.value.owner, head.value.owner);
    assert.ok(prior.verifier.startedAt >= original.expiresAt, 'A new observation must actually verify after the original observation expired');
    verifierProcessor = runtime.armProcessorRepair.proof;
    if (runtime.candidateSwitchObservation) {
      assert.ok(runtime.switchAdmissionRepair, 'A switch observation belongs only to the exact armed continuation');
      assert.notEqual(reference.proofSha256, priorReference.proofSha256);
      assert.equal(proof.previousObservationProofSha256, priorReference.proofSha256);
      assert.equal(proof.switchAdmissionRepairProofSha256, runtime.switchAdmissionRepair.proofSha256);
      assert.equal(runtime.switchAdmissionRepair.proof.candidateObservationProofSha256, priorReference.proofSha256);
      assert.equal(runtime.switchAdmissionRepair.proof.candidateObservationProofFile, priorReference.proofFile);
      assert.deepEqual(proof.candidates, prior.candidates); assert.deepEqual(prior.candidates, original.candidates);
      assert.equal(prior.verifier.file, verifierProcessor.processor.root + '/candidate-reuse.mjs');
      assert.equal(prior.verifier.sha256, verifierProcessor.processorControllers['candidate-reuse.mjs']);
      assert.equal(sha(rootFile(prior.verifier.file)), prior.verifier.sha256); assert.equal(prior.verifier.method, 'verifyOriginalSuccess');
      assert.ok(Number.isSafeInteger(prior.verifier.startedAt) && Number.isSafeInteger(prior.verifier.finishedAt)
        && prior.verifier.finishedAt >= prior.verifier.startedAt && prior.verifier.finishedAt === prior.observedAt);
      assert.equal(prior.expiresAt, prior.observedAt + 1800000);
      for (const [flag, expected] of Object.entries({ readOnly: true, newCompilationClaimed: false, originalTimesChanged: false,
        continuousUnchangedIntervalClaimed: false })) assert.equal(prior[flag], expected);
      assert.equal(prior.protectionComparison, 'assertProtection'); assert.deepEqual(prior.protectionFields, PROTECTION_FIELDS);
      assert.match(prior.protectionSha256 || '', /^[a-f0-9]{64}$/);
      const switched = loaded.events.filter(item => item.value.kind === 'observation' && item.value.name === 'candidate_switch_observation');
      assert.equal(switched.length, 1); const observed = switched[0];
      assert.deepEqual(observed.value.value, { schema: 'sd2-release-candidate-observation-reference.v1', proofFile: reference.proofFile, proofSha256: reference.proofSha256 });
      assert.equal(observed.value.previousSha256, proof.eventHeadSha256);
      const previous = loaded.events[loaded.events.indexOf(observed) - 1]; assert.equal(previous.sha256, proof.eventHeadSha256);
      assert.deepEqual(observed.value.owner, previous.value.owner);
      const repair = loaded.events.find(item => item.value.kind === 'observation' && item.value.name === 'switch_admission_repair');
      assert.ok(repair && repair.value.sequence < observed.value.sequence);
      assert.equal(repair.value.value.proofSha256, runtime.switchAdmissionRepair.proofSha256);
      assert.ok(proof.verifier.startedAt >= prior.expiresAt, 'A switch observation must actually verify after the previous observation expired');
      verifierProcessor = runtime.switchAdmissionRepair.proof;
    } else assert.equal(reference.proofSha256, priorReference.proofSha256);
  } else {
    assert.equal(runtime.candidateSwitchObservation, undefined, 'A switch observation must retain the previous observation');
    assert.equal(proof.eventHeadSha256, runtime.reader.proof.eventHeadSha256);
  }
  if (runtime.candidateSwitchOwnerObservation) {
    assert.ok(runtime.switchOwnerRepair && runtime.candidateSwitchObservation, 'Owner observation requires its exact repair and the retained switch observation');
    const priorReference = reference, prior = proof, oldVerifier = prior.verifier;
    assert.equal(priorReference.proofSha256, runtime.switchOwnerRepair.proof.originalCandidateSwitchObservationProofSha256);
    for (const [flag, expected] of Object.entries({ readOnly: true, newCompilationClaimed: false, originalTimesChanged: false,
      continuousUnchangedIntervalClaimed: false })) assert.equal(prior[flag], expected);
    assert.equal(prior.protectionComparison, 'assertProtection'); assert.deepEqual(prior.protectionFields, PROTECTION_FIELDS);
    assert.match(prior.protectionSha256 || '', /^[a-f0-9]{64}$/);
    assert.equal(oldVerifier.method, 'verifyOriginalSuccess'); assert.equal(oldVerifier.file, verifierProcessor.processor.root + '/candidate-reuse.mjs');
    assert.equal(oldVerifier.sha256, verifierProcessor.processorControllers['candidate-reuse.mjs']);
    assert.equal(sha(rootFile(oldVerifier.file)), oldVerifier.sha256);
    assert.ok(Number.isSafeInteger(oldVerifier.startedAt) && Number.isSafeInteger(oldVerifier.finishedAt)
      && oldVerifier.finishedAt >= oldVerifier.startedAt && oldVerifier.finishedAt === prior.observedAt && oldVerifier.finishedAt <= now);
    assert.equal(prior.expiresAt, prior.observedAt + 1800000);
    reference = runtime.candidateSwitchOwnerObservation;
    assert.equal(reference.schema, 'sd2-release-candidate-observation-runtime.v1');
    proof = runtimeRootProof(reference, 'candidate-observation-', CANDIDATE_OBSERVATION_SCHEMA, m);
    assert.notEqual(reference.proofSha256, priorReference.proofSha256);
    assert.equal(proof.previousObservationProofSha256, priorReference.proofSha256);
    assert.equal(proof.switchOwnerRepairProofSha256, runtime.switchOwnerRepair.proofSha256);
    for (const key of ['runId', 'taskId', 'attemptId', 'manifestSha256', 'originalContinuationSha256', 'retryProofSha256', 'readerProofSha256'])
      assert.equal(proof[key], prior[key]);
    assert.deepEqual(proof.engine, prior.engine); assert.deepEqual(proof.candidates, prior.candidates);
    const records = loaded.events.filter(item => item.value.kind === 'observation' && item.value.name === 'candidate_switch_owner_observation');
    assert.equal(records.length, 1); const observed = records[0];
    assert.deepEqual(observed.value.value, { schema: 'sd2-release-candidate-observation-reference.v1', proofFile: reference.proofFile, proofSha256: reference.proofSha256 });
    assert.equal(observed.value.previousSha256, proof.eventHeadSha256);
    const previous = loaded.events[loaded.events.indexOf(observed) - 1]; assert.equal(previous.sha256, proof.eventHeadSha256);
    assert.deepEqual(observed.value.owner, previous.value.owner);
    const repair = loaded.events.find(item => item.value.kind === 'observation' && item.value.name === 'switch_owner_repair');
    assert.ok(repair && repair.value.sequence < observed.value.sequence);
    assert.equal(repair.value.value.proofSha256, runtime.switchOwnerRepair.proofSha256);
    assert.ok(proof.verifier.startedAt >= prior.expiresAt, 'Owner observation verifies only after the retained switch observation expired');
    verifierProcessor = runtime.switchOwnerRepair.proof;
  }
  if (runtime.candidateRestoredOriginalObservation) {
    assert.ok(runtime.restoredOriginalRepair && runtime.candidateSwitchOwnerObservation);
    const priorReference = reference, prior = proof, priorVerifier = prior.verifier;
    assert.equal(priorReference.proofSha256, runtime.candidateSwitchOwnerObservation.proofSha256);
    assert.equal(priorVerifier.file, verifierProcessor.processor.root + '/candidate-reuse.mjs');
    assert.equal(priorVerifier.sha256, verifierProcessor.processorControllers['candidate-reuse.mjs']);
    assert.equal(sha(rootFile(priorVerifier.file)), priorVerifier.sha256);
    assert.equal(prior.expiresAt, prior.observedAt + 1800000);
    reference = runtime.candidateRestoredOriginalObservation;
    assert.equal(reference.schema, 'sd2-release-candidate-observation-runtime.v1');
    proof = runtimeRootProof(reference, 'candidate-observation-', CANDIDATE_OBSERVATION_SCHEMA, m);
    assert.notEqual(reference.proofSha256, priorReference.proofSha256);
    assert.equal(proof.previousObservationProofSha256, priorReference.proofSha256);
    assert.equal(proof.restoredOriginalRepairProofSha256, runtime.restoredOriginalRepair.proofSha256);
    for (const key of ['runId', 'taskId', 'attemptId', 'manifestSha256', 'originalContinuationSha256', 'retryProofSha256', 'readerProofSha256'])
      assert.equal(proof[key], prior[key]);
    assert.deepEqual(proof.engine, prior.engine); assert.deepEqual(proof.candidates, prior.candidates);
    const records = loaded.events.filter(item => item.value.kind === 'observation' && item.value.name === 'candidate_restored_original_observation');
    assert.equal(records.length, 1); const observed = records[0];
    assert.deepEqual(observed.value.value, { schema: 'sd2-release-candidate-observation-reference.v1', proofFile: reference.proofFile, proofSha256: reference.proofSha256 });
    assert.equal(observed.value.previousSha256, proof.eventHeadSha256);
    const previous = loaded.events[loaded.events.indexOf(observed) - 1]; assert.equal(previous.sha256, proof.eventHeadSha256);
    assert.deepEqual(observed.value.owner, previous.value.owner);
    const repair = loaded.events.find(item => item.value.kind === 'observation' && item.value.name === 'restored_original_repair');
    assert.ok(repair && repair.value.sequence < observed.value.sequence);
    assert.equal(repair.value.value.proofSha256, runtime.restoredOriginalRepair.proofSha256);
    assert.ok(proof.verifier.startedAt >= prior.expiresAt, 'Restored-original observation must verify after the old owner observation actually expired');
    verifierProcessor = runtime.restoredOriginalRepair.proof;
  }
  for (const [flag, expected] of Object.entries({ readOnly: true, newCompilationClaimed: false, originalTimesChanged: false,
    continuousUnchangedIntervalClaimed: false })) assert.equal(proof[flag], expected);
  assert.equal(proof.protectionComparison, 'assertProtection'); assert.deepEqual(proof.protectionFields, PROTECTION_FIELDS);
  assert.match(proof.protectionSha256 || '', /^[a-f0-9]{64}$/);
  const verifier = proof.verifier;
  assert.equal(verifier.method, 'verifyOriginalSuccess'); assert.equal(verifier.file, verifierProcessor.processor.root + '/candidate-reuse.mjs');
  assert.equal(verifier.sha256, verifierProcessor.processorControllers['candidate-reuse.mjs']);
  assert.equal(sha(rootFile(verifier.file)), verifier.sha256);
  assert.ok(Number.isSafeInteger(verifier.startedAt) && verifier.startedAt > 0 && Number.isSafeInteger(verifier.finishedAt)
    && verifier.finishedAt >= verifier.startedAt && verifier.finishedAt === proof.observedAt && verifier.finishedAt <= now);
  assert.equal(proof.expiresAt, proof.observedAt + 1800000);
  assert.ok(now < proof.expiresAt, 'Independent candidate observation expired');
  assert.deepEqual(Object.keys(proof.candidates).sort(), ['guard', 'main']);
  for (const role of ['main', 'guard']) {
    const record = proof.candidates[role], authorized = runtime.reader.proof.successfulArtifacts[role].inputs;
    assert.equal(record.capsuleFile, authorized.capsule.file); assert.equal(record.capsuleSha256, authorized.capsule.sha256);
    assert.equal(record.receiptFile, authorized.build.file); assert.equal(record.receiptSha256, authorized.build.sha256);
    assert.equal(record.capsuleFile, m.stage + '/' + role + '-immutable-success.json');
    const capsuleBytes = rootFile(record.capsuleFile, 128 * 1024 * 1024), capsule = JSON.parse(capsuleBytes);
    assert.equal(sha(capsuleBytes), record.capsuleSha256);
    assert.equal(capsule.kind, role); assert.equal(capsule.sourceRun, m.runId);
    assert.equal(capsule.originalManifestSha256, proof.manifestSha256);
    assert.equal(record.receiptFile, m.stage + '/' + role + '-build.json');
    assert.equal(capsule.originalReceiptFile, record.receiptFile); assert.equal(capsule.originalReceiptSha256, record.receiptSha256);
    const receiptBytes = rootFile(record.receiptFile), receipt = JSON.parse(receiptBytes);
    assert.equal(sha(receiptBytes), record.receiptSha256); assert.deepEqual(capsule.originalReceipt, receipt);
    assert.equal(receipt.source, m[role].source); assert.equal(receipt.version, m[role].version); assert.equal(receipt.label, role);
    assert.equal(receipt.runId, m.runId); assert.equal(receipt.exitCode, 0); assert.equal(receipt.verifiedSourceAndGates, true);
    assert.ok(receipt.startedAt <= receipt.finishedAt && receipt.finishedAt <= verifier.startedAt);
    assert.equal(capsule.originalTimesChanged, false); assert.equal(capsule.newCompilationClaimed, false);
    assert.equal(capsule.originalSourceManifestSha256, sha(rootFile(m[role].sourceManifest)));
    assert.equal(capsule.originalPreparedSha256, sha(rootFile(m.stage + '/' + role + '-prepared.json')));
    for (const field of ['sourceFiles', 'lock', 'dependencies', 'build', 'checks', 'buildEnvironment', 'node', 'env', 'bindings'])
      assert.ok(capsule.snapshot?.[field] && typeof capsule.snapshot[field] === 'object', 'Incomplete freshly verified candidate snapshot: ' + field);
    assert.equal(sha(JSON.stringify(capsule.snapshot)), record.snapshotSha256);
    if (role === kind) assert.deepEqual(value, receipt, 'Independent observation may only admit its exact original successful receipt');
  }
  if (kind === 'guard') assertGuardBuildTailObservation(value, m, now, { requireFresh: false });
  else assert.equal(value.schema, 'rate-impl2-candidate-build.v1');
  return proof;
}
export function candidateGateObservation(value, m, kind, now = Date.now()) {
  const observation = assertCandidateObservation(value, m, kind, now);
  if (observation) {
    const runtime = guardBuildTailRuntime(m);
    return { manifest: m, runtime, observedAt: observation.observedAt, candidateObservation: runtime.candidateRestoredOriginalObservation || runtime.candidateSwitchOwnerObservation || runtime.candidateSwitchObservation || runtime.candidateReobservation || runtime.candidateObservation };
  }
  if (kind !== 'guard' || value.schema !== GUARD_BUILD_TAIL_SCHEMA) return undefined;
  const runtime = guardBuildTailRuntime(m); assert.ok(runtime);
  return { manifest: m, runtime, observedAt: value.tailPostchecks?.observedAt ?? now };
}

export function candidateEvidenceExpiresAt(value, m, kind, now = Date.now()) {
  const observation = assertCandidateObservation(value, m, kind, now);
  if (observation) return observation.expiresAt;
  if (!m.reuseBuilds && kind === 'guard' && value.schema === GUARD_BUILD_TAIL_SCHEMA)
    return assertGuardBuildTailObservation(value, m, now).expiresAt;
  return m.reuseBuilds ? value.expiresAt : value.startedAt + 1800000;
}
export function candidateEvidenceFile(m, kind) {
  assert.ok(['main', 'guard'].includes(kind));
  return m.stage + '/' + kind + (m.reuseBuilds ? '-candidate-reuse.json' : '-build.json');
}
export function assertFreshCandidateEvidence(value, m, kind, now = Date.now()) {
  if (isSharedEngine(m)) {
    engineDirectory(m);
    assert.deepEqual(value.engine, m.engine, 'Candidate admission belongs to another engine controller set');
    assert.deepEqual(value.operation, m.operation, 'Candidate admission belongs to another task or attempt');
  }
  assert.equal(value.label, kind); assert.equal(value.runId, m.runId);
  assert.equal(value.source, m[kind].source); assert.equal(value.version, m[kind].version);
  assert.equal(value.exitCode, 0); assert.equal(value.verifiedSourceAndGates, true);
  assert.ok(Number.isSafeInteger(value.startedAt) && value.startedAt > 0 && Number.isSafeInteger(value.finishedAt)
    && value.startedAt <= value.finishedAt && value.finishedAt <= now);
  if (assertCandidateObservation(value, m, kind, now)) return value;
  if (!m.reuseBuilds) {
    if (kind === 'guard' && value.schema === GUARD_BUILD_TAIL_SCHEMA) {
      assertGuardBuildTailObservation(value, m, now); return value;
    }
    assert.equal(value.schema, 'rate-impl2-candidate-build.v1');
    assert.ok(now - value.startedAt < 1800000, 'Original full-build candidate gate is stale'); return value;
  }
  assert.equal(value.schema, REUSE_SCHEMA); assert.equal(value.newCompilationClaimed, false);
  assert.equal(value.originalTimesChanged, false); assert.equal(value.reuseInputsFullyVerified, true);
  assert.equal(value.originalSuccessSha256, m.reuseBuilds[kind].sha256);
  const original = value.originalBuild; assert.ok(original && original.runId !== m.runId);
  assert.equal(original.runId, m.reuseBuilds.sourceRun);
  for (const key of ['source', 'version', 'build', 'startedAt', 'finishedAt', 'gateReceipt']) assert.deepEqual(value[key], original[key]);
  assert.equal(original.exitCode, 0); assert.equal(original.verifiedSourceAndGates, true);
  assert.ok(Number.isSafeInteger(value.validatedAt) && value.validatedAt >= value.finishedAt && value.validatedAt <= now);
  assert.equal(value.expiresAt, value.validatedAt + 1800000);
  assert.ok(now < value.expiresAt, 'Fresh candidate reuse admission expired; a new integrity/contract check is required, not an automatic full compile');
  return value;
}
