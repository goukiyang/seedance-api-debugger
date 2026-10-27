import { randomUUID } from 'crypto';
import type { CanvasRoleTaskRun, CanvasRoleWork } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { inheritUsageAttribution } from '@/lib/admin/usage-attribution';
import type { SessionUser } from '@/lib/auth/session';
import { getMuskApiSettings, isMuskApiReady } from '@/lib/integrations/musk';
import { isPrivatePromptError } from '@/lib/security/private-prompts.server';
import { compileCanvasTextRules, getCanvasTextSettings } from '@/lib/canvas-text-settings';
import { allocateTaskCredits, settleTaskCredits } from '@/lib/credits/policy';
import { assertLiveNode, assertRoleCollaborationWritable, ownedRun, type RoleDb } from './permissions';
import { roleMutation } from './repository';
import { assertCurrentMaterials, assertEffectiveInputs, handoffContent, latestWorks, taskRequirements, workInputDigest, finalizeDelivered } from './work';
import { callRoleText, cashToPointCents, parseTextContract, readTextCharge, textScope, TEXT_BILLING_KEY, type TextContract } from './text-provider';
import { assertRolePrepared, digest, identifier, integer, pointCents, record, RoleError, text, type JsonRecord, type RoleSnapshot, type TaskRequirements } from './types';
import { currentRoleGrant, queueRoleExecution } from './advancement';
import { createRoleTextContract, readRoleTextPolicy } from './text-billing';
import { askRoleQuestion, answerRoleQuestion, resolveRoleQuestion } from './questions';
import { applyCollaborationReview, deliveryPhase } from './results';
import { isRoleCollaborationReadOnly } from './guard';

export async function assertRoleAdmission(db: RoleDb, user: SessionUser, runId: string, scope: string, model: string) {
  const ownScope = { provider_scope: scope, work: { run: { owner_user_id: user.id } } };
  if (await db.canvasRoleAttempt.count({ where: { ...ownScope, OR: [{ state: 'unknown' },
    { fee_state: { in: ['unknown', 'authorization_required'] } },
    { fee_state: 'pending', state: { notIn: ['reserved', 'sending'] } }] } })) {
    throw new RoleError('本人在此供应商尚有未确认请求或费用，请先查询原回执', 409, 'attempt_unresolved');
  }
  const inflight = { state: { in: ['reserved', 'sending'] } };
  if (await db.canvasRoleAttempt.count({ where: inflight }) >= 2
    || await db.canvasRoleAttempt.count({ where: { ...inflight, work: { run: { owner_user_id: user.id } } } }) >= 2
    || await db.canvasRoleAttempt.count({ where: { ...inflight, work: { role_task_run_id: runId } } }) >= 2) {
    throw new RoleError('角色文字执行槽已满，等待原请求完成', 409, 'role_capacity_wait');
  }
  const modelScope = { provider_scope: scope, quote_json: { contains: '"model":' + JSON.stringify(model) } };
  const verified = await db.canvasRoleAttempt.count({ where: { ...modelScope, settlement_applied: true, fee_state: 'confirmed' } });
  if (!verified && await db.canvasRoleAttempt.count({ where: { ...modelScope, settlement_applied: false } })) {
    throw new RoleError('此账号模型的首笔费用尚未匹配，等待原请求核账', 409, 'first_receipt_wait');
  }
}

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
  assertRolePrepared(snapshot);
  if (purpose === 'review' && snapshot.reviewAuthority === 'none') throw new RoleError('此岗位只负责协调，不承担内容审核', 409, 'role_review_forbidden');
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
  if (isRoleCollaborationReadOnly()) return { enabled: false, code: 'collaboration_guard',
    reason: '角色协作处于保护模式，历史可查看，暂不开始新操作', ownerId: user.id, purposes: {} as Record<string, JsonRecord> };
  if (req.schema === 'role.requirements.v2') {
    const control = await prisma.canvasRoleRunControl.findUnique({ where: { run_id: run.id } });
    const ready = await (await import('./text-billing')).roleTextReadiness();
    return { ...ready, enabled: ready.enabled && !run.paused && run.status === 'active' && !!control?.active_grant_id,
      reason: !control?.active_grant_id ? '请从需求卡确认范围与预算后开始协作' : ready.reason,
      queuedOnly: true, ownerId: user.id, purposes: {} as Record<string, JsonRecord> };
  }
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
  const questions = await db.canvasRoleQuestion.findMany({ where: { run_id: work.role_task_run_id,
    requirements_revision: work.requirements_revision, OR: [{ from_work_id: executorWork.id }, { target_work_id: executorWork.id }],
    status: { notIn: ['resolved', 'cancelled'] } }, orderBy: [{ created_at: 'asc' }, { id: 'asc' }], take: 101 });
  if (questions.length > 100) throw new RoleError('当前交流超出单次输入范围，请本人整理', 409, 'text_exchange_limit');
  const answers = await db.canvasRoleEvent.findMany({ where: { id: { in: questions.map(q => q.answer_event_id).filter((id): id is string => !!id) } },
    select: { id: true, detail_json: true } });
  return { recipientNodeId: executorWork.node_id, purpose,
    questions: questions.map(q => ({ id: q.id, revision: q.revision, fromWorkId: q.from_work_id, targetWorkId: q.target_work_id,
      status: q.status, blocking: q.blocking, ...JSON.parse(q.body_json),
      answer: q.answer_event_id ? JSON.parse(answers.find(a => a.id === q.answer_event_id)?.detail_json || 'null') : null })),
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
    inputs.push({ ...input, content: handoffContent(JSON.parse(source.content_json), input.selectedItems,
      req.participants.find(p => p.nodeId === input.nodeId)?.deliverableItems) });
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
  const { contextGaps: _contextGaps, workflowOnly: _workflowOnly, ...preparedRole } = snapshot;
  const { contextGaps: _targetGaps, workflowOnly: _targetWorkflowOnly, ...reviewTarget } = JSON.parse(work.snapshot_json).role;
  return { purpose, role: preparedRole, task: { goal: req.goal, criteria: req.criteria, requirementsRevision: work.requirements_revision,
      assignment: req.participants.find(p => p.nodeId === work.node_id),
      relations: req.relations?.filter(r => r.from === executorWork.node_id || r.to === executorWork.node_id) },
    materials: req.materials || [], inputs, currentDraft: draft, context, contextDigest: digest(context),
    ...(delivery ? { reviewDelivery: { id: delivery.id, version: delivery.version, content: JSON.parse(delivery.content_json) },
      reviewTarget, reviewIsRecommendationOnly: true } : {}),
    rules: { basicRules: compiled.basicRules, purposeRules: compiled.purposeRules }, rulesTrace: compiled.trace };
}

