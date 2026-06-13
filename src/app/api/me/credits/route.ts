import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUser, errorJson } from '@/lib/auth/api-helpers';
import { getCreditSummary } from '@/lib/credits/policy';

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

  const summary = await prisma.$transaction((tx) => getCreditSummary(tx, dbUser));
  const { account } = summary;

  return NextResponse.json({
    balance: account.balance,
    frozen_credits: summary.frozen_credits,
    available: summary.available,
    monthly_used: account.monthly_used,
    total_used: account.total_used,
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
