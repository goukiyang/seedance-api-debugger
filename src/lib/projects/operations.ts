import crypto from 'crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { assertFeatureAllowed } from '@/lib/access/feature-guard';
import { getProjectAccess, logProjectActionInTransaction, normalizeProjectRole } from './permissions';

type OperationState = 'accepted' | 'rejected' | 'closed';
type CreateReceipt = {
  operationVersion: 1;
  requestId: string;
  state: OperationState;
  fingerprint: string | null;
  projectId: string | null;
  error: string | null;
  httpStatus: number;
  recordedAt: string;
};

export class ProjectOperationError extends AuthError {
  constructor(message: string, status: number, public readonly code: string) { super(message, status); }
}

export function assertProjectRequestId(requestId: unknown): asserts requestId is string {
  if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
    throw new ProjectOperationError('创建协议已更新，请刷新后重试，当前输入请保留', 400, 'PROJECT_OPERATION_PROTOCOL_REQUIRED');
  }
}

export function projectCreateKey(userId: string, requestId: string) {
  assertProjectRequestId(requestId);
  return `project-create:v1:${userId}:${requestId.toLowerCase()}`;
}

export function normalizeProjectCreateInput(body: Record<string, unknown>) {
  const input = {
    name: typeof body.name === 'string' ? body.name.trim() : null,
    description: typeof body.description === 'string' ? body.description.trim() || null
      : body.description == null ? null : { invalid: true },
    type: body.type === undefined ? 'team' : body.type,
  };
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const error = input.type !== 'team' ? '项目类型无效'
    : !input.name ? '项目名称不能为空'
      : input.name.length > 120 ? '项目名称不能超过120字'
        : typeof input.description === 'object' && input.description !== null ? '项目描述格式无效'
          : typeof input.description === 'string' && input.description.length > 4000 ? '项目描述不能超过4000字' : null;
  return { input, fingerprint, error };
}

async function readReceipt(tx: Prisma.TransactionClient, key: string): Promise<CreateReceipt | null> {
  const setting = await tx.platformSetting.findUnique({ where: { key }, select: { value_json: true } });
  if (!setting) return null;
  const receipt = JSON.parse(setting.value_json) as CreateReceipt;
  if (receipt.operationVersion !== 1 || !['accepted', 'rejected', 'closed'].includes(receipt.state)
    || typeof receipt.requestId !== 'string' || typeof receipt.recordedAt !== 'string'
    || receipt.state === 'accepted' && typeof receipt.projectId !== 'string') {
    throw new Error('Project operation receipt unavailable');
  }
  return receipt;
}

async function projectOperationResult(tx: Prisma.TransactionClient, user: SessionUser, receipt: CreateReceipt | null, requestId: string, deduplicated: boolean) {
  const access = receipt?.state === 'accepted' && receipt.projectId
    ? await getProjectAccess(user, receipt.projectId, tx) : null;
  const project = access?.canView ? access.project : null;
  return {
    operation: {
      operationVersion: 1 as const, requestId, state: receipt?.state ?? 'unknown',
      projectId: project?.id ?? null, projectHref: project ? `/projects/${encodeURIComponent(project.id)}` : null,
      error: receipt?.error ?? null, recordedAt: receipt?.recordedAt ?? null,
    },
    project,
    deduplicated,
  };
}

export async function createTeamProject(user: SessionUser, body: Record<string, unknown>) {
  assertProjectRequestId(body.requestId);
  if (body.operationVersion !== 1) throw new ProjectOperationError('创建协议已更新，请刷新后重试，当前输入请保留', 400, 'PROJECT_OPERATION_PROTOCOL_REQUIRED');
  const requestId = body.requestId.toLowerCase();
  const key = projectCreateKey(user.id, requestId);
  const normalized = normalizeProjectCreateInput(body);
  return prisma.$transaction(async (tx) => {
    const existing = await readReceipt(tx, key);
    if (existing) {
      const response = await projectOperationResult(tx, user, existing, requestId, true);
      if (existing.state !== 'closed' && existing.fingerprint !== normalized.fingerprint) {
        return { status: 409, body: { ...response, error: '同一次创建的内容已变化，请先核对原创建结果', code: 'PROJECT_OPERATION_INPUT_CONFLICT' } };
      }
      return { status: existing.state === 'closed' ? 409 : existing.httpStatus,
        body: { ...response, ...(existing.error ? { error: existing.error } : {}) } };
    }
    let rejection = normalized.error;
    let rejectionStatus = 400;
    try { assertFeatureAllowed(user, 'team_project_manage'); } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      rejection = error.message;
      rejectionStatus = error.status;
    }
    let projectId: string | null = null;
    if (!rejection) {
      const project = await tx.project.create({ data: {
        name: normalized.input.name!,
        description: typeof normalized.input.description === 'string' ? normalized.input.description : null,
        type: 'team', visibility: 'private', owner_user_id: user.id, created_by: user.id, status: 'active',
      } });
      projectId = project.id;
      await tx.projectMember.create({ data: { project_id: project.id, user_id: user.id, role: 'project_owner', joined_by: user.id } });
      await logProjectActionInTransaction(tx, user.id, 'project_create', 'project', project.id, { name: project.name, type: 'team' });
      await logProjectActionInTransaction(tx, user.id, 'project_member_join', 'project', project.id,
        { user_id: user.id, role: 'project_owner', source: 'create_project' });
    }
    const receipt: CreateReceipt = { operationVersion: 1, requestId, state: rejection ? 'rejected' : 'accepted',
      fingerprint: normalized.fingerprint, projectId, error: rejection, httpStatus: rejection ? rejectionStatus : 200, recordedAt: new Date().toISOString() };
    // The unique owner/key is claimed in the same transaction as the project and audit.
    await tx.platformSetting.create({ data: { key, value_json: JSON.stringify(receipt), updated_by: user.id } });
    const response = await projectOperationResult(tx, user, receipt, requestId, false);
    return { status: receipt.httpStatus, body: { ...response, ...(rejection ? { error: rejection } : {}) } };
  });
}

