import { releaseDependencyRoot } from './full-release-contract.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { assertWorksLifecycleObservation, assertWorksRecoveryActive, assertInstalledMultiviewRecipeAdoption,
  privateMultiviewRecipeProtection } from './multiview-works-control.mjs';
import { MV_DIRECT } from './release-contract.mjs';
import { createHash } from 'node:crypto';

const directory = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(directory + '/multiview-works-control.mjs', 'utf8');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const require = createRequire(releaseDependencyRoot(MV_DIRECT) + '/package.json');
const ts = require('typescript');
function functionDeclarationSource(text, name, file = 'fixture.mjs') {
  const parsed = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(parsed.parseDiagnostics.length, 0, 'Valid JavaScript module required: ' + file);
  const found = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(found.length, 1, 'Unique top-level function required: ' + file + ':' + name);
  const node = found[0];
  assert.ok(node.body, 'Function body required: ' + file + ':' + name);
  let result = node.getText(parsed);
  const exportModifiers = (node.modifiers || []).filter(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
  assert.ok(exportModifiers.length <= 1, 'At most one export modifier allowed: ' + file + ':' + name);
  if (exportModifiers.length === 1) {
    const nodeStart = node.getStart(parsed), modifier = exportModifiers[0];
    result = result.slice(0, modifier.getStart(parsed) - nodeStart) + result.slice(modifier.end - nodeStart);
  }
  return result;
}
const extractorFixture = `// export function targetFunction() { return 'comment-before'; }
export function targetFunction() { return 'actual-function'; }
/* function targetFunction() { return 'comment-after'; } */
export function adjacentExport() { return 'must-not-be-extracted'; }`;
const extractedFixture = functionDeclarationSource(extractorFixture, 'targetFunction');
assert.equal(vm.runInNewContext('(' + extractedFixture + ')')(), 'actual-function');
assert.equal(extractedFixture.includes('adjacentExport'), false);
assert.throws(() => functionDeclarationSource('// export function targetFunction() {}', 'targetFunction'));
assert.throws(() => functionDeclarationSource('function targetFunction() {}\nfunction targetFunction() {}', 'targetFunction'));
assert.throws(() => functionDeclarationSource('export function targetFunction( {', 'targetFunction'));
const serviceSource = functionDeclarationSource(source, 'service', 'multiview-works-control.mjs');
const serviceFields = ['User', 'Group', 'Restart', 'RestartUSec', 'KillMode', 'KillSignal', 'SendSIGKILL', 'TimeoutStopUSec',
  'TasksMax', 'FragmentPath', 'DropInPaths', 'ControlGroup', 'ExecMainCode', 'ExecMainStatus', 'ExecStart', 'ExecStartPre'];
const serviceChecks = [];
for (const scenario of ['present-nonempty', 'present-empty', 'typed-empty', 'unsupported', 'getter-failed', 'wrong-type', 'wrong-structure',
  'nonempty-typed-array-omitted', 'extra-typed-field', 'malformed-json', 'other-field-missing', 'systemctl-failed']) {
  let getterCalls = 0;
  const values = Object.fromEntries(serviceFields.map(field => [field, field + '-fixture']));
  if (scenario === 'present-empty') values.ExecStartPre = '';
  else if (scenario !== 'present-nonempty') delete values.ExecStartPre;
  if (scenario === 'other-field-missing') delete values.User;
  const fn = vm.runInNewContext('(' + serviceSource + ')', {
    assert: { ...assert, deepEqual: (a, b, message) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), message) },
    NAME: 'sd2-multiview-works.service', unit: name => ({ Id: name }),
    call: (command, argv) => {
      if (command === 'systemctl') {
        if (scenario === 'systemctl-failed') throw new Error('systemctl-execution-failed');
        return Object.entries(values).map(([key, value]) => key + '=' + value).join('\n');
      }
      assert.equal(command, 'busctl'); getterCalls++;
      assert.deepEqual([...argv], ['--json=short', 'get-property', 'org.freedesktop.systemd1',
        '/org/freedesktop/systemd1/unit/sd2_2dmultiview_2dworks_2eservice', 'org.freedesktop.systemd1.Service', 'ExecStartPre']);
      if (scenario === 'unsupported' || scenario === 'getter-failed') throw new Error(scenario);
      if (scenario === 'malformed-json') return '{';
      const typed = scenario === 'wrong-type' ? { type: 's', data: [] }
        : scenario === 'wrong-structure' ? { type: 'a(sasbttttuii)', data: null }
        : scenario === 'nonempty-typed-array-omitted' ? { type: 'a(sasbttttuii)', data: [['fixture']] }
        : scenario === 'extra-typed-field' ? { type: 'a(sasbttttuii)', data: [], extra: true }
        : { type: 'a(sasbttttuii)', data: [] };
      return JSON.stringify(typed);
    },
  });
  if (scenario === 'present-nonempty' || scenario === 'present-empty' || scenario === 'typed-empty') {
    const actual = fn();
    assert.equal(actual.ExecStartPre, scenario === 'present-nonempty' ? 'ExecStartPre-fixture' : '');
    assert.equal(getterCalls, scenario === 'typed-empty' ? 1 : 0);
  } else assert.throws(fn);
  serviceChecks.push(scenario);
}
const expected = { root: '/data/video-api-debugger/managed-releases/' + 'a'.repeat(40), source: 'a'.repeat(40),
  version: '0.103.0', build: 'fixtureBuild', sourceSha256: { 'fixture.ts': 'b'.repeat(64) } };
