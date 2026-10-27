import { openUntrustedImage } from '@/lib/media/decode-image';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createMultiviewPreviewManifest, MULTIVIEW_PREVIEW_CHUNK_SIZE, MULTIVIEW_PREVIEW_COLUMNS,
  MULTIVIEW_PREVIEW_MAX_BYTES, MULTIVIEW_PREVIEW_ROWS, type MultiviewPreviewManifest } from './multiview-preview-contract';
import type { MultiviewInfo } from './multiview-contract';

const exec = promisify(execFile);
const PREVIEW_DIR = 'preview-v1';
const previewName = (index: number) => `chunk-${String(index).padStart(4, '0')}.jpg`;
const jpegDigest = (data: Buffer) => `"${createHash('sha256').update(data).digest('hex')}"`;

async function atomicWrite(file: string, data: Buffer | string) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temp, data, { mode: 0o600 }); await rename(temp, file); }
  finally { await rm(temp, { force: true }); }
}

async function validateAtlas(file: string, manifest: MultiviewPreviewManifest) {
  const data = await readFile(file);
  if (!data.length || data.length > MULTIVIEW_PREVIEW_MAX_BYTES) throw new Error('preview_atlas_invalid_size');
  const metadata = await (await openUntrustedImage(data, 'multiview-output')).metadata();
  if (metadata.format !== 'jpeg' || metadata.width !== manifest.cellWidth * MULTIVIEW_PREVIEW_COLUMNS
    || metadata.height !== manifest.cellHeight * MULTIVIEW_PREVIEW_ROWS) throw new Error('preview_atlas_invalid_dimensions');
  return { data, bytes: data.length, etag: jpegDigest(data) };
}

async function readyChunks(dir: string, manifest: MultiviewPreviewManifest) {
  const ready = new Map<number, { bytes: number; etag: string }>();
  let bytes = 0;
  for (const chunk of manifest.chunks) {
    const file = path.join(dir, previewName(chunk.index));
    try {
      const value = await validateAtlas(file, manifest);
      bytes += value.bytes;
      if (bytes > MULTIVIEW_PREVIEW_MAX_BYTES) throw new Error('preview_cache_limit');
      ready.set(chunk.index, { bytes: value.bytes, etag: value.etag });
    } catch (error) {
      if (error instanceof Error && error.message === 'preview_cache_limit') throw error;
    }
  }
  return ready;
}

function baseManifest(info: MultiviewInfo) {
  return createMultiviewPreviewManifest({ sourceVersion: info.sourceVersion, width: info.width, height: info.height, timestamps: info.timestamps });
}

export async function readMultiviewPreviewManifest(dir: string, info: MultiviewInfo) {
  const previewDir = path.join(dir, PREVIEW_DIR);
  const base = baseManifest(info);
  const ready = await readyChunks(previewDir, base).catch(error => {
    if (error instanceof Error && error.message === 'preview_cache_limit') throw error;
    return new Map<number, { bytes: number; etag: string }>();
  });
  return createMultiviewPreviewManifest({ sourceVersion: info.sourceVersion, width: info.width, height: info.height, timestamps: info.timestamps }, ready);
}

async function renderChunk(source: string, output: string, manifest: MultiviewPreviewManifest, index: number, signal: AbortSignal) {
  const chunk = manifest.chunks[index];
  if (!chunk) throw new Error('preview_chunk_invalid');
  const temp = `${output}.${randomUUID()}.tmp.jpg`;
  const filter = `select=between(n\\,${chunk.start}\\,${chunk.start + chunk.count - 1}),scale=${manifest.cellWidth}:${manifest.cellHeight},tile=${MULTIVIEW_PREVIEW_COLUMNS}x${MULTIVIEW_PREVIEW_ROWS}:nb_frames=${MULTIVIEW_PREVIEW_CHUNK_SIZE}:padding=0:margin=0`;
  try {
    await exec(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-v', 'error', '-threads', '1', '-protocol_whitelist', 'file,pipe',
      '-format_whitelist', 'mov,matroska,webm,avi', '-i', source, '-an', '-sn', '-dn', '-vf', filter, '-frames:v', '1',
      '-fps_mode', 'vfr', '-filter_threads', '1', '-threads', '1', '-q:v', '5', temp],
    { timeout: 60000, maxBuffer: 512 * 1024, signal });
    await validateAtlas(temp, manifest);
    await rename(temp, output);
  } finally { await rm(temp, { force: true }); }
}

