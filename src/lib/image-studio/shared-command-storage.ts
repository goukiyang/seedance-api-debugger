import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { SharedStudioIntent, SharedStudioReasonCode, SharedStudioSharingReceipt } from './shared-types';

type Client = Pick<Prisma.TransactionClient, 'platformSetting'>;
export class StudioSharingError extends Error {
  intent?: SharedStudioIntent;
  constructor(message: string, public status = 409, public reasonCode: SharedStudioReasonCode = 'state-conflict',
    public conflictScope?: 'workspace' | 'definition') { super(message); }
}
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export const sharedCommandFingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function requestKey(ownerId: string, requestId: unknown) {
  if (typeof requestId !== 'string' || !requestId || requestId.length > 160 || !/^[A-Za-z0-9:_-]+$/.test(requestId)) throw new StudioSharingError('请使用有效的保存请求编号', 400);
  return `studio_shared_request_v1:${sharedCommandFingerprint([ownerId, requestId])}`;
}
export async function readOwnedReceipt(client: Client, ownerId: string, requestId: unknown) {
  const row = await client.platformSetting.findUnique({ where: { key: requestKey(ownerId, requestId) }, select: { value_json: true } });
  if (!row) return null;
  let value: { ownerId?: unknown; fingerprint?: unknown; result?: unknown };
  try { value = JSON.parse(row.value_json); } catch { throw new StudioSharingError('原保存回执无法读取'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.ownerId !== ownerId || typeof value.fingerprint !== 'string'
    || !value.result || typeof value.result !== 'object' || Array.isArray(value.result)) {
    throw new StudioSharingError('原保存回执无法确认');
  }
  return { fingerprint: value.fingerprint, result: value.result as Record<string, unknown> };
}
export async function readReceipt(client: Client, ownerId: string, requestId: unknown, fingerprint: string) {
  const value = await readOwnedReceipt(client, ownerId, requestId);
  if (!value) return null;
  if (value.fingerprint !== fingerprint) throw new StudioSharingError('该请求编号已用于其他操作，请核对原保存结果');
  return value.result;
}
export async function writeReceipt(client: Client, ownerId: string, requestId: unknown, fingerprint: string, result: Record<string, unknown>) {
  // Keep the v1 key and envelope: a new command never upserts over an old receipt.
  await client.platformSetting.create({ data: { key: requestKey(ownerId, requestId), value_json: JSON.stringify({ ownerId, fingerprint, result }), updated_by: ownerId } });
}
export function parseStudioSharingReceipt(result: Record<string, unknown>): SharedStudioSharingReceipt {
  const applied = result.appliedState as Record<string, unknown> | null | undefined;
  if (result.action !== 'set-sharing' || typeof result.requestId !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(result.requestId)
    || typeof result.presetId !== 'string' || !result.presetId || result.presetId.length > 160
    || typeof result.expectedRevision !== 'string' || !result.expectedRevision
    || typeof result.appliedRevision !== 'string' || !result.appliedRevision
    || typeof result.committedAt !== 'string' || !result.committedAt || typeof result.noOp !== 'boolean'
    || !applied || typeof applied !== 'object' || Array.isArray(applied) || typeof applied.isShared !== 'boolean' || applied.lifecycle !== 'active'
    || result.moduleRevision !== null && (!Number.isSafeInteger(result.moduleRevision) || Number(result.moduleRevision) < 1)) {
    throw new StudioSharingError('原共享回执无法确认，请保留原请求编号继续查询', 409);
  }
  return { action: 'set-sharing', requestId: result.requestId, presetId: result.presetId,
    expectedRevision: result.expectedRevision, appliedRevision: result.appliedRevision, committedAt: result.committedAt,
    noOp: result.noOp, moduleRevision: result.moduleRevision as number | null,
    appliedState: { isShared: applied.isShared, lifecycle: 'active' } };
}
export function publicStudioReceipt(result: Record<string, unknown>) {
  const safe: Record<string, unknown> = {};
  for (const key of ['action', 'requestId', 'moduleId', 'presetId', 'expectedRevision', 'appliedRevision', 'committedAt', 'sourceRevision', 'definitionToken']) {
    if (typeof result[key] === 'string') safe[key] = result[key];
  }
  for (const key of ['revision', 'beforeRevision', 'moduleRevision', 'expectedRevision']) if (Number.isSafeInteger(result[key])) safe[key] = result[key];
  if (result.moduleRevision === null) safe.moduleRevision = null;
  if (typeof result.noOp === 'boolean') safe.noOp = result.noOp;
  const applied = result.appliedState as { isShared?: unknown; lifecycle?: unknown } | undefined;
  if (applied && typeof applied.isShared === 'boolean' && applied.lifecycle === 'active') safe.appliedState = { isShared: applied.isShared, lifecycle: 'active' };
  return safe;
}
