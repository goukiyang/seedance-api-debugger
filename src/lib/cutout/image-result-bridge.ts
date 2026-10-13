import type { CutoutSettings } from './types';
import type { CutoutImageHandoff } from '@/lib/image-result-next/types';
export type { CutoutImageHandoff } from '@/lib/image-result-next/types';
async function request(receiptId: string, body?: unknown, signal?: AbortSignal): Promise<CutoutImageHandoff> {
  if (!/^[a-f0-9]{64}$/.test(receiptId)) throw new Error('导入记录无效，请返回原结果');
  const response = await fetch(`/api/image-result-next/${receiptId}/cutout`, { cache: 'no-store', signal,
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const value = await response.json().catch(() => null);
  if (!response.ok || value?.receiptId !== receiptId || value?.intent !== 'cutout' || !value?.source?.originalUrl) throw new Error(value?.error || '此次导入尚未确认，请查询原记录后继续');
  return value as CutoutImageHandoff;
}
export const getImageResultCutoutHandoff = (receiptId: string, signal?: AbortSignal) => request(receiptId, undefined, signal);
export const prepareImageResultCutoutHandoff = (receiptId: string) => request(receiptId, { action: 'prepare' });
export const startImageResultCutoutHandoff = (receiptId: string, options: { settings: CutoutSettings; confirmUnknownPrice: boolean }) => request(receiptId, { action: 'start', ...options });
