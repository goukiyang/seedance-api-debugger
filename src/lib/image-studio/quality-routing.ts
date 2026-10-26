export const IMAGE_25_QUALITY_MODEL = 'gpt-image-2.5-sunburst' as const;
export const IMAGE_25_QUALITIES = ['medium', 'max'] as const;
export type Image25Quality = typeof IMAGE_25_QUALITIES[number];
export type ImageQualityRoutes = Partial<Record<typeof IMAGE_25_QUALITY_MODEL, Partial<Record<Image25Quality, string>>>>;
export type ImageQualityRouteSnapshot = { model: typeof IMAGE_25_QUALITY_MODEL; quality: Image25Quality; revision: number };

export function isImage25Quality(value: unknown): value is Image25Quality {
  return value === 'medium' || value === 'max';
}

export function parseImageQualityRouteSnapshot(value: unknown): ImageQualityRouteSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !['model', 'quality', 'revision'].includes(key))
    || row.model !== IMAGE_25_QUALITY_MODEL || !isImage25Quality(row.quality)
    || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0) return null;
  return { model: row.model, quality: row.quality, revision: Number(row.revision) };
}

export function assertImageQualityReferenceCount(route: ImageQualityRouteSnapshot | undefined, count: number) {
  if (route?.quality === 'medium' && count > 7) throw new Error('中等档主图和各类参考图合计最多7张；原素材已保留，请调整后再生成');
}
