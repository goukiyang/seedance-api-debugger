import { MAX_GENERATION_PROMPT_CHARS } from '@/lib/prompt/limits';
import { isSeedanceVideoDuration, isSeedanceVideoModelId, SEEDANCE_2_0_MODEL_ID } from '@/lib/provider/seedance-models';
import { RATIO_OPTIONS, RESOLUTION_OPTIONS, type VideoRatio, type VideoResolution } from '@/types';

export const MULTIVIEW_ROTATION_PRESET = Object.freeze({
  id: 'multiview-360', version: '1.0.0',
  prompt: '根据图片生成360度3d模型旋转效果。固定镜头，角色静态无动作，四边边上预留最少25%出血位 @图片1',
  defaults: Object.freeze({ provider: 'seedance', generationMode: 'all_in_one_reference', model: SEEDANCE_2_0_MODEL_ID,
    ratio: '1:1', duration: 4, resolution: '480p', seed: -1, generateAudio: true, returnLastFrame: false, watermark: false }),
} as const);

// The existing renderer's exact preamble for one reference-image workspace row.
export const MULTIVIEW_REFERENCE_PROMPT_PREFIX = '【参考素材说明】图1（参考图）。\n';
const SUPPLEMENT_SEPARATOR = '\n\n补充要求（仅补充细节，保持固定镜头、角色静止及完整旋转约束）：\n';

export type MultiviewGenerationDraft = {
  schema: 1; presetVersion: string; workspaceTabId: string; projectId: string; videoCardId: string;
  mainImage: { assetId: string; referenceImageId: string } | null;
  provider: string; generationMode: string; model: string; ratio: string; duration: number; resolution: string;
  supplement: string; seed: number; generateAudio: boolean; returnLastFrame: boolean; watermark: boolean;
  resolutionApprovalConfirmed: boolean; resolutionApprovalId: string;
};
export type MultiviewGenerationSnapshot = {
  schema: 1; presetId: typeof MULTIVIEW_ROTATION_PRESET.id; presetVersion: typeof MULTIVIEW_ROTATION_PRESET.version;
  supplement: string; workspaceTabId: string; mainAssetId: string; mainReferenceImageId: string;
};
export type MultiviewGenerationRequest = {
  prompt: string; final_prompt_snapshot: string; prompt_user_edited: boolean;
  provider: 'seedance'; model: string; generation_mode: 'all_in_one_reference'; ratio: VideoRatio; duration: number; resolution: VideoResolution;
  seed: number; generate_audio: boolean; return_last_frame: boolean; watermark: boolean; draft: false;
  project_id: string; video_card_id?: string; reference_image_ids: [string];
  reference_video_urls: []; reference_audio_urls: []; resolution_approval_confirmed: boolean;
  resolution_approval_id?: string; idempotency_key: string; max_estimated_cost: number;
  client_name: 'multiview'; source_metadata: { source: 'multiview'; mode: 'rotation' };
  multiview_generation: MultiviewGenerationSnapshot;
};

export function defaultMultiviewGenerationDraft(workspaceTabId = ''): MultiviewGenerationDraft {
  return { schema: 1, presetVersion: MULTIVIEW_ROTATION_PRESET.version, workspaceTabId, projectId: '', videoCardId: '', mainImage: null,
    ...MULTIVIEW_ROTATION_PRESET.defaults, supplement: '', resolutionApprovalConfirmed: false, resolutionApprovalId: '' };
}

function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function boundedString(value: unknown, maximum: number): value is string { return typeof value === 'string' && value.length <= maximum; }
function identity(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value); }
export function isMultiviewWorkspaceTabId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 96 && /^(?:multiview|mv04)[-_:][A-Za-z0-9:_-]{1,80}$/.test(value);
}

// Existing template inputs use -1 for random; VideoTask.seed is a Prisma Int.
export function isMultiviewGenerationSeed(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= -1 && value <= 2147483647;
}

