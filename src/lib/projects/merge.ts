import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { recordTaskProjectTransfer } from '@/lib/costs/ledger';

type DbClient = typeof prisma | Prisma.TransactionClient;

type MergeProject = {
  id: string;
  name: string;
  type: string;
  status: string;
  owner_user_id: string;
  created_by: string;
};

export type ProjectMergeCounts = {
  tasks: number;
  video_cards: number;
  canvases: number;
  reference_albums: number;
  reference_images: number;
  provider_requests: number;
  approval_records: number;
  content_audit_logs: number;
  cost_ledgers: number;
  cost_allocations: number;
  members: number;
  budget_accounts: number;
  budget_ledgers: number;
};

export type ProjectMergePreviewItem = {
  project: MergeProject;
  counts: ProjectMergeCounts;
  is_empty: boolean;
  can_quick_delete: boolean;
  blockers: string[];
};

export type ProjectMergePreview = {
  target_project: MergeProject | null;
  source_projects: ProjectMergePreviewItem[];
  missing_source_project_ids: string[];
  blockers: string[];
  totals: ProjectMergeCounts & { projects: number };
};

export type ProjectMergeResult = {
  preview: ProjectMergePreview;
  counts: ProjectMergeCounts & {
    projects_archived: number;
    project_members_transferred: number;
    project_members_upgraded: number;
    project_members_kept: number;
    transfer_ledgers: number;
  };
};

const BLOCKED_SOURCE_TYPES = new Set(['personal', 'system']);
const ROLE_PRIORITY: Record<string, number> = {
  viewer: 1,
  member: 2,
  editor: 3,
  project_owner: 4,
};

