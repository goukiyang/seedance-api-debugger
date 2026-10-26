import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { rootFile, sha, call, unit, isSharedEngine, engineDirectory } from './common.mjs';
import { inspectFixedGuardArtifact } from './guard-recovery.mjs';
import { verifyFixedProgramEntry, capturePricingStartControl, PRICING_START_CONTROL } from './pricing-start-pair.mjs';
import { inspectMultiviewWorksProtection } from './multiview-works-control.mjs';

// Only these retained recoveries; none is a publication, continuation or build-age exception.
export const R08_RECOVERED_GUARD = Object.freeze({
  schema: 'sd2-multiview-r08-recovered-guard.v1',
  runId: '7370f24f-6cba-42ae-9602-d49124f3abae',
  manifestSha256: 'a98ce0bada88446b8ebbb2f4c0e21fdc94880acf6e608d78dc61cc44f77a9a57',
  fixedGuardSha256: 'a86481fc85a827788e564cb1339184b64ed4e812cb53043365f04f69491b7fc2',
  guardBuildReceiptSha256: 'edc34f32fa176ec487b665525d4ef17597a5a83c433b551aafcd929ac153c517',
  guardImmutableSuccessSha256: '44e33faaa301dc00eb8c77e5459f6adbf9e3d35d1a54c8cccd2189437ca187ee',
  recoveryCompleteSha256: '54b300fbb7c1bccff8d0e8648da64bcfbea566c15d002663ef8654d488634145',
  switchCommandSha256: '487eb85cb861aa0d8ce2def3f5c421f4188141cc0d7133fd425bc9f592b9eec7',
  proofSha256: '6918a2124c9943c6dc7076d9d9bda3d0821b25076a4bde48e8e4cf42c60e1edb',
  proofCommandSha256: 'c49d8b0f5aa8d2f88f2cc8020fbc1950f4804d15114366cdb5e1f9b38c5afe91',
});
export const R10_RECOVERED_GUARD = Object.freeze({
  schema: 'sd2-multiview-r10-recovered-guard.v1',
  runId: '7a2b5381-e43f-4bfa-8377-019a91bfb8f5',
  manifestSha256: 'ed23f65e91aea8037b490e25e2a2889d95e8895a4f878963bacb8254bd1486f9',
  fixedGuardSha256: '4156c603ef918f434ed0666ecd5fa40f78d1b4cfbc2d89de97c2b510fe989254',
  guardBuildReceiptSha256: 'e5509d7727ac06b5dcfed767b6297321640cf7e16b27f9b655737206d6418c39',
  guardImmutableSuccessSha256: '9a5f41b3214d3f2aa04583d180bdd9d3db77bd3a6629dfe6f0c86f5822d1c097',
  recoveryCompleteSha256: 'ab0a2224d1362cb5596f3fe5d56600b62da9fc3b332be5fb51882fcb317c2cfb',
  switchCommandSha256: 'f29b8fa7b52ed91748ebb26350624fb095848f917b5d77e65c1c4a854ee36dac',
  proofSha256: '06e1a94e3e48c61c1295d25119614e377b19df87d3a64e58dba36ef4ca4421c7',
  proofCommandSha256: '3da9189d8501a8b26ec0bd719cfbe90d02018be08138d75b21931a049e62924b',
  recoveryEvidenceIndexSha256: 'e0f48916580b2df60216873118719f41e4deab1d160d081abb17dceb4d4c05d9',
  worksReadyGuardSha256: '9e91a1710036118d66f7caed54a5398f92195e35b4d67d2040cc65ae8a6c742d',
});
export const R14_RECOVERED_GUARD = Object.freeze({
  schema: 'sd2-multiview-r14-recovered-guard.v1', runId: '53c8aa71-6457-40ff-a913-b2bd3a4a2234',
  manifestSha256: 'e3a010bd79aaad49e8cc0cee6b7a4a0e316655940cd626799cd1e254d980e5b5',
  fixedGuardSha256: '68443a6fb736632bbb4cc20fc328c6ef733fc87423d78b6794d5fd8738fc7b7c',
  guardBuildReceiptSha256: '0b950c4323679c63dd7b644e2f910cfa6871e095592d24f3bf0600826095bf01',
  guardImmutableSuccessSha256: '20d8d24c36a894e394b3cdbf9e8965dbb5b046353fde04d1ef587a4cd2b040fa',
  recoveryCompleteSha256: 'cf4ed9e32e07b3b7133fe366cc9f3ff64523ff1583497317859ba6c461f045e4',
  switchCommandSha256: 'e2f9c6798421381327955ca1a2322fc7ff655fd16b5fd7f6ca08c116959ecc28',
  proofSha256: 'e81a6ad94c86cd7dfd88551c3545c00053cb7b57fe0f141ca11fb00a864fda39',
  proofCommandSha256: 'b91bd983638a35c30d21d09ec5933b03f1846c4c02b60b0fe129138cb8f0603c',
  recoveryEvidenceIndexSha256: '21e383079820a329244b2252f3398057edecd27d43a12ea0cfba5adaf4c9c599',
  worksReadyGuardSha256: '15d5f6f28bd4f7d7a64d040a8e09d188e3a08490a4a0df7c7e074c8ed87ccdde',
});
export const R17_RECOVERED_GUARD = Object.freeze({
  schema: 'sd2-multiview-r17-recovered-guard.v1',
  runId: '19a7cc3d-b11e-44c8-a754-d79e9c5624d1',
  manifestSha256: '00d4c9fa89a4368d0761adff3017ff2e58dcd8e58cc76b7698c3bab167cce7c8',
  fixedGuardSha256: '36c9e71ebc74a8b0fb6c8870b9681a29076a75035fdde4c1a6846fc6b18a4971',
  guardBuildReceiptSha256: 'a78c79ba444819c9b2f88cb6de9590c02b8dbdcb0d9650adb234971d2f1a3866',
  guardImmutableSuccessSha256: '85a85eb392ca6fcf7c9f83d3317106c923bfec90003d7346f7f2c7732636576e',
  recoveryCompleteSha256: 'd4c3feb67e7441cd74b6df492a5ed2652e3a1e1473310f7952ee2a09651dce9b',
  switchCommandSha256: '478ea114c76323b1a987f8909ca5c4e92466df33687f6c302541af7e0a5bbd0b',
  proofSha256: '7477870f7c033afabc113a9ef5761f061fc08e0777467c5f03795e9cc6d237f8',
  proofCommandSha256: '30c151df4647b1d98cfe10b2d27b666a4ba703d1969d1c092639f49271b38c70',
  recoveryEvidenceIndexSha256: 'd76bc0fa5808b68a5c4b2c347dfbb3d736d6c568b7b5f2d45deb5c54034b5081',
  worksReadyGuardSha256: '0f4d7005c95d638cbb8cc93006060f1b23db0032a00186a0bdb94adb3b99a724',
  installedRecipeReceiptSha256: 'ab71ea60b1a7c54f405910ce76389a0a21181058fbb7a81715afd0a47a2349b3',
  backupCaptureSha256: '9968b7d35f258f185e79b51bea38c6e5566dcdc4f9998d8333da1f87a06461d6',
  backupTransitionSha256: '01fbea5139db7184ae14238c6b11bf317b648b5bba248e698dcb09a1d2e0a97f',
  backupPublishedSha256: '78d22884d7bacdbf9d20d8c2d491ab9898f7518100116f037cd5620d58d49e88',
});
const VERSION = '0.103.0+multiview-private-guard.1';
const ROLES = ['web', 'image', 'hd', 'role'];
const roleState = (proof, role) => role === 'role' ? proof.role.current : proof.units[role];
export function assertRecoveredGuardInput(input) {
  const expected = input?.schema === R17_RECOVERED_GUARD.schema ? R17_RECOVERED_GUARD
    : input?.schema === R14_RECOVERED_GUARD.schema ? R14_RECOVERED_GUARD
    : input?.schema === R10_RECOVERED_GUARD.schema ? R10_RECOVERED_GUARD : R08_RECOVERED_GUARD;
  assert.deepEqual(input, expected, 'Only the exact retained R08/c9, R10/2c, R14/e06 or R17/31b recovery is an admitted baseline');
  return input;
}
function time(value) { const at = Date.parse(value); assert.ok(Number.isFinite(at) && at <= Date.now()); return at; }
function bound(value, input) { assert.equal(value.runId, input.runId); assert.equal(value.manifestSha256, input.manifestSha256); return value; }
function recoveredProgram(input) {
  if (input.schema === R17_RECOVERED_GUARD.schema)
    return { source: '31bff5a6544a3d18d433b81fa7735ed57b0d012c', build: 'j0osjBFM7wvoP8iAYEknx' };
  if (input.schema === R14_RECOVERED_GUARD.schema)
    return { source: 'e06d23538ea110a8c7800729bd8b84eaee697091', build: 'UgLJVYXAPzAtIB-K4PnB3' };
  return input.schema === R10_RECOVERED_GUARD.schema
    ? { source: '2c1eafbd875fceeca63ddfe0da0e08c15bb9cbb7', build: 'j2d9GY6_bj4uOIMROXnsi' }
    : { source: 'c9f0a60d753b286db470626ad33c1987ff1c72bf', build: 'B7Ef-SggrUGg4-T5FAA_0' };
}
function assertR10RecoveryRecords(m, records, entry) {
  const input = R10_RECOVERED_GUARD, { recoveryEvidenceIndex: index, recoveryEvidence: evidence } = records;
  assert.equal(sha(Buffer.from(JSON.stringify(index, null, 2) + '\n')), input.recoveryEvidenceIndexSha256);
  assert.equal(index.schema, 'mv-r10-failure-recovery-evidence.v1'); assert.equal(index.runId, input.runId);
  assert.equal(Object.keys(index.pins).length, 47);
  assert.deepEqual(Object.keys(evidence).sort(), Object.keys(index.pins).sort());
  // These two original stdout/publication records use compact JSON. All other
  // retained records use the original indented writer; never normalize history.
  for (const [name, digest] of Object.entries(index.pins)) {
    assert.equal(path.basename(name), name);
    const compact = ['allowed-original.json.published.json', 'guard-baseline-readonly-proof.json'].includes(name);
    assert.equal(sha(Buffer.from(JSON.stringify(evidence[name], null, compact ? undefined : 2) + '\n')), digest,
      'Retained R10 recovery record changed: ' + name);
  }
  for (const [key, name] of Object.entries({ prior: 'manifest.json', fixed: 'fixed-guard-recovery.json', build: 'guard-build.json',
    seal: 'guard-immutable-success.json', complete: 'guard-recovery-complete.json', command: 'normal-switch-command-return.json',
    proof: 'guard-baseline-readonly-proof.json', proofCommand: 'guard-baseline-readonly-proof-command.json',
    pricingPublication: 'allowed-original.json.published.json' })) assert.deepEqual(records[key], evidence[name]);
  assert.equal(index.pins['multiview-works-ready-guard.json'], input.worksReadyGuardSha256);
  const { prior, complete, command, proofCommand } = records;
  assert.equal(prior.mainSource, 'eae4475e5da2ebf3b68c31593a37117b59e6a09a');
  assert.deepEqual(prior.recoveredGuardBaseline, R08_RECOVERED_GUARD);
  assert.equal(command.schema, 'mv-normal-switch-command.v1'); assert.equal(command.error, null);
  const get = name => evidence[name], admission = bound(get('r10-works-recovery-admission.json'), input);
  const stopped = bound(get('r10-works-natural-stop.json'), input), continuation = bound(get('r10-works-recovery-continuation.json'), input);
  assert.equal(admission.schema, 'r10-exact-works-recovery-admission.v1'); assert.equal(admission.guardOnly, true);
  assert.equal(admission.facts.privateApplied, false); assert.equal(admission.facts.guardStartAttempted, false);
  assert.equal(stopped.schema, 'r10-verified-works-natural-stop.v1');
  assert.equal(stopped.naturalExit, true); assert.equal(stopped.forcedKill, false); assert.equal(stopped.businessDataRestored, false);
  assert.equal(stopped.after.ActiveState, 'inactive'); assert.equal(stopped.after.MainPID, '0'); assert.equal(stopped.after.ControlPID, '0');
  assert.equal(stopped.after.Result, 'success'); assert.equal(stopped.after.ExecMainStatus, '0');
  assert.equal(continuation.schema, 'r10-exact-works-recovery-continuation.v1');
  assert.equal(continuation.stopSha256, index.pins['r10-works-natural-stop.json']);
  assert.equal(continuation.admissionSha256, index.pins['r10-works-recovery-admission.json']);
  const wrapper = get('r10-before-wrapper-admission.json'), exact = get('r10-exact-recovery-complete.json');
  assert.equal(wrapper.schema, 'r10-before-wrapper-engineering.v1'); assert.equal(wrapper.runId, input.runId);
  assert.equal(wrapper.allNonRunIdBeforeFieldsExact, true); assert.equal(wrapper.worksNaturalStopVerified, true);
  assert.equal(wrapper.guardStartAttempted, false); assert.equal(wrapper.productionWrites, 0);
  assert.equal(wrapper.token.schema, 'r10-exact-before-wrapper-continuation.v1'); assert.equal(wrapper.token.runId, input.runId);
  assert.equal(wrapper.token.beforeSha256, index.pins['switch-before.json']);
  assert.deepEqual(wrapper.token.worksContinuation, continuation);
  assert.equal(Object.hasOwn(wrapper.token.before, 'runId'), false);
  assert.deepEqual({ runId: input.runId, ...wrapper.token.before }, get('switch-before.json'));
  assert.equal(exact.schema, 'r10-exact-recovery-complete.v1'); assert.equal(exact.runId, input.runId);
  assert.equal(exact.normalPublication, false);
  const { token: _token, pid: _pid, ...verified } = wrapper; assert.deepEqual(exact.verified, verified);
  const { manifestSha256: _manifestSha256, ...result } = complete; assert.deepEqual(exact.result, result);
  assert.ok(time(command.at) < time(admission.at) && time(admission.at) <= time(stopped.at)
    && time(stopped.at) <= time(wrapper.at) && time(wrapper.at) <= time(complete.startedAt)
    && time(complete.startedAt) <= time(complete.finishedAt) && time(complete.finishedAt) <= time(exact.at)
    && time(exact.at) <= time(proofCommand.start));
  assert.equal(proofCommand.stdoutSha256, input.proofSha256);
  assert.equal(proofCommand.stderrSha256, sha(Buffer.alloc(0)));
  const names = Object.keys(index.pins).filter(name => /^multiview-works-transition-\d{4}\.json$/.test(name)).sort();
  assert.equal(names.length, 15);
  names.forEach((name, i) => {
    const transition = bound(get(name), input); assert.equal(transition.sequence, i + 1);
    assert.equal(transition.previousSha256, i ? index.pins[names[i - 1]] : null);
    if (i) assert.ok(time(transition.at) >= time(get(names[i - 1]).at));
  });
  const old = bound(get('multiview-works-before.json'), input), main = bound(get('multiview-works-ready-main.json'), input);
  assert.equal(String(prior.live.works.pid), old.current.MainPID); assert.equal(prior.live.works.invocation, old.current.InvocationID);
  assert.equal(prior.live.works.execMainStartTimestampMonotonic, old.current.ExecMainStartTimestampMonotonic);
  assert.equal(main.kind, 'main'); assert.equal(main.source, prior.mainSource); assert.equal(main.naturalExit, true);
  for (const key of Object.keys(main.current)) assert.equal(stopped.before.current[key], main.current[key]);
  assert.notEqual(main.current.MainPID, stopped.after.MainPID);
  const ready = bound(get('multiview-works-ready-guard.json'), input), works = complete.healthy.multiviewWorks;
  assert.equal(ready.schema, 'multiview-works-ready.v1'); assert.equal(ready.kind, 'guard'); assert.equal(works.kind, 'guard');
  assert.equal(ready.unit, 'sd2-multiview-works.service'); assert.equal(ready.naturalExit, true);
  for (const key of ['source', 'version', 'build']) assert.equal(ready[key], entry[key]);
  for (const key of Object.keys(ready.current)) assert.equal(works.current[key], ready.current[key]);
  assert.deepEqual(ready.runtime, works.runtime); assert.deepEqual(ready.startup, works.startup);
  const active = get(names[13]), last = get(names[14]);
  assert.equal(active.phase, 'active'); assert.equal(active.kind, 'guard'); assert.equal(active.source, entry.source);
  for (const key of ['MainPID', 'InvocationID', 'ExecMainStartTimestampMonotonic', 'WorkingDirectory'])
    assert.equal(active.current[key], works.current[key]);
  assert.equal(last.phase, 'active'); assert.equal(last.kind, 'guard'); assert.equal(last.guardSafe, true);
  assert.ok(time(stopped.at) < time(ready.at) && time(ready.at) <= time(last.at) && time(last.at) <= time(complete.finishedAt));
  const live = m.live.works;
  assert.equal(live.unit, ready.unit); assert.equal(String(live.pid), works.current.MainPID);
  assert.equal(live.invocation, works.current.InvocationID); assert.equal(live.execMainStartTimestampMonotonic, works.current.ExecMainStartTimestampMonotonic);
  assert.equal(works.current.ActiveState, 'active'); assert.equal(works.current.SubState, 'running'); assert.equal(works.current.ControlPID, '0');
  assert.equal(live.root, entry.root); assert.equal(works.current.WorkingDirectory, entry.root);
  for (const key of ['source', 'version', 'build']) { assert.equal(live[key], entry[key]); assert.equal(works.runtime[key], entry[key]); }
  assert.equal(works.runtime.sourceRoot, entry.root); assert.equal(works.runtime.parentPid, live.pid);
  for (const [file, digest] of Object.entries(works.runtime.loadedModuleSha)) assert.equal(digest, entry.sourceFiles[file]);
  assert.deepEqual(m.live.template, prior.live.template);
  return works;
}
function assertR14RecoveryRecords(m, records, entry) {
  const input = R14_RECOVERED_GUARD, { recoveryEvidenceIndex: index, recoveryEvidence: evidence } = records;
  assert.equal(sha(Buffer.from(JSON.stringify(index, null, 2) + '\n')), input.recoveryEvidenceIndexSha256);
  assert.equal(index.schema, 'mv-r14-failure-recovery-evidence.v1'); assert.equal(index.runId, input.runId);
  assert.equal(index.normalPublication, false); assert.equal(index.businessDataRestored, false);
  assert.equal(Object.keys(index.pins).length, 43);
  assert.deepEqual(index.compact, ['allowed-original.json.published.json', 'guard-baseline-readonly-proof.json']);
  assert.deepEqual(Object.keys(evidence).sort(), Object.keys(index.pins).sort());
  for (const [name, digest] of Object.entries(index.pins)) {
    assert.equal(path.basename(name), name);
    assert.equal(sha(Buffer.from(JSON.stringify(evidence[name], null, index.compact.includes(name) ? undefined : 2) + '\n')), digest,
      'Retained R14 recovery record changed: ' + name);
  }
  const get = name => evidence[name];
  for (const [key, name] of Object.entries({ prior: 'manifest.json', fixed: 'fixed-guard-recovery.json', build: 'guard-build.json',
    seal: 'guard-immutable-success.json', complete: 'guard-recovery-complete.json', command: 'normal-switch-command-return.json',
    proof: 'guard-baseline-readonly-proof.json', proofCommand: 'guard-baseline-readonly-proof-command.json',
    pricingPublication: 'allowed-original.json.published.json' })) assert.deepEqual(records[key], get(name));
  assert.equal(index.pins['multiview-works-ready-guard.json'], input.worksReadyGuardSha256);
  const { prior, complete, command, proof, proofCommand } = records;
  assert.equal(prior.mainSource, '08b5ce920384edb4f03199a058ca805561ac8fe5');
  assert.deepEqual(prior.recoveredGuardBaseline, R10_RECOVERED_GUARD);
  assert.equal(prior.deployedUsageSchema.publicationRun, '6a041bed-c909-4370-972f-2299321d7f1f');
  assert.equal(command.schema, 'mv-normal-switch-command.v1'); assert.equal(command.error, null);
  const failure = bound(get('switch-failure-e79825b7-66fa-49ab-80ed-932a02010674.json'), input);
  assert.equal(failure.schema, 'rate-impl2-switch-failure.v1');
  assert.equal(failure.error, 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n1004 !== 0\n');
  assert.equal(failure.safetyFailure.completed, true); assert.equal(failure.safetyFailure.route, 'fixed-guard');
  assert.equal(failure.databaseRestored, false);
  const state = get('r14-private-state-after-recovery.json');
  assert.equal(state.runId, input.runId); assert.equal(state.privateRecipeRowsExactlyMatchSwitchBefore, true);
  assert.deepEqual(state.rows, proof.protection.privateRecipeSettings);
  for (const key of ['expectedImmutableExists', 'activationExists', 'exactGuideProtectionExists', 'exactInstallOperationReceiptExists',
    'guideTargetExists', 'privateRootExists', 'backupPendingExists', 'backupControlDirectoryExists', 'backupDestinationExists'])
    assert.equal(state[key], false);
  assert.ok(Object.values(state.flags).every(value => value === false));
  assert.equal(state.backupDropinOriginalBytesMatched, true); assert.equal(state.backupDropinStateMatched, true);
  assert.equal(proofCommand.stdoutSha256, input.proofSha256);
  assert.equal(proofCommand.stderrSha256, sha(Buffer.alloc(0)));
  const names = Object.keys(index.pins).filter(name => /^multiview-works-transition-\d{4}\.json$/.test(name)).sort();
  const phases = ['captured', 'policy-intent', 'stop-intent', 'stopped', 'control-intent', 'control-published', 'start-intent', 'active',
    'policy-intent', 'stop-intent', 'stopped', 'fixed-guard-natural-drain', 'control-published', 'start-intent', 'active', 'active'];
  assert.equal(names.length, phases.length);
  names.forEach((name, i) => {
    const value = bound(get(name), input); assert.equal(value.sequence, i + 1); assert.equal(value.phase, phases[i]);
    assert.equal(value.previousSha256, i ? index.pins[names[i - 1]] : null);
    if (i) assert.ok(time(value.at) >= time(get(names[i - 1]).at));
  });
  const old = bound(get('multiview-works-before.json'), input), main = bound(get('multiview-works-ready-main.json'), input);
  assert.equal(String(prior.live.works.pid), old.current.MainPID); assert.equal(prior.live.works.invocation, old.current.InvocationID);
  assert.equal(prior.live.works.execMainStartTimestampMonotonic, old.current.ExecMainStartTimestampMonotonic);
  assert.equal(main.kind, 'main'); assert.equal(main.source, prior.mainSource); assert.equal(main.naturalExit, true);
  const stopped = get(names[11]);
  assert.equal(stopped.schema, 'multiview-works-fixed-guard-drain.v1'); assert.equal(stopped.allAdmittedProcessesGone, true);
  assert.equal(stopped.naturalExit, true); assert.equal(stopped.originalNaturalExitRetained, true); assert.equal(stopped.forcedKill, false);
  for (const [key, value] of Object.entries(main.current)) assert.equal(stopped.before[key], value);
  assert.ok(stopped.beforePids.includes(Number(main.current.MainPID)) && stopped.beforePids.includes(main.runtime.pid));
  for (const [key, value] of Object.entries({ ActiveState: 'inactive', MainPID: '0', ControlPID: '0', Result: 'success', ExecMainStatus: '0' }))
    assert.equal(stopped.after[key], value);
  const ready = bound(get('multiview-works-ready-guard.json'), input), works = complete.healthy.multiviewWorks;
  assert.equal(ready.schema, 'multiview-works-ready.v1'); assert.equal(ready.kind, 'guard'); assert.equal(works.kind, 'guard');
  assert.equal(ready.unit, 'sd2-multiview-works.service'); assert.equal(ready.naturalExit, true);
  for (const key of ['source', 'version', 'build']) assert.equal(ready[key], entry[key]);
  // R14 readiness records the fixed identity projection; recovery completion
  // records the full service() result after restoring the captured policies.
  // Each complete record remains independently bound by its original SHA.
  const readyFields = ['MainPID', 'ControlPID', 'ControlGroup', 'InvocationID', 'WorkingDirectory', 'ActiveState', 'SubState'];
  assert.deepEqual(Object.keys(ready.current).sort(), [...readyFields].sort());
  assert.deepEqual(Object.keys(works.current).sort(), Object.keys(old.current).sort());
  for (const key of readyFields) assert.equal(works.current[key], ready.current[key]);
  assert.deepEqual(works.runtime, ready.runtime); assert.deepEqual(works.startup, ready.startup);
  const active = get(names[14]), last = get(names[15]);
  assert.equal(active.kind, 'guard'); assert.equal(active.source, entry.source);
  assert.deepEqual(Object.keys(active.current).sort(), Object.keys(old.current).sort());
  for (const [key, value] of Object.entries(ready.current)) assert.equal(active.current[key], value);
  assert.equal(works.current.ExecMainStartTimestampMonotonic, active.current.ExecMainStartTimestampMonotonic);
  assert.equal(last.kind, 'guard'); assert.equal(last.guardSafe, true);
  assert.ok(time(main.at) <= time(complete.startedAt) && time(complete.startedAt) <= time(stopped.at)
    && time(stopped.at) < time(ready.at) && time(ready.at) <= time(last.at) && time(last.at) <= time(complete.finishedAt)
    && time(complete.finishedAt) <= time(state.at) && time(state.at) <= time(proofCommand.start)
    && time(complete.finishedAt) <= time(command.at));
  const live = m.live.works;
  assert.equal(live.unit, ready.unit); assert.equal(String(live.pid), ready.current.MainPID); assert.equal(live.invocation, ready.current.InvocationID);
  assert.equal(live.execMainStartTimestampMonotonic, active.current.ExecMainStartTimestampMonotonic);
  assert.equal(ready.current.ActiveState, 'active'); assert.equal(ready.current.SubState, 'running'); assert.equal(ready.current.ControlPID, '0');
  assert.equal(ready.current.WorkingDirectory, entry.root); assert.equal(live.root, entry.root);
  for (const key of ['source', 'version', 'build']) { assert.equal(live[key], entry[key]); assert.equal(ready.runtime[key], entry[key]); }
  assert.equal(ready.runtime.sourceRoot, entry.root); assert.equal(ready.runtime.parentPid, live.pid);
  for (const [file, digest] of Object.entries(ready.runtime.loadedModuleSha)) assert.equal(digest, entry.sourceFiles[file]);
  assert.deepEqual(m.live.template, prior.live.template);
  return works;
}
const R17_PRIVATE_EVIDENCE = ['private-recipe/admission.json', 'private-recipe/apply.json',
  'private-recipe/payload.json', 'private-recipe/plan.json', 'private-recipe/verification.json'];
function assertR17EvidenceName(name) {
  if (R17_PRIVATE_EVIDENCE.includes(name)) return;
  assert.equal(path.basename(name), name); assert.match(name, /^[a-z0-9-]+(?:\.json|\.json\.published\.json)$/);
}
function assertR17RecoveryRecords(m, records, entry) {
  const input = R17_RECOVERED_GUARD, { recoveryEvidenceIndex: index, recoveryEvidence: evidence } = records;
  assert.equal(sha(Buffer.from(JSON.stringify(index, null, 2) + '\n')), input.recoveryEvidenceIndexSha256);
  bound(index, input); assert.equal(index.schema, 'mv-r17-failure-recovery-evidence.v1');
  assert.equal(index.normalPublication, false); assert.equal(index.businessDataRestored, false);
  assert.equal(index.installedPrivateRecipeRetained, true); assert.equal(index.originalBackupRetained, true);
  assert.equal(Object.keys(index.pins).length, 55);
  assert.deepEqual(index.compact, ['allowed-original.json.published.json', 'guard-baseline-readonly-proof.json']);
  assert.deepEqual(Object.keys(index.logs).sort(), ['guard-baseline-readonly-proof.stderr', 'normal-switch-controller.log']);
  assert.deepEqual(Object.keys(evidence).sort(), Object.keys(index.pins).sort());
  for (const [name, digest] of Object.entries(index.pins)) {
    assertR17EvidenceName(name);
    assert.equal(sha(Buffer.from(JSON.stringify(evidence[name], null, index.compact.includes(name) ? undefined : 2) + '\n')), digest,
      'Retained R17 recovery record changed: ' + name);
  }
  const get = name => evidence[name], { prior, fixed, build, complete, command, proof, proofCommand } = records;
  for (const [key, name] of Object.entries({ prior: 'manifest.json', fixed: 'fixed-guard-recovery.json', build: 'guard-build.json',
    seal: 'guard-immutable-success.json', complete: 'guard-recovery-complete.json', command: 'normal-switch-command-return.json',
    proof: 'guard-baseline-readonly-proof.json', proofCommand: 'guard-baseline-readonly-proof-command.json',
    pricingPublication: 'allowed-original.json.published.json' })) assert.deepEqual(records[key], get(name));
  for (const [name, key] of Object.entries({ 'multiview-works-ready-guard.json': 'worksReadyGuardSha256',
    'private-recipe/apply.json': 'installedRecipeReceiptSha256', 'multiview-backup-before.json': 'backupCaptureSha256',
    'multiview-backup-transition.json': 'backupTransitionSha256', 'multiview-backup-published.json': 'backupPublishedSha256' }))
    assert.equal(index.pins[name], input[key]);
  assert.equal(prior.mainSource, 'd6c611d353b6f3da665993fe62a1a5b4dbe65f81');
  assert.deepEqual(prior.recoveredGuardBaseline, R14_RECOVERED_GUARD);
  assert.equal(prior.deployedUsageSchema.publicationRun, '6a041bed-c909-4370-972f-2299321d7f1f');
  assert.notEqual(prior.deployedCanvasBatchSchema.migrationRun, input.runId);
  const armed = bound(get('fixed-guard-recovery-armed.json'), input), attempt = bound(get('guard-recovery-attempt.json'), input);
  assert.equal(armed.file, prior.stage + '/fixed-guard-recovery.json'); assert.equal(armed.sha256, input.fixedGuardSha256);
  assert.equal(armed.source, entry.source); assert.equal(armed.build, entry.build); assert.equal(armed.freshAdmissionOnly, true);
  assert.equal(armed.originalBuildStartedAt, build.startedAt); assert.equal(attempt.originalBuildStartedAt, build.startedAt);
  assert.equal(attempt.guardSource, entry.source); assert.equal(attempt.candidateFreshGateClaimed, false);
  const failure = bound(get('switch-failure-35412dd5-6e3a-4281-84ac-f3973d2a8ab5.json'), input);
  const rejected = bound(get('guard-recovery-failed.json'), input), facts = bound(get('r17-recovery-source-facts.json'), input);
  assert.equal(failure.schema, 'rate-impl2-switch-failure.v1'); assert.equal(failure.safetyFailure, null);
  assert.equal(failure.databaseRestored, false); assert.equal(failure.automaticOldPairRecovery, false);
  assert.equal(failure.writerStartIntentPresent, true); assert.equal(rejected.originalFailure, failure.error);
  assert.equal(rejected.error, failure.safetyRecoveryError); assert.equal(rejected.code, null);
  assert.equal(rejected.preservedSafetyState, true); assert.equal(rejected.forcedKill, false);
  assert.equal(rejected.businessDataRestored, false); assert.equal(rejected.candidateFreshGateClaimed, false);
  assert.equal(complete.originalFailure, 'Error: ' + failure.error); assert.equal(complete.originalBuildStartedAt, build.startedAt);
  assert.equal(command.schema, 'mv-normal-switch-command.v1'); assert.equal(command.error, null);
  assert.equal(command.log, prior.stage + '/normal-switch-controller.log'); assert.equal(command.logSha256, index.logs['normal-switch-controller.log']);
  assert.equal(facts.schema, 'r17-exact-fixed-recovery-facts.v1');
  assert.equal(facts.mainSource, prior.mainSource); assert.equal(facts.guardSource, entry.source);
  assert.equal(Object.keys(facts.pins).length, 29);
  for (const [name, digest] of Object.entries(facts.pins)) assert.equal(digest, index.pins[name]);
  assert.deepEqual(facts.originalControlSha256, prior.privateSha256);
  assert.deepEqual(facts.failure, rejected);
  const admission = get('r17-exact-recovery-admission.json'), stopped = bound(get('r17-works-natural-stop.json'), input);
  const continuation = get('r17-exact-recovery-continuation.json'), exact = get('r17-exact-recovery-complete.json');
  assert.equal(admission.schema, 'r17-exact-recovery-readonly-verified.v1'); assert.equal(admission.runId, input.runId);
  assert.equal(admission.guardOnly, true); assert.equal(admission.normalPublication, false); assert.equal(admission.productionWrites, 0);
  assert.equal(admission.positive, 1); assert.equal(admission.negative, 16); assert.equal(admission.sourceFiles, 12);
  assert.equal(admission.original54Unchanged, true); assert.equal(admission.factsSha256, index.pins['r17-recovery-source-facts.json']);
  assert.equal(continuation.schema, 'r17-exact-recovery-continuation.v1'); assert.equal(continuation.runId, input.runId);
  assert.equal(continuation.originalFailureSha256, index.pins['guard-recovery-failed.json']);
  assert.equal(continuation.stopSha256, index.pins['r17-works-natural-stop.json']);
  assert.equal(exact.schema, 'r17-exact-recovery-complete.v1'); assert.equal(exact.runId, input.runId);
  assert.equal(exact.normalPublication, false); assert.equal(exact.businessDataRestored, false);
  const { manifestSha256: _manifest, ...result } = complete; assert.deepEqual(exact.result, result);
  assert.ok(time(fixed.armedAt) <= time(attempt.at) && time(attempt.at) <= time(command.at)
    && time(command.at) <= time(facts.at) && time(facts.at) <= time(admission.at)
    && time(admission.at) <= time(stopped.at) && time(stopped.at) <= time(complete.startedAt)
    && time(complete.startedAt) <= time(complete.finishedAt) && time(complete.finishedAt) <= time(exact.at)
    && time(exact.at) <= time(proofCommand.start));
  assert.equal(proofCommand.stdoutSha256, input.proofSha256); assert.equal(proofCommand.stderrSha256, sha(Buffer.alloc(0)));
  assert.equal(index.logs['guard-baseline-readonly-proof.stderr'], proofCommand.stderrSha256);
  const names = Object.keys(index.pins).filter(name => /^multiview-works-transition-\d{4}\.json$/.test(name)).sort();
  const phases = ['captured', 'policy-intent', 'stop-intent', 'stopped', 'control-intent', 'control-published', 'start-intent', 'active',
    'recipe-install-intent', 'recipe-installed', 'active', 'policy-intent', 'stop-intent', 'stopped', 'fixed-guard-natural-drain',
    'fixed-guard-natural-drain', 'control-published', 'start-intent', 'active', 'active'];
  assert.equal(names.length, phases.length);
  names.forEach((name, i) => {
    const value = bound(get(name), input); assert.equal(value.sequence, i + 1); assert.equal(value.phase, phases[i]);
    assert.equal(value.previousSha256, i ? index.pins[names[i - 1]] : null);
    if (i) assert.ok(time(value.at) >= time(get(names[i - 1]).at));
  });
  const old = bound(get('multiview-works-before.json'), input), main = bound(get('multiview-works-ready-main.json'), input);
  const mainActive = get(names[7]), privateReady = get(names[10]), active = get(names[18]), last = get(names[19]);
  const identityKeys = ['MainPID', 'InvocationID', 'ExecMainStartTimestampMonotonic', 'WorkingDirectory'];
  assert.equal(String(prior.live.works.pid), old.current.MainPID); assert.equal(prior.live.works.invocation, old.current.InvocationID);
  assert.equal(prior.live.works.execMainStartTimestampMonotonic, old.current.ExecMainStartTimestampMonotonic);
  for (const i of [1, 2]) for (const key of identityKeys) assert.equal(get(names[i]).current[key], old.current[key]);
  assert.equal(get(names[2]).forcedKill, false); assert.equal(get(names[3]).forcedKill, false); assert.equal(get(names[3]).naturalExit, true);
  assert.equal(main.kind, 'main'); assert.equal(main.source, prior.mainSource); assert.equal(main.naturalExit, true);
  assert.equal(mainActive.kind, 'main'); assert.equal(mainActive.source, prior.mainSource);
  assert.deepEqual(Object.keys(mainActive.current).sort(), Object.keys(old.current).sort());
  for (const [key, value] of Object.entries(main.current)) assert.equal(mainActive.current[key], value);
  assert.deepEqual(mainActive.runtime, main.runtime); assert.deepEqual(facts.ready, main); assert.deepEqual(facts.active, mainActive);
  assert.equal(get(names[8]).admitted, true); assert.equal(get(names[9]).revision, 6); assert.equal(get(names[9]).version, '1.0.6');
  assert.equal(privateReady.kind, 'main'); assert.equal(privateReady.privateReady, true); assert.deepEqual(facts.summary, privateReady);
  for (const i of [11, 12]) for (const key of identityKeys) assert.equal(get(names[i]).current[key], mainActive.current[key]);
  assert.equal(get(names[12]).forcedKill, false); assert.equal(get(names[13]).forcedKill, false); assert.equal(get(names[13]).naturalExit, true);
  for (const key of identityKeys) assert.equal(stopped.before[key], mainActive.current[key]);
  assert.ok(stopped.beforePids.includes(Number(main.current.MainPID)) && stopped.beforePids.includes(main.runtime.pid));
  assert.deepEqual(Object.fromEntries(Object.keys(stopped).map(key => [key, get(names[14])[key]])), stopped);
  for (const drain of [stopped, get(names[15])]) {
    assert.equal(drain.schema, 'multiview-works-fixed-guard-drain.v1'); assert.equal(drain.allAdmittedProcessesGone, true);
    assert.equal(drain.naturalExit, true); assert.equal(drain.originalNaturalExitRetained, true); assert.equal(drain.forcedKill, false);
    for (const [key, value] of Object.entries({ ActiveState: 'inactive', MainPID: '0', ControlPID: '0', Result: 'success', ExecMainStatus: '0' }))
      assert.equal(drain.after[key], value);
  }
  const ready = bound(get('multiview-works-ready-guard.json'), input), works = complete.healthy.multiviewWorks;
  assert.equal(ready.schema, 'multiview-works-ready.v1'); assert.equal(ready.kind, 'guard'); assert.equal(works.kind, 'guard');
  assert.equal(ready.unit, 'sd2-multiview-works.service'); assert.equal(ready.naturalExit, true);
  assert.equal(active.kind, 'guard'); assert.equal(active.source, entry.source); assert.equal(last.kind, 'guard'); assert.equal(last.guardSafe, true);
  assert.deepEqual(Object.keys(active.current).sort(), Object.keys(old.current).sort());
  assert.deepEqual(Object.keys(works.current).sort(), Object.keys(old.current).sort());
  for (const [key, value] of Object.entries(ready.current)) { assert.equal(active.current[key], value); assert.equal(works.current[key], value); }
  for (const key of identityKeys) assert.equal(works.current[key], active.current[key]);
  assert.deepEqual(works.runtime, ready.runtime); assert.deepEqual(works.startup, ready.startup);
  assert.deepEqual(Object.keys(ready.startup).sort(), ['allowed', 'module', 'sourceDropin']);
  for (const i of [5, 6, 16, 17]) {
    const published = get(names[i]).published;
    assert.deepEqual(published.allowed, ready.startup.allowed); assert.deepEqual(published.module, ready.startup.module);
  }
  assert.equal(get(names[6]).kind, 'main'); assert.equal(get(names[17]).kind, 'guard');
  const live = m.live.works;
  assert.equal(live.unit, ready.unit); assert.equal(String(live.pid), ready.current.MainPID); assert.equal(live.invocation, ready.current.InvocationID);
  assert.equal(live.execMainStartTimestampMonotonic, active.current.ExecMainStartTimestampMonotonic);
  assert.equal(ready.current.ActiveState, 'active'); assert.equal(ready.current.SubState, 'running'); assert.equal(ready.current.ControlPID, '0');
  assert.equal(ready.current.WorkingDirectory, entry.root); assert.equal(live.root, entry.root);
  for (const key of ['source', 'version', 'build']) { assert.equal(ready[key], entry[key]); assert.equal(live[key], entry[key]); assert.equal(ready.runtime[key], entry[key]); }
  assert.equal(ready.runtime.sourceRoot, entry.root); assert.equal(ready.runtime.parentPid, live.pid);
  assert.equal(Object.keys(ready.runtime.loadedModuleSha).length, 12);
  for (const [file, digest] of Object.entries(ready.runtime.loadedModuleSha)) assert.equal(digest, entry.sourceFiles[file]);
  assert.deepEqual(proof.role.current, complete.healthy.role.current); assert.equal(complete.healthy.role.source, entry.source);
  assert.equal(complete.healthy.role.kind, 'guard'); assert.equal(complete.healthy.role.runtime.sourceRoot, entry.root);
  assert.equal(complete.healthy.role.runtime.version, entry.version);
  const image = complete.healthy.imageCapability, hd = complete.healthy.hd;
  assert.equal(image.source, entry.source); assert.equal(image.instance.cwd, entry.root);
  assert.equal(String(image.unitPid), proof.units.image.MainPID); assert.equal(image.invocation, proof.units.image.InvocationID);
  assert.equal(hd.source, entry.source); assert.equal(hd.root, entry.root); assert.equal(String(hd.pid), proof.units.hd.MainPID);
  assert.equal(hd.invocation, proof.units.hd.InvocationID); assert.equal(hd.controlledProcessGroup, true); assert.equal(hd.noFork, true);
  for (const runtime of [image, complete.healthy.role.runtime]) for (const [file, digest] of Object.entries(runtime.loadedModuleSha))
    assert.equal(digest, file === '.deployed-commit' ? sha(Buffer.from(entry.source + '\n')) : entry.sourceFiles[file]);
  const prestart = bound(get('guard-recovery-actual-prestart.json'), input), intent = bound(get('guard-recovery-start-intent.json'), input);
  assert.equal(prestart.schema, 'fixed-guard-recovery-prestart.v1'); assert.equal(prestart.source, entry.source); assert.equal(prestart.build, entry.build);
  assert.deepEqual(prestart.accepted.map(value => value.service).sort(), [prior.live.web.unit, prior.live.image.unit].sort());
  for (const accepted of prestart.accepted) {
    assert.equal(accepted.guard, 'pricing-writer-start-v1'); assert.equal(accepted.sourceAndBuildVerified, true); assert.equal(accepted.barrierVerified, true);
    for (const key of ['source', 'version', 'build']) assert.equal(accepted[key], entry[key]);
  }
  assert.equal(intent.intent.file, PRICING_START_CONTROL + '/start-' + input.runId + '.json');
  assert.equal(intent.intent.retainedExistingLatch, true); assert.equal(intent.intent.sha256, sha(Buffer.from(JSON.stringify(proof.writerStartIntent) + '\n')));
  const apply = get('private-recipe/apply.json'), plan = get('private-recipe/plan.json'), verification = get('private-recipe/verification.json');
  const recipeAdmission = get('private-recipe/admission.json'), transition = bound(get('multiview-recipe-transition.json'), input);
  const preopen = bound(get('multiview-private-preopen-complete.json'), input), isolated = bound(get('multiview-private-isolated-backup-copy.json'), input);
  assert.equal(apply.schema, 'multiview-private-recipe-apply.v1'); assert.equal(apply.revision, 6); assert.equal(apply.version, '1.0.6');
  assert.equal(apply.production, true); assert.equal(apply.activationCreated, true);
  assert.equal(plan.schema, 'multiview-private-recipe-plan.v1'); assert.equal(verification.schema, 'multiview-private-recipe-verification.v1');
  for (const value of [apply, plan, verification, transition]) {
    assert.equal(value.payloadSha256, index.pins['private-recipe/payload.json']);
    if (Object.hasOwn(value, 'planSha256')) assert.equal(value.planSha256, index.pins['private-recipe/plan.json']);
    if (Object.hasOwn(value, 'verificationSha256')) assert.equal(value.verificationSha256, index.pins['private-recipe/verification.json']);
  }
  assert.deepEqual(plan.inspection, verification.inspection); assert.equal(plan.inspection.revision, apply.revision);
  assert.equal(plan.inspection.version, apply.version); assert.equal(plan.inspection.sourceTaskMatched, true); assert.equal(plan.inspection.guideMatched, true);
  assert.equal(get('private-recipe/payload.json').guideSHA, apply.guideSha256); assert.equal(plan.guideSha256, apply.guideSha256);
  assert.equal(verification.guideSha256, apply.guideSha256); assert.equal(apply.installedProof.currentSha256, transition.expectedSha256);
  for (const key of ['currentSha256', 'activationSha256', 'protectionSha256']) assert.match(apply.installedProof[key], /^[a-f0-9]{64}$/);
  assert.equal(recipeAdmission.schema, 'multiview-private-recipe-admission.v1'); assert.equal(recipeAdmission.runId, input.runId);
  assert.equal(recipeAdmission.mainSource, prior.mainSource); assert.equal(recipeAdmission.guardSource, entry.source);
  assert.equal(recipeAdmission.guardBuild, entry.build); assert.equal(recipeAdmission.mainBuild, main.build);
  assert.equal(apply.admission.sha256, index.pins['private-recipe/admission.json']); assert.equal(apply.admission.runId, input.runId);
  assert.equal(apply.admission.mainSource, prior.mainSource); assert.equal(apply.admission.mainBuild, main.build);
  assert.equal(recipeAdmission.evidence.worksReady.sha256, index.pins['multiview-works-ready-main.json']);
  assert.equal(preopen.schema, 'multiview-private-preopen-complete.v1'); assert.equal(preopen.source, prior.mainSource); assert.equal(preopen.build, main.build);
  assert.equal(preopen.readyToOpen, true); assert.equal(preopen.recipe.phase, 'apply'); assert.equal(preopen.recipe.applied, true);
  assert.equal(preopen.recipe.revision, apply.revision); assert.equal(preopen.recipe.version, apply.version); assert.equal(preopen.recipe.target, apply.target);
  assert.equal(preopen.recipe.sourceTaskMatched, true); assert.equal(preopen.recipe.guideMatched, true);
  for (const key of identityKeys) assert.equal(preopen.works.current[key], mainActive.current[key]);
  assert.deepEqual(facts.preopenWorks, preopen.works); assert.deepEqual(preopen.works.startup, main.startup);
  // The retained proof intentionally projects the pre-install rows. It cannot
  // stand in for current revision 6; the separate read-only adoption rechecks it.
  assert.deepEqual(proof.protection.privateRecipeSettings, get('switch-before.json').protection.privateRecipeSettings);
  const capture = bound(get('multiview-backup-before.json'), input), backup = bound(get('multiview-backup-transition.json'), input);
  const published = bound(get('multiview-backup-published.json'), input);
  assert.equal(capture.schema, 'sd2-multiview-backup-capture.v1'); assert.equal(backup.schema, 'sd2-multiview-backup-transition.v1');
  assert.equal(published.schema, 'sd2-multiview-backup-published.v1');
  for (const value of [capture, backup, published]) { assert.equal(value.mainSource, prior.mainSource); assert.equal(value.guardSource, entry.source); }
  assert.equal(backup.captureSha256, input.backupCaptureSha256); assert.equal(published.transitionSha256, input.backupTransitionSha256);
  assert.equal(published.target, backup.target); assert.deepEqual(published.control, backup.control); assert.deepEqual(published.dropin, backup.dropin.next);
  assert.equal(published.timerUnchanged, true); assert.equal(published.serviceStarted, false); assert.equal(published.timerStartedOrEnabled, false);
  assert.deepEqual(preopen.backupControl, published); assert.deepEqual(facts.backupTransition, backup);
  assert.equal(preopen.backup.complete, true); assert.equal(preopen.isolatedRestore.verified, true);
  assert.deepEqual(preopen.isolatedCopy, isolated); assert.equal(isolated.actualDataDisk, true); assert.equal(isolated.separateDirectory, true);
  assert.equal(isolated.productionDatabaseRestored, false); assert.notEqual(isolated.directory, isolated.source);
  assert.ok(time(main.at) <= time(apply.activatedAt) && time(apply.activatedAt) <= time(preopen.at)
    && time(preopen.at) <= time(privateReady.at) && time(privateReady.at) <= time(attempt.at)
    && time(complete.startedAt) <= time(get(names[15]).at) && time(get(names[15]).at) <= time(ready.at)
    && time(ready.at) <= time(last.at) && time(last.at) <= time(complete.finishedAt));
  assert.deepEqual(m.live.template, prior.live.template);
  return works;
}
export function assertRecoveredGuardRecords(m, records, identity) {
  const input = assertRecoveredGuardInput(m.recoveredGuardBaseline);
  const r10 = input.schema === R10_RECOVERED_GUARD.schema, r14 = input.schema === R14_RECOVERED_GUARD.schema,
    r17 = input.schema === R17_RECOVERED_GUARD.schema;
  const { source: SOURCE, build: BUILD } = recoveredProgram(input);
  assert.equal(m.normalContinuation || null, null);
  if (isSharedEngine(m)) engineDirectory(m);
  else assert.equal(m.reuseBuilds || null, null);
  assert.equal(m.privateMultiviewInstall, true); assert.notEqual(m.runId, input.runId);
  const { prior, fixed, build, seal, complete, command, proof, proofCommand, pricingPublication } = records;
  assert.equal(prior.schema, 'rate-impl2-release.v1'); assert.equal(prior.project, 'video-api-debugger');
  assert.equal(prior.runId, input.runId); assert.equal(prior.stage, '/data/video-api-debugger/release-staging/' + input.runId);
  assert.equal(prior.guardSource, SOURCE); assert.equal(prior.guard.source, SOURCE);
  assert.equal(prior.guard.root, '/data/video-api-debugger/managed-releases/' + SOURCE);
  assert.equal(prior.guard.version, VERSION); assert.equal(prior.privateMultiviewInstall, true);
  for (const kind of ['main', 'guard']) assert.ok(![prior.mainSource, prior.guardSource].includes(m[kind + 'Source']), 'A new pair cannot reuse either recovered run source');
  assert.equal(prior.normalContinuation || null, null); assert.equal(prior.reuseBuilds || null, null);
  for (const key of ['database', 'storageRoot', 'uploadsRoot', 'videosRoot', 'envFile', 'hdRoot',
    'deployedUsageSchema', 'deployedCanvasBatchSchema', 'canvasVideoBatchSchema']) assert.deepEqual(prior[key], m[key]);
  bound(fixed, input); assert.equal(fixed.schema, 'mv-hd-upload-fixed-guard-recovery.v1');
  assert.equal(fixed.onlyOperation, 'recover-this-guard-after-this-run-failure');
  assert.equal(fixed.continueMain, false); assert.equal(fixed.replaceGuard, false);
  assert.equal(fixed.normalPublicationWindowAndBuildAgeUnchanged, true);
  assert.deepEqual(fixed.bindings, { storage: m.storageRoot, uploads: m.uploadsRoot, videos: m.videosRoot, env: m.envFile, hd: m.hdRoot });
  const entry = fixed.guardEntry;
  for (const key of ['source', 'root', 'version']) assert.equal(entry[key], prior.guard[key]);
  assert.equal(entry.build, BUILD); assert.equal(fixed.guardBuildReceiptSha256, input.guardBuildReceiptSha256);
  bound(build, input); assert.equal(build.label, 'guard'); assert.equal(build.source, SOURCE); assert.equal(build.version, VERSION);
  assert.equal(build.build, BUILD); assert.equal(build.exitCode, 0); assert.equal(build.verifiedSourceAndGates, true);
  assert.ok(Number.isSafeInteger(build.startedAt) && Number.isSafeInteger(build.finishedAt) && build.startedAt < build.finishedAt);
  assert.deepEqual(fixed.originalGuardBuild, build); assert.deepEqual(fixed.originalFullGuardBuild, build);
  assert.equal(seal.schema, 'sd2-immutable-successful-build.v1'); assert.equal(seal.sourceRun, input.runId); assert.equal(seal.kind, 'guard');
  assert.equal(seal.originalManifestSha256, input.manifestSha256); assert.equal(seal.originalReceiptSha256, input.guardBuildReceiptSha256);
  assert.deepEqual(seal.originalReceipt, build); assert.equal(seal.originallyVerifiedWithinThirtyMinuteGate, true);
  assert.equal(seal.originalTimesChanged, false); assert.equal(seal.newCompilationClaimed, false);
  assert.ok(time(seal.sealedAt) >= build.finishedAt && Date.parse(seal.sealedAt) - build.startedAt < 1800000);
  bound(complete, input); assert.equal(complete.schema, 'mv-hd-upload-fault-recovery.v1');
  assert.equal(complete.route, 'fixed-guard'); assert.equal(complete.completed, true); assert.equal(complete.businessDataRestored, false);
  assert.equal(complete.candidateFreshGateClaimed, false); assert.equal(complete.originalProofAndReceiptsPreserved, true);
  assert.equal(complete.source, SOURCE); assert.equal(complete.build, BUILD);
  assert.equal(complete.healthy.actualHealthy, true); assert.equal(complete.healthy.source, SOURCE);
  assert.equal(complete.healthy.build, BUILD); assert.equal(complete.healthy.releaseVersion, VERSION);
  assert.equal(complete.ingress.exactOriginalBytesRestored, true);
  assert.equal(command.runId, input.runId); assert.equal(command.status, 1); assert.equal(command.signal, null);
  if (!r10 && !r17) assert.ok(time(command.at) >= time(complete.finishedAt));
  bound(proof, input); assert.equal(proof.schema, 'rate-impl2-switch-proof.v1'); assert.equal(proof.readOnly, true);
  assert.equal(proofCommand.status, 0); assert.equal(proofCommand.signal, null); assert.equal(proofCommand.error, null);
  assert.ok(time(proofCommand.start) <= time(proof.at) && time(proof.at) <= time(proofCommand.finish));
  assert.ok(time(proofCommand.start) >= time(complete.finishedAt));
  assert.deepEqual(proof.protection.databaseIdentity, identity);
  assert.equal(proof.role.allTransitionsBound, true); assert.equal(proof.role.forcedKill, false); assert.equal(proof.role.businessDataRestored, false);
  for (const role of ROLES) {
    const live = m.live[role], state = roleState(proof, role);
    assert.equal(state.ActiveState, 'active'); assert.equal(state.SubState, 'running'); assert.equal(state.ControlPID, '0');
    assert.equal(state.WorkingDirectory, entry.root);
    assert.equal(live.source, SOURCE); assert.equal(live.root, entry.root); assert.equal(live.version, VERSION); assert.equal(live.build, BUILD);
    assert.equal(String(live.pid), state.MainPID); assert.equal(live.invocation, state.InvocationID);
    assert.equal(live.execMainStartTimestampMonotonic, state.ExecMainStartTimestampMonotonic);
  }
  const pair = fixed.pair;
  bound(pair, input); assert.equal(pair.schema, 'pricing-start-pair.v1');
  assert.equal(pair.baseAllowedSha256, fixed.originalControl.allowed.sha256);
  assert.equal(sha(Buffer.from(pair.bytesBase64, 'base64')), pair.sha256);
  assert.deepEqual(JSON.parse(Buffer.from(pair.bytesBase64, 'base64')), pair.allowed);
  const installed = proof.pricingStartControl.allowed;
  const publishedAllowed = JSON.parse(Buffer.from(installed.bytesBase64, 'base64'));
  assert.equal(sha(Buffer.from(installed.bytesBase64, 'base64')), installed.sha256);
  bound(pricingPublication, input); assert.equal(pricingPublication.schema, 'pricing-start-pair-published.v1');
  assert.equal(sha(Buffer.from(JSON.stringify(pricingPublication) + '\n')), proof.writerStartIntent.transitionReceiptSha256);
  assert.equal(pricingPublication.control, PRICING_START_CONTROL);
  assert.equal(pricingPublication.backupFile, prior.stage + '/allowed-original.json');
  assert.deepEqual(pricingPublication.previousAllowed, fixed.originalControl.allowed);
  assert.deepEqual(pricingPublication.installed, installed);
  assert.equal(pricingPublication.guard.sha256, fixed.originalControl.guard.sha256);
  assert.equal(pricingPublication.marker.sha256, fixed.originalControl.marker.sha256);
  // The original controller constructs the same pair before arm and again
  // after natural drain. Preserve both receipt-bound hashes and exact times.
  assert.deepEqual(publishedAllowed, { ...pair.allowed, at: publishedAllowed.at });
  assert.ok(time(pair.allowed.at) <= time(fixed.armedAt) && time(fixed.armedAt) <= time(publishedAllowed.at)
    && time(publishedAllowed.at) <= time(pricingPublication.at) && time(pricingPublication.at) <= time(proof.writerStartIntent.at));
  assert.deepEqual(pair.allowed.releases.find(value => value.source === SOURCE), entry);
  for (const key of ['control', 'guard', 'marker', 'chain']) assert.deepEqual(proof.pricingStartControl[key], fixed.originalControl[key]);
  assert.equal(proof.writerStartIntent.schema, 'pricing-new-writer-start-intent.v1');
  assert.equal(proof.writerStartIntent.runId, input.runId); assert.equal(proof.writerStartIntent.allowedSha256, installed.sha256);
  const works = r17 ? assertR17RecoveryRecords(m, records, entry)
    : r14 ? assertR14RecoveryRecords(m, records, entry) : r10 ? assertR10RecoveryRecords(m, records, entry) : null;
  return { prior, final: proof, entry, roleKind: 'guard', manifestSha256: input.manifestSha256,
    ...(works ? { works } : {}),
    recovery: { ...input, source: SOURCE, version: VERSION, build: BUILD, candidateFreshGateClaimed: false }, fixed };
}
function readPinnedEmptyProofStderr(file, expectedSha256, input) {
  assert.ok(input === R14_RECOVERED_GUARD || input === R17_RECOVERED_GUARD);
  assert.equal(file, '/data/video-api-debugger/release-staging/' + input.runId + '/guard-baseline-readonly-proof.stderr');
  assert.equal(expectedSha256, sha(Buffer.alloc(0)), 'Only the exact retained proof stderr uses this empty-file reader');
  assert.equal(fs.realpathSync(file), file);
  const before = fs.lstatSync(file);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.uid === 0 && before.gid === 0
    && before.nlink === 1 && (before.mode & 0o7777) === 0o600 && before.size === 0, 'Untrusted empty retained proof stderr');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd), bytes = fs.readFileSync(fd), after = fs.fstatSync(fd), named = fs.lstatSync(file);
    for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs']) {
      assert.equal(opened[key], before[key]); assert.equal(after[key], before[key]); assert.equal(named[key], before[key]);
    }
    assert.equal(bytes.length, 0); assert.equal(sha(bytes), expectedSha256); return bytes;
  } finally { fs.closeSync(fd); }
}
export function readRecoveredGuardBaseline(m, identity) {
  const input = assertRecoveredGuardInput(m.recoveredGuardBaseline), stage = '/data/video-api-debugger/release-staging/' + input.runId;
  const r17 = input.schema === R17_RECOVERED_GUARD.schema;
  assert.equal(fs.realpathSync(stage), stage); const stat = fs.lstatSync(stage);
  assert.ok(stat.isDirectory() && stat.uid === 0 && !(stat.mode & 0o077));
  assert.equal(call('findmnt', ['-n', '-o', 'TARGET', '-T', stage]), '/data');
  const get = (file, digest) => { const bytes = rootFile(stage + '/' + file); assert.equal(sha(bytes), digest, 'Retained recovery evidence changed: ' + file); return JSON.parse(bytes); };
  const records = { prior: get('manifest.json', input.manifestSha256), fixed: get('fixed-guard-recovery.json', input.fixedGuardSha256),
    build: get('guard-build.json', input.guardBuildReceiptSha256), seal: get('guard-immutable-success.json', input.guardImmutableSuccessSha256),
    complete: get('guard-recovery-complete.json', input.recoveryCompleteSha256), command: get('normal-switch-command-return.json', input.switchCommandSha256),
    proof: get('guard-baseline-readonly-proof.json', input.proofSha256), proofCommand: get('guard-baseline-readonly-proof-command.json', input.proofCommandSha256) };
  records.pricingPublication = get('allowed-original.json.published.json', records.proof.writerStartIntent.transitionReceiptSha256);
  if ([R10_RECOVERED_GUARD.schema, R14_RECOVERED_GUARD.schema, R17_RECOVERED_GUARD.schema].includes(input.schema)) {
    records.recoveryEvidenceIndex = get(r17 ? 'r17-failure-recovery-evidence-index.json' : input.schema === R14_RECOVERED_GUARD.schema
      ? 'r14-failure-recovery-evidence-index.json' : 'failure-recovery-evidence-index.json', input.recoveryEvidenceIndexSha256);
    records.recoveryEvidence = Object.fromEntries(Object.entries(records.recoveryEvidenceIndex.pins).map(([name, digest]) => {
      if (r17) assertR17EvidenceName(name);
      else { assert.equal(path.basename(name), name); assert.match(name, /^[a-z0-9-]+(?:\.json|\.json\.published\.json)$/); }
      return [name, get(name, digest)];
    }));
    const names = fs.readdirSync(stage).filter(name => /^multiview-works-transition-\d{4}\.json$/.test(name)).sort();
    assert.deepEqual(names, Object.keys(records.recoveryEvidenceIndex.pins).filter(name => /^multiview-works-transition-\d{4}\.json$/.test(name)).sort());
    if (!r17) {
      assert.equal(fs.existsSync(stage + '/private-recipe/apply.json'), false);
      assert.equal(fs.existsSync(stage + '/multiview-private-preopen-complete.json'), false);
    }
    if (input.schema === R14_RECOVERED_GUARD.schema || r17) {
      for (const [name, digest] of Object.entries(records.recoveryEvidenceIndex.logs)) {
        assert.ok(['normal-switch-controller.log', 'normal-switch-driver.log', 'guard-baseline-readonly-proof.stderr'].includes(name));
        const bytes = name === 'guard-baseline-readonly-proof.stderr'
          ? readPinnedEmptyProofStderr(stage + '/' + name, digest, r17 ? R17_RECOVERED_GUARD : R14_RECOVERED_GUARD) : rootFile(stage + '/' + name);
        assert.equal(sha(bytes), digest);
      }
      if (!r17) for (const name of ['private-recipe/admission.json', 'multiview-recipe-transition.json', 'multiview-backup-transition.json', 'multiview-backup-published.json'])
          assert.equal(fs.existsSync(stage + '/' + name), false, 'The exact R14 recovery ended before private installation');
    }
  }
  assert.equal(fs.existsSync(stage + '/switch-complete.json'), false, 'A recovered baseline must remain a failed publication with separate recovery');
  for (const [name, digest] of Object.entries(records.prior.privateSha256)) {
    assert.equal(path.basename(name), name); assert.equal(sha(rootFile(stage + '/fix01-release/' + name)), digest);
  }
  for (const file of ['fixed-guard-recovery.json', 'guard-immutable-success.json'])
    assert.ok(call('lsattr', ['-d', '--', stage + '/' + file]).split(/\s+/)[0].includes('i'));
  const value = assertRecoveredGuardRecords(m, records, identity);
  verifyFixedProgramEntry(value.entry);
  assert.deepEqual(inspectFixedGuardArtifact(value.entry), value.fixed.artifact, 'Retained guard bytes or file identities drifted');
  for (const [alias, target] of Object.entries({ storage: m.storageRoot, 'public/uploads': m.uploadsRoot, 'public/videos': m.videosRoot, '.env': m.envFile })) {
    const file = value.entry.root + '/' + alias; assert.ok(fs.lstatSync(file).isSymbolicLink()); assert.equal(fs.readlinkSync(file), target);
    assert.equal(fs.realpathSync(file), fs.realpathSync(target));
  }
  return value;
}
export function assertRecoveredGuardLive(m, value) {
  for (const role of [...ROLES, ...(value.works ? ['works'] : [])]) {
    const live = m.live[role], current = unit(live.unit);
    assert.equal(current.ActiveState, 'active'); assert.equal(current.SubState, 'running'); assert.equal(current.ControlPID, '0');
    assert.equal(current.MainPID, String(live.pid)); assert.equal(current.InvocationID, live.invocation);
    assert.equal(current.ExecMainStartTimestampMonotonic, live.execMainStartTimestampMonotonic);
    assert.equal(current.WorkingDirectory, value.entry.root); assert.equal(fs.realpathSync('/proc/' + current.MainPID + '/cwd'), value.entry.root);
  }
  if (value.works) {
    // This runs the original lifecycle/source/startup/heartbeat verifier against
    // the exact retained run. A saved proof or fresh hash alone cannot admit it.
    inspectMultiviewWorksProtection(value.prior);
    for (const expected of Object.values(value.works.startup)) {
      const bytes = rootFile(expected.path), stat = fs.lstatSync(expected.path);
      assert.equal(sha(bytes), expected.sha256);
      const observed = Object.fromEntries(Object.keys(expected.identity).map(key => [key, key === 'mode' ? stat.mode & 0o7777 : stat[key]]));
      assert.deepEqual(observed, expected.identity);
    }
  }
  const current = capturePricingStartControl({ verifyReleases: false });
  for (const key of ['control', 'guard', 'marker', 'chain', 'allowed']) assert.deepEqual(current[key], value.final.pricingStartControl[key]);
  assert.deepEqual(JSON.parse(rootFile(PRICING_START_CONTROL + '/start-' + value.prior.runId + '.json')), value.final.writerStartIntent);
  return { readOnly: true, recoveredRun: value.prior.runId, source: value.entry.source, build: value.entry.build,
    fourRolesFresh: true, ...(value.works ? { sameRunWorksFresh: true } : {}),
    candidateFreshGateClaimed: false, at: new Date().toISOString() };
}
