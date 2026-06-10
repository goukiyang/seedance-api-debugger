import { NextRequest, NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getAdminUser, errorJson } from '@/lib/auth/api-helpers';

function parseDateParam(value: string | null, endOfDay = false) {
  if (!value) return null;
  const normalized = endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T23:59:59.999`
    : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function GET(request: NextRequest) {
  try {
    await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  const url = new URL(request.url);
  const userId = url.searchParams.get('user_id');
  const type = url.searchParams.get('type');
  const taskId = url.searchParams.get('task_id');
  const keyword = url.searchParams.get('q')?.trim();
  const dateFrom = url.searchParams.get('date_from');
  const dateTo = url.searchParams.get('date_to');
  const fromDate = parseDateParam(dateFrom);
  const toDate = parseDateParam(dateTo, true);
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const requestedPageSize = parseInt(url.searchParams.get('page_size') || '50', 10) || 50;
  const pageSize = Math.min(100, Math.max(10, requestedPageSize));
  const skip = (page - 1) * pageSize;

  const where: Prisma.CreditLedgerWhereInput = {};
  if (userId) where.user_id = userId;
  if (type) where.type = type;
  if (taskId) where.related_task_id = { contains: taskId };
  if (fromDate || toDate) {
    where.created_at = {
      ...(fromDate ? { gte: fromDate } : {}),
      ...(toDate ? { lte: toDate } : {}),
    };
  }
  if (keyword) {
    where.OR = [
      { id: { contains: keyword } },
      { type: { contains: keyword } },
      { reason: { contains: keyword } },
      { related_task_id: { contains: keyword } },
      { user: { name: { contains: keyword } } },
      { user: { username: { contains: keyword } } },
    ];
  }

  const [records, total] = await Promise.all([
    prisma.creditLedger.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, username: true, email: true, account_type: true } },
      },
      orderBy: { created_at: 'desc' },
      skip,
      take: pageSize,
    }),
    prisma.creditLedger.count({ where }),
  ]);

  return NextResponse.json({ records, total, page, page_size: pageSize });
}
