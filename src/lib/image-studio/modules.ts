import { prisma } from '@/lib/prisma';
import { evolutionCapability } from './evolution';
import { resolveModuleContextVersion } from './context-version';
import { archivedPresetKey, studioPresetArchived } from './preset-lifecycle';
import { normalizeStudioRatio } from './ratios';
import { getImageStudioSettings, IMAGE_STUDIO_MODELS, type ImageStudioSettings } from './settings';
import { defaultImageStudioQuality, defaultImageResolution, normalizeImageStudioQuality, normalizeImageResolution, imageStudioModelForNewSelection, type ImageResolution } from './model-catalog';
import { DEFAULT_STUDIO_PRIMARY_MAX, MAX_REFERENCE_IMAGES } from './limits';
import { canManageStudioPreset, canViewStudioPreset, type ImageStudioIdentity, type StudioPresetAccessRow } from './access';
import { studioAssetUrl, studioTemplateAssetUrl } from './media';
import { getStudioModuleFixedReferences, parseStudioFixedReferences, removeStudioModuleFixedReferences, setStudioModuleFixedReferences, StudioFixedReferenceError } from './fixed-references';
import { getStudioModuleStyleIds, getStudioStyleGroup, parseStudioStyleIds, resolveStudioStyleReferences, setStudioModuleStyleIds, studioStyleDTO, StudioStyleError } from './style-groups';
import { getSkill, getSkillSelection, setSkillSelection, skillDTO } from './skills';
import { studioVisibleAssetWhere } from './protected-assets';
import { getStudioModuleReferencePolicy, parseStudioReferencePolicy, removeStudioModuleReferencePolicy, setStudioModuleReferencePolicy, validateStudioReferenceCounts, StudioReferencePolicyError, type StudioReferencePolicy } from './reference-policy';
import { studioTemplateDefaultPolicy } from './template-defaults';
import { assertStudioActor, deleteStudioGroup, getSharedStudioPersonalOverrides, getStudioRemovedDefaultGroups, publishSharedStudioModule, readSharedStudioModules, restoreStudioDefaultGroup, saveSharedStudioPersonal, studioPublisherKey, studioSharedBinding, StudioSharingError, type SharedStudioModuleRead } from './shared-contract';
import type { SharedStudioLiveDTO } from './shared-types';
import { moduleCoverKey, studioFixedCoverDTO } from './module-cover';
import { readStudioModuleSharingPreference, writeStudioModuleSharingPreference, studioModuleSharingPreferenceKey } from './module-sharing-preference';
import { projectSharedStudioCapabilities } from './shared-capabilities';
import { readReceipt, readOwnedReceipt, writeReceipt, sharedCommandFingerprint, publicStudioReceipt } from './shared-command-storage';
import { assertStudioDeletionIdle, assertStudioWorkspaceNotDeleted, listStudioDeletedSources, parseStudioDeletionReceipt,
  recordStudioWorkspaceDeletion, studioWorkspaceDeletionCapability } from './workspace-deletion';
import type { StudioDeletionCommandStatus, StudioDeletionNotApplied, StudioDeletionReceipt } from './shared-types';

export { deleteStudioGroup };

export const defaultStudioModuleId = (ownerId: string) => `default-${ownerId}`;
export class StudioModuleError extends Error {
  commandOutcome?: { status: 'not-applied'; actorId: string; moduleId: string; requestId: string } | StudioDeletionNotApplied;
  constructor(message: string, public status = 400) { super(message); }
}
export function validStudioModuleId(id: unknown, ownerId: string): id is string {
  return typeof id === 'string' && (id === defaultStudioModuleId(ownerId) || /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id));
}

export type StudioModuleGenerationConfig = {
  model: typeof IMAGE_STUDIO_MODELS[number];
  quality: import('./model-catalog').ImageStudioQuality;
  resolution: ImageResolution;
  prices: Record<typeof IMAGE_STUDIO_MODELS[number], number | null>;
};

export function resolveStudioModuleGenerationConfig(
  row: { model?: string | null; quality?: string | null; resolution?: string | null; prices_json?: string | null } | null | undefined,
  fallback: ImageStudioSettings,
): StudioModuleGenerationConfig {
  const model = row?.model && IMAGE_STUDIO_MODELS.includes(row.model as StudioModuleGenerationConfig['model'])
    ? row.model as StudioModuleGenerationConfig['model']
    : fallback.model;
  // Prices are global rules. Keep the legacy column readable for old records,
  // but never let a module override the shared administrator setting.
  return {
    model,
    quality: normalizeImageStudioQuality(model, row?.quality),
    resolution: normalizeImageResolution(model, row?.resolution || defaultImageResolution(model)),
    prices: { ...fallback.prices },
  };
}

type StudioModuleRow = {
  id: string; name: string; prompt: string; context: string; model?: string | null; quality?: string | null; group_name?: string | null; banner_asset_id?: string | null; prices_json?: string | null; reproduce_task_id?: string | null; source_preset_id?: string | null;
  count: number; reference_limit?: number; aspect_ratio?: string; resolution?: string | null; reference_ids: string[] | string; revision: number; created_at: Date; updated_at: Date;
};

