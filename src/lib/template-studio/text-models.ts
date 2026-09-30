export const STUDIO_TEXT_MODELS = [
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna' },
  { id: 'gpt-6-sol', label: 'GPT-6 Sol' },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
] as const;

export function isStudioTextModel(value: unknown): value is string {
  return typeof value === 'string' && STUDIO_TEXT_MODELS.some(model => model.id === value);
}

export function studioTextModelLabel(value: string) {
  return STUDIO_TEXT_MODELS.find(model => model.id === value)?.label || value;
}
