'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, FolderOpen, ImagePlus, Plus, RefreshCw, Upload } from 'lucide-react';
import { useCreationContext } from '@/lib/hooks/use-creation-context';
import CreationAvailability from '@/components/creation/CreationAvailability';
import { UploadedImagePicker } from '@/components/UploadedImagePicker';
import { UploadProgressIndicator } from '@/components/UploadProgressIndicator';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { isExternalUser } from '@/lib/access/external-role';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import { uploadFileToHistory, type UploadProgressSnapshot } from '@/lib/http/file-upload';
import { uploadSession } from '@/lib/http/upload-session';
import { readJsonResponse } from '@/lib/http/json-response';
import ProjectCreateOperationNotice from '@/components/ProjectCreateOperationNotice';
import { useProjectCreateOperation, type ProjectCreateResult } from '@/lib/projects/client-operations';
import { validVideoPricingAmount, videoPricingBusinessInput } from '@/lib/pricing-client';
import type { PickerItem } from '@/lib/assets/picker-types';
import { RATIO_OPTIONS, RESOLUTION_OPTIONS, type WorkspaceAssetItem } from '@/types';
import { SEEDANCE_VIDEO_MODEL_OPTIONS, seedanceVideoDurationOptions } from '@/lib/provider/seedance-models';
import {
  defaultMultiviewGenerationDraft, parseMultiviewGenerationDraft,
  buildMultiviewGenerationRequest, isMultiviewWorkspaceTabId, isMultiviewGenerationSeed, isMultiviewPresetVersion,
  type MultiviewGenerationDraft, type MultiviewRotationPresetPublicState,
} from '@/lib/video/multiview-generation-contract';
import { MultiviewGenerationConfirmDialog } from './MultiviewGenerationConfirmDialog';
import { MultiviewPromptDialog } from './MultiviewPromptDialog';
import { MultiviewSettingsPicker, generationSettingsValue, type MultiviewSettingsPickerApplyResult,
  type MultiviewSettingsPickerRecord } from './MultiviewSettingsPicker';
import { parseMultiviewSettingsDto } from '@/lib/video/multiview-settings-contract';
import { applyMultiviewReusePatch, clearMultiviewReuseHandoff, readMultiviewReuseHandoff } from '@/lib/video/multiview-reuse-handoff.client';
import { multiviewGenerationProgress, type MultiviewGenerationProgressState, type MultiviewTaskProgressInput } from './multiview-generation-progress';
import styles from './multiview-generation.module.css';

export type MultiviewGenerationPhase = 'empty' | 'ready' | 'submitting' | 'submitted' | 'unknown' | 'failed' | 'closed' | 'video_ready';
export type MultiviewGenerationPanelState = { phase: MultiviewGenerationPhase; busy: boolean; taskId?: string; unsaved?: boolean; leavingBusy?: boolean; progress?: MultiviewGenerationProgressState | null };
export type MultiviewGenerationReady = { taskId: string; requestKey: string; ownerId: string;
  startedFromSourceKey: string | null; explicitOpen: boolean };
export type MultiviewGenerationPanelProps = {
  currentSourceKey: string | null; hasResult: boolean; expanded: boolean; onExpandedChange: (expanded: boolean) => void;
  onUseExisting: () => void; onReady: (result: MultiviewGenerationReady) => void;
  onActionSettings?: (value: { model: string; duration: number; resolution: string; projectId: string; videoCardId: string | null }) => void;
  onStateChange?: (state: MultiviewGenerationPanelState) => void; initialProjectId?: string; initialVideoCardId?: string;
  currentTaskId?: string;
  /** A saved work output chosen with “用作参考图”; replaces the main image once, never starts a generation. */
  incomingMainAsset?: { assetId: string; token: number } | null;
  onIncomingMainAssetDone?: (result: { success: boolean; message?: string }) => void;
};
type Project = { id: string; name: string; type: string; status?: string; can_generate?: boolean };
type VideoCard = { id: string; project_id: string; title: string; status: string };
// Match the server's VIDEO_CARD_GENERATABLE_STATUSES without importing its Prisma module.
const canGenerateInCard = (card: VideoCard) => ['draft', 'active', 'reviewing'].includes(card.status);
type RejectedRequestReceipt = { version: 1; key: string; state: 'rejected'; accepted: false;
  code: string; message: string; rejectedAt: string };
type ClosedRequestReceipt = { version: 1; key: string; state: 'closed'; accepted: false;
  code: 'MULTIVIEW_REQUEST_CLOSED_BEFORE_ACCEPTANCE'; message: string; closedAt: string };
type RequestObservation = { httpStatus: number | null; code?: string; message: string };
type RequestReceipt = { schema: 1; ownerId: string; key: string; fingerprint: string; taskId: string | null;
  phase: 'unknown' | 'accepted' | 'ready' | 'failed' | 'rejected' | 'closed'; startedFromSourceKey: string | null;
  observation?: RequestObservation; closeObservation?: RequestObservation; rejection?: RejectedRequestReceipt; closure?: ClosedRequestReceipt;
  closeAttempted?: boolean; newRequestAllowed?: boolean };
type Association = { schema: 1; ownerId: string; requestId: string; workspaceTabId: string; assetId: string; referenceImageId?: string };
type ApiError = { error?: string; message?: string; code?: string; task_id?: string; existing_task_id?: string };
type TaskStatus = ApiError & MultiviewTaskProgressInput;
type HdApproval = { exempt: boolean; state: 'approved' | 'pending' | 'none'; expiresAt?: string; enabled?: boolean;
  lastState?: 'rejected' | 'used' | 'expired' | null; reason?: string };
