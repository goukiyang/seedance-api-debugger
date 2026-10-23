import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { assertUsageProject, parseUsageProjectId, recordUsageAttribution } from '@/lib/admin/usage-attribution';
import { allocateTaskCredits } from '@/lib/credits/policy';
import { canUseCompanyTemplates, canViewStudioPreset } from './access';
import { getImageStudioSettings, IMAGE_STUDIO_SETTING_KEY, DEFAULT_STUDIO_PRICES } from './settings';
import { resolveStudioModuleGenerationConfig } from './modules';
import { submitStudioBatch, parseStudioRequest, parseSharedStudioIntent, sameSharedStudioIntent, resolveOwnedStudioTaskSharedUse,
  assertSharedStudioWorkerReady, studioSharedGenerationSource, publicImageTaskStatus, cancelQueuedChannelTask, SharedStudioDefinitionError, StudioError } from './tasks';
import { STUDIO_BATCH_LIMITS, studioBatchBudgetPrecision, type StudioBatchView } from './batch-contract';
import { studioOutputMismatch as studioDimensionMismatch, studioDimensionMismatchNotice, studioOutputIssue, studioTaskHasViewableOutput } from './dimension-mismatch';
import { frozenStudioInputMainIds, getStudioTaskInputMain, readFrozenStudioInputMain, studioInputMainPreview,
  type StudioInputMainResponse } from './input-main';
import { studioAssetUrl } from './media';
import { studioDeliveryStatus } from './delivery';
import { studioVisibleAssetWhere } from './protected-assets';
import { resolveStudioStyleReferences } from './style-groups';
import { historicalSkills, resolveSkills } from './skills';
import { assertRestoredStudioStyleVersions } from './restored-settings';
import type { StudioReferencePolicy } from './reference-policy';
import { imageBillingView, parseImageBillingContract } from './billing-contract';
import type { ImageBillingContract } from './billing-contract';
import { consumeBatchQuote, quoteStudioBatch } from './batch-billing-quote';
import { imageBillingReady } from './billing-readiness';
import { imageBillingScope } from './billing-scope';
import { resolveImageGenerationRequestChannel } from '@/lib/integrations/image-generation-defaults';
import { resolveImageGenerationRequestRoute } from '@/lib/integrations/image-generation-defaults';
import { IMAGE_25_QUALITY_MODEL } from './quality-routing';
import { captureImageGenerationChannel, getImageGenerationSettingsForModel, isMuskImageGenerationChannel, assertImageGenerationChannelDispatchOpen, ImageGenerationChannelError,
  resolveImageGenerationChannelSnapshot, validateImageGenerationChannel, type ImageGenerationChannelSnapshot, type ImageGenerationResolvedSettings } from '@/lib/integrations/image-generation';
import { QueueCapacityError, QueueMaintenanceError, reserveImageStudioQueueCapacity } from './queue-capacity';
import { PRICING_BATCH_PREFIX, PRICING_BATCH_ITEM_PREFIX, publicPricingTaskState, studioTaskState, studioTaskStates } from './pricing-state';
import { assertPricingImageConsumerReady } from '@/lib/pricing/runtime';
import { samePricingImageCharge, withImagePricing } from '@/lib/pricing/image';
import { normalizeImageResolution } from '@/lib/image-generation/resolution';
import { addCredits, creditCents, sumCredits } from '@/lib/credits/precision';
import { CURRENT_STUDIO_SIZE_POLICY_VERSION, type StudioSizePolicyVersion } from './ratios';

const PREFIX = 'studio_batch_v1:';
const ITEM_PREFIX = 'studio_batch_item_v1:';
const CHANNEL_PREFIX = 'studio_channel_batch_v1:';
const CHANNEL_ITEM_PREFIX = 'studio_channel_batch_item_v1:';
type BatchItem = { ordinal: number; sourceName: string; assetId?: string; taskId: string | null; attempt: number; prepared: boolean; cancelled: boolean };
type BatchRecord = { version: 1 | 2; sizePolicyVersion?: StudioSizePolicyVersion; usageContext?: { version: 1; projectId: string | null }; pricing?: true; id: string; ownerId: string; requestId: string; fingerprint: string; requestFingerprint?: string; moduleId: string; moduleName: string; state: string; note: string; createdAt: string; total: number; budget: number; committedCredits: number; unitCredits: number; prepared: number; input: Record<string, unknown>; items: BatchItem[]; billingMode?: 'actual' | 'fixed'; billingContracts?: Array<ImageBillingContract | null>; definitionConfirmationRequired?: boolean };
const key = (owner: string, id: string, channel = false, pricing = false) => `${pricing ? PRICING_BATCH_PREFIX : channel ? CHANNEL_PREFIX : PREFIX}${owner}:${id}`;
const batchKeys = (owner: string, id: string) => [key(owner, id), key(owner, id, true), key(owner, id, false, true)];
const itemKey = (batch: BatchRecord, ordinal: number) => `${batch.pricing ? PRICING_BATCH_ITEM_PREFIX : batch.input.imageChannel && (batch.input.imageChannel as ImageGenerationChannelSnapshot).channelId !== 'original' ? CHANNEL_ITEM_PREFIX : ITEM_PREFIX}${batch.id}:${ordinal}`;
const childId = (batch: BatchRecord, item: BatchItem) => `${batch.pricing ? 'rate-' : ''}${batch.id}-${item.ordinal}-a${item.attempt}`;
const isChannelBatch = (batch: Pick<BatchRecord, 'input'>) => {
  const snapshot = batch.input.imageChannel as ImageGenerationChannelSnapshot | undefined;
  return Boolean(snapshot?.channelId && snapshot.channelId !== 'original');
};
const idFor = (owner: string, requestId: string) => createHash('sha256').update(`${owner}:${requestId}`).digest('hex');
const parse = (json: string): BatchRecord => {
  const value = JSON.parse(json) as BatchRecord;
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 && value.version !== 2
    || value.sizePolicyVersion !== undefined && value.sizePolicyVersion !== 1 && value.sizePolicyVersion !== 2) {
    throw new StudioError('批次记录或图片尺寸策略版本无效，请核对原批次', 409);
  }
  // Do not materialize v1: a read or unrelated write must not migrate old parents.
  return value;
};
const continuationBinding = (id: string, json: string) => ({ batchId: id,
  recordDigest: createHash('sha256').update(json).digest('hex') });
const boundedBudget = (value: unknown) => {
  try { return typeof value === 'number' && value >= 0 && value <= 10_000_000 && Number.isSafeInteger(creditCents(value)); }
  catch { return false; }
};
function assertBudgetVersion(value: unknown, contracts?: Array<ImageBillingContract | null>, committedCredits = 0) {
  const pricing = contracts?.find(contract => contract?.pricing)?.pricing;
  const precision = pricing && !['legacy_fixed', 'legacy_actual'].includes(pricing.mode) ? 0.1 : 0.01;
  const step = studioBatchBudgetPrecision(pricing?.revision, precision, committedCredits);
  if (!boundedBudget(value) || creditCents(Number(value)) % Math.round(step * 100) !== 0) {
    throw new StudioError(step === 1 ? '旧合同批次预算请填写整数点数' : step === 0.1 ? '本次新合同预算最多保留 1 位小数' : '含旧合同的本批预算最多保留 2 位小数', 409);
  }
}
// Recheck only an unaccepted quote; accepted parents and later children keep their frozen contract.
async function assertUnacceptedBatchPricing(tx: Prisma.TransactionClient, api: ImageGenerationResolvedSettings,
  model: string, contracts: ImageBillingContract[], expectedRevision: unknown, specifications: { quality?: string; resolution?: string; ratio?: string }) {
  const fresh = await withImagePricing(api, model, tx, undefined, specifications);
  for (const contract of contracts) {
    if (!samePricingImageCharge(fresh.quote?.charge, contract.pricing)
      || contract.pricing && expectedRevision !== contract.pricing.revision) {
      throw new StudioError('收费合同已变化，请重新获取整批报价；尚未受理新批次', 409);
    }
  }
}
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);

async function readOwned(owner: string, id: unknown, tx: Pick<Prisma.TransactionClient, 'platformSetting'> = prisma) {
  if (!validId(id)) throw new StudioError('批次编号无效');
  const row = await tx.platformSetting.findFirst({ where: { key: { in: batchKeys(owner, id) } } });
  if (!row) throw new StudioError('批次不存在或无权访问', 404);
  const batch = parse(row.value_json);
  if (batch.ownerId !== owner || batch.id !== id) throw new StudioError('批次不存在或无权访问', 404);
  return { row, batch };
}

