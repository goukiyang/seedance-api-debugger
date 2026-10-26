import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export const H3_API_SETTING_KEY = 'h3_video_api_v1';
export const H3_DEFAULT_BASE_URL = 'http://127.0.0.1:8893';
export const H3_DEFAULT_PRESET_ID = 'lightx2v_4step_turbo';
export const H3_HEALTH_PATH = '/health';
export const H3_PRESETS_PATH = '/api/h3/presets';
export const H3_GENERATE_PATH = '/api/h3/generate';
export const H3_HEALTH_MAX_AGE_MS = 15 * 60 * 1000;
export const H3_DEFAULT_LORA_ID = 'lightx2v_turbo_lora';

export const H3_PRESET_OPTIONS = [
  { id: 'lightx2v_4step_turbo', label: '推荐', detail: '默认 · 速度优先，显存风险更低' },
  { id: 'larry_v4_6step', label: '质量增强', detail: '质量更好但更慢，720P 长秒数有显存风险' },
  { id: 'larry_v4_8step', label: '画质优先', detail: '更多步数，更慢，适合谨慎测试' },
] as const;

export const H3_LORA_OPTIONS = [
  {
    id: 'lightx2v_turbo_lora',
    label: 'LightX2V 快速 LoRA',
    detail: '默认 · 4-step turbo，显存压力更低，适合先跑通',
    node_type: 'MiniMaxH3TurboLoRA',
    lora_name: 'minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors',
    strength: 1,
    low_vram: false,
  },
  {
    id: 'larry_v4_turbo_lora',
    label: 'Larry 高质量 LoRA',
    detail: '画质优先，15 秒 16:9 场景显存风险更高',
    node_type: 'MiniMaxH3TurboLoRA',
    lora_name: 'minimax_h3_turbo_v4_step600_ema.safetensors',
    strength: 1,
    low_vram: false,
  },
] as const;

export type H3PresetId = typeof H3_PRESET_OPTIONS[number]['id'];
export type H3LoraId = typeof H3_LORA_OPTIONS[number]['id'];
export type H3LoraPayload = {
  node_type: string;
  lora_name: string;
  strength: number;
  low_vram: boolean;
};

export type H3PresetRuntimePolicy = {
  id: H3PresetId;
  estimated_runtime_sec: number | null;
  recommended_timeout_sec: number | null;
  runtime_policy: string | null;
};

export type H3ApiSettings = {
  enabled: boolean;
  base_url: string;
  api_token: string | null;
  admin_token: string | null;
  default_preset_id: H3PresetId;
  default_lora_id: H3LoraId;
  health: H3HealthSnapshot | null;
};

export type H3HealthSnapshot = {
  api: string | null;
  version: string | null;
  public_base_url: string | null;
  worker: string | null;
  comfyui: string | null;
  worker_url: string | null;
  default_preset: string | null;
  preset_count: number | null;
  billing: {
    charged: boolean | null;
    cost: number | null;
    currency: string | null;
    cost_model: string | null;
  } | null;
  queue: {
    paused: boolean | null;
    pending: number | null;
    running: number | null;
    max_pending_jobs: number | null;
    active: number | null;
    max_active_jobs: number | null;
  } | null;
  presets: H3PresetRuntimePolicy[] | null;
  checked_at: string | null;
};

export type H3ApiSettingsInput = Partial<Omit<H3ApiSettings, 'default_preset_id' | 'default_lora_id'>>
  & { default_preset_id?: unknown; default_lora_id?: unknown; clear_api_token?: unknown; clear_admin_token?: unknown };

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
  default_lora_id: H3LoraId;
  configured: boolean;
  preset_options: Array<{
    id: H3PresetId;
    label: string;
    detail: string;
    estimated_runtime_sec: number | null;
    recommended_timeout_sec: number | null;
    runtime_policy: string | null;
  }>;
  lora_options: Array<{
    id: H3LoraId;
    label: string;
    detail: string;
  }>;
  api_token_configured: boolean;
  admin_token_configured: boolean;
  health: H3HealthSnapshot | null;
  missing: Array<'api_token' | 'preset'>;
};

