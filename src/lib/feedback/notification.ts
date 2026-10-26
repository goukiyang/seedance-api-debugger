import { createHash } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { adminNavItems, isNavItemActive, userNavItems } from '@/lib/navigation';
import { feedbackAttachmentNotice, validFeedbackAttachments, type FeedbackAttachments } from './attachments';

const feedbackGlobal = globalThis as unknown as { feedbackPrisma?: PrismaClient };
// Feedback may contain pasted credentials. Never let database errors print it.
export const feedbackPrisma = feedbackGlobal.feedbackPrisma ?? new PrismaClient({ log: [], errorFormat: 'minimal' });
if (process.env.NODE_ENV !== 'production') feedbackGlobal.feedbackPrisma = feedbackPrisma;

export const FEEDBACK_NOTIFICATION_TYPE = 'feedback_feishu_v1';
export const FEEDBACK_SITE = 'https://sd2.youdooart.com';
// Feishu deduplicates uuid for one hour. Leave a margin for clocks and requests.
export const SEND_WINDOW_MS = 50 * 60_000;
export const LEASE_MS = 90_000;

export type FeedbackMessage = { msgType: 'text' | 'interactive'; content: string };

export type FeedbackDelivery = {
  version: 1 | 2;
  eventKey: string;
  feedbackId: string;
  uuid: string;
  identity: string;
  state: 'pending' | 'sent' | 'failed' | 'unknown';
  attempts: number;
  nextAttemptAt: number;
  firstSendAt: number | null;
  leaseToken: string | null;
  leaseUntil: number | null;
  receiptId: string | null;
  ambiguousSend: boolean;
  lastErrorCode: string | null;
  message?: FeedbackMessage;
  preparation?: {
    authorId: string | null;
    author: string;
    page: string;
    summary: string;
    until: number;
    cycles: number;
    attachments: FeedbackAttachments;
  };
};

export function feedbackConfig() {
  const recipientId = process.env.FEISHU_FEEDBACK_RECIPIENT_USER_ID || '';
  return {
    enabled: process.env.FEISHU_FEEDBACK_ENABLED === 'true',
    recipientId: /^[a-zA-Z0-9_-]{1,80}$/.test(recipientId) ? recipientId : '',
    identity: process.env.FEISHU_FEEDBACK_IDENTITY_SHA256 || '',
    appId: process.env.FEISHU_APP_ID || '',
    appSecret: process.env.FEISHU_APP_SECRET || '',
    tenant: process.env.FEISHU_ALLOWED_TENANT_KEY || '',
  };
}

export function recipientIdentity(userId: string, openId: string, appId: string, tenant: string) {
  return createHash('sha256').update(JSON.stringify([userId, openId, appId, tenant])).digest('hex');
}

type Recipient = { id: string; status: string; role: string; expires_at: Date | null; feishu_open_id: string | null; feishu_tenant_key: string | null };
export function validFeedbackRecipient(user: Recipient | null, config = feedbackConfig()) {
  return Boolean(user && /^[a-zA-Z0-9_-]{1,80}$/.test(config.recipientId) && user.id === config.recipientId
    && user.status === 'active' && user.role === 'admin'
    && (!user.expires_at || user.expires_at.getTime() > Date.now())
    && config.appId && config.appSecret && config.tenant && user.feishu_tenant_key === config.tenant
    && user.feishu_open_id && /^[a-f0-9]{64}$/.test(config.identity)
    && recipientIdentity(user.id, user.feishu_open_id, config.appId, config.tenant) === config.identity);
}

export function feedbackEventId(feedbackId: string) {
  return createHash('sha256').update(`${FEEDBACK_NOTIFICATION_TYPE}:${feedbackId}`).digest('hex').slice(0, 32);
}

