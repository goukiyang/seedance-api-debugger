import { releaseDependencyRoot, fullSchemaBefore, applyFullSchema } from './full-release-contract.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { candidateEvidenceFile, assertFreshCandidateEvidence, candidateEvidenceExpiresAt, REUSE_SCHEMA,
  GUARD_BUILD_TAIL_SCHEMA, candidateCompatibilityDirectory, candidateGateObservation } from './candidate-evidence.mjs';
import { parseReleaseTimestamp, isSharedEngine, engineDirectory } from './common.mjs';
import { releaseBoundary } from './engine-context.mjs';
import { loadHdCompiledCacheProofs } from './hd-compiled-cache.mjs';
import { assertHdMaintenanceApproval, privateFreezeSha256 } from './cutover-driver.mjs';
import { assertNaturalExitEvidence } from './switch.mjs';
import { assertNoCutoverEffects, CONTINUATION_V2, assertContinuationInput, assertDeployedContinuationSources } from './normal-continuation.mjs';
import { assertUsageRoleStart } from './usage-role-start.mjs';
import { MV_DIRECT, assertProtectedIncrementCandidate } from './release-contract.mjs';

assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const sameAssert = { ...assert, deepEqual: (a, b, message) => assert.deepEqual(copy(a), copy(b), message) };
const source = name => fs.readFileSync(new URL(name, import.meta.url), 'utf8');
const sources = Object.fromEntries(['common.mjs', 'candidate.mjs', 'candidate-inputs.mjs', 'hd-storage-preflight.mjs',
  'candidate-reuse.mjs', 'candidate-evidence.mjs', 'switch.mjs',
  'guard-recovery.mjs', 'pricing-start-pair.mjs', 'normal-continuation.mjs', 'usage-role-control.mjs',
  'usage-role-start.mjs', 'deployed-usage-schema.mjs', 'canvas-batch-schema.mjs', 'canvas-batch-schema-contract.mjs',
  'raw-upload-recovery-proof.mjs', 'nginx-maintenance.mjs', 'package-candidates.mjs', 'writer-network-fence.mjs',
  'multiview-works-control.mjs'].map(name => [name, source(name)]));
const cases = [], traces = [];
const add = name => cases.push(name);
const require = createRequire(releaseDependencyRoot(MV_DIRECT) + '/package.json');
const ts = require('typescript');
function scriptBody(text) {
  const parsed = ts.createSourceFile('fixture.mjs', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(parsed.parseDiagnostics.length, 0);
  const edits = [];
  for (const statement of parsed.statements) {
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
      edits.push([statement.getStart(parsed), statement.end]);
    else for (const modifier of statement.modifiers || [])
      if (modifier.kind === ts.SyntaxKind.ExportKeyword) edits.push([modifier.getStart(parsed), modifier.end]);
  }
  for (const [start, end] of edits.sort((a, b) => b[0] - a[0])) text = text.slice(0, start) + text.slice(end);
  return text;
}

// Reuse the actual output expressions. A changed producer shape fails closed;
// the fixture never maintains a second, partial prepared/build receipt schema.
const producerExpressions = {};
function parsedModule(name) {
  const parsed = ts.createSourceFile(name, sources[name], ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(parsed.parseDiagnostics.length, 0); return parsed;
}
function functionNode(module, name) {
  const parsed = parsedModule(module);
  const found = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(found.length, 1, 'Unique production function required: ' + module + ':' + name);
  assert.ok(found[0].body); return { parsed, node: found[0] };
}
const backupProjectionNames = ['inspectMultiviewBackupProtection', 'privateMultiviewBackupFileProtection'];
const backupProjectionImport = parsedModule('switch.mjs').statements.filter(node => ts.isImportDeclaration(node)
  && node.moduleSpecifier.text === './multiview-backup-control.mjs');
assert.equal(backupProjectionImport.length, 1);
assert.deepEqual(backupProjectionImport[0].importClause.namedBindings.elements.map(node => {
  assert.equal(node.propertyName, undefined); return node.name.text;
}), backupProjectionNames);
const backupProjectionNode = functionNode('switch.mjs', 'projectPrivateMultiviewProtectedFileSnapshot');
const protectedNode = functionNode('switch.mjs', 'assertProtected');
assert.match(protectedNode.node.getText(protectedNode.parsed), /projectPrivateMultiviewProtectedFileSnapshot\(m, file, protectedFileSnapshot\(file\)\)/);
const backupProjectionChecks = [];
for (const scenario of ['exact-transition', 'unchanged', 'not-private', 'other-file', 'inspector-refusal', 'unknown-state']) {
  const file = '/etc/systemd/system/sd2-backup.service.d/90-multiview-works.conf', calls = [];
  const observed = { file, real: file, dev: '1', ino: '3', uid: 0, gid: 0, mode: 0o644, nlink: 1, sha256: 'b'.repeat(64) };
  const original = { identity: ['1', '2'], uid: 0, gid: 0, mode: 0o644, sha256: 'a'.repeat(64), attributes: '--------------e-------' };
  const fn = vm.runInNewContext('(' + backupProjectionNode.node.getText(backupProjectionNode.parsed).replace(/^export /, '') + ')', {
    MV_DIRECT: { privateMultiviewInstall: scenario !== 'not-private' },
    inspectMultiviewBackupProtection: () => { calls.push('full-inspect'); if (scenario === 'inspector-refusal') throw Error('inspector-refusal'); },
    privateMultiviewBackupFileProtection: (_m, target, state) => {
      calls.push('exact-file-projection'); assert.equal(target, file);
      assert.deepEqual(copy(state), { identity: [observed.dev, observed.ino], uid: 0, gid: 0, mode: 0o644,
        sha256: observed.sha256, attributes: original.attributes });
      if (scenario === 'unknown-state') throw Error('unknown-state');
      return scenario === 'unchanged' ? state : original;
    }, call: (name, args) => { assert.equal(name, 'lsattr'); assert.deepEqual([...args], ['-d', '--', file]); return original.attributes + ' ' + file; },
  });
  if (scenario === 'inspector-refusal' || scenario === 'unknown-state') assert.throws(() => fn({}, file, observed), new RegExp(scenario));
  else {
    const value = fn({}, scenario === 'other-file' ? '/other' : file, observed);
    if (['not-private', 'other-file'].includes(scenario)) { assert.equal(value, observed); assert.deepEqual(calls, []); }
    else {
      assert.deepEqual(calls, ['full-inspect', 'exact-file-projection']);
      assert.equal(value.ino, scenario === 'unchanged' ? observed.ino : original.identity[1]);
      assert.equal(value.sha256, scenario === 'unchanged' ? observed.sha256 : original.sha256);
      for (const key of ['file', 'real', 'nlink']) assert.equal(value[key], observed[key]);
    }
  }
  backupProjectionChecks.push(scenario);
}
const privateSwitchHookNames = ['finishPrivateMultiviewPreopen', 'ensurePrivateMultiviewGuard', 'stopMultiviewWorksForGuardRecovery'];
const privateSwitchImport = parsedModule('switch.mjs').statements.filter(node => ts.isImportDeclaration(node)
  && node.moduleSpecifier.text === './multiview-works-control.mjs');
assert.equal(privateSwitchImport.length, 1);
const privateSwitchNamedBindings = privateSwitchImport[0].importClause.namedBindings;
assert.ok(ts.isNamedImports(privateSwitchNamedBindings));
assert.deepEqual(privateSwitchNamedBindings.elements.map(node => {
  assert.equal(node.propertyName, undefined, 'Historical private hooks must retain their exact imported names');
  return node.name.text;
}), privateSwitchHookNames);
const privateRecoveryStop = functionNode('multiview-works-control.mjs', 'stopMultiviewWorksForGuardRecovery');
// Only the actual production function's unrequested branch is available here.
// Enabled private recovery remains covered by works/guard engineering, not this historical lifecycle.
const stopUnrequestedPrivateWorks = vm.runInNewContext('(' + privateRecoveryStop.node.getText(privateRecoveryStop.parsed)
  .replace(/^export /, '') + ')', { MV_DIRECT: { privateMultiviewInstall: false } });
function assertPrivateSwitchBindings(bindings, expected) {
  for (const name of privateSwitchHookNames) {
    assert.equal(typeof expected[name], 'function');
    assert.equal(bindings[name], expected[name], 'Missing or replaced historical private hook: ' + name);
  }
}
const hdAdmissionImport = parsedModule('switch.mjs').statements.filter(node => ts.isImportDeclaration(node)
  && node.moduleSpecifier.text === './hd-storage-preflight.mjs');
assert.equal(hdAdmissionImport.length, 1);
assert.ok(ts.isNamedImports(hdAdmissionImport[0].importClause.namedBindings));
const hdAdmissionBinding = hdAdmissionImport[0].importClause.namedBindings.elements.filter(node => node.name.text === 'inspectHdBeforeMaintenance');
assert.equal(hdAdmissionBinding.length, 1); assert.equal(hdAdmissionBinding[0].propertyName, undefined);
function assertHdAdmissionBinding(bindings, expected) {
  assert.equal(typeof expected, 'function'); assert.equal(bindings.inspectHdBeforeMaintenance, expected,
    'The historical VM must explicitly bind the new private-only HD hook');
}
function assertPrivateHdCall(text) {
  const tree = ts.createSourceFile('switch.mjs', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), calls = [];
  assert.equal(tree.parseDiagnostics.length, 0);
  const walk = node => { if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
    && node.expression.text === 'inspectHdBeforeMaintenance') calls.push(node); ts.forEachChild(node, walk); };
  walk(tree); assert.equal(calls.length, 1, 'The private admission helper must really be called once');
  const call = calls[0]; assert.equal(call.arguments.length, 2); assert.equal(call.arguments[0].getText(tree), 'm');
  assert.ok(ts.isObjectLiteralExpression(call.arguments[1]));
  const assignments = call.arguments[1].properties.filter(ts.isPropertyAssignment);
  const spreads = call.arguments[1].properties.filter(ts.isSpreadAssignment);
  assert.equal(assignments.length + spreads.length, call.arguments[1].properties.length);
  assert.equal(spreads.length, 1, 'The shared/non-shared admission bounds must use one exact conditional spread');
  const options = Object.fromEntries(assignments.map(node => {
    assert.ok(ts.isPropertyAssignment(node)); return [node.name.getText(tree), node.initializer.getText(tree)];
  }));
  assert.deepEqual(Object.keys(options).sort(), ['check', 'record', 'sourceRoot']);
  assert.equal(options.sourceRoot, 'm.main.root'); assert.equal(options.check, 'bounds.check');
  assert.ok(ts.isParenthesizedExpression(spreads[0].expression));
  const bounds = spreads[0].expression.expression;
  assert.ok(ts.isConditionalExpression(bounds)); assert.equal(bounds.condition.getText(tree), 'isSharedEngine(m)');
  assert.ok(ts.isObjectLiteralExpression(bounds.whenTrue)); assert.ok(ts.isObjectLiteralExpression(bounds.whenFalse));
  const properties = object => Object.fromEntries(object.properties.map(node => {
    assert.ok(ts.isPropertyAssignment(node)); return [node.name.getText(tree), node.initializer.getText(tree)];
  }));
  assert.deepEqual(properties(bounds.whenTrue), {
    scanDeadline: 'bounds.scanDeadline', waitBudgetMs: 'bounds.waitBudgetMs',
  });
  assert.deepEqual(properties(bounds.whenFalse), { deadline: 'bounds.deadline' });
  let branch = call.parent;
  while (branch && !(ts.isIfStatement(branch) && branch.expression.getText(tree) === 'm.privateMultiviewInstall === true')) branch = branch.parent;
  assert.ok(branch, 'Only the explicit private normal branch may wait');
  const normal = text.slice(text.indexOf('export async function switchPair'));
  assert.ok(normal.indexOf('await inspectHdBeforeMaintenance') < normal.indexOf('hdAdmissionRecord = recordHdAdmission'));
  assert.ok(normal.indexOf('hdAdmissionRecord = recordHdAdmission') < normal.indexOf('await safety.beforeMaintenance'));
}
assertPrivateHdCall(sources['switch.mjs']);
for (const altered of [
  sources['switch.mjs'].replace('await inspectHdBeforeMaintenance(m,', 'await inspectHdReconciliation(m,'),
  sources['switch.mjs'].replace('m.privateMultiviewInstall === true', 'm.privateMultiviewInstall !== true'),
  sources['switch.mjs'].replace('deadline: bounds.deadline', 'deadline: Date.now() + 15000'),
  sources['switch.mjs'].replace('scanDeadline: bounds.scanDeadline', 'scanDeadline: bounds.deadline'),
  sources['switch.mjs'].replace('waitBudgetMs: bounds.waitBudgetMs', 'waitBudgetMs: 15000'),
]) { assert.notEqual(altered, sources['switch.mjs']); assert.throws(() => assertPrivateHdCall(altered)); }
function expression(module, fn, variable) {
  const { parsed, node } = functionNode(module, fn);
  const declarations = node.body.statements.filter(ts.isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations]).filter(item => item.name.getText(parsed) === variable);
  assert.equal(declarations.length, 1, 'Unique direct producer binding required: ' + fn + ':' + variable);
  assert.ok(ts.isObjectLiteralExpression(declarations[0].initializer));
  const value = declarations[0].initializer.getText(parsed);
  producerExpressions[module + ':' + fn + ':' + variable] = sha(value); return value;
}
function returnedExpression(module, fn, called = null, argument = null) {
  const { parsed, node } = functionNode(module, fn);
  const returns = node.body.statements.filter(ts.isReturnStatement);
  assert.equal(returns.length, 1, 'Unique direct producer return required: ' + module + ':' + fn);
  let value = returns[0].expression;
  if (called) {
    assert.ok(ts.isCallExpression(value)); assert.equal(value.expression.getText(parsed), called);
    assert.ok(Number.isSafeInteger(argument) && argument >= 0); value = value.arguments[argument];
  }
  assert.ok(value && ts.isObjectLiteralExpression(value));
  const code = value.getText(parsed); producerExpressions[module + ':' + fn + ':return'] = sha(code); return code;
}
function literalArray(module, name) {
  const parsed = parsedModule(module);
  const declarations = parsed.statements.filter(ts.isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations]).filter(item => item.name.getText(parsed) === name);
  assert.equal(declarations.length, 1); const value = declarations[0].initializer;
  assert.ok(ts.isArrayLiteralExpression(value) && value.elements.every(ts.isStringLiteral));
  return value.elements.map(item => item.text);
}
function literalString(module, name) {
  const parsed = parsedModule(module);
  const declarations = parsed.statements.filter(ts.isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations]).filter(item => item.name.getText(parsed) === name);
  assert.equal(declarations.length, 1); assert.ok(ts.isStringLiteral(declarations[0].initializer));
  return declarations[0].initializer.text;
}
const preparedExpression = expression('candidate.mjs', 'prepareCandidate', 'result');
const buildExpression = expression('candidate.mjs', 'buildCandidate', 'proof');
const pricingPreparedExpression = returnedExpression('candidate-inputs.mjs', 'preparePricingInputs');
const uploadProbeExpression = returnedExpression('candidate.mjs', 'probeUploadHelper', 'verifyUploadHelperProbe', 4);
const hdProbeExpression = returnedExpression('hd-storage-preflight.mjs', 'probeHdCandidateResolver', 'verifyHdCandidateResolver', 3);
const gateLists = Object.fromEntries(['IMAGE_FIXTURES', 'MULTIVIEW_FIXTURE_CHECKS', 'MULTIVIEW_TRANSPORT_SOURCES',
  'MULTIVIEW_FIXTURE_SOURCES', 'UPLOAD_FIXTURE_CHECKS', 'UPLOAD_FIXTURE_SOURCES'].map(name => [name, literalArray('candidate.mjs', name)]));
const sizePolicySources = [
  'src/lib/image-studio/ratios.ts', 'src/lib/image-generation/resolution.ts',
  'src/lib/integrations/image-generation.ts', 'src/lib/image-studio/tasks.ts',
  'src/lib/image-studio/billing-quote-service.ts', 'src/lib/image-studio/billing-quote-store.ts',
  'src/lib/image-studio/batch-billing-quote.ts', 'src/lib/image-studio/batches.ts',
  'src/lib/tools/toolflow-runtime.ts', 'src/app/api/assets/generate/route.ts', 'src/lib/image-studio/worker.ts',
];
const providerErrorSources = [
  'src/lib/image-studio/provider-error-diagnostics.ts',
  'src/lib/image-studio/provider-error-evidence.ts', 'src/lib/image-studio/provider.ts', 'src/lib/image-studio/worker.ts',
];
const adminDiagnosticsSources = [
  'scripts/image-provider-admin-engineering.ts', 'src/app/api/admin/image-studio/tasks/route.ts',
  'src/app/admin/image-studio/AdminImageStudioClient.tsx',
  'src/app/admin/image-studio/ImageStudioDiagnostics.module.css',
  'src/lib/image-studio/provider-error-diagnostics.ts', 'src/lib/image-studio/provider-error-evidence.ts',
];
const sizePolicyChecks = [
  'legacy_119_frozen_specifications_unchanged', 'standard_16_ratios_48_tiers_unchanged',
  'fine_ratio_four_expected_dimensions', 'boundary_2403_same_candidates_area_band',
  'auto_decimal_invalid_four_to_one_half_k_boundaries', 'shared_pixel_and_native_adapters_preserve_capabilities',
  'server_only_preparation_version_no_fingerprint_migration', 'old_parent_partial_prepared_accepted_uncertain_frozen_v1',
  'new_v2_parent_and_original_parent_receipt_before_quote_gate', 'accepted_original_request_receipt_precedes_old_quote_gate',
  'old_quotes_and_stale_continuation_rejected_without_consumption_or_reservation',
  'parent_parser_rejects_unknown_versions_without_read_backfill',
  'explicit_reconfirmation_migrates_only_safe_unaccepted_items_in_cas_transaction',
];
const providerErrorChecks = [
  'post_errors_preserve_transport_and_safe_serialized_metadata', 'summary_failed_uncertain_and_original_identity',
  'result_errors_and_resume_never_fabricate_post', 'bounded_error_body_cancellation_and_native_compatibility',
  'large_success_download_and_callback_failures_preserve_business',
  'positive_allowlist_rejects_private_echo_and_malicious_fields', 'aggregate_preserves_first_latest_counts_and_limits',
  'sqlite_binding_lease_cas_and_read_projection', 'diagnostic_write_failure_isolated_from_original_business',
  'three_worker_generate_paths_and_local_validation_bound',
];
const adminDiagnosticsChecks = [
  'admin_auth_precedes_single_task_local_diagnostics_branch',
  'diagnostics_responses_are_private_fixed_and_do_not_log_raw_errors',
  'api_and_clipboard_use_explicit_browser_safe_dto_allowlists',
  'single_task_detail_loading_account_target_sequence_and_reset_are_isolated',
  'synthetic_late_response_and_local_failure_preserve_current_admin_surface',
];
const hdHelpers = literalArray('hd-storage-preflight.mjs', 'SOURCE_HELPERS');
const pricingRequired = (() => {
  const { node } = functionNode('candidate-inputs.mjs', 'sourceSnapshot');
  const loops = node.body.statements.filter(ts.isForOfStatement).filter(item => ts.isArrayLiteralExpression(item.expression));
  assert.equal(loops.length, 1);
  return loops[0].expression.elements.map(item => {
    if (ts.isStringLiteral(item)) return item.text;
    assert.ok(ts.isIdentifier(item)); return literalString('candidate-inputs.mjs', item.text);
  });
})();

