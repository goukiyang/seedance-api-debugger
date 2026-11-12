import { randomInt } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/api-helpers';
import { AuthError } from '@/lib/auth/session';
import { assertSupplementaryModelEnabled } from '@/lib/pricing/model-access.server';
import { createMuskChatCompletion, getMuskApiSettings, isMuskApiReady, resolveMuskChatModels, MuskApiError, type MuskChatDiagnostics } from '@/lib/integrations/musk';
import { assertCharacterFusionWritesEnabled } from '@/lib/character-fusion/build-mode';
import { FusionError, isRecord, parseOperationId, type FusionCommand } from '@/lib/character-fusion/actions';
import { readFusionCatalogue } from '@/lib/character-fusion/catalogue-repository';
import { executeWorkspaceOperation, getWorkspace, reserveAssistantOperation, finishAssistantOperation, cancelAssistantOperation, readAssistantOperationStatus, readWorkspaceHistory, listUndoableWorkspaceOperations } from '@/lib/character-fusion/workspace.server';
import { bindFusionAgentCommands, fusionAgentCataloguePage, readFusionAgentControls, validateFusionAgentExecution, FusionAgentError, proposeFusionAgent, type FusionAgentProposal, type FusionAgentTarget } from '@/lib/character-fusion/agent-adapter.server';
import { confirmFusionAgentContinuation, pageFusionAgentCatalogue, prepareFusionAgentContinuation, previewFusionAgentContinuation, queryFusionAgentContinuation } from '@/lib/character-fusion/agent-continuation.server';
import type { FusionCatalogue } from '@/lib/character-fusion/catalogue-model';
import type { FusionSettings } from '@/lib/character-fusion/engine';
import { effectiveFusionSettings, applyFusionSettingChanges } from '@/lib/character-fusion/configuration';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers });

