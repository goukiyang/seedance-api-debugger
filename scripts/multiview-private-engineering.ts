import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { CHECKS, MULTIVIEW_PRIVATE_FIXTURE_SOURCES } from './multiview-private-fixture-inputs.mjs';

type UnknownRecord = Record<string, unknown>;
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const sourceHashes = (root: string) => Object.fromEntries(MULTIVIEW_PRIVATE_FIXTURE_SOURCES.map(file => [
  file,
  sha256(readFileSync(path.join(root, file))),
]));

const SINK_WIRING = Object.freeze([
  ['src/app/api/approvals/[id]/route.ts', ['projectSelectedMultiviewTask', 'source_metadata_json']],
  ['src/app/api/approvals/route.ts', ['projectSelectedMultiviewTask', 'source_metadata_json']],
  ['src/app/api/assets/library/route.ts', ['ordinaryVideoTaskWhere', 'safeVideoTaskKeywordWhere', 'multiviewOutputsOnly']],
  ['src/app/api/assets/picker/route.ts', ['readPicker']],
  ['src/app/api/media/legacy/route.ts', ['legacyMediaResponse']],
  ['src/app/api/me/credits/ledger/route.ts', ['isPrivateMultiviewTask', 'privateMultiviewLedgerMetadata']],
  ['src/app/api/multiview/preset/route.ts', ['readPublicMultiviewRotationPreset']],
  ['src/app/api/projects/[id]/route.ts', ['projectSelectedMultiviewTask', 'safeVideoTaskKeywordWhere', 'source_metadata_json']],
  ['src/app/api/projects/[id]/video-cards/route.ts', ['projectSelectedMultiviewTask', 'source_metadata_json']],
  ['src/app/api/provider/seedance/callback/route.ts', ['projectPrivateMultiviewTask', 'isPublicHttpUrl']],
  ['src/app/api/tasks/[id]/reuse/route.ts', ['isPrivateMultiviewTask', 'readSafePrivateMultiviewInput']],
  ['src/app/api/tasks/[id]/route.ts', ['toVideoTaskView', 'videoTaskViewSelect']],
  ['src/server/video-tasks/standard-create.ts', ['readMultiviewSystemReference', 'consumeTrustedMultiviewRetry', 'multiviewPrivateTaskMarker', 'privateNoStore']],
  ['src/app/api/tasks/enhance-video/create/route.ts', ['readMultiviewPrivateTaskMarker', 'MULTIVIEW_PUBLIC_TASK_TITLE']],
  ['src/app/api/video-cards/[id]/route.ts', ['projectSelectedMultiviewTask', 'source_metadata_json']],
  ['src/app/api/video-cards/[id]/tasks/route.ts', ['toVideoTaskView', 'videoTaskViewSelect']],
  ['src/app/api/video/list/route.ts', ['toVideoTaskView', 'videoTaskViewSelect']],
  ['src/app/api/video/retry/[id]/route.ts', ['createPrivateMultiviewRetry', 'readMultiviewPrivateTaskMarker', 'projectSelectedMultiviewTask']],
  ['src/app/api/video/status/[id]/route.ts', ['privateMultiviewFailure', 'toVideoTaskDetail', 'videoTaskDetailSelect']],
  ['src/app/uploads/[...path]/route.ts', ['multiviewSystemReferenceFileAccess', 'multiviewOutputFileAccess']],
] as const);

function findAstNode<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T, label: string): T {
  let found: T | undefined;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (predicate(node)) { found = node; return; }
    ts.forEachChild(node, visit);
  };
  visit(root);
  assert.ok(found, label);
  return found;
}