const observed = { oldProcessesAbsent: true, oldGroupEmptyOrReusedOnlyByCurrent: true, unitUnchangedExceptRecordedSource: true,
  startupVerified: true, current: { MainPID: '100', ControlPID: '0', ActiveState: 'active', SubState: 'running', InvocationID: 'a'.repeat(32) },
  groupPids: [100, 101], now: 1700000001000, runtime: { schema: 'multiview.works.v1', protocol: 'multiview.works.v1', state: 'active', pid: 101, parentPid: 100,
    sourceRoot: expected.root, source: expected.source, version: expected.version, build: expected.build,
    heartbeatAt: '2023-11-14T22:13:20.000Z', loadedModuleSha: expected.sourceSha256 } };
assert.equal(assertWorksLifecycleObservation(expected, observed), true);
const negative = [
  value => value.oldProcessesAbsent = false,
  value => value.oldGroupEmptyOrReusedOnlyByCurrent = false,
  value => value.unitUnchangedExceptRecordedSource = false,
  value => value.startupVerified = false,
  value => value.runtime.source = 'c'.repeat(40),
  value => value.runtime.sourceRoot = '/other',
  value => value.runtime.version = '0.1.0',
  value => value.runtime.build = 'wrong',
  value => value.runtime.loadedModuleSha['fixture.ts'] = 'c'.repeat(64),
  value => value.runtime.heartbeatAt = '2023-11-14T20:13:20.000Z',
  value => value.groupPids = [100],
  value => value.runtime.parentPid = 999,
];
for (const change of negative) { const value = structuredClone(observed); change(value); assert.throws(() => assertWorksLifecycleObservation(expected, value)); }

// A failed new worker is recoverable only after the original natural drain;
// it must not prevent the compatible guard from running, or admit an old source.
const protectionSource = functionDeclarationSource(source, 'inspectMultiviewWorksProtection', 'multiview-works-control.mjs');
for (const scenario of ['known-failed-drained', 'unknown-failed-source', 'no-natural-exit', 'residual-process']) {
  const known = scenario !== 'unknown-failed-source', natural = scenario !== 'no-natural-exit';
  const current = { ActiveState: 'failed', MainPID: '0', ControlPID: '0', WorkingDirectory: known ? expected.root : '/old', InvocationID: 'new' };
  const m = { main: expected, guard: { root: '/guard' }, live: { works: { pid: 9, invocation: 'old', root: '/old' } } };
  const assertUnitCalls = [];
  const fn = vm.runInNewContext('(' + protectionSource + ')', {
    assert, fs: { realpathSync: value => value },
    journals: () => [{ phase: natural ? 'stopped' : 'start-intent', naturalExit: natural }],
    original: () => ({ current: { ControlGroup: '/system.slice/fixture' } }), service: () => current,
    assertUnit: (_m, _captured, _current, kind) => assertUnitCalls.push(kind),
    groupPids: () => scenario === 'residual-process' ? [19] : [],
    baseline: () => ({ fixture: 'original-projection' }), verifyRunning: () => assert.fail('A failed worker is not active'),
  });
  if (scenario === 'known-failed-drained') {
    assert.deepEqual(fn(m), { fixture: 'original-projection' }); assert.ok(assertUnitCalls.includes('main'));
  } else assert.throws(() => fn(m));
}