// Explicit filesystem adapter: every absolute path stays under one new private
// temporary tree. Unknown native operations throw; there is no live fallback.
function fixture({ fault = null, previous = null, retainedProof = null } = {}) {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sd2-first-publication-')));
  const project = '/data/video-api-debugger', originalRun = '10000000-0000-4000-8000-000000000001';
  const migrationRun = '10000000-0000-4000-8000-000000000004';
  const runId = previous ? '10000000-0000-4000-8000-000000000003' : '10000000-0000-4000-8000-000000000002';
  const originalStage = project + '/release-staging/' + originalRun;
  const migrationStage = project + '/release-staging/' + migrationRun;
  const stage = project + '/release-staging/' + runId, control = project + '/controls/pricing-writer-v1';
  const opened = new Set();
  const physical = file => {
    if (typeof file === 'number') { assert.ok(opened.has(file), 'Only isolated file descriptors are allowed'); return file; }
    assert.ok(typeof file === 'string' && path.isAbsolute(file) && !file.split('/').includes('..'));
    return temporary + file;
  };
  const virtual = file => { assert.ok(file.startsWith(temporary + '/')); return file.slice(temporary.length); };
  const io = new Proxy({ constants: fs.constants }, { get(target, key) {
    if (Object.hasOwn(target, key)) return target[key];
    throw new Error('Unsupported isolated filesystem operation: ' + String(key));
  } });
  for (const name of ['lstatSync', 'statSync', 'readFileSync', 'writeFileSync', 'readdirSync', 'mkdirSync', 'unlinkSync', 'chmodSync', 'chownSync', 'lchownSync', 'existsSync'])
    io[name] = (file, ...args) => fs[name](physical(file), ...args);
  // The virtual /data is an explicit isolated device observation. Both paths
  // are synthetic temp files; never inspect or mount a live production volume.
  const fixtureStat = io.statSync;
  io.statSync = (file, ...args) => {
    const stat = fixtureStat(file, ...args);
    return file === '/' ? new Proxy(stat, { get: (value, key) => key === 'dev' ? -1
      : typeof value[key] === 'function' ? value[key].bind(value) : value[key] }) : stat;
  };
  io.openSync = (file, ...args) => { const fd = fs.openSync(physical(file), ...args); opened.add(fd); return fd; };
  for (const name of ['fstatSync', 'fsyncSync', 'closeSync', 'fchownSync', 'fchmodSync']) io[name] = (fd, ...args) => {
    assert.ok(Number.isInteger(fd) && opened.has(fd));
    try { return fs[name](fd, ...args); } finally { if (name === 'closeSync') opened.delete(fd); }
  };
  io.realpathSync = file => virtual(fs.realpathSync(physical(file)));
  io.readlinkSync = file => { const value = fs.readlinkSync(physical(file)); return path.isAbsolute(value) ? virtual(value) : value; };
  io.symlinkSync = (target, file) => fs.symlinkSync(path.isAbsolute(target) ? physical(target) : target, physical(file));
  io.renameSync = (a, b) => fs.renameSync(physical(a), physical(b));
  const put = (file, value, mode = 0o644) => {
    fs.mkdirSync(path.dirname(physical(file)), { recursive: true, mode: 0o755 });
    fs.writeFileSync(physical(file), Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value), { mode });
  };
  const bytes = file => io.readFileSync(file), json = file => JSON.parse(bytes(file));
  const importTree = file => {
    const stat = previous.io.lstatSync(file);
    if (stat.isSymbolicLink()) {
      fs.mkdirSync(path.dirname(physical(file)), { recursive: true }); io.symlinkSync(previous.io.readlinkSync(file), file);
    } else if (stat.isDirectory()) {
      fs.mkdirSync(physical(file), { recursive: true, mode: stat.mode & 0o777 });
      for (const name of previous.io.readdirSync(file)) importTree(file + '/' + name);
    } else { put(file, previous.bytes(file), stat.mode & 0o777); io.chownSync(file, stat.uid, stat.gid); }
  };
  if (previous) for (const file of [project + '/release-staging', project + '/managed-releases',
    project + '/controls/usage-role-writer-v1', '/etc/systemd/system/sd2-role-coordinator.service.d/admin-usage-source.conf']) importTree(file);
  const exclusive = (file, value) => {
    const fd = io.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { io.writeFileSync(fd, JSON.stringify(value) + '\n'); io.fsyncSync(fd); } finally { io.closeSync(fd); }
    return file;
  };
  let clock = Date.now() + 12 * 3600000, nextPid = 1000;
  class FixtureDate extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  const processView = { pid: 1, platform: 'linux', execPath: '/usr/bin/node', getuid: () => 0, getgid: () => 0, umask: () => 0o022 };
  const immutable = new Set(), events = [], states = {}, pids = new Map();
  const state = { ingress: 200, fence: null, pairPublished: false, starts: 0,
    attributionRows: previous ? previous.state.attributionRows : 0, recovery: false };
  const note = (name, body = {}) => events.push({ name, ...copy(body) });
  const rootFile = file => {
    assert.equal(io.realpathSync(file), file); const stat = io.lstatSync(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 && stat.nlink === 1 && !(stat.mode & 0o022));
    return bytes(file);
  };
  const unit = name => copy(Object.values(states).find(value => value.Id === name));
  const call = (name, args, options = {}) => {
    if (['findmnt', '/usr/bin/findmnt'].includes(name)) {
      assert.deepEqual(copy(args.slice(0, -1)), ['-n', '-o', 'TARGET', '-T']);
      assert.ok(args.at(-1).startsWith(project + '/')); return '/data';
    }
    if (['lsattr', '/usr/bin/lsattr'].includes(name)) {
      assert.ok(args[0] === '-d' && [2, 3].includes(args.length));
      if (args.length === 3) assert.equal(args[1], '--');
      io.lstatSync(args.at(-1)); return (immutable.has(args.at(-1)) ? '----i----' : '---------') + ' ' + args.at(-1);
    }
    if (name === 'chattr') { assert.equal(args.length, 2); assert.equal(args[0], '+i'); io.lstatSync(args[1]); immutable.add(args[1]); return ''; }
    if (name === 'id') { assert.ok(['-u', '-g'].includes(args[0])); assert.equal(args[1], 'gouki'); return '1004'; }
    if (name === 'df') { assert.deepEqual(copy(args), ['-Pk', stage]); return 'Filesystem 1024-blocks Used Available Capacity Mounted\nsynthetic 9000000 1 8999999 1% /data'; }
    if (name === 'runuser') {
      const index = args.findIndex(value => ['scripts/check-image-recovery.mjs', 'scripts/check-pricing-policy.mjs'].includes(value));
      assert.ok(index > 0, 'Only isolated gate observations are supported');
      assert.deepEqual(copy(args.slice(0, 5)), ['-u', 'gouki', '--', 'env', '-i']);
      const script = args[index], file = args[index + 2], since = Number(args[index + 4]);
      assert.deepEqual(copy(args.slice(index + 1)), ['--verify', file, '--since', String(since)]);
      assert.ok([m.main.root, m.guard.root].includes(options.cwd));
      assert.ok(file.startsWith(options.cwd + '/.role-tests/')); assert.ok(Number.isSafeInteger(since) && since > 0);
      const receipt = json(file); assert.equal(receipt.synthetic, true); assert.equal(receipt.runId, runId);
      assert.equal(receipt.candidateRoot, options.cwd); assert.equal(receipt.completed, true);
      assert.ok(receipt.startedAt >= since && receipt.finishedAt >= receipt.startedAt && receipt.finishedAt <= clock);
      const expected = script === 'scripts/check-image-recovery.mjs' ? 'image-recovery-build-gate.v1' : 'pricing-policy-build-gate.v1';
      assert.equal(receipt.schema, expected);
      const kind = ['main', 'guard'].find(value => m[value].root === options.cwd);
      if (script === 'scripts/check-image-recovery.mjs') {
        assert.equal(args[index - 1], 'node');
        assert.deepEqual(copy(args.slice(5, index - 1)), Object.entries(json(stage + '/' + kind + '-prepared.json').buildEnv)
          .map(([key, value]) => key + '=' + value));
        assert.deepEqual(receipt.fixtures.map(value => value.file), gateLists.IMAGE_FIXTURES);
      } else {
        assert.equal(args[index - 1], '/usr/bin/node');
        assert.deepEqual(copy(args.slice(5, index - 1)), ['PATH=' + literalString('candidate-inputs.mjs', 'SYSTEM_PATH'), 'LANG=C.UTF-8']);
        assert.equal(json(receipt.fixtureReceipt).rootInputManifest.source, m[kind].source);
      }
      note('synthetic-native-gate-observation', { script, file, since, cwd: options.cwd, executed: false });
      return script === 'scripts/check-image-recovery.mjs' ? 'Image recovery build gate verified (synthetic observation)' : 'Pricing policy build gate verified (synthetic observation)';
    }
    if (name === 'python3') {
      assert.ok(args.includes('-I') && args.includes('-c')); const input = JSON.parse(args.at(-1));
      assert.deepEqual(input.identity, ['64784', '171442216']); assert.equal(input.schemaSha256, sha('synthetic schema'));
      assert.deepEqual(input.backupCounts, { ExistingBusiness: 3 });
      note('readonly-schema-observation', { attributionRows: state.attributionRows, databaseWrites: 0 });
      return JSON.stringify({ databaseIdentity: input.identity, newSchemaSha256: input.schemaSha256,
        backupIntegrity: 'ok', originalSchemaPreserved: true, attributionRows: state.attributionRows, databaseWrites: 0, ddlExecuted: false });
    }
    if (['systemctl', '/usr/bin/systemctl'].includes(name) && args[0] === 'show') {
      if (args[1] === 'nginx.service') return '999';
      const observed = unit(args[1]); assert.ok(observed, 'Unknown synthetic service');
      if (args.includes('--value') && args.includes('RefuseManualStart')) return 'yes';
      const selected = args.flatMap((value, index) => value === '-p' ? [args[index + 1]] : []);
      return Object.entries(observed).filter(([key]) => selected.includes(key)).map(([key, value]) => key + '=' + value).join('\n');
    }
    if (name === 'systemctl' && args[0] === 'daemon-reload') return '';
    throw new Error('Unimplemented isolated native operation: ' + name + ' ' + args.join(' '));
  };
  const nativeExec = (name, args, options) => {
    if (name === 'node') { assert.deepEqual(copy(args), ['-p', 'process.execPath']); return '/usr/bin/node'; }
    return call(name, args, options);
  };
  const assertWindow = () => assert.ok(clock < json(stage + '/window.json').expiresAt, 'Synthetic release window expired');
  const common = { assert: sameAssert, fs: io, path, Buffer, JSON, Date: FixtureDate, process: processView, randomUUID, createHash,
    rootFile, sha, writeJsonExclusive: exclusive, call, execFileSync: nativeExec, unit,
    assertReleaseWindow: assertWindow, validateManifest: value => value, parseReleaseTimestamp,
    isSharedEngine, engineDirectory, loadHdCompiledCacheProofs, releaseBoundary,
    candidateEvidenceFile, REUSE_SCHEMA, GUARD_BUILD_TAIL_SCHEMA, candidateCompatibilityDirectory,
    candidateGateObservation: (value, m, kind, now = clock) => candidateGateObservation(value, m, kind, now),
    candidateEvidenceExpiresAt: (value, m, kind, now = clock) => candidateEvidenceExpiresAt(value, m, kind, now),
    assertFreshCandidateEvidence: (value, m, kind, now = clock) => assertFreshCandidateEvidence(value, m, kind, now),
    pathToFileURL, setTimeout, clearTimeout, structuredClone, console,
    CONTINUATION_V2, assertContinuationInput, assertDeployedContinuationSources,
    verifyDeployedContinuationProvenance: () => { throw new Error('V2 requires an explicit isolated provenance fixture; native fallback is forbidden'); } };
  function load(name, imports, names, suffix = '', transform = value => value) {
    if (name === 'switch.mjs') {
      assertPrivateSwitchBindings(imports, historicalPrivateHooks);
      assertHdAdmissionBinding(imports, historicalHdAdmissionHook);
    }
    const context = vm.createContext({ releaseDependencyRoot, fullSchemaBefore, createRequire, ...common, ...imports });
    const code = scriptBody(transform(sources[name]));
    vm.runInContext(code + '\n' + suffix + '\nglobalThis.api={' + names.join(',') + '};', context, { filename: name });
    return context.api;
  }
  function construct(code, bindings, at = clock) {
    class ObservationDate extends FixtureDate { constructor(...args) { super(...(args.length ? args : [at])); } static now() { return at; } }
    return vm.runInNewContext('(' + code + ')', { ...common, Date: ObservationDate, ...bindings });
  }
  const m = { schema: 'rate-impl2-release.v1', project: 'video-api-debugger', projectRoot: project, runId, stage,
    mainSource: 'a'.repeat(40), guardSource: 'b'.repeat(40), appUser: 'gouki', live: {},
    storageRoot: project + '/storage', uploadsRoot: project + '/uploads', videosRoot: project + '/videos', hdRoot: project + '/hd',
    database: project + '/database.sqlite', envFile: '/srv/video-api-debugger/app/.env', windowFile: stage + '/window.json',
    minimumFreeBytes: 1024, expectedProtectedFileSha256: {}, privateSha256: {},
    hdForkRoot: project + '/hd-fork', hdWorkerLockPath: project + '/storage/hd-worker.lock',
    uploadPrivateDirectory: { canonical: project + '/private-uploads', alias: project + '/storage/private-uploads' },
    ...(previous ? {} : { normalContinuation: { schema: 'sd2-normal-continuation-input.v1', chainId: originalRun,
      attempt: 2, sourceRun: originalRun, sourceManifestSha256: '0'.repeat(64), beforeSha256: '1'.repeat(64),
      approvalSha256: '2'.repeat(64), refusalSha256: '3'.repeat(64), lineageSha256: '4'.repeat(64) },
      reuseBuilds: { schema: 'sd2-original-build-reuse-input.v1', sourceRun: originalRun } }) };
  const roleModule = sources['usage-role-start.mjs'];
  function program(letter, candidate) {
    const source = letter.repeat(40), root = project + '/managed-releases/' + source;
    const version = candidate ? (letter === 'a' || letter === 'e' ? '0.101.' + (previous ? '1' : '0')
      : '0.101.' + (previous ? '1' : '0') + '+admin-usage-guard.1') : '0.100.2';
    const files = {};
    for (const file of new Set([...pricingRequired, ...gateLists.IMAGE_FIXTURES, ...gateLists.UPLOAD_FIXTURE_SOURCES,
      ...gateLists.MULTIVIEW_FIXTURE_SOURCES, ...gateLists.MULTIVIEW_TRANSPORT_SOURCES, ...hdHelpers,
      ...sizePolicySources, ...providerErrorSources, ...adminDiagnosticsSources,
      'src/lib/release.ts', 'src/app/api/release/route.ts', 'src/lib/assets/verified-upload.ts'])) files[file] = '// synthetic source: ' + file;
    files['package.json'] = JSON.stringify({ version, scripts: { prebuild: 'node scripts/check-image-recovery.mjs', build: 'next build' } });
    files['package-lock.json'] = JSON.stringify({ name: 'synthetic-lifecycle', version, lockfileVersion: 3, packages: { '': { version } } });
    for (let i = 0; i < 100; i++) files['scripts/pricing-legacy-v0954/' + i + '.source'] = '// synthetic original source ' + i;
    for (let i = 0; i < 101; i++) files['src/file-' + i + '.ts'] = 'export const value=' + i + ';';
    for (const file of ['scripts/canvas-role-coordinator.ts', 'prisma/schema.prisma', 'src/lib/canvas-documents.ts',
      'src/lib/admin/usage-attribution.ts', 'src/lib/admin/usage-types.ts', 'src/lib/prisma.ts', 'src/lib/canvas-roles/execution.ts']) files[file] = '// synthetic source: ' + file;
    files['ops/sd2-usage-role-start.mjs'] = roleModule;
    files['ops/sd2-usage-attribution-migrate.py'] = '# unchanged synthetic migration program';
    files['prisma/migrations/20261021073000_usage_attribution/migration.sql'] = 'unchanged synthetic schema SQL';
    for (const [file, value] of Object.entries(files)) { put(root + '/' + file, value); io.chownSync(root + '/' + file, 1004, 1004); }
    put(root + '/.deployed-commit', source + '\n'); put(root + '/node_modules/synthetic.js', 'unchanged dependency');
    put(root + '/.role-tests/receipt.json', { synthetic: true, completed: true }, 0o600);
    io.chownSync(root + '/.role-tests/receipt.json', 1004, 1004);
    for (const type of ['server', 'static']) for (let i = 0; i < 11; i++) put(root + '/.next-prod-candidate/' + type + '/' + i + '.js', 'module.exports=' + i + ';');
    put(root + '/.next-prod-candidate/BUILD_ID', letter + '-synthetic-build\n');
    if (!candidate) io.symlinkSync('.next-prod-candidate', root + '/.next-prod');
    const sourceFiles = Object.fromEntries(Object.keys(files).map(file => [file, sha(bytes(root + '/' + file))]));
    const buildFiles = { BUILD_ID: sha(bytes(root + '/.next-prod-candidate/BUILD_ID')) };
    for (const type of ['server', 'static']) for (let i = 0; i < 11; i++) buildFiles[type + '/' + i + '.js'] = sha(bytes(root + '/.next-prod-candidate/' + type + '/' + i + '.js'));
    return { source, root, version, build: letter + '-synthetic-build', sourceFiles, buildFiles };
  }
  for (const directory of [stage, originalStage, migrationStage, control, m.storageRoot, m.uploadsRoot, m.videosRoot,
    m.hdRoot, m.hdForkRoot, m.uploadPrivateDirectory.canonical, '/proc', '/usr/bin'])
    fs.mkdirSync(physical(directory), { recursive: true, mode: [stage, originalStage, migrationStage].includes(directory) ? 0o700 : 0o755 });
  put(m.envFile, 'synthetic nonsecret configuration', 0o600); put('/usr/bin/node', 'synthetic node installation');
  put(m.hdWorkerLockPath, 'synthetic persistent HD lock');
  io.symlinkSync(m.uploadPrivateDirectory.canonical, m.uploadPrivateDirectory.alias);
  m.expectedProtectedFileSha256[m.envFile] = sha(bytes(m.envFile));
  const entries = { old: previous ? copy(previous.entries.main) : program('c', false),
    oldGuard: previous ? copy(previous.entries.guard) : program('d', false),
    main: program(previous ? 'e' : 'a', true), guard: program(previous ? 'f' : 'b', true) };
  m.mainSource = entries.main.source; m.guardSource = entries.guard.source;
  for (const kind of ['main', 'guard']) {
    const e = entries[kind]; m[kind] = { source: e.source, root: e.root, version: e.version, buildDist: '.next-prod-candidate', sourceManifest: stage + '/' + kind + '/source-manifest.json' };
    for (const [alias, target] of Object.entries({ storage: m.storageRoot, 'public/uploads': m.uploadsRoot, 'public/videos': m.videosRoot, '.env': m.envFile })) {
      fs.mkdirSync(path.dirname(physical(e.root + '/' + alias)), { recursive: true }); io.symlinkSync(target, e.root + '/' + alias);
    }
    const fileDetails = Object.fromEntries(Object.keys(e.sourceFiles).map(file => [file,
      { bytes: bytes(e.root + '/' + file).length, mode: '100644' }]));
    put(m[kind].sourceManifest, { schema: 'rate-impl2-source-manifest.v1', project: m.project,
      kind, source: e.source, version: e.version, baselineSource: entries.old.source,
      archiveSha256: sha('synthetic unexecuted archive ' + e.source), fileCount: Object.keys(e.sourceFiles).length,
      companionFiles: Object.fromEntries(['package.json', 'package-lock.json', 'src/lib/release.ts', 'src/app/api/release/route.ts']
        .map(file => [file, e.sourceFiles[file]])), files: e.sourceFiles, fileDetails });
  }
  const roleNames = { web: 'sd2-gray.service', image: 'sd2-image-studio.service', hd: 'sd2-hd-derivatives.service', role: 'sd2-role-coordinator.service' };
  const setPid = (role, kind = 'old') => {
    const e = entries[kind], pid = nextPid++, invocation = sha(String(pid)).slice(0, 32), group = '/system.slice/' + roleNames[role];
    m.live[role] ||= { unit: roleNames[role], root: e.root, source: e.source, version: e.version, build: e.build, pid, invocation };
    pids.set(pid, { root: e.root, group });
    put('/proc/' + pid + '/stat', pid + ' (synthetic) S 1'); io.symlinkSync(e.root, '/proc/' + pid + '/cwd');
    states[role] = { Id: roleNames[role], User: 'gouki', MainPID: String(pid), ControlPID: '0', ActiveState: 'active', SubState: 'running', Result: 'success',
      InvocationID: invocation, WorkingDirectory: e.root, ControlGroup: group, ExecMainPID: String(pid), ExecMainStartTimestamp: 'synthetic original start',
      ExecMainStartTimestampMonotonic: String(pid * 10), NRestarts: '0', SendSIGKILL: 'no', KillSignal: '15', TimeoutStopUSec: 'infinity', TasksMax: '128' };
  };
  for (const role of Object.keys(roleNames)) setPid(role);
  const marker = project + '/storage/image-studio-drain';
  put(marker, { schema: 'pricing-writer-isolation.v1', protocol: 'pricing-policy-v1', guard: 'reject-legacy-image-writers', installedAt: new FixtureDate(clock - 7200000).toISOString() }, 0o444);
  immutable.add(marker); put(control + '/writer-start-guard.mjs', 'synthetic fixed installed guard', 0o440);
  put(control + '/allowed.json', { schema: 'pricing-writer-start-allowlist.v1', project: m.project, serviceUid: 1004,
    runId: 'previous-publication', at: new FixtureDate(clock - 7200000).toISOString(), marker, releases: [entries.old, entries.oldGuard] }, 0o440);
  put(stage + '/window.json', { runId, expiresAt: clock + 300000 });
  for (const [name, value] of Object.entries(sources)) {
    if (!previous) put(originalStage + '/fix01-release/' + name, value);
    put(stage + '/fix01-release/' + name, value); m.privateSha256[name] = sha(value);
  }
  const original = previous ? json(originalStage + '/manifest.json')
    : { ...copy(m), runId: originalRun, stage: originalStage, reuseBuilds: undefined, normalContinuation: undefined };
  if (!previous) {
    for (const kind of ['main', 'guard']) { original[kind].sourceManifest = originalStage + '/' + kind + '/source-manifest.json'; put(original[kind].sourceManifest, json(m[kind].sourceManifest)); }
    put(originalStage + '/manifest.json', original);
  }
  // A migration attempt may have switch-before evidence; a never-run build may not.
  const migrationOriginal = previous ? json(migrationStage + '/manifest.json')
    : { ...copy(original), runId: migrationRun, stage: migrationStage };
  if (!previous) {
    for (const kind of ['main', 'guard']) {
      migrationOriginal[kind].sourceManifest = migrationStage + '/' + kind + '/source-manifest.json';
      put(migrationOriginal[kind].sourceManifest, json(original[kind].sourceManifest));
    }
    put(migrationStage + '/manifest.json', migrationOriginal);
  }
  const migrationReceipt = previous ? json(migrationStage + '/usage-attribution-migration/receipt.json')
    : { schema: 'sd2-usage-attribution-migration.v1', runId: migrationRun, source: m.mainSource, guardSource: m.guardSource,
    manifestSha256: sha(bytes(migrationStage + '/manifest.json')), sqlSha256: sha('unchanged synthetic schema SQL'),
    originalSchemaPreserved: true, completed: true, businessRowsWritten: 0, historyBackfilled: false, newSchemaSha256: sha('synthetic schema'),
    at: new FixtureDate(clock - 6800000).toISOString(), backupSha256: sha('synthetic consistent backup') };
  if (!previous) {
    put(migrationStage + '/usage-attribution-migration/receipt.json', migrationReceipt, 0o600);
    put(migrationStage + '/usage-attribution-migration/consistent-backup.sqlite', 'synthetic consistent backup', 0o600);
    put(migrationStage + '/usage-attribution-migration/backup-proof.json', { ...migrationReceipt,
      consistent: true, integrity: 'ok', originalTableCounts: { ExistingBusiness: 3 } }, 0o600);
    put(migrationStage + '/switch-before.json', { runId: migrationRun, manifestSha256: migrationReceipt.manifestSha256,
      protection: { databaseIdentity: ['64784', '171442216'] } }, 0o600);
    Object.assign(m.normalContinuation, { sourceManifestSha256: sha(bytes(originalStage + '/manifest.json')), migrationRun,
      migrationManifestSha256: sha(bytes(migrationStage + '/manifest.json')),
      migrationReceiptSha256: sha(bytes(migrationStage + '/usage-attribution-migration/receipt.json')),
      backupProofSha256: sha(bytes(migrationStage + '/usage-attribution-migration/backup-proof.json')) });
  }
  const reuse = load('candidate-reuse.mjs', { probeHdCandidateResolver: async (_m, c, _p, { phase }) => ({ phase, source: c.source, readOnly: true }) },
    ['capture', 'prepareReusedCandidate', 'verifyReusedCandidate', 'prepareFirstRuntimeAlias', 'assertOriginalSnapshotStable', 'assertRuntimeAliasUnchanged']);
  const originals = {};
  for (const kind of ['main', 'guard']) {
    if (previous) continue;
    const c = original[kind], receipt = { schema: 'rate-impl2-candidate-build.v1', label: kind, runId: originalRun,
      manifestSha256: sha(bytes(originalStage + '/manifest.json')), source: c.source, version: c.version, build: entries[kind].build,
      startedAt: clock - 7200000, finishedAt: clock - 7000000, gateReceipt: c.root + '/.role-tests/receipt.json', exitCode: 0, verifiedSourceAndGates: true };
    const prepared = { source: c.source, candidateRoot: c.root, runId: originalRun, buildEnv: { PATH: '/usr/bin:/bin' } };
    put(originalStage + '/' + kind + '-prepared.json', prepared); put(originalStage + '/' + kind + '-build.json', receipt);
    const capsule = { schema: 'sd2-immutable-successful-build.v1', kind, sourceRun: originalRun,
      originallyVerifiedWithinThirtyMinuteGate: true, originalTimesChanged: false, newCompilationClaimed: false,
      originalReceiptFile: originalStage + '/' + kind + '-build.json', originalReceiptSha256: sha(bytes(originalStage + '/' + kind + '-build.json')),
      originalReceipt: receipt, originalManifestSha256: sha(bytes(originalStage + '/manifest.json')),
      originalSourceManifestSha256: sha(bytes(c.sourceManifest)), originalPreparedSha256: sha(bytes(originalStage + '/' + kind + '-prepared.json')),
      originalPrivateSha256: copy(m.privateSha256), snapshot: reuse.capture(original, kind, receipt, prepared) };
    const file = originalStage + '/' + kind + '-immutable-success.json'; put(file, capsule, 0o600); immutable.add(file);
    m.reuseBuilds[kind] = { file, sha256: sha(bytes(file)) }; originals[kind] = copy(receipt);
  }
  if (previous) {
    assert.ok(retainedProof);
    put(stage + '/deployed-usage-prior-proof.stdout', retainedProof.stdout, 0o600);
    put(stage + '/deployed-usage-prior-proof-command.json', retainedProof.command, 0o600);
    const input = { schema: 'sd2-deployed-usage-schema-input.v1', publicationRun: previous.m.runId, migrationRun };
    for (const [key, file] of Object.entries({ publicationManifestSha256: previous.stage + '/manifest.json',
      switchCompleteSha256: previous.stage + '/switch-complete.json', finalProofSha256: stage + '/deployed-usage-prior-proof.stdout',
      finalProofCommandSha256: stage + '/deployed-usage-prior-proof-command.json',
      migrationManifestSha256: migrationStage + '/manifest.json', migrationBeforeSha256: migrationStage + '/switch-before.json',
      migrationReceiptSha256: migrationStage + '/usage-attribution-migration/receipt.json',
      backupProofSha256: migrationStage + '/usage-attribution-migration/backup-proof.json',
      backupSha256: migrationStage + '/usage-attribution-migration/consistent-backup.sqlite' })) input[key] = sha(bytes(file));
    m.deployedUsageSchema = input;
  }
  put(stage + '/manifest.json', m);
  put(stage + '/native-control-preflight/receipt.json', { runId, completed: true, privateSha256: m.privateSha256,
    activeOriginalHdRefusedAsDrained: true, nativeBeforeMaintenance: { completed: true } }, 0o600);
  const manifestSha256 = sha(bytes(stage + '/manifest.json'));
  const pairModule = load('pricing-start-pair.mjs', {}, ['createPricingStartPairHelper'], '',
    text => text.replace('81a92dfae4600f81f6fd043a87d440d2e9c46056aad95dd66dfbdb5836830fe0', sha(bytes(control + '/writer-start-guard.mjs'))));
  const pair = pairModule.createPricingStartPairHelper({ filesystem: io, call, now: () => clock, getuid: () => 0, platform: 'linux' });
  const baselineControl = pair.capturePricingStartControl();
  const guard = load('guard-recovery.mjs', { ...pair, PRICING_START_CONTROL: control,
    MV_DIRECT: { recoveryRunId: runId, mainSource: m.mainSource, recoveryGuardSource: m.guardSource },
    assertOriginalSnapshotStable: reuse.assertOriginalSnapshotStable, assertRuntimeAliasUnchanged: reuse.assertRuntimeAliasUnchanged },
  ['armGuardRecovery', 'readGuardRecovery', 'verifyGuardRecovery', 'inspectGuardRecoveryControl', 'runGuardRecovery', 'markFixedGuardStart']);
  // Values enter the VM explicitly, never through process environment or a live DB.
  // A second small context exposes the same actual migration producer/consumer.
  const migrationContext = vm.createContext({ ...common, fixtureState: state,
    fixtureMigration: { original: migrationOriginal, receipt: migrationReceipt,
      proof: json(migrationStage + '/usage-attribution-migration/backup-proof.json'),
      backup: migrationStage + '/usage-attribution-migration/consistent-backup.sqlite', observed: { databaseWrites: 0 } } });
  vm.runInContext(scriptBody(sources['normal-continuation.mjs'])
    + '\noriginalMigration=(_m,{requireEmpty=true}={})=>{'
    + 'assertOriginalMigration(_m,fixtureMigration.original,fixtureMigration.receipt,fixtureMigration.proof);'
    + 'assert.equal(_m.normalContinuation.migrationRun,fixtureMigration.original.runId);'
    + 'assert.equal(_m.normalContinuation.migrationManifestSha256,fixtureMigration.receipt.manifestSha256);'
    + 'assert.equal(sha(rootFile(fixtureMigration.backup)),fixtureMigration.receipt.backupSha256);'
    + 'if(requireEmpty)assert.equal(fixtureState.attributionRows,0);return fixtureMigration;};'
    + 'globalThis.api={adoptOriginalMigration,readMigrationEvidence};', migrationContext);
  const canvasContract = load('canvas-batch-schema-contract.mjs', {}, ['assertCanvasBatchSchemaInput',
    'assertCanvasBatchPrismaExtension', 'CANVAS_BATCH_SQL', 'CANVAS_BATCH_MIGRATOR', 'CANVAS_BATCH_MODE']);
  const canvasSchema = load('canvas-batch-schema.mjs', { ...canvasContract, assertProtectedIncrementCandidate }, ['verifyCanvasBatchCandidates',
    'readCanvasBatchMigration', 'applyCanvasBatchMigration']);
  const deployed = load('deployed-usage-schema.mjs', canvasSchema, ['verifyDeployedUsageSchema', 'adoptDeployedUsageSchema',
    'readDeployedUsageEvidence', 'assertPriorUsageRoleControl', 'priorUsageRoleControl', 'assertPriorPublication']);
  const migrationApi = previous ? { adoptOriginalMigration: deployed.adoptDeployedUsageSchema, readMigrationEvidence: deployed.readDeployedUsageEvidence }
    : migrationContext.api;
  const denied = name => () => { throw new Error('Unimplemented isolated native operation: ' + name); };
  const pricingInputs = load('candidate-inputs.mjs', {},
    ['cleanBuildEnv', 'sourceSnapshot', 'markerSnapshot', 'inspectMultiviewFixtureRoot', 'verifyPricingInputs', 'verifyPricingGateReceipt', 'verifyNativeGateReceipt']);
  const hdCandidate = load('hd-storage-preflight.mjs', {
    os, APPROVED_HD_LEGACY_READY: null, APPROVED_HD_HISTORICAL_VERSIONS: null,
    inspectRetiredHdCaches: denied('retired HD inventory'),
    fixtureHdLayout: value => {
      assert.equal(value.projectRoot, project); assert.equal(value.hdRoot, project + '/hd');
      assert.equal(value.hdForkRoot, project + '/hd-fork'); assert.equal(value.storageRoot, project + '/storage');
      assert.equal(value.uploadsRoot, project + '/uploads'); assert.equal(value.hdWorkerLockPath, project + '/storage/hd-worker.lock');
      assert.equal(value.appUser, 'gouki');
      return { isolated: false, project, uid: 1004, gid: 1004, legacyApproval: null, historicalApproval: null,
        dataDevice: io.statSync('/data').dev };
    },
  }, ['candidateInputs', 'bindings', 'verifyHdCandidateResolver'], 'layout=fixtureHdLayout;');
  const verifyUploadDirectory = value => {
    assert.equal(value.projectRoot, project);
    assert.deepEqual(copy(value.uploadPrivateDirectory), { canonical: project + '/private-uploads', alias: project + '/storage/private-uploads' });
    const { canonical, alias } = value.uploadPrivateDirectory;
    assert.equal(io.realpathSync(canonical), canonical); const stat = io.lstatSync(canonical);
    assert.ok(stat.isDirectory() && stat.uid === 0 && !(stat.mode & 0o022));
    assert.ok(io.lstatSync(alias).isSymbolicLink()); assert.equal(io.readlinkSync(alias), canonical);
    assert.equal(io.realpathSync(alias), canonical);
  };
  const candidate = load('candidate.mjs', {
    assertProtectedIncrementCandidate,
    validateManifest: value => { assert.deepEqual(copy(value), json(stage + '/manifest.json')); return value; },
    verifyUploadPrivateDirectory: verifyUploadDirectory,
    verifyPricingInputs: pricingInputs.verifyPricingInputs, verifyPricingGateReceipt: pricingInputs.verifyPricingGateReceipt,
    verifyNativeGateReceipt: pricingInputs.verifyNativeGateReceipt,
    verifyHdCandidateResolver: hdCandidate.verifyHdCandidateResolver,
    preparePricingInputs: denied('native pricing preparation'), verifyRateSourceArchive: denied('native archive extraction'),
    spawnSync: denied('npm build'), probeHdCandidateResolver: denied('native HD subprocess'),
    inspectHdReconciliation: denied('native HD reconciliation'), sealOriginalSuccess: denied('native build sealing'),
    assertControlPreflight: denied('publishing preflight'), prepareReusedCandidate: reuse.prepareReusedCandidate,
    verifyReusedCandidate: reuse.verifyReusedCandidate, liveArtifactSource: root => bytes(root + '/.deployed-commit').toString().trim(),
    readProtection: denied('native protection capture'), assertProtection: denied('native protection comparison'),
  }, ['context', 'sourceCheck', 'lockView', 'runtimeBindings', 'inputs', 'compiledTree', 'verifyUploadHelperProbe',
    'uploadDirectoryIdentity', 'verifyGates', 'verifyCandidate']);
  const appFile = (file, value, mode = 0o600) => {
    put(file, value, mode); io.chmodSync(file, mode); io.chownSync(file, 1004, 1004); return file;
  };
  const appDirectory = file => {
    io.mkdirSync(file, { recursive: true, mode: 0o700 }); io.chmodSync(file, 0o700); io.chownSync(file, 1004, 1004);
  };
  function syntheticPricingPreparation(c, source) {
    const root = c.root, preparedRoot = root + '/.role-tests/pricing-prepared-' + runId;
    const runtimeRoot = preparedRoot + '/pricing-legacy-fixture-runtime';
    for (const file of [root + '/.role-tests', preparedRoot, runtimeRoot]) appDirectory(file);
    const buildEnv = pricingInputs.cleanBuildEnv({ preparedRoot, source: c.source, runId });
    const privateFixtureRoot = buildEnv.MULTIVIEW_PRIVATE_FIXTURE_ROOT;
    const engineering = '/data/video-api-debugger-engineering', runRoot = engineering + '/' + runId;
    for (const directory of ['/data', engineering]) {
      io.mkdirSync(directory, { recursive: true, mode: 0o755 }); io.chmodSync(directory, 0o755); io.chownSync(directory, 0, 0);
    }
    io.mkdirSync(runRoot, { recursive: true, mode: 0o700 }); io.chmodSync(runRoot, 0o700); io.chownSync(runRoot, 0, 0);
    const protectedRun = io.lstatSync(runRoot);
    assert.equal(privateFixtureRoot, engineering + '/private-' + runId + '-' + c.source);
    assert.equal(path.dirname(privateFixtureRoot), engineering);
    appDirectory(privateFixtureRoot);
    const privateFixtureIdentity = pricingInputs.inspectMultiviewFixtureRoot(c.source, runId, 1004, 1004);
    const legacy = runRoot + '/' + c.source; appDirectory(legacy);
    assert.throws(() => pricingInputs.inspectMultiviewFixtureRoot(c.source, runId, 1004, 1004, legacy), /ancestor is inaccessible/);
    io.chmodSync(runRoot, 0o755);
    assert.equal(pricingInputs.inspectMultiviewFixtureRoot(c.source, runId, 1004, 1004, legacy).path, legacy);
    const legacyEnv = pricingInputs.cleanBuildEnv({ preparedRoot, source: c.source, runId, multiviewFixtureRoot: legacy });
    assert.equal(legacyEnv.MULTIVIEW_PRIVATE_FIXTURE_ROOT, legacy);
    io.chmodSync(runRoot, 0o700);
    io.chmodSync(privateFixtureRoot, 0o750);
    assert.throws(() => pricingInputs.inspectMultiviewFixtureRoot(c.source, runId, 1004, 1004));
    io.chmodSync(privateFixtureRoot, 0o700);
    assert.throws(() => pricingInputs.inspectMultiviewFixtureRoot(c.source, runId, 1004, 1004, engineering + '/private-' + runId + '-' + '0'.repeat(40)));
    const afterRun = io.lstatSync(runRoot);
    for (const key of ['dev', 'ino', 'uid', 'gid', 'mode']) assert.equal(afterRun[key], protectedRun[key]);
    for (const file of [buildEnv.TMPDIR, buildEnv.HOME, buildEnv.XDG_CACHE_HOME, buildEnv.NPM_CONFIG_CACHE]) appDirectory(file);
    const markers = {};
    for (const kind of ['strict', 'ordinary', 'unprotected', 'wrong-schema', 'extra-field']) {
      const file = (kind === 'strict' ? runtimeRoot : runtimeRoot + '/g19-marker-cases/' + kind) + '/storage/image-studio-drain';
      put(file, { synthetic: true, kind }, 0o444); markers[kind] = file;
      if (!['ordinary', 'unprotected'].includes(kind)) immutable.add(file);
    }
    const manifest = runtimeRoot + '/g19-bootstrap.json';
    put(manifest, { schema: 'pricing-legacy-bootstrap.v1', synthetic: true, candidateRoot: root,
      fixtureRoot: runtimeRoot, source: c.source, uid: 1004, gid: 1004, markers,
      installedAt: new FixtureDate(clock - 280000).toISOString() }, 0o444);
    const sourceSha256 = pricingInputs.sourceSnapshot(root, source.files), receipt = preparedRoot + '/candidate-inputs.json';
    put(receipt, { schema: 'rate-impl2-candidate-inputs.v1', synthetic: true, candidateRoot: root, source: c.source,
      runId, uid: 1004, gid: 1004, preparedRoot, runtimeRoot, sourceSha256,
      privateFixtureRoot: privateFixtureIdentity,
      bootstrapSha256: source.files[literalString('candidate-inputs.mjs', 'BOOTSTRAP')],
      bootstrapReceiptSha256: sha(bytes(manifest)), markers: pricingInputs.markerSnapshot(runtimeRoot, json(manifest)),
      startedAt: clock - 290000, finishedAt: clock - 270000,
      productionDatabaseCopied: false, servicesChanged: false, buildsRun: false }, 0o444);
    // Header-only observation for the production input reader, never a real DB or DDL.
    appFile(buildEnv.DATABASE_URL.slice(5), 'SQLite format 3\0SYNTHETIC EMPTY DATABASE OBSERVATION');
    const prepared = construct(pricingPreparedExpression, { root, source: c.source, runId, appUser: m.appUser,
      preparedRoot, runtimeRoot, buildEnv, receipt, sourceSha256, manifest });
    pricingInputs.verifyPricingInputs({ candidateRoot: root, source: c.source, runId, appUser: m.appUser,
      sourceFiles: source.files, prepared });
    note('synthetic-pricing-inputs-produced', { kind: source.kind, receipt, nativeBootstrapRun: false, ddlExecuted: false });
    return prepared;
  }
  function syntheticUploadProbe(c, source, prepared, phase) {
    verifyUploadDirectory(m);
    const startedAt = clock - (phase === 'prepare' ? 260000 : 220000), finishedAt = startedAt + 1;
    const observed = { cwd: c.root, runtimeUid: 1004, runtimeGid: 1004,
      returnedCanonical: m.uploadPrivateDirectory.canonical,
      canonicalIdentity: candidate.uploadDirectoryIdentity(m.uploadPrivateDirectory.canonical) };
    const output = 'SYNTHETIC UPLOAD OBSERVATION ' + JSON.stringify(observed);
    const probe = construct(uploadProbeExpression, { m, c, source, prepared, phase, observed, output,
      helperSourceSha256: source.files['src/lib/assets/verified-upload.ts'],
      UPLOAD_HELPER: literalString('candidate.mjs', 'UPLOAD_HELPER'),
      beforeAlias: candidate.uploadDirectoryIdentity(m.uploadPrivateDirectory.alias),
      isolatedDatabase: prepared.buildEnv.DATABASE_URL.slice(5), startedAt, finishedAt });
    return candidate.verifyUploadHelperProbe(m, c, source, prepared, probe, phase);
  }
  function syntheticHdProbe(c, prepared, phase) {
    const input = hdCandidate.candidateInputs(m, c, prepared), before = {
      bindings: hdCandidate.bindings(m, input.l), readyByKey: {}, historicalByKey: {} };
    const startedAt = clock - (phase === 'prepare' ? 250000 : phase === 'prebuild' ? 210000 : 1000);
    const observed = { ready: null, runtimeUid: 1004, runtimeGid: 1004, sqlAttempts: 0, networkAttempts: 0, writeAttempts: 0 };
    const probe = construct(hdProbeExpression, { m, c, prepared, phase, input, before, observed, key: null,
      excludedHistoricalReadyCount: 0, originalBefore: null, startedAt,
      output: 'SYNTHETIC HD OBSERVATION ' + JSON.stringify(observed) }, startedAt + 1);
    return hdCandidate.verifyHdCandidateResolver(m, c, prepared, probe, { phase });
  }
  function prepareFreshInputs(kind) {
    assert.ok(previous); const info = candidate.context(m, kind), { c, source } = info;
    candidate.sourceCheck(c, source); candidate.runtimeBindings(m, c);
    assert.deepEqual(copy(candidate.lockView(c.root + '/package-lock.json')), copy(candidate.lockView(m.live.web.root + '/package-lock.json')));
    const prepared = syntheticPricingPreparation(c, source), uploadHelperProbe = syntheticUploadProbe(c, source, prepared, 'prepare');
    const hdHelperProbe = syntheticHdProbe(c, prepared, 'prepare');
    const hdReconciliation = { schema: 'hd-storage-reconciliation-v1', synthetic: true, issues: [], readOnly: true,
      bindings: hdCandidate.bindings(m, hdCandidate.candidateInputs(m, c, prepared).l) };
    const result = construct(preparedExpression, { kind, c, prepared, uploadHelperProbe, hdHelperProbe, hdReconciliation, info }, clock - 240000);
    exclusive(stage + '/' + kind + '-prepared.json', result);
    const checked = candidate.inputs(m, kind, source);
    assert.deepEqual(copy(checked.prepared), copy(result));
    note('actual-prepared-output-expression', { kind, fields: Object.keys(result).sort(), nativePreparationExecuted: false });
  }
  function syntheticGateFiles(c, source, startedAt, finishedAt) {
    const root = c.root, prefix = root + '/.role-tests/fresh-' + runId;
    const times = { startedAt: startedAt + 1000, finishedAt: finishedAt - 1000 };
    const safety = { forbiddenCalls: 0, refusedWrites: 0, productionWrites: 0, paidRequests: 0, browserRuns: 0, hdRootAtImport: null };
    const outcome = (name, index) => {
      const log = appFile(prefix + '-outcome-' + index + '.log', 'SYNTHETIC: ' + name + '; native fixture not executed\n');
      const safetyReceipt = appFile(prefix + '-outcome-' + index + '-safety.json', { synthetic: true, ...safety });
      return { file: name, name, completed: true, exitCode: 0, signal: null, failure: null,
        log, logSha256: sha(bytes(log)), safetyReceipt, safetySha256: sha(bytes(safetyReceipt)) };
    };
    const pricingFixture = appFile(prefix + '-pricing-fixture.json', { synthetic: true, rootInputManifest: { source: c.source } });
    const pricingReceipt = appFile(prefix + '-pricing.json', { schema: 'pricing-policy-build-gate.v1', synthetic: true,
      completed: true, candidateRoot: root, runId, fixtureReceipt: pricingFixture, ...times });
    const fixtures = gateLists.IMAGE_FIXTURES.map((file, index) => ({ file, synthetic: true, ...outcome(file, 'image-' + index) }));
    const engineeringReceipt = (file, schema, sources, checks, label) => {
      const item = fixtures.find(value => value.file === file); assert.ok(item);
      item.receipt = appFile(prefix + '-' + label + '.json', { schema, synthetic: true, completed: true,
        runId, candidateRoot: root, fixtureSha256: source.files[file],
        sourceSha256: Object.fromEntries(sources.map(name => [name, source.files[name]])), checks, ...safety, ...times });
      item.sha256 = sha(bytes(item.receipt));
    };
    engineeringReceipt('scripts/image-size-policy-engineering.ts', 'image-size-policy-engineering.v1',
      sizePolicySources, sizePolicyChecks, 'size-policy');
    engineeringReceipt('scripts/image-provider-error-engineering.ts', 'image-provider-error-engineering.v1',
      providerErrorSources, providerErrorChecks, 'provider-error');
    const hd = fixtures.find(value => value.file === 'scripts/hd-chain-engineering.mjs');
    hd.receipt = appFile(prefix + '-hd.json', { schema: 'hd-chain-engineering.v1', synthetic: true, completed: true,
      runId, candidateRoot: root, productionHdRootPassedToFixtures: false, fixtureSha256: source.files[hd.file],
      sourceSha256: Object.fromEntries(Object.keys(source.files).sort().slice(0, 30).map(file => [file, source.files[file]])),
      outcomes: ['scripts/test-hd-stability.ts', 'scripts/hd-backend-engineering.ts', 'scripts/test-hd-display.ts',
        'scripts/hd-registration-engineering.ts', 'scripts/hd-admin-engineering.ts'].map((file, i) => outcome(file, 'hd-' + i)),
      ...safety, ...times }); hd.sha256 = sha(bytes(hd.receipt));
    const upload = fixtures.find(value => value.file === 'scripts/upload-recovery-engineering.mjs');
    upload.receipt = appFile(prefix + '-upload.json', { schema: 'upload-recovery-engineering.v1', synthetic: true, completed: true,
      runId, candidateRoot: root, checks: gateLists.UPLOAD_FIXTURE_CHECKS, fixtureSha256: source.files[upload.file],
      sourceSha256: Object.fromEntries(gateLists.UPLOAD_FIXTURE_SOURCES.map(file => [file, source.files[file]])), ...safety, ...times });
    upload.sha256 = sha(bytes(upload.receipt));
    const multiview = fixtures.find(value => value.file === 'scripts/multiview-settings-batch-engineering.mjs');
    const checks = [...gateLists.MULTIVIEW_FIXTURE_CHECKS, 'authorized_multiview_original_transport'];
    multiview.receipt = appFile(prefix + '-multiview.json', { schema: 'multiview-settings-batch-engineering.v1', synthetic: true,
      completed: true, runId, candidateRoot: root, checks, fixtureSha256: source.files[multiview.file],
      sourceSha256: Object.fromEntries([...gateLists.MULTIVIEW_FIXTURE_SOURCES, ...gateLists.MULTIVIEW_TRANSPORT_SOURCES]
        .map(file => [file, source.files[file]])), outcomes: checks.map((name, i) => outcome(name, 'multiview-' + i)), ...safety, ...times });
    multiview.sha256 = sha(bytes(multiview.receipt));
    const adminReceipt = appFile(prefix + '-provider-admin.json', { schema: 'image-provider-admin-engineering.v1',
      synthetic: true, completed: true, runId, candidateRoot: root, applicationDatabaseOpened: false,
      sourceSha256: Object.fromEntries(adminDiagnosticsSources.map(file => [file, source.files[file]])),
      checks: adminDiagnosticsChecks, ...safety, ...times });
    const publicUsageFixtures = [{ file: 'scripts/image-provider-admin-engineering.ts', startedAt: times.startedAt,
      finishedAt: times.finishedAt, receipt: adminReceipt, sha256: sha(bytes(adminReceipt)) }];
    const gateReceipt = appFile(prefix + '-image.json', { schema: 'image-recovery-build-gate.v1', synthetic: true,
      completed: true, candidateRoot: root, runId, fixtures, publicUsageFixtures, pricingReceipt, ...times });
    return { gateReceipt, pricingReceipt };
  }
  async function buildFreshReceipt(kind) {
    assert.ok(previous); const info = candidate.context(m, kind), { c, source } = info;
    const { prepared, preparedSha256 } = candidate.inputs(m, kind, source);
    const uploadHelperProbe = syntheticUploadProbe(c, source, prepared, 'prebuild');
    const hdHelperProbe = syntheticHdProbe(c, prepared, 'prebuild');
    const startedAt = clock - 200000, finishedAt = clock - 100000;
    const gates = syntheticGateFiles(c, source, startedAt, finishedAt), logFile = stage + '/' + kind + '-build.log';
    put(logFile, 'SYNTHETIC COMPILER OBSERVATION; npm build was not executed\n'
      + 'IMAGE_RECOVERY_GATE_RECEIPT=' + gates.gateReceipt + '\nPRICING_POLICY_GATE_RECEIPT=' + gates.pricingReceipt + '\n', 0o600);
    const logBytes = rootFile(logFile), lines = logBytes.toString().split(/\r?\n/);
    const image = lines.filter(line => line.startsWith('IMAGE_RECOVERY_GATE_RECEIPT='));
    const pricing = lines.filter(line => line.startsWith('PRICING_POLICY_GATE_RECEIPT='));
    assert.equal(image.length, 1); assert.equal(pricing.length, 1);
    const built = candidate.compiledTree(c);
    const proof = construct(buildExpression, { BUILD_SCHEMA: literalString('candidate.mjs', 'BUILD_SCHEMA'),
      kind, c, m, built, info, startedAt, finishedAt, image, preparedSha256, uploadHelperProbe, hdHelperProbe,
      hdCompiledCache: undefined, logFile, logBytes });
    const verified = candidate.verifyGates(m, kind, source, prepared, proof);
    assert.equal(verified.pricing.receipt, pricing[0].slice('PRICING_POLICY_GATE_RECEIPT='.length));
    exclusive(stage + '/' + kind + '-build.json', proof);
    assert.deepEqual(copy(await candidate.verifyCandidate(m, kind)), copy(proof));
    note('actual-build-output-expression-and-consumer', { kind, fields: Object.keys(proof).sort(), nativeBuildExecuted: false });
    return proof;
  }
  const roleJournal = [];
  const role = load('usage-role-control.mjs', { readMigrationEvidence: migrationApi.readMigrationEvidence,
    priorUsageRoleControl: deployed.priorUsageRoleControl, assertPriorUsageRoleControl: deployed.assertPriorUsageRoleControl,
    fixtureRoleStopped: () => assert.equal(states.role.MainPID, '0'), fixtureRoleJournals: () => roleJournal,
    fixtureRoleRecord: (_m, phase, detail) => { roleJournal.push({ phase, ...copy(detail) }); note('actual-role-control-' + phase); },
    fileURLToPath: () => stage + '/fix01-release/usage-role-control.mjs' }, ['roleStartContract', 'publishRoleStart'],
    'assertUsageRoleStopped=fixtureRoleStopped;journals=fixtureRoleJournals;record=fixtureRoleRecord;',
    value => value.replaceAll('import.meta.url', '"synthetic-module-url"'));
  const stopRole = roleName => {
    const previous = copy(states[roleName]), pid = Number(previous.MainPID);
    pids.delete(pid); if (io.existsSync('/proc/' + pid)) fs.rmSync(physical('/proc/' + pid), { recursive: true });
    Object.assign(states[roleName], { MainPID: '0', ControlPID: '0', ActiveState: 'inactive', SubState: 'dead', Result: 'success' });
    assertNaturalExitEvidence(states[roleName], previous, { originalPidPresent: pids.has(pid), originalGroupPids: [], unitGroupPids: [] });
    note('natural-exit-' + roleName, { pid, forcedKill: false }); return previous;
  };
  let before, installed, mainStarted = false, forcedFault = fault;
  const protectedValue = { databaseIdentity: ['64784', '171442216'], settingsSha256: sha('frozen price fields'), data: 'unchanged original business rows' };
  const captureBefore = () => ({ schema: 'rate-impl2-switch-before.v1', manifestSha256,
    writers: Object.fromEntries(['web', 'image', 'hd'].map(name => [name, copy(states[name])])), protection: copy(protectedValue),
    captured: pair.capturePricingStartControl(), policies: {}, roleControl: { state: copy(states.role) } });
  const stopped = (_m, name) => { assert.equal(states[name].MainPID, '0'); return copy(states[name]); };
  const allGone = () => { for (const name of Object.keys(roleNames)) stopped(m, name); assert.equal(pids.size, 0); };
  const save = (name, value) => exclusive(stage + '/' + name + '.json', { runId, manifestSha256, ...value });
  const assertApproval = () => assertHdMaintenanceApproval(m, json(stage + '/hd-release-safety-approval.json'), { now: clock,
    manifestSha256, windowSha256: sha(bytes(m.windowFile)), mainBuildReceiptSha256: sha(bytes(candidateEvidenceFile(m, 'main'))),
    guardBuildReceiptSha256: sha(bytes(candidateEvidenceFile(m, 'guard'))) });
  let publishedRole;
  const startRole = async (_m, kind) => {
    stopped(m, 'role');
    const result = previous ? role.publishRoleStart(m) : role.roleStartContract(m);
    const contract = result.contract, moduleBytes = bytes(m[kind].root + '/ops/sd2-usage-role-start.mjs');
    publishedRole = { contract: copy(contract), sha256: sha(Buffer.from(JSON.stringify(contract, null, 2) + '\n')), moduleSha256: sha(moduleBytes) };
    put(project + '/controls/usage-role-writer-v1/allowed.json', JSON.stringify(contract, null, 2) + '\n');
    put(project + '/controls/usage-role-writer-v1/start.mjs', moduleBytes);
    put('/etc/systemd/system/sd2-role-coordinator.service.d/admin-usage-source.conf',
      '# Usage origin writer ' + runId + '\n[Service]\nWorkingDirectory=' + m[kind].root
      + '\nExecStartPre=/usr/bin/node ' + project + '/controls/usage-role-writer-v1/start.mjs\n');
    const candidate = contract.releases.find(value => value.source === m[kind].source);
    assert.equal(assertUsageRoleStart(copy(contract), { ...copy(candidate), schemaSha256: contract.schemaSha256 }).sourceAndSchemaVerified, true);
    setPid('role', kind); note('start-role-' + kind); return { kind, current: copy(states.role), source: candidate.source };
  };
  const native = {
    context: () => ({ manifestSha256 }), captureSwitchBefore: () => { before = captureBefore(); return before; },
    processState: pid => ({ pid, start: 'synthetic-start', parentPid: 0 }), service: (_m, name) => copy(states[name]),
    asApp: (_m, args, cwd) => { const kind = ['main', 'guard'].find(name => m[name].root === cwd); assert.ok(kind);
      return JSON.stringify({ service: args.at(-1), source: m[kind].source, version: m[kind].version, build: entries[kind].build,
        sourceAndBuildVerified: true, barrierVerified: true }); },
    running: (_m, name, kind) => { const e = entries[kind || 'old']; assert.equal(states[name].ActiveState, 'active');
      assert.equal(states[name].WorkingDirectory, e.root); return { ...copy(e), pid: Number(states[name].MainPID), invocation: states[name].InvocationID, state: copy(states[name]) }; },
    captureHdMetadata: () => ({ canonical: {}, fork: {} }), assertProtected: () => copy(protectedValue), assertPolicy: () => {},
    assertOriginalStopped: allGone, stopped, groupPids: group => [...pids].filter(([, value]) => value.group === group).map(([pid]) => String(pid)),
    assertNoEscapedRecoveryWriter: () => assert.equal(pids.size, 0),
    installNoForce: (_m, _before, _digest, mode) => {
      const files = {};
      for (const name of ['web', 'image', 'hd']) {
        const file = '/run/systemd/system/' + roleNames[name] + '.d/rate-impl2-' + runId + '.conf';
        put(file, noForceBytes(name)); files[name] = switchApi.rootSnapshot(file);
      }
      const value = { manifestSha256, files }; save('writer-no-force-' + mode, value); note('install-no-force'); return value;
    },
    stopNaturally: async (_m, _before, _temporary, name, mode, capturedOriginal) => {
      const previous = copy(states[name]); save('natural-stop-intent-' + mode + '-' + name, { before: previous, capturedOriginal, signal: 'SIGTERM', forcedKill: false });
      stopRole(name); save('natural-stop-' + mode + '-' + name, { before: previous, after: copy(states[name]), forcedKill: false });
    },
    actualPrestart: (_m, _before, _temporary, builds) => {
      allGone(); const accepted = [];
      for (const kind of ['main', 'guard']) {
        pair.verifyFixedProgramEntry(entries[kind]);
        for (const name of ['web', 'image']) accepted.push({ service: roleNames[name], source: m[kind].source, build: builds[kind].build,
          sourceAndBuildVerified: true, barrierVerified: true });
      }
      for (const name of ['web', 'image', 'hd']) states[name].WorkingDirectory = m.main.root;
      note('four-prestarts'); return { accepted, actualExecStartPreVerified: true };
    },
    configure: (_m, _before, _temporary, kind) => { allGone(); for (const name of ['web', 'image', 'hd']) states[name].WorkingDirectory = m[kind].root; note('configure-' + kind); },
    start: async (_m, _before, _temporary, kind) => {
      allGone(); const latch = json(control + '/start-' + runId + '.json'); assert.equal(latch.runId, runId);
      assert.equal(latch.allowedSha256, pair.capturePricingStartControl().allowed.sha256);
      if (kind === 'main') mainStarted = true;
      for (const name of ['hd', 'image', 'web']) setPid(name, kind);
      state.starts++; state.attributionRows++; note('start-' + kind);
      if (forcedFault === 'after-main-start' && kind === 'main') { forcedFault = null; throw Error('injected after-main-start'); }
      return { kind, source: m[kind].source, build: entries[kind].build, releaseVersion: m[kind].version, actualHealthy: true, readabilityMode: 'normal' };
    },
    restorePolicies: (_m, _before, temporaryPolicy, kind) => { assert.equal(states.web.WorkingDirectory, m[kind].root);
      for (const item of Object.values(temporaryPolicy.files)) if (io.existsSync(item.file)) io.unlinkSync(item.file); note('restore-policies'); },
    observeMaintenance: async () => { assert.equal(state.ingress, 503); return [{ status: 503 }]; },
    observeRestored: (_m, kind, target) => { assert.equal(state.ingress, 200); assert.equal(states.web.WorkingDirectory, m[kind].root); return { host: target.host, status: 200, source: m[kind].source, build: entries[kind].build }; },
    capability: (_m, kind) => ({ source: m[kind].source }), verifyHdSupervisor: (_m, kind) => ({ source: m[kind].source, uniqueLock: true }),
    restoreControlledDrain: async () => { assert.equal(pair.capturePricingStartControl().allowed.sha256, baselineControl.allowed.sha256); for (const name of Object.keys(roleNames)) {
      if (states[name].MainPID === '0') setPid(name, 'old'); }
      for (const name of ['web', 'image', 'hd']) { const file = '/run/systemd/system/' + roleNames[name] + '.d/rate-impl2-' + runId + '.conf';
        if (io.existsSync(file)) io.unlinkSync(file); }
      state.ingress = 200; save('controlled-drain-original-restored', { completed: true, businessDataRestored: false }); note('restore-original'); return { completed: true }; },
  };
  const noForceBytes = name => Buffer.from('# RATE-IMPL2 natural stop ' + runId + '\n[Service]\nRestart=no\nKillSignal=SIGTERM\nSendSIGKILL=no\nTimeoutStopSec=infinity\n'
    + (name === 'hd' ? '\n[Unit]\nRefuseManualStart=yes\n' : ''));
  const safety = { protocol: 'hd-release-safety-v1',
    beforeMaintenance: async () => { assertWindow(); assertApproval(); note('fresh-maintenance-admission'); },
    installFence: async () => { stopped(m, 'image'); stopped(m, 'hd'); assert.equal(states.web.MainPID, before.writers.web.MainPID);
      if (forcedFault === 'before-fence') { forcedFault = null; throw Error('injected before-fence'); }
      state.fence = { phase: 'verified' }; note('install-fence'); return { networkDropins: [], receipt: state.fence }; },
    restoreBeforeStart: async () => { allGone(); assert.equal(state.fence.phase, 'verified'); state.fence = { phase: 'restored', restorePhase: 'before-new-writer-after-proven-old-stop' }; note('restore-network'); },
    inspectRecoveryFence: async () => state.fence,
    restoreForRecovery: async context => { if (context.recoveryRoute === 'original') { stopped(m, 'image'); stopped(m, 'hd'); stopped(m, 'role'); }
      else allGone(); state.fence = { phase: 'restored', restorePhase: 'before-new-writer-after-proven-old-stop' }; note('recover-network'); },
    assertRollbackAllowed: async () => { assertApproval(); assert.equal(json(stage + '/switch-complete.json').kind, 'main'); note('normal-rollback-admitted'); },
    onFailure: async () => ({ action: 'keep-original-no-effects' }) };
  const nativeOverrides = Object.keys(native).map(name => name + '=fixtureNative.' + name + ';').join('\n');
  const rawUpload = { issueRawUploadRecoveryProof: (_m, { assertWritersStopped, published }) => {
    assertWritersStopped(); assert.equal(published.runId, runId); note('retain-original-upload-certificate'); return { retainedUnchanged: true }; } };
  const historicalPrivateHooks = {
    finishPrivateMultiviewPreopen: async value => {
      assert.notEqual(value.privateMultiviewInstall, true); note('private-hook-not-requested'); return { notRequested: true };
    },
    ensurePrivateMultiviewGuard: async value => {
      assert.notEqual(value.privateMultiviewInstall, true); note('private-guard-hook-not-requested'); return { untouched: true };
    },
    stopMultiviewWorksForGuardRecovery: async (value, check) => {
      assert.notEqual(value.privateMultiviewInstall, true);
      const result = await stopUnrequestedPrivateWorks(value, check);
      assert.equal(result.untouched, true); note('private-recovery-hook-not-requested'); return result;
    },
  };
  assert.deepEqual(Object.keys(historicalPrivateHooks), privateSwitchHookNames);
  const historicalHdAdmissionHook = async () => { throw Error('Private HD waiting is unavailable in the historical non-private lifecycle fixture'); };
  const switchApi = load('switch.mjs', {
    ...pair, ...guard, ...canvasSchema, PRICING_START_CONTROL: control, MV_DIRECT: { recoveryRunId: runId }, fixtureNative: native,
    applyFullSchema: (value, ...args) => {
      assert.equal(value.fullRelease, undefined, 'Historical lifecycle fixture must not invoke native full-schema I/O');
      return applyFullSchema(value, ...args);
    },
    fixtureRawUpload: rawUpload,
    verifyCandidate: async (_m, kind) => previous ? candidate.verifyCandidate(_m, kind) : reuse.verifyReusedCandidate(_m, kind),
    readDeployedUsageEvidence: deployed.readDeployedUsageEvidence, assertPriorUsageRoleControl: deployed.assertPriorUsageRoleControl,
    verifyNormalContinuation: () => { assertNoCutoverEffects(io.readdirSync(stage).filter(name => name !== '.switch.lock')); note('normal-zero-effects-admission'); },
    recordHdAdmission: (_m, detail) => { note('hd-detail-durable'); return save('hd-admission-attempt', { detail }); },
    recordNormalRefusal: (_m, _before, error) => { assertNoCutoverEffects(io.readdirSync(stage).filter(name => name !== '.switch.lock')); save('normal-switch-refusal', { effectsStarted: false, error: String(error) }); },
    inspectHdReconciliation: async (_m, options) => ({ safe: options.final === true && options.retiredCachePhase !== 'admission',
      canEnterControlledDrain: options.retiredCachePhase === 'admission', issues: [], unstable: false }),
    inspectHdBeforeMaintenance: historicalHdAdmissionHook,
    readHdStorageProtection: () => ({}), assertHdStorageProtection: () => {}, verifyUploadPrivateDirectory: () => {},
    captureNginxMaintenance: () => ({ runId, stageRoot: stage }),
    installNginxMaintenance: () => { state.ingress = 503; installed = { runId, files: [] }; save('nginx-' + runId + '-installed', installed); note('close-ingress'); return installed; },
    rearmOwnedNginxMaintenance: async () => { state.ingress = 503; note('rearm-ingress'); return { responseEvidence: true, workerEvidence: true }; },
    restoreNginxMaintenance: async ({ healthyConsumers, observeRestored }) => { assert.equal(healthyConsumers.actualHealthy, true); state.ingress = 200;
      const responses = await observeRestored(); note('open-ingress'); return { completed: true, responses }; },
    captureNginxUpstreamSockets: () => ({ count: 0 }),
    captureUsageRole: () => copy(states.role), inspectUsageRoleAdmission: () => { const result = role.roleStartContract(m); note('role-readonly-admission'); return { completed: true, contract: result.contract }; },
    stopUsageRole: async () => { const stopping = copy(states.role); if (states.role.MainPID !== '0') stopRole('role');
      roleJournal.push({ phase: 'stopped', stopping }); save('usage-role-transition-' + events.length, { phase: 'stopped' }); },
    startUsageRole: startRole, assertUsageRoleStopped: () => stopped(m, 'role'),
    // These historical lifecycle scenarios have no private recipe installed.
    // The enabled private hook is exercised by multiview-works-engineering.mjs.
    ...historicalPrivateHooks,
    inspectMultiviewBackupProtection: () => assert.fail('Private backup inspection is not a historical non-private fixture'),
    privateMultiviewBackupFileProtection: () => assert.fail('Private backup projection is not a historical non-private fixture'),
    restoreOriginalUsageRole: async () => ({ unchanged: !events.some(value => value.name === 'natural-exit-role') }),
    usageRoleProof: () => ({ current: copy(states.role), allTransitionsBound: true, forcedKill: false,
      transitions: publishedRole ? [{ runId, manifestSha256, phase: 'start-intent', kind: 'main', published: copy(publishedRole) }] : [] }),
    originalPreparedFile: (_m, kind) => (previous ? stage : originalStage) + '/' + kind + '-prepared.json', originalManifestForInputs: () => previous ? m : original,
    assertRuntimeAliasUnchanged: reuse.assertRuntimeAliasUnchanged,
    probeHdCandidateResolver: async (_m, c, prepared, { phase }) => { assert.equal(_m.runId, previous ? runId : originalRun); assert.equal(prepared.runId, previous ? runId : originalRun);
      assert.equal(c.root, states.hd.WorkingDirectory); note('runtime-probe-original-inputs-' + phase);
      if (previous) {
        const kind = ['main', 'guard'].find(value => m[value].root === c.root); assert.ok(kind);
        assert.deepEqual(copy(prepared), json(stage + '/' + kind + '-prepared.json'));
        return syntheticHdProbe(c, prepared, phase);
      }
      return { phase, readOnly: true }; },
    inspectRecoveryCertificate: () => ({ retained: true, createdByThisRun: false }), readProtection: () => copy(protectedValue),
    assertProtection: (a, b) => assert.deepEqual(copy(a), copy(b)),
  }, ['switchPair', 'privateHdAdmissionBounds', 'recoverFailedSwitch', 'candidateInput', 'rootSnapshot', 'proof'], nativeOverrides,
  text => text.replace("(await import('./raw-upload-recovery-proof.mjs'))", 'fixtureRawUpload'));
  async function prepare() {
    assert.notEqual(originalRun, migrationRun);
    assert.equal(json(migrationStage + '/switch-before.json').runId, migrationRun);
    assert.equal(io.existsSync(originalStage + '/switch-before.json'), false);
    if (previous) for (const kind of ['main', 'guard']) prepareFreshInputs(kind);
    const adopted = migrationApi.adoptOriginalMigration(m);
    assert.equal(adopted.operation, previous ? 'VERIFY-DEPLOYED-SCHEMA' : 'ADOPT'); assert.equal(adopted.ddlExecuted, false);
    assert.equal(adopted.original.runId, migrationRun); assert.equal(adopted.original.at, migrationReceipt.at);
    for (const kind of ['main', 'guard']) {
      assert.equal(io.existsSync(m[kind].root + '/.next-prod'), false);
      if (previous) {
        const proof = await buildFreshReceipt(kind);
        switchApi.candidateInput(m, kind, proof);
      } else await reuse.prepareReusedCandidate(m, kind);
      assert.equal(io.readlinkSync(m[kind].root + '/.next-prod'), '.next-prod-candidate');
      if (!previous) assert.deepEqual(copy(json(candidateEvidenceFile(m, kind)).originalBuild), originals[kind]);
    }
    const approval = { schema: 'hd-release-maintenance-approval.v1', runId, mainSource: m.mainSource, guardSource: m.guardSource,
      manifestSha256, privateFreezeSha256: privateFreezeSha256(m), windowSha256: sha(bytes(m.windowFile)),
      mainBuildReceiptSha256: sha(bytes(candidateEvidenceFile(m, 'main'))), guardBuildReceiptSha256: sha(bytes(candidateEvidenceFile(m, 'guard'))),
      issuedAt: clock, expiresAt: clock + 300000, manualMaintenanceConfirmed: true, allowCompatibleRollback: true,
      candidateEvidenceKind: previous ? 'rate-impl2-candidate-build.v1' : 'sd2-candidate-build-reuse.v1', operations: ['switch', 'rollback-to-compatible-guard'],
      writerFence: { install: true, helperSha256: m.privateSha256['writer-network-fence.mjs'], restorePhases: ['pre-stop-installation-abort', 'before-new-writer-after-proven-old-stop'] } };
    assert.equal(sha(bytes(stage + '/manifest.json')), manifestSha256);
    put(stage + '/hd-release-safety-approval.json', approval, 0o600); note('prepare-original-pair-and-fresh-approval');
  }
  return { m, original, originalStage, migrationOriginal, migrationStage, stage, io, put, bytes, json, entries, originals, state, events, pids, states,
    reuse, guard, pair, role, migrationApi, deployed, switchApi, candidate, safety, prepare, native, manifestSha256, historicalPrivateHooks, historicalHdAdmissionHook,
    setNow: value => { clock = value; }, now: () => clock, mainStarted: () => mainStarted,
    clean: () => fs.rmSync(temporary, { recursive: true, force: false }) };
}

