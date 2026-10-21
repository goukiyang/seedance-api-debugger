import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertCanvasBatchSchemaInput, assertCanvasBatchPrismaExtension, CANVAS_BATCH_SQL, CANVAS_BATCH_MIGRATOR, CANVAS_BATCH_MODE } from './canvas-video-batch-schema-extension.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const here = path.dirname(fileURLToPath(import.meta.url));
export const profile = JSON.parse(fs.readFileSync(path.join(here, 'sd2-release-profile.json')));
const digest = value => createHash('sha256').update(value).digest('hex');
const sha = /^[a-f0-9]{40}$/, sha256 = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const REUSE_SCHEMA = 'sd2-candidate-build-reuse.v1';
export const DEPLOYED_SCHEMA = 'sd2-deployed-usage-schema-input.v1';
export const DEPLOYED_FIELDS = ['schema', 'publicationRun', 'publicationManifestSha256', 'switchCompleteSha256',
  'finalProofSha256', 'finalProofCommandSha256', 'migrationRun', 'migrationManifestSha256', 'migrationBeforeSha256',
  'migrationReceiptSha256', 'backupProofSha256', 'backupSha256'];
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
  keys(promoted, ['template', 'wrapper', 'controllerCount', 'controllerSetSha256', 'wrapperSha256', 'changed', 'added']);
  for (const value of [promoted.template, promoted.wrapper]) assert.ok(path.basename(value) === value && !value.includes('..'));
  const promotedFiles = moduleFiles(path.join(base, promoted.template));
  assert.equal(Object.keys(promotedFiles).length, promoted.controllerCount);
  assert.equal(digest(JSON.stringify(hashes(promotedFiles))), promoted.controllerSetSha256, 'Promoted controller differs from review');
  assert.deepEqual(Object.keys(promotedFiles).filter(file => !Object.hasOwn(files, file)).sort(), [...promoted.added].sort());
  assert.deepEqual(Object.keys(files).filter(file => !promotedFiles[file]?.equals(files[file])).sort(), [...promoted.changed].sort());
  const promotedWrapper = read(path.join(base, promoted.wrapper));
  assert.equal(digest(promotedWrapper), promoted.wrapperSha256);
  return { base, files: promotedFiles, wrapper: promotedWrapper.toString('utf8'), templateName: promoted.template,
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
  keys(c, Object.keys(original));
  keys(live, ['observedAt', 'source', 'version', 'build', 'starts', 'pricingRevision', 'allowedSha256']);
  const observed = Date.parse(live.observedAt);
  assert.ok(Number.isSafeInteger(observed) && observed <= now && now - observed <= 300000, 'Capture must be fresh; historical evidence is not current runtime');
  assert.equal(c.sourceReady, true); assert.equal(c.baselineReconciled, true);
  assert.ok(!(c.normalContinuation && c.deployedUsageSchema), 'Schema adoption modes are mutually exclusive');
  if (c.canvasVideoBatchSchema) {
    assertCanvasBatchSchemaInput(c.canvasVideoBatchSchema);
    assert.ok(c.deployedUsageSchema, 'Additive canvas migration retains the deployed usage schema proof');
    assert.equal(plan.reuseBuilds, null, 'A new schema pair requires two complete fresh builds');
  }
  if (c.deployedUsageSchema !== null && c.deployedUsageSchema !== undefined) {
    const value = c.deployedUsageSchema;
    keys(value, DEPLOYED_FIELDS); assert.equal(value.schema, DEPLOYED_SCHEMA);
    for (const key of ['publicationRun', 'migrationRun']) { assert.match(value[key], uuid); assert.notEqual(value[key], c.recoveryRunId); }
    for (const key of DEPLOYED_FIELDS.filter(key => key.endsWith('Sha256'))) assert.match(value[key], sha256);
    assert.equal(plan.reuseBuilds, null, 'A new deployed-schema pair requires complete fresh main and guard builds');
    keys(plan.deployedUsageProof, ['stdoutFile', 'commandReceiptFile']);
    for (const file of Object.values(plan.deployedUsageProof)) assert.ok(typeof file === 'string' && path.isAbsolute(file));
  } else {
    assert.equal(plan.deployedUsageProof || null, null, 'Historical proof payload is only valid in deployed-schema mode');
  }
  if (c.normalContinuation) {
    const value = c.normalContinuation;
    keys(value, ['schema', 'chainId', 'attempt', 'sourceRun', 'sourceManifestSha256', 'beforeSha256', 'approvalSha256',
      'refusalSha256', 'lineageSha256', 'migrationRun', 'migrationManifestSha256', 'migrationReceiptSha256', 'backupProofSha256']);
    assert.equal(value.schema, 'sd2-normal-continuation-input.v1');
    for (const key of ['chainId', 'sourceRun', 'migrationRun']) assert.match(value[key], uuid);
    for (const key of Object.keys(value).filter(key => key.endsWith('Sha256'))) assert.match(value[key], sha256);
    assert.ok(Number.isSafeInteger(value.attempt) && value.attempt > 1);
    assert.notEqual(value.sourceRun, c.recoveryRunId);
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
  if (c.deployedUsageSchema) for (const file of ['prisma/migrations/20261021073000_usage_attribution/migration.sql',
    'ops/sd2-usage-attribution-migrate.py', 'prisma/schema.prisma', 'ops/sd2-usage-role-start.mjs']) {
    if (file === 'prisma/schema.prisma' && c.canvasVideoBatchSchema) {
      const previous = Buffer.from(execFileSync('git', ['-C', repo, 'show', c.baselineSource + ':' + file]));
      for (const source of [c.mainSource, c.recoveryGuardSource]) {
        const next = Buffer.from(execFileSync('git', ['-C', repo, 'show', source + ':' + file]));
        assertCanvasBatchPrismaExtension(previous, next, c.canvasVideoBatchSchema);
      }
      continue;
    }
    const expected = git(repo, ['rev-parse', c.baselineSource + ':' + file]);
    for (const source of [c.mainSource, c.recoveryGuardSource])
      assert.equal(git(repo, ['rev-parse', source + ':' + file]), expected, 'New pair changed deployed usage schema/start input: ' + file);
  }
  if (c.canvasVideoBatchSchema) for (const [kind, source] of [['main', c.mainSource], ['guard', c.recoveryGuardSource]]) {
    for (const [file, expected] of [[CANVAS_BATCH_SQL, c.canvasVideoBatchSchema.sqlSha256], [CANVAS_BATCH_MIGRATOR, c.canvasVideoBatchSchema.migrationModuleSha256]])
      assert.equal(digest(execFileSync('git', ['-C', repo, 'show', source + ':' + file])), expected);
    assert.equal(git(repo, ['show', source + ':' + CANVAS_BATCH_MODE]),
      `export const CANVAS_VIDEO_BATCH_WRITES_ENABLED: boolean = ${kind === 'main' ? 'true' : 'false'};`);
  }
}

export function reuseInput(plan) {
  if (plan.reuseBuilds === null) return null;
  const { sourceRun, directory } = plan.reuseBuilds, result = { schema: 'sd2-original-build-reuse-input.v1', sourceRun };
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

// No SSH, reservation, upload, service action or production import occurs in this entry point.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [mode, materialsRoot, planFile] = process.argv.slice(2);
  assert.ok(path.isAbsolute(materialsRoot || ''));
  if (mode === 'check-template' && !planFile) {
    verifyTemplate(materialsRoot); console.log(JSON.stringify({ templateVerified: true, productionWrites: 0 }));
  } else if (mode === 'prepare' && planFile) {
    const result = await prepare(json(planFile), materialsRoot);
    console.log(JSON.stringify({ output: result.output, localPreparationOnly: true, serverAdmissionVerified: false }));
  } else throw new Error('Usage: node ops/sd2-release-prepare.mjs check-template MATERIALS_ROOT | prepare MATERIALS_ROOT PRIVATE_PLAN_JSON');
}