function actualFunction(name, next, bindings) {
  void next; // Retain the established call shape; AST identity no longer depends on a neighboring declaration.
  return vm.runInNewContext('(' + functionDeclarationSource(source, name, 'multiview-works-control.mjs') + ')', bindings);
}
const recoveryDrainChecks = [];
for (const fault of ['main-active', 'baseline-active', 'pid-drift', 'invocation-drift', 'cgroup-drift', 'source-drift',
  'unconfirmed-start', 'fingerprint-drift', 'pending-natural-stop', 'residual-group', 'residual-process']) {
  const group = '/system.slice/sd2-multiview-works.service', events = [];
  const originalCurrent = { MainPID: '50', InvocationID: 'original-inv', ControlGroup: group,
    WorkingDirectory: '/baseline', ExecMainStartTimestampMonotonic: '4000' };
  const admitted = { MainPID: '100', InvocationID: 'new-inv', ControlGroup: group,
    WorkingDirectory: expected.root, ExecMainStartTimestampMonotonic: '5000' };
  const baselineCase = fault === 'baseline-active';
  const captured = { current: originalCurrent }, active = { phase: 'active', kind: 'main', source: expected.source,
    current: { ...admitted } };
  let entries = baselineCase ? [] : [{ phase: 'captured' }, active];
  if (fault === 'unconfirmed-start') entries = [{ phase: 'start-intent', kind: 'main' }];
  let live = { ActiveState: 'active', ...(baselineCase ? originalCurrent : admitted) };
  if (fault === 'pid-drift') live.MainPID = '101';
  if (fault === 'invocation-drift') live.InvocationID = 'other';
  if (fault === 'cgroup-drift') live.ControlGroup = '/system.slice/other.service';
  if (fault === 'source-drift') live.WorkingDirectory = '/other';
  let stopped = false, stopCalls = 0;
  const fn = actualFunction('stopMultiviewWorksForGuardRecovery', 'finishPrivateMultiviewPreopen', {
    assert: { ...assert, deepEqual: (a, b, message) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), message) },
    MV_DIRECT: { privateMultiviewInstall: true }, Date,
    assertLock: () => events.push('owned-lock'),
    assertWorksRecoveryActive,
    journals: () => entries,
    capture: () => { events.push('capture'); if (!entries.length) entries = [{ phase: 'captured' }]; return captured; },
    service: () => stopped ? { ...live, ActiveState: 'inactive', MainPID: '0', ControlPID: '0',
      Result: 'success', ExecMainStatus: '0', ExecMainCode: '1' } : live,
    assertUnit: () => events.push('unit-contract'),
    verifyRunning: (_m, c, kind) => { assert.equal(c, captured); assert.equal(kind, 'main'); events.push('verified-loaded-source');
      if (fault === 'fingerprint-drift') throw new Error('loaded-fingerprint-drift'); },
    inspectMultiviewWorksProtection: () => events.push('original-protection'),
    groupPids: () => stopped ? fault === 'residual-group' ? [100] : [] : baselineCase ? [50, 51] : [100, 101],
    stop: async (_m, c) => {
      assert.equal(c, captured); stopCalls++; events.push('original-natural-stop');
      if (fault === 'pending-natural-stop') throw Object.assign(new Error('pending'), { code: 'NATURAL_STOP_PENDING' });
      stopped = true; entries.push({ phase: 'stopped', naturalExit: true });
    },
    exists: file => stopped && fault === 'residual-process' && file === '/proc/100',
    manifestSha: () => 'fixture-manifest',
    record: (_m, phase, value) => { events.push(phase); assert.equal(value.forcedKill, false); },
  });
  const m = { runId: 'fixture', mainSource: expected.source, main: expected, guard: { root: '/guard' } };
  if (fault === 'main-active' || fault === 'baseline-active') {
    const value = await fn(m, () => {});
    assert.equal(stopCalls, 1); assert.equal(value.allAdmittedProcessesGone, true); assert.equal(value.naturalExit, true);
    assert.ok(events.indexOf('capture') < events.indexOf('original-natural-stop'));
    if (!baselineCase) assert.ok(events.indexOf('verified-loaded-source') < events.indexOf('original-natural-stop'));
    assert.ok(events.indexOf('original-natural-stop') < events.indexOf('fixed-guard-natural-drain'));
  } else {
    const error = await fn(m, () => {}).then(() => assert.fail('Expected recovery drain refusal'), error => error);
    if (fault === 'pending-natural-stop') assert.equal(error.code, 'NATURAL_STOP_PENDING');
    if (!['pending-natural-stop', 'residual-group', 'residual-process'].includes(fault)) assert.equal(stopCalls, 0);
    assert.equal(events.includes('fixed-guard-natural-drain'), false);
  }
  recoveryDrainChecks.push(fault);
}

const recoveryContractChecks = [];
const recoveryModuleSha = Object.fromEntries(Array.from({ length: 12 }, (_, index) => ['module-' + index, hash(Buffer.from('module-' + index))]));
const recoveryIdentity = { MainPID: '300', ControlPID: '0', ControlGroup: '/system.slice/sd2-multiview-works.service',
  InvocationID: '1'.repeat(32), WorkingDirectory: expected.root, ActiveState: 'active', SubState: 'running' };
const recoveryRuntime = { pid: 301, parentPid: 300, sourceRoot: expected.root, source: expected.source,
  version: expected.version, build: expected.build, startedAt: '2026-10-22T20:00:00.000Z', loadedModuleSha: recoveryModuleSha };
const recoveryContractM = { runId: 'recovery-contract', mainSource: expected.source,
  main: expected, guard: { ...expected, root: '/guard', source: 'd'.repeat(40), version: '0.103.0-guard.1' } };
const journalEntry = (sequence, at, details) => ({ runId: recoveryContractM.runId, manifestSha256: 'fixture-manifest',
  sequence, previousSha256: sequence === 1 ? null : hash(Buffer.from('journal-' + (sequence - 1))), phase: 'active', at, ...details });
