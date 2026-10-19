import strictAssert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { requestVideoPricing, requireVideoPricingWithinCeiling, videoPricingBusinessInput,
  videoPricingRequestKey, validVideoPricingAmount, type VideoPricingRequest } from '@/lib/pricing-client';
import { stableGenerationPayloadJson } from '@/lib/template-studio-video-handoff';
import { buildMultiviewGenerationRequest, defaultMultiviewGenerationDraft } from '@/lib/video/multiview-generation-contract';

function fixtureChecks() {
  let assertions = 0;
  return {
    get assertions() { return assertions; },
    equal(actual: unknown, expected: unknown, message?: string) { strictAssert.equal(actual, expected, message); assertions++; },
    notEqual(actual: unknown, expected: unknown, message?: string) { strictAssert.notEqual(actual, expected, message); assertions++; },
    deepEqual(actual: unknown, expected: unknown, message?: string) { strictAssert.deepEqual(actual, expected, message); assertions++; },
    ok(actual: unknown, message?: string) { strictAssert.ok(actual, message); assertions++; },
    throws(action: () => unknown) { strictAssert.throws(action); assertions++; },
    async rejects(action: () => Promise<unknown>) { await strictAssert.rejects(action); assertions++; },
  };
}

type CanvasSettings = {
  provider: string; model: string; duration: number; resolution: string; ratio: string; draft?: boolean;
  maxEstimatedCost?: number; pricingRevision?: string | null; pricingQuoteToken?: string;
};
type CanvasPayload = { kind: string; nodeId: string; requestId: string; mode: string; prompt: string; settings: CanvasSettings };
type CanvasInput = Omit<CanvasPayload, 'kind'> & {
  projectId: string; cardId: string; documentId: string; referenceVideoUrls: string[];
};
type Descriptor = { url: string; method: string; payload: Record<string, unknown> };
type CanvasSubmission = { requestId: string; state: string; userId: string; documentId: string;
  input: Record<string, unknown>; generationPayload: CanvasPayload };
type CanvasNode = { id: string; type: string; data: { videoSettings: CanvasSettings; referenceVideoUrls: string[];
  videoSubmission?: CanvasSubmission; videoSubmissionLegacy?: boolean } };
type VideoEstimate = { status: string; signature: string; pricingQuoteToken?: string };
type CanvasWorkflow = {
  videoRequest(input: CanvasInput): Descriptor;
  videoPricingRequest(input: CanvasInput, originalInput?: Record<string, unknown>): Descriptor;
  withVideoPricingQuote(settings: CanvasSettings, quote: unknown, maximum?: unknown): CanvasSettings;
};
type CanvasAdapter = { generate(payload: CanvasPayload): Promise<Record<string, unknown>> };
type CanvasConsumers = {
  installGenerationAdapter(): void;
  videoEstimateSignature(settings: CanvasSettings, nodeId: string): string;
  scheduleVideoEstimate(nodeId: string): void;
  submitNodeGeneration(nodeElement: object, button: object, payload: CanvasPayload): Promise<void>;
  imageChannelIssueForNode(node: { type: string; id: string }): string;
  canvasImageQuotePriceText(quote: unknown): string;
};

function loadUmd<T>(file: string): T {
  const filename = resolve(file), module = { exports: {} };
  vm.runInNewContext(readFileSync(filename, 'utf8'), { module, URL }, { filename, timeout: 1000 });
  return module.exports as T;
}

function loadCanvasConsumers(dependencies: Record<string, unknown>, assert: ReturnType<typeof fixtureChecks>): CanvasConsumers {
  const filename = resolve('public/tools/ultimate-canvas/app.js');
  const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const names = ['installGenerationAdapter', 'videoGenerationRequestInput', 'videoEstimateSignature', 'scheduleVideoEstimate',
    'currentGenerationContext', 'hasCurrentGenerationSubmission', 'submitNodeGeneration', 'imageChannelIssueForNode', 'canvasImageQuotePriceText'];
  const functions: ts.FunctionDeclaration[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) functions.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(functions.length, names.length, 'Load the actual canvas consumers without bootstrapping the DOM');
  const sandbox = { ...dependencies, fixtureConsumers: undefined as CanvasConsumers | undefined };
  vm.runInNewContext(`${functions.map(fn => fn.getText(source)).join('\n')}\nglobalThis.fixtureConsumers = {${names.join(',')}};`,
    sandbox, { filename, timeout: 1000 });
  return sandbox.fixtureConsumers!;
}

