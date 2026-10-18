'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, History, RefreshCw, RotateCcw, Search, SlidersHorizontal, ChevronDown, ChevronUp } from 'lucide-react';
import PaginationControls from '@/components/PaginationControls';
import { RelativeTime } from '@/components/RelativeTime';
import { useProductDialog } from '@/components/useProductDialog';
import { useUnsavedNavigation } from '@/lib/hooks/use-unsaved-navigation';
import type { PricingAdminAction, PricingAdminBasis, PricingAdminChanges, PricingAdminError, PricingAdminFilter, PricingAdminOperation, PricingAdminPreview, PricingAdminPreviewInput, PricingAdminRow, PricingAdminRowChange, PricingAdminSnapshot } from '@/lib/pricing/admin-contract';
import { consumePricingAdminDraft, defaultPricingAdminView, filterPricingAdminRows, parsePricingAdminPending, parsePricingAdminWorkspace, patchPricingAdminRow, pricingAdminPreviewKey, pricingAdminStorageKey, submittedPricingAdminDraft, validPricingAdminRate, type PricingAdminDraft, type PricingAdminPending, type PricingAdminView } from '@/lib/pricing/admin-client-state';
import PricingSourceEditor from './PricingSourceEditor';
import PricingHistory from './PricingHistory';
import styles from './pricing.module.css';

const endpoint = '/api/admin/pricing';
const basisLabel = (basis: PricingAdminBasis) => basis === 'site_base_cny' ? '站内人民币基价' : '供应商实际成本';
const unitLabel = (row: PricingAdminRow) => row.identity.unit === 'image' ? '张' : '秒';
const modeLabel: Record<PricingAdminRow['mode'], string> = { follow: '跟随标准', custom: '单独设置', free: '明确免费', legacy_fixed: '保留原价', legacy_actual: '原费用合同', unset: '待设置' };
const hasChanges = (changes: PricingAdminChanges) => Boolean(changes.rows.length || Object.keys(changes.standards || {}).length);

