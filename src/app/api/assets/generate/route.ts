import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { AuthError, getSession, type SessionUser } from '@/lib/auth/session';
import {
  createImageGeneration,
  getImageGenerationApiSettings,
  ImageGenerationApiError,
  isImageGenerationApiReady,
} from '@/lib/integrations/image-generation';
import { attachAssetToSiteReferenceImage, ReferenceImportError } from '@/lib/assets/reference-import';
import { getOrCreateWorkspace } from '@/lib/assets/workspace';
import { uploadAsset } from '@/lib/assets/storage';
import { prisma } from '@/lib/prisma';
import { getProjectAccess, getProjectForGeneration } from '@/lib/projects/permissions';
import { assertCanUseReferenceImage, uniquePreserveOrder } from '@/lib/reference-albums/permissions';
import { assertCanGenerateInVideoCard } from '@/lib/video-cards/permissions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const IMAGE_GENERATION_ACTIONS = [
  'text_to_image_reference',
  'image_variant',
  'first_frame_draft',
  'last_frame_draft',
  'storyboard_keyframes',
  'background_image',
  'subject_reference',
  'style_reference',
  'cover_image',
] as const;

type ImageGenerationAction = typeof IMAGE_GENERATION_ACTIONS[number];
type AuthorizedReferenceImage = Awaited<ReturnType<typeof assertCanUseReferenceImage>>;

const DEFAULT_REFERENCE_IMAGE_LIMIT = 9;
const SEEDREAM_REFERENCE_IMAGE_LIMIT = 10;
const REFERENCE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

function cleanString(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeAction(value: unknown): ImageGenerationAction | null {
  const raw = cleanString(value);
  return IMAGE_GENERATION_ACTIONS.includes(raw as ImageGenerationAction)
    ? raw as ImageGenerationAction
    : null;
}

function normalizeInput(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeStringList(value: unknown, limit: number) {
  return uniquePreserveOrder(Array.isArray(value) ? value : []).slice(0, limit);
}

function inputTooLarge(input: Record<string, unknown>) {
  return JSON.stringify(input).length > 12000;
}

function normalizeCount(value: unknown, fallback: number, min: number, max: number) {
  const next = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(next)));
}

function imageGenerationModelLabel(provider: string, model: string) {
  if (provider === 'seedream') return 'Seedream 5.0 Pro';
  if (provider === 'musk') return 'Gemini Image (Musk)';
  return model || provider;
}

function inferMimeFromPath(value: string) {
  const ext = path.extname(value).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

function localUploadPath(url: string) {
  if (!url.startsWith('/uploads/')) return null;
  const publicRoot = path.join(process.cwd(), 'public');
  const uploadsRoot = path.join(publicRoot, 'uploads');
  const filePath = path.normalize(path.join(publicRoot, url.replace(/^\/+/, '')));
  const relativePath = path.relative(uploadsRoot, filePath);
  return relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath) ? filePath : null;
}

function localUploadDataUrl(url: string, mimeType?: string | null) {
  const filePath = localUploadPath(url);
  if (!filePath || !fs.existsSync(filePath)) {
    throw new ImageGenerationApiError('参考图本地文件不存在，无法用于图生图', 400, 'image_generation_reference_image_unavailable');
  }
  const buffer = fs.readFileSync(filePath);
  if (buffer.length === 0) {
    throw new ImageGenerationApiError('参考图文件为空，无法用于图生图', 400, 'image_generation_reference_image_empty');
  }
  if (buffer.length > REFERENCE_IMAGE_MAX_BYTES) {
    throw new ImageGenerationApiError('参考图尺寸过大，请先压缩或换一张图片', 413, 'image_generation_reference_image_too_large');
  }
  const resolvedMimeType = mimeType && mimeType.startsWith('image/') ? mimeType : inferMimeFromPath(filePath);
  return `data:${resolvedMimeType};base64,${buffer.toString('base64')}`;
}

function resolveImageGenerationReferenceInputs(images: AuthorizedReferenceImage[]) {
  const inputs: string[] = [];
  for (const image of images.slice(0, SEEDREAM_REFERENCE_IMAGE_LIMIT)) {
    const source = cleanString(image.asset?.original_url || image.url);
    if (!source) continue;
    if (source.startsWith('data:image/') || source.startsWith('http://') || source.startsWith('https://')) {
      inputs.push(source);
      continue;
    }
    if (source.startsWith('/uploads/')) {
      inputs.push(localUploadDataUrl(source, image.asset?.mime_type));
      continue;
    }
    throw new ImageGenerationApiError('参考图地址不可访问，请换成已入库图片或公网图片', 400, 'image_generation_reference_image_unavailable');
  }
  return inputs;
}

