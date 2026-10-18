import { createHash } from 'node:crypto';
import { legacyStudioRatioSize, studioRatioSize, type StudioAspectRatioSource } from '@/lib/image-studio/ratios';
import { isValidImageDimension } from './resolution';

export type ImageRatioContractVersion = 2 | 3;
export type ImageOutputPlan = {
  version: 1;
  algorithmRevision: 'pixel-budget-v3' | 'native-v1' | 'adapter-v2' | 'explicit-v1';
  requestedResolution: string;
  requestedRatio: string;
  resolvedRatio: string;
  aspectRatioSource: StudioAspectRatioSource;
  outputSize: string;
  width: number | null;
  height: number | null;
  targetPixels: number | null;
  pixels: number | null;
  pixelCoverage: number | null;
  relativeRatioError: number | null;
  wireMode: 'size-only' | 'native' | 'size-and-ratio';
};

/** Only call with a server-owned saved batch/avatar/snapshot, never a client body. */
export function savedImageRatioContractVersion(saved: { ratioContractVersion?: unknown }): ImageRatioContractVersion {
  if (saved.ratioContractVersion === undefined || saved.ratioContractVersion === 2) return 2;
  if (saved.ratioContractVersion === 3) return 3;
  throw new Error('保存的图片规格版本无法识别，原计划未改动');
}

export function resolveImageOutputPlan(input: {
  model: string; resolution: string; ratio: string; requestedRatio?: string;
  aspectRatioSource?: StudioAspectRatioSource; native?: boolean; allowFourToOne?: boolean;
  explicitSize?: string; ratioContractVersion?: ImageRatioContractVersion;
}): ImageOutputPlan {
  const native = input.native === true;
  if (input.explicitSize && !isValidImageDimension(input.explicitSize, input.allowFourToOne !== false)) {
    throw new Error('指定宽高不符合当前像素通道限制；未替换尺寸，尚未提交');
  }
  const pixelV3 = !native && input.model.startsWith('gpt-image-') && input.ratioContractVersion !== 2;
  const outputSize = input.explicitSize || (native ? input.resolution
    : (pixelV3 ? studioRatioSize : legacyStudioRatioSize)(input.ratio, input.resolution, input.allowFourToOne !== false));
  if (!outputSize) throw new Error('本次图片规格未解析为明确尺寸，尚未提交');
  const match = /^(\d+)x(\d+)$/.exec(outputSize);
  const width = match ? Number(match[1]) : null, height = match ? Number(match[2]) : null;
  const pixels = width && height ? width * height : null;
  const targetPixels = native || input.explicitSize ? null : input.resolution === '4K' ? 8294400
    : input.resolution === '2K' ? 4194304 : input.resolution === '0.5K' ? 262144 : 1048576;
  const [rw, rh] = input.ratio.split(':').map(Number);
  return { version: 1, algorithmRevision: input.explicitSize ? 'explicit-v1' : native ? 'native-v1'
    : pixelV3 ? 'pixel-budget-v3' : 'adapter-v2', requestedResolution: input.resolution,
    requestedRatio: input.requestedRatio || input.ratio, resolvedRatio: input.ratio,
    aspectRatioSource: input.aspectRatioSource || 'explicit', outputSize, width, height, targetPixels, pixels,
    pixelCoverage: pixels && targetPixels ? pixels / targetPixels : null,
    relativeRatioError: width && height && rw > 0 && rh > 0 ? Math.abs(width / height / (rw / rh) - 1) : null,
    wireMode: native ? 'native' : pixelV3 ? 'size-only' : 'size-and-ratio' };
}

export function imageOutputPlanHash(plan: ImageOutputPlan): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

/** Explicit allowlist: no provider configuration, identity, diagnostics or URLs. */
export function parseImageOutputPlan(value: unknown): ImageOutputPlan | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const plan = value as ImageOutputPlan;
  if (plan.version !== 1 || !['pixel-budget-v3', 'native-v1', 'adapter-v2', 'explicit-v1'].includes(plan.algorithmRevision)
    || !['size-only', 'native', 'size-and-ratio'].includes(plan.wireMode)
    || !['explicit', 'reference', 'model-default'].includes(plan.aspectRatioSource)
    || [plan.requestedResolution, plan.requestedRatio, plan.resolvedRatio, plan.outputSize].some(item => typeof item !== 'string' || item.length > 40)
    || [plan.width, plan.height, plan.targetPixels, plan.pixels, plan.pixelCoverage, plan.relativeRatioError]
      .some(item => item !== null && (typeof item !== 'number' || !Number.isFinite(item) || item < 0))) return null;
  return { version: 1, algorithmRevision: plan.algorithmRevision, requestedResolution: plan.requestedResolution,
    requestedRatio: plan.requestedRatio, resolvedRatio: plan.resolvedRatio, aspectRatioSource: plan.aspectRatioSource,
    outputSize: plan.outputSize, width: plan.width, height: plan.height, targetPixels: plan.targetPixels,
    pixels: plan.pixels, pixelCoverage: plan.pixelCoverage, relativeRatioError: plan.relativeRatioError, wireMode: plan.wireMode };
}

export type PublicImageOutputPlan = Omit<ImageOutputPlan, 'version' | 'algorithmRevision' | 'wireMode'>;
export function publicImageOutputPlan(value: unknown): PublicImageOutputPlan | null {
  const plan = parseImageOutputPlan(value);
  if (!plan) return null;
  const { version: _version, algorithmRevision: _algorithmRevision, wireMode: _wireMode, ...visible } = plan;
  return visible;
}

export type SynchronousImageOutputPreview = { quoteOnly: true; submitted: false; model: string; count: number;
  outputPlan: PublicImageOutputPlan | null; outputPlans: Array<PublicImageOutputPlan | null> };

/** The complete synchronous write/provider path is deferred behind this branch. */
export async function withSynchronousImageOutputPlan<T>(input: { quote: boolean; outputPlan: ImageOutputPlan; model: string; count: number },
  submit: () => Promise<T>, preview: (view: SynchronousImageOutputPreview) => T | Promise<T>): Promise<T> {
  if (input.quote) {
    const outputPlan = publicImageOutputPlan(input.outputPlan);
    return preview({ quoteOnly: true, submitted: false, model: input.model, count: input.count, outputPlan, outputPlans: [outputPlan] });
  }
  return submit();
}
