import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/** Isolated engineering fixture. No caller-supplied DB, media, upstream or production API. */
async function main() {
  const root = realpathSync(process.cwd()), scratch = path.join(root, '.role-tests');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(path.join(scratch, 'multiview-settings-'));
  assert.ok(realpathSync(directory).startsWith(realpathSync(scratch) + path.sep));
  assert.equal(Reflect.get(globalThis, 'prisma'), undefined);
  process.env.DATABASE_URL = `file:${path.join(directory, 'synthetic.db')}`;
  process.env.SESSION_SECRET = randomBytes(32).toString('hex');
  Reflect.set(globalThis, 'AsyncLocalStorage', AsyncLocalStorage);
  globalThis.fetch = async () => { throw new Error('External requests prohibited in isolated multiview settings fixture'); };
  const childEnv: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) if (process.env[key]) childEnv[key] = process.env[key]!;
  Object.assign(childEnv, { DATABASE_URL: process.env.DATABASE_URL, PRISMA_GENERATE_SKIP_AUTOINSTALL: '1', NEXT_TELEMETRY_DISABLED: '1' });
  const schemaLog = execFileSync(process.execPath, [path.join(root, 'node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate',
    '--schema', path.join(root, 'prisma/schema.prisma')], { cwd: directory, env: childEnv, encoding: 'utf8', timeout: 120000 });
  writeFileSync(path.join(directory, 'schema.log'), schemaLog, { mode: 0o600 });
  const require = createRequire(import.meta.url);
  const { requestAsyncStorage } = require('next/dist/client/components/request-async-storage.external') as typeof import('next/dist/client/components/request-async-storage.external');
  const { RequestCookies } = require('next/dist/compiled/@edge-runtime/cookies') as typeof import('next/dist/compiled/@edge-runtime/cookies');
  // One module graph keeps real error class identity under Node20/tsx. Mixing
  // dynamic ESM imports with alias-loaded CJS creates duplicate constructors.
  const { NextRequest } = require('next/server') as typeof import('next/server');
  const { prisma } = require('../src/lib/prisma') as typeof import('../src/lib/prisma');
  const { createSession, getSession } = require('../src/lib/auth/session') as typeof import('../src/lib/auth/session');
  const contract = require('../src/lib/video/multiview-settings-contract') as typeof import('../src/lib/video/multiview-settings-contract');
  const generation = require('../src/lib/video/multiview-generation-contract') as typeof import('../src/lib/video/multiview-generation-contract');
  const service = require('../src/lib/video/multiview-settings.server') as typeof import('../src/lib/video/multiview-settings.server');
  const presets = require('../src/lib/video/multiview-preset.server') as typeof import('../src/lib/video/multiview-preset.server');
  const pricing = require('../src/lib/pricing/video-context') as typeof import('../src/lib/pricing/video-context');
  const collection = require('../src/app/api/multiview/settings/route') as typeof import('../src/app/api/multiview/settings/route');
  const item = require('../src/app/api/multiview/settings/[id]/route') as typeof import('../src/app/api/multiview/settings/[id]/route');
  const apply = require('../src/app/api/multiview/settings/[id]/apply/route') as typeof import('../src/app/api/multiview/settings/[id]/apply/route');
  const mutation = require('../src/app/api/multiview/settings/mutations/[mutationId]/route') as typeof import('../src/app/api/multiview/settings/mutations/[mutationId]/route');
  const estimateRoute = require('../src/app/api/tasks/estimate/route') as typeof import('../src/app/api/tasks/estimate/route');
  const createRoute = require('../src/app/api/tasks/create/route') as typeof import('../src/app/api/tasks/create/route');
  const checks: string[] = [];
  const evidencePath = path.join(directory, 'receipt.json');
  let completed = false;
  try {
    assert.equal(await prisma.user.count(), 0);
    const tokens: Record<string, string> = {};
    for (const [id, role, account_type, feature_profile_id] of [
      ['settings-owner', 'user', 'internal', 'internal_email_authorized'], ['settings-peer', 'user', 'internal', 'internal_email_authorized'],
      ['settings-admin', 'admin', 'internal', null], ['settings-external', 'user', 'external', null],
    ] as const) {
      await prisma.user.create({ data: { id, name: `Synthetic ${id}`, username: id, email: `${id}@isolated.invalid`,
        password_hash: 'synthetic-not-a-login-password', role, account_type, feature_profile_id } });
      tokens[id] = await createSession(id);
    }
    const withActor = async <T>(actor: string, callback: (user: NonNullable<Awaited<ReturnType<typeof getSession>>>) => Promise<T>) => {
      const headers = new Headers({ Cookie: `session=${tokens[actor]}` });
      const store = { headers, cookies: new RequestCookies(headers) } as unknown as Parameters<typeof requestAsyncStorage.run>[0];
      return requestAsyncStorage.run(store, async () => { const user = await getSession(); assert.ok(user); return callback(user); });
    };
    const invoke = async (actor: string | null, method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown, sameOrigin = true) => {
      const headers = new Headers({ ...(actor ? { Cookie: `session=${tokens[actor]}`, 'x-app-session-user': actor } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: sameOrigin ? 'http://mv-settings-isolated.invalid' : 'http://other.invalid' }),
        Host: 'mv-settings-isolated.invalid' });
      const request = new NextRequest(`http://mv-settings-isolated.invalid/api/multiview/settings${url}`, {
        method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const store = { headers, cookies: new RequestCookies(headers) } as unknown as Parameters<typeof requestAsyncStorage.run>[0];
      const response = await requestAsyncStorage.run(store, () => {
        const pathOnly = url.split('?')[0];
        if (pathOnly.startsWith('/mutations/')) return mutation.GET(request, { params: { mutationId: pathOnly.slice('/mutations/'.length) } });
        if (pathOnly.endsWith('/apply')) return apply.POST(request, { params: { id: pathOnly.split('/')[1] } });
        if (pathOnly.length > 1) return method === 'GET' ? item.GET(request, { params: { id: pathOnly.slice(1) } }) : item.PATCH(request, { params: { id: pathOnly.slice(1) } });
        return method === 'GET' ? collection.GET(request) : collection.POST(request);
      });
      assert.match(response.headers.get('cache-control') || '', /private.*no-store/);
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await invoke(null, 'GET', '?kind=generation')).status, 401);
    assert.equal((await invoke('settings-external', 'GET', '?kind=generation')).status, 403);
    assert.equal((await invoke('settings-owner', 'POST', '', {}, false)).status, 403);
    assert.equal(await prisma.platformSetting.count(), 0);
    checks.push('real_session_company_boundary_and_origin_rejection_no_writes');

    const value = { schema: 1 as const, presetId: 'multiview-360' as const, presetVersion: generation.MULTIVIEW_ROTATION_PRESET.version,
      ...generation.MULTIVIEW_ROTATION_PRESET.defaults, supplement: '合成可复用补充要求' };
    const request = { mutationId: randomUUID(), kind: 'generation', name: '合成共享设置', value };
    const first = await invoke('settings-owner', 'POST', '', request);
    assert.equal(first.status, 200);
    assert.equal(first.body.state, 'committed');
    const saved = contract.parseMultiviewSettingsDto(first.body.settings); assert.ok(saved);
    assert.equal(saved.isShared, true); assert.equal(saved.revision, 1);
    const binding = { id: saved.id, revision: saved.revision };
    assert.equal((await invoke('settings-peer', 'GET', '?kind=generation')).body.items.length, 1);
    const applied = await invoke('settings-peer', 'POST', `/${saved.id}/apply`, { expectedRevision: 1 });
    assert.equal(applied.status, 200); assert.equal(applied.body.preset.prompt, generation.MULTIVIEW_ROTATION_PRESET.prompt);
    assert.equal((await invoke('settings-peer', 'PATCH', `/${saved.id}`, { mutationId: randomUUID(), expectedRevision: 1, name: 'forbidden', value })).status, 403);
    const recovered = await invoke('settings-owner', 'GET', `/mutations/${request.mutationId}`);
    assert.deepEqual(recovered.body, first.body);
    assert.deepEqual((await invoke('settings-owner', 'POST', '', request)).body, first.body);
    assert.equal(await prisma.platformSetting.count(), 1);
    const reused = await invoke('settings-owner', 'POST', '', { ...request, name: 'changed-input' });
    assert.equal(reused.status, 409); assert.notEqual(reused.body.notCommitted, true);
    checks.push('shared_default_fresh_apply_owner_only_cas_durable_original_receipt_and_replay');

    for (const forbidden of ['mainImage', 'projectId', 'videoCardId', 'prompt', 'workspaceTabId', 'resolutionApprovalId']) {
      assert.equal(contract.parseMultiviewGenerationSettingsValue({ ...value, [forbidden]: 'forbidden' }), null);
    }
    assert.equal(generation.parseMultiviewGenerationDraft({ ...generation.defaultMultiviewGenerationDraft(), settingsBinding: { ...binding, revision: 0 } }), null);
    const draft = { ...generation.defaultMultiviewGenerationDraft('mv04-isolated-settings'), ...value, settingsBinding: binding,
      projectId: 'isolated-settings-project', mainImage: { assetId: 'isolated-image', referenceImageId: 'isolated-reference' } };
    const body = generation.buildMultiviewGenerationRequest(draft, { idempotencyKey: randomUUID(), maxEstimatedCost: 0 });
    assert.deepEqual(body.multiview_generation.settingsBinding, binding);
    const frozen = JSON.stringify(body);
    await presets.saveMultiviewRotationPreset({ mutationId: randomUUID(), expectedRevision: 0, prompt: '合成新的全局旋转基准 @图片1' }, 'settings-admin');
    await withActor('settings-peer', async user => {
      assert.equal((await service.resolveMultiviewGenerationSettings(user, value.presetVersion, binding)).preset.prompt, generation.MULTIVIEW_ROTATION_PRESET.prompt);
      await assert.rejects(service.resolveMultiviewGenerationSettings(user, value.presetVersion));
    });
    const historicalGuess = await invoke('settings-peer', 'POST', '', { ...request, mutationId: randomUUID(), name: 'unauthorized-old-version' });
    assert.equal(historicalGuess.status, 409);
    const copy = await invoke('settings-peer', 'POST', '', { ...request, mutationId: randomUUID(), name: '合法另存', sourceSettingsBinding: binding });
    assert.equal(copy.status, 200); assert.notEqual(copy.body.settings.id, saved.id);
    assert.equal(JSON.stringify(body), frozen);
    checks.push('server_immutable_prompt_snapshot_old_version_requires_visible_source_and_frozen_input_preserved');

    await prisma.project.create({ data: { id: 'isolated-settings-project', name: 'Synthetic private project', type: 'personal', owner_user_id: 'settings-owner', created_by: 'settings-owner' } });
    await withActor('settings-owner', async user => {
      const base = { project_id: 'isolated-settings-project', video_card_id: null, provider: 'seedance', model: value.model,
        ratio: value.ratio, duration: value.duration, resolution: value.resolution, draft: false, reference_video_urls: [] };
      const quoted = await pricing.resolveVideoPricingContext(user, { ...base, multiview_settings: binding });
      const created = await pricing.resolveVideoPricingContext(user, { ...base, multiview_generation: body.multiview_generation });
      assert.equal(quoted.fingerprint, created.fingerprint);
      const token = pricing.issueVideoPricingCredential(quoted, null, 0);
      pricing.verifyVideoPricingCredential(token, created, null, 0);
      const changedBinding = await pricing.resolveVideoPricingContext(user, { ...base, multiview_settings: { ...binding, revision: 2 } });
      assert.throws(() => pricing.verifyVideoPricingCredential(token, changedBinding, null, 0));
    });
    checks.push('same_saved_binding_quote_and_create_scope_and_changed_binding_token_rejected');

    // Seed an already accepted synthetic request while sharing is still active.
    await prisma.project.create({ data: { id: 'isolated-peer-project', name: 'Synthetic peer private project', type: 'personal', owner_user_id: 'settings-peer', created_by: 'settings-peer' } });
    const acceptedBody = { ...body, project_id: 'isolated-peer-project', pricing_fingerprint_version: 2 };
    const acceptedId = 'isolated-settings-accepted-task';
    await prisma.videoTask.create({ data: { id: acceptedId, user_id: 'settings-peer', owner_user_id: 'settings-peer', project_id: 'isolated-peer-project',
      provider: 'seedance', model: value.model, generation_mode: 'all_in_one_reference', prompt: body.prompt, local_status: 'queued',
      idempotency_key: body.idempotency_key, request_fingerprint: pricing.videoPricingBusinessFingerprint(acceptedBody) } });

    const update = { mutationId: randomUUID(), expectedRevision: 1, name: saved.name, isShared: false, value, sourceSettingsBinding: binding };
    const withdrawn = await invoke('settings-owner', 'PATCH', `/${saved.id}`, update);
    assert.equal(withdrawn.status, 200); assert.equal(withdrawn.body.settings.revision, 2);
    assert.equal((await invoke('settings-peer', 'GET', `/${saved.id}`)).status, 403);
    assert.equal((await invoke('settings-peer', 'POST', `/${saved.id}/apply`, { expectedRevision: 1 })).status, 403);
    await withActor('settings-peer', async user => {
      await assert.rejects(service.resolveMultiviewGenerationSettings(user, value.presetVersion, binding));
      await assert.rejects(service.assertMultiviewGenerationSettings(user, body.multiview_generation));
      const quoted = await estimateRoute.POST(new NextRequest('http://mv-settings-isolated.invalid/api/tasks/estimate', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-app-session-user': user.id },
        body: JSON.stringify({ provider: 'seedance', model: value.model, resolution: value.resolution, duration: value.duration,
          multiview_preset_version: value.presetVersion, multiview_settings: binding }),
      }));
      assert.equal(quoted.status, 403);
    });
    const stale = await invoke('settings-owner', 'PATCH', `/${saved.id}`, { ...update, mutationId: randomUUID(), sourceSettingsBinding: { id: saved.id, revision: 2 } });
    assert.equal(stale.status, 409);
    assert.deepEqual((await invoke('settings-owner', 'GET', `/mutations/${request.mutationId}`)).body, first.body);
    assert.equal((await invoke('settings-peer', 'GET', `/mutations/${request.mutationId}`)).body.state, 'not_found');
    checks.push('withdrawal_and_stale_revision_block_new_uses_while_actor_original_receipt_remains_readable');

    const concurrent = await Promise.all(['a', 'b'].map(suffix => invoke('settings-owner', 'PATCH', `/${saved.id}`, {
      ...update, mutationId: randomUUID(), expectedRevision: 2, name: `concurrent-${suffix}`, sourceSettingsBinding: { id: saved.id, revision: 2 },
    })));
    assert.equal(concurrent.filter(result => result.status === 200).length, 1);
    assert.ok(concurrent.every(result => [200, 409, 503].includes(result.status)));
    assert.equal((await invoke('settings-owner', 'GET', `/${saved.id}`)).body.settings.revision, 3);
    checks.push('concurrent_expected_revision_single_winner_without_overwrite_other_result_conflict_or_unknown');

    await withActor('settings-peer', async user => {
      const response = await createRoute.POST(new NextRequest('http://mv-settings-isolated.invalid/api/tasks/create', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-app-session-user': user.id, 'x-tab-id': draft.workspaceTabId }, body: JSON.stringify(acceptedBody) }));
      const result = await response.json();
      assert.equal(response.status, 200); assert.equal(result.id, acceptedId); assert.equal(result.deduplicated, true);
    });
    assert.equal(await prisma.videoTask.count(), 1);
    assert.equal(await prisma.providerApiRequest.count(), 0);
    checks.push('real_create_api_returns_original_accepted_key_after_source_sharing_withdrawal_without_upstream_or_second_task');

    const source = { duration: 4, timestamps: Array.from({ length: 97 }, (_, index) => Math.round(index / 24 * 1000000) / 1000000) };
    const slots = [{ frame: 2, name: '背面' }, { frame: 48, name: '正面' }, { frame: 92, name: '侧面' }];
    const frameValue = { schema: 1 as const, slots, timing: service.multiviewSettingsTiming(source, slots) };
    assert.ok(contract.parseMultiviewFrameSettingsValue(frameValue));
    assert.equal(frameValue.timing.fps, 24);
    service.assertMultiviewFrameSettingsCompatible(frameValue, { duration: 6, timestamps: Array.from({ length: 145 }, (_, index) => Math.round(index / 24 * 1000000) / 1000000) });
    assert.throws(() => service.assertMultiviewFrameSettingsCompatible(frameValue, { duration: 2, timestamps: source.timestamps.slice(0, 49) }));
    assert.throws(() => service.assertMultiviewFrameSettingsCompatible(frameValue, { duration: 4, timestamps: Array.from({ length: 121 }, (_, index) => index / 30) }));
    const irregular = { ...source, timestamps: source.timestamps.map((time, index) => time + (index === 10 ? 0.001 : 0)) };
    const variable = { schema: 1 as const, slots, timing: service.multiviewSettingsTiming(irregular, slots) };
    assert.equal(variable.timing.fps, null);
    service.assertMultiviewFrameSettingsCompatible(variable, irregular);
    assert.throws(() => service.assertMultiviewFrameSettingsCompatible(variable, source));
    assert.equal(contract.parseMultiviewFrameSettingsInput({ schema: 1, slots, taskId: 'forbidden' }), null);
    assert.equal(contract.parseMultiviewFrameSettingsInput({ schema: 1, slots, layout: {} }), null);
    assert.ok(!JSON.stringify(frameValue).includes('taskId'));
    checks.push('exact_frame_order_names_full_timeline_cfr_longer_compatible_shorter_different_fps_vfr_rejected_without_media');

    await prisma.user.update({ where: { id: 'settings-peer' }, data: { status: 'disabled' } });
    assert.equal((await invoke('settings-peer', 'GET', '?kind=generation')).status, 401);
    assert.equal(await prisma.videoTask.count(), 1);
    assert.equal(await prisma.creditLedger.count(), 0);
    checks.push('fresh_disabled_actor_rejected_and_zero_video_generation_or_point_transactions');
    completed = true;
  } finally {
    await prisma.$disconnect();
    writeFileSync(evidencePath, JSON.stringify({ kind: 'isolated-multiview-settings-engineering', completed, checks,
      production: false, generatedVideo: 0, upstreamRequests: 0, evidencePath }, null, 2), { mode: 0o600 });
  }
  process.stdout.write(JSON.stringify({ completed, checks, evidencePath }) + '\n');
}
void main().catch(error => { process.stderr.write(String(error?.stack || error) + '\n'); process.exitCode = 1; });
