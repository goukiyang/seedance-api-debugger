export function boundedPageValue(raw: string | null, fallback: number, maximum: number) {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? Math.min(maximum, Math.max(1, value)) : fallback;
}
