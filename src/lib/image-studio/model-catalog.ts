export const IMAGE_STUDIO_MODELS = [
  'gemini-3.1-flash-image-preview',
  'gemini-3-pro-image-preview',
  'gpt-image-2',
  'gpt-image-2.5-flare',
  'gpt-image-2.5-sunburst',
] as const;

export type ImageStudioModel = typeof IMAGE_STUDIO_MODELS[number];
export type ImageStudioQuality = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const IMAGE_STUDIO_MODEL_LABELS: Record<ImageStudioModel, string> = {
  'gemini-3.1-flash-image-preview': 'Banana 2',
  'gemini-3-pro-image-preview': 'Banana Pro',
  'gpt-image-2': 'GPT Image 2',
  'gpt-image-2.5-flare': 'GPT Image 2.5 Flare',
  'gpt-image-2.5-sunburst': 'GPT Image 2.5 Sunburst',
};

// Provider USD cost is deliberately separate from the site's credit price.
export const IMAGE_STUDIO_MODEL_COST_USD: Record<ImageStudioModel, number | null> = {
  'gemini-3.1-flash-image-preview': 0.06,
  'gemini-3-pro-image-preview': 0.096,
  'gpt-image-2': null,
  'gpt-image-2.5-flare': 0.064,
  'gpt-image-2.5-sunburst': 0.064,
};

export const IMAGE_STUDIO_MODEL_QUALITY_OPTIONS: Record<ImageStudioModel, ImageStudioQuality[]> = {
  'gemini-3.1-flash-image-preview': ['auto'],
  'gemini-3-pro-image-preview': ['auto'],
  'gpt-image-2': ['auto', 'low', 'medium', 'high'],
  'gpt-image-2.5-flare': ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-image-2.5-sunburst': ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
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
  return options.includes(value as ImageStudioQuality) ? value as ImageStudioQuality : defaultImageStudioQuality(model);
}
