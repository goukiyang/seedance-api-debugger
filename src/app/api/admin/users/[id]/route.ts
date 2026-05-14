import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { errorJson, getAdminUser } from '@/lib/auth/api-helpers';
import { hashPassword } from '@/lib/auth/password';
import type { SessionUser } from '@/lib/auth/session';
import { isCompanyEmail } from '@/lib/auth/registration/config';
import {
  getDefaultFeatureProfileId,
  normalizeFeatureProfileId,
  normalizeUserProfile,
} from '@/lib/users/profiles';

type RouteContext = {
  params: {
    id: string;
  };
};

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  const { id } = context.params;
  const user = await prisma.user.findUnique({
    where: { id },
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
      created_at: true,
      updated_at: true,
      last_login_at: true,
      credit_account: {
        select: {
          balance: true,
          frozen_credits: true,
          monthly_used: true,
          total_used: true,
        },
      },
      credit_ledger: {
        orderBy: { created_at: 'desc' },
        take: 20,
      },
    },
  });

  if (!user) return errorJson('用户不存在', 404);
  return NextResponse.json({ user });
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  let admin: SessionUser;
  try {
    admin = await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  const { id } = context.params;
  const body = await request.json();
  const name = normalizeText(body.name);
  const username = normalizeText(body.username);
  const email = normalizeText(body.email)?.toLowerCase();
  const password = typeof body.password === 'string' && body.password.length > 0 ? body.password : undefined;
  const role = body.role === 'admin' || body.role === 'user' ? body.role : undefined;
  const accountType = body.account_type === 'internal' || body.account_type === 'external' ? body.account_type : undefined;
  const userProfileWasProvided = body.user_profile !== undefined;
  const featureProfileWasProvided = body.feature_profile_id !== undefined;

  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) return errorJson('用户不存在', 404);
  if (existing.status === 'deleted') return errorJson('用户不存在', 404);

  const nextAccountType = accountType || (existing.account_type === 'external' ? 'external' : 'internal');
  const nextUserProfile = nextAccountType === 'external'
    ? 'other'
    : userProfileWasProvided
      ? normalizeUserProfile(body.user_profile)
      : normalizeUserProfile(existing.user_profile);
  const explicitFeatureProfileId = featureProfileWasProvided
    ? normalizeFeatureProfileId(body.feature_profile_id)
    : null;
  const nextFeatureProfileId = nextAccountType === 'external'
    ? 'external_limited'
    : explicitFeatureProfileId
      || ((featureProfileWasProvided || accountType || userProfileWasProvided)
        ? getDefaultFeatureProfileId(nextAccountType, nextUserProfile)
        : existing.feature_profile_id);

  if (email && email !== existing.email) {
    const conflict = await prisma.user.findFirst({ where: { id: { not: id }, email } });
    if (conflict) return errorJson('邮箱已被占用', 409);
  }
  if (username && username !== existing.username) {
    const conflict = await prisma.user.findFirst({ where: { id: { not: id }, username } });
    if (conflict) return errorJson('用户名已被占用', 409);
  }
  const nextEmail = email || existing.email;
  if (nextAccountType === 'internal' && !isCompanyEmail(nextEmail)) {
    return errorJson('内部账号必须使用 @youdoogo.com 公司邮箱', 400);
  }
  const nextRole = role || existing.role;
  if (nextRole === 'admin' && nextAccountType !== 'internal') {
    return errorJson('管理员必须是内部账号', 400);
  }
  if (role === 'user' && existing.role === 'admin') {
    if (id === admin.id) return errorJson('不能将当前登录管理员降级', 400);
    const activeAdminCount = await prisma.user.count({
      where: {
        role: 'admin',
        status: { notIn: ['deleted', 'disabled'] },
      },
    });
    if (activeAdminCount <= 1) {
      return errorJson('不能降级最后一个可用管理员账号', 400);
    }
  }

  const updateData: Record<string, string | Date | null> = {};
  if (name) updateData.name = name;
  if (username) updateData.username = username;
  if (email) updateData.email = email;
  if (role) updateData.role = role;
  if (accountType) updateData.account_type = accountType;
  if (userProfileWasProvided || accountType) updateData.user_profile = nextUserProfile;
  if (featureProfileWasProvided || accountType || userProfileWasProvided) updateData.feature_profile_id = nextFeatureProfileId;
  if (password) updateData.password_hash = hashPassword(password);

  if (Object.keys(updateData).length === 0) {
    return errorJson('没有可更新的字段', 400);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const user = await tx.user.update({
      where: { id },
      data: updateData,
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
        created_at: true,
        updated_at: true,
      },
    });

    await tx.operationLog.create({
      data: {
        operator_id: admin.id,
        action: 'update_user',
        target_type: 'User',
        target_id: id,
	        detail: JSON.stringify({
	          updated_fields: Object.keys(updateData),
	          before: {
	            role: existing.role,
	            account_type: existing.account_type,
	            user_profile: existing.user_profile,
	            feature_profile_id: existing.feature_profile_id,
	          },
	          after: {
	            role: user.role,
	            account_type: user.account_type,
	            user_profile: user.user_profile,
	            feature_profile_id: user.feature_profile_id,
	          },
	        }),
	      },
    });

    return user;
  });

  return NextResponse.json({ user: updated });
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  let admin: SessionUser;
  try {
    admin = await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  const { id } = context.params;
  if (id === admin.id) {
    return errorJson('不能删除当前登录的管理员账号', 400);
  }

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user || user.status === 'deleted') return errorJson('用户不存在', 404);

  if (user.role === 'admin') {
    const activeAdminCount = await prisma.user.count({
      where: {
        role: 'admin',
        status: { notIn: ['deleted', 'disabled'] },
      },
    });
    if (activeAdminCount <= 1) {
      return errorJson('不能删除最后一个可用管理员账号', 400);
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id },
      data: { status: 'deleted' },
    });

    await tx.operationLog.create({
      data: {
        operator_id: admin.id,
        action: 'delete_user',
        target_type: 'User',
        target_id: id,
        detail: JSON.stringify({
          username: user.username,
          email: user.email,
          role: user.role,
          previous_status: user.status,
          deletion_type: 'soft_delete',
        }),
      },
    });
  });

  return NextResponse.json({ ok: true });
}
