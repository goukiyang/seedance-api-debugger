const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const test = require('node:test');
const root = path.resolve(__dirname, '..');
const source = file => ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function find(ast, predicate) { const nodes = []; const visit = node => { if (predicate(node)) nodes.push(node); ts.forEachChild(node, visit); }; visit(ast); return nodes; }
function moduleFrom(text, dependencies = {}) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, Buffer, require: name => { if (name in dependencies) return dependencies[name]; if (name.startsWith('node:') || name === 'crypto') return require(name); throw Error(name); } });
  return module.exports;
}
test('actual creation intent freezes an explicit notification choice; old inputs stay unchanged', () => {
  const ast = source('src/lib/creation/intents.ts');
  const fields = find(ast, n => ts.isVariableDeclaration(n) && n.name.getText(ast) === 'INPUT_FIELDS')[0];
  const normalize = find(ast, n => ts.isFunctionDeclaration(n) && n.name?.text === 'normalizeVideoCreationSpec')[0];
  const contract = moduleFrom(fs.readFileSync(path.join(root, 'src/lib/creation/contract.ts'), 'utf8'));
  const video = moduleFrom(fs.readFileSync(path.join(root, 'src/lib/video/feishu-contract.ts'), 'utf8'));
  const canvas = moduleFrom(fs.readFileSync(path.join(root, 'src/lib/canvas-references.ts'), 'utf8'));
  const work = moduleFrom(`const { CreationError, creationIdentity } = require('contract'); const { normalizeVideoFeishuChoice, VideoFeishuError } = require('video'); const { normalizeCanvasReferences } = require('canvas'); const ${fields.getText(ast)}; ${normalize.getText(ast)}`,
    { contract, video, canvas }).normalizeVideoCreationSpec;
  const body = { project_id: 'project', model: 'seedance-2.0', duration: 5, resolution: '720p', count: 2 };
  const before = work(body), enabled = { version: 1, enabled: true, preferenceRevision: 2 };
  assert.equal(before.input.video_feishu, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(work({ ...body, video_feishu: enabled }).input.video_feishu)), enabled);
  for (const invalid of [{ ...enabled, recipientId: 'foreign' }, { ...enabled, enabled: 'true' }, { ...enabled, preferenceRevision: -1 }]) assert.throws(() => work({ ...body, video_feishu: invalid }), error => error instanceof contract.CreationError && error.status === 400);
  const after = work({ ...body, video_feishu: enabled }); delete after.input.video_feishu;
  assert.equal(JSON.stringify(after), JSON.stringify(before));
});
test('both actual creation routes enqueue only after a new task write in the same original transaction', () => {
  for (const file of ['src/app/api/tasks/create/route.ts', 'src/app/api/ip/tasks/create/route.ts']) {
    const ast = source(file), calls = find(ast, n => ts.isCallExpression(n) && n.expression.getText(ast) === 'enqueueVideoFeishuNotification');
    assert.equal(calls.length, 1, file + ' actual new-task enqueue missing');
    const call = calls[0];
    assert.deepEqual(call.arguments.map(n => n.getText(ast)), ['tx', 'user.id', 'task', 'creationBody.video_feishu']);
    let transaction = call.parent;
    while (transaction && !ts.isArrowFunction(transaction)) transaction = transaction.parent;
    assert.ok(transaction && ts.isCallExpression(transaction.parent) && transaction.parent.expression.getText(ast) === 'prisma.$transaction');
    const writes = find(transaction.body, n => ts.isCallExpression(n) && n.expression.getText(ast) === 'tx.videoTask.create');
    assert.equal(writes.length, 1); assert.ok(writes[0].end < call.pos, 'must follow actual new Task write');
    assert.equal(find(transaction.body, n => ts.isCallExpression(n) && n.expression.getText(ast) === 'acceptVideoCreationIntent').length, 1);
    const params = find(ast, n => ts.isVariableDeclaration(n) && n.name.getText(ast) === 'taskParams')[0];
    assert.match(params.getText(ast), /video_feishu/);
  }
});
test('canvas child input whitelist carries only an explicitly supplied choice, never a saved preference', () => {
  const ast = source('src/lib/canvas-video-batches.ts');
  const fields = find(ast, n => ts.isVariableDeclaration(n) && n.name.getText(ast) === 'inputFields')[0];
  const values = vm.runInNewContext(ts.transpileModule(fields.initializer.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);
  assert.ok(values.has('video_feishu'));
  assert.ok(!fields.getText(ast).includes('Preference'));
});
