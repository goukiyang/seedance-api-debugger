import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function boundedLimit(value: string | null) {
  const parsed = Number(value || 50);
  return Math.min(100, Math.max(1, Number.isFinite(parsed) ? Math.floor(parsed) : 50));
}

export async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const status = optionalString(request.nextUrl.searchParams.get('status'));
    const unreadOnly = request.nextUrl.searchParams.get('unread') === '1';
    const limit = boundedLimit(request.nextUrl.searchParams.get('limit'));
    const where = {
      target_user_id: user.id,
      ...(status ? { status } : unreadOnly ? { read_at: null } : {}),
    };

    const [notifications, unread_count] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: limit,
        include: {
          project: { select: { id: true, name: true, type: true, status: true } },
          videoCard: { select: { id: true, title: true, status: true, project_id: true } },
          approval: { select: { id: true, type: true, status: true } },
          actor: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
        },
      }),
      prisma.notification.count({
        where: {
          target_user_id: user.id,
          read_at: null,
          status: { not: 'read' },
        },
      }),
    ]);

    return NextResponse.json({ notifications, unread_count });
  } catch (error) {
    console.error('[Notifications] List error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const body = await request.json();
    if (body.action !== 'mark_all_read') {
      return NextResponse.json({ error: 'action 必须是 mark_all_read' }, { status: 400 });
    }

    const result = await prisma.notification.updateMany({
      where: {
        target_user_id: user.id,
        read_at: null,
      },
      data: {
        status: 'read',
        read_at: new Date(),
      },
    });

    return NextResponse.json({ updated_count: result.count });
  } catch (error) {
    console.error('[Notifications] Bulk update error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
