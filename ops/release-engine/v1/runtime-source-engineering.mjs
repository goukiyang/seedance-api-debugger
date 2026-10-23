import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { rootFile, validateManifest, engineDirectory, isSharedEngine } from './common.mjs';
import { MV_DIRECT } from './release-contract.mjs';
import { captureRuntimeSourceContracts, assertCapturedLive } from './release.mjs';
import { captureLegacySourceContract, LEGACY_SOURCE_FILES } from './legacy-maintenance.mjs';
import { captureHdLegacyContract } from './switch.mjs';
import { readPublishedBaselineSourceFiles, assertCurrentPublishedBaseline } from './deployed-usage-schema.mjs';

assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
const m = validateManifest(JSON.parse(rootFile(process.argv[2])));
assert.equal(process.argv[2], m.stage + '/manifest.json');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const sameAssert = { ...assert, deepEqual: (a, b, message) => assert.deepEqual(clone(a), clone(b), message) };
const require = createRequire(m.live.web.root + '/package.json'), ts = require('typescript');
const sources = Object.fromEntries(['legacy-maintenance.mjs', 'release.mjs', 'switch.mjs']
  .map(file => [file, fs.readFileSync(new URL('./' + file, import.meta.url), 'utf8')]));
const checks = [];
function parsed(source) {
  const tree = ts.createSourceFile('source.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(tree.parseDiagnostics.length, 0); return tree;
}
function body(source) {
  const tree = parsed(source), edits = [];
  for (const statement of tree.statements) {
    if (ts.isImportDeclaration(statement)) edits.push([statement.getStart(tree), statement.end, '']);
    else for (const modifier of statement.modifiers || [])
      if (modifier.kind === ts.SyntaxKind.ExportKeyword) edits.push([modifier.getStart(tree), modifier.end, '']);
  }
  for (const [start, end, text] of edits.sort((a, b) => b[0] - a[0])) source = source.slice(0, start) + text + source.slice(end);
  return source;
}
function declaration(name, file = 'release.mjs') {
  const source = sources[file], tree = parsed(source);
  const node = tree.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node); return node.getText(tree).replace(/^export /, '');
}
const adoptionImports = parsed(sources['release.mjs']).statements.filter(node => ts.isImportDeclaration(node)
  && node.moduleSpecifier.text === './multiview-works-control.mjs');
assert.equal(adoptionImports.length, 1);
assert.deepEqual(adoptionImports[0].importClause.namedBindings.elements.map(node => {
  assert.equal(node.propertyName, undefined); return node.name.text;
}), ['inspectInstalledMultiviewRecipeAdoption']);
const captureText = declaration('capture');
assert.match(captureText, /if \(m\.recoveredGuardBaseline\?\.schema === 'sd2-multiview-r17-recovered-guard\.v1'\) inspectInstalledMultiviewRecipeAdoption\(m\);/);
assert.ok(captureText.indexOf('inspectInstalledMultiviewRecipeAdoption(m)') > captureText.indexOf("writeJsonExclusive(stage + '/manifest.json', m)"));
assert.ok(captureText.indexOf('inspectInstalledMultiviewRecipeAdoption(m)') < captureText.indexOf('const before = readProtection(m)'));
checks.push('r17_capture_real_import_and_readonly_adoption_call_are_wired_before_protection_capture');
function legacyWithIo(contract, mutate = (file, bytes) => bytes) {
  const io = { ...fs, readFileSync: (file, options) => {
    const value = mutate(file, fs.readFileSync(file));
    return typeof options === 'string' || options?.encoding ? value.toString(typeof options === 'string' ? options : options.encoding) : value;
  } };
  const context = { assert: sameAssert, fs: io, path, process, Date, Buffer, createHash,
    execFileSync: () => { throw Error('No native mutation in source fixture'); },
    MV_DIRECT: contract, readPublishedBaselineSourceFiles };
  vm.runInNewContext(body(sources['legacy-maintenance.mjs'])
    + '\nglobalThis.api={captureLegacySourceContract,captureLegacyWriterContracts};', context);
  return context.api;
}
function runtimeWithLegacy(legacy, hd = captureHdLegacyContract) {
  const context = { captureLegacyWriterContracts: legacy.captureLegacyWriterContracts, captureHdLegacyContract: hd };
  vm.runInNewContext(declaration('captureRuntimeSourceContracts') + '\nglobalThis.run=captureRuntimeSourceContracts;', context);
  return context.run;
}
function hdWithIo(contract, mutate = (file, bytes) => bytes) {
  const tree = parsed(sources['switch.mjs']);
  const constants = tree.statements.find(item => ts.isVariableStatement(item)
    && item.declarationList.declarations.some(value => value.name.getText(tree) === 'HD_LEGACY_FILES'));
  assert.ok(constants);
  const context = { assert: sameAssert, MV_DIRECT: contract, readPublishedBaselineSourceFiles, path, sha,
    regularBytes: file => mutate(file, fs.readFileSync(file)) };
  vm.runInNewContext(constants.getText(tree) + '\n' + declaration('captureHdLegacyContract', 'switch.mjs')
    + '\nglobalThis.run=captureHdLegacyContract;', context);
  return context.run;
}

