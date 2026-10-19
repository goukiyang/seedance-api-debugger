import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

type Value = Record<string, unknown>;
type Payload = Value & { nodeId: string; prompt: string; settings: Value };
type Job = Value & { input?: Value; requestId?: string; batchId?: string };
type Node = { id: string; type: string; data: Value & { styleJob?: Job } };
type CanvasApi = {
  prefetchActualQuote(nodeId: string, safeQuote: Value): Promise<Value | null>;
  generate(payload: Payload, prompt?: string): Promise<Value>;
  generateOrdinary(payload: Payload, prompt: string): Promise<Value>;
  invalidateQuote(nodeId: string): void;
};
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

/** Real browser module, injected I/O only: no copied quote/cache/submission algorithm. */
export async function verifyCanvasQuoteContract(root: string, inputPlan: unknown, check: (name: string) => void) {
  const outputPlan = plain(inputPlan) as Value;
  const source = readFileSync(path.join(root, 'public/tools/ultimate-canvas/canvas-styles.js'), 'utf8');
  const outcomes: Value[] = [];
  for (const style of [false, true]) for (const actual of [false, true]) for (const role of [false, true]) for (const policy of [false, true]) {
    const context = { userId: 'canvas-fixture-owner', projectId: 'canvas-fixture-project', cardId: 'canvas-fixture-card',
      documentId: 'canvas-fixture-document', writable: true };
    const model = 'gpt-image-2.5-sunburst', revision = 7;
    const imageChannel = { channelId: 'original', configRevision: 'fixture-frozen-original' };
    const settings = { model, quality: 'auto', resolution: '2K', requestedRatio: 'auto', ratio: 'auto', count: 1 };
    const payload: Payload = { nodeId: 'canvas-fixture-node', prompt: 'Synthetic prompt', settings, referenceImageIds: [] };
    const node: Node = { id: payload.nodeId, type: 'image', data: { prompt: payload.prompt,
      ...(style ? { canvasStyle: { appliedBy: context.userId, moduleId: randomUUID(), settingsRevision: revision,
        moduleRevision: 2, model, quality: 'auto', resolution: '2K', count: 1, aspectRatio: 'auto', unitCredits: 5 } } : {}) } };
    const safeQuote = { kind: 'image', projectId: context.projectId, model, count: 1, revision, status: 'estimate',
      chargeEnabled: false, actualQuoteRequired: actual, pricingQuoteRequired: policy,
      ...(policy ? { pricingRevision: 'rate-canvas-fixture' } : {}),
      unitCredits: actual ? null : 5, estimatedCredits: actual ? null : 5,
      expiresAt: new Date(Date.now() + 120000).toISOString(), imageChannel, modelOptions: [] };
    const fullQuote = { billingMode: actual ? 'actual' : 'fixed', actualChargeEnabled: actual,
      billingQuoteId: `quote-${style}-${actual}-${role}`, ratioContractVersion: 3, model, count: 1, revision,
      estimatedCredits: actual ? 6.2 : 5, expiresAt: safeQuote.expiresAt, imageChannel,
      ...(policy ? { pricingRevision: 'rate-canvas-fixture' } : {}),
      outputPlan, outputPlans: [outputPlan] };
    const calls: Array<{ url: string; method: string; input: Value | undefined }> = [];
    const confirmations: Value[] = [], shownQuotes: Value[] = [];
    const roleMediaContext = { workId: 'role-work-fixture', roleId: 'role-fixture', actionId: 'role-action-fixture', binding: 'frozen-role-binding' };
    let submissionUnknown = false;
    const hooks = {
      getNode: (id: string) => id === node.id ? node : null,
      context: () => context, getGenerationPayload: () => payload,
      getQuoteSnapshot: () => JSON.stringify([payload, role ? roleMediaContext : null]),
      attachRoleMediaContext: (input: Value) => { if (role) input.roleMediaContext = plain(roleMediaContext); },
      flush: async () => true, save: () => {}, render: () => {}, status: () => {}, notice: () => {},
      clearQuote: () => {}, clearActualQuote: () => {}, quoteConsumed: () => {}, billing: () => {},
      showQuote: (_id: string, quote: Value) => { shownQuotes.push(plain(quote)); },
      confirm: async (view: Value) => { confirmations.push(plain(view)); return true; },
      request: async (url: string, options: { method?: string; payload?: Value }) => {
        const input = options.payload; calls.push({ url, method: options.method || 'GET', input: input ? plain(input) : undefined });
        if (url === '/api/tools/ultimate-canvas/quote') return plain(safeQuote);
        if (url.endsWith('/generate') && input?.action === 'quote') return plain(fullQuote);
        if (url.endsWith('/generate')) {
          if (submissionUnknown) throw new Error('Synthetic connection closed after submission');
          return { batchId: 'original-canvas-batch' };
        }
        if (url === '/api/tools/ultimate-canvas/styles/results') return submissionUnknown
          ? { status: 'not_found', pending: false, assets: [] }
          : { status: 'succeeded', pending: false, assets: [{ id: 'synthetic-canvas-result' }], billing: [] };
        assert.fail(`Unexpected canvas I/O: ${url}`);
      },
    };
    const sandbox = vm.createContext({ window: { setTimeout, clearTimeout }, document: { hidden: false },
      crypto: { randomUUID }, Date, AbortSignal, AbortController, URLSearchParams, structuredClone, console });
    vm.runInContext(source, sandbox, { filename: 'canvas-styles.js', timeout: 5000 });
    const factory = sandbox.window.UltimateCanvasStyles as { create(value: typeof hooks): CanvasApi };
    const api = factory.create(hooks);
    const prefetched = await api.prefetchActualQuote(node.id, safeQuote);
    assert.ok(prefetched, `${style ? 'style' : 'ordinary'} ${actual ? 'actual' : 'fixed'} quote must be prepared`);
    assert.deepEqual(plain(prefetched), fullQuote);
    const fullRequest = calls.find(call => call.url.endsWith('/generate') && call.input?.action === 'quote');
    assert.ok(fullRequest?.input); const preparedRequestId = fullRequest.input.requestId;
    const generate = () => style ? api.generate(payload) : api.generateOrdinary(payload, payload.prompt);
    await generate();
    const submissions = calls.filter(call => call.url.endsWith('/generate') && call.input?.action !== 'quote');
    assert.equal(submissions.length, 1); const submitted = submissions[0].input!;
    assert.equal(submitted.requestId, preparedRequestId); assert.equal(submitted.billingQuoteId, fullQuote.billingQuoteId);
    assert.equal(submitted.maxEstimatedCost, actual ? 6.2 : 5, 'The frozen quote amount must not be rounded up');
    assert.equal(submitted.pricingRevision, policy ? 'rate-canvas-fixture' : undefined);
    assert.deepEqual(submitted.imageChannel, imageChannel);
    assert.deepEqual(submitted.roleMediaContext, role ? roleMediaContext : undefined);
    assert.deepEqual(fullRequest.input.roleMediaContext, role ? roleMediaContext : undefined);
    assert.equal(confirmations.length, actual || policy || !style ? 1 : 0, 'Retain RATE confirmation and do not add a second plan-only fixed confirmation');
    if (!actual && !style) {
      const detail = String(confirmations[0].detail || '');
      assert.ok(detail.includes(String(outputPlan.outputSize)) || detail.includes(`${outputPlan.width}×${outputPlan.height}`), 'Existing confirmation shows actual output dimensions');
    }
    if (actual || !style) assert.ok(shownQuotes.some(quote => quote.billingQuoteId === fullQuote.billingQuoteId));

    // Preserve the real saved unknown job, rather than forging a new submission identity.
    submissionUnknown = true; api.invalidateQuote(node.id);
    await api.prefetchActualQuote(node.id, safeQuote);
    await assert.rejects(generate());
    const originalJob = plain(node.data.styleJob); assert.ok(originalJob?.requestId);
    const originalInput = plain(originalJob.input), unknownStart = calls.length;
    const confirmationsBefore = confirmations.length;
    await assert.rejects(generate());
    const reentry = calls.slice(unknownStart);
    assert.equal(reentry.length, 1); assert.equal(reentry[0].url, '/api/tools/ultimate-canvas/styles/results');
    assert.equal(reentry[0].input?.requestId, originalJob.requestId);
    assert.deepEqual(plain(node.data.styleJob?.input), originalInput);
    assert.equal(confirmations.length, confirmationsBefore);
    outcomes.push({ style, actual, role, policy, confirmations: actual || policy || !style ? 1 : 0,
      preparedRequestId, billingQuoteId: fullQuote.billingQuoteId, unknownQueryEndpoint: reentry[0].url,
      unknownBrowserMethod: reentry[0].method, generationPostsOnUnknownReentry: 0 });
  }
  check('canvas_fixed_ordinary_and_style_keep_plan_quote_token_and_original_confirmation_count');
  check('canvas_actual_original_confirmation_and_max_authorization_are_unchanged');
  check('canvas_role_context_and_unknown_job_identity_survive_query_only_reentry_without_repost');
  return outcomes;
}
