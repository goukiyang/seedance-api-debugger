'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Archive, ArrowLeft, Check, ChevronLeft, ChevronRight, Download, FileArchive, ImagePlus,
  LockKeyhole, Pause, Play, RotateCcw, Save, SkipBack, SkipForward, UnlockKeyhole, Upload, Video,
} from 'lucide-react';
import type {
  AnimationDocumentView, AnimationEntry, AnimationExportView, AnimationFileInfo, AnimationJobKind,
  AnimationJobParameters, AnimationJobView, AnimationPose, AnimationSequence, AnimationSummary,
} from '@/lib/animation/types';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';
import type { ImageComparisonSource } from '@/components/ZoomableImagePreview';
import {
  advanceDocumentRequestContext, animationWorkbenchHref, assignPoseToEntry, canChangeGlobalScale, canExportValidated, canSaveAtRevision, clearMutationIfCurrent, documentRequestStateValue, entryIndexAtTick,
  isPoseAdapted, previewDelayMs, resolveReferenceGeometry, reviewCapabilities, setEntryLocked, stableMutationId, timingSummary, totalTicks, updateGlobalScale, updateSequenceEntry,
  runIfDocumentRequestCurrent,
  sanitizeAnimationWorkbenchReturnTo,
} from './model';
import type { DocumentRequestContext, PendingMutation } from './model';
import styles from './animation-workbench.module.css';

type ProjectOption = { id: string; name: string; can_create: boolean };
type BootstrapResponse = { success: true; projects: ProjectOption[]; limits: { max_upload_bytes: number } };
type DocumentsResponse = { success: true; documents: AnimationSummary[]; next_cursor: string | null };
type DocumentResponse = { success: true; document: AnimationDocumentView };
type JobResponse = { success: true; job: AnimationJobView };
type UploadResponse = { success: true; file: AnimationFileInfo; pose?: AnimationPose };
type PoseEdit = { logical_width: string; logical_height: string; pixels_per_unit: string };
type SavedDraft = {
  base_revision: number;
  sequence: AnimationSequence;
  pose_edits: Record<string, PoseEdit>;
  promoted_poses: AnimationPose[];
  saved_at: string;
};
type JobRequest = { kind: AnimationJobKind; parameters: AnimationJobParameters };
type PendingJobSubmission = JobRequest & { mutation_id: string; base_revision: number; payload: string };
type CandidateView = { pose: AnimationPose; file: AnimationFileInfo; origin: string; sourceJobId?: string; sourceVideoFileId?: string; needsAdaptation: boolean };
type PreviewState = { src: string; alt: string; fileName: string; comparison?: ImageComparisonSource };
type ApiFailure = Error & { code?: string; currentRevision?: number; status?: number };
type ContextStateSetter<T> = (value: T | ((previous: T) => T)) => void;

const EMPTY_PROJECTS: ProjectOption[] = [];
const EMPTY_ENTRIES: AnimationEntry[] = [];
const EMPTY_JOBS: AnimationJobView[] = [];

const API_ROOT = '/api/animation';

