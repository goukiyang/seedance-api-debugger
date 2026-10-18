import { randomUUID } from 'crypto';
import type { CanvasRoleTaskRun, CanvasRoleWork } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { getMuskApiSettings, isMuskApiReady } from '@/lib/integrations/musk';
import { assertLiveNode, assertRoleCollaborationWritable, ownedRun, roleAccountFingerprint, type RoleDb } from './permissions';
import { roleMutation } from './repository';
import { assertCurrentMaterials, assertEffectiveInputs, event, latestWorks, refreshInputs, taskRequirements, updateTaskRun, workInputDigest } from './work';
import { acceptRoleResult, reviseCollaborationWork, refreshResultManifest } from './results';
import { createRoleTextContract, readRoleTextPolicy, reserveRolePointCents } from './text-billing';
import { textScope } from './text-provider';
import { assertRolePrepared, digest, identifier, integer, pointCents, record, roleRunView, RoleError, text,
  type JsonRecord, type RoleGrant, type RoleSnapshot, type TaskRequirements } from './types';

type StoredGrant = RoleGrant & { accountFingerprint: string };
export async function currentRoleGrant(db: RoleDb, user: SessionUser, run: CanvasRoleTaskRun, req: TaskRequirements) {
  assertRoleCollaborationWritable();
  const control = await db.canvasRoleRunControl.findUnique({ where: { run_id: run.id } });
  const authorization = control?.active_grant_id && await db.canvasRoleAuthorization.findUnique({ where: { id: control.active_grant_id } });
  if (!control || !authorization || authorization.run_id !== run.id || authorization.requirements_revision !== run.requirements_revision
    || authorization.expires_at.getTime() <= Date.now()) throw new RoleError('本次授权已失效，请确认范围后重新授权', 409, 'authorization_required');
  const grant: StoredGrant = JSON.parse(authorization.snapshot_json);
  if (digest(grant) !== authorization.snapshot_digest || grant.requirementsDigest !== digest(req)
    || grant.requirementsRevision !== run.requirements_revision || grant.accountFingerprint !== await roleAccountFingerprint(db, user)) {
    throw new RoleError('任务或账号范围已变化，请重新授权', 409, 'authorization_changed');
  }
  return { control, authorization, grant };
}

