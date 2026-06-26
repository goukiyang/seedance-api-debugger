import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUser, errorJson } from '@/lib/auth/api-helpers';

export const dynamic = 'force-dynamic';

function parseLimit(value: string | null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(50, Math.max(1, Math.floor(parsed))) : 20;
}

function metadataHref(value: string | null) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { href?: unknown };
    return typeof parsed.href === 'string' ? parsed.href : null;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  let user;
  try {
    user = await getSessionUser(request);
  } catch {
    return errorJson('未登录', 401);
  }

  const limit = parseLimit(request.nextUrl.searchParams.get('limit'));
  const [notifications, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { target_user_id: user.id, status: { not: 'archived' } },
      orderBy: { created_at: 'desc' },
      take: limit,
    }),
    prisma.notification.count({
      where: { target_user_id: user.id, status: { in: ['pending', 'sent'] } },
    }),
  ]);

  return NextResponse.json({
    notifications: notifications.map((notification) => ({
      id: notification.id,
      type: notification.type,
      title: notification.title,
      body: notification.body || '',
      href: metadataHref(notification.metadata_json),
      status: notification.status === 'read' ? 'read' : 'unread',
      created_at: notification.created_at,
      read_at: notification.read_at,
    })),
    unread_count: unreadCount,
  });
}

export async function PATCH(request: NextRequest) {
  let user;
  try {
    user = await getSessionUser(request);
  } catch {
    return errorJson('未登录', 401);
  }

  const body = await request.json().catch(() => ({}));
  const markAllRead = body.all_read === true || body.allRead === true;
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((id: unknown): id is string => typeof id === 'string' && Boolean(id.trim())).slice(0, 100)
    : [];

  if (!markAllRead && ids.length === 0) return errorJson('请选择通知', 400);

  const result = await prisma.notification.updateMany({
    where: {
      target_user_id: user.id,
      status: { in: ['pending', 'sent'] },
      ...(markAllRead ? {} : { id: { in: ids } }),
    },
    data: {
      status: 'read',
      read_at: new Date(),
    },
  });

  return NextResponse.json({ ok: true, count: result.count });
}
