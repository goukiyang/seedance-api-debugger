import { NextResponse } from 'next/server';
import { SESSION_COOKIE } from './session';
import { PRIVATE_IDENTITY_COOKIE } from '@/lib/security/private-prompt-identity.server';

import { SESSION_COOKIE_MAX_AGE } from './session-account-binding';
export { SESSION_COOKIE_MAX_AGE } from './session-account-binding';

export function setSessionCookie(response: NextResponse, token: string) {
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_COOKIE_MAX_AGE,
    path: '/',
  });
  // New logins rely on their primary session and retire any legacy proof.
  response.cookies.set(PRIVATE_IDENTITY_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
  return response;
}