function evaluateAstExpression<T>(expression: string, globals: UnknownRecord = {}, label = 'unknown'): T {
  const compiled = ts.transpileModule(`module.exports = (${expression});`, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  const sandbox = { module: { exports: undefined as unknown }, exports: {}, ...globals };
  assert.match(label, /^[a-z][a-z0-9-]{0,39}$/);
  vm.runInNewContext(compiled, sandbox, { filename: `multiview-panel-${label}-ast-fixture.js` });
  return sandbox.module.exports as T;
}

function syntheticFailureDiagnostic(error: unknown) {
  const record = error && typeof error === 'object' ? error as UnknownRecord : {};
  const rawName = typeof record.name === 'string' ? record.name : 'NonErrorThrown';
  const rawCode = typeof record.code === 'string' || typeof record.code === 'number' ? String(record.code) : 'none';
  const stack = typeof record.stack === 'string' ? record.stack : '';
  const location = stack.match(/(multiview-panel-[a-z0-9-]+-ast-fixture\.js:\d+:\d+|(?:scripts|src)\/[^()\s]+:\d+:\d+)/)?.[1] || 'unknown';
  const missingMatch = rawName === 'ReferenceError' && typeof record.message === 'string'
    ? /^([A-Za-z_$][A-Za-z0-9_$]{0,79}) is not defined$/.exec(record.message) : null;
  return {
    phase: location.match(/^multiview-panel-([a-z0-9-]+)-ast-fixture\.js:/)?.[1] || 'fixture',
    name: /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(rawName) ? rawName : 'Error',
    code: /^[A-Za-z0-9_.-]{1,80}$/.test(rawCode) ? rawCode : 'unknown',
    location,
    missing: missingMatch?.[1] || 'none',
  };
}

function assertPanelDefaultAndScopeContinuations(root: string, generation: typeof import('../src/lib/video/multiview-generation-contract')) {
  const relative = 'src/app/multiview/MultiviewGenerationPanel.tsx';
  const source = readFileSync(path.join(root, relative), 'utf8');
  const ast = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = findAstNode(ast, (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node)
    && node.name?.text === 'MultiviewGenerationPanel', 'The real multiview generation panel must remain extractable');
  const change = findAstNode(component, (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node)
    && node.name?.text === 'change', 'The real draft change setter must remain extractable');
  const currentDeclaration = findAstNode(component, (node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name) && node.name.text === 'current', 'The real scope checker must remain extractable');
  const captureDeclaration = findAstNode(component, (node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name) && node.name.text === 'capture', 'The real scope capture must remain extractable');
  assert.ok(currentDeclaration.initializer && ts.isArrowFunction(currentDeclaration.initializer));
  assert.ok(captureDeclaration.initializer && ts.isArrowFunction(captureDeclaration.initializer));

  const restorationMarker = findAstNode(component, (node): node is ts.ExpressionStatement => ts.isExpressionStatement(node)
    && ts.isBinaryExpression(node.expression) && node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && node.expression.left.getText(ast) === 'awaitingInitialPresetDefaults.current'
    && node.expression.right.getText(ast) === '!restored',
  'Restoration must initialize the one-time server-default marker from the actual restored draft');
  const adoption = findAstNode(component, (node): node is ts.IfStatement => ts.isIfStatement(node)
    && node.expression.getText(ast).includes('awaitingInitialPresetDefaults.current')
    && node.thenStatement.getText(ast).includes('...value.preset.defaults')
    && node.thenStatement.getText(ast).includes('setDraft(next)'),
  'The actual initial-preset continuation must remain extractable');
  const adoptionBlock = adoption.parent;
  assert.ok(ts.isBlock(adoptionBlock), 'The preset adoption must remain in its real continuation block');
  const adoptionIndex = adoptionBlock.statements.indexOf(adoption);
  assert.ok(adoptionIndex > 0, 'The preset adoption must retain its preceding draft capture');
  const previousDraftStatement = adoptionBlock.statements[adoptionIndex - 1];
  assert.ok(ts.isVariableStatement(previousDraftStatement)
    && previousDraftStatement.declarationList.declarations.length === 1,
  'The preset adoption must retain one adjacent draft capture statement');
  const previousDraftDeclaration = previousDraftStatement.declarationList.declarations[0];
  assert.ok(ts.isIdentifier(previousDraftDeclaration.name) && previousDraftDeclaration.name.text === 'previous'
    && previousDraftDeclaration.initializer?.getText(ast) === 'draftRef.current',
  'The preset adoption must use the adjacent real draftRef capture');
  const setRestorationMarker = evaluateAstExpression<(restored: unknown, marker: { current: boolean }) => void>(
    `function (restored, awaitingInitialPresetDefaults) { ${restorationMarker.getText(ast)} }`,
    {}, 'restoration-marker',
  );
  const runAdoption = evaluateAstExpression<(binding: unknown, marker: { current: boolean }, draftRef: { current: UnknownRecord | null },
    value: UnknownRecord, setDraft: (value: UnknownRecord) => void) => void>(
      `function (binding, awaitingInitialPresetDefaults, draftRef, value, setDraft) { ${previousDraftStatement.getText(ast)} ${adoption.getText(ast)} }`,
      {}, 'preset-adoption',
    );

  const personalDraft = {
    ...generation.defaultMultiviewGenerationDraft('mv04-server-defaults'),
    presetVersion: '1.0.2', projectId: 'personal-project', videoCardId: 'personal-card',
    mainImage: { assetId: 'personal-main', referenceImageId: 'personal-reference' }, supplement: 'keep my supplement',
    model: 'local-default', ratio: '16:9', duration: 5, resolution: '720p', seed: 7,
  };
  const serverDefaults = { provider: 'seedance', generationMode: 'all_in_one_reference', model: 'server-safe-model',
    ratio: '4:3', duration: 12, resolution: '1080p', seed: 42, generateAudio: true, returnLastFrame: true, watermark: true };
  const presetValue = { revision: 9, preset: { id: 'multiview-360', version: '1.0.9', defaults: serverDefaults } };

  const firstMarker = { current: false };
  setRestorationMarker(null, firstMarker);
  assert.equal(firstMarker.current, true);
  const firstRef = { current: { ...personalDraft } as UnknownRecord | null };
  const firstWrites: UnknownRecord[] = [];
  runAdoption(undefined, firstMarker, firstRef, presetValue, value => firstWrites.push(value));
  assert.equal(firstWrites.length, 1);
  assert.equal(firstMarker.current, false);
  assert.equal(firstRef.current?.presetVersion, presetValue.preset.version);
  for (const [key, value] of Object.entries(serverDefaults)) assert.equal(firstRef.current?.[key], value);
  assert.deepEqual(firstRef.current?.mainImage, personalDraft.mainImage);
  assert.equal(firstRef.current?.projectId, personalDraft.projectId);
  assert.equal(firstRef.current?.videoCardId, personalDraft.videoCardId);
  assert.equal(firstRef.current?.supplement, personalDraft.supplement);

  const restored = { ...personalDraft, model: 'restored-model', presetVersion: '1.0.2' };
  const restoredMarker = { current: true };
  setRestorationMarker(restored, restoredMarker);
  assert.equal(restoredMarker.current, false);
  const restoredRef = { current: { ...restored } as UnknownRecord | null };
  const restoredWrites: UnknownRecord[] = [];
  runAdoption(undefined, restoredMarker, restoredRef, presetValue, value => restoredWrites.push(value));
  assert.equal(restoredWrites.length, 0);
  assert.equal(restoredRef.current?.model, 'restored-model');
  assert.equal(restoredRef.current?.presetVersion, '1.0.2');

  const editedMarker = { current: true };
  const editedRef = { current: { ...personalDraft } as UnknownRecord | null };
  const editedWrites: UnknownRecord[] = [];
  const changeDraft = evaluateAstExpression<(patch: UnknownRecord) => void>(change.getText(ast), {
    ready: true, current: () => true, capture: () => ({}), submitLock: { current: null }, draftRef: editedRef,
    awaitingInitialPresetDefaults: editedMarker, setDraft: (value: UnknownRecord) => editedWrites.push(value),
    setError: () => {}, setSaved: () => {}, setDraftEdited: () => {},
  }, 'draft-change');
  changeDraft({ model: 'human-edited-model' });
  assert.equal(editedMarker.current, false);
  assert.equal(editedRef.current?.model, 'human-edited-model');
  runAdoption(undefined, editedMarker, editedRef, presetValue, value => editedWrites.push(value));
  assert.equal(editedWrites.length, 1);
  assert.equal(editedRef.current?.model, 'human-edited-model');

  const handoffScopes = [] as ts.VariableDeclaration[];
  const handoffCallbacks = new Map<'then' | 'catch', ts.ArrowFunction>();
  let pendingDeclaration: ts.VariableDeclaration | undefined;
  const visitHandoff = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'handoffScope') handoffScopes.push(node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'pending'
      && node.initializer?.getText(ast).startsWith('attach(')) pendingDeclaration = node;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && (node.expression.name.text === 'then' || node.expression.name.text === 'catch')) {
      const callback = node.arguments[0];
      if (callback && ts.isArrowFunction(callback) && callback.getText(ast).includes('current(handoffScope)')) {
        handoffCallbacks.set(node.expression.name.text, callback);
      }
    }
    ts.forEachChild(node, visitHandoff);
  };
  visitHandoff(component);
  assert.equal(handoffScopes.length, 1, 'The handoff must capture one immutable scope');
  assert.ok(handoffScopes[0].initializer && handoffScopes[0].initializer!.getText(ast) === 'capture()');
  assert.ok(pendingDeclaration && handoffScopes[0].getStart(ast) < pendingDeclaration.getStart(ast), 'The handoff scope must be captured before attach starts');
  const thenNode = handoffCallbacks.get('then'), catchNode = handoffCallbacks.get('catch');
  assert.ok(thenNode && catchNode, 'The real handoff continuations must both remain extractable');
  assert.equal(thenNode.getText(ast).includes('capture()'), false);
  assert.equal(catchNode.getText(ast).includes('capture()'), false);

  const epoch = { current: 7 }, mountedOwner = { current: 'owner-a' }, liveAuthority = { current: 'authority-a' };
  const liveSessionReady = { current: true }, upload = { ownerId: 'owner-a', epoch: 11 };
  const captureScope = evaluateAstExpression<() => UnknownRecord>(captureDeclaration.initializer!.getText(ast), {
    owner: 'owner-a', authorityKey: 'authority-a', epoch, uploadSession: () => ({ ...upload }),
  }, 'scope-capture');
  const currentScope = evaluateAstExpression<(scope: UnknownRecord) => boolean>(currentDeclaration.initializer!.getText(ast), {
    mountedOwner, epoch, liveAuthority, liveSessionReady, isClientSessionBlocked: () => false, uploadSession: () => ({ ...upload }),
  }, 'scope-current');
  const handoffScope = captureScope();
  const statuses: string[] = [], errors: string[] = [];
  const thenContinuation = evaluateAstExpression<() => void>(thenNode.getText(ast), {
    current: currentScope, handoffScope, setStatus: (value: string) => statuses.push(value), doneMessage: 'handoff complete',
  }, 'handoff-then');
  const catchContinuation = evaluateAstExpression<(cause: unknown) => void>(catchNode.getText(ast), {
    current: currentScope, handoffScope, setError: (value: string) => errors.push(value), message: (_cause: unknown, fallback: string) => fallback,
  }, 'handoff-catch');
  mountedOwner.current = 'owner-b'; epoch.current = 8; upload.ownerId = 'owner-b'; upload.epoch = 12;
  thenContinuation(); catchContinuation(new Error('stale handoff'));
  assert.deepEqual(statuses, []);
  assert.deepEqual(errors, []);
  mountedOwner.current = 'owner-a'; epoch.current = 7; upload.ownerId = 'owner-a'; upload.epoch = 11;
  thenContinuation(); catchContinuation(new Error('current handoff'));
  assert.deepEqual(statuses, ['handoff complete']);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /原主图加入结果待确认/);
}

