import type { ContentKey } from '../content-reactions/types';
import type { ImageResultNextIntent, ImageResultNextReceipt } from './types';

export type ImageResultNextContext = {
  sourceKey?: ContentKey; resultId?: string; scope?: string; accountId: string;
  admin: boolean; enabled?: boolean; sessionChanged?: boolean;
};
export type ImageResultNextState = { identity: string; busy: ImageResultNextIntent | null; message: string; destination: string };
export type ImageResultNextTarget = { close: () => void; closed: () => boolean; replace: (destination: string) => void };
type Dependencies = {
  context: () => ImageResultNextContext; blocked: () => boolean;
  openTarget: () => ImageResultNextTarget | null; currentUrl: () => string;
  find: (source: ContentKey, intent: ImageResultNextIntent) => Promise<ImageResultNextReceipt | null>;
  create: (source: ContentKey, intent: ImageResultNextIntent, returnPath: string) => Promise<ImageResultNextReceipt>;
};
export function imageResultNextIdentity(context: ImageResultNextContext, blocked = false) {
  return JSON.stringify([context.scope || '', context.accountId, context.admin, context.resultId || '', context.sourceKey || '', context.enabled !== false, Boolean(context.sessionChanged || blocked)]);
}
export function imageResultNextCapabilities(context: ImageResultNextContext, blocked = false, busy: ImageResultNextIntent | null = null) {
  const common = !context.sourceKey ? '当前图片不可用于交接' : context.enabled === false ? '当前图片不可继续使用'
    : context.sessionChanged || blocked ? '登录状态已变化，请重新登录' : !context.accountId ? '请先登录' : busy ? '正在导入，请等待' : '';
  const cutoutDisabledReason = common || (!context.admin ? '抠图暂时仅对有业务授权的管理员开放' : '');
  return { canCutout: !cutoutDisabledReason, canVideo: !common, cutoutDisabledReason, videoDisabledReason: common };
}

// Lifetime belongs to the result card, not the transient menu invoking open.
export function createImageResultNextController(deps: Dependencies) {
  const identity = () => imageResultNextIdentity(deps.context(), deps.blocked());
  const empty = (): ImageResultNextState => ({ identity: identity(), busy: null, message: '', destination: '' });
  let state = empty(), alive = true, locked = false, generation = 0;
  let pendingTarget: ImageResultNextTarget | null = null;
  const listeners = new Set<() => void>();
  const update = (next: ImageResultNextState) => { state = next; listeners.forEach(listener => listener()); };
  const close = (target: ImageResultNextTarget | null) => { try { target?.close(); } catch { /* An already closed target cannot be navigated. */ } };
  function invalidate() {
    generation++; locked = false; close(pendingTarget); pendingTarget = null;
    update(empty());
  }
  function synchronize() { if (state.identity !== identity()) invalidate(); }
  async function open(intent: ImageResultNextIntent) {
    synchronize();
    const context = { ...deps.context() };
    const permissions = imageResultNextCapabilities(context, deps.blocked());
    if (!alive || locked || !context.sourceKey || (intent !== 'cutout' && intent !== 'video')
      || (intent === 'cutout' ? !permissions.canCutout : !permissions.canVideo)) return;
    locked = true;
    const expectedIdentity = identity(), request = ++generation;
    const current = () => alive && generation === request && identity() === expectedIdentity;
    update({ identity: expectedIdentity, busy: intent, message: '正在核对原图并导入…', destination: '' });
    let target: ImageResultNextTarget | null = null;
    try {
      // Must stay before the first await, in the original user action stack.
      target = deps.openTarget(); pendingTarget = target;
      if (!current()) { close(target); return; }
      let receipt = await deps.find(context.sourceKey, intent);
      if (!current()) { close(target); return; }
      // A failed or malformed GET is not proof that no receipt exists.
      if (receipt === null) {
        const from = new URL(deps.currentUrl());
        if (context.resultId) { from.searchParams.set('image_result_focus', context.resultId); from.hash = `image-result-${context.resultId}`; }
        if (!current()) { close(target); return; }
        receipt = await deps.create(context.sourceKey, intent, `${from.pathname}${from.search}${from.hash}`);
      }
      if (!current()) { close(target); return; }
      if (!receipt || typeof receipt !== 'object' || receipt.sourceKey !== context.sourceKey || receipt.intent !== intent
        || typeof receipt.destination !== 'string' || !receipt.destination.startsWith(intent === 'cutout' ? '/cutout?handoff=' : '/generate?image_result_handoff=')) {
        throw new Error('导入目标暂不可用，原现场保留');
      }
      update({ identity: expectedIdentity, busy: intent, destination: receipt.destination, message: receipt.message });
      if (!current()) { close(target); return; }
      if (target && !target.closed()) target.replace(receipt.destination);
    } catch (cause) {
      close(target);
      if (current()) update({ ...state, message: cause instanceof Error ? cause.message : '导入尚未确认，请查询原记录后继续' });
    } finally {
      if (generation === request) {
        locked = false; pendingTarget = null;
        if (current()) update({ ...state, busy: null });
        else synchronize();
      }
    }
  }
  return {
    open, synchronize,
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    activate: () => { alive = true; synchronize(); },
    dispose: () => { alive = false; invalidate(); },
  };
}
