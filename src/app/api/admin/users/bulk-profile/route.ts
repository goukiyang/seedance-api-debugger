import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getAdminUser, errorJson } from '@/lib/auth/api-helpers';
import type { SessionUser } from '@/lib/auth/session';
import {
  getDefaultFeatureProfileId,
  normalizeFeatureProfileId,
  normalizeUserProfile,
} from '@/lib/users/profiles';

const MAX_BULK_USERS = 200;

function normalizeUserIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];

  for (const item of input) {
    const id = typeof item === 'string' ? item.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  return ids;
}

export async function POST(request: NextRequest) {
  let admin: SessionUser;
  try {
    admin = await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  try {
    const body = await request.json();
    const userIds = normalizeUserIds(body.user_ids ?? body.userIds);
    const userProfile = normalizeUserProfile(body.user_profile);
    const explicitFeatureProfileId = normalizeFeatureProfileId(body.feature_profile_id);
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    const confirmed = body.confirm === true || body.confirmed === true;

    if (userIds.length === 0) return errorJson('请选择至少一个用户', 400);
    if (userIds.length > MAX_BULK_USERS) return errorJson(`单次最多修改 ${MAX_BULK_USERS} 个用户`, 400);
    if (!reason) return errorJson('reason 为必填', 400);
    if (!confirmed) return errorJson('批量修改需要二次确认', 400);

    const users = await prisma.user.findMany({
      where: { id: { in: userIds }, status: { not: 'deleted' } },
      select: {
        id: true,
        username: true,
        account_type: true,
        user_profile: true,
        feature_profile_id: true,
      },
    });
    if (users.length !== userIds.length) {
      const found = new Set(users.map((user) => user.id));
      const missing = userIds.filter((id) => !found.has(id));
      return errorJson(`用户不存在或已删除：${missing.join(', ')}`, 404);
    }

    const results = await prisma.$transaction(async (tx) => {
      const updatedUsers = [];

      for (const user of users) {
        const accountType = user.account_type === 'external' ? 'external' : 'internal';
        const nextUserProfile = accountType === 'external' ? 'other' : userProfile;
        const nextFeatureProfileId = accountType === 'external'
          ? 'external_limited'
          : explicitFeatureProfileId || getDefaultFeatureProfileId(accountType, nextUserProfile);

        const updated = await tx.user.update({
          where: { id: user.id },
          data: {
            user_profile: nextUserProfile,
            feature_profile_id: nextFeatureProfileId,
          },
          select: {
            id: true,
            user_profile: true,
            feature_profile_id: true,
          },
        });

        await tx.operationLog.create({
          data: {
            operator_id: admin.id,
            action: 'bulk_update_user_profile',
            target_type: 'User',
            target_id: user.id,
            detail: JSON.stringify({
              reason,
              before: {
                user_profile: user.user_profile,
                feature_profile_id: user.feature_profile_id,
              },
              after: {
                user_profile: updated.user_profile,
                feature_profile_id: updated.feature_profile_id,
              },
              batch_size: userIds.length,
            }),
          },
        });

        updatedUsers.push(updated);
      }

      await tx.operationLog.create({
        data: {
          operator_id: admin.id,
          action: 'bulk_update_user_profile_batch',
          target_type: 'User',
          target_id: admin.id,
          detail: JSON.stringify({
            reason,
            user_ids: userIds,
            count: userIds.length,
            requested_user_profile: userProfile,
            requested_feature_profile_id: explicitFeatureProfileId || 'auto',
          }),
        },
      });

      return updatedUsers;
    });

    return NextResponse.json({ ok: true, count: results.length, users: results });
  } catch (err) {
    if (err instanceof Error) return errorJson(err.message, 400);
    console.error('[Admin/Users/BulkProfile]', err);
    return errorJson('服务器错误', 500);
  }
}
