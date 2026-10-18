import { randomUUID } from 'crypto';
import type { CanvasRoleTaskRun, CanvasRoleWork } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { assertLiveNode, assertRoleCollaborationWritable, ownedRun, type RoleDb } from './permissions';
import { roleMutation } from './repository';
import { event, latestWorks, taskRequirements, workInputDigest } from './work';
import { digest, identifier, integer, RoleError, text, type JsonRecord, type TaskRequirements } from './types';

export async function askRoleQuestion(db: RoleDb, user: SessionUser, run: CanvasRoleTaskRun, work: CanvasRoleWork,
  req: TaskRequirements, input: { targetNodeId: string | null; question: string; blocking: boolean }, attemptId?: string) {
  if (req.schema !== 'role.requirements.v2' || work.requirements_revision !== run.requirements_revision) throw new RoleError('问题须属于当前协作任务', 409, 'question_scope_conflict');
  const question = text(input.question, 16000, true), works = await latestWorks(db, run.id, run.requirements_revision);
  const target = input.targetNodeId ? works.find(w => w.node_id === identifier(input.targetNodeId)) : null;
  if (input.targetNodeId && (!target || target.id === work.id || !req.relations?.some(r =>
    (r.from === work.node_id && r.to === target.node_id) || (r.to === work.node_id && r.from === target.node_id)))) {
    throw new RoleError('请向本任务中有协作关系的另一岗位提问，或转交本人', 409, 'question_target_unavailable');
  }
  const inputDigest = workInputDigest(work, req), questionDigest = digest(question);
  const unique = { run_id: run.id, requirements_revision: run.requirements_revision, from_work_id: work.id,
    input_digest: inputDigest, question_digest: questionDigest };
  const prior = await db.canvasRoleQuestion.findUnique({ where: {
    run_id_requirements_revision_from_work_id_input_digest_question_digest: unique } });
  if (prior) {
    const count = prior.no_progress_count + 1;
    return db.canvasRoleQuestion.update({ where: { id: prior.id }, data: { no_progress_count: count,
      status: count >= 2 ? 'escalated' : prior.status, revision: { increment: 1 } } });
  }
  const created = await db.canvasRoleQuestion.create({ data: { id: randomUUID(), ...unique,
    target_work_id: target?.id, source_attempt_id: attemptId, blocking: input.blocking,
    body_json: JSON.stringify({ question, targetNodeId: target?.node_id || null }), status: target ? 'open' : 'escalated' } });
  await db.canvasRoleEvent.create({ data: { id: randomUUID(), role_task_run_id: run.id, requirements_revision: run.requirements_revision,
    work_id: work.id, from_node_id: work.node_id, to_node_id: target?.node_id,
    actor_kind: attemptId ? 'ai' : 'person', actor_user_id: user.id, kind: 'question_opened',
    detail_json: JSON.stringify({ questionId: created.id, question, blocking: input.blocking, attemptId: attemptId || null }) } });
  return created;
}

export async function answerRoleQuestion(db: RoleDb, user: SessionUser, questionId: string, answer: string,
  actor?: { work: CanvasRoleWork; attemptId: string }) {
  const question = await db.canvasRoleQuestion.findUniqueOrThrow({ where: { id: questionId } });
  const { run } = await ownedRun(db, user, question.run_id, true);
  if (question.requirements_revision !== run.requirements_revision || !['open', 'answering', 'escalated'].includes(question.status)) {
    throw new RoleError('问题已回答或不属于当前要求，请读取最新状态', 409, 'question_conflict');
  }
  if (actor && (actor.work.id !== question.target_work_id || actor.work.requirements_revision !== run.requirements_revision)) throw new RoleError('答复者与指定岗位不一致', 403, 'question_actor_mismatch');
  const content = text(answer, 16000, true);
  const entry = await db.canvasRoleEvent.create({ data: { id: randomUUID(), role_task_run_id: run.id,
    requirements_revision: run.requirements_revision, work_id: question.from_work_id, actor_user_id: user.id,
    actor_kind: actor ? 'ai' : 'person', kind: 'question_answered', from_node_id: actor?.work.node_id,
    detail_json: JSON.stringify({ questionId, text: content, attemptId: actor?.attemptId || null,
      attribution: actor ? 'assigned_role' : 'owner_answer', resolved: false }) } });
  const changed = await db.canvasRoleQuestion.updateMany({ where: { id: question.id, revision: question.revision },
    data: { status: 'answered', answer_event_id: entry.id, exchange_count: { increment: 1 }, revision: { increment: 1 } } });
  if (!changed.count) throw new RoleError('问题已更新，请重读', 409, 'revision_conflict');
  await db.canvasRoleRunControl.update({ where: { run_id: run.id }, data: { next_wake_at: new Date() } });
  return { question: await db.canvasRoleQuestion.findUniqueOrThrow({ where: { id: question.id } }), event: entry };
}

