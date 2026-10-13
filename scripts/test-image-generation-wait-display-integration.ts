import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { advanceImageGenerationWaitDisplay, imageGenerationWaitDisplay, type ImageGenerationWait, type ImageGenerationWaitDisplay } from '../src/lib/image-studio/wait-display';

// Offline composition and lifecycle contracts. No real React DOM, browser,
// animation, image network or business API is exercised by this fixture.
type Props = Record<string, unknown>;
type Element = { type: unknown; props: Props };
type Component = (props: Props) => unknown;
type Effect = { deps?: unknown[]; cleanup?: () => void };
type Frame = { slots: unknown[]; dirty: boolean; pending: Array<() => void> };
const root = resolve(process.argv[2] || process.cwd());
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const hookSource = read('src/components/useImageGenerationWaitDisplay.ts');
const waitingSource = read('src/components/ImageGenerationWaiting.tsx');
const resultsSource = read('src/components/GeneratedImageResults.tsx');
const studioSource = read('src/app/image-studio/studio.tsx');
const batchSource = read('src/app/image-studio/batch-results.tsx');
const frames = new Map<string, Frame>();
let current: Frame, slot = 0;
let now = 1_000_000;
let timerId = 0, reads = 0, mutations = 0, downloads = 0;
const timers = new Map<number, { due: number; callback: () => void }>();
const windowEvents: Record<string, Set<() => void>> = {}, documentEvents: Record<string, Set<() => void>> = {};
function events(store: Record<string, Set<() => void>>, name: string) { return store[name] || (store[name] = new Set()); }
const navigator = { onLine: true };
const motionEvents: Record<string, Set<() => void>> = {};
const motion = { matches: false, addEventListener: (name: string, callback: () => void) => events(motionEvents, name).add(callback),
  removeEventListener: (name: string, callback: () => void) => events(motionEvents, name).delete(callback) };
const document = { hidden: false, addEventListener: (name: string, callback: () => void) => events(documentEvents, name).add(callback),
  removeEventListener: (name: string, callback: () => void) => events(documentEvents, name).delete(callback) };
const window = { addEventListener: (name: string, callback: () => void) => events(windowEvents, name).add(callback),
  matchMedia: () => motion,
  removeEventListener: (name: string, callback: () => void) => events(windowEvents, name).delete(callback),
  setTimeout: (callback: () => void, delay: number) => { const id = ++timerId; timers.set(id, { due: now + delay, callback }); return id; },
  clearTimeout: (id: number) => timers.delete(id) };
