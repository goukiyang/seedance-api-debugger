'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, ArrowRight, Copy, Download, Expand, RefreshCw, Undo2, X } from 'lucide-react';
import PageBanner from '@/components/PageBanner';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';
import { VideoLoopButton } from '@/components/VideoLoopButton';
import { useProductDialog } from '@/components/useProductDialog';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { useUnsavedNavigation } from '@/lib/hooks/use-unsaved-navigation';
import { useVideoLoopState } from '@/lib/hooks/use-media-preview-state';
import { copyPngBlob } from '@/lib/media/copy-image';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import { candidateFrames, DEFAULT_MULTIVIEW_LAYOUT, multiviewDimensions, parseMultiviewDraft,
  type MultiviewDraft, type MultiviewInfo, type MultiviewSlot } from '@/lib/video/multiview-contract';
import { MultiviewGenerationPanel, type MultiviewGenerationPanelState, type MultiviewGenerationReady } from './MultiviewGenerationPanel';
import { MultiviewSourcePicker } from './MultiviewSourcePicker';
import styles from './multiview.module.css';

type FrameState = { url?: string; error?: string; loading?: boolean };
type Artifact = { blob: Blob; url: string; name: string; key: string; format: 'png' | 'zip'; slots: MultiviewSlot[] };
type ArtifactOperation = { token: symbol; generation: number; controller: AbortController; key: string;
  owner: string; authority: string; taskId: string; version: string; format: 'png' | 'zip'; slots: MultiviewSlot[]; layout: MultiviewDraft['layout'] };
type ViewPreferences = { tab: 'frames' | 'layout'; selected: string; zoom: number; time: number; x: number; y: number; panX: number; panY: number; originalOpen: boolean };
const emptyView = (): ViewPreferences => ({ tab: 'frames', selected: '', zoom: 1, time: 0, x: 0, y: 0, panX: 0, panY: 0, originalOpen: false });
const safeTask = (id: string) => /^[a-z0-9_-]{8,80}$/i.test(id);
function sourceReturn(value: string | null, taskId: string) {
  if (value?.startsWith('/') && !value.startsWith('//') && !/[\\\u0000-\u001f]/.test(value)) return value;
  return taskId ? `/tasks/${encodeURIComponent(taskId)}` : '/';
}
function slot(frame: number): MultiviewSlot { return { id: crypto.randomUUID(), frame, name: '', manual: false }; }
function initialDraft(info: MultiviewInfo): MultiviewDraft {
  return { schema: 1, sourceVersion: info.sourceVersion, slots: candidateFrames(info.timestamps.length, 8).map(slot), reserve: [],
    layout: { ...DEFAULT_MULTIVIEW_LAYOUT }, editing: null };
}
function preservedSlotOrder(order: string[] | undefined, slots: MultiviewSlot[], reserve: MultiviewSlot[]) {
  const ids = [...slots, ...reserve].map(item => item.id);
  const present = new Set(ids);
  return Array.from(new Set([...(order || []).filter(id => present.has(id)), ...ids]));
}
function contentKey(owner: string, taskId: string, draft: MultiviewDraft, format: 'png' | 'zip', slots = draft.slots) {
  return JSON.stringify([owner, taskId, draft.sourceVersion, slots.map(item => [item.frame, item.name]), draft.layout, format]);
}
function readView(raw: string | null, draft: MultiviewDraft): ViewPreferences {
  try {
    if (!raw || raw.length > 4000) return emptyView();
    const value = JSON.parse(raw);
    return { tab: value.tab === 'layout' ? 'layout' : 'frames', selected: draft.slots.some(item => item.id === value.selected) ? value.selected : '',
      zoom: Number.isFinite(value.zoom) ? Math.min(4, Math.max(.5, value.zoom)) : 1,
      time: Number.isFinite(value.time) ? Math.max(0, value.time) : 0,
      x: Number.isFinite(value.x) ? Math.max(0, Math.min(100000, value.x)) : 0,
      y: Number.isFinite(value.y) ? Math.max(0, Math.min(100000, value.y)) : 0,
      panX: Number.isFinite(value.panX) ? Math.max(0, Math.min(100000, value.panX)) : 0,
      panY: Number.isFinite(value.panY) ? Math.max(0, Math.min(100000, value.panY)) : 0, originalOpen: value.originalOpen === true };
  } catch { return emptyView(); }
}

