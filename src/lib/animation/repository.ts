import { createHash, randomUUID } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import type { Prisma, AnimationDocument as DbAnimationDocument } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { isExternalUser } from '@/lib/access/external-role';
import { assertAnimationProjectAccess, requireAnimationDocument } from './access';
import { AnimationError, requireMutationId } from './http';
import type {
  AnimationDocumentView,
  AnimationExportView,
  AnimationFileInfo,
  AnimationJobKind,
  AnimationJobParameters,
  AnimationJobStatus,
  AnimationJobView,
  AnimationPose,
  AnimationSequence,
  AnimationSummary,
} from './types';
import { validateAnimationSequence } from './schema';
import { ANIMATION_JOB_RESERVED_BYTES, ANIMATION_STORAGE_RESERVE_BYTES, getAnimationStorageRoot, hasAnimationStorageCapacity, preflightAnimationStorage } from './storage';

const DOCUMENT_PAGE_SIZE = 30;
const JOBS_IN_VIEW = 30;
const EXPORTS_IN_VIEW = 30;
const REVISIONS_IN_VIEW = 100;
export const ANIMATION_MAX_ACTIVE_JOBS = 16;
const ANIMATION_JOB_TIMEOUT_MS = 10 * 60 * 1000;

type Tx = Prisma.TransactionClient;
type AnimationViewReader = Pick<Tx, 'user' | 'animationFile' | 'animationJob' | 'animationExport' | 'animationRevision'>;

async function assertWriteAccessInTransaction(tx: Tx, userId: string, projectId: string, documentOwnerId: string, mode: 'write' | 'create') {
  const [user, project] = await Promise.all([
    tx.user.findUnique({ where: { id: userId }, select: { id: true, role: true, account_type: true, status: true, expires_at: true, feishu_user_id: true, feishu_open_id: true, feishu_union_id: true } }),
    tx.project.findUnique({
      where: { id: projectId },
      select: {
        id: true, type: true, status: true, owner_user_id: true,
        members: { where: { user_id: userId }, take: 1, select: { role: true, status: true } },
      },
    }),
  ]);
  if (!user || user.status !== 'active' || isExternalUser({
    role: user.role,
    account_type: user.account_type,
    feishu: { user_id: user.feishu_user_id, open_id: user.feishu_open_id, union_id: user.feishu_union_id },
  }) || (user.expires_at && user.expires_at.getTime() <= Date.now())) {
    throw new AnimationError('登录或账号状态已失效', 401, 'UNAUTHENTICATED');
  }
  if (!project || project.status === 'deleted') throw new AnimationError('项目不存在', 404, 'NOT_FOUND');
  const activeProject = project.status === 'active' && project.type !== 'system';
  let canView = false;
  let canGenerate = false;
  let canManageAssets = false;
  if (user.role === 'admin') {
    canView = true;
    canGenerate = activeProject;
    canManageAssets = activeProject;
  } else {
    const member = ['team', 'public'].includes(project.type) ? project.members[0] : undefined;
    const role = project.owner_user_id === userId ? 'project_owner' : member?.status === 'active' ? member.role : null;
    canView = Boolean(role);
    canGenerate = canView && activeProject && role !== 'viewer';
    canManageAssets = activeProject && (role === 'project_owner' || role === 'editor');
  }
  if (mode === 'create' ? !canGenerate : !canManageAssets && !(documentOwnerId === userId && canGenerate)) {
    throw new AnimationError('项目访问权限已变化', 403, 'FORBIDDEN');
  }
  return { canGenerate, canManageAssets };
}

function jsonOr<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export function canonicalAnimationJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalize(nested)]));
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

export function animationRequestHash(value: unknown) {
  return createHash('sha256').update(canonicalAnimationJson(value)).digest('hex');
}

export async function getIdempotentResponse<T>(actorId: string, requestId: string, operation: string, requestHash: string): Promise<T | null> {
  const existing = await prisma.animationRequest.findUnique({
    where: { actor_user_id_request_id: { actor_user_id: actorId, request_id: requestId } },
  });
  if (!existing) return null;
  if (existing.operation !== operation || existing.request_hash !== requestHash) {
    throw new AnimationError('相同请求编号已用于不同内容', 409, 'IDEMPOTENCY_CONFLICT');
  }
  if (!existing.response_json) throw new AnimationError('请求正在恢复登记，请稍后重试', 503, 'RECONCILE_PENDING');
  return jsonOr<T | null>(existing.response_json, null);
}

async function recordRequest(
  tx: Tx,
  input: { actorId: string; requestId: string; operation: string; requestHash: string; documentId: string | null; response: unknown },
) {
  await tx.animationRequest.create({
    data: {
      id: randomUUID(),
      actor_user_id: input.actorId,
      request_id: input.requestId,
      operation: input.operation,
      request_hash: input.requestHash,
      document_id: input.documentId,
      response_json: JSON.stringify(input.response),
    },
  });
}

function fileView(file: { id: string; name: string; role: string; mime: string; bytes: number; sha256: string; width: number | null; height: number | null }): AnimationFileInfo {
  return { id: file.id, name: file.name, role: file.role as AnimationFileInfo['role'], mime: file.mime, bytes: file.bytes, sha256: file.sha256, width: file.width, height: file.height };
}

function jobView(job: {
  id: string; kind: string; revision: number; status: string; stage: string; error_message: string | null;
  result_json: string | null; created_at: Date; updated_at: Date;
}): AnimationJobView {
  return {
    id: job.id,
    kind: job.kind as AnimationJobKind,
    revision: job.revision,
    status: job.status as AnimationJobStatus,
    stage: job.stage,
    error: job.error_message,
    result: jsonOr(job.result_json, null),
    created_at: job.created_at.toISOString(),
    updated_at: job.updated_at.toISOString(),
  };
}

function exportView(exported: {
  id: string; document_id: string; revision: number; mode: string; bytes: number; sha256: string; entry_count: number; total_ticks: number;
  created_at: Date; warnings_json: string;
}): AnimationExportView {
  return {
    id: exported.id,
    revision: exported.revision,
    mode: exported.mode as AnimationExportView['mode'],
    bytes: exported.bytes,
    sha256: exported.sha256,
    entry_count: exported.entry_count,
    total_ticks: exported.total_ticks,
    download_url: `/api/animation/exports/${encodeURIComponent(exported.id)}?document_id=${encodeURIComponent(exported.document_id)}`,
    created_at: exported.created_at.toISOString(),
    warnings: jsonOr(exported.warnings_json, []),
  };
}

async function buildAnimationDocumentView(
  reader: AnimationViewReader,
  document: DbAnimationDocument,
  canEdit: boolean,
  canManage: boolean,
): Promise<AnimationDocumentView> {
  const [owner, files, jobs, exports, revisions] = await Promise.all([
    reader.user.findUnique({ where: { id: document.owner_user_id }, select: { name: true, avatar_url: true } }),
    reader.animationFile.findMany({ where: { document_id: document.id, project_id: document.project_id }, orderBy: [{ created_at: 'asc' }, { id: 'asc' }] }),
    reader.animationJob.findMany({ where: { document_id: document.id, project_id: document.project_id }, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: JOBS_IN_VIEW }),
    reader.animationExport.findMany({ where: { document_id: document.id, project_id: document.project_id }, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: EXPORTS_IN_VIEW }),
    reader.animationRevision.findMany({ where: { document_id: document.id }, orderBy: { revision: 'desc' }, take: REVISIONS_IN_VIEW, select: { revision: true, created_at: true } }),
  ]);
  const sequence = jsonOr<AnimationSequence | null>(document.sequence_json, null);
  if (!sequence) throw new AnimationError('动画数据不可读取', 500, 'CORRUPT_DOCUMENT');
  return {
    id: document.id,
    project_id: document.project_id,
    owner_id: document.owner_user_id,
    owner_name: owner?.name || '未知用户',
    owner_avatar: owner?.avatar_url || null,
    title: document.title,
    revision: document.revision,
    status: document.status as AnimationDocumentView['status'],
    can_edit: canEdit,
    can_manage: canManage,
    sequence,
    files: files.map(fileView),
    jobs: jobs.map(jobView),
    exports: exports.map(exportView),
    revisions: revisions.map((revision) => ({ revision: revision.revision, created_at: revision.created_at.toISOString() })).reverse(),
    review_status: document.review_status as AnimationDocumentView['review_status'],
    review_revision: document.review_revision,
    review_note: document.review_note,
    game_status: document.game_status as AnimationDocumentView['game_status'],
    updated_at: document.updated_at.toISOString(),
  };
}

