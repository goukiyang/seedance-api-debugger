import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { errorJson, getAdminUser } from '@/lib/auth/api-helpers';
import { hashPassword } from '@/lib/auth/password';
import type { SessionUser } from '@/lib/auth/session';

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
      status: true,
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

  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) return errorJson('用户不存在', 404);

  if (email && email !== existing.email) {
    const conflict = await prisma.user.findFirst({ where: { id: { not: id }, email } });
    if (conflict) return errorJson('邮箱已被占用', 409);
  }
  if (username && username !== existing.username) {
    const conflict = await prisma.user.findFirst({ where: { id: { not: id }, username } });
    if (conflict) return errorJson('用户名已被占用', 409);
  }

  const updateData: Record<string, string> = {};
  if (name) updateData.name = name;
  if (username) updateData.username = username;
  if (email) updateData.email = email;
  if (role) updateData.role = role;
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
        status: true,
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
        detail: JSON.stringify({ updated_fields: Object.keys(updateData) }),
      },
    });

    return user;
  });

  return NextResponse.json({ user: updated });
}
