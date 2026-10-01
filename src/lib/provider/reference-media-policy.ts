import { SEEDANCE_2_5_IP_MODEL_ID } from '@/lib/provider/seedance-models';

export const PROVIDER_REFERENCE_MEDIA_MIN_PIXELS = 409_600;
export const SEEDANCE_REFERENCE_VIDEO_LIMIT = 3;
export const SEEDANCE_REFERENCE_AUDIO_LIMIT = 3;
export const SEEDANCE_REFERENCE_IMAGE_LIMIT = 9;
export const SEEDANCE_REFERENCE_MEDIA_MIN_DURATION_SECONDS = 2;
export const SEEDANCE_REFERENCE_MEDIA_MAX_DURATION_SECONDS = 15;
export const SEEDANCE_REFERENCE_MEDIA_MIN_ASPECT_RATIO = 0.4;
export const SEEDANCE_REFERENCE_MEDIA_MAX_ASPECT_RATIO = 2.5;

export type SeedanceReferenceMediaCapabilities = {
  imageLimit: number;
  videoLimit: number;
  audioLimit: number;
  minDurationSeconds: number;
  maxDurationSeconds: number;
  totalDurationLimitSeconds: number | null;
  audioOnly: boolean;
  videoPixelMin: number | null;
  videoPixelMax: number | null;
  videoEdgeMin: number | null;
  videoEdgeMax: number | null;
  videoFpsMin: number | null;
  videoFpsMax: number | null;
  requiresVideoMetadata: boolean;
  requiresAudioDurationMetadata: boolean;
};

const SEEDANCE_2_5_IP_REFERENCE_MEDIA_CAPABILITIES: SeedanceReferenceMediaCapabilities = {
  imageLimit: 30,
  videoLimit: 10,
  audioLimit: 10,
  minDurationSeconds: 2,
  maxDurationSeconds: 30,
  totalDurationLimitSeconds: 30,
  audioOnly: true,
  videoPixelMin: 407_696,
  videoPixelMax: 8_295_044,
  videoEdgeMin: 300,
  videoEdgeMax: 6_000,
  videoFpsMin: 24,
  videoFpsMax: 60,
  requiresVideoMetadata: true,
  requiresAudioDurationMetadata: true,
};

const LEGACY_SEEDANCE_REFERENCE_MEDIA_CAPABILITIES: SeedanceReferenceMediaCapabilities = {
  imageLimit: SEEDANCE_REFERENCE_IMAGE_LIMIT,
  videoLimit: SEEDANCE_REFERENCE_VIDEO_LIMIT,
  audioLimit: SEEDANCE_REFERENCE_AUDIO_LIMIT,
  minDurationSeconds: SEEDANCE_REFERENCE_MEDIA_MIN_DURATION_SECONDS,
  maxDurationSeconds: SEEDANCE_REFERENCE_MEDIA_MAX_DURATION_SECONDS,
  totalDurationLimitSeconds: null,
  audioOnly: false,
  videoPixelMin: null,
  videoPixelMax: null,
  videoEdgeMin: null,
  videoEdgeMax: null,
  videoFpsMin: null,
  videoFpsMax: null,
  requiresVideoMetadata: false,
  requiresAudioDurationMetadata: false,
};

export function seedanceReferenceMediaCapabilities(model?: string | null): SeedanceReferenceMediaCapabilities {
  return model === SEEDANCE_2_5_IP_MODEL_ID
    ? { ...SEEDANCE_2_5_IP_REFERENCE_MEDIA_CAPABILITIES }
    : { ...LEGACY_SEEDANCE_REFERENCE_MEDIA_CAPABILITIES };
}

export type ReferenceMediaKind = 'image' | 'video' | 'audio';

export type ReferenceMediaRuleSource = 'official' | 'historical_failure' | 'internal_link' | 'observe_only';
export type ReferenceMediaRuleStage = 'asset_ingest' | 'generation_preflight' | 'transport_capability' | 'observe';

