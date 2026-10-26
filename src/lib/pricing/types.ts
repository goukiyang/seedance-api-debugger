import type { PricingAdminBasis, PricingAdminIdentity, PricingAdminMode, PricingAdminSource, PricingAdminExchange } from './admin-contract';

export type PricingIdentity = PricingAdminIdentity;
export type PricingRule = {
  id: string;
  identity: PricingIdentity;
  basisKind: PricingAdminBasis;
  mode: PricingAdminMode;
  baseCny: string | null;
  customPointsPerCny: string | null;
  source: PricingAdminSource | null;
  exchangeRate: PricingAdminExchange | null;
};
export type PricingPolicy = {
  schemaVersion: 1;
  revision: string;
  standards: Record<PricingAdminBasis, string | null>;
  rules: PricingRule[];
};
export type { FrozenPricingCharge } from './charge';
