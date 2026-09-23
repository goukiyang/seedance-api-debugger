export const STUDIO_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '2:1', '1:2', '21:9', '9:21', '3:1', '1:3'];
export const DEFAULT_STUDIO_ASPECT_RATIO = '1:1';

export type StudioRatioReference = { width?: unknown; height?: unknown } | null | undefined;
export type StudioAspectRatioSource = 'explicit' | 'reference' | 'model-default';

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

export function ratioFromImageDimensions(width: unknown, height: unknown): string | null {
  const w = typeof width === 'number' ? width : Number(width);
  const h = typeof height === 'number' ? height : Number(height);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0 || w / h > 3 || h / w > 3) return null;
  try { return normalizeStudioRatio(`${w}:${h}`); } catch { return null; }
}

export function resolveStudioAspectRatio(value: unknown, reference?: StudioRatioReference): {
  requested: string;
  resolved: string;
  source: StudioAspectRatioSource;
} {
  const requested = normalizeStudioRatio(value);
  if (requested !== 'auto') return { requested, resolved: requested, source: 'explicit' };
  const referenceRatio = ratioFromImageDimensions(reference?.width, reference?.height);
  return referenceRatio
    ? { requested, resolved: referenceRatio, source: 'reference' }
    : { requested, resolved: DEFAULT_STUDIO_ASPECT_RATIO, source: 'model-default' };
}

// Keep near the requested pixel budget; prefer exact ratios, otherwise disclose 16px rounding in the UI.
export function studioRatioSize(value: unknown, resolution: string = '1K'): string | undefined {
  const ratio = normalizeStudioRatio(value);
  if (ratio === 'auto') return undefined;
  const [w, h] = ratio.split(':').map(Number);
  const targetArea = resolution === '4K' ? 8294400 : resolution === '2K' ? 4194304 : resolution === '0.5K' ? 262144 : 1048576;
  const maxEdge = resolution === '4K' ? 3840 : resolution === '2K' ? 2880 : resolution === '0.5K' ? 1024 : 2048;
  const minEdge = resolution === '0.5K' ? 256 : 512;
  let best = { width: 1024, height: 1024, error: Infinity, areaDistance: Infinity };
  for (let width = 16; width <= maxEdge; width += 16) {
    const height = Math.round(width * h / w / 16) * 16;
    const area = width * height;
    if (height < minEdge || height > maxEdge || area < (resolution === '0.5K' ? 131072 : 655360) || area > targetArea || width / height > 3 || height / width > 3) continue;
    const error = Math.abs(width / height / (w / h) - 1);
    const areaDistance = Math.abs(area - targetArea);
    if (error < best.error - 1e-10 || Math.abs(error - best.error) < 1e-10 && areaDistance < best.areaDistance) best = { width, height, error, areaDistance };
  }
  return `${best.width}x${best.height}`;
}
