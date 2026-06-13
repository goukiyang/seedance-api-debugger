import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { errorJson, getAdminUser } from '@/lib/auth/api-helpers';

export async function POST(request: NextRequest) {
  let admin;
  try {
    admin = await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  try {
    const body = await request.json();
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((id: unknown): id is string => typeof id === 'string' && Boolean(id.trim())).slice(0, 200)
      : [];

    if (!ids.length) return errorJson('请选择反馈', 400);

    const result = await prisma.feedback.updateMany({
      where: { id: { in: ids } },
      data: {
        status: 'archived',
        archived_at: new Date(),
        archived_by: admin.id,
      },
    });

    return NextResponse.json({ success: true, count: result.count });
  } catch (error) {
    console.error('[Admin Feedback Archive]', error);
    return errorJson('归档失败', 500);
  }
}
