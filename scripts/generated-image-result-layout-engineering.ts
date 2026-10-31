import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import postcss from 'postcss';
import ts from 'typescript';

type Props = Record<string, unknown>;
type Element = { type: unknown; props: Props };
const root = resolve(process.argv[2] || process.cwd());
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');
const resultsSource = read('src/components/GeneratedImageResults.tsx');
const statusSource = read('src/components/ImageResultStatusDetails.tsx');
const cssSource = read('src/components/GeneratedImageResults.module.css');
let slot = 0;
const slots: unknown[] = [];
const runtime = {
  useState(initial: unknown) {
    const index = slot++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    return [slots[index], (next: unknown) => { slots[index] = typeof next === 'function' ? (next as (old: unknown) => unknown)(slots[index]) : next; }];
  },
  useRef(initial: unknown) { const index = slot++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
  useCallback(callback: unknown) { return callback; },
  useEffect() {},
  useId() { return 'fixture-status'; },
};
const jsx = (type: unknown, props: Props): Element => ({ type, props });
const styleNames = new Proxy({}, { get: (_target, key) => String(key) });
function load(source: string, mocks: Record<string, unknown>) {
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
    jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const exports: Props = {};
  runInNewContext(output, { exports, require: (name: string) => {
    if (name === 'react') return runtime;
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: Symbol('fragment') };
    if (name.endsWith('.module.css')) return { __esModule: true, default: styleNames };
    assert.ok(name in mocks, `unexpected fixture dependency: ${name}`);
    return mocks[name];
  }, document: { body: {}, activeElement: null }, navigator: {}, crypto: { randomUUID: () => 'fixture-operation' }, URLSearchParams });
  return exports;
}
function render(component: unknown, props: Props) {
  assert.equal(typeof component, 'function');
  slots.length = 0;
  slot = 0;
  return (component as (value: Props) => Element)(props);
}
function nodes(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object' || !('type' in value) || !('props' in value)) return [];
  const element = value as Element;
  return [element, ...nodes(element.props.children)];
}
function byClass(value: unknown, name: string) {
  const node = nodes(value).find(item => String(item.props.className || '').split(' ').includes(name));
  assert.ok(node, `missing ${name}`);
  return node;
}

const CircleAlert = Symbol('circle-alert');
const Status = load(statusSource, {
  'react-dom': { createPortal: (value: unknown) => value },
  '@radix-ui/react-popper': { Root: Symbol('root'), Anchor: Symbol('anchor'), Content: Symbol('content') },
  'lucide-react': { CircleAlert }, './useDialogDismiss': { useDialogDismiss() {} },
}).ImageResultStatusDetails;
const reasonTrigger = nodes(render(Status, { detail: 'fixture', reason: true, active: true, scopeKey: 'reason' })).find(node => node.type === 'button')!;
assert.equal(reasonTrigger.props['aria-label'], '查看原因');
assert.equal(reasonTrigger.props['data-reason'], true);
assert.ok(nodes(reasonTrigger).some(node => node.type === CircleAlert));
assert.equal((reasonTrigger.props.children as Element).type, CircleAlert, 'the reason trigger contains only its icon');
const normalTrigger = nodes(render(Status, { detail: 'fixture', active: true, scopeKey: 'detail' })).find(node => node.type === 'button')!;
assert.equal(normalTrigger.props['aria-label'], '查看详情');
assert.equal(normalTrigger.props.children, '查看详情');

const IssueDetails = load(readFileSync(resolve('src/components/ImageResultIssueDetails.tsx'), 'utf8'), {
  'react-dom': { createPortal: (value: unknown) => value },
  '@radix-ui/react-popper': { Root: Symbol('root'), Anchor: Symbol('anchor'), Content: Symbol('content') },
  './useDialogDismiss': { useDialogDismiss() {} },
}).ImageResultIssueDetails;
const issueLabel = (actual: Props, requested: Props) => nodes(render(IssueDetails, { issue: { actual, requested, originalRetained: true } }))
  .find(node => node.type === 'button')!.props.children;
