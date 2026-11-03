import 'server-only';

import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { AuthError, getSession, type SessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { WorkError, type WorkOperationReceipt } from './types';
import { canUseWorksPreview } from './rollout.server';

export type WorkOperationValue = string | number | boolean | null | string[];
export type WorkOperationResult = Record<string, WorkOperationValue>;
export type WorkOperationRead = WorkOperationReceipt | {
  requestId: string;
  state: 'unknown';
  result: null;
};

const requestPattern = /^[A-Za-z0-9_-]{8,100}$/;

export function assertWorkRequestId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !requestPattern.test(value)) {
    throw new WorkError('原请求编号无效，请保留当前输入并刷新后重试', 400, 'WORK_REQUEST_ID_INVALID');
  }
}

export function assertWorkViewer(user: SessionUser, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value !== user.id) {
    throw new WorkError('账号已变化，请保留当前输入并重新读取', 409, 'WORK_VIEWER_CHANGED');
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  throw new WorkError('操作内容无效', 400, 'WORK_OPERATION_INVALID');
}

function validResult(value: unknown): value is WorkOperationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(item =>
    item === null || typeof item === 'string' || typeof item === 'boolean'
    || typeof item === 'number' && Number.isFinite(item)
    || Array.isArray(item) && item.every(entry => typeof entry === 'string'));
}

function parseResult(value: string): WorkOperationResult {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!validResult(parsed)) throw new Error('invalid result');
    return parsed;
  } catch {
    throw new WorkError('原请求回执暂时无法读取，请稍后重试', 503, 'WORK_RECEIPT_UNAVAILABLE');
  }
}

function parseDepartments(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch { return []; }
}

async function freshWorkActor(tx: Prisma.TransactionClient, userId: string): Promise<SessionUser> {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: {
      id: true, name: true, username: true, email: true, role: true, account_type: true,
      user_profile: true, feature_profile_id: true, status: true, expires_at: true,
      mobile: true, avatar_url: true, feishu_user_id: true, feishu_open_id: true,
      feishu_union_id: true, feishu_tenant_key: true, feishu_employee_no: true,
      feishu_department_ids: true, last_feishu_sync_at: true,
    },
  });
  if (!user || user.status !== 'active' || user.expires_at && user.expires_at <= new Date()) {
    throw new WorkError('账号暂不可用', 403, 'WORK_ACTOR_UNAVAILABLE');
  }
  if (!['admin', 'user'].includes(user.role) || !['internal', 'external'].includes(user.account_type)) {
    throw new WorkError('账号暂不可用', 403, 'WORK_ACTOR_UNAVAILABLE');
  }
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    email: user.email,
    role: user.role as SessionUser['role'],
    account_type: user.account_type as SessionUser['account_type'],
    user_profile: user.user_profile,
    feature_profile_id: user.feature_profile_id,
    status: user.status,
    expires_at: user.expires_at,
    mobile: user.mobile,
    avatar_url: user.avatar_url,
    feishu: {
      user_id: user.feishu_user_id,
      open_id: user.feishu_open_id,
      union_id: user.feishu_union_id,
      tenant_key: user.feishu_tenant_key,
      employee_no: user.feishu_employee_no,
      department_ids: parseDepartments(user.feishu_department_ids),
      last_sync_at: user.last_feishu_sync_at,
    },
  };
}

