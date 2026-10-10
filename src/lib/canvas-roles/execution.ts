import { randomUUID } from 'crypto';
import type { CanvasRoleTaskRun, CanvasRoleWork } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { getMuskApiSettings, isMuskApiReady } from '@/lib/integrations/musk';
import { compileCanvasTextRules, getCanvasTextSettings } from '@/lib/canvas-text-settings';
import { allocateTaskCredits, settleTaskCredits } from '@/lib/credits/policy';
import { assertLiveNode, ownedRun, type RoleDb } from './permissions';
import { roleMutation } from './repository';
import { assertCurrentMaterials, assertEffectiveInputs, latestWorks, taskRequirements, workInputDigest, finalizeDelivered } from './work';
import { callRoleText, cashToPointCents, parseTextContract, readTextCharge, textScope, TEXT_BILLING_KEY, type TextContract } from './text-provider';
import { digest, identifier, integer, record, RoleError, text, type JsonRecord, type RoleSnapshot, type TaskRequirements } from './types';

function executorIdentity(work: CanvasRoleWork) {
  const snapshot = JSON.parse(work.snapshot_json);
  return { workId: work.id, nodeId: work.node_id, roleVersionId: work.role_version_id,
    definitionId: snapshot.definitionId, version: snapshot.version, roleDigest: digest(snapshot.role) };
}

async function quoteFor(db: RoleDb, work: CanvasRoleWork, purpose: string, req: TaskRequirements) {
  const run = await db.canvasRoleTaskRun.findUniqueOrThrow({ where: { id: work.role_task_run_id } });
  let executorWork = work;
  if (purpose === 'review') {
    const reviewer = (await latestWorks(db, run.id, work.requirements_revision)).find(w => w.node_id === work.reviewer_node_id);
    if (!reviewer) throw new RoleError('未指定可用检查角色', 409, 'reviewer_unavailable');
    executorWork = reviewer;
  }
  const snapshot: RoleSnapshot = JSON.parse(executorWork.snapshot_json).role;
  if (snapshot.executor.kind !== 'ai' || !snapshot.tools.includes('text')) throw new RoleError('此角色未配置文字 AI 能力', 409, 'text_executor_unavailable');
  const settings = await getMuskApiSettings(db);
  if (!isMuskApiReady(settings) || new URL(settings.base_url).origin !== 'https://api.muskapis.com') throw new RoleError('已配置文字供应商当前不可用', 503, 'text_provider_unavailable');
  const row = await db.platformSetting.findUnique({ where: { key: TEXT_BILLING_KEY } });
  const configured = row ? JSON.parse(row.value_json) : null;
  const contract = parseTextContract(record(configured) && Array.isArray(configured.contracts)
    ? configured.contracts.find(c => record(c) && c.model === snapshot.executor.model) : null, textScope(settings), snapshot.executor.model!);
  if (!contract) throw new RoleError('当前账号文字账单可查询，但当前报价、本站文字扣点规则及请求编号对应证据尚未确认；不发送请求，不报免费', 409, 'text_billing_contract_pending');
  const inputDigest = workInputDigest(work, req);
  const context = await scopedExecutionContext(db, work, executorWork, purpose);
  const identity = executorIdentity(executorWork);
  return { settings, snapshot, executorWork, executorIdentity: identity, contract,
    quoteId: digest({ contract, workId: work.id, revision: work.revision, inputDigest, context, purpose, executorIdentity: identity }), inputDigest };
}
export async function executionView(user: SessionUser, run: CanvasRoleTaskRun, work: CanvasRoleWork, req: TaskRequirements) {
  const result: Record<string, JsonRecord> = {};
  for (const purpose of ['work', 'review']) {
    try {
      const q = await quoteFor(prisma, work, purpose, req);
      const { document } = await ownedRun(prisma, user, run.id);
      assertLiveNode(work, document.document_json);
      assertLiveNode(q.executorWork, document.document_json);
      await assertCurrentMaterials(prisma, user, document.document_json, req);
      if (['ready', 'working', 'revision', 'review'].includes(work.phase)) await assertEffectiveInputs(prisma, work, req, document.document_json, user);
      const unknown = await prisma.canvasRoleAttempt.count({ where: { work: { role_task_run_id: run.id },
        OR: [{ state: 'unknown' }, { work_id: work.id, OR: [{ state: { in: ['reserved', 'sending'] } }, { fee_state: 'pending' }] }, { fee_state: { in: ['unknown', 'authorization_required'] } }] } });
      const remaining = run.budget_points_limit != null && run.budget_usd_micros_limit != null && run.max_calls != null
        && run.call_count < run.max_calls && run.settled_points + run.reserved_points + q.contract.reservePointCents <= run.budget_points_limit
        && run.settled_usd_micros + run.reserved_usd_micros + q.contract.reserveUsdMicros <= run.budget_usd_micros_limit;
      const enabled = !run.paused && run.requirements_revision === work.requirements_revision && !unknown
        && (purpose === 'work' ? ['ready', 'working', 'revision'].includes(work.phase) : work.phase === 'review')
        && remaining;
      if (enabled) {
        const input = await executionInput(prisma, work, req, q.snapshot, purpose, q.executorWork);
        if (Buffer.byteLength(JSON.stringify(input)) + 2048 > q.contract.maxInputBytes) throw new RoleError('材料超出报价输入范围', 409, 'quote_input_limit');
      }
      const reason = run.paused ? '本次任务已暂停，不会开始新调用' : unknown ? '原请求或费用尚未确认，请查询原回执；不会重发'
        : run.requirements_revision !== work.requirements_revision ? '这是历史工作，请打开当前任务版本'
          : !remaining ? '本次点数、美金额度或调用次数尚未设置，或剩余额度不足；不会自动增加'
            : '请先接收工作或打开当前待检查成果';
      result[purpose] = { enabled, code: enabled ? 'ready' : 'work_or_budget_not_ready',
        reason: enabled ? '按本次报价预留，收到真实文字账单后结算；需要每次点击开始' : reason,
        quote_id: q.quoteId, model: q.contract.model, reserve_points: q.contract.reservePointCents / 100,
        reserve_usd_micros: q.contract.reserveUsdMicros, expires_at: q.contract.expiresAt,
        max_output_tokens: q.contract.maxOutputTokens, source: q.contract.source };
    } catch (error) {
      result[purpose] = { enabled: false, code: error instanceof RoleError ? error.code : 'text_contract_unavailable',
        reason: error instanceof RoleError ? error.message : '文字收费配置无法确认，未发送请求' };
    }
  }
  return { ...result.work, enabled: result.work.enabled === true, purposes: result, ownerId: user.id };
}

