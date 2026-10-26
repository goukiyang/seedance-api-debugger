'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import { useProductDialog } from '@/components/useProductDialog';
import type { StudioDeletionReceipt, StudioDeletionStatus, StudioDeletionTarget } from '@/lib/image-studio/shared-types';

type Pending = { version: 1; actorId: string; objectKind: 'workspace' | 'source'; id: string; requestId: string;
  moduleRevision?: number; sourceRevision?: string };
type Settled = { receipt: StudioDeletionReceipt; current?: Extract<StudioDeletionStatus, { status: 'completed' }>['current'] };
const plain = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(value);
const keyFor = (actorId: string, kind: Pending['objectKind'], id: string) =>
  `sd2:studio-delete:v1:${encodeURIComponent(actorId)}:${kind}:${encodeURIComponent(id)}`;
function read(actorId: string, kind: Pending['objectKind'], id: string): Pending | null {
  const raw = localStorage.getItem(keyFor(actorId, kind, id));
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (!plain(value) || value.version !== 1 || value.actorId !== actorId || value.objectKind !== kind || value.id !== id
    || !validId(actorId) || !validId(id) || !validId(value.requestId)
    || (kind === 'workspace' ? !Number.isSafeInteger(value.moduleRevision) || Number(value.moduleRevision) < 0
      : typeof value.sourceRevision !== 'string' || !Number.isFinite(Date.parse(value.sourceRevision)))) {
    throw new Error('原删除记录无法确认，请保留现场并核对本机记录');
  }
  return { version: 1, actorId, objectKind: kind, id, requestId: value.requestId,
    ...(kind === 'workspace' ? { moduleRevision: value.moduleRevision as number } : { sourceRevision: value.sourceRevision as string }) };
}
async function claim(command: Pending) {
  const key = keyFor(command.actorId, command.objectKind, command.id);
  if (!navigator.locks) throw new Error('浏览器暂不能安全记住删除请求，本次尚未提交');
  return navigator.locks.request(key, () => {
    if (read(command.actorId, command.objectKind, command.id)) throw new Error('此对象已有待确认删除，请先核对原请求');
    const raw = JSON.stringify(command);
    localStorage.setItem(key, raw);
    if (localStorage.getItem(key) !== raw) throw new Error('删除请求未能记住，本次尚未提交');
  });
}
async function clear(command: Pending) {
  const key = keyFor(command.actorId, command.objectKind, command.id);
  if (!navigator.locks) throw new Error('原删除已确认，但本机记录尚未清理，请再次核对');
  await navigator.locks.request(key, () => {
    const current = read(command.actorId, command.objectKind, command.id);
    if (current && current.requestId !== command.requestId) throw new Error('此对象的删除记录已变化，请核对当前请求');
    if (current) localStorage.removeItem(key);
    if (localStorage.getItem(key) !== null) throw new Error('本机删除记录尚未清理，请再次核对');
  });
}
function matches(value: unknown, command: Pending): value is StudioDeletionReceipt {
  return plain(value) && value.version === 1 && value.deleted === true && value.actorId === command.actorId
    && value.objectKind === command.objectKind && value.id === command.id && value.requestId === command.requestId
    && (command.objectKind === 'workspace' ? value.moduleRevision === command.moduleRevision : value.sourceRevision === command.sourceRevision)
    && typeof value.noOp === 'boolean'
    && (command.objectKind === 'workspace' ? value.sourcePresetId === null || validId(value.sourcePresetId)
      : typeof value.appliedRevision === 'string' && Number.isFinite(Date.parse(value.appliedRevision))
        && Date.parse(value.appliedRevision) > Date.parse(command.sourceRevision!))
    && typeof value.committedAt === 'string' && Number.isFinite(Date.parse(value.committedAt));
}
async function responseJson(response: Response) {
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value?.error || '删除未完成，请核对原请求'), { commandOutcome: value?.commandOutcome });
  return value;
}

