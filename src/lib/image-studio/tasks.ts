import { createHash, randomUUID } from 'node:crypto';
import type { ImageStudioTask } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { allocateTaskCredits, settleTaskCredits } from '@/lib/credits/policy';
import { getImageStudioSettings } from './settings';
import { getImageGenerationApiSettings, isImageGenerationApiReady, isStudioImageGenerationProvider } from '@/lib/integrations/image-generation';
import { defaultStudioModuleId, resolveStudioModuleGenerationConfig, validStudioModuleId } from './modules';
import { canUseCompanyTemplates, canViewStudioPreset, type ImageStudioIdentity } from './access';
import { resolveStudioAspectRatio, normalizeStudioRatio } from './ratios';
import { imageOutputSize, normalizeImageResolution, IMAGE_RESOLUTION_OPTIONS } from '@/lib/image-generation/resolution';
import { MAX_REFERENCE_IMAGES } from './limits';
import { IMAGE_STUDIO_MODEL_COST_USD } from './model-catalog';
import { studioAssetUrl, studioTemplateAssetUrl } from './media';

export class StudioError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function parseStudioRequest(body: Record<string, unknown>) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StudioError('提交内容无效');
  if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(body.requestId)) throw new StudioError('提交编号无效');
  if (typeof body.prompt !== 'string' || body.prompt.length > 20000) throw new StudioError('画面描述不能超过 20000 字');
  if (!Number.isInteger(body.count) || Number(body.count) < 1 || Number(body.count) > 8) throw new StudioError('生成张数必须为 1 到 8');
  if (!Number.isInteger(body.revision)) throw new StudioError('请刷新生成设置');
  if (!Array.isArray(body.referenceIds) || body.referenceIds.length > MAX_REFERENCE_IMAGES || body.referenceIds.some(id => typeof id !== 'string' || id.length > 100)) throw new StudioError(`最多使用 ${MAX_REFERENCE_IMAGES} 张有效参考图`);
  if (!body.prompt.trim() && !body.referenceIds.length) throw new StudioError('请添加参考图片或填写画面描述');
  let aspectRatio: string | undefined;
  try { if (body.aspectRatio !== undefined) aspectRatio = normalizeStudioRatio(body.aspectRatio); }
  catch (error) { throw new StudioError((error as Error).message); }
  let resolution: string | undefined;
  if (body.resolution !== undefined) {
    if (typeof body.resolution !== 'string' || !IMAGE_RESOLUTION_OPTIONS.includes(body.resolution as typeof IMAGE_RESOLUTION_OPTIONS[number])) throw new StudioError('分辨率设置无效');
    resolution = body.resolution;
  }
  const moduleRevision = body.moduleRevision === undefined ? undefined : Number(body.moduleRevision);
  if (moduleRevision !== undefined && (!Number.isInteger(moduleRevision) || moduleRevision < 0)) throw new StudioError('模块已更新，请刷新后重试', 409);
  const reproduceFromTaskId = body.reproduceFromTaskId === undefined ? undefined : body.reproduceFromTaskId;
  if (reproduceFromTaskId !== undefined && (typeof reproduceFromTaskId !== 'string' || reproduceFromTaskId.length > 120)) throw new StudioError('历史生成记录无效', 400);
  return { requestId: body.requestId, prompt: body.prompt.trim(), count: Number(body.count), revision: Number(body.revision), moduleRevision, reproduceFromTaskId, referenceIds: body.referenceIds as string[], ...(aspectRatio !== undefined ? { aspectRatio } : {}), ...(resolution !== undefined ? { resolution } : {}) };
}