export async function scopedExecutionContext(db: RoleDb, work: CanvasRoleWork, executorWork: CanvasRoleWork, purpose: string) {
  const messages = await db.canvasRoleEvent.findMany({ where: { role_task_run_id: work.role_task_run_id,
    requirements_revision: work.requirements_revision, kind: 'message',
    OR: [{ to_node_id: executorWork.node_id }, { from_node_id: executorWork.node_id }] },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }], take: 101 });
  if (messages.length > 100) throw new RoleError('本角色交流超出一次输入范围，请整理为当前任务要求后再执行', 409, 'text_exchange_limit');
  const snapshot = JSON.parse(work.snapshot_json);
  let revisionSource = null;
  if (snapshot.revisionSource) {
    const source = await db.canvasRoleDelivery.findUnique({ where: { id: identifier(snapshot.revisionSource.deliveryId) } });
    const sourceWork = source && await db.canvasRoleWork.findFirst({ where: { id: source.work_id, role_task_run_id: work.role_task_run_id, node_id: work.node_id } });
    if (!sourceWork || sourceWork.id !== snapshot.supersedesWorkId) throw new RoleError('返工原稿版本无法确认', 409, 'delivery_conflict');
    revisionSource = { deliveryId: source!.id, requirementsRevision: sourceWork.requirements_revision, content: JSON.parse(source!.content_json), opinion: snapshot.revisionSource.opinion,
      readonly: true };
  }
  return { recipientNodeId: executorWork.node_id, purpose,
    conversations: messages.map(message => ({ id: message.id, fromNodeId: message.from_node_id, toNodeId: message.to_node_id,
      actorUserId: message.actor_user_id, ...JSON.parse(message.detail_json) })),
    revisionSource, revisionOpinion: work.wait_reason || null };
}
export async function executionInput(db: RoleDb, work: CanvasRoleWork, req: TaskRequirements, snapshot: RoleSnapshot, purpose: string, executorWork = work) {
  if ((req.materials || []).some(m => !['text', 'script'].includes(String(m.type)))) throw new RoleError('本次文字能力不能读取图片、视频或音频原件，请补充文字后更新任务材料', 409, 'text_material_unsupported');
  const inputs = [];
  for (const input of JSON.parse(work.inputs_json)) {
    const source = await db.canvasRoleDelivery.findUnique({ where: { id: input.deliveryId } });
    if (!source || source.requirements_revision !== work.requirements_revision) throw new RoleError('交接材料版本无效', 409, 'delivery_conflict');
    inputs.push({ ...input, content: JSON.parse(source.content_json) });
  }
  const delivery = purpose === 'review' && work.current_delivery_id
    ? await db.canvasRoleDelivery.findUnique({ where: { id: work.current_delivery_id } }) : null;
  const context = await scopedExecutionContext(db, work, executorWork, purpose);
  const draft = JSON.parse(work.snapshot_json).draftContent || { text: work.draft_text, items: {}, attachments: [] };
  const unsupported = (content: JsonRecord | null) => Array.isArray(content?.attachments)
    && content.attachments.some(attachment => !record(attachment) || attachment.sourceKind !== 'canvas_text');
  if (inputs.some(input => unsupported(input.content)) || unsupported(context.revisionSource?.content || null)
    || (delivery && unsupported(JSON.parse(delivery.content_json))) || unsupported(draft)) {
    throw new RoleError('此文字模型未接通原件理解，请人工处理媒体成果；不会把缩略图当作已读原件', 409, 'text_material_unsupported');
  }
  const compiled = compileCanvasTextRules(await getCanvasTextSettings(db), 'text', '');
  return { purpose, role: snapshot, task: { goal: req.goal, criteria: req.criteria, requirementsRevision: work.requirements_revision },
    materials: req.materials || [], inputs, currentDraft: draft, context, contextDigest: digest(context),
    ...(delivery ? { reviewDelivery: { id: delivery.id, version: delivery.version, content: JSON.parse(delivery.content_json) },
      reviewTarget: JSON.parse(work.snapshot_json).role, reviewIsRecommendationOnly: true } : {}),
    rules: { basicRules: compiled.basicRules, purposeRules: compiled.purposeRules }, rulesTrace: compiled.trace };
}

