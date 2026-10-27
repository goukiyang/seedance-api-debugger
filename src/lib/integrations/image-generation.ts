import type { Prisma } from '@prisma/client';
import { parsePrivateCredentials, stringifyPrivateCredentials } from '@/lib/security/private-credentials.server';
import { isPrivatePromptError } from '@/lib/security/private-prompts.server';
import { privateCredentialFetch } from '@/lib/security/private-prompt-send.server';
import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { imageOutputSize, normalizeImageResolution, assertImageResolutionSupported, isGeminiImageModel, isValidImageDimension, supportsStudioFourToOne } from '@/lib/image-generation/resolution';
import {
  IMAGE_STUDIO_MODELS,
  IMAGE_STUDIO_MODEL_QUALITY_OPTIONS,
  IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS,
  normalizeImageStudioQuality,
  type ImageStudioModel,
} from '@/lib/image-studio/model-catalog';
import { MAX_REFERENCE_IMAGES } from '@/lib/image-studio/limits';
import { STUDIO_RATIOS, isStandardStudioRatio, normalizeStudioRatio, CURRENT_STUDIO_SIZE_POLICY_VERSION, type StudioSizePolicyVersion } from '@/lib/image-studio/ratios';
import { getImageStudioSettings } from '@/lib/image-studio/settings';
import { requestStudioImages, StudioProviderError, type StudioImageInput } from '@/lib/image-studio/provider';
import { readStudioImage, normalizeStudioImage } from '@/lib/image-studio/media';
import {
  getImageGenerationDefaultRoutes,
  IMAGE_GENERATION_MODEL_DEFAULTS_SETTING_KEY,
  parseImageGenerationDefaultRoutes,
  serializeImageGenerationDefaultRoutes,
  resolveImageGenerationRequestRoute,
} from '@/lib/integrations/image-generation-defaults';
import { IMAGE_25_QUALITY_MODEL, type ImageQualityRouteSnapshot } from '@/lib/image-studio/quality-routing';
import {
  IMAGE_API_GROUPS, imageApiGroupModels, imageApiGroupModelMissingRequirements, allowsUnconfirmedGeminiProParameters,
  type ImageApiGroup, type ImageApiGroupFormDto, type ImageApiGroupSettings,
  type ImageApiGroupSaveReceipt, type ImageApiGroupModelDto,
  type ImageGenerationChannelDto,
  type ImageGenerationChannelId,
  type ImageGenerationChannelProtocol,
  type ImageGenerationChannelsDto,
  type ImageGenerationChannelSnapshot,
  type ImageGenerationManagedChannelDto,
  type ImageGenerationResolvedProtocol,
} from '@/lib/integrations/image-generation-channel';
export type { ImageGenerationChannelSnapshot } from '@/lib/integrations/image-generation-channel';

export const IMAGE_GENERATION_API_SETTING_KEY = 'image_generation_api_v1';
export const BANANA_IMAGE_API_SETTING_KEY = 'banana_image_api_v1';
export const IMAGE_GENERATION_CHANNEL_REGISTRY_SETTING_KEY = 'image_generation_channels_v1';
export const IMAGE_GENERATION_LEGACY_MODEL_API_SETTING_PREFIX = 'image_generation_legacy_model_api_v1:';
const IMAGE_GENERATION_CHANNEL_VERSION_PREFIX = 'image_generation_channel_version_v1:';
export const FLUXPORT_IMAGE_GENERATION_BASE_URL = 'https://api.uselg.top';

export const IMAGE_GENERATION_PROVIDERS = ['musk', 'ai_media_vip', 'seedream'] as const;
export type LegacyImageGenerationProvider = typeof IMAGE_GENERATION_PROVIDERS[number];
export type ImageGenerationProvider = LegacyImageGenerationProvider | 'fluxport' | 'managed';
export const DEFAULT_MUSK_IMAGE_MODEL = 'gemini-3.1-flash-image-preview';
export const DEFAULT_MUSK_IMAGE_BASE_URL = 'https://api.muskapis.com/';
export const DEFAULT_AI_MEDIA_IMAGE_BASE_URL = 'https://api.ai-media.vip/v1/';
export const DEFAULT_SEEDREAM_IMAGE_MODEL = 'doubao-seedream-5-0-pro-260628';
export const DEFAULT_SEEDREAM_IMAGE_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

const LEGACY_IMAGE_GENERATION_PROVIDERS = new Set(['banana2', 'gemini']);
const LEGACY_IMAGE_GENERATION_MODELS = new Set(['banana2', 'gemini-3.1-flash-image']);
const LEGACY_GOOGLE_GEMINI_HOST = 'generativelanguage.googleapis.com';
const IMAGE_GENERATION_SIZE_OPTIONS = ['1K', '2K'] as const;
const IMAGE_GENERATION_OUTPUT_FORMATS = ['png', 'jpeg'] as const;
const IMAGE_GENERATION_RESPONSE_FORMATS = ['url', 'b64_json'] as const;

export type ImageGenerationSize = typeof IMAGE_GENERATION_SIZE_OPTIONS[number];
export type ImageGenerationOutputFormat = typeof IMAGE_GENERATION_OUTPUT_FORMATS[number];
export type ImageGenerationResponseFormat = typeof IMAGE_GENERATION_RESPONSE_FORMATS[number];

export type ImageGenerationApiSettings = {
  enabled: boolean;
  provider: ImageGenerationProvider;
  base_url: string;
  default_model: string;
  api_key: string | null;
  timeout_ms: number;
  max_outputs_per_request: number;
  default_ratio: string;
  default_size: ImageGenerationSize;
  output_format: ImageGenerationOutputFormat;
  response_format: ImageGenerationResponseFormat;
  watermark: boolean;
  supports_text_to_image: boolean;
  supports_image_to_image: boolean;
  supports_async_task: boolean;
};

export type ImageGenerationModelCapability = {
  enabled: boolean;
  protocol: ImageGenerationChannelProtocol;
  /** Optional supplier request name/address; local model validation is unchanged. */
  upstreamModel?: string;
  baseUrl?: string;
  qualities: string[] | null;
  resolutions: string[] | null;
  ratios: string[] | null;
  maxReferences: number | null;
  billingMode: 'fixed' | 'actual' | null;
  fixedPoints: number | null;
  billingSource: string | null;
  /** Computed from this model's frozen API Key scope, never accepted from the client. */
  actualQuoteRequired?: boolean;
};

export type ImageGenerationResolvedSettings = ImageGenerationApiSettings & {
  channelId: ImageGenerationChannelId;
  configRevision: string;
  supplierName: string;
  supplierKind: 'fluxport' | 'musk' | 'other' | 'legacy';
  protocol: ImageGenerationResolvedProtocol;
  modelCapabilities: Partial<Record<ImageStudioModel, ImageGenerationModelCapability>>;
  /** Private frozen overrides. Never include these in registry or public DTOs. */
  modelApiKeys?: Partial<Record<ImageStudioModel, string>>;
  inherited_base_url?: string;
  inherited_api_key?: string | null;
  /** True when this frozen version belongs to an admin-managed registry entry. */
  managedChannel: boolean;
  explicitModelApi?: boolean;
  label?: string;
  deleted?: boolean;
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
  default_size: '2K',
  output_format: 'png',
  response_format: 'url',
  watermark: false,
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

function normalizeProvider(value: unknown): LegacyImageGenerationProvider {
  const raw = cleanString(value, DEFAULT_IMAGE_GENERATION_API_SETTINGS.provider);
  if (LEGACY_IMAGE_GENERATION_PROVIDERS.has(raw)) return 'musk';
  return IMAGE_GENERATION_PROVIDERS.includes(raw as LegacyImageGenerationProvider)
    ? raw as LegacyImageGenerationProvider
    : 'musk';
}

function providerDefaults(provider: ImageGenerationProvider) {
  if (provider === 'seedream') {
    return {
      base_url: DEFAULT_SEEDREAM_IMAGE_BASE_URL,
      default_model: DEFAULT_SEEDREAM_IMAGE_MODEL,
      max_outputs_per_request: 1,
      supports_text_to_image: true,
      supports_image_to_image: true,
      supports_async_task: false,
      default_size: '2K' as ImageGenerationSize,
      output_format: 'png' as ImageGenerationOutputFormat,
      response_format: 'url' as ImageGenerationResponseFormat,
      watermark: false,
    };
  }
  if (provider === 'ai_media_vip') {
    return {
      base_url: DEFAULT_AI_MEDIA_IMAGE_BASE_URL,
      default_model: DEFAULT_MUSK_IMAGE_MODEL,
      max_outputs_per_request: 1,
      supports_text_to_image: true,
      supports_image_to_image: true,
      supports_async_task: false,
      default_size: '2K' as ImageGenerationSize,
      output_format: 'png' as ImageGenerationOutputFormat,
      response_format: 'url' as ImageGenerationResponseFormat,
      watermark: false,
    };
  }
  return {
    base_url: DEFAULT_MUSK_IMAGE_BASE_URL,
    default_model: DEFAULT_MUSK_IMAGE_MODEL,
    max_outputs_per_request: 1,
    supports_text_to_image: true,
    supports_image_to_image: true,
    supports_async_task: false,
    default_size: '2K' as ImageGenerationSize,
    output_format: 'png' as ImageGenerationOutputFormat,
    response_format: 'url' as ImageGenerationResponseFormat,
    watermark: false,
  };
}

export function isStudioImageGenerationProvider(provider: ImageGenerationProvider) {
  return provider === 'musk' || provider === 'ai_media_vip' || provider === 'fluxport' || provider === 'managed';
}

function normalizeDefaultModel(value: unknown, provider: ImageGenerationProvider) {
  const raw = cleanString(value, providerDefaults(provider).default_model);
  if (LEGACY_IMAGE_GENERATION_MODELS.has(raw)) return DEFAULT_IMAGE_GENERATION_API_SETTINGS.default_model;
  return raw.slice(0, 80);
}

function normalizeSize(value: unknown, fallback: ImageGenerationSize = DEFAULT_IMAGE_GENERATION_API_SETTINGS.default_size) {
  const raw = cleanString(value, fallback);
  return IMAGE_GENERATION_SIZE_OPTIONS.includes(raw as ImageGenerationSize)
    ? raw as ImageGenerationSize
    : fallback;
}

function normalizeOutputFormat(
  value: unknown,
  fallback: ImageGenerationOutputFormat = DEFAULT_IMAGE_GENERATION_API_SETTINGS.output_format,
) {
  const raw = cleanString(value, fallback).toLowerCase();
  return IMAGE_GENERATION_OUTPUT_FORMATS.includes(raw as ImageGenerationOutputFormat)
    ? raw as ImageGenerationOutputFormat
    : fallback;
}

function normalizeResponseFormat(
  value: unknown,
  fallback: ImageGenerationResponseFormat = DEFAULT_IMAGE_GENERATION_API_SETTINGS.response_format,
) {
  const raw = cleanString(value, fallback).toLowerCase();
  return IMAGE_GENERATION_RESPONSE_FORMATS.includes(raw as ImageGenerationResponseFormat)
    ? raw as ImageGenerationResponseFormat
    : fallback;
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
  const provider = isLegacy ? DEFAULT_IMAGE_GENERATION_API_SETTINGS.provider : normalizeProvider(input.provider);
  const defaults = providerDefaults(provider);

  return {
    enabled: input.enabled === true,
    provider,
    base_url: normalizeBaseUrl(isLegacy ? DEFAULT_IMAGE_GENERATION_API_SETTINGS.base_url : input.base_url, defaults.base_url),
    default_model: normalizeDefaultModel(input.default_model, provider),
    api_key: cleanString(input.api_key, '').slice(0, 500) || null,
    timeout_ms: clampInteger(input.timeout_ms, DEFAULT_IMAGE_GENERATION_API_SETTINGS.timeout_ms, 5000, 300000),
    max_outputs_per_request: provider === 'seedream' ? 1 : clampInteger(
      isLegacy ? DEFAULT_IMAGE_GENERATION_API_SETTINGS.max_outputs_per_request : input.max_outputs_per_request,
      defaults.max_outputs_per_request,
      1,
      8,
    ),
    default_ratio: cleanString(input.default_ratio, DEFAULT_IMAGE_GENERATION_API_SETTINGS.default_ratio).slice(0, 20),
    default_size: normalizeSize(input.default_size, defaults.default_size),
    output_format: normalizeOutputFormat(input.output_format, defaults.output_format),
    response_format: normalizeResponseFormat(input.response_format, defaults.response_format),
    watermark: input.watermark === undefined ? defaults.watermark : input.watermark === true,
    supports_text_to_image: provider === 'seedream' ? true : input.supports_text_to_image !== false,
    supports_image_to_image: provider === 'seedream' ? true : input.supports_image_to_image !== false,
    supports_async_task: provider === 'seedream'
      ? false
      : isLegacy ? DEFAULT_IMAGE_GENERATION_API_SETTINGS.supports_async_task : input.supports_async_task !== false,
  };
}

export async function getImageGenerationApiSettings(
  client: Prisma.TransactionClient | typeof prisma = prisma,
  channel: 'default' | 'banana' = 'default',
  strictPricing = false,
): Promise<ImageGenerationApiSettings> {
  const fallback = channel === 'banana'
    ? { ...DEFAULT_IMAGE_GENERATION_API_SETTINGS, max_outputs_per_request: 8 }
    : DEFAULT_IMAGE_GENERATION_API_SETTINGS;
  const setting = await client.platformSetting.findUnique({ where: { key: channel === 'banana' ? BANANA_IMAGE_API_SETTING_KEY : IMAGE_GENERATION_API_SETTING_KEY } });
  if (!setting) return fallback;

  try {
    const value = parsePrivateCredentials(setting.key, setting.value_json);
    if (strictPricing) assertPricingApiSource(value);
    return normalizeImageGenerationApiSettings(channel === 'banana'
      ? { ...value, provider: 'musk', default_model: DEFAULT_MUSK_IMAGE_MODEL }
      : value);
  } catch (error) {
    if (isPrivatePromptError(error)) throw error;
    if (strictPricing) throw error;
    return fallback;
  }
}

function assertPricingApiSource(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('图片接口配置格式损坏');
  const source = value as Record<string, unknown>;
  for (const field of ['enabled', 'watermark', 'supports_text_to_image', 'supports_image_to_image', 'supports_async_task']) {
    if (source[field] !== undefined && typeof source[field] !== 'boolean') throw new Error('图片接口开关配置损坏');
  }
  for (const field of ['base_url', 'api_key', 'default_model', 'default_ratio', 'default_size', 'output_format', 'response_format']) {
    if (source[field] !== undefined && !(field === 'api_key' && source[field] === null) && typeof source[field] !== 'string') throw new Error('图片接口字段配置损坏');
  }
  if (source.provider !== undefined && (typeof source.provider !== 'string'
    || ![...IMAGE_GENERATION_PROVIDERS, ...Array.from(LEGACY_IMAGE_GENERATION_PROVIDERS)].includes(source.provider as LegacyImageGenerationProvider))) throw new Error('图片接口供应商配置损坏');
  if (typeof source.base_url === 'string' && source.base_url.trim()) {
    const url = new URL(source.base_url);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('图片接口地址配置损坏');
  }
  for (const field of ['timeout_ms', 'max_outputs_per_request']) {
    if (source[field] !== undefined && (typeof source[field] !== 'number' || !Number.isSafeInteger(source[field]) || Number(source[field]) <= 0)) throw new Error('图片接口数值配置损坏');
  }
}

async function pricingStudioSettings(client: Prisma.TransactionClient | typeof prisma) {
  const row = await client.platformSetting.findUnique({ where: { key: 'gpt_image_studio_v1' } });
  if (row) {
    const value: unknown = JSON.parse(row.value_json);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('图片价格配置损坏');
    const prices = (value as Record<string, unknown>).prices;
    if (!prices || typeof prices !== 'object' || Array.isArray(prices)
      || Object.values(prices).some(price => price !== null && (typeof price !== 'number' || !Number.isFinite(price) || price < 0 || price > 100000))) throw new Error('图片价格配置损坏');
  }
  return getImageStudioSettings(client);
}

export type ImageGenerationChannels = {
  shared: ImageGenerationApiSettings;
  banana: ImageGenerationApiSettings;
  legacyPrices: Record<ImageStudioModel, number | null>;
  fluxport: ImageGenerationResolvedSettings;
  managed: ImageGenerationResolvedSettings[];
  registry: ManagedChannelRegistry;
  legacyModelApis: Record<'shared' | 'banana', LegacyModelApiRegistry>;
};

export async function getImageGenerationChannels(client: Prisma.TransactionClient | typeof prisma = prisma, strictPricing = false): Promise<ImageGenerationChannels> {
  const [shared, banana, registry, studioSettings, sharedModels, bananaModels] = await Promise.all([
    getImageGenerationApiSettings(client, 'default', strictPricing),
    getImageGenerationApiSettings(client, 'banana', strictPricing),
    readManagedChannelRegistry(client),
    strictPricing ? pricingStudioSettings(client) : getImageStudioSettings(client).catch(() => null),
    readLegacyModelApiRegistry('shared', client),
    readLegacyModelApiRegistry('banana', client),
  ]);
  const records = registry.channels;
  const versions = await Promise.all(records.map(async record => hydrateActualBilling(
    await resolveCurrentManagedSettings(record, client), client, strictPricing,
  )));
  const fluxport = versions.find(item => item.channelId === 'fluxport') || emptyFluxPortSettings();
  return {
    shared,
    banana,
    legacyPrices: studioSettings?.prices || Object.fromEntries(IMAGE_STUDIO_MODELS.map(model => [model, null])) as Record<ImageStudioModel, number | null>,
    fluxport,
    managed: versions.filter(item => item.channelId !== 'fluxport'),
    registry,
    legacyModelApis: { shared: sharedModels, banana: bananaModels },
  };
}

// Missing/original preserves the historic Gemini -> Banana, other -> shared route.
export function selectImageGenerationSettings(
  channels: ImageGenerationChannels,
  model: string,
  channelId: ImageGenerationChannelId = 'original',
): ImageGenerationResolvedSettings {
  if (channelId === 'original') {
    const legacy = isGeminiImageModel(model) ? channels.banana : channels.shared;
    return resolveLegacySettings(legacy, model, 'original', channels.legacyPrices);
  }
  if (channelId === 'shared') return applyLegacyModelApis(resolveLegacySettings(channels.shared, model, 'shared', channels.legacyPrices), channels.legacyModelApis.shared, model);
  if (channelId === 'banana') return applyLegacyModelApis(resolveLegacySettings(channels.banana, model, 'banana', channels.legacyPrices), channels.legacyModelApis.banana, model);
  if (channelId === 'fluxport') return resolveImageGenerationModelSettings(channels.fluxport, model);
  const selected = channels.managed.find(item => item.channelId === channelId);
  if (!selected || selected.deleted) throw new ImageGenerationChannelError('所选图片供应商配置不存在或已归档', 404, 'image_channel_not_found');
  return resolveImageGenerationModelSettings(selected, model);
}

/** Read-only pricing projection. Unlike capture, this never persists a private channel version. */
export async function selectPricingImageGenerationSettings(channels: ImageGenerationChannels, model: string,
  channelId: ImageGenerationChannelId, client: Prisma.TransactionClient | typeof prisma = prisma) {
  const settings = selectImageGenerationSettings(channels, model, channelId);
  if (channelId !== 'shared' && channelId !== 'banana') return settings;
  const capability = settings.modelCapabilities[model as ImageStudioModel];
  const intent = await legacyBillingIntentState(settings, model, client, true);
  if (!capability || !intent.selected) return settings;
  return { ...settings, modelCapabilities: { ...settings.modelCapabilities, [model]: {
    ...capability, billingMode: 'actual' as const, actualQuoteRequired: intent.quoteReady,
  } } };
}

/** Resolve one local model against the same immutable supplier revision. */
export function resolveImageGenerationModelSettings(settings: ImageGenerationResolvedSettings, model: string): ImageGenerationResolvedSettings {
  const capability = settings.modelCapabilities[model as ImageStudioModel];
  const inheritedBase = settings.inherited_base_url ?? settings.base_url;
  const inheritedKey = settings.inherited_api_key !== undefined ? settings.inherited_api_key : settings.api_key;
  return {
    ...settings,
    default_model: model,
    inherited_base_url: inheritedBase,
    inherited_api_key: inheritedKey,
    base_url: capability?.baseUrl || inheritedBase,
    api_key: settings.modelApiKeys?.[model as ImageStudioModel] || inheritedKey,
  };
}

/** Standard ratios are application choices; old frozen tasks retain their original capability gate. */
export function imageGenerationSupportsStudioFourToOne(settings: ImageGenerationApiSettings, model: string, legacyRatioContract = false): boolean {
  if (!legacyRatioContract) return isStudioImageGenerationProvider(settings.provider) && IMAGE_STUDIO_MODELS.includes(model as ImageStudioModel);
  const resolved = settings as ImageGenerationResolvedSettings;
  const capability = resolved.modelCapabilities?.[model as ImageStudioModel];
  if (resolved.managedChannel && capability?.protocol === 'openai_images') {
    return capability.ratios?.includes('4:1') === true;
  }
  const protocol = resolved.managedChannel || resolved.explicitModelApi ? capability?.protocol : undefined;
  return supportsStudioFourToOne(model, protocol === 'openai_images' ? 'ai_media_vip' : settings.provider);
}

/** Convert the existing local resolution/ratio to the explicitly chosen adapter. */
export function imageGenerationModelOutputSize(settings: ImageGenerationApiSettings, model: string, resolution: unknown, ratio: string,
  sizePolicyVersion: StudioSizePolicyVersion = CURRENT_STUDIO_SIZE_POLICY_VERSION) {
  const resolved = settings as ImageGenerationResolvedSettings;
  const protocol = resolved.managedChannel || resolved.explicitModelApi ? resolved.modelCapabilities[model as ImageStudioModel]?.protocol : undefined;
  if (protocol === 'gemini_native') {
    const normalized = normalizeImageResolution(model, resolution, settings.provider);
    assertImageResolutionSupported(model, normalized);
    return normalized;
  }
  const size = imageOutputSize(model, resolution, ratio, protocol === 'openai_images' ? 'ai_media_vip' : settings.provider,
    imageGenerationSupportsStudioFourToOne(settings, model), sizePolicyVersion);
  const pixelProtocol = protocol === 'openai_images' || !isGeminiImageModel(model) || settings.provider === 'ai_media_vip';
  if (pixelProtocol && !isValidImageDimension(size, true)) {
    throw new ImageGenerationChannelError('所选比例与分辨率无法在安全像素范围内表达，请调整分辨率；尚未向供应商提交', 400, 'image_generation_invalid_dimensions');
  }
  return size;
}

/** New requests resolve the model's default route explicitly; historical callers keep using original semantics. */
export async function getImageGenerationDefaultSettingsForModel(
  model: ImageStudioModel,
  client: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const [channels, defaults] = await Promise.all([
    getImageGenerationChannels(client),
    getImageGenerationDefaultRoutes(client),
  ]);
  const channelId = defaults.models[model] || (isGeminiImageModel(model) ? 'banana' : 'shared');
  return selectImageGenerationSettings(channels, model, channelId);
}

// Keep the historical `(model, client)` call shape; `channelId` is an optional third argument.
export async function getImageGenerationSettingsForModel(
  model: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
  channelId: ImageGenerationChannelId = 'original',
) {
  const channels = await getImageGenerationChannels(client);
  return selectImageGenerationSettings(channels, model, channelId);
}

export function buildImageGenerationApiSettingsPatch(
  current: ImageGenerationApiSettings,
  input: ImageGenerationApiSettingsInput,
): ImageGenerationApiSettings {
  const incomingApiKey = typeof input.api_key === 'string' ? input.api_key.trim() : '';
  const hasNewApiKey = Boolean(incomingApiKey);
  const nextProvider = normalizeProvider(input.provider ?? current.provider);
  const nextDefaults = providerDefaults(nextProvider);
  const providerChanged = input.provider !== undefined && nextProvider !== current.provider;
  const nextBaseUrl = input.base_url ?? (providerChanged ? nextDefaults.base_url : current.base_url);
  const nextDefaultModel = input.default_model ?? (providerChanged ? nextDefaults.default_model : current.default_model);
  const nextApiKey = input.clear_api_key === true
    ? null
    : hasNewApiKey
      ? incomingApiKey
      : current.api_key;
  const shouldAutoEnable = hasNewApiKey && Boolean(nextBaseUrl && nextDefaultModel);

  return normalizeImageGenerationApiSettings({
    ...current,
    enabled: input.clear_api_key === true ? false : input.enabled === true || shouldAutoEnable,
    provider: nextProvider,
    base_url: nextBaseUrl,
    default_model: nextDefaultModel,
    api_key: nextApiKey,
    timeout_ms: input.timeout_ms ?? current.timeout_ms,
    max_outputs_per_request: input.max_outputs_per_request ?? (providerChanged ? nextDefaults.max_outputs_per_request : current.max_outputs_per_request),
    default_ratio: input.default_ratio ?? current.default_ratio,
    default_size: input.default_size ?? (providerChanged ? nextDefaults.default_size : current.default_size),
    output_format: input.output_format ?? (providerChanged ? nextDefaults.output_format : current.output_format),
    response_format: input.response_format ?? (providerChanged ? nextDefaults.response_format : current.response_format),
    watermark: input.watermark ?? (providerChanged ? nextDefaults.watermark : current.watermark),
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
      value_json: stringifyPrivateCredentials(IMAGE_GENERATION_API_SETTING_KEY, settings),
      updated_by: updatedBy,
    },
    create: {
      key: IMAGE_GENERATION_API_SETTING_KEY,
      value_json: stringifyPrivateCredentials(IMAGE_GENERATION_API_SETTING_KEY, settings),
      updated_by: updatedBy,
    },
  });

  return settings;
}