export async function POST(request: NextRequest) {
  let intent: { user: Awaited<ReturnType<typeof getSessionUser>>; workspaceId: string; opId: string; fingerprint: string } | undefined;
  let proposed: FusionAgentProposal | undefined;
  let deferred = false;
  try {
    const user = await getSessionUser(request);
    if (user.status !== 'active') throw new AuthError('账号已被禁用。', 403);
    const raw = await request.text();
    if (raw.length > 100000) throw new FusionAgentError('本轮输入过长，请保留想法并分次继续。', 413);
    const body: unknown = JSON.parse(raw);
    if (!isRecord(body) || typeof body.workspaceId !== 'string' || !body.workspaceId || body.workspaceId.length > 180) throw new FusionAgentError('创作文档参数无效。');
    const workspaceId = body.workspaceId;
    if (body.action === 'history' || body.action === 'undoable') {
      if (body.limit !== undefined && (!Number.isSafeInteger(body.limit) || Number(body.limit) < 1 || Number(body.limit) > 30) || body.cursor !== undefined && (typeof body.cursor !== 'string' || body.cursor.length > 1024)) throw new FusionAgentError('历史分页参数无效。');
      return json(body.action === 'history' ? await readWorkspaceHistory(user, workspaceId, { cursor: body.cursor as string | undefined, limit: Number(body.limit) || 10 })
        : await listUndoableWorkspaceOperations(user, workspaceId, { limit: Number(body.limit) || 10 }));
    }
    const opId = parseOperationId(body.opId);
    if (body.action === 'catalogueStatus') return json(await queryFusionAgentContinuation(user, workspaceId, opId));
    if (body.action === 'cancel') return json(await cancelAssistantOperation(user, workspaceId, opId));
    if (body.action === 'previewCatalogue') return json(await previewFusionAgentContinuation(user, workspaceId, opId, body.entries));
    assertCharacterFusionWritesEnabled();
    if (body.action === 'confirmCatalogue') return json(await confirmFusionAgentContinuation(user, workspaceId, opId, { entries: body.entries, previewVersion: body.previewVersion }));
    if (body.action === 'saveInline') {
      if (typeof body.cardId !== 'string' || !Number.isSafeInteger(body.baseVersion) || Number(body.baseVersion) < 1) throw new FusionAgentError('请先保存当前卡片，再存入个人词库。');
      const prior = await queryFusionAgentContinuation(user, workspaceId, opId); if (prior.status !== 'unknown') return json(prior);
      const page = await getWorkspace(user, workspaceId, { limit: 20 }), current = page.workspace;
      if (current.version !== Number(body.baseVersion)) throw new FusionAgentError('当前卡片已更新，请保留输入并重新预览。', 409, 'fusion_agent_scene_changed');
      const catalogue = (await readFusionCatalogue(user)).catalogue;
      let sourceSettings = effectiveFusionSettings(current.state.settings, current.state.preparation?.batch, catalogue);
      if (typeof body.rowId === 'string') {
        const rowPage = await getWorkspace(user, workspaceId, { rowId: body.rowId, limit: 1 });
        if (!('rowSettings' in rowPage) || !rowPage.rowSettings || rowPage.workspace.version !== current.version) throw new FusionAgentError('这条的原卡片暂不可读，请保留输入后重试。', 409);
        const rowDraft = current.state.preparation?.row;
        sourceSettings = applyFusionSettingChanges(rowPage.rowSettings.settings, rowDraft?.rowId === body.rowId ? rowDraft.changes : [], catalogue);
      }
      const card = sourceSettings.cards.find(card => card.id === body.cardId);
      if (!card?.catalogueCategoryId || card.tags.some(tag => !tag.termId)) throw new FusionAgentError('这张卡片没有可复用的新词来源，请从卡片或词库的原导入入口保存。');
      const drafts: unknown[] = [];
      if (!catalogue.categories.some(category => category.id === card.catalogueCategoryId)) drafts.push({ kind: 'category', data: { id: card.catalogueCategoryId, nameZh: card.title, nameEn: card.titleEn, descriptionZh: card.title, descriptionEn: card.titleEn, group: 'extra', multi: Boolean(card.multi), generationKind: 'trait' } });
      for (const tag of card.tags) if (!catalogue.terms.some(term => term.id === tag.termId)) drafts.push({ kind: 'term', data: { id: tag.termId, categoryId: card.catalogueCategoryId, nameZh: tag.label, nameEn: tag.en, descriptionZh: tag.descriptionZh || tag.label, descriptionEn: tag.descriptionEn || tag.en } });
      if (!drafts.length) throw new FusionAgentError('这张卡片的词条已在个人词库，未重复入库；可从词库查看或编辑。');
      const message = `将本创作卡片${card.id}存入个人词库`;
      const reserved = await reserveAssistantOperation(user, workspaceId, { opId, baseVersion: current.version, message, model: 'inline-card' });
      if (reserved.status !== 'planning' || !reserved.claimed) return json(reserved);
      intent = { user, workspaceId, opId, fingerprint: reserved.intentFingerprint };
      const receipt = await prepareFusionAgentContinuation(user, current, { sourceOpId: opId, intentFingerprint: intent.fingerprint, drafts, commands: [], message, reply: '新词已备好，预览确认后仅存入个人词库；不会生成。', model: 'inline-card' });
      deferred = true; return json(receipt);
    }
    if (body.action !== undefined && body.action !== 'send') throw new FusionAgentError('未知的创作操作。');
    if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 4000
      || typeof body.model !== 'string' || !body.model || body.model.length > 80
      || !Number.isSafeInteger(body.baseVersion) || Number(body.baseVersion) < 1) throw new FusionAgentError('创作请求或所选模型无效，原输入已保留。');
    if (body.scopeChoice !== undefined && !['row', 'document'].includes(String(body.scopeChoice))) throw new FusionAgentError('作用范围选择无效。');
    let target: FusionAgentTarget | undefined, targetSettings: FusionSettings | undefined;
    if (body.target !== undefined) {
      if (!isRecord(body.target) || typeof body.target.rowId !== 'string' || !body.target.rowId || body.target.rowId.length > 180 || !Number.isSafeInteger(body.target.version) || Number(body.target.version) < 1) throw new FusionAgentError('单条目标无效，原输入已保留。');
      target = { rowId: body.target.rowId, version: Number(body.target.version) };
    }
    if (body.scopeChoice === 'row' && !target) throw new FusionAgentError('仅修改当前方案需要保留真实单条目标。');
    const reserved = await reserveAssistantOperation(user, workspaceId, { opId, baseVersion: Number(body.baseVersion), message: body.message.trim(), model: body.model,
      ...(target ? { target } : {}), ...(body.scopeChoice ? { scopeChoice: body.scopeChoice as 'row' | 'document' } : {}) });
    if (reserved.status !== 'planning' || !reserved.claimed) return json({ ...reserved, pending: reserved.status === 'planning' && !('continuation' in reserved && reserved.continuation),
      ...(!('reply' in reserved && reserved.reply) ? { reply: reserved.status === 'committed' ? '原操作已确认，请继续使用原结果。' : reserved.status === 'planning' ? '原回合仍在处理或等待确认，请按原编号核对。' : '原回合已结束，输入保留，可继续新的创作要求。' } : {}) });
    intent = { user, workspaceId, opId, fingerprint: reserved.intentFingerprint };
    const initial = await getWorkspace(user, workspaceId, { limit: 20 }), workspace = initial.workspace;
    if (workspace.version !== Number(body.baseVersion)) throw new FusionAgentError('创作现场在请求后已更新，原输入已保留，尚未应用提案。', 409, 'fusion_agent_scene_changed');
    if (body.scopeChoice === 'document') target = undefined;
    if (target) {
      const page = await getWorkspace(user, workspaceId, { rowId: target.rowId, limit: 1 });
      const row = page.workspace.rows.find(row => row.id === target!.rowId);
      if (page.workspace.version !== workspace.version || !row || row.version !== target.version) throw new FusionAgentError('目标方案版本已变，原输入已保留，请重新选择目标。', 409, 'fusion_agent_target_changed');
      workspace.rows = [...workspace.rows.filter(item => item.id !== row.id), row];
      if ('rowSettings' in page && page.rowSettings) targetSettings = page.rowSettings.settings;
    }
    const settings = await getMuskApiSettings();
    if (!isMuskApiReady(settings)) throw new FusionAgentError('当前 LLM 服务未启用或缺少配置，手动操作仍可继续。', 503, 'musk_api_not_configured');
    if (!(await resolveMuskChatModels(settings)).includes(body.model)) throw new FusionAgentError('所选模型已不在当前目录，请更新目录后重新选择；输入已保留。', 400, 'model_not_allowed');
    await assertSupplementaryModelEnabled('text', body.model);
    const selectedModel = body.model, started = Date.now();
    let modelStep = 0;
    let catalogueSnapshot: FusionCatalogue | undefined = (await readFusionCatalogue(user)).catalogue;
    const rowDraft = workspace.state.preparation?.row;
    const sceneSettings = targetSettings ? applyFusionSettingChanges(targetSettings, rowDraft && rowDraft.rowId === target?.rowId ? rowDraft.changes : [], catalogueSnapshot)
      : effectiveFusionSettings(workspace.state.settings, workspace.state.preparation?.batch, catalogueSnapshot);
    const sceneWorkspace = { ...workspace, state: { ...workspace.state, settings: sceneSettings } };
    const assertPlanning = async () => {
      request.signal.throwIfAborted();
      const current = await readAssistantOperationStatus(user, workspaceId, opId);
      if (current.status !== 'planning') throw new FusionAgentError('原回合已结束，未继续请求模型或应用新提案。', 409, 'fusion_agent_cancelled');
    };
    const binding = { target, message: body.message.trim(), sourceOpId: opId, contract: 'configure' as const };
    const executionSeed = randomInt(0, 2147480000);
    const result = await proposeFusionAgent({ workspace, rowsPage: initial.rowsPage, binding, sceneSettings, message: body.message.trim(), signal: request.signal, seed: executionSeed,
      validateCommands: async commands => {
        if (!commands.some(command => ['patchSettings', 'generate', 'intent', 'configure'].includes(command.type))) return;
        catalogueSnapshot ||= (await readFusionCatalogue(user)).catalogue;
        validateFusionAgentExecution(commands, workspace, catalogueSnapshot, body.message as string);
      },
      complete: async messages => {
        await assertPlanning();
        const latest = await getMuskApiSettings();
        if (!isMuskApiReady(latest) || !(await resolveMuskChatModels(latest)).includes(selectedModel)) throw new FusionAgentError('所选模型当前不可用，输入和已有结果已保留。', 503, 'model_not_allowed');
        await assertSupplementaryModelEnabled('text', selectedModel);
        await assertPlanning();
        const timeoutMs = Math.max(0, Math.min(90000, 240000 - (Date.now() - started))), step = ++modelStep;
        if (timeoutMs < 1000) {
          console.info('[character-fusion-planner-step]', JSON.stringify({ opId, step, phase: 'budget_exhausted', elapsedMs: 0, totalElapsedMs: Date.now() - started, timeoutMs, httpStatus: null }));
          throw new FusionAgentError('本轮模型请求已达时限，未提交的新提案已停止。', 504, 'fusion_agent_timeout');
        }
        const callStarted = Date.now();
        let diagnostics: MuskChatDiagnostics | undefined;
        try {
          const completion = await createMuskChatCompletion({ settings: latest, model: selectedModel, messages, temperature: .4, jsonMode: false, timeoutMs, signal: request.signal });
          diagnostics = completion.diagnostics;
          return completion.content;
        } catch (error) {
          if (error instanceof MuskApiError) diagnostics = error.diagnostics;
          throw error;
        } finally {
          console.info('[character-fusion-planner-step]', JSON.stringify({ opId, step, phase: diagnostics?.phase || 'request_failed', elapsedMs: diagnostics?.elapsedMs ?? Date.now() - callStarted,
            totalElapsedMs: Date.now() - started, timeoutMs, httpStatus: diagnostics?.httpStatus ?? null, headersMs: diagnostics?.headersMs ?? null, bodyMs: diagnostics?.bodyMs ?? null }));
        }
      },
      read: async read => {
        await assertPlanning();
        if (read.kind === 'controls' || read.kind === 'constraints') return readFusionAgentControls(sceneWorkspace, read);
        if (read.kind === 'operations') return listUndoableWorkspaceOperations(user, workspaceId, { limit: read.limit || 10 });
        if (read.kind === 'history' || read.kind === 'batches') {
          const history = await readWorkspaceHistory(user, workspaceId, { cursor: read.cursor, limit: read.kind === 'batches' ? 1 : read.limit || 1 });
          if (read.kind === 'history') return history;
          const receipts = history.operations.flatMap(operation => operation.batches || []);
          const batches = receipts.map(batch => ({ id: batch.id, number: batch.number, label: batch.label,
            rowIds: [] as string[], rowCount: batch.rowIds.length, rowIdsComplete: batch.rowIds.length === 0 }));
          const page = { batches, total: batches.length, totalScope: 'history-page', complete: !history.nextCursor, nextCursor: history.nextCursor,
            rowsReadHint: '完整行与版本按batchId读取results；后续页须继续携带同一batchId和nextCursor。' };
          let remaining = Math.max(0, 6000 - JSON.stringify(page).length);
          receipts.forEach((receipt, index) => {
            for (const rowId of receipt.rowIds.slice(0, 32)) {
              const cost = JSON.stringify(rowId).length + 1;
              if (cost > remaining) break;
              batches[index].rowIds.push(rowId); remaining -= cost;
            }
            batches[index].rowIdsComplete = batches[index].rowIds.length === batches[index].rowCount;
          });
          return page;
        }
        if (read.kind === 'results') {
          const page = await getWorkspace(user, workspaceId, { cursor: read.cursor, limit: read.limit || 20, rowId: read.rowId, batchId: read.batchId, displayNo: read.displayNo });
          if (page.workspace.version !== workspace.version) throw new FusionAgentError('创作现场已变，保留原输入和提案，尚未应用。', 409, 'fusion_agent_scene_changed');
          const rows = new Map(workspace.rows.map(row => [row.id, row]));
          for (const row of page.workspace.rows) rows.set(row.id, row);
          workspace.rows = Array.from(rows.values());
          return { results: page.workspace.rows.map(row => ({ id: row.id, displayNo: row.displayNo, originBatchId: row.originBatchId, name: row.name, version: row.version, category: row.category, traits: row.design?.traits, requirements: row.design?.requirements })), ...page.rowsPage };
        }
        catalogueSnapshot ||= (await readFusionCatalogue(user)).catalogue;
        if (read.kind !== 'catalogue') throw new FusionAgentError('未注册的读取请求。');
        return fusionAgentCataloguePage(pageFusionAgentCatalogue(catalogueSnapshot, read), read);
      },
    });
    proposed = result.proposal;
    await assertPlanning();
    const commands = result.limitReached ? [] : bindFusionAgentCommands(result.proposal.commands, workspace, executionSeed, { ...binding, undoableOperationIds: result.undoableOperationIds, undoableOperations: result.undoableOperations });
    const reply = result.limitReached ? '本轮已达到 6 次工具往返上限，未执行新创作操作；已有现场与查询结果已保留，可明确目标后继续。'
      : commands.length ? result.proposal.reply : `本轮仅提供建议或草稿，未执行抽卡或设置变更。${result.proposal.reply}`;
    const title: FusionCommand[] = !commands.some(command => command.type === 'undo') && !workspace.rows.length && !workspace.state.messages.some(message => message.role === 'user') && ['新的角色融合创作', '继续角色融合创作', '未命名创作'].includes(workspace.name)
      ? [{ type: 'rename', name: body.message.trim().replace(/\s+/g, ' ').slice(0, 40), expected: workspace.name }] : [];
    if (result.proposal.drafts.length && !result.limitReached) {
      const receipt = await prepareFusionAgentContinuation(user, workspace, { sourceOpId: opId, intentFingerprint: intent.fingerprint, drafts: result.proposal.drafts,
        commands: commands.length ? [...commands, ...title] : [], message: body.message.trim(), reply, model: selectedModel, target });
      deferred = true;
      return json({ ...receipt, reads: result.reads, iterations: result.iterations, model: selectedModel });
    }
    const receipt = await executeWorkspaceOperation(user, workspaceId, { opId, baseVersion: workspace.version, commands: [...commands, ...title, ...(!commands.length && !title.length ? [{ type: 'context' as const }] : [])] },
      { assistantFingerprint: intent.fingerprint, turn: { user: body.message.trim(), assistant: reply }, ...(catalogueSnapshot ? { catalogueVersion: catalogueSnapshot.version } : {}) });
    return json({ ...receipt, reply: receipt.reply || reply, drafts: [], scopeChoices: result.proposal.scopeChoices, reads: result.reads, iterations: result.iterations, limitReached: result.limitReached, model: selectedModel });
  } catch (error) {
    const failureMessage = error instanceof FusionAgentError && error.userMessage || (error instanceof Error ? error.message : '本轮提案未完成。');
    if (intent && !deferred && !request.signal.aborted) {
      try {
        const terminal = await finishAssistantOperation(intent.user, intent.workspaceId, intent.opId, { intentFingerprint: intent.fingerprint, status: 'rejected', message: failureMessage, proposal: proposed });
        if (terminal.status !== 'planning' && terminal.status !== 'unknown') return json({ ...terminal, pending: false, submitted: terminal.status === 'committed' });
      }
      catch { /* The original receipt remains the only recovery route. */ }
    }
    if (error instanceof AuthError || error instanceof FusionError || error instanceof FusionAgentError || error instanceof MuskApiError) return json({ error: failureMessage, code: 'code' in error ? error.code : undefined, details: { conflict: 'details' in error ? error.details : undefined, ...(proposed ? { proposal: proposed } : {}) }, submitted: false }, error.status);
    if (error instanceof SyntaxError) return json({ error: '请求不是有效 JSON，输入已保留。', submitted: false }, 400);
    const known = error as { status?: number; code?: string } | null;
    return json({ error: request.signal.aborted ? '等待已中断，请核对原操作编号。' : '本轮回复未确认，请核对原操作编号；当前输入与结果已保留。', code: known?.code, pending: true }, known?.status || 503);
  }
}
