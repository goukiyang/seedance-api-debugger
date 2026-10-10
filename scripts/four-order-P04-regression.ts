import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, posix } from 'node:path';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = process.cwd();
const ts = createRequire(join(app, 'package.json'))('typescript');
const owner = 'synthetic-owner';
const description = 'A synthetic portrait description with no real account or provider data.';
const requestId = '6f9619ff-8b86-4f5a-bf6b-9c0f98a7e7a3';
const parserVersion = '1.2.0';
const descriptionId = createHash('sha256').update(`parser-1.0.0:${description}`).digest('hex');
const rules = { layout: 'independent', description, referenceIds: [], choices: {}, locks: {}, intensity: 'standard', people: 1, candidates: 1 };
const attemptKey = `avatar:v1:${owner}:parse-attempt:${descriptionId}`;
const responseKey = `avatar:v1:${owner}:parse-response:${descriptionId}-${requestId}`;
const cacheKey = `avatar:v1:${owner}:parse:${descriptionId}`;

class StudioError extends Error { constructor(message: string, public status = 400) { super(message); } }
type TestStatus = { descriptionId: string; parserVersion?: string; requestId?: string; state: string; canContinueOriginal?: boolean; canRecheck: boolean };
type TestPlan = { id: string; candidates: Array<{ constraints: { interpretation?: string; description: string }; prompt: string }>; descriptionInterpretation?: { mode: string; descriptionId: string; parserVersion: string; originalAttemptRequestId?: string; source: string } };
type TestService = {
  avatarDescriptionStatus: (owner: string, description: string) => Promise<TestStatus>;
  prepareAvatarPlan: (owner: string, body: Record<string, unknown>) => Promise<TestPlan>;
};

