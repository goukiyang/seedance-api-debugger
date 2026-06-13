import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { errorJson, getAdminUser } from '@/lib/auth/api-helpers';

const MAX_SOURCE_USERS = 20;

type ProjectMembership = {
  id: string;
  project_id: string;
  user_id: string;
  role: string;
  status: string;
  joined_at: Date;
};

type AlbumUserShare = {
  id: string;
  album_id: string;
  grantee_id: string;
  permissions_json: string;
  status: string;
  created_at: Date;
};

type MergeUserIdentity = {
  id: string;
  feishu_user_id: string | null;
  feishu_open_id: string | null;
  feishu_union_id: string | null;
  feishu_tenant_key: string | null;
  feishu_employee_no: string | null;
  feishu_department_ids: string | null;
  feishu_raw_profile: string | null;
  last_feishu_sync_at: Date | null;
  mobile: string | null;
  avatar_url: string | null;
};

function normalizeText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSourceIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())));
}

function roleRank(role: string) {
  if (role === 'project_owner') return 4;
  if (role === 'editor') return 3;
  if (role === 'member') return 2;
  if (role === 'viewer') return 1;
  return 0;
}

function statusRank(status: string) {
  return status === 'active' ? 2 : 1;
}

function pickBestMembership(items: ProjectMembership[]) {
  return items.reduce((best, item) => {
    if (statusRank(item.status) !== statusRank(best.status)) {
      return statusRank(item.status) > statusRank(best.status) ? item : best;
    }
    if (roleRank(item.role) !== roleRank(best.role)) {
      return roleRank(item.role) > roleRank(best.role) ? item : best;
    }
    return item.joined_at.getTime() < best.joined_at.getTime() ? item : best;
  });
}

function pickBestShare(items: AlbumUserShare[]) {
  return items.reduce((best, item) => {
    if (statusRank(item.status) !== statusRank(best.status)) {
      return statusRank(item.status) > statusRank(best.status) ? item : best;
    }
    return item.created_at.getTime() < best.created_at.getTime() ? item : best;
  });
}

function mergePermissionsJson(values: string[]) {
  const merged: Record<string, unknown> = {};
  let hasParsed = false;

  for (const value of values) {
    try {
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      hasParsed = true;
      for (const [key, raw] of Object.entries(parsed)) {
        if (raw === true) {
          merged[key] = true;
          continue;
        }
        if (!(key in merged)) merged[key] = raw;
      }
    } catch {
      // Invalid historical permissions stay untouched if nothing valid is available.
    }
  }

  return hasParsed ? JSON.stringify(merged) : values[0] || '{}';
}

function sum(items: Array<number | null | undefined>): number {
  return items.reduce<number>((total, item) => total + (Number(item ?? 0) || 0), 0);
}

function hasFeishuIdentity(user: MergeUserIdentity) {
  return Boolean(user.feishu_user_id || user.feishu_open_id || user.feishu_union_id || user.mobile);
}

function feishuIdentityScore(user: MergeUserIdentity) {
  return [
    user.last_feishu_sync_at?.getTime() || 0,
    user.feishu_user_id ? 1 : 0,
    user.feishu_open_id ? 1 : 0,
  ];
}

function pickPrimaryFeishuIdentity(users: MergeUserIdentity[]) {
  return users
    .filter(hasFeishuIdentity)
    .sort((left, right) => {
      const leftScore = feishuIdentityScore(left);
      const rightScore = feishuIdentityScore(right);
      for (let index = 0; index < leftScore.length; index += 1) {
        if (leftScore[index] !== rightScore[index]) return rightScore[index] - leftScore[index];
      }
      return 0;
    })[0] || null;
}

