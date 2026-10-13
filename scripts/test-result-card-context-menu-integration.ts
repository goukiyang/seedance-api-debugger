import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Offline composition/event contracts. Real React rendering, Radix positioning,
// browser gestures and business APIs remain outside this fixture's evidence.
type Props = Record<string, unknown>;
type Element = { type: unknown; props: Props; key?: string };
type Command = { id: string; group: string; disabled?: boolean; transferFocus?: boolean; onSelect: () => void };
type Controller = { open: (intent: string) => Promise<void>; busy: string | null; message: string; destination: string;
  canCutout: boolean; canVideo: boolean; cutoutDisabledReason: string; videoDisabledReason: string };
const root = resolve(process.argv[2] || process.cwd());
const resultSource = readFileSync(resolve(root, 'src/components/GeneratedImageResults.tsx'), 'utf8');
const coverSource = readFileSync(resolve(root, 'src/components/ResultImageCover.tsx'), 'utf8');
const studioSource = readFileSync(resolve(root, 'src/app/image-studio/studio.tsx'), 'utf8');
const cssSource = readFileSync(resolve(root, 'src/components/GeneratedImageResults.module.css'), 'utf8');
const session = { user: { id: 'fixture-account', role: 'admin' }, sessionChanged: false };
let sessionBlocked = false;
let slots: unknown[] = [], slot = 0;
const frames = new Map<string, unknown[]>();
const commands: string[] = [];
const hookCalls: Props[] = [];
const timers = new Map<number, () => void>();
let timerSequence = 0;
const runtime = {
  useState(initial: unknown) {
    const index = slot++, owned = slots;
    if (!(index in owned)) owned[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    return [owned[index], (next: unknown) => { owned[index] = typeof next === 'function' ? (next as (old: unknown) => unknown)(owned[index]) : next; }];
  },
  useRef(initial: unknown) { const index = slot++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
  useCallback(callback: unknown) { return callback; },
  useEffect() {},
  forwardRef(render: (props: Props, ref: unknown) => Element) {
    return (props: Props) => render(props, props.ref || null);
  },
};
const jsx = (type: unknown, props: Props, key?: string): Element => ({ type, props, key });
const Menu = Symbol('context-menu'), Feedback = Symbol('next-feedback'), LegacyNext = Symbol('legacy-next');
const Reactions = Symbol('reactions'), Preview = Symbol('preview');
const styleNames = new Proxy({}, { get: (_target, name) => String(name) });
const Icon = () => null;
function controllerHook(options: Props) {
  hookCalls.push(options);
  const holder = runtime.useRef(null) as { current: Controller | null };
  if (!holder.current) holder.current = {
    open: async intent => { if (options.enabled) { commands.push(intent); holder.current!.busy = intent; holder.current!.message = '正在导入'; } },
    busy: null, message: '', destination: '', canCutout: Boolean(options.enabled), canVideo: Boolean(options.enabled),
    cutoutDisabledReason: '', videoDisabledReason: '',
  };
  return holder.current;
}
function load(source: string, mocks: Record<string, unknown>, extra: Props = {}) {
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
    jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const exports: Props = {};
  runInNewContext(output, { exports, require: (name: string) => {
    if (name === 'react') return runtime;
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: Symbol('fragment') };
    if (name === 'lucide-react') return new Proxy({}, { get: () => Icon });
    if (name.endsWith('.module.css')) return { __esModule: true, default: styleNames };
    assert.ok(name in mocks, `unexpected fixture dependency: ${name}`); return mocks[name];
  }, setTimeout: (callback: () => void) => { const id = ++timerSequence; timers.set(id, callback); return id; },
  clearTimeout: (id: number) => timers.delete(id), ...extra });
  return exports;
}
function render(component: unknown, props: Props, identity: string): Element {
  assert.equal(typeof component, 'function');
  slots = frames.get(identity) || []; frames.set(identity, slots); slot = 0;
  return (component as (props: Props) => Element)(props);
}
function nodes(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object' || !('type' in value) || !('props' in value)) return [];
  const element = value as Element;
  return [element, ...nodes(element.props.children)];
}
function find(value: unknown, type: unknown): Element {
  const node = nodes(value).find(entry => entry.type === type); assert.ok(node, `missing fixture element: ${String(type)}`); return node;
}
function invoke(node: Element, handler: string, event: unknown) { (node.props[handler] as (event: unknown) => void)(event); }
function event(extra: Props = {}) {
  return { button: 0, detail: 1, ctrlKey: false, pointerType: 'mouse', defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() {},
    currentTarget: { querySelector: () => ({ complete: true, naturalWidth: 10 }) }, ...extra };
}
function flushTimers() { const pending = Array.from(timers.values()); timers.clear(); pending.forEach(callback => callback()); }
const Cover = load(coverSource, {}).ResultImageCover;
const results = load(resultSource, {
  'react-dom': { createPortal: (content: unknown) => content }, './ResultImageCover': { ResultImageCover: Cover },
  './ZoomableImagePreview': { ZoomableImagePreview: Preview }, './content-reactions/ContentReactions': { __esModule: true, default: Reactions },
  './LoadingState': { LoadingSkeleton: Symbol('skeleton'), LoadingStatus: Symbol('loading') },
  '@/lib/media/copy-image': { copyImage: async () => { commands.push('copy'); } },
  './useResultPages': { useResultPages: (options: Props) => ({ page: 1, pages: 1, pageItems: options.items, capacity: 3, gridRef: { current: null },
    goToId() {}, retry() {}, reset() {}, previous() {}, next() {}, last() {} }) },
  './ImageBillingBadge': { ImageBillingBadge: Symbol('billing') }, './ImageGenerationWaiting': { ImageGenerationWaiting: Symbol('waiting') },
  './ImageResultNextActions': { ImageResultNextActions: LegacyNext, ImageResultNextActionFeedback: Feedback },
  './useImageResultNextActions': { useImageResultNextActions: controllerHook }, './ResultImageContextMenu': { ResultImageContextMenu: Menu },
  '@/lib/context/AppSessionContext': { useAppSession: () => session },
  '@/lib/auth/client-session-boundary': { isClientSessionBlocked: () => sessionBlocked },
});
const image = { id: 'fixture-result', label: 'fixture', status: '已完成', media: { src: '/fixture-original', contentKey: 'asset:fixture-original' },
  download: () => { commands.push('download'); } };
const extraActions = [{ id: 'restore', group: 'continue', onSelect: () => commands.push('restore') },
  { id: 'context', group: 'manage', onSelect: () => commands.push('context') },
  { id: 'delete', group: 'danger', transferFocus: true, onSelect: () => commands.push('delete-dialog') }];
function card(options: Props = {}, identity = `case-${frames.size}`) {
  const props: Props = { items: [image], scope: 'sd2-image-studio-result-page:fixture', contextActions: () => extraActions,
    renderDelete: () => jsx('button', { 'data-old-delete': true }), renderActions: () => jsx('button', { 'data-shortcut': true }),
    renderPrimaryActions: () => jsx('button', { 'data-recovery': true }), renderMetadata: () => jsx('p', { 'data-metadata': true }),
    renderReactionAction: () => 'pin-control', ...options };
  const list = render(results.GeneratedImageResults, props, `${identity}-list`);
  const child = nodes(list).find(entry => typeof entry.type === 'function' && (entry.type as { name: string }).name === 'GeneratedImageResultCard');
  assert.ok(child, 'hooks belong to a stable card component, never the map callback');
  return { tree: render(child.type, child.props, identity), rerender: () => render(child.type, child.props, identity), child, list };
}

async function run() {
  const ordinary = card();
  assert.equal(nodes(ordinary.tree).some(node => node.type === Menu), false, 'default callers have no custom menu');
  find(ordinary.tree, LegacyNext); assert.ok(nodes(ordinary.tree).some(node => node.props['data-old-delete']));
  assert.equal(find(ordinary.tree, Cover).props.contextMenuEnabled, false);
  assert.equal(hookCalls.at(-1)?.enabled, false, 'the inactive menu controller cannot send a handoff');
  for (const scope of ['sd2-image-studio-result-page:fixture', 'sd2-image-studio-liked-result-page:fixture']) {
    const target = card({ contextActionsEnabled: true, scope });
    const menu = find(target.tree, Menu), items = menu.props.items as Command[];
    assert.equal(find(target.tree, Cover).props.contextMenuEnabled, true);
    assert.deepEqual(Array.from(items, item => item.id), ['view', 'download', 'copy', 'restore', 'cutout', 'video', 'context', 'delete']);
    assert.equal(nodes(target.tree).some(node => node.type === LegacyNext || node.props['data-old-delete']), false);
    assert.ok(nodes(target.tree).some(node => node.props['data-shortcut']));
    assert.ok(nodes(target.tree).some(node => node.props['data-recovery']));
    assert.ok(nodes(target.tree).some(node => node.props['data-metadata']));
    const reaction = find(target.tree, Reactions);
    assert.equal(reaction.props.contentKey, image.media.contentKey); assert.equal(reaction.props.secondaryAction, 'pin-control');
    assert.equal(reaction.props.overlay, false); assert.equal(reaction.props.parentControlled, false);
    const media = find(target.tree, 'article').props.children as Element[];
    assert.ok(nodes(media[0]).some(node => node.type === Menu));
    assert.equal(nodes(menu.props.children).some(node => node.type === Feedback), false, 'feedback stays outside the closing menu');
    const before = find(target.tree, Feedback).props.controller;
    items.find(item => item.id === 'video')!.onSelect(); invoke(menu, 'onOpenChange', false);
    const after = target.rerender(); assert.equal(find(after, Feedback).props.controller, before, 'closing the menu preserves the controller');
    assert.equal((before as Controller).message, '正在导入');
    assert.equal(hookCalls.at(-1)?.enabled, true);
  }
  for (const protectedImage of [{ ...image, viewOnly: true }, { ...image, media: { ...image.media, previewOnly: true } }]) {
    const target = card({ contextActionsEnabled: true, items: [protectedImage] });
    assert.deepEqual(Array.from(find(target.tree, Menu).props.items as Command[], item => item.id), ['view']);
    assert.equal(nodes(target.tree).some(node => node.props['aria-label'] === '复制图片' || node.props['aria-label'] === '下载图片' || node.props['data-shortcut']), false);
    assert.equal(hookCalls.at(-1)?.enabled, false);
  }
  const empty = card({ contextActionsEnabled: true, items: [{ id: 'empty', label: 'failed', status: '未能交付图片' }],
    contextActions: () => extraActions.filter(item => item.group !== 'continue') });
  assert.deepEqual(Array.from(find(empty.tree, Menu).props.items as Command[], item => item.id), ['context', 'delete']);
  assert.equal(hookCalls.at(-1)?.enabled, false); assert.equal((find(empty.tree, Menu).props.children as Element).props.tabIndex, 0);
  const guarded = card({ contextActionsEnabled: true }); const firstIdentity = find(guarded.tree, Menu).props.identity as string;
  assert.deepEqual(JSON.parse(firstIdentity), ['sd2-image-studio-result-page:fixture', session.user.id, image.id, image.media.contentKey]);
  session.user.id = 'fixture-other'; assert.notEqual(find(guarded.rerender(), Menu).props.identity, firstIdentity);
  session.sessionChanged = true; assert.equal(find(guarded.rerender(), Menu).props.active, false);
  session.sessionChanged = false; sessionBlocked = true; assert.equal(find(guarded.rerender(), Menu).props.active, false);
  sessionBlocked = false;

  const triggerEvents: Array<[string, Props]> = [['onContextMenu', { button: 2 }], ['onPointerDown', { pointerType: 'touch' }],
    ['onPointerDownCapture', { ctrlKey: true }], ['onKeyDown', { key: 'ContextMenu' }], ['onKeyDown', { key: 'F10', shiftKey: true }]];
  let nonTargetPreviews = 0;
  const defaultCover = render(Cover, { src: '/fixture-default', alt: 'fixture', selected: false, applied: false,
    onSelect() {}, onQuickUse() {}, onPreview: () => nonTargetPreviews++ }, 'default-cover');
  for (const [handler, extras] of triggerEvents) {
    invoke(defaultCover, 'onClick', event()); const previous = nonTargetPreviews;
    invoke(defaultCover, handler, event(extras)); flushTimers();
    assert.equal(nonTargetPreviews, previous + 1, `default non-target ${handler} preserves its existing delayed preview`);
  }
  let previews = 0, quickUses = 0, selections = 0, viewed = 0;
  const cancel = { current: null as (() => void) | null }, buttonRef = { current: null };
  const coverProps: Props = { src: '/fixture', alt: 'fixture', selected: false, applied: false, ref: buttonRef,
    style: { color: 'inherit' }, 'data-state': 'closed', 'aria-describedby': 'fixture-menu', contextMenuEnabled: true, cancelPreviewRef: cancel,
    onSelect: () => selections++, onPreview: () => previews++, onQuickUse: () => quickUses++, onViewed: () => viewed++ };
  const cover = () => render(Cover, coverProps, 'cover-gestures');
  let button = cover(); assert.equal(button.type, 'button'); assert.equal(button.props.ref, buttonRef);
  assert.equal(button.props['data-state'], 'closed'); assert.equal(button.props['aria-describedby'], 'fixture-menu');
  assert.deepEqual(button.props.style, coverProps.style);
  invoke(button, 'onClick', event()); assert.equal(previews, 0); flushTimers(); assert.equal(previews, 1);
  assert.equal(selections, 1); assert.equal(viewed, 1);
  for (const [handler, extras] of triggerEvents) {
    invoke(button, 'onClick', event()); const oldPreviews: number = previews;
    invoke(button, handler, event(extras)); flushTimers(); assert.equal(previews, oldPreviews, `${handler} must cancel the 500ms preview`);
  }
  let canceledBeforeForward = false;
  coverProps.onContextMenu = (input: ReturnType<typeof event>) => { canceledBeforeForward = timers.size === 0; assert.equal(input.defaultPrevented, false, 'Radix must receive an uncanceled contextmenu'); };
  button = cover(); invoke(button, 'onClick', event()); invoke(button, 'onContextMenu', event({ button: 2 })); assert.equal(canceledBeforeForward, true);
  coverProps.onClickCapture = (input: ReturnType<typeof event>) => input.preventDefault(); button = cover();
  const release = event(); invoke(button, 'onClickCapture', release); invoke(button, 'onClick', release);
  flushTimers(); assert.equal(previews, 1, 'a consumed release cannot preview');
  delete coverProps.onClickCapture;
  button = cover(); invoke(button, 'onClick', event()); invoke(button, 'onDoubleClick', event({ detail: 2 })); flushTimers();
  assert.equal(quickUses, 1); assert.equal(previews, 1, 'ordinary double-click keeps quick use without a delayed preview');
  invoke(button, 'onClick', event()); cancel.current?.(); flushTimers(); assert.equal(previews, 1, 'menu-open fallback immediately cancels preview');
  const imageNode = find(button, 'img'); invoke(imageNode, 'onError', event()); button = cover();
  assert.equal(button.type, 'button'); assert.equal(button.props.ref, buttonRef); assert.equal(button.props['data-state'], 'closed');
  for (const name of ['onContextMenu', 'onKeyDown', 'onPointerDown', 'onPointerMove', 'onPointerUp', 'onPointerCancel',
    'onPointerDownCapture', 'onPointerMoveCapture', 'onPointerUpCapture', 'onPointerCancelCapture', 'onClickCapture', 'onDoubleClickCapture']) assert.equal(typeof button.props[name], 'function', `failed cover forwards ${name}`);

  const sourceFile = ts.createSourceFile('studio.tsx', studioSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions = new Map<string, string>(); let pageActions = '';
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(sourceFile));
    if (ts.isJsxAttribute(node) && node.name.getText(sourceFile) === 'contextActions' && node.initializer && ts.isJsxExpression(node.initializer)) pageActions = node.initializer.expression?.getText(sourceFile) || '';
    ts.forEachChild(node, visit);
  }
  visit(sourceFile); assert.ok(pageActions);
  let deleteDialog = '', confirms = 0, restored = 0;
  const environment: Props = { isAdmin: true, userId: 'fixture-account', deleting: false, downloadBusy: false, copyFeedback: null,
    unpersistedDraft: true, moduleContext: 'draft', savedModuleContext: 'saved', fixedDirty: false, dirty: false, automaticDirty: false,
    setDeleteError: () => {}, setDeleteTarget: (task: { id: string }) => { deleteDialog = task.id; },
    confirm: async () => { confirms++; return false; }, restoreTask: () => { restored++; return null; }, setError: () => {},
    restoreDisabledReason: () => '', copyTaskContext: () => commands.push('context'), RotateCcw: Icon, ClipboardList: Icon, Trash2: Icon };
  const callbacks = load(`${functions.get('studioTaskHasDeliveredAsset')}\n${functions.get('requestResultDelete')}\n${functions.get('restoreResultSettings')}\nexport const actions = ${pageActions};\nexport { restoreResultSettings };`, {}, environment);
  const own = { id: 'fixture-owned-task', status: 'succeeded', owner: { id: 'fixture-account' }, asset: { original_url: '/fixture' }, snapshot: { sourceAvailable: true } };
  const actions = (callbacks.actions as (item: Props) => Command[])({ task: own });
  const deletion = actions.find(item => item.id === 'delete')!; assert.equal(deletion.transferFocus, true);
  deletion.onSelect(); assert.equal(deleteDialog, own.id, 'menu selection only opens the original confirmation');
  assert.doesNotMatch(functions.get('requestResultDelete')!, /fetch\s*\(|deleteResult\s*\(/);
  await (callbacks.restoreResultSettings as (task: unknown) => Promise<void>)(own);
  assert.equal(confirms, 1); assert.equal(restored, 0, 'canceling the original unsaved confirmation does not restore');
  assert.doesNotMatch(functions.get('restoreTask')!, /\bsetImages\s*\(/, 'restoring settings preserves the current main image');
  assert.equal((callbacks.actions as (item: Props) => Command[])({ task: { ...own, owner: { id: 'other' } } }).length, 0);
  assert.match(studioSource, /contextActionsEnabled=\{templateWorkbench\}/);
  assert.equal((studioSource.match(/<ResultImageContextMenuHint\s*\/>/g) || []).length, 1);
  assert.match(studioSource, /autoFocus disabled=\{deleting\} onClick=\{\(\) => setDeleteTarget\(null\)\}>取消/);
  assert.match(studioSource, /renderReactionAction=\{templateWorkbench \? item => item\.task\?\.asset\?\.id\s*\? <StudioResultPinButton userId=\{userId\} moduleId=\{module\.id\} taskId=\{item\.task\.id\} assetId=\{item\.task\.asset\.id\} state=\{visibleFeed\?\.pinState \|\| null\} onSaved=\{refreshResults\} \/>\s*: item\.sharedPin \? <StudioResultPinnedIndicator \/> : null : undefined\}/);
  assert.match(cssSource, /\.coverReactions button\[data-reaction-action="like"\]:not\(\[aria-pressed="true"\]\):not\(\[data-bloom\]\)/);
  assert.match(resultSource, /contextActionsEnabled = false/);
  assert.doesNotMatch(resultSource, /pageItems\.map\([^]*?useImageResultNextActions/, 'map callbacks contain no hooks');
  console.log('Result card menu offline integration contracts complete');
}
void run().catch(cause => { console.error(cause); process.exitCode = 1; });
