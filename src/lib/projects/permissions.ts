import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/session';
import type { SessionUser } from '@/lib/auth/session';
import {
  isTaskHiddenFromRegularUsers,
  USER_VISIBLE_TASK_RETENTION_STATUSES,
} from '@/lib/tasks/retention';

export type ProjectRole = 'project_owner' | 'editor' | 'member' | 'viewer';

const ACTIVE_MEMBER_STATUS = 'active';
const DELETED_PROJECT_STATUS = 'deleted';
const SHARABLE_PROJECT_TYPES = ['team', 'public'];

type ProjectAccessOptions = {
  includeAdminAll?: boolean;
  includeDeleted?: boolean;
};

function isSharableProjectType(type: string) {
  return SHARABLE_PROJECT_TYPES.includes(type);
}

export async function logProjectAction(
  actorUserId: string,
  action: string,
  targetType: string,
  targetId: string,
  detail?: Record<string, unknown>,
) {
  try {
    await prisma.operationLog.create({
      data: {
        operator_id: actorUserId,
        action,
        target_type: targetType,
        target_id: targetId,
        detail: detail ? JSON.stringify(detail) : null,
      },
    });
  } catch (error) {
    console.error('[ProjectAudit] Failed to write operation log:', error);
  }
}

export async function ensureDefaultProjectForUser(userId: string) {
  const existing = await prisma.project.findFirst({
    where: {
      owner_user_id: userId,
      type: 'personal',
      status: { not: DELETED_PROJECT_STATUS },
    },
    orderBy: { created_at: 'asc' },
  });

  if (existing) {
    await prisma.projectMember.upsert({
      where: { project_id_user_id: { project_id: existing.id, user_id: userId } },
      update: { role: 'project_owner', status: ACTIVE_MEMBER_STATUS },
      create: {
        project_id: existing.id,
        user_id: userId,
        role: 'project_owner',
        joined_by: userId,
      },
    });
    return existing;
  }

  const project = await prisma.$transaction(async (tx) => {
    const created = await tx.project.create({
      data: {
        name: '我的默认项目',
        description: '系统自动创建的个人默认项目',
        type: 'personal',
        visibility: 'private',
        owner_user_id: userId,
        created_by: userId,
        status: 'active',
      },
    });

    await tx.projectMember.create({
      data: {
        project_id: created.id,
        user_id: userId,
        role: 'project_owner',
        joined_by: userId,
      },
    });

    await tx.operationLog.create({
      data: {
        operator_id: userId,
        action: 'project_create_default',
        target_type: 'project',
        target_id: created.id,
        detail: JSON.stringify({ type: 'personal' }),
      },
    });

    return created;
  });

  return project;
}

export async function getAccessibleProjectIds(user: SessionUser, options: ProjectAccessOptions = {}) {
  const includeAdminAll = options.includeAdminAll ?? true;

  if (user.role === 'admin' && includeAdminAll) {
    const projects = await prisma.project.findMany({
      where: { status: { not: DELETED_PROJECT_STATUS } },
      select: { id: true },
    });
    return projects.map((project) => project.id);
  }

  const [memberships, ownedProjects] = await Promise.all([
    prisma.projectMember.findMany({
      where: {
        user_id: user.id,
        status: ACTIVE_MEMBER_STATUS,
        project: {
          status: { not: DELETED_PROJECT_STATUS },
          type: { in: SHARABLE_PROJECT_TYPES },
        },
      },
      select: { project_id: true },
    }),
    prisma.project.findMany({
      where: {
        owner_user_id: user.id,
        status: { not: DELETED_PROJECT_STATUS },
      },
      select: { id: true },
    }),
  ]);

  return Array.from(new Set([
    ...memberships.map((membership) => membership.project_id),
    ...ownedProjects.map((project) => project.id),
  ]));
}

