import { randomUUID } from 'crypto';
import type { CanvasRoleTaskRun, CanvasRoleWork } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { assertDeliveryOriginals } from './media';
import { assertLiveNode, assertRoleCollaborationWritable, ownedDefinition, ownedRun, type RoleDb } from './permissions';
import { roleMutation } from './repository';
import { assertCurrentMaterials, assertEffectiveInputs, event, latestWorks, makeWork, participant, taskRequirements, workInputDigest } from './work';
import { digest, identifier, integer, record, roleSnapshot, RoleError, text, type JsonRecord, type RoleSnapshot, type TaskRequirements } from './types';

export function deliveryPhase(work: CanvasRoleWork, req: TaskRequirements) {
  if (req.schema !== 'role.requirements.v2') return work.reviewer_node_id ? 'review' : work.confirm_required ? 'confirmation' : 'delivered';
  return req.relations?.some(r => r.type === 'review' && r.from === work.node_id) ? 'review' : work.confirm_required ? 'confirmation' : 'delivered';
}

export async function refreshResultManifest(db: RoleDb, user: SessionUser, run: CanvasRoleTaskRun, req: TaskRequirements) {
  const control = await db.canvasRoleRunControl.findUnique({ where: { run_id: run.id } });
  if (!control || run.status === 'cancelled') return null;
  const works = await latestWorks(db, run.id, run.requirements_revision);
  const needed = new Set([...req.participants.filter(p => p.participation === 'required').map(p => p.nodeId), req.finalNodeId]);
  if (!req.finalNodeId || Array.from(needed).some(id => !works.some(w => w.node_id === id && w.phase === 'delivered' && w.current_delivery_id))) return null;
  if (await db.canvasRoleQuestion.count({ where: { run_id: run.id, requirements_revision: run.requirements_revision, blocking: true,
    status: { notIn: ['resolved', 'cancelled'] } } })) return null;
  const { document } = await ownedRun(db, user, run.id);
  await assertCurrentMaterials(db, user, document.document_json, req);
  const deliveries: JsonRecord[] = [], changes: JsonRecord[] = [];
  for (const work of works.filter(w => w.phase === 'delivered' && w.current_delivery_id)) {
    assertLiveNode(work, document.document_json);
    await assertEffectiveInputs(db, work, req, document.document_json, user);
    const delivery = await db.canvasRoleDelivery.findUniqueOrThrow({ where: { id: work.current_delivery_id! } });
    if (delivery.input_digest !== workInputDigest(work, req)) throw new RoleError('成果输入已变化，请先更新相应工作', 409, 'input_conflict');
    const content = JSON.parse(delivery.content_json);
    await assertDeliveryOriginals(db, user, content);
    deliveries.push({ workId: work.id, nodeId: work.node_id, deliveryId: delivery.id, version: delivery.version,
      contentDigest: digest(content), inputDigest: delivery.input_digest, originals: content.attachments || [],
      acceptanceCriteria: participant(req, work.node_id).acceptanceCriteria || req.criteria });
    const source = JSON.parse(work.snapshot_json).revisionSource;
    if (source) changes.push({ workId: work.id, sourceDeliveryId: source.deliveryId, opinion: source.opinion,
      response: content.changes || null, currentDeliveryId: delivery.id });
  }
  const manifest = { requirementsRevision: run.requirements_revision, requirementsDigest: digest(req),
    finalDeliveryId: works.find(w => w.node_id === req.finalNodeId)!.current_delivery_id,
    deliveries, criteria: req.criteria, changes };
  const manifestDigest = digest(manifest);
  const old = control.current_manifest_event_id ? await db.canvasRoleEvent.findUnique({ where: { id: control.current_manifest_event_id } }) : null;
  if (old && JSON.parse(old.detail_json).digest === manifestDigest) return { ...manifest, digest: manifestDigest, eventId: old.id };
  const entry = await event(db, user, run.id, run.requirements_revision, 'result_manifest', null, { ...manifest, digest: manifestDigest });
  await db.canvasRoleRunControl.update({ where: { run_id: run.id }, data: { current_manifest_event_id: entry.id,
    acceptance_event_id: null, revision: { increment: 1 } } });
  await db.canvasRoleTaskRun.update({ where: { id: run.id }, data: { status: 'ready_for_acceptance', revision: { increment: 1 } } });
  return { ...manifest, digest: manifestDigest, eventId: entry.id };
}

