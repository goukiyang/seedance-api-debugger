import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { prisma } from '@/lib/prisma';
import { getSessionUser, errorJson } from '@/lib/auth/api-helpers';
import { calculateEstimatedCost } from '@/lib/pricing';
import { getOrCreateWorkspace } from '@/lib/assets/workspace';
import { validatePromptReferences, renderPromptWithAssets } from '@/lib/assets/collection';
import { createTaskSnapshot } from '@/lib/assets/snapshot';
import { createVideoTask, buildContentArray, isApiKeyConfigured } from '@/lib/provider/jimeng';
import type { CreateVideoInput, GenerationMode, VideoResolution, VideoDuration } from '@/types';

const VALID_GENERATION_MODES: GenerationMode[] = [
  'all_in_one_reference',
  'first_last_frame',
  'smart_multi_frame',
];
const VALID_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
const VALID_DURATIONS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const VALID_RESOLUTIONS = ['480p', '720p'];

export async function POST(request: NextRequest) {
  let user;
  try {
    user = await getSessionUser(request);
  } catch {
    return errorJson('请先登录后再生成视频', 401);
  }

  if (user.status !== 'active') {
    return errorJson('账号已被禁用，无法生成', 403);
  }

  if (!isApiKeyConfigured()) {
    return errorJson('请在环境变量中配置 SEEDANCE_API_KEY', 500);
  }

  const body = await request.json();

  // --- Validation ---
  if (!body.prompt || typeof body.prompt !== 'string' || !body.prompt.trim()) {
    return errorJson('提示词不能为空', 400);
  }

  const generationMode: GenerationMode = body.generation_mode || 'all_in_one_reference';
  if (!VALID_GENERATION_MODES.includes(generationMode)) {
    return errorJson(`generation_mode 必须是 ${VALID_GENERATION_MODES.join(', ')}`, 400);
  }

  const ratio = body.ratio || '16:9';
  const duration: VideoDuration = body.duration || 5;
  const resolution: VideoResolution = body.resolution || '720p';

  if (!VALID_RATIOS.includes(ratio)) return errorJson('ratio 无效', 400);
  if (!VALID_DURATIONS.includes(duration)) return errorJson('duration 必须是 4-15', 400);
  if (!VALID_RESOLUTIONS.includes(resolution)) return errorJson('resolution 无效', 400);

  // --- Pricing ---
  const pricing = calculateEstimatedCost(resolution, duration);
  if (!pricing) {
    return errorJson('当前参数暂无计费规则', 400);
  }
  const estimatedCost = pricing.estimatedCost;

  // --- Idempotency ---
  const idempotencyKey: string | undefined = body.idempotency_key || undefined;
  if (idempotencyKey) {
    const existing = await prisma.videoTask.findUnique({
      where: { user_id_idempotency_key: { user_id: user.id, idempotency_key: idempotencyKey } },
    });
    if (existing) {
      return NextResponse.json({
        id: existing.id,
        status: existing.local_status,
        estimated_cost: existing.estimated_cost,
        frozen_cost: existing.frozen_cost,
        created_at: existing.created_at,
        deduplicated: true,
      });
    }
  }

  // --- Workspace + Reference Image Preparation ---
  const tabId = request.headers.get('x-tab-id') || 'default';
  const { id: workspaceId } = await getOrCreateWorkspace(tabId);

  const { preparedImages, prepareErrors, summary: prepSummary } = await prepareReferenceImages(workspaceId);

  if (prepSummary.total > 0 && preparedImages.length === 0 && prepSummary.skipped > 0) {
    return NextResponse.json(
      { error: 'REFERENCE_IMAGE_NOT_PUBLIC', message: '参考图无法生成公网 URL', details: { errors: prepareErrors } },
      { status: 400 },
    );
  }

  // --- Build mode-specific reference arrays ---
  let referenceImageUrls: string[] = [];
  let firstFrameUrl: string | undefined = body.first_frame_url;
  let lastFrameUrl: string | undefined = body.last_frame_url;
  let frameImageUrls: string[] = body.frame_image_urls ? [...body.frame_image_urls] : [];
  const referenceVideoUrls: string[] = body.reference_video_urls ? [...body.reference_video_urls].slice(0, 3) : [];
  const referenceAudioUrls: string[] = body.reference_audio_urls ? [...body.reference_audio_urls].slice(0, 3) : [];

  switch (generationMode) {
    case 'all_in_one_reference':
      referenceImageUrls = preparedImages.map((img) => img.originalUrl).slice(0, 9);
      break;
    case 'first_last_frame':
      if (!firstFrameUrl) firstFrameUrl = preparedImages[0]?.originalUrl;
      if (!firstFrameUrl) return errorJson('首尾帧模式必须提供首帧图片', 400);
      break;
    case 'smart_multi_frame':
      if (frameImageUrls.length === 0) frameImageUrls = preparedImages.map((img) => img.originalUrl);
      if (frameImageUrls.length < 2) return errorJson('智能多帧模式至少需要 2 张图片', 400);
      break;
  }

  // --- Prompt validation + rendering ---
  const promptValidation = await validatePromptReferences(body.prompt, workspaceId);
  if (!promptValidation.valid) {
    return NextResponse.json(
      { error: 'PROMPT_REFERENCE_ERROR', message: `prompt 中引用的图号不存在: ${promptValidation.missing.join(', ')}` },
      { status: 400 },
    );
  }
  const { promptRendered, assetMapping } = await renderPromptWithAssets(body.prompt, workspaceId, generationMode);

  // --- Build provider input ---
  const seed = body.seed ?? -1;
  const generateAudio = body.generate_audio ?? false;
  const returnLastFrame = body.return_last_frame ?? false;
  const watermark = body.watermark ?? false;

  const providerInput: CreateVideoInput = {
    prompt: promptRendered,
    generation_mode: generationMode,
    ratio: ratio as CreateVideoInput['ratio'],
    duration: duration as CreateVideoInput['duration'],
    resolution: resolution as CreateVideoInput['resolution'],
    seed,
    generate_audio: generateAudio,
    return_last_frame: returnLastFrame,
    watermark,
    reference_image_urls: referenceImageUrls,
    reference_video_urls: referenceVideoUrls,
    reference_audio_urls: referenceAudioUrls,
    first_frame_url: firstFrameUrl,
    last_frame_url: lastFrameUrl,
    frame_image_urls: frameImageUrls,
    callback_url: body.callback_url,
    execution_expires_after: body.execution_expires_after,
  };

  // --- Create snapshot ---
  const content = buildContentArray(providerInput);
  const snapshot = await createTaskSnapshot({
    workspaceId,
    generationMode,
    promptRaw: body.prompt,
    input: providerInput,
    providerPayloadJson: JSON.stringify({ content_item_count: content.length, referenceCount: preparedImages.length }),
  });

  // --- Credit check + freeze + create single VideoTask in ONE transaction ---
  let taskId: string;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const account = await tx.creditAccount.findUnique({ where: { user_id: user.id } });
      if (!account) throw new CreditError('点数账户不存在，请联系管理员', 'NO_ACCOUNT');

      const availableCredits = account.balance - account.frozen_credits;
      if (availableCredits < estimatedCost) {
        throw new CreditError(
          `点数不足，需要 ${estimatedCost} 点，当前可用 ${Math.floor(availableCredits)} 点`,
          'INSUFFICIENT_CREDITS',
        );
      }

      const task = await tx.videoTask.create({
        data: {
          provider: 'seedance',
          model: 'dreamina-seedance-2-0-260128',
          generation_mode: generationMode,
          prompt: body.prompt.trim(),
          ratio,
          duration,
          resolution,
          seed,
          generate_audio: generateAudio,
          return_last_frame: returnLastFrame,
          watermark,
          reference_image_urls: referenceImageUrls.length > 0 ? JSON.stringify(referenceImageUrls) : null,
          reference_video_urls: referenceVideoUrls.length > 0 ? JSON.stringify(referenceVideoUrls) : null,
          reference_audio_urls: referenceAudioUrls.length > 0 ? JSON.stringify(referenceAudioUrls) : null,
          first_frame_url: firstFrameUrl || null,
          last_frame_url: lastFrameUrl || null,
          frame_image_urls: frameImageUrls.length > 0 ? JSON.stringify(frameImageUrls) : null,
          local_status: 'submitted',
          user_id: user.id,
          estimated_cost: estimatedCost,
          frozen_cost: estimatedCost,
          pricing_snapshot: JSON.stringify(pricing),
          pricing_rule_id: pricing.pricingRuleId,
          idempotency_key: idempotencyKey || null,
          workspace_id: workspaceId,
          snapshot_id: snapshot.id,
          params_json: JSON.stringify({
            ratio, duration, resolution, seed,
            generateAudio, returnLastFrame, watermark,
            preparedImages: preparedImages.map((img) => ({ name: img.name, originalUrl: img.originalUrl, sourceType: img.sourceType })),
            prepSummary,
          }),
        },
      });

      const frozenBefore = account.frozen_credits;
      const frozenAfter = frozenBefore + estimatedCost;

      await tx.creditAccount.update({
        where: { user_id: user.id },
        data: { frozen_credits: frozenAfter },
      });

      await tx.creditLedger.create({
        data: {
          user_id: user.id,
          type: 'task_freeze',
          amount: -estimatedCost,
          balance_before: account.balance,
          balance_after: account.balance,
          frozen_before: frozenBefore,
          frozen_after: frozenAfter,
          related_task_id: task.id,
          reason: `任务创建冻结 ${estimatedCost} 点`,
        },
      });

      return task;
    });

    taskId = result.id;
  } catch (err) {
    if (err instanceof CreditError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: 400 });
    }
    throw err;
  }

  // --- Call Seedance provider DIRECTLY (no internal HTTP) ---
  try {
    const providerResult = await createVideoTask(providerInput);

    await prisma.videoTask.update({
      where: { id: taskId },
      data: {
        provider_task_id: providerResult.provider_task_id,
        raw_create_response: JSON.stringify(providerResult.raw),
        local_status: 'submitted',
      },
    });

    return NextResponse.json({
      id: taskId,
      provider_task_id: providerResult.provider_task_id,
      status: 'submitted',
      estimated_cost: estimatedCost,
      frozen_cost: estimatedCost,
      pricing,
      workspace_id: workspaceId,
      snapshot_id: snapshot.id,
      prompt_rendered: promptRendered,
      asset_mapping: assetMapping,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    await handleProviderFailure(
      taskId,
      user.id,
      estimatedCost,
      err instanceof Error ? err.message : 'Seedance 调用异常',
    );
    return NextResponse.json(
      {
        error: 'PROVIDER_CREATE_FAILED',
        message: '视频生成服务异常，已返还冻结点数',
        task_id: taskId,
      },
      { status: 502 },
    );
  }
}

// --- Failure handler: release frozen credits in a single transaction ---
async function handleProviderFailure(
  taskId: string,
  userId: string,
  frozenAmount: number,
  errorMessage: string,
) {
  await prisma.$transaction(async (tx) => {
    await tx.videoTask.update({
      where: { id: taskId },
      data: {
        local_status: 'failed',
        error_message: errorMessage,
        error_code: 'PROVIDER_CREATE_FAILED',
        completed_at: new Date(),
        frozen_cost: 0,
        refund_amount: frozenAmount,
      },
    });

    const account = await tx.creditAccount.findUnique({ where: { user_id: userId } });
    if (!account) return;

    const frozenBefore = account.frozen_credits;
    const frozenAfter = Math.max(0, frozenBefore - frozenAmount);

    await tx.creditAccount.update({
      where: { user_id: userId },
      data: { frozen_credits: frozenAfter },
    });

    await tx.creditLedger.create({
      data: {
        user_id: userId,
        type: 'task_failed_refund',
        amount: frozenAmount,
        balance_before: account.balance,
        balance_after: account.balance,
        frozen_before: frozenBefore,
        frozen_after: frozenAfter,
        related_task_id: taskId,
        reason: `任务创建失败，返还冻结 ${frozenAmount} 点`,
      },
    });
  });
}

// --- Reference image preparation (extracted from /api/video/create) ---
interface PreparedRefImage {
  name: string;
  originalUrl: string;
  sourceType: 'upload' | 'gallery' | 'external';
  order: number;
}

async function prepareReferenceImages(workspaceId: string): Promise<{
  preparedImages: PreparedRefImage[];
  prepareErrors: string[];
  summary: { total: number; publicUrl: number; r2Uploaded: number; skipped: number; hasLocalPath: boolean };
}> {
  const wsAssets = await prisma.workspaceAsset.findMany({
    where: { workspace_id: workspaceId },
    include: { asset: true },
    orderBy: { sort_order: 'asc' },
  });

  const imageAssets = wsAssets.filter((wa) => wa.asset.type === 'image').slice(0, 9);
  const preparedImages: PreparedRefImage[] = [];
  const prepareErrors: string[] = [];
  let publicUrl = 0;
  let r2Uploaded = 0;
  let skipped = 0;
  let hasLocalPath = false;

  for (let i = 0; i < imageAssets.length; i++) {
    const wa = imageAssets[i];
    const asset = wa.asset;
    const originalUrl = asset.original_url;
    const isPublicUrl = originalUrl.startsWith('https://') && !isLocalhostHost(originalUrl);
    const isLocalPath = originalUrl.startsWith('/');

    if (isPublicUrl) {
      publicUrl++;
      const isR2 = originalUrl.includes('.r2.') || originalUrl.includes('r2.dev') || originalUrl.includes('.toscdn.');
      preparedImages.push({ name: asset.file_name || `图${i + 1}`, originalUrl, sourceType: isR2 ? 'upload' : 'external', order: i });
      continue;
    }

    if (isLocalPath) {
      hasLocalPath = true;
      const localFilePath = path.join(process.cwd(), 'public', originalUrl);
      if (!fs.existsSync(localFilePath)) {
        skipped++;
        prepareErrors.push(`[${i + 1}] 本地文件不存在: ${originalUrl}`);
        continue;
      }

      const buffer = fs.readFileSync(localFilePath);
      const ext = path.extname(localFilePath).slice(1).toLowerCase();
      const mimeMap: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
      const mimeType = mimeMap[ext] || 'image/jpeg';

      let r2PublicUrl: string | null = null;
      try {
        const { uploadPublicAsset } = await import('@/lib/assets/public-storage');
        const pubResult = await uploadPublicAsset(buffer, asset.file_name || `image.${ext}`, mimeType);
        r2PublicUrl = pubResult.publicUrl;
      } catch (err) {
        skipped++;
        prepareErrors.push(`[${i + 1}] R2 上传失败: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      try {
        await prisma.asset.update({ where: { id: asset.id }, data: { original_url: r2PublicUrl } });
      } catch { /* non-critical */ }

      r2Uploaded++;
      preparedImages.push({ name: asset.file_name || `图${i + 1}`, originalUrl: r2PublicUrl, sourceType: 'upload', order: i });
      continue;
    }

    skipped++;
    prepareErrors.push(`[${i + 1}] 非公网 URL: ${originalUrl}`);
  }

  return {
    preparedImages,
    prepareErrors,
    summary: { total: imageAssets.length, publicUrl, r2Uploaded, skipped, hasLocalPath },
  };
}

function isLocalhostHost(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname.startsWith('192.168.') || u.hostname.startsWith('10.') || u.hostname.startsWith('172.');
  } catch { return false; }
}

class CreditError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}
