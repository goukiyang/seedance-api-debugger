import { route as apiRoute } from '@/lib/http/route';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authFailureResponse, getAdminUser } from '@/lib/auth/api-helpers';
import { revokeAllSessions } from '@/lib/auth/session-store';

export const POST = apiRoute({ access: 'admin', rateLimit: false }, async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  let admin;
  try { admin = await getAdminUser(request); }
  catch (error) { return authFailureResponse(error); }
  const { id } = await context.params;
  try {
    const target = await prisma.user.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!target || target.status === 'deleted') return NextResponse.json({ error: '用户不存在' }, { status: 404 });
    await prisma.$transaction(async (tx) => {
      await revokeAllSessions(id, 'admin_revoke', tx);
      await tx.operationLog.create({ data: { operator_id: admin.id, action: 'revoke_user_sessions', target_type: 'User', target_id: id } });
    });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: '服务暂时不可用' }, { status: 503 });
  }
});
