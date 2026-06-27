import type { VideoResolution, VideoDuration } from '@/types';

const DEFAULT_PRICING_RULE_ID = 'default-seedance-v1';
const DEFAULT_PRICING_RULE_VERSION = 1;
const ENHANCE_VIDEO_PRICING_RULE_ID = 'default-aimediakit-enhance-video-v1';
const ENHANCE_VIDEO_PRICING_RULE_VERSION = 1;

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

export interface EnhanceVideoPricingSnapshot extends PricingSnapshot {
  toolVersion: string;
  fps: number | null;
  costSource: 'rule';
  confidence: 'estimated';
}

export function calculateEstimatedCost(
  resolution: VideoResolution | string,
  duration: VideoDuration | number,
): PricingSnapshot {
  const baseCostPerSecond = resolution === '1080p' ? 18 : resolution === '720p' ? 12 : 8;
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

export function calculateEnhanceVideoEstimatedCost(input: {
  duration: number;
  resolution: string;
  toolVersion: string;
  fps?: number | null;
}): EnhanceVideoPricingSnapshot {
  const duration = Math.max(1, Math.ceil(input.duration));
  const resolution = input.resolution || '1080p';
  const toolVersion = input.toolVersion || 'standard';
  const fps = input.fps ?? null;
  const resolutionBase = resolution === '4k'
    ? 24
    : resolution === '2k'
      ? 16
      : resolution === '1080p'
        ? 10
        : resolution === '720p'
          ? 7
          : 5;
  const toolMultiplier = toolVersion === 'professional' ? 1.5 : 1.0;
  const fpsMultiplier = fps && fps > 30 ? 1.2 : 1.0;
  const internalMultiplier = Number((toolMultiplier * fpsMultiplier).toFixed(2));
  const finalCostPerSecond = Number((resolutionBase * internalMultiplier).toFixed(2));
  const estimatedCost = Math.ceil(finalCostPerSecond * duration);

  return {
    model: 'AI MediaKit enhance-video',
    resolution,
    duration,
    baseCostPerSecond: resolutionBase,
    internalMultiplier,
    finalCostPerSecond,
    estimatedCost,
    formula: `ceil(${resolutionBase} × ${internalMultiplier} × ${duration}) = ${estimatedCost}`,
    pricingRuleId: ENHANCE_VIDEO_PRICING_RULE_ID,
    pricingRuleVersion: ENHANCE_VIDEO_PRICING_RULE_VERSION,
    toolVersion,
    fps,
    costSource: 'rule',
    confidence: 'estimated',
  };
}
