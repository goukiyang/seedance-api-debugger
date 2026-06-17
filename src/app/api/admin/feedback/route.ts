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

export async function GET(request: NextRequest) {
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
  const page = numberParam(searchParams.get('page'), 1, 10000);
  const pageSize = numberParam(searchParams.get('pageSize') || searchParams.get('page_size'), 20, 100);

  const where: Prisma.FeedbackWhereInput = {};
  const and: Prisma.FeedbackWhereInput[] = [];

  if (VALID_STATUS.has(status)) where.status = status;
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
      orderBy: { created_at: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.feedback.count({ where }),
  ]);

  return NextResponse.json({ items, total, page, pageSize });
}
