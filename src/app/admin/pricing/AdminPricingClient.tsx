'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, History, RefreshCw, RotateCcw, Search, SlidersHorizontal, ChevronDown, ChevronUp, Save } from 'lucide-react';
import PaginationControls from '@/components/PaginationControls';
import { RelativeTime } from '@/components/RelativeTime';
import { useProductDialog } from '@/components/useProductDialog';
import { useUnsavedNavigation } from '@/lib/hooks/use-unsaved-navigation';
import type { PricingAdminAction, PricingAdminBasis, PricingAdminChanges, PricingAdminError, PricingAdminFilter, PricingAdminOperation, PricingAdminPreview, PricingAdminPreviewInput, PricingAdminRow, PricingAdminRowChange, PricingAdminSnapshot } from '@/lib/pricing/admin-contract';
import { consumePricingAdminDraft, defaultPricingAdminView, filterPricingAdminRows, hasPricingAdminChanges, parsePricingAdminPending, parsePricingAdminWorkspace, patchPricingAdminRow, pricingAdminEnhanceGroup, pricingAdminPreviewForSource, pricingAdminPreviewKey, pricingAdminScenarioDifference, pricingAdminStorageKey, stagePricingAdminMemberExit, stagePricingAdminUnify, submittedPricingAdminDraft, validPricingAdminRate, validPricingEnhanceGroup, type PricingAdminDraft, type PricingAdminPending, type PricingAdminView } from '@/lib/pricing/admin-client-state';
import { RECOMMENDED_POINTS_PER_CNY, stageGptImageReference, stageVideoPricingReferences } from '@/lib/pricing/presets';
import { isSeedanceVideoDuration } from '@/lib/provider/seedance-models';
import type { PricingEnhanceGroup } from '@/lib/pricing/pricing-authoring-contract';
import { multiplyDecimal, roundDecimal } from '@/lib/pricing/math';
import PricingSourceEditor from './PricingSourceEditor';
import PricingHistory from './PricingHistory';
import styles from './pricing.module.css';