function MultiviewPageContent() {
  const query = useSearchParams();
  const explicitTask = query.get('taskId') || '';
  const { user, hasLoadedUser, refreshUser, sessionChanged, userLoadError } = useAppSession();
  const owner = user?.id || '';
  const authority = JSON.stringify([owner, user?.role, user?.account_type, user?.feature_profile_id]);
  const [location, setLocation] = useState({ owner: '', taskId: '' });
  const taskId = location.owner === owner ? location.taskId : '';
  const backHref = sourceReturn(query.get('returnTo'), taskId);
  const [info, setInfo] = useState<MultiviewInfo | null>(null);
  const [loadedOwner, setLoadedOwner] = useState('');
  const [loadedAuthority, setLoadedAuthority] = useState('');
  const [draft, setDraft] = useState<MultiviewDraft | null>(null);
  const [frames, setFrames] = useState<Record<number, FrameState>>({});
  const [authorized, setAuthorized] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saved, setSaved] = useState(true);
  const [viewSaved, setViewSaved] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportFile, setExportFile] = useState<Artifact | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const [editorFrame, setEditorFrame] = useState(0);
  const [reduceCount, setReduceCount] = useState<number | null>(null);
  const [retained, setRetained] = useState<string[]>([]);
  const [undo, setUndo] = useState<MultiviewDraft | null>(null);
  const [originalOpen, setOriginalOpen] = useState(false);
  const [partialFormat, setPartialFormat] = useState<'png' | 'zip' | null>(null);
  const [view, setView] = useState<ViewPreferences>(emptyView);
  const [expanded, setExpanded] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [activity, setActivity] = useState(0);
  const [generation, setGeneration] = useState<MultiviewGenerationPanelState>({ phase: 'empty', busy: false });
  const [pendingResult, setPendingResult] = useState<MultiviewGenerationReady | null>(null);
  const [previousTask, setPreviousTask] = useState('');
  const { confirm, productDialog } = useProductDialog();
  const video = useRef<HTMLVideoElement>(null);
  const generationArea = useRef<HTMLDivElement>(null);
  const collageViewport = useRef<HTMLDivElement>(null);
  const requests = useRef(new Map<number, Promise<boolean>>());
  const frameQueue = useRef<Promise<unknown>>(Promise.resolve());
  const objectUrls = useRef(new Set<string>());
  const artifacts = useRef(new Map<string, Artifact>());
  const artifactInflight = useRef(new Map<string, Promise<Artifact>>());
  const operation = useRef<ArtifactOperation | null>(null);
  const context = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const draftRef = useRef(draft); draftRef.current = draft;
  const frameRef = useRef(frames); frameRef.current = frames;
  const ownerRef = useRef(owner); ownerRef.current = owner;
  const authorityRef = useRef(authority); authorityRef.current = authority;
  const accountHydrated = useRef('');
  const locationRef = useRef(location); locationRef.current = location;
  const viewRef = useRef(view); viewRef.current = view;
  const preferencesReady = useRef('');
  const restoreScroll = useRef<{ key: string; x: number; y: number } | null>(null);
  const allowScrollRestore = useRef(true);
  const seenReady = useRef(new Set<string>());
  const collapsedFor = useRef('');
  const source = `/api/video/play/${encodeURIComponent(taskId)}`;
  const loop = useVideoLoopState(taskId ? source : undefined, taskId ? `video_task:${taskId}` : undefined);
  const storageKey = info && owner ? `sd2:multiview:v1:${owner}:${taskId}:${info.sourceVersion}` : '';
  const viewKey = storageKey ? `${storageKey}:view:v1` : '';
  const sessionReady = !sessionChanged && !userLoadError && !isClientSessionBlocked();
  const visible = sessionReady && authorized && loadedOwner === owner && loadedAuthority === authority && info?.taskId === taskId;
  const currentSourceKey = `${owner}:${taskId}:${loadedOwner === owner && info?.taskId === taskId ? info.sourceVersion : ''}:${activity}`;
  const sourceKeyRef = useRef(currentSourceKey); sourceKeyRef.current = currentSourceKey;
  useUnsavedNavigation(!saved || !viewSaved || Boolean(generation.unsaved) || exporting || Boolean(generation.leavingBusy), confirm, {
    unsaved: [...(saved && viewSaved ? [] : ['多角度选帧现场暂未保存到本机']), ...(generation.unsaved ? ['生成输入或原请求记录暂未完整保存到本机'] : [])],
    busy: [...(exporting ? ['拼图文件仍在准备或复制'] : []), ...(generation.leavingBusy ? ['主图或视频提交仍在处理中'] : [])],
    revision: JSON.stringify([draft, generation.unsaved, generation.leavingBusy, generation.taskId]),
  });

  const clearArtifacts = useCallback(() => {
    operation.current?.controller.abort(); operation.current = null;
    for (const item of Array.from(artifacts.current.values())) { URL.revokeObjectURL(item.url); objectUrls.current.delete(item.url); }
    artifacts.current.clear(); artifactInflight.current.clear(); setExportFile(null); setExporting(false);
  }, []);
  const clearUrls = useCallback(() => {
    clearArtifacts();
    for (const url of Array.from(objectUrls.current)) URL.revokeObjectURL(url);
    objectUrls.current.clear(); requests.current.clear(); frameQueue.current = Promise.resolve();
    frameRef.current = {}; setFrames({}); setPreview(null);
  }, [clearArtifacts]);
  const rejectSource = useCallback((message: string) => {
    context.current += 1; abort.current?.abort(); clearUrls();
    video.current?.pause(); setActivity(value => value + 1); setAuthorized(false); setError(message); setNotice('原选帧和生成草稿已保留，重新读取前不再使用旧图片或文件。');
  }, [clearUrls]);
  useEffect(() => { if (!sessionReady) rejectSource('当前登录状态无法确认，旧图片和文件已停止使用。安全草稿仍保留。'); }, [rejectSource, sessionReady]);

  useEffect(() => { if (!hasLoadedUser) void refreshUser(); }, [hasLoadedUser, refreshUser]);
  useEffect(() => {
    if (!hasLoadedUser) return;
    const accountChanged = accountHydrated.current !== owner;
    accountHydrated.current = owner;
    let restored = '';
    try {
      restored = sessionStorage.getItem(`sd2:multiview:source:v1:${owner}`) || localStorage.getItem(`sd2:multiview:last-source:v1:${owner}`) || '';
      const settings = JSON.parse(localStorage.getItem(`sd2:multiview:preferences:v1:${owner}`) || 'null');
      if (accountChanged) { setExpanded(typeof settings?.expanded === 'boolean' ? settings.expanded : true); setViewSaved(true); }
    } catch { if (accountChanged) setExpanded(true); setViewSaved(false); }
    const previous = locationRef.current;
    const nextTask = explicitTask || (!accountChanged && previous.owner === owner ? previous.taskId : safeTask(restored) ? restored : '');
    if (previous.owner !== owner || previous.taskId !== nextTask) { setLocation({ owner, taskId: nextTask }); setPendingResult(null); }
    if (accountChanged) {
      setPreviousTask(''); setGeneration({ phase: 'empty', busy: false });
      seenReady.current.clear(); collapsedFor.current = ''; setActivity(0);
    }
  }, [explicitTask, hasLoadedUser, owner]);

  const load = useCallback(async (recheck = false) => {
    if (!owner || !taskId || isClientSessionBlocked()) { setLoading(false); setError(''); return; }
    if (!safeTask(taskId)) { setLoading(false); setError('视频编号无效，当前生成草稿不受影响'); return; }
    const epoch = ++context.current;
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
    clearArtifacts(); requests.current.clear(); frameQueue.current = Promise.resolve();
    setAuthorized(false); setLoading(true); setError(''); setPreview(null);
    try {
      const response = await fetch(`/api/video/multiview/${encodeURIComponent(taskId)}`, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]) });
      const result = await response.json();
      if (!response.ok || !result.info) throw new Error(result.error || '原视频读取失败，可重新读取');
      if (epoch !== context.current || ownerRef.current !== owner || authorityRef.current !== authority || isClientSessionBlocked()) return;
      const next = result.info as MultiviewInfo;
      const previous = draftRef.current;
      if (!recheck || previous?.sourceVersion !== next.sourceVersion) {
        clearUrls();
        const key = `sd2:multiview:v1:${owner}:${taskId}:${next.sourceVersion}`;
        let restored: MultiviewDraft | null = null; let preference = emptyView();
        try { restored = parseMultiviewDraft(localStorage.getItem(key), next); setSaved(true); }
        catch { setSaved(false); }
        const keepCurrent = previous?.sourceVersion === next.sourceVersion && preferencesReady.current === `${key}:view:v1`;
        const state = keepCurrent ? previous! : restored || initialDraft(next);
        try { preference = keepCurrent ? { ...viewRef.current, x: window.scrollX, y: window.scrollY } : readView(localStorage.getItem(`${key}:view:v1`), state); }
        catch { setViewSaved(false); }
        preferencesReady.current = `${key}:view:v1`;
        preference.selected ||= state.editing || state.slots[0]?.id || '';
        setView(preference); setOriginalOpen(preference.originalOpen); restoreScroll.current = allowScrollRestore.current ? { key, x: preference.x, y: preference.y } : null;
        allowScrollRestore.current = true;
        draftRef.current = state; setDraft(state); setUndo(null); setReduceCount(null);
        setEditorFrame(state.editorFrame ?? state.slots.find(item => item.id === state.editing)?.frame ?? 0);
        if (recheck && previous) setNotice('原视频版本已变化，已载入对应候选；旧草稿单独保留。');
      }
      setInfo(next); setLoadedOwner(owner); setLoadedAuthority(authority); setAuthorized(true);
      try { sessionStorage.setItem(`sd2:multiview:source:v1:${owner}`, taskId); localStorage.setItem(`sd2:multiview:last-source:v1:${owner}`, taskId); }
      catch { setViewSaved(false); }
    } catch (cause) {
      if (epoch !== context.current || controller.signal.aborted) return;
      clearUrls(); setError(cause instanceof Error ? cause.message : '原视频暂不可用');
    } finally { if (epoch === context.current) setLoading(false); }
  }, [authority, clearArtifacts, clearUrls, owner, taskId]);
  useEffect(() => {
    context.current += 1; abort.current?.abort(); clearUrls(); preferencesReady.current = '';
    setInfo(null); draftRef.current = null; setDraft(null); setLoadedOwner(''); setAuthorized(false); setOriginalOpen(false);
    if (hasLoadedUser && location.owner === owner) void load();
    return () => { context.current += 1; abort.current?.abort(); clearUrls(); };
  }, [clearUrls, hasLoadedUser, load, location.owner, owner, user?.role, user?.account_type, user?.feature_profile_id]);
  useEffect(() => {
    const recheck = () => { if (document.visibilityState === 'visible' && draftRef.current && !operation.current) void load(true); };
    window.addEventListener('focus', recheck); document.addEventListener('visibilitychange', recheck);
    return () => { window.removeEventListener('focus', recheck); document.removeEventListener('visibilitychange', recheck); };
  }, [load]);
  useEffect(() => {
    if (!draft || !storageKey || !visible) return;
    try { localStorage.setItem(storageKey, JSON.stringify(draft)); setSaved(true); } catch { setSaved(false); }
  }, [draft, storageKey, visible]);
  useEffect(() => {
    if (!visible || !viewKey || preferencesReady.current !== viewKey) return;
    const persist = () => {
      if (ownerRef.current !== owner || preferencesReady.current !== viewKey) return;
      try { localStorage.setItem(viewKey, JSON.stringify({ ...viewRef.current, x: window.scrollX, y: window.scrollY })); setViewSaved(true); }
      catch { setViewSaved(false); }
    };
    persist();
    let timer: number | undefined;
    const scroll = () => { if (timer === undefined) timer = window.setTimeout(() => { timer = undefined; persist(); }, 250); };
    window.addEventListener('scroll', scroll, { passive: true });
    return () => { window.removeEventListener('scroll', scroll); window.clearTimeout(timer); persist(); };
  }, [owner, view, viewKey, visible]);
  useEffect(() => {
    if (!visible) return;
    const position = restoreScroll.current?.key === storageKey ? restoreScroll.current : null; restoreScroll.current = null;
    const raf = requestAnimationFrame(() => {
      if (position) window.scrollTo(position.x, position.y);
      if (collageViewport.current) { collageViewport.current.scrollLeft = viewRef.current.panX; collageViewport.current.scrollTop = viewRef.current.panY; }
    });
    return () => cancelAnimationFrame(raf);
  }, [storageKey, visible]);
  useEffect(() => {
    const media = video.current;
    const pause = () => { if (document.visibilityState !== 'visible') media?.pause(); };
    document.addEventListener('visibilitychange', pause);
    return () => { media?.pause(); document.removeEventListener('visibilitychange', pause); };
  }, [visible, originalOpen, draft?.editing, view.tab]);

  const loadFrame = useCallback(async (frame: number, retry = false): Promise<boolean> => {
    if (!info || !visible) return false;
    if (frameRef.current[frame]?.url) return true;
    if (requests.current.has(frame)) return requests.current.get(frame)!;
    if (frameRef.current[frame]?.error && !retry) return false;
    const epoch = context.current;
    const previous = frameQueue.current;
    const pending = (async () => {
      if (epoch === context.current) setFrames(value => ({ ...value, [frame]: { loading: true } }));
      try {
        await previous.catch(() => undefined);
        if (epoch !== context.current || isClientSessionBlocked()) return false;
        const response = await fetch(`/api/video/multiview/${encodeURIComponent(taskId)}?version=${info.sourceVersion}&frame=${frame}`, { cache: 'no-store', signal: abort.current ? AbortSignal.any([abort.current.signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000) });
        if (!response.ok) {
          const value = await response.json().catch(() => ({}));
          if ([401, 403, 404, 409].includes(response.status) && epoch === context.current) rejectSource(value.error || '原视频权限或版本已变化，请重新读取');
          throw new Error(value.error || '这一帧未提取成功');
        }
        const blob = await response.blob();
        if (blob.type !== 'image/png' || !blob.size) throw new Error('这一帧暂不可读取，可单独重试');
        if (epoch !== context.current || ownerRef.current !== owner || authorityRef.current !== authority || isClientSessionBlocked()) return false;
        const url = URL.createObjectURL(blob); objectUrls.current.add(url);
        frameRef.current = { ...frameRef.current, [frame]: { url } }; setFrames(value => ({ ...value, [frame]: { url } }));
        return true;
      } catch (cause) {
        if (epoch === context.current && !abort.current?.signal.aborted) setFrames(value => ({ ...value, [frame]: { error: cause instanceof Error ? cause.message : '提取失败，可单独重试' } }));
        return false;
      } finally { if (epoch === context.current) requests.current.delete(frame); }
    })();
    frameQueue.current = pending; requests.current.set(frame, pending); return pending;
  }, [authority, info, owner, rejectSource, taskId, visible]);
  const frameSignature = draft?.slots.map(item => item.frame).join(',') || '';
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void (async () => { for (const frame of Array.from(new Set(frameSignature.split(',').filter(Boolean).map(Number)))) { if (cancelled) break; await loadFrame(frame); } })();
    return () => { cancelled = true; };
  }, [frameSignature, loadFrame, visible]);
  useEffect(() => {
    if (!draft?.editing || !visible || view.tab !== 'frames') return;
    let cancelled = false;
    const timer = window.setTimeout(() => { void (async () => {
      await loadFrame(editorFrame);
      for (const adjacent of [editorFrame - 1, editorFrame + 1, editorFrame - 2, editorFrame + 2]) {
        if (cancelled) break;
        if (adjacent >= 0 && info && adjacent < info.timestamps.length) await loadFrame(adjacent);
      }
    })(); }, 180);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [draft?.editing, editorFrame, info, loadFrame, view.tab, visible]);
  useEffect(() => {
    if (Object.keys(frames).length <= 24 || !draft) return;
    const keep = new Set([...draft.slots.map(item => item.frame), ...(draft.editing ? [-2, -1, 0, 1, 2].map(delta => editorFrame + delta) : []), ...(preview !== null ? [preview] : [])]);
    const removable = Object.keys(frames).map(Number).filter(frame => !keep.has(frame) && !requests.current.has(frame));
    if (!removable.length) return;
    for (const frame of removable) { const url = frames[frame]?.url; if (url) { URL.revokeObjectURL(url); objectUrls.current.delete(url); } }
    setFrames(value => Object.fromEntries(Object.entries(value).filter(([key]) => !removable.includes(Number(key)))));
  }, [draft, editorFrame, frames, preview]);
  const validSlots = draft?.slots.filter(item => frames[item.frame]?.url) || [];
  const dimensions = useMemo(() => info && draft ? multiviewDimensions(info, draft.slots.length, draft.layout) : null, [draft, info]);
  useEffect(() => {
    if (!visible || !validSlots.length || collapsedFor.current === storageKey) return;
    collapsedFor.current = storageKey;
    let explicitPreference = false;
    try { explicitPreference = localStorage.getItem(`sd2:multiview:preferences:v1:${owner}`) !== null; } catch {}
    if (!explicitPreference && !generationArea.current?.contains(document.activeElement)) setExpanded(false);
  }, [owner, storageKey, validSlots.length, visible]);

  function changeExpanded(value: boolean) {
    setExpanded(value);
    try { localStorage.setItem(`sd2:multiview:preferences:v1:${owner}`, JSON.stringify({ expanded: value })); } catch { setViewSaved(false); }
  }
  function update(next: MultiviewDraft, allowUndo = false) {
    const changed = Boolean(draft && contentKey(owner, taskId, draft, 'png') !== contentKey(owner, taskId, next, 'png'));
    if (operation.current && changed) return;
    if (allowUndo) setUndo(draft);
    if (changed) clearArtifacts();
    draftRef.current = next; setDraft(next); if (!operation.current) setNotice(''); setSaved(false); setPartialFormat(null); setActivity(value => value + 1);
  }
  function chooseCount(count: number) {
    if (!draft || !info || count === draft.slots.length) return;
    if (count < draft.slots.length) { setReduceCount(count); setRetained(draft.slots.slice(0, count).map(item => item.id)); return; }
    const restored = draft.reserve.slice(0, count - draft.slots.length);
    const slots = [...draft.slots, ...restored];
    const reserve = draft.reserve.slice(restored.length);
    const restoreOrder = preservedSlotOrder(draft.restoreOrder, slots, reserve);
    slots.sort((a, b) => restoreOrder.indexOf(a.id) - restoreOrder.indexOf(b.id));
    for (const frame of [...candidateFrames(info.timestamps.length, count), ...Array.from({ length: info.timestamps.length }, (_, index) => index)]) { if (slots.length >= count) break; if (!slots.some(item => item.frame === frame)) slots.push(slot(frame)); }
    if (slots.length !== count) { setNotice(`原视频可用帧不足，无法补齐 ${count} 张；原选帧和数量已保留。`); return; }
    update({ ...draft, slots, reserve, restoreOrder: preservedSlotOrder(restoreOrder, slots, reserve) }, true);
  }
  function move(index: number, delta: number) {
    if (!draft || index + delta < 0 || index + delta >= draft.slots.length) return;
    const slots = [...draft.slots]; [slots[index], slots[index + delta]] = [slots[index + delta], slots[index]];
    update({ ...draft, slots, restoreOrder: undefined }, true);
  }
  function openEditor(item: MultiviewSlot) {
    if (!draft) return;
    video.current?.pause(); setEditorFrame(item.frame); setView(value => ({ ...value, tab: 'frames', selected: item.id }));
    if (video.current && info) video.current.currentTime = info.timestamps[item.frame];
    update({ ...draft, editing: item.id, editorFrame: item.frame });
  }
  function selectSlot(item: MultiviewSlot) {
    setView(value => ({ ...value, selected: item.id, tab: 'frames' })); setActivity(value => value + 1);
    if (draft?.editing && draft.editing !== item.id) openEditor(item);
  }
  function seek(frame: number) {
    if (!info) return;
    const value = Math.min(info.timestamps.length - 1, Math.max(0, frame));
    setEditorFrame(value); setSaved(false); setActivity(count => count + 1);
    setDraft(current => current ? { ...current, editorFrame: value } : current);
    if (video.current) { video.current.pause(); video.current.currentTime = info.timestamps[value]; }
  }
  async function selectTask(nextTask: string, automatic = false) {
    if (!safeTask(nextTask) || ownerRef.current !== owner || isClientSessionBlocked()) return;
    if (nextTask === taskId) { setPickerOpen(false); setPendingResult(null); return; }
    if (operation.current && !await confirm('拼图仍在准备或复制。切换后停止使用本次临时文件，原选帧会保留。', { title: '切换视频', confirmLabel: '停止并切换' })) return;
    video.current?.pause(); context.current += 1; abort.current?.abort(); clearUrls();
    allowScrollRestore.current = !automatic;
    if (taskId && taskId !== nextTask) setPreviousTask(taskId);
    setLocation({ owner, taskId: nextTask }); setActivity(count => count + 1); setPickerOpen(false); setPendingResult(null);
    const url = new URL(window.location.href); url.searchParams.set('taskId', nextTask);
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }
  function generationReady(result: MultiviewGenerationReady) {
    if (result.ownerId !== ownerRef.current || isClientSessionBlocked()) return;
    const key = `${result.ownerId}:${result.requestKey}`;
    if (seenReady.current.has(key) && !result.explicitOpen) return;
    seenReady.current.add(key);
    if (result.explicitOpen || !operation.current && result.startedFromSourceKey === sourceKeyRef.current) void selectTask(result.taskId, !result.explicitOpen); else setPendingResult(result);
  }
  function finishOperation(op: ArtifactOperation) { if (operation.current?.token === op.token) { operation.current = null; setExporting(false); } }
  function beginArtifact(format: 'png' | 'zip', selected: MultiviewSlot[]) {
    if (!draft || !info || !visible || operation.current || !selected.length) return null;
    const frozen = selected.map(item => ({ ...item }));
    const op: ArtifactOperation = { token: Symbol(), generation: context.current, controller: new AbortController(),
      key: contentKey(owner, taskId, draft, format, frozen), owner, authority, taskId, version: info.sourceVersion, format, slots: frozen, layout: { ...draft.layout } };
    operation.current = op; setExporting(true); setNotice(format === 'png' ? '正在准备原尺寸拼图…' : '正在准备原尺寸单图包…'); return op;
  }
  function checkOperation(op: ArtifactOperation) {
    if (op.controller.signal.aborted || op.generation !== context.current || op.owner !== ownerRef.current || op.authority !== authorityRef.current || isClientSessionBlocked()) throw new Error('账号或视频已变化，本次文件不再使用');
  }
  async function artifactFor(op: ArtifactOperation): Promise<Artifact> {
    checkOperation(op);
    const fresh = await fetch(`/api/video/multiview/${encodeURIComponent(op.taskId)}`, { cache: 'no-store', signal: AbortSignal.any([op.controller.signal, AbortSignal.timeout(120000)]) });
    const metadata = await fresh.json(); checkOperation(op);
    if (!fresh.ok || metadata.info?.sourceVersion !== op.version) {
      if ([401, 403, 404, 409].includes(fresh.status) || fresh.ok) rejectSource(metadata.error || '原视频权限或版本已变化，请重新读取');
      throw new Error(metadata.error || '暂时无法核对原视频，请稍后重试');
    }
    const cached = artifacts.current.get(op.key); if (cached) return cached;
    const existing = artifactInflight.current.get(op.key); if (existing) return existing;
    const pending = (async () => {
      const response = await fetch(`/api/video/multiview/${encodeURIComponent(op.taskId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: op.version, format: op.format, frames: op.slots.map(item => item.frame), names: op.slots.map(item => item.name), layout: op.layout }), signal: AbortSignal.any([op.controller.signal, AbortSignal.timeout(180000)]) });
      checkOperation(op);
      if (!response.ok) {
        const value = await response.json().catch(() => ({}));
        if ([401, 403, 404, 409].includes(response.status)) rejectSource(value.error || '原视频权限或版本已变化，请重新读取');
        throw new Error(value.error || '文件准备失败，可重试；原视频不重跑');
      }
      const blob = await response.blob(); checkOperation(op);
      const length = response.headers.get('Content-Length');
      if (!blob.size || blob.type !== (op.format === 'png' ? 'image/png' : 'application/zip') || length && Number(length) !== blob.size) throw new Error('文件未完整收到，请重新准备；选帧保持不变');
      const url = URL.createObjectURL(blob); objectUrls.current.add(url);
      for (const [key, prior] of Array.from(artifacts.current.entries())) {
        if (prior.format === op.format) { URL.revokeObjectURL(prior.url); objectUrls.current.delete(prior.url); artifacts.current.delete(key); }
      }
      const artifact = { blob, url, key: op.key, name: `multiview-${op.taskId}.${op.format}`, format: op.format, slots: op.slots }; artifacts.current.set(op.key, artifact); return artifact;
    })();
    artifactInflight.current.set(op.key, pending);
    try { return await pending; } finally { if (artifactInflight.current.get(op.key) === pending) artifactInflight.current.delete(op.key); }
  }
  async function download(format: 'png' | 'zip', onlyReady = false) {
    if (!draft) return;
    const selected = onlyReady ? validSlots : draft.slots;
    if (selected.length !== draft.slots.length && !await confirm(`仅导出当前已就绪的 ${selected.length} 张，按当前顺序重新排版。原草稿数量不变。`, { title: '部分导出', confirmLabel: '下载所选图片' })) return;
    const op = beginArtifact(format, selected); if (!op) return;
    try {
      const file = await artifactFor(op); checkOperation(op); setExportFile(file);
      const link = document.createElement('a'); link.href = file.url; link.download = file.name; document.body.append(link); link.click(); link.remove();
      setNotice(`已将 ${selected.length} 张的文件交给浏览器下载；若未开始，可点击“下载已准备文件”。`);
    } catch (cause) { if (op.generation === context.current) setNotice(cause instanceof Error ? cause.message : '下载未完成，可重试'); }
    finally { finishOperation(op); }
  }
  async function downloadPrepared(file: Artifact) {
    const op = beginArtifact(file.format, file.slots); if (!op) return;
    try {
      if (op.key !== file.key) throw new Error('拼图已调整，请重新准备当前文件');
      const ready = await artifactFor(op); checkOperation(op);
      const link = document.createElement('a'); link.href = ready.url; link.download = ready.name; document.body.append(link); link.click(); link.remove();
      setNotice('已再次交给浏览器下载；是否保存由浏览器决定。');
    } catch (cause) { if (op.generation === context.current) setNotice(cause instanceof Error ? cause.message : '暂时无法下载，请重试'); }
    finally { finishOperation(op); }
  }
  function copyCollage() {
    if (!draft || validSlots.length !== draft.slots.length) return;
    const op = beginArtifact('png', draft.slots); if (!op) return;
    const prepared = artifactFor(op);
    // Start write in this click. The authorized PNG is prepared inside ClipboardItem's Promise.
    const writing = copyPngBlob(prepared.then(file => { checkOperation(op); return file.blob; }));
    void prepared.then(file => { if (op.generation === context.current) setExportFile(file); }).catch(() => undefined);
    void writing.then(() => { checkOperation(op); setNotice('拼图已复制，可粘贴到支持图片的应用。'); }).catch(cause => {
      if (op.generation === context.current) setNotice(cause instanceof Error && cause.name !== 'NotAllowedError' ? cause.message : '复制未获允许，可下载同一张拼图。');
    });
    void Promise.allSettled([prepared, writing]).finally(() => finishOperation(op));
  }
  async function clearWorkspace() {
    if (operation.current || !await confirm('清除此账号当前视频在本机的选帧、名称、排序和排版？服务器原视频及生成记录不会删除，生成设置也保留。', { title: '清除本机选帧', confirmLabel: '清除并重新选帧', danger: true })) return;
    if (!info) return;
    try { localStorage.removeItem(storageKey); localStorage.removeItem(viewKey); } catch { setViewSaved(false); }
    clearArtifacts(); update(initialDraft(info)); setView(emptyView()); setOriginalOpen(false); setUndo(null); setEditorFrame(0); setReduceCount(null);
  }
  const editing = draft?.slots.find(item => item.id === draft.editing);
  const selected = draft?.slots.find(item => item.id === view.selected) || draft?.slots[0];
  const selectedIndex = draft && selected ? draft.slots.indexOf(selected) : 0;
  const currentFrame = frames[editorFrame];
  const stage = visible ? validSlots.length === draft?.slots.length ? 4 : 3 : ['submitting', 'submitted', 'unknown', 'video_ready'].includes(generation.phase) ? 2 : 1;
  const existingSource = visible && generation.taskId !== taskId;
  const playerEpoch = context.current;
  const mediaCurrent = () => playerEpoch === context.current && authorityRef.current === authority && !isClientSessionBlocked();
  const player = info && <div className={styles.videoArea}>
    {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
    <video ref={video} src={source} controls playsInline preload="metadata" loop={loop.enabled}
      onLoadedMetadata={event => { if (!mediaCurrent()) return; event.currentTarget.pause(); event.currentTarget.currentTime = Math.min(info.duration, editing ? info.timestamps[editorFrame] : viewRef.current.time); }}
      onTimeUpdate={event => { if (!mediaCurrent()) return; const time = event.currentTarget.currentTime; setView(value => Math.abs(value.time - time) >= 1 ? { ...value, time } : value); }}
      onPause={event => {
        if (!mediaCurrent()) return;
        const time = event.currentTarget.currentTime; setView(value => ({ ...value, time }));
        if (!editing || operation.current) return;
        let nearest = 0; for (let i = 1; i < info.timestamps.length; i++) if (Math.abs(info.timestamps[i] - time) < Math.abs(info.timestamps[nearest] - time)) nearest = i;
        setEditorFrame(nearest); setDraft(current => current ? { ...current, editorFrame: nearest } : current);
      }} />
    <VideoLoopButton enabled={loop.enabled} onToggle={loop.toggle} disabled={!loop.ready} storageUnavailable={loop.storageUnavailable} />
    <small>原视频实际版本／原生成轮次未知 · 原视频预览，不会重新生成</small>
  </div>;
  function collage(slots: MultiviewSlot[], interactive: boolean) {
    if (!info || !draft || !slots.length) return null;
    const size = multiviewDimensions(info, slots.length, draft.layout); const columns = Math.min(slots.length, draft.layout.columns);
    return <svg role="group" aria-label={`${slots.length} 张最终拼图，${size.width}乘${size.height}像素`} viewBox={`0 0 ${size.width} ${size.height}`}>
      <rect width={size.width} height={size.height} fill={draft.layout.background} />
      {slots.map((item, index) => {
        const x = draft.layout.margin + index % columns * (info.width + draft.layout.gap);
        const y = draft.layout.margin + Math.floor(index / columns) * (info.height + draft.layout.gap);
        const choose = () => { if (interactive) selectSlot(item); };
        return <g key={item.id} role={interactive ? 'button' : undefined} tabIndex={interactive ? 0 : undefined}
          aria-label={`选择第 ${index + 1} 张${item.name ? `：${item.name}` : ''}`} aria-pressed={interactive ? selected?.id === item.id : undefined}
          className={interactive ? styles.collageCell : undefined} onClick={choose} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(); } }}>
          <rect x={x} y={y} width={info.width} height={info.height} fill="#e7eaee" />
          {frames[item.frame]?.url ? <image href={frames[item.frame].url} x={x} y={y} width={info.width} height={info.height} />
            : <text x={x + info.width / 2} y={y + info.height / 2} textAnchor="middle" fill="#526170" fontSize={Math.max(14, info.width / 22)}>{frames[item.frame]?.error ? '这一帧未就绪' : '正在提取…'}</text>}
          {interactive && selected?.id === item.id && <rect x={x + 2} y={y + 2} width={info.width - 4} height={info.height - 4} fill="none" stroke="var(--primary, #2563eb)" strokeWidth="3" vectorEffect="non-scaling-stroke" />}
        </g>;
      })}
    </svg>;
  }

  return <div className={styles.page}>
    <PageBanner title="多角度图" description="一张主图生成旋转视频，再选帧排版。已有视频也可直接制作，不会重新生成。" backHref={backHref} backLabel={taskId ? '返回原视频' : '返回创作首页'} />
    <ol className={styles.stages} aria-label="当前制作阶段">{['导入图片', '生成视频', '提取视图', '调整与导出'].map((label, index) => <li key={label} aria-current={stage === index + 1 ? 'step' : undefined} data-done={existingSource && index < 2 ? 'existing' : stage > index + 1 || undefined}><span>{index + 1}</span>{existingSource && index < 2 ? index === 0 ? '已有视频' : '直接使用成品' : label}</li>)}</ol>
    <div ref={generationArea}><MultiviewGenerationPanel currentSourceKey={currentSourceKey} hasResult={Boolean(visible)} expanded={expanded} onExpandedChange={changeExpanded}
      onUseExisting={() => setPickerOpen(true)} onReady={generationReady} onStateChange={setGeneration}
      initialProjectId={query.get('projectId') || undefined} initialVideoCardId={query.get('videoCardId') || undefined} /></div>
    {pendingResult && pendingResult.ownerId === owner && <div className={styles.notice} role="status">新视频已就绪，当前选帧未被覆盖。<button type="button" onClick={() => void selectTask(pendingResult.taskId)}>打开新结果</button></div>}
    {previousTask && previousTask !== taskId && <button type="button" className={styles.quiet} onClick={() => void selectTask(previousTask)}>返回上次结果</button>}
    {loading && <p className={styles.empty} role="status">正在核对原视频并读取候选图片…</p>}
    {error && <div className={styles.empty} role="status"><p>{error}</p><button type="button" onClick={() => void load()}>重新读取原视频</button><button type="button" onClick={() => setPickerOpen(true)}>使用已有视频</button></div>}
    {visible && info && draft && <section className={styles.result} aria-label="多角度成品工作台">
      <header className={styles.resultHeader}><div><h2>最终拼图</h2><p>时间候选，角度由你确认 · 点击一格调整</p></div><div className={styles.count} aria-label="图片数量">{[3, 4, 8].map(count => <button type="button" key={count} aria-pressed={draft.slots.length === count} disabled={exporting} onClick={() => chooseCount(count)}>{count} 张</button>)}</div></header>
      {reduceCount !== null && <section className={styles.retain} aria-label="选择保留图片"><h3>保留哪 {reduceCount} 张？</h3><p>其余留在本次草稿，增加数量或撤销时可找回。</p><div className={styles.retainOptions}>{draft.slots.map((item, index) => <label key={item.id}><input type="checkbox" checked={retained.includes(item.id)} onChange={event => setRetained(value => event.target.checked ? [...value, item.id] : value.filter(id => id !== item.id))} />第 {index + 1} 张{item.manual ? ' · 已手选' : ''}{item.name && ` · ${item.name}`}</label>)}</div><button type="button" className={styles.primary} disabled={retained.length !== reduceCount} onClick={() => {
        const slots = draft.slots.filter(item => retained.includes(item.id));
        const reserve = [...draft.slots.filter(item => !retained.includes(item.id)), ...draft.reserve].slice(0, 16);
        const restoreOrder = preservedSlotOrder(draft.restoreOrder || [...draft.slots, ...draft.reserve].map(item => item.id), slots, reserve);
        update({ ...draft, slots, reserve, restoreOrder, editing: null }, true); setReduceCount(null);
      }}>保留所选 {retained.length} 张</button><button type="button" onClick={() => setReduceCount(null)}>取消</button></section>}
      <div className={styles.workbench}>
        <div className={styles.resultMain}><div className={styles.previewToolbar}><span>拼图预览</span><label>显示大小<select aria-label="拼图显示大小" value={view.zoom} onChange={event => setView(value => ({ ...value, zoom: Number(event.target.value) }))}>{[.5, .75, 1, 1.5, 2, 3, 4].map(zoom => <option value={zoom} key={zoom}>{zoom === 1 ? '适合窗口' : `${zoom * 100}%`}</option>)}</select></label>{undo && <button type="button" disabled={exporting} onClick={() => { const value = undo; update(value); setUndo(null); }}><Undo2 size={14} />撤销</button>}</div>
          <div ref={collageViewport} className={styles.collageViewport} onScroll={event => { const { scrollLeft: panX, scrollTop: panY } = event.currentTarget; setView(value => value.panX === panX && value.panY === panY ? value : { ...value, panX, panY }); }}><div className={styles.collage} style={{ width: `${view.zoom * 100}%` }}>{collage(draft.slots, true)}</div></div>
          <p className={styles.caption}>每张 {info.width} × {info.height} · 拼图 {dimensions?.width} × {dimensions?.height} · 原图不裁剪、不放大</p>
          <div className={styles.slotStrip} aria-label="选择要调整的图片">{draft.slots.map((item, index) => <button type="button" key={item.id} aria-pressed={selected?.id === item.id} onClick={() => selectSlot(item)}>{frames[item.frame]?.url && <img src={frames[item.frame].url} alt="" />}<span>{item.name || `第 ${index + 1} 张`}</span>{frames[item.frame]?.error && <span>未就绪</span>}</button>)}</div>
        </div>
        <aside className={styles.tools} aria-label="当前拼图工具"><div className={styles.toolTabs} role="tablist" aria-label="拼图工具"><button type="button" id="mv-frames-tab" role="tab" aria-controls="mv-frames-panel" aria-selected={view.tab === 'frames'} onClick={() => setView(value => ({ ...value, tab: 'frames' }))}>选帧</button><button type="button" id="mv-layout-tab" role="tab" aria-controls="mv-layout-panel" aria-selected={view.tab === 'layout'} onClick={() => setView(value => ({ ...value, tab: 'layout' }))}>排版</button></div>
          {view.tab === 'frames' && selected && <div role="tabpanel" id="mv-frames-panel" aria-labelledby="mv-frames-tab" className={styles.toolBody}>
            <header className={styles.selectionTitle}><h3>第 {selectedIndex + 1} 张</h3><span>{info.timestamps[selected.frame].toFixed(3)} 秒{selected.manual ? ' · 已手选' : ''}</span></header>
            <label>方向名称（可选）<input maxLength={40} value={selected.name} placeholder="例如：正面，由你确认" disabled={exporting} onChange={event => update({ ...draft, slots: draft.slots.map(item => item.id === selected.id ? { ...item, name: event.target.value } : item) })} /></label>
            <div className={styles.inlineActions}><button type="button" disabled={exporting || selectedIndex === 0} onClick={() => move(selectedIndex, -1)}><ArrowLeft size={15} />向前</button><button type="button" disabled={exporting || selectedIndex === draft.slots.length - 1} onClick={() => move(selectedIndex, 1)}>向后<ArrowRight size={15} /></button><button type="button" disabled={!frames[selected.frame]?.url} onClick={() => setPreview(selected.frame)}><Expand size={15} />放大</button></div>
            {frames[selected.frame]?.error && <div className={styles.frameError} role="status">{frames[selected.frame].error}<button type="button" onClick={() => void loadFrame(selected.frame, true)}><RefreshCw size={13} />重试这一格</button></div>}
            {!editing && <button type="button" className={styles.primary} onClick={() => openEditor(selected)}>换一帧</button>}
            {editing && <section className={styles.editor} aria-label={`替换第 ${draft.slots.indexOf(editing) + 1} 张`}><header><h3>替换第 {draft.slots.indexOf(editing) + 1} 张</h3><button type="button" aria-label="取消换帧" onClick={() => update({ ...draft, editing: null })}><X size={16} /></button></header>
              <button type="button" className={styles.candidate} disabled={!currentFrame?.url} onClick={() => setPreview(editorFrame)} aria-label="放大待选帧">{currentFrame?.url ? <img src={currentFrame.url} alt="待选帧，尚未应用" /> : <span>{currentFrame?.error || '正在读取这一帧…'}</span>}</button>
              {player}<label className={styles.timeline}>第 {editorFrame + 1} / {info.timestamps.length} 帧 · {info.timestamps[editorFrame].toFixed(3)} 秒<input aria-label="选择视频帧" type="range" min={0} max={info.timestamps.length - 1} step={1} value={editorFrame} onChange={event => seek(Number(event.target.value))} /></label>
              <div className={styles.neighbors}>{[-2, -1, 0, 1, 2].map(delta => editorFrame + delta).filter(frame => frame >= 0 && frame < info.timestamps.length).map(frame => <button type="button" key={frame} aria-pressed={frame === editorFrame} onClick={() => seek(frame)}>{frames[frame]?.url && <img src={frames[frame].url} alt={`第 ${frame + 1} 帧`} />}<span>{frame === editorFrame ? '当前' : frame < editorFrame ? `前 ${editorFrame - frame}` : `后 ${frame - editorFrame}`}</span></button>)}</div>
              <div className={styles.inlineActions}><button type="button" disabled={editorFrame === 0} onClick={() => seek(editorFrame - 1)}>上一帧</button><button type="button" disabled={editorFrame === info.timestamps.length - 1} onClick={() => seek(editorFrame + 1)}>下一帧</button>{currentFrame?.error && <button type="button" onClick={() => void loadFrame(editorFrame, true)}>重试此帧</button>}</div>
              <div className={styles.inlineActions}><button type="button" className={styles.primary} disabled={!currentFrame?.url || exporting} onClick={() => { video.current?.pause(); update({ ...draft, slots: draft.slots.map(item => item.id === editing.id ? { ...item, frame: editorFrame, manual: true } : item), editing: null }, true); }}>使用这一帧</button><button type="button" onClick={() => update({ ...draft, editing: null })}>取消</button></div>
            </section>}
          </div>}
          {view.tab === 'layout' && <div role="tabpanel" id="mv-layout-panel" aria-labelledby="mv-layout-tab" className={styles.toolBody}><h3>拼图排版</h3><label>拼图列数<select value={draft.layout.columns} disabled={exporting} onChange={event => update({ ...draft, layout: { ...draft.layout, columns: Number(event.target.value) } })}>{[1, 2, 3, 4, 8].map(value => <option key={value} value={value}>{value} 列</option>)}</select></label>
            <label>外侧留白（像素）<input type="number" min={0} max={128} step={1} value={draft.layout.margin} disabled={exporting} onChange={event => update({ ...draft, layout: { ...draft.layout, margin: Math.round(Math.max(0, Math.min(128, Number(event.target.value) || 0))) } })} /></label><label>图片间距（像素）<input type="number" min={0} max={128} step={1} value={draft.layout.gap} disabled={exporting} onChange={event => update({ ...draft, layout: { ...draft.layout, gap: Math.round(Math.max(0, Math.min(128, Number(event.target.value) || 0))) } })} /></label><label>留白底色<input type="color" value={draft.layout.background} disabled={exporting} onChange={event => update({ ...draft, layout: { ...draft.layout, background: event.target.value } })} /></label><button type="button" disabled={exporting} onClick={() => update({ ...draft, layout: { ...DEFAULT_MULTIVIEW_LAYOUT } }, true)}>重置排版</button><p>只调整留白，不去背景、不裁剪原帧。单图包仍为原尺寸。</p></div>}
        </aside>
      </div>
      {validSlots.length > 0 && validSlots.length < draft.slots.length && <div className={styles.partial} role="status"><p>{validSlots.length} / {draft.slots.length} 张就绪。可重试未就绪格，或明确只导出当前可用图片。</p><div className={styles.inlineActions}><button type="button" disabled={exporting} onClick={() => setPartialFormat('png')}>仅导出可用拼图</button><button type="button" disabled={exporting} onClick={() => setPartialFormat('zip')}>仅下载可用单图</button></div>{partialFormat && <div className={styles.partialPreview}>{collage(validSlots, false)}<p>本次 {validSlots.length} 张，原草稿仍为 {draft.slots.length} 张；复制完整拼图仍需全部就绪。</p><button type="button" className={styles.primary} disabled={exporting} onClick={() => void download(partialFormat, true)}>确认并下载这 {validSlots.length} 张</button><button type="button" onClick={() => setPartialFormat(null)}>取消</button></div>}</div>}
      {notice && <div className={styles.notice} role="status">{notice}{exportFile && <button type="button" disabled={exporting} onClick={() => void downloadPrepared(exportFile)}>下载已准备文件</button>}</div>}
      {(!saved || !viewSaved) && <p className={styles.warning} role="status">本机存储暂不可用，刷新可能丢失本次工作现场；当前编辑和原图导出仍可使用。</p>}
      <footer className={styles.exportBar}><div><strong>{validSlots.length} / {draft.slots.length} 张就绪</strong><small>{dimensions?.width} × {dimensions?.height} · {saved && viewSaved ? '已保存到此设备' : '本机保存未完成'}</small></div><div className={styles.exportActions}><button type="button" className={styles.primary} disabled={exporting || validSlots.length !== draft.slots.length} onClick={copyCollage}><Copy size={16} />{exporting ? '正在准备…' : '一键复制拼图'}</button><button type="button" disabled={exporting || validSlots.length !== draft.slots.length} onClick={() => void download('png')}><Download size={16} />下载拼图</button><button type="button" disabled={exporting || validSlots.length !== draft.slots.length} onClick={() => void download('zip')}>下载单图包</button></div></footer>
      <div className={styles.footnote}><details open={originalOpen} onToggle={event => { const open = event.currentTarget.open; setOriginalOpen(open); setView(value => value.originalOpen === open ? value : { ...value, originalOpen: open }); }}><summary>查看原视频</summary>{originalOpen && !editing && player}{editing && <p>原视频正在右侧换帧工具中显示。</p>}</details><button type="button" className={styles.quiet} disabled={exporting} onClick={() => void clearWorkspace()}>清除本机选帧</button><p>草稿仅属本账号与此原片版本。失权时停止显示；提帧或导出失败不会重跑视频。</p></div>
      {preview !== null && frames[preview]?.url && <ZoomableImagePreview src={frames[preview].url!} alt="多角度原尺寸帧" imageSharing={false} sourceVersion={info.sourceVersion} previewKey={`multiview-${taskId}-${info.sourceVersion}-${preview}`} onClose={() => setPreview(null)} safeDetails={{ width: info.width, height: info.height }} />}
    </section>}
    <MultiviewSourcePicker open={pickerOpen} onClose={() => setPickerOpen(false)} onSelect={id => void selectTask(id)} currentTaskId={taskId} />
    {productDialog}
  </div>;
}
export default function MultiviewPage() {
  return <Suspense fallback={<div className={styles.page} role="status" aria-busy="true">正在载入多角度工作区…</div>}><MultiviewPageContent /></Suspense>;
}
