import { NextRequest, NextResponse } from 'next/server';
import { getSession } from './session';
import type { SessionUser } from './session';
import { AuthError } from './session';

export type AuthenticatedContext = {
  user: SessionUser;
};

export async function withAuth(_request?: NextRequest) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }
  return null;
}

export async function withAdmin(_request?: NextRequest) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }
  if (user.role !== 'admin') {
    return NextResponse.json({ error: '权限不足' }, { status: 403 });
  }
  return null;
}

export async function getAdminUser(_request?: NextRequest): Promise<SessionUser> {
  const user = await getSession();
  if (!user) throw new AuthError('未登录', 401);
  if (user.role !== 'admin') throw new AuthError('权限不足', 403);
  return user;
}

export async function getSessionUser(_request?: NextRequest): Promise<SessionUser> {
  const user = await getSession();
  if (!user) throw new AuthError('未登录', 401);
  return user;
}

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export function errorJson(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}