type ManagedChannelRegistryRecord = {
  id: ImageGenerationChannelId;
  label: string;
  supplierName: string;
  supplierKind: 'fluxport' | 'musk' | 'other';
  protocol: ImageGenerationResolvedProtocol;
  baseUrl: string;
  enabled: boolean;
  deleted: boolean;
  configRevision: string | null;
  modelCapabilities: Partial<Record<ImageStudioModel, ImageGenerationModelCapability>>;
};

type ManagedChannelRegistry = { version: 1; channels: ManagedChannelRegistryRecord[] };

type PrivateImageGenerationChannelVersion = {
  version: 1;
  channelId: ImageGenerationChannelId;
  configRevision: string;
  label: string;
  supplierName: string;
  supplierKind: 'fluxport' | 'musk' | 'other' | 'legacy';
  sourceChannelId?: 'shared' | 'banana';
  sourceFingerprint?: string;
  /** Optional legacy model-API row revision; absent keeps historical snapshots unchanged. */
  modelOverrideRevision?: string | null;
  selectedModel?: ImageStudioModel;
  /** Billing intent revision captured for alias channels so fixed quotes cannot outlive a mode change. */
  billingIntentRevision?: number;
  protocol: ImageGenerationResolvedProtocol;
  managedChannel: boolean;
  explicitModelApi?: boolean;
  settings: ImageGenerationApiSettings;
  modelCapabilities: Partial<Record<ImageStudioModel, ImageGenerationModelCapability>>;
  modelApiKeys?: Partial<Record<ImageStudioModel, string>>;
  deleted?: boolean;
};

export type ManagedImageGenerationChannelInput = {
  id?: unknown;
  expectedRevision?: unknown;
  label?: unknown;
  supplierName?: unknown;
  supplierKind?: unknown;
  protocol?: unknown;
  baseUrl?: unknown;
  enabled?: unknown;
  deleted?: unknown;
  apiKey?: unknown;
  clearApiKey?: unknown;
  models?: unknown;
};

export class ImageGenerationChannelError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = 'image_channel_invalid') {
    super(message);
    this.name = 'ImageGenerationChannelError';
  }
}

const GEMINI_CHANNEL_MODELS = new Set<ImageStudioModel>([
  'gemini-nano-banana-2.1',
  'gemini-3.1-flash-image-preview',
  'gemini-3-pro-image-preview',
]);
const GPT_IMAGE_CHANNEL_MODELS = new Set<ImageStudioModel>([
  'gpt-image-2',
  'gpt-image-2.5-flare',
  'gpt-image-2.5-sunburst',
]);
const FLUXPORT_PROTOCOL_BY_MODEL: Record<ImageStudioModel, ImageGenerationChannelProtocol> = {
  'gemini-nano-banana-2.1': 'gemini_native',
  'gemini-3.1-flash-image-preview': 'gemini_native',
  'gemini-3-pro-image-preview': 'gemini_native',
  'gpt-image-2': 'openai_images',
  'gpt-image-2.5-flare': 'openai_images',
  'gpt-image-2.5-sunburst': 'openai_images',
};

function blankCapability(protocol: ImageGenerationChannelProtocol, enabled = false): ImageGenerationModelCapability {
  return {
    enabled,
    protocol,
    qualities: null,
    resolutions: null,
    ratios: null,
    maxReferences: null,
    billingMode: null,
    fixedPoints: null,
    billingSource: null,
  };
}

function emptyFluxPortRecord(): ManagedChannelRegistryRecord {
  return {
    id: 'fluxport',
    label: 'FluxPort',
    supplierName: 'FluxPort',
    supplierKind: 'fluxport',
    protocol: 'mixed',
    baseUrl: FLUXPORT_IMAGE_GENERATION_BASE_URL,
    enabled: false,
    deleted: false,
    configRevision: null,
    modelCapabilities: Object.fromEntries(IMAGE_STUDIO_MODELS.map(model => [model, blankCapability(FLUXPORT_PROTOCOL_BY_MODEL[model])])) as Partial<Record<ImageStudioModel, ImageGenerationModelCapability>>,
  };
}

function isDynamicImageChannelId(value: unknown): value is ImageGenerationChannelId {
  return typeof value === 'string'
    && /^image-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function assertImageGenerationChannelId(value: unknown): asserts value is ImageGenerationChannelId {
  if (value === 'original' || value === 'shared' || value === 'banana' || value === 'fluxport' || isDynamicImageChannelId(value)) return;
  throw new ImageGenerationChannelError('图片供应商配置编号无效', 400, 'image_channel_invalid_id');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

type LegacyModelApi = { protocol?: ImageGenerationChannelProtocol; upstreamModel?: string; baseUrl?: string; apiKey?: string };
type LegacyModelApiRegistry = { version: 1; revision: string | null; models: Partial<Record<ImageStudioModel, LegacyModelApi>> };

async function readLegacyModelApiRegistry(channel: 'shared' | 'banana', client: Prisma.TransactionClient | typeof prisma): Promise<LegacyModelApiRegistry> {
  const row = await client.platformSetting.findUnique({ where: { key: `${IMAGE_GENERATION_LEGACY_MODEL_API_SETTING_PREFIX}${channel}` } });
  if (!row) return { version: 1, revision: null, models: {} };
  let value: unknown;
  try { value = parsePrivateCredentials(row.key, row.value_json); } catch (error) { if (isPrivatePromptError(error)) throw error; throw new ImageGenerationChannelError('原供应商型号配置损坏，未使用旧接口代替', 500, 'image_legacy_model_api_invalid'); }
  if (!isRecord(value) || value.version !== 1 || typeof value.revision !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.revision) || !isRecord(value.models)) {
    throw new ImageGenerationChannelError('原供应商型号配置格式无效，未使用旧接口代替', 500, 'image_legacy_model_api_invalid');
  }
  const models: LegacyModelApiRegistry['models'] = {};
  for (const [model, source] of Object.entries(value.models)) {
    if (!IMAGE_STUDIO_MODELS.includes(model as ImageStudioModel) || !isRecord(source)
      || Object.keys(source).some(key => !['protocol', 'upstreamModel', 'baseUrl', 'apiKey'].includes(key))
      || source.protocol !== undefined && source.protocol !== 'gemini_native' && source.protocol !== 'openai_images'
      || source.upstreamModel !== undefined && (typeof source.upstreamModel !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(source.upstreamModel))
      || source.baseUrl !== undefined && (typeof source.baseUrl !== 'string' || source.baseUrl.length > 2048)
      || source.apiKey !== undefined && (typeof source.apiKey !== 'string' || !source.apiKey.trim() || source.apiKey.length > 500)) {
      throw new ImageGenerationChannelError('原供应商型号配置内容无效，未使用旧接口代替', 500, 'image_legacy_model_api_invalid');
    }
    models[model as ImageStudioModel] = source as LegacyModelApi;
  }
  return { version: 1, revision: value.revision, models };
}

export async function hasLegacyImageGenerationModelOverride(model: ImageStudioModel, channel: 'shared' | 'banana', client: Prisma.TransactionClient | typeof prisma = prisma) {
  return Boolean((await readLegacyModelApiRegistry(channel, client)).models[model]);
}

export async function hasLegacyImageGenerationModelApiKey(channel: 'shared' | 'banana', client: Prisma.TransactionClient | typeof prisma = prisma) {
  return Object.values((await readLegacyModelApiRegistry(channel, client)).models).some(api => Boolean(api?.apiKey));
}

function applyLegacyModelApis(settings: ImageGenerationResolvedSettings, registry: LegacyModelApiRegistry, model: string) {
  const modelCapabilities = { ...settings.modelCapabilities };
  const modelApiKeys: Partial<Record<ImageStudioModel, string>> = {};
  for (const localModel of IMAGE_STUDIO_MODELS) {
    const api = registry.models[localModel];
    const capability = modelCapabilities[localModel];
    if (!api || !capability) continue;
    modelCapabilities[localModel] = { ...capability,
      ...(api.protocol ? { protocol: api.protocol } : {}),
      ...(api.upstreamModel ? { upstreamModel: api.upstreamModel } : {}),
      ...(api.baseUrl ? { baseUrl: api.baseUrl } : {}),
    };
    if (api.apiKey) modelApiKeys[localModel] = api.apiKey;
  }
  return resolveImageGenerationModelSettings({ ...settings, modelCapabilities, modelApiKeys, explicitModelApi: Boolean(registry.models[model as ImageStudioModel]) }, model);
}

/** Only edits one original supplier's transport; pricing, enablement and defaults stay separate. */
export async function updateLegacyImageGenerationModelApi(input: ManagedImageGenerationChannelInput & { model?: unknown; modelApi?: unknown }, updatedBy: string) {
  if (input.id !== 'shared' && input.id !== 'banana') throw new ImageGenerationChannelError('原供应商编号无效');
  const channel = input.id;
  if (!IMAGE_STUDIO_MODELS.includes(input.model as ImageStudioModel) || !isRecord(input.modelApi)) throw new ImageGenerationChannelError('请选择有效型号并填写 API 配置');
  const model = input.model as ImageStudioModel;
  const source = input.modelApi;
  if (Object.keys(source).some(key => !['protocol', 'upstreamModel', 'baseUrl', 'apiKey', 'clearApiKey', 'clearOverrides'].includes(key))
    || source.upstreamModel !== undefined && typeof source.upstreamModel !== 'string'
    || source.baseUrl !== undefined && typeof source.baseUrl !== 'string'
    || source.clearApiKey !== undefined && typeof source.clearApiKey !== 'boolean'
    || source.clearOverrides !== undefined && typeof source.clearOverrides !== 'boolean') throw new ImageGenerationChannelError('型号 API 配置字段无效');
  if (source.clearOverrides !== true && source.protocol !== 'gemini_native' && source.protocol !== 'openai_images') throw new ImageGenerationChannelError('请选择已支持的请求协议');
  const upstreamModel = typeof source.upstreamModel === 'string' ? source.upstreamModel.trim() : '';
  if (upstreamModel && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(upstreamModel)) throw new ImageGenerationChannelError('供应商型号名称无效');
  const baseUrl = typeof source.baseUrl === 'string' && source.baseUrl.trim() ? await validateManagedBaseUrl(source.baseUrl) : undefined;
  const key = typeof source.apiKey === 'string' ? source.apiKey.trim() : '';
  if (key.length > 500 || source.apiKey !== undefined && typeof source.apiKey !== 'string' || source.clearApiKey === true && key) throw new ImageGenerationChannelError('型号密钥输入无效');
  const settingKey = `${IMAGE_GENERATION_LEGACY_MODEL_API_SETTING_PREFIX}${channel}`;
  await prisma.$transaction(async tx => {
    const current = await readLegacyModelApiRegistry(channel, tx);
    if ((input.expectedRevision ?? null) !== current.revision) throw new ImageGenerationChannelError('型号 API 配置已被其他管理员修改，请重新读取；未覆盖新设置', 409, 'image_legacy_model_api_conflict');
    const global = await getImageGenerationApiSettings(tx, channel === 'banana' ? 'banana' : 'default');
    if (!isStudioImageGenerationProvider(global.provider)) throw new ImageGenerationChannelError('此原供应商使用独立接口合同，不能套用兼容生图协议；原配置未改', 409);
    const previousKey = current.models[model]?.apiKey;
    const apiKey = source.clearApiKey === true ? undefined : key || previousKey;
    const revision = randomUUID();
    const next: LegacyModelApiRegistry = { version: 1, revision, models: { ...current.models, [model]: {
      protocol: source.protocol as ImageGenerationChannelProtocol,
      ...(upstreamModel ? { upstreamModel } : {}), ...(baseUrl ? { baseUrl } : {}), ...(apiKey ? { apiKey } : {}),
    } } };
    if (source.clearOverrides === true) delete next.models[model];
    const row = await tx.platformSetting.findUnique({ where: { key: settingKey } });
    try {
      if (row) {
        const swapped = await tx.platformSetting.updateMany({ where: { key: settingKey, value_json: row.value_json }, data: { value_json: stringifyPrivateCredentials(settingKey, next), updated_by: updatedBy } });
        if (swapped.count !== 1) throw new ImageGenerationChannelError('型号配置已变化，请重新读取', 409, 'image_legacy_model_api_conflict');
      } else await tx.platformSetting.create({ data: { key: settingKey, value_json: stringifyPrivateCredentials(settingKey, next), updated_by: updatedBy } });
    } catch (error) {
      if (isRecord(error) && error.code === 'P2002') throw new ImageGenerationChannelError('型号配置已被其他管理员创建，请重新读取', 409, 'image_legacy_model_api_conflict');
      throw error;
    }
    await tx.operationLog.create({ data: { operator_id: updatedBy, action: 'image_generation_legacy_model_api_update', target_type: 'PlatformSetting', target_id: settingKey,
      detail: JSON.stringify({ model, revision, api_key_configured: Boolean(next.models[model]?.apiKey), protocol: next.models[model]?.protocol || null, overrides_cleared: source.clearOverrides === true }) } });
  });
  const channels = await getManagedImageGenerationChannels();
  return channels.find(item => item.id === channel)!;
}

function readPersistedCapability(raw: unknown, model: ImageStudioModel, legacyOpenAiGemini = false): ImageGenerationModelCapability | null {
  if (!isRecord(raw) || (raw.protocol !== 'gemini_native' && raw.protocol !== 'openai_images')) return null;
  // Protocol is an explicit per-model setting, independent of the local name.
  if (raw.upstreamModel !== undefined && (typeof raw.upstreamModel !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(raw.upstreamModel))) return null;
  if (raw.baseUrl !== undefined && (typeof raw.baseUrl !== 'string' || raw.baseUrl.length > 2048)) return null;
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') return null;
  const list = (value: unknown, allowed: readonly string[]) => {
    if (value === null || value === undefined) return null;
    if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && allowed.includes(item))) return null;
    return Array.from(new Set(value as string[]));
  };
  const qualities = list(raw.qualities, IMAGE_STUDIO_MODEL_QUALITY_OPTIONS[model]);
  const resolutions = list(raw.resolutions, IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS[model]);
  const ratios = list(raw.ratios, ['auto', ...STUDIO_RATIOS]);
  if ((raw.qualities !== undefined && raw.qualities !== null && qualities === null)
    || (raw.resolutions !== undefined && raw.resolutions !== null && resolutions === null)
    || (raw.ratios !== undefined && raw.ratios !== null && ratios === null)) return null;
  const maxReferences = raw.maxReferences === null || raw.maxReferences === undefined
    ? null
    : Number.isSafeInteger(raw.maxReferences) && Number(raw.maxReferences) >= 0 && Number(raw.maxReferences) <= MAX_REFERENCE_IMAGES
      ? Number(raw.maxReferences)
      : null;
  if (raw.maxReferences !== null && raw.maxReferences !== undefined && maxReferences === null) return null;
  const billingMode = raw.billingMode === 'fixed' || raw.billingMode === 'actual' ? raw.billingMode : null;
  if (raw.billingMode !== undefined && raw.billingMode !== null && billingMode === null) return null;
  const fixedPoints = raw.fixedPoints === null || raw.fixedPoints === undefined
    ? null
    : Number.isSafeInteger(raw.fixedPoints) && Number(raw.fixedPoints) >= 0
      ? Number(raw.fixedPoints)
      : null;
  if (raw.fixedPoints !== null && raw.fixedPoints !== undefined && fixedPoints === null) return null;
  return {
    enabled: raw.enabled === true,
    protocol: raw.protocol,
    ...(typeof raw.upstreamModel === 'string' ? { upstreamModel: raw.upstreamModel } : {}),
    ...(typeof raw.baseUrl === 'string' ? { baseUrl: raw.baseUrl } : {}),
    qualities,
    resolutions,
    ratios,
    maxReferences,
    billingMode,
    fixedPoints,
    billingSource: typeof raw.billingSource === 'string' ? raw.billingSource.slice(0, 80) : null,
  };
}

