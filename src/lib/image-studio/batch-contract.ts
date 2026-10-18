import { creditCents } from '@/lib/credits/precision';

export const STUDIO_BATCH_LIMITS = { images: 100, files: 100, fileBytes: 30 * 1024 * 1024, totalBytes: 256 * 1024 * 1024, activeBatches: 5, zipImages: 8, zipBytes: 128 * 1024 * 1024 } as const;
export type StudioBatchItemView = { ordinal: number; sourceName: string; taskId: string | null; status: string; resultDisposition?: 'dimensions_mismatch' | 'format_mismatch' | null; error?: string | null; delivery?: { phase: string; acceptedAt?: number; waitingStatus?: 'pending' | 'retrying' | 'unconfirmed'; generationDetailSuperseded?: boolean }; billing?: import('./billing-contract').ImageBillingView | null; image?: { id: string; url: string; thumbnail: string; fileSize: number; fileName?: string; mimeType?: string } | null };
export type StudioBatchView = { id: string; requestId: string; moduleId: string; moduleName: string; model?: string; sharedLive?: import('./shared-types').SharedStudioIntent; definitionConfirmationRequired?: boolean; state: string; note: string; total: number; generated: number; failed: number; uncertain: number; active: number; pending: number; prepared: number; budget: number; committedCredits: number; unitCredits: number; pricingRevision?: string | null; creditPrecision?: 0.01 | 0.1; createdAt: string; items?: StudioBatchItemView[] };
export function studioBatchBudgetPrecision(pricingRevision: string | null | undefined, creditPrecision: 0.01 | 0.1, committedCredits = 0): 1 | 0.1 | 0.01 {
  if (!pricingRevision) return 1;
  return creditPrecision === 0.1 && creditCents(committedCredits) % 10 === 0 ? 0.1 : 0.01;
}
export function safeBatchFileName(batchId: string, ordinal: number, sourceName: string, extension = 'png') {
  const stem = sourceName.replace(/\.[^.]+$/, '').replace(new RegExp('[^\\p{L}\\p{N}_-]+', 'gu'), '_').slice(0, 60) || 'image';
  return `${String(ordinal).padStart(3, '0')}-${stem}-${batchId.slice(0, 12)}.${extension}`;
}
export function batchStateLabel(state: string) {
  return ({ preparing: '准备素材', ready: '进行中', paused: '已暂停派发', blocked: '需处理', 'needs-confirmation': '模板已更新，待确认', cancelled: '已取消未派发项', uncertain: '结果待确认', complete: '本批已结束' } as Record<string, string>)[state] || '状态待确认';
}
