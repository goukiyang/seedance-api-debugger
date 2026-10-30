import { NextResponse } from 'next/server';
import { SESSION_COOKIE } from './session';

import { SESSION_COOKIE_MAX_AGE } from './session-account-binding';
export { SESSION_COOKIE_MAX_AGE } from './session-account-binding';

export function setSessionCookie(response: NextResponse, token: string) {
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_COOKIE_MAX_AGE,
    path: '/',
  });
  return response;
}