export async function submitStudioBatch(ownerId: string, body: Record<string, unknown>) {
  const input = parseStudioRequest(body);
  const moduleId = body.moduleId;
  if (moduleId !== undefined && !validStudioModuleId(moduleId, ownerId)) throw new StudioError('模块编号无效');
  const batchId = createHash('sha256').update(`${ownerId}:${input.requestId}`).digest('hex');
  const fingerprint = createHash('sha256').update(JSON.stringify({ ...input, requestId: undefined, ...(moduleId ? { moduleId } : {}) })).digest('hex');
  const previous = await prisma.imageStudioTask.findFirst({ where: { batch_id: batchId, owner_id: ownerId } });
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new StudioError('提交编号已用于其他请求，请重新提交', 409);
    return batchId;
  }
  const settings = await getImageStudioSettings();
  if (settings.revision !== input.revision) throw new StudioError('生成规则或通用上下文已更新，请重新读取设置后确认提交', 409);
  const imageApi = await getImageGenerationApiSettings();
  if (!isStudioImageGenerationProvider(imageApi.provider) || !isImageGenerationApiReady(imageApi)) throw new StudioError('图片专用 API 尚未配置', 503);
  await prisma.$transaction(async tx => {
    const duplicate = await tx.imageStudioTask.findFirst({ where: { batch_id: batchId, owner_id: ownerId } });
    if (duplicate) {
      if (duplicate.fingerprint !== fingerprint) throw new StudioError('提交编号冲突', 409);
      return;
    }
    const user = await tx.user.findUnique({ where: { id: ownerId }, select: {
      id: true, role: true, account_type: true, status: true,
      user_profile: true,
      feishu_user_id: true, feishu_open_id: true, feishu_union_id: true, feishu_tenant_key: true,
    } });
    if (!user || user.status !== 'active') throw new StudioError('当前账号无法生成', 403);
    const identity: ImageStudioIdentity = user;
    if (!canUseCompanyTemplates(identity)) throw new StudioError('仅限公司飞书账号生成图片', 403);
    const workspace = moduleId ? await tx.imageStudioModule.findFirst({ where: { id: moduleId as string, owner_id: ownerId } }) : null;
    if (moduleId && moduleId !== defaultStudioModuleId(ownerId) && !workspace) throw new StudioError('模块不存在或无权使用', 403);
    let sourcePresetId = workspace?.source_preset_id || null;
    if (workspace?.source_preset_id) {
      const source = await tx.imageStudioPreset.findUnique({ where: { id: workspace.source_preset_id }, select: { owner_id: true, scope: true, is_shared: true } });
      if (!source || !canViewStudioPreset(identity, source)) throw new StudioError('该模板已停止共享，不能新建任务', 403);
    }
    if (workspace && input.moduleRevision !== undefined && workspace.revision !== input.moduleRevision) throw new StudioError('模块已在其他页面更新，请刷新后核对', 409);
    const generation = resolveStudioModuleGenerationConfig(workspace, settings);
    const price = generation.prices[generation.model];
    if (price === null || !Number.isInteger(price) || price < 0 || price > 100000) throw new StudioError('管理员尚未设置当前模块的有效生成积分', 409);
    let snapshotGlobalContext = settings.context;
    let snapshotModuleContext = workspace?.context || '';
    let context = [snapshotGlobalContext.trim(), snapshotModuleContext.trim()].filter(Boolean).join('\n\n---\n模块上下文：\n');
    let referenceIds = input.referenceIds;
    const reproduceFromTaskId = input.reproduceFromTaskId || workspace?.reproduce_task_id || undefined;
    if (reproduceFromTaskId) {
      const source = await tx.imageStudioTask.findFirst({ where: { id: reproduceFromTaskId, owner_id: ownerId }, select: { source_preset_id: true, snapshot_json: true } });
      if (!source?.snapshot_json) throw new StudioError('历史记录缺少可恢复上下文，请按当前模块重新生成', 409);
      try {
        const sourceSnapshot = JSON.parse(source.snapshot_json) as { globalContext?: unknown; moduleContext?: unknown; referenceImages?: unknown; sourcePresetId?: unknown };
        const historicalSourcePresetId = source.source_preset_id || (typeof sourceSnapshot.sourcePresetId === 'string' ? sourceSnapshot.sourcePresetId : null);
        if (!sourcePresetId && historicalSourcePresetId) sourcePresetId = historicalSourcePresetId;
        if (historicalSourcePresetId) {
          const historicalSource = await tx.imageStudioPreset.findUnique({ where: { id: historicalSourcePresetId }, select: { owner_id: true, scope: true, is_shared: true } });
          if (!historicalSource || !canViewStudioPreset(identity, historicalSource)) throw new StudioError('该模板已停止共享，不能新建任务', 403);
        }
        const sourceContext = [sourceSnapshot.globalContext, sourceSnapshot.moduleContext]
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          .map(value => value.trim()).join('\n\n---\n模块上下文：\n');
        if (!sourceContext) throw new Error('empty_context');
        context = sourceContext;
        snapshotGlobalContext = typeof sourceSnapshot.globalContext === 'string' ? sourceSnapshot.globalContext : '';
        snapshotModuleContext = typeof sourceSnapshot.moduleContext === 'string' ? sourceSnapshot.moduleContext : '';
      } catch (error) {
        if (error instanceof StudioError) throw error;
        throw new StudioError('历史记录缺少可恢复上下文，请按当前模块重新生成', 409);
      }
    }
    if (!context) throw new StudioError('请先设置当前模块的上下文', 409);
    const active = await tx.imageStudioTask.count({ where: { owner_id: ownerId, status: { in: ['queued', 'running'] } } });
    if (active + input.count > 8) throw new StudioError('最多同时生成 8 张，请等待当前任务完成', 429);
    const references = await tx.asset.findMany({ where: { id: { in: referenceIds }, owner_id: ownerId, status: 'active', type: 'image' },
      select: { id: true, original_url: true, thumbnail_url: true, file_name: true, mime_type: true, width: true, height: true, file_size: true, hash: true } });
    if (references.length !== new Set(referenceIds).size) throw new StudioError('参考图不存在或无权使用', 403);
    const referencesById = new Map(references.map(reference => [reference.id, reference]));
    const referenceSnapshot = referenceIds.map(id => {
      const reference = referencesById.get(id);
      return { id, originalUrl: reference ? studioTemplateAssetUrl(id) : null, thumbnailUrl: reference ? studioTemplateAssetUrl(id, true) : null,
        fileName: reference?.file_name || null, mimeType: reference?.mime_type || null, width: reference?.width || null,
        height: reference?.height || null, fileSize: reference?.file_size || null, hash: reference?.hash || null };
    });
    const requestedAspectRatio = input.aspectRatio || 'auto';
    const firstReference = referenceIds.map(id => referencesById.get(id)).find(reference => reference?.width && reference?.height) || null;
    const ratioResolution = resolveStudioAspectRatio(requestedAspectRatio, firstReference);
    const aspectRatio = ratioResolution.requested;
    const resolvedAspectRatio = ratioResolution.resolved;
    const aspectRatioSource = ratioResolution.source;
    const resolution = normalizeImageResolution(generation.model, input.resolution || generation.resolution, imageApi.provider);
    const outputSize = imageOutputSize(generation.model, resolution, resolvedAspectRatio, imageApi.provider);
    const snapshot = JSON.stringify({
      version: 1,
      referenceImages: referenceSnapshot,
      globalContext: snapshotGlobalContext,
      moduleContext: snapshotModuleContext,
      moduleId: workspace?.id || moduleId || null,
      sourcePresetId,
      reproducedFromTaskId: reproduceFromTaskId || null,
      moduleName: workspace?.name || null,
      prompt: input.prompt,
      model: generation.model,
      quality: generation.quality,
      prices: generation.prices,
      unitCredits: price,
      count: input.count,
      aspectRatio,
      resolvedAspectRatio,
      aspectRatioSource,
      resolution,
      outputSize: outputSize || null,
      resolvedOutputSize: outputSize || null,
      outputFormat: 'png',
      settingsRevision: settings.revision,
        moduleRevision: workspace?.revision ?? null,
    });
    for (let i = 0; i < input.count; i++) {
      const id = `${batchId}-${i}`;
      const freeze = price > 0 ? await allocateTaskCredits(tx, user, price, id) : null;
      await tx.imageStudioTask.create({ data: {
        id, batch_id: batchId, owner_id: ownerId, module_id: moduleId as string | undefined, source_preset_id: sourcePresetId, ordinal: i + 1, fingerprint,
        prompt: input.prompt, context, revision: settings.revision, model: generation.model,
        quality: generation.quality,
        provider_cost_usd: IMAGE_STUDIO_MODEL_COST_USD[generation.model as keyof typeof IMAGE_STUDIO_MODEL_COST_USD], snapshot_json: snapshot,
        aspect_ratio: aspectRatio, output_size: outputSize,
        reference_ids: JSON.stringify(referenceIds), unit_credits: price, freeze_snapshot: freeze?.snapshot,
      } });
      if (freeze) await tx.creditLedger.create({ data: {
        user_id: ownerId, type: 'task_freeze', amount: -price,
        balance_before: freeze.balance_before, balance_after: freeze.balance_after,
        frozen_before: freeze.frozen_before, frozen_after: freeze.frozen_after,
        related_task_id: id, idempotency_key: `image-studio:freeze:${id}`, reason: '图片生成冻结积分',
      } });
    }
  }, { timeout: 15000 });
  return batchId;
}

