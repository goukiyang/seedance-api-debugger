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

export const SESSION_COOKIE = 'session';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-in-production';

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export async function getSession(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  try {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [userIdB64, sig] = parts;
    // 注意：createSession 签名时 update 的是 base64 字符串本身（payload），
    // 因此这里也必须用 userIdB64 做 HMAC，不能先解码。
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(userIdB64).digest('base64');
    const providedBuffer = Buffer.from(sig);
    const expectedBuffer = Buffer.from(expected);
    if (
      providedBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
    ) {
      return null;
    }

    const userId = Buffer.from(userIdB64, 'base64').toString('utf8');
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        username: true,
        email: true,
        role: true,
        account_type: true,
        user_profile: true,
        feature_profile_id: true,
        status: true,
        expires_at: true,
        mobile: true,
        avatar_url: true,
        feishu_user_id: true,
        feishu_open_id: true,
        feishu_union_id: true,
        feishu_tenant_key: true,
        feishu_employee_no: true,
        feishu_department_ids: true,
        last_feishu_sync_at: true,
      },
    });
    if (!user || user.status !== 'active') return null;
    if (user.expires_at && user.expires_at.getTime() <= Date.now()) return null;

    if (user.role !== 'admin' && user.role !== 'user') return null;
    if (user.account_type !== 'internal' && user.account_type !== 'external') return null;
    return {
      id: user.id,
      name: user.name,
      username: user.username,
      email: user.email,
      role: user.role,
      account_type: user.account_type,
      user_profile: user.user_profile,
      feature_profile_id: user.feature_profile_id,
      status: user.status,
      expires_at: user.expires_at,
      mobile: user.mobile,
      avatar_url: user.avatar_url,
      feishu: {
        user_id: user.feishu_user_id,
        open_id: user.feishu_open_id,
        union_id: user.feishu_union_id,
        tenant_key: user.feishu_tenant_key,
        employee_no: user.feishu_employee_no,
        department_ids: parseJsonArray(user.feishu_department_ids),
        last_sync_at: user.last_feishu_sync_at,
      },
    };
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
  if (user.status === 'deleted') return { error: '账号或密码错误', status: 401 };
  if (user.status === 'pending') return { error: '账号待开通，请联系管理员', status: 403 };
  if (user.status === 'expired') return { error: '账号已过期，请联系管理员', status: 403 };
  if (user.status !== 'active') return { error: '账号当前不可用', status: 403 };
  if (user.expires_at && user.expires_at.getTime() <= Date.now()) {
    return { error: '账号已过期，请联系管理员', status: 403 };
  }

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
  const accountType = user.account_type === 'external' ? 'external' : 'internal';
  return {
    user: {
      id: user.id, name: user.name, username: user.username,
      email: user.email, role, account_type: accountType,
      user_profile: user.user_profile || 'other',
      feature_profile_id: user.feature_profile_id,
      status: 'active',
      expires_at: user.expires_at,
      avatar_url: user.avatar_url,
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
