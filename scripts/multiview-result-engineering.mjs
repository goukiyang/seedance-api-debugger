import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url), ts = require('typescript');
const root = process.cwd(), cache = new Map();
const compile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText;
let actor = { id: 'owner-one', account_type: 'internal' }, selectedRows = [], query;
class AuthError extends Error { constructor(message, status) { super(message); this.status = status; } }
const dependencies = {
  'next/server': { NextResponse: { json: (body, options) => ({ body, ...options }) } },
  '@/lib/auth/session': { getSession: async () => actor, AuthError },
  '@/lib/access/feature-guard': { assertInternalOnly: user => { if (user.account_type === 'external') throw new AuthError('denied', 403); } },
  '@/lib/prisma': { prisma: { videoTask: { findMany: async input => { query = input; return selectedRows; } }, multiviewWork: { findMany: async () => [] } } },
};
function load(file) {
  const absolute = path.resolve(root, file);
  if (cache.has(absolute)) return cache.get(absolute).exports;
  const module = { exports: {} }; cache.set(absolute, module);
  const localRequire = name => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    if (name.startsWith('@/') || name.startsWith('.')) {
      const target = name.startsWith('@/') ? path.join(root, 'src', name.slice(2)) : path.resolve(path.dirname(absolute), name);
      return load(target.endsWith('.ts') ? target : `${target}.ts`);
    }
    throw new Error(`Unexpected dependency or I/O: ${name}`);
  };
  const context = { module, exports: module.exports, require: localRequire, Buffer, URL, console,
    process: { env: { NODE_ENV: 'test' } }, fetch: () => { throw new Error('Network prohibited'); } };
  vm.runInNewContext(compile(fs.readFileSync(absolute, 'utf8')), context, { filename: absolute });
  return module.exports;
}
const helper = load('src/app/multiview/multiview-video-results.ts');
let cases = 0;
for (const [actualCost, frozenCost, expected] of [[28.9, 0, 28.9], [0, 0, 0], [null, 0, null], [null, 28.9, null], [28.9, 28.9, null], [NaN, 0, null], [-1, 0, null], [28.9, null, null]]) {
  assert.equal(helper.multiviewSettledPoints({ actualCost, frozenCost, estimatedCost: 99 }), expected); cases++;
}
const fixture = (id, extra = {}) => ({ id, title: '动作视频', status: 'success', model: 'seedance-2.5', duration: 4, resolution: '480p',
  createdAt: '2026-10-30T01:00:00.000Z', actualCost: 28.9, frozenCost: 0, thumbnailUrl: null, playUrl: `/api/video/play/${id}`, downloadUrl: null, deliveryStage: null, error: null, ...extra });
const first = Array.from({ length: 24 }, (_, i) => fixture(`first-${i}`));
const merged = helper.mergeMultiviewVideoResults(first, [fixture('first-1', { actualCost: 19 }), fixture('older', { createdAt: '2026-10-29T01:00:00.000Z' })]);
assert.equal(merged.length, 25); assert.equal(merged.find(item => item.id === 'first-1').actualCost, 19); assert.equal(merged.at(-1).id, 'older'); cases++;
assert.equal(helper.multiviewVideoNeedsRefresh(fixture('ready')), false);
assert.equal(helper.multiviewVideoNeedsRefresh(fixture('billing', { actualCost: null })), true);
assert.equal(helper.multiviewVideoNeedsRefresh(fixture('preparing', { playUrl: null })), true);
assert.equal(helper.multiviewVideoResultLabel(fixture('unknown', { status: 'unconfirmed' })), '状态待确认'); cases += 4;

const route = load('src/app/api/multiview/generations/route.ts');
const privateTask = (id, kind = 'multiview') => ({ id, user_id: 'owner-one', owner_user_id: 'owner-one', local_status: 'succeeded',
  source_metadata_json: JSON.stringify({ protected_module: { kind, schema: 1, recipeVersion: '1.0.0' }, secret: 'SECRET_SYSTEM_IMAGE' }),
  prompt: 'SECRET_RECIPE', params_json: 'SECRET_EXECUTION', local_video_path: '/private/SECRET_OUTPUT.mp4',
  actual_cost: 28.9, frozen_cost: 0, estimated_cost: 99, created_at: '2026-10-30T01:00:00.000Z', updated_at: null });
