import { createHash, randomUUID } from 'node:crypto';
import type { ImageStudioTask } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { allocateTaskCredits, settleTaskCredits } from '@/lib/credits/policy';
import { getImageStudioSettings } from './settings';
import { getMuskApiSettings, isMuskApiReady } from '@/lib/integrations/musk';

export class StudioError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function parseStudioRequest(body: Record<string, unknown>) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StudioError('提交内容无效');
  if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(body.requestId)) throw new StudioError('提交编号无效');
  if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 12000) throw new StudioError('请输入 12000 字以内的画面描述');
  if (!Number.isInteger(body.count) || Number(body.count) < 1 || Number(body.count) > 8) throw new StudioError('生成张数必须为 1 到 8');
  if (!Number.isInteger(body.revision)) throw new StudioError('请刷新生成设置');
  if (!Array.isArray(body.referenceIds) || body.referenceIds.length > 2 || body.referenceIds.some(id => typeof id !== 'string' || id.length > 100)) throw new StudioError('最多使用两张有效参考图');
  return { requestId: body.requestId, prompt: body.prompt.trim(), count: Number(body.count), revision: Number(body.revision), referenceIds: body.referenceIds as string[] };
}

export async function submitStudioBatch(ownerId: string, body: Record<string, unknown>) {
  const input = parseStudioRequest(body);
  const batchId = createHash('sha256').update(`${ownerId}:${input.requestId}`).digest('hex');
  const fingerprint = createHash('sha256').update(JSON.stringify({ ...input, requestId: undefined })).digest('hex');
  const previous = await prisma.imageStudioTask.findFirst({ where: { batch_id: batchId, owner_id: ownerId } });
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new StudioError('提交编号已用于其他请求，请重新提交', 409);
    return batchId;
  }
  const settings = await getImageStudioSettings();
  if (settings.revision !== input.revision) throw new StudioError('生成规则或积分已更新，请重新读取设置后确认提交', 409);
  const price = settings.prices[settings.model];
  if (price === null || !Number.isInteger(price) || price < 0 || price > 100000 || !settings.context.trim()) throw new StudioError('管理员尚未设置有效的生成规则和积分', 409);
  if (!isMuskApiReady(await getMuskApiSettings())) throw new StudioError('图片服务尚未配置', 503);
  await prisma.$transaction(async tx => {
    const duplicate = await tx.imageStudioTask.findFirst({ where: { batch_id: batchId, owner_id: ownerId } });
    if (duplicate) {
      if (duplicate.fingerprint !== fingerprint) throw new StudioError('提交编号冲突', 409);
      return;
    }
    const user = await tx.user.findUnique({ where: { id: ownerId } });
    if (!user || user.status !== 'active') throw new StudioError('当前账号无法生成', 403);
    const active = await tx.imageStudioTask.count({ where: { owner_id: ownerId, status: { in: ['queued', 'running'] } } });
    if (active + input.count > 8) throw new StudioError('最多同时生成 8 张，请等待当前任务完成', 429);
    const references = await tx.asset.findMany({ where: { id: { in: input.referenceIds }, owner_id: ownerId, status: 'active', type: 'image' } });
    if (references.length !== new Set(input.referenceIds).size) throw new StudioError('参考图不存在或无权使用', 403);
    for (let i = 0; i < input.count; i++) {
      const id = `${batchId}-${i}`;
      const freeze = price > 0 ? await allocateTaskCredits(tx, user, price, id) : null;
      await tx.imageStudioTask.create({ data: {
        id, batch_id: batchId, owner_id: ownerId, ordinal: i + 1, fingerprint,
        prompt: input.prompt, context: settings.context, revision: settings.revision, model: settings.model,
        reference_ids: JSON.stringify(input.referenceIds), unit_credits: price, freeze_snapshot: freeze?.snapshot,
      } });
      if (freeze) await tx.creditLedger.create({ data: {
        user_id: ownerId, type: 'task_freeze', amount: -price,
        balance_before: freeze.balance_before, balance_after: freeze.balance_after,
        frozen_before: freeze.frozen_before, frozen_after: freeze.frozen_after,
        related_task_id: id, idempotency_key: `image-studio:freeze:${id}`, reason: '图片生成冻结积分',
      } });
    }
  }, { timeout: 15000 });
  return batchId;
}

export async function finishStudioTask(task: ImageStudioTask, status: 'succeeded' | 'failed' | 'uncertain', data: { assetId?: string; error?: string; usage?: unknown } = {}) {
  await prisma.$transaction(async tx => {
    const changed = await tx.imageStudioTask.updateMany({
      where: { id: task.id, status: 'running', lease_token: task.lease_token },
      data: { status, asset_id: data.assetId, error: data.error, usage_json: data.usage ? JSON.stringify(data.usage) : undefined,
        lease_until: null, lease_token: null, finished_at: new Date() },
    });
    if (!changed.count || task.unit_credits === 0) return;
    const settlement = await settleTaskCredits(tx, { taskId: task.id, userId: task.owner_id,
      terminalStatus: status, frozenAmount: task.unit_credits, freezeSnapshot: task.freeze_snapshot });
    await tx.creditLedger.create({ data: {
      user_id: task.owner_id, type: status === 'succeeded' ? 'task_success_deduct' : 'task_failed_refund',
      amount: status === 'succeeded' ? -settlement.actualCost : settlement.refundedAmount,
      balance_before: settlement.balanceBefore, balance_after: settlement.balanceAfter,
      frozen_before: settlement.frozenBefore, frozen_after: settlement.frozenAfter,
      related_task_id: task.id, idempotency_key: `image-studio:settle:${task.id}`,
      reason: status === 'succeeded' ? '图片已保存，结算积分' : '图片未交付，释放冻结积分',
    } });
  }, { timeout: 15000 });
}

export async function claimStudioTask() {
  const candidate = await prisma.imageStudioTask.findFirst({ where: { status: 'queued' }, orderBy: { created_at: 'asc' } });
  if (!candidate) return null;
  const leaseToken = randomUUID();
  const changed = await prisma.imageStudioTask.updateMany({ where: { id: candidate.id, status: 'queued' },
    data: { status: 'running', lease_token: leaseToken, lease_until: new Date(Date.now() + 10 * 60 * 1000) } });
  return changed.count ? { ...candidate, status: 'running', lease_token: leaseToken } : null;
}

export async function listStudioTasks(ownerId: string, cursor?: string) {
  const rows = await prisma.imageStudioTask.findMany({ where: { owner_id: ownerId },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 25,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
  const items = rows.slice(0, 24);
  const assets = await prisma.asset.findMany({ where: { id: { in: items.flatMap(item => item.asset_id ? [item.asset_id] : []) }, owner_id: ownerId, status: 'active' },
    select: { id: true, original_url: true, thumbnail_url: true } });
  return { tasks: items.map(task => ({ id: task.id, batchId: task.batch_id, ordinal: task.ordinal,
    prompt: task.prompt, model: task.model, status: task.status, error: task.error, unitCredits: task.unit_credits,
    createdAt: task.created_at, finishedAt: task.finished_at, referenceIds: JSON.parse(task.reference_ids) as string[],
    asset: assets.find(asset => asset.id === task.asset_id) || null,
  })), nextCursor: rows.length > 24 ? items[items.length - 1].id : null };
}
