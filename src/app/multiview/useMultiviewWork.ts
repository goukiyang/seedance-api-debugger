'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import { readJsonResponse } from '@/lib/http/json-response';
import type { MultiviewDraft, MultiviewInfo } from '@/lib/video/multiview-contract';
import { isMultiviewWorkId, parseMultiviewWorkRecipe, multiviewWorkRecipesEqual, type MultiviewWorkDto,
  type MultiviewWorkRecipe, type MultiviewWorkReceipt } from '@/lib/video/multiview-work-contract';

type Options = { owner: string; authority: string; enabled: boolean; workId: string; taskId: string; explicitTaskId: string;
  info: MultiviewInfo | null; draft: MultiviewDraft | null; localPresent: boolean; allowCreate: boolean; editRevision: number;
  onSource: (work: MultiviewWorkDto) => void; onRestore: (recipe: MultiviewWorkRecipe) => void; onBound: (work: MultiviewWorkDto) => void };
type Pending = { schema: 1; owner: string; taskId: string; sourceVersion: string; mutationId: string;
  action: 'create' | 'save' | 'branch'; workId: string | null; hash: string; result?: 'committed' | 'rejected' };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const signature = (recipe: MultiviewWorkRecipe | null, title: string) => JSON.stringify([recipe, title]);
