import { isPubliclyReachableUrl } from '@/lib/assets/public-storage';

const SYSTEM_CALLBACK_PATH = '/api/provider/seedance/callback';

type FastPathTask = {
  provider?: string | null;
  generation_mode?: string | null;
};

type CallbackConfigInput = {
  baseUrl?: string | null;
  taskId: string;
  requestCallbackUrl?: string | null;
  callbackSecret?: string | null;
};

export type VideoDeliveryCallbackConfig = {
  systemCallbackUrl: string;
  providerCallbackUrl: string;
  externalCallbackUrl: string | null;
};

function normalize(value: string | null | undefined) {
  return (value || '').trim().toLowerCase();
}

export function isVideoDeliveryFastPathTask(task: FastPathTask) {
  const provider = normalize(task.provider || 'seedance');
  const generationMode = normalize(task.generation_mode);
  if (provider !== 'seedance') return false;
  if (generationMode === 'enhance_video') return false;
  return true;
}

export function resolveVideoDeliveryPublicBaseUrl(input?: string | null) {
  const baseUrl = (
    input
    || process.env.VIDEO_DELIVERY_PUBLIC_BASE_URL
    || process.env.BASE_URL
    || process.env.NEXTAUTH_URL
    || process.env.NEXT_PUBLIC_BASE_URL
    || ''
  ).trim();
  if (!baseUrl || !isPubliclyReachableUrl(baseUrl)) {
    throw new Error('缺少可公网访问的 BASE_URL / NEXTAUTH_URL / NEXT_PUBLIC_BASE_URL，无法设置视频生成回调地址');
  }
  return baseUrl.replace(/\/$/, '');
}

function normalizeExternalCallbackUrl(value: string | null | undefined) {
  const url = value?.trim();
  if (!url || !isPubliclyReachableUrl(url)) return null;
  return url;
}

export function resolveVideoDeliveryCallbackConfig(input: CallbackConfigInput): VideoDeliveryCallbackConfig {
  const url = new URL(SYSTEM_CALLBACK_PATH, resolveVideoDeliveryPublicBaseUrl(input.baseUrl));
  url.searchParams.set('taskId', input.taskId);
  const secret = input.callbackSecret?.trim();
  if (!secret) {
    throw new Error('缺少 VIDEO_DELIVERY_CALLBACK_SECRET，无法启用视频生成回调。');
  }
  url.searchParams.set('token', secret);

  const systemCallbackUrl = url.toString();
  const externalCallbackUrl = normalizeExternalCallbackUrl(input.requestCallbackUrl);

  return {
    systemCallbackUrl,
    providerCallbackUrl: systemCallbackUrl,
    externalCallbackUrl: externalCallbackUrl && externalCallbackUrl !== systemCallbackUrl ? externalCallbackUrl : null,
  };
}

function parseParams(paramsJson: string | null | undefined) {
  if (!paramsJson) return {};
  try {
    const parsed = JSON.parse(paramsJson);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function mergeVideoDeliveryCallbackParams(
  paramsJson: string | null | undefined,
  config: VideoDeliveryCallbackConfig,
) {
  const params = parseParams(paramsJson);
  return JSON.stringify({
    ...params,
    videoDeliveryCallback: {
      systemCallbackUrl: config.systemCallbackUrl,
      externalCallbackUrl: config.externalCallbackUrl,
    },
  });
}

export function getExternalCallbackUrlFromParams(paramsJson: string | null | undefined) {
  const params = parseParams(paramsJson);
  const callback = params.videoDeliveryCallback;
  if (!callback || typeof callback !== 'object' || Array.isArray(callback)) return null;
  const externalCallbackUrl = (callback as { externalCallbackUrl?: unknown }).externalCallbackUrl;
  return typeof externalCallbackUrl === 'string' && isPubliclyReachableUrl(externalCallbackUrl)
    ? externalCallbackUrl
    : null;
}
