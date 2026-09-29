import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const TEST_PREFIX = 'sd2-template-studio-test-';
const runnerDatabaseUrl = process.env.DATABASE_URL || '';

function assertIsolatedRunnerDatabase(value: string) {
  if (!new RegExp(`^file:/tmp/${TEST_PREFIX}[A-Za-z0-9._-]+$`).test(value)) {
    throw new Error(`拒绝运行模板工作台 smoke；DATABASE_URL 必须匹配 file:/tmp/${TEST_PREFIX}*`);
  }
  const databasePath = value.slice('file:'.length);
  if (path.dirname(databasePath) !== '/tmp' || !path.basename(databasePath).startsWith(TEST_PREFIX)) {
    throw new Error('拒绝运行模板工作台 smoke；数据库必须位于隔离临时目录');
  }
  return databasePath;
}

const runnerDatabasePath = assertIsolatedRunnerDatabase(runnerDatabaseUrl);

async function assertRegularTemporaryDatabase(databasePath: string) {
  const info = await fs.lstat(databasePath);
  const [canonicalDatabasePath, canonicalTemporaryRoot] = await Promise.all([fs.realpath(databasePath), fs.realpath('/tmp')]);
  if (!info.isFile() || info.isSymbolicLink()
    || path.dirname(canonicalDatabasePath) !== canonicalTemporaryRoot
    || path.basename(canonicalDatabasePath) !== path.basename(databasePath)) {
    throw new Error('拒绝运行模板工作台 smoke；数据库不是 /tmp 下的普通文件');
  }
}

function replayMigration(databaseUrl: string) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/migrate-template-studio.ts', '--apply'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`隔离迁移回放失败${result.stderr ? `：${result.stderr.slice(-1200)}` : ''}`);
  }
}

function expectStudioError(error: unknown, status: number, code?: string) {
  return Boolean(error && typeof error === 'object'
    && 'status' in error && error.status === status
    && (!code || ('code' in error && error.code === code)));
}

function expectStudioValidationError(error: unknown) {
  return error instanceof Error && error.name === 'StudioValidationError';
}

function feishuIdentityFixture() {
  const id = randomUUID();
  return {
    feishu_user_id: `ou-studio-smoke-${id}`,
    feishu_open_id: `on-studio-smoke-${id}`,
    feishu_union_id: `union-studio-smoke-${id}`,
    feishu_tenant_key: 'tenant-studio-smoke',
    feishu_employee_no: `employee-${id}`,
    feishu_department_ids: JSON.stringify(['department-studio-smoke']),
    last_feishu_sync_at: new Date(),
  };
}

function testUser(row: {
  id: string; name: string; username: string; email: string; role: string; account_type: string; status: string;
  user_profile: string; feature_profile_id: string | null; expires_at: Date | null; mobile: string | null; avatar_url: string | null;
  feishu_user_id: string | null; feishu_open_id: string | null; feishu_union_id: string | null; feishu_tenant_key: string | null;
  feishu_employee_no: string | null; feishu_department_ids: string | null; last_feishu_sync_at: Date | null;
}): import('../src/lib/auth/session').SessionUser {
  let departmentIds: string[] = [];
  try {
    const parsed: unknown = row.feishu_department_ids ? JSON.parse(row.feishu_department_ids) : [];
    departmentIds = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    departmentIds = [];
  }
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    email: row.email,
    role: row.role as import('../src/lib/auth/session').SessionUser['role'],
    account_type: row.account_type as import('../src/lib/auth/session').SessionUser['account_type'],
    user_profile: row.user_profile,
    feature_profile_id: row.feature_profile_id,
    status: row.status as import('../src/lib/auth/session').SessionUser['status'],
    expires_at: row.expires_at,
    mobile: row.mobile,
    avatar_url: row.avatar_url,
    feishu: {
      user_id: row.feishu_user_id,
      open_id: row.feishu_open_id,
      union_id: row.feishu_union_id,
      tenant_key: row.feishu_tenant_key,
      employee_no: row.feishu_employee_no,
      department_ids: departmentIds,
      last_sync_at: row.last_feishu_sync_at,
    },
  };
}

async function verifyLegacyMigration(PrismaClient: typeof import('@prisma/client').PrismaClient) {
  const databasePath = path.join('/tmp', `${TEST_PREFIX}legacy-${process.pid}-${randomUUID()}.db`);
  const databaseUrl = `file:${databasePath}`;
  const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    await client.$executeRawUnsafe('CREATE TABLE "User" ("id" TEXT NOT NULL PRIMARY KEY)');
    await client.$executeRawUnsafe('CREATE TABLE "VideoTask" ("id" TEXT NOT NULL PRIMARY KEY, "provider" TEXT NOT NULL, "model" TEXT NOT NULL, "generation_mode" TEXT NOT NULL, "prompt" TEXT NOT NULL)');
    await client.$executeRawUnsafe('INSERT INTO "User" ("id") VALUES (?)', 'legacy-smoke-user');
    await client.$executeRawUnsafe('INSERT INTO "VideoTask" ("id", "provider", "model", "generation_mode", "prompt") VALUES (?, ?, ?, ?, ?)', 'legacy-smoke-task', 'legacy-provider', 'legacy-model', 'legacy-mode', 'preserve-this-old-prompt');
  } finally {
    await client.$disconnect();
  }

  try {
    replayMigration(databaseUrl);
    replayMigration(databaseUrl);
    const migrated = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    try {
      const rows = await migrated.$queryRawUnsafe<Array<{ id: string; provider: string; prompt: string }>>('SELECT "id", "provider", "prompt" FROM "VideoTask" WHERE "id" = ?', 'legacy-smoke-task');
      assert.deepEqual(rows, [{ id: 'legacy-smoke-task', provider: 'legacy-provider', prompt: 'preserve-this-old-prompt' }]);
      await migrated.$executeRawUnsafe(
        'INSERT INTO "VideoTask" ("id", "provider", "model", "generation_mode", "prompt") VALUES (?, ?, ?, ?, ?)',
        'legacy-writer-after-migration', 'legacy-provider', 'legacy-model', 'legacy-mode', 'new-row-through-old-columns',
      );
      const oldWriterRead = await migrated.$queryRawUnsafe<Array<{ id: string; provider: string; model: string; generation_mode: string; prompt: string }>>(
        'SELECT "id", "provider", "model", "generation_mode", "prompt" FROM "VideoTask" WHERE "id" = ?',
        'legacy-writer-after-migration',
      );
      assert.deepEqual(oldWriterRead, [{
        id: 'legacy-writer-after-migration', provider: 'legacy-provider', model: 'legacy-model',
        generation_mode: 'legacy-mode', prompt: 'new-row-through-old-columns',
      }], 'old-code INSERT/SELECT columns must remain compatible after the additive migration');
      const columns = await migrated.$queryRawUnsafe<Array<{ name: string; notnull: number | bigint }>>('PRAGMA table_info("VideoTask")');
      const columnNames = new Set(columns.map((column) => column.name));
      assert.ok(columnNames.has('prompt'));
      assert.ok(columnNames.has('template_studio_run_id'));
      assert.ok(columnNames.has('template_studio_snapshot_json'));
      assert.ok(columnNames.has('request_fingerprint'));
      for (const name of ['template_studio_run_id', 'template_studio_snapshot_json', 'request_fingerprint']) {
        assert.equal(Number(columns.find((column) => column.name === name)?.notnull), 0, `${name} must remain nullable`);
      }
      const tables = await migrated.$queryRawUnsafe<Array<{ name: string }>>('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = \'VideoTask\'');
      assert.equal(tables.length, 1, 'migration must keep the existing VideoTask table');
      const indexes = await migrated.$queryRawUnsafe<Array<{ name: string }>>('SELECT name FROM sqlite_master WHERE type = \'index\' AND name = \'VideoTask_template_studio_run_id_idx\'');
      assert.equal(indexes.length, 1);
    } finally {
      await migrated.$disconnect();
    }
  } finally {
    for (const suffix of ['', '-journal', '-wal', '-shm']) await fs.rm(`${databasePath}${suffix}`, { force: true });
  }
}

