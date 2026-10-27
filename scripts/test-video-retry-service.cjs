const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
class AuthError extends Error { constructor(message, status) { super(message); this.status = status; } }
class CreationError extends Error {}
const user = { id: 'owner', role: 'user', account_type: 'internal' };
const original = { id: 'original-task', source_metadata_json: null, provider: 'seedance', model: 'synthetic-model',
  local_status: 'failed', error_code: null, frozen_cost: 0, prompt: 'synthetic', generation_mode: 'text_to_video',
  owner_user_id: user.id, user_id: user.id, retention_status: 'active', project_id: null, video_card_id: 'card',
  params_json: '{}', reference_image_urls: null, reference_image_ids: null, creation_contract_version: null };
const calls = [];
const prisma = { videoTask: { findUnique: async ({ where, select }) => where.id
  ? Object.fromEntries(Object.entries(original).filter(([key]) => select?.[key])) : null } };
function load(file, dependencies) {
  const mod = { exports: {} };
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', compiled)(name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unreviewed dependency ${name}`); return dependencies[name];
  }, mod, mod.exports);
  return mod.exports;
}
const retention = load('src/lib/tasks/retention.ts', {});
const features = { assertInternalOnly() {}, assertFeatureAllowed() {}, isFeatureAllowed: () => true };
const session = { getSession: async () => user, AuthError };
const permissions = load('src/lib/projects/permissions.ts', {
  '@/lib/prisma': { prisma }, '@/lib/auth/session': session,
  '@/lib/access/feature-guard': features, '@/lib/tasks/retention': retention,
});
const route = load('src/app/api/video/retry/[id]/route.ts', {
  '@/lib/http/route': { route: (_options, handler) => handler },
  '@/lib/http/api-error': { apiErrorResponse: error => { throw error; } },
  '@/server/video-tasks/create': { createVideoTask: async request => {
    calls.push({ url: request.url, body: await request.json(), cookie: request.headers.get('cookie'),
      host: request.headers.get('host'), forwarded: request.headers.get('x-forwarded-host') });
    return Response.json({ id: 'retry-task', local_status: 'unknown' }, { status: 202 });
  } },
  '@/lib/assets/site-url': { resolveSitePublicBaseUrl: () => 'https://configured.invalid' },
  '@/lib/creation/contract': { CreationError }, '@/lib/creation/intents': {}, '@/lib/creation/lineage': {},
  'next/server': { NextRequest: Request, NextResponse: { json: Response.json } },
  '@/lib/prisma': { prisma }, '@/lib/auth/session': session, '@/lib/access/feature-guard': features,
  '@/lib/projects/permissions': { ...permissions, getProjectForGeneration: async () => ({ id: 'personal-project' }) },
  '@/lib/provider/volcengine-ip': { VOLCENGINE_IP_VIDEO_PROVIDER: 'volcengine_ip' },
  '@/lib/pricing/video': { quoteVideoPricing: async () => ({}), requireVideoPricingRevision() {}, videoPricingError: () => null },
  '@/lib/pricing/video-context': { resolveVideoPricingContext: async () => ({}), savedVideoPricingContextInput: value => value },
  '@/lib/reference-albums/permissions': { uniquePreserveOrder: values => [...new Set(values)] },
  '@/lib/video/multiview-task-privacy': { isPrivateMultiviewTask: () => false },
  '@/lib/video/multiview-private-create.server': {},
  '@/lib/tasks/paid-generation-guard': { PAID_GENERATION_INTENT_HEADER: 'x-paid-intent',
    PAID_GENERATION_INTENT_USER_AUTHORIZED: 'user-authorized', PAID_GENERATION_REASON_HEADER: 'x-paid-reason',
    userRetryGenerationReason: (_type, id) => `retry:${id}` },
});
const invoke = host => route.POST(new Request(`https://${host}/api/video/retry/original-task`, { method: 'POST',
  headers: { host, 'x-forwarded-host': host, cookie: 'synthetic-session=identity', 'content-type': 'application/json' },
  body: JSON.stringify({ pricing_revision: 'current', pricing_quote_token: 'synthetic-quote', max_estimated_cost: 5 }),
}), { params: Promise.resolve({ id: original.id }) });
(async () => {
  for (const host of ['first.untrusted.invalid', 'second.untrusted.invalid']) {
    const response = await invoke(host);
    assert.equal(response.status, 202, 'Actual permission check must see the selected original owner');
    assert.deepEqual(await response.json(), { id: 'retry-task', local_status: 'unknown' });
  }
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0].url, 'https://configured.invalid/api/tasks/create');
  assert.equal(calls[0].cookie, 'synthetic-session=identity');
  assert.equal(calls[0].host, null); assert.equal(calls[0].forwarded, null);
  assert.equal(calls[0].body.idempotency_key, 'video-retry:original-task');
  original.retention_status = 'user_deleted'; assert.equal((await invoke('forged.invalid')).status, 404);
  original.retention_status = 'active'; original.owner_user_id = 'other'; original.user_id = 'other';
  assert.equal((await invoke('forged.invalid')).status, 403); assert.equal(calls.length, 2);
  console.log('PASS actual retry handler uses real owner/retention authorization and trusted service URL independent of forged Host; original receipt and unknown status preserved');
})().catch(error => { console.error(error); process.exitCode = 1; });