export async function getStudioBatchItemInputMain(user: Parameters<typeof getStudioTaskInputMain>[0], id: string,
  ordinal: number): Promise<StudioInputMainResponse> {
  const { batch } = await readOwned(user.id, id);
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > batch.items.length) throw new StudioError('批次条目无效');
  const item = batch.items[ordinal - 1];
  if (!item || item.ordinal !== ordinal || !Number.isSafeInteger(item.attempt) || item.attempt < 0) {
    throw new StudioError('批次条目身份无法确认', 409);
  }
  if (item.taskId) return getStudioTaskInputMain(user, item.taskId);
  const row = await prisma.platformSetting.findUnique({ where: { key: itemKey(batch, ordinal) }, select: { value_json: true } });
  if (!row) return {
    source: { kind: 'batch-item', batchId: batch.id, ordinal, attempt: item.attempt }, state: item.prepared ? 'unknown' : 'unavailable',
    images: [], snapshotToken: createHash('sha256').update(JSON.stringify(['studio-batch-input-missing-v1', batch.id, ordinal, item.attempt])).digest('hex'),
  };
  let frozen: Prisma.ImageStudioTaskUncheckedCreateInput;
  try { frozen = JSON.parse(row.value_json) as Prisma.ImageStudioTaskUncheckedCreateInput; }
  catch { throw new StudioError('批次输入记录无法确认', 409); }
  if (frozen.owner_id !== user.id || frozen.batch_id !== batch.id || frozen.ordinal !== ordinal
    || frozen.id !== childId(batch, item) || typeof frozen.snapshot_json !== 'string' || typeof frozen.reference_ids !== 'string') {
    throw new StudioError('批次输入记录与原条目不匹配', 409);
  }
  return readFrozenStudioInputMain(user, { kind: 'batch-item', batchId: batch.id, ordinal, attempt: item.attempt }, {
    ownerId: String(frozen.owner_id), snapshotJson: frozen.snapshot_json, referenceIdsJson: frozen.reference_ids,
  });
}
async function writeBatch(tx: Pick<Prisma.TransactionClient, 'platformSetting'>, row: { id: string; value_json: string }, batch: BatchRecord) {
  const changed = await tx.platformSetting.updateMany({ where: { id: row.id, value_json: row.value_json }, data: { value_json: JSON.stringify(batch) } });
  if (!changed.count) throw new StudioError('批次已在其他页面更新，请重新读取', 409);
}

function sharedDefinitionError(error: unknown) {
  return error instanceof Error && [400, 403, 404, 409].includes(Number((error as Error & { status?: number }).status));
}

async function invalidateUnacceptedDefinition(tx: Prisma.TransactionClient, batch: BatchRecord, message: string) {
  const pending = batch.items.filter(item => !item.taskId && !item.cancelled);
  for (const item of pending) item.prepared = false;
  if (pending.length) await tx.platformSetting.deleteMany({ where: { key: { in: pending.flatMap(item =>
    [`${ITEM_PREFIX}${batch.id}:${item.ordinal}`, `${CHANNEL_ITEM_PREFIX}${batch.id}:${item.ordinal}`, `${PRICING_BATCH_ITEM_PREFIX}${batch.id}:${item.ordinal}`]) } } });
  batch.prepared = batch.items.filter(item => item.prepared).length;
  batch.definitionConfirmationRequired = true;
  // Only the inputs being invalidated lose their quote. Accepted/unknown task
  // slots retain the parent's original frozen contract as well as the task's.
  if (batch.billingContracts) for (const item of pending) batch.billingContracts[item.ordinal - 1] = null;
  batch.state = 'needs-confirmation';
  batch.note = message;
}

async function recoverAcceptedBatchItems(tx: Prisma.TransactionClient, batch: BatchRecord) {
  for (const item of batch.items.filter(item => !item.taskId && !item.cancelled)) {
    const taskId = childId(batch, item);
    const task = await tx.imageStudioTask.findFirst({ where: { id: taskId, owner_id: batch.ownerId, batch_id: batch.id } });
    if (task) { item.taskId = task.id; item.prepared = true; continue; }
    const ledger = await tx.creditLedger.findFirst({ where: { idempotency_key: `image-studio:freeze:${taskId}` }, select: { id: true } });
    if (ledger) throw new StudioError('条目已有费用受理记录但任务结果未确认，请核对原记录；不会重新生成', 409);
  }
  batch.prepared = batch.items.filter(item => item.prepared).length;
}

export function continuationInput(batch: BatchRecord, body: Record<string, unknown>): Record<string, unknown> {
  if (body.projectId !== undefined && parseUsageProjectId(body.projectId) !== (batch.usageContext?.projectId ?? null)) {
    throw new StudioError('本批项目归属已固定，不能用当前界面改写；请沿原批次继续或主动新建批次', 409);
  }
  const pending = batch.items.filter(item => !item.taskId && !item.cancelled);
  if (!pending.length) throw new StudioError('本批没有未受理条目，请查看原任务', 409);
  const changes = Object.fromEntries(['prompt', 'personalPrompt', 'personalOverrides', 'model', 'quality', 'resolution', 'count', 'aspectRatio',
    'revision', 'moduleRevision', 'sharedLive', 'restoredSettings', 'draft', 'referenceIds', 'imageChannel', 'channelId', 'batchQuoteId', 'pricingRevision', 'budget']
    .filter(field => Object.prototype.hasOwnProperty.call(body, field)).map(field => [field, body[field]]));
  const previous = { ...batch.input };
  delete previous.imageChannel;
  delete previous.channelId;
  delete previous.maxEstimatedCost;
  if (!sameSharedStudioIntent(parseSharedStudioIntent(batch.input.sharedLive), parseSharedStudioIntent(body.sharedLive))) {
    for (const field of ['model', 'quality', 'resolution', 'aspectRatio']) delete previous[field];
  }
  return { ...previous, ...changes, count: 1, moduleId: batch.moduleId, requestId: batch.requestId,
    sources: pending.map(item => ({ name: item.sourceName, ...(item.assetId ? { assetId: item.assetId } : {}) })),
    budget: body.budget ?? batch.budget };
}

