import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { getProjectAccess } from '@/lib/projects/permissions';
import { canGenerateInVideoCardStatus } from '@/lib/video-cards/permissions';
import { shouldBillProjectBudget } from '@/lib/projects/budget';
import { pricingFingerprint } from '@/lib/pricing/catalog';
import { CreationError, VIDEO_CREATION_CAPABILITY, type CreationPayer } from './contract';

export type CreationDb = Prisma.TransactionClient;
const COLUMNS: Record<string, readonly string[]> = {
  VideoTask: ['creation_contract_version', 'creation_intent_id', 'derived_from_task_id', 'lineage_root_task_id'],
  VideoCreationIntent: ['id', 'revision', 'state', 'spec_json', 'batch_id', 'quote_business_hash'],
  VideoDeliverySelection: ['lineage_root_task_id', 'revision', 'state', 'selected_task_id'],
  ApprovalRecord: ['creation_intent_id', 'intent_revision', 'revision', 'authorized_cost_cents', 'used_cost_cents'],
  ApprovalUsage: ['creation_intent_id', 'intent_revision', 'authorization_revision', 'child_key', 'authorized_cost_cents'],
  CanvasVideoBatch: ['creation_intent_id', 'authorization_round'],
  CanvasVideoBatchChild: ['intent_spec_revision', 'authorization_revision', 'approval_record_id', 'approval_scope_hash'],
};
/** Capability reads do not touch new Prisma fields on an unexpanded database. */
export async function videoCreationSchemaReady(db: CreationDb = prisma) {
  for (const [table, columns] of Object.entries(COLUMNS)) {
    const actual = await db.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA table_info("${table}")`);
    const names = new Set(actual.map(row => row.name));
    if (columns.some(name => !names.has(name))) return false;
  }
  return true;
}
export async function assertVideoCreationReady(db: CreationDb = prisma, writes = true) {
  if (writes && process.env.VIDEO_CREATION_FLOW_V2_ENABLED !== '1') {
    throw new CreationError('新的创作流程尚未开放，原任务和当前输入均保留', 503, 'creation_v2_guard');
  }
  if (!await videoCreationSchemaReady(db)) throw new CreationError('新的创作流程尚未就绪，请保留当前输入', 503, 'creation_schema_required');
}
/** Read-only. No default project, workspace, card or billing account is created here. */
export async function readCreationContext(user: SessionUser, projectId: string | null, cardId: string | null = null, db: CreationDb = prisma) {
  if (!projectId) throw new CreationError('请选择保存到哪个项目', 400, 'creation_project_required', 'project_id', 'select_project');
  const access = await getProjectAccess(user, projectId, db);
  if (!access.project) throw new AuthError('项目不存在或无权使用', 404);
  if (!access.canGenerate || access.project.status !== 'active' || access.project.type === 'system') {
    throw new CreationError('此项目当前不可创作，输入已保留，请选择有权使用的项目', 403, 'creation_project_unavailable', 'project_id', 'select_project');
  }
  let legacyCard: { id: string; title: string; status: string } | null = null;
  if (cardId) {
    const card = await db.videoCard.findUnique({ where: { id: cardId }, select: { id: true, title: true, status: true, project_id: true } });
    if (!card || card.project_id !== projectId) throw new CreationError('原视频卡与项目不匹配，未改变原归属', 409, 'creation_legacy_card_invalid', 'video_card_id');
    if (!canGenerateInVideoCardStatus(card.status)) throw new CreationError('原视频卡当前不可继续创作，请处理原锁定状态', 409, 'creation_legacy_card_locked', 'video_card_id', 'reopen');
    legacyCard = { id: card.id, title: card.title, status: card.status };
  }
  const payer: CreationPayer = shouldBillProjectBudget(access.project)
    ? { kind: 'project', id: projectId, label: '使用项目预算' } : { kind: 'user', id: user.id, label: '使用我的点数' };
  return { project: { id: projectId, name: access.project.name, type: access.project.type }, payer, legacyCard,
    contextRevision: pricingFingerprint({ actor: user.id, project: projectId, status: access.project.status, payer, legacyCard }),
    capabilities: [VIDEO_CREATION_CAPABILITY], v2Available: process.env.VIDEO_CREATION_FLOW_V2_ENABLED === '1' && await videoCreationSchemaReady(db) };
}