{
  const f = fixture();
  try {
    const before = copy(f.events);
    for (const name of privateSwitchHookNames) {
      const missing = { ...f.historicalPrivateHooks }; delete missing[name];
      assert.throws(() => assertPrivateSwitchBindings(missing, f.historicalPrivateHooks));
      assert.throws(() => assertPrivateSwitchBindings({ ...f.historicalPrivateHooks, [name]: async () => ({}) }, f.historicalPrivateHooks));
      await assert.rejects(() => f.historicalPrivateHooks[name]({ privateMultiviewInstall: true }, () => assert.fail('No live private work in historical fixture')));
    }
    assert.deepEqual(f.events, before);
    assert.throws(() => assertHdAdmissionBinding({}, f.historicalHdAdmissionHook));
    assert.throws(() => assertHdAdmissionBinding({ inspectHdBeforeMaintenance: async () => ({}) }, f.historicalHdAdmissionHook));
    await assert.rejects(() => f.historicalHdAdmissionHook(), /unavailable/);
    add('exact-three-private-import-bindings_reject-missing-replaced-functions-and-enabled-private-mode');
    add('exact-private-hd-import-binding_reject-missing-replaced-hook-and-historical-private-use');
  } finally { f.clean(); }
}

{
  const f = fixture();
  try {
    await f.prepare();
    const now = f.now(), m = { ...f.m, privateMultiviewInstall: true, reuseBuilds: null };
    const window = { project: m.project, runId: m.runId, mainSource: m.mainSource, guardSource: m.guardSource,
      issuedAt: new Date(now).toISOString(), expiresAt: now + 300000 };
    const builds = Object.fromEntries(['main', 'guard'].map(kind => [kind, { runId: m.runId, manifestSha256: f.manifestSha256,
      source: m[kind].source, version: m[kind].version, startedAt: now - 100000, finishedAt: now - 1000, exitCode: 0 }]));
    const baseApproval = f.json(f.stage + '/hd-release-safety-approval.json');
    function prepareBounds({ windowIssuedAt = now, approvalExpiresAt = now + 300000, guardStartedAt = now - 100000 } = {}) {
      window.issuedAt = new Date(windowIssuedAt).toISOString(); window.expiresAt = windowIssuedAt + 300000;
      builds.guard.startedAt = guardStartedAt;
      f.put(m.windowFile, window);
      for (const kind of ['main', 'guard']) f.put(f.stage + '/' + kind + '-build.json', builds[kind]);
      f.put(f.stage + '/hd-release-safety-approval.json', { ...baseApproval, expiresAt: approvalExpiresAt,
        windowSha256: sha(f.bytes(m.windowFile)), mainBuildReceiptSha256: sha(f.bytes(f.stage + '/main-build.json')),
        guardBuildReceiptSha256: sha(f.bytes(f.stage + '/guard-build.json')) });
      return f.switchApi.privateHdAdmissionBounds(m, builds, f.manifestSha256);
    }
    assert.equal(prepareBounds().deadline, now + 15000);
    assert.equal(prepareBounds({ windowIssuedAt: now - 299500 }).deadline, now + 500);
    assert.equal(prepareBounds({ approvalExpiresAt: now + 300 }).deadline, now + 300);
    const bounds = prepareBounds({ guardStartedAt: now - 1799900 }); assert.equal(bounds.deadline, now + 100);
    f.setNow(now + 100); assert.throws(() => bounds.check(), /deadline expired/); f.setNow(now);
    const pinned = prepareBounds(); f.put(f.stage + '/guard-build.json', { ...builds.guard, finishedAt: now - 999 });
    assert.throws(() => pinned.check(), /input changed/);
    assert.throws(() => f.switchApi.privateHdAdmissionBounds({ ...m, reuseBuilds: { sourceRun: 'old' } }, builds, f.manifestSha256), /reused build/);
    assert.throws(() => prepareBounds({ approvalExpiresAt: now }));
    add('private-hd-admission-minimum-of-hard-15s-original-window-approval-and-both-build-TTL');
    add('private-hd-admission-expiry-input-drift-and-old-build-reuse-refused');
  } finally { f.clean(); }
}

