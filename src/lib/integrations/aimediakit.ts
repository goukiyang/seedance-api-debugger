import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export const AIMEDIAKIT_API_SETTING_KEY = 'aimediakit_enhance_video_api_v1';
export const AIMEDIAKIT_DEFAULT_BASE_URL = 'https://mediakit.cn-beijing.volces.com';
export const AIMEDIAKIT_ENHANCE_VIDEO_PATH = '/api/v1/tools/enhance-video';
export const AIMEDIAKIT_TASK_STATUS_PATH = '/api/v1/tasks/{task_id}';
export const AIMEDIAKIT_REQUEST_UPLOAD_PATH = '/api/v1/tools-sync/request-media-upload-url';

export type AiMediaKitApiSettings = {
  enabled: boolean;
  base_url: string;
  api_key: string | null;
};

export type AiMediaKitApiSettingsInput = Partial<AiMediaKitApiSettings> & {
  clear_api_key?: unknown;
};

export type AiMediaKitSafeConfig = {
  provider: 'aimediakit_enhance_video';
  enabled: boolean;
  ready: boolean;
  base_url: string;
  enhance_video_path: string;
  task_status_path: string;
  request_upload_path: string;
  api_key_configured: boolean;
  missing: Array<'api_key'>;
};

export const DEFAULT_AIMEDIAKIT_API_SETTINGS: AiMediaKitApiSettings = {
  enabled: false,
  base_url: AIMEDIAKIT_DEFAULT_BASE_URL,
  api_key: null,
};

function cleanString(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeBaseUrl(value: unknown, fallback = AIMEDIAKIT_DEFAULT_BASE_URL) {
  const raw = cleanString(value, fallback);
  let parsed: URL;

  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('AI MediaKit API 地址必须是有效 URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('AI MediaKit API 地址只支持 http 或 https');
  }

  return parsed.toString().replace(/\/+$/, '');
}

function envFallbackSettings(): AiMediaKitApiSettings {
  const apiKey = cleanString(process.env.AI_MEDIAKIT_API_KEY, '');
  const baseUrl = normalizeBaseUrl(process.env.AI_MEDIAKIT_BASE_URL);

  return {
    enabled: Boolean(apiKey),
    base_url: baseUrl,
    api_key: apiKey || null,
  };
}

export function normalizeAiMediaKitApiSettings(value: unknown): AiMediaKitApiSettings {
  const input = value && typeof value === 'object'
    ? value as Partial<AiMediaKitApiSettings>
    : {};

  return {
    enabled: input.enabled === true,
    base_url: normalizeBaseUrl(input.base_url),
    api_key: cleanString(input.api_key, '').slice(0, 1000) || null,
  };
}

export async function getAiMediaKitApiSettings(
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<AiMediaKitApiSettings> {
  const setting = await client.platformSetting.findUnique({
    where: { key: AIMEDIAKIT_API_SETTING_KEY },
  });
  if (!setting) return envFallbackSettings();

  try {
    return normalizeAiMediaKitApiSettings(JSON.parse(setting.value_json));
  } catch {
    return DEFAULT_AIMEDIAKIT_API_SETTINGS;
  }
}

export function buildAiMediaKitApiSettingsPatch(
  current: AiMediaKitApiSettings,
  input: AiMediaKitApiSettingsInput,
): AiMediaKitApiSettings {
  const incomingApiKey = typeof input.api_key === 'string' ? input.api_key.trim() : '';
  const hasNewApiKey = Boolean(incomingApiKey);
  const nextBaseUrl = input.base_url ?? current.base_url;
  const nextApiKey = input.clear_api_key === true
    ? null
    : hasNewApiKey
      ? incomingApiKey
      : current.api_key;
  const shouldAutoEnable = hasNewApiKey && Boolean(nextBaseUrl);
  const nextEnabled = typeof input.enabled === 'boolean'
    ? input.enabled
    : current.enabled || shouldAutoEnable;

  return normalizeAiMediaKitApiSettings({
    ...current,
    enabled: input.clear_api_key === true ? false : nextEnabled,
    base_url: nextBaseUrl,
    api_key: nextApiKey,
  });
}

export async function saveAiMediaKitApiSettings(
  input: AiMediaKitApiSettingsInput,
  updatedBy: string,
) {
  const current = await getAiMediaKitApiSettings();
  const settings = buildAiMediaKitApiSettingsPatch(current, input);

  await prisma.platformSetting.upsert({
    where: { key: AIMEDIAKIT_API_SETTING_KEY },
    update: {
      value_json: JSON.stringify(settings),
      updated_by: updatedBy,
    },
    create: {
      key: AIMEDIAKIT_API_SETTING_KEY,
      value_json: JSON.stringify(settings),
      updated_by: updatedBy,
    },
  });

  return settings;
}

export function isAiMediaKitApiReady(settings: AiMediaKitApiSettings) {
  return settings.enabled && Boolean(settings.base_url && settings.api_key);
}

export function safeAiMediaKitConfigDto(settings: AiMediaKitApiSettings): AiMediaKitSafeConfig {
  const missing: AiMediaKitSafeConfig['missing'] = [];
  if (!settings.api_key) missing.push('api_key');

  return {
    provider: 'aimediakit_enhance_video',
    enabled: settings.enabled,
    ready: isAiMediaKitApiReady(settings),
    base_url: settings.base_url,
    enhance_video_path: AIMEDIAKIT_ENHANCE_VIDEO_PATH,
    task_status_path: AIMEDIAKIT_TASK_STATUS_PATH,
    request_upload_path: AIMEDIAKIT_REQUEST_UPLOAD_PATH,
    api_key_configured: Boolean(settings.api_key),
    missing,
  };
}

export function aiMediaKitSettingsToRequestOptions(settings: AiMediaKitApiSettings) {
  return {
    apiKey: settings.api_key || undefined,
    baseUrl: settings.base_url,
  };
}
