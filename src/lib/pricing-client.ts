export interface ClientPricingSnapshot {
  model: string;
  resolution: string;
  duration: number;
  baseCostPerSecond: number;
  internalMultiplier: number;
  finalCostPerSecond: number;
  estimatedCost: number;
  formula: string;
}

export function calculateEstimatedCostClient(
  resolution: string,
  duration: number,
): ClientPricingSnapshot | null {
  if (resolution !== '720p' || duration !== 5) {
    return null;
  }

  return {
    model: 'Seedance 2.0',
    resolution,
    duration,
    baseCostPerSecond: 12,
    internalMultiplier: 1.0,
    finalCostPerSecond: 12,
    estimatedCost: 60,
    formula: '12 × 1.0 × 5 = 60',
  };
}