async function reconfirmBatchDefinition(tx: Prisma.TransactionClient, batch: BatchRecord, body: Record<string, unknown>, row: { id: string; value_json: string }) {
  if (!boundedBudget(body.budget)) throw new StudioError('请确认未受理条目的当前报价及整批最高预算', 409);
  const nextBody = continuationInput(batch, body);
  const input = parseStudioRequest(nextBody);
  const sharedUse = await resolveOwnedStudioTaskSharedUse(batch.ownerId, batch.moduleId, input.sharedLive, tx, input);
  if (!sharedUse) throw new SharedStudioDefinitionError('共享模板绑定不可用，请重新打开模板');
  await assertSharedStudioWorkerReady(tx);
  const settings = await getImageStudioSettings();
  const generationSource = studioSharedGenerationSource(sharedUse, input);
  const generation = resolveStudioModuleGenerationConfig(generationSource, settings);
  const quote = nextBody.batchQuoteId ? await consumeBatchQuote(tx, batch.ownerId, nextBody, continuationBinding(batch.id, row.value_json)) : null;
  const explicitChannelId = typeof nextBody.channelId === 'string' ? nextBody.channelId : undefined;
  const suppliedChannel = quote?.imageChannel || input.imageChannel;
  const qualityRoute = generation.model === IMAGE_25_QUALITY_MODEL ? await resolveImageGenerationRequestRoute(generation.model, generation.quality, explicitChannelId, tx) : undefined;
  const effectiveChannelId = qualityRoute?.channelId || (explicitChannelId === undefined && suppliedChannel
    ? suppliedChannel.channelId : await resolveImageGenerationRequestChannel(generation.model, explicitChannelId, tx) || 'original');
  if (suppliedChannel && suppliedChannel.channelId !== effectiveChannelId) throw new StudioError('型号默认供应商已变化，请重新报价', 409);
  const imageChannel = suppliedChannel || (effectiveChannelId === 'original' ? undefined
    : await captureImageGenerationChannel(generation.model, effectiveChannelId, tx, qualityRoute?.qualityRoute));
  if (qualityRoute && JSON.stringify(imageChannel?.qualityRoute) !== JSON.stringify(qualityRoute.qualityRoute)) throw new StudioError('图片质量路由已变化，请重新报价', 409);
  const rawApi = imageChannel ? await resolveImageGenerationChannelSnapshot(imageChannel, tx, true, generation.model)
    : await getImageGenerationSettingsForModel(generation.model, tx);
  const specifications = { quality: generation.quality,
    resolution: normalizeImageResolution(generation.model, generation.resolution, rawApi.provider), ratio: generationSource.aspectRatio };
  if (quote) await assertUnacceptedBatchPricing(tx, rawApi, generation.model, quote.contracts, nextBody.pricingRevision, specifications);
  const priced = await withImagePricing(rawApi, generation.model, tx, quote?.contracts[0], specifications);
  if (priced.quote && !quote) throw new StudioError('请先确认未受理条目的当前整批报价', 409);
  const api = priced.settings;
  const capability = imageChannel && imageChannel.channelId !== 'original'
    ? api.modelCapabilities[generation.model as keyof typeof api.modelCapabilities] : undefined;
  if (capability) {
    const validation = validateImageGenerationChannel(api, { model: generation.model, quality: generation.quality,
      resolution: generation.resolution, ratio: generationSource.aspectRatio,
      referenceCount: input.referenceIds.length });
    if (!validation.ok) throw new StudioError(validation.error, 409);
    if (capability.billingMode === 'actual' && (!quote || !isMuskImageGenerationChannel(api)
      || new URL(api.base_url).origin !== 'https://api.muskapis.com')) throw new StudioError('请先确认当前通道的整批实扣报价', 409);
    if (!capability.billingMode) throw new StudioError('当前图片通道没有明确计费能力', 409);
  } else if (!quote && (await imageBillingReady(imageBillingScope(api), generation.model, tx)).ready) {
    throw new StudioError('请先确认当前型号的整批实扣报价', 409);
  }
  const unitCredits = quote?.unitCredits ?? (capability?.billingMode === 'fixed' ? capability.fixedPoints : generation.prices[generation.model]);
  const pending = batch.items.filter(item => !item.taskId && !item.cancelled);
  if (batch.billingMode === 'actual') batch.committedCredits = await batchBillingCommitted(tx, batch);
  assertBudgetVersion(body.budget, quote?.contracts, batch.committedCredits);
  if (unitCredits == null || addCredits(batch.committedCredits, quote?.total ?? sumCredits(pending.map(() => unitCredits!))) > Number(body.budget)) {
    throw new StudioError('新预算不足以覆盖已受理点数与未受理条目的当前报价', 409);
  }
  await invalidateUnacceptedDefinition(tx, batch, '');
  batch.sizePolicyVersion = CURRENT_STUDIO_SIZE_POLICY_VERSION;
  batch.input = { ...input, moduleId: batch.moduleId, sharedLive: sharedUse.definition.intent, ...(imageChannel ? { imageChannel } : {}) };
  batch.moduleName = sharedUse.definition.name;
  batch.budget = Number(body.budget); batch.unitCredits = unitCredits;
  batch.billingMode = quote?.mode;
  if (quote?.contracts.some(contract => contract.pricing)) { batch.pricing = true; batch.version = 2; }
  if (quote) {
    batch.billingContracts ??= batch.items.map(() => null);
    pending.forEach((item, index) => { batch.billingContracts![item.ordinal - 1] = quote.contracts[index]; });
  }
  batch.state = 'preparing'; batch.note = '已确认当前模板与预算，正在重新准备未受理条目；原任务保持不变';
  const newKey = key(batch.ownerId, batch.id, isChannelBatch(batch), batch.pricing);
  if ((await tx.platformSetting.updateMany({ where: { id: row.id, value_json: row.value_json }, data: { key: newKey } })).count !== 1) {
    throw new StudioError('批次已在其他页面更新，请重新读取', 409);
  }
}

export async function quoteStudioBatchContinuation(owner: string, body: Record<string, unknown>) {
  const prepared = await prisma.$transaction(async tx => {
    const { row, batch } = await readOwned(owner, body.id, tx);
    if (batch.state === 'cancelled' || batch.state === 'preparing') throw new StudioError('本批不能重新报价，请先读取原批次', 409);
    await recoverAcceptedBatchItems(tx, batch);
    return { input: continuationInput(batch, body), continuation: continuationBinding(batch.id, row.value_json) };
  });
  return quoteStudioBatch(owner, prepared.input, prepared.continuation);
}

