import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';

export const VIDEO_SAVE_HEADER_TIMEOUT_MS = 30_000;
export const VIDEO_SAVE_IDLE_TIMEOUT_MS = 60_000;
export const VIDEO_SAVE_TOTAL_TIMEOUT_MS = 15 * 60_000;
export type VideoSaveFence = { jobId: string; workerId: string; attempt: number };
export type VideoSaveOptions = { timeoutMs?: number; cacheTimeoutMs?: number; refreshOnForbidden?: boolean;
  allowLocalPublic?: boolean; saveFence?: VideoSaveFence; signal?: AbortSignal };
type Source = { id: string; provider?: string | null; provider_task_id: string | null; result_video_url: string | null };
type SaveContext = { taskId: string; source: string; signal: AbortSignal; fence?: VideoSaveFence };
const context = new AsyncLocalStorage<SaveContext>();
export const VIDEO_SAVE_RESULT_PREFIX = 'SD2_VIDEO_SAVE_RESULT:';
export const videoSaveSource = (task: Source) => createHash('sha256')
  .update(JSON.stringify([task.id, task.provider || 'seedance', task.provider_task_id, task.result_video_url])).digest('hex');

export function videoSaveSignal() { return context.getStore()?.signal; }
export function isVideoSaveProcess(taskId: string) { return context.getStore()?.taskId === taskId; }
export async function assertVideoSaveOwnership(task: Source) {
  const held = context.getStore();
  if (!held || held.taskId !== task.id || held.signal.aborted) throw new Error('VIDEO_SAVE_LOCK_LOST');
  const current = await prisma.videoTask.findUnique({ where: { id: task.id }, select: {
    id: true, provider: true, provider_task_id: true, result_video_url: true, local_status: true,
  } });
  if (!current || current.local_status !== 'succeeded' || videoSaveSource(current) !== held.source
    || videoSaveSource(task) !== held.source) throw new Error('VIDEO_SAVE_SOURCE_CHANGED');
  if (held.fence) {
    const job = await prisma.videoDeliveryJob.findUnique({ where: { id: held.fence.jobId }, select: {
      task_id: true, status: true, locked_by: true, attempts: true, locked_at: true,
    } });
    if (!job || job.task_id !== task.id || job.status !== 'running' || job.locked_by !== held.fence.workerId
      || job.attempts !== held.fence.attempt || !job.locked_at
      || Date.now() - job.locked_at.getTime() > 10 * 60_000) throw new Error('VIDEO_SAVE_LEASE_LOST');
  }
}
export async function updateVideoSaveSource(task: Source) {
  const held = context.getStore();
  if (!held || held.taskId !== task.id || held.signal.aborted) throw new Error('VIDEO_SAVE_LOCK_LOST');
  held.source = videoSaveSource(task);
  await assertVideoSaveOwnership(task);
}

/** Reserve the SQLite writer before publishing: a newer claim/source cannot pass this fence mid-publish. */
export async function commitVideoSavePublication(task: Source, publicPath: string, publish?: () => Promise<void>) {
  return commitVideoSaveTask(task, { local_video_path: publicPath }, publish);
}
export async function commitVideoSaveTask(task: Source, data: Prisma.VideoTaskUpdateManyMutationInput, publish?: () => Promise<void>) {
  await assertVideoSaveOwnership(task);
  const held = context.getStore()!;
  await prisma.$transaction(async tx => {
    if (held.fence) {
      const owner = await tx.videoDeliveryJob.updateMany({ where: { id: held.fence.jobId, task_id: task.id,
        status: 'running', locked_by: held.fence.workerId, attempts: held.fence.attempt,
        locked_at: { gte: new Date(Date.now() - 10 * 60_000) } }, data: { locked_by: held.fence.workerId } });
      if (owner.count !== 1) throw new Error('VIDEO_SAVE_LEASE_LOST');
    }
    const source = await tx.videoTask.updateMany({ where: { id: task.id, provider_task_id: task.provider_task_id,
      result_video_url: task.result_video_url, local_status: 'succeeded' }, data });
    if (source.count !== 1) throw new Error('VIDEO_SAVE_SOURCE_CHANGED');
    if (held.signal.aborted) throw new Error('VIDEO_SAVE_LEASE_LOST');
    await publish?.();
  });
}

