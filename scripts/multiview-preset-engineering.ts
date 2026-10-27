import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/** Offline engineering evidence only. Never accepts a caller-supplied database. */
async function main() {
  const root = realpathSync(process.cwd());
  const scratch = path.join(root, '.role-tests');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(path.join(scratch, 'multiview-preset-'));
  const databasePath = path.join(directory, 'synthetic.db');
  assert.equal(path.dirname(databasePath), directory);
  assert.ok(realpathSync(directory).startsWith(realpathSync(scratch) + path.sep));
  assert.equal(Reflect.get(globalThis, 'prisma'), undefined, 'A separate process with no previously imported Prisma singleton is required');
  process.env.DATABASE_URL = `file:${databasePath}`;
  process.env.SESSION_SECRET = randomBytes(32).toString('hex');
  Object.assign(process.env, { NODE_ENV: 'test' });
  // Next 14.2.5 normally installs this Node runtime primitive before loading
  // request storage. Supply the same primitive, never a mock auth function.
  Reflect.set(globalThis, 'AsyncLocalStorage', AsyncLocalStorage);
  globalThis.fetch = async () => { throw new Error('External requests prohibited in isolated MV-PROMPT engineering'); };
  const childEnv: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) if (process.env[key]) childEnv[key] = process.env[key]!;
  Object.assign(childEnv, { DATABASE_URL: process.env.DATABASE_URL, PRISMA_GENERATE_SKIP_AUTOINSTALL: '1', NEXT_TELEMETRY_DISABLED: '1' });
  // Schema preparation applies only to the just-created synthetic file. No
  // existing file, production URL, schema edit or client generation is used.
  const schemaLog = execFileSync(process.execPath, [path.join(root, 'node_modules/prisma/build/index.js'),
    'db', 'push', '--skip-generate', '--schema', path.join(root, 'prisma/schema.prisma')], {
    cwd: directory, env: childEnv, encoding: 'utf8', timeout: 120000,
  });
  writeFileSync(path.join(directory, 'schema.log'), schemaLog, { mode: 0o600 });

  const require = createRequire(import.meta.url);
  const { requestAsyncStorage } = require('./fixtures/next-request-context') as typeof import('./fixtures/next-request-context');
  const { RequestCookies } = require('next/dist/compiled/@edge-runtime/cookies') as typeof import('next/dist/compiled/@edge-runtime/cookies');
  // Keep one real module graph, including route/service error constructors.
  const { NextRequest } = require('next/server') as typeof import('next/server');
  const { prisma } = require('../src/lib/prisma') as typeof import('../src/lib/prisma');
  const { createSession, SESSION_COOKIE } = require('../src/lib/auth/session') as typeof import('../src/lib/auth/session');
  const contract = require('../src/lib/video/multiview-generation-contract') as typeof import('../src/lib/video/multiview-generation-contract');
  const service = require('../src/lib/video/multiview-preset.server') as typeof import('../src/lib/video/multiview-preset.server');
  const adminRoute = require('../src/app/api/admin/multiview/preset/route') as typeof import('../src/app/api/admin/multiview/preset/route');
  const publicRoute = require('../src/app/api/multiview/preset/route') as typeof import('../src/app/api/multiview/preset/route');
  const sharp = require('../src/lib/media/image-decoder-policy.cjs') as typeof import('sharp').default;
  const checks: string[] = [];
  const evidencePath = path.join(directory, 'receipt.json');
  let concurrentOutcome: unknown = null;
  let completed = false;
  try {
    assert.equal(await prisma.user.count(), 0);
    assert.equal(await prisma.platformSetting.count(), 0);
    const tokens: Record<string, string> = {};
    for (const [id, role, account_type, feature_profile_id] of [
      ['admin-a', 'admin', 'internal', null], ['admin-b', 'admin', 'internal', null],
      ['internal-user', 'user', 'internal', 'internal_email_authorized'], ['external-user', 'user', 'external', null],
    ] as const) {
      await prisma.user.create({ data: { id, name: `Synthetic ${id}`, username: id, email: `${id}@isolated.invalid`,
        password_hash: 'synthetic-not-a-login-password', role, account_type, feature_profile_id } });
      tokens[id] = await createSession(id);
    }
    const invoke = async (route: 'admin' | 'public', method: 'GET' | 'PUT', actor: string | null,
      body?: unknown, query = '') => {
      const headers = new Headers({ ...(actor ? { Cookie: `${SESSION_COOKIE}=${tokens[actor]}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) });
      const request = new NextRequest(`http://mv-prompt-isolated.invalid/api/${route === 'admin' ? 'admin/' : ''}multiview/preset${query}`, {
        method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const store = { headers, cookies: new RequestCookies(headers) } as unknown as Parameters<typeof requestAsyncStorage.run>[0];
      const response = await requestAsyncStorage.run(store, () => route === 'public' ? publicRoute.GET(request)
        : method === 'GET' ? adminRoute.GET(request) : adminRoute.PUT(request));
      assert.match(response.headers.get('cache-control') || '', /private.*no-store/);
      return { status: response.status, body: await response.json() };
    };

    assert.equal((await invoke('admin', 'GET', null)).status, 401);
    assert.equal((await invoke('admin', 'GET', 'internal-user')).status, 403);
    assert.equal((await invoke('admin', 'PUT', 'internal-user', { mutationId: randomUUID(), expectedRevision: 0, prompt: 'not allowed' })).status, 403);
    assert.equal((await invoke('public', 'GET', 'external-user')).status, 403);
    assert.equal((await invoke('public', 'GET', null)).status, 401);
    assert.equal(await prisma.platformSetting.count(), 0);
    assert.equal(await prisma.operationLog.count(), 0);
    checks.push('real_session_admin_and_external_rejection_preserves_401_403_no_writes');

    const unconfigured = await invoke('public', 'GET', 'internal-user');
    assert.equal(unconfigured.status, 503);
    assert.equal(unconfigured.body.code, 'MULTIVIEW_PRESET_UNAVAILABLE');
    const unconfiguredAdmin = await invoke('admin', 'GET', 'admin-a');
    assert.equal(unconfiguredAdmin.status, 503);
    assert.equal(unconfiguredAdmin.body.code, 'MULTIVIEW_PRESET_UNAVAILABLE');
    await assert.rejects(service.readMultiviewRotationPresetVersion('1.0.0'),
      (error: unknown) => error instanceof service.MultiviewPresetError && error.code === 'MULTIVIEW_PRESET_CHANGED');
    assert.equal(await prisma.platformSetting.count(), 0);
    assert.equal(await prisma.operationLog.count(), 0);
    checks.push('unconfigured_authenticated_public_and_admin_get_fail_closed_without_virtual_recipe_or_writes');

    const syntheticPrompt = '仅用于隔离模板测试：图1为本人主图，图2为合成构图参考，固定镜头完成一周旋转。';
    const guideBytes = await sharp({ create: { width: 2, height: 2, channels: 4,
      background: { r: 48, g: 32, b: 16, alpha: 1 } } }).png().toBuffer();
    const guideMetadata = await sharp(guideBytes).metadata();
    assert.equal(guideMetadata.format, 'png'); assert.equal(guideMetadata.width, 2); assert.equal(guideMetadata.height, 2);
    const guideSha256 = createHash('sha256').update(guideBytes).digest('hex');
    writeFileSync(path.join(directory, 'synthetic-system-reference.png'), guideBytes, { mode: 0o600 });
    await prisma.referenceAlbum.create({ data: { id: 'preset-system-reference-album', owner_user_id: 'admin-a',
      name: 'Synthetic private guide', album_type: 'personal', visibility: 'private' } });
    await prisma.asset.create({ data: { id: 'preset-system-reference-asset', owner_id: 'admin-a', type: 'image',
      original_url: `/uploads/assets/${guideSha256}.png`, file_name: 'synthetic-system-reference.png', mime_type: 'image/png',
      file_size: guideBytes.length, width: guideMetadata.width, height: guideMetadata.height, hash: guideSha256 } });
    await prisma.referenceImage.create({ data: { id: 'preset-system-reference', owner_user_id: 'admin-a',
      album_id: 'preset-system-reference-album', asset_id: 'preset-system-reference-asset', url: `/uploads/assets/${guideSha256}.png` } });
    const syntheticPreset: import('../src/lib/video/multiview-generation-contract').MultiviewRotationPreset = {
      id: 'multiview-360', version: '1.0.0', prompt: syntheticPrompt,
      defaults: { ...contract.MULTIVIEW_ROTATION_PRESET.defaults }, compositionReference: {
        assetId: 'preset-system-reference-asset', referenceImageId: 'preset-system-reference', ownerId: 'admin-a', sha256: guideSha256,
      },
    };
    const initialPrivateState = { revision: 0, preset: syntheticPreset };
    const initialPrivateRaw = JSON.stringify(initialPrivateState);
    await prisma.$transaction([
      prisma.platformSetting.create({ data: { key: 'multiview_rotation_preset_v1:current', value_json: initialPrivateRaw, updated_by: 'admin-a' } }),
      prisma.platformSetting.create({ data: { key: 'multiview_rotation_preset_v1:version:1.0.0', value_json: initialPrivateRaw, updated_by: 'admin-a' } }),
    ]);
    assert.equal(await prisma.platformSetting.count(), 2);
    assert.equal(await prisma.operationLog.count(), 0);
    assert.deepEqual(await service.readMultiviewRotationPreset(), initialPrivateState);
    assert.deepEqual(await service.readMultiviewRotationPresetVersion('1.0.0'), syntheticPreset);
    const assertSafePublic = (result: Awaited<ReturnType<typeof invoke>>, revision: number) => {
      assert.equal(result.status, 200);
      const { canReadPrivatePrompt, canEditPrivatePrompt, requiresIdentityVerification, ...publicState } = result.body;
      assert.equal(canReadPrivatePrompt, false);
      assert.equal(canEditPrivatePrompt, false);
      assert.equal(typeof requiresIdentityVerification, 'boolean');
      assert.deepEqual(publicState, { revision, preset: { id: 'multiview-360', version: `1.0.${revision}`,
        defaults: syntheticPreset.defaults } });
      assert.equal(Object.prototype.hasOwnProperty.call(result.body.preset, 'prompt'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(result.body.preset, 'compositionReference'), false);
      for (const secret of [syntheticPrompt, guideSha256, syntheticPreset.compositionReference.assetId,
        syntheticPreset.compositionReference.referenceImageId]) assert.ok(!JSON.stringify(result.body).includes(secret));
    };
    const initial = await invoke('public', 'GET', 'internal-user');
    assertSafePublic(initial, 0);
    assertSafePublic(await invoke('public', 'GET', 'admin-a'), 0);
    const initialAdmin = await invoke('admin', 'GET', 'admin-a');
    assert.equal(initialAdmin.status, 200); assert.deepEqual(initialAdmin.body, initialPrivateState);
    assert.equal(await prisma.platformSetting.count(), 2);
    assert.equal(await prisma.operationLog.count(), 0);
    checks.push('synthetic_current_and_immutable_private_recipe_real_png_binding_admin_full_read_public_safe_dto');

    const legacyDraft = { ...contract.defaultMultiviewGenerationDraft('mv04-isolated'), projectId: 'isolated-project',
      mainImage: { assetId: 'isolated-asset', referenceImageId: 'isolated-reference' }, supplement: '保留个人补充' };
    const legacyOptions = { idempotencyKey: randomUUID(), maxEstimatedCost: 0, preset: initial.body.preset };
    const legacyBody = contract.buildMultiviewGenerationRequest(legacyDraft, legacyOptions);
    assert.equal(Object.prototype.hasOwnProperty.call(legacyBody, 'prompt'), false);
    assert.equal(legacyBody.multiview_generation.schema, 2);
    assert.deepEqual(legacyBody.reference_image_ids, [legacyDraft.mainImage.referenceImageId]);
    assert.ok(!JSON.stringify(legacyBody).includes(syntheticPrompt));
    assert.ok(!JSON.stringify(legacyBody).includes(guideSha256));
    assert.ok(!JSON.stringify(legacyBody).includes(syntheticPreset.compositionReference.referenceImageId));
    const originalRecipe = await service.readMultiviewRotationPresetVersion('1.0.0');
    const originalComposition = contract.composeMultiviewGenerationPrompt(legacyDraft.supplement, originalRecipe.version, originalRecipe);
    assert.equal(originalComposition.valid, true);
    assert.ok(originalComposition.prompt.startsWith(syntheticPrompt));
    assert.ok(originalComposition.prompt.endsWith(legacyDraft.supplement));
    assert.equal(contract.composeMultiviewGenerationPrompt(legacyDraft.supplement).valid, false,
      'A browser-safe request cannot reconstruct a private recipe without the server immutable version');
    const frozenComposition = JSON.stringify(originalComposition);
    const frozenLegacy = JSON.stringify(legacyBody);
    const mutationId = randomUUID();
    const saveBody = { mutationId, expectedRevision: 0, prompt: '合成隔离模板：角色静止，固定镜头，完整旋转 @图片1' };
    const first = await invoke('admin', 'PUT', 'admin-a', saveBody);
    assert.equal(first.status, 200);
    assert.equal(first.body.state, 'saved');
    assert.equal(first.body.revision, 1);
    assert.equal(first.body.preset.version, '1.0.1');
    assert.equal(first.body.preset.prompt, saveBody.prompt);
    assert.deepEqual(first.body.preset.defaults, syntheticPreset.defaults);
    assert.deepEqual(first.body.preset.compositionReference, syntheticPreset.compositionReference);
    const settings = await prisma.platformSetting.findMany();
    assert.equal(settings.length, 3);
    const currentRow = settings.find(row => row.key.endsWith(':current'))!;
    const immutableRow = settings.find(row => row.key.endsWith(':version:1.0.1'))!;
    assert.equal(currentRow.value_json, immutableRow.value_json);
    assert.equal(settings.find(row => row.key.endsWith(':version:1.0.0'))!.value_json, initialPrivateRaw);
    const firstPublic = await invoke('public', 'GET', 'internal-user');
    assertSafePublic(firstPublic, 1);
    assertSafePublic(await invoke('public', 'GET', 'admin-a'), 1);
    assert.equal(JSON.stringify(firstPublic.body).includes(saveBody.prompt), false);
    assert.deepEqual((await invoke('admin', 'GET', 'admin-b')).body, { revision: 1, preset: first.body.preset });
    const audit = await prisma.operationLog.findMany();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].operator_id, 'admin-a');
    assert.equal(audit[0].action, 'multiview_rotation_preset_save');
    assert.deepEqual(JSON.parse(audit[0].detail!).receipt, first.body);
    assert.deepEqual((await invoke('admin', 'GET', 'admin-a', undefined, `?mutationId=${mutationId}`)).body, first.body);
    assert.equal((await invoke('admin', 'GET', 'admin-b', undefined, `?mutationId=${mutationId}`)).body.state, 'not_found');
    checks.push('real_admin_save_current_immutable_audit_and_actor_scoped_receipt_commit_together');

    const replay = await invoke('admin', 'PUT', 'admin-a', saveBody);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, first.body);
    const mismatch = await invoke('admin', 'PUT', 'admin-a', { ...saveBody, prompt: 'different input' });
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.body.code, 'MULTIVIEW_PRESET_MUTATION_CONFLICT');
    const stale = await invoke('admin', 'PUT', 'admin-b', { mutationId: randomUUID(), expectedRevision: 0, prompt: 'stale input' });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'MULTIVIEW_PRESET_REVISION_CONFLICT');
    assert.equal(await prisma.platformSetting.count(), 3);
    assert.equal(await prisma.operationLog.count(), 1);
    checks.push('same_mutation_same_body_replays_different_body_conflicts_stale_cas_never_overwrites');

    assert.deepEqual(contract.parseMultiviewGenerationSnapshot(legacyBody.multiview_generation), legacyBody.multiview_generation);
    const historicalRecipe = await service.readMultiviewRotationPresetVersion('1.0.0');
    assert.deepEqual(historicalRecipe, syntheticPreset);
    assert.equal(JSON.stringify(contract.composeMultiviewGenerationPrompt(legacyDraft.supplement,
      historicalRecipe.version, historicalRecipe)), frozenComposition);
    assert.equal(JSON.stringify(contract.buildMultiviewGenerationRequest(legacyDraft, legacyOptions)), frozenLegacy);
    await assert.rejects(service.assertCurrentMultiviewRotationPreset('1.0.0'),
      (error: unknown) => error instanceof service.MultiviewPresetError && error.status === 409 && error.code === 'MULTIVIEW_PRESET_CHANGED');
    await assert.rejects(prisma.$transaction(tx => service.assertCurrentMultiviewRotationPreset('1.0.0', tx)),
      (error: unknown) => error instanceof service.MultiviewPresetError && error.code === 'MULTIVIEW_PRESET_CHANGED');
    assert.equal((await service.assertCurrentMultiviewRotationPreset('1.0.1')).revision, 1);
    const currentDraft = { ...legacyDraft, presetVersion: first.body.preset.version };
    const currentBody = contract.buildMultiviewGenerationRequest(currentDraft, { ...legacyOptions, preset: firstPublic.body.preset });
    assert.equal(currentBody.multiview_generation.presetVersion, '1.0.1');
    assert.equal(Object.prototype.hasOwnProperty.call(currentBody, 'prompt'), false);
    assert.ok(!JSON.stringify(currentBody).includes(saveBody.prompt));
    assert.equal(currentDraft.supplement, legacyDraft.supplement);
    const savedRecipe = await service.readMultiviewRotationPresetVersion('1.0.1');
    assert.equal(savedRecipe.prompt, saveBody.prompt);
    const tooLong = contract.composeMultiviewGenerationPrompt('x'.repeat(20000), '1.0.1', savedRecipe);
    assert.equal(tooLong.valid, false); assert.ok(tooLong.prompt.endsWith('x'.repeat(20000)), 'No silent truncation');
    const longSave = await invoke('admin', 'PUT', 'admin-a', { mutationId: randomUUID(), expectedRevision: 1, prompt: 'x'.repeat(20000) });
    assert.equal(longSave.status, 400); assert.equal(longSave.body.code, 'MULTIVIEW_PRESET_INVALID');
    assert.equal(await prisma.platformSetting.count(), 3); assert.equal(await prisma.operationLog.count(), 1);
    checks.push('old_frozen_body_still_readable_current_gate_rejects_stale_inside_transaction_personal_input_and_limit_preserved');

    const raceBodies = [0, 1].map(index => ({ mutationId: randomUUID(), expectedRevision: 1, prompt: `并发隔离模板 ${index} @图片1` }));
    const race = await Promise.all(raceBodies.map((body, index) => invoke('admin', 'PUT', index ? 'admin-b' : 'admin-a', body)));
    assert.equal(race.filter(result => result.status === 200).length, 1);
    const loser = race.findIndex(result => result.status !== 200);
    assert.ok([409, 503].includes(race[loser].status));
    assert.equal(race[loser].body.code, race[loser].status === 409 ? 'MULTIVIEW_PRESET_REVISION_CONFLICT' : 'MULTIVIEW_PRESET_SAVE_UNKNOWN');
    const loserReceipt = await invoke('admin', 'GET', loser ? 'admin-b' : 'admin-a', undefined, `?mutationId=${raceBodies[loser].mutationId}`);
    assert.equal(loserReceipt.body.state, 'not_found');
    const current = await service.readMultiviewRotationPreset();
    assert.equal(current.revision, 2);
    assert.deepEqual(current.preset, race.find(result => result.status === 200)!.body.preset);
    assert.deepEqual(current.preset.defaults, syntheticPreset.defaults);
    assert.deepEqual(current.preset.compositionReference, syntheticPreset.compositionReference);
    assertSafePublic(await invoke('public', 'GET', 'internal-user'), 2);
    assertSafePublic(await invoke('public', 'GET', 'admin-a'), 2);
    assert.equal(await prisma.operationLog.count(), 2);
    assert.equal(await prisma.platformSetting.count(), 4);
    assert.deepEqual((await invoke('admin', 'PUT', 'admin-a', saveBody)).body, first.body, 'An old successful receipt does not roll back the newer current pointer');
    assert.equal((await service.readMultiviewRotationPreset()).revision, 2);
    concurrentOutcome = race.map(result => ({ status: result.status, code: result.body.code || 'saved' }));
    checks.push('two_admins_same_revision_one_commits_no_overwrite_no_blind_retry_unknown_stays_query_only');

    await assert.rejects(service.saveMultiviewRotationPreset({ mutationId: randomUUID(), expectedRevision: 2, prompt: 'audit failure fixture' }, 'missing-synthetic-actor'));
    assert.equal((await service.readMultiviewRotationPreset()).revision, 2);
    assert.equal(await prisma.platformSetting.count(), 4);
    assert.equal(await prisma.operationLog.count(), 2);
    assert.deepEqual(await service.readMultiviewRotationPresetVersion('1.0.0'), syntheticPreset);
    assert.equal(await prisma.videoTask.count(), 0);
    assert.equal(await prisma.creditLedger.count(), 0);
    checks.push('real_sqlite_audit_foreign_key_failure_rolls_back_preset_with_zero_tasks_or_credit_rows');
    completed = true;
  } finally {
    await prisma.$disconnect();
    writeFileSync(evidencePath, JSON.stringify({ schema: 'mv-prompt-engineering.v1', synthetic: true, databasePath,
      checks, concurrentOutcome, completed, productionWrites: 0, providerCalls: 0, browserRuns: 0,
      scope: 'Isolated SQLite and real Next route/session functions; no production save/generation or browser acceptance.' }, null, 2), { mode: 0o600 });
    console.log(`MV-PROMPT engineering receipt: ${evidencePath}`);
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Isolated engineering failed'); process.exitCode = 1; });
