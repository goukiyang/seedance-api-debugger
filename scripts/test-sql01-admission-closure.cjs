const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function calls(file, name) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const fn = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(fn, name);
  const result = [];
  const visit = node => { if (ts.isCallExpression(node)) result.push(node); ts.forEachChild(node, visit); };
  visit(fn.body);
  return { tree, result };
}
for (const [file, name] of [['src/lib/creation/lineage.ts', 'readCreationSource'],
  ['src/lib/canvas-video-batches-guards.ts', 'assertCanvasVideoAdmission']]) {
  const { tree, result } = calls(file, name);
  const access = result.filter(node => node.expression.getText(tree) === 'assertCanViewTask');
  assert.ok(access.length > 0);
  for (const call of access) assert.equal(call.arguments[2]?.getText(tree), 'db', name + ': task authority must stay on the caller connection');
  const routes = result.filter(node => node.expression.getText(tree) === 'canvasVideoRouteFingerprint');
  if (routes.length) {
    assert.equal(routes.length, 1, 'The fresh transaction route check must not reenter a global connection first');
    assert.equal(routes[0].arguments[1]?.getText(tree), 'db');
  }
}
console.log('PASS SQL01 lineage and canvas admission keep task authority and route checks on caller transaction');
