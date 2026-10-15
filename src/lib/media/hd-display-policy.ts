import type { HdDescription } from './hd-source-session';

export type HdDisplayKind = 'original' | 'hd' | 'preview' | 'pending';

export function hdDescriptionUsesOriginal(description?: HdDescription) {
  return description?.status === 'ready' && (description.original === true || description.format === 'original');
}

/** The descriptor selects a representation, never whether the caller is authorized. */
export function hdDisplayPolicy({ original, previewOnly, supported, description, error = false }: {
  original: boolean; previewOnly: boolean; supported: boolean; description?: HdDescription; error?: boolean;
}) {
  const kind: HdDisplayKind = previewOnly ? 'preview'
    : original || !supported ? 'original'
      : !description && !error ? 'pending'
        : description?.status === 'ready' && !hdDescriptionUsesOriginal(description) ? 'hd' : 'original';
  const pending = supported && !previewOnly && !original && !error && (!description || description.status === 'queued' || description.status === 'running');
  return { kind, pending, fullSize: kind !== 'preview' && kind !== 'pending' };
}

export function hdDisplayLabel(kind: HdDisplayKind, description?: HdDescription, fallback = false) {
  if (kind === 'pending') return '正在确认高清';
  if (kind === 'preview') return '轻量预览';
  if (kind === 'hd') return '原尺寸高清';
  if (fallback) return '完整原图（高清暂不可用）';
  return hdDescriptionUsesOriginal(description) ? '完整原图（无需额外压缩）' : '完整原图';
}

export function hdAvailabilityLabel(description?: HdDescription) {
  if (description?.reason === 'remote_version_unknown') return '远端图片版本暂无法确认，可主动查看或下载原图';
  if (description?.status === 'failed') return '高清压缩未完成，可查看或下载完整原图';
  if (description?.status === 'skipped') return '此图使用完整原图，不另做高清压缩';
  if (hdDescriptionUsesOriginal(description)) return '原图已是合适文件，无需额外压缩';
  return '高清压缩档尚未就绪，可查看或下载完整原图';
}
