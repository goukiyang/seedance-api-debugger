import type { ContentKey } from '@/lib/content-reactions/types';
import type { ImageResultNextIntent, ImageResultNextReceipt } from './types';
export async function createImageResultHandoff(source: ContentKey, intent: ImageResultNextIntent, returnPath: string): Promise<ImageResultNextReceipt> {
  const response = await fetch('/api/image-result-next', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, intent, returnPath }), signal: AbortSignal.timeout(60_000) });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.receiptId || !body.destination) throw new Error(body?.error || '导入结果尚未确认，请查询同一次导入，不要重新提交');
  return body as ImageResultNextReceipt;
}
export async function findImageResultHandoff(source: ContentKey, intent: ImageResultNextIntent): Promise<ImageResultNextReceipt | null> {
  const response = await fetch(`/api/image-result-next?${new URLSearchParams({ source, intent })}`, { cache: 'no-store' });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || !('receipt' in body)) throw new Error(body?.error || '原导入记录暂不可读，请稍后再查询');
  return body.receipt as ImageResultNextReceipt | null;
}
export async function readImageResultHandoff(receiptId: string, signal?: AbortSignal): Promise<ImageResultNextReceipt> {
  if (!/^[a-f0-9]{64}$/.test(receiptId)) throw new Error('导入记录无效，请返回生成结果');
  const response = await fetch(`/api/image-result-next/${receiptId}`, { cache: 'no-store', signal });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.receiptId !== receiptId) throw new Error(body?.error || '原图导入暂不可读，请返回原结果');
  return body as ImageResultNextReceipt;
}
export async function resumeImageResultVideoImport(receiptId: string): Promise<ImageResultNextReceipt> {
  if (!/^[a-f0-9]{64}$/.test(receiptId)) throw new Error('导入记录无效');
  const response = await fetch(`/api/image-result-next/${receiptId}`, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'prepare-video' }) });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.receiptId !== receiptId || body.ready !== true) throw new Error(body?.error || '原首帧准备结果尚未确认，请查询原记录');
  return body as ImageResultNextReceipt;
}
