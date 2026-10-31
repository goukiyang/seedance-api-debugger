import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as production from '../src/lib/generation-completion';

async function main() {
  const job = { owner: 'owner-a', id: 'request-one', kind: 'images' as const, count: 2, receipt: 'images:request-one', baselineSuccess: 0, hint: { moduleId: 'module-one' } };
  const task = (id: string, asset = true) => ({ id, status: 'succeeded', asset: asset ? { id: `asset-${id}`, original_url: `/protected/${id}` } : null });
  assert.equal(production.observeGenerationCompletion(job, { tasks: [task('one'), task('two', false)] }).terminal, false);
  const ready = production.observeGenerationCompletion(job, { tasks: [task('one'), task('two')] });
  assert.equal(ready.terminal, true); assert.equal(ready.targets.length, 2);
  assert.equal(production.generationCompletionHref(ready.targets[0]), '/template-studio?type=image&moduleId=module-one');
  const oldBatch = { ...job, kind: 'batch' as const, id: 'batch-one', baselineSuccess: 1, hint: { moduleId: 'module-one', baselineTaskIds: ['old'] } };
  const batch = { state: 'complete', active: 0, pending: 0, uncertain: 0, generated: 2, total: 2, failed: 0,
    items: [{ taskId: 'old', image: { id: 'asset-old', url: '/protected/old' } }, { taskId: 'new', image: { id: 'asset-new', url: '/protected/new' } }] };
  assert.deepEqual(production.observeGenerationCompletion(oldBatch, { batch }).targets.map(target => target.taskId), ['new']);
  assert.equal(production.observeGenerationCompletion(oldBatch, { batch: { ...batch, items: [] } }).terminal, false);
  const inbox = new Map(ready.targets.map(target => [target.key, target]));
  assert.equal(production.acknowledgeGenerationCompletion(inbox, 'other-owner', ready.targets[0].key, 'one'), false);
  assert.equal(production.acknowledgeGenerationCompletion(inbox, 'owner-a', ready.targets[0].key, 'other-task'), false);
  assert.equal(production.acknowledgeGenerationCompletion(inbox, 'owner-a', ready.targets[0].key, 'one'), true);
  assert.equal(inbox.size, 1);

  const originalIcon = { href: '/favicon.ico', rel: 'shortcut icon', type: 'image/x-icon' };
  const attributes = new Map(Object.entries(originalIcon));
  const iconLink = { getAttribute: (key: string) => attributes.get(key) || null, setAttribute: (key: string, value: string) => attributes.set(key, value), removeAttribute: (key: string) => attributes.delete(key) };
  const workers: Array<{ terminated: boolean; onmessage?: () => void; postMessage(value: unknown): void; terminate(): void }> = [];
  const revoked: string[] = [];
  const canvasContext: any = { scale() {}, clearRect() {}, drawImage() {}, fillRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {}, fillText() {}, measureText: (text: string) => ({ width: text.length * 4 }) };
  const packageOutput: any = { exports: {} };
  class PackageImage { onload?: () => void; set src(_value: string) { this.onload?.(); } }
  class PackageWorker {
    terminated = false; onmessage?: () => void;
    constructor(_url: string) { workers.push(this); }
    postMessage(_value: unknown) {} terminate() { this.terminated = true; }
  }
  class PackageURL extends URL { static createObjectURL() { return 'blob:completion-fixture'; } static revokeObjectURL(url: string) { revoked.push(url); } }
  vm.runInNewContext(readFileSync('node_modules/magic-favicon/dist/index.cjs', 'utf8'), {
    module: packageOutput, exports: packageOutput.exports,
    document: { querySelector: () => iconLink, createElement: () => ({ width: 0, height: 0, getContext: () => canvasContext, toDataURL: () => 'data:image/png;base64,fixture' }) },
    window: { devicePixelRatio: 1, location: { href: 'https://example.invalid/', origin: 'https://example.invalid' } },
    Worker: PackageWorker, URL: PackageURL, Blob, Image: PackageImage, performance: { now: () => 0 },
  });
  const publishedIcon = packageOutput.exports.default;
  publishedIcon.pulse({ tickMs: 160, periodMs: 1800 }); assert.equal(workers.length, 1); workers[0].onmessage?.();
  publishedIcon.badge(2); assert.equal(workers[0].terminated, true); assert.deepEqual(revoked, ['blob:completion-fixture']);
  publishedIcon.reset(); publishedIcon.destroy(); assert.deepEqual(Object.fromEntries(attributes), originalIcon);

  class Hub {
    listeners = new Map<string, Set<(...args: any[]) => void>>();
    addEventListener(type: string, listener: (...args: any[]) => void) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type)!.add(listener); }
    removeEventListener(type: string, listener: (...args: any[]) => void) { this.listeners.get(type)?.delete(listener); }
    dispatchEvent(event: { type: string }) { for (const listener of Array.from(this.listeners.get(event.type) || [])) listener(event); return true; }
  }
  let now = 1000, timerId = 0, dirty = false, hookIndex = 0;
  const timers = new Map<number, { delay: number; callback: () => void; at: number }>();
  const setTimer = (callback: () => void, delay: number) => { const id = ++timerId; timers.set(id, { delay, callback, at: now + delay }); return id; };
  const clearTimer = (id: number) => timers.delete(id);
  const fire = (delay: number) => { const entries = Array.from(timers.entries()).filter(([, timer]) => timer.delay === delay); for (const [id, timer] of entries) { timers.delete(id); now = timer.at; timer.callback(); } };
  const storage = new Map<string, string>();
  const cards: any[] = [];
  const documentHub: any = new Hub();
  Object.assign(documentHub, { title: 'Original title', visibilityState: 'visible', head: {}, body: {}, querySelectorAll: (selector: string) => selector === 'dialog[open]' ? [] : cards });
  Object.defineProperty(documentHub, 'hidden', { get: () => documentHub.visibilityState === 'hidden' });
  const windowHub: any = new Hub();
  Object.assign(windowHub, { location: { pathname: '/template-studio', search: '?type=image&moduleId=module-one' }, innerHeight: 800, innerWidth: 1200 });
  const mutations: any[] = [];
  class Observer {
    target: unknown; active = true;
    constructor(public callback: () => void) { mutations.push(this); }
    observe(target: unknown) { this.target = target; }
    disconnect() { this.active = false; }
  }
  const mutateBody = () => { for (const observer of mutations.filter(item => item.active && item.target === documentHub.body)) observer.callback(); };
  const oldDocument = (globalThis as any).document, oldStyle = (globalThis as any).getComputedStyle;
  (globalThis as any).document = documentHub; (globalThis as any).getComputedStyle = (card: any) => ({ visibility: card.invisible ? 'hidden' : 'visible' });
  let query: unknown = { tasks: [task('one', false), task('two', false)] }, faviconImports = 0;
  const iconCalls: Array<[string, number?]> = [], routes: string[] = [];
  const icon = { pulse: () => { iconCalls.push(['pulse']); }, badge: (count: number) => { iconCalls.push(['badge', count]); }, reset: () => { iconCalls.push(['reset']); }, destroy: () => { iconCalls.push(['destroy']); } };
  const state: any[] = [], effects: Array<{ dependencies?: any[]; cleanup?: () => void }> = [];
  const effectQueue: Array<() => void> = [];
  const react = { useState: (initial: any) => { const index = hookIndex++; if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
    return [state[index], (next: any) => { state[index] = typeof next === 'function' ? next(state[index]) : next; dirty = true; }]; },
    useEffect: (callback: () => any, dependencies?: any[]) => { const index = hookIndex++, old = effects[index];
      if (!old || !dependencies || dependencies.some((value, i) => value !== old.dependencies?.[i])) effectQueue.push(() => { old?.cleanup?.(); effects[index] = { dependencies, cleanup: callback() }; }); } };
  const fakeSession: any = { user: { id: 'owner-a', role: 'admin', account_type: 'internal' }, hasLoadedUser: true, userLoadError: null };
  const modules: Record<string, any> = {
    react, 'react/jsx-runtime': { jsx: (tag: unknown, props: unknown) => ({ tag, props }), jsxs: (tag: unknown, props: unknown) => ({ tag, props }) },
    'next/navigation': { usePathname: () => windowHub.location.pathname, useRouter: () => ({ push: (href: string) => { routes.push(href); const url = new URL(href, 'https://example.invalid'); windowHub.location = { pathname: url.pathname, search: url.search }; dirty = true; } }) },
    'lucide-react': {}, '@/lib/context/AppSessionContext': { useAppSession: () => fakeSession },
    './GenerationCompletion.module.css': {}, '@/lib/media/image-read-session': { setImageReadSessionOwner() {}, revalidateActiveImages() {} },
    '@/lib/hooks/page-exit-guard': { getPageExitRisk: () => ({ busy: [], unsaved: [] }) }, '@/lib/auth/client-session-boundary': { isClientSessionBlocked: () => false }, '@/lib/generation-completion': production,
    'magic-favicon': { __esModule: true, default: icon },
  };
  const exported: any = {};
  const context: any = vm.createContext({ exports: exported, module: { exports: exported }, require: (id: string) => {
    assert.ok(Object.hasOwn(modules, id), id); if (id === 'magic-favicon') faviconImports++; return modules[id]; },
    setTimeout: setTimer, clearTimeout: clearTimer, Date: class extends Date { static now() { return now; } }, Event,
    fetch: async () => Response.json(query), AbortSignal, navigator: {}, matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (fn: () => void) => setTimer(fn, 16), cancelAnimationFrame: clearTimer });
  const source = ts.transpileModule(readFileSync('src/components/GenerationCompletion.tsx', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  vm.runInContext(source + '\nexports.fixture = { poll, get unseen() { return unseen; }, get requested() { return requested; }, get jobs() { return jobs; } };', context);
  assert.equal(faviconImports, 0, 'SSR module evaluation must not import the document-dependent package');
  Object.assign(context, { document: documentHub, window: windowHub, localStorage: { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value) }, MutationObserver: Observer });
  let rendered: any;
  const render = () => { dirty = false; hookIndex = 0; rendered = exported.GenerationCompletionRuntime(); while (effectQueue.length) effectQueue.shift()!(); };
  const settle = async () => { for (let pass = 0; pass < 8; pass++) { await Promise.resolve(); if (dirty) render(); } };
  try {
    render(); await settle();
    exported.watchGenerationCompletion('owner-a', 'request-one', 'images', 2, undefined, 0, { moduleId: 'module-one' });
    await exported.fixture.poll(); await settle(); assert.equal(exported.fixture.jobs.size, 1); assert.equal(exported.fixture.unseen.size, 0);
    query = { tasks: [task('one'), task('two', false)] };
    await exported.fixture.poll(); await settle(); assert.equal(exported.fixture.jobs.size, 1); assert.equal(exported.fixture.unseen.size, 1);
    await exported.fixture.poll(); await settle(); assert.equal(exported.fixture.unseen.size, 1, 'A ready output is not repeatedly announced while other outputs wait');
    query = { tasks: [task('one'), task('two')] };
    await exported.fixture.poll(); await settle(); assert.equal(exported.fixture.unseen.size, 2); assert.equal(routes.length, 0); assert.equal(documentHub.title, 'Original title');
    assert.equal(faviconImports, 0, 'Foreground completion is a quiet in-app result entry');
    assert.ok(JSON.stringify(rendered).includes('查看结果'));
    documentHub.visibilityState = 'hidden'; documentHub.dispatchEvent({ type: 'visibilitychange' }); await settle();
    assert.ok(iconCalls.some(([method, count]) => method === 'badge' && count === 2));
    windowHub.dispatchEvent({ type: 'focus' }); await settle(); assert.equal(routes.length, 0);
    documentHub.visibilityState = 'visible'; documentHub.dispatchEvent({ type: 'visibilitychange' }); await settle();
    assert.equal(routes.length, 1); assert.equal(exported.fixture.unseen.size, 2); assert.ok(exported.fixture.requested);
    const visibleCard: any = { dataset: { resultTaskId: 'one' }, isConnected: true, hasAttribute: (name: string) => name === 'data-result-ready',
      closest: () => null, getBoundingClientRect: () => ({ width: 250, height: 250, top: 50, bottom: 300, left: 20, right: 270 }),
      scrollIntoView() { this.scrolled = true; }, animate() { this.highlighted = true; } };
    cards.push(visibleCard); mutateBody(); assert.equal(exported.fixture.unseen.size, 2); assert.equal(visibleCard.scrolled, true); assert.equal(visibleCard.highlighted, true);
    fire(1400); await settle(); assert.equal(exported.fixture.unseen.size, 1); assert.equal(routes.length, 1, 'Viewing one result must not auto-open the second');
    assert.equal(exported.fixture.requested, null);
    documentHub.visibilityState = 'hidden'; documentHub.dispatchEvent({ type: 'visibilitychange' }); await settle();
    documentHub.visibilityState = 'visible'; documentHub.dispatchEvent({ type: 'visibilitychange' }); await settle();
    assert.ok(exported.fixture.requested); windowHub.dispatchEvent({ type: 'pointerdown' }); await settle();
    assert.equal(exported.fixture.requested, null); assert.equal(exported.fixture.unseen.size, 1, 'A new foreground action cancels only late automatic landing');
    exported.watchGenerationCompletion('other-owner', 'another', 'images', 1); assert.equal(exported.fixture.jobs.size, 0);
    exported.watchGenerationCompletion('owner-a', 'request-one', 'images', 2); assert.equal(exported.fixture.jobs.size, 0);
    documentHub.visibilityState = 'hidden'; documentHub.dispatchEvent({ type: 'visibilitychange' }); await settle();
    exported.watchGenerationCompletion('owner-a', 'request-two', 'images', 1, undefined, 0, { moduleId: 'module-one' }); query = { tasks: [task('three')] };
    await exported.fixture.poll(); await settle();
    assert.equal(exported.fixture.unseen.size, 2); assert.equal(documentHub.title, '生成完成（2）');
    // The original background indicator stays static; a fresh empty inbox starts the next pulse window.
    fakeSession.user = { ...fakeSession.user, id: 'owner-b' }; render(); await settle();
    assert.equal(exported.fixture.unseen.size, 0); assert.equal(exported.fixture.requested, null); assert.equal(documentHub.title, 'Original title');
    exported.watchGenerationCompletion('owner-b', 'request-background', 'images', 1, undefined, 0, { moduleId: 'module-b' }); query = { tasks: [task('four')] };
    await exported.fixture.poll(); await settle(); assert.equal(iconCalls.at(-1)?.[0], 'pulse');
    fire(8000); await settle(); assert.deepEqual(iconCalls.at(-1), ['badge', 1]);
    assert.equal(exported.fixture.unseen.size, 1, 'The pulse deadline is not a viewed receipt');
    const runtimeChecks = ['succeeded_without_asset_keeps_original_watch', 'each_actual_output_notifies_once_without_waiting_for_missing_outputs', 'foreground_toast_does_not_navigate_or_change_tab',
      'window_focus_does_not_navigate', 'hidden_to_visible_requests_actual_target', 'missing_card_keeps_pending',
      'real_card_scroll_highlight_precedes_ack', 'multiple_targets_ack_only_viewed_task', 'foreground_action_cancels_late_automatic_scroll_without_ack', 'receipt_and_owner_isolation',
      'dynamic_client_import_pulse_8s_then_static_badge_until_viewed', 'account_switch_restores_title_and_resets_favicon', 'published_package_badge_stops_pulse_worker_and_revokes_blob', 'published_package_reset_restores_href_rel_type'];
    assert.equal(production.completionCardIsVisible({ ...visibleCard, invisible: true }), false);
    assert.equal(production.completionCardIsVisible({ ...visibleCard, hasAttribute: () => false }), false);
    for (const effect of effects) effect?.cleanup?.();
    assert.equal(iconCalls.at(-1)?.[0], 'destroy');
    console.log(JSON.stringify({ passed: true, checks: runtimeChecks, cases: runtimeChecks.length + 3, productionCoreAndRuntimeExecuted: true, fakeDomOnly: true,
      applicationDatabaseOpened: false, networkCalls: 0, browserRuns: 0, paidRequests: 0 }));
  } finally {
    (globalThis as any).document = oldDocument; (globalThis as any).getComputedStyle = oldStyle;
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
