import { createHash, randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { canUseCompanyTemplates, type ImageStudioIdentity } from './access';
import { parseStudioFixedReferences, type StudioFixedReference } from './fixed-references';
import { MAX_REFERENCE_IMAGES } from './limits';
import { studioVisibleAssetWhere } from './protected-assets';
import { historicalStudioStyles } from './style-history';
import { STUDIO_STYLE_GROUP_WRITES_ENABLED } from './style-groups-build-mode';

const PREFIX = 'studio_style_group_v1:';
const MAX_STYLE_GROUP_NOTE_LENGTH = 8000;
const selectionKey = (moduleId: string) => `studio_style_selection_v1:${moduleId}`;
type Client = Pick<Prisma.TransactionClient, 'platformSetting' | 'asset' | 'imageStudioModule' | 'imageStudioPreset' | 'imageStudioTask'>;
export type StudioStyleGroup = {
  id: string; ownerId: string; name: string; coverAssetId: string; references: StudioFixedReference[];
  revision: number; note?: string; deleted?: boolean; disabled?: boolean; shared?: boolean; source?: { id: string; taskId?: string; revision?: number };
};
export class StudioStyleError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
function identity(user: ImageStudioIdentity) {
  if (!canUseCompanyTemplates(user)) throw new StudioStyleError('仅限公司账号使用风格组', 403);
}
export function canManageStudioStyle(user: ImageStudioIdentity, group: Pick<StudioStyleGroup, 'ownerId'>) {
  return canUseCompanyTemplates(user) && (user.role === 'admin' || group.ownerId === user.id);
}
function decode(value: string): StudioStyleGroup {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed.id !== 'string' || typeof parsed.ownerId !== 'string' || typeof parsed.name !== 'string'
      || typeof parsed.coverAssetId !== 'string' || !Number.isInteger(parsed.revision)
      || (parsed.note !== undefined && typeof parsed.note !== 'string')) throw new Error();
    // Preserve an absent note as absent so the legacy JSON compare-and-swap stays byte-shape compatible.
    return { ...parsed, references: parseStudioFixedReferences(parsed.references) };
  } catch { throw new StudioStyleError('风格组暂时无法读取', 503); }
}
export function parseStudioStyleIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_REFERENCE_IMAGES
    || value.some(id => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))) throw new StudioStyleError('风格组选择无效');
  return Array.from(new Set(value as string[]));
}
export async function getStudioStyleGroup(user: ImageStudioIdentity, id: string, client: Client = prisma) {
  identity(user);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new StudioStyleError('风格组不存在', 404);
  const row = await client.platformSetting.findUnique({ where: { key: `${PREFIX}${id}` }, select: { value_json: true } });
  if (!row) throw new StudioStyleError('风格组已删除或不存在', 404);
  const group = decode(row.value_json);
  if (group.deleted) throw new StudioStyleError('风格组已删除，请重新选择', 409);
  if (group.shared === false && !canManageStudioStyle(user, group)) throw new StudioStyleError('无权使用这个私人风格组', 403);
  return group;
}
export async function studioStyleDTO(user: ImageStudioIdentity, group: StudioStyleGroup, client: Client = prisma) {
  const canManage = canManageStudioStyle(user, group);
  const assets = canManage ? await client.asset.findMany({ where: { id: { in: group.references.map(ref => ref.assetId) }, type: 'image', status: 'active' },
    select: { id: true, width: true, height: true } }) : [];
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  return { id: group.id, name: group.name, ownerId: group.ownerId, revision: group.revision, canManage, canReadContent: canManage, canCopy: canManage,
    shared: group.shared !== false, disabled: group.disabled === true, ...(group.disabled ? { unavailable: true } : {}),
    coverUrl: `/api/image-studio/style-groups/${group.id}/cover?revision=${group.revision}`,
    referenceCount: group.references.length,
    ...(canManage ? { note: group.note ?? '', coverAssetId: group.coverAssetId, references: group.references.map(ref => {
      const asset = byId.get(ref.assetId);
      return { id: ref.assetId, note: ref.note, available: Boolean(asset), width: asset?.width || null, height: asset?.height || null,
        originalUrl: asset ? `/api/image-studio/style-groups/${group.id}/assets/${ref.assetId}` : null,
        thumbnailUrl: asset ? `/api/image-studio/style-groups/${group.id}/assets/${ref.assetId}?thumbnail=1` : null };
    }) } : {}),
  };
}
export async function listStudioStyleGroups(user: ImageStudioIdentity, cursor?: string) {
  return listStudioStyleGroupsPage(user, { cursor });
}
export type StudioSelectorPageOptions = { cursor?: string; query?: string; keys?: string[]; scope?: string };
export function validateStudioSelectorPage(options: StudioSelectorPageOptions) {
  if (options.query && options.query.length > 160 || options.cursor && !/^[0-9a-f-]{36}$/i.test(options.cursor)
    || options.keys && (options.keys.length > 100 || options.keys.some(id => !/^[0-9a-f-]{36}$/i.test(id)))) {
    throw new StudioStyleError('选择列表的搜索或分页条件无效');
  }
}
export async function listStudioStyleGroupsPage(user: ImageStudioIdentity, options: StudioSelectorPageOptions = {}) {
  identity(user); validateStudioSelectorPage(options);
  if (options.keys && !options.keys.length) return { groups: [], nextCursor: null };
  const query = options.query?.trim() || '';
  // Every company user may read names/covers. Notes remain searchable only by their existing managers.
  const rows = await prisma.$queryRaw<Array<{ key: string; value_json: string }>>(Prisma.sql`
    SELECT key, value_json FROM PlatformSetting
    WHERE key >= ${PREFIX} AND key < ${PREFIX + '\uffff'}
      AND json_valid(value_json) AND COALESCE(json_extract(value_json, '$.deleted'), 0) != 1
      AND (COALESCE(json_extract(value_json, '$.shared'), 1) = 1 OR json_extract(value_json, '$.ownerId') = ${user.id} OR ${user.role === 'admin' ? 1 : 0} = 1)
      AND (COALESCE(json_extract(value_json, '$.disabled'), 0) = 0 OR json_extract(value_json, '$.ownerId') = ${user.id} OR ${user.role === 'admin' ? 1 : 0} = 1)
      ${options.scope === 'mine' ? Prisma.sql`AND json_extract(value_json, '$.ownerId') = ${user.id}` : Prisma.empty}
      ${options.scope === 'shared' ? Prisma.sql`AND COALESCE(json_extract(value_json, '$.shared'), 1) = 1` : Prisma.empty}
      ${options.cursor ? Prisma.sql`AND key > ${PREFIX + options.cursor}` : Prisma.empty}
      ${options.keys ? Prisma.sql`AND key IN (${Prisma.join(options.keys.map(id => PREFIX + id))})` : Prisma.empty}
      AND (${query} = '' OR instr(lower(json_extract(value_json, '$.name')), lower(${query})) > 0
        OR ((${user.role === 'admin' ? 1 : 0} = 1 OR json_extract(value_json, '$.ownerId') = ${user.id})
          AND instr(lower(COALESCE(json_extract(value_json, '$.note'), '')), lower(${query})) > 0))
    ORDER BY key ASC LIMIT 49`);
  const page = rows.slice(0, 48);
  return { groups: await Promise.all(page.map(row => studioStyleDTO(user, decode(row.value_json)))),
    nextCursor: rows.length > 48 ? page[page.length - 1].key.slice(PREFIX.length) : null };
}
export async function getStudioModuleStyleIds(ownerId: string, moduleId: string, client: Client = prisma, kind: 'module' | 'preset' = 'module') {
  const row = await client.platformSetting.findUnique({ where: { key: kind === 'preset' ? `studio_style_preset_selection_v1:${moduleId}` : selectionKey(moduleId) }, select: { value_json: true } });
  if (!row) return [];
  try {
    const value = JSON.parse(row.value_json);
    if (value.ownerId !== ownerId) throw new Error();
    return parseStudioStyleIds(value.ids);
  } catch { throw new StudioStyleError('已保存的风格组选择无法读取', 503); }
}
export async function resolveStudioStyleReferences(user: ImageStudioIdentity, ids: string[], client: Client = prisma) {
  const groups = await Promise.all(ids.map(id => getStudioStyleGroup(user, id, client)));
  if (groups.some(group => group.disabled)) throw new StudioStyleError('风格组已停用，请移除或替换', 409);
  const references = groups.flatMap(group => group.references);
  if (references.length > MAX_REFERENCE_IMAGES) throw new StudioStyleError(`风格组图片合计不能超过 ${MAX_REFERENCE_IMAGES} 张`);
  return { groups, references };
}
export async function setStudioModuleStyleIds(user: ImageStudioIdentity, moduleId: string, value: unknown, client: Client = prisma) {
  const ids = parseStudioStyleIds(value);
  const studioModule = await client.imageStudioModule.findFirst({ where: { id: moduleId, owner_id: user.id }, select: { id: true } });
  if (!studioModule) throw new StudioStyleError('模板不存在或无权修改', 403);
  await resolveStudioStyleReferences(user, ids, client);
  const valueJson = JSON.stringify({ ownerId: user.id, ids });
  await client.platformSetting.upsert({ where: { key: selectionKey(moduleId) },
    create: { key: selectionKey(moduleId), value_json: valueJson, updated_by: user.id },
    update: { value_json: valueJson, updated_by: user.id } });
}
export async function setStudioPresetStyleIds(user: ImageStudioIdentity, presetId: string, value: unknown, client: Client = prisma) {
  const ids = parseStudioStyleIds(value);
  const preset = await client.imageStudioPreset.findFirst({ where: { id: presetId, owner_id: user.id }, select: { id: true } });
  if (!preset) throw new StudioStyleError('模板不存在或无权修改', 403);
  await resolveStudioStyleReferences(user, ids, client);
  const key = `studio_style_preset_selection_v1:${presetId}`;
  const valueJson = JSON.stringify({ ownerId: user.id, ids });
  await client.platformSetting.upsert({ where: { key }, create: { key, value_json: valueJson, updated_by: user.id }, update: { value_json: valueJson, updated_by: user.id } });
}
export async function saveStudioStyleGroup(user: ImageStudioIdentity, body: Record<string, unknown>) {
  identity(user);
  if (!STUDIO_STYLE_GROUP_WRITES_ENABLED) throw new StudioStyleError('此版本只保留风格组读取，请更新后保存', 426);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 80) throw new StudioStyleError('风格组名称须为 1–80 字');
  if (body.note !== undefined && typeof body.note !== 'string') throw new StudioStyleError('风格组整体备注内容无效');
  if (typeof body.note === 'string' && body.note.length > MAX_STYLE_GROUP_NOTE_LENGTH) {
    throw new StudioStyleError(`风格组整体备注最多 ${MAX_STYLE_GROUP_NOTE_LENGTH} 字，请缩短后再保存`);
  }
  const requestId = operationId(body.requestId);
  const fingerprint = operationHash(['save', body]);
  const id = body.id == null ? requestId || randomUUID() : String(body.id);
  return prisma.$transaction(async tx => {
    const prior = requestId && await readStyleOperation(user, requestId, tx);
    if (prior) { if (prior.fingerprint !== fingerprint) throw new StudioStyleError('原操作内容不同，请核对原保存', 409); return prior.result; }
    const current = body.id == null ? null : await getStudioStyleGroup(user, id, tx);
    if (current && !canManageStudioStyle(user, current)) throw new StudioStyleError('只有管理员或创建者能修改风格组', 403);
    if (current && body.copyFrom) throw new StudioStyleError('另存必须使用新组编号，原组未修改', 409);
    if (current && body.revision !== current.revision) {
      if (!requestId) throw new StudioStyleError('风格组已更新，请重新打开后编辑', 409);
      const result = { operationState: 'conflict', id, revision: current.revision };
      await tx.platformSetting.create({ data: { key: styleOperationKey(user.id, requestId), value_json: JSON.stringify({ fingerprint, state: 'conflict', result }), updated_by: user.id } });
      return result;
    }
    let references: StudioFixedReference[];
    try { references = parseStudioFixedReferences(body.references); } catch (error) { throw new StudioStyleError((error as Error).message); }
    const mergeIds = body.mergeIds === undefined ? [] : parseStudioStyleIds(body.mergeIds);
    const merge = await resolveStudioStyleReferences(user, mergeIds, tx);
    if (merge.groups.some(group => !canManageStudioStyle(user, group))) throw new StudioStyleError('只有管理员或创建者能合并风格组内容', 403);
    const note = body.note === undefined ? current?.note || '' : body.note as string;
    const mergedNote = [note, ...merge.groups.flatMap(group => group.note?.trim() ? [`【${group.name}】\n${group.note}`] : [])]
      .filter(part => part.length > 0).join('\n\n');
    if (mergedNote.length > MAX_STYLE_GROUP_NOTE_LENGTH) {
      throw new StudioStyleError(`合并后的整体备注超过 ${MAX_STYLE_GROUP_NOTE_LENGTH} 字，请先缩短相关组备注后再合并`);
    }
    references = [...references, ...merge.references];
    if (!references.length || references.length > MAX_REFERENCE_IMAGES) throw new StudioStyleError(`风格组须包含 1–${MAX_REFERENCE_IMAGES} 张图片`);
    const coverAssetId = typeof body.coverAssetId === 'string' ? body.coverAssetId : references[0].assetId;
    if (!references.some(ref => ref.assetId === coverAssetId)) throw new StudioStyleError('请从组内图片选择封面');
    let source: StudioStyleGroup['source'];
    let copiedIds: string[] = [];
    if (body.copyFrom && typeof body.copyFrom === 'object') {
      const input = body.copyFrom as { id?: string; taskId?: string; revision?: number };
      if (typeof input.id !== 'string') throw new StudioStyleError('副本来源无效');
      if (input.taskId) {
        const task = await tx.imageStudioTask.findFirst({ where: { id: input.taskId, ...(user.role === 'admin' ? {} : { owner_id: user.id }) }, select: { snapshot_json: true } });
        const original = task?.snapshot_json && historicalStudioStyles(JSON.parse(task.snapshot_json), input.taskId, user).find(group => group.id === input.id);
        if (!original || !original.canCopy || original.revision !== input.revision) throw new StudioStyleError('历史内容不完整或无权另存', 403);
        copiedIds = original.references?.map(ref => ref.id) || [];
      } else {
        const original = await getStudioStyleGroup(user, input.id, tx);
        if (!canManageStudioStyle(user, original) || !Number.isSafeInteger(input.revision) || Number(input.revision) > original.revision) throw new StudioStyleError('来源版本或复制权限已变化', 409);
        copiedIds = original.references.map(ref => ref.assetId);
      }
      source = { id: input.id, ...(input.taskId ? { taskId: input.taskId } : {}), revision: input.revision };
    }
    const existingIds = new Set([...(current?.references || []), ...merge.references].map(ref => ref.assetId).concat(copiedIds));
    const ids = Array.from(new Set(references.map(ref => ref.assetId)));
    const visible = await studioVisibleAssetWhere(user, tx);
    const assets = await tx.asset.findMany({ where: { id: { in: ids }, type: 'image', status: 'active', AND: [visible,
      ...(user.role === 'admin' ? [] : [{ OR: [{ owner_id: user.id }, { id: { in: Array.from(existingIds) } }] }]) ] }, select: { id: true } });
    if (assets.length !== ids.length) throw new StudioStyleError('组内图片不存在或无权查看', 403);
    const group: StudioStyleGroup = { id, ownerId: current?.ownerId || user.id, name, coverAssetId, references,
      note: mergedNote, shared: source ? false : typeof body.shared === 'boolean' ? body.shared : current?.shared !== false,
      disabled: typeof body.disabled === 'boolean' ? body.disabled : current?.disabled === true,
      ...(source || current?.source ? { source: source || current?.source } : {}), revision: (current?.revision || 0) + 1 };
    const valueJson = JSON.stringify(group);
    if (current) {
      const changed = await tx.platformSetting.updateMany({ where: { key: `${PREFIX}${id}`, value_json: JSON.stringify(current) }, data: { value_json: valueJson, updated_by: user.id } });
      if (!changed.count) throw new StudioStyleError('风格组已更新，请重新打开后编辑', 409);
    } else await tx.platformSetting.create({ data: { key: `${PREFIX}${id}`, value_json: valueJson, updated_by: user.id } });
    const result = await studioStyleDTO(user, group, tx);
    if (typeof body.draftId === 'string' && /^[0-9a-f-]{36}$/i.test(body.draftId) && Number.isSafeInteger(body.draftRevision)) {
      const key = `studio_style_draft_v1:${user.id}:${body.draftId}`;
      const draft = await tx.platformSetting.findUnique({ where: { key }, select: { value_json: true } });
      if (draft && JSON.parse(draft.value_json).revision === body.draftRevision) await tx.platformSetting.deleteMany({ where: { key, value_json: draft.value_json } });
    }
    if (requestId) await tx.platformSetting.create({ data: { key: styleOperationKey(user.id, requestId), value_json: JSON.stringify({ fingerprint, state: 'saved', result }), updated_by: user.id } });
    return result;
  }, { timeout: 15000 });
}
export async function deleteStudioStyleGroup(user: ImageStudioIdentity, id: string, revision: unknown, rawRequestId?: unknown) {
  identity(user);
  if (!STUDIO_STYLE_GROUP_WRITES_ENABLED) throw new StudioStyleError('此版本只保留风格组读取，请更新后操作', 426);
  const requestId = operationId(rawRequestId), fingerprint = operationHash(['delete', id, revision]);
  return prisma.$transaction(async tx => {
    const prior = requestId && await readStyleOperation(user, requestId, tx);
    if (prior) { if (prior.fingerprint !== fingerprint) throw new StudioStyleError('原删除内容不同，请核对原操作', 409); return { state: prior.state }; }
    const group = await getStudioStyleGroup(user, id, tx);
    if (!canManageStudioStyle(user, group)) throw new StudioStyleError('只有管理员或创建者能删除风格组', 403);
    if (group.revision !== revision) {
      if (!requestId) throw new StudioStyleError('风格组已更新，请刷新后再删除', 409);
      await tx.platformSetting.create({ data: { key: styleOperationKey(user.id, requestId), value_json: JSON.stringify({ fingerprint, state: 'conflict', result: { id, revision: group.revision } }), updated_by: user.id } });
      return { state: 'conflict' };
    }
    // Keep the private binding for historical tasks; deleting a group never
    // removes original images or makes their URLs public again.
    const changed = await tx.platformSetting.updateMany({ where: { key: `${PREFIX}${id}`, value_json: JSON.stringify(group) },
      data: { value_json: JSON.stringify({ ...group, deleted: true, revision: group.revision + 1 }), updated_by: user.id } });
    if (!changed.count) throw new StudioStyleError('风格组已更新，请刷新后再删除', 409);
    if (requestId) await tx.platformSetting.create({ data: { key: styleOperationKey(user.id, requestId), value_json: JSON.stringify({ fingerprint, state: 'deleted', result: { id, revision: group.revision + 1 } }), updated_by: user.id } });
    return { state: 'deleted' };
  });
}