export async function createStudioBatch(ownerId: string, body: Record<string, unknown>) {
  if (typeof body?.requestId === 'string' && /^[a-zA-Z0-9-]{16,80}$/.test(body.requestId)) {
    const acceptedId = idFor(ownerId, body.requestId);
    const saved = await prisma.platformSetting.findFirst({ where: { key: { in: batchKeys(ownerId, acceptedId) } } });
    if (saved && (parse(saved.value_json).input.sharedLive !== undefined || body.sharedLive !== undefined
      || parse(saved.value_json).input.restoredSettings !== undefined || body.restoredSettings !== undefined)) {
      if (body.moduleId !== undefined && body.moduleId !== parse(saved.value_json).moduleId) throw new StudioError('提交编号已用于其他批次，请查询原批次', 409);
      return acceptedId;
    }
  }
  const input = parseStudioRequest({ ...body, count: 1 });
  if (typeof body.moduleId !== 'string' || !boundedBudget(body.budget)) throw new StudioError('请选择模板并填写最高预算');
  const sources = body.sources;
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > STUDIO_BATCH_LIMITS.images) throw new StudioError(`本批最多 ${STUDIO_BATCH_LIMITS.images} 张图片`);
  const items: BatchItem[] = sources.map((source, index) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new StudioError('素材清单无效');
    const value = source as Record<string, unknown>;
    if (typeof value.name !== 'string' || value.name.length > 160 || (value.assetId !== undefined && (typeof value.assetId !== 'string' || value.assetId.length > 100))) throw new StudioError('素材清单无效');
    return { ordinal: index + 1, sourceName: value.name.replace(/[\\/\x00-\x1f]/g, '_'), ...(value.assetId ? { assetId: value.assetId as string } : {}), taskId: null, attempt: 0, prepared: false, cancelled: false };
  });
  const id = idFor(ownerId, input.requestId);
  const shared: Record<string, unknown> = { ...input, moduleId: body.moduleId };
  const requestFingerprint = createHash('sha256').update(JSON.stringify({ shared, items, budget: body.budget })).digest('hex');
  let created = false;
  await prisma.$transaction(async tx => {
    const existing = await tx.platformSetting.findFirst({ where: { key: { in: batchKeys(ownerId, id) } } });
    if (existing) {
      const saved = parse(existing.value_json);
      const savedSnapshot = saved.input.imageChannel as ImageGenerationChannelSnapshot | undefined;
      const suppliedSnapshot = input.imageChannel;
      if (saved.input.sharedLive !== undefined || input.sharedLive || saved.input.restoredSettings !== undefined || input.restoredSettings) return;
      const sameIntent = saved.requestFingerprint === requestFingerprint || saved.fingerprint === requestFingerprint;
      if (!sameIntent || suppliedSnapshot && (savedSnapshot?.channelId !== suppliedSnapshot.channelId
        || savedSnapshot.configRevision !== suppliedSnapshot.configRevision)) throw new StudioError('提交编号已用于其他批次', 409);
      return;
    }
    const active = await tx.platformSetting.count({ where: { OR: [
      { key: { startsWith: `${PREFIX}${ownerId}:` } }, { key: { startsWith: `${CHANNEL_PREFIX}${ownerId}:` } },
      { key: { startsWith: `${PRICING_BATCH_PREFIX}${ownerId}:` } },
    ], AND: [{ OR: ['preparing', 'ready', 'paused', 'blocked', 'needs-confirmation'].map(state => ({ value_json: { contains: `"state":"${state}"` } })) }] } });
    if (active >= STUDIO_BATCH_LIMITS.activeBatches) throw new StudioError('最多保留 5 个未结束批次，请先处理原批次', 429);
    const usageUser = await tx.user.findUnique({ where: { id: ownerId }, select: { id: true, role: true, status: true } });
    if (!usageUser || usageUser.status !== 'active') throw new StudioError('当前账号不可用', 403);
    await assertUsageProject(tx, usageUser, input.projectId ?? null);
    const workspace = await tx.imageStudioModule.findFirst({ where: { id: body.moduleId as string, owner_id: ownerId },
      select: { name: true, model: true, quality: true, resolution: true, prices_json: true } });
    if (!workspace) throw new StudioError('模板不存在或无权使用', 404);
    const settings = await getImageStudioSettings();
    const sharedUse = await resolveOwnedStudioTaskSharedUse(ownerId, body.moduleId as string, input.sharedLive, tx, input);
    if (sharedUse) { await assertSharedStudioWorkerReady(tx); shared.sharedLive = sharedUse.definition.intent; }
    const sharedGeneration = sharedUse ? studioSharedGenerationSource(sharedUse, input) : null;
    const generationSource = sharedGeneration || { ...workspace, ...(input.model ? { model: input.model } : {}),
      ...(input.quality !== undefined ? { quality: input.quality } : {}) };
    const billingQuote = body.batchQuoteId ? await consumeBatchQuote(tx, ownerId, body) : null;
    const generation = resolveStudioModuleGenerationConfig(generationSource, settings);
    const model = generation.model;
    const explicitChannelId = typeof body.channelId === 'string' ? body.channelId : undefined;
    const qualityRoute = model === IMAGE_25_QUALITY_MODEL ? await resolveImageGenerationRequestRoute(model, generation.quality, explicitChannelId, tx) : undefined;
    const effectiveChannelId = qualityRoute?.channelId || (explicitChannelId === undefined && (billingQuote?.imageChannel || input.imageChannel)
      ? (billingQuote?.imageChannel || input.imageChannel)!.channelId
      : (await resolveImageGenerationRequestChannel(model, explicitChannelId, tx) || 'original'));
    if (explicitChannelId === 'original' && input.imageChannel
      && effectiveChannelId !== input.imageChannel.channelId) {
      throw new StudioError('当前型号默认图片通道已变化，请重新报价', 409);
    }
    const imageChannel = billingQuote?.imageChannel || input.imageChannel || (effectiveChannelId === 'original' ? undefined
      : await captureImageGenerationChannel(model, effectiveChannelId, tx, qualityRoute?.qualityRoute));
    if (qualityRoute && JSON.stringify(imageChannel?.qualityRoute) !== JSON.stringify(qualityRoute.qualityRoute)) throw new StudioError('图片质量路由已变化，请重新报价', 409);
    if (imageChannel && imageChannel.channelId !== effectiveChannelId) throw new StudioError('本批报价与图片通道不匹配', 409);
    const currentApi = imageChannel ? await resolveImageGenerationChannelSnapshot(imageChannel, tx, true, model)
      : await getImageGenerationSettingsForModel(model, tx);
    const specifications = { quality: generation.quality,
      resolution: normalizeImageResolution(model, sharedGeneration?.resolution || input.resolution || generation.resolution, currentApi.provider),
      ratio: sharedGeneration?.aspectRatio || input.aspectRatio || 'auto' };
    if (billingQuote) await assertUnacceptedBatchPricing(tx, currentApi, model, billingQuote.contracts, body.pricingRevision, specifications);
    const priced = await withImagePricing(currentApi, model, tx, billingQuote?.contracts[0], specifications);
    if (priced.quote && !billingQuote) throw new StudioError('当前收费规则需要有效整批报价；尚未创建批次', 409);
    if (!billingQuote && effectiveChannelId === 'original') {
      if ((await imageBillingReady(imageBillingScope(priced.settings), model, tx)).ready) throw new StudioError('当前模型需要确认有效整批报价，尚未创建或派发生成', 409);
    }
    let unitCredits = billingQuote?.unitCredits ?? generation.prices[model];
    if (effectiveChannelId !== 'original') {
      const api = priced.settings;
      const validation = validateImageGenerationChannel(api, { model, ...specifications, referenceCount: input.referenceIds.length });
      const capability = api.modelCapabilities[model as keyof typeof api.modelCapabilities];
      if (!validation.ok) throw new StudioError(validation.error, 409);
      if (capability?.billingMode === 'actual') {
        if (!isMuskImageGenerationChannel(api) || new URL(api.base_url).origin !== 'https://api.muskapis.com' || !billingQuote) {
          throw new StudioError('此通道没有可确认的实际计费报价，本批尚未创建或派发', 409);
        }
      } else if (capability?.billingMode === 'fixed') { if (!billingQuote) unitCredits = capability.fixedPoints; }
      else throw new StudioError('当前图片通道缺少有效的固定点数或实际计费能力', 409);
      shared.imageChannel = imageChannel;
    }
    if (billingQuote?.imageChannel && effectiveChannelId === 'original') shared.imageChannel = billingQuote.imageChannel;
    assertBudgetVersion(body.budget, billingQuote?.contracts);
    if (unitCredits == null || (billingQuote?.total ?? sumCredits(items.map(() => unitCredits!))) > Number(body.budget)) throw new StudioError('最高预算不足以覆盖本批预计点数');
    const assetIds = Array.from(new Set(items.flatMap(item => item.assetId ? [item.assetId] : [])));
    const assets = await tx.asset.findMany({ where: { id: { in: assetIds }, owner_id: ownerId, status: 'active', type: 'image' }, select: { id: true, file_size: true } });
    if (assets.length !== assetIds.length || assets.some(asset => !asset.file_size || asset.file_size > STUDIO_BATCH_LIMITS.fileBytes) || assets.reduce((sum, asset) => sum + (asset.file_size || 0), 0) > STUDIO_BATCH_LIMITS.totalBytes) throw new StudioError('素材不可用或超过本批大小上限');
    const fingerprint = isChannelBatch({ input: shared })
      ? createHash('sha256').update(JSON.stringify({ requestFingerprint, imageChannel: shared.imageChannel })).digest('hex')
      : requestFingerprint;
    const batch: BatchRecord = { version: 1, sizePolicyVersion: CURRENT_STUDIO_SIZE_POLICY_VERSION, id, ownerId, requestId: input.requestId, fingerprint, requestFingerprint, moduleId: body.moduleId as string, moduleName: sharedUse?.definition.name || workspace.name, state: 'preparing', note: '', createdAt: new Date().toISOString(), total: items.length, budget: Number(body.budget), committedCredits: 0, unitCredits, prepared: 0, input: shared, items,
      usageContext: { version: 1, projectId: input.projectId ?? null },
      ...(billingQuote ? { billingMode: billingQuote.mode, billingContracts: billingQuote.contracts } : {}) };
    if (billingQuote?.contracts.some(contract => contract.pricing)) { batch.pricing = true; batch.version = 2; }
    await tx.platformSetting.create({ data: { key: key(ownerId, id, isChannelBatch(batch), batch.pricing), value_json: JSON.stringify(batch), updated_by: ownerId } });
    created = true;
  }, { timeout: 15000 });
  if (created) await prepareBatch(ownerId, id);
  return id;
}

