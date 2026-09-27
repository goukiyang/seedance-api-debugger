import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AnimationJob, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AnimationError } from './http';
import { validateAnimationSequence } from './schema';
import { exportAnimationBundle, extractAnimationFrame } from './media';
import type { AnimationFileInfo, AnimationJobParameters, AnimationLocalFile, AnimationPose, AnimationSequence } from './types';
import { isExternalUser } from '@/lib/access/external-role';
import {
  ANIMATION_JOB_RESERVED_BYTES,
  ANIMATION_MAX_DOCUMENT_BYTES,
  ANIMATION_STORAGE_RESERVE_BYTES,
  animationFileStat,
  assertAnimationSourceInDirectory,
  createAnimationTempDirectory,
  getAnimationReconcileDirectory,
  hashFile,
  inspectLocalAnimationFile,
  publishAnimationBlob,
  removeAnimationBlob,
  removeAnimationTempDirectory,
  validateAnimationCandidate,
  validateAnimationZip,
  writeAnimationReconcileManifest,
} from './storage';
import { reconcileAnimationUploadManifest, releaseQueueReservation } from './repository';

const WORKER_LEASE_MS = 45_000;
const JOB_LEASE_MS = 60_000;
const HEARTBEAT_MS = 10_000;

type ClaimedJob = AnimationJob & { lease_token: string };
type WorkerOptions = { once?: boolean; signal?: AbortSignal; onActiveController?: (controller: AbortController | null) => void };
type Tx = Prisma.TransactionClient;