export async function finishStudioTask(task: ImageStudioTask, status: 'succeeded' | 'failed' | 'uncertain', data: { assetId?: string; error?: string; usage?: unknown } = {}) {
  await prisma.$transaction(async tx => {
    const changed = await tx.imageStudioTask.updateMany({
      where: { id: task.id, status: 'running', lease_token: task.lease_token },
      data: { status, asset_id: data.assetId, error: data.error, usage_json: data.usage ? JSON.stringify(data.usage) : undefined,
        lease_until: null, lease_token: null, finished_at: new Date() },
    });
    if (!changed.count || task.unit_credits === 0) return;
    const settlement = await settleTaskCredits(tx, { taskId: task.id, userId: task.owner_id,
      terminalStatus: status, frozenAmount: task.unit_credits, freezeSnapshot: task.freeze_snapshot });
    await tx.creditLedger.create({ data: {
      user_id: task.owner_id, type: status === 'succeeded' ? 'task_success_deduct' : 'task_failed_refund',
      amount: status === 'succeeded' ? -settlement.actualCost : settlement.refundedAmount,
      balance_before: settlement.balanceBefore, balance_after: settlement.balanceAfter,
      frozen_before: settlement.frozenBefore, frozen_after: settlement.frozenAfter,
      related_task_id: task.id, idempotency_key: `image-studio:settle:${task.id}`,
      reason: status === 'succeeded' ? '图片已保存，结算积分' : '图片未交付，释放冻结积分',
    } });
  }, { timeout: 15000 });
}

