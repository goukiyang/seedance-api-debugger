import { randomUUID } from 'crypto';
import type { CanvasRoleWork, CanvasRoleTaskRun } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { assertCanUseReferenceImage } from '@/lib/reference-albums/permissions';
import { assertCanViewTask } from '@/lib/projects/permissions';
import { parseCanvasSnapshot } from '@/lib/canvas-documents';
import { executionView } from './execution';
import { assertDeliveryOriginals, authoredCanvasText, originalIdentity, submissionAttachments } from './media';
import { assertLiveNode, ownedDefinition, ownedRun, roleDocument, type RoleDb } from './permissions';
import { roleMutation } from './repository';
import { digest, identifier, integer, pointCents, roleRunView, record, requirements, RoleError, text,
  type JsonRecord, type RoleParticipant, type RoleSnapshot, type TaskRequirements } from './types';

export async function taskRequirements(db: RoleDb, runId: string, revision: number): Promise<TaskRequirements> {
  const row = await db.canvasRoleTaskRevision.findUnique({ where: {
    role_task_run_id_requirements_revision: { role_task_run_id: runId, requirements_revision: revision },
  } });
  if (!row) throw new RoleError('任务要求版本缺失，已停止继续', 409, 'requirements_unavailable');
  return JSON.parse(row.snapshot_json);
}
export function participant(req: TaskRequirements, nodeId: string) {
  const p = req.participants.find(item => item.nodeId === nodeId && item.participation !== 'excluded');
  if (!p) throw new RoleError('角色不参与本次工作', 409, 'not_participating');
  return p;
}
export async function materialSnapshot(db: RoleDb, user: SessionUser, documentJson: string, req: TaskRequirements) {
  const parsed = JSON.parse(documentJson), nodes = parsed.canvas.nodes as Array<{ id: string; type: string; data: JsonRecord }>;
  const result = [];
  for (const nodeId of req.materialNodes) {
    const node = nodes.find(n => n.id === nodeId);
    if (!node || node.type === 'role' || node.type.startsWith('flow-')) throw new RoleError('输入材料已移除或不能作为角色输入', 409, 'material_unavailable');
    const data = node.data;
    const assetId = data.assetId || data.asset_id;
    const referenceId = data.referenceImageId || data.reference_image_id;
    const taskId = data.taskId || data.task_id;
    const reference = referenceId ? await assertCanUseReferenceImage(user, identifier(referenceId)) : null;
    if (reference?.asset && reference.asset.status !== 'active') throw new RoleError('输入原件已失效', 403, 'material_unavailable');
    if (assetId && reference?.asset_id !== assetId) {
      const asset = await db.asset.findFirst({ where: { id: identifier(assetId), status: 'active', ...(user.role === 'admin' ? {} : { owner_id: user.id }) }, select: { id: true } });
      if (!asset) throw new RoleError('输入原件已失效或无权使用', 403, 'material_unavailable');
    }
    if (taskId) {
      const video = await db.videoTask.findUnique({ where: { id: identifier(taskId) } });
      if (video) await assertCanViewTask(user, video);
      else {
        const image = await db.imageStudioTask.findFirst({ where: { id: identifier(taskId), owner_id: user.id } });
        if (!image) throw new RoleError('材料任务不存在或不可访问', 403, 'material_unavailable');
      }
    }
    if (!['text', 'script'].includes(node.type) && !assetId && !referenceId && !taskId) {
      throw new RoleError('素材尚无合法持久原件，请先保存素材', 409, 'material_not_saved');
    }
    const original = !['text', 'script'].includes(node.type) ? (await originalIdentity(db, user, data)).snapshot : null;
    // Match the editor's nullish semantics: explicitly cleared text is still the authored value.
    result.push({ nodeId, type: node.type, title: text(data.title, 120),
      text: ['text', 'script'].includes(node.type) ? authoredCanvasText(data, 32000) : '',
      ...(original ? { original } : {}),
      ...(assetId ? { assetId } : {}), ...(referenceId ? { referenceImageId: referenceId } : {}), ...(taskId ? { taskId } : {}) });
  }
  return result;
}
async function event(db: RoleDb, user: SessionUser, runId: string, revision: number, kind: string,
  workId: string | null, detail: JsonRecord, deliveryId?: string, from?: string, to?: string) {
  return db.canvasRoleEvent.create({ data: { id: randomUUID(), role_task_run_id: runId,
    requirements_revision: revision, work_id: workId, actor_user_id: user.id,
    actor_kind: 'person', kind, detail_json: JSON.stringify(detail),
    delivery_id: deliveryId, from_node_id: from, to_node_id: to } });
}
async function makeWork(db: RoleDb, user: SessionUser, runId: string, revision: number,
  p: RoleParticipant, documentJson: string, round = 1, supersedes?: CanvasRoleWork) {
  const nodes = JSON.parse(documentJson).canvas.nodes;
  const node = nodes.find((n: { id: string; type: string }) => n.id === p.nodeId && n.type === 'role');
  if (!record(node?.data?.roleConfig)) throw new RoleError('请先将角色保存到画布', 409, 'role_node_unsaved');
  const config = node.data.roleConfig;
  const definition = await ownedDefinition(db, user, identifier(config.definitionId));
  const roleVersion = await db.canvasRoleVersion.findUnique({ where: {
    definition_id_version: { definition_id: definition.id, version: integer(config.version) },
  } });
  if (!roleVersion) throw new RoleError('角色版本不存在', 409, 'role_version_unavailable');
  const snapshot: RoleSnapshot = JSON.parse(roleVersion.snapshot_json);
  const work = await db.canvasRoleWork.create({ data: {
    id: randomUUID(), role_task_run_id: runId, requirements_revision: revision,
    node_id: p.nodeId, round, role_version_id: roleVersion.id,
    executor_user_id: snapshot.executor.kind === 'person' ? snapshot.executor.userId : null,
    reviewer_node_id: p.reviewerNodeId, confirm_required: p.confirmRequired,
    snapshot_json: JSON.stringify({ definitionId: definition.id, version: roleVersion.version, role: snapshot,
      ...(supersedes ? { supersedesWorkId: supersedes.id } : {}) }),
    ...(p.dependencies.some(dep => dep.required) ? { phase: 'needs_material', wait_reason: '等待必交材料', wait_since: new Date() } : {}),
  } });
  await event(db, user, runId, revision, 'offered', work.id, { round, supersedesWorkId: supersedes?.id || null });
  return work;
}
export async function createTaskRun(user: SessionUser, body: JsonRecord) {
  const documentId = identifier(body.document_id);
  return roleMutation(user, body, 'role_task_create', async () => roleDocument(user, documentId, true), async db => {
    const document = await roleDocument(user, documentId, true);
    if (integer(body.document_revision, 0) !== document.revision) throw new RoleError('画布已更新，请读取后再配置任务', 409, 'revision_conflict');
    const graph = parseCanvasSnapshot(document.document_json, document.project_id, false);
    const req = requirements(body.requirements, user.id, new Set(graph.canvas.nodes.filter(n => n.type === 'role').map(n => n.id)));
    req.materials = await materialSnapshot(db, user, document.document_json, req);
    const run = await db.canvasRoleTaskRun.create({ data: { id: randomUUID(), owner_user_id: user.id,
      document_id: documentId, max_rounds: integer(body.max_rounds, 1, 100),
      wait_limit_seconds: body.wait_limit_seconds == null ? null : integer(body.wait_limit_seconds, 1, 365 * 86400),
      budget_points_limit: body.budget_points_limit == null ? null : pointCents(body.budget_points_limit),
      budget_usd_micros_limit: body.budget_usd_micros_limit == null ? null : integer(body.budget_usd_micros_limit, 0, 1_000_000_000),
      max_calls: body.max_calls == null ? null : integer(body.max_calls, 1, 1000) } });
    await db.canvasRoleTaskRevision.create({ data: { id: randomUUID(), role_task_run_id: run.id,
      requirements_revision: 1, snapshot_json: JSON.stringify(req), created_by: user.id } });
    const works = [];
    for (const p of req.participants.filter(p => p.participation !== 'excluded')) works.push(await makeWork(db, user, run.id, 1, p, document.document_json));
    await event(db, user, run.id, 1, 'task_created', null, { goal: req.goal, endpoint: req.endpoint });
    return { objectId: run.id, result: { run: roleRunView(run), works, requirements: req } };
  });
}
export async function latestWorks(db: RoleDb, runId: string, revision: number) {
  const rows = await db.canvasRoleWork.findMany({ where: { role_task_run_id: runId, requirements_revision: revision }, orderBy: { round: 'desc' } });
  const seen = new Set<string>();
  return rows.filter(row => { if (seen.has(row.node_id)) return false; seen.add(row.node_id); return true; });
}
async function refreshInputs(db: RoleDb, user: SessionUser, runId: string, revision: number, req: TaskRequirements) {
  const works = await latestWorks(db, runId, revision);
  for (const work of works) {
    if (!['offered', 'needs_material', 'ready', 'rejected'].includes(work.phase)) continue;
    const p = participant(req, work.node_id), inputs = [], missing = [];
    for (const dep of p.dependencies) {
      const source = works.find(row => row.node_id === dep.nodeId);
      if (source?.phase === 'delivered' && source.current_delivery_id) {
        const delivery = await db.canvasRoleDelivery.findUnique({ where: { id: source.current_delivery_id } });
        if (!delivery || delivery.requirements_revision !== revision) throw new RoleError('有效材料版本不一致', 409, 'delivery_conflict');
        inputs.push({ sourceWorkId: source.id, deliveryId: delivery.id, version: delivery.version, nodeId: source.node_id });
        await db.canvasRoleHandoff.upsert({ where: {
          source_delivery_id_target_work_id_requirements_revision: {
            source_delivery_id: delivery.id, target_work_id: work.id, requirements_revision: revision },
        }, update: {}, create: { id: randomUUID(), role_task_run_id: runId, requirements_revision: revision,
          source_work_id: source.id, source_delivery_id: delivery.id, target_work_id: work.id,
          bundle_json: JSON.stringify({ requirementsRevision: revision, deliveryId: delivery.id, content: JSON.parse(delivery.content_json) }) } });
      } else if (dep.required) missing.push(dep.nodeId);
    }
    const manualWait = work.wait_reason?.startsWith('请补材料：');
    const inputsJson = JSON.stringify(inputs), wait = manualWait ? work.wait_reason : missing.length ? `等待角色材料：${missing.join('、')}` : null;
    const nextPhase = manualWait ? work.phase : missing.length ? 'needs_material' : work.phase === 'needs_material' ? 'offered' : work.phase;
    if (inputsJson === work.inputs_json && wait === work.wait_reason && nextPhase === work.phase) continue;
    await db.canvasRoleWork.update({ where: { id: work.id }, data: {
      inputs_json: inputsJson, phase: nextPhase, wait_reason: wait,
      wait_since: wait ? work.wait_since || new Date() : null, revision: { increment: 1 } } });
    await event(db, user, runId, revision, missing.length ? 'materials_waiting' : 'materials_ready', work.id, { inputs, missing });
  }
}
export async function finalizeDelivered(db: RoleDb, user: SessionUser, run: CanvasRoleTaskRun, req: TaskRequirements) {
  await refreshInputs(db, user, run.id, run.requirements_revision, req);
  const works = await latestWorks(db, run.id, run.requirements_revision);
  const complete = req.participants.filter(p => p.participation === 'required').every(p => works.find(w => w.node_id === p.nodeId)?.phase === 'delivered')
    && works.find(w => w.node_id === req.finalNodeId)?.phase === 'delivered';
  if (!complete) return;
  const updated = await db.canvasRoleTaskRun.updateMany({ where: { id: run.id, requirements_revision: run.requirements_revision, status: { not: 'delivered' } },
    data: { status: 'delivered', revision: { increment: 1 } } });
  if (!updated.count) return;
  await event(db, user, run.id, run.requirements_revision, 'owner_result_available', null, {
    finalNodeId: req.finalNodeId, adopted: works.filter(w => w.phase === 'delivered').map(w => ({ workId: w.id, deliveryId: w.current_delivery_id })),
    externalDelivery: false, feeCleared: run.call_count === 0 });
}
export async function readWork(user: SessionUser, workId: string, params = new URLSearchParams()) {
  const work = await prisma.canvasRoleWork.findUnique({ where: { id: identifier(workId) } });
  if (!work) throw new RoleError('工作不存在', 404, 'work_not_found');
  const { run, document } = await ownedRun(prisma, user, work.role_task_run_id);
  const req = await taskRequirements(prisma, run.id, work.requirements_revision);
  const before = params.get('cursor') || params.get('before');
  let eventId: string | undefined;
  if (before) {
    const prior = await prisma.canvasRoleEvent.findFirst({ where: { id: identifier(before), role_task_run_id: run.id,
      requirements_revision: work.requirements_revision,
      OR: [{ work_id: work.id }, { to_node_id: work.node_id }, { from_node_id: work.node_id }, { work_id: null }] } });
    if (!prior) throw new RoleError('历史分页位置无效');
    eventId = prior.id;
  }
  const events = await prisma.canvasRoleEvent.findMany({ where: { role_task_run_id: run.id,
    requirements_revision: work.requirements_revision,
    OR: [{ work_id: work.id }, { to_node_id: work.node_id }, { from_node_id: work.node_id }, { work_id: null }] },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 31,
    ...(eventId ? { cursor: { id: eventId }, skip: 1 } : {}) });
  const deliveries = await prisma.canvasRoleDelivery.findMany({ where: { work_id: work.id }, orderBy: { version: 'desc' }, take: 30 });
  const workCursor = params.get('work_cursor');
  if (workCursor && !await prisma.canvasRoleWork.findFirst({ where: { id: identifier(workCursor),
    role_task_run_id: run.id, node_id: work.node_id } })) throw new RoleError('修订历史分页位置无效');
  const workHistory = await prisma.canvasRoleWork.findMany({ where: { role_task_run_id: run.id, node_id: work.node_id },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 31,
    ...(workCursor ? { cursor: { id: workCursor }, skip: 1 } : {}),
    select: { id: true, node_id: true, role_task_run_id: true, requirements_revision: true, round: true,
      phase: true, current_delivery_id: true, created_at: true } });
  const attemptCursor = params.get('attempt_cursor');
  if (attemptCursor && !await prisma.canvasRoleAttempt.findFirst({ where: { id: identifier(attemptCursor), work_id: work.id } })) throw new RoleError('请求历史分页位置无效');
  const attempts = await prisma.canvasRoleAttempt.findMany({ where: { work_id: work.id }, orderBy: [{ started_at: 'desc' }, { id: 'desc' }], take: 31,
    ...(attemptCursor ? { cursor: { id: attemptCursor }, skip: 1 } : {}),
    select: { id: true, request_id: true, purpose: true, state: true, fee_state: true, started_at: true, finished_at: true,
      reserved_points: true, reserved_usd_micros: true, settled_points: true, settled_usd_micros: true, settlement_applied: true,
      result_json: true, settlement_receipt: true } });
  const inputs = [];
  for (const input of JSON.parse(work.inputs_json)) {
    const delivery = await prisma.canvasRoleDelivery.findUnique({ where: { id: input.deliveryId } });
    if (delivery) inputs.push({ ...input, content: JSON.parse(delivery.content_json) });
  }
  const elapsed = work.wait_since ? Math.max(0, Math.floor((Date.now() - work.wait_since.getTime()) / 1000)) : 0;
  const waitingExpired = Boolean(work.wait_since && run.wait_limit_seconds && elapsed >= run.wait_limit_seconds);
  const currentWorks = await latestWorks(prisma, run.id, work.requirements_revision);
  const currentNodeWork = (work.requirements_revision === run.requirements_revision ? currentWorks
    : await latestWorks(prisma, run.id, run.requirements_revision)).find(w => w.node_id === work.node_id);
  const isCurrentWork = currentNodeWork?.id === work.id;
  let actionUnavailableReason = isCurrentWork ? '' : '这是历史工作，请返回当前修订后操作';
  if (!actionUnavailableReason) {
    try { assertLiveNode(work, document.document_json); }
    catch (error) { actionUnavailableReason = error instanceof Error ? error.message : '原角色不可继续工作'; }
  }
  if (document.status !== 'active') actionUnavailableReason = '画布已归档，当前仅可回查历史';
  const required = req.participants.filter(p => p.participation === 'required');
  const ownerReceipt = await prisma.canvasRoleEvent.findFirst({ where: { role_task_run_id: run.id,
    requirements_revision: work.requirements_revision, kind: 'owner_result_available' }, orderBy: { created_at: 'desc' } });
  return { run: roleRunView(run), work: { ...work, snapshot: JSON.parse(work.snapshot_json) }, requirements: req, inputs,
    draft_content: JSON.parse(work.snapshot_json).draftContent || { text: work.draft_text, items: {}, attachments: [] },
    revision_source: JSON.parse(work.snapshot_json).revisionSource || null,
    deliveries, attempts: attempts.slice(0, 30).map(a => ({ ...a, result_available: Boolean(a.result_json), result_json: undefined, reserved_points: a.reserved_points / 100,
      settled_points: a.settled_points == null ? null : a.settled_points / 100,
      confirmed_bill_usd_micros: a.settlement_receipt ? JSON.parse(a.settlement_receipt).amountMicros ?? null : null,
      settlement_receipt: undefined })), events: events.slice(0, 30), next_cursor: events.length > 30 ? events[29].id : null,
    node_work_history: workHistory.slice(0, 30), next_work_cursor: workHistory.length > 30 ? workHistory[29].id : null,
    next_attempt_cursor: attempts.length > 30 ? attempts[29].id : null,
    input_digest: workInputDigest(work, req), materials: req.materials || [],
    waiting_expired: waitingExpired,
    waiting: { responsible_user_id: run.owner_user_id, elapsed_seconds: elapsed, requires_owner_decision: waitingExpired,
      reason: work.wait_reason, limit_seconds: run.wait_limit_seconds, automatic_pass: false },
    summary: { requirements_revision: work.requirements_revision, round: work.round,
      is_current_work: isCurrentWork, current_work_id: currentNodeWork?.id ?? null,
      action_available: !actionUnavailableReason, action_unavailable_reason: actionUnavailableReason,
      task_update_available: isCurrentWork && document.status === 'active',
      task_control_available: isCurrentWork && document.status === 'active',
      completed_required: required.filter(p => currentWorks.find(w => w.node_id === p.nodeId)?.phase === 'delivered').length,
      required_count: required.length,
      pending_node_ids: required.filter(p => currentWorks.find(w => w.node_id === p.nodeId)?.phase !== 'delivered').map(p => p.nodeId),
      final_receipt: ownerReceipt ? { id: ownerReceipt.id, created_at: ownerReceipt.created_at, ...JSON.parse(ownerReceipt.detail_json) } : null,
      fee_confirmed: run.reserved_points === 0 && run.reserved_usd_micros === 0,
    },
    execution: await executionView(user, run, work, req) };
}
export async function listWorks(user: SessionUser, params: URLSearchParams) {
  const documentId = identifier(params.get('document_id'));
  await roleDocument(user, documentId);
  const cursor = params.get('cursor');
  if (cursor && !await prisma.canvasRoleTaskRun.findFirst({ where: { id: identifier(cursor), document_id: documentId, owner_user_id: user.id } })) throw new RoleError('任务分页位置无效');
  const page = await prisma.canvasRoleTaskRun.findMany({ where: { document_id: documentId, owner_user_id: user.id },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 31, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
  const runs = page.slice(0, 30);
  const works = [];
  for (const run of runs) {
    const req = await taskRequirements(prisma, run.id, run.requirements_revision);
    for (const work of await latestWorks(prisma, run.id, run.requirements_revision)) {
      if (params.get('view') === 'pending' && ['delivered', 'superseded'].includes(work.phase)) continue;
      const snapshot = JSON.parse(work.snapshot_json);
      works.push({ ...work, snapshot_json: undefined, draft_text: undefined, inputs_json: undefined,
        snapshot: { definitionId: snapshot.definitionId, version: snapshot.version,
          role: { name: snapshot.role.name, executor: snapshot.role.executor } }, goal: req.goal.slice(0, 240), run_paused: run.paused });
    }
  }
  return { runs: runs.map(roleRunView), works, scope: 'current_document', limited_to_runs: 30, next_cursor: page.length > 30 ? runs[29].id : null };
}
export async function readRoleAttempt(user: SessionUser, attemptId: string) {
  const attempt = await prisma.canvasRoleAttempt.findUnique({ where: { id: identifier(attemptId) }, select: {
    id: true, work_id: true, request_id: true, purpose: true, state: true, fee_state: true, started_at: true, finished_at: true,
    reserved_points: true, reserved_usd_micros: true, settled_points: true, settled_usd_micros: true,
    settlement_applied: true, settlement_receipt: true, result_json: true,
  } });
  if (!attempt) throw new RoleError('原请求不存在', 404, 'attempt_not_found');
  const work = await prisma.canvasRoleWork.findUniqueOrThrow({ where: { id: attempt.work_id } });
  await ownedRun(prisma, user, work.role_task_run_id);
  return { attempt: { ...attempt, reserved_points: attempt.reserved_points / 100,
    settled_points: attempt.settled_points == null ? null : attempt.settled_points / 100,
    confirmed_bill_usd_micros: attempt.settlement_receipt ? JSON.parse(attempt.settlement_receipt).amountMicros ?? null : null,
    settlement_receipt: undefined }, resend: false };
}
export function workInputDigest(work: CanvasRoleWork, req: TaskRequirements) {
  return digest({ requirementsRevision: work.requirements_revision, materials: req.materials || [], inputs: JSON.parse(work.inputs_json) });
}
export async function assertCurrentMaterials(db: RoleDb, user: SessionUser, documentJson: string, req: TaskRequirements) {
  if (digest(await materialSnapshot(db, user, documentJson, req)) !== digest(req.materials || [])) {
    throw new RoleError('输入材料已改动，请更新本次任务要求后继续；旧版本不会自动采用新材料', 409, 'materials_changed');
  }
}
export async function assertEffectiveInputs(db: RoleDb, work: CanvasRoleWork, req: TaskRequirements, documentJson: string, user: SessionUser) {
  const works = await latestWorks(db, work.role_task_run_id, work.requirements_revision);
  const inputs = JSON.parse(work.inputs_json) as Array<{ nodeId: string; sourceWorkId: string; deliveryId: string }>;
  const deps = participant(req, work.node_id).dependencies;
  for (const dep of deps) {
    const input = inputs.find(i => i.nodeId === dep.nodeId);
    if (!input) {
      if (dep.required) throw new RoleError('必交材料尚未收齐', 409, 'materials_missing');
      continue;
    }
    const source = works.find(w => w.node_id === dep.nodeId);
    const delivery = await db.canvasRoleDelivery.findUnique({ where: { id: input.deliveryId } });
    if (!source || source.id !== input.sourceWorkId || source.phase !== 'delivered'
      || source.current_delivery_id !== input.deliveryId || !delivery || delivery.work_id !== source.id
      || delivery.requirements_revision !== work.requirements_revision) {
      throw new RoleError('交接材料已被修订，不能继续采用旧成果', 409, 'input_conflict');
    }
    assertLiveNode(source, documentJson);
    await assertDeliveryOriginals(db, user, JSON.parse(delivery.content_json));
  }
  if (inputs.some(i => !deps.some(d => d.nodeId === i.nodeId))) throw new RoleError('交接关系与本次要求不一致', 409, 'input_conflict');
}
export async function updateTaskRun(user: SessionUser, runId: string, body: JsonRecord) {
  return roleMutation(user, body, `role_task_update:${identifier(runId)}`, db => ownedRun(db, user, runId, true), async db => {
    const { run, document } = await ownedRun(db, user, runId, true);
    if (integer(body.base_revision) !== run.revision || integer(body.document_revision, 0) !== document.revision) throw new RoleError('任务或画布已更新，请重新核对', 409, 'revision_conflict');
    // Uncertain external requests cannot be bypassed by changing requirements.
    const inFlight = await db.canvasRoleAttempt.count({ where: { work: { role_task_run_id: run.id }, OR: [{ state: { in: ['reserved', 'sending', 'unknown'] } }, { fee_state: { in: ['pending', 'unknown', 'authorization_required'] } }] } });
    if (inFlight) throw new RoleError('尚有模型请求或费用待核对，请先恢复原回执', 409, 'attempt_unresolved');
    const nodes = parseCanvasSnapshot(document.document_json, document.project_id, false).canvas.nodes;
    const previous = await taskRequirements(db, run.id, run.requirements_revision);
    const oldWorks = await latestWorks(db, run.id, run.requirements_revision);
    const limitsOnly = body.update_kind === 'limits' || body.requirements === undefined;
    const req = limitsOnly ? previous : requirements(body.requirements, user.id, new Set(nodes.filter(n => n.type === 'role').map(n => n.id)));
    const configuredChanged = digest({ ...req, materials: undefined }) !== digest({ ...previous, materials: undefined });
    req.materials = !limitsOnly && (configuredChanged || body.refresh_materials === true)
      ? await materialSnapshot(db, user, document.document_json, req) : previous.materials;
    const affected = new Set<string>();
    const globalChange = req.goal !== previous.goal || req.criteria !== previous.criteria || digest(req.materials) !== digest(previous.materials);
    for (const p of [...previous.participants, ...req.participants]) {
      const before = previous.participants.find(item => item.nodeId === p.nodeId);
      const after = req.participants.find(item => item.nodeId === p.nodeId);
      const work = oldWorks.find(item => item.node_id === p.nodeId);
      const config = nodes.find(node => node.id === p.nodeId)?.data.roleConfig;
      const snapshot = work ? JSON.parse(work.snapshot_json) : null;
      if (globalChange || digest(before) !== digest(after) || (!limitsOnly && work
        && (!record(config) || config.definitionId !== snapshot.definitionId || config.version !== snapshot.version))) affected.add(p.nodeId);
    }
    let expanding = true;
    while (expanding) {
      expanding = false;
      for (const p of [...previous.participants, ...req.participants]) if (!affected.has(p.nodeId)
        && (p.dependencies.some(dep => affected.has(dep.nodeId)) || (p.reviewerNodeId && affected.has(p.reviewerNodeId)))) {
        affected.add(p.nodeId); expanding = true;
      }
    }
    const contentChanged = affected.size > 0 || configuredChanged;
    const revision = run.requirements_revision + (contentChanged ? 1 : 0);
    const limits = {
      budget_points_limit: body.budget_points_limit === undefined ? run.budget_points_limit : body.budget_points_limit === null ? null : pointCents(body.budget_points_limit),
      budget_usd_micros_limit: body.budget_usd_micros_limit === undefined ? run.budget_usd_micros_limit : body.budget_usd_micros_limit === null ? null : integer(body.budget_usd_micros_limit, 0, 1_000_000_000),
      max_calls: body.max_calls === undefined ? run.max_calls : body.max_calls === null ? null : integer(body.max_calls, 1, 1000),
    };
    if ((limits.budget_points_limit != null && limits.budget_points_limit < run.settled_points + run.reserved_points)
      || (limits.budget_usd_micros_limit != null && limits.budget_usd_micros_limit < run.settled_usd_micros + run.reserved_usd_micros)
      || (limits.max_calls != null && limits.max_calls < run.call_count)) throw new RoleError('额度不能低于本任务已发生的费用或调用次数', 409, 'budget_conflict');
    const maxRounds = body.max_rounds == null ? run.max_rounds : integer(body.max_rounds, 1, 100);
    const maximum = await db.canvasRoleWork.findFirst({ where: { role_task_run_id: run.id }, orderBy: { round: 'desc' } });
    if (maximum && maxRounds < maximum.round) throw new RoleError('修订上限不能低于已经发生的轮次', 409, 'round_limit');
    const updated = await db.canvasRoleTaskRun.update({ where: { id: run.id }, data: {
      requirements_revision: revision, revision: { increment: 1 }, ...(contentChanged ? { status: 'active' } : {}),
      ...limits,
      max_rounds: maxRounds,
      ...(body.wait_limit_seconds !== undefined ? { wait_limit_seconds: body.wait_limit_seconds === null ? null : integer(body.wait_limit_seconds, 1, 365 * 86400) } : {}),
    } });
    if (!contentChanged) {
      await event(db, user, run.id, revision, 'task_limits_changed', null, { workIdsRetained: true, requirementsRetained: true, feesRetained: true });
      return { objectId: run.id, result: { run: roleRunView(updated), works: oldWorks, requirements: previous, content_changed: false } };
    }
    await db.canvasRoleTaskRevision.create({ data: { id: randomUUID(), role_task_run_id: run.id, requirements_revision: revision,
      snapshot_json: JSON.stringify(req), created_by: user.id } });
    await db.canvasRoleWork.updateMany({ where: { role_task_run_id: run.id, requirements_revision: run.requirements_revision,
      phase: { notIn: ['delivered', 'superseded'] } }, data: { phase: 'superseded', revision: { increment: 1 } } });
    const works: CanvasRoleWork[] = [], carried = new Map<string, CanvasRoleWork>();
    for (const p of req.participants.filter(p => p.participation !== 'excluded')) {
      const old = oldWorks.find(w => w.node_id === p.nodeId);
      const latestEver = await db.canvasRoleWork.findFirst({ where: { role_task_run_id: run.id, node_id: p.nodeId }, orderBy: { round: 'desc' } });
      const round = affected.has(p.nodeId) ? (latestEver?.round || 0) + 1 : old?.round || (latestEver?.round || 0) + 1;
      if (round > maxRounds) throw new RoleError('受影响角色已到累计修订上限，请明确调整上限后再变更', 409, 'round_limit');
      let fresh = await makeWork(db, user, run.id, revision, p, document.document_json, round, old);
      if (old && !affected.has(p.nodeId)) {
        fresh = await db.canvasRoleWork.update({ where: { id: fresh.id }, data: { phase: old.phase,
          draft_text: old.draft_text, wait_reason: old.wait_reason, wait_since: old.wait_since,
          snapshot_json: JSON.stringify({ ...JSON.parse(old.snapshot_json), carriedFromWorkId: old.id }) } });
        carried.set(fresh.id, old);
      }
      works.push(fresh);
    }
    // Carry unchanged branches with explicit provenance, not replayed approval events.
    for (const fresh of works) {
      const old = carried.get(fresh.id);
      if (!old?.current_delivery_id) continue;
      const source = await db.canvasRoleDelivery.findUniqueOrThrow({ where: { id: old.current_delivery_id } });
      await assertDeliveryOriginals(db, user, JSON.parse(source.content_json));
      const delivery = await db.canvasRoleDelivery.create({ data: { id: randomUUID(), work_id: fresh.id, version: 1,
        requirements_revision: revision, input_digest: '', submitted_by: source.submitted_by, submission_kind: 'retained_branch',
        content_json: JSON.stringify({ ...JSON.parse(source.content_json), retainedFrom: { deliveryId: source.id, workId: old.id, requirementsRevision: old.requirements_revision } }) } });
      fresh.current_delivery_id = delivery.id;
      await db.canvasRoleWork.update({ where: { id: fresh.id }, data: { current_delivery_id: delivery.id } });
      await event(db, user, run.id, revision, 'branch_retained', fresh.id, { sourceWorkId: old.id, sourceDeliveryId: source.id,
        confirmationReplayed: false, unchangedBranch: true }, delivery.id);
    }
    for (const fresh of works) {
      const old = carried.get(fresh.id);
      if (!old) continue;
      const inputs = JSON.parse(old.inputs_json).map((input: JsonRecord) => {
        const source = works.find(w => w.node_id === input.nodeId);
        return source?.current_delivery_id ? { ...input, sourceWorkId: source.id, deliveryId: source.current_delivery_id, version: 1 } : null;
      }).filter(Boolean);
      fresh.inputs_json = JSON.stringify(inputs);
      await db.canvasRoleWork.update({ where: { id: fresh.id }, data: { inputs_json: fresh.inputs_json } });
      if (fresh.current_delivery_id) await db.canvasRoleDelivery.update({ where: { id: fresh.current_delivery_id }, data: { input_digest: workInputDigest(fresh, req) } });
    }
    await finalizeDelivered(db, user, updated, req);
    await event(db, user, run.id, revision, 'requirements_changed', null, { previousRevision: run.requirements_revision,
      feesRetained: true, affectedNodeIds: Array.from(affected), unchangedBranchesRetained: true, approvalsNotReplayed: true });
    return { objectId: run.id, result: { run: roleRunView(await db.canvasRoleTaskRun.findUniqueOrThrow({ where: { id: run.id } })), works, requirements: req, content_changed: true } };
  });
}
export async function actOnWork(user: SessionUser, workId: string, body: JsonRecord) {
  identifier(workId);
  const authorize = async (db: RoleDb) => {
    const work = await db.canvasRoleWork.findUnique({ where: { id: workId } });
    if (!work) throw new RoleError('工作不存在', 404, 'work_not_found');
    return ownedRun(db, user, work.role_task_run_id, true);
  };
  return roleMutation(user, body, `role_work:${workId}`, authorize, async db => {
    const work = (await db.canvasRoleWork.findUnique({ where: { id: workId } }))!;
    const { run, document } = await ownedRun(db, user, work.role_task_run_id, true);
    if (integer(body.base_revision) !== work.revision || integer(body.requirements_revision) !== run.requirements_revision
      || work.requirements_revision !== run.requirements_revision) throw new RoleError('任务已更新，请保留草稿并重新核对', 409, 'revision_conflict');
    const req = await taskRequirements(db, run.id, run.requirements_revision), p = participant(req, work.node_id);
    if ((await latestWorks(db, run.id, run.requirements_revision)).find(w => w.node_id === work.node_id)?.id !== work.id) {
      throw new RoleError('这是历史修订，记录保留；请打开当前工作后操作', 409, 'work_superseded');
    }
    const action = String(body.action), beforePhase = work.phase;
    if (!['message', 'pause', 'resume'].includes(action) && await db.canvasRoleAttempt.count({ where: { work_id: work.id,
      OR: [{ state: { in: ['reserved', 'sending', 'unknown'] } }, { fee_state: { in: ['pending', 'unknown', 'authorization_required'] } }] } })) {
      throw new RoleError('此工作已有请求或结果待确认，请查原回执，不能改写或重发', 409, 'attempt_unresolved');
    }
    if (!['message', 'pause', 'resume'].includes(action)) {
      if (run.paused) throw new RoleError('任务已暂停，请先继续', 409, 'task_paused');
      assertLiveNode(work, document.document_json);
      await assertCurrentMaterials(db, user, document.document_json, req);
    }
    let next = work.phase, detail: JsonRecord = {}, deliveryId = work.current_delivery_id;
    let successor: CanvasRoleWork | null = null;
    if (action === 'pause' || action === 'resume') {
      await db.canvasRoleTaskRun.update({ where: { id: run.id }, data: { paused: action === 'pause', revision: { increment: 1 } } });
      detail = { stopNewCallsOnly: true, existingRequestsNotCancelled: true };
    } else if (action === 'message') {
      const target = identifier(body.to_node_id), from = body.from_node_id == null ? null : identifier(body.from_node_id);
      participant(req, target);
      if (from) participant(req, from);
      const currentWorks = await latestWorks(db, run.id, run.requirements_revision);
      for (const nodeId of [target, ...(from ? [from] : [])]) {
        const addressed = currentWorks.find(w => w.node_id === nodeId);
        if (!addressed) throw new RoleError('交流对象已失效', 409, 'recipient_unavailable');
        assertLiveNode(addressed, document.document_json);
      }
      detail = { text: text(body.text, 16000, true), category: body.category === 'question' ? 'question' : 'message', sentBy: user.id,
        attribution: from ? 'owner_message_on_behalf' : 'owner_message', changesRequirements: false };
      await event(db, user, run.id, run.requirements_revision, 'message', work.id, detail, undefined, from || undefined, target);
    } else if (action === 'accept' || action === 'reject' || action === 'request_material') {
      if (!['offered', 'needs_material', 'rejected'].includes(work.phase)) throw new RoleError('此工作已接收，不能重复接单', 409, 'phase_conflict');
      if (action === 'accept') await assertEffectiveInputs(db, work, req, document.document_json, user);
      next = action === 'accept' ? 'ready' : action === 'reject' ? 'rejected' : 'needs_material';
      detail = { reason: text(body.reason, 8000, action !== 'accept'), acceptedBy: user.id, modelRequestAccepted: false };
      await db.canvasRoleWork.update({ where: { id: work.id }, data: {
        wait_reason: action === 'request_material' ? `请补材料：${detail.reason}` : null,
        wait_since: action === 'request_material' ? new Date() : null,
      } });
    } else if (action === 'draft' || action === 'submit') {
      if (!['ready', 'working', 'revision'].includes(work.phase)) throw new RoleError('请先接收任务并补齐材料', 409, 'phase_conflict');
      const snap: RoleSnapshot = JSON.parse(work.snapshot_json).role;
      if (snap.executor.kind !== 'person' && !(p.ownerMaySubmit && body.owner_proxy === true)) throw new RoleError('未允许本人代提交，请在本次任务中明确配置', 403, 'submission_not_authorized');
      if (snap.executor.kind === 'person' && snap.executor.userId !== user.id) throw new RoleError('不是本次执行者', 403, 'executor_mismatch');
      await assertEffectiveInputs(db, work, req, document.document_json, user);
      const attachments = await submissionAttachments(db, user, document.document_json, run.id, body.attachments);
      const content = text(body.text, 100000);
      if (action === 'submit' && !content && !attachments.length) throw new RoleError('请填写成果正文或选择合法原件');
      const items: Record<string, string> = Object.create(null);
      if (body.items !== undefined && !record(body.items)) throw new RoleError('必交项格式无效');
      for (const name of snap.requiredItems) items[name] = text(record(body.items) ? body.items[name] : undefined, 16000, action === 'submit');
      await db.canvasRoleWork.update({ where: { id: work.id }, data: { draft_text: content,
        snapshot_json: JSON.stringify({ ...JSON.parse(work.snapshot_json), draftContent: { text: content, items, attachments } }) } });
      if (action === 'draft') {
        next = 'working'; detail = { saved: true, submitted: false };
      } else {
        const inputDigest = workInputDigest(work, req);
        if (body.input_digest !== inputDigest) throw new RoleError('材料版本已变，请重新核对', 409, 'input_conflict');
        const count = await db.canvasRoleDelivery.count({ where: { work_id: work.id } });
        const delivery = await db.canvasRoleDelivery.create({ data: { id: randomUUID(), work_id: work.id,
          version: count + 1, requirements_revision: run.requirements_revision, content_json: JSON.stringify({ text: content, items, attachments }),
          input_digest: inputDigest, submitted_by: user.id, submission_kind: snap.executor.kind === 'person' ? 'person' : 'owner_proxy' } });
        deliveryId = delivery.id;
        next = work.reviewer_node_id ? 'review' : work.confirm_required ? 'confirmation' : 'delivered';
        detail = { deliveryVersion: delivery.version, submissionKind: delivery.submission_kind };
      }
    } else if (['approve', 'return', 'confirm', 'revise'].includes(action)) {
      await assertEffectiveInputs(db, work, req, document.document_json, user);
      if (deliveryId) {
        const checked = await db.canvasRoleDelivery.findFirst({ where: { id: deliveryId, work_id: work.id } });
        if (!checked) throw new RoleError('指定成果版本不可用', 409, 'delivery_conflict');
        await assertDeliveryOriginals(db, user, JSON.parse(checked.content_json));
      }
      if (action === 'revise') {
        if (work.phase !== 'delivered') throw new RoleError('只有已交付工作可以继续修订', 409, 'phase_conflict');
      } else {
        if (!deliveryId || body.delivery_id !== deliveryId || body.input_digest !== workInputDigest(work, req)) {
          throw new RoleError('成果或材料版本已变，请重新打开待审成果', 409, 'delivery_conflict');
        }
        if (action === 'confirm' && work.phase !== 'confirmation') throw new RoleError('此成果当前不待本人确认', 409, 'phase_conflict');
        if (['approve', 'return'].includes(action)) {
          if (action === 'approve' && work.phase !== 'review') throw new RoleError('检查已经完成，请使用本人确认', 409, 'phase_conflict');
          if (!['review', 'confirmation'].includes(work.phase)) throw new RoleError('此成果当前不待检查', 409, 'phase_conflict');
          if (work.phase === 'review' && work.reviewer_node_id) {
            const reviewer = (await latestWorks(db, run.id, run.requirements_revision)).find(w => w.node_id === work.reviewer_node_id);
            if (!reviewer) throw new RoleError('指定检查者已失效', 403, 'reviewer_unavailable');
            assertLiveNode(reviewer, document.document_json);
            const executor: RoleSnapshot['executor'] = JSON.parse(reviewer.snapshot_json).role.executor;
            if (executor.kind !== 'person' && !(p.ownerMayReview && body.owner_proxy === true)) throw new RoleError('需要指定检查者，或明确允许本人代检查', 403, 'review_not_authorized');
            if (executor.kind === 'person' && executor.userId !== user.id) throw new RoleError('不是本次检查者', 403, 'reviewer_mismatch');
          }
        }
      }
      detail = { opinion: text(body.opinion, 16000, action === 'return'), deliveryId,
        actualActor: user.id, attribution: body.owner_proxy === true ? 'owner_proxy_review' : 'person_review' };
      if (action === 'return' || action === 'revise') {
        if (work.round >= run.max_rounds) throw new RoleError('已到本次修订上限，请负责人调整任务，不能自动加次数', 409, 'round_limit');
        const original = deliveryId ? await db.canvasRoleDelivery.findFirst({ where: { id: deliveryId, work_id: work.id, requirements_revision: work.requirements_revision } }) : null;
        if (!original) throw new RoleError('原成果版本不存在，不能以旧草稿替代', 409, 'delivery_conflict');
        const originalContent = JSON.parse(original.content_json);
        const originalAttachments = (originalContent.attachments || []).map((attachment: JsonRecord, index: number) => ({ ...attachment,
          selection: { sourceDeliveryId: original.id, index } }));
        successor = await makeWork(db, user, run.id, run.requirements_revision, p, document.document_json, work.round + 1, work);
        successor = await db.canvasRoleWork.update({ where: { id: successor.id }, data: { phase: 'revision', inputs_json: work.inputs_json,
          draft_text: originalContent.text || '', wait_reason: String(detail.opinion || '') || null,
          snapshot_json: JSON.stringify({ ...JSON.parse(successor.snapshot_json),
            draftContent: { ...originalContent, attachments: originalAttachments },
            revisionSource: { deliveryId: original.id, content: originalContent, opinion: detail.opinion, readonly: true } }) } });
        await db.canvasRoleTaskRun.update({ where: { id: run.id }, data: { status: 'active', revision: { increment: 1 } } });
        const affected = new Set([work.node_id]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const target of req.participants) if (!affected.has(target.nodeId) && target.dependencies.some(dep => affected.has(dep.nodeId))) {
            affected.add(target.nodeId); changed = true;
          }
        }
        for (const target of (await latestWorks(db, run.id, run.requirements_revision)).filter(w => affected.has(w.node_id) && w.node_id !== work.node_id)) {
          if (target.round >= run.max_rounds) throw new RoleError('受影响角色已到修订上限，请调整任务', 409, 'round_limit');
          if (await db.canvasRoleAttempt.count({ where: { work_id: target.id, state: { in: ['reserved', 'sending', 'unknown'] } } })) throw new RoleError('下游尚有未确认请求，不能替换工作版本', 409, 'attempt_unresolved');
          await db.canvasRoleWork.update({ where: { id: target.id }, data: { phase: 'superseded', revision: { increment: 1 } } });
          await makeWork(db, user, run.id, run.requirements_revision, participant(req, target.node_id), document.document_json, target.round + 1, target);
          await event(db, user, run.id, run.requirements_revision, 'upstream_revision', target.id, { sourceWorkId: work.id, oldDeliveryNotEffective: true });
        }
        next = action === 'return' ? 'superseded' : 'delivered';
      } else next = action === 'approve' && work.confirm_required && work.phase === 'review' ? 'confirmation' : 'delivered';
    } else throw new RoleError('不支持此角色工作动作');
    const updated = await db.canvasRoleWork.updateMany({ where: { id: work.id, revision: work.revision },
      data: { phase: next, current_delivery_id: deliveryId, revision: { increment: 1 } } });
    if (updated.count !== 1) throw new RoleError('工作已在其他页面更新，请保留草稿', 409, 'revision_conflict');
    if (action !== 'message') await event(db, user, run.id, run.requirements_revision, action, work.id,
      { ...detail, beforePhase, phase: next, successorWorkId: successor?.id || null }, deliveryId || undefined);
    if (next === 'delivered' && !successor) {
      await finalizeDelivered(db, user, run, req);
    }
    return { objectId: work.id, result: { work: await db.canvasRoleWork.findUnique({ where: { id: work.id } }), successor } };
  });
}