export async function getAnimationDocumentView(user: SessionUser, documentId: string): Promise<AnimationDocumentView> {
  const { document, canEdit, canManage } = await requireAnimationDocument(user, documentId, 'view');
  return buildAnimationDocumentView(prisma, document, canEdit, canManage);
}

function safeCursor(value: string) {
  if (value.length > 512) throw new AnimationError('分页参数无效', 400, 'INVALID_CURSOR');
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { updated_at?: string; id?: string };
    const updated = parsed.updated_at ? new Date(parsed.updated_at) : null;
    if (!parsed.id || !updated || !Number.isFinite(updated.getTime())) throw new Error('invalid cursor');
    return { updated_at: updated, id: parsed.id };
  } catch {
    throw new AnimationError('分页参数无效', 400, 'INVALID_CURSOR');
  }
}

export async function listAnimationDocuments(user: SessionUser, input: { projectId?: string | null; status: 'active' | 'archived'; cursor?: string | null }) {
  const projectIds = input.projectId
    ? [input.projectId]
    : (await import('./access')).listAnimationProjects(user).then((projects) => projects.map((project) => project.id));
  const ids = await projectIds;
  if (input.projectId) await assertAnimationProjectAccess(user, input.projectId, 'view');
  if (!ids.length) return { documents: [] as AnimationSummary[], next_cursor: null as string | null };
  const cursor = input.cursor ? safeCursor(input.cursor) : null;
  const records = await prisma.animationDocument.findMany({
    where: {
      project_id: { in: ids },
      status: input.status,
      ...(cursor ? { OR: [{ updated_at: { lt: cursor.updated_at } }, { updated_at: cursor.updated_at, id: { lt: cursor.id } }] } : {}),
    },
    orderBy: [{ updated_at: 'desc' }, { id: 'desc' }],
    take: DOCUMENT_PAGE_SIZE + 1,
    select: { id: true, project_id: true, title: true, revision: true, status: true, sequence_json: true, owner_user_id: true, updated_at: true },
  });
  const hasNext = records.length > DOCUMENT_PAGE_SIZE;
  const page = records.slice(0, DOCUMENT_PAGE_SIZE);
  const ownerIds = Array.from(new Set(page.map((record) => record.owner_user_id)));
  const owners = await prisma.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true, avatar_url: true } });
  const ownerById = new Map(owners.map((owner) => [owner.id, owner]));
  const documents = page.map((record) => {
    const sequence = jsonOr<AnimationSequence | null>(record.sequence_json, null);
    const firstPose = sequence?.poses[0];
    const owner = ownerById.get(record.owner_user_id);
    return {
      id: record.id,
      project_id: record.project_id,
      title: record.title,
      revision: record.revision,
      status: record.status as AnimationSummary['status'],
      entry_count: sequence?.entries.length || 0,
      total_ticks: sequence?.entries.reduce((sum, entry) => sum + entry.hold_ticks, 0) || 0,
      thumbnail_url: firstPose ? `/api/animation/files/${encodeURIComponent(firstPose.file_id)}?document_id=${encodeURIComponent(record.id)}` : null,
      owner_name: owner?.name || '未知用户',
      owner_avatar: owner?.avatar_url || null,
      updated_at: record.updated_at.toISOString(),
    } satisfies AnimationSummary;
  });
  const last = page.at(-1);
  const next_cursor = hasNext && last
    ? Buffer.from(JSON.stringify({ updated_at: last.updated_at.toISOString(), id: last.id })).toString('base64url')
    : null;
  return { documents, next_cursor };
}

export async function getAnimationFileForDocument(user: SessionUser, documentId: string, fileId: string) {
  const { document } = await requireAnimationDocument(user, documentId, 'view');
  const file = await prisma.animationFile.findFirst({ where: { id: fileId, document_id: documentId, project_id: document.project_id } });
  if (!file) throw new AnimationError('文件不存在', 404, 'NOT_FOUND');
  return { ...file, info: fileView(file) };
}

export async function getAnimationExportForDocument(user: SessionUser, documentId: string, exportId: string) {
  const { document } = await requireAnimationDocument(user, documentId, 'view');
  const exported = await prisma.animationExport.findFirst({ where: { id: exportId, document_id: documentId, project_id: document.project_id } });
  if (!exported) throw new AnimationError('导出文件不存在', 404, 'NOT_FOUND');
  return exported;
}

export async function getAnimationJobForDocument(user: SessionUser, documentId: string, jobId: string) {
  const { document } = await requireAnimationDocument(user, documentId, 'view');
  const job = await prisma.animationJob.findFirst({ where: { id: jobId, document_id: documentId, project_id: document.project_id } });
  if (!job) throw new AnimationError('处理任务不存在', 404, 'NOT_FOUND');
  return jobView(job);
}

export async function findAnimationFileByHash(documentId: string, role: string, sha256: string) {
  const document = await prisma.animationDocument.findUnique({ where: { id: documentId }, select: { project_id: true } });
  if (!document) return null;
  return prisma.animationFile.findFirst({ where: { document_id: documentId, project_id: document.project_id, role, sha256 } });
}

export async function assertAnimationDocumentQuota(documentId: string, incomingBytes: number) {
  const [aggregate, count] = await Promise.all([
    prisma.animationFile.aggregate({ where: { document_id: documentId }, _sum: { bytes: true } }),
    prisma.animationFile.count({ where: { document_id: documentId } }),
  ]);
  if (count >= 256 || (aggregate._sum.bytes || 0) + incomingBytes > 1024 * 1024 * 1024) {
    throw new AnimationError('此动画已达到文件数量或容量上限', 413, 'DOCUMENT_QUOTA_EXCEEDED');
  }
}

export function animationFileInfoFromRow(file: { id: string; name: string; role: string; mime: string; bytes: number; sha256: string; width: number | null; height: number | null }) {
  return fileView(file);
}

async function validateSequence(value: unknown): Promise<AnimationSequence> {
  try {
    return await validateAnimationSequence(value);
  } catch (error) {
    if (error instanceof AnimationError) throw error;
    throw new AnimationError('动画序列内容无效', 422, 'INVALID_SEQUENCE');
  }
}