for (const form of [0, 'utc']) {
  const f = fixture();
  try {
    await f.prepare();
    if (form === 'utc') { const approval = f.json(f.stage + '/hd-release-safety-approval.json');
      approval.issuedAt = new Date(approval.issuedAt).toISOString(); approval.expiresAt = new Date(approval.expiresAt).toISOString();
      f.put(f.stage + '/hd-release-safety-approval.json', approval, 0o600); }
    const result = await f.switchApi.switchPair(f.m, { safety: f.safety });
    assert.equal(result.kind, 'main'); assert.equal(result.databaseRestored, false);
    const complete = f.json(f.stage + '/switch-complete.json'); assert.equal(complete.kind, 'main');
    assert.equal(f.guard.readGuardRecovery(f.m).originalFullGuardBuild.runId, f.original.runId);
    assert.equal(f.state.ingress, 200); assert.equal(f.state.attributionRows, 1);
    assertNoCutoverEffects(['switch-before.json', 'fixed-guard-recovery.json']);
    assert.throws(() => assertNoCutoverEffects(f.io.readdirSync(f.stage)));
    assert.equal(f.io.readdirSync(f.stage).some(name => /^(?:rollback-|guard-recovery-(?:attempt|start|complete)|switch-failure-)/.test(name)), false);
    traces.push({ outcome: 'normal-first-publication-' + (form === 'utc' ? 'utc' : 'numeric'), events: f.events });
    add('never-run-original-full-pair_to_strict-cross-run-reuse_to_first-publication_and_closure_' + form);
    if (form === 'utc') {
      // Consume the actual first switch and proof producer outputs, not invented success postconditions.
      const retainedProof = { stdout: JSON.stringify(f.switchApi.proof(f.m)),
        command: JSON.stringify({ start: new Date(f.now() - 1000).toISOString(), finish: new Date(f.now()).toISOString(),
          status: 0, signal: null, error: null }) };
      const next = fixture({ previous: f, retainedProof });
      try {
        assert.equal(next.state.attributionRows, 1);
        assert.equal(next.m.reuseBuilds, undefined);
        const historicalFiles = ['manifest.json', 'switch-before.json', 'usage-attribution-migration/receipt.json',
          'usage-attribution-migration/backup-proof.json', 'usage-attribution-migration/consistent-backup.sqlite'];
        const originalHistory = Object.fromEntries(historicalFiles.map(file => [file, f.bytes(f.migrationStage + '/' + file).toString()]));
        const originalPublication = Object.fromEntries(['manifest.json', 'switch-complete.json'].map(file => [file, f.bytes(f.stage + '/' + file).toString()]));
        for (const file of historicalFiles) assert.equal(next.bytes(next.migrationStage + '/' + file).toString(), originalHistory[file]);
        const checked = next.deployed.verifyDeployedUsageSchema(next.m);
        assert.equal(checked.observed.attributionRows, 1); assert.equal(checked.observed.databaseWrites, 0);
        const initial = next.json(next.migrationStage + '/switch-before.json');
        assert.deepEqual(copy(next.deployed.assertPriorPublication(next.m, checked.prior, checked.complete, checked.final,
          checked.original, checked.receipt, checked.proof, initial)), ['64784', '171442216']);
        for (const mutate of [v => { v.complete.mode = 'rollback'; }, v => { v.complete.kind = 'guard'; },
          v => { v.complete.healthy.actualHealthy = false; }, v => { v.complete.databaseRestored = true; },
          v => { v.final.readOnly = false; }, v => { v.final.role.forcedKill = true; },
          v => { v.receipt.source = '9'.repeat(40); }, v => { v.initial.protection.databaseIdentity[1] = '0'; }]) {
          const invalid = copy({ ...checked, initial }); mutate(invalid);
          assert.throws(() => next.deployed.assertPriorPublication(next.m, invalid.prior, invalid.complete, invalid.final,
            invalid.original, invalid.receipt, invalid.proof, invalid.initial));
        }
        const savedInput = copy(next.m.deployedUsageSchema);
        for (const key of Object.keys(savedInput).filter(key => key.endsWith('Sha256'))) {
          next.m.deployedUsageSchema[key] = '0'.repeat(64);
          assert.throws(() => next.deployed.verifyDeployedUsageSchema(next.m));
          next.m.deployedUsageSchema = copy(savedInput);
        }
        for (const change of [m => { m.database += '.other'; }, m => { m.live.web.source = '9'.repeat(40); },
          m => { m.live.image.build += '-wrong'; }, m => { m.live.role.version = '0.0.0'; },
          m => { m.reuseBuilds = {}; }, m => { m.normalContinuation = {}; },
          m => { m.mainSource = checked.prior.mainSource; }]) {
          const changed = copy(next.m); change(changed);
          assert.throws(() => next.deployed.verifyDeployedUsageSchema(changed));
        }
        const candidateSql = next.m.guard.root + '/prisma/migrations/20261021073000_usage_attribution/migration.sql';
        const sqlBytes = next.bytes(candidateSql); next.put(candidateSql, 'changed SQL'); next.io.chownSync(candidateSql, 1004, 1004);
        assert.throws(() => next.deployed.verifyDeployedUsageSchema(next.m));
        next.put(candidateSql, sqlBytes); next.io.chownSync(candidateSql, 1004, 1004);
        add('second-publication_rejects_changed-history-baseline-db-pair-and-candidate-before-maintenance');
        await next.prepare();
        // One assembled batch, then actual consumers reject each damaged contract.
        // No switch is attempted on a negative fixture; every byte/mode is restored.
        const buildFile = candidateEvidenceFile(next.m, 'main'), buildBytes = next.bytes(buildFile);
        const preparedFile = next.stage + '/main-prepared.json', preparedBytes = next.bytes(preparedFile);
        const originalBuild = next.json(buildFile);
        await next.candidate.verifyCandidate(next.m, 'main');
        for (const mutate of [v => { delete v.gateReceipt; }, v => { v.label = 'guard'; },
          v => { v.source = next.m.guardSource; }, v => { v.version = '0.0.0'; }, v => { v.runId = f.m.runId; },
          v => { v.manifestSha256 = '0'.repeat(64); }, v => { v.sourceManifestSha256 = '0'.repeat(64); },
          v => { v.preparedSha256 = '0'.repeat(64); }, v => { v.compiledTreeSha256 = '0'.repeat(64); },
          v => { v.logSha256 = '0'.repeat(64); }, v => { v.logFile = next.stage + '/guard-build.log'; },
          v => { v.gateReceipt = next.json(candidateEvidenceFile(next.m, 'guard')).gateReceipt; },
          v => { v.uploadHelperProbe.productionDatabaseUsed = true; }, v => { v.uploadHelperProbe.phase = 'prepare'; },
          v => { v.hdHelperProbe.sourceManifestSha256 = '0'.repeat(64); }, v => { v.hdHelperProbe.writeAttempts = 1; }]) {
          const changed = copy(originalBuild); mutate(changed); next.put(buildFile, changed);
          try { await assert.rejects(() => next.candidate.verifyCandidate(next.m, 'main')); }
          finally { next.put(buildFile, buildBytes); }
        }
        add('fresh-build-output_consumer_rejects_missing-path-pair-digest-log-and-probe-contracts');
        for (const mutate of [v => { v.schema = 'unknown'; }, v => { v.label = 'guard'; },
          v => { v.manifestSha256 = '0'.repeat(64); }, v => { v.sourceManifestSha256 = '0'.repeat(64); },
          v => { v.source = next.m.guardSource; }, v => { v.candidateRoot = next.m.guard.root; },
          v => { v.buildEnv.DATABASE_URL = 'file:' + next.m.database; },
          v => { v.uploadHelperProbe.productionDatabaseUsed = true; }]) {
          const changed = JSON.parse(preparedBytes); mutate(changed); next.put(preparedFile, changed);
          try { await assert.rejects(() => next.candidate.verifyCandidate(next.m, 'main')); }
          finally { next.put(preparedFile, preparedBytes); }
        }
        add('fresh-prepared-output_consumer_rejects_wrong-identity-input-hash-and-production-db');
        const gateFile = originalBuild.gateReceipt, gateBytes = next.bytes(gateFile), gateStat = next.io.lstatSync(gateFile);
        for (const mutate of [() => next.io.chmodSync(gateFile, 0o644), () => next.io.chownSync(gateFile, 0, 0),
          () => next.put(gateFile, ''), () => {
            const changed = JSON.parse(gateBytes); changed.runId = f.m.runId; next.put(gateFile, changed);
          }]) {
          mutate();
          try { await assert.rejects(() => next.candidate.verifyCandidate(next.m, 'main')); }
          finally { next.put(gateFile, gateBytes); next.io.chmodSync(gateFile, gateStat.mode & 0o777); next.io.chownSync(gateFile, gateStat.uid, gateStat.gid); }
        }
        const heldGate = gateFile + '.held'; next.io.renameSync(gateFile, heldGate); next.io.symlinkSync(heldGate, gateFile);
        try { await assert.rejects(() => next.candidate.verifyCandidate(next.m, 'main')); }
        finally { next.io.unlinkSync(gateFile); next.io.renameSync(heldGate, gateFile); }
        add('fresh-gate-file_consumer_rejects_public-mode-root-owner-empty-other-run-and-alias');
        for (const file of [next.m.main.root + '/src/file-0.ts', next.m.main.root + '/.next-prod-candidate/server/0.js', originalBuild.logFile]) {
          const saved = next.bytes(file); next.put(file, 'tampered synthetic observation');
          try { await assert.rejects(() => next.candidate.verifyCandidate(next.m, 'main')); }
          finally { next.put(file, saved); }
        }
        await next.candidate.verifyCandidate(next.m, 'main'); await next.candidate.verifyCandidate(next.m, 'guard');
        assert.equal(next.state.starts, 0); assert.equal(next.events.some(value => value.name === 'close-ingress'), false);
        add('fresh-source-compiled-log_consumers_reject_tampering_before_any_switch');
        const adopted = next.deployed.readDeployedUsageEvidence(next.m);
        assert.equal(adopted.source, next.m.mainSource); assert.equal(adopted.original.runId, f.migrationOriginal.runId);
        assert.equal(adopted.publication.runId, f.m.runId); assert.equal(adopted.observed.attributionRows, 1);
        const result = await next.switchApi.switchPair(next.m, { safety: next.safety });
        assert.equal(result.kind, 'main'); assert.equal(result.databaseRestored, false);
        assert.equal(next.json(next.stage + '/switch-complete.json').healthy.source, next.m.mainSource);
        assert.equal(next.state.attributionRows, 2); assert.equal(next.state.ingress, 200);
        for (const file of historicalFiles) assert.equal(next.bytes(next.migrationStage + '/' + file).toString(), originalHistory[file]);
        for (const [file, original] of Object.entries(originalPublication)) assert.equal(next.bytes(f.stage + '/' + file).toString(), original);
        assert.equal(next.bytes(next.stage + '/deployed-usage-prior-proof.stdout').toString(), retainedProof.stdout);
        assert.equal(next.bytes(next.stage + '/deployed-usage-prior-proof-command.json').toString(), retainedProof.command);
        assert.equal(next.deployed.readDeployedUsageEvidence(next.m).databaseWrites, 0);
        const final = next.switchApi.proof(next.m);
        assert.equal(final.schema, 'rate-impl2-switch-proof.v1'); assert.equal(final.runId, next.m.runId);
        assert.equal(final.manifestSha256, next.manifestSha256); assert.equal(final.readOnly, true);
        assert.deepEqual(copy(final.protection), copy(checked.final.protection));
        const allowedBytes = Buffer.from(final.pricingStartControl.allowed.bytesBase64, 'base64');
        assert.equal(sha(allowedBytes), final.pricingStartControl.allowed.sha256);
        const allowed = JSON.parse(allowedBytes); assert.equal(allowed.runId, next.m.runId); assert.equal(allowed.releases.length, 2);
        for (const kind of ['main', 'guard']) {
          const entry = allowed.releases.find(value => value.source === next.m[kind].source); assert.ok(entry);
          assert.equal(entry.root, next.m[kind].root); assert.equal(entry.version, next.m[kind].version);
          assert.equal(entry.build, next.entries[kind].build);
          assert.deepEqual(entry.sourceFiles, next.entries[kind].sourceFiles);
        }
        for (const role of ['web', 'image', 'hd']) {
          assert.equal(final.units[role].WorkingDirectory, next.m.main.root);
          assert.equal(final.units[role].MainPID, next.states[role].MainPID);
          assert.equal(final.units[role].ActiveState, 'active'); assert.equal(final.units[role].SubState, 'running');
          assert.equal(final.units[role].ControlPID, '0');
        }
        assert.equal(final.role.current.WorkingDirectory, next.m.main.root); assert.equal(final.role.current.ActiveState, 'active');
        assert.equal(final.role.allTransitionsBound, true); assert.equal(final.role.forcedKill, false);
        assert.equal(final.role.transitions.length, 1);
        const transition = final.role.transitions[0]; assert.equal(transition.runId, next.m.runId);
        assert.equal(transition.manifestSha256, next.manifestSha256); assert.equal(transition.kind, 'main');
        const roleAllowed = next.json(next.m.projectRoot + '/controls/usage-role-writer-v1/allowed.json');
        assert.deepEqual(copy(transition.published.contract), roleAllowed);
        assert.equal(roleAllowed.runId, next.m.runId); assert.equal(roleAllowed.schemaSha256, adopted.newSchemaSha256);
        for (const kind of ['main', 'guard']) {
          const entry = roleAllowed.releases.find(value => value.source === next.m[kind].source); assert.ok(entry);
          assert.equal(entry.root, next.m[kind].root); assert.equal(entry.build, next.entries[kind].build);
        }
        assert.equal(final.writerStartIntent.schema, 'pricing-new-writer-start-intent.v1');
        assert.equal(final.writerStartIntent.runId, next.m.runId);
        assert.equal(final.writerStartIntent.allowedSha256, sha(allowedBytes));
        assert.equal(final.writerStartIntent.transitionReceiptSha256,
          next.json(next.stage + '/pricing-pair-published.json').published.receiptSha256);
        assert.equal(next.guard.readGuardRecovery(next.m).originalFullGuardBuild.runId, next.m.runId);
        add('second-fresh-publication_actual-final-proof_binds-pair-role-latch-and-preserved-history');
        traces.push({ outcome: 'normal-second-publication-after-actual-first-closure', events: next.events });
        add('completed-first-publication_to_nonempty-readonly-schema-adoption_to_fresh-pair-second-normal-publication');
      } finally { next.clean(); }
    }
    if (form === 0) {
      const rolled = await f.switchApi.switchPair(f.m, { mode: 'rollback', safety: f.safety });
      assert.equal(rolled.kind, 'guard'); assert.equal(rolled.databaseRestored, false);
      assert.equal(f.json(f.stage + '/rollback-complete.json').kind, 'guard');
      assert.equal(f.state.attributionRows, 2); assert.equal(f.migrationApi.readMigrationEvidence(f.m).runId, f.migrationOriginal.runId);
      assert.equal(f.state.ingress, 200); add('normal-compatible-guard-rollback_preserves-new-attribution-and-original-migration');
    }
  } finally { f.clean(); }
}
{
  // A rejection can retain failure evidence; never lend this fixture to a success consumer.
  const f = fixture();
  try {
    await f.prepare();
    await f.switchApi.switchPair(f.m, { safety: f.safety });
    const complete = f.bytes(f.stage + '/switch-complete.json');
    const starts = f.state.starts;
    await assert.rejects(() => f.switchApi.switchPair(f.m, { safety: f.safety }));
    assert.ok(f.io.readdirSync(f.stage).some(name => name.startsWith('switch-failure-')));
    assert.equal(f.bytes(f.stage + '/switch-complete.json').equals(complete), true);
    assert.equal(f.state.starts, starts);
    assert.equal(f.state.ingress, 200);
    add('isolated-repeat-switch-refusal_retains-failure-evidence_without-new-writer');
  } finally { f.clean(); }
}
{
  const f = fixture({ fault: 'after-main-start' });
  try {
    await f.prepare(); await assert.rejects(() => f.switchApi.switchPair(f.m, { safety: f.safety }), /injected after-main-start/);
    assert.equal(f.json(f.stage + '/guard-recovery-complete.json').completed, true);
    assert.equal(f.state.ingress, 200); assert.equal(f.states.web.WorkingDirectory, f.m.guard.root);
    assert.equal(f.states.role.WorkingDirectory, f.m.guard.root); assert.equal(f.state.attributionRows, 2);
    assert.equal(f.io.existsSync(f.stage + '/normal-switch-refusal.json'), false);
    assert.equal(f.io.existsSync(f.stage + '/switch-complete.json'), false);
    const privateDrain = f.events.flatMap((value, index) => value.name === 'private-recovery-hook-not-requested' ? [index] : []);
    assert.equal(privateDrain.length, 1);
    assert.ok(privateDrain[0] < f.events.findIndex(value => value.name === 'start-guard'));
    assert.ok(f.events.slice(0, privateDrain[0]).some(value => value.name === 'natural-exit-web'));
    assert.throws(() => assertNoCutoverEffects(f.io.readdirSync(f.stage)));
    traces.push({ outcome: 'actual-switch-failure_then-fixed-guard-recovery_and-closure', events: f.events });
    add('actual-main-start-fault_uses-fixed-guard-recovery_not-normal-retry_or-data-rollback');
  } finally { f.clean(); }
}
{
  const f = fixture({ fault: 'before-fence' });
  try {
    await f.prepare(); await assert.rejects(() => f.switchApi.switchPair(f.m, { safety: f.safety }), /injected before-fence/);
    assert.equal(f.json(f.stage + '/guard-recovery-complete.json').route, 'original-before-fence');
    assert.equal(f.state.ingress, 200); assert.equal(f.state.starts, 0); assert.equal(f.state.attributionRows, 0);
    assert.equal(f.states.web.WorkingDirectory, f.m.live.web.root); assert.equal(f.states.role.WorkingDirectory, f.m.live.role.root);
    assert.equal(f.io.existsSync(f.stage + '/normal-switch-refusal.json'), false);
    assert.throws(() => assertNoCutoverEffects(f.io.readdirSync(f.stage)));
    traces.push({ outcome: 'known-before-fence-abort_restores-original-program_only', events: f.events });
    add('actual-before-fence-fault_restores-original-program_without-new-writer_or-data-rollback');
  } finally { f.clean(); }
}
for (const mutation of ['original-switched', 'original-migration-collision', 'active-candidate', 'wrong-alias', 'broken-alias', 'ordinary-file', 'same-target-replaced', 'alias-owner-changed', 'changed-build', 'missing-original-proof', 'expired-admission']) {
  const f = fixture();
  try {
    await f.prepare(); const link = f.m.main.root + '/.next-prod';
    if (mutation === 'original-switched') f.put(f.originalStage + '/switch-complete.json', { completed: true });
    if (mutation === 'original-migration-collision') f.put(f.originalStage + '/switch-before.json', f.bytes(f.migrationStage + '/switch-before.json'));
    if (mutation === 'active-candidate') { f.put('/proc/12345/stat', '12345 (synthetic) S 1'); f.io.symlinkSync(f.m.main.root, '/proc/12345/cwd'); }
    if (['wrong-alias', 'broken-alias', 'ordinary-file'].includes(mutation)) {
      f.io.unlinkSync(link); if (mutation === 'ordinary-file') f.put(link, 'must not replace');
      else f.io.symlinkSync(mutation === 'wrong-alias' ? f.m.guard.root + '/.next-prod-candidate' : 'missing', link);
    }
    if (mutation === 'same-target-replaced') { f.io.unlinkSync(link); f.io.symlinkSync('.next-prod-candidate', link); }
    if (mutation === 'alias-owner-changed') f.io.lchownSync(link, 1004, 1004);
    if (mutation === 'changed-build') f.put(f.m.main.root + '/.next-prod-candidate/server/1.js', 'drift');
    if (mutation === 'missing-original-proof') f.io.unlinkSync(f.originalStage + '/main-build.json');
    if (mutation === 'expired-admission') { f.setNow(f.now() + 1800001); f.put(f.m.windowFile, { runId: f.m.runId, expiresAt: f.now() + 300000 }); }
    if (['original-switched', 'original-migration-collision', 'active-candidate', 'wrong-alias', 'broken-alias', 'ordinary-file'].includes(mutation))
      assert.throws(() => f.reuse.prepareFirstRuntimeAlias(f.m, 'main', f.json(f.m.reuseBuilds.main.file)));
    else await assert.rejects(() => f.switchApi.switchPair(f.m, { safety: f.safety }));
    assert.equal(f.events.some(value => value.name === 'close-ingress'), false);
    assert.equal(f.state.starts, 0); add('full-path-premaintenance-refuses-' + mutation);
  } finally { f.clean(); }
}
// Only the appended prepare tail is exercised here. Service observations are
// isolated adapters; the production tail body and unused-input guards run intact.
for (const scenario of ['success', 'main-drift', 'guard-input-drift', 'consumed-input', 'hd-conflict']) {
  const stage = '/isolated-prepare-tail', runId = '10000000-0000-4000-8000-000000000002';
  const m = { stage, runId, appUser: 'isolated', reuseBuilds: null,
    main: { root: stage + '/main', source: 'a'.repeat(40), version: '0.104.0', buildDist: '.next-prod-candidate' },
    guard: { root: stage + '/guard', source: 'b'.repeat(40), version: '0.104.0+guard', buildDist: '.next-prod-candidate' } };
  const main = { schema: 'rate-impl2-candidate-prepared.v1', label: 'main', preparedAt: '2026-10-23T00:00:00Z',
    hdHelperProbe: {}, preservedField: 'original preparation bytes' };
  const originalMain = Buffer.from(JSON.stringify(main)), guardInput = Buffer.from('original isolated input');
  const mainFile = stage + '/main-prepared.json', guardInputFile = m.guard.root + '/.role-tests/pricing-prepared-' + runId + '/candidate-inputs.json';
  const writes = [], present = new Set(scenario === 'consumed-input'
    ? [m.guard.root + '/.role-tests/pricing-prepared-' + runId + '/.pricing-gate-claim'] : []);
  const rootFile = file => {
    if (file === mainFile) return scenario === 'main-drift' ? Buffer.concat([originalMain, Buffer.from(' ')]) : originalMain;
    assert.equal(file, guardInputFile); return scenario === 'guard-input-drift' ? Buffer.from('changed input') : guardInput;
  };
  const namespace = { assert: sameAssert, Buffer, Date, JSON, sha, rootFile,
    absent: file => assert.equal(present.has(file), false, 'Never overwrite candidate state'),
    assertControlPreflight: () => {}, assertReleaseWindow: () => {}, requireOriginalLive: () => {},
    context: (_m, kind) => ({ c: m[kind], source: { files: {} }, manifestSha256: 'c'.repeat(64), sourceManifestSha256: 'd'.repeat(64) }),
    readProtection: () => ({ unchanged: true }), assertProtection: (a, b) => assert.deepEqual(copy(a), copy(b)),
    sourceCheck: () => {}, runtimeBindings: () => {}, inputs: () => ({ prepared: main }),
    verifyHdCandidateResolver: () => {}, verifyPrepareTailDependencies: () => {}, verifyPrepareTailSchema: () => ({ readOnly: true }),
    readPreparedPricingInputs: () => ({ candidateRoot: m.guard.root, source: m.guard.source, runId, appUser: m.appUser }),
    probeUploadHelper: () => ({ readOnly: true }), probeHdCandidateResolver: async () => ({ readOnly: true }),
    inspectHdReconciliation: async () => ({ readOnly: true, issues: scenario === 'hd-conflict' ? [{ code: 'exact-retained-conflict', key: 'key' }] : [] }),
    isSharedEngine: () => false, verifyPricingInputs: () => {},
    writeJsonExclusive: (file, value) => { assert.notEqual(file, mainFile); writes.push({ file, value: copy(value) }); },
  };
  const functions = ['assertPrepareTailUnused', 'inspectPrepareTailInputs', 'resumePrepareTail'].map(name =>
    functionNode('candidate.mjs', name).node.getText().replace(/^export /, '')).join('\n');
  vm.runInNewContext(functions + '\nglobalThis.run=resumePrepareTail;', namespace);
  const binding = { mainPreparedSha256: sha(originalMain), guardInputSha256: sha(guardInput), continuationSha256: 'e'.repeat(64) };
  if (scenario === 'success') {
    const result = await namespace.run(m, binding);
    assert.deepEqual(copy(result.main), main); assert.equal(result.main.preparedAt, main.preparedAt);
    assert.equal(writes.length, 2); assert.match(writes[0].file, /prepare-tail-hd-/);
    assert.equal(writes[1].file, stage + '/guard-prepared.json');
    assert.equal(writes[1].value.prepareTailContinuation.originalMainPreparedSha256, binding.mainPreparedSha256);
  } else {
    const message = { 'main-drift': /Original successful main preparation changed/, 'guard-input-drift': /Original guard isolated input changed/,
      'consumed-input': /Never overwrite candidate state/, 'hd-conflict': /exact issues retained/ }[scenario];
    await assert.rejects(() => namespace.run(m, binding), message);
    if (scenario === 'hd-conflict') {
      assert.equal(writes.length, 1); assert.equal(writes[0].value.hdReconciliation.issues[0].code, 'exact-retained-conflict');
    } else assert.equal(writes.length, 0);
  }
  assert.equal(sha(originalMain), binding.mainPreparedSha256);
  add('prepare-tail_actual-body_' + scenario);
}
// Exercise the actual tail body without granting it a compiler or business work.
// Original gate internals remain covered by the native receipts above.
for (const scenario of ['success', 'npm-failed', 'duplicate-gate', 'artifact-drift', 'probe-used', 'main-started', 'protection-drift']) {
  const now = 1792800000000, stage = '/isolated-guard-build-tail', root = stage + '/guard', preparedRoot = root + '/.role-tests/prepared';
  const m = { stage, runId: '10000000-0000-4000-8000-000000000004', appUser: 'isolated',
    engine: { schema: 'sd2-release-engine.v1' }, operation: { taskId: 'tail-task', attemptId: 'tail-attempt' },
    guard: { root, source: 'b'.repeat(40), version: '0.104.0+guard', buildDist: '.next-prod-candidate' } };
  const packageBytes = Buffer.from('{"version":"0.104.0+guard"}'), buildBytes = Buffer.from('retained-build\n');
  const imageFile = preparedRoot + '/image.json', pricingFile = preparedRoot + '/pricing.json';
  const log = Buffer.from('IMAGE_RECOVERY_GATE_RECEIPT=' + imageFile + '\nPRICING_POLICY_GATE_RECEIPT=' + pricingFile + '\n'
    + (scenario === 'duplicate-gate' ? 'IMAGE_RECOVERY_GATE_RECEIPT=' + imageFile + '\n' : ''));
  const prepared = { preparedRoot, buildEnv: { isolated: 'true' }, uploadHelperProbe: { originalPrepare: 'upload' }, hdHelperProbe: { originalPrepare: 'hd' } };
  const preparedSha256 = sha(JSON.stringify(prepared)), manifestSha256 = 'a'.repeat(64);
  const command = { schema: 'sd2-original-build-command.v1', runId: m.runId, label: 'guard', source: m.guard.source,
    manifestSha256, status: scenario === 'npm-failed' ? 1 : 0, signal: null, error: null, errorCode: null,
    originalExitRecordedBeforePostchecks: true, buildEnvironmentSha256: sha(JSON.stringify(prepared.buildEnv)),
    logFile: stage + '/guard-build.log', logSha256: sha(log), startedAt: now - 7200000, finishedAt: now - 3600000 };
  const documents = new Map([[stage + '/guard-build-command.json', Buffer.from(JSON.stringify(command))],
    [stage + '/guard-build.log', log], [stage + '/main-prepared.json', Buffer.from('original main prepared')],
    [imageFile, Buffer.from('original image gate')], [pricingFile, Buffer.from('original pricing gate')]]);
  const built = { build: 'retained-build', sha256: sha('retained compiled output') }, events = [], writes = [];
  const request = { guardPreparedSha256: preparedSha256, mainPreparedSha256: sha(documents.get(stage + '/main-prepared.json')),
    buildCommandSha256: sha(documents.get(stage + '/guard-build-command.json')), buildLogSha256: sha(log),
    packageJsonSha256: sha(packageBytes), buildIdSha256: sha(buildBytes), observedCompiledTreeSha256: built.sha256,
    imageGateReceiptSha256: sha(documents.get(imageFile)), pricingGateReceiptSha256: sha(documents.get(pricingFile)), observedAt: now - 1 };
  const runtime = { schema: 'sd2-release-guard-build-tail-runtime.v1', phase: 'guard-build', proofFile: stage + '/tail-proof.json',
    continuationSha256: 'e'.repeat(64), proof: { request, originalBuild: { startedAt: command.startedAt, finishedAt: command.finishedAt, build: built.build } } };
  class TailDate extends Date { static now() { return now; } }
  const namespace = { assert: sameAssert, Buffer, JSON, Date: TailDate, sha, GUARD_BUILD_TAIL_SCHEMA,
    guardBuildTailRuntime: () => runtime, assertCandidateObservation: () => null, isSharedEngine: () => true, engineDirectory: () => '/original-engine',
    assertControlPreflight: () => {}, assertReleaseWindow: () => {}, requireOriginalLive: () => {},
    context: () => ({ c: m.guard, source: { files: {} }, manifestSha256, sourceManifestSha256: 'c'.repeat(64) }),
    sourceCheck: () => {}, assertProtectedIncrementCandidate: () => {}, inputs: () => ({ prepared, preparedSha256 }),
    rootFile: file => { assert.ok(documents.has(file), 'Unknown isolated input: ' + file); return documents.get(file); },
    call: (name, args) => { assert.equal(name, 'id'); assert.deepEqual([...args], ['-u', 'isolated']); return '1004'; },
    absent: file => { if (scenario === 'main-started' && file === stage + '/main-build.log') throw Error('main already started');
      assert.equal(documents.has(file), false); },
    appReceipt: file => ({ sha256: sha(documents.get(file)) }),
    compiledTree: () => scenario === 'artifact-drift' ? { ...built, sha256: sha('changed output') } : { ...built },
    fs: { readFileSync: file => { if (file === root + '/package.json') return packageBytes;
      assert.equal(file, root + '/.next-prod-candidate/BUILD_ID'); return buildBytes; },
      lstatSync: file => { assert.equal(file, preparedRoot + '/hd-compile-probe'); return { isDirectory: () => true, isSymbolicLink: () => false, uid: 1004, mode: 0o700 }; },
      realpathSync: file => file, readdirSync: () => scenario === 'probe-used' ? ['must retain'] : [] },
    readProtection: () => ({ stable: !(scenario === 'protection-drift' && events.includes('probe')) }),
    assertProtection: (a, b) => assert.deepEqual(copy(a), copy(b)),
    verifyUploadHelperProbe: (_m, _c, _s, _p, probe, phase) => { assert.equal(probe, prepared.uploadHelperProbe); assert.equal(phase, 'prepare'); },
    verifyHdCandidateResolver: (_m, _c, _p, probe, { phase }) => { assert.equal(probe, prepared.hdHelperProbe); assert.equal(phase, 'prepare'); },
    captureHdCompiledCache: (_m, kind, p, { probeDirectory }) => { assert.equal(kind, 'guard'); assert.equal(p, prepared);
      assert.equal(probeDirectory, preparedRoot + '/hd-compile-probe-tail-' + runtime.continuationSha256.slice(0, 16));
      events.push('probe'); return { file: stage + '/guard-hd-compiled-cache.json' }; },
    verifyGates: () => ({ pricing: { receipt: pricingFile } }), verifyPricingInputs: () => {},
    writeJsonExclusive: (file, value) => { assert.equal(file, stage + '/guard-build.json'); assert.equal(documents.has(file), false);
      writes.push(copy(value)); documents.set(file, Buffer.from(JSON.stringify(value))); },
    sealOriginalSuccess: async (_m, kind) => { assert.equal(kind, 'guard'); assert.equal(writes.length, 1); events.push('first-seal'); },
    spawnSync: () => assert.fail('Tail must never compile'), buildCandidate: () => assert.fail('Tail must never replay buildCandidate'),
  };
  const functions = ['assertGuardBuildTailObservation', 'assertFreshCandidateEvidence', 'candidateEvidenceExpiresAt'].map(name =>
    functionNode('candidate-evidence.mjs', name).node.getText().replace(/^export /, '')).join('\n') + '\n'
    + functionNode('candidate.mjs', 'completeSuccessfulGuardBuildTail').node.getText().replace(/^export /, '');
  vm.runInNewContext(functions + '\nglobalThis.run=completeSuccessfulGuardBuildTail;globalThis.fresh=assertFreshCandidateEvidence;', namespace);
  if (scenario === 'success') {
    const result = await namespace.run(m, runtime);
    assert.equal(result.startedAt, command.startedAt); assert.equal(result.finishedAt, command.finishedAt); assert.equal(result.build, built.build);
    assert.equal(result.tailPostchecks.observedAt, now); assert.equal(result.tailPostchecks.expiresAt, now + 1800000);
    assert.deepEqual(events, ['probe', 'first-seal']); assert.equal(writes.length, 1);
    assert.throws(() => namespace.fresh({ ...copy(result), schema: 'rate-impl2-candidate-build.v1' }, m, 'guard', now), /stale/);
    assert.throws(() => namespace.fresh(result, m, 'guard', now + 1800000), /expired/);
  } else {
    await assert.rejects(() => namespace.run(m, runtime)); assert.equal(writes.length, 0); assert.equal(events.includes('first-seal'), false);
    assert.equal(events.includes('probe'), scenario === 'protection-drift');
  }
  add('guard-build-tail_actual-body_' + scenario);
}
// Native Node loader/TTL transport only. Minimal verifier modules retain each
// exact age assertion from the real frozen script and its original nested
// pricing spawn. This does not rerun or claim all original business fixtures.
// Execute the production reader/freshness consumers with isolated root-document
// and journal observations. The root authorizer's full disk/DB observation is
// covered at its own boundary; this fixture does not manufacture that claim.
{
  const now = Date.now(), start = now - 7200000, stage = '/isolated-reader/stage', taskRoot = '/isolated-reader/task';
  const runId = randomUUID(), owner = { token: 'synthetic-new-owner' }, previousOwner = { token: 'synthetic-old-owner' };
  const documents = new Map(), put = (file, value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    documents.set(file, bytes); return sha(bytes);
  };
  const m = { runId, stage, projectRoot: '/isolated-reader', engine: { root: '/isolated-reader/engine' },
    operation: { taskRoot, taskId: 'reader-task', attemptId: runId }, privateSha256: { 'candidate-evidence.mjs': '0'.repeat(64), 'candidate-reuse.mjs': '0'.repeat(64) },
    main: { root: '/isolated-reader/main', source: 'a'.repeat(40), version: '0.104.0', sourceManifest: '/isolated-reader/main-source.json' },
    guard: { root: '/isolated-reader/guard', source: 'b'.repeat(40), version: '0.104.0', sourceManifest: '/isolated-reader/guard-source.json' } };
  const manifestSha256 = put(stage + '/manifest.json', m);
  const controllerNames = Object.keys(m.privateSha256), controllerSets = new Map();
  const processor = root => {
    const controllers = Object.fromEntries(controllerNames.map(name => [name, put(root + '/' + name, root + ':' + name)]));
    controllerSets.set(root, controllers);
    return { processor: { root, controllerSetSha256: sha(JSON.stringify(controllers)) }, processorControllers: controllers };
  };
  const request = { observedAt: start + 20000, buildCommandSha256: 'c'.repeat(64), buildLogSha256: 'd'.repeat(64),
    observedCompiledTreeSha256: 'e'.repeat(64) };
  const original = { schema: 'sd2-release-guard-build-tail-proof.v1', engine: m.engine, runId,
    taskId: m.operation.taskId, attemptId: runId, manifestSha256, originalCompiledSnapshotUnavailable: true,
    ...processor('/isolated-reader/tail'), request, originalBuild: { startedAt: start, finishedAt: start + 10000, build: 'original-build' } };
  const originalFile = stage + '/original-tail.json', continuationSha256 = put(originalFile, original);
  const retry = { ...original, schema: 'sd2-release-guard-build-tail-retry-proof.v1',
    ...processor('/isolated-reader/predecessor'), originalContinuationSha256: continuationSha256,
    originalProofFile: originalFile, observedAt: new Date(start + 20000).toISOString() };
  const retryFile = stage + '/retry-tail.json', retrySha256 = put(retryFile, retry);
  const runtime = { schema: 'sd2-release-guard-build-tail-runtime.v1', phase: 'verify', proofFile: originalFile,
    continuationSha256, proof: original, retry: { schema: 'sd2-release-guard-build-tail-retry-runtime.v1', proofFile: retryFile, proofSha256: retrySha256, proof: retry } };
  const receipts = {}, candidateRecords = {}, successfulArtifacts = {};
  for (const role of ['main', 'guard']) {
    const receipt = { schema: role === 'guard' ? GUARD_BUILD_TAIL_SCHEMA : 'rate-impl2-candidate-build.v1',
      engine: m.engine, operation: m.operation, runId, label: role, source: m[role].source, version: m[role].version,
      exitCode: 0, verifiedSourceAndGates: true, startedAt: start, finishedAt: start + 10000, build: 'original-build' };
    if (role === 'guard') Object.assign(receipt, { helperProbePhase: 'prepare', logSha256: request.buildLogSha256,
      compiledTreeSha256: request.observedCompiledTreeSha256, tailPostchecks: { schema: 'sd2-guard-build-tail-seal.v1',
        continuationSha256, proofFile: originalFile, retryProofSha256: retrySha256, retryProofFile: retryFile,
        retainedOriginalCommand: true, originalCompiledSnapshotUnavailable: true, originalBuildCommandSha256: request.buildCommandSha256,
        observedAt: start + 20000, expiresAt: start + 20000 + 1800000 } });
    const receiptFile = stage + '/' + role + '-build.json', receiptSha256 = put(receiptFile, receipt);
    const snapshot = Object.fromEntries(['sourceFiles', 'lock', 'dependencies', 'build', 'checks', 'buildEnvironment', 'node', 'env', 'bindings'].map(name => [name, { synthetic: name }]));
    const capsule = { kind: role, sourceRun: runId, originalManifestSha256: manifestSha256, originalReceiptFile: receiptFile,
      originalReceiptSha256: receiptSha256, originalReceipt: receipt, originalTimesChanged: false, newCompilationClaimed: false,
      originalSourceManifestSha256: put(m[role].sourceManifest, 'source:' + role),
      originalPreparedSha256: put(stage + '/' + role + '-prepared.json', 'prepared:' + role), snapshot };
    const capsuleFile = stage + '/' + role + '-immutable-success.json', capsuleSha256 = put(capsuleFile, capsule);
    candidateRecords[role] = { capsuleFile, capsuleSha256, receiptFile, receiptSha256, snapshotSha256: sha(JSON.stringify(snapshot)) };
    successfulArtifacts[role] = { inputs: { capsule: { file: capsuleFile, sha256: capsuleSha256 }, build: { file: receiptFile, sha256: receiptSha256 } } };
    receipts[role] = receipt;
  }
  const mainHead = '1'.repeat(64), takeoverHead = '2'.repeat(64), readerHead = '3'.repeat(64);
  const readerIdentity = processor('/isolated-reader/reader');
  const reader = { ...readerIdentity, schema: 'sd2-release-reader-successor-proof.v1', engine: m.engine, runId,
    taskId: m.operation.taskId, attemptId: runId, manifestSha256, originalContinuationSha256: continuationSha256,
    originalProofFile: originalFile, retryProofSha256: retrySha256, retryProofFile: retryFile,
    predecessorProcessor: retry.processor, buildAuthority: false, observedAt: new Date(now).toISOString(), eventHeadSha256: takeoverHead,
    previousOwner, previousLeaseSha256: '4'.repeat(64), successfulArtifacts,
    request: { eventHeadSha256: mainHead, predecessorControllerSetSha256: retry.processor.controllerSetSha256,
      processorControllerSetSha256: readerIdentity.processor.controllerSetSha256, originalContinuationSha256: continuationSha256, retryProofSha256: retrySha256 } };
  const readerBytes = Buffer.from(JSON.stringify(reader)), readerSha256 = sha(readerBytes);
  const readerFile = taskRoot + '/attempts/' + runId + '/reader-successor-' + readerSha256 + '.json'; put(readerFile, readerBytes);
  runtime.reader = { schema: 'sd2-release-reader-successor-runtime.v1', proofFile: readerFile, proofSha256: readerSha256, proof: reader };
  const observation = { schema: 'sd2-release-candidate-observation-proof.v1', engine: m.engine, runId,
    taskId: m.operation.taskId, attemptId: runId, manifestSha256, originalContinuationSha256: continuationSha256,
    retryProofSha256: retrySha256, readerProofSha256: readerSha256, eventHeadSha256: takeoverHead, observedAt: now - 1, expiresAt: now - 1 + 1800000,
    verifier: { file: retry.processor.root + '/candidate-reuse.mjs', sha256: retry.processorControllers['candidate-reuse.mjs'],
      method: 'verifyOriginalSuccess', startedAt: now - 10, finishedAt: now - 1 },
    protectionComparison: 'assertProtection', protectionFields: ['databaseIdentity', 'files', 'marker', 'otherServices', 'settingsSha256', 'protectedTasks', 'protectedFailedVideo'],
    protectionSha256: '5'.repeat(64), candidates: candidateRecords, readOnly: true, newCompilationClaimed: false,
    originalTimesChanged: false, continuousUnchangedIntervalClaimed: false };
  const observationBytes = Buffer.from(JSON.stringify(observation)), observationSha256 = sha(observationBytes);
  const observationFile = taskRoot + '/attempts/' + runId + '/candidate-observation-' + observationSha256 + '.json'; put(observationFile, observationBytes);
  runtime.candidateObservation = { schema: 'sd2-release-candidate-observation-runtime.v1', proofFile: observationFile, proofSha256: observationSha256, proof: observation };
  const events = [
    { sha256: mainHead, value: { kind: 'phase_result', phase: 'main-build', outcome: 'succeeded', sequence: 1 } },
    { sha256: takeoverHead, value: { kind: 'owner_takeover', sequence: 2, previousSha256: mainHead, owner, previousOwner, previousLeaseSha256: reader.previousLeaseSha256 } },
    { sha256: readerHead, value: { kind: 'observation', name: 'reader_successor', sequence: 3, previousSha256: takeoverHead, owner,
      value: { schema: 'sd2-release-reader-successor-reference.v1', proofFile: readerFile, proofSha256: readerSha256 } } },
    { sha256: '6'.repeat(64), value: { kind: 'observation', name: 'candidate_observation', sequence: 4, previousSha256: readerHead, owner,
      value: { schema: 'sd2-release-candidate-observation-reference.v1', proofFile: observationFile, proofSha256: observationSha256 } } },
  ];
  const namespace = { assert: sameAssert, path, Buffer, JSON, Date, sha,
    fs: { readdirSync: root => { assert.ok(controllerSets.has(root)); return controllerNames; } },
    isSharedEngine: () => true, engineDirectory: value => { assert.equal(value, m); return m.engine.root; },
    rootFile: file => { assert.ok(documents.has(file), 'Unknown isolated root document: ' + file); return documents.get(file); },
    currentReleaseContext: () => ({ contract: { engine: m.engine, operation: m.operation }, guardBuildTail: runtime }),
    readAttempt: options => { assert.deepEqual(copy(options), { root: m.projectRoot + '/release-tasks', taskId: m.operation.taskId, attemptId: runId });
      return { headCurrent: true, derivedState: { status: 'running', activePhase: null, guardBuildTailRetry: { status: 'completed' } }, events }; },
    fixtureHere: reader.processor.root };
  const here = 'path.dirname(fileURLToPath(import.meta.url))';
  assert.equal(sources['candidate-evidence.mjs'].split(here).length, 2);
  vm.runInNewContext(scriptBody(sources['candidate-evidence.mjs']).replace(here, 'fixtureHere')
    + '\nglobalThis.api={guardBuildTailRuntime,assertCandidateObservation,assertFreshCandidateEvidence,candidateEvidenceExpiresAt,candidateGateObservation};', namespace);
  const api = namespace.api;
  for (const kind of ['main', 'guard']) {
    assert.deepEqual(copy(api.assertFreshCandidateEvidence(receipts[kind], m, kind, now)), receipts[kind]);
    assert.equal(api.candidateEvidenceExpiresAt(receipts[kind], m, kind, now), observation.expiresAt);
    const bound = api.candidateGateObservation(receipts[kind], m, kind, now);
    assert.equal(bound.observedAt, observation.observedAt); assert.equal(bound.candidateObservation.proofSha256, observationSha256);
    assert.equal(receipts[kind].startedAt, start); assert.equal(receipts[kind].finishedAt, start + 10000);
  }
  add('reader_independent_observation_admits_exact_old_main_and_guard_without_changing_original_times');
  const rejects = (name, change, restore, action = () => api.assertFreshCandidateEvidence(receipts.main, m, 'main', now)) => {
    change(); try { assert.throws(action); } finally { restore(); } add('reader_observation_refuses_' + name);
  };
  rejects('reader_authorization_alone_does_not_extend_old_validity', () => { delete runtime.candidateObservation; },
    () => { runtime.candidateObservation = { schema: 'sd2-release-candidate-observation-runtime.v1', proofFile: observationFile, proofSha256: observationSha256, proof: observation }; });
  assert.throws(() => api.assertFreshCandidateEvidence(receipts.main, m, 'main', observation.expiresAt), /expired/);
  add('reader_independent_observation_expires_at_its_own_fixed_thirty_minute_boundary');
  rejects('reader_build_authority', () => { runtime.phase = 'main-build'; }, () => { runtime.phase = 'verify'; });
  rejects('unbound_current_reader', () => { namespace.fixtureHere = retry.processor.root; }, () => { namespace.fixtureHere = reader.processor.root; });
  const originalController = documents.get(reader.processor.root + '/candidate-evidence.mjs');
  rejects('reader_controller_drift', () => put(reader.processor.root + '/candidate-evidence.mjs', 'changed'),
    () => documents.set(reader.processor.root + '/candidate-evidence.mjs', originalController));
  const originalReceipt = documents.get(candidateRecords.main.receiptFile);
  rejects('receipt_or_original_time_drift', () => put(candidateRecords.main.receiptFile, { ...receipts.main, startedAt: start + 1 }),
    () => documents.set(candidateRecords.main.receiptFile, originalReceipt));
  const originalCapsule = documents.get(candidateRecords.guard.capsuleFile);
  rejects('snapshot_or_source_drift', () => put(candidateRecords.guard.capsuleFile, 'changed snapshot'),
    () => documents.set(candidateRecords.guard.capsuleFile, originalCapsule));
  rejects('unbound_observation_journal', () => { events[3].value.previousSha256 = mainHead; }, () => { events[3].value.previousSha256 = readerHead; });
  traces.push({ successorReaderConsumers: true, productionAuthorizerRerun: false, originalBuildTimesRetained: true,
    observations: ['isolated protected root documents', 'isolated validated journal projection'], applicationDatabaseOpened: false });
}

