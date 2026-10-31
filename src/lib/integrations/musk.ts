import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { readPrivateCredential, writePrivateCredential } from '@/lib/security/private-credentials.server';
import { isPrivatePromptError, isStoredPrivatePrompt, PrivatePromptError, type PrivateOrigin } from '@/lib/security/private-prompts.server';
import { assertPrivateSend, privatePromptFetch, privateCredentialSendOrigins } from '@/lib/security/private-prompt-send.server';

export const MUSK_API_SETTING_KEY = 'musk_api_v1';

export type MuskApiSettings = {
  enabled: boolean;
  base_url: string;
  default_model: string;
  api_key: string | null;
  /** 对话可选模型白名单；为空时只开放 default_model。 */
  allowed_models: string[];
};

export type MuskApiSettingsInput = Omit<Partial<MuskApiSettings>, 'allowed_models'> & {
  clear_api_key?: unknown;
  allowed_models?: unknown;
};

export const DEFAULT_MUSK_API_SETTINGS: MuskApiSettings = {
  enabled: false,
  base_url: 'https://api.muskapis.com/',
  default_model: 'gpt-5.5',
  api_key: null,
  allowed_models: [],
};

export const MAX_ALLOWED_MODELS = 30;

export function sanitizeAllowedModels(value: unknown): string[] {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n,]+/)
      : [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!id || id.length > 80 || out.includes(id)) continue;
    out.push(id);
    if (out.length >= MAX_ALLOWED_MODELS) break;
  }
  return out;
}

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
  if (isStoredPrivatePrompt(input.api_key)) throw new PrivatePromptError();

  return {
    enabled: input.enabled === true,
    base_url: normalizeBaseUrl(input.base_url),
    default_model: cleanString(input.default_model, DEFAULT_MUSK_API_SETTINGS.default_model).slice(0, 80),
    api_key: cleanString(input.api_key, '').slice(0, 500) || null,
    allowed_models: sanitizeAllowedModels(input.allowed_models),
  };
}

export async function getMuskApiSettings(
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<MuskApiSettings> {
  const setting = await client.platformSetting.findUnique({ where: { key: MUSK_API_SETTING_KEY } });
  if (!setting) return DEFAULT_MUSK_API_SETTINGS;

  const stored = JSON.parse(setting.value_json);
  return normalizeMuskApiSettings({ ...stored, api_key: readPrivateCredential(stored.api_key ?? null, MUSK_API_SETTING_KEY, 'api_key') });
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
    allowed_models: input.allowed_models !== undefined
      ? sanitizeAllowedModels(input.allowed_models)
      : current.allowed_models,
  });
}

