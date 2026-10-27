import { route as apiRoute } from '@/lib/http/route';
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { revokeAllSessions } from '@/lib/auth/session-store';
import { clearSessionCookie } from '@/lib/auth/session-cookie';

export const POST = apiRoute({ access: 'user', rateLimit: false }, async function POST() {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    await prisma.$transaction(async (tx) => {
      await revokeAllSessions(user.id, 'logout_all', tx);
      await tx.operationLog.create({ data: { operator_id: user.id, action: 'logout_all', target_type: 'User', target_id: user.id } });
    });
    return clearSessionCookie(NextResponse.json({ ok: true }));
  } catch {
    return NextResponse.json({ error: '服务暂时不可用' }, { status: 503 });
  }
});
