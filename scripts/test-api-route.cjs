const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
process.env.SESSION_SECRET = 'synthetic-api-route-master-0123456789012345678';
require('tsx/cjs');
const { withApiErrors, PublicApiError } = require('../src/lib/http/api-error.ts');
const source = fs.readFileSync(require.resolve('../src/lib/http/route.ts'), 'utf8');
const routeAst = ts.createSourceFile('route.ts', source, ts.ScriptTarget.Latest, true);
let requestTuple;
function findRequestTuple(node) {
  if (ts.isConditionalTypeNode(node) && ts.isTupleTypeNode(node.trueType)) requestTuple = node.trueType;
  ts.forEachChild(node, findRequestTuple);
}
findRequestTuple(routeAst);
assert.ok(requestTuple && ts.isNamedTupleMember(requestTuple.elements[0]));
assert.equal(Boolean(requestTuple.elements[0].questionToken), false, 'Next route exports require a request, even when the inner handler ignores it');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
let user = null, sessionError = null, consumed = [], finished = [], decision = { allowed: true, retryAfterMs: 0, delayMs: 0 };
const limiter = Object.fromEntries(['auth', 'feedback', 'registrationCode', 'beforeLogin'].map(name => [name, async (...values) => {
  consumed.push({ name, values }); return decision;
}]));
limiter.afterLogin = async (...values) => finished.push(values);
const deps = {
  '@/lib/auth/session': { getSession: async () => { if (sessionError) throw sessionError; return user; } },
  '@/lib/access/external-role': { isExternalUser: value => value.account_type === 'external' },
  '@/lib/security/rate-limit-store.server': { apiRateLimiter: limiter },
  './api-error': { withApiErrors, PublicApiError },
  'node:net': require('node:net'),
};
const loaded = { exports: {} };
new Function('require', 'module', 'exports', compiled)(name => {
  assert.ok(Object.hasOwn(deps, name), `Unreviewed route dependency ${name}`); return deps[name];
}, loaded, loaded.exports);
const { route } = loaded.exports;
const request = (data = {}, headers = {}) => new Request('https://synthetic.invalid/api/test', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '192.0.2.1', ...headers }, body: JSON.stringify(data),
});
async function main() {
  let called = 0;
  const handler = async () => { called++; return Response.json({ ok: true }); };
  assert.equal((await route({ access: 'user', rateLimit: false }, handler)(request())).status, 401);
  assert.equal(called, 0);
  assert.equal((await route({ access: 'user', rateLimit: false, unauthenticatedStatus: 404 }, handler)(request())).status, 404);
  assert.equal(called, 0);
  user = { id: 'a', role: 'user', account_type: 'internal' };
  assert.equal((await route({ access: 'admin', rateLimit: false }, handler)(request())).status, 403);
  assert.equal((await route({ access: 'internal', rateLimit: false }, handler)(request())).status, 200);
  user.account_type = 'external';
  assert.equal((await route({ access: 'internal', rateLimit: false }, handler)(request())).status, 403);
  assert.equal((await route({ access: 'service', rateLimit: false, authenticate: async () => false }, handler)(request())).status, 401);
  user = null;
  assert.equal((await route({ access: 'user', rateLimit: false, identity: async () => ({ id: 'service-user', role: 'user' }) }, handler)(request())).status, 200);
  user = { id: 'cookie-admin', role: 'admin' };
  assert.equal((await route({ access: 'user', rateLimit: false, identity: async () => null }, handler)(request())).status, 401);
  assert.equal((await route({ access: 'admin', rateLimit: false, identity: async () => ({ id: 'service-user', role: 'user' }) }, handler)(request())).status, 403);
  const beforeDeniedIdentity = called;
  const deniedIdentity = await route({ access: 'user', rateLimit: false, identity: async () => Response.json(
    { error: 'denied', safeToResubmit: false }, { status: 401, headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization' } }) }, handler)(request());
  assert.equal(deniedIdentity.status, 401);
  assert.equal(deniedIdentity.headers.get('vary'), 'Cookie, Authorization');
  assert.deepEqual(await deniedIdentity.json(), { error: 'denied', safeToResubmit: false });
  assert.equal(called, beforeDeniedIdentity, 'A custom authentication denial must not enter the handler or fall back to Cookie');
  decision = { allowed: false, retryAfterMs: 1500, delayMs: 0 };
  user = null;
  const limited = await route({ access: 'public', rateLimit: 'feedback' }, handler)(request());
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '2');
  user = { id: 'a', role: 'user', account_type: 'internal' };
  assert.equal((await route({ access: 'public', rateLimit: 'feedback' }, handler)(request())).status, 200);
  decision = { allowed: true, retryAfterMs: 0, delayMs: 0 };
  await route({ access: 'public', rateLimit: 'login' }, async () => Response.json({ error: '账号或密码错误' }, { status: 401 }))(request({ identifier: 'person' }));
  assert.equal(finished[0][2].invalidCredentials, true);
  assert.equal(consumed.at(-1).values[1], '192.0.2.1');
  await route({ access: 'public', rateLimit: 'auth' }, handler)(request({}, { 'x-real-ip': 'invalid', 'x-forwarded-for': '192.0.2.2' }));
  assert.equal(consumed.at(-1).values[0], 'unknown-proxy-source');
  assert.equal((await route({ access: 'public', rateLimit: 'login' }, handler)(request({ identifier: 'a'.repeat(20000) }))).status, 413);
  sessionError = new Error('synthetic-database-private-detail');
  const log = console.error; console.error = () => {};
  try { assert.equal((await route({ access: 'user', rateLimit: false }, handler)(request())).status, 503); }
  finally { console.error = log; }
  console.log('PASS route access before handler, service verification, rate policy, trusted proxy and bounded bodies');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