export function matchesAnimationJobAttempt(
  job: AnimationJob | null,
  leaseToken: string,
  attempt: number,
): job is AnimationJob & { lease_token: string } {
  return job !== null && job.status === 'running' && job.lease_token === leaseToken && job.attempt === attempt;
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function safeFailure(error: unknown) {
  if (error instanceof AnimationError) return { code: error.code, message: error.message };
  return { code: 'PROCESSING_FAILED', message: '动画处理未完成，请检查源文件后重试' };
}

async function ensureQueueState() {
  await prisma.animationQueueState.upsert({
    where: { id: 'global' },
    create: { id: 'global', active_count: 0, reserved_storage_bytes: BigInt(0) },
    update: {},
  });
}

export async function acquireAnimationWorkerLease() {
  const token = randomUUID();
  await ensureQueueState();
  const now = new Date();
  const acquired = await prisma.animationQueueState.updateMany({
    where: { id: 'global', OR: [{ worker_token: null }, { worker_lease_expires_at: null }, { worker_lease_expires_at: { lt: now } }] },
    data: { worker_token: token, worker_lease_expires_at: new Date(now.getTime() + WORKER_LEASE_MS) },
  });
  return acquired.count === 1 ? token : null;
}

async function renewWorkerLease(token: string) {
  const now = new Date();
  const result = await prisma.animationQueueState.updateMany({
    where: { id: 'global', worker_token: token, worker_lease_expires_at: { gt: now } },
    data: { worker_lease_expires_at: new Date(now.getTime() + WORKER_LEASE_MS) },
  });
  return result.count === 1;
}

async function releaseWorkerLease(token: string) {
  await prisma.animationQueueState.updateMany({
    where: { id: 'global', worker_token: token },
    data: { worker_token: null, worker_lease_expires_at: null },
  });
}

async function hasCurrentWorkerLease(tx: Tx, token: string) {
  const state = await tx.animationQueueState.findUnique({ where: { id: 'global' }, select: { worker_token: true, worker_lease_expires_at: true } });
  return state?.worker_token === token && Boolean(state.worker_lease_expires_at && state.worker_lease_expires_at.getTime() > Date.now());
}

async function actorStillAuthorized(tx: Tx, job: AnimationJob, document: { project_id: string; owner_user_id: string; status: string }) {
  if (document.status !== 'active') return false;
  const user = await tx.user.findUnique({
    where: { id: job.actor_user_id },
    select: { id: true, role: true, account_type: true, status: true, expires_at: true, feishu_user_id: true, feishu_open_id: true, feishu_union_id: true },
  });
  if (!user || user.status !== 'active' || isExternalUser({
    role: user.role,
    account_type: user.account_type,
    feishu: { user_id: user.feishu_user_id, open_id: user.feishu_open_id, union_id: user.feishu_union_id },
  }) || (user.expires_at && user.expires_at.getTime() <= Date.now())) return false;
  const project = await tx.project.findUnique({
    where: { id: document.project_id },
    select: {
      id: true, type: true, status: true, owner_user_id: true,
      members: { where: { user_id: user.id }, take: 1, select: { role: true, status: true } },
    },
  });
  if (!project || project.status === 'deleted') return false;
  const activeProject = project.status === 'active' && project.type !== 'system';
  let canGenerate = false;
  let canManageAssets = false;
  if (user.role === 'admin') {
    canGenerate = activeProject;
    canManageAssets = activeProject;
  } else {
    const member = ['team', 'public'].includes(project.type) ? project.members[0] : undefined;
    const role = project.owner_user_id === user.id ? 'project_owner' : member?.status === 'active' ? member.role : null;
    const canView = Boolean(role);
    canGenerate = canView && activeProject && role !== 'viewer';
    canManageAssets = activeProject && (role === 'project_owner' || role === 'editor');
  }
  return canManageAssets || (document.owner_user_id === user.id && canGenerate);
}

async function releaseReservation(tx: Tx, job: AnimationJob) {
  await releaseQueueReservation(tx, job);
}

async function markActiveJobsInterrupted() {
  await prisma.$transaction(async (tx) => {
    const active = await tx.animationJob.findMany({ where: { status: 'running', queue_reserved: true } });
    for (const job of active) await releaseReservation(tx, job);
    await tx.animationJob.updateMany({
      where: { status: 'running' },
      data: {
        status: 'interrupted',
        stage: 'interrupted',
        error_code: 'WORKER_RESTARTED',
        error_message: '处理进程已重启，可重新提交处理',
        lease_token: null,
        lease_expires_at: null,
        queue_reserved: false,
        reserved_storage_bytes: BigInt(0),
      },
    });
    const queued = await tx.animationJob.aggregate({ where: { status: 'queued', queue_reserved: true }, _count: { _all: true }, _sum: { reserved_storage_bytes: true } });
    await tx.animationQueueState.updateMany({
      where: { id: 'global' },
      data: { active_count: queued._count._all, reserved_storage_bytes: queued._sum.reserved_storage_bytes ?? BigInt(0) },
    });
  });
}

async function authorityAndClaimCheck(jobId: string, workerToken: string, leaseToken: string, attempt: number, extend: boolean) {
  return prisma.$transaction(async (tx) => {
    const job = await tx.animationJob.findUnique({ where: { id: jobId } });
    if (!matchesAnimationJobAttempt(job, leaseToken, attempt)) return false;
    if (!await hasCurrentWorkerLease(tx, workerToken)) return false;
    const document = await tx.animationDocument.findUnique({ where: { id: job.document_id }, select: { project_id: true, owner_user_id: true, status: true } });
    if (!document || !await actorStillAuthorized(tx, job, document)) {
      await releaseReservation(tx, job);
      await tx.animationJob.updateMany({
        where: { id: job.id, status: 'running', lease_token: leaseToken, attempt },
        data: { status: 'cancelled', stage: 'cancelled', error_code: 'ACCESS_REVOKED', error_message: '项目访问权限已变化，处理未发布', lease_token: null, lease_expires_at: null, queue_reserved: false, reserved_storage_bytes: BigInt(0) },
      });
      return false;
    }
    if (job.timeout_at.getTime() <= Date.now()) {
      await releaseReservation(tx, job);
      await tx.animationJob.updateMany({
        where: { id: job.id, status: 'running', lease_token: leaseToken, attempt },
        data: { status: 'failed', stage: 'failed', error_code: 'JOB_TIMEOUT', error_message: '处理超时，请缩小处理范围后重试', lease_token: null, lease_expires_at: null, queue_reserved: false, reserved_storage_bytes: BigInt(0) },
      });
      return false;
    }
    if (extend) {
      const now = new Date();
      const updated = await tx.animationJob.updateMany({
        where: { id: job.id, status: 'running', lease_token: leaseToken, attempt },
        data: { heartbeat_at: now, lease_expires_at: new Date(now.getTime() + JOB_LEASE_MS) },
      });
      return updated.count === 1;
    }
    return true;
  });
}

async function updateJobStage(job: ClaimedJob, workerToken: string, stage: string) {
  if (!await authorityAndClaimCheck(job.id, workerToken, job.lease_token, job.attempt, false)) return false;
  const result = await prisma.animationJob.updateMany({
    where: { id: job.id, status: 'running', lease_token: job.lease_token, attempt: job.attempt },
    data: { stage },
  });
  return result.count === 1;
}

async function claimNextAnimationJob(workerToken: string): Promise<ClaimedJob | null> {
  const candidates = await prisma.animationJob.findMany({
    where: { status: 'queued', queue_reserved: true },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    take: 8,
  });
  for (const candidate of candidates) {
    const valid = await prisma.$transaction(async (tx) => {
      if (!await hasCurrentWorkerLease(tx, workerToken)) return false;
      const current = await tx.animationJob.findUnique({ where: { id: candidate.id } });
      if (!current || current.status !== 'queued' || !current.queue_reserved) return false;
      const document = await tx.animationDocument.findUnique({ where: { id: current.document_id, status: 'active' }, select: { project_id: true, owner_user_id: true, status: true } });
      if (!document || document.project_id !== current.project_id || !await actorStillAuthorized(tx, current, document)) {
        await releaseReservation(tx, current);
        await tx.animationJob.updateMany({
          where: { id: current.id, status: 'queued', queue_reserved: true },
          data: { status: 'cancelled', stage: 'cancelled', error_code: 'ACCESS_REVOKED', error_message: '项目访问权限已变化，处理未启动', queue_reserved: false, reserved_storage_bytes: BigInt(0) },
        });
        return false;
      }
      const now = new Date();
      const leaseToken = randomUUID();
      const updated = await tx.animationJob.updateMany({
        where: { id: current.id, status: 'queued', queue_reserved: true, attempt: current.attempt },
        data: { status: 'running', stage: 'validating', attempt: { increment: 1 }, lease_token: leaseToken, lease_expires_at: new Date(now.getTime() + JOB_LEASE_MS), heartbeat_at: now },
      });
      return updated.count === 1;
    });
    if (!valid) continue;
    const claimed = await prisma.animationJob.findUnique({ where: { id: candidate.id } });
    if (claimed?.status === 'running' && claimed.lease_token) return claimed as ClaimedJob;
  }
  return null;
}

async function loadFrozenJob(job: ClaimedJob) {
  const [document, revision] = await Promise.all([
    prisma.animationDocument.findUnique({ where: { id: job.document_id } }),
    prisma.animationRevision.findUnique({ where: { document_id_revision: { document_id: job.document_id, revision: job.revision } } }),
  ]);
  if (!document || document.project_id !== job.project_id || !revision) throw new AnimationError('处理修订不可读取', 409, 'REVISION_NOT_FOUND');
  const sequence = validateAnimationSequence(JSON.parse(revision.sequence_json));
  const parameters = parseJson<AnimationJobParameters>(job.parameters_json, {});
  const ids = new Set<string>();
  if (job.kind === 'export') {
    for (const pose of sequence.poses) {
      ids.add(pose.file_id);
      if (pose.mother_file_id) ids.add(pose.mother_file_id);
      if (pose.source.video_file_id) ids.add(pose.source.video_file_id);
    }
    for (const entry of sequence.entries) if (entry.reference_file_id) ids.add(entry.reference_file_id);
  } else if (parameters.video_file_id) ids.add(parameters.video_file_id);
  const rows = ids.size ? await prisma.animationFile.findMany({ where: { id: { in: Array.from(ids) }, document_id: document.id, project_id: job.project_id } }) : [];
  if (rows.length !== ids.size) throw new AnimationError('处理修订引用了不可用的文件', 422, 'INVALID_FILE_REFERENCE');
  const files: AnimationLocalFile[] = [];
  for (const row of rows) {
    const resolved = await (await import('./storage')).resolveAnimationBlob(row.blob_key);
    if (resolved.bytes !== row.bytes || await hashFile(resolved.path) !== row.sha256) throw new AnimationError('已登记的动画文件校验失败', 422, 'FILE_HASH_MISMATCH');
    files.push({ id: row.id, name: row.name, role: row.role as AnimationFileInfo['role'], mime: row.mime, bytes: row.bytes, sha256: row.sha256, width: row.width, height: row.height, path: resolved.path });
  }
  return { document, sequence, parameters, files };
}

async function stageAnimationJobFiles(files: AnimationLocalFile[], attemptDirectory: string, signal: AbortSignal) {
  const directory = path.join(attemptDirectory, 'inputs');
  await mkdir(directory, { mode: 0o700 });
  const root = await realpath(attemptDirectory);
  const inputRoot = await realpath(directory);
  const relative = path.relative(root, inputRoot);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new AnimationError('处理输入目录无效', 503, 'STORAGE_UNAVAILABLE');
  }

  const staged: AnimationLocalFile[] = [];
  for (const file of files) {
    signal.throwIfAborted();
    if (!/^[0-9a-f-]{36}$/i.test(file.id)) throw new AnimationError('处理文件编号无效', 422, 'INVALID_FILE_REFERENCE');
    const extension = file.mime === 'image/png' ? '.png' : file.mime === 'video/mp4' ? '.mp4' : null;
    if (!extension) throw new AnimationError('处理文件类型无效', 422, 'INVALID_FILE_REFERENCE');
    const sourceInfo = await lstat(file.path).catch(() => null);
    if (!sourceInfo?.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size !== file.bytes) {
      throw new AnimationError('处理文件不可用', 422, 'INVALID_FILE_REFERENCE');
    }
    const target = path.join(inputRoot, `${file.id}${extension}`);
    await copyFile(file.path, target, constants.COPYFILE_EXCL);
    signal.throwIfAborted();
    await chmod(target, 0o400);
    const copied = await stat(target);
    if (!copied.isFile() || copied.size !== file.bytes || await hashFile(target) !== file.sha256) {
      await rm(target, { force: true }).catch(() => undefined);
      throw new AnimationError('处理输入文件校验失败', 422, 'FILE_HASH_MISMATCH');
    }
    staged.push({ ...file, path: target });
  }
  return staged;
}