const endpoint = '/api/admin/pricing';
const basisLabel = (basis: PricingAdminBasis) => basis === 'site_base_cny' ? '站内人民币基价' : '供应商实际成本';
const modeLabel: Record<PricingAdminRow['mode'], string> = { follow: '跟随标准', custom: '单独设置', free: '明确免费', legacy_fixed: '保留原价', legacy_actual: '原费用合同', unset: '待设置' };
const hasChanges = hasPricingAdminChanges;
const rateModeLabel = (row: Pick<PricingAdminRow, 'mode' | 'authoringRateMode'>) => row.authoringRateMode === 'follow_global' ? '跟随统一' : row.authoringRateMode === 'legacy_follow' ? '沿用旧标准' : modeLabel[row.mode];
const specsLabel = (specifications: Record<string, string>) => Object.entries(specifications).map(([key, value]) => key === 'referenceVideo' ? ({ none: '无参考视频', present: '有参考视频', unknown: '参考视频待确认' } as Record<string, string>)[value] || value : key === 'pricingPurpose' ? ({ standard: '普通生成', draft: '草稿', draft_upgrade: '草稿升级', unknown: '用途待确认' } as Record<string, string>)[value] || value : value).join(' / ');

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
  const [previewLimit, setPreviewLimit] = useState(24);
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
        let nextDraft: PricingAdminDraft = { revision: data.revision, authoringRevision: data.authoring?.revision, catalogFingerprint: data.catalogFingerprint, changes: { rows: [] } }, nextView = { ...defaultPricingAdminView };
        try {
          const workspace = parsePricingAdminWorkspace(localStorage.getItem(pricingAdminStorageKey(actorId, 'workspace')), actorId);
          if (workspace) { nextDraft = hasChanges(workspace.draft.changes) ? workspace.draft : nextDraft; nextView = workspace.view; }
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

  const filtered = useMemo(() => {
    const rows = filterPricingAdminRows(snapshot?.rows || [], view.filter, view.sort);
    if (view.filter.kind !== 'video') return rows;
    return [...rows].sort((a, b) => (a.identity.specifications.resolution || 'zzz').localeCompare(b.identity.specifications.resolution || 'zzz', undefined, { numeric: true })
      || specsLabel(a.identity.specifications).localeCompare(specsLabel(b.identity.specifications)) || a.label.localeCompare(b.label));
  }, [snapshot, view.filter, view.sort]);
  const pages = Math.max(1, Math.ceil(filtered.length / view.pageSize)), page = Math.min(view.page, pages);
  const visible = filtered.slice((page - 1) * view.pageSize, page * view.pageSize);
  const dirty = hasChanges(draft.changes), conflict = Boolean(snapshot && dirty && (draft.revision !== snapshot.revision
    || draft.authoringRevision !== snapshot.authoring?.revision || draft.catalogFingerprint !== snapshot.catalogFingerprint));
  const action: PricingAdminAction = restore || { kind: 'save', changes: draft.changes };
  const scenarioRows = snapshot?.rows || [];
  const validDuration = /^\d+(?:\.\d+)?$/.test(view.quantity) && Number(view.quantity) > 0 && Number(view.quantity) <= 10000000;
  const scenarios = scenarioRows.filter(row => row.identity.unit === 'image' || validDuration
    && (row.identity.kind !== 'video' || isSeedanceVideoDuration(Number(view.quantity), row.identity.modelId)))
    .map(row => ({ rowId: row.id, quantity: row.identity.unit === 'image' ? '1' : view.quantity,
      ...(row.identity.billingMode === 'actual' && view.simulationRowId === row.id && view.exampleAmount ? { exampleAmount: view.exampleAmount } : {}) }));
  const scenarioOverflow = scenarios.length > 2000;
  const input: PricingAdminPreviewInput | null = snapshot ? {
    expectedRevision: snapshot.revision, expectedAuthoringRevision: snapshot.authoring?.revision, catalogFingerprint: snapshot.catalogFingerprint, action,
    scenarios,
  } : null;
  const inputKey = input ? pricingAdminPreviewKey(input) : '';
  const preview = previewResult?.key === inputKey ? previewResult.data : null;
  const actionable = action.kind !== 'save' || dirty;

  useEffect(() => {
    setPreviewResult(null); setFields({}); setPreviewMessage('');
    if (!input || !hydrated || denied || conflict || reading || scenarioOverflow) return;
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
  }, [inputKey, previewNonce, hydrated, denied, conflict, reading, scenarioOverflow, active, authorized]);

  function updateChanges(update: (changes: PricingAdminChanges) => PricingAdminChanges) {
    setRestore(null);
    setDraft(current => ({ ...current, ...(hasChanges(current.changes) ? {} : { revision: snapshot?.revision || '', authoringRevision: snapshot?.authoring?.revision, catalogFingerprint: snapshot?.catalogFingerprint }), changes: update(current.changes) }));
  }

  function editRow(id: string, patch: Omit<PricingAdminRowChange, 'id'>) {
    updateChanges(changes => patchPricingAdminRow(changes, id, patch));
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
    setDraft(current => ({ ...current, revision: current.revision === operation.payload.expectedRevision ? receipt.revision! : current.revision,
      authoringRevision: current.authoringRevision === operation.payload.expectedAuthoringRevision ? receipt.snapshot!.authoring?.revision : current.authoringRevision,
      catalogFingerprint: current.catalogFingerprint === operation.payload.catalogFingerprint ? receipt.snapshot!.catalogFingerprint : current.catalogFingerprint,
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
  const standardsValue = draft.changes.authoring?.globalPointsPerCny ?? snapshot.authoring?.globalPointsPerCny ?? '';
  const pendingRows = draft.changes.rows.filter(row => !snapshot.rows.some(item => item.id === row.id));
  const selectedRows = snapshot.rows.filter(row => selected.includes(row.id));
  const displayChanges = preview?.changes || [];
  const skipped = preview?.skipped || [];
  const enhanceGroup = draft.changes.authoring?.enhanceGroup || pricingAdminEnhanceGroup(snapshot.rows);
  const enhanceCompatible = pricingAdminEnhanceGroup(snapshot.rows) !== null;
  const groups = new Map<string, string[]>();
  for (const row of snapshot.rows) if (row.currentPointsPerCny !== null) groups.set(row.currentPointsPerCny, [...(groups.get(row.currentPointsPerCny) || []), `${row.label} · ${row.providerLabel} · ${specsLabel(row.identity.specifications) || '通用'}`]);
  const amountChanges = displayChanges.filter(change => change.before.currentUnitCredits !== change.after.currentUnitCredits || change.before.currentPointsPerCny !== change.after.currentPointsPerCny || change.before.baseCny !== change.after.baseCny).length;
  const sceneChanges = displayChanges.flatMap(change => {
    const scenario = pricingAdminPreviewForSource(preview, change.sourceRowId, change.id).scenario;
    return scenario ? [scenario] : [];
  });
  const riseCount = sceneChanges.filter(scene => scene.deltaCredits !== null && scene.deltaCredits !== undefined && Number(scene.deltaCredits) > 0).length;
  const fallCount = sceneChanges.filter(scene => Number(scene.deltaCredits) < 0).length;
  const unchangedCount = sceneChanges.filter(scene => scene.deltaCredits !== null && scene.deltaCredits !== undefined && Number(scene.deltaCredits) === 0).length;
  const invalidRate = action.kind === 'save' && (Object.values(draft.changes.standards || {}).some(value => value !== undefined && !validPricingAdminRate(value))
    || draft.changes.authoring?.globalPointsPerCny !== undefined && !validPricingAdminRate(draft.changes.authoring.globalPointsPerCny)
    || draft.changes.rows.some(row => row.customPointsPerCny !== undefined && !validPricingAdminRate(row.customPointsPerCny)));
  const invalidEnhance = action.kind === 'save' && draft.changes.authoring?.enhanceGroup !== undefined && !validPricingEnhanceGroup(draft.changes.authoring.enhanceGroup);
  const canSave = Boolean(preview && actionable && (preview.changes.length || preview.authoringChanged || action.kind === 'save' && Object.keys(draft.changes.standards || {}).length || action.kind === 'restore' && action.standards?.length))
    && !pending && !saving && !previewBusy && !conflict && !readError && !reading && !invalidRate && !invalidEnhance && !operationStorageFailed && !scenarioOverflow;
  const editEnhance = (next: PricingEnhanceGroup) => updateChanges(changes => ({ ...changes, authoring: { ...changes.authoring, enhanceGroup: next } }));
  return <>{!identityVerified && <div className={styles.identityCheck} role="status">{readError || '正在核对当前账号'}{readError && <button type="button" className="btn btn-secondary" onClick={() => void load()}>重新读取</button>}</div>}<main className={styles.page} style={{ visibility: identityVerified ? undefined : 'hidden' }} aria-hidden={!identityVerified}>
    <header className={styles.header}><h1>点数与费率</h1><div className={styles.tools}>
      <button type="button" onClick={exportCsv}><Download size={17} />导出费率</button>
      <button type="button" onClick={() => setHistoryOpen(true)}><History size={17} />变更记录</button>
      <button type="button" title="重置视图，不清除草稿或费率" aria-label="重置视图，不清除草稿或费率" onClick={() => { scrollAnchor.current = null; setView({ ...defaultPricingAdminView }); setSelected([]); setRestore(null); }}><RotateCcw size={17} /></button>
    </div></header>
    <section className={styles.standard} aria-label="统一换算">
      <div className={styles.standardTop}><strong>统一换算</strong><label>1 元计价金额 = <input aria-label="统一换算点每元" type="number" min={snapshot.limits.rateMin} max={snapshot.limits.rateMax} step="0.1" value={standardsValue} placeholder="未设置" onChange={event => {
        const value = event.target.value; updateChanges(changes => ({ ...changes, authoring: { ...changes.authoring, globalPointsPerCny: value } }));
      }} /> 点</label><span className={styles.muted}>{draft.changes.authoring?.globalPointsPerCny !== undefined ? `待保存，当前 ${snapshot.authoring?.globalPointsPerCny ?? '未设置'} 点/元` : `${snapshot.authoring?.members.length || 0} 项跟随`}</span></div>
      <div className={styles.standardBottom}>{standardsValue && validPricingAdminRate(standardsValue) ? <span className={styles.muted}>0.10 元计 {roundDecimal(multiplyDecimal(['0.10', standardsValue]), 1, 'half_up')} 点 · 0.05 元计 {roundDecimal(multiplyDecimal(['0.05', standardsValue]), 1, 'half_up')} 点</span> : <span className={styles.muted}>建议 10.0 点/元：0.10 元计 1 点，0.05 元计 0.5 点</span>}
        {!standardsValue && <button type="button" className={styles.link} onClick={() => updateChanges(changes => ({ ...changes, authoring: { ...changes.authoring, globalPointsPerCny: RECOMMENDED_POINTS_PER_CNY } }))}>预填 10.0 建议</button>}
        <details><summary>查看其他费率与旧标准</summary><div className={styles.rateGroups}>
          {Array.from(groups).map(([rate, labels]) => <details key={rate}><summary>{rate} 点/元 · {labels.length} 项</summary><ul>{labels.map((label, index) => <li key={`${label}:${index}`}>{label}</li>)}</ul><button type="button" className={styles.link} onClick={() => updateChanges(changes => ({ ...changes, authoring: { ...changes.authoring, globalPointsPerCny: rate } }))}>用作统一换算草稿</button></details>)}
          {(['site_base_cny', 'supplier_cost_cny'] as const).map(basis => <label key={basis}>{basisLabel(basis)}旧标准<input aria-label={`${basisLabel(basis)}旧标准`} type="number" step="0.1" min="0.1" max="10000" value={draft.changes.standards?.[basis] ?? snapshot.standards[basis] ?? ''} placeholder="未设置" onChange={event => { const value = event.target.value; updateChanges(changes => ({ ...changes, standards: { ...changes.standards, [basis]: value } })); }} /></label>)}
        </div></details>
      </div>
    </section>
    {(readError || message || storageFailed || conflict || pending || operationStorageFailed) && <div className={styles.notice} role="status" aria-live="polite">
      {readError && <p>{readError} <button type="button" disabled={reading} onClick={() => void load()}>重新读取</button></p>}
      {message && <p>{message}</p>}
      {storageFailed && <p>此浏览器暂时无法保存现场，离开可能丢失未提交输入。</p>}
      {operationStorageFailed && <p>原操作存储暂不可核实，保存已暂停。请恢复浏览器存储后重新打开并核对原回执。</p>}
      {conflict && <p>费率、关联或目录已变化，原输入仍保留。<button type="button" disabled={Boolean(pending)} onClick={() => { setDraft(current => ({ ...current, revision: snapshot.revision, authoringRevision: snapshot.authoring?.revision, catalogFingerprint: snapshot.catalogFingerprint })); setPreviewNonce(value => value + 1); }}>保留输入，基于当前价重新预览</button></p>}
      {pending && <p>原保存结果待确认 · <RelativeTime value={pending.submittedAt} /> <button type="button" disabled={saving} onClick={() => void queryReceipt(pending)}>查询原保存回执</button></p>}
    </div>}
    <div className={styles.filters}><div className={styles.tabs} role="tablist" aria-label="费率类型">{(['image', 'video', 'enhance'] as const).map(kind => <button key={kind} type="button" role="tab" aria-selected={view.filter.kind === kind} onClick={() => changeFilter({ kind, ...(kind === 'video' ? { defaultsOnly: false } : {}) })}>{({ video: '视频', image: '图片', enhance: '视频增强' })[kind]}</button>)}</div>
      <label className={styles.search}><Search size={16} /><input aria-label="搜索型号或规格" placeholder="搜索型号 / 规格" maxLength={200} value={view.filter.search || ''} onChange={event => changeFilter({ search: event.target.value })} /></label>
      <button type="button" className={styles.link} onClick={() => changeFilter({ kind: 'all', defaultsOnly: false })}>全部收费项（{snapshot.rows.length}）</button>
      <details className={styles.filterDetails} open={view.filtersOpen === true} onToggle={event => { const open = event.currentTarget.open; setView(current => current.filtersOpen === open ? current : { ...current, filtersOpen: open }); }}><summary><SlidersHorizontal size={15} />筛选</summary><div className={styles.filterFields}>
      <select aria-label="供应商" value={view.filter.channelId || ''} onChange={event => changeFilter({ channelId: event.target.value })}><option value="">全部供应商</option>{Array.from(new Map(snapshot.rows.map(row => [row.identity.channelId, row.providerLabel])).entries()).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
      <select aria-label="差异筛选" value={view.filter.difference || 'all'} onChange={event => changeFilter({ difference: event.target.value as PricingAdminFilter['difference'] })}><option value="all">全部差异</option><option value="different">有差异</option><option value="unconfirmed">待核实</option><option value="custom">单独设置</option></select>
      <label className={styles.check}><input type="checkbox" checked={view.filter.defaultsOnly === true} onChange={event => changeFilter({ defaultsOnly: event.target.checked })} />仅默认</label>
      <select aria-label="排序" value={view.sort} onChange={event => { scrollAnchor.current = null; setView(current => ({ ...current, sort: event.target.value as PricingAdminView['sort'], page: 1 })); setSelected([]); setAllMatched(false); setRestore(null); }}><option value="catalog">目录顺序</option><option value="name">型号名称</option><option value="difference">差异优先</option></select>
      <button type="button" onClick={() => changeFilter({ kind: 'h3', defaultsOnly: false })}>H3 免费项</button></div></details></div>
    {['video', 'enhance'].includes(view.filter.kind || '') && <div className={styles.duration}><label>参考时长<input aria-label="视频参考时长秒" type="number" min="1" step="1" maxLength={32} value={view.quantity} onChange={event => { const quantity = event.target.value; setView(current => ({ ...current, quantity })); }} />秒</label>{['5', '10', '15'].map(value => <button type="button" key={value} aria-pressed={view.quantity === value} onClick={() => setView(current => ({ ...current, quantity: value }))}>{value} 秒</button>)}</div>}
    {view.filter.kind === 'video' && <details className={styles.references}><summary>历史参考建议 · 尚未采用</summary><p>普通生成、无参考视频，固定折算 7 CNY/USD；不是供应商实时价格。</p><div className={styles.referencePrices}><span>2.0：480p ¥0.48229127/秒</span><span>720p ¥1.06270945/秒</span><span>1080p ¥2.63337604/秒（仅9单旧样本）</span><span>2.5：同档 2.0 基价 ×1.5，属于推算</span></div><button type="button" className={styles.link} onClick={() => {
      const next = stageVideoPricingReferences(draft.changes, snapshot.rows, snapshot.authoring?.globalPointsPerCny);
      if (next === draft.changes) { setMessage('没有可加入的已绑定参考项；已有基价、人工草稿与不可用项保持不变。'); return; }
      updateChanges(() => next); setMessage('已将可采用的视频参考加入草稿，已有基价和人工草稿未覆盖。请查看实际价格变化后保存。'); setView(current => ({ ...current, changesOpen: true }));
    }}>采用视频参考定价</button></details>}
    {view.filter.kind === 'image' && <details className={styles.references}><summary>GPT Image 2 · 0.10 元/张建议</summary><p>在对应固定计费型号的来源详情绑定实际规格后采用。未启用、实际成本通道与未知型号不参与。</p></details>}
    {view.filter.kind === 'enhance' && enhanceGroup && enhanceCompatible && <section className={styles.enhance} aria-label="视频增强基础点价">
      <div className={styles.enhanceFields}>{(['480p', '720p', '1080p', '2k', '4k'] as const).map(resolution => <label key={resolution}>{resolution.toUpperCase()}（点/秒）<input type="text" inputMode="decimal" maxLength={32} value={enhanceGroup.basePointsPerSecond[resolution]} onChange={event => editEnhance({ ...enhanceGroup, basePointsPerSecond: { ...enhanceGroup.basePointsPerSecond, [resolution]: event.target.value } })} /></label>)}
      <label>专业版系数<input type="text" inputMode="decimal" maxLength={32} value={enhanceGroup.professionalMultiplier} onChange={event => editEnhance({ ...enhanceGroup, professionalMultiplier: event.target.value })} /></label><label>高帧率系数<input type="text" inputMode="decimal" maxLength={32} value={enhanceGroup.highFpsMultiplier} onChange={event => editEnhance({ ...enhanceGroup, highFpsMultiplier: event.target.value })} /></label></div>
      <span className={styles.muted}>沿用原点价与取整，未加入人民币统一换算。</span><button type="button" className={styles.link} aria-expanded={view.enhanceDetailsOpen === true} onClick={() => setView(current => ({ ...current, enhanceDetailsOpen: !current.enhanceDetailsOpen }))}>{view.enhanceDetailsOpen ? '收起' : '查看'}20 种组合</button>
    </section>}
    {view.filter.kind === 'enhance' && !enhanceCompatible && <p className={styles.muted}>现有增强价格含单独设置或不可用项，保留逐项编辑。</p>}
    <div className={view.filter.kind === 'enhance' && enhanceCompatible && !view.enhanceDetailsOpen ? styles.collapsedList : undefined}>
    <section className={`${styles.list} ${view.filter.kind === 'video' ? styles.videoList : ''}`} aria-label="费率目录">
      <div className={styles.selection}><label className={styles.check}><input type="checkbox" aria-label="选择当前页" checked={visible.length > 0 && visible.every(row => selected.includes(row.id))} onChange={event => { setRestore(null); setAllMatched(false); setSelected(event.target.checked ? visible.map(row => row.id) : []); }} />{selected.length ? `已选 ${selected.length} 项` : `共 ${filtered.length} 项`}</label>
        {selected.length > 0 && <><button type="button" className={styles.link} disabled={!validPricingAdminRate(standardsValue)} onClick={() => {
          const result = stagePricingAdminUnify(draft.changes, selectedRows); updateChanges(() => result.changes);
          setMessage(`已将 ${selectedRows.length - result.skipped.length} 项加入统一换算草稿${result.skipped.length ? `，${result.skipped.length} 项未参与：${result.skipped.map(item => `${snapshot.rows.find(row => row.id === item.id)?.label}（${item.reason}）`).join('、')}` : ''}；其他草稿保留。`);
          setSelected([]); setAllMatched(false);
        }}>统一所选</button><button type="button" onClick={() => { setSelected([]); setAllMatched(false); }}>取消选择</button>{!allMatched && filtered.length > visible.length && <button type="button" onClick={() => { setSelected(filtered.map(row => row.id)); setAllMatched(true); }}>选择全部符合条件 {filtered.length} 项</button>}{!validPricingAdminRate(standardsValue) && <span className={styles.muted}>先填写统一换算</span>}</>}
      </div>
      <div className={styles.tableHeader} aria-hidden="true"><span /><span>型号 / 规格</span><span>实际点价</span><span>当前点/元</span><span>跟随方式</span><span /></div>
      <div className={view.filter.kind === 'video' ? styles.videoRows : undefined}>{visible.map(row => {
        const change = draft.changes.rows.find(item => item.id === row.id);
        const mapped = pricingAdminPreviewForSource(preview, row.id), after = mapped.change?.after, scenario = mapped.scenario;
        const basisKind = change?.basisKind || row.basisKind;
        const follows = change?.authoringRateMode === 'follow_global' || !change?.authoringRateMode && row.authoringRateMode === 'follow_global';
        const rate = change?.customPointsPerCny ?? (follows ? standardsValue : (change?.mode || row.mode) === 'follow' ? draft.changes.standards?.[basisKind] ?? snapshot.standards[basisKind] ?? '' : row.currentPointsPerCny ?? '');
        const mode = change?.mode || row.mode, expanded = view.expanded.includes(row.id);
        const changed = Boolean(change || after || follows && draft.changes.authoring?.globalPointsPerCny !== undefined || row.mode === 'follow' && draft.changes.standards?.[basisKind] !== undefined);
        const newScope = change?.specifications && Object.entries(change.specifications).some(([key, value]) => row.identity.specifications[key] !== value);
        const invalidRowDuration = row.identity.kind === 'video' && !isSeedanceVideoDuration(Number(view.quantity), row.identity.modelId);
        const unavailableMember = row.authoringRateMode === 'follow_global' && (!row.enabled || row.availability !== 'ready' || !row.canAdopt);
        const pendingMemberExit = change?.authoringRateMode === 'custom' && Object.keys(change).length === 2;
        return <div key={row.id} className={`${styles.rowBlock} ${selected.includes(row.id) ? styles.selected : ''}`} data-pricing-row={row.id}>
          <div className={styles.row}>
            <input type="checkbox" aria-label={`选择 ${row.label} ${row.providerLabel}`} checked={selected.includes(row.id)} onChange={event => { setRestore(null); setAllMatched(false); setSelected(current => event.target.checked ? [...current, row.id] : current.filter(id => id !== row.id)); }} />
            <div className={styles.model}><strong>{row.label}</strong><small>{row.providerLabel}{row.isDefault ? ' · 默认' : ''}{!row.enabled ? ' · 已停用' : ''}</small><small>{specsLabel(scenario?.specifications || mapped.change?.specifications || change?.specifications || row.identity.specifications) || '通用规格'}</small></div>
            <div className={styles.credits} data-label="实际点价">{row.identity.billingMode === 'actual' ? <><strong>按账单结算</strong><small>{scenario?.authorizedMaximumCredits ? `最多预留 ${scenario.authorizedMaximumCredits} 点` : '预留上限待实际请求报价'}</small></> : <><strong>{newScope && !scenario ? '新规格待报价' : invalidRowDuration ? '此时长不可试算' : scenario?.adjustedCredits !== null && scenario?.adjustedCredits !== undefined ? `${scenario.adjustedCredits} 点` : '待报价'}</strong><small>{row.identity.unit === 'image' ? '每张' : `${view.quantity || '待填'} 秒`}{changed ? ' · 待保存' : ''}</small>{changed && scenario?.currentCredits !== null && scenario?.currentCredits !== undefined && <small>当前 {scenario.currentCredits} 点{pricingAdminScenarioDifference(scenario) ? ` · ${pricingAdminScenarioDifference(scenario)}` : ''}</small>}{scenario?.roundedToZero && <small>取整为 0 点，不是明确免费</small>}{scenario?.reason && <small>{scenario.reason}</small>}</>}</div>
            <div className={styles.rate} data-label="当前点/元"><input type="number" min={snapshot.limits.rateMin} max={snapshot.limits.rateMax} step="0.1" maxLength={32} aria-label={`${row.label} ${row.providerLabel} 当前点每元`} value={rate} placeholder={row.mode === 'free' ? '免费' : '未设置'} onChange={event => editRow(row.id, { mode: 'custom', customPointsPerCny: event.target.value })} />
              {changed && <small>生效 {row.currentPointsPerCny ?? '待核'}，{action.kind === 'save' ? '待保存' : '目标见预览'}</small>}</div>
            <div className={styles.mode} data-label="点元跟随"><span>{follows ? '跟随统一' : rateModeLabel({ ...row, mode, authoringRateMode: change?.authoringRateMode || row.authoringRateMode })}</span>
              {!follows && <button type="button" className={styles.link} disabled={!validPricingAdminRate(standardsValue) || !row.canAdopt || !row.enabled || row.mode === 'free'} onClick={() => editRow(row.id, { authoringRateMode: 'follow_global' })}><RotateCcw size={13} />恢复统一</button>}
              {(follows || unavailableMember && !pendingMemberExit) && <button type="button" className={styles.link} onClick={() => {
                if (unavailableMember) {
                  updateChanges(changes => stagePricingAdminMemberExit(changes, row.id));
                  setMessage('已将移出统一加入草稿，原价保持。该行未提交价格调整已移除，其他行草稿保留。');
                } else editRow(row.id, rate ? { authoringRateMode: 'custom', customPointsPerCny: rate } : { authoringRateMode: 'custom' });
              }}>{unavailableMember ? '移出统一，保留原价' : '改为单独'}</button>}
              {(after || row).hasDifference && (after || row).differencePercent !== null && <small>比统一{Number((after || row).differencePercent) >= 0 ? '高' : '低'} {Math.abs(Number((after || row).differencePercent))}%</small>}
              {row.baseCny === null && row.identity.billingMode === 'fixed' && !change?.base && <small>待补依据，沿用原价</small>}</div>
            <button type="button" className={styles.icon} title={expanded ? '收起来源与规格' : '展开来源与规格'} aria-label={`${expanded ? '收起' : '展开'} ${row.label} 来源与规格`} aria-expanded={expanded} onClick={() => setView(current => ({ ...current, expanded: expanded ? current.expanded.filter(id => id !== row.id) : [...current.expanded, row.id] }))}>{expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</button>
          </div>
          {expanded && <><PricingSourceEditor row={row} rows={snapshot.rows} change={change} onChange={patch => editRow(row.id, patch)}
            exampleAmount={view.simulationRowId === row.id ? view.exampleAmount : ''} onExampleAmount={exampleAmount => setView(current => ({ ...current, simulationRowId: row.id, exampleAmount }))} scenario={scenario} onAdoptGpt={specifications => {
            const next = stageGptImageReference(draft.changes, row, specifications, snapshot.authoring?.globalPointsPerCny);
            if (next === draft.changes) { setMessage('该项尚不能采用，或已有人工草稿。请保留现价并核对范围。'); return; }
            updateChanges(() => next); setMessage('已绑定此供应商、型号和规格的0.10元建议，尚未保存；未启用任何型号。');
          }} /><div className={styles.rowTools}><button type="button" onClick={() => updateChanges(changes => ({ ...changes, authoring: { ...changes.authoring, globalPointsPerCny: rate } }))} disabled={!validPricingAdminRate(rate)}>用此点元作统一草稿</button>{mode !== 'free' && <button type="button" onClick={() => editRow(row.id, { authoringRateMode: 'custom', mode: 'free' })}>设为明确免费</button>}{change && <button type="button" onClick={() => setDraft(current => ({ ...current, changes: { ...current.changes, rows: current.changes.rows.filter(item => item.id !== row.id) } }))}>撤销此行草稿</button>}</div></>}
          {Object.entries(fields).filter(([key]) => key.includes(row.id)).map(([key, value]) => <p key={key} className={styles.fieldError} role="status">{value}</p>)}
        </div>;
      })}</div>
      {!visible.length && <p className={styles.empty}>没有符合条件的型号。<button type="button" onClick={() => changeFilter({ kind: 'all', difference: 'all', search: '', channelId: '', defaultsOnly: false, basisKind: undefined })}>清除筛选</button></p>}
      <div className={styles.pagination}><PaginationControls page={page} totalPages={pages} total={filtered.length} pageSize={view.pageSize} onPageChange={changePage} label="费率" /><select aria-label="每页数量" value={view.pageSize} onChange={event => { scrollAnchor.current = null; setView(current => ({ ...current, pageSize: Number(event.target.value), page: 1 })); setSelected([]); setAllMatched(false); setRestore(null); }}><option value={12}>12 项/页</option><option value={24}>24 项/页</option><option value={48}>48 项/页</option></select></div>
    </section></div>
    {previewBusy && <p className={styles.muted} role="status">正在核对价格</p>}
    {previewMessage && <p role="status">{previewMessage}</p>}
    {scenarioOverflow && <p role="status">目录试算超过2000项，未截断也未保存。需要缩小单次试算范围后继续。</p>}
    {actionable && <section className={styles.preview} aria-label="调整预览">
      <details open={view.changesOpen === true} onToggle={event => { const open = event.currentTarget.open; setView(current => current.changesOpen === open ? current : { ...current, changesOpen: open }); }}>
      <summary>{action.kind === 'restore' ? '查看恢复变化' : '查看全部变化'} · 金额 {amountChanges} 项 · 关系/依据 {displayChanges.length - amountChanges} 项</summary>
      <p className={styles.muted}>上涨 {riseCount} · 下降 {fallCount} · 同场景不变 {unchangedCount} · 未能确定 {displayChanges.length - riseCount - fallCount - unchangedCount}。余额与预算不变，可生成次数可能减少。</p>
      {action.kind === 'restore' && dirty && <p>本次只恢复历史所选，已有编辑草稿仍保留，未包含在此次保存中。</p>}
      {preview?.authoringChanged && !displayChanges.length && <p>只调整设置或关系，没有收费项改价。</p>}
      <div className={styles.previewChanges}>{displayChanges.slice(0, previewLimit).map(change => {
        const scenario = pricingAdminPreviewForSource(preview, change.sourceRowId, change.id).scenario;
        return <div key={change.id}><span>{change.label}<small>{snapshot.rows.find(row => row.id === change.sourceRowId)?.providerLabel}</small><small>{specsLabel(change.specifications) || '通用规格'}</small>
        {rateModeLabel(change.before) !== rateModeLabel(change.after) && <small>{rateModeLabel(change.before)} → {rateModeLabel(change.after)}</small>}
        {change.before.baseCny !== change.after.baseCny && <small>基价 ¥{change.before.baseCny ?? '待核'} → ¥{change.after.baseCny ?? '待核'}</small>}
        {JSON.stringify(change.before.authoringEntry) !== JSON.stringify(change.after.authoringEntry) && <small>基价关系或来源依据已调整{action.kind === 'restore' && !change.after.authoringEntry?.baseRelation ? '，恢复历史价并单独设置' : ''}</small>}
      </span><span>{scenario && !scenario.isExample && scenario.currentCredits !== null && scenario.adjustedCredits !== null ? <>{scenario.currentCredits} → <strong>{scenario.adjustedCredits} 点</strong><small>{scenario.unit === 'second' ? `${scenario.quantity} 秒` : `${scenario.quantity} 张`}{pricingAdminScenarioDifference(scenario) ? ` · ${pricingAdminScenarioDifference(scenario)}` : ''}</small></> : change.after.currentUnitCredits !== null ? <>{change.before.currentUnitCredits ?? '待核'} → <strong>{change.after.currentUnitCredits} 点</strong><small>每计价单位 · 完整场景待报价</small></> : <>{change.before.currentPointsPerCny ?? '待核'} → <strong>{change.after.currentPointsPerCny ?? '待核'}</strong><small>点/元{scenario?.isExample ? ' · 实扣取决于账单' : ' · 此场景待报价'}</small></>}</span></div>;
      })}</div>
      {displayChanges.length > previewLimit && <button type="button" className={styles.link} onClick={() => setPreviewLimit(value => value + 24)}>加载更多变化（已显示 {previewLimit}/{displayChanges.length}）</button>}
      {skipped.length > 0 && <details><summary>有 {skipped.length} 项未参与，保留原价</summary><ul>{skipped.map(item => <li key={item.id}>{snapshot.rows.find(row => row.id === item.id)?.label || '该收费项'}：{item.reason}</li>)}</ul></details>}
      </details><button type="button" className={styles.link} disabled={previewBusy || reading || conflict} onClick={() => setPreviewNonce(value => value + 1)}><RefreshCw size={14} />重新预览</button>
    </section>}
    {pendingRows.length > 0 && <div className={styles.notice}>有 {pendingRows.length} 项草稿对应的目录已不存在，未自动丢弃或迁移。<button type="button" onClick={() => setDraft(current => ({ ...current, changes: { ...current.changes, rows: current.changes.rows.filter(row => snapshot.rows.some(item => item.id === row.id)) } }))}>移除这些失效草稿</button></div>}
    {Object.entries(fields).map(([key, value]) => <p key={key} className={styles.fieldError} role="status">{value}</p>)}
    {invalidRate && <p role="status">点/元须为 0.1–10000.0，最多 1 位小数。免费请明确选择“免费”。</p>}
    {invalidEnhance && <p role="status">增强点价与系数须为有效正数，最多8位小数。</p>}
    <div className={styles.revision}>生效记录：{snapshot.updatedAt ? <RelativeTime value={snapshot.updatedAt} /> : '尚未设置统一策略，保留原价'}{snapshot.updatedBy ? ` · ${snapshot.updatedBy.displayName}` : ''} · {snapshot.revision}</div>
    <footer className={styles.savebar}><div><strong>{action.kind === 'restore' ? `将恢复 ${displayChanges.length} 项` : dirty ? `已调整 ${displayChanges.length} 项${preview?.authoringChanged && !displayChanges.length ? '设置' : ''}` : '当前生效价格'}</strong><span>仅影响新请求</span></div><div className={styles.tools}>
      {actionable && <button type="button" disabled={saving} onClick={() => { if (action.kind === 'save') setDraft({ revision: snapshot.revision, authoringRevision: snapshot.authoring?.revision, catalogFingerprint: snapshot.catalogFingerprint, changes: { rows: [] } }); setSelected([]); setRestore(null); setAllMatched(false); }}><RotateCcw size={15} />撤销本轮草稿</button>}
      <button type="button" className="btn btn-primary" disabled={!canSave} onClick={() => void save()}><Save size={17} />{saving ? '正在核对' : pending ? '保存待确认' : action.kind === 'restore' ? '保存历史恢复' : dirty ? '保存并生效' : '无待保存调整'}</button>
    </div></footer>
    {historyOpen && <PricingHistory snapshot={snapshot} onUnauthorized={unauthorized} onClose={() => setHistoryOpen(false)} onRestore={candidate => { setRestore(candidate); setSelected([]); setAllMatched(false); setView(current => ({ ...current, changesOpen: true })); }} />}
    {productDialog}
  </main></>;
}
