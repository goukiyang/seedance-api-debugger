import { NextResponse } from 'next/server';
import { SESSION_COOKIE } from './session';

export const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

export function setSessionCookie(response: NextResponse, token: string) {
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_COOKIE_MAX_AGE,
    path: '/',
  });
  return response;
}
