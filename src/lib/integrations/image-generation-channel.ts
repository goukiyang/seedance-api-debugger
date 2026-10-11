import type { ImageStudioModel } from '@/lib/image-studio/model-catalog';

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
};

export type ImageGenerationManagedModelDto = {
  enabled: boolean;
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
