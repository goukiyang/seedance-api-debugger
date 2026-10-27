import { route as apiRoute } from '@/lib/http/route';
import { NextRequest, NextResponse } from 'next/server';
import { getSession, parseSessionCookie, SessionUnavailableError } from '@/lib/auth/session';
import { sessionTokenDigest } from '@/lib/auth/session-store';
import { buildFeishuAuthorizeUrl, createFeishuOAuthState, FEISHU_STATE_COOKIE, FeishuAuthError } from '@/lib/auth/feishu';

export const POST = apiRoute({ access: 'user', rateLimit: "auth" }, async function POST(request: NextRequest) {
  try {
    const user = await getSession(), token = parseSessionCookie(request.headers.get('cookie') || '');
    if (!user || !token) return NextResponse.json({ error: '请先登录原账号' }, { status: 401 });
    const origin = new URL(process.env.FEISHU_REDIRECT_URI || request.url).origin;
    if (request.headers.get('origin') !== origin) return NextResponse.json({ error: '请求来源无效' }, { status: 403 });
    const state = createFeishuOAuthState('/account', { userId: user.id, sessionDigest: sessionTokenDigest(token) });
    const response = NextResponse.json({ authorize_url: buildFeishuAuthorizeUrl(state.state, origin) });
    response.cookies.set(FEISHU_STATE_COOKIE, state.cookieValue, { httpOnly: true, secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax', path: '/', maxAge: state.maxAgeSeconds });
    return response;
  } catch (error) {
    if (error instanceof FeishuAuthError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    if (error instanceof SessionUnavailableError) return NextResponse.json({ error: '服务暂时不可用' }, { status: 503 });
    return NextResponse.json({ error: '服务暂时不可用' }, { status: 503 });
  }
});
