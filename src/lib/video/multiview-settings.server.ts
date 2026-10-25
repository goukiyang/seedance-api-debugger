import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import { multiviewInfo, multiviewSourceVersion } from './multiview';
import { assertMultiviewWorkSource } from './multiview-works';
import type { MultiviewInfo } from './multiview-contract';
import { composeMultiviewGenerationPrompt, publicMultiviewRotationPreset,
  type MultiviewGenerationSnapshot } from './multiview-generation-contract';
import { assertCurrentMultiviewRotationPreset, readMultiviewRotationPresetVersion } from './multiview-preset.server';
import { isMultiviewSettingsId, isMultiviewSettingsMutationId, parseMultiviewSettingsBinding, parseMultiviewGenerationSettingsValue,
  parseMultiviewFrameSettingsInput, parseMultiviewSettingsDto,
  type MultiviewSettingsBinding, type MultiviewSettingsDto, type MultiviewSettingsSummary, type MultiviewSettingsReceipt,
  type MultiviewFrameSettingsValue, type MultiviewSettingsSource, type MultiviewSettingsApplyResult } from './multiview-settings-contract';

type Db = Prisma.TransactionClient | typeof prisma;
type Json = Record<string, unknown>;
type Stored = Omit<MultiviewSettingsDto, 'ownedByViewer'> & { schema: 1; ownerId: string };
const PREFIX = 'multiview_settings_v1:';
const ACTION = 'multiview_settings_save';
const record = (value: unknown): value is Json => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => record(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
}
const receiptId = (actorId: string, mutationId: string) => `multiview-settings-${digest(JSON.stringify([actorId, mutationId]))}`;
export class MultiviewSettingsError extends Error {
  constructor(message: string, public status = 400, public code = 'MULTIVIEW_SETTINGS_INVALID', public notCommitted = true) { super(message); }
}
const invalid = (message = '设置内容无效，原输入保留。') => new MultiviewSettingsError(message);
const unavailable = () => new MultiviewSettingsError('设置记录暂时无法确认，请保留输入并稍后重新读取。', 503, 'MULTIVIEW_SETTINGS_UNAVAILABLE', false);
const changed = () => new MultiviewSettingsError('这份设置已被更新，请重新读取；当前内容保留。', 409, 'MULTIVIEW_SETTINGS_REVISION_CONFLICT');

