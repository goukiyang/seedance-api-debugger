import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mock } from 'node:test';
import https from 'node:https';
import dns from 'node:dns/promises';
import { readStudioImage, StudioImageDownloadError } from '../src/lib/image-studio/media';

// Offline transport fixture: exercise production deadlines without paid requests or real DNS.
async function main() {
  const realTimeout = globalThis.setTimeout;
  const realAbortTimeout = AbortSignal.timeout;
  let mode: 'flow' | 'stall' | 'connect' | 'total' | 'private' = 'flow';
  let requests = 0;
  const pinned: string[] = [];
  mock.method(globalThis, 'setTimeout', (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    realTimeout(callback, ms && ms >= 10000 ? ms / 100 : ms, ...args));
  mock.method(AbortSignal, 'timeout', (ms: number) => realAbortTimeout(ms >= 10000 ? ms / 100 : ms));
  mock.method(dns, 'lookup', async () => mode === 'private'
    ? [{ address: '127.0.0.1', family: 4 }]
    : [{ address: '1.1.1.1', family: 4 }, { address: '8.8.8.8', family: 4 }]);
  mock.method(https, 'get', (_url: URL, options: { signal: AbortSignal; lookup: Function }, onResponse: (response: EventEmitter) => void) => {
    requests++;
    options.lookup('', {}, (_error: unknown, address: string) => pinned.push(address));
    const request = new EventEmitter() as EventEmitter & { destroy: () => void; reusedSocket: boolean };
    const response = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string>; complete: boolean; destroy: () => void };
    const timers: ReturnType<typeof realTimeout>[] = [];
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      timers.forEach(clearTimeout);
      options.signal.removeEventListener('abort', abort);
      request.emit('close');
    };
    const abort = () => { request.emit('error', Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })); close(); };
    request.destroy = close;
    request.reusedSocket = false;
    response.destroy = close;
    response.statusCode = 200;
    response.headers = {};
    response.complete = false;
    options.signal.addEventListener('abort', abort, { once: true });
    queueMicrotask(() => {
      if (options.signal.aborted) { abort(); return; }
      const socket = new EventEmitter();
      request.emit('socket', socket);
      if (mode === 'connect') return;
      socket.emit('secureConnect');
      onResponse(response);
      response.emit('data', Buffer.from('x'));
      if (mode === 'stall') return;
      const count = mode === 'total' ? 10 : 3;
      for (let index = 1; index <= count; index++) {
        timers.push(realTimeout(() => {
          response.emit('data', Buffer.from('x'));
          if (mode === 'flow' && index === count) {
            response.complete = true;
            response.emit('end');
            close();
          }
        }, index * 300));
      }
    });
    return request;
  });
  try {
    assert.equal((await readStudioImage('https://fixture.invalid/image')).length, 4, 'continuous download may exceed old per-hop deadline');
    mode = 'stall'; requests = 0; pinned.length = 0;
    await assert.rejects(readStudioImage('https://fixture.invalid/image'), error => {
      assert.ok(error instanceof StudioImageDownloadError);
      // Both attempts share one total deadline; the second one cannot extend it.
      assert.equal(error.code, 'download_total_timeout');
      assert.equal(error.diagnostics?.phase, 'body');
      assert.equal(error.diagnostics?.receivedBytes, 1);
      return true;
    });
    assert.equal(requests, 2);
    assert.deepEqual(pinned, ['1.1.1.1', '8.8.8.8']);
    mode = 'connect'; requests = 0;
    await assert.rejects(readStudioImage('https://fixture.invalid/image'), error => {
      assert.ok(error instanceof StudioImageDownloadError);
      assert.equal(error.code, 'download_connect_timeout');
      assert.equal(error.diagnostics?.phase, 'connect');
      return true;
    });
    assert.equal(requests, 2);
    mode = 'total';
    await assert.rejects(readStudioImage('https://fixture.invalid/image'), error => {
      assert.ok(error instanceof StudioImageDownloadError);
      assert.equal(error.code, 'download_total_timeout');
      return true;
    });
    mode = 'private'; requests = 0;
    await assert.rejects(readStudioImage('https://fixture.invalid/image'), error => error instanceof StudioImageDownloadError && error.code === 'download_unsafe_address');
    assert.equal(requests, 0);
    console.log('PASS: flowing body, stalled body, total deadline, connect timeout, retry IP rotation and private DNS guard; offline only.');
  } finally { mock.restoreAll(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
