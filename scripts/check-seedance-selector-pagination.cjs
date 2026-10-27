const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { ts } = require('./audit-task-pagination-loader.cjs');
const file = 'src/components/SeedanceAssetSelector.tsx', source = fs.readFileSync(file, 'utf8');
const old = execFileSync('git', ['show', 'c47cd971:' + file], { encoding: 'utf8' });
const parsed = value => ts.createSourceFile(file, value, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function named(value, name) {
  const tree = parsed(value); let result;
  const visit = node => { if (node.name?.getText(tree) === name && ts.isVariableDeclaration(node)) result = node.getText(tree); ts.forEachChild(node, visit); };
  visit(tree); assert.ok(result, name); return result;
}
for (const name of ['handleSelect', 'handleRemove', 'handleMoveUp', 'handleMoveDown']) assert.equal(named(source, name), named(old, name), name);
const syntax = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  jsx: ts.JsxEmit.ReactJSX }, reportDiagnostics: true });
assert.equal(syntax.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length || 0, 0);
assert.match(source, /useSeedanceAssetPages\(true, false\)/);
assert.match(source, /id: asset\.localId/); assert.match(source, /localStatus: asset\.status/);
assert.match(source, /asset\.assetType === 'Image' && asset\.status === 'Active'/);
assert.match(source, /asset\.ownershipStatus === 'owned' && Boolean\(asset\.ownerId\) && Boolean\(asset\.originalUrl\)/);
assert.doesNotMatch(source, /\bfetch\(|localStorage|sessionStorage/);
assert.match(source, /selectionTarget\.current !== onSelect/);
assert.match(source, /pages\.scope !== currentScope/);
for (const unchanged of ['src/components/SeedanceAssetPanel.tsx', 'src/lib/pagination/use-seedance-pages.ts',
  'src/lib/pagination/seedance-pages.ts', 'src/lib/assets/seedanceAssetRepository.ts', 'src/app/api/assets/list/route.ts']) {
  assert.equal(fs.readFileSync(unchanged, 'utf8'), execFileSync('git', ['show', 'c47cd971:' + unchanged], { encoding: 'utf8' }), unchanged);
}
const hits = execFileSync('rg', ['-l', '/api/assets/list', 'src'], { encoding: 'utf8' }).trim().split('\n').sort();
assert.deepEqual(hits, ['src/app/api/assets/list/route.ts', 'src/lib/pagination/seedance-pages.ts']);
const clients = execFileSync('rg', ['-l', 'useSeedanceAssetPages\\(', 'src/components'], { encoding: 'utf8' }).trim().split('\n').sort();
assert.deepEqual(clients, ['src/components/SeedanceAssetPanel.tsx', 'src/components/SeedanceAssetSelector.tsx']);
console.log(JSON.stringify({ syntax: 'pass', selectionRemoveAndOrderCallbacksUnchanged: true,
  sharedHookPanelApiRepositoryUnchanged: true, directListReaders: hits, incrementalConsumers: clients,
  acceptance: 'Bounded source/SSR event contracts only; no browser, native database or full build acceptance.' }));
