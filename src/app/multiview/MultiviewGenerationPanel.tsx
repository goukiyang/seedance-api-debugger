'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, FolderOpen, ImagePlus, RefreshCw, Upload } from 'lucide-react';
import { UploadedImagePicker } from '@/components/UploadedImagePicker';
import { UploadProgressIndicator } from '@/components/UploadProgressIndicator';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { isExternalUser } from '@/lib/access/external-role';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import { uploadFileToHistory, type UploadProgressSnapshot } from '@/lib/http/file-upload';
import { uploadSession } from '@/lib/http/upload-session';
import { readJsonResponse } from '@/lib/http/json-response';
import type { PickerItem } from '@/lib/assets/picker-types';
import { RATIO_OPTIONS, RESOLUTION_OPTIONS, type WorkspaceAssetItem } from '@/types';
import { SEEDANCE_VIDEO_MODEL_OPTIONS, seedanceVideoDurationOptions } from '@/lib/provider/seedance-models';
import {
  MULTIVIEW_ROTATION_PRESET, defaultMultiviewGenerationDraft, parseMultiviewGenerationDraft,
  composeMultiviewGenerationPrompt, buildMultiviewGenerationRequest, isMultiviewWorkspaceTabId, isMultiviewGenerationSeed, type MultiviewGenerationDraft,
} from '@/lib/video/multiview-generation-contract';
import styles from './multiview-generation.module.css';

export type MultiviewGenerationPhase = 'empty' | 'ready' | 'submitting' | 'submitted' | 'unknown' | 'failed' | 'video_ready';
export type MultiviewGenerationPanelState = { phase: MultiviewGenerationPhase; busy: boolean; taskId?: string };
export type MultiviewGenerationReady = { taskId: string; requestKey: string; ownerId: string;
  startedFromSourceKey: string | null; explicitOpen: boolean };
export type MultiviewGenerationPanelProps = {
  currentSourceKey: string | null; hasResult: boolean; expanded: boolean; onExpandedChange: (expanded: boolean) => void;
  onUseExisting: () => void; onReady: (result: MultiviewGenerationReady) => void;
  onStateChange?: (state: MultiviewGenerationPanelState) => void; initialProjectId?: string; initialVideoCardId?: string;
};
type Project = { id: string; name: string; type: string; status?: string; can_generate?: boolean };
type VideoCard = { id: string; project_id: string; title: string; status: string };
type RequestReceipt = { schema: 1; ownerId: string; key: string; fingerprint: string; taskId: string | null;
  phase: 'unknown' | 'accepted' | 'ready' | 'failed' | 'rejected'; startedFromSourceKey: string | null };
