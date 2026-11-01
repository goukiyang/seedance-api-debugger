import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import type { ModuleCoverDTO, ModuleCoverEditorState } from '../src/lib/image-studio/module-cover-types';

// Executes the actual component with controlled hooks/fetch and a virtual JSX tree.
// This verifies lifecycle/key/src contracts, not real React DOM reuse or HTTP GET counts.
type Props = Record<string, unknown>;
type Component = (props: Props) => View;
type View = { type: unknown; key: string | null; props: Props };
type Slot = { kind: 'state'; value: unknown } | { kind: 'ref'; value: { current: unknown } }
  | { kind: 'callback'; value: (...args: unknown[]) => unknown; deps: unknown[] }
  | { kind: 'effect'; deps: unknown[]; cleanup?: () => void; pending?: () => void | (() => void) };
const sameDeps = (left: unknown[], right: unknown[]) => left.length === right.length && left.every((value, index) => Object.is(value, right[index]));

class Hooks {
  private slots: Slot[] = [];
  private cursor = 0;
  private pending = true;
  private mounted = true;
  result: View | null = null;
  constructor(private component: Component, private props: Props, private activate: (hooks: Hooks) => void) {}
  useState = (initial: unknown) => {
    const index = this.cursor++;
    if (!this.slots[index]) this.slots[index] = { kind: 'state', value: typeof initial === 'function' ? (initial as () => unknown)() : initial };
    const slot = this.slots[index] as Extract<Slot, { kind: 'state' }>;
    return [slot.value, (next: unknown) => {
      const value = typeof next === 'function' ? (next as (old: unknown) => unknown)(slot.value) : next;
      if (!Object.is(value, slot.value)) { slot.value = value; this.pending = true; }
    }];
  };
  useRef = (initial: unknown) => {
    const index = this.cursor++;
    if (!this.slots[index]) this.slots[index] = { kind: 'ref', value: { current: initial } };
    return (this.slots[index] as Extract<Slot, { kind: 'ref' }>).value;
  };
  useCallback = (callback: (...args: unknown[]) => unknown, deps: unknown[]) => {
    const index = this.cursor++, previous = this.slots[index] as Extract<Slot, { kind: 'callback' }> | undefined;
    if (!previous || !sameDeps(previous.deps, deps)) this.slots[index] = { kind: 'callback', value: callback, deps };
    return (this.slots[index] as Extract<Slot, { kind: 'callback' }>).value;
  };
  useEffect = (effect: () => void | (() => void), deps: unknown[]) => {
    const index = this.cursor++, previous = this.slots[index] as Extract<Slot, { kind: 'effect' }> | undefined;
    if (!previous) this.slots[index] = { kind: 'effect', deps, pending: effect };
    else if (!sameDeps(previous.deps, deps)) { previous.deps = deps; previous.pending = effect; }
  };
  setProps(props: Props) { this.props = props; this.invalidate(); }
  invalidate() { this.pending = true; }
  async flush() {
    for (let round = 0; round < 30; round++) {
      await Promise.resolve();
      if (!this.pending || !this.mounted) continue;
      this.pending = false; this.cursor = 0; this.activate(this);
      this.result = this.component(this.props);
      for (const slot of this.slots) {
        if (slot.kind !== 'effect' || !slot.pending) continue;
        slot.cleanup?.(); const effect = slot.pending; slot.pending = undefined;
        slot.cleanup = effect() || undefined;
      }
    }
    assert.ok(!this.pending || !this.mounted, 'Controlled component must settle');
  }
  unmount() {
    for (const slot of this.slots) if (slot.kind === 'effect') slot.cleanup?.();
    this.mounted = false; this.result = null;
  }
}

type Request = {
  url: string; init: { cache: string };
  respond(status: number, payload: unknown, invalidJSON?: boolean): void;
  reject(error: Error): void;
};
const sourcePath = 'src/components/ModuleCoverEditor.tsx';
const source = readFileSync(sourcePath, 'utf8');
const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const executable = ast.statements.filter(statement => !ts.isImportDeclaration(statement)
  && !(ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression))).map(statement => statement.getText(ast)).join('\n');
