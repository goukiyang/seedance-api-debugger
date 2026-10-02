'use client';
import { LoadingSkeleton, LoadingStatus } from '@/components/LoadingState';

import { useProductDialog } from '@/components/useProductDialog';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Clipboard, Copy, Download, ImagePlus, Settings, X, RefreshCw, LoaderCircle, Plus, Save, Trash2 } from 'lucide-react';
import { uploadFileAsAsset, type UploadedAssetPayload, type UploadProgressSnapshot } from '@/lib/http/file-upload';
import { UploadProgressIndicator } from '@/components/UploadProgressIndicator';
import { UploadedImagePicker } from '@/components/UploadedImagePicker';
import { useRememberedScroll } from '@/lib/hooks/use-remembered-scroll';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { RelativeTime } from '@/components/RelativeTime';
import { useUnsavedNavigation } from '@/lib/hooks/use-unsaved-navigation';
import { copyImage } from '@/lib/media/copy-image';

function studioUploadProgress(file: File, index: number, count: number, progress: UploadProgressSnapshot) {
  const transferring = ['raw', 'proxy', 'storage', 'multipart'].includes(progress.phase);
  const sent = transferring && progress.totalBytes && progress.loadedBytes != null && progress.loadedBytes >= progress.totalBytes;
  return {
    label: sent ? '上传已传完，服务器处理中' : progress.label,
    detail: `${index + 1}/${count} · ${file.name}`,
    percent: transferring && !sent && progress.totalBytes && progress.loadedBytes != null
      ? Math.min(99, Math.floor(progress.loadedBytes / progress.totalBytes * 100)) : undefined,
  };
}
import { ZoomableImagePreview, type ImagePreviewMetadata } from '@/components/ZoomableImagePreview';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import ContentReactions from '@/components/content-reactions/ContentReactions';
import styles from './studio.module.css';
import { StudioReferenceGrid, type FixedStudioReference } from './reference-grid';
import { RatioPicker } from './ratio-picker';
import { useStudioSettings } from './use-studio-settings';
import { StudioGlobalSettingsDialog } from './global-settings-dialog';
import { StudioStyleGroups, type StudioStyleSummary } from './style-groups-view';
import type { SettingsValue } from './settings-controller';
import { normalizeStudioRatio, resolveStudioAspectRatio } from '@/lib/image-studio/ratios';
import { MAX_REFERENCE_IMAGES } from '@/lib/image-studio/limits';
import type { StudioReferencePolicy } from '@/lib/image-studio/reference-policy';
import { IMAGE_STUDIO_MODELS, IMAGE_STUDIO_MODEL_COST_USD, IMAGE_STUDIO_MODEL_LABELS, IMAGE_STUDIO_MODEL_SHORT_LABELS, IMAGE_STUDIO_MODEL_QUALITY_OPTIONS, IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS, IMAGE_STUDIO_QUALITY_LABELS, defaultImageResolution, defaultImageStudioQuality, normalizeImageResolution, normalizeImageStudioQuality, type ImageResolution } from '@/lib/image-studio/model-catalog';

type StudioSnapshot = { referencePolicy?: StudioReferencePolicy; primaryReferenceImages?: UploadedAssetPayload[]; auxiliaryReferenceImages?: UploadedAssetPayload[]; prompt: string; model: string; quality?: string; resolution?: string | null; count: number; aspectRatio: string; resolvedAspectRatio?: string; aspectRatioSource?: string; outputSize?: string | null; resolvedOutputSize?: string | null; globalContext?: string; moduleContext?: string; unitCredits?: number | null; sourceAvailable?: boolean; referenceImages: UploadedAssetPayload[]; fixedReferenceImages?: FixedStudioReference[]; transientReferenceImages?: UploadedAssetPayload[]; fixedReferenceCount?: number; styleGroupIds?: string[]; styleGroups?: StudioStyleSummary[] };
type StudioTask = { id: string; batchId: string; ordinal: number; owner?: { id: string; name: string; avatar_url: string | null } | null; prompt: string; model: string; quality?: string; status: string; error?: string; unitCredits: number; referenceIds: string[]; aspectRatio: string; outputSize?: string; createdAt: string; snapshot?: StudioSnapshot; delivery?: { phase: string; receivedBytes?: number; expectedBytes?: number; recoveryAvailable: boolean; checkpointRetained: boolean; requestId?: string; upstreamRequestId?: string; validation?: { originalFormat: string; storedFormat: string; width: number; height: number; requestedSize?: string } }; asset: { id?: string; original_url: string; thumbnail_url?: string; width?: number; height?: number } | null };
function studioTaskPhase(task: StudioTask) {
  const phase = task.delivery?.phase;
  return ({ queued: '等待生成', provider: '生成中', unknown: '生成结果待确认', download: '原图下载中', recover: '恢复原图中', validate: '图片校验中', save: '保存中', stopped: '原图交付停止', failed: '未能交付图片', ready: task.asset ? '已完成' : '图片已移除' } as Record<string, string>)[phase || '']
    || (task.status === 'running' ? '生成中' : task.status === 'queued' ? '等待生成' : task.status === 'uncertain' ? '生成结果待确认' : '未能交付图片');
}
type StudioModule = { referencePolicy?: StudioReferencePolicy; id: string; name: string; prompt: string; context?: string; contextConfigured: boolean; count: number; referenceLimit: number; aspectRatio: string; resolution: ImageResolution; model: string; quality: string; groupName: string; banner: UploadedAssetPayload | null; cover?: { resultUrl: string; thumbnailUrl?: string | null; referenceUrl?: string | null } | null; prices: Record<string, number | null>; unitCredits: number | null; reproduceFromTaskId: string | null; sourcePresetId?: string | null; sourcePresetShared?: boolean | null; sourcePresetCanManageSharing?: boolean; images: UploadedAssetPayload[]; revision: number; saved: boolean; createdAt: string; fixedReferenceCount?: number; fixedReferencesEditable?: boolean; styleGroupIds?: string[]; styleGroups?: StudioStyleSummary[]; reproductionState?: { fixedReferenceCount: number; styleGroups: StudioStyleSummary[] } | null };
type StudioPreset = { id: string; name: string; scope: 'admin' | 'creator'; isShared: boolean; canManageSharing?: boolean; groupName: string; model: string; quality: string; resolution: ImageResolution; count: number; referenceLimit: number; aspectRatio: string; images: UploadedAssetPayload[]; banner: UploadedAssetPayload | null; contextConfigured: boolean; createdAt: string };
type StudioFeedback = { message: string; tone: 'progress' | 'info' | 'success' | 'warning' | 'error' };
type ImagePreviewState = { contentKey?: `asset:${string}`; taskId?: string; src: string; alt: string; title?: string; fileName?: string; width?: number; height?: number; metadata?: ImagePreviewMetadata; comparison?: { src: string; alt: string; fileName?: string; thumbnailSrc?: string } };
type RatioPreferences = { custom: string[]; busy: boolean; error: string; onRetry: () => void; onCustom: (ratio: string, remove: boolean) => Promise<boolean> };
const models = IMAGE_STUDIO_MODELS;
const fixedReferencePayload = (items: FixedStudioReference[]) => items.map(item => ({ assetId: item.id, note: item.note || '' }));
const DEFAULT_GROUPS = ['未分组', '常用', '角色', '场景', '海报'];
function moduleReferencePolicy(module: StudioModule): StudioReferencePolicy {
  const policy = module.referencePolicy;
  return { primaryIds: policy?.primaryIds ?? module.images.flatMap(image => image.id ? [image.id] : []),
    primaryMin: policy?.primaryMin ?? 0, primaryMax: policy?.primaryMax ?? (module.referenceLimit || MAX_REFERENCE_IMAGES),
    auxiliaryMax: policy?.auxiliaryMax ?? MAX_REFERENCE_IMAGES, styleMax: policy?.styleMax ?? MAX_REFERENCE_IMAGES,
    referenceMax: policy?.referenceMax ?? MAX_REFERENCE_IMAGES, useFixedReferences: policy?.useFixedReferences ?? true };
}
async function readResponse(response: Response) {
  const value = await response.json().catch(() => { throw new Error('服务暂时无法响应，请重试'); });
  if (!response.ok) throw new Error(value.error || '请求失败，请重试');
  return value;
}

function TemplateCoverVisual({ module }: { module: StudioModule }) {
  const [failed, setFailed] = useState(false);
  const resultUrl = module.cover?.thumbnailUrl || module.banner?.thumbnailUrl || module.images[0]?.thumbnailUrl || '';
  const referenceUrl = module.cover?.referenceUrl || '';
  if (module.cover?.referenceUrl && !failed) {
    return <span className={styles.coverVisual} data-cover-source="前后对比">
      <span className={styles.coverComparisonPane}><img decoding="async" src={referenceUrl} loading="lazy" alt="生成前参考图" onError={() => setFailed(true)} /><small>参考图</small></span>
      <span className={styles.coverComparisonPane}><img decoding="async" src={resultUrl} loading="lazy" alt="生成结果" onError={() => setFailed(true)} /><small>生成结果</small></span>
    </span>;
  }
  return <span className={styles.coverVisual} data-cover-source={resultUrl && !failed ? (module.cover?.resultUrl ? '代表生成图' : '模板素材') : '占位'}>
    {resultUrl && !failed ? <img decoding="async" src={module.cover?.thumbnailUrl || resultUrl} loading="lazy" alt={`${module.name}封面`} onError={() => setFailed(true)} /> : <span>暂无代表图</span>}
  </span>;
}

function singleReferenceComparison(task: StudioTask) {
  const references = task.snapshot?.primaryReferenceImages ?? task.snapshot?.transientReferenceImages ?? task.snapshot?.referenceImages ?? [];
  const reference = references[0];
  const src = reference?.originalUrl || reference?.thumbnailUrl;
  return src ? { src, thumbnailSrc: reference.thumbnailUrl || src, alt: '主图 1', fileName: reference.fileName || undefined } : undefined;
}

function studioTaskPreviewState(task: StudioTask): ImagePreviewState {
  const snapshot = task.snapshot;
  const model = studioModelShortLabel(task.model);
  const quality = IMAGE_STUDIO_QUALITY_LABELS[normalizeImageStudioQuality(task.model, task.quality) as keyof typeof IMAGE_STUDIO_QUALITY_LABELS] || task.quality || '自动';
  return {
    taskId: task.id,
    contentKey: task.asset?.id ? `asset:${task.asset.id}` : undefined,
    src: task.asset?.original_url || '',
    alt: `生成结果 ${task.ordinal}`,
    title: `生成结果 ${task.ordinal}`,
    width: task.asset?.width, height: task.asset?.height,
    metadata: { model, quality, ratio: snapshot?.resolvedAspectRatio || task.aspectRatio || 'auto', resolution: snapshot?.resolution || '自动', time: task.createdAt },
    comparison: singleReferenceComparison(task),
  };
}

function studioModelShortLabel(model: string) {
  return IMAGE_STUDIO_MODEL_SHORT_LABELS[model as keyof typeof IMAGE_STUDIO_MODEL_SHORT_LABELS] || model;
}

function copyStudioTaskText(task: StudioTask) {
  const snapshot = task.snapshot;
  if (!snapshot?.sourceAvailable) return '';
  const context = [snapshot.globalContext?.trim(), snapshot.moduleContext?.trim()].filter(Boolean).join('\n\n---\n模块上下文：\n');
  const model = IMAGE_STUDIO_MODEL_LABELS[snapshot.model as keyof typeof IMAGE_STUDIO_MODEL_LABELS] || snapshot.model;
  const quality = IMAGE_STUDIO_QUALITY_LABELS[normalizeImageStudioQuality(snapshot.model, snapshot.quality) as keyof typeof IMAGE_STUDIO_QUALITY_LABELS] || snapshot.quality || '自动';
  return [
    `最终上下文：\n${context}`,
    ...(snapshot.fixedReferenceImages?.length ? [`固定参考图说明：\n${snapshot.fixedReferenceImages.map((image, index) => `图 ${index + 1}：${JSON.stringify(image.note || '')}`).join('\n')}`] : []),
    `画面描述：${snapshot.prompt.trim() || '参考图生成'}`,
    `模型：${model}`,
    `质量：${quality}`,
    `比例：${snapshot.aspectRatio || 'auto'}${snapshot.resolvedAspectRatio && snapshot.resolvedAspectRatio !== snapshot.aspectRatio ? `（实际 ${snapshot.resolvedAspectRatio}）` : ''}`,
    `分辨率：${snapshot.resolution || snapshot.outputSize || '自动'}`,
  ].join('\n');
}

async function copyStudioText(value: string) {
  if (!value) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
    const textarea = document.createElement('textarea');
    textarea.value = value; textarea.setAttribute('readonly', ''); textarea.style.position = 'fixed'; textarea.style.opacity = '0';
    document.body.appendChild(textarea); textarea.select();
    const copied = document.execCommand('copy'); textarea.remove();
    if (!copied) throw new Error('copy_failed');
    return true;
  } catch { return false; }
}