/** Use the same company-sharing boundary as existing templates, with a fresh account read. */
export async function assertMultiviewSettingsActor(user: SessionUser, db: Db = prisma) {
  const actor = await db.user.findUnique({ where: { id: user.id }, select: {
    id: true, role: true, account_type: true, status: true, expires_at: true, feature_profile_id: true,
    feishu_user_id: true, feishu_open_id: true, feishu_union_id: true, feishu_tenant_key: true,
  } });
  if (!actor || actor.status !== 'active' || actor.expires_at && actor.expires_at.getTime() <= Date.now()
    || !canUseCompanyTemplates(actor)) throw new AuthError('当前账号无权使用共享设置，已有输入保留。', 403);
  if (actor.role !== user.role || actor.account_type !== user.account_type || actor.feature_profile_id !== user.feature_profile_id) {
    throw new AuthError('账号授权已变化，请重新登录核对，已有输入保留。', 409);
  }
  return actor;
}
function stored(raw: string, id: string, updatedBy?: string | null): Stored {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw unavailable(); }
  if (!record(value) || Object.keys(value).some(key => !['schema', 'ownerId', 'id', 'kind', 'name', 'isShared', 'revision', 'createdAt', 'updatedAt', 'contentHash', 'value'].includes(key))
    || value.schema !== 1 || typeof value.ownerId !== 'string' || !value.ownerId || value.ownerId.length > 160
    || value.id !== id || updatedBy !== undefined && updatedBy !== value.ownerId) throw unavailable();
  const { schema: _schema, ownerId: _ownerId, ...projection } = value;
  const dto = parseMultiviewSettingsDto({ ...projection, ownedByViewer: true });
  if (!dto || digest(stable(dto.value)) !== dto.contentHash) throw unavailable();
  return { schema: 1, ownerId: value.ownerId, ...projection } as Stored;
}
function dto(value: Stored, userId: string): MultiviewSettingsDto {
  const { ownerId, schema: _schema, ...result } = value;
  return { ...result, ownedByViewer: ownerId === userId } as MultiviewSettingsDto;
}
function visible(value: Stored, actorId: string) { return value.ownerId === actorId || value.isShared; }
async function readRow(user: SessionUser, id: string, db: Db = prisma) {
  if (!isMultiviewSettingsId(id)) throw invalid('设置编号无效。');
  const row = await db.platformSetting.findUnique({ where: { key: PREFIX + id } });
  if (!row) throw new MultiviewSettingsError('设置不存在或已不可用，当前内容保留。', 404, 'MULTIVIEW_SETTINGS_NOT_FOUND');
  const value = stored(row.value_json, id, row.updated_by);
  if (!visible(value, user.id)) throw new MultiviewSettingsError('这份设置已不再共享，当前内容保留。', 403, 'MULTIVIEW_SETTINGS_ACCESS_REVOKED');
  return { row, value };
}
export async function readMultiviewSettings(user: SessionUser, id: string, db: Db = prisma) {
  await assertMultiviewSettingsActor(user, db);
  return dto((await readRow(user, id, db)).value, user.id);
}
export async function listMultiviewSettings(user: SessionUser, kind: string | null, cursor: string | null) {
  await assertMultiviewSettingsActor(user);
  if (kind !== 'generation' && kind !== 'frame' || cursor !== null && !isMultiviewSettingsId(cursor)) throw invalid('设置列表条件无效。');
  const rows = await prisma.platformSetting.findMany({ where: { key: { startsWith: PREFIX }, AND: [
    { OR: [{ updated_by: user.id }, { value_json: { contains: '"isShared":true' } }] },
    { value_json: { contains: `"kind":"${kind}"` } },
  ] }, orderBy: [{ created_at: 'desc' }, { key: 'desc' }], take: 25,
  ...(cursor ? { cursor: { key: PREFIX + cursor }, skip: 1 } : {}) });
  const page = rows.slice(0, 24);
  const items: MultiviewSettingsSummary[] = page.map(row => {
    const value = stored(row.value_json, row.key.slice(PREFIX.length), row.updated_by);
    if (!visible(value, user.id) || value.kind !== kind) throw unavailable();
    const { value: _value, contentHash: _hash, ...summary } = dto(value, user.id);
    return summary;
  });
  return { items, nextCursor: rows.length > 24 ? items[items.length - 1].id : null };
}
function parseSource(value: unknown): MultiviewSettingsSource {
  if (!record(value) || Object.keys(value).some(key => !['taskId', 'sourceVersion'].includes(key)) || typeof value.taskId !== 'string'
    || !/^[A-Za-z0-9_-]{1,160}$/.test(value.taskId) || typeof value.sourceVersion !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceVersion)) {
    throw invalid('请保留原视频与版本后再保存或套用选帧方案。');
  }
  return { taskId: value.taskId, sourceVersion: value.sourceVersion };
}
/** Prove constant cadence against every timestamp, rather than trusting a nominal FPS label. */
export function multiviewSettingsTiming(info: Pick<MultiviewInfo, 'timestamps' | 'duration'>, slots: Array<{ frame: number }>) {
  const times = info.timestamps;
  if (!Array.isArray(times) || times.length < 8 || times.length > 21600 || !Number.isFinite(info.duration) || info.duration <= 0 || info.duration > 180
    || times.some((time, index) => !Number.isFinite(time) || time < 0 || time > 180 || index > 0 && time <= times[index - 1])
    || times[0] !== 0 || slots.some(slot => !Number.isSafeInteger(slot.frame) || slot.frame < 0 || slot.frame >= times.length)) {
    throw invalid('原视频的完整帧时间轴无法确认，未保存或套用帧位置。');
  }
  const step = times[times.length - 1] / (times.length - 1), inferred = 1 / step;
  const fps = inferred <= 240 && times.every((time, index) => Math.abs(time - index * step) <= 0.000003)
    ? Math.round(inferred * 1000000) / 1000000 : null;
  return { frameCount: times.length, duration: info.duration, fps,
    timelineHash: digest(JSON.stringify(times.map(time => Math.round(time * 1000000)))),
    selectedTimestamps: slots.map(slot => Math.round(times[slot.frame] * 1000000) / 1000000) };
}
export function assertMultiviewFrameSettingsCompatible(value: MultiviewFrameSettingsValue, info: Pick<MultiviewInfo, 'timestamps' | 'duration'>) {
  if (value.slots.some(slot => slot.frame >= info.timestamps.length)) throw new MultiviewSettingsError('当前视频太短，不能套用这份选帧方案；当前拼图保留。', 409, 'FRAME_SETTINGS_INAPPLICABLE');
  const target = multiviewSettingsTiming(info, value.slots), source = value.timing;
  const compatible = source.fps !== null && target.fps !== null
    ? Math.abs(source.fps - target.fps) <= 0.00001
      && source.selectedTimestamps.every((time, index) => Math.abs(time - target.selectedTimestamps[index]) <= 0.000003)
    : source.fps === null && target.fps === null && source.timelineHash === target.timelineHash
      && source.frameCount === target.frameCount && source.duration === target.duration;
  if (!compatible) throw new MultiviewSettingsError('当前视频帧率或时间轴不同，这份选帧方案不适用；当前拼图保留。', 409, 'FRAME_SETTINGS_INAPPLICABLE');
}
async function sourceInfo(user: SessionUser, source: MultiviewSettingsSource, request: Request) {
  const info = await multiviewInfo(user, source.taskId, request);
  if (info.sourceVersion !== source.sourceVersion) throw new MultiviewSettingsError('原视频版本已改变，当前拼图保留。', 409, 'MULTIVIEW_SETTINGS_SOURCE_CHANGED');
  return info;
}
async function readReceipt(user: SessionUser, mutationId: string, db: Db) {
  if (!isMultiviewSettingsMutationId(mutationId)) throw invalid('保存操作编号无效。');
  const row = await db.operationLog.findUnique({ where: { id: receiptId(user.id, mutationId) } });
  if (!row) return null;
  let value: unknown;
  try { value = JSON.parse(row.detail || '{}'); } catch { throw unavailable(); }
  if (row.operator_id !== user.id || row.action !== ACTION || row.target_type !== 'MultiviewSettings' || !record(value)
    || typeof value.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.requestHash) || !record(value.receipt)) throw unavailable();
  const receipt = value.receipt;
  const settings = parseMultiviewSettingsDto(receipt.settings);
  if (receipt.state !== 'committed' || receipt.mutationId !== mutationId || !['create', 'save', 'rename', 'delete'].includes(String(receipt.action))
    || !settings || !settings.ownedByViewer || row.target_id !== settings.id || digest(stable(settings.value)) !== settings.contentHash) throw unavailable();
  return { requestHash: value.requestHash, receipt: { state: 'committed', mutationId, action: receipt.action, settings } as MultiviewSettingsReceipt };
}
export async function readMultiviewSettingsMutation(user: SessionUser, mutationId: string) {
  await assertMultiviewSettingsActor(user);
  return (await readReceipt(user, mutationId, prisma))?.receipt ?? { state: 'not_found' as const, mutationId };
}
export async function manageMultiviewSettings(user: SessionUser, id: string, input: unknown, action: 'rename' | 'delete'): Promise<MultiviewSettingsReceipt> {
  await assertMultiviewSettingsActor(user);
  if (!isMultiviewSettingsId(id) || !record(input) || Object.keys(input).some(key => !['mutationId', 'expectedRevision', ...(action === 'rename' ? ['action', 'name'] : [])].includes(key))
    || !isMultiviewSettingsMutationId(input.mutationId) || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1
    || action === 'rename' && (input.action !== 'rename' || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80)) throw invalid();
  const mutationId = input.mutationId;
  const requestHash = digest(stable({ id, action, ...input }));
  const replay = async (db: Db) => {
    const found = await readReceipt(user, mutationId, db);
    if (found && found.requestHash !== requestHash) throw new MultiviewSettingsError('原操作编号对应其他内容，请先核对原操作。', 409, 'MULTIVIEW_SETTINGS_MUTATION_CONFLICT', false);
    return found?.receipt || null;
  };
  const prior = await replay(prisma); if (prior) return prior;
  try {
    return await prisma.$transaction(async db => {
      await assertMultiviewSettingsActor(user, db);
      const prior = await replay(db); if (prior) return prior;
      const current = await readRow(user, id, db);
      if (current.value.ownerId !== user.id) throw new MultiviewSettingsError('只能管理本人保存的设置。', 403, 'MULTIVIEW_SETTINGS_NOT_OWNER');
      if (current.value.revision !== input.expectedRevision) throw changed();
      const next = action === 'rename' ? { ...current.value, name: (input.name as string).trim(), revision: current.value.revision + 1, updatedAt: new Date().toISOString() } : current.value;
      if (!Number.isSafeInteger(next.revision)) throw invalid();
      const where = { key: current.row.key, value_json: current.row.value_json, updated_by: user.id };
      const changedRow = action === 'delete' ? await db.platformSetting.deleteMany({ where })
        : await db.platformSetting.updateMany({ where, data: { value_json: JSON.stringify(next), updated_by: user.id } });
      if (changedRow.count !== 1) throw changed();
      const receipt: MultiviewSettingsReceipt = { state: 'committed', mutationId, action, settings: dto(next, user.id) };
      await db.operationLog.create({ data: { id: receiptId(user.id, mutationId), operator_id: user.id, action: ACTION,
        target_type: 'MultiviewSettings', target_id: id, detail: JSON.stringify({ requestHash, receipt }) } });
      return receipt;
    });
  } catch (error) {
    if (error instanceof MultiviewSettingsError || error instanceof AuthError) throw error;
    const prior = await replay(prisma).catch(() => null); if (prior) return prior;
    throw new MultiviewSettingsError('操作结果待确认，请查询原操作，不要重复提交。', 503, 'MULTIVIEW_SETTINGS_SAVE_UNKNOWN', false);
  }
}
async function generationSavePreset(user: SessionUser, presetVersion: string, rawBinding: unknown, db: Db = prisma) {
  const actor = await assertMultiviewSettingsActor(user, db);
  if (rawBinding !== undefined) {
    const binding = parseMultiviewSettingsBinding(rawBinding);
    if (!binding) throw invalid('原共享设置的来路无效，未保存。');
    return (await resolveMultiviewGenerationSettings(user, presetVersion, binding, db)).preset;
  }
  // An immutable historical revision is storage, not a grant to discover or copy it.
  if (actor.role === 'admin') return readMultiviewRotationPresetVersion(presetVersion, db);
  return (await assertCurrentMultiviewRotationPreset(presetVersion, db)).preset;
}
export async function saveMultiviewSettings(user: SessionUser, input: unknown, request: Request, id?: string): Promise<MultiviewSettingsReceipt> {
  await assertMultiviewSettingsActor(user);
  if (!record(input) || Object.keys(input).some(key => !(id
    ? ['mutationId', 'expectedRevision', 'name', 'isShared', 'value', 'source', 'sourceSettingsBinding'] : ['mutationId', 'kind', 'name', 'isShared', 'value', 'source', 'sourceSettingsBinding']).includes(key))
    || !isMultiviewSettingsMutationId(input.mutationId)) throw invalid();
  const mutationId = input.mutationId, action = id ? 'save' as const : 'create' as const;
  const requestHash = digest(stable({ id: id || null, action, ...input }));
  const replay = async (db: Db) => {
    const found = await readReceipt(user, mutationId, db);
    if (found && found.requestHash !== requestHash) throw new MultiviewSettingsError('原保存编号对应其他内容，请先核对原保存；没有覆盖原记录。', 409, 'MULTIVIEW_SETTINGS_MUTATION_CONFLICT', false);
    return found?.receipt || null;
  };
  const prior = await replay(prisma);
  if (prior) return prior;
  const original = id ? await readMultiviewSettings(user, id) : null;
  if (original && !original.ownedByViewer) throw new MultiviewSettingsError('只能修改本人保存的设置；可将共享设置另存为自己的方案。', 403, 'MULTIVIEW_SETTINGS_NOT_OWNER');
  const kind = original?.kind ?? input.kind;
  if (kind !== 'generation' && kind !== 'frame' || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80
    || input.isShared !== undefined && typeof input.isShared !== 'boolean'
    || id && (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1)) throw invalid('保存须提供名称和当前保存版本。');
  const source = kind === 'frame' ? parseSource(input.source) : null;
  if (kind === 'generation' && input.source !== undefined) throw invalid('生成设置不能包含源媒体或项目归属。');
  if (kind === 'frame' && input.sourceSettingsBinding !== undefined) throw invalid('选帧方案不接收生成模板提示词来路。');
  let value;
  if (kind === 'generation') {
    value = parseMultiviewGenerationSettingsValue(input.value);
    if (!value) throw invalid('生成设置包含无效参数或个人素材字段，未保存。');
    const preset = await generationSavePreset(user, value.presetVersion, input.sourceSettingsBinding);
    const composed = composeMultiviewGenerationPrompt(value.supplement, value.presetVersion, preset);
    if (!composed.valid) throw invalid(composed.error || '保存提示词过长，未截断内容。');
  } else {
    const parsed = parseMultiviewFrameSettingsInput(input.value);
    if (!parsed) throw invalid('选帧方案须保留3、4或8格的实际帧号和名称，不能包含媒体或排版字段。');
    const info = await sourceInfo(user, source!, request);
    value = { ...parsed, timing: multiviewSettingsTiming(info, parsed.slots) };
  }
  const settingsId = id || `mvs_${randomUUID()}`;
  try {
    return await prisma.$transaction(async db => {
      await assertMultiviewSettingsActor(user, db);
      const saved = await replay(db); if (saved) return saved;
      const current = id ? await readRow(user, id, db) : null;
      if (current && current.value.ownerId !== user.id) throw new MultiviewSettingsError('只能修改本人保存的设置；可将共享设置另存为自己的方案。', 403, 'MULTIVIEW_SETTINGS_NOT_OWNER');
      if (current && current.value.revision !== input.expectedRevision) throw changed();
      if (source) {
        await assertMultiviewWorkSource(user, source.taskId, db);
        if (await multiviewSourceVersion(user, source.taskId) !== source.sourceVersion) throw new MultiviewSettingsError('原视频版本已改变，未保存帧位置。', 409, 'MULTIVIEW_SETTINGS_SOURCE_CHANGED');
      } else if (kind === 'generation') {
        const generation = parseMultiviewGenerationSettingsValue(value)!;
        await generationSavePreset(user, generation.presetVersion, input.sourceSettingsBinding, db);
      }
      const revision = current ? current.value.revision + 1 : 1;
      if (!Number.isSafeInteger(revision)) throw invalid('设置版本已到上限，未覆盖原记录。');
      const now = new Date().toISOString();
      const next = { schema: 1, ownerId: user.id, id: settingsId, kind, name: input.name as string,
        isShared: input.isShared === undefined ? current?.value.isShared ?? true : input.isShared as boolean,
        revision, createdAt: current?.value.createdAt || now, updatedAt: now, value, contentHash: digest(stable(value)) } as Stored;
      const raw = JSON.stringify(next);
      if (current) {
        const updated = await db.platformSetting.updateMany({ where: { key: current.row.key, value_json: current.row.value_json, updated_by: user.id },
          data: { value_json: raw, updated_by: user.id } });
        if (updated.count !== 1) throw changed();
      } else await db.platformSetting.create({ data: { key: PREFIX + settingsId, value_json: raw, updated_by: user.id } });
      const receipt: MultiviewSettingsReceipt = { state: 'committed', mutationId, action, settings: dto(next, user.id) };
      await db.operationLog.create({ data: { id: receiptId(user.id, mutationId), operator_id: user.id, action: ACTION,
        target_type: 'MultiviewSettings', target_id: settingsId, detail: JSON.stringify({ requestHash, receipt }) } });
      return receipt;
    });
  } catch (error) {
    if (error instanceof MultiviewSettingsError || error instanceof AuthError) throw error;
    const saved = await replay(prisma).catch(() => null); if (saved) return saved;
    throw new MultiviewSettingsError('保存结果待确认，请保留输入并核对原保存编号，不要重新保存。', 503, 'MULTIVIEW_SETTINGS_SAVE_UNKNOWN', false);
  }
}
export async function applyMultiviewSettings(user: SessionUser, id: string, input: unknown, request: Request): Promise<MultiviewSettingsApplyResult> {
  if (!record(input) || Object.keys(input).some(key => !['expectedRevision', 'target'].includes(key)) || !Number.isSafeInteger(input.expectedRevision)) throw invalid();
  const settings = await readMultiviewSettings(user, id);
  if (settings.revision !== input.expectedRevision) throw changed();
  if (settings.kind === 'generation') {
    if (input.target !== undefined) throw invalid('生成设置不接收媒体或项目归属。');
    const preset = await readMultiviewRotationPresetVersion(settings.value.presetVersion);
    if (!composeMultiviewGenerationPrompt(settings.value.supplement, preset.version, preset).valid) throw unavailable();
    return { settings, preset: publicMultiviewRotationPreset(preset) };
  }
  const target = parseSource(input.target);
  const info = await sourceInfo(user, target, request);
  assertMultiviewFrameSettingsCompatible(settings.value, info);
  // Preparation may await media IO; recheck both source and sharing after that await.
  const fresh = await readMultiviewSettings(user, id);
  if (fresh.revision !== settings.revision || fresh.contentHash !== settings.contentHash) throw changed();
  if (await multiviewSourceVersion(user, target.taskId) !== target.sourceVersion) throw new MultiviewSettingsError('原视频版本已改变，当前拼图保留。', 409, 'MULTIVIEW_SETTINGS_SOURCE_CHANGED');
  return { settings: fresh, slots: settings.value.slots.map(slot => ({ ...slot })) };
}
/** Only new quote/acceptance calls use this live gate; accepted-request lookup stays before it. */
export async function resolveMultiviewGenerationSettings(user: SessionUser, presetVersion: string, binding?: MultiviewSettingsBinding, db: Db = prisma) {
  if (!binding) return assertCurrentMultiviewRotationPreset(presetVersion, db);
  const parsed = parseMultiviewSettingsBinding(binding);
  if (!parsed) throw invalid('已保存设置的绑定无效，原输入保留。');
  const settings = await readMultiviewSettings(user, parsed.id, db);
  if (settings.kind !== 'generation' || settings.revision !== parsed.revision || settings.value.presetVersion !== presetVersion) throw changed();
  const preset = await readMultiviewRotationPresetVersion(settings.value.presetVersion, db);
  return { preset, revision: settings.revision, settings: { id: settings.id, revision: settings.revision, contentHash: settings.contentHash } };
}
export async function assertMultiviewGenerationSettings(user: SessionUser, snapshot: MultiviewGenerationSnapshot, db: Db = prisma) {
  return resolveMultiviewGenerationSettings(user, snapshot.presetVersion, snapshot.settingsBinding, db);
}