const compiled = ts.transpileModule(`${executable}\nexports.__CurrentCover = CurrentCover;\nexports.__CropSlot = CropSlot;`, { compilerOptions: {
  target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React,
} }).outputText;
const cover = (changes: Partial<ModuleCoverDTO> = {}): ModuleCoverDTO => ({
  target: { kind: 'module', id: 'module-a' }, revision: 7, available: true,
  thumbnailUrl: '/fixture/module-a/cover?revision=7&size=640', imageUrl: '/fixture/module-a/cover?revision=7&size=1280',
  width: 1280, height: 1280, updatedAt: '2026-11-01T00:00:00.000Z', ...changes,
});
const editorState = (fixedCover: ModuleCoverDTO | null = cover(), changes: Partial<ModuleCoverEditorState> = {}): ModuleCoverEditorState => ({
  target: { kind: 'module', id: 'module-a' }, revision: 7, fixedCover, canManage: false, recipe: null, sources: [], ...changes,
});

function nodes(value: unknown, path = 'root'): Array<{ node: View; path: string }> {
  if (Array.isArray(value)) return value.flatMap((child, index) => nodes(child, `${path}.${index}`));
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const node = value as View;
  return [{ node, path }, ...nodes(node.props.children, `${path}.children`)];
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join('');
  if (value && typeof value === 'object' && 'props' in value) return text((value as View).props.children);
  return typeof value === 'string' ? value : '';
}

class Fixture {
  session = { user: { id: 'viewer-a' }, sessionChanged: false };
  blocked = false;
  requests: Request[] = [];
  props: Props;
  hooks: Hooks;
  private child?: { key: string | null; hooks: Hooks };
  private currentCover: Component;
  constructor(initialFixedCover: ModuleCoverDTO | null | undefined = cover()) {
    let active: Hooks;
    const activate = (hooks: Hooks) => { active = hooks; };
    const exports = {} as { ModuleCoverEditor: Component; __CurrentCover: Component; __CropSlot: Component };
    const sandbox = {
      exports, Error, AbortController,
      React: { Fragment: 'fragment', createElement: (type: unknown, props: Props | null, ...children: unknown[]) => ({ type, key: props?.key ?? null, props: { ...props, children } }) },
      createPortal: (element: View) => element,
      useState: (initial: unknown) => active.useState(initial),
      useRef: (initial: unknown) => active.useRef(initial),
      useCallback: (callback: (...args: unknown[]) => unknown, deps: unknown[]) => active.useCallback(callback, deps),
      useEffect: (effect: () => void | (() => void), deps: unknown[]) => active.useEffect(effect, deps),
      useAppSession: () => this.session, isClientSessionBlocked: () => this.blocked,
      useProductDialog: () => ({ confirm: async () => true, productDialog: null }),
      useUnsavedNavigation: () => undefined, useDialogDismiss: () => undefined,
      MODULE_COVER_OUTPUT: { width: 1280, height: 1280 },
      styles: new Proxy({}, { get: (_target, property) => String(property) }), document: { body: {} },
      Cropper: 'cropper', UploadedImagePicker: 'picker', ArrowLeftRight: 'swap', ImagePlus: 'image', RotateCcw: 'reset', Save: 'save', X: 'close',
      fetch: (url: string, init: { cache: string }) => new Promise((resolve, reject) => {
        this.requests.push({ url, init, reject, respond(status, payload, invalidJSON) {
          resolve({ status, ok: status >= 200 && status < 300, json: async () => { if (invalidJSON) throw new SyntaxError('invalid fixture JSON'); return payload; } });
        } });
      }),
    };
    vm.runInNewContext(compiled, sandbox, { filename: 'ModuleCoverEditor.fixture.js', timeout: 1000 });
    assert.equal(typeof exports.ModuleCoverEditor, 'function'); assert.equal(typeof exports.__CurrentCover, 'function');
    this.currentCover = exports.__CurrentCover;
    this.props = { userId: 'viewer-a', moduleId: 'module-a', moduleName: 'Module A', initialFixedCover, onClose: () => undefined, onSaved: () => undefined };
    this.hooks = new Hooks(exports.ModuleCoverEditor, this.props, activate);
    this.childFactory = props => new Hooks(this.currentCover, props, activate);
    this.cropFactory = props => new Hooks(exports.__CropSlot, props, activate);
  }
  private childFactory: (props: Props) => Hooks;
  private cropFactory: (props: Props) => Hooks;
  crop(props: Props) { return this.cropFactory(props); }
  async flush() { await this.hooks.flush(); }
  async reply(index: number, payload: unknown, status = 200, invalidJSON = false) {
    assert.ok(this.requests[index], `Expected request ${index}`);
    this.requests[index].respond(status, payload, invalidJSON); await this.flush();
  }
  current() { return nodes(this.hooks.result).find(({ node }) => node.type === this.currentCover); }
  async image() {
    const view = this.current();
    if (!view) { this.child?.hooks.unmount(); this.child = undefined; return null; }
    if (!this.child || this.child.key !== view.node.key) {
      this.child?.hooks.unmount(); this.child = { key: view.node.key, hooks: this.childFactory(view.node.props) };
    } else this.child.hooks.setProps(view.node.props);
    await this.child.hooks.flush();
    return { root: this.child.hooks.result!, img: nodes(this.child.hooks.result).find(({ node }) => node.type === 'img')?.node };
  }
  retry() {
    const button = nodes(this.hooks.result).find(({ node }) => node.type === 'button' && text(node) === '重新读取')?.node;
    assert.ok(button, 'The original fresh-read retry stays available');
    (button.props.onClick as () => void)();
  }
  async setProps(changes: Props) { this.props = { ...this.props, ...changes }; this.hooks.setProps(this.props); await this.flush(); }
}