export async function acceptRoleResult(db: RoleDb, user: SessionUser, run: CanvasRoleTaskRun, body: JsonRecord) {
  const req = await taskRequirements(db, run.id, run.requirements_revision);
  const manifest = await refreshResultManifest(db, user, run, req);
  if (!manifest || body.manifest_event_id !== manifest.eventId || body.manifest_digest !== manifest.digest) {
    throw new RoleError('当前成果未齐或版本已变化，请打开本次成果后确认', 409, 'manifest_conflict');
  }
  const accepted = await event(db, user, run.id, run.requirements_revision, 'owner_result_accepted', null,
    { manifestEventId: manifest.eventId, manifestDigest: manifest.digest, feeCleared: run.reserved_points === 0 && run.reserved_usd_micros === 0 });
  await db.canvasRoleRunControl.update({ where: { run_id: run.id }, data: { acceptance_event_id: accepted.id,
    mode: 'completed', active_grant_id: null, next_wake_at: null, revision: { increment: 1 } } });
  await db.canvasRoleDispatch.updateMany({ where: { run_id: run.id, state: 'queued' }, data: { state: 'cancelled', last_error: 'owner_accepted' } });
  await db.canvasRoleTaskRun.update({ where: { id: run.id }, data: { status: 'delivered', revision: { increment: 1 } } });
  return accepted;
}

export async function reviseCollaborationWork(db: RoleDb, user: SessionUser, run: CanvasRoleTaskRun, work: CanvasRoleWork,
  req: TaskRequirements, opinion: string, documentJson: string) {
  if (work.round >= run.max_rounds) throw new RoleError('已到本次修订上限，请明确调整授权', 409, 'round_limit');
  const original = work.current_delivery_id && await db.canvasRoleDelivery.findUnique({ where: { id: work.current_delivery_id } });
  if (!original || original.work_id !== work.id) throw new RoleError('原稿不可用，不能以草稿代替', 409, 'delivery_conflict');
  const content = JSON.parse(original.content_json);
  let successor = await makeWork(db, user, run.id, run.requirements_revision, participant(req, work.node_id), documentJson, work.round + 1, work);
  successor = await db.canvasRoleWork.update({ where: { id: successor.id }, data: { phase: 'revision', inputs_json: work.inputs_json,
    wait_reason: opinion, draft_text: content.text || '', snapshot_json: JSON.stringify({ ...JSON.parse(successor.snapshot_json),
      draftContent: content, revisionSource: { deliveryId: original.id, opinion, readonly: true } }) } });
  await db.canvasRoleWork.update({ where: { id: work.id }, data: { phase: 'superseded', revision: { increment: 1 } } });
  const before = (await latestWorks(db, run.id, run.requirements_revision)).filter(w => w.id !== successor.id);
  const affected = new Set([work.node_id]);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const target of before) if (!affected.has(target.node_id)
      && (JSON.parse(target.inputs_json) as JsonRecord[]).some(input => affected.has(String(input.nodeId)))) {
      affected.add(target.node_id); expanded = true;
    }
  }
  for (const target of before.filter(w => affected.has(w.node_id) && w.node_id !== work.node_id)) {
    if (target.round >= run.max_rounds) throw new RoleError('已采用原稿的下游达到修订上限，请明确调整任务', 409, 'round_limit');
    await db.canvasRoleWork.update({ where: { id: target.id }, data: { phase: 'superseded', revision: { increment: 1 } } });
    await makeWork(db, user, run.id, run.requirements_revision, participant(req, target.node_id), documentJson, target.round + 1, target);
    await event(db, user, run.id, run.requirements_revision, 'upstream_revision', target.id, { sourceDeliveryId: original.id, lateResponsesRetained: true });
  }
  await db.canvasRoleDispatch.updateMany({ where: { run_id: run.id, work_id: { in: [work.id, ...before.filter(w => affected.has(w.node_id)).map(w => w.id)] },
    attempt_id: null, state: { in: ['queued', 'leased', 'held'] } }, data: { state: 'cancelled', last_error: 'work_revised' } });
  await db.canvasRoleQuestion.updateMany({ where: { from_work_id: { in: [work.id, ...before.filter(w => affected.has(w.node_id)).map(w => w.id)] },
    status: { notIn: ['resolved', 'cancelled'] } }, data: { status: 'cancelled', revision: { increment: 1 } } });
  await db.canvasRoleTaskRun.update({ where: { id: run.id }, data: { status: 'active', revision: { increment: 1 } } });
  await db.canvasRoleRunControl.update({ where: { run_id: run.id }, data: { current_manifest_event_id: null,
    acceptance_event_id: null, next_wake_at: new Date(), revision: { increment: 1 } } });
  return successor;
}