function isAbort(error: unknown) {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function waitForWorkerSignal(signal: AbortSignal, milliseconds: number) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    signal.addEventListener('abort', finish, { once: true });
  });
}

async function markJobFailure(job: ClaimedJob, error: unknown, interrupted: boolean) {
  const failure = interrupted ? { code: 'WORKER_STOPPED', message: '处理进程已停止，可重新提交处理' } : safeFailure(error);
  await prisma.$transaction(async (tx) => {
    const current = await tx.animationJob.findUnique({ where: { id: job.id } });
    if (!matchesAnimationJobAttempt(current, job.lease_token, job.attempt)) return;
    await releaseReservation(tx, current);
    await tx.animationJob.updateMany({
      where: { id: job.id, status: 'running', lease_token: job.lease_token, attempt: job.attempt },
      data: {
        status: interrupted ? 'interrupted' : 'failed',
        stage: interrupted ? 'interrupted' : 'failed',
        error_code: failure.code,
        error_message: failure.message,
        lease_token: null,
        lease_expires_at: null,
        queue_reserved: false,
        reserved_storage_bytes: BigInt(0),
      },
    });
  });
}

async function finalizeExport(job: ClaimedJob, workerToken: string, input: {
  blob_key: string; file_name: string; bytes: number; sha256: string; entry_count: number; total_ticks: number; mode: 'work_copy' | 'validated'; warnings: string[];
}) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.animationJob.findUnique({ where: { id: job.id } });
    const document = await tx.animationDocument.findUnique({ where: { id: job.document_id }, select: { project_id: true, owner_user_id: true, status: true } });
    if (!matchesAnimationJobAttempt(current, job.lease_token, job.attempt)
      || !document || document.project_id !== job.project_id || !await hasCurrentWorkerLease(tx, workerToken)
      || !await actorStillAuthorized(tx, current, document)) return false;
    const exportId = randomUUID();
    const exported = await tx.animationExport.create({
      data: {
        id: exportId,
        document_id: job.document_id,
        project_id: job.project_id,
        job_id: job.id,
        revision: job.revision,
        mode: input.mode,
        blob_key: input.blob_key,
        file_name: input.file_name,
        bytes: input.bytes,
        sha256: input.sha256,
        entry_count: input.entry_count,
        total_ticks: input.total_ticks,
        warnings_json: JSON.stringify(input.warnings.slice(0, 100)),
      },
    });
    const now = new Date();
    const resultJson = JSON.stringify({ export_id: exported.id, warnings: input.warnings.slice(0, 100) });
    const updated = await tx.animationJob.updateMany({
      where: { id: job.id, status: 'running', lease_token: job.lease_token, attempt: job.attempt },
      data: { status: 'succeeded', stage: 'complete', result_json: resultJson, error_code: null, error_message: null, lease_token: null, lease_expires_at: null, queue_reserved: false, reserved_storage_bytes: BigInt(0), heartbeat_at: now },
    });
    if (updated.count !== 1) throw new AnimationError('处理任务已失效', 409, 'ATTEMPT_STALE');
    await releaseReservation(tx, current);
    return true;
  });
}