export async function executeWork(user: SessionUser, workId: string, body: JsonRecord) {
  identifier(workId);
  const existingWork = await prisma.canvasRoleWork.findUnique({ where: { id: workId }, select: { role_task_run_id: true } });
  if (existingWork && await prisma.canvasRoleRunControl.findUnique({ where: { run_id: existingWork.role_task_run_id } })) {
    return queueRoleExecution(user, workId, body);
  }
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
    await assertRoleAdmission(db, user, run.id, q.contract.scope, q.contract.model);
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
    const createdAttempt = await db.canvasRoleAttempt.create({ data: { id, work_id: work.id, round: work.round, purpose,
      attempt: (await db.canvasRoleAttempt.count({ where: { work_id: work.id, round: work.round, purpose } })) + 1,
      request_id: identifier(body.mutation_id), state: 'reserved', fee_state: 'pending',
      input_snapshot_json: JSON.stringify(input), quote_json: JSON.stringify({ contract: q.contract, freezeSnapshot: freeze.snapshot,
        quoteId: q.quoteId, workRevision: work.revision, requirementsRevision: run.requirements_revision, executorIdentity: q.executorIdentity }),
      reserved_points: q.contract.reservePointCents, reserved_usd_micros: q.contract.reserveUsdMicros, provider_scope: q.contract.scope } });
    await inheritUsageAttribution(db, { sourceKind: 'role_attempt', sourceId: id,
      actorUserId: user.id, ownerUserId: run.owner_user_id, billingSubjectType: 'user', billingSubjectId: user.id,
      occurredAt: createdAttempt.started_at, parentSourceKind: 'role_run', parentSourceId: run.id });
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
    if (await holdRoleAttemptOnPrivateFailure(prisma, attempt.id, error)) throw error;
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

async function dispatchContext(db: RoleDb, user: SessionUser, dispatchId: string, token: string, epoch: number) {
  assertRoleCollaborationWritable();
  const dispatch = await db.canvasRoleDispatch.findUniqueOrThrow({ where: { id: dispatchId } });
  if (dispatch.state !== 'leased' || dispatch.lease_token !== token || dispatch.lease_epoch !== epoch
    || !dispatch.lease_until || dispatch.lease_until.getTime() <= Date.now() || !dispatch.work_id) throw new RoleError('原派发租约已失效', 409, 'lease_expired');
  const { run, document } = await ownedRun(db, user, dispatch.run_id, true);
  const req = await taskRequirements(db, run.id, run.requirements_revision);
  const { grant, authorization, control } = await currentRoleGrant(db, user, run, req);
  if (run.paused || run.status !== 'active' || control.mode !== 'automatic' || authorization.id !== dispatch.grant_id
    || dispatch.requirements_revision !== run.requirements_revision) throw new RoleError('任务已暂停或授权变化', 409, 'presend_conflict');
  const payload: JsonRecord = JSON.parse(dispatch.payload_json), purpose = dispatch.action;
  if (!['work', 'answer', 'review'].includes(purpose)) throw new RoleError('派发用途无效', 409);
  const works = await latestWorks(db, run.id, run.requirements_revision);
  const work = works.find(w => w.id === dispatch.work_id), executor = works.find(w => w.id === payload.executorWorkId);
  if (!work || !executor || purpose === 'work' && (work.revision !== payload.workRevision || executor.revision !== payload.executorRevision)
    || workInputDigest(work, req) !== payload.inputDigest) throw new RoleError('工作或输入已变化，原排队不会发送', 409, 'presend_conflict');
  assertLiveNode(work, document.document_json); assertLiveNode(executor, document.document_json);
  await assertCurrentMaterials(db, user, document.document_json, req);
  if (purpose !== 'answer') await assertEffectiveInputs(db, work, req, document.document_json, user);
  const role: RoleSnapshot = JSON.parse(executor.snapshot_json).role;
  const allowed = grant.executors.find(e => e.nodeId === executor.node_id && e.roleVersionId === executor.role_version_id
    && e.roleDigest === digest(role) && e.model === role.executor.model && e.purposes.includes(purpose as 'work' | 'answer' | 'review'));
  if (!allowed?.model) throw new RoleError('执行者不在本次授权内', 403, 'executor_not_authorized');
  if (purpose === 'work') {
    if (executor.id !== work.id || !['offered', 'ready', 'working', 'revision'].includes(work.phase)) throw new RoleError('工作阶段已变化', 409, 'phase_conflict');
    if (await db.canvasRoleQuestion.count({ where: { from_work_id: work.id, requirements_revision: run.requirements_revision,
      blocking: true, status: { in: ['open', 'answering', 'escalated'] } } })) throw new RoleError('请先处理阻塞问题', 409, 'question_blocking');
  } else if (purpose === 'answer') {
    const question = await db.canvasRoleQuestion.findUnique({ where: { id: identifier(payload.questionId) } });
    if (!question || question.run_id !== run.id || question.target_work_id !== executor.id || question.status !== 'open'
      || question.revision !== payload.questionRevision) throw new RoleError('待答问题已变化', 409, 'question_conflict');
  } else {
    const relation = req.relations?.find(r => r.id === payload.relationId && r.type === 'review' && r.from === work.node_id && r.to === executor.node_id);
    const reviews = await db.canvasRoleEvent.findMany({ where: { role_task_run_id: run.id, work_id: work.id,
      delivery_id: identifier(payload.deliveryId), kind: 'collaboration_review' }, select: { detail_json: true }, take: 501 });
    if (reviews.some(entry => JSON.parse(entry.detail_json).relationId === payload.relationId)) {
      throw new RoleError('此稿件已收到对应检查意见，原排队不再发送', 409, 'review_already_recorded');
    }
    if (!relation || work.phase !== 'review' || work.current_delivery_id !== payload.deliveryId || role.reviewAuthority === 'none') throw new RoleError('检查稿或检查者已变化', 409, 'review_conflict');
  }
  const settings = await getMuskApiSettings(db), policy = await readRoleTextPolicy(db, settings);
  if (!isMuskApiReady(settings) || !policy || new URL(settings.base_url).origin !== 'https://api.muskapis.com') throw new RoleError('角色文字政策未就绪', 409, 'role_text_policy_disabled');
  const contract = createRoleTextContract(policy, grant, authorization.id, allowed.model);
  const input = { ...await executionInput(db, work, req, role, purpose, executor), dispatch: {
    purpose, questionId: payload.questionId || null, deliveryId: payload.deliveryId || null,
    reviewAuthority: req.relations?.find(r => r.id === payload.relationId)?.authority || null } };
  if (Buffer.byteLength(JSON.stringify(input)) + 2048 > contract.maxInputBytes) throw new RoleError('材料超过本次输入上限，请本人整理，不会截断或收费摘要', 409, 'text_input_limit');
  return { dispatch, run, req, grant, authorization, payload, purpose, work, executor, contract, input, settings };
}

async function releaseUnsentAttempt(db: RoleDb, user: SessionUser, attemptId: string, code: string) {
  const current = await db.canvasRoleAttempt.findUniqueOrThrow({ where: { id: attemptId } });
  if (current.settlement_applied || !['reserved', 'sending'].includes(current.state)) return;
  const quote = JSON.parse(current.quote_json);
  const settlement = await settleTaskCredits(db, { taskId: `role-attempt:${current.id}`, userId: user.id, terminalStatus: 'failed',
    frozenAmount: current.reserved_points / 100, freezeSnapshot: quote.freezeSnapshot, actualCost: 0 });
  await db.creditLedger.create({ data: { user_id: user.id, type: 'task_billing_release', amount: settlement.refundedAmount,
    balance_before: settlement.balanceBefore, balance_after: settlement.balanceAfter, frozen_before: settlement.frozenBefore,
    frozen_after: settlement.frozenAfter, related_task_id: `role-attempt:${current.id}`, idempotency_key: `role-settle:${current.id}`,
    reason: '角色请求未发送，释放原预留', metadata_json: JSON.stringify({ code }) } });
  await db.canvasRoleAttempt.update({ where: { id: current.id }, data: { state: 'failed', fee_state: 'not_sent',
    settlement_applied: true, settled_points: 0, settled_usd_micros: 0, finished_at: new Date(),
    settlement_receipt: JSON.stringify({ providerCalls: 0, code }) } });
  const work = await db.canvasRoleWork.findUniqueOrThrow({ where: { id: current.work_id } });
  await db.canvasRoleTaskRun.update({ where: { id: work.role_task_run_id }, data: { reserved_points: { decrement: current.reserved_points },
    reserved_usd_micros: { decrement: current.reserved_usd_micros }, revision: { increment: 1 } } });
}

export async function holdRoleAttemptOnPrivateFailure(db: RoleDb, attemptId: string | null, error: unknown) {
  if (!isPrivatePromptError(error)) return false;
  if (attemptId) await db.canvasRoleAttempt.updateMany({ where: { id: attemptId,
    state: { in: ['reserved', 'sending'] }, settlement_applied: false },
    data: { state: 'unknown', fee_state: 'unknown' } });
  return true;
}

export async function recoverRoleDispatch(db: RoleDb, user: SessionUser, dispatchId: string) {
  const dispatch = await db.canvasRoleDispatch.findUniqueOrThrow({ where: { id: dispatchId } });
  if (dispatch.state !== 'leased' || !dispatch.lease_until || dispatch.lease_until.getTime() > Date.now()) return;
  if (!dispatch.attempt_id) {
    await db.canvasRoleDispatch.updateMany({ where: { id: dispatch.id, lease_epoch: dispatch.lease_epoch, state: 'leased' },
      data: { state: 'queued', lease_owner: null, lease_token: null, lease_until: null, due_at: new Date(), last_error: 'unclaimed_lease_recovered' } });
    return;
  }
  const attempt = await db.canvasRoleAttempt.findUniqueOrThrow({ where: { id: dispatch.attempt_id } });
  if (attempt.state === 'reserved') await releaseUnsentAttempt(db, user, attempt.id, 'sender_not_started');
  else if (attempt.state === 'sending') {
    await db.canvasRoleAttempt.update({ where: { id: attempt.id }, data: { state: 'unknown', fee_state: 'unknown' } });
    await db.canvasRoleTaskRun.update({ where: { id: dispatch.run_id }, data: { paused: true, revision: { increment: 1 } } });
    await db.canvasRoleRunControl.update({ where: { run_id: dispatch.run_id }, data: { mode: 'paused',
      pause_reason: 'sender_lost', next_wake_at: null, revision: { increment: 1 } } });
  }
  await db.canvasRoleDispatch.updateMany({ where: { id: dispatch.id, lease_epoch: dispatch.lease_epoch, state: 'leased' },
    data: { state: ['succeeded', 'not_adopted'].includes(attempt.state) ? 'done' : 'held', last_error: 'sender_recovered_no_resend',
      lease_owner: null, lease_token: null, lease_until: null } });
}

export async function executeReservedDispatch(user: SessionUser, dispatchId: string, token: string, epoch: number) {
  let attemptId: string | null = null, sent = false, actual: Awaited<ReturnType<typeof callRoleText>> | null = null;
  try {
    const reserved = await prisma.$transaction(async db => {
      const c = await dispatchContext(db, user, dispatchId, token, epoch);
      if (c.dispatch.attempt_id) return null;
      await assertRoleAdmission(db, user, c.run.id, c.contract.scope, c.contract.model);
      if (await db.canvasRoleAttempt.count({ where: { work_id: c.work.id, state: { in: ['reserved', 'sending'] } } })) throw new RoleError('原工作请求正在进行', 409, 'role_capacity_wait');
      if (c.run.call_count >= c.grant.maxCalls || c.work.round > c.grant.maxRounds
        || c.run.settled_points + c.run.reserved_points + c.contract.reservePointCents > c.grant.pointLimit
        || c.run.settled_usd_micros + c.run.reserved_usd_micros + c.contract.reserveUsdMicros > c.grant.usdMicrosLimit) throw new RoleError('本次额度或次数已用完，等待本人处理', 409, 'budget_exceeded');
      const id = randomUUID();
      const freeze = await allocateTaskCredits(db, user, c.contract.reservePointCents / 100, `role-attempt:${id}`);
      await db.creditLedger.create({ data: { user_id: user.id, type: 'task_freeze', amount: 0,
        balance_before: freeze.balance_before, balance_after: freeze.balance_after, frozen_before: freeze.frozen_before,
        frozen_after: freeze.frozen_after, related_task_id: `role-attempt:${id}`, idempotency_key: `role-freeze:${id}`,
        reason: '角色文字授权预留，不是报价', metadata_json: JSON.stringify({ roleTaskRunId: c.run.id, allocations: freeze.allocations }) } });
      const createdAttempt = await db.canvasRoleAttempt.create({ data: { id, work_id: c.work.id, round: c.work.round, purpose: c.purpose,
        attempt: (await db.canvasRoleAttempt.count({ where: { work_id: c.work.id, round: c.work.round, purpose: c.purpose } })) + 1,
        request_id: c.dispatch.id, state: 'reserved', fee_state: 'pending', provider_scope: c.contract.scope,
        reserved_points: c.contract.reservePointCents, reserved_usd_micros: c.contract.reserveUsdMicros,
        input_snapshot_json: JSON.stringify(c.input), quote_json: JSON.stringify({ contract: c.contract, freezeSnapshot: freeze.snapshot,
          workRevision: c.work.revision, executorRevision: c.executor.revision, executorIdentity: executorIdentity(c.executor),
          requirementsRevision: c.run.requirements_revision, inputDigest: c.payload.inputDigest, dispatchId,
          grantDigest: c.authorization.snapshot_digest, payload: c.payload, billingQuery: { count: 0, nextAt: Date.now() + 10000 } }) } });
      await inheritUsageAttribution(db, { sourceKind: 'role_attempt', sourceId: id,
        actorUserId: user.id, ownerUserId: c.run.owner_user_id, billingSubjectType: 'user', billingSubjectId: user.id,
        occurredAt: createdAttempt.started_at, parentSourceKind: 'role_run', parentSourceId: c.run.id });
      await db.canvasRoleDispatch.update({ where: { id: dispatchId }, data: { attempt_id: id } });
      await db.canvasRoleTaskRun.update({ where: { id: c.run.id }, data: { call_count: { increment: 1 },
        reserved_points: { increment: c.contract.reservePointCents }, reserved_usd_micros: { increment: c.contract.reserveUsdMicros }, revision: { increment: 1 } } });
      return id;
    }, { timeout: 15000 });
    if (!reserved) return;
    attemptId = reserved;
    const beforeSend = await prisma.$transaction(async db => {
      const context = await dispatchContext(db, user, dispatchId, token, epoch);
      const attempt = await db.canvasRoleAttempt.findUniqueOrThrow({ where: { id: reserved } });
      const quote = JSON.parse(attempt.quote_json);
      if (digest(context.input) !== digest(JSON.parse(attempt.input_snapshot_json)) || quote.grantDigest !== context.authorization.snapshot_digest) throw new RoleError('发送前上下文已变化', 409, 'presend_conflict');
      const claimed = await db.canvasRoleAttempt.updateMany({ where: { id: reserved, state: 'reserved' }, data: { state: 'sending' } });
      if (claimed.count !== 1) throw new RoleError('原请求已认领，不会重发', 409, 'attempt_claimed');
      return { settings: context.settings, contract: context.contract, input: context.input };
    }, { timeout: 15000 });
    actual = await callRoleText(beforeSend.settings, beforeSend.contract, beforeSend.input, async (url, init) => {
      sent = true; return fetch(url, init);
    });
    const result = actual;
    await prisma.canvasRoleAttempt.updateMany({ where: { id: reserved, state: { in: ['sending', 'unknown'] } }, data: {
      provider_reference: result.providerReference, result_json: JSON.stringify(result), finished_at: new Date() } });
    await prisma.$transaction(async db => {
      const attempt = await db.canvasRoleAttempt.findUniqueOrThrow({ where: { id: reserved } });
      if (!['sending', 'unknown'].includes(attempt.state)) return;
      const quote = JSON.parse(attempt.quote_json), payload = quote.payload;
      const work = await db.canvasRoleWork.findUniqueOrThrow({ where: { id: attempt.work_id } });
      const { run, document } = await ownedRun(db, user, work.role_task_run_id, true);
      const req = await taskRequirements(db, run.id, work.requirements_revision);
      const latest = await latestWorks(db, run.id, run.requirements_revision);
      const executor = latest.find(w => w.id === payload.executorWorkId);
      if (run.status === 'cancelled' || work.requirements_revision !== run.requirements_revision || !latest.some(w => w.id === work.id)
        || attempt.purpose === 'work' && work.revision !== quote.workRevision || !executor
        || attempt.purpose === 'work' && executor.revision !== quote.executorRevision
        || digest(executorIdentity(executor)) !== digest(quote.executorIdentity) || workInputDigest(work, req) !== quote.inputDigest) throw new RoleError('原工作已变化，原回复保留但不采用', 409, 'result_not_adopted');
      assertLiveNode(work, document.document_json); assertLiveNode(executor, document.document_json);
      await assertCurrentMaterials(db, user, document.document_json, req);
      if (attempt.purpose !== 'answer') await assertEffectiveInputs(db, work, req, document.document_json, user);
      if (digest(await scopedExecutionContext(db, work, executor, attempt.purpose)) !== JSON.parse(attempt.input_snapshot_json).contextDigest) throw new RoleError('原交流已变化，回复留在原请求', 409, 'input_conflict');
      const content = result.content, actor = { work: executor, attemptId: attempt.id };
      if (attempt.purpose === 'answer') {
        if (content.action !== 'answer' || content.questionId !== payload.questionId) throw new RoleError('回复不是当前问题的答复', 409, 'output_action_mismatch');
        await answerRoleQuestion(db, user, identifier(content.questionId), text(content.text, 16000, true), actor);
      } else if (attempt.purpose === 'review') {
        if (content.action !== 'review' || content.deliveryId !== payload.deliveryId) throw new RoleError('检查不对应原稿', 409, 'output_action_mismatch');
        await applyCollaborationReview(db, user, run, work, req, { delivery_id: content.deliveryId, input_digest: quote.inputDigest,
          action: content.verdict === 'revise' ? 'return' : content.verdict === 'suggestion' ? 'suggest' : 'approve', opinion: content.text }, actor);
      } else if (content.action === 'ask') {
        await askRoleQuestion(db, user, run, work, req, { targetNodeId: content.targetNodeId === null ? null : identifier(content.targetNodeId),
          question: text(content.question, 16000, true), blocking: content.blocking === true }, attempt.id);
        await db.canvasRoleWork.update({ where: { id: work.id }, data: { phase: 'working', revision: { increment: 1 } } });
      } else if (content.action === 'deliver') {
        if (Array.isArray(content.resolvedQuestionIds)) for (const id of content.resolvedQuestionIds) await resolveRoleQuestion(db, user, identifier(id), actor);
        if (await db.canvasRoleQuestion.count({ where: { from_work_id: work.id, blocking: true, status: { notIn: ['resolved', 'cancelled'] } } })) throw new RoleError('阻塞问题尚未明确解决，回复保留供本人处理', 409, 'question_blocking');
        const snapshot: RoleSnapshot = JSON.parse(work.snapshot_json).role;
        const required = [...snapshot.requiredItems, ...(req.participants.find(p => p.nodeId === work.node_id)?.deliverableItems || [])];
        if (!record(content.items)) throw new RoleError('交付项缺失', 409, 'delivery_incomplete');
        for (const item of required) text(content.items[item], 16000, true);
        const delivery = await db.canvasRoleDelivery.create({ data: { id: randomUUID(), work_id: work.id,
          version: (await db.canvasRoleDelivery.count({ where: { work_id: work.id } })) + 1,
          requirements_revision: work.requirements_revision, content_json: JSON.stringify({ ...content, attachments: [] }),
          input_digest: workInputDigest(work, req), submitted_by: user.id, submission_kind: 'ai' } });
        const phase = deliveryPhase(work, req);
        await db.canvasRoleWork.update({ where: { id: work.id }, data: { current_delivery_id: delivery.id, phase,
          draft_text: String(content.text), wait_reason: null, revision: { increment: 1 },
          snapshot_json: JSON.stringify({ ...JSON.parse(work.snapshot_json), draftContent: { ...content, attachments: [] } }) } });
        if (phase === 'delivered') await finalizeDelivered(db, user, run, req);
      } else throw new RoleError('本次工作回复动作不在授权内', 409, 'output_action_mismatch');
      await db.canvasRoleAttempt.update({ where: { id: attempt.id }, data: { state: 'succeeded', fee_state: 'pending' } });
      await db.canvasRoleEvent.create({ data: { id: randomUUID(), role_task_run_id: run.id, work_id: work.id,
        requirements_revision: work.requirements_revision, actor_user_id: user.id, actor_kind: 'ai', kind: 'collaboration_ai_result',
        from_node_id: executor.node_id, detail_json: JSON.stringify({ attemptId: attempt.id, purpose: attempt.purpose,
          action: content.action, model: result.model, feePending: true }) } });
    }, { timeout: 15000 });
    await reconcileAttempt(user, reserved, { automatic: true }).catch(() => {});
  } catch (error) {
    const privateConfigurationFailure = await holdRoleAttemptOnPrivateFailure(prisma, attemptId, error);
    const code = privateConfigurationFailure ? 'PRIVATE_PROMPT_UNAVAILABLE' : error instanceof RoleError ? error.code : 'role_execution_unconfirmed';
    if (attemptId) {
      if (!sent && !privateConfigurationFailure) await prisma.$transaction(db => releaseUnsentAttempt(db, user, attemptId!, code), { timeout: 15000 });
      else await prisma.canvasRoleAttempt.updateMany({ where: { id: attemptId, state: { in: ['sending', 'unknown'] } }, data: {
        state: actual ? 'not_adopted' : 'unknown', fee_state: actual ? 'pending' : 'unknown',
        ...(actual ? { result_json: JSON.stringify(actual), provider_reference: actual.providerReference, finished_at: new Date() }
          : error instanceof RoleError && typeof error.details.provider_reference === 'string' ? { provider_reference: error.details.provider_reference } : {}) } });
    }
    const retry = !attemptId && ['role_capacity_wait', 'first_receipt_wait', 'attempt_unresolved'].includes(code);
    const obsolete = code === 'review_already_recorded';
    await prisma.$transaction(async db => {
      const dispatch = await db.canvasRoleDispatch.findUniqueOrThrow({ where: { id: dispatchId } });
      const held = await db.canvasRoleDispatch.updateMany({ where: { id: dispatchId, lease_token: token, lease_epoch: epoch }, data: {
        state: retry ? 'queued' : obsolete ? 'cancelled' : 'held', due_at: new Date(Date.now() + 15000), last_error: code,
        lease_token: null, lease_owner: null, lease_until: null } });
      if (!retry && !obsolete && held.count) {
        const paused = await db.canvasRoleTaskRun.updateMany({ where: { id: dispatch.run_id, status: 'active', paused: false },
          data: { paused: true, revision: { increment: 1 } } });
        await db.canvasRoleRunControl.updateMany({ where: { run_id: dispatch.run_id, mode: 'automatic' }, data: {
          mode: 'paused', pause_reason: code, next_wake_at: null, revision: { increment: 1 } } });
        if (paused.count) await db.canvasRoleEvent.create({ data: { id: randomUUID(), role_task_run_id: dispatch.run_id,
          work_id: dispatch.work_id, requirements_revision: dispatch.requirements_revision, actor_user_id: user.id,
          actor_kind: 'system', kind: 'dispatch_held', detail_json: JSON.stringify({ dispatchId, code, resend: false }) } });
      }
    }, { timeout: 15000 });
    return;
  }
  await prisma.canvasRoleDispatch.updateMany({ where: { id: dispatchId, lease_token: token, lease_epoch: epoch }, data: {
    state: 'done', lease_token: null, lease_owner: null, lease_until: null } });
}

export async function reconcileAttempt(user: SessionUser, attemptId: string, options: { automatic?: boolean } = {}) {
  const attempt = await prisma.canvasRoleAttempt.findUnique({ where: { id: identifier(attemptId) } });
  if (!attempt) throw new RoleError('请求不存在', 404);
  const work = await prisma.canvasRoleWork.findUniqueOrThrow({ where: { id: attempt.work_id } });
  await ownedRun(prisma, user, work.role_task_run_id);
  if (attempt.settlement_applied || !attempt.provider_reference) return { attemptId, state: attempt.state, fee_state: attempt.fee_state, resend: false };
  const quote = JSON.parse(attempt.quote_json), contract: TextContract = quote.contract;
  const now = Date.now(), query = record(quote.billingQuery) ? quote.billingQuery : { count: 0, nextAt: 0 };
  if (Number(query.nextAt) > now || options.automatic && (Number(query.count) >= 32 || now - attempt.started_at.getTime() >= 86400000)) {
    return { attemptId, fee_state: attempt.fee_state, resend: false, reason: '保留待核费用，等待查询间隔或由本人查询原账单' };
  }
  const nextQuery = { count: Number(query.count) + 1,
    nextAt: now + (options.automatic ? Math.min(3600000, 10000 * 2 ** Math.min(Number(query.count), 9)) : 10000) };
  const claimed = await prisma.canvasRoleAttempt.updateMany({ where: { id: attempt.id, quote_json: attempt.quote_json, settlement_applied: false },
    data: { quote_json: JSON.stringify({ ...quote, billingQuery: nextQuery }) } });
  if (!claimed.count) return { attemptId, fee_state: attempt.fee_state, resend: false, reason: '原账单正在核对' };
  const charge = await readTextCharge(await getMuskApiSettings(), contract.scope, attempt.provider_reference, contract.model).catch(() => null);
  if (!charge) return { attemptId, state: attempt.state, fee_state: attempt.fee_state, resend: false, reason: '原文字账单未精确匹配，不报零、不重发' };
  const originalResult = attempt.result_json ? JSON.parse(attempt.result_json) : null;
  if (contract.version === 'role-text.v2' && !originalResult
    || charge.occurredAt < attempt.started_at.getTime() - 1000 || charge.occurredAt > (attempt.finished_at?.getTime() || Date.now()) + 300000
    || (originalResult && (originalResult.usage?.prompt_tokens !== charge.promptTokens
      || originalResult.usage?.completion_tokens !== charge.completionTokens))) {
    return { attemptId, state: attempt.state, fee_state: attempt.fee_state, resend: false, reason: '原账单时间或用量不对应本次请求，保留预留待核对' };
  }
  return prisma.$transaction(async db => {
    const current = await db.canvasRoleAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    const { run } = await ownedRun(db, user, work.role_task_run_id);
    if (current.settlement_applied) return { attemptId, fee_state: current.fee_state, resend: false };
    const actualCents = cashToPointCents(charge.amountMicros, contract.pointsPerUsd);
    if (actualCents > current.reserved_points || charge.amountMicros > current.reserved_usd_micros
      || run.budget_points_limit == null || run.budget_usd_micros_limit == null
      || run.settled_points + run.reserved_points - current.reserved_points + actualCents > run.budget_points_limit
      || run.settled_usd_micros + run.reserved_usd_micros - current.reserved_usd_micros + charge.amountMicros > run.budget_usd_micros_limit) {
      await db.canvasRoleAttempt.update({ where: { id: current.id }, data: {
        fee_state: 'authorization_required', settlement_receipt: JSON.stringify(charge),
      } });
      await db.canvasRoleTaskRun.update({ where: { id: run.id }, data: { paused: true, revision: { increment: 1 } } });
      await db.canvasRoleRunControl.updateMany({ where: { run_id: run.id }, data: { mode: 'paused', pause_reason: 'authorization_required',
        next_wake_at: null, revision: { increment: 1 } } });
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

export async function authorizeRoleSettlement(user: SessionUser, attemptId: string, body: JsonRecord) {
  const authorize = async (db: RoleDb) => {
    const attempt = await db.canvasRoleAttempt.findUnique({ where: { id: identifier(attemptId) } });
    if (!attempt) throw new RoleError('原请求不存在', 404);
    const work = await db.canvasRoleWork.findUniqueOrThrow({ where: { id: attempt.work_id } });
    return { ...await ownedRun(db, user, work.role_task_run_id), attempt };
  };
  return roleMutation(user, body, `role_settlement:${attemptId}`, authorize, async db => {
    const { run, attempt } = await authorize(db);
    if (integer(body.base_revision) !== run.revision) throw new RoleError('任务额度已变化，请重新核对', 409, 'revision_conflict');
    if (attempt.settlement_applied) return { objectId: run.id, result: { attemptId, fee_state: attempt.fee_state, resend: false } };
    if (attempt.fee_state !== 'authorization_required' || !attempt.settlement_receipt
      || body.receipt_digest !== digest(JSON.parse(attempt.settlement_receipt))) throw new RoleError('原账单缺失或已变化，请先查看原账单', 409, 'receipt_conflict');
    const quote = JSON.parse(attempt.quote_json), contract: TextContract = quote.contract;
    const charge = JSON.parse(attempt.settlement_receipt);
    const amountMicros = integer(charge.amountMicros, 0, 1_000_000_000), actualCents = cashToPointCents(amountMicros, contract.pointsPerUsd);
    const pointLimit = pointCents(body.authorized_total_points_limit), usdLimit = integer(body.authorized_total_usd_micros_limit, 0, 1_000_000_000);
    if (pointLimit < run.settled_points + run.reserved_points - attempt.reserved_points + actualCents
      || usdLimit < run.settled_usd_micros + run.reserved_usd_micros - attempt.reserved_usd_micros + amountMicros) throw new RoleError('确认总额度不足以覆盖原账单和其他待核预留', 409, 'budget_exceeded');
    const extra = Math.max(0, actualCents - attempt.reserved_points);
    let freezeSnapshot = quote.freezeSnapshot;
    if (extra > 0) {
      const freeze = await allocateTaskCredits(db, user, extra / 100, `role-attempt:${attempt.id}`);
      const original = JSON.parse(freezeSnapshot);
      if (!Array.isArray(original)) throw new RoleError('原冻结来源无效', 409, 'billing_conflict');
      freezeSnapshot = JSON.stringify([...original, ...freeze.allocations]);
      await db.creditLedger.create({ data: { user_id: user.id, type: 'task_freeze', amount: 0,
        balance_before: freeze.balance_before, balance_after: freeze.balance_after, frozen_before: freeze.frozen_before,
        frozen_after: freeze.frozen_after, related_task_id: `role-attempt:${attempt.id}`,
        idempotency_key: `role-extra-freeze:${attempt.id}`, reason: '本人确认原账单差额；不发送新请求',
        metadata_json: JSON.stringify({ allocations: freeze.allocations, receiptDigest: body.receipt_digest }) } });
    }
    const authorization = await db.canvasRoleEvent.create({ data: { id: randomUUID(), role_task_run_id: run.id,
      requirements_revision: run.requirements_revision, work_id: attempt.work_id, actor_user_id: user.id,
      actor_kind: 'person', kind: 'settlement_authorized', detail_json: JSON.stringify({ attemptId, receiptDigest: body.receipt_digest,
        originalReservedPoints: attempt.reserved_points / 100, actualPoints: actualCents / 100, extraPoints: extra / 100,
        actualUsdMicros: amountMicros, authorizedTotalPoints: pointLimit / 100, authorizedTotalUsdMicros: usdLimit,
        extraFreezeSnapshot: extra ? JSON.parse(freezeSnapshot).slice(JSON.parse(quote.freezeSnapshot).length) : [], providerCalls: 0 }) } });
    const settled = await settleTaskCredits(db, { taskId: `role-attempt:${attempt.id}`, userId: user.id, terminalStatus: 'succeeded',
      frozenAmount: (attempt.reserved_points + extra) / 100, freezeSnapshot, actualCost: actualCents / 100 });
    await db.creditLedger.create({ data: { user_id: user.id, type: 'task_success_deduct', amount: -actualCents / 100,
      balance_before: settled.balanceBefore, balance_after: settled.balanceAfter, frozen_before: settled.frozenBefore,
      frozen_after: settled.frozenAfter, related_task_id: `role-attempt:${attempt.id}`, idempotency_key: `role-settle:${attempt.id}`,
      reason: '本人确认差额后一次结算原请求', metadata_json: JSON.stringify({ authorizationEventId: authorization.id }) } });
    await db.canvasRoleAttempt.update({ where: { id: attempt.id }, data: { settlement_applied: true, fee_state: 'confirmed',
      settled_points: actualCents, settled_usd_micros: amountMicros } });
    await db.canvasRoleTaskRun.update({ where: { id: run.id }, data: { paused: true, budget_points_limit: pointLimit,
      budget_usd_micros_limit: usdLimit, reserved_points: { decrement: attempt.reserved_points },
      reserved_usd_micros: { decrement: attempt.reserved_usd_micros }, settled_points: { increment: actualCents },
      settled_usd_micros: { increment: amountMicros }, revision: { increment: 1 } } });
    await db.canvasRoleRunControl.updateMany({ where: { run_id: run.id }, data: { mode: 'paused', active_grant_id: null,
      pause_reason: 'settlement_confirmed_reauthorize', next_wake_at: null, revision: { increment: 1 } } });
    return { objectId: run.id, result: { attemptId, fee_state: 'confirmed', authorization_event_id: authorization.id, resend: false } };
  });
}
