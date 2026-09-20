export const STUDIO_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '2:1', '1:2', '21:9', '9:21', '3:1', '1:3'];

export function normalizeStudioRatio(value: unknown): string {
  if (value === 'auto' || value === undefined) return 'auto';
  if (typeof value !== 'string' || value.length > 30) throw new Error('请输入有效比例，例如 16:9');
  const match = value.trim().match(/^(\d{1,5}(?:\.\d{1,2})?)\s*[:：/]\s*(\d{1,5}(?:\.\d{1,2})?)$/);
  if (!match) throw new Error('请输入宽:高，例如 16:9，最多两位小数');
  const width = Math.round(Number(match[1]) * 100), height = Math.round(Number(match[2]) * 100);
  if (!width || !height || width / height > 3 || height / width > 3) throw new Error('宽高须大于 0，比例须在 1:3 至 3:1 之间');
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  const divisor = gcd(width, height);
  if (width / divisor > 99999 || height / divisor > 99999) throw new Error('比例数值过于精细，请简化后重新输入');
  return `${width / divisor}:${height / divisor}`;
}

// Keep near 1 megapixel; prefer exact ratios, otherwise disclose 16px rounding in the UI.
export function studioRatioSize(value: unknown): string | undefined {
  const ratio = normalizeStudioRatio(value);
  if (ratio === 'auto') return undefined;
  const [w, h] = ratio.split(':').map(Number);
  let best = { width: 1024, height: 1024, error: Infinity, areaDistance: Infinity };
  for (let width = 512; width <= 2048; width += 16) {
    const height = Math.round(width * h / w / 16) * 16;
    const area = width * height;
    if (height < 512 || height > 2048 || area < 655360 || area > 1572864 || width / height > 3 || height / width > 3) continue;
    const error = Math.abs(width / height / (w / h) - 1);
    const areaDistance = Math.abs(area - 1048576);
    if (error < best.error - 1e-10 || Math.abs(error - best.error) < 1e-10 && areaDistance < best.areaDistance) best = { width, height, error, areaDistance };
  }
  return `${best.width}x${best.height}`;
}