function safeMessage(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return '请求未能完成，请检查连接后重试。';
  return value.trim()
    .replace(/(?:\/Users|\/Volumes|\/private|\/home|\/tmp|\/srv)\/[^\s"'<>]*/gi, '[本机路径已隐藏]')
    .replace(/[A-Z]:\\[^\s"'<>]*/gi, '[本机路径已隐藏]')
    .replace(/(?:bearer\s+|(?:token|cookie|authorization)\s*[:=]\s*)[^\s,;]+/gi, '[凭据已隐藏]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, 500);
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { cache: 'no-store', ...init });
  } catch {
    throw Object.assign(new Error('网络连接中断，当前操作没有自动重试。'), { code: 'NETWORK' }) as ApiFailure;
  }

  let data: Record<string, unknown> | null = null;
  try { data = await response.json() as Record<string, unknown>; } catch { /* Non-JSON errors are reported by status. */ }
  const error = data?.error && typeof data.error === 'object' ? data.error as Record<string, unknown> : null;
  if (!response.ok || data?.success === false) {
    const failure = new Error(safeMessage(error?.message) || `动画服务暂不可用（HTTP ${response.status}）`) as ApiFailure;
    failure.code = typeof error?.code === 'string' ? error.code : undefined;
    failure.currentRevision = Number.isInteger(error?.current_revision) ? Number(error?.current_revision) : undefined;
    failure.status = response.status;
    throw failure;
  }
  if (!data || data.success !== true) throw new Error(`动画服务返回了无法识别的结果（HTTP ${response.status}）`);
  return data as T;
}

function safeLocalUrl(value: string | null | undefined) {
  if (!value || typeof window === 'undefined') return null;
  try {
    const url = new URL(value, window.location.origin);
    return url.origin === window.location.origin ? `${url.pathname}${url.search}` : null;
  } catch { return null; }
}

function privateFileUrl(documentId: string, fileId: string) {
  return `${API_ROOT}/files/${encodeURIComponent(fileId)}?document_id=${encodeURIComponent(documentId)}`;
}

function privateExportUrl(documentId: string, exportId: string) {
  return `${API_ROOT}/exports/${encodeURIComponent(exportId)}?document_id=${encodeURIComponent(documentId)}`;
}

function draftStorageKey(userId: string, documentId: string) {
  return `sd2:animation-workbench:${encodeURIComponent(userId)}:${encodeURIComponent(documentId)}:draft`;
}

function jobStorageKey(userId: string, documentId: string) {
  return `sd2:animation-workbench:${encodeURIComponent(userId)}:${encodeURIComponent(documentId)}:jobs`;
}

function validSequence(value: unknown): value is AnimationSequence {
  if (!value || typeof value !== 'object') return false;
  const sequence = value as AnimationSequence;
  return sequence.schema_version === 1 && Array.isArray(sequence.entries) && Array.isArray(sequence.poses);
}

function readDraft(userId: string, documentId: string): SavedDraft | null {
  try {
    const raw = localStorage.getItem(draftStorageKey(userId, documentId));
    if (!raw) return null;
    const value = JSON.parse(raw) as SavedDraft;
    if (!Number.isInteger(value.base_revision) || !validSequence(value.sequence)) return null;
    return value;
  } catch { return null; }
}

function displayBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return '大小未知';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = bytes / 1024;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount.toFixed(amount < 10 ? 1 : 0)} ${units[unit]}`;
}

function displayFileName(name: string) {
  const segments = name.replace(/\\/g, '/').split('/').filter(Boolean);
  const leaf = segments[segments.length - 1];
  return safeMessage(leaf || '未命名文件').slice(0, 120);
}

function supportedUploadRole(file: File): 'video' | 'candidate' | null {
  const segments = file.name.toLowerCase().split('.');
  const extension = segments.length > 1 ? segments[segments.length - 1] : '';
  if (extension && extension !== 'png' && extension !== 'mp4') return null;
  if (extension === 'png') return !file.type || file.type === 'image/png' ? 'candidate' : null;
  if (extension === 'mp4') return !file.type || file.type === 'video/mp4' ? 'video' : null;
  if (file.type === 'image/png') return 'candidate';
  if (file.type === 'video/mp4') return 'video';
  return null;
}

function displaySourceVersion(value?: string) {
  const version = value?.trim();
  return version && /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,39}$/.test(version) ? version : version ? '已记录' : '';
}

function formatPoseEdit(pose: AnimationPose): PoseEdit {
  return {
    logical_width: pose.logical_width == null ? '' : String(pose.logical_width),
    logical_height: pose.logical_height == null ? '' : String(pose.logical_height),
    pixels_per_unit: pose.pixels_per_unit == null ? '' : String(pose.pixels_per_unit),
  };
}

function withPoseEdit(pose: AnimationPose, edit?: PoseEdit): AnimationPose {
  if (!edit) return pose;
  const parse = (input: string, fallback: number | null) => {
    if (!input.trim()) return fallback;
    const value = Number(input);
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  return {
    ...pose,
    logical_width: parse(edit.logical_width, pose.logical_width),
    logical_height: parse(edit.logical_height, pose.logical_height),
    pixels_per_unit: parse(edit.pixels_per_unit, pose.pixels_per_unit),
  };
}

function statusLabel(status: AnimationJobView['status']) {
  const labels: Record<AnimationJobView['status'], string> = {
    queued: '排队中', running: '处理中', succeeded: '已完成', failed: '失败', cancelled: '已取消', interrupted: '中断，可恢复',
  };
  return labels[status];
}

function poseFromCandidateFile(file: AnimationFileInfo): AnimationPose {
  return {
    id: `candidate:${file.id}`,
    file_id: file.id,
    label: file.name,
    width: file.width ?? 0,
    height: file.height ?? 0,
    logical_width: null,
    logical_height: null,
    pixels_per_unit: null,
    source: { note: '用户上传的 PNG 候选' },
  };
}

function uniqueById<T extends { id: string }>(values: T[]) {
  return Array.from(new Map(values.map(value => [value.id, value])).values());
}

export default function AnimationWorkbenchClient({
  currentUserId,
  initialDocumentId,
  initialProjectId,
  initialReturnTo,
}: {
  currentUserId: string;
  initialDocumentId?: string;
  initialProjectId?: string;
  initialReturnTo?: string | null;
}) {
  const router = useRouter();
  const returnTo = sanitizeAnimationWorkbenchReturnTo(initialReturnTo);
  const returnLabel = returnTo?.startsWith('/assets') ? '返回资产页' : '返回项目';
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [bootstrapError, setBootstrapError] = useState('');
  const [projectId, setProjectId] = useState(initialProjectId || '');
  const [selectedDocumentId, setSelectedDocumentId] = useState(initialDocumentId || '');
  const [documentLoadNonce, setDocumentLoadNonce] = useState(0);
  const [listStatus, setListStatus] = useState<'active' | 'archived'>('active');
  const [cursorPages, setCursorPages] = useState<string[]>(['']);
  const [summaries, setSummaries] = useState<AnimationSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [document, setDocument] = useState<AnimationDocumentView | null>(null);
  const [documentLoading, setDocumentLoading] = useState(false);
  const [documentError, setDocumentError] = useState('');
  const [sequence, setSequence] = useState<AnimationSequence | null>(null);
  const [baseRevision, setBaseRevision] = useState<number | null>(null);
  const [candidateAdaptations, setCandidateAdaptations] = useState<Record<string, PoseEdit>>({});
  const [promotedPoses, setPromotedPoses] = useState<AnimationPose[]>([]);
  const [pendingLocalDraft, setPendingLocalDraft] = useState<SavedDraft | null>(null);
  const [draftReady, setDraftReady] = useState(false);
  const [localDraftSavedAt, setLocalDraftSavedAt] = useState('');
  const [draftError, setDraftError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [jobRequests, setJobRequests] = useState<Record<string, JobRequest>>({});
  const [pendingJobSubmission, setPendingJobSubmission] = useState<PendingJobSubmission | null>(null);
  const [jobBusy, setJobBusy] = useState(false);
  const [jobError, setJobError] = useState('');
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [uploadRetry, setUploadRetry] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState('');
  const [importRetry, setImportRetry] = useState(false);
  const [taskPollError, setTaskPollError] = useState('');
  const [poseFilter, setPoseFilter] = useState('all');
  const [mobilePanel, setMobilePanel] = useState<'original' | 'candidates' | 'current'>('original');
  const [playheadTick, setPlayheadTick] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [backgroundMode, setBackgroundMode] = useState<'light' | 'dark' | 'checker'>('checker');
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [imageErrors, setImageErrors] = useState<Set<string>>(() => new Set());
  const [selectedVideoId, setSelectedVideoId] = useState('');
  const [frameIndex, setFrameIndex] = useState('0');
  const [reviewStatus, setReviewStatus] = useState<'pending' | 'changes_requested' | 'reported_pass'>('pending');
  const [reviewNote, setReviewNote] = useState('');
  const [gameStatus, setGameStatus] = useState<'unverified' | 'changes_requested' | 'reported_pass'>('unverified');
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState('');
  const [lockError, setLockError] = useState('');
  const [lockBusy, setLockBusy] = useState(false);
  const pendingMutationsRef = useRef(new Map<string, PendingMutation>());
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const pendingUploadRef = useRef(new Map<string, { file: File; role: 'video' | 'candidate'; requestId: string }>());
  const pendingImportRef = useRef<{ file: File; projectId: string; requestId: string } | null>(null);
  const pendingLockRef = useRef(new Map<string, { context: DocumentRequestContext; documentId: string; entryId: string; locked: boolean; payload: string; mutationId: string }>());
  const savingRef = useRef(false);
  const documentRef = useRef(document);
  documentRef.current = document;
  const selectedDocumentRef = useRef(selectedDocumentId);
  const documentContextRef = useRef<DocumentRequestContext>({ documentId: initialDocumentId || '', epoch: 0 });
  const unsavedRef = useRef(false);
  const editorDraftRef = useRef<{ hasLocalChanges: boolean; draft: SavedDraft | null }>({ hasLocalChanges: false, draft: null });

  const projects = bootstrap?.projects ?? EMPTY_PROJECTS;
  const pageCursor = cursorPages[cursorPages.length - 1] || '';
  const uploadsAllowed = bootstrap?.limits.max_upload_bytes ?? 0;
  const sequenceDirty = Boolean(document && sequence && JSON.stringify(sequence) !== JSON.stringify(document.sequence));
  const hasLocalChanges = sequenceDirty || Object.keys(candidateAdaptations).length > 0 || promotedPoses.length > 0;
  const liveEditorDraft: SavedDraft | null = document && sequence ? {
    base_revision: baseRevision ?? document.revision,
    sequence,
    pose_edits: candidateAdaptations,
    promoted_poses: promotedPoses,
    saved_at: localDraftSavedAt || new Date().toISOString(),
  } : null;
  editorDraftRef.current = {
    hasLocalChanges: hasLocalChanges || pendingLocalDraft !== null,
    draft: hasLocalChanges ? liveEditorDraft : pendingLocalDraft ?? liveEditorDraft,
  };
  const revisionMatches = Boolean(document && baseRevision !== null && canSaveAtRevision(baseRevision, document.revision));
  const filesById = useMemo(() => new Map((document?.files ?? []).map(file => [file.id, file])), [document?.files]);

  const captureDocumentContext = useCallback((documentId: string | null = selectedDocumentRef.current) => {
    if (documentId === null) return null;
    const current = documentContextRef.current;
    return current.documentId === documentId && selectedDocumentRef.current === documentId ? current : null;
  }, []);

  const isDocumentContextCurrent = useCallback((context: DocumentRequestContext) => (
    selectedDocumentRef.current === context.documentId
    && runIfDocumentRequestCurrent(context, documentContextRef.current, () => true) === true
  ), []);

  const runInDocumentContext = useCallback(<T,>(context: DocumentRequestContext, effect: () => T) => {
    if (selectedDocumentRef.current !== context.documentId) return undefined;
    return runIfDocumentRequestCurrent(context, documentContextRef.current, effect);
  }, []);

  const commitForDocument = useCallback(<T,>(context: DocumentRequestContext, setter: ContextStateSetter<T>, next: T | ((previous: T) => T)) => {
    setter(previous => {
      if (selectedDocumentRef.current !== context.documentId) return previous;
      return documentRequestStateValue(context, documentContextRef.current, previous, next);
    });
  }, []);

  const captureLoadedDocumentContext = useCallback((documentId: string, currentDocument: AnimationDocumentView | null) => {
    if (!documentId || currentDocument?.id !== documentId || selectedDocumentRef.current !== documentId) return null;
    return captureDocumentContext(documentId);
  }, [captureDocumentContext]);

  const renderedDocumentContext = document && document.id === selectedDocumentId
    ? captureDocumentContext(document.id)
    : null;
  const canMutateEditor = () => Boolean(
    document?.can_edit
    && !lockBusy
    && !savingRef.current
    && revisionMatches
    && renderedDocumentContext
    && isDocumentContextCurrent(renderedDocumentContext),
  );

  const activateDocument = useCallback((documentId: string) => {
    const context = advanceDocumentRequestContext(documentContextRef.current, documentId);
    documentContextRef.current = context;
    selectedDocumentRef.current = documentId;
    setSelectedDocumentId(documentId);
    setDocument(null);
    setSequence(null);
    setBaseRevision(null);
    setCandidateAdaptations({});
    setPromotedPoses([]);
    setPendingLocalDraft(null);
    setDraftReady(false);
    setLocalDraftSavedAt('');
    setDraftError('');
    setDocumentError('');
    setSaveError('');
    setLockError('');
    setReviewError('');
    setUploadError('');
    setUploadRetry(false);
    setImportBusy(false);
    setImportError('');
    setImportRetry(false);
    setJobError('');
    setTaskPollError('');
    setActionMessage('');
    setJobRequests({});
    setPendingJobSubmission(null);
    setDocumentLoading(Boolean(documentId));
    setSaving(false);
    savingRef.current = false;
    setLockBusy(false);
    setUploadBusy(false);
    setJobBusy(false);
    setReviewBusy(false);
    setPreview(null);
    setImageErrors(new Set());
    setSelectedVideoId('');
    setFrameIndex('0');
    setReviewStatus('pending');
    setReviewNote('');
    setGameStatus('unverified');
    setPlayheadTick(0);
    setPlaying(false);
    setPoseFilter('all');
    setMobilePanel('original');
    return context;
  }, []);

  const persistDraft = useCallback((context: DocumentRequestContext | null, draft: SavedDraft | null) => {
    if (!context?.documentId || !isDocumentContextCurrent(context)) return;
    try {
      const key = draftStorageKey(currentUserId, context.documentId);
      if (draft) localStorage.setItem(key, JSON.stringify(draft));
      else localStorage.removeItem(key);
      runInDocumentContext(context, () => commitForDocument(context, setDraftError, ''));
    } catch {
      runInDocumentContext(context, () => commitForDocument(context, setDraftError, '浏览器无法保存本地草稿，请先导出或保存服务端修订。'));
    }
  }, [commitForDocument, currentUserId, isDocumentContextCurrent, runInDocumentContext]);

  const mutationIdFor = useCallback((scope: string, payload: string) => {
    return stableMutationId(pendingMutationsRef.current, scope, payload, () => crypto.randomUUID());
  }, []);

  const refreshDocument = useCallback(async (documentId: string, context: DocumentRequestContext) => {
    if (!isDocumentContextCurrent(context) || context.documentId !== documentId) return null;
    const response = await requestJson<DocumentResponse>(`${API_ROOT}/documents/${encodeURIComponent(documentId)}`);
    if (!isDocumentContextCurrent(context) || response.document.id !== documentId) return null;
    return response.document;
  }, [isDocumentContextCurrent]);

  const syncRoute = useCallback((nextDocumentId: string, nextProjectId: string) => {
    router.replace(animationWorkbenchHref({ documentId: nextDocumentId, projectId: nextProjectId, returnTo }), { scroll: false });
  }, [returnTo, router]);

  useEffect(() => {
    let cancelled = false;
    void requestJson<BootstrapResponse>(`${API_ROOT}/bootstrap`).then(result => {
      if (cancelled) return;
      setBootstrap(result);
      setBootstrapError('');
      setProjectId(current => current || result.projects[0]?.id || '');
    }).catch(error => {
      if (!cancelled) setBootstrapError(safeMessage(error instanceof Error ? error.message : '无法读取动画工作区'));
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setCursorPages(['']);
  }, [projectId, listStatus]);

  useEffect(() => {
    if (selectedDocumentId || !projectId) return;
    const controller = new AbortController();
    setListLoading(true);
    setListError('');
    const params = new URLSearchParams({ project_id: projectId, status: listStatus });
    if (pageCursor) params.set('cursor', pageCursor);
    void requestJson<DocumentsResponse>(`${API_ROOT}/documents?${params.toString()}`, { signal: controller.signal })
      .then(result => {
        setSummaries(result.documents);
        setNextCursor(result.next_cursor);
      })
      .catch(error => {
        if (!controller.signal.aborted) setListError(safeMessage(error instanceof Error ? error.message : '无法读取动画记录'));
      })
      .finally(() => { if (!controller.signal.aborted) setListLoading(false); });
    return () => controller.abort();
  }, [listStatus, pageCursor, projectId, selectedDocumentId]);

  useEffect(() => {
    if (!selectedDocumentId) {
      setDocument(null);
      setSequence(null);
      setBaseRevision(null);
      setCandidateAdaptations({});
      setPromotedPoses([]);
      setPendingLocalDraft(null);
      setDraftReady(false);
      return;
    }
    const context = captureDocumentContext(selectedDocumentId);
    if (!context) return;
    runInDocumentContext(context, () => {
      commitForDocument(context, setDocumentLoading, true);
      commitForDocument(context, setDocumentError, '');
      commitForDocument(context, setLockError, '');
      commitForDocument(context, setSaveError, '');
      commitForDocument(context, setDraftReady, false);
    });
    void requestJson<DocumentResponse>(`${API_ROOT}/documents/${encodeURIComponent(selectedDocumentId)}`)
      .then(result => {
        if (result.document.id !== context.documentId) throw new Error('服务端返回的动画记录与当前请求不匹配');
        const next = result.document;
        runInDocumentContext(context, () => {
          const draft = readDraft(currentUserId, context.documentId);
          commitForDocument(context, setDocument, next);
          commitForDocument(context, setReviewStatus, next.can_manage && next.review_status === 'changes_requested' ? 'changes_requested' : next.can_manage && next.review_status === 'reported_pass' ? 'reported_pass' : 'pending');
          commitForDocument(context, setReviewNote, next.review_note || '');
          commitForDocument(context, setGameStatus, next.game_status);
          if (draft && draft.base_revision !== next.revision) {
            commitForDocument(context, setSequence, next.sequence);
            commitForDocument(context, setBaseRevision, next.revision);
            commitForDocument(context, setCandidateAdaptations, {});
            commitForDocument(context, setPromotedPoses, []);
            commitForDocument(context, setPendingLocalDraft, draft);
          } else if (draft) {
            commitForDocument(context, setSequence, draft.sequence);
            commitForDocument(context, setBaseRevision, draft.base_revision);
            commitForDocument(context, setCandidateAdaptations, draft.pose_edits || {});
            commitForDocument(context, setPromotedPoses, draft.promoted_poses || []);
            commitForDocument(context, setPendingLocalDraft, null);
            commitForDocument(context, setLocalDraftSavedAt, draft.saved_at || '');
          } else {
            commitForDocument(context, setSequence, next.sequence);
            commitForDocument(context, setBaseRevision, next.revision);
            commitForDocument(context, setCandidateAdaptations, {});
            commitForDocument(context, setPromotedPoses, []);
            commitForDocument(context, setPendingLocalDraft, null);
            commitForDocument(context, setLocalDraftSavedAt, '');
          }
          try {
            const rawJobs = localStorage.getItem(jobStorageKey(currentUserId, context.documentId));
            commitForDocument(context, setJobRequests, rawJobs ? JSON.parse(rawJobs) as Record<string, JobRequest> : {});
          } catch { commitForDocument(context, setJobRequests, {}); }
          commitForDocument(context, setDraftReady, true);
        });
      })
      .catch(error => {
        runInDocumentContext(context, () => commitForDocument(context, setDocumentError, safeMessage(error instanceof Error ? error.message : '无法读取动画记录')));
      })
      .finally(() => { runInDocumentContext(context, () => commitForDocument(context, setDocumentLoading, false)); });
  }, [captureDocumentContext, commitForDocument, currentUserId, documentLoadNonce, runInDocumentContext, selectedDocumentId]);

  useEffect(() => {
    if (!selectedDocumentId || !draftReady || !sequence || document?.id !== selectedDocumentId || pendingLocalDraft) return;
    const context = captureLoadedDocumentContext(selectedDocumentId, document);
    if (!context) return;
    const dirty = JSON.stringify(sequence) !== JSON.stringify(document.sequence) || Object.keys(candidateAdaptations).length > 0 || promotedPoses.length > 0;
    if (dirty) {
      const draft: SavedDraft = {
        base_revision: baseRevision ?? document.revision,
        sequence,
        pose_edits: candidateAdaptations,
        promoted_poses: promotedPoses,
        saved_at: new Date().toISOString(),
      };
      persistDraft(context, draft);
    } else {
      persistDraft(context, null);
    }
  }, [baseRevision, candidateAdaptations, captureLoadedDocumentContext, document, draftReady, pendingLocalDraft, persistDraft, promotedPoses, selectedDocumentId, sequence]);

  useEffect(() => {
    if (!selectedDocumentId || !draftReady || document?.id !== selectedDocumentId) return;
    const context = captureLoadedDocumentContext(selectedDocumentId, document);
    if (!context || !isDocumentContextCurrent(context)) return;
    try { localStorage.setItem(jobStorageKey(currentUserId, context.documentId), JSON.stringify(jobRequests)); } catch { /* Task retry details are optional local state. */ }
  }, [captureLoadedDocumentContext, currentUserId, document, draftReady, isDocumentContextCurrent, jobRequests, selectedDocumentId]);

  useEffect(() => {
    unsavedRef.current = hasLocalChanges || saving || lockBusy;
  }, [hasLocalChanges, lockBusy, saving]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!unsavedRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  const saveLocalDraft = useCallback(() => {
    if (!document || !sequence || document.id !== selectedDocumentId) return;
    const context = captureLoadedDocumentContext(document.id, document);
    if (!context) return;
    const draft: SavedDraft = {
      base_revision: baseRevision ?? document.revision,
      sequence,
      pose_edits: candidateAdaptations,
      promoted_poses: promotedPoses,
      saved_at: new Date().toISOString(),
    };
    persistDraft(context, draft);
    setLocalDraftSavedAt(draft.saved_at);
    setActionMessage('本地草稿已保存在此浏览器');
  }, [baseRevision, candidateAdaptations, captureLoadedDocumentContext, document, persistDraft, promotedPoses, selectedDocumentId, sequence]);

  const loadRemoteVersion = useCallback(async (discardLocal: boolean) => {
    const context = document ? captureLoadedDocumentContext(selectedDocumentId, document) : null;
    if (!document || document.id !== selectedDocumentId || !context) return;
    if (discardLocal && hasLocalChanges && !window.confirm('重新加载会放弃当前本地编辑。确定继续吗？')) return;
    try {
      const next = await refreshDocument(context.documentId, context);
      if (!next) return;
      runInDocumentContext(context, () => {
        commitForDocument(context, setDocument, next);
        commitForDocument(context, setSequence, next.sequence);
        commitForDocument(context, setBaseRevision, next.revision);
        commitForDocument(context, setCandidateAdaptations, {});
        commitForDocument(context, setPromotedPoses, []);
        commitForDocument(context, setPendingLocalDraft, null);
        commitForDocument(context, setSaveError, '');
        persistDraft(context, null);
        commitForDocument(context, setActionMessage, '已重新加载服务端修订');
      });
    } catch (error) {
      runInDocumentContext(context, () => commitForDocument(context, setDocumentError, safeMessage(error instanceof Error ? error.message : '重新加载失败')));
    }
  }, [captureLoadedDocumentContext, commitForDocument, document, hasLocalChanges, persistDraft, refreshDocument, runInDocumentContext, selectedDocumentId]);

  const keepLocalDraft = useCallback(() => {
    if (!pendingLocalDraft) return;
    setSequence(pendingLocalDraft.sequence);
    setBaseRevision(pendingLocalDraft.base_revision);
    setCandidateAdaptations(pendingLocalDraft.pose_edits || {});
    setPromotedPoses(pendingLocalDraft.promoted_poses || []);
    setLocalDraftSavedAt(pendingLocalDraft.saved_at || '');
    setPendingLocalDraft(null);
    setActionMessage('已保留本地草稿；修订冲突解决前不会覆盖服务端内容');
  }, [pendingLocalDraft]);

  const saveSequence = useCallback(async () => {
    if (!document || !sequence || document.id !== selectedDocumentId || !document.can_edit || savingRef.current || uploadBusy || !revisionMatches || !sequenceDirty) return;
    const context = captureLoadedDocumentContext(document.id, document);
    if (!context || document.id !== selectedDocumentId) return;
    const bodyWithoutKey = { base_revision: document.revision, sequence };
    const payload = JSON.stringify(bodyWithoutKey);
    const scope = `save:${context.documentId}`;
    const mutationId = mutationIdFor(scope, payload);
    savingRef.current = true;
    commitForDocument(context, setSaving, true);
    commitForDocument(context, setSaveError, '');
    commitForDocument(context, setActionMessage, '');
    try {
      if (document.id !== selectedDocumentId || !isDocumentContextCurrent(context)) return;
      const result = await requestJson<DocumentResponse>(`${API_ROOT}/documents/${encodeURIComponent(context.documentId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...bodyWithoutKey, mutation_id: mutationId }),
      });
      if (result.document.id !== context.documentId) throw new Error('服务端返回的保存结果与当前文档不匹配');
      runInDocumentContext(context, () => {
        clearMutationIfCurrent(pendingMutationsRef.current, scope, mutationId);
        commitForDocument(context, setDocument, result.document);
        commitForDocument(context, setSequence, result.document.sequence);
        commitForDocument(context, setBaseRevision, result.document.revision);
        commitForDocument(context, setCandidateAdaptations, {});
        commitForDocument(context, setPromotedPoses, []);
        commitForDocument(context, setPendingLocalDraft, null);
        commitForDocument(context, setActionMessage, `修订 R${result.document.revision} 已保存`);
        persistDraft(context, null);
      });
    } catch (error) {
      const failure = error as ApiFailure;
      if (!isDocumentContextCurrent(context)) return;
      runInDocumentContext(context, () => commitForDocument(context, setSaveError, safeMessage(failure.message)));
      if (failure.code === 'CONFLICT' || failure.currentRevision != null) {
        try {
          const latest = await requestJson<DocumentResponse>(`${API_ROOT}/documents/${encodeURIComponent(context.documentId)}`);
          if (!isDocumentContextCurrent(context) || latest.document.id !== context.documentId) return;
          runInDocumentContext(context, () => {
            commitForDocument(context, setDocument, latest.document);
            commitForDocument(context, setPendingLocalDraft, {
              base_revision: document.revision,
              sequence,
              pose_edits: candidateAdaptations,
              promoted_poses: promotedPoses,
              saved_at: new Date().toISOString(),
            });
            commitForDocument(context, setSaveError, `服务端已更新到 R${failure.currentRevision ?? latest.document.revision}。本地编辑未覆盖服务端，请保留草稿或重新加载。`);
          });
        } catch { /* Preserve the local editor even when the follow-up read also fails. */ }
      }
    } finally {
      runInDocumentContext(context, () => {
        savingRef.current = false;
        commitForDocument(context, setSaving, false);
      });
    }
  }, [candidateAdaptations, captureLoadedDocumentContext, commitForDocument, document, isDocumentContextCurrent, mutationIdFor, persistDraft, promotedPoses, revisionMatches, runInDocumentContext, selectedDocumentId, sequence, sequenceDirty, uploadBusy]);

  const persistEntryLock = useCallback(async (entryId: string, locked: boolean, retry = false) => {
    if (!document || !sequence || document.id !== selectedDocumentId || !document.can_edit || saving) return;
    const context = captureLoadedDocumentContext(document.id, document);
    if (!context || document.id !== selectedDocumentId) return;
    if (!retry && (sequenceDirty || !revisionMatches || pendingLocalDraft)) {
      setActionMessage(sequenceDirty ? '请先保存当前序列，再单独保存锁帧状态。' : '请先解决服务端修订冲突。');
      return;
    }
    const scope = `lock:${context.documentId}:${entryId}:${locked}`;
    let operation = retry ? pendingLockRef.current.get(context.documentId) ?? null : null;
    if (retry && (!operation || operation.entryId !== entryId || operation.locked !== locked)) return;
    if (operation) operation = { ...operation, context };
    if (!operation || operation.entryId !== entryId || operation.locked !== locked) {
      try {
        const nextSequence = setEntryLocked(sequence, entryId, locked);
        const payload = JSON.stringify({ base_revision: document.revision, sequence: nextSequence });
        operation = { context, documentId: context.documentId, entryId, locked, payload, mutationId: mutationIdFor(scope, payload) };
        pendingLockRef.current.set(context.documentId, operation);
      } catch (error) {
        setActionMessage(safeMessage(error instanceof Error ? error.message : '锁帧状态修改失败'));
        return;
      }
    } else {
      pendingLockRef.current.set(context.documentId, operation);
    }
    commitForDocument(context, setLockBusy, true);
    commitForDocument(context, setLockError, '');
    try {
      if (document.id !== selectedDocumentId || !isDocumentContextCurrent(context)) return;
      const result = await requestJson<DocumentResponse>(`${API_ROOT}/documents/${encodeURIComponent(operation.documentId)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...JSON.parse(operation.payload) as { base_revision: number; sequence: AnimationSequence }, mutation_id: operation.mutationId }),
      });
      if (result.document.id !== context.documentId) throw new Error('服务端返回的锁帧结果与当前文档不匹配');
      runInDocumentContext(context, () => {
        if (pendingLockRef.current.get(context.documentId)?.mutationId === operation.mutationId) pendingLockRef.current.delete(context.documentId);
        clearMutationIfCurrent(pendingMutationsRef.current, scope, operation.mutationId);
        commitForDocument(context, setDocument, result.document);
        commitForDocument(context, setSequence, result.document.sequence);
        commitForDocument(context, setBaseRevision, result.document.revision);
        commitForDocument(context, setActionMessage, locked ? '锁帧状态已单独保存' : '已先单独保存解锁状态，现在可以修改该条目');
      });
    } catch (error) {
      if (!isDocumentContextCurrent(context)) return;
      runInDocumentContext(context, () => commitForDocument(context, setLockError, safeMessage(error instanceof Error ? error.message : '锁帧状态保存失败')));
      const failure = error as ApiFailure;
      if (failure.code === 'CONFLICT' || failure.currentRevision != null) {
        try {
          const latest = await requestJson<DocumentResponse>(`${API_ROOT}/documents/${encodeURIComponent(context.documentId)}`);
          if (!isDocumentContextCurrent(context) || latest.document.id !== context.documentId) return;
          runInDocumentContext(context, () => {
            commitForDocument(context, setDocument, latest.document);
            commitForDocument(context, setSequence, latest.document.sequence);
            commitForDocument(context, setBaseRevision, latest.document.revision);
            commitForDocument(context, setSaveError, '');
            commitForDocument(context, setLockError, `服务端修订已变化，当前已加载 R${failure.currentRevision ?? latest.document.revision}。检查条目状态后可重新操作。`);
            if (pendingLockRef.current.get(context.documentId)?.mutationId === operation.mutationId) pendingLockRef.current.delete(context.documentId);
            clearMutationIfCurrent(pendingMutationsRef.current, scope, operation.mutationId);
          });
        } catch { /* Keep the original lock request available for an exact retry. */ }
      }
    } finally {
      runInDocumentContext(context, () => commitForDocument(context, setLockBusy, false));
    }
  }, [captureLoadedDocumentContext, commitForDocument, document, isDocumentContextCurrent, mutationIdFor, pendingLocalDraft, revisionMatches, runInDocumentContext, saving, selectedDocumentId, sequence, sequenceDirty]);

  const retryEntryLock = useCallback(() => {
    const pending = pendingLockRef.current.get(selectedDocumentId);
    if (pending) void persistEntryLock(pending.entryId, pending.locked, true);
  }, [persistEntryLock, selectedDocumentId]);

  const changeStatus = useCallback(async (status: 'active' | 'archived') => {
    if (!document || document.id !== selectedDocumentId || !document.can_edit || hasLocalChanges || !revisionMatches || lockBusy || saving) return;
    if (status === 'archived' && !window.confirm('归档后该记录会从活跃列表移到已归档列表，可随时恢复。继续吗？')) return;
    const context = captureLoadedDocumentContext(document.id, document);
    if (!context || document.id !== selectedDocumentId) return;
    const scope = `status:${context.documentId}`;
    const payload = JSON.stringify({ base_revision: document.revision, status });
    const mutationId = mutationIdFor(scope, payload);
    try {
      if (document.id !== selectedDocumentId || !isDocumentContextCurrent(context)) return;
      const result = await requestJson<DocumentResponse>(`${API_ROOT}/documents/${encodeURIComponent(context.documentId)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base_revision: document.revision, mutation_id: mutationId, status }),
      });
      if (result.document.id !== context.documentId) throw new Error('服务端返回的状态结果与当前文档不匹配');
      runInDocumentContext(context, () => {
        clearMutationIfCurrent(pendingMutationsRef.current, scope, mutationId);
        commitForDocument(context, setDocument, result.document);
        commitForDocument(context, setBaseRevision, result.document.revision);
        commitForDocument(context, setActionMessage, status === 'archived' ? '已归档' : '已恢复到活跃列表');
      });
    } catch (error) { runInDocumentContext(context, () => commitForDocument(context, setActionMessage, safeMessage(error instanceof Error ? error.message : '状态更新失败'))); }
  }, [captureLoadedDocumentContext, commitForDocument, document, hasLocalChanges, isDocumentContextCurrent, lockBusy, mutationIdFor, revisionMatches, runInDocumentContext, saving, selectedDocumentId]);

  const restoreRevision = useCallback(async (revision: number) => {
    if (!document || document.id !== selectedDocumentId || hasLocalChanges || !revisionMatches || !document.can_edit || lockBusy || saving) return;
    if (!window.confirm(`恢复修订 R${revision} 会生成一个新的服务端修订，不会删除现有历史。继续吗？`)) return;
    const context = captureLoadedDocumentContext(document.id, document);
    if (!context || document.id !== selectedDocumentId) return;
    const scope = `restore:${context.documentId}:${revision}`;
    const payload = JSON.stringify({ base_revision: document.revision, restore_revision: revision });
    try {
      const mutationId = mutationIdFor(scope, payload);
      if (document.id !== selectedDocumentId || !isDocumentContextCurrent(context)) return;
      const result = await requestJson<DocumentResponse>(`${API_ROOT}/documents/${encodeURIComponent(context.documentId)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base_revision: document.revision, mutation_id: mutationId, restore_revision: revision }),
      });
      if (result.document.id !== context.documentId) throw new Error('服务端返回的恢复结果与当前文档不匹配');
      runInDocumentContext(context, () => {
        clearMutationIfCurrent(pendingMutationsRef.current, scope, mutationId);
        commitForDocument(context, setDocument, result.document);
        commitForDocument(context, setSequence, result.document.sequence);
        commitForDocument(context, setBaseRevision, result.document.revision);
        commitForDocument(context, setCandidateAdaptations, {});
        commitForDocument(context, setPromotedPoses, []);
        commitForDocument(context, setActionMessage, `已从 R${revision} 恢复为新修订 R${result.document.revision}`);
        persistDraft(context, null);
      });
    } catch (error) { runInDocumentContext(context, () => commitForDocument(context, setActionMessage, safeMessage(error instanceof Error ? error.message : '恢复修订失败'))); }
  }, [captureLoadedDocumentContext, commitForDocument, document, hasLocalChanges, isDocumentContextCurrent, lockBusy, mutationIdFor, persistDraft, revisionMatches, runInDocumentContext, saving, selectedDocumentId]);

  const uploadFile = useCallback(async (file: File, role: 'video' | 'candidate', retry = false) => {
    if (!document || document.id !== selectedDocumentId || !document.can_edit || saving) return;
    const context = captureLoadedDocumentContext(document.id, document);
    if (!context || document.id !== selectedDocumentId) return;
    if (supportedUploadRole(file) !== role) {
      commitForDocument(context, setUploadError, '仅支持 PNG 图片或 MP4 视频');
      commitForDocument(context, setUploadRetry, false);
      return;
    }
    if (uploadsAllowed > 0 && file.size > uploadsAllowed) {
      commitForDocument(context, setUploadError, `文件 ${displayBytes(file.size)}，超过当前限制 ${displayBytes(uploadsAllowed)}`);
      return;
    }
    const pending = retry && pendingUploadRef.current.get(context.documentId)?.role === role
      ? pendingUploadRef.current.get(context.documentId)!
      : { file, role, requestId: crypto.randomUUID() };
    pendingUploadRef.current.set(context.documentId, pending);
    commitForDocument(context, setUploadBusy, true);
    commitForDocument(context, setUploadError, '');
    commitForDocument(context, setUploadRetry, false);
    try {
      const query = new URLSearchParams({ name: pending.file.name, role: pending.role });
      if (document.id !== selectedDocumentId || !isDocumentContextCurrent(context)) return;
      const result = await requestJson<UploadResponse>(`${API_ROOT}/documents/${encodeURIComponent(context.documentId)}/files?${query.toString()}`, {
        method: 'POST', headers: { 'Content-Type': pending.file.type || 'application/octet-stream', 'X-Request-Id': pending.requestId }, body: pending.file,
      });
      if (pendingUploadRef.current.get(context.documentId) === pending) pendingUploadRef.current.delete(context.documentId);
      runInDocumentContext(context, () => {
        commitForDocument(context, setDocument, previous => previous?.id === context.documentId ? { ...previous, files: uniqueById([...previous.files, result.file]) } : previous);
        if (role === 'video') commitForDocument(context, setSelectedVideoId, result.file.id);
        if (result.pose) commitForDocument(context, setPromotedPoses, current => uniqueById([...current, result.pose as AnimationPose]));
        commitForDocument(context, setActionMessage, `${displayFileName(pending.file.name)} 已登记为${role === 'video' ? 'MP4 视频素材' : 'PNG 候选'}，未自动改动当前序列`);
      });
    } catch (error) {
      runInDocumentContext(context, () => {
        commitForDocument(context, setUploadError, safeMessage(error instanceof Error ? error.message : '文件登记失败'));
        commitForDocument(context, setUploadRetry, true);
      });
    } finally {
      runInDocumentContext(context, () => commitForDocument(context, setUploadBusy, false));
    }
  }, [captureLoadedDocumentContext, commitForDocument, document, isDocumentContextCurrent, runInDocumentContext, saving, selectedDocumentId, uploadsAllowed]);

  const importZip = useCallback(async (file: File, retry = false) => {
    const context = captureDocumentContext('');
    if (!context) return;
    if (!projectId) { setImportError('请先选择项目'); return; }
    const selectedProject = projects.find(project => project.id === projectId);
    if (!selectedProject?.can_create) { setImportError('当前项目暂不允许创建动画记录'); return; }
    if (uploadsAllowed > 0 && file.size > uploadsAllowed) {
      setImportError(`压缩包 ${displayBytes(file.size)}，超过当前限制 ${displayBytes(uploadsAllowed)}`);
      return;
    }
    const pending = retry && pendingImportRef.current?.projectId === projectId
      ? pendingImportRef.current
      : { file, projectId, requestId: crypto.randomUUID() };
    pendingImportRef.current = pending;
    runInDocumentContext(context, () => {
      commitForDocument(context, setImportBusy, true);
      commitForDocument(context, setImportError, '');
      commitForDocument(context, setImportRetry, false);
    });
    try {
      if (!isDocumentContextCurrent(context)) return;
      const result = await requestJson<DocumentResponse>(`${API_ROOT}/import?project_id=${encodeURIComponent(pending.projectId)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/zip', 'X-Request-Id': pending.requestId }, body: pending.file,
      });
      if (!isDocumentContextCurrent(context) || result.document.project_id !== pending.projectId) return;
      if (pendingImportRef.current === pending) pendingImportRef.current = null;
      const importedContext = activateDocument(result.document.id);
      commitForDocument(importedContext, setDocument, result.document);
      commitForDocument(importedContext, setSequence, result.document.sequence);
      commitForDocument(importedContext, setBaseRevision, result.document.revision);
      commitForDocument(importedContext, setActionMessage, '压缩包已导入，原始 hold 保持只读');
      syncRoute(result.document.id, pending.projectId);
      if (zipInputRef.current) zipInputRef.current.value = '';
    } catch (error) {
      runInDocumentContext(context, () => {
        commitForDocument(context, setImportError, safeMessage(error instanceof Error ? error.message : '导入失败'));
        commitForDocument(context, setImportRetry, true);
      });
    } finally {
      runInDocumentContext(context, () => commitForDocument(context, setImportBusy, false));
    }
  }, [activateDocument, captureDocumentContext, commitForDocument, isDocumentContextCurrent, projectId, projects, runInDocumentContext, syncRoute, uploadsAllowed]);

  const submitJob = useCallback(async (request: JobRequest, pending?: PendingJobSubmission) => {
    if (!document || document.id !== selectedDocumentId || !document.can_edit || hasLocalChanges || !revisionMatches || lockBusy) return;
    const context = captureLoadedDocumentContext(document.id, document);
    if (!context || document.id !== selectedDocumentId) return;
    const baseRevisionForSubmission = pending?.base_revision ?? document.revision;
    const payload = pending?.payload ?? JSON.stringify({ base_revision: baseRevisionForSubmission, kind: request.kind, parameters: request.parameters });
    const mutationId = pending?.mutation_id || crypto.randomUUID();
    const submission: PendingJobSubmission = { ...request, mutation_id: mutationId, base_revision: baseRevisionForSubmission, payload };
    commitForDocument(context, setPendingJobSubmission, submission);
    commitForDocument(context, setJobBusy, true);
    commitForDocument(context, setJobError, '');
    try {
      if (document.id !== selectedDocumentId || !isDocumentContextCurrent(context)) return;
      const result = await requestJson<JobResponse>(`${API_ROOT}/documents/${encodeURIComponent(context.documentId)}/jobs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...JSON.parse(payload) as { base_revision: number; kind: AnimationJobKind; parameters: AnimationJobParameters }, mutation_id: mutationId }),
      });
      runInDocumentContext(context, () => {
        commitForDocument(context, setPendingJobSubmission, null);
        commitForDocument(context, setDocument, previous => previous?.id === context.documentId ? { ...previous, jobs: uniqueById([result.job, ...previous.jobs]) } : previous);
        commitForDocument(context, setJobRequests, previous => ({ ...previous, [result.job.id]: request }));
        commitForDocument(context, setTaskPollError, '');
        commitForDocument(context, setActionMessage, request.kind === 'extract' ? '抽帧任务已提交，结果完成后需手动加入候选' : '导出任务已提交，工作台可以离开后再回来查看');
      });
    } catch (error) {
      runInDocumentContext(context, () => commitForDocument(context, setJobError, safeMessage(error instanceof Error ? error.message : '任务提交失败')));
    } finally {
      runInDocumentContext(context, () => commitForDocument(context, setJobBusy, false));
    }
  }, [captureLoadedDocumentContext, commitForDocument, document, hasLocalChanges, isDocumentContextCurrent, lockBusy, revisionMatches, runInDocumentContext, selectedDocumentId]);

  const retryFailedJob = useCallback(async (job: AnimationJobView) => {
    const request = jobRequests[job.id];
    if (!request) {
      setJobError('本机没有保留这项任务的重试参数。请重新选择文件或导出方式后提交。');
      return;
    }
    await submitJob(request);
  }, [jobRequests, submitJob]);

  const cancelJob = useCallback(async (jobId: string) => {
    if (!document || document.id !== selectedDocumentId) return;
    const context = captureLoadedDocumentContext(document.id, document);
    if (!context || document.id !== selectedDocumentId) return;
    commitForDocument(context, setJobError, '');
    try {
      if (!isDocumentContextCurrent(context)) return;
      const result = await requestJson<JobResponse>(`${API_ROOT}/documents/${encodeURIComponent(context.documentId)}/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
      runInDocumentContext(context, () => commitForDocument(context, setDocument, previous => previous?.id === context.documentId ? { ...previous, jobs: uniqueById([result.job, ...previous.jobs]) } : previous));
    } catch (error) { runInDocumentContext(context, () => commitForDocument(context, setJobError, safeMessage(error instanceof Error ? error.message : '取消任务失败'))); }
  }, [captureLoadedDocumentContext, commitForDocument, document, isDocumentContextCurrent, runInDocumentContext, selectedDocumentId]);

  const activeJobSignature = JSON.stringify({
    documentId: document?.id ?? '',
    jobs: (document?.jobs ?? EMPTY_JOBS)
      .filter(job => job.status === 'queued' || job.status === 'running' || job.status === 'interrupted')
      .map(job => [job.id, job.status]),
  });

  useEffect(() => {
    const currentDocument = documentRef.current;
    if (!selectedDocumentId || !currentDocument || currentDocument.id !== selectedDocumentId) return;
    const context = captureDocumentContext(selectedDocumentId);
    if (!context) return;
    const activeIds = currentDocument.jobs
      .filter(job => job.status === 'queued' || job.status === 'running' || job.status === 'interrupted')
      .map(job => job.id);
    if (!activeIds.length) return;
    let cancelled = false;
    let timer: number | undefined;
    const isCurrentDocument = () => !cancelled && isDocumentContextCurrent(context);
    const poll = async () => {
      try {
        const results = await Promise.all(activeIds.map(id => requestJson<JobResponse>(`${API_ROOT}/documents/${encodeURIComponent(selectedDocumentId)}/jobs/${encodeURIComponent(id)}`)));
        if (!isCurrentDocument()) return;
        const nextJobs = results.map(result => result.job);
        const completed = nextJobs.some(job => job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled');
        if (!completed) {
          commitForDocument(context, setDocument, previous => previous?.id === context.documentId
            ? { ...previous, jobs: uniqueById([...nextJobs, ...previous.jobs]) }
            : previous);
          commitForDocument(context, setTaskPollError, '');
        } else {
          try {
            const fresh = await requestJson<DocumentResponse>(`${API_ROOT}/documents/${encodeURIComponent(context.documentId)}`);
            if (isCurrentDocument() && fresh.document.id === context.documentId) {
              commitForDocument(context, setDocument, fresh.document);
              const editor = editorDraftRef.current;
              if (editor.hasLocalChanges && editor.draft) {
                commitForDocument(context, setPendingLocalDraft, editor.draft);
                commitForDocument(context, setSaveError, `服务端已更新到 R${fresh.document.revision}。本地编辑已保留，请另存草稿或重新加载服务端版。`);
              } else {
                commitForDocument(context, setSequence, fresh.document.sequence);
                commitForDocument(context, setBaseRevision, fresh.document.revision);
              }
              commitForDocument(context, setTaskPollError, '');
            }
          } catch (error) {
            if (isCurrentDocument()) {
              commitForDocument(context, setDocument, previous => previous?.id === context.documentId
                ? { ...previous, jobs: uniqueById([...nextJobs, ...previous.jobs]) }
                : previous);
              commitForDocument(context, setTaskPollError, safeMessage(error instanceof Error ? error.message : '任务已结束，但记录详情刷新失败；本地编辑已保留'));
            }
          }
        }
      } catch (error) {
        if (isCurrentDocument()) commitForDocument(context, setTaskPollError, safeMessage(error instanceof Error ? error.message : '任务状态暂时无法刷新'));
      } finally {
        if (isCurrentDocument()) timer = window.setTimeout(() => { void poll(); }, 2500);
      }
    };
    timer = window.setTimeout(() => { void poll(); }, 1200);
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [activeJobSignature, captureDocumentContext, commitForDocument, isDocumentContextCurrent, selectedDocumentId]);

  const entries = sequence?.entries ?? EMPTY_ENTRIES;
  const originalEntries = useMemo(() => document?.sequence.entries.filter(entry => poseFilter === 'all' || entry.action === poseFilter) ?? [], [document?.sequence.entries, poseFilter]);
  const currentEntries = useMemo(() => entries.filter(entry => poseFilter === 'all' || entry.action === poseFilter), [entries, poseFilter]);
  const originalTicks = totalTicks(originalEntries, 'original');
  const currentTicks = totalTicks(currentEntries);
  const timelineTicks = Math.max(originalTicks, currentTicks, 1);
  const activeOriginalIndex = entryIndexAtTick(originalEntries, playheadTick, 'original');
  const activeCurrentIndex = entryIndexAtTick(currentEntries, playheadTick);
  const activeOriginal = activeOriginalIndex >= 0 ? originalEntries[activeOriginalIndex] : null;
  const activeEntry = activeCurrentIndex >= 0 ? currentEntries[activeCurrentIndex] : null;
  const activePose = sequence?.poses.find(pose => pose.id === activeEntry?.pose_id) ?? null;
  const originalFileId = activeOriginal?.reference_file_id || '';
  const originalReferenceFile = filesById.get(originalFileId);
  const resolvedOriginalGeometry = activeOriginal ? resolveReferenceGeometry(activeOriginal, originalReferenceFile) : null;
  const originalGeometry = resolvedOriginalGeometry?.geometry ?? null;
  const currentFileId = activePose?.file_id || '';
  const stageLogicalWidth = Math.max(activePose?.logical_width || 0, originalGeometry?.logical_width || 0, 1);
  const stageLogicalHeight = Math.max(activePose?.logical_height || 0, originalGeometry?.logical_height || 0, 1);
  const actions = useMemo(
    () => Array.from(new Set([...(document?.sequence.entries ?? []), ...(sequence?.entries ?? [])].map(entry => entry.action).filter(Boolean))),
    [document?.sequence.entries, sequence?.entries],
  );
  const candidates = useMemo<CandidateView[]>(() => {
    if (!document || !sequence) return [];
    const poses = uniqueById([
      ...document.sequence.poses,
      ...sequence.poses,
      ...promotedPoses,
      ...document.files.filter(file => file.role === 'candidate').map(poseFromCandidateFile),
    ]);
    return poses.flatMap(pose => {
      const file = filesById.get(pose.file_id);
      if (!file) return [];
      const jobSource = document.jobs.find(job => job.result?.candidate_pose?.id === pose.id);
      const frameIndex = jobSource?.result?.candidate_pose?.source.frame_index ?? pose.source.frame_index;
      const sourceVideoFileId = jobSource?.result?.candidate_pose?.source.video_file_id ?? pose.source.video_file_id;
      const sourceVideo = sourceVideoFileId ? filesById.get(sourceVideoFileId) : undefined;
      const origin = Number.isInteger(frameIndex) && Number(frameIndex) >= 0
        ? `视频第 ${frameIndex} 帧`
        : file.role === 'candidate' ? 'PNG 上传候选' : pose.source.note ? '导入来源记录' : '已有序列 pose';
      return [{ pose, file, origin, sourceJobId: jobSource?.id, sourceVideoFileId: sourceVideo?.role === 'video' ? sourceVideo.id : undefined, needsAdaptation: file.role === 'candidate' || promotedPoses.some(item => item.id === pose.id) }];
    });
  }, [document, filesById, promotedPoses, sequence]);
  const videoFiles = document?.files.filter(file => file.role === 'video') ?? [];

  useEffect(() => {
    const maximum = Math.max(originalTicks, currentTicks);
    if (playheadTick >= maximum) setPlayheadTick(Math.max(0, maximum - 1));
  }, [currentTicks, originalTicks, playheadTick]);

  useEffect(() => {
    if (!playing || timelineTicks <= 0 || !sequence) return;
    const delay = previewDelayMs(1, sequence.preview_fps);
    const timer = window.setInterval(() => setPlayheadTick(tick => (tick + 1) % timelineTicks), delay);
    return () => window.clearInterval(timer);
  }, [playing, sequence, timelineTicks]);

  const openDocument = (documentId: string, nextProjectId = projectId) => {
    activateDocument(documentId);
    syncRoute(documentId, nextProjectId);
  };

  const backToList = () => {
    activateDocument('');
    syncRoute('', projectId);
  };

  const setSequenceEntry = (entryId: string, patch: Parameters<typeof updateSequenceEntry>[2]) => {
    if (!sequence || !canMutateEditor()) return;
    try { setSequence(updateSequenceEntry(sequence, entryId, patch)); }
    catch (error) { setActionMessage(safeMessage(error instanceof Error ? error.message : '条目修改失败')); return; }
    setActionMessage('');
  };

  const selectCurrentEntry = (entry: AnimationEntry, entryIndex: number) => {
    let tick = 0;
    for (let index = 0; index < entryIndex; index += 1) tick += currentEntries[index].hold_ticks;
    setPlayheadTick(tick);
  };

  const stepEntry = (direction: -1 | 1) => {
    if (!currentEntries.length) return;
    const nextIndex = Math.max(0, Math.min(currentEntries.length - 1, activeCurrentIndex + direction));
    selectCurrentEntry(currentEntries[nextIndex], nextIndex);
  };

  const updatePoseEdit = (poseId: string, field: keyof PoseEdit, value: string) => {
    if (!canMutateEditor()) return;
    const candidate = candidates.find(item => item.pose.id === poseId);
    setCandidateAdaptations(previous => ({
      ...previous,
      [poseId]: { ...(previous[poseId] || (candidate ? formatPoseEdit(candidate.pose) : { logical_width: '', logical_height: '', pixels_per_unit: '' })), [field]: value },
    }));
    setActionMessage('');
  };

  const addExtractedPose = (pose: AnimationPose) => {
    if (!canMutateEditor()) return;
    setPromotedPoses(previous => uniqueById([...previous, pose]));
    setActionMessage('抽帧结果已加入候选列表；尚未写入当前序列');
  };

  const assignCandidate = (candidate: CandidateView) => {
    if (!canMutateEditor() || !activeEntry || !sequence || activeEntry.locked) return;
    const adaptedPose = withPoseEdit(candidate.pose, candidateAdaptations[candidate.pose.id]);
    if (!isPoseAdapted(adaptedPose)) {
      setActionMessage('先填写逻辑画布宽高和像素倍率，再加入当前条目');
      return;
    }
    try {
      const sourceWasEdited = Boolean(candidateAdaptations[candidate.pose.id])
        && JSON.stringify(adaptedPose) !== JSON.stringify(candidate.pose);
      setSequence(assignPoseToEntry(sequence, activeEntry.id, adaptedPose, {
        deriveId: sourceWasEdited,
        createId: () => `${candidate.pose.id}:derived:${crypto.randomUUID()}`,
      }));
      setCandidateAdaptations(previous => { const next = { ...previous }; delete next[candidate.pose.id]; return next; });
      setActionMessage('已替换当前 pose，hold 保持原值；保存修订后才会写入服务端');
    } catch (error) { setActionMessage(safeMessage(error instanceof Error ? error.message : 'pose 匹配失败')); }
  };

  const submitExtract = () => {
    if (!selectedVideoId || !/^\d+$/.test(frameIndex)) {
      setJobError('请选择视频并填写非负整数帧号');
      return;
    }
    void submitJob({ kind: 'extract', parameters: { video_file_id: selectedVideoId, frame_index: Number(frameIndex) } });
  };

  const submitReview = async () => {
    if (!document || document.id !== selectedDocumentId || (!document.can_edit && !document.can_manage) || hasLocalChanges || !revisionMatches || lockBusy || saving) return;
    const context = captureLoadedDocumentContext(document.id, document);
    if (!context || document.id !== selectedDocumentId) return;
    commitForDocument(context, setReviewBusy, true);
    commitForDocument(context, setReviewError, '');
    const reviewPayload = {
      base_revision: document.revision,
      review_status: document.can_manage ? reviewStatus : 'pending',
      review_note: reviewNote,
      ...(document.can_manage ? { game_status: gameStatus } : {}),
    };
    const reviewScope = `review:${context.documentId}`;
    try {
      const mutationId = mutationIdFor(reviewScope, JSON.stringify(reviewPayload));
      if (document.id !== selectedDocumentId || !isDocumentContextCurrent(context)) return;
      const result = await requestJson<DocumentResponse>(`${API_ROOT}/documents/${encodeURIComponent(context.documentId)}/review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...reviewPayload, mutation_id: mutationId }),
      });
      if (result.document.id !== context.documentId) throw new Error('服务端返回的回执与当前文档不匹配');
      runInDocumentContext(context, () => {
        clearMutationIfCurrent(pendingMutationsRef.current, reviewScope, mutationId);
        commitForDocument(context, setDocument, result.document);
        commitForDocument(context, setBaseRevision, result.document.revision);
        commitForDocument(context, setReviewStatus, result.document.review_status === 'changes_requested' ? 'changes_requested' : result.document.review_status === 'reported_pass' ? 'reported_pass' : 'pending');
        commitForDocument(context, setReviewNote, result.document.review_note);
        commitForDocument(context, setGameStatus, result.document.game_status);
        commitForDocument(context, setActionMessage, '人工回执已记录，系统未将其当作独立认证');
      });
    } catch (error) { runInDocumentContext(context, () => commitForDocument(context, setReviewError, safeMessage(error instanceof Error ? error.message : '回执记录失败'))); }
    finally { runInDocumentContext(context, () => commitForDocument(context, setReviewBusy, false)); }
  };

  const exportFor = (mode: 'work_copy' | 'validated') => {
    if (!sequence) return;
    if (mode === 'validated' && !canExportValidated(sequence)) {
      setJobError('游戏 tick 率未验证，只能生成明确标注的工作副本');
      return;
    }
    void submitJob({ kind: 'export', parameters: { mode } });
  };

  const onPasteCandidate = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const item = Array.from(event.clipboardData.items).find(candidate => candidate.kind === 'file' && candidate.type === 'image/png');
    const file = item?.getAsFile();
    if (!file) return;
    event.preventDefault();
    void uploadFile(file, 'candidate');
  };

  if (!selectedDocumentId) {
    return (
      <div className={styles.root}>
        <header className={styles.pageHeader}>
          <div><h1>抽帧动画</h1><p>选择项目，继续处理动画记录</p>{returnTo && <a className={styles.textButton} href={returnTo}><ArrowLeft size={14} />{returnLabel}</a>}</div>
          <div className={styles.headerTools}>
            <label className={styles.visuallyHidden} htmlFor="animation-project">项目</label>
            <select id="animation-project" className={styles.select} value={projectId} onChange={event => { activateDocument(''); setProjectId(event.target.value); syncRoute('', event.target.value); }} disabled={!projects.length}>
              {!projects.length && <option value="">暂无可用项目</option>}
              {projects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}
            </select>
          </div>
        </header>

        {bootstrapError && <div className={styles.errorBanner} role="alert"><span>{bootstrapError}</span><button type="button" className={styles.iconButton} title="重试读取" aria-label="重试读取" onClick={() => { setBootstrapError(''); void requestJson<BootstrapResponse>(`${API_ROOT}/bootstrap`).then(setBootstrap).catch(error => setBootstrapError(safeMessage(error instanceof Error ? error.message : '读取失败'))); }}><RotateCcw size={16} /></button></div>}
        {bootstrap && <>
          <div className={styles.listToolbar}>
            <div className={styles.segmented} role="tablist" aria-label="记录状态">
              <button type="button" role="tab" aria-selected={listStatus === 'active'} className={listStatus === 'active' ? styles.segmentActive : ''} onClick={() => setListStatus('active')}>活跃</button>
              <button type="button" role="tab" aria-selected={listStatus === 'archived'} className={listStatus === 'archived' ? styles.segmentActive : ''} onClick={() => setListStatus('archived')}>已归档</button>
            </div>
            <div className={styles.importControls}>
              <span className={styles.uploadLimit}>ZIP 上限 {uploadsAllowed ? displayBytes(uploadsAllowed) : '服务端未提供'}</span>
              <input ref={zipInputRef} className={styles.visuallyHidden} type="file" accept=".zip,application/zip" onChange={event => { const file = event.target.files?.[0]; if (file) void importZip(file); }} />
              <button type="button" className={styles.primaryButton} disabled={!projects.find(project => project.id === projectId)?.can_create || importBusy} onClick={() => zipInputRef.current?.click()}>
                <FileArchive size={16} />{importBusy ? '正在导入' : '导入 ZIP'}
              </button>
            </div>
          </div>
          {importError && <div className={styles.errorBanner} role="alert"><span>{importError}</span>{importRetry && <button type="button" className={styles.textButton} onClick={() => pendingImportRef.current && void importZip(pendingImportRef.current.file, true)}>用同一请求重试</button>}</div>}
          {!projects.find(project => project.id === projectId)?.can_create && <p className={styles.inlineHint}>当前项目只读，不能导入新工作包。</p>}
        </>}

        {listError && <div className={styles.errorBanner} role="alert"><span>{listError}</span><button type="button" className={styles.textButton} onClick={() => { setListError(''); setCursorPages(current => [...current]); }}>重新读取</button></div>}
        {listLoading ? <div className={styles.skeletonRows} aria-label="正在读取动画记录"><i /><i /><i /></div> : summaries.length ? (
          <div className={styles.tableWrap}>
            <table className={styles.documentTable}>
              <thead><tr><th scope="col">封面</th><th scope="col">动画记录</th><th scope="col">当前序列</th><th scope="col">操作者</th><th scope="col">更新时间</th><th scope="col"><span className={styles.visuallyHidden}>操作</span></th></tr></thead>
              <tbody>{summaries.map(summary => {
                const cover = safeLocalUrl(summary.thumbnail_url);
                return <tr key={summary.id}>
                  <td><div className={styles.cover}>{cover ? <>
                    {/* eslint-disable-next-line @next/next/no-img-element -- Same-origin private thumbnails must use the browser session. */}
                    <img src={cover} alt="动画记录封面" loading="lazy" />
                  </> : <span>暂无截图</span>}</div></td>
                  <td><button type="button" className={styles.documentTitle} onClick={() => openDocument(summary.id, summary.project_id)}>{summary.title || '未命名动画'}</button><span className={styles.subtleText}>修订 R{summary.revision} · {summary.entry_count} 条</span></td>
                  <td>{summary.total_ticks} ticks</td>
                  <td><UserIdentityBadge size="sm" user={{ id: summary.id, name: summary.owner_name, avatar_url: summary.owner_avatar }} /></td>
                  <td>{new Date(summary.updated_at).toLocaleString()}</td>
                  <td><button type="button" className={styles.iconButton} title="打开动画记录" aria-label={`打开 ${summary.title}`} onClick={() => openDocument(summary.id, summary.project_id)}><ChevronRight size={18} /></button></td>
                </tr>;
              })}</tbody>
            </table>
          </div>
        ) : !listLoading && !listError && bootstrap && <div className={styles.emptyState}>
          <div className={styles.emptyIcon}><FileArchive size={22} /></div>
          <strong>{projectId ? '这个项目还没有动画记录' : '请选择项目'}</strong>
          <span>{projects.find(project => project.id === projectId)?.can_create ? '导入 ZIP 工作包后即可开始处理。' : '选择一个有权限的项目查看记录。'}</span>
        </div>}

        <footer className={styles.pagination}>
          <span>第 {cursorPages.length} 页</span>
          <div>
            <button type="button" className={styles.iconButton} title="上一页" aria-label="上一页" disabled={cursorPages.length <= 1 || listLoading} onClick={() => setCursorPages(current => current.slice(0, -1))}><ChevronLeft size={18} /></button>
            <button type="button" className={styles.iconButton} title="下一页" aria-label="下一页" disabled={!nextCursor || listLoading} onClick={() => nextCursor && setCursorPages(current => [...current, nextCursor])}><ChevronRight size={18} /></button>
          </div>
        </footer>
      </div>
    );
  }

  if (documentLoading && !document) return <div className={styles.root}><header className={styles.pageHeader}><button type="button" className={styles.backButton} onClick={backToList}><ArrowLeft size={16} />返回列表</button><h1>动画工作台</h1></header><div className={styles.skeletonRows} aria-label="正在读取动画记录"><i /><i /><i /></div></div>;
  if (documentError && !document) return <div className={styles.root}><header className={styles.pageHeader}><button type="button" className={styles.backButton} onClick={backToList}><ArrowLeft size={16} />返回列表</button><h1>动画工作台</h1></header><div className={styles.errorBanner} role="alert"><span>{documentError}</span><button type="button" className={styles.textButton} onClick={() => { activateDocument(selectedDocumentId); setDocumentLoadNonce(value => value + 1); }}>重试</button></div></div>;
  if (!document || !sequence) return null;

  const isEditable = document.can_edit && !lockBusy && !saving;
  const currentPose = activePose;
  const currentFile = currentFileId ? filesById.get(currentFileId) : undefined;
  const originalFile = originalFileId ? filesById.get(originalFileId) : undefined;
  const currentImageErrorKey = `${document.id}:${currentFileId}`;
  const originalImageErrorKey = `${document.id}:${originalFileId}`;
  const currentCoordinateReady = Boolean(currentPose && isPoseAdapted(currentPose));
  const originalStageAspect = resolvedOriginalGeometry
    ? `${stageLogicalWidth} / ${stageLogicalHeight}`
    : originalReferenceFile?.width && originalReferenceFile.height
      ? `${originalReferenceFile.width} / ${originalReferenceFile.height}`
      : undefined;
  const selectedEntryLocked = Boolean(activeEntry?.locked);
  const reviewAccess = reviewCapabilities(document.can_edit, document.can_manage);
  const reviewIsCurrent = document.review_revision === document.revision;
  const latestExport = [...document.exports].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];

  const openImagePreview = (side: 'original' | 'current') => {
    const chosenId = side === 'original' ? originalFileId : currentFileId;
    if (!chosenId) return;
    const comparisonId = side === 'original' ? currentFileId : originalFileId;
    const comparisonFile = comparisonId ? filesById.get(comparisonId) : undefined;
    setPreview({
      src: privateFileUrl(document.id, chosenId),
      alt: side === 'original' ? '原作帧' : '当前序列 PNG',
      fileName: side === 'original' ? originalFile?.name || '原作帧' : currentFile?.name || '当前 PNG',
      comparison: comparisonId ? { src: privateFileUrl(document.id, comparisonId), alt: side === 'original' ? '当前序列 PNG' : '原作帧', fileName: comparisonFile?.name } : undefined,
    });
  };

  const renderStageImage = (side: 'original' | 'current') => {
    const fileId = side === 'original' ? originalFileId : currentFileId;
    const file = side === 'original' ? originalFile : currentFile;
    const geometry = side === 'original' ? originalGeometry : currentPose;
    const entry = side === 'original' ? activeOriginal : activeEntry;
    const imageKey = side === 'original' ? originalImageErrorKey : currentImageErrorKey;
    const missingLabel = side === 'original' ? '原作缺失' : '当前 pose 缺失';
    const canPlace = geometry && [geometry.logical_width, geometry.logical_height, geometry.pixels_per_unit]
      .every(value => Number.isFinite(value) && Number(value) > 0) && file?.width && file?.height;
    const stageScale = 250 / Math.max(stageLogicalWidth, stageLogicalHeight);
    const spriteWidth = canPlace ? (file.width as number) / (geometry.pixels_per_unit as number) * stageScale * (side === 'current' ? sequence.global_scale : 1) : undefined;
    const spriteHeight = canPlace ? (file.height as number) / (geometry.pixels_per_unit as number) * stageScale * (side === 'current' ? sequence.global_scale : 1) : undefined;
    const translateX = side === 'current' ? (entry?.translate_x || 0) * stageScale : 0;
    const translateY = side === 'current' ? (entry?.translate_y || 0) * stageScale : 0;
    const broken = imageErrors.has(imageKey);
    if (!fileId) return <div className={styles.stagePlaceholder}><strong>{missingLabel}</strong><span>{side === 'original' ? '没有原作 PNG，左侧不会用当前图替代。' : '请为当前条目选择一个 pose。'}</span></div>;
    if (broken) return <div className={styles.stagePlaceholder} role="status"><strong>图片暂不可用</strong><span>{file?.name || fileId}</span><button type="button" className={styles.textButton} onClick={() => setImageErrors(previous => { const next = new Set(previous); next.delete(imageKey); return next; })}>重新加载</button></div>;
    return <button type="button" className={styles.spriteButton} title="放大检查图片" onClick={() => openImagePreview(side)} style={{
      width: spriteWidth ? `${spriteWidth}px` : '100%',
      height: spriteHeight ? `${spriteHeight}px` : '100%',
      transform: `translate(calc(-50% + ${translateX}px), calc(-50% + ${translateY}px))`,
    }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- Native source pixels are served by a session-authenticated file route. */}
      <img src={privateFileUrl(document.id, fileId)} alt={side === 'original' ? '原作帧 PNG' : '当前序列 PNG'} draggable={false} onError={() => setImageErrors(previous => new Set(previous).add(imageKey))} />
    </button>;
  };

  const renderTimelineRow = (side: 'original' | 'current') => {
    const rowEntries = side === 'original' ? originalEntries : currentEntries;
    const field: 'original_hold_ticks' | 'hold_ticks' = side === 'original' ? 'original_hold_ticks' : 'hold_ticks';
    let start = 0;
    return <div className={styles.timelineRow} aria-label={side === 'original' ? '原作时值' : '当前序列时值'}>
      <strong>{side === 'original' ? '原作' : '当前'}</strong>
      <div className={styles.timelineTrack}>
        {!rowEntries.length && <span className={styles.timelineEmpty}>无匹配条目</span>}
        {rowEntries.map((entry, index) => {
          const duration = Number.isFinite(entry[field]) && entry[field] > 0 ? entry[field] : 0;
          const width = Math.max(0.6, duration / timelineTicks * 100);
          const offset = start;
          start += duration;
          const selected = side === 'current' ? currentEntries[activeCurrentIndex]?.id === entry.id : originalEntries[activeOriginalIndex]?.id === entry.id;
          return <button key={`${side}-${entry.id}`} type="button" className={`${styles.timelineSegment} ${selected ? styles.timelineSegmentActive : ''}`} style={{ left: `${offset / timelineTicks * 100}%`, width: `${width}%` }} title={`${entry.action} · ${duration} ticks`} aria-label={`${side === 'original' ? '原作' : '当前'}第 ${index + 1} 条，${duration} ticks`} onClick={() => setPlayheadTick(offset)}><span>{duration}</span></button>;
        })}
      </div>
    </div>;
  };

  return (
    <div className={styles.root}>
      <header className={styles.editorHeader}>
        <div className={styles.editorTitleGroup}>
          <button type="button" className={styles.backButton} onClick={backToList}><ArrowLeft size={16} />记录列表</button>
          {returnTo && <a className={styles.backButton} href={returnTo}><ArrowLeft size={16} />{returnLabel}</a>}
          <div><h1>{document.title || '未命名动画'}</h1><span className={styles.subtleText}>修订 R{document.revision} · {document.status === 'active' ? '活跃' : '已归档'}</span></div>
        </div>
        <div className={styles.editorActions}>
          <button type="button" className={styles.secondaryButton} onClick={saveLocalDraft} disabled={!hasLocalChanges || saving}><Save size={15} />另存草稿</button>
          <button type="button" className={styles.primaryButton} onClick={() => void saveSequence()} disabled={!isEditable || !sequenceDirty || !revisionMatches || saving || uploadBusy} title={!revisionMatches ? '服务端修订已变化，请先处理冲突' : uploadBusy ? '文件登记完成后再保存序列' : undefined}><Save size={15} />{saving ? '保存中' : '保存修订'}</button>
          <button type="button" className={styles.secondaryButton} disabled={!document.can_edit || hasLocalChanges || !revisionMatches || lockBusy || saving} onClick={() => void changeStatus(document.status === 'archived' ? 'active' : 'archived')}><Archive size={15} />{document.status === 'archived' ? '恢复活跃' : '归档'}</button>
        </div>
      </header>

      {(documentError || saveError || lockError || actionMessage || draftError) && <div className={saveError || lockError || documentError || draftError ? styles.errorBanner : styles.statusBanner} role={saveError || lockError || documentError || draftError ? 'alert' : 'status'}>
        <span>{saveError || lockError || documentError || draftError || actionMessage}</span>
        {saveError && !pendingLocalDraft && revisionMatches && <button type="button" className={styles.textButton} onClick={() => { setSaveError(''); void saveSequence(); }}>重试同一保存</button>}
        {saveError && !revisionMatches && <button type="button" className={styles.textButton} onClick={() => void loadRemoteVersion(true)}>重新加载服务端版</button>}
        {lockError && <button type="button" className={styles.textButton} disabled={lockBusy} onClick={retryEntryLock}>重试同一锁帧操作</button>}
      </div>}
      {hasLocalChanges && <div className={styles.draftNotice}>
        <span>{localDraftSavedAt ? '本地草稿已保存' : '有未保存内容'}{baseRevision !== null && `，基于 R${baseRevision}`}</span>
        {baseRevision !== null && <small>刷新或离开前会提示；后台任务可继续运行。</small>}
      </div>}
      {pendingLocalDraft && <div className={styles.conflictBanner} role="alert">
        <div><strong>服务端修订已变化</strong><span>本地草稿基于 R{pendingLocalDraft.base_revision}，服务端为 R{document.revision}。不会自动覆盖任一方。</span></div>
        <button type="button" className={styles.secondaryButton} onClick={keepLocalDraft}>保留本地草稿</button>
        <button type="button" className={styles.textButton} onClick={() => void loadRemoteVersion(true)}>重新加载服务端版</button>
      </div>}

      <div className={styles.workbenchToolbar}>
        <label className={styles.filterField}><span>动作筛选</span><select className={styles.select} value={poseFilter} onChange={event => { setPoseFilter(event.target.value); setPlayheadTick(0); }}><option value="all">全部动作</option>{actions.map(action => <option value={action} key={action}>{action}</option>)}</select></label>
        <div className={styles.sequenceFacts}>
          <span>原作 {totalTicks(document.sequence.entries, 'original')} ticks</span><span>当前 {totalTicks(sequence.entries)} ticks</span><span>预览 {sequence.preview_fps} fps</span>
          <span className={sequence.tick_rate_verified && sequence.tick_rate ? styles.verifiedPill : styles.unverifiedPill}>{sequence.tick_rate_verified && sequence.tick_rate ? `已登记 tick 率 ${sequence.tick_rate}` : '游戏 tick 未验证'}</span>
        </div>
      </div>

      <section className={styles.previewSection} aria-label="原作与当前序列同步预览">
        <div className={styles.previewHeader}>
          <div><h2>同步预览</h2><span>{timingSummary(sequence)}</span></div>
          <div className={styles.previewControls}>
            <div className={styles.segmented} role="group" aria-label="预览背景">
              <button type="button" aria-pressed={backgroundMode === 'light'} className={backgroundMode === 'light' ? styles.segmentActive : ''} onClick={() => setBackgroundMode('light')}>浅色</button>
              <button type="button" aria-pressed={backgroundMode === 'dark'} className={backgroundMode === 'dark' ? styles.segmentActive : ''} onClick={() => setBackgroundMode('dark')}>深色</button>
              <button type="button" aria-pressed={backgroundMode === 'checker'} className={backgroundMode === 'checker' ? styles.segmentActive : ''} onClick={() => setBackgroundMode('checker')}>棋盘</button>
            </div>
            <button type="button" className={styles.iconButton} title="上一条" aria-label="上一条" onClick={() => stepEntry(-1)} disabled={!currentEntries.length}><SkipBack size={16} /></button>
            <button type="button" className={styles.iconButton} title={playing ? '暂停' : '播放'} aria-label={playing ? '暂停播放' : '播放'} onClick={() => setPlaying(value => !value)} disabled={!currentEntries.length}>{playing ? <Pause size={16} /> : <Play size={16} />}</button>
            <button type="button" className={styles.iconButton} title="下一条" aria-label="下一条" onClick={() => stepEntry(1)} disabled={!currentEntries.length}><SkipForward size={16} /></button>
          </div>
        </div>
        <div className={styles.previewPair}>
          <section className={styles.previewPane}>
            <div className={styles.previewPaneHeading}><strong>原作</strong><span>{activeOriginal ? `${activeOriginal.action} · ${activeOriginal.original_hold_ticks} ticks` : '无匹配条目'}</span><button type="button" className={styles.iconButton} title="放大检查原作" aria-label="放大检查原作" disabled={!originalFileId} onClick={() => openImagePreview('original')}><RotateCcw size={15} /></button></div>
            <div className={`${styles.stage} ${backgroundMode === 'dark' ? styles.stageDark : backgroundMode === 'checker' ? styles.stageChecker : styles.stageLight}`} style={originalStageAspect ? { aspectRatio: originalStageAspect } : undefined}>
              {renderStageImage('original')}
            </div>
            {!originalFileId ? <span className={styles.stageFootnote}>原作缺失，不使用右侧当前图代替。</span>
              : !resolvedOriginalGeometry
                ? <span className={styles.stageFootnote}>原作映射未适配或与文件尺寸不符；按 PNG 原生宽高独立查看，不作等比例对照。</span>
                : <span className={styles.stageFootnote} title={resolvedOriginalGeometry.source}>原作映射已按文件尺寸校验 · 来源：{resolvedOriginalGeometry.source}</span>}
          </section>
          <section className={styles.previewPane}>
            <div className={styles.previewPaneHeading}><strong>当前序列</strong><span>{activeEntry ? `${activeEntry.action} · ${activeEntry.hold_ticks} ticks` : '无匹配条目'}</span><button type="button" className={styles.iconButton} title="放大检查当前图" aria-label="放大检查当前图" disabled={!currentFileId} onClick={() => openImagePreview('current')}><RotateCcw size={15} /></button></div>
            <div className={`${styles.stage} ${backgroundMode === 'dark' ? styles.stageDark : backgroundMode === 'checker' ? styles.stageChecker : styles.stageLight}`} style={{ aspectRatio: `${stageLogicalWidth} / ${stageLogicalHeight}` }}>
              {renderStageImage('current')}
            </div>
            {!currentFileId ? <span className={styles.stageFootnote}>当前 PNG 缺失。</span> : !currentCoordinateReady && <span className={styles.stageFootnote}>当前 pose 尚未完整适配逻辑画布。</span>}
          </section>
        </div>

        {activeEntry && <div className={styles.selectedEntryControls}>
          <div className={styles.selectedEntryHeading}><strong>{activeEntry.action || '未命名动作'}</strong><span>{activeEntry.locked ? '已锁帧' : '可编辑'}</span>
            <button type="button" className={styles.secondaryButton} disabled={!isEditable || !revisionMatches || sequenceDirty || pendingLocalDraft !== null || lockBusy} title={sequenceDirty ? '先保存序列，再单独保存锁帧状态' : undefined} onClick={() => void persistEntryLock(activeEntry.id, !activeEntry.locked)}>
              {activeEntry.locked ? <UnlockKeyhole size={15} /> : <LockKeyhole size={15} />}{activeEntry.locked ? '解锁' : '锁帧'}
            </button>
          </div>
          <label>动作名称<input type="text" value={activeEntry.action} disabled={!isEditable || !revisionMatches || selectedEntryLocked} onChange={event => setSequenceEntry(activeEntry.id, { action: event.target.value })} /></label>
          <span className={styles.readonlyValue}>当前 hold：{activeEntry.hold_ticks} ticks（导入时值只读）</span>
          <label>横向平移<input type="number" step="any" value={activeEntry.translate_x} disabled={!isEditable || !revisionMatches || selectedEntryLocked} onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value)) setSequenceEntry(activeEntry.id, { translate_x: value }); }} /></label>
          <label>纵向平移<input type="number" step="any" value={activeEntry.translate_y} disabled={!isEditable || !revisionMatches || selectedEntryLocked} onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value)) setSequenceEntry(activeEntry.id, { translate_y: value }); }} /></label>
          <span className={styles.readonlyValue}>原始 hold：{activeEntry.original_hold_ticks} ticks（只读）</span>
        </div>}

        <div className={styles.timelineSummary}><span>时间表按 ticks 对齐，播放按预览 FPS 前进。</span><strong>原作 {originalTicks} · 当前 {currentTicks} ticks</strong><span>播放位置：{Math.min(playheadTick + 1, timelineTicks)} / {timelineTicks} ticks</span></div>
        <div className={styles.timeline}>
          {renderTimelineRow('original')}
          {renderTimelineRow('current')}
        </div>
      </section>

      <div className={styles.mobilePanelTabs} role="group" aria-label="选择素材面板">
        <button type="button" aria-pressed={mobilePanel === 'original'} onClick={() => setMobilePanel('original')}>原条目 <span>{originalEntries.length}</span></button>
        <button type="button" aria-pressed={mobilePanel === 'candidates'} onClick={() => setMobilePanel('candidates')}>候选 <span>{candidates.length}</span></button>
        <button type="button" aria-pressed={mobilePanel === 'current'} onClick={() => setMobilePanel('current')}>当前序列 <span>{currentEntries.length}</span></button>
      </div>

      <section className={styles.threeColumns} data-mobile-panel={mobilePanel} aria-label="动画条目、候选与当前序列">
        <section id="animation-panel-source" className={`${styles.panel} ${styles.sourcePanel}`} data-mobile-active={mobilePanel === 'original' ? 'true' : 'false'} aria-labelledby="source-entries-title">
          <div className={styles.panelHeader}><div><h2 id="source-entries-title">原条目</h2><span>原作 hold 只读</span></div><span className={styles.count}>{originalEntries.length}</span></div>
          <div className={styles.entryList}>
            {originalEntries.map((entry, index) => {
              const selected = activeOriginal?.id === entry.id;
              const sourceFile = entry.reference_file_id ? filesById.get(entry.reference_file_id) : undefined;
              return <button type="button" key={entry.id} className={`${styles.entryRow} ${selected ? styles.entrySelected : ''}`} onClick={() => { let tick = 0; for (let i = 0; i < index; i += 1) tick += originalEntries[i].original_hold_ticks; setPlayheadTick(tick); }}>
                <span className={styles.entryThumb}>{sourceFile ? <>
                  {/* eslint-disable-next-line @next/next/no-img-element -- Private animation files require the browser's authenticated request. */}
                  <img src={privateFileUrl(document.id, sourceFile.id)} alt="" loading="lazy" />
                </> : <span>原作缺失</span>}</span>
                <span className={styles.entryCopy}><strong>{entry.action || '未命名动作'}</strong><small>第 {index + 1} 条 · {entry.original_hold_ticks} ticks</small></span>
                <span className={styles.readonlyTag}>只读</span>
              </button>;
            })}
            {!originalEntries.length && <div className={styles.inlineEmpty}>没有符合筛选的原条目</div>}
          </div>
        </section>

        <section id="animation-panel-candidates" className={`${styles.panel} ${styles.candidatePanel}`} data-mobile-active={mobilePanel === 'candidates' ? 'true' : 'false'} aria-labelledby="candidate-title" onPaste={onPasteCandidate}>
          <div className={styles.panelHeader}><div><h2 id="candidate-title">候选</h2><span>先适配逻辑画布，再加入当前条目</span></div><span className={styles.count}>{candidates.length}</span></div>
          <div className={styles.candidateTools}>
            <input ref={uploadInputRef} className={styles.visuallyHidden} type="file" accept="image/png,.png,video/mp4,.mp4" onChange={event => { const file = event.target.files?.[0]; if (file) { const role = supportedUploadRole(file); if (role) void uploadFile(file, role); else { setUploadError('仅支持 PNG 图片或 MP4 视频'); setUploadRetry(false); } } event.target.value = ''; }} />
            <button type="button" className={styles.secondaryButton} onClick={() => uploadInputRef.current?.click()} disabled={!isEditable || uploadBusy}><Upload size={15} />上传 PNG / MP4</button>
            {uploadBusy && <span className={styles.inlineHint}>正在上传文件</span>}
            {uploadError && <div className={styles.errorInline} role="alert"><span>{uploadError}</span>{uploadRetry && pendingUploadRef.current.get(document.id) && <button type="button" className={styles.textButton} disabled={!isEditable} onClick={() => { const pending = pendingUploadRef.current.get(document.id); if (pending) void uploadFile(pending.file, pending.role, true); }}>重试同一上传</button>}</div>}
          </div>
          {videoFiles.length > 0 && <div className={styles.extractForm}>
            <label><Video size={14} /><span className={styles.visuallyHidden}>选择 MP4 素材</span><select className={styles.select} value={selectedVideoId || videoFiles[0].id} onChange={event => setSelectedVideoId(event.target.value)}><option value="">选择 MP4</option>{videoFiles.map(file => <option value={file.id} key={file.id}>{displayFileName(file.name)}</option>)}</select></label>
            <label><span>帧号</span><input className={styles.numberInput} inputMode="numeric" type="number" min="0" step="1" value={frameIndex} onChange={event => setFrameIndex(event.target.value)} /></label>
            <button type="button" className={styles.iconButton} title="从 MP4 提取指定帧" aria-label="从 MP4 提取帧" disabled={!isEditable || jobBusy || hasLocalChanges} onClick={submitExtract}><ImagePlus size={16} /></button>
          </div>}
          <div className={styles.candidateList}>
            {candidates.map(candidate => {
              const edit = candidateAdaptations[candidate.pose.id] || formatPoseEdit(candidate.pose);
              const prepared = isPoseAdapted(withPoseEdit(candidate.pose, edit));
              const isCurrent = activeEntry?.pose_id === candidate.pose.id;
              const candidateName = displayFileName(candidate.file.name);
              return <article className={`${styles.candidateItem} ${isCurrent ? styles.candidateSelected : ''}`} key={candidate.pose.id}>
                <button type="button" className={styles.candidatePreview} title="放大检查 PNG" onClick={() => setPreview({ src: privateFileUrl(document.id, candidate.file.id), alt: displayFileName(candidate.pose.label), fileName: candidateName })}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- Private animation files require the browser's authenticated request. */}
                  <img src={privateFileUrl(document.id, candidate.file.id)} alt="" loading="lazy" onError={() => setImageErrors(previous => new Set(previous).add(`${document.id}:${candidate.file.id}`))} />
                </button>
                <div className={styles.candidateBody}>
                  <strong title={candidateName}>{candidateName}</strong>
                  <span>{candidate.origin}{displaySourceVersion(candidate.pose.source.version) ? ` · 来源版本 ${displaySourceVersion(candidate.pose.source.version)}` : ''}{candidate.pose.source.frame_index == null && candidate.pose.source.pts_seconds != null && Number.isFinite(candidate.pose.source.pts_seconds) ? ` · 源视频时间 ${candidate.pose.source.pts_seconds.toFixed(2)} 秒` : ''}</span>
                  <small>{candidate.pose.width || candidate.file.width || '?'} × {candidate.pose.height || candidate.file.height || '?'} px · {candidate.needsAdaptation ? '需适配' : '已有 pose'}</small>
                  {candidate.sourceJobId && <a className={styles.textButton} href={`#animation-job-${encodeURIComponent(candidate.sourceJobId)}`}>查看来源任务</a>}
                  {candidate.sourceVideoFileId && <a className={styles.textButton} href={privateFileUrl(document.id, candidate.sourceVideoFileId)} target="_blank" rel="noreferrer">打开来源 MP4</a>}
                  {candidate.needsAdaptation && <div className={styles.poseAdaptation}>
                    <label>逻辑宽<input aria-label={`${candidateName} 逻辑宽`} type="number" min="0.01" step="any" value={edit.logical_width} disabled={!isEditable || !revisionMatches} onChange={event => updatePoseEdit(candidate.pose.id, 'logical_width', event.target.value)} /></label>
                    <label>逻辑高<input aria-label={`${candidateName} 逻辑高`} type="number" min="0.01" step="any" value={edit.logical_height} disabled={!isEditable || !revisionMatches} onChange={event => updatePoseEdit(candidate.pose.id, 'logical_height', event.target.value)} /></label>
                    <label>像素倍率<input aria-label={`${candidateName} 像素倍率`} type="number" min="0.01" step="any" value={edit.pixels_per_unit} disabled={!isEditable || !revisionMatches} onChange={event => updatePoseEdit(candidate.pose.id, 'pixels_per_unit', event.target.value)} /></label>
                  </div>}
                  <button type="button" className={styles.textButton} disabled={!isEditable || !activeEntry || selectedEntryLocked || !prepared} title={selectedEntryLocked ? '先解锁当前条目' : !prepared ? '先补齐逻辑画布与像素倍率' : undefined} onClick={() => assignCandidate(candidate)}>{isCurrent ? '当前使用中' : '用于当前条目'}</button>
                </div>
              </article>;
            })}
            {!candidates.length && <div className={styles.inlineEmpty}>上传 PNG 或 MP4 后，可将 PNG 适配并用于当前条目；也可从 MP4 指定帧号提取。图片可在此区域按 Ctrl+V 粘贴。</div>}
          </div>
        </section>

        <section id="animation-panel-current" className={`${styles.panel} ${styles.currentPanel}`} data-mobile-active={mobilePanel === 'current' ? 'true' : 'false'} aria-labelledby="current-sequence-title">
          <div className={styles.panelHeader}><div><h2 id="current-sequence-title">当前序列</h2><span>锁帧后须先解锁再修改</span></div><span className={styles.count}>{currentEntries.length}</span></div>
          <div className={styles.sequenceControls}>
            <label>全段缩放<input type="number" min="0.01" step="any" value={sequence.global_scale} disabled={!isEditable || !revisionMatches || !canChangeGlobalScale(sequence)} title={!canChangeGlobalScale(sequence) ? '全段缩放会影响锁帧条目，请先解锁' : undefined} onChange={event => { const value = Number(event.target.value); if (!Number.isFinite(value) || value <= 0) return; try { setSequence(current => current ? updateGlobalScale(current, value) : current); } catch (error) { setActionMessage(safeMessage(error instanceof Error ? error.message : '全段缩放失败')); } }} /></label>
            <label>预览 FPS<select value={sequence.preview_fps} disabled={!isEditable || !revisionMatches} onChange={event => setSequence(current => current ? { ...current, preview_fps: Number(event.target.value) } : current)}><option value={12}>12</option><option value={24}>24</option><option value={30}>30</option><option value={60}>60</option></select></label>
          </div>
          {!canChangeGlobalScale(sequence) && <span className={styles.inlineHint}>存在锁帧条目，全段缩放已停用；先逐条解锁后再调整。</span>}
          <div className={styles.entryList}>
            {currentEntries.map((entry, index) => {
              const selected = activeEntry?.id === entry.id;
              const pose = sequence.poses.find(item => item.id === entry.pose_id);
              const file = pose ? filesById.get(pose.file_id) : undefined;
              return <button type="button" key={entry.id} className={`${styles.entryRow} ${selected ? styles.entrySelected : ''}`} onClick={() => selectCurrentEntry(entry, index)}>
                <span className={styles.entryThumb}>{file ? <>
                  {/* eslint-disable-next-line @next/next/no-img-element -- Private animation files require the browser's authenticated request. */}
                  <img src={privateFileUrl(document.id, file.id)} alt="" loading="lazy" />
                </> : <span>PNG 缺失</span>}</span>
                <span className={styles.entryCopy}><strong>{entry.action || '未命名动作'}</strong><small>第 {index + 1} 条 · {entry.hold_ticks} ticks</small></span>
                <span className={entry.locked ? styles.lockIndicator : styles.editIndicator} title={entry.locked ? '已锁定' : '未锁定'}>{entry.locked ? <LockKeyhole size={14} /> : <UnlockKeyhole size={14} />}</span>
              </button>;
            })}
            {!currentEntries.length && <div className={styles.inlineEmpty}>没有符合筛选的当前条目</div>}
          </div>
        </section>
      </section>

      <section className={styles.deliveryGrid}>
        <section className={styles.deliveryPanel}>
          <div className={styles.panelHeader}><div><h2>导出结果</h2><span>工作副本与技术校验包分开</span></div></div>
          <div className={styles.exportActions}>
            <button type="button" className={styles.secondaryButton} disabled={!isEditable || !revisionMatches || hasLocalChanges || jobBusy} onClick={() => exportFor('work_copy')}><Download size={15} />生成工作副本</button>
            <button type="button" className={styles.secondaryButton} disabled={!isEditable || !revisionMatches || hasLocalChanges || jobBusy || !canExportValidated(sequence)} title={!canExportValidated(sequence) ? '游戏 tick 率未验证，不能生成技术校验包' : undefined} onClick={() => exportFor('validated')}><Check size={15} />生成技术校验包</button>
            {!canExportValidated(sequence) && <span className={styles.inlineHint}>tick 率未知时只能导出工作副本。</span>}
          </div>
          {jobError && <div className={styles.errorInline} role="alert"><span>{jobError}</span>{pendingJobSubmission && <button type="button" className={styles.textButton} onClick={() => void submitJob(pendingJobSubmission, pendingJobSubmission)}>重试同一提交</button>}</div>}
          {taskPollError && <div className={styles.errorInline} role="status"><span>{taskPollError}</span><button type="button" className={styles.textButton} onClick={() => setTaskPollError('')}>知道了</button></div>}
          <div className={styles.jobList}>
            {document.jobs.map(job => {
              const request = jobRequests[job.id];
              const candidatePose = job.result?.candidate_pose;
              return <article className={styles.jobRow} id={`animation-job-${encodeURIComponent(job.id)}`} key={job.id}>
                <div className={styles.jobHeading}><strong>{job.kind === 'extract' ? '视频抽帧' : job.result?.export_id ? '导出任务' : '序列处理'}</strong><span className={job.status === 'failed' || job.status === 'interrupted' ? styles.statusWarning : styles.statusQuiet}>{statusLabel(job.status)}</span></div>
                <span className={styles.jobStage}>输入修订 R{job.revision} · {job.stage || '等待服务端阶段信息'}</span>
                {job.error && <p className={styles.jobError}>{safeMessage(job.error)}</p>}
                {job.status === 'running' || job.status === 'queued' ? <button type="button" className={styles.textButton} onClick={() => void cancelJob(job.id)}>取消任务</button> : null}
                {(job.status === 'failed' || job.status === 'interrupted') && request && <button type="button" className={styles.textButton} disabled={jobBusy || hasLocalChanges || !revisionMatches} onClick={() => void retryFailedJob(job)}>重试此任务</button>}
                {candidatePose && <div className={styles.extractedCandidate}><span>已取得帧候选：{displayFileName(candidatePose.label)} · {candidatePose.source.frame_index ?? '?'} 帧</span><button type="button" className={styles.textButton} disabled={!isEditable || promotedPoses.some(pose => pose.id === candidatePose.id)} onClick={() => addExtractedPose(candidatePose)}>{promotedPoses.some(pose => pose.id === candidatePose.id) ? '已加入候选' : '加入候选'}</button></div>}
                {job.result?.export_id && <a className={styles.textButton} href={privateExportUrl(document.id, job.result.export_id)}>下载导出包</a>}
              </article>;
            })}
            {!document.jobs.length && <div className={styles.inlineEmpty}>暂无后台任务</div>}
          </div>
          {!!document.exports.length && <div className={styles.exportList}>
            <h3>可下载结果</h3>
            {document.exports.map((item: AnimationExportView) => <div className={styles.exportRow} key={item.id}>
              <div><strong>{item.mode === 'work_copy' ? '工作副本' : '技术校验包'}</strong><span>源修订 R{item.revision} · {item.entry_count} 条 · {item.total_ticks} ticks · {displayBytes(item.bytes)}</span></div>
              <a className={styles.iconButton} href={privateExportUrl(document.id, item.id)} title="受控下载" aria-label={`下载修订 R${item.revision} 导出包`}><Download size={16} /></a>
            </div>)}
          </div>}
          <div className={styles.exportChecks}>
            <div><span>素材检查</span><strong>{latestExport?.warnings.length ? `${latestExport.warnings.length} 条提示` : '暂无独立检查回执'}</strong></div>
            <div><span>导出文件</span><strong>{latestExport ? `R${latestExport.revision} · ${displayBytes(latestExport.bytes)}` : '尚无导出包'}</strong></div>
          </div>
        </section>

        <section className={styles.deliveryPanel}>
          <div className={styles.panelHeader}><div><h2>留存与审核</h2><span>各类认可和回执互不替代</span></div></div>
          <label className={styles.retentionCheck}><input type="checkbox" checked={sequence.user_accepted_for_retention} disabled={!isEditable || !revisionMatches} onChange={event => setSequence(current => current ? { ...current, user_accepted_for_retention: event.target.checked } : current)} /><span>我认可留存当前素材</span></label>
          <div className={styles.reviewFacts}>
            <div><span>人工审核回执</span><strong>{document.review_status === 'unsubmitted' ? '未提交' : document.review_status === 'pending' ? '待处理' : document.review_status === 'changes_requested' ? '要求修改' : reviewIsCurrent ? '人工记录为通过' : '旧修订回执已失效'}</strong><small>人工记录，不是系统独立认证{document.review_revision != null ? ` · 关联 R${document.review_revision}` : ''}</small></div>
            <div><span>游戏导入</span><strong>{document.game_status === 'unverified' ? '未验证' : document.game_status === 'changes_requested' ? '记录为需修改' : '人工记录为通过'}</strong><small>tick 率登记不等于游戏验收；未提供实际运行证据时，不代表游戏可用。</small></div>
            <div><span>留存认可</span><strong>{sequence.user_accepted_for_retention ? '已记录' : '未记录'}</strong><small>随序列修订保存，不等同审核或游戏验证。</small></div>
          </div>
          <div className={styles.reviewForm}>
            {reviewAccess.canRecordOutcome
              ? <label>审核回执<select value={reviewStatus} disabled={hasLocalChanges || !revisionMatches || reviewBusy || lockBusy || saving} onChange={event => setReviewStatus(event.target.value as typeof reviewStatus)}><option value="pending">待处理</option><option value="changes_requested">要求修改</option><option value="reported_pass">人工记录为通过</option></select></label>
              : <div className={styles.reviewPermissionNote}><strong>提交审核</strong><span>当前操作只会提交为待审核；处理结果由具备权限的人员登记。</span></div>}
            {reviewAccess.canRecordGameStatus
              ? <label>游戏导入记录<select value={gameStatus} disabled={hasLocalChanges || !revisionMatches || reviewBusy || lockBusy || saving} onChange={event => setGameStatus(event.target.value as typeof gameStatus)}><option value="unverified">未验证</option><option value="changes_requested">记录为需修改</option><option value="reported_pass">人工记录为通过</option></select></label>
              : <div className={styles.reviewPermissionNote}><strong>游戏导入：{document.game_status === 'unverified' ? '未验证' : document.game_status === 'changes_requested' ? '记录为需修改' : '人工记录为通过'}</strong><span>游戏状态由具备权限的人员登记；人工记录不等同独立认证。</span></div>}
            <label className={styles.reviewNoteField}>{reviewAccess.canRecordOutcome ? '人工审核备注' : '提交说明'}<textarea rows={3} maxLength={2000} value={reviewNote} disabled={!reviewAccess.canSubmit || hasLocalChanges || !revisionMatches || reviewBusy || lockBusy || saving} onChange={event => setReviewNote(event.target.value)} /></label>
            <button type="button" className={styles.secondaryButton} disabled={!reviewAccess.canSubmit || hasLocalChanges || !revisionMatches || reviewBusy || lockBusy || saving} onClick={() => void submitReview()}>{reviewBusy ? '正在提交' : reviewAccess.canRecordOutcome && reviewStatus !== 'pending' ? '记录人工回执' : '提交待审'}</button>
            {reviewError && <span className={styles.errorInline} role="alert">{reviewError}</span>}
          </div>
        </section>
      </section>

      <section className={styles.historyPanel}>
        <div className={styles.panelHeader}><div><h2>历史修订</h2><span>恢复会创建新修订，不覆盖历史</span></div><button type="button" className={styles.iconButton} title="重新加载服务端" aria-label="重新加载服务端" onClick={() => void loadRemoteVersion(true)}><RotateCcw size={16} /></button></div>
        <div className={styles.revisionList}>
          {[...document.revisions].sort((a, b) => b.revision - a.revision).map(revision => <div className={styles.revisionRow} key={revision.revision}>
            <strong>R{revision.revision}{revision.revision === document.revision ? ' · 当前' : ''}</strong><span>{new Date(revision.created_at).toLocaleString()}</span>
            {revision.revision !== document.revision && <button type="button" className={styles.textButton} disabled={!document.can_edit || hasLocalChanges || !revisionMatches || lockBusy || saving} onClick={() => void restoreRevision(revision.revision)}>恢复此修订</button>}
          </div>)}
          {!document.revisions.length && <div className={styles.inlineEmpty}>服务端尚未提供修订历史</div>}
        </div>
      </section>

      {preview && <ZoomableImagePreview
        src={preview.src} alt={preview.alt} fileName={preview.fileName}
        title="PNG 放大检查" previewKey={`${document.id}:${preview.src}`}
        comparison={preview.comparison} onClose={() => setPreview(null)}
      />}
    </div>
  );
}
