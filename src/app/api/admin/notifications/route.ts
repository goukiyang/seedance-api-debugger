import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getAdminUser, errorJson } from '@/lib/auth/api-helpers';
import { createNotification } from '@/lib/notifications';

export const dynamic = 'force-dynamic';

function cleanText(value: unknown, maxLength: number) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

export async function POST(request: NextRequest) {
  let admin;
  try {
    admin = await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  const body = await request.json().catch(() => ({}));
  const title = cleanText(body.title, 80);
  const message = cleanText(body.body ?? body.message, 600);
  const href = cleanText(body.href, 240) || '/notifications';

  if (!title) return errorJson('标题不能为空', 400);
  if (!message) return errorJson('内容不能为空', 400);

  const activeUsers = await prisma.user.findMany({
    where: { status: 'active' },
    select: { id: true },
  });
  const announcementId = `announcement:${Date.now()}`;

  const result = await prisma.$transaction(async (tx) => {
    for (const user of activeUsers) {
      await createNotification(tx, {
        userId: user.id,
        type: 'version_update',
        title,
        body: message,
        href,
        sourceType: 'admin_announcement',
        sourceId: announcementId,
        actorUserId: admin.id,
        metadata: { created_by: admin.id },
      });
    }

    await tx.operationLog.create({
      data: {
        operator_id: admin.id,
        action: 'notification_announcement_publish',
        target_type: 'Notification',
        target_id: announcementId,
        detail: JSON.stringify({ title, user_count: activeUsers.length }),
      },
    });

    return { announcementId, count: activeUsers.length };
  });

  return NextResponse.json({ ok: true, announcement_id: result.announcementId, count: result.count });
}
