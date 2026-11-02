import { FEEDBACK_SUBMISSIONS_ENABLED } from './submission-mode';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/session';
import { enqueueFeedbackNotification } from './notification';
import { snapshotFeedbackAttachments } from './attachments';
import { feedbackSourceKey, type FeedbackSource, type FeedbackPluginSite } from './source';

export class FeedbackSubmissionError extends Error {
  constructor(message: string, public code = 'FEEDBACK_INPUT_INVALID', public status = 400) { super(message); }
}
export type FeedbackSubmissionResult = { success: true; replayed: boolean; feedback: { id: string }; attachments: { saved: number; notSaved: number } };
type SubmissionInput = { operationId?: unknown; expectedUserId?: unknown; content?: unknown; imageUrls?: unknown;
  uploadedAssetIds?: unknown; taskId?: unknown; pageUrl?: unknown; pathname?: unknown; context?: unknown };
type Receipt = { version: 1; inputHash: string; result: FeedbackSubmissionResult };
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
export function feedbackOperationId(value: unknown) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new FeedbackSubmissionError('原提交编号无效，请保留原稿重新核对');
  return value;
}
export function assertFeedbackIdentity(expected: unknown, userId: string | null) {
  if (expected !== userId) throw new FeedbackSubmissionError('登录账号已变化，请切回原账号核对提交', 'FEEDBACK_IDENTITY_MISMATCH', 409);
}
const receiptKey = (userId: string | null, operationId: string) => `feedback-submit:v1:${userId ?? 'guest'}:${operationId}`;
export async function readFeedbackSubmission(db: Prisma.TransactionClient, userId: string | null, operationId: unknown) {
  const row = await db.platformSetting.findUnique({ where: { key: receiptKey(userId, feedbackOperationId(operationId)) } });
  if (!row) return null;
  // Unreadable receipt is unknown, never permission to create again.
  const receipt = JSON.parse(row.value_json) as Receipt;
  if (receipt.version !== 1 || !receipt.inputHash || !receipt.result?.feedback?.id
    || !Number.isSafeInteger(receipt.result.attachments?.saved) || !Number.isSafeInteger(receipt.result.attachments?.notSaved)) throw new Error('feedback_receipt_invalid');
  return receipt;
}
function pluginSource(value: unknown): FeedbackSource {
  const context = value as Record<string, unknown> | null;
  if (!context || !['chatgpt', 'midjourney', 'jimeng'].includes(String(context.site))
    || typeof context.extensionVersion !== 'string' || !/^[a-zA-Z0-9.+_-]{1,80}$/.test(context.extensionVersion)) throw new FeedbackSubmissionError('插件来源信息无效');
  const site = context.site as FeedbackPluginSite;
  let pageUrl: string | null = null;
  if (context.pageUrl !== undefined && context.pageUrl !== null && context.pageUrl !== '') {
    if (typeof context.pageUrl !== 'string' || context.pageUrl.length > 2000) throw new FeedbackSubmissionError('页面地址无效');
    let url: URL;
    try { url = new URL(context.pageUrl); } catch { throw new FeedbackSubmissionError('页面地址无效'); }
    const hosts = { chatgpt: ['chatgpt.com', 'chat.openai.com'], midjourney: ['midjourney.com', 'www.midjourney.com'], jimeng: ['jimeng.jianying.com'] };
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts[site].includes(url.hostname)) throw new FeedbackSubmissionError('页面地址与插件站点不符');
    url.search = ''; url.hash = ''; pageUrl = url.href;
  }
  return { version: 1, site, extensionVersion: context.extensionVersion, pageUrl };
}
/** Receipt, feedback, source and notification writes belong to the caller's transaction. */
export async function submitFeedback(db: Prisma.TransactionClient, user: SessionUser | null, input: SubmissionInput,
  options: { plugin?: boolean; userAgent: string | null }) {
  const userId = user?.id ?? null;
  const operationId = input.operationId === undefined && !options.plugin ? null : feedbackOperationId(input.operationId);
  if (operationId) assertFeedbackIdentity(input.expectedUserId, userId);
  const content = text(input.content);
  if (!content) throw new FeedbackSubmissionError('请输入反馈内容');
  if (operationId && (input.imageUrls !== undefined && (!Array.isArray(input.imageUrls) || input.imageUrls.some(value => typeof value !== 'string'))
    || input.uploadedAssetIds !== undefined && (!Array.isArray(input.uploadedAssetIds) || input.uploadedAssetIds.some(value => typeof value !== 'string')))) throw new FeedbackSubmissionError('附件信息无效');
  const source = options.plugin ? pluginSource(input.context) : null;
  const normalized = { content, imageUrls: Array.isArray(input.imageUrls) ? input.imageUrls : [],
    uploadedAssetIds: Array.isArray(input.uploadedAssetIds) ? input.uploadedAssetIds : [], taskId: options.plugin ? null : text(input.taskId) || null,
    pathname: source ? `/plugin/${source.site}` : text(input.pathname) || null, pageUrl: source ? source.pageUrl : text(input.pageUrl) || null, source };
  const inputHash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  if (operationId) {
    const receipt = await readFeedbackSubmission(db, userId, operationId);
    if (receipt) {
      if (receipt.inputHash !== inputHash) throw new FeedbackSubmissionError('原提交编号已绑定其他内容，请核对原提交', 'FEEDBACK_OPERATION_CONFLICT', 409);
      return { ...receipt.result, replayed: true };
    }
  }
  if (!FEEDBACK_SUBMISSIONS_ENABLED) throw new FeedbackSubmissionError('反馈暂时无法新提交，请保留原稿；已提交的反馈仍可核对。', 'FEEDBACK_SUBMISSIONS_UNAVAILABLE', 503);
  const { snapshot, imageUrls } = await snapshotFeedbackAttachments(db, userId, normalized.imageUrls, normalized.uploadedAssetIds);
  const feedback = await db.feedback.create({ data: { user_id: userId, task_id: normalized.taskId, content,
    image_urls_json: imageUrls.length ? JSON.stringify(imageUrls) : null, page_url: normalized.pageUrl,
    pathname: normalized.pathname, user_agent: options.userAgent, status: 'new' } });
  const result: FeedbackSubmissionResult = { success: true, replayed: false, feedback: { id: feedback.id },
    attachments: { saved: imageUrls.length, notSaved: snapshot.total - imageUrls.length } };
  if (source) await db.platformSetting.create({ data: { key: feedbackSourceKey(feedback.id), value_json: JSON.stringify(source), updated_by: userId } });
  if (operationId) await db.platformSetting.create({ data: { key: receiptKey(userId, operationId), value_json: JSON.stringify({ version: 1, inputHash, result }), updated_by: userId } });
  await enqueueFeedbackNotification(db, feedback, user, snapshot);
  return result;
}

export async function feedbackSources(db: Prisma.TransactionClient, ids: string[]) {
  if (!ids.length) return new Map<string, FeedbackSource>();
  const rows = await db.platformSetting.findMany({ where: { key: { in: ids.map(feedbackSourceKey) } }, select: { key: true, value_json: true } });
  return new Map(rows.map(row => [row.key.slice('feedback-source:v1:'.length), JSON.parse(row.value_json) as FeedbackSource]));
}
