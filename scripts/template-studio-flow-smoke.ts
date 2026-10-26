import assert from 'node:assert/strict';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function requireIsolatedDatabase() {
  const raw = process.env.DATABASE_URL || '';
  if (!raw.startsWith('file:/tmp/sd2-template-studio-test-') || /[?#]/.test(raw)) {
    throw new Error('Refusing to run: DATABASE_URL must be file:/tmp/sd2-template-studio-test-*');
  }
  const databasePath = path.resolve(raw.slice('file:'.length));
  const relative = path.relative('/tmp', databasePath);
  if (path.dirname(databasePath) !== '/tmp'
    || !path.basename(databasePath).startsWith('sd2-template-studio-test-')
    || relative.startsWith('..')
    || path.isAbsolute(relative)) {
    throw new Error('Refusing to run outside the dedicated direct-file template-studio test prefix');
  }
  const databaseStat = lstatSync(databasePath);
  if (!databaseStat.isFile() || databaseStat.isSymbolicLink()) {
    throw new Error('Refusing to run unless the isolated database is a regular, non-symlink file');
  }
}

requireIsolatedDatabase();

async function runSmoke() {
const previousSessionSecret = process.env.SESSION_SECRET;
process.env.SESSION_SECRET = `${randomUUID()}-${randomUUID()}`;
const [{ prisma }, { authorizeStudioRunForGeneration }, handoff, fingerprintModule, session] = await Promise.all([
  import('../src/lib/prisma'),
  import('../src/lib/template-studio/handoff'),
  import('../src/lib/template-studio-video-handoff'),
  import('../src/lib/template-studio-video-fingerprint'),
  import('../src/lib/auth/session'),
]);

const createdUserIds: string[] = [];
const createdDraftIds: string[] = [];
const createdRunIds: string[] = [];
const createdTaskIds: string[] = [];

async function makeSessionUser(id: string) {
  const token = await session.createSession(id);
  const user = await session.getSessionByToken(token);
  assert.ok(user, 'fixture user must resolve through the real session mapper');
  return user;
}

async function createUser(label: string, accountType: 'internal' | 'external' = 'internal') {
  const suffix = `${label}-${randomUUID()}`;
  const user = await prisma.user.create({
    data: {
      name: `Template flow ${label}`,
      username: suffix,
      email: `${suffix}@example.invalid`,
      password_hash: 'smoke-only-not-a-login-credential',
      account_type: accountType,
      feishu_user_id: `feishu-user-${suffix}`,
      feishu_open_id: `feishu-open-${suffix}`,
      feishu_union_id: `feishu-union-${suffix}`,
      feishu_tenant_key: 'template-studio-smoke-tenant',
      feishu_employee_no: `employee-${suffix}`,
      feishu_department_ids: '[]',
      last_feishu_sync_at: new Date(),
    },
  });
  createdUserIds.push(user.id);
  return user;
}

function assertStudioError(error: unknown, status: number) {
  return error instanceof Error
    && 'status' in error
    && Number((error as { status?: unknown }).status) === status;
}

async function main() {
  const owner = await createUser('owner');
  const stranger = await createUser('stranger');
  const external = await createUser('external', 'external');
  const [ownerSession, strangerSession, externalSession] = await Promise.all([
    makeSessionUser(owner.id),
    makeSessionUser(stranger.id),
    makeSessionUser(external.id),
  ]);
  assert.equal(ownerSession.account_type, 'internal');
  assert.equal(ownerSession.feishu?.user_id, owner.feishu_user_id);
  assert.equal(ownerSession.feishu?.open_id, owner.feishu_open_id);
  assert.equal(ownerSession.feishu?.union_id, owner.feishu_union_id);
  assert.equal(externalSession.account_type, 'external');
  assert.equal(externalSession.feishu?.user_id, external.feishu_user_id);
  assert.equal(externalSession.feishu?.open_id, external.feishu_open_id);
  assert.equal(externalSession.feishu?.union_id, external.feishu_union_id);

  const sourceSnapshot = {
    input: { name: 'Flow smoke', groupName: 'contract', values: {}, draftPrompt: 'draft prompt' },
    templateVersion: null,
    recipe: null,
    prompt: 'immutable source prompt',
    parameters: { provider: 'seedance', generationMode: 'all_in_one_reference' },
    assets: [],
    owner: {
      userId: owner.id,
      username: owner.username,
      displayName: owner.name,
      accountType: 'internal' as const,
    },
  };
  const draft = await prisma.videoStudioDraft.create({
    data: { owner_user_id: owner.id, name: 'Flow smoke', template_source: 'blank' },
  });
  createdDraftIds.push(draft.id);
  const run = await prisma.videoStudioRun.create({
    data: {
      owner_user_id: owner.id,
      draft_id: draft.id,
      request_id: `flow-${randomUUID()}`,
      request_fingerprint: fingerprintModule.generationRequestFingerprint(sourceSnapshot),
      source: 'blank',
      mode: 'direct',
      status: 'succeeded',
      prompt: sourceSnapshot.prompt,
      snapshot_json: JSON.stringify(sourceSnapshot),
    },
  });
  createdRunIds.push(run.id);

  const authorized = await authorizeStudioRunForGeneration(ownerSession, run.id);
  assert.equal(authorized.runId, run.id);
  assert.equal(authorized.legacyTemplateId, null);
  assert.equal(authorized.prompt, sourceSnapshot.prompt);
  await assert.rejects(
    () => authorizeStudioRunForGeneration(strangerSession, run.id),
    (error: unknown) => assertStudioError(error, 404),
  );
  await assert.rejects(
    () => authorizeStudioRunForGeneration(externalSession, run.id),
    (error: unknown) => assertStudioError(error, 403),
  );

  const slots = [
    { key: 'first', label: '首帧', role: 'first' as const, types: ['image' as const], required: true, maxItems: 1 },
    { key: 'last', label: '尾帧', role: 'last' as const, types: ['image' as const], required: true, maxItems: 1 },
  ];
  const frameAssets = [
    { assetId: 'asset-first', role: 'first' as const, type: 'image' as const, slotKey: 'first' },
    { assetId: 'asset-last', role: 'last' as const, type: 'image' as const, slotKey: 'last' },
  ];
  assert.equal(handoff.getStudioMaterialCompatibilityError({
    provider: 'seedance', generationMode: 'first_last_frame', assets: frameAssets,
  }), null);
  assert.equal(handoff.getStudioMaterialCompatibilityError({
    provider: 'seedance',
    generationMode: 'first_last_frame',
    assets: [frameAssets[0]],
  }), null);
  assert.equal(handoff.getMissingRequiredStudioAssetSlot(slots, [frameAssets[0]])?.key, 'last');
  assert.equal(handoff.getMissingRequiredStudioAssetSlot(
    [{ ...slots[1], required: false }],
    [frameAssets[0]],
  ), null);
  assert.match(handoff.getStudioMaterialCompatibilityError({
    provider: 'seedance', generationMode: 'first_last_frame',
    assets: [...frameAssets, { assetId: 'asset-reference', role: 'reference', type: 'image' }],
  }) || '', /普通参考素材不会被发送/);
  assert.equal(handoff.getStudioMaterialCompatibilityError({
    provider: 'seedance', generationMode: 'smart_multi_frame',
    assets: [{ assetId: 'asset-image', role: 'reference', type: 'image' }],
  }), null);
  assert.match(handoff.getStudioMaterialCompatibilityError({
    provider: 'seedance', generationMode: 'smart_multi_frame',
    assets: [{ assetId: 'asset-video', role: 'reference', type: 'video' }],
  }) || '', /只接收图片帧/);
  assert.match(handoff.getStudioMaterialCompatibilityError({
    provider: 'h3', generationMode: 'all_in_one_reference',
    assets: [{ assetId: 'asset-image', role: 'reference', type: 'image' }],
  }) || '', /H3 当前只直接接收首尾帧文件/);

  const payload = {
    prompt: 'edited task prompt',
    materialOrder: ['asset-first', 'asset-reference', 'asset-last'],
    settings: { provider: 'seedance', generationMode: 'first_last_frame', priceCap: 12 },
  };
  const requestFingerprint = fingerprintModule.generationRequestFingerprint(payload);
  assert.equal(fingerprintModule.generationRequestFingerprint({
    settings: { priceCap: 12, generationMode: 'first_last_frame', provider: 'seedance' },
    materialOrder: ['asset-first', 'asset-reference', 'asset-last'],
    prompt: 'edited task prompt',
  }), requestFingerprint);
  assert.notEqual(fingerprintModule.generationRequestFingerprint({ ...payload, prompt: 'changed prompt' }), requestFingerprint);
  assert.notEqual(fingerprintModule.generationRequestFingerprint({
    ...payload,
    materialOrder: ['asset-reference', 'asset-first', 'asset-last'],
  }), requestFingerprint);

  assert.deepEqual(handoff.decideGenerationIdempotency({
    request_fingerprint: requestFingerprint,
    video_card_id: 'card-1',
    template_studio_run_id: run.id,
  }, {
    requestFingerprint,
    videoCardId: 'card-1',
    templateStudioRunId: run.id,
  }), { kind: 'deduplicated', fingerprintVerified: true });
  assert.equal(handoff.decideGenerationIdempotency({
    request_fingerprint: requestFingerprint,
    video_card_id: 'card-1',
    template_studio_run_id: run.id,
  }, {
    requestFingerprint: fingerprintModule.generationRequestFingerprint({ ...payload, prompt: 'changed prompt' }),
    videoCardId: 'card-1',
    templateStudioRunId: run.id,
  }).kind, 'payload_mismatch');
  assert.deepEqual(handoff.decideGenerationIdempotency({
    request_fingerprint: null,
    video_card_id: 'card-1',
    template_studio_run_id: null,
  }, {
    requestFingerprint: fingerprintModule.generationRequestFingerprint({ ...payload, prompt: 'legacy retry' }),
    videoCardId: 'card-1',
    templateStudioRunId: null,
  }), { kind: 'deduplicated', fingerprintVerified: false });
  assert.equal(handoff.decideGenerationIdempotency({
    request_fingerprint: null,
    video_card_id: 'other-card',
    template_studio_run_id: null,
  }, {
    requestFingerprint,
    videoCardId: 'card-1',
    templateStudioRunId: null,
  }).kind, 'video_card_mismatch');
  assert.deepEqual(handoff.decideGenerationIdempotency({
    request_fingerprint: requestFingerprint,
    video_card_id: 'card-1',
    template_studio_run_id: null,
  }, {
    requestFingerprint,
    videoCardId: 'card-1',
    templateStudioRunId: null,
  }), { kind: 'deduplicated', fingerprintVerified: true });
  assert.deepEqual(handoff.decideGenerationIdempotency({
    request_fingerprint: requestFingerprint,
    video_card_id: 'card-1',
    template_studio_run_id: null,
  }, {
    requestFingerprint: fingerprintModule.generationRequestFingerprint({ ...payload, prompt: 'changed prompt' }),
    videoCardId: 'card-1',
    templateStudioRunId: null,
  }), { kind: 'payload_mismatch' });
  assert.equal(handoff.decideGenerationIdempotency({
    request_fingerprint: null,
    video_card_id: 'card-1',
    template_studio_run_id: null,
  }, {
    requestFingerprint,
    videoCardId: 'card-1',
    templateStudioRunId: run.id,
  }).kind, 'studio_link_mismatch');

  const snapshotHandoff = {
    ...authorized,
    assets: [
      { assetId: 'asset-reference', role: 'reference' as const, type: 'image' as const, slotKey: 'identity' },
      ...frameAssets,
    ],
    snapshot: {
      ...sourceSnapshot,
      recipe: { instruction: '', fields: [], assetSlots: slots, defaultParameters: {} },
      assets: [
        { assetId: 'asset-reference', role: 'reference' as const, type: 'image' as const, slotKey: 'identity' },
        ...frameAssets,
      ],
    },
  };
  const taskSnapshot = handoff.buildStudioTaskSnapshot(snapshotHandoff, {
    prompt: 'edited task prompt',
    parameters: { provider: 'seedance', model: 'seedance-2.5', generationMode: 'first_last_frame', seed: -1 },
    provider: 'seedance',
    model: 'seedance-2.5',
    generationMode: 'first_last_frame',
    ratio: '16:9',
    duration: 5,
    resolution: '720p',
    seed: -1,
    generateAudio: true,
    returnLastFrame: false,
    watermark: false,
    draft: false,
    projectId: 'project-1',
    videoCardId: 'card-1',
    videoBranchId: null,
    referenceImageIds: [],
    referenceVideoUrls: [],
    referenceAudioUrls: [],
    assets: snapshotHandoff.assets,
    firstFrameAssetId: 'asset-first',
    lastFrameAssetId: 'asset-last',
    h3LoraId: null,
    maxEstimatedCost: 12,
  });
  assert.equal(taskSnapshot.sourceSnapshot.prompt, 'immutable source prompt');
  assert.equal(taskSnapshot.submitted.prompt, 'edited task prompt');
  assert.equal(taskSnapshot.submitted.parameters.seed, -1);
  assert.deepEqual(taskSnapshot.submitted.assets.map((asset) => asset.slotKey), ['identity', 'first', 'last']);

  const task = await prisma.videoTask.create({
    data: {
      provider: 'seedance',
      model: 'smoke-model',
      generation_mode: 'first_last_frame',
      prompt: 'edited task prompt',
      local_status: 'submitted',
      user_id: owner.id,
      owner_user_id: owner.id,
      idempotency_key: `flow-key-${randomUUID()}`,
      template_studio_run_id: run.id,
      template_studio_snapshot_json: JSON.stringify(taskSnapshot),
      request_fingerprint: requestFingerprint,
    },
  });
  createdTaskIds.push(task.id);
  const persistedTask = await prisma.videoTask.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(persistedTask.template_studio_run_id, run.id);
  assert.equal(persistedTask.request_fingerprint, requestFingerprint);
  assert.equal(JSON.parse(persistedTask.template_studio_snapshot_json || '{}').submitted.prompt, 'edited task prompt');

  const lookup = handoff.buildAcceptedTaskLookupWhere(owner.id, task.idempotency_key!, run.id);
  assert.equal((await prisma.videoTask.findFirst({ where: lookup }))?.id, task.id);
  assert.equal(await prisma.videoTask.findFirst({
    where: handoff.buildAcceptedTaskLookupWhere(stranger.id, task.idempotency_key!, run.id),
  }), null);

  const initializedAt = new Date(run.created_at.getTime() + 10);
  assert.equal(handoff.isStudioHandoffWorkspaceInitialized(run.created_at, initializedAt), true);
  assert.equal(handoff.isStudioHandoffWorkspaceInitialized(run.created_at, run.created_at), false);

  await prisma.videoStudioRun.update({ where: { id: run.id }, data: { status: 'cancelled' } });
  await assert.rejects(
    () => authorizeStudioRunForGeneration(ownerSession, run.id),
    (error: unknown) => assertStudioError(error, 409),
  );

  process.stdout.write('[template-studio-flow] isolated DB persistence, task snapshot assembly, owner/revocation checks, and studio/ordinary idempotency decisions passed.\n');
  process.stdout.write('[template-studio-flow] scope excludes tasks/create HTTP execution and real or mocked provider calls.\n');
}

  try {
    await main();
  } finally {
    await prisma.videoTask.deleteMany({ where: { id: { in: createdTaskIds } } });
    await prisma.videoStudioRun.deleteMany({ where: { id: { in: createdRunIds } } });
    await prisma.videoStudioDraft.deleteMany({ where: { id: { in: createdDraftIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.$disconnect();
    if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSessionSecret;
  }
}

void runSmoke().catch((error) => {
  console.error('[template-studio-flow] failed:', error);
  process.exitCode = 1;
});