async function main() {
  let checks = 0;
  const equal = (actual: unknown, expected: unknown, message: string) => { assert.equal(actual, expected, message); checks++; };
  const fixture = new Fixture(); await fixture.flush();
  const pending = fixture.current()!; const hidden = (await fixture.image())!;
  equal(fixture.requests.length, 1, 'Hint starts alongside exactly one fresh JSON read');
  equal(fixture.requests[0].init.cache, 'no-store', 'JSON read retains no-store');
  equal(hidden.root.props['aria-hidden'], true, 'Unconfirmed current cover is inaccessible');
  equal((hidden.root.props.style as Props).visibility, 'hidden', 'Unconfirmed current cover is invisible');
  equal(hidden.img?.props.src, cover().thumbnailUrl, 'Only the clicked 640 fixed cover is prepared');
  equal(pending.node.props.visible, false, 'Shell/hint cannot claim confirmed readiness');
  equal(nodes(fixture.hooks.result).some(({ node }) => node.type === 'button' && text(node).includes('保存封面')), false, 'Hint cannot grant editor or save state');
  await fixture.setProps({ initialFixedCover: cover({ revision: 99, thumbnailUrl: '/fixture/replacement-hint' }) });
  equal(fixture.current()!.node.key, pending.node.key, 'A prop change cannot reseed the first-mount hint');
  await fixture.reply(0, editorState());
  const confirmed = fixture.current()!, visible = (await fixture.image())!;
  equal(confirmed.node.key, pending.node.key, 'Matching JSON preserves CurrentCover key');
  equal(confirmed.path, pending.path, 'Matching JSON preserves CurrentCover sibling position');
  equal(visible.img?.props.src, hidden.img?.props.src, 'Matching JSON preserves image src');
  equal(visible.root.props.style, undefined, 'Only matching fresh JSON reveals the image');
  equal(visible.root.props['aria-hidden'], undefined, 'Confirmed image is accessible');
  equal(confirmed.node.props.visible, true, 'Fresh state controls current-cover visibility');
  equal(nodes(fixture.hooks.result).filter(({ node }) => node.type === 'button' && text(node) === '保存封面').every(({ node }) => node.props.disabled === true), true, 'Fresh canManage=false stays authoritative');

  const mismatches: Array<[string, ModuleCoverEditorState]> = [
    ['state target', editorState(cover(), { target: { kind: 'module', id: 'module-b' } })],
    ['fixed target', editorState(cover({ target: { kind: 'preset', id: 'preset-b' } }))],
    ['state revision', editorState(cover(), { revision: 8 })],
    ['fixed revision', editorState(cover({ revision: 8 }))],
    ['fixed URL', editorState(cover({ thumbnailUrl: '/fixture/fresh-url' }))],
    ['unavailable', editorState(cover({ available: false }))],
    ['source error', editorState(cover(), { sourceError: 'sources unavailable' })],
  ];
  for (const [label, value] of mismatches) {
    const current = new Fixture(); await current.flush(); const previous = current.current()!.node.key;
    await current.reply(0, value);
    equal(current.current()!.node.key === previous, false, `${label} discards the hinted component identity`);
    equal(current.current()!.node.key?.startsWith('fresh:'), true, `${label} uses only fresh state`);
  }
  const missing = new Fixture(); await missing.flush(); await missing.reply(0, editorState(null));
  equal(missing.current()!.node.key?.startsWith('fresh:'), true, 'Missing fixed cover discards hint before fallback JSON');
  equal((await missing.image())!.img, undefined, 'Missing fixed cover cannot show the old hinted image');
  equal(missing.requests[1].url, '/api/image-studio/modules?ids=module-a', 'Missing fixed cover retains original authorized preview read');
  await missing.reply(1, { modules: [{ id: 'module-a', cover: { thumbnailUrl: '/fixture/fresh-preview' } }] });
  equal((await missing.image())!.img?.props.src, '/fixture/fresh-preview', 'Fallback uses only the fresh preview');

  for (const failure of ['403', '503', 'network', 'invalid JSON']) {
    const current = new Fixture(); await current.flush();
    if (failure === 'network') { current.requests[0].reject(new Error('fixture unavailable')); await current.flush(); }
    else await current.reply(0, failure === 'invalid JSON' ? null : { error: `fixture ${failure}` }, failure === 'invalid JSON' ? 200 : Number(failure), failure === 'invalid JSON');
    equal(current.current(), undefined, `${failure} removes the hint`);
    current.retry(); await current.flush();
    equal(current.current(), undefined, `${failure} retry cannot reseed old hinted media`);
    await current.reply(1, editorState());
    equal(current.current()!.node.key?.startsWith('fresh:'), true, `${failure} retry uses fresh JSON state`);
  }
  for (const afterConfirmation of [false, true]) {
    const current = new Fixture(); await current.flush();
    if (afterConfirmation) await current.reply(0, editorState());
    const image = (await current.image())!.img!; (image.props.onError as () => void)(); await current.flush();
    equal(current.current()?.node.key?.startsWith('initial:') || false, false, 'Media rejection immediately clears hinted identity');
    if (!afterConfirmation) {
      equal(current.current(), undefined, 'Rejected unconfirmed media is removed');
      await current.reply(0, editorState());
      equal(current.current()!.node.key?.startsWith('fresh:'), true, 'Late JSON cannot restore rejected hint');
    }
  }
  for (const boundary of ['account', 'session', 'blocked']) {
    const current = new Fixture(); await current.flush();
    if (boundary === 'account') current.session.user.id = 'viewer-b';
    if (boundary === 'session') current.session.sessionChanged = true;
    if (boundary === 'blocked') current.blocked = true;
    current.hooks.invalidate(); await current.flush();
    equal(current.current(), undefined, `${boundary} boundary removes hinted media`);
    await current.reply(0, editorState());
    equal(current.current(), undefined, `${boundary} late JSON cannot revive media`);
    current.session = { user: { id: 'viewer-a' }, sessionChanged: false }; current.blocked = false;
    current.hooks.invalidate(); await current.flush();
    equal(current.current(), undefined, `${boundary} return cannot reseed old hint`);
    await current.reply(1, editorState());
    equal(current.current()!.node.key?.startsWith('fresh:'), true, `${boundary} return requires fresh state`);
  }
  const moved = new Fixture(); await moved.flush(); await moved.setProps({ moduleId: 'module-b' });
  equal(moved.current(), undefined, 'A module scope change clears the hint');
  await moved.reply(0, editorState()); equal(moved.current(), undefined, 'Prior-module late JSON cannot revive the hint');
  await moved.reply(1, editorState(cover({ target: { kind: 'module', id: 'module-b' } }), { target: { kind: 'module', id: 'module-b' } }));
  equal(moved.current()!.node.key?.startsWith('fresh:module:module-b:'), true, 'New module uses its own fresh state');
  const closed = new Fixture(); await closed.flush(); closed.hooks.unmount(); await closed.reply(0, editorState());
  equal(closed.hooks.result, null, 'Closing editor prevents late JSON from publishing');

  for (const initial of [null, cover({ available: false }), cover({ thumbnailUrl: null })]) {
    const current = new Fixture(initial); await current.flush();
    equal(current.current(), undefined, 'No usable 640 hint retains serial initial behavior');
    await current.reply(0, editorState());
    equal(current.current()!.node.key?.startsWith('fresh:'), true, 'Serial initial read renders only fresh state');
  }
  const cropOwner = new Fixture(), originalUrl = '/fixture/original-full-resolution';
  const cropProps = { slot: { source: { previewUrl: originalUrl, width: 2048, height: 2048 }, key: 1 },
    aspect: 1, disabled: false, onCrop: () => undefined, onInteract: () => undefined };
  const pendingCrop = cropOwner.crop(cropProps); await pendingCrop.flush();
  const pendingCropper = nodes(pendingCrop.result).find(({ node }) => node.type === 'cropper')!.node;
  equal(pendingCropper.props.image, originalUrl, 'Cropping still requests the supplied full-resolution URL');
  let abandonedRemovals = 0, currentRemovals = 0;
  const abandoned = { complete: false, isConnected: false, removeAttribute(name: string) { equal(name, 'src', 'Only the abandoned image source is removed'); abandonedRemovals++; } };
  const imageRef: { current: typeof abandoned | null } = { current: abandoned };
  (pendingCropper.props.setImageRef as (ref: typeof imageRef) => void)(imageRef);
  const currentCrop = cropOwner.crop(cropProps); await currentCrop.flush();
  const currentCropper = nodes(currentCrop.result).find(({ node }) => node.type === 'cropper')!.node;
  const loadedImage = { complete: true, isConnected: false, removeAttribute() { currentRemovals++; } };
  (currentCropper.props.setImageRef as (ref: { current: typeof loadedImage }) => void)({ current: loadedImage });
  imageRef.current = null; // React clears the library ref before passive teardown.
  pendingCrop.unmount();
  equal(abandonedRemovals, 1, 'Unmount cancels the captured unfinished read even after the library ref clears');
  equal(currentRemovals, 0, 'An old owner cannot cancel a newly mounted crop image');
  currentCrop.unmount();
  equal(currentRemovals, 0, 'A completed full-resolution image is left intact');
  const connectedCrop = cropOwner.crop(cropProps); await connectedCrop.flush();
  const connectedCropper = nodes(connectedCrop.result).find(({ node }) => node.type === 'cropper')!.node;
  let connectedRemovals = 0;
  const connectedImage = { complete: false, isConnected: true, removeAttribute() { connectedRemovals++; } };
  (connectedCropper.props.setImageRef as (ref: { current: typeof connectedImage }) => void)({ current: connectedImage });
  connectedCrop.unmount(); // Development effect replay cleans up while the DOM remains connected.
  equal(connectedRemovals, 0, 'Connected development cleanup must retain the still-used image');
  connectedImage.isConnected = false; connectedCrop.unmount();
  equal(connectedRemovals, 1, 'Later detached cleanup cancels the same unfinished read');
  const studio = readFileSync('src/app/image-studio/studio.tsx', 'utf8');
  assert.match(studio, /onEditCover: \(\) => editGalleryCover\(entry, pageItem\?\.fixedCover\)/); checks++;
  assert.match(studio, /initialFixedCover=\{galleryCoverTarget\.initialFixedCover\}/); checks++;
  assert.match(studio, /key=\{`\$\{userId\}:\$\{galleryCoverTarget\.moduleId\}`\}/); checks++;
  console.log(JSON.stringify({ schema: 'module-cover-initial-read-fixture.v1', completed: true, assertions: checks,
    sourceSHA256: createHash('sha256').update(source).digest('hex'),
    scope: 'actual TSX controlled lifecycle and virtual key/src/visibility; no browser DOM or media GET proof' }));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
