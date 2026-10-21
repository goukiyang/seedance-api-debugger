import type { SessionUser } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import type { AdminUsageScope, ProjectUsageScope, SelfUsageScope, UsageScope } from './dto';

const identities = new WeakMap<UsageScope, SessionUser>();
function bind<T extends UsageScope>(scope: T, user: SessionUser): T {
  if (!user.id || user.status !== 'active' || user.expires_at && user.expires_at.getTime() <= Date.now()) throw new AuthError('账号当前不可用', 403);
  Object.freeze(scope);
  identities.set(scope, user);
  return scope;
}

export function usageScopeUser(scope: UsageScope): SessionUser {
  const user = identities.get(scope);
  if (!user || user.id !== scope.viewerId) throw new AuthError('用量范围未经服务器授权', 403);
  return user;
}

export function createSelfUsageScope(user: SessionUser): SelfUsageScope {
  return bind({ kind: 'self', viewerId: user.id }, user);
}

export async function createProjectUsageScope(user: SessionUser, projectId: string, memberOwnerId?: string): Promise<ProjectUsageScope> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(projectId) || memberOwnerId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(memberOwnerId)) throw new AuthError('项目或成员条件无效', 400);
  const { assertCanViewProject } = await import('@/lib/projects/permissions');
  await assertCanViewProject(user, projectId);
  return bind({ kind: 'project', viewerId: user.id, projectId, ...(memberOwnerId ? { memberOwnerId } : {}) }, user);
}

export function createAdminUsageScope(user: SessionUser): AdminUsageScope {
  if (user.role !== 'admin') throw new AuthError('无权查看管理用量', 403);
  return bind({ kind: 'admin', viewerId: user.id }, user);
}
