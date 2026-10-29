const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(process.argv[2] || process.cwd());
const results = [];
const plain = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function moduleAt(relative, dependencies, globals = {}) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  const exports = {};
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  vm.runInNewContext(code, { exports, process: { pid: 321, env: { PROCESS_ROLE: 'fixture' } },
    console: { info() {}, error() {} }, require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      if (name === 'node:crypto') return require(name);
      throw new Error(`Unexpected dependency: ${name}`);
    }, ...globals }, { filename: relative });
  return exports;
}
function fixture(mode) {
  const events = [];
  let calls = 0, writes = 0;
  const shared = { scope: 'process-shared-studio-reads', pending: 2, active: { operation: 'catalog', phase: 'transaction_body', heldMs: 610 } };
  const db = { platformSetting: { findUnique: async () => null, create: async () => { writes++; } },
    workspace: { findFirst: async () => ({ id: 'workspace' }) } };
  const busy = () => Object.assign(new Error('secret SQL input must not reach response'), { code: 'P1008' });
  const prisma = { async $transaction(run) {
    calls++;
    if (mode === 'wait') throw busy();
    if (mode === 'body') db.platformSetting.findUnique = async () => { throw busy(); };
    if (mode === 'other') throw new Error('private database path');
    return run(db);
  } };
  const dependencies = { 'server-only': {}, '@/lib/prisma': { prisma },
    '@/lib/auth/session': { AuthError: class AuthError extends Error {} },
    '@/lib/projects/permissions': {}, '@/lib/tasks/retention': {}, '@/lib/reference-albums/permissions': {},
    '@/lib/assets/workspace': {}, '@/lib/image-studio/read-snapshot': { sharedStudioReadDiagnostics: () => shared },
    './task-reuse-intent': {}, };
  const mod = moduleAt('src/lib/navigation/task-reuse-operation.server.ts', dependencies, {
    console: { info: (label, value) => events.push({ label, ...JSON.parse(value) }) },
  });
  return { mod, events, prisma, calls: () => calls, writes: () => writes };
}
const user = { id: 'private-owner', role: 'admin', status: 'active', account_type: 'internal' };
const request = { protocolVersion: 2, requestId: 'private-request', nonce: 'private-nonce', requestHash: 'private-hash',
  tabId: 'tab', workspaceId: 'workspace', surface: 'normal', expectedWorkspaceAssets: [] };

