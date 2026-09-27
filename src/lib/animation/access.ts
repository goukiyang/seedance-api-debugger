import { AuthError, type SessionUser } from '@/lib/auth/session';
import { isExternalUser } from '@/lib/access/external-role';
import { getAccessibleProjectIds, getProjectAccess } from '@/lib/projects/permissions';
import { prisma } from '@/lib/prisma';
import { AnimationError } from './http';

export type AnimationAccessMode = 'view' | 'write' | 'create';

export async function assertAnimationProjectAccess(user: SessionUser, projectId: string, mode: 'view' | 'create') {
  const access = await getProjectAccess(user, projectId);
  if (!access.project) throw new AuthError('项目不存在', 404);
  if (mode === 'view' && !access.canView) throw new AuthError('无权查看此项目', 403);
  if (mode === 'create' && !access.canGenerate) throw new AuthError('无权在此项目中创建动画', 403);
  return access;
}

export async function listAnimationProjects(user: SessionUser) {
  const projectIds = await getAccessibleProjectIds(user);
  if (!projectIds.length) return [];
  const projects = await prisma.project.findMany({
    where: { id: { in: projectIds }, status: { not: 'deleted' } },
    select: { id: true, name: true },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
  const withAccess = await Promise.all(projects.map(async (project) => {
    const access = await getProjectAccess(user, project.id);
    return access.canView ? { ...project, can_create: access.canGenerate } : null;
  }));
  return withAccess.filter((project): project is NonNullable<typeof project> => project !== null);
}

export async function requireAnimationDocument(user: SessionUser, documentId: string, mode: AnimationAccessMode) {
  const document = await prisma.animationDocument.findUnique({ where: { id: documentId } });
  if (!document) throw new AnimationError('动画记录不存在', 404, 'NOT_FOUND');
  const access = await getProjectAccess(user, document.project_id);
  if (!access.project || !access.canView) throw new AnimationError('无权查看此动画记录', 403, 'FORBIDDEN');

  const canEdit = (document.owner_user_id === user.id && access.canGenerate) || access.canManageAssets;
  if (mode !== 'view' && !canEdit) throw new AnimationError('无权修改此动画记录', 403, 'FORBIDDEN');
  if (mode === 'create' && !access.canGenerate) throw new AnimationError('无权在此项目中处理动画', 403, 'FORBIDDEN');

  return { document, access, canEdit, canManage: access.canManageAssets };
}

export async function canCurrentActorRunAnimationJob(actorId: string, projectId: string, documentOwnerId: string) {
  const actor = await prisma.user.findUnique({
    where: { id: actorId },
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
    },
  });
  if (!actor || actor.status !== 'active' || (actor.expires_at && actor.expires_at.getTime() <= Date.now()) || isExternalUser({
    role: actor.role,
    account_type: actor.account_type,
    feishu: { user_id: actor.feishu_user_id, open_id: actor.feishu_open_id, union_id: actor.feishu_union_id },
  })) return false;
  const sessionActor = {
    ...actor,
    feishu: {
      user_id: actor.feishu_user_id,
      open_id: actor.feishu_open_id,
      union_id: actor.feishu_union_id,
      tenant_key: null,
      employee_no: null,
      department_ids: [],
      last_sync_at: null,
    },
  } as SessionUser;
  const access = await getProjectAccess(sessionActor, projectId);
  if (!access.project || !access.canView) return false;
  return access.canManageAssets || (documentOwnerId === actorId && access.canGenerate);
}

export function assertDocumentIsActive(status: string) {
  if (status !== 'active') throw new AnimationError('已归档的动画不能新增处理任务', 409, 'DOCUMENT_ARCHIVED');
}