function assertSinkSyntax(source: string, file: string, tokens: readonly string[]) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node) => { nodes.push(node); ts.forEachChild(node, visit); };
  visit(ast);
  const named = (node: ts.Node | undefined, name: string) => Boolean(node
    && (ts.isIdentifier(node) || ts.isStringLiteral(node)) && node.text === name);
  for (const token of tokens) {
    if (token === 'source_metadata_json') {
      assert.ok(nodes.some(node => ts.isPropertyAssignment(node) && named(node.name, token)
        && node.initializer.kind === ts.SyntaxKind.TrueKeyword && ts.isObjectLiteralExpression(node.parent)
        && ts.isPropertyAssignment(node.parent.parent) && named(node.parent.parent.name, 'select')
        && node.parent.parent.initializer === node.parent), `${file}: missing selected protection field`);
      continue;
    }
    const declared = nodes.some(node => ts.isImportSpecifier(node) && named(node.name, token)
      && !node.isTypeOnly && !node.parent.parent.isTypeOnly
      || ts.isFunctionDeclaration(node) && named(node.name, token) && Boolean(node.body)
      || ts.isVariableDeclaration(node) && named(node.name, token) && Boolean(node.initializer));
    assert.ok(declared, `${file}: missing runtime import/definition for ${token}`);
    if (token === 'videoTaskViewSelect' || token === 'videoTaskDetailSelect') {
      assert.ok(nodes.some(node => ts.isPropertyAssignment(node) && named(node.name, 'select')
        && ts.isIdentifier(node.initializer) && node.initializer.text === token), `${file}: missing DTO select use`);
      continue;
    }
    if (token === 'multiviewOutputsOnly' || token === 'MULTIVIEW_PUBLIC_TASK_TITLE') {
      const used = nodes.some(node => {
        if (!ts.isIdentifier(node) || node.text !== token) return false;
        const parent = node.parent;
        return ts.isShorthandPropertyAssignment(parent)
          || ts.isPropertyAssignment(parent) && parent.initializer === node
          || ts.isTemplateSpan(parent) && parent.expression === node
          || ts.isBinaryExpression(parent) || ts.isConditionalExpression(parent);
      });
      assert.ok(used, `${file}: missing runtime value use for ${token}`);
      continue;
    }
    const invoked = nodes.some(node => ts.isCallExpression(node) && (
      ts.isIdentifier(node.expression) && node.expression.text === token
      // The ledger uses the real array predicate, not a direct call expression.
      || token === 'isPrivateMultiviewTask' && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'filter' && node.arguments[0]
        && ts.isIdentifier(node.arguments[0]) && node.arguments[0].text === token
    ));
    assert.ok(invoked, `${file}: missing helper invocation for ${token}`);
  }
}