async function finalizeExtract(job: ClaimedJob, workerToken: string, input: {
  blob_key: string; info: AnimationFileInfo; pose: AnimationPose;
}) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.animationJob.findUnique({ where: { id: job.id } });
    const document = await tx.animationDocument.findUnique({ where: { id: job.document_id }, select: { project_id: true, owner_user_id: true, status: true } });
    if (!matchesAnimationJobAttempt(current, job.lease_token, job.attempt)
      || !document || document.project_id !== job.project_id || !await hasCurrentWorkerLease(tx, workerToken)
      || !await actorStillAuthorized(tx, current, document)) return { committed: false, usedBlob: false };
    const existing = await tx.animationFile.findUnique({
      where: { document_id_role_sha256: { document_id: job.document_id, role: 'candidate', sha256: input.info.sha256 } },
    });
    let file = existing;
    const usedBlob = !existing;
    if (!file) {
      const [aggregate, count] = await Promise.all([
        tx.animationFile.aggregate({ where: { document_id: job.document_id }, _sum: { bytes: true } }),
        tx.animationFile.count({ where: { document_id: job.document_id } }),
      ]);
      if (count >= 256 || (aggregate._sum.bytes || 0) + input.info.bytes > ANIMATION_MAX_DOCUMENT_BYTES) {
        throw new AnimationError('此动画已达到文件数量或容量上限', 413, 'DOCUMENT_QUOTA_EXCEEDED');
      }
      file = await tx.animationFile.create({
        data: { ...input.info, blob_key: input.blob_key, document_id: job.document_id, project_id: job.project_id, created_by: job.actor_user_id },
      });
    }
    const pose = { ...input.pose, file_id: file.id };
    const resultJson = JSON.stringify({ file: { id: file.id, name: file.name, role: file.role, mime: file.mime, bytes: file.bytes, sha256: file.sha256, width: file.width, height: file.height }, candidate_pose: pose });
    const updated = await tx.animationJob.updateMany({
      where: { id: job.id, status: 'running', lease_token: job.lease_token, attempt: job.attempt },
      data: { status: 'succeeded', stage: 'complete', result_json: resultJson, error_code: null, error_message: null, lease_token: null, lease_expires_at: null, queue_reserved: false, reserved_storage_bytes: BigInt(0), heartbeat_at: new Date() },
    });
    if (updated.count !== 1) throw new AnimationError('处理任务已失效', 409, 'ATTEMPT_STALE');
    await releaseReservation(tx, current);
    return { committed: true, usedBlob };
  });
}

