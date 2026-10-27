import { createHash, randomUUID } from 'node:crypto';
import { readPrivateStudioDefinition, transformPrivateImageTask } from './private-storage.server';
import { isStoredPrivatePrompt, privateOrigin } from '@/lib/security/private-prompts.server';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { compileCanvasPromptReferences, parseCanvasPromptMentions } from '@/lib/canvas-prompt-references';
import { bindModuleContextVersion, MODULE_CONTEXT_VERSION_RULE, snapshotModuleContextVersion, withContextVersionRetry } from './context-version';
import type { ImageStudioTask, Prisma } from '@prisma/client';
import { studioDeliveryStatus } from './delivery';
import { ACTIVE_IMAGE_TASK_STATUSES, QueueCapacityError, QueueMaintenanceError, reserveImageStudioQueueCapacity } from './queue-capacity';
import { prisma } from '@/lib/prisma';
import { assertUsageProject, inheritUsageAttribution, parseUsageProjectId, recordUsageAttribution } from '@/lib/admin/usage-attribution';
import { allocateTaskCredits, settleTaskCredits } from '@/lib/credits/policy';
import { getImageStudioSettings } from './settings';
import { parseStudioTaskSettings, StudioTaskSettingsError } from './task-settings';
import { assertStudioTaskSettingsWrite, assertStudioTaskSettingsWriter, readStudioWorkspaceSource, studioSettingsSourceContext, STUDIO_TASK_SETTINGS_FILES } from './task-settings-storage';
import { imageBillingScope } from './billing-scope';
import { fixedImageBillingContract, imageSpecification, withPricingImageContract } from './billing-quote';
import { quotePricingCharge, assertNewPricingCharge } from '@/lib/pricing/charge';
import { assertNoSynchronousImageAdmission, SynchronousImageAdmissionError } from './synchronous-admission';
import { samePricingImageCharge, withImagePricing } from '@/lib/pricing/image';
import { creditCents, sumCredits } from '@/lib/credits/precision';
import { studioTaskState, studioTaskStates, publicPricingTaskState, studioBillingState, isPricingImageTask } from './pricing-state';
import { assertPricingImageConsumerReady } from '@/lib/pricing/runtime';
import { imageBillingView, parseImageBillingContract, type ImageBillingContract } from './billing-contract';
import { consumeImageQuote } from './billing-quote-store';
import { imageBillingReady } from './billing-readiness';
import { captureImageGenerationChannel, resolveImageGenerationChannelSnapshot, validateImageGenerationChannel, imageGenerationModelOutputSize, imageGenerationSupportsStudioFourToOne,
  getImageGenerationSettingsForModel, isImageGenerationApiReady, isStudioImageGenerationProvider, isMuskImageGenerationChannel, ImageGenerationChannelError,
  type ImageGenerationChannelSnapshot } from '@/lib/integrations/image-generation';
import { resolveImageGenerationRequestChannel, resolveImageGenerationRequestRoute } from '@/lib/integrations/image-generation-defaults';
import { IMAGE_25_QUALITY_MODEL, parseImageQualityRouteSnapshot, assertImageQualityReferenceCount } from './quality-routing';
import { defaultStudioModuleId, resolveStudioModuleGenerationConfig, validStudioModuleId } from './modules';
import { canUseCompanyTemplates, canViewStudioPreset, type ImageStudioIdentity } from './access';
import { resolveStudioAspectRatio, normalizeStudioRatio, CURRENT_STUDIO_SIZE_POLICY_VERSION, type StudioSizePolicyVersion } from './ratios';
import { normalizeImageResolution, IMAGE_RESOLUTION_OPTIONS, studioFourToOneIssue } from '@/lib/image-generation/resolution';
import { MAX_REFERENCE_IMAGES } from './limits';
import { IMAGE_STUDIO_MODEL_COST_USD, IMAGE_STUDIO_MODELS, IMAGE_STUDIO_MODEL_QUALITY_OPTIONS } from './model-catalog';
import { studioAssetUrl, studioTemplateAssetUrl } from './media';
import { displayUserName } from '@/lib/users/display';
import { getStudioModuleFixedReferences, parseStudioFixedReferences, type StudioFixedReference } from './fixed-references';
import { getStudioModuleStyleIds, parseStudioStyleIds, resolveStudioStyleReferences, StudioStyleError } from './style-groups';
import { studioVisibleAssetWhere } from './protected-assets';
import { defaultStudioReferencePolicy, getStudioModuleReferencePolicy, mapStudioReferencePolicy, parseStudioReferencePolicy, validateStudioReferenceCounts, StudioReferencePolicyError, type StudioReferencePolicy } from './reference-policy';
import { DEFAULT_STUDIO_PRIMARY_MAX } from './limits';
import type { AvatarCandidate, AvatarLayout } from '@/lib/avatar-random/types';
import { isAvatarSheet, validateSheetCandidates } from '@/lib/avatar-random/layout';
import { evolutionCapability, parseEvolution, resolveEvolution, evolutionInstructions } from './evolution';
import { studioTemplateTaskWhere } from './task-visibility';
import { getSkillSelection, historicalSkills, parseSkillIds, resolveSkills, publicSkillVersion, publicSkillSnapshot, type SkillSnapshot } from './skills';
import type { SessionUser } from '@/lib/auth/session';
import { resolveCanvasStudioReferenceUse } from '@/lib/canvas-studio-reference-use';
import { bindRoleMediaTask, roleMediaFingerprint, type RoleMediaSubmission } from '@/lib/canvas-roles/media-bindings';
import { resolveSharedStudioModule, parseSharedStudioPersonalOverrides } from './shared-contract';
import { studioPresetArchived } from './preset-lifecycle';
import type { SharedStudioIntent } from './shared-types';
import { assertRestoredStudioDraft, assertRestoredStudioSourceRelation, assertRestoredStudioStyleVersions,
  hasSharedStudioPrompt, historicalStudioTemplateReferences, parseRestoredStudioSettings, restoredStudioTemplatePrompt, studioPersonalPromptProjection,
  RestoredStudioSettingsError } from './restored-settings';
import { studioOutputMismatch as studioDimensionMismatch, studioDimensionMismatchNotice, studioOutputIssue, studioTaskHasViewableOutput, studioOutputTaskWhere } from './dimension-mismatch';
import { studioInputMainPreview } from './input-main';

export class StudioError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export class SharedStudioDefinitionError extends StudioError {
  constructor(message = '模板已更新，请确认本次生成', status = 409) { super(message, status); }
}

export function studioBusinessErrorStatus(error: unknown): number | null {
  if (error instanceof StudioError) return error.status;
  const status = error instanceof Error ? (error as Error & { status?: unknown }).status : undefined;
  return typeof status === 'number' && [400, 403, 404, 409].includes(status) ? status : null;
}

export function parseSharedStudioIntent(value: unknown): SharedStudioIntent | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StudioError('共享模板请求无效', 400);
  const intent = value as Record<string, unknown>;
  if (Object.keys(intent).some(key => !['protocol', 'presetId', 'definitionToken'].includes(key))
    || intent.protocol !== 'shared-live-v1' || typeof intent.presetId !== 'string'
    || (!/^[a-zA-Z0-9-]{1,120}$/.test(intent.presetId)
      && !/^module-source:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(intent.presetId))
    || typeof intent.definitionToken !== 'string' || !intent.definitionToken || intent.definitionToken.length > 256) {
    throw new StudioError('共享模板协议或版本无效，请重新读取模板', 409);
  }
  return { protocol: intent.protocol, presetId: intent.presetId, definitionToken: intent.definitionToken };
}

export function sameSharedStudioIntent(left: SharedStudioIntent | undefined, right: SharedStudioIntent | undefined) {
  return left?.protocol === right?.protocol && left?.presetId === right?.presetId
    && left?.definitionToken === right?.definitionToken;
}

export function assertFrozenSharedStudioTask(task: Pick<ImageStudioTask, 'snapshot_json' | 'source_preset_id' | 'context' | 'model' | 'quality' | 'billing_contract_json'>) {
  const snapshot = JSON.parse(task.snapshot_json || '{}') as Record<string, unknown>;
  if (snapshot.sharedLive === undefined) return;
  const intent = parseSharedStudioIntent(snapshot.sharedLive);
  const channel = safeImageChannelSnapshot(snapshot.imageChannel);
  if (!intent || intent.presetId !== task.source_preset_id || snapshot.sourcePresetId !== intent.presetId
    || snapshot.effectiveContext !== task.context || snapshot.model !== task.model || snapshot.quality !== task.quality
    || !channel || !/^[0-9a-f-]{36}$/i.test(channel.configRevision)
    || !parseImageBillingContract(task.billing_contract_json)) {
    throw new StudioError('共享模板受理快照或协议无法确认，原任务保留，不能重新生成', 409);
  }
}

export async function resolveStudioTaskSharedUse(user: ImageStudioIdentity, moduleId: string | undefined,
  intent: SharedStudioIntent | undefined, tx: Prisma.TransactionClient) {
  const shared = moduleId ? await resolveSharedStudioModule(user, moduleId, tx) : null;
  if (!shared) {
    if (intent) throw new SharedStudioDefinitionError('共享模板绑定不存在，请重新打开模板');
    return null;
  }
  if (!sameSharedStudioIntent(intent, shared.definition.intent)) {
    throw new SharedStudioDefinitionError();
  }
  return shared;
}

export async function resolveOwnedStudioTaskSharedUse(ownerId: string, moduleId: string | undefined,
  intent: SharedStudioIntent | undefined, tx: Prisma.TransactionClient, restoredInput?: ReturnType<typeof parseStudioRequest>) {
  const user = await tx.user.findUnique({ where: { id: ownerId }, select: {
    id: true, role: true, account_type: true, status: true, user_profile: true, feature_profile_id: true,
    feishu_user_id: true, feishu_open_id: true, feishu_union_id: true, feishu_tenant_key: true,
  } });
  if (!user || user.status !== 'active' || !canUseCompanyTemplates(user)) throw new StudioError('当前账号无法生成', 403);
  const shared = await resolveStudioTaskSharedUse(user, moduleId, intent, tx);
  if (restoredInput?.restoredSettings) await resolveStudioTaskRestoredSettings(user, moduleId, restoredInput, shared, tx);
  return shared;
}

export async function resolveStudioTaskRestoredSettings(actor: ImageStudioIdentity, moduleId: string | undefined,
  input: ReturnType<typeof parseStudioRequest>, shared: Awaited<ReturnType<typeof resolveStudioTaskSharedUse>>, tx: Prisma.TransactionClient) {
  if (!input.restoredSettings) return null;
  assertRestoredStudioDraft(input);
  if (!moduleId) throw new StudioError('请在原模板中恢复生成设置', 409);
  const workspace = await tx.imageStudioModule.findFirst({ where: { id: moduleId, owner_id: actor.id }, select: { source_preset_id: true } });
  if (!workspace && moduleId !== defaultStudioModuleId(actor.id)) throw new StudioError('当前模板不存在或无权使用', 403);
  const storedSource = await tx.imageStudioTask.findFirst({ where: { id: input.restoredSettings.sourceTaskId, owner_id: actor.id, deleted_at: null } });
  if (!storedSource?.snapshot_json) throw new StudioError('原记录不存在、已删除或无权使用，请重新选择记录', 403);
  const source = transformPrivateImageTask(storedSource, false);
  let snapshot: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(source.snapshot_json!);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    snapshot = parsed as Record<string, unknown>;
  } catch { throw new StudioError('原记录没有完整恢复设置，请使用当前模板', 409); }
  const sourcePresetId = source.source_preset_id || (typeof snapshot.sourcePresetId === 'string' ? snapshot.sourcePresetId : null);
  let historicalPresetOwnerId: string | undefined;
  if (sourcePresetId) {
    const preset = await tx.imageStudioPreset.findUnique({ where: { id: sourcePresetId }, select: { owner_id: true, scope: true, is_shared: true } });
    if (!preset || !canViewStudioPreset(actor, preset) || await studioPresetArchived(sourcePresetId, tx)) throw new StudioError('原模板已不可用或无权使用，请重新选择模板', 403);
    historicalPresetOwnerId = preset.owner_id;
  }
  assertRestoredStudioSourceRelation(source, snapshot, { moduleId, presetId: shared?.definition.intent.presetId ?? workspace?.source_preset_id ?? null,
    allowOrdinaryModulePromotion: !hasSharedStudioPrompt(snapshot) && source.module_id === moduleId && historicalPresetOwnerId === actor.id
      && shared?.binding.mode === 'publisher' && shared.binding.ownerId === actor.id && shared.definition.sourceOwnerId === actor.id
      && shared.definition.intent.presetId === `module-source:${moduleId}` });
  if (typeof snapshot.globalContext !== 'string' || typeof snapshot.moduleContext !== 'string') {
    throw new StudioError('这条旧记录没有保存完整上下文，请使用当前模板并重新选择设置', 409);
  }
  return { source, snapshot, templatePrompt: restoredStudioTemplatePrompt(snapshot) };
}

export function studioSharedGenerationSource(shared: NonNullable<Awaited<ReturnType<typeof resolveStudioTaskSharedUse>>>,
  input: ReturnType<typeof parseStudioRequest>) {
  return { ...shared.definition.generationDefaults, ...(input.personalOverrides ?? shared.personalOverrides),
    ...(input.personalOverrides === undefined ? {
      ...(input.model ? { model: input.model } : {}), ...(input.quality !== undefined ? { quality: input.quality } : {}),
      ...(input.resolution ? { resolution: input.resolution } : {}), ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
    } : {}) };
}

export function normalizeSharedAuthorDraftForUse(actor: ImageStudioIdentity,
  shared: NonNullable<Awaited<ReturnType<typeof resolveStudioTaskSharedUse>>>, input: ReturnType<typeof parseStudioRequest>) {
  if (input.restoredSettings) { assertRestoredStudioDraft(input); return; }
  const draft = input.draft;
  const hasDefinition = input.reproduceFromTaskId !== undefined || draft?.moduleContext !== undefined
    || draft?.fixedReferences !== undefined || draft?.styleGroupIds !== undefined
    || draft?.skillIds !== undefined || draft?.skillVersions !== undefined;
  if (!hasDefinition) return;
  const consumer = shared.binding.mode !== 'publisher' || shared.binding.ownerId !== actor.id || shared.definition.sourceOwnerId !== actor.id;
  // A colleague may choose, swap or remove style groups for this use; the template context stays the author's.
  if (consumer && input.reproduceFromTaskId === undefined && draft?.moduleContext === undefined && draft?.fixedReferences === undefined
    && draft?.skillIds === undefined && draft?.skillVersions === undefined) return;
  if (consumer) {
    throw new StudioError('共享模板的历史定义不能直接用于生成；请重新读取当前模板，个人设置仍保留', 409);
  }
  const definition = shared.definition;
  const sameReferences = draft?.fixedReferences === undefined || draft.fixedReferences.length === definition.fixedReferences.length
    && draft.fixedReferences.every((reference, index) => reference.assetId === definition.fixedReferences[index].assetId
      && reference.note === definition.fixedReferences[index].note);
  const sameStyles = draft?.styleGroupIds === undefined || draft.styleGroupIds.length === definition.styleGroupIds.length
    && draft.styleGroupIds.every((id, index) => id === definition.styleGroupIds[index]);
  const sameReproduction = input.reproduceFromTaskId === undefined || Boolean(definition.reproduction
    && definition.reproduction.sourceOwnerId === actor.id && input.reproduceFromTaskId === definition.reproduction.sourceTaskId
    && (draft?.globalContext === undefined || draft.globalContext === definition.reproduction.globalContext));
  if (draft?.moduleContext !== undefined && draft.moduleContext !== definition.context || !sameReferences || !sameStyles
    || draft?.skillIds !== undefined && draft.skillIds.length !== 0
    || draft?.skillVersions !== undefined && Object.keys(draft.skillVersions).length !== 0 || !sameReproduction) {
    throw new StudioError('恢复的模板内容尚未保存，请先保存恢复设置或重新读取当前模板后生成', 409);
  }
  // Only discard proven redundant author fields, after the original request fingerprint
  // and accepted-request recovery have been fixed. The fresh source still drives generation.
  input.reproduceFromTaskId = undefined;
  if (draft) {
    delete draft.moduleContext;
    delete draft.fixedReferences;
    delete draft.styleGroupIds;
    delete draft.skillIds;
    delete draft.skillVersions;
  }
}

