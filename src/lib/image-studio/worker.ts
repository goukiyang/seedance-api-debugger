import { prisma } from '@/lib/prisma';
import { getImageGenerationSettingsForModel, isImageGenerationApiReady, isStudioImageGenerationProvider } from '@/lib/integrations/image-generation';
import { claimStudioTask, finishStudioTask } from './tasks';
import { requestStudioImages, StudioProviderError } from './provider';
import { normalizeStudioImage, validateGeneratedStudioImage, readStudioImage, StudioImageDeliveryError, StudioImageDownloadError } from './media';
import { STUDIO_EXECUTION_MS } from './limits';
import { completeToolFlowTask } from '@/lib/tools/toolflow-runtime';
import { randomUUID } from 'node:crypto';
import type { ImageStudioTask } from '@prisma/client';
import { beginStudioRequest, recordStudioResponse, createStudioBase64Delivery, createStudioDelivery, readStudioDelivery, downloadStudioDelivery,
  discardStudioDelivery, studioDeliveryCanRetry, studioDeliveryStatus, cleanupStudioDeliveries, updateStudioDelivery, type StudioDelivery } from './delivery';
import { prepareStudioOutput } from './output';

export async function processStudioTask(generate: typeof requestStudioImages = requestStudioImages) {
  const task = await claimStudioTask();
  if (!task) return false;
  await executeStudioTask(task, generate);
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
      const settings = await getImageGenerationSettingsForModel(task.model);
      if (!isStudioImageGenerationProvider(settings.provider) || !isImageGenerationApiReady(settings)) throw new Error('图片专用 API 暂不可用');
      const images = [];
      const snapshot = task.snapshot_json ? JSON.parse(task.snapshot_json) : {};
      const owners: Record<string, string> = snapshot.authorizedReferenceOwners || {};
      for (const id of JSON.parse(task.reference_ids) as string[]) {
        const asset = await prisma.asset.findFirst({ where: { id, owner_id: owners[id] || task.owner_id, status: 'active', type: 'image' } });
        if (!asset) throw new Error('参考图已不可用');
        images.push({ bytes: await normalizeStudioImage(await readStudioImage(asset.original_url, taskSignal)), mimeType: 'image/png' });
      }
      await assertLease();
      stage = 'provider'; providerStarted = true;
      await beginStudioRequest(task);
      await assertLease();
      const result = await generate({ baseUrl: settings.base_url, apiKey: settings.api_key!, model: task.model,
        provider: settings.provider === 'ai_media_vip' ? 'ai_media_vip' : 'musk',
        prompt: task.prompt.trim() ? `${task.context}\n\n---\n本次画面要求：\n${task.prompt}` : task.context,
        count: 1, images, size: task.output_size || undefined, ratio: task.aspect_ratio, quality: task.quality,
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
      await discardStudioDelivery(task).catch(() => {});
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

export async function recoverStudioTasks() {
  await cleanupStudioDeliveries();
  const expired = await prisma.imageStudioTask.findMany({ where: { status: 'running', lease_until: { lt: new Date() } }, take: 1 });
  for (const task of expired) {
    const token = randomUUID();
    const claimed = await prisma.imageStudioTask.updateMany({ where: { id: task.id, status: 'running', lease_token: task.lease_token, lease_until: { lt: new Date() } },
      data: { lease_token: token, lease_until: new Date(Date.now() + 10 * 60_000) } });
    if (!claimed.count) continue;
    const owned = { ...task, lease_token: token };
    const recovery = await readStudioDelivery(owned).catch(() => null);
    if (recovery) await executeStudioTask(owned, requestStudioImages, recovery);
    else {
      // A request marker without durable output means unknown, not permission to POST again.
      const finished = await finishStudioTask(owned, 'uncertain', { error: '生成结果待确认，没有可用的原图恢复信息，冻结积分已释放；请联系管理员协查，不会自动重复生成。' });
      if (finished) await completeToolFlowTask(task.id);
    }
  }
}
