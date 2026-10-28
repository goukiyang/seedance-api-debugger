import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { parseMultiviewActionBinding } from '../src/lib/video/multiview-action-contract';
import { multiviewActionPrivateTaskMarker, projectPrivateMultiviewTask, readMultiviewPrivateTaskMarker } from '../src/lib/video/multiview-task-privacy';
import { DEFAULT_SEEDANCE_VIDEO_MODEL_ID } from '../src/lib/provider/seedance-models';

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
  const fakeConsole = Object.fromEntries(['log', 'error', 'warn'].map(key => [key, (...items: unknown[]) => logs.push(items.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' '))]));
  const provider = await moduleUnderTest('src/lib/provider/jimeng.ts', {
    '@/lib/security/private-prompt-send.server': { assertPrivateSend: () => {}, privatePromptFetch: async (_identity: unknown, actual: unknown, init: RequestInit) => {
      captured.push(actual); assert.ok(String(init.body).includes('PRIVATE SYNC RULE'));
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
  console.log('action video safety: frozen public input, baseline binding, actor/source denial, one durable claim, terminal rejection/late-writer fence, original acceptance, private Seedance send and echo/log projection passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
