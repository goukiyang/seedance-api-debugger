import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { errorJson, getAdminUser } from '@/lib/auth/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function numberParam(value: string | null, fallback: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function safeParseDetail(value: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  try {
    await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  const { searchParams } = new URL(request.url);
  const take = numberParam(searchParams.get('limit') || searchParams.get('pageSize'), 50, 200);
  const stage = (searchParams.get('stage') || '').trim();
  const status = (searchParams.get('status') || '').trim();
  const actionPrefix = stage ? `asset_upload_${stage}_` : 'asset_upload_';

  const logs = await prisma.operationLog.findMany({
    where: {
      action: {
        startsWith: 'asset_upload_',
        ...(stage ? { startsWith: actionPrefix } : {}),
        ...(status ? { endsWith: `_${status}` } : {}),
      },
    },
    include: {
      operator: {
        select: {
          id: true,
          name: true,
          username: true,
          email: true,
          avatar_url: true,
          account_type: true,
        },
      },
    },
    orderBy: { created_at: 'desc' },
    take,
  });

  return NextResponse.json({
    items: logs.map((log) => ({
      id: log.id,
      action: log.action,
      targetType: log.target_type,
      targetId: log.target_id,
      detail: safeParseDetail(log.detail),
      createdAt: log.created_at,
      operator: log.operator,
    })),
  });
}
