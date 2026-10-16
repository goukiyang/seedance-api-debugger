import { prisma } from '@/lib/prisma';
import { getImageGenerationSettingsForModel, isImageGenerationApiReady, isStudioImageGenerationProvider,
  resolveImageGenerationChannelSnapshot, isMuskImageGenerationChannel, validateImageGenerationChannel, assertImageGenerationChannelDispatchOpen, ImageGenerationChannelError,
  imageGenerationSupportsStudioFourToOne, type ImageGenerationResolvedSettings } from '@/lib/integrations/image-generation';
import { claimStudioTask, finishStudioTask, safeImageChannelSnapshot, assertFrozenSharedStudioTask } from './tasks';
import { requestStudioImages, StudioProviderError } from './provider';
import { normalizeStudioImage, validateGeneratedStudioImage, readStudioImage, StudioImageDeliveryError, StudioImageDownloadError } from './media';
import { STUDIO_EXECUTION_MS } from './limits';
import { completeToolFlowTask } from '@/lib/tools/toolflow-runtime';
import { randomUUID } from 'node:crypto';
import type { ImageStudioTask } from '@prisma/client';
import { beginStudioRequest, recordStudioResponse, createStudioBase64Delivery, createStudioDelivery, readStudioDelivery, downloadStudioDelivery,
  discardStudioDelivery, studioDeliveryCanRetry, studioDeliveryStatus, cleanupStudioDeliveries, updateStudioDelivery, type StudioDelivery,
  createStudioAsyncReceipt, readStudioAsyncReceipt, updateStudioAsyncReceipt, readStudioRequestReceipt, resetStudioAsyncDelivery, setStudioUnsentRequestState, type StudioAsyncReceipt } from './delivery';
import { prepareStudioOutput } from './output';
import { imageBillingScope } from './billing-scope';
import { parseImageBillingContract } from './billing-contract';
import { imageBillingReady } from './billing-readiness';
import { reserveImageStudioQueueCapacity } from './queue-capacity';
import { finishRejectedStudioDimensions } from './dimension-rejection';
import { recordStudioResponseEvidence } from './response-evidence';

export async function assertStudioPostAuthorization(task: ImageStudioTask) {
  const current = await prisma.imageStudioTask.findUnique({ where: { id: task.id } });
  const activeStatus = task.status === 'channel_running' ? 'channel_running' : 'running';
  if (!current || current.status !== activeStatus || current.lease_token !== task.lease_token
    || !current.lease_until || current.lease_until <= new Date()) throw new StudioImageDownloadError('delivery_lease_lost');
  // Only validate the accepted snapshot; never resolve today's shared source here.
  assertFrozenSharedStudioTask(current);
  if (current.billing_mode === 'actual') {
    const contract = parseImageBillingContract(current.billing_contract_json);
    const billingStatus = activeStatus === 'channel_running' ? 'channel_awaiting_response' : 'awaiting_response';
    if (!contract || contract.mode !== 'actual' || contract.scope !== current.billing_scope
      || contract.authorizedCredits !== current.unit_credits || current.billing_settled_at
      || current.billing_status !== billingStatus || current.gateway_request_id
      || !current.billing_deadline || current.billing_deadline <= new Date()
      || Date.parse(contract.deadline!) <= Date.now()) throw new Error('图片费用授权已停止，未向供应商提交');
  }
}

export async function processStudioTask(generate: typeof requestStudioImages = requestStudioImages) {
  const task = await claimStudioTask();
  if (!task) return false;
  if (task.status === 'channel_running') await executeChannelStudioTask(task, generate);
  else await executeStudioTask(task, generate);
  return true;
}