async function assertSequenceFileReferences(tx: Tx, document: Pick<DbAnimationDocument, 'id' | 'project_id'>, sequence: AnimationSequence) {
  const ids = new Set<string>();
  for (const pose of sequence.poses) {
    ids.add(pose.file_id);
    if (pose.mother_file_id) ids.add(pose.mother_file_id);
    if (pose.source.video_file_id) ids.add(pose.source.video_file_id);
  }
  for (const entry of sequence.entries) if (entry.reference_file_id) ids.add(entry.reference_file_id);
  if (!ids.size) return;
  const files = await tx.animationFile.findMany({
    where: { id: { in: Array.from(ids) }, document_id: document.id, project_id: document.project_id },
    select: { id: true, role: true, mime: true, width: true, height: true },
  });
  const fileById = new Map(files.map((file) => [file.id, file]));
  if (fileById.size !== ids.size) throw new AnimationError('序列引用了当前动画以外的文件', 422, 'INVALID_FILE_REFERENCE');
  const pngRoles = ['pose', 'mother', 'reference', 'candidate'];
  for (const pose of sequence.poses) {
    const frame = fileById.get(pose.file_id);
    if (!frame || !['pose', 'mother', 'candidate'].includes(frame.role) || frame.mime !== 'image/png'
      || frame.width !== pose.width || frame.height !== pose.height) {
      throw new AnimationError('帧图必须引用本动画已登记的 PNG 文件', 422, 'INVALID_FILE_REFERENCE');
    }
    const mother = pose.mother_file_id ? fileById.get(pose.mother_file_id) : null;
    if (pose.mother_file_id && (!mother || !pngRoles.includes(mother.role) || mother.mime !== 'image/png' || mother.width === null || mother.height === null)) {
      throw new AnimationError('母帧必须引用本动画已登记的 PNG 文件', 422, 'INVALID_FILE_REFERENCE');
    }
    const video = pose.source.video_file_id ? fileById.get(pose.source.video_file_id) : null;
    if (pose.source.video_file_id && (!video || video.role !== 'video' || video.mime !== 'video/mp4' || video.width === null || video.height === null)) {
      throw new AnimationError('来源视频必须引用本动画已登记的原片', 422, 'INVALID_FILE_REFERENCE');
    }
  }
  const poseIds = new Set(sequence.poses.map((pose) => pose.id));
  if (sequence.entries.some((entry) => !poseIds.has(entry.pose_id))) throw new AnimationError('动作条目引用了不存在的帧', 422, 'INVALID_SEQUENCE');
  for (const entry of sequence.entries) {
    const reference = entry.reference_file_id ? fileById.get(entry.reference_file_id) : null;
    if (entry.reference_file_id && (!reference || !pngRoles.includes(reference.role) || reference.mime !== 'image/png'
      || reference.width === null || reference.height === null)) {
      throw new AnimationError('参考图必须引用本动画已登记的 PNG 文件', 422, 'INVALID_FILE_REFERENCE');
    }
    if (entry.reference_geometry) {
      if (!reference || !entry.reference_file_id) throw new AnimationError('原作几何信息必须绑定登记的参考图', 422, 'INVALID_REFERENCE_GEOMETRY');
      const widthRatio = reference.width! / entry.reference_geometry.logical_width;
      const heightRatio = reference.height! / entry.reference_geometry.logical_height;
      const ppu = entry.reference_geometry.pixels_per_unit;
      const tolerance = Math.max(1e-6, ppu * 1e-6);
      if (Math.abs(widthRatio - ppu) > tolerance || Math.abs(heightRatio - ppu) > tolerance) {
        throw new AnimationError('原作几何与登记参考图尺寸不一致', 422, 'INVALID_REFERENCE_GEOMETRY');
      }
    }
  }
}

export function preserveSequenceInvariants(
  previous: AnimationSequence,
  candidate: AnimationSequence,
  options: { allowRestoreRemovals?: boolean } = {},
): AnimationSequence {
  const next = structuredClone(candidate);
  const oldById = new Map(previous.entries.map((entry) => [entry.id, entry]));
  const oldPoses = new Map(previous.poses.map((pose) => [pose.id, pose]));
  const nextPoses = new Map(next.poses.map((pose) => [pose.id, pose]));
  const hasLockedEntries = previous.entries.some((entry) => entry.locked);
  if (hasLockedEntries && previous.global_scale !== next.global_scale) {
    throw new AnimationError('请先单独解锁受影响的帧，再修改整体缩放', 409, 'ENTRY_LOCKED');
  }
  const geometryFields = ['file_id', 'mother_file_id', 'width', 'height', 'logical_width', 'logical_height', 'pixels_per_unit'] as const;
  const lockedPoseIds = new Set(previous.entries.filter((entry) => entry.locked).map((entry) => entry.pose_id));
  for (const oldPose of previous.poses) {
    const nextPose = nextPoses.get(oldPose.id);
    if (!nextPose && lockedPoseIds.has(oldPose.id)) {
      throw new AnimationError('请先单独解锁该帧，再删除其原作帧图', 409, 'ENTRY_LOCKED');
    }
    if (!nextPose && !options.allowRestoreRemovals) {
      throw new AnimationError('原有帧不可删除；新增候选后只更改动作条目的pose_id', 409, 'ORIGINAL_GEOMETRY_IMMUTABLE');
    }
    if (nextPose && !lockedPoseIds.has(oldPose.id) && geometryFields.some((field) => oldPose[field] !== nextPose[field])) {
      throw new AnimationError('原作帧图与逻辑尺寸基线不可改写；候选图应新增帧并单独选择', 409, 'ORIGINAL_GEOMETRY_IMMUTABLE');
    }
  }
  for (const entry of next.entries) {
    const old = oldById.get(entry.id);
    if (!old) {
      entry.original_hold_ticks = entry.hold_ticks;
      continue;
    }
    if (entry.reference_file_id !== old.reference_file_id) {
      throw new AnimationError('原作参考图不可替换', 409, 'REFERENCE_BASELINE_IMMUTABLE');
    }
    if (canonicalAnimationJson(entry.reference_geometry ?? null) !== canonicalAnimationJson(old.reference_geometry ?? null)) {
      throw new AnimationError('原作几何基线不可修改', 409, 'REFERENCE_BASELINE_IMMUTABLE');
    }
    if (entry.original_hold_ticks !== old.original_hold_ticks) {
      throw new AnimationError('原始时值基线不可修改', 409, 'HOLD_BASELINE_IMMUTABLE');
    }
    entry.original_hold_ticks = old.original_hold_ticks;
    if (old.locked) {
      const before = { ...old, locked: false };
      const after = { ...entry, locked: false };
      const oldPose = oldPoses.get(old.pose_id);
      const nextPose = nextPoses.get(entry.pose_id);
      const poseChanged = !oldPose || !nextPose || canonicalAnimationJson(oldPose) !== canonicalAnimationJson(nextPose);
      if (canonicalAnimationJson(before) !== canonicalAnimationJson(after) || poseChanged) {
        throw new AnimationError('请先单独解锁该帧，再修改帧图、时值或变换', 409, 'ENTRY_LOCKED');
      }
    } else if (entry.pose_id !== old.pose_id) {
      const previousSelection = { ...old, pose_id: null };
      const nextSelection = { ...entry, pose_id: null };
      if (canonicalAnimationJson(previousSelection) !== canonicalAnimationJson(nextSelection)) {
        throw new AnimationError('选择候选帧时只能更改pose_id，原作引用与帧参数保持不变', 409, 'CANDIDATE_SELECTION_ONLY');
      }
    }
  }
  const nextById = new Map(next.entries.map((entry) => [entry.id, entry]));
  for (const entry of previous.entries) {
    if (nextById.has(entry.id)) continue;
    if (entry.locked) throw new AnimationError('请先单独解锁该帧，再删除动作条目', 409, 'ENTRY_LOCKED');
    if (entry.reference_file_id || entry.reference_geometry) {
      throw new AnimationError('原作参考基线对应的动作条目不可删除', 409, 'REFERENCE_BASELINE_IMMUTABLE');
    }
    if (!options.allowRestoreRemovals) {
      throw new AnimationError('原有动作条目编号与时值基线不可删除重建', 409, 'ENTRY_ID_IMMUTABLE');
    }
  }
  return next;
}

function mapMutationConflict(error: unknown): never {
  const code = (error as { code?: unknown })?.code;
  if (code === 'P2002') throw new AnimationError('操作编号已被并发请求使用，请刷新后重试', 409, 'IDEMPOTENCY_CONFLICT');
  throw error;
}

