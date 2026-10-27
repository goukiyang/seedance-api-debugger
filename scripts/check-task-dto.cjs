const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const dtoCalls = new Set(['toVideoTaskView', 'toVideoTaskDetail', 'toIpVideoTaskDetail',
  'projectSelectedMultiviewTask', 'projectPrivateMultiviewTask']);
const rawFields = new Set(['raw_create_response', 'raw_status_response', 'params_json', 'callback_url',
  'credit_freeze_snapshot', 'provider_payload_json', 'reference_images_json', 'provider_usage_snapshot']);
function inspectTaskDto(file, source) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const findings = [], bindings = new Map();
  function report(node, message) { findings.push(`${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}: ${message}`); }
  function index(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) bindings.set(node.name.text, node.initializer);
    ts.forEachChild(node, index);
  }
  index(tree);
  function response(node, seen = new Set()) {
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (ts.isCallExpression(node) && dtoCalls.has(node.expression.getText(tree))) return;
    if (ts.isConditionalExpression(node)) { response(node.whenTrue, seen); response(node.whenFalse, seen); return; }
    if (ts.isBinaryExpression(node)) { response(node.right, seen); return; }
    if (ts.isIdentifier(node)) {
      const value = bindings.get(node.text);
      if (value) response(value, seen);
      return;
    }
    if (ts.isAwaitExpression(node) && ts.isCallExpression(node.expression)
      && /\.videoTask\.(findUnique|findFirst|findMany|update|create)$/.test(node.expression.expression.getText(tree))) {
      report(node, 'Database task row must pass through a task DTO before JSON serialization'); return;
    }
    if (ts.isSpreadAssignment(node) && /^(?:task|row|originalTask|updatedTask|responseTask|finalTask|visibleTask)(?:\.|$)/.test(node.expression.getText(tree))) {
      report(node, 'Task row spread in browser response; use the shared task DTO'); return;
    }
    if (ts.isPropertyAssignment(node)) {
      if (rawFields.has(node.name.getText(tree)) && file !== 'src/app/api/admin/tasks/[id]/debug/route.ts') {
        report(node, 'Raw task field in browser response');
      }
      response(node.initializer, seen); return;
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) { response(node.body, seen); return; }
    if (ts.isBlock(node)) {
      for (const statement of node.statements) if (ts.isReturnStatement(statement)) response(statement.expression, seen);
      return;
    }
    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'map') {
        response(node.arguments[0], seen);
      }
      return;
    }
    if (ts.isPropertyAccessExpression(node)) return;
    // Follow JSON object/array members, map callbacks and referenced result variables, not unrelated handler statements.
    ts.forEachChild(node, child => response(child, seen));
  }
  function walk(node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(tree);
      if (/\.videoTask\.(findUnique|findFirst|findMany)$/.test(callee)) {
        const query = node.arguments[0];
        if (query && ts.isObjectLiteralExpression(query) && query.properties.some(p => p.name?.getText(tree) === 'include')) {
          report(node, 'Task queries must select explicit fields, not include the full database row');
        }
      }
      if (/^(?:NextResponse|Response)\.json$/.test(callee)) response(node.arguments[0]);
    }
    ts.forEachChild(node, walk);
  }
  walk(tree);
  return [...new Set(findings)];
}
module.exports = { inspectTaskDto };
if (require.main === module) {
  const findings = ['src/app/api', 'src/server'].flatMap(root => fs.readdirSync(root, { recursive: true })
    .filter(name => root === 'src/server' ? name.endsWith('.ts') : name.endsWith('/route.ts'))
    .flatMap(name => { const file = path.join(root, name); return inspectTaskDto(file, fs.readFileSync(file, 'utf8')); }));
  findings.forEach(value => console.error(value));
  console.log(JSON.stringify({ schema: 'task-dto-contract.v1', failures: findings.length }));
  process.exitCode = findings.length ? 1 : 0;
}
