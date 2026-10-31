import { createHash } from 'node:crypto';
import { videoFeishuHash, videoFeishuId, type VideoFeishuStep, type VideoFeishuUpload } from '@/lib/video/feishu-contract';
import { imageFeishuCardPayload, imageFeishuCardTemplate } from './feishu-contract';

export const IMAGE_FEISHU_ORIGINAL_TYPE = 'image_feishu_original_v1';
export const IMAGE_FEISHU_ORIGINAL_MAX_BYTES = 30_000_000;
export type OriginalImageFeishuSource = { version: string; contentHash: string; assetId: string; size: number; width: number; height: number; mimeType: string; extension: string };
export type OriginalImageFeishuEvent = { version: 1; taskId: string; actorId: string; identity: string; eventId: string;
  state: 'pending' | 'sent' | 'failed' | 'unknown' | 'cancelled'; mode: 'image' | 'file' | null; fileName: '原图';
  createdAt: number; nextAttemptAt: number; preparations: number; leaseToken: string | null; leaseUntil: number | null;
  externalStartedAt: number | null; source: OriginalImageFeishuSource | null; template: string | null; payload: string | null;
  upload: VideoFeishuUpload; message: VideoFeishuStep; reason: string | null };
export function originalImageFeishuUuid(taskId: string, part: 'event' | 'message') {
  const bytes = createHash('sha256').update(JSON.stringify([IMAGE_FEISHU_ORIGINAL_TYPE, taskId, part])).digest();
  bytes[6] = bytes[6] & 15 | 80; bytes[8] = bytes[8] & 63 | 128;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function originalImageFeishuTemplate(mode: 'image' | 'file', source: OriginalImageFeishuSource) {
  return mode === 'file' ? JSON.stringify({ file_key: 'file_key_pending' }) : imageFeishuCardTemplate(source.assetId,
    { kind: 'original', contentHash: source.contentHash, width: source.width, height: source.height, originalWidth: source.width,
      originalHeight: source.height, mimeType: source.mimeType, extension: source.extension });
}
export function originalImageFeishuPayload(mode: 'image' | 'file', template: string, key: string) {
  return mode === 'file' ? JSON.stringify({ file_key: key }) : imageFeishuCardPayload(template, key);
}
export function newOriginalImageFeishuEvent(taskId: string, actorId: string, identity: string, now = Date.now()): OriginalImageFeishuEvent {
  return { version: 1, taskId, actorId, identity, eventId: originalImageFeishuUuid(taskId, 'event'), state: 'pending', mode: null, fileName: '原图',
    createdAt: now, nextAttemptAt: now, preparations: 0, leaseToken: null, leaseUntil: null, externalStartedAt: null, source: null, template: null, payload: null,
    upload: { state: 'pending', attempts: 0, startedAt: null, key: null }, message: { uuid: originalImageFeishuUuid(taskId, 'message'), state: 'pending',
      attempts: 0, firstSendAt: null, receiptId: null, ambiguous: false, leaseToken: null, leaseUntil: null }, reason: null };
}
export function parseOriginalImageFeishuEvent(raw: string | null): OriginalImageFeishuEvent | null {
  try {
    if (!raw || raw.length > 12000) return null;
    const item = JSON.parse(raw) as OriginalImageFeishuEvent;
    const keys = (v: object, allowed: string[]) => Object.keys(v).every(key => allowed.includes(key));
    const time = (v: unknown) => v === null || Number.isSafeInteger(v) && Number(v) >= 0;
    const lease = (v: { leaseToken: unknown; leaseUntil: unknown }) => (v.leaseToken === null || videoFeishuId(v.leaseToken)) && time(v.leaseUntil);
    if (!item || item.version !== 1 || !keys(item, ['version','taskId','actorId','identity','eventId','state','mode','fileName','createdAt','nextAttemptAt','preparations','leaseToken','leaseUntil','externalStartedAt','source','template','payload','upload','message','reason'])
      || !videoFeishuId(item.taskId) || !videoFeishuId(item.actorId) || !videoFeishuHash(item.identity) || item.eventId !== originalImageFeishuUuid(item.taskId, 'event')
      || !['pending','sent','failed','unknown','cancelled'].includes(item.state) || ![null,'image','file'].includes(item.mode) || item.fileName !== '原图'
      || !time(item.createdAt) || item.createdAt === null || !time(item.nextAttemptAt) || item.nextAttemptAt === null || !lease(item) || !time(item.externalStartedAt)
      || !Number.isSafeInteger(item.preparations) || item.preparations < 0 || item.preparations > 12 || item.reason !== null && !/^[a-z0-9_]{1,80}$/.test(item.reason)) return null;
    const s = item.message, u = item.upload;
    if (!s || !keys(s, ['uuid','state','attempts','firstSendAt','receiptId','ambiguous','leaseToken','leaseUntil'])
      || s.uuid !== originalImageFeishuUuid(item.taskId, 'message') || !['pending','sending','sent','failed','unknown'].includes(s.state)
      || !Number.isSafeInteger(s.attempts) || s.attempts < 0 || s.attempts > 12 || !time(s.firstSendAt) || !lease(s) || typeof s.ambiguous !== 'boolean'
      || s.receiptId !== null && !videoFeishuId(s.receiptId) || s.state === 'sent' && !s.receiptId || s.firstSendAt === null && (s.receiptId || s.ambiguous)
      || !u || !keys(u, ['state','attempts','startedAt','key']) || !['pending','uploading','ready','unknown'].includes(u.state)
      || !Number.isSafeInteger(u.attempts) || u.attempts < 0 || u.attempts > 12 || !time(u.startedAt)
      || u.key !== null && (typeof u.key !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(u.key)) || u.state === 'ready' && !u.key) return null;
    if (item.source !== null) {
      const source = item.source;
      if (!source || !keys(source, ['version','contentHash','assetId','size','width','height','mimeType','extension']) || !videoFeishuHash(source.version)
        || !videoFeishuHash(source.contentHash) || !videoFeishuId(source.assetId) || !Number.isSafeInteger(source.size) || source.size < 1 || source.size > IMAGE_FEISHU_ORIGINAL_MAX_BYTES
        || ![source.width,source.height].every(v => Number.isSafeInteger(v) && v > 0) || !['png','jpg','webp','avif','tiff'].includes(source.extension)
        || !['image/png','image/jpeg','image/webp','image/avif','image/tiff'].includes(source.mimeType) || !item.mode || item.template !== originalImageFeishuTemplate(item.mode, source)) return null;
    } else if (item.mode !== null || item.template !== null || item.payload !== null) return null;
    if (item.payload !== null && (!item.mode || !item.template || !u.key || item.payload !== originalImageFeishuPayload(item.mode, item.template, u.key))) return null;
    if (item.externalStartedAt !== null && !item.source || s.firstSendAt !== null && !item.payload) return null;
    return item;
  } catch { return null; }
}
export function originalImageFeishuCanCancel(meta: OriginalImageFeishuEvent) {
  return meta.state === 'pending' && !meta.leaseToken && meta.externalStartedAt === null && meta.upload.startedAt === null && meta.message.firstSendAt === null;
}
export function originalImageFeishuCanRetry(meta: OriginalImageFeishuEvent) {
  return meta.state === 'failed' && !meta.leaseToken && meta.upload.state === 'pending' && meta.upload.attempts < 12
    && !meta.message.receiptId && !meta.message.ambiguous && meta.message.firstSendAt === null
    && ['image_original_unavailable','image_upload_rejected','preparation_attempts_ended'].includes(meta.reason || '');
}
export function originalImageFeishuStatus(meta: OriginalImageFeishuEvent | null) {
  const state = !meta ? 'not_requested' : meta.state !== 'pending' ? meta.state : meta.upload.state === 'uploading' ? 'uploading'
    : meta.message.state === 'sending' ? 'sending' : meta.leaseToken ? 'preparing' : 'pending';
  return { version: 2 as const, state, canSend: !meta, canCancel: meta ? originalImageFeishuCanCancel(meta) : false,
    canRetry: meta ? originalImageFeishuCanRetry(meta) : false, originalSent: Boolean(meta?.message.receiptId),
    mode: meta?.mode ?? null, fileSize: meta?.source?.size ?? null, maxBytes: IMAGE_FEISHU_ORIGINAL_MAX_BYTES,
    source: meta ? 'manual' as const : null, reason: meta?.reason ?? null };
}