async function currentCachedResponse<T>(actorId: string, requestId: string, operation: string, requestHash: string) {
  return getIdempotentResponse<T>(actorId, requestId, operation, requestHash);
}

export async function createImportedAnimationDocument(input: {
  user: SessionUser;
  documentId?: string;
  projectId: string;
  requestId: string;
  requestHash: string;
  sequence: AnimationSequence;
  title: string;
  files: Array<AnimationFileInfo & { blob_key: string }>;
}) {
  const operation = `import:${input.projectId}`;
  const access = await assertAnimationProjectAccess(input.user, input.projectId, 'create');
  const cached = await currentCachedResponse<{ success: true; document: AnimationDocumentView }>(input.user.id, input.requestId, operation, input.requestHash);
  if (cached) return { ...cached, document: { ...cached.document, can_edit: access.canGenerate, can_manage: access.canManageAssets } };
  const sequence = await validateSequence(input.sequence);
  const documentId = input.documentId || randomUUID();
  const revisionId = randomUUID();
  const createdAt = new Date();
  const title = input.title.trim().slice(0, 160) || '未命名动画';
  const response: { success: true; document: AnimationDocumentView } = {
    success: true,
    document: {
      id: documentId,
      project_id: input.projectId,
      owner_id: input.user.id,
      owner_name: input.user.name,
      owner_avatar: input.user.avatar_url || null,
      title,
      revision: 1,
      status: 'active',
      can_edit: access.canGenerate,
      can_manage: access.canManageAssets,
      sequence,
      files: input.files.map((file) => {
        const { blob_key: _blobKey, ...info } = file;
        return info;
      }),
      jobs: [],
      exports: [],
      revisions: [{ revision: 1, created_at: createdAt.toISOString() }],
      review_status: 'unsubmitted',
      review_revision: null,
      review_note: '',
      game_status: 'unverified',
      updated_at: createdAt.toISOString(),
    },
  };
  try {
    await prisma.$transaction(async (tx) => {
      await assertWriteAccessInTransaction(tx, input.user.id, input.projectId, input.user.id, 'create');
      const document = await tx.animationDocument.create({
        data: {
          id: documentId,
          project_id: input.projectId,
          owner_user_id: input.user.id,
          title,
          status: 'active',
          revision: 1,
          sequence_json: JSON.stringify(sequence),
          review_status: 'unsubmitted',
          review_revision: null,
          review_note: '',
          game_status: 'unverified',
          created_at: createdAt,
          updated_at: createdAt,
        },
      });
      for (const file of input.files) {
        await tx.animationFile.create({ data: { ...file, document_id: documentId, project_id: input.projectId, created_by: input.user.id } });
      }
      await assertSequenceFileReferences(tx, document, sequence);
      await tx.animationRevision.create({
        data: { id: revisionId, document_id: documentId, revision: 1, sequence_json: JSON.stringify(sequence), actor_user_id: input.user.id, reason: 'import', created_at: createdAt },
      });
      await recordRequest(tx, { actorId: input.user.id, requestId: input.requestId, operation, requestHash: input.requestHash, documentId, response });
    });
    return response;
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'P2002') {
      const freshAccess = await assertAnimationProjectAccess(input.user, input.projectId, 'create');
      const replay = await currentCachedResponse<{ success: true; document: AnimationDocumentView }>(input.user.id, input.requestId, operation, input.requestHash);
      if (replay) return { ...replay, document: { ...replay.document, can_edit: freshAccess.canGenerate, can_manage: freshAccess.canManageAssets } };
    }
    mapMutationConflict(error);
  }
}

type ReconcileResult = { resolved: true; cleanupBlobKeys: string[] };

function isStoredAnimationFile(value: unknown): value is AnimationFileInfo & { blob_key: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const file = value as Record<string, unknown>;
  const common = typeof file.id === 'string'
    && typeof file.name === 'string'
    && ['pose', 'mother', 'reference', 'video', 'candidate'].includes(String(file.role))
    && typeof file.mime === 'string'
    && Number.isSafeInteger(file.bytes) && Number(file.bytes) > 0
    && typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/.test(file.sha256)
    && typeof file.blob_key === 'string' && /^[0-9a-f-]{36}$/.test(file.blob_key);
  if (!common) return false;
  if (file.role === 'video') return file.mime === 'video/mp4' && Number.isSafeInteger(file.width) && Number(file.width) > 0 && Number.isSafeInteger(file.height) && Number(file.height) > 0;
  if (file.role === 'reference' && file.mime === 'application/zip') return file.width === null && file.height === null;
  return file.mime === 'image/png' && Number.isSafeInteger(file.width) && Number(file.width) > 0 && Number.isSafeInteger(file.height) && Number(file.height) > 0;
}

function validReconcileIdentity(value: Record<string, unknown>) {
  return typeof value.actor_user_id === 'string'
    && typeof value.request_id === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(value.request_id)
    && typeof value.operation === 'string' && value.operation.length <= 180
    && typeof value.request_hash === 'string' && /^[a-f0-9]{64}$/.test(value.request_hash);
}

