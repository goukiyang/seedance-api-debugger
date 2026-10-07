'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import {
  Archive, Brush, ChevronLeft, ChevronRight, Crop, Download, Image as ImageIcon,
  LoaderCircle, Play, RefreshCw, Scan, Trash2, Upload, X,
} from 'lucide-react';
import PageBanner from '@/components/PageBanner';
import { RelativeTime } from '@/components/RelativeTime';
import { useProductDialog } from '@/components/useProductDialog';
import BrushRepair from '@/components/cutout/BrushRepair';
import CharacterBoxEditor from '@/components/cutout/CharacterBoxEditor';
import CutoutSettingsPanel from '@/components/cutout/CutoutSettingsPanel';
import RegionSelector from '@/components/cutout/RegionSelector';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';
import {
  cancelCutoutJob, createCutoutJob, cutoutResultReference, downloadCutoutBlob,
  getCutoutCapabilities, getCutoutHistory, getCutoutJob, saveCutoutBlob, uploadCutoutAsset,
} from '@/lib/cutout/client';
import type {
  Box, CharacterBox, CutoutCapabilities, CutoutJob, CutoutKind, CutoutSettings,
  ModelOption, PromptOverride, SplitItem,
} from '@/lib/cutout/types';
import { getPageExitRisk, usePageExitRisk } from '@/lib/hooks/page-exit-guard';
import {
  DEFAULT_CUTOUT_SETTINGS, loadCutoutPreferences, saveCutoutPreferences, loadPendingCutout, savePendingCutout,
  type CutoutMode,
} from '@/lib/cutout/settings';
import styles from './cutout.module.css';
import { isSamModelId } from '@/lib/cutout/models';
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
type LocalRepair = { result: Blob; mask: Blob; filename: string };

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