export async function resolveRoleQuestion(db: RoleDb, user: SessionUser, questionId: string,
  actor?: { work: CanvasRoleWork; attemptId: string }) {
  const question = await db.canvasRoleQuestion.findUniqueOrThrow({ where: { id: identifier(questionId) } });
  const { run } = await ownedRun(db, user, question.run_id, true);
  if (question.requirements_revision !== run.requirements_revision || question.status !== 'answered') throw new RoleError('仅已回答的当前问题可确认解决', 409, 'question_conflict');
  if (actor && question.from_work_id !== actor.work.id) throw new RoleError('只有原提问岗位可确认解决', 403, 'question_actor_mismatch');
  const entry = await db.canvasRoleEvent.create({ data: { id: randomUUID(), role_task_run_id: run.id,
    requirements_revision: run.requirements_revision, work_id: question.from_work_id, actor_user_id: user.id,
    actor_kind: actor ? 'ai' : 'person', kind: 'question_resolved', detail_json: JSON.stringify({ questionId,
      answerEventId: question.answer_event_id, attemptId: actor?.attemptId || null, confirmedByOwner: !actor }) } });
  await db.canvasRoleQuestion.update({ where: { id: question.id }, data: { status: 'resolved', resolution_event_id: entry.id, revision: { increment: 1 } } });
  return { question: await db.canvasRoleQuestion.findUniqueOrThrow({ where: { id: question.id } }), event: entry };
}

export async function createRoleQuestion(user: SessionUser, runId: string, body: JsonRecord) {
  return roleMutation(user, body, `question_create:${identifier(runId)}`, db => ownedRun(db, user, runId, true), async db => {
    assertRoleCollaborationWritable();
    const { run, document } = await ownedRun(db, user, runId, true);
    if (integer(body.requirements_revision) !== run.requirements_revision) throw new RoleError('要求已变化，请保留输入后重读', 409, 'revision_conflict');
    const works = await latestWorks(db, run.id, run.requirements_revision);
    const work = works.find(w => w.id === identifier(body.from_work_id));
    if (!work) throw new RoleError('问题来源工作已失效', 409, 'work_superseded');
    assertLiveNode(work, document.document_json);
    const target = body.target_work_id ? works.find(w => w.id === identifier(body.target_work_id)) : null;
    if (body.target_work_id && !target) throw new RoleError('接收工作已失效', 409, 'recipient_unavailable');
    if (target) assertLiveNode(target, document.document_json);
    const question = await askRoleQuestion(db, user, run, work, await taskRequirements(db, run.id, run.requirements_revision), {
      targetNodeId: target?.node_id || null, question: text(body.question, 16000, true), blocking: body.blocking === true });
    return { objectId: run.id, result: { question, author: 'owner', acted_as_ai: false } };
  });
}

export async function actOnRoleQuestion(user: SessionUser, questionId: string, body: JsonRecord) {
  const authorize = async (db: RoleDb) => {
    const question = await db.canvasRoleQuestion.findUnique({ where: { id: identifier(questionId) } });
    if (!question) throw new RoleError('问题不存在', 404, 'question_not_found');
    return ownedRun(db, user, question.run_id, true);
  };
  return roleMutation(user, body, `question_action:${questionId}`, authorize, async db => {
    assertRoleCollaborationWritable();
    const { run } = await authorize(db);
    const question = await db.canvasRoleQuestion.findUniqueOrThrow({ where: { id: questionId } });
    if (integer(body.base_revision) !== question.revision || integer(body.requirements_revision) !== run.requirements_revision
      || question.requirements_revision !== run.requirements_revision) throw new RoleError('问题版本已变化，请保留输入并重读', 409, 'revision_conflict');
    if (body.action === 'answer') return { objectId: run.id, result: await answerRoleQuestion(db, user, question.id, text(body.text, 16000, true)) };
    if (body.action === 'resolve') return { objectId: run.id, result: await resolveRoleQuestion(db, user, question.id) };
    if (!['escalate', 'cancel'].includes(String(body.action)) || ['resolved', 'cancelled'].includes(question.status)) throw new RoleError('当前问题不支持此操作', 409, 'question_conflict');
    const updated = await db.canvasRoleQuestion.update({ where: { id: question.id }, data: {
      status: body.action === 'cancel' ? 'cancelled' : 'escalated', revision: { increment: 1 } } });
    const entry = await event(db, user, run.id, run.requirements_revision, `question_${updated.status}`, question.from_work_id, { questionId: question.id, text: text(body.text, 16000) });
    return { objectId: run.id, result: { question: updated, event: entry } };
  });
}
