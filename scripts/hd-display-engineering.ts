import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';
import type { HdDescription } from '../src/lib/media/hd-source-session';

// Actual client-session modules in a closed VM, following the existing upload
// engineering harness. No React render, browser, database or real fetch occurs.
export async function runHdDisplayEngineering(): Promise<string[]> {
  const root = path.resolve(__dirname, '..');
  const checks: string[] = [], requests: Array<{ id: string; variant: string; method: string; readonly: boolean }> = [];
  const descriptions = new Map<string, HdDescription | number>();
  const bodies = new Map<string, number>();
  const heads = new Map<string, { status?: number; version?: string; bytes?: number; mime?: string }>();
  const decodes = new Map<string, () => void>(), heldDecodes = new Set<string>();
  const objectUrls = new Map<string, Blob>(), clicked: string[] = [];
  let objectSequence = 0, timerSequence = 0, now = 1_000_000;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const listeners = new Set<() => void>();
  const ready: HdDescription = { policy: 'hd-f-v1', status: 'ready', sourceVersion: 'source-v1', mime: 'image/avif', format: 'avif', bytes: 4, width: 3200, height: 1600 };
  const origin = 'https://sd2.youdooart.com';
  class Clock extends Date { static now() { return now; } }
  class MemoryURL extends URL {
    static createObjectURL(blob: Blob) { const key = `blob:engineering-${++objectSequence}`; objectUrls.set(key, blob); return key; }
    static revokeObjectURL(key: string) { objectUrls.delete(key); }
  }
  class DecodedImage {
    src = '';
    get naturalWidth() { return objectUrls.get(this.src)?.type === 'image/avif' ? 3200 : 640; }
    get naturalHeight() { return this.naturalWidth / 2; }
    decode() {
      const mime = objectUrls.get(this.src)?.type || '';
      return heldDecodes.has(mime) ? new Promise<void>(resolve => { decodes.set(mime, resolve); }) : Promise.resolve();
    }
  }
  const descriptorWait: { resolve?: (response: Response) => void } = {};
  let heldDescriptor = '';
  const globals = {
    URL: MemoryURL, URLSearchParams, Blob, Response, Request, Headers, AbortController, AbortSignal, DOMException,
    Image: DecodedImage, Date: Clock, queueMicrotask, console, crypto: webcrypto,
    navigator: { connection: { saveData: false } }, location: new URL(`${origin}/template-studio`), window: { location: new URL(origin) },
    document: { hidden: false, addEventListener: (_name: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_name: string, listener: () => void) => listeners.delete(listener),
      body: { appendChild: () => {} }, createElement: () => ({ href: '', download: '', rel: '', remove() {}, click() { clicked.push(this.href); } }) },
    setTimeout: (callback: () => void, delay = 0) => { const key = ++timerSequence; timers.set(key, { at: now + delay, callback }); return key; },
    clearTimeout: (key: number) => timers.delete(key),
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), origin), id = url.pathname.split('/').at(-1)!;
      assert.equal(url.origin, origin); assert.match(url.pathname, /^\/api\/image-studio\/assets\/[a-z0-9-]+$/);
      const variant = url.searchParams.get('variant') || ['hd-description', 'hd-download', 'hd', 'thumbnail', 'preview', 'download'].find(name => url.searchParams.get(name) === '1') || 'original';
      const method = init?.method || 'GET', readonly = ['prefetch', 'status'].includes(new Headers(init?.headers).get('X-Image-Read-Intent') || '');
      assert.ok(method === 'GET' || method === 'HEAD', 'no business writes are permitted');
      requests.push({ id, variant, method, readonly });
      if (variant === 'hd-description') {
        if (heldDescriptor === id) return new Promise<Response>(resolve => { descriptorWait.resolve = resolve; });
        const description = descriptions.get(id) || ready;
        return typeof description === 'number' ? new Response(null, { status: description }) : Response.json(description);
      }
      const head = heads.get(id) || {};
      if (method === 'HEAD') return new Response(null, { status: head.status || 200, headers: {
        'Content-Type': head.mime || 'image/avif', 'Content-Length': String(head.bytes || 4), 'X-Image-Source-Version': head.version || 'source-v1',
      } });
      const status = bodies.get(`${id}:${variant}`) || 200;
      if (status >= 400) return new Response(null, { status });
      return new Response(new Uint8Array([1, 2, 3, 4]), { status, headers: { 'Content-Type': variant === 'hd' ? 'image/avif' : 'image/png',
        'Content-Length': '4', 'X-Image-Source-Version': variant === 'hd' ? 'source-v1' : `"${variant}-v1"`,
        ...(status === 206 ? { 'Content-Range': 'bytes 0-3/8' } : {}),
      } });
    },
  };
  const modules = new Map<string, Record<string, any>>();
  const files = new Set(['src/lib/media/image-preview-session.ts', 'src/lib/media/image-read-session.ts', 'src/lib/media/hd-source-session.ts',
    'src/lib/media/hd-display-policy.ts', 'src/lib/media/image-comparison.ts', 'src/lib/media/image-comparison-contract.ts', 'src/lib/media/native-download.ts',
    'src/lib/hooks/use-hd-image-source.ts', 'src/lib/hooks/use-media-preview-state.ts', 'src/lib/media/media-preview-state-contract.ts', 'src/lib/http/json-response.ts']);
  function load(file: string): Record<string, any> {
    if (modules.has(file)) return modules.get(file)!;
    assert.ok(files.has(file), `unapproved engineering import: ${file}`);
    const exports: Record<string, any> = {}; modules.set(file, exports);
    const require = (name: string) => {
      if (name === 'react' || name === '@/lib/context/AppSessionContext') return {};
      const resolved = name.startsWith('@/') ? `src/${name.slice(2)}` : path.posix.normalize(path.posix.join(path.posix.dirname(file), name));
      return load(`${resolved}.ts`);
    };
    const output = ts.transpileModule(readFileSync(path.join(root, file), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    vm.runInNewContext(output, { ...globals, exports, require }, { filename: file });
    return exports;
  }
  const reads = load('src/lib/media/image-read-session.ts') as typeof import('../src/lib/media/image-read-session');
  const preview = load('src/lib/media/image-preview-session.ts') as typeof import('../src/lib/media/image-preview-session');
  const downloads = load('src/lib/media/native-download.ts') as typeof import('../src/lib/media/native-download');
  const sources = load('src/lib/media/image-comparison.ts') as typeof import('../src/lib/media/image-comparison');
  const releases: Array<() => void> = [];
  let account = 'engineering:0', accountSequence = 0;
  const flush = async () => { for (let i = 0; i < 150; i++) await Promise.resolve(); };
  const reset = () => {
    for (const release of releases.splice(0)) release();
    account = `engineering:${++accountSequence}`; reads.setImageReadSessionOwner(account);
    timers.clear(); requests.length = 0; clicked.length = 0; heldDecodes.clear(); decodes.clear();
  };
  const mount = (id: string, options: { original?: boolean; previewOnly?: boolean; intent?: 'prepare' | 'open' } = {}) => {
    const handle = preview.prepareImagePreview({ account, source: `/api/image-studio/assets/${id}`, ...options });
    const release = handle.subscribe(() => {}); handle.release(); releases.push(release); return handle;
  };
  const mountHd = async (id: string) => {
    const descriptors = load('src/lib/media/hd-source-session.ts') as typeof import('../src/lib/media/hd-source-session');
    const prefetch = descriptors.prefetchHdImageSource(account, `/api/image-studio/assets/${id}?hd-description=1`);
    await prefetch.result; prefetch.release(); await flush();
    return mount(id);
  };
  const advance = async () => {
    const timer = Array.from(timers).sort((a, b) => a[1].at - b[1].at)[0];
    assert.ok(timer, 'expected bounded descriptor poll'); timers.delete(timer[0]); now = timer[1].at; timer[1].callback(); await flush();
  };
  const noOriginal = () => assert.equal(requests.filter(request => request.variant === 'original' || request.variant === 'download').length, 0);
  const hdSource = (id: string) => `/api/image-studio/assets/${id}?hd=1&hd-version=source-v1`;
  const proof = { sourceVersion: 'source-v1', bytes: 4, mime: 'image/avif', variant: 'hd' as const, policy: 'hd-f-v1' as const };
  try {
    reset(); heldDescriptor = 'cold-ready';
    const coldReady = mount('cold-ready'); await flush();
    assert.equal(coldReady.getSnapshot().displayKind, 'preview'); noOriginal();
    assert.ok(descriptorWait.resolve); descriptorWait.resolve(Response.json(ready)); heldDescriptor = ''; await flush();
    assert.equal(coldReady.getSnapshot().displayKind, 'hd');
    assert.equal(coldReady.getSnapshot().result.decoded, true); noOriginal();
    checks.push('cold_open_confirms_ready_hd_without_original_request');

    reset(); heldDescriptor = 'confirm-ready';
    const confirmReady = mount('confirm-ready', { intent: 'prepare' }); await flush();
    confirmReady.confirmOpen(); await flush(); noOriginal();
    assert.ok(descriptorWait.resolve); descriptorWait.resolve(Response.json(ready)); heldDescriptor = ''; await flush();
    assert.equal(confirmReady.getSnapshot().displayKind, 'hd'); noOriginal();
    checks.push('confirm_open_during_descriptor_read_does_not_pin_original');

    for (const status of ['queued', 'running', 'failed', 'skipped'] as const) {
      reset(); heldDescriptor = `fallback-${status}`;
      const fallback = mount(`fallback-${status}`); await flush(); noOriginal();
      assert.ok(descriptorWait.resolve); descriptorWait.resolve(Response.json({ ...ready, status })); heldDescriptor = ''; await flush();
      assert.equal(fallback.getSnapshot().displayKind, 'original');
      assert.equal(fallback.getSnapshot().result.decoded, true);
      assert.equal(requests.filter(request => request.variant === 'original').length, 1);
    }
    checks.push('confirmed_missing_or_unready_hd_falls_back_to_original');

    reset(); descriptions.set('descriptor-unavailable', 503);
    const unavailable = mount('descriptor-unavailable'); await flush();
    assert.equal(unavailable.getSnapshot().displayKind, 'original');
    assert.equal(unavailable.getSnapshot().result.decoded, true);
    checks.push('descriptor_failure_preserves_original_fallback');

    reset(); descriptions.set('progressive', { ...ready, status: 'queued' });
    const progressive = mount('progressive', { intent: 'prepare' }); await flush();
    assert.equal(progressive.getSnapshot().displayKind, 'preview'); assert.equal(progressive.getSnapshot().result.decoded, true); noOriginal();
    progressive.confirmOpen(); await flush();
    assert.equal(progressive.getSnapshot().displayKind, 'original'); assert.equal(progressive.getSnapshot().result.decoded, true);
    progressive.markDisplayed(); const shownOriginal = progressive.getSnapshot().result.imageSrc;
    assert.equal(reads.canPrefetchImages(), true);
    descriptions.set('progressive', ready); await advance();
    assert.equal(progressive.getSnapshot().displayKind, 'original'); assert.equal(progressive.getSnapshot().result.imageSrc, shownOriginal);
    assert.equal(progressive.getSnapshot().description?.status, 'ready');
    assert.equal(requests.filter(request => request.variant === 'hd').length, 0);
    checks.push('prepare_never_original_confirmed_open_pins_original_after_hd_ready');

    reset(); descriptions.set('unknown-scheduler', { ...ready, status: 'queued', errorKind: 'scheduling_unconfirmed' });
    const unknown = mount('unknown-scheduler'); await flush();
    assert.equal(unknown.getSnapshot().displayKind, 'original');
    assert.equal(unknown.getSnapshot().descriptorPending, false);
    assert.equal(unknown.getSnapshot().result.decoded, true);
    assert.equal(Math.min(...Array.from(timers.values(), timer => timer.at - now)), 60_000);
    descriptions.set('unknown-scheduler', { ...ready, status: 'running' }); await advance();
    assert.equal(unknown.getSnapshot().descriptorPending, true, 'confirmed scheduling resumes normal waiting');
    checks.push('unknown_scheduling_keeps_original_and_quiet_recovery');

    reset(); descriptions.set('failed-image', { ...ready, status: 'running' }); bodies.set('failed-image:original', 503);
    const failed = mount('failed-image'); await flush(); await advance(); await advance();
    assert.equal(failed.getSnapshot().displayKind, 'original'); assert.equal(failed.getSnapshot().result.imageSrc, null);
    assert.equal(requests.filter(request => request.variant === 'original').length, 3, 'two bounded retries after the first failed GET');
    assert.equal(failed.getSnapshot().denied, undefined); checks.push('original_read_failure_preserves_object_and_bounds_retries');

    reset(); descriptions.set('descriptor-denied', { ...ready, status: 'queued' });
    const revoked = mount('descriptor-denied'); await flush(); revoked.markDisplayed(); descriptions.set('descriptor-denied', 403); await advance();
    assert.equal(revoked.getSnapshot().denied, true); assert.equal(revoked.getSnapshot().result.imageSrc, null);
    checks.push('descriptor_denial_removes_displayed_original');

    reset(); const original = mount('chosen-original', { original: true }); await flush();
    assert.equal(original.getSnapshot().displayKind, 'original'); assert.equal(original.getSnapshot().result.decoded, true);
    assert.equal(requests.some(request => request.variant === 'hd'), false); checks.push('explicit_original_never_auto_switches');

    reset(); bodies.set('conflict:hd', 409); const conflict = await mountHd('conflict'); await flush();
    assert.equal(requests.filter(request => request.variant === 'hd').length, 1);
    assert.equal(requests.filter(request => request.variant === 'hd-description' && request.readonly).length, 2, 'hint plus one fresh representation check');
    assert.equal(conflict.getSnapshot().displayKind, 'original'); assert.equal(conflict.getSnapshot().result.decoded, true);
    await advance(); assert.equal(requests.filter(request => request.variant === 'hd').length, 1);
    checks.push('409_one_fresh_confirmation_then_original_no_hd_loop');

    reset(); heldDescriptor = 'late-account'; const late = mount('late-account'); await flush();
    assert.ok(descriptorWait.resolve); reads.setImageReadSessionOwner('different-account');
    descriptorWait.resolve(Response.json(ready)); heldDescriptor = ''; await flush();
    assert.equal(late.getSnapshot().denied, true); assert.equal(late.getSnapshot().result.imageSrc, null);
    assert.equal(requests.filter(request => request.variant === 'hd').length, 0); checks.push('late_account_response_cannot_paint');

    reset(); const cached = await mountHd('download'); await flush(); cached.markDisplayed();
    const borrowed = reads.borrowImageRead(account, hdSource('download'), 'source-v1', proof); assert.ok(borrowed); borrowed.release();
    for (const changed of [{ bytes: 8 }, { mime: 'image/png' }, { sourceVersion: 'source-v2' }]) {
      assert.equal(reads.borrowImageRead(account, hdSource('download'), 'source-v1', { ...proof, ...changed }), null);
    }
    assert.equal(reads.borrowImageRead('another-account', hdSource('download'), 'source-v1', proof), null);
    assert.equal(reads.borrowImageRead(account, '/api/image-studio/assets/download?thumbnail=1', 'source-v1', proof), null);
    const reused = await downloads.handHdImageDownloadToBrowser({ account, source: '/api/image-studio/assets/download', sourceVersion: 'source-v1', fileName: 'image.png', isCurrent: () => true });
    assert.equal(reused.reused, true); assert.match(clicked.at(-1)!, /^blob:engineering-/);
    assert.equal(requests.filter(request => request.method === 'HEAD').length, 1); assert.equal(requests.filter(request => request.variant === 'hd' && request.method === 'GET').length, 1);
    heads.set('download', { bytes: 8 });
    const miss = await downloads.handHdImageDownloadToBrowser({ account, source: '/api/image-studio/assets/download', sourceVersion: 'source-v1', fileName: 'image.png', isCurrent: () => true });
    assert.equal(miss.reused, false); assert.match(clicked.at(-1)!, /hd-download=1/);
    heads.set('download', { version: 'source-v2' }); const beforeMismatch = clicked.length;
    await assert.rejects(downloads.handHdImageDownloadToBrowser({ account, source: '/api/image-studio/assets/download', sourceVersion: 'source-v1', fileName: 'image.png', isCurrent: () => true }));
    assert.equal(clicked.length, beforeMismatch); checks.push('fresh_head_exact_hd_borrow_and_native_miss');

    for (const status of [401, 403, 404]) {
      reset(); const handle = await mountHd(`denied-${status}`); await flush(); handle.markDisplayed();
      heads.set(`denied-${status}`, { status });
      await assert.rejects(downloads.handHdImageDownloadToBrowser({ account, source: `/api/image-studio/assets/denied-${status}`, sourceVersion: 'source-v1', fileName: 'image.png', isCurrent: () => true }));
      assert.equal(handle.getSnapshot().denied, true); assert.equal(handle.getSnapshot().result.imageSrc, null);
      assert.equal(reads.borrowImageRead(account, hdSource(`denied-${status}`), 'source-v1', proof), null); assert.equal(clicked.length, 0);
    }
    checks.push('fresh_head_401_403_404_clears_family');

    reset(); const originalDenied = await mountHd('original-denied'); await flush(); originalDenied.markDisplayed(); heads.set('original-denied', { status: 403 });
    await assert.rejects(downloads.handImageDownloadToBrowser('/api/image-studio/assets/original-denied?download=1', 'image.png'));
    assert.equal(originalDenied.getSnapshot().denied, true); assert.equal(clicked.length, 0);
    checks.push('original_download_denial_clears_hd_family');

    reset(); bodies.set('partial:hd', 206); const partial = await mountHd('partial'); await flush();
    assert.equal(partial.getSnapshot().result.decoded, undefined);
    assert.equal(reads.borrowImageRead(account, hdSource('partial'), 'source-v1', proof), null); checks.push('partial_body_cannot_be_download_blob');

    reset(); const prior = await mountHd('downgrade'); await flush(); prior.markDisplayed();
    const previewOnly = mount('downgrade', { previewOnly: true }); await flush();
    assert.equal(prior.getSnapshot().denied, true); assert.equal(previewOnly.getSnapshot().displayKind, 'preview');
    assert.equal(previewOnly.getSnapshot().fullSize, false); assert.equal(reads.borrowImageRead(account, hdSource('downgrade'), 'source-v1', proof), null);
    checks.push('preview_only_evicts_previous_full_image');

    reset(); const previewResults: import('../src/lib/media/image-read-session').ImageReadResult[] = [];
    releases.push(reads.acquireImageRead(account, '/api/image-studio/assets/existing-preview?preview=1', '', 0, value => { previewResults.push(value); })); await flush();
    assert.equal(previewResults.at(-1)?.decoded, true); descriptions.set('existing-preview', { ...ready, status: 'queued' });
    const existing = mount('existing-preview', { intent: 'prepare' }); await flush();
    assert.match(existing.getSnapshot().readSource, /preview=1/); assert.equal(requests.filter(request => request.variant === 'preview').length, 1); noOriginal();
    checks.push('existing_1600_preview_reuses_same_session');

    for (const source of ['/api/image-studio/assets/variant?hd=1&hd-version=old', '/api/reference-images/variant/content?variant=hd&hd-version=old', '/api/content-reactions/media?variant=hd&hd-version=old']) {
      const value = new URL(sources.imageDisplaySource(source, 'thumbnail'), origin);
      assert.equal(value.searchParams.has('hd-version'), false); assert.equal(value.searchParams.has('hd'), false);
    }
    checks.push('representation_switch_removes_old_hd_version');
    return checks;
  } finally {
    for (const release of releases.splice(0)) release(); reads.setImageReadSessionOwner(''); timers.clear();
  }
}
