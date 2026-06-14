import { NextRequest, NextResponse } from 'next/server';
import {
  buildFeishuAuthorizeUrl,
  createFeishuOAuthState,
  FEISHU_STATE_COOKIE,
  FeishuAuthError,
} from '@/lib/auth/feishu';

export const dynamic = 'force-dynamic';

function requestOrigin(request: NextRequest) {
  return new URL(request.url).origin;
}

function callbackPageUrl(request: NextRequest, errorCode: string) {
  const url = new URL('/auth/feishu/callback', requestOrigin(request));
  url.searchParams.set('error', errorCode);
  return url;
}

function setStateCookie(response: NextResponse, state: ReturnType<typeof createFeishuOAuthState>) {
  response.cookies.set(FEISHU_STATE_COOKIE, state.cookieValue, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: state.maxAgeSeconds,
    path: '/',
  });
  return response;
}

export async function GET(request: NextRequest) {
  try {
    const next = request.nextUrl.searchParams.get('next');
    const state = createFeishuOAuthState(next);
    const authorizeUrl = buildFeishuAuthorizeUrl(state.state, requestOrigin(request));
    return setStateCookie(NextResponse.redirect(authorizeUrl, { status: 303 }), state);
  } catch (error) {
    if (error instanceof FeishuAuthError) {
      return NextResponse.redirect(callbackPageUrl(request, error.code), { status: 303 });
    }
    console.error('[Feishu authorize]', error);
    return NextResponse.redirect(callbackPageUrl(request, 'server_error'), { status: 303 });
  }
}
