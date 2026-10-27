import { NextResponse } from 'next/server';
import { sessionCookieName } from './session-cookie-name';
import { PRIVATE_IDENTITY_COOKIE } from '@/lib/security/private-prompt-identity.server';

export const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

export function setSessionCookie(response: NextResponse, token: string) {
  response.cookies.set(sessionCookieName(), token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_COOKIE_MAX_AGE,
    path: '/',
    secure: process.env.NODE_ENV === 'production',
  });
  response.cookies.set('session', '', { path: '/', maxAge: 0 });
  response.cookies.set(PRIVATE_IDENTITY_COOKIE, '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 0 });
  return response;
}

export function clearSessionCookie(response: NextResponse) {
  setSessionCookie(response, '');
  response.cookies.set(sessionCookieName(), '', { httpOnly: true, sameSite: 'lax', path: '/',
    secure: process.env.NODE_ENV === 'production', maxAge: 0 });
  return response;
}
