import { FULL_SQL, assertFullReleaseContext, assertFullReleaseInput } from './release-engine/v1/full-release-contract.mjs';
import { LEGACY_CONTRACT } from './release-engine/v1/release-contract.mjs';
import { ENGINE_VERSION } from './release-engine/v1/engine-version.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertCanvasBatchSchemaInput, assertCanvasBatchPrismaExtension, CANVAS_BATCH_SQL, CANVAS_BATCH_MIGRATOR, CANVAS_BATCH_MODE } from './canvas-video-batch-schema-extension.mjs';

const require = createRequire(import.meta.url);
// Full JSON preparation needs no installed application dependencies. Legacy AST
// template operations resolve their existing TypeScript runtime only when used.
const ts = new Proxy({}, { get(_target, key) { return require('typescript')[key]; } });
const here = path.dirname(fileURLToPath(import.meta.url));
export const profile = JSON.parse(fs.readFileSync(path.join(here, 'sd2-release-profile.json')));
const digest = value => createHash('sha256').update(value).digest('hex');
const sha = /^[a-f0-9]{40}$/, sha256 = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const REUSE_SCHEMA = 'sd2-candidate-build-reuse.v1';
export const CONTINUATION_V2 = 'sd2-normal-continuation-input.v2';
export const UNPUBLISHED_PAIR = Object.freeze({
  run: 'e6044ae3-4f29-4dfd-8f12-93a94cdfa9ff',
  manifestSha256: '9ce497c4318e25234c251b2a96d2795523d4d8dd37cb81600313e29ab93d030a',
  main: { source: '4fb7f841ec05f38759bede3e3b4bea73e19c027f', version: '0.102.2', build: 'qwBCyuUR2RcM8M-vL8KoV',
    sha256: '9bac43895caf236770eda2f7f71ffc45dc567277f573ee3e48ccba5c446f8496' },
  guard: { source: '4b1adbbab77c80449ec1a7fc326d59b28249e34b', version: '0.102.2+projects-design-guard.1', build: 'oNhpz_gPaennYmwMTqTBf',
    sha256: 'a5bd86c476f13cb1104e2dc21154c4d2a6f2d42cc67b0470cc975ba98d961a57' },
});
export function exactUnpublishedPlan(plan) {
  if (plan.reuseBuilds?.sourceRun !== UNPUBLISHED_PAIR.run) return false;
  assert.equal(plan.contract.normalContinuation, null);
  assert.notEqual(plan.contract.recoveryRunId, UNPUBLISHED_PAIR.run);
  assert.equal(plan.contract.mainSource, UNPUBLISHED_PAIR.main.source);
  assert.equal(plan.contract.recoveryGuardSource, UNPUBLISHED_PAIR.guard.source);
  for (const kind of ['main', 'guard']) assert.equal(plan.contract.versions[kind], UNPUBLISHED_PAIR[kind].version);
  return true;
}
export const CONTINUATION_COMMON_FIELDS = ['schema', 'chainId', 'attempt', 'sourceRun', 'sourceManifestSha256',
  'beforeSha256', 'approvalSha256', 'refusalSha256', 'lineageSha256'];
export function assertContinuationInput(value) {
  assert.ok(['sd2-normal-continuation-input.v1', CONTINUATION_V2].includes(value.schema), 'Unknown normal continuation schema');
  const migration = value.schema === 'sd2-normal-continuation-input.v1';
  keys(value, [...CONTINUATION_COMMON_FIELDS, ...(migration
    ? ['migrationRun', 'migrationManifestSha256', 'migrationReceiptSha256', 'backupProofSha256'] : [])]);
  for (const key of ['chainId', 'sourceRun', ...(migration ? ['migrationRun'] : [])]) assert.match(value[key], uuid);
  for (const key of Object.keys(value).filter(key => key.endsWith('Sha256'))) assert.match(value[key], sha256);
  assert.ok(Number.isSafeInteger(value.attempt) && value.attempt > 1);
  return value;
}
export const DEPLOYED_SCHEMA = 'sd2-deployed-usage-schema-input.v1';
export const DEPLOYED_FIELDS = ['schema', 'publicationRun', 'publicationManifestSha256', 'switchCompleteSha256',
  'finalProofSha256', 'finalProofCommandSha256', 'migrationRun', 'migrationManifestSha256', 'migrationBeforeSha256',
  'migrationReceiptSha256', 'backupProofSha256', 'backupSha256'];
export const DEPLOYED_CANVAS_FIELDS = ['schema', 'migrationRun', 'migrationManifestSha256',
  'migrationReceiptSha256', 'backupProofSha256', 'backupSha256'];
