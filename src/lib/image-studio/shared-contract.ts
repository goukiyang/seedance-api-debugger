import { createHash } from 'node:crypto';
import type { ImageStudioPreset, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { canManageStudioPreset, canUseCompanyTemplates, canViewStudioPreset, type ImageStudioIdentity } from './access';
import { archivedPresetKey, studioPresetArchived } from './preset-lifecycle';
import { getStudioModuleFixedReferences, getStudioPresetFixedReferences, parseStudioFixedReferences, setStudioPresetFixedReferences, StudioFixedReferenceError, type StudioFixedReference } from './fixed-references';
import { getStudioModuleReferencePolicy, getStudioPresetReferencePolicy, parseStudioReferencePolicy, setStudioPresetReferencePolicy, validateStudioReferenceCounts, StudioReferencePolicyError, type StudioReferencePolicy } from './reference-policy';
import { getStudioModuleStyleIds, parseStudioStyleIds, resolveStudioStyleReferences, setStudioPresetStyleIds, StudioStyleError, type StudioStyleGroup } from './style-groups';
import { getSkillSelection, setSkillSelection } from './skills';
import { studioVisibleAssetWhere } from './protected-assets';
import { IMAGE_STUDIO_MODELS, normalizeImageStudioQuality, normalizeImageResolution } from './model-catalog';
import { normalizeStudioRatio } from './ratios';
import { getImageStudioSettings } from './settings';
import { MAX_REFERENCE_IMAGES } from './limits';
import { studioTemplateAssetUrl } from './media';
import type { SharedStudioCatalog, SharedStudioCatalogItem, SharedStudioDefaults, SharedStudioDefinitionPersonalInput, SharedStudioIntent, SharedStudioPersonalOverrides, SharedStudioPublicDefinition } from './shared-types';

export type { SharedStudioIntent, SharedStudioPersonalOverrides } from './shared-types';
export const SHARED_STUDIO_PROTOCOL = 'shared-live-v1' as const;
export class StudioSharingError extends Error {
  intent?: SharedStudioIntent;
  constructor(message: string, public status = 409) { super(message); }
}
export type SharedStudioClient = Pick<Prisma.TransactionClient, 'platformSetting' | 'imageStudioPreset' | 'imageStudioModule' | 'imageStudioTask' | 'asset' | 'user'>;
export type SharedStudioBinding = { protocol: typeof SHARED_STUDIO_PROTOCOL; ownerId: string; presetId: string; mode: 'publisher' | 'live' };
export type SharedStudioReproduction = {
  version: 1;
  sourceOwnerId: string;
  sourceTaskId: string;
  moduleContext: string;
  globalContext: string;
  templateFixedReferences: StudioFixedReference[];
};
export type SharedStudioDefinition = {
  intent: SharedStudioIntent;
  sourceOwnerId: string;
  sourceRevision: string;
  name: string;
  groupName: string;
  bannerAssetId: string | null;
  prompt: string;
  templatePrompt: string;
  context: string;
  generationDefaults: SharedStudioDefaults;
  templateReferenceIds: string[];
  referencePolicy: StudioReferencePolicy;
  fixedReferences: StudioFixedReference[];
  styleGroupIds: string[];
  styleGroups: StudioStyleGroup[];
  styleReferences: StudioFixedReference[];
  reproduction?: SharedStudioReproduction;
};
export const studioBindingKey = (moduleId: string) => `studio_shared_binding_v1:${moduleId}`;
export const studioPublisherKey = (presetId: string) => `studio_shared_publisher_v1:${presetId}`;
export const studioSharedReproductionKey = (presetId: string) => `studio_shared_reproduction_v1:${presetId}`;
const overridesKey = (moduleId: string) => `studio_shared_overrides_v1:${moduleId}`;
const removedGroupsKey = (ownerId: string) => `studio_removed_default_groups_v1:${ownerId}`;
const overrideFields = ['prompt', 'model', 'quality', 'resolution', 'count', 'aspectRatio'] as const;
const defaultGroups = ['常用', '角色', '场景', '海报'];
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const has = (value: object, field: string) => Object.prototype.hasOwnProperty.call(value, field);

export async function assertStudioActor(ownerId: string, client: SharedStudioClient = prisma) {
  const user = await client.user.findUnique({ where: { id: ownerId }, select: {
    id: true, role: true, account_type: true, status: true, expires_at: true, feature_profile_id: true,
    feishu_user_id: true, feishu_open_id: true, feishu_union_id: true, feishu_tenant_key: true,
  } });
  if (!user || user.status !== 'active' || user.expires_at && user.expires_at.getTime() <= Date.now() || !canUseCompanyTemplates(user)) {
    throw new StudioSharingError('当前账号没有模板使用权限，本人草稿和历史仍保留', 403);
  }
  return user;
}
function parseRecord(value: string, message: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw new StudioSharingError(message, 409); }
}
function referenceIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_REFERENCE_IMAGES || value.some(id => typeof id !== 'string' || !id || id.length > 100)) {
    throw new StudioSharingError('模板参考图片无效', 400);
  }
  return Array.from(new Set(value as string[]));
}
function storedIds(value: string) {
  try { return referenceIds(JSON.parse(value)); }
  catch { throw new StudioSharingError('模板参考图片无法读取，请由创建者重新保存', 409); }
}
function sharedRatio(value: unknown) {
  try { return normalizeStudioRatio(value); }
  catch (error) { throw new StudioSharingError((error as Error).message, 400); }
}
function normalizeSharedError(error: unknown) {
  if (error instanceof StudioFixedReferenceError || error instanceof StudioReferencePolicyError || error instanceof StudioStyleError) {
    return new StudioSharingError(error.message, [400, 403, 404, 409].includes(error.status) ? error.status : 409);
  }
  return error;
}
async function writeSetting(client: SharedStudioClient, key: string, ownerId: string, value: unknown) {
  const value_json = JSON.stringify(value);
  await client.platformSetting.upsert({ where: { key }, create: { key, value_json, updated_by: ownerId }, update: { value_json, updated_by: ownerId } });
}
export function automaticStudioModuleId(ownerId: string, presetId: string) {
  const h = digest(['studio-auto-v1', ownerId, presetId]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export async function studioSharedBinding(ownerId: string, moduleId: string, client: SharedStudioClient = prisma): Promise<SharedStudioBinding | null> {
  const row = await client.platformSetting.findUnique({ where: { key: studioBindingKey(moduleId) }, select: { value_json: true } });
  if (!row) return null;
  const value = parseRecord(row.value_json, '共享模板绑定无法确认');
  if (value.ownerId !== ownerId || typeof value.presetId !== 'string' || !value.presetId
    || value.protocol !== SHARED_STUDIO_PROTOCOL || !['publisher', 'live'].includes(String(value.mode))) {
    throw new StudioSharingError('共享模板绑定无法确认', 409);
  }
  return { protocol: SHARED_STUDIO_PROTOCOL, ownerId, presetId: value.presetId, mode: value.mode as SharedStudioBinding['mode'] };
}
async function bindStudioModule(client: SharedStudioClient, moduleId: string, binding: SharedStudioBinding) {
  const existing = await studioSharedBinding(binding.ownerId, moduleId, client);
  if (existing && (existing.presetId !== binding.presetId || existing.mode !== binding.mode)) throw new StudioSharingError('共享模板绑定冲突', 409);
  if (!existing) await writeSetting(client, studioBindingKey(moduleId), binding.ownerId, binding);
  if (binding.mode === 'publisher') {
    const key = studioPublisherKey(binding.presetId);
    const value = { ownerId: binding.ownerId, moduleId, presetId: binding.presetId, protocol: SHARED_STUDIO_PROTOCOL };
    const row = await client.platformSetting.findUnique({ where: { key }, select: { value_json: true } });
    if (row && row.value_json !== JSON.stringify(value)) throw new StudioSharingError('模板创建者绑定冲突', 409);
    if (!row) await writeSetting(client, key, binding.ownerId, value);
  }
}
export async function studioPublisherModule(ownerId: string, presetId: string, client: SharedStudioClient = prisma) {
  const row = await client.platformSetting.findUnique({ where: { key: studioPublisherKey(presetId) }, select: { value_json: true } });
  if (!row) return null;
  const value = parseRecord(row.value_json, '模板创建者绑定无法确认');
  if (value.ownerId !== ownerId || value.presetId !== presetId || value.protocol !== SHARED_STUDIO_PROTOCOL || typeof value.moduleId !== 'string') {
    throw new StudioSharingError('模板创建者绑定无法确认', 409);
  }
  const binding = await studioSharedBinding(ownerId, value.moduleId, client);
  if (!binding || binding.mode !== 'publisher' || binding.presetId !== presetId) throw new StudioSharingError('模板创建者绑定无法确认', 409);
  return value.moduleId;
}
async function reproductionForPreset(client: SharedStudioClient, ownerId: string, presetId: string): Promise<SharedStudioReproduction | undefined> {
  const row = await client.platformSetting.findUnique({ where: { key: studioSharedReproductionKey(presetId) }, select: { value_json: true } });
  if (!row) return undefined;
  const value = parseRecord(row.value_json, '历史模板定义无法读取');
  if (value.version !== 1 || value.sourceOwnerId !== ownerId || typeof value.sourceTaskId !== 'string'
    || typeof value.moduleContext !== 'string' || typeof value.globalContext !== 'string') throw new StudioSharingError('历史模板定义无法确认', 409);
  return { version: 1, sourceOwnerId: ownerId, sourceTaskId: value.sourceTaskId, moduleContext: value.moduleContext,
    globalContext: value.globalContext, templateFixedReferences: parseStudioFixedReferences(value.templateFixedReferences) };
}

export async function resolveSharedStudioDefinition(user: ImageStudioIdentity, presetId: string, client: SharedStudioClient = prisma) {
  try {
    return await (client === prisma ? prisma.$transaction(tx => resolveSharedStudioDefinitionInternal(user, presetId, tx), { timeout: 15000 })
      : resolveSharedStudioDefinitionInternal(user, presetId, client));
  }
  catch (error) { throw normalizeSharedError(error); }
}
async function resolveSharedStudioDefinitionInternal(user: ImageStudioIdentity, presetId: string, client: SharedStudioClient) {
  const actor = await assertStudioActor(user.id, client);
  const source = await client.imageStudioPreset.findUnique({ where: { id: presetId } });
  if (!source) throw new StudioSharingError('模板已不存在，本人历史结果仍保留', 404);
  if (!canViewStudioPreset(actor, source)) throw new StudioSharingError('模板已停止共享或无权使用，本人历史结果仍保留', 403);
  if (await studioPresetArchived(presetId, client)) throw new StudioSharingError('模板已删除，本人历史结果仍保留', 409);
  const intent: SharedStudioIntent = { protocol: SHARED_STUDIO_PROTOCOL, presetId, definitionToken: await sharedDefinitionToken(source, client) };
  try { return await resolveSharedStudioDefinitionData(actor, source, intent, client); }
  catch (error) {
    const problem = normalizeSharedError(error);
    if (problem instanceof StudioSharingError && problem.status === 400) problem.status = 409;
    if (problem instanceof StudioSharingError && canManageStudioPreset(actor, source)) problem.intent = intent;
    throw problem;
  }
}
async function resolveSharedStudioDefinitionData(actor: ImageStudioIdentity, source: ImageStudioPreset, intent: SharedStudioIntent, client: SharedStudioClient) {
  const presetId = source.id;
  const skillIds = await getSkillSelection(source.owner_id, source.id, client, 'preset');
  if (skillIds.length) throw new StudioSharingError('模板含私人skills，不能作为实时共享模板使用', 409);
  const ids = storedIds(source.reference_ids);
  const storedPolicy = await getStudioPresetReferencePolicy(source.owner_id, source.id, ids, source.reference_limit, client);
  const templateReferenceIds = ids.filter(id => !storedPolicy.primaryIds.includes(id));
  const referencePolicy = { ...storedPolicy, primaryIds: [] };
  const reproduction = await reproductionForPreset(client, source.owner_id, source.id);
  const fixedReferences = reproduction?.templateFixedReferences ?? await getStudioPresetFixedReferences(actor, source, client);
  const styleGroupIds = await getStudioModuleStyleIds(source.owner_id, source.id, client, 'preset');
  const styles = await resolveStudioStyleReferences(actor, styleGroupIds, client);
  try { validateStudioReferenceCounts(referencePolicy, templateReferenceIds, fixedReferences.length, styles.references.length); }
  catch (error) { throw new StudioSharingError((error as Error).message, 409); }
  const assetIds = Array.from(new Set([...templateReferenceIds, ...fixedReferences.map(ref => ref.assetId), ...styles.references.map(ref => ref.assetId), ...(source.banner_asset_id ? [source.banner_asset_id] : [])])).sort();
  const assets = await client.asset.findMany({ where: { id: { in: assetIds } }, select: {
    id: true, owner_id: true, status: true, type: true, original_url: true, thumbnail_url: true, width: true, height: true, hash: true, created_at: true,
  }, orderBy: { id: 'asc' } });
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  const ownedIds = [...templateReferenceIds, ...fixedReferences.map(ref => ref.assetId), ...(source.banner_asset_id ? [source.banner_asset_id] : [])];
  if (assets.length !== assetIds.length || assets.some(asset => asset.status !== 'active' || asset.type !== 'image')
    || ownedIds.some(id => byId.get(id)?.owner_id !== source.owner_id)) throw new StudioSharingError('模板引用的图片已不可用，请由创建者重新保存', 409);
  const visible = await studioVisibleAssetWhere(actor, client);
  const readable = await client.asset.findMany({ where: { id: { in: [...templateReferenceIds, ...(source.banner_asset_id ? [source.banner_asset_id] : [])] }, AND: [visible] }, select: { id: true } });
  const readableIds = new Set(readable.map(asset => asset.id));
  if (templateReferenceIds.some(id => !readableIds.has(id))) throw new StudioSharingError('模板参考图已变为受保护内容，请由创建者核对', 409);
  const model = source.model as SharedStudioDefaults['model'];
  if (!IMAGE_STUDIO_MODELS.includes(model)) throw new StudioSharingError('模板模型已不可用，请由创建者重新保存', 409);
  const generationDefaults: SharedStudioDefaults = { model, quality: normalizeImageStudioQuality(model, source.quality),
    resolution: normalizeImageResolution(model, source.resolution), count: source.count, aspectRatio: source.aspect_ratio,
    referenceLimit: source.reference_limit, referencePolicy };
  const sourceRevision = source.updated_at.toISOString();
  const context = reproduction?.moduleContext ?? source.context;
  const definition: SharedStudioDefinition = { intent, sourceOwnerId: source.owner_id, sourceRevision, name: source.name,
    groupName: source.group_name || '未分组', bannerAssetId: source.banner_asset_id, prompt: source.prompt, templatePrompt: source.prompt,
    context, generationDefaults, templateReferenceIds, referencePolicy, fixedReferences, styleGroupIds, styleGroups: styles.groups,
    styleReferences: styles.references, ...(reproduction ? { reproduction } : {}) };
  const image = (id: string) => {
    const asset = byId.get(id)!;
    return { id, originalUrl: studioTemplateAssetUrl(id), thumbnailUrl: studioTemplateAssetUrl(id, true), width: asset.width, height: asset.height };
  };
  const canSeeContext = actor.role === 'admin' || source.owner_id === actor.id;
  const publicDTO: SharedStudioPublicDefinition = { intent, presetId, revision: sourceRevision, name: definition.name, groupName: definition.groupName,
    banner: source.banner_asset_id && readableIds.has(source.banner_asset_id) ? image(source.banner_asset_id) : null,
    templatePrompt: source.prompt, context: canSeeContext ? context : '', contextConfigured: Boolean(context.trim()),
    contextEditable: canManageStudioPreset(actor, source), canManageSharing: canManageStudioPreset(actor, source),
    ownedByViewer: source.owner_id === actor.id, isShared: source.is_shared, defaults: generationDefaults,
    templateReferenceIds, images: templateReferenceIds.map(image), fixedReferenceCount: fixedReferences.length,
    fixedReferences: actor.role === 'admin' ? fixedReferences.map(ref => ({ ...image(ref.assetId), note: canSeeContext ? ref.note : '', available: true })) : [],
    styleGroupIds, styleGroups: styles.groups.map(group => ({ id: group.id, name: group.name, revision: group.revision,
      referenceCount: group.references.length, coverUrl: `/api/image-studio/style-groups/${group.id}/cover?revision=${group.revision}`,
      canManage: canUseCompanyTemplates(actor) && (actor.role === 'admin' || group.ownerId === actor.id) })),
    reproductionConfigured: Boolean(reproduction) };
  return { definition, publicDTO };
}

export async function getSharedStudioPersonalOverrides(ownerId: string, moduleId: string, client: SharedStudioClient = prisma) {
  const row = await client.platformSetting.findUnique({ where: { key: overridesKey(moduleId) }, select: { value_json: true } });
  if (!row) return {} as SharedStudioPersonalOverrides;
  const value = parseRecord(row.value_json, '个人模板设置无法读取');
  if (value.ownerId !== ownerId) throw new StudioSharingError('个人模板设置所有者不匹配', 403);
  return parseSharedStudioPersonalOverrides(value.overrides);
}
export function parseSharedStudioPersonalOverrides(value: unknown): SharedStudioPersonalOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StudioSharingError('个人设置无效', 400);
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !overrideFields.includes(key as typeof overrideFields[number]))) throw new StudioSharingError('个人设置包含不能覆盖的模板字段', 400);
  const result: SharedStudioPersonalOverrides = {};
  if (has(input, 'prompt')) {
    if (typeof input.prompt !== 'string' || input.prompt.length > 20000) throw new StudioSharingError('本次提示词最多20000字', 400);
    result.prompt = input.prompt;
  }
  if (has(input, 'model')) {
    if (!IMAGE_STUDIO_MODELS.includes(input.model as SharedStudioDefaults['model'])) throw new StudioSharingError('个人模型设置无效', 400);
    result.model = input.model as SharedStudioDefaults['model'];
  }
  if (has(input, 'quality')) {
    if (!['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(input.quality))) throw new StudioSharingError('个人质量设置无效', 400);
    result.quality = input.quality as SharedStudioDefaults['quality'];
  }
  if (has(input, 'resolution')) {
    if (!['0.5K', '1K', '2K', '4K'].includes(String(input.resolution))) throw new StudioSharingError('个人分辨率设置无效', 400);
    result.resolution = input.resolution as SharedStudioDefaults['resolution'];
  }
  if (has(input, 'count')) {
    if (!Number.isInteger(input.count) || Number(input.count) < 1 || Number(input.count) > 8) throw new StudioSharingError('生成张数须为1到8张', 400);
    result.count = Number(input.count);
  }
  if (has(input, 'aspectRatio')) result.aspectRatio = sharedRatio(input.aspectRatio);
  return result;
}
export async function resolveSharedStudioModule(user: ImageStudioIdentity, moduleId: string, client: SharedStudioClient = prisma) {
  const binding = await studioSharedBinding(user.id, moduleId, client);
  if (!binding) return null;
  const workspace = await client.imageStudioModule.findFirst({ where: { id: moduleId, owner_id: user.id } });
  if (!workspace || workspace.source_preset_id !== binding.presetId) throw new StudioSharingError('共享模板工作区不存在或来源不匹配', 409);
  const { definition, publicDTO } = await resolveSharedStudioDefinition(user, binding.presetId, client);
  if (binding.mode === 'publisher' && definition.sourceOwnerId !== user.id) throw new StudioSharingError('无权管理他人的原模板', 403);
  const personalOverrides = await getSharedStudioPersonalOverrides(user.id, moduleId, client);
  return { binding, definition, personalOverrides, publicDTO };
}

type Receipt = { fingerprint: string; result: Record<string, unknown> };
function requestKey(ownerId: string, requestId: unknown) {
  if (typeof requestId !== 'string' || !requestId || requestId.length > 160 || !/^[A-Za-z0-9:_-]+$/.test(requestId)) throw new StudioSharingError('请使用有效的保存请求编号', 400);
  return `studio_shared_request_v1:${digest([ownerId, requestId])}`;
}
async function readReceipt(client: SharedStudioClient, ownerId: string, requestId: unknown, fingerprint: string): Promise<Receipt['result'] | null> {
  const row = await client.platformSetting.findUnique({ where: { key: requestKey(ownerId, requestId) }, select: { value_json: true } });
  if (!row) return null;
  const value = parseRecord(row.value_json, '原保存回执无法读取');
  if (value.ownerId !== ownerId || value.fingerprint !== fingerprint || !value.result || typeof value.result !== 'object' || Array.isArray(value.result)) {
    throw new StudioSharingError('该请求编号已用于其他操作，请核对原保存结果', 409);
  }
  return value.result as Receipt['result'];
}
async function writeReceipt(client: SharedStudioClient, ownerId: string, requestId: unknown, fingerprint: string, result: Receipt['result']) {
  await client.platformSetting.create({ data: { key: requestKey(ownerId, requestId), value_json: JSON.stringify({ ownerId, fingerprint, result }), updated_by: ownerId } });
}
function inTransaction<T>(client: SharedStudioClient | undefined, action: (tx: SharedStudioClient) => Promise<T>) {
  return client ? action(client) : prisma.$transaction(tx => action(tx), { timeout: 15000 });
}
export async function openSharedStudioModule(user: ImageStudioIdentity, presetId: string, requestId: unknown, client?: SharedStudioClient) {
  return inTransaction(client, async tx => {
    const actor = await assertStudioActor(user.id, tx);
    const fingerprint = digest(['open-shared', presetId]);
    const receipt = await readReceipt(tx, actor.id, requestId, fingerprint);
    if (receipt) {
      const restored = await tx.imageStudioModule.findFirst({ where: { id: String(receipt.moduleId), owner_id: actor.id } });
      if (!restored) throw new StudioSharingError('原工作区已删除，不会重复创建', 409);
      try { await resolveSharedStudioModule(actor, restored.id, tx); }
      catch (error) {
        const binding = await studioSharedBinding(actor.id, restored.id, tx);
        if (!(error instanceof StudioSharingError) || !error.intent || binding?.mode !== 'publisher') throw error;
      }
      return restored;
    }
    let sourceOwnerId: string;
    try { sourceOwnerId = (await resolveSharedStudioDefinition(actor, presetId, tx)).definition.sourceOwnerId; }
    catch (error) {
      if (!(error instanceof StudioSharingError) || !error.intent) throw error;
      const source = await tx.imageStudioPreset.findUnique({ where: { id: presetId } });
      if (!source || !canManageStudioPreset(actor, source)) throw error;
      sourceOwnerId = source.owner_id;
    }
    const publisherId = sourceOwnerId === actor.id ? await studioPublisherModule(actor.id, presetId, tx) : null;
    const moduleId = publisherId || automaticStudioModuleId(actor.id, presetId);
    const existing = await tx.imageStudioModule.findUnique({ where: { id: moduleId } });
    if (existing && (existing.owner_id !== actor.id || existing.source_preset_id !== presetId || !(await studioSharedBinding(actor.id, moduleId, tx)))) {
      throw new StudioSharingError('共享工作区编号冲突，原数据未改', 409);
    }
    const workspace = existing || await tx.imageStudioModule.create({ data: { id: moduleId, owner_id: actor.id, source_preset_id: presetId, revision: 1 } });
    if (!existing) await bindStudioModule(tx, moduleId, { protocol: SHARED_STUDIO_PROTOCOL, ownerId: actor.id, presetId,
      mode: sourceOwnerId === actor.id ? 'publisher' : 'live' });
    await writeReceipt(tx, actor.id, requestId, fingerprint, { moduleId, presetId, revision: workspace.revision });
    return workspace;
  });
}

async function historicalDefinition(actor: ImageStudioIdentity, taskId: string, client: SharedStudioClient): Promise<SharedStudioReproduction> {
  const task = await client.imageStudioTask.findFirst({ where: { id: taskId, owner_id: actor.id, deleted_at: null }, select: { source_preset_id: true, snapshot_json: true } });
  if (!task?.snapshot_json) throw new StudioSharingError('历史记录缺少原上下文，模板未保存', 409);
  const snapshot = parseRecord(task.snapshot_json, '历史记录缺少原上下文');
  if (typeof snapshot.moduleContext !== 'string' || typeof snapshot.globalContext !== 'string') throw new StudioSharingError('历史记录缺少完整上下文，模板未保存', 409);
  const sharedSnapshot = snapshot.sharedLive && typeof snapshot.sharedLive === 'object' && !Array.isArray(snapshot.sharedLive)
    ? snapshot.sharedLive as Record<string, unknown> : null;
  if (typeof sharedSnapshot?.sourceOwnerId === 'string' && sharedSnapshot.sourceOwnerId !== actor.id
    || typeof snapshot.sourcePresetOwnerId === 'string' && snapshot.sourcePresetOwnerId !== actor.id) {
    throw new StudioSharingError('历史记录含他人的内部上下文，不能共享', 403);
  }
  const originalId = task.source_preset_id || (typeof snapshot.sourcePresetId === 'string' ? snapshot.sourcePresetId
    : typeof sharedSnapshot?.presetId === 'string' ? sharedSnapshot.presetId : null);
  if (originalId) {
    const original = await client.imageStudioPreset.findUnique({ where: { id: originalId } });
    if (!original || original.owner_id !== actor.id || !canViewStudioPreset(actor, original) || await studioPresetArchived(originalId, client)) {
      throw new StudioSharingError('历史记录含他人或不可用原模板，不能共享内部定义', 403);
    }
  }
  if (snapshot.skills !== undefined && (!Array.isArray(snapshot.skills) || snapshot.skills.length)) throw new StudioSharingError('历史记录含私人skills，不能共享', 409);
  if (snapshot.skillIds !== undefined && (!Array.isArray(snapshot.skillIds) || snapshot.skillIds.length)) throw new StudioSharingError('历史记录含私人skills，不能共享', 409);
  if (snapshot.styleGroupIds !== undefined && (!Array.isArray(snapshot.styleGroupIds) || snapshot.styleGroupIds.length)
    || snapshot.styleGroups !== undefined && (!Array.isArray(snapshot.styleGroups) || snapshot.styleGroups.length)) {
    throw new StudioSharingError('历史风格定义不能未经确认转换为共享模板', 409);
  }
  const raw = snapshot.templateFixedReferences ?? snapshot.fixedReferenceImages ?? [];
  if (!Array.isArray(raw)) throw new StudioSharingError('历史固定参考图无法读取', 409);
  const refs = parseStudioFixedReferences(raw.map(item => {
    if (!item || typeof item !== 'object') throw new StudioSharingError('历史固定参考图无法读取', 409);
    const value = item as Record<string, unknown>;
    return { assetId: value.assetId ?? value.id, note: typeof value.note === 'string' ? value.note : '' };
  }));
  const count = snapshot.templateFixedReferences !== undefined ? refs.length : snapshot.templateFixedCount === undefined ? refs.length : Number(snapshot.templateFixedCount);
  if (!Number.isInteger(count) || count < 0 || count > refs.length || count !== refs.length) throw new StudioSharingError('历史记录含未确认的风格参考图，不能共享', 409);
  return { version: 1, sourceOwnerId: actor.id, sourceTaskId: taskId, moduleContext: snapshot.moduleContext,
    globalContext: snapshot.globalContext, templateFixedReferences: refs };
}

type SharedStudioPersonalPatch = { personalOverrides?: unknown; resetFields?: unknown; referenceIds?: unknown; referencePolicy?: unknown };
// Shared personal text lives only in overrides; retain the legacy module text.
async function writeSharedStudioPersonalState(actor: ImageStudioIdentity,
  module: { id: string; reference_ids: string; reference_limit: number }, input: SharedStudioPersonalPatch, tx: SharedStudioClient) {
  const changes: Pick<Prisma.ImageStudioModuleUpdateManyMutationInput, 'reference_ids'> = {};
  if (has(input, 'personalOverrides') || has(input, 'resetFields')) {
    const overrides = await getSharedStudioPersonalOverrides(actor.id, module.id, tx);
    if (has(input, 'personalOverrides')) Object.assign(overrides, parseSharedStudioPersonalOverrides(input.personalOverrides));
    const reset = input.resetFields ?? [];
    if (!Array.isArray(reset) || reset.some(field => !overrideFields.includes(field))) throw new StudioSharingError('个人设置重置字段无效', 400);
    for (const field of reset as Array<typeof overrideFields[number]>) delete overrides[field];
    await writeSetting(tx, overridesKey(module.id), actor.id, { ownerId: actor.id, overrides });
  }
  if (has(input, 'referenceIds') || has(input, 'referencePolicy')) {
    const ids = has(input, 'referenceIds') ? referenceIds(input.referenceIds) : storedIds(module.reference_ids);
    const assets = await tx.asset.count({ where: { id: { in: ids }, owner_id: actor.id, status: 'active', type: 'image', AND: [await studioVisibleAssetWhere(actor, tx)] } });
    if (assets !== ids.length) throw new StudioSharingError('本次图片已不可用或无权使用', 403);
    if (has(input, 'referencePolicy')) {
      const policy = parseStudioReferencePolicy(input.referencePolicy, ids);
      const prior = await getStudioModuleReferencePolicy(actor.id, module.id, ids, module.reference_limit, tx);
      // Keep the personal selection valid; live generation limits still come from the source.
      await writeSetting(tx, `studio_reference_policy_v1:module:${actor.id}:${module.id}`, actor.id, { ownerId: actor.id,
        policy: { ...prior, primaryMax: Math.max(prior.primaryMax, policy.primaryIds.length), primaryIds: policy.primaryIds } });
    }
    if (has(input, 'referenceIds')) changes.reference_ids = JSON.stringify(ids);
  }
  return changes;
}

export type PublishSharedStudioModuleInput = Record<string, unknown> & { requestId: unknown; expectedRevision: unknown }
  & { [Field in keyof SharedStudioDefinitionPersonalInput]?: unknown };
export async function publishSharedStudioModule(user: ImageStudioIdentity, moduleId: string, input: PublishSharedStudioModuleInput, client?: SharedStudioClient) {
  return inTransaction(client, async tx => {
    const actor = await assertStudioActor(user.id, tx);
    const fingerprint = digest(['publish-shared', moduleId, input]);
    const receipt = await readReceipt(tx, actor.id, input.requestId, fingerprint);
    if (receipt) {
      const workspace = await tx.imageStudioModule.findFirst({ where: { id: moduleId, owner_id: actor.id } });
      if (!workspace) throw new StudioSharingError('原保存工作区已删除，不会重复发布', 409);
      return { module: workspace, presetId: String(receipt.presetId), receipt };
    }
    const workspace = await tx.imageStudioModule.findFirst({ where: { id: moduleId, owner_id: actor.id } });
    if (!workspace) throw new StudioSharingError('只能保存自己的模板', 403);
    if (!Number.isInteger(input.expectedRevision) || workspace.revision !== input.expectedRevision) throw new StudioSharingError('模板已在其他页面保存，当前草稿仍保留', 409);
    const binding = await studioSharedBinding(actor.id, moduleId, tx);
    if (binding && binding.mode !== 'publisher') throw new StudioSharingError('只能由创建者修改共享原模板', 403);
    if (!binding && input.isShared !== true) throw new StudioSharingError('请选择共享后再保存模板，个人输入不会自动公开', 400);
    if (has(input, 'isShared') && typeof input.isShared !== 'boolean') throw new StudioSharingError('模板共享设置无效', 400);
    if (!binding && workspace.source_preset_id) {
      const prior = await tx.imageStudioPreset.findUnique({ where: { id: workspace.source_preset_id } });
      if (!prior || prior.owner_id !== actor.id || !canViewStudioPreset(actor, prior) || await studioPresetArchived(prior.id, tx)) {
        throw new StudioSharingError('个人副本含他人的模板定义，不能另行共享内部配置', 403);
      }
    }
    const presetId = binding?.presetId || `module-source:${moduleId}`;
    const source = await tx.imageStudioPreset.findUnique({ where: { id: presetId } });
    if (source && (!binding || !canManageStudioPreset(actor, source))) throw new StudioSharingError('不能把个人副本绑定为已有原件的创建者', 403);
    if (source && await studioPresetArchived(presetId, tx)) throw new StudioSharingError('模板已删除，当前草稿仍保留', 409);
    if (source) {
      const expectedToken = input.expectedDefinitionToken ?? (input.sharedLive as Partial<SharedStudioIntent> | undefined)?.definitionToken;
      if (expectedToken !== await sharedDefinitionToken(source, tx)) throw new StudioSharingError('模板已更新，请重新打开设置核对；当前草稿仍保留', 409);
    }
    if (has(input, 'skillIds')) {
      if (!Array.isArray(input.skillIds) || input.skillIds.length) throw new StudioSharingError('skills仅自己可见，请移除后再共享模板', 409);
      await setSkillSelection(actor, moduleId, [], tx);
      if (source) await setSkillSelection(actor, presetId, [], tx, 'preset');
    }
    if ((await getSkillSelection(actor.id, moduleId, tx)).length || (source && (await getSkillSelection(actor.id, presetId, tx, 'preset')).length)) {
      throw new StudioSharingError('skills仅自己可见，请移除后再共享模板', 409);
    }
    let reproduction = source ? await reproductionForPreset(tx, actor.id, presetId) : undefined;
    if (has(input, 'reproduceFromTaskId') && (typeof input.reproduceFromTaskId !== 'string' || !input.reproduceFromTaskId || input.reproduceFromTaskId.length > 120)) {
      throw new StudioSharingError('共享复现定义必须保留合法的历史来源', 400);
    }
    const sourceTaskId = has(input, 'reproduceFromTaskId') ? input.reproduceFromTaskId as string : source ? reproduction?.sourceTaskId : workspace.reproduce_task_id;
    if (sourceTaskId && reproduction?.sourceTaskId !== sourceTaskId) reproduction = await historicalDefinition(actor, sourceTaskId, tx);
    const base = source || workspace;
    const stringField = (key: string, fallback: string, max: number, allowEmpty = true) => {
      const value = has(input, key) ? input[key] : fallback;
      if (typeof value !== 'string' || value.length > max || !allowEmpty && !value.trim()) throw new StudioSharingError('模板文字或名称无效', 400);
      return value;
    };
    const name = stringField('name', base.name, 80, false).trim();
    if (name === '未命名模块' || moduleId.startsWith('default-')) throw new StudioSharingError('请先完成模板名称，默认空模板不能共享', 400);
    const groupName = stringField('groupName', base.group_name || '未分组', 40).trim() || '未分组';
    if (has(input, 'prompt') && has(input, 'templatePrompt') && input.prompt !== input.templatePrompt) throw new StudioSharingError('模板提示词定义不一致', 400);
    const prompt = stringField(has(input, 'templatePrompt') ? 'templatePrompt' : 'prompt', base.prompt, 20000);
    const context = stringField('context', reproduction?.moduleContext ?? base.context, 20000);
    const settings = await getImageStudioSettings(tx);
    const model = (has(input, 'model') ? input.model : base.model || settings.model) as SharedStudioDefaults['model'];
    if (!IMAGE_STUDIO_MODELS.includes(model)) throw new StudioSharingError('模板模型无效', 400);
    const count = has(input, 'count') ? input.count : base.count;
    const referenceLimit = has(input, 'referenceLimit') ? input.referenceLimit : base.reference_limit;
    if (!Number.isInteger(count) || Number(count) < 1 || Number(count) > 8 || !Number.isInteger(referenceLimit) || Number(referenceLimit) < 1 || Number(referenceLimit) > MAX_REFERENCE_IMAGES) throw new StudioSharingError('模板张数或参考图数量无效', 400);
    const rawIds = has(input, 'referenceIds') ? referenceIds(input.referenceIds) : storedIds(base.reference_ids);
    const incomingPolicy = has(input, 'referencePolicy') ? parseStudioReferencePolicy(input.referencePolicy, rawIds)
      : source ? await getStudioPresetReferencePolicy(actor.id, presetId, rawIds, referenceLimit, tx)
      : await getStudioModuleReferencePolicy(actor.id, moduleId, rawIds, referenceLimit, tx);
    // Main images belong to the personal workspace, never the reusable definition.
    const templateIds = rawIds.filter(id => !incomingPolicy.primaryIds.includes(id));
    const referencePolicy = { ...incomingPolicy, primaryIds: [] };
    let fixedReferences: StudioFixedReference[];
    if (has(input, 'fixedReferences')) {
      if (actor.role !== 'admin') throw new StudioSharingError('固定模板图只能由管理员修改', 403);
      fixedReferences = parseStudioFixedReferences(input.fixedReferences);
    } else fixedReferences = reproduction?.templateFixedReferences ?? (source ? await getStudioPresetFixedReferences(actor, source, tx) : await getStudioModuleFixedReferences(actor.id, moduleId, tx));
    const styleGroupIds = has(input, 'styleGroupIds') ? parseStudioStyleIds(input.styleGroupIds) : await getStudioModuleStyleIds(actor.id, source ? presetId : moduleId, tx, source ? 'preset' : 'module');
    const styles = await resolveStudioStyleReferences(actor, styleGroupIds, tx);
    validateStudioReferenceCounts(referencePolicy, templateIds, fixedReferences.length, styles.references.length);
    const bannerAssetId = has(input, 'bannerAssetId') ? input.bannerAssetId : base.banner_asset_id;
    if (bannerAssetId !== null && (typeof bannerAssetId !== 'string' || bannerAssetId.length > 100)) throw new StudioSharingError('模板封面无效', 400);
    const ownedIds = Array.from(new Set([...templateIds, ...fixedReferences.map(ref => ref.assetId), ...(bannerAssetId ? [bannerAssetId] : [])]));
    const assets = await tx.asset.findMany({ where: { id: { in: ownedIds }, owner_id: actor.id, status: 'active', type: 'image' }, select: { id: true } });
    if (assets.length !== ownedIds.length) throw new StudioSharingError('模板引用图片不存在或不属于创建者', 403);
    const publicIds = [...templateIds, ...(bannerAssetId ? [bannerAssetId] : [])];
    const readable = await tx.asset.count({ where: { id: { in: publicIds }, AND: [await studioVisibleAssetWhere(actor, tx)] } });
    if (readable !== new Set(publicIds).size) throw new StudioSharingError('模板引用包含不可查看的私人图片', 403);
    if (reproduction) {
      const globalContext = stringField('globalContext', reproduction.globalContext, 20000);
      if (has(input, 'globalContext') && actor.role !== 'admin') throw new StudioSharingError('通用上下文只能由管理员修改', 403);
      reproduction = { ...reproduction, moduleContext: context, globalContext, templateFixedReferences: fixedReferences };
      await writeSetting(tx, studioSharedReproductionKey(presetId), actor.id, reproduction);
    } else if (has(input, 'globalContext')) throw new StudioSharingError('普通模板不能写入通用上下文', 400);
    const data = { name, group_name: groupName, prompt, context, model, quality: normalizeImageStudioQuality(model, has(input, 'quality') ? input.quality : base.quality),
      resolution: normalizeImageResolution(model, has(input, 'resolution') ? input.resolution : base.resolution), count: Number(count), reference_limit: Number(referenceLimit),
      aspect_ratio: sharedRatio(has(input, 'aspectRatio') ? input.aspectRatio : base.aspect_ratio), banner_asset_id: bannerAssetId,
      reference_ids: JSON.stringify(templateIds), is_shared: has(input, 'isShared') ? input.isShared === true : source?.is_shared ?? true };
    if (source) {
      const changed = await tx.imageStudioPreset.updateMany({ where: { id: presetId, owner_id: actor.id, updated_at: source.updated_at },
        data: { ...data, updated_at: new Date(Math.max(Date.now(), source.updated_at.getTime() + 1)) } });
      if (changed.count !== 1) throw new StudioSharingError('模板已在其他页面保存，当前草稿仍保留', 409);
    } else {
      if (has(input, 'scope') && !['admin', 'creator'].includes(String(input.scope))) throw new StudioSharingError('模板类型无效', 400);
      const scope = input.scope === 'creator' ? 'creator' : actor.role === 'admin' ? 'admin' : 'creator';
      if (input.scope === 'admin' && actor.role !== 'admin') throw new StudioSharingError('没有管理员模板保存权限', 403);
      await tx.imageStudioPreset.create({ data: { id: presetId, owner_id: actor.id, scope, ...data } });
    }
    await setStudioPresetFixedReferences(actor.id, presetId, fixedReferences, tx);
    await setStudioPresetReferencePolicy(actor.id, presetId, referencePolicy, templateIds, tx);
    await setStudioPresetStyleIds(actor, presetId, styleGroupIds, tx);
    const personalChanges = await writeSharedStudioPersonalState(actor, workspace, {
      ...(has(input, 'personalOverrides') ? { personalOverrides: input.personalOverrides } : {}),
      ...(has(input, 'resetFields') ? { resetFields: input.resetFields } : {}),
      ...(has(input, 'personalReferenceIds') ? { referenceIds: input.personalReferenceIds } : {}),
      ...(has(input, 'personalReferencePolicy') ? { referencePolicy: input.personalReferencePolicy } : {}),
    }, tx);
    const changed = await tx.imageStudioModule.updateMany({ where: { id: moduleId, owner_id: actor.id, revision: workspace.revision },
      data: { ...personalChanges, source_preset_id: presetId, revision: workspace.revision + 1 } });
    if (changed.count !== 1) throw new StudioSharingError('模板已在其他页面保存，当前草稿仍保留', 409);
    await bindStudioModule(tx, moduleId, { protocol: SHARED_STUDIO_PROTOCOL, ownerId: actor.id, presetId, mode: 'publisher' });
    await restoreStudioDefaultGroup(actor.id, groupName, tx);
    const { definition } = await resolveSharedStudioDefinition(actor, presetId, tx);
    const result = { moduleId, presetId, beforeRevision: workspace.revision, revision: workspace.revision + 1,
      sourceRevision: definition.sourceRevision, definitionToken: definition.intent.definitionToken };
    await writeReceipt(tx, actor.id, input.requestId, fingerprint, result);
    return { module: await tx.imageStudioModule.findUniqueOrThrow({ where: { id: moduleId } }), presetId, receipt: result };
  });
}

export async function saveSharedStudioPresetAs(user: ImageStudioIdentity, input: Record<string, unknown>): Promise<ImageStudioPreset & { publisherModuleId: string }> {
  return inTransaction(undefined, async tx => {
    const actor = await assertStudioActor(user.id, tx);
    const fingerprint = digest(['save-as-shared-preset', input]);
    const receipt = await readReceipt(tx, actor.id, input.requestId, fingerprint);
    // Replay before checking the original revision: the first save may have promoted it.
    if (receipt) {
      const publisherModuleId = String(receipt.moduleId);
      const preset = await tx.imageStudioPreset.findUnique({ where: { id: String(receipt.presetId) } });
      const workspace = await tx.imageStudioModule.findFirst({ where: { id: publisherModuleId, owner_id: actor.id } });
      if (!preset || !canManageStudioPreset(actor, preset) || !workspace || workspace.source_preset_id !== preset.id
        || await studioPresetArchived(preset.id, tx) || await studioPublisherModule(actor.id, preset.id, tx) !== publisherModuleId) {
        throw new StudioSharingError('原保存模板或工作区已不可用，不会重复创建', 409);
      }
      return { ...preset, publisherModuleId };
    }
    if (input.isShared !== true) throw new StudioSharingError('请选择共享后再保存模板', 400);
    const sourceModuleId = typeof input.sourceModuleId === 'string' ? input.sourceModuleId : undefined;
    const original = sourceModuleId ? await tx.imageStudioModule.findFirst({ where: { id: sourceModuleId, owner_id: actor.id } }) : null;
    if (sourceModuleId && !original) throw new StudioSharingError('模板来源模块不存在或无权使用', 403);
    let publisherModuleId = original?.id || automaticStudioModuleId(actor.id, `new-preset:${String(input.requestId)}`);
    let expectedRevision: unknown = input.moduleRevision ?? input.expectedRevision;
    let expectedDefinitionToken: unknown = input.expectedDefinitionToken;
    if (original && (!Number.isInteger(expectedRevision) || original.revision !== expectedRevision)) {
      throw new StudioSharingError('模板已在其他页面保存，当前草稿仍保留', 409);
    }
    const binding = original ? await studioSharedBinding(actor.id, original.id, tx) : null;
    if (original && binding) {
      if (binding.mode !== 'publisher' || original.source_preset_id !== binding.presetId) throw new StudioSharingError('只能由创建者另存共享原模板', 403);
      const source = await tx.imageStudioPreset.findUnique({ where: { id: binding.presetId } });
      if (!source || !canManageStudioPreset(actor, source) || await studioPublisherModule(actor.id, source.id, tx) !== original.id) {
        throw new StudioSharingError('原模板创建者身份无法确认', 403);
      }
      const { definition } = await resolveSharedStudioDefinition(actor, source.id, tx);
      if (expectedDefinitionToken !== definition.intent.definitionToken) throw new StudioSharingError('模板已更新，请重新打开设置核对；当前草稿仍保留', 409);
      if (['personalOverrides', 'resetFields', 'personalReferenceIds', 'personalReferencePolicy'].some(field => has(input, field))) {
        throw new StudioSharingError('另存共享模板不包含个人输入和主图，请在原工作区保存这些内容', 400);
      }
      const scope = has(input, 'scope') ? input.scope : source.scope;
      if (!['admin', 'creator'].includes(String(scope)) || scope === 'admin' && actor.role !== 'admin') throw new StudioSharingError('没有保存该模板类型的权限', 403);
      publisherModuleId = automaticStudioModuleId(actor.id, `save-as-shared:${String(input.requestId)}`);
      const presetId = `module-source:${publisherModuleId}`;
      if (await tx.imageStudioModule.findUnique({ where: { id: publisherModuleId } }) || await tx.imageStudioPreset.findUnique({ where: { id: presetId } })) {
        throw new StudioSharingError('另存模板编号已占用，请核对原保存结果', 409);
      }
      // Seed only the owned definition, never the original workspace's personal fields.
      await tx.imageStudioModule.create({ data: { id: publisherModuleId, owner_id: actor.id, source_preset_id: presetId,
        name: definition.name, group_name: definition.groupName, revision: 1 } });
      const copied = await tx.imageStudioPreset.create({ data: { id: presetId, owner_id: actor.id, scope: String(scope), is_shared: true,
        name: definition.name, group_name: definition.groupName, prompt: definition.templatePrompt, context: definition.context,
        model: source.model, quality: source.quality, resolution: source.resolution, count: source.count,
        reference_limit: source.reference_limit, aspect_ratio: source.aspect_ratio, banner_asset_id: definition.bannerAssetId,
        reference_ids: JSON.stringify(definition.templateReferenceIds) } });
      if (definition.reproduction) await writeSetting(tx, studioSharedReproductionKey(presetId), actor.id, definition.reproduction);
      await setStudioPresetFixedReferences(actor.id, presetId, definition.fixedReferences, tx);
      await setStudioPresetReferencePolicy(actor.id, presetId, definition.referencePolicy, definition.templateReferenceIds, tx);
      await setStudioPresetStyleIds(actor, presetId, definition.styleGroupIds, tx);
      await bindStudioModule(tx, publisherModuleId, { protocol: SHARED_STUDIO_PROTOCOL, ownerId: actor.id, presetId, mode: 'publisher' });
      expectedRevision = 1;
      expectedDefinitionToken = await sharedDefinitionToken(copied, tx);
    } else if (!original) {
      if (await tx.imageStudioModule.findUnique({ where: { id: publisherModuleId } })) throw new StudioSharingError('另存模板工作区已存在，请核对原保存结果', 409);
      await tx.imageStudioModule.create({ data: { id: publisherModuleId, owner_id: actor.id,
        name: typeof input.name === 'string' ? input.name : '未命名模块', revision: 1 } });
      expectedRevision = 1;
    }
    const published = await publishSharedStudioModule(actor, publisherModuleId, { ...input,
      requestId: `save-as-definition:${digest([input.requestId, publisherModuleId])}`, expectedRevision, expectedDefinitionToken }, tx);
    await writeReceipt(tx, actor.id, input.requestId, fingerprint, published.receipt);
    return { ...await tx.imageStudioPreset.findUniqueOrThrow({ where: { id: published.presetId } }), publisherModuleId };
  });
}

export async function replaceSharedStudioPreset(user: ImageStudioIdentity, presetId: string, input: Record<string, unknown>) {
  return inTransaction(undefined, async tx => {
    const actor = await assertStudioActor(user.id, tx);
    const fingerprint = digest(['replace-preset', presetId, input]);
    const receipt = await readReceipt(tx, actor.id, input.requestId, fingerprint);
    if (receipt) return tx.imageStudioPreset.findUniqueOrThrow({ where: { id: presetId } });
    const source = await tx.imageStudioPreset.findUnique({ where: { id: presetId } });
    if (!source || !canManageStudioPreset(actor, source)) throw new StudioSharingError('只能修改自己的模板', 403);
    if (input.revision !== source.updated_at.toISOString()) throw new StudioSharingError('模板已在其他页面保存，当前草稿仍保留', 409);
    const definitionToken = await sharedDefinitionToken(source, tx);
    if (input.expectedDefinitionToken !== undefined && input.expectedDefinitionToken !== definitionToken) throw new StudioSharingError('模板依赖已更新，当前草稿仍保留', 409);
    const workspace = await openSharedStudioModule(actor, presetId, `replace-open:${digest([input.requestId, presetId])}`, tx);
    const published = await publishSharedStudioModule(actor, workspace.id, { ...input, requestId: `replace-definition:${digest([input.requestId, presetId])}`,
      expectedRevision: workspace.revision, expectedDefinitionToken: definitionToken }, tx);
    await writeReceipt(tx, actor.id, input.requestId, fingerprint, published.receipt);
    return tx.imageStudioPreset.findUniqueOrThrow({ where: { id: presetId } });
  });
}

export async function saveSharedStudioPersonal(user: ImageStudioIdentity, moduleId: string, body: Record<string, unknown>) {
  return inTransaction(undefined, async tx => {
    const actor = await assertStudioActor(user.id, tx);
    const fingerprint = digest(['save-personal', moduleId, body]);
    const receipt = await readReceipt(tx, actor.id, body.requestId, fingerprint);
    if (receipt) {
      const row = await tx.imageStudioModule.findFirst({ where: { id: moduleId, owner_id: actor.id } });
      if (!row) throw new StudioSharingError('原保存工作区已删除', 409);
      return row;
    }
    const binding = await studioSharedBinding(actor.id, moduleId, tx);
    if (!binding) throw new StudioSharingError('该模块不是实时共享工作区', 400);
    const workspace = await tx.imageStudioModule.findFirst({ where: { id: moduleId, owner_id: actor.id } });
    if (!workspace || workspace.revision !== body.revision) throw new StudioSharingError('个人设置已在其他页面保存，当前草稿仍保留', 409);
    const forbidden = ['sourcePresetId', 'source_preset_id', 'ownerId', 'owner_id', 'templatePrompt', 'context', 'globalContext', 'fixedReferences', 'styleGroupIds', 'skillIds', 'isShared'];
    if (forbidden.some(field => has(body, field))) throw new StudioSharingError('个人保存不能修改共享模板定义', 403);
    const personalChanges = await writeSharedStudioPersonalState(actor, workspace, body, tx);
    const changed = await tx.imageStudioModule.updateMany({ where: { id: moduleId, owner_id: actor.id, revision: workspace.revision },
      data: { ...personalChanges, revision: workspace.revision + 1 } });
    if (changed.count !== 1) throw new StudioSharingError('个人设置已在其他页面保存，当前草稿仍保留', 409);
    await writeReceipt(tx, actor.id, body.requestId, fingerprint, { moduleId, revision: workspace.revision + 1 });
    return tx.imageStudioModule.findUniqueOrThrow({ where: { id: moduleId } });
  });
}

export async function getStudioRemovedDefaultGroups(ownerId: string, client: SharedStudioClient = prisma): Promise<string[]> {
  const row = await client.platformSetting.findUnique({ where: { key: removedGroupsKey(ownerId) }, select: { value_json: true } });
  if (!row) return [];
  const value = parseRecord(row.value_json, '分组选项无法读取');
  if (value.ownerId !== ownerId || !Array.isArray(value.groups) || value.groups.some(group => !defaultGroups.includes(group))) throw new StudioSharingError('分组选项无法确认', 409);
  return value.groups as string[];
}
export async function restoreStudioDefaultGroup(ownerId: string, groupName: string, client: SharedStudioClient) {
  if (!defaultGroups.includes(groupName)) return;
  const groups = await getStudioRemovedDefaultGroups(ownerId, client);
  if (groups.includes(groupName)) await writeSetting(client, removedGroupsKey(ownerId), ownerId, { ownerId, groups: groups.filter(group => group !== groupName) });
}
export async function deleteStudioGroup(user: ImageStudioIdentity, body: Record<string, unknown>) {
  const groupName = typeof body.groupName === 'string' ? body.groupName.trim() : '';
  if (!groupName || groupName === '未分组' || groupName.length > 40 || !Array.isArray(body.expectedMembers)) throw new StudioSharingError('分组删除参数无效', 400);
  const expected = body.expectedMembers as Array<{ id: string; revision: number }>;
  if (expected.some(member => !member || typeof member.id !== 'string' || !Number.isInteger(member.revision)) || new Set(expected.map(member => member.id)).size !== expected.length) throw new StudioSharingError('分组成员核对参数无效', 400);
  return inTransaction(undefined, async tx => {
    const actor = await assertStudioActor(user.id, tx);
    const fingerprint = digest(['delete-group', groupName, [...expected].sort((a, b) => a.id.localeCompare(b.id))]);
    const receipt = await readReceipt(tx, actor.id, body.requestId, fingerprint);
    if (receipt) return receipt;
    const rows = await tx.imageStudioModule.findMany({ where: { owner_id: actor.id } });
    const members: typeof rows = [];
    for (const row of rows) {
      const binding = await studioSharedBinding(actor.id, row.id, tx);
      if (binding?.mode === 'live') continue;
      if (binding) {
        const source = await tx.imageStudioPreset.findUnique({ where: { id: binding.presetId } });
        if (!source || !canManageStudioPreset(actor, source) || await studioPresetArchived(source.id, tx)) continue;
        if (source.group_name === groupName) members.push(row);
      } else if (row.group_name === groupName) members.push(row);
    }
    if (expected.length !== members.length || members.some(row => !expected.some(member => member.id === row.id && member.revision === row.revision))) {
      throw new StudioSharingError('分组内容已变化，请重新打开后删除；原内容未改', 409);
    }
    for (const row of members) {
      const binding = await studioSharedBinding(actor.id, row.id, tx);
      if (binding?.mode === 'publisher') {
        const source = await tx.imageStudioPreset.findUniqueOrThrow({ where: { id: binding.presetId } });
        const changed = await tx.imageStudioPreset.updateMany({ where: { id: source.id, owner_id: actor.id, updated_at: source.updated_at },
          data: { group_name: '未分组', updated_at: new Date(Math.max(Date.now(), source.updated_at.getTime() + 1)) } });
        if (changed.count !== 1) throw new StudioSharingError('共享模板已变化，分组未删除', 409);
      }
      const changed = await tx.imageStudioModule.updateMany({ where: { id: row.id, owner_id: actor.id, revision: row.revision }, data: { group_name: '未分组', revision: row.revision + 1 } });
      if (changed.count !== 1) throw new StudioSharingError('分组内容已变化，分组未删除', 409);
    }
    const removedDefaultGroups = await getStudioRemovedDefaultGroups(actor.id, tx);
    if (defaultGroups.includes(groupName) && !removedDefaultGroups.includes(groupName)) removedDefaultGroups.push(groupName);
    await writeSetting(tx, removedGroupsKey(actor.id), actor.id, { ownerId: actor.id, groups: removedDefaultGroups });
    const result = { deleted: true, groupName, movedModuleIds: members.map(row => row.id), removedDefaultGroups };
    await writeReceipt(tx, actor.id, body.requestId, fingerprint, result);
    return result;
  });
}

async function sharedDependencyState(rows: Array<{ id: string; owner_id: string; reference_ids: string; banner_asset_id: string | null }>, client: SharedStudioClient) {
  const keys = rows.flatMap(row => [
    `studio_fixed_references_v1:preset:${row.id}`, `studio_reference_policy_v1:preset:${row.owner_id}:${row.id}`,
    `studio_style_preset_selection_v1:${row.id}`, `studio_skill_selection_v1:preset:${row.id}`, studioSharedReproductionKey(row.id),
  ]);
  const dependencies = await client.platformSetting.findMany({ where: { key: { in: keys } }, select: { key: true, value_json: true }, orderBy: { key: 'asc' } });
  const styleIds = new Set<string>();
  const assetIds = new Set<string>();
  for (const row of rows) {
    if (row.banner_asset_id) assetIds.add(row.banner_asset_id);
    try { for (const id of storedIds(row.reference_ids)) assetIds.add(id); } catch { /* The full resolver supplies the unavailable reason. */ }
  }
  const collectReferences = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const reference of value) if (reference && typeof reference.assetId === 'string') assetIds.add(reference.assetId);
  };
  for (const row of dependencies) {
    try {
      const value = JSON.parse(row.value_json);
      if (row.key.startsWith('studio_style_preset_selection_v1:') && Array.isArray(value?.ids)) for (const id of value.ids) if (typeof id === 'string') styleIds.add(id);
      collectReferences(value?.references);
      collectReferences(value?.templateFixedReferences);
    } catch { /* Corrupt settings remain in the token and fail closed in the resolver. */ }
  }
  const styles = await client.platformSetting.findMany({ where: { key: { in: Array.from(styleIds, id => `studio_style_group_v1:${id}`) } }, select: { key: true, value_json: true }, orderBy: { key: 'asc' } });
  for (const row of styles) {
    try { const value = JSON.parse(row.value_json); collectReferences(value?.references); }
    catch { /* No public body is derived from this metadata pass. */ }
  }
  const dependencyAssets = await client.asset.findMany({ where: { id: { in: Array.from(assetIds) } }, select: { id: true, owner_id: true, status: true, type: true,
    original_url: true, thumbnail_url: true, hash: true, width: true, height: true, file_size: true, mime_type: true }, orderBy: { id: 'asc' } });
  return { dependencies, styles, dependencyAssets };
}
async function sharedDefinitionToken(source: ImageStudioPreset, client: SharedStudioClient) {
  // Raw dependency identity remains computable when an author needs to repair an unavailable definition.
  return digest({ source, ...await sharedDependencyState([source], client) });
}
async function sharedCatalogState(user: ImageStudioIdentity, client: SharedStudioClient) {
  const actor = await assertStudioActor(user.id, client);
  const rows = await client.imageStudioPreset.findMany({ where: { OR: [{ owner_id: actor.id }, { is_shared: true }] }, orderBy: { id: 'asc' },
    select: { id: true, owner_id: true, scope: true, is_shared: true, name: true, group_name: true, banner_asset_id: true, reference_ids: true, updated_at: true } });
  const archived = await client.platformSetting.findMany({ where: { key: { in: rows.map(row => archivedPresetKey(row.id)) } }, select: { key: true } });
  const archivedKeys = new Set(archived.map(row => row.key));
  const visible = rows.filter(row => row.is_shared && canViewStudioPreset(actor, row) && !archivedKeys.has(archivedPresetKey(row.id)));
  const { dependencies, styles, dependencyAssets } = await sharedDependencyState(visible, client);
  const visibleAssets = await studioVisibleAssetWhere(actor, client);
  const bannerIds = visible.flatMap(row => row.banner_asset_id ? [row.banner_asset_id] : []);
  const assets = await client.asset.findMany({ where: { id: { in: bannerIds }, status: 'active', type: 'image', AND: [visibleAssets] }, select: { id: true, owner_id: true, width: true, height: true }, orderBy: { id: 'asc' } });
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  const catalogRevision = digest([actor.id, actor.role, actor.account_type, actor.feature_profile_id,
    visible.map(row => ({ id: row.id, ownerId: row.owner_id, scope: row.scope, shared: row.is_shared, name: row.name, group: row.group_name,
      banner: row.banner_asset_id, revision: row.updated_at })), dependencies, styles, dependencyAssets, visibleAssets, assets]);
  return { actor, visible, byId, catalogRevision };
}
export async function listSharedStudioCatalog(user: ImageStudioIdentity, options: { cursor?: string; catalogRevision?: string } = {}, client: SharedStudioClient = prisma): Promise<SharedStudioCatalog> {
  if (client === prisma) return prisma.$transaction(tx => listSharedStudioCatalog(user, options, tx), { timeout: 15000 });
  const { actor, visible, byId, catalogRevision } = await sharedCatalogState(user, client);
  if (options.catalogRevision && options.catalogRevision !== catalogRevision) throw new StudioSharingError('共享目录已变化，请重新读取', 409);
  if (options.cursor && (!options.catalogRevision || !visible.some(row => row.id === options.cursor))) throw new StudioSharingError('共享目录已变化，请重新读取', 409);
  const remaining = options.cursor ? visible.filter(row => row.id > options.cursor!) : visible;
  const page = remaining.slice(0, 100);
  const items: SharedStudioCatalogItem[] = await Promise.all(page.map(async row => {
    const asset = row.banner_asset_id ? byId.get(row.banner_asset_id) : null;
    let available = true;
    try { await resolveSharedStudioDefinition(actor, row.id, client); }
    catch (error) { if (!(error instanceof StudioSharingError) || ![403, 404, 409].includes(error.status)) throw error; available = false; }
    return { presetId: row.id, name: row.name, groupName: row.group_name || '未分组', revision: row.updated_at.toISOString(), available,
      banner: asset && asset.owner_id === row.owner_id ? { id: asset.id, originalUrl: studioTemplateAssetUrl(asset.id), thumbnailUrl: studioTemplateAssetUrl(asset.id, true), width: asset.width, height: asset.height } : null };
  }));
  return { items, nextCursor: remaining.length > 100 ? page[page.length - 1].id : null, catalogRevision };
}
export async function sharedStudioRevision(user: ImageStudioIdentity, activePresetId?: string) {
  return prisma.$transaction(async tx => {
    const catalog = await sharedCatalogState(user, tx);
    let activeDefinitionToken: string | null = null;
    let activeAvailable = false;
    if (activePresetId) {
      try { activeDefinitionToken = (await resolveSharedStudioDefinition(user, activePresetId, tx)).definition.intent.definitionToken; activeAvailable = true; }
      catch (error) {
        if (!(error instanceof StudioSharingError) || ![403, 404, 409].includes(error.status)) throw error;
        activeDefinitionToken = error.intent?.definitionToken ?? null;
      }
    }
    return { catalogRevision: catalog.catalogRevision, activeDefinitionToken, activeAvailable };
  }, { timeout: 15000 });
}