// This is the same production helper called by capture(), with the real locked
// manifest/history/source bytes. No service adapter supplies a source verdict.
const actual = captureRuntimeSourceContracts(m);
assert.equal(actual.legacy.length, new Set([m.live.web.root, m.live.image.root]).size);
checks.push('actual_stage_source_helper_accepts_current_exact_baseline');
const target = 'src/app/api/assets/generate/route.ts', targetFile = m.live.web.root + '/' + target;
const changed = legacyWithIo(MV_DIRECT, (file, bytes) => file === targetFile ? Buffer.concat([bytes, Buffer.from('\n// changed')]) : bytes);
assert.throws(() => changed.captureLegacySourceContract({ legacyRoot: m.live.web.root, manifest: m }));
const missing = legacyWithIo(MV_DIRECT, (file, bytes) => {
  if (file === targetFile) { const error = new Error('Missing source'); error.code = 'ENOENT'; throw error; }
  return bytes;
});
assert.throws(() => missing.captureLegacySourceContract({ legacyRoot: m.live.web.root, manifest: m }));
assert.throws(() => legacyWithIo(MV_DIRECT, (file, bytes) => file === m.live.web.root + '/.deployed-commit'
  ? Buffer.from('0'.repeat(40)) : bytes).captureLegacySourceContract({ legacyRoot: m.live.web.root, manifest: m }));
checks.push('changed_marker_changed_or_missing_source_bytes_rejected');
const hdFile = m.live.hd.root + '/scripts/process-hd-derivatives.ts';
const changedHd = hdWithIo(MV_DIRECT, (file, bytes) => file === hdFile ? Buffer.concat([bytes, Buffer.from('\n// changed')]) : bytes);
assert.throws(() => changedHd(m));
assert.throws(() => hdWithIo(MV_DIRECT, (file, bytes) => {
  if (file === hdFile) throw new Error('Missing HD source'); return bytes;
})(m));
checks.push('hd_source_hash_checks_reject_changed_and_missing_bytes');

