import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export const IMAGE_GENERATION_API_SETTING_KEY = 'image_generation_api_v1';

export const IMAGE_GENERATION_PROVIDERS = ['musk'] as const;
export const DEFAULT_MUSK_IMAGE_MODEL = 'gemini-3.1-flash-image-preview';
export const DEFAULT_MUSK_IMAGE_BASE_URL = 'https://api.muskapis.com/';

const LEGACY_IMAGE_GENERATION_PROVIDERS = new Set(['banana2', 'gemini']);
const LEGACY_IMAGE_GENERATION_MODELS = new Set(['banana2', 'gemini-3.1-flash-image']);
const LEGACY_GOOGLE_GEMINI_HOST = 'generativelanguage.googleapis.com';

export type ImageGenerationProvider = typeof IMAGE_GENERATION_PROVIDERS[number];

export type ImageGenerationApiSettings = {
  enabled: boolean;
  provider: ImageGenerationProvider;
  base_url: string;
  default_model: string;
  api_key: string | null;
  timeout_ms: number;
  max_outputs_per_request: number;
  default_ratio: string;
  supports_text_to_image: boolean;
  supports_image_to_image: boolean;
  supports_async_task: boolean;
};

export type ImageGenerationApiSettingsInput = Partial<ImageGenerationApiSettings> & {
  clear_api_key?: unknown;
};

export const DEFAULT_IMAGE_GENERATION_API_SETTINGS: ImageGenerationApiSettings = {
  enabled: false,
  provider: 'musk',
  base_url: DEFAULT_MUSK_IMAGE_BASE_URL,
  default_model: DEFAULT_MUSK_IMAGE_MODEL,
  api_key: null,
  timeout_ms: 90000,
  max_outputs_per_request: 1,
  default_ratio: '16:9',
  supports_text_to_image: true,
  supports_image_to_image: true,
  supports_async_task: false,
};

function cleanString(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number) {
  const next = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(next)));
}

function normalizeProvider(value: unknown): ImageGenerationProvider {
  const raw = cleanString(value, DEFAULT_IMAGE_GENERATION_API_SETTINGS.provider);
  if (LEGACY_IMAGE_GENERATION_PROVIDERS.has(raw)) return DEFAULT_IMAGE_GENERATION_API_SETTINGS.provider;
  return IMAGE_GENERATION_PROVIDERS.includes(raw as ImageGenerationProvider)
    ? raw as ImageGenerationProvider
    : DEFAULT_IMAGE_GENERATION_API_SETTINGS.provider;
}

function normalizeDefaultModel(value: unknown) {
  const raw = cleanString(value, DEFAULT_IMAGE_GENERATION_API_SETTINGS.default_model);
  if (LEGACY_IMAGE_GENERATION_MODELS.has(raw)) return DEFAULT_IMAGE_GENERATION_API_SETTINGS.default_model;
  return raw.slice(0, 80);
}

function isLegacyImageGenerationSettings(input: Partial<ImageGenerationApiSettings>) {
  const rawProvider = cleanString(input.provider);
  const rawModel = cleanString(input.default_model);
  const rawBaseUrl = cleanString(input.base_url);
  let isGoogleDirectBaseUrl = false;
  try {
    isGoogleDirectBaseUrl = rawBaseUrl ? new URL(rawBaseUrl).hostname === LEGACY_GOOGLE_GEMINI_HOST : false;
  } catch {
    isGoogleDirectBaseUrl = false;
  }
  return LEGACY_IMAGE_GENERATION_PROVIDERS.has(rawProvider)
    || LEGACY_IMAGE_GENERATION_MODELS.has(rawModel)
    || isGoogleDirectBaseUrl;
}

function normalizeBaseUrl(value: unknown, fallback = DEFAULT_IMAGE_GENERATION_API_SETTINGS.base_url) {
  const raw = cleanString(value, fallback);
  if (!raw) return '';

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('图形生成 API 地址必须是有效 URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('图形生成 API 地址只支持 http 或 https');
  }

  return parsed.toString();
}