export type ReferenceMediaRule = {
  id: string;
  source: ReferenceMediaRuleSource;
  stage: ReferenceMediaRuleStage;
  description: string;
};

export const SEEDANCE_REFERENCE_MEDIA_RULES: ReferenceMediaRule[] = [
  {
    id: 'upload.file_size.image',
    source: 'official',
    stage: 'asset_ingest',
    description: '图片素材入库最大 30MB。',
  },
  {
    id: 'upload.file_size.video',
    source: 'official',
    stage: 'asset_ingest',
    description: '视频素材入库最大 200MB。',
  },
  {
    id: 'upload.file_size.audio',
    source: 'official',
    stage: 'asset_ingest',
    description: '音频素材入库最大 15MB。',
  },
  {
    id: 'seedance2.image.count',
    source: 'official',
    stage: 'generation_preflight',
    description: 'Seedance 2.0 单次生成最多 9 张参考图。',
  },
  {
    id: 'seedance2.video.count',
    source: 'official',
    stage: 'generation_preflight',
    description: 'Seedance 2.0 单次生成最多 3 个参考视频。',
  },
  {
    id: 'seedance2.audio.count',
    source: 'official',
    stage: 'generation_preflight',
    description: 'Seedance 2.0 单次生成最多 3 个参考音频。',
  },
  {
    id: 'seedance2.audio.requires_visual',
    source: 'official',
    stage: 'generation_preflight',
    description: 'Seedance 2.0 音频参考不能单独使用，必须搭配图片或视频。',
  },
  {
    id: 'seedance25_ip.media.count',
    source: 'official',
    stage: 'generation_preflight',
    description: '火山 IP Seedance 2.5 单次生成最多 30 张图片、10 个视频和 10 个音频参考。',
  },
  {
    id: 'seedance25_ip.media.duration',
    source: 'official',
    stage: 'generation_preflight',
    description: '火山 IP Seedance 2.5 单个参考视频和参考音频时长均为 2-30 秒。',
  },
  {
    id: 'seedance25_ip.audio.only',
    source: 'official',
    stage: 'generation_preflight',
    description: '火山 IP Seedance 2.5 支持不搭配图片或视频的音频参考。',
  },
  {
    id: 'seedance25_ip.media.total_duration',
    source: 'official',
    stage: 'generation_preflight',
    description: '火山 IP Seedance 2.5 的参考视频总时长和参考音频总时长分别不能超过 30 秒。',
  },
  {
    id: 'seedance25_ip.video.metadata',
    source: 'official',
    stage: 'generation_preflight',
    description: '火山 IP Seedance 2.5 参考视频需要可核验的时长、画面尺寸和帧率元数据。',
  },
  {
    id: 'seedance25_ip.video.dimensions_fps',
    source: 'official',
    stage: 'generation_preflight',
    description: '火山 IP Seedance 2.5 参考视频为 407696-8295044 像素，宽高均为 300-6000 像素，帧率为 24-60 fps。',
  },
  {
    id: 'seedance25_ip.audio.metadata',
    source: 'official',
    stage: 'generation_preflight',
    description: '火山 IP Seedance 2.5 参考音频需要可核验的时长元数据。',
  },
  {
    id: 'seedance2.video.duration',
    source: 'official',
    stage: 'generation_preflight',
    description: 'Seedance 2.0 参考视频用于生成时长需为 2-15 秒。',
  },
  {
    id: 'seedance2.audio.duration',
    source: 'official',
    stage: 'generation_preflight',
    description: 'Seedance 2.0 参考音频用于生成时长需为 2-15 秒。',
  },
  {
    id: 'seedance2.media.min_pixels',
    source: 'official',
    stage: 'generation_preflight',
    description: 'Seedance 2.0 图片/视频参考素材至少 409600 像素。',
  },
  {
    id: 'seedance2.media.aspect_ratio',
    source: 'official',
    stage: 'generation_preflight',
    description: 'Seedance 2.0 图片/视频参考素材宽高比需在 0.4-2.5。',
  },
  {
    id: 'seedance2.video.format',
    source: 'official',
    stage: 'generation_preflight',
    description: 'Seedance 2.0 参考视频用于生成时建议使用 MP4/MOV。',
  },
  {
    id: 'seedance2.audio.format',
    source: 'official',
    stage: 'generation_preflight',
    description: 'Seedance 2.0 参考音频用于生成时建议使用 MP3/WAV。',
  },
  {
    id: 'upload.legacy_multipart_8mb',
    source: 'internal_link',
    stage: 'transport_capability',
    description: '旧 multipart 表单入口只兼容 8MB 以内，这是链路能力限制，不是素材合规限制。',
  },
  {
    id: 'upload.video.raw_fallback_disabled',
    source: 'internal_link',
    stage: 'transport_capability',
    description: '视频暂不自动回退普通上传，这是当前上传链路能力限制，不是 Provider 官方素材限制。',
  },
  {
    id: 'provider.unknown_error',
    source: 'observe_only',
    stage: 'observe',
    description: 'Provider 新错误先记录结构化摘要，不直接固化为新拦截规则。',
  },
];

