import { NextRequest, NextResponse } from 'next/server';
import {
  FEISHU_STATE_COOKIE,
  FeishuAuthError,
  loginWithFeishuCode,
  verifyFeishuOAuthState,
} from '@/lib/auth/feishu';
import { setSessionCookie } from '@/lib/auth/session-cookie';

export const dynamic = 'force-dynamic';

function callbackPageUrl(request: NextRequest, params: Record<string, string>) {
  const url = new URL('/auth/feishu/callback', request.url);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url;
}

function redirectToCallbackPage(request: NextRequest, params: Record<string, string>) {
  return NextResponse.redirect(callbackPageUrl(request, params), { status: 303 });
}

function clearStateCookie(response: NextResponse) {
  response.cookies.set(FEISHU_STATE_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 0,
    path: '/',
  });
  return response;
}

export async function GET(request: NextRequest) {
  const returnedError = request.nextUrl.searchParams.get('error');
  if (returnedError) {
    return clearStateCookie(redirectToCallbackPage(request, { error: 'access_denied' }));
  }

  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');
  const storedState = verifyFeishuOAuthState(request.cookies.get(FEISHU_STATE_COOKIE)?.value, state);

  if (!code) return clearStateCookie(redirectToCallbackPage(request, { error: 'missing_code' }));
  if (!storedState) return clearStateCookie(redirectToCallbackPage(request, { error: 'invalid_state' }));

  try {
    const result = await loginWithFeishuCode(code, new URL(request.url).origin);
    const response = redirectToCallbackPage(request, {
      status: 'success',
      next: storedState.next,
    });
    setSessionCookie(response, result.token);
    return clearStateCookie(response);
  } catch (error) {
    if (error instanceof FeishuAuthError) {
      return clearStateCookie(redirectToCallbackPage(request, { error: error.code }));
    }
    console.error('[Feishu callback]', error);
    return clearStateCookie(redirectToCallbackPage(request, { error: 'server_error' }));
  }
}
