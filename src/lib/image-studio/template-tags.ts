export const TEMPLATE_TAG_PREFIX = 'studio_shared_tags_v1:';
export const TEMPLATE_TAG_LIMIT = 6;
export const TEMPLATE_TAG_LENGTH = 16;
export type TemplateTagMetadata = { version: 1; revision: number; tags: string[] };

export function orderTemplateTags(counts: Iterable<readonly [string, number]>): string[] {
  return Array.from(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN')).map(([tag]) => tag);
}

export function parseTemplateTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > TEMPLATE_TAG_LIMIT
    || value.some(tag => typeof tag !== 'string' || !tag.trim() || tag.trim().length > TEMPLATE_TAG_LENGTH || /[\u0000-\u001f\u007f]/.test(tag))) {
    throw new Error(`最多${TEMPLATE_TAG_LIMIT}个标签，每个标签1–${TEMPLATE_TAG_LENGTH}个字`);
  }
  return Array.from(new Set(value.map(tag => (tag as string).trim())));
}
