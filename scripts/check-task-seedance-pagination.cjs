const assert = require('node:assert/strict');
const fs = require('node:fs');
const { ts, sharedCursor } = require('./audit-task-pagination-loader.cjs');
const { assertOriginalNode } = require('./pagination-static-baseline.cjs');
const files = ['src/lib/pagination/created-page.ts', 'src/lib/pagination/seedance-pages.ts', 'src/lib/pagination/use-seedance-pages.ts',
  'src/app/api/video/list/route.ts', 'src/app/api/ip/video/list/route.ts', 'src/app/api/video-cards/[id]/tasks/route.ts',
  'src/lib/assets/seedanceAssetRepository.ts', 'src/app/api/assets/list/route.ts', 'src/components/SeedanceAssetPanel.tsx'];
const read = file => fs.readFileSync(file, 'utf8');
for (const file of files) {
  const result = ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }, reportDiagnostics: true });
  assert.equal(result.diagnostics?.filter(value => value.category === ts.DiagnosticCategory.Error).length || 0, 0, file);
}
for (const file of files.filter(file => file.endsWith('route.ts'))) {
  assert.match(read(file), /apiRoute\(/); assert.match(read(file), /apiErrorResponse\(/); assert.match(read(file), /PaginationError/);
}
const normal = 'src/app/api/video/list/route.ts';
const adapter = read(files[0]);
assert.match(adapter, /readPageCursor/); assert.match(adapter, /writePageCursor/); assert.match(adapter, /requireSecret\('media'\)/);
assert.doesNotMatch(adapter, /createHmac|timingSafeEqual|base64url/);
assert.match(adapter, /take: limit \+ 1/); assert.match(adapter, /rows\.slice\(0, limit\)/);
assertOriginalNode(normal, 'serializeTaskListItem');
const card = 'src/app/api/video-cards/[id]/tasks/route.ts';
assertOriginalNode(card, 'PATCH');
const panel = files.at(-1);
for (const name of ['handleCreate', 'handleRename', 'handleRemove', 'handleProviderDelete', 'handleLocalUpload']) assertOriginalNode(panel, name);
const repository = 'src/lib/assets/seedanceAssetRepository.ts';
for (const name of ['toApiRecord', 'create', 'update', 'updateByProviderId', 'softDelete', 'markProviderDeleted', 'markDeleteFailed', 'createWithStorageMetadata']) assertOriginalNode(repository, name);
assert.match(read(panel), /useSeedanceAssetPages\(visible, includeDeleted\)/);
assert.match(read('src/lib/pagination/use-seedance-pages.ts'), /value\.scope === key/);
assert.doesNotMatch(read('src/lib/pagination/seedance-pages.ts'), /localStorage|sessionStorage|method: 'POST'|method: 'PATCH'|method: 'DELETE'/);
console.log(JSON.stringify({ syntax: 'pass', sharedRealCursorFixture: sharedCursor, positiveErrorWrappersPreserved: true,
  mutationAndProviderDeleteBodiesUnchanged: true, notes: 'Not full typecheck/build/browser/native acceptance. Selector consumer closure has its own focused checker.' }));
