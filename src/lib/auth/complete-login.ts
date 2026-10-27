import type { Prisma, User } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { accountSessionDigest, createSession, isUsableAccount, type SessionAccount, type SessionDevice } from './session-store';
import type { SessionUser } from './session';

export class LoginRejectedError extends Error {
  constructor(message: string, public readonly status = 403) { super(message); }
}

export function toSessionUser(user: User): SessionUser {
  let departments: string[] = [];
  try { const value: unknown = JSON.parse(user.feishu_department_ids || '[]');
    if (Array.isArray(value)) departments = value.filter((item): item is string => typeof item === 'string');
  } catch { /* Invalid optional profile metadata is not authentication evidence. */ }
  return {
    id: user.id, name: user.name, username: user.username, email: user.email,
    role: user.role as SessionUser['role'], account_type: user.account_type as SessionUser['account_type'],
    user_profile: user.user_profile, feature_profile_id: user.feature_profile_id,
    status: 'active', expires_at: user.expires_at, mobile: user.mobile, avatar_url: user.avatar_url,
    feishu: { user_id: user.feishu_user_id, open_id: user.feishu_open_id, union_id: user.feishu_union_id,
      tenant_key: user.feishu_tenant_key, employee_no: user.feishu_employee_no,
      department_ids: departments, last_sync_at: user.last_feishu_sync_at },
  };
}

export async function completeLogin(
  identity: { userId: string; expectedAccount?: SessionAccount; device?: SessionDevice },
  method: 'password' | 'register' | 'feishu' | 'feishu_bind' | 'feishu_cli',
  transaction?: Prisma.TransactionClient,
) {
  const finish = async (tx: Prisma.TransactionClient) => {
    const user = await tx.user.findUnique({ where: { id: identity.userId } });
    if (!user || user.status === 'deleted') throw new LoginRejectedError('账号或密码错误', 401);
    if (identity.expectedAccount && accountSessionDigest(user) !== accountSessionDigest(identity.expectedAccount)) {
      throw new LoginRejectedError('账号状态已变化，请重新登录', 401);
    }
    if (!isUsableAccount(user)) {
      throw new LoginRejectedError(user.status === 'disabled' ? '账号已被禁用'
        : user.status === 'pending' ? '账号待开通，请联系管理员' : '账号已过期，请联系管理员');
    }
    const changed = await tx.user.updateMany({ where: { id: user.id, updated_at: user.updated_at, password_hash: user.password_hash },
      data: { last_login_at: new Date() } });
    if (changed.count !== 1) throw new LoginRejectedError('账号状态已变化，请重新登录', 401);
    const token = await createSession(user.id, user, tx, identity.device);
    await tx.operationLog.create({ data: { operator_id: user.id, action: 'login', target_type: 'User',
      target_id: user.id, detail: JSON.stringify({ method }) } });
    return { user: toSessionUser(user), token };
  };
  return transaction ? finish(transaction) : prisma.$transaction(finish);
}