async function canvasConsumerAssertions(assert: ReturnType<typeof fixtureChecks>) {
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
  const workflow = loadUmd<CanvasWorkflow>('public/tools/ultimate-canvas/generation-node-workflow.js');
  const interactions = loadUmd<{ createGenerationSubmissionTracker(): unknown }>('public/tools/ultimate-canvas/generation-node-interactions.js');
  const settings: CanvasSettings = { provider: 'seedance', model: 'dreamina-seedance-2-5-260628', duration: 5,
    resolution: '720p', ratio: '16:9', draft: true };
  const quote = { estimatedCost: 0.5, pricing_revision: 'canvas-revision', pricing_quote_token: 'canvas-token' };
  const input: CanvasInput = { projectId: 'project-a', cardId: 'card-a', documentId: 'document-a', nodeId: 'video-a',
    requestId: 'original-request', mode: 'text-to-video', prompt: 'Original prompt',
    referenceVideoUrls: ['https://fixture.invalid/reference-a'], settings };
  const priced = workflow.withVideoPricingQuote(settings, quote);
  const create = workflow.videoRequest({ ...input, settings: priced });
  const estimate = workflow.videoPricingRequest(input);
  assert.equal(estimate.url, '/api/tasks/estimate'); assert.equal(estimate.method, 'POST');
  for (const field of ['provider', 'model', 'resolution', 'duration', 'ratio', 'project_id', 'video_card_id', 'draft', 'reference_video_urls']) {
    assert.deepEqual(plain(estimate.payload[field]), plain(create.payload[field]), field);
  }
  assert.equal(create.payload.pricing_quote_token, quote.pricing_quote_token);
  assert.equal(create.payload.pricing_fingerprint_version, 2); assert.equal(create.payload.max_estimated_cost, 0.5);
  assert.equal(workflow.videoRequest({ ...input, settings: { ...priced, provider: 'h3' } }).payload.provider, 'h3');
  const ip = workflow.videoRequest({ ...input, settings: { ...priced, provider: 'volcengine_ip' } });
  assert.equal(ip.url, '/api/ip/tasks/create'); assert.equal('pricing_quote_token' in ip.payload, false);
  assert.equal('pricing_fingerprint_version' in ip.payload, false);
  assert.equal(workflow.withVideoPricingQuote(settings, quote, 1).maxEstimatedCost, 1);
  assert.throws(() => workflow.withVideoPricingQuote(settings, { ...quote, estimatedCost: 1.1 }, 1));
  assert.throws(() => workflow.withVideoPricingQuote(settings, { ...quote, pricing_quote_token: '' }));
  assert.throws(() => workflow.videoPricingRequest({ ...input, referenceVideoUrls: ['a', 'b', 'c', 'd'] }));

  const node: CanvasNode = { id: input.nodeId, type: 'video', data: { videoSettings: { ...settings }, referenceVideoUrls: input.referenceVideoUrls.slice() } };
  const runtime = { bootstrap: { user: { id: 'actor-a' }, capabilities: {} }, contextEpoch: 1,
    selectedProjectId: input.projectId, selectedVideoCardId: input.cardId, selectedVideoBranchId: '', documentId: input.documentId,
    videoEstimates: new Map<string, VideoEstimate>(), unsentVideoRequests: new Map<string, CanvasSubmission>(),
    pendingGenerationSubmissions: interactions.createGenerationSubmissionTracker() };
  const timers = new Map<number, () => Promise<void>>(); let nextTimer = 0, adapter: CanvasAdapter | undefined;
  let request: (url: string, options: { payload?: Record<string, unknown>; headers?: Record<string, string> }) => Promise<unknown> = async () => { throw Error('Unexpected fixture request'); };
  let ready = true, confirmations = 0, recoveries = 0, creates = 0;
  let confirm: () => Promise<boolean> = async () => { confirmations++; return true; };
  let flush: () => Promise<boolean> = async () => true;
  const notices: string[] = [], events: string[] = [];
  const imageSettings = { model: 'gpt-image-2', quality: 'auto', resolution: '2K', requestedRatio: '1:1', count: 1 };
  const model = { ready: true, billingMode: 'fixed', fixedPoints: null, pricingBySpecification: true,
    qualities: ['auto'], resolutions: ['2K'], ratios: ['1:1'], maxReferences: 9 };
  const channel = { id: 'managed-fixture', ready: true, configured: true, enabled: true, models: { 'gpt-image-2': model } };
  const window = {
    UltimateCanvasGenerationNodes: workflow, UltimateCanvasGenerationInteractions: interactions,
    UltimateCanvasNodePricing: { validCredits: validVideoPricingAmount, formatCredits: (value: number) => String(value) },
    CanvasGenerationAPI: { setAdapter(value: CanvasAdapter) { adapter = value; }, generate(payload: CanvasPayload) { return adapter!.generate(payload); } },
    setTimeout(callback: () => Promise<void>) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id: number) { timers.delete(id); },
  };
  const dependencies = {
    window, canvasRuntime: runtime, engine: { nodes: new Map([[node.id, node]]) }, AbortController, structuredClone,
    requestJson: (url: string, options: { payload?: Record<string, unknown>; headers?: Record<string, string> }) => request(url, options),
    requestCanvasConfirmation: () => confirm(), flushCanvasSave: () => flush(),
    canvasWorkspaceKey: () => 'fixture-workspace', promptWithConnectedText: (payload: CanvasPayload) => payload.prompt || '',
    collectReferenceImageIds: () => [], generationSettingsForNode: (value: CanvasNode) => value.type === 'image' ? imageSettings : value.data.videoSettings,
    renderGenerationNodeControls: () => {}, generationReadiness: () => ({ ready, message: 'Fixture capability unavailable' }),
    recoverVideoSubmission: async () => { recoveries++; }, showCanvasNotice: (message: string) => { notices.push(message); },
    setSubmitLoading: () => {}, setNodeGenerationStatus: () => {}, applyGenerationResult: () => {},
    scheduleCanvasSave: () => {}, cacheCanvasDraft: () => {}, canvasSaveSnapshot: () => ({}), prepareVideoSubmissionView: () => {},
    decorateGeneratedNode: () => {}, notifyRoleMediaChanged: () => {}, roleMediaContextForNode: () => null,
    backendEndpoint: (url: string) => url, selectedImageChannel: () => ({ channel }), usesLegacyImageRoute: () => false,
    generationReferenceImageIds: () => [],
  };
  const consumers = loadCanvasConsumers(dependencies, assert);
  const signature = consumers.videoEstimateSignature(node.data.videoSettings, node.id);
  for (const change of [() => { runtime.bootstrap.user.id = 'actor-b'; }, () => { runtime.selectedProjectId = 'project-b'; },
    () => { runtime.selectedVideoCardId = 'card-b'; }, () => { runtime.documentId = 'document-b'; },
    () => { node.data.videoSettings.ratio = '9:16'; }, () => { node.data.videoSettings.draft = false; },
    () => { node.data.referenceVideoUrls = ['https://fixture.invalid/reference-b']; }]) {
    change(); assert.notEqual(consumers.videoEstimateSignature(node.data.videoSettings, node.id), signature);
    runtime.bootstrap.user.id = 'actor-a'; runtime.selectedProjectId = input.projectId; runtime.selectedVideoCardId = input.cardId;
    runtime.documentId = input.documentId; node.data.videoSettings = { ...settings }; node.data.referenceVideoUrls = input.referenceVideoUrls.slice();
  }
  let resolveOld: (value: unknown) => void = () => { throw Error('Old request was not started'); };
  request = async (_url, options) => {
    assert.equal(options.headers?.['x-app-session-user'], 'actor-a');
    if (options.payload?.video_card_id === 'card-a') return new Promise(resolve => { resolveOld = resolve; });
    return { ...quote, pricing_quote_token: 'new-card-token' };
  };
  consumers.scheduleVideoEstimate(node.id);
  const oldCallback = timers.get(nextTimer)!; timers.delete(nextTimer);
  const oldPending = oldCallback();
  runtime.selectedVideoCardId = 'card-b'; consumers.scheduleVideoEstimate(node.id);
  const newCallback = timers.get(nextTimer)!; timers.delete(nextTimer); await newCallback();
  resolveOld(quote); await oldPending;
  assert.equal(runtime.videoEstimates.get(node.id)?.pricingQuoteToken, 'new-card-token', 'A late quote cannot replace the current card quote');
  runtime.selectedVideoCardId = input.cardId;

  consumers.installGenerationAdapter();
  const payload: CanvasPayload = { kind: 'video', nodeId: node.id, requestId: input.requestId, mode: input.mode, prompt: input.prompt,
    settings: { ...settings, maxEstimatedCost: 1 } };
  const originalInput = workflow.videoRequest({ ...input, settings: { ...payload.settings, pricingRevision: 'old-revision', pricingQuoteToken: 'old-token' } }).payload;
  const submission: CanvasSubmission = { requestId: payload.requestId, state: 'unconfirmed', userId: 'actor-a', documentId: input.documentId,
    input: structuredClone(originalInput), generationPayload: structuredClone(payload) };
  node.data.videoSubmission = submission;
  ready = false;
  let unknownRequests = 0;
  request = async () => { unknownRequests++; throw Error('Unknown requests must never quote or create'); };
  await consumers.submitNodeGeneration({}, {}, structuredClone(payload));
  assert.equal(recoveries, 1); assert.equal(creates, 0);
  consumers.scheduleVideoEstimate(node.id); assert.equal(runtime.videoEstimates.has(node.id), false);
  delete node.data.videoSubmission; node.data.videoSubmissionLegacy = true;
  await consumers.submitNodeGeneration({}, {}, structuredClone(payload));
  assert.equal(recoveries, 1, 'Old records without a stable number remain blocked without inventing a new request');
  assert.equal(unknownRequests, 0);
  delete node.data.videoSubmissionLegacy; ready = true;

  node.data.videoSubmission = submission; runtime.unsentVideoRequests.set(node.id, submission);
  let createdInput: Record<string, unknown> | undefined;
  request = async (url, options) => {
    if (url === '/api/tasks/estimate') {
      events.push('quote'); assert.deepEqual(plain(options.payload), plain(workflow.videoPricingRequest(input, originalInput).payload));
      return quote;
    }
    assert.equal(url, '/api/tasks/create'); creates++; events.push('create'); createdInput = options.payload;
    assert.equal(runtime.unsentVideoRequests.has(node.id), false, 'Unsent proof ends before POST begins');
    assert.equal(options.headers?.['x-app-session-user'], 'actor-a');
    return { task_id: 'fixture-task', provider_task_id: 'fixture-provider-task', local_status: 'queued', frozen_cost: 0.5 };
  };
  flush = async () => { events.push('barrier'); assert.equal(node.data.videoSubmission?.input.pricing_quote_token, quote.pricing_quote_token); return true; };
  await consumers.submitNodeGeneration({}, {}, structuredClone(payload));
  assert.deepEqual(events, ['quote', 'barrier', 'create']); assert.equal(creates, 1); assert.equal(confirmations, 0);
  assert.equal(createdInput?.max_estimated_cost, 1); assert.equal(createdInput?.idempotency_key, originalInput.idempotency_key);
  assert.equal(createdInput?.pricing_quote_token, quote.pricing_quote_token); assert.equal(createdInput?.pricing_fingerprint_version, 2);
  assert.deepEqual(plain(videoPricingBusinessInput(createdInput!)), plain(videoPricingBusinessInput(originalInput)), 'Refreshing a proven unsent credential never edits authorized business input');
  assert.equal(originalInput.pricing_quote_token, 'old-token', 'Frozen source input is not mutated by fixture normalization');
  runtime.unsentVideoRequests.set(node.id, submission);
  request = async () => ({ ...quote, estimatedCost: 1.1 });
  await consumers.submitNodeGeneration({}, {}, structuredClone(payload));
  assert.equal(creates, 1); assert.equal(submission.input.max_estimated_cost, 1);
  assert.equal(runtime.unsentVideoRequests.get(node.id), submission); assert.ok(notices.some(message => message.includes('原授权上限')));
  delete node.data.videoSubmission; runtime.unsentVideoRequests.clear();
  request = async () => quote;
  confirm = async () => { confirmations++; runtime.bootstrap.user.id = 'actor-b'; return true; };
  await consumers.submitNodeGeneration({}, {}, { ...payload, requestId: 'new-request', settings: { ...settings } });
  assert.equal(confirmations, 1); assert.equal(creates, 1, 'A changed actor after confirmation cannot send the quote');
  runtime.bootstrap.user.id = 'actor-a';

  const image = { id: 'image-a', type: 'image' };
  assert.equal(consumers.imageChannelIssueForNode(image), '', 'A legal specification price does not require a uniform fixedPoints value');
  model.pricingBySpecification = false; assert.notEqual(consumers.imageChannelIssueForNode(image), ''); model.pricingBySpecification = true;
  model.ready = false; assert.notEqual(consumers.imageChannelIssueForNode(image), ''); model.ready = true;
  channel.configured = false; assert.notEqual(consumers.imageChannelIssueForNode(image), ''); channel.configured = true;
  imageSettings.resolution = '4K'; assert.notEqual(consumers.imageChannelIssueForNode(image), ''); imageSettings.resolution = '2K';
  assert.equal(consumers.canvasImageQuotePriceText({ billingMode: 'fixed', estimatedCredits: 0.6 }), '本次扣 0.6 点');
  assert.equal(consumers.canvasImageQuotePriceText({ billingMode: 'actual', estimatedCredits: 1.5 }), '最多预留 1.5 点，按账单结算');
  assert.equal(consumers.canvasImageQuotePriceText({ billingMode: 'fixed', estimatedCredits: 0.6, unitCredits: 0.2, count: 3 }), '本次扣 0.6 点');
  assert.equal(consumers.canvasImageQuotePriceText({ billingMode: 'actual', estimatedCredits: null }), '费用待估算');
  assert.equal(consumers.canvasImageQuotePriceText({ estimatedCredits: 0.6 }), '费用待估算');
}

