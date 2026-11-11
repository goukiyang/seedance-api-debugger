import { CONFIG, defaults, parseSettings as parseRawSettings, generateBatch, changeRow, reviseRow, settingsForRow, bossRow, refreshRowSnapshot, type Dimension, type FusionSettings, type FusionRow } from './engine';
import type { FusionCatalogue } from './catalogue-model';
import { hydrateCatalogueSettings, builtinCatalogue } from './catalogue';

export type FusionMessage = { role: 'user' | 'assistant'; content: string };
export type FusionWorkspaceState = { settings: FusionSettings; idea: string; summary: string; messages: FusionMessage[]; selectedIds: string[]; retainedIds: string[] };
export type FusionWorkspaceRow = FusionRow & { version: number };
export type FusionWorkspace = { id: string; name: string; version: number; state: FusionWorkspaceState; archived: boolean; updatedAt: string; rows: FusionWorkspaceRow[] };
export type FusionFieldChange = { path: string[]; value: unknown; expected?: unknown };
export type FusionCommand =
  | { type: 'patchSettings'; patch?: Partial<FusionSettings>; expected?: Partial<FusionSettings>; changes?: FusionFieldChange[] }
  | { type: 'generate'; mode: 'append' | 'replace'; seed: number; settingsHash?: string; expectedRows?: Record<string, number> }
  | { type: 'addCurrent'; seed: number }
  | { type: 'patchRow'; rowId: string; expectedVersion?: number; patch: { advanced?: boolean; translations?: FusionRow['translations']; requirements?: { zh: string; en: string } } }
  | { type: 'changeRow'; rowId: string; dimension?: Dimension; value?: string; seed: number; expectedVersion?: number }
  | { type: 'reviseRow'; rowId: string; axis?: string; settings?: FusionSettings; seed: number; expectedVersion?: number }
  | { type: 'removeRows'; rowIds: string[]; expectedVersions?: Record<string, number> }
  | { type: 'selection'; selectedIds?: string[]; retainedIds?: string[]; expected?: { selectedIds?: string[]; retainedIds?: string[] } }
  | { type: 'context'; idea?: string; summary?: string; messages?: FusionMessage[]; expected?: Partial<Pick<FusionWorkspaceState, 'idea' | 'summary' | 'messages'>> }
  | { type: 'importDraft'; state: FusionWorkspaceState; rows: FusionRow[] }
  | { type: 'saveRecipe'; id: string; name: string; settingsHash?: string }
  | { type: 'undo'; operationId: string }
  | { type: 'rename'; name: string; expected?: string }
  | { type: 'archive'; archived: boolean; expected?: boolean };