const styleOperationKey = (actor: string, id: string) => `studio_style_operation_v1:${actor}:${id}`;
const operationHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function operationId(value: unknown) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) throw new StudioStyleError('操作编号无效');
  return value;
}
async function readStyleOperation(user: ImageStudioIdentity, id: string, client: Pick<Prisma.TransactionClient, 'platformSetting'> = prisma) {
  const row = await client.platformSetting.findUnique({ where: { key: styleOperationKey(user.id, id) }, select: { value_json: true } });
  return row ? JSON.parse(row.value_json) : null;
}
export async function studioStyleOperationStatus(user: ImageStudioIdentity, id: unknown) {
  identity(user);
  const requestId = operationId(id);
  if (!requestId) throw new StudioStyleError('缺少原操作编号');
  const prior = await readStyleOperation(user, requestId);
  if (!prior) return { state: 'unknown', requestId };
  const { result } = prior;
  if (prior.state === 'draft') await assertDraftAccess(user, result.value);
  if (prior.state === 'saved') {
    const row = await prisma.platformSetting.findUnique({ where: { key: `${PREFIX}${result.id}` }, select: { value_json: true } });
    if (!row) throw new StudioStyleError('读取权限无法确认', 403);
    const current = decode(row.value_json);
    if (!canManageStudioStyle(user, current)) throw new StudioStyleError('读取权限已变化', 403);
    if (current.deleted || current.disabled) return { state: prior.state, requestId, result: { ...result, unavailable: true } };
  }
  return { state: prior.state, requestId, result };
}

