const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const ts = require('typescript');

const read = path => readFileSync(path, 'utf8');
const policy = {};
runInNewContext(ts.transpileModule(read('src/lib/navigation.ts'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { exports: policy, require(name) {
  assert.ok(['@/lib/cutout/access', '@/lib/access/external-role'].includes(name));
  return {};
} });

assert.equal(policy.workspaceSection('/points/claim'), 'points/claim', 'claim uses the shared workspace shell');
assert.equal(policy.shouldUseNavigationShell('/points/claim'), true);
assert.equal(policy.shouldUseTopbarOnlyShell('/points/claim'), false);
for (const path of ['/points', '/points/claims', '/points/claim/other', '/admin/points/claims']) {
  assert.equal(policy.workspaceSection(path), undefined, `unrelated route keeps its existing shell: ${path}`);
}
for (const section of ['assets', 'projects', 'tasks', 'collections', 'usage', 'pricing', 'account', 'notifications', 'help']) {
  assert.equal(policy.workspaceSection(`/${section}`), section);
}
for (const section of ['projects', 'tasks', 'collections']) {
  assert.equal(policy.workspaceSection(`/${section}/example`), section);
}

const text = read('src/components/home/WorkspaceSidebar.tsx');
const tree = ts.createSourceFile('WorkspaceSidebar.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const entries = [];
function visit(node) {
  if (ts.isObjectLiteralExpression(node)) {
    const properties = new Map(node.properties.filter(ts.isPropertyAssignment).map(p => [p.name.getText(tree), p.initializer]));
    if (properties.get('href')?.text === '/points/claim') entries.push(properties);
  }
  ts.forEachChild(node, visit);
}
visit(tree);
assert.equal(entries.length, 1, 'one shared entry serves expanded, collapsed and mobile menus');
assert.equal(entries[0].get('title').text, '领取积分');
assert.equal(entries[0].get('icon').getText(tree), 'Gift');
assert.equal(entries[0].get('current').getText(tree), "current === 'points/claim'");
assert.equal(entries[0].get('visible').kind, ts.SyntaxKind.TrueKeyword);
console.log('PASS claim workspace routing, unchanged routes and shared accessible navigation entry (no network or database)');