async function lockFile(taskId: string) {
  if (!/^[A-Za-z0-9_-]{1,180}$/.test(taskId)) throw new Error('VIDEO_SAVE_TASK_INVALID');
  const root = process.env.NODE_ENV === 'production' ? '/data/video-api-debugger/var-lib/storage/video-save-locks'
    : path.join(process.cwd(), '.cache/video-save-locks');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root || info.mode & 0o077
    || info.uid !== process.getuid?.()) throw new Error('VIDEO_SAVE_LOCK_DIRECTORY_INVALID');
  const name = path.join(root, createHash('sha256').update(taskId).digest('hex') + '.lock');
  const handle = await open(name, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  const file = await handle.stat();
  if (!file.isFile() || file.nlink !== 1 || file.mode & 0o077 || file.uid !== process.getuid?.()) {
    await handle.close(); throw new Error('VIDEO_SAVE_LOCK_FILE_INVALID');
  }
  return handle;
}

/** The operation itself executes under flock, including validation, publish and its DB fence. */
export async function withVideoSaveProcess<T>(kind: 'cache' | 'ingest' | 'public', task: Source,
  options: VideoSaveOptions, action: () => Promise<T>): Promise<T> {
  if (isVideoSaveProcess(task.id)) { await assertVideoSaveOwnership(task); return action(); }
  if (process.platform !== 'linux') throw new Error('视频后台保存需要Linux文件锁；原视频保持。');
  const handle = await lockFile(task.id);
  try {
    const { signal, ...serializable } = options;
    return await new Promise<T>((resolve, reject) => {
      const child = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '--no-fork', '--conflict-exit-code', '75', '/proc/self/fd/3',
        process.execPath, '--import', 'tsx', '--require', './scripts/server-runtime.cjs', 'scripts/save-video-media.ts',
        kind, task.id, videoSaveSource(task), Buffer.from(JSON.stringify(serializable)).toString('base64url')],
      { cwd: process.cwd(), env: process.env, stdio: ['pipe', 'pipe', 'pipe', handle.fd] });
      let stdout = '', stderr = '';
      const stop = () => { child.kill('SIGTERM'); };
      signal?.addEventListener('abort', stop, { once: true });
      const timer = setTimeout(stop, VIDEO_SAVE_TOTAL_TIMEOUT_MS + 5 * 60_000);
      child.stdout!.on('data', bytes => { stdout += bytes.toString(); if (stdout.length > 1024 * 1024) stop(); });
      child.stderr!.on('data', bytes => { stderr += bytes.toString(); if (stderr.length > 65536) stderr = stderr.slice(-65536); });
      child.once('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(error); });
      child.once('close', code => {
        clearTimeout(timer); signal?.removeEventListener('abort', stop);
        if (code === 75) return resolve({ success: false, in_progress: true, error: 'VIDEO_SAVE_IN_PROGRESS',
          message: '正在保存视频，请稍后核对原任务。', status: 202 } as T);
        const line = stdout.split('\n').findLast(value => value.startsWith(VIDEO_SAVE_RESULT_PREFIX));
        if (code !== 0 || !line || signal?.aborted) return reject(new Error(signal?.aborted ? 'VIDEO_SAVE_LEASE_LOST' : 'VIDEO_SAVE_PROCESS_FAILED'));
        try { resolve(JSON.parse(line.slice(VIDEO_SAVE_RESULT_PREFIX.length)) as T); } catch { reject(new Error('VIDEO_SAVE_RESULT_INVALID')); }
      });
      if (signal?.aborted) stop();
    });
  } finally { await handle.close(); }
}

export async function runVideoSaveProcess(kind: string, taskId: string, source: string, options: VideoSaveOptions, signal: AbortSignal) {
  const lock = await lstat('/proc/self/fd/3');
  if (!lock.isSymbolicLink() || !/^[a-f0-9]{64}$/.test(source)) throw new Error('VIDEO_SAVE_PROCESS_INVALID');
  const task = await prisma.videoTask.findUnique({ where: { id: taskId } });
  if (!task || videoSaveSource(task) !== source) throw new Error('VIDEO_SAVE_SOURCE_CHANGED');
  return context.run({ taskId, source, signal, fence: options.saveFence }, async () => {
    await assertVideoSaveOwnership(task);
    if (kind === 'cache') return (await import('./local-cache')).cacheTaskVideoToLocal(task, options);
    if (kind === 'ingest') return (await import('./media-ingest')).ingestTaskMediaFromProvider(task, options);
    if (kind === 'public') return (await import('./public-delivery')).ensurePublicVideoDelivery(task, options);
    throw new Error('VIDEO_SAVE_OPERATION_INVALID');
  });
}
