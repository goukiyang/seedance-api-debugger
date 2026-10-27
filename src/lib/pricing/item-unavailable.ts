import type { PricingAdminIdentity } from './admin-contract';
import { PublicApiError } from '@/lib/http/public-error';

export type PricingItemUnavailableReason = 'configuration_missing' | 'disabled' | 'model_not_enabled'
  | 'specification_unsupported' | 'price_unconfigured' | 'evidence_unconfirmed' | 'count_exceeds_limit';

/** Only a successfully read, legal configuration may establish item-level unavailability. */
export class PricingItemUnavailableError extends PublicApiError {
  readonly status = 409;
  readonly code = 'pricing_item_unavailable';
  readonly identity: PricingAdminIdentity;
  constructor(identity: PricingAdminIdentity, readonly reason: PricingItemUnavailableReason, message: string) {
    super(message, 409, 'pricing_item_unavailable');
    this.name = 'PricingItemUnavailableError';
    this.identity = Object.freeze({ ...identity, specifications: Object.freeze({ ...identity.specifications }) });
  }
}

export function isPricingItemUnavailable(error: unknown, identity: PricingAdminIdentity): error is PricingItemUnavailableError {
  if (!(error instanceof PricingItemUnavailableError)) return false;
  const source = error.identity;
  return source.kind === identity.kind && source.channelId === identity.channelId && source.modelId === identity.modelId
    && source.billingMode === identity.billingMode && source.unit === identity.unit
    && Object.keys(source.specifications).length === Object.keys(identity.specifications).length
    && Object.entries(source.specifications).every(([key, value]) => identity.specifications[key] === value);
}
