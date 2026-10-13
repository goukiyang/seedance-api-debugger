'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import {
  Archive, Brush, ChevronLeft, ChevronRight, Crop, Download, Image as ImageIcon,
  LoaderCircle, Play, RefreshCw, Scan, Trash2, X,
} from 'lucide-react';
import Link from 'next/link';
import { createPortal } from 'react-dom';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import CutoutWorkspacePreview from '@/components/cutout/CutoutWorkspacePreview';
import { clearCutoutWorkspaceDraft, readCutoutWorkspaceDraft, saveCutoutWorkspaceDraft, readCutoutViewPreferences, saveCutoutViewPreferences, type CutoutViewPreferences } from '@/lib/cutout/workspace-draft';
import { getImageResultCutoutHandoff, prepareImageResultCutoutHandoff, startImageResultCutoutHandoff, type CutoutImageHandoff } from '@/lib/cutout/image-result-bridge';
import { RelativeTime } from '@/components/RelativeTime';
import { useProductDialog } from '@/components/useProductDialog';
import BrushRepair from '@/components/cutout/BrushRepair';
import CharacterBoxEditor from '@/components/cutout/CharacterBoxEditor';
import CutoutSettingsPanel from '@/components/cutout/CutoutSettingsPanel';
import RegionSelector from '@/components/cutout/RegionSelector';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';
import { GeneratedImageResults, type GeneratedImageResult } from '@/components/GeneratedImageResults';
import {
  cancelCutoutJob, createCutoutJob, cutoutResultReference, cutoutSubmissionUncertain, downloadCutoutBlob,
  getCutoutCapabilities, getCutoutHistory, getCutoutJob, saveCutoutBlob, uploadCutoutAsset,
} from '@/lib/cutout/client';
import type {
  Box, CharacterBox, CutoutCapabilities, CutoutJob, CutoutKind, CutoutProgress, CutoutSettings, CutoutUploadProgress,
  ModelOption, PromptOverride, SplitItem,
} from '@/lib/cutout/types';
import { getPageExitRisk, pageExitApproved, runApprovedPageExit, usePageExitRisk } from '@/lib/hooks/page-exit-guard';
import {
  DEFAULT_CUTOUT_SETTINGS, loadCutoutPreferences, saveCutoutPreferences, loadPendingCutout, savePendingCutout,
  type CutoutMode,
} from '@/lib/cutout/settings';
import styles from './cutout.module.css';
import { isSamModelId } from '@/lib/cutout/models';
import { cutoutResultContent } from '@/lib/cutout/result-content';
import { planCutoutJobQuery, refreshCutoutHistoryForQuery, type CutoutJobReadOutcome } from '@/lib/cutout/job-query';
import { ResourceLibraryPicker } from '@/components/ResourceLibraryPicker';
import { uploadFileAsAsset } from '@/lib/http/file-upload';
import type { PickerItem } from '@/lib/assets/picker-types';

const PAGE_SIZE = 12;
const RESULT_ROUTE = '/api/cutout/v1/results';
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const SPLIT_DEFAULTS = {
  split_alpha_threshold: 16,
  min_component_area: 300,
  padding: 24,
  connectivity: 8,
  merge_nearby_components: true,
  merge_distance: 12,
  small_part_attach_distance: 32,
  small_part_max_area_ratio: 0.15,
  deblend_dense_components: true,
  sort_order: 'left_to_right',
  export_manifest: true,
  export_zip: true,
  export_contact_sheet: true,
};
const CHARACTER_DEFAULTS = {
  strategy: 'model_mask',
  background_distance_threshold: 20,
  min_component_area: 1200,
  padding: 20,
  connectivity: 8,
  merge_distance: 24,
  border_sample_width: 8,
  max_components: 64,
  opening_steps: 2,
  bridge_steps: 1,
  sam_model_id: 'facebook/sam-vit-base',
  sam_neighbor_penalty: 0.82,
  sam_preserve_non_overlap: true,
};

type Notice = { kind: 'info' | 'success' | 'error' | 'warning'; text: string };
type SourceImage =
  | { id: string; kind: 'local'; file: File; name: string }
  | { id: string; kind: 'result'; url: string; reference: string; name: string; fullCanvas: boolean };
type SplitEntry = {
  key: string;
  jobId: string;
  item: SplitItem;
  width: number | null;
  height: number | null;
  fullCanvas: boolean;
};
type PendingSubmission = {
  key: string;
  assetId: string;
  kind: CutoutKind;
  parameters: Record<string, unknown>;
  sourceId: string;
  canvasSize: { width: number; height: number } | null;
};
type LocalRepair = { result: Blob; mask: Blob; filename: string; jobId: string; sourceVersion: string };

function makeId() {
  return globalThis.crypto?.randomUUID?.() || `cutout_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

function safeError(error: unknown, purpose: 'upload' | 'job' | 'history' | 'cancel' | 'download' = 'job') {
  const status = typeof error === 'object' && error && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : -1;
  if (purpose === 'upload') {
    if (status === 0 || status >= 500) return '图片上传结果暂未确认。重试可能会多留一份暂存图片，但不会自动重复创建任务。';
    if (status === 413) return '图片超过服务端允许的大小，请换一张较小的图片。';
    if (status === 415 || status === 400) return '图片格式或内容无法处理，请使用 PNG、JPG 或 WebP。';
  }
  if (status === 0) return purpose === 'job'
    ? '连接中断，任务提交结果尚未确认；可用同一提交标识重试确认。'
    : '连接中断，请检查网络后重试。';
  if (status === 401 || status === 403) return '当前账号暂时无法使用此操作，请重新登录或联系管理员。';
  if (status === 404) return '找不到所选任务或结果，请从历史记录重新打开。';
  if (status === 409 && purpose === 'cancel') return '任务可能已开始处理，无法取消；请重新查询状态。';
  if (status === 409) return '任务状态或提交内容已变化，请重新查询后继续。';
  if (status === 413) return '图片或结果超过服务允许的大小。';
  if (status === 503) return '抠图服务暂不可用，请稍后再试。';
  if (status >= 500) return '抠图服务暂时没有完成请求，原图和已有结果仍保留。';
  if (purpose === 'history') return '历史记录暂时无法读取，请稍后重试。';
  if (purpose === 'download') return '结果下载失败，请重新打开任务后重试。';
  return '操作未完成，请检查图片和参数后重试。';
}

function timestampValue(value: number) {
  const milliseconds = value > 1_000_000_000_000 ? value : value * 1000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function resultFileUrl(jobId: string, value?: string | null) {
  if (!value || !jobId) return '';
  const input = value.trim();
  if (/^\/api\/cutout\/v1\/results\/[^/?#]+\/[^/?#]+$/.test(input)) return input;
  if (/^\/api\/v1\/results\/[^/?#]+\/[^/?#]+$/.test(input)) {
    return input.replace(/^\/api\/v1\/results\//, `${RESULT_ROUTE}/`);
  }
  if (input.startsWith('/') || input.includes('://') || input.includes('..')) return '';
  const filename = input.split('/').at(-1) || '';
  if (!filename || /[?#\\]/.test(filename)) return '';
  return `${RESULT_ROUTE}/${encodeURIComponent(jobId)}/${encodeURIComponent(filename)}`;
}

function jobItems(job: CutoutJob | null): SplitItem[] {
  if (!job?.result) return [];
  if (Array.isArray(job.result.items)) return job.result.items;
  return job.result.item ? [job.result.item] : [];
}

function itemImageUrl(job: CutoutJob, item: SplitItem, canvas = false) {
  const direct = canvas
    ? item.canvas_url
    : item.trim_url || item.result_url || item.canvas_url;
  const filename = canvas ? item.filename_canvas : item.filename_trim || item.result_filename || item.filename_canvas;
  return resultFileUrl(job.job_id, direct || filename);
}

function jobThumbnail(job: CutoutJob) {
  const result = job.result;
  if (!result) return '';
  if (result.result_url) return resultFileUrl(job.job_id, result.result_url);
  const item = result.items?.[0] || result.item;
  return item ? itemImageUrl(job, item) : '';
}

function normalizeCrop(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const crop = value as Record<string, unknown>;
  const x = Number(crop.x);
  const y = Number(crop.y);
  const width = Number(crop.width ?? crop.w);
  const height = Number(crop.height ?? crop.h);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  const sourceWidth = Number(crop.source_width);
  const sourceHeight = Number(crop.source_height);
  return {
    x, y, width, height,
    ...(Number.isFinite(sourceWidth) ? { source_width: sourceWidth } : {}),
    ...(Number.isFinite(sourceHeight) ? { source_height: sourceHeight } : {}),
  };
}

function integrationCopy(capabilities: CutoutCapabilities | null) {
  const integration = capabilities?.integration;
  if (!integration) return '暂时无法读取抠图服务状态，请重新检查。';
  if (!integration.configured) return '当前账户尚未绑定抠图授权，暂不能提交任务。';
  if (!integration.authorized) return '当前账户尚未获准连接抠图服务，请联系管理员。';
  if (!integration.ready || capabilities?.dispatch?.available === false) {
    return '抠图服务暂不可用，可查看历史；服务恢复后再提交任务。';
  }
  const message = typeof integration.message === 'string' ? integration.message.trim() : '';
  if (message && message.length <= 100 && !/[\\/]|https?:|\b[A-Z][A-Z0-9_]{3,}\b/.test(message)) return message;
  return '抠图服务已就绪。';
}

function elapsedLabel(startedAt: number, now: number) {
  const seconds = Math.max(0, Math.floor(now / 1000 - startedAt));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return remainder ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours} 小时 ${remainingMinutes} 分` : `${hours} 小时`;
}

function progressLabel(stage: CutoutProgress['stage']) {
  if (stage === 'preparing') return '准备图片';
  if (stage === 'processing') return '正在抠图';
  return '保存结果';
}

function isTerminalJob(job: CutoutJob | null | undefined) {
  return Boolean(job && ['succeeded', 'failed', 'canceled'].includes(job.status));
}