async function renderAll(source: string, outputDir: string, manifest: MultiviewPreviewManifest, signal: AbortSignal) {
  const filter = `scale=${manifest.cellWidth}:${manifest.cellHeight},tile=${MULTIVIEW_PREVIEW_COLUMNS}x${MULTIVIEW_PREVIEW_ROWS}:nb_frames=${MULTIVIEW_PREVIEW_CHUNK_SIZE}:padding=0:margin=0`;
  await exec(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-v', 'error', '-threads', '1', '-protocol_whitelist', 'file,pipe',
    '-format_whitelist', 'mov,matroska,webm,avi', '-i', source, '-an', '-sn', '-dn', '-vf', filter,
    '-frames:v', String(manifest.chunks.length), '-fps_mode', 'vfr', '-filter_threads', '1', '-threads', '1',
    '-q:v', '5', '-start_number', '0', path.join(outputDir, 'chunk-%04d.jpg')],
  { timeout: 120000, maxBuffer: 512 * 1024, signal });
}

export async function buildMultiviewPreviewChunk(input: {
  source: string;
  dir: string;
  info: MultiviewInfo;
  index: number;
  signal: AbortSignal;
}) {
  const manifest = baseManifest(input.info);
  if (!manifest.chunks[input.index]) throw new Error('preview_chunk_invalid');
  const previewDir = path.join(input.dir, PREVIEW_DIR);
  await mkdir(previewDir, { recursive: true, mode: 0o700 });
  const output = path.join(previewDir, previewName(input.index));
  try { return { ...(await validateAtlas(output, manifest)), file: output }; }
  catch {}
  await renderChunk(input.source, output, manifest, input.index, input.signal);
  const metrics = await previewDirectoryMetrics(previewDir);
  if (metrics.bytes > MULTIVIEW_PREVIEW_MAX_BYTES) {
    await rm(output, { force: true });
    throw new Error('preview_cache_limit');
  }
  return { ...(await validateAtlas(output, manifest)), file: output };
}

export async function readMultiviewPreviewChunk(dir: string, info: MultiviewInfo, index: number) {
  const manifest = baseManifest(info);
  if (!manifest.chunks[index]) return null;
  const file = path.join(dir, PREVIEW_DIR, previewName(index));
  try { return { ...(await validateAtlas(file, manifest)), file }; }
  catch { return null; }
}

export async function buildAllMultiviewPreviews(input: {
  source: string;
  dir: string;
  info: MultiviewInfo;
  signal: AbortSignal;
}) {
  const manifest = baseManifest(input.info);
  if (!manifest.eager) return readMultiviewPreviewManifest(input.dir, input.info);
  const existing = await readMultiviewPreviewManifest(input.dir, input.info);
  if (existing.chunks.every(chunk => chunk.ready)) return existing;
  const finalDir = path.join(input.dir, PREVIEW_DIR);
  const tempDir = `${finalDir}.${randomUUID()}.tmp`;
  const staleDir = `${finalDir}.${randomUUID()}.stale`;
  let movedExisting = false; let published = false;
  await mkdir(tempDir, { recursive: true, mode: 0o700 });
  try {
    await renderAll(input.source, tempDir, manifest, input.signal);
    const generated = await readyChunks(tempDir, manifest);
    if (generated.size !== manifest.chunks.length) throw new Error('preview_atlas_incomplete');
    const bytes = Array.from(generated.values()).reduce((sum, item) => sum + item.bytes, 0);
    if (bytes > MULTIVIEW_PREVIEW_MAX_BYTES) throw new Error('preview_cache_limit');
    await atomicWrite(path.join(tempDir, 'manifest.json'), JSON.stringify(createMultiviewPreviewManifest({ sourceVersion: input.info.sourceVersion,
      width: input.info.width, height: input.info.height, timestamps: input.info.timestamps }, generated)));
    if (await stat(finalDir).then(item => item.isDirectory()).catch(() => false)) { await rename(finalDir, staleDir); movedExisting = true; }
    await rename(tempDir, finalDir);
    published = true;
    await rm(staleDir, { recursive: true, force: true });
    return readMultiviewPreviewManifest(input.dir, input.info);
  } catch (error) {
    if (movedExisting && !published && !await stat(finalDir).then(() => true).catch(() => false)) await rename(staleDir, finalDir).catch(() => undefined);
    throw error;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    if (published) await rm(staleDir, { recursive: true, force: true });
  }
}

export async function previewDirectoryMetrics(dir: string): Promise<{ bytes: number; time: number }> {
  let bytes = 0; let time = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const child = await previewDirectoryMetrics(target); bytes += child.bytes; time = Math.max(time, child.time);
    } else if (entry.isFile()) {
      const item = await stat(target).catch(() => null); bytes += item?.size || 0; time = Math.max(time, item?.mtimeMs || 0);
    }
  }
  return { bytes, time };
}
