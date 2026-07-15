import { NextRequest, NextResponse } from 'next/server';
import {
  FEISHU_STATE_COOKIE,
  FeishuAuthError,
  loginWithFeishuCode,
  verifyFeishuOAuthState,
} from '@/lib/auth/feishu';
import {
  buildFeishuLocalCallbackUrl,
  parseFeishuLocalRelay,
} from '@/lib/auth/feishu-local-relay';
import { setSessionCookie } from '@/lib/auth/session-cookie';

export const dynamic = 'force-dynamic';

function originFromUrl(value: string | undefined) {
  if (!value) return '';
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

function publicAuthOrigin(request: NextRequest) {
  return originFromUrl(process.env.NEXT_PUBLIC_BASE_URL)
    || originFromUrl(process.env.BASE_URL)
    || originFromUrl(process.env.NEXTAUTH_URL)
    || originFromUrl(process.env.FEISHU_REDIRECT_URI)
    || new URL(request.url).origin;
}

function callbackPageUrl(request: NextRequest, params: Record<string, string>) {
  const url = new URL('/auth/feishu/callback', publicAuthOrigin(request));
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
  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');
  const storedState = verifyFeishuOAuthState(request.cookies.get(FEISHU_STATE_COOKIE)?.value, state);
  const relay = storedState ? parseFeishuLocalRelay(storedState.next) : null;

  if (returnedError) {
    const response = relay
      ? NextResponse.redirect(buildFeishuLocalCallbackUrl(relay, { error: 'access_denied' }), { status: 303 })
      : redirectToCallbackPage(request, { error: 'access_denied' });
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    return clearStateCookie(response);
  }

  if (!code) return clearStateCookie(redirectToCallbackPage(request, { error: 'missing_code' }));
  if (!storedState) return clearStateCookie(redirectToCallbackPage(request, { error: 'invalid_state' }));
  if (relay) {
    const response = NextResponse.redirect(buildFeishuLocalCallbackUrl(relay, { code }), { status: 303 });
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    return clearStateCookie(response);
  }

  try {
    const result = await loginWithFeishuCode(code, publicAuthOrigin(request));
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
