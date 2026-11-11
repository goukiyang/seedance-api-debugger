import { randomUUID } from 'node:crypto';
import { FusionError, isRecord, parseFusionCommands, parseOperationId, type FusionCommand, type FusionWorkspace } from './actions';
import { manageFusionCatalogue, queryCatalogueOperation, readFusionCatalogue, type CatalogueEntry, type FusionActor } from './catalogue-repository';
import { completeAssistantPlan, executeWorkspaceOperation, getWorkspace, queryWorkspaceOperation, readAssistantPlan, saveAssistantPlan } from './workspace.server';
import { FusionAgentError, type FusionAgentTarget } from './agent-adapter.server';
import { isExtensionId, type FusionCatalogue } from './catalogue-model';

/** Both existing transactions keep their own durable ID and share one original plan. */
export type FusionAgentContinuation = {
  formatVersion: 1; planId: string; workspaceId: string; baseVersion: number;
  sourceOpId: string; catalogueOpId: string; workspaceOpId: string; mode: 'save' | 'generate';
  entries: CatalogueEntry[]; commands: FusionCommand[]; message: string; reply: string; model: string;
  target?: FusionAgentTarget; previewVersion?: string; generationAttempted?: boolean;
};
export function parseFusionAgentContinuation(value: unknown): FusionAgentContinuation {
  if (!isRecord(value) || value.formatVersion !== 1 || typeof value.planId !== 'string' || typeof value.workspaceId !== 'string'
    || !Number.isSafeInteger(value.baseVersion) || Number(value.baseVersion) < 1 || !['save', 'generate'].includes(String(value.mode))
    || !Array.isArray(value.entries) || !value.entries.length || value.entries.length > 20 || !Array.isArray(value.commands)
    || typeof value.message !== 'string' || typeof value.reply !== 'string' || typeof value.model !== 'string') throw new FusionAgentError('原扩库计划不完整，请保留草稿并核对原回执。', 409, 'fusion_agent_plan_invalid');
  for (const key of ['sourceOpId', 'catalogueOpId', 'workspaceOpId'] as const) parseOperationId(value[key]);
  if (value.commands.length) parseFusionCommands(value.commands);
  return value as FusionAgentContinuation;
}
export async function prepareFusionAgentContinuation(actor: FusionActor, workspace: FusionWorkspace, input: {
  sourceOpId: string; intentFingerprint: string; drafts: unknown[]; commands: FusionCommand[]; message: string; reply: string; model: string; target?: FusionAgentTarget;
}) {
  const entries = input.drafts.map(draft => {
    if (!isRecord(draft) || !['category', 'term'].includes(String(draft.kind)) || !isRecord(draft.data)) throw new FusionAgentError('新词草稿格式无效，尚未入库。');
    if (input.commands.length && (typeof draft.data.id !== 'string' || !isExtensionId(draft.data.id))) throw new FusionAgentError('接续原计划的新类别和新词必须带稳定UUID，尚未入库。');
    return { kind: draft.kind, data: { ...draft.data, id: draft.data.id || randomUUID() } } as CatalogueEntry;
  });
  const preview = await manageFusionCatalogue(actor, { action: 'preview', scope: 'private', entries });
  const continuation: FusionAgentContinuation = { formatVersion: 1, planId: randomUUID(), workspaceId: workspace.id, baseVersion: workspace.version,
    sourceOpId: input.sourceOpId, catalogueOpId: randomUUID(), workspaceOpId: randomUUID(), mode: input.commands.some(command => command.type === 'generate') ? 'generate' : 'save',
    entries, commands: input.commands, message: input.message, reply: input.commands.some(command => command.type === 'generate') ? '草稿已备好，确认入库后按原计划继续生成；尚未入库或生成。' : '草稿已备好，等待明确确认入库；尚未生成。', model: input.model,
    ...(input.target ? { target: input.target } : {}), ...(preview.preview ? { previewVersion: preview.preview.version } : {}) };
  const receipt = await saveAssistantPlan(actor, workspace.id, input.sourceOpId, { intentFingerprint: input.intentFingerprint, plan: continuation });
  return { ...receipt, continuation, drafts: entries, ...preview, pending: false,
    reply: continuation.mode === 'generate' ? '草稿已备好，确认入库后会沿本次计划继续生成；当前尚未入库或生成。' : '草稿已备好，确认后仅按原要求入库，不会自动生成。' };
}
function rebindCataloguePlan(plan: FusionAgentContinuation, entries: CatalogueEntry[], workspace: FusionWorkspace): FusionCommand[] {
  const moves = new Map<string, { from: string; to: string }>();
  for (const original of plan.entries) if (original.kind === 'term') {
    const edited = entries.find(entry => entry.kind === 'term' && entry.data.id === original.data.id);
    if (edited && edited.data.categoryId !== original.data.categoryId) moves.set(original.data.id!, { from: original.data.categoryId!, to: edited.data.categoryId! });
  }
  if (!moves.size) return plan.commands;
  const valueAt = (path: string[]) => {
    let value: unknown = workspace.state.settings;
    for (const key of path) value = isRecord(value) && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
    return value ?? null;
  };
  const rebindChanges = (changes: Array<{ path: string[]; value: unknown; expected?: unknown }>) => {
    const destinations = new Map<string, Set<string>>();
    for (const change of changes) {
      if (change.path[0] !== 'catalogue' || change.path[1] !== 'dynamic' || change.path[2] !== 'selections') continue;
      const categoryId = change.path[3];
      const lists = change.path.length === 4 && isRecord(change.value) ? ['values', 'must', 'candidates', 'excluded'].map(key => (change.value as Record<string, unknown>)[key]) : [change.value];
      for (const list of lists) if (Array.isArray(list)) for (const id of list) if (typeof id === 'string') {
        const destination = moves.get(id)?.to || categoryId;
        const set = destinations.get(categoryId) || new Set<string>(); set.add(destination); destinations.set(categoryId, set);
      }
    }
    return changes.map(change => {
      const path = change.path;
      if (path[0] !== 'catalogue' || path[1] !== 'dynamic' || path[2] !== 'selections') return change;
      const targets = destinations.get(path[3]);
      if (!targets || !Array.from(moves.values()).some(move => move.from === path[3])) return change;
      if (targets.size !== 1) throw new FusionAgentError('该类别混合了移类与保留词条，无法明确接续原计划；草稿已保留，尚未入库或生成。', 409, 'fusion_agent_plan_changed');
      const destination = Array.from(targets)[0], nextPath = [...path]; nextPath[3] = destination;
      return { ...change, path: nextPath, expected: valueAt(nextPath) };
    });
  };
  return plan.commands.map(command => {
    if (command.type === 'patchSettings') return { ...command, changes: rebindChanges(command.changes || []) };
    if (command.type !== 'generate' || !command.plan) return command;
    const onceMust: Record<string, string[]> = {};
    for (const [categoryId, ids] of Object.entries(command.plan.onceMust || {})) for (const id of ids) {
      const destination = moves.get(id)?.to || categoryId;
      onceMust[destination] = Array.from(new Set([...(onceMust[destination] || []), id]));
    }
    return { ...command, plan: { ...command.plan, ...(command.plan.overlay ? { overlay: rebindChanges(command.plan.overlay) } : {}), ...(command.plan.onceMust ? { onceMust } : {}) } };
  });
}