export type FusionOperationRequest = { opId: string; baseVersion: number; commands: FusionCommand[] };
export type FusionOperation = { id: string; opId: string; workspaceId: string | null; status: 'planning' | 'committed' | 'rejected' | 'cancelled'; beforeVersion: number; afterVersion: number; resultIds: string[]; reversible: boolean; createdAt: string };
export type FusionDocument = Pick<FusionWorkspace, 'name' | 'archived' | 'version' | 'state' | 'rows'>;
export type FusionUndo = { fields: Array<{ path: string[]; before: unknown; after: unknown }>; rows: Array<{ id: string; before: FusionWorkspaceRow | null; after: FusionWorkspaceRow | null; beforeIndex: number; afterIndex: number }> };
export class FusionError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'FUSION_INVALID', readonly details?: unknown) { super(message); }
}
export function parseFusionSettings(value: unknown): FusionSettings {
  try { return parseRawSettings(value); } catch (error) { throw new FusionError(error instanceof Error ? error.message : '角色设置无效。'); }
}
export const isRecord = (input: unknown): input is Record<string, unknown> => Boolean(input && typeof input === 'object' && !Array.isArray(input));
export function stableStringify(input: unknown): string {
  if (input === undefined) return 'null';
  if (input === null || typeof input !== 'object') return JSON.stringify(input);
  if (Array.isArray(input)) return '[' + input.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(input).sort().map(key => JSON.stringify(key) + ':' + stableStringify((input as Record<string, unknown>)[key])).join(',') + '}';
}
export const sameFusionValue = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);
/** Browser/server shared stale-generation guard, not a security digest. */
export function settingsFingerprint(settings: FusionSettings) {
  let hash = 2166136261;
  for (const character of stableStringify(settings)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16);
}
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
function text(value: unknown, max: number, label: string, empty = true): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw new FusionError(`${label}无效。`);
  return value;
}
export function parseOperationId(value: unknown) { const id = text(value, 120, '操作编号', false); if (!/^[a-zA-Z0-9_-]{8,120}$/.test(id)) throw new FusionError('操作编号无效。'); return id; }
function ids(value: unknown, label = '结果选择'): string[] {
  if (!Array.isArray(value) || value.length > 10000 || value.some(id => typeof id !== 'string' || !id || id.length > 180) || new Set(value).size !== value.length) throw new FusionError(`${label}无效。`);
  return value;
}
function messages(value: unknown): FusionMessage[] {
  if (!Array.isArray(value) || value.length > 20 || value.some(message => !isRecord(message) || !['user', 'assistant'].includes(String(message.role)) || typeof message.content !== 'string' || message.content.length > 6000)) throw new FusionError('最近对话最多20条，每条最多6000字。');
  return value as FusionMessage[];
}
export function parseWorkspaceState(value: unknown): FusionWorkspaceState {
  if (!isRecord(value)) throw new FusionError('创作现场无效。');
  return { settings: parseFusionSettings(value.settings), idea: text(value.idea, 12000, '原始想法'), summary: text(value.summary, 12000, '创作摘要'), messages: messages(value.messages), selectedIds: ids(value.selectedIds), retainedIds: ids(value.retainedIds) };
}
export function emptyWorkspaceState(): FusionWorkspaceState { return { settings: defaults(), idea: '', summary: '', messages: [], selectedIds: [], retainedIds: [] }; }
function rowInput(value: unknown): FusionRow {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length > 180 || !value.id || typeof value.name !== 'string' || !isRecord(value.category) || !isRecord(value.source) || !isRecord(value.concept) || !isRecord(value.mechanism) || !isRecord(value.personality) || !isRecord(value.detail) || typeof value.bridge !== 'string' || typeof value.advanced !== 'boolean') throw new FusionError('承接草稿的结果无效。');
  return value as FusionRow;
}
function validPath(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || !value.length || value.length > 8 || value.some(key => typeof key !== 'string' || !key || ['__proto__', 'prototype', 'constructor'].includes(key))) throw new FusionError('设置字段路径无效。');
}
export function parseFusionCommands(value: unknown): FusionCommand[] {
  if (!Array.isArray(value) || !value.length || value.length > 30) throw new FusionError('一次操作须有1–30条命令。');
  for (const raw of value) {
    if (!isRecord(raw)) throw new FusionError('操作内容无效。');
    if (['generate', 'addCurrent', 'changeRow', 'reviseRow'].includes(String(raw.type)) && !Number.isSafeInteger(raw.seed)) throw new FusionError('抽卡种子无效。');
    if (raw.expectedVersion !== undefined && (!Number.isSafeInteger(raw.expectedVersion) || (raw.expectedVersion as number) < 1)) throw new FusionError('结果版本无效。');
    switch (raw.type) {
      case 'patchSettings':
        if (raw.patch !== undefined && !isRecord(raw.patch) || raw.expected !== undefined && !isRecord(raw.expected) || raw.changes !== undefined && (!Array.isArray(raw.changes) || raw.changes.length > 200) || !raw.patch && !raw.changes) throw new FusionError('局部设置无效。');
        for (const change of (raw.changes || []) as unknown[]) { if (!isRecord(change) || !own(change, 'value')) throw new FusionError('字段修改无效。'); validPath(change.path); }
        break;
      case 'generate': if (!['append', 'replace'].includes(String(raw.mode)) || raw.settingsHash !== undefined && typeof raw.settingsHash !== 'string') throw new FusionError('抽卡模式无效。'); if (raw.expectedRows !== undefined && (!isRecord(raw.expectedRows) || Object.values(raw.expectedRows).some(version => !Number.isSafeInteger(version) || (version as number) < 1))) throw new FusionError('结果基础版本无效。'); break;
      case 'changeRow': text(raw.rowId, 180, '结果编号', false); if (raw.dimension !== undefined && !CONFIG.some(c => c.id === raw.dimension) || raw.dimension !== undefined && typeof raw.value !== 'string') throw new FusionError('替换维度和值无效。'); break;
      case 'addCurrent': break;
      case 'patchRow':
        text(raw.rowId, 180, '结果编号', false);
        if (!isRecord(raw.patch) || Object.keys(raw.patch).some(key => !['advanced', 'translations', 'requirements'].includes(key)) || raw.patch.advanced !== undefined && typeof raw.patch.advanced !== 'boolean') throw new FusionError('结果修改内容无效。');
        if (raw.patch.translations !== undefined && (!Array.isArray(raw.patch.translations) || raw.patch.translations.length > 100 || raw.patch.translations.some(item => !isRecord(item) || !CONFIG.some(c => c.id === item.dimension) || typeof item.label !== 'string' || typeof item.en !== 'string' || item.en.length > 1000))) throw new FusionError('结果翻译无效。');
        if (raw.patch.requirements !== undefined && (!isRecord(raw.patch.requirements) || typeof raw.patch.requirements.zh !== 'string' || raw.patch.requirements.zh.length > 12000 || typeof raw.patch.requirements.en !== 'string' || raw.patch.requirements.en.length > 12000)) throw new FusionError('结果要求翻译无效。');
        break;
      case 'reviseRow': text(raw.rowId, 180, '结果编号', false); if (raw.axis !== undefined) text(raw.axis, 120, '调整轴', false); if (raw.settings !== undefined) parseFusionSettings(raw.settings); if (raw.axis === undefined && raw.settings === undefined) throw new FusionError('缺少调整轴或单条设置。'); break;
      case 'removeRows': ids(raw.rowIds); if (raw.expectedVersions !== undefined && (!isRecord(raw.expectedVersions) || Object.values(raw.expectedVersions).some(v => !Number.isSafeInteger(v) || (v as number) < 1))) throw new FusionError('结果版本无效。'); break;
      case 'selection':
        if (raw.selectedIds === undefined && raw.retainedIds === undefined) throw new FusionError('缺少选择内容。');
        if (raw.selectedIds !== undefined) ids(raw.selectedIds); if (raw.retainedIds !== undefined) ids(raw.retainedIds); if (raw.expected !== undefined && !isRecord(raw.expected)) throw new FusionError('选择旧值无效。'); break;
      case 'context':
        if (raw.idea !== undefined) text(raw.idea, 12000, '原始想法'); if (raw.summary !== undefined) text(raw.summary, 12000, '创作摘要'); if (raw.messages !== undefined) messages(raw.messages); if (raw.expected !== undefined && !isRecord(raw.expected)) throw new FusionError('摘要旧值无效。'); break;
      case 'importDraft':
        parseWorkspaceState(raw.state); if (!Array.isArray(raw.rows) || raw.rows.length > 500) throw new FusionError('一次最多承接500条草稿结果。'); raw.rows.forEach(rowInput); if (new Set(raw.rows.map((row: FusionRow) => row.id)).size !== raw.rows.length) throw new FusionError('草稿结果编号重复。'); break;
      case 'saveRecipe': text(raw.name, 60, '配方名称', false); if (typeof raw.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(raw.id) || raw.settingsHash !== undefined && typeof raw.settingsHash !== 'string') throw new FusionError('配方保存编号无效。'); break;
      case 'undo': parseOperationId(raw.operationId); break;
      case 'rename': text(raw.name, 60, '文档名称', false); if (raw.expected !== undefined) text(raw.expected, 60, '原文档名称'); break;
      case 'archive': if (typeof raw.archived !== 'boolean' || raw.expected !== undefined && typeof raw.expected !== 'boolean') throw new FusionError('归档状态无效。'); break;
      default: throw new FusionError('不支持的操作类型。');
    }
  }
  if (value.some(command => command.type === 'undo') && value.length !== 1) throw new FusionError('撤销须单独提交。');
  return value as FusionCommand[];
}
export function parseFusionOperationRequest(value: unknown): FusionOperationRequest {
  if (!isRecord(value) || !Number.isSafeInteger(value.baseVersion) || (value.baseVersion as number) < 1) throw new FusionError('操作组无效。');
  return { opId: parseOperationId(value.opId), baseVersion: value.baseVersion as number, commands: parseFusionCommands(value.commands) };
}
export const parseActionRequest = parseFusionOperationRequest;
function getPath(value: unknown, path: string[]): unknown { for (const key of path) value = isRecord(value) && own(value, key) ? value[key] : undefined; return value; }
function setPath(target: object, path: string[], value: unknown) {
  validPath(path); let current = target as Record<string, unknown>;
  for (const key of path.slice(0, -1)) { if (!isRecord(current[key])) current[key] = {}; current = current[key] as Record<string, unknown>; }
  if (value === undefined || value === null) delete current[path[path.length - 1]]; else current[path[path.length - 1]] = copy(value);
}
function leaves(value: Record<string, unknown>, path: string[] = []): Array<{ path: string[]; value: unknown }> {
  return Object.entries(value).flatMap(([key, item]) => { const next = [...path, key]; validPath(next); return isRecord(item) && Object.keys(item).length ? leaves(item, next) : [{ path: next, value: item }]; });
}
function conflict(path: string[], expected: unknown, current: unknown): never { throw new FusionError('相关内容已更新，请保留草稿并重新读取后应用。', 409, 'FUSION_CONFLICT', { path, expected, current }); }
function compare(stale: boolean, path: string[], current: unknown, hasExpected: boolean, expected: unknown) {
  if ((stale && !hasExpected) || (hasExpected && !sameFusionValue(current, expected))) conflict(path, expected, current);
}
export function fusionDocumentDelta(before: FusionDocument, after: FusionDocument): FusionUndo {
  const fields: FusionUndo['fields'] = [];
  const walk = (a: unknown, b: unknown, path: string[]) => { if (sameFusionValue(a, b)) return; if (isRecord(a) && isRecord(b)) { for (const key of Array.from(new Set([...Object.keys(a), ...Object.keys(b)]))) walk(a[key], b[key], [...path, key]); } else fields.push({ path, before: a ?? null, after: b ?? null }); };
  walk(before.state, after.state, ['state']); walk(before.name, after.name, ['name']); walk(before.archived, after.archived, ['archived']);
  const rows: FusionUndo['rows'] = [], a = new Map(before.rows.map((row, i) => [row.id, { row, i }])), b = new Map(after.rows.map((row, i) => [row.id, { row, i }]));
  for (const id of Array.from(new Set([...Array.from(a.keys()), ...Array.from(b.keys())]))) if (!sameFusionValue(a.get(id)?.row, b.get(id)?.row)) rows.push({ id, before: a.get(id)?.row || null, after: b.get(id)?.row || null, beforeIndex: a.get(id)?.i ?? -1, afterIndex: b.get(id)?.i ?? -1 });
  return { fields, rows };
}
function trustedRowSettings(settings: FusionSettings, original: FusionSettings, fresh: FusionCatalogue): FusionSettings {
  const dynamic = settings.catalogue?.dynamic;
  if (!dynamic) return settings;
  const historical = original.catalogue?.dynamic?.snapshot, ids = Object.keys(dynamic.selections);
  const categories = ids.map(id => historical?.categories.find(category => category.id === id) || fresh.categories.find(category => category.id === id));
  if (categories.some(category => !category)) throw new FusionError('单条设置包含失效或无权读取的类别。', 409, 'FUSION_CATALOGUE_CHANGED');
  const terms = ids.flatMap(id => (historical?.categories.some(category => category.id === id) ? historical.terms : fresh.terms).filter(term => term.categoryId === id));
  return parseFusionSettings({ ...settings, catalogue: { ...settings.catalogue, dynamic: { ...dynamic, snapshot: { version: historical?.version || fresh.version, categories, terms } } } });
}
/** Refresh only axes that will actually be redrawn, retaining the original candidate boundary. */
function refreshRowCandidates(settings: FusionSettings, original: FusionSettings, categoryIds: Set<string>, fresh: FusionCatalogue, groups: Record<string, string> = {}): FusionSettings {
  if (!categoryIds.size) return settings;
  const builtin = builtinCatalogue(), historical = original.catalogue?.dynamic?.snapshot;
  const categories = new Map(builtin.categories.map(category => [category.id, category]));
  const terms = new Map(builtin.terms.map(term => [term.id, term]));
  for (const category of historical?.categories || []) categories.set(category.id, category);
  for (const term of historical?.terms || []) terms.set(term.id, term);
  const catalogue = structuredClone(settings.catalogue || { details: {}, traits: {} });
  for (const id of Array.from(categoryIds)) {
    const category = fresh.categories.find(category => category.id === id);
    if (!category || !category.enabled) throw new FusionError('调整轴已停用或无权读取，原结果仍保留。', 409, 'FUSION_CATALOGUE_CHANGED');
    const oldTerms = (historical?.categories.some(value => value.id === id) ? historical.terms : settings.catalogue?.dynamic?.snapshot.categories.some(value => value.id === id) ? settings.catalogue.dynamic.snapshot.terms : builtin.terms).filter(term => term.categoryId === id);
    const priorState = original.catalogue?.dynamic?.selections[id] || settings.catalogue?.dynamic?.selections[id];
    const requested = catalogue.dynamic?.selections[id];
    const priorPool = oldTerms.filter(term => (priorState?.candidates === undefined || priorState.candidates.includes(term.id)) && (requested?.candidates === undefined || requested.candidates.includes(term.id)) && (groups[id] === undefined || term.data?.group === groups[id]));
    const active = priorPool.flatMap(term => { const current = fresh.terms.find(value => value.id === term.id && value.categoryId === id && value.enabled); return current ? [current] : []; });
    if (!active.length) throw new FusionError(`${category.nameZh}的原候选范围已没有有效词条，原结果仍保留。`, 409, 'FUSION_CATALOGUE_CHANGED');
    const activeIds = new Set(active.map(term => term.id));
    const state = catalogue.dynamic?.selections[id];
    if (state) {
      if ([...state.must, ...(state.locked ? state.values : [])].some(termId => !activeIds.has(termId))) throw new FusionError(`${category.nameZh}的固定或必出选择已失效，请保留原结果并调整选择。`, 409, 'FUSION_CATALOGUE_CHANGED');
      state.candidates = active.map(term => term.id);
    }
    categories.set(id, category);
    for (const [termId, term] of Array.from(terms.entries())) if (term.categoryId === id) terms.delete(termId);
    for (const term of oldTerms) terms.set(term.id, { ...term, enabled: false });
    for (const term of active) terms.set(term.id, term);
  }
  if (catalogue.dynamic) catalogue.dynamic.snapshot = { version: fresh.version, categories: Array.from(categories.values()).filter(category => Object.keys(catalogue.dynamic!.selections).includes(category.id)), terms: Array.from(terms.values()).filter(term => Object.keys(catalogue.dynamic!.selections).includes(term.categoryId)) };
  return { ...settings, catalogue: hydrateCatalogueSettings(catalogue, { version: fresh.version, categories: Array.from(categories.values()), terms: Array.from(terms.values()) }, settings) };
}
function rowAdjustmentAxes(settings: FusionSettings, baseline: FusionSettings, axis?: string, whole = false): Set<string> {
  if (axis) return new Set([axis.startsWith('dimension:') || !CONFIG.some(c => c.id === axis) ? axis : `dimension:${axis}`]);
  const ids = new Set<string>();
  for (const c of CONFIG) if (whole && !settings.bossLocks[c.id] || !sameFusionValue(settings.rules[c.id], baseline.rules[c.id]) || !sameFusionValue(settings.boss[c.id], baseline.boss[c.id]) || !sameFusionValue(settings.bossLocks[c.id], baseline.bossLocks[c.id]) || !sameFusionValue(settings.catalogue?.details[c.id], baseline.catalogue?.details[c.id])) ids.add(`dimension:${c.id}`);
  for (const [id, state] of Object.entries(settings.catalogue?.traits || {})) if (state.enabled && (whole && !state.locked || !sameFusionValue(state, baseline.catalogue?.traits[id]))) ids.add(id);
  for (const [id, state] of Object.entries(settings.catalogue?.dynamic?.selections || {})) if (state.enabled && (whole && !state.locked || !sameFusionValue(state, baseline.catalogue?.dynamic?.selections[id]))) ids.add(id);
  return ids;
}
/** Deterministic common executor; persistence supplies current rows/catalogue and an optional undo delta. */
export function applyFusionCommands(current: FusionDocument, request: FusionOperationRequest, catalogue: FusionCatalogue, undo?: FusionUndo): FusionDocument {
  const next = copy(current), stale = request.baseVersion !== current.version;
  if (request.baseVersion > current.version) throw new FusionError('基础版本尚不存在，请重新读取。', 409, 'FUSION_CONFLICT');
  const originalSettingsHash = settingsFingerprint(current.state.settings);
  let batchIndex = 0;
  for (const command of request.commands) {
    switch (command.type) {
      case 'patchSettings': {
        const changes: FusionFieldChange[] = [...(command.patch ? leaves(command.patch as Record<string, unknown>).map(change => ({ ...change, ...(getPath(command.expected, change.path) !== undefined ? { expected: getPath(command.expected, change.path) } : {}) })) : []), ...(command.changes || [])];
        for (const change of changes) { if (!own(defaults(), change.path[0])) throw new FusionError('不支持的设置字段。'); compare(stale, ['settings', ...change.path], getPath(next.state.settings, change.path), own(change, 'expected'), change.expected); setPath(next.state.settings, change.path, change.value); }
        if (next.state.settings.catalogue?.dynamic) {
          const dynamic = next.state.settings.catalogue.dynamic;
          const categoryIds = Object.keys(dynamic.selections || {});
          next.state.settings.catalogue = { ...next.state.settings.catalogue, dynamic: { formatVersion: 1, selections: dynamic.selections || {}, snapshot: { version: catalogue.version, categories: catalogue.categories.filter(category => categoryIds.includes(category.id)), terms: catalogue.terms.filter(term => categoryIds.includes(term.categoryId)) } } };
          next.state.settings.catalogue = hydrateCatalogueSettings(next.state.settings.catalogue, catalogue, next.state.settings);
        }
        const parsed = parseFusionSettings(next.state.settings);
        if (stale && (!sameFusionValue(parsed.boss, next.state.settings.boss) || !sameFusionValue(parsed.bossLocks, next.state.settings.bossLocks))) conflict(['settings', 'boss'], next.state.settings.boss, parsed.boss);
        next.state.settings = parsed; break;
      }
      case 'generate': {
        if (stale && command.settingsHash !== originalSettingsHash) conflict(['settings'], command.settingsHash, originalSettingsHash);
        if (stale && command.mode === 'replace' && !sameFusionValue(command.expectedRows, Object.fromEntries(current.rows.map(row => [row.id, row.version])))) conflict(['rows'], command.expectedRows, Object.fromEntries(current.rows.map(row => [row.id, row.version])));
        const settings = { ...next.state.settings, catalogue: hydrateCatalogueSettings(next.state.settings.catalogue || { details: {}, traits: {} }, catalogue, next.state.settings) };
        const generated = generateBatch(settings, command.seed).map((row, index) => ({ ...row, id: `fusion-${request.opId}-${batchIndex}-${index}`, version: 1 }));
        batchIndex++; next.state.settings = settings; next.rows = command.mode === 'append' ? [...next.rows, ...generated] : [...next.rows.filter(row => next.state.retainedIds.includes(row.id)), ...generated]; break;
      }
      case 'addCurrent': {
        if (stale) conflict(['settings'], request.baseVersion, current.version);
        const settings = { ...next.state.settings, catalogue: hydrateCatalogueSettings(next.state.settings.catalogue || { details: {}, traits: {} }, catalogue, next.state.settings) };
        const row = bossRow(settings, next.rows, command.seed); next.rows.push({ ...row, id: `fusion-${request.opId}-${batchIndex++}-current`, version: 1 }); break;
      }
      case 'patchRow': {
        const row = next.rows.find(row => row.id === command.rowId); if (!row) throw new FusionError('目标结果已不存在。', 409, 'FUSION_CONFLICT');
        compare(stale, ['rows', row.id], row.version, command.expectedVersion !== undefined, command.expectedVersion);
        const { requirements, ...patch } = command.patch;
        if (requirements && !row.design) throw new FusionError('旧结果没有可修改的要求快照。');
        const snapshotSettings = requirements && row.catalogueSnapshot?.settings ? { ...row.catalogueSnapshot.settings, requirements: requirements.zh, requirementsEn: requirements.en, requirementsEnabled: Boolean(requirements.zh || requirements.en) } : undefined;
        const changed = refreshRowSnapshot({ ...row, ...patch, ...(requirements && row.design ? { design: { ...row.design, requirements } } : {}) }, snapshotSettings);
        next.rows = next.rows.map(item => item.id === row.id ? { ...changed, version: row.version + 1 } : item); break;
      }
      case 'changeRow': case 'reviseRow': {
        const row = next.rows.find(row => row.id === command.rowId); if (!row) throw new FusionError('目标结果已不存在。', 409, 'FUSION_CONFLICT');
        compare(stale, ['rows', row.id], row.version, command.expectedVersion !== undefined, command.expectedVersion);
        const original = row.catalogueSnapshot?.settings || next.state.settings;
        let settings = command.type === 'reviseRow' && command.settings ? trustedRowSettings(parseFusionSettings(command.settings), original, catalogue) : command.type === 'changeRow' && !command.dimension ? structuredClone(original) : settingsForRow(original, row); let changed: FusionRow[];
        if (command.type === 'changeRow' && command.dimension) {
          const dimension = command.dimension;
          const details = { ...settings.catalogue?.details };
          if (original.catalogue?.details[dimension]) details[dimension] = original.catalogue.details[dimension];
          else delete details[dimension];
          settings = { ...settings, boss: { ...settings.boss, [dimension]: command.value! }, bossLocks: { ...settings.bossLocks, [dimension]: original.bossLocks[dimension] }, catalogue: { ...settings.catalogue!, details } };
          if (settings.catalogue?.dynamic?.selections[`dimension:${dimension}`] && original.catalogue?.dynamic?.selections[`dimension:${dimension}`]) settings.catalogue.dynamic.selections[`dimension:${dimension}`] = structuredClone(original.catalogue.dynamic.selections[`dimension:${dimension}`]);
        }
        if (command.type === 'changeRow') settings = refreshRowCandidates(settings, original, rowAdjustmentAxes(settings, settingsForRow(original, row), command.dimension, !command.dimension), catalogue, command.dimension ? { [`dimension:${command.dimension}`]: command.value! } : {});
        if (command.type === 'changeRow') changed = changeRow(settings, next.rows, row.id, command.dimension ? { dimension: command.dimension, value: command.value! } : undefined, command.seed);
        else {
          const axis = command.axis || '';
          const dimension = CONFIG.find(c => c.id === axis || `dimension:${c.id}` === axis)?.id;
          if (dimension) { settings = { ...settings, bossLocks: { ...settings.bossLocks, [dimension]: false }, catalogue: { ...settings.catalogue!, details: { ...settings.catalogue?.details, [dimension]: undefined } } }; const selection = settings.catalogue?.dynamic?.selections[`dimension:${dimension}`]; if (selection) selection.locked = false; }
          else if (settings.catalogue?.dynamic?.selections[axis]) { const selection = settings.catalogue.dynamic.selections[axis]; settings = { ...settings, catalogue: { ...settings.catalogue, dynamic: { ...settings.catalogue.dynamic, selections: { ...settings.catalogue.dynamic.selections, [axis]: { ...selection, locked: false } } } } }; }
          else if (settings.catalogue?.traits[axis]) settings = { ...settings, catalogue: { ...settings.catalogue, traits: { ...settings.catalogue.traits, [axis]: { ...settings.catalogue.traits[axis], locked: false } } } };
          else if (!command.settings) throw new FusionError('调整轴不存在。');
          settings = refreshRowCandidates(settings, original, rowAdjustmentAxes(settings, settingsForRow(original, row), command.axis), catalogue, dimension ? { [`dimension:${dimension}`]: settings.boss[dimension] } : {});
          changed = reviseRow(settings, next.rows, row.id, command.seed);
        }
        next.rows = changed.map(item => item.id === row.id ? { ...item, version: row.version + 1 } : next.rows.find(existing => existing.id === item.id)!); break;
      }
      case 'removeRows':
        for (const id of command.rowIds) { const row = next.rows.find(item => item.id === id); if (!row) throw new FusionError('目标结果已不存在。', 409, 'FUSION_CONFLICT'); compare(stale, ['rows', id], row.version, command.expectedVersions?.[id] !== undefined, command.expectedVersions?.[id]); }
        next.rows = next.rows.filter(row => !command.rowIds.includes(row.id)); break;
      case 'selection':
        for (const key of ['selectedIds', 'retainedIds'] as const) if (command[key] !== undefined) { compare(stale, [key], next.state[key], command.expected?.[key] !== undefined, command.expected?.[key]); next.state[key] = [...command[key]!]; } break;
      case 'context':
        for (const key of ['idea', 'summary', 'messages'] as const) if (command[key] !== undefined) { compare(stale, [key], next.state[key], command.expected?.[key] !== undefined, command.expected?.[key]); Object.assign(next.state, { [key]: copy(command[key]) }); } break;
      case 'importDraft':
        if (stale || next.rows.length || next.state.idea || next.state.summary || next.state.messages.length || !sameFusionValue(next.state.settings, defaults())) throw new FusionError('仅能显式承接到未编辑的空白文档。', 409, 'FUSION_CONFLICT');
        next.state = parseWorkspaceState(command.state); next.rows = command.rows.map(row => ({ ...copy(row), version: 1 })); break;
      case 'rename': compare(stale, ['name'], next.name, command.expected !== undefined, command.expected); next.name = command.name.trim(); break;
      case 'archive': compare(stale, ['archived'], next.archived, command.expected !== undefined, command.expected); next.archived = command.archived; break;
      case 'saveRecipe':
        if (stale && command.settingsHash !== originalSettingsHash) conflict(['settings'], command.settingsHash, originalSettingsHash);
        break;
      case 'undo':
        if (!undo) throw new FusionError('该操作不可撤销。', 409, 'FUSION_UNDO_CONFLICT');
        for (const field of undo.fields) { const actual = getPath(next, field.path); if (!sameFusionValue(actual, field.after)) conflict(field.path, field.after, actual); }
        for (const item of undo.rows) { const actual = next.rows.find(row => row.id === item.id) || null; if (!sameFusionValue(actual, item.after)) conflict(['rows', item.id], item.after, actual); }
        for (const field of undo.fields) setPath(next, field.path, field.before);
        for (const item of undo.rows) { next.rows = next.rows.filter(row => row.id !== item.id); if (item.before) next.rows.splice(Math.min(item.beforeIndex, next.rows.length), 0, { ...item.before, version: Math.max(item.before.version, item.after?.version || 0) + 1 }); } break;
    }
  }
  if (request.commands.some(command => ['generate', 'addCurrent', 'removeRows', 'importDraft', 'undo'].includes(command.type))) { const live = new Set(next.rows.map(row => row.id)); next.state.selectedIds = next.state.selectedIds.filter(id => live.has(id)); next.state.retainedIds = next.state.retainedIds.filter(id => live.has(id)); } next.version = current.version + 1;
  return next;
}
