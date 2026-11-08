import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma, retrySqliteBusy } from '@/lib/prisma';
import { addCredits, assertCreditWriteback, creditCents } from './precision';
import { claimCampaignState, type ClaimCampaign, type ClaimCampaignConfig, type ClaimCampaignList, type ClaimCampaignSave, type CreditClaimReceipt } from './claim-types';

const PREFIX = 'credit_claim_campaign_v1:';
const RECEIPT = 'credit_claim_receipt_v1:';
const OPERATION = 'credit_claim_admin_operation_v1:';
type Tx = Prisma.TransactionClient;
export class CreditClaimError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const parse = <T>(text: string): T => JSON.parse(text) as T;
async function actor(tx: Tx, id: string, admin = false) {
  const user = await tx.user.findUnique({ where: { id }, select: { id: true, role: true, status: true, expires_at: true, account_type: true } });
  if (!user || user.status !== 'active' || user.expires_at && user.expires_at <= new Date()) throw new CreditClaimError('账号当前不可用', 403);
  if (admin && user.role !== 'admin') throw new CreditClaimError('仅管理员可设置领取活动', 403);
  return user;
}
function config(value: unknown): ClaimCampaignConfig {
  if (!value || typeof value !== 'object') throw new CreditClaimError('缺少领取设置');
  const input = value as ClaimCampaignConfig;
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 60) throw new CreditClaimError('活动名称需为1至60字');
  if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || input.amount <= 0 || input.amount > 1000000) throw new CreditClaimError('积分需大于0且不超过1000000');
  try { creditCents(input.amount); } catch { throw new CreditClaimError('积分最多保留两位小数'); }
  if (typeof input.enabled !== 'boolean' || !['all', 'internal', 'external'].includes(input.audience)) throw new CreditClaimError('启停或适用账号设置无效');
  const start = typeof input.startsAt === 'string' ? Date.parse(input.startsAt) : NaN;
  const end = typeof input.endsAt === 'string' ? Date.parse(input.endsAt) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new CreditClaimError('结束时间必须晚于开始时间');
  return { name: input.name.trim(), amount: input.amount, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), enabled: input.enabled, audience: input.audience };
}
export async function saveClaimCampaign(userId: string, value: unknown) {
  const input = value as ClaimCampaignSave;
  if (!input || !uuid(input.id) || !uuid(input.operationId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new CreditClaimError('保存编号或版本无效');
  const next = config(input.config);
  const fingerprint = JSON.stringify({ id: input.id, expectedRevision: input.expectedRevision, config: next });
  return retrySqliteBusy(() => prisma.$transaction(async tx => {
    await actor(tx, userId, true);
    const operationKey = OPERATION + userId + ':' + input.operationId;
    const previousOperation = await tx.platformSetting.findUnique({ where: { key: operationKey } });
    if (previousOperation) {
      const result = parse<{ fingerprint: string; campaign: ClaimCampaign }>(previousOperation.value_json);
      if (result.fingerprint !== fingerprint) throw new CreditClaimError('该保存编号已用于其它设置，请重新读取', 409);
      return result.campaign;
    }
    const key = PREFIX + input.id;
    const previous = await tx.platformSetting.findUnique({ where: { key } });
    const before = previous ? parse<ClaimCampaign>(previous.value_json) : null;
    if ((before?.revision || 0) !== input.expectedRevision) throw new CreditClaimError('活动已在其它页面更新，请重新读取后核对；当前输入未提交', 409);
    const now = new Date().toISOString();
    const campaign: ClaimCampaign = { ...next, id: input.id, revision: input.expectedRevision + 1,
      createdBy: before?.createdBy || userId, updatedBy: userId, createdAt: before?.createdAt || now, updatedAt: now };
    const data = { value_json: JSON.stringify(campaign), updated_by: userId };
    if (previous) await tx.platformSetting.update({ where: { key }, data });
    else await tx.platformSetting.create({ data: { key, ...data } });
    await tx.platformSetting.create({ data: { key: operationKey, value_json: JSON.stringify({ fingerprint, campaign }), updated_by: userId } });
    await tx.operationLog.create({ data: { operator_id: userId, action: 'credit_claim_campaign_save', target_type: 'CreditClaimCampaign', target_id: campaign.id,
      detail: JSON.stringify({ operationId: input.operationId, before, after: campaign }) } });
    return campaign;
  }, { timeout: 10000 }));
}
export async function readClaimOperation(userId: string, operationId: string) {
  if (!uuid(operationId)) throw new CreditClaimError('保存编号无效');
  return prisma.$transaction(async tx => {
    await actor(tx, userId, true);
    const row = await tx.platformSetting.findUnique({ where: { key: OPERATION + userId + ':' + operationId } });
    return { found: Boolean(row), campaign: row ? parse<{ campaign: ClaimCampaign }>(row.value_json).campaign : null };
  });
}
export async function listClaimCampaigns(userId: string, admin = false, campaignId?: string, cursor?: string): Promise<ClaimCampaignList> {
  if (campaignId && !uuid(campaignId) || cursor && !uuid(cursor)) throw new CreditClaimError('活动或分页编号无效');
  return prisma.$transaction(async tx => {
    const user = await actor(tx, userId, admin);
    const rows = await tx.platformSetting.findMany({ where: campaignId ? { key: PREFIX + campaignId } : { key: { startsWith: PREFIX } },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 21,
      ...(cursor ? { cursor: { key: PREFIX + cursor }, skip: 1 } : {}) });
    const campaigns = rows.slice(0, 20).map(row => parse<ClaimCampaign>(row.value_json));
    const receipts = await tx.platformSetting.findMany({ where: { key: { in: campaigns.map(c => RECEIPT + c.id + ':' + userId) } } });
    const receiptMap = new Map(receipts.map(row => { const value = parse<CreditClaimReceipt>(row.value_json); return [value.campaignId, value]; }));
    const visible = campaigns.filter(c => admin || c.enabled && (c.audience === 'all' || c.audience === user.account_type) || receiptMap.has(c.id));
    return { actorId: userId, serverTime: new Date().toISOString(), nextCursor: rows.length > 20 ? campaigns[campaigns.length - 1].id : null,
      campaigns: await Promise.all(visible.map(async campaign => ({ ...campaign, receipt: receiptMap.get(campaign.id) || null,
        ...(admin ? { claimedCount: await tx.creditLedger.count({ where: { idempotency_key: { startsWith: RECEIPT + campaign.id + ':' } } }) } : {}) }))) };
  }, { timeout: 10000 });
}
export async function claimCampaignCredits(userId: string, value: unknown) {
  const input = value as { campaignId: string; expectedRevision: number };
  if (!input || !uuid(input.campaignId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new CreditClaimError('领取活动或版本无效');
  return retrySqliteBusy(() => prisma.$transaction(async tx => {
    const user = await actor(tx, userId);
    const key = RECEIPT + input.campaignId + ':' + userId;
    const existing = await tx.platformSetting.findUnique({ where: { key } });
    if (existing) return { receipt: parse<CreditClaimReceipt>(existing.value_json), alreadyClaimed: true };
    const stored = await tx.platformSetting.findUnique({ where: { key: PREFIX + input.campaignId } });
    if (!stored) throw new CreditClaimError('领取活动不存在', 404);
    const campaign = parse<ClaimCampaign>(stored.value_json);
    if (campaign.audience !== 'all' && campaign.audience !== user.account_type) throw new CreditClaimError('不在本次活动的领取范围内', 403);
    if (campaign.revision !== input.expectedRevision) throw new CreditClaimError('领取设置已变化，请刷新核对最新积分和时间', 409);
    const state = claimCampaignState(campaign, null, Date.now());
    if (state !== 'available') throw new CreditClaimError(state === 'paused' ? '活动已暂停' : state === 'upcoming' ? '尚未到领取时间' : '领取已结束', 409);
    const account = await tx.creditAccount.findUnique({ where: { user_id: userId } });
    if (!account) throw new CreditClaimError('积分账户未就绪，请联系管理员', 409);
    const amount = campaign.amount, balanceAfter = addCredits(account.balance, amount), ledgerId = randomUUID();
    const receipt: CreditClaimReceipt = { campaignId: campaign.id, campaignRevision: campaign.revision, campaignName: campaign.name,
      userId, amount, balanceAfter, ledgerId, claimedAt: new Date().toISOString() };
    // The unique receipt, account and ledger are one commit. A replay never issues a second grant.
    await tx.platformSetting.create({ data: { key, value_json: JSON.stringify(receipt), updated_by: userId } });
    const written = await tx.creditAccount.update({ where: { user_id: userId }, data: { balance: balanceAfter } });
    assertCreditWriteback(written, { balance: balanceAfter });
    await tx.creditLedger.create({ data: { id: ledgerId, user_id: userId, type: 'admin_grant', amount,
      balance_before: account.balance, balance_after: balanceAfter, frozen_before: account.frozen_credits, frozen_after: account.frozen_credits,
      idempotency_key: key, operator_id: campaign.updatedBy, reason: `活动领取：${campaign.name}`,
      metadata_json: JSON.stringify({ operation: 'campaign_claim', campaign, receipt, scope: 'long_term_balance' }) } });
    await tx.operationLog.create({ data: { operator_id: userId, action: 'credit_campaign_claim', target_type: 'CreditClaimCampaign', target_id: campaign.id,
      detail: JSON.stringify({ ledgerId, amount, campaignRevision: campaign.revision }) } });
    return { receipt, alreadyClaimed: false };
  }, { timeout: 10000 }));
}
