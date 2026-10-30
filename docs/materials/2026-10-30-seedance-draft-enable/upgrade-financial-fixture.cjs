'use strict';
// Runs the committed upgrade service with an in-memory ledger and intercepted provider transport.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
process.env.SEEDANCE_API_KEY = 'isolated-fixture-only';
delete process.env.SEEDANCE_DRAFT_UPGRADE_ENABLED;
const helpers = require(path.resolve('src/lib/provider/seedance-draft.ts'));
const models = require(path.resolve('src/lib/provider/seedance-models.ts'));
const provider = require(path.resolve('src/lib/provider/jimeng.ts'));
const serviceFile = path.resolve('src/lib/tasks/seedance-draft-upgrade.ts');
const compiled = ts.transpileModule(fs.readFileSync(serviceFile, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: serviceFile,
}).outputText;
const noop = async () => {};
const cases = [
  { name: '200 invalid JSON', body: 'invalid', preserve: true },
  { name: '200 missing ID', body: '{}', preserve: true },
  { name: 'accepted then local task registration fails', body: '{"id":"accepted-provider"}', localFail: 'task', preserve: true, known: true },
  { name: 'accepted then request ledger registration fails', body: '{"id":"accepted-provider"}', localFail: 'ledger', preserve: true, known: true },
  { name: 'timeout recovers original request', timeout: true, recover: true, preserve: true, known: true },
  { name: 'explicit provider rejection refunds', body: '{"error":{"code":"InvalidParameter","message":"Draft not ready"}}', preserve: false },
  { name: 'failure before send refunds', beforeSend: true, preserve: false },
  { name: '500 response remains unknown', body: '{"error":{"code":"InternalError"}}', status: 500, preserve: true },
  { name: '500 InvalidParameter does not prove rejection', body: '{"error":{"code":"InvalidParameter"}}', status: 500, preserve: true },
  { name: '503 Unauthorized does not prove rejection', body: '{"error":{"code":"Unauthorized"}}', status: 503, preserve: true },
  { name: '408 body does not prove rejection', body: '{"error":{"code":"InvalidParameter"}}', status: 408, preserve: true },
];
async function run(c) {
  let task = null, frozen = 0, allocations = 0, settlements = 0, posts = 0, recoveryReads = 0, failOnce = true;
  const ledger = [];
  const draft = { id: 'local-draft', provider: 'seedance', model: models.SEEDANCE_2_5_MODEL_ID,
    generation_mode: 'all_in_one_reference', prompt: 'fixture', ratio: '16:9', duration: 4, seed: 42,
    project_id: 'personal-project', video_card_id: null, local_status: 'succeeded', is_draft: true,
    provider_draft_task_id: 'provider-draft', retention_status: 'active', user_id: 'user', owner_user_id: 'user' };
  const db = {
    videoTask: {
      findUnique: async ({ where }) => where.id === draft.id ? draft : task,
      findFirst: async () => task,
      create: async ({ data }) => (task = { id: 'formal-task', created_at: new Date(), ...data }),
      update: async ({ data }) => {
        if (c.localFail === 'task' && failOnce && data.raw_create_response) { failOnce = false; throw new Error('local persistence failed'); }
        task = { ...task, ...data }; return task;
      },
    },
    creditLedger: { findFirst: async () => null, create: async ({ data }) => { ledger.push(data); return data; } },
    approvalUsage: { findMany: async () => [] },
  };
  db.$transaction = async fn => fn(db);
  const stubs = {
    '@/lib/creation/contract': { isCreationV2: () => true },
    '@/lib/creation/context': { assertVideoCreationReady: noop },
    '@/lib/creation/intents': { acceptVideoCreationIntent: noop },
    '@/lib/creation/lineage': { assertLegacyCreationSourceLocks: noop },
    '@/lib/canvas-references': { normalizeCanvasReferences: v => v },
    '@/lib/prisma': { prisma: db },
    '@/lib/admin/usage-attribution': { recordUsageAttribution: noop },
    '@/lib/video/multiview-request-receipt': { assertMultiviewRequestFence: noop },
    '@/lib/pricing/video': { quoteVideoPricing: async () => ({ revision: 'fixture', pricing: { estimatedCost: 18, pricingRuleId: 'fixture' } }), requireVideoPricingRevision() {}, assertVideoPricingAcceptance: noop },
    '@/lib/pricing/video-context': { resolveVideoPricingContext: async () => ({}), savedVideoPricingContextInput: () => ({}), verifyVideoPricingCredential() {}, videoPricingRequiresContext: async () => false },
    '@/lib/video-cards/permissions': { assertCanGenerateInVideoCard: noop },
    '@/lib/projects/permissions': { getProjectForGeneration: async () => ({ id: 'personal-project', type: 'personal' }), assertCanViewTask: noop, assertProjectActiveInTransaction: noop },
    '@/lib/provider/seedance-video-edit': { validateRequestCostCeiling: () => null },
    '@/lib/approvals': { consumeApprovalForTask: noop, findUsableApproval: noop },
    '@/lib/credits/policy': {
      allocateTaskCredits: async () => { allocations++; frozen += 18; return { snapshot: '[]', balance_before: 100, balance_after: 82, frozen_before: 0, frozen_after: 18 }; },
      settleTaskCredits: async () => { settlements++; frozen = 0; return { refundedAmount: 18, balanceBefore: 82, balanceAfter: 100, frozenBefore: 18, frozenAfter: 0, allocations: [] }; },
    },
    '@/lib/projects/budget': { shouldBillProjectBudget: () => false },
    '@/lib/costs/ledger': {
      createProviderApiRequest: async () => { if (c.beforeSend) throw new Error('before send'); return { id: 'request' }; },
      markProviderApiRequestAccepted: async () => { if (c.localFail === 'ledger') throw new Error('accepted request ledger unavailable'); },
      markProviderApiRequestFailed: noop, recordTaskCostEstimate: noop, recordTaskCostSettlement: noop,
    },
    '@/lib/provider/jimeng': { createSeedanceDraftUpgradeTask: provider.createSeedanceDraftUpgradeTask,
      getVideoTaskStatusByClientRequestId: async id => {
        recoveryReads++; assert.equal(id, 'formal-task');
        if (!c.recover) throw new Error('original query temporarily unavailable');
        return { provider_task_id: 'accepted-provider', provider_status: 'running', local_status: 'running', raw: {} };
      } },
    '@/lib/provider/seedance-draft': helpers,
    '@/lib/provider/seedance-models': models,
    '@/lib/video/task-localization-runner': { startTaskLocalization() {} },
    '@/lib/video/prompt-groups': { videoPromptGroupTaskRefs: () => [] },
    '@/lib/video/prompt-groups-build-mode': { VIDEO_PROMPT_GROUP_WRITES_ENABLED: true },
    '@/lib/video/prompt-groups.server': { resolveVideoPromptGroups: noop },
  };
  const mod = { exports: {} };
  new vm.Script(`(function(require,module,exports){${compiled}\n})`, { filename: serviceFile }).runInThisContext()(id => {
    assert.ok(Object.hasOwn(stubs, id), `Unexpected import: ${id}`); return stubs[id];
  }, mod, mod.exports);
  globalThis.fetch = async (url, init) => {
    posts++; assert.ok(String(url).endsWith('/call'));
    const body = JSON.parse(init.body); assert.equal(body.clientRequestId, 'formal-task');
    if (c.timeout) throw new DOMException('aborted', 'AbortError');
    return new Response(c.body, { status: c.status || 200 });
  };
  const input = { user: { id: 'user', role: 'user', account_type: 'internal', status: 'active' },
    creationBody: { creation_contract_version: 2, project_id: 'personal-project' }, draftTaskId: draft.id,
    resolutionApprovalConfirmed: true, idempotencyKey: 'original-upgrade', pricingRevision: 'fixture', maxEstimatedCost: 18 };
  if (c.preserve) {
    const result = await mod.exports.createSeedanceDraftUpgrade(input);
    assert.equal(settlements, 0); assert.equal(frozen, 18); assert.equal(task.frozen_cost, 18);
    assert.notEqual(task.local_status, 'failed'); assert.equal(recoveryReads, 1);
    assert.equal(result.pending_confirmation, !c.recover);
    if (c.known) assert.equal(task.provider_task_id, 'accepted-provider');
  } else {
    await assert.rejects(() => mod.exports.createSeedanceDraftUpgrade(input));
    assert.equal(settlements, 1); assert.equal(frozen, 0); assert.equal(task.frozen_cost, 0); assert.equal(task.local_status, 'failed');
    assert.equal(recoveryReads, 0);
  }
  const repeated = await mod.exports.createSeedanceDraftUpgrade(input);
  assert.equal(repeated.deduplicated, true); assert.equal(allocations, 1); assert.equal(posts, c.beforeSend ? 0 : 1);
  assert.equal(ledger.filter(v => v.type === 'task_failed_refund').length, c.preserve ? 0 : 1);
  return { name: c.name, passed: true, providerPosts: posts, originalRequestQueries: recoveryReads,
    freezes: allocations, refunds: settlements, frozenCredits: frozen, repeatedRequestDeduplicated: true };
}
(async () => {
  const original = globalThis.fetch;
  try {
    const results = [];
    for (const c of cases) results.push(await run(c));
    console.log(JSON.stringify({ passed: true, isolated: true, realProviderCalls: 0, realDatabaseCalls: 0, cases: results }, null, 2));
  } finally { globalThis.fetch = original; }
})().catch(error => { console.error(error); process.exitCode = 1; });