export async function claimStudioTask() {
  const candidate = await prisma.imageStudioTask.findFirst({ where: { status: 'queued' }, orderBy: { created_at: 'asc' } });
  if (!candidate) return null;
  const leaseToken = randomUUID();
  const changed = await prisma.imageStudioTask.updateMany({ where: { id: candidate.id, status: 'queued' },
    data: { status: 'running', lease_token: leaseToken, lease_until: new Date(Date.now() + 10 * 60 * 1000) } });
  return changed.count ? { ...candidate, status: 'running', lease_token: leaseToken } : null;
}

export async function listStudioTasks(ownerId: string, cursor?: string, moduleId?: string) {
  if (moduleId && !validStudioModuleId(moduleId, ownerId)) throw new StudioError('模块编号无效');
  const rows = await prisma.imageStudioTask.findMany({ where: { owner_id: ownerId, deleted_at: null,
    ...(moduleId ? moduleId === defaultStudioModuleId(ownerId) ? { OR: [{ module_id: null }, { module_id: moduleId }] } : { module_id: moduleId } : {}) },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 25,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
  const items = rows.slice(0, 24);
  const outputAssetIds = items.flatMap(item => item.asset_id ? [item.asset_id] : []);
  const referenceIds = Array.from(new Set(items.flatMap(item => {
    try { return JSON.parse(item.reference_ids) as string[]; } catch { return []; }
  })));
  const assets = await prisma.asset.findMany({ where: { id: { in: [...outputAssetIds, ...referenceIds] }, owner_id: ownerId, status: 'active' },
    select: { id: true, original_url: true, thumbnail_url: true, width: true, height: true } });
  const assetById = new Map(assets.map(asset => [asset.id, asset]));
  return { tasks: items.map(task => ({ id: task.id, batchId: task.batch_id, ordinal: task.ordinal,
    prompt: task.prompt, model: task.model, quality: task.quality, status: task.status, error: task.error, unitCredits: task.unit_credits,
    providerCostUsd: task.provider_cost_usd,
    aspectRatio: task.aspect_ratio, outputSize: task.output_size,
    createdAt: task.created_at, finishedAt: task.finished_at, referenceIds: JSON.parse(task.reference_ids) as string[],
    snapshot: publicStudioSnapshot(task, assetById),
    asset: assetById.get(task.asset_id || '') ? { ...assetById.get(task.asset_id || '')!, original_url: studioAssetUrl(task.asset_id!), thumbnail_url: studioAssetUrl(task.asset_id!, true) } : null,
  })), nextCursor: rows.length > 24 ? items[items.length - 1].id : null };
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
    prompt: task.prompt,
    model: task.model,
    status: task.status,
    deletedAt: task.deleted_at,
    error: task.error,
    unitCredits: task.unit_credits,
    providerCostUsd: task.provider_cost_usd,
    aspectRatio: task.aspect_ratio,
    outputSize: task.output_size,
    createdAt: task.created_at,
    finishedAt: task.finished_at,
    asset: assetById.get(task.asset_id || '') || null,
  }));
  return { tasks: items, nextCursor: rows.length > 24 ? items[items.length - 1].id : null };
}

