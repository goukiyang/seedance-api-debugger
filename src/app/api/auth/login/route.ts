import { route as apiRoute } from '@/lib/http/route';
import { NextRequest, NextResponse } from 'next/server';
import { login, SessionUnavailableError } from '@/lib/auth/session';
import { setSessionCookie } from '@/lib/auth/session-cookie';
import { requestSessionDevice } from '@/lib/auth/session-store';

function safeRedirectPath(value: unknown, fallback: string) {
  if (typeof value !== 'string' || /[\\\u0000-\u001f\u007f]/.test(value)) return fallback;
  const trimmed = value.trim();
  if (!trimmed || !trimmed.startsWith('/') || trimmed.startsWith('//')) return fallback;
  return trimmed;
}

function loginErrorRedirect(request: NextRequest, code: string) {
  const url = new URL('/login', request.url);
  url.searchParams.set('error', code);
  return new NextResponse(null, {
    status: 303,
    headers: { Location: `${url.pathname}${url.search}` },
  });
}

export const POST = apiRoute({ access: 'public', rateLimit: "login" }, async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get('content-type') || '';
    const isFormSubmit = contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data');
    const body = isFormSubmit
      ? Object.fromEntries(await request.formData())
      : await request.json();
    const { identifier, password } = body;

    if (!identifier || !password) {
      if (isFormSubmit) return loginErrorRedirect(request, 'missing');
      return NextResponse.json({ error: '账号和密码不能为空' }, { status: 400 });
    }

    const result = await login(String(identifier), String(password), requestSessionDevice(request));

    if ('error' in result) {
      if (isFormSubmit) return loginErrorRedirect(request, 'invalid');
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    if (isFormSubmit) {
      const fallback = '/';
      const response = new NextResponse(null, {
        status: 303,
        headers: { Location: safeRedirectPath(body.next, fallback) },
      });
      return setSessionCookie(response, result.token);
    }

    const response = NextResponse.json({ user: result.user });
    return setSessionCookie(response, result.token);
  } catch (err) {
    if (err instanceof SessionUnavailableError) return NextResponse.json({ error: '服务暂时不可用', code: err.code }, { status: 503 });
    return NextResponse.json({ error: '服务器错误' }, { status: 500 });
  }
});