function assertSinkSyntaxRefusals() {
  const dto = "import { toVideoTaskView, videoTaskViewSelect } from 'synthetic'; const args = { select: videoTaskViewSelect }; const view = toVideoTaskView(task);";
  assertSinkSyntax(dto, 'synthetic-dto.ts', ['toVideoTaskView', 'videoTaskViewSelect']);
  assert.throws(() => assertSinkSyntax(dto.replace('select: videoTaskViewSelect', "select: 'videoTaskViewSelect'"),
    'synthetic-dto.ts', ['toVideoTaskView', 'videoTaskViewSelect']));
  assert.throws(() => assertSinkSyntax(dto.replace('toVideoTaskView(task)', 'task /* toVideoTaskView(task) */'),
    'synthetic-dto.ts', ['toVideoTaskView', 'videoTaskViewSelect']));
  const tokens = ['source_metadata_json', 'projectSelectedMultiviewTask', 'multiviewOutputsOnly'];
  const source = `import { projectSelectedMultiviewTask } from 'synthetic';
    const args = { select: { id: true, source_metadata_json: true } };
    const multiviewOutputsOnly = true; const options = { multiviewOutputsOnly };
    const result = projectSelectedMultiviewTask(task);`;
  const check = (value: string) => assertSinkSyntax(value, 'synthetic-sink.ts', tokens);
  check(source);
  assert.throws(() => check(source.replace('source_metadata_json: true', '/* source_metadata_json: true */')));
  assert.throws(() => check(source.replace('source_metadata_json: true', 'source_metadata_json: false')));
  assert.throws(() => check(source.replace('select: { id: true, source_metadata_json: true }',
    'source_metadata_json: true, select: { id: true }')));
  assert.throws(() => check(source.replace('projectSelectedMultiviewTask(task)', 'task /* projectSelectedMultiviewTask(task) */')));
  assert.throws(() => check(source.replace("import { projectSelectedMultiviewTask } from 'synthetic';",
    '/* import projectSelectedMultiviewTask */')));
  assert.throws(() => check(source.replace('const options = { multiviewOutputsOnly }',
    'const options = { multiviewOutputsOnly: false }; /* multiviewOutputsOnly */')));
  assertSinkSyntax('function privateNoStore() { return {}; } privateNoStore();', 'synthetic-local.ts', ['privateNoStore']);
  assert.throws(() => assertSinkSyntax('function privateNoStore() { return {}; } /* privateNoStore(); */',
    'synthetic-local.ts', ['privateNoStore']));
  const predicate = "import { isPrivateMultiviewTask } from 'synthetic'; rows.filter(isPrivateMultiviewTask);";
  assertSinkSyntax(predicate, 'synthetic-predicate.ts', ['isPrivateMultiviewTask']);
  assert.throws(() => assertSinkSyntax(predicate.replace('rows.filter(isPrivateMultiviewTask)',
    'rows /* filter(isPrivateMultiviewTask) */'), 'synthetic-predicate.ts', ['isPrivateMultiviewTask']));
  const title = "import { MULTIVIEW_PUBLIC_TASK_TITLE } from 'synthetic'; const output = { prompt: MULTIVIEW_PUBLIC_TASK_TITLE };";
  assertSinkSyntax(title, 'synthetic-title.ts', ['MULTIVIEW_PUBLIC_TASK_TITLE']);
  assert.throws(() => assertSinkSyntax(title.replace('prompt: MULTIVIEW_PUBLIC_TASK_TITLE',
    "prompt: 'MULTIVIEW_PUBLIC_TASK_TITLE'"), 'synthetic-title.ts', ['MULTIVIEW_PUBLIC_TASK_TITLE']));
}

