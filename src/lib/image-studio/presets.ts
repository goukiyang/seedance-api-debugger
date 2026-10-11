import { randomUUID } from 'crypto';
import { resolveModuleContextVersion } from './context-version';
import { archivedPresetKey, studioPresetArchived } from './preset-lifecycle';
import { prisma } from '@/lib/prisma';
import { evolutionCapability, type EvolutionCapability } from './evolution';
import { DEFAULT_STUDIO_PRIMARY_MAX, MAX_REFERENCE_IMAGES } from './limits';
import { IMAGE_STUDIO_MODELS, defaultImageResolution, normalizeImageStudioQuality, normalizeImageResolution } from './model-catalog';
import { normalizeStudioRatio } from './ratios';
import { studioModuleDTOForUser, StudioModuleError, validStudioModuleId } from './modules';
import { canManageStudioPreset, canUseCompanyTemplates as canUseCompanyTemplatesForUser, canViewStudioPreset, type ImageStudioIdentity } from './access';
import { studioTemplateAssetUrl } from './media';
import { getStudioModuleFixedReferences, getStudioPresetsFixedReferences, getStudioPresetFixedReferences, parseStudioFixedReferences, setStudioModuleFixedReferences, setStudioPresetFixedReferences, type StudioFixedReference } from './fixed-references';
import { studioVisibleAssetWhere } from './protected-assets';
import { getStudioModuleStyleIds, parseStudioStyleIds, resolveStudioStyleReferences, setStudioModuleStyleIds, setStudioPresetStyleIds } from './style-groups';
import { cloneHistoricalSkills, getSkillSelection, parseSkillIds, resolveSkills, setSkillSelection } from './skills';
import { defaultStudioReferencePolicy, getStudioPresetReferencePolicy, parseStudioReferencePolicy, setStudioModuleReferencePolicy, setStudioPresetReferencePolicy, validateStudioReferenceCounts, StudioReferencePolicyError, type StudioReferencePolicy } from './reference-policy';
import { assertStudioActor, saveSharedStudioPresetAs, replaceSharedStudioPreset, resolveSharedStudioDefinition, restoreStudioDefaultGroup, studioPublisherModule, studioSharedBinding, StudioSharingError } from './shared-contract';

export { canUseCompanyTemplatesForUser as canUseCompanyTemplates };

type PresetDraft = {
  scope?: unknown; name?: unknown; groupName?: unknown; prompt?: unknown; context?: unknown;
  model?: unknown; quality?: unknown; resolution?: unknown; count?: unknown; aspectRatio?: unknown;
  bannerAssetId?: unknown; referenceIds?: unknown; referenceLimit?: unknown; sourceModuleId?: unknown; fixedReferences?: unknown;
  styleGroupIds?: unknown; skillIds?: unknown; referencePolicy?: unknown;
  presetId?: unknown; revision?: unknown;
  reproduceFromTaskId?: unknown;
  isShared?: unknown; requestId?: unknown; moduleRevision?: unknown; expectedRevision?: unknown; expectedDefinitionToken?: unknown; templatePrompt?: unknown;
  personalOverrides?: unknown; resetFields?: unknown; personalReferenceIds?: unknown; personalReferencePolicy?: unknown;
};

function parseIds(value: unknown) {
  if (!Array.isArray(value) || value.length > MAX_REFERENCE_IMAGES || value.some(item => typeof item !== 'string' || !item)) {
    throw new StudioModuleError(`模板参考图片无效（最多 ${MAX_REFERENCE_IMAGES} 张）`);
  }
  return value as string[];
}

function parsePreset(row: { reference_ids: string }) {
  try { return parseIds(JSON.parse(row.reference_ids)); } catch { return []; }
}

const quickPresetKey = (moduleId: string) => `studio_quick_presets_v1:${moduleId}`;
function decodeQuickPresetIds(value: string | undefined, ownerId: string): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (parsed.ownerId !== ownerId || !Array.isArray(parsed.ids) || parsed.ids.some((id: unknown) => typeof id !== 'string')) throw new Error();
    return parsed.ids;
  } catch { throw new StudioModuleError('快捷模板无法读取，请重试', 503); }
}

