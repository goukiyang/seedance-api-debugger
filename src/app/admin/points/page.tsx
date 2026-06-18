import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import AdminPointsClient from './AdminPointsClient';

export const dynamic = 'force-dynamic';

function getTodayStart() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function firstParam(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

export default async function AdminPointsPage({
  searchParams,
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const user = await getSession();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/generate');

  const [accountSummary, accountCount, ledgerToday] = await Promise.all([
    prisma.creditAccount.aggregate({
      _sum: {
        balance: true,
        frozen_credits: true,
        monthly_used: true,
        total_used: true,
      },
    }),
    prisma.creditAccount.count(),
    prisma.creditLedger.count({
      where: { created_at: { gte: getTodayStart() } },
    }),
  ]);

  return (
    <AdminPointsClient
      stats={{
        user_count: accountCount,
        total_balance: accountSummary._sum.balance || 0,
        total_frozen: accountSummary._sum.frozen_credits || 0,
        monthly_used: accountSummary._sum.monthly_used || 0,
        total_used: accountSummary._sum.total_used || 0,
        ledger_today: ledgerToday,
      }}
      initialFilters={{
        user_id: firstParam(searchParams?.user_id),
        task_id: firstParam(searchParams?.task_id),
        type: firstParam(searchParams?.type),
        source: firstParam(searchParams?.source),
        q: firstParam(searchParams?.q),
        date_from: firstParam(searchParams?.date_from),
        date_to: firstParam(searchParams?.date_to),
      }}
    />
  );
}