export async function reconcileAnimationUploadManifest(value: Record<string, unknown>): Promise<ReconcileResult> {
  if (value.kind === 'document_import') {
    if (!validReconcileIdentity(value) || typeof value.document_id !== 'string' || typeof value.project_id !== 'string'
      || typeof value.title !== 'string' || !Array.isArray(value.files) || !value.files.every(isStoredAnimationFile)) {
      throw new AnimationError('恢复记录无效', 500, 'RECONCILE_INVALID');
    }
    const files = value.files;
    let cleanupBlobKeys = files.map((file) => file.blob_key);
    const sequence = await validateSequence(value.sequence);
    let artifactsUsed = false;
    try {
      await prisma.$transaction(async (tx) => {
        await assertWriteAccessInTransaction(tx, value.actor_user_id as string, value.project_id as string, value.actor_user_id as string, 'create');
        const prior = await tx.animationRequest.findUnique({
          where: { actor_user_id_request_id: { actor_user_id: value.actor_user_id as string, request_id: value.request_id as string } },
        });
        if (prior) {
          if (prior.operation !== value.operation || prior.request_hash !== value.request_hash || !prior.response_json) {
            throw new AnimationError('请求编号已用于其他内容', 409, 'IDEMPOTENCY_CONFLICT');
          }
          const referenced = await tx.animationFile.findMany({ where: { blob_key: { in: cleanupBlobKeys } }, select: { blob_key: true } });
          const referencedKeys = new Set(referenced.map((item) => item.blob_key));
          cleanupBlobKeys = cleanupBlobKeys.filter((key) => !referencedKeys.has(key));
          return;
        }
        const access = await assertWriteAccessInTransaction(tx, value.actor_user_id as string, value.project_id as string, value.actor_user_id as string, 'create');
        const createdAt = new Date();
        const document = await tx.animationDocument.create({
          data: {
            id: value.document_id as string,
            project_id: value.project_id as string,
            owner_user_id: value.actor_user_id as string,
            title: (value.title as string).trim().slice(0, 160) || '未命名动画',
            status: 'active', revision: 1, sequence_json: JSON.stringify(sequence),
            review_status: 'unsubmitted', review_revision: null, review_note: '', game_status: 'unverified',
            created_at: createdAt, updated_at: createdAt,
          },
        });
        for (const file of files) {
          await tx.animationFile.create({ data: { ...file, document_id: document.id, project_id: document.project_id, created_by: value.actor_user_id as string } });
        }
        await assertSequenceFileReferences(tx, document, sequence);
        await tx.animationRevision.create({
          data: { id: randomUUID(), document_id: document.id, revision: 1, sequence_json: JSON.stringify(sequence), actor_user_id: value.actor_user_id as string, reason: 'import', created_at: createdAt },
        });
        const response = {
          success: true as const,
          document: await buildAnimationDocumentView(tx, document, access.canGenerate, access.canManageAssets),
        };
        await recordRequest(tx, {
          actorId: value.actor_user_id as string,
          requestId: value.request_id as string,
          operation: value.operation as string,
          requestHash: value.request_hash as string,
          documentId: document.id,
          response,
        });
        artifactsUsed = true;
      });
      return { resolved: true, cleanupBlobKeys: artifactsUsed ? [] : cleanupBlobKeys };
    } catch (error) {
      if (error instanceof AnimationError && [401, 403, 404].includes(error.status)) return { resolved: true, cleanupBlobKeys };
      throw error;
    }
  }

  if (value.kind === 'candidate_file') {
    const file = value.file;
    if (!validReconcileIdentity(value) || typeof value.document_id !== 'string' || typeof value.project_id !== 'string'
      || !isStoredAnimationFile(file) || !['candidate', 'video'].includes(file.role)
      || (file.role === 'candidate' && (!value.pose || typeof value.pose !== 'object' || Array.isArray(value.pose)))) {
      throw new AnimationError('恢复记录无效', 500, 'RECONCILE_INVALID');
    }
    const candidate = file as AnimationFileInfo & { blob_key: string };
    let cleanupBlobKeys = [candidate.blob_key];
    let artifactUsed = false;
    try {
      await prisma.$transaction(async (tx) => {
        const alreadyRegistered = await tx.animationFile.findFirst({ where: { blob_key: candidate.blob_key }, select: { id: true } });
        if (alreadyRegistered) {
          cleanupBlobKeys = [];
          return;
        }
        let document = await requireActiveCandidateDocumentInTransaction(tx, value.document_id as string, value.project_id as string);
        await assertWriteAccessInTransaction(tx, value.actor_user_id as string, document.project_id, document.owner_user_id, 'write');
        const prior = await tx.animationRequest.findUnique({
          where: { actor_user_id_request_id: { actor_user_id: value.actor_user_id as string, request_id: value.request_id as string } },
        });
        if (prior) {
          if (prior.operation !== value.operation || prior.request_hash !== value.request_hash || !prior.response_json) {
            throw new AnimationError('请求编号已用于其他内容', 409, 'IDEMPOTENCY_CONFLICT');
          }
          const referenced = await tx.animationFile.findFirst({ where: { blob_key: candidate.blob_key }, select: { id: true } });
          if (referenced) cleanupBlobKeys = [];
          return;
        }
        const existing = await tx.animationFile.findFirst({
          where: { document_id: document.id, project_id: document.project_id, role: candidate.role, sha256: candidate.sha256 },
        });
        let persisted = existing;
        if (!persisted) {
          const [aggregate, count] = await Promise.all([
            tx.animationFile.aggregate({ where: { document_id: document.id }, _sum: { bytes: true } }),
            tx.animationFile.count({ where: { document_id: document.id } }),
          ]);
          if (count >= 256 || (aggregate._sum.bytes || 0) + candidate.bytes > 1024 * 1024 * 1024) {
            throw new AnimationError('此动画已达到文件数量或容量上限', 413, 'DOCUMENT_QUOTA_EXCEEDED');
          }
          document = await requireActiveCandidateDocumentInTransaction(tx, value.document_id as string, value.project_id as string);
          await assertWriteAccessInTransaction(tx, value.actor_user_id as string, document.project_id, document.owner_user_id, 'write');
          persisted = await tx.animationFile.create({
            data: { ...candidate, document_id: document.id, project_id: document.project_id, created_by: value.actor_user_id as string },
          });
          artifactUsed = true;
        }
        document = await requireActiveCandidateDocumentInTransaction(tx, value.document_id as string, value.project_id as string);
        await assertWriteAccessInTransaction(tx, value.actor_user_id as string, document.project_id, document.owner_user_id, 'write');
        const pose = value.pose && typeof value.pose === 'object' && !Array.isArray(value.pose)
          ? { ...(value.pose as Omit<AnimationPose, 'file_id'>), file_id: persisted.id } as AnimationPose
          : undefined;
        await recordRequest(tx, {
          actorId: value.actor_user_id as string,
          requestId: value.request_id as string,
          operation: value.operation as string,
          requestHash: value.request_hash as string,
          documentId: document.id,
          response: { success: true, file: fileView(persisted), ...(pose ? { pose } : {}) },
        });
      });
      return { resolved: true, cleanupBlobKeys: artifactUsed ? [] : cleanupBlobKeys };
    } catch (error) {
      if (error instanceof AnimationError && ([401, 403, 404].includes(error.status) || error.code === 'DOCUMENT_ARCHIVED')) {
        const referenced = await prisma.animationFile.findFirst({ where: { blob_key: candidate.blob_key }, select: { id: true } });
        if (referenced) cleanupBlobKeys = [];
        return { resolved: true, cleanupBlobKeys };
      }
      throw error;
    }
  }

  throw new AnimationError('恢复记录类型无效', 500, 'RECONCILE_INVALID');
}

type CreateAnimationCandidateFileInput = {
  user: SessionUser;
  documentId: string;
  requestId: string;
  requestHash: string;
  operation: string;
  metadata: AnimationFileInfo & { blob_key: string };
  candidatePose?: Omit<AnimationPose, 'file_id'>;
};

async function requireActiveCandidateDocumentInTransaction(tx: Tx, documentId: string, expectedProjectId: string) {
  const document = await tx.animationDocument.findUnique({ where: { id: documentId } });
  if (!document || document.project_id !== expectedProjectId) throw new AnimationError('动画记录不存在', 404, 'NOT_FOUND');
  if (document.status !== 'active') throw new AnimationError('已归档的动画不能添加文件', 409, 'DOCUMENT_ARCHIVED');
  return document;
}

export async function registerAnimationCandidateFileInTransaction(
  tx: Tx,
  input: CreateAnimationCandidateFileInput,
  expectedProjectId: string,
) {
  let document = await requireActiveCandidateDocumentInTransaction(tx, input.documentId, expectedProjectId);
  await assertWriteAccessInTransaction(tx, input.user.id, document.project_id, document.owner_user_id, 'write');
  const existing = await tx.animationFile.findFirst({
    where: { document_id: document.id, project_id: document.project_id, role: input.metadata.role, sha256: input.metadata.sha256 },
  });
  let file = existing;
  let persisted = false;
  if (!file) {
    const [aggregate, count] = await Promise.all([
      tx.animationFile.aggregate({ where: { document_id: document.id }, _sum: { bytes: true } }),
      tx.animationFile.count({ where: { document_id: document.id } }),
    ]);
    if (count >= 256 || (aggregate._sum.bytes || 0) + input.metadata.bytes > 1024 * 1024 * 1024) {
      throw new AnimationError('此动画已达到文件数量或容量上限', 413, 'DOCUMENT_QUOTA_EXCEEDED');
    }
    document = await requireActiveCandidateDocumentInTransaction(tx, input.documentId, expectedProjectId);
    await assertWriteAccessInTransaction(tx, input.user.id, document.project_id, document.owner_user_id, 'write');
    file = await tx.animationFile.create({
      data: { ...input.metadata, document_id: document.id, project_id: document.project_id, created_by: input.user.id },
    });
    persisted = true;
  }
  document = await requireActiveCandidateDocumentInTransaction(tx, input.documentId, expectedProjectId);
  await assertWriteAccessInTransaction(tx, input.user.id, document.project_id, document.owner_user_id, 'write');
  const pose = input.candidatePose ? { ...input.candidatePose, file_id: file.id } as AnimationPose : undefined;
  const response: { success: true; file: AnimationFileInfo; pose?: AnimationPose } = {
    success: true,
    file: fileView(file),
    ...(pose ? { pose } : {}),
  };
  await recordRequest(tx, {
    actorId: input.user.id,
    requestId: input.requestId,
    operation: input.operation,
    requestHash: input.requestHash,
    documentId: document.id,
    response,
  });
  return { response, persisted };
}

