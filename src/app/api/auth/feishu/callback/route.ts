import { route as apiRoute } from '@/lib/http/route';
import { NextRequest, NextResponse } from 'next/server';
import {
  FEISHU_STATE_COOKIE,
  FeishuAuthError,
  loginWithFeishuCode,
  verifyFeishuOAuthState,
} from '@/lib/auth/feishu';
import { setSessionCookie } from '@/lib/auth/session-cookie';
import { getSession, parseSessionCookie, SessionUnavailableError } from '@/lib/auth/session';
import { sessionTokenDigest, requestSessionDevice } from '@/lib/auth/session-store';
import { PRIVATE_IDENTITY_COOKIE, PRIVATE_IDENTITY_SECONDS } from '@/lib/security/private-prompt-identity.server';

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
    secure: process.env.NODE_ENV === 'production',
  });
  return response;
}

export const GET = apiRoute({ access: 'public', rateLimit: "auth" }, async function GET(request: NextRequest) {
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
    if (storedState.binding) {
      const user = await getSession();
      const token = parseSessionCookie(request.headers.get('cookie') || '');
      if (!user || !token || user.id !== storedState.binding.userId || sessionTokenDigest(token) !== storedState.binding.sessionDigest) {
        return clearStateCookie(redirectToCallbackPage(request, { error: 'binding_session_expired' }));
      }
    }
    const result = await loginWithFeishuCode(code, publicAuthOrigin(request), { binding: storedState.binding, device: requestSessionDevice(request) });
    const response = redirectToCallbackPage(request, {
      status: 'success',
      next: storedState.next,
    });
    setSessionCookie(response, result.token);
    response.cookies.set(PRIVATE_IDENTITY_COOKIE, result.privateIdentityProof || '', {
      httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/',
      maxAge: result.privateIdentityProof ? PRIVATE_IDENTITY_SECONDS : 0,
    });
    return clearStateCookie(response);
  } catch (error) {
    if (error instanceof SessionUnavailableError) return NextResponse.json({ error: '服务暂时不可用', code: error.code }, { status: 503 });
    if (error instanceof FeishuAuthError) {
      return clearStateCookie(redirectToCallbackPage(request, { error: error.code }));
    }
    console.error('[Feishu callback]', error);
    return clearStateCookie(redirectToCallbackPage(request, { error: 'server_error' }));
  }
});
