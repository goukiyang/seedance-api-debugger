import { route as apiRoute } from '@/lib/http/route';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { refreshQuotaMembership } from '@/lib/credits/periodic';
import { errorJson, getAdminUser, authFailureResponse } from '@/lib/auth/api-helpers';
import type { SessionUser } from '@/lib/auth/session';
import { revokeAllSessions } from '@/lib/auth/session-store';

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export const POST = apiRoute({ access: 'admin', rateLimit: false }, async function POST(request: NextRequest, context: RouteContext) {
  let admin: SessionUser;
  try {
    admin = await getAdminUser(request);
  } catch (error) {
    return authFailureResponse(error);
  }

  const { id } = (await context.params);
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) return errorJson('用户不存在', 404);
  if (user.status === 'deleted') return errorJson('已删除用户不能启用', 400);
  if (user.expires_at && user.expires_at.getTime() <= Date.now()) {
    return errorJson('账号已过期，请先调整过期时间', 400);
  }

  await prisma.$transaction(async (tx) => {
    const changed = await tx.user.updateMany({ where: { id, updated_at: user.updated_at, password_hash: user.password_hash },
      data: { status: 'active' } });
    if (changed.count !== 1) throw new Error('Account changed concurrently');
    await revokeAllSessions(id, 'account_enabled', tx);
    await refreshQuotaMembership(tx, id);
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
});
