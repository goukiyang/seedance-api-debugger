import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { isSeedanceVideoDuration, isSeedanceVideoModelId } from '@/lib/provider/seedance-models';
import { RATIO_OPTIONS, RESOLUTION_OPTIONS, type VideoRatio, type VideoResolution } from '@/types';
import {
  PAID_GENERATION_INTENT_HEADER,
  PAID_GENERATION_INTENT_USER_AUTHORIZED,
  PAID_GENERATION_REASON_HEADER,
} from '@/lib/tasks/paid-generation-guard';
import {
  isMultiviewGenerationSeed,
  parseMultiviewGenerationSnapshot,
  type MultiviewGenerationSnapshot,
} from './multiview-generation-contract';
import { readMultiviewPrivateTaskMarker } from './multiview-task-privacy';

export type TrustedMultiviewRetryInput = {
  originalTaskId: string;
  idempotencyKey: string;
  pricingRevision?: string;
  pricingQuoteToken?: string;
  maxEstimatedCost: number;
};

type FrozenTask = {
  source_metadata_json: string | null;
  params_json: string | null;
  project_id: string | null;
  video_card_id: string | null;
  provider: string;
  model: string;
  generation_mode: string;
  ratio: string | null;
  duration: number | null;
  resolution: string | null;
  seed: number | null;
  generate_audio: boolean;
  return_last_frame: boolean;
  watermark: boolean;
  reference_image_ids: string | null;
};

export type SafePrivateMultiviewInput = {
  recipeVersion: string;
  snapshot: MultiviewGenerationSnapshot;
  provider: 'seedance';
  model: string;
  ratio: VideoRatio;
  duration: number;
  resolution: VideoResolution;
  seed: number;
  generateAudio: boolean;
  returnLastFrame: boolean;
  watermark: boolean;
  resolutionApprovalConfirmed: boolean;
  projectId: string;
  videoCardId: string | null;
};

const trustedRetries = new WeakMap<NextRequest, TrustedMultiviewRetryInput>();
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value);

export function readSafePrivateMultiviewInput(task: FrozenTask): SafePrivateMultiviewInput {
  const marker = readMultiviewPrivateTaskMarker(task);
  if (!marker) throw new Error('原任务不是可受信恢复的3D多视图任务');
  let params: unknown;
  try { params = JSON.parse(task.params_json || ''); } catch { throw new Error('原任务的冻结执行参数无法确认'); }
  if (!record(params)) throw new Error('原任务的冻结执行参数无法确认');
  const snapshot = parseMultiviewGenerationSnapshot(params.multiviewGeneration);
  const references = params.referenceImageIds;
  let persistedReferences: unknown;
  try { persistedReferences = JSON.parse(task.reference_image_ids || ''); } catch { throw new Error('原任务的本人主图记录无法确认'); }
  if (!snapshot || snapshot.presetVersion !== marker.recipeVersion
    || !Array.isArray(references) || references.length !== 1 || references[0] !== snapshot.mainReferenceImageId
    || !Array.isArray(persistedReferences) || persistedReferences.length !== 1 || persistedReferences[0] !== snapshot.mainReferenceImageId
    || params.provider !== 'seedance' || params.generationMode !== 'all_in_one_reference'
    || typeof params.model !== 'string' || !isSeedanceVideoModelId(params.model)
    || !RATIO_OPTIONS.includes(params.ratio as VideoRatio) || !isSeedanceVideoDuration(params.duration, params.model)
    || !RESOLUTION_OPTIONS.includes(params.resolution as VideoResolution) || !isMultiviewGenerationSeed(params.seed)
    || typeof params.generateAudio !== 'boolean' || typeof params.returnLastFrame !== 'boolean'
    || typeof params.watermark !== 'boolean' || typeof params.resolutionApprovalConfirmed !== 'boolean'
    || task.provider !== 'seedance' || task.model !== params.model || task.generation_mode !== 'all_in_one_reference'
    || task.ratio !== params.ratio || task.duration !== params.duration || task.resolution !== params.resolution
    || task.seed !== params.seed || task.generate_audio !== params.generateAudio
    || task.return_last_frame !== params.returnLastFrame || task.watermark !== params.watermark
    || !identity(task.project_id) || task.video_card_id !== null && !identity(task.video_card_id)) {
    throw new Error('原任务的私有配方或执行参数不完整，未恢复或重新提交');
  }
  return {
    recipeVersion: marker.recipeVersion,
    snapshot,
    provider: 'seedance',
    model: params.model,
    ratio: params.ratio as VideoRatio,
    duration: params.duration as number,
    resolution: params.resolution as VideoResolution,
    seed: params.seed as number,
    generateAudio: params.generateAudio,
    returnLastFrame: params.returnLastFrame,
    watermark: params.watermark,
    resolutionApprovalConfirmed: params.resolutionApprovalConfirmed,
    projectId: task.project_id,
    videoCardId: task.video_card_id,
  };
}

export function consumeTrustedMultiviewRetry(request: NextRequest): TrustedMultiviewRetryInput | null {
  const value = trustedRetries.get(request) || null;
  if (value) trustedRetries.delete(request);
  return value;
}

/** Server-only adapter. Request headers or JSON cannot create this WeakMap identity. */
export async function createPrivateMultiviewRetry(request: NextRequest, input: TrustedMultiviewRetryInput): Promise<NextResponse> {
  if (!identity(input.originalTaskId) || input.idempotencyKey !== `video-retry:${input.originalTaskId}`
    || typeof input.maxEstimatedCost !== 'number' || !Number.isFinite(input.maxEstimatedCost) || input.maxEstimatedCost < 0
    || input.pricingRevision !== undefined && (typeof input.pricingRevision !== 'string' || input.pricingRevision.length > 160)
    || input.pricingQuoteToken !== undefined && (typeof input.pricingQuoteToken !== 'string' || input.pricingQuoteToken.length > 8192)) {
    return NextResponse.json({ error: 'MULTIVIEW_PRIVATE_RETRY_INVALID', message: '原重试请求无法确认，未重新提交。' }, { status: 400 });
  }
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  headers.set('Content-Type', 'application/json');
  headers.set(PAID_GENERATION_INTENT_HEADER, PAID_GENERATION_INTENT_USER_AUTHORIZED);
  headers.set(PAID_GENERATION_REASON_HEADER, `用户主动重试3D多视图任务 ${input.originalTaskId}`);
  const trustedRequest = new NextRequest(new URL('/api/tasks/create', request.url), {
    method: 'POST', headers, cache: 'no-store', body: JSON.stringify({}),
  });
  trustedRetries.set(trustedRequest, { ...input });
  try {
    const route = await import('@/app/api/tasks/create/route');
    return await route.POST(trustedRequest);
  } finally {
    trustedRetries.delete(trustedRequest);
  }
}
