import type { ImageStudioModel } from '@/lib/image-studio/model-catalog';
import { IMAGE_STUDIO_MODELS } from '@/lib/image-studio/model-catalog';
import type { ImageQualityRouteSnapshot, ImageQualityRoutes } from '@/lib/image-studio/quality-routing';

export const IMAGE_API_GROUPS = ['image', 'banana'] as const;
export type ImageApiGroup = typeof IMAGE_API_GROUPS[number];
export function imageApiGroupModels(group: ImageApiGroup): ImageStudioModel[] {
  return IMAGE_STUDIO_MODELS.filter(model => group === 'banana' ? model.startsWith('gemini-') : !model.startsWith('gemini-'));
}
export type ImageApiGroupSettings = {
  label: string; supplierName: string;
  provider: 'musk' | 'ai_media_vip' | 'seedream' | 'fluxport' | 'managed';
  baseUrl: string; defaultModel: string; timeoutMs: number; maxOutputs: number; defaultRatio: string; defaultSize: '1K' | '2K';
  outputFormat: 'png' | 'jpeg'; responseFormat: 'url' | 'b64_json'; watermark: boolean;
  supportsTextToImage: boolean; supportsImageToImage: boolean; supportsAsyncTask: boolean;
};
export type ImageApiGroupModelDto = ImageGenerationManagedModelDto & {
  protocolConfigured?: boolean;
  configurationReady?: boolean;
  missingRequirements?: string[];
  blockingReasons?: string[];
};

export type ImageApiGroupModelConfiguration = {
  providerSupported: boolean; baseUrlConfigured: boolean; apiKeyConfigured: boolean;
  protocol?: ImageGenerationChannelProtocol | null;
  qualities?: string[] | null; resolutions?: string[] | null; ratios?: string[] | null;
  maxReferences?: number | null; billingMode?: ImageGenerationBillingMode | null; fixedPoints?: number | null;
};

/** Read-only admin diagnostics; this does not gate saving or change dispatch. */
export function imageApiGroupModelMissingRequirements(value: ImageApiGroupModelConfiguration, actualBillingReasons: string[] = []) {
  const missing: string[] = [];
  if (!value.providerSupported) missing.push('现有接口类型尚未支持本组型号');
  if (!value.baseUrlConfigured) missing.push('尚未配置 API 地址');
  if (!value.apiKeyConfigured) missing.push('尚未配置 API Key');
  if (value.protocol !== 'gemini_native' && value.protocol !== 'openai_images') missing.push('尚未确认请求协议');
  if (!value.qualities?.length) missing.push('尚未确认支持的图片质量');
  if (!value.resolutions?.length) missing.push('尚未确认支持的分辨率');
  if (!value.ratios?.length) missing.push('尚未确认支持的图片比例');
  if (!Number.isSafeInteger(value.maxReferences) || Number(value.maxReferences) < 0) missing.push('尚未确认参考图上限');
  if (value.billingMode !== 'fixed' && value.billingMode !== 'actual') missing.push('尚未设置计费方式');
  if (value.billingMode === 'fixed' && (!Number.isSafeInteger(value.fixedPoints) || Number(value.fixedPoints) < 0)) {
    missing.push('固定点数未填写或无效，明确免费时请填写 0');
  }
  if (value.billingMode === 'actual') missing.push(...actualBillingReasons);
  return Array.from(new Set(missing));
}
export type ImageApiGroupProviderDto = {
  id: string; channelId: string; label: string; supplierName: string; groupConfigured: boolean; enabled: boolean; deleted: boolean;
  sourceRevision: string; apiKeyConfigured: boolean; settings: ImageApiGroupSettings;
  models: Partial<Record<ImageStudioModel, ImageApiGroupModelDto>>;
};
export type ImageApiGroupFormDto = {
  group: ImageApiGroup; defaultProviderId: string | null; defaultChannelIds: Partial<Record<ImageStudioModel, string>>;
  providers: ImageApiGroupProviderDto[];
};
export type ImageApiGroupSaveReceipt = {
  mutationId: string; group: ImageApiGroup; providerId: string; channelId: string; enabled: boolean;
  apiKeyConfigured: boolean; defaultRoutes: { revision: number; models: Partial<Record<ImageStudioModel, string>> };
  savedAt: string;
  affectedModels?: ImageStudioModel[];
  modelStatuses?: Partial<Record<ImageStudioModel, ImageApiGroupModelDto>>;
};