async function executeStudioTask(task: ImageStudioTask, generate: typeof requestStudioImages, recovery?: StudioDelivery) {
  let providerStarted = Boolean(recovery);
  let delivery = recovery;
  let stage = 'prepare';
  const started = Date.now();
  const taskSignal = AbortSignal.timeout(STUDIO_EXECUTION_MS);
  const assertLease = async () => {
    taskSignal.throwIfAborted();
    const held = await prisma.imageStudioTask.findFirst({ where: { id: task.id, status: 'running', lease_token: task.lease_token, lease_until: { gt: new Date() } }, select: { id: true } });
    if (!held) throw new StudioImageDownloadError('delivery_lease_lost');
  };
  const download = (record: StudioDelivery) => downloadStudioDelivery(record, taskSignal, undefined, undefined, assertLease);
  try {
    const owner = await prisma.user.findUnique({ where: { id: task.owner_id }, select: { status: true } });
    if (owner?.status !== 'active') throw new Error('当前账号无法生成');
    let usage: unknown;
    let original: Buffer;
    if (recovery) {
      stage = 'download';
      if (!studioDeliveryCanRetry(recovery)) throw new StudioImageDownloadError('download_recovery_limit');
      await assertLease();
      await updateStudioDelivery(recovery, { recoveries: (recovery.recoveries || 0) + 1 });
      original = await download(recovery); usage = recovery.usage;
    } else {
      if (task.billing_mode === 'actual') {
        const contract = parseImageBillingContract(task.billing_contract_json);
        if (!contract || contract.mode !== 'actual' || Date.parse(contract.deadline!) <= Date.now()) throw new Error('图片费用授权已过期，未向供应商提交');
      }
      const snapshot = task.snapshot_json ? JSON.parse(task.snapshot_json) : {};
      const frozenChannel = safeImageChannelSnapshot(snapshot.imageChannel);
      if (snapshot.sharedLive !== undefined) assertFrozenSharedStudioTask(task);
      const settings = snapshot.sharedLive !== undefined && frozenChannel
        ? await resolveImageGenerationChannelSnapshot(frozenChannel, prisma, false, task.model)
        : await getImageGenerationSettingsForModel(task.model);
      if (!isStudioImageGenerationProvider(settings.provider) || !isImageGenerationApiReady(settings)) throw new Error('图片专用 API 暂不可用');
      if (snapshot.ratioContractVersion === 2 && (typeof snapshot.resolvedAspectRatio !== 'string' || snapshot.resolvedAspectRatio === 'auto')) {
        throw new Error('图片任务缺少冻结的实际比例；未向供应商提交');
      }
      if (task.billing_scope && imageBillingScope(settings) !== task.billing_scope) throw new Error('提交时的图片通道已变化，请核对原任务');
      const images = [];
      const owners: Record<string, string> = snapshot.authorizedReferenceOwners || {};
      for (const id of JSON.parse(task.reference_ids) as string[]) {
        const asset = await prisma.asset.findFirst({ where: { id, owner_id: owners[id] || task.owner_id, status: 'active', type: 'image' } });
        if (!asset) throw new Error('参考图已不可用');
        images.push({ bytes: await normalizeStudioImage(await readStudioImage(asset.original_url, taskSignal)), mimeType: 'image/png' });
      }
      await assertLease();
      await assertStudioPostAuthorization(task);
      stage = 'provider'; providerStarted = true;
      await beginStudioRequest(task);
      await assertLease();
      await assertStudioPostAuthorization(task);
      const result = await generate({ baseUrl: settings.base_url, apiKey: settings.api_key!, model: task.model,
        provider: settings.provider === 'ai_media_vip' ? 'ai_media_vip' : 'musk',
        prompt: task.prompt.trim() ? `${task.context}\n\n---\n本次画面要求：\n${task.prompt}` : task.context,
        count: 1, images, size: task.output_size || undefined,
        ratio: snapshot.ratioContractVersion === 2 ? snapshot.resolvedAspectRatio : task.aspect_ratio, quality: task.quality,
        ...(snapshot.ratioContractVersion === 2 ? { ratioContractVersion: 2 as const } : {}),
        signal: AbortSignal.any([taskSignal, AbortSignal.timeout(300000)]), downloadSignal: taskSignal,
        recordResponse: response => recordStudioResponse(task, response),
        persistBase64Image: async (value, outputUsage) => { await assertLease(); delivery = await createStudioBase64Delivery(task, value, outputUsage); },
        deliverRemoteImage: async (url, outputUsage) => {
          await assertLease(); delivery = await createStudioDelivery(task, url, outputUsage);
          return download(delivery);
        } });
      // Gemini keeps its existing endpoint/parameters, but shares durable local output storage.
      if (!delivery) { await assertLease(); delivery = await createStudioBase64Delivery(task, result.images[0], result.usage); }
      original = await download(delivery); usage = result.usage;
    }
    stage = 'normalize'; await assertLease();
    if (delivery) await updateStudioDelivery(delivery, { phase: 'validate' });
    const exactSize = task.output_size && /^\d+x\d+$/.test(task.output_size) ? task.output_size : undefined;
    const { png, validation } = await validateGeneratedStudioImage(original, { size: exactSize, format: exactSize ? 'png' : undefined },
      async value => { if (delivery) await updateStudioDelivery(delivery, { validation: value }); });
    stage = 'save'; await assertLease();
    if (delivery) await updateStudioDelivery(delivery, { phase: 'save', validation });
    const preparedAsset = await prepareStudioOutput(png, task, validation, assertLease);
    stage = 'settle'; await assertLease();
    const deliveryStatus = await studioDeliveryStatus(task);
    const finished = await finishStudioTask(task, 'succeeded', { preparedAsset,
      usage: { ...(usage && typeof usage === 'object' ? usage : {}), studioDelivery: {
        requestId: deliveryStatus.requestId, upstreamRequestId: deliveryStatus.upstreamRequestId, validation,
        responseStatus: deliveryStatus.responseStatus, returnedAt: deliveryStatus.returnedAt } } });
    if (finished) {
      await discardStudioDelivery(task);
      await completeToolFlowTask(task.id);
    }
  } catch (error) {
    if (!delivery && providerStarted) delivery = await readStudioDelivery(task).catch(() => null) || undefined;
    const detail = error instanceof StudioProviderError ? error : null;
    const downloadError = error instanceof StudioImageDownloadError ? error : null;
    const mediaError = error instanceof StudioImageDeliveryError ? error : null;
    const code = detail?.code || downloadError?.code || mediaError?.code || 'processing_failed';
    console.error('[image-studio]', JSON.stringify({ taskId: task.id, stage: detail?.stage || stage, code, imageBytes: mediaError?.bytes,
      model: task.model, outputSize: task.output_size, httpStatus: detail?.status || downloadError?.status,
      download: detail?.diagnostics || downloadError?.diagnostics, elapsedMs: Date.now() - started }));
    if (code === 'delivery_lease_lost') return;
    if (delivery && studioDeliveryCanRetry(delivery) && (taskSignal.aborted || detail?.retryable || downloadError?.retryable || ['save', 'settle'].includes(stage))) {
      await updateStudioDelivery(delivery, { phase: 'recover', code });
      await prisma.imageStudioTask.updateMany({ where: { id: task.id, status: 'running', lease_token: task.lease_token, lease_until: { gt: new Date() } },
        data: { lease_until: new Date(Date.now() + 30_000), error: '原图下载或保存暂时中断，正在恢复同一张图片，不会再次请求生成。' } });
      return;
    }
    if (delivery) await updateStudioDelivery(delivery, { phase: 'stopped', code });
    const finished = await finishStudioTask(task, providerStarted ? 'uncertain' : 'failed', { error: providerStarted
      ? delivery ? mediaError
        ? `${mediaError.code === 'generated_dimensions_mismatch' ? '原图尺寸与请求不符' : mediaError.code === 'generated_format_mismatch' ? '上游原图不是要求的 PNG 格式' : '原图未通过完整图片校验'}，未交付资产；冻结积分已释放。检查点暂留供管理员协查，不会自动重新生成。`
        : '原图下载或保存已停止，冻结积分已释放。恢复资料暂留供管理员协查；已退款任务不能自动领取或重新扣费。'
      : '生成结果待确认，冻结积分已释放。请查询本站记录或联系管理员协查；不会自动再次请求生成。'
      : '参考图或图片服务暂不可用，冻结积分已释放。' });
    if (finished) await completeToolFlowTask(task.id);
  }
}