async function main() {
  for (const [mode, phase] of [['wait', 'transaction_wait'], ['body', 'transaction_body']]) {
    const f = fixture(mode);
    let error;
    try { await f.mod.finishTaskReuseOperation(user, 'private-task', request, { close: true }); }
    catch (cause) { error = cause; }
    assert(error instanceof f.mod.TaskReuseOperationError);
    assert.equal(error.code, 'REUSE_DATABASE_BUSY'); assert.equal(error.status, 503);
    assert.equal(error.diagnostic.action, 'query_original'); assert.equal(error.diagnostic.phase, phase);
    assert.match(error.diagnostic.diagnostic_id, /^[a-f0-9]{16}$/);
    assert.equal(f.calls(), 1, 'do not retry a mutation'); assert.equal(f.writes(), 0);
    const serialized = JSON.stringify({ events: f.events, error });
    for (const secret of ['private-owner', 'private-request', 'private-task', 'secret SQL', 'private-nonce']) assert(!serialized.includes(secret), secret);
    assert.equal(f.events.find(e => e.phase === 'transaction_failed').sharedReads.active.operation, 'catalog');
    assert.equal(f.events.some(e => e.phase === 'transaction_entered'), mode === 'body');
    results.push(`${mode}: busy stays unknown with original-query action and bounded diagnostics`);
  }
  {
    const f = fixture('success');
    const value = await f.mod.finishTaskReuseOperation(user, 'private-task', request, { close: true });
    assert.equal(value.status, 200); assert.equal(value.body.reuse.status, 'closed');
    assert.equal(value.body.reuse.requestId, request.requestId);
    assert.equal(f.calls(), 1); assert.equal(f.writes(), 1);
    assert.equal(f.events.at(-1).stage, 'commit');
    results.push('known close keeps original receipt transaction unchanged');
  }
  {
    const f = fixture('other');
    await assert.rejects(() => f.mod.finishTaskReuseOperation(user, 'private-task', request, { close: true }), /private database path/);
    assert.equal(f.calls(), 1); assert.equal(f.writes(), 0);
    results.push('other failures are not relabelled as database busy');
  }
  {
    let now = 0, releaseEnter, releaseBody;
    const enter = new Promise(resolve => { releaseEnter = resolve; });
    const body = new Promise(resolve => { releaseBody = resolve; });
    const events = [];
    const mod = moduleAt('src/lib/image-studio/read-snapshot.ts', { '@/lib/prisma': {
      prisma: { $transaction: async run => { await enter; return run({}); } }, retrySqliteBusy: run => run(),
    } }, { Date: { now: () => now }, console: { info: (label, value) => events.push({ label, ...JSON.parse(value) }) } });
    const first = mod.readSharedStudioSnapshot(async () => { await body; return 'same-value'; }, 'catalog');
    await flush();
    now = 200;
    assert.equal(mod.sharedStudioReadDiagnostics().active.phase, 'transaction_wait');
    const second = mod.readSharedStudioSnapshot(async () => 'second-value', 'revision');
    assert.equal(mod.sharedStudioReadDiagnostics().pending, 2);
    releaseEnter(); await flush();
    now = 900;
    const active = mod.sharedStudioReadDiagnostics();
    assert.equal(active.active.phase, 'transaction_body'); assert.equal(active.active.heldMs, 700);
    releaseBody(); assert.equal(await first, 'same-value'); assert.equal(await second, 'second-value'); await flush();
    assert.deepEqual(plain(mod.sharedStudioReadDiagnostics()), { scope: 'process-shared-studio-reads', pending: 0, active: null });
    assert(events.some(event => event.active.operation === 'catalog' && event.active.heldMs === 700));
    results.push('shared-read queue distinguishes waiting vs holding and drains without changing results');
  }
  {
    const mod = moduleAt('src/lib/image-studio/read-snapshot.ts', { '@/lib/prisma': {
      prisma: { $transaction: async () => { throw Object.assign(new Error('fixture'), { code: 'P1008' }); } },
      retrySqliteBusy: run => run(),
    } });
    await assert.rejects(() => mod.readSharedStudioSnapshot(async () => {}, 'gallery'), { code: 'P1008' });
    await flush(); assert.equal(mod.sharedStudioReadDiagnostics().pending, 0); assert.equal(mod.sharedStudioReadDiagnostics().active, null);
    results.push('shared-read failure releases observational state and keeps original error');
  }
  for (const mode of ['wait', 'other']) {
    const f = fixture(mode);
    const diagnostic = mode === 'wait' ? new f.mod.TaskReuseOperationError('REUSE_DATABASE_BUSY', 'safe pending', 503,
      { action: 'query_original', phase: 'transaction_wait', diagnostic_id: 'a'.repeat(16) }) : new Error('private database path and SQL');
    const source = fs.readFileSync(path.join(root, 'src/app/api/tasks/[id]/reuse/route.ts'), 'utf8');
    const tree = ts.createSourceFile('route.ts', source, ts.ScriptTarget.Latest, true);
    const post = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'POST');
    const clause = post.body.statements.find(ts.isTryStatement).catchClause;
    const response = vm.runInNewContext(ts.transpileModule(`(() => ${clause.block.getText(tree)})()`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText,
      { error: diagnostic, TaskReuseOperationError: f.mod.TaskReuseOperationError, AuthError: class AuthError extends Error {},
        console: { error() {} }, taskReusePrivateHeaders: { 'Cache-Control': 'private, no-store' },
        NextResponse: { json: (body, init) => ({ body, ...init }) } });
    assert.equal(response.status, 503); assert.equal(response.body.action, 'query_original');
    assert(!response.body.reuse, 'no durable result is fabricated');
    assert(!JSON.stringify(response).includes('private database'));
    assert.equal(response.headers['Cache-Control'], 'private, no-store');
    results.push(`${mode}: actual route catch returns safe unknown response, not a fabricated receipt`);
  }
  console.log(JSON.stringify({ passed: results.length, results, productionWrites: 0, networkRequests: 0, performanceClaim: false }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
