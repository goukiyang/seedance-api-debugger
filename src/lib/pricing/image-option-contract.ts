import type { ImageGenerationChannelsDto, ImageGenerationModelCapabilityDto } from '@/lib/integrations/image-generation-channel';
import type { ImageStudioModel } from '@/lib/image-studio/model-catalog';
import type { PricingAdminIdentity } from './admin-contract';

export type PricingImageMenuCapability = ImageGenerationModelCapabilityDto & { pricingBySpecification?: boolean };
export type PricingImageChannelOptions = Omit<ImageGenerationChannelsDto, 'items'> & {
  items: Array<Omit<ImageGenerationChannelsDto['items'][number], 'models'> & {
    models: Partial<Record<ImageStudioModel, PricingImageMenuCapability>>;
  }>;
};

export function imagePricingSpecificationsRequired(identity: PricingAdminIdentity, scopes: readonly PricingAdminIdentity[]) {
  return scopes.some(scope => scope.kind === identity.kind && scope.channelId === identity.channelId
    && scope.modelId === identity.modelId && scope.billingMode === identity.billingMode && scope.unit === identity.unit
    && Object.entries(scope.specifications).every(([key, value]) => identity.specifications[key] === undefined || identity.specifications[key] === value)
    && Object.keys(scope.specifications).some(key => identity.specifications[key] === undefined));
}

/** Read-only menu projection, never a billing authorization or a frozen task contract. */
export type CanvasImageModelOption = {
  model: string;
  label: string;
  status: 'estimate' | 'unavailable';
  reason: string | null;
  reasonText: string | null;
  unitCredits: number | null;
  estimatedCredits: number | null;
  count: number;
  chargeEnabled: false;
  billingMode: 'fixed' | 'actual';
  actualQuoteRequired: boolean;
  estimateSource: 'channel_contract' | 'legacy_fixed';
  creditPrecision: 0.01 | 0.1;
  pricingRevision?: string;
  pricingQuoteRequired: boolean;
  pricingBySpecification?: boolean;
};
