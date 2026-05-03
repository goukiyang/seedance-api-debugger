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

  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  const pageSize = parseInt(url.searchParams.get('page_size') || '20', 10);
  const skip = (page - 1) * pageSize;

  const [records, total] = await Promise.all([
    prisma.creditLedger.findMany({
      where: { user_id: user.id },
      orderBy: { created_at: 'desc' },
      skip,
      take: pageSize,
    }),
    prisma.creditLedger.count({ where: { user_id: user.id } }),
  ]);

  return NextResponse.json({ records, total, page, page_size: pageSize });
}