import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export const IMAGE_GENERATION_API_SETTING_KEY = 'image_generation_api_v1';

export const IMAGE_GENERATION_PROVIDERS = ['banana2'] as const;

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
  provider: 'banana2',
  base_url: '',
  default_model: 'banana2',
  api_key: null,
  timeout_ms: 90000,
  max_outputs_per_request: 4,
  default_ratio: '16:9',
  supports_text_to_image: true,
  supports_image_to_image: true,
  supports_async_task: true,
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
  return IMAGE_GENERATION_PROVIDERS.includes(raw as ImageGenerationProvider)
    ? raw as ImageGenerationProvider
    : DEFAULT_IMAGE_GENERATION_API_SETTINGS.provider;
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

  return {
    enabled: input.enabled === true,
    provider: normalizeProvider(input.provider),
    base_url: normalizeBaseUrl(input.base_url),
    default_model: cleanString(input.default_model, DEFAULT_IMAGE_GENERATION_API_SETTINGS.default_model).slice(0, 80),
    api_key: cleanString(input.api_key, '').slice(0, 500) || null,
    timeout_ms: clampInteger(input.timeout_ms, DEFAULT_IMAGE_GENERATION_API_SETTINGS.timeout_ms, 5000, 300000),
    max_outputs_per_request: clampInteger(input.max_outputs_per_request, DEFAULT_IMAGE_GENERATION_API_SETTINGS.max_outputs_per_request, 1, 8),
    default_ratio: cleanString(input.default_ratio, DEFAULT_IMAGE_GENERATION_API_SETTINGS.default_ratio).slice(0, 20),
    supports_text_to_image: input.supports_text_to_image !== false,
    supports_image_to_image: input.supports_image_to_image !== false,
    supports_async_task: input.supports_async_task !== false,
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

function buildImagesGenerationUrl(baseUrl: string) {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/images/generations')) return url.toString();
  url.pathname = path.endsWith('/v1') ? `${path}/images/generations` : `${path}/v1/images/generations`;
  return url.toString();
}

function sizeFromRatio(ratio: string) {
  const normalized = cleanString(ratio, DEFAULT_IMAGE_GENERATION_API_SETTINGS.default_ratio);
  if (normalized === '1:1') return '1024x1024';
  if (normalized === '9:16' || normalized === '3:4') return '1024x1536';
  return '1536x1024';
}

function pickOutputString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function extractImageFromRecord(record: Record<string, unknown>): GeneratedImageOutput | null {
  const nestedImage = record.image && typeof record.image === 'object'
    ? record.image as Record<string, unknown>
    : {};
  const merged = { ...nestedImage, ...record };
  const url = pickOutputString(merged, ['url', 'image_url', 'imageUrl', 'output_url', 'outputUrl']);
  const b64Json = pickOutputString(merged, ['b64_json', 'b64Json', 'base64', 'image_base64', 'imageBase64']);
  if (!url && !b64Json) return null;

  return {
    url,
    b64Json,
    mimeType: pickOutputString(merged, ['mime_type', 'mimeType', 'content_type', 'contentType']),
    revisedPrompt: pickOutputString(merged, ['revised_prompt', 'revisedPrompt']),
  };
}

function extractGeneratedImages(data: Record<string, unknown>): GeneratedImageOutput[] {
  const candidates = Array.isArray(data.data)
    ? data.data
    : Array.isArray(data.images)
      ? data.images
      : Array.isArray(data.output)
        ? data.output
        : [];

  const images: GeneratedImageOutput[] = [];
  for (const item of candidates) {
    if (typeof item === 'string' && item.trim()) {
      const value = item.trim();
      images.push(value.startsWith('data:image/') ? { b64Json: value } : { url: value });
      continue;
    }
    if (item && typeof item === 'object') {
      const image = extractImageFromRecord(item as Record<string, unknown>);
      if (image) images.push(image);
    }
  }

  if (images.length > 0) return images;

  const single = extractImageFromRecord(data);
  return single ? [single] : [];
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
    const response = await fetch(buildImagesGenerationUrl(params.settings.base_url), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.settings.api_key}`,
      },
      body: JSON.stringify({
        model: params.settings.default_model,
        prompt: params.prompt,
        n: count,
        size: sizeFromRatio(params.ratio || params.settings.default_ratio),
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

    const images = extractGeneratedImages(data);
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