function publicStudioSnapshot(task: Pick<ImageStudioTask, 'snapshot_json' | 'prompt' | 'model' | 'quality' | 'reference_ids' | 'aspect_ratio' | 'output_size'>, assets: Map<string, { id: string; original_url: string; thumbnail_url: string | null; width: number | null; height: number | null }>) {
  let parsed: Record<string, unknown> = {};
  try { parsed = task.snapshot_json ? JSON.parse(task.snapshot_json) as Record<string, unknown> : {}; } catch { parsed = {}; }
  const snapshotReferences = Array.isArray(parsed.referenceImages) ? parsed.referenceImages : [];
  const sourceAvailable = typeof task.snapshot_json === 'string' && task.snapshot_json.length > 0
    && typeof parsed.globalContext === 'string' && typeof parsed.moduleContext === 'string'
    && Boolean(String(parsed.globalContext).trim() || String(parsed.moduleContext).trim());
  const fallbackReferences = (() => {
    try { return (JSON.parse(task.reference_ids) as string[]).map(id => { const asset = assets.get(id); return { id, originalUrl: asset ? studioTemplateAssetUrl(id) : null, thumbnailUrl: asset ? studioTemplateAssetUrl(id, true) : null, width: asset?.width || null, height: asset?.height || null }; }); }
    catch { return []; }
  })();
  const referenceImages = (snapshotReferences.length ? snapshotReferences : fallbackReferences)
    .map(item => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      if (typeof record.id !== 'string') return null;
      return {
        id: record.id,
        originalUrl: studioTemplateAssetUrl(record.id),
        thumbnailUrl: studioTemplateAssetUrl(record.id, true),
        fileName: typeof record.fileName === 'string' ? record.fileName : null,
        mimeType: typeof record.mimeType === 'string' ? record.mimeType : null,
        width: typeof record.width === 'number' ? record.width : null,
        height: typeof record.height === 'number' ? record.height : null,
        fileSize: typeof record.fileSize === 'number' ? record.fileSize : null,
        hash: typeof record.hash === 'string' ? record.hash : null,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
  const count = Number.isInteger(parsed.count) && Number(parsed.count) >= 1 && Number(parsed.count) <= 8 ? Number(parsed.count) : 1;
  const unitCredits = typeof parsed.unitCredits === 'number' && Number.isFinite(parsed.unitCredits) ? parsed.unitCredits : null;
  return {
    prompt: typeof parsed.prompt === 'string' ? parsed.prompt : task.prompt,
    model: typeof parsed.model === 'string' ? parsed.model : task.model,
    quality: typeof parsed.quality === 'string' ? parsed.quality : task.quality,
    count,
    aspectRatio: typeof parsed.aspectRatio === 'string' ? parsed.aspectRatio : task.aspect_ratio,
    resolvedAspectRatio: typeof parsed.resolvedAspectRatio === 'string' ? parsed.resolvedAspectRatio : task.aspect_ratio,
    aspectRatioSource: typeof parsed.aspectRatioSource === 'string' ? parsed.aspectRatioSource : 'model-default',
    resolution: typeof parsed.resolution === 'string' ? parsed.resolution : null,
    outputSize: typeof parsed.outputSize === 'string' ? parsed.outputSize : task.output_size,
    globalContext: typeof parsed.globalContext === 'string' ? parsed.globalContext : '',
    moduleContext: typeof parsed.moduleContext === 'string' ? parsed.moduleContext : '',
    unitCredits,
    sourceAvailable,
    referenceImages,
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