const runtime = {
  useState(initial: unknown) {
    const owner = current, index = slot++;
    if (!(index in owner.slots)) owner.slots[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    return [owner.slots[index], (value: unknown) => {
      const next = typeof value === 'function' ? (value as (old: unknown) => unknown)(owner.slots[index]) : value;
      if (!Object.is(next, owner.slots[index])) { owner.slots[index] = next; owner.dirty = true; }
    }];
  },
  useRef(initial: unknown) { const index = slot++; if (!(index in current.slots)) current.slots[index] = { current: initial }; return current.slots[index]; },
  useCallback(callback: unknown) { return callback; },
  useEffect(callback: () => void | (() => void), deps?: unknown[]) {
    const owner = current, index = slot++, previous = owner.slots[index] as Effect | undefined;
    if (previous && deps && previous.deps && deps.length === previous.deps.length && deps.every((value, position) => Object.is(value, previous.deps![position]))) return;
    owner.pending.push(() => {
      previous?.cleanup?.();
      const cleanup = callback(); owner.slots[index] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
    });
  },
};
const jsx = (type: unknown, props: Props): Element => ({ type, props });
const styleNames = new Proxy({}, { get: (_target, key) => String(key) });
function load(source: string, mocks: Record<string, unknown> = {}, extra: Props = {}) {
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
    jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const exports: Props = {};
  runInNewContext(output, { exports, require: (name: string) => {
    if (name === 'react') return runtime;
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: Symbol('fragment') };
    if (name === 'lucide-react') return new Proxy({}, { get: () => () => null });
    if (name.endsWith('.module.css')) return { __esModule: true, default: styleNames };
    assert.ok(name in mocks, `unexpected wait fixture dependency: ${name}`); return mocks[name];
  }, navigator, document, window, Date: { now: () => now }, ...extra });
  return exports;
}
function render(component: unknown, props: Props, identity: string): unknown {
  assert.equal(typeof component, 'function');
  const frame = frames.get(identity) || { slots: [], dirty: false, pending: [] }; frames.set(identity, frame);
  let tree: unknown;
  for (let pass = 0; pass < 6; pass++) {
    current = frame; slot = 0; frame.dirty = false;
    tree = (component as Component)(props);
    const pending = frame.pending.splice(0); pending.forEach(effect => effect());
    if (!frame.dirty) return tree;
  }
  throw new Error('fixture rendering did not settle');
}
function nodes(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object' || !('type' in value) || !('props' in value)) return [];
  const element = value as Element; return [element, ...nodes(element.props.children)];
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join('');
  if (value && typeof value === 'object' && 'props' in value) return text((value as Element).props.children);
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
function unmount(identity: string) {
  const frame = frames.get(identity); if (!frame) return;
  frame.slots.forEach(value => { if (value && typeof value === 'object' && 'cleanup' in value) (value as Effect).cleanup?.(); });
  frames.delete(identity);
}
function fire(store: Record<string, Set<() => void>>, name: string) { Array.from(events(store, name)).forEach(callback => callback()); }
function advance(time: number) {
  now = time;
  Array.from(timers.entries()).forEach(([id, timer]) => { if (timer.due <= now) { timers.delete(id); timer.callback(); } });
}
function extract(source: string, name: 'generationWait' | 'renderPrimaryActions') {
  const file = ts.createSourceFile('wait-source.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const expressions: ts.Expression[] = [];
  function visit(node: ts.Node) {
    if (name === 'generationWait' && ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === name) expressions.push(node.initializer);
    if (name === 'renderPrimaryActions' && ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === name
      && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) expressions.push(node.initializer.expression);
    if (!expressions.length) ts.forEachChild(node, visit);
  }
  visit(file); assert.ok(expressions[0], `missing actual ${name} wiring`); return expressions[0].getText(file);
}
const actualPrimary = (source: string) => load(`exports.primary = ${extract(source, 'renderPrimaryActions')};`, {}, {
  submitting: false, templateWorkbench: true, taskReadAction: 'idle', reading: false,
  confirm: async () => { mutations++; return false; }, fetch: () => { mutations++; throw new Error('unexpected mutation'); },
  loadTasks: () => reads++, load: () => reads++,
}).primary as (item: Props, display?: ImageGenerationWaitDisplay) => unknown;
const studioPrimary = actualPrimary(studioSource), batchPrimary = actualPrimary(batchSource);
const hook = load(hookSource, { '@/lib/image-studio/wait-display': { advanceImageGenerationWaitDisplay, imageGenerationWaitDisplay } }).useImageGenerationWaitDisplay;
const Waiting = load(waitingSource).ImageGenerationWaiting;
const Cover = Symbol('cover');
const results = load(resultsSource, {
  'react-dom': { createPortal: (value: unknown) => value }, './ResultImageCover': { ResultImageCover: Cover },
  './ZoomableImagePreview': { ZoomableImagePreview: Symbol('preview') }, './content-reactions/ContentReactions': { __esModule: true, default: Symbol('reactions') },
  './LoadingState': { LoadingSkeleton: Symbol('skeleton'), LoadingStatus: Symbol('loading') },
  '@/lib/media/copy-image': { copyImage: () => { mutations++; } }, './useResultPages': { useResultPages: (options: Props) => ({
    page: 1, pages: 1, pageItems: options.items, capacity: 3, gridRef: { current: null }, goToId() {}, retry() {}, reset() {}, previous() {}, next() {}, last() {},
  }) }, './ImageBillingBadge': { ImageBillingBadge: Symbol('billing') }, './ImageGenerationWaiting': { ImageGenerationWaiting: Waiting },
  './useImageGenerationWaitDisplay': { useImageGenerationWaitDisplay: hook },
  './ImageResultNextActions': { ImageResultNextActions: Symbol('next'), ImageResultNextActionFeedback: Symbol('next-feedback') },
  './useImageResultNextActions': { useImageResultNextActions: () => ({}) }, './ResultImageContextMenu': { ResultImageContextMenu: Symbol('menu') },
  '@/lib/context/AppSessionContext': { useAppSession: () => ({ user: { id: 'wait-fixture' }, sessionChanged: false }) },
  '@/lib/auth/client-session-boundary': { isClientSessionBlocked: () => false },
}).GeneratedImageResults;
const acceptedAt = now;
const task = { id: 'task-original', status: 'running', createdAt: new Date(acceptedAt - 1_000).toISOString(),
  delivery: { phase: 'provider', waitingStatus: 'retrying', acceptedAt, recoveryAvailable: true }, error: '原任务正在重新连接' };
function mappedWait(source: string, value: Props) {
  return load(`exports.wait = ${extract(source, 'generationWait')};`, {}, { task: value, item: value,
    image: value.asset || value.image ? { src: '/fixture-image' } : undefined,
    resultError: '', error: '', studioTaskPhase: () => '生成中', statusLabel: () => '生成中' }).wait as ImageGenerationWait;
}
function card(wait: ImageGenerationWait, primary: (item: Props, display?: ImageGenerationWaitDisplay) => unknown, identity: string, media = false, overrides: Props = {}) {
  let received: ImageGenerationWaitDisplay | undefined;
  let primaryTree: unknown;
  const item = { id: task.id, task: { ...task, status: wait.status }, taskId: task.id, label: '原任务', status: wait.label,
    pending: !media && ['pending', 'queued', 'running'].includes(wait.status),
    generationWait: wait, error: wait.detail, media: media ? { src: '/fixture-image' } : undefined,
    download: media ? () => { downloads++; } : undefined, ...overrides };
  const list = render(results, { items: [item], scope: 'wait-fixture', renderPrimaryActions: (value: Props, display?: ImageGenerationWaitDisplay) => {
    received = display; primaryTree = primary(value, display); return primaryTree;
  } }, `${identity}-list`);
  const child = nodes(list).find(node => typeof node.type === 'function' && (node.type as { name: string }).name === 'GeneratedImageResultCard');
  assert.ok(child);
  const tree = render(child.type, child.props, identity);
  const waitElement = nodes(tree).find(node => node.type === Waiting) || (nodes(tree).find(node => node.type === Cover)?.props.loadingOverlay as Element | undefined);
  if (waitElement) assert.equal(waitElement.props.display, received, 'cover and recovery receive the very same display result');
  const waitingTree = waitElement ? render(Waiting, waitElement.props, `${identity}-waiting`) : undefined;
  const track = nodes(waitingTree).some(node => node.props.className === 'waitTrack');
  const title = nodes(waitingTree).find(node => node.type === 'strong')?.props.children
    || nodes(tree).find(node => node.props.className === 'phase')?.props.children;
  const progressNode = nodes(waitingTree).find(node => node.props.role === 'progressbar');
  const percentNode = nodes(waitingTree).find(node => node.props.className === 'waitPercent');
  if (progressNode) { assert.ok(Number(progressNode.props['aria-valuenow']) <= 100); assert.ok(percentNode); assert.equal(String(percentNode.props['aria-hidden']), 'true'); assert.equal(percentNode.props['aria-live'], undefined); }
  return { tree, received: received!, track, title, alerts: nodes(tree).filter(node => node.props.role === 'alert'),
    buttons: nodes(primaryTree).filter(node => node.type === 'button'), allButtons: nodes(tree).filter(node => node.type === 'button'),
    percent: percentNode ? text(percentNode) : undefined };
}

const singleWait = mappedWait(studioSource, task);
const batchWait = mappedWait(batchSource, { ...task, taskId: task.id });
assert.equal(singleWait.createdAt, task.createdAt); assert.equal(batchWait.createdAt, undefined, 'actual batch mapping does not borrow a batch timestamp');
const variants: Array<[string, ImageGenerationWait, typeof studioPrimary]> = [['single', singleWait, studioPrimary], ['batch', batchWait, batchPrimary]];
variants.forEach(([name, wait, primary]) => {
  now = acceptedAt;
  const initial = card(wait, primary, name);
  assert.equal(initial.title, '正在生成'); assert.equal(initial.track, true); assert.equal(initial.alerts.length, 0); assert.equal(initial.buttons.length, 0);
  navigator.onLine = false; fire(windowEvents, 'offline');
  now = acceptedAt + 299_999;
  const nearly = card(wait, primary, name);
  assert.equal(nearly.track, true); assert.equal(nearly.alerts.length, 0); assert.equal(nearly.buttons.length, 0);
  assert.ok(Array.from(timers.values()).some(timer => timer.due === acceptedAt + 300_000), 'offline does not cancel the original boundary alarm');
  advance(acceptedAt + 300_000);
  const expired = card(wait, primary, name);
  assert.equal(expired.title, '状态暂未更新'); assert.equal(expired.track, false); assert.equal(expired.alerts.length, 1); assert.equal(expired.buttons.length, 1);
  assert.equal(expired.alerts[0].props.children, expired.received.detail, 'error copy consumes the same display result');
  (expired.buttons[0].props.onClick as () => void)();
  navigator.onLine = true; fire(windowEvents, 'online');
  const resumed = card({ ...wait, waitingStatus: 'pending', detail: '旧提示' }, primary, name);
  assert.equal(resumed.title, '正在生成'); assert.equal(resumed.track, true); assert.equal(resumed.alerts.length, 0); assert.equal(resumed.buttons.length, 0);
  assert.equal(card(wait, primary, `${name}-remounted`).track, false, 'remount does not restart five minutes');
});
assert.equal(reads, 2); assert.equal(mutations, 0, 'recovery only invokes the original read callback');

now = acceptedAt + 10;
['succeeded', 'failed', 'cancelled', 'uncertain'].forEach(status => {
  const terminal = card({ ...singleWait, status, label: `真实${status}`, detail: status === 'failed' ? '真实失败说明' : undefined,
    recoveryAvailable: false }, studioPrimary, `terminal-${status}`);
  assert.equal(terminal.title, `真实${status}`); assert.equal(terminal.track, false);
  assert.equal(terminal.alerts.length, status === 'failed' ? 1 : 0); assert.equal(terminal.buttons.length, 0);
});
const validating = card({ ...singleWait, phase: 'validate', label: '图片校验中', detail: '交付阶段说明' }, studioPrimary, 'validating');
assert.equal(validating.title, '图片校验中'); assert.equal(validating.track, true); assert.equal(validating.alerts.length, 1); assert.equal(validating.buttons.length, 1);

now = acceptedAt + 100;
const foregroundIdentity = 'foreground';
card(singleWait, studioPrimary, foregroundIdentity);
document.hidden = true; fire(documentEvents, 'visibilitychange');
now = acceptedAt + 300_001; document.hidden = false; fire(documentEvents, 'visibilitychange');
assert.equal(card(singleWait, studioPrimary, foregroundIdentity).track, false, 'foreground recomputes even when the hidden-page alarm was throttled');
const loaded = card({ ...singleWait, status: 'succeeded', phase: 'ready', label: '已完成', detail: undefined, recoveryAvailable: false }, studioPrimary, 'image-decoding', true);
assert.equal(loaded.title, '正在加载图片'); assert.equal(loaded.track, true); assert.equal(loaded.alerts.length, 0, 'real image loading remains separate from generation terminal state');
assert.equal(studioPrimary({ task: { ...task, status: 'running', delivery: { phase: 'recover', recoveryAvailable: true } } }) !== null, true,
  'the optional second callback argument preserves legacy recovery callers');

const readyWait: ImageGenerationWait = { ...singleWait, status: 'succeeded', phase: 'ready', resultReady: true, label: '已完成',
  detail: '状态暂未更新的旧提示', connectionIssue: true, connectionDetail: '旧查询提示' };
now = acceptedAt + 5_000;
card({ ...singleWait, waitingStatus: 'pending' }, studioPrimary, 'completion');
now = acceptedAt + 5_100;
const completing = card(readyWait, studioPrimary, 'completion', true);
assert.equal(completing.received.finishing, true); assert.equal(completing.alerts.length, 0); assert.equal(completing.buttons.length, 0);
assert.ok(completing.received.progress! < 100); assert.ok(completing.percent?.endsWith('%'));
const downloadButton = completing.allButtons.find(node => node.props['aria-label'] === '下载图片');
assert.ok(downloadButton); assert.ok(!downloadButton.props.disabled);
(downloadButton.props.onClick as () => void)(); assert.equal(downloads, 1, 'the real result is usable during the completion transition');
advance(acceptedAt + 5_400);
const full = card(readyWait, studioPrimary, 'completion', true);
assert.equal(full.percent, '100%'); assert.equal(full.received.finishing, true);
advance(acceptedAt + 5_480);
const done = card(readyWait, studioPrimary, 'completion', true);
assert.equal(done.received.finishing, undefined); assert.equal(done.received.label, '已完成'); assert.equal(done.alerts.length, 0);
assert.equal(card(readyWait, studioPrimary, 'completion', true).received.finishing, undefined, 'repeated result reads never restart completion');
assert.equal(card(readyWait, studioPrimary, 'historical-complete', true).received.finishing, undefined, 'a first-seen completed card does not animate');
const busyDone = card(readyWait, studioPrimary, 'completion', true, { downloadDisabled: true, downloadTemporarilyBusy: true });
assert.equal(busyDone.received.progress, 100); assert.equal(busyDone.received.finishing, undefined); assert.equal(busyDone.alerts.length, 0, 'another download cannot revive old polling errors');
const unavailable = card({ ...readyWait, detail: '原图不可用' }, studioPrimary, 'missing-output');
assert.equal(unavailable.received.progress, undefined); assert.equal(unavailable.received.finishing, undefined); assert.equal(unavailable.alerts.length, 1);
const denied = card({ ...readyWait, detail: '下载权限不可用' }, studioPrimary, 'denied-output', true, { downloadDisabled: true });
assert.equal(denied.received.progress, undefined); assert.equal(denied.received.finishing, undefined); assert.equal(denied.alerts.length, 1);
motion.matches = true; fire(motionEvents, 'change');
card(singleWait, studioPrimary, 'reduced-completion');
const reduced = card(readyWait, studioPrimary, 'reduced-completion', true);
assert.equal(reduced.received.finishing, undefined); assert.equal(reduced.received.progress, 100);
motion.matches = false; fire(motionEvents, 'change');
card(singleWait, studioPrimary, 'switching');
const oldFinish = card(readyWait, studioPrimary, 'switching', true);
assert.equal(oldFinish.received.finishing, true);
const oldAlarm = Array.from(timers.entries()).find(([, timer]) => timer.due === oldFinish.received.nextAnimationAt)?.[0];
assert.ok(oldAlarm);
const newTask = card({ ...singleWait, acceptedAt: now, createdAt: undefined }, studioPrimary, 'switching', false, { id: 'different-task' });
assert.equal(newTask.received.finishing, undefined); assert.equal(newTask.received.progress, 8); assert.equal(timers.has(oldAlarm), false, 'switching task cancels the old finish alarm');
const newAttempt = card({ ...singleWait, taskKey: 'new-batch-attempt', acceptedAt: now, createdAt: undefined }, studioPrimary, 'switching', false, { id: 'different-task' });
assert.equal(newAttempt.received.progress, 8); assert.equal(newAttempt.received.finishing, undefined, 'a new task in the same ordinal card resets local progress');
const alarmsBeforeUnmount = Array.from(timers.keys()); unmount('switching');
assert.ok(alarmsBeforeUnmount.some(id => !timers.has(id)), 'unmount removes the card alarm');
assert.equal(mappedWait(studioSource, { ...task, delivery: { ...task.delivery, receivedBytes: 50, expectedBytes: 100 } }).progress, 50,
  'actual single-task mapping prefers measured bytes when supplied');
assert.equal(mappedWait(batchSource, { ...task, status: 'succeeded', taskId: task.id, image: { id: 'asset', url: '/fixture-image' } }).resultReady, true);
assert.equal(mutations, 0);
console.log('Image generation wait lifecycle/composition offline contracts passed');
