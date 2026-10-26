'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { readJsonResponse } from '@/lib/http/json-response';

export type ProjectCreateInput = { name: string; description?: string | null };
export type CreatedProject = { id: string; name: string; type: string; status?: string };
export type ProjectCreateResult = {
  operation: { operationVersion: 1; requestId: string; state: 'accepted' | 'rejected' | 'closed' | 'unknown';
    projectId: string | null; projectHref: string | null; error: string | null; recordedAt: string | null };
  project: CreatedProject | null;
};
type PendingCreate = { schema: 1; ownerId: string; requestId: string; input: ProjectCreateInput; state: 'unknown' };
type PendingStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;

function parsePending(value: string | null, ownerId: string): PendingCreate | null {
  if (!value) return null;
  const record = JSON.parse(value) as PendingCreate;
  if (record.schema !== 1 || record.ownerId !== ownerId || record.state !== 'unknown'
    || !/^[0-9a-f-]{36}$/i.test(record.requestId) || typeof record.input?.name !== 'string') {
    throw new Error('原创建记录暂时无法确认，请保留现场后重试读取。');
  }
  return record;
}

function validResult(value: ProjectCreateResult, requestId: string) {
  return value?.operation?.operationVersion === 1 && value.operation.requestId === requestId
    && ['accepted', 'rejected', 'closed', 'unknown'].includes(value.operation.state);
}

// Each original request owns its durable entry. A late response in another tab
// must never erase a newer unresolved creation in the same surface.
export function readProjectCreatePending(storage: PendingStorage, storageKey: string, ownerId: string, preferredId?: string) {
  const records = new Map<string, PendingCreate>();
  const legacy = parsePending(storage.getItem(storageKey), ownerId);
  if (legacy) records.set(legacy.requestId, legacy);
  const prefix = `${storageKey}:`;
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const record = parsePending(storage.getItem(key), ownerId);
    if (!record || key !== `${prefix}${record.requestId}`) throw new Error('原创建记录暂时无法确认，请保留现场后重试读取。');
    records.set(record.requestId, record);
  }
  return (preferredId && records.get(preferredId)) || Array.from(records.values()).sort((a, b) => a.requestId.localeCompare(b.requestId))[0] || null;
}

export function storeProjectCreatePending(storage: PendingStorage, storageKey: string, record: PendingCreate) {
  storage.setItem(`${storageKey}:${record.requestId}`, JSON.stringify(record));
}

export function settleProjectCreatePending(storage: PendingStorage, storageKey: string, ownerId: string, requestId: string) {
  storage.removeItem(`${storageKey}:${requestId}`);
  const legacy = parsePending(storage.getItem(storageKey), ownerId);
  if (legacy?.requestId === requestId) storage.removeItem(storageKey);
  return readProjectCreatePending(storage, storageKey, ownerId);
}

