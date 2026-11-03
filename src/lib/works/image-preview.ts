'use client';

import { prepareImagePreview, type ImagePreviewPreparation } from '@/lib/media/image-preview-session';
import type { WorkCard } from './types';

type WorkImage = Pick<WorkCard, 'id' | 'mediaVersion' | 'medium' | 'detailPreviewUrl' | 'previewUrl' | 'previewStatus' | 'downloadUrl' | 'reuse'>;
export type PreparedWorkImage = { workId: string; mediaVersion: string; handle: ImagePreviewPreparation };

export function prepareWorkImage(account: string, work: WorkImage): PreparedWorkImage | undefined {
  const source = work.detailPreviewUrl || (work.previewStatus === 'ready' ? work.previewUrl : null);
  if (!account || work.medium !== 'image' || !source) return;
  return { workId: work.id, mediaVersion: work.mediaVersion,
    handle: prepareImagePreview({ account, source, previewOnly: !work.downloadUrl && !work.reuse }) };
}

/** List data starts an authorized read; fresh detail data decides whether to use it. */
export function matchesWorkImage(prepared: PreparedWorkImage | undefined, account: string, work: WorkImage): boolean {
  return Boolean(prepared && work.medium === 'image' && prepared.workId === work.id && prepared.mediaVersion === work.mediaVersion
    && prepared.handle.account === account && prepared.handle.source === (work.detailPreviewUrl || (work.previewStatus === 'ready' ? work.previewUrl : null))
    && prepared.handle.previewOnly === (!work.downloadUrl && !work.reuse) && prepared.handle.isCurrent());
}
