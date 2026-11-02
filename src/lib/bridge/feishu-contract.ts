import { createHash } from 'node:crypto';

export const BRIDGE_FEISHU_TYPE = 'bridge_feishu_v1';
export const BRIDGE_FEISHU_RATE_KEY = 'bridge.feishu.rate.v1';
export const BRIDGE_FEISHU_MAX_BYTES = 10_000_000;
export const FEISHU_NOT_BOUND = '你的 SD2 账号还没绑定飞书，请用飞书登录一次 SD2';
export const FEISHU_UNKNOWN = '结果未知，请到飞书里看一下是否已收到';
export class BridgeFeishuError extends Error {
  constructor(message: string, readonly status = 400, readonly code?: string) { super(message); }
}
export type BridgeFeishuInput = { requestId: string; source: 'mj' | 'chatgpt' | 'jimeng'; assetIds: string[]; text: string; link: string };
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export function normalizeBridgeFeishuInput(value: unknown): BridgeFeishuInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeFeishuError('请提交正确的发送内容');
  const item = value as Record<string, unknown>;
  if (typeof item.requestId !== 'string' || !item.requestId.trim() || item.requestId.length > 80) throw new BridgeFeishuError('requestId 不能为空，且不能超过 80 个字符');
  if (typeof item.source !== 'string' || !['mj', 'chatgpt', 'jimeng'].includes(item.source)) throw new BridgeFeishuError('不支持的图片来源');
  if (!Array.isArray(item.assetIds) || item.assetIds.length < 1 || item.assetIds.length > 4 || !item.assetIds.every(id)
    || new Set(item.assetIds).size !== item.assetIds.length) throw new BridgeFeishuError('请选择 1–4 张不同的图片');
  if (item.text !== undefined && (typeof item.text !== 'string' || item.text.length > 4000)) throw new BridgeFeishuError('提示词不能超过 4000 字');
  let link = '';
  if (typeof item.link === 'string' && /^https:\/\/(www\.midjourney\.com|chatgpt\.com|jimeng\.jianying\.com)\//.test(item.link)) {
    try {
      const url = new URL(item.link);
      if (!url.username && !url.password && !url.port && ['https://www.midjourney.com', 'https://chatgpt.com', 'https://jimeng.jianying.com'].includes(url.origin)) link = url.href;
    } catch { /* Invalid optional links are discarded. */ }
  }
  if (link.length > 4000) link = '';
  return { requestId: item.requestId, source: item.source as BridgeFeishuInput['source'], assetIds: item.assetIds,
    text: (item.text as string | undefined) ?? '', link };
}
export function bridgeFeishuUuid(actorId: string, requestId: string, part: 'event' | 'message') {
  const bytes = createHash('sha256').update(JSON.stringify([BRIDGE_FEISHU_TYPE, actorId, requestId, part])).digest();
  bytes[6] = bytes[6] & 15 | 80; bytes[8] = bytes[8] & 63 | 128;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export type BridgeFeishuAsset = { id: string; hash: string; original_url: string; mime_type: string; file_size: number };
export type BridgeFeishuEvent = {
  version: 1; actorId: string; eventId: string; identity: string; input: BridgeFeishuInput; assets: BridgeFeishuAsset[];
  state: 'queued' | 'sending' | 'sent' | 'failed' | 'unknown'; reason: string | null;
  leaseToken: string | null; leaseUntil: number | null; nextAttemptAt: number; attempts: number;
  images: Array<{ key: string | null; uploading: boolean }>;
  message: { uuid: string; uncertain: boolean; receiptId: string | null };
};
/** Validate once at the durable JSON boundary; delivery uses this type internally. */
export function parseBridgeFeishuEvent(raw: string | null): BridgeFeishuEvent | null {
  try {
    if (!raw || raw.length > 40000) return null;
    const meta = JSON.parse(raw) as BridgeFeishuEvent;
    const normalized = normalizeBridgeFeishuInput(meta.input);
    if (meta.version !== 1 || !id(meta.actorId) || meta.eventId !== bridgeFeishuUuid(meta.actorId, normalized.requestId, 'event')
      || !/^[a-f0-9]{64}$/.test(meta.identity) || JSON.stringify(normalized) !== JSON.stringify(meta.input)
      || !['queued', 'sending', 'sent', 'failed', 'unknown'].includes(meta.state)
      || meta.reason !== null && typeof meta.reason !== 'string'
      || meta.leaseToken !== null && !id(meta.leaseToken) || meta.leaseUntil !== null && !Number.isSafeInteger(meta.leaseUntil)
      || !Number.isSafeInteger(meta.nextAttemptAt) || !Number.isSafeInteger(meta.attempts) || meta.attempts < 0
      || meta.assets.length !== normalized.assetIds.length || meta.images.length !== meta.assets.length
      || !meta.assets.every((asset, index) => asset.id === normalized.assetIds[index] && /^[a-f0-9]{64}$/.test(asset.hash)
        && typeof asset.original_url === 'string' && typeof asset.mime_type === 'string' && Number.isSafeInteger(asset.file_size)
        && asset.file_size > 0 && asset.file_size <= BRIDGE_FEISHU_MAX_BYTES)
      || !meta.images.every(image => typeof image.uploading === 'boolean' && (image.key === null || /^[A-Za-z0-9_-]{1,256}$/.test(image.key)))
      || meta.message.uuid !== bridgeFeishuUuid(meta.actorId, normalized.requestId, 'message') || typeof meta.message.uncertain !== 'boolean'
      || meta.message.receiptId !== null && !id(meta.message.receiptId) || meta.state === 'sent' && !meta.message.receiptId) return null;
    return meta;
  } catch { return null; }
}
export function bridgeFeishuStatus(meta: BridgeFeishuEvent) {
  // Older plugins only recognize failed; an unknown send must never look successful.
  return { ok: true, id: meta.eventId, state: meta.state === 'unknown' ? 'failed' : meta.state,
    reason: meta.state === 'unknown' ? FEISHU_UNKNOWN : meta.reason ?? '' };
}
export function bridgeFeishuCard(meta: BridgeFeishuEvent) {
  const label = { mj: 'MJ', chatgpt: 'ChatGPT', jimeng: '即梦' }[meta.input.source];
  const text = Array.from(meta.input.text);
  const elements: Record<string, unknown>[] = [];
  if (text.length) elements.push({ tag: 'div', text: { tag: 'plain_text', content: text.slice(0, 1000).join('') + (text.length > 1000 ? '\n（提示词已截断，显示前 1000 字）' : '') } });
  for (const image of meta.images) elements.push({ tag: 'img', img_key: image.key, alt: { tag: 'plain_text', content: `${label} 原图` }, mode: 'fit_horizontal', preview: true });
  if (meta.input.link) elements.push({ tag: 'action', actions: [{ tag: 'button', type: 'default', text: { tag: 'plain_text', content: `打开 ${label} 作品页` }, url: meta.input.link }] });
  return { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: `${label} 出图 · ${meta.assets.length} 张` } }, elements };
}
