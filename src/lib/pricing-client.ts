export function calculateEstimatedCostClient(
  resolution: string,
  duration: number,
): number {
  const baseCostPerSecond = resolution === '720p' ? 12 : 8;
  return Math.ceil(baseCostPerSecond * duration);
}