assert.equal(issueLabel({ width: 2048, height: 2048, format: 'png' }, { width: 2880, height: 2880, format: 'png' }), '实际 2048×2048，尺寸不符');
assert.equal(issueLabel({ width: 2048, height: 2048, format: 'jpeg' }, { width: 2048, height: 2048, format: 'png' }), '实际规格');
assert.equal(issueLabel({ width: 2048, height: 2048 }, { width: null, height: null }), '实际规格');

let pageOptions: Props | undefined;
const Waiting = Symbol('waiting');
const StatusDetails = Symbol('status-details');
const results = load(resultsSource, {
  'react-dom': { createPortal: (value: unknown) => value },
  'lucide-react': new Proxy({}, { get: () => () => null }),
  './ResultImageCover': { ResultImageCover: Symbol('cover') },
  './ZoomableImagePreview': { ZoomableImagePreview: Symbol('preview') },
  './content-reactions/ContentReactions': { __esModule: true, default: Symbol('reactions') },
  './LoadingState': { LoadingSkeleton: Symbol('skeleton'), LoadingStatus: Symbol('loading') },
  '@/lib/media/copy-image': { copyImage: async () => undefined },
  './useResultPages': { useResultPages: (options: Props) => {
    pageOptions = options;
    return { page: 1, pages: 1, pageItems: options.items, capacity: 3, gridRef: { current: null }, canNext: false, canLast: false,
      start: 0, restoring: false, navigationIssue: '', goToId() {}, retry() {}, reset() {}, previous() {}, next() {}, last() {} };
  } },
  './ImageGenerationWaiting': { ImageGenerationWaiting: Waiting },
  './useImageGenerationWaitDisplay': { useImageGenerationWaitDisplay: (value: Props | undefined) => value ? {
    label: '生成中', detail: '原任务返回异常', showIssue: true, showTrack: true, progress: 37, busy: true, pending: true,
  } : undefined },
  './ImageResultNextActions': { ImageResultNextActions: Symbol('next'), ImageResultNextActionFeedback: Symbol('next-feedback') },
  './useImageResultNextActions': { useImageResultNextActions: () => ({ canCutout: false, canVideo: false }) },
  './ResultImageContextMenu': { ResultImageContextMenu: Symbol('menu') },
  '@/lib/context/AppSessionContext': { useAppSession: () => ({ user: { id: 'fixture-user', role: 'admin' }, hasLoadedUser: true, sessionChanged: false }) },
  '@/lib/auth/client-session-boundary': { isClientSessionBlocked: () => false },
  '@/lib/media/image-preview-session': { prepareImagePreview: () => ({ release() {}, confirmOpen() {} }) },
  './TaskNotice': { TaskNotice: Symbol('notice') },
  './ImageResultOperationFeedback': { ImageResultOperationFeedback: Symbol('operation-feedback') },
  './ImageResultStatusDetails': { ImageResultStatusDetails: StatusDetails },
}).GeneratedImageResults;

function card(item: Props, options: Props = {}) {
  const intent = { id: 'completion', scopeKey: 'fixture-scope', revision: 2, targetId: String(item.id) };
  const list = render(results, { items: [item], scope: 'fixture-scope', compactInformation: true, navigationIntent: intent,
    coverDeleteWithContextActions: true, renderDelete: () => jsx('button', { 'data-delete': true }),
    renderActions: () => jsx('button', { 'data-specialty': true }),
    renderDeliveryAction: () => jsx('button', { 'data-delivery': true }), ...options });
  const child = nodes(list).find(node => typeof node.type === 'function' && (node.type as { name?: string }).name === 'GeneratedImageResultCard');
  assert.ok(child, 'result card remains a stable component boundary');
  return render(child.type, child.props);
}

