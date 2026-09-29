import type { GenerationMode, VideoDuration, VideoRatio, VideoResolution } from '@/types';
import type {
  StudioAssetInput,
  StudioGenerationHandoff,
  StudioJsonValue,
  StudioTemplateAssetSlot,
} from '@/lib/template-studio/types';

export type StudioVideoGenerationParameters = {
  provider?: 'seedance' | 'h3';
  model?: string;
  generationMode?: GenerationMode;
  ratio?: VideoRatio;
  duration?: VideoDuration;
  resolution?: VideoResolution;
  seed?: number;
  generateAudio?: boolean;
  returnLastFrame?: boolean;
  watermark?: boolean;
  draft?: boolean;
  h3LoraId?: string;
};

export type StudioVideoParameterMapping = {
  supported: StudioVideoGenerationParameters;
  unsupported: Array<{ key: string; value: StudioJsonValue }>;
};

const PARAMETER_ALIASES: Record<keyof StudioVideoGenerationParameters, string[]> = {
  provider: ['provider'],
  model: ['model'],
  generationMode: ['generationMode', 'generation_mode', 'mode'],
  ratio: ['ratio', 'aspectRatio', 'aspect_ratio'],
  duration: ['duration', 'durationSeconds', 'duration_seconds'],
  resolution: ['resolution'],
  seed: ['seed'],
  generateAudio: ['generateAudio', 'generate_audio'],
  returnLastFrame: ['returnLastFrame', 'return_last_frame'],
  watermark: ['watermark'],
  draft: ['draft'],
  h3LoraId: ['h3LoraId', 'h3_lora_id', 'loraId', 'lora_id'],
};

