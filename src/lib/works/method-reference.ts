import 'server-only';
import type { ImageStudioTask, Prisma } from '@prisma/client';
import { publicPricingTaskState } from '@/lib/image-studio/pricing-state';

type MethodOrigin = {
  schema: 1; ownerId: string; kind: 'image' | 'video'; scopeId: string;
  workId: string; mediaVersion: string; templateId: string; templateVersion: string; templateToken: string | null;
  claim?: { requestId: string; groupId: string };
};
export const workMethodOriginKey = (kind: MethodOrigin['kind'], scopeId: string) => `works-method-origin:v1:${kind}:${scopeId}`;
export const workMethodUseKey = (kind: MethodOrigin['kind'], requestId: string) => `works-method-use:v1:${kind}:${requestId}`;

/** Only the trusted one-click operation creates this binding on its new personal workspace. */
export async function bindWorkMethodOrigin(db: Prisma.TransactionClient, origin: Omit<MethodOrigin, 'schema' | 'claim'>) {
  await db.platformSetting.create({ data: {
    key: workMethodOriginKey(origin.kind, origin.scopeId), value_json: JSON.stringify({ schema: 1, ...origin }),
  } });
}

/** Runs after real task insertion, in that same accepting transaction. Quotes never call this. */
export async function freezeWorkMethodUse(db: Prisma.TransactionClient, input: {
  ownerId: string; kind: MethodOrigin['kind']; scopeId: string; requestId: string; groupId?: string;
  templateId: string | null; templateVersion: string | null; templateToken?: string | null;
}) {
  const key = workMethodOriginKey(input.kind, input.scopeId);
  const row = await db.platformSetting.findUnique({ where: { key } });
  if (!row) return;
  const origin = JSON.parse(row.value_json) as MethodOrigin;
  if (origin.ownerId !== input.ownerId || origin.templateId !== input.templateId
    || (input.kind === 'image' && origin.templateToken
      ? origin.templateToken !== input.templateToken : origin.templateVersion !== input.templateVersion)) return;
  const groupId = input.groupId || input.requestId;
  if (origin.claim && origin.claim.groupId !== groupId) {
    // An accepted/unknown/successful request keeps its attribution. Only a proven failed ordinary attempt can retry.
    if (origin.claim.groupId !== origin.claim.requestId) return;
    const previous = input.kind === 'image'
      ? (await db.imageStudioTask.findMany({ where: { owner_id: input.ownerId, batch_id: origin.claim.requestId }, select: { status: true } }))
        .map(task => publicPricingTaskState(task.status))
      : (await db.videoTask.findMany({ where: { id: origin.claim.requestId, owner_user_id: input.ownerId }, select: { local_status: true } }))
        .map(task => task.local_status);
    if (!previous.length || previous.some(status => status !== 'failed' && status !== 'cancelled')) return;
  }
  const useKey = workMethodUseKey(input.kind, input.requestId);
  await db.platformSetting.upsert({ where: { key: useKey },
    create: { key: useKey, value_json: JSON.stringify({ ...origin, claim: { requestId: input.requestId, groupId } }) }, update: {} });
  if (origin.claim?.groupId !== groupId) await db.platformSetting.update({ where: { key },
    data: { value_json: JSON.stringify({ ...origin, claim: { requestId: input.requestId, groupId } }) } });
}

export async function freezeImageWorkMethodUse(db: Prisma.TransactionClient,
  task: Pick<ImageStudioTask, 'owner_id' | 'module_id' | 'batch_id' | 'source_preset_id' | 'snapshot_json'>, groupId?: string) {
  if (!task.module_id || !task.source_preset_id) return;
  const snapshot = JSON.parse(task.snapshot_json || '{}');
  await freezeWorkMethodUse(db, { ownerId: task.owner_id, kind: 'image', scopeId: task.module_id,
    requestId: task.batch_id, groupId, templateId: task.source_preset_id,
    templateVersion: snapshot.sharedSourceRevision || null, templateToken: snapshot.sharedLive?.definitionToken || null });
}

/** Only a catalog-admitted successful output can turn the frozen reference into an endorsement. */
export async function readSuccessfulWorkMethodUse(db: Prisma.TransactionClient, target: {
  ownerId: string; kind: MethodOrigin['kind']; requestId: string;
}) {
  const row = await db.platformSetting.findUnique({ where: { key: workMethodUseKey(target.kind, target.requestId) } });
  if (!row) return null;
  const use = JSON.parse(row.value_json) as MethodOrigin;
  return use.schema === 1 && use.ownerId === target.ownerId && use.kind === target.kind
    && use.claim?.requestId === target.requestId ? use : null;
}
