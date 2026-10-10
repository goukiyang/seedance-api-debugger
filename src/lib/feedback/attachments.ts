import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { Prisma } from '@prisma/client';
import { siteUploadPathFromUrl } from '@/lib/assets/site-url';

// Local resource limits, not a claim about Feishu's image-count limit.
export const FEEDBACK_ATTACHMENT_LIMIT = 128;
export const FEEDBACK_CARD_IMAGE_LIMIT = 20;
export const FEEDBACK_IMAGE_BYTES = 10 * 1024 * 1024;
export const FEEDBACK_IMAGE_ATTEMPTS = 3;
const formats: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const validHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export type FeedbackAttachment = {
  assetId: string;
  ownerId: string;
  originalUrl: string;
  hash: string;
  mime: string;
  size: number;
  state: 'pending' | 'uploading' | 'ready' | 'skipped';
  attempts: number;
  nextAttemptAt: number;
  imageKey: string | null;
  errorCode: string | null;
};
export type FeedbackAttachments = {
  total: number;
  items: FeedbackAttachment[];
  excluded: Record<string, number>;
};
export const attachmentSelect = { id: true, owner_id: true, type: true, status: true, original_url: true,
  hash: true, mime_type: true, file_size: true } as const;
type AttachmentAsset = Prisma.AssetGetPayload<{ select: typeof attachmentSelect }>;

function canonicalUrl(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000 || /[?#\u0000-\u001f\\]/.test(value)) return null;
  const url = value.trim();
  const local = siteUploadPathFromUrl(url);
  if (local) return local;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : null;
  } catch { return null; }
}

function assetProblem(asset: AttachmentAsset | null, owner: string | null) {
  if (!asset) return 'attachment_missing';
  if (!owner || asset.owner_id !== owner) return 'attachment_unauthorized';
  if (asset.status !== 'active') return 'attachment_inactive';
  if (asset.type !== 'image' || !formats[asset.mime_type]) return 'attachment_format';
  if (!validHash(asset.hash) || !canonicalUrl(asset.original_url)) return 'attachment_source';
  if (!Number.isSafeInteger(asset.file_size) || asset.file_size <= 0 || asset.file_size > FEEDBACK_IMAGE_BYTES) return 'attachment_size';
  return null;
}

export async function snapshotFeedbackAttachments(tx: Prisma.TransactionClient, ownerId: string | null, urls: unknown, ids: unknown) {
  const imageUrls = Array.isArray(urls) ? urls : [];
  const assetIds = Array.isArray(ids) ? ids : [];
  const total = Math.max(imageUrls.length, assetIds.length);
  const bounded = Math.min(total, FEEDBACK_ATTACHMENT_LIMIT);
  const candidates = Array.from(new Set(assetIds.slice(0, bounded).filter(validId)));
  const assets = candidates.length && ownerId ? await tx.asset.findMany({ where: { id: { in: candidates } }, select: attachmentSelect }) : [];
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  const snapshot: FeedbackAttachments = { total, items: [], excluded: {} };
  const acceptedUrls: string[] = [];
  const seen = new Set<string>();
  const exclude = (code: string, count = 1) => { snapshot.excluded[code] = (snapshot.excluded[code] || 0) + count; };
  if (total > bounded) exclude('attachment_snapshot_limit', total - bounded);
  for (let index = 0; index < bounded; index++) {
    const id = assetIds[index];
    const asset = validId(id) ? byId.get(id) || null : null;
    const problem = !ownerId ? 'attachment_unauthorized' : !validId(id) ? 'attachment_unverified' : assetProblem(asset, ownerId);
    if (problem) { exclude(problem); continue; }
    const suppliedUrl = canonicalUrl(imageUrls[index]);
    if (!suppliedUrl || suppliedUrl !== canonicalUrl(asset!.original_url)) { exclude('attachment_url_mismatch'); continue; }
    if (seen.has(id)) { exclude('attachment_duplicate'); continue; }
    seen.add(id);
    acceptedUrls.push(asset!.original_url);
    snapshot.items.push({ assetId: id, ownerId: ownerId!, originalUrl: asset!.original_url, hash: asset!.hash!,
      mime: asset!.mime_type, size: asset!.file_size, state: snapshot.items.length < FEEDBACK_CARD_IMAGE_LIMIT ? 'pending' : 'skipped',
      attempts: 0, nextAttemptAt: 0, imageKey: null,
      errorCode: snapshot.items.length < FEEDBACK_CARD_IMAGE_LIMIT ? null : 'attachment_card_limit' });
  }
  return { snapshot, imageUrls: acceptedUrls };
}