function recoveryContract(kind) {
  const selected = recoveryContractM[kind], root = selected.root;
  const current = { ...recoveryIdentity, WorkingDirectory: root };
  const runtime = { ...recoveryRuntime, sourceRoot: root, source: selected.source, version: selected.version,
    loadedModuleSha: { ...recoveryModuleSha } };
  const active = journalEntry(1, '2026-10-22T20:00:00.000Z', { kind, source: selected.source, current, runtime });
  const ready = { schema: 'multiview-works-ready.v1', kind, source: selected.source, version: selected.version,
    build: runtime.build, unit: 'sd2-multiview-works.service', naturalExit: true, at: '2026-10-22T20:00:01.000Z',
    current: { ...current }, runtime: { ...runtime, loadedModuleSha: { ...runtime.loadedModuleSha } } };
  if (kind === 'guard') return { entries: [active, journalEntry(2, '2026-10-22T20:00:02.000Z', { kind, guardSafe: true })], ready,
    confirmation: null };
  const confirmation = { schema: 'multiview-private-preopen-complete.v1', readyToOpen: true, source: recoveryContractM.mainSource,
    build: ready.build, at: '2026-10-22T20:00:02.000Z', works: { current: { ...ready.current },
      runtime: { ...ready.runtime, loadedModuleSha: { ...ready.runtime.loadedModuleSha } } } };
  return { entries: [active,
    { ...journalEntry(2, '2026-10-22T20:00:00.500Z', {}), phase: 'recipe-adopt-intent' },
    { ...journalEntry(3, '2026-10-22T20:00:00.750Z', {}), phase: 'recipe-adopted' },
    journalEntry(4, '2026-10-22T20:00:03.000Z', { kind, privateReady: true })], ready, confirmation };
}
for (const kind of ['main', 'guard']) {
  const value = recoveryContract(kind);
  assert.equal(assertWorksRecoveryActive(recoveryContractM, value.entries, value.ready, value.confirmation).kind, kind);
  recoveryContractChecks.push(kind + '-full-active-to-ready-summary');
}
const originalInstallRecovery = recoveryContract('main');
originalInstallRecovery.entries[1].phase = 'recipe-install-intent'; originalInstallRecovery.entries[2].phase = 'recipe-installed';
assert.equal(assertWorksRecoveryActive(recoveryContractM, originalInstallRecovery.entries,
  originalInstallRecovery.ready, originalInstallRecovery.confirmation).kind, 'main');
recoveryContractChecks.push('original-install-full-active-to-ready-private-summary');
const recoveryRejections = [
  ['missing-full', value => value.entries.splice(0, 1)],
  ['wrong-kind', value => value.entries.at(-1).kind = 'unknown'],
  ['wrong-source', value => value.entries[0].source = 'f'.repeat(40)],
  ['pid-drift', value => value.ready.current.MainPID = '302'],
  ['invocation-drift', value => value.confirmation.works.current.InvocationID = '2'.repeat(32)],
  ['module-drift', value => value.ready.runtime.loadedModuleSha['module-0'] = '0'.repeat(64)],
  ['ready-invalid', value => value.ready.schema = 'unknown'],
  ['confirmation-invalid', value => value.confirmation.readyToOpen = false],
  ['order-invalid', value => value.entries.at(-1).at = '2026-10-22T19:59:59.000Z'],
  ['unknown-summary', value => value.entries.at(-1).unexpected = true],
];
for (const [name, mutate] of recoveryRejections) {
  const value = structuredClone(recoveryContract('main')); mutate(value);
  assert.throws(() => assertWorksRecoveryActive(recoveryContractM, value.entries, value.ready, value.confirmation));
  recoveryContractChecks.push(name);
}