async function prepareBatch(owner: string, id: string) {
  const initial = (await readOwned(owner, id)).batch;
  try {
    for (const item of initial.items) {
      if (item.prepared || item.taskId || item.cancelled) continue;
      const policy = (initial.input.draft as { referencePolicy?: StudioReferencePolicy } | undefined)?.referencePolicy;
      const references = item.assetId ? [item.assetId, ...(initial.input.referenceIds as string[]).filter(ref => !policy?.primaryIds.includes(ref))] : initial.input.referenceIds;
      const draft = initial.input.draft as Record<string, unknown> | undefined;
      const itemInput = { ...initial.input, requestId: `${id.slice(0, 48)}-${item.ordinal}`, referenceIds: references,
        ...(item.assetId && draft && policy ? { draft: { ...draft, referencePolicy: { ...policy, primaryIds: [item.assetId] } } } : {}) };
      await submitStudioBatch(owner, itemInput, undefined, { batchItem: true, sizePolicyVersion: initial.sizePolicyVersion ?? 1,
        frozenContract: initial.billingContracts?.[item.ordinal - 1] || undefined, save: async (tx, task) => {
        const { row, batch } = await readOwned(owner, id, tx);
        if (batch.state !== 'preparing') throw new StudioError('批次已停止准备');
        if ((batch.sizePolicyVersion ?? 1) !== (initial.sizePolicyVersion ?? 1)
          || JSON.stringify(batch.input) !== JSON.stringify(initial.input)
          || JSON.stringify(batch.billingContracts?.[item.ordinal - 1]) !== JSON.stringify(initial.billingContracts?.[item.ordinal - 1])) {
          throw new StudioError('本批已确认新输入或报价，旧准备结果未写入', 409);
        }
        const current = batch.items[item.ordinal - 1];
        if (current.prepared) return;
        const actualContract = batch.billingContracts?.[item.ordinal - 1];
        if (batch.billingContracts && (actualContract || batch.billingMode !== undefined)) {
          const fixedContract = JSON.parse(String(task.billing_contract_json)) as ImageBillingContract;
          if (!actualContract || actualContract.specification !== fixedContract.specification || actualContract.scope !== fixedContract.scope)
            throw new StudioError('本批输入或通道与已确认报价不符，未派发生成');
          task.unit_credits = actualContract.authorizedCredits;
          task.billing_mode = actualContract.mode; task.billing_contract_json = JSON.stringify(actualContract);
          task.billing_deadline = actualContract.deadline ? new Date(actualContract.deadline) : null;
          task.snapshot_json = JSON.stringify({ ...JSON.parse(String(task.snapshot_json)), billingContract: actualContract, unitCredits: actualContract.authorizedCredits });
        } else if (task.unit_credits !== batch.unitCredits
          || addCredits(batch.committedCredits, sumCredits(batch.items.filter(item => !item.taskId && !item.cancelled).map(() => Number(task.unit_credits)))) > batch.budget) throw new StudioError('价格变化或预算不足，请重新核对后开始新批次');
        const firstPending = batch.items.find(item => item.prepared && !item.taskId && !item.cancelled);
        const first = firstPending ? await tx.platformSetting.findUnique({ where: { key: itemKey(batch, firstPending.ordinal) } }) : null;
        if (first) {
          const before = JSON.parse((JSON.parse(first.value_json) as Prisma.ImageStudioTaskUncheckedCreateInput).snapshot_json as string);
          const now = JSON.parse(task.snapshot_json as string);
          const skillInput = (snapshot: Record<string, unknown>) => Array.isArray(snapshot.skills) ? snapshot.skills.map(skill => ({ id: skill.id, prompt: skill.prompt, promptVersion: skill.promptVersion, ownerId: skill.ownerId })) : [];
          const definitionFields = ['globalContext', 'moduleContext', 'settingsRevision', 'sharedLive', 'styleGroups', 'fixedReferenceImages',
            ...(now.restoredSettings ? ['restoredSettings', 'templatePrompt', 'personalPrompt', 'templateReferenceImages'] : []),
            ...(now.sharedLive ? [] : ['moduleRevision'])];
          if (definitionFields.some(field => JSON.stringify(before[field]) !== JSON.stringify(now[field]))
            || JSON.stringify(skillInput(before)) !== JSON.stringify(skillInput(now))) throw new StudioError('准备期间模板或价格发生变化，未开始生成，请重新核对');
        }
        task.id = childId(batch, item); task.batch_id = id; task.ordinal = item.ordinal;
        task.context += `\n\n本批条目 ${item.ordinal}/${batch.total}。严格保留原正文中的明确条件；仅对正文未指定且允许随机的细节作不同选择，不照抄本批其他条目、不改变演化档数或组合图排版。`;
        task.snapshot_json = JSON.stringify({ ...JSON.parse(task.snapshot_json as string), effectiveContext: task.context, batchId: id, requestId: batch.requestId, persistentBatchId: id, batchOrdinal: item.ordinal });
        await tx.platformSetting.create({ data: { key: itemKey(batch, item.ordinal), value_json: JSON.stringify(task), updated_by: owner } });
        current.prepared = true; batch.prepared += 1;
        await writeBatch(tx, row, batch);
      } });
    }
    await prisma.$transaction(async tx => {
      const { row, batch } = await readOwned(owner, id, tx);
      if ((batch.sizePolicyVersion ?? 1) !== (initial.sizePolicyVersion ?? 1)
        || JSON.stringify(batch.input) !== JSON.stringify(initial.input)) return;
      if (batch.state === 'preparing' && batch.items.every(item => item.prepared || item.taskId || item.cancelled)) {
        await resolveOwnedStudioTaskSharedUse(owner, batch.moduleId, parseSharedStudioIntent(batch.input.sharedLive), tx,
          batch.input.restoredSettings !== undefined ? parseStudioRequest(batch.input) : undefined);
        batch.state = 'ready'; batch.note = ''; batch.definitionConfirmationRequired = false; await writeBatch(tx, row, batch);
      }
    });
  } catch (error) {
    await prisma.$transaction(async tx => {
      const { row, batch } = await readOwned(owner, id, tx);
      if ((batch.sizePolicyVersion ?? 1) !== (initial.sizePolicyVersion ?? 1)
        || JSON.stringify(batch.input) !== JSON.stringify(initial.input)) return;
      if (batch.state === 'preparing') {
        if (error instanceof SharedStudioDefinitionError || batch.input.sharedLive && sharedDefinitionError(error)) {
          await invalidateUnacceptedDefinition(tx, batch, error instanceof Error ? error.message : '模板已更新，请确认本次生成');
        } else { batch.state = 'blocked'; batch.note = error instanceof StudioError ? error.message : '素材准备中断，未派发生成；请取消后重新核对'; }
        await writeBatch(tx, row, batch);
      }
    });
  }
}