async function retainChannelTask(task: ImageStudioTask, message: string, delayMs = 60_000) {
  await prisma.imageStudioTask.updateMany({
    where: { id: task.id, status: 'channel_running', lease_token: task.lease_token, lease_until: { gt: new Date() } },
    data: { lease_until: new Date(Date.now() + delayMs), error: message },
  });
}

async function executeChannelStudioTask(task: ImageStudioTask, generate: typeof requestStudioImages,
  recovery?: StudioDelivery, resumeReceipt?: StudioAsyncReceipt) {
  let providerStarted = Boolean(recovery || resumeReceipt);
  let delivery = recovery;
  let asyncReceipt = resumeReceipt;
  let original: Buffer | undefined;
  let preparedRequest = false;
  let stage = 'prepare';
  const started = Date.now();
  const taskSignal = AbortSignal.timeout(STUDIO_EXECUTION_MS);
  const assertLease = async () => {
    taskSignal.throwIfAborted();
    const held = await prisma.imageStudioTask.findFirst({ where: { id: task.id, status: 'channel_running',
      lease_token: task.lease_token, lease_until: { gt: new Date() } }, select: { id: true } });
    if (!held) throw new StudioImageDownloadError('delivery_lease_lost');
  };
  const download = (record: StudioDelivery) => downloadStudioDelivery(record, taskSignal, undefined, undefined, assertLease);
  try {
    const owner = await prisma.user.findUnique({ where: { id: task.owner_id }, select: { status: true } });
    if (owner?.status !== 'active') throw new Error('当前账号无法生成');
    let usage: unknown;
    // A valid same-result local checkpoint is always consumed before querying
    // the provider again. Expired checkpoints may be replaced only by GET of
    // the stored async task id, never by a new generation POST.
    if (delivery && (delivery.complete || studioDeliveryCanRetry(delivery))) {
      stage = 'download';
      await assertLease();
      if (!delivery.complete) await updateStudioDelivery(delivery, { recoveries: (delivery.recoveries || 0) + 1 });
      original = await download(delivery); usage = delivery.usage;
    } else {
      if (delivery && asyncReceipt) {
        await resetStudioAsyncDelivery(task, asyncReceipt.providerTaskId);
        delivery = undefined;
      } else if (delivery) {
        throw new StudioImageDownloadError('download_recovery_limit');
      }

      let snapshot: Record<string, unknown>;
      try { snapshot = JSON.parse(task.snapshot_json || '{}') as Record<string, unknown>; }
      catch { throw new Error('图片通道任务快照无效'); }
      const imageChannel = safeImageChannelSnapshot(snapshot.imageChannel);
      if (!imageChannel || imageChannel.channelId === 'original') throw new Error('图片通道任务缺少固定配置版本');
      const resuming = Boolean(asyncReceipt);
      let settings: ImageGenerationResolvedSettings | null = null;
      let capability: ImageGenerationResolvedSettings['modelCapabilities'][keyof ImageGenerationResolvedSettings['modelCapabilities']] | undefined;

      if (resuming) {
        // Historical, frozen credentials are intentionally used only for the
        // same provider task GET, even if the live channel is disabled or rotated.
        settings = await resolveImageGenerationChannelSnapshot(imageChannel, prisma, false, task.model);
        capability = settings.modelCapabilities[task.model as keyof typeof settings.modelCapabilities];
        if (!settings.api_key || !settings.base_url || !capability?.enabled || !capability.protocol) {
          throw new Error('原任务查询配置不可用；已保留回执，不会重新生成');
        }
      } else {
        const requestReceipt = await readStudioRequestReceipt(task);
        if (requestReceipt && requestReceipt.dispatchState !== 'held') {
          const finished = await finishStudioTask(task, 'uncertain', { error: '已有上游请求记录但没有可安全重试的原图或异步编号；预留保持不变，请管理员按原任务编号核对。' });
          if (finished) await completeToolFlowTask(task.id);
          return;
        }
        // Submission already checked the live revision. Queued work retains
        // that immutable version even if an administrator later edits/deletes it.
        settings = await resolveImageGenerationChannelSnapshot(imageChannel, prisma, false, task.model);
        await assertImageGenerationChannelDispatchOpen(imageChannel);
        const validation = validateImageGenerationChannel(settings, { model: task.model, quality: task.quality,
          resolution: typeof snapshot.resolution === 'string' ? snapshot.resolution : undefined,
          ratio: task.aspect_ratio || undefined, referenceCount: JSON.parse(task.reference_ids).length }, snapshot.ratioContractVersion !== 2);
        if (!validation.ok) throw new Error(validation.error);
        capability = validation.capability;
        if (!settings.api_key || !settings.base_url || !capability.protocol) throw new Error('图片通道接口暂不可用');
        const scope = imageBillingScope(settings);
        if (scope !== task.billing_scope) throw new Error('提交时的图片通道账单范围已变化，未向供应商提交');
        if (task.billing_mode === 'actual') {
          const contract = parseImageBillingContract(task.billing_contract_json);
          if (!contract || contract.mode !== 'actual' || contract.scope !== scope || contract.model !== task.model
            || contract.authorizedCredits !== task.unit_credits || capability.billingMode !== 'actual'
            || !capability.actualQuoteRequired || !isMuskImageGenerationChannel(settings)
            || new URL(settings.base_url).origin !== 'https://api.muskapis.com'
            || !(await imageBillingReady(scope, task.model)).ready) {
            throw new Error('图片通道实际计费授权或同范围账单证明已停止，未向供应商提交');
          }
        } else if (capability.billingMode !== 'fixed' || capability.fixedPoints !== task.unit_credits) {
          throw new Error('图片通道固定点数已变化，未向供应商提交');
        }
        const standardRatioContract = snapshot.ratioContractVersion === 2;
        const allowFourToOne = imageGenerationSupportsStudioFourToOne(settings, task.model, !standardRatioContract);
        if (standardRatioContract && (typeof snapshot.resolvedAspectRatio !== 'string' || snapshot.resolvedAspectRatio === 'auto')) {
          throw new Error('图片任务缺少冻结的实际比例；未向供应商提交');
        }
        const images = [];
        const owners = (snapshot.authorizedReferenceOwners || {}) as Record<string, string>;
        for (const id of JSON.parse(task.reference_ids) as string[]) {
          const asset = await prisma.asset.findFirst({ where: { id, owner_id: owners[id] || task.owner_id, status: 'active', type: 'image' } });
          if (!asset) throw new Error('参考图已不可用');
          images.push({ bytes: await normalizeStudioImage(await readStudioImage(asset.original_url, taskSignal)), mimeType: 'image/png' });
        }
        await assertLease();
        await assertStudioPostAuthorization(task);
        stage = 'provider';
        await beginStudioRequest(task);
        preparedRequest = true;
        await assertLease();
        await assertStudioPostAuthorization(task);
        await assertImageGenerationChannelDispatchOpen(imageChannel);
        await setStudioUnsentRequestState(task, 'attempted');
        preparedRequest = false;
        providerStarted = true;
        const result = await generate({ baseUrl: settings.base_url, apiKey: settings.api_key, model: task.model,
          upstreamModel: capability.upstreamModel,
          provider: settings.provider === 'ai_media_vip' ? 'ai_media_vip' : 'musk', protocol: capability.protocol,
          idempotencyKey: task.id, prompt: task.prompt.trim() ? `${task.context}\n\n---\n本次画面要求：\n${task.prompt}` : task.context,
          count: 1, images, size: task.output_size || undefined,
          ratio: standardRatioContract ? snapshot.resolvedAspectRatio as string
            : allowFourToOne && snapshot.resolvedAspectRatio === '4:1' ? '4:1' : task.aspect_ratio, quality: task.quality,
          allowFourToOne,
          ...(standardRatioContract ? { ratioContractVersion: 2 as const } : {}),
          signal: AbortSignal.any([taskSignal, AbortSignal.timeout(300000)]), downloadSignal: taskSignal,
          recordResponse: response => recordStudioResponse(task, response),
          recordResponseEvidence: capability.protocol === 'gemini_native' && ['gemini-nano-banana-2.1', 'gemini-3-pro-image-preview'].includes(task.model)
            ? async (diagnostic, candidates) => {
              try {
                const receipt = await readStudioRequestReceipt(task);
                if (!receipt) throw new StudioImageDownloadError('response_evidence_identity_unavailable');
                await recordStudioResponseEvidence(task, receipt, diagnostic, candidates);
              }
              catch {
                console.error('[image-response-evidence]', JSON.stringify({ taskId: task.id, code: 'capture_unavailable' }));
                throw new StudioImageDownloadError('response_evidence_unavailable');
              }
            } : undefined,
          onAsyncAccepted: async receipt => { asyncReceipt = await createStudioAsyncReceipt(task, receipt); },
          persistBase64Image: async (value, outputUsage) => { await assertLease(); delivery = await createStudioBase64Delivery(task, value, outputUsage); },
          deliverRemoteImage: async (url, outputUsage) => {
            await assertLease(); delivery = await createStudioDelivery(task, url, outputUsage);
            return download(delivery);
          } });
        if (!delivery) { await assertLease(); delivery = await createStudioBase64Delivery(task, result.images[0], result.usage); }
        if (asyncReceipt) await updateStudioAsyncReceipt(asyncReceipt, { state: 'success' });
        original = await download(delivery); usage = result.usage;
      }

      if (!settings || !capability) throw new Error('图片通道型号配置缺失；原任务已保留');
      if (resuming) {
        stage = 'provider';
        providerStarted = true;
        const result = await generate({ baseUrl: settings.base_url, apiKey: settings.api_key!, model: task.model,
          upstreamModel: capability.upstreamModel,
          provider: settings.provider === 'ai_media_vip' ? 'ai_media_vip' : 'musk', protocol: capability!.protocol,
          idempotencyKey: task.id, resumeAsync: { taskId: asyncReceipt!.providerTaskId,
            pollAfterMs: asyncReceipt!.pollAfterMs, expiresAt: asyncReceipt!.expiresAt },
          prompt: '', count: 1, images: [], signal: AbortSignal.any([taskSignal, AbortSignal.timeout(300000)]),
          downloadSignal: taskSignal,
          persistBase64Image: async (value, outputUsage) => { await assertLease(); delivery = await createStudioBase64Delivery(task, value, outputUsage); },
          deliverRemoteImage: async (url, outputUsage) => {
            await assertLease(); delivery = await createStudioDelivery(task, url, outputUsage);
            return download(delivery);
          } });
        if (!delivery) { await assertLease(); delivery = await createStudioBase64Delivery(task, result.images[0], result.usage); }
        await updateStudioAsyncReceipt(asyncReceipt!, { state: 'success' });
        original = await download(delivery); usage = result.usage;
      }
    }

    if (!original) throw new Error('原图片尚未获取，未交付资产');
    stage = 'normalize'; await assertLease();
    if (delivery) await updateStudioDelivery(delivery, { phase: 'validate' });
    const exactSize = task.output_size && /^\d+x\d+$/.test(task.output_size) ? task.output_size : undefined;
    const { png, validation } = await validateGeneratedStudioImage(original, { size: exactSize, format: exactSize ? 'png' : undefined },
      async value => { if (delivery) await updateStudioDelivery(delivery, { validation: value }); });
    stage = 'save'; await assertLease();
    if (delivery) await updateStudioDelivery(delivery, { phase: 'save', validation });
    const preparedAsset = await prepareStudioOutput(png, task, validation, assertLease);
    stage = 'settle'; await assertLease();
    const deliveryStatus = await studioDeliveryStatus(task);
    const finished = await finishStudioTask(task, 'succeeded', { preparedAsset,
      usage: { ...(usage && typeof usage === 'object' ? usage : {}), studioDelivery: {
        requestId: deliveryStatus.requestId, upstreamRequestId: deliveryStatus.upstreamRequestId, validation,
        responseStatus: deliveryStatus.responseStatus, returnedAt: deliveryStatus.returnedAt } } });
    if (finished) {
      await discardStudioDelivery(task);
      await completeToolFlowTask(task.id);
    }
  } catch (error) {
    if (error instanceof ImageGenerationChannelError && error.code === 'image_channel_dispatch_paused' && !providerStarted) {
      if (preparedRequest) await setStudioUnsentRequestState(task, 'held');
      await prisma.imageStudioTask.updateMany({ where: { id: task.id, status: 'channel_running', lease_token: task.lease_token },
        data: { status: 'channel_queued', lease_token: null, lease_until: null, error: error.message } });
      return;
    }
    if (!delivery && providerStarted) delivery = await readStudioDelivery(task).catch(() => null) || undefined;
    const detail = error instanceof StudioProviderError ? error : null;
    const downloadError = error instanceof StudioImageDownloadError ? error : null;
    const mediaError = error instanceof StudioImageDeliveryError ? error : null;
    const code = detail?.code || downloadError?.code || mediaError?.code || 'processing_failed';
    console.error('[image-studio-channel]', JSON.stringify({ taskId: task.id, stage: detail?.stage || stage, code,
      imageBytes: mediaError?.bytes, model: task.model, outputSize: task.output_size,
      httpStatus: detail?.status || downloadError?.status, download: detail?.diagnostics || downloadError?.diagnostics,
      elapsedMs: Date.now() - started }));
    if (code === 'delivery_lease_lost') return;
    if (mediaError?.code === 'generated_dimensions_mismatch' && original) {
      const finished = await finishRejectedStudioDimensions(task, original);
      if (finished) {
        if (delivery) await updateStudioDelivery(delivery, { phase: 'stopped', code });
        await completeToolFlowTask(task.id);
      }
      return;
    }
    if (code === 'async_failed' && asyncReceipt) {
      await updateStudioAsyncReceipt(asyncReceipt, { state: 'failed' });
      const finished = await finishStudioTask(task, 'failed', { error: '原异步图片任务已明确失败，未重新生成；预留已按原合同处理。' });
      if (finished) await completeToolFlowTask(task.id);
      return;
    }
    if (code === 'async_task_identity_conflict' && asyncReceipt) {
      const finished = await finishStudioTask(task, 'uncertain', { error: '供应商返回的任务编号与原回执不一致；原任务和费用预留已保留，停止自动查询和重提。请管理员核对。' });
      if (finished) await completeToolFlowTask(task.id);
      return;
    }
    if (asyncReceipt) {
      const retryLocal = delivery && studioDeliveryCanRetry(delivery)
        && (taskSignal.aborted || detail?.retryable || downloadError?.retryable || ['save', 'settle'].includes(stage));
      if (delivery && !retryLocal) {
        await resetStudioAsyncDelivery(task, asyncReceipt.providerTaskId);
        delivery = undefined;
      } else if (delivery && retryLocal) {
        await updateStudioDelivery(delivery, { phase: 'recover', code });
      }
      const delay = Math.max(30_000, Math.min(5 * 60_000, asyncReceipt.pollAfterMs * 4));
      const waitingStatus = code === 'async_pending' ? 'pending' : code === 'async_query_unconfirmed' ? 'unconfirmed' : 'retrying';
      await updateStudioAsyncReceipt(asyncReceipt, { state: 'accepted', waitingStatus });
      await retainChannelTask(task, waitingStatus === 'pending' ? '图片任务已受理，仍在生成，完成后自动显示。'
        : waitingStatus === 'unconfirmed' ? '供应商状态暂未确认，正在查询原任务，不会重新生成。'
        : '状态暂未更新，正在重新连接原任务，不会重复提交生成。', delay);
      return;
    }
    if (delivery && studioDeliveryCanRetry(delivery)
      && (taskSignal.aborted || detail?.retryable || downloadError?.retryable || ['save', 'settle'].includes(stage))) {
      await updateStudioDelivery(delivery, { phase: 'recover', code });
      await retainChannelTask(task, '原图下载或保存暂时中断，正在恢复同一张图片，不会再次请求生成。', 30_000);
      return;
    }
    if (delivery) await updateStudioDelivery(delivery, { phase: 'stopped', code });
    const requestReceipt = providerStarted ? await readStudioRequestReceipt(task).catch(() => null) : null;
    const uncertain = providerStarted && (Boolean(requestReceipt) || code !== 'processing_failed');
    const finished = await finishStudioTask(task, uncertain ? 'uncertain' : 'failed', { error: uncertain
      ? '图片结果待核对；原任务与费用预留已保留，不会自动重新提交。请管理员按原任务编号核对。'
      : '参考图或图片服务暂不可用，冻结积分已释放。' });
    if (finished) await completeToolFlowTask(task.id);
  }
}