function parseManagedCapabilities(
  value: unknown,
  channelId: ImageGenerationChannelId,
  protocol: ImageGenerationResolvedProtocol,
): Partial<Record<ImageStudioModel, ImageGenerationModelCapability>> {
  if (!isRecord(value)) throw new ImageGenerationChannelError('型号配置格式无效，请重新读取后保存', 400, 'image_channel_invalid_capability');
  const input = isRecord(value) ? value : {};
  if (Object.keys(input).some(key => !IMAGE_STUDIO_MODELS.includes(key as ImageStudioModel))) {
    throw new ImageGenerationChannelError('供应商配置包含不支持的本站型号', 400, 'image_channel_model_not_allowed');
  }
  const output: Partial<Record<ImageStudioModel, ImageGenerationModelCapability>> = {};
  for (const model of IMAGE_STUDIO_MODELS) {
    const source = isRecord(input[model]) ? input[model] : {};
    if (source.upstreamModel !== undefined && source.upstreamModel !== null && typeof source.upstreamModel !== 'string'
      || source.baseUrl !== undefined && source.baseUrl !== null && typeof source.baseUrl !== 'string') {
      throw new ImageGenerationChannelError(`型号 ${model} 的地址或名称格式无效`, 400, 'image_channel_invalid_model_api');
    }
    if (source.protocol !== undefined && source.protocol !== 'gemini_native' && source.protocol !== 'openai_images') {
      throw new ImageGenerationChannelError(`型号 ${model} 的请求协议不受支持`, 400, 'image_channel_invalid_protocol');
    }
    const requestedProtocol = source.protocol === 'gemini_native' || source.protocol === 'openai_images' ? source.protocol : channelId === 'fluxport'
      ? FLUXPORT_PROTOCOL_BY_MODEL[model]
      : protocol === 'gemini_native' || protocol === 'openai_images' ? protocol : null;
    if (!requestedProtocol) continue;
    const protocolCompatible = requestedProtocol === 'gemini_native'
      ? GEMINI_CHANNEL_MODELS.has(model)
      : GPT_IMAGE_CHANNEL_MODELS.has(model);
    if (!protocolCompatible && source.protocol === undefined) continue;
    const upstreamModel = typeof source.upstreamModel === 'string' ? source.upstreamModel.trim() : '';
    if (upstreamModel && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(upstreamModel)) {
      throw new ImageGenerationChannelError(`型号 ${model} 的供应商型号名称无效`, 400, 'image_channel_invalid_upstream_model');
    }
    const parseCapabilityList = (field: 'qualities' | 'resolutions' | 'ratios', allowed: readonly string[]) => {
      const raw = source[field];
      if (raw === null || raw === undefined || typeof raw === 'string' && !raw.trim()) return null;
      const values = Array.isArray(raw)
        ? raw.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean)
        : typeof raw === 'string' ? raw.split(',').map(item => item.trim()).filter(Boolean) : null;
      if (!values) return null;
      const unique = Array.from(new Set(values));
      if (unique.some(item => !allowed.includes(item))) {
        throw new ImageGenerationChannelError(`型号 ${model} 的${field}包含当前应用不支持的值`, 400, 'image_channel_invalid_capability');
      }
      return unique;
    };
    const qualities = parseCapabilityList('qualities', IMAGE_STUDIO_MODEL_QUALITY_OPTIONS[model]);
    const resolutions = parseCapabilityList('resolutions', IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS[model]);
    const ratios = parseCapabilityList('ratios', ['auto', ...STUDIO_RATIOS]);
    const rawMaxReferences = source.maxReferences;
    const maxReferences = rawMaxReferences === null || rawMaxReferences === undefined || rawMaxReferences === ''
      ? null
      : Number.isSafeInteger(Number(rawMaxReferences)) && Number(rawMaxReferences) >= 0 && Number(rawMaxReferences) <= MAX_REFERENCE_IMAGES
        ? Number(rawMaxReferences)
        : null;
    if (rawMaxReferences !== null && rawMaxReferences !== undefined && rawMaxReferences !== '' && maxReferences === null) {
      throw new ImageGenerationChannelError(`型号 ${model} 的参考图上限必须是 0 到 ${MAX_REFERENCE_IMAGES} 的整数`, 400, 'image_channel_invalid_capability');
    }
    const billingMode = source.billingMode === 'fixed' || source.billingMode === 'actual' ? source.billingMode : null;
    const rawFixedPoints = source.fixedPoints;
    const fixedPoints = rawFixedPoints === null || rawFixedPoints === undefined || rawFixedPoints === ''
      ? null
      : Number.isSafeInteger(Number(rawFixedPoints)) && Number(rawFixedPoints) >= 0
        ? Number(rawFixedPoints)
        : null;
    if (rawFixedPoints !== null && rawFixedPoints !== undefined && rawFixedPoints !== '' && fixedPoints === null) {
      throw new ImageGenerationChannelError(`型号 ${model} 的固定点数必须是非负整数，0 表示明确免费`, 400, 'image_channel_invalid_price');
    }
    output[model] = {
      enabled: source.enabled === true,
      protocol: requestedProtocol,
      ...(upstreamModel ? { upstreamModel } : {}),
      ...(typeof source.baseUrl === 'string' && source.baseUrl.trim() ? { baseUrl: source.baseUrl.trim() } : {}),
      qualities,
      resolutions,
      ratios,
      maxReferences,
      billingMode,
      fixedPoints,
      billingSource: billingMode === 'fixed'
        ? 'admin_explicit_fixed_points'
        : billingMode === 'actual' ? 'same_scope_actual_billing_proof' : null,
    };
  }
  return output;
}

async function readManagedChannelRegistry(client: Prisma.TransactionClient | typeof prisma): Promise<ManagedChannelRegistry> {
  const row = await client.platformSetting.findUnique({ where: { key: IMAGE_GENERATION_CHANNEL_REGISTRY_SETTING_KEY } });
  if (!row) return { version: 1, channels: [emptyFluxPortRecord()] };
  let parsed: unknown;
  try { parsed = parsePrivateCredentials(row.key, row.value_json); } catch (error) { if (isPrivatePromptError(error)) throw error; throw new ImageGenerationChannelError('图片供应商注册表数据损坏，已停止使用配置', 500, 'image_channel_registry_invalid'); }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.channels)) {
    throw new ImageGenerationChannelError('图片供应商注册表版本无效，已停止使用配置', 500, 'image_channel_registry_invalid');
  }
  const channels: ManagedChannelRegistryRecord[] = [emptyFluxPortRecord()];
  const seen = new Set<string>(['fluxport']);
  for (const raw of parsed.channels) {
    if (!isRecord(raw)) throw new ImageGenerationChannelError('图片供应商注册表包含无效配置，已停止写入', 500, 'image_channel_registry_invalid');
    if (raw.id === 'fluxport') continue;
    if (!isDynamicImageChannelId(raw.id) || seen.has(raw.id)
      || typeof raw.label !== 'string' || typeof raw.supplierName !== 'string'
      || (raw.supplierKind !== 'musk' && raw.supplierKind !== 'other')
      || (raw.protocol !== 'gemini_native' && raw.protocol !== 'openai_images')
      || typeof raw.baseUrl !== 'string'
      || typeof raw.enabled !== 'boolean' || typeof raw.deleted !== 'boolean') {
      throw new ImageGenerationChannelError('图片供应商注册表包含无效配置，已停止写入', 500, 'image_channel_registry_invalid');
    }
    const modelCapabilities: Partial<Record<ImageStudioModel, ImageGenerationModelCapability>> = {};
    if (isRecord(raw.modelCapabilities)) {
      if (Object.keys(raw.modelCapabilities).some(key => !IMAGE_STUDIO_MODELS.includes(key as ImageStudioModel))) {
        throw new ImageGenerationChannelError('图片供应商包含未知型号能力，已停止写入', 500, 'image_channel_registry_invalid');
      }
      for (const model of IMAGE_STUDIO_MODELS) {
        const capability = readPersistedCapability(raw.modelCapabilities[model], model);
        if (capability) modelCapabilities[model] = capability;
        else if (Object.prototype.hasOwnProperty.call(raw.modelCapabilities, model)) {
          throw new ImageGenerationChannelError('图片供应商能力数据损坏，已停止写入', 500, 'image_channel_registry_invalid');
        }
      }
    } else if (raw.modelCapabilities !== undefined) {
      throw new ImageGenerationChannelError('图片供应商能力数据损坏，已停止写入', 500, 'image_channel_registry_invalid');
    }
    const configRevision = raw.configRevision === null ? null
      : typeof raw.configRevision === 'string' && /^[0-9a-f-]{36}$/i.test(raw.configRevision)
        ? raw.configRevision : null;
    if (raw.configRevision !== undefined && configRevision === null) {
      throw new ImageGenerationChannelError('图片供应商修订数据损坏，已停止写入', 500, 'image_channel_registry_invalid');
    }
    channels.push({
      id: raw.id,
      label: raw.label.slice(0, 120),
      supplierName: raw.supplierName.slice(0, 120),
      supplierKind: raw.supplierKind,
      protocol: raw.protocol,
      baseUrl: raw.baseUrl,
      enabled: raw.enabled === true,
      deleted: raw.deleted === true,
      configRevision,
      modelCapabilities,
    });
    seen.add(raw.id);
  }
  const storedFluxPorts = parsed.channels.filter((item: unknown) => isRecord(item) && item.id === 'fluxport');
  if (storedFluxPorts.length > 1) throw new ImageGenerationChannelError('FluxPort 预设重复，已停止写入', 500, 'image_channel_registry_invalid');
  const storedFluxPort = storedFluxPorts[0];
  if (isRecord(storedFluxPort)) {
    if (storedFluxPort.enabled !== undefined && typeof storedFluxPort.enabled !== 'boolean') {
      throw new ImageGenerationChannelError('FluxPort 状态数据损坏，已停止写入', 500, 'image_channel_registry_invalid');
    }
    const base = emptyFluxPortRecord();
    const capabilities: Partial<Record<ImageStudioModel, ImageGenerationModelCapability>> = {};
    if (isRecord(storedFluxPort.modelCapabilities)) {
      if (Object.keys(storedFluxPort.modelCapabilities).some(key => !IMAGE_STUDIO_MODELS.includes(key as ImageStudioModel))) {
        throw new ImageGenerationChannelError('FluxPort 包含未知型号能力，已停止写入', 500, 'image_channel_registry_invalid');
      }
      for (const model of IMAGE_STUDIO_MODELS) {
        const capability = readPersistedCapability(storedFluxPort.modelCapabilities[model], model);
        if (capability) capabilities[model] = capability;
        else if (Object.prototype.hasOwnProperty.call(storedFluxPort.modelCapabilities, model)) {
          throw new ImageGenerationChannelError('FluxPort 能力数据损坏，已停止写入', 500, 'image_channel_registry_invalid');
        }
      }
    } else if (storedFluxPort.modelCapabilities !== undefined) {
      throw new ImageGenerationChannelError('FluxPort 能力数据损坏，已停止写入', 500, 'image_channel_registry_invalid');
    }
    const fluxRevision = storedFluxPort.configRevision === null || storedFluxPort.configRevision === undefined
      ? null
      : typeof storedFluxPort.configRevision === 'string' && /^[0-9a-f-]{36}$/i.test(storedFluxPort.configRevision)
        ? storedFluxPort.configRevision : null;
    if (storedFluxPort.configRevision !== null && storedFluxPort.configRevision !== undefined && fluxRevision === null) {
      throw new ImageGenerationChannelError('FluxPort 修订数据损坏，已停止写入', 500, 'image_channel_registry_invalid');
    }
    channels[0] = {
      ...base,
      label: typeof storedFluxPort.label === 'string' ? storedFluxPort.label.slice(0, 120) : base.label,
      enabled: storedFluxPort.enabled === true,
      deleted: false,
      configRevision: fluxRevision,
      modelCapabilities: Object.keys(capabilities).length ? capabilities : base.modelCapabilities,
    };
  }
  return { version: 1, channels };
}

function privateVersionKey(channelId: string, revision: string) {
  return `${IMAGE_GENERATION_CHANNEL_VERSION_PREFIX}${channelId}:${revision}`;
}

async function writePrivateChannelVersion(
  client: Prisma.TransactionClient | typeof prisma,
  version: PrivateImageGenerationChannelVersion,
  updatedBy: string,
) {
  await client.platformSetting.create({
    data: {
      key: privateVersionKey(version.channelId, version.configRevision),
      value_json: stringifyPrivateCredentials(privateVersionKey(version.channelId, version.configRevision), version),
      updated_by: updatedBy,
    },
  });
}

async function readPrivateChannelVersion(
  client: Prisma.TransactionClient | typeof prisma,
  channelId: string,
  revision: string,
): Promise<PrivateImageGenerationChannelVersion> {
  const row = await client.platformSetting.findUnique({ where: { key: privateVersionKey(channelId, revision) } });
  if (!row) throw new ImageGenerationChannelError('图片供应商配置修订不存在，不能替换为当前配置', 404, 'image_channel_revision_not_found');
  let parsed: unknown;
  try { parsed = parsePrivateCredentials(row.key, row.value_json); } catch (error) { if (isPrivatePromptError(error)) throw error; throw new ImageGenerationChannelError('图片供应商配置修订损坏，不能继续执行', 500, 'image_channel_revision_invalid'); }
  if (!isRecord(parsed) || parsed.version !== 1 || parsed.channelId !== channelId || parsed.configRevision !== revision
    || !isRecord(parsed.settings) || !isRecord(parsed.modelCapabilities)) {
    throw new ImageGenerationChannelError('图片供应商配置修订与任务引用不匹配', 500, 'image_channel_revision_invalid');
  }
  const storedProvider = parsed.settings.provider;
  const knownProvider = storedProvider === 'musk' || storedProvider === 'ai_media_vip' || storedProvider === 'seedream'
    || storedProvider === 'fluxport' || storedProvider === 'managed';
  if (!knownProvider || (parsed.protocol !== 'gemini_native' && parsed.protocol !== 'openai_images' && parsed.protocol !== 'mixed' && parsed.protocol !== 'legacy')
    || !['fluxport', 'musk', 'other', 'legacy'].includes(String(parsed.supplierKind))) {
    throw new ImageGenerationChannelError('图片供应商修订包含无效协议或供应商信息', 500, 'image_channel_revision_invalid');
  }
  if (typeof parsed.settings.base_url !== 'string' || (parsed.settings.api_key !== null && parsed.settings.api_key !== undefined
    && (typeof parsed.settings.api_key !== 'string' || parsed.settings.api_key.length > 500))) {
    throw new ImageGenerationChannelError('图片供应商修订的地址或凭据格式无效', 500, 'image_channel_revision_invalid');
  }
  if (parsed.billingIntentRevision !== undefined
    && (typeof parsed.billingIntentRevision !== 'number'
      || !Number.isSafeInteger(parsed.billingIntentRevision) || parsed.billingIntentRevision < 0)) {
    throw new ImageGenerationChannelError('图片供应商修订的计费意图版本无效', 500, 'image_channel_revision_invalid');
  }
  if (parsed.modelOverrideRevision !== undefined && parsed.modelOverrideRevision !== null
    && (typeof parsed.modelOverrideRevision !== 'string' || !/^[0-9a-f-]{36}$/i.test(parsed.modelOverrideRevision))
    || parsed.selectedModel !== undefined && !IMAGE_STUDIO_MODELS.includes(parsed.selectedModel as ImageStudioModel)) {
    throw new ImageGenerationChannelError('原供应商型号修订信息无效', 500, 'image_channel_revision_invalid');
  }
  const rawProvider = knownProvider ? storedProvider : 'musk';
  const managedProvider = rawProvider === 'fluxport' || rawProvider === 'managed';
  const normalizedSettings = normalizeImageGenerationApiSettings({
    ...parsed.settings,
    provider: managedProvider ? 'musk' : rawProvider,
  });
  const settings = {
    ...normalizedSettings,
    provider: managedProvider ? rawProvider as 'fluxport' | 'managed' : normalizedSettings.provider,
    base_url: typeof parsed.settings.base_url === 'string' ? parsed.settings.base_url : normalizedSettings.base_url,
    api_key: typeof parsed.settings.api_key === 'string' && parsed.settings.api_key.length <= 500 ? parsed.settings.api_key : null,
    supports_async_task: false,
  } as ImageGenerationApiSettings;
  const modelCapabilities: Partial<Record<ImageStudioModel, ImageGenerationModelCapability>> = {};
  if (Object.keys(parsed.modelCapabilities).some(key => !IMAGE_STUDIO_MODELS.includes(key as ImageStudioModel))) {
    throw new ImageGenerationChannelError('图片供应商修订包含未知型号能力', 500, 'image_channel_revision_invalid');
  }
  for (const model of IMAGE_STUDIO_MODELS) {
    const capability = readPersistedCapability(parsed.modelCapabilities[model], model,
      parsed.managedChannel !== true && parsed.settings.provider === 'ai_media_vip');
    if (capability) modelCapabilities[model] = capability;
    else if (Object.prototype.hasOwnProperty.call(parsed.modelCapabilities, model)) {
      throw new ImageGenerationChannelError('图片供应商修订能力数据损坏', 500, 'image_channel_revision_invalid');
    }
  }
  const modelApiKeys: Partial<Record<ImageStudioModel, string>> = {};
  if (parsed.modelApiKeys !== undefined) {
    if (!isRecord(parsed.modelApiKeys) || Object.entries(parsed.modelApiKeys).some(([model, key]) =>
      !IMAGE_STUDIO_MODELS.includes(model as ImageStudioModel) || typeof key !== 'string' || !key.trim() || key.length > 500)) {
      throw new ImageGenerationChannelError('图片供应商型号凭据修订损坏，不能继续执行', 500, 'image_channel_revision_invalid');
    }
    for (const model of IMAGE_STUDIO_MODELS) {
      const key = parsed.modelApiKeys[model];
      if (typeof key === 'string') modelApiKeys[model] = key;
    }
  }
  return {
    version: 1,
    channelId,
    configRevision: revision,
    label: typeof parsed.label === 'string' ? parsed.label.slice(0, 120) : '图片供应商',
    supplierName: typeof parsed.supplierName === 'string' ? parsed.supplierName : '未知供应商',
    supplierKind: parsed.supplierKind === 'fluxport' || parsed.supplierKind === 'musk' || parsed.supplierKind === 'other' || parsed.supplierKind === 'legacy'
      ? parsed.supplierKind : 'other',
    sourceChannelId: parsed.sourceChannelId === 'shared' || parsed.sourceChannelId === 'banana' ? parsed.sourceChannelId : undefined,
    sourceFingerprint: typeof parsed.sourceFingerprint === 'string' ? parsed.sourceFingerprint : undefined,
    billingIntentRevision: typeof parsed.billingIntentRevision === 'number' && Number.isSafeInteger(parsed.billingIntentRevision)
      ? parsed.billingIntentRevision : undefined,
    ...(Object.prototype.hasOwnProperty.call(parsed, 'modelOverrideRevision') ? { modelOverrideRevision: parsed.modelOverrideRevision as string | null } : {}),
    selectedModel: IMAGE_STUDIO_MODELS.includes(parsed.selectedModel as ImageStudioModel) ? parsed.selectedModel as ImageStudioModel : undefined,
    protocol: parsed.protocol === 'gemini_native' || parsed.protocol === 'openai_images' || parsed.protocol === 'mixed'
      ? parsed.protocol : 'legacy',
    managedChannel: parsed.managedChannel === true,
    explicitModelApi: parsed.explicitModelApi === true,
    settings,
    modelCapabilities,
    modelApiKeys,
    deleted: parsed.deleted === true,
  };
}

function providerSupplierName(provider: ImageGenerationProvider): string | null {
  if (provider === 'musk') return 'MuskAPI';
  if (provider === 'ai_media_vip') return 'AI Media VIP';
  if (provider === 'seedream') return 'Seedream';
  if (provider === 'fluxport') return 'FluxPort';
  return null;
}

function legacyProtocol(provider: ImageGenerationProvider, model: string): ImageGenerationResolvedProtocol {
  if (provider === 'ai_media_vip') return 'openai_images';
  if (provider === 'musk') return isGeminiImageModel(model) ? 'gemini_native' : 'openai_images';
  return 'legacy';
}

function legacyStudioProtocol(provider: ImageGenerationProvider, model: ImageStudioModel): ImageGenerationChannelProtocol | null {
  if (provider === 'seedream') return null;
  if (provider === 'musk' && GEMINI_CHANNEL_MODELS.has(model)) return 'gemini_native';
  if (provider === 'musk' || provider === 'ai_media_vip') return 'openai_images';
  return null;
}

function legacyModelCapabilities(
  settings: ImageGenerationApiSettings,
  channelId: 'original' | 'shared' | 'banana',
  prices?: Record<ImageStudioModel, number | null>,
): Partial<Record<ImageStudioModel, ImageGenerationModelCapability>> {
  const capabilities: Partial<Record<ImageStudioModel, ImageGenerationModelCapability>> = {};
  for (const model of IMAGE_STUDIO_MODELS) {
    // An older legacy configuration never implicitly enables a newly introduced model.
    if (model === 'gemini-nano-banana-2.1') {
      capabilities[model] = blankCapability('gemini_native');
      continue;
    }
    // Original keeps the historical model routing and its capability contract.
    // Selectable legacy slots expose only combinations implemented by the Studio adapter.
    const protocol: ImageGenerationChannelProtocol | null = channelId === 'original'
      ? legacyProtocol(settings.provider, model) === 'gemini_native' ? 'gemini_native' : 'openai_images'
      : legacyStudioProtocol(settings.provider, model);
    if (!protocol) continue;
    const legacyPrice = prices?.[model];
    const fixedPoints = Number.isSafeInteger(legacyPrice) && Number(legacyPrice) >= 0 ? Number(legacyPrice) : null;
    capabilities[model] = {
      enabled: true,
      protocol,
      qualities: IMAGE_STUDIO_MODEL_QUALITY_OPTIONS[model],
      resolutions: IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS[model],
      ratios: channelId === 'original' ? null : ['auto', ...STUDIO_RATIOS.filter(ratio => ratio !== '4:1' || supportsStudioFourToOne(model, settings.provider))],
      maxReferences: channelId === 'original' ? null : settings.supports_image_to_image ? MAX_REFERENCE_IMAGES : 0,
      billingMode: channelId === 'original' ? null : 'fixed',
      fixedPoints: channelId === 'original' ? null : fixedPoints,
      billingSource: 'legacy_image_studio_contract',
    };
  }
  return capabilities;
}