export function validFeedbackAttachments(value: unknown): value is FeedbackAttachments {
  if (!value || typeof value !== 'object') return false;
  const data = value as FeedbackAttachments;
  if (!Number.isSafeInteger(data.total) || data.total < 0 || !Array.isArray(data.items) || data.items.length > FEEDBACK_ATTACHMENT_LIMIT
    || !data.excluded || typeof data.excluded !== 'object' || Array.isArray(data.excluded)) return false;
  const excluded = Object.entries(data.excluded);
  if (excluded.length > 20 || excluded.some(([code, count]) => !/^attachment_[a-z_]{1,40}$/.test(code) || !Number.isSafeInteger(count) || count <= 0)
    || excluded.reduce((sum, [, count]) => sum + count, data.items.length) !== data.total) return false;
  if (data.items.filter(item => item && item.state !== 'skipped').length > FEEDBACK_CARD_IMAGE_LIMIT) return false;
  const seen = new Set<string>();
  return data.items.every(item => {
    if (!item || !validId(item.assetId) || !validId(item.ownerId) || seen.has(item.assetId) || !validHash(item.hash)
      || !formats[item.mime] || !canonicalUrl(item.originalUrl) || !Number.isSafeInteger(item.size) || item.size <= 0 || item.size > FEEDBACK_IMAGE_BYTES
      || !['pending', 'uploading', 'ready', 'skipped'].includes(item.state)
      || !Number.isSafeInteger(item.attempts) || item.attempts < 0 || item.attempts > FEEDBACK_IMAGE_ATTEMPTS
      || !Number.isSafeInteger(item.nextAttemptAt) || item.nextAttemptAt < 0
      || (item.imageKey !== null && (typeof item.imageKey !== 'string' || !/^img_[a-zA-Z0-9_-]{1,190}$/.test(item.imageKey)))
      || (item.errorCode !== null && (typeof item.errorCode !== 'string' || !/^[a-z0-9_-]{1,100}$/.test(item.errorCode)))
      || (item.state === 'ready' ? !item.imageKey : item.imageKey !== null)
      || (['uploading', 'ready'].includes(item.state) && item.attempts < 1)
      || (item.state === 'skipped' && !item.errorCode)) return false;
    seen.add(item.assetId);
    return true;
  });
}

export function feedbackAttachmentStillValid(asset: AttachmentAsset | null, item: FeedbackAttachment) {
  return !assetProblem(asset, item.ownerId) && asset!.id === item.assetId && asset!.hash === item.hash
    && asset!.mime_type === item.mime && asset!.file_size === item.size && asset!.original_url === item.originalUrl;
}

export class FeedbackImageError extends Error {
  constructor(public code: string, public retryable = false) { super(code); }
}