async function originalPlan(actor: FusionActor, workspaceId: string, sourceOpId: string) {
  const original = await readAssistantPlan(actor, workspaceId, sourceOpId), continuation = parseFusionAgentContinuation(original.continuation);
  if (continuation.workspaceId !== workspaceId || continuation.sourceOpId !== sourceOpId) throw new FusionAgentError('原计划与当前文档不匹配。', 409);
  return { ...original, continuation };
}
export async function previewFusionAgentContinuation(actor: FusionActor, workspaceId: string, sourceOpId: string, entries?: unknown) {
  const original = await originalPlan(actor, workspaceId, sourceOpId);
  if (original.status !== 'planning') throw new FusionAgentError('本回合已结束，请查询原入库回执。', 409);
  if ((await queryCatalogueOperation(actor, original.continuation.catalogueOpId)).status === 'committed') throw new FusionAgentError('本计划已经入库，请继续查询原计划，不能覆盖原入库内容。', 409);
  return manageFusionCatalogue(actor, { action: 'preview', scope: 'private', entries: entries ?? original.continuation.entries });
}
/** Never invoke a model, choose a new seed or ID, or regenerate the original plan here. */
export async function confirmFusionAgentContinuation(actor: FusionActor, workspaceId: string, sourceOpId: string, input: { entries?: unknown; previewVersion?: unknown }) {
  const original = await originalPlan(actor, workspaceId, sourceOpId);
  let plan = original.continuation;
  const imported = await queryCatalogueOperation(actor, plan.catalogueOpId);
  if (original.status === 'cancelled' || original.status === 'rejected') throw new FusionAgentError('原回合已结束，保留草稿，未继续入库或生成。', 409);
  let catalogue: FusionCatalogue;
  if (imported.status === 'committed') {
    // Once imported, only the import transaction's immutable plan may continue.
    plan = parseFusionAgentContinuation(imported.continuation);
    if (plan.workspaceId !== workspaceId || plan.sourceOpId !== sourceOpId) throw new FusionAgentError('已入库回执的原计划不匹配。', 409);
    catalogue = (await readFusionCatalogue(actor)).catalogue;
  } else {
    const current = await getWorkspace(actor, workspaceId, { limit: 1 });
    if (current.workspace.version !== plan.baseVersion) return { ...current, continuation: plan, catalogueStatus: 'not_committed', generationStatus: 'blocked', reply: '创作条件或目标版本已变，本次未入库或生成；原草稿与计划已保留。' };
    if (input.entries !== undefined) {
      if (!Array.isArray(input.entries) || !input.entries.length || input.entries.length > 20) throw new FusionAgentError('可编辑草稿须为1–20条。');
      const identities = (entries: unknown[]) => entries.map(entry => isRecord(entry) && isRecord(entry.data) ? `${entry.kind}:${entry.data.id}` : '').sort().join('|');
      if (identities(input.entries) !== identities(plan.entries)) throw new FusionAgentError('草稿稳定编号已改变，原生成计划停止；请保留草稿。', 409, 'fusion_agent_plan_changed');
      plan = { ...plan, entries: input.entries as CatalogueEntry[], commands: rebindCataloguePlan(plan, input.entries as CatalogueEntry[], current.workspace) };
    }
    if (typeof input.previewVersion !== 'string') throw new FusionAgentError('请先预览当前编辑稿，再明确确认入库。');
    plan = { ...plan, previewVersion: input.previewVersion };
    await saveAssistantPlan(actor, workspaceId, sourceOpId, { intentFingerprint: original.intentFingerprint, plan });
    const result = await manageFusionCatalogue(actor, { action: 'import', scope: 'private', entries: plan.entries, opId: plan.catalogueOpId, previewVersion: input.previewVersion, continuation: plan });
    if (!('catalogue' in result)) throw new FusionAgentError('入库回执缺少目录，需核对原操作。', 503);
    catalogue = result.catalogue;
    plan = parseFusionAgentContinuation(result.continuation);
  }
  if (!plan.commands.length) {
    const receipt = await completeAssistantPlan(actor, workspaceId, sourceOpId, { catalogueOpId: plan.catalogueOpId, generationStatus: 'saved', reply: '词条已入本人词库；本次只保存，未生成。' });
    return { ...receipt, catalogue, continuation: plan, catalogueStatus: 'committed', generationStatus: 'not_requested', reply: '词条已入本人词库；本次只保存，未生成。' };
  }
  const prior = await queryWorkspaceOperation(actor, workspaceId, plan.workspaceOpId);
  if (prior.status === 'committed') {
    return { ...prior, catalogue, continuation: plan, catalogueStatus: 'committed', generationStatus: plan.mode === 'generate' ? 'committed' : 'not_requested' };
  }
  if (prior.status !== 'unknown') return { ...prior, catalogue, continuation: plan, catalogueStatus: 'committed', generationStatus: 'unknown', reply: '词条已入库，后续操作仍需核对原编号；没有重新生成。' };
  const current = await getWorkspace(actor, workspaceId, { limit: 1 });
  if (current.workspace.version !== plan.baseVersion) return { ...current, catalogue, continuation: plan, catalogueStatus: 'committed', generationStatus: 'blocked', reply: '词条已入库；创作条件或目标版本已变，原生成计划已保留，本次未生成。' };
  if (original.continuation.generationAttempted) return { ...current, catalogue, continuation: original.continuation, catalogueStatus: 'committed', generationStatus: 'unknown', reply: '词条已入库，原生成操作尚未确认；请核对结果，没有重新提交。' };
  plan = { ...plan, generationAttempted: true };
  await saveAssistantPlan(actor, workspaceId, sourceOpId, { intentFingerprint: original.intentFingerprint, plan });
  try {
    const receipt = await executeWorkspaceOperation(actor, workspaceId, { opId: plan.workspaceOpId, baseVersion: plan.baseVersion, commands: plan.commands }, { turn: { user: plan.message, assistant: plan.reply }, continuationSource: { opId: sourceOpId, planId: plan.planId } });
    return { ...receipt, catalogue, continuation: plan, catalogueStatus: 'committed', generationStatus: plan.mode === 'generate' ? 'committed' : 'not_requested' };
  } catch (error) {
    if (!(error instanceof FusionError)) throw error;
    await completeAssistantPlan(actor, workspaceId, sourceOpId, { catalogueOpId: plan.catalogueOpId, workspaceOpId: plan.workspaceOpId, generationStatus: 'rejected', reply: error.message });
    return { ...current, catalogue, continuation: plan, catalogueStatus: 'committed', generationStatus: 'blocked', reply: `词条已入库，后续操作未完成：${error.message} 原计划已保留。` };
  }
}
/** Refresh only reads the original two receipts; it never resumes a write. */
export async function queryFusionAgentContinuation(actor: FusionActor, workspaceId: string, sourceOpId: string) {
  const original = await originalPlan(actor, workspaceId, sourceOpId), plan = original.continuation;
  const imported = await queryCatalogueOperation(actor, plan.catalogueOpId);
  if (imported.status !== 'committed') return { ...original, drafts: plan.entries, pending: false, catalogueStatus: 'unknown', generationStatus: 'not_requested' };
  if (!plan.commands.length) return { ...original, pending: false, catalogueStatus: 'committed', generationStatus: 'not_requested', reply: '词条已入库；本次只保存，未生成。' };
  const generated = await queryWorkspaceOperation(actor, workspaceId, plan.workspaceOpId);
  if (generated.status === 'committed') return { ...generated, continuation: plan, pending: false, catalogueStatus: 'committed', generationStatus: plan.mode === 'generate' ? 'committed' : 'not_requested' };
  const current = await getWorkspace(actor, workspaceId, { limit: 1 });
  const canContinue = original.status === 'planning' && generated.status === 'unknown' && !plan.generationAttempted && current.workspace.version === plan.baseVersion;
  return { ...original, pending: false, catalogueStatus: 'committed', generationStatus: plan.generationAttempted ? 'unknown' : 'blocked', canContinue,
    reply: plan.generationAttempted ? '词条已入库；原生成操作尚未确认，正在核对原编号，没有重新提交。' : canContinue ? '词条已入库，可明确继续同一原计划；尚未生成。' : '词条已入库；条件或目标已变，原计划已保留，尚未生成。' };
}

