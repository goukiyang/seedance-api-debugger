import type { Prisma } from '@prisma/client';
import { isDeepStrictEqual } from 'node:util';
import { creditCents, sumCredits } from '@/lib/credits/precision';
import { publicPricingTaskState, publicPricingBillingState } from '@/lib/image-studio/pricing-state';
import { settleCreditSources } from './credit-sources';
import { settleProjectSources } from './project-sources';

type Tx = Prisma.TransactionClient;
type Reservation = { businessId: string; payerType: 'user' | 'project'; payerId: string; amount: number; snapshot: string; freezeId: string };
const permissions = new WeakMap<object, Map<string, Reservation>>();
const key = (id: string) => `legacy-inflight:${id}:settle`;
const blocked = () => new Error('AUD_BILLING_LEGACY_REVIEW_REQUIRED');
const settlementTypes = ['task_success_deduct', 'task_failed_refund', 'task_billing_release'];

// A transaction-local permit is obtained from a fresh, still-active business
// record before its existing completion CAS. No old business/ledger is edited,
// no CreditHold is imported, and terminal historical rows cannot obtain one.
export async function authorizeLegacyInflight(tx: Tx, kind: 'video' | 'image' | 'image_billing' | 'role', id: string) {
  const businessId = kind === 'role' ? `role-attempt:${id}` : id;
  if (await tx.creditHold.count({ where: { business_id: businessId } })) return;
  let amount: number, snapshot: string | null, payerId: string | null, payerType: 'user' | 'project' = 'user';
  if (kind === 'video') {
    const task = await tx.videoTask.findUnique({ where: { id } });
    if (!task || !['submitted', 'running', 'submitting', 'unknown'].includes(task.local_status)) return;
    amount = task.frozen_cost || 0; snapshot = task.credit_freeze_snapshot;
    payerType = task.billing_scope === 'project' ? 'project' : 'user';
    payerId = payerType === 'project' ? task.project_id : task.user_id;
  } else if (kind === 'role') {
    const attempt = await tx.canvasRoleAttempt.findUnique({ where: { id } });
    if (!attempt || attempt.settlement_applied || !['pending', 'unknown', 'authorization_required'].includes(attempt.fee_state)) return;
    const work = await tx.canvasRoleWork.findUnique({ where: { id: attempt.work_id } });
    const run = work && await tx.canvasRoleTaskRun.findUnique({ where: { id: work.role_task_run_id } });
    payerId = run?.owner_user_id || null; amount = attempt.reserved_points / 100;
    try { snapshot = JSON.parse(attempt.quote_json).freezeSnapshot; } catch { throw blocked(); }
  } else {
    const task = await tx.imageStudioTask.findUnique({ where: { id } });
    if (!task || task.billing_settled_at) return;
    if (kind === 'image' && !['queued', 'running', 'channel_queued', 'channel_running', 'uncertain'].includes(publicPricingTaskState(task.status))) return;
    if (kind === 'image_billing' && (task.billing_mode !== 'actual' || !['pending', 'channel_pending'].includes(publicPricingBillingState(task.billing_status)))) return;
    amount = task.unit_credits; snapshot = task.freeze_snapshot; payerId = task.owner_id;
  }
  if (amount <= 0) return;
  if (!payerId) throw blocked();
  const freezes = payerType === 'project'
    ? await tx.projectBudgetLedger.findMany({ where: { related_task_id: businessId, type: 'task_freeze' } })
    : await tx.creditLedger.findMany({ where: { related_task_id: businessId, type: 'task_freeze' } });
  if (freezes.length !== 1 || freezes[0].idempotency_key?.startsWith('hold:')) throw blocked();
  const freeze = freezes[0];
  const settled = payerType === 'project'
    ? await tx.projectBudgetLedger.count({ where: { related_task_id: businessId, type: { in: settlementTypes } } })
    : await tx.creditLedger.count({ where: { related_task_id: businessId, type: { in: settlementTypes } } });
  if (settled) return;
  if (payerType === 'project') {
    const projectFreeze = freeze as Prisma.ProjectBudgetLedgerGetPayload<{}>;
    if (projectFreeze.project_id !== payerId || creditCents(-freeze.amount) !== creditCents(amount) || !snapshot) throw blocked();
    const source = JSON.parse(snapshot);
    if (source.account_id !== projectFreeze.account_id || source.project_id !== payerId || creditCents(source.amount) !== creditCents(amount)) throw blocked();
  } else {
    const personalFreeze = freeze as Prisma.CreditLedgerGetPayload<{}>;
    if (personalFreeze.user_id !== payerId) throw blocked();
    let allocations;
    try { allocations = JSON.parse(freeze.metadata_json || '').allocations; } catch { throw blocked(); }
    if (!Array.isArray(allocations) || !allocations.length || creditCents(sumCredits(allocations.map(item => item.amount))) !== creditCents(amount)) throw blocked();
    if (snapshot && !isDeepStrictEqual(JSON.parse(snapshot), allocations)) throw blocked();
    snapshot = JSON.stringify(allocations);
  }
  const permits = permissions.get(tx) || new Map<string, Reservation>();
  permits.set(businessId, { businessId, payerType, payerId, amount, snapshot: snapshot!, freezeId: freeze.id });
  permissions.set(tx, permits);
  return true;
}