async function processClaimedJob(job: ClaimedJob, workerToken: string, rootSignal?: AbortSignal) {
  const controller = new AbortController();
  const abortFromRoot = () => controller.abort(rootSignal?.reason);
  if (rootSignal?.aborted) abortFromRoot();
  rootSignal?.addEventListener('abort', abortFromRoot, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('Animation job timeout')), Math.max(1, job.timeout_at.getTime() - Date.now()));
  const heartbeat = setInterval(() => {
    void authorityAndClaimCheck(job.id, workerToken, job.lease_token, job.attempt, true)
      .then((valid) => { if (!valid) controller.abort(new Error('Animation lease lost')); })
      .catch(() => controller.abort(new Error('Animation lease check failed')));
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  let tempDirectory: string | null = null;
  let publishedBlob: string | null = null;
  let manifestPath: string | null = null;
  let manifestPersisted = false;
  try {
    if (controller.signal.aborted) throw new Error('AbortError');
    if (!await authorityAndClaimCheck(job.id, workerToken, job.lease_token, job.attempt, true)) throw new AnimationError('处理任务已失效', 409, 'ATTEMPT_STALE');
    const context = await loadFrozenJob(job);
    tempDirectory = await createAnimationTempDirectory();
    const stagedFiles = await stageAnimationJobFiles(context.files, tempDirectory, controller.signal);
    if (!await updateJobStage(job, workerToken, job.kind === 'export' ? 'exporting' : 'extracting')) throw new AnimationError('处理任务已失效', 409, 'ATTEMPT_STALE');
    controller.signal.throwIfAborted();

    if (job.kind === 'export') {
      const mode = context.parameters.mode === 'validated' ? 'validated' : 'work_copy';
      const outcome = await exportAnimationBundle({ sequence: context.sequence, files: stagedFiles, outputDir: tempDirectory, mode, signal: controller.signal });
      const outputPath = await assertAnimationSourceInDirectory(outcome.path, tempDirectory);
      const fileInfo = await animationFileStat(outputPath);
      if (fileInfo.size <= 0 || fileInfo.size > ANIMATION_MAX_DOCUMENT_BYTES) throw new AnimationError('导出包超过容量限制', 413, 'OUTPUT_TOO_LARGE');
      await validateAnimationZip(outputPath);
      const actualHash = await hashFile(outputPath);
      if (outcome.bytes !== fileInfo.size || outcome.sha256 !== actualHash) throw new AnimationError('导出包校验失败', 422, 'OUTPUT_HASH_MISMATCH');
      const entryCount = context.sequence.entries.length;
      const totalTicks = context.sequence.entries.reduce((sum, entry) => sum + entry.hold_ticks, 0);
      if (outcome.entry_count !== entryCount || outcome.total_ticks !== totalTicks) throw new AnimationError('导出清单与当前修订不一致', 422, 'OUTPUT_MANIFEST_MISMATCH');
      controller.signal.throwIfAborted();
      if (!await authorityAndClaimCheck(job.id, workerToken, job.lease_token, job.attempt, true)) throw new AnimationError('处理任务已失效', 409, 'ATTEMPT_STALE');
      if (!await updateJobStage(job, workerToken, 'publishing')) throw new AnimationError('处理任务已失效', 409, 'ATTEMPT_STALE');
      const published = await publishAnimationBlob(outputPath, actualHash);
      publishedBlob = published.blob_key;
      const metadata = {
        blob_key: published.blob_key,
        file_name: `${context.sequence.title || 'animation'}-r${job.revision}.zip`.replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 160),
        bytes: published.bytes,
        sha256: published.sha256,
        entry_count: entryCount,
        total_ticks: totalTicks,
        mode,
        warnings: Array.isArray(outcome.warnings) ? outcome.warnings.map(String) : [],
      } as const;
      const reconcileId = randomUUID();
      manifestPath = await writeAnimationReconcileManifest(reconcileId, {
        version: 1, kind: 'job_export', job_id: job.id, attempt: job.attempt, lease_token: job.lease_token,
        worker_token: workerToken, document_id: job.document_id, project_id: job.project_id, revision: job.revision, export: metadata,
      });
      manifestPersisted = true;
      controller.signal.throwIfAborted();
      const committed = await finalizeExport(job, workerToken, metadata);
      if (!committed) {
        await removeAnimationBlob(published.blob_key);
        publishedBlob = null;
        await rm(manifestPath, { force: true }).catch(() => undefined);
        manifestPersisted = false;
        return;
      }
      publishedBlob = null;
      await rm(manifestPath, { force: true }).catch(() => undefined);
      manifestPersisted = false;
      return;
    }

    const parameters = context.parameters;
    const video = stagedFiles.find((file) => file.id === parameters.video_file_id && file.role === 'video');
    if (!video || !Number.isInteger(parameters.frame_index) || Number(parameters.frame_index) < 0) throw new AnimationError('抽帧参数无效', 422, 'INVALID_PARAMETERS');
    const outcome = await extractAnimationFrame({ file: video, index: Number(parameters.frame_index), outputDir: tempDirectory, signal: controller.signal });
    const outputPath = await assertAnimationSourceInDirectory(outcome.file.path, tempDirectory);
    const imageMeta = await validateAnimationCandidate(outputPath, 'candidate', outcome.file.name);
    const info = await inspectLocalAnimationFile(outputPath, outcome.file.name, 'candidate', imageMeta);
    if (info.bytes > ANIMATION_MAX_DOCUMENT_BYTES) throw new AnimationError('抽帧结果超过容量限制', 413, 'OUTPUT_TOO_LARGE');
    controller.signal.throwIfAborted();
    if (!await authorityAndClaimCheck(job.id, workerToken, job.lease_token, job.attempt, true)) throw new AnimationError('处理任务已失效', 409, 'ATTEMPT_STALE');
    if (!await updateJobStage(job, workerToken, 'publishing')) throw new AnimationError('处理任务已失效', 409, 'ATTEMPT_STALE');
    const published = await publishAnimationBlob(outputPath, info.sha256);
    publishedBlob = published.blob_key;
    const pose: AnimationPose = { ...outcome.pose, id: randomUUID(), file_id: info.id };
    const reconcileId = randomUUID();
    manifestPath = await writeAnimationReconcileManifest(reconcileId, {
      version: 1, kind: 'job_extract', job_id: job.id, attempt: job.attempt, lease_token: job.lease_token,
      worker_token: workerToken, document_id: job.document_id, project_id: job.project_id, revision: job.revision,
      file: { ...info, blob_key: published.blob_key, document_id: job.document_id, project_id: job.project_id, created_by: job.actor_user_id }, pose,
    });
    manifestPersisted = true;
    controller.signal.throwIfAborted();
    const finalized = await finalizeExtract(job, workerToken, { blob_key: published.blob_key, info, pose });
    if (!finalized.committed) {
      await removeAnimationBlob(published.blob_key);
      publishedBlob = null;
      await rm(manifestPath, { force: true }).catch(() => undefined);
      manifestPersisted = false;
      return;
    }
    if (!finalized.usedBlob) await removeAnimationBlob(published.blob_key);
    publishedBlob = null;
    await rm(manifestPath, { force: true }).catch(() => undefined);
    manifestPersisted = false;
  } catch (error) {
    const lostAttempt = error instanceof AnimationError && error.code === 'ATTEMPT_STALE';
    const stopped = controller.signal.aborted || isAbort(error) || lostAttempt;
    if (publishedBlob && !manifestPersisted) await removeAnimationBlob(publishedBlob);
    if (!manifestPersisted) await markJobFailure(job, error, stopped).catch(() => undefined);
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
    rootSignal?.removeEventListener('abort', abortFromRoot);
    if (tempDirectory) await removeAnimationTempDirectory(tempDirectory).catch(() => undefined);
  }
}