const recipeAdoptionChecks = [];
function recipeAdoptionContract() {
  const prompt = 'synthetic private rotation prompt', guideSHA = hash(Buffer.from('synthetic guide'));
  const ownerId = 'owner-fixture', mutationId = 'mutation-fixture', requestHash = hash(Buffer.from('request-fixture'));
  const defaults = { duration: 6, views: 8 }, ref2binding = { assetId: 'asset-fixture', ownerId };
  const input = { expectedRevision: 5, fullprompt: prompt, expectedPromptSHA: hash(Buffer.from(prompt)), guideSHA,
    defaults, ref2binding, mutationId, sourceTaskId: 'task-fixture' };
  const payloadSha256 = hash(Buffer.from('payload-fixture')), planSha256 = hash(Buffer.from('plan-fixture'));
  const verificationSha256 = hash(Buffer.from('verification-fixture'));
  const inspection = { sourceTaskMatched: true, guideMatched: true, revision: 6, version: '1.0.6' };
  const currentValue = { revision: 6, preset: { id: 'multiview-360', version: '1.0.6', prompt,
    defaults, compositionReference: ref2binding } };
  const current = JSON.stringify(currentValue), activation = JSON.stringify({ active: '1.0.6' });
  const guideUrl = 'https://sd2.youdooart.com/uploads/synthetic-guide.png';
  const guidePath = '/uploads/synthetic-guide.png';
  const protection = JSON.stringify({ kind: 'system-reference', assetId: ref2binding.assetId,
    ownerId, sha256: guideSHA, urls: [guideUrl, guidePath] });
  const targetIdentity = { dev: 7, ino: 8, uid: 0, gid: 0, mode: 0o600, nlink: 1, size: 15 };
  const installedProof = { currentSha256: hash(Buffer.from(current)), activationSha256: hash(Buffer.from(activation)),
    protectionSha256: hash(Buffer.from(protection)), targetIdentity };
  const applied = { schema: 'multiview-private-recipe-apply.v1', production: true, revision: 6, version: '1.0.6',
    payloadSha256, guideSha256: guideSHA, planSha256, verificationSha256, requestHash,
    activatedAt: '2026-10-22T20:00:00.000Z', activationCreated: true, installedProof,
    target: '/data/video-api-debugger/var-lib/storage/multiview-recipes/' + guideSHA + '.png' };
  const detail = { previousRevision: 5, requestHash,
    receipt: { state: 'saved', mutationId, ...currentValue },
    install: { schema: 'multiview-private-recipe-install.v1', state: 'installed', mutationId,
      revision: 6, version: '1.0.6', requestHash, activatedAt: applied.activatedAt,
      activationCreated: applied.activationCreated, sourceTaskMatched: true, guideMatched: true } };
  const records = { input,
    plan: { schema: 'multiview-private-recipe-plan.v1', payloadSha256, guideSha256: guideSHA, inspection },
    verification: { schema: 'multiview-private-recipe-verification.v1', payloadSha256, guideSha256: guideSHA,
      planSha256, inspection: { ...inspection } }, applied,
    preopen: { schema: 'multiview-private-preopen-complete.v1', runId: '19a7cc3d-b11e-44c8-a754-d79e9c5624d1',
      manifestSha256: '00d4c9fa89a4368d0761adff3017ff2e58dcd8e58cc76b7698c3bab167cce7c8', readyToOpen: true,
      recipe: { applied: true, revision: 6, version: '1.0.6' } },
    payloadSha256, planSha256, verificationSha256 };
  const observed = { current, immutable: current, activation, protection, aliases: [guideUrl],
    sourceTask: { owner: ownerId, promptSha256: input.expectedPromptSHA, snapshotSha256: input.expectedPromptSHA },
    operation: { operator_id: ownerId, action: 'multiview_rotation_preset_save', target_type: 'MultiviewRotationPreset',
      target_id: 'multiview-360', detail: JSON.stringify(detail) }, guide: { identity: { ...targetIdentity }, sha256: guideSHA } };
  const m = { runId: '22222222-2222-4222-8222-222222222222', privateMultiviewInstall: true,
    recoveredGuardBaseline: { schema: 'sd2-multiview-r17-recovered-guard.v1',
      runId: '19a7cc3d-b11e-44c8-a754-d79e9c5624d1',
      manifestSha256: '00d4c9fa89a4368d0761adff3017ff2e58dcd8e58cc76b7698c3bab167cce7c8',
      recoveryEvidenceIndexSha256: 'd76bc0fa5808b68a5c4b2c347dfbb3d736d6c568b7b5f2d45deb5c54034b5081',
      installedRecipeReceiptSha256: 'ab71ea60b1a7c54f405910ce76389a0a21181058fbb7a81715afd0a47a2349b3' } };
  return { m, records, observed, mutationId, requestHash };
}
const recipeAdoption = recipeAdoptionContract();
const adoptedRecipe = assertInstalledMultiviewRecipeAdoption(recipeAdoption.m, recipeAdoption.records, recipeAdoption.observed);
assert.equal(adoptedRecipe.adopted, true); assert.equal(adoptedRecipe.applied, false); assert.equal(adoptedRecipe.businessWrites, 0);
assert.equal(adoptedRecipe.originalMutationIdSha256, hash(Buffer.from(recipeAdoption.mutationId)));
assert.equal(adoptedRecipe.requestHash, recipeAdoption.requestHash); recipeAdoptionChecks.push('exact-r17-installed-recipe-adopted');
const recipeAdoptionRejections = [
  ['missing-current-proof', value => delete value.records.applied.installedProof.currentSha256],
  ['missing-activation-proof', value => delete value.records.applied.installedProof.activationSha256],
  ['missing-protection-proof', value => delete value.records.applied.installedProof.protectionSha256],
  ['missing-guide-identity-proof', value => delete value.records.applied.installedProof.targetIdentity],
  ['current-drift', value => value.observed.current += ' '],
  ['immutable-drift', value => value.observed.immutable += ' '],
  ['activation-drift', value => value.observed.activation += ' '],
  ['url-drift', value => value.observed.aliases = ['https://example.invalid/uploads/guide.png']],
  ['guide-drift', value => value.observed.guide.sha256 = '0'.repeat(64)],
  ['original-receipt-pin-drift', value => value.m.recoveredGuardBaseline.installedRecipeReceiptSha256 = '0'.repeat(64)],
  ['fake-normal-origin', value => value.m.recoveredGuardBaseline.schema = 'rate-impl2-release.v1'],
  ['mutation-id-drift', value => { const detail = JSON.parse(value.observed.operation.detail);
    detail.receipt.mutationId = 'other-mutation'; value.observed.operation.detail = JSON.stringify(detail); }],
  ['request-hash-drift', value => { const detail = JSON.parse(value.observed.operation.detail);
    detail.install.requestHash = '0'.repeat(64); value.observed.operation.detail = JSON.stringify(detail); }],
];
for (const [name, mutate] of recipeAdoptionRejections) {
  const value = structuredClone(recipeAdoptionContract()); mutate(value);
  assert.throws(() => assertInstalledMultiviewRecipeAdoption(value.m, value.records, value.observed));
  recipeAdoptionChecks.push(name);
}

