import { randomUUID } from 'node:crypto';
import type { CharacterFusionWorkspace, CharacterFusionResult, CharacterFusionOperation } from '@prisma/client';
import { prisma, retrySqliteBusy } from '@/lib/prisma';
import { builtinCatalogue, hydrateCatalogueSettings } from './catalogue';
import { parseFusionSettings } from './actions';
import { settingsForRow, type FusionSettings } from './engine';
import type { FusionRecipe } from './recipes';
import { assertCharacterFusionWritesEnabled } from './build-mode';
import { FusionError, isRecord, parseOperationId, parseFusionOperationRequest, parseWorkspaceState, emptyWorkspaceState, applyFusionCommands, fusionDocumentDelta, sameFusionValue, type FusionWorkspace, type FusionWorkspaceRow, type FusionUndo, type FusionWorkspaceState } from './actions';
import { fusionFingerprint, requireActiveFusionUser, loadFusionCatalogue, operationDto, type FusionActor, type FusionDb } from './catalogue-repository';

export type WorkspacePageQuery = { cursor?: string; limit?: number; allRows?: boolean; rowId?: string };
export type WorkspaceRowsPage = { nextCursor: string | null; total: number };
const resultDto = (row: CharacterFusionResult): FusionWorkspaceRow => ({ ...JSON.parse(row.row_json), id: row.row_id, version: row.version });
function workspaceDto(row: CharacterFusionWorkspace, rows: FusionWorkspaceRow[]): FusionWorkspace { return { id: row.id, name: row.name, version: row.version, state: JSON.parse(row.state_json) as FusionWorkspaceState, archived: row.archived, updatedAt: row.updated_at.toISOString(), rows }; }
async function owned(db: FusionDb, actor: FusionActor, id: string) {
  const workspace = await db.characterFusionWorkspace.findFirst({ where: { id, owner_id: actor.id } });
  if (!workspace) throw new FusionError('创作现场不存在或无权读取。', 404, 'FUSION_NOT_FOUND');
  return workspace;
}
async function pageWorkspace(db: FusionDb, row: CharacterFusionWorkspace, query: WorkspacePageQuery = {}) {
  const limit = query.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new FusionError('结果分页大小须为1–200。');
  let offset = 0;
  if (query.cursor) {
    let cursor: { version: number; workspaceId: string; offset: number };
    try { cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')); } catch { throw new FusionError('结果分页位置无效。'); }
    if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.workspaceId !== row.id) throw new FusionError('结果分页位置无效。');
    if (cursor.version !== row.version) throw new FusionError('创作现场已更新，请重新读取结果。', 409, 'FUSION_PAGE_CHANGED');
    offset = cursor.offset;
  }
  const [results, total] = await Promise.all([
    db.characterFusionResult.findMany({ where: { workspace_id: row.id }, orderBy: [{ position: 'asc' }, { id: 'asc' }], ...(query.allRows ? {} : { skip: offset, take: limit }) }),
    db.characterFusionResult.count({ where: { workspace_id: row.id } }),
  ]);
  const nextCursor = !query.allRows && offset + results.length < total ? Buffer.from(JSON.stringify({ version: row.version, workspaceId: row.id, offset: offset + results.length })).toString('base64url') : null;
  return { workspace: workspaceDto(row, results.map(resultDto)), rowsPage: { nextCursor, total } };
}
async function resolveWorkspaceRow(db: FusionDb, actor: FusionActor, workspaceId: string, row: FusionWorkspaceRow): Promise<FusionWorkspaceRow> {
  if (!row.catalogueSnapshot || row.catalogueSnapshot.settings) return row;
  const reference = row.catalogueSnapshot.settingsRef;
  if (!reference || typeof reference.operationId !== 'string' || typeof reference.configurationId !== 'string') throw new FusionError('原结果配置引用不完整，未改动结果。', 409, 'FUSION_SNAPSHOT_MISSING');
  const operation = await db.characterFusionOperation.findUnique({ where: { owner_id_op_id: { owner_id: actor.id, op_id: reference.operationId } } });
  if (!operation || operation.workspace_id !== workspaceId || operation.status !== 'committed') throw new FusionError('无法读取本结果的原配置，未改动结果。', 409, 'FUSION_SNAPSHOT_MISSING');
  const configurations = (JSON.parse(operation.result_json) as { configurations?: Record<string, FusionSettings> }).configurations;
  const settings = configurations?.[reference.configurationId];
  if (!settings || fusionFingerprint(settings) !== reference.configurationId) throw new FusionError('原结果配置记录不完整，未改动结果。', 409, 'FUSION_SNAPSHOT_MISSING');
  return { ...row, catalogueSnapshot: { ...row.catalogueSnapshot, settings: parseFusionSettings(settings) } };
}
function compactWorkspaceRow(row: FusionWorkspaceRow, opId: string, configurations: Record<string, FusionSettings>): FusionWorkspaceRow {
  if (!row.catalogueSnapshot) return row;
  const { settings, ...snapshot } = row.catalogueSnapshot;
  if (!settings) return row;
  const configurationId = fusionFingerprint(settings);
  if (snapshot.settingsRef?.configurationId === configurationId) return { ...row, catalogueSnapshot: snapshot };
  configurations[configurationId] = settings;
  return { ...row, catalogueSnapshot: { ...snapshot, settingsRef: { operationId: opId, configurationId } } };
}
export async function getWorkspace(actor: FusionActor, id: string, query: WorkspacePageQuery = {}) {
  return retrySqliteBusy(() => prisma.$transaction(async tx => { await requireActiveFusionUser(tx, actor); const row = await owned(tx, actor, id), page = await pageWorkspace(tx, row, query);
    if (!query.rowId) return page;
    const result = await tx.characterFusionResult.findUnique({ where: { workspace_id_row_id: { workspace_id: id, row_id: query.rowId } } });
    if (!result) throw new FusionError('目标结果不存在。', 404, 'FUSION_NOT_FOUND');
    const resolved = await resolveWorkspaceRow(tx, actor, id, resultDto(result));
    return { ...page, rowSettings: { rowId: result.row_id, settings: settingsForRow(resolved.catalogueSnapshot?.settings || page.workspace.state.settings, resolved) } }; }));
}
export async function listFusionWorkspaces(actor: FusionActor, query: { archived?: boolean; q?: string; cursor?: string; limit?: number } = {}) {
  await requireActiveFusionUser(prisma, actor);
  const limit = query.limit || 30, search = query.q?.trim() || '';
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || search.length > 100) throw new FusionError('文档查询条件无效。');
  const filter = fusionFingerprint({ archived: Boolean(query.archived), search });
  let after: { updatedAt: string; id: string; filter: string } | undefined;
  if (query.cursor) { try { after = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')); } catch { throw new FusionError('文档分页位置无效。'); } if (!after || after.filter !== filter || !Number.isFinite(new Date(after.updatedAt).getTime()) || typeof after.id !== 'string') throw new FusionError('文档分页条件不匹配。'); }
  const rows = await prisma.characterFusionWorkspace.findMany({ where: { owner_id: actor.id, archived: Boolean(query.archived), ...(search ? { name: { contains: search } } : {}), ...(after ? { OR: [{ updated_at: { lt: new Date(after.updatedAt) } }, { updated_at: new Date(after.updatedAt), id: { lt: after.id } }] } : {}) }, orderBy: [{ updated_at: 'desc' }, { id: 'desc' }], take: limit + 1, select: { id: true, name: true, version: true, archived: true, updated_at: true } });
  const hasMore = rows.length > limit, items = rows.slice(0, limit), last = items[items.length - 1];
  return { workspaces: items.map(row => ({ id: row.id, name: row.name, version: row.version, archived: row.archived, updatedAt: row.updated_at.toISOString() })), nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ updatedAt: last.updated_at.toISOString(), id: last.id, filter })).toString('base64url') : null };
}
export async function createFusionWorkspace(actor: FusionActor, input: unknown) {
  assertCharacterFusionWritesEnabled();
  if (!isRecord(input)) throw new FusionError('文档内容无效。');
  const opId = parseOperationId(input.opId), name = input.name === undefined ? '未命名创作' : input.name;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 60) throw new FusionError('文档名称须为1–60字。');
  const state = input.state === undefined ? emptyWorkspaceState() : parseWorkspaceState(input.state);
  if (state.selectedIds.length || state.retainedIds.length) throw new FusionError('创建文档时不能引用未承接的结果，请使用显式承接草稿。');
  const fingerprint = fusionFingerprint({ action: 'createWorkspace', name: name.trim(), state });
  return retrySqliteBusy(() => prisma.$transaction(async tx => {
    await requireActiveFusionUser(tx, actor);
    const prior = await tx.characterFusionOperation.findUnique({ where: { owner_id_op_id: { owner_id: actor.id, op_id: opId } } });
    if (prior) {
      if (prior.target_kind !== 'workspace.create' || prior.fingerprint !== fingerprint || !prior.workspace_id) throw new FusionError('此操作编号已用于其它内容。', 409, 'FUSION_OPERATION_REUSED');
      return { ...await pageWorkspace(tx, await owned(tx, actor, prior.workspace_id)), operation: operationDto(prior) };
    }
    const row = await tx.characterFusionWorkspace.create({ data: { owner_id: actor.id, name: name.trim(), state_json: JSON.stringify(state) } });
    const operation = await tx.characterFusionOperation.create({ data: { owner_id: actor.id, op_id: opId, workspace_id: row.id, target_kind: 'workspace.create', fingerprint, after_version: 1, result_json: JSON.stringify({ resultIds: [] }) } });
    return { workspace: workspaceDto(row, []), rowsPage: { nextCursor: null, total: 0 }, operation: operationDto(operation) };
  }));
}
async function currentRowChanges(db: FusionDb, workspaceId: string, result: { rowChanges?: { upsert: FusionWorkspaceRow[]; removedIds: string[] } }) {
  const touched = Array.from(new Set([...(result.rowChanges?.upsert.map(row => row.id) || []), ...(result.rowChanges?.removedIds || [])]));
  if (!touched.length) return { upsert: [], removedIds: [] };
  const rows = await db.characterFusionResult.findMany({ where: { workspace_id: workspaceId, row_id: { in: touched } }, orderBy: [{ position: 'asc' }, { id: 'asc' }] });
  const live = new Set(rows.map(row => row.row_id));
  const order = await db.characterFusionResult.findMany({ where: { workspace_id: workspaceId }, select: { row_id: true }, orderBy: [{ position: 'asc' }, { id: 'asc' }] });
  return { upsert: rows.map(resultDto), removedIds: touched.filter(id => !live.has(id)), order: order.map(row => row.row_id) };
}
async function queryInDb(db: FusionDb, actor: FusionActor, id: string, opId: string) {
  const workspace = await owned(db, actor, id);
  const operation = await db.characterFusionOperation.findUnique({ where: { owner_id_op_id: { owner_id: actor.id, op_id: opId } } });
  if (!operation || operation.workspace_id !== id) return { status: 'unknown' as const };
  const result = JSON.parse(operation.result_json) as { error?: string; proposal?: { reply: string; commands: unknown[]; drafts: unknown[] }; recipeIds?: string[]; rowChanges?: { upsert: FusionWorkspaceRow[]; removedIds: string[] } };
  return { status: operation.status as 'planning' | 'committed' | 'rejected' | 'cancelled', operation: operationDto(operation), ...await pageWorkspace(db, workspace), ...(result.error ? { error: result.error } : {}), recipeIds: result.recipeIds || [], ...(result.proposal ? { proposal: result.proposal } : {}), ...(result.rowChanges ? { rowChanges: await currentRowChanges(db, id, result) } : {}) };
}
export async function queryWorkspaceOperation(actor: FusionActor, id: string, opId: string) {
  parseOperationId(opId); return retrySqliteBusy(() => prisma.$transaction(async tx => { await requireActiveFusionUser(tx, actor); return queryInDb(tx, actor, id, opId); }));
}
export async function executeWorkspaceOperation(actor: FusionActor, id: string, input: unknown, options: { assistantFingerprint?: string } = {}) {
  assertCharacterFusionWritesEnabled();
  const request = parseFusionOperationRequest(input), fingerprint = fusionFingerprint({ workspaceId: id, request });
  return retrySqliteBusy(() => prisma.$transaction(async tx => {
    await requireActiveFusionUser(tx, actor);
    const workspace = await owned(tx, actor, id);
    const prior = await tx.characterFusionOperation.findUnique({ where: { owner_id_op_id: { owner_id: actor.id, op_id: request.opId } } });
    let reserved: CharacterFusionOperation | undefined;
    if (prior) {
      if (prior.workspace_id !== id) throw new FusionError('此操作编号已用于其它内容。', 409, 'FUSION_OPERATION_REUSED');
      if (prior.target_kind === 'assistant') {
        if (!options.assistantFingerprint || prior.fingerprint !== options.assistantFingerprint) throw new FusionError('此编号属于原对话回合，请查询原回执。', 409, 'FUSION_OPERATION_REUSED');
        if (prior.status === 'planning') reserved = prior;
        else if (prior.status !== 'committed') throw new FusionError('该回合已结束，未应用提案；请保留输入后重新发起。', 409, 'FUSION_ASSISTANT_FINISHED');
        else if ((JSON.parse(prior.result_json) as { executionFingerprint?: string }).executionFingerprint !== fingerprint) throw new FusionError('原回合已提交其它提案，请读取原回执。', 409, 'FUSION_OPERATION_REUSED');
      } else if (prior.target_kind !== 'workspace' || prior.fingerprint !== fingerprint) throw new FusionError('此操作编号已用于其它内容。', 409, 'FUSION_OPERATION_REUSED');
      if (!reserved) { const result = JSON.parse(prior.result_json) as { recipeIds?: string[]; rowChanges?: { upsert: FusionWorkspaceRow[]; removedIds: string[] } }; return { ...await pageWorkspace(tx, workspace), operation: operationDto(prior), recipeIds: result.recipeIds || [], rowChanges: await currentRowChanges(tx, id, result) }; }
    } else if (options.assistantFingerprint) throw new FusionError('对话回合尚未登记，未应用提案。', 409, 'FUSION_ASSISTANT_UNKNOWN');
    if (workspace.archived && request.commands.some(command => command.type !== 'archive')) throw new FusionError('请先恢复归档文档再继续编辑。', 409, 'FUSION_ARCHIVED');
    const needsRows = request.commands.some(command => ['generate', 'addCurrent', 'changeRow', 'reviseRow', 'patchRow', 'removeRows', 'importDraft', 'undo'].includes(command.type));
    const storedRows = needsRows ? await tx.characterFusionResult.findMany({ where: { workspace_id: id }, orderBy: [{ position: 'asc' }, { id: 'asc' }] }) : [];
    const originalCurrent = workspaceDto(workspace, storedRows.map(resultDto));
    const targetIds = new Set(request.commands.flatMap(command => command.type === 'changeRow' || command.type === 'reviseRow' ? [command.rowId] : []));
    const resolvedRows = [];
    for (const row of originalCurrent.rows) resolvedRows.push(targetIds.has(row.id) ? await resolveWorkspaceRow(tx, actor, id, row) : row);
    const current = { ...originalCurrent, rows: resolvedRows };
    for (const command of request.commands) if (command.type === 'selection') {
      const ids = Array.from(new Set([...(command.selectedIds || []), ...(command.retainedIds || [])]));
      if (ids.length && await tx.characterFusionResult.count({ where: { workspace_id: id, row_id: { in: ids } } }) !== ids.length) throw new FusionError('选择中有不属于当前文档的结果。', 409, 'FUSION_CONFLICT');
    }
    const undoCommand = request.commands.find(command => command.type === 'undo');
    let undo: FusionUndo | undefined, undone: CharacterFusionOperation | null = null;
    if (undoCommand?.type === 'undo') {
      undone = await tx.characterFusionOperation.findUnique({ where: { owner_id_op_id: { owner_id: actor.id, op_id: undoCommand.operationId } } });
      if (!undone || undone.workspace_id !== id || !undone.undo_json || undone.undone_by || undone.status !== 'committed') throw new FusionError('该操作不可撤销。', 409, 'FUSION_UNDO_CONFLICT');
      undo = JSON.parse(undone.undo_json) as FusionUndo;
    }
    const catalogue = request.commands.some(command => ['generate', 'addCurrent', 'patchSettings', 'saveRecipe', 'changeRow', 'reviseRow'].includes(command.type)) ? await loadFusionCatalogue(tx, actor.id) : builtinCatalogue();
    let next;
    try { next = applyFusionCommands(current, request, catalogue, undo); } catch (error) { if (error instanceof FusionError) throw error; throw new FusionError(error instanceof Error ? error.message : '角色设置与当前目录不匹配。'); }
    const configurations: Record<string, FusionSettings> = {};
    for (const command of request.commands) if (command.type === 'importDraft') for (const row of command.rows) if (row.catalogueSnapshot?.settingsRef && !row.catalogueSnapshot.settings) await resolveWorkspaceRow(tx, actor, id, { ...row, version: 1 });
    const originals = new Map(originalCurrent.rows.map(row => [row.id, row]));
    next.rows = next.rows.map(row => sameFusionValue(row, originals.get(row.id)) ? row : compactWorkspaceRow(row, request.opId, configurations));
    const delta = fusionDocumentDelta(originalCurrent, next);
    const rowChanges = { upsert: delta.rows.filter(item => item.after).map(item => item.after!), removedIds: delta.rows.filter(item => !item.after).map(item => item.id) };
    const changed = await tx.characterFusionWorkspace.updateMany({ where: { id, owner_id: actor.id, version: workspace.version }, data: { name: next.name, archived: next.archived, state_json: JSON.stringify(next.state), version: next.version } });
    if (changed.count !== 1) throw new FusionError('创作现场已更新，请保留草稿并重新读取。', 409, 'FUSION_CONFLICT');
    if (rowChanges.removedIds.length) await tx.characterFusionResult.deleteMany({ where: { workspace_id: id, row_id: { in: rowChanges.removedIds } } });
    const nextPositions = new Map(next.rows.map((row, index) => [row.id, index]));
    const storedById = new Map(storedRows.map(row => [row.row_id, row]));
    const upsertIds = new Set(rowChanges.upsert.map(row => row.id));
    for (const item of delta.rows.filter(item => item.after)) {
      const row = item.after!, data = { row_json: JSON.stringify(row), position: nextPositions.get(row.id)!, version: row.version };
      await tx.characterFusionResult.upsert({ where: { workspace_id_row_id: { workspace_id: id, row_id: row.id } }, create: { workspace_id: id, row_id: row.id, ...data }, update: data });
    }
    // Removing a row shifts positions, but never rewrites untouched frozen row data.
    for (let position = 0; position < next.rows.length; position++) {
      const old = storedById.get(next.rows[position].id);
      if (old && old.position !== position && !upsertIds.has(old.row_id)) await tx.characterFusionResult.update({ where: { id: old.id }, data: { position } });
    }
    const recipeIds: string[] = [];
    for (const command of request.commands) if (command.type === 'saveRecipe') {
      const settings = parseFusionSettings({ ...next.state.settings, catalogue: hydrateCatalogueSettings(next.state.settings.catalogue || { details: {}, traits: {} }, catalogue, next.state.settings) });
      const key = `character_fusion_recipe_v1:${command.id}`, old = await tx.userPreference.findUnique({ where: { user_id_key: { user_id: actor.id, key } } });
      if (old) { const recipe = JSON.parse(old.value_json) as FusionRecipe; if (recipe.name !== command.name.trim() || !sameFusionValue(recipe.settings, settings)) throw new FusionError('此配方保存编号已使用，请重新读取原配方。', 409, 'FUSION_OPERATION_REUSED'); }
      else { const recipe: FusionRecipe = { id: command.id, name: command.name.trim(), settings, revision: randomUUID(), updatedAt: new Date().toISOString() }; await tx.userPreference.create({ data: { user_id: actor.id, key, value_json: JSON.stringify(recipe) } }); }
      recipeIds.push(command.id);
    }
    const result = { configurations, recipeIds, resultIds: rowChanges.upsert.map(row => row.id), rowChanges, ...(reserved ? { executionFingerprint: fingerprint } : {}) };
    const data = { before_version: workspace.version, after_version: next.version, status: 'committed', result_json: JSON.stringify(result), undo_json: undoCommand || recipeIds.length ? null : JSON.stringify(delta) };
    let operation: CharacterFusionOperation;
    if (reserved) {
      const applied = await tx.characterFusionOperation.updateMany({ where: { id: reserved.id, status: 'planning', fingerprint: options.assistantFingerprint }, data });
      if (applied.count !== 1) throw new FusionError('该回合已结束，未应用提案。', 409, 'FUSION_ASSISTANT_FINISHED');
      operation = (await tx.characterFusionOperation.findUnique({ where: { id: reserved.id } }))!;
    } else operation = await tx.characterFusionOperation.create({ data: { owner_id: actor.id, op_id: request.opId, workspace_id: id, target_kind: 'workspace', fingerprint, ...data } });
    if (undone) await tx.characterFusionOperation.update({ where: { id: undone.id }, data: { undone_by: request.opId } });
    return { ...await pageWorkspace(tx, (await tx.characterFusionWorkspace.findUnique({ where: { id } }))!), operation: operationDto(operation), rowChanges: { ...rowChanges, ...(delta.rows.length ? { order: next.rows.map(row => row.id) } : {}) }, recipeIds };
  }));
}
export async function reserveAssistantOperation(actor: FusionActor, id: string, request: { opId: string; baseVersion: number; message: string; model: string }) {
  assertCharacterFusionWritesEnabled(); parseOperationId(request.opId);
  if (!Number.isSafeInteger(request.baseVersion) || request.baseVersion < 1 || typeof request.message !== 'string' || !request.message.trim() || request.message.length > 6000 || typeof request.model !== 'string' || !request.model || request.model.length > 80) throw new FusionError('对话回合内容无效。');
  const fingerprint = fusionFingerprint({ workspaceId: id, intent: request });
  return retrySqliteBusy(() => prisma.$transaction(async tx => {
    await requireActiveFusionUser(tx, actor); const workspace = await owned(tx, actor, id);
    const prior = await tx.characterFusionOperation.findUnique({ where: { owner_id_op_id: { owner_id: actor.id, op_id: request.opId } } });
    if (prior) {
      if (prior.target_kind !== 'assistant' || prior.workspace_id !== id || prior.fingerprint !== fingerprint && !(prior.status === 'cancelled' && (JSON.parse(prior.result_json) as { cancelBeforeReserve?: boolean }).cancelBeforeReserve)) throw new FusionError('此回合编号已用于其它内容。', 409, 'FUSION_OPERATION_REUSED');
      return { ...await queryInDb(tx, actor, id, request.opId), claimed: false as const, intentFingerprint: prior.fingerprint };
    }
    if (workspace.archived) throw new FusionError('请先恢复归档文档。', 409, 'FUSION_ARCHIVED');
    if (workspace.version !== request.baseVersion) throw new FusionError('创作现场已更新，请保留输入并重新读取。', 409, 'FUSION_CONFLICT');
    const operation = await tx.characterFusionOperation.create({ data: { owner_id: actor.id, op_id: request.opId, workspace_id: id, target_kind: 'assistant', fingerprint, status: 'planning', before_version: workspace.version, after_version: workspace.version, result_json: JSON.stringify({ intent: request, resultIds: [] }) } });
    return { status: 'planning' as const, claimed: true as const, intentFingerprint: fingerprint, operation: operationDto(operation), ...await pageWorkspace(tx, workspace) };
  }));
}
export async function finishAssistantOperation(actor: FusionActor, id: string, opId: string, result: { intentFingerprint: string; status: 'cancelled' | 'rejected'; message?: string; proposal?: { reply: string; commands: unknown[]; drafts: unknown[] } }) {
  assertCharacterFusionWritesEnabled(); parseOperationId(opId);
  if (!['cancelled', 'rejected'].includes(result.status) || typeof result.intentFingerprint !== 'string') throw new FusionError('回合终态无效。');
  if (result.proposal && JSON.stringify(result.proposal).length > 30000) throw new FusionError('未应用提案内容过长。');
  return retrySqliteBusy(() => prisma.$transaction(async tx => {
    await requireActiveFusionUser(tx, actor); await owned(tx, actor, id);
    const operation = await tx.characterFusionOperation.findUnique({ where: { owner_id_op_id: { owner_id: actor.id, op_id: opId } } });
    if (!operation || operation.workspace_id !== id || operation.target_kind !== 'assistant' || operation.fingerprint !== result.intentFingerprint) throw new FusionError('原对话回合不匹配。', 409, 'FUSION_OPERATION_REUSED');
    if (operation.status === 'planning') await tx.characterFusionOperation.updateMany({ where: { id: operation.id, status: 'planning' }, data: { status: result.status, result_json: JSON.stringify({ ...JSON.parse(operation.result_json), ...(result.proposal ? { proposal: result.proposal } : {}), error: (result.message || (result.status === 'cancelled' ? '该回合已取消，未应用提案。' : '该回合未应用，请保留输入后重试。')).slice(0, 1000) }) } });
    return queryInDb(tx, actor, id, opId);
  }));
}
export async function cancelAssistantOperation(actor: FusionActor, id: string, opId: string) {
  assertCharacterFusionWritesEnabled(); parseOperationId(opId);
  return retrySqliteBusy(() => prisma.$transaction(async tx => {
    await requireActiveFusionUser(tx, actor); const workspace = await owned(tx, actor, id);
    const operation = await tx.characterFusionOperation.findUnique({ where: { owner_id_op_id: { owner_id: actor.id, op_id: opId } } });
    if (!operation) await tx.characterFusionOperation.create({ data: { owner_id: actor.id, op_id: opId, workspace_id: id, target_kind: 'assistant', fingerprint: fusionFingerprint({ cancelled: true, workspaceId: id, opId }), status: 'cancelled', before_version: workspace.version, after_version: workspace.version, result_json: JSON.stringify({ cancelBeforeReserve: true, resultIds: [], error: '该回合已取消，未应用提案。' }) } });
    else {
      if (operation.workspace_id !== id || operation.target_kind !== 'assistant') throw new FusionError('此编号不属于当前对话回合。', 409, 'FUSION_OPERATION_REUSED');
      if (operation.status === 'planning') await tx.characterFusionOperation.updateMany({ where: { id: operation.id, status: 'planning' }, data: { status: 'cancelled', result_json: JSON.stringify({ ...JSON.parse(operation.result_json), error: '该回合已取消，未应用提案。' }) } });
    }
    return queryInDb(tx, actor, id, opId);
  }));
}
