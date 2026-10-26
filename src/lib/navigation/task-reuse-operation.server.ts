import 'server-only';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { getProjectAccess } from '@/lib/projects/permissions';
import { isTaskHiddenFromRegularUsers } from '@/lib/tasks/retention';
import { canUseDirectAsset, assertCanUseReferenceImage } from '@/lib/reference-albums/permissions';
import { normalizeWorkspaceTabId } from '@/lib/assets/workspace';
import { canonicalTaskReuseOperation, parseTaskReuseOperationRequest, type TaskReuseOperationRequest,
  type TaskReuseOperationStatus, type TaskReuseWorkspaceItem } from './task-reuse-intent';

type Db = Prisma.TransactionClient;
type PreparedItem = { assetId: string; referenceImageId: string | null; role: string };
type Payload = Record<string, unknown>;
type Stored = { version: 2; ownerId: string; sourceTaskId: string; request: TaskReuseOperationRequest;
  status: 'applied' | 'rejected' | 'closed'; at: string; httpStatus: number; payload: Payload };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const keyFor = (ownerId: string, requestId: string) => 'task_reuse_operation_v2:' + digest(JSON.stringify([ownerId, requestId]));
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
export const taskReusePrivateHeaders = headers;
export class TaskReuseOperationError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
export function taskReuseRequest(value: unknown, ownerId: string, sourceTaskId: string, tabHeader: string | null) {
  const request = parseTaskReuseOperationRequest(value);
  if (!request) throw new TaskReuseOperationError('REUSE_PROTOCOL_UPGRADE_REQUIRED', '复用协议已更新，请刷新后保留原输入再操作；旧结果待确认记录不能直接结束。', 426);
  if (normalizeWorkspaceTabId(tabHeader) !== request.tabId || digest(canonicalTaskReuseOperation(ownerId, sourceTaskId, request)) !== request.requestHash)
    throw new TaskReuseOperationError('REUSE_REQUEST_INVALID', '复用请求与原工作现场不一致，当前输入未改变。', 400);
  return request;
}
function operation(stored: Pick<Stored, 'status' | 'sourceTaskId' | 'request'>): TaskReuseOperationStatus {
  const { protocolVersion, requestId, nonce, requestHash, surface, tabId, workspaceId } = stored.request;
  return { protocolVersion, requestId, nonce, requestHash, surface, tabId, workspaceId,
    sourceTaskId: stored.sourceTaskId, status: stored.status, canClose: false };
}
async function readStored(db: Db, ownerId: string, sourceTaskId: string, request: Pick<TaskReuseOperationRequest, 'requestId' | 'requestHash' | 'nonce' | 'tabId' | 'surface' | 'workspaceId'>) {
  const row = await db.platformSetting.findUnique({ where: { key: keyFor(ownerId, request.requestId) } });
  if (!row) return null;
  let value: Stored;
  try { value = JSON.parse(row.value_json); } catch { throw new TaskReuseOperationError('REUSE_RECEIPT_UNREADABLE', '原复用结果暂时无法核对，请保留原操作号。', 503); }
  if (value.version !== 2 || value.ownerId !== ownerId || !parseTaskReuseOperationRequest(value.request)
    || !['applied', 'rejected', 'closed'].includes(value.status) || !Number.isFinite(Date.parse(value.at)))
    throw new TaskReuseOperationError('REUSE_RECEIPT_UNREADABLE', '原复用结果暂时无法核对，请保留原操作号。', 503);
  if (value.sourceTaskId !== sourceTaskId || ['requestHash', 'nonce', 'tabId', 'surface', 'workspaceId'].some(field =>
    value.request[field as keyof typeof request] !== request[field as keyof typeof request]))
    throw new TaskReuseOperationError('REUSE_REQUEST_CONFLICT', '同一个复用操作号不能用于不同输入或工作区。');
  return value;
}
const sourceFields = ['id', 'project_id', 'owner_user_id', 'user_id', 'retention_status', 'source_metadata_json', 'params_json', 'snapshot_id',
  'provider', 'prompt', 'generation_mode', 'model', 'ratio', 'duration', 'resolution', 'seed', 'generate_audio', 'return_last_frame', 'watermark',
  'reference_image_ids', 'reference_image_urls', 'reference_video_urls', 'reference_audio_urls', 'first_frame_url', 'last_frame_url', 'frame_image_urls'];
