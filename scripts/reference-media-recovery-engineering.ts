import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

type Props = Record<string, unknown>;
type TestInstance = {
  type: unknown;
  props: Props;
  findAll(predicate: (node: TestInstance) => boolean): TestInstance[];
};
type Renderer = { root: TestInstance; toJSON(): unknown; update(element: unknown): void; unmount(): void };
type TestRenderer = { create(element: unknown): Renderer; act(callback: () => void | Promise<void>): void | Promise<void> };

const nativeRequire = createRequire(import.meta.url);
const React = nativeRequire('react') as typeof import('react');
const rendererApi = nativeRequire('react-test-renderer') as TestRenderer;
const root = process.cwd();

function loadModule(file: string, mocks: Record<string, unknown>, append = '', suppliedConsole: Console = console) {
  const source = `${readFileSync(resolve(root, file), 'utf8')}\n${append}`;
  const code = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
    fileName: file,
  }).outputText;
  const exports: Props = {};
  const module = { exports };
  const localRequire = (name: string) => {
    if (Object.prototype.hasOwnProperty.call(mocks, name)) return mocks[name];
    if (name.startsWith('node:')) return nativeRequire(name);
    throw new Error(`Unexpected dependency while loading ${file}: ${name}`);
  };
  runInNewContext(code, {
    module,
    exports,
    require: localRequire,
    console: suppliedConsole,
    process,
    Buffer,
    URL,
    URLSearchParams,
    Request,
    Response,
    Headers,
    Uint8Array,
    AbortController,
    // Module mocks and callers share the native error realm in the running app.
    Error,
    DOMException,
    setTimeout,
    clearTimeout,
  });
  return module.exports as Props;
}

function renderedText(value: unknown): string {
  if (Array.isArray(value)) return value.map(renderedText).join('');
  if (!value || typeof value !== 'object') return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  if ('children' in value) return renderedText((value as { children?: unknown }).children);
  return '';
}

function componentMocks() {
  const icon = (props: Props) => React.createElement('svg', props);
  const components = new Proxy({}, { get: () => () => null });
  return {
    react: React,
    'react/jsx-runtime': nativeRequire('react/jsx-runtime'),
    'react-dom': { createPortal: (value: unknown) => value },
    'lucide-react': new Proxy({}, { get: () => icon }),
    './ResourceLibraryPicker.module.css': { __esModule: true, default: new Proxy({}, { get: (_target, key) => String(key) }) },
    '@/components/ZoomableImagePreview': { ZoomableImagePreview: () => null },
    '@/components/ResourceLibraryAlbumFilter': components,
    '@/components/useResultPages': components,
    '@/components/experience/ExperienceParts': components,
    '@/components/content-reactions/ContentReactions': components,
    '@/components/MediaPreview': components,
    '@/components/UploadProgressIndicator': components,
    '@/components/RelativeTime': components,
    '@/components/useDialogDismiss': components,
    '@/lib/context/AppSessionContext': components,
    '@/components/useProductDialog': components,
    '@/lib/http/json-response': components,
    '@/lib/http/file-upload': components,
    '@/components/UploadedImagePicker': components,
    '@/lib/assets/picker-types': components,
    '@/lib/assets/library-removal': components,
    '@/lib/avatar-random/handoff': components,
    '@/lib/navigation': components,
    '@/lib/media/image-comparison': components,
    '@/lib/auth/client-session-boundary': components,
    '@/types': components,
    '@/lib/content-reactions/types': components,
  };
}

function buttons(renderer: Renderer) {
  return renderer.root.findAll(node => node.type === 'button');
}

