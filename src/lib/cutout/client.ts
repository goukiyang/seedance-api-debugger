import type { CutoutAsset, CutoutCapabilities, CutoutHistory, CutoutJob, CutoutKind } from './types';

const API = '/api/cutout/v1';
export class CutoutRequestError extends Error {
  constructor(message: string, public status: number, public code?: string, public submissionMade: boolean | null = null) { super(message); }
}
export async function cutoutRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch(`${API}${path}`, { ...init, signal: controller.signal, cache: 'no-store' });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.success === false) {
      throw new CutoutRequestError(body?.message || body?.detail?.message || '请求未完成，请重试', response.status, body?.error || body?.detail?.code,
        typeof body?.submission_made === 'boolean' ? body.submission_made : null);
    }
    if (!body || typeof body !== 'object') throw new CutoutRequestError('抠图服务回复不完整，请重试', 502);
    return body as T;
  } catch (error) {
    if (error instanceof CutoutRequestError) throw error;
    throw new CutoutRequestError('网络连接中断，原图与任务保留，请重新查询', 0);
  } finally { clearTimeout(timer); }
}
export const getCutoutCapabilities = () => cutoutRequest<CutoutCapabilities>('/capabilities');
export function uploadCutoutAsset(file: Blob, name = 'image.png') {
  const data = new FormData(); data.append('file', file, name);
  return cutoutRequest<CutoutAsset>('/assets', { method: 'POST', body: data });
}
export function createCutoutJob(assetId: string, kind: CutoutKind, parameters: Record<string, unknown>, idempotencyKey: string) {
  return cutoutRequest<CutoutJob>('/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ asset_id: assetId, kind, parameters }),
  });
}
export const getCutoutJob = (id: string) => cutoutRequest<CutoutJob>(`/jobs/${encodeURIComponent(id)}`);
export const cancelCutoutJob = (id: string) => cutoutRequest<CutoutJob>(`/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const getCutoutHistory = (offset = 0, limit = 12) => cutoutRequest<CutoutHistory>(`/jobs/history?limit=${limit}&offset=${offset}`);
export async function downloadCutoutBlob(url: string): Promise<Blob> {
  if (!/^\/api\/cutout\/v1\/results\/[^/?#]+\/[^/?#]+$/.test(url)) throw new Error('结果链接无效，请重新打开任务');
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(45_000) });
  if (!response.ok) throw new Error('结果下载失败，请重试');
  return response.blob();
}
export function cutoutResultReference(url: string): string {
  if (!/^\/api\/cutout\/v1\/results\/[^/?#]+\/[^/?#]+$/.test(url)) throw new Error('结果引用无效，请重新打开任务');
  return url.replace(/^\/api\/cutout\/v1\//, '/api/v1/');
}
export function saveCutoutBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