export async function recoverStudioTasks() {
  await cleanupStudioDeliveries();
  const expired = await prisma.imageStudioTask.findMany({ where: { status: { in: ['running', 'channel_running'] }, lease_until: { lt: new Date() } },
    orderBy: { created_at: 'asc' }, take: 1 });
  for (const task of expired) {
    const channel = task.status === 'channel_running';
    const token = randomUUID();
    const claimed = await prisma.imageStudioTask.updateMany({ where: { id: task.id, status: task.status, lease_token: task.lease_token, lease_until: { lt: new Date() } },
      data: { lease_token: token, lease_until: new Date(Date.now() + 10 * 60_000) } });
    if (!claimed.count) continue;
    const owned = { ...task, lease_token: token };
    const recovery = await readStudioDelivery(owned).catch(() => null);
    if (channel) {
      const receipt = await readStudioAsyncReceipt(owned).catch(() => null);
      await executeChannelStudioTask(owned, requestStudioImages, recovery || undefined, receipt || undefined);
    } else if (recovery) await executeStudioTask(owned, requestStudioImages, recovery);
    else {
      // A request marker without durable output means unknown, not permission to POST again.
      const finished = await finishStudioTask(owned, 'uncertain', { error: '生成结果待确认，没有可用的原图恢复信息，冻结积分已释放；请联系管理员协查，不会自动重复生成。' });
      if (finished) await completeToolFlowTask(task.id);
    }
  }
}