export const taskReuseSourceStamp = (value: object) => digest(JSON.stringify(sourceFields.map(field => (value as Record<string, unknown>)[field] ?? null)));
async function assertSource(db: Db, user: SessionUser, sourceTaskId: string, stamp?: string) {
  const actor = await db.user.findUnique({ where: { id: user.id }, select: { status: true, role: true, account_type: true } });
  if (!actor || actor.status !== 'active' || actor.role !== user.role || actor.account_type !== user.account_type) throw new AuthError('账号权限已变化', 403);
  const task = await db.videoTask.findUnique({ where: { id: sourceTaskId } });
  if (!task || user.role !== 'admin' && isTaskHiddenFromRegularUsers(task)) throw new AuthError('任务不存在或已删除', 404);
  if (user.role !== 'admin') {
    const allowed = task.project_id ? (await getProjectAccess(user, task.project_id, db)).canView : (task.owner_user_id || task.user_id) === user.id;
    if (!allowed) throw new AuthError('原任务当前无权读取', 403);
  }
  if (stamp && taskReuseSourceStamp(task) !== stamp) throw new TaskReuseOperationError('REUSE_SOURCE_CHANGED', '原任务输入已变化，当前工作区未改变。');
}
async function assertItems(db: Db, user: SessionUser, items: Array<Pick<TaskReuseWorkspaceItem, 'assetId' | 'referenceImageId'>>) {
  for (const item of items) {
    const asset = await db.asset.findUnique({ where: { id: item.assetId }, select: { status: true } });
    if (!asset || asset.status !== 'active') throw new AuthError('原素材已不可用', 403);
    if (item.referenceImageId) {
      const reference = await assertCanUseReferenceImage(user, item.referenceImageId, db);
      if (reference.asset_id !== item.assetId) throw new AuthError('素材来源绑定已变化', 403);
    } else if (!await canUseDirectAsset(user, item.assetId, db)) throw new AuthError('原素材当前无权使用', 403);
  }
}
const workspaceItems = async (db: Db, workspaceId: string): Promise<TaskReuseWorkspaceItem[]> => (await db.workspaceAsset.findMany({
  where: { workspace_id: workspaceId }, orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
  select: { id: true, asset_id: true, reference_image_id: true, role: true, sort_order: true },
})).map(item => ({ id: item.id, assetId: item.asset_id, referenceImageId: item.reference_image_id, role: item.role, sortOrder: item.sort_order }));
async function result(db: Db, user: SessionUser, value: Stored) {
  const reuse = operation(value);
  if (value.status === 'applied') {
    try { await assertSource(db, user, value.sourceTaskId); await assertItems(db, user, value.payload.workspace_assets as TaskReuseWorkspaceItem[]); }
    catch (error) {
      if (!(error instanceof AuthError)) throw error;
      return { status: 200, body: { reuse: { ...reuse, code: 'REUSE_RESULT_UNAVAILABLE', message: '服务器已完成原复用；部分内容当前无权读取，当前草稿未替换。' } } };
    }
  }
  return { status: value.httpStatus, body: { ...value.payload, reuse } };
}
export async function readTaskReuseOperation(user: SessionUser, sourceTaskId: string, request: Pick<TaskReuseOperationRequest, 'requestId' | 'requestHash' | 'nonce' | 'tabId' | 'surface' | 'workspaceId'>) {
  const value = await readStored(prisma, user.id, sourceTaskId, request);
  return value ? result(prisma, user, value) : { status: 200, body: { reuse: { ...request, protocolVersion: 2,
    sourceTaskId, status: 'unknown', canClose: true } } };
}
export async function finishTaskReuseOperation(user: SessionUser, sourceTaskId: string, request: TaskReuseOperationRequest,
  input: { close: true } | { sourceStamp: string; items: PreparedItem[]; payload: Payload; rejection?: { code: string; message: string; status: number } }) {
  const startedAt = Date.now(), correlation = digest(user.id + ':' + request.requestId).slice(0, 16);
  const log = (phase: string, error?: unknown) => console.info('[TaskReuseOperation]', JSON.stringify({ correlation, role: process.env.PROCESS_ROLE || 'web',
    pid: process.pid, phase, at: Date.now(), elapsedMs: Date.now() - startedAt, code: (error as { code?: string } | undefined)?.code || null }));
  log('transaction_requested');
  try {
    return await prisma.$transaction(async tx => {
      log('transaction_entered');
      const prior = await readStored(tx, user.id, sourceTaskId, request);
      if (prior) {
        const original = await result(tx, user, prior);
        return prior.status === 'closed' && !('close' in input) ? { ...original, status: 409 } : original;
      }
      const workspace = await tx.workspace.findFirst({ where: { id: request.workspaceId, owner_id: user.id, status: 'active', name: `默认工作台:${request.tabId}` } });
      if (!workspace) throw new TaskReuseOperationError('REUSE_WORKSPACE_CHANGED', '原工作区已变化，未覆盖其它工作区。');
      let status: Stored['status'] = 'closed', httpStatus = 200, payload: Payload = { code: 'REUSE_OPERATION_CLOSED', message: '已结束等待，当前输入保留；迟到的原操作不会再应用。' };
      if (!('close' in input)) {
        try {
          await assertSource(tx, user, sourceTaskId, input.sourceStamp);
          const current = await workspaceItems(tx, request.workspaceId);
          const canonical = (items: TaskReuseWorkspaceItem[]) => JSON.stringify([...items].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          if (canonical(current) !== canonical(request.expectedWorkspaceAssets)) throw new TaskReuseOperationError('REUSE_WORKSPACE_CONFLICT', '参考区已被更新，未覆盖后来编辑。');
          if (input.rejection) throw new TaskReuseOperationError(input.rejection.code, input.rejection.message, input.rejection.status);
          await assertItems(tx, user, input.items);
          await tx.workspaceAsset.deleteMany({ where: { workspace_id: request.workspaceId } });
          if (input.items.length) await tx.workspaceAsset.createMany({ data: input.items.map((item, index) => ({ workspace_id: request.workspaceId,
            asset_id: item.assetId, reference_image_id: item.referenceImageId, role: item.role, sort_order: index })) });
          status = 'applied'; payload = { ...input.payload, workspace_id: request.workspaceId, workspace_assets: await workspaceItems(tx, request.workspaceId) };
        } catch (error) {
          if (!(error instanceof TaskReuseOperationError) && !(error instanceof AuthError)) throw error;
          status = 'rejected'; httpStatus = error.status;
          payload = { code: error instanceof TaskReuseOperationError ? error.code : 'REUSE_PERMISSION_CHANGED', error: error.message, message: error.message };
        }
      }
      const value: Stored = { version: 2, ownerId: user.id, sourceTaskId, request, status, at: new Date().toISOString(), httpStatus, payload };
      await tx.platformSetting.create({ data: { key: keyFor(user.id, request.requestId), value_json: JSON.stringify(value), updated_by: user.id } });
      return { status: httpStatus, body: { ...payload, reuse: operation(value) } };
    });
  } catch (error) { log('transaction_failed', error); throw error; }
  finally { log('transaction_finished'); }
}

const LEGACY_REUSE_WRITER_PROOF_KEY = 'task_reuse_legacy_writer_proof_v1';
export async function legacyTaskReuseCloseCapability(user: SessionUser, tabId: string, workspaceId: string) {
  const workspace = await prisma.workspace.findFirst({ where: { id: workspaceId, owner_id: user.id, status: 'active', name: `默认工作台:${tabId}` }, select: { id: true } });
  if (!workspace) throw new TaskReuseOperationError('REUSE_WORKSPACE_CHANGED', '原工作区已变化，当前输入保留。');
  const row = await prisma.platformSetting.findUnique({ where: { key: LEGACY_REUSE_WRITER_PROOF_KEY }, select: { value_json: true } });
  let proof: { version?: number; legacyWritersStopped?: boolean; unversionedWritesRejected?: boolean; releaseId?: string; proofSha256?: string; drainedAt?: string } = {};
  try { proof = JSON.parse(row?.value_json || '{}'); } catch {}
  const canClose = proof.version === 1 && proof.legacyWritersStopped === true && proof.unversionedWritesRejected === true
    && typeof proof.releaseId === 'string' && proof.releaseId.length > 0 && /^[a-f0-9]{64}$/.test(proof.proofSha256 || '') && Number.isFinite(Date.parse(proof.drainedAt || ''));
  return { canClose, proof, workspaceId: workspace.id };
}
export async function closeLegacyTaskReuseScope(user: SessionUser, sourceTaskId: string, tabId: string, workspaceId: string) {
  const capability = await legacyTaskReuseCloseCapability(user, tabId, workspaceId);
  if (!capability.canClose) throw new TaskReuseOperationError('REUSE_LEGACY_CLOSE_UNAVAILABLE', '旧写入尚未确认封口，请保留旧复用待核对。');
  return prisma.$transaction(async tx => {
    const actor = await tx.user.findUnique({ where: { id: user.id }, select: { status: true, role: true, account_type: true } });
    const workspace = await tx.workspace.findFirst({ where: { id: workspaceId, owner_id: user.id, status: 'active', name: `默认工作台:${tabId}` }, select: { id: true } });
    const proof = await tx.platformSetting.findUnique({ where: { key: LEGACY_REUSE_WRITER_PROOF_KEY }, select: { value_json: true } });
    if (!actor || actor.status !== 'active' || actor.role !== user.role || actor.account_type !== user.account_type || !workspace
      || proof?.value_json !== JSON.stringify(capability.proof)) throw new TaskReuseOperationError('REUSE_LEGACY_SCOPE_CHANGED', '原账号、工作区或发布证明已变化，未结束等待。');
    const key = `task_reuse_legacy_scope_closed_v1:${digest(JSON.stringify([user.id, tabId, workspaceId]))}`;
    const existing = await tx.platformSetting.findUnique({ where: { key }, select: { value_json: true } });
    if (!existing) await tx.platformSetting.create({ data: { key, updated_by: user.id, value_json: JSON.stringify({ version: 1, ownerId: user.id,
      tabId, workspaceId, sourceTaskId, status: 'closed', releaseId: capability.proof.releaseId, proofSha256: capability.proof.proofSha256, at: new Date().toISOString() }) } });
    return { code: 'REUSE_LEGACY_WAIT_CLOSED', legacy: true, closed: true, message: '已保留当前输入并结束旧复用等待；不代表原请求没有执行。' };
  });
}
