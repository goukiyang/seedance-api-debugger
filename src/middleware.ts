import { NextRequest, NextResponse } from 'next/server';

const SESSION_COOKIE = 'session';
const PROTECTED_PREFIXES = [
  '/admin',
  '/dashboard',
  '/generate',
  '/tasks',
  '/videos',
  '/collections',
  '/templates',
  '/points',
  '/help',
  '/config',
];

function forwardedOrigin(request: NextRequest) {
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();

  if (forwardedHost) {
    return `${forwardedProto || 'https'}://${forwardedHost}`;
  }

  return request.nextUrl.origin;
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
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
    '/admin/:path*',
    '/dashboard/:path*',
    '/generate/:path*',
    '/tasks/:path*',
    '/videos/:path*',
    '/collections/:path*',
    '/templates/:path*',
    '/points/:path*',
    '/help/:path*',
    '/config/:path*',
  ],
};