function resolveLegacySettings(settings: ImageGenerationApiSettings, model: string, channelId: 'original' | 'shared' | 'banana',
  prices?: Record<ImageStudioModel, number | null>): ImageGenerationResolvedSettings {
  const provider = settings.provider;
  return {
    ...settings,
    channelId,
    configRevision: 'legacy-current',
    supplierName: settings.api_key ? providerSupplierName(provider) || '未知供应商' : '未知供应商',
    supplierKind: 'legacy',
    protocol: channelId === 'original' ? 'legacy' : legacyProtocol(provider, model),
    modelCapabilities: legacyModelCapabilities(settings, channelId, prices),
    managedChannel: false,
    default_model: model,
  };
}

function modelCapabilityMissingRequirements(capability: ImageGenerationModelCapability | undefined, model: string) {
  if (!capability || !capability.enabled) return ['该型号尚未加入可用白名单'];
  const allowsUnconfirmed = allowsUnconfirmedGeminiProParameters(model, capability);
  const missing: string[] = [];
  if (capability.qualities === null ? !allowsUnconfirmed : capability.qualities.length === 0) missing.push('尚未确认支持的图片质量');
  if (capability.resolutions === null ? !allowsUnconfirmed : capability.resolutions.length === 0) missing.push('尚未确认支持的分辨率');
  if (capability.maxReferences === null && !allowsUnconfirmed) missing.push('尚未确认参考图上限');
  if (!capability.billingMode) missing.push('尚未设置计费方式');
  if (capability.billingMode === 'fixed' && capability.fixedPoints === null) missing.push('固定点数未填写，明确免费时请填写 0');
  return missing;
}

function modelCapabilityCompleteness(capability: ImageGenerationModelCapability | undefined, model: string) {
  return modelCapabilityMissingRequirements(capability, model)[0] || null;
}

export function isMuskImageGenerationChannel(settings: ImageGenerationApiSettings) {
  const candidate = settings as ImageGenerationResolvedSettings;
  return settings.provider === 'musk'
    && Boolean(settings.api_key)
    && (candidate.supplierKind === undefined || candidate.supplierKind === 'musk' || candidate.supplierKind === 'legacy');
}

async function isActualBillingReady(
  settings: ImageGenerationApiSettings,
  model: string,
  client: Prisma.TransactionClient | typeof prisma,
  strictPricing = false,
) {
  if ((settings as ImageGenerationResolvedSettings).modelCapabilities) {
    const capability = (settings as ImageGenerationResolvedSettings).modelCapabilities[model as ImageStudioModel];
    // Existing bill proofs identify the local model exactly, not an arbitrary alias.
    if (capability?.upstreamModel && capability.upstreamModel !== model) return false;
    settings = resolveImageGenerationModelSettings(settings as ImageGenerationResolvedSettings, model);
  }
  if (!isMuskImageGenerationChannel(settings)) return false;
  try {
    if (new URL(settings.base_url).origin !== 'https://api.muskapis.com') return false;
    const [{ imageBillingScope }, { imageBillingReady }] = await Promise.all([
      import('@/lib/image-studio/billing-scope'),
      import('@/lib/image-studio/billing-readiness'),
    ]);
    const scope = imageBillingScope(settings);
    return (await imageBillingReady(scope, model, client)).ready;
  } catch (error) {
    if (strictPricing) throw error;
    return false;
  }
}

export async function readPricingImageActualReadiness(settings: ImageGenerationApiSettings, model: string,
  client: Prisma.TransactionClient | typeof prisma = prisma) {
  return isActualBillingReady(settings, model, client, true);
}

async function legacyBillingIntentState(
  settings: ImageGenerationApiSettings,
  model: string,
  client: Prisma.TransactionClient | typeof prisma,
  strictPricing = false,
) {
  if ((settings as ImageGenerationResolvedSettings).modelCapabilities) {
    const resolved = settings as ImageGenerationResolvedSettings;
    const capability = resolved.modelCapabilities[model as ImageStudioModel];
    settings = resolveImageGenerationModelSettings(resolved, model);
    if (capability?.upstreamModel && capability.upstreamModel !== model) {
      const { imageBillingIntent } = await import('@/lib/image-studio/billing-readiness');
      const intent = await imageBillingIntent(client);
      return { selected: intent.enabled && intent.enabledModels.includes(model), revision: intent.revision, quoteReady: false };
    }
  }
  const { imageBillingIntent, imageBillingReady } = await import('@/lib/image-studio/billing-readiness');
  const intent = await imageBillingIntent(client);
  const selected = intent.enabled && intent.enabledModels.includes(model);
  if (!selected) return { selected: false, revision: intent.revision, quoteReady: false };
  if (!isMuskImageGenerationChannel(settings)) return { selected: true, revision: intent.revision, quoteReady: false };
  try {
    if (new URL(settings.base_url).origin !== 'https://api.muskapis.com') {
      return { selected: true, revision: intent.revision, quoteReady: false };
    }
  } catch (error) {
    if (strictPricing) throw error;
    return { selected: true, revision: intent.revision, quoteReady: false };
  }
  const { imageBillingScope } = await import('@/lib/image-studio/billing-scope');
  const readiness = await imageBillingReady(imageBillingScope(settings), model, client);
  return { selected: true, revision: intent.revision, quoteReady: readiness.ready };
}

async function hydrateActualBilling(
  settings: ImageGenerationResolvedSettings,
  client: Prisma.TransactionClient | typeof prisma,
  strictPricing = false,
): Promise<ImageGenerationResolvedSettings> {
  const modelCapabilities = { ...settings.modelCapabilities };
  for (const model of IMAGE_STUDIO_MODELS) {
    const capability = modelCapabilities[model];
    if (capability?.billingMode !== 'actual') continue;
    const legacyAlias = settings.channelId === 'shared' || settings.channelId === 'banana';
    modelCapabilities[model] = {
      ...capability,
      actualQuoteRequired: legacyAlias
        ? (await legacyBillingIntentState(settings, model, client, strictPricing)).quoteReady
        : await isActualBillingReady(settings, model, client, strictPricing),
    };
  }
  return { ...settings, modelCapabilities };
}

async function modelDisabledReason(
  settings: ImageGenerationResolvedSettings,
  model: ImageStudioModel,
  client: Prisma.TransactionClient | typeof prisma,
  strictPricing = false,
) {
  settings = resolveImageGenerationModelSettings(settings, model);
  if (settings.deleted) return '该配置已归档，只保留已受理任务查询与结算';
  if (!settings.enabled) return '通道已停用';
  if (!settings.api_key) return '尚未配置 API Key';
  const capability = settings.modelCapabilities[model];
  const incomplete = modelCapabilityCompleteness(capability, model);
  if (incomplete) return incomplete;
  if (capability?.billingMode === 'actual') {
    if (capability.upstreamModel && capability.upstreamModel !== model) return '供应商型号名称与本站型号不同，尚无对应的精确账单证明；请使用已确认的固定点数';
    if (!isMuskImageGenerationChannel(settings)) return '实际计费仅适用于已确认的 Musk 供应商与同一 API Key';
    if (capability.actualQuoteRequired !== true || !await isActualBillingReady(settings, model, client, strictPricing)) {
      return '该 API Key 与型号暂无有效的精确账单证明，实际计费未就绪';
    }
  }
  return null;
}

function managedSettingsFromVersion(version: PrivateImageGenerationChannelVersion): ImageGenerationResolvedSettings {
  return {
    ...version.settings,
    channelId: version.channelId,
    configRevision: version.configRevision,
    supplierName: version.supplierName,
    supplierKind: version.supplierKind,
    protocol: version.protocol,
    modelCapabilities: version.modelCapabilities,
    modelApiKeys: version.modelApiKeys,
    managedChannel: version.managedChannel,
    explicitModelApi: version.explicitModelApi,
    label: version.label,
    deleted: version.deleted === true,
  } as ImageGenerationResolvedSettings;
}

function emptyFluxPortSettings(): ImageGenerationResolvedSettings {
  const record = emptyFluxPortRecord();
  return {
    ...DEFAULT_IMAGE_GENERATION_API_SETTINGS,
    enabled: false,
    provider: 'fluxport',
    base_url: FLUXPORT_IMAGE_GENERATION_BASE_URL,
    api_key: null,
    supports_async_task: false,
    channelId: 'fluxport',
    configRevision: 'unconfigured',
    supplierName: 'FluxPort',
    supplierKind: 'fluxport',
    protocol: 'mixed',
    modelCapabilities: record.modelCapabilities,
    managedChannel: true,
    deleted: false,
  } as ImageGenerationResolvedSettings;
}

async function resolveCurrentManagedSettings(record: ManagedChannelRegistryRecord, client: Prisma.TransactionClient | typeof prisma) {
  if (!record.configRevision) {
    if (record.id === 'fluxport') return { ...emptyFluxPortSettings(), enabled: record.enabled, modelCapabilities: record.modelCapabilities };
    return emptyManagedSettings(record);
  }
  const version = await readPrivateChannelVersion(client, record.id, record.configRevision);
  return { ...managedSettingsFromVersion(version), enabled: record.enabled, deleted: record.deleted };
}

function emptyManagedSettings(record: ManagedChannelRegistryRecord): ImageGenerationResolvedSettings {
  return {
    ...DEFAULT_IMAGE_GENERATION_API_SETTINGS,
    enabled: false,
    provider: record.supplierKind === 'musk' ? 'musk' : 'managed',
    base_url: record.baseUrl,
    api_key: null,
    supports_async_task: false,
    channelId: record.id,
    configRevision: 'unconfigured',
    supplierName: record.supplierName,
    supplierKind: record.supplierKind,
    protocol: record.protocol === 'legacy' ? 'openai_images' : record.protocol,
    modelCapabilities: record.modelCapabilities,
    managedChannel: true,
    deleted: record.deleted,
  } as ImageGenerationResolvedSettings;
}

export async function captureImageGenerationRequestChannel(model: string, quality: unknown,
  requestedChannelId?: string | null, tx: Prisma.TransactionClient | typeof prisma = prisma) {
  const route = await resolveImageGenerationRequestRoute(model, quality, requestedChannelId, tx);
  return route.channelId ? captureImageGenerationChannel(model, route.channelId, tx, route.qualityRoute) : undefined;
}

export async function captureImageGenerationChannel(
  model: string,
  channelId: ImageGenerationChannelId = 'original',
  tx: Prisma.TransactionClient | typeof prisma = prisma,
  qualityRoute?: ImageQualityRouteSnapshot,
): Promise<ImageGenerationChannelSnapshot> {
  assertImageGenerationChannelId(channelId);
  if (!IMAGE_STUDIO_MODELS.includes(model as ImageStudioModel)) {
    throw new ImageGenerationChannelError('所选图片型号不在允许列表中', 400, 'image_channel_model_not_allowed');
  }
  if (channelId !== 'original' && channelId !== 'shared' && channelId !== 'banana') {
    const channels = await getImageGenerationChannels(tx);
    let current = selectImageGenerationSettings(channels, model, channelId);
    if (qualityRoute) {
      const { withImagePricing } = await import('@/lib/pricing/image');
      current = (await withImagePricing(current, model, tx, undefined, { quality: qualityRoute.quality })).settings;
    }
    if (!current.configRevision || current.configRevision === 'unconfigured' || current.deleted || !current.enabled || !current.api_key) {
      throw new ImageGenerationChannelError('该图片供应商尚未配置或已停用，不能提交新任务', 409, 'image_channel_not_available');
    }
    const validation = validateImageGenerationChannel(current, { model });
    if (!validation.ok && validation.code !== 'image_channel_actual_billing_requires_async_quote') {
      throw new ImageGenerationChannelError(validation.error, 409, validation.code);
    }
    return { channelId, configRevision: current.configRevision, ...(qualityRoute ? { qualityRoute } : {}) };
  }

  const sourceChannelId = channelId === 'original' ? (isGeminiImageModel(model) ? 'banana' : 'shared') : channelId;
  const settings = await getImageGenerationApiSettings(tx, sourceChannelId === 'banana' ? 'banana' : 'default');
  const modelApis = await readLegacyModelApiRegistry(sourceChannelId, tx);
  const studioSettings = await getImageStudioSettings(tx).catch(() => null);
  const prices = studioSettings?.prices || Object.fromEntries(IMAGE_STUDIO_MODELS.map(item => [item, null])) as Record<ImageStudioModel, number | null>;
  const resolved = channelId === 'original' ? resolveLegacySettings(settings, model, channelId, prices)
    : applyLegacyModelApis(resolveLegacySettings(settings, model, channelId, prices), modelApis, model);
  if (channelId !== 'original' && !isImageGenerationApiReady(resolved)) {
    throw new ImageGenerationChannelError('所选图片接口未启用或配置不完整', 409, 'image_channel_not_available');
  }
  if (channelId !== 'original') {
    let capability = resolved.modelCapabilities[model as ImageStudioModel];
    if (!capability?.enabled) {
      throw new ImageGenerationChannelError('当前旧接口协议未确认支持该型号，未创建报价', 409, 'image_channel_capability_unknown');
    }
    const billingIntent = await legacyBillingIntentState(resolved, model, tx);
    if (billingIntent.selected) {
      capability = {
        ...capability,
        billingMode: 'actual',
        billingSource: 'same_scope_actual_billing_proof',
        actualQuoteRequired: billingIntent.quoteReady,
      };
      resolved.modelCapabilities = { ...resolved.modelCapabilities, [model]: capability };
    }
    const reason = await modelDisabledReason(resolved, model as ImageStudioModel, tx);
    if (reason) throw new ImageGenerationChannelError(reason, 409, 'image_channel_not_ready');
    const configRevision = randomUUID();
    const version: PrivateImageGenerationChannelVersion = {
      version: 1,
      channelId,
      configRevision,
      label: channelId === 'shared' ? '共享接口' : 'Banana 专用接口',
      supplierName: resolved.api_key ? providerSupplierName(settings.provider) || '未知供应商' : '未知供应商',
      supplierKind: 'legacy',
      sourceChannelId,
      sourceFingerprint: createHash('sha256').update(JSON.stringify(settings)).digest('hex'),
      modelOverrideRevision: modelApis.revision,
      selectedModel: model as ImageStudioModel,
      billingIntentRevision: billingIntent.revision,
      protocol: capability.protocol,
      managedChannel: false,
      explicitModelApi: resolved.explicitModelApi,
      settings,
      modelCapabilities: resolved.modelCapabilities,
      modelApiKeys: resolved.modelApiKeys,
    };
    await writePrivateChannelVersion(tx, version, 'image-generation-task');
    return { channelId, configRevision };
  }
  const configRevision = randomUUID();
  const version: PrivateImageGenerationChannelVersion = {
    version: 1,
    channelId,
    configRevision,
    label: channelId === 'original' ? '原接口' : channelId === 'shared' ? '共享接口' : 'Banana 专用接口',
    supplierName: settings.api_key ? providerSupplierName(settings.provider) || '未知供应商' : '未知供应商',
    supplierKind: 'legacy',
    sourceChannelId,
    sourceFingerprint: createHash('sha256').update(JSON.stringify(settings)).digest('hex'),
    modelOverrideRevision: modelApis.revision,
    selectedModel: model as ImageStudioModel,
    protocol: channelId === 'original' ? 'legacy' : legacyProtocol(settings.provider, model),
    managedChannel: false,
    settings,
    modelCapabilities: resolved.modelCapabilities,
  };
  await writePrivateChannelVersion(tx, version, 'image-generation-task');
  return { channelId, configRevision };
}

export async function resolveImageGenerationChannelSnapshot(
  snapshot: ImageGenerationChannelSnapshot,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
  forSubmission = false,
  model?: string,
): Promise<ImageGenerationResolvedSettings> {
  assertImageGenerationChannelId(snapshot.channelId);
  if (!/^[0-9a-f-]{36}$/i.test(snapshot.configRevision)) {
    throw new ImageGenerationChannelError('图片供应商配置修订无效', 400, 'image_channel_invalid_revision');
  }
  const version = await readPrivateChannelVersion(tx, snapshot.channelId, snapshot.configRevision);
  const settings = managedSettingsFromVersion(version);
  if (forSubmission) {
    if (snapshot.qualityRoute) {
      const route = await resolveImageGenerationRequestRoute(model || snapshot.qualityRoute.model,
        snapshot.qualityRoute.quality, snapshot.channelId, tx);
      if (route.qualityRoute?.revision !== snapshot.qualityRoute.revision) {
        throw new ImageGenerationChannelError('图片质量路由已变化，请重新报价；未使用旧路由提交', 409, 'image_quality_route_stale');
      }
    }
    if (snapshot.channelId === 'original' || snapshot.channelId === 'shared' || snapshot.channelId === 'banana') {
      if (!version.sourceChannelId || !version.sourceFingerprint) {
        throw new ImageGenerationChannelError('原接口快照缺少报价版本信息', 409, 'image_channel_quote_snapshot_invalid');
      }
      const current = await getImageGenerationApiSettings(tx, version.sourceChannelId === 'banana' ? 'banana' : 'default');
      const modelApis = await readLegacyModelApiRegistry(version.sourceChannelId, tx);
      if (version.selectedModel && model && version.selectedModel !== model) throw new ImageGenerationChannelError('报价型号与任务不匹配，请重新报价', 409, 'image_channel_quote_model_mismatch');
      if (Object.prototype.hasOwnProperty.call(version, 'modelOverrideRevision')
        ? version.modelOverrideRevision !== modelApis.revision
        : modelApis.revision !== null) {
        throw new ImageGenerationChannelError('此供应商型号 API 配置已变化，请重新报价；未使用新配置替换原快照', 409, 'image_channel_quote_stale');
      }
      if (snapshot.channelId !== 'original' && version.billingIntentRevision !== undefined) {
        const { imageBillingIntent } = await import('@/lib/image-studio/billing-readiness');
        const currentIntent = await imageBillingIntent(tx);
        if (currentIntent.revision !== version.billingIntentRevision) {
          throw new ImageGenerationChannelError('实际计费意图已变化，请重新获取报价后再提交', 409, 'image_channel_quote_stale');
        }
      }
      const fingerprint = createHash('sha256').update(JSON.stringify(current)).digest('hex');
      if (fingerprint !== version.sourceFingerprint) {
        throw new ImageGenerationChannelError('原接口配置已变化，请重新获取报价后再提交', 409, 'image_channel_quote_stale');
      }
      if (snapshot.channelId !== 'original' && !isImageGenerationApiReady(model ? resolveImageGenerationModelSettings(settings, model) : settings)) {
        throw new ImageGenerationChannelError('所选图片接口已停用或配置不完整，请重新选择', 409, 'image_channel_not_available');
      }
      const hydrated = await hydrateActualBilling(settings, tx);
      return model ? resolveImageGenerationModelSettings(hydrated, model) : hydrated;
    }
    const registry = await readManagedChannelRegistry(tx);
    const current = registry.channels.find(item => item.id === snapshot.channelId);
    if (!current || current.deleted || !current.enabled || current.configRevision !== snapshot.configRevision) {
      throw new ImageGenerationChannelError('图片供应商配置已停用或修订过期，请重新报价', 409, 'image_channel_revision_stale');
    }
  }
  const hydrated = await hydrateActualBilling(settings, tx);
  return model ? resolveImageGenerationModelSettings(hydrated, model) : hydrated;
}

/** Live admission switch only; never substitutes live credentials for a frozen version. */
export async function assertImageGenerationChannelDispatchOpen(
  snapshot: ImageGenerationChannelSnapshot,
  client: Prisma.TransactionClient | typeof prisma = prisma,
) {
  if (snapshot.channelId === 'original') return;
  if (snapshot.channelId === 'shared' || snapshot.channelId === 'banana') {
    const current = await getImageGenerationApiSettings(client, snapshot.channelId === 'banana' ? 'banana' : 'default');
    const modelApis = await readLegacyModelApiRegistry(snapshot.channelId, client);
    if (current.enabled && current.base_url && (current.api_key || Object.values(modelApis.models).some(api => api?.apiKey))) return;
  } else {
    const registry = await readManagedChannelRegistry(client);
    const current = registry.channels.find(item => item.id === snapshot.channelId);
    if (current?.enabled && !current.deleted && current.configRevision) return;
  }
  throw new ImageGenerationChannelError('生成时供应商已停用或归档；未请求上游，原任务和预留保留。恢复该配置后按原修订继续，或取消未受理任务。', 409, 'image_channel_dispatch_paused');
}