async function checkComponents() {
  const mocks = componentMocks();
  const reference = loadModule('src/components/ReferenceThumb.tsx', mocks).ReferenceThumb as (props: Props) => unknown;
  const asset = {
    assetId: 'asset-1',
    referenceImageId: 'ref-1',
    type: 'image',
    fileName: 'fixture.png',
    originalUrl: '/uploads/assets/fixture.png',
    thumbnailUrl: '/uploads/thumbs/fixture.png',
  };
  const props = { asset, index: 0, uploadStatus: 'uploaded', onRemove() {}, onReplace() {}, onPreview() {} };
  let referenceRenderer!: Renderer;
  await rendererApi.act(() => { referenceRenderer = rendererApi.create(React.createElement(reference as never, props)); });
  assert.match(renderedText(referenceRenderer.toJSON()), /读取中/, 'protected reference thumbnail must expose its initial read state');
  let image = referenceRenderer.root.findAll(node => node.type === 'img')[0];
  assert.ok(image, 'reference thumbnail must render its protected image request');
  await rendererApi.act(() => { (image.props.onError as () => void)(); });
  assert.match(renderedText(referenceRenderer.toJSON()), /预览暂不可用，重试/, 'failed reference thumbnail must keep a local retry action');
  const retry = buttons(referenceRenderer).find(button => String(button.props['aria-label'] || '').includes('重试'));
  assert.ok(retry, 'the existing outer image button must become the retry target');
  assert.equal(retry.findAll(node => node !== retry && node.type === 'button').length, 0, 'reference retry must not nest another button');
  await rendererApi.act(() => { (retry.props.onClick as () => void)(); });
  assert.match(renderedText(referenceRenderer.toJSON()), /读取中/, 'one retry returns only this object to reading');
  image = referenceRenderer.root.findAll(node => node.type === 'img')[0];
  assert.match(String(image.props.src), /[?&]read-retry=1$/, 'manual retry must create one cache-distinct read for this object');
  await rendererApi.act(() => { (image.props.onLoad as () => void)(); });
  assert.doesNotMatch(renderedText(referenceRenderer.toJSON()), /读取中|预览暂不可用/, 'successful reread must clear its local loading and failure state');
  referenceRenderer.unmount();

  const picker = loadModule(
    'src/components/ResourceLibraryPicker.tsx',
    mocks,
    'export { Thumbnail as __PickerThumbnail, PickerThumbnailSelection as __PickerThumbnailSelection, retryFailedThumbnailStates as __retryFailedThumbnailStates };',
  );
  const PickerSelection = picker.__PickerThumbnailSelection as (props: Props) => unknown;
  const retryFailed = picker.__retryFailedThumbnailStates as (current: Props, items: Props[]) => Props;
  const pickerItem = {
    identity: 'asset:picker-1',
    key: 'asset:picker-1',
    id: 'picker-1',
    assetId: 'picker-1',
    type: 'image',
    fileName: 'picker.png',
    thumbnailUrl: '/api/content-reactions/media?key=asset%3Apicker-1&variant=thumbnail',
    originalUrl: '/uploads/assets/picker.png',
  };
  let selectionChanges = 0;
  function PickerHarness() {
    const [state, setState] = React.useState({ source: pickerItem.thumbnailUrl, status: 'loading', attempt: 0 });
    return React.createElement(PickerSelection as never, {
      item: pickerItem,
      busy: false,
      inUse: false,
      order: 0,
      state,
      onStateChange: (status: string) => setState(current => ({ ...current, status })),
      onToggle: () => { selectionChanges++; },
      onRetry: () => setState(current => ({ ...current, status: 'loading', attempt: current.attempt + 1 })),
    });
  }
  let pickerRenderer!: Renderer;
  await rendererApi.act(() => { pickerRenderer = rendererApi.create(React.createElement(PickerHarness)); });
  assert.match(renderedText(pickerRenderer.toJSON()), /读取中/);
  const pickerImage = pickerRenderer.root.findAll(node => node.type === 'img')[0];
  await rendererApi.act(() => { (pickerImage.props.onError as () => void)(); });
  assert.match(renderedText(pickerRenderer.toJSON()), /预览暂不可用，重试/);
  const selectionButtons = buttons(pickerRenderer);
  const selectButton = selectionButtons.find(button => String(button.props['aria-label']).startsWith('取消选择'));
  const retryButton = selectionButtons.find(button => String(button.props['aria-label']).startsWith('重试'));
  assert.ok(selectButton && retryButton, 'picker retry must be a sibling of the existing selection control');
  assert.equal(selectButton.findAll(node => node !== selectButton && node.type === 'button').length, 0, 'picker selection button must not contain the retry button');
  await rendererApi.act(() => { (retryButton.props.onClick as (event: { stopPropagation(): void }) => void)({ stopPropagation() {} }); });
  assert.equal(selectionChanges, 0, 'retry must not change the selected item');
  assert.equal(selectButton.props['aria-pressed'], true, 'retry must preserve selection order/state');
  assert.match(renderedText(pickerRenderer.toJSON()), /读取中/, 'picker retry returns only the failed thumbnail to reading');
  const retriedPickerImage = pickerRenderer.root.findAll(node => node.type === 'img')[0];
  assert.match(String(retriedPickerImage.props.src), /[?&]read-retry=1$/);
  await rendererApi.act(() => { (retriedPickerImage.props.onLoad as () => void)(); });
  assert.doesNotMatch(renderedText(pickerRenderer.toJSON()), /读取中|预览暂不可用/, 'picker ready state must be quiet');
  pickerRenderer.unmount();

  const ready = { source: '/ready', status: 'ready', attempt: 0 };
  const failed = { source: '/failed', status: 'failed', attempt: 2 };
  const refreshed = retryFailed({ ready, failed }, [
    { ...pickerItem, identity: 'ready', thumbnailUrl: '/ready' },
    { ...pickerItem, identity: 'failed', thumbnailUrl: '/failed' },
  ]);
  assert.equal(refreshed.ready, ready, 'successful list refresh must leave ready thumbnail state unchanged');
  assert.equal((refreshed.failed as Props).source, '/failed');
  assert.equal((refreshed.failed as Props).status, 'loading');
  assert.equal((refreshed.failed as Props).attempt, 3, 'successful list refresh retries only failed thumbnails');
}

