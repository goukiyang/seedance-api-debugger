import { createHash } from 'node:crypto';

export const VIDEO_FEISHU_TYPE = 'video_feishu_v1';
export const VIDEO_FEISHU_PREFERENCE = 'video.feishu.preference.v1';
export const VIDEO_FEISHU_SITE = 'https://sd2.youdooart.com';
export const VIDEO_FEISHU_MAX_BYTES = 30_000_000;
export const VIDEO_FEISHU_ATTEMPTS = 12;
export type VideoFeishuChoice = { version: 1; enabled: boolean; preferenceRevision: number };
export type VideoFeishuPreference = { version: 1; enabled: boolean; revision: number; available: boolean };
export class VideoFeishuError extends Error {
  constructor(readonly code: string, readonly status = 409, readonly ambiguous = false, readonly retryable = false) { super(code); }
}
export function normalizeVideoFeishuChoice(value: unknown): VideoFeishuChoice {
  if (value === undefined) return { version: 1, enabled: false, preferenceRevision: 0 };
  const item = value as Partial<VideoFeishuChoice> | null;
  if (!item || typeof item !== 'object' || Array.isArray(item) || item.version !== 1 || typeof item.enabled !== 'boolean'
    || !Number.isSafeInteger(item.preferenceRevision) || item.preferenceRevision! < 0
    || Object.keys(item).some(key => !['version', 'enabled', 'preferenceRevision'].includes(key))) throw new VideoFeishuError('invalid_video_feishu_choice', 400);
  return { version: 1, enabled: item.enabled, preferenceRevision: item.preferenceRevision! };
}
export const videoFeishuId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export const videoFeishuHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function videoFeishuUuid(taskId: string, part: 'event' | 'video' | 'explanation') {
  const bytes = createHash('sha256').update(JSON.stringify([VIDEO_FEISHU_TYPE, taskId, part])).digest();
  bytes[6] = bytes[6] & 15 | 80; bytes[8] = bytes[8] & 63 | 128;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export type VideoFeishuStep = { uuid: string; state: 'pending' | 'sending' | 'sent' | 'skipped' | 'failed' | 'unknown';
  attempts: number; firstSendAt: number | null; receiptId: string | null; ambiguous: boolean; leaseToken: string | null; leaseUntil: number | null };
export type VideoFeishuUpload = { state: 'pending' | 'uploading' | 'ready' | 'unknown' | 'skipped'; attempts: number; startedAt: number | null; key: string | null };
export type VideoFeishuEvent = { version: 1; taskId: string; actorId: string; eventId: string; identity: string; choice: VideoFeishuChoice;
  state: 'pending' | 'sent' | 'failed' | 'unknown' | 'cancelled'; mode: 'video' | 'link'; createdAt: number; nextAttemptAt: number; preparations: number;
  leaseToken: string | null; leaseUntil: number | null; externalStartedAt: number | null; sourceVersion: string | null; contentHash: string | null;
  upload: VideoFeishuUpload; cover: VideoFeishuUpload; video: VideoFeishuStep; explanation: VideoFeishuStep; reason: string | null };
export function newVideoFeishuEvent(taskId: string, actorId: string, identity: string, choice: VideoFeishuChoice, now = Date.now()): VideoFeishuEvent {
  const step = (part: 'video' | 'explanation'): VideoFeishuStep => ({ uuid: videoFeishuUuid(taskId, part), state: 'pending', attempts: 0, firstSendAt: null,
    receiptId: null, ambiguous: false, leaseToken: null, leaseUntil: null });
  const upload = (): VideoFeishuUpload => ({ state: 'pending', attempts: 0, startedAt: null, key: null });
  return { version: 1, taskId, actorId, eventId: videoFeishuUuid(taskId, 'event'), identity, choice, state: 'pending', mode: 'video', createdAt: now,
    nextAttemptAt: now, preparations: 0, leaseToken: null, leaseUntil: null, externalStartedAt: null, sourceVersion: null, contentHash: null,
    upload: upload(), cover: upload(), video: step('video'), explanation: step('explanation'), reason: null };
}
export function parseVideoFeishuEvent(raw: string | null): VideoFeishuEvent | null {
  try {
    if (!raw || raw.length > 12000) return null;
    const item = JSON.parse(raw) as VideoFeishuEvent;
    const keys = (value: object, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
    const time = (value: unknown) => value === null || Number.isSafeInteger(value) && Number(value) >= 0;
    const lease = (value: { leaseToken: unknown; leaseUntil: unknown }) => (value.leaseToken === null || videoFeishuId(value.leaseToken)) && time(value.leaseUntil);
    if (!item || !keys(item, ['version', 'taskId', 'actorId', 'eventId', 'identity', 'choice', 'state', 'mode', 'createdAt', 'nextAttemptAt', 'preparations',
      'leaseToken', 'leaseUntil', 'externalStartedAt', 'sourceVersion', 'contentHash', 'upload', 'cover', 'video', 'explanation', 'reason'])
      || item.version !== 1 || !videoFeishuId(item.taskId) || !videoFeishuId(item.actorId) || !videoFeishuHash(item.identity)
      || item.eventId !== videoFeishuUuid(item.taskId, 'event') || !normalizeVideoFeishuChoice(item.choice).enabled
      || !['pending', 'sent', 'failed', 'unknown', 'cancelled'].includes(item.state) || !['video', 'link'].includes(item.mode)
      || !time(item.createdAt) || !time(item.nextAttemptAt) || item.createdAt === null || item.nextAttemptAt === null
      || !Number.isSafeInteger(item.preparations) || item.preparations < 0 || item.preparations > VIDEO_FEISHU_ATTEMPTS
      || !lease(item) || !time(item.externalStartedAt) || item.sourceVersion !== null && !videoFeishuHash(item.sourceVersion)
      || item.contentHash !== null && !videoFeishuHash(item.contentHash) || item.reason !== null && !/^[a-z0-9_]{1,80}$/.test(item.reason)) return null;
    for (const part of ['video', 'explanation'] as const) {
      const step = item[part];
      if (!step || !keys(step, ['uuid', 'state', 'attempts', 'firstSendAt', 'receiptId', 'ambiguous', 'leaseToken', 'leaseUntil'])
        || step.uuid !== videoFeishuUuid(item.taskId, part) || !['pending', 'sending', 'sent', 'skipped', 'failed', 'unknown'].includes(step.state)
        || !Number.isSafeInteger(step.attempts) || step.attempts < 0 || step.attempts > VIDEO_FEISHU_ATTEMPTS || !time(step.firstSendAt)
        || !lease(step) || typeof step.ambiguous !== 'boolean' || step.receiptId !== null && !videoFeishuId(step.receiptId)
        || step.state === 'sent' && !step.receiptId || step.firstSendAt === null && (step.ambiguous || step.receiptId)) return null;
    }
    for (const part of ['upload', 'cover'] as const) {
      const upload = item[part];
      if (!upload || !keys(upload, ['state', 'attempts', 'startedAt', 'key'])
        || !['pending', 'uploading', 'ready', 'unknown', 'skipped'].includes(upload.state) || !Number.isSafeInteger(upload.attempts)
        || upload.attempts < 0 || upload.attempts > VIDEO_FEISHU_ATTEMPTS || !time(upload.startedAt)
        || upload.key !== null && (typeof upload.key !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(upload.key))
        || upload.state === 'ready' && !upload.key) return null;
    }
    if (item.mode === 'link' && (item.video.firstSendAt !== null || item.video.receiptId)) return null;
    return item;
  } catch { return null; }
}
export function videoFeishuCanCancel(meta: VideoFeishuEvent) {
  const cancellable = meta.state === 'pending' || meta.state === 'failed' && ['original_save_failed', 'original_wait_ended'].includes(meta.reason || '');
  return cancellable && meta.leaseToken === null && meta.externalStartedAt === null && meta.upload.startedAt === null
    && meta.cover.startedAt === null && meta.video.firstSendAt === null && meta.explanation.firstSendAt === null;
}
/** A completed second cache destination changes old aggregate stamps. Only a verified full-byte hash can bridge that change. */
export function videoFeishuSameOriginal(previous: { sourceVersion: string | null; contentHash: string | null }, current: { version: string; hash: string | null }) {
  if (previous.contentHash && previous.contentHash !== current.hash) return false;
  return !previous.sourceVersion || previous.sourceVersion === current.version
    || Boolean(previous.contentHash && current.hash && previous.contentHash === current.hash);
}
export function videoFeishuStatus(meta: VideoFeishuEvent | null, originalStatus?: string | null, hasOriginalPath = false) {
  if (!meta) return { version: 1 as const, state: 'not_requested', canCancel: false, videoSent: false, explanationSent: false, mode: null };
  const originalFailed = !meta.video.receiptId && meta.externalStartedAt === null
    && (meta.reason === 'original_save_failed' || meta.reason === 'original_wait_ended' || originalStatus === 'failed' && !hasOriginalPath);
  const state = originalFailed && meta.state !== 'cancelled' ? 'original_save_failed'
    : meta.state === 'sent' ? meta.mode === 'video' ? 'sent_video' : 'sent_link'
    : meta.state !== 'pending' ? meta.state : meta.video.receiptId ? 'video_sent_explanation_pending'
      : meta.upload.state === 'uploading' || meta.cover.state === 'uploading' ? 'uploading'
        : meta.video.state === 'sending' || meta.explanation.state === 'sending' ? 'sending' : meta.leaseToken ? 'preparing' : 'pending';
  return { version: 1 as const, state, canCancel: videoFeishuCanCancel(meta), canRetrySave: originalFailed && originalStatus === 'failed',
    reason: meta.reason, videoSent: Boolean(meta.video.receiptId), explanationSent: Boolean(meta.explanation.receiptId), mode: meta.mode };
}
