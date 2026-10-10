import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { acquireImageRead, isImagePreviewReady, prefetchImageRead, revalidateActiveImages, setImageReadSessionOwner, type ImageReadResult } from '../src/lib/media/image-read-session';
import { acquireHdImageSource, hdImageHint, prefetchHdImageSource, type HdSourceState } from '../src/lib/media/hd-source-session';

type FetchCall = { url: string; init: RequestInit };
type FetchHandler = (url: string, init: RequestInit) => Promise<Response>;
type Size = { width: number; height: number };

const calls: FetchCall[] = [];
const objectSizes = new Map<string, Size>();
const activeDecoded = new Set<FixtureImage>();
let fetchHandler: FetchHandler = async () => { throw new Error('fixture fetch handler missing'); };
let nextDecodeSize: Size = { width: 3840, height: 1280 };
let blobSequence = 0, decodeCalls = 0, fakeNow = 1_000_000;
const realDateNow = Date.now;
Date.now = () => fakeNow;

class FixtureImage {
  complete = false;
  naturalWidth = 0;
  naturalHeight = 0;
  private value = '';
  get src() { return this.value; }
  set src(value: string) {
    this.value = value;
    if (!value) { this.complete = false; activeDecoded.delete(this); return; }
    const size = objectSizes.get(value) || nextDecodeSize;
    this.naturalWidth = size.width; this.naturalHeight = size.height; this.complete = true; activeDecoded.add(this);
  }
  async decode() { if (!this.value) throw new Error('fixture image has no source'); decodeCalls++; }
}

Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://sd2.youdooart.com/', origin: 'https://sd2.youdooart.com' } });
Object.defineProperty(globalThis, 'document', { configurable: true, value: { hidden: false, addEventListener() {}, removeEventListener() {} } });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { connection: { saveData: false } } });
Object.defineProperty(globalThis, 'Image', { configurable: true, value: FixtureImage });
Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const call = { url: String(input), init }; calls.push(call); return fetchHandler(call.url, init);
}) as typeof fetch });
Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: (_blob: Blob) => {
  const url = `blob:https://sd2.youdooart.com/p03-fixture-${++blobSequence}`; objectSizes.set(url, nextDecodeSize); return url;
} });
Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: (url: string) => { objectSizes.delete(url); } });