async function scenario(fault) {
  const events = [], adoptionMode = fault === 'adopted' || fault === 'adoption-mismatch';
  const state = { touched: false, installed: false, live: false, adoptionReads: 0 };
  const m = { runId: 'fixture', stage: '/fixture', database: '/fixture/database', mainSource: expected.source,
    main: expected, guard: { ...expected, source: 'd'.repeat(40) } };
  const captured = {};
  const ready = { current: {}, runtime: { build: expected.build } };
  const bindings = { assert, MV_DIRECT: { privateMultiviewInstall: true }, Date,
    assertReleaseWindow: () => {},
    assertLock: () => { events.push('lock'); if (fault === 'before-hook') throw new Error('fixture'); },
    capture: () => { events.push('capture'); return captured; },
    start: async (_m, _captured, kind) => {
      assert.notEqual(kind, 'original'); events.push('start-' + kind); state.touched = true;
      if (fault === 'works-barrier' && kind === 'main') throw new Error('fixture');
      state.live = true; return { kind, ...ready };
    },
    verifyRunning: (_m, _captured, kind) => { assert.equal(state.live, true); events.push('verify-' + kind); return ready; },
    freshGuideInventory: () => events.push('inflight-readonly'),
    manifestSha: () => 'manifest',
    writeJsonExclusive: file => events.push(path.basename(file)),
    inspectInstalledMultiviewRecipeAdoption: () => {
      if (!adoptionMode) return null;
      state.adoptionReads++; events.push('adopt-fresh');
      return fault === 'adoption-mismatch' && state.adoptionReads === 2
        ? { ...structuredClone(adoptedRecipe), requestHash: '0'.repeat(64) } : structuredClone(adoptedRecipe);
    },
    writeAdmission: () => { events.push('write-admission'); assert.equal(adoptionMode, false); return '/fixture/admission'; },
    authorizeRecipeTransition: () => { events.push('exact-transition-authorized'); assert.equal(adoptionMode, false); },
    publishMultiviewBackupControl: () => { events.push('backup-control'); if (fault === 'backup-control') throw new Error('fixture'); return { published: true }; },
    inspectMultiviewBackupProtection: () => events.push('backup-control-fresh'),
    createMultiviewIsolatedBackupCopy: () => { events.push('isolated-copy'); if (fault === 'isolated-copy') throw new Error('fixture'); return { directory: '/isolated/copy' }; },
    record: (_m, phase) => events.push(phase),
    privateCommand: () => {
      assert.equal(adoptionMode, false);
      events.push('install'); if (fault === 'before-transaction') throw new Error('fixture');
      state.installed = true; if (fault === 'after-transaction') throw new Error('fixture');
      return { phase: 'apply', applied: true, revision: 1, version: '1.0.1' };
    },
    call: (_bin, args) => {
      if (args.includes('--verify-backup')) {
        assert.equal(args[args.indexOf('--verify-backup') + 1], '/isolated/copy');
        events.push('isolated-restore'); if (fault === 'isolated-restore') throw new Error('fixture');
        return JSON.stringify({ verified: true, recipeVersions: 1, directory: '/isolated/copy' });
      }
      events.push('backup'); if (fault === 'backup') throw new Error('fixture');
      return JSON.stringify({ complete: true, directory: '/data/video-api-debugger/backups/multiview-private-fixture' });
    },
    journals: () => state.touched ? [{}] : [], original: () => captured,
    service: () => ({ ActiveState: state.live ? 'active' : 'inactive' }),
  };
  const guard = actualFunction('ensurePrivateMultiviewGuard', null, bindings);
  bindings.ensurePrivateMultiviewGuard = guard;
  const preopen = actualFunction('finishPrivateMultiviewPreopen', 'ensurePrivateMultiviewGuard', bindings);
  const context = { kind: 'main', healthy: { source: expected.source, build: expected.build }, web: {},
    observeMaintenance: async () => { events.push('observe-503'); return [{ status: 503 }, { status: 503 }]; } };
  let complete = null;
  try { complete = await preopen(m, context); }
  catch {
    events.push('guard-recovery'); await guard(m, () => {});
  }
  if (!fault || fault === 'adopted') {
    assert.equal(complete.readyToOpen, true);
    assert.ok(events.indexOf('backup') < events.indexOf('isolated-copy') && events.indexOf('isolated-copy') < events.indexOf('isolated-restore'));
    if (!fault) assert.ok(events.indexOf('start-main') < events.indexOf('install') && events.indexOf('install') < events.indexOf('backup')
      && events.indexOf('backup-control') < events.indexOf('install'));
    else {
      assert.equal(state.adoptionReads, 2); assert.equal(complete.recipe.adopted, true); assert.equal(complete.recipe.applied, false);
      assert.equal(events.includes('install'), false); assert.equal(events.includes('write-admission'), false);
      assert.equal(events.includes('exact-transition-authorized'), false);
      assert.ok(events.indexOf('backup-control') < events.indexOf('adopt-fresh')
        && events.indexOf('recipe-adopted') < events.indexOf('backup'));
    }
  } else {
    assert.equal(complete, null); assert.ok(!events.includes('multiview-private-preopen-complete.json'));
    if (fault === 'adoption-mismatch') {
      assert.equal(state.adoptionReads, 2); assert.equal(events.includes('multiview-private-recipe-adopted.json'), false);
      assert.equal(events.includes('install'), false); assert.equal(events.includes('write-admission'), false);
      assert.equal(events.includes('exact-transition-authorized'), false);
    }
    assert.ok(!events.includes('start-original')); assert.equal(state.installed, ['after-transaction', 'backup', 'isolated-copy', 'isolated-restore'].includes(fault));
    if (state.touched) assert.equal(state.live, true);
  }
  return { fault: fault || 'none', installed: state.installed, events };
}
const stages = [];
for (const fault of [null, 'before-hook', 'works-barrier', 'backup-control', 'before-transaction', 'after-transaction', 'backup', 'isolated-copy', 'isolated-restore']) stages.push(await scenario(fault));
stages.push(await scenario('adopted'), await scenario('adoption-mismatch'));