export const STUDIO_SHARED_WORKER_KEY = 'studio_shared_worker_v1';
export const STUDIO_SHARED_WORKER_FILES = [
  'src/lib/image-studio/shared-contract.ts', 'src/lib/image-studio/shared-types.ts',
  'src/lib/image-studio/read-snapshot.ts',
  'src/lib/image-studio/tasks.ts', 'src/lib/image-studio/batches.ts', 'src/lib/image-studio/worker.ts',
  'src/lib/image-studio/restored-settings.ts',
  'src/lib/image-studio/async-recovery.ts',
  ...STUDIO_TASK_SETTINGS_FILES,
] as const;
let sharedWorkerModuleHashes: Record<string, string> | undefined;

export async function assertSharedStudioWorkerReady(tx: Prisma.TransactionClient) {
  const row = await tx.platformSetting.findUnique({ where: { key: STUDIO_SHARED_WORKER_KEY } });
  try {
    const receipt = JSON.parse(row?.value_json || 'null');
    if (!sharedWorkerModuleHashes) sharedWorkerModuleHashes = Object.fromEntries(STUDIO_SHARED_WORKER_FILES
      .map(file => [file, createHash('sha256').update(readFileSync(path.join(process.cwd(), file))).digest('hex')]));
    if (!receipt || receipt.protocol !== 'shared-live-v1' || !Number.isFinite(Date.parse(receipt.expiresAt))
      || Date.parse(receipt.expiresAt) <= Date.now()
      || STUDIO_SHARED_WORKER_FILES.some(file => receipt.loadedModuleSha?.[file] !== sharedWorkerModuleHashes![file])) {
      throw new Error('worker_protocol_mismatch');
    }
  } catch {
    throw new StudioError('共享模板处理服务尚未就绪，本次未受理；请稍后重新确认', 409);
  }
}

export { ACTIVE_IMAGE_TASK_STATUSES };
export function publicImageTaskStatus(status: string) {
  status = publicPricingTaskState(status);
  if (status === 'channel_queued') return 'queued';
  if (status === 'channel_running') return 'running';
  return status;
}

export function safeImageChannelSnapshot(value: unknown): ImageGenerationChannelSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.channelId !== 'string' || !record.channelId || record.channelId.length > 80
    || typeof record.configRevision !== 'string' || !record.configRevision || record.configRevision.length > 128) return null;
  const qualityRoute = record.qualityRoute === undefined ? undefined : parseImageQualityRouteSnapshot(record.qualityRoute);
  if (record.qualityRoute !== undefined && !qualityRoute) return null;
  return { channelId: record.channelId, configRevision: record.configRevision, ...(qualityRoute ? { qualityRoute } : {}) };
}

type StudioTaskDraft = {
  moduleContext?: string;
  globalContext?: string;
  fixedReferences?: StudioFixedReference[];
  styleGroupIds?: string[];
  styleGroupVersions?: Record<string, number>;
  skillIds?: string[];
  skillVersions?: Record<string, string>;
  referencePolicy?: StudioReferencePolicy;
};

const MAX_STYLE_GROUP_NOTE_LENGTH = 8000;
type StudioTaskStyleGroupSnapshot = { id: string; name: string; revision: number; referenceCount: number; ownerId?: string; note?: string };
type StudioTaskStyleReferenceGroup = StudioTaskStyleGroupSnapshot & { references: StudioFixedReference[] };

function parseHistoricalStyleGroups(value: unknown): StudioTaskStyleGroupSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.name !== 'string') return [];
    return [{ id: record.id, name: record.name,
      revision: Number.isInteger(record.revision) ? Number(record.revision) : 0,
      referenceCount: Number.isInteger(record.referenceCount) ? Math.max(0, Math.min(MAX_REFERENCE_IMAGES, Number(record.referenceCount))) : 0,
      ...(typeof record.ownerId === 'string' ? { ownerId: record.ownerId } : {}),
      ...(typeof record.note === 'string' && record.note.length <= MAX_STYLE_GROUP_NOTE_LENGTH ? { note: record.note } : {}) }];
  });
}

function parseStudioTaskDraft(value: unknown, referenceIds: string[]): StudioTaskDraft | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StudioError('当前生成草稿无效');
  const record = value as Record<string, unknown>;
  const allowed = ['moduleContext', 'globalContext', 'fixedReferences', 'styleGroupIds', 'styleGroupVersions', 'skillIds', 'skillVersions', 'referencePolicy'];
  if (Object.keys(record).some(key => !allowed.includes(key))) throw new StudioError('当前生成草稿包含不支持的字段');
  if (record.moduleContext !== undefined && (typeof record.moduleContext !== 'string' || record.moduleContext.length > 20000)) throw new StudioError('模块上下文最多 20000 字');
  if (record.globalContext !== undefined && (typeof record.globalContext !== 'string' || record.globalContext.length > 20000)) throw new StudioError('通用上下文最多 20000 字');
  const draft: StudioTaskDraft = {};
  if (record.skillIds !== undefined) draft.skillIds = parseSkillIds(record.skillIds);
  if (record.skillVersions !== undefined) {
    if (!record.skillVersions || typeof record.skillVersions !== 'object' || Array.isArray(record.skillVersions)
      || Object.entries(record.skillVersions).some(([id, version]) => !draft.skillIds?.includes(id) || typeof version !== 'string' || !/^[a-f0-9]{64}$/.test(version))) throw new StudioError('skills文字版本无效');
    draft.skillVersions = record.skillVersions as Record<string, string>;
  }
  if (record.moduleContext !== undefined) draft.moduleContext = record.moduleContext as string;
  if (record.globalContext !== undefined) draft.globalContext = record.globalContext as string;
  if (record.fixedReferences !== undefined) {
    try { draft.fixedReferences = parseStudioFixedReferences(record.fixedReferences); }
    catch (error) { throw new StudioError((error as Error).message); }
  }
  if (record.styleGroupIds !== undefined) {
    try { draft.styleGroupIds = parseStudioStyleIds(record.styleGroupIds); }
    catch (error) {
      if (error instanceof StudioStyleError) throw new StudioError(error.message, error.status);
      throw error;
    }
  }
  if (record.styleGroupVersions !== undefined) {
    if (!record.styleGroupVersions || typeof record.styleGroupVersions !== 'object' || Array.isArray(record.styleGroupVersions)
      || Object.entries(record.styleGroupVersions).some(([id, version]) => !draft.styleGroupIds?.includes(id)
        || !Number.isSafeInteger(version) || Number(version) < 0)) throw new StudioError('风格版本无效');
    draft.styleGroupVersions = record.styleGroupVersions as Record<string, number>;
  }
  if (record.referencePolicy !== undefined) {
    try { draft.referencePolicy = parseStudioReferencePolicy(record.referencePolicy, referenceIds); }
    catch (error) { throw new StudioError((error as Error).message, Number((error as { status?: unknown }).status) || 400); }
  }
  return draft;
}

export function parseStudioRequest(body: Record<string, unknown>) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StudioError('提交内容无效');
  if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(body.requestId)) throw new StudioError('提交编号无效');
  if (typeof body.prompt !== 'string' || body.prompt.length > 20000) throw new StudioError('画面描述不能超过 20000 字');
  if (body.personalPrompt !== undefined && (typeof body.personalPrompt !== 'string' || body.personalPrompt.length > 20000)) throw new StudioError('本次画面描述不能超过 20000 字');
  const sharedLive = parseSharedStudioIntent(body.sharedLive);
  const personalOverrides = body.personalOverrides === undefined ? undefined : parseSharedStudioPersonalOverrides(body.personalOverrides);
  if (!Number.isInteger(body.count) || Number(body.count) < 1 || Number(body.count) > 8) throw new StudioError('生成张数必须为 1 到 8');
  if (!Number.isInteger(body.revision)) throw new StudioError('请刷新生成设置');
  if (!Array.isArray(body.referenceIds) || body.referenceIds.length > MAX_REFERENCE_IMAGES || body.referenceIds.some(id => typeof id !== 'string' || id.length > 100)) throw new StudioError(`最多使用 ${MAX_REFERENCE_IMAGES} 张有效参考图`);
  const referenceIds = body.referenceIds as string[];
  const draft = parseStudioTaskDraft(body.draft, referenceIds);
  let evolution;
  try { evolution = parseEvolution(body.evolution); } catch (error) { throw new StudioError((error as Error).message); }
  let aspectRatio: string | undefined;
  try { if (body.aspectRatio !== undefined) aspectRatio = normalizeStudioRatio(body.aspectRatio); }
  catch (error) { throw new StudioError((error as Error).message); }
  let resolution: string | undefined;
  if (body.resolution !== undefined) {
    if (typeof body.resolution !== 'string' || !IMAGE_RESOLUTION_OPTIONS.includes(body.resolution as typeof IMAGE_RESOLUTION_OPTIONS[number])) throw new StudioError('分辨率设置无效');
    resolution = body.resolution;
  }
  const moduleRevision = body.moduleRevision === undefined ? undefined : Number(body.moduleRevision);
  const model = body.model === undefined ? undefined : body.model;
  if (model !== undefined && (typeof model !== 'string' || !IMAGE_STUDIO_MODELS.includes(model as typeof IMAGE_STUDIO_MODELS[number]))) throw new StudioError('生成模型无效');
  const quality = body.quality === undefined ? undefined : body.quality;
  if (quality !== undefined && (typeof quality !== 'string' || quality.length > 30)) throw new StudioError('图片质量无效');
  const channelId = body.channelId === undefined ? undefined : body.channelId;
  if (channelId !== undefined && (typeof channelId !== 'string' || channelId.length > 80
    || !['original', 'shared', 'banana', 'fluxport'].includes(channelId) && !/^image-[0-9a-f-]{36}$/.test(channelId))) throw new StudioError('图片供应商无效');
  let imageChannel: ImageGenerationChannelSnapshot | undefined;
  if (body.imageChannel !== undefined) {
    imageChannel = safeImageChannelSnapshot(body.imageChannel) || undefined;
    if (!imageChannel) throw new StudioError('图片通道配置版本无效');
    if (channelId !== undefined && channelId !== 'original' && channelId !== imageChannel.channelId) throw new StudioError('图片通道与配置版本不匹配');
    if (!['original', 'shared', 'banana', 'fluxport'].includes(imageChannel.channelId)
      && !/^image-[0-9a-f-]{36}$/.test(imageChannel.channelId)) throw new StudioError('图片供应商无效');
  }
  const maxEstimatedCost = body.maxEstimatedCost;
  if (body.billingQuoteId !== undefined && (typeof body.billingQuoteId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.billingQuoteId))) throw new StudioError('图片报价编号无效');
  if (maxEstimatedCost !== undefined && (typeof maxEstimatedCost !== 'number' || !Number.isFinite(maxEstimatedCost) || maxEstimatedCost < 0 || maxEstimatedCost > 10000000)) throw new StudioError('确认价格无效');
  if (maxEstimatedCost !== undefined) { try { creditCents(maxEstimatedCost as number); } catch { throw new StudioError('确认价格精度无效'); } }
  if (moduleRevision !== undefined && (!Number.isInteger(moduleRevision) || moduleRevision < 0)) throw new StudioError('模块已更新，请刷新后重试', 409);
  const reproduceFromTaskId = body.reproduceFromTaskId === undefined ? undefined : body.reproduceFromTaskId;
  if (reproduceFromTaskId !== undefined && (typeof reproduceFromTaskId !== 'string' || reproduceFromTaskId.length > 120)) throw new StudioError('历史生成记录无效', 400);
  const restoredSettings = parseRestoredStudioSettings(body.restoredSettings);
  const taskSettings = parseStudioTaskSettings(body.taskSettings);
  if (taskSettings && draft?.globalContext !== undefined) throw new StudioTaskSettingsError('通用上下文由已保存设置或原记录确定，不能随生成覆盖', 400);
  assertRestoredStudioDraft({ restoredSettings, reproduceFromTaskId, draft });
  const projectId = parseUsageProjectId(body.projectId);
  return { requestId: body.requestId, prompt: body.prompt.trim(), count: Number(body.count), revision: Number(body.revision), moduleRevision, reproduceFromTaskId, referenceIds,
    ...(projectId !== undefined ? { projectId } : {}),
    ...(sharedLive ? { sharedLive } : {}),
    ...(personalOverrides ? { personalOverrides } : {}),
    ...(typeof body.personalPrompt === 'string' ? { personalPrompt: body.personalPrompt.trim() } : {}),
    ...(restoredSettings ? { restoredSettings } : {}), ...(taskSettings ? { taskSettings } : {}),
    ...(channelId !== undefined ? { channelId: channelId as string } : imageChannel ? { channelId: imageChannel.channelId } : {}),
    ...(imageChannel ? { imageChannel } : {}),
    ...(maxEstimatedCost !== undefined ? { maxEstimatedCost: maxEstimatedCost as number } : {}), ...(evolution ? { evolution } : {}), ...(draft !== undefined ? { draft } : {}), ...(aspectRatio !== undefined ? { aspectRatio } : {}), ...(resolution !== undefined ? { resolution } : {}), ...(model !== undefined ? { model: model as typeof IMAGE_STUDIO_MODELS[number] } : {}), ...(quality !== undefined ? { quality: quality as string } : {}) };
}

function parseHistoricalFixedReferences(value: unknown): StudioFixedReference[] {
  if (!Array.isArray(value)) throw new StudioError('历史固定参考图快照无效', 409);
  const references = value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new StudioError('历史固定参考图快照无效', 409);
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string' || !record.id) throw new StudioError('历史固定参考图快照无效', 409);
    return { assetId: record.id, note: typeof record.note === 'string' ? record.note : '' };
  });
  try { return parseStudioFixedReferences(references); }
  catch { throw new StudioError('历史固定参考图快照无效', 409); }
}