type Quote = { key: string; points: number; pricingRevision: string | null; pricingQuoteToken?: string };
type RequestCheckOutcome = 'pending' | 'deferred' | 'stop' | 'close';
type RequestResponse = ApiError & { request_receipt?: unknown; new_request_allowed?: unknown };
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
const responseCode = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
function safeResponseMessage(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 400
    || /https?:\/\/|data:|bearer\s|authorization|api[_ -]?key|cookie|token\s*[:=]|[<>]|\/(?:Users|Volumes|data|home)\//i.test(value)) return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
}
const shortReason = (value: string) => value.length > 100 ? `${value.slice(0, 100)}…` : value;
function responseObservation(httpStatus: number | null, value?: ApiError): RequestObservation {
  return { httpStatus, ...(responseCode(value?.code) ? { code: value.code } : {}),
    message: safeResponseMessage(value?.message || value?.error) || '服务未返回可确认的提交结果，原请求编号已保留。' };
}
function parseObservation(value: unknown): RequestObservation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.httpStatus !== null && !(typeof record.httpStatus === 'number' && Number.isInteger(record.httpStatus) && record.httpStatus >= 100 && record.httpStatus <= 599)) return undefined;
  return responseObservation(record.httpStatus as number | null, {
    ...(typeof record.code === 'string' ? { code: record.code } : {}), ...(typeof record.message === 'string' ? { message: record.message } : {}),
  });
}
function parseRejectedReceipt(value: unknown, key: string): RejectedRequestReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const reason = safeResponseMessage(record.message);
  if (record.version !== 1 || record.key !== key || record.state !== 'rejected' || record.accepted !== false
    || !responseCode(record.code) || !reason || typeof record.rejectedAt !== 'string' || record.rejectedAt.length > 40
    || !/^\d{4}-\d{2}-\d{2}T/.test(record.rejectedAt) || !Number.isFinite(Date.parse(record.rejectedAt))) return null;
  return { version: 1, key, state: 'rejected', accepted: false, code: record.code, message: reason, rejectedAt: record.rejectedAt };
}
function rejectionFromResponse(value: RequestResponse, key: string) {
  return value.new_request_allowed === true ? parseRejectedReceipt(value.request_receipt, key) : null;
}
function parseClosedReceipt(value: unknown, key: string): ClosedRequestReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const reason = safeResponseMessage(record.message);
  if (record.version !== 1 || record.key !== key || record.state !== 'closed' || record.accepted !== false
    || record.code !== 'MULTIVIEW_REQUEST_CLOSED_BEFORE_ACCEPTANCE' || !reason
    || typeof record.closedAt !== 'string' || record.closedAt.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(record.closedAt)
    || !Number.isFinite(Date.parse(record.closedAt))) return null;
  return { version: 1, key, state: 'closed', accepted: false, code: record.code, message: reason, closedAt: record.closedAt };
}
function closureFromResponse(value: RequestResponse, key: string) {
  return value.new_request_allowed === true ? parseClosedReceipt(value.request_receipt, key) : null;
}
const keyFor = (owner: string, part: string) => `sd2:multiview-generation:v1:${owner}:${part}`;
const tabKey = (owner: string, tab: string, part: string) => keyFor(owner, `tab:${tab}:${part}`);
const receiptKey = (owner: string, key: string) => keyFor(owner, `receipt:${key}`);
const TAB_STORAGE_KEY = 'sd2:multiview-generation:v1:tab';
const MULTIVIEW_REUSE_HANDOFF_PARAM = 'reuse_handoff';
let documentTab: { id: string; resumeTab: string | null } | null = null;
const MAX_SCAN_KEYS = 8192;
type RequestScan = { records: RequestReceipt[]; incomplete: boolean; invalid: boolean; next: number | null };
const pendingActive = (receipt: RequestReceipt | null) => receipt?.phase === 'unknown' || receipt?.phase === 'accepted';
// Only a submission whose acceptance is still unknown blocks a new one (it could be charged twice).
// Accepted tasks keep generating in the background; each one is charged on its own.
const blocksNewRequest = (receipt: RequestReceipt) => pendingActive(receipt) && !receipt.taskId;
function parsePublicPresetState(value: unknown): MultiviewRotationPresetPublicState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!Number.isSafeInteger(row.revision) || Number(row.revision) < 0 || !row.preset || typeof row.preset !== 'object' || Array.isArray(row.preset)) return null;
  const preset = row.preset as Record<string, unknown>;
  const defaults = preset.defaults;
  if (preset.id !== 'multiview-360' || !isMultiviewPresetVersion(preset.version)
    || !defaults || typeof defaults !== 'object' || Array.isArray(defaults)) return null;
  const settings = defaults as Record<string, unknown>;
  if (settings.provider !== 'seedance' || settings.generationMode !== 'all_in_one_reference'
    || typeof settings.model !== 'string' || settings.model.length > 160 || !RATIO_OPTIONS.includes(settings.ratio as never)
    || typeof settings.duration !== 'number' || !Number.isFinite(settings.duration) || !RESOLUTION_OPTIONS.includes(settings.resolution as never)
    || !isMultiviewGenerationSeed(settings.seed) || typeof settings.generateAudio !== 'boolean'
    || typeof settings.returnLastFrame !== 'boolean' || typeof settings.watermark !== 'boolean') return null;
  return { revision: Number(row.revision), preset: { id: 'multiview-360', version: preset.version,
    defaults: { provider: 'seedance', generationMode: 'all_in_one_reference', model: settings.model,
      ratio: settings.ratio as (typeof RATIO_OPTIONS)[number], duration: settings.duration,
      resolution: settings.resolution as (typeof RESOLUTION_OPTIONS)[number], seed: settings.seed,
      generateAudio: settings.generateAudio, returnLastFrame: settings.returnLastFrame, watermark: settings.watermark } } };
}
function parseReceipt(raw: string | null, owner: string): RequestReceipt | null {
  if (!raw) return null;
  if (raw.length > 4096) throw new Error('原请求记录无法确认，请先核对任务，不会重新生成。');
  const value = JSON.parse(raw) as RequestReceipt;
  if (value?.schema !== 1 || value.ownerId !== owner || !identifier(value.key) || !/^[a-f0-9]{64}$/.test(value.fingerprint)
    || value.taskId !== null && !identifier(value.taskId) || !['unknown', 'accepted', 'ready', 'failed', 'rejected', 'closed'].includes(value.phase)
    || value.startedFromSourceKey !== null && (typeof value.startedFromSourceKey !== 'string' || value.startedFromSourceKey.length > 4096)) throw new Error('原请求记录无法确认，请先核对任务，不会重新生成。');
  const rejection = value.newRequestAllowed === true ? parseRejectedReceipt(value.rejection, value.key) : null;
  const closure = value.newRequestAllowed === true ? parseClosedReceipt(value.closure, value.key) : null;
  const observation = parseObservation(value.observation);
  const closeObservation = parseObservation(value.closeObservation);
  return { schema: 1, ownerId: owner, key: value.key, fingerprint: value.fingerprint, taskId: value.taskId,
    phase: (value.phase === 'rejected' && !rejection || value.phase === 'closed' && !closure) ? 'unknown' : value.phase,
    startedFromSourceKey: value.startedFromSourceKey, ...(value.closeAttempted === true ? { closeAttempted: true } : {}),
    ...(observation ? { observation } : {}), ...(closeObservation ? { closeObservation } : {}), ...(rejection ? { rejection, newRequestAllowed: true } : {}),
    ...(closure ? { closure, newRequestAllowed: true } : {}) };
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
function readDocumentTab() {
  if (typeof window === 'undefined') throw new Error('页面现场尚未就绪，未新建请求。');
  if (documentTab) return documentTab;
  const previous = sessionStorage.getItem(TAB_STORAGE_KEY);
  if (previous && !identifier(previous)) throw new Error('本标签的原现场编号无法确认，不能新建生成请求。');
  // An opener/duplicated tab may clone sessionStorage. Its old ID is read-only recovery input,
  // never the writable ID of this Document. Keep the new ID stable across effect/navigation remounts.
  documentTab = { id: `mvtab-${crypto.randomUUID()}`, resumeTab: previous || null };
  return documentTab;
}
function readTabValue(owner: string, tab: string, resumeTab: string | null, part: string) {
  const own = tab ? localStorage.getItem(tabKey(owner, tab, part)) : null;
  return own ?? (resumeTab ? localStorage.getItem(tabKey(owner, resumeTab, part)) : null);
}
function readCurrentReceipt(owner: string, tab: string, resumeTab: string | null): RequestReceipt | null {
  const pointer = readTabValue(owner, tab, resumeTab, 'request-key') ?? localStorage.getItem(keyFor(owner, 'last-request-key'));
  if (pointer === 'null') return null; // This Document has explicitly restored an empty current slot.
  if (pointer !== null) {
    if (!identifier(pointer)) throw new Error('原请求编号无法确认，未新建请求。');
    const result = parseReceipt(localStorage.getItem(receiptKey(owner, pointer)), owner);
    if (!result || result.key !== pointer) throw new Error('原请求记录缺失，不能按没有请求处理。');
    return result;
  }
  // Read-only compatibility for the original account-wide slot. Never remove it.
  return parseReceipt(localStorage.getItem(keyFor(owner, 'request')), owner);
}
function readAssociation(owner: string, tab: string, resumeTab: string | null) {
  const own = readTabValue(owner, tab, resumeTab, 'association');
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
  const projectCreate = useProjectCreateOperation(owner, 'multiview');
  const authorityKey = JSON.stringify([owner, user?.role, user?.account_type, user?.feature_profile_id,
    user?.feishu?.user_id, user?.feishu?.open_id, user?.feishu?.union_id]);
  const sessionReady = Boolean(owner && hasLoadedUser && !sessionChanged && !userLoadError && !isClientSessionBlocked() && uploadSession().ownerId === owner);
  const allowed = Boolean(sessionReady && user && !isExternalUser(user));
  const [loadedOwner, setLoadedOwner] = useState('');
  const [loadedAuthority, setLoadedAuthority] = useState('');
  const [sessionTab, setSessionTab] = useState('');
  const [draft, setDraft] = useState<MultiviewGenerationDraft | null>(null);
  const [receipt, setReceipt] = useState<RequestReceipt | null>(null);
  const [taskProgress, setTaskProgress] = useState<{ key: string; value: MultiviewGenerationProgressState } | null>(null);
  const [sections, setSections] = useState({ owner: '', advanced: false, card: false, create: false, dest: false });
  useEffect(() => {
    const next = { owner, advanced: false, card: false, create: false, dest: false };
    try {
      const stored = JSON.parse(localStorage.getItem(`sd2:multiview:generation-sections:v1:${owner}`) || 'null');
      if (stored && typeof stored === 'object') for (const key of ['advanced', 'card', 'create', 'dest'] as const)
        if (typeof stored[key] === 'boolean') next[key] = stored[key];
    } catch { /* Display preferences never block restoring the actual draft. */ }
    setSections(next);
  }, [owner]);
  useEffect(() => {
    if (!sessionReady || sections.owner !== owner) return;
    try { localStorage.setItem(`sd2:multiview:generation-sections:v1:${owner}`, JSON.stringify(sections)); } catch {}
  }, [owner, sections, sessionReady]);
  function toggleSection(key: 'advanced' | 'card' | 'create' | 'dest', open: boolean) {
    if (!sessionReady || sections.owner !== owner) return;
    setSections(current => current[key] === open ? current : { ...current, [key]: open });
  }
  const [association, setAssociation] = useState<Association | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [cards, setCards] = useState<VideoCard[]>([]);
  const [projectLoading, setProjectLoading] = useState(false);
  const [cardLoading, setCardLoading] = useState(false);
  const [imageReady, setImageReady] = useState(false);
  const [working, setWorking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closeRetryKey, setCloseRetryKey] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [hd, setHd] = useState<HdApproval | null>(null);
  const [hdPurpose, setHdPurpose] = useState('');
  const [hdBusy, setHdBusy] = useState(false);
  const [hdError, setHdError] = useState('');
  const [hdRefresh, setHdRefresh] = useState(0);
  const [quoteError, setQuoteError] = useState('');
  const [presetState, setPresetState] = useState<MultiviewRotationPresetPublicState | null>(null);
  const [presetError, setPresetError] = useState('');
  const [presetRefresh, setPresetRefresh] = useState(0);
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptRisk, setPromptRisk] = useState({ unsaved: false, busy: false });
  const [settingsRisk, setSettingsRisk] = useState({ unsaved: false, busy: false });
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [saved, setSaved] = useState(true);
  const [draftEdited, setDraftEdited] = useState(false);
  const [retainedDraft, setRetainedDraft] = useState('');
  const [saveNotice, setSaveNotice] = useState('');
  const [requestStorageFailed, setRequestStorageFailed] = useState(false);
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [progress, setProgress] = useState<UploadProgressSnapshot | null>(null);
  const [projectName, setProjectName] = useState('');
  useEffect(() => { if (projectCreate.pending) setProjectName(projectCreate.pending.input.name); }, [projectCreate.pending]);
  const [cardTitle, setCardTitle] = useState('');
  const [creating, setCreating] = useState<'project' | 'card' | null>(null);
  const [revision, setRevision] = useState(0);
  const [requestScan, setRequestScan] = useState<RequestScan>({ records: [], incomplete: true, invalid: false, next: null });
  const [historyPage, setHistoryPage] = useState(0);
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
  const closeLock = useRef<object | null>(null);
  const checkAbort = useRef<AbortController | null>(null);
  const createLock = useRef<object | null>(null);
  const emittedReady = useRef('');
  const presetRef = useRef(presetState); presetRef.current = presetState;
  const quoteRefreshVersion = useRef('');
  const handoffClaim = useRef('');
  const awaitingInitialPresetDefaults = useRef(false);
  const ready = Boolean(sessionReady && loadedAuthority === authorityKey && owner && loadedOwner === owner && draft);
  const creation = useCreationContext({ ownerId: owner, entry: 'multiview', draftId: sessionTab || 'restoring', projectId: draft?.projectId || null, legacyCardId: draft?.videoCardId || null, enabled: ready,
    onProjectChange: projectId => setDraft(previous => previous ? { ...previous, projectId } : previous) });
  const [creationBaselineId, setCreationBaselineId] = useState<string | null>(null);
  const creationDraftBody = useRef<Record<string, unknown> | null>(null);
  const active = pendingActive(receipt);
  useEffect(() => { if (ready && draft) propsRef.current.onActionSettings?.({ model: draft.model, duration: draft.duration, resolution: draft.resolution, projectId: draft.projectId || '', videoCardId: draft.videoCardId || null }); }, [ready, draft?.model, draft?.duration, draft?.resolution, draft?.projectId, draft?.videoCardId]);
  const currentProject = projects.find(item => item.id === draft?.projectId);
  const currentCard = cards.find(item => item.id === draft?.videoCardId && item.project_id === draft?.projectId);
  const cardSelectionInvalid = Boolean(draft?.videoCardId && (!currentCard || !canGenerateInCard(currentCard)));
  const needsApproval = Boolean(currentProject && currentProject.type !== 'personal' && draft?.resolution === '1080p');
  const approvalBlocked = needsApproval && !creation.context?.v2Available && (!currentCard || !draft?.resolutionApprovalConfirmed);
  const presetReady = Boolean(presetState && draft?.presetVersion === presetState.preset.version);
  const quoteKey = draft ? JSON.stringify([owner, authorityKey, draft.provider, draft.model, draft.duration, draft.resolution, draft.presetVersion,
    draft.settingsBinding?.id, draft.settingsBinding?.revision, draft.projectId, draft.videoCardId, draft.ratio]) : '';
  const currentQuote = quote?.key === quoteKey ? quote : null;
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [confirmationNotice, setConfirmationNotice] = useState('');
  // Bind consent to the complete input and displayed price, never to a mutable form alone.
  const confirmationKey = JSON.stringify([owner, authorityKey, draft, presetState?.revision, creationBaselineId,
    creation.context?.contextRevision, currentQuote?.points, currentQuote?.pricingRevision]);
  const liveConfirmation = useRef(confirmationKey); liveConfirmation.current = confirmationKey;
  const liveGenerationReady = useRef(false);
  liveGenerationReady.current = Boolean(ready && allowed && imageReady && currentProject && !cardSelectionInvalid && !approvalBlocked
    && currentQuote && presetReady && !working && !association && !settingsRisk.busy && !recoveryBlocked
    && (draft?.resolution !== '1080p' || hd?.state === 'approved'));
  useEffect(() => { setConfirmation(null); setConfirmationNotice(''); }, [owner, authorityKey, sessionTab]);
  const accountRequestBlocked = requestScan.invalid || requestScan.incomplete || requestScan.records.some(blocksNewRequest);
  const seedValid = !draft || isMultiviewGenerationSeed(draft.seed);
  const capture = () => ({ owner, authorityKey, epoch: epoch.current, uploadEpoch: uploadSession().epoch });
  const current = (scope: ReturnType<typeof capture>) => scope.owner === mountedOwner.current && scope.epoch === epoch.current
    && scope.authorityKey === liveAuthority.current && liveSessionReady.current && !isClientSessionBlocked()
    && uploadSession().ownerId === scope.owner && uploadSession().epoch === scope.uploadEpoch;
  const invalidateMedia = () => { setImageReady(false); setPickerOpen(false); };
  function change(patch: Partial<MultiviewGenerationDraft>) {
    if (!ready || !current(capture()) || submitLock.current) return;
    const previous = draftRef.current;
    if (!previous) return;
    const next = { ...previous, ...patch };
    if (JSON.stringify(next) === JSON.stringify(previous)) return;
    awaitingInitialPresetDefaults.current = false;
    draftRef.current = next; setDraft(next); setError(''); setSaved(false); setDraftEdited(true);
  }
  async function applyGenerationSettings(result: MultiviewSettingsPickerApplyResult) {
    const scope = capture(); const previous = draftRef.current;
    if (!previous || !ready || !allowed || !current(scope) || submitLock.current || uploadLock.current || createLock.current || closeLock.current
      || pendingActive(receiptRef.current) || recoveryBlocked) throw new Error('当前原请求仍需核对，设置尚未选用；输入保留。');
    const item = result.settings;
    const sourceKey = propsRef.current.currentSourceKey;
    const nextPreset = parsePublicPresetState({ revision: item.revision, preset: result.preset });
    if (item.kind !== 'generation' || !nextPreset || item.value.presetVersion !== nextPreset.preset.version) throw new Error('这份设置的模板版本暂不可确认，输入保留。');
    const previousKey = JSON.stringify(previous);
    const projectResponse = await fetch('/api/projects?lite=true', { headers: { 'x-app-session-user': scope.owner }, cache: 'no-store', signal: AbortSignal.timeout(30000) });
    const projectPayload = await readJsonResponse<ApiError & { projects?: Project[] }>(projectResponse);
    if (!current(scope)) throw new Error('账号或权限已变化，设置尚未选用。');
    if (!projectResponse.ok || !Array.isArray(projectPayload.projects)) throw new Error('项目权限暂未确认，设置尚未选用；输入保留。');
    const freshProjects = projectPayload.projects.filter(project => project.can_generate === true && project.status === 'active');
    setProjects(freshProjects);
    if (previous.projectId && !freshProjects.some(project => project.id === previous.projectId)) throw new Error('原项目已不可用于生成，请先重新选择项目；当前图片和设置保留。');
    let freshCards: VideoCard[] | null = null;
    if (previous.projectId && previous.videoCardId) {
      const cardResponse = await fetch(`/api/projects/${encodeURIComponent(previous.projectId)}/video-cards`, {
        headers: { 'x-app-session-user': scope.owner }, cache: 'no-store', signal: AbortSignal.timeout(30000) });
      const cardPayload = await readJsonResponse<ApiError & { video_cards?: VideoCard[] }>(cardResponse);
      if (!current(scope)) throw new Error('账号或权限已变化，设置尚未选用。');
      if (!cardResponse.ok || !Array.isArray(cardPayload.video_cards)) throw new Error('原视频卡权限暂未确认，设置尚未选用；输入保留。');
      freshCards = cardPayload.video_cards;
      if (!freshCards.some(card => card.id === previous.videoCardId && card.project_id === previous.projectId && canGenerateInCard(card))) {
        setCards(freshCards); throw new Error('原视频卡已不可用于生成，请重新选择或取消关联；当前图片和设置保留。');
      }
    }
    if (!current(scope) || previousKey !== JSON.stringify(draftRef.current) || sourceKey !== propsRef.current.currentSourceKey
      || submitLock.current || pendingActive(receiptRef.current)) throw new Error('当前输入或原请求已变化，请重新选用设置。');
    if (freshCards) setCards(freshCards);
    const value = item.value;
    const next = parseMultiviewGenerationDraft({ ...previous, ...value, settingsBinding: { id: item.id, revision: item.revision },
      resolutionApprovalConfirmed: false, resolutionApprovalId: '' });
    if (!next) throw new Error('这份设置暂不能安全读取，原输入保留。');
    // Persist the existing account/Document draft before replacing any visible input.
    persistDraft(scope.owner, tabRef.current, next);
    awaitingInitialPresetDefaults.current = false;
    draftRef.current = next; setDraft(next); setPresetState(nextPreset); setQuote(null); setPresetError(''); setError('');
    setSaved(true); setRetainedDraft(JSON.stringify(next)); setDraftEdited(true);
  }
  async function useCurrentRotationPreset() {
    const scope = capture(); const previous = draftRef.current;
    if (!previous || !current(scope) || submitLock.current || pendingActive(receiptRef.current)) throw new Error('请先核对原请求，当前设置保留。');
    const previousKey = JSON.stringify(previous);
    const response = await fetch('/api/multiview/preset', { headers: { 'x-app-session-user': scope.owner }, cache: 'no-store', signal: AbortSignal.timeout(30000) });
    const payload = await readJsonResponse<unknown>(response);
    if (!current(scope)) throw new Error('账号或权限已变化，当前设置保留。');
    const nextPreset = parsePublicPresetState(payload);
    if (!response.ok || !nextPreset) throw new Error('当前旋转模板暂不可读取，原设置保留。');
    if (previousKey !== JSON.stringify(draftRef.current) || submitLock.current || pendingActive(receiptRef.current)) throw new Error('当前输入或原请求已变化，请重新选择。');
    const next = { ...previous, presetVersion: nextPreset.preset.version, settingsBinding: undefined };
    persistDraft(scope.owner, tabRef.current, next);
    awaitingInitialPresetDefaults.current = false;
    draftRef.current = next; setDraft(next); setPresetState(nextPreset); setQuote(null); setPresetError(''); setError('');
    setSaved(true); setRetainedDraft(JSON.stringify(next)); setDraftEdited(true);
  }
  function adoptSavedGenerationSettings(item: MultiviewSettingsPickerRecord) {
    const previous = draftRef.current;
    if (!previous || item.kind !== 'generation' || !current(capture()) || pendingActive(receiptRef.current) || submitLock.current
      || JSON.stringify(generationSettingsValue(previous)) !== JSON.stringify(item.value)) return;
    change({ settingsBinding: { id: item.id, revision: item.revision } });
  }
  function saveReceipt(value: RequestReceipt, beforeSubmission = false) {
    const store = () => {
      const existing = parseReceipt(localStorage.getItem(receiptKey(value.ownerId, value.key)), value.ownerId);
      if (existing && (existing.fingerprint !== value.fingerprint || existing.taskId && value.taskId && existing.taskId !== value.taskId)) throw new Error('原请求记录发生冲突，未切换编号。');
      if (existing) {
        value = { ...existing, ...value, ...(existing.closeAttempted ? { closeAttempted: true } : {}),
          ...(!value.observation && existing.observation ? { observation: existing.observation } : {}) };
        // A late empty/error observation cannot erase an already proven terminal fence.
        if (['rejected', 'closed'].includes(existing.phase) && pendingActive(value) && !value.taskId) {
          value = { ...existing, ...(value.observation ? { observation: value.observation } : {}) };
        }
      }
      persist(receiptKey(value.ownerId, value.key), value);
      if (!identifier(tabRef.current)) throw new Error('本标签的原请求现场无法保存，未提交。');
      persistPointer(tabKey(value.ownerId, tabRef.current, 'request-key'), value.key);
      try { persistPointer(keyFor(value.ownerId, 'last-request-key'), value.key); } catch { /* The independently stored receipt remains discoverable. */ }
    };
    if (beforeSubmission) {
      const previous = receiptRef.current;
      if (previous && ['ready', 'failed', 'rejected', 'closed'].includes(previous.phase)
        && localStorage.getItem(receiptKey(previous.ownerId, previous.key)) === null) persist(receiptKey(previous.ownerId, previous.key), previous);
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
    epoch.current++; uploadLock.current = null; submitLock.current = null; checkLock.current = null; closeLock.current = null; createLock.current = null; emittedReady.current = '';
    awaitingInitialPresetDefaults.current = false;
    setLoadedOwner(''); setDraft(null); setReceipt(null); setAssociation(null); setProjects([]); setCards([]);
    setSessionTab(''); setHistoryPage(0); scanRef.current = { records: [], incomplete: true, invalid: false, next: null }; setRequestScan(scanRef.current);
    setImageReady(false); setPickerOpen(false); setWorking(false); setSubmitting(false); setChecking(false); setClosing(false); setCloseRetryKey(''); setProgress(null);
    setProjectLoading(false); setCardLoading(false); setProjectName(''); setCardTitle(''); setCreating(null);
    setQuote(null); setQuoteError(''); setError(''); setStatus(''); setSaved(true); setDraftEdited(false); setSaveNotice(''); setRequestStorageFailed(false); setRecoveryBlocked(false);
    if (!owner || !hasLoadedUser) return;
    let tab = ''; let resumeTab: string | null = null; let restorationValid = true;
    try { const identity = readDocumentTab(); tab = identity.id; resumeTab = identity.resumeTab; setSessionTab(tab); }
    catch (cause) { restorationValid = false; setRecoveryBlocked(true); setError(message(cause, '本标签记录无法读取，未提交。')); }
    let restored: MultiviewGenerationDraft | null = null;
    try {
      restored = (tab ? parseMultiviewGenerationDraft(localStorage.getItem(tabKey(owner, tab, 'draft'))) : null)
        ?? (resumeTab ? parseMultiviewGenerationDraft(localStorage.getItem(tabKey(owner, resumeTab, 'draft'))) : null)
        ?? parseMultiviewGenerationDraft(localStorage.getItem(keyFor(owner, 'draft')));
    } catch { restorationValid = false; setSaved(false); setRecoveryBlocked(true); }
    const next = restored || defaultMultiviewGenerationDraft(`multiview-${crypto.randomUUID()}`);
    awaitingInitialPresetDefaults.current = !restored;
    if (propsRef.current.initialProjectId && identifier(propsRef.current.initialProjectId)) next.projectId = propsRef.current.initialProjectId;
    if (propsRef.current.initialVideoCardId && identifier(propsRef.current.initialVideoCardId)) next.videoCardId = propsRef.current.initialVideoCardId;
    setDraft(next); setRetainedDraft(JSON.stringify(next));
    let restoredReceipt: RequestReceipt | null = null;
    try {
      restoredReceipt = readCurrentReceipt(owner, tab, resumeTab);
      setReceipt(restoredReceipt?.phase === 'ready' ? { ...restoredReceipt, phase: 'accepted' } : restoredReceipt);
    }
    catch (cause) { restorationValid = false; setRecoveryBlocked(true); setError(message(cause, '原请求记录无法读取，不能重新生成。')); }
    let restoredAssociation: Association | null = null;
    try { restoredAssociation = readAssociation(owner, tab, resumeTab); setAssociation(restoredAssociation); }
    catch (cause) { restorationValid = false; setRecoveryBlocked(true); setError(message(cause, '原素材加入记录无法读取。')); }
    if (restorationValid && tab) {
      try {
        // Copy only into this Document's slots before publishing its reload recovery pointer.
        // Existing independent receipts and the read-only resume slots are never overwritten here.
        persist(tabKey(owner, tab, 'draft'), next);
        if (restoredReceipt) {
          const original = localStorage.getItem(receiptKey(owner, restoredReceipt.key));
          if (original === null) persist(receiptKey(owner, restoredReceipt.key), restoredReceipt);
          persistPointer(tabKey(owner, tab, 'request-key'), restoredReceipt.key);
        } else persist(tabKey(owner, tab, 'request-key'), null);
        persist(tabKey(owner, tab, 'association'), restoredAssociation);
        sessionStorage.setItem(TAB_STORAGE_KEY, tab);
        if (sessionStorage.getItem(TAB_STORAGE_KEY) !== tab) throw new Error('本标签恢复记录未能保存，未新建请求。');
      } catch (cause) { setRecoveryBlocked(true); setSaved(false); setError(message(cause, '本标签恢复记录未能保存，未新建请求。')); }
    }
    setLoadedOwner(owner);
    const scanned = scanRequests(owner); scanRef.current = scanned; setRequestScan(scanned);
    return () => { epoch.current++; checkAbort.current?.abort(); };
  }, [owner, hasLoadedUser]);
  useEffect(() => {
    // Session exit retains the old user object for draft safety. That object is not current authority.
    epoch.current++; checkAbort.current?.abort(); checkAbort.current = null;
    uploadLock.current = null; submitLock.current = null; checkLock.current = null; closeLock.current = null; createLock.current = null;
    setImageReady(false); setPickerOpen(false); setProgress(null); setQuote(null); setProjects([]); setCards([]);
    setWorking(false); setSubmitting(false); setChecking(false); setClosing(false); setCloseRetryKey(''); setCreating(null); setProjectLoading(false); setCardLoading(false);
    setLoadedAuthority(sessionReady ? authorityKey : '');
    setPresetState(null); setPresetError(''); setPromptOpen(false); setPromptRisk({ unsaved: false, busy: false }); setSettingsRisk({ unsaved: false, busy: false });
    // Draft and original request/association receipts deliberately remain untouched.
  }, [authorityKey, sessionReady]);
  useEffect(() => {
    if (!ready || !allowed || typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    const token = url.searchParams.get(MULTIVIEW_REUSE_HANDOFF_PARAM) || '';
    const claimKey = `${owner}:${token}`;
    if (!token || handoffClaim.current === claimKey) return;
    handoffClaim.current = claimKey;
    const removeHandoff = () => {
      clearMultiviewReuseHandoff(token);
      const currentUrl = new URL(window.location.href);
      if (currentUrl.searchParams.get(MULTIVIEW_REUSE_HANDOFF_PARAM) === token) {
        currentUrl.searchParams.delete(MULTIVIEW_REUSE_HANDOFF_PARAM);
        window.history.replaceState(window.history.state, '', `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
      }
    };
    const handoff = readMultiviewReuseHandoff(token, owner);
    if (!handoff) {
      removeHandoff();
      setStatus('这次3D多视图复用现场已失效或不属于当前账号，当前草稿没有改变；请从原任务重新选择复用。');
      return;
    }
    if (!handoff.patch) {
      removeHandoff();
      setStatus(`这个结果不能直接恢复生成输入，已保留当前3D多视图草稿；不会自动生成或扣费。${handoff.warnings.join(' ')}`);
      return;
    }
    const scanned = refreshRequests();
    if (recoveryBlocked || pendingActive(receiptRef.current) || scanned.invalid || scanned.incomplete || scanned.records.some(blocksNewRequest)) {
      setStatus('本账号仍有3D多视图原请求待确认，本次复用没有覆盖当前现场。请先核对原请求，确认结束后刷新本页再应用；不会自动重发。');
      return;
    }
    const currentDraft = draftRef.current;
    if (!currentDraft || uploadLock.current || submitLock.current || createLock.current || closeLock.current || association) {
      setStatus('3D多视图当前操作尚未结束，本次复用没有覆盖现场。完成当前操作后刷新本页再应用；不会自动生成。');
      return;
    }
    const next = applyMultiviewReusePatch(currentDraft, handoff.patch);
    if (!next || !identifier(tabRef.current)) {
      removeHandoff();
      setStatus('这次复用参数无法安全写入3D多视图，当前草稿没有改变；请从原任务重新选择复用。');
      return;
    }
    try {
      persistDraft(owner, tabRef.current, next);
    } catch {
      setStatus('这次复用参数无法保存在此设备，当前草稿没有改变；请允许本机存储后刷新重试。');
      return;
    }
    awaitingInitialPresetDefaults.current = false;
    draftRef.current = next; setDraft(next); setRetainedDraft(JSON.stringify(next)); setSaved(true); setDraftEdited(true);
    setPresetState(null); setPresetError(''); setQuote(null); setQuoteError(''); setError('');
    const doneMessage = `已恢复旧任务的本人输入和生成参数；不会自动生成或扣费。${handoff.warnings.join(' ')}`;
    if (!handoff.patch.mainImage) {
      removeHandoff();
      setStatus(doneMessage);
      return;
    }
    const lock = {}; uploadLock.current = lock; setWorking(true); setImageReady(false);
    const handoffScope = capture();
    const pending = attach({ schema: 1, ownerId: owner, requestId: crypto.randomUUID(), workspaceTabId: `multiview-${crypto.randomUUID()}`,
      assetId: handoff.patch.mainImage.assetId, referenceImageId: handoff.patch.mainImage.referenceImageId });
    // attach() retains its original association before the first network wait.
    // A reload can therefore query that operation instead of replaying this handoff.
    removeHandoff();
    void pending.then(() => { if (current(handoffScope)) setStatus(doneMessage); })
      .catch(cause => { if (current(handoffScope)) setError(message(cause, '原主图加入结果待确认；参数和原加入记录已保留，不会重复提交。')); })
      .finally(() => { if (uploadLock.current === lock) { uploadLock.current = null; setWorking(false); } });
    // A blocked claim retries only after an explicit refresh, never when an
    // unrelated state change settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, allowed, owner, sessionTab]);
  useEffect(() => {
    if (!ready || !allowed || active || accountRequestBlocked || recoveryBlocked || submitting) return;
    const scope = capture(); const controller = new AbortController(); let retryTimer: number | undefined;
    const binding = draftRef.current?.settingsBinding;
    setPresetState(null); setQuote(null); setPresetError('');
    void (async () => {
      try {
        const response = await fetch(binding ? `/api/multiview/settings/${encodeURIComponent(binding.id)}/apply` : '/api/multiview/preset', {
          ...(binding ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-app-session-user': scope.owner }, body: JSON.stringify({ expectedRevision: binding.revision }) } : {}),
          cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
        const payload = await readJsonResponse<unknown>(response);
        if (!current(scope) || controller.signal.aborted) return;
        const bound = binding && payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
        const boundSettings = bound ? parseMultiviewSettingsDto(bound.settings) : null;
        const value = binding ? boundSettings?.id === binding.id && boundSettings.revision === binding.revision && boundSettings.kind === 'generation'
          && boundSettings.value.presetVersion === draftRef.current?.presetVersion
          ? parsePublicPresetState({ revision: binding.revision, preset: bound?.preset }) : null : parsePublicPresetState(payload);
        if (!response.ok || !value) throw new Error(typeof bound?.error === 'string' && bound.code === 'MULTIVIEW_PRESET_LEGACY' ? bound.error : '模板暂不可读取，请重试；当前图片和补充要求已保留。');
        const scanned = refreshRequests();
        if (pendingActive(receiptRef.current) || submitLock.current || scanned.invalid || scanned.incomplete || scanned.records.some(blocksNewRequest)) {
          // Root cause of “生成视频 grey until the settings dropdown is touched”: this skip left the template unread
          // with no retry. Re-read shortly; the GET is safe to repeat.
          retryTimer = window.setTimeout(() => setPresetRefresh(count => count + 1), 4000);
          return;
        }
        setPresetState(value);
        const previous = draftRef.current;
        if (!binding && awaitingInitialPresetDefaults.current && previous && !previous.settingsBinding) {
          const next = { ...previous, ...value.preset.defaults, presetVersion: value.preset.version };
          awaitingInitialPresetDefaults.current = false;
          draftRef.current = next;
          setDraft(next);
        }
      } catch { if (current(scope) && !controller.signal.aborted) setPresetError('模板暂不可读取，请重试；当前图片和补充要求已保留。'); }
    })();
    return () => { controller.abort(); if (retryTimer) window.clearTimeout(retryTimer); };
    // Only a future, unsubmitted selection adopts the current preset; original receipts stay immutable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, allowed, active, accountRequestBlocked, recoveryBlocked, submitting, presetRefresh, owner, draft?.settingsBinding?.id, draft?.settingsBinding?.revision]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') setPresetRefresh(value => value + 1); };
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  useEffect(() => {
    if (!ready || !draft || !liveSessionReady.current || isClientSessionBlocked()) return;
    if (!parseMultiviewGenerationDraft(draft)) {
      setSaved(false); setSaveNotice('本次内容过长或设置无效，未能保存到本机；原已保存草稿未被覆盖。'); return;
    }
    try { persistDraft(owner, sessionTab, draft); setRetainedDraft(JSON.stringify(draft)); setSaved(true); setSaveNotice(''); }
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
    if (!ready || !allowed || !draft || !presetReady || active || accountRequestBlocked) return;
    const scope = capture(); const controller = new AbortController();
    const timer = window.setTimeout(() => { void (async () => {
      try {
        const response = await fetch('/api/tasks/estimate', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-app-session-user': owner },
          body: JSON.stringify({ provider: draft.provider, model: draft.model, resolution: draft.resolution, duration: draft.duration,
            project_id: draft.projectId, video_card_id: draft.videoCardId || null, ratio: draft.ratio, draft: false, reference_video_urls: [], multiview_preset_version: draft.presetVersion,
            ...(draft.settingsBinding ? { multiview_settings: draft.settingsBinding } : {}) }),
          cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
        const payload = await readJsonResponse<ApiError & { estimatedCost?: number; multiviewPresetVersion?: string; pricing_revision?: string | null; pricing_quote_token?: string }>(response);
        if (!current(scope) || controller.signal.aborted) return;
        if (response.status === 409 && quoteRefreshVersion.current !== draft.presetVersion) { quoteRefreshVersion.current = draft.presetVersion; setPresetState(null); setPresetRefresh(value => value + 1); }
        if (!response.ok || payload.multiviewPresetVersion !== draft.presetVersion || !validVideoPricingAmount(payload.estimatedCost)
          || payload.pricing_revision !== null && typeof payload.pricing_revision !== 'string') throw new Error(payload.message || payload.error || '报价暂不可用，尚未生成。');
        setQuote({ key: quoteKey, points: payload.estimatedCost, pricingRevision: payload.pricing_revision, pricingQuoteToken: payload.pricing_quote_token });
      } catch (cause) { if (current(scope) && !controller.signal.aborted) setQuoteError(cause instanceof DOMException && cause.name === 'TimeoutError' ? '报价读取超时，请重新报价；尚未生成。' : message(cause, '报价暂不可用，请重新报价。')); }
    })(); }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, allowed, owner, quoteKey, revision, presetReady, active, accountRequestBlocked]);

  useEffect(() => {
    if (!ready || !allowed) return;
    const scope = capture(); const controller = new AbortController();
    void fetch('/api/multiview/1080p-approval', { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) })
      .then(response => response.ok ? readJsonResponse<HdApproval>(response) : null)
      .then(value => { if (current(scope) && !controller.signal.aborted && value) setHd(value); })
      .catch(() => undefined);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, allowed, owner, draft?.resolution, receipt?.key, receipt?.phase, hdRefresh]);
  useEffect(() => {
    if (hd?.state !== 'pending' || draft?.resolution !== '1080p') return;
    const timer = window.setInterval(() => setHdRefresh(value => value + 1), 10000);
    return () => window.clearInterval(timer);
  }, [hd?.state, draft?.resolution]);
  async function requestHd() {
    if (hdBusy || !hdPurpose.trim()) return;
    const scope = capture(); setHdBusy(true); setHdError('');
    try {
      const response = await fetch('/api/multiview/1080p-approval', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'submit', purpose: hdPurpose.trim() }), signal: AbortSignal.timeout(30000) });
      const payload = await readJsonResponse<HdApproval & ApiError>(response);
      if (!current(scope)) return;
      if (!response.ok) throw new Error(payload.error || '申请没有发出，请重试。');
      setHd(payload); setHdPurpose('');
    } catch (cause) { if (current(scope)) setHdError(message(cause, '申请没有发出，请重试。')); }
    finally { setHdBusy(false); }
  }
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
    setImageReady(true); setSaved(false); setDraftEdited(true); setAssociation(null); setError('');
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
  const handledIncoming = useRef(0);
  useEffect(() => {
    const incoming = props.incomingMainAsset;
    if (!incoming || handledIncoming.current === incoming.token || !ready || !allowed || !draft) return;
    handledIncoming.current = incoming.token;
    void selectItem([{ type: 'image', assetId: incoming.assetId } as PickerItem]).then(result => props.onIncomingMainAssetDone?.(result));
  }, [props.incomingMainAsset, ready, allowed, draft]); // eslint-disable-line react-hooks/exhaustive-deps
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

  const checkRequest = useCallback(async (): Promise<RequestCheckOutcome> => {
    const previous = receiptRef.current;
    if (!previous || !owner || loadedOwner !== owner || !liveSessionReady.current || isClientSessionBlocked() || closeLock.current || submitting) return 'stop';
    // An overlapping lookup owns this request, but must not retire the next polling cycle.
    if (checkLock.current) return 'deferred';
    const token = {}; checkLock.current = token; const scope = capture(); const controller = new AbortController(); checkAbort.current = controller; setChecking(true);
    const requestCurrent = () => current(scope) && !controller.signal.aborted && !closeLock.current && receiptRef.current?.key === previous.key;
    try {
      let next = previous;
      if (!next.taskId) {
        const response = await fetch(`/api/tasks/request-status?idempotency_key=${encodeURIComponent(next.key)}`, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
        const payload = await readJsonResponse<RequestResponse & { task?: { id: string } | null; lookup?: string; safeToResubmit?: boolean }>(response);
        if (!requestCurrent()) return 'stop';
        if (!response.ok) { if ([401, 403].includes(response.status)) invalidateMedia(); throw new Error(payload.message || payload.error || '原提交暂未确认，请稍后重新查询。'); }
        if (payload.task != null && !identifier(payload.task.id)) throw new Error('原任务编号无法确认，原记录已保留。');
        const rejection = rejectionFromResponse(payload, next.key);
        if (!payload.task?.id && payload.lookup === 'rejected' && rejection) {
          saveReceipt({ ...next, phase: 'rejected', rejection, newRequestAllowed: true }); setStatus(''); return 'stop';
        }
        const closure = closureFromResponse(payload, next.key);
        if (!payload.task?.id && payload.lookup === 'closed' && closure) {
          saveReceipt({ ...next, phase: 'closed', closure, newRequestAllowed: true }); setStatus(''); return 'stop';
        }
        if (!payload.task?.id) {
          if (next.closeAttempted && ['pending', 'not_found'].includes(payload.lookup || '')) setCloseRetryKey(next.key);
          // The server answered the submission with an error and has no record of this key: ask it to
          // close the request. The server still refuses when any acceptance or charge record exists.
          if (payload.lookup === 'not_found' && !next.closeAttempted && next.observation?.httpStatus && next.observation.httpStatus >= 400) return 'close';
          setStatus(payload.lookup === 'pending' ? '正在确认是否提交成功…' : '暂未查到这次提交。可以在“详情”里结束这次再重新生成，不会重复扣点。');
          return payload.lookup === 'pending' ? 'pending' : 'stop';
        }
        if (!identifier(payload.task.id)) throw new Error('原任务编号无法确认。');
        next = { ...next, taskId: payload.task.id, phase: 'accepted' }; saveReceipt(next);
      }
      const response = await fetch(`/api/video/status/${encodeURIComponent(next.taskId!)}`, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
      const task = await readJsonResponse<TaskStatus>(response);
      if (!requestCurrent()) return 'stop';
      if (!response.ok || task.id !== next.taskId || task.idempotency_key !== next.key) { if ([401, 403, 404].includes(response.status)) invalidateMedia(); throw new Error(task.message || task.error || '原任务状态或请求编号暂不可确认，已保留原记录。'); }
      setTaskProgress(previous => ({ key: next.key, value: multiviewGenerationProgress('submitted', task, previous?.key === next.key ? previous.value : null)! }));
      if (['failed', 'cancelled'].includes(task.local_status)) { saveReceipt({ ...next, phase: 'failed' }); setStatus(task.message || '原视频任务未完成，输入已保留。不会自动重新生成。'); void refreshCredits(); return 'stop'; }
      if (task.local_status !== 'succeeded' || task.submission_unconfirmed) { setStatus(''); return 'pending'; }
      setStatus('正在准备视频与选帧');
      const media = await fetch(`/api/video/multiview/${encodeURIComponent(next.taskId!)}`, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]) });
      const result = await readJsonResponse<ApiError & { info?: { taskId: string; sourceVersion: string } }>(media);
      if (!requestCurrent()) return 'stop';
      if (!media.ok || result.info?.taskId !== next.taskId || !/^[a-f0-9]{64}$/.test(result.info.sourceVersion)) {
        if ([401, 403, 404].includes(media.status)) invalidateMedia();
        setStatus(result.error || '视频已生成，原片或视图还在准备，将继续查询同一任务。'); return 'pending';
      }
      next = { ...next, phase: 'ready' }; saveReceipt(next); setStatus('视频已可读取，可打开八视图。'); void refreshCredits();
      if (emittedReady.current !== next.key) {
        emittedReady.current = next.key;
        propsRef.current.onReady({ taskId: next.taskId!, requestKey: next.key, ownerId: owner, startedFromSourceKey: next.startedFromSourceKey, explicitOpen: false });
      }
      return 'stop';
    } catch (cause) {
      if (requestCurrent() && !controller.signal.aborted) {
        setStatus(message(cause, '原请求暂未确认，请重新查询。'));
        setTaskProgress(value => value?.key === previous.key ? { ...value, value: { ...value.value, uncertain: true, label: '状态暂未确认' } } : value);
      }
      return !controller.signal.aborted && previous.taskId && pendingActive(previous) ? 'pending' : 'stop';
    }
    finally { if (checkLock.current === token) { checkLock.current = null; setChecking(false); } if (checkAbort.current === controller) checkAbort.current = null; }
    // The ref contains the immutable original receipt; draft edits must not restart polling or change its request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, loadedOwner, submitting, refreshCredits]);
  useEffect(() => {
    if (!ready || !allowed || !receipt || !['unknown', 'accepted', 'ready'].includes(receipt.phase)) return;
    let cancelled = false; let timer: ReturnType<typeof setTimeout> | undefined; let pendingChecks = 0;
    const poll = async () => {
      const outcome = await checkRequest();
      if (cancelled) return;
      if (outcome === 'close') { void closeRef.current(); return; }
      if (outcome === 'stop' || !pendingActive(receiptRef.current)) return;
      // Keep checking in the background, slower after the first minute.
      timer = setTimeout(() => void poll(), !receiptRef.current?.taskId && ++pendingChecks >= 12 ? 30000 : 5000);
    };
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [ready, allowed, owner, receipt?.key, receipt?.phase, checkRequest]);
  const phase: MultiviewGenerationPhase = submitting ? 'submitting' : receipt?.phase === 'unknown' ? 'unknown'
    : receipt?.phase === 'accepted' ? 'submitted' : receipt?.phase === 'ready' ? 'video_ready'
      : receipt?.phase === 'closed' ? 'closed' : receipt?.phase === 'failed' || receipt?.phase === 'rejected' ? 'failed' : imageReady ? 'ready' : 'empty';
  // The server proved this request was never accepted, so nothing was charged.
  const notSubmitted = Boolean(receipt && !receipt.taskId && (receipt.phase === 'rejected' || receipt.phase === 'closed'));
  useEffect(() => {
    const confirmedProgress = taskProgress && receipt && taskProgress.key === receipt.key ? taskProgress.value : null;
    propsRef.current.onStateChange?.({
      phase: ready ? phase : 'empty',
      progress: ready ? phase === 'submitted' && confirmedProgress ? confirmedProgress
        : notSubmitted ? { step: null, label: '没有提交成功，没有扣点', uncertain: false, failed: true }
          : multiviewGenerationProgress(phase, null, confirmedProgress) : null,
      busy: ready && (working || submitting || closing || active),
      ...(ready && receipt?.taskId ? { taskId: receipt.taskId } : {}),
      unsaved: ready && draftEdited && !saved && JSON.stringify(draft) !== retainedDraft || requestStorageFailed || promptRisk.unsaved || settingsRisk.unsaved,
      leavingBusy: working || submitting || closing || Boolean(creating) || promptRisk.busy || settingsRisk.busy,
    });
  }, [ready, phase, notSubmitted, working, submitting, closing, active, receipt?.taskId, receipt?.key, taskProgress, saved, draftEdited, draft, retainedDraft, requestStorageFailed, creating, promptRisk, settingsRisk]);

  function openGenerationConfirmation() {
    if (submitLock.current || !liveGenerationReady.current) return;
    setError(''); setStatus(''); setConfirmationNotice(''); setConfirmation(confirmationKey);
  }
  function closeGenerationConfirmation() {
    if (!submitLock.current) { setConfirmation(null); setConfirmationNotice(''); }
  }
  async function generate() {
    if (confirmation === null || submitLock.current) return;
    if (confirmation !== confirmationKey || liveConfirmation.current !== confirmationKey) {
      setConfirmation(confirmationKey); setConfirmationNotice('设置或报价已更新，请核对后再次确认生成。'); return;
    }
    if (!draft || !ready || !allowed || !imageReady || !currentProject || cardSelectionInvalid || approvalBlocked || !currentQuote || !presetReady || !presetState
      || !seedValid || !current(capture()) || working || settingsRisk.busy || uploadLock.current || createLock.current || closeLock.current || association || submitLock.current || pendingActive(receiptRef.current) || recoveryBlocked) return;
    const scanned = refreshRequests();
    if (scanned.invalid || scanned.incomplete || scanned.records.some(blocksNewRequest)) { setStatus('本账号仍有未确认的原请求，或本机记录尚未查全。请先查询下面的原请求，不会新建编号。'); return; }
    const scope = capture(); const token = {}; submitLock.current = token; setSubmitting(true); setError(''); setStatus(''); setConfirmationNotice('');
    const confirmedKey = confirmationKey;
    const confirmedQuote = currentQuote;
    const frozen = JSON.parse(JSON.stringify(draft)) as MultiviewGenerationDraft;
    const startedFromSourceKey = props.currentSourceKey;
    let pending: RequestReceipt | null = null;
    let storedBeforeSubmission = false;
    let submissionHttpStatus: number | null = null;
    try {
      if (!creation.context?.v2Available) throw new Error('当前创作流程尚未开放，输入已保留');
      const previousIntent = creation.intent && !['accepted', 'closed', 'batch_active', 'batch_settled', 'rejected'].includes(creation.intent.state) ? creation.intent : null;
      let key = previousIntent?.request_id || crypto.randomUUID();
      const body: Record<string, unknown> = { ...buildMultiviewGenerationRequest(frozen, { idempotencyKey: key, maxEstimatedCost: currentQuote.points,
        pricingRevision: currentQuote.pricingRevision, pricingQuoteToken: currentQuote.pricingQuoteToken, preset: presetState.preset }),
        creation_contract_version: 2, entry: 'multiview', action: 'generate', continuation: { mode: 'new' },
        video_branch_id: null, count: 1, baseline_task_id: creationBaselineId };
      creationDraftBody.current = body;
      const prepared = await creation.prepare(body, key, previousIntent);
      key = prepared.request_id; body.idempotency_key = key;
      if (!current(scope)) return;
      if (!prepared.availability?.canSubmit) { setStatus('请完成本次创作条件，当前输入已保留。'); setConfirmation(null); return; }
      if (!prepared.quote || !validVideoPricingAmount(prepared.quote.estimated_cost)) {
        setConfirmationNotice('报价暂时无法确认，请返回修改后重新报价。'); setQuote(null); setRevision(value => value + 1); return;
      }
      if (prepared.quote.estimated_cost !== confirmedQuote.points || prepared.quote.pricing_revision !== confirmedQuote.pricingRevision) {
        setQuote({ key: quoteKey, points: prepared.quote.estimated_cost, pricingRevision: prepared.quote.pricing_revision,
          pricingQuoteToken: prepared.quote.pricing_quote_token });
        setConfirmationNotice('报价已更新，请核对后再次确认生成。'); return;
      }
      Object.assign(body, { intent_id: prepared.id, intent_revision: prepared.revision, resolution_approval_id: prepared.approval_id || null,
        ...(prepared.quote?.pricing_quote_token ? { pricing_quote_token: prepared.quote.pricing_quote_token, pricing_fingerprint_version: 2 } : {}) });
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(videoPricingBusinessInput(body))));
      if (!current(scope)) return;
      if (liveConfirmation.current !== confirmedKey || !liveGenerationReady.current || JSON.stringify(draftRef.current) !== JSON.stringify(frozen)) {
        setConfirmationNotice('设置或报价已更新，请核对后再次确认生成。'); return;
      }
      if (presetRef.current?.preset.version !== frozen.presetVersion) { setStatus('模板已更新，正在重新报价；当前输入未提交。'); return; }
      const latest = refreshRequests();
      if (latest.invalid || latest.incomplete || latest.records.some(blocksNewRequest)) { setStatus('本账号有原请求尚未确认，请先查询原记录；当前内容未提交。'); return; }
      pending = { schema: 1, ownerId: owner, key, fingerprint: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''),
        taskId: null, phase: 'unknown', startedFromSourceKey };
      saveReceipt(pending, true);
      storedBeforeSubmission = true;
      setConfirmation(null);
      const response = await fetch('/api/tasks/create', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-app-session-user': owner, 'x-tab-id': frozen.workspaceTabId }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
      submissionHttpStatus = response.status;
      const result = await readJsonResponse<RequestResponse & { id?: string; submission_unconfirmed?: boolean }>(response);
      if (!current(scope)) return;
      const rejection = rejectionFromResponse(result, pending.key);
      if (!identifier(result.id) && !identifier(result.task_id) && rejection) {
        saveReceipt({ ...pending, observation: responseObservation(response.status, result), phase: 'rejected', rejection, newRequestAllowed: true }); setStatus(''); return;
      }
      if (!response.ok) {
        pending = { ...pending, observation: responseObservation(response.status, result) };
        if ([401, 403].includes(response.status)) invalidateMedia();
        if (identifier(result.task_id)) {
          saveReceipt({ ...pending, taskId: result.task_id, phase: 'accepted' });
          setStatus(result.message || result.error || '原任务已记录，正在查询原任务结果；不会重新提交。'); return;
        }
        // A 4xx alone cannot prove this key was never accepted by a concurrent original request.
        saveReceipt(pending); setStatus(''); return;
      }
      if (!identifier(result.id)) throw new Error('提交结果待确认，原请求编号已保留。');
      saveReceipt({ ...pending, taskId: result.id, phase: 'accepted' }); setStatus(''); void refreshCredits();
    } catch (cause) {
      if (current(scope)) {
        if (storedBeforeSubmission && pending && receiptRef.current && receiptRef.current.key === pending.key && pendingActive(receiptRef.current)) {
          saveReceipt({ ...receiptRef.current, observation: responseObservation(submissionHttpStatus) });
          setStatus('');
        }
        else {
          setError(message(cause, '尚未提交，请检查输入。'));
          const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : '';
          if (typeof code === 'string' && /pric|quote/.test(code)) {
            setQuote(null); setRevision(value => value + 1);
            setConfirmationNotice('报价需要更新，正在重新计算；请核对后再次确认生成。');
          }
        }
      }
    } finally { if (submitLock.current === token) { submitLock.current = null; setSubmitting(false); } }
  }
  // 新建: the accepted (or finished) task keeps running in the background and appears in 生成记录; this
  // panel starts an empty slot with the same settings. Nothing is cancelled, resubmitted or charged here.
  function startNew() {
    const previous = receiptRef.current;
    if (!previous || blocksNewRequest(previous) || !ready || submitLock.current || closeLock.current || !identifier(tabRef.current) || !current(capture())) return;
    try { persist(tabKey(owner, tabRef.current, 'request-key'), null); }
    catch { setError('本机记录未能保存，暂不能新建；当前任务不受影响。'); return; }
    checkAbort.current?.abort(); checkAbort.current = null; checkLock.current = null; setChecking(false);
    emittedReady.current = ''; receiptRef.current = null; setReceipt(null); setTaskProgress(null); setCloseRetryKey('');
    const draftNow = draftRef.current;
    if (draftNow?.mainImage) { const next = { ...draftNow, mainImage: null }; draftRef.current = next; setDraft(next); setImageReady(false); }
    setError(''); setStatus(previous.phase === 'accepted' ? '上一单在后台继续生成，完成后可在“生成记录”打开。' : '');
    refreshRequests();
  }
  const closeRef = useRef(closeOriginalRequest); closeRef.current = closeOriginalRequest;
  async function closeOriginalRequest() {
    const previous = receiptRef.current;
    if (!ready || !allowed || !previous || previous.phase !== 'unknown' || previous.taskId || previous.closeAttempted && closeRetryKey !== previous.key
      || closing || closeLock.current || submitLock.current || uploadLock.current || createLock.current) return;
    const scope = capture(); if (!current(scope)) return;
    const token = {}; closeLock.current = token; setClosing(true); setCloseRetryKey(''); setError('');
    checkAbort.current?.abort(); checkAbort.current = null; checkLock.current = null; setChecking(false);
    const requestCurrent = () => current(scope) && receiptRef.current?.key === previous.key;
    let attempted = false;
    try {
      const stored = parseReceipt(localStorage.getItem(receiptKey(owner, previous.key)), owner);
      if (!stored || stored.key !== previous.key || stored.fingerprint !== previous.fingerprint) throw new Error('原请求记录尚未确认，未发送结束操作。');
      if (stored.taskId || stored.phase !== 'unknown' || stored.closeAttempted && closeRetryKey !== previous.key) {
        saveReceipt(stored);
        setStatus(pendingActive(stored) ? '原核对记录已保留，请查询原请求；不会再次发送结束操作。' : ''); return;
      }
      // Each explicit attempt keeps the same key. Unknown results require GET before another explicit attempt.
      saveReceipt({ ...stored, closeAttempted: true }, true);
      attempted = true;
      const response = await fetch('/api/tasks/request-status', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'close_unaccepted', idempotency_key: previous.key }), signal: AbortSignal.timeout(30000) });
      const result = await readJsonResponse<RequestResponse & { task?: { id: string } | null; lookup?: string }>(response);
      if (!requestCurrent()) return;
      const original = receiptRef.current!;
      if ([401, 403].includes(response.status)) invalidateMedia();
      if (result.task?.id && identifier(result.task.id)) {
        saveReceipt({ ...original, taskId: result.task.id, phase: 'accepted' });
        setStatus('已找到原视频任务，将继续查询；没有结束或取消该任务。'); return;
      }
      if (result.task != null) throw new Error('原任务编号尚未确认，请查询原请求。');
      const closure = closureFromResponse(result, previous.key);
      if (response.ok && result.lookup === 'closed' && closure) {
        saveReceipt({ ...original, phase: 'closed', closure, newRequestAllowed: true }); setStatus(''); return;
      }
      const rejection = rejectionFromResponse(result, previous.key);
      if (response.ok && result.lookup === 'rejected' && rejection) {
        saveReceipt({ ...original, phase: 'rejected', rejection, newRequestAllowed: true }); setStatus(''); return;
      }
      const closeObservation = responseObservation(response.status, result);
      saveReceipt({ ...original, closeObservation });
      setStatus(`暂时还不能确认这次提交的结果：${shortReason(closeObservation.message)} 系统会继续确认，不会重复扣点。`);
    } catch (cause) {
      if (requestCurrent()) {
        if (attempted) {
          saveReceipt({ ...receiptRef.current!, closeObservation: responseObservation(null, { message: '服务未返回可确认的结束结果，请先查询原请求。' }) });
          setStatus('暂时还不能确认这次提交的结果，系统会继续确认，不会重复扣点。');
        } else setStatus(message(cause, '原记录尚未保存，未发送结束操作。'));
      }
    } finally { if (closeLock.current === token) { closeLock.current = null; setClosing(false); } }
  }
  function chooseOriginalRequest(record: RequestReceipt) {
    if (!ready || !current(capture()) || submitting || closing || working || creating || record.ownerId !== owner) return;
    try {
      const stored = parseReceipt(localStorage.getItem(receiptKey(owner, record.key)), owner)
        || parseReceipt(localStorage.getItem(keyFor(owner, 'request')), owner);
      if (!stored || stored.key !== record.key || stored.fingerprint !== record.fingerprint) throw new Error('该原请求记录暂无法确认，未换编号。');
      persist(receiptKey(owner, stored.key), stored);
      persistPointer(tabKey(owner, tabRef.current, 'request-key'), stored.key);
      checkAbort.current?.abort(); checkAbort.current = null; checkLock.current = null; setChecking(false); emittedReady.current = '';
      setCloseRetryKey('');
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
      if (kind === 'project') {
        const result = await projectCreate.create({ name });
        if (!current(scope)) return;
        if (result.operation.state === 'accepted') applyCreatedProject(result);
        return;
      }
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/video-cards`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: name, objective: null }), signal: AbortSignal.timeout(30000) });
      const payload = await readJsonResponse<ApiError & { project?: Project; video_card?: VideoCard }>(response);
      if (!current(scope)) return;
      if (!response.ok) throw new Error(payload.message || payload.error || '保存位置创建未确认，请先刷新列表核对，不要重复创建。');
      if (payload.video_card && draftRef.current?.projectId === projectId) { setCards(value => [payload.video_card!, ...value]); change({ videoCardId: payload.video_card.id }); setCardTitle(''); }
      else throw new Error('创建结果尚未确认，请刷新列表核对。');
    } catch (cause) { if (current(scope)) setError(message(cause, '创建结果待确认，请先刷新列表。')); }
    finally { if (createLock.current === token) { createLock.current = null; setCreating(null); } }
  }

  function applyCreatedProject(result: ProjectCreateResult) {
    if (result.operation.state !== 'accepted') return;
    const project = result.project;
    if (project) {
      setProjects(value => [project, ...value.filter(item => item.id !== project.id)]);
      change({ projectId: project.id, videoCardId: '' }); setProjectName('');
    } else setError('原创建已受理，当前项目已不可访问，没有重新创建。');
  }

  if (!hasLoadedUser) return <section className={styles.panel} role="status">正在读取生成设置…</section>;
  if (!user) return <section className={styles.panel}><p>登录后可选择图片并生成视频。</p><button type="button" onClick={props.onUseExisting}>使用已有视频</button></section>;
  if (!sessionReady) return <section className={styles.panel} role="status">当前登录或权限状态尚未确认，生成已暂停。输入和原请求记录仍保留。</section>;
  if (!allowed) return <section className={styles.panel}><p>当前账号不能使用普通视频生成。已有视频仍按原权限查看。</p><button type="button" onClick={props.onUseExisting}>使用已有视频</button></section>;
  if (!ready || !draft) return <section className={styles.panel} role="status">正在恢复本账号的设置…</section>;
  const selectedModel = SEEDANCE_VIDEO_MODEL_OPTIONS.find(item => item.id === draft.model);
  const durationOptions = seedanceVideoDurationOptions(draft.model);
  const settingsDisabled = submitting || closing || working || Boolean(creating) || active || accountRequestBlocked || recoveryBlocked;
  const formDisabled = submitting || closing || working || Boolean(creating) || settingsRisk.busy;
  const hdBlocked = draft.resolution === '1080p' && hd?.state !== 'approved';
  const blocked = formDisabled || active || accountRequestBlocked || recoveryBlocked || Boolean(association) || !imageReady || !currentProject
    || cardSelectionInvalid || approvalBlocked || hdBlocked || !currentQuote || !presetReady || !seedValid;
  // Every disabled state says what is missing (no silent grey button).
  const blockedReason = submitting || active ? '' : recoveryBlocked ? '本机记录读取异常，请刷新页面后再试'
    : accountRequestBlocked ? '还有一单的提交结果未确认，请先在下方“详情”里处理'
      : association || working ? '主图正在准备…' : !imageReady ? '请先选择主图' : !currentProject ? '请选择保存到的项目'
        : cardSelectionInvalid ? '所选视频卡不可用，请重新选择或取消关联' : approvalBlocked || hdBlocked ? '1080p 需要先经管理员同意'
          : !presetReady ? presetError || '模板正在读取…' : !currentQuote ? quoteError || '正在计算点数…'
            : !seedValid ? '随机种子无效，请在高级设置里调整' : formDisabled ? '设置正在保存…' : '';
  const sameReady = Boolean(receipt?.phase === 'ready' && receipt.taskId && receipt.taskId === props.currentTaskId);
  const quietReady = sameReady && !props.expanded && !error && !status && saved && !requestStorageFailed && !accountRequestBlocked && !recoveryBlocked;
  const notSubmittedReason = receipt?.rejection?.message || receipt?.observation?.message;
  const requestSummary = notSubmitted
    ? `没有提交成功，没有扣点。${notSubmittedReason ? `原因：${shortReason(notSubmittedReason)} ` : ''}图片和设置已保留，可以直接重新生成。`
    : receipt?.phase === 'unknown' ? '正在确认是否提交成功，系统会自动确认，不会重复扣点。' : '';
  const admin = user.role === 'admin';
  return <section className={styles.panel} aria-label="原图与生成设置" onPaste={event => {
    const images = Array.from(event.clipboardData.files).filter(item => item.type.startsWith('image/'));
    if (!images.length || formDisabled) return;
    event.preventDefault();
    if (images.length !== 1) { setError('一次放入一张主图，原主图未改变。'); return; }
    void selectFile(images[0]);
  }}>
    <header className={styles.summary}>
      {imageReady && draft.mainImage && <img src={`/api/reference-images/${encodeURIComponent(draft.mainImage.referenceImageId)}/content?variant=thumbnail`} alt="当前生成主图" onError={() => setImageReady(false)} />}
      <div><h2>原图与生成设置</h2><p>{sameReady ? '当前视频已打开 · ' : ''}360°旋转模板 · {selectedModel?.label || draft.model} · {draft.duration}秒 · {draft.resolution}</p>{!props.expanded && working && <small role="status">主图正在准备，尚未生成视频…</small>}</div>
      <div className={styles.summaryActions}>{receipt && !blocksNewRequest(receipt) && <button type="button" className={styles.primary} data-tip="上一单继续在后台生成，这里开始新的一单" disabled={submitting || closing} onClick={startNew}><Plus size={16} />新建</button>}
        <button type="button" disabled={formDisabled || Boolean(association)} onClick={() => setPickerOpen(true)}><ImagePlus size={16} />更换图片</button>
        <button type="button" onClick={props.onUseExisting}><FolderOpen size={16} />使用已有视频</button>

        <button type="button" aria-expanded={props.expanded} onClick={() => props.onExpandedChange(!props.expanded)}>{props.expanded ? '收起设置' : '展开设置'}<ChevronDown size={16} /></button></div>
    </header>
    {props.expanded && <div className={styles.body}>
      <div className={styles.imageArea} onDragOver={event => { event.preventDefault(); }} onDrop={event => {
        event.preventDefault();
        if (formDisabled || !event.dataTransfer.files.length) return;
        if (event.dataTransfer.files.length !== 1) { setError('一次放入一张主图，原主图未改变。'); return; }
        void selectFile(event.dataTransfer.files[0]);
      }}>
        <button type="button" className={styles.imageButton} disabled={formDisabled || Boolean(association)} onClick={() => setPickerOpen(true)}>
          {imageReady && draft.mainImage ? <img src={`/api/reference-images/${encodeURIComponent(draft.mainImage.referenceImageId)}/content?variant=preview`} alt="本次视频的直接输入主图" onError={() => { setImageReady(false); setError('主图暂不可读取，请重新选择，参数已保留。'); }} />
            : <span><Upload size={28} /><strong>放入一张图片</strong><small>点击从素材库选择或上传，也可拖入或粘贴图片</small></span>}
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
        <details className={styles.advanced}><summary>生成预设</summary>
        <MultiviewSettingsPicker kind="generation" ownerId={owner} authorityKey={authorityKey} disabled={settingsDisabled}
          value={presetReady ? generationSettingsValue(draft) : null} binding={draft.settingsBinding}
          onApply={applyGenerationSettings} onReset={useCurrentRotationPreset} onSaved={adoptSavedGenerationSettings} onStateChange={setSettingsRisk}
          onRenamed={(item, previousRevision) => {
            const binding = draftRef.current?.settingsBinding;
            if (binding?.id === item.id && binding.revision === previousRevision) change({ settingsBinding: { id: item.id, revision: item.revision } });
          }} />
        <div className={styles.preset}><strong>360°旋转模板</strong>{user.role === 'admin' && <button type="button" className={styles.quiet} disabled={formDisabled} onClick={() => setPromptOpen(true)}>{draft.settingsBinding ? '默认模板提示词' : '模板提示词'}</button>}</div>
        {draft.settingsBinding && <small>使用这份设置保存时的默认配置。</small>}
        </details>
        {presetError && !active && <p className={styles.feedback} role="status">{presetError}<button type="button" className={styles.quiet} onClick={() => setPresetRefresh(value => value + 1)}>重新读取</button></p>}
        <div className={styles.parameters}>
          <label>模型<select value={draft.model} disabled={formDisabled} onChange={event => change({ model: event.target.value })}>{!selectedModel && <option value={draft.model}>{draft.model || '未选择'}</option>}{SEEDANCE_VIDEO_MODEL_OPTIONS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <label>时长<select value={draft.duration} disabled={formDisabled} onChange={event => change({ duration: Number(event.target.value) })}>{!durationOptions.some(value => value === draft.duration) && <option value={draft.duration}>{draft.duration}秒（需确认）</option>}{durationOptions.map(value => <option key={value} value={value}>{value}秒</option>)}</select></label>
          <label>清晰度<select value={draft.resolution} disabled={formDisabled} onChange={event => change({ resolution: event.target.value, resolutionApprovalConfirmed: false, resolutionApprovalId: '' })}>{!RESOLUTION_OPTIONS.some(value => value === draft.resolution) && <option value={draft.resolution}>{draft.resolution || '未选择'}</option>}{RESOLUTION_OPTIONS.map(value => <option key={value} value={value}>{value === '1080p' && hd && !hd.exempt ? '1080p（需审批）' : value}</option>)}</select></label>
        </div>
        {draft.resolution === '1080p' && !hd?.exempt && <div className={styles.feedback} role="status">
          {!hd ? <p>正在确认 1080p 审批…</p>
            : hd.state === 'approved' ? <p>管理员已同意 1 次 1080p{hd.expiresAt ? `，${new Date(hd.expiresAt).toLocaleString()} 前有效` : ''}。开始生成后即使失败也不退回次数；没开始生成就失败会退回。</p>
              : hd.state === 'pending' ? <p>已发给管理员，等待在飞书同意（24 小时内有效）。也可以先改用 720p。</p>
                : <>
                  <p>3D多视图 1080p 每次都需要管理员在飞书同意。{hd.lastState === 'rejected' ? `上次申请未通过${hd.reason ? `：${hd.reason}` : ''}。` : hd.lastState === 'used' ? '上次同意的 1 次已经用掉。' : hd.lastState === 'expired' ? '上次的申请已过期。' : ''}</p>
                  {hd.enabled === false ? <p>1080p 申请暂未开放，请先使用 720p。</p> : <div className={styles.createRow}>
                    <input aria-label="1080p 用途" value={hdPurpose} maxLength={200} placeholder="用途，如：客户提案需要高清" disabled={hdBusy} onChange={event => setHdPurpose(event.target.value)} />
                    <button type="button" disabled={hdBusy || !hdPurpose.trim()} onClick={() => void requestHd()}>{hdBusy ? '正在发送…' : '申请 1080p'}</button></div>}
                </>}
          {hdError && <p>{hdError}</p>}
        </div>}
        <label className={styles.supplement}>补充要求（可选）<textarea rows={3} maxLength={40000} value={draft.supplement} disabled={submitting} placeholder="如：保持帽子和背包完整，背景使用浅灰色" onChange={event => change({ supplement: event.target.value })} /><small>仅补充本次视频要求，不修改固定模板</small></label>
        {!seedValid && <p className={styles.feedback} role="status">随机种子须为 -1 或0至2147483647的整数，原值已保留，请在高级设置中调整。</p>}
        <details className={styles.advanced} open={sections.owner === owner && sections.advanced} onToggle={event => toggleSection('advanced', event.currentTarget.open)}><summary>高级设置</summary>
          <div className={styles.parameters}><label>画面比例<select value={draft.ratio} disabled={formDisabled} onChange={event => change({ ratio: event.target.value })}>{!RATIO_OPTIONS.some(value => value === draft.ratio) && <option value={draft.ratio}>{draft.ratio}</option>}{RATIO_OPTIONS.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
            <label>随机种子<input type="number" value={draft.seed} disabled={formDisabled} onChange={event => change({ seed: Number(event.target.value) })} /></label></div>
          <div className={styles.checks}>{(['generateAudio', 'returnLastFrame', 'watermark'] as const).map((key, index) => <label key={key}><input type="checkbox" checked={draft[key]} disabled={formDisabled} onChange={event => change({ [key]: event.target.checked })} />{['生成声音', '返回末帧', '水印'][index]}</label>)}</div>
          <button type="button" disabled={formDisabled || !presetState} onClick={() => { const defaults = presetState?.preset.defaults; if (!defaults) return; change({ ...defaults, presetVersion: presetState.preset.version, settingsBinding: undefined, resolutionApprovalConfirmed: false, resolutionApprovalId: '' }); }}>恢复模板参数</button>
        </details>
        <details className={styles.destination} open={!currentProject || cardSelectionInvalid || sections.owner === owner && sections.dest} onToggle={event => {
          // An automatic open (no project yet / invalid card) is not the user's preference.
          if (currentProject && !cardSelectionInvalid) toggleSection('dest', event.currentTarget.open);
        }}>
          <summary>保存到：{currentProject ? currentProject.name : '请选择项目'} · {currentCard ? currentCard.title : '不关联视频卡'}</summary>
          <label>保存到项目<select value={draft.projectId} disabled={formDisabled || projectLoading} onChange={event => change({ projectId: event.target.value, videoCardId: '', resolutionApprovalConfirmed: false, resolutionApprovalId: '' })}><option value="">{projectLoading ? '正在读取项目…' : '选择项目'}</option>{draft.projectId && !currentProject && <option value={draft.projectId}>原项目暂不可用，请重新选择</option>}{projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <details open={cardSelectionInvalid || sections.owner === owner && sections.card} onToggle={event => toggleSection('card', event.currentTarget.open)}>
            <summary>关联视频卡（可选）{currentCard ? `：${currentCard.title}` : ''}</summary>
            <label>视频卡（可选）<select value={draft.videoCardId} disabled={formDisabled || cardLoading || !currentProject} onChange={event => change({ videoCardId: event.target.value, resolutionApprovalConfirmed: false, resolutionApprovalId: '' })}><option value="">{cardLoading ? '正在读取视频卡…' : '不关联视频卡'}</option>{draft.videoCardId && !currentCard && <option value={draft.videoCardId}>原视频卡暂不可用，请重新选择或取消关联</option>}{cards.map(item => <option key={item.id} value={item.id} disabled={!canGenerateInCard(item)}>{item.title}{!canGenerateInCard(item) ? '（不可生成）' : ''}</option>)}</select></label>
            {cardSelectionInvalid && !cardLoading && <p className={styles.feedback} role="status">原视频卡暂不可用于生成，请重新选择或明确取消关联，其他输入已保留。</p>}
          </details>
          <button type="button" className={styles.quiet} disabled={formDisabled} onClick={() => setRevision(value => value + 1)}><RefreshCw size={13} />刷新列表</button>
          <details open={sections.owner === owner && sections.create} onToggle={event => toggleSection('create', event.currentTarget.open)}><summary>新建项目或视频卡</summary><div className={styles.createRow}><input aria-label="新项目名称" value={projectName} maxLength={80} placeholder="新项目名称" disabled={formDisabled || Boolean(projectCreate.pending)} onChange={event => setProjectName(event.target.value)} /><button type="button" disabled={formDisabled || !projectName.trim() || projectCreate.busy || !projectCreate.ready || Boolean(projectCreate.pending)} onClick={() => void createDestination('project')}>新建项目</button></div>
            <div className={styles.createRow}><input aria-label="新视频卡标题" value={cardTitle} maxLength={100} placeholder="新视频卡标题" disabled={formDisabled} onChange={event => setCardTitle(event.target.value)} /><button type="button" disabled={formDisabled || !currentProject || !cardTitle.trim()} onClick={() => void createDestination('card')}>新建视频卡</button></div></details>
        </details>
        {needsApproval && !creation.context?.v2Available && <p className={styles.feedback}>当前项目的1080p生成需要关联已有候选、当前最佳或最终版的视频卡，并通过该卡审批。</p>}
        {needsApproval && !creation.context?.v2Available && currentCard && !cardSelectionInvalid && <label className={styles.approval}><input type="checkbox" checked={draft.resolutionApprovalConfirmed} disabled={formDisabled} onChange={event => change({ resolutionApprovalConfirmed: event.target.checked, resolutionApprovalId: '' })} /><span>我已确认审批中心存在当前视频卡的有效1080p审批。<a href="/approvals" target="_blank" rel="noreferrer">查看审批</a></span></label>}
        <div className={styles.generateRow}><button type="button" className={styles.primary} disabled={Boolean(blocked)} onClick={openGenerationConfirmation}>{submitting ? '正在提交…' : receipt?.phase === 'unknown' ? '正在确认提交…' : receipt?.phase === 'accepted' ? '已提交，生成中' : notSubmitted ? '重新生成' : '生成视频'}</button><span>{currentQuote ? `本次预计 ${currentQuote.points} 点` : '报价待确认'}</span></div>
        {blocked && blockedReason && <p className={styles.blockedReason} role="status">{blockedReason}</p>}
        {quoteError && <p className={styles.feedback} role="status">{quoteError}<button type="button" className={styles.quiet} onClick={() => setRevision(value => value + 1)}>重新报价</button></p>}
      </div>
    </div>}
    {confirmation !== null && <MultiviewGenerationConfirmDialog draft={draft} modelLabel={selectedModel?.label || draft.model}
      projectName={currentProject?.name || ''} cardTitle={currentCard?.title} points={currentQuote?.points ?? null}
      busy={submitting} blocked={Boolean(blocked)}
      notice={error || confirmationNotice || status || blockedReason || (confirmation !== confirmationKey ? '设置或报价已更新，请核对后再次确认生成。' : '')}
      onClose={closeGenerationConfirmation} onConfirm={() => void generate()}
      onImageError={() => { setImageReady(false); setConfirmationNotice('主图暂不可读取，请返回修改后重新选择。'); }} />}
    <ProjectCreateOperationNotice operation={projectCreate} onResolved={applyCreatedProject} />
    {!quietReady && (error || status || !saved || requestStorageFailed || accountRequestBlocked || requestScan.records.length > 0 || recoveryBlocked || active || receipt?.phase === 'ready') && <footer className={styles.footer}>
      {requestSummary && <p role="status">{requestSummary}</p>}
      {error && <p role="status">{error}</p>}{status && !sameReady && <p role="status">{status}</p>}
      {!saved && <p role="status">{saveNotice || '本次修改无法保存在此设备，刷新可能丢失输入。'}</p>}
      {requestStorageFailed && <p role="status">原任务已保留在当前页面，但最新查询记录无法保存到此设备。请保留任务编号后再离开。</p>}
      {receipt?.phase === 'ready' && receipt.taskId && !sameReady && <div className={styles.requestActions}><button type="button" onClick={() => { if (current(capture())) props.onReady({ taskId: receipt.taskId!, requestKey: receipt.key, ownerId: owner, startedFromSourceKey: receipt.startedFromSourceKey, explicitOpen: true }); }}>打开新结果</button></div>}
      {receipt && !sameReady && <details className={styles.requestDetails}>
        <summary>详情</summary>
        <div className={styles.requestActions}>{receipt.taskId ? <a href={`/tasks/${encodeURIComponent(receipt.taskId)}`} target="_blank" rel="noreferrer">查看视频任务</a> : admin && <a href="/tasks" target="_blank" rel="noreferrer">任务列表</a>}
          {receipt.phase !== 'ready' && pendingActive(receipt) && <button type="button" disabled={checking || submitting || closing} onClick={() => void checkRequest()}>{checking ? '正在确认…' : '立即确认'}</button>}
          {receipt.phase === 'unknown' && !receipt.taskId && (!receipt.closeAttempted || closeRetryKey === receipt.key || closing) && <button type="button" disabled={formDisabled || Boolean(association)} onClick={() => void closeOriginalRequest()}>{closing ? '正在结束…' : '结束这次，重新开始'}</button>}</div>
        <p>请求编号：{receipt.taskId || receipt.key}</p>
        {receipt.observation && <p>上次提交反馈{receipt.observation.httpStatus ? `（HTTP ${receipt.observation.httpStatus}）` : ''}：{receipt.observation.message}</p>}
        {receipt.closeObservation && <p>上次核对结束反馈：{receipt.closeObservation.message}</p>}
        {receipt.rejection && <p>服务器已确认未开始生成：{receipt.rejection.message}</p>}
        {receipt.closure && <p>{receipt.closure.message}</p>}
      </details>}
      {(admin || accountRequestBlocked) && <details className={styles.requestHistory} open={accountRequestBlocked && !active}>
        <summary>{requestScan.records.some(blocksNewRequest) ? '还有提交在确认中' : '本账号提交记录'}</summary>
        {(requestScan.invalid || requestScan.incomplete) && <p role="status">本机的提交记录没有读全，为避免重复扣点，暂时不能新建生成。可以点“刷新”。</p>}
        {requestScan.records.slice(historyPage * 8, historyPage * 8 + 8).map(record => <div className={styles.historyRow} key={record.key}>
          <span>{record.taskId ? `任务 ${record.taskId}` : `请求 ${record.key}`} · {record.phase === 'unknown' ? '确认中' : record.phase === 'accepted' ? '生成中' : record.phase === 'rejected' || record.phase === 'closed' ? '没有提交成功' : record.phase === 'ready' ? '视频已生成' : '已结束'}</span>
          <button type="button" disabled={formDisabled || !pendingActive(record) && record.key === receipt?.key} onClick={() => chooseOriginalRequest(record)}>切换到这次</button>
        </div>)}
        <div className={styles.requestActions}><button type="button" disabled={historyPage === 0} onClick={() => setHistoryPage(value => value - 1)}>上一页</button>
          <span>第 {historyPage + 1} 页 · 共 {requestScan.records.length} 条</span>
          <button type="button" disabled={(historyPage + 1) * 8 >= requestScan.records.length} onClick={() => setHistoryPage(value => value + 1)}>下一页</button>
          <button type="button" onClick={() => refreshRequests()}>刷新</button>
          {requestScan.next !== null && <button type="button" onClick={() => refreshRequests(requestScan.next!)}>继续读取未列记录</button>}</div>
      </details>}
    </footer>}
    <CreationAvailability controller={creation} onBaselineChange={id => { setCreationBaselineId(id); if (creation.intent && creationDraftBody.current) void creation.prepare({ ...creationDraftBody.current, baseline_task_id: id }, creation.intent.request_id, creation.intent).catch(cause => setError(message(cause, '基准更新未确认，输入已保留'))); }} />
    {pickerOpen && <UploadedImagePicker open imageOnly target="workspace" title="选择视频主图" purpose="multiview-main-image" contextKey={`${owner}:multiview:${sessionTab}:main-image`} maxSelection={1} currentCount={0} currentAssetIds={[]} currentReferenceImageIds={[]} onClose={() => setPickerOpen(false)}
      onUploadFile={(file, onProgress) => current(capture()) ? uploadFileToHistory(file, { ownerId: owner, onProgress }) : Promise.reject(new Error('当前账号尚未确认，未上传素材。'))} onConfirm={async () => ({ success: false, message: '请选择一张主图。' })} onConfirmSelection={selectItem} />}
    {user.role === 'admin' && <MultiviewPromptDialog open={promptOpen} authorityKey={authorityKey} ownerId={owner} duration={draft?.duration} onClose={() => { setPromptOpen(false); setPresetRefresh(count => count + 1); }} onStateChange={setPromptRisk} onSaved={() => {
      if (!current(capture())) return;
      // A saved mutation may be historical; only a fresh current read can select the next preset.
      setPresetState(null); setPresetError(''); setQuote(null);
      setPresetRefresh(count => count + 1);
    }} />}
  </section>;
}