export const R08_RECOVERED_GUARD = Object.freeze({
  schema: 'sd2-multiview-r08-recovered-guard.v1', runId: '7370f24f-6cba-42ae-9602-d49124f3abae',
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
  schema: 'sd2-multiview-r14-recovered-guard.v1',
  runId: '53c8aa71-6457-40ff-a913-b2bd3a4a2234',
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
export const PROTECTED_INCREMENT = Object.freeze({
  schema: 'sd2-protected-increment.v1', baselineSource: '31bff5a6544a3d18d433b81fa7735ed57b0d012c',
  pricingWrites: false, multiviewGeneration: false, canvasVideoBatchWrites: false,
  sizePolicyVersion: 2, diagnosticsSchema: 'image.provider-error.v1',
});
export const PROTECTED_INCREMENT_SOURCE_FILES = Object.freeze([
  'src/app/api/tasks/create/route.ts', 'src/lib/pricing/build-mode.ts', 'src/lib/canvas-video-batches-build-mode.ts',
  'src/lib/video/multiview-private-create.server.ts', 'src/lib/video/multiview-task-privacy.ts',
  'src/lib/video/multiview-recipe-storage.server.ts', 'scripts/install-multiview-private-recipe.ts',
  'scripts/backup-multiview-works.py',
]);
export function assertProtectedIncrement(value, context) {
  if (!value) return false;
  assert.deepEqual(value, PROTECTED_INCREMENT, 'Unknown or widened protected increment');
  assert.equal(context.baselineSource, PROTECTED_INCREMENT.baselineSource);
  assert.deepEqual(context.recoveredGuardBaseline, R17_RECOVERED_GUARD);
  assert.equal(context.privateMultiviewInstall, true);
  assert.ok(context.deployedUsageSchema && context.deployedCanvasBatchSchema && context.canvasVideoBatchSchema);
  assert.equal(context.normalContinuation || null, null); assert.equal(context.reuseBuilds || null, null);
  return true;
}
const RECOVERED_GUARD_PROGRAMS = Object.freeze([
  Object.freeze({ input: R08_RECOVERED_GUARD, source: 'c9f0a60d753b286db470626ad33c1987ff1c72bf',
    main: '4e1fe5b888c1fdb20a9cbccdd6517b84452fa604', build: 'B7Ef-SggrUGg4-T5FAA_0', rejectRecoveryHistory: false }),
  Object.freeze({ input: R10_RECOVERED_GUARD, source: '2c1eafbd875fceeca63ddfe0da0e08c15bb9cbb7',
    main: 'eae4475e5da2ebf3b68c31593a37117b59e6a09a', build: 'j2d9GY6_bj4uOIMROXnsi', rejectRecoveryHistory: true }),
  Object.freeze({ input: R14_RECOVERED_GUARD, source: 'e06d23538ea110a8c7800729bd8b84eaee697091',
    main: '08b5ce920384edb4f03199a058ca805561ac8fe5', build: 'UgLJVYXAPzAtIB-K4PnB3', rejectRecoveryHistory: true }),
  Object.freeze({ input: R17_RECOVERED_GUARD, source: '31bff5a6544a3d18d433b81fa7735ed57b0d012c',
    main: 'd6c611d353b6f3da665993fe62a1a5b4dbe65f81', build: 'j0osjBFM7wvoP8iAYEknx', rejectRecoveryHistory: true }),
]);
function assertRecoveredGuardInput(value) {
  const program = RECOVERED_GUARD_PROGRAMS.find(entry => entry.input.schema === value?.schema);
  assert.ok(program, 'Unknown recovered guard baseline');
  assert.deepEqual(value, program.input, 'Only the exact retained R08/c9, R10/2c, R14/e06 or R17/31b recovery may supply the live baseline');
  return program;
}
export function assertDeployedCanvasInput(value) {
  keys(value, DEPLOYED_CANVAS_FIELDS);
  assert.equal(value.schema, 'sd2-deployed-canvas-video-batch-schema-input.v1');
  assert.match(value.migrationRun, uuid);
  for (const key of DEPLOYED_CANVAS_FIELDS.filter(key => key.endsWith('Sha256'))) assert.match(value[key], sha256);
  return value;
}
const read = file => {
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'Expected an ordinary single-link file: ' + file);
  return fs.readFileSync(file);
};
const json = file => JSON.parse(read(file));
const keys = (object, expected) => assert.deepEqual(Object.keys(object).sort(), [...expected].sort(), 'Unexpected or missing input fields');
const git = (repo, args) => execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', repo, ...args], {
  encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 ** 2,
  env: { PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', LANG: 'C', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
}).trim();
const moduleFiles = directory => Object.fromEntries(fs.readdirSync(directory).filter(file => file.endsWith('.mjs')).sort()
  .map(file => [file, read(path.join(directory, file))]));
const hashes = files => Object.fromEntries(Object.entries(files).map(([file, bytes]) => [file, digest(bytes)]));

export function verifyTemplate(materialsRoot, { originalOnly = false } = {}) {
  assert.equal(profile.schema, 'sd2-release-profile.v1');
  const base = fs.realpathSync(materialsRoot);
  const files = moduleFiles(path.join(base, profile.template));
  assert.equal(Object.keys(files).length, profile.controllerCount);
  assert.equal(digest(JSON.stringify(hashes(files))), profile.controllerSetSha256, 'Controller template changed; review and promote a new profile, never edit the frozen run');
  const wrapper = read(path.join(base, profile.wrapper));
  assert.equal(digest(wrapper), profile.wrapperSha256);
  for (const [file, expected] of Object.entries(profile.evidence))
    assert.equal(digest(read(path.join(base, profile.successfulRun, file))), expected, 'Original success evidence changed: ' + file);
  assert.deepEqual(json(path.join(base, profile.successfulRun, 'control-freeze.json')).privateSha256, hashes(files));
  if (!profile.promotion || originalOnly) return { base, files, wrapper: wrapper.toString('utf8'), templateName: profile.template };
  const promoted = profile.promotion;
  keys(promoted, ['template', 'wrapper', 'controllerCount', 'controllerSetSha256', 'wrapperSha256', 'changed', 'added',
    ...(Object.hasOwn(promoted, 'root') ? ['root'] : [])]);
  for (const value of [promoted.template, promoted.wrapper]) assert.ok(path.basename(value) === value && !value.includes('..'));
  let promotedBase = base;
  if (Object.hasOwn(promoted, 'root')) {
    assert.ok(typeof promoted.root === 'string' && promoted.root.length > 0);
    assert.ok(path.isAbsolute(promoted.root));
    promotedBase = fs.realpathSync(promoted.root);
    assert.ok(promotedBase.startsWith(fs.realpathSync('/Volumes/Data/Projects/video-api-debugger/docs/materials') + path.sep));
  }
  const promotedFiles = moduleFiles(path.join(promotedBase, promoted.template));
  assert.equal(Object.keys(promotedFiles).length, promoted.controllerCount);
  assert.equal(digest(JSON.stringify(hashes(promotedFiles))), promoted.controllerSetSha256, 'Promoted controller differs from review');
  assert.deepEqual(Object.keys(promotedFiles).filter(file => !Object.hasOwn(files, file)).sort(), [...promoted.added].sort());
  assert.deepEqual(Object.keys(files).filter(file => !promotedFiles[file]?.equals(files[file])).sort(), [...promoted.changed].sort());
  const promotedWrapper = read(path.join(promotedBase, promoted.wrapper));
  assert.equal(digest(promotedWrapper), promoted.wrapperSha256);
  return { base: promotedBase, files: promotedFiles, wrapper: promotedWrapper.toString('utf8'), templateName: promoted.template,
    originalFiles: files, originalSuccessPreserved: true };
}