export type ReferenceMediaSizeInput = {
  kind: ReferenceMediaKind;
  name?: string | null;
  width?: number | null;
  height?: number | null;
  index?: number;
};

export function referenceMediaPixelCount(width: number | null | undefined, height: number | null | undefined) {
  if (!width || !height || width <= 0 || height <= 0) return null;
  return width * height;
}

export function isReferenceMediaTooSmall(width: number | null | undefined, height: number | null | undefined) {
  const pixels = referenceMediaPixelCount(width, height);
  return pixels !== null && pixels < PROVIDER_REFERENCE_MEDIA_MIN_PIXELS;
}

export function referenceMediaKindLabel(kind: ReferenceMediaKind) {
  if (kind === 'video') return '视频';
  if (kind === 'audio') return '音频';
  return '图片';
}

export function referenceMediaDimensionsText(width: number | null | undefined, height: number | null | undefined) {
  return width && height ? `${width}x${height}` : '未知尺寸';
}

export function referenceMediaTooSmallMessage(input: ReferenceMediaSizeInput) {
  const kindLabel = referenceMediaKindLabel(input.kind);
  const fallbackName = input.index != null ? `${kindLabel}${input.index + 1}` : `参考${kindLabel}`;
  const name = input.name?.trim() || fallbackName;
  const pixels = referenceMediaPixelCount(input.width, input.height);
  const pixelText = pixels === null ? '' : `，约 ${pixels} 像素`;
  return `参考${kindLabel}「${name}」分辨率太低：${referenceMediaDimensionsText(input.width, input.height)}${pixelText}。生成服务要求参考素材至少 ${PROVIDER_REFERENCE_MEDIA_MIN_PIXELS} 像素，请换更清晰的素材，或先放大、重新导出后再提交。`;
}

export type SeedanceReferenceMediaItem = {
  url?: string | null;
  name?: string | null;
  mimeType?: string | null;
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
  fps?: number | null;
  index?: number;
};

export type SeedanceReferenceMediaPreflightInput = {
  model?: string;
  metadataValidation?: 'known-only' | 'required';
  images?: SeedanceReferenceMediaItem[];
  videos?: SeedanceReferenceMediaItem[];
  audios?: SeedanceReferenceMediaItem[];
};