export async function executeWork(user: SessionUser, workId: string, body: JsonRecord) {
  identifier(workId);
  const purpose = body.purpose === 'review' ? 'review' : body.purpose === 'work' ? 'work' : '';
  if (!purpose) throw new RoleError('请明确本次工作或检查用途');
  const authorization = async (db: RoleDb) => {
    const work = await db.canvasRoleWork.findUnique({ where: { id: workId } });
    if (!work) throw new RoleError('工作不存在', 404);
    return ownedRun(db, user, work.role_task_run_id, true);
  };
  const reserved = await roleMutation(user, body, `role_execute:${workId}`, authorization, async db => {
    const { run, document } = await authorization(db);
    const work = (await db.canvasRoleWork.findUnique({ where: { id: workId } }))!;
    if (integer(body.base_revision) !== work.revision || integer(body.requirements_revision) !== run.requirements_revision
      || work.requirements_revision !== run.requirements_revision) throw new RoleError('任务或工作已更新，请重新核对', 409, 'revision_conflict');
    if (run.paused || (purpose === 'work' ? !['ready', 'working', 'revision'].includes(work.phase) : work.phase !== 'review')) throw new RoleError('本次工作尚不能开始', 409, 'phase_conflict');
    assertLiveNode(work, document.document_json);
    const req = await taskRequirements(db, run.id, run.requirements_revision);
    await assertCurrentMaterials(db, user, document.document_json, req);
    await assertEffectiveInputs(db, work, req, document.document_json, user);
    const q = await quoteFor(db, work, purpose, req);
    assertLiveNode(q.executorWork, document.document_json);
    if (body.quote_id !== q.quoteId || body.max_output_tokens !== q.contract.maxOutputTokens) throw new RoleError('报价已变，请重新核对', 409, 'quote_changed');
    if (run.budget_points_limit == null || run.budget_usd_micros_limit == null || run.max_calls == null) throw new RoleError('请明确本次点数和美元预算及最多调用次数', 409, 'budget_required');
    if (run.call_count >= run.max_calls || run.settled_points + run.reserved_points + q.contract.reservePointCents > run.budget_points_limit
      || run.settled_usd_micros + run.reserved_usd_micros + q.contract.reserveUsdMicros > run.budget_usd_micros_limit) throw new RoleError('本次任务预算或调用次数不足，不会自动增加', 409, 'budget_exceeded');
    if (await db.canvasRoleAttempt.count({ where: { work: { role_task_run_id: run.id },
      OR: [{ state: 'unknown' }, { work_id: work.id, OR: [{ state: { in: ['reserved', 'sending'] } }, { fee_state: 'pending' }] }, { fee_state: { in: ['unknown', 'authorization_required'] } }] } })) throw new RoleError('已有同一工作请求或未闭合费用授权，不能另开尝试', 409, 'attempt_unresolved');
    const input = await executionInput(db, work, req, q.snapshot, purpose, q.executorWork);
    if (Buffer.byteLength(JSON.stringify(input)) + 2048 > q.contract.maxInputBytes) throw new RoleError('材料超出报价输入范围', 409, 'quote_input_limit');
    const id = randomUUID();
    const freeze = await allocateTaskCredits(db, user, q.contract.reservePointCents / 100, `role-attempt:${id}`);
    await db.creditLedger.create({ data: { user_id: user.id, type: 'task_freeze', amount: 0,
      balance_before: freeze.balance_before, balance_after: freeze.balance_after, frozen_before: freeze.frozen_before, frozen_after: freeze.frozen_after,
      related_task_id: `role-attempt:${id}`, idempotency_key: `role-freeze:${id}`, reason: '本次角色文字请求预留', metadata_json: JSON.stringify({ roleTaskRunId: run.id, allocations: freeze.allocations }) } });
    await db.canvasRoleAttempt.create({ data: { id, work_id: work.id, round: work.round, purpose,
      attempt: (await db.canvasRoleAttempt.count({ where: { work_id: work.id, round: work.round, purpose } })) + 1,
      request_id: identifier(body.mutation_id), state: 'reserved', fee_state: 'pending',
      input_snapshot_json: JSON.stringify(input), quote_json: JSON.stringify({ contract: q.contract, freezeSnapshot: freeze.snapshot,
        quoteId: q.quoteId, workRevision: work.revision, requirementsRevision: run.requirements_revision, executorIdentity: q.executorIdentity }),
      reserved_points: q.contract.reservePointCents, reserved_usd_micros: q.contract.reserveUsdMicros, provider_scope: q.contract.scope } });
    await db.canvasRoleTaskRun.update({ where: { id: run.id }, data: { call_count: { increment: 1 }, reserved_points: { increment: q.contract.reservePointCents },
      reserved_usd_micros: { increment: q.contract.reserveUsdMicros }, revision: { increment: 1 } } });
    return { objectId: work.id, result: { attemptId: id, workId: work.id, state: 'reserved' } };
  });
  // Claim is durable and independent of HTTP retries. A crashed sender is never re-claimed.
  const claimed = await prisma.canvasRoleAttempt.updateMany({ where: { id: reserved.attemptId, state: 'reserved' }, data: { state: 'sending' } });
  if (claimed.count !== 1) return { ...reserved, state: (await prisma.canvasRoleAttempt.findUnique({ where: { id: reserved.attemptId } }))?.state, resend: false };
  const attempt = (await prisma.canvasRoleAttempt.findUnique({ where: { id: reserved.attemptId } }))!;
  const quote = JSON.parse(attempt.quote_json), contract: TextContract = quote.contract;
  let sent = false;
  let actualResult: Awaited<ReturnType<typeof callRoleText>> | null = null;
  try {
    const work = await prisma.canvasRoleWork.findUniqueOrThrow({ where: { id: attempt.work_id } });
    const { run, document } = await ownedRun(prisma, user, work.role_task_run_id, true);
    const req = await taskRequirements(prisma, run.id, work.requirements_revision);
    if (run.paused || work.revision !== quote.workRevision || run.requirements_revision !== quote.requirementsRevision) throw new RoleError('任务已暂停或更新，本次尚未发送', 409, 'presend_conflict');
    assertLiveNode(work, document.document_json);
    await assertCurrentMaterials(prisma, user, document.document_json, req);
    await assertEffectiveInputs(prisma, work, req, document.document_json, user);
    const q = await quoteFor(prisma, work, purpose, req);
    assertLiveNode(q.executorWork, document.document_json);
    if (q.quoteId !== quote.quoteId) throw new RoleError('报价已变化，本次尚未发送', 409, 'quote_changed');
    const settings = await getMuskApiSettings();
    const result = actualResult = await callRoleText(settings, contract, JSON.parse(attempt.input_snapshot_json), async (url, init) => {
      sent = true;
      return fetch(url, init);
    });
    // Persist the supplier receipt independently; adoption failure cannot erase a paid result.
    await prisma.canvasRoleAttempt.updateMany({ where: { id: attempt.id, state: 'sending' }, data: {
      provider_reference: result.providerReference, result_json: JSON.stringify(result), finished_at: new Date(),
    } });
    await prisma.$transaction(async db => {
      const current = await db.canvasRoleAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
      if (current.state !== 'sending') return;
      const work = await db.canvasRoleWork.findUniqueOrThrow({ where: { id: current.work_id } });
      const { run, document } = await ownedRun(db, user, work.role_task_run_id, true);
      const req = await taskRequirements(db, run.id, work.requirements_revision);
      if (work.revision !== quote.workRevision || run.requirements_revision !== work.requirements_revision) throw new RoleError('原工作已变化，结果保留但不自动采用', 409, 'revision_conflict');
      assertLiveNode(work, document.document_json);
      await assertCurrentMaterials(db, user, document.document_json, req);
      await assertEffectiveInputs(db, work, req, document.document_json, user);
      const executorWork = purpose === 'review'
        ? (await latestWorks(db, run.id, work.requirements_revision)).find(w => w.node_id === work.reviewer_node_id) : work;
      if (!executorWork) throw new RoleError('实际执行角色已不可用，原回复保留但未采用', 409, 'reviewer_unavailable');
      assertLiveNode(executorWork, document.document_json);
      if (!record(quote.executorIdentity) || digest(executorIdentity(executorWork)) !== digest(quote.executorIdentity)) {
        throw new RoleError('实际执行角色与原请求不一致，原回复保留但未采用', 409, 'executor_conflict');
      }
      if (digest(await scopedExecutionContext(db, work, executorWork, purpose)) !== JSON.parse(current.input_snapshot_json).contextDigest) {
        throw new RoleError('本次定向交流已变化，原回复保留但未采用', 409, 'input_conflict');
      }
      await db.canvasRoleAttempt.update({ where: { id: current.id }, data: { state: 'succeeded', provider_reference: result.providerReference,
        result_json: JSON.stringify(result), finished_at: new Date() } });
      if (purpose === 'work') {
        const snap: RoleSnapshot = JSON.parse(work.snapshot_json).role;
        for (const item of snap.requiredItems) text((result.content.items as JsonRecord)[item], 16000, true);
        const delivery = await db.canvasRoleDelivery.create({ data: { id: randomUUID(), work_id: work.id,
          version: (await db.canvasRoleDelivery.count({ where: { work_id: work.id } })) + 1, requirements_revision: work.requirements_revision,
          content_json: JSON.stringify(result.content), input_digest: workInputDigest(work, req), submitted_by: user.id, submission_kind: 'ai' } });
        const phase = work.reviewer_node_id ? 'review' : work.confirm_required ? 'confirmation' : 'delivered';
        await db.canvasRoleWork.update({ where: { id: work.id }, data: { current_delivery_id: delivery.id, phase,
          draft_text: String(result.content.text || ''),
          snapshot_json: JSON.stringify({ ...JSON.parse(work.snapshot_json), draftContent: { ...result.content, attachments: [] } }), revision: { increment: 1 } } });
        if (phase === 'delivered') await finalizeDelivered(db, user, run, req);
      }
      await db.canvasRoleEvent.create({ data: { id: randomUUID(), role_task_run_id: run.id, requirements_revision: work.requirements_revision,
        work_id: work.id, actor_user_id: user.id, actor_kind: 'ai', kind: purpose === 'review' ? 'ai_review_recommendation' : 'ai_text_result',
        detail_json: JSON.stringify({ attemptId: current.id, model: result.model, content: purpose === 'review' ? result.content : undefined,
          authorityGranted: false, purpose, feePending: true }) } });
    });
    await reconcileAttempt(user, attempt.id).catch(() => {});
    return { ...reserved, state: 'succeeded', resend: false };
  } catch (error) {
    if (!sent) {
      await prisma.$transaction(async db => {
        const current = await db.canvasRoleAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
        if (current.state !== 'sending' || current.settlement_applied) return;
        if (await db.user.findUnique({ where: { id: user.id }, select: { id: true } })) {
          const released = await settleTaskCredits(db, { taskId: `role-attempt:${current.id}`, userId: user.id, terminalStatus: 'failed',
            frozenAmount: current.reserved_points / 100, freezeSnapshot: quote.freezeSnapshot, actualCost: 0 });
          await db.creditLedger.create({ data: { user_id: user.id, type: 'task_billing_release', amount: released.refundedAmount,
            balance_before: released.balanceBefore, balance_after: released.balanceAfter, frozen_before: released.frozenBefore, frozen_after: released.frozenAfter,
            related_task_id: `role-attempt:${current.id}`, idempotency_key: `role-settle:${current.id}`, reason: '发送前校验未通过，未调用供应商', metadata_json: '{}' } });
        }
        await db.canvasRoleAttempt.update({ where: { id: current.id }, data: { state: 'failed', fee_state: 'not_sent', settlement_applied: true,
          settled_points: 0, settled_usd_micros: 0, finished_at: new Date(), settlement_receipt: JSON.stringify({ source: 'presend_validation', providerCalls: 0 }) } });
        const originalWork = await db.canvasRoleWork.findUniqueOrThrow({ where: { id: current.work_id } });
        await db.canvasRoleTaskRun.update({ where: { id: originalWork.role_task_run_id }, data: { reserved_points: { decrement: current.reserved_points },
          reserved_usd_micros: { decrement: current.reserved_usd_micros }, revision: { increment: 1 } } });
      }, { timeout: 15000 });
      return { ...reserved, state: 'failed', fee_state: 'not_sent', resend: false,
        code: error instanceof RoleError ? error.code : 'presend_failed', error: '发送前校验未通过，未调用供应商；原预留已释放' };
    }
    // Even malformed responses may have cost money. Preserve result identity, never refund blindly.
    const state = actualResult ? 'not_adopted' : 'unknown';
    await prisma.canvasRoleAttempt.updateMany({ where: { id: attempt.id, state: 'sending' }, data: { state, fee_state: actualResult ? 'pending' : 'unknown',
      ...(actualResult ? { provider_reference: actualResult.providerReference, result_json: JSON.stringify(actualResult), finished_at: new Date() }
        : error instanceof RoleError && typeof error.details.provider_reference === 'string' ? { provider_reference: error.details.provider_reference } : {}) } });
    return { ...reserved, state, resend: false, code: actualResult ? 'result_not_adopted' : 'provider_receipt_unknown',
      error: actualResult ? '真实结果已保留，但原工作已变化或成果不符合约定，未自动采用；请查询原账单' : '结果或费用待确认，请查询原请求；不会重新发送' };
  }
}