export async function createAnimationCandidateFile(input: CreateAnimationCandidateFileInput) {
  const { document } = await requireAnimationDocument(input.user, input.documentId, 'write');
  if (document.status !== 'active') throw new AnimationError('已归档的动画不能添加文件', 409, 'DOCUMENT_ARCHIVED');
  const cached = await currentCachedResponse<{ success: true; file: AnimationFileInfo; pose?: AnimationPose }>(input.user.id, input.requestId, input.operation, input.requestHash);
  if (cached) return { response: cached, persisted: false, cached: true };

  try {
    const result = await prisma.$transaction((tx) => registerAnimationCandidateFileInTransaction(tx, input, document.project_id));
    return { ...result, cached: false };
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'P2002') {
      await requireAnimationDocument(input.user, input.documentId, 'write');
      const replay = await currentCachedResponse<{ success: true; file: AnimationFileInfo; pose?: AnimationPose }>(input.user.id, input.requestId, input.operation, input.requestHash);
      if (replay) return { response: replay, persisted: false, cached: true };
    }
    throw error;
  }
}

function mutationInput(body: Record<string, unknown>) {
  const mutationId = requireMutationId(body.mutation_id);
  const hash = animationRequestHash(Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'mutation_id')));
  return { mutationId, hash };
}

export async function patchAnimationDocument(user: SessionUser, documentId: string, body: Record<string, unknown>) {
  const mutation = mutationInput(body);
  const operation = `patch:${documentId}`;
  const { canEdit, canManage } = await requireAnimationDocument(user, documentId, 'write');
  const cached = await currentCachedResponse<{ success: true; document: AnimationDocumentView }>(user.id, mutation.mutationId, operation, mutation.hash);
  if (cached) return { ...cached, document: { ...cached.document, can_edit: canEdit, can_manage: canManage } };
  const hasSequence = Object.prototype.hasOwnProperty.call(body, 'sequence');
  const hasRestore = Object.prototype.hasOwnProperty.call(body, 'restore_revision');
  if (hasSequence && hasRestore) throw new AnimationError('不能同时保存序列并恢复历史版本', 400, 'INVALID_REQUEST');
  if (body.status !== undefined && body.status !== 'active' && body.status !== 'archived') throw new AnimationError('动画状态无效', 400, 'INVALID_STATUS');
  if (!hasSequence && !hasRestore && body.status === undefined) throw new AnimationError('没有可保存的修改', 400, 'INVALID_REQUEST');
  const baseRevision = Number(body.base_revision);
  if (!Number.isInteger(baseRevision) || baseRevision < 1) throw new AnimationError('基础修订号无效', 400, 'INVALID_REVISION');

  try {
    const response = await prisma.$transaction(async (tx) => {
      const current = await tx.animationDocument.findUnique({ where: { id: documentId } });
      if (!current) throw new AnimationError('动画记录不存在', 404, 'NOT_FOUND');
      const grant = await assertWriteAccessInTransaction(tx, user.id, current.project_id, current.owner_user_id, 'write');
      if (current.revision !== baseRevision) throw new AnimationError('动画已被其他修改更新，请先刷新', 409, 'REVISION_CONFLICT', current.revision);
      const previous = await validateSequence(jsonOr(current.sequence_json, null));
      let nextSequence = previous;
      let reason = 'edit';
      if (hasRestore) {
        const restoreRevision = Number(body.restore_revision);
        if (!Number.isInteger(restoreRevision) || restoreRevision < 1) throw new AnimationError('恢复修订号无效', 400, 'INVALID_REVISION');
        const historical = await tx.animationRevision.findUnique({ where: { document_id_revision: { document_id: documentId, revision: restoreRevision } } });
        if (!historical) throw new AnimationError('要恢复的历史修订不存在', 404, 'REVISION_NOT_FOUND');
        const restored = await validateSequence(jsonOr(historical.sequence_json, null));
        nextSequence = preserveSequenceInvariants(previous, restored, { allowRestoreRemovals: true });
        reason = `restore:${restoreRevision}`;
      } else if (hasSequence) {
        const candidate = await validateSequence(body.sequence);
        nextSequence = preserveSequenceInvariants(previous, candidate);
      }
      await assertSequenceFileReferences(tx, current, nextSequence);
      const status = (body.status as string | undefined) || current.status;
      if (current.status === 'archived' && status === 'archived' && (hasSequence || hasRestore)) {
        throw new AnimationError('请先恢复归档动画，再修改序列', 409, 'DOCUMENT_ARCHIVED');
      }
      const changed = status !== current.status || canonicalAnimationJson(nextSequence) !== canonicalAnimationJson(previous);
      const nextRevision = current.revision + (changed ? 1 : 0);
      if (changed) {
        const changedRows = await tx.animationDocument.updateMany({
          where: { id: documentId, revision: baseRevision, status: current.status },
          data: {
            revision: nextRevision,
            status,
            sequence_json: JSON.stringify(nextSequence),
            review_status: 'unsubmitted',
            review_revision: null,
            review_note: '',
            game_status: 'unverified',
          },
        });
        if (changedRows.count !== 1) {
          const latest = await tx.animationDocument.findUnique({ where: { id: documentId }, select: { revision: true } });
          throw new AnimationError('动画已被其他修改更新，请先刷新', 409, 'REVISION_CONFLICT', latest?.revision);
        }
        await tx.animationRevision.create({
          data: { id: randomUUID(), document_id: documentId, revision: nextRevision, sequence_json: JSON.stringify(nextSequence), actor_user_id: user.id, reason },
        });
        if (status === 'archived') await cancelDocumentJobsInTransaction(tx, documentId, '动画已归档');
      }
      const updated = await tx.animationDocument.findUnique({ where: { id: documentId } });
      if (!updated) throw new AnimationError('动画记录不存在', 404, 'NOT_FOUND');
      const freshCanEdit = (current.owner_user_id === user.id && grant.canGenerate) || grant.canManageAssets;
      const view = await buildAnimationDocumentView(tx, updated, freshCanEdit, grant.canManageAssets);
      const result = { success: true as const, document: view };
      await recordRequest(tx, { actorId: user.id, requestId: mutation.mutationId, operation, requestHash: mutation.hash, documentId, response: result });
      return result;
    });
    return response;
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'P2002') {
      const freshAccess = await requireAnimationDocument(user, documentId, 'write');
      const replay = await currentCachedResponse<{ success: true; document: AnimationDocumentView }>(user.id, mutation.mutationId, operation, mutation.hash);
      if (replay) return { ...replay, document: { ...replay.document, can_edit: freshAccess.canEdit, can_manage: freshAccess.canManage } };
    }
    throw error;
  }
}

async function cancelDocumentJobsInTransaction(tx: Tx, documentId: string, message: string) {
  const reserved = await tx.animationJob.findMany({ where: { document_id: documentId, status: { in: ['queued', 'running'] }, queue_reserved: true }, select: { reserved_storage_bytes: true } });
  await tx.animationJob.updateMany({
    where: { document_id: documentId, status: { in: ['queued', 'running'] } },
    data: { status: 'cancelled', stage: 'cancelled', error_code: 'DOCUMENT_ARCHIVED', error_message: message, lease_token: null, lease_expires_at: null, queue_reserved: false, reserved_storage_bytes: BigInt(0) },
  });
  const reservedBytes = reserved.reduce((sum, job) => sum + job.reserved_storage_bytes, BigInt(0));
  if (reserved.length) {
    await tx.animationQueueState.updateMany({
      where: { id: 'global', active_count: { gte: reserved.length }, reserved_storage_bytes: { gte: reservedBytes } },
      data: { active_count: { decrement: reserved.length }, reserved_storage_bytes: { decrement: reservedBytes } },
    });
  }
}

