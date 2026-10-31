import { feishuPayloadHash, validImageFeishuNavigation, imageFeishuNavigationCard, type ImageFeishuNavigation } from './feishu-navigation';
import { createHash } from 'node:crypto';
import { VIDEO_FEISHU_SITE, VideoFeishuError, videoFeishuHash, videoFeishuId, type VideoFeishuStep, type VideoFeishuUpload } from '@/lib/video/feishu-contract';

export const IMAGE_FEISHU_TYPE = 'image_feishu_v1';
export const IMAGE_FEISHU_PREFERENCE = 'image.feishu.preference.v1';
export const IMAGE_FEISHU_ATTEMPTS = 12;
export const IMAGE_FEISHU_MAX_BYTES = 10_000_000;
export type ImageFeishuChoice = { version: 1; enabled: boolean; preferenceRevision: number };
export type ImageFeishuPreference = { version: 1; enabled: boolean; revision: number; available: boolean };
export type FrozenImageFeishuChoice = { version: 1; actorId: string; identity: string; choice: ImageFeishuChoice };
export function normalizeImageFeishuChoice(value: unknown): ImageFeishuChoice | undefined {
  if (value === undefined) return undefined;
  const item = value as Partial<ImageFeishuChoice> | null;
  if (!item || typeof item !== 'object' || Array.isArray(item) || item.version !== 1 || typeof item.enabled !== 'boolean'
    || !Number.isSafeInteger(item.preferenceRevision) || Number(item.preferenceRevision) < 0
    || Object.keys(item).some(key => !['version', 'enabled', 'preferenceRevision'].includes(key))) throw new VideoFeishuError('invalid_notification_choice', 400);
  return { version: 1, enabled: item.enabled, preferenceRevision: item.preferenceRevision! };
}
export function parseFrozenImageFeishuChoice(value: unknown): FrozenImageFeishuChoice | null {
  const item = value as FrozenImageFeishuChoice | null;
  try {
    if (!item || item.version !== 1 || !videoFeishuId(item.actorId) || !videoFeishuHash(item.identity)
      || Object.keys(item).sort().join(',') !== 'actorId,choice,identity,version' || !normalizeImageFeishuChoice(item.choice)?.enabled) return null;
    return item;
  } catch { return null; }
}
export function imageFeishuUuid(taskId: string, part: 'event' | 'image' | 'explanation') {
  const bytes = createHash('sha256').update(JSON.stringify([IMAGE_FEISHU_TYPE, taskId, part])).digest();
  bytes[6] = bytes[6] & 15 | 80; bytes[8] = bytes[8] & 63 | 128;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export type ImageFeishuPresentation = { kind: 'original' | 'preview'; contentHash: string; width: number; height: number;
  originalWidth: number; originalHeight: number; mimeType: string; extension: string };
export const IMAGE_FEISHU_CARD_KEY = 'image_key_pending';
export function imageFeishuCardTemplate(assetId: string, presentation: ImageFeishuPresentation) {
  const plain = (content: string) => ({ tag: 'plain_text', content });
  const url = `${VIDEO_FEISHU_SITE}/image-studio/original/${encodeURIComponent(assetId)}`;
  return JSON.stringify({ config: { wide_screen_mode: true }, header: { template: 'blue', title: plain('图片已生成') },
    elements: [{ tag: 'img', img_key: IMAGE_FEISHU_CARD_KEY, mode: 'fit_horizontal', alt: plain('生成图片') },
      { tag: 'note', elements: [plain(`${presentation.kind === 'preview' ? '飞书预览图 · ' : ''}原图 ${presentation.originalWidth}×${presentation.originalHeight}`)] },
      { tag: 'action', actions: [{ tag: 'button', type: 'primary', text: plain('查看原图'), url }] }] });
}
export function imageFeishuCardPayload(template: string, imageKey: string) {
  const card = JSON.parse(template); card.elements[0].img_key = imageKey; return JSON.stringify(card);
}
export type ImageFeishuEvent = { taskId: string; actorId: string; eventId: string; identity: string; choice: ImageFeishuChoice;
  state: 'pending' | 'sent' | 'failed' | 'unknown' | 'cancelled'; mode: 'image' | 'link'; createdAt: number; nextAttemptAt: number;
  preparations: number; leaseToken: string | null; leaseUntil: number | null; externalStartedAt: number | null;
  sourceVersion: string | null; contentHash: string | null; assetId: string | null;
  upload: VideoFeishuUpload; image: VideoFeishuStep; explanation: VideoFeishuStep; reason: string | null } &
  ({ version: 1 } | ({ version: 2 } | { version: 3; navigation: ImageFeishuNavigation | null; cardTemplateSha256: string | null; cardPayloadSha256: string | null }) & { presentation: ImageFeishuPresentation | null; cardTemplate: string | null; cardPayload: string | null });
export function newImageFeishuEvent(taskId: string, frozen: FrozenImageFeishuChoice, now = Date.now()): ImageFeishuEvent {
  const step = (part: 'image' | 'explanation'): VideoFeishuStep => ({ uuid: imageFeishuUuid(taskId, part), state: 'pending', attempts: 0,
    firstSendAt: null, receiptId: null, ambiguous: false, leaseToken: null, leaseUntil: null });
  return { version: 3, navigation: null, cardTemplateSha256: null, cardPayloadSha256: null, presentation: null, cardTemplate: null, cardPayload: null, taskId, actorId: frozen.actorId, eventId: imageFeishuUuid(taskId, 'event'), identity: frozen.identity,
    choice: frozen.choice, state: 'pending', mode: 'image', createdAt: now, nextAttemptAt: now, preparations: 0,
    leaseToken: null, leaseUntil: null, externalStartedAt: null, sourceVersion: null, contentHash: null, assetId: null,
    upload: { state: 'pending', attempts: 0, startedAt: null, key: null }, image: step('image'), explanation: { ...step('explanation'), state: 'skipped' }, reason: null };
}
export function parseImageFeishuEvent(raw: string | null): ImageFeishuEvent | null {
  try {
    if (!raw || raw.length > 12000) return null;
    const item = JSON.parse(raw) as ImageFeishuEvent;
    const keys = (v: object, allowed: string[]) => Object.keys(v).every(key => allowed.includes(key));
    const time = (v: unknown) => v === null || Number.isSafeInteger(v) && Number(v) >= 0;
    const lease = (v: { leaseToken: unknown; leaseUntil: unknown }) => (v.leaseToken === null || videoFeishuId(v.leaseToken)) && time(v.leaseUntil);
    if (!item || !keys(item, ['version', 'taskId', 'actorId', 'eventId', 'identity', 'choice', 'state', 'mode', 'createdAt', 'nextAttemptAt',
      'preparations', 'leaseToken', 'leaseUntil', 'externalStartedAt', 'sourceVersion', 'contentHash', 'assetId', 'upload', 'image', 'explanation', 'reason', ...(item.version !== 1 ? ['presentation', 'cardTemplate', 'cardPayload'] : []), ...(item.version === 3 ? ['navigation','cardTemplateSha256','cardPayloadSha256'] : [])])
      || !([1, 2, 3].includes(item.version)) || !parseFrozenImageFeishuChoice({ version: 1, actorId: item.actorId, identity: item.identity, choice: item.choice })
      || !videoFeishuId(item.taskId) || item.eventId !== imageFeishuUuid(item.taskId, 'event')
      || !['pending', 'sent', 'failed', 'unknown', 'cancelled'].includes(item.state) || !['image', 'link'].includes(item.mode)
      || !Number.isSafeInteger(item.createdAt) || item.createdAt < 0 || !Number.isSafeInteger(item.nextAttemptAt) || item.nextAttemptAt < 0
      || !Number.isSafeInteger(item.preparations) || item.preparations < 0 || item.preparations > IMAGE_FEISHU_ATTEMPTS
      || !lease(item) || !time(item.externalStartedAt) || item.sourceVersion !== null && !videoFeishuHash(item.sourceVersion)
      || item.contentHash !== null && !videoFeishuHash(item.contentHash) || item.assetId !== null && !videoFeishuId(item.assetId)
      || item.reason !== null && !/^[a-z0-9_]{1,80}$/.test(item.reason)) return null;
    for (const part of ['image', 'explanation'] as const) {
      const s = item[part];
      if (!s || !keys(s, ['uuid', 'state', 'attempts', 'firstSendAt', 'receiptId', 'ambiguous', 'leaseToken', 'leaseUntil'])
        || s.uuid !== imageFeishuUuid(item.taskId, part) || !['pending', 'sending', 'sent', 'skipped', 'failed', 'unknown'].includes(s.state)
        || !Number.isSafeInteger(s.attempts) || s.attempts < 0 || s.attempts > IMAGE_FEISHU_ATTEMPTS || !time(s.firstSendAt)
        || !lease(s) || typeof s.ambiguous !== 'boolean' || s.receiptId !== null && !videoFeishuId(s.receiptId)
        || s.state === 'sent' && !s.receiptId || s.firstSendAt === null && (s.ambiguous || s.receiptId)) return null;
    }
    const u = item.upload;
    if (!u || !keys(u, ['state', 'attempts', 'startedAt', 'key']) || !['pending', 'uploading', 'ready', 'unknown', 'skipped'].includes(u.state)
      || !Number.isSafeInteger(u.attempts) || u.attempts < 0 || u.attempts > IMAGE_FEISHU_ATTEMPTS || !time(u.startedAt)
      || u.key !== null && (typeof u.key !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(u.key)) || u.state === 'ready' && !u.key
      || item.mode === 'link' && (item.image.firstSendAt !== null || item.image.receiptId)) return null;
    if (item.version !== 1) {
      const p = item.presentation;
      if (item.mode !== 'image' || item.explanation.state !== 'skipped' || item.explanation.attempts !== 0
        || item.explanation.firstSendAt !== null || item.explanation.receiptId !== null || item.explanation.ambiguous) return null;
      if (p !== null && (!p || !keys(p, ['kind', 'contentHash', 'width', 'height', 'originalWidth', 'originalHeight', 'mimeType', 'extension'])
        || !['original', 'preview'].includes(p.kind) || !videoFeishuHash(p.contentHash)
        || ![p.width, p.height, p.originalWidth, p.originalHeight].every(value => Number.isSafeInteger(value) && value > 0 && value <= 64000000)
        || !['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico'].includes(p.extension)
        || !['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/x-icon'].includes(p.mimeType))) return null;
      if (item.cardTemplate !== null) {
        if (!p || typeof item.cardTemplate !== 'string' || item.cardTemplate.length > 4000) return null;
        if (!item.assetId || (item.version === 2 ? item.cardTemplate !== imageFeishuCardTemplate(item.assetId, p)
          : !validImageFeishuNavigation(item.navigation, item.assetId) || item.cardTemplate !== imageFeishuNavigationCard(p, item.navigation))) return null;
      } else if (p !== null) return null;
      if (item.cardPayload !== null && (!item.cardTemplate || !u.key || item.cardPayload !== imageFeishuCardPayload(item.cardTemplate, u.key))) return null;
      if (item.version === 3 && (item.cardTemplateSha256 !== (item.cardTemplate ? feishuPayloadHash(item.cardTemplate) : null)
        || item.cardPayloadSha256 !== (item.cardPayload ? feishuPayloadHash(item.cardPayload) : null) || !p && item.navigation !== null)) return null;
      if (item.externalStartedAt !== null && (!p || !item.cardTemplate) || item.image.firstSendAt !== null && !item.cardPayload) return null;
    }
    return item;
  } catch { return null; }
}
export function imageFeishuCanCancel(meta: ImageFeishuEvent) {
  return ['pending', 'failed'].includes(meta.state) && !meta.leaseToken && meta.externalStartedAt === null
    && meta.upload.startedAt === null && meta.image.firstSendAt === null && meta.explanation.firstSendAt === null;
}
export function imageFeishuCanRetry(meta: ImageFeishuEvent) {
  return meta.state === 'failed' && !meta.leaseToken && meta.upload.state !== 'unknown' && meta.upload.state !== 'uploading'
    && meta.upload.attempts < IMAGE_FEISHU_ATTEMPTS
    && [meta.image, meta.explanation].every(s => s.receiptId || !s.ambiguous && s.firstSendAt === null)
    && ['preparation_attempts_ended', 'image_original_unavailable', 'image_upload_rejected'].includes(meta.reason || '');
}
export function imageFeishuStatus(meta: ImageFeishuEvent | null) {
  if (!meta) return { version: 1 as const, state: 'not_requested', canCancel: false, canRetry: false, imageSent: false, explanationSent: false, mode: null, reason: null };
  const state = meta.state === 'sent' ? meta.mode === 'image' ? 'sent_image' : 'sent_link'
    : meta.state !== 'pending' ? meta.state : meta.image.receiptId ? meta.version !== 1 ? 'sending' : 'image_sent_explanation_pending'
      : meta.upload.state === 'uploading' ? 'uploading' : meta.image.state === 'sending' || meta.explanation.state === 'sending' ? 'sending'
        : meta.leaseToken ? 'preparing' : 'pending';
  return { version: 1 as const, state, canCancel: imageFeishuCanCancel(meta), canRetry: imageFeishuCanRetry(meta), reason: meta.reason,
    imageSent: Boolean(meta.image.receiptId), explanationSent: Boolean(meta.explanation.receiptId), mode: meta.mode };
}
