const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { ts, sharedCursor } = require('./audit-task-pagination-loader.cjs');
const service = 'src/lib/video/multiview-records.server.ts', ui = 'src/app/multiview/MultiviewRecords.tsx';
const files = [service, ui, 'src/app/multiview/multiview-record-pages.ts', 'src/app/api/video/multiview/records/route.ts'];
const read = file => fs.readFileSync(file, 'utf8');
for (const file of files) {
  const tree = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  assert.equal(tree.parseDiagnostics.length, 0, file);
  const result = ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }, reportDiagnostics: true });
  assert.equal(result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length || 0, 0, file);
}
const server = read(service), client = read(ui), helper = read(files[2]);
assert.match(server, /batchSize = 100/); assert.match(server, /readPageCursor/); assert.match(server, /writePageCursor/);
assert.match(server, /requireSecret\('media'\)/); assert.match(server, /currentMultiviewActor\(user\)/);
assert.doesNotMatch(server, /new Map|new Set|Array\.from|offset|base64url|recipe_json|manifest_json|readFile|from 'node:fs|createHmac/);
assert.match(server, /items\.length === limit/); assert.match(server, /items\.pop\(\)/);
assert.match(server, /source_id: ''/); assert.match(server, /by: \['source_id', 'source_task_id'\]/);
assert.match(server, /row\?\.project_id === projectId && await allowed/);
assert.match(server, /raw\[width\] !== fingerprint/);
function nodeText(source, name) {
  const tree = ts.createSourceFile(ui, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); let result;
  const visit = node => { if (ts.isFunctionDeclaration(node) && node.name?.text === name) result = node.getText(tree); ts.forEachChild(node, visit); };
  visit(tree); assert.ok(result); return result;
}
assert.equal(nodeText(client, 'RecordCard'), nodeText(execFileSync('git', ['show', '902d4f99:' + ui], { encoding: 'utf8' }), 'RecordCard'));
assert.match(client, /await loadMultiviewRecordProjects/); assert.match(client, /setProjectId\(previous =>/);
assert.match(client, /loadedScope === recordScope \? items : \[\]/); assert.match(client, /captured === directoryScopeRef\.current/);
assert.match(client, /captured === recordScopeRef\.current/); assert.match(client, /\[400, 401, 403, 409\]/);
assert.doesNotMatch(client, /setProjects\(data\.projects\)/);
assert.match(helper, /projects\.size !== total/); assert.match(helper, /options\.current\(\)/);
console.log(JSON.stringify({ syntax: 'pass', sharedRealCursorFixture: sharedCursor, batchMax: 100, retainedCandidatesMax: 100,
  RecordCardAndExistingActionsUnchanged: true, projectsCompleteBeforePreferenceValidation: true,
  note: 'Not native Prisma, full typecheck/build or browser acceptance. Central multiview-work-api PaginationError/errorID handling remains lead-owned.' }));
