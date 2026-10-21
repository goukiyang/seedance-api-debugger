import { Prisma } from '@prisma/client';
import { AuthError } from '@/lib/auth/session';
import type { UsageSourceKind } from './usage-types';

export interface UsageAttributionInput {
  sourceKind: UsageSourceKind;
  sourceId: string;
  actorUserId: string | null;
  ownerUserId: string | null;
  billingSubjectType?: string | null;
  billingSubjectId?: string | null;
  projectId: string | null;
  occurredAt: Date;
  parentSourceKind?: UsageSourceKind | null;
  parentSourceId?: string | null;
  contextOrigin: string;
}

type AttributionDb = Pick<Prisma.TransactionClient, '$executeRaw' | '$queryRaw'>;

// Called only in the original first-create transaction, never from report reads.
export async function recordUsageAttribution(db: AttributionDb, input: UsageAttributionInput) {
  if (!input.sourceId || !Number.isFinite(input.occurredAt.getTime())) throw new Error('Invalid usage attribution');
  await db.$executeRaw`INSERT INTO "UsageAttribution"
    ("source_kind", "source_id", "actor_user_id", "owner_user_id", "billing_subject_type", "billing_subject_id",
     "project_id", "occurred_at", "context_version", "parent_source_kind", "parent_source_id", "context_origin")
    VALUES (${input.sourceKind}, ${input.sourceId}, ${input.actorUserId}, ${input.ownerUserId},
      ${input.billingSubjectType ?? null}, ${input.billingSubjectId ?? null}, ${input.projectId},
      ${input.occurredAt}, 1, ${input.parentSourceKind ?? null}, ${input.parentSourceId ?? null}, ${input.contextOrigin})`;
}

export async function inheritUsageAttribution(db: AttributionDb, input: Omit<UsageAttributionInput, 'projectId' | 'contextOrigin'>) {
  const rows = input.parentSourceKind && input.parentSourceId
    ? await db.$queryRaw<Array<{ project_id: string | null; owner_user_id: string | null; billing_subject_type: string | null; billing_subject_id: string | null }>>`
      SELECT "project_id", "owner_user_id", "billing_subject_type", "billing_subject_id" FROM "UsageAttribution"
      WHERE "source_kind" = ${input.parentSourceKind} AND "source_id" = ${input.parentSourceId}`
    : [];
  const parent = rows[0];
  await recordUsageAttribution(db, { ...input, ownerUserId: parent?.owner_user_id ?? input.ownerUserId,
    billingSubjectType: parent?.billing_subject_type ?? input.billingSubjectType,
    billingSubjectId: parent?.billing_subject_id ?? input.billingSubjectId,
    projectId: parent?.project_id ?? null, contextOrigin: parent ? 'frozen-parent' : 'legacy-parent-unassigned' });
}

export function parseUsageProjectId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(value)) throw new AuthError('项目选择无效', 400);
  return value;
}

export async function assertUsageProject(db: Prisma.TransactionClient, user: { id: string; role: string }, projectId: string | null) {
  if (!projectId) return;
  const project = await db.project.findUnique({ where: { id: projectId }, select: {
    id: true, owner_user_id: true, type: true, status: true,
    members: { where: { user_id: user.id, status: 'active' }, select: { role: true }, take: 1 },
  } });
  const member = ['team', 'public'].includes(project?.type || '') ? project?.members[0] : null;
  if (!project || project.status !== 'active' || project.type === 'system'
    || user.role !== 'admin' && project.owner_user_id !== user.id && (!member || member.role === 'viewer')) {
    throw new AuthError('所选项目已不可用或无权生成，请重新选择；当前输入已保留', 403);
  }
}
