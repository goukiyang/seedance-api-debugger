import { randomInt } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/api-helpers';
import { AuthError } from '@/lib/auth/session';
import { assertSupplementaryModelEnabled } from '@/lib/pricing/model-access.server';
import { createMuskChatCompletion, getMuskApiSettings, isMuskApiReady, resolveMuskChatModels, MuskApiError } from '@/lib/integrations/musk';
import { assertCharacterFusionWritesEnabled } from '@/lib/character-fusion/build-mode';
import { FusionError, parseOperationId, type FusionCommand } from '@/lib/character-fusion/actions';
import { readFusionCatalogue } from '@/lib/character-fusion/catalogue-repository';
import { executeWorkspaceOperation, getWorkspace, reserveAssistantOperation, finishAssistantOperation, cancelAssistantOperation } from '@/lib/character-fusion/workspace.server';
import { bindFusionAgentCommands, FusionAgentError, proposeFusionAgent, type FusionAgentProposal } from '@/lib/character-fusion/agent-adapter.server';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers });

export async function POST(request: NextRequest) {
  let intent: { user: Awaited<ReturnType<typeof getSessionUser>>; workspaceId: string; opId: string; fingerprint: string } | undefined;
  let proposed: FusionAgentProposal | undefined;
  try {
    const user = await getSessionUser(request);
    if (user.status !== 'active') throw new AuthError('账号已被禁用。', 403);
    const raw = await request.text();
    if (raw.length > 16000) throw new FusionAgentError('本轮输入过长，请保留想法并分次继续。', 413);
    const body = JSON.parse(raw) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.workspaceId !== 'string' || body.workspaceId.length > 180) throw new FusionAgentError('创作文档参数无效。');
    const opId = parseOperationId(body.opId), workspaceId = body.workspaceId;
    if (body.action === 'cancel') return json(await cancelAssistantOperation(user, workspaceId, opId));
    assertCharacterFusionWritesEnabled();
    if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 4000
      || typeof body.model !== 'string' || !body.model || body.model.length > 80
      || !Number.isSafeInteger(body.baseVersion) || Number(body.baseVersion) < 1) throw new FusionAgentError('创作请求或所选模型无效，原输入已保留。');
    const reserved = await reserveAssistantOperation(user, workspaceId, { opId, baseVersion: Number(body.baseVersion), message: body.message.trim(), model: body.model });
    if (reserved.status !== 'planning' || !reserved.claimed) {
      return json({ ...reserved, pending: reserved.status === 'planning', reply: reserved.status === 'committed' ? '原操作已确认，请继续使用原结果。' : reserved.status === 'planning' ? '原操作仍在处理，请按原编号核对。' : '原回合已结束，输入保留，可继续新的创作要求。' });
    }
    intent = { user, workspaceId, opId, fingerprint: reserved.intentFingerprint };
    const { workspace } = await getWorkspace(user, workspaceId, { allRows: true });
    const settings = await getMuskApiSettings();
    if (!isMuskApiReady(settings)) throw new FusionAgentError('当前 LLM 服务未启用或缺少配置，手动操作仍可继续。', 503, 'musk_api_not_configured');
    if (!(await resolveMuskChatModels(settings)).includes(body.model)) throw new FusionAgentError('所选模型已不在当前目录，请更新目录后重新选择；输入已保留。', 400, 'model_not_allowed');
    await assertSupplementaryModelEnabled('text', body.model);
    const selectedModel = body.model;
    const started = Date.now();
    const result = await proposeFusionAgent({
      workspace, message: body.message.trim(), signal: request.signal,
      complete: async messages => {
        const remaining = 90000 - (Date.now() - started);
        if (remaining < 1000) throw new FusionAgentError('本轮模型请求已达时限，未提交的新提案已停止。', 504, 'fusion_agent_timeout');
        // Match the selected live directory on every turn; no silent model fallback.
        const latest = await getMuskApiSettings();
        if (!isMuskApiReady(latest) || !(await resolveMuskChatModels(latest)).includes(selectedModel)) throw new FusionAgentError('所选模型当前不可用，输入和已有结果已保留。', 503, 'model_not_allowed');
        await assertSupplementaryModelEnabled('text', selectedModel);
        return (await createMuskChatCompletion({ settings: latest, model: selectedModel, messages, temperature: .4, jsonMode: false, timeoutMs: remaining, signal: request.signal })).content;
      },
      read: async read => {
        if (read.kind === 'results') {
          const page = await getWorkspace(user, workspaceId, { cursor: read.cursor, limit: read.limit || 20 });
          return { results: page.workspace.rows.map(row => ({ id: row.id, name: row.name, version: row.version, category: row.category, traits: row.design?.traits })), ...page.rowsPage };
        }
        const page = await readFusionCatalogue(user, { categoryId: read.categoryId, q: read.q, cursor: read.cursor, limit: read.limit || 20 });
        return { version: page.catalogue.version, nextCursor: page.nextCursor, total: page.total,
          categories: page.catalogue.categories.filter(category => category.enabled).map(category => ({ id: category.id, nameZh: category.nameZh, nameEn: category.nameEn, generationKind: category.generationKind, multi: category.multi, randomMax: category.randomMax })),
          terms: page.catalogue.terms.map(term => ({ id: term.id, categoryId: term.categoryId, nameZh: term.nameZh, nameEn: term.nameEn, descriptionZh: term.descriptionZh, descriptionEn: term.descriptionEn })) };
      },
    });
    proposed = result.proposal;
    request.signal.throwIfAborted();
    const commands = result.limitReached ? [] : bindFusionAgentCommands(result.proposal.commands, workspace, randomInt(0, 2147480000));
    const reply = result.limitReached ? '本轮已达到 6 次工具往返上限，未执行新创作操作；已有现场与查询结果已保留，可明确目标后继续。'
      : commands.length ? `已应用 ${commands.length} 项创作操作。${result.proposal.reply}` : `本轮仅提供建议或草稿，未执行抽卡或设置变更。${result.proposal.reply}`;
    const messages = [...workspace.state.messages, { role: 'user' as const, content: body.message.trim() }, { role: 'assistant' as const, content: reply }].slice(-20);
    const context: FusionCommand = { type: 'context', messages, expected: { messages: workspace.state.messages } };
    const receipt = await executeWorkspaceOperation(user, workspaceId, { opId, baseVersion: workspace.version, commands: [...commands, context] }, { assistantFingerprint: intent.fingerprint });
    return json({ ...receipt, reply, drafts: result.proposal.drafts, reads: result.reads, iterations: result.iterations, limitReached: result.limitReached, model: selectedModel });
  } catch (error) {
    // A dropped connection does not cancel a possibly submitted operation.
    if (intent && !request.signal.aborted) {
      try { await finishAssistantOperation(intent.user, intent.workspaceId, intent.opId, { intentFingerprint: intent.fingerprint, status: 'rejected', message: error instanceof Error ? error.message : '本轮提案未完成。', proposal: proposed }); }
      catch { /* The caller must query the same original receipt if its status is unknown. */ }
    }
    if (error instanceof AuthError || error instanceof FusionError || error instanceof FusionAgentError || error instanceof MuskApiError) return json({ error: error.message, code: 'code' in error ? error.code : undefined, details: { conflict: 'details' in error ? error.details : undefined, ...(proposed ? { proposal: proposed } : {}) }, submitted: false }, error.status);
    if (error instanceof SyntaxError) return json({ error: '请求不是有效 JSON，输入已保留。', submitted: false }, 400);
    const known = error as { status?: number; code?: string } | null;
    return json({ error: request.signal.aborted ? '等待已中断，请核对原操作编号。' : '本轮回复未确认，请核对原操作编号；当前输入与结果已保留。', code: known?.code, pending: true }, known?.status || 503);
  }
}
