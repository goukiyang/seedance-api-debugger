import { randomUUID } from 'node:crypto';
import type { CharacterFusionWorkspace, CharacterFusionResult, CharacterFusionOperation } from '@prisma/client';
import { prisma, retrySqliteBusy } from '@/lib/prisma';
import { builtinCatalogue, hydrateCatalogueSettings } from './catalogue';
import { parseFusionSettings } from './actions';
import { settingsForRow, textFor, type FusionSettings } from './engine';
import type { FusionRecipe } from './recipes';
import { assertCharacterFusionWritesEnabled } from './build-mode';
import { FusionError, isRecord, parseOperationId, parseFusionOperationRequest, parseWorkspaceState, emptyWorkspaceState, applyFusionCommands, fusionDocumentDelta, sameFusionValue, type FusionWorkspace, type FusionWorkspaceRow, type FusionUndo, type FusionWorkspaceState } from './actions';
import { fusionFingerprint, requireActiveFusionUser, loadFusionCatalogue, operationDto, type FusionActor, type FusionDb } from './catalogue-repository';
import type { FusionBatchReceipt, FusionEffects } from './domain';
import { effectiveFusionSettings } from './configuration';

export type WorkspacePageQuery = { cursor?: string; limit?: number; allRows?: boolean; rowId?: string; batchId?: string; displayNo?: number };
export type WorkspaceRowsPage = { nextCursor: string | null; total: number; matchedTotal?: number };
const resultDto = (row: CharacterFusionResult): FusionWorkspaceRow => ({ ...JSON.parse(row.row_json), id: row.row_id, version: row.version });
function workspaceDto(row: CharacterFusionWorkspace, rows: FusionWorkspaceRow[]): FusionWorkspace { const state = parseWorkspaceState(JSON.parse(row.state_json)); if (state.summary && !state.summaryMeta) state.summaryMeta = { formatVersion: 1, stateVersion: row.version, legacy: true }; return { id: row.id, name: row.name, version: row.version, state, archived: row.archived, updatedAt: row.updated_at.toISOString(), rows }; }
type StoredWorkspaceResult = { formatVersion?: number; batches?: FusionBatchReceipt[]; effects?: FusionEffects; reply?: string; turn?: { user: string; assistant: string }; continuation?: unknown; phase?: string; rowChanges?: { upsert: FusionWorkspaceRow[]; removedIds: string[] }; resultIds?: string[]; [key: string]: unknown };
async function recentBatches(db: FusionDb, workspaceId: string, limit = 50): Promise<FusionBatchReceipt[]> {
  const operations = await db.characterFusionOperation.findMany({ where: { workspace_id: workspaceId, status: 'committed', result_json: { contains: '"batches":[{' } }, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 100, select: { result_json: true } });
  const seen = new Set<string>();
  return operations.flatMap(operation => ((JSON.parse(operation.result_json) as StoredWorkspaceResult).batches || []).filter(batch => { if (seen.has(batch.id)) return false; seen.add(batch.id); return true; })).slice(0, limit);
}
export function describeFusionWorkspaceEffects(effects: FusionEffects): string {
  const parts: string[] = [];
  for (const batch of effects.batches) parts.push(`已${effects.removedIds.length ? '生成' : '追加'}第${batch.number}批，共${batch.rowIds.length}条`);
  if (effects.modifiedIds.length) parts.push(`已修改${effects.modifiedIds.length}条方案`);
  if (effects.removedIds.length) parts.push(`已移除${effects.removedIds.length}条未保留方案`);
  if (effects.undoneOperationId) parts.push('已撤销刚才的创作修改，对话记录保留');
  if (effects.settingsChanged) parts.push('后续创作要求已更新');
  if (effects.intentChanged) parts.push('明确创作要求已更新');
  if (effects.batches.some(batch => batch.plan?.scope === 'batch' && (batch.plan.overlay?.length || Object.keys(batch.plan.onceMust || {}).length))) parts.push('本批附加要求仅用于本批');
  if (effects.batches.some(batch => batch.allocation?.diversity?.relaxed)) parts.push('当前可用母体较少，已保留所需数量，部分母体重复');
  return parts.length ? parts.join('；') + '。' : '';
}
async function owned(db: FusionDb, actor: FusionActor, id: string) {
  const workspace = await db.characterFusionWorkspace.findFirst({ where: { id, owner_id: actor.id } });
  if (!workspace) throw new FusionError('创作现场不存在或无权读取。', 404, 'FUSION_NOT_FOUND');
  return workspace;
}
async function pageWorkspace(db: FusionDb, row: CharacterFusionWorkspace, query: WorkspacePageQuery = {}) {
  const limit = query.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new FusionError('结果分页大小须为1–200。');
  const scope = query.batchId ? `batch:${query.batchId}` : query.rowId ? `row:${query.rowId}` : query.displayNo !== undefined ? `number:${query.displayNo}` : '';
  let offset = 0;
  if (query.cursor) {
    let cursor: { version: number; workspaceId: string; offset: number; scope?: string };
    try { cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')); } catch { throw new FusionError('结果分页位置无效。'); }
    if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.workspaceId !== row.id || (cursor.scope || '') !== scope) throw new FusionError('结果分页位置或作用范围无效，请沿原批次继续读取。');
    if (cursor.version !== row.version) throw new FusionError('创作现场已更新，请重新读取结果。', 409, 'FUSION_PAGE_CHANGED');
    offset = cursor.offset;
  }
  let rowIds: string[] | undefined;
  if (query.rowId) rowIds = [query.rowId];
  if (query.displayNo !== undefined) {
    if (!Number.isSafeInteger(query.displayNo) || query.displayNo < 1) throw new FusionError('方案编号无效。');
    const matches = await db.$queryRaw<Array<{ row_id: string }>>`SELECT row_id FROM "CharacterFusionResult" WHERE workspace_id = ${row.id} AND json_extract(row_json, '$.displayNo') = ${query.displayNo} LIMIT 2`;
    rowIds = matches.map(item => item.row_id);
  }
  let batches = await recentBatches(db, row.id);
  if (query.batchId) {
    const split = query.batchId.lastIndexOf(':batch:');
    if (split < 0) throw new FusionError('批次编号无效。');
    const source = await db.characterFusionOperation.findUnique({ where: { owner_id_op_id: { owner_id: row.owner_id, op_id: query.batchId.slice(0, split) } } });
    const batch = source?.workspace_id === row.id && source.status === 'committed' ? (JSON.parse(source.result_json) as StoredWorkspaceResult).batches?.find(item => item.id === query.batchId) : undefined;
    if (!batch) throw new FusionError('批次不存在或未记录来源。', 404, 'FUSION_NOT_FOUND');
    rowIds = batch.rowIds;
    batches = [batch, ...batches.filter(item => item.id !== batch.id)];
  }
  const [results, total, filteredTotal] = await Promise.all([
    db.characterFusionResult.findMany({ where: { workspace_id: row.id, ...(rowIds ? { row_id: { in: rowIds } } : {}) }, orderBy: [{ position: 'asc' }, { id: 'asc' }], ...(query.allRows ? {} : { skip: offset, take: limit }) }),
    db.characterFusionResult.count({ where: { workspace_id: row.id } }),
    rowIds ? db.characterFusionResult.count({ where: { workspace_id: row.id, row_id: { in: rowIds } } }) : Promise.resolve(undefined),
  ]);
  const visibleRows = results.map(resultDto);
  const missingBatchIds = Array.from(new Set(visibleRows.flatMap(result => result.originBatchId && !batches.some(batch => batch.id === result.originBatchId) ? [result.originBatchId] : [])));
  if (missingBatchIds.length) {
    const operationIds = Array.from(new Set(missingBatchIds.flatMap(batchId => { const split = batchId.lastIndexOf(':batch:'); return split > 0 ? [batchId.slice(0, split)] : []; })));
    const sources = await db.characterFusionOperation.findMany({ where: { workspace_id: row.id, owner_id: row.owner_id, status: 'committed', op_id: { in: operationIds } }, select: { result_json: true } });
    batches = [...batches, ...sources.flatMap(source => ((JSON.parse(source.result_json) as StoredWorkspaceResult).batches || []).filter(batch => missingBatchIds.includes(batch.id) && visibleRows.some(result => result.originBatchId === batch.id && batch.rowIds.includes(result.id))))];
  }
  const matchedTotal = filteredTotal ?? total;
  const nextCursor = !query.allRows && !query.rowId && query.displayNo === undefined && offset + results.length < matchedTotal ? Buffer.from(JSON.stringify({ version: row.version, workspaceId: row.id, offset: offset + results.length, ...(scope ? { scope } : {}) })).toString('base64url') : null;
  return { workspace: { ...workspaceDto(row, visibleRows), batches }, rowsPage: { nextCursor, total, ...(query.batchId ? { matchedTotal } : {}) } };
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
    if (!query.rowId && query.displayNo === undefined) return page;
    const targetId = query.rowId || page.workspace.rows[0]?.id;
    if (!targetId) throw new FusionError('目标结果不存在。', 404, 'FUSION_NOT_FOUND');
    const result = await tx.characterFusionResult.findUnique({ where: { workspace_id_row_id: { workspace_id: id, row_id: targetId } } });
    if (!result) throw new FusionError('目标结果不存在。', 404, 'FUSION_NOT_FOUND');
    const resolved = await resolveWorkspaceRow(tx, actor, id, resultDto(result));
    const settings = settingsForRow(resolved.catalogueSnapshot?.settings || page.workspace.state.settings, resolved);
    return { ...page, rowSettings: { rowId: result.row_id, version: result.version, settings, body: { zh: textFor(resolved, { ...settings, lang: 'zh' }), en: textFor(resolved, { ...settings, lang: 'en' }) } } }; }));
}
export async function listFusionWorkspaces(actor: FusionActor, query: { archived?: boolean; q?: string; cursor?: string; limit?: number } = {}) {
  await requireActiveFusionUser(prisma, actor);
  const limit = query.limit || 30, search = query.q?.trim() || '';
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || search.length > 100) throw new FusionError('文档查询条件无效。');
  const filter = fusionFingerprint({ archived: Boolean(query.archived), search });
  let after: { updatedAt: string; id: string; filter: string } | undefined;
  if (query.cursor) { try { after = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')); } catch { throw new FusionError('文档分页位置无效。'); } if (!after || after.filter !== filter || !Number.isFinite(new Date(after.updatedAt).getTime()) || typeof after.id !== 'string') throw new FusionError('文档分页条件不匹配。'); }
  const rows = await prisma.characterFusionWorkspace.findMany({ where: { owner_id: actor.id, archived: Boolean(query.archived), ...(search ? { name: { contains: search } } : {}), ...(after ? { OR: [{ updated_at: { lt: new Date(after.updatedAt) } }, { updated_at: new Date(after.updatedAt), id: { lt: after.id } }] } : {}) }, orderBy: [{ updated_at: 'desc' }, { id: 'desc' }], take: limit + 1, select: { id: true, name: true, version: true, archived: true, updated_at: true, state_json: true, _count: { select: { results: true } } } });
  const hasMore = rows.length > limit, items = rows.slice(0, limit), last = items[items.length - 1];
  return { workspaces: items.map(row => {
    const state = parseWorkspaceState(JSON.parse(row.state_json)), settings = state.settings;
    const direction = [state.intent?.requirements.map(item => item.text).join('；'), settings.requirementsEnabled ? settings.requirements : '', settings.role,
      ...Object.values(settings.catalogue?.traits || {}).filter(selection => selection.enabled && selection.locked).flatMap(selection => selection.values),
      ...Object.values(settings.catalogue?.dynamic?.selections || {}).filter(selection => selection.enabled && selection.locked).flatMap(selection => selection.values.map(termId => settings.catalogue?.dynamic?.snapshot.terms.find(term => term.id === termId)?.nameZh || '')),
      ...settings.cards.filter(card => card.joined && card.locked).flatMap(card => card.multi ? card.values || [card.value] : [card.value]),
      ...Object.entries(settings.bossLocks).filter(([, locked]) => locked).map(([dimension]) => settings.boss[dimension as keyof typeof settings.boss]),
    ].filter(Boolean).join('；') || state.idea;
    const batchCount = state.identity && state.identity.nextBatchNo > 1 ? state.identity.nextBatchNo - 1 : undefined;
    return { id: row.id, name: row.name, version: row.version, archived: row.archived, updatedAt: row.updated_at.toISOString(), direction: direction.slice(0, 100), rowCount: row._count.results, ...(batchCount !== undefined ? { batchCount } : {}) };
  }), nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ updatedAt: last.updated_at.toISOString(), id: last.id, filter })).toString('base64url') : null };
}
export async function createFusionWorkspace(actor: FusionActor, input: unknown) {
  assertCharacterFusionWritesEnabled();
  if (!isRecord(input)) throw new FusionError('文档内容无效。');
  const opId = parseOperationId(input.opId), name = input.name === undefined ? '未命名创作' : input.name;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 60) throw new FusionError('文档名称须为1–60字。');
  const parsedState = input.state === undefined ? emptyWorkspaceState() : parseWorkspaceState(input.state);
  const state = { ...parsedState, formatVersion: 2 as const, identity: { nextDisplayNo: 1, nextBatchNo: 1 } };
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
  const result = JSON.parse(operation.result_json) as StoredWorkspaceResult & { error?: string; proposal?: { reply: string; commands: unknown[]; drafts: unknown[] }; recipeIds?: string[] };
  return { status: operation.status as 'planning' | 'committed' | 'rejected' | 'cancelled', operation: operationDto(operation), ...await pageWorkspace(db, workspace), ...(result.error ? { error: result.error } : {}), recipeIds: result.recipeIds || [], ...(result.proposal ? { proposal: result.proposal } : {}), ...(result.continuation ? { continuation: result.continuation, phase: result.phase } : {}), ...(result.reply ? { reply: result.reply } : {}), ...(result.effects ? { effects: result.effects } : {}), ...(result.rowChanges ? { rowChanges: await currentRowChanges(db, id, result) } : {}) };
}
export async function queryWorkspaceOperation(actor: FusionActor, id: string, opId: string) {
  parseOperationId(opId); return retrySqliteBusy(() => prisma.$transaction(async tx => { await requireActiveFusionUser(tx, actor); return queryInDb(tx, actor, id, opId); }));
}
export async function readAssistantOperationStatus(actor: FusionActor, id: string, opId: string) {
  parseOperationId(opId);
  return retrySqliteBusy(() => prisma.$transaction(async tx => {
    await requireActiveFusionUser(tx, actor); await owned(tx, actor, id);
    const operation = await tx.characterFusionOperation.findUnique({ where: { owner_id_op_id: { owner_id: actor.id, op_id: opId } } });
    if (!operation || operation.workspace_id !== id || operation.target_kind !== 'assistant') return { status: 'unknown' as const };
    const result = JSON.parse(operation.result_json) as StoredWorkspaceResult;
    return { status: operation.status as 'planning' | 'committed' | 'rejected' | 'cancelled', phase: result.phase };
  }));
}
function safeBusinessUndo(operation: CharacterFusionOperation): FusionUndo | undefined {
  if (!operation.undo_json || operation.undone_by || operation.status !== 'committed') return undefined;
  const delta = JSON.parse(operation.undo_json) as FusionUndo;
  const result = JSON.parse(operation.result_json) as StoredWorkspaceResult;
  // Legacy combined snapshots cannot safely distinguish discussion from a requirement change.
  if (result.formatVersion !== 2 && delta.fields.some(field => field.path[0] === 'state' && ['messages', 'summary'].includes(field.path[1]))) return undefined;
  const fields = delta.fields.filter(field => field.path[0] !== 'state' || !['messages', 'summary', 'summaryMeta', 'identity', 'formatVersion'].includes(field.path[1]));
  return fields.length || delta.rows.length ? { ...delta, fields } : undefined;
}
export async function readWorkspaceHistory(actor: FusionActor, id: string, query: { cursor?: string; limit?: number } = {}) {
  const limit = query.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new FusionError('对话分页大小须为1–50。');
  let after: { id: string; createdAt: string; workspaceId: string } | undefined;
  if (query.cursor) {
    try { after = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')); } catch { throw new FusionError('对话分页位置无效。'); }
    if (!after || after.workspaceId !== id || typeof after.id !== 'string' || !Number.isFinite(Date.parse(after.createdAt))) throw new FusionError('对话分页位置无效。');
  }
  return retrySqliteBusy(() => prisma.$transaction(async tx => {
    await requireActiveFusionUser(tx, actor); await owned(tx, actor, id);
    const rows = await tx.characterFusionOperation.findMany({ where: { workspace_id: id, owner_id: actor.id, ...(after ? { OR: [{ created_at: { lt: new Date(after.createdAt) } }, { created_at: new Date(after.createdAt), id: { lt: after.id } }] } : {}) }, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: limit + 1 });
    const items = rows.slice(0, limit), last = items[items.length - 1];
    return { operations: items.map(operation => { const result = JSON.parse(operation.result_json) as StoredWorkspaceResult; return { opId: operation.op_id, createdAt: operation.created_at.toISOString(), status: operation.status, ...(result.turn && !result.continuationSourceOpId ? { turn: result.turn } : {}), effects: result.effects, batches: result.batches, reversible: Boolean(safeBusinessUndo(operation)), undoneBy: operation.undone_by || undefined }; }), nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ id: last.id, createdAt: last.created_at.toISOString(), workspaceId: id })).toString('base64url') : null };
  }));
}
export async function listUndoableWorkspaceOperations(actor: FusionActor, id: string, query: { limit?: number } = {}) {
  const limit = query.limit ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 30) throw new FusionError('撤销列表大小须为1–30。');
  return retrySqliteBusy(() => prisma.$transaction(async tx => {
    await requireActiveFusionUser(tx, actor); await owned(tx, actor, id);
    const rows = await tx.characterFusionOperation.findMany({ where: { workspace_id: id, owner_id: actor.id, status: { in: ['committed', 'cancelled'] } }, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 100 });
    const isBusiness = (row: CharacterFusionOperation) => {
      const result = JSON.parse(row.result_json) as StoredWorkspaceResult;
      if (Array.isArray(result.recipeIds) && result.recipeIds.length || result.catalogueOpId) return true;
      const effects = result.effects;
      if (effects && (effects.addedIds.length || effects.modifiedIds.length || effects.removedIds.length || effects.settingsChanged || effects.intentChanged || effects.undoneOperationId)) return true;
      if (!row.undo_json) return false;
      const delta = JSON.parse(row.undo_json) as FusionUndo;
      return Boolean(delta.rows.length || delta.fields.some(field => field.path[0] !== 'state' || !['messages', 'summary', 'summaryMeta', 'identity', 'formatVersion'].includes(field.path[1])));
    };
    const latest = rows.find(isBusiness);
    const blocked = latest && !safeBusinessUndo(latest);
    const latestResult = latest ? JSON.parse(latest.result_json) as StoredWorkspaceResult : undefined;
    const blockedBy = blocked ? { opId: latest.op_id, label: Array.isArray(latestResult?.recipeIds) && latestResult.recipeIds.length ? '保存配方' : latestResult?.catalogueOpId ? '词条入库' : latestResult?.effects?.undoneOperationId ? '已完成的撤销' : '最近的创作操作', reason: latest.undone_by ? '这一步已经撤销，不能再撤销一次。' : '最近这一步不能直接撤销，请明确选择更早的具体操作。' } : undefined;
    return { operations: rows.filter(row => safeBusinessUndo(row)).slice(0, limit).map(operationDto), ...(blockedBy ? { blockedBy } : {}), requiresExplicitChoice: Boolean(blockedBy) };
  }));
}
export async function executeWorkspaceOperation(actor: FusionActor, id: string, input: unknown, options: { assistantFingerprint?: string; turn?: { user: string; assistant: string }; summary?: { text: string; throughOpId?: string }; continuationSource?: { opId: string; planId: string }; catalogueVersion?: string } = {}) {
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
      if (!reserved) { const result = JSON.parse(prior.result_json) as StoredWorkspaceResult & { recipeIds?: string[] }; return { ...await pageWorkspace(tx, workspace), operation: operationDto(prior), recipeIds: result.recipeIds || [], rowChanges: await currentRowChanges(tx, id, result), effects: result.effects, reply: result.reply }; }
    } else if (options.assistantFingerprint) throw new FusionError('对话回合尚未登记，未应用提案。', 409, 'FUSION_ASSISTANT_UNKNOWN');
    let continuationSource: CharacterFusionOperation | undefined;
    if (options.continuationSource) {
      const source = await tx.characterFusionOperation.findUnique({ where: { owner_id_op_id: { owner_id: actor.id, op_id: options.continuationSource.opId } } });
      const plan = source ? (JSON.parse(source.result_json) as StoredWorkspaceResult).continuation : undefined;
      if (!source || source.workspace_id !== id || source.target_kind !== 'assistant' || source.status !== 'planning' || !isRecord(plan) || plan.planId !== options.continuationSource.planId || plan.workspaceOpId !== request.opId || typeof plan.catalogueOpId !== 'string') throw new FusionError('原计划已停止或发生变化，未生成新方案。', 409, 'FUSION_ASSISTANT_FINISHED');
      const catalogueOperation = await tx.characterFusionOperation.findUnique({ where: { owner_id_op_id: { owner_id: actor.id, op_id: plan.catalogueOpId } } });
      if (!catalogueOperation || catalogueOperation.target_kind !== 'catalogue' || catalogueOperation.status !== 'committed') throw new FusionError('词条入库尚未确认，未生成新方案。', 409, 'FUSION_CATALOGUE_UNKNOWN');
      continuationSource = source;
    }
    if (workspace.archived && request.commands.some(command => command.type !== 'archive')) throw new FusionError('请先恢复归档文档再继续编辑。', 409, 'FUSION_ARCHIVED');
    const mutatesRows = request.commands.some(command => ['generate', 'addCurrent', 'changeRow', 'reviseRow', 'patchRow', 'removeRows', 'importDraft', 'undo', 'applyPreparedRow'].includes(command.type));
    const needsRows = mutatesRows || request.commands.some(command => command.type === 'configure' && command.target || command.type === 'prepare' && command.value?.row);
    const storedRows = needsRows ? await tx.characterFusionResult.findMany({ where: { workspace_id: id }, orderBy: [{ position: 'asc' }, { id: 'asc' }] }) : [];
    const originalCurrent = workspaceDto(workspace, storedRows.map(resultDto));
    let nextDisplayNo = Math.max(originalCurrent.state.identity?.nextDisplayNo || 1, ...originalCurrent.rows.map(row => (row.displayNo || 0) + 1));
    const metadataRows = new Set<string>();
    originalCurrent.rows = originalCurrent.rows.map(row => {
      if (row.displayNo) return row;
      metadataRows.add(row.id); return { ...row, displayNo: nextDisplayNo++ };
    });
    originalCurrent.state = { ...originalCurrent.state, formatVersion: 2, identity: { nextDisplayNo, nextBatchNo: originalCurrent.state.identity?.nextBatchNo || 1 } };
    const targetIds = new Set(request.commands.flatMap(command => command.type === 'changeRow' || command.type === 'reviseRow' || command.type === 'applyPreparedRow' || command.type === 'patchRow' && command.patch.requirements ? [command.rowId] : command.type === 'configure' && command.target ? [command.target.rowId] : command.type === 'prepare' && command.value?.row ? [command.value.row.rowId] : []));
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
      undo = options.assistantFingerprint || options.turn ? safeBusinessUndo(undone) : JSON.parse(undone.undo_json) as FusionUndo;
      if (!undo) throw new FusionError('这一步旧操作无法安全分离对话与创作修改，请使用原工作台撤销入口。', 409, 'FUSION_UNDO_LEGACY');
      // Old undo snapshots predate stable display identities; retaining them does not rewrite history.
      undo = { ...undo, rows: undo.rows.map(item => { const row = originalCurrent.rows.find(value => value.id === item.id); return { ...item, ...(item.before ? { before: { ...item.before, ...(row?.displayNo ? { displayNo: row.displayNo } : {}), ...(row?.originBatchId ? { originBatchId: row.originBatchId } : {}) } } : {}), ...(item.after && row ? { after: { ...item.after, displayNo: row.displayNo, ...(row.originBatchId ? { originBatchId: row.originBatchId } : {}) } } : {}) }; }) };
    }
    const needsCatalogue = request.commands.some(command => ['generate', 'addCurrent', 'patchSettings', 'saveRecipe', 'changeRow', 'reviseRow', 'configure', 'prepare', 'applyPreparedRow'].includes(command.type));
    const catalogue = needsCatalogue ? await loadFusionCatalogue(tx, actor.id) : builtinCatalogue();
    if (options.catalogueVersion && catalogue.version !== options.catalogueVersion && needsCatalogue) throw new FusionError('词库在本轮规划后已更新，原提案与输入已保留，请重新核对。', 409, 'FUSION_CATALOGUE_CHANGED');
    const priorBatches = await recentBatches(tx, id, 2);
    const sourceTerms = (row: FusionWorkspaceRow) => Object.entries(row.catalogueSnapshot?.selections || {}).flatMap(([categoryId, values]) => categoryId === 'dimension:source' || row.catalogueSnapshot?.categories.some(category => category.id === categoryId && category.generationKind === 'source') ? values : []);
    const recentSourceIds = Array.from(new Set([...priorBatches.flatMap(batch => batch.allocation?.rows.flatMap(row => Object.entries(row.selections).flatMap(([key, values]) => key === 'dimension:source' || catalogue.categories.some(category => category.id === key && category.generationKind === 'source') ? values : [])) || []), ...current.rows.filter(row => current.state.retainedIds.includes(row.id)).flatMap(sourceTerms)]));
    let next;
    try { next = applyFusionCommands(current, request, catalogue, undo, { recentSourceIds }); } catch (error) { if (error instanceof FusionError) throw error; throw new FusionError(error instanceof Error ? error.message : '角色设置与当前目录不匹配。'); }
    if (!mutatesRows) next.rows = originalCurrent.rows;
    const originalIds = new Set(originalCurrent.rows.map(row => row.id));
    const batches: FusionBatchReceipt[] = [];
    let batchNo = originalCurrent.state.identity?.nextBatchNo || 1;
    let generatedIndex = 0;
    for (const command of request.commands) if (command.type === 'generate' || command.type === 'addCurrent') {
      const prefix = `fusion-${request.opId}-${generatedIndex++}-`;
      const generated = next.rows.filter(row => !originalIds.has(row.id) && row.id.startsWith(prefix));
      if (!generated.length) continue;
      const batchId = `${request.opId}:batch:${batches.length}`;
      const facts = next.generationFacts?.find(fact => fact.rowIds.some(rowId => generated.some(row => row.id === rowId)));
      const rows = generated.map(row => ({ selections: row.catalogueSnapshot?.selections || {} }));
      const sourceIds = generated.flatMap(sourceTerms);
      const unique = new Set(sourceIds).size;
      batches.push({ formatVersion: 1, id: batchId, number: batchNo++, operationId: request.opId, label: command.type === 'generate' && command.plan?.scope === 'batch' ? '本批要求' : batches.length || priorBatches.length ? '新方向' : '初始方向', rowIds: generated.map(row => row.id), createdAt: new Date().toISOString(), ...(command.type === 'generate' && command.plan ? { plan: command.plan } : {}), allocation: facts?.allocation || { formatVersion: 1, rows, diversity: { availableSourceCount: unique, repeatedSourceCount: Math.max(0, generated.length - unique), relaxed: sourceIds.length > 0 && unique < generated.length } } });
      next.rows = next.rows.map(row => generated.some(item => item.id === row.id) ? { ...row, originBatchId: batchId } : row);
    }
    next.rows = next.rows.map(row => !originalIds.has(row.id) && !undoCommand || !row.displayNo ? { ...row, displayNo: nextDisplayNo++ } : row);
    next.state = { ...next.state, formatVersion: 2, identity: { nextDisplayNo, nextBatchNo: batchNo } };
    if (undoCommand) { next.state.summary = ''; next.state.summaryMeta = { formatVersion: 1, stateVersion: next.version, throughOpId: request.opId }; }
    else if (options.summary) { next.state.summary = options.summary.text; next.state.summaryMeta = { formatVersion: 1, stateVersion: next.version, throughOpId: options.summary.throughOpId || request.opId }; }
    const configurations: Record<string, FusionSettings> = {};
    for (const command of request.commands) if (command.type === 'importDraft') for (const row of command.rows) if (row.catalogueSnapshot?.settingsRef && !row.catalogueSnapshot.settings) await resolveWorkspaceRow(tx, actor, id, { ...row, version: 1 });
    const originals = new Map(originalCurrent.rows.map(row => [row.id, row]));
    next.rows = next.rows.map(row => sameFusionValue(row, originals.get(row.id)) ? row : compactWorkspaceRow(row, request.opId, configurations));
    const delta = fusionDocumentDelta(originalCurrent, next, request.commands.some(command => command.type === 'generate' || command.type === 'applyPreparedRow'));
    const effects: FusionEffects = { formatVersion: 1, addedIds: delta.rows.filter(item => !item.before && item.after).map(item => item.id), modifiedIds: delta.rows.filter(item => item.before && item.after).map(item => item.id), removedIds: delta.rows.filter(item => item.before && !item.after).map(item => item.id), retainedIds: next.state.retainedIds, settingsChanged: !sameFusionValue(originalCurrent.state.settings, next.state.settings), intentChanged: !sameFusionValue(originalCurrent.state.intent, next.state.intent), preparationChanged: !sameFusionValue(originalCurrent.state.preparation, next.state.preparation), batches, ...(undoCommand?.type === 'undo' ? { undoneOperationId: undoCommand.operationId } : {}) };
    const configured = request.commands.some(command => command.type === 'configure');
    const reply = configured ? next.state.preparation?.row ? '这条的调整已配好，点击“更新这条”应用。' : `可见卡片已同步，点击“生成${effectiveFusionSettings(next.state.settings, next.state.preparation?.batch, catalogue).count}套提示词”开始。` : describeFusionWorkspaceEffects(effects) || options.turn?.assistant;
    const turn = options.turn ? { user: options.turn.user, assistant: reply || options.turn.assistant } : undefined;
    if (turn) next.state.messages = [...originalCurrent.state.messages, { role: 'user', content: turn.user }, { role: 'assistant', content: turn.assistant }].slice(-20) as FusionWorkspaceState['messages'];
    const rowChanges = { upsert: next.rows.filter(row => metadataRows.has(row.id) || delta.rows.some(item => item.id === row.id && item.after)), removedIds: effects.removedIds };
    const changed = await tx.characterFusionWorkspace.updateMany({ where: { id, owner_id: actor.id, version: workspace.version }, data: { name: next.name, archived: next.archived, state_json: JSON.stringify(next.state), version: next.version } });
    if (changed.count !== 1) throw new FusionError('创作现场已更新，请保留草稿并重新读取。', 409, 'FUSION_CONFLICT');
    if (rowChanges.removedIds.length) await tx.characterFusionResult.deleteMany({ where: { workspace_id: id, row_id: { in: rowChanges.removedIds } } });
    const nextPositions = new Map(next.rows.map((row, index) => [row.id, index]));
    const storedById = new Map(storedRows.map(row => [row.row_id, row]));
    const upsertIds = new Set(rowChanges.upsert.map(row => row.id));
    for (const row of rowChanges.upsert) {
      const data = { row_json: JSON.stringify(row), position: nextPositions.get(row.id)!, version: row.version };
      await tx.characterFusionResult.upsert({ where: { workspace_id_row_id: { workspace_id: id, row_id: row.id } }, create: { workspace_id: id, row_id: row.id, ...data }, update: data });
    }
    // Removing a row shifts positions, but never rewrites untouched frozen row data.
    for (let position = 0; position < next.rows.length; position++) {
      const old = storedById.get(next.rows[position].id);
      if (old && old.position !== position && !upsertIds.has(old.row_id)) await tx.characterFusionResult.update({ where: { id: old.id }, data: { position } });
    }
    const recipeIds: string[] = [];
    for (const command of request.commands) if (command.type === 'saveRecipe') {
      const effective = effectiveFusionSettings(next.state.settings, next.state.preparation?.batch, catalogue);
      const settings = parseFusionSettings({ ...effective, catalogue: hydrateCatalogueSettings(effective.catalogue || { details: {}, traits: {} }, catalogue, effective) });
      const key = `character_fusion_recipe_v1:${command.id}`, old = await tx.userPreference.findUnique({ where: { user_id_key: { user_id: actor.id, key } } });
      if (old) { const recipe = JSON.parse(old.value_json) as FusionRecipe; if (recipe.name !== command.name.trim() || !sameFusionValue(recipe.settings, settings)) throw new FusionError('此配方保存编号已使用，请重新读取原配方。', 409, 'FUSION_OPERATION_REUSED'); }
      else { const recipe: FusionRecipe = { id: command.id, name: command.name.trim(), settings, revision: randomUUID(), updatedAt: new Date().toISOString() }; await tx.userPreference.create({ data: { user_id: actor.id, key, value_json: JSON.stringify(recipe) } }); }
      recipeIds.push(command.id);
    }
    const result = { ...(reserved ? JSON.parse(reserved.result_json) : {}), formatVersion: 2, configurations, recipeIds, resultIds: [...effects.addedIds, ...effects.modifiedIds], rowChanges, batches, effects, ...(reply ? { reply } : {}), ...(turn ? { turn } : {}), ...(continuationSource ? { continuationSourceOpId: continuationSource.op_id } : {}), ...(reserved ? { executionFingerprint: fingerprint } : {}) };
    const data = { before_version: workspace.version, after_version: next.version, status: 'committed', result_json: JSON.stringify(result), undo_json: undoCommand || recipeIds.length || !delta.fields.length && !delta.rows.length ? null : JSON.stringify(delta) };
    let operation: CharacterFusionOperation;
    if (reserved) {
      const applied = await tx.characterFusionOperation.updateMany({ where: { id: reserved.id, status: 'planning', fingerprint: options.assistantFingerprint }, data });
      if (applied.count !== 1) throw new FusionError('该回合已结束，未应用提案。', 409, 'FUSION_ASSISTANT_FINISHED');
      operation = (await tx.characterFusionOperation.findUnique({ where: { id: reserved.id } }))!;
    } else operation = await tx.characterFusionOperation.create({ data: { owner_id: actor.id, op_id: request.opId, workspace_id: id, target_kind: 'workspace', fingerprint, ...data } });
    if (continuationSource) {
      const sourceResult = JSON.parse(continuationSource.result_json) as StoredWorkspaceResult;
      const completed = await tx.characterFusionOperation.updateMany({ where: { id: continuationSource.id, status: 'planning' }, data: { status: 'committed', after_version: next.version, result_json: JSON.stringify({ ...sourceResult, ...result, continuationSourceOpId: undefined, continuation: sourceResult.continuation, phase: 'completed', workspaceOpId: request.opId }) } });
      if (completed.count !== 1) throw new FusionError('原计划已停止，未生成新方案。', 409, 'FUSION_ASSISTANT_FINISHED');
    }
    if (undone) await tx.characterFusionOperation.update({ where: { id: undone.id }, data: { undone_by: request.opId } });
    return { ...await pageWorkspace(tx, (await tx.characterFusionWorkspace.findUnique({ where: { id } }))!), operation: operationDto(operation), rowChanges: { ...rowChanges, ...(delta.rows.length ? { order: next.rows.map(row => row.id) } : {}) }, recipeIds, effects, reply };
  }));
}
export async function reserveAssistantOperation(actor: FusionActor, id: string, request: { opId: string; baseVersion: number; message: string; model: string; target?: { rowId: string; version: number }; scopeChoice?: 'row' | 'document' }) {
  assertCharacterFusionWritesEnabled(); parseOperationId(request.opId);
  if (!Number.isSafeInteger(request.baseVersion) || request.baseVersion < 1 || typeof request.message !== 'string' || !request.message.trim() || request.message.length > 6000 || typeof request.model !== 'string' || !request.model || request.model.length > 80) throw new FusionError('对话回合内容无效。');
  if (request.target && (typeof request.target.rowId !== 'string' || !request.target.rowId || request.target.rowId.length > 180 || !Number.isSafeInteger(request.target.version) || request.target.version < 1) || request.scopeChoice !== undefined && !['row', 'document'].includes(request.scopeChoice)) throw new FusionError('对话作用对象无效。');
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
    if (request.target) { const target = await tx.characterFusionResult.findUnique({ where: { workspace_id_row_id: { workspace_id: id, row_id: request.target.rowId } } }); if (!target || target.version !== request.target.version) throw new FusionError('目标方案已更新，请保留输入后重新选择这张。', 409, 'FUSION_CONFLICT'); }
    const operation = await tx.characterFusionOperation.create({ data: { owner_id: actor.id, op_id: request.opId, workspace_id: id, target_kind: 'assistant', fingerprint, status: 'planning', before_version: workspace.version, after_version: workspace.version, result_json: JSON.stringify({ intent: request, resultIds: [] }) } });
    return { status: 'planning' as const, claimed: true as const, intentFingerprint: fingerprint, operation: operationDto(operation), ...await pageWorkspace(tx, workspace, { limit: 20 }) };
  }));
}
export async function saveAssistantPlan(actor: FusionActor, id: string, opId: string, input: { intentFingerprint: string; plan: unknown }) {
  assertCharacterFusionWritesEnabled(); parseOperationId(opId);
  const plan = input.plan;
  if (!isRecord(plan) || JSON.stringify(plan).length > 100000 || plan.workspaceId !== id || plan.sourceOpId !== opId) throw new FusionError('待入库计划无效。');
  return retrySqliteBusy(() => prisma.$transaction(async tx => {
    await requireActiveFusionUser(tx, actor); await owned(tx, actor, id);
    const operation = await tx.characterFusionOperation.findUnique({ where: { owner_id_op_id: { owner_id: actor.id, op_id: opId } } });
    if (!operation || operation.workspace_id !== id || operation.target_kind !== 'assistant' || operation.fingerprint !== input.intentFingerprint) throw new FusionError('原创作计划不匹配。', 409, 'FUSION_OPERATION_REUSED');
    if (operation.status !== 'planning') return queryInDb(tx, actor, id, opId);
    const result = JSON.parse(operation.result_json) as StoredWorkspaceResult;
    const sourceIntent = isRecord(result.intent) ? result.intent : undefined;
    const planReply = typeof plan.reply === 'string' ? plan.reply : '';
    const turn = sourceIntent && typeof sourceIntent.message === 'string' && planReply ? { user: sourceIntent.message, assistant: planReply } : result.turn;
    await tx.characterFusionOperation.updateMany({ where: { id: operation.id, status: 'planning' }, data: { result_json: JSON.stringify({ ...result, formatVersion: 2, phase: result.phase === 'awaiting_generation' ? result.phase : 'awaiting_catalogue', continuation: plan, ...(turn ? { turn } : {}) }) } });
    return queryInDb(tx, actor, id, opId);
  }));
}
export async function readAssistantPlan(actor: FusionActor, id: string, opId: string) {
  parseOperationId(opId);
  return retrySqliteBusy(() => prisma.$transaction(async tx => {
    await requireActiveFusionUser(tx, actor); await owned(tx, actor, id);
    const operation = await tx.characterFusionOperation.findUnique({ where: { owner_id_op_id: { owner_id: actor.id, op_id: opId } } });
    if (!operation || operation.workspace_id !== id || operation.target_kind !== 'assistant') throw new FusionError('原创作计划不存在。', 404, 'FUSION_NOT_FOUND');
    const result = JSON.parse(operation.result_json) as StoredWorkspaceResult;
    return { ...await queryInDb(tx, actor, id, opId), continuation: result.continuation, intentFingerprint: operation.fingerprint };
  }));
}
export async function completeAssistantPlan(actor: FusionActor, id: string, opId: string, input: { catalogueOpId: string; workspaceOpId?: string; generationStatus: 'committed' | 'rejected' | 'saved'; reply?: string }) {
  assertCharacterFusionWritesEnabled(); parseOperationId(opId); parseOperationId(input.catalogueOpId);
  return retrySqliteBusy(() => prisma.$transaction(async tx => {
    await requireActiveFusionUser(tx, actor); const workspace = await owned(tx, actor, id);
    const operation = await tx.characterFusionOperation.findUnique({ where: { owner_id_op_id: { owner_id: actor.id, op_id: opId } } });
    if (!operation || operation.workspace_id !== id || operation.target_kind !== 'assistant') throw new FusionError('原创作计划不存在。', 404, 'FUSION_NOT_FOUND');
    if (operation.status !== 'planning') return queryInDb(tx, actor, id, opId);
    const result = JSON.parse(operation.result_json) as StoredWorkspaceResult, plan = result.continuation;
    if (!isRecord(plan) || plan.catalogueOpId !== input.catalogueOpId || input.workspaceOpId && plan.workspaceOpId !== input.workspaceOpId) throw new FusionError('接续操作与原计划不匹配。', 409, 'FUSION_OPERATION_REUSED');
    const catalogue = await tx.characterFusionOperation.findUnique({ where: { owner_id_op_id: { owner_id: actor.id, op_id: input.catalogueOpId } } });
    if (!catalogue || catalogue.status !== 'committed' || !catalogue.target_kind.startsWith('catalogue')) throw new FusionError('词条入库尚未确认，请核对原操作。', 409, 'FUSION_CATALOGUE_UNKNOWN');
    const generated = input.workspaceOpId ? await tx.characterFusionOperation.findUnique({ where: { owner_id_op_id: { owner_id: actor.id, op_id: input.workspaceOpId } } }) : null;
    if (input.generationStatus === 'committed' && (!generated || generated.workspace_id !== id || generated.status !== 'committed')) throw new FusionError('方案生成尚未确认，请核对原操作。', 409, 'FUSION_ASSISTANT_UNKNOWN');
    const linked = generated?.status === 'committed' ? JSON.parse(generated.result_json) as StoredWorkspaceResult : {};
    const completed = input.generationStatus !== 'rejected';
    const turn = result.turn ? { user: result.turn.user, assistant: input.reply || result.turn.assistant } : undefined;
    let afterVersion = workspace.version;
    if (input.generationStatus === 'saved' && turn) {
      const state = parseWorkspaceState(JSON.parse(workspace.state_json));
      state.messages = [...state.messages, { role: 'user', content: turn.user }, { role: 'assistant', content: turn.assistant }].slice(-20) as FusionWorkspaceState['messages'];
      afterVersion++;
      const appended = await tx.characterFusionWorkspace.updateMany({ where: { id, owner_id: actor.id, version: workspace.version }, data: { state_json: JSON.stringify(state), version: afterVersion } });
      if (appended.count !== 1) throw new FusionError('创作现场已更新，请核对原保存回执。', 409, 'FUSION_CONFLICT');
    }
    await tx.characterFusionOperation.updateMany({ where: { id: operation.id, status: 'planning' }, data: { status: completed ? 'committed' : 'planning', after_version: afterVersion, result_json: JSON.stringify({ ...result, ...linked, continuation: plan, phase: completed ? 'completed' : 'awaiting_generation', catalogueOpId: input.catalogueOpId, workspaceOpId: input.workspaceOpId, ...(input.reply ? { reply: input.reply } : {}), ...(turn ? { turn } : {}) }) } });
    return queryInDb(tx, actor, id, opId);
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
      if (operation.status === 'planning') {
        const result = JSON.parse(operation.result_json) as StoredWorkspaceResult, plan = result.continuation;
        const catalogue = isRecord(plan) && typeof plan.catalogueOpId === 'string' ? await tx.characterFusionOperation.findUnique({ where: { owner_id_op_id: { owner_id: actor.id, op_id: plan.catalogueOpId } } }) : null;
        const saved = catalogue?.target_kind === 'catalogue' && catalogue.status === 'committed';
        const message = saved ? '词条已入库并保留；后续计划已停止，本次未生成。' : isRecord(plan) ? '本次计划已取消，未入库或生成。' : '该回合已取消，未应用提案。';
        await tx.characterFusionOperation.updateMany({ where: { id: operation.id, status: 'planning' }, data: { status: 'cancelled', result_json: JSON.stringify({ ...result, ...(saved && isRecord(plan) ? { catalogueOpId: plan.catalogueOpId, phase: 'catalogue_saved_cancelled' } : {}), ...(result.turn ? { turn: { user: result.turn.user, assistant: message } } : {}), error: message }) } });
      }
    }
    return queryInDb(tx, actor, id, opId);
  }));
}