export function safeFeedbackSummary(content: string) {
  // Unstructured pasted diagnostics are not safe notification excerpts.
  if (/(?:password|passwd|secret|token|cookie|authorization|credential|api[_ -]?key|bearer|密码|口令|密钥|凭据|令牌|验证码|私钥|-----BEGIN)/i.test(content)) {
    return '内容可能包含敏感信息，请在后台查看。';
  }
  return content
    .replace(/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/gi, '[链接已隐藏]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[邮箱已隐藏]')
    .replace(/[a-zA-Z0-9_+\/=.-]{24,}/g, '[长标识已隐藏]')
    .replace(/<[^>]*>/g, '')
    .replace(/[<>\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 200) || '请在后台查看完整内容。';
}

export function safeFeedbackPath(pathname: string | null) {
  if (!pathname?.startsWith('/') || pathname.startsWith('//')) return '未提供';
  const path = pathname.split(/[?#]/, 1)[0];
  if (!/^\/[a-zA-Z0-9/_-]*$/.test(path) || path.length > 120
    || path.split('/').some(part => part.length > 24 || /(?:token|secret|password|key)/i.test(part))) return '已隐藏';
  return path || '/';
}

export function safeFeedbackAuthor(name: string | null | undefined, signedIn: boolean) {
  return name && new RegExp('^[\\p{L} .-]{1,24}$', 'u').test(name) ? name : signedIn ? '站内用户' : '未登录访客';
}

export function feedbackPageName(pathname: string | null) {
  const path = safeFeedbackPath(pathname);
  if (path === '/image-studio') return '图片生成';
  const items = [...userNavItems, ...adminNavItems].filter(item => isNavItemActive(path, item));
  items.sort((a, b) => b.href.length - a.href.length);
  return items[0]?.label || '其他页面';
}

export function feedbackDeliveryMessage(meta: FeedbackDelivery, body: string | null): FeedbackMessage | null {
  const message = meta.message ?? (meta.version === 1 && body ? { msgType: 'text', content: JSON.stringify({ text: body }) } : null);
  if (!message || !['text', 'interactive'].includes(message.msgType) || typeof message.content !== 'string'
    || !message.content || (meta.version === 1 ? message.content.length > 4000 : Buffer.byteLength(message.content, 'utf8') > 26_000)) return null;
  try {
    const content = JSON.parse(message.content);
    if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
    if (message.msgType === 'text' && typeof content.text !== 'string') return null;
    if (message.msgType === 'interactive' && !Array.isArray(content.elements)) return null;
    return message;
  } catch { return null; }
}

export function feedbackImageCard(meta: FeedbackDelivery): FeedbackMessage | null {
  const preparation = meta.preparation;
  if (meta.version !== 2 || !preparation || preparation.attachments.items.some(item => ['pending', 'uploading'].includes(item.state))) return null;
  const plain = (content: string) => ({ tag: 'plain_text', content });
  const images = preparation.attachments.items.filter(item => item.state === 'ready');
  const notice = feedbackAttachmentNotice(preparation.attachments);
  return { msgType: 'interactive', content: JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: plain('新修改意见') },
    elements: [
      { tag: 'div', text: plain(preparation.summary) },
      ...images.map((item, index) => ({ tag: 'img', img_key: item.imageKey, mode: 'fit_horizontal', alt: plain(`反馈截图 ${index + 1}`) })),
      ...(notice ? [{ tag: 'note', elements: [plain(notice)] }] : []),
      { tag: 'note', elements: [plain(`${preparation.author} · ${preparation.page}`), plain('Seedance2.0系统反馈通知')] },
      { tag: 'action', actions: [{ tag: 'button', type: 'primary', text: plain('查看意见'),
        url: `${FEEDBACK_SITE}/admin/feedback?feedbackId=${encodeURIComponent(meta.feedbackId)}` }] },
    ],
  }) };
}

function feedbackCard(feedbackId: string, author: string, page: string, summary: string, attachmentCount: number): FeedbackMessage {
  const plain = (content: string) => ({ tag: 'plain_text', content });
  return { msgType: 'interactive', content: JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: plain('新修改意见') },
    elements: [
      { tag: 'note', elements: [plain('Seedance2.0系统反馈通知')] },
      { tag: 'div', text: plain(`提交人：${author}\n页面：${page}`) },
      { tag: 'div', text: plain(summary) },
      ...(attachmentCount > 0 ? [{ tag: 'div', text: plain(`截图：${attachmentCount} 张`) }] : []),
      { tag: 'action', actions: [{ tag: 'button', type: 'primary', text: plain('查看意见'),
        url: `${FEEDBACK_SITE}/admin/feedback?feedbackId=${encodeURIComponent(feedbackId)}` }] },
    ],
  }) };
}

