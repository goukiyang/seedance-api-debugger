import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { Readable, Transform } from 'node:stream';
import { isPublicAddress, publicHttpUrl } from './public-address';

export type SafeFetchCode = 'ADDRESS_NOT_ALLOWED' | 'TIMEOUT' | 'TOO_LARGE' | 'UPSTREAM_ERROR';
type NetworkPhase = 'dns' | 'connect' | 'headers' | 'body';
export class SafeFetchError extends Error {
  constructor(public readonly code: SafeFetchCode, public readonly phase?: NetworkPhase | 'total') { super(code); this.name = 'SafeFetchError'; }
}
export type SafeFetchOptions = {
  method?: 'GET' | 'HEAD' | 'POST';
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  maxBytes: number;
  timeoutMs: number;
  allowRedirects?: boolean;
  signal?: AbortSignal;
  addressIndex?: number;
  headersTimeoutMs?: number;
  onPhase?: (phase: NetworkPhase, redirects: number) => void;
};

function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason instanceof SafeFetchError ? signal.reason : new SafeFetchError('TIMEOUT', 'dns'));
    if (signal.aborted) { promise.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      () => { signal.removeEventListener('abort', abort); reject(new SafeFetchError(signal.aborted ? 'TIMEOUT' : 'UPSTREAM_ERROR')); });
  });
}

export async function validatePublicUrl(source: string, signal = AbortSignal.timeout(10_000)) {
  const url = publicHttpUrl(source);
  if (!url) throw new SafeFetchError('ADDRESS_NOT_ALLOWED');
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  const addresses = await untilAbort(lookup(host, { all: true, verbatim: true }), AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
  if (!addresses.length || addresses.some(item => ![4, 6].includes(item.family) || !isPublicAddress(item.address))) {
    throw new SafeFetchError('ADDRESS_NOT_ALLOWED');
  }
  return { url, addresses };
}

// Public resources only: never use this transport for credential-bearing provider dispatch.
export async function safeFetch(source: string, options: SafeFetchOptions): Promise<Response> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0 || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new SafeFetchError('UPSTREAM_ERROR');
  }
  const method = options.method || 'GET';
  if (!['GET', 'HEAD', 'POST'].includes(method) || (method !== 'POST' && options.body !== undefined)) throw new SafeFetchError('UPSTREAM_ERROR');
  if (options.body && Buffer.byteLength(options.body) > 1024 * 1024) throw new SafeFetchError('TOO_LARGE');
  const headers: Record<string, string> = { 'Accept-Encoding': 'identity' };
  for (const [name, value] of Object.entries(options.headers || {})) {
    if (!['accept', 'accept-encoding', 'content-type', 'range', 'if-range', 'user-agent'].includes(name.toLowerCase())
      || /[\r\n]/.test(value) || (name.toLowerCase() === 'accept-encoding' && value !== 'identity')) throw new SafeFetchError('UPSTREAM_ERROR');
    headers[name] = value;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new SafeFetchError('TIMEOUT', 'total')), options.timeoutMs);
  const abort = () => controller.abort(new SafeFetchError('TIMEOUT', 'total'));
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
  const signal = controller.signal;
  const perform = async (value: string, redirects: number): Promise<Response> => {
    options.onPhase?.('dns', redirects);
    const { url, addresses } = await validatePublicUrl(value, signal);
    if (signal.aborted) throw new SafeFetchError('TIMEOUT');
    return new Promise((resolve, reject) => {
      let stream: Transform | undefined;
      let stageTimer: ReturnType<typeof setTimeout> | undefined;
      const clearStage = () => { if (stageTimer) clearTimeout(stageTimer); };
      const fail = (error?: unknown) => {
        const classified = error instanceof SafeFetchError ? error : signal.aborted && signal.reason instanceof SafeFetchError
          ? signal.reason : new SafeFetchError(signal.aborted ? 'TIMEOUT' : 'UPSTREAM_ERROR');
        clearStage(); cleanup(); stream?.destroy(classified); reject(classified);
      };
      const index = Number.isSafeInteger(options.addressIndex) && options.addressIndex! >= 0 ? options.addressIndex! : 0;
      const pinned = addresses[index % addresses.length];
      options.onPhase?.('connect', redirects);
      const upstream = (url.protocol === 'https:' ? https : http).request(url, {
        method, headers, signal, family: pinned.family, agent: false,
        lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family),
      }, response => {
        clearStage();
        const status = response.statusCode || 502;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = response.headers.location;
          response.destroy();
          if (!options.allowRedirects || method === 'POST' || !location || redirects >= 3) { fail(); return; }
          let next: URL;
          try { next = new URL(location, url); } catch { fail(); return; }
          if (url.protocol === 'https:' && next.protocol !== 'https:') { fail(new SafeFetchError('ADDRESS_NOT_ALLOWED')); return; }
          perform(next.href, redirects + 1).then(resolve, error => { cleanup(); reject(error); });
          return;
        }
        const resultHeaders = new Headers();
        for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'content-encoding']) {
          const item = response.headers[name];
          if (typeof item === 'string') resultHeaders.set(name, item);
        }
        const length = response.headers['content-length'];
        if (status >= 200 && status < 300 && length !== undefined
          && (!/^\d+$/.test(String(length)) || Number(length) > options.maxBytes)) {
          response.destroy(); fail(new SafeFetchError('TOO_LARGE')); return;
        }
        // Preserve HTTP status for expired URLs/ranges, never expose an upstream error body.
        if (status < 200 || status >= 300 || method === 'HEAD' || status === 204 || status === 205) {
          response.destroy(); cleanup(); resolve(new Response(null, { status: status < 200 ? 502 : status, headers: resultHeaders })); return;
        }
        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') { response.destroy(); fail(); return; }
        let bytes = 0;
        options.onPhase?.('body', redirects);
        stream = new Transform({ transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > options.maxBytes) callback(new SafeFetchError('TOO_LARGE'));
          else callback(null, chunk);
        }, flush(callback) {
          callback(length !== undefined && bytes !== Number(length) ? new SafeFetchError('UPSTREAM_ERROR') : null);
        } });
        response.once('error', fail);
        response.once('aborted', () => fail());
        response.setTimeout(60_000, () => response.destroy(new SafeFetchError('TIMEOUT', 'body')));
        stream.once('error', () => { response.destroy(); upstream.destroy(); clearStage(); cleanup(); });
        stream.once('end', cleanup);
        stream.once('close', () => { response.destroy(); upstream.destroy(); cleanup(); });
        response.pipe(stream);
        resolve(new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, headers: resultHeaders }));
      });
      stageTimer = setTimeout(() => upstream.destroy(new SafeFetchError('TIMEOUT', 'connect')), 20_000);
      upstream.once('socket', socket => {
        const connected = () => {
          clearStage(); options.onPhase?.('headers', redirects);
          stageTimer = setTimeout(() => upstream.destroy(new SafeFetchError('TIMEOUT', 'headers')), Math.min(options.headersTimeoutMs || 30_000, 60_000));
        };
        if (upstream.reusedSocket) connected();
        else socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', connected);
      });
      upstream.once('error', fail);
      upstream.once('close', clearStage);
      upstream.end(options.body);
    });
  };
  try { return await perform(source, 0); }
  catch (error) { cleanup(); throw error instanceof SafeFetchError ? error : new SafeFetchError(signal.aborted ? 'TIMEOUT' : 'UPSTREAM_ERROR'); }
}