export const DEFAULT_H3_API_SETTINGS: H3ApiSettings = {
  enabled: false,
  base_url: H3_DEFAULT_BASE_URL,
  api_token: null,
  admin_token: null,
  default_preset_id: H3_DEFAULT_PRESET_ID,
  default_lora_id: H3_DEFAULT_LORA_ID,
  health: null,
};

export function isH3PresetId(value: unknown): value is H3PresetId {
  return typeof value === 'string'
    && H3_PRESET_OPTIONS.some((option) => option.id === value);
}

export function isH3LoraId(value: unknown): value is H3LoraId {
  return typeof value === 'string'
    && H3_LORA_OPTIONS.some((option) => option.id === value);
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

function normalizeLoraId(value: unknown, fallback: H3LoraId = H3_DEFAULT_LORA_ID): H3LoraId {
  if (isH3LoraId(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    throw new Error(`H3 LoRA 只允许 ${H3_LORA_OPTIONS.map((item) => item.id).join(', ')}`);
  }
  return fallback;
}

export function resolveH3LoraOption(value: unknown, fallback: H3LoraId = H3_DEFAULT_LORA_ID) {
  const loraId = normalizeLoraId(value, fallback);
  return (H3_LORA_OPTIONS.find((option) => option.id === loraId) || H3_LORA_OPTIONS[0]) as typeof H3_LORA_OPTIONS[number];
}

export function h3LoraOptionToPayload(option: typeof H3_LORA_OPTIONS[number]): H3LoraPayload {
  return {
    node_type: option.node_type,
    lora_name: option.lora_name,
    strength: option.strength,
    low_vram: option.low_vram,
  };
}

function readH3LoraPayload(value: unknown): H3LoraPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.some((key) => !['node_type', 'lora_name', 'strength', 'low_vram'].includes(key))) return null;
  if (
    typeof input.node_type !== 'string'
    || typeof input.lora_name !== 'string'
    || typeof input.strength !== 'number'
    || typeof input.low_vram !== 'boolean'
  ) {
    return null;
  }
  return {
    node_type: input.node_type,
    lora_name: input.lora_name,
    strength: input.strength,
    low_vram: input.low_vram,
  };
}

function sameH3LoraPayload(a: H3LoraPayload, b: H3LoraPayload) {
  return a.node_type === b.node_type
    && a.lora_name === b.lora_name
    && a.strength === b.strength
    && a.low_vram === b.low_vram;
}

export function validateH3LoraPayload(value: unknown): H3LoraPayload {
  const payload = readH3LoraPayload(value);
  if (!payload) {
    throw new Error(`H3 LoRA 只允许 ${H3_LORA_OPTIONS.map((item) => item.id).join(', ')}`);
  }
  const allowed = H3_LORA_OPTIONS.some((option) => sameH3LoraPayload(payload, h3LoraOptionToPayload(option)));
  if (!allowed) {
    throw new Error(`H3 LoRA 只允许 ${H3_LORA_OPTIONS.map((item) => item.id).join(', ')}`);
  }
  return payload;
}

export function resolveH3LoraPayload(value: unknown, fallback: H3LoraId = H3_DEFAULT_LORA_ID): H3LoraPayload {
  return h3LoraOptionToPayload(resolveH3LoraOption(value, fallback));
}

