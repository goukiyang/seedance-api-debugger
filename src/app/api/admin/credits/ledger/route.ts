import { NextRequest, NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getAdminUser, errorJson } from '@/lib/auth/api-helpers';

export async function GET(request: NextRequest) {
  try {
    const admin = await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  const url = new URL(request.url);
  const userId = url.searchParams.get('user_id');
  const type = url.searchParams.get('type');
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  const pageSize = parseInt(url.searchParams.get('page_size') || '50', 10);
  const skip = (page - 1) * pageSize;

  const where: Prisma.CreditLedgerWhereInput = {};
  if (userId) where.user_id = userId;
  if (type) where.type = type;

  const [records, total] = await Promise.all([
    prisma.creditLedger.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, username: true } },
      },
      orderBy: { created_at: 'desc' },
      skip,
      take: pageSize,
    }),
    prisma.creditLedger.count({ where }),
  ]);

  return NextResponse.json({ records, total, page, page_size: pageSize });
}
