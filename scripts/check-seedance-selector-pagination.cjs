const assert = require('node:assert/strict');
const fs = require('node:fs');
const { ts } = require('./audit-task-pagination-loader.cjs');
const { assertOriginalNode, assertOriginalFile, sourceFilesContaining } = require('./pagination-static-baseline.cjs');
const file = 'src/components/SeedanceAssetSelector.tsx', source = fs.readFileSync(file, 'utf8');
for (const name of ['handleSelect', 'handleRemove', 'handleMoveUp', 'handleMoveDown']) assertOriginalNode(file, name);
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
  assertOriginalFile(unchanged);
}
const hits = sourceFilesContaining('src', '/api/assets/list');
assert.deepEqual(hits, ['src/app/api/assets/list/route.ts', 'src/lib/pagination/seedance-pages.ts']);
const clients = sourceFilesContaining('src/components', 'useSeedanceAssetPages(');
assert.deepEqual(clients, ['src/components/SeedanceAssetPanel.tsx', 'src/components/SeedanceAssetSelector.tsx']);
console.log(JSON.stringify({ syntax: 'pass', selectionRemoveAndOrderCallbacksUnchanged: true,
  sharedHookPanelApiRepositoryUnchanged: true, directListReaders: hits, incrementalConsumers: clients,
  acceptance: 'Bounded source/SSR event contracts only; no browser, native database or full build acceptance.' }));