function roleForAction(action: ImageGenerationAction) {
  if (action === 'first_frame_draft') return 'first_frame';
  if (action === 'last_frame_draft') return 'last_frame';
  return 'reference_image';
}

function buildGenerationPrompt(
  body: Record<string, unknown>,
  input: Record<string, unknown>,
  action: ImageGenerationAction,
) {
  const direct = cleanString(
    body.prompt
      || input.prompt
      || input.text
      || input.description
      || input.final_prompt
      || input.finalPrompt,
  );
  if (direct) return direct;

  const parts = [
    cleanString(input.subject),
    cleanString(input.scene),
    cleanString(input.style),
    cleanString(input.camera),
    cleanString(input.requirements),
    cleanString(input.instructions),
  ].filter(Boolean);
  if (parts.length > 0) return parts.join('\n');

  const labelByAction: Record<ImageGenerationAction, string> = {
    text_to_image_reference: '生成一张可用于视频生成的参考图',
    image_variant: '基于参考信息生成一张图片变体',
    first_frame_draft: '生成一张适合视频首帧的图片',
    last_frame_draft: '生成一张适合视频尾帧的图片',
    storyboard_keyframes: '生成一张视频分镜关键帧图片',
    background_image: '生成一张视频背景图',
    subject_reference: '生成一张主体参考图',
    style_reference: '生成一张风格参考图',
    cover_image: '生成一张视频封面图',
  };
  return labelByAction[action];
}

function inferMimeFromDataUrl(value: string) {
  const match = value.match(/^data:(image\/[-+.a-z0-9]+);base64,/i);
  return match?.[1] || null;
}

function decodeBase64Image(raw: string, fallbackMimeType?: string) {
  const trimmed = raw.trim();
  const mimeType = inferMimeFromDataUrl(trimmed) || fallbackMimeType || 'image/png';
  const base64 = trimmed.replace(/^data:image\/[-+.a-z0-9]+;base64,/i, '');
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0) {
    throw new ImageGenerationApiError('图形生成 API 返回的 base64 图片为空', 502, 'image_generation_empty_image');
  }
  return { buffer, mimeType };
}

async function downloadGeneratedImage(output: { url?: string; b64Json?: string; mimeType?: string }) {
  if (output.b64Json) return decodeBase64Image(output.b64Json, output.mimeType);
  if (!output.url) {
    throw new ImageGenerationApiError('图形生成 API 返回的图片缺少 URL 或 base64', 502, 'image_generation_invalid_image');
  }
  if (output.url.startsWith('data:image/')) return decodeBase64Image(output.url, output.mimeType);

  let parsed: URL;
  try {
    parsed = new URL(output.url);
  } catch {
    throw new ImageGenerationApiError('图形生成 API 返回的图片 URL 无效', 502, 'image_generation_invalid_image_url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ImageGenerationApiError('图形生成 API 返回的图片 URL 协议不支持', 502, 'image_generation_invalid_image_url');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(output.url, { signal: controller.signal });
    if (!response.ok) {
      throw new ImageGenerationApiError(`下载生成图片失败 (HTTP ${response.status})`, 502, 'image_generation_download_failed');
    }
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() || output.mimeType || 'image/png';
    if (!contentType.startsWith('image/')) {
      throw new ImageGenerationApiError('图形生成 API 返回的文件不是图片', 502, 'image_generation_non_image_output');
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      throw new ImageGenerationApiError('下载到的生成图片为空', 502, 'image_generation_empty_image');
    }
    if (buffer.length > 30 * 1024 * 1024) {
      throw new ImageGenerationApiError('生成图片超过 30MB，已拒绝入库', 413, 'image_generation_image_too_large');
    }
    return { buffer, mimeType: contentType };
  } catch (error) {
    if (error instanceof ImageGenerationApiError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ImageGenerationApiError('下载生成图片超时', 504, 'image_generation_download_timeout');
    }
    throw new ImageGenerationApiError('下载生成图片失败', 502, 'image_generation_download_failed');
  } finally {
    clearTimeout(timeout);
  }
}

function imageFileName(action: ImageGenerationAction, index: number, mimeType: string) {
  const extByMime: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };
  const ext = extByMime[mimeType] || 'png';
  return `${action}-${Date.now()}-${index + 1}.${ext}`;
}