export async function studioBatchView(owner: string, id: string, includeItems = true): Promise<StudioBatchView> {
  const { batch } = await readOwned(owner, id);
  if (batch.billingMode === 'actual') batch.committedCredits = await batchBillingCommitted(prisma, batch);
  const identity = await prisma.user.findUniqueOrThrow({ where: { id: owner }, select: { id: true, role: true, account_type: true, feature_profile_id: true, feishu_user_id: true, feishu_open_id: true, feishu_union_id: true, feishu_tenant_key: true } });
  const taskIds = batch.items.flatMap(item => item.taskId ? [item.taskId] : []);
  const tasks = await prisma.imageStudioTask.findMany({ where: { id: { in: taskIds }, owner_id: owner }, select: { id: true, status: true, error: true, usage_json: true, asset_id: true, deleted_at: true,
    owner_id: true, snapshot_json: includeItems, reference_ids: true, billing_status: true, actual_amount_micros: true, actual_credits: true, billing_contract_json: true, unit_credits: true, billing_settled_at: true } });
  const preparedRows = includeItems ? await prisma.platformSetting.findMany({ where: { key: { in: batch.items
    .filter(item => !item.taskId && item.prepared).map(item => itemKey(batch, item.ordinal)) } }, select: { key: true, value_json: true } }) : [];
  const frozenByOrdinal = new Map<number, Prisma.ImageStudioTaskUncheckedCreateInput>();
  for (const row of preparedRows) {
    try {
      const frozen = JSON.parse(row.value_json) as Prisma.ImageStudioTaskUncheckedCreateInput;
      const ordinal = Number(frozen.ordinal);
      const item = batch.items[ordinal - 1];
      if (item && row.key === itemKey(batch, ordinal) && frozen.owner_id === owner && frozen.batch_id === batch.id
        && frozen.id === childId(batch, item) && typeof frozen.snapshot_json === 'string' && typeof frozen.reference_ids === 'string') {
        frozenByOrdinal.set(ordinal, frozen);
      }
    } catch { /* Corrupt frozen input remains unknown and is never guessed from the current batch draft. */ }
  }
  const inputIds = Array.from(new Set([
    ...tasks.flatMap(task => frozenStudioInputMainIds(task.snapshot_json, task.reference_ids) || []),
    ...Array.from(frozenByOrdinal.values()).flatMap(frozen => frozenStudioInputMainIds(String(frozen.snapshot_json), String(frozen.reference_ids)) || []),
  ]));
  const inputAssets = includeItems && inputIds.length ? await prisma.asset.findMany({ where: { id: { in: inputIds }, owner_id: owner,
    status: 'active', type: 'image', AND: [await studioVisibleAssetWhere(identity)] }, select: { id: true } }) : [];
  const readableInputIds = new Set(inputAssets.map(asset => asset.id));
  // 仅当前活跃项读取回执；批次目录不取快照，已完成历史不读逐图文件。
  const deliveryByTask = new Map(includeItems ? await Promise.all(tasks.filter(task => ['running', 'channel_running'].includes(publicPricingTaskState(task.status)))
    .map(async task => { const delivery = await studioDeliveryStatus(task); return [task.id, { phase: delivery.phase, acceptedAt: delivery.acceptedAt, waitingStatus: delivery.waitingStatus,
      generationDetailSuperseded: delivery.generationDetailSuperseded }] as const; })) : []);
  const assets = includeItems ? await prisma.asset.findMany({ where: { id: { in: tasks.flatMap(task => !task.deleted_at && studioTaskHasViewableOutput(task) && task.asset_id ? [task.asset_id] : []) }, owner_id: owner, status: 'active', type: 'image', AND: [await studioVisibleAssetWhere(identity)] }, select: { id: true, file_size: true, file_name: true, mime_type: true } }) : [];
  const statuses = batch.items.map(item => item.cancelled ? 'cancelled' : item.taskId
    ? (() => { const task = tasks.find(task => task.id === item.taskId); return task && studioTaskHasViewableOutput(task) ? 'succeeded' : publicImageTaskStatus(task?.status || 'uncertain'); })() : batch.definitionConfirmationRequired ? 'needs-confirmation' : 'pending');
  const active = statuses.filter(state => ['running', 'queued'].includes(state)).length;
  const pending = statuses.filter(state => state === 'pending' || state === 'needs-confirmation').length;
  const uncertain = statuses.filter(state => state === 'uncertain').length;
  const pricing = batch.billingContracts?.find(contract => contract?.pricing)?.pricing
    || tasks.map(task => parseImageBillingContract(task.billing_contract_json)?.pricing).find(Boolean);
  const creditPrecision = pricing && !['legacy_fixed', 'legacy_actual'].includes(pricing.mode) ? 0.1 as const : 0.01 as const;
  return { id: batch.id, requestId: batch.requestId, moduleId: batch.moduleId, moduleName: batch.moduleName, state: !active && !pending && uncertain ? 'uncertain' : batch.state === 'ready' && !active && !pending ? 'complete' : batch.state, note: batch.note, total: batch.total, generated: statuses.filter(state => state === 'succeeded').length, failed: statuses.filter(state => state === 'failed').length, uncertain, active, pending, prepared: batch.prepared, budget: batch.budget, committedCredits: batch.committedCredits, unitCredits: batch.unitCredits, createdAt: batch.createdAt,
    pricingRevision: pricing?.revision ?? null, creditPrecision,
    ...(batch.input.sharedLive ? { sharedLive: parseSharedStudioIntent(batch.input.sharedLive) } : {}),
    ...(batch.definitionConfirmationRequired ? { definitionConfirmationRequired: true } : {}),
    ...(typeof batch.input.model === 'string' ? { model: batch.input.model } : {}),
    ...(includeItems ? { items: batch.items.map((item, index) => {
      const task = tasks.find(task => task.id === item.taskId);
      const asset = assets.find(asset => asset.id === task?.asset_id);
      const mismatch = task && studioDimensionMismatch(task);
      const frozen = task || frozenByOrdinal.get(item.ordinal);
      const inputMainPreview = frozen && typeof frozen.snapshot_json === 'string' && typeof frozen.reference_ids === 'string'
        ? studioInputMainPreview(task ? { kind: 'task', taskId: task.id }
          : { kind: 'batch-item', batchId: batch.id, ordinal: item.ordinal, attempt: item.attempt },
        frozen.snapshot_json, frozen.reference_ids, readableInputIds)
        : { source: { kind: 'batch-item' as const, batchId: batch.id, ordinal: item.ordinal, attempt: item.attempt },
          state: item.prepared ? 'unknown' as const : 'unavailable' as const };
      return { ordinal: item.ordinal, sourceName: item.sourceName, taskId: item.taskId, status: statuses[index],
        error: mismatch && asset ? studioDimensionMismatchNotice(mismatch.validation) : task?.error,
        resultDisposition: mismatch ? mismatch.code === 'generated_format_mismatch' ? 'format_mismatch' as const : 'dimensions_mismatch' as const : null,
        outputIssue: task ? studioOutputIssue(task) : null, inputMainPreview,
        ...(task && deliveryByTask.has(task.id) ? { delivery: deliveryByTask.get(task.id) } : {}),
        billing: task ? imageBillingView(task, owner, false) : null, image: asset ? { id: asset.id, url: studioAssetUrl(asset.id), thumbnail: studioAssetUrl(asset.id, true), fileSize: asset.file_size || 0, fileName: asset.file_name, mimeType: asset.mime_type || 'image/png' } : null };
    }) } : {}) };
}
export async function listStudioBatches(owner: string, cursor?: string) {
  if (cursor && !validId(cursor)) throw new StudioError('批次分页无效');
  const cursorRow = cursor ? (await readOwned(owner, cursor)).row : undefined;
  const rows = await prisma.platformSetting.findMany({ where: { OR: [PREFIX, CHANNEL_PREFIX, PRICING_BATCH_PREFIX].map(prefix => ({ key: { startsWith: `${prefix}${owner}:` } })) }, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 13, ...(cursorRow ? { cursor: { id: cursorRow.id }, skip: 1 } : {}) });
  const selected = rows.slice(0, 12);
  return { batches: await Promise.all(selected.map(row => studioBatchView(owner, parse(row.value_json).id, false))), nextCursor: rows.length > 12 ? parse(selected[selected.length - 1].value_json).id : null };
}

export async function updateStudioBatch(owner: string, body: Record<string, unknown>) {
  const action = body.action;
  if (!['prepare', 'pause', 'resume', 'cancel', 'retry'].includes(String(action))) throw new StudioError('批次操作无效');
  const retryIds = body.ordinals;
  let shouldPrepare = action === 'prepare';
  let definitionConflict: Error | undefined;
  await prisma.$transaction(async tx => {
    const { row, batch } = await readOwned(owner, body.id, tx);
    if (['prepare', 'resume', 'retry'].includes(String(action))) {
      await recoverAcceptedBatchItems(tx, batch);
      try {
        await resolveOwnedStudioTaskSharedUse(owner, batch.moduleId,
          parseSharedStudioIntent(body.sharedLive ?? batch.input.sharedLive), tx,
          batch.input.restoredSettings !== undefined ? parseStudioRequest(batch.input) : undefined);
      } catch (error) {
        if (error instanceof SharedStudioDefinitionError || batch.input.sharedLive && sharedDefinitionError(error)) {
          await invalidateUnacceptedDefinition(tx, batch, error instanceof Error ? error.message : '模板已更新，请确认本次生成');
          await writeBatch(tx, row, batch); definitionConflict = error as Error; shouldPrepare = false; return;
        }
        throw error;
      }
    }
    if (action === 'prepare') {
      if (batch.definitionConfirmationRequired) throw new StudioError('模板已更新，请先重新报价并确认继续生成', 409);
      if (!['preparing', 'blocked'].includes(batch.state) || batch.prepared === batch.total) throw new StudioError('本批不需要继续准备');
      batch.state = 'preparing'; batch.note = '';
    }
    if (action === 'pause') { if (batch.state === 'preparing') throw new StudioError('素材尚未准备完成，请取消或等待'); batch.state = 'paused'; batch.note = '未派发项已暂停；已受理任务继续，未向上游申请撤销或退款'; }
    if (action === 'cancel') {
      {
        const queued = await tx.imageStudioTask.findMany({ where: { batch_id: batch.id, owner_id: owner, status: { in: studioTaskStates(['channel_queued']) } }, select: { id: true } });
        for (const task of queued) {
          try { await cancelQueuedChannelTask(owner, task.id, tx); }
          catch (error) { if (!(error instanceof StudioError && error.status === 409)) throw error; }
        }
      }
      batch.state = 'cancelled'; batch.items.forEach(item => { if (!item.taskId) item.cancelled = true; });
      batch.note = '只取消未派发项及可证明未请求上游的通道排队任务；已受理或未知任务、收据和费用继续保留，未向上游撤销或承诺退款';
    }
    if (action === 'resume') {
      if (batch.state === 'cancelled') throw new StudioError('本批已取消，原任务保留，不能重新派发', 409);
      const changedDefinition = !sameSharedStudioIntent(parseSharedStudioIntent(batch.input.sharedLive), parseSharedStudioIntent(body.sharedLive ?? batch.input.sharedLive));
      if (batch.definitionConfirmationRequired || changedDefinition) {
        await reconfirmBatchDefinition(tx, batch, body, row); shouldPrepare = true;
      } else {
        if (!batch.items.every(item => item.prepared || item.taskId || item.cancelled)) throw new StudioError('本批不能继续，请重新核对未准备素材');
        if (batch.input.sharedLive) await assertSharedStudioWorkerReady(tx);
        batch.state = 'ready'; batch.note = '';
      }
    }
    if (action === 'retry') {
      if (batch.billingMode === 'actual' || batch.pricing) throw new StudioError('本批重试需要重新报价，请复用原素材开始新批次；原失败项不会自动追扣', 409);
      if (!Array.isArray(retryIds) || !retryIds.length || retryIds.length > STUDIO_BATCH_LIMITS.images || retryIds.some(value => !Number.isInteger(value) || value < 1 || value > batch.total) || !boundedBudget(body.budget)) throw new StudioError('请选择失败项并填写新预算上限');
      assertBudgetVersion(body.budget);
      const selected = batch.items.filter(item => retryIds.includes(item.ordinal));
      if (selected.some(item => item.attempt >= 3)) throw new StudioError('每项最多重试 3 次，请先核对失败原因；本次未重新生成');
      if (selected.length !== new Set(retryIds).size || selected.some(item => !item.taskId)) throw new StudioError('所选条目不能重试');
      const failed = await tx.imageStudioTask.count({ where: { id: { in: selected.map(item => item.taskId!) }, owner_id: owner, status: 'failed' } });
      if (failed !== selected.length) throw new StudioError('仅能重试已确认失败项；结果未知请先核对，保存失败无需重新生成');
      if (Number(body.budget) < addCredits(batch.committedCredits, sumCredits(selected.map(() => batch.unitCredits)))) throw new StudioError('新预算不足以覆盖已派发点数与本次重试');
      batch.budget = Number(body.budget);
      selected.forEach(item => { item.taskId = null; item.attempt += 1; item.cancelled = false; });
      if (batch.input.sharedLive) { await reconfirmBatchDefinition(tx, batch, body, row); shouldPrepare = true; }
      else { batch.state = 'ready'; batch.note = ''; }
    }
    await writeBatch(tx, row, batch);
  }, { timeout: 15000 });
  if (definitionConflict) throw new StudioError(definitionConflict.message, 409);
  if (shouldPrepare) await prepareBatch(owner, body.id as string);
}