export function normalizeImageGenerationApiSettings(value: unknown): ImageGenerationApiSettings {
  const input = value && typeof value === 'object'
    ? value as Partial<ImageGenerationApiSettings>
    : {};
  const isLegacy = isLegacyImageGenerationSettings(input);

  return {
    enabled: input.enabled === true,
    provider: normalizeProvider(input.provider),
    base_url: normalizeBaseUrl(isLegacy ? DEFAULT_IMAGE_GENERATION_API_SETTINGS.base_url : input.base_url),
    default_model: normalizeDefaultModel(input.default_model),
    api_key: cleanString(input.api_key, '').slice(0, 500) || null,
    timeout_ms: clampInteger(input.timeout_ms, DEFAULT_IMAGE_GENERATION_API_SETTINGS.timeout_ms, 5000, 300000),
    max_outputs_per_request: clampInteger(
      isLegacy ? DEFAULT_IMAGE_GENERATION_API_SETTINGS.max_outputs_per_request : input.max_outputs_per_request,
      DEFAULT_IMAGE_GENERATION_API_SETTINGS.max_outputs_per_request,
      1,
      8,
    ),
    default_ratio: cleanString(input.default_ratio, DEFAULT_IMAGE_GENERATION_API_SETTINGS.default_ratio).slice(0, 20),
    supports_text_to_image: input.supports_text_to_image !== false,
    supports_image_to_image: input.supports_image_to_image !== false,
    supports_async_task: isLegacy ? DEFAULT_IMAGE_GENERATION_API_SETTINGS.supports_async_task : input.supports_async_task !== false,
  };
}

export async function getImageGenerationApiSettings(
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<ImageGenerationApiSettings> {
  const setting = await client.platformSetting.findUnique({ where: { key: IMAGE_GENERATION_API_SETTING_KEY } });
  if (!setting) return DEFAULT_IMAGE_GENERATION_API_SETTINGS;

  try {
    return normalizeImageGenerationApiSettings(JSON.parse(setting.value_json));
  } catch {
    return DEFAULT_IMAGE_GENERATION_API_SETTINGS;
  }
}

export function buildImageGenerationApiSettingsPatch(
  current: ImageGenerationApiSettings,
  input: ImageGenerationApiSettingsInput,
): ImageGenerationApiSettings {
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

  return normalizeImageGenerationApiSettings({
    ...current,
    enabled: input.clear_api_key === true ? false : input.enabled === true || shouldAutoEnable,
    provider: input.provider ?? current.provider,
    base_url: nextBaseUrl,
    default_model: nextDefaultModel,
    api_key: nextApiKey,
    timeout_ms: input.timeout_ms ?? current.timeout_ms,
    max_outputs_per_request: input.max_outputs_per_request ?? current.max_outputs_per_request,
    default_ratio: input.default_ratio ?? current.default_ratio,
    supports_text_to_image: input.supports_text_to_image ?? current.supports_text_to_image,
    supports_image_to_image: input.supports_image_to_image ?? current.supports_image_to_image,
    supports_async_task: input.supports_async_task ?? current.supports_async_task,
  });
}

export async function saveImageGenerationApiSettings(
  input: ImageGenerationApiSettingsInput,
  updatedBy: string,
) {
  const current = await getImageGenerationApiSettings();
  const settings = buildImageGenerationApiSettingsPatch(current, input);

  await prisma.platformSetting.upsert({
    where: { key: IMAGE_GENERATION_API_SETTING_KEY },
    update: {
      value_json: JSON.stringify(settings),
      updated_by: updatedBy,
    },
    create: {
      key: IMAGE_GENERATION_API_SETTING_KEY,
      value_json: JSON.stringify(settings),
      updated_by: updatedBy,
    },
  });

  return settings;
}

export function isImageGenerationApiReady(settings: ImageGenerationApiSettings) {
  return settings.enabled
    && Boolean(settings.provider && settings.base_url && settings.default_model && settings.api_key);
}

export class ImageGenerationApiError extends Error {
  constructor(
    message: string,
    public readonly status = 500,
    public readonly code = 'image_generation_api_error',
  ) {
    super(message);
  }
}

export type GeneratedImageOutput = {
  url?: string;
  b64Json?: string;
  mimeType?: string;
  revisedPrompt?: string;
};

export type ImageGenerationResult = {
  images: GeneratedImageOutput[];
  model: string;
  raw: unknown;
};

function buildMuskGeminiGenerateContentUrl(baseUrl: string, model: string) {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith(':generateContent')) return url.toString();
  const versionPath = path.endsWith('/v1') || path.endsWith('/v1beta')
    ? path
    : `${path}/v1beta`;
  url.pathname = `${versionPath}/models/${encodeURIComponent(model)}:generateContent`;
  return url.toString();
}