async function buildGrant(db: RoleDb, user: SessionUser, run: CanvasRoleTaskRun, req: TaskRequirements, documentJson: string, body: JsonRecord) {
  if (!req.goal || !req.criteria || !req.finalNodeId || !req.participants.some(p => p.participation === 'required' && p.nodeId === req.finalNodeId)) {
    throw new RoleError('开始前请补齐目标、验收要求及必交的最终岗位', 409, 'requirements_incomplete');
  }
  const works = await latestWorks(db, run.id, run.requirements_revision);
  await assertCurrentMaterials(db, user, documentJson, req);
  const executors: RoleGrant['executors'] = [];
  for (const p of req.participants.filter(p => p.participation !== 'excluded')) {
    const work = works.find(w => w.node_id === p.nodeId);
    if (!work || !p.assignment || !p.deliverableItems?.length || !p.acceptanceCriteria) throw new RoleError('请补齐每个参与岗位的本次分工、交付和验收标准', 409, 'assignment_incomplete');
    assertLiveNode(work, documentJson);
    const role: RoleSnapshot = JSON.parse(work.snapshot_json).role;
    assertRolePrepared(role);
    if (role.executor.kind === 'unassigned') throw new RoleError('请为参与岗位指定本人或AI执行者', 409, 'executor_unavailable');
    if (role.executor.kind === 'ai' && (!role.tools.includes('text') || !role.executor.model)) throw new RoleError('参与AI岗位没有可用文字能力', 409, 'text_executor_unavailable');
    executors.push({ nodeId: work.node_id, roleVersionId: work.role_version_id, roleDigest: digest(role),
      model: role.executor.kind === 'ai' ? role.executor.model! : null, purposes: ['work', 'answer',
        ...(req.relations?.some(r => r.type === 'review' && r.to === work.node_id) ? ['review' as const] : [])] });
  }
  const settings = await getMuskApiSettings(db), policy = await readRoleTextPolicy(db, settings);
  const hasText = executors.some(e => e.model);
  if (hasText && (!isMuskApiReady(settings) || new URL(settings.base_url).origin !== 'https://api.muskapis.com'
    || !policy?.enabled || !policy.allowUnpricedText || executors.some(e => e.model && !policy.allowedModels.includes(e.model)))) {
    throw new RoleError('角色文字尚未启用或所选模型未获管理员允许，请管理员核对角色文字设置', 409, 'role_text_policy_disabled');
  }
  const pointLimit = pointCents(body.budget_points_limit), usdMicrosLimit = integer(body.budget_usd_micros_limit, 0, 1_000_000_000);
  const maxCalls = integer(body.max_calls, hasText ? 1 : 0, 1000), maxRounds = integer(body.max_rounds ?? 3, 1, 100);
  const available = usdMicrosLimit - run.settled_usd_micros - run.reserved_usd_micros;
  const calls = maxCalls - run.call_count;
  const reserveUsdMicros = hasText ? integer(body.reserve_usd_micros ?? Math.floor(available / Math.max(calls, 1)), 1, 1_000_000_000) : 0;
  const reservePointCents = hasText ? reserveRolePointCents(reserveUsdMicros) : 0;
  if (available < reserveUsdMicros || calls < (hasText ? 1 : 0) || pointLimit < run.settled_points + run.reserved_points + reservePointCents
    || maxRounds < Math.max(1, ...works.map(w => w.round))) throw new RoleError('授权额度不足以覆盖已用、待核费用和下一次预留', 409, 'budget_exceeded');
  const mediaRaw = body.media ?? [];
  if (!Array.isArray(mediaRaw) || mediaRaw.length > 30) throw new RoleError('媒体授权范围无效');
  const media: RoleGrant['media'] = mediaRaw.map(item => {
    if (!record(item) || !['image', 'video'].includes(String(item.kind))) throw new RoleError('媒体类型无效');
    const maxPoints = pointCents(item.maxPoints) / 100;
    if (!maxPoints || maxPoints * 100 > pointLimit) throw new RoleError('媒体限额须在本次总点数以内');
    return { kind: item.kind as 'image' | 'video', model: text(item.model, 120, true),
      providerId: item.providerId == null ? null : text(item.providerId, 160, true), maxPoints };
  });
  return { schema: 'role.authorization.v2', requirementsRevision: run.requirements_revision, requirementsDigest: digest(req),
    accountFingerprint: await roleAccountFingerprint(db, user), scope: textScope(settings), policyRevision: policy?.revision || 0,
    pointsPerUsd: 35, reserveUsdMicros, reservePointCents, maxInputBytes: policy?.maxInputBytes || 32768,
    maxOutputTokens: policy?.maxOutputTokens || 2048, pointLimit, usdMicrosLimit, maxCalls, maxRounds, executors, media,
    confirmationNodes: req.participants.filter(p => p.confirmRequired).map(p => p.nodeId),
    expiresAt: new Date(Date.now() + integer(body.expires_in_seconds ?? 86400, 60, 86400) * 1000).toISOString() } as StoredGrant;
}