function useFetch(handler: FetchHandler) { fetchHandler = handler; calls.length = 0; }
function imageResponse(version: string, status = 200) {
  if (status !== 200) return new Response(null, { status });
  return new Response(new Uint8Array([1, 2, 3, 4]), { status, headers: {
    'content-type': 'image/png', 'content-length': '4', etag: version, 'x-image-source-version': version,
  } });
}
function notModified(version: string) {
  return new Response(null, { status: 304, headers: { 'content-type': 'image/png', etag: version, 'x-image-source-version': version } });
}
function descriptionResponse(version = '"hd-v1"') {
  return new Response(JSON.stringify({ policy: 'hd-f-v1', status: 'ready', sourceVersion: version, bytes: 4, width: 3840, height: 1280, mime: 'image/png' }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}
function source(id: string, variant = 'preview') { return `/api/image-studio/assets/${id}?${variant.includes('=') ? variant : `${variant}=1`}`; }
function sourceQuery(id: string, query: string) { return `/api/image-studio/assets/${id}?${query}`; }
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const last = <T,>(values: T[]) => values[values.length - 1];
async function waitFor(check: () => boolean, label: string) {
  for (let attempt = 0; attempt < 100; attempt++) { if (check()) return; await pause(); }
  throw new Error(`fixture timed out: ${label}`);
}
async function resetOwner(account: string) { setImageReadSessionOwner(account); await pause(); }
async function readToReady(account: string, imageSource: string, version: string) {
  const events: ImageReadResult[] = [];
  const release = acquireImageRead(account, imageSource, version, 0, value => events.push(value));
  await waitFor(() => events.some(value => value.decoded && value.imageSrc), `decoded image ${imageSource}`);
  return { events, release };
}
function getCount() { return calls.filter(call => (call.init.method || 'GET').toUpperCase() === 'GET').length; }

async function warmFamily(account: string, id: string) {
  await resetOwner(account);
  const descriptor = source(id, 'hd-description');
  useFetch(async url => url.includes('hd-description=1') ? descriptionResponse('"source-v1"') : imageResponse('"source-v1"'));
  const preview = await readToReady(account, source(id, 'preview'), '"source-v1"');
  const high = await readToReady(account, source(id, 'hd=1&hd-version=%22source-v1%22'), '"source-v1"');
  const descriptorStates: HdSourceState[] = [];
  const releaseDescriptor = acquireHdImageSource(account, descriptor, '"source-v1"', value => descriptorStates.push(value));
  await waitFor(() => descriptorStates.some(value => value.description?.status === 'ready'), 'ready HD descriptor');
  const unrelated = await readToReady(account, source(`${id}-unrelated`), '"source-v1"');
  return { descriptor, descriptorStates, releaseDescriptor, preview, high, unrelated };
}

function assertUnrelatedFamilyStillWarm(account: string, id: string) {
  const before = getCount();
  let immediate: ImageReadResult | undefined;
  const release = acquireImageRead(account, source(`${id}-unrelated`), '', 0, value => { immediate = value; });
  assert.equal(immediate?.decoded, true, 'unrelated family remains synchronously cached after denial');
  assert.equal(getCount(), before, 'unrelated family denial does not trigger a body GET');
  release();
}

async function warmReadDoesNotWaitForHead() {
  const account = 'p03-warm:member:user', imageSource = source('warm');
  await resetOwner(account); fakeNow += 1;
  let finishHead: ((response: Response) => void) | undefined, heads = 0;
  useFetch(async (_url, init) => {
    if (init.method === 'HEAD') { heads++; return new Promise<Response>(resolve => { finishHead = resolve; }); }
    return imageResponse('"warm-v1"');
  });
  const first = await readToReady(account, imageSource, '"warm-v1"');
  assert.equal(getCount(), 1, 'a cold read starts with one protected GET');
  assert.equal(heads, 0, 'a cold read does not issue HEAD');
  first.release();

  fakeNow += 60_000;
  let synchronous: ImageReadResult | undefined;
  const release = acquireImageRead(account, imageSource, '"warm-v1"', 0, value => { synchronous = value; });
  assert.equal(synchronous?.decoded, true, 'hot ready result is emitted before acquire returns');
  assert.equal(getCount(), 1, 'warm reuse does not repeat the body GET');
  assert.equal(heads, 1, 'only the due background revalidation starts');
  assert.ok(finishHead, 'the background HEAD is pending independently of display');
  finishHead!(imageResponse('"warm-v1"', 503));
  await pause();
  assert.equal(synchronous?.decoded, true, 'transient HEAD failure retains the warm decoded display');
  let retainedAfterTransient: ImageReadResult | undefined;
  const releaseRetained = acquireImageRead(account, imageSource, '"warm-v1"', 0, value => { retainedAfterTransient = value; });
  assert.equal(retainedAfterTransient?.decoded, true, 'a transient revalidation failure keeps the warm decoded display available');
  releaseRetained();
  fakeNow += 59_999; revalidateActiveImages(60_000); await pause();
  assert.equal(heads, 1, 'transient failure is not retried inside 60 seconds');
  fakeNow += 1;
  useFetch(async (_url, init) => init.method === 'HEAD' ? (heads++, notModified('"warm-v1"')) : imageResponse('"warm-v1"'));
  revalidateActiveImages(60_000); await pause();
  assert.equal(heads, 2, 'a stale active entry may revalidate after the retry interval');
  release();
}

async function denialDiffersFromNetworkFailure() {
  const deniedAccount = 'p03-denied:member:user';
  await resetOwner(deniedAccount);
  useFetch(async () => imageResponse('', 403));
  const denied: ImageReadResult[] = [];
  const releaseDenied = acquireImageRead(deniedAccount, source('denied'), '', 0, value => denied.push(value));
  await waitFor(() => denied.some(value => value.denied), '403 denial');
  assert.notEqual(last(denied)?.unconfirmed, true, '403 is not reported as a network uncertainty');
  releaseDenied();

  const networkAccount = 'p03-network:member:user';
  await resetOwner(networkAccount);
  useFetch(async () => { throw new TypeError('fixture offline'); });
  const network: ImageReadResult[] = [];
  const releaseNetwork = acquireImageRead(networkAccount, source('offline'), '', 0, value => network.push(value));
  await waitFor(() => network.some(value => value.unconfirmed), 'network uncertainty');
  assert.notEqual(last(network)?.denied, true, 'network failure is not treated as access denial');
  releaseNetwork();
}

async function bodyDenialInvalidatesOnlyItsSourceFamily() {
  const account = 'p03-family-body:member:user', id = 'family-body';
  await resetOwner(account);
  useFetch(async url => imageResponse(url.includes('family-other') ? '"other-v1"' : '"family-v1"'));
  const preview = await readToReady(account, source(id, 'preview'), '"family-v1"');
  const detail = await readToReady(account, source(id, 'detail'), '"family-v1"');
  const unrelated = await readToReady(account, source('family-other', 'preview'), '"other-v1"');
  const descriptor = `/api/image-studio/assets/${id}?hd-description=1`;
  useFetch(async () => descriptionResponse('"family-v1"'));
  const warmHd = prefetchHdImageSource(account, descriptor, '"family-v1"');
  await warmHd.result; warmHd.release();
  assert.equal(hdImageHint(account, descriptor, '"family-v1"')?.status, 'ready');

  const pendingSource = source(id, 'download'), deniedSource = source(id, 'thumbnail');
  let finishLateBody: ((response: Response) => void) | undefined;
  useFetch(async url => {
    if (url === pendingSource) return new Promise<Response>(resolve => { finishLateBody = resolve; });
    if (url === deniedSource) return imageResponse('', 403);
    return imageResponse('"other-v1"');
  });
  const lateEvents: ImageReadResult[] = [], deniedEvents: ImageReadResult[] = [];
  const releaseLate = acquireImageRead(account, pendingSource, '', 0, value => lateEvents.push(value));
  await waitFor(() => Boolean(finishLateBody), 'late same-family body GET');
  const releaseDenied = acquireImageRead(account, deniedSource, '', 0, value => deniedEvents.push(value));
  await waitFor(() => deniedEvents.some(value => value.denied), 'same-family body 403');
  assert.equal(last(preview.events)?.denied, true, 'body denial withdraws the warm preview variant');
  assert.equal(last(detail.events)?.denied, true, 'body denial withdraws the warm detail variant');
  assert.equal(lateEvents.some(value => value.denied), true, 'body denial notifies a pending sibling consumer');
  assert.equal(hdImageHint(account, descriptor, '"family-v1"'), undefined, 'body denial withdraws the matching HD descriptor');
  assert.equal(unrelated.events.some(value => value.denied), false, 'body denial does not affect another source family');

  const getsBeforeUnrelatedReuse = getCount();
  let unrelatedReuse: ImageReadResult | undefined;
  const releaseUnrelatedReuse = acquireImageRead(account, source('family-other', 'preview'), '"other-v1"', 0, value => { unrelatedReuse = value; });
  assert.equal(unrelatedReuse?.decoded, true, 'the unrelated warm family remains immediately usable');
  assert.equal(getCount(), getsBeforeUnrelatedReuse, 'the unrelated family requires no new body GET');
  finishLateBody!(imageResponse('"late-family-v1"')); await pause();
  assert.equal(lateEvents.some(value => value.decoded), false, 'an aborted late body response cannot republish after family denial');
  releaseUnrelatedReuse(); releaseDenied(); releaseLate(); preview.release(); detail.release(); unrelated.release();
}

async function readonlyHdDenialInvalidatesFamilyWithoutConsumer() {
  const account = 'p03-family-hd:member:user', id = 'family-hd';
  await resetOwner(account);
  useFetch(async url => imageResponse(url.includes('family-hd-other') ? '"other-v1"' : '"family-v1"'));
  const preview = await readToReady(account, source(id, 'preview'), '"family-v1"');
  const detail = await readToReady(account, source(id, 'detail'), '"family-v1"');
  const unrelated = await readToReady(account, source('family-hd-other', 'preview'), '"other-v1"');
  const descriptor = `/api/image-studio/assets/${id}?hd-description=1`;
  useFetch(async () => descriptionResponse('"family-v1"'));
  const warmHd = prefetchHdImageSource(account, descriptor, '"family-v1"');
  await warmHd.result; warmHd.release();
  assert.equal(hdImageHint(account, descriptor, '"family-v1"')?.status, 'ready');

  const pendingSource = source(id, 'download');
  let finishLateBody: ((response: Response) => void) | undefined;
  useFetch(async url => {
    if (url === pendingSource) return new Promise<Response>(resolve => { finishLateBody = resolve; });
    if (url === descriptor) return imageResponse('', 403);
    return imageResponse('"other-v1"');
  });
  const lateEvents: ImageReadResult[] = [];
  const releaseLate = acquireImageRead(account, pendingSource, '', 0, value => lateEvents.push(value));
  await waitFor(() => Boolean(finishLateBody), 'late body GET during readonly HD denial');
  fakeNow += 60_000;
  const readonlyRetry = prefetchHdImageSource(account, descriptor, '"family-v1"');
  const readonlyResult = await readonlyRetry.result;
  assert.equal(readonlyResult.denied, true, 'a readonly descriptor 403 is an access denial');
  const descriptorCall = calls.find(call => call.url === descriptor);
  assert.equal(new Headers(descriptorCall?.init.headers).get('X-Image-Read-Intent'), 'prefetch', 'the denial came from the readonly request');
  assert.equal(last(preview.events)?.denied, true, 'readonly HD denial withdraws the warm preview variant');
  assert.equal(last(detail.events)?.denied, true, 'readonly HD denial withdraws the warm detail variant');
  assert.equal(lateEvents.some(value => value.denied), true, 'readonly HD denial notifies sibling body consumers without a foreground HD hook');
  assert.equal(hdImageHint(account, descriptor, '"family-v1"'), undefined, 'readonly HD denial removes the descriptor');
  assert.equal(unrelated.events.some(value => value.denied), false, 'readonly HD denial leaves another source family intact');

  const getsBeforeUnrelatedReuse = getCount();
  let unrelatedReuse: ImageReadResult | undefined;
  const releaseUnrelatedReuse = acquireImageRead(account, source('family-hd-other', 'preview'), '"other-v1"', 0, value => { unrelatedReuse = value; });
  assert.equal(unrelatedReuse?.decoded, true, 'the unrelated warm family remains immediately usable');
  assert.equal(getCount(), getsBeforeUnrelatedReuse, 'the unrelated family requires no new body GET');
  finishLateBody!(imageResponse('"late-family-v1"')); await pause();
  assert.equal(lateEvents.some(value => value.decoded), false, 'a late sibling body response cannot republish after readonly HD denial');
  readonlyRetry.release(); releaseUnrelatedReuse(); releaseLate(); preview.release(); detail.release(); unrelated.release();
}

async function versionsVariantsAndOwnerEpoch() {
  const account = 'p03-version:member:user', imageSource = source('versioned');
  await resetOwner(account);
  let reads = 0;
  useFetch(async () => imageResponse(reads++ === 0 ? '"v1"' : '"v2"'));
  const first = await readToReady(account, imageSource, '"v1"'); first.release();
  const second = await readToReady(account, imageSource, '"v2"');
  assert.equal(getCount(), 2, 'a known version mismatch invalidates the old body and makes one protected GET');
  second.release();
  let blankVersion: ImageReadResult | undefined;
  const releaseBlank = acquireImageRead(account, imageSource, '', 0, value => { blankVersion = value; });
  assert.equal(blankVersion?.decoded, true, 'an empty caller version reuses only the cached actual version');
  assert.equal(getCount(), 2);
  releaseBlank();

  const hdVariant = sourceQuery('versioned', 'hd=1&hd-version=%22v2%22');
  const hd = await readToReady(account, hdVariant, '"v2"');
  assert.equal(getCount(), 3, 'HD and preview variants keep distinct cache entries');
  hd.release();

  const oldSource = source('late-owner'), oldEvents: ImageReadResult[] = [];
  let finishGet: ((response: Response) => void) | undefined;
  useFetch(async () => new Promise<Response>(resolve => { finishGet = resolve; }));
  const oldRelease = acquireImageRead(account, oldSource, '"late"', 0, value => oldEvents.push(value));
  await waitFor(() => Boolean(finishGet), 'pending old-owner GET');
  const nextAccount = 'p03-version:admin:internal';
  setImageReadSessionOwner(nextAccount);
  finishGet!(imageResponse('"late"')); await pause();
  assert.equal(oldEvents.some(value => value.decoded), false, 'late response after account/role epoch change cannot republish');
  oldRelease();
  useFetch(async () => imageResponse('"late"'));
  const current = await readToReady(nextAccount, oldSource, '"late"');
  assert.equal(getCount(), 1, 'the new owner performs its own protected read');
  current.release();
}

async function readonlyHdDoesNotPromote() {
  const account = 'p03-hd-readonly:member:user', descriptor = '/api/image-studio/assets/readonly?hd-description=1';
  await resetOwner(account);
  let finishDescription: ((response: Response) => void) | undefined;
  useFetch(async (_url, init) => new Promise<Response>(resolve => { finishDescription = resolve; }));
  const prefetched = prefetchHdImageSource(account, descriptor, '"source-v1"');
  const states: Array<{ denied?: boolean; error?: boolean }> = [];
  const releaseListener = acquireHdImageSource(account, descriptor, '"source-v1"', state => states.push(state));
  assert.equal(calls.length, 1, 'foreground subscriber joins the in-flight readonly request');
  assert.equal(new Headers(calls[0].init.headers).get('X-Image-Read-Intent'), 'prefetch');
  finishDescription!(new Response(null, { status: 409 }));
  const result = await prefetched.result; await pause();
  assert.equal(result.denied, undefined, 'readonly 409 means not prepared, not denied');
  assert.equal(calls.length, 1, 'readonly 409 does not start a normal preparation GET');
  assert.equal(states.some(state => state.denied), false);
  prefetched.release(); releaseListener();
}

async function freshHdReadyAndStaleRetention() {
  const account = 'p03-hd-cache:member:user', descriptor = '/api/image-studio/assets/ready?hd-description=1';
  await resetOwner(account);
  useFetch(async () => descriptionResponse());
  const states: Array<{ description?: { status: string }; denied?: boolean; error?: boolean }> = [];
  const release = acquireHdImageSource(account, descriptor, '"source-v1"', value => states.push(value));
  await waitFor(() => states.some(value => value.description?.status === 'ready'), 'cold HD description');
  assert.equal(calls.length, 1);
  release();
  const freshStates: typeof states = [];
  const releaseFresh = acquireHdImageSource(account, descriptor, '"source-v1"', value => freshStates.push(value));
  assert.equal(freshStates[0]?.description?.status, 'ready', 'fresh ready descriptor is synchronously available');
  assert.equal(calls.length, 1, 'fresh ready descriptor does not issue a redundant request');
  releaseFresh();

  fakeNow += 60_000;
  useFetch(async () => { throw new TypeError('fixture offline'); });
  const staleStates: typeof states = [];
  const releaseStale = acquireHdImageSource(account, descriptor, '"source-v1"', value => staleStates.push(value));
  assert.equal(staleStates[0]?.description?.status, 'ready', 'expired ready descriptor remains available during readonly check');
  await waitFor(() => staleStates.some(value => value.error), 'stale descriptor network error');
  assert.equal(last(staleStates)?.description?.status, 'ready', 'transient failure retains the ready descriptor');
  assert.equal(last(staleStates)?.denied, undefined);
  assert.equal(new Headers(calls[0].init.headers).get('X-Image-Read-Intent'), 'prefetch');
  const retryCount = calls.length;
  const retry = prefetchHdImageSource(account, descriptor, '"source-v1"');
  await retry.result;
  assert.equal(calls.length, retryCount, 'neighbor prefetch honors the stale ready descriptor 60-second retry backoff');
  retry.release();
  releaseStale();
}

async function bodyDenialInvalidatesOnlyItsFamily() {
  const account = 'p03-denial-body:member:user', id = 'body-family';
  const family = await warmFamily(account, id);
  let finishLate: ((response: Response) => void) | undefined, lateSignal: AbortSignal | undefined;
  const lateEvents: ImageReadResult[] = [], detailSource = source(id, 'detail');
  useFetch(async (url, init) => {
    if (url.includes(`${id}?detail=1`)) {
      lateSignal = init.signal as AbortSignal;
      return new Promise<Response>(resolve => { finishLate = resolve; });
    }
    if (url.includes(`${id}?preview=1`)) return imageResponse('', 403);
    return imageResponse('"source-v1"');
  });
  const releasePrefetch = prefetchImageRead(account, detailSource, '"source-v1"');
  await waitFor(() => Boolean(finishLate && lateSignal), 'in-flight sibling body');
  const releaseLate = acquireImageRead(account, detailSource, '"source-v1"', 0, value => lateEvents.push(value));
  const denialEvents: ImageReadResult[] = [];
  const releaseDenial = acquireImageRead(account, source(id, 'preview'), '"new-version"', 0, value => denialEvents.push(value));
  await waitFor(() => denialEvents.some(value => value.denied), 'body 403 family denial');
  assert.equal(last(family.high.events)?.denied, true, 'body denial clears and notifies the warm HD body variant');
  assert.equal(family.descriptorStates.some(value => value.denied), true, 'body denial invalidates the warm HD descriptor');
  assert.equal(hdImageHint(account, family.descriptor, '"source-v1"', true), undefined);
  assert.equal(lateSignal?.aborted, true, 'family denial aborts sibling body work');
  const decodedBeforeLateResponse = lateEvents.filter(value => value.decoded).length;
  finishLate!(imageResponse('"late-v1"'));
  await pause();
  assert.equal(lateEvents.filter(value => value.decoded).length, decodedBeforeLateResponse, 'late sibling GET cannot republish after family invalidation');
  assertUnrelatedFamilyStillWarm(account, id);
  releaseDenial(); releaseLate(); releasePrefetch(); family.releaseDescriptor();
  family.preview.release(); family.high.release(); family.unrelated.release();
}

async function readonlyHdDenialInvalidatesFamily() {
  const account = 'p03-denial-hd:member:user', id = 'readonly-family';
  const family = await warmFamily(account, id);
  family.releaseDescriptor();
  fakeNow += 60_000;
  let finishLate: ((response: Response) => void) | undefined, lateSignal: AbortSignal | undefined;
  const lateEvents: ImageReadResult[] = [], detailSource = source(id, 'detail');
  useFetch(async (url, init) => {
    if (url.includes(`${id}?detail=1`)) {
      lateSignal = init.signal as AbortSignal;
      return new Promise<Response>(resolve => { finishLate = resolve; });
    }
    if (url.includes('hd-description=1')) return imageResponse('', 403);
    return imageResponse('"source-v1"');
  });
  const releasePrefetch = prefetchImageRead(account, detailSource, '"source-v1"');
  await waitFor(() => Boolean(finishLate && lateSignal), 'in-flight sibling body before readonly denial');
  const releaseLate = acquireImageRead(account, detailSource, '"source-v1"', 0, value => lateEvents.push(value));
  const request = prefetchHdImageSource(account, family.descriptor, '"source-v1"');
  const descriptorCall = calls.find(call => call.url.includes('hd-description=1'));
  assert.equal(new Headers(descriptorCall?.init.headers).get('X-Image-Read-Intent'), 'prefetch', 'unmounted HD denial remains readonly');
  const result = await request.result;
  await pause();
  assert.equal(result.denied, true, 'readonly descriptor 403 is known denial');
  assert.equal(last(family.preview.events)?.denied, true, 'readonly HD denial clears the warm preview body');
  assert.equal(last(family.high.events)?.denied, true, 'readonly HD denial clears the warm HD body');
  assert.equal(hdImageHint(account, family.descriptor, '"source-v1"', true), undefined);
  assert.equal(lateSignal?.aborted, true, 'readonly HD denial aborts sibling body work');
  const decodedBeforeLateResponse = lateEvents.filter(value => value.decoded).length;
  finishLate!(imageResponse('"late-v1"'));
  await pause();
  assert.equal(lateEvents.filter(value => value.decoded).length, decodedBeforeLateResponse, 'late sibling GET cannot republish after readonly descriptor denial');
  assertUnrelatedFamilyStillWarm(account, id);
  request.release(); releaseLate(); releasePrefetch();
  family.preview.release(); family.high.release(); family.unrelated.release();
}

async function decodedBudgetAndNeighborCancellation() {
  const account = 'p03-budget:member:user';
  await resetOwner(account);
  let reads = 0;
  useFetch(async () => imageResponse(`"budget-${++reads}"`));
  const firstSource = source('budget-0');
  for (let index = 0; index < 4; index++) {
    nextDecodeSize = { width: 4000, height: 3000 };
    const before = decodeCalls;
    const release = prefetchImageRead(account, source(`budget-${index}`), `"budget-${index + 1}"`);
    await waitFor(() => decodeCalls > before, `neighbor decode ${index}`);
    release(); await pause();
  }
  assert.ok(activeDecoded.size <= 2, '48MiB RGBA fixtures stay under the 96MiB decoded-reference budget');
  const beforeRevisit = decodeCalls, getsBeforeRevisit = getCount();
  const revisited: ImageReadResult[] = [];
  const releaseRevisited = acquireImageRead(account, firstSource, '"budget-1"', 0, value => revisited.push(value));
  await waitFor(() => decodeCalls > beforeRevisit && revisited.some(value => value.decoded), 'local decode after decoded-reference eviction');
  assert.equal(getCount(), getsBeforeRevisit, 'decoded-reference eviction keeps the authorized Blob for local decode');
  releaseRevisited();

  nextDecodeSize = { width: 12000, height: 3000 };
  const currentEvents: ImageReadResult[] = [];
  const currentRelease = acquireImageRead(account, source('oversized-current'), '', 0, value => currentEvents.push(value));
  await waitFor(() => currentEvents.some(value => value.decoded), 'oversized current image');
  assert.equal(currentEvents.find(value => value.decoded)?.width, 12000, 'the current image keeps its original quality and dimensions');
  assert.equal(activeDecoded.size, 1, 'an oversized current image drops decoded neighbor references');
  currentRelease();

  nextDecodeSize = { width: 1, height: 1 };
  const boundedFirst = source('bounded-0');
  for (let index = 0; index < 33; index++) {
    const before = decodeCalls;
    const release = prefetchImageRead(account, source(`bounded-${index}`));
    await waitFor(() => decodeCalls > before, `32-entry LRU fixture ${index}`);
    release(); await pause();
  }
  const getsBeforeEvictedRevisit = getCount();
  const bounded = await readToReady(account, boundedFirst, '');
  assert.equal(getCount(), getsBeforeEvictedRevisit + 1, 'the body cache stays within 32 entries and evicts its least-recently-used body');
  bounded.release();

  const cancelSource = source('cancel-neighbor');
  let requestSignal: AbortSignal | null = null;
  useFetch(async (_url, init) => {
    requestSignal = init.signal as AbortSignal;
    return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  });
  const releaseNeighbor = prefetchImageRead(account, cancelSource, '"cancel"');
  releaseNeighbor(); await pause();
  assert.equal((requestSignal as AbortSignal | null)?.aborted, true, 'released neighbor prefetch cancels its protected body request');
}

async function idleHiddenCancellationAndScheduler() {
  const account = 'p03-idle-hidden:member:user', imageSource = source('idle-ttl');
  await resetOwner(account);
  useFetch(async () => imageResponse('"idle-v1"'));
  const first = await readToReady(account, imageSource, '"idle-v1"'); first.release();
  const beforeIdleReopen = getCount();
  fakeNow += 10 * 60_000;
  revalidateActiveImages(); await pause();
  const reopened = await readToReady(account, imageSource, '');
  assert.equal(getCount(), beforeIdleReopen + 1, 'idle entries expire after ten minutes');
  reopened.release();

  const fixtureDocument = document as unknown as { hidden: boolean };
  let hiddenSignal: AbortSignal | undefined, finishHidden: ((response: Response) => void) | undefined;
  try {
    fixtureDocument.hidden = false;
    useFetch(async (_url, init) => {
      hiddenSignal = init.signal as AbortSignal;
      return new Promise<Response>(resolve => { finishHidden = resolve; });
    });
    const releaseHidden = prefetchImageRead(account, source('hidden-cancel'), '"hidden-v1"');
    await waitFor(() => Boolean(finishHidden && hiddenSignal), 'hidden cancellation request');
    fixtureDocument.hidden = true; revalidateActiveImages(); await pause();
    assert.equal(hiddenSignal?.aborted, true, 'hiding the document cancels idle neighbor prefetch work');
    finishHidden!(imageResponse('"hidden-v1"')); await pause();
    releaseHidden();
  } finally { fixtureDocument.hidden = false; }

  const cacheSource = readFileSync(resolve(process.cwd(), 'src/lib/media/image-read-session.ts'), 'utf8');
  const completionSource = readFileSync(resolve(process.cwd(), 'src/components/GenerationCompletion.tsx'), 'utf8');
  assert.match(cacheSource, /const REVALIDATE_AFTER = 60_000/);
  assert.match(cacheSource, /now - entry\.checkedAt >= Math\.max\(REVALIDATE_AFTER, minAge\)/);
  assert.match(completionSource, /revalidateActiveImages\(60000\)/, 'foreground scheduler retains its 60-second minimum');
}

async function hiddenPageCancelsNeighborPrefetch() {
  const account = 'p03-hidden-prefetch:member:user';
  await resetOwner(account);
  let requestSignal: AbortSignal | null = null;
  useFetch(async (_url, init) => {
    requestSignal = init.signal as AbortSignal;
    return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  });
  const release = prefetchImageRead(account, source('hidden-neighbor'), '"hidden"');
  await waitFor(() => requestSignal !== null, 'hidden-page neighbor request');
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  revalidateActiveImages(60_000);
  await pause();
  assert.equal((requestSignal as AbortSignal | null)?.aborted, true, 'hiding the page cancels an unused neighbor request');
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  release();
}

function delayedAnimationFramesDoNotGateReady() {
  const queued: FrameRequestCallback[] = [];
  let sequence = 0;
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => { queued.push(callback); return ++sequence; } });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: () => {} });
  let oldGateFinished = false;
  requestAnimationFrame(() => requestAnimationFrame(() => { oldGateFinished = true; }));
  const hot: ImageReadResult = { imageSrc: 'blob:https://sd2.youdooart.com/p03-hot', decoded: true, width: 3840, height: 1280, progress: { phase: 'decoding', loadedBytes: 4, percent: 100 } };
  assert.equal(isImagePreviewReady(hot), true, 'decoded hot Blob is visible without waiting for either frame');
  assert.equal(oldGateFinished, false, 'the simulated two-frame gate is still pending');
  const completeByProgressOnly: ImageReadResult = { imageSrc: 'blob:https://sd2.youdooart.com/p03-not-decoded', progress: { phase: 'reading', loadedBytes: 4, percent: 100 } };
  assert.equal(isImagePreviewReady(completeByProgressOnly), false, '100 percent progress alone is not decoded readiness');
  const component = readFileSync(resolve(process.cwd(), 'src/components/ZoomableImagePreview.tsx'), 'utf8');
  const previewImage = component.slice(component.indexOf('function PreviewImage'), component.indexOf('\ntype Side'));
  assert.match(previewImage, /isImagePreviewReady\(readResult, loadedKey === key\)/);
  assert.doesNotMatch(previewImage, /requestAnimationFrame/);
  queued.shift()?.(0);
  assert.equal(oldGateFinished, false);
}

async function main() {
  try {
    await warmReadDoesNotWaitForHead();
    await denialDiffersFromNetworkFailure();
    await bodyDenialInvalidatesOnlyItsSourceFamily();
    await readonlyHdDenialInvalidatesFamilyWithoutConsumer();
    await versionsVariantsAndOwnerEpoch();
    await readonlyHdDoesNotPromote();
    await freshHdReadyAndStaleRetention();
    await bodyDenialInvalidatesOnlyItsFamily();
    await readonlyHdDenialInvalidatesFamily();
    await decodedBudgetAndNeighborCancellation();
    await idleHiddenCancellationAndScheduler();
    await hiddenPageCancelsNeighborPrefetch();
    delayedAnimationFramesDoNotGateReady();
    console.log('P03 isolated regression fixtures completed.');
  } finally {
    setImageReadSessionOwner('');
    Date.now = realDateNow;
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