const GENERATION_MODES = new Set<GenerationMode>([
  'all_in_one_reference',
  'first_last_frame',
  'smart_multi_frame',
]);
const VIDEO_RATIOS = new Set<VideoRatio>(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']);
const VIDEO_RESOLUTIONS = new Set<VideoResolution>(['480p', '720p', '1080p']);

function isVideoDuration(value: unknown): value is VideoDuration {
  return typeof value === 'number' && Number.isInteger(value) && value >= 4 && value <= 15;
}

function normalizeParameter(key: keyof StudioVideoGenerationParameters, value: StudioJsonValue): unknown {
  switch (key) {
    case 'provider':
      return value === 'seedance' || value === 'h3' ? value : undefined;
    case 'model':
    case 'h3LoraId':
      return typeof value === 'string' && value.trim() ? value.trim() : undefined;
    case 'generationMode':
      return typeof value === 'string' && GENERATION_MODES.has(value as GenerationMode) ? value : undefined;
    case 'ratio':
      return typeof value === 'string' && VIDEO_RATIOS.has(value as VideoRatio) ? value : undefined;
    case 'duration':
      return isVideoDuration(value) ? value : undefined;
    case 'resolution':
      return typeof value === 'string' && VIDEO_RESOLUTIONS.has(value as VideoResolution) ? value : undefined;
    case 'seed':
      return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
    case 'generateAudio':
    case 'returnLastFrame':
    case 'watermark':
    case 'draft':
      return typeof value === 'boolean' ? value : undefined;
  }
}

export function mapStudioVideoParameters(parameters: Record<string, StudioJsonValue>): StudioVideoParameterMapping {
  const supported: StudioVideoGenerationParameters = {};
  const unsupported: Array<{ key: string; value: StudioJsonValue }> = [];
  const consumedKeys = new Set<string>();

  for (const [canonicalKey, aliases] of Object.entries(PARAMETER_ALIASES) as Array<[
    keyof StudioVideoGenerationParameters,
    string[],
  ]>) {
    const matches = aliases.filter((key) => Object.hasOwn(parameters, key));
    if (matches.length === 0) continue;
    const normalized = matches.map((key) => ({ key, value: normalizeParameter(canonicalKey, parameters[key]) }));
    const first = normalized[0];
    if (normalized.some((item) => item.value === undefined || item.value !== first.value)) {
      for (const item of normalized) unsupported.push({ key: item.key, value: parameters[item.key] });
      matches.forEach((key) => consumedKeys.add(key));
      continue;
    }
    (supported as Record<string, unknown>)[canonicalKey] = first.value;
    matches.forEach((key) => consumedKeys.add(key));
  }

  for (const [key, value] of Object.entries(parameters)) {
    if (!consumedKeys.has(key)) unsupported.push({ key, value });
  }

  return { supported, unsupported };
}

export function getUnknownStudioVideoParameterKeys(parameters: Record<string, StudioJsonValue>): string[] {
  const supportedKeys = new Set(Object.values(PARAMETER_ALIASES).flat());
  return Object.keys(parameters).filter((key) => !supportedKeys.has(key));
}

export function formatUnsupportedStudioParameters(unsupported: StudioVideoParameterMapping['unsupported']): string | null {
  if (unsupported.length === 0) return null;
  const details = unsupported.map(({ key, value }) => `${key}=${JSON.stringify(value)}`).join('、');
  return `模板参数无法由当前普通视频生成设置完整承接，已保留且阻止提交：${details}。请移除模板中的不支持参数或改用兼容设置。`;
}

export type StudioTaskSnapshotInput = {
  prompt: string;
  parameters: Record<string, StudioJsonValue>;
  provider: string;
  model: string;
  generationMode: string;
  ratio: string;
  duration: number;
  resolution: string;
  seed: number;
  generateAudio: boolean;
  returnLastFrame: boolean;
  watermark: boolean;
  draft: boolean;
  projectId: string;
  videoCardId: string;
  videoBranchId: string | null;
  referenceImageIds: string[];
  referenceVideoUrls: string[];
  referenceAudioUrls: string[];
  assets: Array<{ assetId: string; role: 'reference' | 'first' | 'last'; type: 'image' | 'video' | 'audio'; slotKey?: string }>;
  firstFrameAssetId: string | null;
  lastFrameAssetId: string | null;
  h3LoraId: string | null;
  maxEstimatedCost: number | null;
};

export function buildStudioTaskSnapshot(
  handoff: StudioGenerationHandoff,
  submitted: StudioTaskSnapshotInput,
) {
  return {
    version: 1,
    runId: handoff.runId,
    legacyTemplateId: handoff.legacyTemplateId,
    sourceSnapshot: handoff.snapshot,
    submitted: {
      ...submitted,
      prompt: submitted.prompt.trim(),
      parameters: { ...submitted.parameters },
      referenceImageIds: [...submitted.referenceImageIds],
      referenceVideoUrls: [...submitted.referenceVideoUrls],
      referenceAudioUrls: [...submitted.referenceAudioUrls],
      assets: submitted.assets.map((asset) => ({ ...asset })),
    },
  };
}

export function stableGenerationPayloadJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

export type GenerationIdempotencyRecord = {
  request_fingerprint: string | null;
  video_card_id: string | null;
  template_studio_run_id?: string | null;
};

export type GenerationIdempotencyDecision =
  | { kind: 'deduplicated'; fingerprintVerified: boolean }
  | { kind: 'payload_mismatch' }
  | { kind: 'legacy_unverifiable' }
  | { kind: 'video_card_mismatch' }
  | { kind: 'studio_link_mismatch' };

export function decideGenerationIdempotency(
  existing: GenerationIdempotencyRecord,
  current: { requestFingerprint: string; videoCardId: string; templateStudioRunId: string | null },
): GenerationIdempotencyDecision {
  if (current.templateStudioRunId) {
    if (existing.template_studio_run_id !== current.templateStudioRunId) {
      return { kind: 'studio_link_mismatch' };
    }
    if (!existing.request_fingerprint) return { kind: 'legacy_unverifiable' };
    return existing.request_fingerprint === current.requestFingerprint
      ? { kind: 'deduplicated', fingerprintVerified: true }
      : { kind: 'payload_mismatch' };
  }

  if (existing.template_studio_run_id) return { kind: 'studio_link_mismatch' };
  if (existing.video_card_id && existing.video_card_id !== current.videoCardId) {
    return { kind: 'video_card_mismatch' };
  }
  if (existing.request_fingerprint === null) {
    return { kind: 'deduplicated', fingerprintVerified: false };
  }
  if (existing.request_fingerprint !== current.requestFingerprint) {
    return { kind: 'payload_mismatch' };
  }
  return {
    kind: 'deduplicated',
    fingerprintVerified: true,
  };
}

export function getStudioMaterialCompatibilityError<TAsset extends Pick<StudioAssetInput, 'role' | 'type'>>(input: {
  provider: string;
  generationMode: GenerationMode;
  assets: TAsset[];
}): string | null {
  const referenceAssets = input.assets.filter((asset) => asset.role === 'reference');
  const firstCount = input.assets.filter((asset) => asset.role === 'first').length;
  const lastCount = input.assets.filter((asset) => asset.role === 'last').length;
  if ((firstCount > 0 || lastCount > 0) && input.generationMode !== 'first_last_frame') {
    return '模板首尾帧素材必须使用首尾帧生成模式';
  }
  if (input.generationMode === 'first_last_frame' && (firstCount !== 1 || lastCount > 1)) {
    return '首尾帧模式要求一个首帧和至多一个尾帧；模板标记为必填的素材槽仍必须补齐';
  }
  if (input.generationMode === 'first_last_frame' && referenceAssets.length > 0) {
    return '首尾帧模式只接收首帧和可选尾帧，普通参考素材不会被发送；请移除普通参考素材或改用兼容模式';
  }
  if (input.generationMode === 'smart_multi_frame' && referenceAssets.some((asset) => asset.type !== 'image')) {
    return '智能多帧模式只接收图片帧，模板中的视频或音频参考不会被发送';
  }
  if (input.provider === 'h3' && referenceAssets.length > 0) {
    return 'H3 当前只直接接收首尾帧文件，普通参考素材不会被发送；请移除普通参考素材或改用 Seedance';
  }
  return null;
}

export function getMissingRequiredStudioAssetSlot(
  slots: StudioTemplateAssetSlot[] | undefined,
  assets: StudioAssetInput[],
) {
  return slots?.find((slot) => slot.required === true && !assets.some((asset) => (
    asset.slotKey === slot.key
    && asset.role === slot.role
    && slot.types.includes(asset.type)
  ))) || null;
}

export function buildAcceptedTaskLookupWhere(userId: string, idempotencyKey: string, studioRunId?: string | null) {
  return {
    user_id: userId,
    idempotency_key: idempotencyKey,
    ...(studioRunId ? { template_studio_run_id: studioRunId } : {}),
  };
}

export function isStudioHandoffWorkspaceInitialized(createdAt: Date, updatedAt: Date) {
  return updatedAt.getTime() > createdAt.getTime();
}