function assertTwentySinkStaticWiring(root: string) {
  assert.equal(SINK_WIRING.length, 20, 'The static sink inventory must stay at the reviewed 20 endpoints');
  assertSinkSyntaxRefusals();
  for (const [file, tokens] of SINK_WIRING) assertSinkSyntax(readFileSync(path.join(root, file), 'utf8'), file, tokens);
  for (const [file, tokens] of [
    ['src/lib/assets/picker-service.ts', ['ordinaryVideoTaskWhere', 'safeVideoTaskKeywordWhere', 'decideMedia']],
    ['src/lib/dto/video-task.ts', ['isPrivateMultiviewTask', 'projectPrivateMultiviewTask']],
    ['src/lib/dto/video-task-detail.ts', ['toVideoTaskView']],
    ['src/lib/media/legacy.ts', ['decideMedia']],
    ['src/lib/access/media-policy.ts', ['protectedSource', 'multiviewSystemReferenceFileAccess']],
  ] as const) assertSinkSyntax(readFileSync(path.join(root, file), 'utf8'), file, tokens);
  for (const file of ['src/lib/video/multiview-output-assets.server.ts', 'src/lib/video/multiview-work-render.ts']) {
    assertSinkSyntax(readFileSync(path.join(root, file), 'utf8'), file, ['parseMultiviewWorkManifest']);
  }
  const file = 'src/lib/image-studio/protected-assets.ts';
  assertSinkSyntax(readFileSync(path.join(root, file), 'utf8'), file, ['multiviewOutputFileAccess']);
}

