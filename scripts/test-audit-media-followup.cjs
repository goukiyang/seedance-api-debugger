'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { fixturePlan } = require('./prepare-audit-media-fixture.cjs');
const root = process.cwd();
const results = [];
function check(name, run) {
  try { run(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: error.message }); }
}
const compile = (file) => ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  fileName: file, reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.Preserve },
});
const source = compile('src/lib/media/browser-asset.ts');
const context = { exports: {} };
vm.runInNewContext(source.outputText, context, { filename: 'browser-asset.js' });
const { browserUploadAsset } = context.exports;
const proof = Object.freeze({ requestId: 'synthetic-original-request', verified: true, assetDisposition: 'new', sourceVersion: 'synthetic-version' });
const input = Object.freeze({ id: 'synthetic-upload', originalUrl: '/uploads/assets/never-display.png', thumbnailUrl: '/uploads/thumbs/never-display.webp',
  hash: 'b'.repeat(64), fileSize: 100, mimeType: 'image/png', upload: proof, unknownSourceField: '/private/never-copy' });
const media = { ref: { type: 'asset', id: input.id }, originalUrl: '/m/asset/synthetic-upload/original?synthetic=1',
  previewUrl: '/m/asset/synthetic-upload/preview?synthetic=1', thumbnailUrl: '/m/asset/synthetic-upload/thumbnail?synthetic=1', canUse: true, canDownload: true };
check('response projection never copies canonical storage addresses or unknown fields', () => {
  const result = browserUploadAsset(input, media);
  assert.equal(result.originalUrl, media.originalUrl);
  assert.equal(result.thumbnailUrl, media.thumbnailUrl);
  assert.equal(Object.hasOwn(result, 'unknownSourceField'), false);
  assert(!JSON.stringify(result).includes('/uploads/') && !JSON.stringify(result).includes('/private/'));
});
check('projection retains the exact durable request proof without mutating the source', () => {
  const before = JSON.stringify(input), result = browserUploadAsset(input, media);
  assert.equal(result.id, input.id); assert.equal(result.hash, input.hash);
  assert.equal(result.upload, proof); assert.equal(JSON.stringify(input), before);
  assert.equal(result.isPubliclyReachable, false);
});
check('use-only projection selects a rendition and never manufactures an original grant', () => {
  const useOnly = { ...media, originalUrl: null, canDownload: false };
  const result = browserUploadAsset(input, useOnly);
  assert.equal(result.originalUrl, useOnly.previewUrl);
  assert.equal(result.media.originalUrl, null); assert.equal(result.media.canDownload, false);
});
check('temporarily unavailable media keeps the completed receipt and exposes no source path', () => {
  const result = browserUploadAsset(input, null);
  assert.equal(result.id, input.id); assert.equal(result.hash, input.hash); assert.equal(result.upload, proof);
  assert.equal(result.originalUrl, null); assert.equal(result.thumbnailUrl, null); assert.equal(result.mediaUnavailable, true);
});
check('fresh fixture path ignores inherited DATABASE_URL and stays under the isolated evidence root', () => {
  const plan = fixturePlan(root, 'synthetic-followup');
  assert.equal(plan.databaseUrl, `file:${root}/.role-tests/media-fixtures/synthetic-followup/audit-media.db`);
});
for (const id of ['', '../user-data', '/tmp/outside', 'contains space', 'a'.repeat(81)]) {
  check(`fixture rejects unsafe run ID ${JSON.stringify(id)}`, () => assert.throws(() => fixturePlan(root, id)));
}
check('all newly edited TS sources transpile without loading Prisma or application dependencies', () => {
  const files = ['scripts/test-audit-media.ts', 'src/lib/media/browser-asset.ts', 'src/lib/media/browser-projection.server.ts',
    'src/lib/assets/workspace.ts', 'src/app/api/workspace/route.ts',
    ...['upload', 'upload-ticket', 'upload-proxy', 'upload-complete', 'upload/recover', 'multipart/start', 'multipart/complete']
      .map(entry => `src/app/api/assets/${entry}/route.ts`)];
  for (const file of files) {
    const errors = (compile(file).diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error);
    assert.equal(errors.length, 0, `${file}: ${errors.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')).join('\n')}`);
  }
});
check('each audited upload and recovery HTTP entrypoint invokes the response-only projection', () => {
  for (const entry of ['upload', 'upload-ticket', 'upload-proxy', 'upload-complete', 'upload/recover', 'multipart/start', 'multipart/complete']) {
    const file = `src/app/api/assets/${entry}/route.ts`, text = fs.readFileSync(file, 'utf8');
    assert(text.includes('browserUploadResponse(user,'), file);
  }
  const text = fs.readFileSync('src/app/api/assets/upload/route.ts', 'utf8');
  assert.equal((text.match(/if \(asset\) return NextResponse\.json\(\{ success: true, asset \}\)/g) || []).length, 0);
  assert.equal((text.match(/browserUploadResponse\(user, \{ success: true, asset \}/g) || []).length, 3);
});
check('Seedance fixture requires per-operation audit deltas, unknown409/no-resend and successful response proof', () => {
  const text = fs.readFileSync('scripts/test-audit-media.ts', 'utf8');
  for (const expected of ['requestedBefore + 1', 'successRequestedBefore + 1', 'successCompletedBefore + 1',
    'assert.equal(unknownResponse.status, 502)', 'assert.equal(calls, 1', 'assert.equal(successCalls, 1)',
    "{ success: true, localId: 'media-delete-success', status: 'ProviderDeleted' }"])
    assert(text.includes(expected), expected);
  assert(text.includes('providerRoute.DELETE(request(), params))).status, 409'));
});
const evidence = { scope: 'pure response projection, fixture fencing, syntax and caller/source checks only',
  realPrismaExecuted: false, fullTypecheckExecuted: false, providerOrBrowserCalls: false,
  permissionAndSuccessBehaviorRequiresLeadServerRun: true, results,
  passed: results.filter(row => row.ok).length, failed: results.filter(row => !row.ok).length };
const checkId = process.env.MEDIA_FOLLOWUP_CHECK_ID || 'local';
assert.match(checkId, /^[a-zA-Z0-9_-]{1,80}$/);
fs.writeFileSync(path.join(root, '.role-tests', `audit-media-followup-${checkId}.json`), JSON.stringify(evidence, null, 2), { flag: 'wx' });
console.log(JSON.stringify(evidence));
if (evidence.failed) process.exitCode = 1;