export async function enqueueRoleDispatch(db: RoleDb, user: SessionUser, run: CanvasRoleTaskRun, work: CanvasRoleWork,
  req: TaskRequirements, purpose: 'work' | 'answer' | 'review', executor: CanvasRoleWork, trigger: JsonRecord = {}) {
  const { authorization, grant, control } = await currentRoleGrant(db, user, run, req);
  if (run.paused || run.status !== 'active' || control.mode !== 'automatic') throw new RoleError('本次任务未在协作中', 409, 'run_paused');
  const allowed = grant.executors.find(e => e.nodeId === executor.node_id && e.roleVersionId === executor.role_version_id
    && e.roleDigest === digest(JSON.parse(executor.snapshot_json).role) && e.purposes.includes(purpose));
  if (!allowed?.model) throw new RoleError('执行者或用途不在本次AI授权内', 403, 'executor_not_authorized');
  const { document } = await ownedRun(db, user, run.id, true);
  assertLiveNode(work, document.document_json); assertLiveNode(executor, document.document_json);
  const inputDigest = workInputDigest(work, req);
  const payload = { purpose, executorWorkId: executor.id, workRevision: work.revision,
    executorRevision: executor.revision, inputDigest, ...trigger };
  const dedupeKey = digest({ revision: run.requirements_revision, workId: work.id, grantId: authorization.id,
    purpose, executorWorkId: executor.id, inputDigest, ...trigger,
    ...(purpose === 'work' ? { workRevision: work.revision, executorRevision: executor.revision } : {}) });
  return db.canvasRoleDispatch.upsert({ where: { run_id_dedupe_key: { run_id: run.id, dedupe_key: dedupeKey } }, update: {},
    create: { id: randomUUID(), run_id: run.id, work_id: work.id, grant_id: authorization.id,
      requirements_revision: run.requirements_revision, action: purpose, target_key: work.id,
      dedupe_key: dedupeKey, payload_json: JSON.stringify(payload), due_at: new Date() } });
}

export async function planRoleDispatches(db: RoleDb, user: SessionUser, runId: string) {
  const { run } = await ownedRun(db, user, runId, true);
  const req = await taskRequirements(db, run.id, run.requirements_revision);
  if (req.schema !== 'role.requirements.v2' || run.paused || run.status !== 'active') return [];
  await currentRoleGrant(db, user, run, req);
  await refreshInputs(db, user, run.id, run.requirements_revision, req);
  await refreshResultManifest(db, user, run, req);
  const fresh = await db.canvasRoleTaskRun.findUniqueOrThrow({ where: { id: run.id } });
  if (fresh.status !== 'active') return [];
  const works = await latestWorks(db, run.id, run.requirements_revision);
  const questions = await db.canvasRoleQuestion.findMany({ where: { run_id: run.id, requirements_revision: run.requirements_revision,
    status: { notIn: ['resolved', 'cancelled'] } }, take: 501 });
  if (questions.length > 500) throw new RoleError('当前问题过多，请本人整理后继续', 409, 'question_limit');
  const queued = [];
  for (const question of questions.filter(q => q.status === 'open' && q.target_work_id)) {
    const target = works.find(w => w.id === question.target_work_id);
    if (target && JSON.parse(target.snapshot_json).role.executor.kind === 'ai') queued.push(await enqueueRoleDispatch(db, user, fresh, target, req,
      'answer', target, { questionId: question.id, questionRevision: question.revision }));
  }
  for (const work of works) {
    if (work.phase === 'review') {
      const events = await db.canvasRoleEvent.findMany({ where: { work_id: work.id, delivery_id: work.current_delivery_id,
        kind: 'collaboration_review' }, select: { detail_json: true }, take: 501 });
      for (const relation of req.relations?.filter(r => r.type === 'review' && r.from === work.node_id) || []) {
        if (events.some(e => JSON.parse(e.detail_json).relationId === relation.id)) continue;
        const reviewer = works.find(w => w.node_id === relation.to);
        if (reviewer && JSON.parse(reviewer.snapshot_json).role.executor.kind === 'ai') queued.push(await enqueueRoleDispatch(db, user, fresh, work, req,
          'review', reviewer, { relationId: relation.id, deliveryId: work.current_delivery_id }));
      }
      continue;
    }
    if (!['offered', 'ready', 'revision', 'working'].includes(work.phase) || JSON.parse(work.snapshot_json).role.executor.kind !== 'ai') continue;
    const blocked = questions.filter(q => q.from_work_id === work.id && q.blocking);
    if (blocked.some(q => q.status !== 'answered')) continue;
    if (await db.canvasRoleAttempt.count({ where: { work_id: work.id, OR: [{ state: { in: ['reserved', 'sending', 'unknown'] } },
      { fee_state: { in: ['pending', 'unknown', 'authorization_required'] } }] } })) continue;
    queued.push(await enqueueRoleDispatch(db, user, fresh, work, req, 'work', work,
      { answers: blocked.map(q => ({ id: q.id, revision: q.revision, eventId: q.answer_event_id })) }));
  }
  return queued.map(row => row.id);
}

