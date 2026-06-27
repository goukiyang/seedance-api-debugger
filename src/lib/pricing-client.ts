export function calculateEstimatedCostClient(
  resolution: string,
  duration: number,
): number {
  const baseCostPerSecond = resolution === '1080p' ? 18 : resolution === '720p' ? 12 : 8;
  return Math.ceil(baseCostPerSecond * duration);
}

export function calculateEnhanceVideoEstimatedCostClient(input: {
  resolution: string;
  duration: number;
  toolVersion: string;
  fps?: number | null;
}): number {
  const duration = Math.max(1, Math.ceil(input.duration || 1));
  const resolutionBase = input.resolution === '4k'
    ? 24
    : input.resolution === '2k'
      ? 16
      : input.resolution === '1080p'
        ? 10
        : input.resolution === '720p'
          ? 7
          : 5;
  const toolMultiplier = input.toolVersion === 'professional' ? 1.5 : 1;
  const fpsMultiplier = input.fps && input.fps > 30 ? 1.2 : 1;
  return Math.ceil(resolutionBase * toolMultiplier * fpsMultiplier * duration);
}
