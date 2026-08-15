import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export const H3_API_SETTING_KEY = 'h3_video_api_v1';
export const H3_DEFAULT_BASE_URL = 'http://127.0.0.1:8893';
export const H3_DEFAULT_PRESET_ID = 'larry_v4_6step';
export const H3_HEALTH_PATH = '/health';
export const H3_PRESETS_PATH = '/api/h3/presets';
export const H3_GENERATE_PATH = '/api/h3/generate';

export const H3_PRESET_OPTIONS = [
  { id: 'larry_v4_6step', label: '推荐', detail: '默认质量和速度平衡' },
  { id: 'larry_v4_8step', label: '画质优先', detail: '更多步数，细节更稳' },
  { id: 'lightx2v_4step_turbo', label: '快速预览', detail: '速度优先，用于草稿' },
] as const;

export type H3PresetId = typeof H3_PRESET_OPTIONS[number]['id'];

export type H3ApiSettings = {
  enabled: boolean;
  base_url: string;
  api_token: string | null;
  admin_token: string | null;
  default_preset_id: H3PresetId;
};

export type H3ApiSettingsInput = Partial<Omit<H3ApiSettings, 'default_preset_id'>>
  & { default_preset_id?: unknown; clear_api_token?: unknown; clear_admin_token?: unknown };

export type H3SafeConfig = {
  provider: 'h3_video';
  enabled: boolean;
  ready: boolean;
  admin_queue_ready: boolean;
  base_url: string;
  health_path: string;
  presets_path: string;
  generate_path: string;
  default_preset_id: H3PresetId;
  preset_options: Array<{ id: H3PresetId; label: string; detail: string }>;
  api_token_configured: boolean;
  admin_token_configured: boolean;
  missing: Array<'api_token' | 'preset'>;
};

export const DEFAULT_H3_API_SETTINGS: H3ApiSettings = {
  enabled: false,
  base_url: H3_DEFAULT_BASE_URL,
  api_token: null,
  admin_token: null,
  default_preset_id: H3_DEFAULT_PRESET_ID,
};

export function isH3PresetId(value: unknown): value is H3PresetId {
  return typeof value === 'string'
    && H3_PRESET_OPTIONS.some((option) => option.id === value);
}

