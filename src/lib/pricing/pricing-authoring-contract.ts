// Management metadata only. Runtime charges always use pricing_policy_v1.
export const PRICING_AUTHORING_KEY = 'pricing_authoring_v1';
export const PRICING_AUTHORING_CAPABILITY = 'pricing-authoring-v1';
export type PricingAuthoringRateMode = 'follow_global' | 'custom' | 'legacy_follow';
export type PricingEvidence = {
  kind: 'user_provided' | 'historical_statement' | 'derived' | 'admin_defined' | 'unconfirmed';
  amount: string;
  currency: 'CNY' | 'USD';
  unit: 'image' | 'second';
  specifications: Record<string, string>;
  sampledAt: string | null;
  exchangeAssumption: string | null;
  reference: string;
  version: string;
};
export type PricingBaseRelation = {
  parentId: string;
  factor: string;
  parentRevision: string;
  exactProduct: string;
};
export type PricingAuthoringEntry = {
  adoptedRevision: string;
  sourceKind: PricingEvidence['kind'];
  evidence: PricingEvidence | null;
  baseRelation: PricingBaseRelation | null;
};
export type PricingAuthoring = {
  enhanceGroup?: PricingEnhanceGroup;
  schemaVersion: 1;
  revision: string;
  policyRevision: string;
  globalPointsPerCny: string | null;
  members: string[];
  entries: Record<string, PricingAuthoringEntry>;
};
export type PricingEnhanceGroup = {
  basePointsPerSecond: Record<'480p' | '720p' | '1080p' | '2k' | '4k', string>;
  professionalMultiplier: string;
  highFpsMultiplier: string;
};
export type PricingAuthoringChange = { globalPointsPerCny?: string; enhanceGroup?: PricingEnhanceGroup };
export type PricingVideoPurpose = 'standard' | 'draft' | 'draft_upgrade' | 'unknown';
export type PricingReferenceVideo = 'none' | 'present' | 'unknown';
export type PricingImageSpecifications = { quality?: string; resolution?: string; ratio?: string };

export function normalizePricingImageSpecifications(value: PricingImageSpecifications = {}): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ['quality', 'resolution', 'ratio'] as const) {
    const item = value[key];
    if (item === undefined || item === null || item === '') continue;
    if (typeof item !== 'string' || item.length > 64 || !/^[a-zA-Z0-9_.:/-]+$/.test(item)) throw new Error('图片计价规格无效');
    result[key] = key === 'resolution' && /^\d+k$/i.test(item) ? item.toUpperCase() : item;
  }
  return result;
}
