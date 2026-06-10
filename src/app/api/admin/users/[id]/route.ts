import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { errorJson, getAdminUser } from '@/lib/auth/api-helpers';
import { hashPassword } from '@/lib/auth/password';
import type { SessionUser } from '@/lib/auth/session';
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

const EDITABLE_STATUSES = new Set(['active', 'disabled', 'pending', 'expired']);

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function hasOwn(body: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(body, key);
}

function parseExpiresAt(value: unknown): Date | null | 'invalid' {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return 'invalid';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T23:59:59.999+08:00`)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? 'invalid' : date;
}

function canUseAdminSession(user: { role: string; status: string; expires_at: Date | null }) {
  return user.role === 'admin'
    && user.status === 'active'
    && (!user.expires_at || user.expires_at.getTime() > Date.now());
}

function activeAdminWhere(excludeUserId?: string) {
  return {
    role: 'admin',
    status: 'active',
    id: excludeUserId ? { not: excludeUserId } : undefined,
    OR: [
      { expires_at: null },
      { expires_at: { gt: new Date() } },
    ],
  };
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
      feishu_user_id: true,
      feishu_open_id: true,
      feishu_union_id: true,
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
  const body = await request.json() as Record<string, unknown>;
  const name = normalizeText(body.name);
  const username = normalizeText(body.username);
  const email = normalizeText(body.email)?.toLowerCase();
  const password = typeof body.password === 'string' && body.password.length > 0 ? body.password : undefined;
  const role = body.role === 'admin' || body.role === 'user' ? body.role : undefined;
  const accountType = body.account_type === 'internal' || body.account_type === 'external' ? body.account_type : undefined;
  const status = typeof body.status === 'string' && EDITABLE_STATUSES.has(body.status) ? body.status : undefined;
  const userProfileWasProvided = body.user_profile !== undefined;
  const featureProfileWasProvided = body.feature_profile_id !== undefined;
  const expiresAtWasProvided = hasOwn(body, 'expires_at');
  const reason = normalizeText(body.reason);

  if (!reason) return errorJson('reason 为必填', 400);

  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) return errorJson('用户不存在', 404);
  if (existing.status === 'deleted') return errorJson('用户不存在', 404);

  const hasFeishuBinding = Boolean(existing.feishu_user_id || existing.feishu_open_id || existing.feishu_union_id);
  const requestedRole = role || existing.role;
  const requestedAccountType = accountType || (existing.account_type === 'external' ? 'external' : 'internal');
  if (requestedRole === 'admin' && requestedAccountType === 'external' && !hasFeishuBinding) {
    return errorJson('管理员必须是内部账号；请先改为普通用户再切换外部账号', 400);
  }
  const nextAccountType = requestedRole === 'admin' && hasFeishuBinding
    ? 'internal'
    : requestedAccountType;
  const accountTypeChanged = nextAccountType !== existing.account_type;
  const nextStatus = status || existing.status;
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
      || ((featureProfileWasProvided || accountType || accountTypeChanged || userProfileWasProvided)
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
  const nextRole = nextAccountType === 'external' ? 'user' : requestedRole;
  if (nextRole === 'admin' && nextAccountType !== 'internal') {
    return errorJson('管理员必须是内部账号', 400);
  }
  const parsedExpiresAt = expiresAtWasProvided ? parseExpiresAt(body.expires_at) : existing.expires_at;
  if (parsedExpiresAt === 'invalid') return errorJson('expires_at 格式不正确', 400);
  const nextExpiresAt = parsedExpiresAt;
  if (nextStatus === 'active' && nextExpiresAt && nextExpiresAt.getTime() <= Date.now()) {
    return errorJson('启用账号的过期时间必须晚于当前时间', 400);
  }

  const wasUsableAdmin = canUseAdminSession(existing);
  const willBeUsableAdmin = canUseAdminSession({
    role: nextRole,
    status: nextStatus,
    expires_at: nextExpiresAt,
  });
  if (wasUsableAdmin && !willBeUsableAdmin) {
    if (id === admin.id) return errorJson('不能让当前登录管理员失去后台访问权限', 400);
    const otherActiveAdminCount = await prisma.user.count({ where: activeAdminWhere(id) });
    if (otherActiveAdminCount <= 0) {
      return errorJson('不能移除最后一个可用管理员账号', 400);
    }
  }

  const updateData: Record<string, string | Date | null> = {};
  if (name) updateData.name = name;
  if (username) updateData.username = username;
  if (email) updateData.email = email;
  if (nextRole !== existing.role) updateData.role = nextRole;
  if (nextAccountType !== existing.account_type || accountType) updateData.account_type = nextAccountType;
  if (status) updateData.status = status;
  if (userProfileWasProvided || accountType || accountTypeChanged) updateData.user_profile = nextUserProfile;
  if (featureProfileWasProvided || accountType || accountTypeChanged || userProfileWasProvided) updateData.feature_profile_id = nextFeatureProfileId;
  if (expiresAtWasProvided) updateData.expires_at = nextExpiresAt;
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
        feishu_user_id: true,
        feishu_open_id: true,
        feishu_union_id: true,
        expires_at: true,
        created_at: true,
        updated_at: true,
      },
    });

    await tx.operationLog.create({
      data: {
        operator_id: admin.id,
        action: nextRole !== existing.role ? 'update_user_role' : 'update_user_account_attributes',
        target_type: 'User',
        target_id: id,
        detail: JSON.stringify({
          reason,
          updated_fields: Object.keys(updateData),
          before: {
            name: existing.name,
            username: existing.username,
            email: existing.email,
            role: existing.role,
            account_type: existing.account_type,
            user_profile: existing.user_profile,
            feature_profile_id: existing.feature_profile_id,
            status: existing.status,
            expires_at: existing.expires_at,
          },
          after: {
            name: user.name,
            username: user.username,
            email: user.email,
            role: user.role,
            account_type: user.account_type,
            user_profile: user.user_profile,
            feature_profile_id: user.feature_profile_id,
            status: user.status,
            expires_at: user.expires_at,
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

  if (canUseAdminSession(user)) {
    const otherActiveAdminCount = await prisma.user.count({ where: activeAdminWhere(id) });
    if (otherActiveAdminCount <= 0) {
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
