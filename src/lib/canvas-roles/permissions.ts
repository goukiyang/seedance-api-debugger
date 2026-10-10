import type { Prisma, CanvasRoleWork } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/session';
import { assertInternalOnly } from '@/lib/access/feature-guard';
import { isExternalUser } from '@/lib/access/external-role';
import { assertCanEditCanvasDocument, assertCanReadCanvasDocument } from '@/lib/canvas-documents';
import { RoleError, record, digest } from './types';
import { prisma } from '@/lib/prisma';

export type RoleDb = Prisma.TransactionClient;
const requestAccounts = new WeakMap<SessionUser, string>();
export function assertRoleUser(user: SessionUser) {
  assertInternalOnly(user, '外部账号无权使用无限画布角色。');
  if (user.status !== 'active') throw new RoleError('账号当前不可用', 403, 'account_unavailable');
}
export async function assertCurrentRoleUser(db: RoleDb, user: SessionUser) {
  assertRoleUser(user);
  const current = await db.user.findUnique({ where: { id: user.id }, select: {
    id: true, status: true, account_type: true, role: true, feature_profile_id: true, expires_at: true,
    password_hash: true, user_profile: true, feishu_user_id: true, feishu_open_id: true, feishu_union_id: true,
  } });
  if (!current || current.status !== 'active' || current.account_type !== 'internal'
    || current.role !== user.role || current.feature_profile_id !== user.feature_profile_id
    || current.user_profile !== user.user_profile || current.expires_at?.getTime() !== user.expires_at?.getTime()
    || (current.feishu_user_id || null) !== (user.feishu?.user_id || null) || (current.feishu_open_id || null) !== (user.feishu?.open_id || null)
    || (current.feishu_union_id || null) !== (user.feishu?.union_id || null)
    || isExternalUser({ ...current, feishu: { user_id: current.feishu_user_id, open_id: current.feishu_open_id, union_id: current.feishu_union_id } })
    || (current.expires_at && current.expires_at.getTime() <= Date.now())) {
    throw new RoleError('账号或授权已变化，请重新登录后核对', 403, 'account_unavailable');
  }
  // Keep a request-local fingerprint, never expose a password hash through SessionUser/API.
  const fingerprint = digest(current);
  const before = requestAccounts.get(user);
  if (before && before !== fingerprint) throw new RoleError('账号在处理期间已变化，未继续原操作', 403, 'account_unavailable');
  requestAccounts.set(user, fingerprint);
}
export async function roleDocument(user: SessionUser, documentId: string, write = false) {
  await assertCurrentRoleUser(prisma, user);
  return write ? assertCanEditCanvasDocument(user, documentId) : assertCanReadCanvasDocument(user, documentId);
}
export async function ownedDefinition(db: RoleDb, user: SessionUser, definitionId: string, add = false) {
  await assertCurrentRoleUser(db, user);
  const role = await db.canvasRoleDefinition.findFirst({ where: { id: definitionId, owner_user_id: user.id } });
  if (!role) throw new RoleError('角色不存在或不可访问', 404, 'role_not_found');
  if (add && role.status !== 'active') throw new RoleError('角色已归档，请先恢复到角色库', 409, 'role_archived');
  return role;
}
export async function ownedRun(db: RoleDb, user: SessionUser, runId: string, write = false) {
  await assertCurrentRoleUser(db, user);
  const run = await db.canvasRoleTaskRun.findFirst({ where: { id: runId, owner_user_id: user.id } });
  if (!run) throw new RoleError('任务不存在或不可访问', 404, 'role_task_not_found');
  const document = await roleDocument(user, run.document_id, write);
  // Recheck owner and revision inside the local write transaction as well.
  const current = await db.canvasDocument.findUnique({ where: { id: document.id } });
  if (!current || current.owner_user_id !== user.id || current.status === 'deleted') {
    throw new RoleError('画布不存在或不可访问', 403, 'document_unavailable');
  }
  if (write && current.status !== 'active') throw new RoleError('画布已归档，请先恢复', 409, 'document_archived');
  return { run, document: current };
}
export function assertLiveNode(work: CanvasRoleWork, documentJson: string) {
  const graph = JSON.parse(documentJson);
  const node = graph.canvas?.nodes?.find((item: { id: string; type: string }) => item.id === work.node_id && item.type === 'role');
  if (!node || !record(node.data?.roleConfig)) throw new RoleError('角色已移除，可回查历史但不能继续原工作', 409, 'role_node_removed');
  const snapshot = JSON.parse(work.snapshot_json);
  if (node.data.roleConfig.definitionId !== snapshot.definitionId || node.data.roleConfig.version !== snapshot.version) {
    throw new RoleError('角色版本已变，请更新本次任务后继续', 409, 'role_version_changed');
  }
  return node;
}
