import { createHash } from 'node:crypto';
import type { ImageStudioTask, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { settleTaskCredits } from '@/lib/credits/policy';
import { getImageGenerationSettingsForModel } from '@/lib/integrations/image-generation';
import { billedCredits, parseImageBillingContract } from './billing-contract';
import { imageBillingScope } from './billing-scope';
import { matchImageSupplierCharge, readImageSupplierBills, type ImageSupplierCharge } from './billing-provider';
import { recordImageBillingProof } from './billing-readiness';

const eventKey = (scope: string, requestId: string) => `image-bill:${createHash('sha256').update(`${scope}\0${requestId}\0consume`).digest('hex')}`;
const terminal = ['succeeded', 'failed', 'uncertain'];
const MAX_ATTEMPTS = 48;
const billable = (task: ImageStudioTask) => task.billing_status === 'pending' && terminal.includes(task.status);

async function writeCreditSettlement(tx: Prisma.TransactionClient, task: ImageStudioTask, actualCost?: number) {
  const settlement = await settleTaskCredits(tx, { taskId: task.id, userId: task.owner_id,
    terminalStatus: actualCost === undefined ? 'failed' : 'succeeded', frozenAmount: task.unit_credits,
    freezeSnapshot: task.freeze_snapshot, actualCost: actualCost ?? 0 });
  await tx.creditLedger.create({ data: { user_id: task.owner_id,
    type: actualCost === undefined ? 'task_billing_release' : 'task_success_deduct',
    amount: actualCost === undefined ? settlement.refundedAmount : -settlement.actualCost,
    balance_before: settlement.balanceBefore, balance_after: settlement.balanceAfter,
    frozen_before: settlement.frozenBefore, frozen_after: settlement.frozenAfter, related_task_id: task.id,
    idempotency_key: `image-studio:actual-settle:${task.id}`,
    reason: actualCost === undefined ? '图片费用无法在授权范围内确认，释放原预留，不自动追扣' : '图片账单已核对，按原合同结算并释放多余预留',
    metadata_json: JSON.stringify({ allocations: settlement.allocations, unused_released: settlement.refundedAmount,
      expired_closed: settlement.expiredClosedAmount }) } });
  return settlement.actualCost;
}

export async function settleImageSupplierCharge(taskId: string, charge: ImageSupplierCharge, cashOnly = false) {
  return prisma.$transaction(async tx => {
    const task = await tx.imageStudioTask.findUnique({ where: { id: taskId } });
    if (!task || !(billable(task) || cashOnly && terminal.includes(task.status)
      && ['manual', 'conflict', 'deadline_expired', 'unmatched'].includes(task.billing_status))) return false;
    if (cashOnly && task.billing_mode === 'actual' && task.status === 'succeeded' && !task.billing_settled_at) throw new Error('Reservation must be released first');
    const contract = parseImageBillingContract(task.billing_contract_json);
    if (!contract || contract.scope !== task.billing_scope || charge.requestId !== task.gateway_request_id
      || charge.model !== task.model || charge.type !== 2 || !Number.isSafeInteger(charge.amountMicros)
      || charge.amountMicros < 0 || charge.amountMicros > 2_000_000_000) throw new Error('Billing identity invalid');
    if (await tx.imageStudioTask.count({ where: { billing_scope: contract.scope, gateway_request_id: charge.requestId } }) !== 1) {
      if (contract.mode === 'actual' && task.status === 'succeeded' && !task.billing_settled_at) {
        await writeCreditSettlement(tx, task);
        await tx.imageStudioTask.update({ where: { id: task.id }, data: { actual_credits: 0, billing_settled_at: new Date() } });
      }
      await tx.imageStudioTask.update({ where: { id: task.id }, data: { billing_status: 'conflict', billing_next_check_at: null } });
      return false;
    }
    const changed = await tx.imageStudioTask.updateMany({ where: { id: task.id, billing_status: task.billing_status,
      gateway_request_id: charge.requestId, billing_scope: contract.scope, status: task.status },
      data: { billing_status: 'reconciling' } });
    if (!changed.count) return false;
    const key = eventKey(contract.scope, charge.requestId);
    const existing = await tx.costLedger.findUnique({ where: { idempotency_key: key } });
    if (existing) {
      if (cashOnly) { await tx.imageStudioTask.update({ where: { id: task.id }, data: { billing_status: task.billing_status } }); return false; }
      if (contract.mode === 'actual' && task.status === 'succeeded' && !task.billing_settled_at) {
        await writeCreditSettlement(tx, task);
        await tx.imageStudioTask.update({ where: { id: task.id }, data: { actual_credits: 0, billing_settled_at: new Date() } });
      }
      await tx.imageStudioTask.update({ where: { id: task.id }, data: { billing_status: 'conflict', billing_next_check_at: null } });
      return false;
    }
    const delivered = task.status === 'succeeded';
    const actualCredits = billedCredits(charge.amountMicros, contract.pointsPerUsd);
    const overLimit = delivered && contract.mode === 'actual' && actualCredits > contract.authorizedCredits;
    const expired = contract.mode === 'actual' && (!task.billing_deadline || task.billing_deadline <= new Date());
    let chargedCredits = task.actual_credits;
    if (contract.mode === 'actual' && delivered && !cashOnly) {
      if (contract.authorizedCredits !== task.unit_credits || task.billing_settled_at) throw new Error('Original billing reservation unavailable');
      chargedCredits = await writeCreditSettlement(tx, task, overLimit || expired ? undefined : actualCredits);
    }
    const ledger = await tx.costLedger.create({ data: { source_type: 'official_bill', source_id: charge.requestId,
      image_task_id: task.id, user_id: task.owner_id, provider_name: 'musk', provider_account_id: contract.scope,
      provider_task_id: charge.requestId, event_type: 'official_charge', amount_micros: charge.amountMicros, currency: 'USD',
      cost_source: 'official_bill', confidence: 'confirmed', official_charge_id: key, idempotency_key: key,
      occurred_at: charge.occurredAt, pricing_snapshot: JSON.stringify({ contract, quota: charge.quota, quotaPerUsd: 500000,
        promptTokens: charge.promptTokens, completionTokens: charge.completionTokens, match: 'scope_gateway_request_model',
        deliveryStatus: task.status, platformLoss: cashOnly || !delivered || overLimit || expired }),
      reason: !delivered ? '未交付图片的供应商费用，用户不追扣' : '独立网关编号精确对应供应商消费' } });
    await tx.costAllocation.create({ data: { ledger_id: ledger.id, allocation_type: 'image_task', allocation_id: task.id,
      image_task_id: task.id, user_id: task.owner_id, amount_micros: charge.amountMicros, currency: 'USD' } });
    if (delivered) await recordImageBillingProof(tx, { scope: contract.scope, model: task.model, taskId: task.id, ledgerId: ledger.id });
    await tx.imageStudioTask.update({ where: { id: task.id }, data: { actual_amount_micros: charge.amountMicros,
      actual_credits: chargedCredits, billing_status: !delivered ? 'provider_loss' : cashOnly ? 'late_confirmed_no_charge' : overLimit ? 'over_limit' : expired ? 'deadline_expired' : 'confirmed',
      billing_settled_at: contract.mode === 'actual' && delivered && !cashOnly ? new Date() : task.billing_settled_at,
      billing_next_check_at: null } });
    return true;
  }, { timeout: 15000 });
}

async function exitImageBilling(task: ImageStudioTask, status: 'manual' | 'conflict' | 'deadline_expired' | 'unmatched') {
  await prisma.$transaction(async tx => {
    const changed = await tx.imageStudioTask.updateMany({ where: { id: task.id, billing_status: 'pending' },
      data: { billing_status: status, billing_next_check_at: null } });
    if (!changed.count) return;
    if (task.billing_mode === 'actual' && task.status === 'succeeded' && !task.billing_settled_at) {
      await writeCreditSettlement(tx, task);
      await tx.imageStudioTask.update({ where: { id: task.id }, data: { actual_credits: 0, billing_settled_at: new Date() } });
    }
  }, { timeout: 15000 });
}

let active = false;
let nextTick = 0;
export async function reconcileImageBilling() {
  if (active || Date.now() < nextTick) return;
  active = true; nextTick = Date.now() + 30_000;
  try {
    const tasks = await prisma.imageStudioTask.findMany({ where: { billing_status: 'pending',
      status: { in: terminal }, OR: [{ billing_next_check_at: null }, { billing_next_check_at: { lte: new Date() } }] },
      orderBy: { created_at: 'asc' }, take: 24 });
    const groups = new Map<string, { settings: Awaited<ReturnType<typeof getImageGenerationSettingsForModel>>; tasks: ImageStudioTask[] }>();
    for (const task of tasks) {
      const contract = parseImageBillingContract(task.billing_contract_json);
      if (!contract || !task.gateway_request_id || !task.billing_scope) { await exitImageBilling(task, 'unmatched'); continue; }
      if (task.billing_attempts >= MAX_ATTEMPTS || task.billing_deadline && task.billing_deadline <= new Date()) {
        await exitImageBilling(task, 'deadline_expired'); continue;
      }
      const settings = await getImageGenerationSettingsForModel(task.model);
      if (settings.provider !== 'musk' || !settings.api_key || imageBillingScope(settings) !== task.billing_scope) {
        await exitImageBilling(task, 'manual'); continue;
      }
      const group = groups.get(task.billing_scope) || { settings, tasks: [] };
      group.tasks.push(task); groups.set(task.billing_scope, group);
    }
    for (const [scope, group] of Array.from(groups.entries()).slice(0, 2)) {
      let rows: ImageSupplierCharge[] | null = null;
      try { rows = await readImageSupplierBills(group.settings, scope); } catch { /* Missing bills are not zero-dollar bills. */ }
      for (const task of group.tasks) {
        const match = rows ? matchImageSupplierCharge(rows, task.gateway_request_id!, task.model) : { state: 'missing' as const };
        if (match.state === 'conflict') await exitImageBilling(task, 'conflict');
        else if (match.state === 'matched') {
          try { await settleImageSupplierCharge(task.id, match.charge); }
          catch {
            // Corrupt reservation evidence must not be guessed or retried
            // forever. Preserve it and require an operator to repair it.
            await prisma.imageStudioTask.updateMany({ where: { id: task.id, billing_status: 'pending' },
              data: { billing_status: 'manual', billing_next_check_at: null } });
          }
        }
        else await prisma.imageStudioTask.updateMany({ where: { id: task.id, billing_status: 'pending' },
          data: { billing_attempts: { increment: 1 }, billing_next_check_at: new Date(Date.now() + Math.min(60 * 60_000, 30_000 * Math.pow(2, Math.min(task.billing_attempts, 7)))) } });
      }
    }
  } finally { active = false; }
}
