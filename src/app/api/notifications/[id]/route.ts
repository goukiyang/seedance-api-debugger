import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

const NOTIFICATION_INCLUDE = {
  project: { select: { id: true, name: true, type: true, status: true } },
  videoCard: { select: { id: true, title: true, status: true, project_id: true } },
  approval: { select: { id: true, type: true, status: true } },
  actor: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
} as const;

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const notification = await prisma.notification.findFirst({
      where: { id: params.id, target_user_id: user.id },
      include: NOTIFICATION_INCLUDE,
    });
    if (!notification) return NextResponse.json({ error: '通知不存在' }, { status: 404 });

    return NextResponse.json({ notification });
  } catch (error) {
    console.error('[Notifications] Detail error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const body = await request.json();
    if (!['mark_read', 'retry_failed'].includes(body.action)) {
      return NextResponse.json({ error: 'action 必须是 mark_read 或 retry_failed' }, { status: 400 });
    }

    const existing = await prisma.notification.findFirst({
      where: { id: params.id, target_user_id: user.id },
      select: { id: true, status: true },
    });
    if (!existing) return NextResponse.json({ error: '通知不存在' }, { status: 404 });
    if (body.action === 'retry_failed' && existing.status !== 'failed') {
      return NextResponse.json({ error: '只有失败通知可以重试' }, { status: 400 });
    }

    const notification = await prisma.notification.update({
      where: { id: params.id },
      data: body.action === 'mark_read'
        ? {
            status: 'read',
            read_at: new Date(),
          }
        : {
            status: 'sent',
            sent_at: new Date(),
            error_message: null,
          },
      include: NOTIFICATION_INCLUDE,
    });

    return NextResponse.json({ notification });
  } catch (error) {
    console.error('[Notifications] Update error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
