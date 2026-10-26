'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import type { SharedStudioReasonCode, SharedStudioSharingCurrent } from '@/lib/image-studio/shared-types';

export type SharingCommandInput = {
  presetId: string; isShared: boolean; revision: string; entryPoint: 'template-library' | 'workbench';
};
type StoredSharingCommand = SharingCommandInput & { version: 1; account: string; requestId: string };
export type PendingSharingCommand = StoredSharingCommand & { state: 'submitting' | 'querying' | 'unknown'; error: string };
export type SharingCommandResult = {
  status: 'completed' | 'rejected' | 'unknown' | 'blocked'; requestId?: string; error?: string;
  reasonCode?: SharedStudioReasonCode; current?: SharedStudioSharingCurrent | null;
};
type SettledResult = SharingCommandResult & { status: 'completed' | 'rejected' };
const prefix = (owner: string) => `sd2:studio-sharing-command:v1:${encodeURIComponent(owner)}:`;
const storageKey = (command: Pick<StoredSharingCommand, 'account' | 'presetId'>) => prefix(command.account) + encodeURIComponent(command.presetId);
const plain = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(value);
const revision = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 160;
function stored(raw: string | null, owner: string): StoredSharingCommand | null {
  if (!raw) return null;
  const v: unknown = JSON.parse(raw);
  if (!plain(v) || v.version !== 1 || v.account !== owner || !id(v.presetId) || !id(v.requestId)
    || !revision(v.revision) || typeof v.isShared !== 'boolean' || !['template-library', 'workbench'].includes(String(v.entryPoint))) {
    throw new Error('原共享操作记录无法确认，请保留当前页面并核对本机存储');
  }
  return { version: 1, account: owner, presetId: v.presetId, requestId: v.requestId, revision: v.revision,
    isShared: v.isShared, entryPoint: v.entryPoint as SharingCommandInput['entryPoint'] };
}
function serialize(command: StoredSharingCommand) {
  return JSON.stringify({ version: 1, account: command.account, presetId: command.presetId, requestId: command.requestId,
    revision: command.revision, isShared: command.isShared, entryPoint: command.entryPoint });
}
const unknown = (command: StoredSharingCommand, error = '共享操作结果待确认，请查询原操作'):
  PendingSharingCommand => ({ ...command, state: 'unknown', error });
function completed(value: unknown, command: StoredSharingCommand): SharedStudioSharingCurrent | null {
  if (!plain(value) || !plain(value.receipt)) throw new Error('共享回执暂无法确认');
  const receipt = value.receipt, applied = receipt.appliedState;
  if (receipt.action !== 'set-sharing' || receipt.requestId !== command.requestId || receipt.presetId !== command.presetId
    || receipt.expectedRevision !== command.revision || !plain(applied) || applied.isShared !== command.isShared || applied.lifecycle !== 'active'
    || !revision(receipt.appliedRevision) || typeof receipt.committedAt !== 'string' || !Number.isFinite(Date.parse(receipt.committedAt))
    || typeof receipt.noOp !== 'boolean' || receipt.moduleRevision !== null && (!Number.isSafeInteger(receipt.moduleRevision) || Number(receipt.moduleRevision) < 1)) {
    throw new Error('共享回执与原操作不一致，请继续查询原操作');
  }
  // The receipt proves this command finished. Only the fresh current projection
  // can update UI facts; appliedState may already have a successor.
  if (value.current === null) return null;
  const current = value.current;
  if (!plain(current) || current.presetId !== command.presetId || !revision(current.sourceRevision)
    || typeof current.isShared !== 'boolean' || !['active', 'archived'].includes(String(current.lifecycle))
    || current.moduleRevision !== null && (!Number.isSafeInteger(current.moduleRevision) || Number(current.moduleRevision) < 1)) {
    throw new Error('当前共享状态暂无法确认，请查询原操作');
  }
  return { presetId: current.presetId, sourceRevision: current.sourceRevision, isShared: current.isShared,
    lifecycle: current.lifecycle as SharedStudioSharingCurrent['lifecycle'], moduleRevision: current.moduleRevision as number | null };
}