export async function listStudioPresets(user: ImageStudioIdentity, moduleId?: string, presetId?: string) {
  user = await assertStudioActor(user.id);
  if (presetId !== undefined) {
    const { publicDTO } = await resolveSharedStudioDefinition(user, presetId);
    return [{ id: publicDTO.presetId, ...publicDTO, ...publicDTO.defaults, prompt: publicDTO.templatePrompt, sourcePresetId: publicDTO.presetId,
      scope: (await prisma.imageStudioPreset.findUniqueOrThrow({ where: { id: presetId }, select: { scope: true } })).scope,
      referencesAvailable: true, fixedReferencesEditable: user.role === 'admin' && publicDTO.ownedByViewer,
      skillIds: [], moduleContextVersion: await resolveModuleContextVersion(publicDTO.context).catch(() => null) }];
  }
  let quickIds: string[] | undefined;
  if (moduleId !== undefined) {
    if (!validStudioModuleId(moduleId, user.id)) throw new StudioModuleError('模块不存在或无权使用', 404);
    const workspace = await prisma.imageStudioModule.findFirst({ where: { id: moduleId, owner_id: user.id }, select: { source_preset_id: true } });
    if (!workspace) throw new StudioModuleError('模块不存在或无权使用', 404);
    const stored = await prisma.platformSetting.findUnique({ where: { key: quickPresetKey(moduleId) }, select: { value_json: true } });
    quickIds = Array.from(new Set([...decodeQuickPresetIds(stored?.value_json, user.id), ...(workspace.source_preset_id ? [workspace.source_preset_id] : [])]));
  }
  const rows = await prisma.imageStudioPreset.findMany({
    where: { OR: [{ owner_id: user.id }, { is_shared: true }], ...(quickIds ? { id: { in: quickIds }, owner_id: user.id } : {}) },
    orderBy: [{ scope: 'asc' }, { updated_at: 'desc' }],
  });
  const archived = await prisma.platformSetting.findMany({ where: { key: { in: rows.map(row => archivedPresetKey(row.id)) } }, select: { key: true } });
  const archivedKeys = new Set(archived.map(item => item.key));
  const visibleRows = rows.filter(row => canViewStudioPreset(user, row) && !archivedKeys.has(archivedPresetKey(row.id)));
  const privateRows = visibleRows.filter(row => !row.is_shared);
  const fixedByPreset = await getStudioPresetsFixedReferences(user, privateRows);
  const referencePolicies = await Promise.all(privateRows.map(async row => [row.id, await getStudioPresetReferencePolicy(row.owner_id, row.id, parsePreset(row), row.reference_limit)] as const));
  const policyByPreset = new Map(referencePolicies);
  const styleIdsByPreset = moduleId === undefined ? new Map<string, string[]>() : new Map(await Promise.all(privateRows.map(async row =>
    [row.id, await getStudioModuleStyleIds(row.owner_id, row.id, prisma, 'preset')] as const)));
  const reusableIds = (row: typeof visibleRows[number]) => parsePreset(row).filter(id => !policyByPreset.get(row.id)?.primaryIds.includes(id));
  const assetIds = privateRows.flatMap(row => [...reusableIds(row), ...(fixedByPreset.get(row.id) || []).map(reference => reference.assetId)]);
  const bannerIds = privateRows.map(row => row.banner_asset_id).filter((id): id is string => Boolean(id));
  const assets = await prisma.asset.findMany({ where: { id: { in: Array.from(new Set([...assetIds, ...bannerIds])) }, status: 'active', type: 'image', AND: [await studioVisibleAssetWhere(user)] }, select: { id: true, owner_id: true, original_url: true, thumbnail_url: true, width: true, height: true } });
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  return Promise.all(visibleRows.map(async row => {
    if (row.is_shared) {
      try {
        const { publicDTO } = await resolveSharedStudioDefinition(user, row.id);
        return { id: row.id, scope: row.scope, ...publicDTO, ...publicDTO.defaults, prompt: publicDTO.templatePrompt,
          sourcePresetId: row.id, referencesAvailable: true, skillIds: [],
          moduleContextVersion: await resolveModuleContextVersion(publicDTO.context).catch(() => null), createdAt: row.created_at, updatedAt: row.updated_at };
      } catch (error) {
        if (!(error instanceof StudioSharingError) || ![403, 404, 409].includes(error.status)) throw error;
        return { id: row.id, name: row.name, scope: row.scope, groupName: row.group_name, revision: row.updated_at.toISOString(), model: row.model,
          isShared: row.is_shared, ownedByViewer: row.owner_id === user.id, canManageSharing: canManageStudioPreset(user, row),
          unavailable: true, unavailableReason: error.message, prompt: '', context: '', contextConfigured: false, referencesAvailable: false,
          images: [], banner: null, fixedReferences: [], fixedReferenceCount: 0, skillIds: [] };
      }
    }
    const ids = reusableIds(row);
    const visibleIds = ids.filter(id => {
      const asset = byId.get(id);
      return Boolean(asset && asset.owner_id === row.owner_id);
    });
    const storedPolicy = policyByPreset.get(row.id);
    const referencePolicy = storedPolicy
      ? { ...storedPolicy, primaryIds: [] }
      : undefined;
    const canSeeContext = user.role === 'admin' || row.owner_id === user.id;
    const toPayload = (id: string) => {
      const asset = byId.get(id);
      if (!asset || asset.owner_id !== row.owner_id) return null;
      return { id, originalUrl: studioTemplateAssetUrl(id), thumbnailUrl: studioTemplateAssetUrl(id, true), width: asset.width, height: asset.height };
    };
    return {
      id: row.id, name: row.name, scope: row.scope, groupName: row.group_name, prompt: row.prompt, context: canSeeContext ? row.context : '', revision: row.updated_at.toISOString(),
      isShared: row.is_shared,
      moduleContextVersion: await resolveModuleContextVersion(row.context).catch(() => null),
      ownedByViewer: row.owner_id === user.id,
      referencesAvailable: visibleIds.length === ids.length && (fixedByPreset.get(row.id) || []).every(reference => byId.get(reference.assetId)?.owner_id === row.owner_id),
      canManageSharing: canManageStudioPreset(user, row),
      model: row.model, quality: normalizeImageStudioQuality(row.model, row.quality), resolution: normalizeImageResolution(row.model, row.resolution || defaultImageResolution(row.model)), count: row.count, referenceLimit: Math.max(1, Math.min(MAX_REFERENCE_IMAGES, Number(row.reference_limit) || DEFAULT_STUDIO_PRIMARY_MAX)), referencePolicy,
      aspectRatio: row.aspect_ratio, contextConfigured: Boolean(row.context.trim()),
      ...(moduleId !== undefined ? { styleGroupIds: styleIdsByPreset.get(row.id) || [] } : {}),
      skillIds: row.owner_id === user.id ? await getSkillSelection(user.id, row.id, prisma, 'preset') : [],
      images: ids.map(toPayload).filter((item): item is NonNullable<ReturnType<typeof toPayload>> => Boolean(item)),
      fixedReferenceCount: (fixedByPreset.get(row.id) || []).length,
      fixedReferences: (user.role === 'admin' ? fixedByPreset.get(row.id) || [] : []).map(reference => {
        const asset = byId.get(reference.assetId);
        const available = Boolean(asset && asset.owner_id === row.owner_id);
        return { id: reference.assetId, originalUrl: available ? studioTemplateAssetUrl(reference.assetId) : null,
          thumbnailUrl: available ? studioTemplateAssetUrl(reference.assetId, true) : null,
          width: available ? asset?.width ?? null : null, height: available ? asset?.height ?? null : null,
          note: canSeeContext ? reference.note : '', available };
      }),
      banner: row.banner_asset_id ? toPayload(row.banner_asset_id) : null,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }));
}

export async function saveStudioPreset(user: ImageStudioIdentity, body: PresetDraft, replace = false) {
  user = await assertStudioActor(user.id);
  if (body.isShared !== undefined && typeof body.isShared !== 'boolean') throw new StudioModuleError('模板共享设置无效');
  if (replace) {
    const target = await prisma.imageStudioPreset.findUnique({ where: { id: String(body.presetId || '') } });
    if (target?.is_shared || body.isShared === true || (target?.owner_id === user.id && await studioPublisherModule(user.id, target.id)) || await prisma.platformSetting.findUnique({ where: { key: `studio_shared_reproduction_v1:${String(body.presetId || '')}` }, select: { id: true } })) {
      return replaceSharedStudioPreset(user, String(body.presetId || ''), body as Record<string, unknown>);
    }
  } else if (body.isShared === true) {
    if (body.sourceModuleId !== undefined && (typeof body.sourceModuleId !== 'string' || !validStudioModuleId(body.sourceModuleId, user.id))) {
      throw new StudioModuleError('模板来源模块无效', 400);
    }
    return saveSharedStudioPresetAs(user, body as Record<string, unknown>);
  }
  if (!canUseCompanyTemplatesForUser(user)) throw new StudioModuleError('仅限公司飞书账号使用共享模板', 403);
  const userId = user.id;
  const isAdmin = user.role === 'admin';
  const scope = body.scope === 'admin' ? 'admin' : body.scope === 'creator' ? 'creator' : '';
  if (!scope || (scope === 'admin' && !isAdmin)) throw new StudioModuleError('没有保存该模板类型的权限', 403);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const groupName = typeof body.groupName === 'string' ? body.groupName.trim() || '未分组' : '未分组';
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  const context = typeof body.context === 'string' ? body.context : '';
  const model = typeof body.model === 'string' && IMAGE_STUDIO_MODELS.includes(body.model as never) ? body.model : '';
  const count = Number(body.count);
  const requestedIds = parseIds(body.referenceIds);
  let referencePolicy: StudioReferencePolicy | undefined;
  if (body.referencePolicy !== undefined) {
    try { referencePolicy = parseStudioReferencePolicy(body.referencePolicy, requestedIds); }
    catch (error) {
      if (error instanceof StudioReferencePolicyError) throw new StudioModuleError(error.message, error.status);
      throw error;
    }
  }
  const referenceLimit = body.referenceLimit === undefined
    ? referencePolicy?.primaryMax ?? DEFAULT_STUDIO_PRIMARY_MAX
    : Number(body.referenceLimit);
  // Presets store reusable settings and auxiliary references, never a user's current main image.
  const incomingPolicy = referencePolicy || defaultStudioReferencePolicy(requestedIds, referenceLimit);
  const ids = requestedIds.filter(id => !incomingPolicy.primaryIds.includes(id));
  referencePolicy = { ...incomingPolicy, primaryIds: [] };
  let fixedReferences: StudioFixedReference[] | undefined;
  if (body.fixedReferences !== undefined) {
    if (!isAdmin) throw new StudioModuleError('固定模板图只能由管理员修改', 403);
    try { fixedReferences = parseStudioFixedReferences(body.fixedReferences); }
    catch (error) { throw new StudioModuleError((error as Error).message); }
  }
  if (!name || name.length > 80 || prompt.length > 20000 || context.length > 20000 || groupName.length > 40 || !model || !Number.isInteger(count) || count < 1 || count > 8 || !Number.isInteger(referenceLimit) || referenceLimit < 1 || referenceLimit > MAX_REFERENCE_IMAGES || ids.length > MAX_REFERENCE_IMAGES) throw new StudioModuleError('模板内容无效');
  const aspectRatio = normalizeStudioRatio(body.aspectRatio);
  const quality = normalizeImageStudioQuality(model, body.quality);
  const resolution = normalizeImageResolution(model, body.resolution || defaultImageResolution(model));
  const bannerAssetId = body.bannerAssetId == null ? null : String(body.bannerAssetId);
  const sourceModuleId = body.sourceModuleId == null ? null : String(body.sourceModuleId);
  if (sourceModuleId && !validStudioModuleId(sourceModuleId, userId)) throw new StudioModuleError('模板来源模块无效', 403);
  return prisma.$transaction(async tx => {
    user = await assertStudioActor(user.id, tx);
    if (scope === 'admin' && user.role !== 'admin' || fixedReferences !== undefined && user.role !== 'admin') throw new StudioModuleError('当前账号没有保存管理员配置的权限', 403);
    const target = replace ? await tx.imageStudioPreset.findFirst({ where: { id: String(body.presetId || ''), owner_id: userId } }) : null;
    if (target && await studioPresetArchived(target.id, tx)) throw new StudioModuleError('模板已删除，请重新读取', 409);
    if (target && !canManageStudioPreset(user, target)) throw new StudioModuleError('当前账号没有修改该模板的权限', 403);
    if (target && (target.is_shared || await studioPublisherModule(userId, target.id, tx)
      || await tx.platformSetting.findUnique({ where: { key: `studio_shared_reproduction_v1:${target.id}` }, select: { id: true } }))) {
      throw new StudioModuleError('模板已成为共享原件，请重新读取后保存定义；当前草稿仍保留', 409);
    }
    if (replace && (!target || typeof body.revision !== 'string' || target.updated_at.toISOString() !== body.revision)) {
      throw new StudioModuleError(target ? '模板已在其他页面更新，请重新读取后修改' : '只能修改自己的模板', target ? 409 : 403);
    }
    let priorPresetId: string | null = null;
    let inheritedEvolution: EvolutionCapability | null = null;
    if (sourceModuleId) {
      const sourceModule = await tx.imageStudioModule.findFirst({ where: { id: sourceModuleId, owner_id: userId }, select: { id: true, context: true, source_preset_id: true } });
      if (!sourceModule) throw new StudioModuleError('模板来源模块不存在或无权使用', 403);
      if (user.role !== 'admin' && sourceModule.source_preset_id) {
        const original = await tx.imageStudioPreset.findUnique({ where: { id: sourceModule.source_preset_id }, select: { owner_id: true } });
        if (!original || original.owner_id !== userId) throw new StudioModuleError('共享模板的内部配置只能由创建者另存', 403);
      }
      priorPresetId = sourceModule.source_preset_id;
      inheritedEvolution = evolutionCapability(sourceModule);
    }
    const presetFixedReferences = fixedReferences === undefined
      ? sourceModuleId ? await getStudioModuleFixedReferences(userId, sourceModuleId, tx) : []
      : fixedReferences;
    const styleIds = body.styleGroupIds === undefined ? [] : parseStudioStyleIds(body.styleGroupIds);
    let skillIds = body.skillIds === undefined ? [] : parseSkillIds(body.skillIds);
    if (!body.reproduceFromTaskId) await resolveSkills(user, skillIds, tx);
    if (target?.is_shared && skillIds.length) throw new StudioModuleError('skills仅自己可见，请先关闭模板共享，或移除skills后再保存', 409);
    const styles = await resolveStudioStyleReferences(user, styleIds, tx);
    try { validateStudioReferenceCounts(referencePolicy || defaultStudioReferencePolicy(ids, referenceLimit), ids, presetFixedReferences.length, styles.references.length); }
    catch (error) { throw new StudioModuleError((error as Error).message); }
    const assetIds = Array.from(new Set([...ids, ...presetFixedReferences.map(reference => reference.assetId), ...(bannerAssetId ? [bannerAssetId] : [])]));
    const owned = await tx.asset.findMany({ where: { id: { in: assetIds }, owner_id: userId, status: 'active', type: 'image', AND: [await studioVisibleAssetWhere(user, tx)] }, select: { id: true } });
    if (owned.length !== assetIds.length) throw new StudioModuleError('模板参考图片不存在或无权使用', 403);
    let effectiveContext = context;
    if (body.reproduceFromTaskId) {
      if (typeof body.reproduceFromTaskId !== 'string' || body.reproduceFromTaskId.length > 120) throw new StudioModuleError('历史记录无效');
      const task = await tx.imageStudioTask.findFirst({ where: { id: body.reproduceFromTaskId, owner_id: userId, deleted_at: null } });
      if (!task?.snapshot_json) throw new StudioModuleError('历史记录缺少原上下文', 409);
      let snapshot;
      try { snapshot = JSON.parse(task.snapshot_json); } catch { throw new StudioModuleError('历史记录缺少原上下文', 409); }
      if (!snapshot || typeof snapshot.moduleContext !== 'string' || typeof snapshot.globalContext !== 'string') throw new StudioModuleError('历史记录缺少原上下文', 409);
      const originalId = task.source_preset_id || (typeof snapshot.sourcePresetId === 'string' ? snapshot.sourcePresetId : null);
      if (originalId) {
        const original = await tx.imageStudioPreset.findUnique({ where: { id: originalId } });
        if (!original || !canViewStudioPreset(user, original)) throw new StudioModuleError('原模板已不可用', 403);
        if (user.role !== 'admin' && original.owner_id !== userId) throw new StudioModuleError('共享模板的内部配置只能由创建者另存', 403);
      }
      effectiveContext = snapshot.moduleContext;
      skillIds = await cloneHistoricalSkills(user, snapshot.skills, tx);
      if (target?.is_shared && skillIds.length) throw new StudioModuleError('历史skills仅自己可见，请先关闭模板共享', 409);
      if (snapshot.evolution && ['increase', 'decrease'].includes(snapshot.evolution.direction)) inheritedEvolution = { version: 1, defaultDirection: snapshot.evolution.direction };
    }
    if (inheritedEvolution && !evolutionCapability({ context: effectiveContext })) effectiveContext += `\n[studio:evolution:v1:${inheritedEvolution.defaultDirection}]`;
    const data = { name, group_name: groupName, prompt, context: effectiveContext, model, quality, resolution, count, reference_limit: referenceLimit, aspect_ratio: aspectRatio, banner_asset_id: bannerAssetId, reference_ids: JSON.stringify(ids) };
    let created;
    if (target) {
      const changed = await tx.imageStudioPreset.updateMany({ where: { id: target.id, owner_id: userId, updated_at: target.updated_at },
        data: { ...data, updated_at: new Date(Math.max(Date.now(), target.updated_at.getTime() + 1)) } });
      if (changed.count !== 1) throw new StudioModuleError('模板已在其他页面更新，请重新读取后修改', 409);
      created = await tx.imageStudioPreset.findUniqueOrThrow({ where: { id: target.id } });
    } else {
      created = await tx.imageStudioPreset.create({ data: { ...data, id: randomUUID(), owner_id: userId, scope, is_shared: false } });
    }
    await setStudioPresetFixedReferences(userId, created.id, presetFixedReferences, tx);
    await setStudioPresetStyleIds(user, created.id, styleIds, tx);
    await setSkillSelection(user, created.id, skillIds, tx, 'preset');
    if (referencePolicy) {
      try { await setStudioPresetReferencePolicy(userId, created.id, referencePolicy, ids, tx); }
      catch (error) {
        if (error instanceof StudioReferencePolicyError) throw new StudioModuleError(error.message, error.status);
        throw error;
      }
    }
    if (sourceModuleId && !replace) {
      const key = quickPresetKey(sourceModuleId);
      const stored = await tx.platformSetting.findUnique({ where: { key }, select: { value_json: true } });
      const ids = Array.from(new Set([...decodeQuickPresetIds(stored?.value_json, userId), ...(priorPresetId ? [priorPresetId] : []), created.id]));
      const valueJson = JSON.stringify({ ownerId: userId, ids });
      await tx.platformSetting.upsert({ where: { key }, create: { key, value_json: valueJson, updated_by: userId }, update: { value_json: valueJson, updated_by: userId } });
      if (!(await studioSharedBinding(userId, sourceModuleId, tx))) {
        await tx.imageStudioModule.update({ where: { id: sourceModuleId }, data: { source_preset_id: created.id } });
      }
    }
    await restoreStudioDefaultGroup(userId, groupName, tx);
    return created;
  });
}

export async function manageStudioPreset(user: ImageStudioIdentity, presetId: string, revision: unknown, action: 'rename' | 'delete', value?: unknown) {
  return prisma.$transaction(async tx => {
    user = await assertStudioActor(user.id, tx);
    const preset = await tx.imageStudioPreset.findFirst({ where: { id: presetId, owner_id: user.id } });
    if (!preset || !canManageStudioPreset(user, preset)) throw new StudioModuleError('只能管理自己的模板', 403);
    if (await studioPresetArchived(preset.id, tx)) throw new StudioModuleError('模板已删除，请重新读取', 409);
    if (typeof revision !== 'string' || revision !== preset.updated_at.toISOString()) throw new StudioModuleError('模板已在其他页面更新，请重新读取后修改', 409);
    const where = { id: presetId, owner_id: user.id, updated_at: preset.updated_at };
    if (action === 'rename') {
      const name = typeof value === 'string' ? value.trim() : '';
      if (!name || name.length > 80) throw new StudioModuleError('模板名称需为 1 至 80 字');
      const updated = await tx.imageStudioPreset.updateMany({ where, data: { name, updated_at: new Date(Math.max(Date.now(), preset.updated_at.getTime() + 1)) } });
      if (updated.count !== 1) throw new StudioModuleError('模板已在其他页面更新，请重新读取后修改', 409);
    } else {
      const deleted = await tx.imageStudioPreset.updateMany({ where, data: { updated_at: new Date(Math.max(Date.now(), preset.updated_at.getTime() + 1)) } });
      if (deleted.count !== 1) throw new StudioModuleError('模板已在其他页面更新，请重新读取后修改', 409);
      // Keep the source row for authorized historical restoration, without exposing a recycle bin.
      await tx.platformSetting.create({ data: { key: archivedPresetKey(presetId), value_json: JSON.stringify({ archivedAt: new Date().toISOString() }), updated_by: user.id } });
    }
    const publisher = await studioPublisherModule(user.id, presetId, tx);
    if (publisher) await tx.imageStudioModule.updateMany({ where: { id: publisher, owner_id: user.id }, data: { revision: { increment: 1 } } });
    return { id: presetId };
  });
}

export async function linkStudioQuickPreset(user: ImageStudioIdentity, moduleId: string, presetId: string) {
  if (!validStudioModuleId(moduleId, user.id)) throw new StudioModuleError('模块不存在或无权使用', 404);
  return prisma.$transaction(async tx => {
    user = await assertStudioActor(user.id, tx);
    const workspace = await tx.imageStudioModule.findFirst({ where: { id: moduleId, owner_id: user.id }, select: { id: true } });
    const preset = await tx.imageStudioPreset.findFirst({ where: { id: presetId, owner_id: user.id }, select: { id: true } });
    if (!workspace || !preset) throw new StudioModuleError('只能添加自己的模板到自己的模块', 403);
    if (await studioPresetArchived(preset.id, tx)) throw new StudioModuleError('模板已删除，请重新读取', 409);
    const key = quickPresetKey(moduleId);
    const stored = await tx.platformSetting.findUnique({ where: { key }, select: { value_json: true } });
    const ids = Array.from(new Set([...decodeQuickPresetIds(stored?.value_json, user.id), presetId]));
    const valueJson = JSON.stringify({ ownerId: user.id, ids });
    await tx.platformSetting.upsert({ where: { key }, create: { key, value_json: valueJson, updated_by: user.id }, update: { value_json: valueJson, updated_by: user.id } });
    return { id: presetId };
  });
}

export async function setStudioPresetSharing(user: ImageStudioIdentity, presetId: string, isShared: boolean, revision?: unknown) {
  return prisma.$transaction(async tx => {
    user = await assertStudioActor(user.id, tx);
    const preset = await tx.imageStudioPreset.findUnique({ where: { id: presetId } });
    if (!preset || !canManageStudioPreset(user, preset)) {
      throw new StudioModuleError('只有模板创建者可以修改共享状态', 403);
    }
    if (await studioPresetArchived(preset.id, tx)) throw new StudioModuleError('模板已删除，请重新读取', 409);
    if (revision !== undefined && revision !== preset.updated_at.toISOString()) throw new StudioModuleError('模板已在其他页面更新，请重新读取', 409);
    if (isShared) await resolveSharedStudioDefinition(user, presetId, tx);
    const changed = await tx.imageStudioPreset.updateMany({ where: { id: presetId, owner_id: user.id, updated_at: preset.updated_at },
      data: { is_shared: isShared, updated_at: new Date(Math.max(Date.now(), preset.updated_at.getTime() + 1)) } });
    if (changed.count !== 1) throw new StudioModuleError('模板共享状态已变化，请重新读取', 409);
    const publisher = await studioPublisherModule(user.id, presetId, tx);
    if (publisher) await tx.imageStudioModule.updateMany({ where: { id: publisher, owner_id: user.id }, data: { revision: { increment: 1 } } });
    return tx.imageStudioPreset.findUniqueOrThrow({ where: { id: presetId } });
  });
}

export async function applyStudioPreset(user: ImageStudioIdentity, presetId: string) {
  const userId = user.id;
  const moduleId = await prisma.$transaction(async tx => {
    user = await assertStudioActor(userId, tx);
    const preset = await tx.imageStudioPreset.findUnique({ where: { id: presetId } });
    if (!preset || !canViewStudioPreset(user, preset)) throw new StudioModuleError('模板不存在或无权使用', 404);
    if (await studioPresetArchived(preset.id, tx)) throw new StudioModuleError('模板已删除，请重新读取', 409);
    const storedIds = parsePreset(preset);
    const storedPolicy = await getStudioPresetReferencePolicy(preset.owner_id, preset.id, storedIds, preset.reference_limit, tx);
    const ids = storedIds.filter(id => !storedPolicy.primaryIds.includes(id));
    const fixedReferences = await getStudioPresetFixedReferences(user, preset, tx);
    const styleGroupIds = await getStudioModuleStyleIds(preset.owner_id, preset.id, tx, 'preset');
    const skillIds = await getSkillSelection(preset.owner_id, preset.id, tx, 'preset');
    await resolveSkills(user, skillIds, tx);
    const referencePolicy = { ...storedPolicy, primaryIds: [] };
    const styles = await resolveStudioStyleReferences(user, styleGroupIds, tx);
    try { validateStudioReferenceCounts(referencePolicy, ids, fixedReferences.length, styles.references.length); }
    catch (error) { throw new StudioModuleError((error as Error).message, 409); }
    const allIds = Array.from(new Set([...ids, ...fixedReferences.map(reference => reference.assetId), ...(preset.banner_asset_id ? [preset.banner_asset_id] : [])]));
    const sources = await tx.asset.findMany({ where: { id: { in: allIds }, owner_id: preset.owner_id, status: 'active', type: 'image' } });
    if (sources.length !== allIds.length) throw new StudioModuleError('模板引用的图片已不可用，请重新保存模板', 409);
    const visible = await studioVisibleAssetWhere(user, tx);
    const publicIds = [...ids, ...(preset.banner_asset_id ? [preset.banner_asset_id] : [])];
    if (await tx.asset.count({ where: { id: { in: publicIds }, AND: [visible] } }) !== new Set(publicIds).size) throw new StudioModuleError('模板引用包含不可查看的图片', 403);
    const assetMap = new Map<string, string>();
    for (const source of sources) {
      if (fixedReferences.some(reference => reference.assetId === source.id)) continue;
      if (source.owner_id === userId) { assetMap.set(source.id, source.id); continue; }
      const clone = await tx.asset.create({ data: { owner_id: userId, type: source.type, original_url: source.original_url, thumbnail_url: source.thumbnail_url, file_name: source.file_name, mime_type: source.mime_type, width: source.width, height: source.height, file_size: source.file_size, hash: null, status: 'active' } });
      assetMap.set(source.id, clone.id);
    }
    const copiedReferenceIds = ids.map(id => assetMap.get(id)).filter((id): id is string => Boolean(id));
    const id = randomUUID();
    await tx.imageStudioModule.create({ data: { id, owner_id: userId, revision: 1, source_preset_id: preset.id,
      name: preset.name, prompt: preset.prompt, context: preset.context, model: preset.model, quality: preset.quality, resolution: preset.resolution,
      count: preset.count, reference_limit: preset.reference_limit, aspect_ratio: preset.aspect_ratio, group_name: preset.group_name,
      banner_asset_id: preset.banner_asset_id ? assetMap.get(preset.banner_asset_id) || null : null, reference_ids: JSON.stringify(copiedReferenceIds) } });
    if (preset.owner_id === userId) await setStudioModuleFixedReferences(userId, id, fixedReferences, tx);
    await setStudioModuleReferencePolicy(userId, id, referencePolicy, copiedReferenceIds, tx);
    await setStudioModuleStyleIds(user, id, styleGroupIds, tx);
    await setSkillSelection(user, id, skillIds, tx);
    await restoreStudioDefaultGroup(userId, preset.group_name, tx);
    return id;
  }, { timeout: 15000 });
  return studioModuleDTOForUser(user, moduleId);
}
