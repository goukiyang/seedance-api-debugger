'use client';

import { useEffect, useRef, useState } from 'react';
import type { ResolutionDelta, ResolutionOperation, ResolutionReceipt } from '@/lib/image-studio/resolution-apply-types';
import type { SettingsDraft, SettingsValue } from './settings-controller';
import { studioSettingsDirty } from './settings-controller';
import type { useStudioSettings } from './use-studio-settings';

const API = '/api/image-studio/settings/resolution-apply';
const terminal = new Set(['complete', 'partial', 'cancelled', 'restored']);
export function useResolutionApply({ open, ownerId, canEdit, editor, getExcluded, onDeltas }: {
  open: boolean; ownerId: string; canEdit: boolean; editor: ReturnType<typeof useStudioSettings>;
  getExcluded: () => string[]; onDeltas: (deltas: ResolutionDelta[]) => void;
}) {
  const [scope, setScope] = useState(false);
  const [value, setValue] = useState<ResolutionReceipt | null>(null);
  const [history, setHistory] = useState<ResolutionOperation[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const scopeRef = useRef({ ownerId, open });
  scopeRef.current = { ownerId, open };
  const lock = useRef(false);
  const stop = useRef(false);
  const current = useRef<ResolutionReceipt | null>(null);
  const pendingId = useRef('');
  const prepared = useRef<{ settings: Record<string, unknown>; excludeIds: string[]; draft: SettingsDraft } | null>(null);
  const key = `sd2:resolution-apply:v1:${ownerId}`;
  const remember = (id: string) => { pendingId.current = id; try { localStorage.setItem(key, id); } catch { /* Server receipts remain available when browser storage is unavailable. */ } };
  async function request(method: 'GET' | 'POST', input: Record<string, unknown> | string, token = sequence.current) {
    const response = await fetch(typeof input === 'string' ? `${API}${input}` : API, {
      method, cache: 'no-store', ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : {}),
    });
    if (token !== sequence.current || scopeRef.current.ownerId !== ownerId || !scopeRef.current.open) throw new Error('操作界面已关闭或账号已切换；重新打开后查询原操作');
    const data = await response.json();
    if (token !== sequence.current || scopeRef.current.ownerId !== ownerId || !scopeRef.current.open) throw new Error('操作界面已关闭或账号已切换；重新打开后查询原操作');
    if (!response.ok) {
      if (data.requestId) remember(data.requestId);
      if (response.status === 401 || response.status === 403) { current.current = null; setValue(null); setHistory([]); }
      throw new Error(data.error || '结果尚未确认，请查询原操作');
    }
    return data;
  }
  function accept(receipt: ResolutionReceipt) {
    if (!receipt.operation || receipt.operation.ownerId !== ownerId) throw new Error('没有完整读取本账号操作');
    current.current = receipt; setValue(receipt); remember(receipt.operation.requestId);
    if (receipt.deltas?.length) onDeltas(receipt.deltas);
  }
  async function exclusive(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); stop.current = false;
    const token = sequence.current;
    try { await action(); }
    catch (cause) { if (token === sequence.current) setError(cause instanceof Error ? cause.message : '结果尚未确认，请查询原操作'); }
    finally { if (token === sequence.current) { lock.current = false; setBusy(false); } }
  }
  async function query(id = current.current?.operation.requestId || pendingId.current, cursor = 0) {
    if (!id) return;
    const data = await request('GET', `?requestId=${encodeURIComponent(id)}&cursor=${cursor}`) as ResolutionReceipt;
    accept(data);
  }
  useEffect(() => {
    ++sequence.current; lock.current = false; stop.current = true; current.current = null; prepared.current = null; pendingId.current = '';
    setScope(false); setValue(null); setHistory([]); setError(''); setBusy(false);
    if (!open || !canEdit) return;
    const token = sequence.current;
    void exclusive(async () => {
      const list = await request('GET', '', token) as { operations: ResolutionOperation[] };
      setHistory(list.operations);
      let id = '';
      try { id = localStorage.getItem(key) || ''; pendingId.current = id; } catch { /* Read-only history provides the fallback. */ }
      const active = list.operations.find(item => !terminal.has(item.phase));
      if (active || list.operations.some(item => item.requestId === id)) await query(active?.requestId || id);
    });
    return () => { ++sequence.current; stop.current = true; };
    // Account/open changes reset dangerous scope; reading a receipt never advances it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ownerId, canEdit]);
  async function prepare() {
    await exclusive(async () => {
      if (!editor.settings || !editor.draft) throw new Error('请先完整读取设置');
      if (current.current && !terminal.has(current.current.operation.phase)) throw new Error('请先停止原操作，再准备新的预览');
      const settings = { revision: editor.settings.revision, model: editor.settings.model, context: editor.draft.context,
        prices: editor.draft.prices, templateDefaults: editor.draft.templateDefaults, confirmContextClear: !editor.draft.context.trim() };
      prepared.current = { settings, excludeIds: getExcluded(), draft: editor.draft };
      const requestId = crypto.randomUUID(); remember(requestId);
      accept(await request('POST', { action: 'prepare', requestId, ...prepared.current, draft: undefined }) as ResolutionReceipt);
    });
  }
  async function advance(restoring: boolean) {
    for (let count = 0; count <= 2500; count++) {
      const operation = current.current?.operation;
      if (!operation || stop.current || (restoring ? operation.phase === 'restored' : !['defaultConfirmed', 'applying'].includes(operation.phase))) return;
      const before = restoring ? operation.nextRestoreBatch : operation.nextBatch;
      const receipt = await request('POST', { action: restoring ? 'restore' : 'apply', requestId: operation.requestId,
        previewDigest: operation.previewDigest, operationRevision: operation.operationRevision, batch: before }) as ResolutionReceipt;
      accept(receipt);
      const next = restoring ? receipt.operation.nextRestoreBatch : receipt.operation.nextBatch;
      if (next === before) return;
    }
    throw new Error('已达到安全推进上限，请查询当前结果后明确继续');
  }
  async function commit() {
    let finished = false;
    await exclusive(async () => {
      const operation = current.current?.operation;
      const input = prepared.current;
      if (!operation || !input || editor.draft !== input.draft) throw new Error('设置已变化或原预览草稿未保留，请停止旧操作并重新预览');
      const receipt = await request('POST', { action: 'commit', requestId: operation.requestId, previewDigest: operation.previewDigest,
        operationRevision: operation.operationRevision, settings: input.settings, excludeIds: input.excludeIds }) as ResolutionReceipt;
      accept(receipt);
      if (receipt.settings) editor.controller.acceptCommitted(receipt.settings as SettingsValue, input.draft);
      await advance(false);
      finished = current.current?.operation.phase === 'complete' && !studioSettingsDirty(editor.controller.getSnapshot());
    });
    return finished;
  }
  return { scope, setScope, value, history, busy, error,
    canCommit: Boolean(prepared.current && editor.draft === prepared.current.draft && value?.operation.phase === 'preview'),
    prepare, commit, query: (id?: string) => exclusive(() => query(id)),
    more: () => exclusive(() => query(undefined, current.current?.nextCursor ?? 0)),
    continue: async () => {
      let finished = false;
      await exclusive(async () => { await advance(false); finished = current.current?.operation.phase === 'complete' && !studioSettingsDirty(editor.controller.getSnapshot()); });
      return finished;
    },
    restore: () => exclusive(() => advance(true)),
    stop: () => { stop.current = true; },
    cancel: () => exclusive(async () => {
      const operation = current.current?.operation;
      if (operation) accept(await request('POST', { action: 'cancel', requestId: operation.requestId,
        previewDigest: operation.previewDigest, operationRevision: operation.operationRevision }) as ResolutionReceipt);
    }),
  };
}
