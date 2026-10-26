import { createHash, randomBytes } from 'crypto';
import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';

export const API_SCOPES = ['models:read', 'assets:write', 'video:write', 'video:read', 'content:read', 'usage:read'] as const;
export type ApiScope = typeof API_SCOPES[number];
export type ApiTx = Prisma.TransactionClient;

export class CustomerApiError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

export function apiError(error: unknown) {
  const known = error instanceof CustomerApiError;
  return NextResponse.json({ error: {
    code: known ? error.code : 'SERVICE_UNAVAILABLE',
    message: known ? error.message : '服务暂不可用，请保留原请求号查询。',
  } }, { status: known ? error.status : 503, headers: {
    'Cache-Control': 'no-store', ...(known && error.status === 429 ? { 'Retry-After': '60' } : {}),
  } });
}

export function apiJson(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

export function stringList(value: string): string[] {
  try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) && parsed.every(v => typeof v === 'string') ? parsed : []; }
  catch { return []; }
}

export function digest(value: string) { return createHash('sha256').update(value).digest('hex'); }

export function newApiKey() {
  const token = `sd2_live_${randomBytes(32).toString('base64url')}`;
  return { token, digest: digest(token), prefix: token.slice(0, 17) };
}

async function loadContext(tx: ApiTx, keyId: string, scope: ApiScope) {
  const key = await tx.apiKey.findUnique({ where: { id: keyId }, include: { customer: { include: { user: true } } } });
  if (!key || !key.active || key.expires_at.getTime() <= Date.now()) throw new CustomerApiError('INVALID_KEY', 'Key 无效或已失效。', 401);
  if (!stringList(key.scopes_json).includes(scope)) throw new CustomerApiError('SCOPE_DENIED', 'Key 没有此操作权限。', 403);
  const customer = key.customer;
  const owner = customer.user;
  if (!customer.read_enabled || owner.status !== 'active' || owner.role !== 'user' || owner.account_type !== 'external'
    || (owner.expires_at && owner.expires_at.getTime() <= Date.now())) {
    throw new CustomerApiError('CUSTOMER_BLOCKED', '客户访问已停用。', 403);
  }
  const project = await tx.project.findUnique({ where: { id: customer.project_id } });
  const card = await tx.videoCard.findUnique({ where: { id: customer.video_card_id } });
  if (!project || project.owner_user_id !== owner.id || project.type !== 'personal' || project.visibility !== 'private'
    || !card || card.project_id !== project.id || card.owner_user_id !== owner.id) {
    throw new CustomerApiError('CUSTOMER_CONFIGURATION', '客户归属配置不可用。', 503);
  }
  const user: SessionUser = {
    id: owner.id, name: owner.name, username: owner.username, email: owner.email, role: 'user', account_type: 'external',
    user_profile: owner.user_profile, feature_profile_id: owner.feature_profile_id, status: 'active', expires_at: owner.expires_at,
  };
  return { key, customer, user };
}

export type ApiContext = Awaited<ReturnType<typeof loadContext>>;

export async function recheckApiContext(tx: ApiTx, context: ApiContext, scope: ApiScope) {
  const fresh = await loadContext(tx, context.key.id, scope);
  if (fresh.customer.id !== context.customer.id || fresh.user.id !== context.user.id) throw new CustomerApiError('INVALID_KEY', 'Key 归属已变化。', 401);
  return fresh;
}

export async function authenticateCustomerApi(request: Request, scope: ApiScope) {
  const url = new URL(request.url);
  if (['key', 'api_key', 'token', 'access_token'].some(k => url.searchParams.has(k))) throw new CustomerApiError('HEADER_REQUIRED', 'Key 仅允许放在 Authorization 请求头。', 400);
  const bearer = request.headers.get('authorization') || '';
  if (!/^Bearer sd2_live_[A-Za-z0-9_-]{43}$/.test(bearer)) throw new CustomerApiError('INVALID_KEY', '需要有效的 Bearer Key。', 401);
  const key = await prisma.apiKey.findUnique({ where: { digest: digest(bearer.slice(7)) }, select: { id: true } });
  if (!key) throw new CustomerApiError('INVALID_KEY', 'Key 无效或已失效。', 401);
  return prisma.$transaction(async tx => {
    // Acquire the SQLite writer before reading the window; all processes share this limit.
    await tx.apiKey.update({ where: { id: key.id }, data: { window_count: { increment: 0 } } });
    const context = await loadContext(tx, key.id, scope);
    const now = new Date();
    const sameWindow = context.key.window_start && now.getTime() - context.key.window_start.getTime() < 60_000;
    const count = sameWindow ? context.key.window_count : 0;
    if (context.key.requests_per_minute <= 0 || count >= context.key.requests_per_minute) throw new CustomerApiError('RATE_LIMIT', '请求过于频繁，请稍后继续查询原请求。', 429);
    await tx.apiKey.update({ where: { id: key.id }, data: { window_start: sameWindow ? context.key.window_start : now, window_count: count + 1, last_used_at: now } });
    return context;
  });
}

export function assertModel(context: ApiContext, model: string) {
  if (!stringList(context.customer.models_json).includes(model) || !stringList(context.key.models_json).includes(model)) {
    throw new CustomerApiError('MODEL_DENIED', '该型号未开放给此 Key。', 403);
  }
}

export async function assertNewAdmission(tx: ApiTx, context: ApiContext) {
  const global = await tx.apiConfiguration.findUnique({ where: { id: 'global' } });
  const c = context.customer;
  if (!global?.enabled || !global.license_confirmed || !c.create_enabled || !c.license_confirmed) throw new CustomerApiError('CREATION_DISABLED', '新请求暂未开放；已有任务仍可查询。', 403);
  if (![c.points_per_cny, c.max_task_points, c.daily_points, c.monthly_points, c.concurrency_limit, global.concurrency_limit]
    .every(v => typeof v === 'number' && Number.isFinite(v) && v > 0)
    || !c.storage_limit_bytes || c.storage_limit_bytes <= BigInt(0) || !c.upload_limit_bytes || c.upload_limit_bytes <= BigInt(0)
    || !global.storage_limit_bytes || global.storage_limit_bytes <= BigInt(0) || !global.max_output_bytes || global.max_output_bytes <= BigInt(0)
    || !c.retention_policy?.trim()) throw new CustomerApiError('CONFIGURATION_REQUIRED', '价格、额度或媒体保留规则尚未配置完整。', 503);
  return global;
}

export async function readJson(request: Request, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new CustomerApiError('INVALID_BODY', '需要 JSON 请求正文。');
  const reader = request.body?.getReader();
  if (!reader) throw new CustomerApiError('INVALID_BODY', '请求正文为空。');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new CustomerApiError('BODY_TOO_LARGE', '请求正文过大。', 413); } chunks.push(part.value); }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
    return parsed as Record<string, unknown>;
  } catch (error) { if (error instanceof CustomerApiError) throw error; throw new CustomerApiError('INVALID_BODY', 'JSON 请求正文无效。'); }
  finally { reader.releaseLock(); }
}

export function requestId(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) throw new CustomerApiError('REQUEST_ID_REQUIRED', '原请求号需为 8–128 位字母、数字或 . _ : -。');
  return value;
}
