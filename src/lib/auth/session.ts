import { cookies } from 'next/headers';
import { PublicApiError } from '@/lib/http/public-error';
import { prisma } from '@/lib/prisma';
import { authenticatePrivateIdentity, PRIVATE_IDENTITY_COOKIE } from '@/lib/security/private-prompt-identity.server';
import { verifyPassword } from './password';
import { completeLogin, LoginRejectedError, toSessionUser } from './complete-login';
import { resolveSession, revokeSession, type SessionClient, type SessionDevice } from './session-store';
import { sessionCookieName } from './session-cookie-name';
import { SessionUnavailableError } from './session-errors';

export interface SessionUser {
  id: string;
  name: string;
  username: string;
  email: string;
  role: 'admin' | 'user';
  account_type: 'internal' | 'external';
  user_profile: string;
  feature_profile_id: string | null;
  status: 'active' | 'disabled' | 'pending' | 'expired';
  expires_at: Date | null;
  mobile?: string | null;
  avatar_url?: string | null;
  feishu?: {
    user_id: string | null;
    open_id: string | null;
    union_id: string | null;
    tenant_key: string | null;
    employee_no: string | null;
    department_ids: string[];
    last_sync_at: Date | null;
  };
}

export { createSession } from './session-store';
export { SessionUnavailableError } from './session-errors';
export const SESSION_COOKIE = sessionCookieName();

export function parseSessionCookie(rawCookie: string): string | null {
  const prefix = `${sessionCookieName()}=`;
  return rawCookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length) || null;
}

export async function getSession(client?: SessionClient): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(sessionCookieName())?.value;
  if (!token) return null;
  const user = await getSessionByToken(token, client);
  if (user) authenticatePrivateIdentity(user, store.get(PRIVATE_IDENTITY_COOKIE)?.value, token);
  return user;
}

export async function getSessionByToken(token?: string | null, client?: SessionClient): Promise<SessionUser | null> {
  const user = await resolveSession(token, client);
  return user ? toSessionUser(user) : null;
}

export async function login(identifier: string, password: string, device?: SessionDevice): Promise<{ user: SessionUser; token: string } | { error: string; status: number }> {
  try {
    const user = await prisma.user.findFirst({ where: { OR: [{ username: identifier }, { email: identifier }] } });
    const passwordValid = await verifyPassword(password, user?.password_hash);
    if (!passwordValid || !user) return { error: '账号或密码错误', status: 401 };
    return await completeLogin({ userId: user.id, expectedAccount: user, device }, 'password');
  } catch (error) {
    if (error instanceof LoginRejectedError) return { error: error.message, status: error.status };
    throw new SessionUnavailableError();
  }
}

export async function logout(): Promise<void> {
  const store = await cookies();
  const token = store.get(sessionCookieName())?.value;
  if (token) await revokeSession(token);
}

export function requireAuth(user: SessionUser | null): asserts user is SessionUser {
  if (!user) throw new AuthError('未登录', 401);
}

export function requireAdmin(user: SessionUser | null): asserts user is SessionUser {
  requireAuth(user);
  if (user.role !== 'admin') throw new AuthError('权限不足', 403);
}

export class AuthError extends PublicApiError {
  constructor(message: string, public readonly status: number) { super(message, status); }
}