const nativeTailBase = '/data/video-api-debugger-engineering';
assert.equal(fs.realpathSync('/data'), '/data');
const nativeTailData = fs.lstatSync('/data');
assert.ok(nativeTailData.isDirectory() && !nativeTailData.isSymbolicLink());
assert.notEqual(nativeTailData.dev, fs.statSync('/').dev, 'Native tail fixture requires the real separate data volume');
assert.equal(execFileSync('findmnt', ['-n', '-o', 'TARGET', '-T', '/data'], { encoding: 'utf8' }).trim(), '/data');
assert.equal(fs.realpathSync(nativeTailBase), nativeTailBase);
const nativeTailBaseStat = fs.lstatSync(nativeTailBase);
assert.ok(nativeTailBaseStat.isDirectory() && !nativeTailBaseStat.isSymbolicLink() && nativeTailBaseStat.uid === 0
  && (nativeTailBaseStat.mode & 0o7777) === 0o755 && nativeTailBaseStat.dev === nativeTailData.dev,
'Native tail fixture requires the existing protected root-owned data engineering base');
const nativeTailDirectory = fs.realpathSync(fs.mkdtempSync(nativeTailBase + '/sd2-native-tail-age-'));
fs.chmodSync(nativeTailDirectory, 0o711);
try {
  const uid = Number(execFileSync('id', ['-u', 'gouki'], { encoding: 'utf8' }).trim());
  const gid = Number(execFileSync('id', ['-g', 'gouki'], { encoding: 'utf8' }).trim());
  assert.ok(uid > 0 && gid > 0);
  const root = nativeTailDirectory + '/candidate', stage = nativeTailDirectory + '/root-stage';
  for (const file of [root, root + '/scripts', root + '/.role-tests']) {
    fs.mkdirSync(file, { mode: 0o700 }); fs.chownSync(file, uid, gid);
  }
  fs.mkdirSync(stage, { mode: 0o700 });
  const writeApp = (file, bytes) => { fs.writeFileSync(file, bytes, { mode: 0o600 }); fs.chownSync(file, uid, gid); };
  const entries = ['scripts/check-image-recovery.mjs', 'scripts/check-pricing-policy.mjs'];
  const frozenRoot = releaseDependencyRoot(MV_DIRECT), frozenSources = {}, ages = {};
  let nestedPricing;
  for (const entry of entries) {
    const bytes = fs.readFileSync(frozenRoot + '/' + entry, 'utf8'); frozenSources[entry] = sha(bytes);
    const parsed = ts.createSourceFile(entry, bytes, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    assert.equal(parsed.parseDiagnostics.length, 0);
    const verify = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'verify');
    assert.equal(verify.length, 1);
    const age = verify[0].body.statements.filter(node => node.getText(parsed).includes('Date.now() - value.startedAt'));
    assert.equal(age.length, 1); ages[entry] = age[0].getText(parsed);
    if (entry === entries[0]) {
      const spawn = verify[0].body.statements.filter(node => node.getText(parsed).startsWith('const pricing = spawnSync('));
      assert.equal(spawn.length, 1); nestedPricing = spawn[0].getText(parsed);
    }
  }
  const pricingFile = root + '/.role-tests/pricing.json', imageFile = root + '/.role-tests/image.json';
  const logFile = root + '/.role-tests/child.log'; writeApp(logFile, 'synthetic verifier-only child transcript\n');
  const logSha256 = sha(fs.readFileSync(logFile));
  const nativeSources = {};
  for (const entry of entries) {
    const image = entry === entries[0];
    const body = `import assert from 'node:assert/strict';import fs from 'node:fs';import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';
const root=fs.realpathSync(process.cwd()),pricingGate='scripts/check-pricing-policy.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const sources=()=>Object.fromEntries(${JSON.stringify(entries)}.map(file=>[file,hash(fs.readFileSync(root+'/'+file))]));
assert.equal(process.argv.length,6);assert.equal(process.argv[2],'--verify');assert.equal(process.argv[4],'--since');
const since=Number(process.argv[5]),value=JSON.parse(fs.readFileSync(process.argv[3]));
assert.equal(value.candidateRoot,root);assert.ok(value.startedAt>=since&&value.finishedAt>=value.startedAt&&value.finishedAt<=Date.now()+1000);
${ages[entry]}
assert.deepEqual(value.sourceSha256,sources());assert.equal(hash(fs.readFileSync(value.childLog)),value.childLogSha256);
${image ? nestedPricing + "\nassert.ifError(pricing.error);assert.equal(pricing.status,0,(pricing.stderr||'')+(pricing.stdout||''));process.stdout.write(pricing.stdout);" : ''}
console.log(${JSON.stringify(image ? 'Image recovery build gate verified (native verifier-only fixture)' : 'Pricing policy build gate verified (native verifier-only fixture)')});
`;
    writeApp(root + '/' + entry, body); nativeSources[entry] = sha(body);
  }
  const runId = randomUUID(), sourceId = 'f'.repeat(40), now = Date.now(), since = now - 7200000;
  const commonGate = { completed: true, candidateRoot: root, runId, startedAt: since + 1000, finishedAt: since + 2000,
    sourceSha256: nativeSources, childLog: logFile, childLogSha256: logSha256 };
  writeApp(pricingFile, JSON.stringify({ ...commonGate, schema: 'pricing-policy-build-gate.v1' }));
  writeApp(imageFile, JSON.stringify({ ...commonGate, schema: 'image-recovery-build-gate.v1', pricingReceipt: pricingFile }));
  const m = { stage, runId, appUser: 'gouki', guard: { root, source: sourceId } };
  const runtime = { schema: 'sd2-release-guard-build-tail-runtime.v1', phase: 'guard-build', continuationSha256: 'a'.repeat(64),
    proof: { runId, request: { observedAt: now - 7200000, imageGateReceiptSha256: sha(fs.readFileSync(imageFile)),
      pricingGateReceiptSha256: sha(fs.readFileSync(pricingFile)) },
      originalBuild: { startedAt: since, finishedAt: since + 10000, imageGateReceiptFile: imageFile, pricingGateReceiptFile: pricingFile } },
    retry: { proofSha256: 'b'.repeat(64), proof: { observedAt: now - 1 } } };
  let bound = true, nativeCalls = 0;
  const namespace = { assert, fs, path, Buffer, JSON, Date, process, createHash, pathToFileURL,
    execFileSync: (file, args, options) => { if (file === 'runuser') nativeCalls++; return execFileSync(file, args, options); },
    guardBuildTailRuntime: value => { assert.equal(value, m); return bound ? runtime : null; },
    assertGuardBuildTailObservation: (value, manifest, at) => { assert.equal(manifest, m);
      assert.equal(value.schema, GUARD_BUILD_TAIL_SCHEMA); assert.equal(value.tailPostchecks.continuationSha256, runtime.continuationSha256);
      assert.equal(value.tailPostchecks.expiresAt, value.tailPostchecks.observedAt + 1800000);
      assert.ok(at < value.tailPostchecks.expiresAt); } };
  vm.runInNewContext(scriptBody(sources['candidate-inputs.mjs'])
    + '\ncanonicalCandidate=(candidateRoot,source)=>{assert.equal(candidateRoot,' + JSON.stringify(root)
    + ');assert.equal(source,' + JSON.stringify(sourceId) + ');return candidateRoot;};globalThis.nativeVerify=verifyNativeGateReceipt;', namespace);
  const options = { candidateRoot: root, source: sourceId, runId, appUser: 'gouki', sourceFiles: nativeSources,
    entry: entries[0], receipt: imageFile, since, buildEnv: { PATH: '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', NODE_ENV: 'test' } };
  const tailContext = { manifest: m, runtime, observedAt: now };
  assert.throws(() => namespace.nativeVerify(options));
  assert.throws(() => namespace.nativeVerify({ ...options, entry: entries[1], receipt: pricingFile }));
  const output = namespace.nativeVerify({ ...options, tailContext });
  assert.match(output, /Image recovery build gate verified/); assert.match(output, /Pricing policy build gate verified/);
  assert.equal(JSON.parse(fs.readFileSync(imageFile)).startedAt, commonGate.startedAt);
  assert.equal(JSON.parse(fs.readFileSync(pricingFile)).finishedAt, commonGate.finishedAt);
  add('native_tail_two_exact_age_assertions_preserve_original_times_and_nested_pricing_verify_inheritance');
  const reject = (name, change, restore) => {
    const before = nativeCalls; change();
    try { assert.throws(() => namespace.nativeVerify({ ...options, tailContext })); }
    finally { restore(); }
    add('native_tail_refuses_' + name); return before;
  };
  reject('unbound_root_context', () => { bound = false; }, () => { bound = true; });
  assert.throws(() => namespace.nativeVerify({ ...options, tailContext: { ...tailContext, observedAt: now - 1800001 } }));
  assert.throws(() => namespace.nativeVerify({ ...options, entry: 'scripts/not-an-original-verifier.mjs', tailContext }));
  add('native_tail_expired_observation_and_unknown_entry_are_refused');
  const originalSource = fs.readFileSync(root + '/' + entries[1]);
  reject('source_drift', () => fs.appendFileSync(root + '/' + entries[1], '\n// drift'), () => fs.writeFileSync(root + '/' + entries[1], originalSource));
  const originalGate = fs.readFileSync(pricingFile);
  reject('receipt_time_drift', () => fs.writeFileSync(pricingFile, JSON.stringify({ ...JSON.parse(originalGate), startedAt: since + 2 })),
    () => fs.writeFileSync(pricingFile, originalGate));
  reject('child_log_drift', () => fs.appendFileSync(logFile, 'drift'), () => fs.writeFileSync(logFile, 'synthetic verifier-only child transcript\n'));
  reject('stale_retry_proof_observation', () => { runtime.retry.proof.observedAt = now - 1800001; }, () => { runtime.retry.proof.observedAt = now - 1; });
  const seal = { schema: GUARD_BUILD_TAIL_SCHEMA, tailPostchecks: { continuationSha256: runtime.continuationSha256,
    observedAt: now - 1000, expiresAt: now - 1000 + 1800000 } };
  fs.writeFileSync(stage + '/guard-build.json', JSON.stringify(seal), { mode: 0o600 });
  assert.throws(() => namespace.nativeVerify({ ...options, tailContext }));
  add('native_tail_sealed_observation_cannot_be_refreshed_on_later_verification');
  // The separately exercised production observation consumer supplies the root
  // authority here; these real Node calls prove transport into BOTH unchanged
  // native age checks, including the image verifier's pricing subprocess.
  const observation = { observedAt: now - 1, expiresAt: now - 1 + 1800000, candidates: {} };
  runtime.candidateObservation = { schema: 'sd2-release-candidate-observation-runtime.v1', proofSha256: 'c'.repeat(64), proof: observation };
  namespace.assertCandidateObservation = (value, manifest, kind, at) => {
    assert.equal(manifest, m); assert.deepEqual(value, JSON.parse(fs.readFileSync(stage + '/' + kind + '-build.json')));
    assert.ok(at < observation.expiresAt); return observation;
  };
  const observedContext = { manifest: m, runtime, observedAt: observation.observedAt, candidateObservation: runtime.candidateObservation };
  for (const kind of ['main', 'guard']) {
    if (kind === 'main') { m.main = { root, source: sourceId }; m.guard.root = nativeTailDirectory + '/unused-guard'; }
    else { delete m.main; m.guard.root = root; }
    const original = { schema: kind === 'guard' ? GUARD_BUILD_TAIL_SCHEMA : 'rate-impl2-candidate-build.v1',
      startedAt: since, finishedAt: since + 10000, gateReceipt: imageFile, tailPostchecks: { observedAt: since + 10000 } };
    fs.writeFileSync(stage + '/' + kind + '-build.json', JSON.stringify(original), { mode: 0o600 });
    const capsuleFile = stage + '/' + kind + '-immutable-success.json';
    const capsule = { snapshot: { checks: Object.fromEntries([imageFile, pricingFile].map(file =>
      [path.relative(root + '/.role-tests', file), { sha256: sha(fs.readFileSync(file)) }])) } };
    fs.writeFileSync(capsuleFile, JSON.stringify(capsule), { mode: 0o600 });
    observation.candidates[kind] = { capsuleFile };
    const verified = namespace.nativeVerify({ ...options, tailContext: observedContext });
    assert.match(verified, /Image recovery build gate verified/); assert.match(verified, /Pricing policy build gate verified/);
    assert.equal(JSON.parse(fs.readFileSync(stage + '/' + kind + '-build.json')).startedAt, since);
    add('native_independent_observation_' + kind + '_retains_original_receipt_and_nested_pricing');
    delete capsule.snapshot.checks[path.relative(root + '/.role-tests', pricingFile)];
    fs.writeFileSync(capsuleFile, JSON.stringify(capsule));
    assert.throws(() => namespace.nativeVerify({ ...options, tailContext: observedContext }), /complete check snapshot/);
    add('native_independent_observation_' + kind + '_requires_exact_bound_pricing_check_hash');
  }
  assert.throws(() => namespace.nativeVerify({ ...options, tailContext: { ...observedContext, observedAt: now } }));
  const savedExpiry = observation.expiresAt; observation.expiresAt = now - 1;
  assert.throws(() => namespace.nativeVerify({ ...options, tailContext: observedContext })); observation.expiresAt = savedExpiry;
  add('native_independent_observation_cannot_refresh_bound_time_or_use_expired_authority');
  traces.push({ nativeTailVerifierOnly: true, frozenVerifierSourceSha256: frozenSources, exactNativeAgeStatements: ages,
    nativeSubprocesses: nativeCalls, completeOriginalBusinessGatesRerun: false, applicationDatabaseOpened: false });
} finally { fs.rmSync(nativeTailDirectory, { recursive: true, force: true }); }
for (const invalid of [NaN, Infinity, 1.5, '2026-02-30T00:00:00Z', '2026-10-21', '1792590000000'])
  assert.ok(Number.isNaN(parseReleaseTimestamp(invalid)));
