import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { errorJson, getAdminUser } from '@/lib/auth/api-helpers';

type RouteContext = {
  params: {
    id: string;
  };
};

function normalizeText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeVisibility(value: unknown) {
  return ['private', 'specific_users', 'all_users', 'admin_only'].includes(String(value))
    ? String(value)
    : undefined;
}

function normalizeStatus(value: unknown) {
  return ['active', 'disabled'].includes(String(value)) ? String(value) : undefined;
}

function normalizeUserIds(value: unknown) {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)))
    : [];
}

const resourceInclude = {
  scoped_users: {
    select: {
      user_id: true,
      user: {
        select: {
          id: true,
          name: true,
          username: true,
          email: true,
          status: true,
        },
      },
    },
    orderBy: { created_at: 'asc' as const },
  },
} as const;

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  const resource = await prisma.sharedResource.findUnique({
    where: { id: context.params.id },
    include: resourceInclude,
  });

  if (!resource) return errorJson('资源不存在', 404);
  return NextResponse.json({ resource });
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  let admin;
  try {
    admin = await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  try {
    const existing = await prisma.sharedResource.findUnique({ where: { id: context.params.id } });
    if (!existing) return errorJson('资源不存在', 404);

    const body = await request.json();
    const name = normalizeText(body.name);
    const resourceType = normalizeText(body.resource_type || body.resourceType);
    const previewUrl = body.preview_url === null || body.previewUrl === null
      ? null
      : normalizeText(body.preview_url || body.previewUrl) || undefined;
    const description = body.description === null
      ? null
      : normalizeText(body.description) || undefined;
    const visibilityScope = normalizeVisibility(body.visibility_scope || body.visibilityScope);
    const status = normalizeStatus(body.status);
    const specificUserIds = visibilityScope === 'specific_users'
      ? normalizeUserIds(body.specific_user_ids || body.specificUserIds)
      : visibilityScope
        ? []
        : undefined;

    if (visibilityScope === 'specific_users' && (!specificUserIds || specificUserIds.length === 0)) {
      return errorJson('specific_users 可见范围至少选择一个用户', 400);
    }

    if (specificUserIds && specificUserIds.length > 0) {
      const users = await prisma.user.findMany({ where: { id: { in: specificUserIds } }, select: { id: true } });
      if (users.length !== specificUserIds.length) return errorJson('存在无效的用户范围配置', 400);
    }

    const updateData: Record<string, unknown> = {};
    if (name) updateData.name = name;
    if (resourceType) updateData.resource_type = resourceType;
    if (previewUrl !== undefined) updateData.preview_url = previewUrl;
    if (description !== undefined) updateData.description = description;
    if (visibilityScope) updateData.visibility_scope = visibilityScope;
    if (status) {
      updateData.status = status;
      updateData.disabled_at = status === 'disabled' ? new Date() : null;
    }

    const resource = await prisma.$transaction(async (tx) => {
      const updated = await tx.sharedResource.update({
        where: { id: context.params.id },
        data: updateData,
      });

      if (specificUserIds !== undefined) {
        await tx.sharedResourceUser.deleteMany({ where: { resource_id: updated.id } });
        if (specificUserIds.length > 0) {
          await tx.sharedResourceUser.createMany({
            data: specificUserIds.map((userId) => ({ resource_id: updated.id, user_id: userId })),
          });
        }
      }

      await tx.operationLog.create({
        data: {
          operator_id: admin.id,
          action: 'update_shared_resource',
          target_type: 'SharedResource',
          target_id: updated.id,
          detail: JSON.stringify({
            updated_fields: Object.keys(updateData),
            specific_user_ids: specificUserIds,
          }),
        },
      });

      return tx.sharedResource.findUnique({
        where: { id: updated.id },
        include: resourceInclude,
      });
    });

    return NextResponse.json({ resource });
  } catch (err) {
    console.error('[Admin/Resources PATCH]', err);
    return errorJson('服务器错误', 500);
  }
}