export async function readFeedbackImage(item: FeedbackAttachment): Promise<Buffer> {
  // Read the original hash-addressed upload, never a URL or a thumbnail.
  const filename = `${item.hash}.${formats[item.mime]}`;
  if (!validHash(item.hash) || !formats[item.mime]) throw new FeedbackImageError('attachment_source');
  let file;
  try {
    const root = await realpath(path.join(process.cwd(), 'public', 'uploads', 'assets'));
    file = await open(path.join(root, filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await file.stat();
    if (!before.isFile() || before.size !== item.size || before.size <= 0 || before.size > FEEDBACK_IMAGE_BYTES) throw new FeedbackImageError('attachment_size');
    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) throw new FeedbackImageError('attachment_changed');
      offset += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || createHash('sha256').update(buffer).digest('hex') !== item.hash) throw new FeedbackImageError('attachment_changed');
    const metadata = await sharp(buffer, { limitInputPixels: 12000 * 12000 }).metadata();
    const expected = item.mime === 'image/jpeg' ? 'jpeg' : formats[item.mime];
    if (metadata.format !== expected || !metadata.width || !metadata.height || metadata.width > 12000 || metadata.height > 12000
      || (metadata.pages || 1) !== 1) throw new FeedbackImageError('attachment_format');
    return buffer;
  } catch (error) {
    if (error instanceof FeedbackImageError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new FeedbackImageError(code === 'ENOENT' ? 'attachment_file_missing' : code === 'EACCES' ? 'attachment_file_permission' : 'attachment_file_invalid');
  } finally { await file?.close(); }
}

export async function uploadFeedbackImage(buffer: Buffer, mime: string, token: string, leaseUntil: number) {
  if (Date.now() >= leaseUntil - 10_000) throw new FeedbackImageError('attachment_lease_expiring', true);
  const form = new FormData();
  form.set('image_type', 'message');
  form.set('image', new Blob([new Uint8Array(buffer)], { type: mime }), `feedback.${formats[mime]}`);
  let response: Response;
  let data: { code?: unknown; data?: { image_key?: unknown } };
  try {
    response = await fetch('https://open.feishu.cn/open-apis/im/v1/images', { method: 'POST',
      headers: { Authorization: `Bearer ${token}` }, body: form, signal: AbortSignal.timeout(8000), cache: 'no-store', redirect: 'error' });
    data = await response.json();
  } catch { throw new FeedbackImageError('attachment_upload_unknown'); }
  const code = typeof data.code === 'number' ? data.code : null;
  if (response.ok && code === 0 && typeof data.data?.image_key === 'string' && /^img_[a-zA-Z0-9_-]{1,190}$/.test(data.data.image_key)) return data.data.image_key;
  if (response.status >= 500 || code === null || (response.ok && code === 0)) throw new FeedbackImageError('attachment_upload_unknown');
  if (response.status === 401 || response.status === 403 || code === 99991672 || code === 99991679 || code === 234007) throw new FeedbackImageError('attachment_upload_permission');
  throw new FeedbackImageError(`attachment_feishu_${code}`, response.status === 429 || [99991400, 99991663, 99991668].includes(code));
}

export function feedbackAttachmentNotice(data: FeedbackAttachments) {
  if (!data.total) return '';
  const ready = data.items.filter(item => item.state === 'ready').length;
  const reasons: Record<string, number> = {};
  const label = (code: string) => code.includes('limit') ? '超过通知容量' : code.includes('permission') ? '上传权限不可用'
    : code.includes('unknown') ? '图片上传结果未确认' : /unauthorized|inactive|missing|changed|unverified|mismatch|source/.test(code) ? '附件未通过有效性核验'
      : /size|format|invalid/.test(code) ? '图片格式或大小不支持' : '图片上传未完成';
  for (const [code, count] of Object.entries(data.excluded)) reasons[label(code)] = (reasons[label(code)] || 0) + count;
  for (const item of data.items.filter(item => item.state !== 'ready')) {
    const reason = label(item.errorCode || 'attachment_not_ready');
    reasons[reason] = (reasons[reason] || 0) + 1;
  }
  const missing = data.total - ready;
  return missing ? `已附 ${ready} 张截图，另 ${missing} 项未附：${Object.entries(reasons).map(([reason, count]) => `${reason} ${count} 项`).join('；')}。请查看意见详情。`
    : `附 ${ready} 张截图`;
}
