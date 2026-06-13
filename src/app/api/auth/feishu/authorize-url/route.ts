import { NextRequest, NextResponse } from 'next/server';
import {
  buildFeishuAuthorizeUrl,
  createFeishuOAuthState,
  FEISHU_STATE_COOKIE,
  FeishuAuthError,
  isFeishuCliLoginEnabledForHost,
} from '@/lib/auth/feishu';

export const dynamic = 'force-dynamic';

function requestOrigin(request: NextRequest) {
  return new URL(request.url).origin;
}

export async function GET(request: NextRequest) {
  try {
    const next = request.nextUrl.searchParams.get('next');
    const state = createFeishuOAuthState(next);
    const authorizeUrl = buildFeishuAuthorizeUrl(state.state, requestOrigin(request));
    const response = NextResponse.json({
      authorize_url: authorizeUrl,
      state: state.state,
    });

    response.cookies.set(FEISHU_STATE_COOKIE, state.cookieValue, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: state.maxAgeSeconds,
      path: '/',
    });
    return response;
  } catch (error) {
    if (error instanceof FeishuAuthError) {
      return NextResponse.json({
        error: error.message,
        code: error.code,
        cli_login_available: isFeishuCliLoginEnabledForHost(request.nextUrl.hostname),
      }, { status: error.status });
    }
    console.error('[Feishu authorize-url]', error);
    return NextResponse.json({ error: '飞书登录初始化失败' }, { status: 500 });
  }
}
