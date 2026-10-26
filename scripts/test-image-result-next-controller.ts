import assert from 'node:assert/strict';
import { createImageResultNextController, imageResultNextCapabilities, type ImageResultNextContext } from '../src/lib/image-result-next/controller';
import type { ImageResultNextIntent, ImageResultNextReceipt } from '../src/lib/image-result-next/types';
import type { ContentKey } from '../src/lib/content-reactions/types';

// Injected promises and blank-window handles only. No browser, fetch, file
// upload, auth mutation, handoff API, or paid provider request is performed.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const sourceKey: ContentKey = 'asset:fixture-original';
function receipt(source: ContentKey = sourceKey, intent: ImageResultNextIntent = 'video'): ImageResultNextReceipt {
  return { receiptId: 'a'.repeat(64), intent, sourceKey: source, source: { label: 'fixture', originalUrl: '/fixture-original', fileName: 'fixture.png' },
    returnPath: '/template-studio?type=image', destination: intent === 'video' ? `/generate?image_result_handoff=${'a'.repeat(64)}` : `/cutout?handoff=${'a'.repeat(64)}`,
    message: '原图已带入，尚未生成', ready: true };
}
function fixture(initial: Partial<ImageResultNextContext> = {}) {
  let context: ImageResultNextContext = { accountId: 'fixture-account', admin: true, sourceKey, resultId: 'fixture-result', scope: 'fixture-scope:v1', ...initial };
  let blocked = false, popupBlocked = false;
  const events: string[] = [], posts: Array<{ source: ContentKey; intent: ImageResultNextIntent; returnPath: string }> = [];
  const queries: ContentKey[] = [];
  const reads: Array<() => Promise<ImageResultNextReceipt | null>> = [];
  const writes: Array<() => Promise<ImageResultNextReceipt>> = [];
  const targets: Array<{ closed: boolean; url: string; closes: number }> = [];
  const controller = createImageResultNextController({ context: () => context, blocked: () => blocked,
    currentUrl: () => 'https://fixture.invalid/template-studio?type=image&moduleId=fixture#original-position',
    openTarget: () => {
      events.push('open');
      if (popupBlocked) return null;
      const target = { closed: false, url: '', closes: 0 }; targets.push(target);
      return { close: () => { target.closed = true; target.closes++; }, closed: () => target.closed, replace: url => { target.url = url; } };
    },
    find: source => { events.push('get'); queries.push(source); const next = reads.shift(); assert.ok(next, 'unexpected GET'); return next(); },
    create: (source, intent, returnPath) => { events.push('post'); posts.push({ source, intent, returnPath }); const next = writes.shift(); assert.ok(next, 'unexpected POST'); return next(); },
  });
  return { controller, events, posts, queries, reads, writes, targets,
    change: (next: Partial<ImageResultNextContext>) => { context = { ...context, ...next }; },
    block: () => { blocked = true; }, blockPopup: () => { popupBlocked = true; } };
}