function stringOrNull(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberOrNull(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanOrNull(value: unknown) {
  return typeof value === 'boolean' ? value : null;
}

function normalizeHealthBilling(value: unknown): H3HealthSnapshot['billing'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  return {
    charged: booleanOrNull(input.charged),
    cost: numberOrNull(input.cost),
    currency: stringOrNull(input.currency),
    cost_model: stringOrNull(input.cost_model),
  };
}

function normalizeHealthQueue(value: unknown): H3HealthSnapshot['queue'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  return {
    paused: booleanOrNull(input.paused),
    pending: numberOrNull(input.pending),
    running: numberOrNull(input.running),
    max_pending_jobs: numberOrNull(input.max_pending_jobs),
    active: numberOrNull(input.active),
    max_active_jobs: numberOrNull(input.max_active_jobs),
  };
}

function normalizePresetRuntime(value: unknown): H3PresetRuntimePolicy | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const id = input.id;
  if (!isH3PresetId(id)) return null;
  return {
    id,
    estimated_runtime_sec: numberOrNull(input.estimated_runtime_sec),
    recommended_timeout_sec: numberOrNull(input.recommended_timeout_sec),
    runtime_policy: stringOrNull(input.runtime_policy),
  };
}

function normalizePresetRuntimeList(value: unknown): H3PresetRuntimePolicy[] | null {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>).presets
    : value;
  if (!Array.isArray(source)) return null;
  const presets = source.map(normalizePresetRuntime).filter((item): item is H3PresetRuntimePolicy => Boolean(item));
  return presets.length > 0 ? presets : null;
}

function normalizeHealthSnapshot(value: unknown): H3HealthSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Partial<H3HealthSnapshot>;
  const checkedAt = typeof input.checked_at === 'string' && input.checked_at.trim()
    ? input.checked_at.trim()
    : null;
  return {
    api: stringOrNull(input.api),
    version: stringOrNull(input.version),
    public_base_url: stringOrNull(input.public_base_url),
    worker: stringOrNull(input.worker),
    comfyui: stringOrNull(input.comfyui),
    worker_url: stringOrNull(input.worker_url),
    default_preset: stringOrNull(input.default_preset),
    preset_count: numberOrNull(input.preset_count),
    billing: normalizeHealthBilling(input.billing),
    queue: normalizeHealthQueue(input.queue),
    presets: normalizePresetRuntimeList(input.presets),
    checked_at: checkedAt,
  };
}