class FakeNextResponse extends Response {
  static json(body: unknown, init?: ResponseInit) {
    const headers = new Headers(init?.headers);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    return new FakeNextResponse(JSON.stringify(body), { ...init, headers });
  }

  static redirect(input: string | URL, init?: number | ResponseInit) {
    const status = typeof init === 'number' ? init : init?.status || 307;
    const headers = new Headers(typeof init === 'number' ? undefined : init?.headers);
    headers.set('Location', String(input));
    return new FakeNextResponse(null, { status, headers });
  }
}

class FixtureStudioImageDownloadError extends Error {
  name = 'StudioImageDownloadError';
  constructor(public code: string, public status?: number, public retryable = false, public diagnostics?: Props) { super(code); }
}

function uuid(value: string | null) {
  assert.match(value || '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  return value!;
}

function authorizedModule(imageStudio: Props, diagnosticConsole: Console = console) {
  return loadModule('src/lib/media/authorized-image-response.ts', {
    '@/lib/image-studio/media': { ...imageStudio, StudioImageDownloadError: FixtureStudioImageDownloadError },
    './preview-response': { mediaPreviewResponse: async () => new Response('original'), previewMime: () => 'image/png' },
    './hd-derivatives': { hdControl: async () => ({ state: 'active' }), hdDirectory: () => '', hdRepresentationVersion: async () => undefined,
      lookupHd: async () => undefined, requestHd: async () => undefined },
    './hd-encoder': { hdEncoderStrategy: () => undefined },
    './image-validators': { imageEtagMatches: () => false, imageStatEtag: () => '"fixture"', isImagePrefetch: (request: Request) => request.headers.get('x-image-read-intent') === 'prefetch' },
    '@/lib/assets/site-url': { siteUploadPathFromUrl: () => null },
    './image-comparison-version': { comparisonOriginalVersion: async () => null },
    './image-comparison-contract': { COMPARISON_VERSION_HEADER: 'X-Comparison-Version', COMPARISON_VERSION_PARAM: 'comparison-version', validComparisonVersion: () => true },
  }, '', diagnosticConsole);
}

async function checkAuthorizedReaderAndDiagnostics(tempFile: string) {
  let reads = 0;
  let stats = 0;
  let available = true;
  const media = {
    readStudioThumbnail: async () => { reads++; return Buffer.from('display'); },
    readStudioPreview: async () => Buffer.from('display'),
    readStudioDetail: async () => Buffer.from('display'),
    statStudioDisplayImage: async () => {
      stats++;
      return available ? { file: tempFile, size: 7, etag: '"display-v1"' } : null;
    },
  };
  const authorized = authorizedModule(media);
  const readId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const get = await (authorized.authorizedImageResponse as (...args: unknown[]) => Promise<Response>)(
    new Request('https://app.test/media?variant=thumbnail'), 'https://cdn.test/image.png', 'thumbnail', 'image/png', 'image.png', performance.now(), undefined, undefined, readId,
  );
  assert.equal(get.status, 200);
  assert.equal(await get.text(), 'display');
  assert.equal(get.headers.get('X-Media-Request-Id'), readId, 'the caller read-id must survive the actual authorized reader');
  assert.equal(reads, 1);
  assert.equal(stats, 1);

  reads = 0;
  stats = 0;
  available = false;
  const head = await (authorized.authorizedImageResponse as (...args: unknown[]) => Promise<Response>)(
    new Request('https://app.test/media?variant=thumbnail', { method: 'HEAD' }), 'https://cdn.test/image.png', 'thumbnail', 'image/png', 'image.png', performance.now(), undefined, undefined, readId,
  );
  assert.equal(head.status, 409, 'read-only cache miss must remain not prepared');
  assert.equal(reads, 0, 'HEAD cache miss must not start display generation');
  assert.equal(stats, 1);

  const events: Array<{ level: string; fields: unknown[] }> = [];
  const safeConsole = {
    ...console,
    info: (...fields: unknown[]) => { events.push({ level: 'info', fields }); },
    warn: (...fields: unknown[]) => { events.push({ level: 'warn', fields }); },
  } as Console;
  const diagnostic = authorizedModule(media, safeConsole).recordImageReadDiagnostic as (input: Props) => void;
  const failure = new FixtureStudioImageDownloadError('download_headers_timeout', undefined, true, {
    phase: 'headers',
    host: 'secret-cdn.example/private/original.png?token=do-not-log',
    attempt: 2,
    receivedBytes: 0,
    elapsedMs: 123,
  });
  diagnostic({ readId, variant: 'thumbnail', started: performance.now() - 12, stage: 'read', error: failure });
  assert.equal(events.length, 1);
  assert.equal(events[0].level, 'warn');
  const event = events[0].fields[1] as Props;
  assert.deepEqual(Object.keys(event).sort(), ['code', 'elapsedMs', 'readId', 'stage', 'variant']);
  assert.equal(event.readId, readId);
  assert.equal(event.stage, 'headers');
  assert.equal(event.code, 'download_headers_timeout');
  assert.doesNotMatch(JSON.stringify(events), /secret-cdn|original\.png|token|prompt|cookie/i, 'diagnostics must not include source URLs or secrets');

  const abort = new Error('sensitive abort text');
  abort.name = 'AbortError';
  diagnostic({ readId, variant: 'preview', started: performance.now(), stage: 'read', error: abort });
  assert.equal((events.at(-1)!.fields[1] as Props).stage, 'cancelled');

  const nativeAbort = new DOMException('sensitive DOM abort text', 'AbortError');
  assert.ok(nativeAbort instanceof Error, 'the actual Node DOMException must inherit Error');
  diagnostic({ readId, variant: 'preview', started: performance.now(), stage: 'read', error: nativeAbort });
  assert.equal((events.at(-1)!.fields[1] as Props).stage, 'cancelled');

  diagnostic({ readId, variant: 'preview', started: performance.now(), stage: 'read', error: { name: 'AbortError' } });
  assert.equal((events.at(-1)!.fields[1] as Props).stage, 'read', 'a name-only object is not a native cancellation error');

  diagnostic({ readId, variant: 'detail', started: performance.now(), stage: 'read',
    error: new FixtureStudioImageDownloadError('display_encoding_failed', undefined, false, { phase: 'encoding' }) });
  assert.equal((events.at(-1)!.fields[1] as Props).stage, 'encoding');
  assert.equal((events.at(-1)!.fields[1] as Props).code, 'display_encoding_failed');
  assert.doesNotMatch(JSON.stringify(events), /sensitive|secret-cdn|original\.png|token|prompt|cookie/i);
}

async function checkActualDisplayEncodingFailure() {
  const fixtureRoot = await mkdtemp(resolve(tmpdir(), 'reference-media-encoding-'));
  const previousDirectory = process.cwd();
  try {
    const uploadRoot = resolve(fixtureRoot, 'public/uploads');
    await mkdir(uploadRoot, { recursive: true });
    const file = resolve(uploadRoot, 'invalid.png');
    await writeFile(file, Buffer.from('not-an-image'));
    const media = await import('../src/lib/image-studio/media');
    process.chdir(fixtureRoot);
    await assert.rejects(
      media.readStudioThumbnail('/uploads/invalid.png'),
      error => {
        assert.ok(error instanceof media.StudioImageDownloadError);
        assert.equal(error.code, 'display_encoding_failed');
        assert.equal(error.diagnostics?.phase, 'encoding');
        assert.doesNotMatch(JSON.stringify(error.diagnostics), /invalid\.png|uploads|reference-media-recovery/);
        return true;
      },
      'the actual reader must classify a real image encoding failure without source details',
    );
  } finally {
    process.chdir(previousDirectory);
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function checkContentReactionRoute(tempFile: string) {
  class ReactionError extends Error { constructor(message: string, public status = 400) { super(message); } }
  let resolved: Props = {};
  let cached: Props | null = null;
  let thumbnailReads = 0;
  let thumbnailStats = 0;
  let readFailure: unknown;
  const diagnostics: Props[] = [];
  const route = loadModule('src/app/api/content-reactions/media/route.ts', {
    'next/server': { NextResponse: FakeNextResponse },
    '@/lib/content-reactions/http': {
      reactionUser: async () => ({ id: 'user-1' }),
      reactionError: (error: unknown) => FakeNextResponse.json({ error: error instanceof Error ? error.message : 'failed' }, { status: error instanceof ReactionError ? error.status : 502 }),
    },
    '@/lib/content-reactions/content': { parseContentKey: (value: unknown) => value, ReactionError, resolveContent: async () => resolved },
    '@/lib/image-studio/media': {
      readStudioThumbnail: async () => { thumbnailReads++; if (readFailure) throw readFailure; return Buffer.from('display'); },
      statStudioDisplayImage: async () => { thumbnailStats++; return cached; },
    },
    '@/lib/media/authorized-image-response': {
      authorizedImageResponse: async () => new Response('image'),
      discardHdViewingInterest: async () => undefined,
      recordImageReadDiagnostic: (input: Props) => { diagnostics.push(input); },
    },
    '@/lib/media/public-url': { isPrivateNetworkHost: () => false },
    '@/lib/media/image-validators': { isImagePrefetch: (request: Request) => request.headers.get('x-image-read-intent') === 'prefetch' },
  });
  const get = route.GET as (request: Request) => Promise<Response>;
  resolved = {
    summary: { category: 'video', previewUrl: '/preview', title: 'video' },
    source: { url: 'https://cdn.test/video.mp4', thumbnail: 'https://cdn.test/thumb.jpg' },
  };

  const headMiss = await get(new Request('https://app.test/api/content-reactions/media?key=asset%3A1&variant=thumbnail', { method: 'HEAD' }));
  assert.equal(headMiss.status, 409);
  assert.equal(thumbnailStats, 1);
  assert.equal(thumbnailReads, 0, 'non-image thumbnail HEAD miss must not start a job');
  const missId = uuid(headMiss.headers.get('X-Media-Request-Id'));
  assert.equal(diagnostics.at(-1)?.readId, missId);

  thumbnailStats = 0;
  const prefetchMiss = await get(new Request('https://app.test/api/content-reactions/media?key=asset%3A1&variant=thumbnail', { headers: { 'x-image-read-intent': 'prefetch' } }));
  assert.equal(prefetchMiss.status, 409);
  assert.equal(thumbnailStats, 1);
  assert.equal(thumbnailReads, 0, 'prefetch miss must not start a job');

  cached = { file: tempFile, size: 7, etag: '"display-v1"' };
  const headHit = await get(new Request('https://app.test/api/content-reactions/media?key=asset%3A1&variant=thumbnail', { method: 'HEAD' }));
  assert.equal(headHit.status, 200);
  assert.equal(headHit.body, null, 'cached HEAD must not return a body');
  assert.equal(thumbnailReads, 0);

  cached = null;
  const normal = await get(new Request('https://app.test/api/content-reactions/media?key=asset%3A1&variant=thumbnail'));
  assert.equal(normal.status, 200);
  assert.equal(await normal.text(), 'display');
  assert.equal(thumbnailReads, 1, 'foreground GET must preserve the actual video thumbnail read');
  const normalId = uuid(normal.headers.get('X-Media-Request-Id'));
  assert.equal(diagnostics.at(-1)?.readId, normalId);

  readFailure = new FixtureStudioImageDownloadError('download_connect_timeout', undefined, true, { phase: 'connect' });
  const failed = await get(new Request('https://app.test/api/content-reactions/media?key=asset%3A1&variant=thumbnail'));
  assert.equal(failed.status, 502);
  const failedId = uuid(failed.headers.get('X-Media-Request-Id'));
  const failureDiagnostic = diagnostics.at(-1)!;
  assert.equal(failureDiagnostic.readId, failedId, 'failure response and diagnostic must share one start-time read-id');
  assert.equal(failureDiagnostic.stage, 'read');
  assert.equal(failureDiagnostic.error, readFailure);
}

function nextRequest(url: string, init?: RequestInit) {
  const request = new Request(url, init) as Request & { nextUrl: URL };
  Object.defineProperty(request, 'nextUrl', { value: new URL(request.url) });
  return request;
}

async function checkReferenceImageRoute() {
  let image: Props = {};
  let authorizedFailure: unknown;
  let authorizedInput: unknown[] = [];
  const diagnostics: Props[] = [];
  const trusted = { source: 'https://cdn.test/original.png', hash: 'a'.repeat(64), size: 123 };
  const route = loadModule('src/app/api/reference-images/[id]/content/route.ts', {
    'next/server': { NextRequest: Request, NextResponse: FakeNextResponse },
    '@/lib/auth/session': { getSession: async () => ({ id: 'user-1' }), AuthError: class AuthError extends Error { constructor(message: string, public status = 400) { super(message); } } },
    '@/lib/reference-albums/permissions': {
      assertCanViewReferenceImage: async () => image,
      canDownloadOriginal: async () => true,
      canUseAlbumImage: async () => true,
    },
    '@/lib/media/preview-response': { mediaPreviewResponse: async () => new Response('media') },
    '@/lib/media/authorized-image-response': {
      authorizedImageResponse: async (...input: unknown[]) => { authorizedInput = input; if (authorizedFailure) throw authorizedFailure; return new Response('image'); },
      discardHdViewingInterest: async () => undefined,
      recordImageReadDiagnostic: (input: Props) => { diagnostics.push(input); },
    },
    '@/lib/image-studio/media': { trustedStudioImageVersion: () => trusted },
  });
  const get = route.GET as (request: Request, context: { params: { id: string } }) => Promise<Response>;
  image = {
    id: 'reference-1',
    url: trusted.source,
    thumbnail_url: 'https://cdn.test/independent-thumb.png',
    owner_user_id: 'user-1',
    asset: {
      id: 'asset-1',
      type: 'image',
      status: 'active',
      original_url: trusted.source,
      owner_id: 'user-1',
      mime_type: 'image/png',
      file_name: 'original.png',
      hash: trusted.hash,
      file_size: trusted.size,
    },
  };
  const success = await get(nextRequest('https://app.test/api/reference-images/reference-1/content?variant=preview'), { params: { id: 'reference-1' } });
  assert.equal(success.status, 200);
  const successId = uuid(success.headers.get('X-Media-Request-Id'));
  assert.equal(authorizedInput[8], successId, 'reference route must create the read-id before calling the reader');
  assert.equal(authorizedInput[7], trusted, 'trusted version is passed only for the matching original source');
  assert.equal(diagnostics.at(-1)?.readId, successId);

  image = { ...image, url: 'https://cdn.test/independent-display.png' };
  await get(nextRequest('https://app.test/api/reference-images/reference-1/content?variant=preview'), { params: { id: 'reference-1' } });
  assert.equal(authorizedInput[7], undefined, 'an independent display source must not borrow the original asset hash');

  authorizedFailure = new FixtureStudioImageDownloadError('download_body_timeout', undefined, true, { phase: 'body' });
  const failed = await get(nextRequest('https://app.test/api/reference-images/reference-1/content?variant=preview'), { params: { id: 'reference-1' } });
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), { error: '素材暂时无法读取，请重试' });
  const failedId = uuid(failed.headers.get('X-Media-Request-Id'));
  const failureDiagnostic = diagnostics.at(-1)!;
  assert.equal(failureDiagnostic.readId, failedId, 'reference failure response and diagnostic must share one start-time read-id');
  assert.equal(failureDiagnostic.error, authorizedFailure);
  assert.equal(failureDiagnostic.stage, 'read');
}

async function main() {
  const directory = await mkdtemp(resolve(tmpdir(), 'reference-media-recovery-'));
  const displayFile = resolve(directory, 'display.webp');
  try {
    await writeFile(displayFile, Buffer.from('display'));
    await checkComponents();
    await checkActualDisplayEncodingFailure();
    await checkAuthorizedReaderAndDiagnostics(displayFile);
    await checkContentReactionRoute(displayFile);
    await checkReferenceImageRoute();
    console.log('PASS: actual React components, local retry/selection preservation, actual media handlers, read-id diagnostics, and read-only no-job checks.');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