/**
 * A channel id is opaque and stable. The built-in ids remain reserved while
 * additional, admin-managed integrations use the `image-<uuid>` form.
 */
export type ImageGenerationChannelId = string;

export const IMAGE_GENERATION_RESERVED_CHANNEL_IDS = [
  'original',
  'shared',
  'banana',
  'fluxport',
] as const;

export type ImageGenerationChannelProtocol = 'gemini_native' | 'openai_images';
export type ImageGenerationResolvedProtocol = ImageGenerationChannelProtocol | 'legacy' | 'mixed';
export type ImageGenerationBillingMode = 'fixed' | 'actual';

/** These explicitly approved native models can send parameters without a supplier declaration.
 * This is not a support claim: explicit limits, enablement and a real fixed price still apply.
 */
export function allowsUnconfirmedGeminiProParameters(model: string, capability: {
  enabled?: boolean; protocol?: string; billingMode?: string | null; fixedPoints?: number | null;
} | undefined) {
  return (model === 'gemini-3-pro-image-preview' || model === 'gemini-nano-banana-2.1') && capability?.enabled === true
    && capability.protocol === 'gemini_native' && capability.billingMode === 'fixed'
    && Number.isSafeInteger(capability.fixedPoints) && Number(capability.fixedPoints) >= 0;
}

export type ImageGenerationChannelSnapshot = {
  channelId: ImageGenerationChannelId;
  configRevision: string;
  qualityRoute?: ImageQualityRouteSnapshot;
};

export type ImageGenerationModelCapabilityDto = {
  ready: boolean;
  disabledReason: string | null;
  billingMode: ImageGenerationBillingMode | null;
  fixedPoints: number | null;
  billingSource: string | null;
  actualQuoteRequired: boolean;
  /** Menu-only projection; a concrete specification still requires a server quote. */
  pricingBySpecification?: boolean;
  qualities: string[] | null;
  resolutions: string[] | null;
  ratios: string[] | null;
  maxReferences: number | null;
  /** Server-derived admission policy, not a declaration of supplier support. */
  allowsUnconfirmedParameters?: boolean;
};

/** Safe for generator settings responses. Never add credential fields here. */
export type ImageGenerationChannelDto = {
  id: ImageGenerationChannelId;
  label: string;
  supplierName: string | null;
  ready: boolean;
  enabled: boolean;
  configured: boolean;
  disabledReason: string | null;
  models: Partial<Record<ImageStudioModel, ImageGenerationModelCapabilityDto>>;
};

export type ImageGenerationChannelsDto = {
  items: ImageGenerationChannelDto[];
  defaultRoutes?: {
    revision: number;
    models: Partial<Record<ImageStudioModel, string>>;
    qualityRoutes?: ImageQualityRoutes;
  };
};

export type ImageGenerationManagedModelDto = {
  enabled: boolean;
  protocol: ImageGenerationChannelProtocol;
  upstreamModel: string | null;
  baseUrl: string | null;
  apiKeyConfigured: boolean;
  apiKeyOverrideConfigured: boolean;
  ready: boolean;
  disabledReason: string | null;
  billingMode: ImageGenerationBillingMode | null;
  fixedPoints: number | null;
  billingSource: string | null;
  actualQuoteRequired: boolean;
  qualities: string[] | null;
  resolutions: string[] | null;
  ratios: string[] | null;
  maxReferences: number | null;
};

/** Admin-safe supplier data. API keys are represented only by apiKeyConfigured. */
export type ImageGenerationManagedChannelDto = {
  id: ImageGenerationChannelId;
  label: string;
  supplierName: string;
  supplierKind: 'fluxport' | 'musk' | 'other';
  protocol: ImageGenerationChannelProtocol | 'mixed';
  baseUrl: string;
  enabled: boolean;
  deleted: boolean;
  configRevision: string | null;
  apiKeyConfigured: boolean;
  models: Partial<Record<ImageStudioModel, ImageGenerationManagedModelDto>>;
};