export default function ImageStudio({ isAdmin, userId, templateWorkbench = false }: { isAdmin: boolean; userId: string; templateWorkbench?: boolean }) {
  const { confirm, productDialog } = useProductDialog();
  const [modules, setModules] = useState<StudioModule[]>([]);
  const [directory, setDirectory] = useState<Array<Pick<StudioModule, 'id' | 'name' | 'groupName'>>>([]);
  const removedModuleIds = useRef(new Set<string>());
  const hydratingIds = useRef(new Set<string>());
  const [hydrating, setHydrating] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [active, setActive] = useState('');
  const [selectedGroup, setSelectedGroup] = useState('');
  const [coverView, setCoverView] = useState(false);
  const [viewRestored, setViewRestored] = useState(false);
  useRememberedScroll(`image-studio:${userId}`, viewRestored);
  useEffect(() => {
    try {
      const view = JSON.parse(sessionStorage.getItem(`sd2-studio-view:${userId}`) || 'null');
      if (typeof view?.group === 'string') setSelectedGroup(view.group);
      if (typeof view?.active === 'string') setActive(view.active);
      if (templateWorkbench && typeof view?.coverView === 'boolean') setCoverView(view.coverView);
    } catch {}
    setViewRestored(true);
  }, [userId, templateWorkbench]);
  useEffect(() => {
    if (!viewRestored) return;
    try { sessionStorage.setItem(`sd2-studio-view:${userId}`, JSON.stringify({ group: selectedGroup, active, ...(templateWorkbench ? { coverView } : {}) })); } catch {}
  }, [viewRestored, userId, selectedGroup, active, coverView, templateWorkbench]);
  const [coverPage, setCoverPage] = useState(() => {
    if (typeof window === 'undefined') return 0;
    try {
      const stored = Number(window.localStorage.getItem('sd2-image-studio-cover-page'));
      return Number.isInteger(stored) && stored >= 0 ? stored : 0;
    } catch {
      return 0;
    }
  });
  const [coverColumns, setCoverColumns] = useState(4);
  const globalEditor = useStudioSettings(userId, isAdmin);
  const settings = globalEditor.settings;
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false);
  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const [presets, setPresets] = useState<StudioPreset[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(false);
  const [presetsError, setPresetsError] = useState('');
  const presetDialog = useRef<HTMLDialogElement>(null);
  const presetApplyLock = useRef(false);
  const [presetApplying, setPresetApplying] = useState(false);
  const [presetSharingId, setPresetSharingId] = useState<string | null>(null);
  useEffect(() => { if (presetDialogOpen) presetDialog.current?.showModal(); else presetDialog.current?.close(); }, [presetDialogOpen]);
  useDialogDismiss({ open: presetDialogOpen, dialogRef: presetDialog, nativeDialog: true, onDismiss: () => setPresetDialogOpen(false) });
  const [customRatios, setCustomRatios] = useState<string[]>([]);
  const [ratiosBusy, setRatiosBusy] = useState(false);
  const [ratiosError, setRatiosError] = useState('');
  const ratiosLock = useRef(false);
  async function syncRatios(ratio?: string, remove = false) {
    if (ratiosLock.current) return false;
    ratiosLock.current = true; setRatiosBusy(true); setRatiosError('');
    try {
      const result = await readResponse(await fetch('/api/image-studio/ratios', ratio ? { method: remove ? 'DELETE' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ratio }) } : { cache: 'no-store' }));
      setCustomRatios(result.ratios); return true;
    } catch (e) { setRatiosError(e instanceof Error ? e.message : '比例未保存'); return false; }
    finally { ratiosLock.current = false; setRatiosBusy(false); }
  }
  useEffect(() => { void syncRatios(); }, []);
  useEffect(() => {
    const syncCoverColumns = () => setCoverColumns(window.innerWidth <= 520 ? 1 : window.innerWidth <= 800 ? 2 : window.innerWidth <= 1000 ? 3 : 4);
    syncCoverColumns();
    window.addEventListener('resize', syncCoverColumns);
    return () => window.removeEventListener('resize', syncCoverColumns);
  }, []);
  useEffect(() => {
    try { const stored = Number(localStorage.getItem('sd2-image-studio-cover-page')); if (Number.isInteger(stored) && stored >= 0) setCoverPage(stored); } catch { /* Pagination is a convenience, not a dependency. */ }
  }, []);
  const createId = useRef<string | null>(null);
  const createLock = useRef(false);
  const listLock = useRef(false);
  const loadModules = useCallback(async (next?: string) => {
    if (listLock.current) return;
    listLock.current = true; setLoading(true); setError('');
    try {
      const data = await readResponse(await fetch(`/api/image-studio/modules${next ? `?cursor=${encodeURIComponent(next)}` : ''}`, { cache: 'no-store' }));
      if (Array.isArray(data.directory)) setDirectory(data.directory.filter((item: StudioModule) => !removedModuleIds.current.has(item.id)));
      setModules(current => {
        const ids = new Set(current.map(item => item.id));
        return [...current, ...data.modules.filter((item: StudioModule) => !ids.has(item.id) && !removedModuleIds.current.has(item.id))]
          .sort((a, b) => Number(b.id === `default-${userId}`) - Number(a.id === `default-${userId}`)
            || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id.localeCompare(b.id));
      });
      setCursor(data.nextCursor); setActive(current => current || data.modules[0]?.id || '');
    } catch (e) { setError(e instanceof Error ? e.message : '模块读取失败'); }
    finally { listLock.current = false; setLoading(false); }
  }, [userId]);
  useEffect(() => { void loadModules(); }, [loadModules]);
  const hydrateModules = useCallback(async (ids: string[]) => {
    const requested = ids.filter(id => !hydratingIds.current.has(id)).slice(0, 12);
    if (!requested.length) return;
    requested.forEach(id => hydratingIds.current.add(id));
    setHydrating(true);
    try {
      const data = await readResponse(await fetch(`/api/image-studio/modules?ids=${encodeURIComponent(requested.join(','))}`, { cache: 'no-store' }));
      setModules(current => {
        const existing = new Set(current.map(item => item.id));
        return [...current, ...data.modules.filter((item: StudioModule) => !existing.has(item.id) && !removedModuleIds.current.has(item.id))];
      });
      setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '模块读取失败，请重试'); }
    finally { requested.forEach(id => hydratingIds.current.delete(id)); setHydrating(hydratingIds.current.size > 0); }
  }, []);
  const routedContentHandled = useRef(false);
  useEffect(() => {
    if (routedContentHandled.current || loading) return;
    const params = new URLSearchParams(window.location.search);
    const moduleId = params.get('moduleId');
    const presetId = params.get('presetId');
    if (moduleId) {
      const target = directory.find(item => item.id === moduleId);
      if (target) {
        routedContentHandled.current = true;
        setCoverView(false); setSelectedGroup(target.groupName || '未分组'); setActive(moduleId);
        void hydrateModules([moduleId]);
      }
    } else if (presetId) {
      routedContentHandled.current = true;
      void openPresetLibrary();
    }
  }, [directory, loading, hydrateModules]);
  async function createModule() {
    if (createLock.current) return;
    createLock.current = true; setCreating(true); setError('');
    createId.current ||= crypto.randomUUID();
    try {
      const workspace: StudioModule = await readResponse(await fetch('/api/image-studio/modules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: createId.current, groupName: selectedGroup || '未分组' }) }));
      setModules(current => current.some(item => item.id === workspace.id) ? current : [...current, workspace]);
      setSelectedGroup(workspace.groupName || '未分组'); setActive(workspace.id); createId.current = null;
      requestAnimationFrame(() => document.getElementById(`module-${workspace.id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    } catch (e) { setError(e instanceof Error ? e.message : '新建失败'); }
    finally { createLock.current = false; setCreating(false); }
  }
  async function openPresetLibrary() {
    setPresetDialogOpen(true); setPresetsLoading(true); setPresetsError('');
    try { const result = await readResponse(await fetch('/api/image-studio/presets', { cache: 'no-store' }));
      const requested = new URLSearchParams(window.location.search).get('presetId');
      const sorted = [...result.presets].sort((a, b) => Number(b.id === requested) - Number(a.id === requested));
      setPresets(sorted);
      if (requested && !sorted.some(item => item.id === requested)) setPresetsError('收藏的模板已不可用或不再共享');
    }
    catch (e) { setPresetsError(e instanceof Error ? e.message : '模板读取失败'); }
    finally { setPresetsLoading(false); }
  }
  async function applyPreset(preset: StudioPreset) {
    if (presetApplyLock.current) return;
    presetApplyLock.current = true; setPresetApplying(true); setPresetsError('');
    try {
      const created: StudioModule = await readResponse(await fetch('/api/image-studio/presets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'apply', presetId: preset.id }) }));
      setModules(current => [created, ...current.filter(item => item.id !== created.id)]); setSelectedGroup(created.groupName || '未分组'); setActive(created.id); setPresetDialogOpen(false);
      requestAnimationFrame(() => document.getElementById(`module-${created.id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    } catch (e) { setPresetsError(e instanceof Error ? e.message : '应用模板失败'); }
    finally { presetApplyLock.current = false; setPresetApplying(false); }
  }
  async function togglePresetSharing(preset: StudioPreset) {
    if (!preset.canManageSharing || presetSharingId) return;
    const next = !preset.isShared;
    setPresetSharingId(preset.id); setPresetsError('');
    setPresets(current => current.map(item => item.id === preset.id ? { ...item, isShared: next } : item));
    try {
      const result = await readResponse(await fetch('/api/image-studio/presets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-sharing', presetId: preset.id, isShared: next }),
      }));
      setPresets(current => current.map(item => item.id === preset.id ? { ...item, isShared: result.isShared === true } : item));
    } catch (e) {
      setPresets(current => current.map(item => item.id === preset.id ? { ...item, isShared: preset.isShared } : item));
      setPresetsError(e instanceof Error ? e.message : '共享状态保存失败，请重试');
    } finally { setPresetSharingId(null); }
  }
  async function toggleModuleSharing(module: StudioModule) {
    if (!module.sourcePresetCanManageSharing || !module.sourcePresetId || presetSharingId) return;
    const next = module.sourcePresetShared !== true;
    const previous = module.sourcePresetShared === true;
    setPresetSharingId(module.sourcePresetId);
    setError('');
    setModules(current => current.map(item => item.id === module.id ? { ...item, sourcePresetShared: next } : item));
    setPresets(current => current.map(item => item.id === module.sourcePresetId ? { ...item, isShared: next } : item));
    try {
      const result = await readResponse(await fetch('/api/image-studio/presets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-sharing', presetId: module.sourcePresetId, isShared: next }),
      }));
      const effective = result.isShared === true;
      setModules(current => current.map(item => item.id === module.id ? { ...item, sourcePresetShared: effective } : item));
      setPresets(current => current.map(item => item.id === module.sourcePresetId ? { ...item, isShared: effective } : item));
    } catch (e) {
      setModules(current => current.map(item => item.id === module.id ? { ...item, sourcePresetShared: previous } : item));
      setPresets(current => current.map(item => item.id === module.sourcePresetId ? { ...item, isShared: previous } : item));
      setError(e instanceof Error ? e.message : '共享状态保存失败，请重试');
    } finally { setPresetSharingId(null); }
  }
  const navigation = useMemo(() => {
    const items = new Map(directory.map(item => [item.id, item]));
    modules.forEach(item => items.set(item.id, { id: item.id, name: item.name, groupName: item.groupName }));
    return Array.from(items.values());
  }, [directory, modules]);
  const groupedModules = useMemo(() => navigation.reduce<Record<string, typeof navigation>>((groups, item) => {
    const group = item.groupName || '未分组';
    (groups[group] ||= []).push(item);
    return groups;
  }, {}), [navigation]);
  const updateModuleMetadata = useCallback((id: string, name: string, groupName: string, followGroup = false) => {
    setModules(current => current.map(item => item.id === id && (item.name !== name || item.groupName !== groupName)
      ? { ...item, name, groupName } : item));
    if (followGroup) setSelectedGroup(groupName);
  }, []);
  const groups = useMemo(() => Array.from(new Set([...DEFAULT_GROUPS, ...navigation.map(item => item.groupName).filter(Boolean)])), [navigation]);
  const visibleModules = useMemo(() => selectedGroup ? modules.filter(item => item.groupName === selectedGroup) : modules, [modules, selectedGroup]);
  const missingGroupModules = useMemo(() => (groupedModules[selectedGroup] || []).filter(item => !modules.some(module => module.id === item.id)), [groupedModules, selectedGroup, modules]);
  useEffect(() => {
    const firstPage = (groupedModules[selectedGroup] || []).slice(0, 12);
    void hydrateModules(firstPage.filter(item => !modules.some(module => module.id === item.id)).map(item => item.id));
  }, [selectedGroup, groupedModules, modules, hydrateModules]);
  useEffect(() => {
    if (active && navigation.some(item => item.id === active) && !modules.some(item => item.id === active)) void hydrateModules([active]);
  }, [active, navigation, modules, hydrateModules]);
  const coverPageSize = coverColumns * 3;
  const coverPageCount = Math.max(1, Math.ceil(modules.length / coverPageSize));
  const visibleCoverModules = useMemo(() => modules.slice(coverPage * coverPageSize, (coverPage + 1) * coverPageSize), [coverPage, coverPageSize, modules]);
  useEffect(() => {
    if (!modules.length) return;
    setCoverPage(current => Math.min(current, coverPageCount - 1));
  }, [coverPageCount, modules.length]);
  useEffect(() => { try { localStorage.setItem('sd2-image-studio-cover-page', String(coverPage)); } catch { /* Pagination is a convenience, not a dependency. */ } }, [coverPage]);
  useEffect(() => {
    if (!navigation.length) return;
    const availableGroups = Object.keys(groupedModules);
    setSelectedGroup(current => current && availableGroups.includes(current) ? current : availableGroups[0] || groups[0]);
  }, [groups, groupedModules, navigation.length]);
  async function deleteGroup(group: string) {
    if (DEFAULT_GROUPS.includes(group)) return;
    // Read unloaded members too; deleting a group must not omit later pages.
    const targets = [...modules.filter(item => item.groupName === group)];
    const unloaded = (groupedModules[group] || []).filter(item => !targets.some(target => target.id === item.id));
    try {
      for (let offset = 0; offset < unloaded.length; offset += 12) {
        const ids = unloaded.slice(offset, offset + 12).map(item => item.id);
        const data = await readResponse(await fetch(`/api/image-studio/modules?ids=${encodeURIComponent(ids.join(','))}`, { cache: 'no-store' }));
        targets.push(...data.modules);
      }
    } catch { setError('分组内容未能完整读取，请重试'); return; }
    if (!targets.length || !(await confirm(`删除分组“${group}”？其中的模块会移到“未分组”，图片和生成结果不会删除。`, { title: '删除分组', confirmLabel: '删除分组', danger: true }))) return;
    try {
      const replacements: StudioModule[] = [];
      for (const item of targets) {
        replacements.push(await readResponse(await fetch('/api/image-studio/modules', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          id: item.id, revision: item.revision, name: item.name, prompt: item.prompt, context: item.context || '', count: item.count, referenceLimit: item.referenceLimit,
          aspectRatio: item.aspectRatio, model: item.model, quality: item.quality, resolution: item.resolution, groupName: '未分组', bannerAssetId: item.banner?.id || null,
          referenceIds: item.images.map(image => image.id), reproduceFromTaskId: item.reproduceFromTaskId || null,
        }) })));
      }
      const replacementById = new Map(replacements.map(item => [item.id, item]));
      setModules(current => current.map(item => replacementById.get(item.id) || item));
      setDirectory(current => current.map(item => replacementById.has(item.id) ? { ...item, groupName: '未分组' } : item));
      setSelectedGroup('未分组');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除分组失败，请重试');
      void loadModules();
    }
  }
  const navigateToModule = (group: string, id: string) => {
    setCoverView(false); setSelectedGroup(group); setActive(id);
    void (async () => {
      if (!modules.some(module => module.id === id)) await hydrateModules([id]);
      requestAnimationFrame(() => document.getElementById(`module-${id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    })();
  };
  return <>{productDialog}{(<main className={`${styles.page} ${templateWorkbench ? styles.templateWorkbench : ''}`}>
    <aside className={styles.moduleRail} data-remember-scroll="image-groups" aria-label="分组快捷栏">
      <div className={styles.moduleRailTitle}>分组快捷栏</div>
      {Object.entries(groupedModules).map(([group, items]) => <div key={group} className={styles.moduleRailGroup}>
        <button type="button" className={selectedGroup === group ? styles.moduleRailActive : ''} aria-current={selectedGroup === group ? 'page' : undefined} onClick={() => {
          setCoverView(false); setSelectedGroup(group); setActive(items[0]?.id || '');
        }}><span>{group}</span><small>{items.length}</small></button>
        <div className={styles.moduleRailChildren}>{items.map(item => <button key={item.id} type="button" className={`${styles.moduleRailChild} ${!coverView && active === item.id ? styles.moduleRailActive : ''}`} aria-current={!coverView && active === item.id ? 'page' : undefined}
          onClick={() => navigateToModule(group, item.id)}>{item.name}</button>)}</div>
      </div>)}
      <button type="button" className={coverView ? styles.moduleRailActive : ''} aria-current={coverView ? 'page' : undefined} onClick={() => setCoverView(true)}>全部封面<small>{navigation.length}</small></button>
    </aside>
    {templateWorkbench && <nav className={styles.mobileModuleNav} aria-label="图片模块导航">
      <label className={styles.mobileGroupPicker}><span>分组</span><select aria-label="选择图片分组" value={selectedGroup} onChange={event => {
        const group = event.target.value;
        const first = groupedModules[group]?.[0];
        if (first) navigateToModule(group, first.id);
      }}>
        {!Object.keys(groupedModules).length && <option value="">暂无分组</option>}
        {Object.entries(groupedModules).map(([group, items]) => <option key={group} value={group}>{group} ({items.length})</option>)}
      </select></label>
      <button type="button" className={coverView ? styles.moduleRailActive : ''} aria-pressed={coverView} onClick={() => setCoverView(true)}>全部封面 <small>{navigation.length}</small></button>
      <label className={styles.mobileModulePicker}><span>模块</span><select aria-label="选择图片模块" value={!coverView && groupedModules[selectedGroup]?.some(item => item.id === active) ? active : ''} onChange={event => {
        if (event.target.value) navigateToModule(selectedGroup, event.target.value);
      }}>
        <option value="">{coverView ? '选择模块返回编辑' : '选择模块'}</option>
        {(groupedModules[selectedGroup] || []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
    </nav>}
    <div className={styles.content}>
    <header className={styles.header}><div><h1>{coverView ? (templateWorkbench ? '模块封面' : '模板封面') : templateWorkbench ? '图片模块' : '图片生成'}</h1><p className={styles.muted}>{coverView ? (templateWorkbench ? '所有模块的 3:4 封面预览' : '所有模板的 3:4 封面预览') : `当前分组：${selectedGroup || '未分组'}`}</p></div><div className={styles.counts}>
      <button type="button" onClick={() => void openPresetLibrary()}>模板库</button>
      {isAdmin && <button type="button" onClick={() => setGlobalSettingsOpen(true)}><Settings size={17} />通用上下文</button>}
      <button type="button" disabled={creating || !modules.length} onClick={() => void createModule()}><Plus size={17} />{creating ? '新建中' : '新建模块'}</button></div></header>
    {error && <p role="alert" className={styles.error}>{error}<button onClick={() => void loadModules(cursor || undefined)}>重试读取</button></p>}
    {coverView && <section className={styles.coverGrid} aria-label={templateWorkbench ? '模块封面' : '模板封面'}><div className={styles.coverGridInner}>{visibleCoverModules.map(module => {
      return <button key={module.id} type="button" className={styles.coverCard} onClick={() => { setCoverView(false); setSelectedGroup(module.groupName || '未分组'); setActive(module.id); requestAnimationFrame(() => document.getElementById(`module-${module.id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })); }}>
        <TemplateCoverVisual module={module} />
        <span className={styles.coverDescription}><strong title={module.name}>{module.name}</strong><small>{module.prompt.trim() ? module.prompt.trim().slice(0, 96) : `以${module.name}为主题，按当前参考图和模型设置生成图片。`}</small></span>
      </button>;
    })}</div><div className={styles.pagination} aria-label={templateWorkbench ? '模块封面分页' : '模板封面分页'}><button type="button" disabled={coverPage <= 0} onClick={() => setCoverPage(current => Math.max(0, current - 1))}>上一页</button><span>第 {coverPage + 1} / {coverPageCount} 页</span><button type="button" disabled={coverPage >= coverPageCount - 1} onClick={() => setCoverPage(current => Math.min(coverPageCount - 1, current + 1))}>下一页</button></div>{cursor && <button type="button" disabled={loading} onClick={() => void loadModules(cursor)}>{templateWorkbench ? '加载更多模块' : '加载更多模板'}</button>}</section>}
    <div hidden={coverView}>
    {modules.map(module => <ImageStudioBlock key={module.id} templateWorkbench={templateWorkbench} module={module} hidden={coverView || Boolean(selectedGroup && module.groupName !== selectedGroup)} onMetadataChange={updateModuleMetadata} groups={groups} onDeleteGroup={deleteGroup} isAdmin={isAdmin} onToggleSharing={toggleModuleSharing} sharingId={presetSharingId}
      onModuleDelete={id => { removedModuleIds.current.add(id); setModules(current => current.filter(item => item.id !== id)); setDirectory(current => current.filter(item => item.id !== id)); setActive(current => current === id ? '' : current); }}
      userId={userId} settings={settings} globalContextDraft={isAdmin ? globalEditor.draft?.context : undefined} globalSettingsDirty={globalEditor.dirty || globalEditor.saving} settingsError={globalEditor.error} active={!coverView && active === module.id && module.groupName === selectedGroup} onActivate={() => setActive(module.id)}
      onModuleChange={next => { setModules(current => current.map(item => item.id === next.id ? { ...next, name: item.name, groupName: item.groupName } : item)); }}
      ratios={{ custom: customRatios, busy: ratiosBusy, error: ratiosError, onRetry: () => void syncRatios(), onCustom: syncRatios }}
      onReloadSettings={discard => { void globalEditor.controller.load(discard); }} />)}
    {(loading || hydrating) && <p role="status">正在读取模块…</p>}
    {missingGroupModules.length > 0 && <button disabled={hydrating} onClick={() => void hydrateModules(missingGroupModules.slice(0, 12).map(item => item.id))}>加载更多模块（{missingGroupModules.length}）</button>}
    {visibleModules.length > 0 && <button type="button" className={styles.newModule} disabled={creating} onClick={() => void createModule()}><Plus size={17} />新建模块</button>}
    </div>
    </div>
    <dialog ref={presetDialog} className={styles.dialog}>
      <header className={styles.header}><h2>模板库</h2><button type="button" aria-label="关闭模板库" onClick={() => setPresetDialogOpen(false)}><X size={20} /></button></header>
      {presetsError && <p role="alert" className={styles.error}>{presetsError}</p>}
      {presetsLoading ? <p role="status">正在读取模板…</p> : !presets.length ? <p className={styles.muted}>暂无模板</p> : <div className={styles.presetList}>{presets.map(preset => <article key={preset.id} className={styles.presetItem}><div><strong>{preset.name}</strong><span>{preset.groupName} · {IMAGE_STUDIO_MODEL_LABELS[preset.model as keyof typeof IMAGE_STUDIO_MODEL_LABELS] || preset.model} · 应用后生成自己的配置</span></div><div className={styles.presetActions}><ContentReactions contentKey={`image_template:${preset.id}`} />{preset.canManageSharing && <button type="button" role="switch" aria-checked={preset.isShared} className={styles.presetSharing} disabled={presetSharingId === preset.id} onClick={() => void togglePresetSharing(preset)}>{preset.isShared ? '共享给同事' : '仅自己可见'}</button>}<button type="button" disabled={presetApplying} onClick={() => void applyPreset(preset)}>新建并应用</button></div></article>)}</div>}
    </dialog>
    {isAdmin && <StudioGlobalSettingsDialog open={globalSettingsOpen} onClose={() => setGlobalSettingsOpen(false)} editor={globalEditor} />}
    {!settings && globalEditor.error && <p role="alert" className={styles.error}>{globalEditor.error}<button onClick={() => void globalEditor.controller.load()}>重试读取设置</button></p>}
  </main>)}</>;
}