type BatchDispatchPosition = { at: Date; id: string };
let batchDispatchSweep: { cursor: BatchDispatchPosition | null; ceiling: BatchDispatchPosition } | null = null;

// Only the existing worker dispatches paid tasks; all GET routes are observation-only.
export async function dispatchStudioBatches() {
  const eligible: Prisma.PlatformSettingWhereInput = { OR: [PREFIX, CHANNEL_PREFIX, PRICING_BATCH_PREFIX].map(prefix => ({ key: { startsWith: prefix } })), value_json: { contains: '"state":"ready"' } };
  if (!batchDispatchSweep) {
    const last = await prisma.platformSetting.findFirst({ where: eligible, orderBy: [{ updated_at: 'desc' }, { id: 'desc' }], select: { updated_at: true, id: true } });
    if (!last) return;
    batchDispatchSweep = { cursor: null, ceiling: { at: last.updated_at, id: last.id } };
  }
  const sweep = batchDispatchSweep;
  // Capture tuples, not a cursor row's later position. The fixed upper bound
  // makes a sweep finish even while new tail entries keep arriving.
  const bounds: Prisma.PlatformSettingWhereInput[] = [{ OR: [
    { updated_at: { lt: sweep.ceiling.at } }, { updated_at: sweep.ceiling.at, id: { lte: sweep.ceiling.id } },
  ] }];
  if (sweep.cursor) bounds.push({ OR: [
    { updated_at: { gt: sweep.cursor.at } }, { updated_at: sweep.cursor.at, id: { gt: sweep.cursor.id } },
  ] });
  const rows = await prisma.platformSetting.findMany({ where: { ...eligible, AND: bounds }, orderBy: [{ updated_at: 'asc' }, { id: 'asc' }], take: 32 });
  if (!rows.length) { batchDispatchSweep = null; return; }
  // Keep the original ten-candidate work/admission budget. Unchecked entries
  // from the loaded page are not skipped by the next call's cursor.
  for (const candidate of rows.slice(0, 10)) {
    sweep.cursor = { at: candidate.updated_at, id: candidate.id };
    let original: BatchRecord;
    try { original = parse(candidate.value_json); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      console.error('[image-batch-dispatch]', JSON.stringify({ candidateId: candidate.id, code: 'invalid_candidate_deferred' }));
      continue;
    }
    try {
      await prisma.$transaction(async tx => {
        const { row, batch } = await readOwned(original.ownerId, original.id, tx);
        if (batch.state !== 'ready') return;
        if (batch.pricing) await assertPricingImageConsumerReady(tx);
        if (batch.definitionConfirmationRequired) { batch.state = 'needs-confirmation'; await writeBatch(tx, row, batch); return; }
        await recoverAcceptedBatchItems(tx, batch);
        const item = batch.items.find(item => item.prepared && !item.taskId && !item.cancelled);
        if (!item) {
          const active = await tx.imageStudioTask.count({ where: { batch_id: batch.id, owner_id: batch.ownerId, status: { in: studioTaskStates(['queued', 'running', 'channel_queued', 'channel_running']) } } });
          if (!active) { batch.state = 'complete'; await writeBatch(tx, row, batch); }
          return;
        }
        const sharedUse = await resolveOwnedStudioTaskSharedUse(batch.ownerId, batch.moduleId,
          parseSharedStudioIntent(batch.input.sharedLive), tx,
          batch.input.restoredSettings !== undefined ? parseStudioRequest(batch.input) : undefined);
        if (sharedUse) await assertSharedStudioWorkerReady(tx);
        await reserveImageStudioQueueCapacity(tx, batch.ownerId, 1);
        const prepared = await tx.platformSetting.findUnique({ where: { key: itemKey(batch, item.ordinal) } });
        if (!prepared) throw new StudioError('素材快照不可用，未派发新任务');
        const data = JSON.parse(prepared.value_json) as Prisma.ImageStudioTaskUncheckedCreateInput;
        const user = await tx.user.findUnique({ where: { id: batch.ownerId }, select: { id: true, role: true, account_type: true, feature_profile_id: true, status: true, user_profile: true, feishu_user_id: true, feishu_open_id: true, feishu_union_id: true, feishu_tenant_key: true } });
        if (!user || user.status !== 'active' || !canUseCompanyTemplates(user)) throw new StudioError('当前账号不能继续生成');
        if (data.source_preset_id) {
          const source = await tx.imageStudioPreset.findUnique({ where: { id: data.source_preset_id }, select: { owner_id: true, scope: true, is_shared: true } });
          if (!source || !canViewStudioPreset(user, source)) throw new StudioError('模板已停止共享，未派发新任务');
        }
        const snapshot = JSON.parse(String(data.snapshot_json));
        if (!sameSharedStudioIntent(parseSharedStudioIntent(snapshot.sharedLive), sharedUse?.definition.intent)) throw new SharedStudioDefinitionError();
        if (sharedUse && !isChannelBatch(batch)) {
          const frozenOriginal = snapshot.imageChannel as ImageGenerationChannelSnapshot | undefined;
          if (!frozenOriginal || frozenOriginal.channelId !== 'original') throw new SharedStudioDefinitionError('共享模板未受理快照缺少原供应商配置，请重新报价');
          await resolveImageGenerationChannelSnapshot(frozenOriginal, tx, true, String(data.model));
        }
        const transientIds = (snapshot.transientReferenceImages || []).map((reference: { id: string }) => reference.id);
        const visibleReferences = await tx.asset.count({ where: { id: { in: transientIds }, owner_id: batch.ownerId, status: 'active', type: 'image', AND: [await studioVisibleAssetWhere(user, tx)] } });
        if (visibleReferences !== new Set(transientIds).size) throw new StudioError('本批参考图已不可用，未派发新任务');
        if (snapshot.restoredSettings && snapshot.templateReferenceImages?.length) {
          const templateIds = snapshot.templateReferenceImages.map((reference: { id: string }) => reference.id);
          const readable = await tx.asset.count({ where: { id: { in: templateIds }, status: 'active', type: 'image',
            AND: [await studioVisibleAssetWhere(user, tx)] } });
          if (readable !== new Set(templateIds).size) throw new StudioError('原记录的模板参考图已不可用，未派发新任务', 403);
        }
        const allIds = Array.from(new Set<string>((snapshot.referenceImages || []).map((reference: { id: string }) => reference.id)));
        const assets = await tx.asset.findMany({ where: { id: { in: allIds }, status: 'active', type: 'image' }, select: { id: true, owner_id: true, hash: true } });
        if (assets.length !== allIds.length || assets.some(asset => asset.owner_id !== snapshot.authorizedReferenceOwners?.[asset.id] || snapshot.referenceImages.find((reference: { id: string }) => reference.id === asset.id)?.hash !== asset.hash)) throw new StudioError('本批素材归属或内容已变化，未派发新任务');
        if ((!sharedUse || snapshot.restoredSettings) && snapshot.styleGroupIds?.length) {
          const selected = await resolveStudioStyleReferences(user, snapshot.styleGroupIds, tx);
          if (snapshot.restoredSettings) {
            const draft = batch.input.draft as { styleGroupVersions?: Record<string, number> } | undefined;
            if (draft?.styleGroupVersions) assertRestoredStudioStyleVersions(selected.groups, draft.styleGroupVersions);
            else if (snapshot.styleGroups?.some((group: { id: string; ownerId?: string }) => group.ownerId !== undefined
              && selected.groups.find(current => current.id === group.id)?.ownerId !== group.ownerId)) {
              throw new StudioError('历史风格归属已变化，未派发新任务', 403);
            }
          }
        }
        await historicalSkills(user, snapshot.skills, tx);
        if (snapshot.restoredSettings) {
          const draft = batch.input.draft as { skillIds?: string[]; skillVersions?: Record<string, string> } | undefined;
          if (draft?.skillIds) {
            const current = await resolveSkills(user, draft.skillIds, tx);
            if (current.some(skill => draft.skillVersions?.[skill.id] !== skill.promptVersion)) {
              throw new StudioError('本次改选的提示词组已更新，未派发新任务', 409);
            }
          }
        }
        const settingsRow = await tx.platformSetting.findUnique({ where: { key: IMAGE_STUDIO_SETTING_KEY } });
        let channelApi: ImageGenerationResolvedSettings | null = null;
        if (isChannelBatch(batch)) {
          await assertImageGenerationChannelDispatchOpen(batch.input.imageChannel as ImageGenerationChannelSnapshot, tx);
          channelApi = await resolveImageGenerationChannelSnapshot(batch.input.imageChannel as ImageGenerationChannelSnapshot, tx, false, String(data.model));
        }
        const currentPrice = isChannelBatch(batch)
          ? channelApi?.modelCapabilities[String(data.model) as keyof typeof channelApi.modelCapabilities]?.fixedPoints
          : ({ ...DEFAULT_STUDIO_PRICES, ...(settingsRow ? JSON.parse(settingsRow.value_json).prices : {}) } as Record<string, number | null>)[String(data.model)];
        if (batch.billingMode === 'actual') {
          const contract = batch.billingContracts?.[item.ordinal - 1];
          const api = channelApi || await getImageGenerationSettingsForModel(String(data.model), tx);
          const ready = contract ? await imageBillingReady(contract.scope, contract.model, tx) : null;
          if (!contract || !ready?.ready || imageBillingScope(api) !== contract.scope
            || isChannelBatch(batch) && (!isMuskImageGenerationChannel(api) || new URL(api.base_url).origin !== 'https://api.muskapis.com')
            || !isChannelBatch(batch) && (!settingsRow || JSON.parse(settingsRow.value_json).revision !== snapshot.settingsRevision)
            || Date.parse(contract.deadline!) <= Date.now()) throw new StudioError('本批实扣合同或通道已变化，停止新派发；请重新报价');
          batch.committedCredits = await batchBillingCommitted(tx, batch);
        } else if (batch.pricing) {
          const frozen = batch.billingContracts?.[item.ordinal - 1];
          if (!frozen?.pricing || JSON.stringify(frozen) !== data.billing_contract_json
            || frozen.authorizedCredits !== data.unit_credits) throw new StudioError('父批次冻结合同不完整，未派发子项', 409);
        } else if (currentPrice !== data.unit_credits) throw new StudioError('价格变化，已停止新派发；请核对后开始新批次');
        if (addCredits(batch.committedCredits, Number(data.unit_credits)) > batch.budget) throw new StudioError('预算不足，已停止新派发；已扣、预留和待对账均计入预算');
        const taskId = childId(batch, item);
        if (isChannelBatch(batch) && (channelApi?.modelCapabilities[String(data.model) as keyof typeof channelApi.modelCapabilities]?.fixedPoints !== data.unit_credits
          && batch.billingMode !== 'actual' && !batch.pricing)) throw new StudioError('本通道固定点数已变化，停止新派发；请重新核对预算');
        const channelStatus = studioTaskState({ billing_contract_json: String(data.billing_contract_json) }, isChannelBatch(batch) ? 'channel_queued' : 'queued');
        const freeze = Number(data.unit_credits) > 0 ? await allocateTaskCredits(tx, user, Number(data.unit_credits), taskId) : null;
        await assertUsageProject(tx, user, batch.usageContext?.projectId ?? null);
        const created = await tx.imageStudioTask.create({ data: { ...data, id: taskId, status: channelStatus, freeze_snapshot: freeze?.snapshot } });
        await recordUsageAttribution(tx, { sourceKind: 'image_task', sourceId: taskId,
          actorUserId: batch.ownerId, ownerUserId: batch.ownerId, billingSubjectType: 'user', billingSubjectId: batch.ownerId,
          projectId: batch.usageContext?.projectId ?? null, occurredAt: created.created_at,
          contextOrigin: batch.usageContext ? 'image-parent-batch' : 'legacy-parent-unassigned' });
        if (freeze) await tx.creditLedger.create({ data: { user_id: batch.ownerId, type: 'task_freeze', amount: -Number(data.unit_credits), balance_before: freeze.balance_before, balance_after: freeze.balance_after, frozen_before: freeze.frozen_before, frozen_after: freeze.frozen_after, related_task_id: taskId, idempotency_key: `image-studio:freeze:${taskId}`, reason: '图片生成冻结积分', metadata_json: JSON.stringify({ allocations: freeze.allocations }) } });
        item.taskId = taskId; batch.committedCredits = addCredits(batch.committedCredits, Number(data.unit_credits));
        await writeBatch(tx, row, batch);
      }, { timeout: 15000 });
    } catch (error) {
      if (error instanceof QueueCapacityError || error instanceof QueueMaintenanceError) continue;
      try {
        await prisma.$transaction(async tx => {
          const { row, batch } = await readOwned(original.ownerId, original.id, tx);
          if (batch.state !== 'ready') return;
          if (error instanceof SharedStudioDefinitionError || batch.input.sharedLive && sharedDefinitionError(error)) {
            try { await recoverAcceptedBatchItems(tx, batch); }
            catch (acceptanceError) {
              batch.state = 'blocked'; batch.note = acceptanceError instanceof Error ? acceptanceError.message : '原费用受理记录待核对，未重新生成';
              await writeBatch(tx, row, batch); return;
            }
            await invalidateUnacceptedDefinition(tx, batch, error instanceof Error ? error.message : '模板已更新，请确认本次生成');
          } else {
            batch.state = 'blocked'; batch.note = error instanceof StudioError || error instanceof ImageGenerationChannelError ? error.message : error instanceof Error && error.message.startsWith('点数不足') ? '可用点数不足，已停止新派发；补足点数后可继续' : '批次派发暂时中断，已受理项保留，请重新读取后继续';
          }
          await writeBatch(tx, row, batch);
        });
      } catch (deferred) {
        // A removed/invalid individual target must not pin the scan. Shared
        // database/infrastructure errors still propagate to the coordinator.
        if (!(deferred instanceof StudioError) || deferred.status < 400 || deferred.status >= 500) throw deferred;
        console.error('[image-batch-dispatch]', JSON.stringify({ candidateId: candidate.id, code: 'candidate_unavailable_deferred', status: deferred.status }));
      }
    }
  }
  if (rows.length <= 10) batchDispatchSweep = null;
}

async function batchBillingCommitted(tx: Pick<Prisma.TransactionClient, 'imageStudioTask'>, batch: BatchRecord) {
  const rows = await tx.imageStudioTask.findMany({ where: { owner_id: batch.ownerId, batch_id: batch.id },
    select: { billing_settled_at: true, actual_credits: true, unit_credits: true } });
  return sumCredits(rows.map(row => row.billing_settled_at ? row.actual_credits ?? 0 : row.unit_credits));
}