async function assertDraftAccess(user: ImageStudioIdentity, draft: Record<string, unknown>) {
  identity(user);
  const allowed = new Set<string>();
  if (typeof draft.id === 'string') {
    const original = await getStudioStyleGroup(user, draft.id);
    if (!canManageStudioStyle(user, original)) throw new StudioStyleError('无权编辑该风格组草稿', 403);
    original.references.forEach(reference => allowed.add(reference.assetId));
  }
  if (draft.copyFrom && typeof draft.copyFrom === 'object') {
    const source = draft.copyFrom as { id: string; taskId?: string };
    if (source.taskId) {
      const task = await prisma.imageStudioTask.findFirst({ where: { id: source.taskId, ...(user.role === 'admin' ? {} : { owner_id: user.id }) }, select: { snapshot_json: true } });
      const group = task?.snapshot_json && historicalStudioStyles(JSON.parse(task.snapshot_json), source.taskId, user).find(item => item.id === source.id && item.canCopy);
      if (!group) throw new StudioStyleError('无权读取来源草稿', 403);
      group.references?.forEach(reference => allowed.add(reference.id));
    } else {
      const group = await getStudioStyleGroup(user, source.id);
      if (!canManageStudioStyle(user, group)) throw new StudioStyleError('无权读取来源草稿', 403);
      group.references.forEach(reference => allowed.add(reference.assetId));
    }
  }
  return allowed;
}
export async function studioStyleDraft(user: ImageStudioIdentity, id: unknown, input?: Record<string, unknown>) {
  identity(user);
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new StudioStyleError('草稿编号无效');
  const key = `studio_style_draft_v1:${user.id}:${id}`;
  if (!input) {
    const row = await prisma.platformSetting.findUnique({ where: { key }, select: { value_json: true } });
    if (!row) return null;
    const draft = JSON.parse(row.value_json);
    await assertDraftAccess(user, draft.value);
    return { ...draft, value: { ...draft.value, references: draft.value.references.map((reference: { id: string; note: string }) => ({ ...reference,
      originalUrl: `/api/image-studio/style-groups/drafts/${id}/assets/${encodeURIComponent(reference.id)}`,
      thumbnailUrl: `/api/image-studio/style-groups/drafts/${id}/assets/${encodeURIComponent(reference.id)}?thumbnail=1`, available: true })) } };
  }
  if (!STUDIO_STYLE_GROUP_WRITES_ENABLED) throw new StudioStyleError('此版本只保留草稿读取，请更新后保存', 426);
  const raw = input.value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || JSON.stringify(raw).length > 100000
    || !Number.isSafeInteger(input.expectedRevision)) throw new StudioStyleError('草稿内容无效');
  const content = raw as Record<string, unknown>;
  if (typeof content.name !== 'string' || content.name.length > 80 || typeof content.note !== 'string' || content.note.length > 8000
    || typeof content.coverAssetId !== 'string' || !Array.isArray(content.references) || content.references.length > MAX_REFERENCE_IMAGES
    || content.references.some(reference => !reference || typeof reference.id !== 'string' || typeof reference.note !== 'string' || reference.note.length > 8000)) throw new StudioStyleError('草稿内容无效');
  const value = { ...(typeof content.id === 'string' ? { id: content.id, revision: content.revision } : {}),
    name: content.name, note: content.note, coverAssetId: content.coverAssetId,
    references: content.references.map(reference => ({ id: reference.id, note: reference.note })), shared: content.shared !== false, disabled: content.disabled === true,
    ...(content.copyFrom ? { copyFrom: content.copyFrom } : {}) };
  await assertDraftAccess(user, value);
  const requestId = operationId(input.requestId);
  if (!requestId) throw new StudioStyleError('缺少草稿操作编号');
  const fingerprint = operationHash(['draft', id, input]);
  return prisma.$transaction(async tx => {
    const prior = await readStyleOperation(user, requestId, tx);
    if (prior) { if (prior.fingerprint !== fingerprint) throw new StudioStyleError('原草稿操作内容不同', 409); return prior.result; }
    const row = await tx.platformSetting.findUnique({ where: { key }, select: { value_json: true } });
    const revision = row ? Number(JSON.parse(row.value_json).revision) : 0;
    if (revision !== input.expectedRevision) throw new StudioStyleError('草稿已有更新，当前输入保留，可另存副本', 409);
    const result = { revision: revision + 1, value };
    if (row) {
      const changed = await tx.platformSetting.updateMany({ where: { key, value_json: row.value_json }, data: { value_json: JSON.stringify(result), updated_by: user.id } });
      if (changed.count !== 1) throw new StudioStyleError('草稿已有更新，当前输入保留', 409);
    } else await tx.platformSetting.create({ data: { key, value_json: JSON.stringify(result), updated_by: user.id } });
    await tx.platformSetting.create({ data: { key: styleOperationKey(user.id, requestId), value_json: JSON.stringify({ fingerprint, state: 'draft', result, draftId: id }), updated_by: user.id } });
    return result;
  });
}

export async function studioStyleDraftAsset(user: ImageStudioIdentity, draftId: string, assetId: string) {
  const draft = await studioStyleDraft(user, draftId);
  if (!draft?.value.references.some((reference: { id: string }) => reference.id === assetId)) return null;
  const allowed = await assertDraftAccess(user, draft.value);
  return prisma.asset.findFirst({ where: { id: assetId, status: 'active', type: 'image',
    ...(user.role === 'admin' || allowed.has(assetId) ? {} : { owner_id: user.id }), AND: [await studioVisibleAssetWhere(user)] },
    select: { id: true, owner_id: true, original_url: true, mime_type: true, file_name: true } });
}