type Association = { schema: 1; ownerId: string; requestId: string; workspaceTabId: string; assetId: string; referenceImageId?: string };
type ApiError = { error?: string; message?: string; code?: string; task_id?: string; existing_task_id?: string };
type TaskStatus = ApiError & { id: string; local_status: string; idempotency_key?: string | null; submission_unconfirmed?: boolean };
type Quote = { key: string; points: number };
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
const keyFor = (owner: string, part: string) => `sd2:multiview-generation:v1:${owner}:${part}`;
const tabKey = (owner: string, tab: string, part: string) => keyFor(owner, `tab:${tab}:${part}`);
const receiptKey = (owner: string, key: string) => keyFor(owner, `receipt:${key}`);
const TAB_STORAGE_KEY = 'sd2:multiview-generation:v1:tab';
const MAX_SCAN_KEYS = 8192;
type RequestScan = { records: RequestReceipt[]; incomplete: boolean; invalid: boolean; next: number | null };
const pendingActive = (receipt: RequestReceipt | null) => receipt?.phase === 'unknown' || receipt?.phase === 'accepted';
function parseReceipt(raw: string | null, owner: string): RequestReceipt | null {
  if (!raw) return null;
  if (raw.length > 4096) throw new Error('原请求记录无法确认，请先核对任务，不会重新生成。');
  const value = JSON.parse(raw) as RequestReceipt;
  if (value?.schema !== 1 || value.ownerId !== owner || !identifier(value.key) || !/^[a-f0-9]{64}$/.test(value.fingerprint)
    || value.taskId !== null && !identifier(value.taskId) || !['unknown', 'accepted', 'ready', 'failed', 'rejected'].includes(value.phase)
    || value.startedFromSourceKey !== null && (typeof value.startedFromSourceKey !== 'string' || value.startedFromSourceKey.length > 4096)) throw new Error('原请求记录无法确认，请先核对任务，不会重新生成。');
  return value;
}
function parseAssociation(raw: string | null, owner: string): Association | null {
  if (!raw || raw === 'null') return null;
  if (raw.length > 2048) throw new Error('原素材加入记录无法确认，请先核对素材。');
  const value = JSON.parse(raw) as Association;
  if (value?.schema !== 1 || value.ownerId !== owner || !identifier(value.requestId) || !isMultiviewWorkspaceTabId(value.workspaceTabId)
    || !identifier(value.assetId) || value.referenceImageId !== undefined && !identifier(value.referenceImageId)) throw new Error('原素材加入记录无法确认，请先核对素材。');
  return value;
}
function persist(key: string, value: unknown) {
  const bytes = JSON.stringify(value);
  localStorage.setItem(key, bytes);
  if (localStorage.getItem(key) !== bytes) throw new Error('本机记录未能保存，尚未提交。请允许本机存储后重试。');
}
function persistPointer(key: string, value: string) {
  if (!identifier(value)) throw new Error('本页记录编号无法确认，未提交。');
  localStorage.setItem(key, value);
  if (localStorage.getItem(key) !== value) throw new Error('本页记录未能保存，未提交。');
}
function readTabId() {
  const previous = sessionStorage.getItem(TAB_STORAGE_KEY);
  if (previous && !identifier(previous)) throw new Error('本标签的原现场编号无法确认，不能新建生成请求。');
  const next = previous || `mvtab-${crypto.randomUUID()}`;
  sessionStorage.setItem(TAB_STORAGE_KEY, next);
  if (sessionStorage.getItem(TAB_STORAGE_KEY) !== next) throw new Error('本标签记录无法保存，不能新建生成请求。');
  return next;
}
function readCurrentReceipt(owner: string, tab: string): RequestReceipt | null {
  const own = tab ? localStorage.getItem(tabKey(owner, tab, 'request-key')) : null;
  const pointer = own ?? localStorage.getItem(keyFor(owner, 'last-request-key'));
  if (pointer !== null) {
    if (!identifier(pointer)) throw new Error('原请求编号无法确认，未新建请求。');
    const result = parseReceipt(localStorage.getItem(receiptKey(owner, pointer)), owner);
    if (!result || result.key !== pointer) throw new Error('原请求记录缺失，不能按没有请求处理。');
    return result;
  }
  // Read-only compatibility for the original account-wide slot. Never remove it.
  return parseReceipt(localStorage.getItem(keyFor(owner, 'request')), owner);
}
function readAssociation(owner: string, tab: string) {
  const own = tab ? localStorage.getItem(tabKey(owner, tab, 'association')) : null;
  if (own !== null) return parseAssociation(own, owner);
  const previousTab = localStorage.getItem(keyFor(owner, 'last-association-tab'));
  if (previousTab !== null) {
    if (!identifier(previousTab)) throw new Error('原素材加入现场无法确认。');
    return parseAssociation(localStorage.getItem(tabKey(owner, previousTab, 'association')), owner);
  }
  return parseAssociation(localStorage.getItem(keyFor(owner, 'association')), owner);
}
function scanRequests(owner: string, offset = 0): RequestScan {
  const records = new Map<string, RequestReceipt>(); let invalid = false;
  try {
    const length = localStorage.length;
    const end = Math.min(length, offset + MAX_SCAN_KEYS);
    for (let index = offset; index < end; index++) {
      const name = localStorage.key(index);
      if (!name?.startsWith(`${keyFor(owner, 'receipt')}:`)) continue;
      try {
        const record = parseReceipt(localStorage.getItem(name), owner);
        if (!record || name !== receiptKey(owner, record.key)) invalid = true;
        else records.set(record.key, record);
      } catch { invalid = true; }
    }
    try {
      const legacy = parseReceipt(localStorage.getItem(keyFor(owner, 'request')), owner);
      if (legacy && !records.has(legacy.key)) {
        const independent = parseReceipt(localStorage.getItem(receiptKey(owner, legacy.key)), owner);
        records.set(legacy.key, independent || legacy);
      }
    } catch { invalid = true; }
    const incomplete = end < length || localStorage.length !== length;
    return { records: Array.from(records.values()), invalid, incomplete, next: end < length ? end : null };
  } catch { return { records: [], invalid: true, incomplete: true, next: null }; }
}
function persistDraft(owner: string, tab: string, value: MultiviewGenerationDraft) {
  if (!parseMultiviewGenerationDraft(value)) throw new Error('本次输入超出本机草稿保存范围，原已保存草稿未被覆盖。');
  if (!identifier(tab)) throw new Error('本标签的现场编号尚未确认，原草稿未覆盖。');
  persist(tabKey(owner, tab, 'draft'), value);
  // Only a new tab uses this last-valid fallback; other open tabs keep their own draft.
  persist(keyFor(owner, 'draft'), value);
}
function message(cause: unknown, fallback: string) { return cause instanceof Error ? cause.message : fallback; }
export function MultiviewGenerationPanel(props: MultiviewGenerationPanelProps) {
  const { user, hasLoadedUser, sessionChanged, userLoadError, refreshUser, refreshCredits } = useAppSession();
  const owner = user?.id || '';
  const authorityKey = JSON.stringify([owner, user?.role, user?.account_type, user?.feature_profile_id,
    user?.feishu?.user_id, user?.feishu?.open_id, user?.feishu?.union_id]);
  const sessionReady = Boolean(owner && hasLoadedUser && !sessionChanged && !userLoadError && !isClientSessionBlocked() && uploadSession().ownerId === owner);
  const allowed = Boolean(sessionReady && user && !isExternalUser(user));
  const [loadedOwner, setLoadedOwner] = useState('');
  const [loadedAuthority, setLoadedAuthority] = useState('');
  const [sessionTab, setSessionTab] = useState('');
  const [draft, setDraft] = useState<MultiviewGenerationDraft | null>(null);
  const [receipt, setReceipt] = useState<RequestReceipt | null>(null);
  const [association, setAssociation] = useState<Association | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [cards, setCards] = useState<VideoCard[]>([]);
  const [projectLoading, setProjectLoading] = useState(false);
  const [cardLoading, setCardLoading] = useState(false);
  const [imageReady, setImageReady] = useState(false);
  const [working, setWorking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [saved, setSaved] = useState(true);
  const [saveNotice, setSaveNotice] = useState('');
  const [requestStorageFailed, setRequestStorageFailed] = useState(false);
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [progress, setProgress] = useState<UploadProgressSnapshot | null>(null);
  const [projectName, setProjectName] = useState('');
  const [cardTitle, setCardTitle] = useState('');
  const [creating, setCreating] = useState<'project' | 'card' | null>(null);
  const [revision, setRevision] = useState(0);
  const [requestScan, setRequestScan] = useState<RequestScan>({ records: [], incomplete: true, invalid: false, next: null });
  const [historyPage, setHistoryPage] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const epoch = useRef(0);
  const mountedOwner = useRef(owner); mountedOwner.current = owner;
  const liveAuthority = useRef(authorityKey); liveAuthority.current = authorityKey;
  const liveSessionReady = useRef(sessionReady); liveSessionReady.current = sessionReady;
  const draftRef = useRef(draft); draftRef.current = draft;
  const receiptRef = useRef(receipt); receiptRef.current = receipt;
  const tabRef = useRef(sessionTab); tabRef.current = sessionTab;
  const scanRef = useRef(requestScan); scanRef.current = requestScan;
  const propsRef = useRef(props); propsRef.current = props;
  const uploadLock = useRef<object | null>(null);
  const submitLock = useRef<object | null>(null);
  const checkLock = useRef<object | null>(null);
  const checkAbort = useRef<AbortController | null>(null);
  const createLock = useRef<object | null>(null);
  const emittedReady = useRef('');
  const ready = Boolean(sessionReady && loadedAuthority === authorityKey && owner && loadedOwner === owner && draft);
  const active = pendingActive(receipt);
  const currentProject = projects.find(item => item.id === draft?.projectId);
  const currentCard = cards.find(item => item.id === draft?.videoCardId && item.project_id === draft?.projectId);
  const prompt = useMemo(() => composeMultiviewGenerationPrompt(draft?.supplement || '', draft?.presetVersion), [draft?.supplement, draft?.presetVersion]);
  const quoteKey = draft ? JSON.stringify([draft.provider, draft.model, draft.duration, draft.resolution]) : '';
  const currentQuote = quote?.key === quoteKey ? quote : null;
  const accountRequestBlocked = requestScan.invalid || requestScan.incomplete || requestScan.records.some(pendingActive);
  const seedValid = !draft || isMultiviewGenerationSeed(draft.seed);
  const capture = () => ({ owner, authorityKey, epoch: epoch.current, uploadEpoch: uploadSession().epoch });
  const current = (scope: ReturnType<typeof capture>) => scope.owner === mountedOwner.current && scope.epoch === epoch.current
    && scope.authorityKey === liveAuthority.current && liveSessionReady.current && !isClientSessionBlocked()
    && uploadSession().ownerId === scope.owner && uploadSession().epoch === scope.uploadEpoch;
  const invalidateMedia = () => { setImageReady(false); setPickerOpen(false); };
  function change(patch: Partial<MultiviewGenerationDraft>) {
    if (!ready || !current(capture()) || submitLock.current) return;
    setDraft(value => value ? { ...value, ...patch } : value); setError(''); setSaved(false);
  }
  function saveReceipt(value: RequestReceipt, beforeSubmission = false) {
    const store = () => {
      const existing = parseReceipt(localStorage.getItem(receiptKey(value.ownerId, value.key)), value.ownerId);
      if (existing && (existing.fingerprint !== value.fingerprint || existing.taskId && value.taskId && existing.taskId !== value.taskId)) throw new Error('原请求记录发生冲突，未切换编号。');
      persist(receiptKey(value.ownerId, value.key), value);
      if (!identifier(tabRef.current)) throw new Error('本标签的原请求现场无法保存，未提交。');
      persistPointer(tabKey(value.ownerId, tabRef.current, 'request-key'), value.key);
      try { persistPointer(keyFor(value.ownerId, 'last-request-key'), value.key); } catch { /* The independently stored receipt remains discoverable. */ }
    };
    if (beforeSubmission) {
      const previous = receiptRef.current;
      if (previous && ['ready', 'failed', 'rejected'].includes(previous.phase)) persist(receiptKey(previous.ownerId, previous.key), previous);
      store(); setRequestStorageFailed(false);
    }
    else { try { store(); setRequestStorageFailed(false); } catch { setRequestStorageFailed(true); } }
    receiptRef.current = value; setReceipt(value);
    refreshRequests();
  }
  function refreshRequests(offset = 0) {
    const scanned = scanRequests(owner, offset);
    const merged = new Map((offset ? scanRef.current.records : []).map(value => [value.key, value]));
    for (const record of scanned.records) merged.set(record.key, record);
    let invalid = scanned.invalid || (offset > 0 && scanRef.current.invalid);
    // An external removal is not proof that a previously observed unknown request disappeared.
    if (!offset) for (const record of scanRef.current.records) if (record.ownerId === owner && pendingActive(record) && !merged.has(record.key)) { merged.set(record.key, record); invalid = true; }
    const next = { ...scanned, invalid, records: Array.from(merged.values()) };
    scanRef.current = next; setRequestScan(next); if (!offset) setHistoryPage(0);
    return next;
  }

  useEffect(() => { if (!hasLoadedUser) void refreshUser(); }, [hasLoadedUser, refreshUser]);
  useEffect(() => {
    checkAbort.current?.abort(); checkAbort.current = null;
    epoch.current++; uploadLock.current = null; submitLock.current = null; checkLock.current = null; createLock.current = null; emittedReady.current = '';
    setLoadedOwner(''); setDraft(null); setReceipt(null); setAssociation(null); setProjects([]); setCards([]);
    setSessionTab(''); setHistoryPage(0); scanRef.current = { records: [], incomplete: true, invalid: false, next: null }; setRequestScan(scanRef.current);
    setImageReady(false); setPickerOpen(false); setWorking(false); setSubmitting(false); setChecking(false); setProgress(null);
    setProjectLoading(false); setCardLoading(false); setProjectName(''); setCardTitle(''); setCreating(null);
    setQuote(null); setQuoteError(''); setError(''); setStatus(''); setSaved(true); setSaveNotice(''); setRequestStorageFailed(false); setRecoveryBlocked(false);
    if (!owner || !hasLoadedUser) return;
    let tab = '';
    try { tab = readTabId(); setSessionTab(tab); }
    catch (cause) { setRecoveryBlocked(true); setError(message(cause, '本标签记录无法读取，未提交。')); }
    let restored: MultiviewGenerationDraft | null = null;
    try { restored = parseMultiviewGenerationDraft((tab ? localStorage.getItem(tabKey(owner, tab, 'draft')) : null) ?? localStorage.getItem(keyFor(owner, 'draft'))); }
    catch { setSaved(false); }
    const next = restored || defaultMultiviewGenerationDraft(`multiview-${crypto.randomUUID()}`);
    if (propsRef.current.initialProjectId && identifier(propsRef.current.initialProjectId)) next.projectId = propsRef.current.initialProjectId;
    if (propsRef.current.initialVideoCardId && identifier(propsRef.current.initialVideoCardId)) next.videoCardId = propsRef.current.initialVideoCardId;
    setDraft(next);
    try {
      const restoredReceipt = readCurrentReceipt(owner, tab);
      setReceipt(restoredReceipt?.phase === 'ready' ? { ...restoredReceipt, phase: 'accepted' } : restoredReceipt);
    }
    catch (cause) { setRecoveryBlocked(true); setError(message(cause, '原请求记录无法读取，不能重新生成。')); }
    try { setAssociation(readAssociation(owner, tab)); }
    catch (cause) { setRecoveryBlocked(true); setError(message(cause, '原素材加入记录无法读取。')); }
    setLoadedOwner(owner);
    const scanned = scanRequests(owner); scanRef.current = scanned; setRequestScan(scanned);
    return () => { epoch.current++; checkAbort.current?.abort(); };
  }, [owner, hasLoadedUser]);
  useEffect(() => {
    // Session exit retains the old user object for draft safety. That object is not current authority.
    epoch.current++; checkAbort.current?.abort(); checkAbort.current = null;
    uploadLock.current = null; submitLock.current = null; checkLock.current = null; createLock.current = null;
    setImageReady(false); setPickerOpen(false); setProgress(null); setQuote(null); setProjects([]); setCards([]);
    setWorking(false); setSubmitting(false); setChecking(false); setCreating(null); setProjectLoading(false); setCardLoading(false);
    setLoadedAuthority(sessionReady ? authorityKey : '');
    // Draft and original request/association receipts deliberately remain untouched.
  }, [authorityKey, sessionReady]);
  useEffect(() => {
    if (!ready || !draft || !liveSessionReady.current || isClientSessionBlocked()) return;
    if (!parseMultiviewGenerationDraft(draft)) {
      setSaved(false); setSaveNotice('本次内容过长或设置无效，未能保存到本机；原已保存草稿未被覆盖。'); return;
    }
    try { persistDraft(owner, sessionTab, draft); setSaved(true); setSaveNotice(''); }
    catch { setSaved(false); setSaveNotice('本次修改无法保存在此设备，刷新可能丢失输入。'); }
  }, [ready, draft, owner, sessionTab]);
  useEffect(() => {
    if (!owner || loadedOwner !== owner) return;
    const changed = (event: StorageEvent) => {
      if (event.key === null || event.key === keyFor(owner, 'request') || event.key.startsWith(`${keyFor(owner, 'receipt')}:`)) refreshRequests();
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
    // Only the request list/lock follows other tabs; never their draft, selection or current receipt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, loadedOwner]);

  useEffect(() => {
    if (!ready || !allowed) return;
    const scope = capture(); const controller = new AbortController();
    setProjectLoading(true);
    void (async () => {
      try {
        const response = await fetch('/api/projects?lite=true', { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
        const payload = await readJsonResponse<ApiError & { projects?: Project[] }>(response);
        if (!current(scope) || controller.signal.aborted) return;
        if (!response.ok) { if ([401, 403].includes(response.status)) invalidateMedia(); throw new Error(payload.message || payload.error || '项目读取失败，请重试。'); }
        setProjects((payload.projects || []).filter(item => item.can_generate !== false && (!item.status || item.status === 'active')));
      } catch (cause) { if (current(scope) && !controller.signal.aborted) setError(cause instanceof DOMException && cause.name === 'TimeoutError' ? '项目读取超时，请刷新列表重试；尚未生成。' : message(cause, '项目读取失败，请刷新列表重试。')); }
      finally { if (current(scope) && !controller.signal.aborted) setProjectLoading(false); }
    })();
    return () => controller.abort();
    // Account-scoped data reloads only after an explicit retry/create.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, allowed, owner, revision]);
  useEffect(() => {
    setCards([]); setCardLoading(false);
    if (!ready || !allowed || !draft?.projectId) return;
    const projectId = draft.projectId; const scope = capture(); const controller = new AbortController();
    setCardLoading(true);
    void (async () => {
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/video-cards`, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
        const payload = await readJsonResponse<ApiError & { video_cards?: VideoCard[] }>(response);
        if (!current(scope) || controller.signal.aborted || draftRef.current?.projectId !== projectId) return;
        if (!response.ok) { if ([401, 403, 404].includes(response.status)) invalidateMedia(); throw new Error(payload.message || payload.error || '视频卡读取失败，请重试。'); }
        setCards(payload.video_cards || []);
      } catch (cause) { if (current(scope) && !controller.signal.aborted) setError(cause instanceof DOMException && cause.name === 'TimeoutError' ? '视频卡读取超时，请刷新列表重试；尚未生成。' : message(cause, '视频卡读取失败，请刷新列表重试。')); }
      finally { if (current(scope) && !controller.signal.aborted && draftRef.current?.projectId === projectId) setCardLoading(false); }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, allowed, owner, draft?.projectId, revision]);
  useEffect(() => {
    setImageReady(false);
    if (!ready || !allowed || !draft?.mainImage || !isMultiviewWorkspaceTabId(draft.workspaceTabId)) return;
    const scope = capture(); const image = draft.mainImage; const tab = draft.workspaceTabId; const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/workspace', { headers: { 'x-tab-id': tab }, cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
        const payload = await readJsonResponse<ApiError & { workspace?: { assets: WorkspaceAssetItem[] } }>(response);
        if (!current(scope) || controller.signal.aborted || draftRef.current?.mainImage?.referenceImageId !== image.referenceImageId) return;
        if (!response.ok || payload.workspace?.assets.length !== 1 || !payload.workspace.assets.some(item => item.assetId === image.assetId && item.referenceImageId === image.referenceImageId && item.type === 'image')) throw new Error(payload.message || payload.error || '原主图需要重新选择，参数与补充要求已保留。');
        setImageReady(true);
      } catch (cause) { if (current(scope) && !controller.signal.aborted) setError(cause instanceof DOMException && cause.name === 'TimeoutError' ? '主图核对超时，请点“刷新列表”重新核对；原图与参数未改变。' : message(cause, '主图暂不可用，请重新选择。')); }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, allowed, owner, draft?.mainImage?.referenceImageId, draft?.workspaceTabId, revision]);
  useEffect(() => {
    setQuote(null); setQuoteError('');
    if (!ready || !allowed || !draft) return;
    const scope = capture(); const controller = new AbortController();
    const params = new URLSearchParams({ provider: draft.provider, model: draft.model, resolution: draft.resolution, duration: String(draft.duration) });
    const timer = window.setTimeout(() => { void (async () => {
      try {
        const response = await fetch(`/api/tasks/estimate?${params}`, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
        const payload = await readJsonResponse<ApiError & { estimatedCost?: number }>(response);
        if (!current(scope) || controller.signal.aborted) return;
        if (!response.ok || typeof payload.estimatedCost !== 'number' || !Number.isSafeInteger(payload.estimatedCost) || payload.estimatedCost < 0) throw new Error(payload.message || payload.error || '报价暂不可用，尚未生成。');
        setQuote({ key: quoteKey, points: payload.estimatedCost });
      } catch (cause) { if (current(scope) && !controller.signal.aborted) setQuoteError(cause instanceof DOMException && cause.name === 'TimeoutError' ? '报价读取超时，请重新报价；尚未生成。' : message(cause, '报价暂不可用，请重新报价。')); }
    })(); }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, allowed, owner, quoteKey, revision]);

  async function attach(record: Association) {
    const scope = capture();
    if (!current(scope) || !draftRef.current || !identifier(tabRef.current) || record.ownerId !== scope.owner || !isMultiviewWorkspaceTabId(record.workspaceTabId)) throw new Error('账号或主图现场已变化，未套用原素材。');
    persist(tabKey(owner, tabRef.current, 'association'), record); setAssociation(record);
    try { persistPointer(keyFor(owner, 'last-association-tab'), tabRef.current); } catch { /* This tab keeps the original association. */ }
    const response = await fetch('/api/workspace/assets', { method: 'POST', headers: { 'Content-Type': 'application/json',
      'x-tab-id': record.workspaceTabId, 'x-upload-owner-id': owner }, body: JSON.stringify({ ownerId: owner, requestId: record.requestId,
      role: 'reference_image', selection: [record.referenceImageId ? { referenceImageId: record.referenceImageId } : { assetId: record.assetId }] }), signal: AbortSignal.timeout(30000) });
    const payload = await readJsonResponse<ApiError & { association?: { requestId?: string; associated?: boolean } }>(response);
    if (!current(scope)) throw new Error('账号已变化，原素材未套用到新账号。');
    if (!response.ok || payload.association?.requestId !== record.requestId || payload.association.associated !== true) {
      if ([401, 403, 404].includes(response.status)) invalidateMedia();
      throw new Error(payload.message || payload.error || '素材加入结果未确认，请重试原加入，不用重新上传。');
    }
    const check = await fetch('/api/workspace', { headers: { 'x-tab-id': record.workspaceTabId }, cache: 'no-store', signal: AbortSignal.timeout(30000) });
    const workspace = await readJsonResponse<ApiError & { workspace?: { assets: WorkspaceAssetItem[] } }>(check);
    if (!current(scope)) throw new Error('账号已变化，原素材未套用。');
    const image = workspace.workspace?.assets.find(item => item.assetId === record.assetId && (!record.referenceImageId || item.referenceImageId === record.referenceImageId) && item.type === 'image');
    if (!check.ok || workspace.workspace?.assets.length !== 1 || !image?.referenceImageId) throw new Error('素材已保留，但唯一主图编号尚未确认。请重试原加入。');
    const nextDraft = { ...draftRef.current!, workspaceTabId: record.workspaceTabId, mainImage: { assetId: image.assetId, referenceImageId: image.referenceImageId } };
    setDraft(nextDraft);
    setImageReady(true); setSaved(false); setAssociation(null); setError('');
    try { persistDraft(owner, tabRef.current, nextDraft); persist(tabKey(owner, tabRef.current, 'association'), null); }
    catch { /* Retain the original association so a later explicit check can recover this known asset. */ }
  }
  async function selectFile(file: File, onProgress?: (value: UploadProgressSnapshot) => void) {
    if (!ready || !allowed || uploadLock.current || submitLock.current) return;
    if (association) { setError('上一张素材的加入结果待确认，请先重试原加入。'); return; }
    if (!file.type.startsWith('image/') || !file.size || file.size > 30 * 1024 * 1024) { setError('请选择30MB以内的图片，原主图和输入未改变。'); return; }
    const scope = capture(); if (!current(scope)) return;
    const token = {}; uploadLock.current = token; setWorking(true); setError(''); setProgress(null);
    try {
      const asset = await uploadFileToHistory(file, { ownerId: owner, onProgress: value => { if (current(scope)) { setProgress(value); onProgress?.(value); } } });
      if (!current(scope)) return;
      if (!asset.id) throw new Error('上传已完成，但素材编号未确认。请先核对我的素材。');
      await attach({ schema: 1, ownerId: owner, workspaceTabId: `multiview-${crypto.randomUUID()}`, requestId: crypto.randomUUID(), assetId: asset.id });
    } catch (cause) { if (current(scope)) setError(message(cause, '图片未准备好，请重试原操作。')); }
    finally { if (uploadLock.current === token) { uploadLock.current = null; setWorking(false); setProgress(null); } }
  }
  async function selectItem(items: PickerItem[]) {
    if (items.length !== 1 || items[0].type !== 'image' || !items[0].assetId) return { success: false, message: '请选择一张可用于生成的完整图片。' };
    if (!ready || !allowed || !draft || !current(capture()) || uploadLock.current || association || submitLock.current) return { success: false, message: '请先确认当前账号并完成图片准备。' };
    const token = {}; uploadLock.current = token; const scope = capture(); setWorking(true);
    try {
      await attach({ schema: 1, ownerId: owner, requestId: crypto.randomUUID(), workspaceTabId: `multiview-${crypto.randomUUID()}`,
        assetId: items[0].assetId, ...(items[0].referenceImageId ? { referenceImageId: items[0].referenceImageId } : {}) });
      if (current(scope)) setPickerOpen(false);
      return { success: current(scope) };
    } catch (cause) { return { success: false, message: message(cause, '主图加入失败。') }; }
    finally { if (uploadLock.current === token) { uploadLock.current = null; setWorking(false); } }
  }

  const checkRequest = useCallback(async () => {
    const previous = receiptRef.current;
    if (!previous || !owner || loadedOwner !== owner || !liveSessionReady.current || isClientSessionBlocked() || checkLock.current || submitting) return;
    const token = {}; checkLock.current = token; const scope = capture(); const controller = new AbortController(); checkAbort.current = controller; setChecking(true);
    const requestCurrent = () => current(scope) && receiptRef.current?.key === previous.key;
    try {
      let next = previous;
      if (!next.taskId) {
        const response = await fetch(`/api/tasks/request-status?idempotency_key=${encodeURIComponent(next.key)}`, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
        const payload = await readJsonResponse<ApiError & { task?: { id: string } | null; lookup?: string; safeToResubmit?: boolean }>(response);
        if (!requestCurrent()) return;
        if (!response.ok) { if ([401, 403].includes(response.status)) invalidateMedia(); throw new Error(payload.message || payload.error || '原提交暂未确认，请稍后重新查询。'); }
        if (!payload.task?.id) { setStatus('提交结果待确认，暂未查到原任务。请求编号已保留，不会再次提交。'); return; }
        if (!identifier(payload.task.id)) throw new Error('原任务编号无法确认。');
        next = { ...next, taskId: payload.task.id, phase: 'accepted' }; saveReceipt(next);
      }
      const response = await fetch(`/api/video/status/${encodeURIComponent(next.taskId!)}`, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
      const task = await readJsonResponse<TaskStatus>(response);
      if (!requestCurrent()) return;
      if (!response.ok || task.id !== next.taskId || task.idempotency_key !== next.key) { if ([401, 403, 404].includes(response.status)) invalidateMedia(); throw new Error(task.message || task.error || '原任务状态或请求编号暂不可确认，已保留原记录。'); }
      if (['failed', 'cancelled'].includes(task.local_status)) { saveReceipt({ ...next, phase: 'failed' }); setStatus(task.message || '原视频任务未完成，输入已保留。不会自动重新生成。'); void refreshCredits(); return; }
      if (task.local_status !== 'succeeded' || task.submission_unconfirmed) { setStatus(task.submission_unconfirmed ? '原任务受理结果待确认，请勿重复生成。' : task.local_status === 'running' ? '视频正在生成，可继续编辑下一次的设置。' : '原视频任务已受理，正在等待处理。'); return; }
      const media = await fetch(`/api/video/multiview/${encodeURIComponent(next.taskId!)}`, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]) });
      const result = await readJsonResponse<ApiError & { info?: { taskId: string; sourceVersion: string } }>(media);
      if (!requestCurrent()) return;
      if (!media.ok || result.info?.taskId !== next.taskId || !/^[a-f0-9]{64}$/.test(result.info.sourceVersion)) {
        if ([401, 403, 404].includes(media.status)) invalidateMedia();
        setStatus(result.error || '视频已生成，原片或视图还在准备，将继续查询同一任务。'); return;
      }
      next = { ...next, phase: 'ready' }; saveReceipt(next); setStatus('视频已可读取，可打开八视图。'); void refreshCredits();
      if (emittedReady.current !== next.key) {
        emittedReady.current = next.key;
        propsRef.current.onReady({ taskId: next.taskId!, requestKey: next.key, ownerId: owner, startedFromSourceKey: next.startedFromSourceKey, explicitOpen: false });
      }
    } catch (cause) { if (requestCurrent()) setStatus(message(cause, '原请求暂未确认，请重新查询。')); }
    finally { if (checkLock.current === token) { checkLock.current = null; setChecking(false); } if (checkAbort.current === controller) checkAbort.current = null; }
    // The ref contains the immutable original receipt; draft edits must not restart polling or change its request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, loadedOwner, submitting, refreshCredits]);
  useEffect(() => {
    if (!ready || !allowed || !receipt || !['unknown', 'accepted', 'ready'].includes(receipt.phase)) return;
    let cancelled = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => { await checkRequest(); if (!cancelled && pendingActive(receiptRef.current)) timer = setTimeout(() => void poll(), 5000); };
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [ready, allowed, owner, receipt?.key, receipt?.phase, checkRequest]);
  const phase: MultiviewGenerationPhase = submitting ? 'submitting' : receipt?.phase === 'unknown' ? 'unknown'
    : receipt?.phase === 'accepted' ? 'submitted' : receipt?.phase === 'ready' ? 'video_ready'
      : receipt?.phase === 'failed' || receipt?.phase === 'rejected' ? 'failed' : imageReady ? 'ready' : 'empty';
  useEffect(() => { propsRef.current.onStateChange?.(ready ? { phase, busy: working || submitting || active, ...(receipt?.taskId ? { taskId: receipt.taskId } : {}) } : { phase: 'empty', busy: false }); }, [ready, phase, working, submitting, active, receipt?.taskId]);

  async function generate() {
    if (!draft || !ready || !allowed || !imageReady || !currentProject || !currentCard || !currentQuote || !prompt.valid
      || !seedValid || !current(capture()) || working || uploadLock.current || createLock.current || association || submitLock.current || pendingActive(receiptRef.current) || recoveryBlocked) return;
    const scanned = refreshRequests();
    if (scanned.invalid || scanned.incomplete || scanned.records.some(pendingActive)) { setStatus('本账号仍有未确认的原请求，或本机记录尚未查全。请先查询下面的原请求，不会新建编号。'); return; }
    const scope = capture(); const token = {}; submitLock.current = token; setSubmitting(true); setError(''); setStatus('');
    const frozen = JSON.parse(JSON.stringify(draft)) as MultiviewGenerationDraft;
    const startedFromSourceKey = props.currentSourceKey;
    let pending: RequestReceipt | null = null;
    let storedBeforeSubmission = false;
    try {
      const key = crypto.randomUUID();
      const body = buildMultiviewGenerationRequest(frozen, { idempotencyKey: key, maxEstimatedCost: currentQuote.points });
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body)));
      if (!current(scope)) return;
      const latest = refreshRequests();
      if (latest.invalid || latest.incomplete || latest.records.some(pendingActive)) { setStatus('本账号有原请求尚未确认，请先查询原记录；当前内容未提交。'); return; }
      pending = { schema: 1, ownerId: owner, key, fingerprint: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''),
        taskId: null, phase: 'unknown', startedFromSourceKey };
      saveReceipt(pending, true);
      storedBeforeSubmission = true;
      const response = await fetch('/api/tasks/create', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-tab-id': frozen.workspaceTabId }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
      const result = await readJsonResponse<ApiError & { id?: string; submission_unconfirmed?: boolean }>(response);
      if (!current(scope)) return;
      if (!response.ok) {
        if ([401, 403].includes(response.status)) invalidateMedia();
        if (identifier(result.task_id)) {
          saveReceipt({ ...pending, taskId: result.task_id, phase: 'accepted' });
          setStatus(result.message || result.error || '原任务已记录，正在查询原任务结果；不会重新提交。'); return;
        }
        // A 4xx alone cannot prove this key was never accepted by a concurrent original request.
        setStatus(result.message || result.error || '提交结果待确认，已保留原请求编号，请查询原任务。'); return;
      }
      if (!identifier(result.id)) throw new Error('提交结果待确认，原请求编号已保留。');
      saveReceipt({ ...pending, taskId: result.id, phase: 'accepted' }); setStatus('原视频任务已受理，正在查询成品。'); void refreshCredits();
    } catch (cause) {
      if (current(scope)) {
        if (storedBeforeSubmission && receiptRef.current?.phase !== 'rejected') setStatus('提交结果待确认，原请求编号已保留。请查询原任务，不会自动再次提交。');
        else setError(message(cause, '尚未提交，请检查输入。'));
      }
    } finally { if (submitLock.current === token) { submitLock.current = null; setSubmitting(false); } }
  }
  function chooseOriginalRequest(record: RequestReceipt) {
    if (!ready || !current(capture()) || submitting || working || creating || record.ownerId !== owner) return;
    try {
      const stored = parseReceipt(localStorage.getItem(receiptKey(owner, record.key)), owner)
        || parseReceipt(localStorage.getItem(keyFor(owner, 'request')), owner);
      if (!stored || stored.key !== record.key || stored.fingerprint !== record.fingerprint) throw new Error('该原请求记录暂无法确认，未换编号。');
      persist(receiptKey(owner, stored.key), stored);
      persistPointer(tabKey(owner, tabRef.current, 'request-key'), stored.key);
      checkAbort.current?.abort(); checkAbort.current = null; checkLock.current = null; setChecking(false); emittedReady.current = '';
      const next: RequestReceipt = stored.phase === 'ready' ? { ...stored, phase: 'accepted' } : stored;
      receiptRef.current = next; setReceipt(next); setStatus('已选回原请求，只查询该编号，不会再次提交。');
    } catch (cause) { setError(message(cause, '原请求记录读取失败。')); }
  }
  async function createDestination(kind: 'project' | 'card') {
    if (!draft || !ready || working || createLock.current || submitLock.current || !allowed) return;
    const name = (kind === 'project' ? projectName : cardTitle).trim();
    if (!name || kind === 'card' && !currentProject) return;
    const scope = capture(); if (!current(scope)) return;
    const token = {}; createLock.current = token; const projectId = draft.projectId; setCreating(kind); setError('');
    try {
      const response = await fetch(kind === 'project' ? '/api/projects' : `/api/projects/${encodeURIComponent(projectId)}/video-cards`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(kind === 'project' ? { name, type: 'team' } : { title: name, objective: null }), signal: AbortSignal.timeout(30000) });
      const payload = await readJsonResponse<ApiError & { project?: Project; video_card?: VideoCard }>(response);
      if (!current(scope)) return;
      if (!response.ok) throw new Error(payload.message || payload.error || '保存位置创建未确认，请先刷新列表核对，不要重复创建。');
      if (kind === 'project' && payload.project) { setProjects(value => [payload.project!, ...value.filter(item => item.id !== payload.project!.id)]); change({ projectId: payload.project.id, videoCardId: '' }); setProjectName(''); }
      else if (kind === 'card' && payload.video_card && draftRef.current?.projectId === projectId) { setCards(value => [payload.video_card!, ...value]); change({ videoCardId: payload.video_card.id }); setCardTitle(''); }
      else throw new Error('创建结果尚未确认，请刷新列表核对。');
    } catch (cause) { if (current(scope)) setError(message(cause, '创建结果待确认，请先刷新列表。')); }
    finally { if (createLock.current === token) { createLock.current = null; setCreating(null); } }
  }

  if (!hasLoadedUser) return <section className={styles.panel} role="status">正在读取生成设置…</section>;
  if (!user) return <section className={styles.panel}><p>登录后可选择图片并生成视频。</p><button type="button" onClick={props.onUseExisting}>使用已有视频</button></section>;
  if (!sessionReady) return <section className={styles.panel} role="status">当前登录或权限状态尚未确认，生成已暂停。输入和原请求记录仍保留。</section>;
  if (!allowed) return <section className={styles.panel}><p>当前账号不能使用普通视频生成。已有视频仍按原权限查看。</p><button type="button" onClick={props.onUseExisting}>使用已有视频</button></section>;
  if (!ready || !draft) return <section className={styles.panel} role="status">正在恢复本账号的设置…</section>;
  const needsApproval = currentProject && currentProject.type !== 'personal' && draft.resolution === '1080p';
  const selectedModel = SEEDANCE_VIDEO_MODEL_OPTIONS.find(item => item.id === draft.model);
  const durationOptions = seedanceVideoDurationOptions(draft.model);
  const formDisabled = submitting || working || Boolean(creating);
  const blocked = formDisabled || active || accountRequestBlocked || recoveryBlocked || Boolean(association) || !imageReady || !currentProject || !currentCard
    || ['sealed', 'archived'].includes(currentCard.status) || !currentQuote || !prompt.valid || !seedValid || needsApproval && !draft.resolutionApprovalConfirmed;
  return <section className={styles.panel} aria-label="原图与生成设置" onPaste={event => {
    const images = Array.from(event.clipboardData.files).filter(item => item.type.startsWith('image/'));
    if (!images.length || formDisabled) return;
    event.preventDefault();
    if (images.length !== 1) { setError('一次放入一张主图，原主图未改变。'); return; }
    void selectFile(images[0]);
  }}>
    <header className={styles.summary}>
      {imageReady && draft.mainImage && <img src={`/api/reference-images/${encodeURIComponent(draft.mainImage.referenceImageId)}/content?variant=thumbnail`} alt="当前生成主图" onError={() => setImageReady(false)} />}
      <div><h2>原图与生成设置</h2><p>360°旋转模板 · {selectedModel?.label || draft.model} · {draft.duration}秒 · {draft.resolution}</p>{!props.expanded && working && <small role="status">主图正在准备，尚未生成视频…</small>}</div>
      <div className={styles.summaryActions}><button type="button" disabled={formDisabled} onClick={() => fileInput.current?.click()}><ImagePlus size={16} />更换图片</button>
        <button type="button" onClick={props.onUseExisting}><FolderOpen size={16} />使用已有视频</button>
        <button type="button" aria-expanded={props.expanded} onClick={() => props.onExpandedChange(!props.expanded)}>{props.expanded ? '收起设置' : '展开设置'}<ChevronDown size={16} /></button></div>
    </header>
    <input ref={fileInput} className={styles.fileInput} type="file" accept="image/*" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void selectFile(file); }} />
    {props.expanded && <div className={styles.body}>
      <div className={styles.imageArea} onDragOver={event => { event.preventDefault(); }} onDrop={event => {
        event.preventDefault();
        if (formDisabled || !event.dataTransfer.files.length) return;
        if (event.dataTransfer.files.length !== 1) { setError('一次放入一张主图，原主图未改变。'); return; }
        void selectFile(event.dataTransfer.files[0]);
      }}>
        <button type="button" className={styles.imageButton} disabled={formDisabled} onClick={() => fileInput.current?.click()}>
          {imageReady && draft.mainImage ? <img src={`/api/reference-images/${encodeURIComponent(draft.mainImage.referenceImageId)}/content?variant=preview`} alt="本次视频的直接输入主图" onError={() => { setImageReady(false); setError('主图暂不可读取，请重新选择，参数已保留。'); }} />
            : <span><Upload size={28} /><strong>放入一张图片</strong><small>点击选择，也可拖入或粘贴图片</small></span>}
        </button>
        <button type="button" disabled={formDisabled || Boolean(association)} onClick={() => setPickerOpen(true)}>从我的素材选择</button>
        {progress && <UploadProgressIndicator label={progress.label} percent={progress.percent} variant="light" />}
        {working && <p role="status">正在准备主图，尚未生成视频…</p>}
        {association && <div className={styles.feedback}><p>原素材已保留，加入结果待确认，无需重新上传。</p><button type="button" disabled={working} onClick={() => {
          if (uploadLock.current) return; const token = {}; uploadLock.current = token; const scope = capture(); setWorking(true);
          void attach(association).catch(cause => { if (current(scope)) setError(message(cause, '原加入尚未确认。')); }).finally(() => { if (uploadLock.current === token) { uploadLock.current = null; setWorking(false); } });
        }}>重试原加入</button></div>}
      </div>
      <div className={styles.settings}>
        <div className={styles.preset}><strong>360°旋转模板</strong><details><summary>查看固定文案</summary><p>{MULTIVIEW_ROTATION_PRESET.prompt}</p></details></div>
        <div className={styles.parameters}>
          <label>模型<select value={draft.model} disabled={formDisabled} onChange={event => change({ model: event.target.value })}>{!selectedModel && <option value={draft.model}>{draft.model || '未选择'}</option>}{SEEDANCE_VIDEO_MODEL_OPTIONS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <label>时长<select value={draft.duration} disabled={formDisabled} onChange={event => change({ duration: Number(event.target.value) })}>{!durationOptions.some(value => value === draft.duration) && <option value={draft.duration}>{draft.duration}秒（需确认）</option>}{durationOptions.map(value => <option key={value} value={value}>{value}秒</option>)}</select></label>
          <label>清晰度<select value={draft.resolution} disabled={formDisabled} onChange={event => change({ resolution: event.target.value, resolutionApprovalConfirmed: false, resolutionApprovalId: '' })}>{!RESOLUTION_OPTIONS.some(value => value === draft.resolution) && <option value={draft.resolution}>{draft.resolution || '未选择'}</option>}{RESOLUTION_OPTIONS.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        </div>
        <label className={styles.supplement}>补充要求（可选）<textarea rows={3} value={draft.supplement} disabled={submitting} placeholder="如：保持帽子和背包完整，背景使用浅灰色" onChange={event => change({ supplement: event.target.value })} /><small>会加入本次视频文案，不修改固定模板</small></label>
        {!prompt.valid && <p className={styles.feedback} role="status">{prompt.error} 当前完整文案 {prompt.characters} 字，内容未截断。</p>}
        {!seedValid && <p className={styles.feedback} role="status">随机种子须为 -1 或0至2147483647的整数，原值已保留，请在高级设置中调整。</p>}
        <details className={styles.advanced}><summary>高级设置与完整文案</summary>
          <div className={styles.parameters}><label>画面比例<select value={draft.ratio} disabled={formDisabled} onChange={event => change({ ratio: event.target.value })}>{!RATIO_OPTIONS.some(value => value === draft.ratio) && <option value={draft.ratio}>{draft.ratio}</option>}{RATIO_OPTIONS.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
            <label>随机种子<input type="number" value={draft.seed} disabled={formDisabled} onChange={event => change({ seed: Number(event.target.value) })} /></label></div>
          <div className={styles.checks}>{(['generateAudio', 'returnLastFrame', 'watermark'] as const).map((key, index) => <label key={key}><input type="checkbox" checked={draft[key]} disabled={formDisabled} onChange={event => change({ [key]: event.target.checked })} />{['生成声音', '返回末帧', '水印'][index]}</label>)}</div>
          <p className={styles.fullPrompt}>{prompt.prompt}</p><small>完整文案 {prompt.characters} 字，可再补充 {Math.max(0, prompt.remainingCharacters)} 字。</small>
          <button type="button" disabled={formDisabled} onClick={() => { const defaults = defaultMultiviewGenerationDraft(draft.workspaceTabId); change({ ...defaults, mainImage: draft.mainImage, projectId: draft.projectId, videoCardId: draft.videoCardId, supplement: draft.supplement }); }}>恢复模板参数</button>
        </details>
        <div className={styles.destination}><span>保存到：{currentProject?.name || '未选择项目'} / {currentCard?.title || '未选择视频卡'}</span><details open={!draft.projectId || !draft.videoCardId}>
          <summary>选择或新建保存位置</summary><div className={styles.parameters}>
            <label>项目<select value={draft.projectId} disabled={formDisabled || projectLoading} onChange={event => change({ projectId: event.target.value, videoCardId: '', resolutionApprovalConfirmed: false, resolutionApprovalId: '' })}><option value="">{projectLoading ? '正在读取项目…' : '选择项目'}</option>{draft.projectId && !currentProject && <option value={draft.projectId}>原项目暂不可用，请重新选择</option>}{projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label>视频卡<select value={draft.videoCardId} disabled={formDisabled || cardLoading || !currentProject} onChange={event => change({ videoCardId: event.target.value, resolutionApprovalConfirmed: false, resolutionApprovalId: '' })}><option value="">{cardLoading ? '正在读取视频卡…' : '选择视频卡'}</option>{draft.videoCardId && !currentCard && <option value={draft.videoCardId}>原视频卡暂不可用，请重新选择</option>}{cards.map(item => <option key={item.id} value={item.id} disabled={['sealed', 'archived'].includes(item.status)}>{item.title}{['sealed', 'archived'].includes(item.status) ? '（不可生成）' : ''}</option>)}</select></label></div>
          <button type="button" className={styles.quiet} disabled={formDisabled} onClick={() => setRevision(value => value + 1)}><RefreshCw size={13} />刷新列表</button>
          <details><summary>新建项目或视频卡</summary><div className={styles.createRow}><input aria-label="新项目名称" value={projectName} maxLength={80} placeholder="新项目名称" disabled={formDisabled} onChange={event => setProjectName(event.target.value)} /><button type="button" disabled={formDisabled || !projectName.trim()} onClick={() => void createDestination('project')}>新建项目</button></div>
            <div className={styles.createRow}><input aria-label="新视频卡标题" value={cardTitle} maxLength={100} placeholder="新视频卡标题" disabled={formDisabled} onChange={event => setCardTitle(event.target.value)} /><button type="button" disabled={formDisabled || !currentProject || !cardTitle.trim()} onClick={() => void createDestination('card')}>新建视频卡</button></div></details>
        </details></div>
        {needsApproval && <label className={styles.approval}><input type="checkbox" checked={draft.resolutionApprovalConfirmed} disabled={formDisabled} onChange={event => change({ resolutionApprovalConfirmed: event.target.checked, resolutionApprovalId: '' })} /><span>我已确认审批中心存在当前视频卡的有效1080p审批。<a href="/approvals" target="_blank" rel="noreferrer">查看审批</a></span></label>}
        <div className={styles.generateRow}><button type="button" className={styles.primary} disabled={Boolean(blocked)} onClick={() => void generate()}>{submitting ? '正在提交…' : active ? '原视频处理中' : '生成视频'}</button><span>{currentQuote ? `本次预计 ${currentQuote.points} 点` : '报价待确认'}</span></div>
        {quoteError && <p className={styles.feedback} role="status">{quoteError}<button type="button" className={styles.quiet} onClick={() => setRevision(value => value + 1)}>重新报价</button></p>}
      </div>
    </div>}
    {(error || status || !saved || requestStorageFailed || accountRequestBlocked || requestScan.records.length > 0 || recoveryBlocked || active || receipt?.phase === 'ready') && <footer className={styles.footer}>
      {error && <p role="status">{error}</p>}{status && <p role="status">{status}</p>}
      {!saved && <p role="status">{saveNotice || '本次修改无法保存在此设备，刷新可能丢失输入。'}</p>}
      {requestStorageFailed && <p role="status">原任务已保留在当前页面，但最新查询记录无法保存到此设备。请保留任务编号后再离开。</p>}
      {receipt && <div className={styles.requestActions}><a href={receipt.taskId ? `/tasks/${encodeURIComponent(receipt.taskId)}` : '/tasks'} target="_blank" rel="noreferrer">{receipt.taskId ? '查看原视频任务' : '核对任务列表'}</a>
        {pendingActive(receipt) && <button type="button" disabled={checking || submitting} onClick={() => void checkRequest()}>{checking ? '正在查询…' : '查询原请求'}</button>}
        {receipt.phase === 'ready' && receipt.taskId && <button type="button" onClick={() => { if (current(capture())) props.onReady({ taskId: receipt.taskId!, requestKey: receipt.key, ownerId: owner, startedFromSourceKey: receipt.startedFromSourceKey, explicitOpen: true }); }}>打开新结果</button>}</div>}
      <details className={styles.requestHistory} open={accountRequestBlocked}>
        <summary>本账号原请求{requestScan.records.some(pendingActive) ? '（仍有待确认）' : ''}</summary>
        {(requestScan.invalid || requestScan.incomplete) && <p role="status">本机原请求记录未能完整确认，未列出的记录不代表不存在；新生成暂不放行。</p>}
        {requestScan.records.slice(historyPage * 8, historyPage * 8 + 8).map(record => <div className={styles.historyRow} key={record.key}>
          <span>{record.taskId ? `任务 ${record.taskId}` : `请求 ${record.key}`} · {pendingActive(record) ? '待确认' : record.phase === 'ready' ? '视频可查询' : '原请求已结束'}</span>
          <button type="button" disabled={formDisabled || !pendingActive(record) && record.key === receipt?.key} onClick={() => chooseOriginalRequest(record)}>查询原记录</button>
        </div>)}
        <div className={styles.requestActions}><button type="button" disabled={historyPage === 0} onClick={() => setHistoryPage(value => value - 1)}>上一页</button>
          <span>第 {historyPage + 1} 页 · 已读取 {requestScan.records.length} 条原记录</span>
          <button type="button" disabled={(historyPage + 1) * 8 >= requestScan.records.length} onClick={() => setHistoryPage(value => value + 1)}>下一页</button>
          <button type="button" onClick={() => refreshRequests()}>重新核对记录</button>
          {requestScan.next !== null && <button type="button" onClick={() => refreshRequests(requestScan.next!)}>继续读取未列记录</button>}</div>
      </details>
    </footer>}
    {pickerOpen && <UploadedImagePicker open imageOnly target="workspace" title="选择视频主图" purpose="multiview-main-image" maxSelection={1} currentCount={0} currentAssetIds={[]} currentReferenceImageIds={[]} onClose={() => setPickerOpen(false)}
      onUploadFile={(file, onProgress) => current(capture()) ? uploadFileToHistory(file, { ownerId: owner, onProgress }) : Promise.reject(new Error('当前账号尚未确认，未上传素材。'))} onConfirm={async () => ({ success: false, message: '请选择一张主图。' })} onConfirmSelection={selectItem} />}
  </section>;
}