async function writeGenerationAttemptLog(params: {
  userId: string;
  action: string;
  status: string;
  projectId: string;
  videoCardId: string;
  canvasDocumentId: string | null;
  canvasNodeId: string | null;
  provider: string;
  model: string;
  modelLabel?: string;
  size?: string;
  outputFormat?: string;
  responseFormat?: string;
  referenceImageCount?: number;
  error?: string;
  workspaceId?: string;
  assetIds?: string[];
  referenceImageIds?: string[];
}) {
  await prisma.operationLog.create({
    data: {
      operator_id: params.userId,
      action: 'image_generation_generate_attempt',
      target_type: 'ImageGeneration',
      target_id: null,
      detail: JSON.stringify({
        action: params.action,
        status: params.status,
        project_id: params.projectId,
        video_card_id: params.videoCardId,
        canvas_document_id: params.canvasDocumentId,
        canvas_node_id: params.canvasNodeId,
        provider: params.provider,
        model: params.model,
        model_label: params.modelLabel || imageGenerationModelLabel(params.provider, params.model),
        size: params.size || null,
        output_format: params.outputFormat || null,
        response_format: params.responseFormat || null,
        reference_image_count: params.referenceImageCount ?? params.referenceImageIds?.length ?? 0,
        error: params.error || null,
        workspace_id: params.workspaceId || null,
        asset_ids: params.assetIds || [],
        reference_image_ids: params.referenceImageIds || [],
      }),
    },
  });
}

async function assertCanAttachCanvasContext(user: SessionUser, canvasDocumentId: string) {
  const canvas = await prisma.canvasDocument.findUnique({
    where: { id: canvasDocumentId },
    select: {
      id: true,
      owner_user_id: true,
      project_id: true,
      status: true,
    },
  });

  if (!canvas || canvas.status === 'deleted') {
    throw new AuthError('画布不存在', 404);
  }

  if (user.role === 'admin' || canvas.owner_user_id === user.id) {
    return canvas;
  }

  if (!canvas.project_id) {
    throw new AuthError('无权编辑此画布', 403);
  }

  const projectAccess = await getProjectAccess(user, canvas.project_id);
  if (projectAccess.role !== 'project_owner' && projectAccess.role !== 'editor') {
    throw new AuthError('无权编辑此画布', 403);
  }

  return canvas;
}

