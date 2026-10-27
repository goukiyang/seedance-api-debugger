import type { Prisma } from '@prisma/client';
import { allocateCreditSources, settleCreditSources, type CreditPolicyUser } from './credit-sources';
import { allocateProjectSources, settleProjectSources } from './project-sources';
import { creditCents } from '@/lib/credits/precision';
import { settleLegacyCredits, settleLegacyProject, readLegacySettlement } from './legacy-inflight';

type Tx = Prisma.TransactionClient;
type PersonalReceipt = Awaited<ReturnType<typeof settleCreditSources>>;
export class HoldReviewRequired extends Error {
  constructor(public businessId: string) { super('AUD_BILLING_LEGACY_REVIEW_REQUIRED'); }
}
const identity = (businessId: string, businessType = 'task') => ({ business_type_business_id: { business_type: businessType, business_id: businessId } });

export async function openHold(tx: Tx, input: {
  businessId: string; businessType?: string; amount: number;
  payer: { type: 'user'; user: CreditPolicyUser } | { type: 'project'; projectId: string; operatorId: string };
}) {
  const payerId = input.payer.type === 'user' ? input.payer.user.id : input.payer.projectId;
  const existing = await tx.creditHold.findUnique({ where: identity(input.businessId, input.businessType) });
  if (existing) {
    if (existing.payer_type !== input.payer.type || existing.payer_id !== payerId || creditCents(existing.amount) !== creditCents(input.amount)) throw new Error('AUD_BILLING_HOLD_IDENTITY_CONFLICT');
    return existing;
  }
  const legacy = input.payer.type === 'user'
    ? await tx.creditLedger.findFirst({ where: { related_task_id: input.businessId, type: { in: ['task_freeze', 'task_success_deduct', 'task_failed_refund', 'task_billing_release'] } } })
    : await tx.projectBudgetLedger.findFirst({ where: { related_task_id: input.businessId, type: { in: ['task_freeze', 'task_success_deduct', 'task_failed_refund'] } } });
  if (legacy) throw new HoldReviewRequired(input.businessId);
  let hold = await tx.creditHold.create({ data: {
    business_type: input.businessType || 'task', business_id: input.businessId, payer_type: input.payer.type,
    payer_id: payerId, operator_id: input.payer.type === 'user' ? payerId : input.payer.operatorId,
    amount: input.amount, freeze_snapshot: '[]', opening_receipt: '{}',
  } });
  const receipt = input.payer.type === 'user'
    ? await allocateCreditSources(tx, input.payer.user, input.amount, input.businessId)
    : await allocateProjectSources(tx, { projectId: payerId, taskId: input.businessId, amount: input.amount, operatorId: input.payer.operatorId, idempotencyKey: `hold:${hold.id}:open` });
  hold = await tx.creditHold.update({ where: { id: hold.id }, data: { freeze_snapshot: receipt.snapshot, opening_receipt: JSON.stringify(receipt) } });
  if (input.payer.type === 'user') {
    const personal = receipt as Awaited<ReturnType<typeof allocateCreditSources>>;
    await tx.creditLedger.create({ data: { user_id: payerId, type: 'task_freeze', amount: -input.amount,
      balance_before: personal.balance_before, balance_after: personal.balance_after,
      frozen_before: personal.frozen_before, frozen_after: personal.frozen_after, related_task_id: input.businessId,
      idempotency_key: `hold:${hold.id}:open`, metadata_json: JSON.stringify({ allocations: personal.allocations }) } });
  }
  return hold;
}

