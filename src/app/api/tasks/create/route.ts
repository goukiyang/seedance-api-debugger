import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { prisma } from '@/lib/prisma';
import { getSessionUser, errorJson } from '@/lib/auth/api-helpers';
import { calculateEstimatedCost, calculateH3EstimatedCost } from '@/lib/pricing';
import { addAssetToWorkspace, getOrCreateWorkspace } from '@/lib/assets/workspace';
import { validatePromptReferences, renderPromptWithAssets } from '@/lib/assets/collection';
import { createTaskSnapshot } from '@/lib/assets/snapshot';
import { createVideoTask, buildContentArray, isApiKeyConfigured } from '@/lib/provider/jimeng';
import { parseSeedanceVideoModel, seedanceVideoModelLabel } from '@/lib/provider/seedance-models';
import {
  H3_VIDEO_PROVIDER,
  H3RequestError,
  createH3VideoJob,
  type H3GeneratePayload,
} from '@/lib/provider/h3';
import { buildH3DiagnosticSnapshot } from '@/lib/provider/h3-diagnostics';
import { uploadH3ReferenceImagesForTask } from '@/lib/provider/h3-assets';
import { getH3ApiSettings, isH3Operational, isH3PresetId } from '@/lib/integrations/h3';
import {
  PROVIDER_REFERENCE_IMAGE_MAX_PIXELS,
  ensureProviderSafeReferenceImageUrl,
  getProviderSafeImageResizeDimensions,
  isProviderReferenceImageSizeError,
  providerReferenceImageSizeMessage,
  readProviderReferenceImageDimensions,
} from '@/lib/provider/reference-image-safety';
import {
  isReferenceMediaTooSmall,
  referenceMediaTooSmallMessage,
  validateSeedanceReferenceMediaPreflight,
  type ReferenceMediaKind,
  type SeedanceReferenceMediaItem,
} from '@/lib/provider/reference-media-policy';
import { providerCreateFailureUserMessage } from '@/lib/provider/error-message';
import { AuthError } from '@/lib/auth/session';
import { getProjectForGeneration } from '@/lib/projects/permissions';
import { assertCanGenerateInVideoCard } from '@/lib/video-cards/permissions';
import {
  authenticateCodexVideoApi,
  CodexApiAuthError,
  hasCodexApiAuthSignal,
  webRequestSource,
  type GenerationRequestSource,
} from '@/lib/integrations/codex';
import {
  createProviderApiRequest,
  markProviderApiRequestAccepted,
  markProviderApiRequestFailed,
  recordTaskCostEstimate,
  recordTaskCostSettlement,
} from '@/lib/costs/ledger';
import {
  assertCanUseReferenceImage,
  getAuthorizedReferenceImagesForUse,
  uniquePreserveOrder,
} from '@/lib/reference-albums/permissions';
import {
  ensureWorkspaceImageAssetsHaveReferenceImages,
  importReferenceImageUrlsToSite,
  ReferenceImportError,
} from '@/lib/assets/reference-import';
import { ensureSiteAssetPublicUrl, sameOriginPublicUrlForLocalUpload } from '@/lib/assets/site-upload';
import { isPubliclyReachableUrl } from '@/lib/assets/public-storage';
import { allocateTaskCredits, settleTaskCredits } from '@/lib/credits/policy';
import {
  allocateProjectTaskBudget,
  settleProjectTaskBudget,
  shouldBillProjectBudget,
} from '@/lib/projects/budget';
import { consumeApprovalForTask, findUsableApproval } from '@/lib/approvals';
import { notifyProjectOwner } from '@/lib/notifications';
import { evaluatePaidGenerationGuard, paidGenerationGuardError } from '@/lib/tasks/paid-generation-guard';
import { startTaskLocalization } from '@/lib/video/task-localization-runner';
import {
  isVideoDeliveryFastPathTask,
  mergeVideoDeliveryCallbackParams,
  resolveVideoDeliveryCallbackConfig,
} from '@/lib/video/delivery-policy';
import type { CreateVideoInput, GenerationMode, VideoResolution, VideoDuration } from '@/types';

const VALID_GENERATION_MODES: GenerationMode[] = [
  'all_in_one_reference',
  'first_last_frame',
  'smart_multi_frame',
];
const VALID_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
const VALID_DURATIONS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const VALID_RESOLUTIONS = ['480p', '720p', '1080p'];
const execFileAsync = promisify(execFile);

type GenerationProvider = 'seedance' | typeof H3_VIDEO_PROVIDER;

function normalizeGenerationProvider(value: unknown): GenerationProvider {
  if (typeof value !== 'string' || !value.trim()) return 'seedance';
  const normalized = value.trim().toLowerCase();
  if (['seedance', 'jimeng', 'dreamina'].includes(normalized)) return 'seedance';
  if (['h3', 'h3_video', 'h3-local', 'h3_local'].includes(normalized)) return H3_VIDEO_PROVIDER;
  throw new Error('provider 只允许 seedance 或 h3');
}

function appendH3VisibleContext(input: {
  prompt: string;
  extraReferenceImageUrls: string[];
  referenceVideoUrls: string[];
  referenceAudioUrls: string[];
}) {
  const lines: string[] = [];
  if (input.extraReferenceImageUrls.length > 0) {
    lines.push(`参考图上下文（不直接传给 H3 文件字段）：${input.extraReferenceImageUrls.length} 张图片只作为画面参考，需在生成时保持主体、风格和构图意图。`);
  }
  if (input.referenceVideoUrls.length > 0) {
    lines.push(`参考视频上下文（H3 第一版不直传视频文件）：${input.referenceVideoUrls.length} 个视频只作为动作、节奏或镜头参考。`);
  }
  if (input.referenceAudioUrls.length > 0) {
    lines.push(`参考音频上下文（H3 第一版不直传音频文件）：${input.referenceAudioUrls.length} 个音频只作为声音氛围参考；如需声音请写入 audio_prompt 或 music_prompt。`);
  }
  if (lines.length === 0) return input.prompt;
  return `${input.prompt.trim()}\n\n[H3 可见上下文]\n${lines.map((line) => `- ${line}`).join('\n')}`;
}

function cleanSourceMetadata(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of ['source', 'canvas_document_id', 'canvas_node_id', 'mode']) {
    const raw = source[key];
    if (typeof raw === 'string' && raw.trim()) result[key] = raw.trim().slice(0, 240);
  }
  return result;
}

function cleanClientName(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : null;
}

function parseJsonRecord(value: string | null | undefined) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function normalizeReferenceMediaUrls(value: unknown, max: number) {
  return normalizeReferenceMediaUrlList(value).slice(0, max);
}

function normalizeReferenceMediaUrlList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
}

function firstNonPublicReferenceMediaUrl(urls: string[]) {
  return urls.find((url) => !isPubliclyReachableUrl(url)) || null;
}

type ReferenceMediaResolutionIssue = {
  error: string;
  message: string;
  details: {
    kind: ReferenceMediaKind;
    name: string | null;
    width: number | null;
    height: number | null;
    index: number;
  };
};

function normalizeProbeDimension(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const next = Math.floor(parsed);
  return next > 0 && next < 100000 ? next : null;
}

function safeUrlHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

function parseFps(value: unknown) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const [numerator, denominator] = value.split('/').map((item) => Number(item));
  if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) {
    const next = numerator / denominator;
    return Number.isFinite(next) && next > 0 ? next : null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeProbeDuration(value: unknown) {
  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function inferMimeTypeFromUrl(url: string | null | undefined) {
  if (!url) return null;
  const pathname = url.split('?')[0]?.toLowerCase() || '';
  if (pathname.endsWith('.mp4')) return 'video/mp4';
  if (pathname.endsWith('.mov')) return 'video/quicktime';
  if (pathname.endsWith('.webm')) return 'video/webm';
  if (pathname.endsWith('.mp3')) return 'audio/mpeg';
  if (pathname.endsWith('.wav')) return 'audio/wav';
  if (pathname.endsWith('.ogg')) return 'audio/ogg';
  if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
  if (pathname.endsWith('.png')) return 'image/png';
  if (pathname.endsWith('.webp')) return 'image/webp';
  if (pathname.endsWith('.gif')) return 'image/gif';
  if (pathname.endsWith('.bmp')) return 'image/bmp';
  return null;
}

async function probePublicImageDimensions(url: string) {
  if (!isPubliclyReachableUrl(url)) return null;
  const dimensions = await readProviderReferenceImageDimensions(url);
  return dimensions.width && dimensions.height
    ? { width: dimensions.width, height: dimensions.height }
    : null;
}

async function probePublicVideoDimensions(url: string) {
  if (!isPubliclyReachableUrl(url)) return null;
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height,avg_frame_rate,r_frame_rate:format=duration',
    '-of',
    'json',
    url,
  ], { timeout: 15000, maxBuffer: 1024 * 32 });
  const parsed = JSON.parse(String(stdout || '{}')) as {
    streams?: Array<{ width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string }>;
    format?: { duration?: string | number };
  };
  const stream = parsed.streams?.[0];
  const width = normalizeProbeDimension(stream?.width);
  const height = normalizeProbeDimension(stream?.height);
  return {
    width,
    height,
    durationSeconds: normalizeProbeDuration(parsed.format?.duration),
    fps: parseFps(stream?.avg_frame_rate) ?? parseFps(stream?.r_frame_rate),
  };
}

async function probePublicAudioMetadata(url: string) {
  if (!isPubliclyReachableUrl(url)) return null;
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'json',
    url,
  ], { timeout: 15000, maxBuffer: 1024 * 16 });
  const parsed = JSON.parse(String(stdout || '{}')) as { format?: { duration?: string | number } };
  return { durationSeconds: normalizeProbeDuration(parsed.format?.duration) };
}

function buildLowResolutionIssue(input: {
  kind: ReferenceMediaKind;
  name: string | null;
  width: number | null;
  height: number | null;
  index: number;
}): ReferenceMediaResolutionIssue {
  return {
    error: 'REFERENCE_MEDIA_TOO_SMALL',
    message: referenceMediaTooSmallMessage(input),
    details: input,
  };
}