function pickOutputString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function extractGeminiGeneratedImages(data: Record<string, unknown>): GeneratedImageOutput[] {
  const candidates = Array.isArray(data.candidates) ? data.candidates : [];
  const images: GeneratedImageOutput[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const content = (candidate as Record<string, unknown>).content;
    if (!content || typeof content !== 'object') continue;
    const contentRecord = content as Record<string, unknown>;
    const parts: unknown[] = Array.isArray(contentRecord.parts)
      ? contentRecord.parts
      : [];
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      const record = part as Record<string, unknown>;
      const inlineData = record.inlineData || record.inline_data;
      if (!inlineData || typeof inlineData !== 'object') continue;
      const inlineRecord = inlineData as Record<string, unknown>;
      const dataValue = pickOutputString(inlineRecord, ['data']);
      if (!dataValue) continue;
      images.push({
        b64Json: dataValue,
        mimeType: pickOutputString(inlineRecord, ['mimeType', 'mime_type']) || 'image/png',
      });
    }
  }
  return images;
}

export async function createImageGeneration(params: {
  settings: ImageGenerationApiSettings;
  prompt: string;
  ratio?: string;
  count?: number;
}): Promise<ImageGenerationResult> {
  if (!isImageGenerationApiReady(params.settings)) {
    throw new ImageGenerationApiError('图形生成 API 未启用或缺少配置', 503, 'image_generation_api_not_configured');
  }

  const count = clampInteger(
    params.count,
    1,
    1,
    params.settings.max_outputs_per_request,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.settings.timeout_ms);

  try {
    const response = await fetch(buildMuskGeminiGenerateContentUrl(params.settings.base_url, params.settings.default_model), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': params.settings.api_key || '',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: params.prompt }],
        }],
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    let data: Record<string, unknown>;
    try {
      data = text.trim() ? JSON.parse(text) as Record<string, unknown> : {};
    } catch {
      throw new ImageGenerationApiError('图形生成 API 返回不是 JSON', 502, 'image_generation_invalid_response');
    }

    if (!response.ok) {
      const message = pickOutputString(data, ['message', 'error', 'detail'])
        || (data.error && typeof data.error === 'object'
          ? pickOutputString(data.error as Record<string, unknown>, ['message', 'code'])
          : null)
        || `图形生成 API 调用失败 (HTTP ${response.status})`;
      throw new ImageGenerationApiError(message, response.status, 'image_generation_upstream_error');
    }

    const images = extractGeminiGeneratedImages(data);
    if (images.length === 0) {
      throw new ImageGenerationApiError('图形生成 API 未返回图片', 502, 'image_generation_empty_output');
    }

    return {
      images: images.slice(0, count),
      model: params.settings.default_model,
      raw: data,
    };
  } catch (error) {
    if (error instanceof ImageGenerationApiError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ImageGenerationApiError('图形生成 API 调用超时', 504, 'image_generation_timeout');
    }
    throw new ImageGenerationApiError(
      error instanceof Error ? error.message : '图形生成 API 调用失败',
      500,
      'image_generation_request_failed',
    );
  } finally {
    clearTimeout(timeout);
  }
}
