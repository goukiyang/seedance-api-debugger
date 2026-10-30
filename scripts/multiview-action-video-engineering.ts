import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { parseMultiviewActionBinding } from '../src/lib/video/multiview-action-contract';
import { parseMultiviewGenerationSnapshot } from '../src/lib/video/multiview-generation-contract';
import { multiviewActionPrivateTaskMarker, projectPrivateMultiviewTask, readMultiviewPrivateTaskMarker } from '../src/lib/video/multiview-task-privacy';
import { DEFAULT_SEEDANCE_VIDEO_MODEL_ID } from '../src/lib/provider/seedance-models';
import { createMultiviewReferenceRecipe } from '../src/lib/video/multiview-reference-layout';
import * as workContract from '../src/lib/video/multiview-work-contract';
import { siteUploadPathFromUrl } from '../src/lib/assets/site-url';

const require = createRequire(import.meta.url);
class AuthError extends Error { constructor(message: string, public status = 403) { super(message); } }
class StudioError extends Error { constructor(message: string, public status = 409) { super(message); } }
class PrivatePromptError extends Error {}
async function moduleUnderTest(file: string, imports: Record<string, unknown>, extras: Record<string, unknown> = {}) {
  const source = await readFile(file, 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} as any };
  const context = vm.createContext({ module, exports: module.exports, require: (name: string) => Object.hasOwn(imports, name) ? imports[name] : require(name),
    Buffer, URL, Response, Request, setTimeout, clearTimeout, console,
    process: { env: { NODE_ENV: 'test', SEEDANCE_API_KEY: 'isolated-fixture', SEEDANCE_BASE_URL: 'https://fixture.invalid/api' } },
    fetch: () => { throw new Error('External network is prohibited in this engineering fixture'); }, ...extras });
  new vm.Script(js, { filename: file }).runInContext(context);
  return module.exports;
}
async function main() {
  const binding = { runId: 'final-run', workId: 'reference-work', revision: 4, recipeHash: 'a'.repeat(64), inputHash: 'b'.repeat(64) };
  assert.ok(parseMultiviewActionBinding(binding));
  const marker = multiviewActionPrivateTaskMarker(binding);
  const metadata = JSON.stringify({ protected_module: marker });
  assert.equal(readMultiviewPrivateTaskMarker({ source_metadata_json: metadata })?.kind, 'multiview-action');
  assert.throws(() => readMultiviewPrivateTaskMarker({ source_metadata_json: JSON.stringify({ protected_module: { ...marker, actionBinding: { ...binding, revision: 0 } } }) }));
  const projected = projectPrivateMultiviewTask({ id: 'task-1', local_status: 'running', source_metadata_json: metadata,
    prompt: 'PRIVATE SYNC RULE', final_prompt_snapshot: 'PRIVATE SYNC RULE', params_json: 'PRIVATE SYNC RULE',
    template_studio_snapshot_json: 'PRIVATE SYNC RULE', raw_create_response: 'PRIVATE SYNC RULE', error_message: 'PRIVATE SYNC RULE',
    provider_task_id: 'upstream-1', provider_client_request_id: 'task-1', idempotency_key: 'multiview-action:final-run' });
  assert.equal(projected.prompt, '同步动作视频');
  assert.ok(!JSON.stringify(projected).includes('PRIVATE SYNC RULE'));
  assert.ok(!Object.hasOwn(projected, 'provider_task_id'));

  const parameters = { provider: 'seedance', model: DEFAULT_SEEDANCE_VIDEO_MODEL_ID, duration: 5, resolution: '720p', ratio: '16:9', project_id: 'project', video_card_id: null };
  const origins = [{ kind: 'multiview-action-sync', id: 'sync', ownerId: 'system:administrators' }];
  const action = { ...binding, actionText: '举手后收回', prompt: '举手后收回\nPRIVATE SYNC RULE', parameters, assetId: 'collage-asset', origins };
  let permitted = true, checks = 0;
  const helper = await moduleUnderTest('src/lib/video/multiview-action-video.server.ts', {
    'server-only': {}, '@/lib/prisma': { prisma: {} }, '@/lib/auth/session': { AuthError },
    './multiview-action-contract': { parseMultiviewActionBinding }, '@/lib/template-studio/errors': { StudioError },
    './multiview-action.server': { resolveMultiviewActionForGeneration: async (user: any, input: unknown) => {
      if (user.id !== 'owner' || !permitted) throw new StudioError('Source or actor changed', 403);
      assert.deepEqual(JSON.parse(JSON.stringify(input)), binding); return action;
    } },
    '@/lib/provider/jimeng': { assertPrivateSeedanceDestination: (model: string, actual: unknown) => { checks++; assert.equal(model, parameters.model); assert.deepEqual(actual, origins); } },
    '@/lib/template-studio-video-fingerprint': { generationRequestFingerprint: (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex') },
    '@/lib/security/private-prompt-fields.server': {},
  });
  const publicBody = { ...parameters, multiview_action: binding, prompt: action.actionText, generation_mode: 'first_last_frame',
    entry: 'multiview', request_id: 'multiview-action:final-run', idempotency_key: 'multiview-action:final-run',
    creation_contract_version: 2, intent_id: 'intent', baseline_task_id: 'approved-baseline' };
  const resolved = await helper.resolveMultiviewActionVideoInput({ id: 'owner' }, publicBody, {}, true);
  assert.equal(resolved.body.first_frame_asset_id, action.assetId);
  assert.equal(resolved.body.template_studio_run_id, binding.runId);
  assert.equal(resolved.body.prompt, action.actionText);
  assert.ok(!JSON.stringify(resolved.body).includes('PRIVATE SYNC RULE'), 'private rules entered public intent input');
  for (const mutation of [{ prompt: 'changed' }, { duration: 10 }, { provider: 'volcengine_ip' }, { first_frame_asset_id: 'other' },
    { last_frame_url: 'https://fixture.invalid/extra.png' }, { reference_image_ids: ['other'] }, { multiview_generation: {} },
    { idempotency_key: 'another-key' }, { draft: true }, { continuation: { mode: 'continue', parent_task_id: 'task' } }]) {
    await assert.rejects(helper.resolveMultiviewActionVideoInput({ id: 'owner' }, { ...publicBody, ...mutation }, {}, true));
  }
  await assert.rejects(helper.resolveMultiviewActionVideoInput({ id: 'another' }, publicBody, {}, true));
  permitted = false; await assert.rejects(helper.resolveMultiviewActionVideoInput({ id: 'owner' }, publicBody, {}, true)); permitted = true;
  assert.ok(checks > 0);
  const availability = await moduleUnderTest('src/lib/creation/availability.ts', {
    '@/lib/video/multiview-generation-contract': { parseMultiviewGenerationSnapshot },
    '@/lib/video/multiview-action-contract': { parseMultiviewActionBinding },
    '@/lib/credits/policy': {}, '@/lib/projects/budget': {}, '@/lib/credits/precision': {},
    '@/lib/provider/seedance-models': require('../src/lib/provider/seedance-models'),
    './lineage': {}, './contract': {},
  });
  const payer = { kind: 'personal', id: 'owner' };
  const available = (input: any, entry = 'multiview') => availability.readCreationAvailability({}, {
    state: 'ready', payer_kind: payer.kind, payer_account_id: payer.id,
    spec_json: JSON.stringify({ action: 'generate', entry, input }),
  }, 'personal', payer);
  // The production action intent has no rotation snapshot by design.
  assert.equal((await available(resolved.body)).canSubmit, true, 'valid action intent was rejected as missing rotation input');
  for (const multiview_action of [null, {}, { ...binding, revision: 0 }]) {
    assert.equal((await available({ ...resolved.body, multiview_action })).canSubmit, false);
  }
  assert.equal((await available({ ...resolved.body, multiview_generation: {} })).canSubmit, false, 'mixed action/rotation input passed');
  const rotation = { ...resolved.body }; delete rotation.multiview_action;
  assert.equal((await available(rotation)).canSubmit, false, 'missing rotation snapshot passed');
  rotation.multiview_generation = { schema: 2, presetId: 'multiview-360', presetVersion: '1.0.0',
    supplement: '', workspaceTabId: 'multiview-fixture', mainAssetId: 'main-asset', mainReferenceImageId: 'main-reference' };
  assert.equal((await available(rotation)).canSubmit, true, 'valid rotation input was rejected');
  assert.equal((await available({ prompt: 'ordinary video' }, 'ordinary')).canSubmit, true);

  const info = { taskId: 'source-task', sourceVersion: 'a'.repeat(64), width: 1536, height: 1536, duration: 4,
    timestamps: Array.from({ length: 100 }, (_, index) => index / 25) };
  const recipe = createMultiviewReferenceRecipe(info, Array.from({ length: 4 }, (_, index) => ({
    id: `shot-${index}`, frame: index * 20, name: '', manual: false,
  })), { width: 1536, height: 1536, background: '#d6dbdf' });
  const recipeJson = JSON.stringify(recipe), recipeHash = createHash('sha256').update(recipeJson).digest('hex');
  const outputHash = 'c'.repeat(64), revision = 20, originalUrl = '/uploads/multiview-outputs/fixture/collage.png';
  const work = { id: 'reference-work', owner_id: 'owner', schema_version: 3, removed_at: null, status: 'ready',
    draft_revision: revision, ready_revision: revision, source_task_id: info.taskId, source_version: info.sourceVersion,
    source_info_json: JSON.stringify(info), recipe_json: recipeJson, ready_recipe_json: recipeJson,
    ready_manifest_json: JSON.stringify({ schema: 1, sourceVersion: info.sourceVersion, revision, recipeHash,
      width: 1536, height: 1536, frameCount: 4,
      files: ['thumbnail', 'collage', 'zip', ...recipe.slots.map(slot => `frame-${slot.id}`)].map(role => ({
        role, file: `${role}.${role === 'zip' ? 'zip' : 'png'}`, mime: role === 'zip' ? 'application/zip' : 'image/png',
        bytes: 64, sha256: outputHash, width: 1536, height: 1536,
      })) }),
  };
  let sourcePermitted = true;
  const asset = { id: 'collage-asset', owner_id: 'owner', hash: outputHash, status: 'active', type: 'image',
    original_url: originalUrl, width: 1536, height: 1536 };
  const bindingDb = { multiviewWork: { findFirst: async ({ where }: any) => where.owner_id === work.owner_id ? work : null },
    asset: { findFirst: async ({ where }: any) => Object.entries(where).every(([key, value]) => asset[key as keyof typeof asset] === value) ? asset : null },
    platformSetting: { findUnique: async () => ({ value_json: JSON.stringify({ ownerId: 'owner', readyRevision: revision,
      outputs: [{ role: 'collage', state: 'registered', assetId: asset.id, sha256: outputHash, originalUrl }] }) }) } };
  class MultiviewWorkError extends Error { constructor(message: string, public status: number, public code: string) { super(message); } }
  const outputAssets = await moduleUnderTest('src/lib/video/multiview-output-assets.server.ts', {
    '@/lib/prisma': { prisma: bindingDb }, '@/lib/assets/site-url': { siteUploadPathFromUrl }, '@/lib/image-studio/protected-assets': {},
    '@/lib/media/hd-registration': { registerCommittedAssetHd: async () => { throw new Error('Read-only binding checks must not register HD'); } },
    './multiview-work-contract': workContract,
    './multiview-works': { currentMultiviewActor: async () => {}, MultiviewWorkError,
      assertMultiviewWorkReference: async () => { if (!sourcePermitted) throw new AuthError('Source access denied', 403); } },
  });
  const readBinding = (owner = 'owner') => outputAssets.readMultiviewReferenceBinding({ id: owner }, work.id, revision, bindingDb);
  const beforePublicUrl = await readBinding();
  asset.original_url = `https://sd2.youdooart.com${originalUrl}`;
  const afterPublicUrl = await readBinding();
  assert.deepEqual(afterPublicUrl, beforePublicUrl, 'same collage became unavailable after the shared asset URL was made public');
  for (const url of [`https://foreign.invalid${originalUrl}`, '/uploads/another.png', 'https://sd2.youdooart.com/uploads/another.png']) {
    asset.original_url = url;
    await assert.rejects(readBinding(), (error: any) => error.code === 'REFERENCE_ASSET_UNAVAILABLE');
  }
  asset.original_url = `https://sd2.youdooart.com${originalUrl}`;
  for (const patch of [{ status: 'hidden' }, { owner_id: 'another' }, { hash: 'd'.repeat(64) }, { width: 1024 }]) {
    const original = { ...asset }; Object.assign(asset, patch);
    await assert.rejects(readBinding()); Object.assign(asset, original);
  }
  await assert.rejects(readBinding('another'));
  sourcePermitted = false; await assert.rejects(readBinding(), /Source access denied/); sourcePermitted = true;
  work.draft_revision++; await assert.rejects(readBinding()); work.draft_revision--;

  const panelSource = await readFile('src/app/multiview/MultiviewActionPanel.tsx', 'utf8');
  const panelAst = ts.createSourceFile('panel.tsx', panelSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let submitNode: ts.FunctionDeclaration | undefined;
  const locateSubmit = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === 'submit') submitNode = node; ts.forEachChild(node, locateSubmit); };
  locateSubmit(panelAst); assert.ok(submitNode);
  const submitJs = ts.transpileModule(`${submitNode.getText(panelAst)}; module.exports = submit;`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const phase of ['prepare', 'create', 'closed']) {
    const ui = { confirming: true, message: '', original: null as any, submitting: true, newAttemptRequired: false, stored: new Map(), createCalls: 0 };
    const evaluated = { exports: undefined as any };
    const submitContext = vm.createContext({ module: evaluated, Error, scope: 'owner-scope', active: () => true,
      submitLock: { current: false }, saveLock: { current: false }, currentQuote: { text: 'action', parameters, points: 28.9, pricingRevision: 'fixture', token: 'fixture' },
      draftRef: { current: null }, attemptId: 'initial', appliedRunId: undefined, baseline: null, requestKey: 'original-key', attemptKey: 'attempt-key',
      props: { onPrepare: async () => { if (phase === 'prepare') throw new Error('参考拼图素材已不可用，原作品仍保留。'); return { id: work.id }; } },
      creation: { intent: null, prepare: async () => ({ request_id: 'multiview-action:final-run', id: 'intent', revision: 1, state: phase === 'closed' ? 'closed' : 'ready',
        availability: { canSubmit: true }, quote: { estimated_cost: 28.9, pricing_revision: 'fixture' } }) },
      isResolvedCreationIntent: (intent: any) => intent?.state === 'closed', localStorage: { setItem: (key: string, value: string) => ui.stored.set(key, value) },
      api: async (url: string) => { if (url.endsWith('/drafts')) return { draft: { id: 'draft', revision: 1 } };
        if (url.endsWith('/final')) return { binding, run: { text: 'action' } };
        assert.equal(url, '/api/tasks/create'); ui.createCalls++; throw new Error('network result unknown'); },
      setDraft: () => {}, setMessage: (message: string) => { ui.message = message; },
      setConfirming: (value: boolean) => { ui.confirming = value; }, setSubmitting: (value: boolean) => { ui.submitting = value; },
      setNewAttemptRequired: (value: boolean) => { ui.newAttemptRequired = value; },
      setOriginal: (value: any) => { ui.original = value; }, setSelectedRunId: () => {},
    });
    new vm.Script(submitJs).runInContext(submitContext); await evaluated.exports();
    assert.equal(ui.confirming, false, `${phase} failure left the cost modal hiding the inline error`);
    assert.equal(ui.submitting, false);
    if (phase === 'prepare') { assert.match(ui.message, /参考拼图素材已不可用/); assert.equal(ui.stored.size, 0); assert.equal(ui.createCalls, 0); }
    else if (phase === 'create') { assert.match(ui.message, /提交结果待确认/); assert.equal(ui.original.key, 'multiview-action:final-run'); assert.equal(ui.stored.size, 1); assert.equal(ui.createCalls, 1); assert.equal(ui.newAttemptRequired, false); }
    else { assert.equal(ui.newAttemptRequired, true); assert.equal(ui.createCalls, 0); assert.equal(ui.original, null); assert.ok(ui.stored.has('attempt-key')); assert.ok(!ui.stored.has('original-key')); }
  }
  const fingerprint = helper.multiviewActionVideoFingerprint(publicBody);
  assert.equal(fingerprint, helper.multiviewActionVideoFingerprint({ ...publicBody, seed: -1, generate_audio: true, return_last_frame: false, watermark: false }));
  for (const mutation of [{ prompt: 'changed' }, { baseline_task_id: 'another-baseline' }, { multiview_action: { ...binding, revision: 5 } }, { model: 'another-model' }]) {
    assert.notEqual(fingerprint, helper.multiviewActionVideoFingerprint({ ...publicBody, ...mutation }));
  }

  const rows = new Map<string, any>(), tasks = new Map<string, any>();
  let sequence = Promise.resolve(), logWrites = 0;
  const db: any = { platformSetting: {
    findUnique: async ({ where }: any) => rows.has(where.key) ? { value_json: rows.get(where.key) } : null,
    create: async ({ data }: any) => { assert.ok(!rows.has(data.key)); rows.set(data.key, data.value_json); return data; },
    updateMany: async ({ where, data }: any) => { if (rows.get(where.key) !== where.value_json) return { count: 0 }; rows.set(where.key, data.value_json); return { count: 1 }; },
  }, videoTask: { findUnique: async ({ where }: any) => tasks.get(where.user_id_idempotency_key.idempotency_key) || null },
  providerApiRequest: { findFirst: async () => null }, creditLedger: { findFirst: async () => null },
  projectBudgetLedger: { findFirst: async () => null }, costLedger: { findFirst: async () => null },
  operationLog: { findFirst: async () => null, create: async () => { logWrites++; } }, user: { findUnique: async () => ({ status: 'active' }) },
  $transaction: (fn: any) => { const result = sequence.then(() => fn(db)); sequence = result.then(() => undefined, () => undefined); return result; } };
  const receipts = await moduleUnderTest('src/lib/video/multiview-request-receipt.ts', {
    '@/lib/prisma': { prisma: db }, '@/lib/auth/session': { AuthError }, './multiview-generation-contract': { parseMultiviewGenerationSnapshot: () => null },
  });
  const requests = await Promise.all([receipts.claimMultiviewRequest('owner', publicBody.idempotency_key, publicBody), receipts.claimMultiviewRequest('owner', publicBody.idempotency_key, publicBody)]);
  assert.equal(requests.filter(item => item.kind === 'claimed').length, 1, 'concurrent pages obtained two admission claims');
  const claim = requests.find(item => item.kind === 'claimed').claim;
  const rejected = await receipts.rejectMultiviewRequest(claim, 409, { error: 'Source changed' });
  assert.equal(rejected.accepted, false); assert.equal(rejected.key, publicBody.idempotency_key);
  await assert.rejects(receipts.assertMultiviewRequestFence(db, 'owner', publicBody.idempotency_key, claim), 'late writer passed sealed original request');
  assert.equal((await receipts.readMultiviewRequestReceipt('owner', publicBody.idempotency_key)).receipt.state, 'rejected');
  const next = await receipts.claimMultiviewRequest('owner', 'multiview-action:next-run', { binding: 'next' });
  tasks.set('multiview-action:next-run', { id: 'accepted-task' });
  await receipts.acceptMultiviewRequest(db, next.claim, 'accepted-task');
  assert.equal(await receipts.rejectMultiviewRequest(next.claim, 400, {}), null, 'accepted task was turned into free retry proof');
  assert.equal((await receipts.readMultiviewRequestReceipt('owner', 'multiview-action:next-run')).state, 'accepted');
  assert.equal(logWrites, 1);

  const captured: unknown[] = [], logs: string[] = [];
  let transmittedBody = '';
  const fakeConsole = Object.fromEntries(['log', 'error', 'warn'].map(key => [key, (...items: unknown[]) => logs.push(items.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' '))]));
  const provider = await moduleUnderTest('src/lib/provider/jimeng.ts', {
    '@/lib/security/private-prompt-send.server': { assertPrivateSend: () => {}, privatePromptFetch: async (_identity: unknown, actual: unknown, init: RequestInit) => {
      captured.push(actual); transmittedBody = String(init.body); assert.ok(transmittedBody.includes('PRIVATE SYNC RULE'));
      return new Response(JSON.stringify({ id: 'provider-task', prompt: 'PRIVATE SYNC RULE', status: 'queued' }), { status: 200 });
    } },
    '@/lib/security/private-prompts.server': { PrivatePromptError }, '@/lib/video/private-storage.server': { privateMultiviewOrigins: () => [{ kind: 'old-rotation' }] },
    './error-message': require('../src/lib/provider/error-message'), './seedance-models': require('../src/lib/provider/seedance-models'),
    './seedance-draft': require('../src/lib/provider/seedance-draft'), './seedance-video-edit': require('../src/lib/provider/seedance-video-edit'),
    './create-diagnostic': require('../src/lib/provider/create-diagnostic'), '../video/multiview-task-privacy': require('../src/lib/video/multiview-task-privacy'),
  }, { console: fakeConsole });
  const result = await provider.createVideoTask({ prompt: action.prompt, model: parameters.model, generation_mode: 'first_last_frame', first_frame_url: 'https://fixture.invalid/collage.png', duration: 5, ratio: '16:9', resolution: '720p' }, undefined,
    { sensitiveRecipe: true, privateOrigins: origins });
  assert.deepEqual(captured[0], origins, 'action send substituted old rotation origins');
  assert.ok(!JSON.stringify(result).includes('PRIVATE SYNC RULE'), 'provider echo escaped safe response');
  assert.ok(!logs.join('\n').includes('PRIVATE SYNC RULE'), 'private rules escaped provider logs');
  const transport = await moduleUnderTest('src/lib/provider/reference-image-transport.ts', {
    '@/lib/assets/site-url': { siteUploadPathFromUrl }, './jimeng': provider,
  });
  const routeText = await readFile('src/app/api/tasks/create/route.ts', 'utf8');
  const routeAst = ts.createSourceFile('route.ts', routeText, ts.ScriptTarget.Latest, true);
  const transportBranches: ts.IfStatement[] = [];
  const locateTransport = (node: ts.Node) => { if (ts.isIfStatement(node) && node.expression.getText(routeAst).startsWith("requestedProvider === 'seedance'")
    && node.thenStatement.getText(routeAst).includes('await seedanceLocalReferenceTransport(')) transportBranches.push(node); ts.forEachChild(node, locateTransport); };
  locateTransport(routeAst); assert.equal(transportBranches.length, 1);
  const inlineBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
  const imageUrl = `https://sd2.youdooart.com${originalUrl}`;
  const transportInput = { prompt: action.prompt, model: parameters.model, generation_mode: 'first_last_frame', first_frame_url: imageUrl, duration: 5, ratio: '16:9', resolution: '720p' };
  const transportAsset = { original_url: imageUrl, type: 'image', status: 'active', mime_type: 'image/png', file_size: inlineBytes.length };
  const transportContext = vm.createContext({ requestedProvider: 'seedance', multiviewGeneration: null, multiviewAction: action,
    actionImageForTransport: { url: imageUrl, asset: transportAsset }, body: {}, cleanSourceMetadata: () => ({}), requestSource: {},
    providerInput: transportInput, generationReferenceImages: [], multiviewSystemReference: null, requestCallbackUrl: undefined,
    seedanceLocalReferenceTransport: (input: unknown, images: unknown, _read: unknown, privateImages: unknown) =>
      transport.seedanceLocalReferenceTransport(input, images, async () => inlineBytes, privateImages),
    errorJson: (error: string, status: number) => ({ error, status }),
  });
  const transportJs = ts.transpileModule(`async function prepare() { let seedanceReferenceTransport = {}; ${transportBranches[0].getText(routeAst)} return seedanceReferenceTransport; }`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  new vm.Script(transportJs).runInContext(transportContext);
  const inline = await (transportContext as any).prepare();
  assert.match(inline.first_frame_base64_data || '', /^data:image\/png;base64,/, 'action route skipped the shared private collage byte transport');
  await provider.createVideoTask({ ...transportInput, ...inline }, undefined, { sensitiveRecipe: true, privateOrigins: origins });
  assert.ok(!transmittedBody.includes(imageUrl), 'provider was told to anonymously fetch a protected collage URL');
  assert.ok(transmittedBody.includes(inline.first_frame_base64_data));
  assert.deepEqual(captured[1], origins, 'inline action send lost its action-specific private origins');
  assert.equal(transportInput.first_frame_url, imageUrl, 'transient image bytes changed durable input identity');
  console.log('action video safety: availability, same-site collage identity/source denial, failure modal/unknown retention, closed explicit recovery, durable original receipts, shared inline action image transport and private send projection passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
