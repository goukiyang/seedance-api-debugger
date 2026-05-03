import { prisma } from '@/lib/prisma';
import type { VideoDuration, VideoResolution } from '@/types';

const DEFAULT_MODEL = 'dreamina-seedance-2-0-260128';
const DEFAULT_PRICING_RULE_ID = 'default-seedance-v1';
const DEFAULT_PRICING_RULE_VERSION = 1;

export interface PricingSnapshot {
  model: string;
  resolution: string;
  duration: number;
  isFast: boolean;
  baseCostPerSecond: number;
  internalMultiplier: number;
  finalCostPerSecond: number;
  estimatedCost: number;
  formula: string;
  pricingRuleId: string;
  pricingRuleVersion: number;
  pricingRuleName?: string;
  effectiveAt?: string;
}

function roundPricingValue(value: number) {
  return Math.round(value * 10000) / 10000;
}

function buildPricingSnapshot(input: {
  model: string;
  resolution: string;
  duration: number;
  isFast?: boolean;
  baseCostPerSecond: number;
  internalMultiplier: number;
  pricingRuleId: string;
  pricingRuleVersion: number;
  pricingRuleName?: string;
  effectiveAt?: Date;
}): PricingSnapshot {
  const finalCostPerSecond = roundPricingValue(input.baseCostPerSecond * input.internalMultiplier);
  const estimatedCost = Math.ceil(finalCostPerSecond * input.duration);

  return {
    model: input.model,
    resolution: input.resolution,
    duration: input.duration,
    isFast: Boolean(input.isFast),
    baseCostPerSecond: input.baseCostPerSecond,
    internalMultiplier: input.internalMultiplier,
    finalCostPerSecond,
    estimatedCost,
    formula: `ceil(${input.baseCostPerSecond} × ${input.internalMultiplier} × ${input.duration}) = ${estimatedCost}`,
    pricingRuleId: input.pricingRuleId,
    pricingRuleVersion: input.pricingRuleVersion,
    pricingRuleName: input.pricingRuleName,
    effectiveAt: input.effectiveAt?.toISOString(),
  };
}

export function calculateEstimatedCostFallback(
  resolution: VideoResolution | string,
  duration: VideoDuration | number,
  model = DEFAULT_MODEL,
): PricingSnapshot {
  const baseCostPerSecond = resolution === '720p' ? 12 : 8;

  return buildPricingSnapshot({
    model,
    resolution: resolution as string,
    duration: duration as number,
    isFast: false,
    baseCostPerSecond,
    internalMultiplier: 1,
    pricingRuleId: DEFAULT_PRICING_RULE_ID,
    pricingRuleVersion: DEFAULT_PRICING_RULE_VERSION,
    pricingRuleName: 'Default Seedance Rule',
  });
}

export async function getPricingSnapshot(params: {
  model?: string;
  resolution: VideoResolution | string;
  duration: VideoDuration | number;
  isFast?: boolean;
}): Promise<PricingSnapshot> {
  const model = params.model || DEFAULT_MODEL;
  const resolution = params.resolution as string;
  const duration = params.duration as number;
  const isFast = Boolean(params.isFast);

  const activeRule = await prisma.pricingRule.findFirst({
    where: {
      model,
      resolution,
      is_fast: isFast,
      status: 'active',
      effective_at: { lte: new Date() },
    },
    orderBy: [
      { effective_at: 'desc' },
      { version: 'desc' },
      { created_at: 'desc' },
    ],
  });

  if (!activeRule) {
    return calculateEstimatedCostFallback(resolution, duration, model);
  }

  return buildPricingSnapshot({
    model: activeRule.model,
    resolution: activeRule.resolution,
    duration,
    isFast: activeRule.is_fast,
    baseCostPerSecond: activeRule.base_cost_per_second,
    internalMultiplier: activeRule.internal_multiplier,
    pricingRuleId: activeRule.id,
    pricingRuleVersion: activeRule.version,
    pricingRuleName: activeRule.name,
    effectiveAt: activeRule.effective_at,
  });
}
