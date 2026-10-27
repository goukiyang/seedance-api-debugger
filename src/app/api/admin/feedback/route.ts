import { route as apiRoute } from '@/lib/http/route';
import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { errorJson, getAdminUser } from '@/lib/auth/api-helpers';

const VALID_STATUS = new Set(['new', 'reviewed', 'archived']);

function numberParam(value: string | null, fallback: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

export const GET = apiRoute({ access: 'admin', rateLimit: false }, async function GET(request: NextRequest) {
  try {
    await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status') || '';
  const hasImage = searchParams.get('hasImage') || '';
  const keyword = (searchParams.get('keyword') || '').trim();
  const pagePath = (searchParams.get('pagePath') || searchParams.get('pathname') || '').trim();
  const ownerUserId = (searchParams.get('owner_user_id') || '').trim();
  const taskId = (searchParams.get('task_id') || '').trim();
  const from = searchParams.get('date_from'), to = searchParams.get('date_to');
  const dateFrom = from ? new Date(from) : null, dateTo = to ? new Date(to) : null;
  if (status && !VALID_STATUS.has(status) || hasImage && !['true', 'false'].includes(hasImage)
    || [ownerUserId, taskId].some(value => value.length > 120) || keyword.length > 200 || pagePath.length > 200
    || dateFrom && !Number.isFinite(dateFrom.getTime()) || dateTo && !Number.isFinite(dateTo.getTime())) return errorJson('反馈筛选条件无效', 400);
  if (dateTo && to && /^\d{4}-\d{2}-\d{2}$/.test(to)) dateTo.setUTCHours(23, 59, 59, 999);
  if (dateFrom && dateTo && dateFrom > dateTo) return errorJson('日期范围无效', 400);
  const page = numberParam(searchParams.get('page'), 1, 10000);
  if (searchParams.has('page') && (!/^\d+$/.test(searchParams.get('page') || '') || Number(searchParams.get('page')) < 1 || Number(searchParams.get('page')) > 10000)
    || searchParams.has('page_size') && !['20', '30', '50', '100'].includes(searchParams.get('page_size') || '')) return errorJson('反馈分页条件无效', 400);
  const pageSize = numberParam(searchParams.get('page_size') || searchParams.get('pageSize'), 30, 100);

  const where: Prisma.FeedbackWhereInput = {};
  const and: Prisma.FeedbackWhereInput[] = [];

  if (VALID_STATUS.has(status)) where.status = status;
  if (ownerUserId) where.user_id = ownerUserId;
  if (taskId) where.task_id = taskId;
  if (dateFrom || dateTo) where.created_at = { ...(dateFrom ? { gte: dateFrom } : {}), ...(dateTo ? { lte: dateTo } : {}) };
  if (hasImage === 'true') and.push({ image_urls_json: { not: null } });
  if (hasImage === 'false') and.push({ image_urls_json: null });
  if (pagePath) {
    and.push({
      OR: [
        { pathname: { contains: pagePath } },
        { page_url: { contains: pagePath } },
      ],
    });
  }
  if (keyword) {
    and.push({
      OR: [
        { content: { contains: keyword } },
        { admin_note: { contains: keyword } },
        { task_id: { contains: keyword } },
        { user: { name: { contains: keyword } } },
        { user: { username: { contains: keyword } } },
        { user: { email: { contains: keyword } } },
      ],
    });
  }
  if (and.length) where.AND = and;

  const [items, total] = await Promise.all([
    prisma.feedback.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.feedback.count({ where }),
  ]);

  return NextResponse.json({ items, total, page, pageSize }, { headers: { 'Cache-Control': 'private, no-store' } });
});
