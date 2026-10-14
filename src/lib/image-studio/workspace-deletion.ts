import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { canManageStudioPreset, type ImageStudioIdentity, type StudioPresetAccessRow } from './access';
import { sharedCommandFingerprint, StudioSharingError } from './shared-command-storage';
import type { StudioDeletionCapability, StudioDeletionReceipt } from './shared-types';

type Client = Pick<Prisma.TransactionClient, 'platformSetting' | 'imageStudioTask'>;
type WorkspaceDeletion = {
  version: 1; ownerId: string; moduleId: string; moduleRevision: number; presetId: string | null;
  requestId: string; deletedAt: string;
};
export type StudioDeletedSource = {
  version: 1; ownerId: string; presetId: string; deletedModuleId: string; deletedAt: string;
  reopenedModuleId: string | null;
};
const ownerToken = (ownerId: string) => sharedCommandFingerprint(ownerId);
const moduleKey = (ownerId: string, moduleId: string) => `studio_deleted_workspace_v1:${ownerToken(ownerId)}:${moduleId}`;
const sourcePrefix = (ownerId: string) => `studio_deleted_workspace_source_v1:${ownerToken(ownerId)}:`;
const sourceKey = (ownerId: string, presetId: string) => `${sourcePrefix(ownerId)}${sharedCommandFingerprint(presetId)}`;
function record(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw new StudioSharingError('删除记录无法确认，请保留原请求编号核对', 409); }
}
function parseSource(value: string, ownerId: string): StudioDeletedSource {
  const parsed = record(value);
  if (parsed.version !== 1 || parsed.ownerId !== ownerId || typeof parsed.presetId !== 'string' || !parsed.presetId
    || typeof parsed.deletedModuleId !== 'string' || typeof parsed.deletedAt !== 'string'
    || parsed.reopenedModuleId !== null && typeof parsed.reopenedModuleId !== 'string') {
    throw new StudioSharingError('删除来源记录无法确认，请重新读取', 409);
  }
  return parsed as StudioDeletedSource;
}
export async function readStudioWorkspaceDeletion(ownerId: string, moduleId: string, client: Client = prisma): Promise<WorkspaceDeletion | null> {
  const row = await client.platformSetting.findUnique({ where: { key: moduleKey(ownerId, moduleId) }, select: { value_json: true } });
  if (!row) return null;
  const value = record(row.value_json);
  if (value.version !== 1 || value.ownerId !== ownerId || value.moduleId !== moduleId || !Number.isSafeInteger(value.moduleRevision)
    || Number(value.moduleRevision) < 0 || value.presetId !== null && typeof value.presetId !== 'string'
    || typeof value.requestId !== 'string' || typeof value.deletedAt !== 'string') {
    throw new StudioSharingError('删除工作区记录无法确认，请重新读取', 409);
  }
  return value as WorkspaceDeletion;
}
export async function assertStudioWorkspaceNotDeleted(ownerId: string, moduleId: string, client: Client = prisma) {
  if (await readStudioWorkspaceDeletion(ownerId, moduleId, client)) {
    throw new StudioSharingError('原工作区已删除，请在模板库主动重新选用；旧请求不会恢复工作区', 409);
  }
}
export async function readStudioDeletedSource(ownerId: string, presetId: string, client: Client = prisma) {
  const row = await client.platformSetting.findUnique({ where: { key: sourceKey(ownerId, presetId) }, select: { value_json: true } });
  if (!row) return null;
  const value = parseSource(row.value_json, ownerId);
  if (value.presetId !== presetId) throw new StudioSharingError('删除来源记录不匹配，请重新读取', 409);
  return value;
}
export async function listStudioDeletedSources(ownerId: string, client: Client = prisma) {
  const rows = await client.platformSetting.findMany({ where: { key: { startsWith: sourcePrefix(ownerId) } }, select: { key: true, value_json: true } });
  return rows.map(row => {
    const value = parseSource(row.value_json, ownerId);
    if (row.key !== sourceKey(ownerId, value.presetId)) throw new StudioSharingError('删除来源记录不匹配，请重新读取', 409);
    return value;
  });
}
async function writeSetting(client: Client, key: string, ownerId: string, value: unknown) {
  const value_json = JSON.stringify(value);
  await client.platformSetting.upsert({ where: { key }, create: { key, value_json, updated_by: ownerId }, update: { value_json, updated_by: ownerId } });
}
export async function recordStudioWorkspaceDeletion(client: Client, ownerId: string, moduleId: string,
  moduleRevision: number, presetId: string | null, requestId: string, deletedAt: string) {
  // The deleted id is permanent. Reselecting a valid source uses a fresh id,
  // so a late save or original open receipt can never resurrect this object.
  const value: WorkspaceDeletion = { version: 1, ownerId, moduleId, moduleRevision, presetId, requestId, deletedAt };
  await client.platformSetting.create({ data: { key: moduleKey(ownerId, moduleId), value_json: JSON.stringify(value), updated_by: ownerId } });
  if (presetId) await writeSetting(client, sourceKey(ownerId, presetId), ownerId, {
    version: 1, ownerId, presetId, deletedModuleId: moduleId, deletedAt, reopenedModuleId: null,
  } satisfies StudioDeletedSource);
}
export async function recordStudioSourceReselection(client: Client, ownerId: string, presetId: string, moduleId: string) {
  const previous = await readStudioDeletedSource(ownerId, presetId, client);
  if (previous) await writeSetting(client, sourceKey(ownerId, presetId), ownerId, { ...previous, reopenedModuleId: moduleId });
}
export function studioWorkspaceDeletionCapability(ownerId: string, moduleId: string, moduleRevision: number, saved = true): StudioDeletionCapability {
  const allowed = saved && !moduleId.startsWith('default-');
  return { version: 1, actorId: ownerId, objectKind: 'workspace', id: moduleId, moduleRevision, allowed,
    reason: allowed ? null : '默认模板需要保留，请删除其他模板' };
}
export function studioSourceDeletionCapability(actor: ImageStudioIdentity,
  source: StudioPresetAccessRow & { id: string; updated_at: Date }, archived = false): StudioDeletionCapability {
  const allowed = source.owner_id === actor.id && canManageStudioPreset(actor, source) && !archived;
  return { version: 1, actorId: actor.id, objectKind: 'source', id: source.id, sourceRevision: source.updated_at.toISOString(), allowed,
    reason: allowed ? null : archived ? '模板已删除，请重新读取' : '只能删除自己的原模板' };
}
export function parseStudioDeletionReceipt(value: Record<string, unknown>, actorId: string, objectKind: 'workspace' | 'source', id: string): StudioDeletionReceipt {
  if (value.version !== 1 || value.actorId !== actorId || value.deleted !== true || value.objectKind !== objectKind || value.id !== id || typeof value.requestId !== 'string'
    || typeof value.committedAt !== 'string' || typeof value.noOp !== 'boolean'
    || objectKind === 'workspace' && (!Number.isSafeInteger(value.moduleRevision)
      || value.sourcePresetId !== null && typeof value.sourcePresetId !== 'string')
    || objectKind === 'source' && (typeof value.sourceRevision !== 'string' || typeof value.appliedRevision !== 'string')) {
    throw new StudioSharingError('原删除回执无法确认，请保留原请求编号继续查询', 409);
  }
  return value as StudioDeletionReceipt;
}
export async function assertStudioDeletionIdle(client: Client, ownerId: string, moduleId: string) {
  // Unknown submission/output states remain protected along with active tasks.
  const pending = await client.imageStudioTask.count({ where: { owner_id: ownerId, module_id: moduleId,
    status: { notIn: ['succeeded', 'failed', 'cancelled', 'canceled'] } } });
  if (pending) throw new StudioSharingError('模板还有生成中或结果未确认的任务，请先核对原任务再删除', 409);
  const batches = await client.platformSetting.findMany({ where: { OR: [
    { key: { startsWith: `studio_batch_v1:${ownerId}:` } }, { key: { startsWith: `studio_channel_batch_v1:${ownerId}:` } },
  ], value_json: { contains: `"moduleId":${JSON.stringify(moduleId)}` } }, select: { value_json: true } });
  for (const row of batches) {
    const batch = record(row.value_json);
    if (batch.ownerId !== ownerId || batch.moduleId !== moduleId) throw new StudioSharingError('批量提交归属无法确认，请先核对原批次再删除', 409);
    if (!Array.isArray(batch.items) || typeof batch.state !== 'string') throw new StudioSharingError('批量提交状态未确认，请先核对原批次再删除', 409);
    if (batch.items.some(item => !item || typeof item !== 'object'
      || typeof item.cancelled !== 'boolean' || item.taskId !== null && typeof item.taskId !== 'string')) {
      throw new StudioSharingError('批量提交记录未确认，请先核对原批次再删除', 409);
    }
    if (batch.items.some(item => !item.cancelled && !item.taskId)) {
      throw new StudioSharingError('模板还有未完成的批量提交，请先完成或取消原批次再删除', 409);
    }
    // A saved batch receipt without its accepted task is not a completed task.
    const ids = batch.items.flatMap(item => typeof item?.taskId === 'string' ? [item.taskId] : []);
    const confirmed = await client.imageStudioTask.count({ where: { id: { in: ids }, owner_id: ownerId, module_id: moduleId,
      status: { in: ['succeeded', 'failed', 'cancelled', 'canceled'] } } });
    if (confirmed !== new Set(ids).size) throw new StudioSharingError('批量任务结果未确认，请先核对原任务再删除', 409);
  }
}
