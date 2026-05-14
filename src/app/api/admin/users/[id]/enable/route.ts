import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { errorJson, getAdminUser } from '@/lib/auth/api-helpers';
import type { SessionUser } from '@/lib/auth/session';

type RouteContext = {
  params: {
    id: string;
  };
};

export async function POST(request: NextRequest, context: RouteContext) {
  let admin: SessionUser;
  try {
    admin = await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  const { id } = context.params;
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) return errorJson('用户不存在', 404);
  if (user.status === 'deleted') return errorJson('已删除用户不能启用', 400);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id }, data: { status: 'active' } });
    await tx.operationLog.create({
      data: {
        operator_id: admin.id,
        action: 'enable_user',
        target_type: 'User',
        target_id: id,
        detail: JSON.stringify({ username: user.username }),
      },
    });
  });

  return NextResponse.json({ ok: true });
}