async function recoverReconcileFiles(workerToken: string) {
  const directory = await getAnimationReconcileDirectory();
  const entries = await readdir(directory).catch(() => []);
  for (const entry of entries) {
    if (!/^[0-9a-f-]{36}\.json$/.test(entry)) continue;
    const filePath = path.join(directory, entry);
    try {
      const info = await lstat(filePath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) continue;
      const record = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
      if (record.version !== 1 || !['job_export', 'job_extract', 'document_import', 'candidate_file'].includes(String(record.kind))) continue;
      if (record.kind === 'document_import') {
        if (!Array.isArray(record.files)) continue;
        let valid = true;
        for (const item of record.files as Array<Record<string, unknown>>) {
          if (typeof item.blob_key !== 'string' || !Number.isSafeInteger(item.bytes) || typeof item.sha256 !== 'string') { valid = false; break; }
          const blob = await (await import('./storage')).resolveAnimationBlob(item.blob_key);
          if (blob.bytes !== item.bytes || await hashFile(blob.path) !== item.sha256) { valid = false; break; }
        }
        if (!valid) continue;
        const result = await reconcileAnimationUploadManifest(record);
        for (const blobKey of result.cleanupBlobKeys) await removeAnimationBlob(blobKey);
        await rm(filePath, { force: true });
        continue;
      }
      if (record.kind === 'candidate_file') {
        const file = record.file as Record<string, unknown> | undefined;
        if (!file || typeof file.blob_key !== 'string' || !Number.isSafeInteger(file.bytes) || typeof file.sha256 !== 'string') continue;
        const blob = await (await import('./storage')).resolveAnimationBlob(file.blob_key);
        if (blob.bytes !== file.bytes || await hashFile(blob.path) !== file.sha256) continue;
        const result = await reconcileAnimationUploadManifest(record);
        for (const blobKey of result.cleanupBlobKeys) await removeAnimationBlob(blobKey);
        await rm(filePath, { force: true });
        continue;
      }
      const jobId = String(record.job_id || '');
      const attempt = Number(record.attempt);
      const leaseToken = String(record.lease_token || '');
      const job = await prisma.animationJob.findUnique({ where: { id: jobId } });
      if (!job || job.status !== 'running' || job.attempt !== attempt || job.lease_token !== leaseToken) {
        const artifact = record.kind === 'job_export' ? (record.export as { blob_key?: string } | undefined) : (record.file as { blob_key?: string } | undefined);
        if (artifact?.blob_key) await removeAnimationBlob(artifact.blob_key);
        await rm(filePath, { force: true });
        continue;
      }
      if (record.kind === 'job_export') {
        const exported = record.export as { blob_key: string; file_name: string; bytes: number; sha256: string; entry_count: number; total_ticks: number; mode: 'work_copy' | 'validated'; warnings: string[] };
        const blob = await (await import('./storage')).resolveAnimationBlob(exported.blob_key);
        if (blob.bytes !== exported.bytes || await hashFile(blob.path) !== exported.sha256) continue;
        const result = await finalizeExport(job as ClaimedJob, workerToken, exported);
        if (result) await rm(filePath, { force: true });
        else {
          await removeAnimationBlob(exported.blob_key);
          await rm(filePath, { force: true });
        }
      } else {
        const candidate = record.file as AnimationFileInfo & { blob_key: string; document_id: string; project_id: string; created_by: string };
        const pose = record.pose as AnimationPose;
        const blob = await (await import('./storage')).resolveAnimationBlob(candidate.blob_key);
        if (blob.bytes !== candidate.bytes || await hashFile(blob.path) !== candidate.sha256) continue;
        const result = await finalizeExtract(job as ClaimedJob, workerToken, { blob_key: candidate.blob_key, info: candidate, pose });
        if (result.committed) {
          if (!result.usedBlob) await removeAnimationBlob(candidate.blob_key);
          await rm(filePath, { force: true });
        } else {
          await removeAnimationBlob(candidate.blob_key);
          await rm(filePath, { force: true });
        }
      }
    } catch {
      // Retain unreadable or temporarily unregistrable reconciliation records for operator recovery.
    }
  }
}

