import { createHash, timingSafeEqual } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { feedbackConfig, FEEDBACK_ACK_NOTIFICATION_TYPE, FEEDBACK_SITE, parseFeedbackDelivery, recipientIdentity, safeFeedbackSummary, validFeedbackRecipient } from './notification';
import { snapshotFeedbackAttachments } from './attachments';
import { FeedbackFlowError, feedbackRoundKey, parseFeedbackRound, readFeedbackFlow, saveFeedbackFlow,
  validFeedbackId, type FeedbackRepairRound } from './flow-state';

export const FEEDBACK_RETEST_TYPE = 'feedback_retest_feishu_v1';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const feedbackRetestNotificationId = (id: string, round: number) => digest([FEEDBACK_RETEST_TYPE, id, round]).slice(0, 32);
const actorSelect = { id: true, status: true, role: true, expires_at: true, feishu_open_id: true, feishu_tenant_key: true } as const;
async function actor(db: Prisma.TransactionClient, id: string, admin = false) {
  const row = await db.user.findUnique({ where: { id }, select: actorSelect });
  if (!row || row.status !== 'active' || row.expires_at && row.expires_at.getTime() <= Date.now()
    || admin && row.role !== 'admin') throw new FeedbackFlowError('当前账号无权执行此操作', 403);
  return row;
}
function operationId(value: unknown): string {
  if (!validFeedbackId(value)) throw new FeedbackFlowError('原操作编号无效，请保留原操作重新核对', 400);
  return value;
}
const feedbackSelect = { id: true, user_id: true, content: true, pathname: true, task_id: true,
  image_urls_json: true, created_at: true } as const;