export type SeedanceReferenceMediaPreflightIssue = {
  code:
    | 'REFERENCE_IMAGE_COUNT_EXCEEDED'
    | 'REFERENCE_VIDEO_COUNT_EXCEEDED'
    | 'REFERENCE_AUDIO_COUNT_EXCEEDED'
    | 'REFERENCE_AUDIO_REQUIRES_VISUAL'
    | 'REFERENCE_VIDEO_DURATION_UNSUPPORTED'
    | 'REFERENCE_AUDIO_DURATION_UNSUPPORTED'
    | 'REFERENCE_VIDEO_FORMAT_UNSUPPORTED'
    | 'REFERENCE_AUDIO_FORMAT_UNSUPPORTED'
    | 'REFERENCE_MEDIA_ASPECT_RATIO_UNSUPPORTED'
    | 'REFERENCE_MEDIA_TOO_SMALL'
    | 'REFERENCE_MEDIA_METADATA_UNAVAILABLE'
    | 'REFERENCE_MEDIA_TOTAL_DURATION_EXCEEDED'
    | 'REFERENCE_VIDEO_PIXELS_OUT_OF_RANGE'
    | 'REFERENCE_VIDEO_EDGE_UNSUPPORTED'
    | 'REFERENCE_MEDIA_DIMENSIONS_UNSUPPORTED'
    | 'REFERENCE_VIDEO_FPS_UNSUPPORTED';
  message: string;
  ruleId: string;
  kind?: ReferenceMediaKind;
  index?: number;
};

function mediaName(kind: ReferenceMediaKind, item: SeedanceReferenceMediaItem, index: number) {
  return item.name?.trim() || `${referenceMediaKindLabel(kind)}${index + 1}`;
}

function normalizeMimeType(value: string | null | undefined) {
  return value?.split(';')[0]?.trim().toLowerCase() || '';
}

function mimeTypeFromUrl(value: string | null | undefined) {
  if (!value) return '';
  const path = value.split('?')[0]?.toLowerCase() || '';
  if (path.endsWith('.mp4')) return 'video/mp4';
  if (path.endsWith('.mov')) return 'video/quicktime';
  if (path.endsWith('.webm')) return 'video/webm';
  if (path.endsWith('.mp3')) return 'audio/mpeg';
  if (path.endsWith('.wav')) return 'audio/wav';
  if (path.endsWith('.ogg')) return 'audio/ogg';
  return '';
}

function mediaMimeType(item: SeedanceReferenceMediaItem) {
  return normalizeMimeType(item.mimeType) || mimeTypeFromUrl(item.url);
}

function knownDurationIssue(
  kind: 'video' | 'audio',
  item: SeedanceReferenceMediaItem,
  index: number,
  capabilities: SeedanceReferenceMediaCapabilities,
): SeedanceReferenceMediaPreflightIssue | null {
  const duration = item.durationSeconds;
  if (!Number.isFinite(duration) || duration == null) {
    if ((kind === 'video' && capabilities.requiresVideoMetadata) || (kind === 'audio' && capabilities.requiresAudioDurationMetadata)) {
      return {
        code: 'REFERENCE_MEDIA_METADATA_UNAVAILABLE',
        ruleId: kind === 'video' ? 'seedance25_ip.video.metadata' : 'seedance25_ip.audio.metadata',
        kind,
        index,
        message: `无法读取参考${referenceMediaKindLabel(kind)}「${mediaName(kind, item, index)}」的时长，不能确认它符合 Seedance 2.5 的素材要求。请重新上传可读取元数据的文件后再试。`,
      };
    }
    return null;
  }
  if (duration <= 0 && !capabilities.requiresVideoMetadata && !capabilities.requiresAudioDurationMetadata) return null;
  if (
    duration >= capabilities.minDurationSeconds
    && duration <= capabilities.maxDurationSeconds
  ) {
    return null;
  }
  const kindLabel = referenceMediaKindLabel(kind);
  const name = mediaName(kind, item, index);
  return {
    code: kind === 'video' ? 'REFERENCE_VIDEO_DURATION_UNSUPPORTED' : 'REFERENCE_AUDIO_DURATION_UNSUPPORTED',
    ruleId: capabilities.audioOnly
      ? 'seedance25_ip.media.duration'
      : (kind === 'video' ? 'seedance2.video.duration' : 'seedance2.audio.duration'),
    kind,
    index,
    message: `参考${kindLabel}「${name}」时长约 ${duration.toFixed(1)} 秒。${capabilities.audioOnly ? 'Seedance 2.5' : 'Seedance 2.0'} 要求参考${kindLabel}为 ${capabilities.minDurationSeconds}-${capabilities.maxDurationSeconds} 秒，请裁剪后再生成。`,
  };
}