export async function applyCollaborationReview(db: RoleDb, user: SessionUser, run: CanvasRoleTaskRun, work: CanvasRoleWork,
  req: TaskRequirements, body: JsonRecord, actor?: { work: CanvasRoleWork; attemptId: string }) {
  const { document } = await ownedRun(db, user, run.id, true);
  if (body.delivery_id !== work.current_delivery_id || body.input_digest !== workInputDigest(work, req)) throw new RoleError('这是旧稿的检查，请打开当前成果', 409, 'delivery_conflict');
  if (!['review', 'confirmation', 'delivered'].includes(work.phase)) throw new RoleError('当前没有可检查成果', 409, 'phase_conflict');
  await assertEffectiveInputs(db, work, req, document.document_json, user);
  const delivery = await db.canvasRoleDelivery.findUniqueOrThrow({ where: { id: work.current_delivery_id! } });
  await assertDeliveryOriginals(db, user, JSON.parse(delivery.content_json));
  const action = String(body.action), opinion = text(body.opinion, 16000, ['return', 'revise'].includes(action));
  let relationId: string | null = null, reviewerNodeId: string | null = null;
  if (action === 'confirm') {
    if (actor || work.phase !== 'confirmation') throw new RoleError('此确认只交本人处理', 403, 'owner_confirmation_required');
  } else if (action === 'revise') {
    if (actor || work.phase !== 'delivered') throw new RoleError('请由本人对当前已交付稿提出修订', 409, 'phase_conflict');
  } else if (work.phase === 'review') {
    const reviewerId = actor?.work.node_id || identifier(body.reviewer_node_id);
    const relation = req.relations?.find(r => r.type === 'review' && r.from === work.node_id && r.to === reviewerId);
    const reviewer = actor?.work || (await latestWorks(db, run.id, run.requirements_revision)).find(w => w.node_id === reviewerId);
    if (!relation || !reviewer) throw new RoleError('没有对应的检查关系', 403, 'reviewer_unavailable');
    assertLiveNode(reviewer, document.document_json);
    const role: RoleSnapshot = JSON.parse(reviewer.snapshot_json).role;
    if (role.reviewAuthority === 'none') throw new RoleError('此岗位不承担专业检查', 403, 'role_review_forbidden');
    if (actor && relation.authority !== 'approve' && action !== 'suggest') throw new RoleError('本次只允许提供建议，不能自动通过或退回', 403, 'review_not_authorized');
    if (!actor && role.executor.kind !== 'person' && !(participant(req, work.node_id).ownerMayReview && body.owner_proxy === true)) throw new RoleError('此检查由指定AI负责；本人代检查须在任务中明确授权', 403, 'review_not_authorized');
    relationId = relation.id; reviewerNodeId = reviewer.node_id;
  } else if (action !== 'return' || actor) throw new RoleError('当前阶段不能执行此检查', 409, 'phase_conflict');
  if (!['approve', 'suggest', 'return', 'confirm', 'revise'].includes(action)) throw new RoleError('检查动作无效');
  const entry = await db.canvasRoleEvent.create({ data: { id: randomUUID(), role_task_run_id: run.id,
    requirements_revision: run.requirements_revision, work_id: work.id, delivery_id: delivery.id,
    actor_user_id: user.id, actor_kind: actor ? 'ai' : 'person', from_node_id: reviewerNodeId, to_node_id: work.node_id,
    kind: 'collaboration_review', detail_json: JSON.stringify({ action, opinion, relationId, reviewerNodeId,
      inputDigest: workInputDigest(work, req), attemptId: actor?.attemptId || null, ownerProxy: body.owner_proxy === true }) } });
  if (action === 'return' || action === 'revise') {
    const successor = await reviseCollaborationWork(db, user, run, work, req, opinion, document.document_json);
    return { work: await db.canvasRoleWork.findUniqueOrThrow({ where: { id: work.id } }), successor, event: entry };
  }
  let next = work.phase;
  if (action === 'confirm') next = 'delivered';
  else {
    const reviews = await db.canvasRoleEvent.findMany({ where: { role_task_run_id: run.id, work_id: work.id,
      delivery_id: delivery.id, kind: 'collaboration_review' }, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 500 });
    const edges = req.relations!.filter(r => r.type === 'review' && r.from === work.node_id);
    if (edges.every(edge => reviews.some(e => { const detail = JSON.parse(e.detail_json); return detail.relationId === edge.id
      && detail.inputDigest === workInputDigest(work, req) && (edge.authority === 'approve' ? detail.action === 'approve' : ['suggest', 'approve'].includes(detail.action)); }))) {
      next = work.confirm_required || edges.some(edge => edge.authority === 'suggestion') ? 'confirmation' : 'delivered';
    }
  }
  const updated = await db.canvasRoleWork.update({ where: { id: work.id }, data: { phase: next, revision: { increment: 1 } } });
  if (next === 'delivered') {
    const { finalizeDelivered } = await import('./work');
    await finalizeDelivered(db, user, run, req);
  }
  return { work: updated, successor: null, event: entry };
}

