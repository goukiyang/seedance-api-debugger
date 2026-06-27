import type {
  EnhanceVideoCreateInput,
  EnhanceVideoResolution,
  EnhanceVideoScene,
  EnhanceVideoToolVersion,
} from '@/lib/provider/aimediakit-enhance-video';

const ALLOWED_VIDEO_URL_PROTOCOLS = ['http:', 'https:', 'mediakit:', 'vod:', 'tos:'] as const;
const ALLOWED_TOOL_VERSIONS: EnhanceVideoToolVersion[] = ['standard', 'professional'];
const ALLOWED_SCENES: EnhanceVideoScene[] = ['common', 'ugc', 'short_series', 'aigc', 'old_film'];
const ALLOWED_RESOLUTIONS: EnhanceVideoResolution[] = ['240p', '360p', '480p', '540p', '720p', '1080p', '2k', '4k'];

export type NormalizedEnhanceVideoCreateBody = {
  sourceTaskId: string | null;
  videoUrl: string | null;
  toolVersion: EnhanceVideoToolVersion;
  scene: EnhanceVideoScene | null;
  resolution: EnhanceVideoResolution;
  fps: number | null;
  durationSeconds: number | null;
  videoCardId: string | null;
  idempotencyKey: string | null;
};

export type BuildEnhanceVideoProviderInputArgs = {
  videoUrl: string;
  toolVersion: EnhanceVideoToolVersion;
  scene: EnhanceVideoScene | null;
  resolution: EnhanceVideoResolution;
  fps?: number | null;
  clientToken: string;
};

function cleanString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T, label: string) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') throw new Error(`${label} 无效`);
  const normalized = value.trim() as T;
  if (!allowed.includes(normalized)) {
    throw new Error(`${label} 必须是 ${allowed.join(', ')}`);
  }
  return normalized;
}

function readOptionalInteger(value: unknown, label: string, min: number, max: number) {
  if (value === undefined || value === null || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${label} 必须是 ${min}-${max} 的整数`);
  }
  return number;
}

function isPrivateHttpHost(hostname: string) {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')) return true;

  const match = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const [first, second] = match.slice(1, 3).map(Number);
  if (first === 10 || first === 127 || first === 0 || first === 169) return true;
  if (first === 192 && second === 168) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  return false;
}

export function validateEnhanceVideoUrl(videoUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(videoUrl);
  } catch {
    throw new Error('video_url 格式无效');
  }

  if (!ALLOWED_VIDEO_URL_PROTOCOLS.includes(parsed.protocol as typeof ALLOWED_VIDEO_URL_PROTOCOLS[number])) {
    throw new Error(`video_url 协议只支持 ${ALLOWED_VIDEO_URL_PROTOCOLS.join(', ')}`);
  }
  if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && isPrivateHttpHost(parsed.hostname)) {
    throw new Error('video_url 不能指向本机或内网地址');
  }

  return videoUrl;
}

export function normalizeEnhanceVideoCreateBody(input: unknown): NormalizedEnhanceVideoCreateBody {
  const body = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const sourceTaskId = cleanString(body.source_task_id ?? body.sourceTaskId);
  const videoUrl = cleanString(body.video_url ?? body.videoUrl);

  if (!sourceTaskId && !videoUrl) {
    throw new Error('必须提供 source_task_id 或 video_url');
  }
  if (sourceTaskId && videoUrl) {
    throw new Error('source_task_id 和 video_url 不能同时提供');
  }

  const toolVersion = readEnum(body.tool_version ?? body.toolVersion, ALLOWED_TOOL_VERSIONS, 'standard', 'tool_version');
  const scene = toolVersion === 'standard'
    ? readEnum(body.scene, ALLOWED_SCENES, 'aigc', 'scene')
    : null;
  const resolution = readEnum(body.resolution, ALLOWED_RESOLUTIONS, '1080p', 'resolution');
  const fps = readOptionalInteger(body.fps, 'fps', 15, 120);
  const durationSeconds = readOptionalInteger(body.duration ?? body.duration_seconds ?? body.durationSeconds, 'duration', 1, 3600);

  return {
    sourceTaskId,
    videoUrl: videoUrl ? validateEnhanceVideoUrl(videoUrl) : null,
    toolVersion,
    scene,
    resolution,
    fps,
    durationSeconds,
    videoCardId: cleanString(body.video_card_id ?? body.videoCardId),
    idempotencyKey: cleanString(body.idempotency_key ?? body.idempotencyKey),
  };
}

export function buildEnhanceVideoProviderInput(args: BuildEnhanceVideoProviderInputArgs): EnhanceVideoCreateInput {
  const input: EnhanceVideoCreateInput = {
    video_url: validateEnhanceVideoUrl(args.videoUrl),
    tool_version: args.toolVersion,
    resolution: args.resolution,
    client_token: args.clientToken,
  };

  if (args.toolVersion === 'standard' && args.scene) {
    input.scene = args.scene;
  }
  if (args.fps !== undefined && args.fps !== null) {
    input.fps = args.fps;
  }

  return input;
}