/** One authenticated snapshot per proposal; execution still validates the fresh catalogue. */
export function pageFusionAgentCatalogue(catalogue: FusionCatalogue, query: { categoryId?: string; q?: string; cursor?: string; limit?: number }) {
  const q = (query.q || '').trim().toLocaleLowerCase(), limit = query.limit || 20, signature = JSON.stringify({ categoryId: query.categoryId || '', q });
  let offset = 0;
  if (query.cursor) {
    let cursor: { version: string; signature: string; offset: number };
    try { cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')); } catch { throw new FusionAgentError('目录分页位置无效。'); }
    if (cursor.version !== catalogue.version || cursor.signature !== signature || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new FusionAgentError('目录分页与本轮快照不匹配，请重新检索。', 409);
    offset = cursor.offset;
  }
  const categoryMatches = new Set(catalogue.categories.filter(category => category.enabled && q && [category.nameZh, category.nameEn, ...category.aliases, ...category.tags].some(value => value.toLocaleLowerCase().includes(q))).map(category => category.id));
  const active = new Set(catalogue.categories.filter(category => category.enabled).map(category => category.id));
  const matches = catalogue.terms.filter(term => term.enabled && active.has(term.categoryId) && (!query.categoryId || term.categoryId === query.categoryId)
    && (!q || categoryMatches.has(term.categoryId) || [term.nameZh, term.nameEn, term.descriptionZh, term.descriptionEn, ...term.aliases, ...term.tags].some(value => value.toLocaleLowerCase().includes(q))));
  const terms = matches.slice(offset, offset + limit), visible = new Set(terms.map(term => term.categoryId));
  const categories = catalogue.categories.filter(category => category.enabled && (query.categoryId ? category.id === query.categoryId : visible.has(category.id) || categoryMatches.has(category.id))).slice(0, 30);
  return { catalogue: { ...catalogue, categories, terms }, total: matches.length,
    nextCursor: offset + limit < matches.length ? Buffer.from(JSON.stringify({ version: catalogue.version, signature, offset: offset + limit })).toString('base64url') : null };
}