function knownFormatIssue(
  kind: 'video' | 'audio',
  item: SeedanceReferenceMediaItem,
  index: number,
  capabilities: SeedanceReferenceMediaCapabilities,
): SeedanceReferenceMediaPreflightIssue | null {
  const mimeType = mediaMimeType(item);
  if (!mimeType) return null;
  if (kind === 'video' && ['video/mp4', 'video/quicktime'].includes(mimeType)) return null;
  if (kind === 'audio' && ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/wave', 'audio/x-wav'].includes(mimeType)) return null;
  const kindLabel = referenceMediaKindLabel(kind);
  const name = mediaName(kind, item, index);
  const modelLabel = capabilities.audioOnly ? 'Seedance 2.5' : 'Seedance 2.0';
  return {
    code: kind === 'video' ? 'REFERENCE_VIDEO_FORMAT_UNSUPPORTED' : 'REFERENCE_AUDIO_FORMAT_UNSUPPORTED',
    ruleId: kind === 'video' ? 'seedance2.video.format' : 'seedance2.audio.format',
    kind,
    index,
    message: kind === 'video'
      ? `参考视频「${name}」格式暂不适合直接生成。${modelLabel} 生成需使用 MP4/MOV，请先转成 MP4 后再提交。`
      : `参考音频「${name}」格式暂不适合直接生成。${modelLabel} 生成需使用 MP3/WAV，请先转成 MP3 或 WAV 后再提交。`,
  };
}

function knownVisualSizeIssue(
  kind: 'image' | 'video',
  item: SeedanceReferenceMediaItem,
  index: number,
  capabilities: SeedanceReferenceMediaCapabilities,
): SeedanceReferenceMediaPreflightIssue | null {
  const width = item.width;
  const height = item.height;
  if (!width || !height || width <= 0 || height <= 0) {
    if (kind === 'video' && capabilities.requiresVideoMetadata) {
      return {
        code: 'REFERENCE_MEDIA_METADATA_UNAVAILABLE',
        ruleId: 'seedance25_ip.video.metadata',
        kind,
        index,
        message: `无法读取参考视频「${mediaName(kind, item, index)}」的画面尺寸，不能确认它符合 Seedance 2.5 的素材要求。请重新上传可读取元数据的视频后再试。`,
      };
    }
    return null;
  }
  if (capabilities.videoEdgeMin != null && capabilities.videoEdgeMax != null) {
    if (width < capabilities.videoEdgeMin || width > capabilities.videoEdgeMax || height < capabilities.videoEdgeMin || height > capabilities.videoEdgeMax) {
      return {
        code: 'REFERENCE_MEDIA_DIMENSIONS_UNSUPPORTED',
        ruleId: 'seedance25_ip.video.dimensions_fps',
        kind,
        index,
        message: `参考${referenceMediaKindLabel(kind)}「${mediaName(kind, item, index)}」尺寸为 ${width}x${height}。Seedance 2.5 要求宽和高均在 ${capabilities.videoEdgeMin}-${capabilities.videoEdgeMax} 像素之间。`,
      };
    }
  }
  const pixelCount = referenceMediaPixelCount(width, height);
  const pixelMin = kind === 'video' && capabilities.videoPixelMin != null
    ? capabilities.videoPixelMin
    : capabilities.audioOnly ? null : PROVIDER_REFERENCE_MEDIA_MIN_PIXELS;
  const pixelMax = kind === 'video' ? capabilities.videoPixelMax : null;
  if (pixelCount != null && ((pixelMin != null && pixelCount < pixelMin) || (pixelMax != null && pixelCount > pixelMax))) {
    if (kind === 'video' && capabilities.videoPixelMax != null) {
      return {
        code: 'REFERENCE_VIDEO_PIXELS_OUT_OF_RANGE',
        ruleId: 'seedance25_ip.video.dimensions_fps',
        kind,
        index,
        message: `参考视频「${mediaName(kind, item, index)}」约 ${pixelCount} 像素。Seedance 2.5 要求画面为 ${capabilities.videoPixelMin}-${capabilities.videoPixelMax} 像素。`,
      };
    }
    return {
      code: 'REFERENCE_MEDIA_TOO_SMALL',
      ruleId: 'seedance2.media.min_pixels',
      kind,
      index,
      message: referenceMediaTooSmallMessage({ kind, name: item.name, width, height, index }),
    };
  }
  if (kind === 'video' && capabilities.requiresVideoMetadata && !Number.isFinite(item.fps)) {
    return {
      code: 'REFERENCE_MEDIA_METADATA_UNAVAILABLE',
      ruleId: 'seedance25_ip.video.metadata',
      kind,
      index,
      message: `无法读取参考视频「${mediaName(kind, item, index)}」的帧率，不能确认它符合 Seedance 2.5 的素材要求。请重新上传可读取元数据的视频后再试。`,
    };
  }
  if (kind === 'video' && capabilities.videoFpsMin != null && capabilities.videoFpsMax != null && Number.isFinite(item.fps)) {
    if (item.fps! < capabilities.videoFpsMin || item.fps! > capabilities.videoFpsMax) {
      return {
        code: 'REFERENCE_VIDEO_FPS_UNSUPPORTED',
        ruleId: 'seedance25_ip.video.dimensions_fps',
        kind,
        index,
        message: `参考视频「${mediaName(kind, item, index)}」帧率为 ${item.fps} fps。Seedance 2.5 要求帧率为 ${capabilities.videoFpsMin}-${capabilities.videoFpsMax} fps。`,
      };
    }
  }
  const ratio = width / height;
  if (ratio < SEEDANCE_REFERENCE_MEDIA_MIN_ASPECT_RATIO || ratio > SEEDANCE_REFERENCE_MEDIA_MAX_ASPECT_RATIO) {
    const kindLabel = referenceMediaKindLabel(kind);
    const name = mediaName(kind, item, index);
    return {
      code: 'REFERENCE_MEDIA_ASPECT_RATIO_UNSUPPORTED',
      ruleId: 'seedance2.media.aspect_ratio',
      kind,
      index,
      message: `参考${kindLabel}「${name}」宽高比约 ${ratio.toFixed(2)}，不在 ${capabilities.audioOnly ? 'Seedance 2.5' : 'Seedance 2.0'} 支持范围 ${SEEDANCE_REFERENCE_MEDIA_MIN_ASPECT_RATIO}-${SEEDANCE_REFERENCE_MEDIA_MAX_ASPECT_RATIO} 内。请裁剪或重新导出后再生成。`,
    };
  }
  return null;
}

export function validateSeedanceReferenceMediaPreflight(
  input: SeedanceReferenceMediaPreflightInput,
): SeedanceReferenceMediaPreflightIssue | null {
  const capabilities = seedanceReferenceMediaCapabilities(input.model);
  if (input.metadataValidation === 'known-only') {
    capabilities.requiresVideoMetadata = false;
    capabilities.requiresAudioDurationMetadata = false;
  }
  const modelLabel = capabilities.audioOnly ? 'Seedance 2.5' : 'Seedance 2.0';
  const images = input.images || [];
  const videos = input.videos || [];
  const audios = input.audios || [];

  if (images.length > capabilities.imageLimit) {
    return {
      code: 'REFERENCE_IMAGE_COUNT_EXCEEDED',
      ruleId: capabilities.audioOnly ? 'seedance25_ip.media.count' : 'seedance2.image.count',
      message: `${modelLabel} 单次生成最多选择 ${capabilities.imageLimit} 张参考图。`,
    };
  }
  if (videos.length > capabilities.videoLimit) {
    return {
      code: 'REFERENCE_VIDEO_COUNT_EXCEEDED',
      ruleId: capabilities.audioOnly ? 'seedance25_ip.media.count' : 'seedance2.video.count',
      message: `${modelLabel} 单次生成最多选择 ${capabilities.videoLimit} 个参考视频。`,
    };
  }
  if (audios.length > capabilities.audioLimit) {
    return {
      code: 'REFERENCE_AUDIO_COUNT_EXCEEDED',
      ruleId: capabilities.audioOnly ? 'seedance25_ip.media.count' : 'seedance2.audio.count',
      message: `${modelLabel} 单次生成最多选择 ${capabilities.audioLimit} 个参考音频。`,
    };
  }
  if (!capabilities.audioOnly && audios.length > 0 && images.length === 0 && videos.length === 0) {
    return {
      code: 'REFERENCE_AUDIO_REQUIRES_VISUAL',
      ruleId: 'seedance2.audio.requires_visual',
      message: '音频参考不能单独使用，至少还需要 1 个图片或视频参考素材。',
    };
  }

  for (let index = 0; index < images.length; index += 1) {
    const issue = knownVisualSizeIssue('image', images[index], index, capabilities);
    if (issue) return issue;
  }
  for (let index = 0; index < videos.length; index += 1) {
    const item = videos[index];
    const formatIssue = knownFormatIssue('video', item, index, capabilities);
    if (formatIssue) return formatIssue;
    const durationIssue = knownDurationIssue('video', item, index, capabilities);
    if (durationIssue) return durationIssue;
    const sizeIssue = knownVisualSizeIssue('video', item, index, capabilities);
    if (sizeIssue) return sizeIssue;
  }
  for (let index = 0; index < audios.length; index += 1) {
    const item = audios[index];
    const formatIssue = knownFormatIssue('audio', item, index, capabilities);
    if (formatIssue) return formatIssue;
    const durationIssue = knownDurationIssue('audio', item, index, capabilities);
    if (durationIssue) return durationIssue;
  }

  if (capabilities.totalDurationLimitSeconds != null) {
    const videoDuration = videos.reduce((total, item) => total + (Number.isFinite(item.durationSeconds) ? item.durationSeconds as number : 0), 0);
    if (videoDuration > capabilities.totalDurationLimitSeconds) {
      return {
        code: 'REFERENCE_MEDIA_TOTAL_DURATION_EXCEEDED',
        ruleId: 'seedance25_ip.media.total_duration',
        kind: 'video',
        message: `参考视频总时长为 ${videoDuration.toFixed(1)} 秒。Seedance 2.5 单次生成的参考视频总时长不能超过 ${capabilities.totalDurationLimitSeconds} 秒。`,
      };
    }
    const audioDuration = audios.reduce((total, item) => total + (Number.isFinite(item.durationSeconds) ? item.durationSeconds as number : 0), 0);
    if (audioDuration > capabilities.totalDurationLimitSeconds) {
      return {
        code: 'REFERENCE_MEDIA_TOTAL_DURATION_EXCEEDED',
        ruleId: 'seedance25_ip.media.total_duration',
        kind: 'audio',
        message: `参考音频总时长为 ${audioDuration.toFixed(1)} 秒。Seedance 2.5 单次生成的参考音频总时长不能超过 ${capabilities.totalDurationLimitSeconds} 秒。`,
      };
    }
  }

  return null;
}
