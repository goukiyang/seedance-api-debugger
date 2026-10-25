import { NextRequest, NextResponse } from 'next/server';
import { prisma, retrySqliteBusy } from '@/lib/prisma';
import { getSessionUser, errorJson } from '@/lib/auth/api-helpers';
import { getCreditSummary } from '@/lib/credits/policy';

// Concurrent polls from one account share a single summary transaction (no caching beyond the in-flight request).
const inflight = new Map<string, Promise<Awaited<ReturnType<typeof getCreditSummary>>>>();

export async function GET(request: NextRequest) {
  let user: { id: string } | null = null;
  try {
    user = await getSessionUser(request);
  } catch {
    return errorJson('未登录', 401);
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: { id: true, role: true, account_type: true, user_profile: true, status: true },
  });
  if (!dbUser) return errorJson('用户不存在', 404);

  let pending = inflight.get(dbUser.id);
  if (!pending) {
    pending = retrySqliteBusy(() => prisma.$transaction((tx) => getCreditSummary(tx, dbUser)));
    inflight.set(dbUser.id, pending);
    const settled = pending;
    settled.finally(() => { if (inflight.get(dbUser.id) === settled) inflight.delete(dbUser.id); }).catch(() => {});
  }
  const summary = await pending;
  const { account } = summary;

  return NextResponse.json({
    balance: account.balance,
    frozen_credits: summary.frozen_credits,
    available: summary.available,
    monthly_used: account.monthly_used,
    total_used: account.total_used,
    quota_buckets: summary.buckets,
    periodic: summary.periodic,
    daily_quota: {
      total: summary.daily_total,
      remaining: summary.daily_remaining,
      frozen: summary.daily_frozen,
      expires_at: summary.daily_expires_at,
    },
    long_term: {
      available: summary.long_available,
      balance: account.balance,
      frozen: account.frozen_credits,
    },
  });
}
