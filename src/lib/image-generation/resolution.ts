import { studioRatioSize } from '@/lib/image-studio/ratios';

export const IMAGE_RESOLUTION_OPTIONS = ['0.5K', '1K', '2K', '4K'] as const;
export type ImageResolution = typeof IMAGE_RESOLUTION_OPTIONS[number];

const GEMINI_MODELS = new Set(['gemini-3.1-flash-image-preview', 'gemini-3-pro-image-preview']);
const FLASH_RESOLUTIONS: ImageResolution[] = ['0.5K', '1K', '2K', '4K'];
const PRO_RESOLUTIONS: ImageResolution[] = ['1K', '2K', '4K'];
const GPT_RESOLUTIONS: ImageResolution[] = ['1K', '2K', '4K'];

export function isGeminiImageModel(model: string) {
  return GEMINI_MODELS.has(model);
}

export function imageResolutionOptions(model: string, provider?: string): ImageResolution[] {
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
  return options.includes(value as ImageResolution) ? value as ImageResolution : options[options.length - 1] || '1K';
}

export function imageOutputSize(model: string, resolution: unknown, ratio: string, provider?: string): string {
  const normalized = normalizeImageResolution(model, resolution, provider);
  return isGeminiImageModel(model) && provider !== 'ai_media_vip'
    ? normalized
    : studioRatioSize(ratio, normalized) || studioRatioSize('1:1', normalized) || '1024x1024';
}

export function isValidImageDimension(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d+x\d+$/.test(value)) return false;
  const [width, height] = value.split('x').map(Number);
  return Number.isInteger(width) && Number.isInteger(height)
    && width % 16 === 0 && height % 16 === 0
    && width >= 16 && height >= 16 && Math.max(width, height) <= 3840
    && width / height <= 3 && height / width <= 3
    && width * height >= 655360 && width * height <= 8294400;
}