function envFallbackSettings(): H3ApiSettings {
  const apiToken = cleanString(process.env.H3_API_TOKEN, '');
  const adminToken = cleanString(process.env.H3_ADMIN_TOKEN, '');
  const baseUrl = normalizeBaseUrl(
    process.env.H3_PUBLIC_BASE_URL || process.env.H3_API_BASE_URL || process.env.H3_BASE_URL,
  );
  const presetId = normalizePresetId(process.env.H3_DEFAULT_PRESET_ID);
  const loraId = normalizeLoraId(process.env.H3_DEFAULT_LORA_ID);

  return {
    enabled: Boolean(apiToken && baseUrl),
    base_url: baseUrl,
    api_token: apiToken || null,
    admin_token: adminToken || null,
    default_preset_id: presetId,
    default_lora_id: loraId,
    health: null,
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
    default_lora_id: normalizeLoraId(input.default_lora_id),
    health: normalizeHealthSnapshot((input as { health?: unknown }).health),
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
  const nextLoraId = input.default_lora_id ?? current.default_lora_id;
  const shouldAutoEnable = hasNewApiToken && Boolean(nextBaseUrl && nextPresetId);
  const nextEnabled = typeof input.enabled === 'boolean'
    ? input.enabled
    : current.enabled || shouldAutoEnable;

  const settings = normalizeH3ApiSettings({
    enabled: input.clear_api_token === true ? false : nextEnabled,
    base_url: nextBaseUrl,
    api_token: nextApiToken,
    admin_token: nextAdminToken,
    default_preset_id: nextPresetId,
    default_lora_id: nextLoraId,
    health: current.health,
  });
  const baseUrlChanged = settings.base_url !== current.base_url;
  const presetChanged = settings.default_preset_id !== current.default_preset_id;
  const authChanged = hasNewApiToken || input.clear_api_token === true;
  return {
    ...settings,
    health: baseUrlChanged || presetChanged || authChanged ? null : settings.health,
  };
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

export function isH3HealthReady(health: H3HealthSnapshot | null) {
  const checkedAtMs = health?.checked_at ? Date.parse(health.checked_at) : Number.NaN;
  return health?.api === 'ok'
    && health.worker === 'ok'
    && health.comfyui === 'ok'
    && Number.isFinite(checkedAtMs)
    && Date.now() - checkedAtMs <= H3_HEALTH_MAX_AGE_MS;
}

export function isH3Operational(settings: H3ApiSettings) {
  return isH3ApiReady(settings) && isH3HealthReady(settings.health);
}

function formatRuntimeSeconds(value: number | null) {
  if (value === null) return null;
  if (value < 60) return `${Math.round(value)} 秒`;
  return `约 ${Math.round(value / 60)} 分钟`;
}

function buildPresetDetail(option: typeof H3_PRESET_OPTIONS[number], runtime: H3PresetRuntimePolicy | undefined) {
  const parts: string[] = [option.detail];
  const estimated = formatRuntimeSeconds(runtime?.estimated_runtime_sec ?? null);
  const timeout = formatRuntimeSeconds(runtime?.recommended_timeout_sec ?? null);
  if (estimated) parts.push(`预计 ${estimated}`);
  if (timeout) parts.push(`建议等待 ${timeout}`);
  if (runtime?.runtime_policy) parts.push(runtime.runtime_policy);
  return parts.join(' · ');
}

export function h3HealthSnapshotFromResponse(health: unknown, presets?: unknown): H3HealthSnapshot {
  const input = health && typeof health === 'object' && !Array.isArray(health)
    ? health as Record<string, unknown>
    : {};
  const worker = input.worker && typeof input.worker === 'object' && !Array.isArray(input.worker)
    ? input.worker as Record<string, unknown>
    : {};
  return {
    api: stringOrNull(input.api),
    version: stringOrNull(input.version),
    public_base_url: stringOrNull(input.public_base_url),
    worker: stringOrNull(worker.worker),
    comfyui: stringOrNull(worker.comfyui),
    worker_url: stringOrNull(input.worker_url),
    default_preset: stringOrNull(input.default_preset),
    preset_count: numberOrNull(input.preset_count),
    billing: normalizeHealthBilling(input.billing),
    queue: normalizeHealthQueue(input.queue),
    presets: normalizePresetRuntimeList(presets),
    checked_at: new Date().toISOString(),
  };
}

export async function saveH3HealthSnapshot(
  health: unknown,
  updatedBy: string,
  presets?: unknown,
) {
  const current = await getH3ApiSettings();
  const settings = normalizeH3ApiSettings({
    ...current,
    health: h3HealthSnapshotFromResponse(health, presets),
  });

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

export function safeH3ConfigDto(settings: H3ApiSettings): H3SafeConfig {
  const missing: H3SafeConfig['missing'] = [];
  if (!settings.api_token) missing.push('api_token');
  if (!isH3PresetId(settings.default_preset_id)) missing.push('preset');

  return {
    provider: 'h3_video',
    enabled: settings.enabled,
    ready: isH3Operational(settings),
    admin_queue_ready: isH3Operational(settings) && Boolean(settings.admin_token),
    base_url: settings.base_url,
    health_path: H3_HEALTH_PATH,
    presets_path: H3_PRESETS_PATH,
    generate_path: H3_GENERATE_PATH,
    default_preset_id: settings.default_preset_id,
    default_lora_id: settings.default_lora_id,
    configured: isH3ApiReady(settings),
    preset_options: H3_PRESET_OPTIONS.map((option) => {
      const runtime = settings.health?.presets?.find((item) => item.id === option.id);
      return {
        ...option,
        detail: buildPresetDetail(option, runtime),
        estimated_runtime_sec: runtime?.estimated_runtime_sec ?? null,
        recommended_timeout_sec: runtime?.recommended_timeout_sec ?? null,
        runtime_policy: runtime?.runtime_policy ?? null,
      };
    }),
    lora_options: H3_LORA_OPTIONS.map((option) => ({
      id: option.id,
      label: option.label,
      detail: option.detail,
    })),
    api_token_configured: Boolean(settings.api_token),
    admin_token_configured: Boolean(settings.admin_token),
    health: settings.health,
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
