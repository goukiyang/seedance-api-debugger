import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mock } from 'node:test';
import https from 'node:https';
import dns from 'node:dns/promises';
import sharp from 'sharp';
import { createStudioDelivery, readStudioDelivery, downloadStudioDelivery, discardStudioDelivery, studioDeliveryCanRetry } from '../src/lib/image-studio/delivery';
import { StudioImageDownloadError, type openStudioImageStream } from '../src/lib/image-studio/media';

async function main() {
  if (!process.env.DATABASE_URL?.startsWith('file:/tmp/sd2-image-studio-test-')) throw new Error('Isolated test database required');
  const original = process.cwd();
  const temporary = await fs.mkdtemp('/tmp/sd2-image-delivery-');
  process.chdir(temporary);
  const { prisma } = await import('../src/lib/prisma');
  const { recoverStudioTasks } = await import('../src/lib/image-studio/worker');
  const { finishStudioTask } = await import('../src/lib/image-studio/tasks');
  const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#317e63' } }).png().toBuffer();
  const task = { id: 'delivery-fixture', owner_id: 'delivery-owner' };
  let mode: 'slow' | 'interrupt' | 'resume' | 'ignore-range' | 'bad-range' | 'expired' = 'interrupt';
  let observedHeaders: Record<string, string> = {};
  function fixture(signal: AbortSignal, headers: Record<string, string> = {}) {
    observedHeaders = headers;
    if (mode === 'expired') throw new StudioImageDownloadError('download_http_error', 403);
    const offset = Number(headers.Range?.match(/\d+/)?.[0] || 0);
    const resumed = offset > 0 && mode !== 'ignore-range';
    const response = new PassThrough() as PassThrough & { statusCode: number; headers: Record<string, string>; complete: boolean; setTimeout: () => void };
    response.statusCode = resumed ? 206 : 200;
    response.headers = { etag: '"fixture-v1"', 'content-length': String(bytes.length - (resumed ? offset : 0)) };
    if (resumed) response.headers['content-range'] = `bytes ${mode === 'bad-range' ? 0 : offset}-${bytes.length - 1}/${bytes.length}`;
    response.complete = false;
    response.setTimeout = () => {};
    const abort = () => response.destroy(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
    signal.addEventListener('abort', abort, { once: true });
    const timers: ReturnType<typeof setTimeout>[] = [];
    response.once('close', () => { signal.removeEventListener('abort', abort); timers.forEach(clearTimeout); });
    queueMicrotask(() => {
      if (mode === 'interrupt') {
        response.write(bytes.subarray(0, bytes.length - 2));
        timers.push(setTimeout(() => response.destroy(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), 10));
      } else if (mode === 'slow') {
        const middle = Math.floor(bytes.length / 2);
        response.write(bytes.subarray(0, middle));
        timers.push(setTimeout(() => { response.complete = true; response.end(bytes.subarray(middle)); }, 40));
      } else { response.complete = true; response.end(bytes.subarray(resumed ? offset : 0)); }
    });
    return response;
  }
  const open: typeof openStudioImageStream = async (_url, signal, _metrics, headers) => fixture(signal, headers) as unknown as import('node:http').IncomingMessage;
  let paidRequests = 0;
  mock.method(globalThis, 'fetch', async () => { paidRequests++; throw new Error('External requests forbidden'); });
  try {
    const record = await createStudioDelivery(task, 'https://fixture.invalid/original?signature=fixture-only', null);
    await assert.rejects(downloadStudioDelivery(record, AbortSignal.timeout(1000), open), error => error instanceof StudioImageDownloadError && error.retryable);
    assert.equal((await fs.stat('storage/studio-delivery/delivery-fixture/image.part')).size, bytes.length - 2);
    const reloaded = (await readStudioDelivery(task))!;
    assert.equal(reloaded.attempts, 1);
    assert.equal((await fs.stat('storage/studio-delivery/delivery-fixture/source.json')).mode & 0o777, 0o600);
    assert.equal((await fs.stat('storage/studio-delivery')).mode & 0o777, 0o700);
    await assert.rejects(readStudioDelivery({ ...task, owner_id: 'other-owner' }));
    mode = 'resume';
    assert.deepEqual(await downloadStudioDelivery(reloaded, AbortSignal.timeout(1000), open), bytes);
    assert.equal(observedHeaders.Range, `bytes=${bytes.length - 2}-`);
    assert.equal(observedHeaders['If-Range'], '"fixture-v1"');
    assert.equal((await sharp(await downloadStudioDelivery((await readStudioDelivery(task))!, AbortSignal.timeout(1000), open)).metadata()).width, 16);
    for (const next of ['ignore-range', 'bad-range'] as const) {
      await discardStudioDelivery(task);
      mode = 'interrupt';
      const fresh = await createStudioDelivery(task, 'https://fixture.invalid/original', null);
      await assert.rejects(downloadStudioDelivery(fresh, AbortSignal.timeout(1000), open));
      mode = next;
      if (next === 'bad-range') await assert.rejects(downloadStudioDelivery(fresh, AbortSignal.timeout(1000), open), /download_invalid_range/);
      else assert.deepEqual(await downloadStudioDelivery(fresh, AbortSignal.timeout(1000), open), bytes);
    }
    await discardStudioDelivery(task);
    mode = 'slow';
    const slow = await createStudioDelivery(task, 'https://fixture.invalid/slow', null);
    assert.deepEqual(await downloadStudioDelivery(slow, AbortSignal.timeout(1000), open), bytes);
    await discardStudioDelivery(task);
    const timeout = await createStudioDelivery(task, 'https://fixture.invalid/slow', null);
    await assert.rejects(downloadStudioDelivery(timeout, AbortSignal.timeout(1000), open, 15), /download_total_timeout/);
    mode = 'expired';
    await assert.rejects(downloadStudioDelivery(timeout, AbortSignal.timeout(1000), open), error => error instanceof StudioImageDownloadError && error.status === 403 && !error.retryable);
    timeout.expiresAt = 0;
    assert.equal(studioDeliveryCanRetry(timeout), false);
    await assert.rejects(downloadStudioDelivery(timeout, AbortSignal.timeout(1000), open), /download_source_expired/);
    timeout.expiresAt = Date.now() + 1000; timeout.attempts = 6;
    await assert.rejects(downloadStudioDelivery(timeout, AbortSignal.timeout(1000), open), /download_retry_limit/);

    await discardStudioDelivery(task);
    await prisma.user.create({ data: { id: task.owner_id, name: 'Fixture', username: 'delivery-owner', email: 'delivery@example.invalid', password_hash: 'not-a-password' } });
    await prisma.creditAccount.create({ data: { user_id: task.owner_id, balance: 80, frozen_credits: 20 } });
    const running = await prisma.imageStudioTask.create({ data: { ...task, batch_id: task.id, ordinal: 1, fingerprint: 'fixture', prompt: '', context: '', revision: 0,
      model: 'gpt-image-2.5-flare', reference_ids: '[]', unit_credits: 20, status: 'running', error: 'Recovering original', lease_token: 'dead-process', lease_until: new Date(0) } });
    mode = 'interrupt';
    const restart = await createStudioDelivery(task, 'https://fixture.invalid/restart', null);
    await assert.rejects(downloadStudioDelivery(restart, AbortSignal.timeout(1000), open));
    mock.method(dns, 'lookup', async () => [{ address: '1.1.1.1', family: 4 }]);
    mock.method(https, 'get', (_url: URL, options: { signal: AbortSignal; headers: Record<string, string> }, callback: (response: unknown) => void) => {
      const request = new EventEmitter() as EventEmitter & { destroy: () => void };
      request.destroy = () => request.emit('close');
      queueMicrotask(() => { callback(fixture(options.signal, options.headers)); request.emit('close'); });
      return request;
    });
    mode = 'resume';
    await recoverStudioTasks();
    const delivered = await prisma.imageStudioTask.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(delivered.status, 'succeeded');
    assert.equal(delivered.error, null);
    assert.ok(delivered.asset_id);
    assert.equal(await readStudioDelivery(task), null);
    assert.equal(await finishStudioTask(running, 'uncertain'), false, 'stale worker cannot refund delivered task');
    await recoverStudioTasks();
    assert.equal(await prisma.creditLedger.count({ where: { related_task_id: task.id, type: 'task_success_deduct' } }), 1);
    assert.equal((await prisma.creditAccount.findUniqueOrThrow({ where: { user_id: task.owner_id } })).frozen_credits, 0);
    assert.equal(paidRequests, 0, 'restart recovery must never regenerate');
    console.log('PASS: slow stream, near-complete interruption, persisted resume, ignored/invalid Range, total deadline, URL expiry, retry bound, private checkpoint, restarted worker, lease and one-time settlement; no paid request.');
  } finally {
    mock.restoreAll();
    await prisma.$disconnect();
    process.chdir(original);
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