export function validateImageGenerationChannel(
  settings: ImageGenerationResolvedSettings,
  args: { model: string; quality?: string; resolution?: string; ratio?: string; referenceCount?: number },
  legacyRatioContract = false,
): { ok: true; capability: ImageGenerationModelCapability } | { ok: false; code: string; error: string } {
  const model = args.model as ImageStudioModel;
  if (!IMAGE_STUDIO_MODELS.includes(model)) return { ok: false, code: 'image_channel_model_not_allowed', error: '所选图片型号不在允许列表中' };
  if (model === 'gemini-nano-banana-2.1') {
    if (args.quality !== undefined && !(IMAGE_STUDIO_MODEL_QUALITY_OPTIONS[model] as readonly string[]).includes(args.quality)) {
      return { ok: false, code: 'image_channel_capability_mismatch', error: 'Banana 2.1 不支持所选图片质量；当前选择未被替换' };
    }
    if (args.resolution !== undefined && !(IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS[model] as readonly string[]).includes(args.resolution)) {
      return { ok: false, code: 'image_channel_capability_mismatch', error: 'Banana 2.1 不支持所选分辨率；请明确选择 1K、2K 或 4K，当前选择未被替换' };
    }
  }
  settings = resolveImageGenerationModelSettings(settings, model);
  const capability = settings.modelCapabilities[model];
  if (settings.channelId === 'original') {
    if (model === 'gemini-nano-banana-2.1' && !capability?.enabled) return { ok: false, code: 'image_channel_model_not_enabled', error: '原接口未明确开放 Banana 2.1，请使用已配置的型号供应商' };
    if (!isImageGenerationApiReady(settings)) return { ok: false, code: 'image_generation_api_not_configured', error: '原接口未启用或配置不完整' };
    return { ok: true, capability: capability || blankCapability(legacyProtocol(settings.provider, model) === 'gemini_native' ? 'gemini_native' : 'openai_images') };
  }
  if (!settings.enabled || settings.deleted || !settings.api_key || !settings.base_url) {
    return { ok: false, code: 'image_channel_not_available', error: '该图片供应商尚未配置、已停用或已归档' };
  }
  if (!capability || !capability.enabled) return { ok: false, code: 'image_channel_model_not_enabled', error: '该供应商未开放此图片型号' };
  const missingCapability = modelCapabilityCompleteness(capability, model);
  if (missingCapability) return { ok: false, code: 'image_channel_capability_unknown', error: missingCapability };
  if (legacyRatioContract && !capability.ratios?.length) {
    return { ok: false, code: 'image_channel_capability_unknown', error: '尚未确认支持的图片比例' };
  }
  if (capability.billingMode === 'actual') {
    if (!isMuskImageGenerationChannel(settings)) return { ok: false, code: 'image_channel_actual_billing_unavailable', error: '此供应商没有可用的实际计费账单证明' };
    if (capability.actualQuoteRequired !== true) {
      return { ok: false, code: 'image_channel_actual_billing_not_ready', error: '同一 API Key 与型号尚无有效账单证明' };
    }
  }
  if (capability.billingMode === 'fixed' && capability.fixedPoints === null) {
    return { ok: false, code: 'image_channel_fixed_price_missing', error: '固定点数未填写，明确免费时请填写 0' };
  }
  const tests: Array<[string | undefined, string[] | null, string]> = [
    [args.quality, capability.qualities, '图片质量'],
    [args.resolution, capability.resolutions, '分辨率'],
  ];
  const allowsUnconfirmed = allowsUnconfirmedGeminiProParameters(model, capability);
  for (const [value, allowed, label] of tests) {
    if (allowed === null && allowsUnconfirmed) continue;
    if (value !== undefined && (!allowed || !allowed.includes(value))) {
      return { ok: false, code: 'image_channel_capability_mismatch', error: `当前供应商未确认支持所选${label}` };
    }
  }
  if (args.ratio !== undefined && (legacyRatioContract || !isStandardStudioRatio(args.ratio))) {
    const allowed = capability.ratios;
    const matches = legacyRatioContract ? allowed?.includes(args.ratio) : allowed?.some(value => {
      try { return normalizeStudioRatio(value) === normalizeStudioRatio(args.ratio); } catch { return false; }
    });
    if (!matches) return { ok: false, code: 'image_channel_capability_mismatch', error: '当前供应商未确认支持所选自定义图片比例' };
  }
  if (args.referenceCount !== undefined && (capability.maxReferences === null ? !allowsUnconfirmed : args.referenceCount > capability.maxReferences)) {
    return { ok: false, code: 'image_channel_reference_limit_unknown', error: capability.maxReferences === null
      ? '当前供应商尚未确认参考图上限' : `当前供应商最多支持 ${capability.maxReferences} 张参考图` };
  }
  return { ok: true, capability };
}

async function channelOption(
  settings: ImageGenerationResolvedSettings,
  label: string,
  supplierName: string | null,
  configured: boolean,
  enabled: boolean,
  client: Prisma.TransactionClient | typeof prisma,
  strictPricing = false,
): Promise<ImageGenerationChannelDto> {
  const models: ImageGenerationChannelDto['models'] = {};
  for (const model of IMAGE_STUDIO_MODELS) {
    const capability = settings.modelCapabilities[model];
    const legacySlot = settings.channelId === 'shared' || settings.channelId === 'banana';
    const legacyIntent = legacySlot
      ? await legacyBillingIntentState(settings, model, client, strictPricing)
      : null;
    const actualReady = legacySlot
      ? legacyIntent?.quoteReady === true
      : capability?.billingMode === 'actual' && await isActualBillingReady(settings, model, client, strictPricing);
    const effectiveCapability = capability && legacySlot && legacyIntent?.selected
      ? { ...capability, billingMode: 'actual' as const, billingSource: 'same_scope_actual_billing_proof', actualQuoteRequired: actualReady }
      : capability && actualReady
        ? { ...capability, billingMode: 'actual' as const, actualQuoteRequired: true }
      : capability;
    const effectiveSettings = effectiveCapability
      ? { ...settings, modelCapabilities: { ...settings.modelCapabilities, [model]: effectiveCapability } }
      : settings;
    let reason = !configured ? '尚未配置 API Key' : !enabled ? '通道已停用' : null;
    if (!reason && settings.channelId === 'original') reason = null;
    else if (!reason) reason = await modelDisabledReason(effectiveSettings, model, client, strictPricing);
    models[model] = {
      ready: settings.channelId === 'original' ? true : !reason,
      disabledReason: settings.channelId === 'original' ? null : reason,
      billingMode: effectiveCapability?.billingMode || null,
      fixedPoints: capability?.fixedPoints ?? null,
      billingSource: capability?.billingSource || (settings.channelId === 'shared' || settings.channelId === 'banana' ? 'legacy_image_studio_contract' : null),
      actualQuoteRequired: Boolean(actualReady && isMuskImageGenerationChannel(resolveImageGenerationModelSettings(settings, model))),
      qualities: capability?.qualities ?? null,
      resolutions: capability?.resolutions ?? null,
      ratios: ['auto', ...STUDIO_RATIOS],
      maxReferences: capability?.maxReferences ?? null,
      allowsUnconfirmedParameters: allowsUnconfirmedGeminiProParameters(model, effectiveCapability),
    };
  }
  const ready = Object.values(models).some(item => item.ready);
  const disabledReason = !configured ? '尚未配置 API Key' : !enabled ? '通道已停用' : ready ? null : '尚无能力完整且计费就绪的型号';
  return {
    id: settings.channelId,
    label,
    supplierName,
    ready,
    enabled,
    configured,
    disabledReason,
    models,
  };
}

export async function getImageGenerationChannelOptions(
  client: Prisma.TransactionClient | typeof prisma = prisma,
  strictPricing = false,
): Promise<ImageGenerationChannelsDto> {
  const [channels, defaultRoutes] = await Promise.all([
    getImageGenerationChannels(client, strictPricing),
    getImageGenerationDefaultRoutes(client),
  ]);
  const items: ImageGenerationChannelDto[] = [];
  const shared = selectImageGenerationSettings(channels, 'gpt-image-2', 'shared');
  const banana = selectImageGenerationSettings(channels, IMAGE_STUDIO_MODELS[0], 'banana');
  items.push(await channelOption(shared, '共享接口', channels.shared.api_key ? providerSupplierName(channels.shared.provider) : null,
    Boolean((channels.shared.api_key || Object.values(shared.modelApiKeys || {}).some(Boolean)) && channels.shared.base_url), channels.shared.enabled, client, strictPricing));
  items.push(await channelOption(banana, 'Banana 专用接口', channels.banana.api_key ? providerSupplierName(channels.banana.provider) : null,
    Boolean((channels.banana.api_key || Object.values(banana.modelApiKeys || {}).some(Boolean)) && channels.banana.base_url), channels.banana.enabled, client, strictPricing));
  const fluxport = channels.fluxport;
  items.push(await channelOption(fluxport, fluxport.label || 'FluxPort', 'FluxPort', Boolean((fluxport.api_key || Object.values(fluxport.modelApiKeys || {}).some(Boolean)) && fluxport.base_url), fluxport.enabled, client, strictPricing));
  for (const settings of channels.managed) {
    if (settings.deleted) continue;
    const group = IMAGE_API_GROUPS.find(item => imageApiGroupSources(channels).some(id => imageApiGroupChannelId(item, id) === settings.channelId));
    const label = `${settings.label || settings.supplierName}${group ? `（${group === 'banana' ? 'Banana' : 'Image'}组）` : ''}`;
    items.push(await channelOption(settings, label, settings.supplierName,
      Boolean((settings.api_key || Object.values(settings.modelApiKeys || {}).some(Boolean)) && settings.base_url), settings.enabled, client, strictPricing));
  }

  const originalModels: ImageGenerationChannelDto['models'] = {};
  for (const model of IMAGE_STUDIO_MODELS) {
    const defaultChannelId = defaultRoutes.models[model] || (isGeminiImageModel(model) ? 'banana' : 'shared');
    const defaultChannel = items.find(item => item.id === defaultChannelId);
    originalModels[model] = defaultChannel?.models[model] || {
      ready: false,
      disabledReason: '该型号默认供应商已删除或不存在；未切换到其他供应商',
      billingMode: null,
      fixedPoints: null,
      billingSource: null,
      actualQuoteRequired: false,
      qualities: null,
      resolutions: null,
      ratios: null,
      maxReferences: null,
    };
  }
  const originalReady = Object.values(originalModels).some(item => item?.ready === true);
  const original: ImageGenerationChannelDto = {
    id: 'original',
    label: '原接口',
    supplierName: null,
    ready: originalReady,
    enabled: true,
    configured: true,
    disabledReason: originalReady ? null : '该型号默认供应商未就绪',
    models: originalModels,
  };
  return { items: [original, ...items], defaultRoutes };
}

async function registryDto(
  record: ManagedChannelRegistryRecord,
  settings: ImageGenerationResolvedSettings,
  client: Prisma.TransactionClient | typeof prisma,
): Promise<ImageGenerationManagedChannelDto> {
  settings = await hydrateActualBilling(settings, client);
  const models: ImageGenerationManagedChannelDto['models'] = {};
  for (const model of IMAGE_STUDIO_MODELS) {
    const capability = settings.modelCapabilities[model];
    const actualReady = capability?.billingMode === 'actual' && await isActualBillingReady(settings, model, client);
    const reason = await modelDisabledReason(settings, model, client);
    models[model] = {
      enabled: capability?.enabled === true,
      protocol: capability?.protocol || (record.protocol === 'gemini_native' ? 'gemini_native' : record.id === 'fluxport' ? FLUXPORT_PROTOCOL_BY_MODEL[model] : 'openai_images'),
      upstreamModel: capability?.upstreamModel || null,
      baseUrl: capability?.baseUrl || null,
      apiKeyConfigured: Boolean(resolveImageGenerationModelSettings(settings, model).api_key),
      apiKeyOverrideConfigured: Boolean(settings.modelApiKeys?.[model]),
      ready: !reason,
      disabledReason: reason,
      billingMode: capability?.billingMode || null,
      fixedPoints: capability?.fixedPoints ?? null,
      billingSource: capability?.billingSource || null,
      actualQuoteRequired: Boolean(actualReady && isMuskImageGenerationChannel(resolveImageGenerationModelSettings(settings, model))),
      qualities: capability?.qualities ?? null,
      resolutions: capability?.resolutions ?? null,
      ratios: capability?.ratios ?? null,
      maxReferences: capability?.maxReferences ?? null,
    };
  }
  return {
    id: record.id,
    label: record.label,
    supplierName: record.supplierName,
    supplierKind: record.supplierKind,
    protocol: record.protocol === 'legacy' ? 'openai_images' : record.protocol,
    baseUrl: record.baseUrl,
    enabled: record.enabled,
    deleted: record.deleted,
    configRevision: record.configRevision,
    apiKeyConfigured: Boolean(settings.inherited_api_key !== undefined ? settings.inherited_api_key : settings.api_key),
    models,
  };
}