/** Preserve bounded unavailable choices for display. Validation belongs to explicit submission. */
export function parseMultiviewGenerationDraft(value: unknown): MultiviewGenerationDraft | null {
  if (typeof value === 'string') {
    if (value.length > 128000) return null;
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!record(value) || value.schema !== 1) return null;
  for (const key of ['presetVersion', 'workspaceTabId', 'projectId', 'videoCardId', 'provider', 'generationMode', 'model', 'ratio', 'resolution', 'resolutionApprovalId'] as const) {
    if (!boundedString(value[key], 200)) return null;
  }
  if (!boundedString(value.supplement, 40000) || typeof value.duration !== 'number' || !Number.isFinite(value.duration) || Math.abs(value.duration) > 1000000
    || typeof value.seed !== 'number' || !Number.isSafeInteger(value.seed)) return null;
  for (const key of ['generateAudio', 'returnLastFrame', 'watermark', 'resolutionApprovalConfirmed'] as const) if (typeof value[key] !== 'boolean') return null;
  const image = value.mainImage;
  if (image !== null && (!record(image) || !boundedString(image.assetId, 200) || !boundedString(image.referenceImageId, 200))) return null;
  return {
    schema: 1, presetVersion: value.presetVersion as string, workspaceTabId: value.workspaceTabId as string,
    projectId: value.projectId as string, videoCardId: value.videoCardId as string,
    mainImage: image === null ? null : { assetId: (image as Record<string, unknown>).assetId as string, referenceImageId: (image as Record<string, unknown>).referenceImageId as string },
    provider: value.provider as string, generationMode: value.generationMode as string, model: value.model as string,
    ratio: value.ratio as string, duration: value.duration, resolution: value.resolution as string, supplement: value.supplement,
    seed: value.seed, generateAudio: value.generateAudio as boolean, returnLastFrame: value.returnLastFrame as boolean,
    watermark: value.watermark as boolean, resolutionApprovalConfirmed: value.resolutionApprovalConfirmed as boolean,
    resolutionApprovalId: value.resolutionApprovalId as string,
  };
}

export function composeMultiviewGenerationPrompt(supplement: string, presetVersion: string = MULTIVIEW_ROTATION_PRESET.version): {
  prompt: string; characters: number; remainingCharacters: number; valid: boolean; error: string | null;
} {
  if (typeof supplement !== 'string' || presetVersion !== MULTIVIEW_ROTATION_PRESET.version) {
    return { prompt: '', characters: 0, remainingCharacters: 0, valid: false, error: '固定旋转模板版本尚未确认，已有输入保留，请明确恢复当前预设后再生成' };
  }
  const prompt = MULTIVIEW_ROTATION_PRESET.prompt + (supplement.length ? SUPPLEMENT_SEPARATOR + supplement : '');
  const characters = MULTIVIEW_REFERENCE_PROMPT_PREFIX.length + prompt.length;
  // Reserve the separator before the first supplementary character is entered.
  const remainingCharacters = MAX_GENERATION_PROMPT_CHARS - characters - (supplement.length ? 0 : SUPPLEMENT_SEPARATOR.length);
  return { prompt, characters, remainingCharacters, valid: characters <= MAX_GENERATION_PROMPT_CHARS,
    error: characters > MAX_GENERATION_PROMPT_CHARS ? `固定文案和补充要求合计最多 ${MAX_GENERATION_PROMPT_CHARS} 字，当前超出 ${characters - MAX_GENERATION_PROMPT_CHARS} 字；没有截断内容` : null };
}

export function parseMultiviewGenerationSnapshot(value: unknown): MultiviewGenerationSnapshot | null {
  if (!record(value) || value.schema !== 1 || value.presetId !== MULTIVIEW_ROTATION_PRESET.id || value.presetVersion !== MULTIVIEW_ROTATION_PRESET.version
    || !boundedString(value.supplement, 40000) || !isMultiviewWorkspaceTabId(value.workspaceTabId) || !identity(value.mainAssetId) || !identity(value.mainReferenceImageId)) return null;
  return { schema: 1, presetId: MULTIVIEW_ROTATION_PRESET.id, presetVersion: MULTIVIEW_ROTATION_PRESET.version,
    supplement: value.supplement, workspaceTabId: value.workspaceTabId, mainAssetId: value.mainAssetId, mainReferenceImageId: value.mainReferenceImageId };
}

