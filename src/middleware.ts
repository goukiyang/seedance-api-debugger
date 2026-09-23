import { NextRequest, NextResponse } from 'next/server';

const SESSION_COOKIE = 'session';
const LEGACY_HOST_REDIRECTS: Record<string, string> = {
  'sd2.youdoodesign.com': 'https://sd2.youdooart.com',
};
const PROTECTED_PREFIXES = [
  '/admin',
  '/dashboard',
  '/generate',
  '/tasks',
  '/collections',
  '/templates',
  '/points',
  '/help',
  '/config',
  '/tools',
];

function normalizedHost(value: string | null | undefined) {
  const host = value?.split(',')[0]?.trim().toLowerCase();
  if (!host) return null;
  return host.replace(/:\d+$/, '');
}

function forwardedOrigin(request: NextRequest) {
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();

  if (forwardedHost) {
    return `${forwardedProto || 'https'}://${forwardedHost}`;
  }

  return request.nextUrl.origin;
}

function legacyRedirectUrl(request: NextRequest) {
  const host = normalizedHost(request.headers.get('x-forwarded-host'))
    || normalizedHost(request.headers.get('host'))
    || normalizedHost(request.nextUrl.host);
  const targetOrigin = host ? LEGACY_HOST_REDIRECTS[host] : null;
  if (!targetOrigin) return null;
  return new URL(`${request.nextUrl.pathname}${request.nextUrl.search}`, targetOrigin);
}

export async function middleware(request: NextRequest) {
  const redirectUrl = legacyRedirectUrl(request);
  if (redirectUrl) return NextResponse.redirect(redirectUrl, 308);

  const { pathname } = request.nextUrl;
  if (pathname.startsWith('/uploads/assets/') || pathname.startsWith('/uploads/thumbs/')) {
    const accessUrl = new URL('/api/image-studio/upload-access', request.url);
    accessUrl.searchParams.set('path', pathname);
    const accessResponse = await fetch(accessUrl, {
      cache: 'no-store',
      headers: {
        cookie: request.headers.get('cookie') || '',
        'x-image-studio-upload-access-check': '1',
      },
    });
    if (accessResponse.status !== 204) {
      return NextResponse.json({ error: '图片不存在或无权访问' }, { status: accessResponse.status === 404 ? 404 : 503 });
    }
  }
  const needsAuth = PROTECTED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  if (!needsAuth) return NextResponse.next();

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (token) return NextResponse.next();

  const loginUrl = new URL('/login', forwardedOrigin(request));
  loginUrl.searchParams.set('next', `${pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
