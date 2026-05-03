import type { VideoResolution, VideoDuration } from '@/types';

const DEFAULT_PRICING_RULE_ID = 'default-seedance-v1';
const DEFAULT_PRICING_RULE_VERSION = 1;

export interface PricingSnapshot {
  model: string;
  resolution: string;
  duration: number;
  baseCostPerSecond: number;
  internalMultiplier: number;
  finalCostPerSecond: number;
  estimatedCost: number;
  formula: string;
  pricingRuleId: string;
  pricingRuleVersion: number;
}

export function calculateEstimatedCost(
  resolution: VideoResolution | string,
  duration: VideoDuration | number,
): PricingSnapshot {
  const baseCostPerSecond = resolution === '720p' ? 12 : 8;
  const internalMultiplier = 1.0;
  const finalCostPerSecond = baseCostPerSecond * internalMultiplier;
  const estimatedCost = Math.ceil(finalCostPerSecond * (duration as number));

  return {
    model: 'Seedance 2.0',
    resolution: resolution as string,
    duration: duration as number,
    baseCostPerSecond,
    internalMultiplier,
    finalCostPerSecond,
    estimatedCost,
    formula: `ceil(${baseCostPerSecond} × ${internalMultiplier} × ${duration}) = ${estimatedCost}`,
    pricingRuleId: DEFAULT_PRICING_RULE_ID,
    pricingRuleVersion: DEFAULT_PRICING_RULE_VERSION,
  };
}