export async function reconcileAttempt(user: SessionUser, attemptId: string) {
  const attempt = await prisma.canvasRoleAttempt.findUnique({ where: { id: identifier(attemptId) } });
  if (!attempt) throw new RoleError('请求不存在', 404);
  const work = await prisma.canvasRoleWork.findUniqueOrThrow({ where: { id: attempt.work_id } });
  await ownedRun(prisma, user, work.role_task_run_id);
  if (attempt.settlement_applied || !attempt.provider_reference) return { attemptId, state: attempt.state, fee_state: attempt.fee_state, resend: false };
  const quote = JSON.parse(attempt.quote_json), contract: TextContract = quote.contract;
  const charge = await readTextCharge(await getMuskApiSettings(), contract.scope, attempt.provider_reference, contract.model).catch(() => null);
  if (!charge) return { attemptId, state: attempt.state, fee_state: attempt.fee_state, resend: false, reason: '原文字账单未精确匹配，不报零、不重发' };
  const originalResult = attempt.result_json ? JSON.parse(attempt.result_json) : null;
  if (charge.occurredAt < attempt.started_at.getTime() - 1000 || charge.occurredAt > Date.now() + 300000
    || (originalResult && (originalResult.usage?.prompt_tokens !== charge.promptTokens
      || originalResult.usage?.completion_tokens !== charge.completionTokens))) {
    return { attemptId, state: attempt.state, fee_state: attempt.fee_state, resend: false, reason: '原账单时间或用量不对应本次请求，保留预留待核对' };
  }
  return prisma.$transaction(async db => {
    const current = await db.canvasRoleAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    const { run } = await ownedRun(db, user, work.role_task_run_id);
    if (current.settlement_applied) return { attemptId, fee_state: current.fee_state, resend: false };
    const actualCents = cashToPointCents(charge.amountMicros, contract.pointsPerUsd);
    if (actualCents > current.reserved_points || charge.amountMicros > current.reserved_usd_micros) {
      await db.canvasRoleAttempt.update({ where: { id: current.id }, data: {
        fee_state: 'authorization_required', settlement_receipt: JSON.stringify(charge),
      } });
      return { attemptId, state: current.state, fee_state: 'authorization_required', actual_usd_micros: charge.amountMicros,
        resend: false, reason: '原账单超过本次预留授权，保留预留待处理；不会追加扣费或重发' };
    }
    // Quote expiry gates new sends, not settlement of a previously authorized send.
    // Result adoption and actual supplier consumption are independent facts.
    const settlement = await settleTaskCredits(db, { taskId: `role-attempt:${current.id}`, userId: user.id, terminalStatus: 'succeeded',
      frozenAmount: current.reserved_points / 100, freezeSnapshot: quote.freezeSnapshot, actualCost: actualCents / 100 });
    await db.creditLedger.create({ data: { user_id: user.id, type: 'task_success_deduct',
      amount: -actualCents / 100, balance_before: settlement.balanceBefore, balance_after: settlement.balanceAfter,
      frozen_before: settlement.frozenBefore, frozen_after: settlement.frozenAfter, related_task_id: `role-attempt:${current.id}`,
      idempotency_key: `role-settle:${current.id}`, reason: '角色文字原账单精确结算；不以成果是否采用免除已授权费用',
      metadata_json: JSON.stringify({ roleTaskRunId: run.id, supplierReference: charge.reference }) } });
    await db.canvasRoleAttempt.update({ where: { id: current.id }, data: { settlement_applied: true, fee_state: 'confirmed',
      settled_points: actualCents, settled_usd_micros: charge.amountMicros, settlement_receipt: JSON.stringify(charge) } });
    await db.canvasRoleTaskRun.update({ where: { id: run.id }, data: { reserved_points: { decrement: current.reserved_points },
      reserved_usd_micros: { decrement: current.reserved_usd_micros }, settled_points: { increment: actualCents },
      settled_usd_micros: { increment: charge.amountMicros }, revision: { increment: 1 } } });
    return { attemptId, state: current.state, fee_state: 'confirmed', resend: false };
  }, { timeout: 15000 });
}
