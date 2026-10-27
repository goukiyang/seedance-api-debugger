import { route as apiRoute } from '@/lib/http/route';
import { NextResponse } from 'next/server';
import { logout } from '@/lib/auth/session';
import { clearSessionCookie } from '@/lib/auth/session-cookie';

export const POST = apiRoute({ access: 'public', rateLimit: false }, async function POST() {
  try {
    await logout();
    return clearSessionCookie(NextResponse.json({ ok: true }));
  } catch {
    return NextResponse.json({ error: '服务暂时不可用', code: 'AUTH_UNAVAILABLE' }, { status: 503 });
  }
});