export function parseFeedbackDelivery(value: string | null): FeedbackDelivery | null {
  try {
    const data = JSON.parse(value || '') as FeedbackDelivery;
    if (![1, 2].includes(data.version) || !/^[a-zA-Z0-9_-]{1,80}$/.test(data.feedbackId)
      || data.uuid !== feedbackEventId(data.feedbackId)
      || data.eventKey !== `${FEEDBACK_NOTIFICATION_TYPE}:${data.feedbackId}`
      || !['pending', 'sent', 'failed', 'unknown'].includes(data.state)
      || !Number.isSafeInteger(data.attempts) || data.attempts < 0
      || !Number.isSafeInteger(data.nextAttemptAt) || data.nextAttemptAt < 0
      || (data.firstSendAt !== null && (!Number.isSafeInteger(data.firstSendAt) || data.firstSendAt < 0))
      || (data.leaseUntil !== null && (!Number.isSafeInteger(data.leaseUntil) || data.leaseUntil < 0))
      || (data.leaseToken !== null && typeof data.leaseToken !== 'string')
      || typeof data.identity !== 'string'
      || (data.message !== undefined && !feedbackDeliveryMessage(data, null))
      || (data.ambiguousSend !== undefined && typeof data.ambiguousSend !== 'boolean')
      || (data.lastErrorCode !== undefined && data.lastErrorCode !== null
        && (typeof data.lastErrorCode !== 'string' || !/^[a-z0-9_-]{1,100}$/.test(data.lastErrorCode)))) return null;
    if (data.version === 2) {
      const prep = data.preparation;
      if (!prep || !validFeedbackAttachments(prep.attachments)
        || (prep.authorId !== null && !/^[a-zA-Z0-9_-]{1,80}$/.test(prep.authorId))
        || prep.attachments.items.some(item => item.ownerId !== prep.authorId)
        || typeof prep.author !== 'string' || prep.author.length > 24 || typeof prep.page !== 'string' || prep.page.length > 80
        || typeof prep.summary !== 'string' || prep.summary.length > 200
        || !Number.isSafeInteger(prep.until) || prep.until < 0 || !Number.isSafeInteger(prep.cycles) || prep.cycles < 0 || prep.cycles > 100
        || (data.message && prep.attachments.items.some(item => ['pending', 'uploading'].includes(item.state)))
        || (!data.message && (data.firstSendAt !== null || data.ambiguousSend))) return null;
    }
    // Older metadata lacking the flag is conservative once a send was attempted.
    return { ...data, ambiguousSend: data.ambiguousSend ?? (data.firstSendAt !== null), lastErrorCode: data.lastErrorCode ?? null };
  } catch { return null; }
}

export async function enqueueFeedbackNotification(
  tx: Prisma.TransactionClient,
  feedback: { id: string; content: string; pathname: string | null },
  author: { name?: string | null; id: string } | null,
  attachments: FeedbackAttachments | number,
) {
  const config = feedbackConfig();
  if (!config.enabled) return;
  if (!config.recipientId) { console.warn('feedback_recipient_configuration_invalid'); return; }
  const recipient = await tx.user.findUnique({ where: { id: config.recipientId }, select: {
    id: true, status: true, role: true, expires_at: true, feishu_open_id: true, feishu_tenant_key: true,
  } });
  // A deleted FK target cannot own an outbox row. Never redirect to another user.
  if (!recipient) { console.warn('feedback_recipient_missing'); return; }
  const valid = validFeedbackRecipient(recipient, config);
  const safeAuthor = safeFeedbackAuthor(author?.name, Boolean(author));
  const summary = safeFeedbackSummary(feedback.content);
  const page = feedbackPageName(feedback.pathname);
  const attachmentCount = typeof attachments === 'number' ? attachments : attachments.total;
  const meta: FeedbackDelivery = {
    version: typeof attachments === 'number' ? 1 : 2, eventKey: `${FEEDBACK_NOTIFICATION_TYPE}:${feedback.id}`, feedbackId: feedback.id,
    uuid: feedbackEventId(feedback.id), identity: config.identity, state: valid ? 'pending' : 'failed',
    attempts: 0, nextAttemptAt: Date.now(), firstSendAt: null, leaseToken: null, leaseUntil: null, receiptId: null,
    ambiguousSend: false, lastErrorCode: null,
    ...(typeof attachments === 'number' ? { message: feedbackCard(feedback.id, safeAuthor, page, summary, attachmentCount) }
      : { preparation: { authorId: author?.id || null, author: safeAuthor, page, summary, until: Date.now() + 30 * 60_000, cycles: 0, attachments } }),
  };
  await tx.notification.create({ data: {
    id: meta.uuid, type: FEEDBACK_NOTIFICATION_TYPE, channel: 'feishu', status: valid ? 'pending' : 'failed',
    target_user_id: config.recipientId, title: '新修改意见',
    body: ['Seedance2.0系统反馈通知', '新修改意见',
      `提交人：${safeAuthor}`, `页面：${page}`, `摘要：${summary}`,
      ...(attachmentCount > 0 ? [`截图：${attachmentCount} 张`] : []),
      `后台查看：${FEEDBACK_SITE}/admin/feedback?feedbackId=${encodeURIComponent(feedback.id)}`].join('\n'),
    metadata_json: JSON.stringify(meta), error_message: valid ? null : 'feedback_identity_invalid',
  } });
}
