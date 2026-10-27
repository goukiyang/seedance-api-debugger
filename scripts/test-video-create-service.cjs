const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const source = fs.readFileSync('src/server/video-tasks/create.ts', 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const calls = [], output = Response.json({ id: 'original-task', local_status: 'unknown' }, { status: 202 });
const deps = {
  '@/lib/http/api-error': { withApiErrors: handler => handler },
  './standard-create': { createStandardVideoTask: async request => { calls.push(['standard', request]); return output; } },
  './ip-create': { createIpVideoTask: async request => { calls.push(['ip', request]); return output; } },
};
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled)(name => {
  assert.ok(Object.hasOwn(deps,name), `Unreviewed dependency ${name}`); return deps[name];
}, mod, mod.exports);
async function main() {
  const request = new Request('https://synthetic.invalid/api/tasks/create', { method:'POST', body:JSON.stringify({ idempotency_key:'original-key' }) });
  assert.equal(await mod.exports.createVideoTask(request), output);
  assert.equal(await mod.exports.createVideoTask(request, 'ip'), output);
  assert.deepEqual(calls.map(([kind]) => kind), ['standard','ip']);
  assert.ok(calls.every(([,actual])=>actual===request), 'trusted request identity and original body are not recreated');
  for (const file of ['src/app/api/tasks/create/route.ts','src/app/api/ip/tasks/create/route.ts','src/app/api/codex/video/create/route.ts']) {
    const route=fs.readFileSync(file,'utf8');
    assert.match(route, /@\/server\/video-tasks\/create/);
    assert.match(route, /access: 'user'/);
    assert.match(route, /cookieOrCodexIdentity/);
  }
  const retry=fs.readFileSync('src/app/api/video/retry/[id]/route.ts','utf8');
  assert.doesNotMatch(retry, /\bfetch\s*\(/);
  assert.match(retry, /createVideoTask\(createRequest\)/);
  assert.match(retry, /resolveSitePublicBaseUrl\(\)/);
  const privateRetry=fs.readFileSync('src/lib/video/multiview-private-create.server.ts','utf8');
  assert.match(privateRetry, /createVideoTask\(trustedRequest\)/);
  assert.match(privateRetry, /trustedRetries\.delete\(trustedRequest\)/);
  assert.doesNotMatch(privateRetry, /import\(['"]@\/app\/api/);
  console.log('PASS common video creation service dispatch preserves request/unknown receipt; all entrypoints retain auth and retry has no HTTP self-call');
}
main().catch(error=>{ console.error(error); process.exitCode=1; });
