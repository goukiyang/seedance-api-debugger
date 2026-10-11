import type { ImageStudioModel } from '@/lib/image-studio/model-catalog';
import { IMAGE_STUDIO_MODELS } from '@/lib/image-studio/model-catalog';

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
export type ImageApiGroupModelDto = ImageGenerationManagedModelDto;
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

export type ImageGenerationChannelSnapshot = {
  channelId: ImageGenerationChannelId;
  configRevision: string;
};

export type ImageGenerationModelCapabilityDto = {
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
