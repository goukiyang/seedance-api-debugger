import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { WorkAudience } from './types';

export const WORKS_POLICY_ACTIVATION_KEY = 'works_source_policy_v1:activation';
export const WORKS_CONTROL_KEY = 'works_registration_v1:control';
type PolicyDb = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;
const requiredTables = ['Work', 'WorkMediaVersion', 'WorkSourcePolicy', 'WorkRegistrationJob', 'WorkDiscoveryCheckpoint', 'WorkOperation'];

/** A pre-capability or rolled-back writer may continue its original operation, but grants no new audience. */
export async function worksSchemaReady(db: PolicyDb = prisma) {
  const tables = await db.$queryRaw<Array<{ name: string }>>`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('Work','WorkMediaVersion','WorkSourcePolicy','WorkRegistrationJob','WorkDiscoveryCheckpoint','WorkOperation')`;
  if (!requiredTables.every(name => tables.some(row => row.name === name))) return false;
  const columns = await db.$queryRaw<Array<{ name: string }>>`SELECT name FROM pragma_table_info('Project') WHERE name = 'work_audience'`;
  const media = await db.$queryRaw<Array<{ name: string }>>`SELECT name FROM pragma_table_info('WorkMediaVersion') WHERE name IN ('source_url','source_updated_at','preview_url','preview_hash')`;
  return columns.length === 1 && media.length === 4;
}
export async function worksPolicyActivation(db: PolicyDb = prisma) {
  const rows = await db.$queryRaw<Array<{ value_json: string }>>`SELECT value_json FROM PlatformSetting WHERE key = ${WORKS_POLICY_ACTIVATION_KEY}`;
  if (!rows.length) return null;
  const value = JSON.parse(rows[0].value_json);
  if (value.schema !== 1 || typeof value.activatedAt !== 'string' || !Number.isFinite(Date.parse(value.activatedAt))) throw new Error('WORKS_POLICY_ACTIVATION_INVALID');
  return new Date(value.activatedAt);
}
export async function worksRegistrationPaused(db: PolicyDb = prisma) {
  const rows = await db.$queryRaw<Array<{ value_json: string }>>`SELECT value_json FROM PlatformSetting WHERE key = ${WORKS_CONTROL_KEY}`;
  if (!rows.length) return false;
  const value = JSON.parse(rows[0].value_json);
  if (value.schema !== 1 || typeof value.paused !== 'boolean') throw new Error('WORKS_CONTROL_INVALID');
  return value.paused;
}

