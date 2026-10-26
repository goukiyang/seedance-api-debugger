import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/prisma';
import { submitStudioBatch, StudioError } from '../src/lib/image-studio/tasks';
import { applyStudioPreset, saveStudioPreset } from '../src/lib/image-studio/presets';
import { saveStudioModule } from '../src/lib/image-studio/modules';
import { getImageStudioSettings, IMAGE_STUDIO_MODELS, saveImageStudioSettings } from '../src/lib/image-studio/settings';
import { BANANA_IMAGE_API_SETTING_KEY, IMAGE_GENERATION_API_SETTING_KEY } from '../src/lib/integrations/image-generation';

const TENANT_KEY = 'image-studio-context-smoke-tenant';
const API_CONFIG = {
  enabled: true,
  provider: 'musk',
  base_url: 'https://example.invalid/',
  api_key: 'test-only',
  default_model: IMAGE_STUDIO_MODELS[0],
};

type StudioModule = Awaited<ReturnType<typeof saveStudioModule>>;

async function main() {
  if (!process.env.DATABASE_URL?.startsWith('file:/tmp/sd2-image-studio-test-')) {
    throw new Error('Use an isolated /tmp/sd2-image-studio-test-* database');
  }
  process.env.FEISHU_ALLOWED_TENANT_KEY = TENANT_KEY;

  const ownerId = randomUUID();
  const user = await prisma.user.create({ data: {
    id: ownerId,
    name: 'Context smoke',
    username: `context-smoke-${ownerId}`,
    email: `${ownerId}@example.invalid`,
    password_hash: 'not-a-login-password',
    feishu_user_id: ownerId,
    feishu_tenant_key: TENANT_KEY,
  } });

  for (const key of [IMAGE_GENERATION_API_SETTING_KEY, BANANA_IMAGE_API_SETTING_KEY]) {
    await prisma.platformSetting.upsert({
      where: { key },
      update: { value_json: JSON.stringify(API_CONFIG), updated_by: ownerId },
      create: { key, value_json: JSON.stringify(API_CONFIG), updated_by: ownerId },
    });
  }

  const zeroPrices = Object.fromEntries(IMAGE_STUDIO_MODELS.map(model => [model, 0])) as Awaited<ReturnType<typeof getImageStudioSettings>>['prices'];
  async function setGlobalContext(context: string, confirmClear = false) {
    const current = await getImageStudioSettings();
    const next = { ...current, context, model: IMAGE_STUDIO_MODELS[0], prices: zeroPrices };
    const saved = context === '' && confirmClear
      ? await saveImageStudioSettings(next, ownerId, { confirmContextClear: true })
      : await saveImageStudioSettings(next, ownerId);
    assert.ok(saved, 'settings revision must remain current');
    return saved;
  }

  async function createModule(context: string) {
    return saveStudioModule(ownerId, { id: randomUUID(), context }, true);
  }

  async function updateModule(module: StudioModule, context: string, reproduceFromTaskId?: string) {
    return saveStudioModule(ownerId, {
      id: module.id,
      revision: module.revision,
      name: module.name,
      prompt: module.prompt,
      count: module.count,
      referenceLimit: module.referenceLimit,
      aspectRatio: module.aspectRatio,
      model: module.model,
      quality: module.quality,
      resolution: module.resolution,
      referenceIds: module.images.map(image => image.id),
      context,
      ...(reproduceFromTaskId ? { reproduceFromTaskId } : {}),
    });
  }

  async function submit(options: {
    module?: StudioModule;
    moduleRevision?: number;
    reproduceFromTaskId?: string;
    referenceIds?: string[];
    revision?: number;
  } = {}) {
    const settings = await getImageStudioSettings();
    const batchId = await submitStudioBatch(ownerId, {
      requestId: randomUUID(),
      prompt: 'Context smoke prompt',
      count: 1,
      revision: options.revision ?? settings.revision,
      referenceIds: options.referenceIds ?? [],
      ...(options.module ? {
        moduleId: options.module.id,
        moduleRevision: options.moduleRevision ?? options.module.revision,
      } : {}),
      ...(options.reproduceFromTaskId ? { reproduceFromTaskId: options.reproduceFromTaskId } : {}),
    });
    return prisma.imageStudioTask.findFirstOrThrow({ where: { batch_id: batchId } });
  }

  async function retireFixtureTask(taskId: string) {
    await prisma.imageStudioTask.update({ where: { id: taskId }, data: { status: 'failed' } });
  }

  function assertSnapshot(task: { context: string; snapshot_json: string | null }, globalContext: string, moduleContext: string) {
    assert.ok(task.snapshot_json);
    const snapshot = JSON.parse(task.snapshot_json) as { globalContext?: string; moduleContext?: string };
    assert.equal(snapshot.globalContext, globalContext);
    assert.equal(snapshot.moduleContext, moduleContext);
    const expected = [globalContext.trim(), moduleContext.trim()].filter(Boolean).join('\n\n---\n模块上下文：\n');
    assert.ok(task.context.startsWith(expected));
  }

  await setGlobalContext('Global context A');

  const oldModule = await createModule('Legacy module context');
  const oldModuleTask = await submit({ module: oldModule });
  assertSnapshot(oldModuleTask, 'Global context A', 'Legacy module context');
  await retireFixtureTask(oldModuleTask.id);

  const emptyModule = await createModule('');
  const emptyModuleTask = await submit({ module: emptyModule });
  assertSnapshot(emptyModuleTask, 'Global context A', '');
  await retireFixtureTask(emptyModuleTask.id);

  const newModule = await createModule('New module context');
  const newModuleTask = await submit({ module: newModule });
  assertSnapshot(newModuleTask, 'Global context A', 'New module context');
  await retireFixtureTask(newModuleTask.id);

  const preset = await saveStudioPreset(user, {
    scope: 'creator',
    name: 'Context smoke preset',
    groupName: 'Smoke',
    prompt: '',
    context: 'Template context',
    model: IMAGE_STUDIO_MODELS[0],
    count: 1,
    aspectRatio: 'auto',
    referenceIds: [],
  });
  const appliedModule = await applyStudioPreset(user, preset.id);
  assert.equal(appliedModule.context, 'Template context');
  const templateTask = await submit({ module: appliedModule });
  assertSnapshot(templateTask, 'Global context A', 'Template context');
  await retireFixtureTask(templateTask.id);

  await setGlobalContext('', true);
  const transientReference = await prisma.asset.create({ data: {
    owner_id: ownerId,
    type: 'image',
    original_url: '/uploads/context-smoke.png',
    file_name: 'context-smoke.png',
    mime_type: 'image/png',
    file_size: 1,
  } });
  const emptyHistoryTask = await submit({ referenceIds: [transientReference.id] });
  assertSnapshot(emptyHistoryTask, '', '');
  const emptyHistorySnapshot = emptyHistoryTask.snapshot_json;
  await retireFixtureTask(emptyHistoryTask.id);

  await setGlobalContext('Current global context');
  const emptyHistoryReproduction = await submit({ reproduceFromTaskId: emptyHistoryTask.id });
  assertSnapshot(emptyHistoryReproduction, 'Current global context', '');
  assert.equal((await prisma.imageStudioTask.findUniqueOrThrow({ where: { id: emptyHistoryTask.id } })).snapshot_json, emptyHistorySnapshot,
    'reproduction must not rewrite the source task snapshot');
  await retireFixtureTask(emptyHistoryReproduction.id);

  await setGlobalContext('Historic global context');
  const historicModule = await createModule('Historic module context');
  const historicTask = await submit({ module: historicModule });
  const historicSnapshot = historicTask.snapshot_json;
  await retireFixtureTask(historicTask.id);

  await setGlobalContext('Current global context');
  const currentModule = await updateModule(historicModule, 'Current module context', historicTask.id);
  const currentWorkspaceReproduction = await submit({ module: currentModule, reproduceFromTaskId: historicTask.id });
  assertSnapshot(currentWorkspaceReproduction, 'Current global context', 'Current module context');
  assert.equal((await prisma.imageStudioTask.findUniqueOrThrow({ where: { id: historicTask.id } })).snapshot_json, historicSnapshot,
    'workspace reproduction must preserve the source snapshot');
  await retireFixtureTask(currentWorkspaceReproduction.id);

  const historyFallbackReproduction = await submit({ reproduceFromTaskId: historicTask.id });
  assertSnapshot(historyFallbackReproduction, 'Current global context', 'Historic module context');
  assert.equal((await prisma.imageStudioTask.findUniqueOrThrow({ where: { id: historicTask.id } })).snapshot_json, historicSnapshot,
    'history fallback must preserve the source snapshot');
  await retireFixtureTask(historyFallbackReproduction.id);

  await assert.rejects(
    submit({ module: currentModule, moduleRevision: historicModule.revision }),
    error => error instanceof StudioError && error.status === 409,
    'stale module revision must conflict',
  );
  const latestSettings = await getImageStudioSettings();
  await assert.rejects(
    submit({ revision: latestSettings.revision - 1 }),
    error => error instanceof StudioError && error.status === 409,
    'stale global settings revision must conflict',
  );

  console.log('PASS: current global/module context composition, template application, historical fallback, immutable source snapshots, and stale revisions. No worker, network generation, or billing assertions.');
  await prisma.$disconnect();
}

void main().catch(async error => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
