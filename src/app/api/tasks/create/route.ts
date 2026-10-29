import { NextRequest, NextResponse } from 'next/server';
import { CreationError, isCreationV2 } from '@/lib/creation/contract';
import { assertVideoCreationReady } from '@/lib/creation/context';
import { assertLegacyCreationSourceLocks } from '@/lib/creation/lineage';
import { acceptVideoCreationIntent } from '@/lib/creation/intents';
import { enqueueVideoFeishuNotification } from '@/lib/video/feishu-notification';
import { VideoFeishuError } from '@/lib/video/feishu-contract';
import { assertVideoPromptGroupSurface, hasVideoPromptGroups, VideoPromptGroupError } from '@/lib/video/prompt-groups';
import { resolveVideoPromptGroups } from '@/lib/video/prompt-groups.server';
import { protectVideoPromptGroupTask } from '@/lib/video/prompt-group-execution.server';
import { assertPrivateH3Destination } from '@/lib/provider/h3';
import { videoFeishuErrorText } from '@/lib/video/feishu-errors';
import { MULTIVIEW_GENERATION_WRITES_ENABLED } from '@/lib/video/multiview-build-mode';
import { compileCanvasVideoPrompt } from '@/lib/canvas-video-prompt';
import { restoreCanvasVideoBatchCreate, assertCanvasVideoAdmission, bindCanvasVideoBatchTask,
  assertCanvasVideoBatchDedupe, recordCanvasVideoBatchRejection, canvasVideoBatchTaskResponse,
  CanvasVideoBatchError, type CanvasVideoAdmission } from '@/lib/canvas-video-batches-guards';
import { assertCanvasPromptCompatibility } from '@/lib/canvas-prompt-compatibility';
import { parseCanvasPromptMentions, compileCanvasPromptReferences, CanvasPromptReferenceError } from '@/lib/canvas-prompt-references';
import { resolveImageInputUrls } from '@/lib/assets/original-image-input';
import { multiviewRequestIntent, claimMultiviewRequest, assertMultiviewRequestFence, acceptMultiviewRequest,
  rejectMultiviewRequest, type MultiviewRequestClaim } from '@/lib/video/multiview-request-receipt';
import { consumeMultiview1080pApproval, hasMultiview1080pApproval, restoreMultiview1080pApproval, MULTIVIEW_1080P_APPROVAL_REQUIRED,
  MULTIVIEW_1080P_REQUIRED_MESSAGE } from '@/lib/video/multiview-1080p-approval';
import { composeMultiviewGenerationPrompt, MULTIVIEW_REFERENCE_PROMPT_PREFIX, isMultiviewGenerationSeed, parseMultiviewGenerationSnapshot,
  type MultiviewGenerationSnapshot, type MultiviewRotationPreset } from '@/lib/video/multiview-generation-contract';
import { readMultiviewRotationPresetVersion, MultiviewPresetError } from '@/lib/video/multiview-preset.server';
import { assertMultiviewGenerationSettings, MultiviewSettingsError } from '@/lib/video/multiview-settings.server';
import { readMultiviewSystemReference } from '@/lib/video/multiview-recipe-storage.server';
import { consumeTrustedMultiviewRetry, readSafePrivateMultiviewInput } from '@/lib/video/multiview-private-create.server';
import { isPrivateMultiviewTask, isPrivateMultiviewActionTask, multiviewPrivateTaskMarker, multiviewActionPrivateTaskMarker,
  MULTIVIEW_ACTION_PUBLIC_TASK_TITLE, projectPrivateMultiviewTask } from '@/lib/video/multiview-task-privacy';
import { resolveMultiviewActionVideoInput, multiviewActionVideoFingerprint, protectMultiviewActionVideoTask,
  multiviewActionRequestId } from '@/lib/video/multiview-action-video.server';
import { parseMultiviewActionBinding, type MultiviewActionBinding } from '@/lib/video/multiview-action-contract';
import { registerMultiviewWorkIntent } from '@/lib/video/multiview-works';
import { assertCanEditCanvasDocument } from '@/lib/canvas-documents';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { prisma } from '@/lib/prisma';
import { inheritUsageAttribution, recordUsageAttribution } from '@/lib/admin/usage-attribution';
import { getSessionUser, errorJson } from '@/lib/auth/api-helpers';
import { quoteVideoPricing, requireVideoPricingRevision, assertVideoPricingAcceptance, publicVideoPricing, videoPricingError, type VideoPricingQuote } from '@/lib/pricing/video';
import { resolveVideoPricingContext, verifyVideoPricingCredential, videoPricingRequiresContext, videoPricingBusinessFingerprint, assertVideoPricingFinalReferences, normalizedVideoPricingReferenceScope, type VideoPricingContext } from '@/lib/pricing/video-context';
import { addAssetToWorkspace, getOrCreateWorkspace } from '@/lib/assets/workspace';
import { validatePromptReferences, renderPromptWithAssets } from '@/lib/assets/collection';
import { createTaskSnapshot } from '@/lib/assets/snapshot';
import { randomUUID } from 'node:crypto';
import { transformPrivateVideoText } from '@/lib/video/private-storage.server';
import { assertPrivateSeedanceDestination } from '@/lib/provider/jimeng';
import { PrivatePromptError } from '@/lib/security/private-prompts.server';
import {
  exceedsGenerationPromptLimit,
  GENERATION_PROMPT_LIMIT_MESSAGE,
  generationPromptLimitMessage,
} from '@/lib/prompt/limits';
import { createVideoTask, buildContentArray, isApiKeyConfigured } from '@/lib/provider/jimeng';
import type { ProviderCreateDiagnostic } from '@/lib/provider/create-diagnostic';
import { seedanceLocalReferenceTransport } from '@/lib/provider/reference-image-transport';
import { parseSeedanceVideoModel, seedanceRatioFollowsFirstFrame, isSeedanceVideoDuration, seedanceVideoDurationError } from '@/lib/provider/seedance-models';
import {
  validateSeedanceEditMode,
  validateSeedanceEditReference,
  seedanceVideoEditParameters,
  normalizeSeedanceEditPilot,
  isSeedanceEditPilotAllowed,
  validateRequestCostCeiling,
  type SeedanceProviderInput,
  type SeedanceEditReference,
} from '@/lib/provider/seedance-video-edit';
import {
  canCreateSeedanceDraft,
  isSeedanceDraftCreateEnabled,
  SEEDANCE_DRAFT_CONTRACT_VERSION,
} from '@/lib/provider/seedance-draft';
import {
  H3_VIDEO_PROVIDER,
  H3RequestError,
  createH3VideoJob,
  type H3GeneratePayload,
} from '@/lib/provider/h3';
import { buildH3DiagnosticSnapshot } from '@/lib/provider/h3-diagnostics';
import { uploadH3ReferenceImagesForTask } from '@/lib/provider/h3-assets';
import {
  getH3ApiSettings,
  h3LoraOptionToPayload,
  isH3Operational,
  isH3PresetId,
  resolveH3LoraOption,
} from '@/lib/integrations/h3';
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
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { assertFeatureAllowed } from '@/lib/access/feature-guard';
import { getProjectForGeneration, assertCanViewTask, assertProjectActiveInTransaction } from '@/lib/projects/permissions';
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
import { authorizeStudioAssets } from '@/lib/template-studio/assets';
import {
  isVideoDeliveryFastPathTask,
  mergeVideoDeliveryCallbackParams,
  resolveVideoDeliveryCallbackConfig,
} from '@/lib/video/delivery-policy';
import type { CreateVideoInput, GenerationMode, VideoResolution, VideoDuration } from '@/types';
import { authorizeStudioRunForGeneration } from '@/lib/template-studio/handoff';
import { StudioError } from '@/lib/template-studio/errors';
import type { StudioAssetInput, StudioGenerationHandoff, StudioJsonValue } from '@/lib/template-studio/types';
import { generationRequestFingerprint } from '@/lib/template-studio-video-fingerprint';
import { applyCanvasReferenceInputs, resolveCanvasReferenceInputs } from '@/lib/canvas-reference-inputs';
import { bindRoleMediaTask, roleMediaFingerprint } from '@/lib/canvas-roles/media-bindings';
import {
  buildStudioTaskSnapshot,
  decideGenerationIdempotency,
  getStudioMaterialCompatibilityError,
  getMissingRequiredStudioAssetSlot,
  getUnknownStudioVideoParameterKeys,
} from '@/lib/template-studio-video-handoff';

const VALID_GENERATION_MODES: GenerationMode[] = [
  'all_in_one_reference',
  'first_last_frame',
  'smart_multi_frame',
];
const VALID_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
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

function protectedMultiviewTaskPayload<T extends object & { source_metadata_json: string | null; local_status?: string }>(
  task: T,
  extra: Record<string, unknown> = {},
) {
  const projected = projectPrivateMultiviewTask(task) as unknown as Record<string, unknown>;
  return { ...projected, ...(projected.local_status ? { status: projected.local_status } : {}), ...extra };
}