export async function POST(request: NextRequest) {
  let admin;
  try {
    admin = await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return errorJson('请求体格式不正确', 400);

  const targetUserId = normalizeText(body.target_user_id);
  const sourceUserIds = normalizeSourceIds(body.source_user_ids).filter((id) => id !== targetUserId);
  const reason = normalizeText(body.reason);
  const confirm = body.confirm === true;

  if (!confirm) return errorJson('请确认执行账号合并', 400);
  if (!targetUserId) return errorJson('请选择保留账号', 400);
  if (sourceUserIds.length === 0) return errorJson('请选择至少一个被合并账号', 400);
  if (sourceUserIds.length > MAX_SOURCE_USERS) return errorJson(`单次最多合并 ${MAX_SOURCE_USERS} 个账号`, 400);
  if (!reason) return errorJson('合并原因必填', 400);

  const [targetUser, sourceUsers] = await Promise.all([
    prisma.user.findUnique({ where: { id: targetUserId } }),
    prisma.user.findMany({ where: { id: { in: sourceUserIds } } }),
  ]);

  if (!targetUser || targetUser.status === 'deleted') return errorJson('保留账号不存在', 404);
  if (targetUser.status !== 'active') return errorJson('保留账号必须是启用状态', 400);
  if (sourceUsers.length !== sourceUserIds.length) return errorJson('被合并账号中存在无效账号', 404);
  const deletedSource = sourceUsers.find((user) => user.status === 'deleted');
  if (deletedSource) return errorJson(`被合并账号 ${deletedSource.username} 已删除`, 400);

  const adminSource = sourceUsers.find((user) => user.role === 'admin');
  if (adminSource) {
    return errorJson(`管理员账号 ${adminSource.username} 不能作为被合并账号，请把管理员账号设为保留账号`, 400);
  }

  const result = await prisma.$transaction(async (tx) => {
    const counts = {
      video_tasks: 0,
      owned_tasks: 0,
      projects_owned: 0,
      project_members_transferred: 0,
      project_members_merged: 0,
      canvas_documents: 0,
      reference_albums: 0,
      reference_images: 0,
      album_shares_transferred: 0,
      album_shares_merged: 0,
      provider_requests: 0,
      cost_ledgers: 0,
      cost_allocations: 0,
      feedbacks: 0,
      workspaces: 0,
      assets: 0,
      asset_collections: 0,
    };
    const primaryFeishuIdentity = pickPrimaryFeishuIdentity([targetUser, ...sourceUsers]);

    const targetAccount = await tx.creditAccount.upsert({
      where: { user_id: targetUserId },
      update: {},
      create: {
        user_id: targetUserId,
        balance: 0,
        frozen_credits: 0,
        monthly_used: 0,
        total_used: 0,
      },
    });
    const sourceAccounts = await tx.creditAccount.findMany({ where: { user_id: { in: sourceUserIds } } });
    const sourceBalance = sum(sourceAccounts.map((account) => account.balance));
    const sourceFrozen = sum(sourceAccounts.map((account) => account.frozen_credits));
    const sourceMonthlyUsed = sum(sourceAccounts.map((account) => account.monthly_used));
    const sourceTotalUsed = sum(sourceAccounts.map((account) => account.total_used));

    if (sourceBalance !== 0 || sourceFrozen !== 0 || sourceMonthlyUsed !== 0 || sourceTotalUsed !== 0) {
      await tx.creditAccount.update({
        where: { user_id: targetUserId },
        data: {
          balance: { increment: sourceBalance },
          frozen_credits: { increment: sourceFrozen },
          monthly_used: { increment: sourceMonthlyUsed },
          total_used: { increment: sourceTotalUsed },
        },
      });

      await tx.creditLedger.create({
        data: {
          user_id: targetUserId,
          type: 'account_merge_in',
          amount: sourceBalance,
          balance_before: targetAccount.balance,
          balance_after: targetAccount.balance + sourceBalance,
          frozen_before: targetAccount.frozen_credits,
          frozen_after: targetAccount.frozen_credits + sourceFrozen,
          operator_id: admin.id,
          reason,
        },
      });

      for (const account of sourceAccounts) {
        const accountBalance = Number(account.balance ?? 0) || 0;
        const accountFrozen = Number(account.frozen_credits ?? 0) || 0;
        const accountMonthlyUsed = Number(account.monthly_used ?? 0) || 0;
        const accountTotalUsed = Number(account.total_used ?? 0) || 0;
        if (accountBalance === 0 && accountFrozen === 0 && accountMonthlyUsed === 0 && accountTotalUsed === 0) continue;
        await tx.creditLedger.create({
          data: {
            user_id: account.user_id,
            type: 'account_merge_out',
            amount: -accountBalance,
            balance_before: accountBalance,
            balance_after: 0,
            frozen_before: accountFrozen,
            frozen_after: 0,
            operator_id: admin.id,
            reason: `合并到 ${targetUser.username}：${reason}`,
          },
        });
      }

      await tx.creditAccount.updateMany({
        where: { user_id: { in: sourceUserIds } },
        data: {
          balance: 0,
          frozen_credits: 0,
          monthly_used: 0,
          total_used: 0,
        },
      });
    }

    const sourceTasksWithKeys = await tx.videoTask.findMany({
      where: {
        user_id: { in: sourceUserIds },
        idempotency_key: { not: null },
      },
      select: { id: true, idempotency_key: true },
    });
    const sourceKeys = Array.from(new Set(sourceTasksWithKeys.map((task) => task.idempotency_key).filter((key): key is string => Boolean(key))));
    if (sourceKeys.length > 0) {
      const targetKeys = await tx.videoTask.findMany({
        where: {
          user_id: targetUserId,
          idempotency_key: { in: sourceKeys },
        },
        select: { idempotency_key: true },
      });
      const conflictingKeys = new Set(targetKeys.map((task) => task.idempotency_key).filter((key): key is string => Boolean(key)));
      const conflictingTaskIds = sourceTasksWithKeys
        .filter((task) => task.idempotency_key && conflictingKeys.has(task.idempotency_key))
        .map((task) => task.id);
      if (conflictingTaskIds.length > 0) {
        await tx.videoTask.updateMany({
          where: { id: { in: conflictingTaskIds } },
          data: { idempotency_key: null },
        });
      }
    }

    counts.video_tasks = (await tx.videoTask.updateMany({
      where: { user_id: { in: sourceUserIds } },
      data: { user_id: targetUserId },
    })).count;
    counts.owned_tasks = (await tx.videoTask.updateMany({
      where: { owner_user_id: { in: sourceUserIds } },
      data: { owner_user_id: targetUserId },
    })).count;
    counts.projects_owned = (await tx.project.updateMany({
      where: { owner_user_id: { in: sourceUserIds } },
      data: { owner_user_id: targetUserId },
    })).count;
    counts.canvas_documents = (await tx.canvasDocument.updateMany({
      where: { owner_user_id: { in: sourceUserIds } },
      data: { owner_user_id: targetUserId },
    })).count;
    counts.reference_albums = (await tx.referenceAlbum.updateMany({
      where: { owner_user_id: { in: sourceUserIds } },
      data: { owner_user_id: targetUserId },
    })).count;
    counts.reference_images = (await tx.referenceImage.updateMany({
      where: { owner_user_id: { in: sourceUserIds } },
      data: { owner_user_id: targetUserId },
    })).count;
    counts.provider_requests = (await tx.providerApiRequest.updateMany({
      where: { user_id: { in: sourceUserIds } },
      data: { user_id: targetUserId },
    })).count;
    counts.cost_ledgers = (await tx.costLedger.updateMany({
      where: { user_id: { in: sourceUserIds } },
      data: { user_id: targetUserId },
    })).count;
    counts.cost_allocations = (await tx.costAllocation.updateMany({
      where: { user_id: { in: sourceUserIds } },
      data: { user_id: targetUserId },
    })).count;
    await tx.costAllocation.updateMany({
      where: {
        allocation_type: 'user',
        allocation_id: { in: sourceUserIds },
      },
      data: { allocation_id: targetUserId },
    });
    counts.feedbacks = (await tx.feedback.updateMany({
      where: { user_id: { in: sourceUserIds } },
      data: { user_id: targetUserId },
    })).count;
    counts.workspaces = (await tx.workspace.updateMany({
      where: { owner_id: { in: sourceUserIds } },
      data: { owner_id: targetUserId },
    })).count;
    counts.assets = (await tx.asset.updateMany({
      where: { owner_id: { in: sourceUserIds } },
      data: { owner_id: targetUserId },
    })).count;
    counts.asset_collections = (await tx.assetCollection.updateMany({
      where: { owner_id: { in: sourceUserIds } },
      data: { owner_id: targetUserId },
    })).count;

    const memberships = await tx.projectMember.findMany({
      where: {
        user_id: { in: [targetUserId, ...sourceUserIds] },
      },
      select: {
        id: true,
        project_id: true,
        user_id: true,
        role: true,
        status: true,
        joined_at: true,
      },
    });
    const membershipsByProject = new Map<string, ProjectMembership[]>();
    for (const membership of memberships) {
      if (!membershipsByProject.has(membership.project_id)) membershipsByProject.set(membership.project_id, []);
      membershipsByProject.get(membership.project_id)?.push(membership);
    }

    for (const group of Array.from(membershipsByProject.values())) {
      const sourceMemberships = group.filter((membership) => sourceUserIds.includes(membership.user_id));
      if (sourceMemberships.length === 0) continue;
      const targetMembership = group.find((membership) => membership.user_id === targetUserId);
      const best = pickBestMembership(group);

      if (targetMembership) {
        if (targetMembership.role !== best.role || targetMembership.status !== best.status) {
          await tx.projectMember.update({
            where: { id: targetMembership.id },
            data: { role: best.role, status: best.status },
          });
        }
        await tx.projectMember.updateMany({
          where: { id: { in: sourceMemberships.map((membership) => membership.id) } },
          data: { status: 'removed' },
        });
        counts.project_members_merged += sourceMemberships.length;
        continue;
      }

      await tx.projectMember.update({
        where: { id: best.id },
        data: {
          user_id: targetUserId,
          role: best.role,
          status: best.status,
        },
      });
      counts.project_members_transferred += 1;

      const redundantIds = sourceMemberships.filter((membership) => membership.id !== best.id).map((membership) => membership.id);
      if (redundantIds.length > 0) {
        await tx.projectMember.updateMany({
          where: { id: { in: redundantIds } },
          data: { status: 'removed' },
        });
        counts.project_members_merged += redundantIds.length;
      }
    }

    const albumShares = await tx.albumShare.findMany({
      where: {
        grantee_type: 'user',
        grantee_id: { in: [targetUserId, ...sourceUserIds] },
      },
      select: {
        id: true,
        album_id: true,
        grantee_id: true,
        permissions_json: true,
        status: true,
        created_at: true,
      },
    });
    const sharesByAlbum = new Map<string, AlbumUserShare[]>();
    for (const share of albumShares) {
      if (!sharesByAlbum.has(share.album_id)) sharesByAlbum.set(share.album_id, []);
      sharesByAlbum.get(share.album_id)?.push(share);
    }

    for (const group of Array.from(sharesByAlbum.values())) {
      const sourceShares = group.filter((share) => sourceUserIds.includes(share.grantee_id));
      if (sourceShares.length === 0) continue;
      const targetShare = group.find((share) => share.grantee_id === targetUserId);
      const best = pickBestShare(group);
      const permissionsJson = mergePermissionsJson(group.map((share) => share.permissions_json));
      const nextStatus = group.some((share) => share.status === 'active') ? 'active' : best.status;

      if (targetShare) {
        await tx.albumShare.update({
          where: { id: targetShare.id },
          data: {
            permissions_json: permissionsJson,
            status: nextStatus,
          },
        });
        await tx.albumShare.updateMany({
          where: { id: { in: sourceShares.map((share) => share.id) } },
          data: { status: 'revoked' },
        });
        counts.album_shares_merged += sourceShares.length;
        continue;
      }

      await tx.albumShare.update({
        where: { id: best.id },
        data: {
          grantee_id: targetUserId,
          permissions_json: permissionsJson,
          status: nextStatus,
        },
      });
      counts.album_shares_transferred += 1;

      const redundantIds = sourceShares.filter((share) => share.id !== best.id).map((share) => share.id);
      if (redundantIds.length > 0) {
        await tx.albumShare.updateMany({
          where: { id: { in: redundantIds } },
          data: { status: 'revoked' },
        });
        counts.album_shares_merged += redundantIds.length;
      }
    }

    if (primaryFeishuIdentity) {
      await tx.user.updateMany({
        where: { id: { in: sourceUserIds } },
        data: {
          feishu_user_id: null,
          feishu_open_id: null,
          feishu_union_id: null,
          feishu_tenant_key: null,
          feishu_employee_no: null,
          feishu_department_ids: null,
          feishu_raw_profile: null,
          last_feishu_sync_at: null,
          mobile: null,
          avatar_url: null,
        },
      });

      await tx.user.update({
        where: { id: targetUserId },
        data: {
          feishu_user_id: primaryFeishuIdentity.feishu_user_id,
          feishu_open_id: primaryFeishuIdentity.feishu_open_id,
          feishu_union_id: primaryFeishuIdentity.feishu_union_id,
          feishu_tenant_key: primaryFeishuIdentity.feishu_tenant_key,
          feishu_employee_no: primaryFeishuIdentity.feishu_employee_no,
          feishu_department_ids: primaryFeishuIdentity.feishu_department_ids,
          feishu_raw_profile: primaryFeishuIdentity.feishu_raw_profile,
          last_feishu_sync_at: primaryFeishuIdentity.last_feishu_sync_at,
          mobile: primaryFeishuIdentity.mobile,
          avatar_url: primaryFeishuIdentity.avatar_url,
        },
      });
    }

    await tx.user.updateMany({
      where: { id: { in: sourceUserIds } },
      data: { status: 'deleted' },
    });

    await tx.operationLog.create({
      data: {
        operator_id: admin.id,
        action: 'merge_users',
        target_type: 'User',
        target_id: targetUserId,
        detail: JSON.stringify({
          reason,
          target_user: {
            id: targetUser.id,
            username: targetUser.username,
            email: targetUser.email,
            role: targetUser.role,
          },
          feishu_identity_transfer: primaryFeishuIdentity
            ? {
              from_user_id: primaryFeishuIdentity.id,
              to_user_id: targetUserId,
              source_users_cleared: sourceUserIds,
            }
            : null,
          source_users: sourceUsers.map((user) => ({
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role,
            previous_status: user.status,
          })),
          credit_transfer: {
            balance: sourceBalance,
            frozen_credits: sourceFrozen,
            monthly_used: sourceMonthlyUsed,
            total_used: sourceTotalUsed,
          },
          counts,
        }),
      },
    });

    return {
      source_count: sourceUserIds.length,
      target_user_id: targetUserId,
      credit_transfer: {
        balance: sourceBalance,
        frozen_credits: sourceFrozen,
        monthly_used: sourceMonthlyUsed,
        total_used: sourceTotalUsed,
      },
      counts,
    };
  });

  return NextResponse.json(result);
}
