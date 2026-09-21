export const MAX_GENERATION_PROMPT_CHARS = 20_000;
export const GENERATION_PROMPT_LIMIT_MESSAGE = `提示词最多 ${MAX_GENERATION_PROMPT_CHARS} 字`;

export function generationPromptLimitMessage(label: string) {
  return `${label}最多 ${MAX_GENERATION_PROMPT_CHARS} 字`;
}

export function exceedsGenerationPromptLimit(value: unknown): value is string {
  return typeof value === 'string' && value.length > MAX_GENERATION_PROMPT_CHARS;
}
