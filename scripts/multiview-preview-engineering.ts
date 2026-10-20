import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { buildAllMultiviewPreviews, readMultiviewPreviewManifest } from '../src/lib/video/multiview-preview';
import { createMultiviewLatestTargetGate, createMultiviewPreviewManifest, multiviewPreviewChunkIndex,
  multiviewPreviewRetainedChunks, multiviewPreviewFrameRect, MULTIVIEW_PREVIEW_MAX_BYTES } from '../src/lib/video/multiview-preview-contract';
import { parseMediaPreviewStoredState } from '../src/lib/media/media-preview-state-contract';
import { createMultiviewFrameScrub } from '../src/app/multiview/multiview-frame-scrub';
import { multiviewGenerationProgress } from '../src/app/multiview/multiview-generation-progress';

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
    assert(parseMediaPreviewStoredState(null, true).loop, 'first multiview visit must loop by default');
    assert(!parseMediaPreviewStoredState(JSON.stringify({ version: 1, state: { loop: false } }), true).loop, 'saved loop-off was overwritten');
    assert(parseMediaPreviewStoredState(JSON.stringify({ version: 1, state: { currentTime: 2 } }), true).loop, 'missing legacy loop must use the caller default');
    assert(!parseMediaPreviewStoredState(null).loop, 'other media surfaces changed their loop default');
    const coloredAtlas = await sharp({ create: { width: manifest.columns * manifest.cellWidth, height: manifest.rows * manifest.cellHeight,
      channels: 3, background: { r: 0, g: 0, b: 0 } } }).composite(await Promise.all(Array.from({ length: 24 }, async (_, index) => ({
      input: await sharp({ create: { width: manifest.cellWidth, height: manifest.cellHeight, channels: 3,
        background: { r: index * 10, g: 100, b: 255 - index * 10 } } }).png().toBuffer(),
      left: index % 6 * manifest.cellWidth, top: Math.floor(index / 6) * manifest.cellHeight,
    })))).png().toBuffer();
    for (const frame of [0, 5, 6, 23, 24, 47, 96]) {
      const rect = multiviewPreviewFrameRect(manifest, frame);
      assert(rect, `frame ${frame} has no atlas cell`);
      const pixel = await sharp(coloredAtlas).extract({ left: rect!.x, top: rect!.y, width: rect!.width, height: rect!.height }).resize(1, 1).raw().toBuffer();
      assert(pixel[0] === frame % 24 * 10 && pixel[1] === 100 && pixel[2] === 255 - frame % 24 * 10,
        `frame ${frame} cropped pixels from a different atlas cell`);
    }
    assert(multiviewPreviewFrameRect(manifest, -1) === null && multiviewPreviewFrameRect(manifest, 97) === null
      && multiviewPreviewFrameRect(manifest, 1.5) === null, 'invalid preview frame was accepted');
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
    const { createMultiviewOriginalQueue } = await import('../src/app/multiview/multiview-original-queue');
    const queue = createMultiviewOriginalQueue();
    let release!: (value: boolean) => void;
    const calls: number[] = [];
    const first = queue.request(1, () => { calls.push(1); return new Promise(done => { release = done; }); }, true);
    queue.background([2], true);
    const obsolete = queue.request(2, async () => { calls.push(2); return true; }, false);
    queue.background([3], true);
    const last = queue.request(3, async () => { calls.push(3); return true; }, false);
    const explicit = queue.request(4, async () => { calls.push(4); return true; }, true);
    assert(await obsolete === false && calls.join(',') === '1', 'obsolete target was not dropped while original work was active');
    release(true); await first; await explicit;
    queue.background([3]); await last;
    assert(calls.join(',') === '1,4,3', 'original queue lost explicit priority or serialized background order');
    queue.clear();
    const task = { id: 'local-task', local_status: 'running', provider_task_id: 'upstream-task', provider_status: 'queued', created_at: '2026-10-20T00:00:00.000Z' };
    const queued = multiviewGenerationProgress('submitted', task);
    assert(queued?.step === 1 && !queued.uncertain, 'explicit accepted queue must establish waiting stage');
    const running = multiviewGenerationProgress('submitted', { ...task, provider_status: 'processing' }, queued);
    assert(running?.step === 2, 'explicit provider processing must establish generation stage');
    assert(multiviewGenerationProgress('submitted', { ...task, provider_task_id: task.id })?.step === null, 'local task id cannot establish upstream acceptance');
    assert(multiviewGenerationProgress('submitted', { ...task, provider_status: 'unrecognized' }, running)?.step === 2, 'unknown provider status must retain last confirmed stage');
    assert(multiviewGenerationProgress('unknown', task, running)?.uncertain, 'unknown submit must not appear accepted');
    assert(multiviewGenerationProgress('submitted', { ...task, local_status: 'failed' }, running)?.failed, 'failure must remain failure');
    assert(multiviewGenerationProgress('video_ready', task, running)?.step === 3, 'ready video cannot claim preview frames already ready');

    const requests: number[] = [], shown: number[] = [], commits: number[] = [];
    const deferred = new Map<number, (url: string | null) => void>();
    let cancelled = 0, settled = 0;
    const scrub = createMultiviewFrameScrub({
      preview: frame => { requests.push(frame); return new Promise(resolve => deferred.set(frame, resolve)); },
      commit: frame => { commits.push(frame); return true; }, cancel: () => { cancelled++; },
    }, frame => shown.push(frame), () => { settled++; });
    scrub.target(1); scrub.target(2); scrub.target(3); scrub.finish(4);
    assert(requests.join(',') === '1' && commits.length === 0, 'scrub started concurrent previews or committed intermediate frame');
    deferred.get(1)!('one'); await Promise.resolve(); await Promise.resolve();
    assert(requests.join(',') === '1,4' && shown.length === 0, 'scrub failed to discard obsolete intermediate targets');
    deferred.get(4)!('four'); await Promise.resolve(); await Promise.resolve();
    assert(shown.join(',') === '4' && commits.join(',') === '4' && cancelled === 1 && settled === 1, 'scrub final readable target must commit exactly once');
    scrub.finish(4); scrub.cancel();
    assert(commits.length === 1 && settled === 1, 'finished scrub was repeated or undone by lost capture');
    let late!: (url: string | null) => void;
    const abandoned = createMultiviewFrameScrub({ preview: () => new Promise(resolve => { late = resolve; }),
      commit: () => { throw new Error('cancelled gesture committed'); }, cancel: () => {} }, () => { throw new Error('cancelled gesture displayed late response'); }, () => {});
    abandoned.target(5); abandoned.cancel(); late('late');
    await Promise.resolve(); await Promise.resolve();
    let failure = '';
    const failed = createMultiviewFrameScrub({ preview: async () => null,
      commit: () => { throw new Error('unreadable target committed'); }, cancel: () => {} }, () => {}, message => { failure = message || ''; });
    failed.finish(6); await Promise.resolve(); await Promise.resolve();
    assert(Boolean(failure), 'unreadable final preview must preserve original selection and report retry');
    console.log('multiview preview engineering checks passed');
  } finally { await rm(root, { recursive: true, force: true }); }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
