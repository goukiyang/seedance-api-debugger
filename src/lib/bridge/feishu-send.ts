import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { videoFeishuActor, videoFeishuBinding } from '@/lib/video/feishu-notification';
import { VideoFeishuError } from '@/lib/video/feishu-contract';
import { ownBridgeFeishuAssets } from './feishu-source';
import { BRIDGE_FEISHU_TYPE, BRIDGE_FEISHU_RATE_KEY, BridgeFeishuError, FEISHU_NOT_BOUND, FEISHU_UNKNOWN,
  normalizeBridgeFeishuInput, bridgeFeishuUuid, parseBridgeFeishuEvent, bridgeFeishuStatus, type BridgeFeishuEvent } from './feishu-contract';

export async function bridgeFeishuActor(db: Prisma.TransactionClient, actorId: string) {
  try { return await videoFeishuActor(db, actorId); }
  catch (error) { if (error instanceof VideoFeishuError && error.status === 401) throw new BridgeFeishuError('未登录', 401); throw error; }
}
export async function preflightBridgeFeishu(actorId: string) {
  const user = await bridgeFeishuActor(prisma, actorId);
  return user.feishu_open_id ? { ok: true, bound: true } : { ok: true, bound: false, error: FEISHU_NOT_BOUND };
}
export async function readBridgeFeishuSend(actorId: string, eventId: string) {
  const row = await prisma.notification.findFirst({ where: { id: eventId, target_user_id: actorId, type: BRIDGE_FEISHU_TYPE, channel: 'feishu' } });
  if (!row) throw new BridgeFeishuError('找不到这条发送记录', 404);
  const meta = parseBridgeFeishuEvent(row.metadata_json);
  if (!meta || meta.actorId !== actorId || meta.eventId !== row.id) throw new BridgeFeishuError('发送记录暂时无法读取，请稍后再试', 503);
  return bridgeFeishuStatus(meta);
}
export async function enqueueBridgeFeishuSend(actorId: string, value: unknown) {
  const input = normalizeBridgeFeishuInput(value);
  const eventId = bridgeFeishuUuid(actorId, input.requestId, 'event');
  for (let attempt = 0; ; attempt++) {
    try { return await prisma.$transaction(async tx => {
      const user = await bridgeFeishuActor(tx, actorId);
      const row = await tx.notification.findUnique({ where: { id: eventId } });
      let meta: BridgeFeishuEvent | null = null;
      if (row) {
        meta = parseBridgeFeishuEvent(row.metadata_json);
        if (row.type !== BRIDGE_FEISHU_TYPE || row.channel !== 'feishu' || row.target_user_id !== actorId || !meta
          || meta.actorId !== actorId || meta.eventId !== eventId) throw new BridgeFeishuError('发送记录暂时无法读取，请稍后再试', 503);
        if (meta.state !== 'failed') return bridgeFeishuStatus(meta);
        if (meta.message.uncertain || meta.images.some(image => image.uploading)) return { ok: true, id: eventId, state: 'failed', reason: FEISHU_UNKNOWN };
        if (meta.message.receiptId) return { ok: true, id: eventId, state: 'sent', reason: '' };
      }
      if (!user.feishu_open_id) throw new BridgeFeishuError(FEISHU_NOT_BOUND, 409, 'feishu_not_bound');
      const identity = videoFeishuBinding(user);
      if (!identity) throw new BridgeFeishuError('飞书发送服务暂不可用，请联系管理员检查应用配置', 503);
      if (meta && meta.identity !== identity) throw new BridgeFeishuError('飞书绑定已变化，请重新发起发送', 409);
      // A retry resumes the original content, never the newly supplied body.
      const assets = await ownBridgeFeishuAssets(tx, actorId, (meta?.input ?? input).assetIds);
      if (meta && JSON.stringify(assets) !== JSON.stringify(meta.assets)) throw new BridgeFeishuError('图片原件已变化，请重新发起发送', 409);
      const now = Date.now();
      const rateWhere = { user_id_key: { user_id: actorId, key: BRIDGE_FEISHU_RATE_KEY } };
      const rate = await tx.userPreference.findUnique({ where: rateWhere });
      const previous: number[] = rate ? JSON.parse(rate.value_json) : [];
      const times = previous.filter(time => time > now - 60_000);
      if (times.length >= 10) throw new BridgeFeishuError('发送太频繁了，请一分钟后再试', 429);
      times.push(now);
      await tx.userPreference.upsert({ where: rateWhere, create: { user_id: actorId, key: BRIDGE_FEISHU_RATE_KEY, value_json: JSON.stringify(times) }, update: { value_json: JSON.stringify(times) } });
      if (meta) {
        meta.state = 'queued'; meta.reason = null; meta.nextAttemptAt = now; meta.attempts = 0; meta.leaseToken = null; meta.leaseUntil = null;
        const changed = await tx.notification.updateMany({ where: { id: eventId, status: 'failed', metadata_json: row!.metadata_json },
          data: { status: 'pending', error_message: null, metadata_json: JSON.stringify(meta) } });
        if (changed.count !== 1) throw new BridgeFeishuError('发送状态已变化，请稍后查询原记录', 409);
      } else {
        meta = { version: 1, actorId, eventId, identity, input, assets, state: 'queued', reason: null, leaseToken: null, leaseUntil: null,
          nextAttemptAt: now, attempts: 0, images: assets.map(() => ({ key: null, uploading: false })),
          message: { uuid: bridgeFeishuUuid(actorId, input.requestId, 'message'), uncertain: false, receiptId: null } };
        await tx.notification.create({ data: { id: eventId, type: BRIDGE_FEISHU_TYPE, channel: 'feishu', status: 'pending',
          target_user_id: actorId, actor_user_id: actorId, title: '插件出图发到本人飞书', metadata_json: JSON.stringify(meta) } });
      }
      return bridgeFeishuStatus(meta);
    }); } catch (error) {
      // SQLite contention can expire an already-open transaction as well as reject BEGIN.
      // Only DB work is retried; the stable event ID also resolves an already-committed receipt.
      if (attempt >= 2 || !['P1008', 'P2028'].includes((error as { code?: string } | null)?.code ?? '')) throw error;
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
}
