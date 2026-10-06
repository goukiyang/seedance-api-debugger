'use client';
import { STUDIO_BATCH_LIMITS } from '@/lib/image-studio/batch-contract';
export type BatchFileHandle = { kind: 'file'; name: string; getFile(): Promise<File>; createWritable(): Promise<{ write(data: Blob | string): Promise<void>; close(): Promise<void>; abort(): Promise<void> }> };
export type BatchDirectoryHandle = { kind: 'directory'; name: string; values(): AsyncIterable<BatchFileHandle | BatchDirectoryHandle>; getDirectoryHandle(name: string, options?: { create: boolean }): Promise<BatchDirectoryHandle>; getFileHandle(name: string, options?: { create: boolean }): Promise<BatchFileHandle>; queryPermission(options: { mode: 'readwrite' }): Promise<string>; requestPermission(options: { mode: 'readwrite' }): Promise<string> };
export type BatchLocalFile = { file: File; preview: string; assetId?: string };
type DirectoryWindow = Window & { showDirectoryPicker?: (options: { mode: 'read' | 'readwrite' }) => Promise<BatchDirectoryHandle> };
export const canSelectBatchDirectory = () => typeof window !== 'undefined' && typeof (window as DirectoryWindow).showDirectoryPicker === 'function';
export async function selectBatchDirectory(mode: 'read' | 'readwrite') {
  const picker = (window as DirectoryWindow).showDirectoryPicker;
  if (!picker) throw new Error('当前浏览器不支持目录权限，请使用图片选择或 ZIP 下载');
  return picker({ mode });
}
export async function readBatchDirectory(directory: BatchDirectoryHandle) {
  const files: File[] = [], skipped: string[] = [];
  let scanned = 0;
  for await (const entry of directory.values()) {
    if (++scanned > 200) throw new Error('目录超过200个条目，请分成较小文件夹；原选择保留');
    if (entry.kind === 'directory') { skipped.push(`${entry.name}：子文件夹不递归读取`); continue; }
    if (files.length >= STUDIO_BATCH_LIMITS.files) throw new Error('超过100个文件，请分成较小文件夹；没有截取前100张生成');
    try { files.push(await entry.getFile()); } catch { skipped.push(`${entry.name}：无法读取`); }
  }
  return { files, skipped };
}
export async function previewBatchFiles(files: File[], initialSkipped: string[] = []) {
  if (files.length > STUDIO_BATCH_LIMITS.files) throw new Error('超过100个文件，请减少素材；原选择保留');
  const accepted: BatchLocalFile[] = [], skipped = [...initialSkipped];
  let totalBytes = 0;
  for (const file of files) {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    if (relative && relative.split('/').length > 2) { skipped.push(`${file.name}：子文件夹不递归读取`); continue; }
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { skipped.push(`${file.name}：不是 PNG、JPEG 或 WebP 图片`); continue; }
    if (!file.size || file.size > STUDIO_BATCH_LIMITS.fileBytes) { skipped.push(`${file.name}：空文件或超过单图 30MB 上限`); continue; }
    if (totalBytes + file.size > STUDIO_BATCH_LIMITS.totalBytes) {
      accepted.forEach(item => URL.revokeObjectURL(item.preview));
      throw new Error('本批超过256MB，请减少素材；原选择保留，没有截取部分文件生成');
    }
    try {
      const bitmap = await createImageBitmap(file);
      const valid = bitmap.width > 0 && bitmap.height > 0 && bitmap.width * bitmap.height <= 40_000_000;
      bitmap.close();
      if (!valid) throw new Error('图片尺寸过大');
      accepted.push({ file, preview: URL.createObjectURL(file) }); totalBytes += file.size;
    } catch { skipped.push(`${file.name}：坏图或图片尺寸超过 4000 万像素`); }
  }
  return { accepted, skipped };
}
export async function newBatchOutputDirectory(parent: BatchDirectoryHandle, batchId: string) {
  const name = `batch-${batchId.slice(0, 12)}-${crypto.randomUUID().slice(0, 8)}`;
  try { await parent.getDirectoryHandle(name); throw new Error('结果子目录已存在，请重试'); }
  catch (error) { if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error; }
  return parent.getDirectoryHandle(name, { create: true });
}
export async function writeUniqueBatchFile(directory: BatchDirectoryHandle, name: string, data: Blob | string) {
  let target = name;
  try {
    await directory.getFileHandle(target);
    const dot = name.lastIndexOf('.');
    target = `${name.slice(0, dot)}-${crypto.randomUUID().slice(0, 8)}${name.slice(dot)}`;
  } catch (error) { if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error; }
  const handle = await directory.getFileHandle(target, { create: true });
  const writer = await handle.createWritable();
  try { await writer.write(data); await writer.close(); } catch (error) { await writer.abort().catch(() => {}); throw error; }
  const actual = await handle.getFile();
  const expectedSize = typeof data === 'string' ? new Blob([data]).size : data.size;
  if (actual.size !== expectedSize) throw new Error('保存大小未确认，请重试保存，不需要重新生成');
  return target;
}
