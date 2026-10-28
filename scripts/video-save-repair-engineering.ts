import './server-runtime.cjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, mkdir, writeFile, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const execute = promisify(execFile);
async function main() {
  if (process.argv[2] === '--contender') {
    const [{ prisma }, { cacheTaskVideoToLocal }] = await Promise.all([import('../src/lib/prisma'), import('../src/lib/video/local-cache')]);
    try { const task = await prisma.videoTask.findUniqueOrThrow({ where: { id: process.argv[3] } });
      process.stdout.write('CONTENDER:' + JSON.stringify(await cacheTaskVideoToLocal(task)) + '\n'); }
    finally { await prisma.$disconnect(); }
    return;
  }
  assert.equal(process.platform, 'linux', 'The production flock path requires Linux');
  assert.equal(existsSync(path.join(process.cwd(), '.env')), false, 'Use an isolated source copy without production environment links');
  const root = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), 'video-save-repair-'));
  Object.assign(process.env, { NODE_ENV: 'test' });
  process.env.DATABASE_URL = 'file:' + path.join(root, 'isolated.db');
  await writeFile(path.join(root, 'isolated.db'), '');
  await execute(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate', '--schema', 'prisma/schema.prisma'],
    { env: process.env, timeout: 60_000, maxBuffer: 1024 * 1024 });
  const [{ prisma }, cache, queue] = await Promise.all([import('../src/lib/prisma'), import('../src/lib/video/local-cache'), import('../src/lib/video/delivery-queue')]);
  const files: string[] = [], taskIds: string[] = [], operations: Promise<unknown>[] = [];
  let requests = 0;
  const requested = new Map<string, () => void>();
  let original: Buffer = Buffer.alloc(0);
  const server = createServer((request, response) => {
    requests++;
    const name = request.url || '/';
    response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': original.length });
    const count = name.startsWith('/slow/') ? 8 : 5;
    const interval = name.startsWith('/slow/') ? 9_000 : 60;
    let index = 0;
    const send = () => {
      if (response.destroyed) return;
      const end = Math.ceil(original.length * (index + 1) / count);
      response.write(original.subarray(Math.ceil(original.length * index / count), end)); index++;
      requested.get(name)?.(); requested.delete(name);
      if (index === count) response.end(); else { const timer = setTimeout(send, interval); response.once('close', () => clearTimeout(timer)); }
    };
    send();
  });
  try {
    await execute(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=96x96:d=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(root, 'original.mp4')]);
    original = await readFile(path.join(root, 'original.mp4'));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const origin = 'http://127.0.0.1:' + address.port;
    const task = async (kind: string) => {
      const id = 'savefixture-' + randomUUID(); taskIds.push(id);
      return prisma.videoTask.create({ data: { id, provider: 'seedance', model: 'isolated-fixture', generation_mode: 'image_to_video',
        prompt: 'Synthetic engineering fixture; no supplier request', local_status: 'succeeded', provider_task_id: id,
        result_video_url: origin + '/' + kind + '/' + id } });
    };
    const waitForRequest = (url: string) => new Promise<void>(resolve => requested.set(new URL(url).pathname, resolve));

    const exhausted = await task('queue');
    const failed = await prisma.videoDeliveryJob.create({ data: { task_id: exhausted.id, status: 'failed', attempts: 13, max_attempts: 5,
      last_error: 'Original timeout evidence', completed_at: new Date() } });
    const untouched = await queue.enqueueVideoDeliveryJob(exhausted.id);
    assert.equal(untouched.queued, false); assert.equal((await prisma.videoDeliveryJob.findUniqueOrThrow({ where: { id: failed.id } })).status, 'failed');
    await Promise.all([queue.enqueueVideoDeliveryJob(exhausted.id, { force: true }), queue.enqueueVideoDeliveryJob(exhausted.id, { force: true })]);
    const recovered = await prisma.videoDeliveryJob.findUniqueOrThrow({ where: { id: failed.id } });
    assert.equal(recovered.attempts, 13); assert.equal(recovered.max_attempts, 18);
    const history = JSON.parse(recovered.payload_json!); assert.equal(history.recoveries.length, 1);
    assert.equal(history.recoveries[0].previousError, 'Original timeout evidence');
    const claimed = await queue.claimNextVideoDeliveryJob({ workerId: 'fixture-queue-owner' }); assert.ok(claimed);
    const held = await prisma.videoDeliveryJob.findUniqueOrThrow({ where: { id: claimed.id } });
    await queue.enqueueVideoDeliveryJob(exhausted.id, { force: true });
    const same = await prisma.videoDeliveryJob.findUniqueOrThrow({ where: { id: claimed.id } });
    assert.equal(same.locked_by, held.locked_by); assert.equal(same.locked_at?.getTime(), held.locked_at?.getTime()); assert.equal(same.attempts, held.attempts);
    assert.equal(await queue.renewVideoDeliveryJob(claimed), true);
    await queue.failVideoDeliveryJob(claimed, new Error('fixture stop'));

    const slow = await task('slow');
    const firstRequest = waitForRequest(slow.result_video_url!);
    const started = Date.now(); const saved = cache.cacheTaskVideoToLocal(slow);
    operations.push(saved);
    await firstRequest;
    const contender = await execute(process.execPath, ['--import', 'tsx', 'scripts/video-save-repair-engineering.ts', '--contender', slow.id],
      { env: process.env, timeout: 20_000, maxBuffer: 1024 * 1024 });
    const overlap = JSON.parse(contender.stdout.split('\n').find(value => value.startsWith('CONTENDER:'))!.slice(10));
    assert.equal(overlap.in_progress, true); assert.equal(requests, 1, 'The second process must not start a provider download');

    const stream = (delays: number[]) => new Response(new ReadableStream<Uint8Array>({ async start(controller) {
      for (const delay of delays) { await new Promise(resolve => setTimeout(resolve, delay)); controller.enqueue(Uint8Array.of(1)); } controller.close();
    } }));
    const continuous = path.join(root, 'continuous.bin');
    await cache.writeResponseToFile(stream([30, 30, 30, 30]), continuous, 4, 500, { idleTimeoutMs: 80 });
    assert.equal((await stat(continuous)).size, 4);
    await assert.rejects(cache.writeResponseToFile(stream([10, 120]), path.join(root, 'idle.bin'), 2, 500, { idleTimeoutMs: 60 }), /停滞/);
    await assert.rejects(cache.writeResponseToFile(stream([30, 30, 30, 30]), path.join(root, 'total.bin'), 4, 80, { idleTimeoutMs: 60 }), /下载超时/);
    assert.equal(existsSync(path.join(root, 'idle.bin')), false); assert.equal(existsSync(path.join(root, 'total.bin')), false);

    const changed = await task('changed'); const changing = waitForRequest(changed.result_video_url!);
    const oldSave = cache.cacheTaskVideoToLocal(changed); await changing;
    operations.push(oldSave);
    await prisma.videoTask.update({ where: { id: changed.id }, data: { result_video_url: origin + '/changed-source' } });
    const rejected = await oldSave; assert.equal(rejected.success, false); assert.equal(rejected.error, 'VIDEO_SAVE_SOURCE_CHANGED');
    assert.equal((await prisma.videoTask.findUniqueOrThrow({ where: { id: changed.id } })).local_video_path, null);

    const fenced = await task('fenced');
    await queue.enqueueVideoDeliveryJob(fenced.id, { priority: 100 });
    const old = await queue.claimNextVideoDeliveryJob({ workerId: 'fixture-old-owner' }); assert.ok(old); assert.equal(old.task_id, fenced.id);
    const reading = waitForRequest(fenced.result_video_url!);
    const oldWriter = cache.cacheTaskVideoToLocal(fenced, { saveFence: { jobId: old.id, workerId: old.locked_by!, attempt: old.attempts } });
    operations.push(oldWriter);
    await reading;
    await prisma.videoDeliveryJob.update({ where: { id: old.id }, data: { locked_by: 'fixture-new-owner', attempts: { increment: 1 } } });
    const denied = await oldWriter; assert.equal(denied.success, false); assert.equal(denied.error, 'VIDEO_SAVE_LEASE_LOST');
    await queue.failVideoDeliveryJob(old, new Error('late original owner'));
    assert.equal((await prisma.videoDeliveryJob.findUniqueOrThrow({ where: { id: old.id } })).locked_by, 'fixture-new-owner');
    assert.equal((await prisma.videoTask.findUniqueOrThrow({ where: { id: fenced.id } })).local_video_path, null);

    const complete = await saved;
    assert.equal(complete.success, true); assert.ok(Date.now() - started > 60_000, 'Real continuous transfer must exceed the old 60s total cutoff');
    const savedTask = await prisma.videoTask.findUniqueOrThrow({ where: { id: slow.id } }); assert.ok(savedTask.local_video_path);
    const absolute = path.join(process.cwd(), 'public', savedTask.local_video_path.slice(1)); files.push(absolute);
    assert.equal(createHash('sha256').update(await readFile(absolute)).digest('hex'), createHash('sha256').update(original).digest('hex'));
    await cache.validateLocalMp4(absolute);
    const already = await cache.cacheTaskVideoToLocal(savedTask); assert.equal(already.already_exists, true);
    const remaining = (await readdir(path.dirname(absolute))).filter(name => taskIds.some(id => name.startsWith(id)) && name.endsWith('.tmp'));
    assert.deepEqual(remaining, []);
    process.stdout.write(JSON.stringify({ passed: true, cases: ['real SQLite bounded CAS retry/history/in-flight force', 'kernel flock process overlap',
      'continuous idle/total separation', 'stale source denied before publish', 'lost lease late writer denied', 'real continuous MP4 >60s and exact bytes',
      'ready fast path and own temporary cleanup'], longStreamMilliseconds: Date.now() - started, productionWrites: 0, externalSends: 0 }) + '\n');
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await Promise.allSettled(operations);
    const completed = await prisma.videoTask.findMany({ where: { id: { in: taskIds } }, select: { id: true, local_video_path: true } });
    for (const task of completed) if (task.local_video_path?.startsWith('/videos/' + task.id + '-')) files.push(path.join(process.cwd(), 'public', task.local_video_path.slice(1)));
    for (const file of files) await rm(file, { force: true });
    for (const id of taskIds) await rm(path.join(process.cwd(), '.cache/video-save-locks', createHash('sha256').update(id).digest('hex') + '.lock'), { force: true });
    await prisma.$disconnect(); await rm(root, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'video save engineering failed'); process.exitCode = 1; });
