import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { assertCanGenerateInProject, getProjectAccess } from '@/lib/projects/permissions';
import { assertCanGenerateInVideoCard } from '@/lib/video-cards/permissions';
import { getOrCreateWorkspace } from '@/lib/assets/workspace';
import { CanvasReferenceError, requireCanvasReferencesCapability } from './canvas-references';

type Input = { projectId: string; documentId: string; cardId?: string | null; nodeId?: string | null;
  purpose?: 'read' | 'upload' | 'reference' | 'generate' };
export function canvasWorkspaceKey(ownerId: string, projectId: string, documentId: string) {
  return 'uc2_' + createHash('sha256').update(JSON.stringify(['canvas-workspace', 2, ownerId, projectId, documentId])).digest('hex');
}
export async function resolveCanvasWorkspaceScope(user: SessionUser, input: Input, db: Prisma.TransactionClient = prisma) {
  if (user.status !== 'active' || user.account_type !== 'internal') throw new AuthError('当前账号无权使用画布', 403);
  const actor = await db.user.findUnique({ where: { id: user.id }, select: { status: true, role: true, account_type: true } });
  if (!actor || actor.status !== 'active' || actor.account_type !== 'internal') throw new AuthError('当前账号无权使用画布', 403);
  if (actor.role !== user.role || actor.account_type !== user.account_type) throw new AuthError('账号权限已变化，请刷新后核对原输入', 409);
  if (![input.projectId, input.documentId].every(value => /^[A-Za-z0-9_-]{1,160}$/.test(value))) throw new AuthError('画布归属无效', 400);
  if (input.purpose === 'read') {
    if (!(await getProjectAccess(user, input.projectId, db)).canView) throw new AuthError('无权读取此项目画布', 403);
  } else await assertCanGenerateInProject(user, input.projectId, db);
  const document = await db.canvasDocument.findUnique({ where: { id: input.documentId } });
  if (!document || document.status === 'deleted') throw new AuthError('画布不存在', 404);
  if (document.owner_user_id !== user.id || document.project_id !== input.projectId) throw new AuthError('无权使用此画布或归属不同', 403);
  if (input.purpose !== 'read' && document.status !== 'active') throw new AuthError('画布已归档，请先恢复', 409);
  const snapshot = JSON.parse(document.document_json), savedCard = snapshot.context?.video_card_id || snapshot.context?.videoCardId || null;
  const cardId = input.cardId === undefined ? savedCard : input.cardId || null;
  if (savedCard && savedCard !== cardId) throw new AuthError('原画布仍绑定原视频卡，未更改原归属', 409);
  if (cardId && input.purpose !== 'read') await assertCanGenerateInVideoCard(user, input.projectId, cardId, db);
  if (input.nodeId && input.purpose !== 'upload' && !snapshot.canvas?.nodes?.some((node: { id: string }) => node.id === input.nodeId)) {
    throw new AuthError('节点已不在当前画布，请先保存后重试', 409);
  }
  return { version: 2 as const, owner_id: user.id, project_id: input.projectId, document_id: document.id,
    video_card_id: cardId as string | null, workspace_key: canvasWorkspaceKey(user.id, input.projectId, document.id), snapshot };
}
export type CanvasWorkspaceScope = Awaited<ReturnType<typeof resolveCanvasWorkspaceScope>>;
export async function writeCanvasWorkspace(scope: CanvasWorkspaceScope, db: Prisma.TransactionClient = prisma) {
  return getOrCreateWorkspace(scope.workspace_key, scope.owner_id, db);
}
export function legacyCanvasWorkspaceKeys(scope: CanvasWorkspaceScope, nodeId?: string | null) {
  return [...new Set([
    ...(scope.video_card_id ? [`ultimate-canvas:${scope.project_id}:${scope.video_card_id}`] : []),
    `ultimate-canvas:v2:${scope.owner_id}:${scope.project_id}:${scope.document_id}`,
    ...(scope.video_card_id || nodeId ? [`ultimate-canvas:${scope.project_id}:${scope.video_card_id || nodeId}`] : []),
  ])];
}
export async function readLegacyCanvasWorkspace(scope: CanvasWorkspaceScope, nodeId?: string | null,
  receiptWorkspaceId?: string, db: Prisma.TransactionClient = prisma) {
  if (receiptWorkspaceId) {
    const original = await db.workspace.findFirst({ where: { id: receiptWorkspaceId, owner_id: scope.owner_id, status: 'active' }, select: { id: true } });
    if (!original) throw new AuthError('原工作区已失效，未重新关联', 409);
    return original;
  }
  const keys = legacyCanvasWorkspaceKeys(scope, nodeId), ids = new Set<string>();
  for (const tabId of keys) {
    const key = 'workspace_tab_binding_v1:' + createHash('sha256').update(JSON.stringify([scope.owner_id, tabId])).digest('hex');
    const binding = await db.platformSetting.findUnique({ where: { key } });
    if (binding) {
      const saved = JSON.parse(binding.value_json);
      if (saved.version !== 1 || saved.ownerId !== scope.owner_id || saved.tabId !== tabId || typeof saved.workspaceId !== 'string') throw new AuthError('原工作区绑定无法确认', 409);
      const row = await db.workspace.findFirst({ where: { id: saved.workspaceId, owner_id: scope.owner_id, status: 'active', name: `默认工作台:${tabId.trim().slice(0, 96)}` }, select: { id: true } });
      if (!row) throw new AuthError('原工作区绑定已失效', 409);
      ids.add(row.id);
    }
  }
  const rows = await db.workspace.findMany({ where: { owner_id: scope.owner_id, status: 'active',
    name: { in: keys.map(key => `默认工作台:${key.trim().slice(0, 96)}`) } }, select: { id: true }, take: 4 });
  rows.forEach(row => ids.add(row.id));
  if (ids.size > 1) throw new AuthError('原工作区存在多个可能记录，请保留原素材并核对原关联', 409);
  return ids.size ? { id: [...ids][0] } : null;
}
export async function canvasWorkspaceFromHeaders(user: SessionUser, headers: Headers, purpose: Input['purpose'] = 'reference', db: Prisma.TransactionClient = prisma) {
  const key = headers.get('x-tab-id');
  if (!key?.startsWith('uc2_')) return null;
  const scope = await resolveCanvasWorkspaceScope(user, { projectId: headers.get('x-canvas-project-id') || '',
    documentId: headers.get('x-canvas-document-id') || '', cardId: headers.get('x-canvas-card-id') || null,
    nodeId: headers.get('x-canvas-node-id'), purpose }, db);
  if (scope.workspace_key !== key) throw new AuthError('工作区与当前画布不一致', 409);
  try { if (purpose !== 'read') requireCanvasReferencesCapability(scope.snapshot, (headers.get('x-canvas-capabilities') || '').split(',')); }
  catch (error) { if (error instanceof CanvasReferenceError) throw new AuthError(error.message, error.status); throw error; }
  return scope;
}
