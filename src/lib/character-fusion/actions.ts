import { CONFIG, COUNTS, defaults, newCreationSettings, parseSettings as parseRawSettings, generateBatch, allocateFusionBatch, changeRow, reviseRow, applyRowConfiguration, settingsForRow, bossRow, refreshRowSnapshot, type Dimension, type FusionSettings, type FusionRow } from './engine';
import type { FusionCatalogue } from './catalogue-model';
import { hydrateCatalogueSettings, builtinCatalogue } from './catalogue';
import type { FusionFieldChange, FusionGenerationPlan, FusionAllocation, FusionIntent, FusionSummaryMeta, FusionIdentity, FusionBatchReceipt, FusionEffects, FusionPreparation } from './domain';
import { configureFusionSettings, effectiveFusionSettings, applyFusionSettingChanges, fusionSettingsChanges, parseFusionConfiguration, type FusionConfiguration } from './configuration';
export type { FusionFieldChange, FusionGenerationPlan, FusionAllocation, FusionIntent, FusionSummaryMeta, FusionIdentity, FusionBatchReceipt, FusionEffects } from './domain';

export type FusionMessage = { role: 'user' | 'assistant'; content: string };
export type FusionWorkspaceState = { settings: FusionSettings; idea: string; summary: string; messages: FusionMessage[]; selectedIds: string[]; retainedIds: string[];
  formatVersion?: 2; intent?: FusionIntent; summaryMeta?: FusionSummaryMeta; identity?: FusionIdentity; preparation?: FusionPreparation };
export type FusionWorkspaceRow = FusionRow & { version: number };
export type FusionWorkspace = { id: string; name: string; version: number; state: FusionWorkspaceState; archived: boolean; updatedAt: string; rows: FusionWorkspaceRow[]; batches?: FusionBatchReceipt[] };
export type FusionCommand =
  | { type: 'patchSettings'; patch?: Partial<FusionSettings>; expected?: Partial<FusionSettings>; changes?: FusionFieldChange[] }
  | { type: 'configure'; configuration: FusionConfiguration; target?: { rowId: string; version: number } }
  | { type: 'prepare'; value: FusionPreparation | null; expected?: FusionPreparation | null }
  | { type: 'applyPreparedRow'; rowId: string; expectedVersion: number; seed: number }
  | { type: 'generate'; mode: 'append' | 'replace'; seed: number; settingsHash?: string; preparationHash?: string; expectedRows?: Record<string, number>; plan?: FusionGenerationPlan; allocation?: FusionAllocation }
  | { type: 'addCurrent'; seed: number }
  | { type: 'patchRow'; rowId: string; expectedVersion?: number; patch: { advanced?: boolean; translations?: FusionRow['translations']; requirements?: { zh: string; en: string } } }
  | { type: 'changeRow'; rowId: string; dimension?: Dimension; value?: string; seed: number; expectedVersion?: number }
  | { type: 'reviseRow'; rowId: string; axis?: string; settings?: FusionSettings; seed: number; expectedVersion?: number }
  | { type: 'removeRows'; rowIds: string[]; expectedVersions?: Record<string, number> }
  | { type: 'selection'; selectedIds?: string[]; retainedIds?: string[]; expected?: { selectedIds?: string[]; retainedIds?: string[] } }
  | { type: 'intent'; requirements: FusionIntent['requirements']; expected?: FusionIntent }
  | { type: 'context'; idea?: string; summary?: string; summaryMeta?: FusionSummaryMeta; messages?: FusionMessage[]; expected?: Partial<Pick<FusionWorkspaceState, 'idea' | 'summary' | 'summaryMeta' | 'messages'>> }
  | { type: 'importDraft'; state: FusionWorkspaceState; rows: FusionRow[] }
  | { type: 'saveRecipe'; id: string; name: string; settingsHash?: string; preparationHash?: string }
  | { type: 'undo'; operationId: string }
  | { type: 'rename'; name: string; expected?: string }
  | { type: 'archive'; archived: boolean; expected?: boolean };
export type FusionOperationRequest = { opId: string; baseVersion: number; commands: FusionCommand[] };
export type FusionOperation = { id: string; opId: string; workspaceId: string | null; status: 'planning' | 'committed' | 'rejected' | 'cancelled'; beforeVersion: number; afterVersion: number; resultIds: string[]; reversible: boolean; createdAt: string;
  effects?: FusionEffects; batch?: FusionBatchReceipt; reply?: string; undoneBy?: string; turn?: { user: string; assistant: string } };