async function main() {
  await assertRegularTemporaryDatabase(runnerDatabasePath);
  const [{ PrismaClient }, { prisma }, validation, errors, capabilities, templates, drafts, runs, adminRuns, handoff, assets, worker] = await Promise.all([
    import('@prisma/client'),
    import('../src/lib/prisma'),
    import('../src/lib/template-studio/validation'),
    import('../src/lib/template-studio/errors'),
    import('../src/lib/template-studio/capabilities'),
    import('../src/lib/template-studio/templates'),
    import('../src/lib/template-studio/drafts'),
    import('../src/lib/template-studio/runs'),
    import('../src/lib/template-studio/admin-runs'),
    import('../src/lib/template-studio/handoff'),
    import('../src/lib/template-studio/assets'),
    import('../src/lib/template-studio/worker'),
  ]);

  try {
    const migrationOwner = await prisma.user.create({
      data: { name: 'Template Smoke', username: `studio-migrate-${randomUUID()}`, email: `studio-migrate-${randomUUID()}@example.invalid`, password_hash: 'smoke-only-not-a-credential' },
    });
    const preservedTask = await prisma.videoTask.create({
      data: { provider: 'smoke', model: 'smoke', generation_mode: 'smoke', prompt: 'preserve-existing-row', owner_user_id: migrationOwner.id },
      select: { id: true, prompt: true },
    });
    replayMigration(runnerDatabaseUrl);
    replayMigration(runnerDatabaseUrl);
    assert.deepEqual(await prisma.videoTask.findUnique({ where: { id: preservedTask.id }, select: { id: true, prompt: true } }), preservedTask);
    await verifyLegacyMigration(PrismaClient);

    const [ownerRow, otherRow] = await Promise.all([
      prisma.user.create({ data: { name: 'Studio Owner', username: `studio-owner-${randomUUID()}`, email: `studio-owner-${randomUUID()}@example.invalid`, password_hash: 'smoke-only-not-a-credential', ...feishuIdentityFixture() } }),
      prisma.user.create({ data: { name: 'Studio Other', username: `studio-other-${randomUUID()}`, email: `studio-other-${randomUUID()}@example.invalid`, password_hash: 'smoke-only-not-a-credential', ...feishuIdentityFixture() } }),
    ]);
    const owner = testUser(ownerRow);
    const other = testUser(otherRow);
    assert.equal(owner.role, 'user');
    assert.equal(owner.account_type, 'internal');
    assert.equal(owner.status, 'active');
    assert.ok(owner.feishu?.user_id, 'company fixture must carry the persisted Feishu identity');
    assert.equal(owner.feishu?.department_ids[0], 'department-studio-smoke', 'company fixture must use the auth session Feishu projection');

    const normalizedParameters = validation.normalizeParameters({
      provider: 'seedance', model: 'smoke-model', generationMode: 'all_in_one_reference', seed: -1,
      draft: false, h3LoraId: 'lora-smoke', modelSpecificConfig: { mode: 'keep' },
    });
    assert.equal(normalizedParameters.seed, -1);
    assert.deepEqual(normalizedParameters.modelSpecificConfig, { mode: 'keep' });
    assert.throws(() => validation.normalizeAssets([
      { assetId: 'asset-a', role: 'reference', type: 'image' },
    ], {
      instruction: 'test', fields: [], defaultParameters: {}, assetSlots: [
        { key: 'ref-a', label: 'A', role: 'reference', types: ['image'], maxItems: 1 },
        { key: 'ref-b', label: 'B', role: 'reference', types: ['image'], maxItems: 1 },
      ],
    }), /需要指定 slotKey/);

    const incompleteTemplate = await templates.createStudioTemplate(owner, {
      name: 'Incomplete Draft Validation',
      groupName: 'Smoke',
      recipe: {
        instruction: 'Fill required fields before execution',
        fields: [
          { key: 'subject', label: '主体', type: 'text', required: true },
          { key: 'camera', label: '镜头', type: 'text', required: true },
          { key: 'style', label: '风格', type: 'select', required: true, options: ['cinematic', 'documentary'] },
          { key: 'duration', label: '时长', type: 'number', required: true, min: 4, max: 12 },
        ],
        assetSlots: [],
        defaultParameters: {},
      },
    });
    const incompleteDraft = await drafts.createStudioDraft(owner, { templateId: incompleteTemplate.id, templateSource: 'studio' });
    const partiallySavedDraft = await drafts.updateStudioDraft(owner, incompleteDraft.id, {
      name: incompleteDraft.name, groupName: incompleteDraft.groupName, prompt: '已输入的提示词要保留',
      values: { subject: '已输入主体', style: '', duration: '' }, assets: [], parameters: {}, revision: incompleteDraft.revision,
    });
    const reloadedPartialDraft = await drafts.getStudioDraft(owner, incompleteDraft.id);
    assert.equal(reloadedPartialDraft.prompt, '已输入的提示词要保留');
    assert.equal(reloadedPartialDraft.values.subject, '已输入主体');
    assert.equal(reloadedPartialDraft.values.camera, undefined, 'missing required values must remain missing in a saved draft');
    assert.equal(reloadedPartialDraft.values.style, '');
    assert.equal(reloadedPartialDraft.values.duration, '');
    await assert.rejects(
      runs.createStudioRun(owner, {
        draftId: reloadedPartialDraft.id, revision: reloadedPartialDraft.revision,
        requestId: `incomplete-run-${randomUUID()}`, mode: 'direct',
      }),
      expectStudioValidationError,
    );

    const outOfRangeDraft = await drafts.updateStudioDraft(owner, partiallySavedDraft.id, {
      name: partiallySavedDraft.name, groupName: partiallySavedDraft.groupName, prompt: partiallySavedDraft.prompt,
      values: { subject: '已输入主体', camera: '中景', style: 'cinematic', duration: 99 }, assets: [], parameters: {}, revision: partiallySavedDraft.revision,
    });
    assert.equal(outOfRangeDraft.values.duration, 99, 'draft saving may retain a bounded numeric value outside the execution range');
    await assert.rejects(
      runs.createStudioRun(owner, {
        draftId: outOfRangeDraft.id, revision: outOfRangeDraft.revision,
        requestId: `out-of-range-run-${randomUUID()}`, mode: 'direct',
      }),
      expectStudioValidationError,
    );

    const completeDraft = await drafts.updateStudioDraft(owner, outOfRangeDraft.id, {
      name: outOfRangeDraft.name, groupName: outOfRangeDraft.groupName, prompt: outOfRangeDraft.prompt,
      values: { subject: '已输入主体', camera: '中景', style: 'cinematic', duration: 8 }, assets: [], parameters: {}, revision: outOfRangeDraft.revision,
    });
    const completedDraftRun = await runs.createStudioRun(owner, {
      draftId: completeDraft.id, revision: completeDraft.revision,
      requestId: `complete-draft-run-${randomUUID()}`, mode: 'direct',
    });
    assert.equal(completedDraftRun.run.status, 'succeeded', 'fully completed values must remain executable');

    const recoverySource = await prisma.videoStudioDraft.findUniqueOrThrow({ where: { id: partiallySavedDraft.id } });
    const recoverySnapshotJson = recoverySource.template_snapshot_json;
    const recoverySourceBefore = {
      revision: recoverySource.revision,
      prompt: recoverySource.prompt,
      values_json: recoverySource.values_json,
      template_snapshot_json: recoverySource.template_snapshot_json,
    };
    const recoveryInput = {
      name: 'Recovered Partial Template Draft',
      prompt: '冲突时尚未保存的提示词',
      values: { subject: '恢复的主体', style: '', duration: '' },
      assets: [],
      parameters: {},
    };
    await templates.patchStudioTemplate(owner, incompleteTemplate.id, {
      action: 'update', expectedRevision: incompleteTemplate.revision,
      name: 'Updated Current Template', groupName: 'Updated Current Group',
      recipe: { instruction: 'This newer recipe must not replace the source draft snapshot', fields: [], assetSlots: [], defaultParameters: {} },
    });
    const runCountBeforeRecoveryCopy = await prisma.videoStudioRun.count({ where: { owner_user_id: owner.id } });
    const draftCountBeforeRecoveryCopy = await prisma.videoStudioDraft.count({ where: { owner_user_id: owner.id } });
    const originalRecoveryFetch = globalThis.fetch;
    let recoveryModelCalls = 0;
    globalThis.fetch = (async () => {
      recoveryModelCalls += 1;
      throw new Error('draft recovery must not call a model or network service');
    }) as typeof fetch;
    const recoveredPartialDraft = await (async () => {
      try {
        return await drafts.createStudioDraft(owner, {
          fromDraftId: partiallySavedDraft.id,
          recovery: recoveryInput,
        });
      } finally {
        globalThis.fetch = originalRecoveryFetch;
      }
    })();
    assert.notEqual(recoveredPartialDraft.id, partiallySavedDraft.id);
    assert.equal(recoveredPartialDraft.name, recoveryInput.name);
    assert.equal(recoveredPartialDraft.groupName, partiallySavedDraft.groupName, 'omitted recovery group should use the source draft value');
    assert.equal(recoveredPartialDraft.prompt, recoveryInput.prompt);
    assert.equal(recoveredPartialDraft.values.subject, '恢复的主体');
    assert.equal(recoveredPartialDraft.values.camera, undefined, 'partial required fields must remain recoverable');
    assert.equal(recoveredPartialDraft.values.style, '');
    assert.equal(recoveredPartialDraft.values.duration, '');
    assert.deepEqual(recoveredPartialDraft.recipe, partiallySavedDraft.recipe);
    assert.equal(recoveredPartialDraft.recipe?.instruction, 'Fill required fields before execution');
    assert.deepEqual(recoveredPartialDraft.template, partiallySavedDraft.template);
    assert.equal(recoveredPartialDraft.revision, 1, 'the recovered draft is a new first revision');
    const recoveredPartialRow = await prisma.videoStudioDraft.findUniqueOrThrow({ where: { id: recoveredPartialDraft.id } });
    assert.equal(recoveredPartialRow.owner_user_id, owner.id);
    assert.equal(recoveredPartialRow.template_snapshot_json, recoverySnapshotJson, 'recovery must copy the exact immutable recipe/template snapshot');
    assert.equal(await prisma.videoStudioDraft.count({ where: { owner_user_id: owner.id } }), draftCountBeforeRecoveryCopy + 1, 'recovery must atomically create exactly one new draft');
    assert.equal(recoveryModelCalls, 0, 'recovery must not call a model or external service');
    assert.deepEqual(await prisma.videoStudioDraft.findUnique({
      where: { id: partiallySavedDraft.id },
      select: { revision: true, prompt: true, values_json: true, template_snapshot_json: true },
    }), recoverySourceBefore);
    assert.equal(await prisma.videoStudioRun.count({ where: { owner_user_id: owner.id } }), runCountBeforeRecoveryCopy, 'recovery copy must not create a run or call a model');
    assert.equal((await prisma.videoStudioRun.findUniqueOrThrow({ where: { id: completedDraftRun.run.id } })).status, 'succeeded', 'recovery must not alter existing runs');
    const forgedRecoveryRequest = {
      fromDraftId: partiallySavedDraft.id,
      recovery: recoveryInput,
      owner_user_id: other.id,
      revision: 99,
      template_snapshot_json: JSON.stringify({ recipe: { instruction: 'forged' } }),
    } as unknown as Parameters<typeof drafts.createStudioDraft>[1];
    await assert.rejects(
      drafts.createStudioDraft(owner, forgedRecoveryRequest),
      (error: unknown) => expectStudioError(error, 400, 'INVALID'),
      'recovery input must not override template snapshot, owner or revision',
    );
    const forgedRecoveryTemplate = {
      fromDraftId: partiallySavedDraft.id,
      recovery: { ...recoveryInput, recipe: { instruction: 'forged', fields: [], assetSlots: [], defaultParameters: {} }, templateSource: 'legacy' },
    } as unknown as Parameters<typeof drafts.createStudioDraft>[1];
    await assert.rejects(
      drafts.createStudioDraft(owner, forgedRecoveryTemplate),
      (error: unknown) => expectStudioError(error, 400, 'INVALID'),
      'recovery fields cannot override the source recipe or template version',
    );
    const mixedDraftRecoveryRequest = {
      fromDraftId: partiallySavedDraft.id,
      recovery: recoveryInput,
      fromRunId: 'must-not-be-used',
      templateId: incompleteTemplate.id,
      templateSource: 'studio',
    } as unknown as Parameters<typeof drafts.createStudioDraft>[1];
    await assert.rejects(
      drafts.createStudioDraft(owner, mixedDraftRecoveryRequest),
      (error: unknown) => expectStudioError(error, 400, 'INVALID'),
      'template and fromDraft recovery sources must be mutually exclusive',
    );
    await assert.rejects(
      drafts.createStudioDraft(other, { fromDraftId: partiallySavedDraft.id, recovery: recoveryInput }),
      (error: unknown) => expectStudioError(error, 404, 'NOT_FOUND'),
      'another owner cannot copy a draft by ID',
    );

    const foreign = { ...owner, account_type: 'external' as const };
    assert.throws(() => errors.requireInternalStudioUser(foreign), (error: unknown) => expectStudioError(error, 403));

    await prisma.platformSetting.upsert({
      where: { key: capabilities.TEMPLATE_STUDIO_TEXT_ENABLED_KEY },
      update: { value_json: 'false' },
      create: { key: capabilities.TEMPLATE_STUDIO_TEXT_ENABLED_KEY, value_json: 'false' },
    });
    await prisma.platformSetting.upsert({
      where: { key: 'musk_api_v1' },
      update: { value_json: JSON.stringify({ enabled: false, base_url: 'https://example.invalid/', default_model: 'smoke-only', api_key: null }) },
      create: { key: 'musk_api_v1', value_json: JSON.stringify({ enabled: false, base_url: 'https://example.invalid/', default_model: 'smoke-only', api_key: null }) },
    });
    const featureOff = await capabilities.getStudioCapabilities(owner);
    assert.equal(featureOff.llmEnabled, false);
    assert.equal(JSON.stringify(featureOff).includes('api_key'), false);

    const inaccessibleAsset = await prisma.asset.create({
      data: { owner_id: other.id, type: 'image', original_url: 'https://example.invalid/smoke.png', file_name: 'smoke.png', mime_type: 'image/png', file_size: 1 },
      select: { id: true },
    });
    const recoveryAssetSource = await drafts.createStudioDraft(owner, {});
    await assert.rejects(
      drafts.createStudioDraft(owner, {
        fromDraftId: recoveryAssetSource.id,
        recovery: {
          prompt: 'Do not copy an unreadable asset', values: {},
          assets: [{ assetId: inaccessibleAsset.id, role: 'reference', type: 'image' }], parameters: {},
        },
      }),
      (error: unknown) => expectStudioError(error, 403, 'FORBIDDEN'),
      'recovery copy must reauthorize every submitted asset',
    );
    await assert.rejects(
      assets.authorizeStudioAssets(owner, [{ assetId: inaccessibleAsset.id, role: 'reference', type: 'image' }]),
      (error: unknown) => expectStudioError(error, 403, 'FORBIDDEN'),
    );
    const legacyDefaultAsset = await prisma.asset.create({
      data: { owner_id: 'default-user', type: 'image', original_url: 'https://example.invalid/legacy-default.png', file_name: 'legacy-default.png', mime_type: 'image/png', file_size: 1 },
      select: { id: true },
    });
    await assert.rejects(
      assets.authorizeStudioAssets(owner, [{ assetId: legacyDefaultAsset.id, role: 'reference', type: 'image' }]),
      (error: unknown) => expectStudioError(error, 403, 'FORBIDDEN'),
    );

    const template = await templates.createStudioTemplate(owner, {
      name: 'Smoke Source Template',
      groupName: 'Smoke',
      recipe: { instruction: 'Initial immutable instruction', fields: [], assetSlots: [], defaultParameters: {} },
    });
    await prisma.generationTemplate.create({
      data: { id: template.id, template_key: `studio-smoke-${randomUUID()}`, name: 'Legacy Collision', status: 'active', created_by: owner.id, updated_by: owner.id },
    });
    const studioDraft = await drafts.createStudioDraft(owner, { templateId: template.id, templateSource: 'studio' });
    const legacyCatalog = await templates.getStudioTemplate(owner, template.id, 'legacy');
    assert.equal(legacyCatalog.template.recipe, null, 'legacy catalog entries must not expose a lossy Studio recipe');
    assert.equal(legacyCatalog.template.applyMode, 'legacy-route');
    assert.equal(legacyCatalog.template.applyUrl, `/template-generate?templateId=${encodeURIComponent(template.id)}`);
    await assert.rejects(
      drafts.createStudioDraft(owner, { templateId: template.id, templateSource: 'legacy' }),
      (error: unknown) => Boolean(expectStudioError(error, 409, 'CONFLICT')
        && 'details' in (error as object)
        && (error as { details?: { applyUrl?: string } }).details?.applyUrl === legacyCatalog.template.applyUrl),
    );
    const legacyRecipe = { instruction: 'Preserved historical legacy instruction', fields: [], assetSlots: [], defaultParameters: {} };
    const legacyRef = {
      templateId: template.id,
      templateSource: 'legacy',
      versionId: null,
      versionNumber: null,
      templateName: legacyCatalog.template.name,
      sourceRevision: `legacy:${legacyCatalog.template.updatedAt}`,
    };
    const legacyDraft = await prisma.videoStudioDraft.create({
      data: {
        owner_user_id: owner.id,
        name: 'Historical Legacy Draft',
        group_name: '旧版模板',
        prompt: 'Historical user text',
        template_source: 'legacy',
        source_template_id: template.id,
        template_snapshot_json: JSON.stringify({ ref: legacyRef, recipe: legacyRecipe }),
      },
    });
    await assert.rejects(
      runs.createStudioRun(owner, { draftId: legacyDraft.id, revision: legacyDraft.revision, requestId: `legacy-new-${randomUUID()}`, mode: 'direct' }),
      (error: unknown) => expectStudioError(error, 409, 'CONFLICT'),
    );
    const legacySnapshot = {
      input: { name: legacyDraft.name, groupName: legacyDraft.group_name, values: {}, draftPrompt: legacyDraft.prompt },
      templateVersion: legacyRef,
      recipe: legacyRecipe,
      prompt: 'Historical legacy prompt',
      parameters: {},
      assets: [],
      owner: { userId: owner.id, username: owner.username, displayName: owner.name || owner.username, accountType: 'internal' },
    };
    const legacyRun = { run: await prisma.videoStudioRun.create({
      data: {
        owner_user_id: owner.id,
        draft_id: legacyDraft.id,
        draft_revision: legacyDraft.revision,
        request_id: `legacy-history-${randomUUID()}`,
        request_fingerprint: 'legacy-history-fixture',
        source: 'legacy',
        mode: 'direct',
        status: 'succeeded',
        delivery_state: 'response_received',
        prompt: legacySnapshot.prompt,
        snapshot_json: JSON.stringify(legacySnapshot),
        completed_at: new Date(),
      },
    }) };
    const legacyCopyRunCount = await prisma.videoStudioRun.count({ where: { owner_user_id: owner.id } });
    await assert.rejects(
      drafts.createStudioDraft(other, { fromRunId: legacyRun.run.id }),
      (error: unknown) => expectStudioError(error, 404, 'NOT_FOUND'),
    );
    const mixedDraftRequest = { fromRunId: legacyRun.run.id, templateId: template.id, templateSource: 'studio' } as unknown as Parameters<typeof drafts.createStudioDraft>[1];
    await assert.rejects(
      drafts.createStudioDraft(owner, mixedDraftRequest),
      (error: unknown) => expectStudioError(error, 400, 'INVALID'),
    );
    const legacyInputCopy = await drafts.createStudioDraft(owner, { fromRunId: legacyRun.run.id });
    assert.equal(legacyInputCopy.prompt, legacySnapshot.input.draftPrompt, 'input copy must not use the composed run prompt');
    assert.deepEqual(legacyInputCopy.values, legacySnapshot.input.values);
    assert.deepEqual(legacyInputCopy.parameters, legacySnapshot.parameters);
    assert.deepEqual(legacyInputCopy.assets, legacySnapshot.assets);
    assert.deepEqual(legacyInputCopy.recipe, legacySnapshot.recipe);
    assert.deepEqual(legacyInputCopy.template, legacySnapshot.templateVersion);
    assert.equal(await prisma.videoStudioRun.count({ where: { owner_user_id: owner.id } }), legacyCopyRunCount, 'input copy must not create or invoke a model run');
    const assetCopyDraft = await drafts.createStudioDraft(owner, {});
    const readyAssetCopyDraft = await drafts.updateStudioDraft(owner, assetCopyDraft.id, {
      name: assetCopyDraft.name, groupName: assetCopyDraft.groupName, prompt: 'Historical asset input',
      values: {}, assets: [], parameters: {}, revision: assetCopyDraft.revision,
    });
    const assetSourceRun = await runs.createStudioRun(owner, {
      draftId: readyAssetCopyDraft.id, revision: readyAssetCopyDraft.revision,
      requestId: `asset-copy-source-${randomUUID()}`, mode: 'direct',
    });
    const assetSourceDetail = await runs.getStudioRun(owner, assetSourceRun.run.id);
    const unavailableHistoricalAsset = { assetId: inaccessibleAsset.id, role: 'reference' as const, type: 'image' as const };
    await prisma.videoStudioRun.update({
      where: { id: assetSourceRun.run.id },
      data: { snapshot_json: JSON.stringify({ ...assetSourceDetail.snapshot, assets: [unavailableHistoricalAsset] }) },
    });
    const assetCopyRunCount = await prisma.videoStudioRun.count({ where: { owner_user_id: owner.id } });
    const assetInputCopy = await drafts.createStudioDraft(owner, { fromRunId: assetSourceRun.run.id });
    assert.deepEqual(assetInputCopy.assets, [unavailableHistoricalAsset], 'copy must retain an unavailable historical asset for editing');
    const editedAssetInputCopy = await drafts.updateStudioDraft(owner, assetInputCopy.id, {
      name: assetInputCopy.name, groupName: assetInputCopy.groupName, prompt: 'Edited while retaining historical asset',
      values: assetInputCopy.values, assets: assetInputCopy.assets, parameters: assetInputCopy.parameters, revision: assetInputCopy.revision,
    });
    assert.equal(editedAssetInputCopy.prompt, 'Edited while retaining historical asset', 'unavailable historical assets must not block restoring and editing a copied draft');
    assert.equal(await prisma.videoStudioRun.count({ where: { owner_user_id: owner.id } }), assetCopyRunCount, 'copying and editing inputs must not invoke the model');
    await assert.rejects(
      runs.createStudioRun(owner, { draftId: editedAssetInputCopy.id, revision: editedAssetInputCopy.revision, requestId: `asset-copy-blocked-${randomUUID()}`, mode: 'direct' }),
      (error: unknown) => expectStudioError(error, 403, 'FORBIDDEN'),
    );
    assert.equal(await prisma.videoStudioRun.count({ where: { owner_user_id: owner.id } }), assetCopyRunCount, 'blocked generation must not create a run');
    const originalRun = await runs.createStudioRun(owner, { draftId: studioDraft.id, revision: studioDraft.revision, requestId: `immutable-${randomUUID()}`, mode: 'direct' });
    await assert.rejects(handoff.authorizeStudioRunForGeneration(foreign, originalRun.run.id), (error: unknown) => expectStudioError(error, 403));
    await assert.rejects(handoff.authorizeStudioRunForGeneration({ ...owner, status: 'disabled' }, originalRun.run.id), (error: unknown) => expectStudioError(error, 403, 'FORBIDDEN'));
    const projectedTask = await prisma.videoTask.create({
      data: { provider: 'smoke', model: 'smoke', generation_mode: 'smoke', prompt: 'projection', owner_user_id: owner.id, template_studio_run_id: originalRun.run.id, local_video_path: '/videos/smoke-projection.mp4' },
      select: { id: true },
    });
    const editedDraft = await drafts.updateStudioDraft(owner, studioDraft.id, {
      name: studioDraft.name, groupName: studioDraft.groupName, prompt: 'Draft edited after acceptance',
      values: {}, assets: [], parameters: normalizedParameters, revision: studioDraft.revision,
    });
    const idempotent = await runs.createStudioRun(owner, { draftId: studioDraft.id, revision: studioDraft.revision, requestId: originalRun.run.requestId, mode: 'direct' });
    assert.equal(idempotent.run.id, originalRun.run.id, 'accepted request must survive later draft edits');
    await assert.rejects(
      runs.createStudioRun(owner, { draftId: editedDraft.id, revision: editedDraft.revision, requestId: originalRun.run.requestId, mode: 'llm' }),
      (error: unknown) => expectStudioError(error, 409, 'CONFLICT'),
    );

    await assert.rejects(runs.listStudioRuns(owner, { templateId: template.id }), (error: unknown) => expectStudioError(error, 400, 'INVALID'));
    const onlyLegacy = await runs.listStudioRuns(owner, { templateId: template.id, templateSource: 'legacy' });
    const onlyStudio = await runs.listStudioRuns(owner, { templateId: template.id, templateSource: 'studio' });
    assert.ok(onlyLegacy.items.some((item) => item.id === legacyRun.run.id));
    assert.equal(onlyLegacy.items.some((item) => item.id === originalRun.run.id), false);
    assert.ok(onlyStudio.items.some((item) => item.id === originalRun.run.id));
    const projectedRun = onlyStudio.items.find((item) => item.id === originalRun.run.id)!;
    assert.equal(projectedRun.taskCount, 1);
    assert.equal(projectedRun.thumbnailUrl, `/api/video/thumbnail/${encodeURIComponent(projectedTask.id)}`);
    const createdWindow = await runs.listStudioRuns(owner, {
      templateId: `studio:${template.id}`,
      createdAfter: new Date(Date.parse(originalRun.run.createdAt) - 5000).toISOString(),
      createdBefore: new Date(Date.parse(originalRun.run.createdAt) + 5000).toISOString(),
    });
    assert.ok(createdWindow.items.some((item) => item.id === originalRun.run.id), 'template source and date filters must affect the database query');
    const historicalLegacyRun = await runs.getStudioRun(owner, legacyRun.run.id);
    assert.equal(historicalLegacyRun.snapshot.templateVersion?.templateSource, 'legacy', 'existing legacy history remains readable');
    assert.equal((await handoff.authorizeStudioRunForGeneration(owner, legacyRun.run.id)).legacyTemplateId, template.id, 'unchanged legacy history remains compatible with the original generation handoff');

    const historicalBeforeEdit = await runs.getStudioRun(owner, originalRun.run.id);
    await templates.patchStudioTemplate(owner, template.id, {
      action: 'update', expectedRevision: template.revision, name: template.name, groupName: template.groupName,
      description: template.description, recipe: { instruction: 'Changed instruction', fields: [], assetSlots: [], defaultParameters: {} },
    });
    const historicalAfterEdit = await runs.getStudioRun(owner, originalRun.run.id);
    assert.deepEqual(historicalAfterEdit.snapshot, historicalBeforeEdit.snapshot, 'run history must keep its immutable snapshot');
    const studioCopyRunCount = await prisma.videoStudioRun.count({ where: { owner_user_id: owner.id } });
    const studioInputCopy = await drafts.createStudioDraft(owner, { fromRunId: originalRun.run.id });
    assert.equal(studioInputCopy.prompt, historicalBeforeEdit.snapshot.input.draftPrompt);
    assert.deepEqual(studioInputCopy.values, historicalBeforeEdit.snapshot.input.values);
    assert.deepEqual(studioInputCopy.parameters, historicalBeforeEdit.snapshot.parameters);
    assert.deepEqual(studioInputCopy.assets, historicalBeforeEdit.snapshot.assets);
    assert.deepEqual(studioInputCopy.recipe, historicalBeforeEdit.snapshot.recipe);
    assert.deepEqual(studioInputCopy.template, historicalBeforeEdit.snapshot.templateVersion);
    assert.equal(studioInputCopy.recipe?.instruction, 'Initial immutable instruction', 'input copy must keep the run-time recipe, not the current template');
    assert.equal(await prisma.videoStudioRun.count({ where: { owner_user_id: owner.id } }), studioCopyRunCount, 'input copy must not create a model run');
    await assert.rejects(
      runs.createStudioRun(owner, { draftId: studioInputCopy.id, revision: studioInputCopy.revision, requestId: `stale-copy-${randomUUID()}`, mode: 'direct' }),
      (error: unknown) => expectStudioError(error, 409, 'CONFLICT'),
    );
    await assert.rejects(
      runs.createStudioRun(owner, { draftId: studioDraft.id, revision: editedDraft.revision, requestId: `stale-${randomUUID()}`, mode: 'direct' }),
      (error: unknown) => expectStudioError(error, 409, 'CONFLICT'),
    );

    const currentDraft = await drafts.createStudioDraft(owner, { templateId: template.id, templateSource: 'studio' });
    const archivedSourceRun = await runs.createStudioRun(owner, { draftId: currentDraft.id, revision: currentDraft.revision, requestId: `archived-${randomUUID()}`, mode: 'direct' });
    await templates.patchStudioTemplate(owner, template.id, { action: 'archive', expectedRevision: template.revision + 1 });
    assert.equal((await runs.getStudioRun(owner, archivedSourceRun.run.id)).snapshot.prompt, 'Changed instruction');
    await assert.rejects(handoff.authorizeStudioRunForGeneration(owner, archivedSourceRun.run.id), (error: unknown) => expectStudioError(error, 409, 'CONFLICT'));
    const editedArchivedCopy = await drafts.updateStudioDraft(owner, studioInputCopy.id, {
      name: studioInputCopy.name, groupName: studioInputCopy.groupName, prompt: 'Editable copied input after source archive',
      values: studioInputCopy.values, assets: studioInputCopy.assets, parameters: studioInputCopy.parameters, revision: studioInputCopy.revision,
    });
    assert.equal(editedArchivedCopy.prompt, 'Editable copied input after source archive');
    await assert.rejects(
      runs.createStudioRun(owner, { draftId: editedArchivedCopy.id, revision: editedArchivedCopy.revision, requestId: `archived-copy-${randomUUID()}`, mode: 'direct' }),
      (error: unknown) => expectStudioError(error, 409, 'CONFLICT'),
    );

    await prisma.videoStudioRun.update({ where: { id: legacyRun.run.id }, data: { status: 'uncertain', delivery_state: 'unknown' } });
    const uncertainHistory = await runs.getStudioRun(owner, legacyRun.run.id);
    assert.equal(uncertainHistory.run.status, 'uncertain');
    assert.equal(uncertainHistory.snapshot.templateVersion?.templateSource, 'legacy');

    await prisma.platformSetting.update({ where: { key: capabilities.TEMPLATE_STUDIO_TEXT_ENABLED_KEY }, data: { value_json: 'true' } });
    await prisma.platformSetting.update({ where: { key: 'musk_api_v1' }, data: { value_json: JSON.stringify({ enabled: true, base_url: 'https://example.invalid/', default_model: 'smoke-only', api_key: 'fake-smoke-key-never-used' }) } });
    const promptDraft = await drafts.createStudioDraft(owner, {});
    const readyPromptDraft = await drafts.updateStudioDraft(owner, promptDraft.id, {
      name: promptDraft.name, groupName: promptDraft.groupName, prompt: 'Smoke prompt', values: {}, assets: [], parameters: {}, revision: promptDraft.revision,
    });
    const queued = await runs.createStudioRun(owner, { draftId: readyPromptDraft.id, revision: readyPromptDraft.revision, requestId: `queue-idempotent-${randomUUID()}`, mode: 'llm' });
    await prisma.platformSetting.update({ where: { key: capabilities.TEMPLATE_STUDIO_TEXT_ENABLED_KEY }, data: { value_json: 'false' } });
    const queuedAgain = await runs.createStudioRun(owner, { draftId: readyPromptDraft.id, revision: readyPromptDraft.revision, requestId: queued.run.requestId, mode: 'llm' });
    assert.equal(queuedAgain.run.id, queued.run.id, 'accepted LLM request must remain readable when the feature is disabled');

    await prisma.platformSetting.update({ where: { key: capabilities.TEMPLATE_STUDIO_TEXT_ENABLED_KEY }, data: { value_json: 'true' } });
    for (const row of await prisma.videoStudioRun.findMany({ where: { owner_user_id: owner.id, mode: 'llm' }, select: { id: true } })) {
      await prisma.videoStudioRun.update({ where: { id: row.id }, data: { status: 'failed', delivery_state: 'not_sent', lease_token: null, lease_expires_at: null } });
    }
    for (let index = 1; index < 5; index += 1) {
      const limited = await runs.createStudioRun(owner, { draftId: readyPromptDraft.id, revision: readyPromptDraft.revision, requestId: `rate-${index}-${randomUUID()}`, mode: 'llm' });
      await prisma.videoStudioRun.update({ where: { id: limited.run.id }, data: { status: 'failed', delivery_state: 'not_sent' } });
    }
    await assert.rejects(
      runs.createStudioRun(owner, { draftId: readyPromptDraft.id, revision: readyPromptDraft.revision, requestId: `rate-limit-${randomUUID()}`, mode: 'llm' }),
      (error: unknown) => expectStudioError(error, 429, 'RATE_LIMITED'),
    );

    const queueSubmitterRow = await prisma.user.create({ data: { name: 'Queue Submitter', username: `studio-queue-${randomUUID()}`, email: `studio-queue-${randomUUID()}@example.invalid`, password_hash: 'smoke-only-not-a-credential', ...feishuIdentityFixture() } });
    const queueOwnerRow = await prisma.user.create({ data: { name: 'Queue Fixture', username: `studio-fixture-${randomUUID()}`, email: `studio-fixture-${randomUUID()}@example.invalid`, password_hash: 'smoke-only-not-a-credential', ...feishuIdentityFixture() } });
    const queueSubmitter = testUser(queueSubmitterRow);
    const queueOwner = testUser(queueOwnerRow);
    const submitterDraft = await drafts.createStudioDraft(queueSubmitter, {});
    const submitterReadyDraft = await drafts.updateStudioDraft(queueSubmitter, submitterDraft.id, {
      name: submitterDraft.name, groupName: submitterDraft.groupName, prompt: 'Queue cap smoke', values: {}, assets: [], parameters: {}, revision: submitterDraft.revision,
    });
    const fixtureDraft = await drafts.createStudioDraft(queueOwner, {});
    await prisma.videoStudioRun.createMany({
      data: Array.from({ length: 50 }, (_, index) => ({
        owner_user_id: queueOwner.id, draft_id: fixtureDraft.id, draft_revision: fixtureDraft.revision,
        request_id: `queue-fixture-${index}-${randomUUID()}`, request_fingerprint: 'smoke-fixture', source: 'blank',
        mode: 'llm', status: 'queued', delivery_state: 'not_sent', snapshot_json: '{}',
      })),
    });
    await assert.rejects(
      runs.createStudioRun(queueSubmitter, { draftId: submitterReadyDraft.id, revision: submitterReadyDraft.revision, requestId: `queue-cap-${randomUUID()}`, mode: 'llm' }),
      (error: unknown) => expectStudioError(error, 503, 'UNAVAILABLE'),
    );

    await prisma.videoStudioRun.updateMany({
      where: { mode: 'llm', status: 'queued' },
      data: { status: 'failed', delivery_state: 'not_sent', lease_token: null, lease_expires_at: null },
    });
    const workerDraft = await drafts.createStudioDraft(owner, {});
    const workerReadyDraft = await drafts.updateStudioDraft(owner, workerDraft.id, {
      name: workerDraft.name, groupName: workerDraft.groupName, prompt: 'Worker state smoke',
      values: {}, assets: [], parameters: {}, revision: workerDraft.revision,
    });
    const workerSeedRun = await runs.createStudioRun(owner, {
      draftId: workerReadyDraft.id, revision: workerReadyDraft.revision,
      requestId: `worker-seed-${randomUUID()}`, mode: 'direct',
    });
    const workerSnapshot = (await runs.getStudioRun(owner, workerSeedRun.run.id)).snapshot;
    const createWorkerRun = (
      label: string,
      runOwner = owner,
      runDraft = workerReadyDraft,
      snapshot = workerSnapshot,
    ) => prisma.videoStudioRun.create({
      data: {
        owner_user_id: runOwner.id,
        draft_id: runDraft.id,
        draft_revision: runDraft.revision,
        request_id: `worker-${label}-${randomUUID()}`,
        request_fingerprint: `worker-${label}`,
        source: 'blank',
        mode: 'llm',
        status: 'queued',
        delivery_state: 'not_sent',
        snapshot_json: JSON.stringify(snapshot),
      },
    });
    const assertSendingLease = async (id: string) => {
      const row = await prisma.videoStudioRun.findUniqueOrThrow({ where: { id } });
      assert.equal(row.status, 'running');
      assert.equal(row.delivery_state, 'sending');
      assert.ok(row.lease_token, 'claimed runs must hold a lease token before sending');
      assert.ok(row.lease_expires_at && row.lease_expires_at.getTime() > Date.now(), 'sending lease must be live');
      assert.equal(row.attempt, 1);
    };

    const originalFetch = globalThis.fetch;
    let workerFetchCalls = 0;
    try {
      globalThis.fetch = async () => {
        workerFetchCalls += 1;
        throw new Error('unexpected network request in disabled worker case');
      };
      await prisma.platformSetting.update({ where: { key: capabilities.TEMPLATE_STUDIO_TEXT_ENABLED_KEY }, data: { value_json: 'false' } });
      const disabledWorkerRun = await createWorkerRun('disabled');
      assert.equal(await worker.processStudioPromptOnce(), true);
      const disabledResult = await prisma.videoStudioRun.findUniqueOrThrow({ where: { id: disabledWorkerRun.id } });
      assert.equal(disabledResult.status, 'failed');
      assert.equal(disabledResult.delivery_state, 'not_sent');
      assert.equal(disabledResult.attempt, 1);
      assert.equal(workerFetchCalls, 0, 'disabled text processing must not make a network request');
      assert.equal(await worker.processStudioPromptOnce(), false, 'a pre-send failure must not be automatically retried');

      const cancelledWorkerRun = await createWorkerRun('cancelled');
      await runs.cancelStudioRun(owner, cancelledWorkerRun.id);
      assert.equal(await worker.processStudioPromptOnce(), false, 'cancelled queued runs must not be claimed');
      assert.equal(workerFetchCalls, 0, 'cancelled queued runs must not call the upstream');
      const cancelledResult = await prisma.videoStudioRun.findUniqueOrThrow({ where: { id: cancelledWorkerRun.id } });
      assert.equal(cancelledResult.status, 'cancelled');
      assert.equal(cancelledResult.attempt, 0);

      const externalRow = await prisma.user.create({
        data: {
          name: 'External Worker Fixture', username: `studio-external-${randomUUID()}`,
          email: `studio-external-${randomUUID()}@example.invalid`, password_hash: 'smoke-only-not-a-credential',
          account_type: 'external', ...feishuIdentityFixture(),
        },
      });
      const externalUser = testUser(externalRow);
      const externalDraft = await drafts.createStudioDraft(externalUser, {});
      const externalReadyDraft = await drafts.updateStudioDraft(externalUser, externalDraft.id, {
        name: externalDraft.name, groupName: externalDraft.groupName, prompt: 'External worker must be rejected',
        values: {}, assets: [], parameters: {}, revision: externalDraft.revision,
      });
      const externalSnapshot = {
        ...workerSnapshot,
        owner: { ...workerSnapshot.owner, userId: externalUser.id, username: externalUser.username, accountType: 'external' as const },
      };
      const externalWorkerRun = await createWorkerRun('external', externalUser, externalReadyDraft, externalSnapshot);
      assert.equal(await worker.processStudioPromptOnce(), true);
      const externalResult = await prisma.videoStudioRun.findUniqueOrThrow({ where: { id: externalWorkerRun.id } });
      assert.equal(externalResult.status, 'failed');
      assert.equal(externalResult.delivery_state, 'not_sent');
      assert.equal(workerFetchCalls, 0, 'external accounts must be rejected before any mock upstream request');

      await prisma.platformSetting.update({ where: { key: capabilities.TEMPLATE_STUDIO_TEXT_ENABLED_KEY }, data: { value_json: 'true' } });
      const successfulWorkerRun = await createWorkerRun('success');
      globalThis.fetch = async (input, init) => {
        workerFetchCalls += 1;
        assert.equal(new URL(String(input)).hostname, 'example.invalid', 'worker test must use a fake host');
        assert.equal(init?.method, 'POST');
        await assertSendingLease(successfulWorkerRun.id);
        const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role: string; content: string }> };
        assert.ok(body.messages?.every((message) => typeof message.content === 'string'), 'worker must send text-only messages');
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ prompt: 'Mocked completed prompt' }) } }],
          model: 'contract-mock',
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      };
      assert.equal(await worker.processStudioPromptOnce(), true);
      const successfulResult = await prisma.videoStudioRun.findUniqueOrThrow({ where: { id: successfulWorkerRun.id } });
      assert.equal(successfulResult.status, 'succeeded');
      assert.equal(successfulResult.delivery_state, 'response_received');
      assert.equal(successfulResult.prompt, 'Mocked completed prompt');
      assert.equal(successfulResult.attempt, 1);
      assert.equal(await worker.processStudioPromptOnce(), false);
      assert.equal(workerFetchCalls, 1, 'a completed request must not be automatically resent');

      const uncertainWorkerRun = await createWorkerRun('uncertain');
      globalThis.fetch = async () => {
        workerFetchCalls += 1;
        await assertSendingLease(uncertainWorkerRun.id);
        throw new Error('mock transport interrupted after request send');
      };
      assert.equal(await worker.processStudioPromptOnce(), true);
      const uncertainResult = await prisma.videoStudioRun.findUniqueOrThrow({ where: { id: uncertainWorkerRun.id } });
      assert.equal(uncertainResult.status, 'uncertain');
      assert.equal(uncertainResult.delivery_state, 'unknown');
      assert.equal(uncertainResult.lease_token, null);
      assert.equal(uncertainResult.attempt, 1);
      assert.equal(await worker.processStudioPromptOnce(), false, 'unknown delivery must not be automatically retried');
      assert.equal(workerFetchCalls, 2, 'unknown delivery must cause zero automatic resends');

      const lateWorkerRun = await createWorkerRun('late-response');
      let signalFetchEntered!: () => void;
      let resolveLateResponse!: (response: Response) => void;
      const fetchEntered = new Promise<void>((resolve) => { signalFetchEntered = resolve; });
      const pendingResponse = new Promise<Response>((resolve) => { resolveLateResponse = resolve; });
      globalThis.fetch = async () => {
        workerFetchCalls += 1;
        signalFetchEntered();
        return pendingResponse;
      };
      const lateWorkerPromise = worker.processStudioPromptOnce();
      await fetchEntered;
      await assertSendingLease(lateWorkerRun.id);
      await prisma.videoStudioRun.update({ where: { id: lateWorkerRun.id }, data: { lease_expires_at: new Date(Date.now() - 1000) } });
      assert.equal(await worker.recoverExpiredStudioRuns(), 1, 'expired sending lease must become uncertain');
      resolveLateResponse(new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ prompt: 'Too late to overwrite' }) } }],
        model: 'contract-mock',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      assert.equal(await lateWorkerPromise, true);
      const lateResult = await prisma.videoStudioRun.findUniqueOrThrow({ where: { id: lateWorkerRun.id } });
      assert.equal(lateResult.status, 'uncertain');
      assert.equal(lateResult.delivery_state, 'unknown');
      assert.notEqual(lateResult.prompt, 'Too late to overwrite', 'late response must not overwrite lease recovery');
      assert.equal(await worker.processStudioPromptOnce(), false);
      assert.equal(workerFetchCalls, 3, 'lease recovery must not trigger an automatic resend');
    } finally {
      globalThis.fetch = originalFetch;
    }

    const pagingDraft = await drafts.createStudioDraft(owner, {});
    const pagingReadyDraft = await drafts.updateStudioDraft(owner, pagingDraft.id, {
      name: pagingDraft.name, groupName: pagingDraft.groupName, prompt: 'Pagination smoke', values: {}, assets: [], parameters: {}, revision: pagingDraft.revision,
    });
    const expectedRunIds = new Set<string>();
    for (let index = 0; index < 33; index += 1) {
      expectedRunIds.add((await runs.createStudioRun(owner, {
        draftId: pagingReadyDraft.id, revision: pagingReadyDraft.revision, requestId: `page-${index}-${randomUUID()}`, mode: 'direct',
      })).run.id);
    }
    const seenRunIds = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await runs.listStudioRuns(owner, { draftId: pagingDraft.id, cursor });
      for (const row of page.items) {
        assert.equal(seenRunIds.has(row.id), false, 'run keyset pages must not duplicate records');
        seenRunIds.add(row.id);
      }
      cursor = page.nextCursor || undefined;
    } while (cursor);
    for (const id of Array.from(expectedRunIds)) assert.ok(seenRunIds.has(id), 'run keyset pages must expose all older records');

    const adminRow = await prisma.user.create({
      data: { name: 'Studio Admin', username: `studio-admin-${randomUUID()}`, email: `studio-admin-${randomUUID()}@example.invalid`, password_hash: 'smoke-only-not-a-credential', role: 'admin', ...feishuIdentityFixture() },
    });
    const admin = testUser(adminRow);
    await assert.rejects(
      drafts.createStudioDraft(admin, { fromDraftId: partiallySavedDraft.id, recovery: recoveryInput }),
      (error: unknown) => expectStudioError(error, 404, 'NOT_FOUND'),
      'admins may recover only drafts they own, never another user\'s draft',
    );
    await assert.rejects(
      adminRuns.listAdminStudioRuns(owner, {}),
      (error: unknown) => expectStudioError(error, 403, 'FORBIDDEN'),
      'ordinary internal users must not access cross-owner run review',
    );
    await assert.rejects(
      adminRuns.listAdminStudioRuns({ ...admin, status: 'disabled' }, {}),
      (error: unknown) => expectStudioError(error, 403, 'FORBIDDEN'),
      'inactive admins must not access cross-owner run review',
    );
    await assert.rejects(
      adminRuns.listAdminStudioRuns({ ...admin, account_type: 'external' }, {}),
      (error: unknown) => expectStudioError(error, 403, 'FORBIDDEN'),
      'external admins must not access cross-owner run review',
    );

    const reviewTemplate = await templates.createStudioTemplate(owner, {
      name: 'Immutable Admin Review Template', groupName: 'Review',
      recipe: { instruction: 'Snapshot-only name', fields: [], assetSlots: [], defaultParameters: {} },
    });
    await prisma.user.update({
      where: { id: owner.id },
      data: { avatar_url: 'https://avatar.example.com/profile.png?token=PRIVATE_AVATAR_SIGNED_SENTINEL' },
    });
    const reviewDraft = await drafts.createStudioDraft(owner, { templateId: reviewTemplate.id, templateSource: 'studio' });
    const readyReviewDraft = await drafts.updateStudioDraft(owner, reviewDraft.id, {
      name: reviewDraft.name, groupName: reviewDraft.groupName, prompt: 'PRIVATE_PROMPT_SENTINEL',
      values: {}, assets: [], parameters: {}, revision: reviewDraft.revision,
    });
    const reviewCreated = await runs.createStudioRun(owner, {
      draftId: readyReviewDraft.id, revision: readyReviewDraft.revision,
      requestId: `admin-review-${randomUUID()}`, mode: 'direct',
    });
    const reviewRunRow = await prisma.videoStudioRun.findUniqueOrThrow({ where: { id: reviewCreated.run.id } });
    const reviewSnapshot = JSON.parse(reviewRunRow.snapshot_json) as Record<string, unknown>;
    await prisma.videoStudioRun.update({
      where: { id: reviewCreated.run.id },
      data: {
        status: 'uncertain', delivery_state: 'unknown', attempt: 2, model: 'model-review-safe',
        error_message: 'PRIVATE_UPSTREAM_RAW_SENTINEL https://private.example/result?token=PRIVATE_SIGNED_SENTINEL',
        usage_json: JSON.stringify({ prompt_tokens: 4, completion_tokens: 6, total_tokens: 10, api_key: 'PRIVATE_USAGE_KEY_SENTINEL', raw_response: 'PRIVATE_USAGE_RAW_SENTINEL' }),
        snapshot_json: JSON.stringify({
          ...reviewSnapshot,
          prompt: 'PRIVATE_PROMPT_SENTINEL',
          templateVersion: { ...(reviewSnapshot.templateVersion as object), templateName: 'Immutable Admin Review Template' },
          private_payload: 'PRIVATE_SNAPSHOT_SENTINEL',
        }),
      },
    });
    const reviewTask = await prisma.videoTask.create({
      data: {
        provider: 'smoke', model: 'smoke', generation_mode: 'smoke', prompt: 'private task prompt',
        owner_user_id: owner.id, template_studio_run_id: reviewCreated.run.id, local_status: 'succeeded',
        delivery_status: 'completed', public_video_url: 'https://private.example/video.mp4?token=PRIVATE_TASK_SIGNED_SENTINEL',
      },
      select: { id: true },
    });
    const adminReviewPage = await adminRuns.listAdminStudioRuns(admin, {
      status: 'uncertain', ownerUserId: owner.id, draftId: reviewDraft.id,
      templateId: reviewTemplate.id, templateSource: 'studio',
    });
    const adminReviewItem = adminReviewPage.items.find((item) => item.id === reviewCreated.run.id);
    assert.ok(adminReviewItem, 'admin must be able to review another internal owner’s uncertain run');
    assert.equal(adminReviewPage.reviewNotice, adminRuns.SAFE_REVIEW_NOTICE);
    assert.equal(adminReviewItem.owner.displayName, owner.name);
    assert.equal(adminReviewItem.owner.avatarUrl, 'https://avatar.example.com/profile.png');
    assert.equal(adminReviewItem.templateName, 'Immutable Admin Review Template', 'template label must come from the immutable run snapshot');
    assert.equal(adminReviewItem.deliveryState, 'unknown');
    assert.equal(adminReviewItem.attempt, 2);
    assert.equal(adminReviewItem.safeError?.includes('人工核对'), true);
    assert.deepEqual(adminReviewItem.usage, { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 });
    assert.equal(adminReviewItem.taskCount, 1);
    assert.equal(adminReviewItem.tasksTruncated, false);
    assert.equal(adminReviewItem.tasks[0].id, reviewTask.id);
    assert.equal(adminReviewItem.tasks[0].thumbnailUrl, `/api/video/thumbnail/${encodeURIComponent(reviewTask.id)}`);
    assert.equal(adminReviewItem.tasks[0].href, `/tasks/${encodeURIComponent(reviewTask.id)}?return_to=%2Fadmin%2Fagent-runs`);
    const adminReviewDetail = await adminRuns.getAdminStudioRun(admin, reviewCreated.run.id);
    const serializedAdminReview = JSON.stringify({ list: adminReviewPage, detail: adminReviewDetail });
    for (const privateSentinel of [
      'PRIVATE_PROMPT_SENTINEL', 'PRIVATE_UPSTREAM_RAW_SENTINEL', 'PRIVATE_SIGNED_SENTINEL',
      'PRIVATE_USAGE_KEY_SENTINEL', 'PRIVATE_USAGE_RAW_SENTINEL', 'PRIVATE_SNAPSHOT_SENTINEL',
      'PRIVATE_TASK_SIGNED_SENTINEL', 'PRIVATE_AVATAR_SIGNED_SENTINEL',
    ]) assert.equal(serializedAdminReview.includes(privateSentinel), false, `admin projection must not expose ${privateSentinel}`);
    assert.equal(serializedAdminReview.includes('https://private.example'), false, 'admin projection must not expose raw media URLs');
    assert.equal(adminReviewDetail.run.tasks[0].playUrl, `/api/video/play/${encodeURIComponent(reviewTask.id)}`);
    assert.equal(adminReviewDetail.run.tasks[0].downloadUrl, `/api/video/download/${encodeURIComponent(reviewTask.id)}`);

    const adminPageTimestamp = new Date('2026-09-29T12:00:00.000Z');
    await prisma.videoStudioRun.createMany({
      data: Array.from({ length: 32 }, (_, index) => ({
        id: `admin-page-${String(index).padStart(2, '0')}`,
        owner_user_id: owner.id, draft_id: reviewDraft.id, draft_revision: readyReviewDraft.revision,
        request_id: `admin-page-${index}-${randomUUID()}`, request_fingerprint: `admin-page-fingerprint-${index}`,
        source: 'studio', mode: 'llm', status: index % 2 ? 'uncertain' : 'failed',
        delivery_state: index % 2 ? 'unknown' : 'response_received', snapshot_json: '{}', created_at: adminPageTimestamp,
      })),
    });
    const adminPagedIds = new Set<string>();
    let adminCursor: string | undefined;
    let adminPageCount = 0;
    do {
      const page = await adminRuns.listAdminStudioRuns(admin, {
        status: 'uncertain', ownerUserId: owner.id, draftId: reviewDraft.id,
        templateId: reviewTemplate.id, templateSource: 'studio', cursor: adminCursor,
      });
      adminPageCount += 1;
      for (const item of page.items) {
        assert.equal(adminPagedIds.has(item.id), false, 'admin keyset pages must not repeat runs');
        assert.equal(item.status, 'uncertain', 'admin status filter must be applied in the database query');
        adminPagedIds.add(item.id);
      }
      adminCursor = page.nextCursor || undefined;
    } while (adminCursor);
    assert.ok(adminPageCount >= 2, 'admin run history must use multiple stable cursor pages');
    assert.equal(adminPagedIds.size, 17, 'admin keyset paging must include all uncertain matching runs');
    const failedReviewPage = await adminRuns.listAdminStudioRuns(admin, {
      status: 'failed', ownerUserId: owner.id, draftId: reviewDraft.id,
      templateId: reviewTemplate.id, templateSource: 'studio',
    });
    assert.equal(failedReviewPage.items.length, 16, 'failed status filter must exclude uncertain runs');

    const publishedTemplate = await templates.createStudioTemplate(admin, {
      name: 'Frozen Published Search Name',
      groupName: 'Frozen Published Group',
      recipe: { instruction: 'Published recipe', fields: [], assetSlots: [], defaultParameters: {} },
    });
    const publishedVersion = await templates.patchStudioTemplate(admin, publishedTemplate.id, {
      action: 'publish', expectedRevision: publishedTemplate.revision,
    });
    await templates.patchStudioTemplate(admin, publishedTemplate.id, {
      action: 'update', expectedRevision: publishedVersion.revision,
      name: 'Unpublished Editor Name', groupName: 'Unpublished Editor Group',
      recipe: { instruction: 'Unpublished recipe', fields: [], assetSlots: [], defaultParameters: {} },
    });
    const publishedFilter = await templates.listStudioTemplates(owner, { search: 'Frozen Published Search', group: 'Frozen Published Group' });
    assert.ok(publishedFilter.items.some((item) => item.id === publishedTemplate.id && item.name === 'Frozen Published Search Name'), 'shared filters must use the immutable published version');
    const unpublishedFilter = await templates.listStudioTemplates(owner, { search: 'Unpublished Editor', group: 'Unpublished Editor Group' });
    assert.equal(unpublishedFilter.items.some((item) => item.id === publishedTemplate.id), false, 'unpublished shared edits must not affect the public catalog');

    const paginationPrefix = `Pagination ${randomUUID()}`;
    const expectedTemplateIds = new Set<string>();
    const expectedDraftIds = new Set<string>();
    const paginationTemplateRows: Array<{ id: string; ownerId: string; index: number }> = [];
    for (let index = 0; index < 33; index += 1) {
      const item = await templates.createStudioTemplate(owner, {
        name: `${paginationPrefix} ${index}`, groupName: 'Pagination',
        recipe: { instruction: 'Pagination recipe', fields: [], assetSlots: [], defaultParameters: {} },
      });
      expectedTemplateIds.add(item.id);
      paginationTemplateRows.push({ id: item.id, ownerId: owner.id, index });
      const draft = await drafts.createStudioDraft(owner, { name: `${paginationPrefix} ${index}`, groupName: 'Pagination' });
      expectedDraftIds.add(draft.id);
    }
    for (let index = 0; index < 35; index += 1) {
      const hidden = await templates.createStudioTemplate(other, {
        name: `${paginationPrefix} hidden ${index}`, groupName: 'Pagination',
        recipe: { instruction: 'Hidden pagination recipe', fields: [], assetSlots: [], defaultParameters: {} },
      });
      paginationTemplateRows.push({ id: hidden.id, ownerId: other.id, index });
    }
    const paginationBase = Date.parse('2026-09-29T10:00:00.000Z');
    for (const entry of paginationTemplateRows) {
      const offset = entry.ownerId === owner.id
        ? entry.index < 30 ? entry.index * 1000 : 2_000_000 + (entry.index - 30) * 1000
        : 30_000 + (entry.index + 1) * 1000;
      const timestamp = new Date(paginationBase - offset);
      await prisma.videoStudioTemplate.update({ where: { id: entry.id }, data: { created_at: timestamp, updated_at: timestamp } });
    }
    const seenTemplateIds = new Set<string>();
    let templateCursor: string | undefined;
    do {
      const page = await templates.listStudioTemplates(owner, { cursor: templateCursor, search: paginationPrefix });
      for (const item of page.items) {
        assert.equal(seenTemplateIds.has(item.id), false, 'template keyset pages must not duplicate records');
        seenTemplateIds.add(item.id);
      }
      templateCursor = page.nextCursor || undefined;
    } while (templateCursor);
    for (const id of Array.from(expectedTemplateIds)) assert.ok(seenTemplateIds.has(id), 'template keyset pages must expose all matching records');

    const seenDraftIds = new Set<string>();
    let draftCursor: string | undefined;
    do {
      const page = await drafts.listStudioDrafts(owner, draftCursor);
      for (const item of page.items) {
        assert.equal(seenDraftIds.has(item.id), false, 'draft keyset pages must not duplicate records');
        seenDraftIds.add(item.id);
      }
      draftCursor = page.nextCursor || undefined;
    } while (draftCursor);
    for (const id of Array.from(expectedDraftIds)) assert.ok(seenDraftIds.has(id), 'draft keyset pages must expose all older records');

    process.stdout.write('模板工作台契约 smoke 完成：隔离迁移及旧列兼容、权限/快照/幂等/限额/分页与 worker mock 契约已执行；未访问网络或真实模型。\n');
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error) => {
  console.error('[template-studio-smoke] failed:', error instanceof Error ? error.message : 'unknown');
  process.exitCode = 1;
});