async function feedbackRow(db: Prisma.TransactionClient, id: string) {
  if (!validFeedbackId(id)) throw new FeedbackFlowError('反馈编号无效', 400);
  const row = await db.feedback.findUnique({ where: { id }, select: feedbackSelect });
  if (!row) throw new FeedbackFlowError('反馈不存在或无权访问', 404);
  return row;
}
async function roundRow(db: Prisma.TransactionClient, id: string, round: number) {
  const row = await db.platformSetting.findUnique({ where: { key: feedbackRoundKey(id, round) } });
  if (!row) throw new FeedbackFlowError('修复轮次尚未确认，请重新读取', 409);
  return { row, round: parseFeedbackRound(row.value_json, id, round) };
}
export function feedbackAuthorBinding(user: { id: string; status: string; expires_at: Date | null; feishu_open_id: string | null; feishu_tenant_key: string | null }) {
  const config = feedbackConfig();
  return user.status === 'active' && (!user.expires_at || user.expires_at.getTime() > Date.now())
    && config.appId && config.appSecret && config.tenant && user.feishu_open_id && user.feishu_tenant_key === config.tenant
    ? recipientIdentity(user.id, user.feishu_open_id, config.appId, config.tenant) : null;
}
export async function markFeedbackFixed(db: Prisma.TransactionClient, adminId: string, feedbackId: string, input: {
  operationId: unknown; revision: unknown; summary: unknown;
}) {
  await actor(db, adminId, true);
  const feedback = await feedbackRow(db, feedbackId), op = operationId(input.operationId);
  const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
  if (!summary || summary.length > 400 || !Number.isSafeInteger(input.revision) || Number(input.revision) < 0) throw new FeedbackFlowError('请填写简短公开修复说明，并重新读取当前状态', 400);
  const inputHash = digest([adminId, feedbackId, input.revision, summary]);
  const receiptKey = `feedback-repair-op:v1:${feedbackId}:${op}`;
  const receipt = await db.platformSetting.findUnique({ where: { key: receiptKey } });
  if (receipt) {
    const saved = JSON.parse(receipt.value_json);
    if (saved.inputHash !== inputHash || !Number.isSafeInteger(saved.round) || saved.round < 1) throw new FeedbackFlowError('原操作编号已绑定其他修复内容');
    return { round: (await roundRow(db, feedbackId, saved.round)).round, replayed: true };
  }
  const before = await readFeedbackFlow(db, feedbackId);
  if (before.flow.revision !== input.revision) throw new FeedbackFlowError('反馈处理记录已变化，请重新读取；原操作保留');
  const round = before.flow.currentRound + 1;
  const author = feedback.user_id ? await db.user.findUnique({ where: { id: feedback.user_id }, select: actorSelect }) : null;
  const config = feedbackConfig();
  const identity = author && config.enabled ? feedbackAuthorBinding(author) : null;
  const notificationId = author && identity ? feedbackRetestNotificationId(feedbackId, round) : null;
  const unavailable = !author ? 'feedback_author_missing'
    : author.status !== 'active' || author.expires_at && author.expires_at.getTime() <= Date.now() ? 'feedback_author_inactive'
      : !config.enabled ? 'feedback_notifications_disabled'
      : !config.appId || !config.appSecret || !config.tenant ? 'feishu_configuration_unavailable'
        : identity ? null : 'feedback_author_unbound';
  const saved: FeedbackRepairRound = { version: 1, feedbackId, round, operationId: op, inputHash, summary,
    publishedAt: Date.now(), publishedBy: adminId, notificationId,
    notificationUnavailable: unavailable, review: null };
  await saveFeedbackFlow(db, before, { ...before.flow, revision: before.flow.revision + 1, currentRound: round }, adminId);
  await db.platformSetting.create({ data: { key: feedbackRoundKey(feedbackId, round), value_json: JSON.stringify(saved), updated_by: adminId } });
  await db.platformSetting.create({ data: { key: receiptKey, value_json: JSON.stringify({ version: 1, inputHash, round }), updated_by: adminId } });
  if (notificationId && author && identity) {
    const plain = (content: string) => ({ tag: 'plain_text', content });
    const message = { msgType: 'interactive', content: JSON.stringify({ config: { wide_screen_mode: true },
      header: { template: 'blue', title: plain('请回测反馈') }, elements: [
        { tag: 'div', text: plain(safeFeedbackSummary(feedback.content)) },
        { tag: 'div', text: plain(safeFeedbackSummary(summary)) },
        { tag: 'action', actions: [{ tag: 'button', type: 'primary', text: plain('打开并回测'),
          url: `${FEEDBACK_SITE}/feedback/${encodeURIComponent(feedbackId)}?round=${round}` }] },
      ] }) };
    await db.notification.create({ data: { id: notificationId, type: FEEDBACK_RETEST_TYPE, channel: 'feishu', status: 'pending',
      target_user_id: author.id, actor_user_id: adminId, title: '请回测反馈',
      metadata_json: JSON.stringify({ version: 1, feedbackId, round, uuid: notificationId, identity, state: 'pending',
        attempts: 0, nextAttemptAt: Date.now(), firstSendAt: null, leaseToken: null, leaseUntil: null,
        receiptId: null, ambiguousSend: false, lastErrorCode: null, message }) } });
  }
  return { round: saved, replayed: false };
}
export async function reviewFeedbackFix(db: Prisma.TransactionClient, userId: string, feedbackId: string, input: {
  operationId: unknown; round: unknown; result: unknown; note?: unknown; imageUrls?: unknown; uploadedAssetIds?: unknown;
}) {
  await actor(db, userId);
  const feedback = await feedbackRow(db, feedbackId);
  if (feedback.user_id !== userId) throw new FeedbackFlowError('反馈不存在或无权访问', 404);
  const op = operationId(input.operationId), number = input.round;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 || input.result !== 'passed' && input.result !== 'needs_work'
    || input.note !== undefined && typeof input.note !== 'string') throw new FeedbackFlowError('回测内容无效', 400);
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (note.length > 2000) throw new FeedbackFlowError('补充说明过长', 400);
  const inputHash = digest([userId, feedbackId, number, input.result, note, input.imageUrls ?? [], input.uploadedAssetIds ?? []]);
  const selected = await roundRow(db, feedbackId, number);
  if (selected.round.review) {
    if (selected.round.review.operationId !== op || selected.round.review.inputHash !== inputHash) throw new FeedbackFlowError('该轮已有回测结论，请重新读取');
    return { round: selected.round, replayed: true };
  }
  const before = await readFeedbackFlow(db, feedbackId);
  if (before.flow.currentRound !== number) throw new FeedbackFlowError('已有新的修复轮次，请回测最新一轮');
  if (input.imageUrls !== undefined && !Array.isArray(input.imageUrls) || input.uploadedAssetIds !== undefined && !Array.isArray(input.uploadedAssetIds)) throw new FeedbackFlowError('附件信息无效', 400);
  const { snapshot, imageUrls } = await snapshotFeedbackAttachments(db, userId, input.imageUrls, input.uploadedAssetIds);
  if (Object.keys(snapshot.excluded).some(code => code !== 'attachment_duplicate')) throw new FeedbackFlowError('部分回测附件已失效或无权使用，请重新选择', 403);
  const updated: FeedbackRepairRound = { ...selected.round, review: { operationId: op, inputHash,
    result: input.result as 'passed' | 'needs_work', note, imageUrls, at: Date.now() } };
  const written = await db.platformSetting.updateMany({ where: { key: selected.row.key, value_json: selected.row.value_json },
    data: { value_json: JSON.stringify(updated), updated_by: userId } });
  if (written.count !== 1) throw new FeedbackFlowError('回测记录已变化，请重新读取；原操作编号保留');
  await saveFeedbackFlow(db, before, { ...before.flow, revision: before.flow.revision + 1 }, userId);
  if (input.result === 'needs_work') await db.feedback.update({ where: { id: feedbackId }, data: { status: 'new', archived_at: null, archived_by: null } });
  return { round: updated, replayed: false };
}
export async function acknowledgeFeedback(db: Prisma.TransactionClient, input: {
  feedbackId: unknown; nonce: unknown; openId: unknown; messageId: unknown;
}) {
  if (!validFeedbackId(input.feedbackId) || typeof input.nonce !== 'string' || !/^[a-f0-9]{48}$/.test(input.nonce)
    || typeof input.openId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(input.openId)
    || typeof input.messageId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(input.messageId)) throw new FeedbackFlowError('卡片操作无效', 400);
  const before = await readFeedbackFlow(db, input.feedbackId), ack = before.flow.acknowledgment;
  if (!ack || !timingSafeEqual(Buffer.from(ack.nonce), Buffer.from(input.nonce))) throw new FeedbackFlowError('卡片已失效，请在后台查看反馈', 403);
  const recipient = await db.user.findUnique({ where: { id: ack.recipientId }, select: actorSelect });
  const config = feedbackConfig();
  if (!validFeedbackRecipient(recipient, config) || ack.identity !== config.identity || recipient!.feishu_open_id !== input.openId) throw new FeedbackFlowError('仅原指定接收人可确认', 403);
  await feedbackRow(db, input.feedbackId);
  const notification = await db.notification.findUnique({ where: { id: ack.notificationId } });
  const meta = notification ? parseFeedbackDelivery(notification.metadata_json) : null;
  if (!notification || notification.type !== FEEDBACK_ACK_NOTIFICATION_TYPE || notification.channel !== 'feishu'
    || notification.target_user_id !== recipient!.id || notification.status !== 'sent'
    || !meta || meta.identity !== ack.identity || meta.uuid !== ack.notificationId || meta.ackNonce !== ack.nonce
    || meta.feedbackId !== input.feedbackId || meta.receiptId !== input.messageId) throw new FeedbackFlowError('原通知回执尚未确认，请稍后或在后台查看');
  const receivedAt = ack.receivedAt ?? Date.now();
  if (ack.receivedAt === null) await saveFeedbackFlow(db, before, { ...before.flow, revision: before.flow.revision + 1,
    acknowledgment: { ...ack, receivedAt } }, recipient!.id);
  return { receivedAt, message: meta.message };
}
export async function feedbackLifecycleView(db: Prisma.TransactionClient, userId: string, feedbackId: string, options: {
  admin?: boolean; round?: number;
} = {}) {
  await actor(db, userId, Boolean(options.admin));
  const feedback = await feedbackRow(db, feedbackId);
  if (!options.admin && feedback.user_id !== userId) throw new FeedbackFlowError('反馈不存在或无权访问', 404);
  const { flow } = await readFeedbackFlow(db, feedbackId);
  const round = options.round ?? flow.currentRound;
  if (!Number.isSafeInteger(round) || round < 0 || round > flow.currentRound) throw new FeedbackFlowError('修复轮次无效', 400);
  const selected = round > 0 ? (await roundRow(db, feedbackId, round)).round : null;
  const delivery = selected?.notificationId ? await db.notification.findUnique({ where: { id: selected.notificationId },
    select: { status: true, error_message: true } }) : null;
  return { feedback, revision: flow.revision, currentRound: flow.currentRound, receivedAt: flow.acknowledgment?.receivedAt ?? null,
    round: selected ? { number: selected.round, summary: selected.summary, publishedAt: selected.publishedAt,
      ...(options.admin ? { operationId: selected.operationId } : {}),
      review: selected.review ? { operationId: selected.review.operationId, result: selected.review.result, note: selected.review.note, imageUrls: selected.review.imageUrls, at: selected.review.at } : null,
      delivery: delivery ? { status: delivery.status, error: delivery.error_message } : { status: 'unavailable', error: selected.notificationUnavailable } } : null };
}