export async function queueRoleExecution(user: SessionUser, workId: string, body: JsonRecord) {
  assertRoleCollaborationWritable();
  const authorize = async (db: RoleDb) => {
    const work = await db.canvasRoleWork.findUnique({ where: { id: workId } });
    if (!work) throw new RoleError('工作不存在', 404);
    return { ...await ownedRun(db, user, work.role_task_run_id, true), work };
  };
  return roleMutation(user, body, `role_execute:${workId}`, authorize, async db => {
    const { run, work } = await authorize(db);
    if (integer(body.base_revision) !== work.revision || integer(body.requirements_revision) !== run.requirements_revision
      || work.requirements_revision !== run.requirements_revision) throw new RoleError('工作版本已变化', 409, 'revision_conflict');
    const req = await taskRequirements(db, run.id, run.requirements_revision);
    if (body.purpose !== 'work') throw new RoleError('检查由当前关系和指定检查者排队，请打开本次工作', 409, 'review_use_current_relation');
    const dispatch = await enqueueRoleDispatch(db, user, run, work, req, 'work', work);
    return { objectId: work.id, result: { dispatchId: dispatch.id, workId, state: dispatch.state, queued: true } };
  });
}

export async function controlRoleRun(user: SessionUser, runId: string, body: JsonRecord) {
  assertRoleCollaborationWritable(); identifier(runId);
  if (body.action === 'apply_revision') return updateTaskRun(user, runId, { ...body, apply_current: true });
  return roleMutation(user, body, `role_control:${runId}`, db => ownedRun(db, user, runId, true), async db => {
    const { run, document } = await ownedRun(db, user, runId, true);
    const control = await db.canvasRoleRunControl.findUnique({ where: { run_id: run.id } });
    if (!control) throw new RoleError('旧任务使用原工作操作', 409, 'legacy_role_run');
    if (integer(body.base_revision) !== run.revision || integer(body.requirements_revision) !== run.requirements_revision
      || integer(body.control_revision) !== control.revision) throw new RoleError('任务状态已变化，请核对当前状态', 409, 'revision_conflict');
    const req = await taskRequirements(db, run.id, run.requirements_revision);
    const action = String(body.action); let queued: string[] = [];
    if (run.status === 'cancelled') throw new RoleError('此任务已取消，只能查看历史', 409, 'run_cancelled');
    if (action === 'accept_result') await acceptRoleResult(db, user, run, body);
    else if (action === 'reject_result') {
      if (body.manifest_event_id !== control.current_manifest_event_id || !control.current_manifest_event_id) throw new RoleError('成果版本已变', 409, 'manifest_conflict');
      const final = (await latestWorks(db, run.id, run.requirements_revision)).find(w => w.node_id === req.finalNodeId);
      if (!final) throw new RoleError('整合稿不存在', 409);
      await reviseCollaborationWork(db, user, run, final, req, text(body.reason, 16000, true), document.document_json);
    } else if (['pause', 'revoke_authorization', 'cancel'].includes(action)) {
      await db.canvasRoleTaskRun.update({ where: { id: run.id }, data: { paused: true,
        ...(action === 'cancel' ? { status: 'cancelled' } : {}), revision: { increment: 1 } } });
      await db.canvasRoleRunControl.update({ where: { run_id: run.id }, data: { mode: action === 'cancel' ? 'cancelled' : 'paused',
        pause_reason: action, next_wake_at: null, ...(action !== 'pause' ? { active_grant_id: null } : {}), revision: { increment: 1 } } });
      await db.canvasRoleDispatch.updateMany({ where: { run_id: run.id, state: { in: ['queued', 'held'] } },
        data: { state: 'cancelled', last_error: action } });
      await event(db, user, run.id, run.requirements_revision, action, null, { originalRequestsRetained: true });
    } else if (['authorize', 'start', 'resume'].includes(action)) {
      if (['delivered', 'ready_for_acceptance'].includes(run.status)) throw new RoleError('请先查看成果或明确修订，不能重新开始旧任务', 409, 'phase_conflict');
      if (action === 'authorize') {
        const grant = await buildGrant(db, user, run, req, document.document_json, body);
        const consent = await event(db, user, run.id, run.requirements_revision, 'task_authorized', null,
          { pointLimit: grant.pointLimit / 100, usdMicrosLimit: grant.usdMicrosLimit, maxCalls: grant.maxCalls,
            maxRounds: grant.maxRounds, reserveUsdMicros: grant.reserveUsdMicros, reservePoints: grant.reservePointCents / 100,
            pointsPerUsd: 35, expiresAt: grant.expiresAt, reserveIsNotPrice: true });
        const authorization = await db.canvasRoleAuthorization.create({ data: { id: randomUUID(), run_id: run.id,
          sequence: (await db.canvasRoleAuthorization.count({ where: { run_id: run.id } })) + 1,
          requirements_revision: run.requirements_revision, consent_event_id: consent.id, snapshot_json: JSON.stringify(grant),
          snapshot_digest: digest(grant), granted_by: user.id, expires_at: new Date(grant.expiresAt) } });
        await db.canvasRoleTaskRun.update({ where: { id: run.id }, data: { budget_points_limit: grant.pointLimit,
          budget_usd_micros_limit: grant.usdMicrosLimit, max_calls: grant.maxCalls, max_rounds: grant.maxRounds, revision: { increment: 1 } } });
        await db.canvasRoleRunControl.update({ where: { run_id: run.id }, data: { active_grant_id: authorization.id,
          revision: { increment: 1 } } });
        await db.canvasRoleDispatch.updateMany({ where: { run_id: run.id, state: { in: ['queued', 'held'] } }, data: { state: 'cancelled', last_error: 'reauthorized' } });
      }
      if (action !== 'authorize' || body.start === true) {
        const current = await db.canvasRoleTaskRun.findUniqueOrThrow({ where: { id: run.id } });
        const { grant } = await currentRoleGrant(db, user, current, req);
        const settings = await getMuskApiSettings(db), policy = await readRoleTextPolicy(db, settings);
        for (const executor of grant.executors) if (executor.model) {
          if (!policy) throw new RoleError('角色文字政策未就绪', 409, 'role_text_policy_disabled');
          createRoleTextContract(policy, grant, (await db.canvasRoleRunControl.findUniqueOrThrow({ where: { run_id: run.id } })).active_grant_id!, executor.model);
        }
        await db.canvasRoleTaskRun.update({ where: { id: run.id }, data: { status: 'active', paused: false, revision: { increment: 1 } } });
        await db.canvasRoleRunControl.update({ where: { run_id: run.id }, data: { mode: 'automatic', pause_reason: null,
          next_wake_at: new Date(), revision: { increment: 1 } } });
        await event(db, user, run.id, run.requirements_revision, action === 'resume' ? 'resumed' : 'started', null, { queuedOnly: true });
        queued = await planRoleDispatches(db, user, run.id);
      }
    } else throw new RoleError('任务控制动作无效');
    return { objectId: run.id, result: { run: roleRunView(await db.canvasRoleTaskRun.findUniqueOrThrow({ where: { id: run.id } })),
      control: await db.canvasRoleRunControl.findUniqueOrThrow({ where: { run_id: run.id } }), queued } };
  });
}