export async function getProjectAccess(user: SessionUser, projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      members: {
        where: { user_id: user.id },
        take: 1,
      },
    },
  });

  if (!project || project.status === DELETED_PROJECT_STATUS) {
    return {
      project: null,
      role: null,
      canView: false,
      canGenerate: false,
      canManageProject: false,
      canManageMembers: false,
      canManageAssets: false,
    };
  }

  if (user.role === 'admin') {
    return {
      project,
      role: 'admin',
      canView: true,
      canGenerate: project.status === 'active' && project.type !== 'system',
      canManageProject: true,
      canManageMembers: isSharableProjectType(project.type),
      canManageAssets: project.status === 'active' && project.type !== 'system',
    };
  }

  const membership = isSharableProjectType(project.type) ? project.members[0] : null;
  const isOwner = project.owner_user_id === user.id;
  const activeRole = membership?.status === ACTIVE_MEMBER_STATUS ? membership.role : null;
  const role = (isOwner ? 'project_owner' : activeRole) as ProjectRole | null;
  const canView = Boolean(role);
  const isActiveNonSystem = project.status === 'active' && project.type !== 'system';
  const canGenerate = canView && isActiveNonSystem && role !== 'viewer';
  const canManageProject = role === 'project_owner';
  const canManageMembers = role === 'project_owner' && isSharableProjectType(project.type);
  const canManageAssets = isActiveNonSystem && (role === 'project_owner' || role === 'editor');

  return { project, role, canView, canGenerate, canManageProject, canManageMembers, canManageAssets };
}

export async function assertCanViewProject(user: SessionUser, projectId: string) {
  const access = await getProjectAccess(user, projectId);
  if (!access.project) throw new AuthError('项目不存在', 404);
  if (!access.canView) throw new AuthError('无权查看此项目', 403);
  return access;
}

export async function assertCanManageProjectMembers(user: SessionUser, projectId: string) {
  const access = await getProjectAccess(user, projectId);
  if (!access.project) throw new AuthError('项目不存在', 404);
  if (!access.canManageMembers) throw new AuthError('无权管理此项目成员', 403);
  return access;
}

export async function assertCanManageProject(user: SessionUser, projectId: string) {
  const access = await getProjectAccess(user, projectId);
  if (!access.project) throw new AuthError('项目不存在', 404);
  if (!access.canManageProject) throw new AuthError('无权管理此项目', 403);
  return access;
}

export async function assertCanManageProjectAssets(user: SessionUser, projectId: string) {
  const access = await getProjectAccess(user, projectId);
  if (!access.project) throw new AuthError('项目不存在', 404);
  if (!access.canManageAssets) throw new AuthError('无权管理此项目素材', 403);
  return access;
}

export async function assertCanGenerateInProject(user: SessionUser, projectId: string) {
  const access = await getProjectAccess(user, projectId);
  if (!access.project) throw new AuthError('项目不存在', 404);
  if (!access.canGenerate) throw new AuthError('无权在此项目中生成内容', 403);
  return access;
}

export async function getProjectForGeneration(user: SessionUser, requestedProjectId?: string | null) {
  const projectId = requestedProjectId || (await ensureDefaultProjectForUser(user.id)).id;
  const access = await assertCanGenerateInProject(user, projectId);
  return access.project;
}

export async function assertCanViewTask(user: SessionUser, task: {
  id: string;
  project_id: string | null;
  owner_user_id?: string | null;
  user_id?: string | null;
  retention_status?: string | null;
}) {
  if (user.role === 'admin') return;

  if (isTaskHiddenFromRegularUsers(task)) {
    throw new AuthError('任务不存在或已删除', 404);
  }

  if (task.project_id) {
    await assertCanViewProject(user, task.project_id);
    return;
  }

  const ownerId = task.owner_user_id || task.user_id;
  if (ownerId === user.id) return;

  throw new AuthError('无权查看此任务', 403);
}

export async function getTaskWhereForUser(
  user: SessionUser,
  projectId?: string | null,
  options: ProjectAccessOptions = {},
) {
  const includeAdminAll = options.includeAdminAll ?? true;
  const includeDeleted = options.includeDeleted ?? false;
  const retentionWhere = includeDeleted
    ? null
    : { retention_status: { in: [...USER_VISIBLE_TASK_RETENTION_STATUSES] } };
  const withRetention = (where: Record<string, unknown>) => (
    retentionWhere ? { AND: [where, retentionWhere] } : where
  );

  if (user.role === 'admin' && includeAdminAll) {
    return withRetention(projectId ? { project_id: projectId } : {});
  }

  if (projectId) {
    await assertCanViewProject(user, projectId);
    return withRetention({ project_id: projectId });
  }

  const projectIds = await getAccessibleProjectIds(user, { includeAdminAll });
  return withRetention({
    OR: [
      { project_id: { in: projectIds } },
      { project_id: null, owner_user_id: user.id },
      { project_id: null, user_id: user.id },
    ],
  });
}

export function normalizeProjectRole(role: unknown): ProjectRole {
  if (role === 'viewer' || role === 'editor' || role === 'project_owner') return role;
  return 'member';
}