export function appliedWorkRecipe(draft: MultiviewDraft | null, info: MultiviewInfo | null) {
  return draft && info ? parseMultiviewWorkRecipe({ ...draft, restoreOrder: draft.restoreOrder || [] }, info) : null;
}
function workFrom(value: unknown): MultiviewWorkDto | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const work = value as MultiviewWorkDto;
  if (!isMultiviewWorkId(work.id) || !isMultiviewWorkId(work.sourceTaskId) || typeof work.title !== 'string' || work.title.length > 200
    || !Number.isSafeInteger(work.revision) || work.revision < 0 || !Number.isSafeInteger(work.draftRevision) || work.draftRevision < 0
    || !['waiting_source', 'queued', 'rendering', 'ready', 'failed', 'source_changed'].includes(work.status)
    || !['current', 'changed', 'unavailable'].includes(work.sourceState) || typeof work.removed !== 'boolean'
    || work.sourceVersion !== null && !/^[a-f0-9]{64}$/.test(work.sourceVersion)) return null;
  if (work.info && (!Array.isArray(work.info.timestamps) || !work.info.timestamps.length || work.info.timestamps.length > 21600
    || work.info.taskId !== work.sourceTaskId || work.info.sourceVersion !== work.sourceVersion
    || !Number.isSafeInteger(work.info.width) || work.info.width < 1 || !Number.isSafeInteger(work.info.height) || work.info.height < 1
    || !Number.isFinite(work.info.duration) || work.info.timestamps.some(time => !Number.isFinite(time) || time < 0))) return null;
  if (work.recipe && (!work.info || !parseMultiviewWorkRecipe(work.recipe, work.info))) return null;
  return work;
}
function receiptFrom(value: unknown, pending: Pending): MultiviewWorkReceipt | null {
  if (!value || typeof value !== 'object') return null;
  const result = value as MultiviewWorkReceipt;
  return result.state === 'committed' && result.mutationId === pending.mutationId && result.action === pending.action
    && isMultiviewWorkId(result.workId) && (pending.action !== 'save' || result.workId === pending.workId)
    && Number.isSafeInteger(result.revision) && result.revision >= 0 && Number.isSafeInteger(result.draftRevision) && result.draftRevision >= 0 ? result : null;
}
const recordKey = (owner: string, mutationId: string) => `sd2:multiview-work-mutation:v1:${owner}:${mutationId}`;
const pointerKey = (owner: string, taskId: string) => `sd2:multiview-work-pending:v1:${owner}:${taskId}`;
function retainPending(value: Pending) {
  const bytes = JSON.stringify(value);
  localStorage.setItem(recordKey(value.owner, value.mutationId), bytes);
  if (localStorage.getItem(recordKey(value.owner, value.mutationId)) !== bytes) throw new Error('原保存编号未能保存，尚未发送。');
  sessionStorage.setItem(pointerKey(value.owner, value.taskId), value.mutationId);
  if (sessionStorage.getItem(pointerKey(value.owner, value.taskId)) !== value.mutationId) throw new Error('原保存编号未能保存，尚未发送。');
}
function settlePending(value: Pending, result: 'committed' | 'rejected') {
  const bytes = JSON.stringify({ ...value, result });
  localStorage.setItem(recordKey(value.owner, value.mutationId), bytes);
  if (localStorage.getItem(recordKey(value.owner, value.mutationId)) !== bytes) throw new Error('原保存回执未能完整保存在此设备，请保留页面继续查询。');
  if (sessionStorage.getItem(pointerKey(value.owner, value.taskId)) === value.mutationId) sessionStorage.removeItem(pointerKey(value.owner, value.taskId));
}
function readPending(owner: string, taskId: string): Pending | null {
  let id = sessionStorage.getItem(pointerKey(owner, taskId));
  if (!id) {
    const length = localStorage.length;
    if (length > 8192) throw new Error('本机原保存记录尚未查全，未按没有保存处理；请保留原页面查询。');
    for (let index = 0; index < length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(`sd2:multiview-work-mutation:v1:${owner}:`)) continue;
      const raw = localStorage.getItem(key);
      if (!raw || raw.length > 2048) throw new Error('本机原保存记录无法确认，未新建保存。');
      const record = JSON.parse(raw) as Pending;
      if (record.schema !== 1 || record.owner !== owner || !uuid.test(record.mutationId) || key !== recordKey(owner, record.mutationId)
        || !isMultiviewWorkId(record.taskId) || !/^[a-f0-9]{64}$/.test(record.sourceVersion) || !/^[a-f0-9]{64}$/.test(record.hash)
        || !['create', 'save', 'branch'].includes(record.action) || record.result !== undefined && !['committed', 'rejected'].includes(record.result)) throw new Error('本机原保存记录无法确认，未新建保存。');
      if (record.owner === owner && record.taskId === taskId && record.result === undefined) { id = record.mutationId; break; }
    }
    if (length !== localStorage.length) throw new Error('本机原保存记录正在变化，请重新核对。');
    if (!id) return null;
  }
  if (!uuid.test(id)) throw new Error('原保存记录无法确认，未新建保存。');
  const raw = localStorage.getItem(recordKey(owner, id));
  if (!raw || raw.length > 2048) throw new Error('原保存记录缺失，未按没有保存处理。');
  const value = JSON.parse(raw) as Pending;
  if (value.schema !== 1 || value.owner !== owner || value.taskId !== taskId || value.mutationId !== id
    || !/^[a-f0-9]{64}$/.test(value.hash) || !/^[a-f0-9]{64}$/.test(value.sourceVersion)
    || !['create', 'save', 'branch'].includes(value.action) || value.workId !== null && !isMultiviewWorkId(value.workId)
    || value.result !== undefined && !['committed', 'rejected'].includes(value.result)) throw new Error('原保存记录无法确认，未新建保存。');
  return value.result === 'rejected' ? null : value;
}

