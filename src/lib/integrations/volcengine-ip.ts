import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  VOLCENGINE_IP_CREATE_TASK_PATH,
  VOLCENGINE_IP_DEFAULT_BASE_URL,
  type VolcengineIpRequestOptions,
} from '@/lib/provider/volcengine-ip';

export const VOLCENGINE_IP_API_SETTING_KEY = 'volcengine_ip_api_v1';

export type VolcengineIpApiSettings = {
  enabled: boolean;
  base_url: string;
  default_model: string;
  api_key: string | null;
};

export type VolcengineIpApiSettingsInput = Partial<VolcengineIpApiSettings> & {
  clear_api_key?: unknown;
};

export type VolcengineIpSafeConfig = {
  provider: 'volcengine_ip';
  enabled: boolean;
  ready: boolean;
  base_url: string;
  create_task_path: string;
  default_model: string;
  model: string;
  api_key_configured: boolean;
  model_configured: boolean;
  missing: Array<'api_key' | 'model'>;
};

export const DEFAULT_VOLCENGINE_IP_API_SETTINGS: VolcengineIpApiSettings = {
  enabled: false,
  base_url: VOLCENGINE_IP_DEFAULT_BASE_URL,
  default_model: '',
  api_key: null,
};

function cleanString(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeBaseUrl(value: unknown, fallback = VOLCENGINE_IP_DEFAULT_BASE_URL) {
  const raw = cleanString(value, fallback);
  let parsed: URL;

  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('火山 API 地址必须是有效 URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('火山 API 地址只支持 http 或 https');
  }

  return parsed.toString().replace(/\/+$/, '');
}

function envFallbackSettings(): VolcengineIpApiSettings {
  const apiKey = cleanString(process.env.VOLCENGINE_IP_API_KEY || process.env.ARK_API_KEY, '');
  const model = cleanString(process.env.VOLCENGINE_IP_MODEL || process.env.ARK_MODEL, '');
  const baseUrl = normalizeBaseUrl(process.env.VOLCENGINE_IP_BASE_URL || process.env.ARK_BASE_URL);

  return {
    enabled: Boolean(apiKey && model),
    base_url: baseUrl,
    default_model: model,
    api_key: apiKey || null,
  };
}

export function normalizeVolcengineIpApiSettings(value: unknown): VolcengineIpApiSettings {
  const input = value && typeof value === 'object'
    ? value as Partial<VolcengineIpApiSettings>
    : {};

  return {
    enabled: input.enabled === true,
    base_url: normalizeBaseUrl(input.base_url),
    default_model: cleanString(input.default_model, '').slice(0, 120),
    api_key: cleanString(input.api_key, '').slice(0, 1000) || null,
  };
}

export async function getVolcengineIpApiSettings(
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<VolcengineIpApiSettings> {
  const setting = await client.platformSetting.findUnique({
    where: { key: VOLCENGINE_IP_API_SETTING_KEY },
  });
  if (!setting) return envFallbackSettings();

  try {
    return normalizeVolcengineIpApiSettings(JSON.parse(setting.value_json));
  } catch {
    return DEFAULT_VOLCENGINE_IP_API_SETTINGS;
  }
}

export function buildVolcengineIpApiSettingsPatch(
  current: VolcengineIpApiSettings,
  input: VolcengineIpApiSettingsInput,
): VolcengineIpApiSettings {
  const incomingApiKey = typeof input.api_key === 'string' ? input.api_key.trim() : '';
  const hasNewApiKey = Boolean(incomingApiKey);
  const nextBaseUrl = input.base_url ?? current.base_url;
  const nextDefaultModel = input.default_model ?? current.default_model;
  const nextApiKey = input.clear_api_key === true
    ? null
    : hasNewApiKey
      ? incomingApiKey
      : current.api_key;
  const shouldAutoEnable = hasNewApiKey && Boolean(nextBaseUrl && nextDefaultModel);

  return normalizeVolcengineIpApiSettings({
    ...current,
    enabled: input.clear_api_key === true ? false : input.enabled === true || shouldAutoEnable,
    base_url: nextBaseUrl,
    default_model: nextDefaultModel,
    api_key: nextApiKey,
  });
}

export async function saveVolcengineIpApiSettings(
  input: VolcengineIpApiSettingsInput,
  updatedBy: string,
) {
  const current = await getVolcengineIpApiSettings();
  const settings = buildVolcengineIpApiSettingsPatch(current, input);

  await prisma.platformSetting.upsert({
    where: { key: VOLCENGINE_IP_API_SETTING_KEY },
    update: {
      value_json: JSON.stringify(settings),
      updated_by: updatedBy,
    },
    create: {
      key: VOLCENGINE_IP_API_SETTING_KEY,
      value_json: JSON.stringify(settings),
      updated_by: updatedBy,
    },
  });

  return settings;
}

export function isVolcengineIpApiReady(settings: VolcengineIpApiSettings) {
  return settings.enabled && Boolean(settings.base_url && settings.default_model && settings.api_key);
}

export function safeVolcengineIpConfigDto(settings: VolcengineIpApiSettings): VolcengineIpSafeConfig {
  const missing: VolcengineIpSafeConfig['missing'] = [];
  if (!settings.api_key) missing.push('api_key');
  if (!settings.default_model) missing.push('model');

  return {
    provider: 'volcengine_ip',
    enabled: settings.enabled,
    ready: isVolcengineIpApiReady(settings),
    base_url: settings.base_url,
    create_task_path: VOLCENGINE_IP_CREATE_TASK_PATH,
    default_model: settings.default_model,
    model: settings.default_model,
    api_key_configured: Boolean(settings.api_key),
    model_configured: Boolean(settings.default_model),
    missing,
  };
}

export function volcengineIpSettingsToRequestOptions(
  settings: VolcengineIpApiSettings,
): VolcengineIpRequestOptions {
  return {
    apiKey: settings.api_key || undefined,
    model: settings.default_model,
    baseUrl: settings.base_url,
  };
}