export async function readRoleResults(user: SessionUser, runId: string, params = new URLSearchParams()) {
  const { run } = await ownedRun(prisma, user, identifier(runId));
  const control = await prisma.canvasRoleRunControl.findUnique({ where: { run_id: run.id } });
  const manifestEvent = control?.current_manifest_event_id ? await prisma.canvasRoleEvent.findUnique({ where: { id: control.current_manifest_event_id } }) : null;
  const where = { role_task_run_id: run.id, kind: { in: [
    'requirements_changed', 'collaboration_review', 'branch_retained', 'owner_result_accepted',
    'rule_proposed', 'rule_adopted', 'rule_verified', 'retained', 'reverted'] } };
  const cursor = params.get('cursor');
  if (cursor && !await prisma.canvasRoleEvent.findFirst({ where: { ...where, id: identifier(cursor) }, select: { id: true } })) {
    throw new RoleError('成果记录分页位置失效，请重新读取');
  }
  const reviews = await prisma.canvasRoleEvent.findMany({ where,
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 31,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
  const deliveries = manifestEvent ? await prisma.canvasRoleDelivery.findMany({ where: {
    id: { in: JSON.parse(manifestEvent.detail_json).deliveries.map((d: JsonRecord) => String(d.deliveryId)) }, work: { role_task_run_id: run.id } } }) : [];
  return { manifest: manifestEvent ? { ...JSON.parse(manifestEvent.detail_json), eventId: manifestEvent.id } : null,
    deliveries, acceptance_event_id: control?.acceptance_event_id || null,
    fee_confirmed: run.reserved_points === 0 && run.reserved_usd_micros === 0, facts: reviews.slice(0, 30),
    next_cursor: reviews.length > 30 ? reviews[29].id : null, facts_limited_to: 30, analysis_generated: false };
}

export async function actOnRoleResults(user: SessionUser, runId: string, body: JsonRecord) {
  return roleMutation(user, body, `role_results:${identifier(runId)}`, db => ownedRun(db, user, runId, true), async db => {
    assertRoleCollaborationWritable();
    const { run } = await ownedRun(db, user, runId, true);
    const work = await db.canvasRoleWork.findFirst({ where: { id: identifier(body.work_id), role_task_run_id: run.id } });
    if (!work) throw new RoleError('工作来源不属于本任务', 404, 'work_not_found');
    const action = String(body.action), snapshot = JSON.parse(work.snapshot_json);
    if (action === 'rule_proposed') {
      const entry = await event(db, user, run.id, work.requirements_revision, action, work.id, {
        text: text(body.text, 8000, true), definitionId: snapshot.definitionId, sourceVersion: snapshot.version, changesExistingRole: false });
      return { objectId: run.id, result: { event: entry } };
    }
    const proposal = await db.canvasRoleEvent.findFirst({ where: { id: identifier(body.proposal_event_id),
      run: { owner_user_id: user.id }, kind: action === 'rule_adopted' ? 'rule_proposed' : 'rule_adopted' } });
    if (!proposal) throw new RoleError('原规则建议或采用记录不存在', 409, 'rule_source_missing');
    await ownedRun(db, user, proposal.role_task_run_id);
    const detail = JSON.parse(proposal.detail_json);
    if (detail.definitionId !== snapshot.definitionId) throw new RoleError('规则记录不属于当前岗位', 409, 'rule_source_missing');
    const definition = await ownedDefinition(db, user, identifier(detail.definitionId));
    if (action === 'rule_adopted' || action === 'reverted') {
      if (integer(body.base_role_revision) !== definition.revision || integer(body.base_role_version) !== definition.current_version) throw new RoleError('长期角色规则已更新，请先核对，旧任务不被覆盖', 409, 'revision_conflict');
      if (action === 'reverted' && definition.current_version !== detail.adoptedVersion) throw new RoleError('此规则之后已有新版本，不能覆盖后续修改', 409, 'rule_version_changed');
      const source = await db.canvasRoleVersion.findUniqueOrThrow({ where: { definition_id_version: {
        definition_id: definition.id, version: action === 'reverted' ? detail.previousVersion : definition.current_version } } });
      const before: RoleSnapshot = JSON.parse(source.snapshot_json);
      const next = roleSnapshot({ ...before, ...(action === 'rule_adopted' ? { boundary: [before.boundary, detail.text].filter(Boolean).join('\n') } : {}),
        provenance: { kind: 'user', version: String(definition.current_version + 1), source: action === 'rule_adopted' ? '本人明确采纳规则' : '本人明确撤回规则' } }, user.id);
      const version = definition.current_version + 1;
      await db.canvasRoleVersion.create({ data: { id: `${definition.id}-v${version}`, definition_id: definition.id, version, snapshot_json: JSON.stringify(next) } });
      const changed = await db.canvasRoleDefinition.updateMany({ where: { id: definition.id, revision: definition.revision }, data: { current_version: version, revision: { increment: 1 } } });
      if (!changed.count) throw new RoleError('角色已更新，请重读', 409, 'revision_conflict');
      const entry = await event(db, user, run.id, work.requirements_revision, action, work.id, { definitionId: definition.id,
        previousVersion: definition.current_version, adoptedVersion: version, proposalEventId: proposal.id, text: detail.text, existingRunsChanged: false });
      return { objectId: run.id, result: { event: entry, role_version: version, applies_to_future_tasks: true } };
    }
    if (!['rule_verified', 'retained'].includes(action)) throw new RoleError('规则操作无效');
    const evidence = await db.canvasRoleDelivery.findFirst({ where: { id: identifier(body.evidence_delivery_id), work_id: work.id } });
    if (!evidence || snapshot.definitionId !== detail.definitionId || snapshot.version !== detail.adoptedVersion) throw new RoleError('请提供实际使用所采纳规则版本的任务成果', 409, 'rule_evidence_required');
    const entry = await event(db, user, run.id, work.requirements_revision, action, work.id, { adoptionEventId: proposal.id,
      definitionId: definition.id, roleVersion: snapshot.version, evidenceDeliveryId: evidence.id, text: text(body.text, 8000, true) }, evidence.id);
    return { objectId: run.id, result: { event: entry } };
  });
}