async function moduleDTO(row: StudioModuleRow, ownerId: string, settings: ImageStudioSettings, saved = true, isAdmin = false, sourcePreset?: StudioPresetAccessRow & { id: string; updated_at?: Date }, identity?: ImageStudioIdentity, sharedReads?: Map<string, SharedStudioModuleRead>) {
  const sharedRead = saved ? sharedReads?.get(row.id) ?? (await readSharedStudioModules(ownerId, [row.id])).get(row.id) : undefined;
  if (sharedRead?.binding) return sharedModuleDTO(row, ownerId, settings, sharedRead, identity);
  const ids = Array.isArray(row.reference_ids) ? row.reference_ids : JSON.parse(row.reference_ids) as string[];
  const protectedSource = !isAdmin && Boolean(row.source_preset_id) && sourcePreset?.owner_id !== ownerId;
  const fixedReferences = await getStudioModuleFixedReferences(ownerId, row.id);
  const user = identity || await prisma.user.findUniqueOrThrow({ where: { id: ownerId }, select: { id: true, role: true, account_type: true, feature_profile_id: true, feishu_user_id: true, feishu_open_id: true, feishu_union_id: true, feishu_tenant_key: true } });
  const styleGroupIds = await getStudioModuleStyleIds(ownerId, row.id);
  const skillIds = await getSkillSelection(ownerId, row.id);
  const skills = await Promise.all(skillIds.map(async id => {
    try { return skillDTO(await getSkill(user, id)); }
    catch (error) { if (error instanceof StudioStyleError && [403, 404, 409].includes(error.status)) return { id, name: 'skills不可用', unavailable: true }; throw error; }
  }));
  const styleGroups = await Promise.all(styleGroupIds.map(async id => {
    try { return await studioStyleDTO(user, await getStudioStyleGroup(user, id)); }
    catch (error) {
      if (error instanceof StudioStyleError && [404, 409].includes(error.status)) return { id, name: '风格组已删除', referenceCount: 0, canManage: false, coverUrl: null, unavailable: true };
      throw error;
    }
  }));
  let reproductionState: { fixedReferenceCount: number; skills: unknown[]; styleGroups: Array<{ id: string; name: string; referenceCount: number; coverUrl: string; canManage: false }> } | null = null;
  if (row.reproduce_task_id) {
    const sourceTask = await prisma.imageStudioTask.findFirst({ where: { id: row.reproduce_task_id, owner_id: ownerId }, select: { snapshot_json: true } });
    try {
      const snapshot = JSON.parse(sourceTask?.snapshot_json || '{}');
      reproductionState = { fixedReferenceCount: Array.isArray(snapshot.fixedReferenceImages) ? snapshot.fixedReferenceImages.length : 0,
        skills: Array.isArray(snapshot.skills) ? snapshot.skills.filter((skill: { ownerId?: unknown; prompt?: unknown }) => (isAdmin || skill.ownerId === ownerId) && typeof skill.prompt === 'string') : [],
        styleGroups: Array.isArray(snapshot.styleGroups) ? snapshot.styleGroups.filter((group: { id?: unknown; name?: unknown }) => typeof group.id === 'string' && typeof group.name === 'string')
          .map((group: { id: string; name: string; referenceCount?: number }) => ({ id: group.id, name: group.name, referenceCount: Number(group.referenceCount) || 0, coverUrl: `/api/image-studio/style-groups/${group.id}/cover`, canManage: false })) : [] };
    } catch { reproductionState = null; }
  }
  const assetIds = [...ids, ...(isAdmin ? fixedReferences.map(reference => reference.assetId) : []), ...(row.banner_asset_id ? [row.banner_asset_id] : [])];
  const assets = await prisma.asset.findMany({ where: { id: { in: assetIds }, ...(isAdmin ? {} : { owner_id: ownerId }), status: 'active', type: 'image', AND: [await studioVisibleAssetWhere(user)] },
    select: { id: true, original_url: true, thumbnail_url: true, width: true, height: true } });
  const generation = resolveStudioModuleGenerationConfig(row, settings);
  const quality = normalizeImageStudioQuality(generation.model, row.quality);
  const referenceLimit = Math.max(1, Math.min(MAX_REFERENCE_IMAGES, Number(row.reference_limit) || DEFAULT_STUDIO_PRIMARY_MAX));
  const visibleTransientIds = ids.filter(id => assets.some(asset => asset.id === id));
  let referencePolicy;
  try { referencePolicy = saved ? await getStudioModuleReferencePolicy(ownerId, row.id, visibleTransientIds, referenceLimit)
    : studioTemplateDefaultPolicy(settings.templateDefaults!); }
  catch (error) {
    if (error instanceof StudioReferencePolicyError) throw new StudioModuleError(error.message, error.status);
    throw error;
  }
  const latestTask = row.id.startsWith('default-') ? null : await prisma.imageStudioTask.findFirst({
    where: { module_id: row.id, owner_id: ownerId, status: 'succeeded', deleted_at: null, asset_id: { not: null } },
    orderBy: { finished_at: 'desc' },
    select: { asset_id: true, snapshot_json: true },
  });
  const latestResult = latestTask?.asset_id
    ? await prisma.asset.findFirst({ where: { id: latestTask.asset_id, owner_id: ownerId, status: 'active', type: 'image' }, select: { id: true } })
    : null;
  let representativeReference: string | null = null;
  try {
    const parsed = latestTask?.snapshot_json ? JSON.parse(latestTask.snapshot_json) as {
      primaryReferenceImages?: Array<{ id?: unknown }>;
      transientReferenceImages?: Array<{ id?: unknown }>;
      referenceImages?: Array<{ id?: unknown }>;
    } : null;
    const representative = parsed?.primaryReferenceImages?.[0] ?? parsed?.transientReferenceImages?.[0] ?? parsed?.referenceImages?.[0];
    if (isAdmin && typeof representative?.id === 'string') representativeReference = studioTemplateAssetUrl(representative.id, true);
  } catch { representativeReference = null; }
  const banner = row.banner_asset_id ? assets.find(item => item.id === row.banner_asset_id) : null;
  const fixedCover = saved ? await studioFixedCoverDTO(user, { kind: 'module', id: row.id }) : null;
  const sourceArchived = sourcePreset ? await studioPresetArchived(sourcePreset.id) : false;
  const state = projectSharedStudioCapabilities({ objectKind: row.source_preset_id ? 'legacy-copy' : 'local',
    lifecycle: row.source_preset_id ? sourcePreset ? sourceArchived ? 'archived' : 'active' : 'missing' : 'active',
    sharing: sourcePreset ? sourcePreset.is_shared ? 'shared' : 'private' : row.source_preset_id ? 'unknown' : 'private',
    dependency: visibleTransientIds.length === ids.length && !skills.some(item => 'unavailable' in item && item.unavailable)
      && !styleGroups.some(item => 'unavailable' in item && item.unavailable) ? 'ready' : 'invalid',
    sourceRevision: sourcePreset && canViewStudioPreset(user, sourcePreset) ? sourcePreset.updated_at?.toISOString() ?? null : null,
    moduleRevision: row.revision, definitionToken: null, actorAllowed: true, ownsWorkspace: true,
    canViewSource: !row.source_preset_id || Boolean(sourcePreset && canViewStudioPreset(user, sourcePreset)),
    canManageSource: Boolean(sourcePreset && canManageStudioPreset(user, sourcePreset)) });
  // A local definition is owned through its workspace; source management remains
  // separate for legacy copies and is never inferred from administrator status.
  if (!row.source_preset_id) {
    state.capabilities.editDefinition = state.capabilities.editPersonalDraft;
    state.capabilities.saveDefinition = state.capabilities.editPersonalDraft;
  }
  return { ...state, deletion: studioWorkspaceDeletionCapability(ownerId, row.id, row.revision, saved), id: row.id, name: row.name, prompt: row.prompt, count: row.count, referenceLimit, referencePolicy, aspectRatio: row.aspect_ratio || 'auto', resolution: generation.resolution, revision: row.revision, saved,
    model: generation.model, quality, groupName: row.group_name || '未分组', banner: banner ? { id: banner.id, originalUrl: studioTemplateAssetUrl(banner.id), thumbnailUrl: studioTemplateAssetUrl(banner.id, true), width: banner.width, height: banner.height } : null,
    fixedCover, coverEditable: saved,
    cover: !fixedCover && latestResult ? { resultUrl: studioAssetUrl(latestResult.id), thumbnailUrl: studioAssetUrl(latestResult.id, true), referenceUrl: representativeReference } : null,
    prices: generation.prices, unitCredits: generation.prices[generation.model],
    reproduceFromTaskId: row.reproduce_task_id || null, sourcePresetId: row.source_preset_id || null,
    sourcePresetShared: row.source_preset_id ? sourcePreset?.is_shared ?? null : null,
    sourcePresetOwnedByViewer: Boolean(sourcePreset && sourcePreset.owner_id === ownerId),
    sourcePresetCanManageSharing: Boolean(sourcePreset && canManageStudioPreset(user, sourcePreset) && !(await studioPresetArchived(sourcePreset.id))),
    sharingPreference: saved ? await readStudioModuleSharingPreference(ownerId, row.id) : null,
    canChooseSharing: saved && !row.id.startsWith('default-') && (!row.source_preset_id || Boolean(sourcePreset && canManageStudioPreset(user, sourcePreset) && !sourceArchived)),
    contextEditable: !protectedSource,
    evolution: evolutionCapability(row),
    fixedReferencesEditable: isAdmin && (!sourcePreset || sourcePreset.owner_id === ownerId),
    fixedReferenceCount: fixedReferences.length,
    styleGroupIds, styleGroups, skillIds, skills, reproductionState,
    contextConfigured: Boolean(row.context.trim()), context: protectedSource ? '' : row.context,
    moduleContextVersion: await resolveModuleContextVersion(row.context).catch(() => null),
    createdAt: row.created_at, updatedAt: row.updated_at,
    images: ids.flatMap(id => { const asset = assets.find(item => item.id === id); return asset ? [{ id, originalUrl: studioTemplateAssetUrl(id), thumbnailUrl: studioTemplateAssetUrl(id, true), width: asset.width, height: asset.height }] : []; }),
    fixedReferences: (isAdmin ? fixedReferences : []).map(reference => {
      const asset = assets.find(item => item.id === reference.assetId);
      const available = Boolean(asset);
      return { id: reference.assetId, originalUrl: available ? studioTemplateAssetUrl(reference.assetId) : null,
        thumbnailUrl: available ? studioTemplateAssetUrl(reference.assetId, true) : null,
        width: asset?.width || null, height: asset?.height || null, note: protectedSource ? '' : reference.note, available };
    }) };
}
async function sharedModuleDTO(row: StudioModuleRow, ownerId: string, settings: ImageStudioSettings, sharedRead: SharedStudioModuleRead, identity?: ImageStudioIdentity) {
  const actor = identity || await assertStudioActor(ownerId);
  const { binding, resolved } = sharedRead;
  if (!binding) throw new StudioModuleError('共享绑定已变化，请重新读取', 409);
  const unavailableReason = sharedRead.unavailable?.message;
  const unavailableIntent = sharedRead.unavailable?.intent;
  const ids = Array.isArray(row.reference_ids) ? row.reference_ids : JSON.parse(row.reference_ids) as string[];
  const assets = await prisma.asset.findMany({ where: { id: { in: ids }, owner_id: ownerId, status: 'active', type: 'image', AND: [await studioVisibleAssetWhere(actor)] }, select: { id: true, width: true, height: true } });
  const images = ids.flatMap(id => {
    const asset = assets.find(item => item.id === id);
    return asset ? [{ id, originalUrl: studioTemplateAssetUrl(id), thumbnailUrl: studioTemplateAssetUrl(id, true), width: asset.width, height: asset.height }] : [];
  });
  const dto = resolved?.publicDTO;
  const repairDefinition = sharedRead.repairDefinition;
  const canRepair = Boolean(repairDefinition && binding.mode === 'publisher');
  const overrides = resolved?.personalOverrides || await getSharedStudioPersonalOverrides(ownerId, row.id);
  const defaults = dto?.defaults;
  const model = overrides.model ?? defaults?.model ?? settings.model;
  const quality = normalizeImageStudioQuality(model, overrides.quality ?? defaults?.quality);
  const resolution = normalizeImageResolution(model, overrides.resolution ?? defaults?.resolution);
  const personalPolicy = await getStudioModuleReferencePolicy(ownerId, row.id, ids, defaults?.referenceLimit ?? row.reference_limit);
  const referencePolicy = defaults ? { ...defaults.referencePolicy, primaryIds: personalPolicy.primaryIds } : personalPolicy;
  const latestTask = await prisma.imageStudioTask.findFirst({ where: { module_id: row.id, owner_id: ownerId, status: 'succeeded', deleted_at: null, asset_id: { not: null } }, orderBy: { finished_at: 'desc' }, select: { asset_id: true } });
  const latestResult = latestTask?.asset_id ? await prisma.asset.findFirst({ where: { id: latestTask.asset_id, owner_id: ownerId, status: 'active', type: 'image', AND: [await studioVisibleAssetWhere(actor)] }, select: { id: true } }) : null;
  const intent = resolved?.definition.intent || unavailableIntent || { protocol: 'shared-live-v1' as const, presetId: binding.presetId, definitionToken: '' };
  const state = sharedRead.state ?? projectSharedStudioCapabilities({ objectKind: binding.mode, lifecycle: dto || repairDefinition ? 'active' : 'missing',
    sharing: dto ? dto.isShared ? 'shared' : 'private' : 'unknown', dependency: resolved ? 'ready' : canRepair ? 'invalid' : 'unknown',
    sourceRevision: dto?.revision ?? repairDefinition?.sourceRevision ?? null, moduleRevision: row.revision, definitionToken: intent.definitionToken || null,
    actorAllowed: true, ownsWorkspace: true, canViewSource: Boolean(resolved || canRepair), canManageSource: binding.mode === 'publisher' && Boolean(dto?.canManageSharing || canRepair),
    reasonCode: resolved ? null : sharedRead.unavailable?.reasonCode });
  const sharedLive: SharedStudioLiveDTO = { ...state, ...intent, intent, mode: binding.mode, available: Boolean(resolved),
    ...(unavailableReason ? { unavailableReason } : {}), overriddenFields: Object.keys(overrides) as SharedStudioLiveDTO['overriddenFields'],
    ...(defaults ? { defaults } : {}), ...(repairDefinition ? { repairDefinition } : {}) };
  const fixedCover = dto?.fixedCover ?? await studioFixedCoverDTO(actor, { kind: 'preset', id: binding.presetId });
  return { ...state, deletion: studioWorkspaceDeletionCapability(ownerId, row.id, row.revision), ...(repairDefinition ? { repairDefinition } : {}), id: row.id,
    name: dto?.name || repairDefinition?.name || row.name.trim() || `历史模板 · ${row.id.slice(0, 8)}`,
    groupName: dto?.groupName || repairDefinition?.groupName || row.group_name?.trim() || '未分组',
    prompt: overrides.prompt ?? '', personalPrompt: overrides.prompt ?? '', templatePrompt: dto?.templatePrompt ?? repairDefinition?.templatePrompt ?? '',
    context: dto?.context ?? repairDefinition?.context ?? '', contextConfigured: dto?.contextConfigured ?? Boolean(repairDefinition?.context.trim()),
    contextEditable: binding.mode === 'publisher' && (Boolean(dto?.contextEditable) || canRepair),
    fixedReferencesEditable: actor.role === 'admin' && binding.mode === 'publisher' && (Boolean(dto?.ownedByViewer) || canRepair),
    model, quality, resolution, count: overrides.count ?? defaults?.count ?? row.count,
    aspectRatio: overrides.aspectRatio ?? defaults?.aspectRatio ?? row.aspect_ratio ?? 'auto',
    referenceLimit: defaults?.referenceLimit ?? row.reference_limit ?? DEFAULT_STUDIO_PRIMARY_MAX, referencePolicy,
    revision: row.revision, saved: true, banner: dto?.banner || null,
    fixedCover,
    coverEditable: binding.mode === 'publisher' && (Boolean(dto?.coverEditable) || canRepair),
    cover: !fixedCover && latestResult ? { resultUrl: studioAssetUrl(latestResult.id), thumbnailUrl: studioAssetUrl(latestResult.id, true), referenceUrl: null } : null,
    prices: settings.prices, unitCredits: settings.prices[model], images, templateImages: dto?.images || [],
    templateReferenceIds: dto?.templateReferenceIds || [], fixedReferences: dto?.fixedReferences || [], fixedReferenceCount: dto?.fixedReferenceCount || 0,
    styleGroupIds: dto?.styleGroupIds || [], styleGroups: dto?.styleGroups || [], skillIds: [], skills: [],
    reproductionState: dto?.reproductionConfigured ? { fixedReferenceCount: dto.fixedReferenceCount, skills: [], styleGroups: dto.styleGroups } : null,
    reproduceFromTaskId: row.reproduce_task_id || null, sourcePresetId: binding.presetId,
    sourcePresetShared: state.sharing === 'unknown' ? null : state.sharing === 'shared',
    sourcePresetOwnedByViewer: sharedRead.ownedByViewer ?? dto?.ownedByViewer ?? canRepair,
    sourcePresetCanManageSharing: state.capabilities.changeSharing.allowed,
    moduleContextVersion: await resolveModuleContextVersion(dto?.context || '').catch(() => null),
    evolution: evolutionCapability({ context: dto?.context || '' }), sharedLive, createdAt: row.created_at, updatedAt: row.updated_at };
}
export async function studioModuleDTOForUser(user: ImageStudioIdentity, moduleId: string) {
  user = await assertStudioActor(user.id);
  const row = await prisma.imageStudioModule.findFirst({ where: { id: moduleId, owner_id: user.id } });
  if (!row) throw new StudioModuleError('模块不存在或无权使用', 404);
  const source = row.source_preset_id ? await prisma.imageStudioPreset.findUnique({ where: { id: row.source_preset_id }, select: { id: true, owner_id: true, scope: true, is_shared: true, updated_at: true } }) : null;
  return moduleDTO(row, user.id, await getImageStudioSettings(), true, user.role === 'admin', source || undefined, user);
}
export async function listStudioModules(ownerId: string, cursor?: string, isAdmin = false, requestedIds?: string[], identity?: ImageStudioIdentity) {
  const actor = await assertStudioActor(ownerId);
  identity = actor;
  isAdmin = actor.role === 'admin';
  const settings = await getImageStudioSettings();
  const defaultId = defaultStudioModuleId(ownerId);
  const rows = await prisma.imageStudioModule.findMany({ where: { owner_id: ownerId, id: { not: defaultId, ...(requestedIds ? { in: requestedIds } : {}) } },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }], take: 13, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
  const includeDefault = !cursor && (!requestedIds || requestedIds.includes(defaultId));
  const defaultRow = includeDefault ? await prisma.imageStudioModule.findFirst({ where: { id: defaultId, owner_id: ownerId } }) : null;
  const directory = !cursor && !requestedIds ? await prisma.imageStudioModule.findMany({
    where: { owner_id: ownerId }, orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true, group_name: true, source_preset_id: true, revision: true },
  }) : undefined;
  const sourceIds = Array.from(new Set([...(directory || []), ...rows, ...(defaultRow ? [defaultRow] : [])]
    .map(row => row.source_preset_id).filter((id): id is string => Boolean(id))));
  const sourceRows = sourceIds.length ? await prisma.imageStudioPreset.findMany({ where: { id: { in: sourceIds } },
    select: { id: true, owner_id: true, scope: true, is_shared: true, name: true, group_name: true, updated_at: true } }) : [];
  const sourceById = new Map(sourceRows.map(row => [row.id, row]));
  const archivedSources = sourceIds.length ? await prisma.platformSetting.findMany({ where: { key: { in: sourceIds.map(archivedPresetKey) } }, select: { key: true } }) : [];
  const archivedSourceIds = new Set(archivedSources.map(row => row.key));
  // Keep an old personal copy visible after sharing is turned off so its
  // already-submitted results remain discoverable. The task transaction is
  // the authoritative check for whether a new generation may start.
  const visible = rows.slice(0, 12);
  // Only the content page resolves full definitions/assets. The full directory
  // receives source metadata below and never hydrates every saved workspace.
  const sharedReads = await readSharedStudioModules(ownerId, [...visible, ...(defaultRow ? [defaultRow] : [])].map(row => row.id));
  const modules = await Promise.all(visible.map(row => moduleDTO(row, ownerId, settings, true, isAdmin, row.source_preset_id ? sourceById.get(row.source_preset_id) : undefined, identity, sharedReads)));
  if (includeDefault) {
    const defaults = settings.templateDefaults;
    modules.unshift(await moduleDTO(defaultRow || { id: defaultId, name: '模块 1', prompt: '', context: '',
      model: defaults.model, quality: defaults.quality, resolution: defaults.resolution, count: defaults.count,
      aspect_ratio: defaults.aspectRatio, reference_limit: defaults.primaryMax, reference_ids: [], revision: 0, created_at: new Date(0), updated_at: new Date(0) }, ownerId, settings, Boolean(defaultRow), isAdmin, defaultRow?.source_preset_id ? sourceById.get(defaultRow.source_preset_id) : undefined, identity, sharedReads));
  }
  // Navigation must describe all saved modules, not just the first content page.
  const projectedDirectory = directory ? await Promise.all(directory.map(async item => {
    const sharedRead = sharedReads.get(item.id);
    const binding = sharedRead ? sharedRead.binding : await studioSharedBinding(ownerId, item.id);
    if (binding && binding.presetId !== item.source_preset_id) throw new StudioSharingError('共享模板工作区来源不匹配', 409);
    const source = item.source_preset_id ? sourceById.get(item.source_preset_id) : undefined;
    const archived = Boolean(source && archivedSourceIds.has(archivedPresetKey(source.id)));
    const canViewSource = !item.source_preset_id || Boolean(source && canViewStudioPreset(actor, source));
    const canManageSource = Boolean(source && canManageStudioPreset(actor, source) && (!binding || binding.mode === 'publisher'));
    const reasonCode = !item.source_preset_id ? null : !source ? 'source-missing' as const
      : archived && canViewSource ? 'source-archived' as const : !canViewSource ? source.is_shared ? 'access-revoked' as const : 'source-withdrawn' as const
      : binding?.mode === 'publisher' && source.owner_id !== ownerId ? 'access-revoked' as const : null;
    const state = sharedRead?.state ?? projectSharedStudioCapabilities({ objectKind: binding?.mode ?? (item.source_preset_id ? 'legacy-copy' : 'local'),
      lifecycle: source ? archived ? 'archived' : 'active' : item.source_preset_id ? 'missing' : 'active',
      sharing: source ? source.is_shared ? 'shared' : 'private' : item.source_preset_id ? 'unknown' : 'private', dependency: 'unknown', reasonCode,
      sourceRevision: source && canViewSource ? source.updated_at.toISOString() : null, moduleRevision: item.revision, definitionToken: null,
      actorAllowed: true, ownsWorkspace: true, canViewSource, canManageSource });
    const deletion = studioWorkspaceDeletionCapability(ownerId, item.id, item.revision);
    if (!binding) return { ...state, deletion, id: item.id, name: item.name.trim() || `历史模板 · ${item.id.slice(0, 8)}`,
      groupName: item.group_name?.trim() || '未分组', sourcePresetId: item.source_preset_id,
      sourcePresetShared: source ? source.is_shared : item.source_preset_id ? null : false, revision: item.revision, canManageGroup: true, coverEditable: true };
    const resolved = sharedRead?.resolved;
    const repair = sharedRead?.repairDefinition;
    const intent = resolved?.definition.intent || sharedRead?.unavailable?.intent || { protocol: 'shared-live-v1' as const, presetId: binding.presetId, definitionToken: '' };
    // For unhydrated navigation only, the compatibility flag describes the
    // source's current authorization/lifecycle. Unknown dependencies never grant
    // generate; opening the workspace still performs the full strict read.
    const available = sharedRead ? Boolean(resolved) : canViewSource && !archived && reasonCode === null;
    const sharedLive: SharedStudioLiveDTO = { ...state, ...intent, intent, mode: binding.mode, available,
      overriddenFields: Object.keys(resolved?.personalOverrides || {}) as SharedStudioLiveDTO['overriddenFields'],
      ...(resolved ? { defaults: resolved.publicDTO.defaults } : {}),
      ...(sharedRead?.unavailable ? { unavailableReason: sharedRead.unavailable.message } : {}) };
    const legalNavigationSource = source && canViewSource && !archived ? source : null;
    const canManageGroup = binding.mode === 'publisher' && canManageSource && !archived;
    return { ...state, deletion, id: item.id, name: resolved?.definition.name || repair?.name || legalNavigationSource?.name || item.name.trim() || `历史模板 · ${item.id.slice(0, 8)}`,
      groupName: resolved?.definition.groupName || repair?.groupName || legalNavigationSource?.group_name || item.group_name?.trim() || '未分组',
      sourcePresetId: binding.presetId, sourcePresetShared: state.sharing === 'unknown' ? null : state.sharing === 'shared',
      sourcePresetOwnedByViewer: source?.owner_id === ownerId, coverEditable: canManageGroup, revision: item.revision, canManageGroup, sharedLive,
      ...(sharedRead?.unavailable || reasonCode ? { unavailable: true } : {}) };
  })) : undefined;
  return { modules, nextCursor: rows.length > 12 ? visible[visible.length - 1].id : null,
    removedDefaultGroups: await getStudioRemovedDefaultGroups(ownerId),
    deletedSourcePresetIds: (await listStudioDeletedSources(ownerId)).filter(item => !item.reopenedModuleId).map(item => item.presetId),
    ...(directory ? { directory: [
      ...(directory.some(item => item.id === defaultId) ? [] : [{ id: defaultId, name: '模块 1', groupName: '未分组',
        deletion: studioWorkspaceDeletionCapability(ownerId, defaultId, 0, false) }]),
      ...projectedDirectory!,
    ] } : {}) };
}
export async function deleteStudioModule(ownerId: string, id: unknown, revision: unknown, requestId?: unknown): Promise<StudioDeletionReceipt> {
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(requestId)) {
    throw new StudioModuleError('请刷新页面后删除，并保留有效的原请求编号', 428);
  }
  if (!validStudioModuleId(id, ownerId) || !Number.isSafeInteger(revision) || Number(revision) < 0) throw new StudioModuleError('模板参数无效');
  if (id === defaultStudioModuleId(ownerId)) throw new StudioModuleError('默认模板需要保留，请删除其他模板');
  // The old server-call shape remains callable, but cannot perform an
  // unreceipted deletion. Never synthesize a new request id on the caller's behalf.
  const originalRequestId = requestId;
  const fingerprint = sharedCommandFingerprint(['delete-module', id, revision]);
  try {
    return await prisma.$transaction(async tx => {
      await assertStudioActor(ownerId, tx);
      const prior = await readReceipt(tx, ownerId, originalRequestId, fingerprint);
      if (prior) return parseStudioDeletionReceipt(prior, ownerId, 'workspace', id);
      const current = await tx.imageStudioModule.findFirst({ where: { id, owner_id: ownerId } });
      if (!current) throw new StudioModuleError('工作区不存在或已删除，请核对原请求结果', 409);
      await assertStudioWorkspaceNotDeleted(ownerId, id, tx);
      if (current.revision !== revision) throw new StudioModuleError('模板已更新，请刷新后再删除', 409);
      await assertStudioDeletionIdle(tx, ownerId, id);
      const binding = await studioSharedBinding(ownerId, id, tx);
      if (binding && binding.presetId !== current.source_preset_id) throw new StudioModuleError('模板来源绑定已变化，请重新读取后删除', 409);
      // Remove only configuration owned through this verified workspace. Source
      // definitions, assets, tasks, receipts and their history are independent.
      await removeStudioModuleFixedReferences(ownerId, id, tx);
      await removeStudioModuleReferencePolicy(ownerId, id, tx);
      if (binding?.mode === 'publisher') {
        const pointer = await tx.platformSetting.findUnique({ where: { key: studioPublisherKey(binding.presetId) }, select: { value_json: true } });
        if (pointer) {
          let publisher: { ownerId?: unknown; moduleId?: unknown; presetId?: unknown; protocol?: unknown };
          try { publisher = JSON.parse(pointer.value_json); } catch { throw new StudioModuleError('模板创建者绑定无法确认', 409); }
          if (!publisher || publisher.ownerId !== ownerId || publisher.moduleId !== id || publisher.presetId !== binding.presetId || publisher.protocol !== binding.protocol) {
            throw new StudioModuleError('模板创建者绑定已变化，请重新读取后删除', 409);
          }
          await tx.platformSetting.deleteMany({ where: { key: studioPublisherKey(binding.presetId), value_json: pointer.value_json } });
        }
      }
      await tx.platformSetting.deleteMany({ where: { key: { in: [`studio_style_selection_v1:${id}`, `studio_skill_selection_v1:module:${id}`,
        `studio_quick_presets_v1:${id}`, moduleCoverKey({ kind: 'module', id }),
        `studio_shared_binding_v1:${id}`, `studio_shared_overrides_v1:${id}`, studioModuleSharingPreferenceKey(id)] } } });
      const changed = await tx.imageStudioModule.deleteMany({ where: { id, owner_id: ownerId, revision: current.revision } });
      if (changed.count !== 1) throw new StudioModuleError('模板已更新，请重新读取后删除', 409);
      const committedAt = new Date().toISOString();
      await recordStudioWorkspaceDeletion(tx, ownerId, id, current.revision, current.source_preset_id,
        originalRequestId as string, committedAt);
      const result: StudioDeletionReceipt = { version: 1, actorId: ownerId, deleted: true, objectKind: 'workspace', id,
        moduleRevision: current.revision, sourcePresetId: current.source_preset_id,
        requestId: originalRequestId as string, committedAt, noOp: false };
      await writeReceipt(tx, ownerId, originalRequestId, fingerprint, { ...result, action: 'delete-module' });
      return result;
    });
  } catch (error) {
    // Only a known business rejection from the rolled-back transaction may
    // unlock this command. Transport/DB errors and any original own receipt stay unknown.
    if (error instanceof StudioModuleError || error instanceof StudioSharingError) {
      try {
        await assertStudioActor(ownerId);
        if (!await readOwnedReceipt(prisma, ownerId, originalRequestId)) {
          const rejected = new StudioModuleError(error.message, error.status);
          rejected.commandOutcome = { status: 'not-applied', actorId: ownerId, objectKind: 'workspace', id, requestId: originalRequestId as string };
          throw rejected;
        }
      } catch (proofError) {
        if (proofError instanceof StudioModuleError && proofError.commandOutcome) throw proofError;
      }
    }
    throw error;
  }
}