export async function cancelAnimationDocumentJobs(tx: Tx, documentId: string, message: string) {
  return cancelDocumentJobsInTransaction(tx, documentId, message);
}

function parseJobParameters(kind: AnimationJobKind, value: unknown): AnimationJobParameters {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AnimationError('处理参数无效', 400, 'INVALID_PARAMETERS');
  const parameters = value as Record<string, unknown>;
  const allowed = new Set(kind === 'export' ? ['mode'] : ['video_file_id', 'frame_index']);
  if (Object.keys(parameters).some((key) => !allowed.has(key))) throw new AnimationError('处理参数包含不支持的字段', 400, 'INVALID_PARAMETERS');
  if (kind === 'export') {
    const mode = parameters.mode ?? 'work_copy';
    if (mode !== 'work_copy' && mode !== 'validated') throw new AnimationError('导出模式无效', 400, 'INVALID_PARAMETERS');
    return { mode };
  }
  if (typeof parameters.video_file_id !== 'string' || !parameters.video_file_id || !Number.isInteger(parameters.frame_index) || Number(parameters.frame_index) < 0) {
    throw new AnimationError('抽帧参数无效', 400, 'INVALID_PARAMETERS');
  }
  return { video_file_id: parameters.video_file_id, frame_index: Number(parameters.frame_index) };
}

async function reserveQueueInTransaction(tx: Tx, availableBytes: bigint) {
  await tx.animationQueueState.upsert({
    where: { id: 'global' },
    create: { id: 'global', active_count: 0, reserved_storage_bytes: BigInt(0) },
    update: { active_count: { increment: 0 } },
  });
  const [queue, uploads] = await Promise.all([
    tx.animationQueueState.findUnique({ where: { id: 'global' }, select: { reserved_storage_bytes: true } }),
    tx.animationUploadState.findUnique({ where: { id: 'global' }, select: { reserved_storage_bytes: true } }),
  ]);
  const jobReservedBytes = queue?.reserved_storage_bytes ?? BigInt(0);
  const uploadReservedBytes = uploads?.reserved_storage_bytes ?? BigInt(0);
  if (!hasAnimationStorageCapacity(availableBytes, jobReservedBytes, uploadReservedBytes, ANIMATION_JOB_RESERVED_BYTES)) {
    throw new AnimationError('处理队列或空间预算已满，请稍后重试', 429, 'JOB_CAPACITY_REACHED');
  }
  const slot = await tx.animationQueueState.updateMany({
    where: {
      id: 'global',
      active_count: { lt: ANIMATION_MAX_ACTIVE_JOBS },
      reserved_storage_bytes: { lte: availableBytes - ANIMATION_STORAGE_RESERVE_BYTES - uploadReservedBytes - ANIMATION_JOB_RESERVED_BYTES },
    },
    data: { active_count: { increment: 1 }, reserved_storage_bytes: { increment: ANIMATION_JOB_RESERVED_BYTES } },
  });
  if (slot.count !== 1) throw new AnimationError('处理队列或空间预算已满，请稍后重试', 429, 'JOB_CAPACITY_REACHED');
}

export async function createAnimationJob(user: SessionUser, documentId: string, body: Record<string, unknown>) {
  const mutation = mutationInput(body);
  const kind = body.kind;
  if (kind !== 'export' && kind !== 'extract') throw new AnimationError('处理类型无效', 400, 'INVALID_JOB_KIND');
  const parameters = parseJobParameters(kind, body.parameters);
  const baseRevision = Number(body.base_revision);
  if (!Number.isInteger(baseRevision) || baseRevision < 1) throw new AnimationError('基础修订号无效', 400, 'INVALID_REVISION');
  const operation = `job:${documentId}`;
  const { document } = await requireAnimationDocument(user, documentId, 'create');
  if (document.status !== 'active') throw new AnimationError('已归档的动画不能处理', 409, 'DOCUMENT_ARCHIVED');
  const cached = await currentCachedResponse<{ success: true; job: AnimationJobView }>(user.id, mutation.mutationId, operation, mutation.hash);
  if (cached) return cached;
  await preflightAnimationStorage(ANIMATION_JOB_RESERVED_BYTES);
  const space = await statfs(await getAnimationStorageRoot(), { bigint: true });
  const availableBytes = space.bavail * space.bsize;
  const requestHash = animationRequestHash({ kind, document_id: documentId, base_revision: baseRevision, parameters });

  try {
    return await prisma.$transaction(async (tx) => {
      const current = await tx.animationDocument.findUnique({ where: { id: documentId } });
      if (!current) throw new AnimationError('动画记录不存在', 404, 'NOT_FOUND');
      await assertWriteAccessInTransaction(tx, user.id, current.project_id, current.owner_user_id, 'create');
      if (current.status !== 'active') throw new AnimationError('已归档的动画不能处理', 409, 'DOCUMENT_ARCHIVED');
      if (current.revision !== baseRevision) throw new AnimationError('动画已被其他修改更新，请先刷新', 409, 'REVISION_CONFLICT', current.revision);
      const sequence = await validateSequence(jsonOr(current.sequence_json, null));
      await assertSequenceFileReferences(tx, current, sequence);
      if (kind === 'extract') {
        const video = await tx.animationFile.findFirst({
          where: { id: parameters.video_file_id, document_id: documentId, project_id: current.project_id, role: 'video' },
          select: { id: true },
        });
        if (!video) throw new AnimationError('原片不属于此动画或不可用', 422, 'INVALID_FILE_REFERENCE');
      }
      const duplicate = await tx.animationJob.findFirst({
        where: { document_id: documentId, project_id: current.project_id, revision: baseRevision, kind, parameters_hash: requestHash, status: { in: ['queued', 'running'] } },
        orderBy: { created_at: 'asc' },
      });
      if (duplicate) {
        const result = { success: true as const, job: jobView(duplicate) };
        await recordRequest(tx, { actorId: user.id, requestId: mutation.mutationId, operation, requestHash: mutation.hash, documentId, response: result });
        return result;
      }

      await reserveQueueInTransaction(tx, availableBytes);
      const now = new Date();
      const row = await tx.animationJob.create({
        data: {
          id: randomUUID(),
          document_id: documentId,
          project_id: current.project_id,
          actor_user_id: user.id,
          kind,
          status: 'queued',
          revision: baseRevision,
          parameters_json: JSON.stringify(parameters),
          parameters_hash: requestHash,
          stage: 'queued',
          attempt: 0,
          queue_reserved: true,
          reserved_storage_bytes: ANIMATION_JOB_RESERVED_BYTES,
          timeout_at: new Date(now.getTime() + ANIMATION_JOB_TIMEOUT_MS),
          created_at: now,
          updated_at: now,
        },
      });
      const result = { success: true as const, job: jobView(row) };
      await recordRequest(tx, { actorId: user.id, requestId: mutation.mutationId, operation, requestHash: mutation.hash, documentId, response: result });
      return result;
    });
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'P2002') {
      await requireAnimationDocument(user, documentId, 'create');
      const replay = await currentCachedResponse<{ success: true; job: AnimationJobView }>(user.id, mutation.mutationId, operation, mutation.hash);
      if (replay) return replay;
    }
    throw error;
  }
}