if (m.deployedUsageSchema) {
  const files = Object.keys(LEGACY_SOURCE_FILES);
  const published = readPublishedBaselineSourceFiles(m, files);
  const differences = files.filter(file => published.sourceFiles[file] !== LEGACY_SOURCE_FILES[file]);
  if (m.live.web.source === '9c39aeb7de06c3c9e676477febf214c089cb9727') assert.equal(differences.length, 5);
  for (const file of files) assert.equal(sha(fs.readFileSync(m.live.web.root + '/' + file)), published.sourceFiles[file]);
  assert.equal(actual.legacy[0].publishedBaseline.publicationRun, m.deployedUsageSchema.publicationRun);
  checks.push('legitimate_changed_baseline_uses_pinned_published_pair_not_fresh_hash_trust');
  assert.throws(() => readPublishedBaselineSourceFiles(m, ['src/not-in-published-source.ts']));
  assert.throws(() => readPublishedBaselineSourceFiles(m, ['../escape']));
  for (const key of ['publicationManifestSha256', 'switchCompleteSha256', 'finalProofSha256', 'finalProofCommandSha256']) {
    const bad = clone(m); bad.deployedUsageSchema[key] = '0'.repeat(64);
    assert.throws(() => readPublishedBaselineSourceFiles(bad, files));
    assert.throws(() => captureLegacySourceContract({ legacyRoot: m.live.web.root, manifest: bad }));
  }
  checks.push('missing_evidence_field_path_escape_and_forged_history_pins_rejected');
  // The old migration's live source remains protected history. Read it without
  // changing markers, copying code or pretending it is the current baseline.
  const oldManifest = JSON.parse(rootFile('/data/video-api-debugger/release-staging/'
    + m.deployedUsageSchema.migrationRun + '/manifest.json'));
  const old = oldManifest.live.web;
  const oldContract = { ...MV_DIRECT, baselineSource: old.source, deployedUsageSchema: null };
  const oldCapture = legacyWithIo(oldContract).captureLegacySourceContract({ legacyRoot: old.root });
  assert.deepEqual(clone(oldCapture.sourceFiles), LEGACY_SOURCE_FILES);
  assert.equal(oldCapture.source, old.source);
  assert.equal(Object.hasOwn(oldCapture, 'publishedBaseline'), false);
  assert.throws(() => legacyWithIo(oldContract, (file, bytes) => file === old.root + '/' + target
    ? Buffer.concat([bytes, Buffer.from('\n// changed')]) : bytes).captureLegacySourceContract({ legacyRoot: old.root }));
  hdWithIo(oldContract)({ ...oldManifest, deployedUsageSchema: null });
  checks.push('original_static_source_behavior_retained_with_actual_historical_bytes');
}