export async function studioModuleDeletionStatus(ownerId: string, id: unknown, requestId: unknown): Promise<StudioDeletionCommandStatus> {
  if (!validStudioModuleId(id, ownerId)) throw new StudioModuleError('删除查询参数无效');
  return prisma.$transaction(async tx => {
    await assertStudioActor(ownerId, tx);
    const saved = await readOwnedReceipt(tx, ownerId, requestId);
    if (!saved) return { status: 'not-found' };
    const receipt = parseStudioDeletionReceipt(saved.result, ownerId, 'workspace', id);
    if (saved.fingerprint !== sharedCommandFingerprint(['delete-module', id, receipt.objectKind === 'workspace' ? receipt.moduleRevision : null])
      || receipt.requestId !== requestId) throw new StudioModuleError('原删除请求与对象不匹配，请保留原请求编号核对', 409);
    const current = await tx.imageStudioModule.findFirst({ where: { id, owner_id: ownerId }, select: { revision: true } });
    return { status: 'completed', receipt, current: { exists: Boolean(current), moduleRevision: current?.revision ?? null } };
  });
}

export async function saveStudioModule(ownerId: string, body: Record<string, unknown>, createOnly = false, isAdmin = false, forcedSourcePresetId?: string, sourceIdentity?: ImageStudioIdentity) {
  if (!body || !validStudioModuleId(body.id, ownerId)) throw new StudioModuleError('模块编号无效');
  const id = body.id;
  const actor = await assertStudioActor(ownerId);
  isAdmin = actor.role === 'admin';
  sourceIdentity = actor;
  const binding = await studioSharedBinding(ownerId, id);
  if (!createOnly && body.saveIntent === 'definition') {
    let published: Awaited<ReturnType<typeof publishSharedStudioModule>>;
    try {
      published = await publishSharedStudioModule(actor, id, { ...body, requestId: body.requestId, expectedRevision: body.revision });
    } catch (error) {
      // The awaited standalone publish transaction has rolled back a known
      // business rejection. A post-commit DTO read is deliberately OUTSIDE this
      // catch. Neither transport/Prisma uncertainty nor a prior own receipt can
      // be labelled not-applied, even when the HTTP status looks recoverable.
      const businessRejected = error instanceof StudioSharingError || error instanceof StudioFixedReferenceError
        || error instanceof StudioReferencePolicyError || error instanceof StudioStyleError;
      let noOriginalReceipt = false;
      if (businessRejected && Object.prototype.hasOwnProperty.call(body, 'fixedReferenceRepairs')
        && typeof body.requestId === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(body.requestId)) {
        try {
          const fresh = await assertStudioActor(ownerId);
          noOriginalReceipt = !await readOwnedReceipt(prisma, fresh.id, body.requestId);
        } catch { /* An unreadable receipt or revoked identity remains unknown. */ }
      }
      if (businessRejected && noOriginalReceipt) {
        const rejected = new StudioModuleError(error.message, error.status);
        rejected.commandOutcome = { status: 'not-applied', actorId: ownerId, moduleId: id, requestId: body.requestId as string };
        throw rejected;
      }
      throw error;
    }
    const dto = await studioModuleDTOForUser(actor, id);
    return Object.prototype.hasOwnProperty.call(body, 'fixedReferenceRepairs')
      ? { ...dto, commandReceipt: { ...publicStudioReceipt(published.receipt), requestId: body.requestId } } : dto;
  }
  if (!createOnly && binding) {
    if (body.saveIntent !== 'personal') throw new StudioModuleError('请明确保存个人输入或模板定义，当前草稿仍保留', 400);
    await saveSharedStudioPersonal(actor, id, body);
    return studioModuleDTOForUser(actor, id);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'fixedReferenceRepairs')) throw new StudioModuleError('固定参考修复须通过本人已有原模板的定义保存', 403);
  if (body.saveIntent !== undefined && body.saveIntent !== 'personal') throw new StudioModuleError('模板保存意图无效', 400);
  let aspectRatio: string | undefined;
  try { if (body.aspectRatio !== undefined) aspectRatio = normalizeStudioRatio(body.aspectRatio); }
  catch (error) { throw new StudioModuleError((error as Error).message); }
  if (body.context !== undefined && (typeof body.context !== 'string' || body.context.length > 20000)) throw new StudioModuleError('模块上下文最多 20000 字');
  const model = body.model === undefined ? undefined : body.model;
  if (model !== undefined && !IMAGE_STUDIO_MODELS.includes(model as typeof IMAGE_STUDIO_MODELS[number])) {
    throw new StudioModuleError('模块模型无效');
  }
  const quality = body.quality === undefined ? undefined : body.quality;
  if (quality !== undefined && typeof quality !== 'string') throw new StudioModuleError('图片质量设置无效');
  const groupName = body.groupName === undefined ? undefined : body.groupName;
  if (groupName !== undefined && (typeof groupName !== 'string' || groupName.trim().length > 40)) throw new StudioModuleError('模块分组名称最多 40 字');
  const bannerAssetId = body.bannerAssetId === undefined ? undefined : body.bannerAssetId;
  if (bannerAssetId !== undefined && bannerAssetId !== null && (typeof bannerAssetId !== 'string' || bannerAssetId.length > 100)) throw new StudioModuleError('模块 banner 图片无效');
  const reproduceFromTaskId = body.reproduceFromTaskId === undefined ? undefined : body.reproduceFromTaskId;
  if (reproduceFromTaskId !== undefined && reproduceFromTaskId !== null
    && (typeof reproduceFromTaskId !== 'string' || reproduceFromTaskId.length > 120)) throw new StudioModuleError('历史生成记录无效');
  const name = createOnly ? '未命名模块' : body.name;
  const prompt = createOnly ? '' : body.prompt;
  const count = createOnly ? 1 : body.count;
  const ids = createOnly ? [] : body.referenceIds;
  if (!Array.isArray(ids) || ids.length > MAX_REFERENCE_IMAGES || ids.some(item => typeof item !== 'string' || !item || item.length > 100)) throw new StudioModuleError(`模块内容无效，请检查名称、张数和参考图片（最多 ${MAX_REFERENCE_IMAGES} 张）`);
  let referencePolicy: StudioReferencePolicy | undefined;
  if (!createOnly && body.referencePolicy !== undefined) {
    try { referencePolicy = parseStudioReferencePolicy(body.referencePolicy, ids as string[]); }
    catch (error) {
      if (error instanceof StudioReferencePolicyError) throw new StudioModuleError(error.message, error.status);
      throw error;
    }
  }
  const savedModuleLimit = !createOnly && body.referenceLimit === undefined && !referencePolicy
    ? await prisma.imageStudioModule.findFirst({ where: { id, owner_id: ownerId }, select: { reference_limit: true } })
    : null;
  const referenceLimitValue = createOnly ? DEFAULT_STUDIO_PRIMARY_MAX
    : body.referenceLimit !== undefined ? body.referenceLimit
      : referencePolicy?.primaryMax ?? savedModuleLimit?.reference_limit ?? DEFAULT_STUDIO_PRIMARY_MAX;
  const referenceLimit = Number(referenceLimitValue);
  let fixedReferences: ReturnType<typeof parseStudioFixedReferences> | undefined;
  if (body.fixedReferences !== undefined) {
    if (!isAdmin) throw new StudioModuleError('固定模板图只能由管理员修改', 403);
    try { fixedReferences = parseStudioFixedReferences(body.fixedReferences); }
    catch (error) { throw new StudioModuleError((error as Error).message); }
  }
  const revision = createOnly ? 0 : body.revision;
  if (typeof name !== 'string' || !name.trim() || name.length > 80 || typeof prompt !== 'string' || prompt.length > 20000
    || !Number.isInteger(count) || Number(count) < 1 || Number(count) > 8 || !Number.isInteger(referenceLimit) || referenceLimit < 1 || referenceLimit > MAX_REFERENCE_IMAGES
    || !Number.isInteger(revision) || Number(revision) < 0) throw new StudioModuleError(`模块内容无效，请检查名称、张数和参考图片（最多 ${MAX_REFERENCE_IMAGES} 张）`);
  if (!referencePolicy && (ids as string[]).length > referenceLimit) {
    throw new StudioModuleError(`旧版保存请求最多支持 ${referenceLimit} 张参考图`);
  }
  const row = await prisma.$transaction(async tx => {
    const identity = await assertStudioActor(ownerId, tx);
    await assertStudioWorkspaceNotDeleted(ownerId, id, tx);
    if (fixedReferences !== undefined && identity.role !== 'admin') throw new StudioModuleError('固定模板图只能由管理员修改', 403);
    const current = await tx.imageStudioModule.findUnique({ where: { id } });
    if (current && current.owner_id !== ownerId) throw new StudioModuleError('无权修改这个模块', 403);
    if (current && createOnly) return current;
    if (await studioSharedBinding(ownerId, id, tx)) throw new StudioModuleError('模块已绑定共享原件，请重新读取后明确保存个人输入或模板定义', 409);
    if ((current?.revision || 0) !== revision) throw new StudioModuleError('模块已在其他页面保存，请刷新后核对；当前草稿仍在本页', 409);
    if (current?.source_preset_id && fixedReferences !== undefined) {
      const source = await tx.imageStudioPreset.findUnique({ where: { id: current.source_preset_id }, select: { owner_id: true } });
      if (source?.owner_id !== ownerId) throw new StudioModuleError('共享模板固定图由原模板管理，不能在副本中修改', 403);
    }
    let protectedSource = false;
    if (current?.source_preset_id && identity.role !== 'admin') {
      const source = await tx.imageStudioPreset.findUnique({ where: { id: current.source_preset_id }, select: { owner_id: true } });
      protectedSource = !source || source.owner_id !== ownerId;
      if (protectedSource) {
        const currentFixedReferences = fixedReferences === undefined ? [] : await getStudioModuleFixedReferences(ownerId, id, tx);
        const contextMatches = body.context === undefined || body.context === current.context;
        const fixedReferencesMatch = fixedReferences === undefined || (fixedReferences.length === currentFixedReferences.length
          && fixedReferences.every((reference, index) => reference.assetId === currentFixedReferences[index].assetId && reference.note === currentFixedReferences[index].note));
        if (!contextMatches || !fixedReferencesMatch) throw new StudioModuleError('共享模板的内部上下文和固定参考图只能由创建者修改', 403);
        fixedReferences = undefined;
      }
    }
    const assets = await tx.asset.count({ where: { id: { in: ids as string[] }, owner_id: ownerId, type: 'image', status: 'active', AND: [await studioVisibleAssetWhere(identity, tx)] } });
    if (assets !== new Set(ids as string[]).size) throw new StudioModuleError('参考图片已不可用或无权使用', 403);
    if (reproduceFromTaskId) {
      const source = await tx.imageStudioTask.findFirst({ where: { id: reproduceFromTaskId, owner_id: ownerId, snapshot_json: { not: null } }, select: { id: true } });
      if (!source) throw new StudioModuleError('历史生成记录不存在或无权复现', 403);
    }
    // Read new-module defaults inside this transaction, never re-resolve old saved contracts.
    const settings = await getImageStudioSettings(tx);
    const defaults = settings.templateDefaults;
    const initializeDefaults = !current && createOnly && !forcedSourcePresetId;
    if (initializeDefaults) referencePolicy = studioTemplateDefaultPolicy(defaults);
    const selectedModel = initializeDefaults ? imageStudioModelForNewSelection(defaults.model) : model || current?.model || settings.model;
    const selectedQuality = quality !== undefined
      ? normalizeImageStudioQuality(String(selectedModel), String(quality))
      : initializeDefaults
        ? defaults.quality
        : createOnly ? defaultImageStudioQuality(String(selectedModel))
        : normalizeImageStudioQuality(String(selectedModel), current?.quality);
    const selectedResolution = initializeDefaults ? defaults.resolution : normalizeImageResolution(String(selectedModel), body.resolution !== undefined ? body.resolution : current?.resolution);
    const data = { name: name.trim(), prompt, count: initializeDefaults ? defaults.count : Number(count),
      reference_limit: initializeDefaults ? defaults.primaryMax : referenceLimit, reference_ids: JSON.stringify(ids), revision: Number(revision) + 1,
      ...(initializeDefaults ? { aspect_ratio: defaults.aspectRatio } : aspectRatio !== undefined ? { aspect_ratio: aspectRatio } : {}),
      ...(initializeDefaults ? { model: selectedModel } : model !== undefined ? { model: model as string } : {}),
      quality: initializeDefaults ? defaults.quality : selectedQuality, resolution: selectedResolution,
      ...(groupName !== undefined ? { group_name: groupName.trim() || '未分组' } : {}),
      ...(bannerAssetId !== undefined ? { banner_asset_id: bannerAssetId } : {}),
      ...(reproduceFromTaskId !== undefined ? { reproduce_task_id: reproduceFromTaskId } : {}),
      ...(forcedSourcePresetId !== undefined ? { source_preset_id: forcedSourcePresetId } : {}),
      ...(typeof body.context === 'string' && !protectedSource ? { context: body.context } : {}) };
    if (bannerAssetId) {
      const banner = await tx.asset.findFirst({ where: { id: bannerAssetId, owner_id: ownerId, type: 'image', status: 'active' }, select: { id: true } });
      if (!banner) throw new StudioModuleError('banner 图片不存在或无权使用', 403);
    }
    if (forcedSourcePresetId) {
      const source = await tx.imageStudioPreset.findUnique({ where: { id: forcedSourcePresetId }, select: { id: true, owner_id: true, scope: true, is_shared: true } });
      const sourceUser = sourceIdentity || { id: ownerId, role: isAdmin ? 'admin' : 'user', account_type: 'internal', feishu: null } as const;
      if (!source || !canViewStudioPreset(sourceUser, source)) throw new StudioModuleError('模板已停止共享，不能保存新的配置', 403);
    }
    const saved = !current
      ? await tx.imageStudioModule.create({ data: { id, owner_id: ownerId, ...data } })
      : await (async () => {
        const changed = await tx.imageStudioModule.updateMany({ where: { id, owner_id: ownerId, revision: Number(revision) }, data });
        if (!changed.count) throw new StudioModuleError('模块已在其他页面保存，请刷新后核对', 409);
        return tx.imageStudioModule.findUniqueOrThrow({ where: { id } });
      })();
    // Only the explicit new-template action opts in. Old modules and the
    // automatically initialized default workspace never change visibility.
    if (initializeDefaults && !id.startsWith('default-')) {
      await writeStudioModuleSharingPreference({ version: 1, ownerId, moduleId: id, enabled: body.sharingDefault !== false, revision: 1 }, tx,
        { entryPoint: body.entryPoint, beforeModuleRevision: 0, afterModuleRevision: saved.revision });
    }
    if (fixedReferences) {
      try { await setStudioModuleFixedReferences(ownerId, id, fixedReferences, tx); }
      catch (error) {
        if (error instanceof StudioFixedReferenceError) throw new StudioModuleError(error.message, error.status);
        throw error;
      }
    }
    if (referencePolicy) {
      try { await setStudioModuleReferencePolicy(ownerId, id, referencePolicy, ids as string[], tx); }
      catch (error) {
        if (error instanceof StudioReferencePolicyError) throw new StudioModuleError(error.message, error.status);
        throw error;
      }
    }
    try {
      if (body.styleGroupIds !== undefined) await setStudioModuleStyleIds(identity, id, body.styleGroupIds, tx);
      if (body.skillIds !== undefined) await setSkillSelection(identity, id, body.skillIds, tx);
      const selectedIds = body.styleGroupIds === undefined ? await getStudioModuleStyleIds(ownerId, id, tx) : parseStudioStyleIds(body.styleGroupIds);
      const selected = await resolveStudioStyleReferences(identity, selectedIds, tx);
      const fixed = await getStudioModuleFixedReferences(ownerId, id, tx);
      const effectivePolicy = referencePolicy || await getStudioModuleReferencePolicy(ownerId, id, ids as string[], referenceLimit, tx);
      validateStudioReferenceCounts(effectivePolicy, ids as string[], fixed.length, selected.references.length);
    } catch (error) {
      if (error instanceof StudioStyleError || error instanceof StudioReferencePolicyError) throw new StudioModuleError(error.message, error.status);
      throw error;
    }
    if (groupName !== undefined) await restoreStudioDefaultGroup(ownerId, groupName.trim() || '未分组', tx);
    return saved;
  }, { timeout: 15000 });
  const source = row.source_preset_id ? await prisma.imageStudioPreset.findUnique({ where: { id: row.source_preset_id }, select: { id: true, owner_id: true, scope: true, is_shared: true, updated_at: true } }) : undefined;
  return moduleDTO(row, ownerId, await getImageStudioSettings(), true, isAdmin, source || undefined, sourceIdentity);
}

