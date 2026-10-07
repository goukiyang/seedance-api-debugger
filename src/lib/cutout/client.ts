import type { CutoutAsset, CutoutCapabilities, CutoutHistory, CutoutJob, CutoutKind, CutoutProgress, CutoutUploadProgress } from './types';
import { isCutoutJob, isRecord } from './receipt';

const API = '/api/cutout/v1';
const progressStages = new Set(['preparing', 'processing', 'saving']);
export class CutoutRequestError extends Error {
  constructor(message: string, public status: number, public code?: string, public submissionMade: boolean | null = null) { super(message); }
}
export async function cutoutRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const externalSignal = init.signal || undefined;
  const forwardAbort = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch(`${API}${path}`, { ...init, signal: controller.signal, cache: 'no-store' });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.success === false) {
      throw new CutoutRequestError(body?.message || body?.detail?.message || '请求未完成，请重试', response.status, body?.error || body?.detail?.code,
        typeof body?.submission_made === 'boolean' ? body.submission_made : null);
    }
    if (!isRecord(body)) throw new CutoutRequestError('抠图服务回复不完整，受理结果未确认；原提交标识保留，请重新查询', 502);
    return body as T;
  } catch (error) {
    if (error instanceof CutoutRequestError) throw error;
    throw new CutoutRequestError('网络连接中断，原图与任务保留，请重新查询', 0);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', forwardAbort);
  }
}
export const getCutoutCapabilities = () => cutoutRequest<CutoutCapabilities>('/capabilities');
function requestMessage(body: any, fallback: string) {
  return body?.message || body?.detail?.message || fallback;
}
function requestCode(body: any) {
  if (typeof body?.error === 'string') return body.error;
  return typeof body?.detail?.code === 'string' ? body.detail.code : undefined;
}
function submissionMade(body: any): boolean | null {
  return typeof body?.submission_made === 'boolean' ? body.submission_made : null;
}
function validProgress(value: unknown): CutoutProgress | undefined {
  if (!isRecord(value) || typeof value.stage !== 'string' || !progressStages.has(value.stage)
    || typeof value.attempt !== 'number' || !Number.isSafeInteger(value.attempt) || value.attempt < 1
    || typeof value.sequence !== 'number' || !Number.isSafeInteger(value.sequence) || value.sequence < 1
    || typeof value.reported_at !== 'number' || !Number.isFinite(value.reported_at) || value.reported_at < 0) return undefined;
  return {
    stage: value.stage as CutoutProgress['stage'],
    attempt: value.attempt,
    sequence: value.sequence,
    reported_at: value.reported_at,
  };
}
function validEpochSeconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function validJob(value: unknown, expected?: { id?: string; kind?: CutoutKind }): CutoutJob {
  if (!isCutoutJob(value, expected)) throw new CutoutRequestError('任务回复不完整，受理结果未确认；保留原提交标识与参数，请重新查询', 502, 'INVALID_JOB_RECEIPT', null);
  const job: CutoutJob = { ...value };
  delete job.started_at;
  delete job.progress;
  const startedAt = validEpochSeconds((value as Record<string, unknown>).started_at);
  const progress = validProgress((value as Record<string, unknown>).progress);
  if (startedAt !== undefined) job.started_at = startedAt;
  if (progress) job.progress = progress;
  return job;
}
function uploadRequest<T>(path: string, data: FormData, onProgress?: (progress: CutoutUploadProgress | null) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API}${path}`, true);
    xhr.timeout = 45_000;
    xhr.upload.addEventListener('progress', event => {
      try {
        if (!event.lengthComputable || event.total <= 0) {
          onProgress?.(null);
          return;
        }
        onProgress?.({
          loaded: event.loaded,
          total: event.total,
          percent: Math.min(100, (event.loaded / event.total) * 100),
        });
      } catch { /* UI progress is optional and must not interrupt the upload. */ }
    });
    xhr.onerror = () => reject(new CutoutRequestError('网络连接中断，原图与任务保留，请重新查询', 0));
    xhr.ontimeout = () => reject(new CutoutRequestError('网络连接中断，原图与任务保留，请重新查询', 0));
    xhr.onabort = () => reject(new CutoutRequestError('网络连接中断，原图与任务保留，请重新查询', 0));
    xhr.onload = () => {
      let body: any = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* handled as an incomplete receipt below */ }
      if (xhr.status < 200 || xhr.status >= 300 || body?.success === false) {
        reject(new CutoutRequestError(requestMessage(body, '请求未完成，请重试'), xhr.status, requestCode(body), submissionMade(body)));
        return;
      }
      if (!isRecord(body)) {
        reject(new CutoutRequestError('抠图服务回复不完整，原图上传结果未确认；请重新查询', 502, 'INVALID_ASSET_RECEIPT', false));
        return;
      }
      resolve(body as T);
    };
    xhr.send(data);
  });
}
export async function uploadCutoutAsset(file: Blob, name = 'image.png', onProgress?: (progress: CutoutUploadProgress | null) => void) {
  const data = new FormData(); data.append('file', file, name);
  const asset = await uploadRequest<unknown>('/assets', data, onProgress);
  if (!isRecord(asset)) throw new CutoutRequestError('原图上传回复不完整，尚未提交任务；原图保留', 502, 'INVALID_ASSET_RECEIPT', false);
  if (typeof asset.asset_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(asset.asset_id)
    || ![asset.width, asset.height, asset.size].every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)) {
    throw new CutoutRequestError('原图上传回复不完整，尚未提交任务；原图保留', 502, 'INVALID_ASSET_RECEIPT', false);
  }
  return asset as unknown as CutoutAsset;
}
export async function createCutoutJob(assetId: string, kind: CutoutKind, parameters: Record<string, unknown>, idempotencyKey: string) {
  return validJob(await cutoutRequest<unknown>('/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ asset_id: assetId, kind, parameters }),
  }), { kind });
}
export const getCutoutJob = async (id: string, signal?: AbortSignal) => validJob(await cutoutRequest<unknown>(`/jobs/${encodeURIComponent(id)}`, { signal }), { id });
export const cancelCutoutJob = async (id: string) => validJob(await cutoutRequest<unknown>(`/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }), { id });
export async function getCutoutHistory(offset = 0, limit = 12): Promise<CutoutHistory> {
  const body = await cutoutRequest<CutoutHistory>(`/jobs/history?limit=${limit}&offset=${offset}`);
  if (!Array.isArray(body.items) || !body.items.every(item => isCutoutJob(item))) throw new CutoutRequestError('任务历史回复不完整，原有记录保留，请重试读取', 502);
  return { ...body, items: body.items.map(item => validJob(item)) };
}
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
