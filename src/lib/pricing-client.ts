export function calculateEstimatedCostClient(
  resolution: string,
  duration: number,
): number {
  const baseCostPerSecond = resolution === '1080p' ? 18 : resolution === '720p' ? 12 : 8;
  return Math.ceil(baseCostPerSecond * duration);
}
