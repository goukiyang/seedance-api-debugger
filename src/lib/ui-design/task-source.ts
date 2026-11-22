import type { Prisma } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { readUiDocument } from './store';
import type { UiJob } from './types';
import { resolveCanvasStudioReferenceUse } from '@/lib/canvas-studio-reference-use';
export type UiTaskSource = { user: SessionUser; requestId: string };
export async function resolveUiTaskSource(source: UiTaskSource, owner: string, body: Record<string, unknown>, tx: Prisma.TransactionClient) {
  if (source.user.id !== owner || source.user.account_type !== 'internal' || source.user.status !== 'active' || source.requestId !== body.requestId) throw new AuthError('UI 设计来源不匹配', 403);
  const record = await readUiDocument(owner, 'request', source.requestId, tx), job = record.data as UiJob;
  const fields = ['requestId', 'projectId', 'prompt', 'count', 'revision', 'referenceIds', 'model', 'channelId', 'quality', 'resolution', 'aspectRatio', 'draft'];
  if (job.id !== source.requestId || fields.some(key => JSON.stringify(job.body[key]) !== JSON.stringify(body[key]))) throw new AuthError('原提交内容已变化，请核对原任务；本次未发送', 409);
  const shared = job.references.filter(reference => reference.referenceImageId);
  const owners = await resolveCanvasStudioReferenceUse(source.user, shared.map(reference => reference.referenceImageId!), tx);
  if (shared.some(reference => !owners.has(reference.assetId))) throw new AuthError('共享参考与原素材不匹配', 403);
  const assets = await tx.asset.findMany({ where: { id: { in: job.references.map(reference => reference.assetId) }, status: 'active', type: 'image' }, select: { id: true, hash: true } });
  if (job.references.some(reference => assets.find(asset => asset.id === reference.assetId)?.hash !== reference.hash)) throw new AuthError('原素材内容或权限已变化，请保留输入重新核对', 409);
  return { job, owners };
}