function cleanString(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeBaseUrl(value: unknown, fallback = H3_DEFAULT_BASE_URL) {
  const raw = cleanString(value, fallback);
  let parsed: URL;

  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('H3 API 地址必须是有效 URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('H3 API 地址只支持 http 或 https');
  }

  return parsed.toString().replace(/\/+$/, '');
}

function normalizePresetId(value: unknown, fallback: H3PresetId = H3_DEFAULT_PRESET_ID): H3PresetId {
  if (isH3PresetId(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    throw new Error(`H3 preset 只允许 ${H3_PRESET_OPTIONS.map((item) => item.id).join(', ')}`);
  }
  return fallback;
}

function envFallbackSettings(): H3ApiSettings {
  const apiToken = cleanString(process.env.H3_API_TOKEN, '');
  const adminToken = cleanString(process.env.H3_ADMIN_TOKEN, '');
  const baseUrl = normalizeBaseUrl(
    process.env.H3_PUBLIC_BASE_URL || process.env.H3_API_BASE_URL || process.env.H3_BASE_URL,
  );
  const presetId = normalizePresetId(process.env.H3_DEFAULT_PRESET_ID);

  return {
    enabled: Boolean(apiToken && baseUrl),
    base_url: baseUrl,
    api_token: apiToken || null,
    admin_token: adminToken || null,
    default_preset_id: presetId,
  };
}

export function normalizeH3ApiSettings(value: unknown): H3ApiSettings {
  const input = value && typeof value === 'object'
    ? value as Partial<H3ApiSettings>
    : {};

  return {
    enabled: input.enabled === true,
    base_url: normalizeBaseUrl(input.base_url),
    api_token: cleanString(input.api_token, '').slice(0, 2000) || null,
    admin_token: cleanString(input.admin_token, '').slice(0, 2000) || null,
    default_preset_id: normalizePresetId(input.default_preset_id),
  };
}

export async function getH3ApiSettings(
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<H3ApiSettings> {
  const setting = await client.platformSetting.findUnique({
    where: { key: H3_API_SETTING_KEY },
  });
  if (!setting) return envFallbackSettings();

  try {
    return normalizeH3ApiSettings(JSON.parse(setting.value_json));
  } catch {
    return DEFAULT_H3_API_SETTINGS;
  }
}

export function buildH3ApiSettingsPatch(
  current: H3ApiSettings,
  input: H3ApiSettingsInput,
): H3ApiSettings {
  const incomingApiToken = typeof input.api_token === 'string' ? input.api_token.trim() : '';
  const incomingAdminToken = typeof input.admin_token === 'string' ? input.admin_token.trim() : '';
  const hasNewApiToken = Boolean(incomingApiToken);
  const hasNewAdminToken = Boolean(incomingAdminToken);
  const nextApiToken = input.clear_api_token === true
    ? null
    : hasNewApiToken
      ? incomingApiToken
      : current.api_token;
  const nextAdminToken = input.clear_admin_token === true
    ? null
    : hasNewAdminToken
      ? incomingAdminToken
      : current.admin_token;
  const nextBaseUrl = input.base_url ?? current.base_url;
  const nextPresetId = input.default_preset_id ?? current.default_preset_id;
  const shouldAutoEnable = hasNewApiToken && Boolean(nextBaseUrl && nextPresetId);
  const nextEnabled = typeof input.enabled === 'boolean'
    ? input.enabled
    : current.enabled || shouldAutoEnable;

  return normalizeH3ApiSettings({
    enabled: input.clear_api_token === true ? false : nextEnabled,
    base_url: nextBaseUrl,
    api_token: nextApiToken,
    admin_token: nextAdminToken,
    default_preset_id: nextPresetId,
  });
}

export async function saveH3ApiSettings(input: H3ApiSettingsInput, updatedBy: string) {
  const current = await getH3ApiSettings();
  const settings = buildH3ApiSettingsPatch(current, input);

  await prisma.platformSetting.upsert({
    where: { key: H3_API_SETTING_KEY },
    update: {
      value_json: JSON.stringify(settings),
      updated_by: updatedBy,
    },
    create: {
      key: H3_API_SETTING_KEY,
      value_json: JSON.stringify(settings),
      updated_by: updatedBy,
    },
  });

  return settings;
}

export function isH3ApiReady(settings: H3ApiSettings) {
  return settings.enabled
    && Boolean(settings.base_url && settings.api_token)
    && isH3PresetId(settings.default_preset_id);
}

export function safeH3ConfigDto(settings: H3ApiSettings): H3SafeConfig {
  const missing: H3SafeConfig['missing'] = [];
  if (!settings.api_token) missing.push('api_token');
  if (!isH3PresetId(settings.default_preset_id)) missing.push('preset');

  return {
    provider: 'h3_video',
    enabled: settings.enabled,
    ready: isH3ApiReady(settings),
    admin_queue_ready: isH3ApiReady(settings) && Boolean(settings.admin_token),
    base_url: settings.base_url,
    health_path: H3_HEALTH_PATH,
    presets_path: H3_PRESETS_PATH,
    generate_path: H3_GENERATE_PATH,
    default_preset_id: settings.default_preset_id,
    preset_options: H3_PRESET_OPTIONS.map((option) => ({ ...option })),
    api_token_configured: Boolean(settings.api_token),
    admin_token_configured: Boolean(settings.admin_token),
    missing,
  };
}

export function h3SettingsToRequestOptions(settings: H3ApiSettings) {
  return {
    apiToken: settings.api_token || undefined,
    adminToken: settings.admin_token || undefined,
    baseUrl: settings.base_url,
  };
}
