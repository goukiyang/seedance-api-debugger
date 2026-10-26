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
  default_model: 'gpt-5.5',
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
    public diagnostics?: MuskChatDiagnostics,
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
  diagnostics: MuskChatDiagnostics;
};

export type MuskChatDiagnostics = {
  model: string; requestChars: number; requestBytes: number; timeoutMs: number;
  phase: 'awaiting_headers' | 'reading_body' | 'parsing' | 'completed';
  elapsedMs: number; headersMs: number | null; bodyMs: number | null;
  httpStatus: number | null; upstreamRequestId: string | null; networkCode?: string;
};

function safeMuskRequestId(value: string | null) {
  return value && /^[A-Za-z0-9_.:-]{1,160}$/.test(value) ? value : null;
}

export async function createMuskChatCompletion(params: {
  settings: MuskApiSettings;
  messages: MuskChatMessage[];
  temperature?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<MuskChatCompletionResult> {
  if (!isMuskApiReady(params.settings)) {
    throw new MuskApiError('Musk API 未启用或缺少 API Key', 503, 'musk_api_not_configured');
  }

  const controller = new AbortController();
  const body = JSON.stringify({ model: params.settings.default_model, messages: params.messages,
    temperature: params.temperature ?? 0.2, response_format: { type: 'json_object' } });
  const started = Date.now();
  const diagnostics: MuskChatDiagnostics = { model: params.settings.default_model,
    requestChars: body.length, requestBytes: Buffer.byteLength(body), timeoutMs: params.timeoutMs || 45000,
    phase: 'awaiting_headers', elapsedMs: 0, headersMs: null, bodyMs: null, httpStatus: null, upstreamRequestId: null };
  const timeout = setTimeout(() => controller.abort(), diagnostics.timeoutMs);

  try {
    const response = await (params.fetchImpl || fetch)(buildChatCompletionsUrl(params.settings.base_url), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.settings.api_key}`,
      },
      body,
      signal: controller.signal,
    });
    diagnostics.headersMs = Date.now() - started;
    diagnostics.httpStatus = response.status;
    diagnostics.upstreamRequestId = safeMuskRequestId(response.headers.get('x-request-id') || response.headers.get('request-id'));
    diagnostics.phase = 'reading_body';
    const text = await response.text();
    diagnostics.bodyMs = Date.now() - started - diagnostics.headersMs;
    diagnostics.phase = 'parsing';
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

    diagnostics.phase = 'completed';
    diagnostics.elapsedMs = Date.now() - started;
    return {
      content,
      model: typeof data.model === 'string' ? data.model : null,
      usage: data.usage ?? null,
      diagnostics,
    };
  } catch (error) {
    diagnostics.elapsedMs = Date.now() - started;
    const code = (error as { cause?: { code?: unknown }; code?: unknown })?.cause?.code
      || (error as { code?: unknown })?.code;
    if (typeof code === 'string' && /^(?:UND_ERR_[A-Z_]+|E(?:CONNRESET|CONNREFUSED|TIMEDOUT|AI_AGAIN|NOTFOUND))$/.test(code)) diagnostics.networkCode = code;
    if (error instanceof MuskApiError) { error.diagnostics = diagnostics; throw error; }
    if (controller.signal.aborted) throw new MuskApiError('Musk API 调用超时', 504, 'musk_api_timeout', diagnostics);
    throw new MuskApiError('Musk API 调用失败', 500, 'musk_api_request_failed', diagnostics);
  } finally {
    clearTimeout(timeout);
  }
}