/** Both entrances share original-request receipts; browser restoration never sends a command. */
export function useStudioDeletion({ userId, onSettled, blocked }: {
  userId: string; onSettled: (result: Settled) => void; blocked: (target: StudioDeletionTarget) => string | null;
}) {
  const { confirm, productDialog } = useProductDialog();
  const [pending, setPending] = useState<Pending[]>([]);
  const pendingRef = useRef<Pending[]>([]);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const scope = useRef({ actorId: userId });
  if (scope.current.actorId !== userId) scope.current = { actorId: userId };
  const alive = useRef(true), busy = useRef(false);
  const callbacks = useRef({ onSettled, blocked }); callbacks.current = { onSettled, blocked };
  const reload = useCallback(() => {
    const prefix = `sd2:studio-delete:v1:${encodeURIComponent(userId)}:`;
    try {
      const values: Pending[] = [];
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (!key?.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length), split = rest.indexOf(':');
        const kind = rest.slice(0, split), id = decodeURIComponent(rest.slice(split + 1));
        if (kind !== 'workspace' && kind !== 'source') throw new Error('本机删除记录无法确认');
        const value = read(userId, kind, id);
        if (value) values.push(value);
      }
      const merged = new Map(pendingRef.current.filter(value => value.actorId === userId).map(value => [`${value.objectKind}:${value.id}`, value]));
      values.forEach(value => merged.set(`${value.objectKind}:${value.id}`, value));
      pendingRef.current = Array.from(merged.values());
      setPending(pendingRef.current);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '本机删除记录未能读取'); }
  }, [userId]);
  useEffect(() => { alive.current = true; busy.current = false; setBusyId(''); setError(''); reload(); window.addEventListener('storage', reload);
    return () => { alive.current = false; window.removeEventListener('storage', reload); }; }, [reload]);
  const current = (expected: typeof scope.current) => alive.current && scope.current === expected && !isClientSessionBlocked();
  async function settle(command: Pending, receipt: unknown, expected: typeof scope.current, state?: Settled['current']) {
    if (!matches(receipt, command)) throw new Error('原删除回执尚未完整确认，请继续核对原请求');
    await clear(command);
    if (!current(expected)) return;
    pendingRef.current = pendingRef.current.filter(value => value.requestId !== command.requestId);
    reload(); callbacks.current.onSettled({ receipt, current: state });
  }
  async function query(command: Pending, expected: typeof scope.current) {
    const url = command.objectKind === 'workspace'
      ? `/api/image-studio/modules?mode=delete-status&id=${encodeURIComponent(command.id)}&requestId=${encodeURIComponent(command.requestId)}`
      : `/api/image-studio/presets?mode=delete-status&presetId=${encodeURIComponent(command.id)}&requestId=${encodeURIComponent(command.requestId)}`;
    const result: StudioDeletionStatus = await responseJson(await fetch(url, { cache: 'no-store' }));
    if (!current(expected)) return;
    if (result.status !== 'completed') throw new Error('暂未查到原删除回执，结果仍待确认；不会重新删除');
    const state: unknown = result.current;
    if (!plain(state) || typeof state.exists !== 'boolean'
      || (command.objectKind === 'workspace' ? state.moduleRevision !== null && !Number.isSafeInteger(state.moduleRevision)
        : typeof state.archived !== 'boolean' || state.sourceRevision !== null
          && (typeof state.sourceRevision !== 'string' || !Number.isFinite(Date.parse(state.sourceRevision))))) {
      throw new Error('原删除回执与当前状态尚未完整读取，请继续核对原请求');
    }
    await settle(command, result.receipt, expected, result.current);
  }
  async function check(command: Pending) {
    if (busy.current || command.actorId !== userId || isClientSessionBlocked()) return;
    const expected = scope.current; busy.current = true; setBusyId(`${command.objectKind}:${command.id}`); setError('');
    try { await query(command, expected); }
    catch (cause) { if (current(expected)) setError(cause instanceof Error ? cause.message : '原删除仍待确认'); }
    finally { if (current(expected)) { busy.current = false; setBusyId(''); } }
  }
  async function request(target: StudioDeletionTarget, name: string, anchor?: HTMLElement) {
    if (busy.current || target.actorId !== userId || isClientSessionBlocked()) return;
    let original: Pending | null;
    try { original = read(userId, target.objectKind, target.id) || pendingRef.current.find(value => value.actorId === userId && value.objectKind === target.objectKind && value.id === target.id) || null; }
    catch (cause) { setError(cause instanceof Error ? cause.message : '原删除记录无法确认'); return; }
    if (original) { await check(original); return; }
    const reason = callbacks.current.blocked(target);
    if (!target.allowed || reason) { setError(reason || target.reason || '当前对象不能删除，请重新读取'); return; }
    const expected = scope.current;
    const message = target.objectKind === 'workspace'
      ? `删除“${name}”的个人工作区？配置会移除，已生成图片和历史保留，不退积分；共享原件不受影响。刷新不会自动重新创建，之后仍可在模板库主动选用。`
      : `删除模板原件“${name}”？共享使用者将不能再使用该原件；已有图片和历史保留，不退积分。`;
    await confirm(message, { title: target.objectKind === 'workspace' ? '删除工作区' : '删除原模板', confirmLabel: '删除', danger: true, anchor,
      onSubmit: async () => {
        if (!current(expected)) throw new Error('账号已变化，未继续删除');
        // A second confirm after an unknown result reads the original receipt, never POSTs again.
        const retained = read(userId, target.objectKind, target.id) || pendingRef.current.find(value => value.actorId === userId && value.objectKind === target.objectKind && value.id === target.id);
        if (retained) { await query(retained, expected); return; }
        const blockedReason = callbacks.current.blocked(target);
        if (blockedReason) throw new Error(blockedReason);
        const command: Pending = { version: 1, actorId: userId, objectKind: target.objectKind, id: target.id,
          requestId: crypto.randomUUID(), ...(target.objectKind === 'workspace' ? { moduleRevision: target.moduleRevision } : { sourceRevision: target.sourceRevision }) };
        busy.current = true; setBusyId(`${target.objectKind}:${target.id}`); setError('');
        let sent = false;
        try {
          await claim(command);
          if (!current(expected)) { await clear(command); return; }
          reload(); sent = true;
          const result = await responseJson(await fetch(target.objectKind === 'workspace' ? '/api/image-studio/modules' : '/api/image-studio/presets', {
            method: target.objectKind === 'workspace' ? 'DELETE' : 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000),
            body: JSON.stringify(target.objectKind === 'workspace' ? { action: 'delete-module', id: target.id, revision: target.moduleRevision, requestId: command.requestId }
              : { action: 'delete', presetId: target.id, revision: target.sourceRevision, requestId: command.requestId, entryPoint: 'workbench' }),
          }));
          if (!current(expected)) return;
          await settle(command, result, expected);
        } catch (cause) {
          const outcome = (cause as { commandOutcome?: unknown })?.commandOutcome;
          const rejected = plain(outcome) && outcome.status === 'not-applied' && outcome.actorId === command.actorId
            && outcome.objectKind === command.objectKind && outcome.id === command.id && outcome.requestId === command.requestId;
          if (!sent || rejected) await clear(command);
          if (!current(expected)) return;
          if (!sent || rejected) pendingRef.current = pendingRef.current.filter(value => value.requestId !== command.requestId);
          reload();
          const message = !sent || rejected ? cause instanceof Error ? cause.message : '删除尚未提交'
            : '删除结果待确认，请核对原请求；不会重复发送删除';
          setError(message); throw new Error(message);
        } finally { if (current(expected)) { busy.current = false; setBusyId(''); } }
      },
    });
  }
  return { request, check, pending, busyId, error, productDialog };
}
