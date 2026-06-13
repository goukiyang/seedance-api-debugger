import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUser, errorJson } from '@/lib/auth/api-helpers';

export async function GET(request: NextRequest) {
  let user: { id: string } | null = null;
  try {
    user = await getSessionUser(request);
  } catch {
    return errorJson('未登录', 401);
  }

  const account = await prisma.creditAccount.findUnique({
    where: { user_id: user.id },
  });

  if (!account) {
    return NextResponse.json({
      balance: 0,
      frozen_credits: 0,
      available: 0,
      monthly_used: 0,
      total_used: 0,
    });
  }

  return NextResponse.json({
    balance: account.balance,
    frozen_credits: account.frozen_credits,
    available: account.balance - account.frozen_credits,
    monthly_used: account.monthly_used,
    total_used: account.total_used,
  });
}