export async function POST(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  try {
    const body = await request.json() as Record<string, unknown>;
    const action = normalizeAction(body.action);
    if (!action) return NextResponse.json({ error: '图形生成 action 无效' }, { status: 400 });

    const videoCardId = cleanString(body.video_card_id || body.videoCardId);
    if (!videoCardId) return NextResponse.json({ error: '必须先选择视频卡，图形生成结果才能进入统一项目资产链路' }, { status: 400 });

    const videoCard = await prisma.videoCard.findUnique({
      where: { id: videoCardId },
      select: { id: true, project_id: true },
    });
    if (!videoCard) return NextResponse.json({ error: '视频卡不存在' }, { status: 404 });

    const requestedProjectId = cleanString(body.project_id) || videoCard.project_id;
    const project = await getProjectForGeneration(user, requestedProjectId);
    await assertCanGenerateInVideoCard(user, project.id, videoCard.id);

    const canvasDocumentId = cleanString(body.canvas_document_id || body.canvasDocumentId) || null;
    const canvasNodeId = cleanString(body.canvas_node_id || body.canvasNodeId) || null;
    if (canvasDocumentId) {
      const canvas = await assertCanAttachCanvasContext(user, canvasDocumentId);
      if (canvas.project_id && canvas.project_id !== project.id) {
        return NextResponse.json({ error: '画布不属于当前项目' }, { status: 400 });
      }
    }

    const input = normalizeInput(body.input);
    if (inputTooLarge(input)) {
      return NextResponse.json({ error: '图形生成输入过长，请减少节点、参考图或提示词内容' }, { status: 400 });
    }

    const settings = await getImageGenerationApiSettings();
    const modelLabel = imageGenerationModelLabel(settings.provider, settings.default_model);
    const referenceLimit = settings.provider === 'seedream'
      ? SEEDREAM_REFERENCE_IMAGE_LIMIT
      : DEFAULT_REFERENCE_IMAGE_LIMIT;
    const referenceImageIds = normalizeStringList(input.reference_image_ids || input.referenceImageIds, referenceLimit);
    const referenceImages: AuthorizedReferenceImage[] = [];
    for (const referenceImageId of referenceImageIds) {
      referenceImages.push(await assertCanUseReferenceImage(user, referenceImageId));
    }
    const referenceInputs = settings.provider === 'seedream'
      ? resolveImageGenerationReferenceInputs(referenceImages)
      : [];

    if (!isImageGenerationApiReady(settings)) {
      await writeGenerationAttemptLog({
        userId: user.id,
        action,
        status: 'failed',
        projectId: project.id,
        videoCardId: videoCard.id,
        canvasDocumentId,
        canvasNodeId,
        provider: settings.provider,
        model: settings.default_model,
        modelLabel,
        referenceImageCount: referenceImageIds.length,
        error: 'image_generation_api_not_configured',
      });
      return NextResponse.json({
        error: 'image_generation_api_not_configured',
        message: '图形生成 API 未启用或缺少配置，请先到后台 API 设置保存 API 地址、模型和 API Key。',
      }, { status: 503 });
    }

    const prompt = buildGenerationPrompt(body, input, action);
    if (!prompt) return NextResponse.json({ error: '图形生成提示词不能为空' }, { status: 400 });

    const count = normalizeCount(
      input.count ?? input.output_count ?? input.outputCount,
      1,
      1,
      settings.max_outputs_per_request,
    );
    const ratio = cleanString(input.ratio || body.ratio, settings.default_ratio);
    const imageSize = cleanString(input.size || input.default_size || input.resolution || body.size, settings.default_size);
    const explicitWorkspaceId = cleanString(body.workspace_id || body.workspaceId);
    let workspaceId = explicitWorkspaceId;
    if (workspaceId) {
      const workspace = await prisma.workspace.findFirst({
        where: { id: workspaceId, owner_id: user.id, status: 'active' },
        select: { id: true },
      });
      if (!workspace) return NextResponse.json({ error: '当前工作区不存在或无权使用' }, { status: 404 });
    } else {
      const tabId = cleanString(body.tab_id || body.tabId || request.headers.get('x-tab-id'), 'default');
      workspaceId = (await getOrCreateWorkspace(tabId, user.id)).id;
    }

    const providerResult = await createImageGeneration({
      settings,
      prompt,
      ratio,
      size: imageSize,
      count,
      referenceImages: referenceInputs,
    });
    const generatedAssets: Array<{
      assetId: string;
      referenceImageId: string;
      workspaceAssetId: string;
      originalUrl: string;
      thumbnailUrl: string | null;
      fileName: string;
      width?: number;
      height?: number;
      mimeType: string;
      revisedPrompt?: string;
    }> = [];
    const role = roleForAction(action);

    for (let index = 0; index < providerResult.images.length; index += 1) {
      const image = providerResult.images[index];
      const downloaded = await downloadGeneratedImage(image);
      const asset = await uploadAsset(
        downloaded.buffer,
        imageFileName(action, index, downloaded.mimeType),
        downloaded.mimeType,
        user.id,
      );
      const reference = await attachAssetToSiteReferenceImage(
        {
          user,
          workspaceId,
          projectId: project.id,
          sourceRequestId: `${action}:${videoCard.id}:${Date.now()}:${index + 1}`,
          sourceLabel: `图形生成 API / ${modelLabel}`,
          role,
          albumName: '图形生成结果',
          albumDescription: '图形生成 API 生成并自动归档的图片',
          metadataSource: 'image_generation_api',
        },
        asset.assetId,
      );
      generatedAssets.push({
        assetId: asset.assetId,
        referenceImageId: reference.referenceImageId,
        workspaceAssetId: reference.workspaceAssetId,
        originalUrl: asset.originalUrl,
        thumbnailUrl: asset.thumbnailUrl,
        fileName: reference.fileName,
        width: asset.width,
        height: asset.height,
        mimeType: downloaded.mimeType,
        revisedPrompt: image.revisedPrompt,
      });
    }

    await writeGenerationAttemptLog({
      userId: user.id,
      action,
      status: 'succeeded',
      projectId: project.id,
      videoCardId: videoCard.id,
      canvasDocumentId,
      canvasNodeId,
      provider: settings.provider,
      model: settings.default_model,
      modelLabel,
      size: imageSize,
      outputFormat: settings.output_format,
      responseFormat: settings.response_format,
      referenceImageCount: referenceImageIds.length,
      workspaceId,
      assetIds: generatedAssets.map((asset) => asset.assetId),
      referenceImageIds: generatedAssets.map((asset) => asset.referenceImageId),
    });

    return NextResponse.json({
      success: true,
      action,
      provider: settings.provider,
      model: settings.default_model,
      source_model_label: modelLabel,
      size: imageSize,
      output_format: settings.output_format,
      response_format: settings.response_format,
      reference_image_count: referenceImageIds.length,
      workspaceId,
      assets: generatedAssets,
      asset_id: generatedAssets[0]?.assetId || null,
      reference_image_id: generatedAssets[0]?.referenceImageId || null,
      workspace_asset_id: generatedAssets[0]?.workspaceAssetId || null,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ImageGenerationApiError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
    }
    if (error instanceof ReferenceImportError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
    }
    console.error('[ImageGeneration] Generate failed:', error);
    return NextResponse.json({
      error: 'image_generation_failed',
      message: error instanceof Error ? error.message : '图形生成请求失败',
    }, { status: 500 });
  }
}
