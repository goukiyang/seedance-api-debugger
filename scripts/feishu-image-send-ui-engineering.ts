import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

type Props = Record<string, any>;
type Element = { type: unknown; props: Props };
const source = readFileSync('src/components/image-studio/ImageFeishuStatus.tsx', 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
const pending = (state = 'pending', extra: Props = {}) => ({ version: 2, state, canSend: state === 'not_requested', canCancel: state === 'pending', canRetry: false,
  originalSent: state === 'sent', mode: state === 'not_requested' ? null : 'file', fileSize: 14_000_000, maxBytes: 30_000_000, source: state === 'not_requested' ? null : 'manual', reason: null, ...extra });
function nodes(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object' || !('type' in value) || !('props' in value)) return [];
  const element = value as Element; return [element, ...nodes(element.props.children)];
}
const text = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' && 'props' in value ? text((value as Element).props.children) : '';
class Harness {
  slots: any[] = []; index = 0; dirty = true; mounted = true; now = 100000; timerId = 0; effects: Array<() => void> = []; timers = new Map<number, { at: number; callback: () => unknown }>();
  listeners = new Map<string, Set<() => void>>(); changes = 0; calls: Array<{ url: string; method: string }> = []; dom: unknown; component: (props: Props) => unknown;
  session: Props = { hasLoadedUser: true, sessionChanged: false, user: { id: 'fixture-owner' } };
  props: Props = { owner: 'fixture-owner', taskId: 'fixture-task', onChanged: () => { this.changes++; } }; visibility = 'visible'; original: Props = pending('not_requested');
  respond: (url: string, init: Props) => Promise<Response> = async (url, init) => {
    if (!url.includes('intent=original')) return Response.json({ version: 1, state: 'failed', canCancel: false, canRetry: true, imageSent: false, explanationSent: false, mode: 'link' });
    if (init.method === 'POST') this.original = pending(); return Response.json(this.original);
  };
  constructor(initial?: Props) {
    if (initial) this.props.initial = initial;
    const runtime = {
      useState: (initial: unknown) => { const index = this.index++; if (!(index in this.slots)) this.slots[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
        return [this.slots[index], (next: unknown) => { const value = typeof next === 'function' ? (next as (old: unknown) => unknown)(this.slots[index]) : next; if (!Object.is(this.slots[index], value)) { this.slots[index] = value; if (this.mounted) this.dirty = true; } }]; },
      useRef: (initial: unknown) => { const index = this.index++; if (!(index in this.slots)) this.slots[index] = { current: initial }; return this.slots[index]; },
      useId: () => 'fixture-feedback',
      useCallback: (callback: unknown, deps: unknown[]) => { const index = this.index++, old = this.slots[index]; if (!old || !same(old.deps, deps)) this.slots[index] = { deps, callback }; return this.slots[index].callback; },
      useEffect: (effect: () => void | (() => void), deps: unknown[]) => { const index = this.index++, old = this.slots[index]; if (!old || !same(old.deps, deps)) this.effects.push(() => { old?.cleanup?.(); this.slots[index] = { deps, cleanup: effect() }; }); },
    };
    const jsx = (type: unknown, props: Props) => ({ type, props }), icons = Object.fromEntries(['Send','Check','CircleAlert','LoaderCircle','X'].map(name => [name, Symbol(name)]));
    const document = { body: {}, get visibilityState() { return harness.visibility; }, addEventListener: (type: string, fn: () => void) => { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type)!.add(fn); }, removeEventListener: (type: string, fn: () => void) => this.listeners.get(type)?.delete(fn) };
    const harness = this, exports: Props = {};
    runInNewContext(compiled, { exports, require: (name: string) => {
      if (name === 'react') return runtime;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === 'react-dom') return { createPortal: (value: unknown) => value };
      if (name === '@radix-ui/react-popper') return { Root: Symbol('root'), Anchor: Symbol('anchor'), Content: Symbol('content') };
      if (name === 'lucide-react') return icons;
      if (name === '@/components/useDialogDismiss') return { useDialogDismiss() {} };
      if (name === '@/lib/context/AppSessionContext') return { useAppSession: () => this.session };
      if (name === '@/lib/auth/client-session-boundary') return { isClientSessionBlocked: () => false };
      if (name === '@/lib/video/feishu-errors') return { videoFeishuErrorText: () => '当前无法发送' };
      if (name.endsWith('.module.css')) return { __esModule: true, default: new Proxy({}, { get: (_target, key) => String(key) }) };
      throw Error(`Unexpected UI fixture import ${name}`);
    }, document, Date: class extends Date { static now() { return harness.now; } }, AbortSignal, AbortController,
    fetch: (url: string, init: Props) => { this.calls.push({ url, method: init.method }); return this.respond(url, init); },
    setTimeout: (callback: () => unknown, delay: number) => { const id = ++this.timerId; this.timers.set(id, { at: this.now + delay, callback }); return id; }, clearTimeout: (id: number) => this.timers.delete(id) });
    this.component = exports.ImageFeishuStatus; this.render();
  }
  render() { if (!this.mounted) return; let passes = 0; do { assert.ok(passes++ < 30, 'fixture render settled'); this.dirty = false; this.index = 0; this.dom = this.component(this.props); for (const effect of this.effects.splice(0)) effect(); } while (this.dirty); }
  async settle() { for (let i = 0; i < 6; i++) { await new Promise<void>(resolve => setImmediate(resolve)); this.render(); } }
  button(label?: string) { const result = nodes(this.dom).find(node => node.type === 'button' && (label === undefined ? node.props.className === 'trigger' : text(node) === label)); assert.ok(result, `button ${label || 'trigger'}`); return result; }
  async click(label?: string) { this.button(label).props.onClick({ preventDefault() {}, stopPropagation() {} }); this.render(); await this.settle(); }
  async advance(ms: number) { this.now += ms; for (const [id, timer] of Array.from(this.timers).sort((a,b) => a[1].at - b[1].at)) if (timer.at <= this.now && this.timers.delete(id)) timer.callback(); await this.settle(); }
  content() { return nodes(this.dom).find(node => node.props.className === 'feedback' || node.props.className === 'details'); }
  posts() { return this.calls.filter(call => call.method === 'POST').length; }
  async hide() { this.visibility = 'hidden'; for (const listener of Array.from(this.listeners.get('visibilitychange') || [])) listener(); this.render(); await this.settle(); }
  unmount() { this.mounted = false; for (const value of this.slots) value?.cleanup?.(); }
}
const same = (a: unknown[], b: unknown[]) => a?.length === b?.length && a.every((item, index) => Object.is(item, b[index]));
async function main() {
  let cases = 0;
  const first = new Harness(); await first.click(); assert.equal(first.posts(), 1); assert.equal(first.calls.length, 2); assert.ok(first.calls.every(call => call.url.includes('intent=original')));
  assert.ok(text(first.dom).includes('正在发送原图附件…')); assert.ok(!nodes(first.dom).some(node => node.props.role === 'dialog')); assert.ok(!text(first.dom).includes('30MB'));
  await first.click(); assert.equal(first.posts(), 1); cases++;
  first.original = pending('sent'); await first.advance(2000); assert.ok(text(first.dom).includes('已发送到飞书')); assert.equal(first.button().props['aria-label'], '原图已发送');
  await first.advance(1000); first.content()!.props.onMouseEnter(); first.render(); await first.advance(10000); assert.ok(first.content());
  first.content()!.props.onMouseLeave(); first.render(); await first.advance(1999); assert.ok(first.content()); await first.advance(1); assert.equal(first.content(), undefined); cases++;
  first.props = { ...first.props, initial: { version: 1, state: 'failed', original: pending('sent') } }; first.dirty = true; first.render(); assert.equal(first.content(), undefined); assert.equal(first.button().props.title, '原图已发送');
  await first.click(); assert.ok(text(first.dom).includes('这张原图已发送')); assert.equal(first.posts(), 1); first.content()!.props.onFocusCapture(); first.render(); await first.advance(5000); assert.ok(first.content()); first.unmount(); cases++;

  const timeout = new Harness(); let rejected = false;
  timeout.respond = async (_url, init) => { if (init.method === 'POST') { rejected = true; throw Error('fixture timeout'); } return Response.json(timeout.original); };
  await timeout.click(); assert.equal(rejected, true); assert.equal(timeout.posts(), 1); assert.ok(text(timeout.dom).includes('暂未确认是否送达'));
  await timeout.click(); assert.equal(timeout.posts(), 1); assert.equal(timeout.button().props.title, '原图发送待核对');
  timeout.original = pending('unknown'); await timeout.click(); assert.equal(timeout.posts(), 1); await timeout.click('查看状态'); assert.ok(!nodes(timeout.dom).some(node => text(node) === '重试发送')); timeout.unmount(); cases++;

  const bounded = new Harness(); await bounded.click(); for (let i = 0; i < 30; i++) await bounded.advance(2000);
  const atLimit = bounded.calls.length; await bounded.advance(10000); assert.equal(bounded.calls.length, atLimit); assert.equal(bounded.posts(), 1); assert.equal(bounded.changes, 1, 'pending observation does not refresh every old task/notification in the parent list');
  assert.equal(bounded.button().props.title, '原图发送中'); assert.ok(!text(bounded.dom).includes('发送未完成')); bounded.unmount(); cases++;
  const deadline = new Harness(); await deadline.click(); let deadlineSignal: AbortSignal | undefined, resolveDeadline: (response: Response) => void = () => {};
  deadline.respond = async (_url, init) => { deadlineSignal = init.signal; return new Promise<Response>(resolve => { resolveDeadline = resolve; }); };
  await deadline.advance(58000); assert.equal(deadlineSignal?.aborted, false); await deadline.advance(2000); assert.equal(deadlineSignal?.aborted, true);
  resolveDeadline(Response.json(pending())); await deadline.settle(); assert.equal(deadline.posts(), 1); assert.equal(deadline.button().props.title, '原图发送中'); deadline.unmount();
  const hidden = new Harness(); await hidden.click(); await hidden.hide(); const atHide = hidden.calls.length; await hidden.advance(10000); assert.equal(hidden.calls.length, atHide); hidden.unmount(); cases++;
  const removed = new Harness(); await removed.click(); const atUnmount = removed.calls.length; removed.unmount(); await removed.advance(10000); assert.equal(removed.calls.length, atUnmount); cases++;

  const late = new Harness(); let resolveLate: (response: Response) => void = () => {};
  late.respond = async () => new Promise<Response>(resolve => { resolveLate = resolve; }); late.button().props.onClick({ preventDefault() {}, stopPropagation() {} }); late.render();
  late.props = { ...late.props, taskId: 'different-task' }; late.dirty = true; late.render(); resolveLate(Response.json(pending())); await late.settle();
  assert.equal(late.posts(), 0); assert.equal(late.button().props.title, '发送原图到飞书'); assert.equal(late.content(), undefined); late.unmount(); cases++;
  const switched = new Harness(); let resolveAccount: (response: Response) => void = () => {};
  switched.respond = async () => new Promise<Response>(resolve => { resolveAccount = resolve; }); switched.button().props.onClick({ preventDefault() {}, stopPropagation() {} }); switched.render();
  switched.session = { ...switched.session, user: { id: 'another-owner' } }; switched.dirty = true; switched.render(); resolveAccount(Response.json(pending('not_requested'))); await switched.settle(); assert.equal(switched.posts(), 0); assert.equal(switched.dom, null); switched.unmount(); cases++;

  const detail = new Harness(); await detail.click(); await detail.click('详情'); assert.ok(nodes(detail.dom).some(node => node.props.role === 'dialog'));
  assert.equal(detail.calls.filter(call => !call.url.includes('intent=original')).length, 0); await detail.click('通知记录'); assert.equal(detail.calls.filter(call => !call.url.includes('intent=original')).length, 1);
  assert.ok(text(detail.dom).includes('继续通知')); detail.unmount(); cases++;
  const limit = new Harness(); limit.original = pending('not_requested', { canSend: false, reason: 'image_original_too_large' }); await limit.click(); assert.equal(limit.posts(), 0); assert.ok(text(limit.dom).includes('30MB')); assert.ok(!nodes(limit.dom).some(node => node.props.role === 'dialog')); limit.unmount(); cases++;
  const partial = new Harness(); partial.original = pending('sent_navigation_unknown', { originalSent: true, canSend: false, canCancel: false, reason: 'navigation_receipt_unknown' });
  await partial.click(); assert.equal(partial.posts(), 0); assert.equal(partial.button().props.title, '原图已发送，入口待核对');
  assert.ok(text(partial.dom).includes('原图已发送，入口待核对')); assert.ok(!text(partial.dom).includes('已发送到飞书'));
  await partial.click('查看状态'); assert.ok(!nodes(partial.dom).some(node => text(node) === '重试发送')); partial.unmount(); cases++;
  const candidate = new Harness(); candidate.props.presentationLabel = '候选整图'; candidate.dirty = true; candidate.render();
  assert.equal(candidate.button().props.title, '发送候选整图到飞书'); await candidate.click(); assert.ok(text(candidate.dom).includes('候选整图 · 正在发送原图附件…')); candidate.unmount(); cases++;
  console.log(JSON.stringify({ passed: true, cases, actualComponent: true, fakeTimers: true, externalRequests: 0, productionWrites: 0 }));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
