import { createHash, randomUUID } from 'crypto';
import { parseStudioTaskSettings } from './task-settings';
import { assertStudioTaskSettingsWrite, assertStudioTaskSettingsWriter, readStudioWorkspaceSource, writeStudioWorkspaceSource, studioSettingsSourceContext } from './task-settings-storage';
import type { Prisma } from '@prisma/client';
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
import { studioFixedCoverDTO, assertPresetCoverShareable } from './module-cover';
import { getStudioModuleStyleIds, parseStudioStyleIds, resolveStudioStyleReferences, setStudioModuleStyleIds, setStudioPresetStyleIds } from './style-groups';
import { cloneHistoricalSkills, getSkillSelection, parseSkillIds, resolveSkills, setSkillSelection } from './skills';
import { defaultStudioReferencePolicy, getStudioPresetReferencePolicy, parseStudioReferencePolicy, setStudioModuleReferencePolicy, setStudioPresetReferencePolicy, validateStudioReferenceCounts, StudioReferencePolicyError, type StudioReferencePolicy } from './reference-policy';
import { assertStudioActor, saveSharedStudioPresetAs, replaceSharedStudioPreset, resolveSharedStudioDefinition, restoreStudioDefaultGroup, studioPublisherModule, studioSharedBinding, parseSharedStudioPersonalOverrides, StudioSharingError, studioSharedReproductionKey } from './shared-contract';
import type { SharedStudioPersonalOverrides } from './shared-types';
import { readStudioModuleSharingPreference, writeStudioModuleSharingPreference } from './module-sharing-preference';
import { readOwnedReceipt, readReceipt, writeReceipt, sharedCommandFingerprint, publicStudioReceipt, parseStudioSharingReceipt } from './shared-command-storage';
import { recordStudioLifecycleEvent, studioDefinitionChangedFields, publicStudioLifecycleDetail } from './shared-lifecycle-audit';
import { readSharedStudioSnapshot } from './read-snapshot';
import { projectSharedStudioCapabilities, studioStateReason } from './shared-capabilities';
import { assertStudioDeletionIdle, parseStudioDeletionReceipt, recordStudioSourceReselection, studioSourceDeletionCapability } from './workspace-deletion';
import type { StudioDeletionCommandStatus, StudioDeletionReceipt } from './shared-types';
import type { SharedStudioSharingCurrent, SharedStudioSharingReceipt, SharedStudioCommandStatus, SharedStudioLifecycleHistory } from './shared-types';

export { canUseCompanyTemplatesForUser as canUseCompanyTemplates };

type PresetDraft = {
  taskSettings?: unknown; globalContext?: unknown;
  skillVersions?: unknown; styleGroupVersions?: unknown;
  scope?: unknown; name?: unknown; groupName?: unknown; prompt?: unknown; context?: unknown;
  model?: unknown; quality?: unknown; resolution?: unknown; count?: unknown; aspectRatio?: unknown;
  bannerAssetId?: unknown; referenceIds?: unknown; referenceLimit?: unknown; sourceModuleId?: unknown; fixedReferences?: unknown;
  styleGroupIds?: unknown; skillIds?: unknown; referencePolicy?: unknown;
  presetId?: unknown; revision?: unknown;
  reproduceFromTaskId?: unknown;
  isShared?: unknown; requestId?: unknown; moduleRevision?: unknown; expectedRevision?: unknown; expectedDefinitionToken?: unknown; templatePrompt?: unknown;
  personalOverrides?: unknown; resetFields?: unknown; personalReferenceIds?: unknown; personalReferencePolicy?: unknown;
  saveIntent?: unknown;
  entryPoint?: unknown;
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
const personalQuickPresetKey = (presetId: string) => `studio_personal_quick_preset_v1:${presetId}`;
const personalQuickRequestKey = (ownerId: string, requestId: string) => `studio_personal_quick_request_v1:${createHash('sha256').update(JSON.stringify([ownerId, requestId])).digest('hex')}`;
type PersonalQuickPresetMetadata = {
  version: 1; ownerId: string; presetId: string; overrides: SharedStudioPersonalOverrides; referenceIds: string[];
};
function decodePersonalQuickPreset(value: string | undefined, ownerId: string, presetId: string): PersonalQuickPresetMetadata | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || parsed.version !== 1 || parsed.ownerId !== ownerId || parsed.presetId !== presetId) throw new Error();
    return { version: 1, ownerId, presetId, overrides: parseSharedStudioPersonalOverrides(parsed.overrides), referenceIds: parseIds(parsed.referenceIds) };
  } catch { throw new StudioModuleError('个人快捷设置无法读取，请重试；原模板仍保留', 503); }
}
function personalQuickFingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).filter(([key, child]) => key !== 'requestId' && child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
async function recoverPersonalQuickPreset(tx: Prisma.TransactionClient, ownerId: string, sourceModuleId: string,
  requestKey: string, fingerprint: string) {
  const receipt = await tx.platformSetting.findUnique({ where: { key: requestKey }, select: { value_json: true } });
  if (!receipt) return null;
  let saved: { version?: unknown; ownerId?: unknown; sourceModuleId?: unknown; inputFingerprint?: unknown; presetId?: unknown };
  try { saved = JSON.parse(receipt.value_json); } catch { throw new StudioModuleError('快捷保存回执无法确认，请保留原提交编号重试', 409); }
  if (!saved || saved.version !== 1 || saved.ownerId !== ownerId || saved.sourceModuleId !== sourceModuleId
    || saved.inputFingerprint !== fingerprint || typeof saved.presetId !== 'string') {
    throw new StudioModuleError('该保存编号已用于其他设置，请读取原快捷设置或使用新的保存编号', 409);
  }
  const preset = await tx.imageStudioPreset.findFirst({ where: { id: saved.presetId, owner_id: ownerId, is_shared: false } });
  if (!preset || await studioPresetArchived(preset.id, tx)) throw new StudioModuleError('原快捷设置已不可用，不能重复创建；请重新读取', 409);
  const metadata = await tx.platformSetting.findUnique({ where: { key: personalQuickPresetKey(preset.id) }, select: { value_json: true } });
  const personal = decodePersonalQuickPreset(metadata?.value_json, ownerId, preset.id);
  if (!personal) throw new StudioModuleError('原快捷设置回执不完整，请保留原提交编号重试', 409);
  return { ...preset, saveIntent: 'personal-quick' as const, personalOverrides: personal.overrides };
}
function decodeQuickPresetIds(value: string | undefined, ownerId: string): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (parsed.ownerId !== ownerId || !Array.isArray(parsed.ids) || parsed.ids.some((id: unknown) => typeof id !== 'string')) throw new Error();
    return parsed.ids;
  } catch { throw new StudioModuleError('快捷模板无法读取，请重试', 503); }
}