function ImageStudioBlock({ isAdmin, userId, module, hidden, onMetadataChange, onModuleDelete, groups, onDeleteGroup, onToggleSharing, sharingId, settings, globalContextDraft, globalSettingsDirty, settingsError, active, onActivate, onModuleChange, onReloadSettings, ratios, templateWorkbench }: {
  templateWorkbench: boolean;
  onModuleDelete: (id: string) => void;
  hidden: boolean; onMetadataChange: (id: string, name: string, groupName: string, followGroup?: boolean) => void;
  isAdmin: boolean; userId: string; module: StudioModule & { fixedReferences?: FixedStudioReference[]; contextEditable?: boolean }; groups: string[]; onDeleteGroup: (group: string) => Promise<void>; onToggleSharing: (module: StudioModule) => Promise<void>; sharingId: string | null; settings: SettingsValue | null;
  globalContextDraft?: string; globalSettingsDirty: boolean; settingsError: string; active: boolean; onActivate: () => void; onModuleChange: (module: StudioModule) => void;
  onReloadSettings: (discardDraft?: boolean) => void;
  ratios: RatioPreferences;
}) {
  const { confirm, prompt: askName, productDialog } = useProductDialog();
  const contextEditable = module.contextEditable !== false;
  const fixedEditable = isAdmin && module.fixedReferencesEditable !== false;
  const [styleGroups, setStyleGroups] = useState<StudioStyleSummary[]>(module.styleGroups || []);
  const [reproductionFixedCount, setReproductionFixedCount] = useState(module.reproductionState?.fixedReferenceCount || 0);
  const [reproductionStyles, setReproductionStyles] = useState<StudioStyleSummary[]>(module.reproductionState?.styleGroups || []);
  const [saveStatus, setSaveStatus] = useState('');
  const [recoverableDraft, setRecoverableDraft] = useState<Record<string, any> | null>(null);
  const [savedAsSignature, setSavedAsSignature] = useState('');
  const [prompt, setPrompt] = useState(module.prompt);
  const [count, setCount] = useState(module.count);
  const [referenceLimit, setReferenceLimit] = useState(module.referencePolicy?.primaryMax ?? Math.max(1, Math.min(MAX_REFERENCE_IMAGES, module.referenceLimit || MAX_REFERENCE_IMAGES)));
  const [primaryMin, setPrimaryMin] = useState(module.referencePolicy?.primaryMin ?? 0);
  const [auxiliaryLimit, setAuxiliaryLimit] = useState(module.referencePolicy?.auxiliaryMax ?? MAX_REFERENCE_IMAGES);
  const [styleLimit, setStyleLimit] = useState(module.referencePolicy?.styleMax ?? MAX_REFERENCE_IMAGES);
  const [referenceImageLimit, setReferenceImageLimit] = useState(module.referencePolicy?.referenceMax ?? MAX_REFERENCE_IMAGES);
  const [useFixedReferences, setUseFixedReferences] = useState(module.referencePolicy?.useFixedReferences ?? true);
  const [aspectRatio, setAspectRatio] = useState(module.aspectRatio || 'auto');
  const [moduleModel, setModuleModel] = useState(module.model);
  const [resolution, setResolution] = useState<ImageResolution>(normalizeImageResolution(module.model, module.resolution || defaultImageResolution(module.model)));
  const [quality, setQuality] = useState(module.quality || defaultImageStudioQuality(module.model));
  const [groupName, setGroupName] = useState(module.groupName || '未分组');
  const [banner, setBanner] = useState<UploadedAssetPayload | null>(module.banner || null);
  const [ratioEditing, setRatioEditing] = useState(false);
  const [images, setImages] = useState<UploadedAssetPayload[]>(module.images.filter(image => !module.referencePolicy || module.referencePolicy.primaryIds.includes(image.id || '')));
  const [auxiliaryImages, setAuxiliaryImages] = useState<UploadedAssetPayload[]>(module.referencePolicy ? module.images.filter(image => !module.referencePolicy!.primaryIds.includes(image.id || '')) : []);
  const [name, setName] = useState(module.name);
  const [nameEditing, setNameEditing] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const [moduleRevision, setModuleRevision] = useState(module.revision);
  const revisionRef = useRef(module.revision);
  const [moduleSaving, setModuleSaving] = useState(false);
  const [moduleDeleting, setModuleDeleting] = useState(false);
  const moduleDeleteLock = useRef(false);
  const [fixedReferences, setFixedReferences] = useState<FixedStudioReference[]>(module.fixedReferences || []);
  const [savedFixedReferences, setSavedFixedReferences] = useState<FixedStudioReference[]>(module.fixedReferences || []);
  const [reproductionReferences, setReproductionReferences] = useState<FixedStudioReference[]>([]);
  const fixedDirty = JSON.stringify(fixedReferencePayload(fixedReferences)) !== JSON.stringify(fixedReferencePayload(savedFixedReferences));
  const [moduleContext, setModuleContext] = useState(module.context || '');
  const [savedModuleContext, setSavedModuleContext] = useState(module.context || '');
  const [moduleContextConfigured, setModuleContextConfigured] = useState(module.contextConfigured);
  const [moduleSaveError, setModuleSaveError] = useState('');
  const [moduleSaved, setModuleSaved] = useState(JSON.stringify({ name: module.name, prompt: module.prompt, context: module.context || '', count: module.count, referenceLimit: moduleReferencePolicy(module).primaryMax, aspectRatio: module.aspectRatio || 'auto', model: module.model, quality: normalizeImageStudioQuality(module.model, module.quality), resolution: normalizeImageResolution(module.model, module.resolution || defaultImageResolution(module.model)), groupName: module.groupName || '未分组', bannerAssetId: module.banner?.id || null, referenceIds: [...module.images.filter(image => moduleReferencePolicy(module).primaryIds.includes(image.id || '')), ...module.images.filter(image => !moduleReferencePolicy(module).primaryIds.includes(image.id || ''))].map(image => image.id), reproduceFromTaskId: module.reproduceFromTaskId || null, sourcePresetId: module.sourcePresetId || null, styleGroupIds: module.styleGroupIds || [], referencePolicy: moduleReferencePolicy(module) }));
  const moduleSaveLock = useRef(false);
  const restoredDraftKey = useRef('');
  const autoSaveAttempt = useRef('');
  const section = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [imageSourceTarget, setImageSourceTarget] = useState<'reference' | 'auxiliary' | 'banner' | 'fixed'>('reference');
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const imageSourceDialog = useRef<HTMLDialogElement>(null);
  function openImageSource(target: 'reference' | 'auxiliary' | 'banner' | 'fixed') {
    setImageSourceTarget(target);
    imageSourceDialog.current?.showModal();
  }
  const [uploadProgress, setUploadProgress] = useState<ReturnType<typeof studioUploadProgress> | null>(null);
  const [bannerProgress, setBannerProgress] = useState<ReturnType<typeof studioUploadProgress> | null>(null);
  const [bannerUploading, setBannerUploading] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<ImagePreviewState | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<{ id: string; text: string } | null>(null);
  const [tasks, setTasks] = useState<StudioTask[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [tasksError, setTasksError] = useState('');
  const [taskReadAction, setTaskReadAction] = useState<'idle' | 'initial' | 'refresh' | 'more'>('initial');
  const [taskRetryCursor, setTaskRetryCursor] = useState<string | undefined>();
  const taskReadScope = `${userId}:${module.id}`;
  const taskReadScopeRef = useRef(taskReadScope);
  taskReadScopeRef.current = taskReadScope;
  const taskReadRequest = useRef<{ scope: string; controller: AbortController; action: 'initial' | 'refresh' | 'silent' } | null>(null);
  const taskReadLoaded = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [queryingSubmission, setQueryingSubmission] = useState(false);
  const [pendingSubmission, setPendingSubmission] = useState<Record<string, unknown> | null>(null);
  const [reproduceSourceTaskId, setReproduceSourceTaskId] = useState<string | null>(module.reproduceFromTaskId || null);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [persistedDraftSignature, setPersistedDraftSignature] = useState<string | null>(null);
  const [draftRestoring, setDraftRestoring] = useState(false);
  const draftRestoreSequence = useRef(0);
  const blockedDraftSignature = useRef<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [downloadMode, setDownloadMode] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<StudioTask | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const deletedIds = useRef(new Set<string>());
  const deleteLock = useRef(false);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const [downloadReady, setDownloadReady] = useState<{ url: string; name: string } | null>(null);
  const submitLock = useRef(false);
  const listLock = useRef(false);
  const loadedMore = useRef(false);
  const uploadLock = useRef(false);
  const moduleDialog = useRef<HTMLDialogElement>(null);
  const resumeModulePreview = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const auxiliaryFileInput = useRef<HTMLInputElement>(null);
  const fixedFileInput = useRef<HTMLInputElement>(null);
  const bannerFileInput = useRef<HTMLInputElement>(null);
  const dirty = globalSettingsDirty;
  const unsavedContext = dirty || moduleContext !== savedModuleContext || fixedDirty;
  const suffix = module.id === `default-${userId}` ? userId : `${userId}:${module.id}`;
  const draftKey = `sd2-image-studio-draft:${suffix}`;
  const pendingKey = `sd2-image-studio-pending:${suffix}`;
  const referencePolicy: StudioReferencePolicy = { primaryIds: images.flatMap(image => image.id ? [image.id] : []), primaryMin, primaryMax: referenceLimit, auxiliaryMax: auxiliaryLimit, styleMax: styleLimit, referenceMax: referenceImageLimit, useFixedReferences };
  const moduleDraft = { name, prompt, context: moduleContext, count, referenceLimit, aspectRatio, model: moduleModel, quality: normalizeImageStudioQuality(moduleModel, quality), resolution: normalizeImageResolution(moduleModel, resolution), groupName, bannerAssetId: banner?.id || null, referenceIds: [...images, ...auxiliaryImages].map(image => image.id), reproduceFromTaskId: reproduceSourceTaskId || null, sourcePresetId: module.sourcePresetId || null, styleGroupIds: styleGroups.map(group => group.id), referencePolicy };
  const moduleSaveSnapshot = { ...moduleDraft };
  const moduleDirty = JSON.stringify(moduleSaveSnapshot) !== moduleSaved;
  const baseline = moduleSaved ? JSON.parse(moduleSaved) as typeof moduleDraft : moduleDraft;
  const generationDraft = JSON.stringify({ prompt, count, referenceLimit, aspectRatio, resolution: normalizeImageResolution(moduleModel, resolution), referenceIds: moduleDraft.referenceIds, model: moduleModel, quality: normalizeImageStudioQuality(moduleModel, quality), referencePolicy, context: moduleContext, fixedReferences: fixedReferencePayload(fixedReferences), styleGroupIds: moduleDraft.styleGroupIds });
  const defaultGenerationDraft = JSON.stringify({ prompt: baseline.prompt, count: baseline.count, referenceLimit: baseline.referenceLimit, aspectRatio: baseline.aspectRatio, resolution: normalizeImageResolution(baseline.model, baseline.resolution), referenceIds: baseline.referenceIds, model: baseline.model, quality: normalizeImageStudioQuality(baseline.model, baseline.quality), referencePolicy: baseline.referencePolicy, context: savedModuleContext, fixedReferences: fixedReferencePayload(savedFixedReferences), styleGroupIds: baseline.styleGroupIds });
  const generationChanged = generationDraft !== defaultGenerationDraft || Boolean(reproduceSourceTaskId);
  const automaticSnapshot = JSON.stringify({ ...baseline, name, groupName, bannerAssetId: banner?.id || null });
  const automaticDirty = automaticSnapshot !== moduleSaved;
  const unpersistedDraft = draftLoaded && generationChanged && persistedDraftSignature !== generationDraft;
  useUnsavedNavigation(unsavedContext || automaticDirty || moduleSaving || uploading || bannerUploading || unpersistedDraft, confirm);
  const settingsDirty = moduleContext !== savedModuleContext || fixedDirty || generationDraft !== defaultGenerationDraft;
  const contextDialogSnapshot = JSON.stringify({ context: moduleContext, primaryMin, primaryMax: referenceLimit,
    auxiliaryMax: auxiliaryLimit, styleMax: styleLimit, referenceMax: referenceImageLimit, useFixedReferences,
    fixedReferences: fixedReferencePayload(fixedReferences), styleGroupIds: styleGroups.map(group => group.id),
    model: moduleModel, resolution: normalizeImageResolution(moduleModel, resolution), quality: normalizeImageStudioQuality(moduleModel, quality) });
  const contextDialogOpening = useRef('');
  function openModuleDialog() {
    if (!draftLoaded || draftRestoring) return;
    contextDialogOpening.current = contextDialogSnapshot;
    moduleDialog.current?.showModal();
  }
  async function closeModuleDialog() {
    if (moduleSaving || uploading || bannerUploading) return;
    if (settingsDirty && contextDialogSnapshot !== contextDialogOpening.current && !(await confirm('模块设置尚未保存，确定关闭吗？当前草稿会保留。', { title: '关闭编辑', confirmLabel: '关闭编辑' }))) return;
    moduleDialog.current?.close();
  }
  useDialogDismiss({ open: true, dialogRef: moduleDialog, nativeDialog: true, onDismiss: closeModuleDialog });
  useDialogDismiss({ open: true, dialogRef: imageSourceDialog, nativeDialog: true, onDismiss: () => imageSourceDialog.current?.close() });
  useDialogDismiss({ open: Boolean(deleteTarget), dialogRef: deleteDialog, nativeDialog: true, onDismiss: () => { if (!deleting) setDeleteTarget(null); } });
  const activeStyles = reproduceSourceTaskId ? reproductionStyles : styleGroups;
  const activeTemplateCount = useFixedReferences ? (reproduceSourceTaskId
    ? Math.max(0, reproductionFixedCount - reproductionStyles.reduce((total, group) => total + group.referenceCount, 0))
    : fixedEditable ? fixedReferences.length : module.fixedReferenceCount ?? savedFixedReferences.length) : 0;
  const activeFixedReferences = reproduceSourceTaskId
    ? reproductionReferences.filter((_, index) => useFixedReferences || index >= Math.max(0, reproductionFixedCount - reproductionStyles.reduce((total, group) => total + group.referenceCount, 0)))
    : useFixedReferences ? fixedReferences : [];
  const activeFixedCount = activeTemplateCount + activeStyles.reduce((total, group) => total + group.referenceCount, 0);
  const auxiliaryCount = activeFixedCount + auxiliaryImages.length;
  const styleImageCount = activeStyles.reduce((total, group) => total + group.referenceCount, 0);
  const ordinaryReferenceCount = activeTemplateCount + auxiliaryImages.length;
  const effectiveReferences = [...images, ...auxiliaryImages, ...activeFixedReferences];
  const effectiveReferenceCount = auxiliaryCount + images.length;
  const currentReferenceCap = Math.min(referenceLimit, Math.max(0, MAX_REFERENCE_IMAGES - auxiliaryCount));
  const currentAuxiliaryCap = Math.max(0, Math.min(referenceImageLimit - activeTemplateCount, auxiliaryLimit - activeFixedCount, MAX_REFERENCE_IMAGES - images.length - activeFixedCount));
  const currentStyleCap = Math.max(0, Math.min(styleLimit, auxiliaryLimit - ordinaryReferenceCount, MAX_REFERENCE_IMAGES - images.length - ordinaryReferenceCount));
  const sourceSharingBlocked = Boolean(module.sourcePresetId && module.sourcePresetShared === false);

  useEffect(() => {
    // Group removal updates modules in the parent without remounting editors.
    if (module.revision <= revisionRef.current) return;
    revisionRef.current = module.revision;
    setModuleRevision(module.revision);
    setGroupName(module.groupName || '未分组');
    setModuleSaved(current => current ? JSON.stringify({ ...JSON.parse(current), groupName: module.groupName || '未分组' }) : current);
  }, [module.revision, module.groupName]);

  useEffect(() => { if (deleteTarget) deleteDialog.current?.showModal(); else deleteDialog.current?.close(); }, [deleteTarget]);
  useEffect(() => { if (nameEditing) nameInput.current?.focus(); }, [nameEditing]);

  useEffect(() => {
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { rootMargin: '200px' });
    if (section.current) observer.observe(section.current);
    return () => observer.disconnect();
  }, []);

  async function saveModule(reproduceTaskId = reproduceSourceTaskId, revisionOverride = revisionRef.current, manualSettings = true, fixedOverride?: FixedStudioReference[]) {
    if (moduleSaveLock.current || moduleDeleteLock.current || uploading || bannerUploading) return false;
    moduleSaveLock.current = true; setModuleSaving(true); setError(''); setModuleSaveError('');
    const snapshot = { ...(manualSettings ? moduleDraft : JSON.parse(automaticSnapshot) as typeof moduleDraft), context: manualSettings ? moduleContext : savedModuleContext, reproduceFromTaskId: manualSettings ? reproduceTaskId || null : baseline.reproduceFromTaskId };
    const contextSnapshot = snapshot.context;
    const fixedSnapshot = fixedOverride || (manualSettings ? fixedReferences : savedFixedReferences);
    try {
      const result = await readResponse(await fetch('/api/image-studio/modules', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: module.id, revision: revisionOverride, ...snapshot, context: contextEditable ? contextSnapshot : undefined, fixedReferences: fixedEditable && (manualSettings || fixedOverride) ? fixedReferencePayload(fixedSnapshot) : undefined }) }));
      revisionRef.current = result.revision;
      setModuleRevision(result.revision); setModuleSaved(JSON.stringify({ ...snapshot, context: contextSnapshot }));
      setSavedModuleContext(contextSnapshot); setModuleContextConfigured(result.contextConfigured);
      setSavedFixedReferences(result.fixedReferences || fixedSnapshot);
      if (manualSettings) contextDialogOpening.current = contextDialogSnapshot;
      if (fixedOverride) setFixedReferences(result.fixedReferences || fixedOverride);
      else if (manualSettings) setFixedReferences(current => JSON.stringify(fixedReferencePayload(current)) === JSON.stringify(fixedReferencePayload(fixedSnapshot)) ? result.fixedReferences || fixedSnapshot : current);
      onModuleChange(result);
      return result.revision as number;
    } catch (e) { const message = e instanceof Error ? e.message : '保存失败'; setError(message); setModuleSaveError(message); return false; }
    finally { moduleSaveLock.current = false; setModuleSaving(false); }
  }

  async function restoreDefaults() {
    if (!(await confirm(templateWorkbench ? '恢复当前模块默认参数和参考图？上次临时草稿仍可恢复。' : '恢复当前模板默认参数和参考图？上次临时草稿仍可恢复。', { title: '恢复默认', confirmLabel: '恢复默认' }))) return;
    try { const saved = JSON.parse(localStorage.getItem(draftKey) || 'null'); if (saved) setRecoverableDraft(saved); } catch {}
    blockedDraftSignature.current = null;
    setPrompt(baseline.prompt); setCount(baseline.count); setReferenceLimit(baseline.referenceLimit); setAspectRatio(baseline.aspectRatio); setModuleModel(baseline.model);
    setQuality(baseline.quality); setResolution(baseline.resolution);
    setImages(module.images.filter(image => baseline.referencePolicy.primaryIds.includes(image.id || '')));
    setAuxiliaryImages(module.images.filter(image => !baseline.referencePolicy.primaryIds.includes(image.id || '')));
    setPrimaryMin(baseline.referencePolicy.primaryMin); setAuxiliaryLimit(baseline.referencePolicy.auxiliaryMax); setUseFixedReferences(baseline.referencePolicy.useFixedReferences);
    setStyleLimit(baseline.referencePolicy.styleMax ?? MAX_REFERENCE_IMAGES); setReferenceImageLimit(baseline.referencePolicy.referenceMax ?? MAX_REFERENCE_IMAGES);
    setFixedReferences(savedFixedReferences); setModuleContext(savedModuleContext); setStyleGroups(module.styleGroups || []); setReproduceSourceTaskId(null);
    setModuleSaveError('');
  }

  async function deleteModule() {
    if (moduleDeleteLock.current || moduleSaveLock.current || submitting || uploading || bannerUploading) return;
    const objectName = templateWorkbench ? '模块' : '模板';
    if (!(await confirm(`删除${objectName}“${name}”？${objectName}配置将移除，已生成图片仍保留在资产库，不退积分；模板库中的共享原件不受影响。`, { title: `删除${objectName}`, confirmLabel: `删除${objectName}`, danger: true }))) return;
    moduleDeleteLock.current = true; setModuleDeleting(true); setError('');
    try {
      await readResponse(await fetch('/api/image-studio/modules', { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: module.id, revision: revisionRef.current }) }));
      try { localStorage.removeItem(draftKey); localStorage.removeItem(pendingKey); sessionStorage.removeItem(pendingKey); } catch { /* Optional browser cache. */ }
      onModuleDelete(module.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '删除失败，请重试'); }
    finally { moduleDeleteLock.current = false; setModuleDeleting(false); }
  }

  async function saveAsPreset() {
    if (!contextEditable) { setError('共享模板的内部上下文由创建者维护，不能另存内部配置；本次参数仍可直接生成。'); return; }
    const presetName = await askName('模板名称', name, { title: '另存为模板', confirmLabel: '保存模板', maxLength: 80 });
    if (!presetName?.trim()) return;
    try {
      await readResponse(await fetch('/api/image-studio/presets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        scope: isAdmin ? 'admin' : 'creator', name: presetName.trim(), groupName, prompt, context: moduleContext, model: moduleModel, quality, resolution,
        count, referenceLimit, referencePolicy, aspectRatio, bannerAssetId: banner?.id || null, referenceIds: moduleDraft.referenceIds, sourceModuleId: isAdmin ? module.id : undefined,
        fixedReferences: fixedEditable ? fixedReferencePayload(fixedReferences) : undefined,
        styleGroupIds: styleGroups.map(group => group.id),
      }) }));
      setSaveStatus('模板已保存');
      setSavedAsSignature(generationDraft);
      window.setTimeout(() => setSaveStatus(''), 2200);
    } catch (e) { setError(e instanceof Error ? e.message : '模板保存失败'); }
  }

  async function restoreTemporaryDraft(saved = recoverableDraft, automatic = false) {
      const sequence = ++draftRestoreSequence.current;
      setDraftRestoring(true);
      if (saved) {
        let restoredImages: UploadedAssetPayload[] = [];
        let restoredTask: StudioTask | undefined;
        let restoredStyles: StudioStyleSummary[] | undefined;
        let restoredFixed: FixedStudioReference[] | undefined;
        let recoveredFixedCount: number | undefined;
        let recoveredStyles: StudioStyleSummary[] | undefined;
        const validIds = (value: unknown): string[] => Array.isArray(value) ? value.flatMap((item: unknown) => {
          const id = typeof item === 'string' ? item : item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined;
          return typeof id === 'string' && id.length > 0 && id.length <= 100 ? [id] : [];
        }).slice(0, MAX_REFERENCE_IMAGES) : [];
        try {
          const ids = validIds(saved.images);
          const fixedIds = fixedEditable ? validIds(saved.fixedReferences) : [];
          const knownFixed = new Map((module.fixedReferences || []).map(image => [image.id, image]));
          const lookupIds = Array.from(new Set([...ids, ...fixedIds.filter(id => !knownFixed.has(id))]));
          let available: UploadedAssetPayload[] = [];
          if (lookupIds.length) {
            const result = await readResponse(await fetch(`/api/assets/history?assetIds=${encodeURIComponent(lookupIds.join(','))}`, { cache: 'no-store' }));
            available = result.assets || [];
            restoredImages = ids.flatMap(id => available.filter(image => image.id === id));
            if (restoredImages.length !== ids.length) throw new Error('上次草稿中的部分图片已不可用，当前模板未被替换。');
          }
          if (fixedEditable && Array.isArray(saved.fixedReferences)) restoredFixed = fixedIds.map(id => {
            const asset = knownFixed.get(id) || available.find(image => image.id === id);
            if (!asset) throw new Error('草稿中的固定参考图已不可用，当前模板未被替换。');
            const original = saved.fixedReferences.find((item: { id?: string }) => item.id === id);
            return { ...asset, note: typeof original?.note === 'string' ? original.note.slice(0, 2000) : '', available: true };
          });
          if (Array.isArray(saved.styleGroupIds)) {
            const styleIds = saved.styleGroupIds.filter((id: unknown): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)).slice(0, MAX_REFERENCE_IMAGES);
            restoredStyles = styleIds.length ? (await readResponse(await fetch(`/api/image-studio/style-groups?ids=${encodeURIComponent(styleIds.join(','))}`, { cache: 'no-store' }))).groups : [];
          }
          if (typeof saved.reproduceSourceTaskId === 'string') {
            if (saved.reproduceSourceTaskId.length > 120) throw new Error('历史任务编号无效，请恢复模板默认设置。');
            const history = await readResponse(await fetch(`/api/image-studio/tasks?moduleId=${encodeURIComponent(module.id)}&taskId=${encodeURIComponent(saved.reproduceSourceTaskId)}`, { cache: 'no-store' }));
            restoredTask = history.tasks?.find((task: StudioTask) => task.id === saved.reproduceSourceTaskId);
            if (!restoredTask?.snapshot?.sourceAvailable) throw new Error('这份草稿的历史来源已不可用，当前模板未被替换。');
            recoveredFixedCount = restoredTask.snapshot.fixedReferenceCount || 0;
            recoveredStyles = restoredTask.snapshot.styleGroups || [];
          }
        } catch (cause) {
          if (sequence === draftRestoreSequence.current) { blockedDraftSignature.current = generationDraft; setError(cause instanceof Error ? cause.message : '草稿参考图读取失败，请重试'); setRecoverableDraft(saved); setDraftRestoring(false); }
          return;
        }
        if (sequence !== draftRestoreSequence.current) return;
        if (typeof saved.prompt === 'string') setPrompt(saved.prompt.slice(0, 20000));
        if (Number.isInteger(saved.count) && saved.count >= 1 && saved.count <= 8) setCount(saved.count);
        if (Number.isInteger(saved.referenceLimit) && saved.referenceLimit >= 1 && saved.referenceLimit <= MAX_REFERENCE_IMAGES) setReferenceLimit(saved.referenceLimit);
        if (typeof saved.model === 'string' && models.includes(saved.model as typeof models[number])) setModuleModel(saved.model);
        if (typeof saved.resolution === 'string') setResolution(normalizeImageResolution(typeof saved.model === 'string' ? saved.model : module.model, saved.resolution));
        if (typeof saved.quality === 'string') setQuality(saved.quality);
        if (typeof saved.aspectRatio === 'string') { try { setAspectRatio(normalizeStudioRatio(saved.aspectRatio)); } catch {} }
        const policy = saved.referencePolicy;
        const primaryIds = policy && Array.isArray(policy.primaryIds) ? validIds(policy.primaryIds) : restoredImages.flatMap(image => image.id ? [image.id] : []);
        setImages(restoredImages.filter(image => primaryIds.includes(image.id || '')));
        setAuxiliaryImages(restoredImages.filter(image => !primaryIds.includes(image.id || '')));
        if (policy && Number.isInteger(policy.primaryMax) && policy.primaryMax >= 1 && policy.primaryMax <= MAX_REFERENCE_IMAGES) {
          setReferenceLimit(policy.primaryMax);
          if (Number.isInteger(policy.primaryMin) && policy.primaryMin >= 0 && policy.primaryMin <= policy.primaryMax) setPrimaryMin(policy.primaryMin);
        }
        if (policy && Number.isInteger(policy.auxiliaryMax) && policy.auxiliaryMax >= 0 && policy.auxiliaryMax <= MAX_REFERENCE_IMAGES) setAuxiliaryLimit(policy.auxiliaryMax);
        if (policy && Number.isInteger(policy.styleMax) && policy.styleMax >= 0 && policy.styleMax <= MAX_REFERENCE_IMAGES) setStyleLimit(policy.styleMax);
        if (policy && Number.isInteger(policy.referenceMax) && policy.referenceMax >= 0 && policy.referenceMax <= MAX_REFERENCE_IMAGES) setReferenceImageLimit(policy.referenceMax);
        if (policy && typeof policy.useFixedReferences === 'boolean') setUseFixedReferences(policy.useFixedReferences);
        if (contextEditable && typeof saved.context === 'string') setModuleContext(saved.context.slice(0, 20000));
        if (restoredFixed) setFixedReferences(restoredFixed);
        if (restoredStyles) setStyleGroups(restoredStyles);
        if (recoveredFixedCount !== undefined) setReproductionFixedCount(recoveredFixedCount);
        if (recoveredStyles) setReproductionStyles(recoveredStyles);
        if (Object.prototype.hasOwnProperty.call(saved, 'reproduceSourceTaskId')) {
          setReproduceSourceTaskId(typeof saved.reproduceSourceTaskId === 'string' && saved.reproduceSourceTaskId.length <= 120 ? saved.reproduceSourceTaskId : null);
          setReproductionReferences(isAdmin ? restoredTask?.snapshot?.fixedReferenceImages || [] : []);
        }
      }
      setRecoverableDraft(null);
      blockedDraftSignature.current = null;
      setSavedAsSignature('');
      setDraftRestoring(false);
      if (!automatic) setError('已恢复本次草稿，尚未提交生成。');
  }
  useEffect(() => {
    if (restoredDraftKey.current === draftKey) return;
    restoredDraftKey.current = draftKey;
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey) || 'null');
      if (saved && typeof saved === 'object') {
        blockedDraftSignature.current = generationDraft;
        setRecoverableDraft(saved);
        void restoreTemporaryDraft(saved, true).finally(() => setDraftLoaded(true));
      } else setDraftLoaded(true);
      const pending = JSON.parse(localStorage.getItem(pendingKey) || sessionStorage.getItem(pendingKey) || 'null');
      if (pending && typeof pending.requestId === 'string' && /^[a-zA-Z0-9-]{16,80}$/.test(pending.requestId)) {
        const identity = { requestId: pending.requestId };
        setPendingSubmission(identity);
        localStorage.setItem(pendingKey, JSON.stringify(identity)); sessionStorage.removeItem(pendingKey);
      }
    } catch { setDraftLoaded(true); /* A damaged local draft must not block the page. */ }
  }, [draftKey, pendingKey, module.saved, module.revision, module.model, isAdmin]);
  useEffect(() => {
    if (!draftLoaded || draftRestoring || (recoverableDraft && blockedDraftSignature.current === generationDraft)) return;
    try { localStorage.setItem(draftKey, JSON.stringify({ schemaVersion: 2, prompt, count, referenceLimit, referencePolicy, aspectRatio, resolution,
      images: [...images, ...auxiliaryImages].map(image => ({ id: image.id })), context: contextEditable ? moduleContext : undefined,
      fixedReferences: fixedEditable ? fixedReferences.map(image => ({ id: image.id, note: image.note })) : undefined,
      styleGroupIds: styleGroups.map(group => group.id), model: moduleModel, quality, reproduceSourceTaskId: reproduceSourceTaskId || null, revision: moduleRevision }));
      setPersistedDraftSignature(generationDraft); }
    catch { setError('临时草稿未能保存到浏览器，请勿刷新；当前内容仍可生成或另存为。'); }
  }, [draftLoaded, draftRestoring, recoverableDraft, draftKey, generationDraft, reproduceSourceTaskId, moduleRevision, contextEditable, fixedEditable]);

  useEffect(() => () => { draftRestoreSequence.current += 1; }, []);

  useEffect(() => {
    if (draftLoaded) onMetadataChange(module.id, name, groupName);
  }, [draftLoaded, module.id, name, groupName, onMetadataChange]);

  const saveAutomatically = useRef(() => {});
  saveAutomatically.current = () => {
    if (moduleDeleteLock.current) return;
    autoSaveAttempt.current = automaticSnapshot;
    void saveModule(reproduceSourceTaskId, revisionRef.current, false);
  };
  useEffect(() => {
    if (!draftLoaded || !automaticDirty || moduleSaving || moduleDeleting || uploading || bannerUploading || submitting || pendingSubmission
      || !name.trim() || !Number.isInteger(count) || count < 1 || count > 8 || autoSaveAttempt.current === automaticSnapshot) return;
    const timer = window.setTimeout(() => saveAutomatically.current(), 500);
    return () => window.clearTimeout(timer);
  }, [draftLoaded, automaticDirty, automaticSnapshot, moduleSaving, moduleDeleting, uploading, bannerUploading, submitting, pendingSubmission, name, count]);

  async function changeGroup(value: string) {
    const next = value !== '__other__' ? value : (await askName('输入新分组名称（最多 40 字）', '未命名分组', { title: '创建分组', confirmLabel: '创建分组', maxLength: 40 }))?.trim().slice(0, 40);
    if (next) { setGroupName(next); onMetadataChange(module.id, name, next, true); }
  }

  const loadTasks = useCallback(async (cursor?: string, action: 'initial' | 'refresh' | 'silent' = 'refresh') => {
    if (templateWorkbench) {
      const scope = `${userId}:${module.id}`;
      if (action === 'initial' && taskReadLoaded.current) action = 'silent';
      if (taskReadRequest.current?.scope === scope && (taskReadRequest.current.action !== 'silent' || action === 'silent')) return;
      taskReadRequest.current?.controller.abort();
      const request = { scope, controller: new AbortController(), action };
      taskReadRequest.current = request;
      const currentRequest = () => taskReadRequest.current === request && taskReadScopeRef.current === scope && !request.controller.signal.aborted;
      if (action !== 'silent') {
        setTaskReadAction(cursor ? 'more' : action);
        setLoadingTasks(action === 'initial');
        setTasksError('');
        setTaskRetryCursor(cursor);
      }
      try {
        const query = new URLSearchParams({ moduleId: module.id });
        if (cursor) query.set('cursor', cursor);
        const result = await readResponse(await fetch(`/api/image-studio/tasks?${query}`, { cache: 'no-store', signal: request.controller.signal }));
        if (!currentRequest()) return;
        taskReadLoaded.current = true;
        setTasks(current => {
          const fresh: StudioTask[] = result.tasks.filter((task: StudioTask) => !deletedIds.current.has(task.id));
          const ids = new Set(fresh.map(task => task.id));
          const previous = current.filter(task => !ids.has(task.id) && !deletedIds.current.has(task.id));
          return cursor ? [...previous, ...fresh] : loadedMore.current ? [...fresh, ...previous] : fresh;
        });
        if (cursor || !loadedMore.current) setNextCursor(result.nextCursor);
        if (cursor) loadedMore.current = true;
        setTasksError('');
      } catch (cause) {
        if (currentRequest()) setTasksError(cause instanceof Error ? cause.message : '读取记录失败，已有图片仍保留');
      } finally {
        if (taskReadRequest.current === request) {
          taskReadRequest.current = null;
          if (taskReadScopeRef.current === scope && !request.controller.signal.aborted) { setLoadingTasks(false); setTaskReadAction('idle'); }
        }
      }
      return;
    }
    if (listLock.current) return;
    listLock.current = true;
    try {
      const query = new URLSearchParams({ moduleId: module.id });
      if (cursor) query.set('cursor', cursor);
      const result = await readResponse(await fetch(`/api/image-studio/tasks?${query}`, { cache: 'no-store' }));
      setTasks(current => {
        const fresh: StudioTask[] = result.tasks.filter((task: StudioTask) => !deletedIds.current.has(task.id));
        const ids = new Set(fresh.map(task => task.id));
        const previous = current.filter(task => !ids.has(task.id) && !deletedIds.current.has(task.id));
        return cursor ? [...previous, ...fresh] : loadedMore.current ? [...fresh, ...previous] : fresh;
      });
      if (cursor || !loadedMore.current) setNextCursor(result.nextCursor);
      if (cursor) loadedMore.current = true;
      setTasksError('');
    } catch (e) { setTasksError(e instanceof Error ? e.message : '读取记录失败'); }
    finally { listLock.current = false; setLoadingTasks(false); }
  }, [module.id, userId, templateWorkbench]);
  useEffect(() => {
    if (!templateWorkbench) return;
    setTasks([]); setSelected([]); setPreview(null); setNextCursor(null); setTasksError('');
    setLoadingTasks(true); setTaskReadAction('initial'); loadedMore.current = false; taskReadLoaded.current = false;
    return () => {
      const request = taskReadRequest.current;
      if (request?.scope === taskReadScope) { request.controller.abort(); taskReadRequest.current = null; }
    };
  }, [taskReadScope, templateWorkbench]);
  useEffect(() => { if (visible) void loadTasks(undefined, 'initial'); }, [visible, loadTasks]);
  const hasPending = tasks.some(task => task.status === 'queued' || task.status === 'running');
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => { if (!document.hidden) void loadTasks(undefined, 'silent'); }, hasPending ? 5000 : 15000);
    return () => clearInterval(timer);
  }, [hasPending, loadTasks, visible]);
  useEffect(() => {
    const refresh = () => { if (!document.hidden && visible) void loadTasks(undefined, 'silent'); };
    document.addEventListener('visibilitychange', refresh);
    return () => document.removeEventListener('visibilitychange', refresh);
  }, [loadTasks, visible]);
  useEffect(() => () => { if (downloadReady) URL.revokeObjectURL(downloadReady.url); }, [downloadReady]);

  async function querySubmission() {
    if (!pendingSubmission || submitLock.current || moduleDeleteLock.current) return;
    submitLock.current = true; setQueryingSubmission(true); setSubmitting(true); setError('');
    try {
      const value = await readResponse(await fetch(`/api/image-studio/tasks?requestId=${encodeURIComponent(String(pendingSubmission.requestId))}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) }));
      if (!Array.isArray(value.tasks) || !value.tasks.length) {
        setError('暂未查到这次提交，仍不能确认是否受理。请稍后查询或联系管理员，不会自动再生成。'); return;
      }
      setPendingSubmission(null); localStorage.removeItem(pendingKey); sessionStorage.removeItem(pendingKey);
      await loadTasks();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '查询暂不可用，原提交编号仍保留。'); }
    finally { submitLock.current = false; setSubmitting(false); setQueryingSubmission(false); }
  }

  async function submit(retryTask?: StudioTask) {
    if (pendingSubmission) { await querySubmission(); return; }
    if (!settings || submitLock.current || moduleDeleteLock.current || ratioEditing || draftRestoring) return;
    if (reproduceSourceTaskId || tasks.some(task => task.status === 'uncertain')) {
      submitLock.current = true;
      let accepted = false;
      try { accepted = await confirm('这会新建图片生成任务，可能再次产生上游费用。恢复原图不会重新生成；确定按当前设置新建生成任务吗？', { title: '确认生成', confirmLabel: '新建生成任务' }); }
      finally { submitLock.current = false; }
      if (!accepted) return;
    }
    if (!pendingSubmission && (images.length < primaryMin || images.length > referenceLimit || auxiliaryCount > auxiliaryLimit || styleImageCount > styleLimit || ordinaryReferenceCount > referenceImageLimit || effectiveReferenceCount > MAX_REFERENCE_IMAGES
      || activeFixedReferences.some(item => item.available === false) || activeStyles.some(group => group.unavailable))) {
      setError('请检查主图数量、辅助参考数量和图片可用性。'); return;
    }
    const payload = pendingSubmission || { requestId: crypto.randomUUID(), prompt: retryTask?.prompt ?? prompt,
      moduleId: module.id, model: retryTask?.model || moduleModel, quality: retryTask?.quality || quality, reproduceFromTaskId: reproduceSourceTaskId || undefined, count: retryTask ? 1 : count, aspectRatio: retryTask?.aspectRatio || aspectRatio, resolution: retryTask?.snapshot?.resolution || resolution, revision: settings.revision,
      referenceIds: retryTask?.referenceIds || moduleDraft.referenceIds,
      draft: { moduleContext: contextEditable ? moduleContext : undefined, globalContext: isAdmin ? globalContextDraft : undefined,
        fixedReferences: !reproduceSourceTaskId && fixedEditable ? fixedReferencePayload(fixedReferences) : undefined,
        styleGroupIds: reproduceSourceTaskId ? undefined : styleGroups.map(group => group.id), referencePolicy } };
    try {
      const saved = JSON.stringify({ requestId: payload.requestId });
      localStorage.setItem(pendingKey, saved);
      if (localStorage.getItem(pendingKey) !== saved) throw new Error('Request identity not saved');
    } catch { setError('提交编号未能保存，尚未提交生成。请允许浏览器保存数据后再试。'); return; }
    submitLock.current = true; setSubmitting(true); setError('');
    let ambiguous = true;
    try {
      const response = await fetch('/api/image-studio/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
      if (response.status >= 400 && response.status < 500) { ambiguous = false; setPendingSubmission(null); try { localStorage.removeItem(pendingKey); sessionStorage.removeItem(pendingKey); } catch {} if (response.status === 409) onReloadSettings(); await readResponse(response); }
      else {
        const value = await readResponse(response);
        if (typeof value.batchId !== 'string' || !/^[a-f0-9]{64}$/.test(value.batchId)) throw new Error('提交结果待确认，请查询这次提交。');
        setPendingSubmission(null); try { localStorage.removeItem(pendingKey); sessionStorage.removeItem(pendingKey); } catch {} await loadTasks();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '提交结果未确认');
      // Reuse the exact request ID after ambiguous transport failures.
      setPendingSubmission(ambiguous ? { requestId: payload.requestId } : null);
    } finally { submitLock.current = false; setSubmitting(false); }
  }

  async function restoreTask(task: StudioTask) {
    if (!task.snapshot) {
      setError('这条历史记录没有可恢复的完整设置，请按当前模块重新填写后生成。');
      return;
    }
    if (pendingSubmission) {
      setError('上次提交尚未确认，请先查看生成记录或放弃核对后再恢复设置。');
      return;
    }
    if (uploading || moduleSaving) {
      setError('当前仍在上传或保存模块，请完成后再恢复历史设置。');
      return;
    }
    if (moduleDirty && !(await confirm('当前模块有未保存内容，恢复后会替换当前输入，但不会立即保存、提交或扣积分。确定继续吗？', { title: '恢复历史设置', confirmLabel: '恢复设置' }))) return;
    const snapshot = task.snapshot;
    setPrompt(snapshot.prompt || '');
    setCount(Math.max(1, Math.min(8, snapshot.count || 1)));
    try { setAspectRatio(normalizeStudioRatio(snapshot.aspectRatio || 'auto')); } catch { setAspectRatio('auto'); }
    setResolution(normalizeImageResolution(snapshot.model || moduleModel, snapshot.resolution || defaultImageResolution(snapshot.model || moduleModel)));
    const transient = snapshot.transientReferenceImages || snapshot.referenceImages;
    const primaryIds = snapshot.referencePolicy?.primaryIds || transient.flatMap(image => image.id ? [image.id] : []);
    setImages(transient.filter(image => image && primaryIds.includes(image.id || '')));
    setAuxiliaryImages(transient.filter(image => image && !primaryIds.includes(image.id || '')));
    setReferenceLimit(snapshot.referencePolicy?.primaryMax ?? Math.max(1, transient.length));
    setPrimaryMin(snapshot.referencePolicy?.primaryMin ?? 0); setAuxiliaryLimit(snapshot.referencePolicy?.auxiliaryMax ?? MAX_REFERENCE_IMAGES);
    setStyleLimit(snapshot.referencePolicy?.styleMax ?? MAX_REFERENCE_IMAGES); setReferenceImageLimit(snapshot.referencePolicy?.referenceMax ?? MAX_REFERENCE_IMAGES);
    setUseFixedReferences(snapshot.referencePolicy?.useFixedReferences ?? true);
    setReproductionReferences(snapshot.fixedReferenceImages || []);
    setReproductionFixedCount(snapshot.fixedReferenceCount ?? snapshot.fixedReferenceImages?.length ?? 0);
    setReproductionStyles(snapshot.styleGroups || []);
    if (typeof snapshot.model === 'string' && snapshot.model) setModuleModel(snapshot.model);
    if (typeof snapshot.quality === 'string') setQuality(normalizeImageStudioQuality(snapshot.model || moduleModel, snapshot.quality));
    setReproduceSourceTaskId(snapshot.sourceAvailable ? task.id : null);
    setSelected([]);
    setError(snapshot.sourceAvailable
      ? '已恢复当时的参考图和生成设置，生成时合并当前通用与模块上下文。点击“生成图片”后才会创建新任务并扣积分。'
      : '已恢复当时可读取的参考图和生成设置。该旧记录没有独立上下文快照，本次会按当前模块上下文生成。点击“生成图片”后才会创建新任务并扣积分。');
  }

  function exitReproductionMode(message = '已退出历史复现模式，接下来会使用当前模块上下文。') {
    setReproduceSourceTaskId(null);
    setError(message);
  }

  async function download(ids: string[]) {
    if (downloadBusy) return;
    setDownloadBusy(true); setError(''); setDownloadReady(null);
    try {
      const query = new URLSearchParams(); ids.forEach(id => query.append('id', id));
      const response = await fetch(`/api/image-studio/download?${query}`);
      if (!response.ok) { await readResponse(response); return; }
      const expectedType = ids.length === 1 ? 'image/png' : 'application/zip';
      if (!response.headers.get('content-type')?.startsWith(expectedType)) throw new Error('下载未返回图片，请重新登录后重试');
      const blob = await response.blob();
      if (!blob.size) throw new Error('下载文件为空，请重试');
      const url = URL.createObjectURL(blob);
      const name = ids.length === 1 ? 'generated-image.png' : 'generated-images.zip';
      setDownloadReady({ url, name });
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = name;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setSelected([]); setDownloadMode(false);
    } catch (e) { setError(e instanceof Error ? e.message : '下载失败，请重试'); }
    finally { setDownloadBusy(false); }
  }
  async function deleteResult() {
    if (!deleteTarget || deleteLock.current) return;
    const target = deleteTarget;
    deleteLock.current = true; setDeleting(true); setDeleteError('');
    try {
      await readResponse(await fetch('/api/image-studio/tasks', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: target.id }) }));
      deletedIds.current.add(target.id);
      setTasks(current => current.filter(task => task.id !== target.id));
      setSelected(current => current.filter(id => id !== target.id));
      setDownloadReady(null); setDeleteTarget(null);
      if (preview?.taskId === target.id || preview?.src === target.asset?.original_url) setPreview(null);
    } catch (e) { setDeleteError(e instanceof Error ? e.message : '删除未确认，请重试'); }
    finally { deleteLock.current = false; setDeleting(false); }
  }
  async function copyTaskContext(task: StudioTask) {
    if (!isAdmin || !task.snapshot?.sourceAvailable) return;
    setCopyFeedback({ id: task.id, text: '复制中…' });
    const copied = await copyStudioText(copyStudioTaskText(task));
    setCopyFeedback({ id: task.id, text: copied ? '已复制' : '复制失败，请重试' });
    window.setTimeout(() => setCopyFeedback(current => current?.id === task.id ? null : current), copied ? 1800 : 2600);
  }
  async function copyTaskImage(task: StudioTask) {
    const imageUrl = task.asset?.original_url;
    if (!imageUrl) return;
    setCopyFeedback({ id: task.id, text: '复制中…' });
    let copied = false;
    try {
      await copyImage(imageUrl);
      copied = true;
    } catch {
      copied = false;
    }
    setCopyFeedback({ id: task.id, text: copied ? '已复制' : '复制失败，请重试' });
    window.setTimeout(() => setCopyFeedback(current => current?.id === task.id ? null : current), copied ? 1800 : 2600);
  }
  const moduleUnitCredits = settings?.prices?.[moduleModel] ?? module.prices[moduleModel] ?? null;
  const providerCostUsd = IMAGE_STUDIO_MODEL_COST_USD[moduleModel as keyof typeof IMAGE_STUDIO_MODEL_COST_USD];
  const selectedProviderReady = settings?.modelReady?.[moduleModel] ?? settings?.providerReady;
  const hasContext = Boolean((isAdmin ? globalContextDraft?.trim() : settings?.contextConfigured) || (contextEditable ? moduleContext.trim() : moduleContextConfigured));
  const ready = Boolean(selectedProviderReady && moduleUnitCredits !== null && settings && !settingsError);
  const generationFeedback: StudioFeedback | null = queryingSubmission ? { message: '正在查询这次提交，不会再次生成。', tone: 'progress' }
    : pendingSubmission ? submitting ? { message: '正在处理当前请求，请稍候再查询。', tone: 'progress' }
      : moduleDeleting ? { message: '正在删除模板，请等待操作结束后再查询。', tone: 'progress' } : null
    : sourceSharingBlocked ? { message: '该模板已停止共享，请换一个可用模板。', tone: 'error' }
    : submitting ? { message: '正在提交，请等待结果，不要重复点击。', tone: 'progress' }
    : uploading || bannerUploading ? { message: '图片还在上传或处理，请等待图片显示后再生成。', tone: 'progress' }
    : draftRestoring ? { message: '正在恢复上次使用的图片和设置。', tone: 'progress' }
    : ratioEditing ? { message: '图片比例尚未确认，请先完成比例设置。', tone: 'info' }
    : settingsError ? { message: `设置暂不可用：${settingsError}`, tone: 'error' }
    : !settings ? { message: '正在读取生成设置，请稍候；长时间无变化请刷新页面。', tone: 'progress' }
    : !selectedProviderReady ? { message: '当前模型的图片服务尚未就绪，请换一个模型或联系管理员检查接口。', tone: 'warning' }
    : moduleUnitCredits === null ? { message: '当前模型尚未设置点数，请换一个模型或联系管理员配置。', tone: 'warning' }
    : activeFixedReferences.some(item => item.available === false) ? { message: '固定参考图已不可用，请关闭、移除或更换。', tone: 'error' }
    : activeStyles.some(group => group.unavailable) ? { message: '已选风格组不可用，请移除或重新选择。', tone: 'error' }
    : images.length < primaryMin ? { message: `这个模板至少需要 ${primaryMin} 张主图，当前 ${images.length} 张。`, tone: 'warning' }
    : images.length > referenceLimit ? { message: `主图最多 ${referenceLimit} 张，请移除多余主图或调整上限。`, tone: 'warning' }
    : styleImageCount > styleLimit ? { message: `风格组最多传入 ${styleLimit} 张图片，当前 ${styleImageCount} 张。请调整上限或移除风格组。`, tone: 'warning' }
    : ordinaryReferenceCount > referenceImageLimit ? { message: `参考图最多 ${referenceImageLimit} 张，当前 ${ordinaryReferenceCount} 张（含启用的模板固定图）。`, tone: 'warning' }
    : auxiliaryCount > auxiliaryLimit ? { message: `辅助参考最多 ${auxiliaryLimit} 张，当前 ${auxiliaryCount} 张（包含模板图和风格组）。`, tone: 'warning' }
    : effectiveReferenceCount > MAX_REFERENCE_IMAGES ? { message: `当前通道最多传入 ${MAX_REFERENCE_IMAGES} 张图片，已选主图 ${images.length} 张、辅助参考 ${auxiliaryCount} 张，请减少辅助参考。`, tone: 'warning' }
    : !prompt.trim() && !effectiveReferenceCount && !hasContext ? { message: '请填写画面要求，或添加主图。', tone: 'info' }
    : !Number.isInteger(count) || count < 1 || count > 8 ? { message: '生成张数应为1到8的整数，请修改张数。', tone: 'warning' }
    : !ready ? { message: '生成条件尚未就绪，请检查模型和上下文设置。', tone: 'warning' } : null;
  const previewableTasks = tasks.filter(task => Boolean(task.asset?.id));
  function openTaskPreview(task: StudioTask) { setPreview(studioTaskPreviewState(task)); }
  function movePreview(direction: -1 | 1) {
    if (!preview?.taskId || previewableTasks.length < 2) return;
    const currentIndex = previewableTasks.findIndex(task => task.id === preview.taskId);
    const nextIndex = currentIndex < 0 ? 0 : (currentIndex + direction + previewableTasks.length) % previewableTasks.length;
    setPreview(studioTaskPreviewState(previewableTasks[nextIndex]));
  }

  function changeFixedReferences(next: FixedStudioReference[]) {
    if (!fixedEditable) return;
    if (reproduceSourceTaskId) exitReproductionMode('固定参考图已修改，已退出历史复现模式。');
    setFixedReferences(next); setModuleSaveError('');
  }
  function clearAllReferences() {
    if (uploading || submitting || pendingSubmission) return;
    setAuxiliaryImages([]); setStyleGroups([]); setUseFixedReferences(false);
    setReproduceSourceTaskId(null); setRecoverableDraft(null);
    setError('本次辅助参考已清空，主图、文字上下文和原始资料保留。');
  }
  function changeImageRole(image: UploadedAssetPayload, index: number, toPrimary: boolean) {
    if (toPrimary) {
      if (images.length >= referenceLimit) { setError('主图已达到数量上限，请先调整上限。'); return; }
      setAuxiliaryImages(current => current.filter((_, position) => position !== index));
      setImages(current => [...current, image]);
    } else {
      if (auxiliaryCount >= auxiliaryLimit || ordinaryReferenceCount >= referenceImageLimit) { setError('参考图已达到数量上限，请先调整上限。'); return; }
      setImages(current => current.filter((_, position) => position !== index));
      setAuxiliaryImages(current => [...current, image]);
    }
  }
  function previewReference(asset: UploadedAssetPayload, number: number) {
    if (!asset.originalUrl) return;
    if (moduleDialog.current?.open) { resumeModulePreview.current = true; moduleDialog.current.close(); }
    setPreview({ contentKey: asset.id ? `asset:${asset.id}` : undefined, src: asset.originalUrl, alt: `参考图 ${number}`, fileName: asset.fileName, width: asset.width || undefined, height: asset.height || undefined });
  }
  const addImages = useCallback(async (files: File[], fixed = false, auxiliary = false) => {
    if (uploadLock.current || submitting || pendingSubmission || !files.length) return;
    if (fixed && !fixedEditable) return;
    const cap = fixed ? MAX_REFERENCE_IMAGES : auxiliary ? currentAuxiliaryCap : currentReferenceCap;
    const existing = fixed ? fixedReferences.length : auxiliary ? auxiliaryImages.length : images.length;
    const singleMain = !fixed && !auxiliary && referenceLimit === 1;
    if (singleMain && files.length > 1) {
      setError('主图上限为 1 张，请一次只选择一张图片。');
      return;
    }
    const replacing = singleMain && existing > 0;
    const uploadFiles = files;
    if (!cap || (!replacing && uploadFiles.length + existing > cap)) { setError(fixed ? `固定参考图最多 ${MAX_REFERENCE_IMAGES} 张` : auxiliary ? `本次可选辅助参考最多 ${cap} 张，模板和风格组已占 ${activeFixedCount} 张。` : `本次可选主图最多 ${cap} 张，请调整数量或减少辅助参考。`); return; }
    if (uploadFiles.some(file => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024)) {
      setError('请使用 20MB 以内的 PNG、JPG 或 WebP 图片'); return;
    }
    if (replacing && !(await confirm(`确认用「${uploadFiles[0].name}」替换当前主图？上传成功前旧主图会保留；取消不会更改当前内容。`, { title: '替换主图', confirmLabel: '替换主图' }))) return;
    uploadLock.current = true; setUploading(true); setError('');
    try {
      for (let index = 0; index < uploadFiles.length; index++) {
        const file = uploadFiles[index];
        const asset = await uploadFileAsAsset(file, { onProgress: progress => setUploadProgress(studioUploadProgress(file, index, uploadFiles.length, progress)) });
        if (!asset.id || !asset.originalUrl) throw new Error('上传结果不完整，请重试');
        if (fixed) {
          setFixedReferences(current => [...current, { ...asset, note: '', available: true }]);
          setReproduceSourceTaskId(null);
        } else if (auxiliary) setAuxiliaryImages(current => [...current, asset]);
        else setImages(current => replacing ? [asset] : [...current, asset]);
      }
    } catch (e) { setError(e instanceof Error ? e.message : '上传失败'); }
    finally { uploadLock.current = false; setUploading(false); setUploadProgress(null); }
  }, [images.length, auxiliaryImages.length, currentReferenceCap, currentAuxiliaryCap, fixedReferences.length, activeFixedCount, submitting, pendingSubmission, fixedEditable, referenceLimit]);

  async function uploadBanner(file: File) {
    if (bannerUploading || submitting || pendingSubmission) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024) {
      setError('banner 请使用 20MB 以内的 PNG、JPG 或 WebP 图片'); return;
    }
    setBannerUploading(true); setError('');
    try {
      const asset = await uploadFileAsAsset(file, { onProgress: progress => setBannerProgress(studioUploadProgress(file, 0, 1, progress)) });
      if (!asset.id || !asset.originalUrl) throw new Error('banner 上传结果不完整，请重试');
      setBanner(asset);
    } catch (e) { setError(e instanceof Error ? e.message : 'banner 上传失败'); }
    finally { setBannerUploading(false); setBannerProgress(null); }
  }

  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      if (!active || assetPickerOpen || document.querySelector('dialog[open]') || preview || event.defaultPrevented) return;
      const files = Array.from(event.clipboardData?.items || [])
        .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
        .map(item => item.getAsFile()).filter((file): file is File => Boolean(file));
      if (!files.length) return;
      event.preventDefault();
      void addImages(files);
    };
    document.addEventListener('paste', paste);
    return () => document.removeEventListener('paste', paste);
  }, [addImages, preview, active, referenceLimit, assetPickerOpen]);

  function activateDraft() {
    onActivate();
    if (draftRestoring) { draftRestoreSequence.current += 1; setDraftRestoring(false); }
  }
  return <>{productDialog}{(<section ref={section} hidden={hidden} id={`module-${module.id}`} className={styles.module} aria-label={name} data-active={active}
    onPointerDownCapture={activateDraft} onFocusCapture={activateDraft}>
    <header className={styles.header}>
      <div className={styles.moduleTitleRow}>
        {module.saved && <ContentReactions contentKey={`image_module:${module.id}`} />}
        {nameEditing ? <input ref={nameInput} className={styles.moduleName} aria-label="模块名称" value={name} maxLength={80} onChange={event => setName(event.target.value)} onBlur={() => setNameEditing(false)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); setNameEditing(false); } }} /> : <button type="button" className={styles.moduleNameDisplay} aria-label={`编辑模块标题：${name}`} onClick={() => setNameEditing(true)}>{name}</button>}
        {module.sourcePresetCanManageSharing && module.sourcePresetId && <button type="button" role="switch" aria-checked={module.sourcePresetShared === true} className={`${styles.presetSharing} ${styles.moduleSharing}`} title={templateWorkbench ? '只改变原模板的共享，不会发布当前模块草稿' : undefined} disabled={sharingId === module.sourcePresetId} onClick={() => void onToggleSharing(module)}>{templateWorkbench ? (module.sourcePresetShared === true ? '原模板已共享' : '共享原模板') : (module.sourcePresetShared === true ? '共享给同事' : '仅自己可见')}</button>}
      </div>
      <div className={styles.counts}>
        <label className={styles.moduleGroupControl}>分组
          <select aria-label="模块分组" value={groupName} onChange={event => changeGroup(event.target.value)}>
            {groups.map(group => <option key={group} value={group}>{group}</option>)}
            <option value="__other__">其他…</option>
          </select>
        </label>
        {!DEFAULT_GROUPS.includes(groupName) && <button type="button" disabled={moduleSaving || automaticDirty} title="删除当前分组" onClick={() => void onDeleteGroup(groupName)}>删除分组</button>}
        <span role="status" className={styles.muted}>{moduleSaving ? '保存中' : moduleSaveError ? '保存失败' : automaticDirty ? '等待自动保存' : settingsDirty ? '设置未保存' : '已保存'}</span>
        <button type="button" disabled={!draftLoaded || draftRestoring} onClick={openModuleDialog}><Settings size={17} />模块上下文</button>
        <button type="button" title={module.id === `default-${userId}` ? (templateWorkbench ? '默认模块需要保留' : '默认模板需要保留') : (templateWorkbench ? '删除模块' : '删除模板')} aria-label={`删除${templateWorkbench ? '模块' : '模板'}：${name}`}
          disabled={module.id === `default-${userId}` || moduleDeleting || moduleSaving || submitting || uploading || bannerUploading || Boolean(pendingSubmission)}
          onClick={() => void deleteModule()}><Trash2 size={17} />{moduleDeleting ? '删除中' : templateWorkbench ? '删除模块' : '删除模板'}</button>
      </div>
    </header>
    <div className={`${styles.moduleBanner} ${banner?.originalUrl ? styles.moduleBannerHasImage : ''}`}>
      {banner?.originalUrl ? <>
        {/* 固定 banner 高度并完整等比显示图片，不裁切。 */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img decoding="async" className={styles.moduleBannerImage} src={banner.thumbnailUrl || undefined} alt={templateWorkbench ? '模块封面' : '模块 banner'} />
        <span className={styles.bannerLabel}>{templateWorkbench ? '模块封面' : '模块 banner'}</span>
        <button type="button" className={styles.bannerReplace} disabled={bannerUploading || submitting} onClick={() => openImageSource('banner')}>{bannerUploading ? '上传中' : '更换图片'}</button>
        <button type="button" className={styles.bannerRemove} disabled={bannerUploading || submitting} onClick={() => setBanner(null)} aria-label={templateWorkbench ? '移除模块封面' : '移除模块 banner'}><X size={16} /></button>
      </> : <button type="button" className={styles.bannerEmpty} disabled={bannerUploading || submitting} onClick={() => openImageSource('banner')}><ImagePlus size={20} />{bannerUploading ? '上传中' : templateWorkbench ? '添加模块封面' : '添加模块 banner'}</button>}
    </div>
    <input ref={bannerFileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={event => { const file = event.target.files?.[0]; if (file) void uploadBanner(file); event.target.value = ''; }} />
    {bannerProgress && <UploadProgressIndicator {...bannerProgress} />}
    <div className={styles.workspace}>
      <section className={styles.inputs} aria-label="生成参数">
        {reproduceSourceTaskId && <p role="status" className={styles.muted}>历史复现模式：沿用当时的参考图，合并当前通用与模块上下文；不会自动提交或扣积分。<button type="button" onClick={() => exitReproductionMode()}>退出历史复现</button></p>}
        <section className={`${styles.materialSection} ${templateWorkbench ? styles.primaryMaterials : ''}`} aria-label="主图">
          <header className={styles.materialHeading}><h3>主图</h3>
            <select aria-label="主图数量上限" value={referenceLimit} disabled={uploading || submitting || Boolean(pendingSubmission)} onChange={event => {
              const next = Number(event.target.value);
              if (next < images.length || next < primaryMin) { setError('上限不能低于当前主图数量或最少要求，请先调整。'); return; }
              setReferenceLimit(next);
            }}>{Array.from({ length: MAX_REFERENCE_IMAGES }, (_, index) => index + 1).map(value => <option key={value} value={value}>最多 {value} 张</option>)}</select>
            <span>已选 <b>{images.length} 张</b></span>
          </header>
          <div onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void addImages(Array.from(event.dataTransfer.files)); }}>
            <StudioReferenceGrid items={images} onChange={setImages} onPreview={previewReference} labels="primary" materialTiles compact
              onChangeRole={(image, index) => changeImageRole(image, index, false)} disabled={uploading || submitting || Boolean(pendingSubmission)}>
              {(!templateWorkbench || images.length < currentReferenceCap) && <button type="button" className={styles.materialAdd} disabled={uploading || submitting || Boolean(pendingSubmission) || images.length >= currentReferenceCap}
                title={images.length >= currentReferenceCap ? '已达到可用图片数量上限' : '添加主图'} onClick={() => openImageSource('reference')}><Plus size={24} /><span>{uploading ? '上传中' : '添加主图'}</span></button>}
            </StudioReferenceGrid>
          </div>
        </section>
        <section className={styles.materialSection} aria-label="风格组">
          <header className={styles.materialHeading}><h3>风格组</h3>
            <select aria-label="风格图片数量上限" value={styleLimit} disabled={uploading || submitting || Boolean(pendingSubmission)} onChange={event => setStyleLimit(Number(event.target.value))}>
              {Array.from({ length: MAX_REFERENCE_IMAGES + 1 }, (_, value) => <option key={value} value={value}>最多 {value} 张</option>)}
            </select><span>已选 <b>{activeStyles.length} 组</b><small>共 {styleImageCount} 张</small></span>
          </header>
          <StudioStyleGroups userId={userId} selected={activeStyles} currentImages={auxiliaryImages} tiles maxReferences={currentStyleCap}
            disabled={uploading || submitting || Boolean(pendingSubmission)}
            onChange={next => { if (reproduceSourceTaskId) exitReproductionMode('风格组已修改，接下来使用当前模板和风格组。'); setStyleGroups(next); }} />
        </section>
        <section className={styles.materialSection} aria-label="参考图">
          <header className={styles.materialHeading}><h3>参考图</h3>
            <select aria-label="参考图数量上限" value={referenceImageLimit} disabled={uploading || submitting || Boolean(pendingSubmission)} onChange={event => setReferenceImageLimit(Number(event.target.value))}>
              {Array.from({ length: MAX_REFERENCE_IMAGES + 1 }, (_, value) => <option key={value} value={value}>最多 {value} 张</option>)}
            </select><span>已选 <b>{ordinaryReferenceCount} 张</b></span>
          </header>
          <div onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void addImages(Array.from(event.dataTransfer.files), false, true); }}
            onPaste={event => {
              const files = Array.from(event.clipboardData.items).filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter((file): file is File => Boolean(file));
              if (files.length) { event.preventDefault(); event.stopPropagation(); void addImages(files, false, true); }
            }} tabIndex={0} aria-label="参考图片">
            <StudioReferenceGrid items={auxiliaryImages} onChange={setAuxiliaryImages} onPreview={previewReference} labels="auxiliary" compact materialTiles onChangeRole={(image, index) => changeImageRole(image, index, true)} disabled={uploading || submitting || Boolean(pendingSubmission)}>
              {isAdmin && activeFixedReferences.slice(0, activeTemplateCount).map((image, index) => <div className={styles.styleTile} key={`fixed-${image.id}-${index}`}>
                <button type="button" className={styles.styleTilePreview} disabled={!image.originalUrl} onClick={() => previewReference(image, index + 1)} aria-label={`预览模板固定图${index + 1}`}>
                  <ImagePlus size={24} />{image.thumbnailUrl && <img src={image.thumbnailUrl} alt={`模板固定图${index + 1}`} />}
                  <span className={styles.styleTileName}>模板{String.fromCharCode(65 + index)}</span>
                </button>
                {fixedEditable && !reproduceSourceTaskId && <button type="button" className={styles.materialRemove} disabled={uploading || submitting || Boolean(pendingSubmission)}
                  title="移除本次固定参考图" aria-label={`移除模板固定图${index + 1}`} onClick={() => changeFixedReferences(fixedReferences.filter((_, position) => position !== index))}><X size={14} /></button>}
              </div>)}
              {!isAdmin && activeTemplateCount > 0 && <div className={styles.hiddenReferenceTile}><ImagePlus size={22} /><span>模板固定图</span><b>{activeTemplateCount} 张</b></div>}
              <button type="button" className={styles.materialAdd} disabled={uploading || submitting || Boolean(pendingSubmission) || auxiliaryImages.length >= currentAuxiliaryCap}
                title={auxiliaryImages.length >= currentAuxiliaryCap ? '已达到可用图片数量上限' : '添加参考图'} onClick={() => openImageSource('auxiliary')}><Plus size={24} /><span>添加参考图</span></button>
            </StudioReferenceGrid>
          </div>
          {(fixedReferences.length > 0 || Boolean(module.fixedReferenceCount) || reproductionFixedCount > styleImageCount) && <label className={styles.referenceToggle}><input type="checkbox" checked={useFixedReferences} disabled={uploading || submitting || Boolean(pendingSubmission)} onChange={event => setUseFixedReferences(event.target.checked)} />使用模板固定参考图</label>}
          <input ref={auxiliaryFileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={event => { void addImages(Array.from(event.target.files || []), false, true); event.target.value = ''; }} />
        </section>
        <div className={styles.materialFooter}><span>本次图片 {effectiveReferenceCount} / {MAX_REFERENCE_IMAGES} 张</span>
          <button type="button" title="清空本次风格组和参考图，保留主图与文字" disabled={uploading || submitting || Boolean(pendingSubmission) || !auxiliaryCount} onClick={clearAllReferences}><X size={14} />清空参考</button>
        </div>
        {uploadProgress && <UploadProgressIndicator busy {...uploadProgress} />}
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={event => {
          void addImages(Array.from(event.target.files || [])); event.target.value = '';
        }} />
        <label className={styles.label} htmlFor={`studio-prompt-${module.id}`}>补充 <span>有图片时选填</span></label>
        <textarea id={`studio-prompt-${module.id}`} disabled={submitting || Boolean(pendingSubmission)} value={prompt} maxLength={20000} onChange={event => setPrompt(event.target.value)} placeholder="补充想生成的画面" rows={9} />
        <label className={styles.label} htmlFor={`studio-count-${module.id}`}>生成张数</label>
        <div className={styles.counts}>
          {[1, 2, 4, 8].map(n => <button type="button" disabled={submitting || Boolean(pendingSubmission)} key={n} aria-pressed={count === n} onClick={() => setCount(n)}>{n}</button>)}
          <input id={`studio-count-${module.id}`} disabled={submitting || Boolean(pendingSubmission)} type="number" min={1} max={8} step={1} value={count} onChange={event => setCount(Number(event.target.value))} />
        </div>
        <button type="button" className={`${styles.generate} sd2-loading-surface`} data-busy={submitting || queryingSubmission} disabled={Boolean(generationFeedback)} title={generationFeedback?.message} aria-describedby={generationFeedback ? `generation-blocker-${module.id}` : undefined} onClick={() => void (pendingSubmission ? querySubmission() : submit())}>{queryingSubmission ? '正在查询' : submitting ? '正在提交' : pendingSubmission ? '查询这次提交' : '生成图片'}</button>
        {generationFeedback && <p id={`generation-blocker-${module.id}`} role="status" className={styles.generationFeedback} data-tone={generationFeedback.tone}>{generationFeedback.message}</p>}
        {settingsError && <button type="button" onClick={async () => { if (!dirty || (await confirm('重新读取会替换未保存的通用设置，是否继续？', { title: '重新读取', confirmLabel: '放弃修改并读取' }))) onReloadSettings(true); }}><RefreshCw size={16} />重新读取设置</button>}
        {sourceSharingBlocked && <p role="alert" className={styles.error}>该模板已停止共享，不能新建任务；已提交任务和历史结果仍保留。</p>}
        <RatioPicker value={aspectRatio} onChange={setAspectRatio} reference={effectiveReferences.find(image => Number(image.width) > 0 && Number(image.height) > 0) || null} model={moduleModel} resolution={resolution} onEditing={setRatioEditing} disabled={submitting || Boolean(pendingSubmission)} {...ratios} />
        <div className={styles.modelQualityRow}>
          <label className={styles.compactField} htmlFor={`studio-model-${module.id}`}><strong>生成模型</strong>
            <select id={`studio-model-${module.id}`} disabled={submitting || Boolean(pendingSubmission)} value={moduleModel} onChange={event => { const next = event.target.value; setModuleModel(next); setQuality(defaultImageStudioQuality(next)); setResolution(defaultImageResolution(next)); }}>
              {models.map(model => <option key={model} value={model}>{IMAGE_STUDIO_MODEL_LABELS[model]}</option>)}
            </select>
          </label>
          <label className={styles.compactField} htmlFor={`studio-quality-${module.id}`}><strong>图片质量</strong>
            <select id={`studio-quality-${module.id}`} disabled={submitting || Boolean(pendingSubmission)} value={normalizeImageStudioQuality(moduleModel, quality)} onChange={event => setQuality(event.target.value)}>
              {(IMAGE_STUDIO_MODEL_QUALITY_OPTIONS[moduleModel as keyof typeof IMAGE_STUDIO_MODEL_QUALITY_OPTIONS] || ['auto']).map(option => <option key={option} value={option}>{IMAGE_STUDIO_QUALITY_LABELS[option]}</option>)}
            </select>
          </label>
          <label className={styles.compactField} htmlFor={`studio-resolution-${module.id}`}><strong>分辨率</strong>
            <select id={`studio-resolution-${module.id}`} disabled={submitting || Boolean(pendingSubmission)} value={normalizeImageResolution(moduleModel, resolution)} onChange={event => setResolution(normalizeImageResolution(moduleModel, event.target.value))}>
              {(IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS[moduleModel as keyof typeof IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS] || ['1K', '2K']).map(option => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
        </div>
        {!IMAGE_STUDIO_MODEL_QUALITY_OPTIONS[moduleModel as keyof typeof IMAGE_STUDIO_MODEL_QUALITY_OPTIONS]?.some(option => option !== 'auto') && <p className={styles.muted}>当前模型不支持质量档位，按模型默认质量生成。</p>}
        <p className={styles.muted}>{moduleUnitCredits == null ? '当前模型积分单价尚未设置' : `每张 ${moduleUnitCredits} 积分 · 本次 ${moduleUnitCredits * (Number.isInteger(count) ? count : 0)} 积分`} · 上游成本 {providerCostUsd == null ? '待配置' : `$${providerCostUsd.toFixed(3)} / 张`}</p>
        <div className={styles.moduleQuickActions} aria-label="模板快捷设置">
          <button type="button" onClick={restoreDefaults}><RefreshCw size={16} />恢复默认</button>
          <button type="button" className={`${styles.primary} sd2-loading-surface`} data-busy={moduleSaving} disabled={moduleSaving || uploading || bannerUploading || !settingsDirty} onClick={() => void saveModule()}><Save size={16} />{templateWorkbench ? '保存设置' : '保存上下文'}</button>
          <button type="button" title={!contextEditable && !recoverableDraft ? '共享模板的内部配置只能由创建者另存；当前草稿仍可生成' : undefined} disabled={uploading || bannerUploading || submitting || (!recoverableDraft && (!contextEditable || !generationChanged || generationDraft === savedAsSignature))} className={recoverableDraft || (contextEditable && generationChanged && generationDraft !== savedAsSignature) ? styles.saveReady : ''} onClick={() => recoverableDraft ? restoreTemporaryDraft() : void saveAsPreset()}><Save size={16} />{recoverableDraft ? '恢复上一次' : templateWorkbench ? '另存为模板' : '另存为'}</button>
        </div>
        {saveStatus && <p role="status" className={styles.muted}>{saveStatus}</p>}
        {error && <p role="alert" className={styles.error}>{error}</p>}
        {pendingSubmission && <p className={styles.muted}>提交结果待确认，只查询原请求，不会再次生成。<button type="button" disabled={submitting} onClick={async () => {
          if ((await confirm('上次提交可能已受理。放弃核对后，再次生成会新建任务，可能再次产生上游费用。确定放弃核对吗？', { title: '放弃核对', confirmLabel: '放弃核对' }))) { setPendingSubmission(null); try { localStorage.removeItem(pendingKey); sessionStorage.removeItem(pendingKey); } catch {} }
        }}>放弃核对</button></p>}
        {!ready && !settingsError && <p className={styles.muted}>{!selectedProviderReady ? '图片服务尚未就绪' : '请管理员完成模型积分设置'}</p>}
      </section>
      <section className={styles.outputs} aria-label="生成结果">
        <header className={styles.header}><h2>生成结果</h2><div className={styles.counts}>
          {!downloadMode ? <button type="button" disabled={downloadBusy} onClick={() => { setSelected([]); setDownloadMode(true); }}><Download size={16} />下载</button> : <div className={styles.downloadModeBar}><span>已选 {selected.length} 张</span><button type="button" disabled={!selected.length || downloadBusy} onClick={() => void download(selected)}>{downloadBusy ? '准备中' : '确认下载'}</button><button type="button" disabled={downloadBusy} onClick={() => { setSelected([]); setDownloadMode(false); }}>取消</button></div>}
          <button type="button" title="刷新记录" aria-label="刷新记录" className={templateWorkbench ? 'sd2-loading-surface' : undefined} data-busy={templateWorkbench && taskReadAction === 'refresh'} disabled={templateWorkbench && taskReadAction !== 'idle'} onClick={() => void loadTasks()}><RefreshCw size={16} /></button>
        </div></header>
        {tasksError && <p role="alert" className={styles.error}>{tasksError}{templateWorkbench && <button type="button" disabled={taskReadAction !== 'idle'} onClick={() => void loadTasks(taskRetryCursor)}>重试读取记录</button>}</p>}
        {downloadReady && <p role="status">文件已准备好。<a href={downloadReady.url} download={downloadReady.name}>再次保存</a></p>}
        {loadingTasks && (tasks.length ? <LoadingStatus>正在更新生成记录</LoadingStatus> : <LoadingSkeleton label="正在读取生成记录" grid />)}
        {templateWorkbench && taskReadAction === 'refresh' && <LoadingStatus>正在刷新记录，已有图片仍保留</LoadingStatus>}
        {!loadingTasks && !tasks.length && !tasksError && <div className={styles.empty}>暂无生成记录</div>}
        <div className={styles.grid}>{tasks.map(task => <article key={task.id} className={styles.result}>
          <div className={styles.resultMedia} data-reaction-surface>{task.asset ? <>
            {task.asset.id && <div className={styles.resultReactions}><ContentReactions contentKey={`asset:${task.asset.id}`} overlay /></div>}
            <button type="button" className={styles.preview} aria-label="预览生成图片" onClick={() => openTaskPreview(task)}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img decoding="async" src={task.asset.thumbnail_url || undefined} alt={`生成结果 ${task.ordinal}`} loading="lazy" />
            </button>
            {downloadMode && <input className={styles.select} type="checkbox" aria-label={`选择第 ${task.ordinal} 张图片`} checked={selected.includes(task.id)} onChange={event => {
              if (event.target.checked && selected.length >= 8) { setError('每次最多下载 8 张'); return; }
              setSelected(current => event.target.checked ? [...current, task.id] : current.filter(id => id !== task.id));
            }} />}
          </> : <div className={`${styles.taskState} sd2-loading-surface`} data-busy={['queued', 'running'].includes(task.status)}>
            <span role="status">{studioTaskPhase(task)}</span>
            {['download', 'recover'].includes(task.delivery?.phase || '') && Number(task.delivery?.expectedBytes) > 0 && task.delivery?.receivedBytes != null && <span>{Math.min(100, Math.floor(task.delivery.receivedBytes / task.delivery.expectedBytes! * 100))}% 字节已接收</span>}
          </div>}<button type="button" className={styles.deleteResult} disabled={deleting || downloadBusy} title="删除生成记录" aria-label={`删除第 ${task.ordinal} 张生成记录`} onClick={() => { setDeleteError(''); setDeleteTarget(task); }}><Trash2 size={17} /></button></div>
          <div className={styles.resultHeading}>
            <p className={styles.prompt}>{name} · {task.ordinal}</p>
            <span className={styles.resultOwner} aria-label="生成者"><UserIdentityBadge user={task.owner} size="sm" className="asset-card-user" /></span>
          </div>
          <div className={styles.resultMeta}>
            <div className={styles.resultConfig}>
            <span title={IMAGE_STUDIO_MODEL_LABELS[task.model as keyof typeof IMAGE_STUDIO_MODEL_LABELS] || task.model}>{studioModelShortLabel(task.model)}</span>
            <span>·</span>
            <span>{IMAGE_STUDIO_QUALITY_LABELS[normalizeImageStudioQuality(task.model, task.quality) as keyof typeof IMAGE_STUDIO_QUALITY_LABELS] || task.quality || '自动'}</span>
            <span>·</span><span className={styles.resolutionHint} tabIndex={0} aria-describedby={`studio-size-${task.id}`}>
              {task.snapshot?.resolution && /^[124]K$/i.test(task.snapshot.resolution) ? task.snapshot.resolution : '自动'}
              <span id={`studio-size-${task.id}`} role="tooltip" className={styles.resolutionTooltip}>{task.asset?.width && task.asset.height ? `${task.asset.width} × ${task.asset.height} px` : '实际尺寸暂不可用'}</span>
            </span>
            </div>
            <RelativeTime className={styles.resultTime} value={task.createdAt} />
          </div>
          <div className={styles.resultActions}><div className={styles.resultCommands} data-needs-action={task.status === 'uncertain'}>
            {task.delivery?.recoveryAvailable && <button type="button" className={`${styles.recoveryAction} ${templateWorkbench ? 'sd2-loading-surface' : ''}`} data-busy={templateWorkbench && taskReadAction === 'refresh'} disabled={templateWorkbench && taskReadAction !== 'idle'} onClick={() => void loadTasks()}>{templateWorkbench ? '刷新恢复状态' : '查看原图恢复'}</button>}
            {task.asset && <button type="button" disabled={downloadBusy} title="下载图片" aria-label="下载图片" onClick={() => { setSelected([task.id]); setDownloadMode(true); }}><Download size={15} /></button>}
            {task.asset && <button type="button" className="sd2-loading-surface" data-busy={copyFeedback?.id === task.id && copyFeedback.text === '复制中…'} disabled={copyFeedback?.id === task.id && copyFeedback.text === '复制中…'} title="复制图片" aria-label="复制图片" onClick={() => void copyTaskImage(task)}><Clipboard size={15} /></button>}
            {task.snapshot && <button type="button" disabled={submitting || uploading || moduleSaving || ratioEditing || Boolean(pendingSubmission)} title="恢复本次输入设置，不会提交生成或扣积分" aria-label="恢复设置" onClick={() => restoreTask(task)}><RefreshCw size={15} />恢复设置</button>}
            {isAdmin && task.snapshot?.sourceAvailable && <button type="button" className="sd2-loading-surface" data-busy={copyFeedback?.id === task.id && copyFeedback.text === '复制中…'} disabled={copyFeedback?.id === task.id && copyFeedback.text === '复制中…'} title="复制上下文" aria-label="复制上下文" onClick={() => void copyTaskContext(task)}><Copy size={15} /></button>}
          </div>
          </div>{copyFeedback?.id === task.id && <span className={styles.copyFeedback} role="status" aria-live="polite">{copyFeedback.text}</span>}{task.error && <p className={styles.error}>{task.error}</p>}
          {task.delivery?.checkpointRetained && task.status === 'uncertain' && <p className={styles.muted}>恢复资料暂留供协查，已退款任务不能自动领取原图。请联系管理员。</p>}
          {(task.delivery?.upstreamRequestId || task.delivery?.validation) && <details className={styles.muted}><summary>交付详情</summary>
            {task.delivery.upstreamRequestId && <p>上游请求编号：{task.delivery.upstreamRequestId}</p>}
            {task.delivery.validation && <p>原图 {task.delivery.validation.originalFormat.toUpperCase()} · {task.delivery.validation.width} × {task.delivery.validation.height}；本站保存 PNG{task.delivery.validation.requestedSize ? `；请求 ${task.delivery.validation.requestedSize}` : ''}</p>}
          </details>}
        </article>)}</div>
        {templateWorkbench && taskReadAction === 'more' && <LoadingStatus>正在读取更多记录</LoadingStatus>}
        {nextCursor && <button type="button" className={templateWorkbench ? 'sd2-loading-surface' : undefined} data-busy={templateWorkbench && taskReadAction === 'more'} disabled={templateWorkbench && taskReadAction !== 'idle'} onClick={() => void loadTasks(nextCursor)}>加载更多</button>}
      </section>
    </div>
    <dialog ref={imageSourceDialog} className={`${styles.dialog} ${styles.sourceDialog}`} aria-label="添加图片">
      <header><h3>添加图片</h3><button type="button" aria-label="关闭" onClick={() => imageSourceDialog.current?.close()}><X size={18} /></button></header>
      <div className={styles.sourceActions}>
        <button type="button" onClick={() => { imageSourceDialog.current?.close(); (imageSourceTarget === 'banner' ? bannerFileInput : imageSourceTarget === 'fixed' ? fixedFileInput : imageSourceTarget === 'auxiliary' ? auxiliaryFileInput : fileInput).current?.click(); }}><ImagePlus size={18} />上传图片</button>
        <button type="button" onClick={() => { imageSourceDialog.current?.close(); setAssetPickerOpen(true); }}><ImagePlus size={18} />从资产库选择</button>
      </div>
    </dialog>
    {assetPickerOpen && <UploadedImagePicker open imageOnly selectionOnly
      portalContainer={imageSourceTarget === 'fixed' ? moduleDialog.current : undefined}
      currentCount={imageSourceTarget === 'banner' ? 0 : imageSourceTarget === 'fixed' ? fixedReferences.length : imageSourceTarget === 'auxiliary' ? auxiliaryImages.length : images.length}
      currentAssetIds={imageSourceTarget === 'banner' ? [] : (imageSourceTarget === 'fixed' ? fixedReferences : imageSourceTarget === 'auxiliary' ? auxiliaryImages : images).flatMap(image => image.id ? [image.id] : [])}
      maxSelection={imageSourceTarget === 'banner' ? 1 : imageSourceTarget === 'fixed' ? MAX_REFERENCE_IMAGES - fixedReferences.length : imageSourceTarget === 'auxiliary' ? Math.max(0, currentAuxiliaryCap - auxiliaryImages.length) : Math.max(0, currentReferenceCap - images.length)}
      onClose={() => setAssetPickerOpen(false)}
      onUploadFile={async () => { throw new Error('请从上传图片入口上传'); }}
      onConfirm={async (_ids, assets) => {
        if (submitting || pendingSubmission || uploading || bannerUploading) throw new Error('当前操作尚未结束，请稍后选择');
        const picked = (assets || []).filter(asset => asset.type === 'image' && asset.originalUrl);
        if (!picked.length || picked.length !== _ids.length) throw new Error('图片信息不完整，请重新选择');
        if (imageSourceTarget === 'banner') {
          if (picked.length !== 1) throw new Error('请选择一张图片');
          setBanner(picked[0]);
        } else if (imageSourceTarget === 'fixed') {
          const additions = picked.filter(asset => !fixedReferences.some(image => image.id === asset.id));
          if (fixedReferences.length + additions.length > MAX_REFERENCE_IMAGES) throw new Error(`固定参考图最多 ${MAX_REFERENCE_IMAGES} 张`);
          changeFixedReferences([...fixedReferences, ...additions.map(asset => ({ ...asset, note: '', available: true }))]);
        } else if (imageSourceTarget === 'auxiliary') {
          if (picked.some(asset => images.some(image => image.id === asset.id))) throw new Error('这张图片已是主图；需要改作辅助参考时，请使用主图上的下移按钮。');
          const additions = picked.filter(asset => !auxiliaryImages.some(image => image.id === asset.id));
          if (auxiliaryImages.length + additions.length > currentAuxiliaryCap) throw new Error(`本次最多选择 ${currentAuxiliaryCap} 张辅助参考图`);
          setAuxiliaryImages(current => [...current, ...additions]);
        } else {
          if (picked.some(asset => auxiliaryImages.some(image => image.id === asset.id))) throw new Error('这张图片已是辅助参考；需要改作主图时，请使用参考图上的上移按钮。');
          const additions = picked.filter(asset => !images.some(image => image.id === asset.id));
          if (images.length + additions.length > currentReferenceCap) throw new Error(`本次最多选择 ${currentReferenceCap} 张主图`);
          setImages(current => [...current, ...additions]);
        }
      }} />}
    <dialog ref={deleteDialog} className={styles.dialog} aria-labelledby={`delete-title-${module.id}`}>
      <h2 id={`delete-title-${module.id}`}>删除这张图片？</h2>
      <p>将从本模块的生成结果中移除，不退还已消耗积分。其他模块、参考图和已保存的副本不受影响。</p>
      {deleteError && <p role="alert" className={styles.error}>{deleteError}</p>}
      <div className={styles.resultActions}><button type="button" autoFocus disabled={deleting} onClick={() => setDeleteTarget(null)}>取消</button><button type="button" className={styles.danger} disabled={deleting} onClick={() => void deleteResult()}><Trash2 size={16} />{deleting ? '删除中' : '确认删除'}</button></div>
    </dialog>
    <dialog ref={moduleDialog} className={styles.dialog} onPaste={event => {
      if (!fixedEditable || assetPickerOpen || imageSourceDialog.current?.open) return;
      const files = Array.from(event.clipboardData.items).filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter((file): file is File => Boolean(file));
      if (files.length) { event.preventDefault(); event.stopPropagation(); void addImages(files, true); }
    }}>
      <header className={styles.header}><h2>模块上下文</h2><button type="button" aria-label="关闭模块上下文" onClick={closeModuleDialog}><X size={20} /></button></header>
      {contextEditable ? <textarea aria-label="模块上下文" rows={12} maxLength={20000} value={moduleContext} onChange={event => { if (reproduceSourceTaskId) exitReproductionMode('模块上下文已修改，已退出历史复现模式，接下来会使用新上下文。'); setModuleContext(event.target.value); setModuleSaveError(''); }} /> : <p className={styles.muted}>共享模板的内部上下文由创建者维护，生成时自动使用。</p>}
      <div className={styles.referenceLimits}>
        <label>主图最少 <select aria-label="主图最少张数" value={primaryMin} disabled={submitting || Boolean(pendingSubmission)} onChange={event => setPrimaryMin(Number(event.target.value))}>
          {Array.from({ length: referenceLimit + 1 }, (_, value) => <option key={value} value={value}>{value} 张</option>)}
        </select></label>
        <label>主图最多 <select aria-label="模板主图最多张数" value={referenceLimit} disabled={submitting || Boolean(pendingSubmission)} onChange={event => {
          const next = Number(event.target.value);
          if (next < primaryMin || next < images.length) { setError('主图上限不能低于最少要求或已选张数。'); return; }
          setReferenceLimit(next);
        }}>{Array.from({ length: MAX_REFERENCE_IMAGES }, (_, index) => index + 1).map(value => <option key={value} value={value}>{value} 张</option>)}</select></label>
        <label>风格图片最多 <select aria-label="模板风格图片最多张数" value={styleLimit} disabled={submitting || Boolean(pendingSubmission)} onChange={event => setStyleLimit(Number(event.target.value))}>
          {Array.from({ length: MAX_REFERENCE_IMAGES + 1 }, (_, value) => <option key={value} value={value}>{value} 张</option>)}
        </select></label>
        <label>参考图最多 <select aria-label="模板参考图最多张数" value={referenceImageLimit} disabled={submitting || Boolean(pendingSubmission)} onChange={event => setReferenceImageLimit(Number(event.target.value))}>
          {Array.from({ length: MAX_REFERENCE_IMAGES + 1 }, (_, value) => <option key={value} value={value}>{value} 张</option>)}
        </select></label>
        <label>辅助参考总上限 <select aria-label="模板辅助参考总上限" value={auxiliaryLimit} disabled={submitting || Boolean(pendingSubmission)} onChange={event => setAuxiliaryLimit(Number(event.target.value))}>
          {Array.from({ length: MAX_REFERENCE_IMAGES + 1 }, (_, value) => <option key={value} value={value}>{value} 张</option>)}
        </select></label>
      </div>
      <div className={styles.imageSectionHeading}><label className={styles.referenceToggle}><input type="checkbox" checked={useFixedReferences} disabled={submitting || Boolean(pendingSubmission)} onChange={event => setUseFixedReferences(event.target.checked)} />使用模板固定参考图</label>
        <button type="button" disabled={uploading || submitting || Boolean(pendingSubmission) || !auxiliaryCount} onClick={clearAllReferences}><X size={15} />一键清空参考</button></div>
      {isAdmin && <><label className={styles.label}>固定模板图 <span>{fixedReferences.length}/{MAX_REFERENCE_IMAGES}</span></label>
      <div onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void addImages(Array.from(event.dataTransfer.files), true); }}>
        <StudioReferenceGrid items={fixedReferences} onChange={changeFixedReferences} onPreview={previewReference} compact labels="template" notes
          disabled={!fixedEditable || uploading || moduleSaving || submitting || Boolean(pendingSubmission)}>
          {fixedEditable && fixedReferences.length < MAX_REFERENCE_IMAGES && <button type="button" className={styles.add} disabled={uploading || moduleSaving || submitting || Boolean(pendingSubmission)} onClick={() => openImageSource('fixed')}><ImagePlus size={20} />添加图片</button>}
        </StudioReferenceGrid>
      </div>
      <input ref={fixedFileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={event => { void addImages(Array.from(event.target.files || []), true); event.target.value = ''; }} /></>}
      <StudioStyleGroups userId={userId} selected={activeStyles} currentImages={auxiliaryImages} maxReferences={currentStyleCap}
        disabled={uploading || submitting || Boolean(pendingSubmission)}
        onChange={next => { if (reproduceSourceTaskId) exitReproductionMode('风格组已修改，接下来使用当前模板和风格组。'); setStyleGroups(next); }} />
      {uploadProgress && <UploadProgressIndicator busy {...uploadProgress} />}
      {error && <p role="status" className={styles.error}>{error}</p>}
      <div className={styles.modelQualityRow}>
        <label className={styles.compactField} htmlFor={`studio-module-model-${module.id}`}><strong>模块模型</strong>
          <select id={`studio-module-model-${module.id}`} value={moduleModel} onChange={event => { const next = event.target.value; setModuleModel(next); setQuality(defaultImageStudioQuality(next)); setResolution(defaultImageResolution(next)); }}>
            {models.map(model => <option key={model} value={model}>{IMAGE_STUDIO_MODEL_LABELS[model]}</option>)}
          </select>
        </label>
        <label className={styles.compactField} htmlFor={`studio-module-resolution-${module.id}`}><strong>模块分辨率</strong>
          <select id={`studio-module-resolution-${module.id}`} value={normalizeImageResolution(moduleModel, resolution)} onChange={event => setResolution(normalizeImageResolution(moduleModel, event.target.value))}>
            {(IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS[moduleModel as keyof typeof IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS] || ['1K', '2K']).map(option => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <label className={styles.compactField} htmlFor={`studio-module-quality-${module.id}`}><strong>图片质量</strong>
          <select id={`studio-module-quality-${module.id}`} value={normalizeImageStudioQuality(moduleModel, quality)} onChange={event => setQuality(event.target.value)}>
            {(IMAGE_STUDIO_MODEL_QUALITY_OPTIONS[moduleModel as keyof typeof IMAGE_STUDIO_MODEL_QUALITY_OPTIONS] || ['auto']).map(option => <option key={option} value={option}>{IMAGE_STUDIO_QUALITY_LABELS[option]}</option>)}
          </select>
        </label>
      </div>
      {contextEditable && <button type="button" className={`${styles.primary} sd2-loading-surface`} data-busy={moduleSaving} disabled={moduleSaving || uploading || bannerUploading || !settingsDirty} onClick={() => void saveModule()}><Save size={16} />{templateWorkbench ? '保存模块设置' : '保存模板设置'}</button>}
      <p role="status">{moduleSaving ? '正在保存' : settingsDirty ? '上下文未保存' : generationChanged ? '生成参数为临时草稿' : '已保存'}</p>
      {moduleSaveError && <p role="alert" className={styles.error}>{moduleSaveError}<button onClick={() => void saveModule()}>重试保存</button></p>}
    </dialog>
    {preview && <ZoomableImagePreview contentKey={preview.contentKey} src={preview.src} alt={preview.alt} title={preview.title} previewKey={preview.taskId || preview.src} fileName={preview.fileName} safeDetails={{ ...preview.metadata, width: preview.width, height: preview.height }} comparison={preview.comparison} hasNavigation={Boolean(preview.taskId && previewableTasks.length > 1)} onPrevious={() => movePreview(-1)} onNext={() => movePreview(1)} onClose={() => { setPreview(null); if (resumeModulePreview.current) { resumeModulePreview.current = false; moduleDialog.current?.showModal(); } }} />}
  </section>)}</>;
}