export async function saveMuskApiSettings(
  input: MuskApiSettingsInput,
  updatedBy: string,
) {
  const current = await getMuskApiSettings();
  const settings = buildMuskApiSettingsPatch(current, input);
  const storedSettings = { ...settings, api_key: writePrivateCredential(settings.api_key, MUSK_API_SETTING_KEY, 'api_key') };

  await prisma.platformSetting.upsert({
    where: { key: MUSK_API_SETTING_KEY },
    update: {
      value_json: JSON.stringify(storedSettings),
      updated_by: updatedBy,
    },
    create: {
      key: MUSK_API_SETTING_KEY,
      value_json: JSON.stringify(storedSettings),
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
export function assertPrivateMuskSend(settings: MuskApiSettings, origins: PrivateOrigin[]) {
  origins = privateCredentialSendOrigins(origins);
  if (origins.length) assertPrivateSend({ endpoint: buildChatCompletionsUrl(settings.base_url), provider: 'musk',
    credential: settings.api_key || '', model: settings.default_model }, origins);
}

export type MuskChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type MuskChatMessage = {
  role: 'system' | 'user' | 'assistant';
  /** 纯文本，或 OpenAI 兼容的多模态 parts（含 image_url）。 */
  content: string | MuskChatContentPart[];
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
  privateOrigins?: PrivateOrigin[];
  /** 默认 true，保持模板生成等现有 JSON 强制行为；普通聊天传 false。 */
  jsonMode?: boolean;
  /** 覆盖 default_model（调用方需先校验白名单）。 */
  model?: string;
  /** 外部中止信号（例如客户端断开）。 */
  signal?: AbortSignal;
}): Promise<MuskChatCompletionResult> {
  if (!isMuskApiReady(params.settings)) {
    throw new MuskApiError('Musk API 未启用或缺少 API Key', 503, 'musk_api_not_configured');
  }

  const controller = new AbortController();
  const model = params.model || params.settings.default_model;
  const jsonMode = params.jsonMode !== false;
  const payload: Record<string, unknown> = {
    model,
    messages: params.messages,
    temperature: params.temperature ?? 0.2,
  };
  if (jsonMode) payload.response_format = { type: 'json_object' };
  const body = JSON.stringify(payload);
  const started = Date.now();
  const diagnostics: MuskChatDiagnostics = { model,
    requestChars: body.length, requestBytes: Buffer.byteLength(body), timeoutMs: params.timeoutMs || 45000,
    phase: 'awaiting_headers', elapsedMs: 0, headersMs: null, bodyMs: null, httpStatus: null, upstreamRequestId: null };
  const timeout = setTimeout(() => controller.abort(), diagnostics.timeoutMs);
  const onExternalAbort = () => controller.abort();
  params.signal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    const endpoint = buildChatCompletionsUrl(params.settings.base_url);
    const init: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.settings.api_key}`,
      },
      body,
      signal: controller.signal,
    };
    const origins = privateCredentialSendOrigins(params.privateOrigins);
    const response = origins.length
      ? await privatePromptFetch({ endpoint, provider: 'musk', credential: params.settings.api_key || '', model }, origins, init, params.fetchImpl || fetch)
      : await (params.fetchImpl || fetch)(endpoint, init);
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
    if (isPrivatePromptError(error)) throw error;
    diagnostics.elapsedMs = Date.now() - started;
    const code = (error as { cause?: { code?: unknown }; code?: unknown })?.cause?.code
      || (error as { code?: unknown })?.code;
    if (typeof code === 'string' && /^(?:UND_ERR_[A-Z_]+|E(?:CONNRESET|CONNREFUSED|TIMEDOUT|AI_AGAIN|NOTFOUND))$/.test(code)) diagnostics.networkCode = code;
    if (error instanceof MuskApiError) { error.diagnostics = diagnostics; throw error; }
    if (controller.signal.aborted) {
      const abortedByCaller = Boolean(params.signal?.aborted);
      throw new MuskApiError(
        abortedByCaller ? '请求已取消' : 'Musk API 调用超时',
        abortedByCaller ? 499 : 504,
        abortedByCaller ? 'musk_api_aborted' : 'musk_api_timeout',
        diagnostics,
      );
    }
    throw new MuskApiError('Musk API 调用失败', 500, 'musk_api_request_failed', diagnostics);
  } finally {
    clearTimeout(timeout);
    params.signal?.removeEventListener('abort', onExternalAbort);
  }
}

function buildModelsUrl(baseUrl: string) {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  url.pathname = path.endsWith('/v1') ? `${path}/models` : `${path}/v1/models`;
  return url.toString();
}

const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
let upstreamModelsCache: { key: string; at: number; ids: string[] } | null = null;

/** 拉上游 OpenAI 兼容 /models，缓存 5 分钟；失败返回 null。 */
export async function fetchMuskUpstreamModels(
  settings: MuskApiSettings,
  options?: { force?: boolean },
): Promise<string[] | null> {
  if (!isMuskApiReady(settings)) return null;
  const key = `${settings.base_url}|${settings.api_key?.slice(-6)}`;
  if (
    !options?.force
    && upstreamModelsCache
    && upstreamModelsCache.key === key
    && Date.now() - upstreamModelsCache.at < MODELS_CACHE_TTL_MS
  ) {
    return upstreamModelsCache.ids;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(buildModelsUrl(settings.base_url), {
      headers: { Authorization: `Bearer ${settings.api_key}` },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = await response.json() as { data?: Array<{ id?: unknown }> };
    const ids = Array.isArray(data.data)
      ? data.data.map((m) => (typeof m?.id === 'string' ? m.id : '')).filter(Boolean)
      : [];
    upstreamModelsCache = { key, at: Date.now(), ids };
    return ids;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** 对话可用模型：白名单 ∩ 上游列表（上游不可达时信任白名单）；白名单为空只给 default_model。 */
export async function resolveMuskChatModels(settings: MuskApiSettings): Promise<string[]> {
  const allow = settings.allowed_models;
  if (!allow.length) return [settings.default_model];
  const upstream = await fetchMuskUpstreamModels(settings);
  const list = upstream ? allow.filter((id) => upstream.includes(id)) : [...allow];
  if (!list.includes(settings.default_model)) list.unshift(settings.default_model);
  return list;
}

/** 流式调用：返回上游 Response（SSE），调用方负责解析。 */
export async function openMuskChatStream(params: {
  settings: MuskApiSettings;
  messages: MuskChatMessage[];
  temperature?: number;
  model?: string;
  signal?: AbortSignal;
  connectTimeoutMs?: number;
}): Promise<Response> {
  if (!isMuskApiReady(params.settings)) {
    throw new MuskApiError('Musk API 未启用或缺少 API Key', 503, 'musk_api_not_configured');
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  params.signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), params.connectTimeoutMs || 45000);
  try {
    const response = await fetch(buildChatCompletionsUrl(params.settings.base_url), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.settings.api_key}`,
      },
      body: JSON.stringify({
        model: params.model || params.settings.default_model,
        messages: params.messages,
        temperature: params.temperature ?? 0.4,
        stream: true,
      }),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new MuskApiError(`Musk API 调用失败 (HTTP ${response.status})`, response.status || 502, 'musk_api_upstream_error');
    }
    return response;
  } catch (error) {
    if (error instanceof MuskApiError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new MuskApiError(
        params.signal?.aborted ? '请求已取消' : 'Musk API 调用超时',
        params.signal?.aborted ? 499 : 504,
        params.signal?.aborted ? 'musk_api_aborted' : 'musk_api_timeout',
      );
    }
    throw new MuskApiError('Musk API 调用失败', 500, 'musk_api_request_failed');
  } finally {
    clearTimeout(timeout);
    params.signal?.removeEventListener('abort', onAbort);
  }
}
