import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, Module } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Execute the complete actual GET route modules with explicit read-only I/O
// boundaries. This tests route identity propagation, not token cryptography.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const provider = 'volcengine_ark';
const owner = { id: 'ordinary-service-account', status: 'active', account_type: 'internal' };
const other = { ...owner, id: 'different-cookie-account' };
class AuthError extends Error { constructor(message, status = 403) { super(message); this.status = status; } }
class CodexApiAuthError extends Error { constructor(message, status = 401) { super(message); this.status = status; } }
const originalFetch = globalThis.fetch;
let networkAttempts = 0, writes = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error('Network forbidden in this fixture'); };
const sourceHashes = {}, passed = [];
const frozen = [{ characterAssetId: 'private-directory-record', revision: 4, name: '原角色', assetId: 'asset-Frozen', uri: 'asset://asset-Frozen', position: 1 }];
const selected = [{ kind: 'ark_asset', characterAssetId: 'private-directory-record', revision: 4 }];
const originalTask = {
  id: 'fixture-ip-task', user_id: owner.id, owner_user_id: owner.id, idempotency_key: 'fixture-original-key',
  provider, model: 'doubao-seedance-2-0-260128', provider_task_id: 'mock-upstream-original',
  prompt: '图片1保持原有角色设计。', generation_mode: 'all_in_one_reference', ratio: '16:9', duration: 5, resolution: '720p',
  reference_image_urls: '["asset://asset-Frozen"]',
  params_json: JSON.stringify({ reference_image_inputs: selected, characterAssetReferences: frozen }),
  source_metadata_json: '{"private_character_assets":true}', local_status: 'submitted', provider_status: 'queued',
  error_code: 'IP_SUBMISSION_UNCONFIRMED', error_message: null, estimated_cost: 5, frozen_cost: 5,
  result_video_url: null, result_last_frame_url: null, local_video_path: null,
  project_id: 'fixture-owner-project', video_card_id: null, created_at: new Date('2026-11-11T12:00:00Z'), updated_at: new Date('2026-11-11T12:00:00Z'), completed_at: null,
};
let state;
function reset(patch = {}) {
  state = { bearerUser: owner, cookieUser: other, authError: null, task: structuredClone(originalTask), missing: false,
    denyPermission: false, bearerCalls: 0, cookieCalls: 0, reads: [], permissions: [], finalizers: [], ...patch };
}
const taskReads = new Proxy({
  findUnique: async input => {
    state.reads.push({ method: 'findUnique', input });
    return state.missing || input.where.id !== state.task.id ? null : structuredClone(state.task);
  },
  findFirst: async input => {
    state.reads.push({ method: 'findFirst', input });
    const match = !state.missing && Object.entries(input.where).every(([key, value]) => state.task[key] === value);
    if (!match) return null;
    return Object.fromEntries(Object.keys(input.select).map(key => [key, state.task[key]]));
  },
}, { get(target, key) {
  if (key in target) return target[key];
  writes++; throw new Error(`Unexpected task mutation/query: ${String(key)}`);
} });
const prisma = new Proxy({ videoTask: taskReads }, { get(target, key) {
  if (key in target) return target[key];
  writes++; throw new Error(`Unexpected database dependency: ${String(key)}`);
} });
const modules = {
  'next/server': { NextResponse: { json: (data, init) => new Response(JSON.stringify(data), init) } },
  '@/lib/prisma': { prisma },
  '@/lib/auth/session': { AuthError, getSession: async () => { state.cookieCalls++; return state.cookieUser; } },
  '@/lib/integrations/codex': {
    CodexApiAuthError, hasCodexApiAuthSignal: request => request.headers.has('authorization'),
    authenticateCodexVideoApi: async request => {
      state.bearerCalls++; assert.equal(request.headers.get('authorization'), 'Bearer fixture-token');
      if (state.authError) throw state.authError;
      return { user: state.bearerUser, source: { source_type: 'codex_api' } };
    },
  },
  '@/lib/access/external-role': { isExternalUser: user => user.account_type === 'external' },
  '@/lib/projects/permissions': { assertCanViewTask: async (user, task) => {
    state.permissions.push({ userId: user.id, taskId: task.id });
    if (state.denyPermission || user.id !== (task.owner_user_id || task.user_id)) throw new AuthError('无权查看原任务', 403);
  } },
  '@/lib/provider/volcengine-ip': { VOLCENGINE_IP_VIDEO_PROVIDER: provider, safeVolcengineIpUserMessage: value => value },
  '@/lib/video/task-finalizer': { finalizeVideoTaskStatus: async (id, options) => {
    state.finalizers.push({ id, options }); return { task: state.task, providerError: null };
  } },
  '@/lib/video/task-thumbnail-projection': { taskThumbnailProjection: () => ({ result_thumbnail_url: null }) },
};
function actual(file) {
  const filename = path.join(root, file), source = fs.readFileSync(filename, 'utf8');
  sourceHashes[file] = createHash('sha256').update(source).digest('hex');
  const code = ts.transpileModule(source, { fileName: filename, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true,
  } }).outputText;
  const mod = new Module(filename); mod.filename = filename;
  mod.require = name => { assert.ok(name in modules, `Unmocked route dependency: ${name}`); return modules[name]; };
  mod._compile(code, filename); return mod.exports;
}
modules['@/lib/character-assets/privacy'] = actual('src/lib/character-assets/privacy.ts');
const statusRoute = actual('src/app/api/ip/video/status/[id]/route.ts');
const requestRoute = actual('src/app/api/ip/tasks/request-status/route.ts');
assert.equal(statusRoute.POST, undefined); assert.equal(requestRoute.POST, undefined);
function request({ bearer = true, key = originalTask.idempotency_key, expectedActor, refresh = false } = {}) {
  const headers = { ...(bearer ? { Authorization: 'Bearer fixture-token' } : {}), ...(expectedActor ? { 'x-app-session-user': expectedActor } : {}) };
  const url = new URL('https://app.fixture.invalid/api/ip/tasks/request-status');
  if (key !== null) url.searchParams.set('idempotency_key', key);
  if (refresh) url.searchParams.set('refresh', 'true');
  const value = new Request(url, { headers }); value.nextUrl = url; return value;
}
function cache(response) {
  assert.match(response.headers.get('cache-control') || '', /private/);
  assert.match(response.headers.get('cache-control') || '', /no-store/);
  const vary = new Set((response.headers.get('vary') || '').toLowerCase().split(',').map(value => value.trim()));
  assert.ok(vary.has('cookie')); assert.ok(vary.has('authorization'));
}
async function run(route, options) {
  const response = route === 'status' ? await statusRoute.GET(request(options), { params: { id: originalTask.id } }) : await requestRoute.GET(request(options));
  cache(response); return { response, body: await response.json() };
}
async function check(label, operation) {
  await operation(); assert.equal(writes, 0); assert.equal(networkAttempts, 0); passed.push(label);
}
async function main() {
  for (const route of ['status', 'request-status']) {
    await check(`${route}: bearer ordinary owner overrides another valid cookie account`, async () => {
      reset(); const { response, body } = await run(route, { refresh: true });
      assert.equal(response.status, 200); assert.equal(state.bearerCalls, 1); assert.equal(state.cookieCalls, 0);
      assert.deepEqual(state.permissions, [{ userId: owner.id, taskId: originalTask.id }]);
      if (route === 'status') {
        assert.equal(body.id, originalTask.id); assert.deepEqual(body.character_asset_references, frozen); assert.deepEqual(body.reference_image_inputs, selected);
        assert.equal(state.finalizers.length, 1); assert.equal(state.finalizers[0].id, originalTask.id);
        assert.equal(state.finalizers[0].options.createdBy, owner.id); assert.equal(state.finalizers[0].options.forceProviderRefresh, true);
      } else {
        assert.equal(body.task.id, originalTask.id); assert.equal(body.lookup, 'found'); assert.equal(body.safeToResubmit, false);
        assert.deepEqual(state.reads[0].input.where, { user_id: owner.id, provider, idempotency_key: originalTask.idempotency_key });
        assert.equal(state.finalizers.length, 0);
      }
    });
    for (const status of [401, 403]) await check(`${route}: invalid bearer retains ${status} and never falls back to a valid cookie`, async () => {
      reset({ cookieUser: owner, authError: new CodexApiAuthError('无效 API 凭据', status) });
      const { response, body } = await run(route); assert.equal(response.status, status); assert.equal(body.error, '无效 API 凭据');
      assert.equal(state.cookieCalls, 0); assert.equal(state.reads.length, 0); assert.equal(state.finalizers.length, 0);
      if (route === 'request-status') assert.equal(body.safeToResubmit, false);
    });
    await check(`${route}: disabled bearer owner is rejected before DB and cannot borrow active cookie`, async () => {
      reset({ bearerUser: { ...owner, status: 'disabled' }, cookieUser: owner });
      assert.equal((await run(route)).response.status, 401); assert.equal(state.cookieCalls, 0); assert.equal(state.reads.length, 0);
    });
    await check(`${route}: expected actor mismatch returns 409 before task lookup`, async () => {
      reset(); assert.equal((await run(route, { expectedActor: other.id })).response.status, 409); assert.equal(state.reads.length, 0);
    });
    await check(`${route}: original cookie owner still works with private no-store/Vary`, async () => {
      reset({ cookieUser: owner }); const { response } = await run(route, { bearer: false });
      assert.equal(response.status, 200); assert.equal(state.bearerCalls, 0); assert.equal(state.cookieCalls, 1);
    });
    await check(`${route}: signed-out and disabled cookie users are rejected before DB`, async () => {
      for (const cookieUser of [null, { ...owner, status: 'disabled' }]) {
        reset({ cookieUser }); assert.equal((await run(route, { bearer: false })).response.status, 401); assert.equal(state.reads.length, 0);
      }
    });
    await check(`${route}: retained permission guard denies even the matching owner row`, async () => {
      reset({ denyPermission: true }); assert.equal((await run(route)).response.status, 403);
      assert.equal(state.permissions.length, 1); assert.equal(state.finalizers.length, 0);
    });
  }
  await check('status: another valid bearer account cannot view the owner task or reach provider status', async () => {
    reset({ bearerUser: other, cookieUser: owner }); const { response } = await run('status');
    assert.equal(response.status, 403); assert.equal(state.cookieCalls, 0); assert.equal(state.finalizers.length, 0);
    assert.deepEqual(state.permissions, [{ userId: other.id, taskId: originalTask.id }]);
  });
  await check('status: absent/wrong-provider task exits without provider refresh', async () => {
    reset({ missing: true }); assert.equal((await run('status')).response.status, 404); assert.equal(state.finalizers.length, 0);
    reset({ task: { ...originalTask, provider: 'seedance' } }); assert.equal((await run('status')).response.status, 400); assert.equal(state.finalizers.length, 0);
  });
  await check('status: unconfirmed original without upstream ID stays readable and never creates/retries', async () => {
    reset({ task: { ...originalTask, provider_task_id: null } }); const { response, body } = await run('status');
    assert.equal(response.status, 200); assert.equal(body.error_code, 'IP_SUBMISSION_UNCONFIRMED'); assert.equal(state.finalizers.length, 0);
  });
  await check('request-status: another bearer account gets only its own scoped lookup, never owner cookie data', async () => {
    reset({ bearerUser: other, cookieUser: owner }); const { response, body } = await run('request-status');
    assert.equal(response.status, 200); assert.equal(body.task, null); assert.equal(body.lookup, 'not_found'); assert.equal(body.safeToResubmit, false);
    assert.deepEqual(state.reads[0].input.where, { user_id: other.id, provider, idempotency_key: originalTask.idempotency_key });
    assert.equal(state.cookieCalls, 0); assert.equal(state.permissions.length, 0);
  });
  await check('request-status: original key is trimmed and exact user/provider filters remain mandatory', async () => {
    reset(); assert.equal((await run('request-status', { key: `  ${originalTask.idempotency_key}  ` })).body.lookup, 'found');
    assert.deepEqual(state.reads[0].input.where, { user_id: owner.id, provider, idempotency_key: originalTask.idempotency_key });
  });
  await check('request-status: missing original and wrong provider are not authorization to resubmit', async () => {
    for (const patch of [{ missing: true }, { task: { ...originalTask, provider: 'seedance' } }]) {
      reset(patch); const { response, body } = await run('request-status');
      assert.equal(response.status, 200); assert.equal(body.task, null); assert.equal(body.lookup, 'not_found'); assert.equal(body.safeToResubmit, false);
    }
  });
  await check('request-status: empty/absent/oversize key is rejected before DB with resubmit locked', async () => {
    for (const key of ['', null, 'x'.repeat(201)]) {
      reset(); const { response, body } = await run('request-status', { key });
      assert.equal(response.status, 400); assert.equal(body.safeToResubmit, false); assert.equal(state.reads.length, 0);
    }
  });
  console.log(JSON.stringify({ passed: passed.length, cases: passed, sourceSha256: sourceHashes,
    isolation: { realDatabase: false, realProviderCalls: networkAttempts, createOrWriteCalls: writes, browserRuns: 0 },
    boundary: 'Actual GET route modules; bearer verification, permissions and provider/finalizer are explicit mocks. No token cryptography or deployed-runtime acceptance is claimed.' }, null, 2));
}
try { await main(); }
catch (error) { console.error(error); process.exitCode = 1; }
finally { globalThis.fetch = originalFetch; }