export type FreezeWorkSourceInput = {
  sourceKind: 'image_task' | 'image_batch' | 'video_task' | 'video_intent' | 'multiview_work'; sourceId: string; ownerId: string;
  projectId: string | null; occurredAt: Date; operationId?: string; eligible?: boolean; inheritImageBatch?: boolean;
};
async function inheritFrozenPolicy(db: PolicyDb, input: FreezeWorkSourceInput, kind: 'image_batch' | 'video_intent', parentId: string) {
  const frozen = await db.$queryRaw<Array<{ owner_id: string; project_id: string | null; audience: string }>>`
    SELECT owner_id, project_id, audience FROM WorkSourcePolicy WHERE source_kind = ${kind} AND source_id = ${parentId} AND operation_id = 'initial'`;
  const parent = frozen[0];
  const audience = parent?.owner_id === input.ownerId && parent.project_id === input.projectId ? parent.audience : 'source';
  // A parent lacking its original admission snapshot never borrows a later project label.
  await db.$executeRaw`INSERT INTO WorkSourcePolicy (id, source_kind, source_id, operation_id, owner_id, project_id, audience, captured_at)
    VALUES (${randomUUID()}, ${input.sourceKind}, ${input.sourceId}, 'initial', ${input.ownerId}, ${input.projectId}, ${audience}, ${input.occurredAt})
    ON CONFLICT(source_kind, source_id, operation_id) DO NOTHING`;
}
/** Only call in the original first-create / explicit-save transaction. Never call during reconciliation. */
export async function freezeWorkSourcePolicy(db: PolicyDb, input: FreezeWorkSourceInput) {
  try {
    if (!await worksSchemaReady(db)) return;
    const activation = await worksPolicyActivation(db);
    if (!activation || input.occurredAt < activation) return;
    let eligible = input.eligible !== false;
    if (input.sourceKind === 'image_task') {
      const tasks = await db.$queryRaw<Array<{ batch_id: string; snapshot_json: string | null }>>`SELECT batch_id, snapshot_json FROM ImageStudioTask WHERE id = ${input.sourceId} AND owner_id = ${input.ownerId}`;
      const task = tasks[0];
      if (!task) return;
      if (input.inheritImageBatch) { await inheritFrozenPolicy(db, input, 'image_batch', task.batch_id); return; }
      const snapshot = task.snapshot_json ? JSON.parse(task.snapshot_json) : {};
      if (snapshot.characterLab || snapshot.reproducedFromTaskId || snapshot.safeRetry?.attempt > 0) eligible = false;
      const prefix = `character-lab:v1:${input.ownerId}:plan:`;
      const plans = await db.$queryRaw<Array<{ key: string }>>`SELECT key FROM PlatformSetting WHERE key >= ${prefix} AND key < ${prefix.slice(0, -1) + ';'}`;
      if (plans.some(plan => /^[a-zA-Z0-9-]{16,80}$/.test(plan.key.slice(prefix.length)) && createHash('sha256').update(`${input.ownerId}:${plan.key.slice(prefix.length)}`).digest('hex') === task.batch_id)) eligible = false;
      if (typeof snapshot.requestId === 'string') {
        const attempts = await db.$queryRaw<Array<{ created_at: Date }>>`SELECT created_at FROM OperationLog WHERE operator_id = ${input.ownerId}
          AND action = 'image_generation_generate_attempt' AND target_type = 'ImageGeneration' AND target_id = ${snapshot.requestId} ORDER BY created_at ASC LIMIT 1`;
        if (attempts[0] && new Date(attempts[0].created_at) < activation) eligible = false;
      }
    }
    if (input.sourceKind === 'video_task') {
      const rows = await db.$queryRaw<Array<{ creation_intent_id: string | null; derived_from_task_id: string | null; source_draft_task_id: string | null }>>`
        SELECT creation_intent_id, derived_from_task_id, source_draft_task_id FROM VideoTask WHERE id = ${input.sourceId}`;
      const source = rows[0];
      if (!source) return;
      if (source.creation_intent_id) {
        await inheritFrozenPolicy(db, input, 'video_intent', source.creation_intent_id);
        return;
      }
      if (source.derived_from_task_id || source.source_draft_task_id) eligible = false;
    }
    const owners = await db.$queryRaw<Array<{ account_type: string; status: string; expires_at: Date | null }>>`SELECT account_type, status, expires_at FROM User WHERE id = ${input.ownerId}`;
    const owner = owners[0];
    if (!owner || owner.account_type !== 'internal' || owner.status !== 'active' || owner.expires_at && new Date(owner.expires_at) <= input.occurredAt) eligible = false;
    const projects = input.projectId ? await db.$queryRaw<Array<{ type: string; status: string; work_audience: string | null }>>`SELECT type, status, work_audience FROM Project WHERE id = ${input.projectId}` : [];
    const project = projects[0];
    let audience: WorkAudience = 'source';
    if (eligible && project?.status === 'active') {
      if (project.type === 'personal') audience = 'private';
      else if (project.type === 'team' && ['team', 'project', 'private'].includes(project.work_audience || '')) audience = project.work_audience as WorkAudience;
    }
    await db.$executeRaw`INSERT INTO WorkSourcePolicy (id, source_kind, source_id, operation_id, owner_id, project_id, audience, captured_at)
      VALUES (${randomUUID()}, ${input.sourceKind}, ${input.sourceId}, ${input.operationId || 'initial'}, ${input.ownerId}, ${input.projectId}, ${audience}, ${input.occurredAt})
      ON CONFLICT(source_kind, source_id, operation_id) DO NOTHING`;
  } catch {
    // Missing policy fails closed to original permissions; catalog availability must not reverse generation or billing.
    console.warn('[works-policy] capture deferred; original source permissions retained');
  }
}

/** Explicit operational activation; ordinary background passes never enable historical grants. */
export async function setWorksControl(action: 'activate-policy' | 'pause' | 'resume') {
  if (!await worksSchemaReady()) throw new Error('WORKS_SCHEMA_CAPABILITY_REQUIRED');
  if (action === 'activate-policy') {
    const activatedAt = new Date().toISOString();
    await prisma.platformSetting.upsert({ where: { key: WORKS_POLICY_ACTIVATION_KEY },
      create: { key: WORKS_POLICY_ACTIVATION_KEY, value_json: JSON.stringify({ schema: 1, activatedAt }) }, update: {} });
    return { activatedAt: (await worksPolicyActivation())!.toISOString() };
  }
  await prisma.platformSetting.upsert({ where: { key: WORKS_CONTROL_KEY },
    create: { key: WORKS_CONTROL_KEY, value_json: JSON.stringify({ schema: 1, paused: action === 'pause' }) },
    update: { value_json: JSON.stringify({ schema: 1, paused: action === 'pause' }) } });
  return { paused: action === 'pause' };
}
