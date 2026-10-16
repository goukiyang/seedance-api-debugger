import { createHash, randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/session';
import { parseMultiviewGenerationSnapshot } from './multiview-generation-contract';

type Db = Prisma.TransactionClient;
type Identity = { ownerId: string; key: string };
type StoredReceipt = Identity & {
  version: 1; state: 'pending' | 'accepted' | 'rejected' | 'closed'; nonce: string; fingerprint: string | null;
  createdAt: string; taskId?: string; status?: number; code?: string; message?: string; rejectedAt?: string; closedAt?: string;
};
export type MultiviewRequestClaim = Identity & { nonce: string; fingerprint: string };
export type MultiviewRejectedReceipt = {
  version: 1; key: string; state: 'rejected'; accepted: false; code: string; message: string; rejectedAt: string;
};
export type MultiviewClosedReceipt = {
  version: 1; key: string; state: 'closed'; accepted: false;
  code: 'MULTIVIEW_REQUEST_CLOSED_BEFORE_ACCEPTANCE'; message: string; closedAt: string;
};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const receiptKey = ({ ownerId, key }: Identity) => `multiview_request_v1:${digest(ownerId)}:${digest(key)}`;
const unavailable = () => new AuthError('原提交结果暂时无法核对，请保留原请求号，不要重新提交。', 503);
const safeReasons: Record<string, string> = {
  REFERENCE_IMAGE_PREP_FAILED: '主图暂时无法处理，请检查原图后再生成。',
  REFERENCE_IMAGE_NOT_PUBLIC: '主图暂时无法提供给生成服务，请检查原图的可用状态。',
  REFERENCE_IMAGE_TOO_LARGE: '主图尺寸过大且本次处理未完成，请调整原图后再生成。',
  REFERENCE_IMAGE_NOT_IN_WORKSPACE: '主图尚未关联到当前工作区，请重新核对主图。',
  REFERENCE_MEDIA_TOO_SMALL: '主图像素不足，请选择更清晰的原图。',
  REFERENCE_MEDIA_ASPECT_RATIO_UNSUPPORTED: '主图比例不符合生成服务要求，请调整主图比例。',
  PROMPT_REFERENCE_ERROR: '主图引用暂时无法确认，请核对主图与当前工作区。',
  INSUFFICIENT_CREDITS: '本次可用点数不足，请核对额度后再生成。',
  INSUFFICIENT_PROJECT_BUDGET: '项目可用预算不足，请核对项目预算后再生成。',
};
const safeLiteralReasons = new Set([
  '请先明确保存到的项目', '项目不存在', '无权在此项目中生成内容', '视频卡不存在', '视频卡不属于当前项目',
  '视频卡已封板或归档，不能继续生成', '无权查看此视频卡',
  '多角度旋转预设版本或主图记录无效，已有输入保留',
  '多角度生成设置与原文案、归属或报价不一致，未提交生成',
  '多角度生成必须且只能使用当前明确选择的一张主图',
  '多角度旋转请求不能混入其他素材、模板运行记录或角色工作流',
  '3D多视图旋转预设版本或主图记录无效，已有输入保留',
  '3D多视图生成设置与原文案、归属或报价不一致，未提交生成',
  '3D多视图生成必须且只能使用当前明确选择的一张主图',
  '3D多视图旋转请求不能混入其他素材、模板运行记录或角色工作流',
  '3D多视图生成归属与当前有权使用的项目或视频卡不一致，未提交生成',
  '非个人项目的 1080p 生成必须选择视频卡，并通过该视频卡的基准任务审批',
  '1080p 生成需要先确认审批通过',
]);
function publicReason(value: unknown) {
  const body = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const code = typeof body.error === 'string' && safeReasons[body.error] ? body.error
    : typeof body.code === 'string' && safeReasons[body.code] ? body.code : 'MULTIVIEW_REQUEST_REJECTED';
  const literal = typeof body.error === 'string' && safeLiteralReasons.has(body.error) ? body.error : null;
  return { code, message: safeReasons[code] || literal || '本次提交未被受理，请核对主图、项目和生成设置。原输入已保留。' };
}
function parseStored(raw: string, identity: Identity): StoredReceipt {
  let value: StoredReceipt;
  try { value = JSON.parse(raw); } catch { throw unavailable(); }
  if (!value || value.version !== 1 || value.ownerId !== identity.ownerId || value.key !== identity.key
    || !['pending', 'accepted', 'rejected', 'closed'].includes(value.state) || !/^[a-f0-9]{48}$/.test(value.nonce)
    || value.fingerprint !== null && !/^[a-f0-9]{64}$/.test(value.fingerprint)
    || !Number.isFinite(Date.parse(value.createdAt))
    || value.state === 'accepted' && (typeof value.taskId !== 'string' || !value.taskId)
    || value.state === 'rejected' && (typeof value.code !== 'string' || typeof value.message !== 'string'
      || value.code.length > 100 || value.message.length > 1024 || !value.rejectedAt || !Number.isFinite(Date.parse(value.rejectedAt)))
    || value.state === 'closed' && (value.code !== 'MULTIVIEW_REQUEST_CLOSED_BEFORE_ACCEPTANCE' || typeof value.message !== 'string'
      || !value.closedAt || !Number.isFinite(Date.parse(value.closedAt)))) throw unavailable();
  return value;
}
async function readStored(db: Db, identity: Identity) {
  const row = await db.platformSetting.findUnique({ where: { key: receiptKey(identity) }, select: { value_json: true } });
  return row ? { raw: row.value_json, value: parseStored(row.value_json, identity) } : null;
}
export function rejectedReceipt(value: StoredReceipt): MultiviewRejectedReceipt | null {
  if (value.state !== 'rejected') return null;
  return { version: 1, key: value.key, state: 'rejected', accepted: false,
    code: value.code!, message: value.message!, rejectedAt: value.rejectedAt! };
}
function terminalReceipt(value: StoredReceipt): MultiviewRejectedReceipt | MultiviewClosedReceipt | null {
  if (value.state !== 'closed') return rejectedReceipt(value);
  return { version: 1, key: value.key, state: 'closed', accepted: false,
    code: 'MULTIVIEW_REQUEST_CLOSED_BEFORE_ACCEPTANCE', message: value.message!, closedAt: value.closedAt! };
}
export async function readMultiviewRequestReceipt(ownerId: string, key: string) {
  const found = await readStored(prisma, { ownerId, key });
  return found ? { state: found.value.state, receipt: terminalReceipt(found.value) } : null;
}
export function multiviewRequestIntent(body: Record<string, unknown>, tabId: string | null) {
  const snapshot = parseMultiviewGenerationSnapshot(body?.multiview_generation);
  const source = body?.source_metadata as Record<string, unknown> | undefined;
  return snapshot && body.client_name === 'multiview' && source?.source === 'multiview' && source?.mode === 'rotation'
    && tabId === snapshot.workspaceTabId && typeof body.idempotency_key === 'string'
    && /^[A-Za-z0-9_-]{1,200}$/.test(body.idempotency_key) ? body.idempotency_key : null;
}
export async function claimMultiviewRequest(ownerId: string, key: string, body: unknown): Promise<
  { kind: 'claimed'; claim: MultiviewRequestClaim } | { kind: 'task_exists' }
  | { kind: 'blocked'; receipt: MultiviewRejectedReceipt | MultiviewClosedReceipt | null; status: number }
> {
  const identity = { ownerId, key }, fingerprint = digest(JSON.stringify(body));
  const inspect = async (db: Db) => {
    const task = await db.videoTask.findUnique({ where: { user_id_idempotency_key: { user_id: ownerId, idempotency_key: key } }, select: { id: true } });
    if (task) return { kind: 'task_exists' as const };
    const previous = await readStored(db, identity);
    if (!previous) return null;
    return { kind: 'blocked' as const,
      receipt: previous.value.fingerprint === fingerprint || previous.value.fingerprint === null ? terminalReceipt(previous.value) : null,
      status: previous.value.state === 'rejected' ? previous.value.status || 409 : 409 };
  };
  try {
    return await prisma.$transaction(async db => {
      const previous = await inspect(db); if (previous) return previous;
      const claim = { ...identity, fingerprint, nonce: randomBytes(24).toString('hex') };
      const value: StoredReceipt = { ...claim, version: 1, state: 'pending', createdAt: new Date().toISOString() };
      await db.platformSetting.create({ data: { key: receiptKey(identity), value_json: JSON.stringify(value), updated_by: ownerId } });
      return { kind: 'claimed' as const, claim };
    });
  } catch (error) {
    if (!['P2002', 'P2034', 'P1008', 'P2028'].includes(String((error as { code?: string }).code))) throw error;
    const previous = await inspect(prisma); if (previous) return previous;
    throw unavailable();
  }
}
/** Every VideoTask writer calls this inside its creation transaction. No lease or timeout recovery. */
export async function assertMultiviewRequestFence(db: Db, ownerId: string, key?: string | null, claim?: MultiviewRequestClaim | null) {
  if (!key) return;
  const found = await readStored(db, { ownerId, key });
  if (!found) { if (claim) throw unavailable(); return; }
  if (!claim || found.value.state !== 'pending' || found.value.nonce !== claim.nonce || found.value.fingerprint !== claim.fingerprint) {
    throw new AuthError('此请求号已有提交记录或已结束，请查询原请求，不会再次受理。', 409);
  }
}
export async function acceptMultiviewRequest(db: Db, claim: MultiviewRequestClaim | null, taskId: string) {
  if (!claim) return;
  const found = await readStored(db, claim);
  await assertMultiviewRequestFence(db, claim.ownerId, claim.key, claim);
  if (!found) throw unavailable();
  const next: StoredReceipt = { ...found.value, state: 'accepted', taskId };
  const changed = await db.platformSetting.updateMany({ where: { key: receiptKey(claim), value_json: found.raw }, data: { value_json: JSON.stringify(next), updated_by: claim.ownerId } });
  if (changed.count !== 1) throw unavailable();
}
async function acceptanceEvidence(db: Db, identity: Identity) {
  const where = { user_id: identity.ownerId, idempotency_key: identity.key };
  const task = await db.videoTask.findUnique({ where: { user_id_idempotency_key: where }, select: { id: true } });
  if (task) return true;
  // These survive normal task soft deletion and independently rule out a recorded outbound request.
  if (await db.providerApiRequest.findFirst({ where, select: { id: true } })) return true;
  if (await db.creditLedger.findFirst({ where: { user_id: identity.ownerId, OR: [{ idempotency_key: identity.key }, { metadata_json: { contains: identity.key } }] }, select: { id: true } })) return true;
  if (await db.projectBudgetLedger.findFirst({ where: { operator_id: identity.ownerId, OR: [{ idempotency_key: identity.key }, { metadata_json: { contains: identity.key } }] }, select: { id: true } })) return true;
  if (await db.costLedger.findFirst({ where: { user_id: identity.ownerId, OR: [{ idempotency_key: identity.key }, { source_id: identity.key }] }, select: { id: true } })) return true;
  if (await db.operationLog.findFirst({ where: { operator_id: identity.ownerId, action: { in: ['generation_create', 'generation_create_codex_api', 'enhance_video_create'] }, detail: { contains: identity.key } }, select: { id: true } })) return true;
  return false;
}
export async function rejectMultiviewRequest(claim: MultiviewRequestClaim, status: number, body: unknown) {
  if (status < 400 || status >= 500) return null;
  return prisma.$transaction(async db => {
    if (await acceptanceEvidence(db, claim)) return null;
    const found = await readStored(db, claim);
    if (!found || found.value.state !== 'pending' || found.value.nonce !== claim.nonce || found.value.fingerprint !== claim.fingerprint) return null;
    const next: StoredReceipt = { ...found.value, state: 'rejected', status, ...publicReason(body), rejectedAt: new Date().toISOString() };
    const changed = await db.platformSetting.updateMany({ where: { key: receiptKey(claim), value_json: found.raw }, data: { value_json: JSON.stringify(next), updated_by: claim.ownerId } });
    if (changed.count !== 1) throw unavailable();
    await db.operationLog.create({ data: { operator_id: claim.ownerId, action: 'multiview_request_rejected', target_type: 'MultiviewRequest', target_id: receiptKey(claim), detail: JSON.stringify(rejectedReceipt(next)) } });
    return rejectedReceipt(next);
  });
}

/** Explicit user action only. A protected release must first retire every pre-fence web writer. */
export async function closeUnacceptedMultiviewRequest(ownerId: string, key: string) {
  const identity = { ownerId, key };
  return prisma.$transaction(async db => {
    const user = await db.user.findUnique({ where: { id: ownerId }, select: { status: true } });
    if (user?.status !== 'active') throw new AuthError('当前账号不可用，原提交未结束。', 403);
    // Includes hidden/deleted-retention rows. Existing tasks always take precedence over receipts.
    const task = await db.videoTask.findUnique({ where: { user_id_idempotency_key: { user_id: ownerId, idempotency_key: key } }, select: { id: true } });
    if (task) return { kind: 'task' as const, taskId: task.id };
    const found = await readStored(db, identity);
    if (found?.value.state === 'accepted' || await acceptanceEvidence(db, identity)) return { kind: 'unknown' as const };
    const prior = found ? terminalReceipt(found.value) : null;
    if (prior) return { kind: 'terminal' as const, receipt: prior };
    const now = new Date().toISOString();
    const next: StoredReceipt = { ...(found?.value || { ...identity, version: 1 as const, fingerprint: null, createdAt: now }),
      state: 'closed', nonce: randomBytes(24).toString('hex'), status: 409,
      code: 'MULTIVIEW_REQUEST_CLOSED_BEFORE_ACCEPTANCE',
      message: '本次提交已结束，原请求号不会再被受理。素材和设置已保留；未重新生成。', closedAt: now };
    if (found) {
      const changed = await db.platformSetting.updateMany({ where: { key: receiptKey(identity), value_json: found.raw }, data: { value_json: JSON.stringify(next), updated_by: ownerId } });
      if (changed.count !== 1) throw unavailable();
    } else {
      await db.platformSetting.create({ data: { key: receiptKey(identity), value_json: JSON.stringify(next), updated_by: ownerId } });
    }
    const receipt = terminalReceipt(next)!;
    await db.operationLog.create({ data: { operator_id: ownerId, action: 'multiview_request_closed', target_type: 'MultiviewRequest', target_id: receiptKey(identity), detail: JSON.stringify(receipt) } });
    return { kind: 'terminal' as const, receipt };
  });
}
