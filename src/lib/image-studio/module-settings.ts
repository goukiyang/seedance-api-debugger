import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { canUseCompanyTemplates, type ImageStudioIdentity } from './access';
import { assertStudioActor, parseSharedStudioPersonalOverrides, resolveSharedStudioDefinition, StudioSharingError } from './shared-contract';
import { validStudioModuleId } from './modules';
import { studioVisibleAssetWhere } from './protected-assets';
import { parseStudioStyleIds, resolveStudioStyleReferences, StudioStyleError } from './style-groups';
import { studioTemplateAssetUrl } from './media';
import { MAX_REFERENCE_IMAGES } from './limits';
import type { StudioModuleSettings, StudioModuleSettingsCommand } from './module-settings-types';

type Client = Prisma.TransactionClient;
type Stored = StudioModuleSettings & { fingerprint: string };
const prefix = (ownerId: string, moduleId: string) => `studio_named_settings_v1:${encodeURIComponent(ownerId)}:${moduleId}:`;
const validRequestId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9-]{16,80}$/.test(value);
export class StudioModuleSettingsError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
function parseCommand(raw: unknown, ownerId: string): StudioModuleSettingsCommand {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new StudioModuleSettingsError('设置内容无效');
  const input = raw as StudioModuleSettingsCommand;
  if (Object.keys(input).some(key => !['requestId', 'moduleId', 'moduleRevision', 'definitionToken', 'name', 'values'].includes(key))
    || !validRequestId(input.requestId) || !validStudioModuleId(input.moduleId, ownerId)
    || !Number.isSafeInteger(input.moduleRevision) || input.moduleRevision < 0
    || typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80
    || input.definitionToken !== undefined && (typeof input.definitionToken !== 'string' || input.definitionToken.length > 200)) {
    throw new StudioModuleSettingsError('请填写设置名称并确认当前模板');
  }
  const values = input.values;
  if (!values || typeof values !== 'object' || Array.isArray(values)
    || Object.keys(values).sort().join(',') !== 'aspectRatio,count,model,prompt,quality,referenceIds,resolution,styleGroupIds') {
    throw new StudioModuleSettingsError('只保存本次生成设置，不包含模板内部定义或主图');
  }
  const { styleGroupIds, referenceIds, ...personal } = values;
  const parsed = parseSharedStudioPersonalOverrides(personal);
  if (Object.keys(parsed).length !== 6 || !Array.isArray(referenceIds) || referenceIds.length > MAX_REFERENCE_IMAGES
    || referenceIds.some(id => typeof id !== 'string' || !id || id.length > 100) || new Set(referenceIds).size !== referenceIds.length) {
    throw new StudioModuleSettingsError('生成设置或临时参考不完整，当前输入保留');
  }
  return { requestId: input.requestId, moduleId: input.moduleId, moduleRevision: input.moduleRevision,
    ...(input.definitionToken !== undefined ? { definitionToken: input.definitionToken } : {}), name: input.name.trim(),
    values: { ...parsed as Required<typeof parsed>, styleGroupIds: parseStudioStyleIds(styleGroupIds), referenceIds } };
}
function readStored(value: string, ownerId: string, moduleId: string, id?: string): Stored {
  const row = JSON.parse(value) as Stored;
  if (row.version !== 1 || row.ownerId !== ownerId || row.moduleId !== moduleId || !validRequestId(row.id)
    || id !== undefined && row.id !== id || typeof row.name !== 'string' || !row.values
    || typeof row.fingerprint !== 'string' || typeof row.createdAt !== 'string') {
    throw new StudioModuleSettingsError('已保存的设置无法读取，请保留原记录', 503);
  }
  return row;
}
function dto({ fingerprint: _fingerprint, ...row }: Stored): StudioModuleSettings { return row; }
async function actor(user: ImageStudioIdentity, client: Client) {
  const fresh = await assertStudioActor(user.id, client);
  if (!canUseCompanyTemplates(fresh)) throw new StudioModuleSettingsError('无权使用模板设置', 403);
  return fresh;
}
async function workspace(user: ImageStudioIdentity, moduleId: string, client: Client) {
  if (!validStudioModuleId(moduleId, user.id)) throw new StudioModuleSettingsError('模板不存在或无权使用', 404);
  const row = await client.imageStudioModule.findFirst({ where: { id: moduleId, owner_id: user.id } });
  if (!row) throw new StudioModuleSettingsError('模板不存在或已删除，设置不会新建模板', 404);
  const source = row.source_preset_id ? await resolveSharedStudioDefinition(user, row.source_preset_id, client) : null;
  return { row, source };
}
async function materialize(user: ImageStudioIdentity, row: Stored, client: Client,
  source: Awaited<ReturnType<typeof resolveSharedStudioDefinition>> | null) {
  // Resolve the current template before reusing its style projection. Additional
  // choices still require this actor's own access.
  const template = new Map((source?.definition.styleGroups || []).map(group => [group.id, group]));
  const extra = await resolveStudioStyleReferences(user, row.values.styleGroupIds.filter(id => !template.has(id)), client);
  const chosen = new Map(extra.groups.map(group => [group.id, group]));
  const groups = row.values.styleGroupIds.map(id => template.get(id) || chosen.get(id)!);
  const assets = await client.asset.findMany({ where: { id: { in: row.values.referenceIds }, owner_id: user.id,
    type: 'image', status: 'active', AND: [await studioVisibleAssetWhere(user, client)] },
    select: { id: true, width: true, height: true } });
  if (assets.length !== row.values.referenceIds.length) throw new StudioModuleSettingsError('设置中的临时参考已不可用，当前输入保留', 409);
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  return { ...dto(row), styleGroups: groups.map(group => ({ id: group.id, name: group.name, revision: group.revision,
    referenceCount: group.references.length, canManage: user.role === 'admin' || group.ownerId === user.id,
    coverUrl: `/api/image-studio/style-groups/${group.id}/cover?revision=${group.revision}` })),
    images: row.values.referenceIds.map(id => ({ ...byId.get(id)!, originalUrl: studioTemplateAssetUrl(id), thumbnailUrl: studioTemplateAssetUrl(id, true) })) };
}
export async function listStudioModuleSettings(user: ImageStudioIdentity, moduleId: string, id?: string) {
  return prisma.$transaction(async tx => {
    const fresh = await actor(user, tx); const current = await workspace(fresh, moduleId, tx);
    if (id !== undefined) {
      if (!validRequestId(id)) throw new StudioModuleSettingsError('设置编号无效');
      const saved = await tx.platformSetting.findUnique({ where: { key: prefix(fresh.id, moduleId) + id } });
      if (!saved) throw new StudioModuleSettingsError('这套设置已不可用，请重新选择', 404);
      return { setting: await materialize(fresh, readStored(saved.value_json, fresh.id, moduleId, id), tx, current.source) };
    }
    const rows = await tx.platformSetting.findMany({ where: { key: { startsWith: prefix(fresh.id, moduleId) } }, orderBy: { created_at: 'desc' } });
    // The picker reads names and values only. Resolve references once on explicit apply.
    return { settings: rows.map(row => dto(readStored(row.value_json, fresh.id, moduleId))) };
  });
}
export async function studioModuleSettingsStatus(user: ImageStudioIdentity, moduleId: string, requestId: string) {
  return prisma.$transaction(async tx => {
    const fresh = await actor(user, tx);
    if (!validStudioModuleId(moduleId, fresh.id) || !validRequestId(requestId)) throw new StudioModuleSettingsError('原保存查询无效');
    const row = await tx.platformSetting.findUnique({ where: { key: prefix(fresh.id, moduleId) + requestId } });
    return row ? { status: 'completed' as const, setting: dto(readStored(row.value_json, fresh.id, moduleId, requestId)) }
      : { status: 'not-found' as const };
  });
}
export async function saveStudioModuleSettings(user: ImageStudioIdentity, raw: unknown) {
  try {
    const command = parseCommand(raw, user.id);
    const fingerprint = createHash('sha256').update(JSON.stringify(command)).digest('hex');
    return await prisma.$transaction(async tx => {
      const fresh = await actor(user, tx);
      const key = prefix(fresh.id, command.moduleId) + command.requestId;
      const previous = await tx.platformSetting.findUnique({ where: { key } });
      if (previous) {
        const row = readStored(previous.value_json, fresh.id, command.moduleId, command.requestId);
        if (row.fingerprint !== fingerprint) throw new StudioModuleSettingsError('原保存编号已用于其他设置，请核对原操作', 409);
        return { saved: true, setting: dto(row), replayed: true };
      }
      const current = await workspace(fresh, command.moduleId, tx);
      if (current.row.revision !== command.moduleRevision || current.source
        && current.source.definition.intent.definitionToken !== command.definitionToken) {
        throw new StudioModuleSettingsError('模板已更新，请重新读取后另存；当前输入保留', 409);
      }
      const row: Stored = { version: 1, id: command.requestId, ownerId: fresh.id, moduleId: command.moduleId,
        name: command.name, values: command.values, createdAt: new Date().toISOString(), fingerprint };
      await materialize(fresh, row, tx, current.source);
      await tx.platformSetting.create({ data: { key, value_json: JSON.stringify(row), updated_by: fresh.id } });
      return { saved: true, setting: dto(row), replayed: false };
    });
  } catch (error) {
    // Only a rolled-back business rejection plus a fresh absence of this exact
    // receipt can release the browser's original command. DB/transport errors stay unknown.
    if ((error instanceof StudioModuleSettingsError || error instanceof StudioSharingError || error instanceof StudioStyleError) && error.status < 500) {
      const input = raw as Partial<StudioModuleSettingsCommand> | null;
      if (input && validStudioModuleId(input.moduleId, user.id) && validRequestId(input.requestId)) {
        const proof = await studioModuleSettingsStatus(user, input.moduleId as string, input.requestId).catch(() => null);
        if (proof?.status === 'not-found') Object.assign(error, { commandOutcome: { status: 'not-applied', moduleId: input.moduleId, requestId: input.requestId } });
      }
    }
    throw error;
  }
}