export type FusionDocument = Pick<FusionWorkspace, 'name' | 'archived' | 'version' | 'state' | 'rows'> & { generationFacts?: Array<{ allocation: FusionAllocation; plan?: FusionGenerationPlan; rowIds: string[] }> };
export type FusionUndo = { fields: Array<{ path: string[]; before: unknown; after: unknown }>; rows: Array<{ id: string; before: FusionWorkspaceRow | null; after: FusionWorkspaceRow | null; beforeIndex: number; afterIndex: number }> };
export class FusionError extends Error {
  proposalError?: string;
  constructor(message: string, readonly status = 400, readonly code = 'FUSION_INVALID', readonly details?: unknown) { super(message); }
}
export function parseFusionSettings(value: unknown): FusionSettings {
  try { return parseRawSettings(value); } catch (error) {
    const failure = new FusionError(error instanceof Error ? error.message : '角色设置无效。');
    if (error instanceof Error && 'proposalError' in error && typeof error.proposalError === 'string') failure.proposalError = error.proposalError;
    throw failure;
  }
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
  return valueFingerprint(settings);
}
function valueFingerprint(value: unknown) {
  let hash = 2166136261;
  for (const character of stableStringify(value)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16);
}
export const preparationFingerprint = (plan?: FusionGenerationPlan) => valueFingerprint(plan || null);
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const settingField = (key: string) => key === 'generationMode' || own(defaults(), key);
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
function parseIntent(value: unknown): FusionIntent {
  if (!isRecord(value) || !Array.isArray(value.requirements) || value.requirements.length > 40) throw new FusionError('创作要求无效。');
  return { requirements: value.requirements.map(item => {
    if (!isRecord(item)) throw new FusionError('创作要求无效。');
    if (item.en !== undefined && (typeof item.en !== 'string' || item.en.length > 4000 || /[\u3400-\u9fff]/.test(item.en))) throw new FusionError('创作要求英文无效。');
    return { text: text(item.text, 2000, '创作要求', false).trim(), ...(item.en !== undefined ? { en: item.en.trim() } : {}), ...(item.sourceOpId !== undefined ? { sourceOpId: parseOperationId(item.sourceOpId) } : {}) };
  }) };
}
function parseSummaryMeta(value: unknown): FusionSummaryMeta {
  if (!isRecord(value) || value.formatVersion !== 1 || !Number.isSafeInteger(value.stateVersion) || (value.stateVersion as number) < 1 || value.legacy !== undefined && typeof value.legacy !== 'boolean') throw new FusionError('创作备忘来源无效。');
  return { formatVersion: 1, stateVersion: value.stateVersion as number, ...(value.throughOpId !== undefined ? { throughOpId: parseOperationId(value.throughOpId) } : {}), ...(value.legacy !== undefined ? { legacy: value.legacy as boolean } : {}) };
}
export function parseWorkspaceState(value: unknown): FusionWorkspaceState {
  if (!isRecord(value)) throw new FusionError('创作现场无效。');
  if (value.formatVersion !== undefined && value.formatVersion !== 2) throw new FusionError('此创作现场格式暂不支持，请保留草稿并刷新。');
  if (value.identity !== undefined && (!isRecord(value.identity) || !Number.isSafeInteger(value.identity.nextDisplayNo) || (value.identity.nextDisplayNo as number) < 1 || !Number.isSafeInteger(value.identity.nextBatchNo) || (value.identity.nextBatchNo as number) < 1)) throw new FusionError('创作编号状态无效。');
  return { settings: parseFusionSettings(value.settings), idea: text(value.idea, 12000, '原始想法'), summary: text(value.summary, 12000, '创作摘要'), messages: messages(value.messages), selectedIds: ids(value.selectedIds), retainedIds: ids(value.retainedIds),
    ...(value.formatVersion === 2 ? { formatVersion: 2 } : {}), ...(value.intent !== undefined ? { intent: parseIntent(value.intent) } : {}), ...(value.summaryMeta !== undefined ? { summaryMeta: parseSummaryMeta(value.summaryMeta) } : {}), ...(value.identity !== undefined ? { identity: copy(value.identity) as FusionIdentity } : {}), ...(value.preparation !== undefined ? { preparation: parseFusionPreparation(value.preparation) } : {}) };
}
export function emptyWorkspaceState(): FusionWorkspaceState { return { settings: defaults(), idea: '', summary: '', messages: [], selectedIds: [], retainedIds: [] }; }
/** New document entry points share definition preservation; neither imports old rows or chat. */
export function newCreationState(state: FusionWorkspaceState, mode: 'fresh' | 'inherit' = 'fresh', catalogue?: FusionCatalogue): FusionWorkspaceState {
  const original = parseWorkspaceState(state);
  return { ...emptyWorkspaceState(), settings: mode === 'inherit' ? effectiveFusionSettings(original.settings, original.preparation?.batch, catalogue) : newCreationSettings(original.settings),
    idea: mode === 'inherit' ? original.idea : '', formatVersion: 2, intent: mode === 'inherit' ? copy(original.intent || { requirements: [] }) : { requirements: [] },
    identity: { nextDisplayNo: 1, nextBatchNo: 1 } };
}
function rowInput(value: unknown): FusionRow {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length > 180 || !value.id || typeof value.name !== 'string' || !isRecord(value.category) || !isRecord(value.source) || !isRecord(value.concept) || !isRecord(value.mechanism) || !isRecord(value.personality) || !isRecord(value.detail) || typeof value.bridge !== 'string' || typeof value.advanced !== 'boolean') throw new FusionError('承接草稿的结果无效。');
  return value as FusionRow;
}
function validPath(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || !value.length || value.length > 8 || value.some(key => typeof key !== 'string' || !key || ['__proto__', 'prototype', 'constructor'].includes(key))) throw new FusionError('设置字段路径无效。');
}
export function parseFusionGenerationPlan(value: unknown): FusionGenerationPlan {
  if (!isRecord(value) || value.formatVersion !== 1 || !['document', 'batch'].includes(String(value.scope))
    || value.count !== undefined && !COUNTS.includes(value.count as number)
    || value.diversity !== undefined && !['prefer', 'strict'].includes(String(value.diversity))) throw new FusionError('本批创作计划无效。');
  if (value.overlay !== undefined) {
    if (!Array.isArray(value.overlay) || value.overlay.length > 200) throw new FusionError('本批要求无效。');
    for (const change of value.overlay) { if (!isRecord(change) || !own(change, 'value')) throw new FusionError('本批要求无效。'); validPath(change.path); }
  }
  if (value.onceMust !== undefined) {
    if (!isRecord(value.onceMust) || Object.keys(value.onceMust).length > 200) throw new FusionError('本批必出项无效。');
    for (const values of Object.values(value.onceMust)) ids(values, '本批必出项');
  }
  if (value.targetRowIds !== undefined) ids(value.targetRowIds, '本批作用对象');
  return copy(value) as FusionGenerationPlan;
}
export function parseFusionPreparation(value: unknown): FusionPreparation {
  if (!isRecord(value) || value.formatVersion !== 1 || value.row !== undefined && (!isRecord(value.row) || typeof value.row.rowId !== 'string' || !value.row.rowId || !Number.isSafeInteger(value.row.version) || Number(value.row.version) < 1 || !Array.isArray(value.row.changes) || value.row.changes.length > 200)) throw new FusionError('待应用条件无效，请重新配置；原结果保留。');
  if (isRecord(value.row)) for (const change of value.row.changes as unknown[]) { if (!isRecord(change) || !own(change, 'value')) throw new FusionError('单条待应用字段无效。'); validPath(change.path); if (!own(defaults(), change.path[0])) throw new FusionError('不支持的单条设置字段。'); }
  return { formatVersion: 1, ...(value.batch !== undefined ? { batch: parseFusionGenerationPlan(value.batch) } : {}), ...(value.row !== undefined ? { row: copy(value.row) as FusionPreparation['row'] } : {}) };
}
function parseAllocation(value: unknown): FusionAllocation {
  if (!isRecord(value) || value.formatVersion !== 1 || !Array.isArray(value.rows) || value.rows.length > 32) throw new FusionError('本次词条分配无效。');
  for (const row of value.rows) {
    if (!isRecord(row) || !isRecord(row.selections) || Object.keys(row.selections).length > 200) throw new FusionError('本次词条分配无效。');
    for (const values of Object.values(row.selections)) ids(values, '本次词条分配');
  }
  return copy(value) as FusionAllocation;
}
export function parseFusionCommands(value: unknown): FusionCommand[] {
  if (!Array.isArray(value) || !value.length || value.length > 30) throw new FusionError('一次操作须有1–30条命令。');
  for (const raw of value) {
    if (!isRecord(raw)) throw new FusionError('操作内容无效。');
    if (['generate', 'addCurrent', 'changeRow', 'reviseRow', 'applyPreparedRow'].includes(String(raw.type)) && !Number.isSafeInteger(raw.seed)) throw new FusionError('抽卡种子无效。');
    if (raw.expectedVersion !== undefined && (!Number.isSafeInteger(raw.expectedVersion) || (raw.expectedVersion as number) < 1)) throw new FusionError('结果版本无效。');
    switch (raw.type) {
      case 'configure':
        try { raw.configuration = parseFusionConfiguration(raw.configuration); } catch (error) { throw new FusionError(error instanceof Error ? error.message : '卡片配置无效。'); }
        if (raw.target !== undefined && (!isRecord(raw.target) || typeof raw.target.rowId !== 'string' || !raw.target.rowId || !Number.isSafeInteger(raw.target.version) || Number(raw.target.version) < 1)) throw new FusionError('单条配置目标无效。');
        break;
      case 'prepare':
        if (raw.value !== null) raw.value = parseFusionPreparation(raw.value);
        if (raw.expected !== undefined && raw.expected !== null) parseFusionPreparation(raw.expected);
        break;
      case 'applyPreparedRow':
        text(raw.rowId, 180, '目标方案', false); if (!Number.isSafeInteger(raw.expectedVersion) || Number(raw.expectedVersion) < 1) throw new FusionError('单条应用须绑定原版本。');
        break;
      case 'patchSettings':
        if (raw.patch !== undefined && !isRecord(raw.patch) || raw.expected !== undefined && !isRecord(raw.expected) || raw.changes !== undefined && (!Array.isArray(raw.changes) || raw.changes.length > 200) || !raw.patch && !raw.changes) throw new FusionError('局部设置无效。');
        for (const change of (raw.changes || []) as unknown[]) { if (!isRecord(change) || !own(change, 'value')) throw new FusionError('字段修改无效。'); validPath(change.path); }
        break;
      case 'generate':
        if (!['append', 'replace'].includes(String(raw.mode)) || raw.settingsHash !== undefined && typeof raw.settingsHash !== 'string' || raw.preparationHash !== undefined && typeof raw.preparationHash !== 'string') throw new FusionError('抽卡模式无效。');
        if (raw.expectedRows !== undefined && (!isRecord(raw.expectedRows) || Object.values(raw.expectedRows).some(version => !Number.isSafeInteger(version) || (version as number) < 1))) throw new FusionError('结果基础版本无效。');
        if (raw.plan !== undefined) parseFusionGenerationPlan(raw.plan); if (raw.allocation !== undefined) parseAllocation(raw.allocation); break;
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
        if (raw.idea !== undefined) text(raw.idea, 12000, '原始想法'); if (raw.summary !== undefined) text(raw.summary, 12000, '创作摘要'); if (raw.summaryMeta !== undefined) parseSummaryMeta(raw.summaryMeta); if (raw.messages !== undefined) messages(raw.messages); if (raw.expected !== undefined && !isRecord(raw.expected)) throw new FusionError('摘要旧值无效。'); break;
      case 'intent': parseIntent({ requirements: raw.requirements }); if (raw.expected !== undefined) parseIntent(raw.expected); break;
      case 'importDraft':
        parseWorkspaceState(raw.state); if (!Array.isArray(raw.rows) || raw.rows.length > 500) throw new FusionError('一次最多承接500条草稿结果。'); raw.rows.forEach(rowInput); if (new Set(raw.rows.map((row: FusionRow) => row.id)).size !== raw.rows.length) throw new FusionError('草稿结果编号重复。'); break;
      case 'saveRecipe': text(raw.name, 60, '配方名称', false); if (typeof raw.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(raw.id) || raw.settingsHash !== undefined && typeof raw.settingsHash !== 'string' || raw.preparationHash !== undefined && typeof raw.preparationHash !== 'string') throw new FusionError('配方保存编号无效。'); break;
      case 'undo': parseOperationId(raw.operationId); break;
      case 'rename': text(raw.name, 60, '文档名称', false); if (raw.expected !== undefined) text(raw.expected, 60, '原文档名称'); break;
      case 'archive': if (typeof raw.archived !== 'boolean' || raw.expected !== undefined && typeof raw.expected !== 'boolean') throw new FusionError('归档状态无效。'); break;
      default: throw new FusionError('不支持的操作类型。');
    }
  }
  if (value.some(command => command.type === 'undo') && (value.filter(command => command.type === 'undo').length !== 1 || value.some(command => !['undo', 'context'].includes(command.type) || command.type === 'context' && command.idea !== undefined))) throw new FusionError('撤销只能与本轮对话记录一起提交。');
  return value as FusionCommand[];
}
export function parseFusionOperationRequest(value: unknown): FusionOperationRequest {
  if (!isRecord(value) || !Number.isSafeInteger(value.baseVersion) || (value.baseVersion as number) < 1) throw new FusionError('操作组无效。');
  return { opId: parseOperationId(value.opId), baseVersion: value.baseVersion as number, commands: parseFusionCommands(value.commands) };
}
export const parseActionRequest = parseFusionOperationRequest;
function arrayIndex(value: unknown[], key: string) {
  const index = Number(key);
  if (!/^(0|[1-9]\d*)$/.test(key) || !Number.isSafeInteger(index) || index >= value.length || !own(value, key)) throw new FusionError('列表索引无效，请重新读取原卡片或规则。');
  return index;
}
function getPath(value: unknown, path: string[], staleIndexed = false): unknown {
  for (const key of path) {
    if (Array.isArray(value)) {
      if (staleIndexed) throw new FusionError('列表内容已更新，请重新读取后修改原卡片或规则。', 409, 'FUSION_CONFLICT', { path });
      value = value[arrayIndex(value, key)];
    } else value = isRecord(value) && own(value, key) ? value[key] : undefined;
  }
  return value;
}
function setPath(target: object, path: string[], value: unknown) {
  validPath(path); let current = target as Record<string, unknown>;
  for (const key of path.slice(0, -1)) {
    if (Array.isArray(current)) arrayIndex(current, key);
    if (!isRecord(current[key]) && !Array.isArray(current[key])) {
      if (Array.isArray(current)) throw new FusionError('该列表项不能继续按字段编辑，请重新读取。');
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  const key = path[path.length - 1];
  if (Array.isArray(current)) { arrayIndex(current, key); if (value === undefined || value === null) throw new FusionError('不能通过索引删除列表项，请使用原列表操作。'); }
  if (value === undefined || value === null) delete current[key]; else current[key] = copy(value);
}
function leaves(value: Record<string, unknown>, path: string[] = []): Array<{ path: string[]; value: unknown }> {
  return Object.entries(value).flatMap(([key, item]) => { const next = [...path, key]; validPath(next); return isRecord(item) && Object.keys(item).length ? leaves(item, next) : [{ path: next, value: item }]; });
}
function conflict(path: string[], expected: unknown, current: unknown): never { throw new FusionError('相关内容已更新，请保留草稿并重新读取后应用。', 409, 'FUSION_CONFLICT', { path, expected, current }); }
function compare(stale: boolean, path: string[], current: unknown, hasExpected: boolean, expected: unknown) {
  if ((stale && !hasExpected) || (hasExpected && !sameFusionValue(current, expected))) conflict(path, expected, current);
}
function settingsWithIntent(settings: FusionSettings, intent?: FusionIntent): FusionSettings {
  const extra = intent?.requirements.filter(item => !(settings.requirementsEnabled && settings.requirements.includes(item.text))) || [];
  if (!extra.length) return settings;
  const originalZh = settings.requirementsEnabled ? settings.requirements.trim() : '';
  const originalEn = settings.requirementsEnabled ? settings.requirementsEn.trim() : '';
  const requirements = [originalZh, ...extra.map(item => item.text)].filter(Boolean).join('\n');
  const requirementsEn = extra.some(item => !item.en && /[\u3400-\u9fff]/.test(item.text)) || originalZh && !originalEn
    ? '' : [originalEn, ...extra.map(item => item.en || item.text)].filter(Boolean).join('\n');
  if (requirements.length > 6000 || requirementsEn.length > 10000) throw new FusionError('明确创作要求与本批设置合并后过长，请精简后生成；原内容仍保留。');
  return { ...settings, requirements, requirementsEn, requirementsEnabled: true };
}
export function fusionDocumentDelta(before: FusionDocument, after: FusionDocument, consumedPreparation = false): FusionUndo {
  const fields: FusionUndo['fields'] = [];
  const walk = (a: unknown, b: unknown, path: string[]) => { if (sameFusionValue(a, b)) return; if (isRecord(a) && isRecord(b)) { for (const key of Array.from(new Set([...Object.keys(a), ...Object.keys(b)]))) walk(a[key], b[key], [...path, key]); } else fields.push({ path, before: a ?? null, after: b ?? null }); };
  for (const key of ['settings', 'idea', 'intent', 'selectedIds', 'retainedIds'] as const) walk(before.state[key], after.state[key], ['state', key]);
  if (!consumedPreparation) walk(before.state.preparation, after.state.preparation, ['state', 'preparation']);
  walk(before.name, after.name, ['name']); walk(before.archived, after.archived, ['archived']);
  const rows: FusionUndo['rows'] = [], a = new Map(before.rows.map((row, i) => [row.id, { row, i }])), b = new Map(after.rows.map((row, i) => [row.id, { row, i }]));
  const businessRow = (row?: FusionWorkspaceRow) => { if (!row) return row; const { displayNo: _displayNo, originBatchId: _originBatchId, ...business } = row; return business; };
  for (const id of Array.from(new Set([...Array.from(a.keys()), ...Array.from(b.keys())]))) if (!sameFusionValue(businessRow(a.get(id)?.row), businessRow(b.get(id)?.row))) rows.push({ id, before: a.get(id)?.row || null, after: b.get(id)?.row || null, beforeIndex: a.get(id)?.i ?? -1, afterIndex: b.get(id)?.i ?? -1 });
  return { fields, rows };
}
/** Bind definitions before parsing new category references; selection constraints remain intact. */
function bindFreshDynamicSnapshot(settings: FusionSettings, catalogue: FusionCatalogue) {
  const dynamic = settings.catalogue?.dynamic;
  if (!dynamic) return;
  const categoryIds = Object.keys(dynamic.selections || {});
  settings.catalogue = { ...settings.catalogue!, dynamic: { formatVersion: 1, selections: dynamic.selections || {}, snapshot: {
    version: catalogue.version, categories: catalogue.categories.filter(category => categoryIds.includes(category.id)), terms: catalogue.terms.filter(term => categoryIds.includes(term.categoryId)),
  } } };
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
export function applyFusionCommands(current: FusionDocument, request: FusionOperationRequest, catalogue: FusionCatalogue, undo?: FusionUndo, context: { recentSourceIds?: string[] } = {}): FusionDocument {
  const next = copy(current), stale = request.baseVersion !== current.version;
  delete next.generationFacts;
  if (request.baseVersion > current.version) throw new FusionError('基础版本尚不存在，请重新读取。', 409, 'FUSION_CONFLICT');
  const originalSettingsHash = settingsFingerprint(current.state.settings);
  let batchIndex = 0;
  for (const command of request.commands) {
    switch (command.type) {
      case 'configure': {
        if (stale) conflict(['preparation'], request.baseVersion, current.version);
        if (command.target) {
          const row = next.rows.find(row => row.id === command.target!.rowId);
          if (!row || row.version !== command.target.version) throw new FusionError('目标方案已更新，请重新选择；未应用调整。', 409, 'FUSION_CONFLICT');
          if (command.configuration.count !== undefined || command.configuration.strict !== undefined || command.configuration.generationMode !== undefined) throw new FusionError('当前只调整一条；数量、整批差异或生成方式请清除单条目标后配置。');
          const original = settingsForRow(row.catalogueSnapshot?.settings || next.state.settings, row), pending = next.state.preparation?.row;
          if (pending && (pending.rowId !== row.id || pending.version !== row.version)) throw new FusionError('已有单条草稿绑定其它目标或旧版本，请先清除目标。', 409, 'FUSION_CONFLICT');
          const visible = applyFusionSettingChanges(original, pending?.changes || [], catalogue), configured = configureFusionSettings(visible, command.configuration, catalogue, request.opId);
          next.state.preparation = { ...next.state.preparation, formatVersion: 1, row: { rowId: row.id, version: row.version, changes: fusionSettingsChanges(original, configured) } };
        } else if (command.configuration.scope === 'batch') {
          const configured = configureFusionSettings(effectiveFusionSettings(next.state.settings, next.state.preparation?.batch, catalogue), command.configuration, catalogue, request.opId);
          if (command.configuration.inlineCards?.length) {
            const cards = [...next.state.settings.cards];
            for (const card of configured.cards.filter(card => command.configuration.inlineCards!.some(draft => draft.cardId === card.id || draft.title === card.title))) {
              const index = cards.findIndex(existing => existing.id === card.id), previous = cards[index];
              const definition = { ...card, ...(previous || { joined: false, locked: false }), title: card.title, titleEn: card.titleEn, catalogueCategoryId: card.catalogueCategoryId,
                tags: card.tags.map(tag => ({ ...tag, status: previous?.tags.find(old => old.label === tag.label)?.status || 'default' as const })) };
              if (index < 0) cards.push(definition); else cards[index] = definition;
            }
            next.state.settings = parseFusionSettings({ ...next.state.settings, cards });
          }
          const overlay = fusionSettingsChanges(next.state.settings, configured);
          next.state.preparation = { ...next.state.preparation, formatVersion: 1, batch: { formatVersion: 1, scope: 'batch', overlay } };
        } else {
          const before = next.state.settings, configured = configureFusionSettings(before, command.configuration, catalogue, request.opId), changed = fusionSettingsChanges(before, configured);
          next.state.settings = configured;
          const preparation = next.state.preparation, batch = preparation?.batch;
          if (batch) {
            const overlaps = (a: string[], b: string[]) => a.slice(0, Math.min(a.length, b.length)).every((key, index) => key === b[index]);
            const overlay = batch.overlay?.filter(field => !changed.some(change => overlaps(field.path, change.path))) || [];
            next.state.preparation = overlay.length || preparation?.row ? { formatVersion: 1, ...(overlay.length ? { batch: { ...batch, overlay } } : {}), ...(preparation?.row ? { row: preparation.row } : {}) } : undefined;
          }
        }
        break;
      }
      case 'prepare':
        if (stale) conflict(['preparation'], request.baseVersion, current.version);
        compare(false, ['preparation'], next.state.preparation || null, own(command, 'expected'), command.expected);
        if (command.value?.batch) effectiveFusionSettings(next.state.settings, command.value.batch, catalogue);
        if (command.value?.row) {
          const draft = command.value.row, row = next.rows.find(row => row.id === draft.rowId);
          if (!row || row.version !== draft.version) throw new FusionError('单条草稿版本已变，未保存本次调整。', 409, 'FUSION_CONFLICT');
          applyFusionSettingChanges(settingsForRow(row.catalogueSnapshot?.settings || next.state.settings, row), draft.changes, catalogue);
        }
        next.state.preparation = command.value || undefined;
        break;
      case 'patchSettings': {
        const changes: FusionFieldChange[] = [...(command.patch ? leaves(command.patch as Record<string, unknown>).map(change => ({ ...change, ...(getPath(command.expected, change.path) !== undefined ? { expected: getPath(command.expected, change.path) } : {}) })) : []), ...(command.changes || [])];
        for (const change of changes) { if (!settingField(change.path[0])) throw new FusionError('不支持的设置字段。'); compare(stale, ['settings', ...change.path], getPath(next.state.settings, change.path, stale), own(change, 'expected'), change.expected); setPath(next.state.settings, change.path, change.value); }
        if (next.state.settings.catalogue?.dynamic) {
          bindFreshDynamicSnapshot(next.state.settings, catalogue);
          next.state.settings.catalogue = hydrateCatalogueSettings(next.state.settings.catalogue, catalogue, next.state.settings);
        }
        const parsed = parseFusionSettings(next.state.settings);
        if (stale && (!sameFusionValue(parsed.boss, next.state.settings.boss) || !sameFusionValue(parsed.bossLocks, next.state.settings.bossLocks))) conflict(['settings', 'boss'], next.state.settings.boss, parsed.boss);
        next.state.settings = parsed; break;
      }
      case 'generate': {
        if (stale && command.settingsHash !== originalSettingsHash) conflict(['settings'], command.settingsHash, originalSettingsHash);
        const prepared = next.state.preparation?.batch;
        if (prepared && (stale || command.preparationHash !== preparationFingerprint(prepared))) throw new FusionError('本批条件已更新，请确认当前可见卡片后再生成。', 409, 'FUSION_CONFLICT');
        if (prepared && command.plan && !sameFusionValue(command.plan, prepared)) throw new FusionError('生成计划与当前可见本批条件不一致，请重新读取。', 409, 'FUSION_CONFLICT');
        const plan = command.plan || prepared;
        const targetIds = plan?.targetRowIds;
        if (targetIds?.some(id => !next.rows.some(row => row.id === id))) throw new FusionError('本批作用对象已不存在，请保留输入并重新选择。', 409, 'FUSION_CONFLICT');
        const replacing = next.rows.filter(row => !targetIds || targetIds.includes(row.id));
        if (stale && command.mode === 'replace' && replacing.some(row => command.expectedRows?.[row.id] !== row.version)) conflict(['rows'], command.expectedRows, Object.fromEntries(replacing.map(row => [row.id, row.version])));
        const documentSettings = { ...next.state.settings, catalogue: hydrateCatalogueSettings(next.state.settings.catalogue || { details: {}, traits: {} }, catalogue, next.state.settings) };
        const batchSettings = copy(documentSettings);
        for (const change of plan?.overlay || []) {
          if (!settingField(change.path[0])) throw new FusionError('不支持的本批设置字段。');
          compare(stale, ['settings', ...change.path], getPath(batchSettings, change.path, stale), own(change, 'expected'), change.expected);
          setPath(batchSettings, change.path, change.value);
        }
        if (plan?.count !== undefined) batchSettings.count = plan.count;
        bindFreshDynamicSnapshot(batchSettings, catalogue);
        const parsed = settingsWithIntent(parseFusionSettings(batchSettings), next.state.intent);
        if (parsed.generationMode !== undefined && command.mode !== parsed.generationMode) throw new FusionError('生成方式与当前可见设置不一致，请重新核对后点击生成；原方案与输入保留。', 409, 'FUSION_CONFLICT');
        parsed.catalogue = hydrateCatalogueSettings(parsed.catalogue || { details: {}, traits: {} }, catalogue, parsed);
        const plannedAllocation = allocateFusionBatch(parsed, command.seed, { onceMust: plan?.onceMust, diversity: plan?.diversity || parsed.diversity, avoidSourceTermIds: context.recentSourceIds });
        const allocation = command.allocation ? { ...command.allocation, diversity: plannedAllocation.diversity } : plannedAllocation;
        const generated = generateBatch(parsed, command.seed, allocation).map((row, index) => ({ ...row, id: `fusion-${request.opId}-${batchIndex}-${index}`, version: 1 }));
        for (const [categoryId, values] of Object.entries(plan?.onceMust || {})) for (const value of values) {
          if (!generated.some(row => row.catalogueSnapshot?.selections[categoryId]?.some(id => id === value || row.catalogueSnapshot?.terms.some(term => term.id === id && (term.legacyValue || term.nameZh) === value)))) throw new FusionError('本批必出要求未能进入实际方案，整批未执行，原内容仍保留。');
        }
        const sourceIds = generated.flatMap(row => (row.catalogueSnapshot?.categories.filter(category => category.generationKind === 'source') || []).flatMap(category => row.catalogueSnapshot!.selections[category.id] || []));
        const repeated = generated.length - new Set(sourceIds).size;
        if ((plan?.diversity || parsed.diversity) === 'strict' && repeated > 0) throw new FusionError('当前分配无法满足母体绝不重复，整批未执行，请调整范围或数量。');
        if (allocation.diversity) allocation.diversity = { ...allocation.diversity, repeatedSourceCount: Math.max(0, repeated), relaxed: repeated > 0 || sourceIds.some(id => context.recentSourceIds?.includes(id)) };
        (next.generationFacts ||= []).push({ allocation, ...(plan ? { plan: copy(plan) } : {}), rowIds: generated.map(row => row.id) });
        batchIndex++; next.state.settings = documentSettings;
        if (prepared) next.state.preparation = next.state.preparation?.row ? { formatVersion: 1, row: next.state.preparation.row } : undefined;
        next.rows = command.mode === 'append' ? [...next.rows, ...generated] : [...next.rows.filter(row => next.state.retainedIds.includes(row.id) || targetIds && !targetIds.includes(row.id)), ...generated]; break;
      }
      case 'applyPreparedRow': {
        if (stale) conflict(['preparation', 'row'], request.baseVersion, current.version);
        const draft = next.state.preparation?.row, row = next.rows.find(row => row.id === command.rowId);
        if (!draft || !row || draft.rowId !== row.id || draft.version !== row.version || command.expectedVersion !== row.version) throw new FusionError('单条草稿或目标版本已变，请重新配置这条；原结果保留。', 409, 'FUSION_CONFLICT');
        if (!draft.changes.length) throw new FusionError('这条还没有待应用的调整，请先修改要求或卡片。');
        const original = row.catalogueSnapshot?.settings || next.state.settings;
        const baseline = settingsForRow(original, row), configured = applyFusionSettingChanges(baseline, draft.changes, catalogue);
        const settings = trustedRowSettings(configured, original, catalogue);
        const changed = applyRowConfiguration(row, baseline, settings, command.seed);
        next.rows = next.rows.map(item => item.id === row.id ? { ...changed, version: row.version + 1 } : item);
        next.state.preparation = next.state.preparation?.batch ? { formatVersion: 1, batch: next.state.preparation.batch } : undefined;
        break;
      }
      case 'addCurrent': {
        if (stale) conflict(['settings'], request.baseVersion, current.version);
        const settings = settingsWithIntent({ ...next.state.settings, catalogue: hydrateCatalogueSettings(next.state.settings.catalogue || { details: {}, traits: {} }, catalogue, next.state.settings) }, next.state.intent);
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
        if (command.type === 'changeRow' && !command.dimension && row.design) settings = { ...settings,
          requirements: row.design.requirements.zh, requirementsEn: row.design.requirements.en,
          requirementsEnabled: Boolean(row.design.requirements.zh || row.design.requirements.en) };
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
      case 'intent':
        compare(stale, ['intent'], next.state.intent || { requirements: [] }, command.expected !== undefined, command.expected);
        next.state.intent = parseIntent({ requirements: command.requirements }); next.state.formatVersion = 2; break;
      case 'context':
        for (const key of ['idea', 'summary', 'summaryMeta', 'messages'] as const) if (command[key] !== undefined) { compare(stale, [key], next.state[key], command.expected?.[key] !== undefined, command.expected?.[key]); Object.assign(next.state, { [key]: copy(command[key]) }); } break;
      case 'importDraft':
        if (stale || next.rows.length || next.state.idea || next.state.summary || next.state.messages.length || !sameFusionValue(next.state.settings, defaults())) throw new FusionError('仅能显式承接到未编辑的空白文档。', 409, 'FUSION_CONFLICT');
        next.state = { ...next.state, ...parseWorkspaceState(command.state) };
        next.rows = command.rows.map(row => { const { displayNo: _displayNo, originBatchId: _originBatchId, ...historical } = copy(row); return { ...historical, version: 1 }; }); break;
      case 'rename': compare(stale, ['name'], next.name, command.expected !== undefined, command.expected); next.name = command.name.trim(); break;
      case 'archive': compare(stale, ['archived'], next.archived, command.expected !== undefined, command.expected); next.archived = command.archived; break;
      case 'saveRecipe':
        if (stale && command.settingsHash !== originalSettingsHash) conflict(['settings'], command.settingsHash, originalSettingsHash);
        if (next.state.preparation?.batch && (stale || command.preparationHash !== preparationFingerprint(next.state.preparation.batch))) conflict(['preparation'], command.preparationHash, preparationFingerprint(next.state.preparation.batch));
        break;
      case 'undo':
        if (!undo) throw new FusionError('该操作不可撤销。', 409, 'FUSION_UNDO_CONFLICT');
        for (const field of undo.fields) { const actual = getPath(next, field.path); if (!sameFusionValue(actual, field.after)) conflict(field.path, field.after, actual); }
        for (const item of undo.rows) { const actual = next.rows.find(row => row.id === item.id) || null; if (!sameFusionValue(actual, item.after)) conflict(['rows', item.id], item.after, actual); }
        for (const field of undo.fields) setPath(next, field.path, field.before);
        for (const item of undo.rows) {
          const actual = next.rows.find(row => row.id === item.id);
          next.rows = next.rows.filter(row => row.id !== item.id);
          if (item.before) next.rows.splice(Math.min(item.beforeIndex, next.rows.length), 0, { ...item.before,
            ...(actual?.displayNo !== undefined ? { displayNo: actual.displayNo } : {}), ...(actual?.originBatchId !== undefined ? { originBatchId: actual.originBatchId } : {}),
            version: Math.max(item.before.version, item.after?.version || 0) + 1 });
        }
        if (next.state.summaryMeta) next.state.summaryMeta = { ...next.state.summaryMeta, legacy: true };
        break;
    }
  }
  if (request.commands.some(command => ['generate', 'addCurrent', 'removeRows', 'importDraft', 'undo'].includes(command.type))) { const live = new Set(next.rows.map(row => row.id)); next.state.selectedIds = next.state.selectedIds.filter(id => live.has(id)); next.state.retainedIds = next.state.retainedIds.filter(id => live.has(id)); } next.version = current.version + 1;
  return next;
}