export async function runWorkOperation<T extends WorkOperationResult>(
  user: SessionUser,
  input: { viewerId: unknown; requestId: unknown; intent: unknown },
  mutate: (tx: Prisma.TransactionClient, actor: SessionUser) => Promise<T>,
): Promise<WorkOperationReceipt> {
  assertWorkViewer(user, input.viewerId);
  assertWorkRequestId(input.requestId);
  const requestId = input.requestId;
  const fingerprint = createHash('sha256').update(canonicalJson(input.intent)).digest('hex');
  return prisma.$transaction(async tx => {
    const actor = await freshWorkActor(tx, user.id);
    const previous = await tx.workOperation.findUnique({
      where: { owner_id_request_id: { owner_id: actor.id, request_id: requestId } },
    });
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw new WorkError('同一请求编号的操作内容不一致，请查询原请求结果', 409, 'WORK_OPERATION_CONFLICT');
      }
      return { requestId, state: 'committed' as const, result: parseResult(previous.result_json) };
    }
    const result = await mutate(tx, actor);
    if (!validResult(result)) throw new Error('Work operation result must contain only flags, IDs and versions');
    const resultJson = JSON.stringify(result);
    if (Buffer.byteLength(resultJson, 'utf8') > 16 * 1024) throw new Error('Work operation result is too large');
    await tx.workOperation.create({ data: {
      owner_id: actor.id,
      request_id: requestId,
      fingerprint,
      result_json: resultJson,
    } });
    return { requestId, state: 'committed' as const, result };
  }, { timeout: 15000 });
}

export async function readWorkOperation(user: SessionUser, requestIdValue: unknown): Promise<WorkOperationRead> {
  assertWorkRequestId(requestIdValue);
  const requestId = requestIdValue;
  return prisma.$transaction(async tx => {
    const actor = await freshWorkActor(tx, user.id);
    const operation = await tx.workOperation.findUnique({
      where: { owner_id_request_id: { owner_id: actor.id, request_id: requestId } },
      select: { result_json: true },
    });
    return operation
      ? { requestId, state: 'committed' as const, result: parseResult(operation.result_json) }
      : { requestId, state: 'unknown' as const, result: null };
  }, { timeout: 15000 });
}

export async function workApiUser(request: Request): Promise<SessionUser> {
  const user = await getSession();
  if (!user) throw new WorkError('请先登录', 401, 'WORK_AUTH_REQUIRED');
  if (!canUseWorksPreview(user)) throw new WorkError('页面暂不可用', 404, 'WORK_PREVIEW_UNAVAILABLE');
  const expectedUser = request.headers.get('x-app-session-user');
  if (expectedUser && expectedUser !== user.id) {
    throw new WorkError('账号已变化，请回原账号核对原操作', 409, 'WORK_VIEWER_CHANGED');
  }
  if (!['GET', 'HEAD'].includes(request.method)) {
    const origin = request.headers.get('origin');
    const host = request.headers.get('host');
    if (!origin || !host) throw new WorkError('请在本站操作', 403, 'WORK_ORIGIN_REQUIRED');
    try {
      if (new URL(origin).host !== host) throw new Error('origin mismatch');
    } catch { throw new WorkError('请在本站操作', 403, 'WORK_ORIGIN_INVALID'); }
    if (!request.headers.get('content-type')?.startsWith('application/json')) {
      throw new WorkError('请求格式无效', 415, 'WORK_JSON_REQUIRED');
    }
  }
  return user;
}

export async function workJsonBody(request: Request): Promise<Record<string, unknown>> {
  const value: unknown = await request.json();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkError('请求格式无效', 400, 'WORK_JSON_INVALID');
  }
  return value as Record<string, unknown>;
}

export const workJson = (data: unknown, status = 200) => NextResponse.json(data, {
  status,
  headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' },
});

export function workApiError(error: unknown, mode: 'mutation' | 'read' = 'mutation') {
  if (error instanceof WorkError) return workJson({ error: error.message, code: error.code }, error.status);
  if (error instanceof AuthError) return workJson({ error: error.message, code: 'WORK_ACCESS_DENIED' }, error.status);
  if (error instanceof SyntaxError) return workJson({ error: '请求格式无效', code: 'WORK_JSON_INVALID' }, 400);
  console.error('[works]', error instanceof Error ? error.name : 'unknown');
  if (mode === 'read') return workJson({ error: '作品暂时无法读取，请稍后重试', code: 'WORK_READ_UNAVAILABLE' }, 503);
  return workJson({ error: '作品操作结果暂时未知，请查询原请求回执', code: 'WORK_OPERATION_UNKNOWN' }, 503);
}
