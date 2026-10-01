import { prisma } from '@/lib/prisma';
import { getImageGenerationSettingsForModel, isImageGenerationApiReady, isStudioImageGenerationProvider } from '@/lib/integrations/image-generation';
import { uploadAsset } from '@/lib/assets/storage';
import { claimStudioTask, finishStudioTask } from './tasks';
import { requestStudioImages, StudioProviderError } from './provider';
import { normalizeStudioImage, normalizeGeneratedStudioImage, readStudioImage, StudioImageDeliveryError } from './media';
import { MAX_STUDIO_GENERATED_BASE64 } from './limits';
import { completeToolFlowTask } from '@/lib/tools/toolflow-runtime';
import { randomUUID } from 'node:crypto';
import type { ImageStudioTask } from '@prisma/client';
import { createStudioDelivery, readStudioDelivery, downloadStudioDelivery, discardStudioDelivery, studioDeliveryCanRetry, cleanupStudioDeliveries, type StudioDelivery } from './delivery';
import { StudioImageDownloadError } from './media';

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
  // Leave settlement time before the existing ten-minute task lease expires.
  const taskSignal = AbortSignal.timeout(480000);
  try {
    const owner = await prisma.user.findUnique({ where: { id: task.owner_id }, select: { status: true } });
    if (owner?.status !== 'active') throw new Error('当前账号无法生成');
    let result: { images: string[]; usage: unknown };
    if (recovery) {
      stage = 'download';
      result = { images: [(await downloadStudioDelivery(recovery, taskSignal)).toString('base64')], usage: recovery.usage };
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
      taskSignal.throwIfAborted();
      providerStarted = true;
      stage = 'provider';
      result = await generate({ baseUrl: settings.base_url, apiKey: settings.api_key!, model: task.model,
        provider: settings.provider === 'ai_media_vip' ? 'ai_media_vip' : 'musk',
        prompt: task.prompt.trim() ? `${task.context}\n\n---\n本次画面要求：\n${task.prompt}` : task.context,
        count: 1, images, size: task.output_size || undefined, ratio: task.aspect_ratio, quality: task.quality,
        signal: AbortSignal.any([taskSignal, AbortSignal.timeout(300000)]), downloadSignal: taskSignal,
        deliverRemoteImage: async (url, usage) => {
          delivery = await createStudioDelivery(task, url, usage);
          return downloadStudioDelivery(delivery, taskSignal);
        } });
    }
    stage = 'normalize';
    if (result.images[0].length > MAX_STUDIO_GENERATED_BASE64) {
      throw new StudioImageDeliveryError('generated_base64_size_limit', result.images[0].length);
    }
    const bytes = await normalizeGeneratedStudioImage(Buffer.from(result.images[0], 'base64'));
    stage = 'save';
    const owned = await prisma.imageStudioTask.updateMany({ where: { id: task.id, status: 'running', lease_token: task.lease_token },
      data: { lease_until: new Date(Date.now() + 10 * 60_000) } });
    if (!owned.count) return;
    const asset = await uploadAsset(bytes, `image-${task.id}.png`, 'image/png', task.owner_id);
    stage = 'settle';
    const finished = await finishStudioTask(task, 'succeeded', { assetId: asset.assetId, usage: result.usage });
    if (finished) {
      await discardStudioDelivery(task).catch(() => {});
      await completeToolFlowTask(task.id);
    }
  } catch (error) {
    const detail = error instanceof StudioProviderError ? error : null;
    const downloadError = error instanceof StudioImageDownloadError ? error : null;
    const mediaError = error instanceof StudioImageDeliveryError ? error : null;
    console.error('[image-studio]', JSON.stringify({ taskId: task.id, stage: detail?.stage || stage,
      code: detail?.code || downloadError?.code || mediaError?.code || 'processing_failed', imageBytes: mediaError?.bytes,
      model: task.model, outputSize: task.output_size,
      httpStatus: detail?.status || downloadError?.status, download: detail?.diagnostics || downloadError?.diagnostics, elapsedMs: Date.now() - started }));
    if (delivery && studioDeliveryCanRetry(delivery) && (detail?.retryable || downloadError?.retryable || ['save', 'settle'].includes(stage))) {
      await prisma.imageStudioTask.updateMany({ where: { id: task.id, status: 'running', lease_token: task.lease_token },
        data: { lease_until: new Date(Date.now() + 30_000), error: '原图下载或保存暂时中断，正在恢复同一张图片，不会再次请求生成。' } });
      return;
    }
    const deliveryFailed = detail?.stage === 'download' || ['normalize', 'save', 'settle'].includes(stage);
    const finished = await finishStudioTask(task, providerStarted ? 'uncertain' : 'failed', { error: providerStarted
      ? detail?.stage === 'download' || downloadError
        ? `原图下载未完成（${detail?.code || downloadError?.code}），已停止自动恢复并释放冻结积分；重新生成会再次请求上游。`
        : deliveryFailed
        ? '图片服务已返回结果，但图片保存失败，冻结积分已释放。请联系管理员；重新生成会再次请求上游。'
        : '本次未能交付图片，冻结积分已释放。上游结果未确认，重试会新建生成任务。'
      : '参考图或图片服务暂不可用，冻结积分已释放。' });
    if (finished) {
      await discardStudioDelivery(task).catch(() => {});
      await completeToolFlowTask(task.id);
    }
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
    if (recovery) {
      // Recovery has no path back to the paid provider request.
      await executeStudioTask(owned, requestStudioImages, recovery);
    } else {
      const finished = await finishStudioTask(owned, 'uncertain', { error: '生成连接中断，没有可用的原图恢复信息，冻结积分已释放；不会自动重复生成。' });
      if (finished) { await discardStudioDelivery(owned).catch(() => {}); await completeToolFlowTask(task.id); }
    }
  }
}