const request = (suffix = '', owner = 'owner-one') => ({ nextUrl: new URL(`https://fixture.invalid/api/multiview/generations${suffix}`), headers: new Headers({ 'x-app-session-user': owner }) });
selectedRows = [privateTask('rotation'), privateTask('action', 'multiview-action')];
let result = await route.GET(request());
assert.equal(result.status, 200); assert.equal(result.body.items.length, 2);
assert.equal(result.body.items[1].title, '动作视频'); assert.equal(result.body.items[0].title, '旋转视频');
assert.equal(result.body.items[1].playUrl, '/api/video/play/action'); assert.equal(result.body.items[1].actualCost, 28.9);
assert.ok(!JSON.stringify(result.body).includes('SECRET_')); cases++;
const terms = query.where.AND;
assert.equal(terms[0].OR[0].owner_user_id, 'owner-one');
assert.equal(terms[0].OR[1].owner_user_id, null); assert.equal(terms[0].OR[1].user_id, 'owner-one');
assert.ok(terms.some(term => term.source_metadata_json?.contains === '"protected_module"'));
assert.ok(terms.some(term => Array.isArray(term.retention_status?.in))); assert.equal(query.take, 25); cases++;
await route.GET(request('?taskId=action')); assert.ok(query.where.AND.some(term => term.id === 'action')); cases++;
assert.equal((await route.GET(request('?taskId='))).status, 400);
assert.equal((await route.GET(request('?taskId=../../secret'))).status, 400);
assert.equal((await route.GET(request('?cursor=invalid'))).status, 400); cases += 3;
assert.equal((await route.GET(request('', 'other-owner'))).status, 409); cases++;
actor = null; assert.equal((await route.GET(request())).status, 401); cases++;
actor = { id: 'owner-one', account_type: 'external' }; assert.equal((await route.GET(request())).status, 403); cases++;
actor = { id: 'owner-one', account_type: 'internal' };
const after = Buffer.from(JSON.stringify({ at: '2026-10-29T01:00:00.000Z', id: 'last' })).toString('base64url');
await route.GET(request(`?cursor=${after}`)); assert.equal(query.where.AND.at(-1).OR[1].id.lt, 'last'); cases++;

const source = fs.readFileSync('src/app/multiview/MultiviewVideoResults.tsx', 'utf8');
const ast = ts.createSourceFile('results.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let choose;
function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'choose') choose = node.initializer.getText(ast); ts.forEachChild(node, visit); }
visit(ast); assert.ok(choose);
const changes = [], storage = [];
const context = { player: { current: { pause() {}, play: async () => {} } }, selected: fixture('old'),
  setSelectedId: id => changes.push(['selected', id]), setPlayRequest: id => changes.push(['play', id]), setMediaError() {},
  sessionStorage: { setItem: (key, id) => storage.push([key, id]) }, selectionKey: 'owner-one' };
vm.runInNewContext(compile(`const choose = ${choose}; choose('history-video');`), context);
assert.deepEqual(changes, [['selected', 'history-video'], ['play', 'history-video']]);
assert.deepEqual(storage, [['owner-one', 'history-video']]); cases++;
assert.ok(!source.includes('/api/video/create') && !source.includes('selectTask(') && !source.includes('/tasks/')); cases++;
for (const file of ['src/app/multiview/page.tsx', 'src/app/multiview/MultiviewActionPanel.tsx']) {
  assert.match(fs.readFileSync(file, 'utf8'), /<MultiviewVideoResults/); cases++;
}
console.log(JSON.stringify({ passed: true, cases, actualRouteAndProjection: true, actualSelectionHandler: true,
  networkCalls: 0, databaseWrites: 0, paidCalls: 0, browserTests: 0 }));
