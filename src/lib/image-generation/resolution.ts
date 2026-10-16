import { studioRatioSize } from '@/lib/image-studio/ratios';

export const IMAGE_RESOLUTION_OPTIONS = ['0.5K', '1K', '2K', '4K'] as const;
export type ImageResolution = typeof IMAGE_RESOLUTION_OPTIONS[number];

const GEMINI_MODELS = new Set(['gemini-nano-banana-2.1', 'gemini-3.1-flash-image-preview', 'gemini-3-pro-image-preview']);
const FLASH_RESOLUTIONS: ImageResolution[] = ['0.5K', '1K', '2K', '4K'];
const PRO_RESOLUTIONS: ImageResolution[] = ['1K', '2K', '4K'];
const GPT_RESOLUTIONS: ImageResolution[] = ['1K', '2K', '4K'];

export function isGeminiImageModel(model: string) {
  return GEMINI_MODELS.has(model);
}

export function supportsStudioFourToOne(model: string, provider?: string) {
  return model === 'gemini-3.1-flash-image-preview' && provider !== 'ai_media_vip';
}

export function studioFourToOneIssue(ratio: string, supported: boolean) {
  return ratio === '4:1' && !supported ? '当前模型或通道未确认支持4:1，请选择已支持的通道或其他比例。' : '';
}

export function imageResolutionOptions(model: string, provider?: string): ImageResolution[] {
  if (model === 'gemini-nano-banana-2.1') return [...PRO_RESOLUTIONS];
  if (model === 'gemini-3.1-flash-image-preview') return [...FLASH_RESOLUTIONS];
  if (model === 'gemini-3-pro-image-preview') return [...PRO_RESOLUTIONS];
  if (model.startsWith('gpt-image-')) return [...GPT_RESOLUTIONS];
  if (provider === 'seedream') return ['1K', '2K'];
  return ['1K', '2K'];
}

export function defaultImageResolution(model: string, provider?: string): ImageResolution {
  const options = imageResolutionOptions(model, provider);
  return options[options.length - 1] || '1K';
}

export function normalizeImageResolution(model: string, value: unknown, provider?: string): ImageResolution {
  const options = imageResolutionOptions(model, provider);
  if (model === 'gemini-nano-banana-2.1' && value !== undefined && value !== null) {
    if (IMAGE_RESOLUTION_OPTIONS.includes(value as ImageResolution)) return value as ImageResolution;
    throw new Error('Banana 2.1 不支持所选分辨率；当前选择未被替换');
  }
  return options.includes(value as ImageResolution) ? value as ImageResolution : options[options.length - 1] || '1K';
}

/** Local request choices, not a declaration of any supplier's capabilities. */
export function assertImageResolutionSupported(model: string, value: unknown) {
  if (model === 'gemini-nano-banana-2.1' && !imageResolutionOptions(model).includes(value as ImageResolution)) {
    throw new Error('Banana 2.1 不支持所选分辨率；请明确选择 1K、2K 或 4K，尚未向供应商提交');
  }
}

export function imageOutputSize(model: string, resolution: unknown, ratio: string, provider?: string, allowFourToOne = true): string {
  const issue = studioFourToOneIssue(ratio, allowFourToOne || supportsStudioFourToOne(model, provider));
  if (issue) throw new Error(issue);
  const normalized = normalizeImageResolution(model, resolution, provider);
  assertImageResolutionSupported(model, normalized);
  return isGeminiImageModel(model) && provider !== 'ai_media_vip'
    ? normalized
    : studioRatioSize(ratio, normalized, allowFourToOne) || studioRatioSize('1:1', normalized) || '1024x1024';
}

export function isValidImageDimension(value: unknown, allowFourToOne = false): value is string {
  if (typeof value !== 'string' || !/^\d+x\d+$/.test(value)) return false;
  const [width, height] = value.split('x').map(Number);
  return Number.isInteger(width) && Number.isInteger(height)
    && width % 16 === 0 && height % 16 === 0
    && width >= 16 && height >= 16 && Math.max(width, height) <= 3840
    && (width / height <= 3 || allowFourToOne && width === height * 4) && height / width <= 3
    && width * height >= 655360 && width * height <= 8294400;
}