async function settleHold(tx: Tx, holdId: string, capture: boolean, actualCost?: number) {
  let hold = await tx.creditHold.findUniqueOrThrow({ where: { id: holdId } });
  // Compatibility for the earlier candidate's age-only review flag. Age is not
  // evidence of a billing conflict and must not prevent an authoritative result.
  if (hold.state === 'review' && hold.review_reason === 'held_over_24_hours') {
    await tx.creditHold.updateMany({ where: { id: hold.id, state: 'review', review_reason: 'held_over_24_hours', version: hold.version },
      data: { state: 'held', review_reason: null, version: { increment: 1 } } });
    hold = await tx.creditHold.findUniqueOrThrow({ where: { id: holdId } });
  }
  if (['captured', 'released', 'expired_closed'].includes(hold.state)) {
    if (!hold.settlement_receipt) throw new HoldReviewRequired(hold.business_id);
    return hold;
  }
  if (hold.state !== 'held') throw new HoldReviewRequired(hold.business_id);
  if (actualCost !== undefined && (creditCents(actualCost) < 0 || creditCents(actualCost) > creditCents(hold.amount))) throw new Error('AUD_BILLING_CAPTURE_OUTSIDE_HOLD');
  const key = `hold:${hold.id}:${capture ? 'capture' : 'release'}`;
  const claimed = await tx.creditHold.updateMany({ where: { id: hold.id, state: 'held', version: hold.version },
    data: { state: capture ? 'captured' : 'released', version: { increment: 1 }, settled_at: new Date() } });
  if (!claimed.count) return tx.creditHold.findUniqueOrThrow({ where: { id: hold.id } });
  let result;
  if (hold.payer_type === 'project') {
    result = await settleProjectSources(tx, { projectId: hold.payer_id, taskId: hold.business_id,
      terminalStatus: capture ? 'succeeded' : 'failed', frozenAmount: hold.amount, freezeSnapshot: hold.freeze_snapshot,
      operatorId: hold.operator_id, idempotencyKey: key });
  } else {
    result = await settleCreditSources(tx, { userId: hold.payer_id, taskId: hold.business_id,
      terminalStatus: capture ? 'succeeded' : 'failed', frozenAmount: hold.amount, freezeSnapshot: hold.freeze_snapshot, actualCost });
    await tx.creditLedger.create({ data: { user_id: hold.payer_id, type: capture ? 'task_success_deduct' : 'task_failed_refund',
      amount: capture ? -result.actualCost : result.refundedAmount, balance_before: result.balanceBefore, balance_after: result.balanceAfter,
      frozen_before: result.frozenBefore, frozen_after: result.frozenAfter, related_task_id: hold.business_id,
      idempotency_key: key, metadata_json: JSON.stringify({ allocations: result.allocations, expired_closed: result.expiredClosedAmount }) } });
  }
  const expired = 'expiredClosedAmount' in result ? result.expiredClosedAmount : 0;
  hold = await tx.creditHold.update({ where: { id: hold.id }, data: {
    actual_cost: result.actualCost, refunded_amount: result.refundedAmount, expired_closed_amount: expired,
    state: !capture && expired > 0 && result.refundedAmount === 0 ? 'expired_closed' : capture ? 'captured' : 'released',
    settlement_receipt: JSON.stringify(result),
  } });
  return hold;
}
export const captureHold = (tx: Tx, id: string, actualCost?: number) => settleHold(tx, id, true, actualCost);
export const releaseHold = (tx: Tx, id: string) => settleHold(tx, id, false);
export async function markHoldForReview(tx: Tx, id: string, reason: string) {
  const hold = await tx.creditHold.findUniqueOrThrow({ where: { id } });
  await tx.creditHold.updateMany({ where: { id, state: 'held', version: hold.version }, data: { state: 'review', version: { increment: 1 }, review_reason: reason } });
  return tx.creditHold.findUniqueOrThrow({ where: { id } });
}
export async function findTaskHold(tx: Tx, taskId: string) {
  const holds = await tx.creditHold.findMany({ where: { business_id: taskId }, take: 2 });
  if (holds.length > 1) throw new Error('AUD_BILLING_AMBIGUOUS_BUSINESS_ID');
  return holds[0] || null;
}

