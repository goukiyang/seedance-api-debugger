import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/session';
import type { SessionUser } from '@/lib/auth/session';
import type { Prisma } from '@prisma/client';
import { assertFeatureAllowed, isFeatureAllowed } from '@/lib/access/feature-guard';
import type { AccountScopedUser } from '@/lib/access/external-role';
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

export async function getProjectAccess(user: { id: string; role: string } & AccountScopedUser, projectId: string, db: Prisma.TransactionClient = prisma) {
  const project = await db.project.findUnique({
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

  const managementAllowed = isFeatureAllowed(user, 'team_project_manage');
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
  const canManageProject = managementAllowed && role === 'project_owner';
  const canManageMembers = managementAllowed && role === 'project_owner' && isSharableProjectType(project.type);
  const canManageAssets = isActiveNonSystem && (project.type === 'personal' || managementAllowed)
    && (role === 'project_owner' || role === 'editor');

  return { project, role, canView, canGenerate, canManageProject, canManageMembers, canManageAssets };
}

export async function assertCanViewProject(user: SessionUser, projectId: string, db: Prisma.TransactionClient = prisma) {
  const access = await getProjectAccess(user, projectId, db);
  if (!access.project) throw new AuthError('项目不存在', 404);
  if (!access.canView) throw new AuthError('无权查看此项目', 403);
  return access;
}

export async function assertCanManageProjectMembers(user: SessionUser, projectId: string, db: Prisma.TransactionClient = prisma) {
  assertFeatureAllowed(user, 'team_project_manage');
  const access = await getProjectAccess(user, projectId, db);
  if (!access.project) throw new AuthError('项目不存在', 404);
  if (!access.canManageMembers) throw new AuthError('无权管理此项目成员', 403);
  return access;
}

export async function assertCanManageProject(user: SessionUser, projectId: string, db: Prisma.TransactionClient = prisma) {
  assertFeatureAllowed(user, 'team_project_manage');
  const access = await getProjectAccess(user, projectId, db);
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

export async function assertCanGenerateInProject(user: SessionUser, projectId: string, db: Prisma.TransactionClient = prisma) {
  const access = await getProjectAccess(user, projectId, db);
  if (!access.project) throw new AuthError('项目不存在', 404);
  if (!access.canGenerate) throw new AuthError('无权在此项目中生成内容', 403);
  return access;
}

export async function getProjectForGeneration(user: SessionUser, requestedProjectId?: string | null) {
  const projectId = requestedProjectId || (await ensureDefaultProjectForUser(user.id)).id;
  const access = await assertCanGenerateInProject(user, projectId);
  return access.project;
}

// First user-initiated association only. Accepted work must finish against its frozen context.
export async function assertProjectActiveInTransaction(
  tx: Prisma.TransactionClient,
  user: { id: string; role: string } & AccountScopedUser,
  projectId: string | null | undefined,
  permission: 'generate' | 'assets' | 'manage' | 'members' | 'active' = 'generate',
) {
  if (!projectId) return null;
  const access = await getProjectAccess(user, projectId, tx);
  // 'active' is status-only for callers that separately prove their original sharing permission in this tx.
  const allowed = permission === 'active' ? true : permission === 'generate' ? access.canGenerate
    : permission === 'assets' ? access.canManageAssets
      : permission === 'members' ? access.canManageMembers : access.canManageProject;
  if (!access.project || access.project.status !== 'active' || access.project.type === 'system' || !allowed) {
    throw new AuthError('项目已不可用或无权执行此操作，当前输入已保留', 403);
  }
  return access;
}

export async function logProjectActionInTransaction(
  tx: Prisma.TransactionClient, actorUserId: string, action: string, targetType: string, targetId: string,
  detail?: Record<string, unknown>,
) {
  return tx.operationLog.create({ data: {
    operator_id: actorUserId, action, target_type: targetType, target_id: targetId,
    detail: detail ? JSON.stringify(detail) : null,
  } });
}

export async function getProjectActorInTransaction(tx: Prisma.TransactionClient, actorUserId: string) {
  const actor = await tx.user.findUnique({ where: { id: actorUserId }, select: {
    id: true, role: true, account_type: true, feature_profile_id: true, status: true, expires_at: true,
    feishu_user_id: true, feishu_open_id: true, feishu_union_id: true,
  } });
  if (!actor || actor.status !== 'active' || actor.expires_at && actor.expires_at.getTime() <= Date.now()) throw new AuthError('操作账号已不可用', 403);
  return { ...actor, feishu: { user_id: actor.feishu_user_id, open_id: actor.feishu_open_id, union_id: actor.feishu_union_id } };
}

export async function assertProjectActiveForActorInTransaction(
  tx: Prisma.TransactionClient, actorUserId: string, projectId: string,
  permission: 'generate' | 'assets' | 'manage' | 'members' = 'manage',
) {
  return assertProjectActiveInTransaction(tx, await getProjectActorInTransaction(tx, actorUserId), projectId, permission);
}

export function projectStatusVersion(project: { status: string; updated_at: Date }) {
  return { status: project.status, updated_at: project.updated_at.toISOString() };
}

export function projectListOperationProjection(
  project: { type: string; status: string; updated_at: Date },
  canManageProject: boolean,
  deletionBlockers: readonly string[] | null,
) {
  const canMutate = canManageProject && !['personal', 'system'].includes(project.type);
  return {
    status_version: projectStatusVersion(project),
    can_delete: canMutate && deletionBlockers !== null && deletionBlockers.length === 0,
    can_archive: canMutate && ['active', 'locked'].includes(project.status),
    can_restore: canMutate && project.status === 'archived',
  };
}

export async function readProjectOperationProjection(
  db: Prisma.TransactionClient,
  project: { id: string; type: string; status: string; updated_at: Date },
  canManageProject: boolean,
) {
  // This is a UI preview. The DELETE transaction rechecks the complete contract.
  // An interactive SQLite transaction here would acquire a writer lock for a read.
  const blockers = canManageProject && !['personal', 'system'].includes(project.type)
    ? await getProjectDeletionBlockers(db, project.id, { stopAfterFirst: true })
    : null;
  return projectListOperationProjection(project, canManageProject, blockers);
}

export class ProjectVersionConflictError extends AuthError {
  readonly details: { code: string; current: ReturnType<typeof projectStatusVersion> };
  constructor(project: { status: string; updated_at: Date }) {
    super('项目状态已变化，请核对后重新操作', 409);
    this.details = { code: 'PROJECT_STATE_CONFLICT', current: projectStatusVersion(project) };
  }
}

export async function compareAndSetProject(
  tx: Prisma.TransactionClient,
  project: { id: string; status: string; updated_at: Date },
  expected: { status: string; updated_at: Date },
  data: Prisma.ProjectUpdateManyMutationInput,
) {
  if (project.status !== expected.status || project.updated_at.getTime() !== expected.updated_at.getTime()) throw new ProjectVersionConflictError(project);
  const changed = await tx.project.updateMany({ where: { id: project.id, ...expected },
    data: { ...data, updated_at: new Date(Math.max(Date.now(), project.updated_at.getTime() + 1)) } });
  if (changed.count !== 1) throw new ProjectVersionConflictError(project);
}

export async function getProjectDeletionBlockers(
  tx: Prisma.TransactionClient,
  projectId: string,
  options: { stopAfterFirst?: boolean } = {},
) {
  const blockers: string[] = [];
  const project = await tx.project.findUnique({ where: { id: projectId }, select: { type: true, status: true } });
  if (!project || !['team', 'public'].includes(project.type)) blockers.push('项目类型待核对');
  if (!project || !['active', 'locked', 'archived'].includes(project.status)) blockers.push('项目状态待核对');
  if (options.stopAfterFirst && blockers.length) return blockers;
  const checks = [
    ['视频卡', () => tx.videoCard.count({ where: { project_id: projectId } })],
    ['生成任务', () => tx.videoTask.count({ where: { project_id: projectId } })],
    ['画布文档', () => tx.canvasDocument.count({ where: { project_id: projectId } })],
    ['图集历史', () => tx.referenceAlbum.count({ where: { project_id: projectId } })],
    ['参考图片', () => tx.referenceImage.count({ where: { OR: [{ project_id: projectId }, { album: { project_id: projectId } }] } })],
    ['接口请求', () => tx.providerApiRequest.count({ where: { project_id: projectId } })],
    ['费用记录', () => tx.costLedger.count({ where: { project_id: projectId } })],
    ['费用分摊', () => tx.costAllocation.count({ where: { project_id: projectId } })],
    ['预算流水', () => tx.projectBudgetLedger.count({ where: { project_id: projectId } })],
    ['审批历史', () => tx.approvalRecord.count({ where: { project_id: projectId } })],
    ['内容审核历史', () => tx.contentAuditLog.count({ where: { project_id: projectId } })],
    ['飞书需求', () => tx.feishuRequirement.count({ where: { created_project_id: projectId } })],
    ['审片记录', () => tx.reviewCard.count({ where: { project_id: projectId } })],
    ['业务通知', () => tx.notification.count({ where: { project_id: projectId } })],
    ['工具流', () => tx.toolFlow.count({ where: { project_id: projectId } })],
    ['已使用邀请', () => tx.projectInvite.count({ where: { project_id: projectId, used_count: { gt: 0 } } })],
    ['成员退出或未知角色历史', () => tx.projectMember.count({ where: { project_id: projectId,
      OR: [{ status: { not: 'active' } }, { role: { notIn: ['project_owner', 'editor', 'member', 'viewer'] } }] } })],
  ] as const;
  for (const [label, count] of checks) {
    if (await count() > 0) {
      blockers.push(label);
      if (options.stopAfterFirst) return blockers;
    }
  }
  const usage = await tx.$queryRaw<Array<{ found: number }>>`SELECT 1 AS found FROM "UsageAttribution" WHERE "project_id" = ${projectId} LIMIT 1`;
  if (usage.length) blockers.push('使用历史');
  if (options.stopAfterFirst && blockers.length) return blockers;
  const priorFlowRuns = await tx.$queryRaw<Array<{ found: number }>>`SELECT 1 AS found FROM "ToolFlowRun"
    WHERE CASE WHEN json_valid("snapshot_json") THEN json_extract("snapshot_json", '$.project_id') ELSE NULL END = ${projectId} LIMIT 1`;
  if (priorFlowRuns.length) blockers.push('工具流运行历史');
  if (options.stopAfterFirst && blockers.length) return blockers;
  const account = await tx.projectBudgetAccount.findUnique({ where: { project_id: projectId } });
  if (account && (account.budget_credits !== 0 || account.used_credits !== 0 || account.frozen_credits !== 0
    || account.status !== 'active' || account.currency !== 'credits' || account.reconciliation_status !== 'normal' || account.freeze_reason
    || account.threshold_notified_json && account.threshold_notified_json !== '[]'
    || await tx.projectBudgetLedger.count({ where: { account_id: account.id } }) > 0)) blockers.push('预算或冻结账户');
  if (options.stopAfterFirst && blockers.length) return blockers;
  const logs = await tx.operationLog.findMany({ where: { target_type: 'project', target_id: projectId }, select: { action: true, detail: true } });
  for (const log of logs) {
    if (['project_create', 'project_create_default', 'project_invite_create', 'project_update', 'project_archive', 'project_restore'].includes(log.action)) continue;
    if (log.action === 'project_member_join') {
      try { if (JSON.parse(log.detail || '{}').source === 'create_project') continue; } catch { /* Unknown history blocks deletion. */ }
    }
    blockers.push('协作或管理历史');
    break;
  }
  return blockers;
}

export async function assertCanViewTask(user: SessionUser, task: {
  id: string;
  project_id: string | null;
  owner_user_id?: string | null;
  user_id?: string | null;
  retention_status?: string | null;
}, db: Prisma.TransactionClient = prisma) {
  if (user.role === 'admin') return;

  if (isTaskHiddenFromRegularUsers(task)) {
    throw new AuthError('任务不存在或已删除', 404);
  }

  if (task.project_id) {
    await assertCanViewProject(user, task.project_id, db);
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
