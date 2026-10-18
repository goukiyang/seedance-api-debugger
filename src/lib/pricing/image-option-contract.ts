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
};
