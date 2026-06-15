import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export const MUSK_API_SETTING_KEY = 'musk_api_v1';

export type MuskApiSettings = {
  enabled: boolean;
  base_url: string;
  default_model: string;
  api_key: string | null;
};

export type MuskApiSettingsInput = Partial<MuskApiSettings> & {
  clear_api_key?: unknown;
};

export const DEFAULT_MUSK_API_SETTINGS: MuskApiSettings = {
  enabled: false,
  base_url: 'https://api.muskapis.com/',
  default_model: 'gpt-5.4',
  api_key: null,
};

function cleanString(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeBaseUrl(value: unknown, fallback = DEFAULT_MUSK_API_SETTINGS.base_url) {
  const raw = cleanString(value, fallback);
  let parsed: URL;

  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Musk API 地址必须是有效 URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Musk API 地址只支持 http 或 https');
  }

  return parsed.toString();
}

export function normalizeMuskApiSettings(value: unknown): MuskApiSettings {
  const input = value && typeof value === 'object'
    ? value as Partial<MuskApiSettings>
    : {};

  return {
    enabled: input.enabled === true,
    base_url: normalizeBaseUrl(input.base_url),
    default_model: cleanString(input.default_model, DEFAULT_MUSK_API_SETTINGS.default_model).slice(0, 80),
    api_key: cleanString(input.api_key, '').slice(0, 500) || null,
  };
}

export async function getMuskApiSettings(
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<MuskApiSettings> {
  const setting = await client.platformSetting.findUnique({ where: { key: MUSK_API_SETTING_KEY } });
  if (!setting) return DEFAULT_MUSK_API_SETTINGS;

  try {
    return normalizeMuskApiSettings(JSON.parse(setting.value_json));
  } catch {
    return DEFAULT_MUSK_API_SETTINGS;
  }
}

export function buildMuskApiSettingsPatch(
  current: MuskApiSettings,
  input: MuskApiSettingsInput,
): MuskApiSettings {
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

  return normalizeMuskApiSettings({
    ...current,
    enabled: input.clear_api_key === true ? false : input.enabled === true || shouldAutoEnable,
    base_url: nextBaseUrl,
    default_model: nextDefaultModel,
    api_key: nextApiKey,
  });
}

export async function saveMuskApiSettings(
  input: MuskApiSettingsInput,
  updatedBy: string,
) {
  const current = await getMuskApiSettings();
  const settings = buildMuskApiSettingsPatch(current, input);

  await prisma.platformSetting.upsert({
    where: { key: MUSK_API_SETTING_KEY },
    update: {
      value_json: JSON.stringify(settings),
      updated_by: updatedBy,
    },
    create: {
      key: MUSK_API_SETTING_KEY,
      value_json: JSON.stringify(settings),
      updated_by: updatedBy,
    },
  });

  return settings;
}

export class MuskApiError extends Error {
  constructor(
    message: string,
    public readonly status = 500,
    public readonly code = 'musk_api_error',
  ) {
    super(message);
  }
}

export function isMuskApiReady(settings: MuskApiSettings) {
  return settings.enabled && Boolean(settings.base_url && settings.default_model && settings.api_key);
}

function buildChatCompletionsUrl(baseUrl: string) {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/chat/completions')) return url.toString();
  url.pathname = path.endsWith('/v1') ? `${path}/chat/completions` : `${path}/v1/chat/completions`;
  return url.toString();
}

export type MuskChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type MuskChatCompletionResult = {
  content: string;
  model: string | null;
  usage: unknown;
};

export async function createMuskChatCompletion(params: {
  settings: MuskApiSettings;
  messages: MuskChatMessage[];
  temperature?: number;
  timeoutMs?: number;
}): Promise<MuskChatCompletionResult> {
  if (!isMuskApiReady(params.settings)) {
    throw new MuskApiError('Musk API 未启用或缺少 API Key', 503, 'musk_api_not_configured');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs || 45000);

  try {
    const response = await fetch(buildChatCompletionsUrl(params.settings.base_url), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.settings.api_key}`,
      },
      body: JSON.stringify({
        model: params.settings.default_model,
        messages: params.messages,
        temperature: params.temperature ?? 0.2,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new MuskApiError(`Musk API 调用失败 (HTTP ${response.status})`, response.status, 'musk_api_upstream_error');
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new MuskApiError('Musk API 返回不是 JSON', 502, 'musk_api_invalid_response');
    }

    const choices = Array.isArray(data.choices) ? data.choices : [];
    const firstChoice = choices[0] && typeof choices[0] === 'object'
      ? choices[0] as Record<string, unknown>
      : null;
    const message = firstChoice?.message && typeof firstChoice.message === 'object'
      ? firstChoice.message as Record<string, unknown>
      : null;
    const content = typeof message?.content === 'string' ? message.content : '';
    if (!content.trim()) {
      throw new MuskApiError('Musk API 未返回 message.content', 502, 'musk_api_empty_content');
    }

    return {
      content,
      model: typeof data.model === 'string' ? data.model : null,
      usage: data.usage ?? null,
    };
  } catch (error) {
    if (error instanceof MuskApiError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new MuskApiError('Musk API 调用超时', 504, 'musk_api_timeout');
    }
    throw new MuskApiError('Musk API 调用失败', 500, 'musk_api_request_failed');
  } finally {
    clearTimeout(timeout);
  }
}
