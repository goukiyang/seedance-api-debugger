import { randomUUID } from 'node:crypto';
import type { Notification, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { DeliveryError, feedbackTenantToken } from '@/lib/feedback/delivery';
import { LEASE_MS, SEND_WINDOW_MS } from '@/lib/feedback/notification';
import { videoFeishuBinding } from '@/lib/video/feishu-notification';
import { VideoFeishuError } from '@/lib/video/feishu-contract';
import { uploadImageFeishuOriginal, sendVideoFeishuMessage } from '@/lib/video/feishu-transport';
import { bridgeFeishuActor } from './feishu-send';
import { ownBridgeFeishuAssets, readBridgeFeishuOriginal } from './feishu-source';
import { BRIDGE_FEISHU_TYPE, BridgeFeishuError, FEISHU_UNKNOWN, parseBridgeFeishuEvent, bridgeFeishuCard } from './feishu-contract';

type Row = Pick<Notification, 'id' | 'type' | 'channel' | 'status' | 'target_user_id' | 'metadata_json'>;
const MAX_ATTEMPTS = 3;
/** Only this queue's events are consumed. A durable uncertain intent is never resent. */
export async function deliverBridgeFeishuNotification(db: Prisma.TransactionClient, row: Row) {
  if (row.type !== BRIDGE_FEISHU_TYPE || row.channel !== 'feishu' || row.status !== 'pending') return 'ignored';
  const meta = parseBridgeFeishuEvent(row.metadata_json);
  if (!meta || meta.actorId !== row.target_user_id || meta.eventId !== row.id) {
    await db.notification.updateMany({ where: { id: row.id, type: BRIDGE_FEISHU_TYPE, status: 'pending', metadata_json: row.metadata_json },
      data: { status: 'failed', error_message: 'bridge_feishu_invalid_event' } });
    return 'failed';
  }
  if ((meta.leaseUntil ?? 0) > Date.now() || meta.nextAttemptAt > Date.now()) {
    // Rotate deferred rows out of the bounded scan, so later ready events are not starved.
    await db.notification.updateMany({ where: { id: row.id, status: 'pending', metadata_json: row.metadata_json }, data: { updated_at: new Date() } });
    return 'waiting';
  }
  let raw = row.metadata_json;
  let owned = false;
  const lease = randomUUID();
  const save = async (release = false) => {
    meta.leaseToken = release ? null : lease; meta.leaseUntil = release ? null : Date.now() + LEASE_MS;
    const next = JSON.stringify(meta);
    const terminal = ['sent', 'failed', 'unknown'].includes(meta.state);
    try {
      const changed = await db.notification.updateMany({ where: { id: row.id, type: BRIDGE_FEISHU_TYPE, channel: 'feishu', status: 'pending', metadata_json: raw },
        data: { metadata_json: next, ...(terminal ? { status: meta.state === 'sent' ? 'sent' : 'failed',
          sent_at: meta.state === 'sent' ? new Date() : null, error_message: meta.state === 'sent' ? null : meta.reason } : {}) } });
      if (changed.count !== 1) throw new Error('lease_lost');
    } catch { owned = false; throw new Error('lease_lost'); }
    raw = next; owned = !release && !terminal;
  };
  const finish = async (state: 'failed' | 'unknown' | 'sent', reason: string | null) => {
    meta.state = state; meta.reason = reason; await save(true); return state;
  };
  try {
    await save();
    if (meta.message.receiptId) return await finish('sent', null);
    if (meta.state === 'unknown' || meta.message.uncertain || meta.images.some(image => image.uploading)) return await finish('unknown', FEISHU_UNKNOWN);
    if (!['queued', 'sending'].includes(meta.state)) return await finish('failed', '发送记录状态异常，请联系管理员');
    meta.state = 'sending'; meta.reason = null; meta.attempts++; await save();
    const authority = async () => {
      const user = await bridgeFeishuActor(db, meta.actorId);
      if (videoFeishuBinding(user) !== meta.identity) throw new BridgeFeishuError('飞书绑定或应用配置已变化，已停止发送', 409);
      const current = await ownBridgeFeishuAssets(db, meta.actorId, meta.input.assetIds);
      if (JSON.stringify(current) !== JSON.stringify(meta.assets)) throw new BridgeFeishuError('图片原件已变化，已停止发送', 409);
      return user.feishu_open_id!;
    };
    await authority();
    const sources: Awaited<ReturnType<typeof readBridgeFeishuOriginal>>[] = [];
    for (const asset of meta.assets) { await save(); sources.push(await readBridgeFeishuOriginal(asset)); }
    const token = await feedbackTenantToken();
    const beforeExternal = async () => {
      const openId = await authority();
      for (const source of sources) if (!await source.current()) throw new BridgeFeishuError('图片原件已变化，已停止发送', 409);
      return openId;
    };
    for (let index = 0; index < meta.images.length; index++) {
      const image = meta.images[index];
      if (image.key) continue;
      await beforeExternal(); image.uploading = true; await save();
      try { image.key = await uploadImageFeishuOriginal(token, sources[index].file, sources[index].extension); }
      catch (error) {
        // An upload has no UUID. Unknown uploads are not repeated either.
        if (error instanceof VideoFeishuError && !error.ambiguous) image.uploading = false;
        throw error;
      }
      image.uploading = false; await save();
    }
    const openId = await beforeExternal();
    meta.message.uncertain = true; await save();
    let receipt: string;
    try {
      receipt = await sendVideoFeishuMessage(token, openId, meta.message.uuid, 'interactive', bridgeFeishuCard(meta), Date.now() + SEND_WINDOW_MS, meta.leaseUntil!);
    } catch (error) {
      if (error instanceof VideoFeishuError && !error.ambiguous) meta.message.uncertain = false;
      throw error;
    }
    // Keep a failed receipt write separate from an external rejection. The durable intent stays unknown.
    meta.message.receiptId = receipt; meta.message.uncertain = false;
    return await finish('sent', null);
  } catch (error) {
    if (!owned) return 'lease_lost';
    if (meta.message.uncertain || meta.images.some(image => image.uploading)) return await finish('unknown', FEISHU_UNKNOWN);
    const retryable = error instanceof DeliveryError || error instanceof VideoFeishuError ? error.retryable : false;
    const reason = error instanceof BridgeFeishuError ? error.message : '飞书未接收本次发送，请稍后重试或联系管理员检查应用权限';
    if (retryable && meta.attempts < MAX_ATTEMPTS) {
      meta.state = 'queued'; meta.reason = '飞书暂不可用，稍后自动重试'; meta.nextAttemptAt = Date.now() + 20_000;
      await save(true); return 'deferred';
    }
    return await finish('failed', reason);
  }
}

export async function processBridgeFeishuDeliveries(limit = 1) {
  const rows = await prisma.notification.findMany({ where: { type: BRIDGE_FEISHU_TYPE, channel: 'feishu', status: 'pending' },
    orderBy: [{ updated_at: 'asc' }, { id: 'asc' }], take: 50,
    select: { id: true, type: true, channel: true, status: true, target_user_id: true, metadata_json: true } });
  const bound = Number.isSafeInteger(limit) ? Math.max(1, Math.min(50, limit)) : 1;
  let processed = 0;
  for (const row of rows) {
    const result = await deliverBridgeFeishuNotification(prisma, row);
    if (!['ignored', 'waiting', 'lease_lost'].includes(result)) processed++;
    if (processed >= bound) break;
  }
  return { scanned: rows.length, processed };
}