export async function getProjectCreateOperation(user: SessionUser, requestId: string) {
  const key = projectCreateKey(user.id, requestId);
  return prisma.$transaction(async (tx) => projectOperationResult(tx, user, await readReceipt(tx, key), requestId.toLowerCase(), true));
}

export async function closeProjectCreateOperation(user: SessionUser, requestId: string) {
  const key = projectCreateKey(user.id, requestId);
  return prisma.$transaction(async (tx) => {
    const original = await readReceipt(tx, key);
    if (original?.state === 'accepted' || original?.state === 'closed') return projectOperationResult(tx, user, original, requestId.toLowerCase(), true);
    const receipt: CreateReceipt = { operationVersion: 1, requestId: requestId.toLowerCase(), state: 'closed',
      fingerprint: original?.fingerprint ?? null, projectId: null, error: null, httpStatus: 409, recordedAt: new Date().toISOString() };
    if (original) await tx.platformSetting.update({ where: { key }, data: { value_json: JSON.stringify(receipt), updated_by: user.id } });
    else await tx.platformSetting.create({ data: { key, value_json: JSON.stringify(receipt), updated_by: user.id } });
    return projectOperationResult(tx, user, receipt, requestId.toLowerCase(), true);
  });
}

export async function joinProjectInvite(tx: Prisma.TransactionClient, user: SessionUser, token: string) {
  assertFeatureAllowed(user, 'team_project_manage');
  const now = new Date();
  const invite = await tx.projectInvite.findUnique({ where: { token }, include: { project: true } });
  if (!invite || invite.status !== 'active') throw new AuthError('邀请链接无效或已停用', 404);
  if (invite.expires_at && invite.expires_at.getTime() <= now.getTime()) throw new AuthError('邀请链接已过期', 410);
  if (invite.allowed_account_type && invite.allowed_account_type !== user.account_type) throw new AuthError('当前账号类型不允许加入此项目', 403);
  if (invite.project.status !== 'active' || !['team', 'public'].includes(invite.project.type)) throw new AuthError('项目当前不可通过邀请加入', 403);
  const existing = await tx.projectMember.findUnique({ where: { project_id_user_id: { project_id: invite.project_id, user_id: user.id } } });
  if (existing?.status === 'active') return { project_id: invite.project_id, member: existing, deduplicated: true };
  if (invite.max_uses !== null && invite.used_count >= invite.max_uses) throw new AuthError('邀请链接使用次数已达上限', 410);
  const normalizedRole = normalizeProjectRole(invite.default_role);
  const role = normalizedRole === 'project_owner' ? 'member' : normalizedRole;
  const member = await tx.projectMember.upsert({
    where: { project_id_user_id: { project_id: invite.project_id, user_id: user.id } },
    update: { role, status: 'active', joined_by: invite.created_by, joined_at: now },
    create: { project_id: invite.project_id, user_id: user.id, role, joined_by: invite.created_by },
  });
  const consumed = await tx.projectInvite.updateMany({ where: { id: invite.id, status: 'active', used_count: invite.used_count,
    OR: [{ expires_at: null }, { expires_at: { gt: now } }] }, data: { used_count: { increment: 1 } } });
  if (consumed.count !== 1) throw new AuthError('邀请状态已变化，请重新核对', 409);
  await logProjectActionInTransaction(tx, user.id, 'project_member_join', 'project', invite.project_id, { via: 'invite', invite_id: invite.id, role });
  await logProjectActionInTransaction(tx, invite.created_by, 'project_invite_used', 'project', invite.project_id, { invite_id: invite.id, user_id: user.id });
  return { project_id: invite.project_id, member, deduplicated: false };
}
