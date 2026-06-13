export async function calculateEstimatedCostClient(
  resolution: string,
  duration: number,
): Promise<number> {
  try {
    const query = new URLSearchParams({
      resolution,
      duration: String(duration),
    });
    const res = await fetch(`/api/tasks/estimate?${query.toString()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('estimate failed');
    const data = await res.json();
    return Number(data.estimatedCost || 0);
  } catch {
    const baseCostPerSecond = resolution === '720p' ? 12 : 8;
    return Math.ceil(baseCostPerSecond * duration);
  }
}