async function validateReferenceMediaResolution(input: {
  preparedImages: PreparedRefImage[];
  imageUrls: string[];
  referenceVideoUrls: string[];
}): Promise<ReferenceMediaResolutionIssue | null> {
  const imageUrls = uniquePreserveOrder(input.imageUrls);
  const preparedImageByUrl = new Map(input.preparedImages.map((image) => [image.originalUrl, image]));
  const imageAssets = imageUrls.length > 0
    ? await prisma.asset.findMany({
        where: { original_url: { in: imageUrls } },
        select: {
          id: true,
          original_url: true,
          file_name: true,
          width: true,
          height: true,
          type: true,
        },
      })
    : [];
  const imageAssetByUrl = new Map(imageAssets.map((asset) => [asset.original_url, asset]));

  for (let index = 0; index < imageUrls.length; index += 1) {
    const url = imageUrls[index];
    const prepared = preparedImageByUrl.get(url) ?? null;
    const asset = imageAssetByUrl.get(url) ?? null;
    const name = prepared?.name || asset?.file_name || `图片${index + 1}`;
    let width = prepared?.width ?? asset?.width ?? null;
    let height = prepared?.height ?? asset?.height ?? null;

    if (width == null || height == null) {
      try {
        const probed = await probePublicImageDimensions(url);
        if (probed) {
          width = probed.width;
          height = probed.height;
          if (asset?.type === 'image') {
            await prisma.asset.update({
              where: { id: asset.id },
              data: { width, height },
            });
          }
        }
      } catch (error) {
        console.warn('[TasksCreate] Failed to probe reference image dimensions:', {
          assetId: asset?.id ?? null,
          urlHost: safeUrlHost(url),
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (isReferenceMediaTooSmall(width, height)) {
      return buildLowResolutionIssue({
        kind: 'image',
        name,
        width,
        height,
        index,
      });
    }
  }

  const referenceVideoUrls = input.referenceVideoUrls;
  if (referenceVideoUrls.length === 0) return null;
  const videoAssets = await prisma.asset.findMany({
    where: { original_url: { in: referenceVideoUrls } },
    select: {
      id: true,
      original_url: true,
      file_name: true,
      width: true,
      height: true,
      type: true,
    },
  });
  const videoAssetByUrl = new Map(videoAssets.map((asset) => [asset.original_url, asset]));

  for (let index = 0; index < referenceVideoUrls.length; index += 1) {
    const url = referenceVideoUrls[index];
    const asset = videoAssetByUrl.get(url) ?? null;
    const name = asset?.file_name || `视频${index + 1}`;
    let width = asset?.width ?? null;
    let height = asset?.height ?? null;

    if (width == null || height == null) {
      try {
        const probed = await probePublicVideoDimensions(url);
        if (probed) {
          width = probed.width ?? width;
          height = probed.height ?? height;
          if (asset?.type === 'video' && width && height) {
            await prisma.asset.update({
              where: { id: asset.id },
              data: { width, height },
            });
          }
        }
      } catch (error) {
        console.warn('[TasksCreate] Failed to probe reference video dimensions:', {
          assetId: asset?.id ?? null,
          urlHost: safeUrlHost(url),
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (isReferenceMediaTooSmall(width, height)) {
      return buildLowResolutionIssue({
        kind: 'video',
        name,
        width,
        height,
        index,
      });
    }
  }

  return null;
}

async function validateReferenceMediaProviderPreflight(input: {
  preparedImages: PreparedRefImage[];
  imageUrls: string[];
  referenceVideoUrls: string[];
  referenceAudioUrls: string[];
}): Promise<ReferenceMediaResolutionIssue | null> {
  const allUrls = uniquePreserveOrder([
    ...input.imageUrls,
    ...input.referenceVideoUrls,
    ...input.referenceAudioUrls,
  ]);
  const assets = allUrls.length > 0
    ? await prisma.asset.findMany({
        where: { original_url: { in: allUrls } },
        select: {
          id: true,
          original_url: true,
          file_name: true,
          mime_type: true,
          width: true,
          height: true,
          type: true,
        },
      })
    : [];
  const assetByUrl = new Map(assets.map((asset) => [asset.original_url, asset]));
  const preparedImageByUrl = new Map(input.preparedImages.map((image) => [image.originalUrl, image]));

  const images: SeedanceReferenceMediaItem[] = input.imageUrls.map((url, index) => {
    const prepared = preparedImageByUrl.get(url) ?? null;
    const asset = assetByUrl.get(url) ?? null;
    return {
      url,
      index,
      name: prepared?.name || asset?.file_name || `图片${index + 1}`,
      mimeType: asset?.mime_type || inferMimeTypeFromUrl(url),
      width: prepared?.width ?? asset?.width ?? null,
      height: prepared?.height ?? asset?.height ?? null,
    };
  });

  const videos: SeedanceReferenceMediaItem[] = [];
  for (let index = 0; index < input.referenceVideoUrls.length; index += 1) {
    const url = input.referenceVideoUrls[index];
    const asset = assetByUrl.get(url) ?? null;
    let width = asset?.width ?? null;
    let height = asset?.height ?? null;
    let durationSeconds: number | null = null;
    let fps: number | null = null;
    try {
      const probed = await probePublicVideoDimensions(url);
      if (probed) {
        width = width ?? probed.width;
        height = height ?? probed.height;
        durationSeconds = probed.durationSeconds;
        fps = probed.fps;
        if (asset?.type === 'video' && (asset.width == null || asset.height == null) && width && height) {
          await prisma.asset.update({ where: { id: asset.id }, data: { width, height } });
        }
      }
    } catch (error) {
      console.warn('[TasksCreate] Failed to probe reference video preflight metadata:', {
        assetId: asset?.id ?? null,
        urlHost: safeUrlHost(url),
        message: error instanceof Error ? error.message : String(error),
      });
    }
    videos.push({
      url,
      index,
      name: asset?.file_name || `视频${index + 1}`,
      mimeType: asset?.mime_type || inferMimeTypeFromUrl(url),
      width,
      height,
      durationSeconds,
      fps,
    });
  }

  const audios: SeedanceReferenceMediaItem[] = [];
  for (let index = 0; index < input.referenceAudioUrls.length; index += 1) {
    const url = input.referenceAudioUrls[index];
    const asset = assetByUrl.get(url) ?? null;
    let durationSeconds: number | null = null;
    try {
      const probed = await probePublicAudioMetadata(url);
      durationSeconds = probed?.durationSeconds ?? null;
    } catch (error) {
      console.warn('[TasksCreate] Failed to probe reference audio preflight metadata:', {
        assetId: asset?.id ?? null,
        urlHost: safeUrlHost(url),
        message: error instanceof Error ? error.message : String(error),
      });
    }
    audios.push({
      url,
      index,
      name: asset?.file_name || `音频${index + 1}`,
      mimeType: asset?.mime_type || inferMimeTypeFromUrl(url),
      durationSeconds,
    });
  }

  const issue = validateSeedanceReferenceMediaPreflight({ images, videos, audios });
  if (!issue) return null;
  return {
    error: issue.code,
    message: issue.message,
    details: {
      kind: issue.kind || 'image',
      name: null,
      width: null,
      height: null,
      index: issue.index ?? 0,
    },
  };
}

function buildReferenceMediaFailureSummary(input: {
  preparedImages: PreparedRefImage[];
  imageUrls: string[];
  referenceVideoUrls: string[];
  referenceAudioUrls: string[];
}) {
  const preparedImageByUrl = new Map(input.preparedImages.map((image) => [image.originalUrl, image]));
  return {
    images: {
      count: input.imageUrls.length,
      items: input.imageUrls.slice(0, 20).map((url, index) => {
        const prepared = preparedImageByUrl.get(url) ?? null;
        return {
          index,
          name: prepared?.name || `图片${index + 1}`,
          host: safeUrlHost(url),
          width: prepared?.width ?? null,
          height: prepared?.height ?? null,
          source_type: prepared?.sourceType ?? null,
          resized: Boolean(prepared?.providerSafeResize),
        };
      }),
    },
    videos: {
      count: input.referenceVideoUrls.length,
      items: input.referenceVideoUrls.slice(0, 20).map((url, index) => ({
        index,
        host: safeUrlHost(url),
        mime_type: inferMimeTypeFromUrl(url),
      })),
    },
    audios: {
      count: input.referenceAudioUrls.length,
      items: input.referenceAudioUrls.slice(0, 20).map((url, index) => ({
        index,
        host: safeUrlHost(url),
        mime_type: inferMimeTypeFromUrl(url),
      })),
    },
  };
}

export async function POST(request: NextRequest) {
  let user;
  let requestSource: GenerationRequestSource = webRequestSource(request);

  if (hasCodexApiAuthSignal(request)) {
    try {
      const codexContext = await authenticateCodexVideoApi(request);
      user = codexContext.user;
      requestSource = codexContext.source;
    } catch (error) {
      if (error instanceof CodexApiAuthError) {
        return errorJson(error.message, error.status);
      }
      throw error;
    }
  } else {
    try {
      user = await getSessionUser(request);
    } catch {
      return errorJson('请先登录后再生成视频', 401);
    }
  }

  if (user.status !== 'active') {
    return errorJson('账号已被禁用，无法生成', 403);
  }

  const body = await request.json();
  let requestedProvider: GenerationProvider;
  try {
    requestedProvider = normalizeGenerationProvider(body.provider ?? body.engine);
  } catch (error) {
    return errorJson(error instanceof Error ? error.message : 'provider 无效', 400);
  }

  if (requestedProvider === 'seedance' && !isApiKeyConfigured()) {
    return errorJson('请在环境变量中配置 SEEDANCE_API_KEY', 500);
  }

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
  const resolutionApprovalConfirmed = body.resolution_approval_confirmed === true || body.resolutionApprovalConfirmed === true;
  const requestedTemplateId = typeof body.template_id === 'string' && body.template_id.trim() ? body.template_id.trim() : null;
  const requestedAgentRunId = typeof body.agent_run_id === 'string' && body.agent_run_id.trim() ? body.agent_run_id.trim() : null;
  const selectedAgentPlanKey = typeof body.selected_agent_plan_key === 'string' && body.selected_agent_plan_key.trim()
    ? body.selected_agent_plan_key.trim().slice(0, 16)
    : null;
  const agentPromptSnapshot = typeof body.agent_prompt_snapshot === 'string' && body.agent_prompt_snapshot.trim()
    ? body.agent_prompt_snapshot.trim().slice(0, 12000)
    : null;
  const finalPromptSnapshot = typeof body.final_prompt_snapshot === 'string' && body.final_prompt_snapshot.trim()
    ? body.final_prompt_snapshot.trim().slice(0, 12000)
    : body.prompt.trim();
  const promptUserEdited = body.prompt_user_edited === true;

  if (!VALID_RATIOS.includes(ratio)) return errorJson('ratio 无效', 400);
  if (!VALID_DURATIONS.includes(duration)) return errorJson('duration 必须是 4-15', 400);
  if (!VALID_RESOLUTIONS.includes(resolution)) return errorJson('resolution 无效', 400);
  const h3Settings = requestedProvider === H3_VIDEO_PROVIDER ? await getH3ApiSettings() : null;
  let selectedModel: string;
  if (requestedProvider === H3_VIDEO_PROVIDER) {
    if (!h3Settings || !isH3Operational(h3Settings)) {
      return errorJson('H3 本地生成服务未就绪，请管理员先在 API 设置页保存配置并测试连接通过。', 503);
    }
    const requestedPreset = typeof body.preset_id === 'string' && body.preset_id.trim()
      ? body.preset_id.trim()
      : typeof body.model === 'string' && body.model.trim()
        ? body.model.trim()
        : h3Settings.default_preset_id;
    if (!isH3PresetId(requestedPreset)) {
      return errorJson('H3 preset 只允许 larry_v4_6step、larry_v4_8step、lightx2v_4step_turbo', 400);
    }
    if (!['16:9', '9:16', '1:1', '4:3', '3:4'].includes(ratio)) {
      return errorJson('H3 比例只支持 16:9、9:16、1:1、4:3、3:4', 400);
    }
    selectedModel = requestedPreset;
  } else {
    const parsedModel = parseSeedanceVideoModel(body.model);
    if (!parsedModel.ok) return errorJson(parsedModel.message, 400);
    selectedModel = parsedModel.model;
  }

  const paidGenerationGuard = evaluatePaidGenerationGuard({ request, body, requestSource });
  if (!paidGenerationGuard.allowed) {
    return NextResponse.json(paidGenerationGuardError(paidGenerationGuard), { status: 403 });
  }

  const requestedProjectId = typeof body.project_id === 'string' && body.project_id.trim()
    ? body.project_id.trim()
    : null;
  const requestedVideoCardId = typeof body.video_card_id === 'string' && body.video_card_id.trim()
    ? body.video_card_id.trim()
    : typeof body.videoCardId === 'string' && body.videoCardId.trim()
      ? body.videoCardId.trim()
      : null;
  const requestedResolutionApprovalId = typeof body.resolution_approval_id === 'string' && body.resolution_approval_id.trim()
    ? body.resolution_approval_id.trim()
    : typeof body.resolutionApprovalId === 'string' && body.resolutionApprovalId.trim()
      ? body.resolutionApprovalId.trim()
      : null;
  const requestedVideoBranchId = typeof body.video_branch_id === 'string' && body.video_branch_id.trim()
    ? body.video_branch_id.trim()
    : typeof body.videoBranchId === 'string' && body.videoBranchId.trim()
      ? body.videoBranchId.trim()
      : null;

  if (!requestedVideoCardId) {
    return errorJson('必须先选择视频卡，生成任务才能写入项目成本闭环', 400);
  }

  const requestedVideoCard = await prisma.videoCard.findUnique({
    where: { id: requestedVideoCardId },
    select: { id: true, project_id: true },
  });
  if (!requestedVideoCard) {
    return errorJson('视频卡不存在', 404);
  }
  if (requestedProjectId && requestedProjectId !== requestedVideoCard.project_id) {
    return errorJson('视频卡不属于当前项目', 400);
  }

  let project;
  let videoCard;
  try {
    project = await getProjectForGeneration(user, requestedVideoCard.project_id);
    const videoCardAccess = await assertCanGenerateInVideoCard(user, project.id, requestedVideoCard.id);
    videoCard = videoCardAccess.videoCard;
  } catch (error) {
    if (error instanceof AuthError) return errorJson(error.message, error.status);
    throw error;
  }

  let generationTemplate: { id: string; status: string } | null = null;
  if (requestedTemplateId) {
    generationTemplate = await prisma.generationTemplate.findFirst({
      where: {
        id: requestedTemplateId,
        OR: user.role === 'admin' ? [{ status: { in: ['draft', 'active'] } }] : [{ status: 'active' }],
      },
      select: { id: true, status: true },
    });
    if (!generationTemplate) return errorJson('模板不存在或不可用', 404);
  }

  let agentRun: { id: string; template_id: string; user_id: string; video_card_id: string | null } | null = null;
  if (requestedAgentRunId) {
    agentRun = await prisma.agentRun.findUnique({
      where: { id: requestedAgentRunId },
      select: { id: true, template_id: true, user_id: true, video_card_id: true },
    });
    if (!agentRun) return errorJson('Agent 执行链路不存在', 404);
    if (agentRun.user_id !== user.id && user.role !== 'admin') return errorJson('Agent 执行链路不属于当前用户', 403);
    if (generationTemplate && agentRun.template_id !== generationTemplate.id) return errorJson('Agent 执行链路与当前模板不一致', 400);
    if (agentRun.video_card_id && agentRun.video_card_id !== videoCard.id) return errorJson('Agent 执行链路与当前视频卡不一致', 400);
    if (!generationTemplate) {
      generationTemplate = { id: agentRun.template_id, status: 'active' };
    }
  }

  if (project.type !== 'personal' && resolution === '1080p') {
    if (!resolutionApprovalConfirmed) {
      return errorJson('1080p 生成需要先确认审批通过', 403);
    }
    const baselineTaskId = videoCard.final_task_id || videoCard.current_best_task_id;
    const candidateCount = await prisma.videoTask.count({
      where: {
        video_card_id: videoCard.id,
        version_role: { in: ['candidate', 'current_best', 'final'] },
      },
    });
    if (!baselineTaskId && candidateCount === 0) {
      return errorJson('1080p 必须基于候选、当前最佳或最终版任务，不能在无基准版本的视频卡上直接生成', 403);
    }
    const approval = requestedResolutionApprovalId
      ? await prisma.approvalRecord.findFirst({
          where: {
            id: requestedResolutionApprovalId,
            type: 'resolution_1080p',
            status: 'approved',
            project_id: project.id,
            video_card_id: videoCard.id,
          },
        })
      : await prisma.$transaction((tx) => findUsableApproval(tx, {
          type: 'resolution_1080p',
          projectId: project.id,
          videoCardId: videoCard.id,
        }));
    if (!approval) {
      const rejectedApproval = await prisma.approvalRecord.findFirst({
        where: {
          type: 'resolution_1080p',
          status: 'rejected',
          project_id: project.id,
          video_card_id: videoCard.id,
        },
        orderBy: [{ rejected_at: 'desc' }, { created_at: 'desc' }],
        select: { decision_reason: true, reason: true },
      });
      if (rejectedApproval) {
        const reason = rejectedApproval.decision_reason || rejectedApproval.reason || '未填写原因';
        return errorJson(`1080p 审批已拒绝：${reason}`, 403);
      }
      return errorJson('未找到有效的 1080p 审批记录，请先在审批中心申请并通过审批', 403);
    }
    if (approval.video_card_id !== videoCard.id) {
      return errorJson('1080p 审批必须绑定当前视频卡，不能跨视频卡或使用项目级通配审批', 403);
    }
    if (approval.usage_limit !== null && approval.used_count >= approval.usage_limit) {
      return errorJson('1080p 审批额度已用尽，请重新申请', 403);
    }
    if (approval.expires_at && approval.expires_at <= new Date()) {
      return errorJson('1080p 审批已过期，请重新申请', 403);
    }
    if (!approval.task_id) {
      return errorJson('1080p 审批缺少基准任务，请重新申请', 403);
    }
    const approvalBaseTask = await prisma.videoTask.findUnique({
      where: { id: approval.task_id },
      select: { id: true, video_card_id: true, version_role: true },
    });
    if (
      !approvalBaseTask
      || approvalBaseTask.video_card_id !== videoCard.id
      || !['candidate', 'current_best', 'final'].includes(approvalBaseTask.version_role)
    ) {
      return errorJson('1080p 审批基准任务不属于当前视频卡候选/当前最佳/最终版', 403);
    }
  }

  if (videoCard.ratio_locked && videoCard.ratio && ratio !== videoCard.ratio) {
    return errorJson(`此视频卡已锁定比例 ${videoCard.ratio}，变更比例需要先通过比例变更审批`, 403);
  }

  let videoBranch: { id: string; title: string; status: string; is_primary: boolean } | null = null;
  if (requestedVideoBranchId) {
    const branch = await prisma.videoBranch.findUnique({
      where: { id: requestedVideoBranchId },
      select: { id: true, video_card_id: true, title: true, status: true, is_primary: true },
    });
    if (!branch || branch.video_card_id !== videoCard.id) {
      return errorJson('方向分支不属于当前视频卡', 400);
    }
    if (['closed', 'merged', 'promoted'].includes(branch.status)) {
      return errorJson('方向分支已关闭、合并或升格，不能继续生成', 403);
    }
    videoBranch = branch;
  }

  // --- Pricing ---
  const pricing = requestedProvider === H3_VIDEO_PROVIDER
    ? calculateH3EstimatedCost(duration, selectedModel)
    : calculateEstimatedCost(resolution, duration, seedanceVideoModelLabel(selectedModel));
  const estimatedCost = pricing.estimatedCost;
  const billingScope = shouldBillProjectBudget(project) ? 'project' : 'user';
  const billingAccountId = billingScope === 'project' ? project.id : user.id;

  // --- Idempotency ---
  const idempotencyKey: string | undefined = body.idempotency_key || undefined;
  if (idempotencyKey) {
    const existing = await prisma.videoTask.findUnique({
      where: { user_id_idempotency_key: { user_id: user.id, idempotency_key: idempotencyKey } },
    });
    if (existing) {
      if (existing.video_card_id && existing.video_card_id !== videoCard.id) {
        return errorJson('同一个幂等键已绑定到其他视频卡', 409);
      }
      return NextResponse.json({
        id: existing.id,
        status: existing.local_status,
        model: existing.model,
        estimated_cost: existing.estimated_cost,
        frozen_cost: existing.frozen_cost,
        created_at: existing.created_at,
        deduplicated: true,
        source_type: existing.source_type,
        source_label: existing.source_label,
        source_request_id: existing.source_request_id,
        project_id: existing.project_id,
        video_card_id: existing.video_card_id,
        template_id: existing.template_id,
        agent_run_id: existing.agent_run_id,
        selected_agent_plan_key: existing.selected_agent_plan_key,
        billing_scope: existing.billing_scope,
        billing_account_id: existing.billing_account_id,
      });
    }
  }

  // --- Workspace + Reference Image Preparation ---
  const tabId = request.headers.get('x-tab-id') || 'default';
  const bodySourceRequestId = typeof body.source_request_id === 'string' && body.source_request_id.trim()
    ? body.source_request_id.trim()
    : typeof body.codex_request_id === 'string' && body.codex_request_id.trim()
      ? body.codex_request_id.trim()
      : null;
  const sourceRequestId = requestSource.source_request_id || bodySourceRequestId || idempotencyKey || null;
  const cleanedSourceMetadata = cleanSourceMetadata(body.source_metadata);
  const clientName = cleanClientName(body.client_name);
  const isUltimateCanvasRequest = clientName === 'ultimate_canvas'
    || cleanedSourceMetadata.source === 'ultimate_canvas';
  const effectiveSourceLabel = isUltimateCanvasRequest ? '无线画布' : requestSource.source_label;
  const sourceMetadata: Record<string, unknown> = {
    ...requestSource.source_metadata,
    ...cleanedSourceMetadata,
    ...(isUltimateCanvasRequest ? { source: 'ultimate_canvas' } : {}),
    tab_id: tabId,
    idempotency_key: idempotencyKey || null,
    body_source_request_id: bodySourceRequestId,
    client_name: clientName,
    source_label: effectiveSourceLabel,
    provider: requestedProvider,
    model: selectedModel,
    paid_generation_guard: paidGenerationGuard.metadata,
  };
  const { id: workspaceId } = await getOrCreateWorkspace(tabId, user.id);

  let requestedReferenceImageIds = uniquePreserveOrder(
    Array.isArray(body.reference_image_ids)
      ? body.reference_image_ids
      : Array.isArray(body.referenceImageIds)
        ? body.referenceImageIds
        : [],
  );

  let requestedReferenceImageUrls = uniquePreserveOrder(
    Array.isArray(body.reference_image_urls)
      ? body.reference_image_urls
      : Array.isArray(body.referenceImageUrls)
        ? body.referenceImageUrls
        : [],
  );

  if (requestedReferenceImageIds.length + requestedReferenceImageUrls.length > 9) {
    return NextResponse.json({ error: '单次生成最多选择 9 张参考图' }, { status: 400 });
  }

  if (requestSource.source_type === 'codex_api' && requestedReferenceImageUrls.length > 0) {
    try {
      const importedReferences = await importReferenceImageUrlsToSite({
        user,
        workspaceId,
        projectId: project.id,
        sourceRequestId,
        sourceLabel: effectiveSourceLabel,
        urls: requestedReferenceImageUrls,
      });
      requestedReferenceImageIds = uniquePreserveOrder([
        ...requestedReferenceImageIds,
        ...importedReferences.map((item) => item.referenceImageId),
      ]);
      requestedReferenceImageUrls = [];
      sourceMetadata.imported_reference_images = importedReferences.map((item) => ({
        asset_id: item.assetId,
        reference_image_id: item.referenceImageId,
        original_url: item.originalUrl,
      }));
    } catch (error) {
      if (error instanceof ReferenceImportError) {
        return NextResponse.json(
          { error: error.code, message: error.message },
          { status: error.status },
        );
      }
      throw error;
    }
  }

  const workspaceReferenceBackfill = await ensureWorkspaceImageAssetsHaveReferenceImages({
    user,
    workspaceId,
    projectId: project.id,
    sourceRequestId,
    sourceLabel: effectiveSourceLabel,
    metadataSource: requestSource.source_type === 'codex_api' ? 'codex_api_workspace' : 'web_workspace',
  });
  if (workspaceReferenceBackfill.length > 0) {
    sourceMetadata.workspace_reference_backfill = workspaceReferenceBackfill.map((item) => ({
      asset_id: item.assetId,
      reference_image_id: item.referenceImageId,
    }));
  }

  let workspaceReferenceImageIds = uniquePreserveOrder(
    (await prisma.workspaceAsset.findMany({
      where: {
        workspace_id: workspaceId,
        reference_image_id: { not: null },
      },
      orderBy: { sort_order: 'asc' },
      select: { reference_image_id: true },
    })).map((item) => item.reference_image_id || ''),
  );

  if (requestedReferenceImageIds.length > 0) {
    const workspaceIdSet = new Set(workspaceReferenceImageIds);
    let missingFromWorkspace = requestedReferenceImageIds.filter((id) => !workspaceIdSet.has(id));
    if (missingFromWorkspace.length > 0 && isUltimateCanvasRequest) {
      const importedToWorkspace: Array<{
        asset_id: string;
        reference_image_id: string;
        workspace_asset_id: string;
      }> = [];

      for (const referenceImageId of missingFromWorkspace) {
        const image = await assertCanUseReferenceImage(user, referenceImageId);
        if (!image.asset_id) continue;
        const workspaceAssetId = await addAssetToWorkspace(
          workspaceId,
          image.asset_id,
          'reference_image',
          user.id,
          { referenceImageId: image.id, allowSharedAsset: true },
        );
        importedToWorkspace.push({
          asset_id: image.asset_id,
          reference_image_id: image.id,
          workspace_asset_id: workspaceAssetId,
        });
        workspaceIdSet.add(image.id);
      }

      if (importedToWorkspace.length > 0) {
        sourceMetadata.canvas_reference_workspace_import = importedToWorkspace;
        workspaceReferenceImageIds = uniquePreserveOrder([
          ...workspaceReferenceImageIds,
          ...importedToWorkspace.map((item) => item.reference_image_id),
        ]);
        missingFromWorkspace = requestedReferenceImageIds.filter((id) => !workspaceIdSet.has(id));
      }
    }

    if (missingFromWorkspace.length > 0) {
      return NextResponse.json(
        { error: 'REFERENCE_IMAGE_NOT_IN_WORKSPACE', message: '参考图必须先加入当前生成工作台' },
        { status: 400 },
      );
    }
  }

  if (requestedReferenceImageIds.length === 0 && requestedReferenceImageUrls.length > 9) {
    return NextResponse.json({ error: '单次生成最多选择 9 张参考图' }, { status: 400 });
  }

  const generationReferenceImageIds = requestedReferenceImageIds.length > 0
    ? requestedReferenceImageIds
    : requestedReferenceImageUrls.length > 0
      ? []
      : requestSource.source_type === 'codex_api'
        ? []
        : workspaceReferenceImageIds;
  if (generationReferenceImageIds.length > 9) {
    return NextResponse.json({ error: '单次生成最多选择 9 张参考图' }, { status: 400 });
  }
  let generationReferenceImages: Awaited<ReturnType<typeof getAuthorizedReferenceImagesForUse>> = [];
  try {
    generationReferenceImages = generationReferenceImageIds.length > 0
      ? await getAuthorizedReferenceImagesForUse(user, generationReferenceImageIds)
      : [];
  } catch (error) {
    if (error instanceof AuthError) return errorJson(error.message, error.status);
    throw error;
  }
  const generationReferenceAlbumIds = uniquePreserveOrder(generationReferenceImages.map((image) => image.album_id));

  let preparedImages: PreparedRefImage[];
  let prepareErrors: string[];
  let prepSummary: { total: number; publicUrl: number; r2Uploaded: number; skipped: number; hasLocalPath: boolean };
  try {
    ({ preparedImages, prepareErrors, summary: prepSummary } = await prepareReferenceImages(
      workspaceId,
      generationReferenceImageIds,
      requestedReferenceImageUrls,
      user.id,
    ));
  } catch (error) {
    console.error('[TasksCreate] Reference image preparation failed:', error);
    return NextResponse.json(
      {
        error: 'REFERENCE_IMAGE_PREP_FAILED',
        message: `参考图处理失败：${error instanceof Error ? error.message : '服务临时异常'}`,
      },
      { status: 400 },
    );
  }

  if (prepSummary.total > 0 && preparedImages.length === 0 && prepSummary.skipped > 0) {
    const referenceImageFailure = buildReferenceImagePreparationFailure(prepareErrors);
    return NextResponse.json(
      { error: referenceImageFailure.error, message: referenceImageFailure.message, details: { errors: prepareErrors } },
      { status: 400 },
    );
  }

  // --- Build mode-specific reference arrays ---
  let referenceImageUrls: string[] = [];
  let firstFrameUrl: string | undefined = body.first_frame_url;
  let lastFrameUrl: string | undefined = body.last_frame_url;
  let frameImageUrls: string[] = normalizeReferenceMediaUrlList(body.frame_image_urls);
  const allReferenceVideoUrls = normalizeReferenceMediaUrlList(body.reference_video_urls);
  const allReferenceAudioUrls = normalizeReferenceMediaUrlList(body.reference_audio_urls);
  if (allReferenceVideoUrls.length > 3) {
    return errorJson(`${requestedProvider === H3_VIDEO_PROVIDER ? 'H3' : 'Seedance 2.0'} 单次生成最多选择 3 个参考视频。`, 400);
  }
  if (allReferenceAudioUrls.length > 3) {
    return errorJson(`${requestedProvider === H3_VIDEO_PROVIDER ? 'H3' : 'Seedance 2.0'} 单次生成最多选择 3 个参考音频。`, 400);
  }
  const referenceVideoUrls = allReferenceVideoUrls.slice(0, 3);
  const referenceAudioUrls = allReferenceAudioUrls.slice(0, 3);

  switch (generationMode) {
    case 'all_in_one_reference':
      referenceImageUrls = preparedImages.map((img) => img.originalUrl);
      break;
    case 'first_last_frame':
      if (!firstFrameUrl) firstFrameUrl = preparedImages[0]?.originalUrl;
      if (!lastFrameUrl) lastFrameUrl = preparedImages[1]?.originalUrl;
      if (!firstFrameUrl) return errorJson('首尾帧模式必须提供首帧图片', 400);
      break;
    case 'smart_multi_frame':
      if (frameImageUrls.length === 0) frameImageUrls = preparedImages.map((img) => img.originalUrl);
      if (frameImageUrls.length < 2) return errorJson('智能多帧模式至少需要 2 张图片', 400);
      break;
  }

  const nonPublicReferenceMediaUrl = firstNonPublicReferenceMediaUrl([
    ...referenceVideoUrls,
    ...referenceAudioUrls,
  ]);
  if (nonPublicReferenceMediaUrl) {
    return errorJson('参考视频/音频必须是公网可访问 URL，请重新上传素材或配置 R2/TOS 存储。', 400);
  }
  const hasVisualReference = referenceImageUrls.length > 0
    || Boolean(firstFrameUrl)
    || Boolean(lastFrameUrl)
    || frameImageUrls.length > 0
    || referenceVideoUrls.length > 0;
  if (requestedProvider !== H3_VIDEO_PROVIDER && referenceAudioUrls.length > 0 && !hasVisualReference) {
    return errorJson('音频参考不能单独使用，至少还需要 1 个图片或视频参考素材。', 400);
  }

  const finalReferenceImageUrls = uniquePreserveOrder([
    ...referenceImageUrls,
    ...(firstFrameUrl ? [firstFrameUrl] : []),
    ...(lastFrameUrl ? [lastFrameUrl] : []),
    ...frameImageUrls,
  ]);
  const referenceMediaResolutionIssue = await validateReferenceMediaResolution({
    preparedImages,
    imageUrls: finalReferenceImageUrls,
    referenceVideoUrls: requestedProvider === H3_VIDEO_PROVIDER ? [] : referenceVideoUrls,
  });
  if (referenceMediaResolutionIssue) {
    return NextResponse.json(referenceMediaResolutionIssue, { status: 400 });
  }
  if (requestedProvider !== H3_VIDEO_PROVIDER) {
    const referenceMediaPreflightIssue = await validateReferenceMediaProviderPreflight({
      preparedImages,
      imageUrls: finalReferenceImageUrls,
      referenceVideoUrls,
      referenceAudioUrls,
    });
    if (referenceMediaPreflightIssue) {
      return NextResponse.json(referenceMediaPreflightIssue, { status: 400 });
    }
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
  const generateAudio = body.generate_audio ?? true;
  const returnLastFrame = body.return_last_frame ?? false;
  const watermark = body.watermark ?? false;
  const requestCallbackUrl = typeof body.callback_url === 'string' && body.callback_url.trim()
    ? body.callback_url.trim()
    : null;
  const isFastPathDelivery = isVideoDeliveryFastPathTask({
    provider: requestedProvider,
    generation_mode: generationMode,
  });
  if (isFastPathDelivery) {
    try {
      resolveVideoDeliveryCallbackConfig({
        taskId: 'preflight',
        callbackSecret: process.env.VIDEO_DELIVERY_CALLBACK_SECRET || process.env.SEEDANCE_CALLBACK_SECRET || null,
      });
    } catch (error) {
      return NextResponse.json(
        {
          error: 'VIDEO_DELIVERY_CALLBACK_CONFIG_ERROR',
          message: error instanceof Error ? error.message : '视频回调配置缺失，请联系管理员。',
        },
        { status: 500 },
      );
    }
  }

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
    callback_url: undefined,
    execution_expires_after: body.execution_expires_after,
    model: selectedModel,
  };

  let h3ReferenceTransfer: Awaited<ReturnType<typeof uploadH3ReferenceImagesForTask>> | null = null;
  let h3GeneratePayload: H3GeneratePayload | null = null;
  let storedFinalPromptSnapshot = finalPromptSnapshot;

  if (requestedProvider === H3_VIDEO_PROVIDER && h3Settings) {
    h3ReferenceTransfer = await uploadH3ReferenceImagesForTask({
      firstFrameUrl: firstFrameUrl || null,
      lastFrameUrl: lastFrameUrl || null,
      options: {
        baseUrl: h3Settings.base_url,
        apiToken: h3Settings.api_token || undefined,
      },
    });
    const directH3ImageUrls = new Set([
      firstFrameUrl || '',
      lastFrameUrl || '',
    ].filter(Boolean));
    const extraReferenceImageUrls = finalReferenceImageUrls.filter((url) => !directH3ImageUrls.has(url));
    const h3Prompt = appendH3VisibleContext({
      prompt: promptRendered,
      extraReferenceImageUrls,
      referenceVideoUrls,
      referenceAudioUrls,
    });
    providerInput.prompt = h3Prompt;
    storedFinalPromptSnapshot = h3Prompt;
    h3GeneratePayload = {
      preset_id: selectedModel as H3GeneratePayload['preset_id'],
      prompt: h3Prompt,
      audio_prompt: typeof body.audio_prompt === 'string' && body.audio_prompt.trim()
        ? body.audio_prompt.trim().slice(0, 1200)
        : undefined,
      music_prompt: typeof body.music_prompt === 'string' && body.music_prompt.trim()
        ? body.music_prompt.trim().slice(0, 1200)
        : undefined,
      aspect_ratio: ratio as H3GeneratePayload['aspect_ratio'],
      duration_sec: duration,
      seed,
      first_frame: h3ReferenceTransfer.first_frame || undefined,
      last_frame: h3ReferenceTransfer.last_frame || undefined,
      metadata: {
        external_user_id: user.id,
        external_request_id: sourceRequestId || idempotencyKey || null,
        sd2_provider: H3_VIDEO_PROVIDER,
      },
    };
  }

  // --- Create snapshot ---
  const content = requestedProvider === H3_VIDEO_PROVIDER ? [] : buildContentArray(providerInput);
  const snapshot = await createTaskSnapshot({
    workspaceId,
    generationMode,
    promptRaw: body.prompt,
    input: providerInput,
    providerPayloadJson: JSON.stringify(requestedProvider === H3_VIDEO_PROVIDER
      ? {
          provider: H3_VIDEO_PROVIDER,
          preset_id: selectedModel,
          h3_payload: h3GeneratePayload,
          h3_reference_transfers: h3ReferenceTransfer?.transfers.map((item) => ({
            role: item.role,
            source_url: item.source_url,
            h3_filename: item.h3_filename,
            sha256: item.sha256,
            size_bytes: item.size_bytes,
          })) || [],
        }
      : { model: selectedModel, content_item_count: content.length, referenceCount: preparedImages.length }),
  });
  const taskParams = {
    provider: requestedProvider,
    model: selectedModel,
    ratio, duration, resolution, seed,
    generateAudio, returnLastFrame, watermark, resolutionApprovalConfirmed,
    referenceAlbumIds: generationReferenceAlbumIds,
    referenceImageIds: generationReferenceImageIds,
    videoCardId: videoCard.id,
    videoBranchId: videoBranch?.id || null,
    templateId: generationTemplate?.id || null,
    agentRunId: agentRun?.id || null,
    selectedAgentPlanKey,
    promptUserEdited,
    preparedImages: preparedImages.map((img) => ({
      name: img.name,
      originalUrl: img.originalUrl,
      sourceType: img.sourceType,
      width: img.width ?? null,
      height: img.height ?? null,
      providerSafeResize: img.providerSafeResize,
    })),
    prepSummary,
    h3: requestedProvider === H3_VIDEO_PROVIDER ? {
      preset_id: selectedModel,
      first_frame: h3ReferenceTransfer?.first_frame || null,
      last_frame: h3ReferenceTransfer?.last_frame || null,
      reference_transfers: h3ReferenceTransfer?.transfers.map((item) => ({
        role: item.role,
        source_url: item.source_url,
        h3_filename: item.h3_filename,
        sha256: item.sha256,
        size_bytes: item.size_bytes,
      })) || [],
      visible_context_in_final_prompt: true,
    } : null,
    source: {
      type: requestSource.source_type,
      label: effectiveSourceLabel,
      requestId: sourceRequestId,
      paidGenerationGuard: paidGenerationGuard.metadata,
    },
  };

  // --- Credit check + freeze + create single VideoTask in ONE transaction ---
  let taskId: string;
  let createdTask!: {
    id: string;
    user_id: string | null;
    owner_user_id: string | null;
    project_id: string | null;
    video_card_id: string | null;
    provider: string;
    provider_task_id: string | null;
    model: string;
    resolution: string | null;
    duration: number | null;
    estimated_cost: number | null;
    pricing_rule_id: string | null;
    pricing_snapshot: string | null;
    billing_scope: string;
    billing_account_id: string | null;
  };
  try {
    const result = await prisma.$transaction(async (tx) => {
      const task = await tx.videoTask.create({
        data: {
          provider: requestedProvider,
          model: selectedModel,
          generation_mode: generationMode,
          prompt: body.prompt.trim(),
          source_type: requestSource.source_type,
          source_label: effectiveSourceLabel,
          source_request_id: sourceRequestId,
          source_metadata_json: JSON.stringify(sourceMetadata),
          ratio,
          duration,
          resolution,
          seed,
          generate_audio: generateAudio,
          return_last_frame: returnLastFrame,
          watermark,
          reference_image_urls: referenceImageUrls.length > 0 ? JSON.stringify(referenceImageUrls) : null,
          reference_album_ids: generationReferenceAlbumIds.length > 0 ? JSON.stringify(generationReferenceAlbumIds) : null,
          reference_image_ids: generationReferenceImageIds.length > 0 ? JSON.stringify(generationReferenceImageIds) : null,
          reference_video_urls: referenceVideoUrls.length > 0 ? JSON.stringify(referenceVideoUrls) : null,
          reference_audio_urls: referenceAudioUrls.length > 0 ? JSON.stringify(referenceAudioUrls) : null,
          first_frame_url: firstFrameUrl || null,
          last_frame_url: lastFrameUrl || null,
          frame_image_urls: frameImageUrls.length > 0 ? JSON.stringify(frameImageUrls) : null,
          local_status: 'submitted',
          user_id: user.id,
          owner_user_id: user.id,
          project_id: project.id,
          video_card_id: videoCard.id,
          video_branch_id: videoBranch?.id || null,
          template_id: generationTemplate?.id || null,
          agent_run_id: agentRun?.id || null,
          selected_agent_plan_key: selectedAgentPlanKey,
          agent_prompt_snapshot: agentPromptSnapshot,
          final_prompt_snapshot: storedFinalPromptSnapshot,
          prompt_user_edited: promptUserEdited,
          visibility: project.type === 'personal' ? 'private' : 'project',
          estimated_cost: estimatedCost,
          frozen_cost: estimatedCost,
          pricing_snapshot: JSON.stringify(pricing),
          pricing_rule_id: pricing.pricingRuleId,
          idempotency_key: idempotencyKey || null,
          billing_scope: billingScope,
          billing_account_id: billingAccountId,
          workspace_id: workspaceId,
          snapshot_id: snapshot.id,
          params_json: JSON.stringify(taskParams),
        },
      });

      if (project.type !== 'personal' && resolution === '1080p') {
        const approval = requestedResolutionApprovalId
          ? await tx.approvalRecord.findFirst({
              where: {
                id: requestedResolutionApprovalId,
                type: 'resolution_1080p',
                status: 'approved',
                project_id: project.id,
                video_card_id: videoCard.id,
              },
            })
          : await findUsableApproval(tx, {
              type: 'resolution_1080p',
              projectId: project.id,
              videoCardId: videoCard.id,
            });
        if (!approval) throw new Error('未找到可用的 1080p 审批额度');
        if (approval.video_card_id !== videoCard.id) throw new Error('1080p 审批必须绑定当前视频卡');
        if (!approval.task_id) throw new Error('1080p 审批缺少基准任务');
        const baseTask = await tx.videoTask.findUnique({
          where: { id: approval.task_id },
          select: { id: true, video_card_id: true, version_role: true },
        });
        if (
          !baseTask
          || baseTask.video_card_id !== videoCard.id
          || !['candidate', 'current_best', 'final'].includes(baseTask.version_role)
        ) {
          throw new Error('1080p 审批基准任务不属于当前视频卡候选/当前最佳/最终版');
        }
        await consumeApprovalForTask(tx, {
          approvalId: approval.id,
          taskId: task.id,
          userId: user.id,
          metadata: {
            project_id: project.id,
            video_card_id: videoCard.id,
            baseline_task_id: approval.task_id,
            resolution,
            estimated_cost: estimatedCost,
          },
        });
        await tx.videoTask.update({
          where: { id: task.id },
          data: {
            params_json: JSON.stringify({
              ...taskParams,
              resolutionApprovalId: approval.id,
              resolutionApprovalBaselineTaskId: approval.task_id,
            }),
          },
        });
      }

      let freezeSnapshot = '[]';
      if (estimatedCost > 0) {
        try {
          if (billingScope === 'project') {
            const freeze = await allocateProjectTaskBudget(tx, {
              projectId: project.id,
              taskId: task.id,
              amount: estimatedCost,
              operatorId: user.id,
            });
            freezeSnapshot = freeze.snapshot;
          } else {
            const freeze = await allocateTaskCredits(tx, {
              id: user.id,
              role: user.role,
              account_type: user.account_type,
              user_profile: user.user_profile,
              status: user.status,
            }, estimatedCost, task.id);
            freezeSnapshot = freeze.snapshot;

            await tx.creditLedger.create({
              data: {
                user_id: user.id,
                type: 'task_freeze',
                amount: -estimatedCost,
                balance_before: freeze.balance_before,
                balance_after: freeze.balance_after,
                frozen_before: freeze.frozen_before,
                frozen_after: freeze.frozen_after,
                related_task_id: task.id,
                reason: `任务创建冻结 ${estimatedCost} 点`,
                metadata_json: JSON.stringify({ allocations: freeze.allocations, source_metadata: sourceMetadata }),
              },
            });
          }
        } catch (error) {
          throw new CreditError(
            error instanceof Error ? error.message : billingScope === 'project' ? '项目预算不足' : '点数不足',
            billingScope === 'project' ? 'INSUFFICIENT_PROJECT_BUDGET' : 'INSUFFICIENT_CREDITS',
          );
        }
      }

      await tx.videoTask.update({
        where: { id: task.id },
        data: { credit_freeze_snapshot: freezeSnapshot },
      });

      await tx.operationLog.create({
        data: {
          operator_id: user.id,
          action: requestSource.source_type === 'codex_api' ? 'generation_create_codex_api' : 'generation_create',
          target_type: 'VideoTask',
          target_id: task.id,
          detail: JSON.stringify({
            project_id: project.id,
            video_card_id: videoCard.id,
            template_id: generationTemplate?.id || null,
            agent_run_id: agentRun?.id || null,
            selected_agent_plan_key: selectedAgentPlanKey,
            provider: requestedProvider,
            model: selectedModel,
            provider_task_id: task.provider_task_id,
            pricing_rule_id: pricing.pricingRuleId,
            owner_user_id: user.id,
            estimated_cost: estimatedCost,
            billing_scope: billingScope,
            billing_account_id: billingAccountId,
            reference_album_ids: generationReferenceAlbumIds,
            reference_image_ids: generationReferenceImageIds,
            source_type: requestSource.source_type,
            source_label: effectiveSourceLabel,
            source_request_id: sourceRequestId,
            source_metadata: sourceMetadata,
            paid_generation_guard: paidGenerationGuard.metadata,
          }),
        },
      });

      await recordTaskCostEstimate(tx, task, pricing, user.id);

      if (agentRun) {
        await tx.agentRun.update({
          where: { id: agentRun.id },
          data: {
            video_task_id: task.id,
            video_card_id: videoCard.id,
            status: 'submitted',
            selected_plan_key: selectedAgentPlanKey || undefined,
              final_prompt_snapshot: storedFinalPromptSnapshot,
            user_edited: promptUserEdited,
          },
        });
        if (selectedAgentPlanKey) {
          await tx.templateMemory.create({
            data: {
              template_id: generationTemplate?.id || agentRun.template_id,
              user_id: user.id,
              agent_run_id: agentRun.id,
              video_task_id: task.id,
              memory_type: 'plan_selected',
              signal: 'positive',
              summary: `用户选择了方案 ${selectedAgentPlanKey}`,
              metadata_json: JSON.stringify({ planKey: selectedAgentPlanKey, prompt_user_edited: promptUserEdited }),
            },
          });
        }
      }

      return task;
    });

    taskId = result.id;
    createdTask = result;
  } catch (err) {
    if (err instanceof CreditError) {
      if (err.code === 'INSUFFICIENT_PROJECT_BUDGET') {
        await prisma.$transaction((tx) => notifyProjectOwner(tx, {
          projectId: project.id,
          actorUserId: user.id,
          type: 'project_budget_insufficient',
          title: '项目预算不足',
          body: err.message,
          metadata: {
            attempted_cost: estimatedCost,
            video_card_id: videoCard.id,
          },
        })).catch((notificationError) => {
          console.error('[TasksCreate] Failed to notify project budget shortage:', notificationError);
        });
      }
      return NextResponse.json({ error: err.code, message: err.message }, { status: 400 });
    }
    throw err;
  }

  // --- Call provider DIRECTLY (no internal HTTP) ---
  let providerRequestId: string | null = null;
  try {
    providerInput.clientRequestId = taskId;
    providerInput.client_request_id = taskId;
    if (h3GeneratePayload) {
      h3GeneratePayload = {
        ...h3GeneratePayload,
        metadata: {
          ...(h3GeneratePayload.metadata || {}),
          external_task_id: taskId,
        },
      };
    }
    const providerIdempotencyKey = requestedProvider === H3_VIDEO_PROVIDER
      ? sourceRequestId || idempotencyKey || taskId
      : idempotencyKey || null;
    let callbackParamsJson: string | null = null;
    if (requestedProvider === 'seedance' && isFastPathDelivery) {
      const callbackConfig = resolveVideoDeliveryCallbackConfig({
        taskId,
        requestCallbackUrl,
        callbackSecret: process.env.VIDEO_DELIVERY_CALLBACK_SECRET || process.env.SEEDANCE_CALLBACK_SECRET || null,
      });
      providerInput.callback_url = callbackConfig.providerCallbackUrl;
      callbackParamsJson = mergeVideoDeliveryCallbackParams(JSON.stringify(taskParams), callbackConfig);
    } else if (requestCallbackUrl) {
      providerInput.callback_url = requestCallbackUrl;
    }

    await prisma.videoTask.update({
      where: { id: taskId },
      data: {
        provider_client_request_id: taskId,
        callback_url: providerInput.callback_url || null,
        ...(callbackParamsJson ? { params_json: callbackParamsJson } : {}),
      },
    });

    const providerRequest = await createProviderApiRequest({
      task: createdTask,
      endpoint: requestedProvider === H3_VIDEO_PROVIDER ? 'h3.generate' : 'seedance.createVideoTask',
      method: 'POST',
      idempotencyKey: providerIdempotencyKey,
      requestPayload: requestedProvider === H3_VIDEO_PROVIDER
        ? {
            ...h3GeneratePayload,
            source: {
              type: requestSource.source_type,
              label: effectiveSourceLabel,
              requestId: sourceRequestId,
              paidGenerationGuard: paidGenerationGuard.metadata,
            },
          }
        : {
            ...providerInput,
            source: {
              type: requestSource.source_type,
              label: effectiveSourceLabel,
              requestId: sourceRequestId,
              paidGenerationGuard: paidGenerationGuard.metadata,
            },
          },
    });
    providerRequestId = providerRequest.id;

    const providerResult = requestedProvider === H3_VIDEO_PROVIDER && h3GeneratePayload && h3Settings
      ? await createH3VideoJob(h3GeneratePayload, {
          baseUrl: h3Settings.base_url,
          apiToken: h3Settings.api_token || undefined,
          idempotencyKey: providerIdempotencyKey,
        })
      : await createVideoTask(providerInput);

    await prisma.videoTask.update({
      where: { id: taskId },
      data: {
        provider_task_id: providerResult.provider_task_id,
        raw_create_response: JSON.stringify(providerResult.raw),
        local_status: 'submitted',
      },
    });

    await markProviderApiRequestAccepted({
      requestId: providerRequest.id,
      task: { ...createdTask, provider_task_id: providerResult.provider_task_id },
      providerTaskId: providerResult.provider_task_id,
      responseSummary: {
        provider_task_id: providerResult.provider_task_id,
        response_keys: providerResult.raw && typeof providerResult.raw === 'object'
          ? Object.keys(providerResult.raw as Record<string, unknown>)
          : [],
      },
    });

    if (agentRun) {
      await prisma.$transaction(async (tx) => {
        await tx.agentRun.update({
          where: { id: agentRun.id },
          data: {
            status: 'submitted',
            video_task_id: taskId,
            final_prompt_snapshot: storedFinalPromptSnapshot,
            user_edited: promptUserEdited,
          },
        });
        await tx.agentRunStep.create({
          data: {
            agent_run_id: agentRun.id,
            step_key: requestedProvider === H3_VIDEO_PROVIDER ? 'h3_submit' : 'seedance_submit',
            title: requestedProvider === H3_VIDEO_PROVIDER ? 'H3 执行' : 'Seedance 执行',
            input_json: JSON.stringify({ task_id: taskId, template_id: generationTemplate?.id || null }),
            output_json: JSON.stringify({ provider_task_id: providerResult.provider_task_id, status: 'submitted' }),
            sort_order: 6,
          },
        });
        await tx.templateMemory.create({
          data: {
            template_id: generationTemplate?.id || agentRun.template_id,
            user_id: user.id,
            agent_run_id: agentRun.id,
            video_task_id: taskId,
            memory_type: 'task_result',
            signal: 'neutral',
            summary: requestedProvider === H3_VIDEO_PROVIDER ? '任务已提交 H3，等待生成结果回写' : '任务已提交 Seedance，等待生成结果回写',
            metadata_json: JSON.stringify({ provider: requestedProvider, provider_task_id: providerResult.provider_task_id }),
          },
        });
      });
    }

    startTaskLocalization(taskId, requestedProvider === H3_VIDEO_PROVIDER
      ? { initialDelayMs: 4000, intervalMs: 4000, maxRuntimeMs: 15 * 60 * 1000 }
      : isFastPathDelivery
        ? { cacheOnSuccess: false, generateThumbnail: false, enqueueDeliveryOnSuccess: true }
        : {});
    const referenceImageResizeSummary = buildReferenceImageResizeSummary(preparedImages);

    return NextResponse.json({
      id: taskId,
      provider: requestedProvider,
      provider_task_id: providerResult.provider_task_id,
      model: selectedModel,
      status: 'submitted',
      estimated_cost: estimatedCost,
      frozen_cost: estimatedCost,
      pricing,
      workspace_id: workspaceId,
      project_id: project.id,
      video_card_id: videoCard.id,
      template_id: generationTemplate?.id || null,
      agent_run_id: agentRun?.id || null,
      selected_agent_plan_key: selectedAgentPlanKey,
      billing_scope: billingScope,
      billing_account_id: billingAccountId,
      snapshot_id: snapshot.id,
      prompt_rendered: promptRendered,
      final_prompt_snapshot: storedFinalPromptSnapshot,
      asset_mapping: assetMapping,
      reference_album_ids: generationReferenceAlbumIds,
      reference_image_ids: generationReferenceImageIds,
      reference_image_notice: referenceImageResizeSummary
        ? `已自动把 ${referenceImageResizeSummary.resized_count} 张过大的参考图压缩到平台允许尺寸，原图不会被修改。`
        : null,
      reference_image_resize_summary: referenceImageResizeSummary,
      source_type: requestSource.source_type,
      source_label: effectiveSourceLabel,
      source_request_id: sourceRequestId,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    const providerFailureMessage = err instanceof Error
      ? err.message
      : requestedProvider === H3_VIDEO_PROVIDER ? 'H3 调用异常' : 'Seedance 调用异常';
    const userFacingFailure = providerCreateFailureUserMessage(providerFailureMessage);
    if (providerRequestId) {
      await markProviderApiRequestFailed({
        requestId: providerRequestId,
        errorCode: userFacingFailure.code,
        errorMessage: providerFailureMessage,
        responseSummary: {
          error: {
            code: userFacingFailure.code,
            user_message: userFacingFailure.message,
          },
          reference_media: buildReferenceMediaFailureSummary({
            preparedImages,
            imageUrls: finalReferenceImageUrls,
            referenceVideoUrls,
            referenceAudioUrls,
          }),
          h3_diagnostic: requestedProvider === H3_VIDEO_PROVIDER
            ? buildH3DiagnosticSnapshot({
                phase: 'create_failed',
                taskId,
                presetId: selectedModel,
                durationSec: duration,
                aspectRatio: ratio,
                localStatus: 'failed',
                errorCode: userFacingFailure.code,
                errorMessage: providerFailureMessage,
                httpStatus: err instanceof H3RequestError ? err.statusCode ?? null : null,
                retryAfterSeconds: err instanceof H3RequestError ? err.retryAfterSeconds ?? null : null,
                health: h3Settings?.health || null,
                queue: h3Settings?.health?.queue || null,
                raw: err instanceof H3RequestError ? err.raw : null,
              })
            : undefined,
        },
      }).catch(() => {});
    }
    await handleProviderFailure(
      taskId,
      user.id,
      estimatedCost,
      userFacingFailure.message,
    );
    if (agentRun) {
      await prisma.$transaction(async (tx) => {
        await tx.agentRun.update({
          where: { id: agentRun.id },
          data: {
            status: 'failed',
            error_message: userFacingFailure.message,
            completed_at: new Date(),
          },
        });
        await tx.agentRunStep.create({
          data: {
            agent_run_id: agentRun.id,
            step_key: requestedProvider === H3_VIDEO_PROVIDER ? 'h3_failed' : 'seedance_failed',
            title: requestedProvider === H3_VIDEO_PROVIDER ? 'H3 执行失败' : 'Seedance 执行失败',
            input_json: JSON.stringify({ task_id: taskId }),
            output_json: JSON.stringify({
              error: userFacingFailure.code,
              message: userFacingFailure.message,
            }),
            sort_order: 6,
          },
        });
        await tx.templateMemory.create({
          data: {
            template_id: generationTemplate?.id || agentRun.template_id,
            user_id: user.id,
            agent_run_id: agentRun.id,
            video_task_id: taskId,
            memory_type: 'task_result',
            signal: 'negative',
            summary: requestedProvider === H3_VIDEO_PROVIDER ? 'H3 提交失败，未消耗点数' : 'Seedance 提交失败，已返还冻结点数',
            metadata_json: JSON.stringify({
              error: userFacingFailure.code,
              message: userFacingFailure.message,
            }),
          },
        });
      }).catch(() => {});
    }
    return NextResponse.json(
      {
        error: userFacingFailure.code,
        message: userFacingFailure.message,
        task_id: taskId,
      },
      { status: userFacingFailure.status },
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
    const existingSettlement = await tx.creditLedger.findFirst({
      where: {
        related_task_id: taskId,
        type: { in: ['task_success_deduct', 'task_failed_refund'] },
      },
    });
    if (existingSettlement) return;

    const taskBeforeSettlement = await tx.videoTask.findUnique({ where: { id: taskId } });
    if (!taskBeforeSettlement) return;

    const consumedApprovals = await tx.approvalUsage.findMany({
      where: { task_id: taskId },
      select: { approval_id: true },
    });
    if (consumedApprovals.length > 0) {
      await tx.approvalUsage.deleteMany({ where: { task_id: taskId } });
      for (const usage of consumedApprovals) {
        await tx.approvalRecord.updateMany({
          where: { id: usage.approval_id, used_count: { gt: 0 } },
          data: { used_count: { decrement: 1 } },
        });
      }
    }

    await tx.videoTask.update({
      where: { id: taskId },
      data: {
        local_status: 'failed',
        error_message: errorMessage,
        error_code: 'PROVIDER_CREATE_FAILED',
        completed_at: new Date(),
      },
    });

    const effectiveFrozenAmount = Math.max(0, Number(taskBeforeSettlement.frozen_cost ?? frozenAmount ?? 0));
    if (effectiveFrozenAmount <= 0) {
      const failedTask = await tx.videoTask.update({
        where: { id: taskId },
        data: {
          frozen_cost: 0,
          actual_cost: 0,
          refund_amount: 0,
        },
      });

      await recordTaskCostSettlement(tx, failedTask, 'failed', userId);
      return;
    }

    if (taskBeforeSettlement.billing_scope === 'project' && taskBeforeSettlement.project_id) {
      const settlement = await settleProjectTaskBudget(tx, {
        projectId: taskBeforeSettlement.project_id,
        taskId,
        terminalStatus: 'failed',
        frozenAmount: effectiveFrozenAmount,
        freezeSnapshot: taskBeforeSettlement.credit_freeze_snapshot,
        operatorId: userId,
      });

      const failedTask = await tx.videoTask.update({
        where: { id: taskId },
        data: {
          frozen_cost: 0,
          actual_cost: 0,
          refund_amount: settlement.refundedAmount,
        },
      });

      await recordTaskCostSettlement(tx, failedTask, 'failed', userId);
      return;
    }

    const settlement = await settleTaskCredits(tx, {
      taskId,
      userId,
      terminalStatus: 'failed',
      frozenAmount: effectiveFrozenAmount,
      freezeSnapshot: taskBeforeSettlement.credit_freeze_snapshot,
    });

    const failedTask = await tx.videoTask.update({
      where: { id: taskId },
      data: {
        frozen_cost: 0,
        actual_cost: 0,
        refund_amount: settlement.refundedAmount,
      },
    });

    await tx.creditLedger.create({
      data: {
        user_id: userId,
        type: 'task_failed_refund',
        amount: settlement.refundedAmount,
        balance_before: settlement.balanceBefore,
        balance_after: settlement.balanceAfter,
        frozen_before: settlement.frozenBefore,
        frozen_after: settlement.frozenAfter,
        related_task_id: taskId,
        reason: `任务创建失败，返还冻结 ${settlement.refundedAmount} 点`,
        metadata_json: JSON.stringify({
          allocations: settlement.allocations,
          expired_closed: settlement.expiredClosedAmount,
          source_metadata: parseJsonRecord(taskBeforeSettlement.source_metadata_json),
        }),
      },
    });

    await recordTaskCostSettlement(tx, failedTask, 'failed', userId);
  });
}

// --- Reference image preparation (extracted from /api/video/create) ---
interface PreparedRefImage {
  name: string;
  originalUrl: string;
  sourceType: 'upload' | 'gallery' | 'external';
  order: number;
  width?: number | null;
  height?: number | null;
  providerSafeResize?: {
    originalWidth?: number;
    originalHeight?: number;
    outputWidth?: number;
    outputHeight?: number;
    originalPixels?: number;
    maxPixels?: number;
  };
}

function buildReferenceImageResizeSummary(preparedImages: PreparedRefImage[]) {
  const resizedItems = preparedImages.filter((image) => image.providerSafeResize);
  if (resizedItems.length === 0) return null;
  return {
    resized_count: resizedItems.length,
    max_pixels: PROVIDER_REFERENCE_IMAGE_MAX_PIXELS,
    items: resizedItems.map((image) => ({
      name: image.name,
      original_width: image.providerSafeResize?.originalWidth ?? null,
      original_height: image.providerSafeResize?.originalHeight ?? null,
      output_width: image.providerSafeResize?.outputWidth ?? null,
      output_height: image.providerSafeResize?.outputHeight ?? null,
      original_pixels: image.providerSafeResize?.originalPixels ?? null,
      max_pixels: image.providerSafeResize?.maxPixels ?? PROVIDER_REFERENCE_IMAGE_MAX_PIXELS,
    })),
  };
}

function buildReferenceImagePreparationFailure(prepareErrors: string[]) {
  const joinedErrors = prepareErrors.join('；');
  if (isProviderReferenceImageSizeError(joinedErrors)) {
    return {
      error: 'REFERENCE_IMAGE_TOO_LARGE',
      message: '参考图尺寸过大，系统已尝试自动压缩到合规尺寸，但这张图处理失败。请换一张更小的图，或先压缩后再提交。',
    };
  }
  return {
    error: 'REFERENCE_IMAGE_NOT_PUBLIC',
    message: '参考图无法生成公网 URL，请换一张可访问的图片后重试。',
  };
}

async function prepareReferenceImages(
  workspaceId: string,
  preferredReferenceImageIds: string[] = [],
  preferredReferenceImageUrls: string[] = [],
  ownerId: string,
): Promise<{
  preparedImages: PreparedRefImage[];
  prepareErrors: string[];
  summary: { total: number; publicUrl: number; r2Uploaded: number; skipped: number; hasLocalPath: boolean };
}> {
  const selectedIds = uniquePreserveOrder(preferredReferenceImageIds);
  const selectedReferenceImageUrls = uniquePreserveOrder(preferredReferenceImageUrls);
  const prepareErrors: string[] = [];
  let skipped = 0;

  let imageItems: Array<{
    asset: {
      id: string;
      file_name: string | null;
      original_url: string;
      type: string;
      width: number | null;
      height: number | null;
      mime_type: string | null;
    } | null;
    originalUrl: string;
  }> = [];

  const workspaceReferenceAssets = await prisma.workspaceAsset.findMany({
    where: { workspace_id: workspaceId },
    include: { asset: true },
    orderBy: { sort_order: 'asc' },
  });

  if (selectedIds.length > 0) {
    const workspaceMap = new Map<string, NonNullable<typeof workspaceReferenceAssets[number]['asset']>>();
    for (const wa of workspaceReferenceAssets) {
      if (wa.reference_image_id) {
        workspaceMap.set(wa.reference_image_id, wa.asset);
      }
    }

    for (const referenceImageId of selectedIds) {
      const asset = workspaceMap.get(referenceImageId);
      if (!asset) {
        prepareErrors.push(`[${referenceImageId}] 参考图未在当前生成工作台内`);
        skipped += 1;
        continue;
      }

      if (asset.type !== 'image') {
        prepareErrors.push(`[${referenceImageId}] 参考图素材不是图片`);
        skipped += 1;
        continue;
      }

      imageItems.push({ asset, originalUrl: asset.original_url });
    }
  } else if (selectedReferenceImageUrls.length > 0) {
    const matchedAssets = await prisma.asset.findMany({
      where: { original_url: { in: selectedReferenceImageUrls } },
    });
    const matchedByUrl = new Map(matchedAssets.map((asset) => [asset.original_url, asset]));

    for (const rawUrl of selectedReferenceImageUrls) {
      const asset = matchedByUrl.get(rawUrl) ?? null;
      if (asset && asset.type !== 'image') {
        prepareErrors.push(`[${rawUrl}] 参考图素材不是图片`);
        skipped += 1;
        continue;
      }
      imageItems.push({ asset: asset ? {
        id: asset.id,
        file_name: asset.file_name,
        original_url: asset.original_url,
        type: asset.type,
        width: asset.width,
        height: asset.height,
        mime_type: asset.mime_type,
      } : null, originalUrl: rawUrl });
    }
  } else {
    imageItems = workspaceReferenceAssets
      .filter((item) => item.asset.type === 'image')
      .map((item) => ({ asset: {
        id: item.asset.id,
        file_name: item.asset.file_name,
        original_url: item.asset.original_url,
        type: item.asset.type,
        width: item.asset.width,
        height: item.asset.height,
        mime_type: item.asset.mime_type,
      }, originalUrl: item.asset.original_url }));
  }

  const preparedImages: PreparedRefImage[] = [];
  let publicUrl = 0;
  let r2Uploaded = 0;
  let hasLocalPath = false;

  for (let i = 0; i < imageItems.length; i++) {
    const item = imageItems[i];
    const originalUrl = item.originalUrl;
    const isPublicUrl = originalUrl.startsWith('https://') && !isLocalhostHost(originalUrl);
    const isR2 = originalUrl.includes('.r2.') || originalUrl.includes('r2.dev') || originalUrl.includes('.toscdn.');
    const isLocalPath = originalUrl.startsWith('/');

    if (isPublicUrl) {
      let providerUrl = originalUrl;
      let sourceType: PreparedRefImage['sourceType'] = isR2 ? 'upload' : 'external';
      let providerSafeResize: PreparedRefImage['providerSafeResize'];
      const shouldResize = Boolean(getProviderSafeImageResizeDimensions(item.asset?.width, item.asset?.height));
      let safeWidth = item.asset?.width ?? null;
      let safeHeight = item.asset?.height ?? null;
      try {
        const safeReference = await ensureProviderSafeReferenceImageUrl({ originalUrl, asset: item.asset, ownerId });
        providerUrl = safeReference.providerUrl;
        safeWidth = safeReference.outputWidth ?? safeReference.width ?? safeWidth;
        safeHeight = safeReference.outputHeight ?? safeReference.height ?? safeHeight;
        if (safeReference.resized) {
          r2Uploaded += 1;
          sourceType = 'upload';
          providerSafeResize = {
            originalWidth: safeReference.width,
            originalHeight: safeReference.height,
            outputWidth: safeReference.outputWidth,
            outputHeight: safeReference.outputHeight,
            originalPixels: safeReference.originalPixels,
            maxPixels: safeReference.maxPixels,
          };
        }
      } catch (error) {
        skipped += 1;
        const rawMessage = error instanceof Error ? error.message : String(error);
        const message = shouldResize || isProviderReferenceImageSizeError(rawMessage)
          ? providerReferenceImageSizeMessage(rawMessage)
          : `参考图处理失败: ${rawMessage}`;
        prepareErrors.push(`[${i + 1}] ${message}`);
        continue;
      }
      publicUrl += 1;
      preparedImages.push({
        name: item.asset?.file_name || `图${i + 1}`,
        originalUrl: providerUrl,
        sourceType,
        order: i,
        width: safeWidth,
        height: safeHeight,
        providerSafeResize,
      });
      continue;
    }

    if (isLocalPath) {
      hasLocalPath = true;
      const localFilePath = path.join(process.cwd(), 'public', originalUrl.replace(/^\/+/, ''));
      if (!fs.existsSync(localFilePath)) {
        skipped += 1;
        prepareErrors.push(`[${i + 1}] 本地文件不存在: ${originalUrl}`);
        continue;
      }

      let providerUrl: string | null = null;
      try {
        if (item.asset?.id) {
          const result = await ensureSiteAssetPublicUrl(item.asset.id);
          providerUrl = result.asset.original_url;
        } else {
          providerUrl = sameOriginPublicUrlForLocalUpload(originalUrl);
          if (!providerUrl) throw new Error(`本地素材没有可用公网地址: ${originalUrl}`);
        }
      } catch (err) {
        skipped += 1;
        prepareErrors.push(`[${i + 1}] 本地素材公网链接准备失败: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      r2Uploaded += 1;
      preparedImages.push({
        name: item.asset?.file_name || `图${i + 1}`,
        originalUrl: providerUrl,
        sourceType: 'upload',
        order: i,
        width: item.asset?.width ?? null,
        height: item.asset?.height ?? null,
      });
      continue;
    }

    skipped += 1;
    prepareErrors.push(`[${i + 1}] 非公网 URL: ${originalUrl}`);
  }

  return {
    preparedImages,
    prepareErrors,
    summary: {
      total: selectedIds.length > 0
        ? selectedIds.length
        : selectedReferenceImageUrls.length > 0
          ? selectedReferenceImageUrls.length
          : imageItems.length,
      publicUrl,
      r2Uploaded,
      skipped,
      hasLocalPath,
    },
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
