import crypto from 'crypto';
import { cookies } from 'next/headers';
import { prisma } from '@/lib/prisma';
import { verifyPassword } from './password';

export interface SessionUser {
  id: string;
  name: string;
  username: string;
  email: string;
  role: 'admin' | 'user';
  status: 'active' | 'disabled';
}

export const SESSION_COOKIE = 'session';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-in-production';

export async function getSession(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  try {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [userId, sig] = parts;
    const payload = Buffer.from(userId, 'base64').toString('utf8');
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64');
    const providedBuffer = Buffer.from(sig);
    const expectedBuffer = Buffer.from(expected);
    if (
      providedBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
    ) {
      return null;
    }

    const user = await prisma.user.findUnique({
      where: { id: payload },
      select: {
        id: true, name: true, username: true, email: true,
        role: true, status: true,
      },
    });
    if (!user || user.status === 'disabled') return null;

    if (user.role !== 'admin' && user.role !== 'user') return null;
    return user as SessionUser;
  } catch {
    return null;
  }
}

export async function createSession(userId: string): Promise<string> {
  const payload = Buffer.from(userId).toString('base64');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64');
  return `${payload}.${sig}`;
}

export async function login(
  identifier: string,
  password: string
): Promise<{ user: SessionUser; token: string } | { error: string; status: number }> {
  const user = await prisma.user.findFirst({
    where: {
      OR: [{ username: identifier }, { email: identifier }],
    },
  });
  if (!user) return { error: '账号或密码错误', status: 401 };
  if (user.status === 'disabled') return { error: '账号已被禁用', status: 403 };

  if (!verifyPassword(password, user.password_hash)) {
    return { error: '账号或密码错误', status: 401 };
  }

  // 更新 last_login_at
  await prisma.user.update({
    where: { id: user.id },
    data: { last_login_at: new Date() },
  });

  const token = await createSession(user.id);
  const role = user.role === 'admin' ? 'admin' : 'user';
  return {
    user: {
      id: user.id, name: user.name, username: user.username,
      email: user.email, role, status: 'active',
    },
    token,
  };
}

export async function logout(): Promise<void> {
  // 服务端无状态，cookie 清除由前端处理
}

export function requireAuth(user: SessionUser | null): asserts user is SessionUser {
  if (!user) throw new AuthError('未登录', 401);
}

export function requireAdmin(user: SessionUser | null): asserts user is SessionUser {
  if (!user) throw new AuthError('未登录', 401);
  if (user.role !== 'admin') throw new AuthError('权限不足', 403);
}

export class AuthError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}