// Compatibility signatures retain callers and frozen snapshots; never adopt old money.
export async function allocateTaskCredits(tx: Tx, user: CreditPolicyUser, amount: number, taskId: string, businessType = taskId.startsWith('role-attempt:') ? 'role_attempt' : 'video') {
  const hold = await openHold(tx, { businessId: taskId, businessType, amount, payer: { type: 'user', user } });
  return JSON.parse(hold.opening_receipt) as Awaited<ReturnType<typeof allocateCreditSources>>;
}
export async function increaseTaskHold(tx: Tx, user: CreditPolicyUser, amount: number, taskId: string, authorizationKey: string) {
  const hold = await findTaskHold(tx, taskId);
  if (!hold || hold.state !== 'held' || hold.payer_type !== 'user' || hold.payer_id !== user.id) throw new HoldReviewRequired(taskId);
  const key = `hold:${hold.id}:increase:${authorizationKey}`;
  const previous = await tx.creditLedger.findUnique({ where: { idempotency_key: key } });
  if (previous?.metadata_json) return JSON.parse(previous.metadata_json) as Awaited<ReturnType<typeof allocateCreditSources>>;
  const freeze = await allocateCreditSources(tx, user, amount, taskId);
  const changed = await tx.creditHold.updateMany({ where: { id: hold.id, state: 'held', version: hold.version }, data: {
    amount: (creditCents(hold.amount) + creditCents(amount)) / 100,
    freeze_snapshot: JSON.stringify([...JSON.parse(hold.freeze_snapshot), ...freeze.allocations]), version: { increment: 1 },
  } });
  if (!changed.count) throw new Error('AUD_BILLING_HOLD_CONFLICT');
  await tx.creditLedger.create({ data: { user_id: user.id, type: 'task_freeze', amount: -amount,
    balance_before: freeze.balance_before, balance_after: freeze.balance_after, frozen_before: freeze.frozen_before,
    frozen_after: freeze.frozen_after, related_task_id: taskId, idempotency_key: key, metadata_json: JSON.stringify(freeze) } });
  return freeze;
}
export async function allocateProjectTaskBudget(tx: Tx, input: Parameters<typeof allocateProjectSources>[1]) {
  const hold = await openHold(tx, { businessId: input.taskId, businessType: 'video', amount: input.amount, payer: { type: 'project', projectId: input.projectId, operatorId: input.operatorId } });
  return JSON.parse(hold.opening_receipt) as Awaited<ReturnType<typeof allocateProjectSources>>;
}
export async function settleTaskCredits(tx: Tx, input: Parameters<typeof settleCreditSources>[1]) {
  const hold = await findTaskHold(tx, input.taskId);
  if (!hold) return settleLegacyCredits(tx, input);
  if (hold.payer_type !== 'user' || hold.payer_id !== input.userId) throw new Error('AUD_BILLING_PAYER_MISMATCH');
  const settled = input.terminalStatus === 'succeeded' ? await captureHold(tx, hold.id, input.actualCost) : await releaseHold(tx, hold.id);
  if (!settled.settlement_receipt) throw new HoldReviewRequired(input.taskId);
  return JSON.parse(settled.settlement_receipt) as PersonalReceipt;
}
export async function settleProjectTaskBudget(tx: Tx, input: Parameters<typeof settleProjectSources>[1]) {
  const hold = await findTaskHold(tx, input.taskId);
  if (!hold) return settleLegacyProject(tx, input);
  if (hold.payer_type !== 'project' || hold.payer_id !== input.projectId) throw new Error('AUD_BILLING_PAYER_MISMATCH');
  const settled = input.terminalStatus === 'succeeded' ? await captureHold(tx, hold.id) : await releaseHold(tx, hold.id);
  if (!settled.settlement_receipt) throw new HoldReviewRequired(input.taskId);
  return JSON.parse(settled.settlement_receipt) as Awaited<ReturnType<typeof settleProjectSources>>;
}

// Callers may retain audit text, but cannot create a second financial receipt.
export async function writeHoldLedger(tx: Tx, input: Prisma.CreditLedgerCreateArgs) {
  const taskId = input.data.related_task_id;
  if (!taskId) throw new Error('AUD_BILLING_LEDGER_MISSING_BUSINESS');
  const hold = await findTaskHold(tx, taskId);
  if (!hold) {
    const receipt = await readLegacySettlement(tx, taskId);
    if (!receipt || receipt.user_id !== input.data.user_id) throw new HoldReviewRequired(taskId);
    return receipt;
  }
  const suffix = input.data.type === 'task_freeze' ? 'open' : hold.state === 'captured' ? 'capture' : 'release';
  const receipt = await tx.creditLedger.findUnique({ where: { idempotency_key: `hold:${hold.id}:${suffix}` } });
  if (!receipt) throw new Error('AUD_BILLING_RECEIPT_MISSING');
  return receipt;
}