function makePng(width = 1, height = 1) {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

async function main() {
  const candidateRoot = realpathSync(process.cwd());
  const scratch = path.join(candidateRoot, '.role-tests');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  chmodSync(scratch, 0o700);
  const receiptArgument = process.argv[2];
  assert.ok(receiptArgument, 'A new private receipt path under .role-tests is required');
  const receiptPath = path.resolve(candidateRoot, receiptArgument);
  const receiptRelative = path.relative(scratch, receiptPath);
  assert.ok(receiptRelative && !receiptRelative.startsWith(`..${path.sep}`) && receiptRelative !== '..' && !path.isAbsolute(receiptRelative),
    'The receipt must remain under .role-tests');
  const receiptParent = path.dirname(receiptPath);
  mkdirSync(receiptParent, { recursive: true, mode: 0o700 });
  assert.ok(realpathSync(receiptParent).startsWith(realpathSync(scratch) + path.sep) || realpathSync(receiptParent) === realpathSync(scratch),
    'The receipt parent must remain under the private scratch root');

  assert.equal(new Set(CHECKS).size, CHECKS.length, 'Check names must be unique');
  assert.equal(new Set(MULTIVIEW_PRIVATE_FIXTURE_SOURCES).size, MULTIVIEW_PRIVATE_FIXTURE_SOURCES.length,
    'Fixture sources must be unique');
  const initialHashes = sourceHashes(candidateRoot);
  const directory = mkdtempSync(path.join(scratch, 'multiview-private-'));
  const originalCwd = process.cwd();
  const guardedEnvironment = ['DATABASE_URL', 'NODE_ENV', 'SITE_PUBLIC_BASE_URL', 'BASE_URL', 'NEXTAUTH_URL', 'NEXT_PUBLIC_BASE_URL'] as const;
  const previousEnvironment = Object.fromEntries(guardedEnvironment.map(key => [key, process.env[key]]));
  const prismaGlobals = globalThis as typeof globalThis & { prismaSqlitePragmasStarted?: boolean };
  const hadPrismaSqlitePragmasStarted = Object.prototype.hasOwnProperty.call(prismaGlobals, 'prismaSqlitePragmasStarted');
  const previousPrismaSqlitePragmasStarted = prismaGlobals.prismaSqlitePragmasStarted;
  const originalFetch = globalThis.fetch;
  let forbiddenCalls = 0;

  try {
    Object.assign(process.env, { NODE_ENV: 'test' });
    process.env.DATABASE_URL = `file:${path.join(directory, 'never-open-application.db')}`;
    // Importing the real storage helper also imports the shared Prisma module.
    // Mark its one-time SQLite setup as already handled so the fixture's
    // deliberately unopened database cannot receive the three startup PRAGMAs.
    prismaGlobals.prismaSqlitePragmasStarted = true;
    for (const key of ['SITE_PUBLIC_BASE_URL', 'BASE_URL', 'NEXTAUTH_URL', 'NEXT_PUBLIC_BASE_URL'] as const) delete process.env[key];
    globalThis.fetch = async () => {
      forbiddenCalls += 1;
      throw new Error('External calls are prohibited in this synthetic fixture');
    };

    const privacy = await import('../src/lib/video/multiview-task-privacy');
    const generation = await import('../src/lib/video/multiview-generation-contract');
    const handoff = await import('../src/lib/video/multiview-reuse-handoff.client');
    const storage = await import('../src/lib/video/multiview-recipe-storage.server');
    assertPanelDefaultAndScopeContinuations(candidateRoot, generation);

    const secret = 'SYNTHETIC_PRIVATE_RECIPE_MUST_NOT_ESCAPE';
    const marker = privacy.multiviewPrivateTaskMarker('1.0.7');
    const protectedTask = {
      id: 'synthetic-protected-task', user_id: 'synthetic-owner', owner_user_id: 'synthetic-owner',
      local_status: 'failed', provider_status: 'failed', prompt: secret, final_prompt_snapshot: `${secret}:final`,
      params_json: JSON.stringify({ recipe: secret }), reference_image_ids: JSON.stringify([`${secret}:reference`]),
      source_metadata_json: JSON.stringify({ protected_module: marker, raw: secret, callback_token: `${secret}:callback` }),
      raw_response: { private: secret }, callback_url: `https://synthetic.invalid/${secret}`,
      error_message: 'permission denied by synthetic input', project: { id: 'project', name: 'Synthetic', type: 'personal', secret },
    };
    for (const actor of ['synthetic-owner', 'synthetic-peer']) {
      assert.ok(actor);
      const projected = privacy.projectPrivateMultiviewTask(protectedTask) as unknown as UnknownRecord;
      const serialized = JSON.stringify(projected);
      assert.equal(serialized.includes(secret), false);
      assert.equal(projected.prompt, privacy.MULTIVIEW_PUBLIC_TASK_TITLE);
      assert.equal(projected.reference_image_ids, null);
      assert.equal(projected.reference_image_urls, null);
      assert.equal(Object.prototype.hasOwnProperty.call(projected, 'params_json'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(projected, 'final_prompt_snapshot'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(projected, 'raw_response'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(projected, 'callback_url'), false);
    }
    assert.throws(() => privacy.projectPrivateMultiviewTask({ id: 'partial-without-protection-column' } as never), /保护字段未加载/);
    const corruptProtected = { id: 'corrupt', local_status: 'failed', prompt: secret,
      source_metadata_json: `{"protected_module":${secret}` };
    assert.equal(privacy.isPrivateMultiviewTask(corruptProtected), true);
    assert.equal(JSON.stringify(privacy.projectPrivateMultiviewTask(corruptProtected)).includes(secret), false);
    const unknownProtected = { id: 'unknown', local_status: 'failed', prompt: secret,
      source_metadata_json: JSON.stringify({ protected_module: { kind: 'future', schema: 99, recipeVersion: '99.0.0' } }) };
    assert.equal(privacy.isPrivateMultiviewTask(unknownProtected), true);
    assert.throws(() => privacy.readMultiviewPrivateTaskMarker(unknownProtected), /暂时无法确认/);
    assert.equal(JSON.stringify(privacy.projectPrivateMultiviewTask(unknownProtected)).includes(secret), false);

    const ordinaryFull = { id: 'ordinary-full', prompt: 'ordinary prompt', source_metadata_json: null, legacy: { kept: true } };
    assert.deepEqual(privacy.projectPrivateMultiviewTask(ordinaryFull), { id: ordinaryFull.id, prompt: ordinaryFull.prompt });
    const ordinaryPartial = { id: 'ordinary-partial', prompt: 'ordinary prompt', source_metadata_json: null, legacy: 'kept' };
    assert.deepEqual(privacy.projectSelectedMultiviewTask(ordinaryPartial), { id: ordinaryPartial.id, prompt: ordinaryPartial.prompt });

    const keywordWhere = privacy.safeVideoTaskKeywordWhere(secret) as UnknownRecord;
    assert.deepEqual(keywordWhere, { OR: [
      { id: { contains: secret } },
      { AND: [privacy.ordinaryVideoTaskWhere(), { prompt: { contains: secret } }] },
    ] });
    const publicTitleWhere = privacy.safeVideoTaskKeywordWhere('3D多视图') as UnknownRecord;
    assert.equal(Array.isArray(publicTitleWhere.OR) && publicTitleWhere.OR.length, 3);

    const forcedLedger = privacy.privateMultiviewLedgerMetadata(JSON.stringify({ task_id: protectedTask.id, amount: 2, raw: secret }), true);
    assert.ok(forcedLedger);
    assert.deepEqual(JSON.parse(forcedLedger), { task_id: protectedTask.id, amount: 2 });
    assert.equal(privacy.privateMultiviewLedgerMetadata(`{${secret}`, true), null);
    assert.equal(privacy.privateMultiviewLedgerMetadata(JSON.stringify({ source_metadata: { protected_module: marker }, raw: secret }), false), '{}');
    const failureCases = [
      ['insufficient credits', 'CREDITS_UNAVAILABLE'],
      ['permission denied', 'INPUT_PERMISSION_CHANGED'],
      ['reference image missing', 'INPUT_UNAVAILABLE'],
      ['content moderation rejected', 'PROVIDER_CONTENT_REJECTED'],
      ['network timeout', 'ORIGINAL_REQUEST_CHECK_REQUIRED'],
      ['synthetic provider failure', 'GENERATION_NOT_COMPLETED'],
    ] as const;
    for (const [message, code] of failureCases) {
      const failure = privacy.privateMultiviewFailure(message, code === 'ORIGINAL_REQUEST_CHECK_REQUIRED' ? 'unknown' : 'failed');
      assert.ok(failure);
      assert.equal(failure.code, code);
      assert.ok(!failure.message.includes(message));
      assert.match(failure.message, /请|核对|保留|调整/);
    }

    const draft = {
      ...generation.defaultMultiviewGenerationDraft('mv04-synthetic-private'),
      presetVersion: '1.0.7', projectId: 'synthetic-project', videoCardId: 'synthetic-card',
      mainImage: { assetId: 'synthetic-main-asset', referenceImageId: 'synthetic-main-reference' },
      supplement: 'synthetic own supplement', ratio: '1:1' as const, resolution: '480p' as const,
    };
    const preset = { id: generation.MULTIVIEW_ROTATION_PRESET.id, version: '1.0.7',
      defaults: { ...generation.MULTIVIEW_ROTATION_PRESET.defaults } };
    const request = generation.buildMultiviewGenerationRequest(draft, {
      idempotencyKey: 'synthetic-private-request', maxEstimatedCost: 1, preset,
    });
    assert.equal(request.multiview_generation.schema, 2);
    assert.equal(request.multiview_generation.mainReferenceImageId, draft.mainImage.referenceImageId);
    assert.equal(request.multiview_generation.supplement, draft.supplement);
    assert.deepEqual(Object.keys(request.multiview_generation).sort(), [
      'mainAssetId', 'mainReferenceImageId', 'presetId', 'presetVersion', 'schema', 'supplement', 'workspaceTabId',
    ]);
    const requestJson = JSON.stringify(request);
    for (const forbidden of ['prompt', 'final_prompt_snapshot', 'compositionReference', 'system_reference', 'guide']) {
      assert.equal(Object.prototype.hasOwnProperty.call(request, forbidden), false);
      assert.equal(Object.prototype.hasOwnProperty.call(request.multiview_generation, forbidden), false);
    }
    assert.equal(requestJson.includes(secret), false);
    const privatePreset = { ...preset, prompt: secret, compositionReference: {
      assetId: 'synthetic-guide-asset', referenceImageId: 'synthetic-guide-reference', ownerId: 'synthetic-guide-owner', sha256: 'a'.repeat(64),
    } };
    assert.deepEqual(generation.publicMultiviewRotationPreset(
      privatePreset as Parameters<typeof generation.publicMultiviewRotationPreset>[0],
    ), preset);
    const patched = handoff.applyMultiviewReusePatch(generation.defaultMultiviewGenerationDraft('mv04-handoff'), {
      provider: 'seedance', model: draft.model, ratio: draft.ratio, duration: draft.duration, resolution: draft.resolution,
      supplement: draft.supplement, seed: draft.seed, generateAudio: false, returnLastFrame: false, watermark: false,
      projectId: draft.projectId, videoCardId: draft.videoCardId, mainImage: draft.mainImage,
      prompt: secret, guide: secret, finalPrompt: secret,
    } as never);
    assert.ok(patched);
    assert.equal(JSON.stringify(patched).includes(secret), false);
    assert.equal(Object.prototype.hasOwnProperty.call(patched, 'settingsBinding'), false);

    process.chdir(directory);
    const recipeRoot = path.join(directory, '.cache', 'multiview-recipes');
    mkdirSync(recipeRoot, { recursive: true, mode: 0o700 });
    chmodSync(recipeRoot, 0o700);
    const png = makePng(), guideSha = sha256(png);
    const guidePath = path.join(recipeRoot, `${guideSha}.png`);
    writeFileSync(guidePath, png, { flag: 'wx', mode: 0o600 });
    const binding = { assetId: 'synthetic-guide-asset', referenceImageId: 'synthetic-guide-reference',
      ownerId: 'synthetic-guide-owner', sha256: guideSha };
    const oldUrl = '/uploads/synthetic-private/old-guide.png';
    const currentUrl = '/uploads/synthetic-private/current-guide.png';
    const recipeRow = { value_json: JSON.stringify({ preset: { compositionReference: binding } }) };
    const durableRow = { key: storage.MULTIVIEW_PRIVATE_MEDIA_ACCESS_PREFIX + guideSha, value_json: JSON.stringify({
      schema: 1, kind: 'system-reference', assetId: binding.assetId, ownerId: binding.ownerId, sha256: guideSha, urls: [oldUrl],
    }) };
    const makeDb = (options: { assetPresent?: boolean; unknownDurable?: boolean } = {}) => ({
      asset: {
        findUnique: async () => options.assetPresent === false ? null : ({
          id: binding.assetId, owner_id: binding.ownerId, status: 'active', type: 'image', mime_type: 'image/png', hash: guideSha,
          file_size: png.length, width: 1, height: 1, original_url: currentUrl, thumbnail_url: null,
        }),
        findMany: async () => options.assetPresent === false ? [] : [{ id: binding.assetId, original_url: currentUrl, thumbnail_url: null }],
      },
      referenceImage: { findUnique: async () => ({ id: binding.referenceImageId, owner_user_id: binding.ownerId,
        asset_id: binding.assetId, status: 'active' }) },
      user: { findUnique: async () => ({ status: 'active' }) },
      platformSetting: { findMany: async (query: UnknownRecord) => {
        const serialized = JSON.stringify(query);
        if (serialized.includes(storage.MULTIVIEW_PRIVATE_MEDIA_ACCESS_PREFIX)) {
          return options.unknownDurable ? [{ ...durableRow, value_json: JSON.stringify({ schema: 99, raw: secret }) }] : [durableRow];
        }
        return [recipeRow];
      } },
    });
    const activeDb = makeDb();
    const readGuide = await storage.readMultiviewSystemReference(binding, activeDb as never);
    assert.equal(readGuide.sha256, guideSha);
    assert.deepEqual(readGuide.bytes, png);
    const owner = { id: binding.ownerId, role: 'user', account_type: 'internal', status: 'active' };
    const peer = { id: 'synthetic-peer', role: 'user', account_type: 'internal', status: 'active' };
    assert.deepEqual(await storage.hiddenMultiviewSystemReferenceUrls(owner, activeDb as never), []);
    assert.ok((await storage.hiddenMultiviewSystemReferenceUrls(peer, activeDb as never)).includes(oldUrl));
    assert.ok((await storage.hiddenMultiviewSystemReferenceUrls(null, activeDb as never)).includes(oldUrl));
    assert.deepEqual(await storage.multiviewSystemReferenceFileAccess(owner, oldUrl, activeDb as never), { protected: true, allowed: true });
    assert.deepEqual(await storage.multiviewSystemReferenceFileAccess(peer, oldUrl, activeDb as never), { protected: true, allowed: false });
    assert.deepEqual(await storage.multiviewSystemReferenceFileAccess(null, oldUrl, activeDb as never), { protected: true, allowed: false });
    const deletedDb = makeDb({ assetPresent: false });
    assert.deepEqual(await storage.multiviewSystemReferenceFileAccess(peer, oldUrl, deletedDb as never), { protected: true, allowed: false });
    assert.deepEqual(await storage.multiviewSystemReferenceFileAccess(null, oldUrl, deletedDb as never), { protected: true, allowed: false });
    const unknownDb = makeDb({ unknownDurable: true });
    await assert.rejects(storage.hiddenMultiviewSystemReferenceUrls(peer, unknownDb as never));
    await assert.rejects(storage.multiviewSystemReferenceFileAccess(peer, oldUrl, unknownDb as never));

    process.chdir(candidateRoot);
    assertTwentySinkStaticWiring(candidateRoot);
    assert.deepEqual(sourceHashes(candidateRoot), initialHashes, 'Fixture sources changed during the engineering gate');
    assert.equal(forbiddenCalls, 0);

    const runId = process.env.IMAGE_RECOVERY_GATE_RUN_ID;
    const receipt = {
      schema: 'multiview-private-engineering.v1', completed: true, synthetic: true,
      applicationDatabaseOpened: false, productionWrites: 0, forbiddenCalls: 0, paidRequests: 0, browserRuns: 0,
      checks: [...CHECKS], sourceSha256: initialHashes, candidateRoot,
      ...(runId ? { runId } : {}),
    };
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 });
    console.log('Multiview private engineering: PASS');
  } finally {
    process.chdir(originalCwd);
    globalThis.fetch = originalFetch;
    for (const key of guardedEnvironment) {
      const value = previousEnvironment[key];
      if (value === undefined) delete process.env[key];
      else Object.assign(process.env, { [key]: value });
    }
    if (hadPrismaSqlitePragmasStarted) prismaGlobals.prismaSqlitePragmasStarted = previousPrismaSqlitePragmasStarted;
    else delete prismaGlobals.prismaSqlitePragmasStarted;
    rmSync(directory, { recursive: true, force: true });
  }
}

void main().catch(error => {
  const failure = syntheticFailureDiagnostic(error);
  console.error(`Multiview private engineering failed [phase=${failure.phase}; name=${failure.name}; code=${failure.code}; at=${failure.location}; missing=${failure.missing}]`);
  process.exitCode = 1;
});
