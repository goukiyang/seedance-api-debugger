import type { Prisma } from '@prisma/client';
import { creditCents } from '@/lib/credits/precision';
import { prisma } from '@/lib/prisma';
import { queueBillingAlert } from './alerts';

export async function inspectBillingInvariants(tx: Prisma.TransactionClient) {
  const issues: Array<{ kind: string; id: string }> = [];
  const [accounts, buckets, holds] = await Promise.all([
    tx.creditAccount.findMany(), tx.creditBucket.findMany({ where: { frozen_amount: { gt: 0 } } }), tx.creditHold.findMany(),
  ]);
  const personal = new Map<string, number>();
  for (const account of accounts) personal.set(account.user_id, creditCents(account.frozen_credits));
  for (const bucket of buckets) personal.set(bucket.user_id, (personal.get(bucket.user_id) || 0) + creditCents(bucket.frozen_amount));
  for (const hold of holds) if (hold.payer_type === 'user' && ['held', 'review'].includes(hold.state)) personal.set(hold.payer_id, (personal.get(hold.payer_id) || 0) - creditCents(hold.amount));
  for (const [userId, difference] of personal) if (difference !== 0) issues.push({ kind: 'personal_frozen_mismatch', id: userId });
  const projectAccounts = await tx.projectBudgetAccount.findMany();
  for (const account of projectAccounts) {
    const sum = holds.filter(hold => hold.payer_type === 'project' && hold.payer_id === account.project_id && ['held', 'review'].includes(hold.state)).reduce((total, hold) => total + creditCents(hold.amount), 0);
    if (sum !== creditCents(account.frozen_credits)) issues.push({ kind: 'project_frozen_mismatch', id: account.project_id });
  }
  for (const hold of holds) {
    const closed = ['captured', 'released', 'expired_closed'].includes(hold.state);
    if (closed && !hold.settlement_receipt) issues.push({ kind: 'hold_receipt_missing', id: hold.id });
    const keys = [`hold:${hold.id}:capture`, `hold:${hold.id}:release`];
    const receipts = hold.payer_type === 'project'
      ? await tx.projectBudgetLedger.findMany({ where: { idempotency_key: { in: keys } } })
      : await tx.creditLedger.findMany({ where: { idempotency_key: { in: keys } } });
    if (receipts.length !== (closed ? 1 : 0)) issues.push({ kind: 'settlement_receipt_mismatch', id: hold.id });
    const task = await tx.videoTask.findUnique({ where: { id: hold.business_id } });
    if (task && ['succeeded', 'failed', 'cancelled'].includes(task.local_status) && !closed) issues.push({ kind: 'terminal_hold_unsettled', id: hold.id });
    if (task && ['released', 'expired_closed'].includes(hold.state) && (task.provider_official_amount_micros || task.provider_official_amount_minor || 0) > 0) issues.push({ kind: 'refunded_but_provider_charged', id: hold.id });
  }
  return issues;
}
export async function runDailyBillingInspection(now = new Date()) {
  return prisma.$transaction(async tx => {
    const key = `audit_billing_inspection:${now.toISOString().slice(0, 10)}`;
    if (await tx.platformSetting.findUnique({ where: { key } })) return null;
    const issues = await inspectBillingInvariants(tx);
    const counts: Record<string, number> = {};
    for (const issue of issues) counts[issue.kind] = (counts[issue.kind] || 0) + 1;
    if (issues.length) await queueBillingAlert(tx, key, counts);
    await tx.platformSetting.create({ data: { key, value_json: JSON.stringify({ checked_at: now.toISOString(), counts }) } });
    return counts;
  });
}
