import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { buildAllMultiviewPreviews, readMultiviewPreviewManifest } from '../src/lib/video/multiview-preview';
import { createMultiviewLatestTargetGate, createMultiviewPreviewManifest, multiviewPreviewChunkIndex,
  multiviewPreviewRetainedChunks, MULTIVIEW_PREVIEW_MAX_BYTES } from '../src/lib/video/multiview-preview-contract';

const exec = promisify(execFile);
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sd2-multiview-preview-'));
  try {
    const source = path.join(root, 'source.mp4');
    await exec(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25',
      '-frames:v', '97', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', source], { timeout: 30000 });
    const timestamps = Array.from({ length: 97 }, (_, frame) => frame / 25);
    const info = { taskId: 'test-preview', sourceVersion: 'a'.repeat(64), width: 320, height: 180, duration: 97 / 25, timestamps };
    const manifest = await buildAllMultiviewPreviews({ source, dir: root, info, signal: AbortSignal.timeout(60000) });
    assert(manifest.eager, '97 frames should use eager preview generation');
    assert(manifest.chunks.length === 5 && manifest.chunks.every(chunk => chunk.ready), 'all eager preview chunks must be ready');
    assert(manifest.chunks.reduce((sum, chunk) => sum + (chunk.bytes || 0), 0) <= MULTIVIEW_PREVIEW_MAX_BYTES, 'preview cache exceeds limit');
    assert(multiviewPreviewChunkIndex(23) === 0 && multiviewPreviewChunkIndex(24) === 1, 'chunk boundary is incorrect');
    assert(JSON.stringify(multiviewPreviewRetainedChunks(2, [0, 1, 2, 3])) === JSON.stringify([2, 1]), 'decoded preview retention is not bounded');
    const gate = createMultiviewLatestTargetGate();
    const targets = Array.from({ length: 10 }, (_, frame) => gate.issue(frame));
    assert(targets.slice(0, -1).every(target => !gate.isCurrent(target)) && gate.isCurrent(targets.at(-1)!), 'rapid frame changes did not preserve latest-target-wins');
    const atlas = await readFile(path.join(root, 'preview-v1', 'chunk-0004.jpg'));
    const metadata = await sharp(atlas).metadata();
    assert(metadata.format === 'jpeg' && metadata.width === manifest.cellWidth * manifest.columns
      && metadata.height === manifest.cellHeight * manifest.rows, 'atlas dimensions or format are incorrect');
    const restored = await readMultiviewPreviewManifest(root, info);
    assert(JSON.stringify(restored.chunks) === JSON.stringify(manifest.chunks), 'cached manifest did not restore exactly');
    const lazy = createMultiviewPreviewManifest({ sourceVersion: 'b'.repeat(64), width: 1080, height: 1920,
      timestamps: Array.from({ length: 601 }, (_, frame) => frame / 30) });
    assert(!lazy.eager && lazy.chunks.length === 26 && lazy.chunks.at(-1)?.count === 1, 'long-video lazy boundary is incorrect');
    const route = await readFile(path.join(process.cwd(), 'src/app/api/video/multiview/[id]/previews/route.ts'), 'utf8');
    assert(route.includes('getSession()') && route.includes('multiviewPreviewAtlas') && route.includes("'Cache-Control': 'private, no-store'"), 'preview route lost authorization or private cache boundary');
    console.log('multiview preview engineering checks passed');
  } finally { await rm(root, { recursive: true, force: true }); }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
