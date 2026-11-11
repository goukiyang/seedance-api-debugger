import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma, retrySqliteBusy } from '@/lib/prisma';
import { builtinCatalogue } from './catalogue';
import { parseFusionCatalogue, isExtensionId, type FusionCategory, type FusionTerm, type FusionCatalogue } from './catalogue-model';
import { FusionError, isRecord, parseOperationId, stableStringify, type FusionOperation } from './actions';
import { assertCharacterFusionWritesEnabled } from './build-mode';

export type FusionActor = { id: string; role?: string };
export type CatalogueQuery = { categoryId?: string; q?: string; cursor?: string; limit?: number; includeDisabled?: boolean };
export type CatalogueEntry = { kind: 'category' | 'term'; data: Partial<FusionCategory & FusionTerm>; expectedVersion?: string };
export type CataloguePreviewEntry = { index: number; status: 'new' | 'update' | 'duplicate' | 'error'; message?: string; code?: string; httpStatus?: number; entry?: CatalogueEntry };
export type CataloguePreview = { version: string; entries: CataloguePreviewEntry[]; errors: number; duplicates: number; canImport: boolean };
export type CatalogueManageRequest =
  | { action: 'preview'; scope: 'private' | 'shared'; entries: CatalogueEntry[] }
  | { action: 'import'; scope: 'private' | 'shared'; entries: CatalogueEntry[]; opId: string; previewVersion: string; continuation?: unknown }
  | { action: 'upsert'; scope: 'private' | 'shared'; entry: CatalogueEntry; opId: string }
  | { action: 'rename' | 'disable'; scope: 'private' | 'shared'; kind: 'category' | 'term'; id: string; expectedVersion: string; opId: string; nameZh?: string; nameEn?: string; enabled?: boolean };
export type FusionDb = Prisma.TransactionClient;
export const fusionFingerprint = (value: unknown) => createHash('sha256').update(stableStringify(value)).digest('hex');

