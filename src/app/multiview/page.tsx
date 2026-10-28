'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, ArrowRight, Copy, Download, Expand, Film, History, Images, Pencil, RefreshCw, Undo2, WandSparkles, X } from 'lucide-react';
import { DndContext, KeyboardCode, KeyboardSensor, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import PageBanner from '@/components/PageBanner';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';
import { VideoLoopButton } from '@/components/VideoLoopButton';
import { useProductDialog } from '@/components/useProductDialog';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { ProductActionMenu } from '@/components/ProductActionMenu';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { useUnsavedNavigation } from '@/lib/hooks/use-unsaved-navigation';
import { useVideoLoopState } from '@/lib/hooks/use-media-preview-state';
import { copyPngBlob } from '@/lib/media/copy-image';
import type { LocalFrameContext } from '@/lib/media/image-read-session';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import { candidateFrames, DEFAULT_MULTIVIEW_LAYOUT, multiviewDimensions, parseMultiviewDraft,
  type MultiviewDraft, type MultiviewInfo, type MultiviewSlot } from '@/lib/video/multiview-contract';
import { MultiviewGenerationPanel, type MultiviewGenerationPanelState, type MultiviewGenerationReady } from './MultiviewGenerationPanel';
import { MultiviewSourcePicker } from './MultiviewSourcePicker';
import { MultiviewWorks } from './MultiviewWorks';
import { MultiviewRecords } from './MultiviewRecords';
import { MultiviewReferenceComposer } from './MultiviewReferenceComposer';
import { MultiviewShareDialog } from './MultiviewShareDialog';
import { useMultiviewShareOperation } from './useMultiviewShareOperation';
import { MultiviewFrameSettingsPanel } from './MultiviewFrameSettingsPanel';
import { encodeMultiviewPreviewFrame } from './multiview-preview-image';
import { MultiviewFrameImage } from './MultiviewFrameImage';
import { MultiviewFrameControls } from './MultiviewFrameControls';
import { MultiviewGenerationProgress } from './MultiviewGenerationProgress';
import type { MultiviewScrubSession } from './multiview-frame-scrub';
import { createMultiviewOriginalQueue } from './multiview-original-queue';
import { appliedWorkRecipe, useMultiviewWork } from './useMultiviewWork';
import { multiviewWorkRecipesEqual, type MultiviewWorkDto, type MultiviewWorkRecipe } from '@/lib/video/multiview-work-contract';
import { parseMultiviewSettingsBinding, type MultiviewSettingsBinding } from '@/lib/video/multiview-settings-contract';
import { createMultiviewLatestTargetGate, multiviewPreviewChunkIndex, multiviewPreviewRetainedChunks,
  type MultiviewPreviewManifest } from '@/lib/video/multiview-preview-contract';
import styles from './multiview.module.css';

type FrameState = { url?: string; blob?: Blob; localFrame?: LocalFrameContext; originalBytes?: number; previewUrl?: string; previewError?: string; error?: string; loading?: boolean };
const ORIGINAL_MEMORY_LIMIT = 256 * 1024 * 1024;
type PreviewState = { manifest: MultiviewPreviewManifest | null; urls: Record<number, string>; loading: boolean; error: string };
type Artifact = { blob: Blob; url: string; name: string; key: string; format: 'png' | 'zip'; slots: MultiviewSlot[] };
type ArtifactOperation = { token: symbol; generation: number; controller: AbortController; key: string;
  owner: string; authority: string; taskId: string; mediaBase: string; version: string; format: 'png' | 'zip'; slots: MultiviewSlot[]; layout: MultiviewDraft['layout'] };
type ViewPreferences = { tab: 'frames' | 'layout'; selected: string; zoom: number; time: number; x: number; y: number; panX: number; panY: number; originalOpen: boolean; frameSettingsBinding?: MultiviewSettingsBinding };
type SlotDrag = { id: string; generation: number; sourceKey: string; draft: MultiviewDraft };
type SortableImageBinding = Pick<ReturnType<typeof useSortable>, 'attributes' | 'listeners' | 'setActivatorNodeRef'>;
function SortableFrame({ id, disabled, children }: { id: string; disabled: boolean; children: (binding: SortableImageBinding) => ReactNode }) {
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  return <figure ref={setNodeRef} className={styles.frameCell} data-mv-slot={id} data-dragging={isDragging || undefined}
    style={{ transform: CSS.Transform.toString(transform), transition }}>{children({ attributes, listeners, setActivatorNodeRef })}</figure>;
}
function AtlasFrame({ manifest, url, frame, alt, className }: { manifest: MultiviewPreviewManifest; url: string; frame: number; alt: string; className?: string }) {
  const local = frame % manifest.chunkSize;
  const column = local % manifest.columns;
  const row = Math.floor(local / manifest.columns);
  return <span role="img" aria-label={alt} className={className || styles.atlasFrame} style={{
    backgroundImage: `url(${url})`, backgroundSize: `${manifest.columns * 100}% ${manifest.rows * 100}%`,
    backgroundPosition: `${column / (manifest.columns - 1) * 100}% ${row / (manifest.rows - 1) * 100}%`,
  }} />;
}
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
  return JSON.stringify([owner, taskId, draft.sourceVersion, slots.map(item => [item.frame, item.name, Boolean(item.locked)]), draft.layout, format]);
}
const editingSignature = (draft: MultiviewDraft) => JSON.stringify([draft.slots, draft.reserve, draft.layout, draft.restoreOrder]);
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
      panY: Number.isFinite(value.panY) ? Math.max(0, Math.min(100000, value.panY)) : 0, originalOpen: value.originalOpen === true,
      frameSettingsBinding: parseMultiviewSettingsBinding(value.frameSettingsBinding) || undefined };
  } catch { return emptyView(); }
}