export async function submitStudioBatch(ownerId: string, body: Record<string, unknown>, avatar?: { layout?: AvatarLayout; candidates: AvatarCandidate[]; onQueued?: (tx: Prisma.TransactionClient, batchId: string) => Promise<void> }, preparation?: { save: (tx: Prisma.TransactionClient, data: Prisma.ImageStudioTaskUncheckedCreateInput) => Promise<void>; batchItem?: boolean; frozenContract?: ImageBillingContract; sizePolicyVersion?: StudioSizePolicyVersion }, canvasUse?: { user: SessionUser; referenceImageIds: string[]; projectId?: string | null }, canvasPrompt?: { mentions: unknown; referenceAssets: Record<string, string> }, roleMedia?: RoleMediaSubmission) {
  // This version comes only from persisted server preparation, never from body.
  const sizePolicyVersion = preparation?.sizePolicyVersion ?? CURRENT_STUDIO_SIZE_POLICY_VERSION;
  if (sizePolicyVersion !== 1 && sizePolicyVersion !== 2) throw new StudioError('图片尺寸策略版本无效', 409);
  if (body.roleMediaContext !== undefined && !roleMedia) throw new StudioError('角色媒体来源只能由原画布确认入口提交', 403);
  if (roleMedia && (roleMedia.user.id !== ownerId || !canvasUse || avatar || preparation)) throw new StudioError('角色媒体必须沿原图片任务创建和扣点流程', 403);
  const roleContextFingerprint = roleMedia ? roleMediaFingerprint(roleMedia.context) : undefined;
  let legacyAcceptedProjectContext = false;
  // An accepted request is recovered before any current definition/configuration checks.
  if (!roleMedia && typeof body?.requestId === 'string' && /^[a-zA-Z0-9-]{16,80}$/.test(body.requestId)) {
    const acceptedBatchId = createHash('sha256').update(`${ownerId}:${body.requestId}`).digest('hex');
    const accepted = await prisma.imageStudioTask.findFirst({ where: { batch_id: acceptedBatchId, owner_id: ownerId } });
    if (accepted) {
      let snapshot: Record<string, unknown> = {};
      try { snapshot = JSON.parse(accepted.snapshot_json || '{}'); } catch {}
      legacyAcceptedProjectContext = canvasUse?.projectId !== undefined && snapshot.usageAttribution === undefined;
      if (snapshot.sharedLive !== undefined || body.sharedLive !== undefined || snapshot.restoredSettings !== undefined || body.restoredSettings !== undefined) {
        if (body.moduleId !== undefined && body.moduleId !== accepted.module_id) throw new StudioError('提交编号已用于其他请求，请查询原记录', 409);
        return acceptedBatchId;
      }
    }
  }
  if (roleMedia && canvasUse?.projectId !== undefined && typeof body.requestId === 'string') {
    const acceptedId = createHash('sha256').update(`${ownerId}:${body.requestId}`).digest('hex');
    const accepted = await prisma.imageStudioTask.findFirst({ where: { batch_id: acceptedId, owner_id: ownerId }, select: { snapshot_json: true } });
    if (accepted) {
      try { legacyAcceptedProjectContext = JSON.parse(accepted.snapshot_json || '{}').usageAttribution === undefined; } catch { /* Original fingerprint validation still fails closed. */ }
    }
  }
  // A new server-derived field must not change an already accepted legacy request.
  const input = parseStudioRequest(legacyAcceptedProjectContext ? { ...body, projectId: undefined } : body);
  const usageProjectId = canvasUse?.projectId !== undefined ? canvasUse.projectId : input.projectId ?? null;
  if (canvasUse?.projectId !== undefined && input.projectId !== undefined && input.projectId !== canvasUse.projectId) throw new StudioError('图片项目与画布上下文不一致', 409);
  const personalPrompt = input.personalPrompt ?? input.prompt;
  const billingQuoteId = typeof body.billingQuoteId === 'string' ? body.billingQuoteId : undefined;
  const rawCanvasPrompt = input.prompt;
  const moduleId = body.moduleId;
  if (input.taskSettings && (avatar || canvasUse || canvasPrompt || roleMedia || typeof moduleId !== 'string')) throw new StudioError('模板设置模式不能用于其他生成入口', 400);
  const sheet = Boolean(avatar && isAvatarSheet(avatar));
  if (avatar && (moduleId !== undefined || input.sharedLive || input.restoredSettings || input.draft !== undefined || input.reproduceFromTaskId || (sheet ? input.count !== 1 || input.aspectRatio !== '1:1' : avatar.candidates.length !== input.count))) throw new StudioError('人物任务排版无效或继承了模板设置');
  if (input.restoredSettings && (canvasUse || canvasPrompt || roleMedia)) throw new StudioError('恢复模板设置不能混入其他生成入口', 403);
  if (sheet) { try { validateSheetCandidates(avatar!.candidates, input.referenceIds, avatar!.layout); } catch (e) { throw new StudioError((e as Error).message); } }
  if (moduleId !== undefined && !validStudioModuleId(moduleId, ownerId)) throw new StudioError('模块编号无效');
  const batchId = createHash('sha256').update(`${ownerId}:${input.requestId}`).digest('hex');
  if (canvasUse && (canvasUse.user.id !== ownerId || avatar)) throw new StudioError('画布参考图请求归属无效', 403);
  const explicitChannelId = typeof body.channelId === 'string' ? body.channelId : undefined;
  const requestedChannelId = input.channelId || input.imageChannel?.channelId || 'original';
  const fingerprintInput = { ...input } as Record<string, unknown>;
  if (requestedChannelId === 'original') {
    // Keep the pre-channel serialization byte-for-byte for legacy callers.
    delete fingerprintInput.channelId;
    delete fingerprintInput.imageChannel;
  } else {
    fingerprintInput.channelId = requestedChannelId;
  }
  const requestFingerprint = createHash('sha256').update(JSON.stringify({ ...fingerprintInput,
    requestId: undefined, ...(moduleId ? { moduleId } : {}), ...(canvasUse ? { canvasReferenceImageIds: canvasUse.referenceImageIds } : {}),
    ...(canvasPrompt ? { canvasPromptMentions: parseCanvasPromptMentions(canvasPrompt.mentions), canvasPromptAssets: canvasPrompt.referenceAssets } : {}),
    ...(roleContextFingerprint ? { roleMediaContext: roleContextFingerprint } : {}),
    ...(avatar ? { avatar: avatar.candidates, ...(sheet ? { avatarLayout: avatar!.layout } : {}) } : {}) })).digest('hex');
  const matchesRequest = (task: ImageStudioTask) => {
    try {
      const snapshot = JSON.parse(task.snapshot_json || '{}') as Record<string, unknown>;
      if (snapshot.inputFingerprint === requestFingerprint) {
        const savedChannel = safeImageChannelSnapshot(snapshot.imageChannel);
        return requestedChannelId === 'original' ? input.imageChannel
          ? savedChannel?.channelId === input.imageChannel.channelId
            && savedChannel.configRevision === input.imageChannel.configRevision
          : true
          : savedChannel?.channelId === requestedChannelId
            && (!input.imageChannel || savedChannel.configRevision === input.imageChannel.configRevision);
      }
    } catch {}
    // Legacy tasks used the same hash over the input before channel fields existed.
    return requestedChannelId === 'original' && task.fingerprint === requestFingerprint;
  };
  const previous = await prisma.imageStudioTask.findFirst({ where: { batch_id: batchId, owner_id: ownerId } });
  if (previous) {
    if (!matchesRequest(previous)) throw new StudioError('提交编号已用于其他请求，请重新提交', 409);
    return batchId;
  }
  const settings = await getImageStudioSettings();
  if (settings.revision !== input.revision) throw new StudioError('生成规则或通用上下文已更新，请重新读取设置后确认提交', 409);
  await withContextVersionRetry(() => prisma.$transaction(async tx => {
    const duplicate = await tx.imageStudioTask.findFirst({ where: { batch_id: batchId, owner_id: ownerId } });
    if (duplicate) {
      if (input.taskSettings) {
        if (!matchesRequest(duplicate)) throw new StudioError('提交编号已用于其他请求，请查询原记录', 409);
        return;
      }
      if (input.sharedLive || input.restoredSettings) {
        if (moduleId !== undefined && moduleId !== duplicate.module_id) throw new StudioError('提交编号已用于其他请求，请查询原记录', 409);
        return;
      }
      if (!matchesRequest(duplicate)) throw new StudioError('提交编号冲突', 409);
      return;
    }
    if (input.taskSettings) await assertStudioTaskSettingsWriter(tx);
    const settings = await getImageStudioSettings(tx);
    if (settings.revision !== input.revision) throw new StudioError('通用设置已更新，请重新读取并确认报价；尚未生成', 409);
    try { await assertNoSynchronousImageAdmission(tx, ownerId, input.requestId); }
    catch (error) { if (error instanceof SynchronousImageAdmissionError) throw new StudioError(error.message, error.status); throw error; }
    const user = await tx.user.findUnique({ where: { id: ownerId }, select: {
      id: true, role: true, account_type: true, status: true,
      user_profile: true, feature_profile_id: true,
      feishu_user_id: true, feishu_open_id: true, feishu_union_id: true, feishu_tenant_key: true,
    } });
    if (!user || user.status !== 'active') throw new StudioError('当前账号无法生成', 403);
    await assertUsageProject(tx, user, usageProjectId);
    const identity: ImageStudioIdentity = user;
    if (!canUseCompanyTemplates(identity)) throw new StudioError('仅限公司飞书账号生成图片', 403);
    const canvasReferenceOwners = canvasUse ? await resolveCanvasStudioReferenceUse(canvasUse.user, canvasUse.referenceImageIds) : new Map<string, string>();
    if (canvasUse && (canvasReferenceOwners.size !== new Set(input.referenceIds).size || input.referenceIds.some(id => !canvasReferenceOwners.has(id)))) throw new StudioError('画布参考图与持久请求不匹配', 403);
    const storedWorkspace = moduleId ? await tx.imageStudioModule.findFirst({ where: { id: moduleId as string, owner_id: ownerId } }) : null;
    const workspace = storedWorkspace ? readPrivateStudioDefinition('image-module', storedWorkspace) : null;
    if (moduleId && moduleId !== defaultStudioModuleId(ownerId) && !workspace) throw new StudioError('模块不存在或无权使用', 403);
    const sharedUse = await resolveStudioTaskSharedUse(identity, typeof moduleId === 'string' ? moduleId : undefined, input.sharedLive, tx);
    if (sharedUse) {
      await assertSharedStudioWorkerReady(tx);
      normalizeSharedAuthorDraftForUse(identity, sharedUse, input);
    }
    const sharedDefinition = sharedUse?.definition;
    const savedSettingsSource = moduleId ? await readStudioWorkspaceSource(tx, ownerId, String(moduleId)) : null;
    assertStudioTaskSettingsWrite(savedSettingsSource?.taskSettings ?? sharedDefinition?.reproduction?.taskSettings, input.taskSettings);
    const restored = await resolveStudioTaskRestoredSettings(identity, typeof moduleId === 'string' ? moduleId : undefined, input, sharedUse, tx);
    if (sharedUse && input.personalOverrides !== undefined && !preparation?.batchItem
      && input.count !== (input.personalOverrides.count ?? sharedUse.definition.generationDefaults.count)) {
      throw new SharedStudioDefinitionError();
    }
    const effectiveTemplatePrompt = restored ? restored.templatePrompt : sharedDefinition?.templatePrompt;
    if (sharedDefinition || restored) input.prompt = [effectiveTemplatePrompt, personalPrompt].filter(Boolean).join('\n\n本次个人要求：\n');
    const reproduceFromTaskId = restored?.source.id || (sharedUse ? undefined : input.reproduceFromTaskId || (!input.draft ? workspace?.reproduce_task_id : undefined));
    const contextMode = input.taskSettings?.mode ?? sharedDefinition?.reproduction?.taskSettings?.mode ?? 'historical';
    if (input.taskSettings?.mode === 'historical' && !input.taskSettings.sourceTaskId && !reproduceFromTaskId && !sharedDefinition?.reproduction) {
      throw new StudioError('历史设置来源尚未确认，当前输入保留', 409);
    }
    let sourcePresetId = sharedUse?.definition.intent.presetId || workspace?.source_preset_id || null;
    if (reproduceFromTaskId && !restored) sourcePresetId = null;
    let sourcePresetOwnerId: string | null = null;
    if (workspace?.source_preset_id) {
      const source = await tx.imageStudioPreset.findUnique({ where: { id: workspace.source_preset_id }, select: { owner_id: true, scope: true, is_shared: true } });
      if ((!reproduceFromTaskId || restored) && (!source || !canViewStudioPreset(identity, source))) throw new StudioError('该模板已停止共享，不能新建任务', 403);
      sourcePresetOwnerId = source?.owner_id || null;
    }
    const moduleContextEditable = user.role === 'admin' || !workspace?.source_preset_id || sourcePresetOwnerId === ownerId;
    const fixedReferencesEditable = user.role === 'admin' && (!workspace?.source_preset_id || sourcePresetOwnerId === ownerId);
    if (input.draft?.moduleContext !== undefined && !moduleContextEditable) throw new StudioError('共享模板的内部上下文只能由创建者修改', 403);
    if (input.draft?.fixedReferences !== undefined && !fixedReferencesEditable) throw new StudioError('固定模板图只能由管理员修改原模板', 403);
    if (input.draft?.globalContext !== undefined && user.role !== 'admin') throw new StudioError('通用上下文只能由管理员修改', 403);
    if (workspace && input.moduleRevision !== undefined && workspace.revision !== input.moduleRevision) throw new StudioError('模块已在其他页面更新，请刷新后核对', 409);
    const generationSource = sharedUse
      ? studioSharedGenerationSource(sharedUse, input)
      : { ...workspace, ...(input.model ? { model: input.model } : {}), ...(input.quality !== undefined ? { quality: input.quality } : {}) };
    const requestedModel = generationSource.model || settings.model;
    const requestedQuality = sharedUse ? generationSource.quality : input.quality;
    if (requestedQuality !== undefined && requestedQuality !== null
      && !(IMAGE_STUDIO_MODEL_QUALITY_OPTIONS[requestedModel as keyof typeof IMAGE_STUDIO_MODEL_QUALITY_OPTIONS] as readonly string[] | undefined)?.includes(requestedQuality)) throw new StudioError('当前模型不支持所选图片质量');
    const generation = resolveStudioModuleGenerationConfig(generationSource, settings);
    const acceptedContract = preparation?.frozenContract;
    const sharedGeneration = sharedUse ? studioSharedGenerationSource(sharedUse, input) : null;
    const effectiveResolution = sharedGeneration?.resolution || input.resolution || generation.resolution;
    const effectiveAspectRatio = sharedGeneration?.aspectRatio || input.aspectRatio || 'auto';
    let effectiveRequestedChannelId = requestedChannelId;
    const qualityRoute = generation.model === IMAGE_25_QUALITY_MODEL && !acceptedContract
      ? await resolveImageGenerationRequestRoute(generation.model, generation.quality, explicitChannelId, tx) : undefined;
    if (acceptedContract && input.imageChannel) {
      effectiveRequestedChannelId = input.imageChannel.channelId;
    } else if (qualityRoute) {
      effectiveRequestedChannelId = qualityRoute.channelId || 'original';
      if (input.imageChannel && (input.imageChannel.channelId !== effectiveRequestedChannelId
        || !input.imageChannel.qualityRoute
        || JSON.stringify(input.imageChannel.qualityRoute) !== JSON.stringify(qualityRoute.qualityRoute))) {
        throw new StudioError('图片质量路由已变化或原报价缺少档位信息，请重新报价；未生成', 409);
      }
    } else if (explicitChannelId === undefined && input.imageChannel) {
      // A snapshot without a channel choice is the older explicit-snapshot
      // contract; keep it pinned instead of consulting today's model default.
      effectiveRequestedChannelId = input.imageChannel.channelId;
    } else {
      try {
        effectiveRequestedChannelId = await resolveImageGenerationRequestChannel(
          generation.model as typeof IMAGE_STUDIO_MODELS[number], explicitChannelId, tx,
        ) || 'original';
      } catch (error) {
        throw new StudioError(error instanceof Error ? error.message : '图片型号默认供应商设置无法读取', 503);
      }
      if (explicitChannelId === 'original' && input.imageChannel
        && effectiveRequestedChannelId !== input.imageChannel.channelId) {
        throw new StudioError('当前型号默认供应商已变化，原报价尚未生成；请重新报价', 409);
      }
    }
    if (effectiveRequestedChannelId !== 'original' && explicitChannelId !== effectiveRequestedChannelId
      && (input.maxEstimatedCost !== undefined || billingQuoteId) && !input.imageChannel) {
      throw new StudioError('当前型号默认供应商已变化或旧报价缺少通道版本，请重新获取报价并确认；未派发生成', 409);
    }
    let imageChannel: ImageGenerationChannelSnapshot | undefined;
    let originalSharedChannel: ImageGenerationChannelSnapshot | undefined;
    let imageApi;
    let pricingQuote: Awaited<ReturnType<typeof quotePricingCharge>> = null;
    if (effectiveRequestedChannelId === 'original') {
      // Ordinary legacy tasks keep their existing worker contract; new shared
      // tasks additionally freeze the same private original configuration below.
      if (input.imageChannel) {
        try { await resolveImageGenerationChannelSnapshot(input.imageChannel, tx, true, generation.model); }
        catch { throw new StudioError('原图片通道配置已变化，请重新报价并确认', 409); }
      }
      imageApi = await getImageGenerationSettingsForModel(generation.model, tx);
      if (sharedDefinition) {
        originalSharedChannel = input.imageChannel || await captureImageGenerationChannel(generation.model, 'original', tx);
        imageApi = await resolveImageGenerationChannelSnapshot(originalSharedChannel, tx, false, generation.model);
      }
    } else {
      imageChannel = input.imageChannel || await captureImageGenerationChannel(generation.model, effectiveRequestedChannelId, tx, qualityRoute?.qualityRoute);
      if (imageChannel.channelId !== effectiveRequestedChannelId) throw new StudioError('图片通道与配置版本不匹配', 409);
      imageApi = await resolveImageGenerationChannelSnapshot(imageChannel, tx, !acceptedContract, generation.model);
      const priced = await withImagePricing(imageApi, generation.model, tx, acceptedContract,
        acceptedContract ? {} : { quality: generation.quality,
          resolution: normalizeImageResolution(generation.model, effectiveResolution, imageApi.provider), ratio: effectiveAspectRatio });
      imageApi = priced.settings; pricingQuote = priced.quote;
      const channelCapability = imageApi.modelCapabilities[generation.model as keyof typeof imageApi.modelCapabilities];
      const validation = validateImageGenerationChannel(imageApi, { model: generation.model, quality: generation.quality,
        resolution: effectiveResolution, ratio: effectiveAspectRatio, referenceCount: input.referenceIds.length });
      const actualQuotePreparation = Boolean(preparation) && channelCapability?.billingMode === 'actual'
        && channelCapability.actualQuoteRequired === true
        && isMuskImageGenerationChannel(imageApi)
        && new URL(imageApi.base_url).origin === 'https://api.muskapis.com'
        && (await imageBillingReady(imageBillingScope(imageApi), generation.model, tx)).ready;
      if (!validation.ok) throw new StudioError(validation.error, 400);
      if (preparation && channelCapability?.billingMode === 'actual' && !actualQuotePreparation) {
        throw new StudioError('同一图片通道与型号尚无有效账单证明，暂不能准备实际计费报价', 409);
      }
    }
    if (!imageChannel) {
      const priced = await withImagePricing(imageApi, generation.model, tx, acceptedContract,
        acceptedContract ? {} : { quality: generation.quality,
          resolution: normalizeImageResolution(generation.model, effectiveResolution, imageApi.provider), ratio: effectiveAspectRatio });
      imageApi = priced.settings; pricingQuote = priced.quote;
    }
    if(avatar && (input.referenceIds.length ? !imageApi.supports_image_to_image : !imageApi.supports_text_to_image)) throw new StudioError('当前图片通道不支持本次文字或原图参考生成',409);
    if (!isStudioImageGenerationProvider(imageApi.provider) || !isImageGenerationApiReady(imageApi)) {
      throw new StudioError(generation.model.startsWith('gemini-') ? 'Banana 专用通道尚未配置，请管理员在后台 API 设置填写专用 Key' : '图片专用 API 尚未配置', 503);
    }
    const channelCapability = imageChannel ? imageApi.modelCapabilities[generation.model as keyof typeof imageApi.modelCapabilities] : undefined;
    const requestedBillingMode = channelCapability?.billingMode;
    const billingScope = imageBillingScope(imageApi);
    const actualBillingEligible = isMuskImageGenerationChannel(imageApi)
      && new URL(imageApi.base_url).origin === 'https://api.muskapis.com'
      && (!imageChannel || channelCapability?.billingMode === 'actual' && channelCapability.actualQuoteRequired === true)
      && (await imageBillingReady(billingScope, generation.model, tx)).ready;
    if (imageChannel && requestedBillingMode === 'actual'
      && (!isMuskImageGenerationChannel(imageApi) || new URL(imageApi.base_url).origin !== 'https://api.muskapis.com')) {
      throw new StudioError('此图片通道没有已验证的实际账单来源，请选择固定点数或原图片通道', 409);
    }
    let price = imageChannel && requestedBillingMode === 'fixed'
      ? channelCapability?.fixedPoints ?? null
      : generation.prices[generation.model];
    if (imageChannel && requestedBillingMode === 'actual') price = 0;
    // Actual preparation has no charge yet; acceptance requires the stored authorization below.
    if (pricingQuote) price = pricingQuote.charge.identity.billingMode === 'actual' ? 0 : pricingQuote.credits;
    if (acceptedContract) price = acceptedContract.authorizedCredits;
    if (pricingQuote && !billingQuoteId && !preparation) throw new StudioError('当前收费规则需要确认有效报价，请重新报价；尚未生成', 409);
    if (imageChannel && requestedBillingMode === 'actual' && !billingQuoteId && !preparation) {
      throw new StudioError('实际计费需先获取并确认同一通道的有效报价', 409);
    }
    if (price === null || !Number.isFinite(price) || (!pricingQuote && !acceptedContract && !Number.isInteger(price)) || price < 0 || price > 100000) throw new StudioError('管理员尚未设置当前模块的有效生成积分', 409);
    creditCents(price);
    const quotedUnitCredits = price;
    if (!billingQuoteId && input.maxEstimatedCost !== undefined && sumCredits(Array.from({ length: input.count }, () => quotedUnitCredits)) > input.maxEstimatedCost) throw new StudioError('图片价格已变化，请重新确认点数', 409);
    let snapshotGlobalContext = avatar ? '' : user.role === 'admin' && input.draft?.globalContext !== undefined ? input.draft.globalContext : settings.context;
    let snapshotModuleContext = input.draft?.moduleContext !== undefined ? input.draft.moduleContext : workspace?.context || '';
    if (sharedDefinition) {
      snapshotModuleContext = sharedDefinition.reproduction?.moduleContext ?? sharedDefinition.context;
      if (sharedDefinition.reproduction && contextMode === 'historical') {
        if (typeof sharedDefinition.reproduction.globalContext !== 'string') throw new StudioError('原历史上下文无法确认，请重新选择历史记录', 409);
        snapshotGlobalContext = sharedDefinition.reproduction.globalContext;
      }
    }
    let templateFixedReferences: StudioFixedReference[] = [];
    let styleGroupIds: string[] = [];
    let styleGroupSnapshot: StudioTaskStyleGroupSnapshot[] = [];
    let styleReferenceGroups: StudioTaskStyleReferenceGroup[] = [];
    let historicalReferenceOwners: Record<string, string> = {};
    const freshlySelectedStyleIds = new Set<string>();
    let consumerStyleGroupIds: string[] = [];
    let historicalSnapshot: Record<string, unknown> | null = null;
    let historicalTemplateReferences: Record<string, unknown>[] = [];
    let skills: SkillSnapshot[] = [];
    const referenceIds = input.referenceIds;
    if (reproduceFromTaskId) {
      const storedSource = restored?.source ?? await tx.imageStudioTask.findFirst({ where: { id: reproduceFromTaskId, owner_id: ownerId } });
      const source = storedSource ? transformPrivateImageTask(storedSource, false) : null;
      if (!source?.snapshot_json) throw new StudioError('历史记录缺少可恢复上下文，请按当前模块重新生成', 409);
      try {
        const sourceSnapshot = JSON.parse(source.snapshot_json) as Record<string, unknown>;
        historicalSnapshot = sourceSnapshot;
        if (restored) historicalTemplateReferences = historicalStudioTemplateReferences(sourceSnapshot);
        const historicalSourcePresetId = source.source_preset_id || (typeof sourceSnapshot.sourcePresetId === 'string' ? sourceSnapshot.sourcePresetId : null);
        if (historicalSourcePresetId) {
          const historicalSource = await tx.imageStudioPreset.findUnique({ where: { id: historicalSourcePresetId }, select: { owner_id: true, scope: true, is_shared: true } });
          if (!historicalSource || !canViewStudioPreset(identity, historicalSource)) throw new StudioError('该模板已停止共享，不能新建任务', 403);
          if (!restored || !sharedDefinition) sourcePresetId = historicalSourcePresetId;
        }
        const configuredFixed = Array.isArray(sourceSnapshot.fixedReferenceImages)
            ? parseHistoricalFixedReferences(sourceSnapshot.fixedReferenceImages)
          : [];
        if (restored && sourceSnapshot.templateFixedCount !== undefined && (!Number.isInteger(sourceSnapshot.templateFixedCount)
          || Number(sourceSnapshot.templateFixedCount) < 0 || Number(sourceSnapshot.templateFixedCount) > configuredFixed.length)) {
          throw new StudioError('原记录的固定参考图数量无法确认，请使用当前模板', 409);
        }
        const configuredTemplateFixedCount = Math.max(0, Math.min(configuredFixed.length,
          Number.isInteger(sourceSnapshot.templateFixedCount) ? Number(sourceSnapshot.templateFixedCount) : configuredFixed.length));
        templateFixedReferences = configuredFixed.slice(0, configuredTemplateFixedCount);
        const historicalStyleReferences = configuredFixed.slice(configuredTemplateFixedCount);
        styleGroupIds = sourceSnapshot.styleGroupIds === undefined ? [] : parseStudioStyleIds(sourceSnapshot.styleGroupIds);
        if (Array.isArray(sourceSnapshot.styleGroups)) {
          styleGroupSnapshot = parseHistoricalStyleGroups(sourceSnapshot.styleGroups);
          if (restored && input.draft?.styleGroupIds === undefined && sourceSnapshot.styleGroups.some(group => !group
            || typeof group !== 'object' || !Number.isSafeInteger(group.revision) || group.revision < 0)) {
            throw new StudioError('这条旧记录没有保存风格版本，请重新选择本次风格', 409);
          }
        } else {
          if (restored && styleGroupIds.length && input.draft?.styleGroupIds === undefined) throw new StudioError('这条旧记录没有保存风格版本，请重新选择本次风格', 409);
          const styles = await resolveStudioStyleReferences(identity, styleGroupIds, tx);
          styleGroupSnapshot = styles.groups.map(group => {
            const note = (group as { note?: unknown }).note;
            return { id: group.id, name: group.name, revision: group.revision, referenceCount: group.references.length,
              ownerId: group.ownerId, ...(typeof note === 'string' ? { note } : {}) };
          });
        }
        let styleOffset = 0;
        for (const group of styleGroupSnapshot) {
          const references = historicalStyleReferences.slice(styleOffset, styleOffset + group.referenceCount);
          styleOffset += references.length;
          styleReferenceGroups.push({ ...group, references });
        }
        if (styleOffset < historicalStyleReferences.length) {
          const references = historicalStyleReferences.slice(styleOffset);
          styleReferenceGroups.push({ id: 'historical-style-references', name: '历史风格参考图', revision: 0, referenceCount: references.length, references });
        }
        if (input.draft?.styleGroupIds !== undefined) {
          styleGroupIds = input.draft.styleGroupIds;
          const selected = await resolveStudioStyleReferences(identity, styleGroupIds, tx);
          if (restored) assertRestoredStudioStyleVersions(selected.groups, input.draft.styleGroupVersions!);
          styleGroupSnapshot = selected.groups.map(group => ({ id: group.id, name: group.name, revision: group.revision,
            referenceCount: group.references.length, ownerId: group.ownerId, ...(group.note ? { note: group.note } : {}) }));
          styleReferenceGroups = selected.groups.map((group, index) => ({ ...styleGroupSnapshot[index], references: group.references }));
          for (const group of selected.groups) for (const reference of group.references) freshlySelectedStyleIds.add(reference.assetId);
        } else {
          // Keep historical notes and images, but recheck that their groups are still usable.
          const current = await resolveStudioStyleReferences(identity, styleGroupIds, tx);
          if (restored && (styleGroupSnapshot.length !== styleGroupIds.length
            || styleGroupSnapshot.some((group, index) => group.id !== styleGroupIds[index]
              || group.ownerId !== undefined && group.ownerId !== current.groups[index]?.ownerId)
            || styleReferenceGroups.some(group => group.references.length !== group.referenceCount)
            || styleOffset !== historicalStyleReferences.length)) throw new StudioError('原记录的风格来源不完整或归属已变化，请重新选择本次风格', 409);
        }
        if (sourceSnapshot.authorizedReferenceOwners && typeof sourceSnapshot.authorizedReferenceOwners === 'object') {
          historicalReferenceOwners = Object.fromEntries(Object.entries(sourceSnapshot.authorizedReferenceOwners as Record<string, unknown>)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
        }
        if (typeof sourceSnapshot.globalContext !== 'string' || typeof sourceSnapshot.moduleContext !== 'string') {
          throw new StudioError('这条旧记录没有保存完整上下文，无法完整复现；请退出历史复现后使用当前设置', 409);
        }
        // Reproduction must use the recorded contexts, including deliberately empty ones.
        if (contextMode === 'historical') snapshotGlobalContext = sourceSnapshot.globalContext;
        snapshotModuleContext = sourceSnapshot.moduleContext;
      } catch (error) {
        if (error instanceof StudioError) throw error;
        if (error instanceof RestoredStudioSettingsError) throw new StudioError(error.message, error.status);
        if (error instanceof StudioStyleError) throw new StudioError(error.message, error.status);
        throw new StudioError('历史记录缺少可恢复上下文，请按当前模块重新生成', 409);
      }
    } else if (sharedDefinition) {
      templateFixedReferences = sharedDefinition.reproduction?.templateFixedReferences ?? sharedDefinition.fixedReferences;
      styleGroupIds = input.draft?.styleGroupIds ?? sharedDefinition.styleGroupIds;
      // Groups of the template are used under the author's sharing; any other choice must be usable by this user.
      type SharedStyleGroup = (typeof sharedDefinition.styleGroups)[number];
      const templateGroups = new Map(sharedDefinition.styleGroups.map(group => [group.id, group]));
      consumerStyleGroupIds = styleGroupIds.filter(id => !templateGroups.has(id));
      const chosen = new Map<string, SharedStyleGroup>();
      try {
        if (consumerStyleGroupIds.length) for (const group of (await resolveStudioStyleReferences(identity, consumerStyleGroupIds, tx)).groups) {
          const note = (group as { note?: unknown }).note;
          chosen.set(group.id, { ...group, ...(typeof note === 'string' ? { note } : {}) } as SharedStyleGroup);
        }
      } catch (error) {
        if (error instanceof StudioStyleError) throw new StudioError(error.message, error.status);
        throw error;
      }
      const styleGroups = styleGroupIds.map(id => templateGroups.get(id) ?? chosen.get(id)!);
      if (styleGroups.flatMap(group => group.references).length > MAX_REFERENCE_IMAGES) throw new StudioError(`风格组图片合计不能超过 ${MAX_REFERENCE_IMAGES} 张`);
      styleGroupSnapshot = styleGroups.map(group => ({ id: group.id, name: group.name, revision: group.revision,
        referenceCount: group.references.length, ownerId: group.ownerId, ...(group.note ? { note: group.note } : {}) }));
      styleReferenceGroups = styleGroups.map((group, index) => ({ ...styleGroupSnapshot[index], references: group.references }));
    } else {
      if (workspace) templateFixedReferences = await getStudioModuleFixedReferences(ownerId, workspace.id, tx);
      if (!reproduceFromTaskId && input.draft?.fixedReferences !== undefined) {
        const requestedIds = input.draft.fixedReferences.map(reference => reference.assetId);
        const uniqueRequestedIds = Array.from(new Set(requestedIds));
        const authorizedOriginalIds = Array.from(new Set(templateFixedReferences.map(reference => reference.assetId)));
        const visibleOwned = await tx.asset.findMany({ where: { id: { in: uniqueRequestedIds }, owner_id: ownerId, status: 'active', type: 'image', AND: [await studioVisibleAssetWhere(identity, tx)] }, select: { id: true } });
        const originalFixed = await tx.asset.findMany({ where: { id: { in: uniqueRequestedIds.filter(id => authorizedOriginalIds.includes(id)) }, status: 'active', type: 'image' }, select: { id: true } });
        const permittedIds = new Set([...visibleOwned, ...originalFixed].map(asset => asset.id));
        if (permittedIds.size !== uniqueRequestedIds.length) throw new StudioError('固定参考图不存在或无权使用', 403);
        templateFixedReferences = input.draft.fixedReferences;
      }
      try {
        styleGroupIds = input.draft?.styleGroupIds !== undefined
          ? input.draft.styleGroupIds
          : workspace ? await getStudioModuleStyleIds(ownerId, workspace.id, tx) : [];
        const styles = await resolveStudioStyleReferences(identity, styleGroupIds, tx);
        styleGroupSnapshot = styles.groups.map(group => {
          const note = (group as { note?: unknown }).note;
          return { id: group.id, name: group.name, revision: group.revision, referenceCount: group.references.length,
            ownerId: group.ownerId, ...(typeof note === 'string' ? { note } : {}) };
        });
        styleReferenceGroups = styles.groups.map(group => {
          const note = (group as { note?: unknown }).note;
          return { id: group.id, name: group.name, revision: group.revision, referenceCount: group.references.length,
            ownerId: group.ownerId, ...(typeof note === 'string' ? { note } : {}), references: group.references };
        });
      } catch (error) {
        if (error instanceof StudioStyleError) throw new StudioError(error.message, error.status);
        throw error;
      }
    }
    let referencePolicy: StudioReferencePolicy;
    if (!avatar && (!sharedDefinition || restored)) skills = reproduceFromTaskId && input.draft?.skillIds === undefined
      ? await historicalSkills(identity, historicalSnapshot?.skills, tx)
      : await resolveSkills(identity, input.draft?.skillIds ?? (workspace ? await getSkillSelection(ownerId, workspace.id, tx) : []), tx);
    if (restored && input.draft?.skillIds === undefined && historicalSnapshot?.skillIds !== undefined) {
      const historicalSkillIds = parseSkillIds(historicalSnapshot.skillIds);
      if (historicalSkillIds.length !== skills.length || historicalSkillIds.some((id, index) => skills[index]?.id !== id)) {
        throw new StudioError('原记录的提示词组不完整，请重新选择本次提示词组', 409);
      }
    }
    if (input.draft?.skillVersions && skills.some(skill => input.draft!.skillVersions![skill.id] !== publicSkillVersion(skill))) throw new StudioError('skills文字已更新，请重新选择后生成', 409);
    if (avatar) referencePolicy = { ...defaultStudioReferencePolicy(referenceIds), primaryIds: avatar.candidates[0]?.baselineAssetId ? [avatar.candidates[0].baselineAssetId] : [], useFixedReferences: false };
    else if (sharedDefinition && !restored) {
      const primaryIds = input.draft?.referencePolicy?.primaryIds ?? input.referenceIds;
      referencePolicy = { ...sharedDefinition.referencePolicy, primaryIds: referenceIds.filter(id => primaryIds.includes(id)) };
    }
    else if (input.draft?.referencePolicy && !restored) referencePolicy = input.draft.referencePolicy;
    else if (reproduceFromTaskId && historicalSnapshot?.referencePolicy !== undefined) {
      try { referencePolicy = mapStudioReferencePolicy(historicalSnapshot.referencePolicy, referenceIds); }
      catch { throw new StudioError('历史参考图角色设置无效，请按当前模块重新选择参考图', 409); }
    } else if (reproduceFromTaskId) {
      referencePolicy = defaultStudioReferencePolicy(referenceIds, workspace?.reference_limit);
    } else {
      try {
        referencePolicy = await getStudioModuleReferencePolicy(ownerId, typeof moduleId === 'string' ? moduleId : defaultStudioModuleId(ownerId), referenceIds, workspace?.reference_limit ?? DEFAULT_STUDIO_PRIMARY_MAX);
      } catch (error) {
        if (error instanceof StudioReferencePolicyError) throw new StudioError(error.message, error.status);
        throw error;
      }
    }
    if (restored) {
      const primaryIds = input.draft?.referencePolicy?.primaryIds ?? input.referenceIds;
      referencePolicy = { ...referencePolicy, primaryIds: referenceIds.filter(id => primaryIds.includes(id)) };
    }
    const uniqueTransientIds = Array.from(new Set(referenceIds));
    const primaryIdSet = new Set(referencePolicy.primaryIds);
    const primaryReferenceIds = uniqueTransientIds.filter(id => primaryIdSet.has(id));
    const auxiliaryTransientIds = uniqueTransientIds.filter(id => !primaryIdSet.has(id));
    const includeTemplateFixed = referencePolicy.useFixedReferences;
    const actualTemplateFixedReferences = includeTemplateFixed ? templateFixedReferences : [];
    const sourceTemplateReferenceIds = restored ? historicalTemplateReferences.map(reference => String(reference.id)) : sharedDefinition?.templateReferenceIds || [];
    const actualStyleReferenceGroups = styleReferenceGroups;
    const actualFixedReferences = [...actualTemplateFixedReferences, ...actualStyleReferenceGroups.flatMap(group => group.references)];
    const auxiliaryCount = auxiliaryTransientIds.length + sourceTemplateReferenceIds.length + actualFixedReferences.length;
    try { validateStudioReferenceCounts(referencePolicy, [...referenceIds, ...sourceTemplateReferenceIds], templateFixedReferences.length, actualStyleReferenceGroups.reduce((total, group) => total + group.references.length, 0), true); }
    catch (error) { throw new StudioError((error as Error).message); }
    if (input.taskSettings?.sourceTaskId) {
      const originalGlobalContext = await studioSettingsSourceContext(tx, identity, input.taskSettings.sourceTaskId);
      if (contextMode === 'historical') snapshotGlobalContext = originalGlobalContext;
    }
    const baseContext = [snapshotGlobalContext.trim(), snapshotModuleContext.trim()].filter(Boolean).join('\n\n---\n模块上下文：\n');
    if (!input.prompt.trim() && !baseContext.trim() && !skills.length && primaryReferenceIds.length + auxiliaryCount === 0) throw new StudioError('请填写画面描述、上下文、选择skills或添加参考图片');
    const referenceDescriptors: Array<{ id: string; role: 'primary' | 'transient-auxiliary' | 'template-reference' | 'template-fixed' | 'style-fixed'; label: string; note?: string; styleGroupId?: string }> = [];
    primaryReferenceIds.forEach((id, index) => referenceDescriptors.push({ id, role: 'primary', label: `主图 ${index + 1}（主图${'一二三四五六七八九十'[index]}，主要内容）` }));
    auxiliaryTransientIds.forEach((id, index) => referenceDescriptors.push({ id, role: 'transient-auxiliary', label: `辅助参考图 ${index + 1}` }));
    sourceTemplateReferenceIds.forEach((id, index) => referenceDescriptors.push({ id, role: 'template-reference', label: `模板参考图 ${index + 1}（辅助参考）`,
      ...(restored && typeof historicalTemplateReferences[index]?.note === 'string' ? { note: historicalTemplateReferences[index].note as string } : {}) }));
    actualTemplateFixedReferences.forEach((reference, index) => referenceDescriptors.push({ id: reference.assetId, role: 'template-fixed', label: `模板${String.fromCharCode(65 + index)}（辅助参考）`, note: reference.note }));
    for (const group of actualStyleReferenceGroups) {
      group.references.forEach((reference, index) => referenceDescriptors.push({ id: reference.assetId, role: 'style-fixed', label: `风格组「${group.name}」图片 ${index + 1}（辅助参考）`, note: reference.note, styleGroupId: group.id }));
    }
    const orderedReferenceIds = referenceDescriptors.map(reference => reference.id);
    const actualFixedIds = Array.from(new Set([...actualFixedReferences.map(reference => reference.assetId), ...sourceTemplateReferenceIds]));
    const referenceInstructions = referenceDescriptors.map((reference, index) =>
      `实际第 ${index + 1} 张：${reference.label}${reference.note !== undefined ? `；备注（JSON 字符串）：${JSON.stringify(reference.note)}` : ''}`
    ).join('\n');
    const styleNoteInstructions = actualStyleReferenceGroups.flatMap(group => {
      const note = group.note?.trim();
      const labels = referenceDescriptors.filter(reference => reference.styleGroupId === group.id).map(reference => reference.label);
      return note && labels.length ? [`风格组「${group.name}」备注（适用于${labels.join('、')}；仅作辅助指导，不替代主参考图主体）：${JSON.stringify(note)}`] : [];
    }).join('\n');
    const roleInstructions = primaryReferenceIds.length
      ? '主图承担画面主要内容，模板中未特别指定对象的主要处理要求默认指向主图。多张主图的具体分工以模板和本次要求为准，不默认融合，也不将后续主图降为辅助参考。普通参考、模板固定图和风格组仅提供明确指定的辅助信息，不得擅自用其中的主体替换主图主体。素材备注只约束对应素材的用途，不改变主图与辅助参考的角色。'
      : '本次没有主图，按文字要求生成。辅助参考仅提供指定的辅助信息，不自动将其中的主体当作生成主体。';
    const historicalEvolution = historicalSnapshot?.evolution;
    const evolutionRequest = input.evolution || (historicalEvolution ? parseEvolution({ direction: (historicalEvolution as { direction: string }).direction, manual: (historicalEvolution as { manual: boolean }).manual }) : undefined);
    const capability = evolutionCapability({ id: workspace?.id, context: snapshotModuleContext });
    if (evolutionRequest && !capability && !historicalEvolution) throw new StudioError('当前模板不支持演化方向');
    let evolution;
    try { if (evolutionRequest) evolution = resolveEvolution(evolutionRequest, input.prompt, capability || { version: 1, defaultDirection: 'increase' }); }
    catch (error) { throw new StudioError((error as Error).message); }
    const context = [baseContext.trim(), evolution ? evolutionInstructions(evolution) : '', referenceInstructions ? `${roleInstructions}\n\n参考图顺序与作用（编号与实际发送次序一致）：\n${referenceInstructions}` : '',
      styleNoteInstructions ? `风格组补充说明：\n${styleNoteInstructions}` : '',
      skills.length ? `补充文字skills（仅补充本次未指定部分；本次手写要求优先；多个组冲突时后组优先）：\n${skills.map((skill, index) => `${index + 1}. ${JSON.stringify(skill.prompt)}`).join('\n')}` : '']
      .filter(Boolean).join('\n\n---\n');
    if (!preparation) {
      try { await reserveImageStudioQueueCapacity(tx, ownerId, input.count); }
      catch (error) {
        if (error instanceof QueueCapacityError || error instanceof QueueMaintenanceError) throw new StudioError(error.message, error.status);
        throw error;
      }
    }
    const ownedTransientIds = uniqueTransientIds.filter(id => !canvasReferenceOwners.has(id));
    const visibleTransient = await tx.asset.count({ where: { id: { in: ownedTransientIds }, owner_id: ownerId, status: 'active', type: 'image', AND: [await studioVisibleAssetWhere(identity, tx)] } });
    if (visibleTransient !== ownedTransientIds.length) throw new StudioError('本次参考图已不可用或无权查看', 403);
    if (restored && sourceTemplateReferenceIds.length) {
      const visibleTemplateReferences = await tx.asset.count({ where: { id: { in: sourceTemplateReferenceIds }, status: 'active', type: 'image',
        AND: [await studioVisibleAssetWhere(identity, tx)] } });
      if (visibleTemplateReferences !== new Set(sourceTemplateReferenceIds).size) throw new StudioError('原记录的模板参考图已不可用或无权使用，请使用当前模板', 403);
    }
    const actualReferenceIds = Array.from(new Set(orderedReferenceIds));
    try { assertImageQualityReferenceCount(qualityRoute?.qualityRoute, orderedReferenceIds.length); }
    catch (error) { throw new StudioError((error as Error).message, 400); }
    if (imageChannel) {
      const validation = validateImageGenerationChannel(imageApi, { model: generation.model, quality: generation.quality,
        resolution: effectiveResolution, ratio: effectiveAspectRatio, referenceCount: orderedReferenceIds.length });
      if (!validation.ok) throw new StudioError(validation.error, 400);
    }
    const references = await tx.asset.findMany({ where: { id: { in: actualReferenceIds }, status: 'active', type: 'image',
      OR: [{ owner_id: ownerId }, { id: { in: actualFixedIds } }, ...Array.from(canvasReferenceOwners, ([id, expectedOwner]) => ({ id, owner_id: expectedOwner }))] },
      select: { id: true, owner_id: true, original_url: true, thumbnail_url: true, file_name: true, mime_type: true, width: true, height: true, file_size: true, hash: true } });
    const referencesById = new Map(references.map(reference => [reference.id, reference]));
    if (orderedReferenceIds.some(id => !referencesById.has(id))) throw new StudioError('固定参考图或本次参考图已不可用，或当前账号无权使用', 403);
    let canvasPromptFingerprint: string | undefined;
    if (canvasPrompt) {
      const pairs = Object.entries(canvasPrompt.referenceAssets);
      if (new Set(pairs.map(([, assetId]) => assetId)).size !== pairs.length) throw new StudioError('多张绑定图片指向同一原件，请重新选择明确的参考图', 400);
      const actualIds = orderedReferenceIds.map(assetId => pairs.find(([, id]) => id === assetId)?.[0] || `canvas-original-${assetId}`);
      const compiled = compileCanvasPromptReferences({ prompt: rawCanvasPrompt, promptMentions: canvasPrompt.mentions, referenceImageIds: actualIds });
      input.prompt = compiled.prompt; canvasPromptFingerprint = compiled.fingerprint;
    }
    if (reproduceFromTaskId && references.some(ref => actualFixedIds.includes(ref.id) && !freshlySelectedStyleIds.has(ref.id) && ref.owner_id !== (historicalReferenceOwners[ref.id] || ownerId))) throw new StudioError('历史参考图归属已变化，请重新选择风格组或模板', 403);
    if (restored && Array.isArray(historicalSnapshot?.referenceImages)) {
      const historicalHashes = new Map(historicalSnapshot.referenceImages.flatMap(record => record && typeof record === 'object'
        && typeof record.id === 'string' && typeof record.hash === 'string' ? [[record.id, record.hash] as const] : []));
      if (references.some(ref => actualFixedIds.includes(ref.id) && !freshlySelectedStyleIds.has(ref.id)
        && historicalHashes.has(ref.id) && historicalHashes.get(ref.id) !== ref.hash)) {
        throw new StudioError('原记录的参考图内容已变化，请重新选择本次风格或模板', 409);
      }
    }
    const referenceSnapshot = referenceDescriptors.map(referenceDescriptor => {
      const id = referenceDescriptor.id;
      const reference = referencesById.get(id);
      const useOnly = canvasReferenceOwners.has(id) && reference?.owner_id !== ownerId;
      return { id, originalUrl: reference && !useOnly ? studioTemplateAssetUrl(id) : null, thumbnailUrl: reference && !useOnly ? studioTemplateAssetUrl(id, true) : null,
        fileName: reference?.file_name || null, mimeType: reference?.mime_type || null, width: reference?.width || null,
        height: reference?.height || null, fileSize: reference?.file_size || null, hash: reference?.hash || null,
        referenceRole: referenceDescriptor.role,
        ...(referenceDescriptor.note !== undefined ? { note: referenceDescriptor.note } : {}) };
    });
    const fixedReferenceSnapshot = referenceSnapshot.filter(reference => reference.referenceRole === 'template-fixed' || reference.referenceRole === 'style-fixed');
    const transientReferenceSnapshot = referenceSnapshot.filter(reference => reference.referenceRole === 'primary' || reference.referenceRole === 'transient-auxiliary');
    const primaryReferenceSnapshot = referenceSnapshot.filter(reference => reference.referenceRole === 'primary');
    const auxiliaryReferenceSnapshot = referenceSnapshot.filter(reference => reference.referenceRole !== 'primary');
    const requestedAspectRatio = effectiveAspectRatio;
    const firstReference = primaryReferenceIds.map(id => referencesById.get(id)).find(reference => reference?.width && reference?.height) || null;
    if (requestedAspectRatio === 'auto' && primaryReferenceIds.length && !firstReference) {
      throw new StudioError('主图尺寸尚未确认，暂时不能自动跟随原图比例；请选择明确比例，或重新上传主图');
    }
    const fourToOneSupported = imageGenerationSupportsStudioFourToOne(imageApi, generation.model);
    let ratioResolution: ReturnType<typeof resolveStudioAspectRatio>;
    try { ratioResolution = resolveStudioAspectRatio(requestedAspectRatio, firstReference, fourToOneSupported, true); }
    catch (error) { throw new StudioError(error instanceof Error ? error.message : '原图比例无法确认，请选择明确比例'); }
    const aspectRatio = ratioResolution.requested;
    const resolvedAspectRatio = ratioResolution.resolved;
    const aspectRatioSource = ratioResolution.source;
    const ratioIssue = studioFourToOneIssue(resolvedAspectRatio, fourToOneSupported);
    if (ratioIssue) throw new StudioError(ratioIssue);
    const resolution = normalizeImageResolution(generation.model, effectiveResolution, imageApi.provider);
    const outputSize = imageGenerationModelOutputSize(imageApi, generation.model, resolution, resolvedAspectRatio, sizePolicyVersion);
    const moduleContextVersion = await bindModuleContextVersion(snapshotModuleContext, tx);
    if (!preparation && !billingQuoteId && actualBillingEligible) {
      throw new StudioError('当前模型需要确认有效报价，请重新报价后提交；尚未生成', 409);
    }
    // Freeze the channel before hashing the quote; its returned snapshot must
    // describe the same input when the user later accepts that quote.
    const contractImageChannel = imageChannel || originalSharedChannel || input.imageChannel
      || (preparation && !acceptedContract && (pricingQuote || actualBillingEligible) && effectiveRequestedChannelId === 'original'
        ? await captureImageGenerationChannel(generation.model, 'original', tx)
        : undefined);
    let billingContract = fixedImageBillingContract({ scope: billingScope, model: generation.model, credits: price,
      specification: imageSpecification({ model: generation.model, quality: generation.quality, outputSize,
        aspectRatio: resolvedAspectRatio, referenceCount: orderedReferenceIds.length,
        inputCharacters: context.length + input.prompt.length,
        inputDigest: createHash('sha256').update(JSON.stringify({ context, prompt: input.prompt,
          ...(input.projectId !== undefined || canvasUse?.projectId !== undefined ? { usageProjectId } : {}),
          avatar: avatar?.candidates, references: referenceSnapshot.map(ref => ({ id: ref.id, hash: ref.hash })),
          imageChannel: contractImageChannel || null,
          revision: settings.revision, moduleRevision: sharedDefinition ? undefined : workspace?.revision,
          ...(sharedDefinition ? { sharedLive: sharedDefinition.intent } : {}),
          ...(input.taskSettings ? { taskSettings: input.taskSettings } : {}),
          ...(input.restoredSettings ? { restoredSettings: input.restoredSettings, personalPrompt,
            styleGroupIds, styleGroups: styleGroupSnapshot, skills: skills.map(skill => ({ id: skill.id, promptVersion: skill.promptVersion })) } : {}) })).digest('hex') }) });
    if (pricingQuote) billingContract = withPricingImageContract(billingContract, pricingQuote.charge, price);
    if (acceptedContract) {
      const frozen = parseImageBillingContract(JSON.stringify(acceptedContract));
      if (!frozen || frozen.scope !== billingScope || frozen.model !== generation.model
        || frozen.specification !== billingContract.specification) throw new StudioError('父批次冻结合同与当前原始输入不匹配，未创建子项', 409);
      billingContract = frozen;
    }
    if (billingQuoteId) {
      if (preparation) throw new StudioError('批量准备不能沿用已确认的单次报价', 409);
      try {
        billingContract = await consumeImageQuote(tx, { owner: ownerId, id: billingQuoteId,
          sizePolicyVersion,
          count: input.count, fingerprint: billingContract.specification, specification: billingContract.specification,
          scope: billingScope, model: generation.model, imageChannel: contractImageChannel,
          ...(sharedDefinition ? { sharedLive: sharedDefinition.intent } : {}) });
      } catch { throw new StudioError('实扣报价已过期、被使用或参数已变化，请重新报价', 409); }
      price = billingContract.authorizedCredits;
      if (!samePricingImageCharge(pricingQuote?.charge, billingContract.pricing)) throw new StudioError('收费合同或图片规格已变化，请重新报价；未沿旧报价生成', 409);
      if (billingContract.pricing) await assertNewPricingCharge(billingContract.pricing, body.pricingRevision, tx);
      const authorizedUnitCredits = price;
      if (input.maxEstimatedCost === undefined || sumCredits(Array.from({ length: input.count }, () => authorizedUnitCredits)) > input.maxEstimatedCost) throw new StudioError('请先确认本次预估及最高扣点授权', 409);
    }
    const fingerprint = imageChannel
      ? createHash('sha256').update(`${requestFingerprint}\0${imageChannel.channelId}\0${imageChannel.configRevision}`).digest('hex')
      : requestFingerprint;
    const quoteImageChannel = contractImageChannel
      || (preparation && effectiveRequestedChannelId === 'original'
        ? await captureImageGenerationChannel(generation.model, 'original', tx)
        : undefined);
    const snapshot = JSON.stringify({
      version: 1,
      ...(input.taskSettings ? { taskSettings: input.taskSettings } : {}),
      usageAttribution: { version: 1, projectId: usageProjectId },
      requestId: input.requestId, batchId, inputFingerprint: requestFingerprint,
      ...(quoteImageChannel
        ? { imageChannel: quoteImageChannel, imageChannelLabel: imageApi.label || imageApi.channelId,
        imageSupplierName: imageApi.supplierName } : {}),
      ...(canvasPrompt ? { canvasPromptMentions: parseCanvasPromptMentions(canvasPrompt.mentions), canvasPromptFingerprint } : {}),
      referenceImages: referenceSnapshot,
      ...(sharedDefinition || restored ? { templateReferenceImages: referenceSnapshot.filter(reference => reference.referenceRole === 'template-reference') } : {}),
      fixedReferenceImages: fixedReferenceSnapshot,
      templateFixedCount: actualTemplateFixedReferences.length,
      primaryReferenceImages: primaryReferenceSnapshot,
      auxiliaryReferenceImages: auxiliaryReferenceSnapshot,
      styleGroupIds, styleGroups: styleGroupSnapshot, ...(consumerStyleGroupIds.length ? { consumerStyleGroupIds } : {}),
      skills, skillIds: skills.map(skill => skill.id), effectiveContext: context,
      referencePolicy: { ...referencePolicy, primaryIds: primaryReferenceIds },
      authorizedReferenceOwners: Object.fromEntries(references.map(ref => [ref.id, ref.owner_id])),
      ...(canvasUse ? { canvasReferenceImageIds: canvasUse.referenceImageIds } : {}),
      transientReferenceImages: transientReferenceSnapshot,
      globalContext: snapshotGlobalContext,
      moduleContext: snapshotModuleContext,
      moduleContextVersion, moduleContextVersionRule: MODULE_CONTEXT_VERSION_RULE,
      moduleId: workspace?.id || moduleId || null,
      sourcePresetId,
      ...(sharedDefinition ? { sharedLive: sharedDefinition.intent, templatePrompt: effectiveTemplatePrompt, personalPrompt,
        sharedSourceRevision: sharedDefinition.sourceRevision, sharedSourceOwnerId: sharedDefinition.sourceOwnerId } : {}),
      ...(restored ? { restoredSettings: input.restoredSettings, templatePrompt: effectiveTemplatePrompt, personalPrompt,
        restoredSource: { taskId: restored.source.id, moduleId: restored.source.module_id,
          sourcePresetId: restored.source.source_preset_id || (typeof restored.snapshot.sourcePresetId === 'string' ? restored.snapshot.sourcePresetId : null),
          ...(typeof restored.snapshot.sharedSourceRevision === 'string' ? { sharedSourceRevision: restored.snapshot.sharedSourceRevision } : {}),
          ...(typeof restored.snapshot.sharedSourceOwnerId === 'string' ? { sharedSourceOwnerId: restored.snapshot.sharedSourceOwnerId } : {}),
          ...(Number.isInteger(restored.snapshot.settingsRevision) ? { settingsRevision: restored.snapshot.settingsRevision } : {}),
          ...(Number.isInteger(restored.snapshot.moduleRevision) ? { moduleRevision: restored.snapshot.moduleRevision } : {}) } } : {}),
      reproducedFromTaskId: reproduceFromTaskId || null,
      moduleName: sharedDefinition?.name || workspace?.name || null,
      prompt: input.prompt,
      ...(evolution ? { evolution } : {}),
      model: generation.model,
      quality: generation.quality,
      prices: generation.prices,
      unitCredits: price,
      billingContract,
      count: input.count,
      aspectRatio,
      resolvedAspectRatio,
      aspectRatioSource,
      ratioContractVersion: 2,
      sizePolicyVersion,
      resolution,
      outputSize: outputSize || null,
      resolvedOutputSize: outputSize || null,
      outputFormat: 'png',
      settingsRevision: settings.revision,
        moduleRevision: workspace?.revision ?? null,
    });
    for (let i = 0; i < input.count; i++) {
      const id = `${billingContract.pricing ? 'rate-' : ''}${batchId}-${i}`;
      const candidate = sheet ? undefined : avatar?.candidates[i];
      const taskPrompt = candidate?.prompt || input.prompt;
      const freeze = !preparation && price > 0 ? await allocateTaskCredits(tx, user, price, id) : null;
      const taskData: Prisma.ImageStudioTaskUncheckedCreateInput = {
        id, batch_id: batchId, owner_id: ownerId, module_id: moduleId as string | undefined, source_preset_id: sourcePresetId, ordinal: i + 1, fingerprint,
        billing_mode: billingContract.mode, billing_scope: billingScope,
        billing_contract_json: JSON.stringify(billingContract), billing_status: studioBillingState({ billing_contract_json: JSON.stringify(billingContract) }, imageChannel ? 'channel_awaiting_response' : 'awaiting_response'),
        billing_deadline: billingContract.mode === 'actual' ? new Date(billingContract.deadline!) : null,
        prompt: taskPrompt, context, revision: settings.revision, model: generation.model,
        quality: generation.quality,
        provider_cost_usd: imageChannel ? null : IMAGE_STUDIO_MODEL_COST_USD[generation.model as keyof typeof IMAGE_STUDIO_MODEL_COST_USD],
        status: studioTaskState({ billing_contract_json: JSON.stringify(billingContract) }, imageChannel ? 'channel_queued' : 'queued'),
        snapshot_json: sheet ? JSON.stringify({ ...JSON.parse(snapshot), avatarLayout: avatar!.layout, avatar: { layout: avatar!.layout, cells: avatar!.candidates } }) : candidate ? JSON.stringify({ ...JSON.parse(snapshot), prompt: taskPrompt, avatar: candidate }) : snapshot,
        aspect_ratio: aspectRatio, output_size: outputSize,
        reference_ids: JSON.stringify(orderedReferenceIds), unit_credits: price, freeze_snapshot: freeze?.snapshot,
      };
      const protectedTaskData = transformPrivateImageTask({ ...taskData, id, owner_id: ownerId,
        prompt: taskPrompt, context, snapshot_json: taskData.snapshot_json ?? null }, true);
      if (preparation) await preparation.save(tx, protectedTaskData);
      else {
        const created = await tx.imageStudioTask.create({ data: protectedTaskData });
        if (roleMedia && roleMedia.context && typeof roleMedia.context === 'object' && 'runId' in roleMedia.context) {
          await inheritUsageAttribution(tx, { sourceKind: 'image_task', sourceId: created.id,
            actorUserId: ownerId, ownerUserId: ownerId, billingSubjectType: 'user', billingSubjectId: ownerId,
            occurredAt: created.created_at, parentSourceKind: 'role_run', parentSourceId: String(roleMedia.context.runId) });
        } else await recordUsageAttribution(tx, { sourceKind: 'image_task', sourceId: created.id,
          actorUserId: ownerId, ownerUserId: ownerId, billingSubjectType: 'user', billingSubjectId: ownerId,
          projectId: usageProjectId, occurredAt: created.created_at, contextOrigin: canvasUse ? 'canvas-context' : 'image-explicit-project' });
      }
      if (roleMedia) await bindRoleMediaTask(tx, roleMedia, { kind: 'image', taskId: id,
        requestId: input.requestId, ordinal: i + 1, model: generation.model,
        providerId: quoteImageChannel?.channelId || imageApi.channelId || 'original', reservedPoints: price });
      if (freeze) await tx.creditLedger.create({ data: {
        user_id: ownerId, type: 'task_freeze', amount: -price,
        balance_before: freeze.balance_before, balance_after: freeze.balance_after,
        frozen_before: freeze.frozen_before, frozen_after: freeze.frozen_after,
        related_task_id: id, idempotency_key: `image-studio:freeze:${id}`, reason: '图片生成冻结积分',
        metadata_json: JSON.stringify({ allocations: freeze.allocations }),
      } });
    }
    if (!preparation && avatar?.onQueued) await avatar.onQueued(tx, batchId);
  }, { timeout: 15000 }));
  return batchId;
}

export async function finishStudioTask(task: ImageStudioTask, status: 'succeeded' | 'failed' | 'uncertain', data: { assetId?: string; preparedAsset?: Prisma.AssetUncheckedCreateInput; retainedAsset?: Prisma.AssetUncheckedCreateInput; error?: string; usage?: unknown } = {}, transaction?: Prisma.TransactionClient) {
  const finish = async (tx: Prisma.TransactionClient) => {
    const recovering = publicPricingTaskState(task.status) === 'uncertain';
    const retainedMismatch = Boolean(data.retainedAsset && studioDimensionMismatch({ status, usage_json: JSON.stringify(data.usage) }));
    if (data.retainedAsset && !retainedMismatch) throw new Error('Retained output requires a proven dimension mismatch');
    if (recovering && status === 'uncertain' && !retainedMismatch) return false;
    const recovery = recovering ? await import('./async-recovery') : null;
    if (recovery && !await recovery.studioAsyncRecoveryLease(tx, task)) return false;
    const activeStatus = studioTaskState(task, recovering ? 'uncertain' : publicPricingTaskState(task.status) === 'channel_running' ? 'channel_running' : 'running');
    const channel = publicPricingTaskState(activeStatus) === 'channel_running' || recovering;
    // Complete the same recovery CAS before changing task state; both roll back
    // with asset/ledger settlement if any later step fails.
    if (recovery && (status !== 'uncertain' || retainedMismatch)) await recovery.completeStudioAsyncRecovery(tx, task);
    const changed = await tx.imageStudioTask.updateMany({
      where: { id: task.id, status: activeStatus, lease_token: task.lease_token, lease_until: { gt: new Date() } },
      data: { status: studioTaskState(task, status), asset_id: data.assetId, error: status === 'succeeded' ? null : data.error, usage_json: data.usage ? JSON.stringify(data.usage) : undefined,
        lease_until: null, lease_token: null, finished_at: new Date() },
    });
    if (!changed.count) { if (recovery) throw new Error('async_recovery_finish_lease_lost'); return false; }
    const prepared = status === 'succeeded' ? data.preparedAsset : data.retainedAsset;
    if (prepared) {
      if (prepared.owner_id !== task.owner_id || !prepared.hash || prepared.type !== 'image') throw new Error('Output ownership mismatch');
      const asset = await tx.asset.upsert({ where: { owner_id_hash: { owner_id: task.owner_id, hash: prepared.hash } },
        create: prepared, update: { thumbnail_url: prepared.thumbnail_url, width: prepared.width, height: prepared.height } });
      if (asset.status !== 'active' || asset.mime_type !== prepared.mime_type || asset.original_url !== prepared.original_url
        || !asset.thumbnail_url || asset.width !== prepared.width || asset.height !== prepared.height) throw new Error('Output asset unavailable');
      await tx.imageStudioTask.update({ where: { id: task.id }, data: { asset_id: asset.id } });
    }
    // A channel request with an unknown result must remain visible and retain
    // its original reservation. It is not permission to refund or re-submit.
    if ((channel || isPricingImageTask(task)) && status === 'uncertain') return true;
    const billing = parseImageBillingContract(task.billing_contract_json);
    if (isPricingImageTask(task) && !billing?.pricing) throw new Error('新版图片原收费合同无法确认，已停止结算');
    if (task.billing_mode === 'actual') {
      if (!billing || billing.mode !== 'actual' || billing.scope !== task.billing_scope
        || billing.authorizedCredits !== task.unit_credits) throw new Error('图片收费合同无效');
      if (status === 'succeeded') {
        await tx.imageStudioTask.update({ where: { id: task.id }, data: { billing_status: studioBillingState(task, channel ? 'channel_pending' : 'pending'),
          billing_deadline: new Date(billing.deadline!), billing_next_check_at: new Date() } });
        return true;
      }
    }
    if (task.billing_mode !== 'actual' && channel) {
      await tx.imageStudioTask.update({ where: { id: task.id }, data: { billing_status: studioBillingState(task, status === 'succeeded' ? 'channel_confirmed' : 'channel_provider_loss'),
        billing_next_check_at: null } });
    } else if (task.billing_mode === 'actual' && channel) {
      const persisted = await tx.imageStudioTask.findUnique({ where: { id: task.id }, select: { gateway_request_id: true } });
      await tx.imageStudioTask.update({ where: { id: task.id }, data: { billing_status: studioBillingState(task, persisted?.gateway_request_id ? 'channel_pending' : 'channel_unmatched'),
        billing_next_check_at: new Date() } });
    }
    if (task.unit_credits === 0) {
      await tx.imageStudioTask.update({ where: { id: task.id }, data: { actual_credits: 0,
        billing_settled_at: new Date() } });
      return true;
    }
    const settlement = await settleTaskCredits(tx, { taskId: task.id, userId: task.owner_id,
      terminalStatus: status, frozenAmount: task.unit_credits, freezeSnapshot: task.freeze_snapshot,
      ...(task.billing_mode === 'actual' ? { actualCost: 0 } : {}) });
    await tx.creditLedger.create({ data: {
      user_id: task.owner_id, type: status === 'succeeded' ? 'task_success_deduct' : 'task_failed_refund',
      amount: status === 'succeeded' ? -settlement.actualCost : settlement.refundedAmount,
      balance_before: settlement.balanceBefore, balance_after: settlement.balanceAfter,
      frozen_before: settlement.frozenBefore, frozen_after: settlement.frozenAfter,
      related_task_id: task.id, idempotency_key: `image-studio:settle:${task.id}`,
      reason: status === 'succeeded' ? '图片已保存，结算积分' : data.retainedAsset ? '图片规格不符，保留原图并释放冻结积分' : '图片未交付，释放冻结积分',
      metadata_json: JSON.stringify({ allocations: settlement.allocations, expired_closed: settlement.expiredClosedAmount }),
    } });
    await tx.imageStudioTask.update({ where: { id: task.id }, data: { actual_credits: settlement.actualCost,
      billing_settled_at: new Date() } });
    return true;
  };
  return transaction ? finish(transaction) : prisma.$transaction(finish, { timeout: 15000 });
}

export async function claimStudioTask() {
  let cursor: string | undefined;
  let candidate: ImageStudioTask | undefined;
  for (;;) {
    const candidates = await prisma.imageStudioTask.findMany({ where: { status: { in: studioTaskStates(['queued', 'channel_queued']) } },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }], take: 32, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    for (const row of candidates) {
      if (isPricingImageTask(row)) {
        try { await assertPricingImageConsumerReady(prisma); } catch { continue; }
      }
      try { assertFrozenSharedStudioTask(transformPrivateImageTask(row, false)); }
      catch {
        const message = '任务快照或共享模板协议无法确认；原任务与费用预留保留，请管理员核对，未请求生成';
        if (row.error !== message) await prisma.imageStudioTask.updateMany({ where: { id: row.id, status: row.status }, data: { error: message } });
        continue;
      }
      if (publicPricingTaskState(row.status) === 'channel_queued') {
        try {
          const snapshot = safeImageChannelSnapshot(JSON.parse(row.snapshot_json || '{}').imageChannel);
          if (!snapshot) throw new Error('missing_channel');
          const { assertImageGenerationChannelDispatchOpen } = await import('@/lib/integrations/image-generation');
          await assertImageGenerationChannelDispatchOpen(snapshot);
        } catch (error) {
          const message = error instanceof ImageGenerationChannelError ? error.message : '原图片配置暂不能读取；任务与预留保留，请管理员核对或取消未受理任务';
          if (row.error !== message) await prisma.imageStudioTask.updateMany({ where: { id: row.id, status: row.status }, data: { error: message } });
          continue;
        }
      }
      candidate = row; break;
    }
    if (candidate || candidates.length < 32) break;
    cursor = candidates[candidates.length - 1].id;
  }
  if (!candidate) return null;
  const leaseToken = randomUUID();
  const channel = publicPricingTaskState(candidate.status) === 'channel_queued';
  const runningStatus = studioTaskState(candidate, channel ? 'channel_running' : 'running');
  const changed = await prisma.imageStudioTask.updateMany({ where: { id: candidate.id, status: candidate.status },
    data: { status: runningStatus, lease_token: leaseToken, lease_until: new Date(Date.now() + 10 * 60 * 1000) } });
  return changed.count ? { ...candidate, status: runningStatus, lease_token: leaseToken } : null;
}

/** Cancel only a provably unattempted explicit-channel task; accepted receipts never mean a refund. */
export async function cancelQueuedChannelTask(ownerId: string, id: string, client?: Prisma.TransactionClient) {
  const cancel = async (tx: Prisma.TransactionClient) => {
    const task = await tx.imageStudioTask.findFirst({ where: { id, owner_id: ownerId } });
    if (!task) throw new StudioError('图片任务不存在或无权操作', 404);
    if (task.status === 'cancelled') return false;
    if (publicPricingTaskState(task.status) !== 'channel_queued') throw new StudioError('只能取消尚未向供应商请求的通道排队任务；已有受理或未知结果请核对原记录', 409);
    const { readStudioRequestReceipt, readStudioAsyncReceipt } = await import('./delivery');
    const receipt = await readStudioRequestReceipt(task);
    if (receipt && receipt.dispatchState !== 'held' || await readStudioAsyncReceipt(task)) {
      throw new StudioError('任务已有请求或受理凭据，不能以取消释放预留；未停止供应商，也未重新生成', 409);
    }
    const changed = await tx.imageStudioTask.updateMany({ where: { id, owner_id: ownerId, status: task.status },
      data: { status: 'cancelled', error: '本人取消了未向供应商请求的排队任务；原记录保留', finished_at: new Date(),
        lease_token: null, lease_until: null, billing_status: studioBillingState(task, 'channel_cancelled'), billing_next_check_at: null } });
    if (!changed.count) throw new StudioError('任务已开始执行，请重新读取；没有确认取消或退款', 409);
    if (task.unit_credits > 0) {
      const settlement = await settleTaskCredits(tx, { taskId: id, userId: ownerId, terminalStatus: 'failed',
        frozenAmount: task.unit_credits, freezeSnapshot: task.freeze_snapshot, actualCost: 0 });
      await tx.creditLedger.create({ data: { user_id: ownerId, type: 'task_failed_refund',
      amount: settlement.refundedAmount, balance_before: settlement.balanceBefore, balance_after: settlement.balanceAfter,
      frozen_before: settlement.frozenBefore, frozen_after: settlement.frozenAfter, related_task_id: id,
      idempotency_key: `image-studio:settle:${id}`, reason: '取消未向供应商请求的图片任务，释放原预留',
      metadata_json: JSON.stringify({ allocations: settlement.allocations, expired_closed: settlement.expiredClosedAmount }) } });
    }
    await tx.imageStudioTask.update({ where: { id }, data: { actual_credits: 0, billing_settled_at: new Date() } });
    return true;
  };
  return client ? cancel(client) : prisma.$transaction(cancel, { timeout: 15000 });
}

export async function listStudioTasks(ownerId: string, cursor?: string, moduleId?: string, isAdmin = false, taskId?: string, requestId?: string, likedOnly = false) {
  if (moduleId && !validStudioModuleId(moduleId, ownerId)) throw new StudioError('模块编号无效');
  if (taskId !== undefined && (typeof taskId !== 'string' || !taskId || taskId.length > 120)) throw new StudioError('历史生成记录无效');
  if (requestId !== undefined && !/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) throw new StudioError('提交编号无效');
  const where: Prisma.ImageStudioTaskWhereInput = { ...studioTemplateTaskWhere(ownerId, moduleId, taskId !== undefined || Boolean(requestId)),
    ...(requestId ? { batch_id: createHash('sha256').update(`${ownerId}:${requestId}`).digest('hex') } : {}) };
  if (likedOnly) {
    if (!moduleId || taskId || requestId) throw new StudioError('请选择当前模板的喜欢结果');
    // Match the shared heart's legacy private-favorite compatibility, never another viewer's marks.
    const marks = await prisma.contentReaction.findMany({ where: { user_id: ownerId, content_key: { startsWith: 'asset:' }, OR: [{ liked: true }, { favorited: true }] }, select: { content_key: true } });
    const assets = await prisma.asset.findMany({ where: { id: { in: marks.map(mark => mark.content_key.slice(6)) }, owner_id: ownerId, status: 'active' }, select: { id: true } });
    where.asset_id = { in: assets.map(asset => asset.id) };
    where.AND = [...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []), studioOutputTaskWhere];
  }
  if (cursor && !(await prisma.imageStudioTask.findFirst({ where: { ...where, id: cursor }, select: { id: true } }))) {
    throw new StudioError('结果目录已变化，请重新读取', 409);
  }
  const total = await prisma.imageStudioTask.count({ where: { ...where, ...(taskId ? { id: taskId } : {}) } });
  const rows = taskId !== undefined
    ? await prisma.imageStudioTask.findFirst({ where: { ...where, id: taskId } }).then(task => task ? [task] : [])
    : await prisma.imageStudioTask.findMany({ where,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 25,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
  const items = taskId !== undefined ? rows : rows.slice(0, 24);
  return { total, tasks: await studioTaskDTOs(ownerId, isAdmin, items),
    ...(taskId !== undefined ? {} : { nextCursor: rows.length > 24 ? items[items.length - 1].id : null }) };
}

/** Owner-scoped callers only. Shared pins use a separate output-only projection. */
export async function studioTaskDTOs(ownerId: string, isAdmin: boolean, items: ImageStudioTask[]) {
  if (items.some(item => item.owner_id !== ownerId)) throw new StudioError('生成记录归属不匹配', 403);
  const outputAssetIds = items.flatMap(item => item.asset_id ? [item.asset_id] : []);
  const referenceIds = Array.from(new Set(items.flatMap(item => {
    try { return JSON.parse(item.reference_ids) as string[]; } catch { return []; }
  })));
  const assets = await prisma.asset.findMany({ where: { id: { in: [...outputAssetIds, ...referenceIds] }, ...(isAdmin ? {} : { owner_id: ownerId }), status: 'active' },
    select: { id: true, original_url: true, thumbnail_url: true, width: true, height: true, file_size: true, file_name: true, mime_type: true } });
  const assetById = new Map(assets.map(asset => [asset.id, asset]));
  const owner = items.length ? await prisma.user.findUnique({ where: { id: ownerId },
    select: { id: true, name: true, username: true, avatar_url: true } }) : null;
  const publicOwner = owner ? { id: owner.id, name: displayUserName(owner), avatar_url: owner.avatar_url } : null;
  const deliveries = new Map(await Promise.all(items.map(async task => [task.id, await studioDeliveryStatus(task)] as const)));
  const contextVersions = new Map(await Promise.all(items.map(async task => [task.id, await snapshotModuleContextVersion(task.snapshot_json)] as const)));
  return items.map(task => {
    const snapshot = publicStudioSnapshot(task, assetById, isAdmin, ownerId);
    const mismatch = studioDimensionMismatch(task);
    const readableIds = new Set(assetById.keys());
    return { id: task.id, batchId: task.batch_id, ordinal: task.ordinal,
      owner: publicOwner,
      delivery: deliveries.get(task.id),
      prompt: snapshot.prompt, model: task.model, quality: task.quality, status: publicImageTaskStatus(task.status),
      error: mismatch && studioTaskHasViewableOutput(task) ? studioDimensionMismatchNotice(mismatch.validation) : task.error, unitCredits: task.unit_credits,
      providerCostUsd: task.provider_cost_usd,
      billing: imageBillingView(task, ownerId, isAdmin),
      aspectRatio: task.aspect_ratio, outputSize: task.output_size,
      resultDisposition: mismatch ? mismatch.code === 'generated_format_mismatch' ? 'format_mismatch' : 'dimensions_mismatch' : task.status === 'succeeded' ? 'accepted' : null,
      outputIssue: studioOutputIssue(task),
      inputMainPreview: studioInputMainPreview({ kind: 'task', taskId: task.id }, task.snapshot_json, task.reference_ids, readableIds),
      createdAt: task.created_at, finishedAt: task.finished_at, referenceIds: snapshot.transientReferenceImages.map(image => image.id),
      snapshot: { ...snapshot, moduleContextVersion: contextVersions.get(task.id)?.code ?? null, moduleContextVersionState: contextVersions.get(task.id)?.state ?? 'missing' },
      asset: studioTaskHasViewableOutput(task) && assetById.get(task.asset_id || '') ? { ...assetById.get(task.asset_id || '')!, original_url: studioAssetUrl(task.asset_id!), thumbnail_url: studioAssetUrl(task.asset_id!, true) } : null,
    };
  });
}

export async function listAdminStudioTasks(cursor?: string, moduleId?: string, ownerId?: string) {
  const rows = await prisma.imageStudioTask.findMany({
    where: {
      ...(moduleId ? { module_id: moduleId } : {}),
      ...(ownerId ? { owner_id: ownerId } : {}),
    },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    take: 25,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const assetIds = rows.flatMap(task => task.asset_id ? [task.asset_id] : []);
  const assets = assetIds.length
    ? await prisma.asset.findMany({ where: { id: { in: assetIds } }, select: { id: true, original_url: true, thumbnail_url: true, width: true, height: true, status: true } })
    : [];
  const ownerIds = Array.from(new Set(rows.map(task => task.owner_id)));
  const owners = ownerIds.length
    ? await prisma.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true, username: true, email: true, avatar_url: true } })
    : [];
  const assetById = new Map(assets.map(asset => [asset.id, asset]));
  const ownerById = new Map(owners.map(owner => [owner.id, owner]));
  const items = rows.slice(0, 24).map(task => ({
    id: task.id,
    batchId: task.batch_id,
    ownerId: task.owner_id,
    owner: ownerById.get(task.owner_id) || null,
    moduleId: task.module_id,
    ordinal: task.ordinal,
    prompt: publicStudioSnapshot(task, new Map(), false, task.owner_id).prompt,
    model: task.model,
    status: publicImageTaskStatus(task.status),
    deletedAt: task.deleted_at,
    error: task.error,
    unitCredits: task.unit_credits,
    providerCostUsd: task.provider_cost_usd,
    billing: imageBillingView(task, task.owner_id, true),
    aspectRatio: task.aspect_ratio,
    outputSize: task.output_size,
    createdAt: task.created_at,
    finishedAt: task.finished_at,
    asset: assetById.get(task.asset_id || '') || null,
  }));
  return { tasks: items, nextCursor: rows.length > 24 ? items[items.length - 1].id : null };
}

export function publicStudioSnapshot(task: Pick<ImageStudioTask, 'id' | 'snapshot_json' | 'prompt' | 'model' | 'quality' | 'reference_ids' | 'aspect_ratio' | 'output_size'>, assets: Map<string, { id: string; original_url: string; thumbnail_url: string | null; width: number | null; height: number | null }>, isAdmin: boolean, viewerOwnerId?: string) {
  let parsed: Record<string, unknown> = {};
  try { parsed = task.snapshot_json ? JSON.parse(task.snapshot_json) as Record<string, unknown> : {}; } catch { parsed = {}; }
  const protectedModule = Boolean(typeof parsed.sourcePresetId === 'string' && privateOrigin('image-preset', parsed.sourcePresetId)
    || typeof parsed.moduleId === 'string' && privateOrigin('image-module', parsed.moduleId));
  const protectedGlobal = Boolean(privateOrigin('image-global', 'gpt_image_studio_v1'));
  const publicText = (value: unknown, protectedField: boolean) => !protectedField && typeof value === 'string'
    && !isStoredPrivatePrompt(value) ? value : '';
  const fallbackReferences = (() => {
    try { return (JSON.parse(task.reference_ids) as string[]).map(id => { const asset = assets.get(id); return { id, originalUrl: asset ? studioTemplateAssetUrl(id) : null, thumbnailUrl: asset ? studioTemplateAssetUrl(id, true) : null, width: asset?.width || null, height: asset?.height || null }; }); }
    catch { return []; }
  })();
  const snapshotReferences = Array.isArray(parsed.referenceImages) && parsed.referenceImages.length ? parsed.referenceImages : fallbackReferences;
  const snapshotFixedReferences = Array.isArray(parsed.fixedReferenceImages) ? parsed.fixedReferenceImages : [];
  let snapshotTemplateReferences: Record<string, unknown>[] = [];
  try { snapshotTemplateReferences = historicalStudioTemplateReferences(parsed); } catch {}
  const snapshotTransientReferences = Array.isArray(parsed.transientReferenceImages)
    ? parsed.transientReferenceImages
    : snapshotFixedReferences.length ? [] : snapshotReferences;
  const transientIds = snapshotTransientReferences.flatMap(item => item && typeof item === 'object' && typeof (item as Record<string, unknown>).id === 'string' ? [(item as Record<string, unknown>).id as string] : []);
  let referencePolicy: StudioReferencePolicy;
  try {
    referencePolicy = parsed.referencePolicy === undefined
      ? defaultStudioReferencePolicy(transientIds)
      : mapStudioReferencePolicy(parsed.referencePolicy, transientIds);
  } catch {
    referencePolicy = defaultStudioReferencePolicy(transientIds);
  }
  const primaryIdSet = new Set(referencePolicy.primaryIds);
  const snapshotPrimaryReferences = Array.isArray(parsed.primaryReferenceImages)
    ? parsed.primaryReferenceImages.filter(item => item && typeof item === 'object' && typeof (item as Record<string, unknown>).id === 'string' && primaryIdSet.has((item as Record<string, unknown>).id as string))
    : snapshotTransientReferences.filter(item => item && typeof item === 'object' && typeof (item as Record<string, unknown>).id === 'string' && primaryIdSet.has((item as Record<string, unknown>).id as string));
  const snapshotTransientAuxiliaryReferences = snapshotTransientReferences.filter(item => {
    if (!item || typeof item !== 'object') return false;
    const record = item as Record<string, unknown>;
    return record.referenceRole === 'transient-auxiliary' || (record.referenceRole !== 'primary' && typeof record.id === 'string' && !primaryIdSet.has(record.id));
  });
  const snapshotAuxiliaryReferences = Array.isArray(parsed.auxiliaryReferenceImages)
    ? parsed.auxiliaryReferenceImages.filter(item => {
      if (!item || typeof item !== 'object') return false;
      const record = item as Record<string, unknown>;
      if (typeof record.id !== 'string') return false;
      return typeof record.referenceRole === 'string' ? record.referenceRole !== 'primary' : !primaryIdSet.has(record.id);
    })
    : snapshotReferences.filter(item => item && typeof item === 'object' && typeof (item as Record<string, unknown>).id === 'string' && !primaryIdSet.has((item as Record<string, unknown>).id as string));
  const mapReference = (item: unknown) => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      if (typeof record.id !== 'string') return null;
      const asset = assets.get(record.id);
      return {
        id: record.id,
        comparison: { schema: 2 as const, kind: 'asset' as const, id: record.id, originalVersion: null },
        originalUrl: asset ? studioTemplateAssetUrl(record.id) : null,
        thumbnailUrl: asset ? studioTemplateAssetUrl(record.id, true) : null,
        fileName: typeof record.fileName === 'string' ? record.fileName : null,
        mimeType: typeof record.mimeType === 'string' ? record.mimeType : null,
        width: typeof record.width === 'number' ? record.width : asset?.width || null,
        height: typeof record.height === 'number' ? record.height : asset?.height || null,
        fileSize: typeof record.fileSize === 'number' ? record.fileSize : null,
        hash: typeof record.hash === 'string' ? record.hash : null,
        ...(typeof record.note === 'string' ? { note: isAdmin ? record.note : '' } : {}),
        available: Boolean(asset),
      };
    };
  const referenceImages = (isAdmin ? snapshotReferences : snapshotTransientReferences).map(mapReference).filter((item): item is NonNullable<typeof item> => item !== null);
  const fixedReferenceImages = (isAdmin ? snapshotFixedReferences : []).map(mapReference).filter((item): item is NonNullable<typeof item> => item !== null);
  const templateReferenceImages = (isAdmin ? snapshotTemplateReferences : []).map(mapReference).filter((item): item is NonNullable<typeof item> => item !== null);
  const transientReferenceImages = snapshotTransientReferences.map(mapReference).filter((item): item is NonNullable<typeof item> => item !== null);
  const primaryReferenceImages = snapshotPrimaryReferences.map(mapReference).filter((item): item is NonNullable<typeof item> => item !== null);
  const auxiliaryReferenceImages = (isAdmin ? snapshotAuxiliaryReferences : snapshotTransientAuxiliaryReferences).map(mapReference).filter((item): item is NonNullable<typeof item> => item !== null);
  const sourceAvailable = typeof task.snapshot_json === 'string' && task.snapshot_json.length > 0
    && ((typeof parsed.globalContext === 'string' && typeof parsed.moduleContext === 'string'
      && Boolean(String(parsed.globalContext).trim() || String(parsed.moduleContext).trim())) || snapshotReferences.length > 0 || Array.isArray(parsed.skills) && parsed.skills.length > 0 || Boolean(typeof parsed.prompt === 'string' ? parsed.prompt.trim() : task.prompt.trim()));
  const count = Number.isInteger(parsed.count) && Number(parsed.count) >= 1 && Number(parsed.count) <= 8 ? Number(parsed.count) : 1;
  const unitCredits = typeof parsed.unitCredits === 'number' && Number.isFinite(parsed.unitCredits) ? parsed.unitCredits : null;
  const imageChannel = safeImageChannelSnapshot(parsed.imageChannel);
  const imageChannelLabel = typeof parsed.imageChannelLabel === 'string' && parsed.imageChannelLabel.length <= 120 ? parsed.imageChannelLabel : null;
  const imageSupplierName = typeof parsed.imageSupplierName === 'string' && parsed.imageSupplierName.length <= 120 ? parsed.imageSupplierName : null;
  let sharedLive: SharedStudioIntent | undefined;
  try { sharedLive = parseSharedStudioIntent(parsed.sharedLive); } catch {}
  let restoredSettings;
  try { restoredSettings = parseRestoredStudioSettings(parsed.restoredSettings); } catch {}
  let taskSettings;
  try { taskSettings = parseStudioTaskSettings(parsed.taskSettings); } catch {}
  const personalPromptProjection = studioPersonalPromptProjection(parsed);
  return {
    ...(sharedLive ? { sharedLive } : {}),
    ...(taskSettings ? { taskSettings } : {}),
    ...personalPromptProjection,
    ...(restoredSettings ? { restoredSettings } : {}),
    ...(isAdmin && sharedLive ? { templatePrompt: publicText(parsed.templatePrompt, protectedModule) } : {}),
    ...(imageChannel ? { imageChannel } : {}),
    ...(imageChannel && imageChannelLabel ? { imageChannelLabel } : {}),
    ...(imageChannel && imageSupplierName ? { imageSupplierName } : {}),
    prompt: personalPromptProjection.personalPrompt ?? (hasSharedStudioPrompt(parsed) ? '' : publicText(typeof parsed.prompt === 'string' ? parsed.prompt : task.prompt, protectedModule)),
    skills: Array.isArray(parsed.skills) ? parsed.skills.flatMap((skill, index) => skill && typeof skill === 'object'
      && (isAdmin || skill.ownerId === viewerOwnerId) && typeof skill.prompt === 'string'
      ? [publicSkillSnapshot(skill, task.id, index)] : []) : [],
    evolution: parsed.evolution && typeof parsed.evolution === 'object' && ['increase', 'decrease'].includes(String((parsed.evolution as Record<string, unknown>).direction))
      ? { direction: (parsed.evolution as Record<string, unknown>).direction, manual: (parsed.evolution as Record<string, unknown>).manual === true } : null,
    model: typeof parsed.model === 'string' ? parsed.model : task.model,
    quality: typeof parsed.quality === 'string' ? parsed.quality : task.quality,
    count,
    aspectRatio: typeof parsed.aspectRatio === 'string' ? parsed.aspectRatio : task.aspect_ratio,
    resolvedAspectRatio: typeof parsed.resolvedAspectRatio === 'string' ? parsed.resolvedAspectRatio : task.aspect_ratio,
    aspectRatioSource: typeof parsed.aspectRatioSource === 'string' ? parsed.aspectRatioSource : 'model-default',
    resolution: typeof parsed.resolution === 'string' ? parsed.resolution : null,
    outputSize: typeof parsed.outputSize === 'string' ? parsed.outputSize : task.output_size,
    globalContext: isAdmin ? publicText(parsed.globalContext, protectedGlobal) : '',
    moduleContext: isAdmin ? publicText(parsed.moduleContext, protectedModule) : '',
    unitCredits,
    sourceAvailable,
    contextAvailable: typeof parsed.globalContext === 'string' && typeof parsed.moduleContext === 'string',
    contextConfigured: Boolean((typeof parsed.globalContext === 'string' && parsed.globalContext.trim()) || (typeof parsed.moduleContext === 'string' && parsed.moduleContext.trim())),
    referenceImages,
    fixedReferenceImages,
    templateReferenceImages,
    templateReferenceCount: Array.isArray(parsed.templateReferenceImages) ? parsed.templateReferenceImages.length : snapshotTemplateReferences.length,
    primaryReferenceImages,
    auxiliaryReferenceImages,
    referencePolicy,
    fixedReferenceCount: snapshotFixedReferences.length,
    templateFixedCount: typeof parsed.templateFixedCount === 'number' ? parsed.templateFixedCount : snapshotFixedReferences.length,
    styleGroupIds: Array.isArray(parsed.styleGroupIds) ? parsed.styleGroupIds.filter(id => typeof id === 'string') : [],
    styleGroups: Array.isArray(parsed.styleGroups) ? parsed.styleGroups.flatMap(value => {
      if (!value || typeof value !== 'object' || typeof value.id !== 'string' || typeof value.name !== 'string') return [];
      const canViewNote = isAdmin || (typeof viewerOwnerId === 'string' && value.ownerId === viewerOwnerId);
      return [{ id: value.id, name: value.name, referenceCount: typeof value.referenceCount === 'number' ? value.referenceCount : 0,
        ...(Number.isSafeInteger(value.revision) && value.revision >= 0 ? { revision: value.revision as number } : {}),
        ...(canViewNote && typeof value.note === 'string' ? { note: value.note } : {}),
        coverUrl: `/api/image-studio/style-groups/${value.id}/cover`, canManage: false as const }];
    }) : [],
    transientReferenceImages,
  };
}

export async function deleteStudioResult(ownerId: string, id: unknown) {
  if (typeof id !== 'string' || id.length > 100 || !id) throw new StudioError('图片编号无效');
  const task = await prisma.imageStudioTask.findFirst({ where: { id, owner_id: ownerId } });
  if (!task) throw new StudioError('图片不存在或无权删除', 404);
  if (task.deleted_at) throw new StudioError('这条记录已经删除', 409);
  // Hide the result or failed record, not the shared asset or immutable billing/task history.
  await prisma.imageStudioTask.updateMany({ where: { id, owner_id: ownerId, deleted_at: null }, data: { deleted_at: new Date() } });
}