function makeHarness(options: { state?: 'unknown' | 'pending'; ageMs?: number; requestId?: string; cost?: string; responseId?: string } = {}) {
  const rows = new Map<string, { id: string; key: string; value_json: string; updated_at: Date }>();
  const calls = { text: 0, quote: 0, submit: 0 };
  let beforeTransaction: (() => void) | undefined;
  const attemptUpdatedAt = new Date(Date.now() - 1000);
  const attemptRaw = JSON.stringify({ version: 2, parserVersion, requestId: options.requestId || requestId,
    state: options.state || 'unknown', createdAt: new Date(Date.now() - (options.ageMs ?? 300000)).toISOString(),
    updatedAt: new Date(Date.now() - (options.ageMs ?? 300000)).toISOString(), cost: options.cost || 'unknown',
    ...(options.responseId ? { responseId: options.responseId } : {}) });
  rows.set(attemptKey, { id: 'attempt-row', key: attemptKey, value_json: attemptRaw, updated_at: attemptUpdatedAt });
  const platformSetting = {
    findUnique: async ({ where }: { where: { key: string } }) => rows.get(where.key) || null,
    findMany: async () => [],
    create: async ({ data }: { data: { key: string; value_json: string } }) => { if (rows.has(data.key)) throw new Error('synthetic duplicate'); rows.set(data.key, { id: randomUUID(), key: data.key, value_json: data.value_json, updated_at: new Date() }); return data; },
    updateMany: async ({ where, data }: { where: { id?: string; key: string; value_json?: string; updated_at?: Date }; data: { value_json: string; updated_at?: Date } }) => {
      const row = rows.get(where.key);
      if (!row || where.id !== undefined && row.id !== where.id || where.value_json !== undefined && row.value_json !== where.value_json
        || where.updated_at !== undefined && row.updated_at.getTime() !== where.updated_at.getTime()) return { count: 0 };
      row.value_json = data.value_json;
      if (data.updated_at) row.updated_at = data.updated_at;
      return { count: 1 };
    },
  };
  const prisma = {
    platformSetting,
    $transaction: async (run: (tx: { platformSetting: typeof platformSetting }) => Promise<unknown>) => {
      const hook = beforeTransaction; beforeTransaction = undefined; hook?.();
      return run({ platformSetting });
    },
  };
  const mocks: Record<string, unknown> = {
    'node:crypto': { createHash, randomUUID },
    '@/lib/prisma': { prisma },
    '@/lib/integrations/musk': {
      getMuskApiSettings: async () => { calls.text++; throw new Error('text model calls are forbidden in this fixture'); },
      isMuskApiReady: () => true,
      createMuskChatCompletion: async () => { calls.text++; throw new Error('text model calls are forbidden in this fixture'); },
      MuskApiError: class MuskApiError extends Error { constructor(message: string, public status: number, public code: string) { super(message); } },
    },
    '@/lib/image-studio/settings': { getImageStudioSettings: async () => ({ revision: 7, model: 'synthetic-image', prices: { 'synthetic-image': 5 } }) },
    '@/lib/image-studio/tasks': {
      StudioError,
      submitStudioBatch: async () => { calls.submit++; throw new Error('image submission is forbidden in this fixture'); },
    },
    '@/lib/image-studio/model-catalog': { IMAGE_STUDIO_MODELS: ['synthetic-image'], normalizeImageStudioQuality: (_model: string, value: string) => value || 'auto' },
    '@/lib/integrations/image-generation': {
      getImageGenerationSettingsForModel: async () => ({ provider: 'synthetic', supports_image_to_image: true, supports_text_to_image: true }),
      isImageGenerationApiReady: () => true,
      isStudioImageGenerationProvider: () => true,
    },
    '@/lib/image-generation/resolution': { normalizeImageResolution: (_model: string, value: string) => value || '1K' },
    '@/lib/image-studio/reference-policy': { defaultStudioReferencePolicy: () => ({}), validateStudioReferenceCounts: () => undefined },
    '@/lib/image-studio/protected-assets': { studioVisibleAssetWhere: async () => ({}) },
    '@/lib/image-studio/billing-quote-service': { prepareImageBillingQuote: async () => { calls.quote++; throw new Error('quote calls are not part of prepare'); } },
    '@/lib/image-studio/billing-scope': { imageBillingScope: () => 'synthetic' },
    '@/lib/image-studio/billing-readiness': { imageBillingReady: async () => ({ ready: false }) },
    '@/lib/image-studio/billing-provider': { readImageSupplierBills: async () => [] },
    '@/lib/image-studio/billing-quote': { supplierHistoryEstimate: () => null },
    './store': {
      avatarKey: (account: string, kind: string, id: string) => `avatar:v1:${account}:${kind}:${id}`,
      avatarPlanKey: (account: string, plan: { id: string }) => `avatar:v1:${account}:plan:${plan.id}`,
      avatarRecordKey: (account: string, record: { id: string }) => `avatar:v1:${account}:record:${record.id}`,
      readAvatar: async (account: string, kind: string, id: string) => {
        const row = rows.get(`avatar:v1:${account}:${kind}:${id}`);
        return row ? JSON.parse(row.value_json) : null;
      },
    },
    './engine': {
      parseAvatarRules: (input: typeof rules) => ({ ...input, description: input.description.trim() }),
      emptyConstraints: () => ({ description: '', explicit: {}, details: [], scopes: [], background: '', unrecognized: [], conflicts: [], parserVersion }),
      createAvatarCandidates: (inputRules: typeof rules, constraints: Record<string, unknown>) => [{
        characterId: 'synthetic-character', members: [{ fields: {}, details: [], seed: 'synthetic', ruleVersion: '1.2.0', featureBudget: 0 }],
        standardDescription: 'Synthetic only', prompt: `Synthetic prompt; complete description: ${inputRules.description}`,
        compilerVersion: '1.5.0', rules: inputRules, constraints,
      }],
      adaptAvatarPrompt: (candidate: unknown) => candidate,
    },
    './layout': {
      avatarLayout: (value: { layout?: string }) => value.layout || 'independent',
      avatarOutputCount: (plan: { candidates: unknown[] }) => plan.candidates.length,
      withAvatarLayout: (plan: Record<string, unknown>, layout: string) => ({ ...plan, layout }),
      isAvatarSheet: () => false,
      avatarSheetLabel: () => '宫格',
    },
  };
  const cache = new Map<string, { exports: Record<string, unknown> }>();
  function load(path: string): Record<string, unknown> {
    assert.match(path, /^src\/lib\/avatar-random\/[a-z-]+\.ts$/);
    if (cache.has(path)) return cache.get(path)!.exports;
    const module = { exports: {} as Record<string, unknown> };
    cache.set(path, module);
    const source = readFileSync(join(app, path), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const localRequire = (name: string) => {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (name.startsWith('./')) return load(posix.join(posix.dirname(path), `${name.slice(2)}.ts`));
      throw new Error(`Unmocked import in isolated fixture: ${name}`);
    };
    vm.runInNewContext(`(function(require,module,exports){${code}\n})`, {}, { timeout: 2000 })(localRequire, module, module.exports);
    return module.exports;
  }
  const service = load('src/lib/avatar-random/service.ts') as unknown as TestService;
  return { service, rows, calls, attemptRaw, attemptUpdatedAt, setBeforeTransaction: (hook?: () => void) => { beforeTransaction = hook; } };
}

function requestBody(parse: { descriptionId: string; parserVersion?: string; requestId?: string }) {
  return { actionType: 'new', rules, descriptionId: parse.descriptionId, parserVersion: parse.parserVersion,
    descriptionMode: 'original', originalAttemptRequestId: parse.requestId, model: 'synthetic-image', quality: 'auto', resolution: '1K' };
}

async function main() {
  let cases = 0;
  const base = makeHarness();
  const before = await base.service.avatarDescriptionStatus(owner, description);
  assert.equal(before.state, 'unknown'); assert.equal(before.canContinueOriginal, true); assert.equal(before.canRecheck, false);
  const plan = await base.service.prepareAvatarPlan(owner, requestBody(before));
  assert.equal(plan.candidates[0].constraints.interpretation, 'original');
  assert.equal(plan.candidates[0].constraints.description, description);
  assert.ok(plan.candidates[0].prompt.includes(description));
  assert.equal(JSON.stringify(plan.descriptionInterpretation), JSON.stringify({ mode: 'original', descriptionId, parserVersion, originalAttemptRequestId: requestId, source: 'original-description' }));
  assert.equal(base.rows.get(attemptKey)?.value_json, base.attemptRaw);
  assert.equal(base.rows.get(attemptKey)?.updated_at.getTime(), base.attemptUpdatedAt.getTime());
  assert.equal(base.rows.has(cacheKey), false);
  assert.equal(base.calls.text, 0); assert.equal(base.calls.quote, 0); assert.equal(base.calls.submit, 0);
  const savedPlan = JSON.parse(base.rows.get(`avatar:v1:${owner}:plan:${plan.id}`)!.value_json);
  assert.equal(JSON.stringify(savedPlan.descriptionInterpretation), JSON.stringify(plan.descriptionInterpretation));
  cases++;

  const active = makeHarness({ state: 'pending', ageMs: 119000 });
  const activeStatus = await active.service.avatarDescriptionStatus(owner, description);
  assert.equal(activeStatus.state, 'pending'); assert.equal(activeStatus.canContinueOriginal, undefined);
  await assert.rejects(active.service.prepareAvatarPlan(owner, requestBody({ ...activeStatus, requestId })), (error: { status?: number }) => error.status === 409);
  assert.equal(active.rows.get(attemptKey)?.value_json, active.attemptRaw); assert.equal(active.calls.text, 0);
  assert.equal(Array.from(active.rows.keys()).some(key => key.includes(':plan:')), false); cases++;

  const expired = makeHarness({ state: 'pending', ageMs: 130000 });
  const expiredStatus = await expired.service.avatarDescriptionStatus(owner, description);
  assert.equal(expiredStatus.state, 'unknown'); assert.equal(expiredStatus.canContinueOriginal, true);
  const expiredPlan = await expired.service.prepareAvatarPlan(owner, requestBody(expiredStatus));
  assert.equal(expiredPlan.descriptionInterpretation?.originalAttemptRequestId, requestId); assert.equal(expired.calls.text, 0); cases++;

  const wrongBinding = makeHarness();
  const wrongStatus = await wrongBinding.service.avatarDescriptionStatus(owner, description);
  await assert.rejects(wrongBinding.service.prepareAvatarPlan(owner, { ...requestBody(wrongStatus), originalAttemptRequestId: '6f9619ff-8b86-4f5a-bf6b-9c0f98a7e7b4' }), (error: { status?: number }) => error.status === 409);
  assert.equal(wrongBinding.rows.get(attemptKey)?.value_json, wrongBinding.attemptRaw); assert.equal(wrongBinding.calls.text, 0); cases++;

  const malformed = makeHarness({ requestId: 'not-a-legal-request-id' });
  const malformedStatus = await malformed.service.avatarDescriptionStatus(owner, description);
  assert.equal(malformedStatus.canContinueOriginal, undefined);
  await assert.rejects(malformed.service.prepareAvatarPlan(owner, requestBody({ ...malformedStatus, requestId: 'not-a-legal-request-id' })), (error: { status?: number }) => error.status === 409);
  assert.equal(malformed.rows.get(attemptKey)?.value_json, malformed.attemptRaw); assert.equal(malformed.calls.text, 0); cases++;

  const replyRace = makeHarness();
  const replyStatus = await replyRace.service.avatarDescriptionStatus(owner, description);
  replyRace.setBeforeTransaction(() => replyRace.rows.set(responseKey, { id: 'reply-row', key: responseKey, value_json: JSON.stringify({ content: '{"synthetic":true}' }), updated_at: new Date() }));
  await assert.rejects(replyRace.service.prepareAvatarPlan(owner, requestBody(replyStatus)), (error: { status?: number }) => error.status === 409);
  assert.equal(replyRace.rows.get(attemptKey)?.value_json, replyRace.attemptRaw);
  assert.equal(Array.from(replyRace.rows.keys()).some(key => key.includes(':plan:')), false);
  assert.equal(replyRace.calls.text, 0); assert.equal(replyRace.calls.quote, 0); assert.equal(replyRace.calls.submit, 0); cases++;

  const cacheRace = makeHarness();
  const cacheStatus = await cacheRace.service.avatarDescriptionStatus(owner, description);
  cacheRace.setBeforeTransaction(() => cacheRace.rows.set(cacheKey, { id: 'cache-row', key: cacheKey, value_json: JSON.stringify({ description, explicit: {}, details: [], scopes: [], background: '', unrecognized: [], conflicts: [], parserVersion }), updated_at: new Date() }));
  await assert.rejects(cacheRace.service.prepareAvatarPlan(owner, requestBody(cacheStatus)), (error: { status?: number }) => error.status === 409);
  assert.equal(cacheRace.rows.get(attemptKey)?.value_json, cacheRace.attemptRaw);
  assert.equal(Array.from(cacheRace.rows.keys()).some(key => key.includes(':plan:')), false); assert.equal(cacheRace.calls.text, 0); cases++;

  const casRace = makeHarness();
  const casStatus = await casRace.service.avatarDescriptionStatus(owner, description);
  const changedAttempt = JSON.stringify({ ...JSON.parse(casRace.attemptRaw), updatedAt: new Date().toISOString() });
  casRace.setBeforeTransaction(() => casRace.rows.set(attemptKey, { id: 'attempt-row', key: attemptKey, value_json: changedAttempt, updated_at: new Date() }));
  await assert.rejects(casRace.service.prepareAvatarPlan(owner, requestBody(casStatus)), (error: { status?: number }) => error.status === 409);
  assert.equal(casRace.rows.get(attemptKey)?.value_json, changedAttempt);
  assert.equal(Array.from(casRace.rows.keys()).some(key => key.includes(':plan:')), false); assert.equal(casRace.calls.text, 0); cases++;

  const savedReply = makeHarness();
  savedReply.rows.set(responseKey, { id: 'saved-reply-row', key: responseKey, value_json: JSON.stringify({ content: '{"saved":true}' }), updated_at: new Date() });
  const savedStatus = await savedReply.service.avatarDescriptionStatus(owner, description);
  assert.equal(savedStatus.canRecheck, true); assert.equal(savedStatus.canContinueOriginal, undefined);
  await assert.rejects(savedReply.service.prepareAvatarPlan(owner, requestBody(savedStatus)), (error: { status?: number }) => error.status === 409);
  assert.equal(savedReply.calls.text, 0); assert.equal(Array.from(savedReply.rows.keys()).some(key => key.includes(':plan:')), false); cases++;

  const routeSource = readFileSync(join(app, 'src/app/api/avatar-studio/route.ts'), 'utf8');
  const uiSource = readFileSync(join(app, 'src/app/tools/avatar-studio/studio.tsx'), 'utf8');
  const serviceSource = readFileSync(join(app, 'src/lib/avatar-random/service.ts'), 'utf8');
  assert.match(routeSource, /isLegalAvatarParserVersion\(body\.parserVersion\)/);
  assert.match(routeSource, /isLegalDescriptionRequestId\(body\.originalAttemptRequestId\)/);
  assert.match(routeSource, /validateOriginalContinuation\(body\)/);
  assert.match(serviceSource, /descriptionInterpretation: plan\.descriptionInterpretation/);
  assert.match(routeSource, /planId:plan!\.id,taskId:result\.id/);
  assert.match(uiSource, /按原描述生成/); assert.match(uiSource, /descriptionInterpretationLabel\(record\.descriptionInterpretation\)/);
  cases++;

  const serviceAst = ts.createSourceFile('service.ts', serviceSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const name of ['submitAvatarPlan', 'quoteAvatarPlan']) {
    const fn = serviceAst.statements.find((node: any) => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(fn?.body, `function exists: ${name}`);
    const calls: string[] = [];
    const visit = (node: any) => { if (ts.isCallExpression(node)) calls.push(node.expression.getText(serviceAst)); ts.forEachChild(node, visit); };
    visit(fn.body);
    assert.ok(!calls.some(call => ['parseAvatarDescription', 'resolveDescription', 'createMuskChatCompletion'].includes(call)), `${name} does not call the text model`);
  }
  assert.ok(serviceSource.includes('billingQuoteId: draft?.billingQuoteId') && serviceSource.includes('maxEstimatedCost: draft?.maxEstimatedCost'));
  assert.ok(uiSource.includes('maxEstimatedCost:Math.ceil(quote.estimatedCredits)'));
  cases++;

  console.log(JSON.stringify({ ok: true, cases, providerCalls: 0, databaseConnections: 0, imageSubmissions: 0, quoteCalls: 0,
    fixtureData: 'synthetic in-memory only', functionalAcceptance: false }));
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