function MultiviewPageContent() {
  const query = useSearchParams();
  const explicitTask = query.get('taskId') || '';
  const shareId = query.get('shareId') || '';
  const [shared, setShared] = useState<{ id: string; title: string; revision: number; sourceTaskId: string; sourceVersion: string; generation: string; info: MultiviewInfo; recipe: MultiviewWorkRecipe } | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [pageView, setPageView] = useState<'editor' | 'generations' | 'works'>(() => query.get('view') === 'works'
    ? 'works' : query.get('view') === 'generations' ? 'generations' : 'editor');
  const [editorWork, setEditorWork] = useState({ owner: '', id: '' });
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
  const [draftEdited, setDraftEdited] = useState(false);
  const [retainedDraft, setRetainedDraft] = useState('');
  const [viewSaved, setViewSaved] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportFile, setExportFile] = useState<Artifact | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const [copyingFrame, setCopyingFrame] = useState('');
  const frameCopy = useRef<{ token: symbol; slotId: string; frame: number; generation: number } | null>(null);
  const previewSlot = useRef<{ slotId: string; frame: number } | null>(null);
  const [editorFrame, setEditorFrame] = useState(0);
  const editorFrameRef = useRef(editorFrame); editorFrameRef.current = editorFrame;
  const [frameInput, setFrameInput] = useState('1');
  const [frameInputError, setFrameInputError] = useState('');
  const [editorMode, setEditorMode] = useState<'frame' | 'video'>('frame');
  const [dock, setDock] = useState<{ left: number; width: number; bottom: number; height: number; toolHeight: number } | null>(null);
  const [reduceCount, setReduceCount] = useState<number | null>(null);
  const [retained, setRetained] = useState<string[]>([]);
  const [undo, setUndo] = useState<MultiviewDraft | null>(null);
  const [originalOpen, setOriginalOpen] = useState(false);
  const [actionDefaults, setActionDefaults] = useState<{ owner: string; model: string; duration: number; resolution: string; projectId: string; videoCardId: string | null } | null>(null);
  const [referenceSelection, setReferenceSelection] = useState<string[] | null>(null);
  const [referenceEditor, setReferenceEditor] = useState<{ scope: string; slots: MultiviewSlot[]; workId?: string; info?: MultiviewInfo } | null>(null);
  const referenceScope = `${authority}:${taskId}:${info?.sourceVersion || ''}`;
  const referenceActive = Boolean(referenceEditor && referenceEditor.scope.startsWith(`${authority}:${taskId}:`) && (referenceEditor.workId || referenceEditor.scope === referenceScope));
  const referenceInfo = referenceEditor?.info || info;
  const currentReferenceWork = useRef('');
  const [referenceLibrary, setReferenceLibrary] = useState(query.get('kind') === 'reference');
  const [view, setView] = useState<ViewPreferences>(emptyView);
  const [expanded, setExpanded] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [activity, setActivity] = useState(0);
  const [generation, setGeneration] = useState<MultiviewGenerationPanelState>({ phase: 'empty', busy: false });
  const [pendingResult, setPendingResult] = useState<MultiviewGenerationReady | null>(null);
  const [previousTask, setPreviousTask] = useState('');
  const [quickFrame, setQuickFrame] = useState<string | null>(null);
  const [quickPreview, setQuickPreview] = useState<Record<string, number>>({});
  const [applyingFrame, setApplyingFrame] = useState(false);
  const [originalWaiting, setOriginalWaiting] = useState(false);
  const [onscreenSlots, setOnscreenSlots] = useState<string[]>([]);
  const [releasedPixels, setReleasedPixels] = useState(0);
  const [previewState, setPreviewState] = useState<PreviewState>({ manifest: null, urls: {}, loading: false, error: '' });
  const [localPresent, setLocalPresent] = useState(false);
  const [allowWorkCreate, setAllowWorkCreate] = useState(false);
  const { confirm, prompt, productDialog } = useProductDialog();
  const sortSensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 350, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: [KeyboardCode.Space], cancel: [KeyboardCode.Esc], end: [KeyboardCode.Space] } }));
  const video = useRef<HTMLVideoElement>(null);
  const generationArea = useRef<HTMLDivElement>(null);
  const collageViewport = useRef<HTMLDivElement>(null);
  const resultArea = useRef<HTMLElement | null>(null);
  const [resultAreaNode, setResultAreaNode] = useState<HTMLElement | null>(null);
  const bindResultArea = useCallback((node: HTMLElement | null) => { resultArea.current = node; setResultAreaNode(node); }, []);
  const toolsArea = useRef<HTMLElement>(null);
  const toolsBackdrop = useRef<HTMLDivElement>(null);
  const exportBar = useRef<HTMLElement>(null);
  const requests = useRef(new Map<number, Promise<boolean>>());
  const originalQueue = useRef(createMultiviewOriginalQueue());
  const originalTargets = useRef(new Set<number>());
  const preferredOriginalSlot = useRef('');
  const usedUrls = useRef(new Map<string, number>());
  const retiredOriginals = useRef(new Map<string, number>());
  const interactionUntil = useRef(0);
  const previewRequests = useRef(new Map<number, Promise<boolean>>());
  const previewFrameRequests = useRef(new Map<number, Promise<boolean>>());
  const previewAtlases = useRef(new Map<number, ImageBitmap>());
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
  const mediaBaseRef = useRef('');
  const accountHydrated = useRef('');
  const locationRef = useRef(location); locationRef.current = location;
  const viewRef = useRef(view); viewRef.current = view;
  const previewRef = useRef(previewState); previewRef.current = previewState;
  const quickPreviewRef = useRef(quickPreview); quickPreviewRef.current = quickPreview;
  const preferencesReady = useRef('');
  const restoreScroll = useRef<{ key: string; x: number; y: number } | null>(null);
  const allowScrollRestore = useRef(true);
  const seenReady = useRef(new Set<string>());
  const collapsedFor = useRef('');
  const quickFrameLock = useRef<symbol | null>(null);
  const scrubFrames = useRef(new Set<number>());
  const quickFrameGate = useRef(createMultiviewLatestTargetGate());
  const slotDrag = useRef<SlotDrag | null>(null);
  const suppressSlotClick = useRef('');
  const boundDraft = useRef<{ owner: string; workId: string; taskId: string; draft: MultiviewDraft; preserveLocal: boolean } | null>(null);
  const unreadLocalKey = useRef('');
  const editingWorkId = !shareId && editorWork.owner === owner ? editorWork.id : '';
  const mediaBase = shareId ? `/api/video/multiview/shares/${encodeURIComponent(shareId)}/source` : editingWorkId ? `/api/video/multiview/works/${encodeURIComponent(editingWorkId)}/source` : `/api/video/multiview/${encodeURIComponent(taskId)}`;
  mediaBaseRef.current = mediaBase;
  const source = editingWorkId || shareId ? `${mediaBase}/video` : `/api/video/play/${encodeURIComponent(taskId)}`;
  const loop = useVideoLoopState(taskId ? source : undefined, taskId ? `video_task:${editingWorkId || taskId}` : undefined, undefined, true);
  const storageKey = info && owner ? shareId ? `sd2:multiview-share-draft:v1:${owner}:${shareId}:${shared?.revision}:${info.sourceVersion}` : editingWorkId ? `sd2:multiview-work:v1:${owner}:${editingWorkId}:${info.sourceVersion}` : `sd2:multiview:v1:${owner}:${taskId}:${info.sourceVersion}` : '';
  const viewKey = storageKey ? `${storageKey}:view:v1` : '';
  const sessionReady = !sessionChanged && !userLoadError && !isClientSessionBlocked();
  const visible = sessionReady && authorized && (!shareId || shared?.id === shareId) && loadedOwner === owner && loadedAuthority === authority && info?.taskId === taskId;
  const toolsOpen = Boolean(visible && pageView === 'editor' && (draft?.editing || view.tab === 'layout' && !originalOpen));
  function closeTools() {
    if (applyingFrame) return;
    video.current?.pause();
    if (draftRef.current?.editing) update({ ...draftRef.current, editing: null });
    setView(value => ({ ...value, tab: 'frames' }));
  }
  useDialogDismiss({ open: toolsOpen, dialogRef: toolsArea, dismissSurfaceRef: toolsBackdrop, onDismiss: closeTools });
  const currentSourceKey = `${owner}:${taskId}:${loadedOwner === owner && info?.taskId === taskId ? info.sourceVersion : ''}:${activity}`;
  const sourceKeyRef = useRef(currentSourceKey); sourceKeyRef.current = currentSourceKey;
  useEffect(() => {
    const view = query.get('view') === 'works' ? 'works' : query.get('view') === 'generations' ? 'generations' : 'editor'; setPageView(view);
    if (view === 'editor') setEditorWork({ owner, id: query.get('workId') || '' });
  }, [query, owner]);
  useEffect(() => {
    const referenceId = query.get('referenceWorkId');
    if (currentReferenceWork.current === referenceId && referenceEditor?.scope.startsWith(`${authority}:${taskId}:`)) return;
    if (!owner || !sessionReady || !referenceId || !/^[A-Za-z0-9_-]{1,100}$/.test(referenceId)) return;
    let cancelled = false; const capturedOwner = owner, capturedAuthority = authority;
    void fetch(`/api/video/multiview/works/${referenceId}`, {cache:'no-store',headers:{'x-app-session-user':owner},signal:AbortSignal.timeout(30000)}).then(async response=>{
      const value = await response.json(); if (!response.ok || value.work?.recipe?.schema!==3 || !value.work.info) throw new Error(value.error || '参考拼图暂不可读取。');
      if (cancelled || ownerRef.current!==capturedOwner || authorityRef.current!==capturedAuthority || isClientSessionBlocked()) return;
      const work = value.work as MultiviewWorkDto; setLocation({owner,taskId:work.sourceTaskId});setEditorWork({owner,id:work.parentWorkId||''});setPageView('editor');setReferenceEditor({scope:`${authority}:${work.sourceTaskId}:${work.sourceVersion}`,slots:work.recipe!.slots,workId:work.id,info:work.info!});
    }).catch(cause=>{if(!cancelled&&ownerRef.current===capturedOwner)setReferenceNotice(cause.message);});
    return()=>{cancelled=true;};
  }, [query,owner,authority,sessionReady]);
  function writeLocation(view: 'editor' | 'generations' | 'works', workId = '', sourceTask = taskId) {
    const url = new URL(window.location.href);
    url.searchParams.delete('shareId');
    if (view === 'works' || view === 'generations') url.searchParams.set('view', view); else url.searchParams.delete('view');
    if (view !== 'works') { url.searchParams.delete('kind'); setReferenceLibrary(false); }
    url.searchParams.delete('referenceWorkId');
    if (workId) url.searchParams.set('workId', workId); else url.searchParams.delete('workId');
    if (sourceTask && view === 'editor') url.searchParams.set('taskId', sourceTask); else url.searchParams.delete('taskId');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    if (view !== pageView) setActivity(value => value + 1);
    setPageView(view);
    if (view === 'editor') { setEditorWork({ owner, id: workId }); if (sourceTask) setLocation({ owner, taskId: sourceTask }); }
  }
  async function openSavedWork(workId: string, sourceTask: string) {
    const epoch = context.current, capturedOwner = owner;
    if ((unsavedFrames || workState.unsaved) && !await confirm('当前编辑内容尚未保存在此设备，仍要打开另一份方案吗？', { title: '打开方案', confirmLabel: '放弃并打开' })) return;
    if (epoch !== context.current || capturedOwner !== ownerRef.current || isClientSessionBlocked()) return;
    writeLocation('editor', workId, sourceTask);
  }
  function restoreWorkRecipe(recipe: MultiviewWorkRecipe) {
    if (recipe.schema === 3 || !visible || !info || recipe.sourceVersion !== info.sourceVersion || operation.current || isClientSessionBlocked()) return;
    const before = draftRef.current;
    const applied = appliedWorkRecipe(before, info);
    const same = Boolean(applied && multiviewWorkRecipesEqual(applied, recipe));
    const editingIndex = before?.slots.findIndex(item => item.id === before.editing) ?? -1;
    const selectedIndex = before?.slots.findIndex(item => item.id === viewRef.current.selected) ?? -1;
    const next: MultiviewDraft = { ...recipe, editing: same ? recipe.slots[editingIndex]?.id || null : null,
      ...(same && before?.editorFrame !== undefined ? { editorFrame: before.editorFrame } : {}) };
    clearArtifacts(); draftRef.current = next; setDraft(next); setDraftEdited(false); setRetainedDraft(editingSignature(next)); setSaved(false);
    setView(value => ({ ...value, selected: next.slots.some(item => item.id === value.selected) ? value.selected : same ? next.slots[selectedIndex]?.id || next.slots[0]?.id || '' : next.slots[0]?.id || '' }));
    setUndo(null); setReduceCount(null); if (!same) setActivity(value => value + 1);
  }
  const sharedOperation = useMultiviewShareOperation(owner, `share:${shareId}`, receipt => {
    if (!receipt.workId || !shared || ownerRef.current !== owner || isClientSessionBlocked()) return;
    const currentDraft = draftRef.current;
    if (currentDraft?.sourceVersion === shared.sourceVersion) {
      localStorage.setItem(`sd2:multiview-work:v1:${owner}:${receipt.workId}:${shared.sourceVersion}`, JSON.stringify(currentDraft));
      boundDraft.current = { owner, workId: receipt.workId, taskId: shared.sourceTaskId, draft: currentDraft, preserveLocal: false };
    }
    setEditorWork({ owner, id: receipt.workId }); writeLocation('editor', receipt.workId, shared.sourceTaskId);
  });
  const workState = useMultiviewWork({ owner, authority, enabled: Boolean(owner && hasLoadedUser && sessionReady && pageView === 'editor' && !shareId && !referenceActive),
    workId: editingWorkId, taskId, explicitTaskId: explicitTask, info: visible ? info : null, draft: visible ? draft : null,
    localPresent, allowCreate: allowWorkCreate, editRevision: activity,
    onSource: work => { if (ownerRef.current === owner && !isClientSessionBlocked()) setLocation({ owner, taskId: work.sourceTaskId }); },
    onRestore: restoreWorkRecipe,
    onBound: work => {
      if (ownerRef.current !== owner || isClientSessionBlocked()) return;
      let currentDraft = draftRef.current;
      if (currentDraft && currentDraft.sourceVersion === work.sourceVersion) {
        const currentRecipe = appliedWorkRecipe(currentDraft, work.info);
        // A just-created default preview is not a device edit: first opening an existing
        // work without a saved draft must restore that work, not manufacture a conflict.
        if (!localPresent && !draftEdited && work.recipe && work.recipe.schema !== 3 && currentRecipe && !multiviewWorkRecipesEqual(currentRecipe, work.recipe)) {
          currentDraft = { ...work.recipe, editing: null };
        }
        let preserveLocal = false;
        try {
          const key = `sd2:multiview-work:v1:${owner}:${work.id}:${currentDraft.sourceVersion}`; const bytes = JSON.stringify(currentDraft);
          const previousRaw = localStorage.getItem(key);
          const previous = work.info ? parseMultiviewDraft(previousRaw, work.info) : null;
          const previousRecipe = appliedWorkRecipe(previous, work.info); const carriedRecipe = appliedWorkRecipe(currentDraft, work.info);
          preserveLocal = previousRaw !== null && (!previousRecipe || !carriedRecipe || !multiviewWorkRecipesEqual(previousRecipe, carriedRecipe));
          if (!preserveLocal) { localStorage.setItem(key, bytes); if (localStorage.getItem(key) !== bytes) throw new Error('not_retained'); }
        } catch { preserveLocal = true; setSaved(false); }
        boundDraft.current = { owner, workId: work.id, taskId: work.sourceTaskId, draft: currentDraft, preserveLocal };
      }
      setEditorWork({ owner, id: work.id }); setAllowWorkCreate(false); writeLocation('editor', work.id, work.sourceTaskId);
    },
  });
  const unsavedFrames = Boolean(draftEdited && !saved && draft && editingSignature(draft) !== retainedDraft);
  useEffect(() => {
    if (!visible || pageView !== 'editor') { setDock(null); return; }
    let raf = 0;
    const measure = () => {
      raf = 0;
      if (!resultArea.current || !exportBar.current) return;
      const viewport = window.visualViewport;
      const leftEdge = viewport?.offsetLeft ?? 0;
      const bottomEdge = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight);
      const bounds = resultArea.current.getBoundingClientRect();
      const left = Math.max(leftEdge + 8, bounds.left);
      const width = Math.max(0, Math.min(bounds.right, leftEdge + (viewport?.width ?? window.innerWidth) - 8) - left);
      const height = width >= 160 ? Math.ceil(exportBar.current.getBoundingClientRect().height) : 0;
      const toolsTop = Math.max((viewport?.offsetTop ?? 0) + 64, toolsArea.current?.getBoundingClientRect().top ?? 64);
      // Do not collapse the focused tool body when a software keyboard reduces the visual viewport.
      const typing = document.activeElement instanceof HTMLElement && document.activeElement.matches('input, textarea, select, [contenteditable=true]');
      const toolsBottom = typing && viewport && viewport.height < window.innerHeight * .7 ? window.innerHeight : bottomEdge;
      const next = { left, width, height, bottom: Math.max(0, window.innerHeight - bottomEdge), toolHeight: Math.max(96, Math.floor(toolsBottom - toolsTop - height - 16)) };
      setDock(value => value && Object.keys(next).every(key => value[key as keyof typeof next] === next[key as keyof typeof next]) ? value : next);
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(measure); };
    const focus = () => { schedule(); const active = document.activeElement; if (active instanceof HTMLElement && resultArea.current?.contains(active)) active.scrollIntoView({ block: 'nearest', inline: 'nearest' }); };
    const observer = new ResizeObserver(schedule);
    if (resultArea.current) observer.observe(resultArea.current);
    if (exportBar.current) observer.observe(exportBar.current);
    measure();
    window.addEventListener('resize', schedule); window.addEventListener('scroll', schedule, true);
    window.visualViewport?.addEventListener('resize', focus); window.visualViewport?.addEventListener('scroll', schedule);
    return () => { observer.disconnect(); cancelAnimationFrame(raf); window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true); window.visualViewport?.removeEventListener('resize', focus); window.visualViewport?.removeEventListener('scroll', schedule); };
  }, [visible, pageView, editingWorkId, workState.work?.id]);
  useUnsavedNavigation(unsavedFrames || Boolean(generation.unsaved) || exporting || Boolean(generation.leavingBusy) || workState.unsaved || workState.busy, confirm, {
    unsaved: [...(unsavedFrames ? ['本次选帧或排版修改暂未保存到本机'] : []), ...(generation.unsaved ? ['生成输入或原请求记录暂未完整保存到本机'] : []), ...(workState.unsaved ? ['作品名称或原保存记录尚未保存在此设备'] : [])],
    busy: [...(exporting ? ['拼图文件仍在准备或复制'] : []), ...(generation.leavingBusy ? ['主图或视频提交仍在处理中'] : []), ...(workState.busy ? ['作品保存仍在处理中'] : [])],
    revision: JSON.stringify([draft, generation.unsaved, generation.leavingBusy, generation.taskId, workState.unsaved, workState.busy]),
    onBlocked: setNotice,
  });

  const clearArtifacts = useCallback(() => {
    operation.current?.controller.abort(); operation.current = null;
    for (const item of Array.from(artifacts.current.values())) { URL.revokeObjectURL(item.url); objectUrls.current.delete(item.url); }
    artifacts.current.clear(); artifactInflight.current.clear(); setExportFile(null); setExporting(false);
  }, []);
  const retireFrameUrl = useCallback((url: string, bytes = 0) => {
    if (usedUrls.current.has(url)) { retiredOriginals.current.set(url, bytes); return; }
    URL.revokeObjectURL(url); objectUrls.current.delete(url); retiredOriginals.current.delete(url);
  }, []);
  const trackFrameUrl = useCallback((url: string, used: boolean) => {
    const count = (usedUrls.current.get(url) || 0) + (used ? 1 : -1);
    if (count > 0) usedUrls.current.set(url, count);
    else {
      usedUrls.current.delete(url);
      if (retiredOriginals.current.has(url)) { URL.revokeObjectURL(url); objectUrls.current.delete(url); retiredOriginals.current.delete(url); }
      setReleasedPixels(value => value + 1);
    }
  }, []);
  const clearUrls = useCallback(() => {
    clearArtifacts();
    quickFrameGate.current.cancel();
    originalQueue.current.clear(); originalTargets.current.clear(); preferredOriginalSlot.current = '';
    frameCopy.current = null; previewSlot.current = null; setCopyingFrame('');
    quickFrameLock.current = null; scrubFrames.current.clear(); setQuickFrame(null); slotDrag.current = null; suppressSlotClick.current = '';
    const sizes = new Map(Object.values(frameRef.current).filter(item => item.url).map(item => [item.url!, item.originalBytes || 0]));
    for (const url of Array.from(objectUrls.current)) retireFrameUrl(url, sizes.get(url) || retiredOriginals.current.get(url) || 0);
    requests.current.clear(); previewRequests.current.clear(); previewFrameRequests.current.clear();
    for (const bitmap of Array.from(previewAtlases.current.values())) bitmap.close();
    previewAtlases.current.clear();
    frameRef.current = {}; setFrames({}); setPreviewState({ manifest: null, urls: {}, loading: false, error: '' });
    setQuickPreview({}); setApplyingFrame(false); setPreview(null); setOriginalWaiting(false); setOnscreenSlots([]);
  }, [clearArtifacts, retireFrameUrl]);
  const rejectSource = useCallback((message: string) => {
    context.current += 1; abort.current?.abort(); clearUrls();
    video.current?.pause(); video.current?.removeAttribute('src'); video.current?.load(); setActivity(value => value + 1); setAuthorized(false); setError(message); setNotice('原选帧和生成草稿已保留，重新读取前不再使用旧图片或文件。');
  }, [clearUrls]);
  useEffect(() => {
    setShared(null); setShareOpen(false);
    if (!shareId || !owner || !sessionReady) return;
    let stopped = false, attempts = 0, checking = false; const controller = new AbortController();
    const check = async () => {
      if (stopped || document.hidden || checking || attempts > 120) return;
      if (++attempts > 120) { setShared(null); rejectSource('本次分享核对已暂停，重新聚焦页面后继续核对。'); return; }
      checking = true;
      try {
        const response = await fetch(`/api/video/multiview/shares/${encodeURIComponent(shareId)}`, { cache: 'no-store', headers: { 'x-app-session-user': owner }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
        const data = await response.json();
        if (stopped || ownerRef.current !== owner || isClientSessionBlocked()) return;
        if (!response.ok || !data.share || data.share.id !== shareId) {
          setShared(null); rejectSource(data.error || '分享暂不可读取。'); return;
        }
        const next = data.share;
        setShared(previous => previous && previous.id === next.id && previous.generation === next.generation ? previous : next);
        setLocation(previous => previous.owner === owner && previous.taskId === next.sourceTaskId ? previous : { owner, taskId: next.sourceTaskId });
      } catch { if (!stopped) { setShared(null); rejectSource('分享授权暂无法确认，请重新读取。'); } }
      finally { checking = false; }
    };
    void check(); const timer = setInterval(() => void check(), 15000);
    const focus = () => { attempts = 0; void check(); };
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    return () => { stopped = true; controller.abort(); clearInterval(timer); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, [owner, authority, shareId, sessionReady, rejectSource]);
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
    const libraryView = query.get('view') === 'works' || query.get('view') === 'generations';
    const nextTask = shareId ? '' : explicitTask || (!libraryView && query.get('workId') ? '' : !accountChanged && previous.owner === owner ? previous.taskId : safeTask(restored) ? restored : '');
    if (previous.owner !== owner || previous.taskId !== nextTask) { setLocation({ owner, taskId: nextTask }); setPendingResult(null); }
    if (accountChanged) {
      setPreviousTask(''); setGeneration({ phase: 'empty', busy: false });
      seenReady.current.clear(); collapsedFor.current = ''; setActivity(0); setAllowWorkCreate(false); setLocalPresent(false);
    }
  }, [explicitTask, hasLoadedUser, owner, shareId]);

  const load = useCallback(async (recheck = false) => {
    if (!owner || !taskId || shareId && shared?.id !== shareId || isClientSessionBlocked()) { setLoading(false); setError(''); return; }
    if (!safeTask(taskId)) { setLoading(false); setError('视频编号无效，当前生成草稿不受影响'); return; }
    const epoch = ++context.current;
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
    clearArtifacts(); originalQueue.current.clear(); requests.current.clear();
    setAuthorized(false); setLoading(true); setError(''); setPreview(null);
    try {
      const response = await fetch(mediaBase, { cache: 'no-store', headers: { 'x-app-session-user': owner }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]) });
      const result = await response.json();
      if (!response.ok || !result.info) throw new Error(result.error || '原视频读取失败，可重新读取');
      if (epoch !== context.current || ownerRef.current !== owner || authorityRef.current !== authority || isClientSessionBlocked()) return;
      const next = result.info as MultiviewInfo;
      const previous = draftRef.current;
      if (!recheck || previous?.sourceVersion !== next.sourceVersion) {
        clearUrls();
        const legacyKey = `sd2:multiview:v1:${owner}:${taskId}:${next.sourceVersion}`;
        const key = shareId ? `sd2:multiview-share-draft:v1:${owner}:${shareId}:${shared?.revision}:${next.sourceVersion}` : editingWorkId ? `sd2:multiview-work:v1:${owner}:${editingWorkId}:${next.sourceVersion}` : legacyKey;
        let restored: MultiviewDraft | null = null; let preference = emptyView();
        try {
          const raw = localStorage.getItem(key); restored = parseMultiviewDraft(raw, next);
          if (raw !== null && !restored) { unreadLocalKey.current = key; setSaved(false); setNotice('原本机配方暂无法读取，原记录已保留；当前现场不会覆盖它。'); }
          else { unreadLocalKey.current = ''; setSaved(true); }
        }
        catch { setSaved(false); }
        if (boundDraft.current?.owner === owner && boundDraft.current.workId === editingWorkId && boundDraft.current.taskId === taskId && boundDraft.current.draft.sourceVersion === next.sourceVersion) {
          restored = boundDraft.current.draft;
          if (boundDraft.current.preserveLocal) { unreadLocalKey.current = key; setSaved(false); setNotice('本作品已有不同本机配方，原记录已保留；当前修改可另存一版。'); }
          boundDraft.current = null;
        }
        const keepCurrent = previous?.sourceVersion === next.sourceVersion && preferencesReady.current === `${key}:view:v1`;
        if (!keepCurrent) setDraftEdited(false);
        const state: MultiviewDraft = keepCurrent ? previous! : restored || (shared?.id === shareId && shared.recipe.schema !== 3 ? { ...shared.recipe, editing: null } : initialDraft(next));
        if (!keepCurrent) setLocalPresent(Boolean(restored));
        if (!keepCurrent) setRetainedDraft(editingSignature(state));
        try { preference = keepCurrent ? { ...viewRef.current, x: window.scrollX, y: window.scrollY } : readView(localStorage.getItem(`${key}:view:v1`), state); }
        catch { setViewSaved(false); }
        preferencesReady.current = `${key}:view:v1`;
        preference.selected ||= state.editing || state.slots[0]?.id || '';
        setView(preference); setOriginalOpen(preference.originalOpen); restoreScroll.current = allowScrollRestore.current ? { key, x: preference.x, y: preference.y } : null;
        allowScrollRestore.current = true;
        draftRef.current = state; setDraft(state); setUndo(null); setReduceCount(null);
        const restoredFrame = state.editorFrame ?? state.slots.find(item => item.id === state.editing)?.frame ?? 0;
        setEditorFrame(restoredFrame); setFrameInput(String(restoredFrame + 1)); setFrameInputError('');
        if (recheck && previous) setNotice('原视频版本已变化，已载入对应候选；旧草稿单独保留。');
      }
      setInfo(next); setLoadedOwner(owner); setLoadedAuthority(authority); setAuthorized(true);
      try { if (!shareId) { sessionStorage.setItem(`sd2:multiview:source:v1:${owner}`, taskId); localStorage.setItem(`sd2:multiview:last-source:v1:${owner}`, taskId); } }
      catch { setViewSaved(false); }
    } catch (cause) {
      if (epoch !== context.current || controller.signal.aborted) return;
      clearUrls(); setError(cause instanceof Error ? cause.message : '原视频暂不可用');
    } finally { if (epoch === context.current) setLoading(false); }
  }, [authority, clearArtifacts, clearUrls, owner, taskId, editingWorkId, mediaBase, shareId, shared]);
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
    if (unreadLocalKey.current === storageKey) { setSaved(false); return; }
    try {
      const bytes = JSON.stringify(draft);
      localStorage.setItem(storageKey, bytes);
      if (localStorage.getItem(storageKey) !== bytes) throw new Error('draft_not_retained');
      setRetainedDraft(editingSignature(draft)); setSaved(true);
    } catch { setSaved(false); }
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
      // The page owns vertical scrolling; legacy internal pan coordinates are ignored.
    });
    return () => cancelAnimationFrame(raf);
  }, [storageKey, visible]);
  useEffect(() => {
    const media = video.current;
    const pause = () => { if (document.visibilityState !== 'visible') media?.pause(); };
    document.addEventListener('visibilitychange', pause);
    return () => { media?.pause(); document.removeEventListener('visibilitychange', pause); };
  }, [visible, originalOpen, draft?.editing, view.tab]);

  const loadFrame = useCallback(async (frame: number, retry = false, foreground = true): Promise<boolean> => {
    if (!info || !visible) return false;
    const epoch = context.current;
    const bindLocal = (url: string, blob: Blob): LocalFrameContext => ({
      kind: 'local-frame', account: `${owner}:${user?.role || ''}:${user?.account_type || ''}`, authority,
      sourceKind: shareId ? 'share' : editingWorkId ? 'work' : 'task', sourceId: shareId || editingWorkId || taskId,
      taskId, sourceVersion: info.sourceVersion, frame, width: info.width, height: info.height, generation: epoch,
      blob, url, signal: abort.current!.signal,
      isCurrent: () => epoch === context.current && ownerRef.current === owner && authorityRef.current === authority
        && mediaBaseRef.current === mediaBase && frameRef.current[frame]?.url === url && frameRef.current[frame]?.blob === blob && !isClientSessionBlocked(),
      retain: () => { trackFrameUrl(url, true); let released = false; return () => { if (!released) { released = true; trackFrameUrl(url, false); } }; },
      authorize: async () => {
        const response = await fetch(mediaBase, { cache: 'no-store', headers: { 'x-app-session-user': owner },
          signal: AbortSignal.any([abort.current!.signal, AbortSignal.timeout(30000)]) });
        const result = await response.json();
        if (epoch !== context.current || ownerRef.current !== owner || authorityRef.current !== authority || mediaBaseRef.current !== mediaBase || isClientSessionBlocked()) throw new DOMException('原帧已变化', 'AbortError');
        if (!response.ok || result.info?.taskId !== taskId || result.info?.sourceVersion !== info.sourceVersion
          || result.info.width !== info.width || result.info.height !== info.height) {
          if ([401, 403, 404, 409].includes(response.status) || response.ok) rejectSource('原视频权限或版本已变化，请重新读取');
          throw new Error('暂时无法核对原视频，请重试这一帧');
        }
      },
    });
    const cached = frameRef.current[frame];
    if (cached?.url && cached.blob && abort.current) {
      if (cached.localFrame?.generation !== epoch) { frameRef.current = { ...frameRef.current, [frame]: { ...cached, localFrame: bindLocal(cached.url, cached.blob) } }; setFrames(frameRef.current); }
      return true;
    }
    if (cached?.error && !retry) return false;
    const pending = originalQueue.current.request(frame, async () => {
      if (epoch !== context.current) return false;
      if (epoch === context.current) setFrames(value => ({ ...value, [frame]: { ...value[frame], loading: true } }));
      try {
        if (epoch !== context.current || isClientSessionBlocked()) return false;
        const response = await fetch(`${mediaBase}?version=${info.sourceVersion}&frame=${frame}`, { cache: 'no-store', headers: { 'x-app-session-user': owner }, signal: abort.current ? AbortSignal.any([abort.current.signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000) });
        if (!response.ok) {
          const value = await response.json().catch(() => ({}));
          if ([401, 403, 404, 409].includes(response.status) && epoch === context.current) rejectSource(value.error || '原视频权限或版本已变化，请重新读取');
          throw new Error(value.error || '这一帧未提取成功');
        }
        const blob = await response.blob();
        if (blob.type !== 'image/png' || !blob.size) throw new Error('这一帧暂不可读取，可单独重试');
        if (epoch !== context.current || ownerRef.current !== owner || authorityRef.current !== authority || isClientSessionBlocked()) return false;
        const url = URL.createObjectURL(blob);
        try { const image = new Image(); image.src = url; await image.decode();
          if (image.naturalWidth !== info.width || image.naturalHeight !== info.height) throw new Error('原帧尺寸与视频不一致');
        } catch { URL.revokeObjectURL(url); throw new Error('原尺寸画面未完整显示，可重试这一格'); }
        if (epoch !== context.current || ownerRef.current !== owner || authorityRef.current !== authority || isClientSessionBlocked()) { URL.revokeObjectURL(url); return false; }
        objectUrls.current.add(url);
        frameRef.current = { ...frameRef.current, [frame]: { ...frameRef.current[frame], url, blob, localFrame: bindLocal(url, blob), originalBytes: blob.size + info.width * info.height * 4, loading: false, error: undefined } }; setFrames(frameRef.current);
        return true;
      } catch (cause) {
        if (epoch === context.current && !abort.current?.signal.aborted) { frameRef.current = { ...frameRef.current, [frame]: { ...frameRef.current[frame], loading: false, error: cause instanceof Error ? cause.message : '提取失败，可单独重试' } }; setFrames(frameRef.current); }
        return false;
      }
    }, foreground);
    requests.current.set(frame, pending);
    void pending.finally(() => { if (requests.current.get(frame) === pending) requests.current.delete(frame); });
    return pending;
  }, [authority, info, owner, rejectSource, mediaBase, visible, user?.role, user?.account_type, shareId, editingWorkId, taskId, trackFrameUrl]);
  const currentSlotFrame = (id: string, frame: number) => draftRef.current?.slots.some(item => item.id === id && item.frame === frame) === true;
  async function openFramePreview(frame: number, slotId = '') {
    const epoch = context.current;
    const current = () => epoch === context.current && (slotId ? currentSlotFrame(slotId, frame) : editorFrameRef.current === frame) && !isClientSessionBlocked();
    try {
      if (!await loadFrame(frame, true) || !current()) return;
      const local = frameRef.current[frame]?.localFrame;
      if (!local?.isCurrent()) return;
      const release = local.retain();
      try { await local.authorize(); if (current() && local.isCurrent()) { previewSlot.current = slotId ? { slotId, frame } : null; setPreview(frame); } }
      finally { release(); }
    } catch (cause) { if (current()) setNotice(cause instanceof Error ? cause.message : '原帧暂不可读取，请重试'); }
  }
  function copySlotFrame(item: MultiviewSlot) {
    const captured = { token: Symbol('frame-copy'), slotId: item.id, frame: item.frame, generation: context.current };
    frameCopy.current = captured; setCopyingFrame(item.id);
    const current = () => frameCopy.current === captured && captured.generation === context.current
      && currentSlotFrame(captured.slotId, captured.frame) && ownerRef.current === owner && authorityRef.current === authority && !isClientSessionBlocked();
    let release = () => {};
    const png = (async () => {
      if (!await loadFrame(captured.frame, true) || !current()) throw new DOMException('原帧已变化，复制已取消', 'AbortError');
      const local = frameRef.current[captured.frame]?.localFrame;
      if (!local?.isCurrent()) throw new DOMException('原帧已变化，复制已取消', 'AbortError');
      release = local.retain(); await local.authorize();
      if (!current() || !local.isCurrent()) throw new DOMException('原帧已变化，复制已取消', 'AbortError');
      return local.blob;
    })();
    // This write starts in the click, not after the original PNG has loaded.
    void copyPngBlob(png).then(() => { if (current()) setNotice('原尺寸PNG已复制'); })
      .catch(cause => { if (current()) setNotice(cause instanceof Error ? cause.message : '复制未完成，请重试'); })
      .finally(() => { void png.then(() => release(), () => release()); if (frameCopy.current === captured) { frameCopy.current = null; setCopyingFrame(''); } });
  }
  useEffect(() => {
    const copy = frameCopy.current;
    if (copy && (copy.generation !== context.current || !draft?.slots.some(item => item.id === copy.slotId && item.frame === copy.frame))) { frameCopy.current = null; setCopyingFrame(''); }
    const target = previewSlot.current;
    if (pageView !== 'editor' || target && !draft?.slots.some(item => item.id === target.slotId && item.frame === target.frame)
      || !target && preview !== null && draft?.editing && preview !== editorFrame) { previewSlot.current = null; setPreview(null); }
  }, [draft, pageView, authority, preview, editorFrame]);
  const loadPreviewManifest = useCallback(async () => {
    if (!info || !visible || previewRef.current.manifest?.sourceVersion === info.sourceVersion) return;
    const epoch = context.current;
    setPreviewState(value => ({ ...value, loading: true, error: '' }));
    try {
      const response = await fetch(`${mediaBase}/previews?version=${info.sourceVersion}`,
        { cache: 'no-store', headers: { 'x-app-session-user': owner }, signal: abort.current ? AbortSignal.any([abort.current.signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000) });
      const value = await response.json();
      if (!response.ok) {
        if ([401, 403, 404, 409].includes(response.status) && epoch === context.current) rejectSource(value.error || '原视频权限或版本已变化，请重新读取');
        throw new Error(value.error || '快速预览暂不可用');
      }
      const manifest = value.manifest as MultiviewPreviewManifest;
      if (epoch !== context.current || manifest?.schema !== 1 || manifest.sourceVersion !== info.sourceVersion
        || manifest.totalFrames !== info.timestamps.length || !Array.isArray(manifest.chunks)) return;
      previewRef.current = { ...previewRef.current, manifest, loading: false, error: '' }; setPreviewState(previewRef.current);
    } catch (cause) {
      if (epoch === context.current && !abort.current?.signal.aborted) setPreviewState(current => ({ ...current, loading: false,
        error: cause instanceof Error ? cause.message : '快速预览暂不可用' }));
    }
  }, [info, rejectSource, mediaBase, owner, visible]);
  const loadPreviewChunk = useCallback(async (frame: number): Promise<boolean> => {
    const manifest = previewRef.current.manifest;
    if (!manifest || frame < 0 || frame >= manifest.totalFrames || !visible) return false;
    const index = multiviewPreviewChunkIndex(frame);
    if (previewRef.current.urls[index] && previewAtlases.current.has(index)) return true;
    const pending = previewRequests.current.get(index);
    if (pending) return pending;
    const epoch = context.current;
    const request = (async () => {
      try {
        const response = await fetch(`${mediaBase}/previews?version=${manifest.sourceVersion}&chunk=${index}`,
          { cache: 'no-store', headers: { 'x-app-session-user': owner }, signal: abort.current ? AbortSignal.any([abort.current.signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000) });
        if (!response.ok) {
          const value = await response.json().catch(() => ({}));
          if ([401, 403, 404, 409].includes(response.status) && epoch === context.current) rejectSource(value.error || '原视频权限或版本已变化，请重新读取');
          throw new Error(value.error || '快速预览暂不可用');
        }
        const blob = await response.blob();
        if (!blob.size || blob.type !== 'image/jpeg') throw new Error('快速预览未完整收到');
        if (epoch !== context.current || ownerRef.current !== owner || authorityRef.current !== authority || isClientSessionBlocked()) return false;
        const bitmap = await createImageBitmap(blob);
        if (bitmap.width !== manifest.columns * manifest.cellWidth || bitmap.height !== manifest.rows * manifest.cellHeight) {
          bitmap.close(); throw new Error('快速预览尺寸不匹配，请重新读取');
        }
        if (epoch !== context.current || ownerRef.current !== owner || authorityRef.current !== authority || isClientSessionBlocked()) { bitmap.close(); return false; }
        const url = URL.createObjectURL(blob); objectUrls.current.add(url);
        previewAtlases.current.set(index, bitmap);
        {
          const urls = { ...previewRef.current.urls, [index]: url };
          const keep = new Set(multiviewPreviewRetainedChunks(index, Object.keys(urls).map(Number)));
          const remove = Object.keys(urls).map(Number).filter(key => !keep.has(key));
          for (const key of remove) {
            URL.revokeObjectURL(urls[key]); objectUrls.current.delete(urls[key]); delete urls[key];
            previewAtlases.current.get(key)?.close(); previewAtlases.current.delete(key);
          }
          previewRef.current = { ...previewRef.current, urls, error: '' }; setPreviewState(previewRef.current);
        }
        return true;
      } catch (cause) {
        if (epoch === context.current && !abort.current?.signal.aborted) setPreviewState(current => ({ ...current,
          error: cause instanceof Error ? cause.message : '快速预览暂不可用' }));
        return false;
      } finally { if (epoch === context.current) previewRequests.current.delete(index); }
    })();
    previewRequests.current.set(index, request);
    return request;
  }, [authority, owner, rejectSource, mediaBase, visible]);
  const loadPreviewFrame = useCallback(async (frame: number): Promise<boolean> => {
    if (!visible || !previewRef.current.manifest) return false;
    if (frameRef.current[frame]?.previewUrl) return true;
    const existing = previewFrameRequests.current.get(frame); if (existing) return existing;
    const epoch = context.current;
    const pending = (async () => {
      try {
        if (!await loadPreviewChunk(frame)) return false;
        const manifest = previewRef.current.manifest;
        const bitmap = previewAtlases.current.get(multiviewPreviewChunkIndex(frame));
        if (!manifest || !bitmap || epoch !== context.current || isClientSessionBlocked()) return false;
        const blob = await encodeMultiviewPreviewFrame(bitmap, manifest, frame);
        if (epoch !== context.current || ownerRef.current !== owner || authorityRef.current !== authority || isClientSessionBlocked()) return false;
        const previewUrl = URL.createObjectURL(blob);
        try { const image = new Image(); image.src = previewUrl; await image.decode(); }
        catch { URL.revokeObjectURL(previewUrl); throw new Error('这一帧预览未完整显示，可重试'); }
        if (epoch !== context.current || ownerRef.current !== owner || authorityRef.current !== authority || isClientSessionBlocked()) { URL.revokeObjectURL(previewUrl); return false; }
        objectUrls.current.add(previewUrl);
        frameRef.current = { ...frameRef.current, [frame]: { ...frameRef.current[frame], previewUrl, previewError: undefined } };
        setFrames(frameRef.current); return true;
      } catch (cause) {
        if (epoch === context.current && !abort.current?.signal.aborted) {
          frameRef.current = { ...frameRef.current, [frame]: { ...frameRef.current[frame], previewError: cause instanceof Error ? cause.message : '快速预览未就绪' } };
          setFrames(frameRef.current);
        }
        return false;
      } finally { if (epoch === context.current) previewFrameRequests.current.delete(frame); }
    })();
    previewFrameRequests.current.set(frame, pending); return pending;
  }, [authority, loadPreviewChunk, owner, visible]);
  useEffect(() => { if (visible && info) void loadPreviewManifest(); }, [info, loadPreviewManifest, visible]);
  const frameSignature = draft?.slots.map(item => item.frame).join(',') || '';
  const slotIds = draft?.slots.map(item => item.id).join(',') || '';
  useEffect(() => {
    setOnscreenSlots([]);
    if (!visible || !resultAreaNode || resultArea.current !== resultAreaNode) return;
    let active = true;
    const showing = new Set<string>(), epoch = context.current;
    const observer = new IntersectionObserver(entries => {
      if (!active || epoch !== context.current || resultArea.current !== resultAreaNode) return;
      for (const entry of entries) {
        if (!resultAreaNode.contains(entry.target)) continue;
        const id = (entry.target as HTMLElement).dataset.mvSlot;
        if (!id) continue;
        if (entry.isIntersecting) showing.add(id); else showing.delete(id);
      }
      setOnscreenSlots(Array.from(showing));
    }, { rootMargin: '80px' });
    resultAreaNode.querySelectorAll('[data-mv-slot]').forEach(element => observer.observe(element));
    return () => { active = false; observer.disconnect(); };
  }, [resultAreaNode, slotIds, visible, view.tab, pageView]);
  const originalSignature = JSON.stringify([frameSignature, draft?.editing, editorFrame, view.selected, onscreenSlots, quickPreview, preferredOriginalSlot.current]);
  useEffect(() => {
    if (!visible || !info || !draft || pageView !== 'editor') { originalTargets.current.clear(); originalQueue.current.background([], true); return; }
    originalQueue.current.background([], true);
    const preferred = draft.slots.find(item => item.id === preferredOriginalSlot.current) || draft.slots.find(item => item.id === view.selected);
    const targets = Array.from(new Set([
      ...(draft.editing ? [editorFrame] : []),
      ...(preferred ? [preferred.frame] : []),
      ...draft.slots.filter(item => onscreenSlots.includes(item.id)).map(item => item.frame),
    ]));
    // Reserve decoded pixels plus encoded bytes, rather than an unbounded count of large images.
    const capacity = Math.max(1, Math.floor(ORIGINAL_MEMORY_LIMIT / (info.width * info.height * 8)));
    const bounded = targets.slice(0, capacity);
    originalTargets.current = new Set(bounded);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled || quickFrameLock.current) return;
      originalQueue.current.background(bounded);
      void (async () => { for (const frame of bounded) {
        if (cancelled || Date.now() < interactionUntil.current) break;
        await loadFrame(frame, false, false);
      } })();
    }, Math.max(200, interactionUntil.current - Date.now()));
    const waiting = window.setTimeout(() => { if (!cancelled) setOriginalWaiting(true); }, 1200);
    return () => { cancelled = true; window.clearTimeout(timer); window.clearTimeout(waiting); setOriginalWaiting(false); };
    // Original requests update frames, not the target list, so completion cannot restart this queue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originalSignature, info, loadFrame, pageView, visible, quickFrame]);
  useEffect(() => {
    if (!visible || !previewState.manifest && !previewState.error) return;
    let cancelled = false;
    void (async () => { for (const frame of Array.from(new Set(frameSignature.split(',').filter(Boolean).map(Number)))) {
      if (cancelled) break;
      if (previewState.manifest) await loadPreviewFrame(frame);
    } })();
    return () => { cancelled = true; };
  }, [frameSignature, loadFrame, loadPreviewFrame, previewState.error, previewState.manifest, visible]);
  useEffect(() => {
    if (!draft?.editing || !visible || view.tab !== 'frames' || !previewState.manifest) return;
    const timer = window.setTimeout(() => {
      void loadPreviewFrame(editorFrame);
      for (const adjacent of [editorFrame - 2, editorFrame + 2]) if (adjacent >= 0 && adjacent < previewState.manifest!.totalFrames) void loadPreviewFrame(adjacent);
    }, 80);
    return () => window.clearTimeout(timer);
  }, [draft?.editing, editorFrame, loadPreviewFrame, previewState.manifest, view.tab, visible]);
  useEffect(() => {
    if (!draft) return;
    const keep = new Set([...draft.slots.map(item => item.frame), ...Array.from(scrubFrames.current), ...Object.values(quickPreview), ...(draft.editing ? [-2, -1, 0, 1, 2].map(delta => editorFrame + delta) : []), ...(preview !== null ? [preview] : [])]);
    let bytes = Object.values(frames).reduce((total, item) => total + (item.originalBytes || 0), 0) + Array.from(retiredOriginals.current.values()).reduce((a, b) => a + b, 0);
    const removable: number[] = [];
    for (const frame of Object.keys(frames).map(Number)) {
      if (frame === preview || scrubFrames.current.has(frame) || requests.current.has(frame) || previewFrameRequests.current.has(frame) || [frames[frame]?.url, frames[frame]?.previewUrl].some(url => url && usedUrls.current.has(url))) continue;
      if (!keep.has(frame) && (Object.keys(frames).length > 24 || bytes > ORIGINAL_MEMORY_LIMIT) || frames[frame]?.url && !originalTargets.current.has(frame) && bytes > ORIGINAL_MEMORY_LIMIT) { removable.push(frame); bytes -= frames[frame].originalBytes || 0; }
    }
    if (!removable.length) return;
    for (const frame of removable) for (const url of [frames[frame]?.url, frames[frame]?.previewUrl]) if (url) retireFrameUrl(url, url === frames[frame]?.url ? frames[frame].originalBytes : 0);
    frameRef.current = Object.fromEntries(Object.entries(frameRef.current).filter(([key]) => !removable.includes(Number(key)))); setFrames(frameRef.current);
  }, [draft, editorFrame, frames, preview, quickPreview, releasedPixels, retireFrameUrl]);
  const validSlots = draft?.slots.filter(item => frames[item.frame]?.previewUrl || frames[item.frame]?.url) || [];
  const dimensions = useMemo(() => info && draft ? multiviewDimensions(info, draft.slots.length, draft.layout) : null, [draft, info]);
  useEffect(() => {
    if (!visible || !validSlots.length || collapsedFor.current === storageKey) return;
    collapsedFor.current = storageKey;
    let explicitPreference = false;
    try { explicitPreference = localStorage.getItem(`sd2:multiview:preferences:v1:${owner}`) !== null; } catch {}
    if (!explicitPreference && !generationArea.current?.contains(document.activeElement)) setExpanded(false);
  }, [owner, storageKey, validSlots.length, visible]);

  // “用作参考图”: a saved work output becomes the editor's main image; nothing is generated.
  const [incomingMainAsset, setIncomingMainAsset] = useState<{ assetId: string; token: number } | null>(null);
  const [referenceNotice, setReferenceNotice] = useState('');
  function applyWorkAsReference(work: MultiviewWorkDto, role: string) {
    void (async () => {
      if (!owner || isClientSessionBlocked()) return;
      setReferenceNotice('正在把作品图片设为主图…');
      try {
        const response = await fetch(`/api/video/multiview/works/${encodeURIComponent(work.id)}/files/${encodeURIComponent(role)}/asset`,
          { cache: 'no-store', headers: { 'x-app-session-user': owner } });
        const payload = await response.json().catch(() => ({})) as { assetId?: unknown; error?: unknown };
        if (!response.ok || typeof payload.assetId !== 'string') throw new Error(typeof payload.error === 'string' ? payload.error : '作品图片暂不可用，请重试。');
        writeLocation('editor', editingWorkId); changeExpanded(true);
        setIncomingMainAsset({ assetId: payload.assetId, token: Date.now() });
      } catch (cause) { setReferenceNotice(cause instanceof Error ? cause.message : '作品图片暂不可用，请重试。'); }
    })();
  }
  function changeExpanded(value: boolean) {
    setExpanded(value);
    try { localStorage.setItem(`sd2:multiview:preferences:v1:${owner}`, JSON.stringify({ expanded: value })); } catch { setViewSaved(false); }
  }
  function update(next: MultiviewDraft, allowUndo = false, frameToken?: symbol, restoringUndo = false) {
    if (quickFrameLock.current && quickFrameLock.current !== frameToken) return;
    if (!restoringUndo && draft?.slots.some(item => item.locked && !next.slots.some(value => value.id === item.id && value.frame === item.frame))) {
      setNotice('请先解锁需要更换或移出的图片，锁定格保持不变。'); return;
    }
    if (JSON.stringify(draft) === JSON.stringify(next)) return;
    const changed = Boolean(draft && contentKey(owner, taskId, draft, 'png') !== contentKey(owner, taskId, next, 'png'));
    if (operation.current && changed) return;
    if (draft && (draft.slots.length !== next.slots.length || draft.slots.some(item => !next.slots.some(current => current.id === item.id)))) setReduceCount(null);
    if (allowUndo) setUndo(draft);
    if (changed) clearArtifacts();
    if (changed || draft && (JSON.stringify(draft.reserve) !== JSON.stringify(next.reserve) || JSON.stringify(draft.restoreOrder) !== JSON.stringify(next.restoreOrder))) setDraftEdited(true);
    draftRef.current = next; setDraft(next); if (!operation.current) setNotice(''); setSaved(false); setActivity(value => value + 1);
  }
  function chooseCount(count: number) {
    if (!draft || !info || quickFrameLock.current || count === draft.slots.length) return;
    const locked = draft.slots.filter(item => item.locked);
    if (count < locked.length) { setNotice(`已有 ${locked.length} 张锁定，请先解锁再减少数量。`); return; }
    if (count < draft.slots.length) { setReduceCount(count); setRetained([...locked, ...draft.slots.filter(item => !item.locked)].slice(0, count).map(item => item.id)); return; }
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
    if (!draft || quickFrameLock.current || index + delta < 0 || index + delta >= draft.slots.length) return;
    const slots = [...draft.slots]; [slots[index], slots[index + delta]] = [slots[index + delta], slots[index]];
    update({ ...draft, slots, restoreOrder: undefined }, true);
  }
  function beginScrub(id: string): MultiviewScrubSession | null {
    const before = draftRef.current;
    const item = before?.slots.find(value => value.id === id);
    if (item?.locked) return null;
    if (!before || before.editing || reduceCount !== null || !item || !visible || !info || operation.current || quickFrameLock.current || slotDrag.current || isClientSessionBlocked()) return null;
    const token = Symbol(); const generation = context.current; const sourceKey = sourceKeyRef.current;
    quickFrameLock.current = token; setQuickFrame(id);
    preferredOriginalSlot.current = id; originalQueue.current.background([], true);
    const current = () => quickFrameLock.current === token && generation === context.current && sourceKey === sourceKeyRef.current
      && before === draftRef.current && !isClientSessionBlocked() && !operation.current;
    let displayed = item.frame;
    return {
      preview: async frame => {
        if (!current() || !Number.isInteger(frame) || frame < 0 || frame >= info.timestamps.length) return null;
        scrubFrames.current = new Set([item.frame, displayed, frame]);
        const ready = await loadPreviewFrame(frame);
        if (!current() || !ready) return null;
        return frameRef.current[frame]?.previewUrl || null;
      },
      displayed: frame => { scrubFrames.current = new Set([item.frame, displayed, frame]); displayed = frame; },
      commit: frame => {
        if (!current()) return false;
        if (frame !== item.frame) {
          video.current?.pause();
          update({ ...before, slots: before.slots.map(value => value.id === id ? { ...value, frame, manual: true } : value),
            editing: before.editing === id ? null : before.editing }, true, token);
        }
        return true;
      },
      cancel: () => {
        if (quickFrameLock.current !== token) return;
        quickFrameLock.current = null; scrubFrames.current.clear();
        interactionUntil.current = Date.now() + 200; setQuickFrame(null);
      },
    };
  }
  async function renameSlot(item: MultiviewSlot, anchor: HTMLElement) {
    if (quickFrameLock.current || operation.current) return;
    const before = draftRef.current; const epoch = context.current;
    await prompt('方向名称', item.name, { title: '修改名称', anchor, maxLength: 40, allowEmpty: true,
      onSubmit: async name => {
        if (!before || before !== draftRef.current || epoch !== context.current || isClientSessionBlocked()) throw new Error('当前选帧已变化，请重新修改。');
        update({ ...before, slots: before.slots.map(value => value.id === item.id ? { ...value, name } : value) }, true);
      } });
  }
  function stepSlot(id: string, delta: -1 | 1) {
    const before = draftRef.current;
    const item = before?.slots.find(value => value.id === id);
    if (item?.locked) return;
    if (!before || !item || !info || !visible || operation.current || quickFrameLock.current && quickPreviewRef.current[id] === undefined || isClientSessionBlocked()) return;
    const frame = (quickPreviewRef.current[id] ?? item.frame) + delta;
    if (frame < 0 || frame >= info.timestamps.length) return;
    preferredOriginalSlot.current = id;
    interactionUntil.current = Date.now() + 200; originalQueue.current.background([], true);
    const token = Symbol(); const target = quickFrameGate.current.issue(frame);
    quickFrameLock.current = token; setQuickFrame(id);
    quickPreviewRef.current = { ...quickPreviewRef.current, [id]: frame }; setQuickPreview(quickPreviewRef.current);
    const generation = context.current; const sourceKey = sourceKeyRef.current;
    void loadPreviewFrame(frame).then(ready => {
        if (!quickFrameGate.current.isCurrent(target) || quickFrameLock.current !== token || generation !== context.current
          || sourceKey !== sourceKeyRef.current || before !== draftRef.current || isClientSessionBlocked() || operation.current) return;
        if (!ready) { setNotice('快速预览暂未就绪，原选帧保持不变；可稍后重试或打开换帧读取原帧。'); return; }
        video.current?.pause();
        update({ ...before, slots: before.slots.map(value => value.id === id ? { ...value, frame, manual: true } : value),
          editing: before.editing === id ? null : before.editing }, true, token);
      }).finally(() => {
        if (!quickFrameGate.current.isCurrent(target) || quickFrameLock.current !== token) return;
        quickFrameLock.current = null; setQuickFrame(null);
        setQuickPreview(value => { const next = { ...value }; delete next[id]; quickPreviewRef.current = next; return next; });
      });
  }
  function startSlotDrag(event: DragStartEvent) {
    const before = draftRef.current;
    if (!before || !visible || operation.current || quickFrameLock.current || isClientSessionBlocked()) return;
    slotDrag.current = { id: String(event.active.id), generation: context.current, sourceKey: sourceKeyRef.current, draft: before };
    suppressSlotClick.current = String(event.active.id);
  }
  function cancelSlotDrag() { if (slotDrag.current) suppressSlotClick.current = slotDrag.current.id; slotDrag.current = null; }
  function endSlotDrag(event: DragEndEvent) {
    const drag = slotDrag.current; cancelSlotDrag();
    if (!drag || !event.over || drag.id !== event.active.id || drag.generation !== context.current || drag.sourceKey !== sourceKeyRef.current
      || drag.draft !== draftRef.current || operation.current || isClientSessionBlocked()) return;
    const from = drag.draft.slots.findIndex(item => item.id === drag.id);
    const to = drag.draft.slots.findIndex(item => item.id === event.over!.id);
    if (from < 0 || to < 0 || from === to) return;
    update({ ...drag.draft, slots: arrayMove(drag.draft.slots, from, to), restoreOrder: undefined }, true);
    setNotice(`已移到第 ${to + 1} 张，可撤销本次排序。`);
  }
  function openEditor(item: MultiviewSlot) {
    if (!draft || quickFrameLock.current || item.locked) return;
    video.current?.pause(); setEditorMode('frame'); setEditorFrame(item.frame); setFrameInput(String(item.frame + 1)); setFrameInputError(''); setView(value => ({ ...value, tab: 'frames', selected: item.id }));
    if (video.current && info) video.current.currentTime = info.timestamps[item.frame];
    update({ ...draft, editing: item.id, editorFrame: item.frame });
    requestAnimationFrame(() => toolsArea.current?.scrollIntoView({ block: 'nearest', behavior: 'auto' }));
  }
  function selectSlot(item: MultiviewSlot) {
    preferredOriginalSlot.current = item.id;
    setView(value => ({ ...value, selected: item.id, tab: 'frames' })); setActivity(value => value + 1);
    if (draft?.editing && draft.editing !== item.id) openEditor(item);
  }
  function seek(frame: number) {
    if (!info) return;
    const value = Math.min(info.timestamps.length - 1, Math.max(0, frame));
    if (value !== editorFrame) { interactionUntil.current = Date.now() + 200; originalQueue.current.background([], true); }
    setEditorMode('frame'); setEditorFrame(value); setFrameInput(String(value + 1)); setFrameInputError(''); setSaved(false); setActivity(count => count + 1);
    setDraft(current => current ? { ...current, editorFrame: value } : current);
    if (video.current) { video.current.pause(); video.current.currentTime = info.timestamps[value]; }
  }
  function jumpToInput() {
    const frame = Number(frameInput);
    if (!info || !Number.isInteger(frame) || frame < 1 || frame > info.timestamps.length) {
      setFrameInputError(`请输入 1 到 ${info?.timestamps.length || 1} 的整数`); return;
    }
    seek(frame - 1);
  }
  function editorKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.target instanceof HTMLElement && event.target.matches('input, textarea, select, [contenteditable=true]')) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault(); seek(editorFrame + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 10 : 1));
    } else if (event.key === 'Home') { event.preventDefault(); seek(0); }
    else if (event.key === 'End' && info) { event.preventDefault(); seek(info.timestamps.length - 1); }
  }
  async function applySelectedFrame() {
    const before = draftRef.current;
    const selectedEditing = before?.slots.find(item => item.id === before.editing);
    if (!before || !selectedEditing || selectedEditing.locked || applyingFrame || exporting) return;
    const generation = context.current; setApplyingFrame(true);
    try {
      const ready = await loadFrame(editorFrame, true);
      if (!ready || generation !== context.current || before !== draftRef.current || isClientSessionBlocked()) {
        if (!ready && generation === context.current) setNotice('原尺寸帧暂未就绪，当前图片未替换；快速预览仍可继续选择。');
        return;
      }
      video.current?.pause();
      update({ ...before, slots: before.slots.map(item => item.id === selectedEditing.id ? { ...item, frame: editorFrame, manual: true } : item), editing: null }, true);
    } finally { if (generation === context.current) setApplyingFrame(false); }
  }
  async function selectTask(nextTask: string, automatic = false) {
    if (!safeTask(nextTask) || ownerRef.current !== owner || isClientSessionBlocked()) return;
    const selectionEpoch = context.current; const selectionAuthority = authorityRef.current;
    if (nextTask === taskId) { if (!automatic && !editingWorkId) setAllowWorkCreate(true); setPickerOpen(false); setPendingResult(null); writeLocation('editor', editingWorkId, nextTask); return; }
    if ((unsavedFrames || workState.unsaved) && !await confirm('本次修改尚未保存在此设备。切换会离开当前编辑内容，仍要切换吗？', { title: '切换视频', confirmLabel: '放弃并切换' })) return;
    if (ownerRef.current !== owner || selectionEpoch !== context.current || selectionAuthority !== authorityRef.current || isClientSessionBlocked()) return;
    if (operation.current && !await confirm('拼图仍在准备或复制。切换后停止使用本次临时文件，原选帧会保留。', { title: '切换视频', confirmLabel: '停止并切换' })) return;
    video.current?.pause(); context.current += 1; abort.current?.abort(); clearUrls();
    allowScrollRestore.current = !automatic;
    if (taskId && taskId !== nextTask) setPreviousTask(taskId);
    setEditorWork({ owner, id: '' }); setAllowWorkCreate(!automatic); setLocalPresent(false);
    setLocation({ owner, taskId: nextTask }); setActivity(count => count + 1); setPickerOpen(false); setPendingResult(null);
    writeLocation('editor', '', nextTask);
  }
  function generationReady(result: MultiviewGenerationReady) {
    if (result.ownerId !== ownerRef.current || isClientSessionBlocked()) return;
    const key = `${result.ownerId}:${result.requestKey}`;
    if (result.taskId === taskId) {
      seenReady.current.add(key);
      setPendingResult(value => value?.taskId === result.taskId ? null : value);
      return;
    }
    if (pageView !== 'editor') { setPendingResult(result); return; }
    if (seenReady.current.has(key) && !result.explicitOpen) return;
    seenReady.current.add(key);
    if (result.explicitOpen || !taskId && !editingWorkId && !operation.current && !quickFrameLock.current && !slotDrag.current && result.startedFromSourceKey === sourceKeyRef.current) void selectTask(result.taskId, !result.explicitOpen); else setPendingResult(result);
  }
  function finishOperation(op: ArtifactOperation) { if (operation.current?.token === op.token) { operation.current = null; setExporting(false); } }
  function beginArtifact(format: 'png' | 'zip', selected: MultiviewSlot[]) {
    if (!draft || !info || !visible || operation.current || quickFrameLock.current || !selected.length) return null;
    const frozen = selected.map(item => ({ ...item }));
    const op: ArtifactOperation = { token: Symbol(), generation: context.current, controller: new AbortController(),
      key: contentKey(owner, taskId, draft, format, frozen), owner, authority, taskId, mediaBase, version: info.sourceVersion, format, slots: frozen, layout: { ...draft.layout } };
    operation.current = op; setExporting(true); setNotice(format === 'png' ? '正在准备原尺寸拼图…' : '正在准备原尺寸单图包…'); return op;
  }
  function checkOperation(op: ArtifactOperation) {
    if (op.controller.signal.aborted || op.generation !== context.current || op.owner !== ownerRef.current || op.authority !== authorityRef.current || isClientSessionBlocked()) throw new Error('账号或视频已变化，本次文件不再使用');
  }
  async function artifactFor(op: ArtifactOperation): Promise<Artifact> {
    checkOperation(op);
    const fresh = await fetch(op.mediaBase, { cache: 'no-store', headers: { 'x-app-session-user': op.owner }, signal: AbortSignal.any([op.controller.signal, AbortSignal.timeout(120000)]) });
    const metadata = await fresh.json(); checkOperation(op);
    if (!fresh.ok || metadata.info?.sourceVersion !== op.version) {
      if ([401, 403, 404, 409].includes(fresh.status) || fresh.ok) rejectSource(metadata.error || '原视频权限或版本已变化，请重新读取');
      throw new Error(metadata.error || '暂时无法核对原视频，请稍后重试');
    }
    const cached = artifacts.current.get(op.key); if (cached) return cached;
    const existing = artifactInflight.current.get(op.key); if (existing) return existing;
    const pending = (async () => {
      const response = await fetch(op.mediaBase, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-app-session-user': op.owner },
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
    if (!draft) return;
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
    if (draftRef.current?.slots.some(item => item.locked)) { setNotice('请先解锁图片，再重置本机选帧。'); return; }
    if (operation.current || workState.pending || workState.busy || !await confirm(workState.work ? '清除此设备的选帧修改和浏览设置，回到作品已保存的选帧？服务器作品、原视频及生成记录不会删除。' : '清除此账号当前视频在本机的选帧、名称、排序和排版？服务器原视频及生成记录不会删除，生成设置也保留。', { title: '清除本机选帧', confirmLabel: '清除本机修改', danger: true })) return;
    if (!info) return;
    try { localStorage.removeItem(storageKey); localStorage.removeItem(viewKey); } catch { setViewSaved(false); }
    unreadLocalKey.current = '';
    if (workState.work?.recipe) workState.openServer(); else { clearArtifacts(); update(initialDraft(info)); }
    setView(emptyView()); setOriginalOpen(false); setUndo(null); setEditorFrame(0); setReduceCount(null);
  }
  const editing = draft?.slots.find(item => item.id === draft.editing);
  function branchWork(anchor?: HTMLElement) {
    if (!workState.canBranch) return;
    const before = context.current;
    void prompt('方案名称', workState.title || '3D多视图', { title: '另存为', maxLength: 120, anchor,
      onSubmit: async name => {
        if (!name.trim()) throw new Error('请填写方案名称。');
        if (before !== context.current || isClientSessionBlocked()) throw new Error('当前方案已变化，请重新打开。');
        await workState.branch(name.trim());
      } });
  }
  const selected = draft?.slots.find(item => item.id === view.selected) || draft?.slots[0];
  const selectedIndex = draft && selected ? draft.slots.indexOf(selected) : 0;
  const currentFrame = frames[editorFrame];
  const previewManifest = previewState.manifest;
  const atlasUrl = (frame: number) => previewManifest ? previewState.urls[multiviewPreviewChunkIndex(frame)] : undefined;
  const frameVisual = (frame: number, alt: string, className?: string) => frames[frame]?.previewUrl || frames[frame]?.url
    ? <img src={frames[frame].previewUrl || frames[frame].url} alt={alt} draggable={false} />
    : previewManifest && atlasUrl(frame) ? <AtlasFrame manifest={previewManifest} url={atlasUrl(frame)!} frame={frame} alt={alt} className={className} /> : null;
  const displayScope = JSON.stringify([authority, taskId, info?.sourceVersion, context.current]);
  const originalMemory = Object.values(frames).reduce((total, item) => total + (item.originalBytes || 0), 0) + Array.from(retiredOriginals.current.values()).reduce((a, b) => a + b, 0);
  const stableFrameVisual = (frame: number, alt: string, fallback: ReactNode) => <MultiviewFrameImage key={displayScope}
    src={(originalMemory <= ORIGINAL_MEMORY_LIMIT || originalTargets.current.has(frame) || preview === frame ? frames[frame]?.url : undefined) || frames[frame]?.previewUrl} alt={alt}
    onUsage={trackFrameUrl}
    onFailure={url => { if (frameRef.current[frame]?.url === url) { retireFrameUrl(url, frameRef.current[frame].originalBytes); frameRef.current = { ...frameRef.current, [frame]: { ...frameRef.current[frame], url: undefined, blob: undefined, localFrame: undefined, originalBytes: undefined, error: '原尺寸画面未完整显示，可重试这一格' } }; setFrames(frameRef.current); } }}
    >{fallback}</MultiviewFrameImage>;
  const playerEpoch = context.current;
  const mediaCurrent = () => playerEpoch === context.current && authorityRef.current === authority && !isClientSessionBlocked();
  const player = info && <div className={styles.videoArea} style={{ '--mv-video-ratio': info.width / info.height } as CSSProperties}>
    <div className={editing && editorMode === 'frame' ? styles.editorStage : styles.originalStage}>
    {editing && editorMode === 'frame' && <button type="button" className={styles.candidate} disabled={!currentFrame?.url && !currentFrame?.previewUrl && !atlasUrl(editorFrame)} onClick={() => void openFramePreview(editorFrame)} aria-label="放大待选帧">{stableFrameVisual(editorFrame, '待选帧，尚未应用', <span>{previewState.loading ? '正在准备快速预览…' : currentFrame?.previewError || currentFrame?.error || previewState.error || '正在读取预览…'}</span>)}</button>}
    {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
    <video ref={video} src={source} hidden={Boolean(editing && editorMode !== 'video')} controls playsInline preload="metadata" loop={loop.enabled}
      onLoadedMetadata={event => { if (!mediaCurrent()) return; event.currentTarget.pause(); event.currentTarget.currentTime = Math.min(info.duration, editing ? info.timestamps[editorFrame] : viewRef.current.time); }}
      onTimeUpdate={event => { if (!mediaCurrent()) return; const time = event.currentTarget.currentTime; setView(value => Math.abs(value.time - time) >= 1 ? { ...value, time } : value); }}
      onPause={event => {
        if (!mediaCurrent()) return;
        const time = event.currentTarget.currentTime; setView(value => ({ ...value, time }));
        if (!editing || operation.current) return;
        let nearest = 0; for (let i = 1; i < info.timestamps.length; i++) if (Math.abs(info.timestamps[i] - time) < Math.abs(info.timestamps[nearest] - time)) nearest = i;
        setEditorFrame(nearest); setDraft(current => current ? { ...current, editorFrame: nearest } : current);
      }} />
    </div>
    <div className={styles.videoToolbar}>
    {editing && <div className={styles.toolTabs} role="group" aria-label="预览方式">
      <button type="button" aria-pressed={editorMode === 'frame'} onClick={() => { video.current?.pause(); setEditorMode('frame'); }}><Images size={15} />帧预览</button>
      <button type="button" aria-pressed={editorMode === 'video'} onClick={() => setEditorMode('video')}><Film size={15} />原视频</button>
    </div>}
    <VideoLoopButton enabled={loop.enabled} onToggle={loop.toggle} disabled={!loop.ready} storageUnavailable={loop.storageUnavailable} />
    <small>原视频实际版本／原生成轮次未知 · 原视频预览，不会重新生成</small></div>
  </div>;
  function collage(slots: MultiviewSlot[]) {
    if (!info || !draft || !slots.length) return null;
    const size = multiviewDimensions(info, slots.length, draft.layout); const columns = Math.min(slots.length, draft.layout.columns);
    return <DndContext sensors={sortSensors} collisionDetection={closestCenter} onDragStart={startSlotDrag} onDragEnd={endSlotDrag} onDragCancel={cancelSlotDrag}
      accessibility={{ screenReaderInstructions: { draggable: '在图片上按空格开始排序，方向键移动，再按空格完成；Escape 取消。Enter 选择图片。' },
        announcements: { onDragStart: () => '已开始图片排序。', onDragOver: ({ over }) => over ? `目标位置：第 ${slots.findIndex(item => item.id === over.id) + 1} 张。` : '请移动到拼图内。',
          onDragEnd: () => '排序操作已结束。', onDragCancel: () => '已取消排序。' } }}>
    <SortableContext items={slots.map(item => item.id)} strategy={rectSortingStrategy}>
    <div className={styles.frameGrid} role="group" aria-label={`${slots.length} 张最终拼图，${size.width}乘${size.height}像素；图片可拖放排序`}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: `calc(100cqw * ${draft.layout.gap / size.width})`, padding: `calc(100cqw * ${draft.layout.margin / size.width})`, background: draft.layout.background }}>
      {slots.map((item, index) => <SortableFrame key={item.id} id={item.id} disabled={exporting || quickFrame !== null || referenceSelection !== null}>
        {({ attributes, listeners, setActivatorNodeRef }) => { const displayFrame = quickPreview[item.id] ?? item.frame; return <><button type="button" ref={setActivatorNodeRef} {...attributes} {...listeners}
          className={styles.frameImage} style={{ aspectRatio: `${info.width} / ${info.height}` }} aria-pressed={referenceSelection ? referenceSelection.includes(item.id) : selected?.id === item.id}
          aria-label={`选择第 ${index + 1} 张${item.name ? `：${item.name}` : ''}，长按或拖放排序，空格开始键盘排序，Alt加左右方向键调整顺序`} aria-keyshortcuts="Space Alt+ArrowLeft Alt+ArrowRight"
          disabled={exporting || quickFrame !== null} onMouseDown={event => { suppressSlotClick.current = ''; listeners?.onMouseDown?.(event); }}
          onTouchStart={event => { suppressSlotClick.current = ''; listeners?.onTouchStart?.(event); }}
          onKeyDown={event => {
            if (referenceSelection !== null) return;
            if (event.key === 'Enter') suppressSlotClick.current = '';
            if (event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key) && !slotDrag.current) { event.preventDefault(); move(index, event.key === 'ArrowLeft' ? -1 : 1); return; }
            listeners?.onKeyDown?.(event);
          }}
          onClick={() => { if (referenceSelection !== null) { setReferenceSelection(value => value?.includes(item.id) ? value.filter(id => id !== item.id) : value && value.length < 4 ? [...value, item.id] : value); return; } if (suppressSlotClick.current === item.id) { suppressSlotClick.current = ''; return; } selectSlot(item); }}>
          {referenceSelection !== null && <span className={styles.referenceCheck}>{referenceSelection.includes(item.id) ? '✓' : index + 1}</span>}{stableFrameVisual(displayFrame, item.name || `第 ${index + 1} 张时间候选`, <span>{frames[displayFrame]?.error || frames[displayFrame]?.previewError ? '这一帧预览未就绪' : '正在读取预览…'}</span>)}
        </button>
        <MultiviewFrameControls frame={displayFrame} name={item.name} index={index} timestamps={info.timestamps}
          locked={item.locked} onToggleLock={() => update({ ...draft, slots: draft.slots.map(value => value.id === item.id ? { ...value, locked: !value.locked } : value) }, true)}
          onUsage={trackFrameUrl}
          scope={`${authority}:${taskId}:${info.sourceVersion}:${visible}:${pageView}`}
          disabled={referenceSelection !== null || exporting || applyingFrame || Boolean(draft?.editing) || reduceCount !== null || Boolean(quickFrame && quickFrame !== item.id)}
          onBegin={() => beginScrub(item.id)} onName={anchor => void renameSlot(item, anchor)}
          onStep={delta => stepSlot(item.id, delta)} onEdit={() => openEditor(item)}
          copying={copyingFrame === item.id} onCopy={() => copySlotFrame(item)}
          onZoom={() => void openFramePreview(item.frame, item.id)} /></>; }}
      </SortableFrame>)}
    </div></SortableContext></DndContext>;
  }

  return <div className={styles.page}>
    <PageBanner title="3D多视图" description="旋转选帧、参考拼图与动作视频。" backHref={backHref} backLabel={taskId ? '返回原视频' : '返回创作首页'} />
    <div className={styles.pageTabs} aria-label="3D多视图区域"><button type="button" aria-pressed={pageView === 'editor'} onClick={() => writeLocation('editor', editingWorkId)}><WandSparkles size={16} />工作台</button><button type="button" aria-pressed={pageView !== 'editor'} disabled={exporting || workState.busy || Boolean(generation.leavingBusy)} onClick={() => { setReferenceLibrary(false); video.current?.pause(); writeLocation('generations'); }}><History size={16} />记录{['submitting', 'submitted', 'unknown'].includes(generation.phase) && <span className={styles.tabBadge}>进行中</span>}</button><button type="button" aria-pressed={pageView === 'works' && referenceLibrary} onClick={()=>{writeLocation('works');setReferenceLibrary(true);const url=new URL(window.location.href);url.searchParams.set('kind','reference');window.history.replaceState(window.history.state,'',url.pathname+url.search);}}>动作作品</button></div>
    <div hidden={pageView !== 'generations'}><MultiviewRecords key={`${owner}:${authority}`} owner={owner} authority={authority} active={pageView === 'generations' && sessionReady}
      onTask={id => void selectTask(id)} onWork={(id, sourceTask) => void openSavedWork(id, sourceTask)} onManage={id => writeLocation('works', id)} onDraft={() => writeLocation('editor', editingWorkId)} onUseReference={applyWorkAsReference} /></div>
    {pageView === 'works' && <MultiviewWorks key={referenceLibrary?'reference':'ordinary'} kind={referenceLibrary?'reference':undefined} owner={owner} authority={authority} initialWorkId={query.get('workId') || undefined}
      onEdit={(work: MultiviewWorkDto) => { void (async () => {
        if (!owner || isClientSessionBlocked()) return;
        const selectionEpoch = context.current; const selectionAuthority = authorityRef.current;
        if ((unsavedFrames || workState.unsaved) && !await confirm('当前编辑内容尚未保存在此设备，仍要打开另一件作品吗？', { title: '打开作品', confirmLabel: '放弃并打开' })) return;
        if (ownerRef.current !== owner || selectionEpoch !== context.current || selectionAuthority !== authorityRef.current || isClientSessionBlocked()) return;
        if (work.recipe?.schema === 3) { setLocation({ owner, taskId: work.sourceTaskId }); setReferenceEditor({ scope: `${authority}:${work.sourceTaskId}:${work.sourceVersion}`, slots: work.recipe.slots, workId: work.id, info: work.info || undefined }); writeLocation('editor', work.parentWorkId || '', work.sourceTaskId); return; }
        setEditorWork({ owner, id: work.id }); setLocation({ owner, taskId: work.sourceTaskId }); setAllowWorkCreate(false); writeLocation('editor', work.id, work.sourceTaskId);
      })(); }}
      onNew={() => writeLocation('editor', editingWorkId)} onUseReference={applyWorkAsReference} />}
    {referenceNotice && <div className={styles.notice} role="status">{referenceNotice}</div>}
    <div hidden={pageView !== 'editor'}>
    {!shareId && <div ref={generationArea} hidden={referenceActive}><MultiviewGenerationPanel currentSourceKey={currentSourceKey} currentTaskId={visible ? taskId : undefined} hasResult={Boolean(visible)} expanded={expanded} onExpandedChange={changeExpanded}
      onActionSettings={value => setActionDefaults({owner,...value})} onUseExisting={() => setPickerOpen(true)} onReady={generationReady} onStateChange={setGeneration}
      initialProjectId={query.get('projectId') || undefined} initialVideoCardId={query.get('videoCardId') || undefined}
      incomingMainAsset={incomingMainAsset} onIncomingMainAssetDone={result => setReferenceNotice(result.success ? '已把作品图片设为主图，未开始生成。' : result.message || '主图未替换，请重试。')} /></div>}
    {!shareId && <MultiviewGenerationProgress state={generation.progress} taskId={generation.taskId}
      preparing={generation.taskId === taskId && (loading || previewState.loading)}
      previewReady={Boolean(generation.taskId === taskId && visible && validSlots.length > 0)} />}
    {!shareId && pendingResult && pendingResult.ownerId === owner && pendingResult.taskId !== taskId && <div className={styles.notice} role="status">新视频已就绪，当前选帧未被覆盖。<button type="button" onClick={() => void selectTask(pendingResult.taskId)}>打开新结果</button></div>}
    {!shareId && previousTask && previousTask !== taskId && <button type="button" className={styles.quiet} onClick={() => void selectTask(previousTask)}>返回上次结果</button>}
    {loading && <p className={styles.empty} role="status">正在核对原视频并读取候选图片…</p>}
    {error && <div className={styles.empty} role="status"><p>{error}</p><button type="button" onClick={() => void load()}>重新读取原视频</button><button type="button" onClick={() => setPickerOpen(true)}>使用已有视频</button></div>}
    {editingWorkId && !workState.work && <div className={styles.notice} role="status">{workState.loading ? '正在读取指定作品…' : workState.message || '指定作品尚未读取，当前生成设置保留。'}{!workState.loading && <button type="button" onClick={workState.retry}>重新读取作品</button>}</div>}
    {referenceActive && referenceEditor && referenceInfo && <MultiviewReferenceComposer key={`${referenceScope}:${referenceEditor.workId || referenceEditor.slots.map(slot=>slot.id).join(',')}`} ownerId={owner} authority={authority} taskId={taskId} info={referenceInfo} slots={referenceEditor.slots} mediaBase={referenceEditor.workId ? `/api/video/multiview/works/${referenceEditor.workId}/source` : mediaBase} initialWorkId={referenceEditor.workId} videoDefaults={actionDefaults?.owner === owner ? actionDefaults : undefined} access={shareId ? { kind: 'share', id: shareId } : editingWorkId ? { kind: 'work', id: editingWorkId } : undefined} onWorkBound={id => {currentReferenceWork.current=id;}} onBack={() => {currentReferenceWork.current='';setReferenceEditor(null);const url=new URL(window.location.href);url.searchParams.delete('referenceWorkId');window.history.replaceState(window.history.state,'',url.pathname+url.search);}} />}
    {!referenceActive && visible && info && draft && (!editingWorkId || workState.work?.id === editingWorkId && workState.work.sourceTaskId === taskId) && <section ref={bindResultArea} className={styles.result} style={{ '--export-height': `${dock?.height ?? 88}px`, '--tool-height': `${dock?.toolHeight ?? 600}px` } as CSSProperties} aria-label="3D多视图成品工作台">
      <header className={styles.resultHeader}><h2>{shared?.title || (workState.work ? workState.title || '未命名作品' : '3D多视图作品')}</h2>
        {workState.work && <button type="button" title="修改作品名称" aria-label="修改作品名称" disabled={workState.busy || workState.pending || Boolean(quickFrame)} onClick={event => {
          const epoch = context.current; const id = workState.work!.id;
          void prompt('作品名称', workState.title, { title: '修改名称', anchor: event.currentTarget, maxLength: 120,
            onSubmit: async name => { if (!name.trim()) throw new Error('请填写作品名称。'); if (epoch !== context.current || workState.work?.id !== id || isClientSessionBlocked()) throw new Error('当前作品已变化，请重新修改。'); workState.setTitle(name.trim()); setActivity(value => value + 1); } });
        }}><Pencil size={14} /></button>}
      </header>
      {shareId ? <div className={styles.workStatus}>
        <button type="button" disabled={!shared || sharedOperation.busy || Boolean(sharedOperation.pending) || exporting || Boolean(quickFrame)} onClick={event => {
          const before = context.current;
          void prompt('方案名称', shared?.title || '3D多视图', { title: '另存为我的方案', maxLength: 120, anchor: event.currentTarget, onSubmit: async title => {
            if (!title.trim() || before !== context.current || !shared) throw new Error('当前方案已变化，请重新打开。');
            const recipe = appliedWorkRecipe(draftRef.current, info); if (!recipe) throw new Error('当前选帧不可保存。');
            await sharedOperation.send({ action: 'branch', shareId, title: title.trim(), recipe });
          } });
        }}>另存为我的方案</button>
        {sharedOperation.pending && <button type="button" disabled={sharedOperation.busy} onClick={() => void sharedOperation.query()}>查询原另存</button>}
        {sharedOperation.canResume && <button type="button" disabled={sharedOperation.busy} onClick={() => void sharedOperation.resume()}>恢复原另存</button>}
        {sharedOperation.error && <p role="status">{sharedOperation.error}</p>}
      </div> : <div className={styles.workStatus}>
        <span role="status">{workState.loading ? '正在读取作品…' : workState.phase === 'saved' ? '已保存到我的作品' : workState.phase === 'saving' ? '正在确认保存…' : workState.phase === 'unknown' ? '保存结果待确认' : workState.phase === 'preparing' ? workState.work?.recipe ? '选帧已保存，正在准备拼图' : '作品正在准备，当前修改仅此设备保留' : workState.phase === 'failed' ? '选帧已保存，拼图准备未完成' : '仅此设备保留，尚未保存到作品'}</span>
        {workState.pending ? <button type="button" disabled={workState.busy} onClick={() => void workState.queryOriginal()}>查询原保存</button>
          : workState.conflict ? <><button type="button" disabled={!workState.canSaveCurrent || exporting || Boolean(quickFrame) || applyingFrame} onClick={() => void workState.saveCurrent()}>保存到原作品</button><button type="button" disabled={workState.busy || exporting || Boolean(quickFrame) || applyingFrame || !workState.work?.recipe || workState.work.sourceVersion !== info.sourceVersion} onClick={workState.openServer}>打开服务器版本</button><button type="button" disabled={!workState.canBranch || exporting || Boolean(quickFrame) || applyingFrame} onClick={event => branchWork(event.currentTarget)}>将此设备修改另存一版</button></>
            : <button type="button" disabled={workState.busy || workState.loading || Boolean(quickFrame) || exporting || applyingFrame || Boolean(workState.work && !workState.canSaveCurrent)} onClick={() => { setAllowWorkCreate(true); void (workState.work ? workState.saveCurrent() : workState.create()); }}>保存</button>}
        {workState.work && !workState.title.trim() && <p role="status">请填写作品名称，当前修改尚未保存到作品。</p>}
        {workState.canRetrySave && <button type="button" onClick={workState.retrySave}>{workState.work?.status === 'failed' ? '重新准备拼图' : '重试保存当前修改'}</button>}
        {workState.message && <p role="status">{workState.message}<button type="button" className={styles.quiet} disabled={workState.busy} onClick={workState.retry}>重新核对作品</button></p>}
        {workState.work && <button type="button" onClick={() => setShareOpen(true)}>分享</button>}
      </div>}
      {reduceCount !== null && <section className={styles.retain} aria-label="选择保留图片"><h3>保留哪 {reduceCount} 张？</h3><p>其余留在本次草稿，增加数量或撤销时可找回。</p><div className={styles.retainOptions}>{draft.slots.map((item, index) => <label key={item.id}><input type="checkbox" checked={retained.includes(item.id)} disabled={Boolean(item.locked)} onChange={event => setRetained(value => event.target.checked ? [...value, item.id] : value.filter(id => id !== item.id))} />第 {index + 1} 张{item.locked ? ' · 已锁定' : item.manual ? ' · 已手选' : ''}{item.name && ` · ${item.name}`}</label>)}</div><button type="button" className={styles.primary} disabled={retained.length !== reduceCount} onClick={() => {
        const slots = draft.slots.filter(item => retained.includes(item.id));
        const reserve = [...draft.slots.filter(item => !retained.includes(item.id)), ...draft.reserve].slice(0, 16);
        const restoreOrder = preservedSlotOrder(draft.restoreOrder || [...draft.slots, ...draft.reserve].map(item => item.id), slots, reserve);
        update({ ...draft, slots, reserve, restoreOrder, editing: null }, true); setReduceCount(null);
      }}>保留所选 {retained.length} 张</button><button type="button" onClick={() => setReduceCount(null)}>取消</button></section>}
      <div className={styles.commandBar} aria-label="拼图工具">
        {!shareId && (referenceSelection === null ? <button type="button" className={styles.primary} disabled={exporting || Boolean(quickFrame) || Boolean(draft.editing)} onClick={() => { video.current?.pause(); setReferenceSelection([]); }}>制作动作视频</button> : <><strong>已选 {referenceSelection.length}/4</strong><button type="button" className={styles.primary} disabled={referenceSelection.length < 2} onClick={() => { setReferenceEditor({ scope: referenceScope, info, slots: referenceSelection.map(id => draft.slots.find(slot => slot.id === id)!).filter(Boolean) }); setReferenceSelection(null); }}>使用所选图片</button><button type="button" onClick={() => setReferenceSelection(null)}>取消选择</button></>)}
        <div className={styles.toolTabs} role="tablist" aria-label="拼图设置"><button type="button" id="mv-frames-tab" role="tab" aria-controls="mv-frames-panel" aria-selected={view.tab === 'frames' && !originalOpen} onClick={() => { video.current?.pause(); setOriginalOpen(false); setView(value => ({ ...value, tab: 'frames', originalOpen: false })); }}>选帧</button><button type="button" id="mv-layout-tab" role="tab" aria-controls="mv-layout-panel" aria-selected={view.tab === 'layout' && !originalOpen} onClick={() => { video.current?.pause(); setOriginalOpen(false); setView(value => ({ ...value, tab: 'layout', originalOpen: false })); }}>排版</button></div>
        <button type="button" aria-pressed={editing ? editorMode === 'video' : originalOpen} onClick={() => { if (editing) setEditorMode(value => value === 'video' ? 'frame' : 'video'); else { const open = !originalOpen; setOriginalOpen(open); setView(value => ({ ...value, originalOpen: open })); } }}>查看原视频</button>
        <div className={styles.commandSpacer} />
        <div className={styles.count} aria-label="图片数量">{[3, 4, 8].map(count => <button type="button" key={count} aria-pressed={draft.slots.length === count} disabled={referenceSelection !== null || exporting || Boolean(quickFrame)} onClick={() => chooseCount(count)}>{count} 张</button>)}</div>
        <label className={styles.displaySize}>显示<select aria-label="拼图显示大小" value={view.zoom} onChange={event => setView(value => ({ ...value, zoom: Number(event.target.value) }))}>{[.5, .75, 1, 1.5, 2, 3, 4].map(zoom => <option value={zoom} key={zoom}>{zoom === 1 ? '适合窗口' : `${zoom * 100}%`}</option>)}</select></label>
        {undo && <button type="button" title="撤销" aria-label="撤销" disabled={exporting || Boolean(quickFrame)} onClick={() => { const value = undo; update(value, false, undefined, true); setUndo(null); }}><Undo2 size={14} /></button>}
        <ProductActionMenu label="更多作品操作" disabled={exporting || Boolean(quickFrame) || workState.busy || workState.pending} actions={[
          { id: 'branch', label: '另存为', disabled: Boolean(shareId) || !workState.canBranch, onSelect: () => branchWork() },
          { id: 'order', label: '恢复顺序', disabled: !draft.restoreOrder?.length, onSelect: () => update({ ...draft, slots: [...draft.slots].sort((a, b) => draft.restoreOrder!.indexOf(a.id) - draft.restoreOrder!.indexOf(b.id)) }, true) },
          { id: 'view', label: '重置浏览设置', onSelect: () => { video.current?.pause(); setOriginalOpen(false); setView(emptyView()); } },
          { id: 'clear', label: '清除本机选帧', danger: true, onSelect: () => void clearWorkspace() },
        ]} />
      <div className={styles.frameSettingsRow}><MultiviewFrameSettingsPanel ownerId={owner} authorityKey={authority} taskId={taskId} info={info} draft={draft}
        access={shareId ? { kind: 'share', id: shareId } : editingWorkId ? { kind: 'work', id: editingWorkId } : undefined}
        disabled={referenceSelection !== null || !visible || exporting || workState.busy || workState.pending || Boolean(quickFrame) || applyingFrame || Boolean(generation.leavingBusy)}
        binding={view.frameSettingsBinding} onApply={(next, binding) => {
          if (!visible || operation.current || quickFrameLock.current || applyingFrame || ownerRef.current !== owner || authorityRef.current !== authority || isClientSessionBlocked()
            || draftRef.current?.sourceVersion !== next.sourceVersion) return;
          update(next, true); setView(value => ({ ...value, frameSettingsBinding: binding }));
        }} onSavedBinding={binding => setView(value => ({ ...value, frameSettingsBinding: binding }))}
        onReset={() => setView(value => ({ ...value, frameSettingsBinding: undefined }))} /></div>
      </div>
      {originalOpen && !editing && <section className={styles.originalPanel} aria-label="原视频">{player}</section>}
      <div className={styles.workbench}>
        <div className={styles.resultMain}><div className={styles.previewToolbar}><span>拼图预览</span><span role="status">{draft.slots.some(item => frames[item.frame]?.error) ? <>部分清晰画面未就绪 <button type="button" onClick={() => { for (const item of draft.slots) if (frames[item.frame]?.error) void loadFrame(item.frame, true); }}><RefreshCw size={13} />重试</button></> : originalWaiting && draft.slots.some(item => originalTargets.current.has(item.frame) && !frames[item.frame]?.url) ? `正在补清晰画面 ${draft.slots.filter(item => frames[item.frame]?.url).length}/${draft.slots.length}` : previewState.loading ? '正在准备快速选帧…' : previewState.error && !previewState.manifest ? '快速预览不可用，保留原帧读取' : ''}</span></div>
          <div ref={collageViewport} className={styles.collageViewport}><div className={styles.collage} style={{ width: `${view.zoom * 100}%` }}>{collage(draft.slots)}</div></div>
        </div>
        {toolsOpen && <div ref={toolsBackdrop} className={styles.toolsBackdrop}><aside ref={toolsArea} className={`${styles.tools} ${!editing ? styles.layoutTools : ''}`} role="dialog" aria-modal="true" aria-label={editing ? '精调选帧' : '拼图排版'}>
          <header className={styles.toolsHeader}><h3>{editing ? '精调选帧' : '拼图排版'}</h3><button type="button" title="关闭" aria-label="关闭" disabled={applyingFrame} onClick={closeTools}><X size={16} /></button></header>
          <fieldset className={styles.toolFields} disabled={Boolean(quickFrame)}>
          {view.tab === 'frames' && selected && <div role="tabpanel" id="mv-frames-panel" aria-labelledby="mv-frames-tab" className={styles.toolBody}>
            <header className={styles.selectionTitle}><h3>第 {selectedIndex + 1} 张</h3><span>{info.timestamps[selected.frame].toFixed(3)} 秒{selected.manual ? ' · 已手选' : ''}</span></header>
            {(frames[selected.frame]?.error || frames[selected.frame]?.previewError) && <div className={styles.frameError} role="status">{frames[selected.frame].error || frames[selected.frame].previewError}<button type="button" onClick={() => { void loadPreviewFrame(selected.frame); void loadFrame(selected.frame, true); }}><RefreshCw size={13} />重试这一格</button></div>}
            {!editing && <button type="button" className={styles.primary} onClick={() => openEditor(selected)}>换一帧</button>}
            {editing && <section className={styles.editor} aria-label={`替换第 ${draft.slots.indexOf(editing) + 1} 张`} tabIndex={-1} onKeyDown={editorKeyDown}><header><h3>替换第 {draft.slots.indexOf(editing) + 1} 张</h3><button type="button" aria-label="取消换帧" onClick={() => update({ ...draft, editing: null })}><X size={16} /></button></header>
              {player}<label className={styles.timeline}>第 {editorFrame + 1} / {info.timestamps.length} 帧 · {info.timestamps[editorFrame].toFixed(3)} 秒<input aria-label="选择视频帧" aria-valuetext={`第 ${editorFrame + 1} 帧，${info.timestamps[editorFrame].toFixed(3)} 秒`} type="range" min={0} max={info.timestamps.length - 1} step={1} value={editorFrame} onChange={event => seek(Number(event.target.value))} /></label>
              <div className={styles.neighbors}>{[-2, -1, 0, 1, 2].map(delta => editorFrame + delta).filter(frame => frame >= 0 && frame < info.timestamps.length).map(frame => <button type="button" key={frame} aria-pressed={frame === editorFrame} onClick={() => seek(frame)}>{frameVisual(frame, `第 ${frame + 1} 帧`, styles.atlasThumb)}<span>{frame === editorFrame ? '当前' : frame < editorFrame ? `前 ${editorFrame - frame}` : `后 ${frame - editorFrame}`}</span></button>)}</div>
              <div className={styles.frameStepper}><button type="button" disabled={editorFrame === 0} onClick={() => seek(editorFrame - 10)} aria-label="向前十帧">−10</button><button type="button" disabled={editorFrame === 0} onClick={() => seek(editorFrame - 1)}><ArrowLeft size={15} />上一帧</button><label>指定帧<input type="number" min={1} max={info.timestamps.length} value={frameInput} aria-invalid={Boolean(frameInputError)} onChange={event => { setFrameInput(event.target.value); setFrameInputError(''); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); jumpToInput(); } }} />{frameInputError && <span role="status">{frameInputError}</span>}</label><button type="button" onClick={jumpToInput}>跳到</button><button type="button" disabled={editorFrame === info.timestamps.length - 1} onClick={() => seek(editorFrame + 1)}>下一帧<ArrowRight size={15} /></button><button type="button" disabled={editorFrame === info.timestamps.length - 1} onClick={() => seek(editorFrame + 10)} aria-label="向后十帧">+10</button>{currentFrame?.error && <button type="button" onClick={() => void loadFrame(editorFrame, true)}>重试原帧</button>}</div>
            </section>}
          </div>}
          {view.tab === 'layout' && <div role="tabpanel" id="mv-layout-panel" aria-labelledby="mv-layout-tab" className={styles.toolBody}><h3>拼图排版</h3><label>拼图列数<select value={draft.layout.columns} disabled={exporting} onChange={event => update({ ...draft, layout: { ...draft.layout, columns: Number(event.target.value) } })}>{[1, 2, 3, 4, 8].map(value => <option key={value} value={value}>{value} 列</option>)}</select></label>
            <label>外侧留白（像素）<input type="number" min={0} max={128} step={1} value={draft.layout.margin} disabled={exporting} onChange={event => update({ ...draft, layout: { ...draft.layout, margin: Math.round(Math.max(0, Math.min(128, Number(event.target.value) || 0))) } })} /></label><label>图片间距（像素）<input type="number" min={0} max={128} step={1} value={draft.layout.gap} disabled={exporting} onChange={event => update({ ...draft, layout: { ...draft.layout, gap: Math.round(Math.max(0, Math.min(128, Number(event.target.value) || 0))) } })} /></label><label>留白底色<input type="color" value={draft.layout.background} disabled={exporting} onChange={event => update({ ...draft, layout: { ...draft.layout, background: event.target.value } })} /></label><button type="button" disabled={exporting} onClick={() => update({ ...draft, layout: { ...DEFAULT_MULTIVIEW_LAYOUT } }, true)}>重置排版</button><p>只调整留白，不去背景、不裁剪原帧。单图包仍为原尺寸。</p></div>}
          {view.tab === 'frames' && editing && <div className={styles.editorActions}><button type="button" className={styles.primary} disabled={applyingFrame || exporting} onClick={() => void applySelectedFrame()}>{applyingFrame ? '正在读取原尺寸帧…' : currentFrame?.url ? '使用这一帧' : '读取原尺寸并使用'}</button><button type="button" disabled={applyingFrame} onClick={() => { video.current?.pause(); update({ ...draft, editing: null }); }}>取消</button></div>}
          </fieldset>
        </aside></div>}
      </div>
      {validSlots.length > 0 && validSlots.length < draft.slots.length && <div className={styles.partial} role="status"><p>{validSlots.length} / {draft.slots.length} 张预览可用。完整拼图仍按全部选帧准备原尺寸图片，也可只下载当前可预览部分。</p><div className={styles.inlineActions}><button type="button" disabled={exporting || Boolean(quickFrame)} onClick={() => void download('png', true)}>下载当前可预览 {validSlots.length} / {draft.slots.length} 张（PNG拼图）</button><button type="button" disabled={exporting || Boolean(quickFrame)} onClick={() => void download('zip', true)}>下载当前可预览 {validSlots.length} / {draft.slots.length} 张（ZIP单图包）</button></div></div>}
      {notice && <div className={styles.notice} role="status">{notice}{exportFile && <button type="button" disabled={exporting} onClick={() => void downloadPrepared(exportFile)}>下载已准备文件</button>}</div>}
      {(!saved || !viewSaved) && <p className={styles.warning} role="status">本机存储暂不可用，刷新可能丢失本次工作现场；当前编辑和原图导出仍可使用。</p>}
      <footer ref={exportBar} className={styles.exportBar} style={dock && dock.width >= 160 ? { left: dock.left, width: dock.width, bottom: dock.bottom } : { visibility: 'hidden', width: 'min(100%, 600px)' }}>
        <div><strong>{dimensions?.width} × {dimensions?.height}</strong><small>{validSlots.length} / {draft.slots.length} 张预览可用</small></div>
        <div className={styles.exportActions}>
          <button type="button" className={styles.primary} disabled={exporting || Boolean(quickFrame)} onClick={copyCollage}><Copy size={16} />{exporting ? '正在准备原尺寸…' : '复制拼图'}</button>
          <button type="button" disabled={exporting || Boolean(quickFrame)} onClick={() => void download('png')}><Download size={16} />下载拼图</button>
          <ProductActionMenu label="更多下载方式" disabled={exporting || Boolean(quickFrame)} actions={[
            { id: 'zip', label: '下载单张图片（ZIP）', onSelect: () => void download('zip') },
          ]} />
        </div>
      </footer>
      {preview !== null && frames[preview]?.localFrame?.isCurrent() && <ZoomableImagePreview src={frames[preview].url!} localFrame={frames[preview].localFrame} alt="3D多视图原尺寸帧" imageSharing={false} sourceVersion={info.sourceVersion} previewKey={`multiview-${taskId}-${info.sourceVersion}-${preview}`} onClose={() => { previewSlot.current = null; setPreview(null); }} safeDetails={{ width: info.width, height: info.height }} />}
    </section>}
    <MultiviewSourcePicker open={pickerOpen} onClose={() => setPickerOpen(false)} onSelect={id => void selectTask(id)} currentTaskId={taskId} />
    </div>
    {productDialog}
    {shareOpen && workState.work && <MultiviewShareDialog key={`${owner}:${workState.work.id}`} owner={owner} work={workState.work} onClose={() => setShareOpen(false)}
      blockedReason={workState.pending ? '原保存结果待确认，暂未建立分享。' : workState.changed || workState.work.saveState === 'intent' ? '当前修改尚未保存，暂未建立分享。' : workState.work.ready?.revision !== workState.work.draftRevision ? '当前成品尚未就绪，暂未建立分享。' : ''}
      recovery={workState.pending ? { label: '查询原保存', run: () => void workState.queryOriginal(), disabled: workState.busy }
        : workState.changed ? { label: '保存', run: () => void workState.saveCurrent(), disabled: !workState.canSaveCurrent || workState.busy }
        : { label: '核对成品', run: workState.retry, disabled: workState.busy }} />}
  </div>;
}
export default function MultiviewPage() {
  return <Suspense fallback={<div className={styles.page} role="status" aria-busy="true">正在载入3D多视图工作区…</div>}><MultiviewPageContent /></Suspense>;
}