async function run() {
  for (const context of [{ sourceKey: undefined }, { accountId: '' }, { enabled: false }, { sessionChanged: true }]) {
    const f = fixture(context); await f.controller.open('video');
    assert.deepEqual(f.events, [], 'disabled/missing source never opens a page or queries'); f.controller.dispose();
  }
  const unauthorized = fixture({ admin: false }); await unauthorized.controller.open('cutout');
  assert.deepEqual(unauthorized.events, []); unauthorized.controller.dispose();
  assert.equal(imageResultNextCapabilities({ accountId: 'a', admin: false, sourceKey }).canVideo, true);
  const alreadyBlocked = fixture(); alreadyBlocked.block(); await alreadyBlocked.controller.open('video');
  assert.deepEqual(alreadyBlocked.events, []); alreadyBlocked.controller.dispose();

  // Synchronous opening and per-card duplicate lock. Hiding a menu changes no
  // controller lifetime; the owning card and feedback remain mounted.
  const active = fixture(), gate = deferred<ImageResultNextReceipt | null>();
  active.reads.push(() => gate.promise);
  let menuOpen = true;
  const operation = active.controller.open('video');
  assert.deepEqual(active.events, ['open', 'get'], 'open must happen before the async read yields');
  await active.controller.open('cutout');
  assert.deepEqual(active.events, ['open', 'get'], 'a second click does not issue another GET/POST/window');
  menuOpen = false;
  gate.resolve(receipt()); await operation;
  assert.equal(menuOpen, false); assert.equal(active.targets[0].url, receipt().destination);
  assert.equal(active.controller.getSnapshot().message, receipt().message);
  assert.equal(active.controller.getSnapshot().busy, null); active.controller.dispose();
  assert.equal(active.targets[0].closed, false, 'card cleanup must not close an already delivered workspace');

  const getError = fixture(); getError.reads.push(() => Promise.reject(new Error('GET unavailable')));
  await getError.controller.open('video');
  assert.equal(getError.posts.length, 0); assert.equal(getError.controller.getSnapshot().message, 'GET unavailable');
  assert.equal(getError.targets[0].closed, true); getError.controller.dispose();
  const badGet = fixture(); badGet.reads.push(() => Promise.resolve(false as unknown as ImageResultNextReceipt));
  await badGet.controller.open('video'); assert.equal(badGet.posts.length, 0); badGet.controller.dispose();

  // A lost POST reply leaves a message. A later user action must query first
  // and reuse the found receipt, rather than directly repeating that POST.
  const uncertain = fixture(); uncertain.reads.push(() => Promise.resolve(null));
  uncertain.writes.push(() => Promise.reject(new Error('POST result unknown')));
  await uncertain.controller.open('video');
  assert.equal(uncertain.posts.length, 1); assert.equal(uncertain.controller.getSnapshot().message, 'POST result unknown');
  const from = new URL(uncertain.posts[0].returnPath, 'https://fixture.invalid');
  assert.equal(from.pathname, '/template-studio'); assert.equal(from.searchParams.get('moduleId'), 'fixture');
  assert.equal(from.searchParams.get('image_result_focus'), 'fixture-result'); assert.equal(from.hash, '#image-result-fixture-result');
  uncertain.reads.push(() => Promise.resolve(receipt())); await uncertain.controller.open('video');
  assert.deepEqual(uncertain.events, ['open', 'get', 'post', 'open', 'get']); uncertain.controller.dispose();

  // Query failures during unknown recovery cannot prove non-acceptance either.
  const unknownRead = fixture(); unknownRead.reads.push(() => Promise.resolve(null));
  unknownRead.writes.push(() => Promise.reject(new Error('unknown'))); await unknownRead.controller.open('video');
  unknownRead.reads.push(() => Promise.reject(new Error('receipt read failed'))); await unknownRead.controller.open('video');
  assert.equal(unknownRead.posts.length, 1); unknownRead.controller.dispose();

  for (const change of [{ accountId: 'other-account' }, { sourceKey: 'asset:other' as ContentKey }, { resultId: 'other-result' }, { scope: 'fixture-scope:v2' }, { sessionChanged: true }, { enabled: false }]) {
    const f = fixture(), pending = deferred<ImageResultNextReceipt | null>(); f.reads.push(() => pending.promise);
    const task = f.controller.open('video'); f.change(change); f.controller.synchronize();
    assert.equal(f.targets[0].closed, true, 'identity changes promptly close the pending blank page');
    pending.resolve(null); await task;
    assert.equal(f.posts.length, 0); assert.equal(f.controller.getSnapshot().destination, ''); f.controller.dispose();
  }
  const blockedDuringGet = fixture(), read = deferred<ImageResultNextReceipt | null>();
  blockedDuringGet.reads.push(() => read.promise); const readTask = blockedDuringGet.controller.open('video');
  blockedDuringGet.block(); read.resolve(null); await readTask;
  assert.equal(blockedDuringGet.posts.length, 0); assert.equal(blockedDuringGet.targets[0].closed, true); blockedDuringGet.controller.dispose();

  const latePost = fixture(), created = deferred<ImageResultNextReceipt>(), postStarted = deferred<void>();
  latePost.reads.push(() => Promise.resolve(null)); latePost.writes.push(() => { postStarted.resolve(undefined); return created.promise; });
  const posting = latePost.controller.open('video');
  await postStarted.promise;
  assert.equal(latePost.posts.length, 1); latePost.change({ accountId: 'new-account' }); latePost.controller.synchronize();
  created.resolve(receipt()); await posting;
  assert.equal(latePost.targets[0].url, ''); assert.equal(latePost.controller.getSnapshot().message, ''); latePost.controller.dispose();

  const unmounted = fixture(), pendingRead = deferred<ImageResultNextReceipt | null>();
  unmounted.reads.push(() => pendingRead.promise); const old = unmounted.controller.open('video');
  unmounted.controller.dispose(); pendingRead.resolve(null); await old;
  assert.equal(unmounted.posts.length, 0); assert.equal(unmounted.targets[0].closed, true);

  const fallback = fixture(); fallback.blockPopup(); fallback.reads.push(() => Promise.resolve(null)); fallback.writes.push(() => Promise.resolve(receipt()));
  await fallback.controller.open('video'); assert.equal(fallback.controller.getSnapshot().destination, receipt().destination);
  assert.equal(fallback.controller.getSnapshot().message, receipt().message); fallback.controller.dispose();
  const wrongDestination = fixture(); wrongDestination.reads.push(() => Promise.resolve({ ...receipt(), destination: 'https://other.invalid/' }));
  await wrongDestination.controller.open('video'); assert.equal(wrongDestination.controller.getSnapshot().destination, '');
  assert.equal(wrongDestination.targets[0].closed, true); wrongDestination.controller.dispose();

  console.log('Image result handoff controller fixture cases complete');
}
void run().catch(cause => { console.error(cause); process.exitCode = 1; });