export function useProjectCreateOperation(ownerId: string | null | undefined, surface: string) {
  const storageKey = ownerId ? `sd2-project-create:v1:${ownerId}:${surface}` : null;
  const identity = useRef(storageKey);
  identity.current = storageKey;
  const pendingRef = useRef<PendingCreate | null>(null);
  const lock = useRef<object | null>(null);
  const [pending, setPending] = useState<PendingCreate | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [lastResult, setLastResult] = useState<ProjectCreateResult | null>(null);

  const restore = useCallback(() => {
    pendingRef.current = null;
    setPending(null); setLastResult(null); setReady(false); setError(''); setLoadedKey(storageKey);
    if (!storageKey || !ownerId) return;
    try {
      const record = readProjectCreatePending(localStorage, storageKey, ownerId);
      pendingRef.current = record; setPending(record); setReady(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '原创建记录读取失败。'); }
  }, [ownerId, storageKey]);

  useEffect(() => {
    restore();
    const changed = (event: StorageEvent) => { if (event.key === storageKey || storageKey && event.key?.startsWith(`${storageKey}:`)) restore(); };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [restore, storageKey]);

  const resolve = useCallback(async (record: PendingCreate, action: 'create' | 'check' | 'close') => {
    if (!storageKey || !ownerId || identity.current !== storageKey) throw new Error('请先确认当前账号。');
    if (lock.current) throw new Error('正在核对原创建，请稍候。');
    const token = {}; lock.current = token; setBusy(true); setError('');
    try {
      const endpoint = action === 'create' ? '/api/projects'
        : `/api/projects/operations/${encodeURIComponent(record.requestId)}${action === 'close' ? '/close' : ''}`;
      const response = await fetch(endpoint, {
        method: action === 'check' ? 'GET' : 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'x-app-session-user': ownerId },
        ...(action === 'create' ? { body: JSON.stringify({ ...record.input, type: 'team', operationVersion: 1, requestId: record.requestId }) } : {}),
        signal: AbortSignal.timeout(30000),
      });
      const result = await readJsonResponse<ProjectCreateResult & { error?: string; message?: string }>(response);
      if (identity.current !== storageKey) throw new Error('账号已变化，请回原账号核对原创建。');
      if (!validResult(result, record.requestId)) throw new Error(result.message || result.error || '创建结果尚未确认，请查询原创建。');
      setLastResult(result);
      if (result.operation.state === 'unknown') {
        setError('提交结果待确认。可查询原创建，或核对并结束本次创建；不会自动重发。');
        return result;
      }
      // Only the original server receipt can unlock this creation scope.
      const remaining = settleProjectCreatePending(localStorage, storageKey, ownerId, record.requestId);
      pendingRef.current = remaining; setPending(remaining);
      if (result.operation.state === 'rejected') throw new Error(result.operation.error || '本次创建已明确拒绝，请调整后主动创建。');
      return result;
    } catch (cause) {
      if (identity.current === storageKey) setError(cause instanceof Error ? cause.message : '创建结果待确认，请查询原创建。');
      throw cause;
    } finally {
      if (lock.current === token) { lock.current = null; setBusy(false); }
    }
  }, [ownerId, storageKey]);

  const create = useCallback(async (input: ProjectCreateInput) => {
    if (!ready || loadedKey !== storageKey || !ownerId || !storageKey || identity.current !== storageKey) throw new Error('原创建记录尚未读取，请稍后重试。');
    const existing = readProjectCreatePending(localStorage, storageKey, ownerId, pendingRef.current?.requestId);
    if (existing || pendingRef.current) {
      pendingRef.current = existing || pendingRef.current; setPending(pendingRef.current);
      throw new Error('已有一次创建结果待确认，请先查询原创建或核对结束。');
    }
    if (lock.current) throw new Error('创建处理中，请稍候。');
    const record: PendingCreate = { schema: 1, ownerId, requestId: crypto.randomUUID(),
      input: { name: input.name.trim(), description: input.description?.trim() || null }, state: 'unknown' };
    storeProjectCreatePending(localStorage, storageKey, record);
    pendingRef.current = record; setPending(record); setLastResult(null);
    return resolve(record, 'create');
  }, [loadedKey, ownerId, ready, resolve, storageKey]);

  const check = useCallback(async () => {
    if (!pendingRef.current) throw new Error('没有待核对的原创建。');
    return resolve(pendingRef.current, 'check');
  }, [resolve]);
  const close = useCallback(async () => {
    if (!pendingRef.current) throw new Error('没有待核对的原创建。');
    return resolve(pendingRef.current, 'close');
  }, [resolve]);
  const current = loadedKey === storageKey;
  return { create, check, close, restore, pending: current ? pending : null, busy,
    ready: current && ready, error: current ? error : '', lastResult: current ? lastResult : null };
}

export type ProjectCreateOperation = ReturnType<typeof useProjectCreateOperation>;

export function projectStatusExpectation(project: { status?: string; updated_at?: string; status_version?: { status: string; updated_at: string } }) {
  const version = project.status_version || { status: project.status, updated_at: project.updated_at };
  if (!version.status || !version.updated_at || !Number.isFinite(Date.parse(version.updated_at))) {
    throw new Error('项目状态尚未确认，请先刷新项目后再操作。');
  }
  return { expected_status: version.status, expected_updated_at: version.updated_at };
}