export default function CutoutPage() {
  const { confirm, productDialog } = useProductDialog();
  const actionLock = useRef(false);
  const mounted = useRef(true);
  const historyRequest = useRef(0);
  const currentHistoryLoaderRef = useRef<(() => Promise<void>) | null>(null);
  const originalSourceByJob = useRef(new Map<string, string>());
  const [authChecked, setAuthChecked] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [capabilities, setCapabilities] = useState<CutoutCapabilities | null>(null);
  const [capabilityLoading, setCapabilityLoading] = useState(false);
  const [source, setSource] = useState<SourceImage | null>(null);
  const [sourceObjectUrl, setSourceObjectUrl] = useState('');
  const [sourceSize, setSourceSize] = useState<{ width: number; height: number } | null>(null);
  const [cachedAsset, setCachedAsset] = useState<{ sourceId: string; assetId: string } | null>(null);
  const [acceptedSourceId, setAcceptedSourceId] = useState('');
  const [mode, setMode] = useState<CutoutMode>('cutout');
  const [settings, setSettings] = useState<CutoutSettings>({ ...DEFAULT_CUTOUT_SETTINGS });
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [characterSettings, setCharacterSettings] = useState({ ...CHARACTER_DEFAULTS });
  const [boxes, setBoxes] = useState<CharacterBox[]>([]);
  const [prompts, setPrompts] = useState<PromptOverride[]>([]);
  const [regionBox, setRegionBox] = useState<Box | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [mutation, setMutation] = useState<'upload' | 'submit' | 'cancel' | null>(null);
  const [uploadProgress, setUploadProgress] = useState<CutoutUploadProgress | null>(null);
  const [pendingSubmission, setPendingSubmission] = useState<PendingSubmission | null>(null);
  const [history, setHistory] = useState<CutoutJob[]>([]);
  const [historyTotal, setHistoryTotal] = useState<number | null>(null);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [selectedJob, setSelectedJob] = useState<CutoutJob | null>(null);
  const [retainedResultJob, setRetainedResultJob] = useState<CutoutJob | null>(null);
  const [selectedJobId, setSelectedJobId] = useState('');
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [jobReadIssue, setJobReadIssue] = useState('');
  const [manualQueryBusy, setManualQueryBusy] = useState(false);
  const [elapsedAt, setElapsedAt] = useState(0);
  const [queryRefreshToken, setQueryRefreshToken] = useState(0);
  const [splitEntries, setSplitEntries] = useState<SplitEntry[]>([]);
  const [selectedEntryKeys, setSelectedEntryKeys] = useState<string[]>([]);
  const [exportModes, setExportModes] = useState({ trim: true, canvas: true });
  const [repairTarget, setRepairTarget] = useState<{ url: string; originalUrl?: string; cropMeta?: ReturnType<typeof normalizeCrop>; filename: string } | null>(null);
  const [repairDirty, setRepairDirty] = useState(false);
  const [localRepair, setLocalRepair] = useState<LocalRepair | null>(null);
  const [repairObjectUrl, setRepairObjectUrl] = useState('');
  const [zoom, setZoom] = useState<{ src: string; alt: string } | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyPanelRef = useRef<HTMLDivElement>(null);
  const historySurfaceRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<CutoutViewPreferences['view']>('result');
  const [previewBackground, setPreviewBackground] = useState<CutoutViewPreferences['background']>('checker');
  const [adjustmentsOpen, setAdjustmentsOpen] = useState(false);
  const [characterOpen, setCharacterOpen] = useState(false);
  const [selectedOutputId, setSelectedOutputId] = useState('');
  const [draftReady, setDraftReady] = useState(false);
  const [draftStatus, setDraftStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [draftMessage, setDraftMessage] = useState('');
  const draftWriteSequence = useRef(0);
  const draftWriteQueue = useRef<Promise<void>>(Promise.resolve());
  const [handoffId, setHandoffId] = useState('');
  const [handoff, setHandoff] = useState<CutoutImageHandoff | null>(null);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffError, setHandoffError] = useState('');
  const handoffSelection = useRef(false);
  const automaticHandoffImport = useRef('');
  const currentSourceIdRef = useRef('');
  currentSourceIdRef.current = source?.id || '';
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [imagePickerOpen, setImagePickerOpen] = useState(false);
  const sourceSelection = useRef(0);
  const selectedJobIdRef = useRef('');
  const selectedJobRef = useRef<CutoutJob | null>(null);
  const accountIdRef = useRef('');
  const accountGenerationRef = useRef(0);
  const lastAccountIdRef = useRef('');
  const selectionGenerationRef = useRef(0);
  const jobReadSequenceRef = useRef(0);
  const automaticQueryBlockedRef = useRef(false);
  const activeJobReadRef = useRef<{
    requestId: number;
    accountId: string;
    accountGeneration: number;
    jobId: string;
    generation: number;
    controller: AbortController;
  } | null>(null);
  const latestProgressRef = useRef<{ accountId: string; jobId: string; progress: CutoutProgress } | null>(null);
  const pendingSubmissionRef = useRef<PendingSubmission | null>(null);
  const terminalHandledRef = useRef(new Set<string>());
  const splitMetaByJobRef = useRef(new Map<string, { width: number; height: number } | null>());
  const pollFailuresRef = useRef(0);
  accountIdRef.current = accountId;
  useDialogDismiss({ open: historyOpen, dialogRef: historyPanelRef, dismissSurfaceRef: historySurfaceRef, onDismiss: () => setHistoryOpen(false) });

  const sourceUrl = source?.kind === 'result' ? source.url : sourceObjectUrl;
  const actionReady = Boolean(
    capabilities?.integration?.configured
    && capabilities.integration.authorized
    && capabilities.integration.ready
    && capabilities.dispatch?.available !== false,
  );
  const isBusy = mutation !== null;
  const sourceNeedsGuard = source?.kind === 'local' && acceptedSourceId !== source.id;
  const dirtyCharacterDraft = boxes.length > 0 || prompts.length > 0;

  usePageExitRisk({
    unsaved: [
      ...(sourceNeedsGuard ? ['已选图片尚未提交任务'] : []),
      ...(dirtyCharacterDraft ? ['角色框选或点提示尚未提交'] : []),
      ...(regionBox ? ['区域框选尚未提交'] : []),
      ...(repairDirty ? ['画笔修改尚未应用'] : []),
      ...(localRepair && draftStatus !== 'saved' ? ['本地修复结果尚未保存，离开前请下载'] : []),
      ...(pendingSubmission ? ['任务提交结果尚未确认'] : []),
    ],
    busy: isBusy || handoffBusy ? [handoffBusy ? '正在处理接续图片' : mutation === 'upload' ? '图片上传中' : mutation === 'cancel' ? '正在取消任务' : '正在提交任务'] : [],
    revision: `${source?.id || ''}:${selectedJobId}:${boxes.length}:${prompts.length}:${regionBox ? `${regionBox.x},${regionBox.y},${regionBox.w},${regionBox.h}` : ''}:${repairDirty}:${draftStatus}:${pendingSubmission?.key || ''}`,
  });

  useEffect(() => {
    const leave = async (destination: string) => {
      const risk = getPageExitRisk();
      if (risk.busy.length) { setNotice({ kind: 'warning', text: '当前操作尚未完成，请等待确认后离开。' }); return; }
      if (risk.unsaved.length && !await confirm(`${risk.unsaved.join('；')}。离开会放弃未应用修改，请先保存或下载需要保留的结果。`, { title: '离开抠图', confirmLabel: '仍然离开' })) return;
      runApprovedPageExit(() => window.location.assign(destination), risk.signature);
    };
    const onLink = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || pageExitApproved()) return;
      const link = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href]');
      if (!link || link.target === '_blank' || link.hasAttribute('download')) return;
      const destination = new URL(link.href, location.href);
      if (destination.pathname === location.pathname && destination.search === location.search) return;
      const risk = getPageExitRisk();
      if (!risk.busy.length && !risk.unsaved.length) return;
      event.preventDefault(); event.stopImmediatePropagation(); void leave(destination.href);
    };
    const navigation = (window as Window & { navigation?: EventTarget }).navigation;
    const onNavigate = (event: Event) => {
      const value = event as Event & { destination?: { url: string }; hashChange?: boolean; downloadRequest?: string | null };
      if (!value.cancelable || !value.destination || value.hashChange || value.downloadRequest || pageExitApproved()) return;
      const risk = getPageExitRisk();
      if (!risk.busy.length && !risk.unsaved.length) return;
      value.preventDefault(); void leave(value.destination.url);
    };
    document.addEventListener('click', onLink, true);
    navigation?.addEventListener('navigate', onNavigate);
    return () => { document.removeEventListener('click', onLink, true); navigation?.removeEventListener('navigate', onNavigate); };
  }, [confirm]);

  const setJobContext = useCallback((jobId: string) => {
    if (selectedJobIdRef.current !== jobId) {
      activeJobReadRef.current?.controller.abort();
      activeJobReadRef.current = null;
      selectionGenerationRef.current += 1;
      pollFailuresRef.current = 0;
      automaticQueryBlockedRef.current = false;
      latestProgressRef.current = null;
      setJobReadIssue('');
    }
    selectedJobIdRef.current = jobId;
  }, []);

  const chooseJob = useCallback((job: CutoutJob | null) => {
    const jobId = job?.job_id || '';
    const selectionChanged = selectedJobIdRef.current !== jobId;
    setJobContext(jobId);
    if (isTerminalJob(job)) latestProgressRef.current = null;
    else if (job?.progress) {
      const currentProgress = latestProgressRef.current;
      const isOlder = currentProgress?.accountId === accountIdRef.current && currentProgress.jobId === jobId
        && (job.progress.attempt < currentProgress.progress.attempt
          || job.progress.attempt === currentProgress.progress.attempt && (job.progress.sequence < currentProgress.progress.sequence
            || job.progress.sequence === currentProgress.progress.sequence && job.progress.reported_at < currentProgress.progress.reported_at));
      if (selectionChanged || !currentProgress || currentProgress.accountId !== accountIdRef.current || currentProgress.jobId !== jobId || !isOlder) {
        latestProgressRef.current = { accountId: accountIdRef.current, jobId, progress: job.progress };
      }
    }
    setSelectedJob(job);
    selectedJobRef.current = job;
    setSelectedJobId(jobId);
  }, [setJobContext]);

  const sourceFromResult = useCallback(async (url: string, name: string, fullCanvas: boolean) => {
    if (actionLock.current || pendingSubmissionRef.current || getPageExitRisk().busy.length) return;
    if ((sourceNeedsGuard || regionBox || repairDirty || localRepair || boxes.length || prompts.length) && !await confirm('切换图片会替换当前本机草稿、修图和框选。请先下载需要保留的本地结果；原图和服务器结果不会被修改。', { title: '切换图片', confirmLabel: '切换' })) return;
    try {
      const reference = cutoutResultReference(url);
      setSource({ id: makeId(), kind: 'result', url, reference, name, fullCanvas });
      handoffSelection.current = false;
      setView('original');
      setCachedAsset(null);
      setAcceptedSourceId('');
      setSourceSize(null);
      setBoxes([]);
      setPrompts([]);
      setRegionBox(null);
      setRepairTarget(null);
      setRepairDirty(false);
      setLocalRepair(null);
      setNotice(null);
    } catch {
      setNotice({ kind: 'error', text: '这张图片暂时不能作为后续任务的来源，请重新打开结果。' });
    }
  }, [boxes.length, confirm, localRepair, prompts.length, regionBox, repairDirty, sourceNeedsGuard]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      historyRequest.current++;
      activeJobReadRef.current?.controller.abort();
      activeJobReadRef.current = null;
    };
  }, []);

  const setJobResult = useCallback((job: CutoutJob) => {
    if (selectedJobIdRef.current && selectedJobIdRef.current !== job.job_id) return;
    chooseJob(job);
    if (job.status !== 'succeeded' || terminalHandledRef.current.has(job.job_id)) return;
    terminalHandledRef.current.add(job.job_id);
    if (originalSourceByJob.current.get(job.job_id) === currentSourceIdRef.current) setView('result');
    if (job.kind === 'split_preview') {
      const width = Number(job.result?.source_width) || null;
      const height = Number(job.result?.source_height) || null;
      const entries = (job.result?.items || []).map((item) => ({
        key: `${job.job_id}:${item.id}`,
        jobId: job.job_id,
        item,
        width,
        height,
        fullCanvas: Boolean(item.canvas_url || item.filename_canvas),
      }));
      setSplitEntries(entries);
      setSelectedEntryKeys([]);
    }
    if ((job.kind === 'split_region' || job.kind === 'split_merge') && job.result?.item) {
      const size = splitMetaByJobRef.current.get(job.job_id) || null;
      const item = job.result.item;
      const entry: SplitEntry = {
        key: `${job.job_id}:${item.id}`,
        jobId: job.job_id,
        item,
        width: size?.width ?? null,
        height: size?.height ?? null,
        fullCanvas: Boolean(size && (item.canvas_url || item.filename_canvas)),
      };
      setSplitEntries((current) => current.some((row) => row.key === entry.key) ? current : [...current, entry]);
      setSelectedEntryKeys((current) => current.includes(entry.key) ? current : [...current, entry.key]);
    }
  }, [chooseJob]);

  const applyJobResponse = useCallback((job: CutoutJob, context: {
    accountId: string; accountGeneration: number; jobId: string; selectionGeneration: number;
  }) => {
    if (!mounted.current || accountIdRef.current !== context.accountId
      || accountGenerationRef.current !== context.accountGeneration
      || selectedJobIdRef.current !== context.jobId
      || selectionGenerationRef.current !== context.selectionGeneration
      || job.job_id !== context.jobId) return null;

    const latestProgress = latestProgressRef.current;
    const current = selectedJobRef.current;
    if (current?.job_id === job.job_id && job.updated_at < current.updated_at) return null;

    let preserveLatestProgress = false;
    if (latestProgress?.accountId === context.accountId && latestProgress.jobId === context.jobId && job.progress) {
      const previous = latestProgress.progress;
      const incoming = job.progress;
      preserveLatestProgress = incoming.attempt === previous.attempt && (incoming.sequence < previous.sequence
          || incoming.sequence === previous.sequence && incoming.reported_at < previous.reported_at);
    }

    if (current?.job_id === job.job_id && isTerminalJob(current) && job.status !== current.status) return null;

    const nextJob = isTerminalJob(job)
      ? { ...job, progress: undefined }
      : preserveLatestProgress && latestProgress ? { ...job, progress: latestProgress.progress } : job;
    if (isTerminalJob(nextJob)) latestProgressRef.current = null;
    else if (nextJob.progress) latestProgressRef.current = { accountId: context.accountId, jobId: context.jobId, progress: nextJob.progress };
    else if (latestProgress?.accountId === context.accountId && latestProgress.jobId === context.jobId) latestProgressRef.current = null;
    setJobResult(nextJob);
    return nextJob;
  }, [setJobResult]);

  const readSelectedJob = useCallback(async (jobId: string, selectionGeneration: number): Promise<CutoutJobReadOutcome> => {
    const accountIdAtStart = accountIdRef.current;
    const accountGeneration = accountGenerationRef.current;
    if (!accountIdAtStart || selectedJobIdRef.current !== jobId || selectionGenerationRef.current !== selectionGeneration) return { kind: 'stale' };
    const existing = activeJobReadRef.current;
    if (existing && existing.accountId === accountIdAtStart && existing.accountGeneration === accountGeneration
      && existing.jobId === jobId && existing.generation === selectionGeneration) return { kind: 'in-flight' };
    existing?.controller.abort();

    const requestId = ++jobReadSequenceRef.current;
    const controller = new AbortController();
    const request = { requestId, accountId: accountIdAtStart, accountGeneration, jobId, generation: selectionGeneration, controller };
    activeJobReadRef.current = request;
    const isCurrentRequest = () => activeJobReadRef.current?.requestId === requestId
      && accountIdRef.current === accountIdAtStart
      && accountGenerationRef.current === accountGeneration
      && selectedJobIdRef.current === jobId
      && selectionGenerationRef.current === selectionGeneration;
    try {
      const job = await getCutoutJob(jobId, controller.signal);
      if (!isCurrentRequest()) return { kind: 'stale' };
      const applied = applyJobResponse(job, { accountId: accountIdAtStart, accountGeneration, jobId, selectionGeneration });
      if (!applied) return isCurrentRequest() ? { kind: 'ignored' } : { kind: 'stale' };
      setJobReadIssue('');
      return { kind: 'updated', job: applied };
    } catch (error) {
      if (controller.signal.aborted || !isCurrentRequest()) return { kind: 'stale' };
      const status = typeof error === 'object' && error && 'status' in error ? Number((error as { status?: unknown }).status) : -1;
      setJobReadIssue(status === 0 || status >= 500
        ? '暂时无法更新任务状态，任务可能仍在处理。可重新查询。'
        : safeError(error, 'history'));
      return { kind: 'request-failed', status };
    } finally {
      if (activeJobReadRef.current?.requestId === requestId) activeJobReadRef.current = null;
    }
  }, [applyJobResponse]);

  useEffect(() => {
    if (lastAccountIdRef.current === accountId) return;
    const previousAccount = lastAccountIdRef.current;
    lastAccountIdRef.current = accountId;
    accountGenerationRef.current += 1;
    if (!previousAccount) return;
    setJobContext('');
    setSelectedJob(null);
    selectedJobRef.current = null;
    setSelectedJobId('');
    setSource(null); setLocalRepair(null); setRepairTarget(null); setRepairDirty(false);
    setBoxes([]); setPrompts([]); setRegionBox(null); setCachedAsset(null); setAcceptedSourceId('');
    setRetainedResultJob(null); setHandoff(null); setHandoffId(''); handoffSelection.current = false;
    automaticHandoffImport.current = '';
    originalSourceByJob.current.clear(); terminalHandledRef.current.clear();
    pendingSubmissionRef.current = null; setPendingSubmission(null);
    latestProgressRef.current = null;
    setJobReadIssue('');
  }, [accountId, setJobContext]);

  useEffect(() => {
    let active = true;
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((response) => response.json())
      .then((body: { user?: { id?: string; role?: string } | null }) => {
        if (!active) return;
        const user = body?.user;
        if (user?.role === 'admin') {
          setIsAdmin(true);
          setAccountId(typeof user.id === 'string' ? user.id : '');
        } else {
          window.location.assign(user ? '/generate' : '/login?next=/cutout');
        }
        setAuthChecked(true);
      })
      .catch(() => {
        if (!active) return;
        setAuthChecked(true);
        window.location.assign('/login?next=/cutout');
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!authChecked || !isAdmin) return;
    let active = true;
    setCapabilityLoading(true);
    getCutoutCapabilities()
      .then((value) => { if (active) setCapabilities(value); })
      .catch(() => { if (active) setCapabilities(null); })
      .finally(() => { if (active) setCapabilityLoading(false); });
    return () => { active = false; };
  }, [authChecked, isAdmin]);

  useEffect(() => {
    if (!authChecked || !isAdmin) return;
    if (accountId) {
      const preferences = loadCutoutPreferences(accountId);
      if (preferences) {
        setSettings(preferences.settings);
        setMode(preferences.mode);
        setAdvancedOpen(preferences.advancedOpen);
        setHistoryOffset(preferences.historyOffset);
        setJobContext(preferences.selectedJobId || '');
        setSelectedJobId(preferences.selectedJobId || '');
      }
      const linkedJobId = new URLSearchParams(window.location.search).get('jobId');
      if (linkedJobId && /^[a-zA-Z0-9_-]{1,128}$/.test(linkedJobId)) {
        setJobContext(linkedJobId);
        setSelectedJobId(linkedJobId);
      }
      const pending = loadPendingCutout(accountId);
      if (pending) {
        pendingSubmissionRef.current = pending;
        setPendingSubmission(pending);
        setNotice({ kind: 'warning', text: '上次提交结果未确认，已找回原提交标识。可先查看历史，或用原标识重试确认。' });
      }
    }
    setPreferencesReady(true);
  }, [accountId, authChecked, isAdmin, setJobContext]);

  useEffect(() => {
    if (!preferencesReady || !accountId) return;
    saveCutoutPreferences(accountId, { settings, mode, advancedOpen, selectedJobId: selectedJobId || null, historyOffset });
  }, [accountId, advancedOpen, historyOffset, mode, preferencesReady, selectedJobId, settings]);

  useEffect(() => {
    if (!accountId || !preferencesReady) return;
    let active = true;
    const token = sourceSelection.current;
    const views = readCutoutViewPreferences(accountId);
    setView(views.view || 'result');
    setPreviewBackground(views.background || 'checker');
    setAdjustmentsOpen(views.adjustmentsOpen === true);
    setCharacterOpen(views.characterOpen === true);
    if (views.characterSettings) setCharacterSettings(current => ({ ...current, ...views.characterSettings }));
    setSelectedOutputId(views.outputId || '');
    setDraftReady(false);
    const params = new URLSearchParams(window.location.search);
    const receipt = params.get('handoff') || '';
    if (/^[\w-]{1,128}$/.test(receipt)) setHandoffId(receipt);
    void readCutoutWorkspaceDraft(accountId).then(value => {
      if (!active || accountIdRef.current !== accountId || sourceSelection.current !== token || !value) return;
      // Explicit new sources win; the stored draft is retained until the user chooses to replace it.
      if (value.source) {
        if (value.source.handoffId && (!receipt || receipt === value.source.handoffId)) {
          handoffSelection.current = true;
          setHandoffId(value.source.handoffId);
        }
        if (value.source.file) {
          const file = new File([value.source.file], value.source.name, { type: value.source.file.type });
          setSource({ id: value.source.id, kind: 'local', file, name: value.source.name });
        } else if (value.source.reference) {
          setSource({ id: value.source.id, kind: 'result', reference: value.source.reference, url: value.source.reference.replace(/^\/api\/v1\/results\//, `${RESULT_ROUTE}/`), name: value.source.name, fullCanvas: value.source.fullCanvas === true });
        }
        if (value.source.accepted) setAcceptedSourceId(value.source.id);
        if (value.sourceJobId) originalSourceByJob.current.set(value.sourceJobId, value.source.id);
        if (value.editor) { setBoxes(value.editor.boxes); setPrompts(value.editor.prompts); setRegionBox(value.editor.region); }
      }
      if (value.repair) setLocalRepair(value.repair);
      setDraftStatus('saved');
      setDraftMessage(receipt ? '本机有上次草稿。导入新图片前会确认替换；原任务和结果保留。' : '已恢复本机草稿；任务状态会重新查询。');
    }).catch(error => {
      if (!active) return;
      setDraftStatus('failed');
      setDraftMessage(error instanceof Error ? error.message : '本机草稿恢复失败，请重新选图；服务器结果仍保留。');
    }).finally(() => { if (active) setDraftReady(true); });
    return () => { active = false; };
  }, [accountId, preferencesReady]);

  useEffect(() => {
    if (!draftReady || !accountId) return;
    if (!saveCutoutViewPreferences(accountId, { view, background: previewBackground, adjustmentsOpen, characterOpen, outputId: selectedOutputId, characterSettings: { strategy: characterSettings.strategy, background_distance_threshold: characterSettings.background_distance_threshold, min_component_area: characterSettings.min_component_area, padding: characterSettings.padding, max_components: characterSettings.max_components } })) {
      setDraftMessage('本次视图设置无法记住；页面仍可继续使用。');
    }
  }, [accountId, adjustmentsOpen, characterOpen, characterSettings, draftReady, previewBackground, selectedOutputId, view]);

  useEffect(() => {
    if (!draftReady || !accountId) return;
    const sequence = ++draftWriteSequence.current;
    const account = accountId;
    const sourceJobId = source ? Array.from(originalSourceByJob.current.entries()).find(([, id]) => id === source.id)?.[0] || null : null;
    setDraftStatus('saving');
    const timer = window.setTimeout(() => {
      draftWriteQueue.current = draftWriteQueue.current.catch(() => {}).then(async () => {
        if (sequence !== draftWriteSequence.current || accountIdRef.current !== account) return;
        try {
          if (!source && !localRepair) await clearCutoutWorkspaceDraft(account);
          else await saveCutoutWorkspaceDraft(account, { version: 1, savedAt: Date.now(),
            source: source ? { id: source.id, ...(source.kind === 'local' ? { file: source.file } : { reference: source.reference, fullCanvas: source.fullCanvas }), name: source.name.slice(0, 240), accepted: acceptedSourceId === source.id, ...(handoffSelection.current && handoffId ? { handoffId } : {}) } : null,
            sourceJobId, repair: localRepair, editor: source ? { boxes, prompts, region: regionBox } : undefined });
          if (mounted.current && sequence === draftWriteSequence.current && accountIdRef.current === account) {
            setDraftStatus('saved'); setDraftMessage(localRepair ? '修复草稿已保存在本机，7天内可恢复；不是云端历史。' : '');
          }
        } catch (error) {
          if (mounted.current && sequence === draftWriteSequence.current && accountIdRef.current === account) {
            setDraftStatus('failed'); setDraftMessage(`${error instanceof Error ? error.message : '草稿未保存'}。离开前请下载本地结果。`);
          }
        }
      });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [acceptedSourceId, accountId, boxes, draftReady, handoffId, localRepair, prompts, regionBox, source]);

  useEffect(() => {
    if (source?.kind !== 'local') {
      setSourceObjectUrl('');
      return;
    }
    const url = URL.createObjectURL(source.file);
    setSourceObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [source?.id]);

  useEffect(() => {
    setSourceSize(null);
  }, [source?.id]);

  useEffect(() => {
    if (!localRepair) {
      setRepairObjectUrl('');
      return;
    }
    const url = URL.createObjectURL(localRepair.result);
    setRepairObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [localRepair]);

  const loadHistory = useCallback(async () => {
    const requestId = ++historyRequest.current;
    setHistoryLoading(true);
    setHistoryError('');
    try {
      const response = await getCutoutHistory(historyOffset, PAGE_SIZE);
      if (!mounted.current || requestId !== historyRequest.current) return;
      setHistory(Array.isArray(response.items) ? response.items : []);
      setHistoryTotal(Number.isFinite(response.total) ? Number(response.total) : null);
    } catch (error) {
      if (!mounted.current || requestId !== historyRequest.current) return;
      setHistoryError(safeError(error, 'history'));
    } finally {
      if (mounted.current && requestId === historyRequest.current) setHistoryLoading(false);
    }
  }, [historyOffset]);
  currentHistoryLoaderRef.current = loadHistory;

  useEffect(() => {
    if (!authChecked || !isAdmin || !preferencesReady) return;
    void loadHistory();
  }, [authChecked, isAdmin, loadHistory, preferencesReady]);

  useEffect(() => {
    if (!selectedJob || !['queued', 'running'].includes(selectedJob.status)) return;
    setElapsedAt(Date.now());
    const timer = window.setInterval(() => setElapsedAt(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [selectedJob?.job_id, selectedJob?.started_at, selectedJob?.status]);

  useEffect(() => {
    if (!preferencesReady || !selectedJobId) return;
    const jobId = selectedJobId;
    const selectionGeneration = selectionGenerationRef.current;
    const initialJob = selectedJobRef.current?.job_id === jobId ? selectedJobRef.current : null;
    if (initialJob && isTerminalJob(initialJob)) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (delay: number) => {
      if (!active || document.visibilityState !== 'visible') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void poll(); }, delay);
    };
    const poll = async () => {
      if (!active || automaticQueryBlockedRef.current || document.visibilityState !== 'visible' || selectedJobIdRef.current !== jobId
        || selectionGenerationRef.current !== selectionGeneration) return;
      const currentJob = selectedJobRef.current;
      if (currentJob?.job_id === jobId && isTerminalJob(currentJob)) return;
      const outcome = await readSelectedJob(jobId, selectionGeneration);
      if (selectedJobIdRef.current !== jobId || selectionGenerationRef.current !== selectionGeneration) return;
      if (outcome.kind === 'updated') pollFailuresRef.current = 0;
      else if (outcome.kind === 'request-failed') pollFailuresRef.current += 1;
      const plan = planCutoutJobQuery({
        jobId,
        currentJob: selectedJobRef.current,
        outcome,
        failureCount: pollFailuresRef.current,
        now: Date.now(),
      });
      if (outcome.kind === 'updated') automaticQueryBlockedRef.current = false;
      else if (outcome.kind === 'request-failed' && plan.delayMs === null) automaticQueryBlockedRef.current = true;
      if (mounted.current) void refreshCutoutHistoryForQuery(plan, currentHistoryLoaderRef);
      if (!active) return;
      if (plan.refreshHistory) {
        active = false;
        if (timer) clearTimeout(timer);
      }
      if (plan.delayMs !== null) schedule(plan.delayMs);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        if (timer) clearTimeout(timer);
        const request = activeJobReadRef.current;
        if (request?.jobId === jobId && request.generation === selectionGeneration) request.controller.abort();
      } else {
        if (timer) clearTimeout(timer);
        void poll();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    if (document.visibilityState === 'visible') {
      if (!initialJob) void poll();
      else schedule(initialJob.status === 'queued' ? planCutoutJobQuery({
        jobId, currentJob: initialJob, outcome: { kind: 'in-flight' }, failureCount: 0, now: Date.now(),
      }).delayMs || 3500 : 3500);
    }
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [loadHistory, preferencesReady, queryRefreshToken, readSelectedJob, selectedJobId]);

  const modelOptions = useMemo<ModelOption[]>(() => {
    const options: ModelOption[] = [{ id: 'auto', label: '自动选择', available: true }];
    const seen = new Set(['auto']);
    for (const model of capabilities?.models || []) {
      if (!model?.id || seen.has(model.id) || isSamModelId(model.id)) continue;
      seen.add(model.id);
      options.push(model);
    }
    if (!seen.has(settings.model_preference) && !isSamModelId(settings.model_preference)) {
      options.push({ id: settings.model_preference, label: settings.model_preference, available: false, reason: '当前未提供' });
    }
    return options;
  }, [capabilities?.models, settings.model_preference]);

  const acceptFile = useCallback(async (file: File | null, preserveRepair = false, fromHandoff = false) => {
    if (actionLock.current || isBusy || pendingSubmission || !fromHandoff && getPageExitRisk().busy.length) return false;
    const token = ++sourceSelection.current;
    if ((sourceNeedsGuard || regionBox || repairDirty || (!preserveRepair && localRepair) || boxes.length || prompts.length) && !await confirm('更换图片会替换当前本机草稿、修图和框选。请先下载需要保留的本地结果；原图和服务器结果不会被修改。', { title: '更换图片', confirmLabel: '继续' })) return false;
    if (!file) {
      setSource(null); setCachedAsset(null); setBoxes([]); setPrompts([]); setRegionBox(null); setRepairTarget(null); setRepairDirty(false); setLocalRepair(null);
      return true;
    }
    if (!IMAGE_TYPES.has(file.type)) {
      setNotice({ kind: 'error', text: '请使用 PNG、JPG 或 WebP 图片。' });
      return false;
    }
    const limit = (capabilities?.limits?.max_upload_mb || 15) * 1024 * 1024;
    if (file.size > limit) {
      setNotice({ kind: 'error', text: `图片超过当前 ${Math.round(limit / 1024 / 1024)} MB 上限。` });
      return false;
    }
    try { const image = await createImageBitmap(file); image.close(); }
    catch { setNotice({ kind: 'error', text: '所选图片未能读取，原图和旧结果仍保留。' }); return false; }
    if (!mounted.current || sourceSelection.current !== token || actionLock.current || pendingSubmissionRef.current || !fromHandoff && getPageExitRisk().busy.length) return false;
    setSource({ id: makeId(), kind: 'local', file, name: file.name || 'image.png' });
    handoffSelection.current = false;
    setView('original');
    setCachedAsset(null);
    setAcceptedSourceId('');
    setSourceSize(null);
    setBoxes([]);
    setPrompts([]);
    setRegionBox(null);
    setRepairTarget(null);
    setRepairDirty(false);
    setLocalRepair(null);
    setNotice(null);
    return true;
  }, [boxes.length, capabilities?.limits?.max_upload_mb, confirm, isBusy, localRepair, pendingSubmission, prompts.length, regionBox, repairDirty, sourceNeedsGuard]);

  async function selectLibraryImage(items: PickerItem[]) {
    const item = items[0], token = ++sourceSelection.current;
    if (!item || item.type !== 'image' || !item.originalUrl) return { success: false, message: '原图不可用或未授权读取，已有输入保留；请重新选择可读取原件的图片' };
    try {
      const response = await fetch(item.originalUrl, { cache: 'no-store', signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error('所选原图无法读取，原图和旧结果保留');
      const blob = await response.blob();
      if (!mounted.current || token !== sourceSelection.current || pendingSubmissionRef.current || actionLock.current) return false;
      return await acceptFile(new File([blob], item.fileName || 'image.png', { type: blob.type.split(';')[0] }));
    } catch (error) { return { success: false, message: error instanceof Error ? error.message : '图片读取失败，原图保留' }; }
  }

  useEffect(() => {
    if (!isAdmin) return;
    const paste = (event: ClipboardEvent) => {
      if (imagePickerOpen || (event.target as Element | null)?.closest?.('input,textarea,[contenteditable="true"]')) return;
      const file = Array.from(event.clipboardData?.files || []).find(item => IMAGE_TYPES.has(item.type));
      if (file) { event.preventDefault(); void acceptFile(file); }
    };
    document.addEventListener('paste', paste);
    return () => document.removeEventListener('paste', paste);
  }, [acceptFile, isAdmin, imagePickerOpen]);

  const onFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    acceptFile(event.currentTarget.files?.[0] || null);
    event.currentTarget.value = '';
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    if (!isBusy && !pendingSubmission) acceptFile(event.dataTransfer.files?.[0] || null);
  };

  const selectHistoryJob = async (job: CutoutJob) => {
    if (actionLock.current || getPageExitRisk().busy.length) return;
    if (repairDirty && !await confirm('切换记录会关闭当前未应用的画笔修改。已应用的本机草稿和服务器结果保留。', { title: '切换记录', confirmLabel: '切换' })) return;
    chooseJob(job);
    setRetainedResultJob(null);
    setRepairTarget(null);
    setRepairDirty(false);
    setHistoryOpen(false);
    setView('result');
    setSelectedOutputId('');
    const width = Number(job.result?.source_width) || null;
    const height = Number(job.result?.source_height) || null;
    if (job.kind === 'split_preview') {
      setSplitEntries((job.result?.items || []).map((item) => ({
        key: `${job.job_id}:${item.id}`, jobId: job.job_id, item,
        width, height, fullCanvas: Boolean(item.canvas_url || item.filename_canvas),
      })));
      setSelectedEntryKeys([]);
    } else if (job.kind === 'split_region' || job.kind === 'split_merge') {
      const item = job.result?.item;
      setSplitEntries(item ? [{ key: `${job.job_id}:${item.id}`, jobId: job.job_id, item, width, height, fullCanvas: Boolean(width && height && item.canvas_url) }] : []);
      setSelectedEntryKeys([]);
    } else {
      setSplitEntries([]);
      setSelectedEntryKeys([]);
    }
  };

  const getOrUploadAsset = useCallback(async (chosen: SourceImage) => {
    if (cachedAsset?.sourceId === chosen.id) return cachedAsset.assetId;
    setMutation('upload');
    setUploadProgress(null);
    let image: Blob = chosen.kind === 'local' ? chosen.file : await downloadCutoutBlob(chosen.url);
    const uploaded = await uploadCutoutAsset(image, chosen.name, (progress) => {
      if (mounted.current && actionLock.current) setUploadProgress(progress);
    });
    if (!mounted.current) throw new Error('页面已离开，未创建任务');
    setUploadProgress(null);
    setCachedAsset({ sourceId: chosen.id, assetId: uploaded.asset_id });
    if (uploaded.width > 0 && uploaded.height > 0) setSourceSize({ width: uploaded.width, height: uploaded.height });
    return uploaded.asset_id;
  }, [cachedAsset]);

  const submitWithKey = useCallback(async (pending: PendingSubmission) => {
    if (!mounted.current || !savePendingCutout(accountId, pending)) {
      setNotice({ kind: 'error', text: '浏览器无法保存提交标识，为防止重复任务，暂未提交。请允许本站存储后重试。' });
      return;
    }
    pendingSubmissionRef.current = pending;
    setPendingSubmission(pending);
    setMutation('submit');
    setNotice({ kind: 'info', text: '正在提交任务。' });
    try {
      const job = await createCutoutJob(pending.assetId, pending.kind, pending.parameters, pending.key);
      saveCutoutPreferences(accountId, { settings, mode, advancedOpen, selectedJobId: job.job_id, historyOffset });
      savePendingCutout(accountId, null);
      if (!mounted.current) return;
      originalSourceByJob.current.set(job.job_id, pending.sourceId);
      pendingSubmissionRef.current = null;
      setPendingSubmission(null);
      setAcceptedSourceId(pending.sourceId);
      if (pending.kind === 'characters') { setBoxes([]); setPrompts([]); }
      setRegionBox(null);
      splitMetaByJobRef.current.set(job.job_id, pending.canvasSize);
      if (selectedJobRef.current?.status === 'succeeded') setRetainedResultJob(selectedJobRef.current);
      chooseJob(job);
      setNotice(job.status === 'failed' || job.status === 'canceled'
        ? { kind: 'warning', text: job.status === 'failed' ? '任务已受理，但处理失败；原图与已有结果保留。' : '任务已受理，但已经取消；原图与已有结果保留。' }
        : { kind: 'success', text: job.status === 'succeeded' ? '任务已完成。' : '任务已提交，完成后会显示结果。' });
      setJobResult(job);
    } catch (error) {
      if (cutoutSubmissionUncertain(error)) {
        pendingSubmissionRef.current = pending;
        setPendingSubmission(pending);
        setNotice({ kind: 'warning', text: safeError(error, 'job') });
      } else {
        pendingSubmissionRef.current = null;
        setPendingSubmission(null);
        savePendingCutout(accountId, null);
        setNotice({ kind: 'error', text: safeError(error, 'job') });
      }
    } finally {
      setMutation(null);
    }
  }, [accountId, advancedOpen, chooseJob, historyOffset, mode, setJobResult, settings]);

  const startJob = useCallback(async (kind: CutoutKind, parameters: Record<string, unknown>) => {
    if (actionLock.current || !preferencesReady) return;
    if (handoffSelection.current && handoff && ['preparing', 'submitting', 'unknown'].includes(handoff.stage)) {
      setNotice({ kind: 'warning', text: '原接续结果尚未确认，请查询历史或原记录，不要重新提交。' }); return;
    }
    if (!source) {
      setNotice({ kind: 'error', text: '请先选择或载入一张图片。' });
      return;
    }
    if (!sourceSize) { setNotice({ kind: 'warning', text: '图片尚未读取完成，请稍后再处理；无法读取时请更换图片。' }); return; }
    if (!actionReady) {
      setNotice({ kind: 'warning', text: integrationCopy(capabilities) });
      return;
    }
    if (pendingSubmissionRef.current) {
      setNotice({ kind: 'warning', text: '上次提交结果尚未确认，请先用原提交标识重试确认。' });
      return;
    }
    actionLock.current = true;
    try {
      const assetId = await getOrUploadAsset(source);
      setMutation(null);
      const pending: PendingSubmission = {
        key: makeId().replace(/-/g, '_'),
        assetId,
        kind,
        parameters,
        sourceId: source.id,
        canvasSize: sourceSize,
      };
      await submitWithKey(pending);
    } catch (error) {
      setMutation(null);
      setUploadProgress(null);
      setNotice({ kind: 'error', text: safeError(error, 'upload') });
    } finally { actionLock.current = false; }
  }, [actionReady, capabilities, getOrUploadAsset, handoff, preferencesReady, source, sourceSize, submitWithKey]);

  const retrySubmission = () => {
    const pending = pendingSubmissionRef.current;
    if (pending && !isBusy && !actionLock.current && actionReady) {
      actionLock.current = true;
      void submitWithKey(pending).finally(() => { actionLock.current = false; });
    }
  };

  useEffect(() => {
    if (!handoffId || !accountId || !draftReady) return;
    let active = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const read = async () => {
      try {
        const value = await getImageResultCutoutHandoff(handoffId, controller.signal);
        if (!active || accountIdRef.current !== accountId) return;
        setHandoff(value); setHandoffError(''); failures = 0;
        if (['preparing', 'submitting', 'unknown'].includes(value.stage)) timer = setTimeout(() => void read(), 5000);
      } catch (error) {
        if (!active) return;
        setHandoffError(error instanceof Error ? error.message : '接续记录暂时无法读取，未重新提交。');
        if (++failures < 3) timer = setTimeout(() => void read(), 5000 * failures);
      }
    };
    void read();
    return () => { active = false; controller.abort(); if (timer) clearTimeout(timer); };
  }, [accountId, draftReady, handoffId, queryRefreshToken]);

  const importHandoffImage = async () => {
    if (!handoff || handoffBusy || actionLock.current || pendingSubmissionRef.current || !draftReady) return;
    const account = accountIdRef.current;
    const token = ++sourceSelection.current;
    setHandoffBusy(true); setHandoffError('');
    try {
      const response = await fetch(handoff.source.originalUrl, { cache: 'no-store', signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error('来源原图无法读取或已失去权限，当前草稿保留。');
      const blob = await response.blob();
      if (!mounted.current || sourceSelection.current !== token || accountIdRef.current !== account) return;
      const imported = await acceptFile(new File([blob], handoff.source.fileName || 'image.png', { type: blob.type.split(';')[0] }), false, true);
      if (!imported) return;
      handoffSelection.current = true;
      setMode('cutout'); setView('original');
      setNotice({ kind: ['preparing', 'submitting', 'unknown'].includes(handoff.stage) ? 'warning' : 'info', text: ['preparing', 'submitting', 'unknown'].includes(handoff.stage) ? '来源原图已载入，原接续结果尚未确认。请查询历史或原记录，不要重新提交。' : handoff.stage === 'accepted' ? '来源原图已载入，原任务已受理；请查看原任务。' : '来源原图已载入，价格未知，请确认后开始。' });
    } catch (error) { if (accountIdRef.current === account) setHandoffError(error instanceof Error ? error.message : '原图导入失败，当前草稿保留。'); }
    finally { if (mounted.current) setHandoffBusy(false); }
  };

  useEffect(() => {
    if (!handoff || !draftReady || handoffBusy || source || localRepair || boxes.length || prompts.length || pendingSubmission || automaticHandoffImport.current === handoff.receiptId) return;
    automaticHandoffImport.current = handoff.receiptId;
    // Loading the authorized original is read-only. This effect never prepares or starts a job.
    void importHandoffImage();
    // The import owns its selection token; later user selections cancel its result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoff, draftReady, handoffBusy, source, localRepair, boxes.length, prompts.length, pendingSubmission]);

  const submitHandoff = async () => {
    if (!handoffId || !handoffSelection.current || !source || !sourceSize || !actionReady || handoffBusy || actionLock.current) return;
    if (!handoff || ['preparing', 'submitting', 'unknown', 'accepted'].includes(handoff.stage)) {
      setNotice({ kind: 'warning', text: '原接续任务已提交或尚未确认，请只查询原记录；不会重复发送。' }); return;
    }
    if (!await confirm('当前抠图服务没有提供可靠报价，无法确认本次费用。是否按当前设置提交一次？未知提交只查询原记录，不会重新发送。', { title: '确认抠图', confirmLabel: '确认并开始' })) return;
    const account = accountIdRef.current;
    actionLock.current = true; setHandoffBusy(true); setHandoffError('');
    try {
      let value = await prepareImageResultCutoutHandoff(handoffId);
      if (!mounted.current || accountIdRef.current !== account) return;
      setHandoff(value);
      if (value.asset) setCachedAsset({ sourceId: source.id, assetId: value.asset.asset_id });
      if (value.stage === 'awaiting-confirmation' || value.stage === 'import-ready' || value.stage === 'not-submitted') {
        value = await startImageResultCutoutHandoff(handoffId, { settings, confirmUnknownPrice: true });
        if (!mounted.current || accountIdRef.current !== account) return;
        setHandoff(value);
      }
      if (value.job) {
        originalSourceByJob.current.set(value.job.job_id, source.id);
        setAcceptedSourceId(source.id); chooseJob(value.job); setJobResult(value.job); setView('result');
      }
      setNotice({ kind: value.stage === 'unknown' ? 'warning' : 'info', text: value.message });
    } catch (error) { if (accountIdRef.current === account) setHandoffError(error instanceof Error ? error.message : '结果尚未确认，请查询原接续记录。'); }
    finally { actionLock.current = false; if (mounted.current) { setHandoffBusy(false); setQueryRefreshToken(value => value + 1); } }
  };

  const submitMain = () => {
    if (mode === 'cutout') {
      if (handoffSelection.current && handoffId) { void submitHandoff(); return; }
      void startJob('cutout', { settings });
      return;
    }
    const splitSettings = {
      ...characterSettings,
      manual_boxes: boxes.map(({ id, name, x, y, w, h }) => ({ id, name, x, y, w, h })),
      sam_prompt_overrides: prompts.map(({ id, points, labels, mask_index }) => ({ id, points, labels, ...(mask_index == null ? {} : { mask_index }) })),
    };
    void startJob('characters', { settings, character_split_settings: splitSettings });
  };

  const runCrop = () => { void startJob('crop', {}); };
  const runSplitPreview = () => { void startJob('split_preview', { settings: SPLIT_DEFAULTS }); };

  const runRegion = () => {
    if (!source || source.kind !== 'result' || !source.fullCanvas || !regionBox) return;
    const payload = {
      source_filename: source.reference,
      bbox: regionBox,
      padding: 24,
      id: `manual_${Date.now()}`,
      name: '手工选区',
    };
    void startJob('split_region', { payload });
  };

  const entryReferences = (entry: SplitEntry) => {
    const trimUrl = itemImageUrl({ job_id: entry.jobId } as CutoutJob, entry.item);
    const canvasUrl = itemImageUrl({ job_id: entry.jobId } as CutoutJob, entry.item, true);
    if (!trimUrl || !canvasUrl) return null;
    try {
      return {
        filename_trim: cutoutResultReference(trimUrl),
        filename_canvas: cutoutResultReference(canvasUrl),
      };
    } catch { return null; }
  };

  const selectedEntries = splitEntries.filter((entry) => selectedEntryKeys.includes(entry.key));
  const eligibleEntries = selectedEntries.filter((entry) => entry.fullCanvas && entry.width && entry.height);
  const sameCanvasSize = eligibleEntries.length > 0 && eligibleEntries.every((entry) => (
    entry.width === eligibleEntries[0].width && entry.height === eligibleEntries[0].height
  ));
  const selectedExportEntries = selectedEntries.filter((entry) => entry.item.export !== false && entryReferences(entry));
  const entryPayload = (entry: SplitEntry) => {
    const refs = entryReferences(entry);
    return refs ? { ...refs, id: entry.item.id, name: entry.item.name, bbox: entry.item.bbox,
      area: entry.item.area, alpha_mean: entry.item.alpha_mean, padding: entry.item.padding,
      export: entry.item.export !== false, type: entry.item.type, manual_adjusted: entry.item.manual_adjusted,
      merged_from: entry.item.merged_from } : null;
  };

  const runMerge = () => {
    if (!source || selectedEntries.length < 2 || !sameCanvasSize) return;
    const items = selectedEntries.filter((entry) => entry.fullCanvas).map(entryPayload).filter(Boolean);
    if (items.length < 2 || items.length !== selectedEntries.length) {
      setNotice({ kind: 'warning', text: '仅能合并具有同尺寸全尺寸画布和有效结果引用的对象。' });
      return;
    }
    void startJob('split_merge', { payload: { source_file: source.name, items } });
  };

  const runExport = () => {
    if (!source || selectedExportEntries.length === 0 || (!exportModes.trim && !exportModes.canvas)) return;
    const items = selectedExportEntries.map(entryPayload).filter(Boolean);
    if (!items.length) return;
    void startJob('split_export', { payload: {
      source_file: source.name,
      source_width: splitEntries[0]?.width || sourceSize?.width || 0,
      source_height: splitEntries[0]?.height || sourceSize?.height || 0,
      items,
      export_modes: [ ...(exportModes.trim ? ['trim'] : []), ...(exportModes.canvas ? ['canvas'] : []) ],
      split_mode: 'manual_adjusted',
      params: {},
    } });
  };

  const requerySelected = async () => {
    const jobId = selectedJobIdRef.current;
    const selectionGeneration = selectionGenerationRef.current;
    if (!jobId || isBusy || manualQueryBusy) return;
    setManualQueryBusy(true);
    automaticQueryBlockedRef.current = false;
    setJobReadIssue('');
    try {
      const outcome = await readSelectedJob(jobId, selectionGeneration);
      if (outcome.kind === 'updated') {
        pollFailuresRef.current = 0;
        automaticQueryBlockedRef.current = false;
        setQueryRefreshToken((current) => current + 1);
      } else if (outcome.kind === 'in-flight') {
        setJobReadIssue('正在读取最新状态，请稍候。');
      }
      if (outcome.kind === 'request-failed') {
        pollFailuresRef.current += 1;
        if (outcome.status !== 0 && outcome.status < 500) automaticQueryBlockedRef.current = true;
      }
      if (outcome.kind === 'updated' && isTerminalJob(outcome.job)) void loadHistory();
    } finally {
      if (mounted.current) setManualQueryBusy(false);
    }
  };

  const cancelQueued = async () => {
    if (!selectedJob || selectedJob.status !== 'queued' || isBusy || actionLock.current) return;
    const jobId = selectedJob.job_id;
    const accountIdAtStart = accountIdRef.current;
    const accountGeneration = accountGenerationRef.current;
    const selectionGeneration = selectionGenerationRef.current;
    actionLock.current = true;
    setMutation('cancel');
    try {
      const job = await cancelCutoutJob(jobId);
      if (accountIdRef.current !== accountIdAtStart || accountGenerationRef.current !== accountGeneration
        || selectedJobIdRef.current !== jobId || selectionGenerationRef.current !== selectionGeneration) return;
      const applied = applyJobResponse(job, { accountId: accountIdAtStart, accountGeneration, jobId, selectionGeneration });
      if (applied) {
        setNotice({ kind: 'success', text: job.status === 'canceled' ? '已取消排队中的任务。' : '任务状态已更新。' });
        void loadHistory();
      } else void readSelectedJob(jobId, selectionGeneration);
    } catch (error) {
      if (accountIdRef.current === accountIdAtStart && accountGenerationRef.current === accountGeneration
        && selectedJobIdRef.current === jobId && selectionGenerationRef.current === selectionGeneration) {
        setNotice({ kind: 'error', text: safeError(error, 'cancel') });
      }
      if (typeof error === 'object' && error && 'status' in error && Number((error as { status?: unknown }).status) === 409) {
        await readSelectedJob(jobId, selectionGeneration);
      }
    } finally {
      actionLock.current = false;
      if (mounted.current) setMutation(null);
    }
  };

  const downloadResult = async (url: string, filename: string) => {
    if (!url) return;
    try {
      const blob = await downloadCutoutBlob(url);
      saveCutoutBlob(blob, filename);
    } catch (error) {
      setNotice({ kind: 'error', text: safeError(error, 'download') });
    }
  };

  const onApplyRepair = async (result: Blob, mask: Blob) => {
    const repairedJob = selectedJob?.status === 'succeeded' ? selectedJob : retainedResultJob;
    if (!repairTarget || !repairedJob) return;
    const filename = repairTarget.filename.replace(/\.[^.]+$/, '') + '-修复.png';
    setLocalRepair({ result, mask, filename, jobId: repairedJob.job_id, sourceVersion: `${repairedJob.job_id}:${repairedJob.updated_at}:${repairTarget.filename}` });
    setDraftStatus('saving');
    setRepairDirty(false);
    setRepairTarget(null);
    setView('result');
    setNotice({ kind: 'info', text: '修复已应用到本地结果，正在保存本机草稿；原图和服务器结果未修改。' });
  };

  const useLocalRepair = () => {
    if (!localRepair) return;
    const file = new File([localRepair.result], localRepair.filename, { type: 'image/png' });
    void acceptFile(file, true);
  };

  const nextPage = () => {
    if (historyLoading) return;
    setHistoryOffset((current) => current + PAGE_SIZE);
  };
  const previousPage = () => setHistoryOffset((current) => Math.max(0, current - PAGE_SIZE));
  const canGoNext = historyTotal == null ? history.length === PAGE_SIZE : historyOffset + PAGE_SIZE < historyTotal;

  if (!authChecked || !isAdmin) {
    return <main className={styles.page}><div className={styles.statusNotice}>正在确认管理员权限…</div></main>;
  }

  const outputJob = selectedJob?.status === 'succeeded' ? selectedJob : retainedResultJob;
  const result = outputJob?.result || null;
  const activeJob = selectedJob && ['queued', 'running'].includes(selectedJob.status) ? selectedJob : null;
  const activeStage = activeJob?.status === 'queued' ? '正在排队' : activeJob?.progress ? progressLabel(activeJob.progress.stage) : '任务正在处理';
  const activeElapsed = activeJob?.status === 'queued'
    ? `提交后 ${elapsedLabel(activeJob.created_at, elapsedAt)}`
    : activeJob?.started_at != null ? `自首次开始 ${elapsedLabel(activeJob.started_at, elapsedAt)}` : '';
  const uploadMessage = uploadProgress?.percent != null && uploadProgress.percent >= 100
    ? '上传数据已发送，正在确认图片接收…'
    : uploadProgress ? `正在上传原图 ${Math.floor(uploadProgress.percent)}%`
      : '正在准备并上传原图；等待服务确认接收。';
  const sourceWidth = sourceSize?.width || 0;
  const sourceHeight = sourceSize?.height || 0;
  const selectedImageUrl = result?.result_url ? resultFileUrl(outputJob!.job_id, result.result_url) : '';
  const resultCrop = normalizeCrop(result?.crop);
  const matchingOriginal = source && outputJob && originalSourceByJob.current.get(outputJob.job_id) === source.id && sourceUrl ? { src: sourceUrl, alt: '本次原图' } : undefined;
  const cutoutOutputs = outputJob?.status === 'succeeded' && result ? [
    ...(selectedImageUrl ? [{ id: `${outputJob.job_id}:result`, url: selectedImageUrl, label: '抠图结果', filename: result.filename || 'cutout.png', main: true, mask: '', content: cutoutResultContent(outputJob, 'result') }] : []),
    ...(outputJob.kind === 'characters' && Array.isArray(result.items) ? result.items.flatMap((item, index) => {
      const url = resultFileUrl(outputJob.job_id, item.result_url || item.result_filename);
      return url ? [{ id: `${outputJob.job_id}:character:${item.id || index}`, url, label: item.name || `角色 ${index + 1}`, filename: item.result_filename || `${item.name || item.id || 'character'}.png`, main: false, mask: resultFileUrl(outputJob.job_id, item.mask_url), content: cutoutResultContent(outputJob, `character_${index}`) }] : [];
    }) : []),
    ...(['split_preview', 'split_region', 'split_merge', 'crop'].includes(outputJob.kind) && !selectedImageUrl ? jobItems(outputJob).flatMap(item => {
      const url = itemImageUrl(outputJob, item);
      return url ? [{ id: `${outputJob.job_id}:object:${item.id}`, url, label: item.name || '拆分对象', filename: item.filename_trim || item.result_filename || 'object.png', main: false, mask: resultFileUrl(outputJob.job_id, item.mask_url), content: null }] : [];
    }) : []),
  ] : [];
  const sharedResults: Array<GeneratedImageResult & { output?: typeof cutoutOutputs[number] }> = cutoutOutputs.map(output => ({
    id: output.id, output, label: output.label, status: '已完成', transparent: true,
    media: { src: output.url, alt: output.label, fileName: output.filename, comparison: output.main ? matchingOriginal : undefined,
      contentKey: output.content?.key, imageSharing: false,
      comparisonCandidates: cutoutOutputs.filter(other => other.id !== output.id).map(other => ({ src: other.url, alt: other.label, contentKey: other.content?.key })) },
    download: async () => {
      try { saveCutoutBlob(await downloadCutoutBlob(output.url), output.filename); }
      catch (cause) { throw new Error(safeError(cause, 'download')); }
    },
  }));
  if (selectedJob && selectedJob.status !== 'succeeded') sharedResults.push({
    id: `${selectedJob.job_id}:state`, label: '任务结果', pending: ['queued', 'running'].includes(selectedJob.status),
    status: selectedJob.status === 'queued' ? '排队中' : selectedJob.status === 'running' ? '处理中' : selectedJob.status === 'failed' ? '任务未完成，原图仍保留' : '任务已取消',
  });
  const activeOutput = cutoutOutputs.find(output => output.id === selectedOutputId) || cutoutOutputs[0];
  const localRepairVisible = Boolean(localRepair && outputJob && localRepair.jobId === outputJob.job_id
    && localRepair.sourceVersion === `${outputJob.job_id}:${outputJob.updated_at}:${activeOutput?.filename || ''}`);
  const mainResultUrl = localRepairVisible ? repairObjectUrl : activeOutput?.url || '';
  const settingsChanged = Boolean(outputJob?.parameters?.settings && JSON.stringify(outputJob.parameters.settings) !== JSON.stringify(settings));
  const samAvailable = Boolean(capabilities?.models?.some(model => model.available === true && isSamModelId(model.id) && model.id === characterSettings.sam_model_id));
  const handoffBlocked = Boolean(handoffSelection.current && handoff && ['preparing', 'submitting', 'unknown'].includes(handoff.stage));
  const returnHref = handoff?.returnPath && handoff.returnPath.startsWith('/') && !handoff.returnPath.startsWith('//') && !/[\\\r\n]/.test(handoff.returnPath) ? handoff.returnPath : '/';
  const selectedCharacters = outputJob?.kind === 'characters' ? cutoutOutputs.filter(output => !output.main && selectedEntryKeys.includes(output.id)) : [];
  const chooseOutput = async (id: string) => {
    if (repairDirty && !await confirm('切换预览会关闭未应用的画笔修改。已应用的本机草稿保留。', { title: '切换预览', confirmLabel: '切换' })) return;
    setRepairTarget(null); setRepairDirty(false); setSelectedOutputId(id); setView('result');
  };


  return (
    <main className={styles.page}>
      <header className={styles.workspaceHeader}>
        <div className={styles.buttonRow}><Link className={styles.quietButton} href={returnHref}><ChevronLeft size={16} />返回来源</Link><h1>抠图</h1></div>
        <button type="button" className={styles.secondaryButton} onClick={() => setHistoryOpen(true)}><Archive size={16} />最近任务{history.some(job => ['queued', 'running'].includes(job.status)) ? ' · 处理中' : ''}</button>
      </header>
      <div className={styles.modeTabs} role="group" aria-label="处理方式">
        <button type="button" className={`${styles.modeTab} ${mode === 'cutout' ? styles.modeActive : ''}`} aria-pressed={mode === 'cutout'} onClick={() => setMode('cutout')} disabled={isBusy || repairDirty}>去背景</button>
        <button type="button" className={`${styles.modeTab} ${mode === 'characters' ? styles.modeActive : ''}`} aria-pressed={mode === 'characters'} onClick={() => setMode('characters')} disabled={isBusy || repairDirty}>角色拆切</button>
      </div>
      {handoffId && <div className={styles.handoffStrip} role="status">
        <span>{handoff ? `${handoff.source.label} · ${handoff.message || handoff.autoStart.message}` : handoffError || '正在读取接续图片…'}</span>
        {handoff && <button className={styles.secondaryButton} type="button" onClick={() => void importHandoffImage()} disabled={handoffBusy || isBusy || Boolean(pendingSubmission)}>导入来源图片</button>}
        <button className={styles.quietButton} type="button" disabled={handoffBusy} onClick={() => void getImageResultCutoutHandoff(handoffId).then(setHandoff).catch(error => setHandoffError(error instanceof Error ? error.message : '接续记录暂时无法读取'))}>查询接续状态</button>
        {handoff?.job && <button className={styles.quietButton} type="button" onClick={() => void selectHistoryJob(handoff.job!)}>查看原任务</button>}
        {handoffError && <span className={styles.statusError}>{handoffError}</span>}
      </div>}
      <div className={styles.layout}>
        <div className={styles.mainColumn}>
          <section className={styles.workArea} aria-label="当前图片">
            <div className={styles.workspaceToolbar}>
              <div className={styles.buttonRow} role="group" aria-label="图片视图">
                {(['original', 'result', 'compare'] as const).map(tab => <button type="button" className={`${styles.modeTab} ${view === tab ? styles.modeActive : ''}`} aria-pressed={view === tab} key={tab} onClick={() => setView(tab)} disabled={Boolean(repairTarget) || (tab === 'original' ? !sourceUrl : tab === 'result' ? !mainResultUrl : !mainResultUrl || !matchingOriginal || !activeOutput?.main)}><span>{tab === 'original' ? '原图' : tab === 'result' ? '结果' : '对照'}</span></button>)}
              </div>
              {source && <div className={styles.buttonRow}><button className={styles.quietButton} type="button" onClick={() => setImagePickerOpen(true)} disabled={isBusy || handoffBusy || Boolean(pendingSubmission)}>更换图片</button><button className={styles.iconButton} type="button" aria-label="清除当前图片" onClick={() => void acceptFile(null)} disabled={isBusy || Boolean(pendingSubmission)}><X size={15} /></button></div>}
            </div>
            {!source && !mainResultUrl ? <div className={`${styles.sourceDropzone} ${dragActive ? styles.sourceDropActive : ''}`} onDragEnter={event => { event.preventDefault(); if (!isBusy && !pendingSubmission) setDragActive(true); }} onDragOver={event => event.preventDefault()} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragActive(false); }} onDrop={onDrop}>
              <ImageIcon size={36} aria-hidden="true" /><strong>选择要处理的图片</strong><span>拖入图片或粘贴，支持 PNG、JPG、WebP</span><div className={styles.buttonRow}><button type="button" className={styles.primaryButton} onClick={() => fileInputRef.current?.click()} disabled={isBusy}>上传图片</button><button type="button" className={styles.secondaryButton} onClick={() => setImagePickerOpen(true)} disabled={isBusy}>从素材库选择</button></div>
            </div> : repairTarget ? <>
              <div className={styles.sectionHeading}><h2>修一下</h2><button className={styles.quietButton} type="button" onClick={async () => { if (!repairDirty || await confirm('放弃未应用的画笔修改？已应用结果保留。', { title: '关闭修图', confirmLabel: '放弃修改' })) { setRepairTarget(null); setRepairDirty(false); } }}>关闭修图</button></div>
              <BrushRepair resultUrl={repairTarget.url} originalUrl={repairTarget.originalUrl} cropMeta={repairTarget.cropMeta} filename={repairTarget.filename} disabled={isBusy} onDraftDirtyChange={setRepairDirty} onApply={onApplyRepair} />
            </> : mode === 'characters' && characterSettings.strategy === 'sam_box' && sourceUrl && sourceWidth > 0 && sourceHeight > 0 && view === 'original' ?
              <CharacterBoxEditor imageUrl={sourceUrl} width={sourceWidth} height={sourceHeight} boxes={boxes} onBoxesChange={setBoxes} prompts={prompts} onPromptsChange={setPrompts} disabled={isBusy} /> :
              <CutoutWorkspacePreview scope={`${accountId}:${source?.id || outputJob?.job_id || 'empty'}`} originalUrl={sourceUrl} resultUrl={mainResultUrl} matchingOriginal={Boolean(matchingOriginal) && Boolean(activeOutput?.main)} crop={activeOutput?.main ? resultCrop : null} view={view} background={previewBackground} onOriginalSize={setSourceSize} onZoom={url => setZoom({ src: url, alt: source?.name || '抠图结果' })} />}
            <input ref={fileInputRef} className={styles.hiddenInput} type="file" accept="image/png,image/jpeg,image/webp" onChange={onFileInput} />
            {source && <div className={styles.sourceHint}><span title={source.name}>{source.name}</span><span>{sourceWidth && sourceHeight ? `${sourceWidth} × ${sourceHeight} px` : '正在读取尺寸'} · {source.kind === 'local' ? cachedAsset?.sourceId === source.id ? '已暂存' : '尚未上传' : '任务结果'}</span></div>}
            <div className={styles.previewTools}><div className={styles.buttonRow}><span>预览底色</span>{(['checker', 'light', 'dark'] as const).map(background => <button className={`${styles.modeTab} ${previewBackground === background ? styles.modeActive : ''}`} aria-pressed={previewBackground === background} key={background} type="button" onClick={() => setPreviewBackground(background)}>{background === 'checker' ? '透明网格' : background === 'light' ? '浅色' : '深色'}</button>)}</div><span>仅预览，不改变导出</span></div>
            {mainResultUrl && <div className={styles.operationBar}>
              <button className={styles.primaryButton} type="button" onClick={() => localRepairVisible ? saveCutoutBlob(localRepair!.result, localRepair!.filename) : void downloadResult(activeOutput!.url, activeOutput!.filename)}><Download size={15} />下载透明PNG</button>
              {activeOutput?.main && outputJob?.kind === 'cutout' && <button className={styles.secondaryButton} type="button" onClick={() => setRepairTarget({ url: mainResultUrl, originalUrl: matchingOriginal?.src, cropMeta: resultCrop, filename: activeOutput.filename })}><Brush size={15} />修一下</button>}
              <button className={styles.secondaryButton} type="button" disabled={isBusy || handoffBlocked || Boolean(pendingSubmission)} onClick={() => localRepairVisible ? useLocalRepair() : void sourceFromResult(activeOutput!.url, activeOutput!.filename, activeOutput!.main)}>继续处理这张图</button>
            </div>}
            {localRepairVisible && <div className={styles.draftStrip} role="status">
              <span>{draftStatus === 'saving' ? '修复已应用，正在保存本机草稿…' : draftStatus === 'saved' ? '本机修复草稿 · 7天内可恢复' : '修复仅在当前页面，离开前请下载'}</span>
              <button className={styles.textButton} type="button" onClick={() => saveCutoutBlob(localRepair!.mask, localRepair!.filename.replace(/\.png$/, '-mask.png'))}>下载修复遮罩</button>
              <button className={styles.quietButton} type="button" onClick={async () => { if (await confirm('放弃本机修复草稿？原图和服务器结果仍保留。', { title: '放弃修复', confirmLabel: '放弃草稿', danger: true })) setLocalRepair(null); }}><Trash2 size={14} />放弃草稿</button>
            </div>}
            {draftMessage && <p className={styles.strategyCopy} role="status">{draftMessage}</p>}
          </section>
          <section className={styles.section} aria-labelledby="cutout-result-title">
            <div className={styles.resultHeader}>
              <div className={styles.sectionTitle}><ImageIcon size={17} aria-hidden="true" /><div><h2 id="cutout-result-title">当前状态与输出</h2><p>{selectedJob ? `${selectedJob.status === 'queued' ? '排队中' : selectedJob.status === 'running' ? '处理中' : selectedJob.status === 'succeeded' ? '已完成' : selectedJob.status === 'failed' ? '失败' : '已取消'}` : selectedJobId ? `${selectedJobId.slice(0, 12)} · 等待读取状态` : '选择一条任务查看结果。'}</p></div></div>
              {(selectedJob || selectedJobId) && <div className={styles.buttonRow}>
                <button className={styles.iconButton} type="button" title="重新查询" aria-label="重新查询" onClick={() => void requerySelected()} disabled={isBusy || manualQueryBusy}><RefreshCw size={15} /></button>
                {selectedJob?.status === 'queued' && <button className={styles.iconButton} type="button" title="取消排队任务" aria-label="取消排队任务" onClick={() => void cancelQueued()} disabled={isBusy}><X size={15} /></button>}
              </div>}
            </div>

            {selectedJob && <details className={styles.taskDetails}><summary>任务详情</summary><p>{selectedJob.job_id}</p>{selectedJob.error?.message && <p>{selectedJob.error.message}</p>}</details>}
            {!source && !selectedJob && <p className={styles.emptyHint}>{selectedJobId ? '尚未读取到任务详情。可重新查询；不会因此重新提交任务。' : '提交任务后，处理进度和可用结果会显示在这里。'}</p>}
            {activeJob && <div className={styles.statusNotice} role="status" aria-live="polite">
              <LoaderCircle size={15} aria-hidden="true" />
              <div className={styles.progressCopy}>
                <strong>{activeStage}</strong>
                <span>{activeJob.status === 'queued' ? '离开页面不会重复提交；页面隐藏时暂停查询，返回后继续。' : '页面保持在前台时自动查询；离开时暂停，返回后继续。'}</span>
                {(activeElapsed || (activeJob.progress && activeJob.progress.attempt > 1)) && <span className={styles.progressMeta}>
                  {activeElapsed}{activeElapsed && activeJob.progress && activeJob.progress.attempt > 1 ? ' · ' : ''}
                  {activeJob.progress && activeJob.progress.attempt > 1 ? `第 ${activeJob.progress.attempt} 次处理` : ''}
                </span>}
              </div>
            </div>}
            {jobReadIssue && <div className={`${styles.statusNotice} ${styles.statusWarning}`} role="status">{jobReadIssue}</div>}
            {selectedJob?.status === 'failed' && <div className={`${styles.statusNotice} ${styles.statusError}`}>任务未完成。原图仍保留，请检查参数后重新提交。</div>}
            {selectedJob?.status === 'canceled' && <div className={styles.statusNotice}>任务已取消，原图与其他任务结果不受影响。</div>}
            {selectedJob?.status === 'succeeded' && ['cutout', 'characters', 'crop'].includes(selectedJob.kind) && !cutoutOutputs.length && <div className={`${styles.statusNotice} ${styles.statusWarning}`} role="status">任务已结束，但图片结果尚不可用。原图保留，可重新查询；不会重新提交任务。</div>}

            {(cutoutOutputs.length > 1 || outputJob?.kind === 'characters') && <GeneratedImageResults key={`${accountId}:${outputJob?.job_id}`} items={sharedResults} selectedId={selectedOutputId} onSelect={item => { void chooseOutput(item.id); }}
              scope={`sd2:cutout-results:v1:${accountId}:${selectedJobId}:output`} emptyLabel={selectedJob ? '暂无可显示的图片结果' : '暂无任务结果'}
              renderActions={item => item.output ? <>
                {outputJob?.kind === 'characters' && !item.output.main && <label className={styles.checkField}><input type="checkbox" checked={selectedEntryKeys.includes(item.id)} onChange={event => setSelectedEntryKeys(keys => event.target.checked ? [...keys.filter(key => key !== item.id), item.id] : keys.filter(key => key !== item.id))} />选入导出</label>}
                <button type="button" onClick={() => sourceFromResult(item.output!.url, item.output!.filename, item.output!.main)}>作为后续图片</button>
                {item.output.mask && <button type="button" onClick={() => void downloadResult(item.output!.mask, 'character-mask.png')}><Download size={14} />遮罩</button>}
                {item.output.main && outputJob?.kind === 'cutout' && <button type="button" onClick={() => setRepairTarget({url: item.output!.url, originalUrl: matchingOriginal?.src, cropMeta: resultCrop, filename: item.output!.filename})}><Brush size={14} />局部修复</button>}
              </> : null}
            />}
            {outputJob?.kind === 'characters' && cutoutOutputs.some(output => !output.main) && <div className={styles.operationBar}>
              <span className={styles.subtleText}>已选 {selectedCharacters.length} 个（当前任务的已加载角色）</span>
              <button className={styles.primaryButton} type="button" disabled={!selectedCharacters.length || isBusy} onClick={async () => { for (const output of selectedCharacters) await downloadResult(output.url, output.filename); }}><Download size={15} />导出所选PNG</button>
              <span className={styles.subtleText}>按实际提供的角色尺寸导出；未提供全画布文件时不伪造。</span>
            </div>}
            {retainedResultJob && selectedJob?.status !== 'succeeded' && <p className={styles.strategyCopy}>当前保留上次可用结果；新任务完成后才更新画面。</p>}
            {outputJob?.status === 'succeeded' && result && (
              <>
                {result.mask_url && <div className={styles.operationBar}>
                  <button className={styles.textButton} type="button" onClick={() => void downloadResult(resultFileUrl(outputJob.job_id, result.mask_url), 'cutout-mask.png')}><Download size={14} />下载遮罩</button>
                </div>}
                {(result.contact_sheet_url || result.manifest_url || result.zip_url) && (
                  <div className={styles.operationBar} aria-label="任务附带文件">
                    {result.contact_sheet_url && <button className={styles.textButton} type="button" onClick={() => void downloadResult(resultFileUrl(outputJob.job_id, result.contact_sheet_url), 'contact-sheet.png')}><Download size={14} />总览图</button>}
                    {result.manifest_url && <button className={styles.textButton} type="button" onClick={() => void downloadResult(resultFileUrl(outputJob.job_id, result.manifest_url), 'manifest.json')}><Download size={14} />清单</button>}
                    {result.zip_url && <button className={styles.textButton} type="button" onClick={() => void downloadResult(resultFileUrl(outputJob.job_id, result.zip_url), 'cutout-results.zip')}><Download size={14} />ZIP</button>}
                  </div>
                )}
                {splitEntries.length > 0 && (
                  <div className={styles.splitList}>
                    <div className={styles.sectionHeading}><div><h2>拆分对象</h2><p>先选中对象，再合并或导出；合并仅支持同尺寸全尺寸画布。</p></div></div>
                    {splitEntries.map((entry) => {
                      const preview = itemImageUrl({ job_id: entry.jobId } as CutoutJob, entry.item);
                      const canvas = itemImageUrl({ job_id: entry.jobId } as CutoutJob, entry.item, true);
                      const checked = selectedEntryKeys.includes(entry.key);
                      return <div className={styles.splitRow} key={entry.key}>
                        <input type="checkbox" checked={checked} aria-label={`选择${entry.item.name || entry.item.id}`} onChange={(event) => setSelectedEntryKeys((current) => event.target.checked ? [...current, entry.key] : current.filter((key) => key !== entry.key))} />
                        {preview ? <button className={styles.objectPreviewButton} type="button" aria-label={`预览${entry.item.name || entry.item.id}`} onClick={() => void chooseOutput(`${entry.jobId}:object:${entry.item.id}`)} onDoubleClick={() => setZoom({ src: preview, alt: entry.item.name || '拆分对象' })}>{/* eslint-disable-next-line @next/next/no-img-element */}<img className={styles.splitThumb} src={preview} alt="" /></button> : <span className={styles.historyThumb}>暂无截图</span>}
                        <span className={styles.splitName} title={entry.item.name}>{entry.item.name || entry.item.id}</span>
                        <span className={styles.resultActions}>
                          <label className={styles.checkField}><input type="checkbox" checked={entry.item.export !== false} onChange={(event) => setSplitEntries((current) => current.map((row) => row.key === entry.key ? { ...row, item: { ...row.item, export: event.target.checked } } : row))} />导出</label>
                          {canvas && <button className={styles.textButton} type="button" onClick={() => sourceFromResult(canvas, `${entry.item.name || entry.item.id}-canvas.png`, entry.fullCanvas)}>画布</button>}
                        </span>
                      </div>;
                    })}
                    <div className={styles.operationBar}>
                      <label className={styles.checkField}><input type="checkbox" checked={exportModes.trim} onChange={(event) => setExportModes((value) => ({ ...value, trim: event.target.checked }))} />紧裁剪图</label>
                      <label className={styles.checkField}><input type="checkbox" checked={exportModes.canvas} onChange={(event) => setExportModes((value) => ({ ...value, canvas: event.target.checked }))} />全尺寸画布</label>
                      <button className={styles.secondaryButton} type="button" onClick={runMerge} disabled={!actionReady || isBusy || Boolean(pendingSubmission) || selectedEntries.length < 2 || !sameCanvasSize || selectedEntries.some((entry) => !entry.fullCanvas || !entryReferences(entry))}><LayersIcon />合并所选</button>
                      <span className={styles.subtleText}>已选 {selectedEntries.length} 个（当前已加载对象）</span><button className={styles.primaryButton} type="button" onClick={runExport} disabled={!actionReady || isBusy || Boolean(pendingSubmission) || selectedExportEntries.length === 0 || (!exportModes.trim && !exportModes.canvas)}><Archive size={15} />导出所选</button>
                      {selectedEntries.length > 1 && (!sameCanvasSize || selectedEntries.some(entry => !entry.fullCanvas || !entryReferences(entry))) && <span className={styles.subtleText}>所选对象缺少一致的全尺寸画布，不能合并。</span>}
                      <span className={styles.subtleText}>紧裁剪图去掉透明留白，全尺寸画布保留原位置与尺寸。</span>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>


          <details className={styles.continueTools}><summary>继续处理 · 裁剪与区域拆分</summary><p className={styles.strategyCopy}>使用当前输入，裁剪会改变输出尺寸；这些操作会创建服务任务，价格以服务实际规则为准。</p>          {source?.kind === 'result' && source.fullCanvas && sourceUrl && sourceWidth > 0 && sourceHeight > 0 && (
            <section className={styles.section} aria-label="区域拆分">
              <div className={styles.sectionHeading}><div><h2>区域拆分</h2><p>来源使用当前任务的完整结果引用，不会覆盖原图。</p></div></div>
              <RegionSelector imageUrl={sourceUrl} width={sourceWidth} height={sourceHeight} value={regionBox} onChange={setRegionBox} disabled={isBusy} />
              <div className={styles.operationBar}>
                <button className={styles.secondaryButton} type="button" onClick={runRegion} disabled={!regionBox || !actionReady || isBusy || Boolean(pendingSubmission)}><Crop size={15} />生成区域对象</button>
              </div>
            </section>
          )}
</details>
        </div>
        <aside className={styles.settingsColumn} aria-label="当前处理设置">
            {mode === 'characters' && (
              <div className={styles.settingsPanel}>
                <div className={styles.sectionHeading}>
                  <div><h2>拆切方式</h2></div>
                </div>
                <div className={styles.strategyTabs} role="group" aria-label="角色拆切策略">
                  <button type="button" className={`${styles.strategyTab} ${characterSettings.strategy === 'model_mask' ? styles.strategyActive : ''}`} aria-pressed={characterSettings.strategy === 'model_mask'} onClick={() => setCharacterSettings((value) => ({ ...value, strategy: 'model_mask' }))} disabled={isBusy}>自动识别</button>
                  <button type="button" className={`${styles.strategyTab} ${characterSettings.strategy === 'sam_box' ? styles.strategyActive : ''}`} aria-pressed={characterSettings.strategy === 'sam_box'} title={samAvailable ? '手动框选' : 'SAM 模型当前不可用'} onClick={() => { setCharacterSettings((value) => ({ ...value, strategy: 'sam_box' })); setView('original'); }} disabled={isBusy || !samAvailable}>手动框选</button>
                </div>
                <details className={styles.advancedSettings} open={characterOpen} onToggle={event => setCharacterOpen(event.currentTarget.open)}><summary>识别设置</summary><div className={styles.fieldGrid}>
                  <label className={styles.fieldLabel}>背景识别阈值<input className={styles.numberInput} type="number" min={2} max={128} value={characterSettings.background_distance_threshold} onChange={(event) => setCharacterSettings((value) => ({ ...value, background_distance_threshold: Number(event.target.value) }))} disabled={isBusy} /></label>
                  <label className={styles.fieldLabel}>最小角色面积（px²）<input className={styles.numberInput} type="number" min={16} max={2000000} value={characterSettings.min_component_area} onChange={(event) => setCharacterSettings((value) => ({ ...value, min_component_area: Number(event.target.value) }))} disabled={isBusy} /></label>
                  <label className={styles.fieldLabel}>边缘留白（px）<input className={styles.numberInput} type="number" min={0} max={512} value={characterSettings.padding} onChange={(event) => setCharacterSettings((value) => ({ ...value, padding: Number(event.target.value) }))} disabled={isBusy} /></label>
                  <label className={styles.fieldLabel}>最多角色数<input className={styles.numberInput} type="number" min={1} max={256} value={characterSettings.max_components} onChange={(event) => setCharacterSettings((value) => ({ ...value, max_components: Number(event.target.value) }))} disabled={isBusy} /></label>
                </div></details>
                {!samAvailable && <p className={styles.strategyCopy}>手动框选模型当前不可用，可继续使用自动识别。</p>}
              </div>
            )}


          <CutoutSettingsPanel settings={settings} modelOptions={modelOptions} advancedOpen={advancedOpen} adjustmentsOpen={adjustmentsOpen} disabled={isBusy || handoffBusy} onChange={setSettings} onAdvancedOpenChange={setAdvancedOpen} onAdjustmentsOpenChange={setAdjustmentsOpen} onReset={() => setSettings({ ...DEFAULT_CUTOUT_SETTINGS })} />
          {settingsChanged && <p className={styles.settingsChanged}>设置已修改，重新处理后生效；当前结果保留原设置。</p>}
          <p className={styles.strategyCopy}>费用暂无法确认，未提供可靠报价；开始前请按当前服务实际计费规则判断。</p>
            <div className={`${styles.statusNotice} ${!actionReady ? styles.statusWarning : ''}`} role="status">
              {capabilityLoading ? <LoaderCircle size={15} aria-hidden="true" /> : null}
              <span>{capabilityLoading ? '正在读取抠图服务状态。' : integrationCopy(capabilities)}</span>
              <button className={styles.iconButton} type="button" title="重新检查服务" aria-label="重新检查服务" disabled={capabilityLoading} onClick={() => {
                setCapabilityLoading(true);
                getCutoutCapabilities().then(setCapabilities).catch(() => setCapabilities(null)).finally(() => setCapabilityLoading(false));
              }}><RefreshCw size={14} aria-hidden="true" /></button>
            </div>

            {notice && <div className={`${styles.statusNotice} ${notice.kind === 'error' ? styles.statusError : notice.kind === 'warning' ? styles.statusWarning : ''}`} role="status">{notice.text}</div>}

            <div className={styles.primaryActions}>
              <button className={styles.primaryButton} type="button" onClick={submitMain} disabled={!source || !sourceSize || !preferencesReady || !draftReady || !actionReady || isBusy || handoffBusy || Boolean(pendingSubmission) || Boolean(handoffSelection.current && mode === 'cutout' && (!handoff || ['preparing', 'submitting', 'unknown', 'accepted'].includes(handoff.stage))) || (mode === 'characters' && characterSettings.strategy === 'sam_box' && !samAvailable)}>
                {isBusy ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
                {mutation === 'upload' ? '正在上传…' : mutation === 'submit' ? '正在提交…' : mode === 'cutout' ? settingsChanged ? '按新设置重新处理' : '开始抠图' : '开始角色拆切'}
              </button>
              {pendingSubmission && <button className={styles.secondaryButton} type="button" onClick={retrySubmission} disabled={isBusy || !actionReady}><RefreshCw size={15} />重试确认提交</button>}
              {source?.kind === 'result' && <button className={styles.secondaryButton} type="button" onClick={runCrop} disabled={!actionReady || isBusy || Boolean(pendingSubmission)}><Crop size={15} />裁剪透明边缘</button>}
              {source && <button className={styles.secondaryButton} type="button" onClick={runSplitPreview} disabled={!actionReady || isBusy || Boolean(pendingSubmission)}><Scan size={15} />拆分透明对象</button>}
              {mutation === 'upload' && <div className={styles.uploadProgress} role="status" aria-live="polite">
                <span>{uploadMessage}</span>
                <progress aria-label="原图上传进度" max={100} value={uploadProgress ? Math.floor(uploadProgress.percent) : undefined} />
              </div>}
            </div>

          <button className={styles.textButton} type="button" onClick={() => { setView('result'); setPreviewBackground('checker'); setAdjustmentsOpen(false); setCharacterOpen(false); setAdvancedOpen(false); setSelectedOutputId(''); }}>重置视图设置</button>
        </aside>
      </div>
      {historyOpen && createPortal(<div ref={historySurfaceRef} className={styles.historyBackdrop}><div ref={historyPanelRef} role="dialog" aria-modal="true" aria-label="最近任务" className={styles.historyDrawer}><header className={styles.sectionHeading}><h2>最近任务</h2><button className={styles.iconButton} type="button" aria-label="关闭最近任务" onClick={() => setHistoryOpen(false)}><X size={17} /></button></header>          <section className={styles.section} aria-labelledby="cutout-history-title">
            <div className={styles.sectionHeading}>
              <div className={styles.sectionTitle}><Archive size={17} aria-hidden="true" /><div><h2 id="cutout-history-title">任务记录</h2><p>{historyTotal == null ? '仅显示当前账户可访问的任务。' : `共 ${historyTotal} 条`}</p></div></div>
              <button className={styles.iconButton} type="button" title="刷新记录" aria-label="刷新记录" onClick={() => void loadHistory()} disabled={historyLoading}><RefreshCw size={15} /></button>
            </div>
            {historyError && <div className={`${styles.statusNotice} ${styles.statusError}`}>{capabilities?.integration && !capabilities.integration.configured ? `${integrationCopy(capabilities)} 历史记录暂未读取，已有参数保留。` : historyError}</div>}
            {historyLoading && history.length === 0 ? <p className={styles.emptyHint}>正在读取任务记录…</p> : null}
            {!historyLoading && history.length === 0 && !historyError ? <p className={styles.emptyHint}>还没有任务记录。</p> : null}
            <div className={styles.historyList}>
              {history.map((job) => {
                const thumbnail = jobThumbnail(job);
                return (
                  <div key={job.job_id} role="button" tabIndex={0} className={`${styles.historyRow} ${selectedJobId === job.job_id ? styles.historySelected : ''}`} onClick={() => void selectHistoryJob(job)} onKeyDown={event => { if (event.target !== event.currentTarget) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void selectHistoryJob(job); } }} aria-disabled={isBusy}>
                    <span className={styles.historyThumb}>
                      {thumbnail ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={thumbnail} alt="" /> : '暂无截图'}
                    </span>
                    <span className={styles.historyInfo}>
                      <strong>{job.kind === 'cutout' ? '普通抠图' : job.kind === 'characters' ? '角色拆切' : job.kind === 'crop' ? '透明裁剪' : job.kind === 'split_preview' ? '拆分预览' : job.kind === 'split_region' ? '区域拆分' : job.kind === 'split_merge' ? '合并对象' : '打包导出'}</strong>
                      <span className={styles.jobMeta}><RelativeTime value={timestampValue(job.created_at)} className={styles.timeText} /> · {job.job_id.slice(0, 8)}</span>
                    </span>
                    <span className={`${styles.statusBadge} ${job.status === 'succeeded' ? styles.statusSucceeded : job.status === 'failed' ? styles.statusFailed : job.status === 'running' ? styles.statusRunning : ''}`}>
                      {job.status === 'queued' ? '排队中' : job.status === 'running' ? '处理中' : job.status === 'succeeded' ? '已完成' : job.status === 'failed' ? '失败' : '已取消'}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className={styles.pager}>
              <span>{historyOffset + (history.length ? 1 : 0)}–{historyOffset + history.length}</span>
              <div className={styles.buttonRow}>
                <button className={styles.pagerButton} type="button" onClick={previousPage} disabled={historyOffset === 0 || historyLoading} aria-label="上一页"><ChevronLeft size={16} /></button>
                <button className={styles.pagerButton} type="button" onClick={nextPage} disabled={!canGoNext || historyLoading} aria-label="下一页"><ChevronRight size={16} /></button>
              </div>
            </div>
          </section>

</div></div>, document.body)}
      {zoom && <ZoomableImagePreview src={zoom.src} alt={zoom.alt} onClose={() => setZoom(null)} />}
      <ResourceLibraryPicker open={imagePickerOpen} imageOnly target="workspace" title="选择抠图原图" confirmLabel="使用所选图片" purpose="cutout-source" maxSelection={1} currentCount={0} currentAssetIds={[]}
        onClose={() => { sourceSelection.current++; setImagePickerOpen(false); }}
        onUploadFile={(file, onProgress) => uploadFileAsAsset(file, { onProgress })}
        onConfirm={async () => false} onConfirmSelection={selectLibraryImage} />
      {productDialog}
    </main>
  );
}

function LayersIcon() {
  return <Archive size={15} aria-hidden="true" />;
}
