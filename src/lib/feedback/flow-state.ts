import { randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';

export class FeedbackFlowError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
export type FeedbackFlow = {
  version: 1;
  feedbackId: string;
  revision: number;
  currentRound: number;
  acknowledgment: null | {
    recipientId: string;
    identity: string;
    notificationId: string;
    nonce: string;
    receivedAt: number | null;
  };
};
export type FeedbackRepairRound = {
  version: 1;
  feedbackId: string;
  round: number;
  operationId: string;
  inputHash: string;
  summary: string;
  publishedAt: number;
  publishedBy: string;
  notificationId: string | null;
  notificationUnavailable: string | null;
  review: null | {
    operationId: string;
    inputHash: string;
    result: 'passed' | 'needs_work';
    note: string;
    imageUrls: string[];
    at: number;
  };
};
export const feedbackFlowKey = (id: string) => `feedback-flow:v1:${id}`;
export const feedbackRoundKey = (id: string, round: number) => `feedback-repair:v1:${id}:${round}`;
export const validFeedbackId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function initialFeedbackFlow(feedbackId: string): FeedbackFlow {
  if (!validFeedbackId(feedbackId)) throw new FeedbackFlowError('反馈编号无效', 400);
  return { version: 1, feedbackId, revision: 0, currentRound: 0, acknowledgment: null };
}
export function parseFeedbackFlow(raw: string, feedbackId: string): FeedbackFlow {
  try {
    const value = JSON.parse(raw) as FeedbackFlow;
    if (value.version !== 1 || value.feedbackId !== feedbackId || !integer(value.revision) || !integer(value.currentRound)) throw new Error();
    const ack = value.acknowledgment;
    if (ack !== null && (!ack || !validFeedbackId(ack.recipientId) || !hash(ack.identity)
      || !/^[a-f0-9]{32}$/.test(ack.notificationId) || !/^[a-f0-9]{48}$/.test(ack.nonce)
      || ack.receivedAt !== null && !integer(ack.receivedAt))) throw new Error();
    return value;
  } catch { throw new FeedbackFlowError('反馈处理记录暂不可核对，请重新读取', 503); }
}
export function parseFeedbackRound(raw: string, feedbackId: string, round: number): FeedbackRepairRound {
  try {
    const value = JSON.parse(raw) as FeedbackRepairRound;
    if (value.version !== 1 || value.feedbackId !== feedbackId || value.round !== round || !integer(round) || round < 1
      || !validFeedbackId(value.operationId) || !hash(value.inputHash) || !validFeedbackId(value.publishedBy)
      || typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 400 || !integer(value.publishedAt)
      || value.notificationId !== null && !/^[a-f0-9]{32}$/.test(value.notificationId)
      || value.notificationUnavailable !== null && typeof value.notificationUnavailable !== 'string') throw new Error();
    const review = value.review;
    if (review !== null && (!review || !validFeedbackId(review.operationId) || !hash(review.inputHash)
      || !['passed', 'needs_work'].includes(review.result) || typeof review.note !== 'string' || review.note.length > 2000
      || !Array.isArray(review.imageUrls) || review.imageUrls.length > 128 || review.imageUrls.some(url => typeof url !== 'string' || url.length > 2000)
      || !integer(review.at))) throw new Error();
    return value;
  } catch { throw new FeedbackFlowError('修复轮次记录暂不可核对，请重新读取', 503); }
}
export async function readFeedbackFlow(db: Prisma.TransactionClient, feedbackId: string) {
  const row = await db.platformSetting.findUnique({ where: { key: feedbackFlowKey(feedbackId) } });
  return { row, flow: row ? parseFeedbackFlow(row.value_json, feedbackId) : initialFeedbackFlow(feedbackId) };
}
export async function saveFeedbackFlow(db: Prisma.TransactionClient, before: Awaited<ReturnType<typeof readFeedbackFlow>>,
  next: FeedbackFlow, actorId: string) {
  if (next.feedbackId !== before.flow.feedbackId || next.revision !== before.flow.revision + 1) throw new FeedbackFlowError('处理记录版本不一致');
  const value_json = JSON.stringify(next);
  if (!before.row) {
    await db.platformSetting.create({ data: { key: feedbackFlowKey(next.feedbackId), value_json, updated_by: actorId } });
  } else {
    const saved = await db.platformSetting.updateMany({ where: { key: before.row.key, value_json: before.row.value_json },
      data: { value_json, updated_by: actorId } });
    if (saved.count !== 1) throw new FeedbackFlowError('处理记录已变化，请重新读取；原操作编号保留');
  }
}
export async function initializeFeedbackAcknowledgment(db: Prisma.TransactionClient, feedbackId: string,
  recipientId: string, identity: string, notificationId: string) {
  const nonce = randomBytes(24).toString('hex');
  const flow: FeedbackFlow = { ...initialFeedbackFlow(feedbackId), revision: 1,
    acknowledgment: { recipientId, identity, notificationId, nonce, receivedAt: null } };
  await db.platformSetting.create({ data: { key: feedbackFlowKey(feedbackId), value_json: JSON.stringify(flow), updated_by: recipientId } });
  return nonce;
}
