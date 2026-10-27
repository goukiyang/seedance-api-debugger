const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
Object.assign(process.env, { NODE_ENV: 'test', SESSION_SECRET: 'synthetic-mv-error-secret-not-production' });
require('tsx/cjs');
const apiErrors = require('../src/lib/http/api-error.ts');
const { PaginationError } = require('../src/lib/pagination/cursor.ts');
class AuthError extends Error { constructor(message, status = 403) { super(message); this.status = status; } }
class MultiviewError extends Error {}
class MultiviewWorkError extends Error { constructor(message, status = 409, code = 'WORK_CONFLICT', details) {
  super(message); Object.assign(this, { status, code, details });
} }
const dependencies = {
  'next/server': { NextResponse: { json: Response.json } },
  '@/lib/auth/session': { getSession: async () => ({ id: 'owner' }), AuthError },
  './multiview': { MultiviewError }, './multiview-works': { MultiviewWorkError },
  '@/lib/http/api-error': apiErrors, '@/lib/pagination/cursor': { PaginationError },
};
const mod = { exports: {} };
const source = ts.transpileModule(fs.readFileSync('src/lib/video/multiview-work-api.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
new Function('require', 'module', 'exports', source)(name => {
  assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name];
}, mod, mod.exports);
const invoke = error => mod.exports.multiviewWorkRoute(new Request('https://synthetic.invalid/api/video/multiview/records', {
  headers: { 'x-app-session-user': 'owner' },
}), false, async () => { throw error; });
(async () => {
  const log = [], original = console.error;
  try {
    console.error = (...args) => log.push(args);
    for (const error of [new Error('DATABASE_PRIVATE Authorization: Bearer SYNTHETIC_PRIVATE'), Object.assign(new Error('SCHEMA_PRIVATE'), { code: 'P2021' })]) {
      const response = await invoke(error), body = await response.json();
      assert.equal(response.status, 503); assert.match(body.errorId || '', /^[a-f0-9-]{36}$/);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.doesNotMatch(JSON.stringify(body), /DATABASE_PRIVATE|SYNTHETIC_PRIVATE|SCHEMA_PRIVATE/);
      assert.equal(log.at(-1)[1].errorId, body.errorId);
    }
    assert.doesNotMatch(JSON.stringify(log), /DATABASE_PRIVATE|SYNTHETIC_PRIVATE|SCHEMA_PRIVATE/);
    const known = await invoke(new MultiviewWorkError('保留原请求', 409, 'WORK_CONFLICT', { notCommitted: true }));
    assert.deepEqual(await known.json(), { error: '保留原请求', code: 'WORK_CONFLICT', notCommitted: true });
    const cursor = await invoke(new PaginationError('列表已变化', 409));
    assert.equal(cursor.status, 409); assert.equal((await cursor.json()).error, '列表已变化');
    assert.equal(log.length, 2);
  } finally { console.error = original; }
  console.log('PASS actual multiview error boundary preserves known receipts/cursor status and encrypts unexpected database diagnostics with errorId');
})().catch(error => { console.error(error); process.exitCode = 1; });