add('shared-approval-time-parser-rejects-invalid-or-ambiguous-values');
console.log(JSON.stringify({ schema: 'sd2-first-publication-lifecycle-engineering.v1', completed: true, cases, count: cases.length, traces,
  sourceSha256: Object.fromEntries(Object.entries(sources).map(([name, bytes]) => [name, sha(bytes)])),
  producerExpressionSha256: producerExpressions, backupProjectionChecks,
  actualFunctions: ['prepareReusedCandidate/verifyOriginalSuccess/verifyReusedCandidate', 'candidateInput/verifyBoth/switchPair/recoverFailedSwitch',
    'buildPair/publishPricingStartPair/markPricingWriterStartIntent', 'armGuardRecovery/readGuardRecovery/runGuardRecovery/markFixedGuardStart',
    'adoptOriginalMigration/readMigrationEvidence/roleStartContract', 'assertNaturalExitEvidence/assertUsageRoleStart',
    'prepareCandidate.result/buildCandidate.proof AST expressions', 'verifyCandidate/inputs/sourceCheck/runtimeBindings/compiledTree/verifyGates',
    'verifyPricingInputs/verifyPricingGateReceipt', 'HD candidateInputs/verifyHdCandidateResolver', 'proof'],
  boundary: 'One connected synthetic first-publication lifecycle with actual production orchestration and evidence consumers. Native service/network/DB observations are explicit isolated adapters, not a live switch, production rollback drill or functional acceptance.',
  syntheticNativeObservations: ['data-volume/layout', 'compiler artifact', 'pricing bootstrap/empty DB header',
    'native gate subprocess outputs', 'upload/HD helper execution', 'schema DB read', 'service/network/health'],
  productionWrites: 0, liveServiceCalls: 0, networkRequests: 0, browserRuns: 0, newCompilationClaimed: false }));