export async function readLegacySettlement(tx: Tx, taskId: string) {
  return tx.creditLedger.findUnique({ where: { idempotency_key: key(taskId) } });
}
export async function settleLegacyCredits(tx: Tx, input: Parameters<typeof settleCreditSources>[1]) {
  const previous = await readLegacySettlement(tx, input.taskId);
  if (previous) {
    if (previous.user_id !== input.userId) throw blocked();
    return JSON.parse(previous.metadata_json!).settlement as Awaited<ReturnType<typeof settleCreditSources>>;
  }
  const permit = permissions.get(tx)?.get(input.taskId);
  if (!permit || permit.payerType !== 'user' || permit.payerId !== input.userId || creditCents(permit.amount) !== creditCents(input.frozenAmount)) throw blocked();
  const result = await settleCreditSources(tx, { ...input, freezeSnapshot: permit.snapshot });
  await tx.creditLedger.create({ data: { user_id: permit.payerId, type: input.terminalStatus === 'succeeded' ? 'task_success_deduct' : 'task_failed_refund',
    amount: input.terminalStatus === 'succeeded' ? -result.actualCost : result.refundedAmount,
    balance_before: result.balanceBefore, balance_after: result.balanceAfter, frozen_before: result.frozenBefore, frozen_after: result.frozenAfter,
    related_task_id: input.taskId, idempotency_key: key(input.taskId), reason: '升级前在途任务沿原预留正常结算',
    metadata_json: JSON.stringify({ legacy_freeze_ledger_id: permit.freezeId, settlement: result }) } });
  permissions.get(tx)?.delete(input.taskId);
  return result;
}
export async function settleLegacyProject(tx: Tx, input: Parameters<typeof settleProjectSources>[1]) {
  const previous = await tx.projectBudgetLedger.findUnique({ where: { idempotency_key: key(input.taskId) } });
  if (previous) {
    if (previous.project_id !== input.projectId) throw blocked();
    return { actualCost: previous.type === 'task_success_deduct' ? -previous.amount : 0, refundedAmount: previous.type === 'task_failed_refund' ? previous.amount : 0,
      budgetBefore: previous.budget_before, budgetAfter: previous.budget_after, usedBefore: previous.used_before, usedAfter: previous.used_after,
      frozenBefore: previous.frozen_before, frozenAfter: previous.frozen_after, snapshot: null };
  }
  const permit = permissions.get(tx)?.get(input.taskId);
  if (!permit || permit.payerType !== 'project' || permit.payerId !== input.projectId || creditCents(permit.amount) !== creditCents(input.frozenAmount)) throw blocked();
  const result = await settleProjectSources(tx, { ...input, freezeSnapshot: permit.snapshot, idempotencyKey: key(input.taskId), legacyFreezeLedgerId: permit.freezeId });
  permissions.get(tx)?.delete(input.taskId);
  return result;
}