export async function getManagedImageGenerationChannels(
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<ImageGenerationManagedChannelDto[]> {
  const registry = await readManagedChannelRegistry(client);
  const managed = await Promise.all(registry.channels.map(async record => registryDto(record, await resolveCurrentManagedSettings(record, client), client)));
  const channels = await getImageGenerationChannels(client);
  for (const channel of ['shared', 'banana'] as const) {
    const global = channels[channel];
    const settings = selectImageGenerationSettings(channels, IMAGE_STUDIO_MODELS[0], channel);
    const record: ManagedChannelRegistryRecord = { id: channel, label: channel === 'shared' ? '共享图形 API' : 'Banana 专用 API',
      supplierName: providerSupplierName(global.provider) || '原供应商', supplierKind: global.provider === 'musk' ? 'musk' : 'other',
      protocol: global.provider === 'musk' ? 'mixed' : 'openai_images', baseUrl: global.base_url, enabled: global.enabled, deleted: false,
      configRevision: channels.legacyModelApis[channel].revision, modelCapabilities: settings.modelCapabilities };
    managed.push(await registryDto(record, settings, client));
  }
  return managed;
}

export async function setImageGenerationModelDefaultRoute(
  model: ImageStudioModel,
  channelId: ImageGenerationChannelId | null,
  expectedRevision: number,
  updatedBy: string,
) {
  if (!IMAGE_STUDIO_MODELS.includes(model)) {
    throw new ImageGenerationChannelError('所选图片型号不在允许列表中', 400, 'image_channel_model_not_allowed');
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new ImageGenerationChannelError('设置版本无效，请重新读取后保存', 400, 'image_generation_default_invalid_revision');
  }
  if (channelId !== null) {
    assertImageGenerationChannelId(channelId);
    if (channelId === 'original') {
      throw new ImageGenerationChannelError('原接口是未设置时的兼容路由，不能作为默认供应商保存', 400, 'image_generation_default_invalid_channel');
    }
  }

  return prisma.$transaction(async tx => {
    const row = await tx.platformSetting.findUnique({ where: { key: IMAGE_GENERATION_MODEL_DEFAULTS_SETTING_KEY } });
    const current = parseImageGenerationDefaultRoutes(row?.value_json);
    if (current.revision !== expectedRevision) {
      throw new ImageGenerationChannelError('默认供应商设置已被其他管理员修改，请刷新后重试；未覆盖较新的设置', 409, 'image_generation_default_revision_conflict');
    }
    if (current.revision >= Number.MAX_SAFE_INTEGER) {
      throw new ImageGenerationChannelError('默认供应商设置版本已达上限，未保存更改', 409, 'image_generation_default_revision_exhausted');
    }

    if (channelId && channelId !== 'shared' && channelId !== 'banana' && channelId !== 'fluxport') {
      const registry = await readManagedChannelRegistry(tx);
      const selected = registry.channels.find(item => item.id === channelId);
      if (!selected || selected.deleted) {
        throw new ImageGenerationChannelError('所选图片供应商配置不存在或已归档；未更改默认设置', 404, 'image_channel_not_found');
      }
    }

    const models = { ...current.models };
    if (channelId === null) delete models[model];
    else models[model] = channelId;
    const next = { ...current, revision: current.revision + 1, models };
    const valueJson = serializeImageGenerationDefaultRoutes(next);
    try {
      if (row) {
        const swapped = await tx.platformSetting.updateMany({
          where: { key: IMAGE_GENERATION_MODEL_DEFAULTS_SETTING_KEY, value_json: row.value_json },
          data: { value_json: valueJson, updated_by: updatedBy },
        });
        if (swapped.count !== 1) {
          throw new ImageGenerationChannelError('默认供应商设置已被其他管理员修改，请刷新后重试；未覆盖较新的设置', 409, 'image_generation_default_revision_conflict');
        }
      } else {
        await tx.platformSetting.create({
          data: { key: IMAGE_GENERATION_MODEL_DEFAULTS_SETTING_KEY, value_json: valueJson, updated_by: updatedBy },
        });
      }
    } catch (error) {
      if (error instanceof ImageGenerationChannelError) throw error;
      if (isRecord(error) && error.code === 'P2002') {
        throw new ImageGenerationChannelError('默认供应商设置已被其他管理员创建，请刷新后重试', 409, 'image_generation_default_revision_conflict');
      }
      throw error;
    }

    await tx.operationLog.create({
      data: {
        operator_id: updatedBy,
        action: 'image_generation_model_default_route_update',
        target_type: 'PlatformSetting',
        target_id: IMAGE_GENERATION_MODEL_DEFAULTS_SETTING_KEY,
        detail: JSON.stringify({ model, channelId, revision: next.revision }),
      },
    });
    return next;
  });
}

// Group copies use the existing managed-channel/immutable-version protocol.
// The stable id also identifies copies without adding a second routing table.
function imageApiGroupChannelId(group: ImageApiGroup, sourceId: string) {
  const hex = modelApiSourceRevision(['image-api-group.v1', group, sourceId]);
  return `image-${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function imageApiGroupSources(channels: ImageGenerationChannels) {
  const ids = ['shared', 'banana', ...channels.registry.channels.map(channel => channel.id)];
  const copies = new Set(ids.flatMap(id => IMAGE_API_GROUPS.map(group => imageApiGroupChannelId(group, id))));
  return ids.filter(id => !copies.has(id));
}

const IMAGE_API_GROUP_READONLY_SETTINGS = {
  defaultModel: 'default_model', timeoutMs: 'timeout_ms', maxOutputs: 'max_outputs_per_request',
  defaultRatio: 'default_ratio', defaultSize: 'default_size', outputFormat: 'output_format',
  responseFormat: 'response_format', watermark: 'watermark', supportsTextToImage: 'supports_text_to_image',
  supportsImageToImage: 'supports_image_to_image', supportsAsyncTask: 'supports_async_task',
} as const;
type ImageApiGroupRetainedSettings = Partial<Pick<ImageGenerationApiSettings,
  typeof IMAGE_API_GROUP_READONLY_SETTINGS[keyof typeof IMAGE_API_GROUP_READONLY_SETTINGS]>>;

// Admin saves preserve stored parameters without changing runtime normalization.
async function readImageApiGroupRetainedSettings(client: Prisma.TransactionClient | typeof prisma,
  key: string | null, versioned: boolean, settings: ImageGenerationApiSettings): Promise<ImageApiGroupRetainedSettings> {
  if (!key) return {};
  const row = await client.platformSetting.findUnique({ where: { key } });
  if (!row) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(row.value_json); } catch {
    throw new ImageGenerationChannelError('原参数记录无法读取，已停止保存，请保留输入', 500, 'image_group_retained_settings_invalid');
  }
  const stored = versioned && isRecord(parsed) ? parsed.settings : parsed;
  if (!isRecord(stored)) throw new ImageGenerationChannelError('原参数记录格式无效，已停止保存，请保留输入', 500, 'image_group_retained_settings_invalid');
  const retained: Record<string, unknown> = {};
  for (const field of Object.values(IMAGE_API_GROUP_READONLY_SETTINGS)) {
    if (!Object.prototype.hasOwnProperty.call(stored, field)) continue;
    if (typeof stored[field] !== typeof settings[field]) {
      throw new ImageGenerationChannelError('原参数记录类型无效，已停止保存，请保留输入', 500, 'image_group_retained_settings_invalid');
    }
    retained[field] = stored[field];
  }
  return retained as ImageApiGroupRetainedSettings;
}

async function imageApiGroupSource(channels: ImageGenerationChannels, group: ImageApiGroup, id: string,
  client: Prisma.TransactionClient | typeof prisma) {
  if (!imageApiGroupSources(channels).includes(id)) throw new ImageGenerationChannelError('所选供应商不在原配置列表中');
  const models = imageApiGroupModels(group);
  const rootRecord = channels.registry.channels.find(channel => channel.id === id);
  const copyId = imageApiGroupChannelId(group, id);
  const copyRecord = channels.registry.channels.find(channel => channel.id === copyId);
  const legacy = id === 'shared' || id === 'banana';
  const root = legacy ? selectImageGenerationSettings(channels, models[0], id)
    : await resolveCurrentManagedSettings(rootRecord!, client);
  const settings = copyRecord ? await resolveCurrentManagedSettings(copyRecord, client) : root;
  const versionRecord = copyRecord || rootRecord;
  const retainedSettingsKey = versionRecord
    ? versionRecord.configRevision ? privateVersionKey(versionRecord.id, versionRecord.configRevision) : null
    : legacy ? id === 'banana' ? BANANA_IMAGE_API_SETTING_KEY : IMAGE_GENERATION_API_SETTING_KEY : null;
  const retainedSettings = await readImageApiGroupRetainedSettings(client, retainedSettingsKey,
    Boolean(versionRecord?.configRevision), settings);
  const modelCapabilities: Partial<Record<ImageStudioModel, ImageGenerationModelCapability>> = {};
  for (const model of models) {
    const resolved = !copyRecord && legacy ? selectImageGenerationSettings(channels, model, id) : settings;
    let capability = resolved.modelCapabilities[model];
    if (capability && !copyRecord && legacy) {
      const intent = await legacyBillingIntentState(resolved, model, client);
      if (intent.selected) capability = { ...capability, billingMode: 'actual', billingSource: 'same_scope_actual_billing_proof', actualQuoteRequired: intent.quoteReady };
    }
    if (capability) modelCapabilities[model] = { ...capability };
  }
  const modelApiKeys = Object.fromEntries(models.flatMap(model => settings.modelApiKeys?.[model] ? [[model, settings.modelApiKeys[model]]] : []));
  const sourceRevision = modelApiSourceRevision([group, id,
    legacy ? [channels[id as 'shared' | 'banana'], channels.legacyModelApis[id as 'shared' | 'banana'], modelCapabilities] : rootRecord,
    copyRecord || null, retainedSettings]);
  const label = root.label || (id === 'shared' ? '原图片接口' : id === 'banana' ? '原Banana接口' : root.supplierName);
  const supplierName = (legacy ? providerSupplierName(root.provider) : root.supplierName) || '原供应商';
  return { settings: { ...settings, label: settings.label || label, supplierName: copyRecord ? settings.supplierName : supplierName,
    default_model: !copyRecord && legacy ? channels[id as 'shared' | 'banana'].default_model : settings.default_model,
    modelCapabilities, modelApiKeys }, retainedSettings, sourceRevision, root, rootRecord, copyRecord, copyId,
    deleted: root.deleted === true || copyRecord?.deleted === true,
    label, supplierName };
}

function imageApiGroupSettings(settings: ImageGenerationResolvedSettings): ImageApiGroupSettings {
  return { label: settings.label || '图片接口', supplierName: settings.supplierName || providerSupplierName(settings.provider) || '原供应商',
    provider: settings.provider, baseUrl: settings.inherited_base_url || settings.base_url,
    defaultModel: settings.default_model,
    timeoutMs: settings.timeout_ms, maxOutputs: settings.max_outputs_per_request, defaultRatio: settings.default_ratio,
    defaultSize: settings.default_size, outputFormat: settings.output_format, responseFormat: settings.response_format,
    watermark: settings.watermark, supportsTextToImage: settings.supports_text_to_image,
    supportsImageToImage: settings.supports_image_to_image, supportsAsyncTask: settings.supports_async_task };
}

function imageApiGroupModelStatuses(settings: ImageGenerationResolvedSettings, group: ImageApiGroup, deleted = settings.deleted === true) {
  const result: Partial<Record<ImageStudioModel, ImageApiGroupModelDto>> = {};
  for (const model of imageApiGroupModels(group)) {
    const capability = settings.modelCapabilities[model];
    const effective = resolveImageGenerationModelSettings(settings, model);
    const actualBillingReasons: string[] = [];
    if (capability?.billingMode === 'actual') {
      if (capability.upstreamModel && capability.upstreamModel !== model) actualBillingReasons.push('上游型号与本站型号不同，尚无对应的精确账单证明');
      if (!isMuskImageGenerationChannel(effective)) actualBillingReasons.push('实际计费仅适用于已确认的 Musk 供应商与同一 API Key');
      if (capability.actualQuoteRequired !== true) actualBillingReasons.push('该 API Key 与型号的精确账单证明未就绪');
    }
    const missingRequirements = imageApiGroupModelMissingRequirements({
      providerSupported: isStudioImageGenerationProvider(settings.provider),
      baseUrlConfigured: Boolean(effective.base_url), apiKeyConfigured: Boolean(effective.api_key),
      protocol: capability?.protocol, qualities: capability?.qualities, resolutions: capability?.resolutions,
      ratios: ['auto', ...STUDIO_RATIOS], maxReferences: capability?.maxReferences,
      billingMode: capability?.billingMode, fixedPoints: capability?.fixedPoints,
    }, actualBillingReasons);
    const blockingReasons: string[] = [];
    if (deleted) blockingReasons.push('该供应商已归档，只保留已受理任务');
    if (!settings.enabled) blockingReasons.push('本组未启用');
    if (capability?.enabled !== true) blockingReasons.push('该型号未启用');
    const configurationReady = missingRequirements.length === 0;
    result[model] = { enabled: capability?.enabled === true,
      protocol: capability?.protocol || (group === 'banana' ? 'gemini_native' : 'openai_images'),
      protocolConfigured: Boolean(capability?.protocol),
      upstreamModel: capability?.upstreamModel || null, baseUrl: capability?.baseUrl || null,
      apiKeyConfigured: Boolean(effective.api_key), apiKeyOverrideConfigured: Boolean(settings.modelApiKeys?.[model]),
      configurationReady, missingRequirements, blockingReasons,
      ready: configurationReady && blockingReasons.length === 0,
      disabledReason: blockingReasons[0] || missingRequirements[0] || null,
      billingMode: capability?.billingMode || null, fixedPoints: capability?.fixedPoints ?? null,
      billingSource: capability?.billingSource || null, actualQuoteRequired: capability?.actualQuoteRequired === true,
      qualities: capability?.qualities ?? null, resolutions: capability?.resolutions ?? null,
      ratios: capability?.ratios ?? null, maxReferences: capability?.maxReferences ?? null };
  }
  return result;
}

export async function getImageApiGroupForms(client: Prisma.TransactionClient | typeof prisma = prisma): Promise<ImageApiGroupFormDto[]> {
  const defaults = await getImageGenerationDefaultRoutes(client);
  const channels = await getImageGenerationChannels(client);
  const forms: ImageApiGroupFormDto[] = [];
  for (const group of IMAGE_API_GROUPS) {
    const models = imageApiGroupModels(group);
    const defaultChannelIds = Object.fromEntries(models.map(model => [model, defaults.models[model] || (group === 'banana' ? 'banana' : 'shared')]));
    const providers: ImageApiGroupFormDto['providers'] = [];
    for (const id of imageApiGroupSources(channels)) {
      const source = await imageApiGroupSource(channels, group, id, client);
      const settings = await hydrateActualBilling(source.settings, client);
      const modelDtos = imageApiGroupModelStatuses(settings, group, source.deleted);
      providers.push({ id, channelId: source.copyRecord ? source.copyId : id,
        label: settings.label === settings.supplierName ? settings.supplierName : `${settings.supplierName}（${settings.label}）`,
        supplierName: settings.supplierName, groupConfigured: Boolean(source.copyRecord), enabled: settings.enabled, deleted: source.deleted, sourceRevision: source.sourceRevision,
        apiKeyConfigured: Boolean(settings.inherited_api_key !== undefined ? settings.inherited_api_key : settings.api_key),
        settings: imageApiGroupSettings({ ...settings, ...source.retainedSettings }), models: modelDtos });
    }
    const selected = providers.find(provider => models.every(model => defaultChannelIds[model] === provider.channelId));
    forms.push({ group, defaultProviderId: selected?.id || null, defaultChannelIds, providers });
  }
  return forms;
}

function imageApiGroupReceiptId(actorId: string, mutationId: string) {
  return `image-group-save-${modelApiSourceRevision([actorId, mutationId])}`;
}
export async function readImageApiGroupSaveReceipt(actorId: string, mutationId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma) {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(mutationId)) throw new ImageGenerationChannelError('保存操作编号无效');
  const row = await client.operationLog.findUnique({ where: { id: imageApiGroupReceiptId(actorId, mutationId) } });
  if (!row || row.operator_id !== actorId || row.action !== 'image_generation_group_api_save') return null;
  const value: unknown = JSON.parse(row.detail || '{}');
  if (!isRecord(value) || !isRecord(value.receipt) || typeof value.requestHash !== 'string') {
    throw new ImageGenerationChannelError('原保存回执无法读取，请保留输入', 409, 'image_group_receipt_invalid');
  }
  return { requestHash: value.requestHash, receipt: value.receipt as ImageApiGroupSaveReceipt };
}

function imageApiGroupKey(value: unknown) {
  if (typeof value !== 'string' || value.length > 500) throw new ImageGenerationChannelError('API Key 格式无效');
  const key = value.trim();
  if (key && (/[*•●…]{3,}/.test(key) || /[\r\n\x00-\x1f\x7f]/.test(key))) {
    throw new ImageGenerationChannelError('请填写真实 API Key，不能保存掩码');
  }
  return key;
}

function patchImageApiGroupSettings(current: ImageApiGroupSettings, patch: unknown): ImageApiGroupSettings {
  if (patch === undefined) return current;
  if (!isRecord(patch) || Object.keys(patch).some(key => !Object.prototype.hasOwnProperty.call(current, key))) {
    throw new ImageGenerationChannelError('共用设置包含不支持的字段');
  }
  if (Object.keys(IMAGE_API_GROUP_READONLY_SETTINGS).some(field => Object.prototype.hasOwnProperty.call(patch, field)
    && !Object.is(patch[field], current[field as keyof ImageApiGroupSettings]))) {
    throw new ImageGenerationChannelError('原默认参数和共用能力标记在此只读；本组普通生图仍为每任务 1 张、PNG、300000ms，输入未保存', 400, 'image_group_readonly_setting');
  }
  const next = { ...current, ...patch };
  if (typeof next.label !== 'string' || !next.label.trim() || next.label.length > 120
    || typeof next.supplierName !== 'string' || !next.supplierName.trim() || next.supplierName.length > 120
    || !['musk', 'ai_media_vip', 'seedream', 'fluxport', 'managed'].includes(String(next.provider))
    || typeof next.baseUrl !== 'string' || next.baseUrl.length > 2048) {
    throw new ImageGenerationChannelError('供应商名称、接口类型或共用地址无效，输入未保存');
  }
  return next;
}

/** Group configuration, immutable version and only this group's defaults commit together. */
export async function saveImageApiGroupForm(input: Record<string, unknown>, actorId: string) {
  if (Object.keys(input).some(key => !['channel_action', 'mutation_id', 'group', 'channelId', 'apiKey', 'clearApiKey', 'enabled', 'settings', 'models', 'expectedSourceRevision', 'expectedDefaultRevision'].includes(key))
    || input.channel_action !== 'save-api-group' || !IMAGE_API_GROUPS.includes(input.group as ImageApiGroup)
    || typeof input.mutation_id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(input.mutation_id)
    || typeof input.channelId !== 'string' || typeof input.enabled !== 'boolean'
    || input.clearApiKey !== undefined && typeof input.clearApiKey !== 'boolean'
    || !Number.isSafeInteger(input.expectedDefaultRevision) || Number(input.expectedDefaultRevision) < 0
    || typeof input.expectedSourceRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedSourceRevision)) {
    throw new ImageGenerationChannelError('分组、供应商或保存版本无效，请保留输入重新读取');
  }
  const group = input.group as ImageApiGroup, id = input.channelId, mutationId = input.mutation_id, enabled = input.enabled;
  const models = imageApiGroupModels(group), key = imageApiGroupKey(input.apiKey);
  if (input.clearApiKey === true && key) throw new ImageGenerationChannelError('共用密钥不能同时替换和清除');
  const modelPatch = input.models === undefined ? {} : input.models;
  const modelFields = ['enabled', 'protocol', 'upstreamModel', 'baseUrl', 'apiKey', 'clearApiKey', 'qualities', 'resolutions', 'ratios', 'maxReferences', 'billingMode', 'fixedPoints'];
  if (!isRecord(modelPatch) || Object.entries(modelPatch).some(([model, value]) => !models.includes(model as ImageStudioModel)
    || !isRecord(value) || Object.keys(value).some(field => !modelFields.includes(field)))) {
    throw new ImageGenerationChannelError('只能保存本组的合法型号设置，其他分组未改');
  }
  const requestHash = modelApiSourceRevision({ ...input, apiKey: key });
  const replay = async (client: Prisma.TransactionClient | typeof prisma) => {
    const saved = await readImageApiGroupSaveReceipt(actorId, mutationId, client);
    if (!saved) return null;
    if (saved.requestHash !== requestHash) throw new ImageGenerationChannelError('保存编号已用于不同输入，原结果未覆盖', 409, 'image_group_mutation_conflict');
    return { receipt: saved.receipt, replayed: true };
  };
  const prior = await replay(prisma);
  if (prior) return prior;
  const before = await imageApiGroupSource(await getImageGenerationChannels(), group, id, prisma);
  if (before.deleted) throw new ImageGenerationChannelError('供应商已归档，本次保存不会恢复它', 409, 'image_channel_archived');
  const shared = patchImageApiGroupSettings(imageApiGroupSettings({ ...before.settings, ...before.retainedSettings }), input.settings);
  if (id === 'fluxport' && shared.provider !== 'fluxport' || id !== 'fluxport' && shared.provider === 'fluxport') {
    throw new ImageGenerationChannelError('FluxPort 使用固定供应商身份，请选择对应供应商，不合并其他通道');
  }
  if (enabled && !isStudioImageGenerationProvider(shared.provider)) {
    throw new ImageGenerationChannelError('此接口类型尚未支持本组型号；可停用后保存，不会假称可生成');
  }
  const baseUrl = shared.baseUrl.trim() ? await validateManagedBaseUrl(shared.baseUrl) : '';
  if (enabled && !baseUrl) throw new ImageGenerationChannelError('启用本组前请填写 API 地址；停用时可保留未完整设置');
  const validatedBases: Partial<Record<ImageStudioModel, string>> = {};
  for (const model of models) {
    const patch = modelPatch[model];
    if (!isRecord(patch)) continue;
    if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean'
      || patch.clearApiKey !== undefined && typeof patch.clearApiKey !== 'boolean'
      || patch.billingMode !== undefined && patch.billingMode !== null && patch.billingMode !== 'fixed' && patch.billingMode !== 'actual') {
      throw new ImageGenerationChannelError(`型号 ${model} 的开关或计费选择无效`);
    }
    const modelKey = patch.apiKey === undefined ? '' : imageApiGroupKey(patch.apiKey);
    if (modelKey && patch.clearApiKey === true) throw new ImageGenerationChannelError('型号密钥不能同时替换和改为继承');
    for (const field of ['qualities', 'resolutions', 'ratios']) {
      const value = patch[field];
      if (value !== undefined && value !== null && typeof value !== 'string'
        && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))) throw new ImageGenerationChannelError(`型号 ${model} 的规格格式无效`);
    }
    if (patch.baseUrl !== undefined && patch.baseUrl !== null && typeof patch.baseUrl !== 'string') throw new ImageGenerationChannelError('型号地址格式无效');
    if (typeof patch.baseUrl === 'string' && patch.baseUrl.trim()) validatedBases[model] = await validateManagedBaseUrl(patch.baseUrl);
  }
  try {
    return await prisma.$transaction(async tx => {
      const existing = await replay(tx);
      if (existing) return existing;
      const defaultRow = await tx.platformSetting.findUnique({ where: { key: IMAGE_GENERATION_MODEL_DEFAULTS_SETTING_KEY } });
      const defaults = parseImageGenerationDefaultRoutes(defaultRow?.value_json);
      if (defaults.revision !== input.expectedDefaultRevision || defaults.revision >= Number.MAX_SAFE_INTEGER) {
        throw new ImageGenerationChannelError('默认供应商已变化，输入已保留，请重新读取核对', 409, 'image_generation_default_revision_conflict');
      }
      const channels = await getImageGenerationChannels(tx);
      const source = await imageApiGroupSource(channels, group, id, tx);
      if (source.deleted || source.sourceRevision !== input.expectedSourceRevision) {
        throw new ImageGenerationChannelError('供应商配置已变化，输入已保留，请重新读取核对', 409, 'image_channel_revision_conflict');
      }
      const modelCapabilities = { ...source.settings.modelCapabilities }, modelApiKeys = { ...source.settings.modelApiKeys };
      for (const model of models) {
        const patch = modelPatch[model];
        if (!isRecord(patch)) continue;
        const current = modelCapabilities[model];
        if (patch.billingMode !== undefined && patch.billingMode !== (current?.billingMode ?? null)
          || patch.fixedPoints !== undefined && patch.fixedPoints !== (current?.fixedPoints ?? null)) {
          throw new ImageGenerationChannelError('收费已统一到点数定价页面；API 设置不能另写价格，请刷新后台', 409, 'pricing_legacy_writer_rejected');
        }
        const capability = parseManagedCapabilities({ [model]: { ...current, ...patch } }, source.copyId,
          group === 'banana' ? 'gemini_native' : 'openai_images')[model];
        if (!capability) throw new ImageGenerationChannelError(`型号 ${model} 缺少合法协议，输入未保存`);
        if (current && patch.billingMode === undefined && patch.fixedPoints === undefined) capability.billingSource = current.billingSource;
        if (validatedBases[model]) capability.baseUrl = validatedBases[model];
        modelCapabilities[model] = capability;
        const modelKey = patch.apiKey === undefined ? '' : imageApiGroupKey(patch.apiKey);
        if (patch.clearApiKey === true) delete modelApiKeys[model];
        else if (modelKey) modelApiKeys[model] = modelKey;
      }
      const oldKey = source.settings.inherited_api_key !== undefined ? source.settings.inherited_api_key : source.settings.api_key;
      const apiKey = input.clearApiKey === true ? null : key || oldKey || null;
      if (enabled && !apiKey && !Object.values(modelApiKeys).some(Boolean)) {
        throw new ImageGenerationChannelError('启用本组前请填写共用 Key 或型号独立 Key；输入未保存');
      }
      const settings: ImageGenerationApiSettings = {
        enabled, provider: shared.provider, base_url: baseUrl, default_model: shared.defaultModel,
        api_key: apiKey, timeout_ms: shared.timeoutMs, max_outputs_per_request: shared.maxOutputs,
        default_ratio: shared.defaultRatio, default_size: shared.defaultSize, output_format: shared.outputFormat,
        response_format: shared.responseFormat, watermark: shared.watermark, supports_text_to_image: shared.supportsTextToImage,
        supports_image_to_image: shared.supportsImageToImage, supports_async_task: shared.supportsAsyncTask,
      };
      const configRevision = randomUUID();
      const version: PrivateImageGenerationChannelVersion = {
        version: 1, channelId: source.copyId, configRevision, label: shared.label.trim(),
        supplierName: shared.supplierName.trim(),
        supplierKind: shared.provider === source.settings.provider ? source.settings.supplierKind : shared.provider === 'musk' ? 'musk' : 'other',
        protocol: source.settings.protocol,
        managedChannel: true, settings, modelCapabilities, modelApiKeys, deleted: false,
      };
      const registry = channels.registry;
      const registryRow = await tx.platformSetting.findUnique({ where: { key: IMAGE_GENERATION_CHANNEL_REGISTRY_SETTING_KEY } });
      const record: ManagedChannelRegistryRecord = {
        id: source.copyId, label: version.label, supplierName: version.supplierName,
        supplierKind: version.supplierKind === 'musk' || shared.provider === 'musk' ? 'musk' : 'other',
        protocol: group === 'banana' ? 'gemini_native' : 'openai_images', baseUrl,
        enabled, deleted: false, configRevision, modelCapabilities,
      };
      const index = registry.channels.findIndex(channel => channel.id === record.id);
      if (index < 0) registry.channels.push(record); else registry.channels[index] = record;
      await writePrivateChannelVersion(tx, version, actorId);
      await swapSimpleModelSetting(tx, IMAGE_GENERATION_CHANNEL_REGISTRY_SETTING_KEY, registryRow?.value_json, JSON.stringify(registry), actorId);
      const defaultRoutes = { ...defaults, revision: defaults.revision + 1,
        models: { ...defaults.models, ...Object.fromEntries(models.map(model => [model, source.copyId])) } };
      await swapSimpleModelSetting(tx, IMAGE_GENERATION_MODEL_DEFAULTS_SETTING_KEY, defaultRow?.value_json,
        serializeImageGenerationDefaultRoutes(defaultRoutes), actorId);
      const savedSettings = await hydrateActualBilling(managedSettingsFromVersion(version), tx);
      const receipt: ImageApiGroupSaveReceipt = { mutationId, group, providerId: id, channelId: source.copyId,
        enabled, apiKeyConfigured: Boolean(apiKey), defaultRoutes, savedAt: new Date().toISOString(),
        affectedModels: models.filter(model => defaultRoutes.models[model] === source.copyId),
        modelStatuses: imageApiGroupModelStatuses(savedSettings, group) };
      await tx.operationLog.create({ data: { id: imageApiGroupReceiptId(actorId, mutationId), operator_id: actorId,
        action: 'image_generation_group_api_save', target_type: 'PlatformSetting', target_id: source.copyId,
        detail: JSON.stringify({ requestHash, receipt }) } });
      return { receipt, replayed: false };
    }, { timeout: 15000 });
  } catch (error) {
    if (isRecord(error) && ['P2002', 'P2034', 'P1008', 'P2028'].includes(String(error.code))) {
      const receipt = await replay(prisma);
      if (receipt) return receipt;
      throw new ImageGenerationChannelError('保存结果尚未确认，请查询原保存回执，不要重复提交', 409, 'image_group_save_unknown');
    }
    throw error;
  }
}

export type ImageModelApiFormDto = {
  model: ImageStudioModel; defaultChannelId: string;
  providers: { id: string; label: string; supplierName: string; revision: string | null;
    sourceRevision: string; apiKeyConfigured: boolean; canSave: boolean; reason: string | null }[];
};
export type ImageModelApiSaveReceipt = {
  mutationId: string; model: ImageStudioModel; channelId: string; apiKeyConfigured: boolean; enabled: boolean;
  defaultRoutes: Awaited<ReturnType<typeof getImageGenerationDefaultRoutes>>; savedAt: string;
};

function modelApiSourceRevision(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function getImageModelApiForms(client: Prisma.TransactionClient | typeof prisma = prisma): Promise<ImageModelApiFormDto[]> {
  const defaults = await getImageGenerationDefaultRoutes(client);
  const registry = await readManagedChannelRegistry(client);
  const legacy = await getImageGenerationChannels(client);
  const forms: ImageModelApiFormDto[] = [];
  for (const model of IMAGE_STUDIO_MODELS) {
    const providers: ImageModelApiFormDto['providers'] = [];
    for (const id of ['shared', 'banana'] as const) {
      const settings = selectImageGenerationSettings(legacy, model, id);
      const reason = await modelDisabledReason(settings, model, client);
      const sourceRevision = modelApiSourceRevision([legacy[id], legacy.legacyModelApis[id]]);
      providers.push({ id, label: `${providerSupplierName(settings.provider) || '原供应商'}（${id === 'shared' ? '通道1' : '通道2'}）`,
        supplierName: providerSupplierName(settings.provider) || '原供应商', revision: legacy.legacyModelApis[id].revision,
        sourceRevision, apiKeyConfigured: Boolean(settings.api_key), canSave: true, reason });
    }
    for (const channel of registry.channels) {
      if (channel.deleted) continue;
      const settings = await resolveCurrentManagedSettings(channel, client);
      const reason = await modelDisabledReason(settings, model, client);
      providers.push({ id: channel.id, label: channel.label === channel.supplierName ? channel.supplierName : `${channel.supplierName}（${channel.label}）`,
        supplierName: channel.supplierName, revision: channel.configRevision, sourceRevision: modelApiSourceRevision(channel),
        apiKeyConfigured: Boolean(resolveImageGenerationModelSettings(settings, model).api_key), canSave: true, reason });
    }
    forms.push({ model, defaultChannelId: defaults.models[model] || (model.startsWith('gemini-') ? 'banana' : 'shared'), providers });
  }
  return forms;
}

function modelApiReceiptId(actorId: string, mutationId: string) {
  return `image-model-save-${modelApiSourceRevision([actorId, mutationId])}`;
}
export async function readImageModelApiSaveReceipt(actorId: string, mutationId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma) {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(mutationId)) throw new ImageGenerationChannelError('保存操作编号无效');
  const row = await client.operationLog.findUnique({ where: { id: modelApiReceiptId(actorId, mutationId) } });
  if (!row || row.operator_id !== actorId || row.action !== 'image_generation_model_api_save') return null;
  const value: unknown = JSON.parse(row.detail || '{}');
  if (!isRecord(value) || !isRecord(value.receipt) || typeof value.requestHash !== 'string') {
    throw new ImageGenerationChannelError('原保存回执无法读取，请保留草稿', 409, 'image_model_receipt_invalid');
  }
  return { requestHash: value.requestHash, receipt: value.receipt as ImageModelApiSaveReceipt };
}

/** Compatibility writer preserves enablement; group enablement uses saveImageApiGroupForm. */
export async function saveImageModelApiForm(input: Record<string, unknown>, actorId: string) {
  if (Object.keys(input).some(key => !['channel_action', 'mutation_id', 'model', 'channelId', 'apiKey', 'expectedRevision', 'expectedSourceRevision', 'expectedDefaultRevision'].includes(key))
    || input.channel_action !== 'save-model-api'
    || typeof input.mutation_id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(input.mutation_id)
    || !IMAGE_STUDIO_MODELS.includes(input.model as ImageStudioModel) || typeof input.apiKey !== 'string'
    || input.apiKey.length > 500 || !Number.isSafeInteger(input.expectedDefaultRevision) || Number(input.expectedDefaultRevision) < 0
    || typeof input.expectedSourceRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedSourceRevision)
    || input.expectedRevision !== null && (typeof input.expectedRevision !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.expectedRevision))) {
    throw new ImageGenerationChannelError('型号、密钥或保存版本无效，请保留输入重新读取');
  }
  assertImageGenerationChannelId(input.channelId);
  if (input.channelId === 'original') throw new ImageGenerationChannelError('请选择实际供应商通道');
  const model = input.model as ImageStudioModel, id = input.channelId, mutationId = input.mutation_id;
  const key = input.apiKey.trim();
  if (key && (/[*•●…]{3,}/.test(key) || /[\r\n\x00-\x1f\x7f]/.test(key))) throw new ImageGenerationChannelError('请填写真实API Key，不能保存掩码');
  const requestHash = modelApiSourceRevision({ ...input, apiKey: key });
  const replay = async (client: Prisma.TransactionClient | typeof prisma) => {
    const existing = await readImageModelApiSaveReceipt(actorId, mutationId, client);
    if (!existing) return null;
    if (existing.requestHash !== requestHash) throw new ImageGenerationChannelError('保存编号已用于不同输入，原结果未覆盖', 409, 'image_model_mutation_conflict');
    return { receipt: existing.receipt, replayed: true };
  };
  const prior = await replay(prisma);
  if (prior) return prior;
  // Address validation can resolve DNS; keep it outside the write transaction.
  const forms = await getImageModelApiForms();
  const selected = forms.find(form => form.model === model)?.providers.find(provider => provider.id === id);
  if (!selected || !selected.canSave) throw new ImageGenerationChannelError(selected?.reason || '供应商未配置或已归档', 409, 'image_model_preset_unavailable');
  const before = await getImageGenerationSettingsForModel(model, prisma, id);
  if (before.base_url) await validateManagedBaseUrl(before.base_url);
  if (before.modelCapabilities[model]?.baseUrl) await validateManagedBaseUrl(before.modelCapabilities[model]!.baseUrl);
  try {
    return await prisma.$transaction(async tx => {
      const existing = await replay(tx);
      if (existing) return existing;
      const defaultRow = await tx.platformSetting.findUnique({ where: { key: IMAGE_GENERATION_MODEL_DEFAULTS_SETTING_KEY } });
      const defaults = parseImageGenerationDefaultRoutes(defaultRow?.value_json);
      if (defaults.revision !== input.expectedDefaultRevision || defaults.revision >= Number.MAX_SAFE_INTEGER) {
        throw new ImageGenerationChannelError('默认供应商设置已变化，请保留输入重新读取', 409, 'image_generation_default_revision_conflict');
      }
      let savedSettings: ImageGenerationResolvedSettings;
      if (id === 'shared' || id === 'banana') {
        const channels = await getImageGenerationChannels(tx);
        const old = channels.legacyModelApis[id];
        if (old.revision !== input.expectedRevision || modelApiSourceRevision([channels[id], old]) !== input.expectedSourceRevision) {
          throw new ImageGenerationChannelError('供应商设置已变化，请保留输入重新读取', 409, 'image_channel_revision_conflict');
        }
        const next: LegacyModelApiRegistry = { version: 1, revision: randomUUID(), models: { ...old.models,
          [model]: { ...old.models[model], ...(key ? { apiKey: key } : {}) } } };
        const settingKey = `${IMAGE_GENERATION_LEGACY_MODEL_API_SETTING_PREFIX}${id}`;
        const row = await tx.platformSetting.findUnique({ where: { key: settingKey } });
        await swapSimpleModelSetting(tx, settingKey, row?.value_json, JSON.stringify(next), actorId);
        savedSettings = selectImageGenerationSettings({ ...channels, legacyModelApis: { ...channels.legacyModelApis, [id]: next } }, model, id);
        const intent = await legacyBillingIntentState(savedSettings, model, tx);
        const capability = savedSettings.modelCapabilities[model];
        if (intent.selected && capability) savedSettings.modelCapabilities = { ...savedSettings.modelCapabilities,
          [model]: { ...capability, billingMode: 'actual', billingSource: 'same_scope_actual_billing_proof', actualQuoteRequired: intent.quoteReady } };
      } else {
        const row = await tx.platformSetting.findUnique({ where: { key: IMAGE_GENERATION_CHANNEL_REGISTRY_SETTING_KEY } });
        const registry = await readManagedChannelRegistry(tx);
        const index = registry.channels.findIndex(channel => channel.id === id);
        const channel = registry.channels[index];
        if (!channel || channel.deleted) throw new ImageGenerationChannelError('供应商不存在或已归档', 409, 'image_channel_not_found');
        if (channel.configRevision !== input.expectedRevision || modelApiSourceRevision(channel) !== input.expectedSourceRevision) {
          throw new ImageGenerationChannelError('供应商设置已变化，请保留输入重新读取', 409, 'image_channel_revision_conflict');
        }
        const previous = await resolveCurrentManagedSettings(channel, tx);
        const modelApiKeys = { ...previous.modelApiKeys, ...(key ? { [model]: key } : {}) };
        const configRevision = randomUUID();
        const modelCapabilities = { ...previous.modelCapabilities };
        const next = { ...channel, configRevision, modelCapabilities };
        const version: PrivateImageGenerationChannelVersion = { version: 1, channelId: id, configRevision,
          label: channel.label, supplierName: channel.supplierName, supplierKind: channel.supplierKind,
          protocol: channel.protocol, managedChannel: true,
          settings: { ...previous, enabled: channel.enabled, api_key: previous.inherited_api_key !== undefined ? previous.inherited_api_key : previous.api_key,
            base_url: previous.inherited_base_url || previous.base_url }, modelCapabilities, modelApiKeys, deleted: false };
        await writePrivateChannelVersion(tx, version, actorId);
        registry.channels[index] = next;
        await swapSimpleModelSetting(tx, IMAGE_GENERATION_CHANNEL_REGISTRY_SETTING_KEY, row?.value_json, JSON.stringify(registry), actorId);
        savedSettings = managedSettingsFromVersion(version);
      }
      savedSettings = await hydrateActualBilling(savedSettings, tx);
      const defaultRoutes = { ...defaults, revision: defaults.revision + 1, models: { ...defaults.models, [model]: id } };
      await swapSimpleModelSetting(tx, IMAGE_GENERATION_MODEL_DEFAULTS_SETTING_KEY, defaultRow?.value_json,
        serializeImageGenerationDefaultRoutes(defaultRoutes), actorId);
      const receipt: ImageModelApiSaveReceipt = { mutationId, model, channelId: id,
        apiKeyConfigured: Boolean(resolveImageGenerationModelSettings(savedSettings, model).api_key), enabled: savedSettings.enabled,
        defaultRoutes, savedAt: new Date().toISOString() };
      await tx.operationLog.create({ data: { id: modelApiReceiptId(actorId, mutationId), operator_id: actorId,
        action: 'image_generation_model_api_save', target_type: 'PlatformSetting', target_id: id,
        detail: JSON.stringify({ requestHash, receipt }) } });
      return { receipt, replayed: false };
    }, { timeout: 15000 });
  } catch (error) {
    if (isRecord(error) && ['P2002', 'P2034', 'P1008', 'P2028'].includes(String(error.code))) {
      const receipt = await replay(prisma);
      if (receipt) return receipt;
      throw new ImageGenerationChannelError('并发保存尚未确认，请先查原操作回执', 409, 'image_model_save_unknown');
    }
    throw error;
  }
}

async function swapSimpleModelSetting(client: Prisma.TransactionClient, key: string, oldValue: string | undefined,
  value: string, actorId: string) {
  value = stringifyPrivateCredentials(key, JSON.parse(value));
  if (oldValue !== undefined) {
    const changed = await client.platformSetting.updateMany({ where: { key, value_json: oldValue }, data: { value_json: value, updated_by: actorId } });
    if (changed.count !== 1) throw new ImageGenerationChannelError('设置发生并发冲突，未保存任何更改', 409, 'image_channel_revision_conflict');
  } else await client.platformSetting.create({ data: { key, value_json: value, updated_by: actorId } });
}

async function validateManagedBaseUrl(value: unknown, fallback?: string) {
  const candidate = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  if (!candidate) throw new ImageGenerationChannelError('请填写 API 地址', 400, 'image_channel_base_url_required');
  const { validateStudioProviderApiBaseUrl } = await import('@/lib/image-studio/provider');
  const validation = await validateStudioProviderApiBaseUrl(candidate);
  if (!validation.ok) throw new ImageGenerationChannelError('API 地址必须是安全的 HTTPS 公网地址', 400, validation.code);
  return validation.url;
}

async function saveManagedRecord(
  input: ManagedImageGenerationChannelInput,
  updatedBy: string,
  operation: 'create' | 'update' | 'archive' | 'restore',
) {
  const requestedId = input.id;
  const createId = operation === 'create' ? `image-${randomUUID()}` : null;
  const id = createId || requestedId;
  assertImageGenerationChannelId(id);
  if (id === 'original' || id === 'shared' || id === 'banana') {
    throw new ImageGenerationChannelError('原接口及其兼容别名不可新增、改名或删除', 400, 'image_channel_reserved_id');
  }
  const isFluxPort = id === 'fluxport';
  if (operation === 'create' && isFluxPort) throw new ImageGenerationChannelError('FluxPort 是预设通道，不能重复新增', 409, 'image_channel_already_exists');
  if (operation === 'archive' && isFluxPort) throw new ImageGenerationChannelError('FluxPort 预设不能删除，只能停用', 400, 'image_channel_reserved_id');
  const beforeRegistry = await readManagedChannelRegistry(prisma);
  const beforeRecord = beforeRegistry.channels.find(item => item.id === id);
  const baseUrl = operation === 'archive' || operation === 'restore'
    ? (isFluxPort ? FLUXPORT_IMAGE_GENERATION_BASE_URL : beforeRecord?.baseUrl || '')
    : isFluxPort
      ? await validateManagedBaseUrl(FLUXPORT_IMAGE_GENERATION_BASE_URL)
      : await validateManagedBaseUrl(input.baseUrl, beforeRecord?.baseUrl);
  if (!baseUrl) throw new ImageGenerationChannelError('图片供应商配置不存在', 404, 'image_channel_not_found');
  // Validate every explicit model endpoint before entering the write transaction.
  const validatedModelBases: Partial<Record<ImageStudioModel, string>> = {};
  if ((operation === 'create' || operation === 'update') && isRecord(input.models)) {
    for (const model of IMAGE_STUDIO_MODELS) {
      const source = input.models[model];
      if (isRecord(source) && typeof source.baseUrl === 'string' && source.baseUrl.trim()) {
        validatedModelBases[model] = await validateManagedBaseUrl(source.baseUrl);
      }
    }
  }

  return prisma.$transaction(async tx => {
    const registryRowBefore = await tx.platformSetting.findUnique({ where: { key: IMAGE_GENERATION_CHANNEL_REGISTRY_SETTING_KEY } });
    const registry = await readManagedChannelRegistry(tx);
    const existingIndex = registry.channels.findIndex(item => item.id === id);
    const existing = existingIndex >= 0 ? registry.channels[existingIndex] : null;
    if (operation === 'create' && existing) throw new ImageGenerationChannelError('该图片供应商已存在', 409, 'image_channel_already_exists');
    if (operation !== 'create' && !existing) throw new ImageGenerationChannelError('图片供应商配置不存在', 404, 'image_channel_not_found');
    const expectedRevision = input.expectedRevision === null || input.expectedRevision === undefined || input.expectedRevision === ''
      ? null : String(input.expectedRevision);
    if (operation !== 'create' && expectedRevision !== existing?.configRevision) {
      throw new ImageGenerationChannelError('配置已被其他管理员修改，请刷新后重试；未覆盖较新的设置', 409, 'image_channel_revision_conflict');
    }
    const previous = existing ? await resolveCurrentManagedSettings(existing, tx) : null;
    const supplierKind = isFluxPort ? 'fluxport'
      : input.supplierKind === 'musk' ? 'musk' : input.supplierKind === 'other' ? 'other'
        : existing?.supplierKind === 'musk' ? 'musk' : 'other';
    const supplierName = isFluxPort ? 'FluxPort'
      : cleanString(input.supplierName, existing?.supplierName || '').slice(0, 120);
    const label = isFluxPort ? cleanString(input.label, existing?.label || 'FluxPort').slice(0, 120)
      : cleanString(input.label, existing?.label || '').slice(0, 120);
    if (!label) throw new ImageGenerationChannelError('请填写配置名称', 400, 'image_channel_label_required');
    if (!supplierName) throw new ImageGenerationChannelError('请填写供应商真实名称', 400, 'image_channel_supplier_required');
    const protocol: ImageGenerationResolvedProtocol = isFluxPort ? 'mixed'
      : input.protocol === 'gemini_native' || input.protocol === 'openai_images'
        ? input.protocol
        : existing?.protocol || 'openai_images';
    const suppliedModels = operation === 'create' ? input.models ?? {} : input.models ?? existing?.modelCapabilities ?? {};
    const modelsInput = isRecord(suppliedModels) ? Object.fromEntries(Object.entries(suppliedModels).map(([model, value]) => {
      if (!isRecord(value)) return [model, value];
      const previousCapability = previous?.modelCapabilities[model as ImageStudioModel];
      if (value.billingMode !== undefined && value.billingMode !== (previousCapability?.billingMode ?? null)
        || value.fixedPoints !== undefined && value.fixedPoints !== (previousCapability?.fixedPoints ?? null)) {
        throw new ImageGenerationChannelError('收费已统一到点数定价页面；API 设置不能另写价格，请刷新后台', 409, 'pricing_legacy_writer_rejected');
      }
      return [model, { ...value, billingMode: previousCapability?.billingMode ?? null, fixedPoints: previousCapability?.fixedPoints ?? null }];
    })) : suppliedModels;
    const modelCapabilities = operation === 'archive' || operation === 'restore'
      ? existing!.modelCapabilities
      : parseManagedCapabilities(modelsInput, id, protocol);
    const modelApiKeys = { ...previous?.modelApiKeys };
    if (operation === 'create' || operation === 'update') {
      for (const model of IMAGE_STUDIO_MODELS) {
        const source = isRecord(modelsInput) && isRecord(modelsInput[model]) ? modelsInput[model] as Record<string, unknown> : {};
        const key = typeof source.apiKey === 'string' ? source.apiKey.trim() : '';
        if (key.length > 500 || source.apiKey !== undefined && typeof source.apiKey !== 'string') {
          throw new ImageGenerationChannelError('型号 API Key 格式无效，请核对输入', 400, 'image_channel_invalid_api_key');
        }
        if (source.clearApiKey === true && key) throw new ImageGenerationChannelError('型号密钥不能同时替换和清除', 400, 'image_channel_key_conflict');
        if (source.clearApiKey === true) delete modelApiKeys[model];
        else if (key) modelApiKeys[model] = key;
        if (modelCapabilities[model] && validatedModelBases[model]) {
          modelCapabilities[model] = { ...modelCapabilities[model]!, baseUrl: validatedModelBases[model] };
        }
      }
    }
    const requestedEnabled = operation === 'create' || operation === 'update' ? input.enabled === true : false;
    if ((operation === 'create' || operation === 'update') && input.enabled !== undefined && typeof input.enabled !== 'boolean') {
      throw new ImageGenerationChannelError('启用状态无效，请重新选择后保存', 400, 'image_channel_invalid_enabled');
    }
    if (requestedEnabled && input.clearApiKey === true) {
      throw new ImageGenerationChannelError('不能同时清除 API Key 并启用通道；请保留或重新填写 API Key', 400, 'image_channel_enable_key_conflict');
    }
    const inputKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    if (inputKey.length > 500) throw new ImageGenerationChannelError('API Key 过长，请核对输入内容', 400, 'image_channel_invalid_api_key');
    const apiKey = input.clearApiKey === true ? null : inputKey || previous?.api_key || null;
    if (requestedEnabled && !apiKey && !Object.values(modelApiKeys).some(Boolean)) {
      throw new ImageGenerationChannelError('启用图片供应商前必须先填写 API Key；当前输入未保存', 400, 'image_channel_api_key_required');
    }
    const enabled = requestedEnabled;
    const deleted = operation === 'archive' ? true : operation === 'restore' ? false : existing?.deleted === true;
    const configRevision = randomUUID();
    const provider: ImageGenerationProvider = isFluxPort ? 'fluxport' : supplierKind === 'musk' ? 'musk' : 'managed';
    const settings: ImageGenerationApiSettings = {
      ...DEFAULT_IMAGE_GENERATION_API_SETTINGS,
      enabled,
      provider,
      base_url: baseUrl,
      default_model: IMAGE_STUDIO_MODELS.find(model => modelCapabilities[model]?.enabled) || IMAGE_STUDIO_MODELS[0],
      api_key: apiKey,
      timeout_ms: clampInteger(previous?.timeout_ms, DEFAULT_IMAGE_GENERATION_API_SETTINGS.timeout_ms, 5000, 300000),
      max_outputs_per_request: 8,
      default_ratio: '16:9',
      default_size: '2K',
      output_format: 'png',
      response_format: 'url',
      watermark: false,
      supports_text_to_image: true,
      supports_image_to_image: Object.values(modelCapabilities).some(capability => capability.maxReferences !== null && capability.maxReferences > 0),
      supports_async_task: false,
    };
    const record: ManagedChannelRegistryRecord = {
      id,
      label,
      supplierName,
      supplierKind,
      protocol,
      baseUrl,
      enabled,
      deleted,
      configRevision,
      modelCapabilities,
    };
    const version: PrivateImageGenerationChannelVersion = {
      version: 1,
      channelId: id,
      configRevision,
      label,
      supplierName,
      supplierKind,
      protocol,
      managedChannel: true,
      settings,
      modelCapabilities,
      modelApiKeys,
      deleted,
    };
    await writePrivateChannelVersion(tx, version, updatedBy);
    if (existingIndex >= 0) registry.channels[existingIndex] = record;
    else registry.channels.push(record);
    const serializedRegistry = stringifyPrivateCredentials(IMAGE_GENERATION_CHANNEL_REGISTRY_SETTING_KEY, registry);
    try {
      if (registryRowBefore) {
        const swapped = await tx.platformSetting.updateMany({
          where: { key: IMAGE_GENERATION_CHANNEL_REGISTRY_SETTING_KEY, value_json: registryRowBefore.value_json },
          data: { value_json: serializedRegistry, updated_by: updatedBy },
        });
        if (swapped.count !== 1) {
          throw new ImageGenerationChannelError('配置已被其他管理员修改，请刷新后重试；未覆盖较新的设置', 409, 'image_channel_revision_conflict');
        }
      } else {
        await tx.platformSetting.create({
          data: { key: IMAGE_GENERATION_CHANNEL_REGISTRY_SETTING_KEY, value_json: serializedRegistry, updated_by: updatedBy },
        });
      }
    } catch (error) {
      if (error instanceof ImageGenerationChannelError) throw error;
      if (isRecord(error) && error.code === 'P2002') {
        throw new ImageGenerationChannelError('该图片供应商配置已被其他管理员创建，请刷新后重试', 409, 'image_channel_revision_conflict');
      }
      throw error;
    }
    const resolved = await hydrateActualBilling(managedSettingsFromVersion(version), tx);
    const result = await registryDto(record, resolved, tx);
    await tx.operationLog.create({
      data: {
        operator_id: updatedBy,
        action: `image_generation_channel_${operation}`,
        target_type: 'PlatformSetting',
        target_id: id,
        detail: JSON.stringify({
          revision: configRevision,
          enabled,
          deleted,
          api_key_configured: Boolean(apiKey),
          model_count: Object.values(modelCapabilities).filter(capability => capability.enabled).length,
        }),
      },
    });
    return result;
  });
}

export async function createManagedImageGenerationChannel(input: ManagedImageGenerationChannelInput, updatedBy: string) {
  if (input.supplierKind === 'fluxport') throw new ImageGenerationChannelError('FluxPort 是预设通道，不作为新供应商重复创建', 400, 'image_channel_reserved_supplier');
  return saveManagedRecord(input, updatedBy, 'create');
}

export async function updateManagedImageGenerationChannel(input: ManagedImageGenerationChannelInput, updatedBy: string) {
  return saveManagedRecord(input, updatedBy, 'update');
}

export async function archiveManagedImageGenerationChannel(input: ManagedImageGenerationChannelInput, updatedBy: string) {
  return saveManagedRecord(input, updatedBy, 'archive');
}

export async function restoreManagedImageGenerationChannel(input: ManagedImageGenerationChannelInput, updatedBy: string) {
  return saveManagedRecord(input, updatedBy, 'restore');
}

/** Private staged values never enter an HTTP DTO or script output. */
export async function prepareImageQualityChannelUpdate(tx: Prisma.TransactionClient | typeof prisma, id: string,
  configRevision: string, patch: { baseUrl?: string; apiKey?: string; maxReferences?: number; resolutions?: string[]; mediumActivation?: boolean }) {
  const row = await tx.platformSetting.findUniqueOrThrow({ where: { key: IMAGE_GENERATION_CHANNEL_REGISTRY_SETTING_KEY } });
  const registry = await readManagedChannelRegistry(tx);
  const index = registry.channels.findIndex(item => item.id === id);
  const existing = registry.channels[index];
  if (!existing || existing.deleted || !existing.configRevision) throw new ImageGenerationChannelError('质量档位的 API 不存在或已归档', 409);
  const previous = await readPrivateChannelVersion(tx, id, existing.configRevision);
  const originalVersionRow = await tx.platformSetting.findUniqueOrThrow({ where: { key: privateVersionKey(id, existing.configRevision) } });
  const originalVersion = parsePrivateCredentials(originalVersionRow.key, originalVersionRow.value_json) as PrivateImageGenerationChannelVersion;
  const model = IMAGE_25_QUALITY_MODEL;
  const capability = previous.modelCapabilities[model];
  if (!capability) throw new ImageGenerationChannelError('该 API 没有 Sunburst 型号配置', 409);
  const medium = patch.mediumActivation === true;
  const nextCapability: ImageGenerationModelCapability = { ...capability,
    ...(medium ? { enabled: true, protocol: 'openai_images' as const, qualities: ['medium'],
      resolutions: ['1K', '2K', '4K'], ratios: ['auto', ...STUDIO_RATIOS], maxReferences: 7,
      billingMode: 'fixed' as const, fixedPoints: null, billingSource: 'user_confirmed' } : {}),
    ...(patch.baseUrl ? { baseUrl: patch.baseUrl } : {}),
    ...(patch.maxReferences !== undefined ? { maxReferences: patch.maxReferences } : {}),
    ...(patch.resolutions ? { resolutions: patch.resolutions } : {}) };
  const modelCapabilities = { ...originalVersion.modelCapabilities, [model]: nextCapability };
  const modelApiKeys = { ...originalVersion.modelApiKeys, ...(patch.apiKey ? { [model]: patch.apiKey } : {}) };
  const version: PrivateImageGenerationChannelVersion = { ...originalVersion, configRevision, modelCapabilities, modelApiKeys,
    settings: { ...originalVersion.settings, ...(medium ? { base_url: 'https://api.uselg.top', supports_image_to_image: true } : {}) } };
  if (!existing.enabled || !previous.settings.api_key && !modelApiKeys[model]) throw new ImageGenerationChannelError('该质量 API 尚未启用或缺少 Key，未保存', 409);
  // Readers normalize old records. Only replace the selected raw row when writing,
  // so this operation cannot normalize or discard another provider's saved fields.
  const rawRegistry = parsePrivateCredentials(row.key, row.value_json) as { channels: Array<Record<string, unknown>> };
  const rawIndex = rawRegistry.channels.findIndex(item => item.id === id);
  if (rawIndex < 0) throw new ImageGenerationChannelError('API 原始配置不存在，未保存', 409);
  const rawRecord = rawRegistry.channels[rawIndex];
  rawRegistry.channels[rawIndex] = { ...rawRecord, configRevision,
    modelCapabilities: { ...(isRecord(rawRecord.modelCapabilities) ? rawRecord.modelCapabilities : {}), [model]: nextCapability },
    ...(medium ? { baseUrl: 'https://api.uselg.top' } : {}) };
  return { before: row.value_json, registryJson: JSON.stringify(rawRegistry),
    versionKey: privateVersionKey(id, configRevision), versionJson: stringifyPrivateCredentials(privateVersionKey(id, configRevision), version), configRevision,
    previousRevision: existing.configRevision };
}

export async function persistImageQualityChannelUpdate(tx: Prisma.TransactionClient,
  staged: Awaited<ReturnType<typeof prepareImageQualityChannelUpdate>>, actorId: string) {
  await tx.platformSetting.create({ data: { key: staged.versionKey, value_json: staged.versionJson, updated_by: actorId } });
  await swapSimpleModelSetting(tx, IMAGE_GENERATION_CHANNEL_REGISTRY_SETTING_KEY, staged.before, staged.registryJson, actorId);
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

function buildOpenAiImagesGenerationUrl(baseUrl: string) {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/images/generations')) return url.toString();
  url.pathname = `${path || ''}/images/generations`;
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

function extractSeedreamGeneratedImages(data: Record<string, unknown>): GeneratedImageOutput[] {
  const items = Array.isArray(data.data) ? data.data : [];
  const images: GeneratedImageOutput[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const url = pickOutputString(record, ['url']);
    const b64Json = pickOutputString(record, ['b64_json', 'b64Json']);
    if (!url && !b64Json) continue;
    images.push({
      url,
      b64Json,
      mimeType: pickOutputString(record, ['mime_type', 'mimeType']) || undefined,
      revisedPrompt: pickOutputString(record, ['revised_prompt', 'revisedPrompt']) || undefined,
    });
  }
  return images;
}

function normalizeReferenceImages(value: unknown, limit: number) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const images: string[] = [];
  for (const item of value) {
    const raw = cleanString(item);
    if (!raw || seen.has(raw)) continue;
    if (!raw.startsWith('data:image/') && !raw.startsWith('http://') && !raw.startsWith('https://')) continue;
    seen.add(raw);
    images.push(raw);
    if (images.length >= limit) break;
  }
  return images;
}

function imageGenerationSize(params: {
  size?: string;
  settings: ImageGenerationApiSettings;
}) {
  const resolved = params.settings as ImageGenerationResolvedSettings;
  const allowFourToOne = resolved.managedChannel === true
    && resolved.modelCapabilities?.[params.settings.default_model as ImageStudioModel]?.protocol === 'openai_images'
    && imageGenerationSupportsStudioFourToOne(params.settings, params.settings.default_model, true);
  if (isValidImageDimension(params.size, allowFourToOne)) return params.size;
  return normalizeSize(params.size, params.settings.default_size);
}

function buildOpenAiImageRequestBody(params: {
  settings: ImageGenerationApiSettings;
  prompt: string;
  count?: number;
  size?: string;
  referenceImages?: string[];
}) {
  const referenceImages = normalizeReferenceImages(params.referenceImages, 10);
  const body: Record<string, unknown> = {
    model: params.settings.default_model,
    prompt: params.prompt,
    ...(params.count && params.settings.provider !== 'seedream' ? { n: params.count } : {}),
    size: imageGenerationSize({ size: params.size, settings: params.settings }),
    output_format: params.settings.output_format,
    response_format: params.settings.response_format,
    watermark: params.settings.watermark,
  };
  if (referenceImages.length > 0) {
    body.image = referenceImages;
  }
  return body;
}

async function parseJsonResponse(response: Response) {
  const text = await response.text();
  try {
    return text.trim() ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    throw new ImageGenerationApiError('图形生成 API 返回不是 JSON', 502, 'image_generation_invalid_response');
  }
}

function upstreamErrorMessage(data: Record<string, unknown>, fallbackStatus: number) {
  return pickOutputString(data, ['message', 'error', 'detail'])
    || (data.error && typeof data.error === 'object'
      ? pickOutputString(data.error as Record<string, unknown>, ['message', 'code'])
      : null)
    || `图形生成 API 调用失败 (HTTP ${fallbackStatus})`;
}

const GEMINI_IMAGE_MODELS = new Set([
  'gemini-nano-banana-2.1',
  'gemini-3.1-flash-image-preview',
  'gemini-3-pro-image-preview',
]);

async function createGeminiImageGeneration(params: {
  settings: ImageGenerationApiSettings;
  prompt: string;
  count: number;
  ratio?: string;
  size?: string;
  referenceImages?: string[];
  signal: AbortSignal;
}) {
  const parts: Array<Record<string, unknown>> = [{ text: params.prompt }];
  for (const source of params.referenceImages || []) {
    const match = source.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i);
    if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
  }
  const response = await privateCredentialFetch({ endpoint: buildMuskGeminiGenerateContentUrl(params.settings.base_url, params.settings.default_model),
    provider: params.settings.provider, credential: params.settings.api_key || '', model: params.settings.default_model }, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(params.settings.provider === 'musk'
        ? { 'x-goog-api-key': params.settings.api_key || '' }
        : { Authorization: `Bearer ${params.settings.api_key || ''}` }),
    },
    body: JSON.stringify({
      contents: [{
        parts,
      }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: {
          ...(params.ratio ? { aspectRatio: params.ratio } : {}),
          ...(params.size ? { imageSize: params.size } : {}),
        },
      },
    }),
    signal: params.signal,
  });

  const data = await parseJsonResponse(response);
  if (!response.ok) {
    throw new ImageGenerationApiError(
      upstreamErrorMessage(data, response.status),
      response.status,
      'image_generation_upstream_error',
    );
  }

  const images = extractGeminiGeneratedImages(data);
  if (images.length === 0) {
    throw new ImageGenerationApiError('图形生成 API 未返回图片', 502, 'image_generation_empty_output');
  }

  return {
    images: images.slice(0, params.count),
    model: params.settings.default_model,
    raw: data,
  };
}

async function createOpenAiImageGeneration(params: {
  settings: ImageGenerationApiSettings;
  prompt: string;
  count: number;
  size?: string;
  referenceImages?: string[];
  signal: AbortSignal;
}) {
  const response = await privateCredentialFetch({ endpoint: buildOpenAiImagesGenerationUrl(params.settings.base_url),
    provider: params.settings.provider, credential: params.settings.api_key || '', model: params.settings.default_model }, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.settings.api_key || ''}`,
    },
    body: JSON.stringify(buildOpenAiImageRequestBody(params)),
    signal: params.signal,
  });

  const data = await parseJsonResponse(response);
  if (!response.ok) {
    throw new ImageGenerationApiError(
      upstreamErrorMessage(data, response.status),
      response.status,
      'image_generation_upstream_error',
    );
  }

  const images = extractSeedreamGeneratedImages(data);
  if (images.length === 0) {
    throw new ImageGenerationApiError('图形生成 API 未返回图片', 502, 'image_generation_empty_output');
  }

  return {
    images: images.slice(0, params.settings.provider === 'seedream' ? 1 : params.count),
    model: params.settings.default_model,
    raw: data,
  };
}

