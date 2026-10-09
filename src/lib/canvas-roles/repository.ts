import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { assertRoleUser, assertCurrentRoleUser, ownedDefinition, type RoleDb } from './permissions';
import { digest, identifier, integer, record, roleSnapshot, RoleError, ROLE_PAGE_SIZE, text, type JsonRecord } from './types';

export async function roleMutation<T>(user: SessionUser, body: JsonRecord, kind: string,
  authorize: (db: RoleDb) => Promise<unknown>, perform: (db: RoleDb) => Promise<{ objectId: string; result: T }>) {
  assertRoleUser(user);
  const mutationId = identifier(body.mutation_id), requestHash = digest({ kind, body });
  async function replay(db: RoleDb) {
    await assertCurrentRoleUser(db, user);
    await authorize(db);
    const receipt = await db.canvasRoleMutationReceipt.findUnique({
      where: { owner_user_id_mutation_id: { owner_user_id: user.id, mutation_id: mutationId } },
    });
    if (!receipt) return null;
    if (receipt.request_hash !== requestHash) throw new RoleError('此请求编号已用于不同内容，请保留草稿重新操作', 409, 'mutation_conflict');
    return { ...JSON.parse(receipt.response_json), replayed: true };
  }
  try {
    return await prisma.$transaction(async db => {
      const prior = await replay(db);
      if (prior) return prior;
      const { objectId, result } = await perform(db);
      const response = { ...(record(result) ? result : { result }), mutation_id: mutationId, replayed: false };
      await db.canvasRoleMutationReceipt.create({ data: {
        id: randomUUID(), owner_user_id: user.id, mutation_id: mutationId,
        request_hash: requestHash, object_id: objectId, response_json: JSON.stringify(response),
      } });
      return response;
    }, { timeout: 15000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034', 'P1008', 'P2028'].includes(error.code)) {
      const prior = await replay(prisma);
      if (prior) return prior;
      throw new RoleError('遇到并发保存，请保留原请求编号重试', 409, 'write_conflict');
    }
    throw error;
  }
}
export async function listRoles(user: SessionUser, params: URLSearchParams) {
  await assertCurrentRoleUser(prisma, user);
  const status = params.get('status') || 'active';
  if (!['active', 'archived'].includes(status)) throw new RoleError('角色库筛选无效');
  const q = text(params.get('q') ?? '', 120);
  const scope = digest([user.id, status, q]);
  let after: { id: string; updatedAt: Date } | null = null;
  const cursor = params.get('cursor');
  if (cursor) {
    try {
      if (cursor.length > 1024) throw new Error();
      const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (!record(v) || v.scope !== scope) throw new Error();
      const updatedAt = new Date(String(v.updatedAt));
      if (!Number.isFinite(updatedAt.getTime())) throw new Error();
      after = { id: identifier(v.id), updatedAt };
    } catch { throw new RoleError('分页位置失效，请重新加载角色库'); }
  }
  const rows = await prisma.canvasRoleDefinition.findMany({
    where: { owner_user_id: user.id, status, ...(q ? { name: { contains: q } } : {}),
      ...(after ? { OR: [{ updated_at: { lt: after.updatedAt } }, { updated_at: after.updatedAt, id: { lt: after.id } }] } : {}) },
    orderBy: [{ updated_at: 'desc' }, { id: 'desc' }], take: ROLE_PAGE_SIZE + 1,
  });
  const roles = rows.slice(0, ROLE_PAGE_SIZE), last = roles[roles.length - 1];
  return { roles, next_cursor: rows.length > ROLE_PAGE_SIZE && last
    ? Buffer.from(JSON.stringify({ scope, id: last.id, updatedAt: last.updated_at.toISOString() })).toString('base64url') : null };
}
export async function getRole(user: SessionUser, roleId: string, version?: number) {
  const role = await ownedDefinition(prisma, user, identifier(roleId));
  const row = await prisma.canvasRoleVersion.findUnique({ where: {
    definition_id_version: { definition_id: role.id, version: version ?? role.current_version },
  } });
  if (!row) throw new RoleError('角色版本不存在', 404, 'role_version_not_found');
  return { role, version: { ...row, snapshot: JSON.parse(row.snapshot_json), snapshot_json: undefined } };
}
export async function createRole(user: SessionUser, body: JsonRecord) {
  return roleMutation(user, body, 'role_create', async () => assertRoleUser(user), async db => {
    const snapshot = roleSnapshot(body.snapshot, user.id);
    const roleId = `role-${digest([user.id, body.mutation_id])}`;
    const role = await db.canvasRoleDefinition.create({ data: { id: roleId, owner_user_id: user.id, name: snapshot.name } });
    const version = await db.canvasRoleVersion.create({ data: {
      id: `${roleId}-v1`, definition_id: roleId, version: 1, snapshot_json: JSON.stringify(snapshot),
    } });
    return { objectId: roleId, result: { role, version: { id: version.id, version: 1, snapshot } } };
  });
}
export async function editRole(user: SessionUser, roleId: string, body: JsonRecord) {
  return roleMutation(user, body, `role_edit:${identifier(roleId)}`, db => ownedDefinition(db, user, roleId), async db => {
    const role = await ownedDefinition(db, user, roleId);
    if (integer(body.base_revision) !== role.revision || integer(body.base_version) !== role.current_version) {
      throw new RoleError('角色已更新，请保留草稿并读取最新版本', 409, 'revision_conflict', { current_revision: role.revision });
    }
    const action = body.action;
    if (!['edit', 'archive', 'restore'].includes(String(action))) throw new RoleError('角色操作无效');
    let version = role.current_version, snapshot;
    if (action === 'edit') {
      if (role.status !== 'active') throw new RoleError('请先恢复角色再编辑', 409, 'role_archived');
      snapshot = roleSnapshot(body.snapshot, user.id);
      version++;
      await db.canvasRoleVersion.create({ data: { id: `${roleId}-v${version}`, definition_id: roleId, version, snapshot_json: JSON.stringify(snapshot) } });
    }
    const changed = await db.canvasRoleDefinition.updateMany({ where: { id: roleId, revision: role.revision },
      data: { current_version: version, revision: { increment: 1 }, ...(snapshot ? { name: snapshot.name } : {}),
        ...(action !== 'edit' ? { status: action === 'archive' ? 'archived' : 'active' } : {}) } });
    if (changed.count !== 1) throw new RoleError('角色已更新，请重读最新版本', 409, 'revision_conflict');
    return { objectId: roleId, result: { role: await db.canvasRoleDefinition.findUnique({ where: { id: roleId } }),
      version: snapshot ? { id: `${roleId}-v${version}`, version, snapshot } : null } };
  });
}
export async function roleReceipt(user: SessionUser, mutationId: string) {
  await assertCurrentRoleUser(prisma, user);
  const receipt = await prisma.canvasRoleMutationReceipt.findUnique({ where: {
    owner_user_id_mutation_id: { owner_user_id: user.id, mutation_id: identifier(mutationId) },
  } });
  if (!receipt) throw new RoleError('尚未找到保存回执，请保留草稿与原请求编号', 404, 'receipt_not_found');
  const response = JSON.parse(receipt.response_json);
  // Receipts are not an alternate route around current project/document access.
  if (response.nodeId && response.documentId === receipt.object_id) {
    const { roleDocument } = await import('./permissions');
    await roleDocument(user, receipt.object_id);
  } else if (response.role?.id === receipt.object_id) await ownedDefinition(prisma, user, receipt.object_id);
  else {
    const { ownedRun } = await import('./permissions');
    const work = await prisma.canvasRoleWork.findUnique({ where: { id: receipt.object_id } });
    await ownedRun(prisma, user, work?.role_task_run_id || receipt.object_id);
  }
  if (typeof response.attemptId === 'string') {
    const attempt = await prisma.canvasRoleAttempt.findUnique({ where: { id: response.attemptId } });
    if (attempt) return { ...response, state: attempt.state, fee_state: attempt.fee_state,
      settlement_applied: attempt.settlement_applied, resend: false, receipt_kind: 'execution_reservation', replayed: true };
  }
  return { ...response, replayed: true };
}
