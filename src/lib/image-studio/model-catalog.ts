export const IMAGE_STUDIO_MODELS = [
  'gemini-nano-banana-2.1',
  'gemini-3.1-flash-image-preview',
  'gemini-3-pro-image-preview',
  'gpt-image-2',
  'gpt-image-2.5-flare',
  'gpt-image-2.5-sunburst',
] as const;

// Historical model ids remain readable; only explicit new selections use this list.
export const IMAGE_STUDIO_NEW_REQUEST_MODELS = IMAGE_STUDIO_MODELS.filter(model => model !== 'gemini-3.1-flash-image-preview');

export function imageStudioModelForNewSelection(model: string): ImageStudioModel {
  if (model === 'gemini-3.1-flash-image-preview') return 'gemini-nano-banana-2.1';
  if (IMAGE_STUDIO_MODELS.includes(model as ImageStudioModel)) return model as ImageStudioModel;
  throw new Error('不支持的图片模型');
}

export type ImageStudioModel = typeof IMAGE_STUDIO_MODELS[number];
export type ImageStudioQuality = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export { defaultImageResolution, imageOutputSize, imageResolutionOptions, normalizeImageResolution, type ImageResolution } from '@/lib/image-generation/resolution';

export const IMAGE_STUDIO_MODEL_LABELS: Record<ImageStudioModel, string> = {
  'gemini-nano-banana-2.1': 'Banana 2.1',
  'gemini-3.1-flash-image-preview': 'Banana 2',
  'gemini-3-pro-image-preview': 'Banana Pro',
  'gpt-image-2': 'GPT Image 2',
  'gpt-image-2.5-flare': 'GPT Image 2.5 Flare',
  'gpt-image-2.5-sunburst': 'GPT Image 2.5 Sunburst',
};

export const IMAGE_STUDIO_MODEL_SHORT_LABELS: Record<ImageStudioModel, string> = {
  'gemini-nano-banana-2.1': 'ba2.1',
  'gemini-3.1-flash-image-preview': 'ba2',
  'gemini-3-pro-image-preview': 'baPro',
  'gpt-image-2': 'img2',
  'gpt-image-2.5-flare': 'img2.5-F',
  'gpt-image-2.5-sunburst': 'img2.5-S',
};

// Provider USD cost is deliberately separate from the site's credit price.
export const IMAGE_STUDIO_MODEL_COST_USD: Record<ImageStudioModel, number | null> = {
  'gemini-nano-banana-2.1': null,
  'gemini-3.1-flash-image-preview': 0.06,
  'gemini-3-pro-image-preview': 0.096,
  'gpt-image-2': null,
  'gpt-image-2.5-flare': 0.064,
  'gpt-image-2.5-sunburst': 0.064,
};

export const IMAGE_STUDIO_MODEL_QUALITY_OPTIONS: Record<ImageStudioModel, ImageStudioQuality[]> = {
  'gemini-nano-banana-2.1': ['auto'],
  'gemini-3.1-flash-image-preview': ['auto'],
  'gemini-3-pro-image-preview': ['auto'],
  'gpt-image-2': ['auto', 'low', 'medium', 'high'],
  'gpt-image-2.5-flare': ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-image-2.5-sunburst': ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
};

export const IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS: Record<ImageStudioModel, import('@/lib/image-generation/resolution').ImageResolution[]> = {
  'gemini-nano-banana-2.1': ['1K', '2K', '4K'],
  'gemini-3.1-flash-image-preview': ['0.5K', '1K', '2K', '4K'],
  'gemini-3-pro-image-preview': ['1K', '2K', '4K'],
  'gpt-image-2': ['1K', '2K', '4K'],
  'gpt-image-2.5-flare': ['1K', '2K', '4K'],
  'gpt-image-2.5-sunburst': ['1K', '2K', '4K'],
};

export const IMAGE_STUDIO_QUALITY_LABELS: Record<ImageStudioQuality, string> = {
  auto: '自动', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高',
};

export function defaultImageStudioQuality(model: string): ImageStudioQuality {
  const options = IMAGE_STUDIO_MODEL_QUALITY_OPTIONS[model as ImageStudioModel] || ['auto'];
  return options[options.length - 1] || 'auto';
}

export function normalizeImageStudioQuality(model: string, value: unknown): ImageStudioQuality {
  const options = IMAGE_STUDIO_MODEL_QUALITY_OPTIONS[model as ImageStudioModel] || ['auto'];
  // Preserve a retained choice for display/save; admission must reject unsupported values.
  if (model === 'gemini-nano-banana-2.1' && value !== undefined && value !== null) {
    if (Object.prototype.hasOwnProperty.call(IMAGE_STUDIO_QUALITY_LABELS, String(value))) return value as ImageStudioQuality;
    throw new Error('Banana 2.1 不支持所选图片质量；当前选择未被替换');
  }
  return options.includes(value as ImageStudioQuality) ? value as ImageStudioQuality : defaultImageStudioQuality(model);
}

export function imageStudioNewQualityOptions(model: string): ImageStudioQuality[] {
  return model === 'gpt-image-2.5-sunburst' ? ['medium', 'max'] : IMAGE_STUDIO_MODEL_QUALITY_OPTIONS[model as ImageStudioModel] || ['auto'];
}

export function imageStudioQualityLabel(model: string, quality: string): string {
  return model === 'gpt-image-2.5-sunburst' && quality === 'medium' ? '中等'
    : IMAGE_STUDIO_QUALITY_LABELS[quality as ImageStudioQuality] || quality;
}