export function useSharingCommand({ userId, onSettled }: {
  userId: string; onSettled: (presetId: string, current: SharedStudioSharingCurrent | null, result: SettledResult) => void | Promise<void>;
}) {
  const { sessionChanged } = useAppSession();
  const scopeKey = `${userId}:${sessionChanged}`;
  const scope = useRef({ key: scopeKey });
  if (scope.current.key !== scopeKey) scope.current = { key: scopeKey };
  const latest = useRef(onSettled); latest.current = onSettled;
  const commands = useRef<{ scope: typeof scope.current; ready: boolean; items: Record<string, PendingSharingCommand> }>({ scope: scope.current, ready: false, items: {} });
  const [state, setState] = useState({ owner: userId, key: scopeKey, items: {} as Record<string, PendingSharingCommand> });
  const controllers = useRef(new Set<AbortController>());
  const activeScopes = useRef(new Set<typeof scope.current>());

  useEffect(() => {
    const current = scope.current;
    activeScopes.current.add(current);
    const items: Record<string, PendingSharingCommand> = {};
    let ready = false;
    if (userId && !sessionChanged && !isClientSessionBlocked()) {
      try {
        for (let index = 0; index < localStorage.length; index++) {
          const key = localStorage.key(index);
          if (!key?.startsWith(prefix(userId))) continue;
          const command = stored(localStorage.getItem(key), userId);
          if (command && storageKey(command) === key) items[command.presetId] = unknown(command);
        }
        ready = true;
      } catch { ready = false; }
    }
    commands.current = { scope: current, ready, items };
    setState({ owner: userId, key: scopeKey, items });
    // Refresh restores only metadata and a query affordance, never POST or a
    // previously accepted confirmation. Other tabs also cannot release a lock
    // merely by deleting local storage; this tab must confirm its own receipt.
    const receive = (event: StorageEvent) => {
      if (scope.current !== current || !event.key?.startsWith(prefix(userId)) || !event.newValue) return;
      try {
        const command = stored(event.newValue, userId);
        if (!command || event.key !== storageKey(command)) return;
        const existing = commands.current.items[command.presetId];
        if (existing && existing.requestId !== command.requestId) return;
        const next = { ...commands.current.items, [command.presetId]: existing || unknown(command) };
        commands.current.items = next; setState({ owner: userId, key: scopeKey, items: next });
      } catch { commands.current.ready = false; }
    };
    window.addEventListener('storage', receive);
    const activeControllers = controllers.current;
    const active = activeScopes.current;
    return () => { active.delete(current); window.removeEventListener('storage', receive); activeControllers.forEach(controller => controller.abort()); activeControllers.clear(); };
  }, [userId, scopeKey, sessionChanged]);

  const valid = useCallback((current: typeof scope.current) => Boolean(userId && !sessionChanged && !isClientSessionBlocked()
    && current.key === scopeKey && scope.current === current && commands.current.scope === current && activeScopes.current.has(current)), [userId, sessionChanged, scopeKey]);
  const publish = useCallback((current: typeof scope.current, presetId: string, command: PendingSharingCommand | null) => {
    if (!valid(current)) return;
    const items = { ...commands.current.items };
    if (command) items[presetId] = command; else delete items[presetId];
    commands.current.items = items; setState({ owner: userId, key: scopeKey, items });
  }, [valid, userId, scopeKey]);
  const settle = useCallback((current: typeof scope.current, command: StoredSharingCommand, result: SettledResult) => {
    if (!valid(current)) return;
    try {
      const saved = stored(localStorage.getItem(storageKey(command)), userId);
      if (saved?.requestId === command.requestId) localStorage.removeItem(storageKey(command));
    } catch { /* A confirmed receipt is still complete if cache cleanup fails. */ }
    publish(current, command.presetId, null);
    // Downstream catalog refresh errors must never turn a confirmed write back
    // into an unknown command or trigger a second submission.
    try { void Promise.resolve(latest.current(command.presetId, result.current ?? null, result)).catch(() => {}); } catch { /* Caller owns read feedback. */ }
  }, [valid, publish, userId]);
  const execute = useCallback(async (command: StoredSharingCommand, mode: 'submit' | 'query'): Promise<SharingCommandResult> => {
    const current = scope.current;
    if (!valid(current)) return { status: 'blocked', error: '账号状态已变化，请重新读取' };
    const controller = new AbortController(); controllers.current.add(controller);
    publish(current, command.presetId, { ...command, state: mode === 'submit' ? 'submitting' : 'querying', error: '' });
    try {
      const response = await fetch(mode === 'submit' ? '/api/image-studio/presets'
        : `/api/image-studio/presets?mode=command-status&requestId=${encodeURIComponent(command.requestId)}`, {
        method: mode === 'submit' ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        ...(mode === 'submit' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'set-sharing',
          presetId: command.presetId, isShared: command.isShared, revision: command.revision, requestId: command.requestId, entryPoint: command.entryPoint }) } : {}),
      });
      const value: unknown = await response.json();
      if (!valid(current) || commands.current.items[command.presetId]?.requestId !== command.requestId) {
        return { status: 'unknown', requestId: command.requestId, error: '账号或页面已变化，原操作仍待确认' };
      }
      if (!response.ok) {
        if (mode === 'submit' && [400, 401, 403, 404, 409, 428].includes(response.status) && plain(value) && typeof value.error === 'string') {
          const result: SettledResult = { status: 'rejected', requestId: command.requestId, error: value.error,
            reasonCode: value.reasonCode as SharedStudioReasonCode | undefined, current: null };
          settle(current, command, result); return result;
        }
        throw new Error('共享操作结果待确认，请查询原操作');
      }
      if (mode === 'query' && plain(value) && value.status === 'not-found') throw new Error('尚未查到原操作回执，结果仍待确认');
      if (mode === 'query' && (!plain(value) || value.status !== 'completed')) throw new Error('原操作回执暂无法确认');
      const currentState = completed(value, command);
      const result: SettledResult = { status: 'completed', requestId: command.requestId, current: currentState };
      settle(current, command, result); return result;
    } catch (cause) {
      const error = cause instanceof Error && !['AbortError', 'TimeoutError'].includes(cause.name)
        ? cause.message : '共享操作结果待确认，请查询原操作';
      if (valid(current) && commands.current.items[command.presetId]?.requestId === command.requestId) publish(current, command.presetId, unknown(command, error));
      return { status: 'unknown', requestId: command.requestId, error };
    } finally { controllers.current.delete(controller); }
  }, [valid, publish, settle]);

  const submit = useCallback(async (input: SharingCommandInput): Promise<SharingCommandResult> => {
    const current = scope.current;
    if (!valid(current) || !commands.current.ready) return { status: 'blocked', error: '本机操作记录无法安全保存，尚未提交共享修改' };
    if (!id(input.presetId) || !revision(input.revision) || typeof input.isShared !== 'boolean'
      || !['template-library', 'workbench'].includes(input.entryPoint)) return { status: 'blocked', error: '请重新读取当前模板版本后再修改共享范围' };
    try {
      const prior = commands.current.items[input.presetId] || stored(localStorage.getItem(storageKey({ account: userId, presetId: input.presetId })), userId);
      if (prior) {
        if (!commands.current.items[input.presetId]) publish(current, input.presetId, unknown(prior));
        return { status: 'blocked', requestId: prior.requestId, error: '此模板已有待确认操作，请先查询原操作' };
      }
      const command: StoredSharingCommand = { version: 1, account: userId, presetId: input.presetId, isShared: input.isShared,
        revision: input.revision, entryPoint: input.entryPoint, requestId: `sharing-${crypto.randomUUID()}` };
      const raw = serialize(command), key = storageKey(command);
      localStorage.setItem(key, raw);
      if (localStorage.getItem(key) !== raw) throw new Error('操作记录未能保存');
      return execute(command, 'submit');
    } catch { return { status: 'blocked', error: '本机操作记录未能保存，尚未提交共享修改' }; }
  }, [valid, userId, publish, execute]);
  const query = useCallback(async (presetId: string): Promise<SharingCommandResult> => {
    const current = scope.current;
    if (!valid(current)) return { status: 'blocked', error: '账号状态已变化，请重新读取' };
    const command = commands.current.items[presetId];
    if (!command) return { status: 'blocked', error: '没有可核对的原操作记录' };
    if (command.state !== 'unknown') return { status: 'blocked', requestId: command.requestId, error: '原操作正在确认，请稍候' };
    return execute(command, 'query');
  }, [valid, execute]);
  const pending: Record<string, PendingSharingCommand> = state.owner === userId && state.key === scopeKey ? state.items : {};
  const busyId = Object.values(pending).find(command => command.state !== 'unknown')?.presetId || null;
  return { pending, busyId, submit, query };
}