export default function AdminPricingClient({ actorId }: { actorId: string }) {
  const [snapshot, setSnapshot] = useState<PricingAdminSnapshot | null>(null);
  const [draft, setDraft] = useState<PricingAdminDraft>({ revision: '', changes: { rows: [] } });
  const [view, setView] = useState<PricingAdminView>(defaultPricingAdminView);
  const [pending, setPending] = useState<PricingAdminPending | null>(null);
  const [selected, setSelected] = useState<string[]>([]), [allMatched, setAllMatched] = useState(false);
  const [restore, setRestore] = useState<PricingAdminAction | null>(null);
  const [previewResult, setPreviewResult] = useState<{ key: string; data: PricingAdminPreview } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false), [reading, setReading] = useState(true), [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(''), [fields, setFields] = useState<Record<string, string>>({});
  const [previewMessage, setPreviewMessage] = useState('');
  const [readError, setReadError] = useState(''), [denied, setDenied] = useState(false), [hydrated, setHydrated] = useState(false);
  const [storageFailed, setStorageFailed] = useState(false), [operationStorageFailed, setOperationStorageFailed] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false), [previewNonce, setPreviewNonce] = useState(0);
  const [identityVerified, setIdentityVerified] = useState(false);
  const { confirm, productDialog } = useProductDialog();
  const currentActor = useRef(actorId), alive = useRef(true), saveLock = useRef(false), restored = useRef(false);
  const pendingRef = useRef<PricingAdminPending | null>(null), draftRef = useRef(draft), viewRef = useRef(view);
  const restoredAnchor = useRef(false), userInteracted = useRef(false);
  const scrollAnchor = useRef<{ anchorId: string; anchorOffset: number } | null>(null), readSequence = useRef(0);
  draftRef.current = draft; viewRef.current = view; pendingRef.current = pending;
  const unauthorized = useCallback(() => {
    setDenied(true); setSnapshot(null); setHistoryOpen(false); setPreviewResult(null); setSelected([]);
    setDraft({ revision: '', changes: { rows: [] } }); setPending(null); setHydrated(false);
  }, []);
  const authorized = useCallback((response: Response) => {
    if (response.status === 401 || response.status === 403) { unauthorized(); return false; }
    return true;
  }, [unauthorized]);
  const active = useCallback(() => alive.current && currentActor.current === actorId, [actorId]);

  const load = useCallback(async (initialize = false) => {
    const sequence = ++readSequence.current;
    setReading(true); setReadError(''); setPreviewResult(null);
    try {
      const response = await fetch(endpoint, { cache: 'no-store', headers: { 'x-app-session-user': actorId } });
      if (!active() || sequence !== readSequence.current || !authorized(response)) return;
      const data = await response.json() as PricingAdminSnapshot & PricingAdminError;
      if (!active() || sequence !== readSequence.current) return;
      if (data.code === 'pricing_actor_changed' || response.ok && data.actor?.id !== actorId) { unauthorized(); return; }
      if (!response.ok || data.schemaVersion !== 1 || data.actor?.id !== actorId || !Array.isArray(data.rows)) throw new Error(data.error || '费率读取失败，请重新读取');
      setSnapshot(data); setDenied(false); setIdentityVerified(true);
      if (initialize && !restored.current) {
        restored.current = true;
        let nextDraft: PricingAdminDraft = { revision: data.revision, changes: { rows: [] } }, nextView = { ...defaultPricingAdminView };
        try {
          const workspace = parsePricingAdminWorkspace(localStorage.getItem(pricingAdminStorageKey(actorId, 'workspace')), actorId);
          if (workspace) { nextDraft = workspace.draft; nextView = workspace.view; }
          const rawOperation = localStorage.getItem(pricingAdminStorageKey(actorId, 'operation'));
          const operation = parsePricingAdminPending(rawOperation, actorId);
          if (rawOperation && !operation) { setOperationStorageFailed(true); setMessage('原保存记录无法读取。请保留此浏览器记录，联系管理员核对，暂不发起新保存。'); }
          if (operation) setPending(operation);
        } catch { setStorageFailed(true); setOperationStorageFailed(true); }
        const url = new URL(window.location.href), target = url.searchParams.get('ruleId');
        const explicitFilter: PricingAdminFilter = {};
        const kind = url.searchParams.get('kind');
        if (kind && ['all', 'video', 'image', 'enhance', 'h3'].includes(kind)) explicitFilter.kind = kind as PricingAdminFilter['kind'];
        for (const field of ['channelId', 'search'] as const) { const value = url.searchParams.get(field); if (value !== null) explicitFilter[field] = value.slice(0, field === 'search' ? 200 : 500); }
        if (Object.keys(explicitFilter).length) nextView = { ...nextView, filter: { kind: 'all', difference: 'all', ...explicitFilter }, page: 1, anchorId: '' };
        if (target) {
          const row = data.rows.find(item => item.id === target);
          nextView = { ...nextView, filter: { kind: 'all', search: row?.label || target }, page: 1,
            expanded: row ? [target] : [], anchorId: row ? target : '', anchorOffset: 0 };
        }
        setDraft(nextDraft); setView(nextView); setHydrated(true);
      }
    } catch (error) { if (active() && sequence === readSequence.current) setReadError(error instanceof Error ? error.message : '费率暂不可读取'); }
    finally { if (active() && sequence === readSequence.current) setReading(false); }
  }, [active, actorId, authorized, unauthorized]);

  useEffect(() => {
    alive.current = true; currentActor.current = actorId; restored.current = false; restoredAnchor.current = false; userInteracted.current = false;
    saveLock.current = false; scrollAnchor.current = null; setOperationStorageFailed(false); setStorageFailed(false); setIdentityVerified(false);
    setSnapshot(null); setHydrated(false); setDenied(false); setPending(null); setSelected([]); setRestore(null);
    void load(true);
    return () => { alive.current = false; };
  }, [actorId, load]);

  const persistWorkspace = useCallback(() => {
    if (!hydrated || denied) return;
    try {
      localStorage.setItem(pricingAdminStorageKey(actorId, 'workspace'), JSON.stringify({ schema: 1, actorId, draft: draftRef.current, view: { ...viewRef.current, ...scrollAnchor.current } }));
      setStorageFailed(false);
    } catch { setStorageFailed(true); }
  }, [actorId, denied, hydrated]);
  useEffect(() => { persistWorkspace(); }, [draft, view, persistWorkspace]);
  useEffect(() => {
    if (!hydrated || denied) return;
    let frame = 0;
    const savePosition = () => {
      frame = 0;
      const row = Array.from(document.querySelectorAll<HTMLElement>('[data-pricing-row]')).find(element => element.getBoundingClientRect().bottom > 0);
      if (row) scrollAnchor.current = { anchorId: row.dataset.pricingRow || '', anchorOffset: row.getBoundingClientRect().top };
      persistWorkspace();
    };
    const scroll = () => { if (!frame) frame = requestAnimationFrame(savePosition); };
    const interaction = () => { userInteracted.current = true; };
    const storage = (event: StorageEvent) => {
      if (event.key !== pricingAdminStorageKey(actorId, 'operation')) return;
      const operation = parsePricingAdminPending(event.newValue, actorId);
      if (operation) { setPending(operation); setMessage('另一页签有保存待核对，请先查询原回执。'); }
      else if (pendingRef.current) setMessage('原操作记录在另一页签发生变化，请查询原回执后继续。');
    };
    window.addEventListener('scroll', scroll, { passive: true });
    window.addEventListener('pointerdown', interaction, { once: true }); window.addEventListener('keydown', interaction, { once: true });
    window.addEventListener('pagehide', savePosition); window.addEventListener('storage', storage);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('scroll', scroll); window.removeEventListener('pointerdown', interaction); window.removeEventListener('keydown', interaction); window.removeEventListener('pagehide', savePosition); window.removeEventListener('storage', storage); };
  }, [actorId, denied, hydrated, persistWorkspace]);
  useEffect(() => {
    if (!hydrated || denied) return;
    const visibility = () => {
      setIdentityVerified(false);
      setHistoryOpen(false);
      window.dispatchEvent(new CustomEvent('sd2-time-bubble', { detail: 'pricing-session-check' }));
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', visibility);
    return () => document.removeEventListener('visibilitychange', visibility);
  }, [hydrated, denied, load]);
  useEffect(() => {
    if (!hydrated || !snapshot || restoredAnchor.current) return;
    restoredAnchor.current = true;
    if (userInteracted.current || !view.anchorId) return;
    const element = Array.from(document.querySelectorAll<HTMLElement>('[data-pricing-row]')).find(row => row.dataset.pricingRow === view.anchorId);
    if (element) window.scrollBy({ top: element.getBoundingClientRect().top - view.anchorOffset, behavior: 'auto' });
  }, [hydrated, snapshot, view.anchorId, view.anchorOffset]);
  useEffect(() => {
    if (!storageFailed || !hasChanges(draft.changes)) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protect); return () => window.removeEventListener('beforeunload', protect);
  }, [draft.changes, storageFailed]);
  useUnsavedNavigation(storageFailed && hasChanges(draft.changes), confirm, {
    unsaved: storageFailed && hasChanges(draft.changes) ? ['无法恢复的费率草稿'] : [], busy: [], onBlocked: setMessage,
  });

  const filtered = useMemo(() => filterPricingAdminRows(snapshot?.rows || [], view.filter, view.sort), [snapshot, view.filter, view.sort]);
  const pages = Math.max(1, Math.ceil(filtered.length / view.pageSize)), page = Math.min(view.page, pages);
  const visible = filtered.slice((page - 1) * view.pageSize, page * view.pageSize);
  const dirty = hasChanges(draft.changes), conflict = Boolean(snapshot && dirty && draft.revision !== snapshot.revision);
  const action: PricingAdminAction = restore || (selected.length ? { kind: 'unify', basisKind: view.basis, ruleIds: [...selected].sort() } : { kind: 'save', changes: draft.changes });
  const simulationRow = snapshot?.rows.find(row => row.id === view.simulationRowId) || filtered[0];
  const input: PricingAdminPreviewInput | null = snapshot ? {
    expectedRevision: snapshot.revision, catalogFingerprint: snapshot.catalogFingerprint, action,
    ...(simulationRow ? { simulation: { rowId: simulationRow.id, quantity: view.quantity, ...(simulationRow.identity.billingMode === 'actual' && view.exampleAmount ? { exampleAmount: view.exampleAmount } : {}) } } : {}),
  } : null;
  const inputKey = input ? pricingAdminPreviewKey(input) : '';
  const preview = previewResult?.key === inputKey ? previewResult.data : null;
  const actionable = action.kind !== 'save' || dirty;

  useEffect(() => {
    setPreviewResult(null); setFields({}); setPreviewMessage('');
    if (!input || !hydrated || denied || conflict || reading) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setPreviewBusy(true);
      try {
        const response = await fetch(`${endpoint}/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-app-session-user': actorId }, body: inputKey, signal: controller.signal });
        if (!active() || !authorized(response)) return;
        const data = await response.json() as PricingAdminPreview & PricingAdminError;
        if (controller.signal.aborted || !active()) return;
        if (data.code === 'pricing_actor_changed') { unauthorized(); return; }
        if (!response.ok) { setFields(data.fields || {}); if (response.status === 409) setReadError('服务器费率或目录已变化，请重新读取后核对，输入仍保留。'); throw new Error(data.error || '预览暂不可用'); }
        if (!data.previewToken || !Array.isArray(data.changes)) throw new Error('预览未完整返回，请重新预览');
        setPreviewResult({ key: inputKey, data });
      } catch (error) { if (!controller.signal.aborted && active()) setPreviewMessage(error instanceof Error ? error.message : '预览暂不可用'); }
      finally { if (!controller.signal.aborted && active()) setPreviewBusy(false); }
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); setPreviewBusy(false); };
    // The immutable serialized input is also the stale-response guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputKey, previewNonce, hydrated, denied, conflict, reading, active, authorized]);

  function editRow(id: string, patch: Omit<PricingAdminRowChange, 'id'>) {
    setSelected([]); setAllMatched(false); setRestore(null);
    setDraft(current => ({ revision: hasChanges(current.changes) ? current.revision : snapshot?.revision || '', changes: patchPricingAdminRow(current.changes, id, patch) }));
  }
  function changeFilter(patch: PricingAdminFilter) {
    scrollAnchor.current = null;
    setView(current => ({ ...current, filter: { ...current.filter, ...patch }, page: 1, anchorId: '' }));
    if (selected.length) setMessage('筛选范围已变化，已清除批量选择；手填草稿仍保留。');
    setSelected([]); setAllMatched(false); setRestore(null);
  }
  function changePage(next: number) {
    scrollAnchor.current = null;
    setView(current => ({ ...current, page: next, anchorId: '' }));
    if (!allMatched) { setSelected([]); if (selected.length) setMessage('已切换页面并清除本页批量选择；手填草稿仍保留。'); }
  }
  function rememberOperation(operation: PricingAdminPending) {
    const key = pricingAdminStorageKey(actorId, 'operation');
    let existing: string | null;
    try { existing = localStorage.getItem(key); }
    catch { setOperationStorageFailed(true); throw new Error('此浏览器无法可靠记录原保存，未提交。'); }
    if (existing) {
      const original = parsePricingAdminPending(existing, actorId);
      if (original) setPending(original);
      else setOperationStorageFailed(true);
      throw new Error('已有保存需要核对，未发起新保存。');
    }
    try {
      localStorage.setItem(key, JSON.stringify(operation));
      if (localStorage.getItem(key) !== JSON.stringify(operation)) throw new Error('无法可靠保存原操作，未提交。');
    } catch { setOperationStorageFailed(true); throw new Error('此浏览器无法可靠记录原保存，未提交。'); }
    pendingRef.current = operation; setPending(operation);
  }
  function forgetOperation(operation: PricingAdminPending) {
    const key = pricingAdminStorageKey(actorId, 'operation');
    try {
      const saved = parsePricingAdminPending(localStorage.getItem(key), actorId);
      if (saved?.payload.operationId === operation.payload.operationId) localStorage.removeItem(key);
    } catch { setOperationStorageFailed(true); }
    if (pendingRef.current?.payload.operationId === operation.payload.operationId) { pendingRef.current = null; setPending(null); }
  }
  async function applyReceipt(receipt: PricingAdminOperation, operation: PricingAdminPending) {
    if (receipt.operationId !== operation.payload.operationId) throw new Error('回执与原保存不匹配，请保留原操作继续核对。');
    if (receipt.state === 'unknown') { setMessage('保存结果待确认。继续编辑会保留为独立草稿，不会重复提交。'); return; }
    if (receipt.inputFingerprint !== null && receipt.inputFingerprint !== operation.inputFingerprint) throw new Error('回执内容与原保存不匹配，请保留原操作继续核对。');
    if (receipt.state === 'rejected') {
      forgetOperation(operation); setFields(receipt.error?.fields || {}); setMessage(receipt.error?.message || '本次保存未生效，输入已保留。');
      await load(); return;
    }
    if (receipt.state !== 'succeeded' || !receipt.inputFingerprint || !receipt.snapshot || receipt.snapshot.actor.id !== actorId || !receipt.revision) throw new Error('成功回执不完整，请查询原操作。');
    setDraft(current => ({ revision: current.revision === operation.payload.expectedRevision ? receipt.revision! : current.revision,
      changes: consumePricingAdminDraft(current.changes, operation.submittedDraft) }));
    setSnapshot(receipt.snapshot); forgetOperation(operation); setSelected([]); setRestore(null); setAllMatched(false);
    setPreviewResult(null); setMessage('已保存，仅影响新任务。后续草稿已保留。'); await load();
  }
  const queryReceipt = useCallback(async (operation: PricingAdminPending) => {
    if (saveLock.current || denied) return;
    saveLock.current = true; setSaving(true);
    try {
      const response = await fetch(`${endpoint}/operations/${encodeURIComponent(operation.payload.operationId)}`, { cache: 'no-store', headers: { 'x-app-session-user': actorId } });
      if (!active() || !authorized(response)) return;
      const data = await response.json();
      if (!active()) return;
      if (data.code === 'pricing_actor_changed') { unauthorized(); return; }
      if (!response.ok) throw new Error(data.error || '原回执暂不可读取。没有回执不代表未保存。');
      await applyReceipt(data, operation);
    } catch (error) { if (active()) setMessage(error instanceof Error ? error.message : '保存结果待确认，请继续查询原回执。'); }
    finally { if (active()) { saveLock.current = false; setSaving(false); } }
    // Each pending record is immutable; querying never sends its payload again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, authorized, denied, actorId, load]);
  useEffect(() => {
    if (hydrated && pending && !denied) void queryReceipt(pending);
    // A restored/new unknown operation is checked once, never polled indefinitely.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, pending?.payload.operationId, denied]);

  async function save() {
    if (!input || !preview || !actionable || pendingRef.current || saveLock.current || conflict || denied || operationStorageFailed || reading) return;
    if (!Number.isFinite(Date.parse(preview.expiresAt)) || Date.parse(preview.expiresAt) <= Date.now()) { setMessage('预览已过期，请重新预览。'); setPreviewNonce(value => value + 1); return; }
    const operation: PricingAdminPending = { actorId, submittedAt: new Date().toISOString(), inputFingerprint: preview.inputFingerprint,
      payload: { ...input, operationId: crypto.randomUUID(), previewToken: preview.previewToken },
      submittedDraft: submittedPricingAdminDraft(draft.changes, action.kind === 'unify' ? { ...action, ruleIds: action.ruleIds.filter(id => !preview.skipped.some(item => item.id === id)) } : action) };
    saveLock.current = true; setSaving(true); setMessage('');
    try {
      rememberOperation(operation);
      const response = await fetch(endpoint, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'x-app-session-user': actorId }, body: JSON.stringify(operation.payload) });
      if (!active() || !authorized(response)) return;
      const data = await response.json();
      if (!active()) return;
      if (data.code === 'pricing_actor_changed') { unauthorized(); return; }
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && data.code && data.code !== 'pricing_operation_mismatch') {
          forgetOperation(operation); setFields(data.fields || {});
          if (response.status === 409) { setMessage('费率或预览已变化，未覆盖服务器。草稿已保留，请读取最新价格后重新预览。'); await load(); return; }
        }
        throw new Error(data.error || '保存结果待确认，请查询原回执。');
      }
      await applyReceipt(data, operation);
    } catch (error) { if (active()) setMessage(error instanceof Error ? error.message : '保存结果待确认，请查询原回执。'); }
    finally { if (active()) { saveLock.current = false; setSaving(false); } }
  }

  function exportCsv() {
    const params = new URLSearchParams();
    Object.entries(view.filter).forEach(([key, value]) => { if (value !== undefined && value !== '') params.set(key, String(value)); });
    void (async () => {
      try {
        const response = await fetch(`${endpoint}/export?${params}`, { cache: 'no-store', headers: { 'x-app-session-user': actorId } });
        if (!active() || !authorized(response)) return;
        if (!response.ok) { const data = await response.json(); if (data.code === 'pricing_actor_changed') { unauthorized(); return; } throw new Error(data.error || '导出失败'); }
        const blob = await response.blob(); if (!active()) return;
        const url = URL.createObjectURL(blob), link = document.createElement('a');
        link.href = url; link.download = `pricing-${snapshot?.revision || 'current'}.csv`; link.click(); URL.revokeObjectURL(url);
        setMessage('已导出当前筛选范围的生效费率，不含草稿。');
      } catch (error) { if (active()) setMessage(error instanceof Error ? error.message : '导出失败，请重试'); }
    })();
  }

  if (denied) return <main className={styles.page}><h1>点数与费率</h1><p role="status">当前账号无管理员权限或登录已失效。未继续读取或保存。</p><a className="btn btn-secondary" href="/login">重新登录</a></main>;
  if (!snapshot || snapshot.actor.id !== actorId || !hydrated) return <main className={styles.page}><h1>点数与费率</h1><p role="status">{readError || '正在读取当前费率'}</p>{readError && <button type="button" className="btn btn-secondary" onClick={() => void load(!hydrated)}>重新读取</button>}{productDialog}</main>;
  const standardsValue = draft.changes.standards?.[view.basis] ?? snapshot.standards[view.basis] ?? '';
  const pendingRows = draft.changes.rows.filter(row => !snapshot.rows.some(item => item.id === row.id));
  const selectedRows = snapshot.rows.filter(row => selected.includes(row.id));
  const displayChanges = preview?.changes || [];
  const skipped = preview?.skipped || [];
  const targetCount = action.kind === 'unify' ? Math.max(0, selected.length - skipped.length) : displayChanges.length;
  const simulation = preview?.simulation;
  const invalidRate = action.kind === 'save' && (Object.values(draft.changes.standards || {}).some(value => value !== undefined && !validPricingAdminRate(value))
    || draft.changes.rows.some(row => row.mode === 'custom' && !validPricingAdminRate(row.customPointsPerCny || '')));
  const canSave = Boolean(preview && actionable && (preview.changes.length || action.kind === 'save' && Object.keys(draft.changes.standards || {}).length
    || action.kind === 'restore' && action.standards?.length || action.kind === 'unify' && targetCount > 0))
    && !pending && !saving && !previewBusy && !conflict && !readError && !reading && !invalidRate && !operationStorageFailed;
  return <>{!identityVerified && <div className={styles.identityCheck} role="status">{readError || '正在核对当前账号'}{readError && <button type="button" className="btn btn-secondary" onClick={() => void load()}>重新读取</button>}</div>}<main className={styles.page} style={{ visibility: identityVerified ? undefined : 'hidden' }} aria-hidden={!identityVerified}>
    <header className={styles.header}><h1>点数与费率</h1><div className={styles.tools}>
      <button type="button" onClick={exportCsv}><Download size={17} />导出费率</button>
      <button type="button" onClick={() => setHistoryOpen(true)}><History size={17} />变更记录</button>
      <button type="button" title="重置视图，不清除草稿或费率" aria-label="重置视图，不清除草稿或费率" onClick={() => { scrollAnchor.current = null; setView({ ...defaultPricingAdminView }); setSelected([]); setRestore(null); }}><RotateCcw size={17} /></button>
    </div></header>
    <section className={styles.standard} aria-label="统一标准">
      <div className={styles.standardTop}><strong>统一标准</strong><label>1 元人民币 = <input aria-label="统一标准点每元" type="number" min={snapshot.limits.rateMin} max={snapshot.limits.rateMax} step="0.1" value={standardsValue} placeholder="未设置" onChange={event => {
        setSelected([]); setRestore(null); setDraft(current => ({ revision: hasChanges(current.changes) ? current.revision : snapshot.revision,
          changes: { ...current.changes, standards: { ...current.changes.standards, [view.basis]: event.target.value } } }));
      }} /> 点</label><span className={styles.muted}>{view.basis === 'site_base_cny' ? '目标点数 = 基价 × 点/元' : '实际费用 × 冻结汇率 × 点/元'}<small>新合同四舍五入至 1 位小数</small></span></div>
      <div className={styles.standardBottom}><label>计价依据<select value={view.basis} onChange={event => { setView(current => ({ ...current, basis: event.target.value as PricingAdminBasis })); setSelected([]); setRestore(null); }}><option value="site_base_cny">站内人民币基价</option><option value="supplier_cost_cny">供应商实际成本</option></select></label>
        <label>参照<select value={view.referenceId} onChange={event => setView(current => ({ ...current, referenceId: event.target.value }))}><option value="">未选择</option>{snapshot.rows.filter(row => row.basisKind === view.basis && row.currentPointsPerCny !== null).map(row => <option key={row.id} value={row.id}>{row.label} · {row.providerLabel} · {row.currentPointsPerCny} 点/元</option>)}</select></label>
        {view.referenceId && <button type="button" className={styles.link} onClick={() => { const row = snapshot.rows.find(item => item.id === view.referenceId); if (row?.currentPointsPerCny) { setSelected([]); setRestore(null); setDraft(current => ({ revision: hasChanges(current.changes) ? current.revision : snapshot.revision, changes: { ...current.changes, standards: { ...current.changes.standards, [view.basis]: row.currentPointsPerCny! } } })); } }}>采用参照标准</button>}
        {draft.changes.standards?.[view.basis] !== undefined && <span className={styles.muted}>生效值 {snapshot.standards[view.basis] ?? '未设置'}，当前为待保存调整</span>}
      </div>
    </section>
    {(readError || message || storageFailed || conflict || pending || operationStorageFailed) && <div className={styles.notice} role="status" aria-live="polite">
      {readError && <p>{readError} <button type="button" disabled={reading} onClick={() => void load()}>重新读取</button></p>}
      {message && <p>{message}</p>}
      {storageFailed && <p>此浏览器暂时无法保存现场，离开可能丢失未提交输入。</p>}
      {operationStorageFailed && <p>原操作存储暂不可核实，保存已暂停。请恢复浏览器存储后重新打开并核对原回执。</p>}
      {conflict && <p>草稿基于较早的费率，服务器当前为 {snapshot.revision}。<button type="button" disabled={Boolean(pending)} onClick={() => { setDraft(current => ({ ...current, revision: snapshot.revision })); setPreviewNonce(value => value + 1); }}>保留输入，基于当前价重新预览</button></p>}
      {pending && <p>原保存结果待确认 · <RelativeTime value={pending.submittedAt} /> <button type="button" disabled={saving} onClick={() => void queryReceipt(pending)}>查询原保存回执</button></p>}
    </div>}
    <div className={styles.filters}><div className={styles.tabs} role="tablist" aria-label="费率类型">{(['all', 'video', 'image', 'enhance', 'h3'] as const).map(kind => <button key={kind} type="button" role="tab" aria-selected={(view.filter.kind || 'all') === kind} onClick={() => changeFilter({ kind })}>{({ all: '全部', video: '视频', image: '图片', enhance: '视频增强', h3: 'H3' })[kind]}</button>)}</div>
      <label className={styles.search}><Search size={16} /><input aria-label="搜索型号或规格" placeholder="搜索型号 / 规格" maxLength={200} value={view.filter.search || ''} onChange={event => changeFilter({ search: event.target.value })} /></label>
      <select aria-label="供应商" value={view.filter.channelId || ''} onChange={event => changeFilter({ channelId: event.target.value })}><option value="">全部供应商</option>{Array.from(new Map(snapshot.rows.map(row => [row.identity.channelId, row.providerLabel])).entries()).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
      <select aria-label="差异筛选" value={view.filter.difference || 'all'} onChange={event => changeFilter({ difference: event.target.value as PricingAdminFilter['difference'] })}><option value="all">全部差异</option><option value="different">有差异</option><option value="unconfirmed">待核实</option><option value="custom">单独设置</option></select>
      <label className={styles.check}><input type="checkbox" checked={view.filter.defaultsOnly === true} onChange={event => changeFilter({ defaultsOnly: event.target.checked })} />仅默认</label>
      <select aria-label="排序" value={view.sort} onChange={event => { scrollAnchor.current = null; setView(current => ({ ...current, sort: event.target.value as PricingAdminView['sort'], page: 1 })); setSelected([]); setAllMatched(false); setRestore(null); }}><option value="catalog">目录顺序</option><option value="name">型号名称</option><option value="difference">差异优先</option></select>
    </div>
    <div className={styles.workbench}><section className={styles.list} aria-label="费率目录">
      <div className={styles.selection}><label className={styles.check}><input type="checkbox" aria-label="选择当前页" checked={visible.length > 0 && visible.every(row => selected.includes(row.id))} onChange={event => { setRestore(null); setAllMatched(false); setSelected(event.target.checked ? visible.map(row => row.id) : []); }} />{selected.length ? `已选 ${selected.length} 项` : `共 ${filtered.length} 项`}</label>
        {selected.length > 0 && <><button type="button" onClick={() => { setSelected([]); setAllMatched(false); }}>取消选择</button>{!allMatched && filtered.length > visible.length && <button type="button" onClick={() => { setSelected(filtered.map(row => row.id)); setAllMatched(true); }}>选择全部符合条件 {filtered.length} 项</button>}</>}
      </div>
      <div className={styles.tableHeader} aria-hidden="true"><span /><span>型号 / 规格</span><span>人民币基价</span><span>当前点/元</span><span>跟随方式</span><span>相对标准</span><span>单次点数</span><span /></div>
      {visible.map(row => {
        const change = draft.changes.rows.find(item => item.id === row.id), after = displayChanges.find(item => item.id === row.id)?.after;
        const basisKind = change?.basisKind || row.basisKind;
        const rate = change?.mode === 'custom' ? change.customPointsPerCny ?? '' : (change?.mode || row.mode) === 'follow' ? draft.changes.standards?.[basisKind] ?? snapshot.standards[basisKind] ?? '' : row.currentPointsPerCny ?? '';
        const mode = change?.mode || row.mode, expanded = view.expanded.includes(row.id);
        const changed = Boolean(change || after || draft.changes.standards?.[basisKind] !== undefined);
        return <div key={row.id} className={`${styles.rowBlock} ${selected.includes(row.id) ? styles.selected : ''}`} data-pricing-row={row.id}>
          <div className={styles.row}>
            <input type="checkbox" aria-label={`选择 ${row.label} ${row.providerLabel}`} checked={selected.includes(row.id)} onChange={event => { setRestore(null); setAllMatched(false); setSelected(current => event.target.checked ? [...current, row.id] : current.filter(id => id !== row.id)); }} />
            <div className={styles.model}><strong>{row.label}</strong><small>{row.providerLabel}{row.isDefault ? ' · 默认' : ''} · 每{unitLabel(row)}{!row.enabled ? ' · 已停用' : ''}</small><small>{Object.values(row.identity.specifications).join(' / ')}</small></div>
            <div className={styles.base} data-label="人民币基价">{row.baseCny !== null ? <><strong>¥{row.baseCny}</strong><small>{row.confirmation === 'confirmed' ? '已确认' : row.confirmation === 'needs_review' ? '待复核' : '待核实'}</small></> : <><span>{row.identity.billingMode === 'actual' ? '按实际成本' : '待核实'}</span><button type="button" className={styles.link} onClick={() => setView(current => ({ ...current, expanded: Array.from(new Set([...current.expanded, row.id])) }))}>{row.identity.billingMode === 'actual' ? '查看费用依据' : '补充基价'}</button></>}</div>
            <div className={styles.rate} data-label="当前点/元"><input type="number" min={snapshot.limits.rateMin} max={snapshot.limits.rateMax} step="0.1" maxLength={32} aria-label={`${row.label} ${row.providerLabel} 当前点每元`} value={rate} placeholder={row.mode === 'free' ? '免费' : '未设置'} onChange={event => editRow(row.id, { mode: 'custom', customPointsPerCny: event.target.value })} />
              {changed && <small>生效 {row.currentPointsPerCny ?? '待核'}，{action.kind === 'save' ? '待保存' : '目标见预览'}</small>}</div>
            <div className={styles.mode} data-label="跟随方式"><select aria-label={`${row.label} 跟随方式`} value={mode} onChange={event => {
              const next = event.target.value as 'follow' | 'custom' | 'free'; editRow(row.id, { mode: next, ...(next === 'custom' ? { customPointsPerCny: rate } : {}) });
            }}><option value="follow">跟随标准</option><option value="custom">单独设置</option><option value="free">明确免费</option>{['legacy_fixed', 'legacy_actual', 'unset'].includes(mode) && <option value={mode}>{modeLabel[mode]}</option>}</select>
              {mode === 'custom' && <button type="button" className={styles.link} onClick={() => editRow(row.id, { mode: 'follow' })}><RotateCcw size={13} />恢复跟随</button>}</div>
            <div className={styles.relative} data-label="相对标准"><span>{(after || (!changed ? row : null))?.relativeMultiplier ? `${(after || row).relativeMultiplier}×` : mode === 'free' ? '免费' : changed ? '待预览' : '无法判断'}</span><small>{(after || (!changed ? row : null))?.differencePercent ? `${(after || row).differencePercent}%` : !changed && !row.hasDifference && row.relativeMultiplier ? '一致' : ''}</small></div>
            <div className={styles.credits} data-label="单次点数">{row.identity.billingMode === 'actual' ? <><span>按费用计算</span><small>{row.exchangeRate ? `${row.exchangeRate.rate} CNY/${row.exchangeRate.sourceCurrency}` : '汇率待确认'}</small></> : <><strong>{after ? after.currentUnitCredits ?? '待核' : changed ? '待预览' : row.currentUnitCredits ?? '未设置'}</strong> 点/{unitLabel(row)}{changed && <small>原 {row.currentUnitCredits ?? '未设置'}</small>}</>}</div>
            <button type="button" className={styles.icon} title={expanded ? '收起来源与规格' : '展开来源与规格'} aria-label={`${expanded ? '收起' : '展开'} ${row.label} 来源与规格`} aria-expanded={expanded} onClick={() => setView(current => ({ ...current, expanded: expanded ? current.expanded.filter(id => id !== row.id) : [...current.expanded, row.id] }))}>{expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</button>
          </div>
          {expanded && <><PricingSourceEditor row={row} change={change} onChange={patch => editRow(row.id, patch)} /><div className={styles.rowTools}><button type="button" onClick={() => setView(current => ({ ...current, referenceId: row.id }))}>设为参照</button>{change && <button type="button" onClick={() => setDraft(current => ({ ...current, changes: { ...current.changes, rows: current.changes.rows.filter(item => item.id !== row.id) } }))}>放弃此行调整</button>}</div></>}
          {Object.entries(fields).filter(([key]) => key.includes(row.id)).map(([key, value]) => <p key={key} className={styles.fieldError} role="status">{value}</p>)}
        </div>;
      })}
      {!visible.length && <p className={styles.empty}>没有符合条件的型号。<button type="button" onClick={() => changeFilter({ kind: 'all', difference: 'all', search: '', channelId: '', defaultsOnly: false, basisKind: undefined })}>清除筛选</button></p>}
      <div className={styles.pagination}><PaginationControls page={page} totalPages={pages} total={filtered.length} pageSize={view.pageSize} onPageChange={changePage} label="费率" /><select aria-label="每页数量" value={view.pageSize} onChange={event => { scrollAnchor.current = null; setView(current => ({ ...current, pageSize: Number(event.target.value), page: 1 })); setSelected([]); setAllMatched(false); setRestore(null); }}><option value={12}>12 项/页</option><option value={24}>24 项/页</option><option value={48}>48 项/页</option></select></div>
    </section>
    <aside className={styles.preview} aria-label="费率预览与试算">
      <h2>{action.kind === 'unify' ? '统一预览' : action.kind === 'restore' ? '恢复预览' : '调整预览'}</h2>
      <p className={styles.muted}>{selected.length ? `已选 ${selected.length} 项${allMatched ? '（全部符合条件）' : '（本页选择）'}` : `${displayChanges.length} 项受影响`} · 尚未生效</p>
      {action.kind === 'unify' && <p className={styles.muted}>按已生效的{basisLabel(view.basis)}标准 {snapshot.standards[view.basis] ?? '未设置'} 点/元统一，不带入其它手填草稿。</p>}
      {action.kind === 'unify' && selectedRows.some(row => draft.changes.rows.some(change => change.id === row.id)) && <p>所选行的手填费率将按此预览替换，来源草稿保留。</p>}
      {action.kind === 'save' && Object.keys(draft.changes.standards || {}).length > 0 && <p className={styles.muted}>统一标准变化会包含全部跟随项，含其它页；单独设置保持绝对费率。</p>}
      {previewBusy && <p role="status">正在预览</p>}
      {previewMessage && <p role="status">{previewMessage}</p>}
      {preview && action.kind === 'unify' && targetCount > displayChanges.length && <p className={styles.muted}>{targetCount - displayChanges.length} 项已跟随当前标准，无需改价。</p>}
      <div className={styles.previewChanges}>{displayChanges.map(change => <div key={change.id}><span>{change.label}<small>{snapshot.rows.find(row => row.id === change.id)?.providerLabel}</small>
        {change.before.mode !== change.after.mode && <small>{modeLabel[change.before.mode]} → {modeLabel[change.after.mode]}</small>}
        {change.before.baseCny !== change.after.baseCny && <small>基价 ¥{change.before.baseCny ?? '待核'} → ¥{change.after.baseCny ?? '待核'}</small>}
        {change.before.relativeMultiplier !== change.after.relativeMultiplier && <small>相对标准 {change.before.relativeMultiplier ?? '待核'}× → {change.after.relativeMultiplier ?? '待核'}×</small>}
      </span><span>{change.before.currentUnitCredits ?? change.before.currentPointsPerCny ?? '待核'} → <strong>{change.after.currentUnitCredits ?? change.after.currentPointsPerCny ?? '待核'}</strong><small>{change.after.currentUnitCredits !== null ? `点/${snapshot.rows.find(row => row.id === change.id)?.identity.unit === 'second' ? '秒' : '张'}` : '点/元'}</small></span></div>)}</div>
      {skipped.length > 0 && <details><summary>有 {skipped.length} 项未参与，保留原价</summary><ul>{skipped.map(item => <li key={item.id}>{snapshot.rows.find(row => row.id === item.id)?.label || item.id}：{item.reason}</li>)}</ul></details>}
      <h2 className={styles.simTitle}>费用试算</h2>
      <label>型号与规格<select value={simulationRow?.id || ''} onChange={event => setView(current => ({ ...current, simulationRowId: event.target.value }))}>{snapshot.rows.map(row => <option key={row.id} value={row.id}>{row.label} · {row.providerLabel} · {Object.values(row.identity.specifications).join('/') || '通用'}</option>)}</select></label>
      <label>{simulationRow?.identity.unit === 'second' ? '时长（秒）' : '图片数量'}<input type="text" inputMode="decimal" maxLength={32} value={view.quantity} onChange={event => setView(current => ({ ...current, quantity: event.target.value }))} /></label>
      {simulationRow?.identity.billingMode === 'actual' && <label>示例账单金额（{simulationRow.exchangeRate?.sourceCurrency || '原币待确认'}）<input type="text" inputMode="decimal" maxLength={32} value={view.exampleAmount} onChange={event => setView(current => ({ ...current, exampleAmount: event.target.value }))} /></label>}
      <dl className={styles.simulation}><div><dt>当前</dt><dd>{simulation?.currentCredits ?? '待试算'} 点</dd></div><div><dt>调整后</dt><dd>{simulation?.adjustedCredits ?? '待试算'} 点</dd></div>{simulation?.authorizedMaximumCredits && <div><dt>授权预留上限</dt><dd>{simulation.authorizedMaximumCredits} 点</dd></div>}</dl>
      {simulation?.isExample && <p>示例演算，不是供应商报价。</p>}{simulation?.roundedToZero && <p>本次取整为 0 点，不代表免费。</p>}{simulation?.reason && <p>{simulation.reason}</p>}
      <p className={styles.muted}>仅试算，不生成或扣点。</p>
      <button type="button" className={styles.link} disabled={previewBusy || reading || conflict} onClick={() => setPreviewNonce(value => value + 1)}><RefreshCw size={14} />重新预览</button>
    </aside></div>
    {pendingRows.length > 0 && <div className={styles.notice}>有 {pendingRows.length} 项草稿对应的目录已不存在，未自动丢弃或迁移。<button type="button" onClick={() => setDraft(current => ({ ...current, changes: { ...current.changes, rows: current.changes.rows.filter(row => snapshot.rows.some(item => item.id === row.id)) } }))}>移除这些失效草稿</button></div>}
    {Object.entries(fields).map(([key, value]) => <p key={key} className={styles.fieldError} role="status">{key}：{value}</p>)}
    {invalidRate && <p role="status">点/元须为 0.1–10000.0，最多 1 位小数。免费请明确选择“免费”。</p>}
    <div className={styles.revision}>生效记录：{snapshot.updatedAt ? <RelativeTime value={snapshot.updatedAt} /> : '尚未设置统一策略，保留原价'}{snapshot.updatedBy ? ` · ${snapshot.updatedBy.displayName}` : ''} · {snapshot.revision}</div>
    <footer className={styles.savebar}><div><strong>{action.kind === 'unify' ? `将统一 ${targetCount} 项费率` : action.kind === 'restore' ? `将恢复 ${displayChanges.length} 项费率` : dirty ? `将保存 ${displayChanges.length} 项费率调整` : '当前生效费率'}</strong><span>只影响新任务，已有任务保持原价。</span></div><div className={styles.tools}>
      {actionable && <button type="button" disabled={saving} onClick={() => { if (action.kind === 'save') setDraft({ revision: snapshot.revision, changes: { rows: [] } }); setSelected([]); setRestore(null); setAllMatched(false); }}>放弃本次调整</button>}
      <button type="button" className="btn btn-primary" disabled={!canSave} onClick={() => void save()}><SlidersHorizontal size={17} />{saving ? '正在核对' : pending ? '保存待确认' : action.kind === 'unify' ? `一键统一（${targetCount}项）` : action.kind === 'restore' ? '恢复所选' : dirty ? '保存调整' : '无待保存调整'}</button>
    </div></footer>
    {historyOpen && <PricingHistory snapshot={snapshot} onUnauthorized={unauthorized} onClose={() => setHistoryOpen(false)} onRestore={candidate => { setRestore(candidate); setSelected([]); setAllMatched(false); }} />}
    {productDialog}
  </main></>;
}
