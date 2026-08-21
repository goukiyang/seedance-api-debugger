import { NextRequest, NextResponse } from 'next/server';
import { login } from '@/lib/auth/session';
import { setSessionCookie } from '@/lib/auth/session-cookie';
import { defaultLandingForUser, safeLandingForUser } from '@/lib/access/external-user';

function safeRedirectPath(value: unknown, fallback: string) {
  if (typeof value !== 'string') return fallback;
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

export async function POST(request: NextRequest) {
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

    const result = await login(String(identifier), String(password));

    if ('error' in result) {
      if (isFormSubmit) return loginErrorRedirect(request, 'invalid');
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    if (isFormSubmit) {
      const fallback = defaultLandingForUser(result.user);
      const response = new NextResponse(null, {
        status: 303,
        headers: { Location: safeLandingForUser(safeRedirectPath(body.next, fallback), result.user) },
      });
      return setSessionCookie(response, result.token);
    }

    const response = NextResponse.json({ user: result.user });
    return setSessionCookie(response, result.token);
  } catch (err) {
    console.error('[Login]', err);
    return NextResponse.json({ error: '服务器错误' }, { status: 500 });
  }
}
