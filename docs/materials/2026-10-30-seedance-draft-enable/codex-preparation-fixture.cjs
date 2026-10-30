'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const { NextRequest } = require('next/server');
const contract = require(path.resolve('src/lib/creation/contract.ts'));
function load(file, imports) {
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  }, fileName: file }).outputText;
  const mod = { exports: {} };
  new vm.Script(`(function(require,module,exports){${js}\n})`, { filename: file }).runInThisContext()(id => {
    assert.ok(Object.hasOwn(imports, id), `Unexpected import: ${id}`); return imports[id];
  }, mod, mod.exports);
  return mod.exports;
}
const actor = { id: 'configured-service-user', role: 'user', account_type: 'internal', status: 'active' };
let preparations = [], authCalls = 0, forwards = [], mode = 'ready';
let rejectionCalls = [];
const durableRejections = new Map();
class AuthError extends Error { constructor(message, status = 403) { super(message); this.status = status; } }
class VideoPromptGroupError extends Error { constructor(message) { super(message); this.status = 422; this.code = 'group_invalid'; } }
const receiptDb = { videoCreationIntent: { findUnique: async () => null } };
receiptDb.$transaction = async fn => fn(receiptDb);
const receipts = load('src/lib/creation/preparation-receipts.ts', {
  '@/lib/prisma': { prisma: receiptDb }, '@/lib/pricing/catalog': { pricingFingerprint: JSON.stringify },
  './contract': contract, './receipts': {
    readCreationOperation: async (_db, user, target, key) => durableRejections.get(`${user}:${target}:${key}`) || null,
    writeCreationOperation: async (_db, user, target, key, business, state, result) => {
      durableRejections.set(`${user}:${target}:${key}`, { business, state, result });
    },
  },
});
const codex = load('src/lib/integrations/codex.ts', {
  crypto: require('node:crypto'), 'next/server': { NextRequest }, '@/lib/prisma': { prisma: {} },
  '@/lib/provider/seedance-video-edit': { normalizeSeedanceEditPilot: value => value },
  '@/lib/creation/contract': contract,
  '@/lib/creation/intents': { prepareVideoCreationIntent: async (user, body) => {
    preparations.push({ user, body }); contract.creationIdentity(body.request_id, 'request_id');
    await receipts.assertNoPreparationRejection(receiptDb, user.id, body.request_id, body);
    if (mode === 'prepare-reject') throw new contract.CreationError('invalid input', 400, 'creation_input_invalid');
    if (mode === 'prepare-race') throw new contract.CreationError('race', 409, 'creation_revision_conflict');
    if (mode === 'prepare-unknown') throw Object.assign(new Error('unavailable'), { status: 503 });
    if (mode === 'project-denied') throw new AuthError('project forbidden');
    if (mode === 'group-invalid') throw new VideoPromptGroupError('invalid group');
    return { id: 'normal-intent', revision: 7, accepted_task_id: mode === 'accepted' ? 'original-task' : null,
      availability: { canSubmit: mode === 'ready', reasons: [{ code: 'approval_required', message: 'approval required', field: 'approval', action: 'request_approval' }] },
      quote: { pricing_quote_token: 'fresh-normal-quote', pricing_revision: 'original-price', estimated_cost: 18 } };
  } },
  '@/lib/creation/preparation-receipts': { recordPreparationRejection: async (...args) => {
    rejectionCalls.push(args); return receipts.recordPreparationRejection(...args);
  } },
});
const base = { creation_contract_version: 2, idempotency_key: 'original-request', project_id: 'own-project',
  draft: true, resolution: '480p', duration: 4, pricing_revision: 'original-price', max_estimated_cost: 18,
  pricing_quote_token: 'original-preview-token' };
