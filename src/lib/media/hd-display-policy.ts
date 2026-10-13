import type { HdDescription } from './hd-source-session';

export type HdDisplayKind = 'original' | 'hd' | 'preview';

export function hdDescriptionUsesOriginal(description?: HdDescription) {
  return description?.status === 'ready' && (description.original === true || description.format === 'original');
}

/** The descriptor selects a representation, never whether the caller is authorized. */
export function hdDisplayPolicy({ original, previewOnly, supported, description, error = false }: {
  original: boolean; previewOnly: boolean; supported: boolean; description?: HdDescription; error?: boolean;
}) {
  const kind: HdDisplayKind = previewOnly ? 'preview'
    : original || description?.status !== 'ready' || hdDescriptionUsesOriginal(description) ? 'original' : 'hd';
  const pending = supported && !previewOnly && !original && !error && (!description || description.status === 'queued' || description.status === 'running');
  return { kind, pending, fullSize: kind !== 'preview' };
}

export function hdDisplayLabel(kind: HdDisplayKind, description?: HdDescription, fallback = false) {
  if (kind === 'preview') return '轻量预览';
  if (kind === 'hd') return '原尺寸高清';
  if (fallback) return '完整原图（高清显示失败）';
  return hdDescriptionUsesOriginal(description) ? '完整原图（无需额外压缩）' : '完整原图';
}

export function hdAvailabilityLabel(description?: HdDescription) {
  if (description?.status === 'failed') return '高清压缩未完成，可查看或下载完整原图';
  if (description?.status === 'skipped') return '此图使用完整原图，不另做高清压缩';
  if (hdDescriptionUsesOriginal(description)) return '原图已是合适文件，无需额外压缩';
  return '高清压缩档尚未就绪，可查看或下载完整原图';
}