export function useMultiviewWork(options: Options) {
  const [work, setWork] = useState<MultiviewWorkDto | null>(null);
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [conflict, setConflict] = useState(false);
  const [message, setMessage] = useState('');
  const [stopped, setStopped] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [retry, setRetry] = useState(0);
  const [storageFailed, setStorageFailed] = useState(false);
  const [loadedIdentity, setLoadedIdentity] = useState('');
  const epoch = useRef(0); const lock = useRef<symbol | null>(null);
  const live = useRef(options); live.current = options;
  const workRef = useRef(work); workRef.current = work;
  const pendingRef = useRef(pending); pendingRef.current = pending;
  const titleRef = useRef(title); titleRef.current = title;
  const acknowledged = useRef(''); const initialized = useRef('');
  const editedTitle = useRef(false);
  const initialEditRevision = useRef(options.editRevision);
  const titleKnown = useRef('');
  const recipe = useMemo(() => appliedWorkRecipe(options.draft, options.info), [options.draft, options.info]);
  const localSignature = signature(recipe, title);
  const identity = `${options.owner}:${options.authority}:${options.workId}:${options.taskId}`;
  const scope = () => ({ identity, epoch: epoch.current, owner: options.owner });
  const current = (value: ReturnType<typeof scope>) => value.epoch === epoch.current && value.owner === live.current.owner
    && value.identity === `${live.current.owner}:${live.current.authority}:${live.current.workId}:${live.current.taskId}`
    && live.current.enabled && !isClientSessionBlocked();
  const headers = () => ({ 'x-app-session-user': options.owner });
  const titleKey = options.owner && options.taskId ? `sd2:multiview-work-title:v1:${options.owner}:${options.workId || options.taskId}` : '';
  async function readWork(id: string, value: ReturnType<typeof scope>): Promise<MultiviewWorkDto> {
    const response = await fetch(`/api/video/multiview/works/${encodeURIComponent(id)}`, { cache: 'no-store', headers: headers(), signal: AbortSignal.timeout(30000) });
    const payload = await readJsonResponse<{ work?: unknown; error?: string }>(response);
    if (!current(value)) throw new Error('账号或作品已变化，未套用迟到结果。');
    const next = workFrom(payload.work);
    if (!response.ok || !next || next.id !== id) throw new Error(payload.error || '作品暂不可读取，请重试；此设备修改仍保留。');
    if (live.current.explicitTaskId && next.sourceTaskId !== live.current.explicitTaskId || !live.current.workId && live.current.taskId && next.sourceTaskId !== live.current.taskId) throw new Error('作品与指定视频不一致，请核对链接；未替换当前内容。');
    return next;
  }
  const fetchInitial = useCallback(async () => {
    if (!options.enabled || !options.owner || !options.workId && !options.taskId) return;
    const value = scope(); setLoading(true); setMessage('');
    try {
      if (options.workId && !isMultiviewWorkId(options.workId)) throw new Error('作品编号无效，请从我的作品重新打开。');
      let next: MultiviewWorkDto | null = null;
      if (options.workId) next = await readWork(options.workId, value);
      else {
        const params = new URLSearchParams({ taskId: options.taskId });
        const response = await fetch(`/api/video/multiview/works?${params}`, { cache: 'no-store', headers: headers(), signal: AbortSignal.timeout(30000) });
        const payload = await readJsonResponse<{ works?: unknown[]; error?: string }>(response);
        if (!current(value)) return;
        if (!response.ok || !Array.isArray(payload.works)) throw new Error(payload.error || '作品暂无法核对，此设备修改仍保留。');
        next = payload.works.map(workFrom).find(item => item && item.sourceTaskId === options.taskId && item.parentWorkId === null) || null;
      }
      if (!current(value)) return;
      if (next && initialized.current && workRef.current && next.revision !== workRef.current.revision
        && signature(appliedWorkRecipe(live.current.draft, live.current.info), titleRef.current) !== signature(next.recipe, next.title)) {
        setConflict(true); setMessage('服务器作品已有不同内容，此设备修改保留，请选择继续方式。');
      }
      setWork(next); workRef.current = next; setHydrated(true); setLoadedIdentity(identity);
      if (next && !editedTitle.current) setTitle(next.title);
      if (next) { if (options.workId && options.taskId !== next.sourceTaskId) live.current.onSource(next); }
      if (next?.recipe && next.sourceVersion && !options.workId) live.current.onBound(next);
    } catch (cause) { if (current(value)) { setStopped(true); setMessage(cause instanceof Error ? cause.message : '作品暂不可读取，当前修改保留。'); } }
    finally { if (current(value)) setLoading(false); }
    // Authority/target changes invalidate every response; draft edits do not restart this read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, options.enabled, retry]);
  useEffect(() => {
    epoch.current++; lock.current = null; setWork(null); workRef.current = null; setPending(null); pendingRef.current = null;
    setLoading(false); setBusy(false); setConflict(false); setStopped(false); setHydrated(false); setLoadedIdentity(''); setStorageFailed(false); setMessage('');
    initialized.current = ''; acknowledged.current = ''; editedTitle.current = false; initialEditRevision.current = options.editRevision; titleKnown.current = ''; setTitle('');
    if (options.enabled && options.owner && options.taskId) {
      try {
        const original = readPending(options.owner, options.taskId); pendingRef.current = original; setPending(original);
        const savedTitle = titleKey ? localStorage.getItem(titleKey) : null;
        if (savedTitle !== null) { if (savedTitle.length > 120) throw new Error('作品名称记录无效。'); setTitle(savedTitle); editedTitle.current = true; }
        titleKnown.current = titleKey;
      } catch (cause) { setStorageFailed(true); setStopped(true); setMessage(cause instanceof Error ? cause.message : '原保存记录无法确认，未新建保存。'); }
    }
    void fetchInitial();
    return () => { epoch.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, options.enabled]);
  const fetchRef = useRef(fetchInitial); fetchRef.current = fetchInitial;
  useEffect(() => { if (retry) void fetchRef.current(); }, [retry]);
  useEffect(() => {
    if (!hydrated || loadedIdentity !== identity || !work || !options.info || !recipe) return;
    const key = `${identity}:${work.id}:${options.info.sourceVersion}`;
    if (initialized.current === key) return;
    if (!work.recipe || !work.sourceVersion) { setMessage('作品正在准备原视频和初始选帧，当前修改先保留在此设备。'); return; }
    initialized.current = key;
    if (work.sourceVersion !== options.info.sourceVersion || work.sourceState !== 'current' || work.removed) {
      setStopped(true); setMessage(work.removed ? '这件作品已移出作品库，请从已移出列表恢复后继续保存。' : '作品原视频版本暂不可确认，当前修改仅保留在此设备。'); return;
    }
    const nextTitle = editedTitle.current ? titleRef.current : work.title;
    setTitle(nextTitle);
    acknowledged.current = signature(work.recipe, work.title);
    setMessage('');
    const localChanged = options.localPresent || options.editRevision !== initialEditRevision.current;
    if (localChanged && !multiviewWorkRecipesEqual(recipe, work.recipe) || editedTitle.current && nextTitle !== work.title) {
      setConflict(true); setMessage('此设备修改与作品中的内容不同，尚未覆盖。可打开服务器版本，或将此设备修改另存一版。');
    } else if (!localChanged || JSON.stringify(recipe) !== JSON.stringify(work.recipe)) live.current.onRestore(work.recipe);
  }, [hydrated, loadedIdentity, work, options.info, recipe, identity, options.localPresent, options.editRevision]);
  useEffect(() => {
    if (!options.enabled || !hydrated || loadedIdentity !== identity || isClientSessionBlocked() || !titleKey || titleKnown.current !== titleKey || !editedTitle.current) return;
    try { localStorage.setItem(titleKey, title); if (localStorage.getItem(titleKey) !== title) throw new Error('not_retained'); }
    catch { setStorageFailed(true); }
  }, [options.enabled, hydrated, loadedIdentity, identity, title, titleKey]);

  async function acceptReceipt(original: Pending, receipt: MultiviewWorkReceipt, value: ReturnType<typeof scope>, supplied?: unknown) {
    const suppliedWork = workFrom(supplied);
    const next = suppliedWork && suppliedWork.id === receipt.workId ? suppliedWork : await readWork(receipt.workId, value);
    if (!current(value) || pendingRef.current?.mutationId !== original.mutationId) return;
    if (next.sourceTaskId !== original.taskId || next.sourceVersion !== original.sourceVersion || !next.recipe) throw new Error('原保存来源尚未确认，原编号保留，请继续查询。');
    settlePending(original, 'committed'); pendingRef.current = null; setPending(null);
    if (live.current.info && live.current.info.sourceVersion !== original.sourceVersion
      || live.current.workId && live.current.workId !== original.workId && live.current.workId !== next.id) {
      setMessage('原保存已确认，当前作品未被替换；原成果可在我的作品中找到。'); return;
    }
    setWork(next); workRef.current = next; acknowledged.current = signature(next.recipe, next.title);
    setStopped(false); setConflict(next.revision !== receipt.revision); setStorageFailed(false);
    if (original.action !== 'save') { setTitle(next.title); editedTitle.current = false; live.current.onBound(next); }
    setMessage(next.revision !== receipt.revision ? '原保存已确认，服务器另有更新；此设备修改保留，请选择继续方式。' : '');
  }
  async function queryOriginal() {
    const original = pendingRef.current;
    if (!original || lock.current || !options.enabled) return;
    const value = scope(); const token = Symbol(); lock.current = token; setBusy(true);
    try {
      const response = await fetch(`/api/video/multiview/works/mutations/${encodeURIComponent(original.mutationId)}`, { cache: 'no-store', headers: headers(), signal: AbortSignal.timeout(30000) });
      const payload = await readJsonResponse<unknown>(response);
      if (!current(value)) return;
      const receipt = receiptFrom(payload, original);
      if (!response.ok || !receipt) { setMessage('原保存结果尚未确认，可继续查询原保存；不会换号重复保存。'); return; }
      await acceptReceipt(original, receipt, value);
    } catch (cause) { if (current(value)) setMessage(cause instanceof Error ? cause.message : '原保存结果待确认，请继续查询原编号。'); }
    finally { if (lock.current === token) { lock.current = null; setBusy(false); } }
  }
  async function send(action: 'create' | 'save' | 'branch') {
    const info = live.current.info; const applied = appliedWorkRecipe(live.current.draft, info); const existing = workRef.current;
    if (!options.enabled || !info || !applied || lock.current || pendingRef.current || storageFailed || !title.trim() && action !== 'create'
      || action !== 'create' && (!existing || existing.removed || existing.sourceVersion !== info.sourceVersion)) return;
    const value = scope(); if (!current(value)) return;
    const token = Symbol(); lock.current = token; setBusy(true); setMessage('');
    let original: Pending | null = null; let sent = false;
    try {
      const unresolved = readPending(options.owner, options.taskId);
      if (unresolved) { pendingRef.current = unresolved; setPending(unresolved); setMessage('仍有原保存待确认，请先查询原保存。'); return; }
      const mutationId = crypto.randomUUID();
      const body = action === 'create' ? { mutationId, taskId: options.taskId, sourceVersion: info.sourceVersion, recipe: applied, ...(title.trim() ? { title } : {}) }
        : { mutationId, baseRevision: existing!.revision, action, recipe: applied, title,
          ...(action === 'branch' ? { branchKey: crypto.randomUUID() } : {}) };
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body)));
      if (!current(value)) return;
      original = { schema: 1, owner: options.owner, taskId: options.taskId, sourceVersion: info.sourceVersion, mutationId,
        action, workId: existing?.id || null, hash: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') };
      retainPending(original); pendingRef.current = original; setPending(original); sent = true;
      const response = await fetch(action === 'create' ? '/api/video/multiview/works' : `/api/video/multiview/works/${encodeURIComponent(existing!.id)}`, {
        method: action === 'create' ? 'POST' : 'PATCH', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      const payload = await readJsonResponse<{ receipt?: unknown; work?: unknown; notCommitted?: boolean; code?: string; workId?: string; error?: string }>(response);
      if (!current(value)) return;
      const receipt = receiptFrom(payload.receipt, original);
      if (response.ok && receipt) { await acceptReceipt(original, receipt, value, payload.work); return; }
      if (response.status >= 400 && response.status < 500 && payload.notCommitted === true) {
        settlePending(original, 'rejected'); pendingRef.current = null; setPending(null); setStopped(true);
        if (payload.code === 'WORK_EXISTS' && isMultiviewWorkId(payload.workId) || payload.code === 'WORK_REVISION_CONFLICT') {
          const conflictId = payload.workId || existing?.id;
          if (!isMultiviewWorkId(conflictId)) { setMessage('本次保存未受理，请重新核对作品后再主动保存；此设备修改仍保留。'); return; }
          const next = await readWork(conflictId, value);
          if (!current(value)) return;
          setWork(next); workRef.current = next; initialized.current = `${identity}:${next.id}:${info.sourceVersion}`;
          if (!editedTitle.current) setTitle(next.title);
          acknowledged.current = signature(next.recipe, next.title); setConflict(true);
          setMessage('服务器已有不同内容，此设备修改已保留。可打开服务器版本，或将本机修改另存一版。');
        } else setMessage(payload.error || '本次保存未受理，当前修改保留，可调整后重试。');
        return;
      }
      setMessage('保存结果待确认，当前修改保留；请查询原保存，不会重复发送。');
    } catch (cause) {
      if (current(value)) { if (!sent) setStopped(true); setMessage(sent ? '保存结果待确认，请查询原保存；当前修改仍保留。' : cause instanceof Error ? cause.message : '尚未保存，当前修改仅保留在此设备。'); }
    } finally { if (lock.current === token) { lock.current = null; setBusy(false); } }
  }
  const sendRef = useRef(send); sendRef.current = send;
  const recipeRef = useRef(recipe); recipeRef.current = recipe;
  useEffect(() => {
    if (!options.enabled || !hydrated || loadedIdentity !== identity || loading || !recipeRef.current || pending || busy || conflict || stopped || storageFailed || !work && !options.allowCreate
      || work && (!work.recipe || initialized.current !== `${identity}:${work.id}:${options.info?.sourceVersion}`) || localSignature === acknowledged.current) return;
    const timer = window.setTimeout(() => void sendRef.current(work ? 'save' : 'create'), 750);
    return () => window.clearTimeout(timer);
  }, [options.enabled, options.allowCreate, options.info?.sourceVersion, hydrated, loadedIdentity, loading, localSignature, pending, busy, conflict, stopped, storageFailed, work, identity]);
  useEffect(() => {
    if (!work || !options.enabled || !['waiting_source', 'queued', 'rendering'].includes(work.status)) return;
    const value = scope(); let cancelled = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await readWork(work.id, value);
        if (cancelled || !current(value)) return;
        if (!pendingRef.current && initialized.current && workRef.current?.recipe && next.revision !== workRef.current.revision
          && signature(appliedWorkRecipe(live.current.draft, live.current.info), titleRef.current) !== signature(next.recipe, next.title)) { setConflict(true); setMessage('服务器作品已有更新，此设备修改保留。'); }
        setWork(next); workRef.current = next;
        if (['waiting_source', 'queued', 'rendering'].includes(next.status)) timer = setTimeout(() => void poll(), 4000);
      } catch { if (!cancelled && current(value)) setMessage('拼图准备状态暂不可查询，可重新读取；原已保存成果保留。'); }
    };
    timer = setTimeout(() => void poll(), 2500);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [work?.id, work?.status, options.enabled, identity]);
  function openServer() {
    if (!current(scope()) || !work?.recipe || !options.info || work.sourceVersion !== options.info.sourceVersion || pendingRef.current || busy) return;
    live.current.onRestore(work.recipe); setTitle(work.title); editedTitle.current = false;
    try { if (titleKey) localStorage.setItem(titleKey, work.title); }
    catch { setStorageFailed(true); }
    acknowledged.current = signature(work.recipe, work.title); setConflict(false); setStopped(false); setMessage('已打开服务器版本。');
  }
  const changed = Boolean(recipe && work && localSignature !== acknowledged.current);
  const phase = busy ? 'saving' : pending ? 'unknown' : conflict ? 'conflict' : !work ? 'local'
    : changed ? 'local' : work.status === 'ready' && work.ready?.revision === work.draftRevision ? 'saved' : work.status === 'failed' ? 'failed' : 'preparing';
  return { work, title, phase, loading, busy, pending: Boolean(pending), conflict, message, storageFailed, changed,
    unsaved: storageFailed && (editedTitle.current || Boolean(pending)),
    canBranch: Boolean(work?.recipe && options.info && work.sourceVersion === options.info.sourceVersion && work.sourceState === 'current' && !work.removed && title.trim() && !pending && !busy),
    canRetrySave: Boolean(stopped && hydrated && work?.recipe && !conflict && !pending && !storageFailed),
    setTitle: (value: string) => { editedTitle.current = true; setTitle(value); }, openServer,
    create: () => send('create'), branch: () => send('branch'), queryOriginal,
    retry: () => { setRetry(value => value + 1); }, retrySave: () => { setStopped(false); setMessage(''); },
  };
}
