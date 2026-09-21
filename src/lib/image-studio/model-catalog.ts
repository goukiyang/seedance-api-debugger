export const IMAGE_STUDIO_MODELS = [
  'gemini-3.1-flash-image-preview',
  'gemini-3-pro-image-preview',
  'gpt-image-2',
  'gpt-image-2.5-flare',
  'gpt-image-2.5-sunburst',
] as const;

export type ImageStudioModel = typeof IMAGE_STUDIO_MODELS[number];

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