function parse(source) {
  const result = ts.createSourceFile('release.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(result.parseDiagnostics.length, 0, 'Invalid release JavaScript');
  return result;
}
function patchNodes(source, patches) {
  for (const { start, end, value } of patches.sort((a, b) => b.start - a.start))
    source = source.slice(0, start) + value + source.slice(end);
  parse(source);
  return source;
}
function literalObject(node) {
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literalObject);
  assert.ok(ts.isObjectLiteralExpression(node), 'Contract must contain static data only');
  const result = {};
  for (const property of node.properties) {
    assert.ok(ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)));
    const key = property.name.text;
    assert.ok(!Object.hasOwn(result, key) && !['__proto__', 'constructor', 'prototype'].includes(key));
    result[key] = literalObject(property.initializer);
  }
  return result;
}
export function contractData(source) {
  let object;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText() === 'MV_DIRECT') {
      assert.equal(node.initializer.expression.getText(), 'Object.freeze');
      assert.equal(node.initializer.arguments.length, 1);
      object = node.initializer.arguments[0];
    }
    ts.forEachChild(node, visit);
  }
  visit(parse(source)); assert.ok(object);
  return { object, value: literalObject(object) };
}

export function validatePlan(plan, original, now = Date.now()) {
  keys(plan, ['schema', 'repoRoot', 'outputRoot', 'liveCapture', 'contract', 'reuseBuilds',
    ...(Object.hasOwn(plan, 'deployedUsageProof') ? ['deployedUsageProof'] : [])]);
  assert.equal(plan.schema, 'sd2-release-plan.v1');
  for (const field of ['repoRoot', 'outputRoot']) assert.ok(path.isAbsolute(plan[field]));
  const c = plan.contract, live = plan.liveCapture;
  keys(c, [...Object.keys(original).filter(key => !['protectedIncrement', 'fullRelease'].includes(key)),
    ...(Object.hasOwn(c, 'protectedIncrement') ? ['protectedIncrement'] : []),
    ...(Object.hasOwn(c, 'fullRelease') ? ['fullRelease'] : [])]);
  const full = c.fullRelease ? assertFullReleaseContext(c) : null;
  if (full) assertRecoveredGuardInput(full.privateRecipeOrigin);
  if (c.protectedIncrement) {
    assertProtectedIncrement(c.protectedIncrement, { ...c, reuseBuilds: plan.reuseBuilds });
    assert.equal(plan.reuseBuilds, null);
  }
  keys(live, ['observedAt', 'source', 'version', 'build', 'starts', 'pricingRevision', 'allowedSha256']);
  const observed = Date.parse(live.observedAt);
  assert.ok(Number.isSafeInteger(observed) && observed <= now && now - observed <= 300000, 'Capture must be fresh; historical evidence is not current runtime');
  assert.equal(c.sourceReady, true); assert.equal(c.baselineReconciled, true);
  if (c.normalContinuation) {
    assertContinuationInput(c.normalContinuation);
    assert.notEqual(c.normalContinuation.sourceRun, c.recoveryRunId);
  }
  const continuationV2 = c.normalContinuation?.schema === CONTINUATION_V2;
  const exactUnpublished = exactUnpublishedPlan(plan);
  if (continuationV2) {
    assert.ok(c.deployedUsageSchema && c.deployedCanvasBatchSchema && c.canvasVideoBatchSchema && plan.reuseBuilds,
      'Continuation v2 requires both deployed schemas and the original full-build pair');
    assert.equal(plan.reuseBuilds.sourceRun, c.normalContinuation.sourceRun);
  } else assert.ok(!(c.normalContinuation && c.deployedUsageSchema), 'Schema adoption modes are mutually exclusive');
  if (c.canvasVideoBatchSchema) {
    assertCanvasBatchSchemaInput(c.canvasVideoBatchSchema);
    assert.ok(c.deployedUsageSchema, 'Additive canvas migration retains the deployed usage schema proof');
    if (!full && !continuationV2 && !exactUnpublished) assert.equal(plan.reuseBuilds, null, 'A new schema pair requires two complete fresh builds');
  }
  if (c.deployedCanvasBatchSchema) {
    assertDeployedCanvasInput(c.deployedCanvasBatchSchema);
    assert.ok(c.canvasVideoBatchSchema && c.deployedUsageSchema);
    if (!continuationV2) assert.equal(c.normalContinuation, null);
    assert.notEqual(c.deployedCanvasBatchSchema.migrationRun, c.recoveryRunId);
    if (!full && !continuationV2 && !exactUnpublished) assert.equal(plan.reuseBuilds, null, 'Deployed canvas adoption requires complete fresh main and guard builds');
  }
  if (c.deployedUsageSchema !== null && c.deployedUsageSchema !== undefined) {
    const value = c.deployedUsageSchema;
    keys(value, DEPLOYED_FIELDS); assert.equal(value.schema, DEPLOYED_SCHEMA);
    for (const key of ['publicationRun', 'migrationRun']) { assert.match(value[key], uuid); assert.notEqual(value[key], c.recoveryRunId); }
    for (const key of DEPLOYED_FIELDS.filter(key => key.endsWith('Sha256'))) assert.match(value[key], sha256);
    if (!full && !continuationV2 && !exactUnpublished) assert.equal(plan.reuseBuilds, null, 'A new deployed-schema pair requires complete fresh main and guard builds');
    keys(plan.deployedUsageProof, ['stdoutFile', 'commandReceiptFile']);
    for (const file of Object.values(plan.deployedUsageProof)) assert.ok(typeof file === 'string' && path.isAbsolute(file));
  } else {
    assert.equal(plan.deployedUsageProof || null, null, 'Historical proof payload is only valid in deployed-schema mode');
  }
  if (c.recoveredGuardBaseline) {
    const program = assertRecoveredGuardInput(c.recoveredGuardBaseline), recovered = program.input;
    assert.ok(c.deployedUsageSchema && c.deployedCanvasBatchSchema && c.privateMultiviewInstall);
    assert.equal(c.normalContinuation, null); assert.equal(plan.reuseBuilds, null);
    assert.notEqual(c.recoveryRunId, recovered.runId);
    assert.equal(c.baselineSource, program.source);
    assert.equal(c.sourceBase, c.baselineSource);
    assert.equal(c.baselineVersion, '0.103.0+multiview-private-guard.1');
    assert.equal(c.baselineBuild, program.build);
    for (const source of [c.mainSource, c.recoveryGuardSource])
      assert.ok(![program.main, program.source].includes(source), 'Recovered run builds cannot become a fresh pair');
    if (program.rejectRecoveryHistory) for (const key of ['publicationRun', 'migrationRun'])
      assert.notEqual(c.deployedUsageSchema[key], recovered.runId, 'A failed recovery cannot replace normal schema history');
    if (recovered === R14_RECOVERED_GUARD || recovered === R17_RECOVERED_GUARD) {
      assert.equal(c.privateMultiviewInstall, true);
      assert.equal(c.deployedUsageSchema.publicationRun, '6a041bed-c909-4370-972f-2299321d7f1f');
      assert.notEqual(c.deployedCanvasBatchSchema.migrationRun, recovered.runId, 'A failed recovery cannot replace canvas schema history');
    }
  }
  assert.match(c.recoveryRunId, uuid); assert.notEqual(c.recoveryRunId, profile.successfulRun);
  for (const key of ['mainSource', 'recoveryGuardSource', 'baselineSource', 'sourceBase', 'guardDisplaySource']) assert.match(c[key], sha);
  assert.notEqual(c.mainSource, c.recoveryGuardSource);
  for (const [key, current] of [['baselineSource', 'source'], ['baselineVersion', 'version'], ['baselineBuild', 'build'],
    ['pricingRevision', 'pricingRevision'], ['expectedAllowedSha256', 'allowedSha256'], ['starts', 'starts']])
    assert.deepEqual(c[key], live[current], 'Contract differs from current capture: ' + key);
  assert.match(c.expectedAllowedSha256, sha256); assert.match(c.pricingRevision, uuid);
  keys(c.starts, ['web', 'image', 'hd', 'works', 'role', 'template']);
  for (const value of Object.values(c.starts)) {
    assert.ok(Array.isArray(value) && value.length === 3 && Number.isSafeInteger(value[0]) && value[0] > 0);
    assert.match(value[1], /^[a-f0-9]{32}$/); assert.match(value[2], /^\d+$/);
  }
  keys(c.versions, ['main', 'guard']);
  for (const value of [c.baselineVersion, ...Object.values(c.versions)])
    assert.match(value, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  for (const key of ['baselineBuild', 'mainBranch', 'guardReference', 'closedCacheReference'])
    assert.ok(typeof c[key] === 'string' && c[key].length > 0 && !/[\x00-\x20/\\]/.test(key === 'mainBranch' || key === 'guardReference' ? c[key].replaceAll('/', '') : c[key]));
  for (const key of ['approvedMainFiles', 'guardChangedFiles', 'guardDisplayFiles']) {
    assert.ok(Array.isArray(c[key]) && new Set(c[key]).size === c[key].length);
    for (const file of c[key]) assert.ok(typeof file === 'string' && !path.isAbsolute(file)
      && file.split('/').every(p => p && p !== '.' && p !== '..') && !/[\x00-\x1f\\]/.test(file));
  }
  assert.ok(c.approvedMainFiles.length > 0 && c.guardChangedFiles.length > 0);
  assert.ok(Array.isArray(c.retiredPricingSources) && new Set(c.retiredPricingSources).size === c.retiredPricingSources.length);
  for (const source of c.retiredPricingSources) {
    assert.match(source, sha);
    assert.ok(![c.mainSource, c.recoveryGuardSource].includes(source), 'A legal pair source cannot also be retired; drain PIDs separately');
  }
  for (const source of original.retiredPricingSources)
    assert.ok([c.mainSource, c.recoveryGuardSource].includes(source) || c.retiredPricingSources.includes(source), 'Cannot drop a retired source without a reviewed controller promotion');
  assert.ok(Array.isArray(c.protectedVideoTaskIds));
  for (const id of c.protectedVideoTaskIds) assert.match(id, /^[a-z0-9]+$/);
  for (const id of original.protectedVideoTaskIds) assert.ok(c.protectedVideoTaskIds.includes(id), 'Cannot drop existing protected tasks');
  if (plan.reuseBuilds !== null) {
    keys(plan.reuseBuilds, ['sourceRun', 'directory']);
    assert.match(plan.reuseBuilds.sourceRun, uuid); assert.notEqual(plan.reuseBuilds.sourceRun, c.recoveryRunId);
    assert.ok(path.isAbsolute(plan.reuseBuilds.directory));
  }
  return c;
}

export function checkSources(repo, c) {
  assert.equal(fs.realpathSync(git(repo, ['rev-parse', '--show-toplevel'])), fs.realpathSync(repo));
  for (const source of [c.mainSource, c.recoveryGuardSource, c.sourceBase, c.guardDisplaySource, c.baselineSource])
    assert.equal(git(repo, ['cat-file', '-t', source]), 'commit');
  for (const source of [c.mainSource, c.recoveryGuardSource]) git(repo, ['merge-base', '--is-ancestor', c.sourceBase, source]);
  const changed = (left, right) => git(repo, ['diff', '--name-only', '-z', left, right]).split('\0').filter(Boolean).sort();
  assert.deepEqual(changed(c.sourceBase, c.mainSource), [...c.approvedMainFiles].sort(), 'Main scope differs from review');
  assert.deepEqual(changed(c.mainSource, c.recoveryGuardSource), [...c.guardChangedFiles].sort(), 'Guard scope differs from review');
  for (const [kind, source] of [['main', c.mainSource], ['guard', c.recoveryGuardSource]])
    assert.equal(JSON.parse(git(repo, ['show', source + ':package.json'])).version, c.versions[kind]);
  assert.equal(git(repo, ['rev-parse', c.mainBranch]), c.mainSource, 'Main branch moved');
  assert.equal(git(repo, ['rev-parse', c.guardReference]), c.recoveryGuardSource, 'Guard branch moved');
  if (c.recoveredGuardBaseline) {
    assertRecoveredGuardInput(c.recoveredGuardBaseline);
    const create = 'src/app/api/tasks/create/route.ts';
    const protectedIncrement = assertProtectedIncrement(c.protectedIncrement, c);
    assert.equal(git(repo, ['show', c.mainSource + ':' + create]), git(repo, ['show',
      (protectedIncrement ? c.baselineSource : '4e1fe5b888c1fdb20a9cbccdd6517b84452fa604') + ':' + create]));
    assert.equal(git(repo, ['show', c.recoveryGuardSource + ':' + create]), git(repo, ['show', 'c9f0a60d753b286db470626ad33c1987ff1c72bf:' + create]));
    for (const [kind, source] of [['main', c.mainSource], ['guard', c.recoveryGuardSource]])
      assert.equal(git(repo, ['show', source + ':src/lib/pricing/build-mode.ts']),
        `export const PRICING_ADMIN_WRITES_ENABLED: boolean = ${!protectedIncrement && kind === 'main' ? 'true' : 'false'};`);
    if (protectedIncrement) for (const source of [c.mainSource, c.recoveryGuardSource]) for (const file of PROTECTED_INCREMENT_SOURCE_FILES)
      assert.equal(git(repo, ['show', source + ':' + file]), git(repo, ['show', c.baselineSource + ':' + file]),
        'Protected admission/privacy source changed: ' + file);
  }
  if (c.deployedUsageSchema) for (const file of ['prisma/migrations/20261021073000_usage_attribution/migration.sql',
    'ops/sd2-usage-attribution-migrate.py', 'prisma/schema.prisma', 'ops/sd2-usage-role-start.mjs']) {
    if (file === 'prisma/schema.prisma' && c.canvasVideoBatchSchema) {
      const previous = Buffer.from(execFileSync('git', ['-C', repo, 'show', c.baselineSource + ':' + file]));
      for (const source of [c.mainSource, c.recoveryGuardSource]) {
        const next = Buffer.from(execFileSync('git', ['-C', repo, 'show', source + ':' + file]));
        if (c.deployedCanvasBatchSchema) {
          assert.equal(digest(previous), c.canvasVideoBatchSchema.newPrismaSha256, 'Published canvas schema changed');
          assert.equal(digest(next), c.fullRelease ? c.fullRelease.schemaChange.newPrismaSha256 : c.canvasVideoBatchSchema.newPrismaSha256, 'Adopted canvas schema changed');
          if (c.fullRelease) assert.equal(digest(previous), c.fullRelease.schemaChange.previousPrismaSha256);
        } else assertCanvasBatchPrismaExtension(previous, next, c.canvasVideoBatchSchema);
      }
      continue;
    }
    const expected = git(repo, ['rev-parse', c.baselineSource + ':' + file]);
    for (const source of [c.mainSource, c.recoveryGuardSource])
      assert.equal(git(repo, ['rev-parse', source + ':' + file]), expected, 'New pair changed deployed usage schema/start input: ' + file);
  }
  if (c.fullRelease) for (const [kind, source] of [['main', c.mainSource], ['guard', c.recoveryGuardSource]]) {
    assert.equal(digest(execFileSync('git', ['-C', repo, 'show', source + ':' + FULL_SQL])), c.fullRelease.schemaChange.sqlSha256);
    assert.equal(git(repo, ['show', source + ':src/lib/pricing/build-mode.ts']),
      `export const PRICING_ADMIN_WRITES_ENABLED: boolean = ${c.fullRelease.capabilities[kind].pricingWrites};`);
    assert.equal(git(repo, ['show', source + ':src/lib/video/multiview-build-mode.ts']),
      `export const MULTIVIEW_GENERATION_WRITES_ENABLED: boolean = ${c.fullRelease.capabilities[kind].multiviewGeneration};`);
  }
  if (c.canvasVideoBatchSchema) for (const [kind, source] of [['main', c.mainSource], ['guard', c.recoveryGuardSource]]) {
    for (const [file, expected] of [[CANVAS_BATCH_SQL, c.canvasVideoBatchSchema.sqlSha256], [CANVAS_BATCH_MIGRATOR, c.canvasVideoBatchSchema.migrationModuleSha256]])
      assert.equal(digest(execFileSync('git', ['-C', repo, 'show', source + ':' + file])), expected);
    assert.equal(git(repo, ['show', source + ':' + CANVAS_BATCH_MODE]),
      `export const CANVAS_VIDEO_BATCH_WRITES_ENABLED: boolean = ${c.fullRelease ? c.fullRelease.capabilities[kind].canvasVideoBatchWrites : !c.protectedIncrement && kind === 'main'};`);
  }
}

export function reuseInput(plan) {
  if (plan.reuseBuilds === null) return null;
  const { sourceRun, directory } = plan.reuseBuilds, result = { schema: 'sd2-original-build-reuse-input.v1', sourceRun };
  const continuation = plan.contract.normalContinuation && assertContinuationInput(plan.contract.normalContinuation);
  const exactUnpublished = exactUnpublishedPlan(plan);
  let original;
  const manifestSha256 = exactUnpublished ? UNPUBLISHED_PAIR.manifestSha256 : continuation?.sourceManifestSha256;
  if (continuation?.schema === CONTINUATION_V2 || exactUnpublished) {
    assert.ok(plan.contract.deployedUsageSchema && plan.contract.deployedCanvasBatchSchema && plan.contract.canvasVideoBatchSchema);
    assert.equal(sourceRun, exactUnpublished ? UNPUBLISHED_PAIR.run : continuation.sourceRun);
    const bytes = read(path.join(directory, 'manifest.json')); assert.equal(digest(bytes), manifestSha256);
    original = JSON.parse(bytes);
    assert.equal(original.schema, 'rate-impl2-release.v1'); assert.equal(original.project, 'video-api-debugger');
    assert.equal(original.runId, sourceRun); assert.equal(original.stage, '/data/video-api-debugger/release-staging/' + sourceRun);
    assert.equal(original.normalContinuation || null, null); assert.equal(original.reuseBuilds || null, null);
    for (const key of ['deployedUsageSchema', 'deployedCanvasBatchSchema', 'canvasVideoBatchSchema'])
      assert.deepEqual(original[key], plan.contract[key]);
    assert.equal(original.mainSource, plan.contract.mainSource); assert.equal(original.guardSource, plan.contract.recoveryGuardSource);
    for (const kind of ['main', 'guard']) {
      assert.equal(original[kind].source, original[kind + 'Source']);
      assert.equal(original[kind].root, '/data/video-api-debugger/managed-releases/' + original[kind].source);
      assert.equal(original[kind].version, plan.contract.versions[kind]);
    }
  }
  for (const [kind, source] of [['main', plan.contract.mainSource], ['guard', plan.contract.recoveryGuardSource]]) {
    const file = kind + '-immutable-success.json', bytes = read(path.join(directory, file)), value = JSON.parse(bytes);
    assert.equal(value.schema, 'sd2-immutable-successful-build.v1');
    assert.equal(value.kind, kind); assert.equal(value.sourceRun, sourceRun);
    assert.equal(value.originallyVerifiedWithinThirtyMinuteGate, true);
    assert.equal(value.originalTimesChanged, false); assert.equal(value.newCompilationClaimed, false);
    assert.equal(value.originalReceipt.source, source); assert.equal(value.originalReceipt.runId, sourceRun);
    assert.equal(value.originalReceipt.version, plan.contract.versions[kind]);
    assert.equal(value.originalReceipt.exitCode, 0); assert.equal(value.originalReceipt.verifiedSourceAndGates, true);
    assert.ok(value.snapshot && value.originalReceipt.build && value.originalReceipt.finishedAt);
    if (exactUnpublished) {
      assert.equal(digest(bytes), UNPUBLISHED_PAIR[kind].sha256);
      assert.equal(value.originalReceipt.build, UNPUBLISHED_PAIR[kind].build);
      const sealed = Date.parse(value.sealedAt);
      assert.ok(Number.isSafeInteger(sealed) && sealed >= value.originalReceipt.finishedAt
        && sealed - value.originalReceipt.startedAt < 1800000);
    }
    if (original) {
      assert.equal(value.originalManifestSha256, manifestSha256);
      assert.equal(value.originalReceiptFile, original.stage + '/' + kind + '-build.json');
      const receipt = read(path.join(directory, kind + '-build.json'));
      assert.equal(digest(receipt), value.originalReceiptSha256); assert.deepEqual(JSON.parse(receipt), value.originalReceipt);
      assert.equal(digest(read(path.join(directory, 'manifest.json'))), manifestSha256,
        'Original manifest changed during local reuse preparation');
    }
    result[kind] = { file: '/data/video-api-debugger/release-staging/' + sourceRun + '/' + file, sha256: digest(bytes) };
  }
  return result;
}

export function deployedProofInput(plan) {
  if (!plan.contract.deployedUsageSchema) return null;
  const c = plan.contract.deployedUsageSchema, input = plan.deployedUsageProof;
  const stdout = read(input.stdoutFile), command = read(input.commandReceiptFile);
  assert.equal(digest(stdout), c.finalProofSha256, 'Original retained proof stdout changed');
  assert.equal(digest(command), c.finalProofCommandSha256, 'Original retained proof command receipt changed');
  const proof = JSON.parse(stdout), receipt = JSON.parse(command);
  assert.equal(proof.schema, 'rate-impl2-switch-proof.v1'); assert.equal(proof.readOnly, true);
  assert.equal(proof.runId, c.publicationRun); assert.equal(proof.manifestSha256, c.publicationManifestSha256);
  assert.equal(receipt.status, 0); assert.equal(receipt.signal, null); assert.equal(receipt.error, null);
  const start = Date.parse(receipt.start), finish = Date.parse(receipt.finish), at = Date.parse(proof.at);
  assert.ok(Number.isFinite(start) && Number.isFinite(finish) && Number.isFinite(at)
    && start <= at && at <= finish && finish <= Date.now(), 'Retained proof must belong to the original completed command');
  return { stdout, command, provenance: { kind: 'original-retained-command-stdout', publicationRun: c.publicationRun,
    stdout: { sourceFile: input.stdoutFile, stagedFile: 'deployed-usage-prior-proof.stdout', sha256: digest(stdout) },
    command: { sourceFile: input.commandReceiptFile, stagedFile: 'deployed-usage-prior-proof-command.json', sha256: digest(command) },
    originalProofAt: proof.at, originalCommandStart: receipt.start, originalCommandFinish: receipt.finish,
    originalBytesAndTimesChanged: false, historicalRunWritten: false } };
}

export function renderWrapper(source, repoRoot, reuse, templateName = profile.promotion?.template || profile.template) {
  const patches = [], counts = { imports: 0, control: 0, repo: 0, reuse: 0, review: 0 };
  const add = (node, value) => patches.push({ start: node.getStart(), end: node.end, value });
  function visit(node) {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier.text.startsWith('./' + templateName + '/')) {
      add(node.moduleSpecifier, JSON.stringify('./control/' + path.posix.basename(node.moduleSpecifier.text))); counts.imports++;
    }
    if (ts.isVariableDeclaration(node) && node.name.getText() === 'control') {
      assert.equal(node.initializer.getText(), "path.join(base, '" + templateName + "')");
      add(node.initializer, "path.join(base, 'control')"); counts.control++;
    }
    if (ts.isPropertyAssignment(node)) {
      const key = node.name.getText();
      if (key === 'repoRoot') { add(node.initializer, JSON.stringify(repoRoot)); counts.repo++; }
      if (key === 'reuseBuilds') { add(node.initializer, JSON.stringify(reuse)); counts.reuse++; }
      if (key === 'review') {
        add(node.initializer, JSON.stringify('Pinned successful controller; exact committed scope; local preparation is not fresh server admission or functional acceptance')); counts.review++;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(parse(source));
  assert.deepEqual(counts, { imports: 2, control: 1, repo: 1, reuse: 1, review: 1 });
  return patchNodes(source, patches);
}

export async function prepare(plan, materialsRoot) {
  const template = verifyTemplate(materialsRoot), contractSource = template.files['release-contract.mjs'].toString('utf8');
  const original = contractData(contractSource), c = validatePlan(plan, original.value);
  const common = root => fs.realpathSync(path.resolve(root, git(root, ['rev-parse', '--git-common-dir'])));
  assert.equal(common(plan.repoRoot), common('/Volumes/Data/Projects/video-api-debugger'), 'Different project repository');
  checkSources(plan.repoRoot, c);
  const reuse = reuseInput(plan);
  const historicalProof = deployedProofInput(plan);
  const output = path.join(fs.realpathSync(path.dirname(plan.outputRoot)), path.basename(plan.outputRoot));
  assert.ok(output.startsWith(template.base + path.sep) && output !== template.base, 'Output must stay in the private release materials directory');
  assert.ok(!fs.existsSync(path.join(template.base, c.recoveryRunId)), 'Run already exists; do not reset its failure history');
  assert.ok(!fs.existsSync(output), 'Output must be new; frozen runs are never overwritten');
  const generatedContract = patchNodes(contractSource, [{ start: original.object.getStart(), end: original.object.end, value: JSON.stringify(c, null, 2) }]);
  const generatedWrapper = renderWrapper(template.wrapper, plan.repoRoot, reuse, template.templateName);
  // All static checks finish before creating an exclusive private output directory.
  fs.mkdirSync(output, { mode: 0o700 });
  fs.mkdirSync(path.join(output, 'control'), { mode: 0o700 });
  const write = (file, bytes) => fs.writeFileSync(path.join(output, file), bytes, { flag: 'wx', mode: 0o600 });
  for (const [file, bytes] of Object.entries(template.files)) write('control/' + file, file === 'release-contract.mjs' ? generatedContract : bytes);
  write('run.mjs', generatedWrapper);
  if (historicalProof) {
    write('deployed-usage-prior-proof.stdout', historicalProof.stdout);
    write('deployed-usage-prior-proof-command.json', historicalProof.command);
  }
  const receipt = { schema: 'sd2-release-preparation.v1', runId: c.recoveryRunId, createdAt: new Date().toISOString(),
    profileSha256: digest(read(path.join(here, 'sd2-release-profile.json'))), planSha256: digest(JSON.stringify(plan)),
    privateSha256: hashes(moduleFiles(path.join(output, 'control'))), wrapperSha256: digest(generatedWrapper),
    candidateEvidenceKind: reuse ? REUSE_SCHEMA : 'rate-impl2-candidate-build.v1',
    reuseInput: reuse, deployedUsageProof: historicalProof?.provenance || null, localPreparationOnly: true, serverAdmissionVerified: false,
    servicesChanged: false, productionWrites: 0, functionalAcceptance: false };
  write('preparation.json', JSON.stringify(receipt, null, 2) + '\n');
  return { output, receipt };
}

export function prepareFull(plan) {
  keys(plan, ['schema', 'taskId', 'repoRoot', 'outputRoot', 'liveCapture', 'contract', 'reuseBuilds', 'deployedUsageProof',
    ...(Object.hasOwn(plan, 'controlEvidence') ? ['controlEvidence'] : [])]);
  assert.equal(plan.schema, 'sd2-full-release-plan.v1'); assert.match(plan.taskId, uuid);
  const validation = { schema: 'sd2-release-plan.v1', repoRoot: plan.repoRoot, outputRoot: plan.outputRoot,
    liveCapture: plan.liveCapture, contract: plan.contract, reuseBuilds: plan.reuseBuilds, deployedUsageProof: plan.deployedUsageProof };
  const c = validatePlan(validation, LEGACY_CONTRACT); assert.ok(assertFullReleaseInput(c.fullRelease));
  checkSources(plan.repoRoot, c);
  const output = path.join(fs.realpathSync(path.dirname(plan.outputRoot)), path.basename(plan.outputRoot));
  assert.equal(fs.existsSync(output), false, 'Never overwrite a prepared, failed or published attempt');
  const engineSource = path.join(here, 'release-engine/v1'), privateSha256 = hashes(moduleFiles(engineSource));
  const controllerSetSha256 = digest(JSON.stringify(privateSha256)), projectRoot = '/data/video-api-debugger';
  const engine = { schema: 'sd2-release-engine.v1', version: ENGINE_VERSION, controllerSetSha256,
    root: projectRoot + '/release-engines/' + ENGINE_VERSION + '-' + controllerSetSha256 };
  const stage = projectRoot + '/release-staging/' + c.recoveryRunId;
  const operation = { schema: 'sd2-release-operation.v1', taskId: plan.taskId, attemptId: c.recoveryRunId,
    taskRoot: projectRoot + '/release-tasks/' + plan.taskId };
  const reuse = reuseInput(validation), historical = deployedProofInput(validation);
  const context = { schema: 'sd2-release-context.v1', contract: { ...c, engine, operation,
    ...(reuse ? { immutableOriginalManifest: projectRoot + '/release-staging/' + reuse.sourceRun + '/manifest.json' } : {}) } };
  const request = { schema: reuse ? 'sd2-release-package-request.v2' : 'sd2-release-package-request.v1', repoRoot: plan.repoRoot,
    mainSource: c.mainSource, guardSource: c.recoveryGuardSource, outputRoot: output + '/packages',
    ...(reuse ? { originalBuilds: { directory: plan.reuseBuilds.directory, sourceRun: reuse.sourceRun,
      manifestSha256: digest(read(path.join(plan.reuseBuilds.directory, 'manifest.json'))),
      mainSha256: reuse.main.sha256, guardSha256: reuse.guard.sha256 } } : {}) };
  const seed = { runId: c.recoveryRunId, mainSource: c.mainSource, guardSource: c.recoveryGuardSource,
    expectedAllowedSha256: c.expectedAllowedSha256, engine, operation, ...(reuse ? { reuseBuilds: reuse } : {}),
    ...(plan.controlEvidence ? { controlEvidence: plan.controlEvidence } : {}) };
  const install = { schema: 'sd2-release-engine-install.v1', projectRoot, sourceRoot: stage + '/engine-source', engine, privateSha256 };
  fs.mkdirSync(output, { mode: 0o700 }); fs.mkdirSync(output + '/engine-source', { mode: 0o700 });
  const save = (file, value) => fs.writeFileSync(output + '/' + file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  for (const file of Object.keys(privateSha256)) fs.writeFileSync(output + '/engine-source/' + file, read(engineSource + '/' + file), { flag: 'wx', mode: 0o600 });
  save('context.json', context); save('seed.json', seed); save('package-request.json', request); save('engine-install.json', install);
  if (historical) {
    fs.writeFileSync(output + '/deployed-usage-prior-proof.stdout', historical.stdout, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(output + '/deployed-usage-prior-proof-command.json', historical.command, { flag: 'wx', mode: 0o600 });
  }
  const receipt = { schema: 'sd2-full-release-preparation.v1', runId: c.recoveryRunId, taskId: plan.taskId, output, stage,
    engine, privateSha256, localPreparationOnly: true, serverAdmissionVerified: false, servicesChanged: false,
    productionWrites: 0, functionalAcceptance: false, planSha256: digest(JSON.stringify(plan)), createdAt: new Date().toISOString() };
  save('preparation.json', receipt); return receipt;
}

export function bindFullPackage(preparationFile, packageReceiptFile) {
  const preparation = json(preparationFile); assert.equal(preparation.schema, 'sd2-full-release-preparation.v1');
  const output = fs.realpathSync(preparation.output), receipt = json(packageReceiptFile);
  assert.equal(receipt.schema, 'rate-impl2-package-candidates.v1'); assert.equal(receipt.outputRoot, output + '/packages');
  const seed = json(output + '/seed.json'), context = json(output + '/context.json');
  const artifacts = Object.fromEntries(['main', 'guard'].map(kind => {
    const file = receipt[kind].sourceManifest, bytes = read(file), value = JSON.parse(bytes);
    assert.equal(file, output + '/packages/' + kind + '/source-manifest.json'); assert.equal(value.kind, kind);
    assert.equal(digest(bytes), receipt[kind].manifestSha256); assert.equal(value.source, seed[kind + 'Source']);
    assert.equal(value.version, context.contract.versions[kind]);
    return [kind, { schema: 'sd2-release-artifact-input.v1', kind, source: value.source, version: value.version,
      sourceManifestSha256: digest(bytes), buildInputsSha256: digest(JSON.stringify({ sourceManifestSha256: digest(bytes),
        packageLockSha256: value.files['package-lock.json'], engine: preparation.engine })) }];
  }));
  const batch = { schema: 'sd2-release-batch.v1', project: 'video-api-debugger', projectRoot: '/data/video-api-debugger',
    taskId: preparation.taskId, attemptId: preparation.runId, runId: preparation.runId, engine: preparation.engine,
    contextFile: preparation.stage + '/context.json', seedFile: preparation.stage + '/seed.json', manifestFile: preparation.stage + '/manifest.json',
    artifacts, phases: ['capture', 'preflight', 'admission', 'adopt', 'prepare', 'guard-build', 'main-build', 'verify', 'arm', 'switch', 'proof'] };
  fs.writeFileSync(output + '/release-batch.json', JSON.stringify(batch, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { batchFile: output + '/release-batch.json', serverBatchFile: preparation.stage + '/release-batch.json',
    originalSourceManifestBytesBound: true, localPreparationOnly: true, productionWrites: 0 };
}

// No SSH, reservation, upload, service action or production import occurs in this entry point.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [mode, materialsRoot, planFile] = process.argv.slice(2);
  assert.ok(path.isAbsolute(materialsRoot || ''));
  if (mode === 'prepare-full' && !planFile) console.log(JSON.stringify(prepareFull(json(materialsRoot))));
  else if (mode === 'bind-package' && planFile) console.log(JSON.stringify(bindFullPackage(materialsRoot, planFile)));
  else if (mode === 'check-template' && !planFile) {
    verifyTemplate(materialsRoot); console.log(JSON.stringify({ templateVerified: true, productionWrites: 0 }));
  } else if (mode === 'prepare' && planFile) {
    const result = await prepare(json(planFile), materialsRoot);
    console.log(JSON.stringify({ output: result.output, localPreparationOnly: true, serverAdmissionVerified: false }));
  } else throw new Error('Usage: node ops/sd2-release-prepare.mjs prepare-full FULL_PLAN.json | bind-package PREPARATION.json PACKAGE_RECEIPT.json | check-template MATERIALS_ROOT | prepare MATERIALS_ROOT PRIVATE_PLAN_JSON');
}