export function buildMultiviewGenerationRequest(draft: MultiviewGenerationDraft, options: {
  idempotencyKey: string; maxEstimatedCost: number;
}): MultiviewGenerationRequest {
  if (!parseMultiviewGenerationDraft(draft)) throw new Error('生成设置无法安全读取，原输入保留');
  const composed = composeMultiviewGenerationPrompt(draft.supplement, draft.presetVersion);
  if (!composed.valid) throw new Error(composed.error || '完整文案无效');
  if (draft.provider !== 'seedance' || draft.generationMode !== 'all_in_one_reference') throw new Error('当前旋转预设不支持所选生成通道或模式，已有选择保留');
  if (!isSeedanceVideoModelId(draft.model)) throw new Error('当前型号不在可用普通视频型号中，已有选择保留，请明确选择可用型号');
  if (!isSeedanceVideoDuration(draft.duration, draft.model)) throw new Error('当前型号不支持所选时长，已有选择保留');
  if (!RATIO_OPTIONS.includes(draft.ratio as VideoRatio) || !RESOLUTION_OPTIONS.includes(draft.resolution as VideoResolution)) throw new Error('所选比例或清晰度当前不可用，已有选择保留');
  if (!isMultiviewGenerationSeed(draft.seed)) throw new Error('随机种子须为 -1（随机）或 0–2147483647 的整数，已有输入保留');
  if (!identity(draft.projectId)) throw new Error('请先明确保存到的项目');
  if (draft.videoCardId && !identity(draft.videoCardId)) throw new Error('所选视频卡无效，请明确重新选择或取消关联');
  if (!isMultiviewWorkspaceTabId(draft.workspaceTabId)) throw new Error('本页素材工作区尚未确认，已有输入保留');
  if (!draft.mainImage || !identity(draft.mainImage.assetId) || !identity(draft.mainImage.referenceImageId)) throw new Error('请先准备一张有权用于生成的主图');
  if (draft.resolutionApprovalId && !identity(draft.resolutionApprovalId)) throw new Error('清晰度审批编号无效，已有选择保留');
  if (typeof options.idempotencyKey !== 'string' || !options.idempotencyKey.trim() || options.idempotencyKey !== options.idempotencyKey.trim() || options.idempotencyKey.length > 200) throw new Error('生成请求编号无效');
  if (!Number.isFinite(options.maxEstimatedCost) || !Number.isInteger(options.maxEstimatedCost) || options.maxEstimatedCost < 0) throw new Error('当前报价尚未确认，未提交生成');
  return {
    prompt: composed.prompt, final_prompt_snapshot: composed.prompt, prompt_user_edited: draft.supplement.length > 0,
    provider: 'seedance', model: draft.model, generation_mode: 'all_in_one_reference', ratio: draft.ratio as VideoRatio,
    duration: draft.duration, resolution: draft.resolution as VideoResolution, seed: draft.seed,
    generate_audio: draft.generateAudio, return_last_frame: draft.returnLastFrame, watermark: draft.watermark, draft: false,
    project_id: draft.projectId, ...(draft.videoCardId ? { video_card_id: draft.videoCardId } : {}), reference_image_ids: [draft.mainImage.referenceImageId],
    reference_video_urls: [], reference_audio_urls: [], resolution_approval_confirmed: draft.resolutionApprovalConfirmed,
    ...(draft.resolutionApprovalId ? { resolution_approval_id: draft.resolutionApprovalId } : {}),
    idempotency_key: options.idempotencyKey, max_estimated_cost: options.maxEstimatedCost,
    client_name: 'multiview', source_metadata: { source: 'multiview', mode: 'rotation' },
    multiview_generation: { schema: 1, presetId: MULTIVIEW_ROTATION_PRESET.id, presetVersion: MULTIVIEW_ROTATION_PRESET.version,
      supplement: draft.supplement, workspaceTabId: draft.workspaceTabId,
      mainAssetId: draft.mainImage.assetId, mainReferenceImageId: draft.mainImage.referenceImageId },
  };
}