// Run the real copy body against a synthetic virtual /data tree. The adapter
// remaps paths and ownership only; bytes, no-follow opens and copy operations
// use the actual filesystem, without reading a production backup.
const copyTemporary = fs.mkdtempSync(path.join(os.tmpdir(), 'multiview-isolated-copy-'));
try {
  const runId = 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12), sourceId = 'a'.repeat(40);
  const base = '/data/video-api-debugger-engineering/' + runId;
  const backup = '/data/video-api-debugger/backups/multiview-private-' + runId;
  const destination = base + '/restore-' + sourceId;
  const mapped = file => file === '/' ? copyTemporary : copyTemporary + file;
  const unmapped = file => file === copyTemporary ? '/' : file.slice(copyTemporary.length);
  const adjusted = (stat, root = false) => new Proxy(stat, { get(target, key) {
    if (key === 'uid') return 0; if (key === 'dev') return root ? 0 : 1;
    return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
  } });
  const virtualFs = { ...fs,
    lstatSync: file => adjusted(fs.lstatSync(mapped(file)), file === '/'),
    statSync: file => adjusted(fs.statSync(mapped(file)), file === '/'),
    fstatSync: fd => adjusted(fs.fstatSync(fd)),
    realpathSync: file => unmapped(fs.realpathSync(mapped(file))),
    existsSync: file => fs.existsSync(mapped(file)),
    openSync: (file, ...args) => fs.openSync(mapped(file), ...args),
    mkdirSync: (file, ...args) => fs.mkdirSync(mapped(file), ...args),
    readdirSync: (file, ...args) => fs.readdirSync(mapped(file), ...args),
    copyFileSync: (from, to, ...args) => fs.copyFileSync(mapped(from), mapped(to), ...args),
    chmodSync: (file, ...args) => fs.chmodSync(mapped(file), ...args),
  };
  for (const file of [base, backup]) fs.mkdirSync(mapped(file), { recursive: true, mode: 0o700 });
  for (const name of ['database.sqlite3', 'mapping.json']) fs.writeFileSync(mapped(backup + '/' + name), 'synthetic-' + name, { mode: 0o600 });
  fs.mkdirSync(mapped(backup + '/recipes'), { mode: 0o700 });
  fs.writeFileSync(mapped(backup + '/recipes/guide.png'), 'synthetic-media', { mode: 0o600 });
  const copies = [];
  const fn = vm.runInNewContext('(' + functionDeclarationSource(source, 'createMultiviewIsolatedBackupCopy', 'multiview-works-control.mjs') + ')', {
    assert, fs: virtualFs, path, process: { platform: 'linux', getuid: () => 0 }, createHash,
    exists: virtualFs.existsSync, manifestSha: () => 'synthetic-manifest',
    writeJsonExclusive: (_file, record) => copies.push(record), Buffer, Date,
  });
  const m = { runId, mainSource: sourceId, stage: '/synthetic-stage' };
  fs.symlinkSync('missing', mapped(backup + '/blocked-link'));
  assert.throws(() => fn(m, backup)); assert.equal(copies.length, 0);
  fs.unlinkSync(mapped(backup + '/blocked-link'));
  // A partial copy is evidence, not a reusable destination. Use a new run,
  // leaving the failed synthetic tree intact until fixture cleanup.
  const nextRun = runId.replace(/^a/, 'b'), nextBackup = backup.replace(runId, nextRun);
  fs.mkdirSync(mapped(base.replace(runId, nextRun)), { recursive: true, mode: 0o700 });
  fs.cpSync(mapped(backup), mapped(nextBackup), { recursive: true });
  const complete = fn({ ...m, runId: nextRun }, nextBackup);
  assert.equal(complete.productionDatabaseRestored, false); assert.equal(copies.length, 1);
  assert.notEqual(complete.directory, nextBackup);
  assert.deepEqual(fs.readFileSync(mapped(complete.directory + '/recipes/guide.png')), Buffer.from('synthetic-media'));
  assert.throws(() => fn({ ...m, runId: nextRun }, nextBackup));
  assert.throws(() => fn(m, destination));
} finally { fs.rmSync(copyTemporary, { recursive: true, force: true }); }

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'multiview-protection-'));
try {
  fs.chmodSync(temporary, 0o700); fs.mkdirSync(temporary + '/private-recipe', { mode: 0o700 });
  const value = { fixture: true }, payload = Buffer.from(JSON.stringify(value)), plan = Buffer.from('fixture plan'), verification = Buffer.from('fixture verification');
  const before = { current: 'old', immutable: 'old-immutable' };
  const manifest = Buffer.from('{}');
  for (const [name, bytes] of [['manifest.json', manifest], ['private-recipe/payload.json', payload],
    ['private-recipe/plan.json', plan], ['private-recipe/verification.json', verification]]) fs.writeFileSync(temporary + '/' + name, bytes, { mode: 0o600 });
  fs.writeFileSync(temporary + '/multiview-recipe-transition.json', JSON.stringify({ runId: 'fixture', manifestSha256: hash(manifest),
    before, payloadSha256: hash(payload), planSha256: hash(plan), verificationSha256: hash(verification),
    currentKey: 'current', versionKey: 'new-version', expectedSha256: 'intended-new' }), { mode: 0o600 });
  const m = { runId: 'fixture', stage: temporary };
  assert.deepEqual(privateMultiviewRecipeProtection(m, before), before);
  assert.deepEqual(privateMultiviewRecipeProtection(m, { ...before, current: 'intended-new', 'new-version': 'intended-new' }), before);
  assert.throws(() => privateMultiviewRecipeProtection(m, { ...before, immutable: 'changed', current: 'intended-new', 'new-version': 'intended-new' }));
  assert.notDeepEqual(privateMultiviewRecipeProtection(m, { ...before, current: 'unknown' }), before);
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }

