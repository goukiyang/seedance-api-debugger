import { Prisma, type ApiCustomer } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { budgetPeriod } from './contracts';
import type { ApiTx } from './auth';

type Client = ApiTx | typeof prisma;
export async function reservationUsage(client: Client, customerId: string, day: string, month: string) {
  const rows = await client.$queryRaw<Array<{ day_points: number; month_points: number; active: number | bigint; global_active: number | bigint }>>(Prisma.sql`
    SELECT COALESCE(SUM(CASE WHEN r.customer_id = ${customerId} AND r.day_key = ${day} THEN
      CASE WHEN s.kind = 'task_failed_refund' THEN 0 WHEN s.kind = 'task_success_deduct' THEN s.charge ELSE r.reserved_points END ELSE 0 END), 0) AS day_points,
      COALESCE(SUM(CASE WHEN r.customer_id = ${customerId} AND r.month_key = ${month} THEN
      CASE WHEN s.kind = 'task_failed_refund' THEN 0 WHEN s.kind = 'task_success_deduct' THEN s.charge ELSE r.reserved_points END ELSE 0 END), 0) AS month_points,
      COALESCE(SUM(CASE WHEN r.customer_id = ${customerId} AND s.kind IS NULL THEN 1 ELSE 0 END), 0) AS active,
      COALESCE(SUM(CASE WHEN s.kind IS NULL THEN 1 ELSE 0 END), 0) AS global_active
    FROM ApiRequest r LEFT JOIN
      (SELECT related_task_id, MAX(type) AS kind, MAX(ABS(amount)) AS charge FROM CreditLedger
       WHERE type IN ('task_success_deduct', 'task_failed_refund') GROUP BY related_task_id) s ON s.related_task_id = r.task_id`);
  return { day: Number(rows[0].day_points), month: Number(rows[0].month_points), active: Number(rows[0].active), globalActive: Number(rows[0].global_active) };
}

export async function storageUsage(client: Client, customerId?: string) {
  const filter = customerId ? Prisma.sql`WHERE customer_id = ${customerId}` : Prisma.empty;
  const requestFilter = customerId ? Prisma.sql`AND r.customer_id = ${customerId}` : Prisma.empty;
  const rows = await client.$queryRaw<Array<{ total: bigint | number }>>(Prisma.sql`
    SELECT COALESCE(SUM(bytes),0) AS total FROM (
      SELECT size_bytes AS bytes FROM ApiAsset ${filter}
      UNION ALL SELECT size_bytes AS bytes FROM ApiUpload WHERE asset_id IS NULL ${customerId ? Prisma.sql`AND customer_id = ${customerId}` : Prisma.empty}
      UNION ALL SELECT COALESCE(r.output_bytes, r.output_reserved_bytes) AS bytes FROM ApiRequest r
      WHERE (r.output_bytes IS NOT NULL OR NOT EXISTS (SELECT 1 FROM CreditLedger l WHERE l.related_task_id = r.task_id AND l.type = 'task_failed_refund')) ${requestFilter}
    )`);
  return BigInt(rows[0].total);
}

export async function publicUsage(context: { customer: ApiCustomer; user: { id: string } }, cursor?: string) {
  const period = budgetPeriod(context.customer.timezone);
  const usage = await reservationUsage(prisma, context.customer.id, period.day, period.month);
  const account = await prisma.creditAccount.findUnique({ where: { user_id: context.user.id } });
  const records = await prisma.apiRequest.findMany({ where: { customer_id: context.customer.id, ...(cursor ? { id: { lt: cursor } } : {}) }, orderBy: { id: 'desc' }, take: 51 });
  const settlements = await prisma.creditLedger.findMany({ where: { related_task_id: { in: records.map(r => r.task_id) }, type: { in: ['task_success_deduct', 'task_failed_refund'] } }, select: { related_task_id: true, type: true, amount: true } });
  return { balance_points: account?.balance ?? 0, frozen_points: account?.frozen_credits ?? 0,
    available_points: Math.max(0, (account?.balance ?? 0) - (account?.frozen_credits ?? 0)), timezone: context.customer.timezone,
    day: period.day, month: period.month, day_used_points: usage.day, month_used_points: usage.month,
    day_remaining_points: context.customer.daily_points == null ? null : Math.max(0, context.customer.daily_points - usage.day),
    month_remaining_points: context.customer.monthly_points == null ? null : Math.max(0, context.customer.monthly_points - usage.month),
    active_requests: usage.active, storage_bytes: String(await storageUsage(prisma, context.customer.id)),
    records: records.slice(0, 50).map(r => { const s = settlements.find(l => l.related_task_id === r.task_id); return {
      id: r.id, request_id: r.request_id, reserved_points: r.reserved_points, charged_points: s?.type === 'task_success_deduct' ? Math.abs(s.amount) : 0,
      fee_status: s ? s.type === 'task_success_deduct' ? 'charged' : 'refunded' : 'reserved', created_at: r.created_at.toISOString() }; }),
    next_cursor: records.length > 50 ? records[49].id : null };
}