export default function CutoutPage() {
  const { confirm, productDialog } = useProductDialog();
  const actionLock = useRef(false);
  const mounted = useRef(true);
  const historyRequest = useRef(0);
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
  const [pendingSubmission, setPendingSubmission] = useState<PendingSubmission | null>(null);
  const [history, setHistory] = useState<CutoutJob[]>([]);
  const [historyTotal, setHistoryTotal] = useState<number | null>(null);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [selectedJob, setSelectedJob] = useState<CutoutJob | null>(null);
  const [selectedJobId, setSelectedJobId] = useState('');
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [pollPaused, setPollPaused] = useState(false);
  const [splitEntries, setSplitEntries] = useState<SplitEntry[]>([]);
  const [selectedEntryKeys, setSelectedEntryKeys] = useState<string[]>([]);
  const [exportModes, setExportModes] = useState({ trim: true, canvas: true });
  const [repairTarget, setRepairTarget] = useState<{ url: string; originalUrl?: string; cropMeta?: ReturnType<typeof normalizeCrop>; filename: string } | null>(null);
  const [repairDirty, setRepairDirty] = useState(false);
  const [localRepair, setLocalRepair] = useState<LocalRepair | null>(null);
  const [repairObjectUrl, setRepairObjectUrl] = useState('');
  const [zoom, setZoom] = useState<{ src: string; alt: string } | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [imagePickerOpen, setImagePickerOpen] = useState(false);
  const sourceSelection = useRef(0);
  const selectedJobIdRef = useRef('');
  const pendingSubmissionRef = useRef<PendingSubmission | null>(null);
  const terminalHandledRef = useRef(new Set<string>());
  const splitMetaByJobRef = useRef(new Map<string, { width: number; height: number } | null>());
  const pollFailuresRef = useRef(0);
  const pollAttemptsRef = useRef(0);

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
      ...(localRepair ? ['本地修复结果尚未下载或继续处理'] : []),
      ...(pendingSubmission ? ['任务提交结果尚未确认'] : []),
    ],
    busy: isBusy ? [mutation === 'upload' ? '图片上传中' : mutation === 'cancel' ? '正在取消任务' : '正在提交任务'] : [],
    revision: `${source?.id || ''}:${selectedJobId}:${boxes.length}:${prompts.length}:${regionBox ? `${regionBox.x},${regionBox.y},${regionBox.w},${regionBox.h}` : ''}:${repairDirty}:${pendingSubmission?.key || ''}`,
  });

  const chooseJob = useCallback((job: CutoutJob | null) => {
    if (selectedJobIdRef.current !== (job?.job_id || '')) {
      pollFailuresRef.current = 0;
      pollAttemptsRef.current = 0;
    }
    selectedJobIdRef.current = job?.job_id || '';
    setSelectedJob(job);
    setSelectedJobId(job?.job_id || '');
    setPollPaused(false);
  }, []);

  const sourceFromResult = useCallback(async (url: string, name: string, fullCanvas: boolean) => {
    if (actionLock.current || pendingSubmissionRef.current || getPageExitRisk().busy.length) return;
    if ((repairDirty || localRepair || boxes.length || prompts.length) && !await confirm('切换图片会清除当前未应用的修图和框选。原图、服务器结果不会被修改。', { title: '切换图片', confirmLabel: '切换' })) return;
    try {
      const reference = cutoutResultReference(url);
      setSource({ id: makeId(), kind: 'result', url, reference, name, fullCanvas });
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
  }, [boxes.length, confirm, localRepair, prompts.length, repairDirty]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; historyRequest.current++; };
  }, []);

  const setJobResult = useCallback((job: CutoutJob) => {
    if (selectedJobIdRef.current && selectedJobIdRef.current !== job.job_id) return;
    chooseJob(job);
    if (job.status !== 'succeeded' || terminalHandledRef.current.has(job.job_id)) return;
    terminalHandledRef.current.add(job.job_id);
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
        selectedJobIdRef.current = preferences.selectedJobId || '';
        setSelectedJobId(preferences.selectedJobId || '');
      }
      const pending = loadPendingCutout(accountId);
      if (pending) {
        pendingSubmissionRef.current = pending;
        setPendingSubmission(pending);
        setNotice({ kind: 'warning', text: '上次提交结果未确认，已找回原提交标识。可先查看历史，或用原标识重试确认。' });
      }
    }
    setPreferencesReady(true);
  }, [accountId, authChecked, isAdmin]);

  useEffect(() => {
    if (!preferencesReady || !accountId) return;
    saveCutoutPreferences(accountId, { settings, mode, advancedOpen, selectedJobId: selectedJobId || null, historyOffset });
  }, [accountId, advancedOpen, historyOffset, mode, preferencesReady, selectedJobId, settings]);

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

  useEffect(() => {
    if (!authChecked || !isAdmin || !preferencesReady) return;
    void loadHistory();
  }, [authChecked, isAdmin, loadHistory, preferencesReady]);

  useEffect(() => {
    if (!preferencesReady || !selectedJobId || selectedJob) return;
    let active = true;
    getCutoutJob(selectedJobId)
      .then((job) => { if (active) setJobResult(job); })
      .catch((error) => { if (active) setNotice({ kind: 'error', text: safeError(error, 'history') }); });
    return () => { active = false; };
  }, [preferencesReady, selectedJobId, selectedJob, setJobResult]);

  useEffect(() => {
    if (!selectedJob || !['queued', 'running'].includes(selectedJob.status) || pollPaused) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (!active || selectedJobIdRef.current !== selectedJob.job_id) return;
      pollAttemptsRef.current += 1;
      if (pollAttemptsRef.current > 40) {
        setPollPaused(true);
        setNotice({ kind: 'warning', text: '自动查询已暂停；任务仍可在历史中手动重新查询。' });
        return;
      }
      try {
        const job = await getCutoutJob(selectedJob.job_id);
        if (!active || selectedJobIdRef.current !== job.job_id) return;
        pollFailuresRef.current = 0;
        setJobResult(job);
        if (['queued', 'running'].includes(job.status)) timer = setTimeout(poll, 3500);
        else void loadHistory();
      } catch {
        if (!active) return;
        pollFailuresRef.current += 1;
        if (pollFailuresRef.current >= 3) {
          setPollPaused(true);
          setNotice({ kind: 'warning', text: '任务状态暂时无法自动更新；可手动重新查询。' });
          return;
        }
        timer = setTimeout(poll, 5000);
      }
    };
    timer = setTimeout(poll, 3500);
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [loadHistory, pollPaused, selectedJob?.job_id, selectedJob?.status, setJobResult]);

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

  const acceptFile = useCallback(async (file: File | null, preserveRepair = false) => {
    if (actionLock.current || isBusy || pendingSubmission || getPageExitRisk().busy.length) return false;
    const token = ++sourceSelection.current;
    if ((repairDirty || (!preserveRepair && localRepair) || boxes.length || prompts.length) && !await confirm('更换图片会清除当前未应用的修图和框选。原图、服务器结果不会被修改。', { title: '更换图片', confirmLabel: '继续' })) return false;
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
    if (!mounted.current || sourceSelection.current !== token || actionLock.current || pendingSubmissionRef.current || getPageExitRisk().busy.length) return false;
    setSource({ id: makeId(), kind: 'local', file, name: file.name || 'image.png' });
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
  }, [boxes.length, capabilities?.limits?.max_upload_mb, confirm, isBusy, localRepair, pendingSubmission, prompts.length, repairDirty]);

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
    if ((repairDirty || localRepair) && !await confirm('切换记录会关闭当前未应用的修图。服务器结果不会被删除。', { title: '切换记录', confirmLabel: '切换' })) return;
    chooseJob(job);
    setRepairTarget(null);
    setRepairDirty(false);
    setLocalRepair(null);
    setRegionBox(null);
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
    let image: Blob = chosen.kind === 'local' ? chosen.file : await downloadCutoutBlob(chosen.url);
    const uploaded = await uploadCutoutAsset(image, chosen.name);
    if (!mounted.current) throw new Error('页面已离开，未创建任务');
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
      chooseJob(job);
      setNotice(job.status === 'failed' || job.status === 'canceled'
        ? { kind: 'warning', text: job.status === 'failed' ? '任务已受理，但处理失败；原图与已有结果保留。' : '任务已受理，但已经取消；原图与已有结果保留。' }
        : { kind: 'success', text: job.status === 'succeeded' ? '任务已完成。' : '任务已提交，完成后会显示结果。' });
      setJobResult(job);
    } catch (error) {
      const status = typeof error === 'object' && error && 'status' in error ? Number((error as { status?: unknown }).status) : -1;
      if (status === 0 || status >= 500 || (typeof error === 'object' && error && 'submissionMade' in error && error.submissionMade === null)) {
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
      setNotice({ kind: 'error', text: safeError(error, 'upload') });
    } finally { actionLock.current = false; }
  }, [actionReady, capabilities, getOrUploadAsset, preferencesReady, source, sourceSize, submitWithKey]);

  const retrySubmission = () => {
    const pending = pendingSubmissionRef.current;
    if (pending && !isBusy && !actionLock.current && actionReady) {
      actionLock.current = true;
      void submitWithKey(pending).finally(() => { actionLock.current = false; });
    }
  };

  const submitMain = () => {
    if (mode === 'cutout') {
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

  const eligibleEntries = useMemo(() => splitEntries.filter((entry) => entry.fullCanvas && entry.width && entry.height), [splitEntries]);
  const sameCanvasSize = eligibleEntries.length > 0 && eligibleEntries.every((entry) => (
    entry.width === eligibleEntries[0].width && entry.height === eligibleEntries[0].height
  ));
  const selectedEntries = splitEntries.filter((entry) => selectedEntryKeys.includes(entry.key));
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
    if (!selectedJobId || isBusy) return;
    setMutation('submit');
    setNotice({ kind: 'info', text: '正在重新查询任务。' });
    try {
      const job = await getCutoutJob(selectedJobId);
      setJobResult(job);
      setNotice({ kind: 'success', text: '任务状态已更新。' });
      setPollPaused(false);
      pollFailuresRef.current = 0;
      pollAttemptsRef.current = 0;
    } catch (error) {
      setNotice({ kind: 'error', text: safeError(error, 'history') });
    } finally { setMutation(null); }
  };

  const cancelQueued = async () => {
    if (!selectedJob || selectedJob.status !== 'queued' || isBusy) return;
    setMutation('cancel');
    try {
      const job = await cancelCutoutJob(selectedJob.job_id);
      setJobResult(job);
      setNotice({ kind: 'success', text: '已取消排队中的任务。' });
      void loadHistory();
    } catch (error) {
      setNotice({ kind: 'error', text: safeError(error, 'cancel') });
      if (typeof error === 'object' && error && 'status' in error && Number((error as { status?: unknown }).status) === 409) {
        try { setJobResult(await getCutoutJob(selectedJob.job_id)); } catch { /* user can requery */ }
      }
    } finally { setMutation(null); }
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
    if (!repairTarget) return;
    const filename = repairTarget.filename.replace(/\.[^.]+$/, '') + '-修复.png';
    setLocalRepair({ result, mask, filename });
    setRepairDirty(false);
    setNotice({ kind: 'success', text: '修复结果只保存在当前页面；原图和服务器结果未修改。' });
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

  const result = selectedJob?.result || null;
  const sourceWidth = sourceSize?.width || 0;
  const sourceHeight = sourceSize?.height || 0;
  const selectedImageUrl = result?.result_url ? resultFileUrl(selectedJob!.job_id, result.result_url) : '';
  const resultCrop = normalizeCrop(result?.crop);
  const samAvailable = Boolean(capabilities?.models?.some(model => model.available === true && isSamModelId(model.id) && model.id === characterSettings.sam_model_id));

  return (
    <main className={styles.page}>
      <PageBanner
        eyebrow="SD2 · 管理工具"
        title="AI 抠图工作台"
        backHref="/admin"
        backLabel="返回管理台"
        tone="dark"
      />

      <div className={styles.layout}>
        <div className={styles.column}>
          <section className={styles.section} aria-labelledby="cutout-source-title">
            <div className={styles.sectionHeading}>
              <div className={styles.sectionTitle}>
                <ImageIcon size={17} aria-hidden="true" />
                <div><h2 id="cutout-source-title">处理图片</h2></div>
              </div>
            </div>
            <div
              className={`${styles.sourceDropzone} ${dragActive ? styles.sourceDropActive : ''}`}
              onDragEnter={(event) => { event.preventDefault(); if (!isBusy && !pendingSubmission) setDragActive(true); }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragActive(false); }}
              onDrop={onDrop}
            >
              <Upload size={21} aria-hidden="true" />
              <strong>拖入图片，或从剪贴板粘贴</strong>
              <span>支持 PNG、JPG、WebP；按服务端限制校验大小</span>
              <div className={styles.buttonRow}>
                <button className={styles.secondaryButton} type="button" onClick={() => setImagePickerOpen(true)} disabled={isBusy || Boolean(pendingSubmission)}>
                  <Upload size={15} aria-hidden="true" />选择图片
                </button>
                {source && <button className={styles.quietButton} type="button" onClick={() => acceptFile(null)} disabled={isBusy || Boolean(pendingSubmission)} title="清除当前图片"><X size={15} />清除</button>}
              </div>
              <input ref={fileInputRef} className={styles.hiddenInput} type="file" accept="image/png,image/jpeg,image/webp" onChange={onFileInput} />
            </div>

            {source && (
              <>
                <div className={styles.sourceHeading}>
                  <strong title={source.name}>{source.name}</strong>
                  {source.kind === 'result' && <span className={styles.statusBadge}>来自任务结果</span>}
                </div>
                {sourceUrl && (
                  <div className={styles.sourceStage}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      className={styles.sourceImage}
                      src={sourceUrl}
                      alt="当前处理图片"
                      onDoubleClick={() => setZoom({ src: sourceUrl, alt: source.name })}
                      onLoad={(event) => { if (event.currentTarget.currentSrc === new URL(sourceUrl, window.location.origin).href) setSourceSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); }}
                      onError={() => setNotice({ kind: 'error', text: '图片无法读取，请更换有效图片。' })}
                    />
                  </div>
                )}
                <div className={styles.sourceHint}>
                  <span>{sourceWidth && sourceHeight ? `${sourceWidth} × ${sourceHeight} px` : '正在读取图片尺寸'}</span>
                  <span>{source.kind === 'local' ? cachedAsset?.sourceId === source.id ? '已暂存' : '尚未上传' : source.fullCanvas ? '全尺寸画布' : '单个结果图'}</span>
                  <button className={styles.iconButton} title="查看大图" aria-label="查看原图大图" onClick={() => setZoom({ src: sourceUrl, alt: source.name })}><ImageIcon size={16} /></button>
                </div>
              </>
            )}

            <div className={styles.modeTabs} role="tablist" aria-label="处理方式">
              <button type="button" role="tab" aria-selected={mode === 'cutout'} className={`${styles.modeTab} ${mode === 'cutout' ? styles.modeActive : ''}`} onClick={() => setMode('cutout')} disabled={isBusy}>
                普通抠图
              </button>
              <button type="button" role="tab" aria-selected={mode === 'characters'} className={`${styles.modeTab} ${mode === 'characters' ? styles.modeActive : ''}`} onClick={() => setMode('characters')} disabled={isBusy}>
                角色拆切
              </button>
            </div>

            {mode === 'characters' && (
              <div className={styles.settingsPanel}>
                <div className={styles.sectionHeading}>
                  <div><h2>拆切方式</h2></div>
                </div>
                <div className={styles.strategyTabs} role="group" aria-label="角色拆切策略">
                  <button type="button" className={`${styles.strategyTab} ${characterSettings.strategy === 'model_mask' ? styles.strategyActive : ''}`} aria-pressed={characterSettings.strategy === 'model_mask'} onClick={() => setCharacterSettings((value) => ({ ...value, strategy: 'model_mask' }))} disabled={isBusy}>自动识别</button>
                  <button type="button" className={`${styles.strategyTab} ${characterSettings.strategy === 'sam_box' ? styles.strategyActive : ''}`} aria-pressed={characterSettings.strategy === 'sam_box'} title={samAvailable ? 'SAM 手动框选' : 'SAM 模型当前不可用'} onClick={() => setCharacterSettings((value) => ({ ...value, strategy: 'sam_box' }))} disabled={isBusy || !samAvailable}>SAM 手动框选</button>
                </div>
                <div className={styles.fieldGrid}>
                  <label className={styles.fieldLabel}>背景识别阈值<input className={styles.numberInput} type="number" min={2} max={128} value={characterSettings.background_distance_threshold} onChange={(event) => setCharacterSettings((value) => ({ ...value, background_distance_threshold: Number(event.target.value) }))} disabled={isBusy} /></label>
                  <label className={styles.fieldLabel}>最小角色面积<input className={styles.numberInput} type="number" min={16} max={2000000} value={characterSettings.min_component_area} onChange={(event) => setCharacterSettings((value) => ({ ...value, min_component_area: Number(event.target.value) }))} disabled={isBusy} /></label>
                  <label className={styles.fieldLabel}>边缘留白<input className={styles.numberInput} type="number" min={0} max={512} value={characterSettings.padding} onChange={(event) => setCharacterSettings((value) => ({ ...value, padding: Number(event.target.value) }))} disabled={isBusy} /></label>
                  <label className={styles.fieldLabel}>最多角色数<input className={styles.numberInput} type="number" min={1} max={256} value={characterSettings.max_components} onChange={(event) => setCharacterSettings((value) => ({ ...value, max_components: Number(event.target.value) }))} disabled={isBusy} /></label>
                </div>
                {characterSettings.strategy === 'sam_box' && sourceUrl && sourceWidth > 0 && sourceHeight > 0 && (
                  <div>
                    <CharacterBoxEditor
                      imageUrl={sourceUrl}
                      width={sourceWidth}
                      height={sourceHeight}
                      boxes={boxes}
                      onBoxesChange={setBoxes}
                      prompts={prompts}
                      onPromptsChange={setPrompts}
                      disabled={isBusy}
                    />
                  </div>
                )}
              </div>
            )}

            <CutoutSettingsPanel
              settings={settings}
              modelOptions={modelOptions}
              advancedOpen={advancedOpen}
              disabled={isBusy}
              onChange={setSettings}
              onAdvancedOpenChange={setAdvancedOpen}
              onReset={() => setSettings({ ...DEFAULT_CUTOUT_SETTINGS })}
            />

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
              <button className={styles.primaryButton} type="button" onClick={submitMain} disabled={!source || !sourceSize || !preferencesReady || !actionReady || isBusy || Boolean(pendingSubmission) || (mode === 'characters' && characterSettings.strategy === 'sam_box' && !samAvailable)}>
                {isBusy ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
                {isBusy ? '处理中…' : mode === 'cutout' ? '开始普通抠图' : '开始角色拆切'}
              </button>
              {pendingSubmission && <button className={styles.secondaryButton} type="button" onClick={retrySubmission} disabled={isBusy || !actionReady}><RefreshCw size={15} />重试确认提交</button>}
              {source?.kind === 'result' && <button className={styles.secondaryButton} type="button" onClick={runCrop} disabled={!actionReady || isBusy || Boolean(pendingSubmission)}><Crop size={15} />裁剪透明边缘</button>}
              {source && <button className={styles.secondaryButton} type="button" onClick={runSplitPreview} disabled={!actionReady || isBusy || Boolean(pendingSubmission)}><Scan size={15} />拆分透明对象</button>}
            </div>
          </section>

          {source?.kind === 'result' && source.fullCanvas && sourceUrl && sourceWidth > 0 && sourceHeight > 0 && (
            <section className={styles.section} aria-label="区域拆分">
              <div className={styles.sectionHeading}><div><h2>区域拆分</h2><p>来源使用当前任务的完整结果引用，不会覆盖原图。</p></div></div>
              <RegionSelector imageUrl={sourceUrl} width={sourceWidth} height={sourceHeight} value={regionBox} onChange={setRegionBox} disabled={isBusy} />
              <div className={styles.operationBar}>
                <button className={styles.secondaryButton} type="button" onClick={runRegion} disabled={!regionBox || !actionReady || isBusy || Boolean(pendingSubmission)}><Crop size={15} />生成区域对象</button>
              </div>
            </section>
          )}
        </div>

        <div className={styles.column}>
          <section className={styles.section} aria-labelledby="cutout-history-title">
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

          <section className={styles.section} aria-labelledby="cutout-result-title">
            <div className={styles.resultHeader}>
              <div className={styles.sectionTitle}><ImageIcon size={17} aria-hidden="true" /><div><h2 id="cutout-result-title">任务结果</h2><p>{selectedJob ? `${selectedJob.job_id.slice(0, 12)} · ${selectedJob.status === 'queued' ? '排队中' : selectedJob.status === 'running' ? '处理中' : selectedJob.status === 'succeeded' ? '已完成' : selectedJob.status === 'failed' ? '失败' : '已取消'}` : '选择一条任务查看结果。'}</p></div></div>
              {selectedJob && <div className={styles.buttonRow}>
                <button className={styles.iconButton} type="button" title="重新查询" aria-label="重新查询" onClick={() => void requerySelected()} disabled={isBusy}><RefreshCw size={15} /></button>
                {selectedJob.status === 'queued' && <button className={styles.iconButton} type="button" title="取消排队任务" aria-label="取消排队任务" onClick={() => void cancelQueued()} disabled={isBusy}><X size={15} /></button>}
              </div>}
            </div>

            {!selectedJob && <p className={styles.emptyHint}>提交任务后，处理进度和可用结果会显示在这里。</p>}
            {selectedJob && ['queued', 'running'].includes(selectedJob.status) && <div className={styles.statusNotice}><LoaderCircle size={15} aria-hidden="true" />{selectedJob.status === 'queued' ? '任务已进入队列，离开页面不会重复提交。' : '任务正在处理；页面会有限次自动查询，也可手动重新查询。'}</div>}
            {selectedJob?.status === 'failed' && <div className={`${styles.statusNotice} ${styles.statusError}`}>任务未完成。原图仍保留，请检查参数后重新提交。</div>}
            {selectedJob?.status === 'canceled' && <div className={styles.statusNotice}>任务已取消，原图与其他任务结果不受影响。</div>}

            {selectedJob?.status === 'succeeded' && result && (
              <>
                {selectedImageUrl && (
                  <article className={styles.resultTile}>
                    <div className={styles.resultTileHeader}><strong>{result.filename || '抠图结果'}</strong><span className={styles.statusBadge}>结果</span></div>
                    <div className={styles.imageFrame}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img className={styles.resultImage} src={selectedImageUrl} alt="抠图结果" onDoubleClick={() => setZoom({ src: selectedImageUrl, alt: '抠图结果' })} />
                    </div>
                    <div className={styles.resultActions}>
                      <button className={styles.textButton} type="button" onClick={() => void downloadResult(selectedImageUrl, result.filename || 'cutout.png')}><Download size={14} />下载结果</button>
                      <button className={styles.textButton} type="button" onClick={() => sourceFromResult(selectedImageUrl, result.filename || 'cutout.png', true)}>作为后续图片</button>
                      {selectedJob.kind === 'cutout' && <button className={styles.textButton} type="button" onClick={() => {
                        const originalUrl = source?.kind === 'local' && originalSourceByJob.current.get(selectedJob.job_id) === source.id ? sourceUrl : undefined;
                        setRepairTarget({ url: selectedImageUrl, originalUrl, cropMeta: resultCrop, filename: result.filename || 'cutout.png' });
                      }}><Brush size={14} />局部修复</button>}
                      <button className={styles.iconButton} title="查看大图" aria-label="查看结果大图" onClick={() => setZoom({ src: selectedImageUrl, alt: '抠图结果' })}><ImageIcon size={16} /></button>
                    </div>
                  </article>
                )}
                {result.mask_url && (
                  <div className={styles.operationBar}>
                    <button className={styles.textButton} type="button" onClick={() => void downloadResult(resultFileUrl(selectedJob.job_id, result.mask_url), 'cutout-mask.png')}><Download size={14} />下载遮罩</button>
                  </div>
                )}
                {selectedJob.kind === 'characters' && Array.isArray(result.items) && (
                  <div className={styles.resultGrid}>
                    {result.items.map((item, index) => {
                      const url = resultFileUrl(selectedJob.job_id, item.result_url || item.result_filename);
                      if (!url) return null;
                      return <article className={styles.resultTile} key={`${selectedJob.job_id}:${item.id || index}`}>
                        <div className={styles.resultTileHeader}><strong>{item.name || item.id || `角色 ${index + 1}`}</strong><span className={styles.statusBadge}>{item.meta?.model || '角色结果'}</span></div>
                        <div className={styles.imageFrame}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img className={styles.resultImage} src={url} alt={item.name || `角色 ${index + 1}`} onDoubleClick={() => setZoom({ src: url, alt: item.name || `角色 ${index + 1}` })} />
                        </div>
                        <div className={styles.resultActions}>
                          <button className={styles.textButton} type="button" onClick={() => void downloadResult(url, item.result_filename || `${item.name || item.id || 'character'}.png`)}><Download size={14} />下载</button>
                          {item.mask_url && <button className={styles.textButton} type="button" onClick={() => void downloadResult(resultFileUrl(selectedJob.job_id, item.mask_url), item.mask_filename || 'character-mask.png')}><Download size={14} />遮罩</button>}
                          <button className={styles.iconButton} title="查看大图" aria-label={`查看${item.name || item.id || index + 1}大图`} onClick={() => setZoom({ src: url, alt: item.name || '角色结果' })}><ImageIcon size={16} /></button>
                          <button className={styles.textButton} type="button" onClick={() => sourceFromResult(url, item.result_filename || item.name || 'character.png', false)}>作为后续图片</button>
                        </div>
                      </article>;
                    })}
                  </div>
                )}
                {(result.contact_sheet_url || result.manifest_url || result.zip_url) && (
                  <div className={styles.operationBar} aria-label="任务附带文件">
                    {result.contact_sheet_url && <button className={styles.textButton} type="button" onClick={() => void downloadResult(resultFileUrl(selectedJob.job_id, result.contact_sheet_url), 'contact-sheet.png')}><Download size={14} />总览图</button>}
                    {result.manifest_url && <button className={styles.textButton} type="button" onClick={() => void downloadResult(resultFileUrl(selectedJob.job_id, result.manifest_url), 'manifest.json')}><Download size={14} />清单</button>}
                    {result.zip_url && <button className={styles.textButton} type="button" onClick={() => void downloadResult(resultFileUrl(selectedJob.job_id, result.zip_url), 'cutout-results.zip')}><Download size={14} />ZIP</button>}
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
                        {preview ? /* eslint-disable-next-line @next/next/no-img-element */ <img className={styles.splitThumb} src={preview} alt="" onDoubleClick={() => setZoom({ src: preview, alt: entry.item.name || '拆分对象' })} /> : <span className={styles.historyThumb}>暂无截图</span>}
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
                      <button className={styles.secondaryButton} type="button" onClick={runExport} disabled={!actionReady || isBusy || Boolean(pendingSubmission) || selectedExportEntries.length === 0 || (!exportModes.trim && !exportModes.canvas)}><Archive size={15} />导出所选</button>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>

          {repairTarget && (
            <section className={styles.section} aria-label="局部修复">
              <div className={styles.sectionHeading}><div><h2>局部修复</h2></div><button className={styles.iconButton} type="button" title="关闭局部修复" aria-label="关闭局部修复" onClick={async () => { if (!repairDirty || await confirm('放弃未应用的画笔修改？', { title: '关闭修图', confirmLabel: '放弃修改' })) { setRepairTarget(null); setRepairDirty(false); } }}><X size={15} /></button></div>
              <BrushRepair resultUrl={repairTarget.url} originalUrl={repairTarget.originalUrl} cropMeta={repairTarget.cropMeta} filename={repairTarget.filename} disabled={isBusy} onDraftDirtyChange={setRepairDirty} onApply={onApplyRepair} />
            </section>
          )}

          {localRepair && repairObjectUrl && (
            <section className={styles.section} aria-label="本地修复结果">
              <div className={styles.sectionHeading}><div><h2>本地修复结果</h2><p>仅保存在当前页面内存中；需要处理时会作为一张新图片上传。</p></div></div>
              <div className={styles.imageFrame}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className={styles.resultImage} src={repairObjectUrl} alt="本地修复结果" onDoubleClick={() => setZoom({ src: repairObjectUrl, alt: '本地修复结果' })} />
              </div>
              <div className={styles.resultActions}>
                <button className={styles.textButton} type="button" onClick={() => saveCutoutBlob(localRepair.result, localRepair.filename)}><Download size={14} />下载修复图</button>
                <button className={styles.textButton} type="button" onClick={() => saveCutoutBlob(localRepair.mask, localRepair.filename.replace(/\.png$/, '-mask.png'))}><Download size={14} />下载修复遮罩</button>
                <button className={styles.secondaryButton} type="button" onClick={useLocalRepair} disabled={isBusy || Boolean(pendingSubmission)}>作为新图片处理</button>
                <button className={styles.iconButton} type="button" title="移除本地结果" aria-label="移除本地结果" onClick={async () => { if (await confirm('移除尚未上传的本地修复结果？原图和服务器结果仍保留。', { title: '移除本地结果', confirmLabel: '移除', danger: true })) setLocalRepair(null); }}><Trash2 size={15} /></button>
              </div>
            </section>
          )}
        </div>
      </div>
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
