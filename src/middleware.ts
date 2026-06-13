import { NextRequest, NextResponse } from 'next/server';

const SESSION_COOKIE = 'session';
const PROTECTED_PREFIXES = ['/admin', '/generate', '/tasks', '/config'];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const needsAuth = PROTECTED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  if (!needsAuth) return NextResponse.next();

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (token) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.searchParams.set('next', pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/admin/:path*', '/generate/:path*', '/tasks/:path*', '/config/:path*'],
};