const imports = {
  'next/server': { NextRequest }, '@/lib/creation/contract': contract,
  '@/lib/auth/session': { AuthError }, '@/lib/video/prompt-groups': { VideoPromptGroupError },
  '@/lib/pricing/video': { videoPricingError: () => null },
  '@/lib/integrations/codex': { ...codex, authenticateCodexVideoApi: async () => {
    authCalls++; if (mode === 'bad-auth') throw new codex.CodexApiAuthError('invalid token', 401, 'codex_api_invalid_token');
    return { user: actor };
  } },
  '@/app/api/tasks/create/route': { POST: async request => { forwards.push({ request, body: await request.json() }); return Response.json({ id: 'normal-task' }); } },
  '@/app/api/tasks/[id]/draft-upgrade/route': { POST: async (request, context) => { forwards.push({ request, context, body: await request.json() }); return Response.json({ id: 'normal-upgrade' }); } },
};
const create = load('src/app/api/codex/video/create/route.ts', imports).POST;
const upgrade = load('src/app/api/codex/video/draft-upgrade/route.ts', imports).POST;
const request = body => new NextRequest('https://sd2.youdooart.com/api/codex/video/create', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture',
    'x-paid-generation-intent': 'user_authorized_real_provider' }, body: JSON.stringify(body),
});
function reset(next = 'ready') { preparations = []; authCalls = 0; forwards = []; rejectionCalls = []; durableRejections.clear(); mode = next; }
const results = [];
async function check(name, run) { await run(); results.push({ name, passed: true }); }
(async () => {
  await check('legacy body delegates unchanged', async () => {
    reset(); const body = { ...base, creation_contract_version: 1 }; const r = await create(request(body));
    assert.equal(r.status, 200); assert.equal(preparations.length, 0); assert.equal(authCalls, 0); assert.deepEqual(forwards[0].body, body);
  });
  await check('v2 authenticates first and prepares with configured ordinary actor', async () => {
    reset(); const r = await create(request({ ...base, user_id: 'untrusted-body-user' })); assert.equal(r.status, 200);
    assert.equal(authCalls, 1); assert.equal(preparations[0].user, actor); assert.equal(preparations[0].body.request_id, base.idempotency_key);
    const body = forwards[0].body; assert.equal(body.intent_id, 'normal-intent'); assert.equal(body.intent_revision, 7);
    assert.equal(body.max_estimated_cost, 18); assert.equal(body.pricing_revision, 'original-price'); assert.equal(body.idempotency_key, 'original-request');
    assert.equal(body.pricing_quote_token, 'fresh-normal-quote'); assert.equal(forwards[0].request.headers.get('x-paid-generation-intent'), 'user_authorized_real_provider');
  });
  await check('invalid token cannot prepare or submit', async () => {
    reset('bad-auth'); const r = await create(request(base)); assert.equal(r.status, 401); assert.equal(preparations.length, 0); assert.equal(forwards.length, 0);
  });
  await check('approval blocker cannot submit', async () => {
    reset('blocked'); const r = await create(request(base)); assert.equal(r.status, 409); assert.equal(forwards.length, 0);
    assert.equal(rejectionCalls.length, 0); assert.equal(durableRejections.size, 0);
  });
  await check('existing intent is not silently replaced', async () => {
    reset(); const body = { ...base, intent_id: 'provided-intent', intent_revision: 3 }; await create(request(body));
    assert.equal(authCalls, 1); assert.equal(preparations.length, 0); assert.deepEqual(forwards[0].body, body);
  });
  await check('accepted original is delegated for normal deduplication', async () => {
    reset('accepted'); const r = await create(request(base)); assert.equal(r.status, 200); assert.equal(forwards[0].body.idempotency_key, base.idempotency_key);
  });
  await check('missing original request identity cannot submit', async () => {
    reset(); const body = { ...base }; delete body.idempotency_key; const r = await create(request(body));
    assert.equal(r.status, 400); assert.equal(forwards.length, 0);
  });
  await check('upgrade retains bound local Draft and normal preparation contract', async () => {
    reset(); const creationInput = { project_id: 'own-project', video_card_id: null, provider: 'seedance',
      model: 'dreamina-seedance-2-5-260628', ratio: '16:9', duration: 4, resolution: '1080p', reference_video_urls: [],
      draft: false, source_draft_task_id: 'local-draft', action: 'draft_upgrade', entry: 'draft_upgrade',
      continuation: { mode: 'continue', parent_task_id: 'local-draft' }, baseline_task_id: 'local-draft' };
    const body = { ...base, ...creationInput, draft_task_id: 'local-draft' };
    const r = await upgrade(request(body)); assert.equal(r.status, 200); assert.equal(authCalls, 1);
    assert.equal(preparations[0].body.action, 'draft_upgrade'); assert.equal(forwards[0].context.params.id, 'local-draft');
    assert.equal(preparations[0].body.source_draft_task_id, 'local-draft'); assert.equal(preparations[0].body.resolution, '1080p');
    assert.deepEqual(preparations[0].body.continuation, creationInput.continuation);
    assert.equal(forwards[0].body.intent_id, 'normal-intent'); assert.equal(forwards[0].body.max_estimated_cost, 18);
  });
  await check('upgrade rejects provider ID passthrough before preparing', async () => {
    reset(); const r = await upgrade(request({ ...base, draft_task_id: 'local-draft', provider_task_id: 'not-a-local-id' }));
    assert.equal(r.status, 400); assert.equal(preparations.length, 0); assert.equal(forwards.length, 0);
  });
  await check('definite pre-intent rejection seals original key across changed input', async () => {
    reset('prepare-reject'); assert.equal((await create(request(base))).status, 400);
    assert.equal(durableRejections.size, 1); assert.equal(rejectionCalls[0][0], actor);
    assert.equal(rejectionCalls[0][1].request_id, base.idempotency_key);
    mode = 'ready'; const r = await create(request({ ...base, duration: 5 }));
    assert.equal(r.status, 409); assert.equal(forwards.length, 0); assert.equal(durableRejections.size, 1);
  });
  await check('preparation 409 remains unsealed', async () => {
    reset('prepare-race'); assert.equal((await create(request(base))).status, 409); assert.equal(durableRejections.size, 0); assert.equal(forwards.length, 0);
  });
  await check('preparation 503 remains unsealed', async () => {
    reset('prepare-unknown'); await assert.rejects(() => create(request(base))); assert.equal(durableRejections.size, 0); assert.equal(forwards.length, 0);
  });
  await check('known project permission error retains 403 and no submission', async () => {
    reset('project-denied'); assert.equal((await create(request(base))).status, 403); assert.equal(forwards.length, 0);
  });
  await check('known prompt group error retains 422 and no submission', async () => {
    reset('group-invalid'); assert.equal((await create(request(base))).status, 422); assert.equal(forwards.length, 0);
  });
  console.log(JSON.stringify({ passed: true, isolated: true, realDatabaseCalls: 0, realProviderCalls: 0, cases: results }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