function uniq(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function emptyCounts(): ProjectMergeCounts {
  return {
    tasks: 0,
    video_cards: 0,
    canvases: 0,
    reference_albums: 0,
    reference_images: 0,
    provider_requests: 0,
    approval_records: 0,
    content_audit_logs: 0,
    cost_ledgers: 0,
    cost_allocations: 0,
    members: 0,
    budget_accounts: 0,
    budget_ledgers: 0,
  };
}

function addCounts(left: ProjectMergeCounts, right: ProjectMergeCounts) {
  const next = { ...left };
  for (const key of Object.keys(next) as Array<keyof ProjectMergeCounts>) {
    next[key] += right[key];
  }
  return next;
}

function betterRole(currentRole: string, incomingRole: string) {
  const currentPriority = ROLE_PRIORITY[currentRole] || 0;
  const incomingPriority = ROLE_PRIORITY[incomingRole] || 0;
  return incomingPriority > currentPriority ? incomingRole : currentRole;
}

async function countProjectRelations(client: DbClient, projectId: string): Promise<ProjectMergeCounts> {
  const [
    tasks,
    videoCards,
    canvases,
    referenceAlbums,
    referenceImages,
    providerRequests,
    approvalRecords,
    contentAuditLogs,
    costLedgers,
    costAllocations,
    members,
    budgetAccounts,
    budgetLedgers,
  ] = await Promise.all([
    client.videoTask.count({ where: { project_id: projectId } }),
    client.videoCard.count({ where: { project_id: projectId } }),
    client.canvasDocument.count({ where: { project_id: projectId } }),
    client.referenceAlbum.count({ where: { project_id: projectId, status: { not: 'deleted' } } }),
    client.referenceImage.count({ where: { project_id: projectId } }),
    client.providerApiRequest.count({ where: { project_id: projectId } }),
    client.approvalRecord.count({ where: { project_id: projectId } }),
    client.contentAuditLog.count({ where: { project_id: projectId } }),
    client.costLedger.count({ where: { project_id: projectId } }),
    client.costAllocation.count({ where: { project_id: projectId } }),
    client.projectMember.count({ where: { project_id: projectId, status: 'active' } }),
    client.projectBudgetAccount.count({ where: { project_id: projectId } }),
    client.projectBudgetLedger.count({ where: { project_id: projectId } }),
  ]);

  return {
    tasks,
    video_cards: videoCards,
    canvases,
    reference_albums: referenceAlbums,
    reference_images: referenceImages,
    provider_requests: providerRequests,
    approval_records: approvalRecords,
    content_audit_logs: contentAuditLogs,
    cost_ledgers: costLedgers,
    cost_allocations: costAllocations,
    members,
    budget_accounts: budgetAccounts,
    budget_ledgers: budgetLedgers,
  };
}

function sourceBlockers(project: MergeProject, counts: ProjectMergeCounts, targetProjectId: string) {
  const blockers: string[] = [];
  if (project.id === targetProjectId) blockers.push('源项目不能包含目标项目');
  if (BLOCKED_SOURCE_TYPES.has(project.type)) blockers.push('默认项目或系统项目不能作为源项目');
  if (project.status === 'deleted') blockers.push('已删除项目不能合并');
  if (counts.budget_accounts > 0 || counts.budget_ledgers > 0) {
    blockers.push('项目预算账户暂不支持自动合并');
  }
  return blockers;
}

export async function previewProjectMerge(input: {
  sourceProjectIds: string[];
  targetProjectId: string;
  client?: DbClient;
}): Promise<ProjectMergePreview> {
  const client = input.client || prisma;
  const sourceProjectIds = uniq(input.sourceProjectIds).filter((id) => id !== input.targetProjectId);
  const targetProjectId = input.targetProjectId.trim();
  const blockers: string[] = [];

  if (!targetProjectId) blockers.push('请选择目标项目');
  if (sourceProjectIds.length === 0) blockers.push('请选择至少一个源项目');

  const [targetProject, sourceProjects] = await Promise.all([
    targetProjectId
      ? client.project.findUnique({
          where: { id: targetProjectId },
          select: { id: true, name: true, type: true, status: true, owner_user_id: true, created_by: true },
        })
      : null,
    sourceProjectIds.length > 0
      ? client.project.findMany({
          where: { id: { in: sourceProjectIds } },
          select: { id: true, name: true, type: true, status: true, owner_user_id: true, created_by: true },
          orderBy: { created_at: 'asc' },
        })
      : [],
  ]);

  if (!targetProject) blockers.push('目标项目不存在');
  if (targetProject?.status === 'deleted') blockers.push('目标项目已删除，不能合并进入');

  const sourceById = new Map(sourceProjects.map((project) => [project.id, project]));
  const missingSourceProjectIds = sourceProjectIds.filter((id) => !sourceById.has(id));
  if (missingSourceProjectIds.length > 0) blockers.push('源项目中存在无效项目');

  const sourceItems = await Promise.all(sourceProjects.map(async (project) => {
    const counts = await countProjectRelations(client, project.id);
    const itemBlockers = sourceBlockers(project, counts, targetProjectId);
    const isEmpty = counts.tasks === 0
      && counts.video_cards === 0
      && counts.canvases === 0
      && counts.reference_albums === 0
      && counts.reference_images === 0
      && counts.provider_requests === 0
      && counts.approval_records === 0
      && counts.content_audit_logs === 0
      && counts.cost_ledgers === 0
      && counts.cost_allocations === 0
      && counts.budget_accounts === 0
      && counts.budget_ledgers === 0;

    return {
      project,
      counts,
      is_empty: isEmpty,
      can_quick_delete: isEmpty && project.type === 'team' && project.status !== 'deleted',
      blockers: itemBlockers,
    };
  }));

  const totals = sourceItems.reduce(
    (acc, item) => addCounts(acc, item.counts),
    emptyCounts(),
  );
  const itemBlockers = sourceItems.flatMap((item) => item.blockers);

  return {
    target_project: targetProject,
    source_projects: sourceItems,
    missing_source_project_ids: missingSourceProjectIds,
    blockers: [...blockers, ...itemBlockers],
    totals: { ...totals, projects: sourceItems.length },
  };
}

export async function mergeProjects(input: {
  sourceProjectIds: string[];
  targetProjectId: string;
  actorUserId: string;
  reason: string;
}): Promise<ProjectMergeResult> {
  const sourceProjectIds = uniq(input.sourceProjectIds).filter((id) => id !== input.targetProjectId);
  const reason = input.reason.trim();
  if (!reason) throw new Error('合并原因必填');

  return prisma.$transaction(async (tx) => {
    const preview = await previewProjectMerge({
      sourceProjectIds,
      targetProjectId: input.targetProjectId,
      client: tx,
    });
    if (preview.blockers.length > 0) {
      throw new Error(preview.blockers[0]);
    }

    const sourceIds = preview.source_projects.map((item) => item.project.id);
    const counts = {
      ...emptyCounts(),
      projects_archived: 0,
      project_members_transferred: 0,
      project_members_upgraded: 0,
      project_members_kept: 0,
      transfer_ledgers: 0,
    };

    const tasks = await tx.videoTask.findMany({
      where: { project_id: { in: sourceIds } },
      select: {
        id: true,
        user_id: true,
        owner_user_id: true,
        project_id: true,
        provider: true,
        provider_task_id: true,
        provider_client_request_id: true,
        model: true,
        resolution: true,
        duration: true,
        estimated_cost: true,
        pricing_rule_id: true,
        pricing_snapshot: true,
        provider_official_amount_minor: true,
        provider_final_amount_minor: true,
        provider_cost_currency: true,
      },
    });

    const sourceMembers = await tx.projectMember.findMany({
      where: { project_id: { in: sourceIds }, status: 'active' },
      select: { user_id: true, role: true },
    });
    for (const member of sourceMembers) {
      const existing = await tx.projectMember.findUnique({
        where: {
          project_id_user_id: {
            project_id: input.targetProjectId,
            user_id: member.user_id,
          },
        },
      });
      if (!existing) {
        await tx.projectMember.create({
          data: {
            project_id: input.targetProjectId,
            user_id: member.user_id,
            role: member.role,
            status: 'active',
            joined_by: input.actorUserId,
          },
        });
        counts.project_members_transferred += 1;
      } else {
        const mergedRole = betterRole(existing.role, member.role);
        if (existing.status !== 'active' || mergedRole !== existing.role) {
          await tx.projectMember.update({
            where: { id: existing.id },
            data: { role: mergedRole, status: 'active' },
          });
          counts.project_members_upgraded += 1;
        } else {
          counts.project_members_kept += 1;
        }
      }
    }

    counts.tasks += (await tx.videoTask.updateMany({
      where: { project_id: { in: sourceIds } },
      data: { project_id: input.targetProjectId },
    })).count;
    counts.video_cards += (await tx.videoCard.updateMany({
      where: { project_id: { in: sourceIds } },
      data: { project_id: input.targetProjectId },
    })).count;
    counts.canvases += (await tx.canvasDocument.updateMany({
      where: { project_id: { in: sourceIds } },
      data: { project_id: input.targetProjectId },
    })).count;
    counts.reference_albums += (await tx.referenceAlbum.updateMany({
      where: { project_id: { in: sourceIds } },
      data: { project_id: input.targetProjectId },
    })).count;
    counts.reference_images += (await tx.referenceImage.updateMany({
      where: { project_id: { in: sourceIds } },
      data: { project_id: input.targetProjectId },
    })).count;
    counts.provider_requests += (await tx.providerApiRequest.updateMany({
      where: { project_id: { in: sourceIds } },
      data: { project_id: input.targetProjectId },
    })).count;
    counts.approval_records += (await tx.approvalRecord.updateMany({
      where: { project_id: { in: sourceIds } },
      data: { project_id: input.targetProjectId },
    })).count;
    counts.content_audit_logs += (await tx.contentAuditLog.updateMany({
      where: { project_id: { in: sourceIds } },
      data: { project_id: input.targetProjectId },
    })).count;
    counts.cost_ledgers += (await tx.costLedger.updateMany({
      where: { project_id: { in: sourceIds } },
      data: { project_id: input.targetProjectId },
    })).count;

    for (const sourceId of sourceIds) {
      counts.cost_allocations += (await tx.costAllocation.updateMany({
        where: { project_id: sourceId },
        data: { project_id: input.targetProjectId },
      })).count;
      await tx.costAllocation.updateMany({
        where: { allocation_type: 'project', allocation_id: sourceId },
        data: { allocation_id: input.targetProjectId },
      });
    }

    for (const task of tasks) {
      if (!task.project_id) continue;
      await recordTaskProjectTransfer(
        tx,
        task,
        task.project_id,
        input.targetProjectId,
        reason,
        input.actorUserId,
      );
      counts.transfer_ledgers += 1;
    }

    for (const item of preview.source_projects) {
      await tx.project.update({
        where: { id: item.project.id },
        data: {
          status: 'archived',
          archived_at: new Date(),
          description: [
            `已合并到 ${preview.target_project?.name || input.targetProjectId}`,
            `目标项目 ID：${input.targetProjectId}`,
            `原因：${reason}`,
          ].join('\n'),
        },
      });
      counts.projects_archived += 1;
    }

    await tx.operationLog.create({
      data: {
        operator_id: input.actorUserId,
        action: 'project_merge_apply',
        target_type: 'project',
        target_id: input.targetProjectId,
        detail: JSON.stringify({
          source_project_ids: sourceIds,
          target_project_id: input.targetProjectId,
          reason,
          counts,
        }),
      },
    });

    return { preview, counts };
  });
}
