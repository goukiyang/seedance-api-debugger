import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { inspectUpload, uploadFileHash, uploadFileVersion } from '@/lib/assets/verified-upload';
import { apiMediaRoot, privateMediaPath, publishPrivateMedia } from './private-media';
import { digest } from './auth';

export async function apiOutputFile(taskId: string) {
  const receipt = await prisma.apiRequest.findUnique({ where: { task_id: taskId } });
  if (!receipt?.output_bytes || !receipt.output_sha256 || !receipt.output_version) return null;
  const task = await prisma.videoTask.findUnique({ where: { id: taskId }, select: { local_video_path: true, user_id: true, source_type: true } });
  if (!task?.local_video_path || task.source_type !== 'customer_api' || !task.user_id) return null;
  const file = await privateMediaPath(task.local_video_path, digest(task.user_id));
  if (!file || await uploadFileVersion(file) !== receipt.output_version || BigInt((await fs.stat(file)).size) !== receipt.output_bytes) return null;
  return { file, bytes: Number(receipt.output_bytes), sha256: receipt.output_sha256, url: task.local_video_path };
}

export async function preparePrivateApiOutput(taskId: string) {
  const task = await prisma.videoTask.findUnique({ where: { id: taskId }, select: { source_type: true, user_id: true } });
  if (task?.source_type !== 'customer_api') return null;
  const receipt = await prisma.apiRequest.findUnique({ where: { task_id: taskId } });
  if (!receipt || !task.user_id || receipt.output_reserved_bytes <= BigInt(0)
    || receipt.output_reserved_bytes > BigInt(200 * 1024 * 1024)) throw new Error('API output reservation unavailable');
  return { receipt, ownerId: task.user_id, existing: await apiOutputFile(taskId),
    target: path.join(await apiMediaRoot(), `.${randomUUID()}.download`), maxBytes: Number(receipt.output_reserved_bytes) };
}

export async function finishPrivateApiOutput(taskId: string, ownerId: string, file: string, bytes: number) {
  try {
    const proof = await inspectUpload(file, 'video/mp4', await uploadFileHash(file), bytes);
    const saved = await publishPrivateMedia(proof, digest(ownerId), 'videos');
    await prisma.$transaction(async tx => {
      const receipt = await tx.apiRequest.findUnique({ where: { task_id: taskId } });
      if (!receipt || receipt.output_reserved_bytes < BigInt(bytes)) throw new Error('API output exceeds reservation');
      if (receipt.output_sha256 && receipt.output_sha256 !== proof.hash) throw new Error('API original output changed');
      await tx.apiRequest.update({ where: { id: receipt.id }, data: { output_bytes: BigInt(bytes), output_sha256: proof.hash, output_version: saved.version } });
      await tx.videoTask.update({ where: { id: taskId }, data: { local_video_path: saved.url } });
    });
    return saved.url;
  } finally { await fs.unlink(file).catch(() => {}); }
}
