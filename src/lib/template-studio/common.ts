import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import type { SessionUser } from '@/lib/auth/session';
import { getSessionUser } from '@/lib/auth/api-helpers';
import { StudioError, requireInternalStudioUser, studioErrorResponse } from './errors';
import { stableJson } from './validation';

export function requireStudioUser(user: SessionUser) {
  requireInternalStudioUser(user);
  if (user.status !== 'active') throw new StudioError('账号当前不可用', 403, 'FORBIDDEN');
}

export async function withStudioRoute(action: (user: SessionUser) => Promise<NextResponse>) {
  try {
    const user = await getSessionUser();
    requireStudioUser(user);
    return await action(user);
  } catch (error) {
    return studioErrorResponse(error);
  }
}

export async function readStudioJson(request: NextRequest) {
  try { return await request.json(); }
  catch { throw new StudioError('请求内容不是有效 JSON', 400, 'INVALID'); }
}

export function safeOwner(user: Pick<SessionUser, 'name' | 'username' | 'avatar_url'>) {
  return { displayName: user.name || user.username, avatarUrl: user.avatar_url || null };
}

export function makeFingerprint(value: unknown) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export function encodeCursor(value: string) {
  return Buffer.from(value).toString('base64url');
}

export function decodeCursor(value: string | undefined) {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    return decoded.length <= 512 ? decoded : null;
  } catch {
    return null;
  }
}

export function parseCursor(value: string | undefined) {
  const decoded = decodeCursor(value);
  if (!decoded) return null;
  const split = decoded.indexOf('|');
  if (split < 1) return null;
  const date = new Date(decoded.slice(0, split));
  const id = decoded.slice(split + 1);
  if (!Number.isFinite(date.getTime()) || !id || id.length > 200) return null;
  return { date, id };
}
