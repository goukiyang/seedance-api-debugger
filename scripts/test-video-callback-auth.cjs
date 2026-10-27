const assert = require('node:assert/strict');
process.env.SESSION_SECRET = 'synthetic-video-callback-master-0123456789012345';
process.env.VIDEO_DELIVERY_CALLBACK_SECRET = 'synthetic-video-callback-key-0123456789012345';
require('tsx/cjs');
const { createVideoCallbackToken, verifyVideoCallbackToken, redactVideoCallbackEcho } = require('../src/lib/video/callback-auth.ts');
const token = createVideoCallbackToken('task-a');
assert.notEqual(token, process.env.VIDEO_DELIVERY_CALLBACK_SECRET);
const callbackUrl = `https://synthetic.invalid/api/provider/seedance/callback?taskId=task-a&token=${encodeURIComponent(token)}`;
const echo = redactVideoCallbackEcho(JSON.stringify({ id: 'accepted-provider-id', nested: { callback_url: callbackUrl, token } }), callbackUrl);
assert.equal(JSON.parse(echo).id, 'accepted-provider-id');
assert.equal(echo.includes(token), false);
assert.equal(echo.includes(callbackUrl), false);
assert.equal(verifyVideoCallbackToken({ taskId: 'task-a', token }), true);
assert.equal(verifyVideoCallbackToken({ taskId: 'task-b', token }), false);
assert.equal(verifyVideoCallbackToken({ taskId: 'task-a', token: token + 'x' }), false);
const start = Date.UTC(2026, 9, 27);
const legacy = process.env.VIDEO_DELIVERY_CALLBACK_SECRET;
const oldTask = { taskId: 'old-task', token: legacy, createdAt: new Date(start - 1), now: start + 1 };
assert.equal(verifyVideoCallbackToken(oldTask), false);
process.env.VIDEO_CALLBACK_LEGACY_STARTED_AT = new Date(start).toISOString();
assert.equal(verifyVideoCallbackToken(oldTask), true);
assert.equal(verifyVideoCallbackToken({ ...oldTask, createdAt: new Date(start) }), false);
assert.equal(verifyVideoCallbackToken({ ...oldTask, createdAt: undefined }), false);
assert.equal(verifyVideoCallbackToken({ ...oldTask, now: start - 1 }), false);
assert.equal(verifyVideoCallbackToken({ ...oldTask, now: start + 48 * 3600000 }), false);
assert.equal(verifyVideoCallbackToken({ ...oldTask, token: legacy + 'x' }), false);
assert.equal(verifyVideoCallbackToken({ ...oldTask, token: 'v2:invalid' }), false);
process.env.VIDEO_CALLBACK_LEGACY_STARTED_AT = 'not-a-date';
assert.equal(verifyVideoCallbackToken(oldTask), false);
assert.equal(verifyVideoCallbackToken({ taskId: 'task-a', token }), true);
console.log('PASS task-bound callback token and explicit 48h old-task-only transition');

async function routeContract() {
  const fs = require('node:fs');
  const ts = require('typescript');
  const { NextRequest, NextResponse } = require('next/server');
  const { withApiErrors } = require('../src/lib/http/api-error.ts');
  const { requireSecret } = require('../src/lib/security/secrets.ts');
  const source = fs.readFileSync(require.resolve('../src/app/api/provider/seedance/callback/route.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const privateText = 'synthetic-private-provider-prompt';
  const task = { id: 'task-a', provider_task_id: 'provider-a', created_at: new Date(start - 1),
    local_status: 'succeeded', provider_status: 'succeeded', params_json: '{}',
    result_video_url: 'https://media.example.invalid/result.mp4', error_message: privateText,
    request_json: privateText, source_metadata_json: null };
  const calls = { finalized: [], forward: [], updated: [] };
  const deps = {
    'next/server': { NextResponse },
    '@/lib/prisma': { prisma: { videoTask: {
      findUnique: async ({ where }) => where.id === task.id ? task : null,
      update: async value => { calls.updated.push(value); return task; },
    } } },
    '@/lib/video/task-finalizer': { finalizeVideoTaskStatus: async id => { calls.finalized.push(id); return { task }; } },
    '@/lib/video/delivery-queue': { enqueueVideoDeliveryJob: async () => ({ queued: true }) },
    '@/lib/video/delivery-policy': { getExternalCallbackUrlFromParams: () => 'https://callback.example.invalid/hook' },
    '@/lib/video/multiview-task-privacy': { projectPrivateMultiviewTask: value => value },
    '@/lib/media/public-url': { isPublicHttpUrl: value => typeof value === 'string' && value.startsWith('https://') },
    '@/lib/video/callback-auth': { verifyVideoCallbackToken },
    '@/lib/security/secrets': { requireSecret },
    '@/lib/http/api-error': { withApiErrors },
  };
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', 'fetch', compiled)(name => {
    assert.ok(Object.hasOwn(deps, name), `Unreviewed route dependency: ${name}`);
    return deps[name];
  }, loaded, loaded.exports, async (_url, options) => {
    calls.forward.push(JSON.parse(options.body));
    return new Response('', { status: 200 });
  });
  const invoke = (id, credential, providerId = 'provider-a') => loaded.exports.POST(new NextRequest(
    `https://synthetic.invalid/api/provider/seedance/callback?taskId=${id}&token=${encodeURIComponent(credential)}`,
    { method: 'POST', body: JSON.stringify({ task_id: providerId, prompt: privateText, token: credential, raw: privateText }) }));
  assert.equal((await invoke('task-a', createVideoCallbackToken('task-b'))).status, 401);
  assert.equal((await invoke('missing-task', token)).status, 401);
  assert.equal((await invoke('task-a', token, 'other-provider')).status, 409);
  assert.equal(calls.finalized.length, 0);
  assert.equal((await invoke('task-a', token)).status, 200);
  assert.deepEqual(calls.finalized, ['task-a']);
  assert.equal(calls.forward.length, 1);
  assert.equal(JSON.stringify(calls.forward).includes(privateText), false);
  assert.equal(JSON.stringify(calls.forward).includes(token), false);
  assert.equal(calls.forward[0].sd2_task_id, task.id);
  console.log('PASS actual callback route authentication, provider binding and forwarding confidentiality');
}
routeContract().catch(error => { console.error(error); process.exitCode = 1; });