export async function createImageGeneration(params: {
  settings: ImageGenerationApiSettings;
  prompt: string;
  ratio?: string;
  size?: string;
  count?: number;
  referenceImages?: string[];
  quality?: string;
}): Promise<ImageGenerationResult> {
  if ((params.settings as ImageGenerationResolvedSettings).modelCapabilities) {
    params = { ...params, settings: resolveImageGenerationModelSettings(params.settings as ImageGenerationResolvedSettings, params.settings.default_model) };
  }
  if (!isImageGenerationApiReady(params.settings)) {
    throw new ImageGenerationApiError('图形生成 API 未启用或缺少配置', 503, 'image_generation_api_not_configured');
  }
  if (params.settings.default_model === 'gemini-nano-banana-2.1') {
    const resolved = params.settings as ImageGenerationResolvedSettings;
    if (!resolved.modelCapabilities?.[params.settings.default_model]) {
      throw new ImageGenerationApiError('所选供应商修订未明确开放 Banana 2.1，尚未向供应商提交', 409, 'image_channel_model_not_enabled');
    }
    const validation = validateImageGenerationChannel(resolved, { model: params.settings.default_model,
      quality: params.quality, ratio: params.ratio, referenceCount: params.referenceImages?.length,
      ...(resolved.modelCapabilities[params.settings.default_model]?.protocol === 'gemini_native' ? { resolution: params.size } : {}) });
    if (!validation.ok) throw new ImageGenerationApiError(validation.error, 400, validation.code);
    if ((params.referenceImages?.length || 0) > MAX_REFERENCE_IMAGES) {
      throw new ImageGenerationApiError(`本站最多使用 ${MAX_REFERENCE_IMAGES} 张参考图；当前素材未被删减，尚未向供应商提交`, 400, 'image_generation_reference_limit');
    }
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
    if (isStudioImageGenerationProvider(params.settings.provider)
      && IMAGE_STUDIO_MODELS.includes(params.settings.default_model as typeof IMAGE_STUDIO_MODELS[number])) {
      if (params.ratio === '4:1' && !imageGenerationSupportsStudioFourToOne(params.settings, params.settings.default_model, params.settings.default_model !== 'gemini-nano-banana-2.1')) {
        throw new ImageGenerationApiError('当前模型或通道未确认支持4:1', 400, 'image_generation_ratio_not_supported');
      }
      const resolvedSettings = params.settings as ImageGenerationResolvedSettings;
      const managedProtocol = resolvedSettings.managedChannel || resolvedSettings.explicitModelApi
        ? resolvedSettings.modelCapabilities[params.settings.default_model as ImageStudioModel]?.protocol
        : undefined;
      if ((resolvedSettings.managedChannel || resolvedSettings.explicitModelApi) && !managedProtocol) {
        throw new ImageGenerationApiError('所选图片供应商修订缺少该型号的明确请求协议', 409, 'image_generation_channel_protocol_missing');
      }
      const images: StudioImageInput[] = [];
      for (const source of normalizeReferenceImages(params.referenceImages, 10)) {
        const inline = source.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i);
        if (inline && inline[2].length > 28 * 1024 * 1024) {
          throw new ImageGenerationApiError('参考图过大，请压缩后重试', 413, 'image_generation_reference_image_too_large');
        }
        const bytes = inline ? Buffer.from(inline[2], 'base64') : await readStudioImage(source, controller.signal);
        images.push({ bytes: await normalizeStudioImage(bytes), mimeType: 'image/png' });
      }
      // Share only the provider transport, not template permissions or billing.
      const request = {
        baseUrl: params.settings.base_url,
        apiKey: params.settings.api_key || '',
        provider: params.settings.provider === 'musk' ? 'musk' as const : 'ai_media_vip' as const,
        ...(managedProtocol ? { protocol: managedProtocol } : {}),
        model: params.settings.default_model,
        upstreamModel: resolvedSettings.modelCapabilities?.[params.settings.default_model as ImageStudioModel]?.upstreamModel,
        prompt: params.prompt,
        quality: normalizeImageStudioQuality(params.settings.default_model, params.settings.default_model === 'gemini-nano-banana-2.1' ? params.quality ?? 'auto' : params.quality || 'auto'),
        count,
        images,
        ratio: params.ratio,
        size: params.size,
        allowFourToOne: imageGenerationSupportsStudioFourToOne(params.settings, params.settings.default_model, params.settings.default_model !== 'gemini-nano-banana-2.1'),
        ...(params.settings.default_model === 'gemini-nano-banana-2.1' ? { ratioContractVersion: 2 as const } : {}),
        signal: controller.signal,
      };
      // Gemini generateContent produces one image per call; count is not an API parameter.
      // Each slot is requested once, never retried after an uncertain upstream result.
      const usesGeminiProtocol = managedProtocol
        ? managedProtocol === 'gemini_native'
        : params.settings.provider === 'musk' && GEMINI_IMAGE_MODELS.has(params.settings.default_model);
      const attempts = usesGeminiProtocol
        ? Array.from({ length: count }, () => requestStudioImages({ ...request, count: 1 }))
        : [requestStudioImages(request)];
      const completed = await Promise.allSettled(attempts);
      const outputs = completed.flatMap(item => item.status === 'fulfilled' ? item.value.images : []);
      if (!outputs.length) {
        const failed = completed.find(item => item.status === 'rejected');
        throw failed?.status === 'rejected' ? failed.reason : new StudioProviderError('response', 'empty_output');
      }
      return {
        images: outputs.map(b64Json => ({ b64Json })),
        model: params.settings.default_model,
        raw: { usage: completed.flatMap(item => item.status === 'fulfilled' ? [item.value.usage] : []) },
      };
    }
    const useMuskGeminiProtocol = params.settings.provider === 'musk'
      && GEMINI_IMAGE_MODELS.has(params.settings.default_model);
    if (!useMuskGeminiProtocol) {
      return await createOpenAiImageGeneration({
        settings: params.settings,
        prompt: params.prompt,
        count,
        size: params.size,
        referenceImages: params.referenceImages,
        signal: controller.signal,
      });
    }

    return await createGeminiImageGeneration({
      settings: params.settings,
      prompt: params.prompt,
      count,
      ratio: params.ratio,
      size: params.size,
      referenceImages: params.referenceImages,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof ImageGenerationApiError) throw error;
    if (error instanceof StudioProviderError) {
      const message = error.code === 'invalid_json'
        ? '图片服务未返回有效结果，请管理员检查生图接口地址；请勿连续重复生成'
        : error.code === 'timeout'
          ? '图片服务响应超时，上游结果尚未确认，请勿连续重复生成'
          : `图片服务处理失败（${error.code}${error.status ? `，HTTP ${error.status}` : ''}）`;
      throw new ImageGenerationApiError(message, error.code === 'timeout' ? 504 : 502, `image_generation_${error.code}`);
    }
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