export async function listStudioPresets(user: ImageStudioIdentity, moduleId?: string, presetId?: string) {
  const { resolveStudioTemplateAuthor } = await import('./template-author');
  user = await assertStudioActor(user.id);
  if (presetId !== undefined) {
    const { publicDTO } = await resolveSharedStudioDefinition(user, presetId);
    const templateRead = (await resolveStudioTemplateAuthor(user, { presetId })).templateRead;
    return [{ id: publicDTO.presetId, ...publicDTO, templateRead, ...publicDTO.defaults, prompt: publicDTO.templatePrompt, sourcePresetId: publicDTO.presetId,
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
  const personalMetadata = await prisma.platformSetting.findMany({ where: { key: { in: privateRows.filter(row => row.owner_id === user.id)
    .map(row => personalQuickPresetKey(row.id)) } }, select: { key: true, value_json: true } });
  const personalMetadataByKey = new Map(personalMetadata.map(row => [row.key, row.value_json]));
  const personalByPreset = new Map(privateRows.filter(row => row.owner_id === user.id).map(row =>
    [row.id, decodePersonalQuickPreset(personalMetadataByKey.get(personalQuickPresetKey(row.id)), user.id, row.id)] as const));
  const fixedByPreset = await getStudioPresetsFixedReferences(user, privateRows);
  const referencePolicies = await Promise.all(privateRows.map(async row => [row.id, await getStudioPresetReferencePolicy(row.owner_id, row.id, parsePreset(row), row.reference_limit)] as const));
  const policyByPreset = new Map(referencePolicies);
  const styleIdsByPreset = moduleId === undefined ? new Map<string, string[]>() : new Map(await Promise.all(privateRows.map(async row =>
    [row.id, await getStudioModuleStyleIds(row.owner_id, row.id, prisma, 'preset')] as const)));
  const reusableIds = (row: typeof visibleRows[number]) => parsePreset(row).filter(id => !policyByPreset.get(row.id)?.primaryIds.includes(id));
  const assetIds = privateRows.flatMap(row => [...reusableIds(row), ...(fixedByPreset.get(row.id) || []).map(reference => reference.assetId),
    ...(personalByPreset.get(row.id)?.referenceIds || [])]);
  const bannerIds = privateRows.map(row => row.banner_asset_id).filter((id): id is string => Boolean(id));
  const assets = await prisma.asset.findMany({ where: { id: { in: Array.from(new Set([...assetIds, ...bannerIds])) }, status: 'active', type: 'image', AND: [await studioVisibleAssetWhere(user)] }, select: { id: true, owner_id: true, original_url: true, thumbnail_url: true, width: true, height: true } });
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  return Promise.all(visibleRows.map(async row => {
    const deletion = studioSourceDeletionCapability(user, row);
    if (row.is_shared) {
      const templateRead = (await resolveStudioTemplateAuthor(user, { presetId: row.id })).templateRead;
      try {
        const { publicDTO } = await resolveSharedStudioDefinition(user, row.id);
        return { id: row.id, scope: row.scope, ...publicDTO, templateRead, ...publicDTO.defaults, prompt: publicDTO.templatePrompt,
          sourcePresetId: row.id, referencesAvailable: true, skillIds: [],
          moduleContextVersion: await resolveModuleContextVersion(publicDTO.context).catch(() => null), createdAt: row.created_at, updatedAt: row.updated_at };
      } catch (error) {
        if (!(error instanceof StudioSharingError) || ![403, 404, 409].includes(error.status)) throw error;
        const state = projectSharedStudioCapabilities({ objectKind: row.owner_id === user.id ? 'publisher' : 'live', lifecycle: 'active', sharing: 'shared',
          dependency: error.reasonCode === 'dependency-invalid' ? 'invalid' : 'unknown', sourceRevision: row.updated_at.toISOString(), moduleRevision: null,
          definitionToken: error.intent?.definitionToken ?? null, actorAllowed: true, ownsWorkspace: false, canViewSource: true,
          canManageSource: canManageStudioPreset(user, row), canViewDefinition: templateRead.canViewTemplateContext, reasonCode: error.reasonCode });
        state.capabilities.editDefinition = { allowed: false, reasonCode: error.reasonCode, reason: studioStateReason[error.reasonCode] };
        state.capabilities.saveDefinition = { allowed: false, reasonCode: error.reasonCode, reason: studioStateReason[error.reasonCode] };
        return { ...state, deletion, templateRead, id: row.id, name: row.name, scope: row.scope, groupName: row.group_name, revision: row.updated_at.toISOString(), model: row.model,
          isShared: row.is_shared, ownedByViewer: row.owner_id === user.id, canManageSharing: canManageStudioPreset(user, row),
          unavailable: true, unavailableReason: studioStateReason[error.reasonCode], prompt: '', context: '', contextConfigured: false, referencesAvailable: false,
          fixedCover: await studioFixedCoverDTO(user, { kind: 'preset', id: row.id }), coverEditable: canManageStudioPreset(user, row),
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
    const toPayload = (id: string) => {
      const asset = byId.get(id);
      if (!asset || asset.owner_id !== row.owner_id) return null;
      return { id, originalUrl: studioTemplateAssetUrl(id), thumbnailUrl: studioTemplateAssetUrl(id, true), width: asset.width, height: asset.height };
    };
    const personal = personalByPreset.get(row.id);
    const settingsSource = await readStudioWorkspaceSource(prisma, row.owner_id, row.id, 'preset');
    const templateRead = (await resolveStudioTemplateAuthor(user, { presetId: row.id })).templateRead;
    return {
      deletion, templateRead, id: row.id, name: row.name, scope: row.scope, groupName: row.group_name, prompt: templateRead.canViewTemplateContext ? row.prompt : '', context: templateRead.canViewTemplateContext ? row.context : '', revision: row.updated_at.toISOString(),
      isShared: row.is_shared,
      ...(settingsSource && row.owner_id === user.id ? { taskSettings: settingsSource.taskSettings } : {}),
      ...(personal ? { saveIntent: 'personal-quick' as const, personalOverrides: personal.overrides,
        personalImages: personal.referenceIds.map(toPayload).filter((item): item is NonNullable<ReturnType<typeof toPayload>> => Boolean(item)),
        personalReferencesAvailable: personal.referenceIds.every(id => Boolean(toPayload(id))) } : {}),
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
          note: templateRead.canViewTemplateContext ? reference.note : '', available };
      }),
      banner: row.banner_asset_id ? toPayload(row.banner_asset_id) : null,
      fixedCover: await studioFixedCoverDTO(user, { kind: 'preset', id: row.id }), coverEditable: canManageStudioPreset(user, row),
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }));
}

export async function saveStudioPreset(user: ImageStudioIdentity, body: PresetDraft, replace = false) {
  const taskSettings = parseStudioTaskSettings(body.taskSettings);
  if (taskSettings && Object.prototype.hasOwnProperty.call(body, 'globalContext')) throw new StudioModuleError('通用上下文不能随模板覆盖', 400);
  user = await assertStudioActor(user.id);
  if (body.saveIntent !== undefined && body.saveIntent !== 'personal-quick') throw new StudioModuleError('模板保存方式无效', 400);
  const personalQuick = body.saveIntent === 'personal-quick';
  if (personalQuick && (replace || body.isShared !== false || typeof body.sourceModuleId !== 'string'
    || typeof body.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(body.requestId))) {
    throw new StudioModuleError('个人快捷设置须在自己的模块中另存，请保留草稿重新保存', 400);
  }
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
  if (Object.prototype.hasOwnProperty.call(body, 'fixedReferenceRepairs')) throw new StudioModuleError('固定参考修复仅限本人已有原模板，不用于普通另存或快捷设置', 403);
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
  const personalOverrides = personalQuick ? body.personalOverrides === undefined ? {} : parseSharedStudioPersonalOverrides(body.personalOverrides) : undefined;
  const requestedPersonalIds = personalQuick && body.personalReferenceIds !== undefined ? parseIds(body.personalReferenceIds) : [];
  let personalReferenceIds = Array.from(new Set(requestedPersonalIds.filter(id => !incomingPolicy.primaryIds.includes(id))));
  if (personalQuick && body.personalReferencePolicy !== undefined) {
    try {
      const policy = parseStudioReferencePolicy(body.personalReferencePolicy, requestedPersonalIds);
      personalReferenceIds = personalReferenceIds.filter(id => !policy.primaryIds.includes(id));
    } catch (error) { throw new StudioModuleError((error as Error).message, Number((error as { status?: unknown }).status) || 400); }
  }
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
  const quickRequestKey = personalQuick ? personalQuickRequestKey(userId, body.requestId as string) : undefined;
  const quickFingerprint = personalQuick ? personalQuickFingerprint(body) : undefined;
  return prisma.$transaction(async tx => {
    user = await assertStudioActor(user.id, tx);
    let privateQuickSourceRevision: number | null = null;
    if (scope === 'admin' && user.role !== 'admin' || fixedReferences !== undefined && user.role !== 'admin') throw new StudioModuleError('当前账号没有保存管理员配置的权限', 403);
    if (personalQuick) {
      const source = await tx.imageStudioModule.findFirst({ where: { id: sourceModuleId!, owner_id: userId } });
      if (!source) throw new StudioModuleError('请先保存自己的模块，再另存个人快捷设置', 409);
      const binding = await studioSharedBinding(userId, source.id, tx);
      const original = source.source_preset_id ? await tx.imageStudioPreset.findUnique({ where: { id: source.source_preset_id } }) : null;
      if (source.source_preset_id && (!original || original.owner_id !== userId || !canViewStudioPreset(user, original)
        || await studioPresetArchived(original.id, tx)) || binding && (binding.mode !== 'publisher'
          || binding.ownerId !== userId || binding.presetId !== source.source_preset_id || original?.owner_id !== userId)) {
        throw new StudioModuleError('个人快捷设置只能另存自己创建的模板，不能另存他人的共享定义', 403);
      }
      const recovered = await recoverPersonalQuickPreset(tx, userId, source.id, quickRequestKey!, quickFingerprint!);
      if (recovered) return recovered;
      if (body.moduleRevision !== undefined && (!Number.isInteger(body.moduleRevision) || body.moduleRevision !== source.revision)) {
        throw new StudioModuleError('模板工作区已更新，请重新读取后保存；当前草稿仍保留', 409);
      }
      if (!binding) privateQuickSourceRevision = source.revision;
    }
    const target = replace ? await tx.imageStudioPreset.findFirst({ where: { id: String(body.presetId || ''), owner_id: userId } }) : null;
    const priorSettings = target ? await readStudioWorkspaceSource(tx, userId, target.id, 'preset') : null;
    assertStudioTaskSettingsWrite(priorSettings?.taskSettings, taskSettings);
    if (taskSettings) {
      await assertStudioTaskSettingsWriter(tx);
      const sourceTaskId = taskSettings.sourceTaskId || (typeof body.reproduceFromTaskId === 'string' ? body.reproduceFromTaskId : undefined);
      if (sourceTaskId) { await studioSettingsSourceContext(tx, user, sourceTaskId); taskSettings.sourceTaskId = sourceTaskId; }
      else if (taskSettings.mode === 'historical') throw new StudioModuleError('历史设置来源尚未确认，未另存模板', 409);
    }
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
      if ((personalQuick || user.role !== 'admin') && sourceModule.source_preset_id) {
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
    if (taskSettings && body.styleGroupVersions !== undefined) {
      const versions = body.styleGroupVersions as Record<string, unknown>;
      if (!versions || typeof versions !== 'object' || styles.groups.some(group => versions[group.id] !== group.revision)) throw new StudioModuleError('风格组已更新，当前输入保留，请重新选择后保存', 409);
    }
    try { validateStudioReferenceCounts(referencePolicy || defaultStudioReferencePolicy(ids, referenceLimit), [...ids, ...personalReferenceIds], presetFixedReferences.length, styles.references.length); }
    catch (error) { throw new StudioModuleError((error as Error).message); }
    const assetIds = Array.from(new Set([...ids, ...personalReferenceIds, ...presetFixedReferences.map(reference => reference.assetId), ...(bannerAssetId ? [bannerAssetId] : [])]));
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
        if ((personalQuick || user.role !== 'admin') && original.owner_id !== userId) throw new StudioModuleError('共享模板的内部配置只能由创建者另存', 403);
      }
      effectiveContext = taskSettings && body.context !== undefined ? context : snapshot.moduleContext;
      const originalSkills = Array.isArray(snapshot.skills) ? snapshot.skills : [];
      const versions = body.skillVersions as Record<string, unknown> | undefined;
      const keepsOriginalSkills = skillIds.length === originalSkills.length && originalSkills.every((skill: { id: string; promptVersion?: string }, index: number) => skillIds[index] === skill.id && versions?.[skill.id] === skill.promptVersion);
      if (!taskSettings || body.skillIds === undefined || keepsOriginalSkills) skillIds = await cloneHistoricalSkills(user, snapshot.skills, tx);
      else {
        const selected = await resolveSkills(user, skillIds, tx);
        if (!versions || selected.some(skill => versions[skill.id] !== skill.promptVersion)) throw new StudioModuleError('提示词组已更新，当前输入保留，请重新选择后保存', 409);
      }
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
    if (taskSettings) await writeStudioWorkspaceSource(tx, { version: 2, ownerId: userId, moduleId: created.id,
      sourceTaskId: taskSettings.sourceTaskId || null, taskSettings }, 'preset');
    if (personalQuick) {
      const personal: PersonalQuickPresetMetadata = { version: 1, ownerId: userId, presetId: created.id,
        overrides: personalOverrides!, referenceIds: personalReferenceIds };
      await tx.platformSetting.create({ data: { key: personalQuickPresetKey(created.id), value_json: JSON.stringify(personal), updated_by: userId } });
      // Unique owner/request receipt and the private snapshot commit together. A failed
      // transaction cannot leave a second preset or a successful-looking receipt behind.
      await tx.platformSetting.create({ data: { key: quickRequestKey!, value_json: JSON.stringify({ version: 1, ownerId: userId,
        sourceModuleId, inputFingerprint: quickFingerprint, presetId: created.id }), updated_by: userId } });
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
        if (personalQuick) {
          if (privateQuickSourceRevision === null) throw new StudioModuleError('模板共享状态已更新，请重新读取后保存', 409);
          const changed = await tx.imageStudioModule.updateMany({ where: { id: sourceModuleId, owner_id: userId, revision: privateQuickSourceRevision },
            data: { source_preset_id: created.id, revision: { increment: 1 } } });
          if (changed.count !== 1) throw new StudioModuleError('模板工作区已更新，请重新读取后保存；当前草稿仍保留', 409);
          const preference = await readStudioModuleSharingPreference(userId, sourceModuleId, tx);
          // Explicitly choosing a private save closes this unpublished template's
          // sharing intent in the same transaction as its idempotent save receipt.
          await writeStudioModuleSharingPreference({ version: 1, ownerId: userId, moduleId: sourceModuleId,
            enabled: false, revision: (preference?.revision ?? 0) + 1, requestId: body.requestId as string }, tx,
            { entryPoint: body.entryPoint, beforeModuleRevision: privateQuickSourceRevision, afterModuleRevision: privateQuickSourceRevision + 1 });
        } else {
          await tx.imageStudioModule.update({ where: { id: sourceModuleId }, data: { source_preset_id: created.id } });
        }
      }
    }
    await restoreStudioDefaultGroup(userId, groupName, tx);
    await recordStudioLifecycleEvent(tx, { actorUserId: user.id, ownerUserId: created.owner_id, contentId: created.id,
      action: target ? 'definition-saved' : 'published', requestId: body.requestId, entryPoint: body.entryPoint,
      before: { sourceRevision: target?.updated_at.toISOString() ?? null, ...(target ? { isShared: target.is_shared } : {}) },
      after: { sourceRevision: created.updated_at.toISOString(), isShared: created.is_shared }, changedFields: studioDefinitionChangedFields(body as Record<string, unknown>) });
    return personalQuick ? { ...created, saveIntent: 'personal-quick' as const, personalOverrides: personalOverrides! } : created;
  });
}

export async function manageStudioPreset(user: ImageStudioIdentity, presetId: string, revision: unknown, action: 'rename' | 'delete', value?: unknown,
  metadata?: { requestId?: unknown; entryPoint?: unknown }) {
  const originalRequestId = metadata?.requestId;
  if (action === 'delete' && (typeof originalRequestId !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(originalRequestId))) {
    throw new StudioModuleError('请刷新页面后删除，并保留有效的原请求编号', 428);
  }
  const deletionFingerprint = sharedCommandFingerprint(['delete-source', presetId, revision]);
  try { return await prisma.$transaction(async tx => {
    user = await assertStudioActor(user.id, tx);
    if (action === 'delete') {
      const prior = await readReceipt(tx, user.id, originalRequestId, deletionFingerprint);
      if (prior) return parseStudioDeletionReceipt(prior, user.id, 'source', presetId);
    }
    const preset = await tx.imageStudioPreset.findFirst({ where: { id: presetId, owner_id: user.id } });
    if (!preset || !canManageStudioPreset(user, preset)) throw new StudioModuleError('只能管理自己的模板', 403);
    if (await studioPresetArchived(preset.id, tx)) throw new StudioModuleError('模板已删除，请重新读取', 409);
    const settingsSource = await readStudioWorkspaceSource(tx, preset.owner_id, preset.id, 'preset');
    if (settingsSource?.taskSettings.sourceTaskId) await studioSettingsSourceContext(tx, user, settingsSource.taskSettings.sourceTaskId);
    if (typeof revision !== 'string' || revision !== preset.updated_at.toISOString()) throw new StudioModuleError('模板已在其他页面更新，请重新读取后修改', 409);
    const where = { id: presetId, owner_id: user.id, updated_at: preset.updated_at };
    if (action === 'rename') {
      const name = typeof value === 'string' ? value.trim() : '';
      if (!name || name.length > 80) throw new StudioModuleError('模板名称需为 1 至 80 字');
      if (name === preset.name) return { id: presetId };
      const updated = await tx.imageStudioPreset.updateMany({ where, data: { name, updated_at: new Date(Math.max(Date.now(), preset.updated_at.getTime() + 1)) } });
      if (updated.count !== 1) throw new StudioModuleError('模板已在其他页面更新，请重新读取后修改', 409);
    } else {
      const active = await tx.imageStudioTask.count({ where: { source_preset_id: presetId,
        status: { notIn: ['succeeded', 'failed', 'cancelled', 'canceled'] } } });
      if (active) throw new StudioModuleError('模板还有生成中或结果未确认的任务，请先核对原任务再删除', 409);
      const workspaces = await tx.imageStudioModule.findMany({ where: { owner_id: user.id, source_preset_id: presetId }, select: { id: true } });
      for (const workspace of workspaces) await assertStudioDeletionIdle(tx, user.id, workspace.id);
      const deleted = await tx.imageStudioPreset.updateMany({ where, data: { updated_at: new Date(Math.max(Date.now(), preset.updated_at.getTime() + 1)) } });
      if (deleted.count !== 1) throw new StudioModuleError('模板已在其他页面更新，请重新读取后修改', 409);
      // Keep the source row for authorized historical restoration, without exposing a recycle bin.
      await tx.platformSetting.create({ data: { key: archivedPresetKey(presetId), value_json: JSON.stringify({ archivedAt: new Date().toISOString() }), updated_by: user.id } });
    }
    const publisher = await studioPublisherModule(user.id, presetId, tx);
    if (publisher) await tx.imageStudioModule.updateMany({ where: { id: publisher, owner_id: user.id }, data: { revision: { increment: 1 } } });
    const updated = await tx.imageStudioPreset.findUniqueOrThrow({ where: { id: presetId } });
    await recordStudioLifecycleEvent(tx, { actorUserId: user.id, ownerUserId: preset.owner_id, contentId: presetId,
      action: action === 'rename' ? 'definition-renamed' : 'source-archived', requestId: metadata?.requestId, entryPoint: metadata?.entryPoint,
      before: { sourceRevision: preset.updated_at.toISOString(), isShared: preset.is_shared },
      after: { sourceRevision: updated.updated_at.toISOString(), isShared: updated.is_shared }, changedFields: action === 'rename' ? ['name'] : [] });
    if (action === 'delete') {
      const receipt: StudioDeletionReceipt = { version: 1, actorId: user.id, deleted: true, objectKind: 'source', id: presetId,
        sourceRevision: preset.updated_at.toISOString(), appliedRevision: updated.updated_at.toISOString(),
        requestId: originalRequestId as string, committedAt: new Date().toISOString(), noOp: false };
      await writeReceipt(tx, user.id, originalRequestId, deletionFingerprint, { ...receipt, action: 'delete-source', presetId });
      return receipt;
    }
    return { id: presetId };
  }); } catch (error) {
    if (action === 'delete' && (error instanceof StudioModuleError || error instanceof StudioSharingError)) {
      try {
        await assertStudioActor(user.id);
        if (!await readOwnedReceipt(prisma, user.id, originalRequestId)) {
          const rejected = new StudioModuleError(error.message, error.status);
          rejected.commandOutcome = { status: 'not-applied', actorId: user.id, objectKind: 'source', id: presetId, requestId: originalRequestId as string };
          throw rejected;
        }
      } catch (proofError) {
        if (proofError instanceof StudioModuleError && proofError.commandOutcome) throw proofError;
      }
    }
    throw error;
  }
}

export async function studioPresetDeletionStatus(user: ImageStudioIdentity, presetId: string, requestId: unknown): Promise<StudioDeletionCommandStatus> {
  if (!presetId || presetId.length > 160) throw new StudioModuleError('删除查询参数无效');
  return readSharedStudioSnapshot(async tx => {
    const actor = await assertStudioActor(user.id, tx);
    const saved = await readOwnedReceipt(tx, actor.id, requestId);
    if (!saved) return { status: 'not-found' };
    const receipt = parseStudioDeletionReceipt(saved.result, actor.id, 'source', presetId);
    if (saved.fingerprint !== sharedCommandFingerprint(['delete-source', presetId, receipt.objectKind === 'source' ? receipt.sourceRevision : null])
      || receipt.requestId !== requestId) throw new StudioModuleError('原删除请求与对象不匹配，请保留原请求编号核对', 409);
    const source = await tx.imageStudioPreset.findFirst({ where: { id: presetId, owner_id: actor.id }, select: { updated_at: true } });
    return { status: 'completed', receipt, current: { exists: Boolean(source), archived: Boolean(source && await studioPresetArchived(presetId, tx)),
      sourceRevision: source?.updated_at.toISOString() ?? null } };
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

export async function setStudioPresetSharing(user: ImageStudioIdentity, presetId: string, isShared: boolean, revision?: unknown, requestId?: unknown, entryPoint?: unknown) {
  if (typeof revision !== 'string' || !revision || typeof requestId !== 'string' || !requestId) {
    throw new StudioSharingError('请刷新后再修改共享范围，需要当前模板版本和原请求编号', 428);
  }
  if (typeof isShared !== 'boolean' || !presetId || presetId.length > 160) throw new StudioSharingError('模板共享设置无效', 400);
  return prisma.$transaction(async tx => {
    user = await assertStudioActor(user.id, tx);
    const fingerprint = sharedCommandFingerprint(['set-sharing', presetId, isShared, revision]);
    const saved = await readReceipt(tx, user.id, requestId, fingerprint);
    if (saved) {
      const receipt = parseStudioSharingReceipt(saved);
      if (receipt.presetId !== presetId || receipt.requestId !== requestId || receipt.expectedRevision !== revision) {
        throw new StudioSharingError('原共享回执与请求不一致，请核对原操作', 409);
      }
      const current = await currentStudioSharing(tx, user.id, presetId);
      return { id: presetId, is_shared: current?.isShared ?? null, receipt, current };
    }
    const preset = await tx.imageStudioPreset.findUnique({ where: { id: presetId } });
    if (!preset || !canManageStudioPreset(user, preset)) {
      throw new StudioSharingError('只有模板创建者可以修改共享状态', 403, 'access-revoked');
    }
    if (await studioPresetArchived(preset.id, tx)) throw new StudioSharingError('模板已删除，请重新读取', 409, 'source-archived');
    if (revision !== preset.updated_at.toISOString()) throw new StudioSharingError('模板已在其他页面更新，请重新读取；当前草稿仍保留', 409);
    if (isShared) {
      const settingsSource = await readStudioWorkspaceSource(tx, user.id, presetId, 'preset');
      if (settingsSource?.taskSettings.sourceTaskId && !await tx.platformSetting.findUnique({ where: { key: studioSharedReproductionKey(presetId) }, select: { id: true } })) {
        await assertStudioTaskSettingsWriter(tx);
        const globalContext = await studioSettingsSourceContext(tx, user, settingsSource.taskSettings.sourceTaskId);
        await tx.platformSetting.create({ data: { key: studioSharedReproductionKey(presetId), updated_by: user.id,
          value_json: JSON.stringify({ version: 2, taskSettings: settingsSource.taskSettings, sourceOwnerId: user.id,
            sourceTaskId: settingsSource.taskSettings.sourceTaskId, moduleContext: preset.context,
            ...(settingsSource.taskSettings.mode === 'historical' ? { globalContext } : {}),
            templateFixedReferences: await getStudioPresetFixedReferences(user, preset, tx) }) } });
      }
      await resolveSharedStudioDefinition(user, presetId, tx);
      await assertPresetCoverShareable(user, presetId, tx);
    }
    const noOp = preset.is_shared === isShared;
    let beforeModuleRevision: number | null = null;
    if (!noOp) {
      const changed = await tx.imageStudioPreset.updateMany({ where: { id: presetId, owner_id: user.id, updated_at: preset.updated_at },
        data: { is_shared: isShared, updated_at: new Date(Math.max(Date.now(), preset.updated_at.getTime() + 1)) } });
      if (changed.count !== 1) throw new StudioSharingError('模板共享状态已变化，请重新读取', 409);
      const publisher = await studioPublisherModule(user.id, presetId, tx);
      if (publisher) {
        const workspace = await tx.imageStudioModule.findFirst({ where: { id: publisher, owner_id: user.id }, select: { revision: true } });
        if (!workspace) throw new StudioSharingError('作者工作区已变化，共享设置未改变，请重新读取', 409);
        beforeModuleRevision = workspace.revision;
        const updated = await tx.imageStudioModule.updateMany({ where: { id: publisher, owner_id: user.id, revision: workspace.revision }, data: { revision: { increment: 1 } } });
        if (updated.count !== 1) throw new StudioSharingError('作者工作区已变化，共享设置未改变，请重新读取', 409);
      }
    }
    const current = (await currentStudioSharing(tx, user.id, presetId))!;
    const receipt: SharedStudioSharingReceipt = { action: 'set-sharing', presetId, requestId, expectedRevision: revision,
      appliedRevision: current.sourceRevision, appliedState: { isShared, lifecycle: 'active' }, committedAt: new Date().toISOString(), noOp, moduleRevision: current.moduleRevision };
    if (!noOp) await recordStudioLifecycleEvent(tx, { actorUserId: user.id, ownerUserId: preset.owner_id, contentId: presetId,
      action: isShared ? 'sharing-enabled' : 'sharing-disabled', requestId, entryPoint,
      before: { sourceRevision: preset.updated_at.toISOString(), moduleRevision: beforeModuleRevision, isShared: preset.is_shared },
      after: { sourceRevision: current.sourceRevision, moduleRevision: current.moduleRevision, isShared } });
    await writeReceipt(tx, user.id, requestId, fingerprint, receipt);
    return { id: presetId, is_shared: current.isShared, receipt, current };
  }, { timeout: 15000 });
}

async function currentStudioSharing(tx: Prisma.TransactionClient, ownerId: string, presetId: string): Promise<SharedStudioSharingCurrent | null> {
  const source = await tx.imageStudioPreset.findFirst({ where: { id: presetId, owner_id: ownerId }, select: { id: true, is_shared: true, updated_at: true } });
  if (!source) return null;
  const publisher = await studioPublisherModule(ownerId, presetId, tx);
  const workspace = publisher ? await tx.imageStudioModule.findFirst({ where: { id: publisher, owner_id: ownerId }, select: { revision: true } }) : null;
  return { presetId, sourceRevision: source.updated_at.toISOString(), isShared: source.is_shared,
    lifecycle: await studioPresetArchived(presetId, tx) ? 'archived' : 'active', moduleRevision: workspace?.revision ?? null };
}
export async function studioSharingCommandStatus(user: ImageStudioIdentity, requestId: unknown): Promise<SharedStudioCommandStatus> {
  return readSharedStudioSnapshot(async tx => {
    const actor = await assertStudioActor(user.id, tx);
    const stored = await readOwnedReceipt(tx, actor.id, requestId);
    if (!stored) return { status: 'not-found' };
    const receipt = stored.result.action === 'set-sharing' ? parseStudioSharingReceipt(stored.result) : publicStudioReceipt(stored.result);
    return { status: 'completed', receipt, current: typeof stored.result.presetId === 'string'
      ? await currentStudioSharing(tx, actor.id, stored.result.presetId) : null };
  });
}
export async function studioPresetLifecycleHistory(user: ImageStudioIdentity, presetId: string, cursor?: string): Promise<SharedStudioLifecycleHistory> {
  return readSharedStudioSnapshot(async tx => {
    const actor = await assertStudioActor(user.id, tx);
    const source = await tx.imageStudioPreset.findFirst({ where: { id: presetId, owner_id: actor.id }, select: { id: true } });
    if (!source) throw new StudioSharingError('模板记录不存在或无权读取', 403, 'access-revoked');
    let boundary: { created_at: Date; id: string } | null = null;
    if (cursor) {
      if (cursor.length > 160) throw new StudioSharingError('记录翻页参数无效', 400);
      boundary = await tx.contentAuditLog.findFirst({ where: { id: cursor, content_type: 'image_studio_preset', content_id: presetId, owner_user_id: actor.id,
        action: { startsWith: 'studio-' } }, select: { created_at: true, id: true } });
      if (!boundary) throw new StudioSharingError('记录翻页已失效，请重新读取', 409);
    }
    const rows = await tx.contentAuditLog.findMany({ where: { content_type: 'image_studio_preset', content_id: presetId, owner_user_id: actor.id,
      action: { startsWith: 'studio-' }, ...(boundary ? { OR: [{ created_at: { lt: boundary.created_at } }, { created_at: boundary.created_at, id: { lt: boundary.id } }] } : {}) },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 21,
      select: { id: true, action: true, actor_user_id: true, owner_user_id: true, created_at: true, detail_json: true } });
    const page = rows.slice(0, 20);
    return { items: page.map(row => ({ id: row.id, action: row.action, actorUserId: row.actor_user_id, ownerUserId: row.owner_user_id,
      createdAt: row.created_at.toISOString(), detail: publicStudioLifecycleDetail(row.detail_json) })), nextCursor: rows.length > 20 ? page[page.length - 1].id : null };
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
    if (settingsSource) await writeStudioWorkspaceSource(tx, { ...settingsSource, ownerId: userId, moduleId: id });
    await setStudioModuleReferencePolicy(userId, id, referencePolicy, copiedReferenceIds, tx);
    await setStudioModuleStyleIds(user, id, styleGroupIds, tx);
    await setSkillSelection(user, id, skillIds, tx);
    await restoreStudioDefaultGroup(userId, preset.group_name, tx);
    // apply is the existing explicit template-library selection, not a refresh
    // or restoration path. Its new copy must not revive any deleted workspace id.
    await recordStudioSourceReselection(tx, userId, preset.id, id);
    return id;
  }, { timeout: 15000 });
  return studioModuleDTOForUser(user, moduleId);
}