export async function releaseQueueReservation(tx: Tx, job: { queue_reserved: boolean; reserved_storage_bytes: bigint }) {
  if (!job.queue_reserved) return;
  await tx.animationQueueState.updateMany({
    where: {
      id: 'global',
      active_count: { gt: 0 },
      reserved_storage_bytes: { gte: job.reserved_storage_bytes },
    },
    data: { active_count: { decrement: 1 }, reserved_storage_bytes: { decrement: job.reserved_storage_bytes } },
  });
}

export async function cancelAnimationJob(user: SessionUser, documentId: string, jobId: string) {
  const { document, access } = await requireAnimationDocument(user, documentId, 'write');
  const permittedJob = await prisma.animationJob.findFirst({ where: { id: jobId, document_id: documentId, project_id: document.project_id }, select: { actor_user_id: true } });
  if (!permittedJob) throw new AnimationError('处理任务不存在', 404, 'NOT_FOUND');
  if (permittedJob.actor_user_id !== user.id && !access.canManageAssets) throw new AnimationError('无权取消此处理任务', 403, 'FORBIDDEN');
  const idempotencyKey = `cancel:${jobId}`;
  const operation = `cancel:${documentId}:${jobId}`;
  const requestHash = animationRequestHash({ document_id: documentId, job_id: jobId, action: 'cancel' });
  const cached = await currentCachedResponse<{ success: true; job: AnimationJobView }>(user.id, idempotencyKey, operation, requestHash);
  if (cached) return cached;
  try {
    return await prisma.$transaction(async (tx) => {
      const job = await tx.animationJob.findFirst({ where: { id: jobId, document_id: documentId, project_id: document.project_id } });
      if (!job) throw new AnimationError('处理任务不存在', 404, 'NOT_FOUND');
      const grant = await assertWriteAccessInTransaction(tx, user.id, document.project_id, document.owner_user_id, 'write');
      if (job.actor_user_id !== user.id && !grant.canManageAssets) throw new AnimationError('无权取消此处理任务', 403, 'FORBIDDEN');
      if (job.queue_reserved) await releaseQueueReservation(tx, job);
      const status = job.status === 'queued' || job.status === 'running' ? 'cancelled' : job.status;
      const updated = await tx.animationJob.update({
        where: { id: job.id },
        data: {
          status,
          stage: status === 'cancelled' ? 'cancelled' : job.stage,
          error_code: status === 'cancelled' ? 'CANCELLED_BY_USER' : job.error_code,
          error_message: status === 'cancelled' ? '已取消' : job.error_message,
          lease_token: status === 'cancelled' ? null : job.lease_token,
          lease_expires_at: status === 'cancelled' ? null : job.lease_expires_at,
          queue_reserved: false,
          reserved_storage_bytes: BigInt(0),
        },
      });
      const result = { success: true as const, job: jobView(updated) };
      await recordRequest(tx, { actorId: user.id, requestId: idempotencyKey, operation, requestHash, documentId, response: result });
      return result;
    });
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'P2002') {
      const { access: freshAccess } = await requireAnimationDocument(user, documentId, 'write');
      const currentJob = await prisma.animationJob.findFirst({ where: { id: jobId, document_id: documentId, project_id: document.project_id }, select: { actor_user_id: true } });
      if (!currentJob) throw new AnimationError('处理任务不存在', 404, 'NOT_FOUND');
      if (currentJob.actor_user_id !== user.id && !freshAccess.canManageAssets) throw new AnimationError('无权取消此处理任务', 403, 'FORBIDDEN');
      const replay = await currentCachedResponse<{ success: true; job: AnimationJobView }>(user.id, idempotencyKey, operation, requestHash);
      if (replay) return replay;
    }
    throw error;
  }
}

export async function submitAnimationReview(user: SessionUser, documentId: string, body: Record<string, unknown>) {
  const mutation = mutationInput(body);
  const operation = `review:${documentId}`;
  const currentAccess = await requireAnimationDocument(user, documentId, 'write');
  const reviewStatus = String(body.review_status);
  const baseRevision = Number(body.base_revision);
  if (!Number.isInteger(baseRevision) || baseRevision < 1) throw new AnimationError('基础修订号无效', 400, 'INVALID_REVISION');
  if (!['pending', 'changes_requested', 'reported_pass'].includes(reviewStatus)) throw new AnimationError('审核状态无效', 400, 'INVALID_REVIEW_STATUS');
  if (reviewStatus !== 'pending' && !currentAccess.canManage) throw new AnimationError('只有资产管理员可以登记人工审核结论', 403, 'FORBIDDEN');
  const note = typeof body.review_note === 'string' ? body.review_note : '';
  if (note.length > 4000) throw new AnimationError('审核说明过长', 413, 'BODY_TOO_LARGE');
  if (body.game_status !== undefined && !['unverified', 'changes_requested', 'reported_pass'].includes(String(body.game_status))) {
    throw new AnimationError('游戏状态无效', 400, 'INVALID_GAME_STATUS');
  }
  if (body.game_status !== undefined && !currentAccess.canManage) throw new AnimationError('只有资产管理员可以登记人工游戏回执', 403, 'FORBIDDEN');
  const cached = await currentCachedResponse<{ success: true; document: AnimationDocumentView }>(user.id, mutation.mutationId, operation, mutation.hash);
  if (cached) return { ...cached, document: { ...cached.document, can_edit: currentAccess.canEdit, can_manage: currentAccess.canManage } };
  try {
    return await prisma.$transaction(async (tx) => {
      const current = await tx.animationDocument.findUnique({ where: { id: documentId } });
      if (!current) throw new AnimationError('动画记录不存在', 404, 'NOT_FOUND');
      const grant = await assertWriteAccessInTransaction(tx, user.id, current.project_id, current.owner_user_id, 'write');
      if ((reviewStatus !== 'pending' || body.game_status !== undefined) && !grant.canManageAssets) {
        throw new AnimationError('只有资产管理员可以登记人工审核或游戏回执', 403, 'FORBIDDEN');
      }
      if (current.revision !== baseRevision) throw new AnimationError('动画已被其他修改更新，请先刷新', 409, 'REVISION_CONFLICT', current.revision);
      const changed = await tx.animationDocument.updateMany({
        where: { id: documentId, revision: baseRevision },
        data: {
          review_status: reviewStatus,
          review_revision: baseRevision,
          review_note: note,
          ...(body.game_status === undefined ? {} : { game_status: String(body.game_status) }),
        },
      });
      if (changed.count !== 1) {
        const latest = await tx.animationDocument.findUnique({ where: { id: documentId }, select: { revision: true } });
        throw new AnimationError('动画已被其他修改更新，请先刷新', 409, 'REVISION_CONFLICT', latest?.revision);
      }
      const updated = await tx.animationDocument.findUnique({ where: { id: documentId } });
      if (!updated) throw new AnimationError('动画记录不存在', 404, 'NOT_FOUND');
      const canEdit = (current.owner_user_id === user.id && grant.canGenerate) || grant.canManageAssets;
      const result = { success: true as const, document: await buildAnimationDocumentView(tx, updated, canEdit, grant.canManageAssets) };
      await recordRequest(tx, { actorId: user.id, requestId: mutation.mutationId, operation, requestHash: mutation.hash, documentId, response: result });
      return result;
    });
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'P2002') {
      const freshAccess = await requireAnimationDocument(user, documentId, 'write');
      if ((reviewStatus !== 'pending' || body.game_status !== undefined) && !freshAccess.canManage) {
        throw new AnimationError('只有资产管理员可以登记人工审核或游戏回执', 403, 'FORBIDDEN');
      }
      const replay = await currentCachedResponse<{ success: true; document: AnimationDocumentView }>(user.id, mutation.mutationId, operation, mutation.hash);
      if (replay) return { ...replay, document: { ...replay.document, can_edit: freshAccess.canEdit, can_manage: freshAccess.canManage } };
    }
    throw error;
  }
}