export async function runPricingVideoScopeClientFixture() {
  const assert = fixtureChecks();
  const input: VideoPricingRequest = { provider: 'seedance', model: 'dreamina-seedance-2-5-260628',
    resolution: '720p', duration: 5, context: { project_id: 'fixture-project', video_card_id: 'fixture-card',
      ratio: '16:9', draft: false, reference_video_urls: [], template_studio_run_id: 'fixture-template',
      template_studio_assets: [{ assetId: 'fixture-asset', type: 'image', role: 'reference' }] } };
  const key = videoPricingRequestKey(input, 'fixture-actor');
  for (const [field, value] of Object.entries({ project_id: 'other-project', video_card_id: 'other-card', ratio: '9:16',
    draft: true, reference_video_urls: ['https://fixture.invalid/private-video'], template_studio_run_id: 'other-template',
    template_studio_assets: [{ assetId: 'other-asset', type: 'video', role: 'reference' }] })) {
    assert.notEqual(videoPricingRequestKey({ ...input, context: { ...input.context, [field]: value } }, 'fixture-actor'), key, field);
  }
  assert.notEqual(videoPricingRequestKey(input, 'other-actor'), key);
  for (const change of [{ model: 'other-model' }, { provider: 'h3' }, { resolution: '1080p' }, { duration: 6 }]) {
    assert.notEqual(videoPricingRequestKey({ ...input, ...change }, 'fixture-actor'), key);
  }

  const quote = { estimatedCost: 0.5, pricing_revision: 'fixture-revision', pricing_quote_token: 'fixture-opaque-only', policyApplied: true };
  const originalFetch = globalThis.fetch;
  const captured: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url, init) => {
    captured.push({ url: String(url), init });
    return Response.json(quote);
  }) as typeof fetch;
  try {
    assert.deepEqual(await requestVideoPricing(input, undefined, 'fixture-actor'), quote);
    assert.equal(captured[0].url, '/api/tasks/estimate');
    assert.equal(captured[0].init?.method, 'POST');
    const body = JSON.parse(String(captured[0].init?.body));
    assert.deepEqual(body, { ...input.context, provider: input.provider, model: input.model,
      resolution: input.resolution, duration: input.duration });
    assert.equal(new Headers(captured[0].init?.headers).get('x-app-session-user'), 'fixture-actor');
    await requestVideoPricing({ ...input, context: { retry_task_id: 'fixture-original-task' } });
    assert.equal(JSON.parse(String(captured[1].init?.body)).retry_task_id, 'fixture-original-task');
    await requestVideoPricing({ provider: 'volcengine_ip', model: 'doubao-seedance-2-5-260628', resolution: '720p', duration: 5 });
    assert.ok(captured[2].url.startsWith('/api/tasks/estimate?'));
    assert.equal(captured[2].init?.body, undefined);
    assert.equal(captured[2].url.includes('template_studio'), false);
    await requestVideoPricing({ provider: 'volcengine_mediakit', model: 'enhance-video', resolution: '2k', duration: 5, toolVersion: 'professional', fps: 60 });
    assert.equal(new URL(captured[3].url, 'https://fixture.invalid').searchParams.get('fps'), '60');
    globalThis.fetch = (async () => Response.json({ ...quote, pricing_quote_token: '' })) as typeof fetch;
    await assert.rejects(() => requestVideoPricing(input));
  } finally { globalThis.fetch = originalFetch; }

  assert.equal(requireVideoPricingWithinCeiling(quote, 0.5), quote);
  assert.equal(requireVideoPricingWithinCeiling(quote, 1), quote);
  assert.throws(() => requireVideoPricingWithinCeiling({ ...quote, estimatedCost: 0.6 }, 0.5));
  assert.throws(() => requireVideoPricingWithinCeiling(quote, undefined));
  const business = { project_id: 'fixture-project', video_card_id: 'fixture-card', draft: false,
    reference_video_urls: [], max_estimated_cost: 0.5, idempotency_key: 'fixture-original-key' };
  const first = { ...business, pricing_revision: 'revision-a', pricing_quote_token: 'credential-a', pricing_fingerprint_version: 2 };
  const expired = { ...business, pricing_revision: 'revision-b', pricing_quote_token: 'credential-b', pricing_fingerprint_version: 2 };
  assert.equal(stableGenerationPayloadJson(videoPricingBusinessInput(first)), stableGenerationPayloadJson(videoPricingBusinessInput(expired)));
  for (const change of [{ max_estimated_cost: 0.6 }, { video_card_id: 'other-card' }, { draft: true }, { reference_video_urls: ['https://fixture.invalid/video'] }]) {
    assert.notEqual(stableGenerationPayloadJson(videoPricingBusinessInput({ ...expired, ...change })), stableGenerationPayloadJson(business));
  }
  assert.equal(first.pricing_quote_token, 'credential-a', 'normalizing a new fingerprint never rewrites the original request');
  const draft = { ...defaultMultiviewGenerationDraft('multiview-fixture'), projectId: 'fixture-project',
    mainImage: { assetId: 'fixture-asset', referenceImageId: 'fixture-reference' } };
  const multiview = buildMultiviewGenerationRequest(draft, { idempotencyKey: 'fixture-key', maxEstimatedCost: 0.5,
    pricingRevision: 'fixture-revision', pricingQuoteToken: 'fixture-credential' });
  assert.equal(multiview.pricing_quote_token, 'fixture-credential');
  assert.equal(multiview.pricing_fingerprint_version, 2);
  assert.equal(multiview.max_estimated_cost, 0.5);
  assert.equal('pricing_quote_token' in videoPricingBusinessInput(multiview), false);
  await canvasConsumerAssertions(assert);
  return { fixture: 'pricing-video-scope-client', completed: true, assertions: assert.assertions, evidence: [
    'Complete account/input/template scope separates quote keys',
    'POST context, legacy IP/enhance GET and retry source are wired without network calls',
    'Final card repricing cannot raise the originally authorized ceiling',
    'Credential refresh is excluded from stable business input; authorization and real inputs remain bound',
    'Multiview carries credentials without adding them to its stable fingerprint',
    'Actual canvas workflow and app consumers share POST scope, credentials and actor-bound late-response guards',
    'Unknown and legacy canvas requests cannot reprice or resend; proven unsent refresh preserves original business input and ceiling',
    'Canvas specification pricing keeps real capability gates and distinguishes fixed charge from actual-fee reservation',
    'No real HTTP, provider, browser, database or acceptance; lead runner must await this fixture',
  ] };
}