export async function requireActiveFusionUser(db: FusionDb, actor: FusionActor) {
  const user = await db.user.findUnique({ where: { id: actor.id }, select: { id: true, role: true, status: true, expires_at: true } });
  if (!user || user.status !== 'active' || user.expires_at && user.expires_at.getTime() <= Date.now()) throw new FusionError('账号当前不可用。', 403, 'FUSION_FORBIDDEN');
  return user;
}
export function operationDto(row: { id: string; op_id: string; workspace_id: string | null; before_version: number; after_version: number; result_json: string; undo_json: string | null; undone_by: string | null; created_at: Date; status: string }): FusionOperation {
  const result = JSON.parse(row.result_json) as { resultIds?: string[]; effects?: FusionOperation['effects']; batches?: NonNullable<FusionOperation['batch']>[]; reply?: string; turn?: { user: string; assistant: string } };
  return { id: row.id, opId: row.op_id, workspaceId: row.workspace_id, status: row.status as FusionOperation['status'], beforeVersion: row.before_version, afterVersion: row.after_version, resultIds: result.resultIds || [], reversible: Boolean(row.undo_json && !row.undone_by), createdAt: row.created_at.toISOString(), ...(result.effects ? { effects: result.effects } : {}), ...(result.batches?.[0] ? { batch: result.batches[0] } : {}), ...(result.reply ? { reply: result.reply } : {}), ...(row.undone_by ? { undoneBy: row.undone_by } : {}), ...(result.turn ? { turn: result.turn } : {}) };
}
export async function loadFusionCatalogue(db: FusionDb, ownerId: string, sharedOnly = false): Promise<FusionCatalogue> {
  const [categories, terms] = await Promise.all([
    db.characterFusionCategory.findMany({ where: { OR: [{ scope: 'shared' }, ...(sharedOnly ? [] : [{ scope_key: `user:${ownerId}` }])] }, orderBy: [{ scope: 'desc' }, { stable_id: 'asc' }] }),
    db.characterFusionTerm.findMany({ where: { OR: [{ scope: 'shared' }, ...(sharedOnly ? [] : [{ scope_key: `user:${ownerId}` }])] }, orderBy: [{ scope: 'desc' }, { stable_id: 'asc' }] }),
  ]);
  const builtin = builtinCatalogue(), categoryMap = new Map(builtin.categories.map(category => [category.id, category])), termMap = new Map(builtin.terms.map(term => [term.id, term]));
  // Shared definitions first, explicit personal overrides last.
  for (const row of [...categories.filter(row => row.scope === 'shared'), ...categories.filter(row => row.scope !== 'shared')]) categoryMap.set(row.stable_id, JSON.parse(row.definition_json) as FusionCategory);
  for (const row of [...terms.filter(row => row.scope === 'shared'), ...terms.filter(row => row.scope !== 'shared')]) termMap.set(row.stable_id, JSON.parse(row.definition_json) as FusionTerm);
  const content = { categories: Array.from(categoryMap.values()).sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)), terms: Array.from(termMap.values()).sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)) };
  return { version: fusionFingerprint(content), ...content };
}
export async function readFusionCatalogue(actor: FusionActor, query?: CatalogueQuery) {
  return retrySqliteBusy(() => prisma.$transaction(async tx => {
  await requireActiveFusionUser(tx, actor);
  const catalogue = await loadFusionCatalogue(tx, actor.id);
  if (!query) return { catalogue, nextCursor: null, total: catalogue.terms.length };
  const q = (query.q || '').trim().toLocaleLowerCase();
  if (q.length > 200 || query.categoryId && query.categoryId.length > 700 || query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 200)) throw new FusionError('目录查询条件无效。');
  const limit = query.limit || 100, signature = fusionFingerprint({ categoryId: query.categoryId || '', q, includeDisabled: Boolean(query.includeDisabled) });
  let offset = 0;
  if (query.cursor) {
    let cursor: { version: string; offset: number; signature: string };
    try { cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')); } catch { throw new FusionError('目录分页位置无效。'); }
    if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.signature !== signature) throw new FusionError('目录分页条件不匹配。');
    if (cursor.version !== catalogue.version) throw new FusionError('目录已更新，请重新检索。', 409, 'FUSION_CATALOGUE_CHANGED');
    offset = cursor.offset;
  }
  const activeCategories = new Set(catalogue.categories.filter(category => category.enabled).map(category => category.id));
  const matches = catalogue.terms.filter(term => (!query.categoryId || term.categoryId === query.categoryId) && (query.includeDisabled || term.enabled && activeCategories.has(term.categoryId)) && (!q || [term.nameZh, term.nameEn, term.descriptionZh, term.descriptionEn, ...term.aliases, ...term.tags].some(value => value.toLocaleLowerCase().includes(q))));
  const next = offset + limit < matches.length ? Buffer.from(JSON.stringify({ version: catalogue.version, offset: offset + limit, signature })).toString('base64url') : null;
  return { catalogue: { ...catalogue, terms: matches.slice(offset, offset + limit) }, nextCursor: next, total: matches.length };
  }));
}
function scopeKey(scope: 'private' | 'shared', ownerId: string) { return scope === 'shared' ? 'shared' : `user:${ownerId}`; }
function parseManage(input: unknown): CatalogueManageRequest {
  if (!isRecord(input) || !['preview', 'import', 'upsert', 'rename', 'disable'].includes(String(input.action)) || !['private', 'shared'].includes(String(input.scope))) throw new FusionError('目录操作无效。');
  if (input.action !== 'preview') parseOperationId(input.opId);
  if (['preview', 'import'].includes(String(input.action)) && (!Array.isArray(input.entries) || !input.entries.length || input.entries.length > 100)) throw new FusionError('每次导入须有1–100条定义。');
  if (input.action === 'upsert' && !isRecord(input.entry)) throw new FusionError('缺少目录定义。');
  if (['rename', 'disable'].includes(String(input.action)) && (!['category', 'term'].includes(String(input.kind)) || typeof input.id !== 'string' || typeof input.expectedVersion !== 'string')) throw new FusionError('请携带当前目录版本后操作。');
  if (input.action === 'import' && typeof input.previewVersion !== 'string') throw new FusionError('请先预览本批内容。');
  if (input.action === 'import' && input.continuation !== undefined && (!isRecord(input.continuation) || input.continuation.formatVersion !== 1 || input.scope !== 'private' || typeof input.continuation.sourceOpId !== 'string' || input.continuation.catalogueOpId !== input.opId || JSON.stringify(input.continuation).length > 100000)) throw new FusionError('扩库接续计划关联无效。');
  return input as CatalogueManageRequest;
}
function normalizeEntry(entry: unknown, scope: 'private' | 'shared', ownerId: string, catalogue: FusionCatalogue): CatalogueEntry {
  if (!isRecord(entry) || !['category', 'term'].includes(String(entry.kind)) || !isRecord(entry.data)) throw new FusionError('词库条目格式无效。');
  const data = entry.data, existing = (entry.kind === 'category' ? catalogue.categories : catalogue.terms).find(item => item.id === data.id);
  const builtin = existing?.scope === 'builtin';
  if (existing && !builtin && (existing.scope !== scope || scope === 'private' && existing.ownerId !== ownerId)) throw new FusionError('无法覆盖其它范围的目录定义。', 403, 'FUSION_FORBIDDEN');
  if (existing && !builtin && entry.expectedVersion !== existing.version || existing && builtin && entry.expectedVersion !== existing.version) throw new FusionError('目录项已更新，请重新读取。', 409, 'FUSION_CONFLICT');
  const id = typeof data.id === 'string' && data.id ? data.id : randomUUID();
  if (!existing && !isExtensionId(id)) throw new FusionError('新增目录项须使用稳定UUID。');
  const definition = { ...existing, ...data, id, scope: builtin ? 'builtin' : scope, ownerId: builtin ? null : existing?.ownerId || ownerId, version: existing?.version || 'draft', enabled: data.enabled ?? existing?.enabled ?? true,
    descriptionZh: data.descriptionZh || data.nameZh || existing?.descriptionZh || '', descriptionEn: data.descriptionEn || data.nameEn || existing?.descriptionEn || '', aliases: data.aliases ?? existing?.aliases ?? [], tags: data.tags ?? existing?.tags ?? [], sortOrder: data.sortOrder ?? existing?.sortOrder ?? 0,
    ...(entry.kind === 'category' ? { group: data.group ?? (existing as FusionCategory)?.group ?? 'extra', multi: data.multi ?? (existing as FusionCategory)?.multi ?? false, randomMax: data.randomMax ?? (existing as FusionCategory)?.randomMax ?? 1, generationKind: builtin ? (existing as FusionCategory).generationKind : 'trait' } : {}) };
  if (entry.kind === 'term' && scope === 'shared' && catalogue.categories.find(category => category.id === data.categoryId)?.scope === 'private') throw new FusionError('共享词条不能引用个人类别。', 403, 'FUSION_FORBIDDEN');
  const parsed = entry.kind === 'category' ? parseFusionCatalogue({ version: 'preview', categories: [definition], terms: [] }).categories[0] : parseFusionCatalogue({ version: 'preview', categories: catalogue.categories, terms: [definition] }).terms[0];
  return { kind: entry.kind as 'category' | 'term', data: parsed, ...(entry.expectedVersion ? { expectedVersion: entry.expectedVersion as string } : {}) };
}
function previewEntries(raw: CatalogueEntry[], scope: 'private' | 'shared', ownerId: string, catalogue: FusionCatalogue): CataloguePreview {
  const draft: FusionCatalogue = { ...catalogue, categories: [...catalogue.categories], terms: [...catalogue.terms] }, entries: CataloguePreviewEntry[] = [];
  // Categories are validated first so terms may refer to a category in the same finite batch.
  for (const { item, index } of raw.map((item, index) => ({ item, index })).sort((a, b) => Number(b.item?.kind === 'category') - Number(a.item?.kind === 'category'))) {
    try {
      const entry = normalizeEntry(item, scope, ownerId, draft), data = entry.data;
      const collection: Array<FusionCategory | FusionTerm> = entry.kind === 'category' ? draft.categories : draft.terms;
      const old = collection.find(value => value.id === data.id);
      const duplicate = collection.find(value => value.id !== data.id && value.scope === scope && (scope === 'shared' || value.ownerId === ownerId) && (entry.kind === 'category' || (value as FusionTerm).categoryId === data.categoryId) && value.nameZh.trim().normalize('NFKC').toLocaleLowerCase() === data.nameZh!.trim().normalize('NFKC').toLocaleLowerCase());
      if (duplicate) entries.push({ index, status: 'duplicate', message: `与「${duplicate.nameZh}」重复，请复用原项（${duplicate.id}）。`, entry });
      else {
        if (old) collection.splice(collection.indexOf(old), 1);
        collection.push(data as FusionCategory | FusionTerm);
        entries.push({ index, status: old ? 'update' : 'new', entry });
      }
    } catch (error) { entries.push({ index, status: 'error', message: error instanceof Error ? error.message : '定义无效。', ...(error instanceof FusionError ? { code: error.code, httpStatus: error.status } : {}) }); }
  }
  entries.sort((a, b) => a.index - b.index);
  const errors = entries.filter(entry => entry.status === 'error').length, duplicates = entries.filter(entry => entry.status === 'duplicate').length;
  return { version: catalogue.version, entries, errors, duplicates, canImport: errors === 0 && duplicates === 0 };
}
export async function queryCatalogueOperation(actor: FusionActor, opId: string) {
  parseOperationId(opId); await requireActiveFusionUser(prisma, actor);
  const operation = await prisma.characterFusionOperation.findUnique({ where: { owner_id_op_id: { owner_id: actor.id, op_id: opId } } });
  if (!operation || operation.target_kind !== 'catalogue') return { status: 'unknown' as const };
  const result = JSON.parse(operation.result_json) as { changedIds: string[]; continuation?: unknown };
  return { status: 'committed' as const, operation: operationDto(operation), changedIds: result.changedIds, ...(result.continuation ? { continuation: result.continuation } : {}) };
}
export async function manageFusionCatalogue(actor: FusionActor, input: unknown) {
  const request = parseManage(input);
  if (request.action !== 'preview') assertCharacterFusionWritesEnabled();
  return retrySqliteBusy(() => prisma.$transaction(async tx => {
    const user = await requireActiveFusionUser(tx, actor);
    if (request.scope === 'shared' && user.role !== 'admin') throw new FusionError('共享词库仅管理员可维护。', 403, 'FUSION_FORBIDDEN');
    const catalogue = await loadFusionCatalogue(tx, actor.id, request.scope === 'shared');
    if (request.action === 'preview') return { preview: previewEntries(request.entries, request.scope, actor.id, catalogue) };
    const fingerprint = fusionFingerprint(request);
    const prior = await tx.characterFusionOperation.findUnique({ where: { owner_id_op_id: { owner_id: actor.id, op_id: request.opId } } });
    if (prior) {
      if (prior.target_kind !== 'catalogue' || prior.fingerprint !== fingerprint) throw new FusionError('此操作编号已用于其它内容，请查询原回执。', 409, 'FUSION_OPERATION_REUSED');
      const original = JSON.parse(prior.result_json) as { changedIds: string[]; continuation?: unknown };
      return { catalogue, operation: operationDto(prior), changedIds: original.changedIds, ...(original.continuation ? { continuation: original.continuation } : {}) };
    }
    if (request.action === 'import' && isRecord(request.continuation)) {
      const plan = request.continuation;
      const source = await tx.characterFusionOperation.findUnique({ where: { owner_id_op_id: { owner_id: actor.id, op_id: String(plan.sourceOpId) } } });
      const original = source ? JSON.parse(source.result_json) as { continuation?: unknown } : undefined;
      if (!source || source.target_kind !== 'assistant' || source.status !== 'planning' || source.workspace_id !== plan.workspaceId || fusionFingerprint(original?.continuation) !== fusionFingerprint(plan)) throw new FusionError('原扩库计划已结束或发生变化，保留草稿，未入库。', 409, 'FUSION_ASSISTANT_FINISHED');
      const workspace = await tx.characterFusionWorkspace.findFirst({ where: { id: source.workspace_id!, owner_id: actor.id } });
      if (!workspace || workspace.version !== plan.baseVersion) throw new FusionError('创作条件或目标版本已变，原扩库计划已保留。', 409, 'FUSION_CONFLICT');
    }
    let raw: CatalogueEntry[];
    if (request.action === 'import') {
      if (request.previewVersion !== catalogue.version) throw new FusionError('目录已更新，请重新预览本批内容。', 409, 'FUSION_CATALOGUE_CHANGED');
      raw = request.entries;
    } else if (request.action === 'upsert') raw = [request.entry];
    else {
      const current = (request.kind === 'category' ? catalogue.categories : catalogue.terms).find(item => item.id === request.id);
      if (!current) throw new FusionError('目录项不存在。', 404, 'FUSION_NOT_FOUND');
      const patch = request.action === 'disable' ? { enabled: request.enabled ?? false } : { nameZh: request.nameZh ?? current.nameZh, nameEn: request.nameEn ?? current.nameEn };
      raw = [{ kind: request.kind, data: { ...current, ...patch }, expectedVersion: request.expectedVersion }];
    }
    const preview = previewEntries(raw, request.scope, actor.id, catalogue);
    if (!preview.canImport) { const status = preview.entries.some(entry => entry.httpStatus === 403) ? 403 : preview.entries.some(entry => entry.httpStatus === 409) ? 409 : 400; throw new FusionError(status === 409 ? '目录项已更新，请保留草稿并重新读取。' : '本批存在重复或无效定义，未写入任何条目。', status, status === 409 ? 'FUSION_CONFLICT' : 'FUSION_IMPORT_INVALID', preview); }
    const changedIds: string[] = [], key = scopeKey(request.scope, actor.id);
    for (const item of [...preview.entries].sort((a, b) => Number(b.entry!.kind === 'category') - Number(a.entry!.kind === 'category'))) {
      const entry = item.entry!, definition = { ...entry.data, version: randomUUID() }, stableId = definition.id!;
      if (entry.kind === 'category') await tx.characterFusionCategory.upsert({ where: { scope_key_stable_id: { scope_key: key, stable_id: stableId } }, create: { stable_id: stableId, scope_key: key, scope: request.scope, owner_id: actor.id, version: definition.version, enabled: definition.enabled!, definition_json: JSON.stringify(definition) }, update: { version: definition.version, enabled: definition.enabled!, definition_json: JSON.stringify(definition) } });
      else {
        const category = await tx.characterFusionCategory.findFirst({ where: { stable_id: definition.categoryId, OR: [{ scope_key: key }, { scope: 'shared' }] }, orderBy: { scope: 'asc' } });
        const data = { category_id: definition.categoryId!, category_record_id: category?.id || null, version: definition.version, enabled: definition.enabled!, definition_json: JSON.stringify(definition) };
        await tx.characterFusionTerm.upsert({ where: { scope_key_stable_id: { scope_key: key, stable_id: stableId } }, create: { stable_id: stableId, scope_key: key, scope: request.scope, owner_id: actor.id, ...data }, update: data });
      }
      changedIds.push(stableId);
    }
    const updated = await loadFusionCatalogue(tx, actor.id);
    const operation = await tx.characterFusionOperation.create({ data: { owner_id: actor.id, op_id: request.opId, target_kind: 'catalogue', fingerprint, result_json: JSON.stringify({ changedIds, catalogueVersion: updated.version, ...(request.action === 'import' && request.continuation ? { continuation: request.continuation } : {}) }) } });
    return { catalogue: updated, operation: operationDto(operation), changedIds, ...(request.action === 'import' && request.continuation ? { continuation: request.continuation } : {}) };
  }));
}
