import { prisma } from '@/lib/prisma';
import { getImageGenerationApiSettings, isImageGenerationApiReady, isStudioImageGenerationProvider } from '@/lib/integrations/image-generation';
import { uploadAsset } from '@/lib/assets/storage';
import { claimStudioTask, finishStudioTask } from './tasks';
import { requestStudioImages, StudioProviderError } from './provider';
import { normalizeStudioImage, readStudioImage } from './media';

export async function processStudioTask(generate: typeof requestStudioImages = requestStudioImages) {
  const task = await claimStudioTask();
  if (!task) return false;
  let providerStarted = false;
  let stage = 'prepare';
  const started = Date.now();
  try {
    const owner = await prisma.user.findUnique({ where: { id: task.owner_id }, select: { status: true } });
    if (owner?.status !== 'active') throw new Error('当前账号无法生成');
    const settings = await getImageGenerationApiSettings();
    if (!isStudioImageGenerationProvider(settings.provider) || !isImageGenerationApiReady(settings)) throw new Error('图片专用 API 暂不可用');
    const images = [];
    for (const id of JSON.parse(task.reference_ids) as string[]) {
      const asset = await prisma.asset.findFirst({ where: { id, owner_id: task.owner_id, status: 'active', type: 'image' } });
      if (!asset) throw new Error('参考图已不可用');
      images.push({ bytes: await normalizeStudioImage(await readStudioImage(asset.original_url)), mimeType: 'image/png' });
    }
    providerStarted = true;
    stage = 'provider';
    const result = await generate({ baseUrl: settings.base_url, apiKey: settings.api_key!, model: task.model,
      provider: settings.provider === 'ai_media_vip' ? 'ai_media_vip' : 'musk',
      prompt: task.prompt.trim() ? `${task.context}\n\n---\n本次画面要求：\n${task.prompt}` : task.context,
      count: 1, images, size: task.output_size || undefined, quality: task.quality, signal: AbortSignal.timeout(300000) });
    stage = 'normalize';
    if (result.images[0].length > 28 * 1024 * 1024) throw new Error('生成图片过大');
    const bytes = await normalizeStudioImage(Buffer.from(result.images[0], 'base64'));
    stage = 'save';
    const asset = await uploadAsset(bytes, `image-${task.id}.png`, 'image/png', task.owner_id);
    stage = 'settle';
    await finishStudioTask(task, 'succeeded', { assetId: asset.assetId, usage: result.usage });
  } catch (error) {
    const detail = error instanceof StudioProviderError ? error : null;
    console.error('[image-studio]', JSON.stringify({ taskId: task.id, stage: detail?.stage || stage,
      code: detail?.code || 'processing_failed', httpStatus: detail?.status, elapsedMs: Date.now() - started }));
    const deliveryFailed = detail?.stage === 'download' || ['normalize', 'save', 'settle'].includes(stage);
    await finishStudioTask(task, providerStarted ? 'uncertain' : 'failed', { error: providerStarted
      ? deliveryFailed
        ? '图片服务已返回结果，但图片保存失败，冻结积分已释放。请联系管理员；重新生成会再次请求上游。'
        : '本次未能交付图片，冻结积分已释放。上游结果未确认，重试会新建生成任务。'
      : '参考图或图片服务暂不可用，冻结积分已释放。' });
  }
  return true;
}

export async function recoverStudioTasks() {
  const expired = await prisma.imageStudioTask.findMany({ where: { status: 'running', lease_until: { lt: new Date() } }, take: 20 });
  for (const task of expired) await finishStudioTask(task, 'uncertain', { error: '生成连接中断，结果未确认，冻结积分已释放；不会自动重复生成。' });
}
