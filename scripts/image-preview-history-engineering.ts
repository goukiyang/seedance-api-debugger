import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

/** Actual hook callbacks across documents sharing one browser history. */
export async function runImagePreviewHistoryEngineering() {
  const source = readFileSync(path.join(__dirname, '../src/components/useImagePreviewHistoryDismiss.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const marker = '__sd2ImagePreviewHistoryEntry';
  const checks: string[] = [];
  const flush = async () => { for (let n = 0; n < 5; n++) await Promise.resolve(); };
  function browser(initial: Record<string, unknown> | null = { __NA: true }) {
    const entries = [initial]; let index = 0, backCalls = 0;
    const location = { href: 'https://sd2.youdooart.com/template-studio?moduleId=fixture' };
    let listeners = new Set<() => void>();
    const history = {
      get state() { return entries[index]; }, get length() { return entries.length; },
      pushState(state: Record<string, unknown>) { entries.splice(++index); entries.push(structuredClone(state)); },
      replaceState(state: Record<string, unknown>) { entries[index] = structuredClone(state); },
      back() { backCalls++; if (index > 0) { index--; queueMicrotask(() => { for (const fn of Array.from(listeners)) fn(); }); } },
    };
    const page = { history, location, top: null as object | null, closed: new Map<string, number>(),
      get backCalls() { return backCalls; },
      newDocument() { listeners = new Set(); },
      addEventListener(_name: string, fn: () => void) { listeners.add(fn); },
      removeEventListener(_name: string, fn: () => void) { listeners.delete(fn); },
    };
    return page;
  }
  function mount(page: ReturnType<typeof browser>, identity = 'stable-react-id') {
    const effects: Array<() => void | (() => void)> = [];
    const runtime = { useId: () => identity, useRef: <T,>(value: T) => ({ current: value }),
      useCallback: <T,>(callback: T) => callback, useEffect: (effect: () => void | (() => void)) => effects.push(effect) };
    const exports: Record<string, unknown> = {};
    vm.runInNewContext(code, { exports, crypto: webcrypto, queueMicrotask, window: page,
      require(name: string) { if (name === 'react') return runtime;
        assert.equal(name, './useDialogDismiss'); return { isTopmostDialogLayer: (element: object) => page.top === element }; },
    });
    const ref = { current: {} as HTMLDivElement }; page.top = ref.current;
    const hook = exports.useImagePreviewHistoryDismiss as typeof import('../src/components/useImagePreviewHistoryDismiss').useImagePreviewHistoryDismiss;
    const close = hook(true, ref, () => page.closed.set(identity, (page.closed.get(identity) || 0) + 1));
    assert.equal(effects.length, 1);
    let cleanup = effects[0]();
    return { ref, close, cleanup: () => { if (typeof cleanup === 'function') cleanup(); }, replay: () => { cleanup = effects[0](); } };
  }
  const active = (page: ReturnType<typeof browser>) => page.history.state?.[marker] as { active: boolean; token: string } | undefined;

  const reload = browser(); mount(reload);
  const previousToken = active(reload)!.token;
  reload.newDocument(); // A reload preserves history.state, not the previous React instance or module counter.
  const reopened = mount(reload);
  assert.equal(active(reload)!.token !== previousToken, true, 'reloading must not reuse an active marker from the previous document');
  reopened.close(); await flush();
  assert.equal(reload.closed.get('stable-react-id'), 1, 'close after reload must not be mistaken for this session still being active');
  reopened.close(); assert.equal(reload.backCalls, 1);
  checks.push('preview_close_after_reload_uses_distinct_history_session');

  const strict = browser(), strictHook = mount(strict), strictToken = active(strict)!.token;
  strictHook.cleanup(); strictHook.replay(); await flush();
  assert.equal(strict.history.length, 2); assert.equal(active(strict)!.token, strictToken); assert.equal(active(strict)!.active, true);
  strictHook.close(); await flush(); assert.equal(strict.closed.get('stable-react-id'), 1);
  checks.push('preview_history_strict_mode_replay_keeps_one_entry');

  const nested = browser(), parent = mount(nested, 'parent'), child = mount(nested, 'child');
  child.close(); await flush();
  assert.equal(nested.closed.get('child'), 1); assert.equal(nested.closed.get('parent'), undefined);
  child.cleanup(); nested.top = parent.ref.current; parent.close(); await flush();
  assert.equal(nested.closed.get('parent'), 1);
  checks.push('preview_history_nested_back_closes_only_top_layer');

  const noState = browser(null), direct = mount(noState);
  direct.close(); direct.close();
  assert.equal(noState.closed.get('stable-react-id'), 1); assert.equal(noState.backCalls, 0);
  checks.push('preview_history_without_writable_state_closes_directly');

  const changed = browser(), changedHook = mount(changed);
  changed.location.href += '&different=1'; changedHook.close();
  assert.equal(changed.closed.get('stable-react-id'), 1); assert.equal(changed.backCalls, 0);
  checks.push('preview_history_close_does_not_navigate_from_another_url');

  const reuse = browser(), first = mount(reuse);
  first.cleanup(); await flush(); assert.equal(active(reuse)!.active, false);
  const reused = mount(reuse); assert.equal(reuse.history.length, 2);
  reused.close(); await flush(); assert.equal(reuse.closed.get('stable-react-id'), 1);
  checks.push('preview_history_reuses_inactive_same_page_entry');
  return checks;
}
