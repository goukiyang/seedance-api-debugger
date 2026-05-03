import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { errorJson, getAdminUser } from '@/lib/auth/api-helpers';

function normalizeText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeVisibility(value: unknown) {
  return ['private', 'specific_users', 'all_users', 'admin_only'].includes(String(value))
    ? String(value)
    : 'private';
}

function normalizeStatus(value: unknown) {
  return ['active', 'disabled'].includes(String(value)) ? String(value) : 'active';
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

export async function GET(request: NextRequest) {
  try {
    await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  const [resources, users] = await Promise.all([
    prisma.sharedResource.findMany({
      include: resourceInclude,
      orderBy: [{ status: 'asc' }, { updated_at: 'desc' }],
    }),
    prisma.user.findMany({
      where: { status: 'active' },
      select: { id: true, name: true, username: true, email: true, role: true },
      orderBy: [{ role: 'desc' }, { created_at: 'asc' }],
    }),
  ]);

  return NextResponse.json({ resources, users });
}

export async function POST(request: NextRequest) {
  let admin;
  try {
    admin = await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  try {
    const body = await request.json();
    const name = normalizeText(body.name);
    const resourceType = normalizeText(body.resource_type || body.resourceType);
    const previewUrl = normalizeText(body.preview_url || body.previewUrl) || null;
    const description = normalizeText(body.description) || null;
    const visibilityScope = normalizeVisibility(body.visibility_scope || body.visibilityScope);
    const status = normalizeStatus(body.status);
    const specificUserIds = visibilityScope === 'specific_users'
      ? normalizeUserIds(body.specific_user_ids || body.specificUserIds)
      : [];

    if (!name || !resourceType) {
      return errorJson('name 与 resource_type 为必填项', 400);
    }

    if (visibilityScope === 'specific_users' && specificUserIds.length === 0) {
      return errorJson('specific_users 可见范围至少选择一个用户', 400);
    }

    const users = specificUserIds.length > 0
      ? await prisma.user.findMany({ where: { id: { in: specificUserIds } }, select: { id: true } })
      : [];

    if (users.length !== specificUserIds.length) {
      return errorJson('存在无效的用户范围配置', 400);
    }

    const resource = await prisma.$transaction(async (tx) => {
      const created = await tx.sharedResource.create({
        data: {
          name,
          resource_type: resourceType,
          preview_url: previewUrl,
          description,
          visibility_scope: visibilityScope,
          status,
          disabled_at: status === 'disabled' ? new Date() : null,
          scoped_users: specificUserIds.length > 0
            ? {
                create: specificUserIds.map((userId) => ({ user_id: userId })),
              }
            : undefined,
        },
        include: resourceInclude,
      });

      await tx.operationLog.create({
        data: {
          operator_id: admin.id,
          action: 'create_shared_resource',
          target_type: 'SharedResource',
          target_id: created.id,
          detail: JSON.stringify({
            name,
            resource_type: resourceType,
            visibility_scope: visibilityScope,
            status,
            specific_user_ids: specificUserIds,
          }),
        },
      });

      return created;
    });

    return NextResponse.json({ resource }, { status: 201 });
  } catch (err) {
    console.error('[Admin/Resources POST]', err);
    return errorJson('服务器错误', 500);
  }
}