function privateNoStore() {
  return { 'Cache-Control': 'private, no-store' };
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
  onVideoProbed?: (reference: SeedanceEditReference) => void;
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
        if (probed.width && probed.height && durationSeconds != null) {
          input.onVideoProbed?.({ url, width: probed.width, height: probed.height, durationSeconds });
        }
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
  let user: SessionUser;
  let editPilotSettings: unknown;
  let requestSource: GenerationRequestSource = webRequestSource(request);

  if (hasCodexApiAuthSignal(request)) {
    try {
      const codexContext = await authenticateCodexVideoApi(request);
      user = codexContext.user;
      requestSource = codexContext.source;
      editPilotSettings = codexContext.settings.video_edit_pilot;
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
  const expectedActor = request.headers.get('x-app-session-user');
  if (expectedActor && expectedActor !== user.id) return NextResponse.json({ error: '账号已变化，请重新确认当前账号；原输入保留，尚未生成', code: 'pricing_actor_changed' }, { status: 409 });
  try {
    // Codex API 绑定用户由后台管理员显式配置，允许内部普通服务账号
    // 复用普通生成链路；普通邮箱网页登录仍继续走外部账号收口规则。
    const isCodexInternalServiceUser = requestSource.source_type === 'codex_api'
      && user.account_type === 'internal';
    if (!isCodexInternalServiceUser) {
      assertFeatureAllowed(user, 'standard_generate', '外部账号无权使用普通生成，请使用 IP 生成。');
    }
  } catch (error) {
    if (error instanceof AuthError) return errorJson(error.message, error.status);
    throw error;
  }

  const trustedMultiviewRetry = consumeTrustedMultiviewRetry(request);
  let trustedMultiviewSourceTask: {
    id: string; source_metadata_json: string | null; params_json: string | null;
    project_id: string | null; video_card_id: string | null; video_branch_id: string | null;
    owner_user_id: string | null; user_id: string | null; workspace_id: string | null;
    local_status: string; error_code: string | null; frozen_cost: number | null;
    provider: string; model: string; generation_mode: string; prompt: string; final_prompt_snapshot: string | null;
    ratio: string | null; duration: number | null; resolution: string | null; seed: number | null;
    generate_audio: boolean; return_last_frame: boolean; watermark: boolean; reference_image_ids: string | null;
  } | null = null;
  let receivedBody = await request.json();
  if (!receivedBody || typeof receivedBody !== 'object' || Array.isArray(receivedBody)) return errorJson('视频输入无效', 400);
  if (typeof receivedBody.idempotency_key === 'string' && receivedBody.idempotency_key) {
    const original = await prisma.videoTask.findUnique({ where: { user_id_idempotency_key: {
      user_id: user.id, idempotency_key: receivedBody.idempotency_key,
    } } });
    // Frozen batch inputs and legacy fingerprints still use their original validators below.
    if (original?.request_fingerprint?.startsWith('pricing-v2:')
      && receivedBody.canvas_video_batch === undefined && !receivedBody.idempotency_key.startsWith('cvb:')) {
      await assertCanViewTask(user, original);
      if (original.request_fingerprint !== (isPrivateMultiviewActionTask(original) ? multiviewActionVideoFingerprint(receivedBody)
        : videoPricingBusinessFingerprint(receivedBody))) return NextResponse.json({ error: '原请求内容不同，请查询原任务；未重新生成', code: 'IDEMPOTENCY_PAYLOAD_MISMATCH', existing_task_id: original.id }, { status: 409 });
      return isPrivateMultiviewTask(original) || hasVideoPromptGroups(original)
        ? NextResponse.json(protectedMultiviewTaskPayload(original, { deduplicated: true, fingerprint_verified: true }), { headers: privateNoStore() })
        : NextResponse.json(canvasVideoBatchTaskResponse(original));
    }
  }
  if (trustedMultiviewRetry) {
    const original = await prisma.videoTask.findUnique({ where: { id: trustedMultiviewRetry.originalTaskId }, select: {
      id: true, source_metadata_json: true, params_json: true, project_id: true, video_card_id: true, video_branch_id: true,
      owner_user_id: true, user_id: true, workspace_id: true, local_status: true, error_code: true, frozen_cost: true,
      provider: true, model: true, generation_mode: true, prompt: true, final_prompt_snapshot: true,
      ratio: true, duration: true, resolution: true, seed: true, generate_audio: true, return_last_frame: true,
      watermark: true, reference_image_ids: true,
    } });
    if (!original || (original.owner_user_id || original.user_id) !== user.id) {
      return NextResponse.json({ error: 'MULTIVIEW_PRIVATE_RETRY_DENIED', message: '原任务不存在或不属于当前账号，未重新提交。' },
        { status: 403, headers: privateNoStore() });
    }
    if (original.local_status !== 'failed' || original.error_code?.includes('UNCONFIRMED') || original.frozen_cost !== 0) {
      return NextResponse.json({ error: 'MULTIVIEW_PRIVATE_RETRY_NOT_READY', message: '原请求尚未确认失败，请查询原任务；未重新生成。' },
        { status: 409, headers: privateNoStore() });
    }
    let frozen: ReturnType<typeof readSafePrivateMultiviewInput>;
    try { frozen = readSafePrivateMultiviewInput(original); }
    catch {
      return NextResponse.json({ error: 'MULTIVIEW_PRIVATE_RETRY_UNAVAILABLE', message: '原任务的受保护生成设置无法确认，未恢复或重新提交。' },
        { status: 409, headers: privateNoStore() });
    }
    if (!original.workspace_id || original.video_branch_id || frozen.projectId !== original.project_id
      || frozen.videoCardId !== original.video_card_id || frozen.recipeVersion !== frozen.snapshot.presetVersion) {
      return NextResponse.json({ error: 'MULTIVIEW_PRIVATE_RETRY_UNAVAILABLE', message: '原任务的归属或冻结设置不完整，未恢复或重新提交。' },
        { status: 409, headers: privateNoStore() });
    }
    trustedMultiviewSourceTask = transformPrivateVideoText('video-task', original,
      ['prompt', 'final_prompt_snapshot'], false, true);
    receivedBody = {
      provider: 'seedance', model: frozen.model, generation_mode: 'all_in_one_reference', ratio: frozen.ratio,
      duration: frozen.duration, resolution: frozen.resolution, seed: frozen.seed,
      generate_audio: frozen.generateAudio, return_last_frame: frozen.returnLastFrame, watermark: frozen.watermark,
      draft: false, project_id: frozen.projectId, ...(frozen.videoCardId ? { video_card_id: frozen.videoCardId } : {}),
      reference_image_ids: [frozen.snapshot.mainReferenceImageId], reference_video_urls: [], reference_audio_urls: [],
      resolution_approval_confirmed: frozen.resolutionApprovalConfirmed,
      idempotency_key: trustedMultiviewRetry.idempotencyKey,
      max_estimated_cost: trustedMultiviewRetry.maxEstimatedCost,
      ...(trustedMultiviewRetry.pricingRevision ? { pricing_revision: trustedMultiviewRetry.pricingRevision } : {}),
      ...(trustedMultiviewRetry.pricingQuoteToken ? {
        pricing_quote_token: trustedMultiviewRetry.pricingQuoteToken, pricing_fingerprint_version: 2,
      } : {}),
      client_name: 'multiview', source_metadata: { source: 'multiview', mode: 'rotation' },
      multiview_generation: frozen.snapshot,
    };
  }
  let actionRequestClaim: MultiviewRequestClaim | null = null;
  if (receivedBody.multiview_action !== undefined) {
    const actionBinding = parseMultiviewActionBinding(receivedBody.multiview_action);
    if (actionBinding && receivedBody.idempotency_key === multiviewActionRequestId(actionBinding.runId)) {
      try {
        const admission = await claimMultiviewRequest(user.id, receivedBody.idempotency_key, receivedBody);
        if (admission.kind === 'blocked') return NextResponse.json({ error: admission.receipt?.code || 'MULTIVIEW_REQUEST_PENDING',
          message: admission.receipt?.message || '提交结果待确认，请查询原请求号', safeToResubmit: false,
          ...(admission.receipt ? { request_receipt: admission.receipt, new_request_allowed: true } : {}) },
        { status: admission.status, headers: privateNoStore() });
        if (admission.kind === 'claimed') actionRequestClaim = admission.claim;
        if (admission.kind === 'task_exists') {
          const original = await prisma.videoTask.findUnique({ where: { user_id_idempotency_key: { user_id: user.id, idempotency_key: receivedBody.idempotency_key } } });
          if (!original) throw new Error('Original task unavailable');
          await assertCanViewTask(user, original);
          if (!isPrivateMultiviewActionTask(original) || original.request_fingerprint !== multiviewActionVideoFingerprint(receivedBody)) return errorJson('原请求内容不同，请查询原任务；未重新生成', 409);
          return NextResponse.json(protectedMultiviewTaskPayload(original, { deduplicated: true }), { headers: privateNoStore() });
        }
      } catch { return NextResponse.json({ error: 'MULTIVIEW_REQUEST_UNKNOWN', message: '原提交结果暂时无法确认，请查询原请求号，不要重新提交。', safeToResubmit: false }, { status: 503, headers: privateNoStore() }); }
    }
  }
  async function sealActionRejection(response: NextResponse) {
    if (!actionRequestClaim || response.status < 400 || response.status >= 500) return response;
    const payload = await response.clone().json().catch(() => null);
    if (payload?.id || payload?.task_id || payload?.existing_task_id) return response;
    const receipt = await rejectMultiviewRequest(actionRequestClaim, response.status, payload);
    return receipt ? NextResponse.json({ ...payload, request_receipt: receipt, new_request_allowed: true, safeToResubmit: false },
      { status: response.status, headers: privateNoStore() }) : response;
  }
  let multiviewAction: Awaited<ReturnType<typeof resolveMultiviewActionVideoInput>> = null;
  let actionImageForTransport: Parameters<typeof seedanceLocalReferenceTransport>[1][number] | null = null;
  try {
    if (typeof receivedBody.idempotency_key === 'string' && receivedBody.idempotency_key.startsWith('multiview-action:')
      && receivedBody.multiview_action === undefined) throw new AuthError('动作视频原请求必须保留冻结绑定，请查询原任务', 409);
    multiviewAction = await resolveMultiviewActionVideoInput(user, receivedBody, prisma, receivedBody.multiview_action !== undefined);
    if (multiviewAction) receivedBody = multiviewAction.body;
  } catch (error) {
    if (error instanceof AuthError || error instanceof StudioError || error instanceof PrivatePromptError) return sealActionRejection(NextResponse.json({ error: error.message,
      ...('code' in error ? { code: error.code } : {}) }, { status: error.status, headers: privateNoStore() }));
    throw error;
  }
  let restoredBatch: Awaited<ReturnType<typeof restoreCanvasVideoBatchCreate>>;
  try { restoredBatch = await restoreCanvasVideoBatchCreate(user, receivedBody, 'ordinary'); }
  catch (error) {
    if (error instanceof CanvasVideoBatchError) return NextResponse.json({ error: error.message, code: error.code, ...error.details }, { status: error.status });
    throw error;
  }
  if (restoredBatch.existingTask) return NextResponse.json(canvasVideoBatchTaskResponse(restoredBatch.existingTask));
  // Existing validators deliberately normalize this local input after server restoration.
  const body = restoredBatch.body as typeof receivedBody;
  let canvasInputs: Awaited<ReturnType<typeof resolveCanvasReferenceInputs>> = null;
  const originalCanvasRequest = body.idempotency_key ? await prisma.videoTask.findUnique({ where: { user_id_idempotency_key: { user_id: user.id, idempotency_key: body.idempotency_key } }, select: { id: true } }) : null;
  if (!originalCanvasRequest) {
    try { canvasInputs = await resolveCanvasReferenceInputs(user, body, prisma, { target: 'video' }); Object.assign(body, applyCanvasReferenceInputs(body, canvasInputs)); }
    catch (error) { if (error instanceof AuthError) return errorJson(error.message, error.status); throw error; }
  }
  // Freeze the user's v2 spec BEFORE existing provider normalization/private prompt composition.
  const creationBody = structuredClone(body);
  if (multiviewAction) {
    const asset = await prisma.asset.findFirst({ where: { id: multiviewAction.action.assetId, owner_id: user.id, status: 'active', type: 'image' } });
    if (!asset) return sealActionRejection(errorJson('参考拼图素材已不可用，原动作与布局保留', 409));
    const prepared = await ensureSiteAssetPublicUrl(asset.id);
    if (!prepared.isPubliclyReachable) return sealActionRejection(errorJson('参考拼图暂时无法提供给视频服务，尚未生成', 409));
    actionImageForTransport = { url: prepared.asset.original_url, asset: { ...asset, original_url: prepared.asset.original_url } };
    body.first_frame_url = prepared.asset.original_url;
    body.prompt = multiviewAction.action.prompt;
    body.final_prompt_snapshot = multiviewAction.action.prompt;
  }
  let creationV2 = false;
  try { creationV2 = isCreationV2(body); if (creationV2) await assertVideoCreationReady(); }
  catch (error) {
    if (error instanceof CreationError) return sealActionRejection(NextResponse.json({ error: error.message, code: error.code, stage: 'validation', attemptedSend: false }, { status: error.status }));
    throw error;
  }
  const canvasAdmission: CanvasVideoAdmission | null = restoredBatch.admission;
  let response: NextResponse;
  try { response = await runCanvasAdmission(); }
  catch (error) {
    if (error instanceof VideoPromptGroupError || error instanceof StudioError || error instanceof PrivatePromptError) return NextResponse.json({ error: error.message, code: error.code },
      { status: error.status, headers: privateNoStore() });
    if (error instanceof CreationError) return NextResponse.json({ error: error.message, code: error.code, field: error.field, action: error.action }, { status: error.status });
    if (!(error instanceof CanvasVideoBatchError)) throw error;
    response = NextResponse.json({ error: error.message, code: error.code, ...error.details }, { status: error.status });
  }
  if (canvasAdmission && response.status >= 400) {
    await recordCanvasVideoBatchRejection(user, canvasAdmission, response.status, await response.clone().json().catch(() => null));
  }
  if (body.multiview_generation !== undefined || multiviewAction) response.headers.set('Cache-Control', 'private, no-store');
  return response;

  async function runCanvasAdmission() {
  const stablePricingFingerprint = multiviewAction ? multiviewActionVideoFingerprint(creationBody)
    : body.pricing_fingerprint_version === 2 ? videoPricingBusinessFingerprint(body) : null;
  if (stablePricingFingerprint && typeof body.idempotency_key === 'string') {
    const existing = await prisma.videoTask.findUnique({ where: { user_id_idempotency_key: { user_id: user.id, idempotency_key: body.idempotency_key } } });
    if (existing?.request_fingerprint?.startsWith('pricing-v2:')) {
      await assertCanvasVideoBatchDedupe(user, canvasAdmission, existing);
      try { await assertCanViewTask(user, existing); }
      catch (error) { if (error instanceof AuthError) return errorJson(error.message, error.status); throw error; }
      if (existing.request_fingerprint !== stablePricingFingerprint) return NextResponse.json({ error: '原请求内容不同，请查询原任务；未重新生成', code: 'IDEMPOTENCY_PAYLOAD_MISMATCH', existing_task_id: existing.id }, { status: 409 });
      const payload = { id: existing.id, provider: existing.provider, provider_task_id: existing.provider_task_id,
        status: existing.local_status, model: existing.model, estimated_cost: existing.estimated_cost, frozen_cost: existing.frozen_cost,
        created_at: existing.created_at, project_id: existing.project_id, video_card_id: existing.video_card_id,
        template_studio_run_id: existing.template_studio_run_id, billing_scope: existing.billing_scope, billing_account_id: existing.billing_account_id,
        deduplicated: true, fingerprint_verified: true };
      return isPrivateMultiviewTask(existing) || hasVideoPromptGroups(existing)
        ? NextResponse.json(protectedMultiviewTaskPayload(existing, { deduplicated: true, fingerprint_verified: true }), { headers: privateNoStore() })
        : NextResponse.json(payload);
    }
  }
  if (body.multiview_generation !== undefined && !MULTIVIEW_GENERATION_WRITES_ENABLED) {
    return NextResponse.json({ error: 'MULTIVIEW_GENERATION_GUARD', message: '3D多视图新生成暂不可用，原任务、作品和当前输入保留；请查询原结果。' },
      { status: 503, headers: privateNoStore() });
  }
  let requestClaim: MultiviewRequestClaim | null = actionRequestClaim;
  let committedTaskId: string | null = null;
  const receiptIntentKey = actionRequestClaim?.key || trustedMultiviewRetry?.idempotencyKey || multiviewRequestIntent(body, request.headers.get('x-tab-id'));
  if (!receiptIntentKey) return runCreate();
  try {
    const admission = actionRequestClaim ? null : await claimMultiviewRequest(user.id, receiptIntentKey, body);
    if (admission?.kind === 'blocked') {
      const receipt = admission.receipt;
      return NextResponse.json({ error: receipt?.code || 'MULTIVIEW_REQUEST_PENDING',
        message: receipt?.message || '原提交结果待确认，请查询同一请求号，不会再次提交。', safeToResubmit: false,
        ...(receipt ? { request_receipt: receipt, new_request_allowed: true } : {}) },
      { status: admission.status, headers: privateNoStore() });
    }
    if (admission?.kind === 'claimed') requestClaim = admission.claim;
    const response = await runCreate();
    if (!requestClaim || response.status < 400 || response.status >= 500) return response;
    const payload = await response.clone().json().catch(() => null);
    // A task-bearing response must never be replaced by a pre-acceptance rejection.
    if (payload?.id || payload?.task_id || payload?.existing_task_id) return response;
    const receipt = await rejectMultiviewRequest(requestClaim, response.status, payload);
    return receipt ? NextResponse.json({ ...payload, request_receipt: receipt, new_request_allowed: true, safeToResubmit: false },
      { status: response.status, headers: privateNoStore() }) : response;
  } catch {
    return NextResponse.json({ error: 'MULTIVIEW_REQUEST_UNKNOWN', message: '原提交结果暂时无法确认，请查询原请求号，不要重新提交。',
      ...(committedTaskId ? { task_id: committedTaskId } : {}), safeToResubmit: false }, { status: 503, headers: privateNoStore() });
  }

  async function runCreate() {
  try { await resolveImageInputUrls(user, body); }
  catch (error) { if (error instanceof AuthError) return errorJson(error.message, error.status); throw error; }
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
  const groupRefs = assertVideoPromptGroupSurface(creationBody);
  if (groupRefs.length && typeof body.prompt !== 'string') throw new VideoPromptGroupError('个人描述格式无法确认，请重新读取输入', 400);
  if (groupRefs.length && (hasCodexApiAuthSignal(request) || !creationV2)) {
    throw new VideoPromptGroupError('提示词组仅供普通视频创作入口执行，原输入保留', 403);
  }
  const videoGroups = await resolveVideoPromptGroups(user, groupRefs, typeof creationBody.prompt === 'string' ? creationBody.prompt : '');
  const privateMultiviewIntent = body.multiview_generation !== undefined;
  if (!privateMultiviewIntent && !groupRefs.length && (!body.prompt || typeof body.prompt !== 'string' || !body.prompt.trim())) {
    return errorJson('提示词不能为空', 400);
  }
  if (!privateMultiviewIntent && exceedsGenerationPromptLimit(body.prompt)) {
    return errorJson(GENERATION_PROMPT_LIMIT_MESSAGE, 400);
  }

  const generationMode: GenerationMode = body.generation_mode || 'all_in_one_reference';
  if (!VALID_GENERATION_MODES.includes(generationMode)) {
    return errorJson(`generation_mode 必须是 ${VALID_GENERATION_MODES.join(', ')}`, 400);
  }

  const ratio = body.ratio || '16:9';
  const duration: VideoDuration = body.duration ?? 5;
  const resolution: VideoResolution = body.resolution || '720p';
  const resolutionApprovalConfirmed = body.resolution_approval_confirmed === true || body.resolutionApprovalConfirmed === true;
  const requestedTemplateId = typeof body.template_id === 'string' && body.template_id.trim() ? body.template_id.trim() : null;
  const requestedAgentRunId = typeof body.agent_run_id === 'string' && body.agent_run_id.trim() ? body.agent_run_id.trim() : null;
  const requestedStudioRunId = typeof body.template_studio_run_id === 'string' && body.template_studio_run_id.trim()
    ? body.template_studio_run_id.trim()
    : null;
  let studioHandoff: StudioGenerationHandoff | null = null;
  if (requestedStudioRunId && !multiviewAction) {
    if (requestedTemplateId || requestedAgentRunId) {
      return errorJson('模板工作台运行记录不能混用旧模板或 Agent 执行链路', 400);
    }
    try {
      studioHandoff = await authorizeStudioRunForGeneration(user, requestedStudioRunId);
    } catch (error) {
      if (!(error instanceof StudioError)) {
        console.error('[TasksCreate] Studio handoff authorization failed:', error instanceof Error ? error.name : 'unknown');
        return NextResponse.json({ error: '模板运行记录暂时无法验证，请稍后重试', code: 'UNAVAILABLE' }, { status: 503 });
      }
      const status = error && typeof error === 'object' && 'status' in error
        ? Number((error as { status?: unknown }).status)
        : 0;
      return NextResponse.json({
        error: error.message,
        code: error.code,
      }, { status: [400, 403, 404, 409, 500, 503].includes(status) ? status : 403 });
    }
    const unknownParameters = getUnknownStudioVideoParameterKeys(studioHandoff.parameters);
    if (unknownParameters.length > 0) {
      return NextResponse.json({
        error: '模板含当前视频生成链路无法承接的参数，已保留且阻止提交',
        code: 'UNSUPPORTED_STUDIO_PARAMETERS',
        parameters: unknownParameters,
      }, { status: 400 });
    }
  }
  const selectedAgentPlanKey = typeof body.selected_agent_plan_key === 'string' && body.selected_agent_plan_key.trim()
    ? body.selected_agent_plan_key.trim().slice(0, 16)
    : null;
  const agentPromptSnapshot = typeof body.agent_prompt_snapshot === 'string' && body.agent_prompt_snapshot.trim()
    ? body.agent_prompt_snapshot.trim()
    : null;
  let finalPromptSnapshot = typeof body.final_prompt_snapshot === 'string' && body.final_prompt_snapshot.trim()
    ? body.final_prompt_snapshot.trim()
    : typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (exceedsGenerationPromptLimit(agentPromptSnapshot)) {
    return errorJson(generationPromptLimitMessage('方案提示词'), 400);
  }
  if (!privateMultiviewIntent && exceedsGenerationPromptLimit(finalPromptSnapshot)) {
    return errorJson(generationPromptLimitMessage('最终提示词'), 400);
  }
  const promptUserEdited = body.prompt_user_edited === true;

  if (!VALID_RATIOS.includes(ratio)) return errorJson('ratio 无效', 400);
  if (!VALID_RESOLUTIONS.includes(resolution)) return errorJson('resolution 无效', 400);
  const h3Settings = requestedProvider === H3_VIDEO_PROVIDER ? await getH3ApiSettings() : null;
  let selectedModel: string;
  let selectedH3Lora: ReturnType<typeof resolveH3LoraOption> | null = null;
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
      return errorJson('H3 preset 只允许 lightx2v_4step_turbo、larry_v4_6step、larry_v4_8step', 400);
    }
    if (!['16:9', '9:16', '1:1', '4:3', '3:4'].includes(ratio)) {
      return errorJson('H3 比例只支持 16:9、9:16、1:1、4:3、3:4', 400);
    }
    try {
      selectedH3Lora = resolveH3LoraOption(
        typeof body.lora_id === 'string' && body.lora_id.trim()
          ? body.lora_id.trim()
          : typeof body.h3_lora_id === 'string' && body.h3_lora_id.trim()
            ? body.h3_lora_id.trim()
            : h3Settings.default_lora_id,
        h3Settings.default_lora_id,
      );
    } catch (error) {
      return errorJson(error instanceof Error ? error.message : 'H3 LoRA 无效', 400);
    }
    selectedModel = requestedPreset;
    if (groupRefs.length) {
      try { await assertPrivateH3Destination(selectedModel, { baseUrl: h3Settings.base_url, apiToken: h3Settings.api_token || undefined }, videoGroups.origins); }
      catch (error) {
        if (error instanceof PrivatePromptError) throw new VideoPromptGroupError('当前 H3 尚未获准接收提示词组内部正文，请改用 Seedance 或移除组；尚未受理，输入保留。', 403, 'VIDEO_PROMPT_GROUP_H3_DESTINATION_NOT_APPROVED');
        throw error;
      }
    }
  } else {
    const parsedModel = parseSeedanceVideoModel(body.model);
    if (!parsedModel.ok) return errorJson(parsedModel.message, 400);
    selectedModel = parsedModel.model;
  }

  if (!isSeedanceVideoDuration(duration, selectedModel)) {
    return errorJson(seedanceVideoDurationError(selectedModel), 400);
  }

  const draftRequested = body.draft === true;
  const editModeError = validateSeedanceEditMode({
    taskType: body.omni_reference_task_type, provider: requestedProvider,
    model: selectedModel, mode: generationMode, draft: draftRequested,
  });
  if (editModeError) return errorJson(editModeError, 400);
  const videoEditRequested = body.omni_reference_task_type === 'edit';
  if (videoEditRequested && (requestSource.source_type !== 'codex_api'
    || !normalizeSeedanceEditPilot(editPilotSettings).enabled)) {
    return errorJson('视频编辑试验尚未启用，请由管理员确认试验项目后配置。', 503);
  }
  if (draftRequested) {
    if (requestedProvider !== 'seedance' || !canCreateSeedanceDraft(selectedModel)) {
      return errorJson('样片 Draft 只支持 Seedance 2.5', 400);
    }
    if (!isSeedanceDraftCreateEnabled()) {
      return errorJson('供应商 Draft 能力尚未完成核验，暂不能创建样片 Draft', 503);
    }
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

  const idempotencyKey = typeof body.idempotency_key === 'string' && body.idempotency_key.trim()
    ? body.idempotency_key.trim()
    : undefined;
  let multiviewGeneration: MultiviewGenerationSnapshot | null = null;
  let multiviewRecipe: MultiviewRotationPreset | null = null;
  let multiviewSystemReference: Awaited<ReturnType<typeof readMultiviewSystemReference>> | null = null;
  if (body.multiview_generation !== undefined) {
    multiviewGeneration = parseMultiviewGenerationSnapshot(body.multiview_generation);
    if (!multiviewGeneration) return errorJson('3D多视图旋转预设版本或主图记录无效，已有输入保留', 400);
    const clientSuppliedPrivateMaterial = body.prompt !== undefined || body.final_prompt_snapshot !== undefined
      || body.agent_prompt_snapshot !== undefined || body.protected_module !== undefined
      || body.recipe !== undefined || body.recipe_prompt !== undefined || body.system_reference !== undefined
      || body.system_reference_image_id !== undefined || body.system_asset_id !== undefined
      || body.callback_url !== undefined;
    // Resolve only the immutable revision here. Existing task/receipt lookup must
    // not substitute today's preset into an already accepted request.
    try { multiviewRecipe = await readMultiviewRotationPresetVersion(multiviewGeneration.presetVersion); }
    catch (error) {
      if (error instanceof MultiviewPresetError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
      throw error;
    }
    let composed = composeMultiviewGenerationPrompt(multiviewGeneration.supplement, multiviewGeneration.presetVersion, multiviewRecipe, duration);
    if (!composed.valid) return errorJson(composed.error || '完整旋转文案无效', 400);
    if (trustedMultiviewSourceTask && trustedMultiviewSourceTask.final_prompt_snapshot !== composed.prompt) {
      // Tasks frozen before the automatic timing clause retry with their original wording.
      const legacy = composeMultiviewGenerationPrompt(multiviewGeneration.supplement, multiviewGeneration.presetVersion, multiviewRecipe, duration, false);
      if (legacy.valid && trustedMultiviewSourceTask.final_prompt_snapshot === legacy.prompt) composed = legacy;
    }
    if (trustedMultiviewSourceTask && (trustedMultiviewSourceTask.prompt !== composed.prompt.trim()
      || trustedMultiviewSourceTask.final_prompt_snapshot !== composed.prompt)) {
      return NextResponse.json({ error: 'MULTIVIEW_PRIVATE_RETRY_UNAVAILABLE',
        message: '原任务的受保护文案与冻结配方不一致，未恢复或重新提交。' },
      { status: 409, headers: privateNoStore() });
    }
    // Only the complete rotation contract may omit a card; a source label alone is not sufficient.
    if (!idempotencyKey || !trustedMultiviewRetry && request.headers.get('x-tab-id') !== multiviewGeneration.workspaceTabId
      || body.client_name !== 'multiview' || cleanSourceMetadata(body.source_metadata).source !== 'multiview'
      || cleanSourceMetadata(body.source_metadata).mode !== 'rotation'
      || clientSuppliedPrivateMaterial || agentPromptSnapshot !== null || promptUserEdited
      || requestedProvider !== 'seedance' || body.provider !== 'seedance' || generationMode !== 'all_in_one_reference'
      || body.generation_mode !== 'all_in_one_reference' || body.model !== selectedModel || body.ratio !== ratio
      || body.duration !== duration || body.resolution !== resolution || !requestedProjectId || body.project_id !== requestedProjectId
      || (body.video_card_id ?? null) !== requestedVideoCardId || body.videoCardId !== undefined
      || !isMultiviewGenerationSeed(body.seed)
      || typeof body.generate_audio !== 'boolean' || typeof body.return_last_frame !== 'boolean' || typeof body.watermark !== 'boolean'
      || typeof body.resolution_approval_confirmed !== 'boolean' || body.draft !== false
      || typeof body.max_estimated_cost !== 'number' || !Number.isFinite(body.max_estimated_cost) || body.max_estimated_cost < 0) {
      return errorJson('3D多视图生成设置与原文案、归属或报价不一致，未提交生成', 400);
    }
    if (!Array.isArray(body.reference_image_ids) || body.reference_image_ids.length !== 1
      || body.reference_image_ids[0] !== multiviewGeneration.mainReferenceImageId) return errorJson('3D多视图生成必须且只能使用当前明确选择的一张主图', 400);
    const alternateArrays = ['referenceImageIds', 'reference_image_urls', 'referenceImageUrls', 'reference_video_urls', 'reference_audio_urls', 'frame_image_urls', 'template_studio_assets'];
    if (alternateArrays.some(key => body[key] != null && (!Array.isArray(body[key]) || body[key].length !== 0))
      || ['first_frame_url', 'last_frame_url', 'first_frame_asset_id', 'last_frame_asset_id', 'template_id', 'agent_run_id', 'template_studio_run_id',
        'template_studio_parameters', 'roleMediaContext', 'promptMentions', 'canvas_document_id', 'canvas_node_id'].some(key => body[key] != null && body[key] !== '')
      || cleanSourceMetadata(body.source_metadata).canvas_document_id || cleanSourceMetadata(body.source_metadata).canvas_node_id) {
      return errorJson('3D多视图旋转请求不能混入其他素材、模板运行记录或角色工作流', 400);
    }
    try { multiviewSystemReference = await readMultiviewSystemReference(multiviewRecipe.compositionReference); }
    catch {
      return NextResponse.json({ error: 'MULTIVIEW_SYSTEM_REFERENCE_UNAVAILABLE',
        message: '系统构图参考暂时无法确认，主图和原输入已保留；请联系管理员后再生成。' },
      { status: 503, headers: privateNoStore() });
    }
    // Private prompt material is created only after the safe browser contract has
    // been validated. It never returns through the ordinary request DTO.
    body.prompt = composed.prompt;
    body.final_prompt_snapshot = composed.prompt;
    finalPromptSnapshot = composed.prompt;
  }

  if (!requestedVideoCardId && !multiviewGeneration && !creationV2) {
    return errorJson('必须先选择视频卡，生成任务才能写入项目成本闭环', 400);
  }

  const requestedVideoCard = requestedVideoCardId ? await prisma.videoCard.findUnique({
    where: { id: requestedVideoCardId },
    select: { id: true, project_id: true },
  }) : null;
  if (requestedVideoCardId && !requestedVideoCard) {
    return errorJson('视频卡不存在', 404);
  }
  if (requestedVideoCard && requestedProjectId && requestedProjectId !== requestedVideoCard.project_id) {
    return errorJson('视频卡不属于当前项目', 400);
  }
  if (videoEditRequested && requestedVideoCard && !isSeedanceEditPilotAllowed(editPilotSettings, requestedVideoCard.project_id)) {
    return errorJson('当前项目未获准使用视频编辑试验。', 403);
  }

  let project;
  let videoCard: NonNullable<Awaited<ReturnType<typeof assertCanGenerateInVideoCard>>['videoCard']> | null = null;
  try {
    const projectId = requestedVideoCard?.project_id || requestedProjectId;
    if (!projectId) throw new AuthError('请先明确保存到的项目', 400);
    project = await getProjectForGeneration(user, projectId);
    if (requestedVideoCard) {
      const videoCardAccess = await assertCanGenerateInVideoCard(user, project.id, requestedVideoCard.id);
      videoCard = videoCardAccess.videoCard;
    }
    const canvasDocumentIds = new Set([
      body.canvas_document_id,
      cleanSourceMetadata(body.source_metadata).canvas_document_id,
      requestSource.source_metadata?.canvas_document_id,
    ].filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).map(value => value.trim()));
    if (canvasDocumentIds.size > 1) throw new AuthError('画布归属信息不一致', 400);
    if (body.roleMediaContext !== undefined) {
      roleMediaFingerprint(body.roleMediaContext);
      const context = body.roleMediaContext;
      if (hasCodexApiAuthSignal(request) || context.ownerId !== user.id || context.kind !== 'video'
        || canvasDocumentIds.size !== 1 || !canvasDocumentIds.has(context.documentId)
        || context.generationNodeId !== (cleanSourceMetadata(body.source_metadata).canvas_node_id || body.canvas_node_id)
        || body.client_name !== 'ultimate_canvas') throw new AuthError('角色视频必须由本人在原画布生成器确认', 403);
    }
    for (const canvasDocumentId of Array.from(canvasDocumentIds)) {
      const document = await assertCanEditCanvasDocument(user, canvasDocumentId, project.id);
      const nodeId = cleanSourceMetadata(body.source_metadata).canvas_node_id || body.canvas_node_id;
      const node = JSON.parse(document.document_json).canvas.nodes.find((item: { id: string }) => item.id === nodeId);
      if (node?.data?.roleMediaOrigin && body.roleMediaContext === undefined) throw new AuthError('此视频节点属于固定角色工作，请从原岗位重新打开生成器', 409);
    }
    for (const canvasDocumentId of Array.from(canvasDocumentIds)) await assertCanvasPromptCompatibility(user, canvasDocumentId,
      cleanSourceMetadata(body.source_metadata).canvas_node_id || body.canvas_node_id || null, body.prompt, body.promptMentions);
    if (body.promptMentions != null) {
      if (canvasDocumentIds.size !== 1 || body.client_name !== 'ultimate_canvas') throw new AuthError('图片绑定仅用于合法画布请求', 400);
      try { compileCanvasPromptReferences({ prompt: body.prompt, promptMentions: body.promptMentions, referenceImageIds: body.reference_image_ids ?? [] }); } catch (error) {
        if (error instanceof CanvasPromptReferenceError) throw new AuthError(error.message, 400); throw error;
      }
    }
  } catch (error) {
    if (error instanceof AuthError) return errorJson(error.message, error.status);
    throw error;
  }

  const videoCardId = videoCard?.id || null;
  if (studioHandoff && !videoCard && !creationV2) return errorJson('模板生成必须明确关联视频卡', 400);

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
    if (agentRun.video_card_id && agentRun.video_card_id !== videoCardId) return errorJson('Agent 执行链路与当前视频卡不一致', 400);
    if (!generationTemplate) {
      generationTemplate = await prisma.generationTemplate.findFirst({
        where: {
          id: agentRun.template_id,
          OR: user.role === 'admin' ? [{ status: { in: ['draft', 'active'] } }] : [{ status: 'active' }],
        },
        select: { id: true, status: true },
      });
      if (!generationTemplate) return errorJson('Agent 所属模板已归档或不可用', 403);
    }
  }

  if (!creationV2 && project.type !== 'personal' && resolution === '1080p') {
    if (!videoCard) return errorJson('非个人项目的 1080p 生成必须选择视频卡，并通过该视频卡的基准任务审批', 403);
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

  let videoBranch: { id: string; title: string; status: string; is_primary: boolean } | null = null;
  if (requestedVideoBranchId) {
    if (!videoCard) return errorJson('选择方向分支前必须明确关联视频卡', 400);
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

  // --- Idempotency ---
  if (body.idempotency_key !== undefined && (!idempotencyKey || idempotencyKey.length > 200)) {
    return errorJson('idempotency_key 无效', 400);
  }
  if (body.roleMediaContext !== undefined && !idempotencyKey) return errorJson('角色媒体必须保留原请求编号，未生成', 400);
  if (multiviewGeneration && (body.project_id !== project.id || (body.video_card_id ?? null) !== videoCardId)) {
    return errorJson('3D多视图生成归属与当前有权使用的项目或视频卡不一致，未提交生成', 400);
  }
  const studioAssetsForFingerprint = Array.isArray(body.template_studio_assets)
    ? body.template_studio_assets.map((item: Record<string, unknown>) => ({
        assetId: item?.assetId,
        role: item?.role,
        type: item?.type,
        slotKey: item?.slotKey,
      }))
    : [];
  const fingerprintPayload = {
    ...(creationBody.video_feishu === undefined ? {} : { video_feishu: creationBody.video_feishu }),
    ...(body.canvas_references === undefined ? {} : { canvas_references: body.canvas_references }),
    prompt: body.prompt.trim(),
    ...(body.promptMentions != null ? { canvasPromptMentions: parseCanvasPromptMentions(body.promptMentions) } : {}),
    provider: requestedProvider,
    model: selectedModel,
    generationMode,
    ratio,
    duration,
    resolution,
    seed: body.seed ?? -1,
    generateAudio: body.generate_audio ?? true,
    returnLastFrame: body.return_last_frame ?? false,
    watermark: body.watermark ?? false,
    draft: draftRequested,
    h3LoraId: selectedH3Lora?.id || null,
    projectId: project.id,
    videoCardId,
    videoBranchId: requestedVideoBranchId,
    referenceImageIds: uniquePreserveOrder(Array.isArray(body.reference_image_ids) ? body.reference_image_ids : Array.isArray(body.referenceImageIds) ? body.referenceImageIds : []),
    referenceImageUrls: uniquePreserveOrder(Array.isArray(body.reference_image_urls) ? body.reference_image_urls : Array.isArray(body.referenceImageUrls) ? body.referenceImageUrls : []),
    referenceVideoUrls: normalizeReferenceMediaUrlList(body.reference_video_urls),
    referenceAudioUrls: normalizeReferenceMediaUrlList(body.reference_audio_urls),
    frameImageUrls: normalizeReferenceMediaUrlList(body.frame_image_urls),
    firstFrameUrl: requestedStudioRunId ? null : (typeof body.first_frame_url === 'string' ? body.first_frame_url.trim() : null),
    lastFrameUrl: requestedStudioRunId ? null : (typeof body.last_frame_url === 'string' ? body.last_frame_url.trim() : null),
    templateId: requestedTemplateId,
    agentRunId: requestedAgentRunId,
    studioRunId: requestedStudioRunId,
    studioAssets: studioAssetsForFingerprint,
    studioParameters: requestedStudioRunId && body.template_studio_parameters && typeof body.template_studio_parameters === 'object'
      ? body.template_studio_parameters
      : null,
    selectedAgentPlanKey,
    agentPromptSnapshot,
    finalPromptSnapshot,
    promptUserEdited,
    priceCeiling: body.max_estimated_cost ?? null,
    ...(typeof body.pricing_revision === 'string' ? { pricingRevision: body.pricing_revision } : {}),
    resolutionApprovalId: requestedResolutionApprovalId,
    resolutionApprovalConfirmed,
    ...(body.roleMediaContext === undefined ? {} : { roleMediaContext: roleMediaFingerprint(body.roleMediaContext) }),
    ...(multiviewGeneration ? { multiviewGeneration } : {}),
  };
  const requestFingerprint = stablePricingFingerprint || generationRequestFingerprint(fingerprintPayload);
  if (idempotencyKey) {
    const existing = await prisma.videoTask.findUnique({
      where: { user_id_idempotency_key: { user_id: user.id, idempotency_key: idempotencyKey } },
    });
    if (existing) await assertCanvasVideoBatchDedupe(user, canvasAdmission, existing);
    if (existing) {
      const decision = decideGenerationIdempotency(existing, {
        requestFingerprint,
        videoCardId,
        templateStudioRunId: requestedStudioRunId,
      });
      if (decision.kind !== 'deduplicated') {
        const conflict = decision.kind === 'legacy_unverifiable'
          ? { code: 'IDEMPOTENCY_LEGACY_UNVERIFIABLE', error: '已找到同请求号的历史任务，但缺少内容指纹。请先查询该任务状态，不要盲目重新提交。' }
          : decision.kind === 'payload_mismatch'
            ? { code: 'IDEMPOTENCY_PAYLOAD_MISMATCH', error: '同一个请求号已对应不同生成内容。请查询已有任务；如确需再生成，应由用户明确发起新请求。' }
            : decision.kind === 'video_card_mismatch'
              ? { code: 'IDEMPOTENCY_VIDEO_CARD_MISMATCH', error: '同一个请求号已绑定其他视频卡，请查询已有任务，不要用该请求号重新提交。' }
              : { code: 'IDEMPOTENCY_STUDIO_LINK_MISMATCH', error: '同一个请求号已用于不同生成链路，请查询已有任务，不要用该请求号重新提交。' };
        return NextResponse.json({ ...conflict, existing_task_id: existing.id }, { status: 409 });
      }
      const payload = {
        id: existing.id,
        provider: existing.provider,
        provider_task_id: existing.provider_task_id,
        status: existing.local_status,
        model: existing.model,
        estimated_cost: existing.estimated_cost,
        frozen_cost: existing.frozen_cost,
        created_at: existing.created_at,
        deduplicated: true,
        fingerprint_verified: decision.fingerprintVerified,
        source_type: existing.source_type,
        source_label: existing.source_label,
        source_request_id: existing.source_request_id,
        project_id: existing.project_id,
        video_card_id: existing.video_card_id,
        template_id: existing.template_id,
        template_studio_run_id: existing.template_studio_run_id,
        agent_run_id: existing.agent_run_id,
        selected_agent_plan_key: existing.selected_agent_plan_key,
        billing_scope: existing.billing_scope,
        billing_account_id: existing.billing_account_id,
      };
      return isPrivateMultiviewTask(existing) || hasVideoPromptGroups(existing)
        ? NextResponse.json(protectedMultiviewTaskPayload(existing, {
            deduplicated: true, fingerprint_verified: decision.fingerprintVerified,
          }), { headers: privateNoStore() })
        : NextResponse.json(payload);
    }
  }

  if (multiviewGeneration) {
    // Restored settings check (replaced by an unconditional 503 in the 10-22 recovery guard 9c113fb9).
    try {
      if (trustedMultiviewRetry) await readMultiviewRotationPresetVersion(multiviewGeneration.presetVersion);
      else await assertMultiviewGenerationSettings(user, multiviewGeneration);
    }
    catch (error) {
      if (error instanceof MultiviewPresetError || error instanceof MultiviewSettingsError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
      throw error;
    }
    // A 4xx here becomes a "not submitted" receipt, so the page can say nothing was charged.
    if (resolution === '1080p' && !await hasMultiview1080pApproval(user.id)) {
      return NextResponse.json({ error: MULTIVIEW_1080P_REQUIRED_MESSAGE, code: MULTIVIEW_1080P_APPROVAL_REQUIRED }, { status: 403 });
    }
  }

  // Existing accepted requests return above without recalculating today's quote.
  let priceQuote: VideoPricingQuote;
  let pricingContext: VideoPricingContext;
  let requireScopeCredential = false;
  try {
    pricingContext = await resolveVideoPricingContext(user, { ...body, project_id: project.id, video_card_id: videoCardId,
      provider: requestedProvider === H3_VIDEO_PROVIDER ? 'h3' : 'seedance', model: selectedModel, resolution, duration, draft: draftRequested });
    priceQuote = await quoteVideoPricing({ provider: requestedProvider === H3_VIDEO_PROVIDER ? 'h3' : 'seedance', model: selectedModel, resolution, duration, context: pricingContext });
    requireVideoPricingRevision(priceQuote, body.pricing_revision);
    requireScopeCredential = Boolean(groupRefs.length || multiviewAction || multiviewGeneration?.settingsBinding) || Boolean(body.pricing_quote_token) || await videoPricingRequiresContext(selectedModel, priceQuote.identity.channelId);
    if (requireScopeCredential) verifyVideoPricingCredential(body.pricing_quote_token, pricingContext, priceQuote.revision, priceQuote.pricing.estimatedCost);
  } catch (error) {
    if (error instanceof VideoPromptGroupError) throw error;
    const failure = videoPricingError(error);
    return NextResponse.json({ error: failure?.message || '报价暂不可用，原参数和素材已保留', code: failure?.code || 'pricing_unavailable' }, { status: failure?.status || 503 });
  }
  const pricing = priceQuote.pricing;
  const estimatedCost = pricing.estimatedCost;
  const costCeilingError = validateRequestCostCeiling(body.max_estimated_cost, estimatedCost);
  if (costCeilingError) return errorJson(costCeilingError, 400);
  const billingScope = shouldBillProjectBudget(project) ? 'project' : 'user';
  const billingAccountId = billingScope === 'project' ? project.id : user.id;
  if (pricingContext.payer.kind !== billingScope || pricingContext.payer.id !== billingAccountId) return NextResponse.json({
    error: '付费归属已变化，请保留输入重新报价；尚未生成', code: 'pricing_context_changed',
  }, { status: 409 });

  // --- Workspace + Reference Image Preparation ---
  const tabId = canvasInputs?.scope.workspace_key || (multiviewAction ? `multiview-action-${multiviewAction.action.runId}` : studioHandoff ? `template-studio-${studioHandoff.runId}`
    : multiviewGeneration ? multiviewGeneration.workspaceTabId
      : request.headers.get('x-tab-id') || 'default');
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
  const effectiveSourceLabel = multiviewAction ? MULTIVIEW_ACTION_PUBLIC_TASK_TITLE : multiviewGeneration ? '3D多视图' : isUltimateCanvasRequest ? '无限画布' : requestSource.source_label;
  const ordinarySourceMetadata: Record<string, unknown> = {
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
    ...(selectedH3Lora ? {
      h3_lora_id: selectedH3Lora.id,
      h3_lora_label: selectedH3Lora.label,
    } : {}),
    paid_generation_guard: paidGenerationGuard.metadata,
  };
  const sourceMetadata: Record<string, unknown> = multiviewAction
    ? { protected_module: multiviewActionPrivateTaskMarker(creationBody.multiview_action as MultiviewActionBinding) } : multiviewGeneration
    ? { protected_module: multiviewPrivateTaskMarker(multiviewGeneration.presetVersion) }
    : ordinarySourceMetadata;
  if (groupRefs.length) sourceMetadata.video_prompt_groups = { schema: 1, refs: groupRefs };
  const workspace = multiviewGeneration ? await prisma.workspace.findFirst({
    where: trustedMultiviewSourceTask
      ? { id: trustedMultiviewSourceTask.workspace_id!, owner_id: user.id, status: 'active' }
      : { owner_id: user.id, status: 'active', name: `默认工作台:${multiviewGeneration.workspaceTabId}` },
    orderBy: { updated_at: 'desc' }, select: { id: true },
  }) : await getOrCreateWorkspace(tabId, user.id);
  if (!workspace) return errorJson('本页主图工作区尚未准备好，原输入保留，请重新核对素材', 409);
  const workspaceId = workspace.id;
  if (multiviewGeneration) {
    const rows = await prisma.workspaceAsset.findMany({ where: { workspace_id: workspaceId }, take: 2,
      select: { asset_id: true, reference_image_id: true, role: true, asset: { select: { status: true, type: true } } } });
    if (rows.length !== 1 || rows[0].asset_id !== multiviewGeneration.mainAssetId
      || rows[0].reference_image_id !== multiviewGeneration.mainReferenceImageId
      || rows[0].asset.status !== 'active' || rows[0].asset.type !== 'image' || rows[0].role && rows[0].role !== 'reference_image') {
      return errorJson('本页主图与工作区关联已变化，请核对原图；未自动添加或删除素材', 409);
    }
  }

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

  let studioSubmission: {
    assets: StudioAssetInput[];
    referenceVideoUrls: string[];
    referenceAudioUrls: string[];
    firstFrameUrl: string | null;
    lastFrameUrl: string | null;
  } | null = null;

  if (studioHandoff) {
    const submittedAssets = body.template_studio_assets;
    if (!Array.isArray(submittedAssets) || submittedAssets.length > 32) {
      return errorJson('模板素材提交内容无效', 400);
    }
    const ids = submittedAssets.map((item: Record<string, unknown>) => item?.assetId);
    if (ids.some((id: unknown) => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) {
      return errorJson('模板素材编号无效或重复', 400);
    }
    const submittedRows = await prisma.workspaceAsset.findMany({
      where: { workspace_id: workspaceId, asset_id: { in: ids as string[] } },
      include: { asset: true },
      orderBy: { sort_order: 'asc' },
    });
    const rowByAssetId = new Map(submittedRows.map((row) => [row.asset_id, row]));
    if (submittedRows.length !== ids.length) return errorJson('有素材已从当前生成工作区移除，请刷新后重试', 400);

    const sourceAssetsById = new Map(studioHandoff.assets.map((asset) => [asset.assetId, asset]));
    const recipeSlots = studioHandoff.snapshot.recipe?.assetSlots || [];
    const slotByKey = new Map(recipeSlots.map((slot) => [slot.key, slot]));
    const slotCounts = new Map<string, number>();
    const normalizedStudioAssets: StudioAssetInput[] = [];
    const referenceImageIds: string[] = [];
    const referenceVideoUrls: string[] = [];
    const referenceAudioUrls: string[] = [];
    let firstFrameUrl: string | null = null;
    let lastFrameUrl: string | null = null;

    for (const raw of submittedAssets as Array<Record<string, unknown>>) {
      const assetId = typeof raw.assetId === 'string' ? raw.assetId.trim() : '';
      const role = raw.role;
      const type = raw.type;
      const slotKey = typeof raw.slotKey === 'string' && raw.slotKey.trim() ? raw.slotKey.trim() : undefined;
      if (!['reference', 'first', 'last'].includes(String(role)) || !['image', 'video', 'audio'].includes(String(type))) {
        return errorJson('模板素材角色或类型无效', 400);
      }
      if ((role === 'first' || role === 'last') && type !== 'image') return errorJson('首帧和尾帧只支持图片', 400);

      const workspaceAsset = rowByAssetId.get(assetId);
      if (!workspaceAsset || workspaceAsset.asset.status !== 'active' || workspaceAsset.asset.type !== type) {
        return errorJson('模板素材不存在、已停用或类型不匹配', 403);
      }
      const sourceAsset = sourceAssetsById.get(assetId);
      if (sourceAsset) {
        if (sourceAsset.type !== type || sourceAsset.role !== role || sourceAsset.slotKey !== slotKey) {
          return errorJson('模板原始素材角色或槽位已改变，请返回模板工作台重新确认', 409);
        }
      } else {
        if (slotKey) return errorJson('新增素材不能伪装为模板必填槽位素材', 400);
      }

      if (slotKey) {
        const slot = slotByKey.get(slotKey);
        if (!slot || slot.role !== role || !slot.types.includes(type as StudioAssetInput['type'])) {
          return errorJson('模板素材与固定槽位不匹配', 400);
        }
        const count = (slotCounts.get(slotKey) || 0) + 1;
        if (count > (slot.maxItems || 1)) return errorJson(`模板素材槽「${slot.label}」超过数量限制`, 400);
        slotCounts.set(slotKey, count);
      }

      const normalizedAsset: StudioAssetInput = {
        assetId,
        role: role as StudioAssetInput['role'],
        type: type as StudioAssetInput['type'],
        ...(slotKey ? { slotKey } : {}),
      };
      if (!sourceAsset) {
        try {
          await authorizeStudioAssets(user, [normalizedAsset]);
        } catch (error) {
          if (error instanceof StudioError) {
            return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
          }
          throw error;
        }
      }
      normalizedStudioAssets.push(normalizedAsset);

      if (role === 'reference' && type === 'image') {
        if (!workspaceAsset.reference_image_id) return errorJson('普通参考图片缺少授权引用记录，请重新准备素材', 409);
        referenceImageIds.push(workspaceAsset.reference_image_id);
      } else if (role === 'reference' && (type === 'video' || type === 'audio')) {
        try {
          const publicAsset = await ensureSiteAssetPublicUrl(assetId);
          if (!publicAsset.isPubliclyReachable) return errorJson('模板中的视频或音频素材当前无法公网访问', 400);
          if (type === 'video') referenceVideoUrls.push(publicAsset.asset.original_url);
          else referenceAudioUrls.push(publicAsset.asset.original_url);
        } catch {
          return errorJson('模板中的视频或音频素材当前无法公网访问', 400);
        }
      } else {
        try {
          const publicAsset = await ensureSiteAssetPublicUrl(assetId);
          if (!publicAsset.isPubliclyReachable) return errorJson('首尾帧图片当前无法提供给视频服务', 400);
          if (role === 'first') firstFrameUrl = publicAsset.asset.original_url;
          else lastFrameUrl = publicAsset.asset.original_url;
        } catch {
          return errorJson('首尾帧图片当前无法提供给视频服务', 400);
        }
      }
    }

    const missingRequiredSlot = getMissingRequiredStudioAssetSlot(recipeSlots, normalizedStudioAssets);
    if (missingRequiredSlot) return errorJson(`模板必填素材槽「${missingRequiredSlot.label}」缺少素材`, 400);
    const materialCompatibilityError = getStudioMaterialCompatibilityError({
      provider: requestedProvider,
      generationMode,
      assets: normalizedStudioAssets,
    });
    if (materialCompatibilityError) return errorJson(materialCompatibilityError, 400);

    requestedReferenceImageIds = referenceImageIds;
    requestedReferenceImageUrls = [];
    studioSubmission = {
      assets: normalizedStudioAssets,
      referenceVideoUrls,
      referenceAudioUrls,
      firstFrameUrl,
      lastFrameUrl,
    };
  }

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

  const workspaceReferenceBackfill = canvasInputs || studioHandoff || multiviewGeneration || multiviewAction ? [] : await ensureWorkspaceImageAssetsHaveReferenceImages({
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

  let workspaceReferenceImageIds = multiviewAction ? [] : uniquePreserveOrder(
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
      : body.canvas_references !== undefined || studioHandoff || multiviewAction || requestSource.source_type === 'codex_api'
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
      canvasInputs ? [] : generationReferenceImageIds,
      canvasInputs ? canvasInputs.orderedImageUrls : requestedReferenceImageUrls,
      user.id,
      Boolean(studioHandoff || canvasInputs || multiviewAction),
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

  if (canvasInputs && prepSummary.skipped > 0 || prepSummary.total > 0 && preparedImages.length === 0 && prepSummary.skipped > 0) {
    const referenceImageFailure = buildReferenceImagePreparationFailure(prepareErrors);
    return NextResponse.json(
      { error: referenceImageFailure.error, message: referenceImageFailure.message, details: { errors: prepareErrors } },
      { status: 400 },
    );
  }

  // --- Build mode-specific reference arrays ---
  let referenceImageUrls: string[] = [];
  let firstFrameUrl: string | undefined = studioSubmission
    ? studioSubmission.firstFrameUrl || undefined
    : body.first_frame_url;
  let lastFrameUrl: string | undefined = studioSubmission
    ? studioSubmission.lastFrameUrl || undefined
    : body.last_frame_url;
  let frameImageUrls: string[] = studioHandoff ? [] : normalizeReferenceMediaUrlList(body.frame_image_urls);
  const allReferenceVideoUrls = studioSubmission
    ? studioSubmission.referenceVideoUrls
    : normalizeReferenceMediaUrlList(body.reference_video_urls);
  const allReferenceAudioUrls = studioSubmission
    ? studioSubmission.referenceAudioUrls
    : normalizeReferenceMediaUrlList(body.reference_audio_urls);
  if (allReferenceVideoUrls.length > 3) {
    return errorJson(`${requestedProvider === H3_VIDEO_PROVIDER ? 'H3' : 'Seedance 2.0'} 单次生成最多选择 3 个参考视频。`, 400);
  }
  if (allReferenceAudioUrls.length > 3) {
    return errorJson(`${requestedProvider === H3_VIDEO_PROVIDER ? 'H3' : 'Seedance 2.0'} 单次生成最多选择 3 个参考音频。`, 400);
  }
  const referenceVideoUrls = normalizedVideoPricingReferenceScope(allReferenceVideoUrls).urls;
  const referenceAudioUrls = allReferenceAudioUrls.slice(0, 3);
  try { assertVideoPricingFinalReferences(pricingContext, referenceVideoUrls); }
  catch (error) { const failure = videoPricingError(error); return NextResponse.json({ error: failure?.message || '最终素材与报价不同，请重新报价；尚未生成', code: failure?.code || 'pricing_context_changed' }, { status: failure?.status || 409 }); }
  if (videoEditRequested && referenceVideoUrls.length !== 1) {
    return errorJson('本次视频编辑必须绑定一个且仅一个待编辑视频。', 400);
  }

  switch (generationMode) {
    case 'all_in_one_reference':
      referenceImageUrls = preparedImages.map((img) => img.originalUrl);
      break;
    case 'first_last_frame':
      if (!firstFrameUrl && !studioHandoff) firstFrameUrl = preparedImages[0]?.originalUrl;
      if (!lastFrameUrl && !studioHandoff) lastFrameUrl = preparedImages[1]?.originalUrl;
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
  const editReferences: SeedanceEditReference[] = [];
  if (requestedProvider !== H3_VIDEO_PROVIDER) {
    const referenceMediaPreflightIssue = await validateReferenceMediaProviderPreflight({
      preparedImages,
      imageUrls: finalReferenceImageUrls,
      referenceVideoUrls,
      referenceAudioUrls,
      onVideoProbed: videoEditRequested ? (reference) => editReferences.push(reference) : undefined,
    });
    if (referenceMediaPreflightIssue) {
      return NextResponse.json(referenceMediaPreflightIssue, { status: 400 });
    }
  }
  const editReference = editReferences[0];
  if (videoEditRequested) {
    const editReferenceError = validateSeedanceEditReference({
      urls: referenceVideoUrls, reference: editReference || null, duration, ratio,
    });
    if (editReferenceError) return errorJson(editReferenceError, 400);
  }

  // --- Prompt validation + rendering ---
  const hasCanvasBindings = body.promptMentions != null && new RegExp('@图[0-9]+(?![\\p{N}A-Za-z_])', 'u').test(body.prompt);
  const promptValidation = multiviewGeneration || multiviewAction || hasCanvasBindings
    ? { valid: true, missing: [] }
    : await validatePromptReferences(body.prompt, workspaceId);
  if (!promptValidation.valid) {
    return NextResponse.json(
      { error: 'PROMPT_REFERENCE_ERROR', message: `prompt 中引用的图号不存在: ${promptValidation.missing.join(', ')}` },
      { status: 400 },
    );
  }
  let promptRendered: string, assetMapping: Record<string, string>;
  try {
    const rendered = multiviewAction ? { promptRendered: multiviewAction.action.prompt, assetMapping: {} } : multiviewGeneration && multiviewSystemReference
      ? { promptRendered: MULTIVIEW_REFERENCE_PROMPT_PREFIX + body.prompt,
          assetMapping: { '图1': multiviewGeneration.mainAssetId, '图2': multiviewSystemReference.assetId } }
      : hasCanvasBindings
      ? await compileCanvasVideoPrompt(user, body.prompt, body.promptMentions, generationReferenceImageIds, preparedImages, finalReferenceImageUrls)
      : await renderPromptWithAssets(body.prompt, workspaceId, generationMode);
    ({ promptRendered, assetMapping } = rendered);
    if (groupRefs.length) {
      // Render only personal asset references; groups cannot create hidden material bindings.
      const compiled = await resolveVideoPromptGroups(user, groupRefs, promptRendered);
      promptRendered = compiled.prompt;
      finalPromptSnapshot = promptRendered;
    }
    if ('canvasPromptFingerprint' in rendered) sourceMetadata.canvas_prompt_fingerprint = rendered.canvasPromptFingerprint;
  } catch (error) { if (error instanceof AuthError) return errorJson(error.message, error.status); throw error; }

  if (multiviewGeneration) {
    if (!multiviewSystemReference || assetMapping['图1'] !== multiviewGeneration.mainAssetId
      || assetMapping['图2'] !== multiviewSystemReference.assetId || Object.keys(assetMapping).length !== 2
      || promptRendered !== MULTIVIEW_REFERENCE_PROMPT_PREFIX + body.prompt) return errorJson('主图引用顺序或工作区已变化，原请求未提交，请重新核对', 409);
    if (exceedsGenerationPromptLimit(promptRendered)) return errorJson(GENERATION_PROMPT_LIMIT_MESSAGE, 400);
  }

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

  const providerInput: SeedanceProviderInput = {
    ...(videoEditRequested ? { omni_reference_task_type: 'edit' as const, seedance_edit_reference: editReference } : {}),
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
    draft: draftRequested,
  };

  let h3ReferenceTransfer: Awaited<ReturnType<typeof uploadH3ReferenceImagesForTask>> | null = null;
  let seedanceReferenceTransport: Partial<CreateVideoInput> = {};
  // Each caller has authorized its images above; private URLs are not upstream-fetch grants.
  if (requestedProvider === 'seedance' && (multiviewGeneration || multiviewAction || body.canvas_document_id
    || cleanSourceMetadata(body.source_metadata).canvas_document_id || requestSource.source_metadata?.canvas_document_id)) {
    try {
      seedanceReferenceTransport = await seedanceLocalReferenceTransport(
        { ...providerInput, callback_url: requestCallbackUrl || undefined },
        [...generationReferenceImages, ...(actionImageForTransport ? [actionImageForTransport] : [])],
        undefined,
        multiviewSystemReference ? [{ mimeType: multiviewSystemReference.mimeType, bytes: multiviewSystemReference.bytes }] : [],
      );
    }
    catch (error) { return errorJson(error instanceof Error ? error.message : '参考原图直传准备失败，尚未提交视频生成', 400); }
  }
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
      lora: selectedH3Lora ? h3LoraOptionToPayload(selectedH3Lora) : undefined,
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
  if (groupRefs.length && requestedProvider !== H3_VIDEO_PROVIDER) assertPrivateSeedanceDestination(selectedModel, videoGroups.origins);
  const content = requestedProvider === H3_VIDEO_PROVIDER ? [] : buildContentArray(providerInput);
  if (multiviewGeneration) assertPrivateSeedanceDestination(selectedModel);
  const snapshot = await createTaskSnapshot({
    workspaceId,
    generationMode,
    promptRaw: body.prompt,
    input: providerInput,
    ...(groupRefs.length ? { promptRenderedOverride: promptRendered, assetMappingOverride: assetMapping,
      protectedGroups: { origins: videoGroups.origins } } : {}),
    ...(multiviewGeneration ? {
      promptRenderedOverride: promptRendered,
      assetMappingOverride: assetMapping,
      protectedRecipeVersion: multiviewGeneration.presetVersion,
    } : {}),
    ...(multiviewAction ? { promptRenderedOverride: promptRendered, assetMappingOverride: {}, protectedAction: {
      binding: creationBody.multiview_action as MultiviewActionBinding, origins: multiviewAction.action.origins } } : {}),
    providerPayloadJson: JSON.stringify(requestedProvider === H3_VIDEO_PROVIDER
      ? {
          provider: H3_VIDEO_PROVIDER,
          preset_id: selectedModel,
          lora_id: selectedH3Lora?.id || null,
          h3_payload: h3GeneratePayload,
          h3_reference_transfers: h3ReferenceTransfer?.transfers.map((item) => ({
            role: item.role,
            source_url: item.source_url,
            h3_filename: item.h3_filename,
            sha256: item.sha256,
            size_bytes: item.size_bytes,
          })) || [],
        }
      : { model: selectedModel, content_item_count: multiviewGeneration ? 3 : content.length,
          referenceCount: preparedImages.length + (multiviewSystemReference ? 1 : 0),
          requested_ratio: ratio,
          ratio: seedanceRatioFollowsFirstFrame(selectedModel, generationMode) ? 'adaptive' : ratio,
          ...(videoEditRequested ? { requested_duration: duration, source_video: editReference, ...seedanceVideoEditParameters(providerInput) } : {}) }),
  });
  const taskParams = {
    ...(groupRefs.length ? { videoPromptGroups: groupRefs, videoPromptGroupsContract: 1 } : {}),
    ...(multiviewAction ? { multiviewAction: creationBody.multiview_action } : {}),
    ...(creationBody.video_feishu === undefined ? {} : { video_feishu: creationBody.video_feishu }),
    ...(canvasInputs ? { canvas_references: canvasInputs.references } : {}),
    ...(multiviewGeneration ? { multiviewGeneration } : {}),
    ...(body.max_estimated_cost !== undefined ? { max_estimated_cost: body.max_estimated_cost } : {}),
    ...(videoEditRequested ? { omni_reference_task_type: 'edit', seedance_edit_reference: editReference } : {}),
    provider: requestedProvider,
    model: selectedModel, generationMode,
    ratio, duration, resolution, seed,
    generateAudio, returnLastFrame, watermark, resolutionApprovalConfirmed,
    referenceAlbumIds: generationReferenceAlbumIds,
    referenceImageIds: generationReferenceImageIds,
    videoCardId,
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
      lora_id: selectedH3Lora?.id || null,
      lora_label: selectedH3Lora?.label || null,
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
  const actualStudioParameters: Record<string, StudioJsonValue> = {
    provider: requestedProvider,
    model: selectedModel,
    generationMode,
    ratio,
    duration,
    resolution,
    seed,
    generateAudio,
    returnLastFrame,
    watermark,
    draft: draftRequested,
    h3LoraId: selectedH3Lora?.id || null,
  };
  const templateStudioSnapshotJson = multiviewAction ? JSON.stringify({ purpose: 'multiview-action', binding: creationBody.multiview_action,
    actionText: multiviewAction.action.actionText, parameters: multiviewAction.action.parameters, geometry: multiviewAction.action.geometry,
    formatRevision: multiviewAction.action.formatRevision, syncRevision: multiviewAction.action.syncRevision }) : studioHandoff && studioSubmission
    ? JSON.stringify(buildStudioTaskSnapshot(studioHandoff, {
        prompt: body.prompt,
        parameters: actualStudioParameters,
        provider: requestedProvider,
        model: selectedModel,
        generationMode,
        ratio,
        duration,
        resolution,
        seed,
        generateAudio,
        returnLastFrame,
        watermark,
        draft: draftRequested,
        projectId: project.id,
        videoCardId,
        videoBranchId: videoBranch?.id || null,
        referenceImageIds: generationReferenceImageIds,
        referenceVideoUrls,
        referenceAudioUrls,
        assets: studioSubmission.assets,
        firstFrameAssetId: studioSubmission.assets.find((asset) => asset.role === 'first')?.assetId || null,
        lastFrameAssetId: studioSubmission.assets.find((asset) => asset.role === 'last')?.assetId || null,
        h3LoraId: selectedH3Lora?.id || null,
        maxEstimatedCost: typeof body.max_estimated_cost === 'number' ? body.max_estimated_cost : null,
      }))
    : null;

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
    source_metadata_json: string | null;
  };
  try {
    const result = await prisma.$transaction(async (tx) => {
      await resolveCanvasReferenceInputs(user, body, tx, { target: 'video' });
      await assertMultiviewRequestFence(tx, user.id, idempotencyKey, requestClaim);
      await assertProjectActiveInTransaction(tx, user, project.id);
      await assertLegacyCreationSourceLocks(tx, user, creationBody, project.id);
      await assertCanvasVideoAdmission(tx, user, body, canvasAdmission, { projectId: project.id,
        videoCardId, branchId: videoBranch?.id || null, amount: estimatedCost });
      await assertVideoPricingAcceptance(priceQuote, body.pricing_revision, tx);
      if (multiviewAction) {
        const fresh = await resolveMultiviewActionVideoInput(user, creationBody, tx, true);
        if (!fresh || fresh.action.prompt !== multiviewAction.action.prompt || fresh.action.assetId !== multiviewAction.action.assetId) {
          throw new AuthError('动作视频输入已变化，请重新准备本次费用；尚未生成', 409);
        }
      }
      if (requireScopeCredential) {
        const freshPricingContext = await resolveVideoPricingContext(user, { ...body, project_id: project.id, video_card_id: videoCardId,
          provider: requestedProvider === H3_VIDEO_PROVIDER ? 'h3' : 'seedance', model: selectedModel, resolution, duration, draft: draftRequested }, 'create', tx);
        verifyVideoPricingCredential(body.pricing_quote_token, freshPricingContext, priceQuote.revision, priceQuote.pricing.estimatedCost);
      }
      if (multiviewGeneration && multiviewRecipe && multiviewSystemReference) {
        const resolved = trustedMultiviewRetry
          ? { preset: await readMultiviewRotationPresetVersion(multiviewGeneration.presetVersion, tx) }
          : await assertMultiviewGenerationSettings(user, multiviewGeneration, tx);
        if (JSON.stringify(resolved.preset) !== JSON.stringify(multiviewRecipe)
          || resolved.preset.compositionReference.assetId !== multiviewSystemReference.assetId
          || resolved.preset.compositionReference.referenceImageId !== multiviewSystemReference.referenceImageId
          || resolved.preset.compositionReference.sha256 !== multiviewSystemReference.sha256) {
          throw new MultiviewPresetError('3D多视图配方已变化，原输入保留；请重新读取后再生成。', 409, 'MULTIVIEW_PRESET_CHANGED');
        }
        const [workspaceInput, mainAsset, mainReference, systemAsset, systemReference, systemOwner] = await Promise.all([
          tx.workspaceAsset.findFirst({ where: { workspace_id: workspaceId, asset_id: multiviewGeneration.mainAssetId,
            reference_image_id: multiviewGeneration.mainReferenceImageId }, select: { id: true } }),
          tx.asset.findUnique({ where: { id: multiviewGeneration.mainAssetId }, select: { status: true, type: true } }),
          tx.referenceImage.findUnique({ where: { id: multiviewGeneration.mainReferenceImageId },
            select: { asset_id: true, status: true } }),
          tx.asset.findUnique({ where: { id: multiviewSystemReference.assetId },
            select: { owner_id: true, status: true, type: true, mime_type: true, hash: true } }),
          tx.referenceImage.findUnique({ where: { id: multiviewSystemReference.referenceImageId },
            select: { asset_id: true, owner_user_id: true, status: true } }),
          tx.user.findUnique({ where: { id: resolved.preset.compositionReference.ownerId }, select: { status: true } }),
        ]);
        if (!workspaceInput || !mainAsset || mainAsset.status !== 'active' || mainAsset.type !== 'image'
          || !mainReference || mainReference.status !== 'active'
          || mainReference.asset_id !== multiviewGeneration.mainAssetId || !systemAsset || systemAsset.status !== 'active'
          || systemAsset.type !== 'image' || systemAsset.mime_type !== 'image/png'
          || systemAsset.owner_id !== resolved.preset.compositionReference.ownerId
          || systemAsset.hash !== null && systemAsset.hash !== multiviewSystemReference.sha256
          || !systemReference || systemReference.status !== 'active'
          || systemReference.asset_id !== multiviewSystemReference.assetId
          || systemReference.owner_user_id !== resolved.preset.compositionReference.ownerId
          || systemOwner?.status !== 'active') {
          throw new MultiviewPresetError('3D多视图输入权限或系统参考已变化，原输入保留；未提交生成。', 409, 'MULTIVIEW_INPUT_CHANGED');
        }
        // Uses one approval in the same transaction as the task, so a rolled-back creation keeps it.
        if (resolution === '1080p' && await consumeMultiview1080pApproval(tx, user.id, idempotencyKey || null) === false) {
          throw new MultiviewPresetError(MULTIVIEW_1080P_REQUIRED_MESSAGE, 403, MULTIVIEW_1080P_APPROVAL_REQUIRED);
        }
      }
      const task = await tx.videoTask.create({
        data: protectVideoPromptGroupTask(protectMultiviewActionVideoTask(transformPrivateVideoText('video-task', {
          id: randomUUID(),
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
          is_draft: draftRequested,
          draft_upgrade_mode: draftRequested ? 'draft' : null,
          draft_contract_version: draftRequested ? SEEDANCE_DRAFT_CONTRACT_VERSION : null,
          user_id: user.id,
          owner_user_id: user.id,
          project_id: project.id,
          video_card_id: videoCardId,
          video_branch_id: videoBranch?.id || null,
          template_id: generationTemplate?.id || null,
          agent_run_id: agentRun?.id || null,
          template_studio_run_id: multiviewAction?.action.runId || studioHandoff?.runId || null,
          template_studio_snapshot_json: templateStudioSnapshotJson,
          request_fingerprint: requestFingerprint,
          selected_agent_plan_key: selectedAgentPlanKey,
          agent_prompt_snapshot: agentPromptSnapshot,
          final_prompt_snapshot: storedFinalPromptSnapshot,
          prompt_user_edited: promptUserEdited,
          visibility: multiviewGeneration || multiviewAction ? 'private' : project.type === 'personal' ? 'private' : 'project',
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
        }, ['prompt', 'final_prompt_snapshot'], true, Boolean(multiviewGeneration)), multiviewAction?.action || null), videoGroups.origins),
      });

      await enqueueVideoFeishuNotification(tx, user.id, task, creationBody.video_feishu);
      await acceptVideoCreationIntent(tx, user, creationBody, { taskId: task.id, cost: estimatedCost,
        pricingRevision: priceQuote.revision,
        ...(canvasAdmission ? { batchChildId: canvasAdmission.reference.child_id } : {}) });

      const usageAttribution = { sourceKind: 'video_task' as const, sourceId: task.id,
        actorUserId: user.id, ownerUserId: task.owner_user_id || task.user_id,
        billingSubjectType: task.billing_scope, billingSubjectId: task.billing_account_id,
        projectId: task.project_id, occurredAt: task.created_at, contextOrigin: 'video-create',
        parentSourceKind: studioHandoff || multiviewAction ? 'video_studio_run' as const : null,
        parentSourceId: multiviewAction?.action.runId || studioHandoff?.runId || null };
      if (body.roleMediaContext && typeof body.roleMediaContext === 'object' && 'runId' in body.roleMediaContext) {
        await inheritUsageAttribution(tx, { ...usageAttribution, parentSourceKind: 'role_run', parentSourceId: String(body.roleMediaContext.runId) });
      } else await recordUsageAttribution(tx, usageAttribution);

      if (!creationV2 && project.type !== 'personal' && resolution === '1080p') {
        if (!videoCard) throw new Error('非个人项目的 1080p 生成必须选择视频卡');
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
            video_card_id: videoCardId,
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

      if (body.roleMediaContext !== undefined) await bindRoleMediaTask(tx, { user, context: body.roleMediaContext,
        generationNodeId: String(cleanSourceMetadata(body.source_metadata).canvas_node_id || body.canvas_node_id) },
      { kind: 'video', taskId: task.id, requestId: idempotencyKey || task.id, ordinal: 1,
        model: selectedModel, providerId: requestedProvider, reservedPoints: estimatedCost });

      await tx.operationLog.create({
        data: {
          operator_id: user.id,
          action: requestSource.source_type === 'codex_api' ? 'generation_create_codex_api' : 'generation_create',
          target_type: 'VideoTask',
          target_id: task.id,
          detail: JSON.stringify({
            project_id: project.id,
            video_card_id: videoCardId,
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
            video_card_id: videoCardId,
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

      await acceptMultiviewRequest(tx, requestClaim, task.id);
      await bindCanvasVideoBatchTask(tx, canvasAdmission, task.id, estimatedCost);
      if (multiviewGeneration) await registerMultiviewWorkIntent(tx, { ownerId: user.id, taskId: task.id,
        projectId: project.id, videoCardId });
      return task;
    });

    taskId = result.id;
    committedTaskId = taskId;
    createdTask = result;
  } catch (err) {
    if (err instanceof VideoFeishuError) return NextResponse.json({ error: videoFeishuErrorText(err.code), code: `video_feishu_${err.code}` }, { status: err.status });
    if (err instanceof CanvasVideoBatchError) {
      if (canvasAdmission && err.code === 'canvas_video_batch_child_accepted') {
        const original = await restoreCanvasVideoBatchCreate(user, receivedBody, 'ordinary');
        if (original.existingTask) return NextResponse.json(canvasVideoBatchTaskResponse(original.existingTask));
      }
      return NextResponse.json({ error: err.message, code: err.code, ...err.details }, { status: err.status });
    }
    if (idempotencyKey && err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'P2002') {
      const racedTask = await prisma.videoTask.findUnique({
        where: { user_id_idempotency_key: { user_id: user.id, idempotency_key: idempotencyKey } },
      });
      if (racedTask) {
        await assertCanvasVideoBatchDedupe(user, canvasAdmission, racedTask);
        const decision = decideGenerationIdempotency(racedTask, {
          requestFingerprint,
          videoCardId,
          templateStudioRunId: requestedStudioRunId,
        });
        if (decision.kind !== 'deduplicated') {
          const conflict = decision.kind === 'legacy_unverifiable'
            ? { code: 'IDEMPOTENCY_LEGACY_UNVERIFIABLE', error: '已找到同请求号的历史任务，但缺少内容指纹。请先查询该任务状态，不要盲目重新提交。' }
            : decision.kind === 'payload_mismatch'
              ? { code: 'IDEMPOTENCY_PAYLOAD_MISMATCH', error: '同一个请求号已对应不同生成内容。请查询已有任务；如确需再生成，应由用户明确发起新请求。' }
              : decision.kind === 'video_card_mismatch'
                ? { code: 'IDEMPOTENCY_VIDEO_CARD_MISMATCH', error: '同一个请求号已绑定其他视频卡，请查询已有任务，不要用该请求号重新提交。' }
                : { code: 'IDEMPOTENCY_STUDIO_LINK_MISMATCH', error: '同一个请求号已用于不同生成链路，请查询已有任务，不要用该请求号重新提交。' };
          return NextResponse.json({ ...conflict, existing_task_id: racedTask.id }, { status: 409 });
        }
        const payload = {
          id: racedTask.id,
          provider: racedTask.provider,
          provider_task_id: racedTask.provider_task_id,
          status: racedTask.local_status,
          model: racedTask.model,
          estimated_cost: racedTask.estimated_cost,
          frozen_cost: racedTask.frozen_cost,
          created_at: racedTask.created_at,
          project_id: racedTask.project_id,
          video_card_id: racedTask.video_card_id,
          template_id: racedTask.template_id,
          template_studio_run_id: racedTask.template_studio_run_id,
          agent_run_id: racedTask.agent_run_id,
          deduplicated: true,
          fingerprint_verified: decision.fingerprintVerified,
        };
        return isPrivateMultiviewTask(racedTask) || hasVideoPromptGroups(racedTask)
          ? NextResponse.json(protectedMultiviewTaskPayload(racedTask, {
              deduplicated: true, fingerprint_verified: decision.fingerprintVerified,
            }), { headers: privateNoStore() })
          : NextResponse.json(payload);
      }
    }
    if (err instanceof CreationError) return NextResponse.json({ error: err.message, code: err.code, stage: 'validation', attemptedSend: false }, { status: err.status });
    if (err instanceof MultiviewPresetError || err instanceof MultiviewSettingsError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    const pricingFailure = videoPricingError(err);
    if (pricingFailure) return NextResponse.json({ error: pricingFailure.message, code: pricingFailure.code }, { status: pricingFailure.status });
    if (err instanceof AuthError) return errorJson(err.message, err.status);
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
            video_card_id: videoCardId,
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
  const seedanceDiagnostic: { value: ProviderCreateDiagnostic | null } = { value: null };
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
      requestPayload: groupRefs.length ? { video_prompt_groups: { schema: 1, refs: groupRefs }, provider: requestedProvider,
        model: selectedModel, generation_mode: generationMode, ratio, duration, resolution }
        : requestedProvider === H3_VIDEO_PROVIDER
        ? {
            ...h3GeneratePayload,
            source: {
              type: requestSource.source_type,
              label: effectiveSourceLabel,
              requestId: sourceRequestId,
              paidGenerationGuard: paidGenerationGuard.metadata,
            },
          }
        : multiviewAction ? { protected_module: multiviewActionPrivateTaskMarker(creationBody.multiview_action as MultiviewActionBinding),
            provider: 'seedance', model: selectedModel, generation_mode: generationMode, ratio, duration, resolution,
            reference_count: 1 } : multiviewGeneration ? {
            protected_module: multiviewPrivateTaskMarker(multiviewGeneration.presetVersion),
            provider: 'seedance', model: selectedModel, generation_mode: generationMode,
            ratio, duration, resolution, reference_count: 2,
            source: { type: requestSource.source_type, label: effectiveSourceLabel,
              requestId: sourceRequestId, paidGenerationGuard: paidGenerationGuard.metadata },
          } : {
            ...providerInput,
            ...(videoEditRequested ? { requested_ratio: ratio, requested_duration: duration, ...seedanceVideoEditParameters(providerInput) } : {}),
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
          ...(groupRefs.length ? { privateOrigins: videoGroups.origins } : {}),
        })
      : await createVideoTask(
          { ...providerInput, ...seedanceReferenceTransport },
          diagnostic => { seedanceDiagnostic.value = diagnostic; },
          { sensitiveRecipe: Boolean(groupRefs.length || multiviewGeneration || multiviewAction),
            ...(groupRefs.length ? { privateOrigins: videoGroups.origins } : multiviewAction ? { privateOrigins: multiviewAction.action.origins } : {}) },
        );

    await prisma.videoTask.update({
      where: { id: taskId },
      data: {
        provider_task_id: providerResult.provider_task_id,
        ...(draftRequested ? { provider_draft_task_id: providerResult.provider_task_id } : {}),
        raw_create_response: groupRefs.length ? JSON.stringify({ accepted: true }) : JSON.stringify(providerResult.raw),
        local_status: 'submitted',
      },
    });

    await markProviderApiRequestAccepted({
      requestId: providerRequest.id,
      task: { ...createdTask, provider_task_id: providerResult.provider_task_id },
      providerTaskId: providerResult.provider_task_id,
      httpStatus: seedanceDiagnostic.value?.http_status,
      responseSummary: {
        seedance_diagnostic: seedanceDiagnostic.value || undefined,
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

    if (groupRefs.length || multiviewGeneration || multiviewAction) {
      return NextResponse.json(protectedMultiviewTaskPayload({ ...createdTask,
        provider_task_id: providerResult.provider_task_id, local_status: 'submitted' }, {
        status: 'submitted', pricing: publicVideoPricing(priceQuote),
        reference_image_notice: referenceImageResizeSummary
          ? `已自动把 ${referenceImageResizeSummary.resized_count} 张过大的本人主图压缩到平台允许尺寸，原图不会被修改。`
          : null,
        reference_image_resize_summary: referenceImageResizeSummary,
      }), { headers: privateNoStore() });
    }

    return NextResponse.json({
      id: taskId,
      provider: requestedProvider,
      provider_task_id: providerResult.provider_task_id,
      is_draft: draftRequested,
      draft_contract_version: draftRequested ? SEEDANCE_DRAFT_CONTRACT_VERSION : null,
      model: selectedModel,
      status: 'submitted',
      estimated_cost: estimatedCost,
      frozen_cost: estimatedCost,
      pricing: publicVideoPricing(priceQuote),
      workspace_id: workspaceId,
      project_id: project.id,
      video_card_id: videoCardId,
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
    if (err instanceof PrivatePromptError) {
      await prisma.videoTask.updateMany({ where: { id: taskId, provider_task_id: null, local_status: 'submitted' },
        data: { error_code: 'PRIVATE_PROMPT_UNCONFIRMED', error_message: '内部模板安全配置待核对，原请求及预留保留，请管理员核对；不会重新提交。' } });
      return errorJson('内部模板安全配置待核对，原请求及预留已保留，请按原请求查询，不要重新提交。', 503);
    }
    const providerFailureMessage = groupRefs.length ? '视频服务暂未完成本次生成，请核对原任务状态和费用。' : err instanceof Error
      ? err.message
      : requestedProvider === H3_VIDEO_PROVIDER ? 'H3 调用异常' : 'Seedance 调用异常';
    const userFacingFailure = providerCreateFailureUserMessage(providerFailureMessage);
    if (providerRequestId) {
      await markProviderApiRequestFailed({
        requestId: providerRequestId,
        errorCode: userFacingFailure.code,
        errorMessage: providerFailureMessage,
        httpStatus: seedanceDiagnostic.value?.http_status,
        responseSummary: {
          seedance_diagnostic: seedanceDiagnostic.value || undefined,
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
                raw: groupRefs.length ? null : err instanceof H3RequestError ? err.raw : null,
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
      userFacingFailure.code,
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
      { status: userFacingFailure.status, ...(multiviewGeneration ? { headers: privateNoStore() } : {}) },
    );
  }
  }
}

  }
// --- Failure handler: release frozen credits in a single transaction ---
async function handleProviderFailure(
  taskId: string,
  userId: string,
  frozenAmount: number,
  errorMessage: string,
  errorCode: string,
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

    if (taskBeforeSettlement.idempotency_key) await restoreMultiview1080pApproval(tx, userId, taskBeforeSettlement.idempotency_key);
    const consumedApprovals = await tx.approvalUsage.findMany({
      where: { task_id: taskId, creation_intent_id: null },
      select: { approval_id: true },
    });
    if (consumedApprovals.length > 0) {
      await tx.approvalUsage.deleteMany({ where: { task_id: taskId, creation_intent_id: null } });
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
        error_code: errorCode || 'PROVIDER_CREATE_FAILED',
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
  forceEmptyWorkspaceReferences = false,
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
  } else if (forceEmptyWorkspaceReferences) {
    imageItems = [];
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