const switching = fs.readFileSync(directory + '/switch.mjs', 'utf8');
const normal = switching.slice(switching.indexOf("const kind = mode === 'switch'"));
assert.ok(normal.indexOf('finishPrivateMultiviewPreopen') < normal.indexOf('restoreNginxMaintenance'));
const recovery = switching.slice(switching.indexOf('startGuard: async () =>'), switching.indexOf('openIngress: async'));
assert.ok(recovery.includes('ensurePrivateMultiviewGuard'));
assert.ok(fs.readFileSync(directory + '/common.mjs', 'utf8').includes('privateMultiviewRecipeProtection(m, business.privateRecipeSettings)'));
const backupEngineering = JSON.parse(execFileSync(process.execPath, [directory + '/multiview-backup-engineering.mjs'], { encoding: 'utf8', timeout: 120000 }));
assert.equal(backupEngineering.completed, true);
console.log(JSON.stringify({ schema: 'multiview-private-control-engineering.v1', completed: true, synthetic: true,
  productionWrites: 0, servicesChanged: false, realDatabaseOpened: false,
  serviceChecks, recoveryDrainChecks, recoveryContractChecks, recipeAdoptionChecks,
  checks: ['actual_lifecycle_observation_positive_and_twelve_rejections', 'actual_preopen_body_eleven_success_failure_paths',
    'ast_function_extraction_comment_and_adjacent_export_positive_and_three_rejections',
    'actual_recovery_drain_body_binds_baseline_or_admitted_identity_before_natural_stop_and_empty_group',
    'actual_recovery_active_contract_two_positive_and_ten_rejections',
    'exact_r17_installed_recipe_adoption_one_positive_and_thirteen_rejections',
    'known_new_worker_failure_requires_original_drain_and_empty_group',
    'actual_isolated_copy_body_copies_bytes_and_rejects_links_reuse_and_wrong_source',
    'exact_private_recipe_transition_preserves_history', 'normal_and_guard_preopen_static_wiring', 'existing_backup_unit_exact_transition'], stages, backupEngineering }));