const ready = card({ id: 'ready', completionTaskId: 'task-ready', label: '结果', status: '已完成', media: { src: '/fixture.png' }, download: () => undefined });
const readyArticle = nodes(ready).find(node => node.type === 'article')!;
assert.equal(readyArticle.props['data-result-ready'], '');
assert.equal(readyArticle.props['data-result-task-id'], 'task-ready');
const actions = byClass(ready, 'mediaActions');
const actionGroups = (Array.isArray(actions.props.children) ? actions.props.children : [actions.props.children]).filter(Boolean) as Element[];
assert.equal(actionGroups.at(-1)?.props.className, 'deliveryAction');
assert.ok(nodes(actionGroups.at(-1)).some(node => node.props['data-delivery']));

const pending = card({ id: 'pending', label: '处理中', status: '生成中', pending: true,
  generationWait: { status: 'running' }, error: '原任务返回异常' }, { renderDelete: undefined, renderActions: undefined, renderDeliveryAction: undefined });
const pendingArticle = nodes(pending).find(node => node.type === 'article')!;
assert.equal(pendingArticle.props['data-result-ready'], undefined);
assert.equal(pendingArticle.props['data-result-task-id'], 'pending');
const pendingMain = byClass(pending, 'pendingStatusMain');
const pendingChildren = (Array.isArray(pendingMain.props.children) ? pendingMain.props.children : [pendingMain.props.children]).filter(Boolean) as Element[];
assert.equal(pendingChildren[0].type, Waiting);
assert.equal(pendingChildren.at(-1)?.props.className, 'pendingStatusIssue');
assert.ok(nodes(pendingChildren.at(-1)).some(node => node.type === StatusDetails));
assert.equal(JSON.stringify(pageOptions?.navigationIntent), JSON.stringify({ id: 'completion', scopeKey: 'fixture-scope', revision: 2, targetId: 'pending' }));

const css = postcss.parse(cssSource);
function declarations(selector: string) {
  const matches: Record<string, string>[] = [];
  css.walkRules(rule => {
    if (!rule.selectors.includes(selector)) return;
    const values: Record<string, string> = {};
    rule.walkDecls(declaration => { values[declaration.prop] = declaration.value; });
    matches.push(values);
  });
  assert.ok(matches.length, `missing CSS rule ${selector}`);
  return matches;
}
const mainLayout = declarations('.pendingStatusMain')[0];
assert.equal(mainLayout.position, 'absolute'); assert.equal(mainLayout.top, '50%'); assert.equal(mainLayout.transform, 'translate(-50%, -50%)');
const issueLayout = declarations('.pendingStatusIssue')[0];
assert.equal(issueLayout.position, 'absolute'); assert.equal(issueLayout.top, 'calc(100% + 8px)');
const mediaLayout = declarations('.mediaActions')[0];
assert.equal(mediaLayout['flex-wrap'], 'wrap'); assert.equal(mediaLayout['overflow-x'], 'hidden');
const visibleDeliveryFailure = declarations('.card .mediaActions:has(button[data-state="failed"], button[data-state="unknown"])')[0];
assert.equal(visibleDeliveryFailure.opacity, '1'); assert.equal(visibleDeliveryFailure['pointer-events'], 'auto');
const square = declarations('.mediaActions[data-cover-context-delete] button')[0];
assert.equal(square.width, '35px'); assert.equal(square.flex, '0 0 35px');
assert.equal(declarations('.deliveryAction')[0].display, 'contents');
const icon = declarations('.mediaActions[data-cover-context-delete] button svg')[0];
assert.equal(icon.width, '17.5px'); assert.equal(icon.height, '17.5px');
assert.ok(declarations('.mediaActions[data-cover-context-delete] button').some(rule => rule.width === '44px' && rule['flex-basis'] === '44px'),
  'touch actions, including delivery, keep the shared 44px target');

process.stdout.write('generated image result layout engineering passed (DOM and parsed CSS contracts)\n');