export async function chooseStudioModuleSharing(ownerId: string, body: Record<string, unknown>) {
  if (!validStudioModuleId(body.id, ownerId) || body.id.startsWith('default-') || typeof body.isShared !== 'boolean'
    || typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(body.requestId)
    || !Number.isInteger(body.revision)) throw new StudioModuleError('共享设置参数无效');
  const id = body.id;
  const receipt = await prisma.$transaction(async tx => {
    const actor = await assertStudioActor(ownerId, tx);
    const fingerprint = sharedCommandFingerprint(['set-sharing-preference', id, body.isShared, body.revision]);
    const saved = await readReceipt(tx, ownerId, body.requestId, fingerprint);
    if (saved) return saved;
    const current = await tx.imageStudioModule.findFirst({ where: { id, owner_id: ownerId } });
    if (!current) throw new StudioModuleError('模板不存在或无权设置共享', 403);
    if (await studioSharedBinding(ownerId, id, tx)) throw new StudioModuleError('模板已发布，请重新读取后设置共享范围', 409);
    if (current.source_preset_id) {
      const source = await tx.imageStudioPreset.findUnique({ where: { id: current.source_preset_id } });
      if (!source || !canManageStudioPreset(actor, source) || await studioPresetArchived(source.id, tx)) {
        throw new StudioSharingError('当前账号不能设置这个模板的共享选择', 403, 'access-revoked');
      }
    }
    const previous = await readStudioModuleSharingPreference(ownerId, id, tx);
    if (previous && previous.requestId === body.requestId) {
      throw new StudioModuleError('旧共享选择缺少可核对的原请求回执，请读取后重新确认，不会重复写入', 409);
    }
    if (current.revision !== body.revision) throw new StudioModuleError('模板已在其他页面更新，当前输入保留，请重新核对共享设置', 409);
    if (previous?.enabled === body.isShared) {
      const result = { action: 'set-sharing-preference', requestId: body.requestId, moduleId: id, revision: current.revision,
        expectedRevision: current.revision, noOp: true, committedAt: new Date().toISOString() };
      await writeReceipt(tx, ownerId, body.requestId, fingerprint, result);
      return result;
    }
    const changed = await tx.imageStudioModule.updateMany({ where: { id, owner_id: ownerId, revision: Number(body.revision) }, data: { revision: { increment: 1 } } });
    if (changed.count !== 1) throw new StudioModuleError('模板已在其他页面更新，当前输入保留，请重新核对共享设置', 409);
    await writeStudioModuleSharingPreference({ version: 1, ownerId, moduleId: id, enabled: body.isShared as boolean,
      revision: (previous?.revision || 0) + 1, requestId: body.requestId as string }, tx,
      { entryPoint: body.entryPoint, beforeModuleRevision: current.revision, afterModuleRevision: current.revision + 1 });
    const result = { action: 'set-sharing-preference', requestId: body.requestId, moduleId: id, revision: current.revision + 1,
      expectedRevision: current.revision, noOp: false, committedAt: new Date().toISOString() };
    await writeReceipt(tx, ownerId, body.requestId, fingerprint, result);
    return result;
  });
  const actor = await assertStudioActor(ownerId);
  return { ...await studioModuleDTOForUser(actor, id), sharingCommandReceipt: publicStudioReceipt(receipt) };
}