// Run the actual capture() body up to the first mutating boundary. Only service,
// archive and filesystem observations are isolated; source checks run unchanged.
async function stageCapture(sourceCapture, expectSourceFailure = false) {
  const stop = new Error('fixture reached upload preparation boundary');
  const counters = { sources: 0, uploads: 0, writes: 0, recoveredAdmission: 0 }, imports = [], seedFile = m.stage + '/seed.json';
  const seed = { runId: m.runId, mainSource: m.mainSource, guardSource: m.guardSource,
    expectedAllowedSha256: MV_DIRECT.expectedAllowedSha256,
    ...(isSharedEngine(m) ? { engine: m.engine, operation: m.operation } : {}) };
  const fixtureRootFile = file => {
    if (file === seedFile) return Buffer.from(JSON.stringify(seed));
    for (const kind of ['main', 'guard']) {
      if (file === m.stage + '/' + kind + '/source-manifest.json') return Buffer.from(JSON.stringify({
        kind, source: m[kind].source, version: m[kind].version, archiveSha256: sha('isolated archive') }));
      if (file === m.stage + '/' + kind + '/source.tar.gz') return Buffer.from('isolated archive');
    }
    return rootFile(file);
  };
  const io = { realpathSync: file => file, existsSync: fs.existsSync, readFileSync: () => Buffer.from('isolated protected observation'),
    readdirSync: () => Object.keys(m.privateSha256) };
  const context = { assert: sameAssert, fs: io, path, process, Date, Buffer, Object, JSON,
    directory: engineDirectory(m), protectedTaskIds: m.protectedTaskIds, MV_DIRECT,
    assertMvDirectReady: () => assert.equal(MV_DIRECT.sourceReady, true),
    rootFile: fixtureRootFile, sha, call: () => '/data', protectedDirectory: () => {},
    liveInfo: name => m.live[Object.keys(m.live).find(role => m.live[role].unit === name)],
    assertCapturedLive, validateManifest: value => {
      assert.equal(value.runId, m.runId); assert.deepEqual(clone(value.live), clone(m.live)); return m;
    },
    APPROVED_HD_LEGACY_READY: m.hdLegacyReady, APPROVED_HD_HISTORICAL_VERSIONS: m.hdHistoricalVersions,
    assertReleaseWindow: () => {}, trustedCode: () => {},
    fixtureImport: async name => {
      imports.push(name);
      if (name === './deployed-usage-schema.mjs') return {
        assertCurrentPublishedBaseline: value => {
          assert.equal(value, m); counters.recoveredAdmission++;
          return assertCurrentPublishedBaseline(value);
        },
      };
      assert.equal(name, './pricing-start-pair.mjs');
      return { capturePricingStartControl: () => ({ allowed: { sha256: seed.expectedAllowedSha256 } }) };
    },
    captureRuntimeSourceContracts: value => { counters.sources++; assert.equal(value, m); return sourceCapture(value); },
    inspectInstalledMultiviewRecipeAdoption: () => assert.fail('Installed-state read is after this fixture mutating boundary'),
    prepareUploadPrivateDirectory: () => { counters.uploads++; throw stop; },
    verifyUploadPrivateDirectory: () => assert.fail('No post-boundary operation allowed'),
    readProtection: () => assert.fail('No post-boundary operation allowed'),
    writeJsonExclusive: () => { counters.writes++; assert.fail('No fixture publication writes'); },
  };
  let code = declaration('capture'), tree = parsed(code), edits = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      edits.push([node.expression.getStart(tree), node.expression.end]);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  for (const [start, end] of edits.sort((a, b) => b[0] - a[0])) code = code.slice(0, start) + 'fixtureImport' + code.slice(end);
  vm.runInNewContext(code + '\nglobalThis.run=capture;', context);
  await assert.rejects(context.run(seedFile), error => expectSourceFailure ? error !== stop : error === stop);
  assert.equal(counters.sources, 1); assert.equal(counters.uploads, expectSourceFailure ? 0 : 1); assert.equal(counters.writes, 0);
  assert.equal(counters.recoveredAdmission, m.recoveredGuardBaseline ? 1 : 0);
  assert.deepEqual(imports, ['./pricing-start-pair.mjs', ...(m.recoveredGuardBaseline ? ['./deployed-usage-schema.mjs'] : [])]);
  await assert.rejects(context.fixtureImport('./unknown-source-fixture.mjs'));
}
await stageCapture(captureRuntimeSourceContracts);
await stageCapture(runtimeWithLegacy(changed), true);
await stageCapture(runtimeWithLegacy(missing), true);
await stageCapture(runtimeWithLegacy(legacyWithIo(MV_DIRECT), changedHd), true);
checks.push('actual_capture_body_cannot_skip_source_checks_before_upload_or_manifest_writes');
checks.push('capture_only_imports_exact_pricing_and_recovered_source_modules_and_executes_real_recovery_admission_once');
// Keep switch admission connected to the same production source checks too.
const switchTree = parsed(sources['switch.mjs']);
const before = switchTree.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === 'captureSwitchBefore');
assert.ok(before);
const calls = [];
function visitCalls(node) {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.push(node.expression.text);
  ts.forEachChild(node, visitCalls);
}
visitCalls(before);
assert.ok(calls.includes('captureLegacyWriterContracts') && calls.includes('captureHdLegacyContract'));
checks.push('switch_premaintenance_capture_retains_same_source_checks');
console.log(JSON.stringify({ schema: 'sd2-runtime-source-engineering.v1', completed: true, checks, count: checks.length,
  sourceSha256: Object.fromEntries(Object.entries(sources).map(([file, bytes]) => [file, sha(bytes)])),
  currentSource: m.live.web.source, ioKind: 'actual-source-capture-and-stage-body-with-isolated-service-observations',
  servicesChanged: false, productionWrites: 0, paidRequests: 0, browserRuns: 0, functionalAcceptance: false }));
