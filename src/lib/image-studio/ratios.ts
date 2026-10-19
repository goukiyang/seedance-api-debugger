export const STUDIO_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '2:1', '1:2', '21:9', '9:21', '3:1', '1:3', '4:1'];
export const DEFAULT_STUDIO_ASPECT_RATIO = '1:1';

export type StudioRatioReference = { width?: unknown; height?: unknown } | null | undefined;
export type StudioAspectRatioSource = 'explicit' | 'reference' | 'model-default';

export function normalizeStudioRatio(value: unknown): string {
  if (value === 'auto' || value === undefined) return 'auto';
  if (typeof value !== 'string' || value.length > 30) throw new Error('请输入有效比例，例如 16:9');
  const match = value.trim().match(/^(\d{1,5}(?:\.\d{1,2})?)\s*[:：/]\s*(\d{1,5}(?:\.\d{1,2})?)$/);
  if (!match) throw new Error('请输入宽:高，例如 16:9，最多两位小数');
  const width = Math.round(Number(match[1]) * 100), height = Math.round(Number(match[2]) * 100);
  if (!width || !height || (width / height > 3 && width !== height * 4) || height / width > 3) throw new Error('宽高须大于 0，支持 1:3 至 3:1，以及 4:1');
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  const divisor = gcd(width, height);
  if (width / divisor > 99999 || height / divisor > 99999) throw new Error('比例数值过于精细，请简化后重新输入');
  // Keep standard names stable through saving, quoting and provider requests.
  // In particular, 21:9 and 9:21 must not become unregistered 7:3 and 3:7.
  const standard = STUDIO_RATIOS.find(item => {
    const [w, h] = item.split(':').map(Number);
    return width * h === height * w;
  });
  return standard || `${width / divisor}:${height / divisor}`;
}

export function isStandardStudioRatio(value: unknown): boolean {
  try { return value === 'auto' || STUDIO_RATIOS.includes(normalizeStudioRatio(value)); }
  catch { return false; }
}

export function ratioFromImageDimensions(width: unknown, height: unknown, allowFourToOne = true): string | null {
  const w = typeof width === 'number' ? width : Number(width);
  const h = typeof height === 'number' ? height : Number(height);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0
    || (w / h > 3 && !(allowFourToOne && w === h * 4)) || h / w > 3) return null;
  try { return normalizeStudioRatio(`${w}:${h}`); } catch { return null; }
}

export function resolveStudioAspectRatio(value: unknown, reference?: StudioRatioReference, allowFourToOne = true, requireReferenceRatio = false): {
  requested: string;
  resolved: string;
  source: StudioAspectRatioSource;
} {
  const requested = normalizeStudioRatio(value);
  if (requested !== 'auto') return { requested, resolved: requested, source: 'explicit' };
  const referenceRatio = ratioFromImageDimensions(reference?.width, reference?.height, allowFourToOne);
  if (requireReferenceRatio && reference && !referenceRatio) throw new Error('原图比例无法在当前安全范围内表达，请明确选择图片比例；未改为1:1');
  return referenceRatio
    ? { requested, resolved: referenceRatio, source: 'reference' }
    : { requested, resolved: DEFAULT_STUDIO_ASPECT_RATIO, source: 'model-default' };
}

// Keep near the requested pixel budget; prefer exact ratios, otherwise disclose 16px rounding in the UI.
export function legacyStudioRatioSize(value: unknown, resolution: string = '1K', allowFourToOne = true): string | undefined {
  const ratio = normalizeStudioRatio(value);
  if (ratio === 'auto') return undefined;
  if (ratio === '4:1' && !allowFourToOne) throw new Error('当前像素尺寸通道未确认支持4:1，请选择其他比例');
  const [w, h] = ratio.split(':').map(Number);
  const targetArea = resolution === '4K' ? 8294400 : resolution === '2K' ? 4194304 : resolution === '0.5K' ? 262144 : 1048576;
  const maxEdge = resolution === '4K' ? 3840 : resolution === '2K' ? 2880 : resolution === '0.5K' ? 1024 : 2048;
  const minEdge = resolution === '0.5K' ? 256 : 512;
  let best = { width: 1024, height: 1024, error: Infinity, areaDistance: Infinity };
  for (let width = 16; width <= maxEdge; width += 16) {
    const height = Math.round(width * h / w / 16) * 16;
    const area = width * height;
    if (ratio === '4:1' && width !== height * 4) continue;
    if (height < minEdge || height > maxEdge || area < (resolution === '0.5K' ? 131072 : 655360) || area > targetArea
      || (width / height > 3 && !(allowFourToOne && ratio === '4:1' && width === height * 4)) || height / width > 3) continue;
    const error = Math.abs(width / height / (w / h) - 1);
    const areaDistance = Math.abs(area - targetArea);
    if (error < best.error - 1e-10 || Math.abs(error - best.error) < 1e-10 && areaDistance < best.areaDistance) best = { width, height, error, areaDistance };
  }
  if (!Number.isFinite(best.error)) throw new Error('所选比例与分辨率无法在安全像素范围内表达，请调整分辨率');
  return `${best.width}x${best.height}`;
}

/** Pixel contract v3: keep the pixel budget first, within the disclosed ratio tolerance. */
export function studioRatioSize(value: unknown, resolution: string = '1K', allowFourToOne = true): string | undefined {
  if (resolution === '0.5K') return legacyStudioRatioSize(value, resolution, allowFourToOne);
  const ratio = normalizeStudioRatio(value);
  if (ratio === 'auto') return undefined;
  if (ratio === '4:1' && !allowFourToOne) throw new Error('当前像素尺寸通道未确认支持4:1，请选择其他比例');
  const [w, h] = ratio.split(':').map(Number);
  const targetArea = resolution === '4K' ? 8294400 : resolution === '2K' ? 4194304 : 1048576;
  // 3840 is this pixel adapter's validated domain, not the old local 2K policy cap.
  let best: { width: number; height: number; error: number; area: number } | undefined;
  for (let width = 512; width <= 3840; width += 16) {
    for (let height = 512; height <= 3840; height += 16) {
      const area = width * height;
      if (area > targetArea || area < targetArea * 0.95
        || (width / height > 3 && !(allowFourToOne && ratio === '4:1' && width === height * 4)) || height / width > 3) continue;
      const error = Math.abs(width / height / (w / h) - 1);
      if (error > 0.005 + 1e-12 || ratio === '4:1' && width !== height * 4) continue;
      if (!best || area > best.area || area === best.area && error < best.error) best = { width, height, error, area };
    }
  }
  if (!best) throw new Error(`所选${resolution}与${ratio}在当前通道边长限制内无法同时满足像素量和比例；请明确调整选择，尚未提交`);
  return `${best.width}x${best.height}`;
}
