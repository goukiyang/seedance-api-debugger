import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { errorJson, getAdminUser } from '@/lib/auth/api-helpers';
import type { SessionUser } from '@/lib/auth/session';

type RouteContext = {
  params: {
    id: string;
  };
};

function canUseAdminSession(user: { role: string; status: string; expires_at: Date | null }) {
  return user.role === 'admin'
    && user.status === 'active'
    && (!user.expires_at || user.expires_at.getTime() > Date.now());
}

export async function POST(request: NextRequest, context: RouteContext) {
  let admin: SessionUser;
  try {
    admin = await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  const { id } = context.params;
  if (id === admin.id) return errorJson('不能禁用当前登录账号', 400);

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) return errorJson('用户不存在', 404);
  if (user.status === 'deleted') return errorJson('用户不存在', 404);
  if (canUseAdminSession(user)) {
    const otherActiveAdminCount = await prisma.user.count({
      where: {
        role: 'admin',
        status: 'active',
        id: { not: id },
        OR: [
          { expires_at: null },
          { expires_at: { gt: new Date() } },
        ],
      },
    });
    if (otherActiveAdminCount <= 0) return errorJson('不能禁用最后一个可用管理员账号', 400);
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id }, data: { status: 'disabled' } });
    await tx.operationLog.create({
      data: {
        operator_id: admin.id,
        action: 'disable_user',
        target_type: 'User',
        target_id: id,
        detail: JSON.stringify({ username: user.username }),
      },
    });
  });

  return NextResponse.json({ ok: true });
}