export async function runAnimationWorker(options: WorkerOptions = {}) {
  const workerToken = await acquireAnimationWorkerLease();
  if (!workerToken) throw new AnimationError('已有动画处理进程正在运行', 409, 'WORKER_ALREADY_RUNNING');
  const stopController = new AbortController();
  const stop = () => stopController.abort(options.signal?.reason);
  if (options.signal?.aborted) stop();
  options.signal?.addEventListener('abort', stop, { once: true });
  const rootHeartbeat = setInterval(() => {
    void renewWorkerLease(workerToken).then((valid) => { if (!valid) stopController.abort(new Error('Worker lease lost')); })
      .catch(() => stopController.abort(new Error('Worker lease heartbeat failed')));
  }, HEARTBEAT_MS);
  rootHeartbeat.unref?.();
  options.onActiveController?.(stopController);
  try {
    await recoverReconcileFiles(workerToken);
    await markActiveJobsInterrupted();
    do {
      if (stopController.signal.aborted) break;
      const job = await claimNextAnimationJob(workerToken);
      if (!job) {
        if (options.once) break;
        await waitForWorkerSignal(stopController.signal, 1000);
        continue;
      }
      await processClaimedJob(job, workerToken, stopController.signal);
      await recoverReconcileFiles(workerToken).catch(() => undefined);
      if (options.once) break;
    } while (!stopController.signal.aborted);
  } finally {
    clearInterval(rootHeartbeat);
    options.signal?.removeEventListener('abort', stop);
    options.onActiveController?.(null);
    await releaseWorkerLease(workerToken).catch(() => undefined);
  }
}

export const animationWorkerLimits = {
  max_job_storage_bytes: Number(ANIMATION_JOB_RESERVED_BYTES),
  max_output_bytes: ANIMATION_MAX_DOCUMENT_BYTES,
};
