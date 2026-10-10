'use client';
import { LoadingSkeleton, LoadingStatus } from '@/components/LoadingState';

import { useProductDialog } from '@/components/useProductDialog';
import { saveMainImageReminder, skipMainImageReminder } from './main-image-reminder';
import { ContextClipboardActions } from '@/components/ContextClipboardActions';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Heart, ChevronFirst, ChevronLast, ChevronLeft, ChevronDown, ChevronRight, Copy, Download, Eye, ImagePlus, Settings, X, RefreshCw, RotateCcw, LoaderCircle, Plus, Save, Trash2, Pencil, FolderCog } from 'lucide-react';
import { useResultPages } from '@/components/useResultPages';
import { ContextVersionLabel, useModuleContextVersion } from './context-version-label';
import { uploadFileAsAsset, type UploadedAssetPayload, type UploadProgressSnapshot } from '@/lib/http/file-upload';
import { UploadProgressIndicator } from '@/components/UploadProgressIndicator';
import { UploadedImagePicker } from '@/components/UploadedImagePicker';
import { useRememberedScroll } from '@/lib/hooks/use-remembered-scroll';
import { scrollToWorkbenchHeader } from '@/lib/navigation/scroll-to-workbench-header';
import { replaceImageModuleLocation } from '@/lib/navigation/image-module-location';
import { GeneratedImageResults, type GeneratedImageResult } from '@/components/GeneratedImageResults';
import { useLikedStudioResults } from './liked-results';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { RelativeTime } from '@/components/RelativeTime';
import { useUnsavedNavigation } from '@/lib/hooks/use-unsaved-navigation';

import { ModuleGroupPicker } from './group-picker';
import { TemplateFavoritesList, useTemplateFavorites } from './template-favorites';
import { tryContentKeyParts } from '@/lib/content-reactions/key';
import type { ReactionListItem } from '@/lib/content-reactions/types';

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
import { ZoomableImagePreview, type ImagePreviewMetadata, type ImageComparisonSource } from '@/components/ZoomableImagePreview';
import UserIdentityBadge from '@/components/UserIdentityBadge';

import TemplateFavoriteTitle from '@/components/content-reactions/TemplateFavoriteTitle';

import { studioResultVersion } from '@/lib/image-studio/result-attention';
import { useResultAttention } from './use-result-attention';
import styles from './studio.module.css';
import { StudioReferenceGrid, type FixedStudioReference } from './reference-grid';
import { RatioPicker } from './ratio-picker';
import { useStudioSettings } from './use-studio-settings';
import { StudioGlobalSettingsDialog } from './global-settings-dialog';
import { StudioSkills, type SkillSummary } from './skills-view';
import { StudioStyleGroups, type StudioStyleSummary } from './style-groups-view';
import type { SettingsValue } from './settings-controller';
import { parseStudioTemplateDefaults } from '@/lib/image-studio/template-defaults';
import { normalizeStudioRatio, resolveStudioAspectRatio } from '@/lib/image-studio/ratios';
import { studioFourToOneIssue } from '@/lib/image-generation/resolution';
import { useStudioBatch } from './use-studio-batch';
import { BatchResults } from './batch-results';
import { watchGenerationCompletion } from '@/components/GenerationCompletion';
import { handImageDownloadToBrowser } from '@/lib/media/native-download';
import { describedEvolutionDirection, type EvolutionCapability, type EvolutionInput } from '@/lib/image-studio/evolution';
import { DEFAULT_STUDIO_PRIMARY_MAX, MAX_REFERENCE_IMAGES } from '@/lib/image-studio/limits';
import type { ImageBillingView } from '@/lib/image-studio/billing-contract';
import { useImageBillingRefresh } from '@/lib/hooks/use-image-billing-refresh';
import type { StudioReferencePolicy } from '@/lib/image-studio/reference-policy';
import { IMAGE_STUDIO_MODELS, IMAGE_STUDIO_MODEL_LABELS, IMAGE_STUDIO_MODEL_SHORT_LABELS, IMAGE_STUDIO_MODEL_QUALITY_OPTIONS, IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS, IMAGE_STUDIO_QUALITY_LABELS, defaultImageResolution, defaultImageStudioQuality, normalizeImageResolution, normalizeImageStudioQuality, type ImageResolution } from '@/lib/image-studio/model-catalog';

type StudioSnapshot = { referencePolicy?: StudioReferencePolicy; primaryReferenceImages?: UploadedAssetPayload[]; auxiliaryReferenceImages?: UploadedAssetPayload[]; prompt: string; model: string; quality?: string; resolution?: string | null; count: number; aspectRatio: string; resolvedAspectRatio?: string; aspectRatioSource?: string; outputSize?: string | null; resolvedOutputSize?: string | null; globalContext?: string; moduleContext?: string; unitCredits?: number | null; sourceAvailable?: boolean; contextAvailable?: boolean; contextConfigured?: boolean; referenceImages: UploadedAssetPayload[]; fixedReferenceImages?: FixedStudioReference[]; transientReferenceImages?: UploadedAssetPayload[]; fixedReferenceCount?: number; styleGroupIds?: string[]; styleGroups?: StudioStyleSummary[]; skills?: SkillSummary[]; skillIds?: string[] };
type StudioTask = { id: string; batchId: string; ordinal: number; owner?: { id: string; name: string; avatar_url: string | null } | null; prompt: string; model: string; quality?: string; status: string; error?: string; unitCredits: number; billing?: ImageBillingView | null; referenceIds: string[]; aspectRatio: string; outputSize?: string; createdAt: string; finishedAt?: string | null; snapshot?: StudioSnapshot & { moduleContextVersion?: string | null; moduleContextVersionState?: string }; delivery?: { phase: string; receivedBytes?: number; expectedBytes?: number; recoveryAvailable: boolean; checkpointRetained: boolean; requestId?: string; upstreamRequestId?: string; validation?: { originalFormat: string; storedFormat: string; width: number; height: number; requestedSize?: string } }; asset: { id?: string; original_url: string; thumbnail_url?: string; width?: number; height?: number; file_size?: number } | null };
function studioTaskHasDeliveredAsset(task: StudioTask): task is StudioTask & { asset: NonNullable<StudioTask['asset']> } {
  return task.status === 'succeeded' && Boolean(task.asset?.original_url);
}
function studioTaskPhase(task: StudioTask) {
  if (['cancelled', 'canceled'].includes(task.status)) return '已取消';
  if (task.status === 'failed') return task.delivery?.phase === 'stopped' ? '原图交付停止' : '未能交付图片';
  const phase = task.delivery?.phase;
  return ({ queued: '等待生成', provider: '生成中', unknown: '生成结果待确认', download: '原图下载中', recover: '恢复原图中', validate: '图片校验中', save: '保存中', stopped: '原图交付停止', failed: '未能交付图片', ready: studioTaskHasDeliveredAsset(task) ? '已完成' : task.status === 'succeeded' ? '图片已移除' : '生成结果待确认' } as Record<string, string>)[phase || '']
    || (task.status === 'running' ? '生成中' : task.status === 'queued' ? '等待生成' : task.status === 'uncertain' ? '生成结果待确认' : '未能交付图片');
}
type StudioModule = { referencePolicy?: StudioReferencePolicy; id: string; name: string; prompt: string; context?: string; contextConfigured: boolean; count: number; referenceLimit: number; aspectRatio: string; resolution: ImageResolution; model: string; quality: string; groupName: string; banner: UploadedAssetPayload | null; cover?: { resultUrl: string; thumbnailUrl?: string | null; referenceUrl?: string | null } | null; prices: Record<string, number | null>; unitCredits: number | null; reproduceFromTaskId: string | null; sourcePresetId?: string | null; sourcePresetShared?: boolean | null; sourcePresetOwnedByViewer?: boolean; sourcePresetCanManageSharing?: boolean; images: UploadedAssetPayload[]; revision: number; saved: boolean; createdAt: string; fixedReferenceCount?: number; fixedReferencesEditable?: boolean; styleGroupIds?: string[]; styleGroups?: StudioStyleSummary[]; skills?: SkillSummary[]; skillIds?: string[]; reproductionState?: { fixedReferenceCount: number; styleGroups: StudioStyleSummary[] } | null };
type StudioPreset = { id: string; name: string; revision: string; moduleContextVersion?: string | null; scope: 'admin' | 'creator'; isShared: boolean; canManageSharing?: boolean; ownedByViewer?: boolean; groupName: string; model: string; quality: string; resolution: ImageResolution; count: number; referenceLimit: number; aspectRatio: string; images: UploadedAssetPayload[]; banner: UploadedAssetPayload | null; contextConfigured: boolean; createdAt: string };
type QuickStudioPreset = StudioPreset & { prompt: string; context: string; referencesAvailable: boolean; referencePolicy?: StudioReferencePolicy; fixedReferences?: FixedStudioReference[]; styleGroupIds: string[] };
type PresetSource = { draft: Record<string, unknown>; blocked: string | null; groupDeleteBlocked?: boolean };
type PresetSourceReader = () => PresetSource;
type StudioFeedback = { message: string; tone: 'progress' | 'info' | 'success' | 'warning' | 'error' };
type StudioImageQuote = { billingMode: 'fixed' | 'actual'; billingQuoteId: string | null; unitCredits: number; estimatedCredits: number; expiresAt?: string };
type CachedStudioImageQuote = { signature: string; requestId: string; quote: StudioImageQuote };
type ImagePreviewState = { contentKey?: `asset:${string}`; taskId?: string; resultVersion?: string | null; src: string; thumbnailSrc?: string; alt: string; title?: string; fileName?: string; width?: number; height?: number; fileSize?: number; metadata?: ImagePreviewMetadata; comparison?: ImageComparisonSource };
type RatioPreferences = { custom: string[]; busy: boolean; error: string; onRetry: () => void; onCustom: (ratio: string, remove: boolean) => Promise<boolean> };
type ModuleScrollRequest = { target: 'module' | 'header'; id: string; group: string; token: number; behavior: ScrollBehavior; markViewed: boolean; expansionRevision?: number };
type ModuleNavigationOptions = { ensureLoaded?: boolean; markViewed?: boolean; behavior?: ScrollBehavior; expandParents?: boolean };
const models = IMAGE_STUDIO_MODELS;
const fixedReferencePayload = (items: FixedStudioReference[]) => items.map(item => ({ assetId: item.id, note: item.note || '' }));
const DEFAULT_GROUPS = ['未分组', '常用', '角色', '场景', '海报'];
function moduleReferencePolicy(module: StudioModule): StudioReferencePolicy {
  const policy = module.referencePolicy;
  return { primaryIds: policy?.primaryIds ?? module.images.flatMap(image => image.id ? [image.id] : []),
    primaryMin: policy?.primaryMin ?? 0, primaryMax: policy?.primaryMax ?? (module.referenceLimit || DEFAULT_STUDIO_PRIMARY_MAX),
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
  return src ? { src, thumbnailSrc: reference.thumbnailUrl || src, alt: '主图 1', fileName: reference.fileName || undefined, width: reference.width || undefined, height: reference.height || undefined, fileSize: reference.fileSize, ...(reference.id ? { contentKey: `asset:${reference.id}` as const } : {}) } : undefined;
}

function taskComparisonCandidates(task?: StudioTask): ImageComparisonSource[] {
  const snapshot = task?.snapshot;
  const references = [...(snapshot?.primaryReferenceImages ?? snapshot?.transientReferenceImages ?? snapshot?.referenceImages ?? []),
    ...(snapshot?.auxiliaryReferenceImages || []), ...(snapshot?.fixedReferenceImages || [])];
  return references.flatMap((image, index) => image.originalUrl ? [{ src: image.originalUrl, thumbnailSrc: image.thumbnailUrl || undefined, alt: `参考图 ${index + 1}`, width: image.width || undefined, height: image.height || undefined, fileSize: image.fileSize, ...(image.id ? { contentKey: `asset:${image.id}` as const } : {}) }] : []);
}

function studioTaskPreviewState(task: StudioTask): ImagePreviewState {
  const snapshot = task.snapshot;
  const model = studioModelShortLabel(task.model);
  const quality = IMAGE_STUDIO_QUALITY_LABELS[normalizeImageStudioQuality(task.model, task.quality) as keyof typeof IMAGE_STUDIO_QUALITY_LABELS] || task.quality || '自动';
  return {
    taskId: task.id,
    resultVersion: studioResultVersion(task),
    contentKey: task.asset?.id ? `asset:${task.asset.id}` : undefined,
    src: task.asset?.original_url || '',
    thumbnailSrc: task.asset?.thumbnail_url,
    alt: `生成结果 ${task.ordinal}`,
    title: `生成结果 ${task.ordinal}`,
    width: task.asset?.width, height: task.asset?.height, fileSize: task.asset?.file_size,
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

export default function ImageStudio({ isAdmin, userId, templateWorkbench = false, favoritesRequest = 0 }: { isAdmin: boolean; userId: string; templateWorkbench?: boolean; favoritesRequest?: number }) {
  const router = useRouter();
  const routeQuery = useSearchParams()?.toString() || '';
  const routedContentHandled = useRef('');
  const sidebarInteraction = useRef(0);
  const { confirm, prompt: askPresetName, productDialog } = useProductDialog();
  const presetSources = useRef(new Map<string, PresetSourceReader>());
  const registerPresetSource = useCallback((id: string, read: PresetSourceReader | null) => {
    if (read) presetSources.current.set(id, read); else presetSources.current.delete(id);
  }, []);
  const [presetSourceId, setPresetSourceId] = useState('');
  const [presetManaging, setPresetManaging] = useState(false);
  const presetManagementLock = useRef(false);
  const [modules, setModules] = useState<StudioModule[]>([]);
  const [directory, setDirectory] = useState<Array<Pick<StudioModule, 'id' | 'name' | 'groupName' | 'sourcePresetId'>>>([]);
  const [directoryReady, setDirectoryReady] = useState(false);
  const removedModuleIds = useRef(new Set<string>());
  const moduleReadScope = useRef({ owner: userId, generation: 0 });
  if (moduleReadScope.current.owner !== userId) moduleReadScope.current = { owner: userId, generation: moduleReadScope.current.generation + 1 };
  const hydratingIds = useRef(new Set<string>());
  const [hydrating, setHydrating] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [active, setActive] = useState('');
  const attention = useResultAttention(userId, templateWorkbench);
  const [requestedView, setRequestedView] = useState({ viewerId: userId, moduleId: '', token: 0 });
  const viewSequence = useRef(0);
  const [selectedGroup, setSelectedGroup] = useState('');
  const [coverView, setCoverView] = useState(false);
  const viewStorageKey = templateWorkbench ? `sd2-template-studio:image-view:v1:${userId}` : `sd2-studio-view:${userId}`;
  const [restoredViewKey, setRestoredViewKey] = useState('');
  const viewRestored = restoredViewKey === viewStorageKey;
  const [expandedGroups, setExpandedGroups] = useState<string[]>([]);
  const [imageGenerationExpanded, setImageGenerationExpanded] = useState(false);
  const [favoritesExpanded, setFavoritesExpanded] = useState(false), [selectedFavorite, setSelectedFavorite] = useState('');
  const favorites = useTemplateFavorites(userId, templateWorkbench && viewRestored && favoritesExpanded);
  const [favoriteSelecting, setFavoriteSelecting] = useState(false);
  const favoriteOpenRequest = useRef(0), routeFavoritesHandled = useRef(false);
  const [pendingModuleScroll, setPendingModuleScroll] = useState<ModuleScrollRequest | null>(null);
  const moduleScrollSequence = useRef(0);
  const pageRef = useRef<HTMLElement>(null);
  const mobileModuleNavRef = useRef<HTMLElement>(null);
  useRememberedScroll(`image-studio:${userId}`, viewRestored, { skipRestore: typeof window !== 'undefined' && Boolean(new URLSearchParams(window.location.search).get('moduleId')) });
  useEffect(() => {
    const readView = (storage: Storage, key: string) => {
      try {
        const view = JSON.parse(storage.getItem(key) || 'null');
        return view && typeof view === 'object' && !Array.isArray(view)
          && (typeof view.group === 'string' || typeof view.active === 'string' || typeof view.coverView === 'boolean') ? view : null;
      } catch { return null; }
    };
    let view = null;
    try {
      view = templateWorkbench ? readView(localStorage, viewStorageKey) : readView(sessionStorage, viewStorageKey);
      if (templateWorkbench && !view) view = readView(sessionStorage, `sd2-studio-view:${userId}`);
    } catch { /* Unavailable storage must not block editing. */ }
    if (templateWorkbench) {
      const savedGroup = typeof view?.group === 'string' && view.group.length <= 120 ? view.group : '';
      const savedActive = typeof view?.active === 'string' && view.active.length <= 200 ? view.active : '';
      const hasExpandedGroups = Array.isArray(view?.expandedGroups);
      setSelectedGroup(savedGroup);
      setActive(savedActive);
      setCoverView(typeof view?.coverView === 'boolean' ? view.coverView : false);
      const savedGroups = hasExpandedGroups
        ? view.expandedGroups.filter((group: unknown): group is string => typeof group === 'string' && group.length > 0 && group.length <= 120).slice(0, 100)
        : savedGroup ? [savedGroup] : [];
      setExpandedGroups(savedGroups);
      setImageGenerationExpanded(typeof view?.imageGenerationExpanded === 'boolean' ? view.imageGenerationExpanded : savedGroups.length > 0 || (!hasExpandedGroups && Boolean(savedActive)));
      setFavoritesExpanded(view?.favoritesExpanded === true);
      setSelectedFavorite(typeof view?.selectedFavorite === 'string' && /^[a-z_]+:[A-Za-z0-9_-]+$/.test(view.selectedFavorite) ? view.selectedFavorite : '');
    } else {
      if (typeof view?.group === 'string') setSelectedGroup(view.group);
      if (typeof view?.active === 'string') setActive(view.active);
    }
    setRestoredViewKey(viewStorageKey);
  }, [userId, templateWorkbench, viewStorageKey]);
  useEffect(() => {
    if (!viewRestored) return;
    try {
      const storage = templateWorkbench ? localStorage : sessionStorage;
      storage.setItem(viewStorageKey, JSON.stringify({ group: selectedGroup, active, ...(templateWorkbench ? { coverView, expandedGroups, imageGenerationExpanded, favoritesExpanded, selectedFavorite } : {}) }));
    } catch {}
  }, [viewRestored, viewStorageKey, selectedGroup, active, coverView, expandedGroups, imageGenerationExpanded, favoritesExpanded, selectedFavorite, templateWorkbench]);
  useEffect(() => {
    if (!viewRestored || !templateWorkbench) return;
    const fromRoute = new URLSearchParams(routeQuery).get('favorites') === '1';
    if (favoritesRequest !== favoriteOpenRequest.current || fromRoute && !routeFavoritesHandled.current) setFavoritesExpanded(true);
    favoriteOpenRequest.current = favoritesRequest;
    if (fromRoute) routeFavoritesHandled.current = true;
  }, [favoritesRequest, viewRestored, templateWorkbench, routeQuery]);
  const updateNavigationOffset = useCallback(() => {
    const page = pageRef.current;
    if (!page) return;
    const nav = mobileModuleNavRef.current;
    const visible = nav && window.getComputedStyle(nav).display !== 'none';
    const height = visible ? Math.ceil(nav.getBoundingClientRect().height) : 0;
    page.style.setProperty('--template-mobile-nav-height', `${height}px`);
  }, []);
  useLayoutEffect(() => {
    if (!templateWorkbench || !pageRef.current) return;
    const page = pageRef.current;
    const nav = mobileModuleNavRef.current;
    updateNavigationOffset();
    const observer = nav && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateNavigationOffset) : null;
    if (nav) observer?.observe(nav);
    window.addEventListener('resize', updateNavigationOffset);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateNavigationOffset);
      page.style.removeProperty('--template-mobile-nav-height');
    };
  }, [templateWorkbench, updateNavigationOffset]);
  const [coverRetry, setCoverRetry] = useState(0);
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
  const [quickPresetVersion, setQuickPresetVersion] = useState(0);
  const [quickLinkingId, setQuickLinkingId] = useState<string | null>(null);
  useEffect(() => { if (presetDialogOpen) presetDialog.current?.showModal(); else presetDialog.current?.close(); }, [presetDialogOpen]);
  useDialogDismiss({ open: presetDialogOpen, dialogRef: presetDialog, nativeDialog: true, onDismiss: () => { if (!quickLinkingId && !presetApplying && !presetManagementLock.current) setPresetDialogOpen(false); } });
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
  const createId = useRef<string | null>(null);
  const createLock = useRef(false);
  const listLock = useRef(false);
  useEffect(() => {
    listLock.current = false; removedModuleIds.current.clear(); hydratingIds.current.clear();
    setModules([]); setDirectory([]); setDirectoryReady(false); setCursor(null); setActive('');
  }, [userId]);
  const loadModules = useCallback(async (next?: string) => {
    if (listLock.current) return;
    listLock.current = true; setLoading(true); setError('');
    const scope = moduleReadScope.current;
    try {
      const data = await readResponse(await fetch(`/api/image-studio/modules${next ? `?cursor=${encodeURIComponent(next)}` : ''}`, { cache: 'no-store' }));
      if (moduleReadScope.current !== scope) return;
      if (Array.isArray(data.directory)) {
        setDirectory(data.directory.filter((item: StudioModule) => !removedModuleIds.current.has(item.id)));
        setDirectoryReady(true);
      }
      setModules(current => {
        const ids = new Set(current.map(item => item.id));
        return [...current, ...data.modules.filter((item: StudioModule) => !ids.has(item.id) && !removedModuleIds.current.has(item.id))]
          .sort((a, b) => Number(b.id === `default-${userId}`) - Number(a.id === `default-${userId}`)
            || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id.localeCompare(b.id));
      });
      setCursor(data.nextCursor); setActive(current => current || data.modules[0]?.id || '');
    } catch (e) { if (moduleReadScope.current === scope) setError(e instanceof Error ? e.message : '模块读取失败'); }
    finally { if (moduleReadScope.current === scope) { listLock.current = false; setLoading(false); } }
  }, [userId]);
  useEffect(() => { void loadModules(); }, [loadModules]);
  const hydrateModules = useCallback(async (ids: string[]) => {
    const requested = ids.filter(id => !hydratingIds.current.has(id)).slice(0, 12);
    if (!requested.length) return;
    requested.forEach(id => hydratingIds.current.add(id));
    setHydrating(true);
    const scope = moduleReadScope.current;
    try {
      const data = await readResponse(await fetch(`/api/image-studio/modules?ids=${encodeURIComponent(requested.join(','))}`, { cache: 'no-store' }));
      if (moduleReadScope.current !== scope) return;
      const returnedIds = new Set<string>(data.modules.map((item: StudioModule) => item.id));
      setDirectory(current => current.filter(item => !requested.includes(item.id) || returnedIds.has(item.id)));
      setModules(current => {
        const existing = new Set(current.map(item => item.id));
        return [...current, ...data.modules.filter((item: StudioModule) => !existing.has(item.id) && !removedModuleIds.current.has(item.id))];
      });
      setError('');
    } catch (cause) { if (moduleReadScope.current === scope) setError(cause instanceof Error ? cause.message : '模块读取失败，请重试'); }
    finally { if (moduleReadScope.current === scope) { requested.forEach(id => hydratingIds.current.delete(id)); setHydrating(hydratingIds.current.size > 0); } }
  }, [userId]);
  const navigateToModule = useCallback((group: string, id: string, options: ModuleNavigationOptions = {}) => {
    replaceImageModuleLocation(id);
    routedContentHandled.current = `${userId}:${window.location.search}`;
    setError('');
    setCoverView(false);
    setSelectedGroup(group);
    setActive(id);
    if (options.expandParents !== false) {
      setExpandedGroups(current => current.includes(group) ? current : [...current, group]);
      setImageGenerationExpanded(true);
    }
    if (options.markViewed === false) setRequestedView({ viewerId: userId, moduleId: '', token: 0 });
    setPendingModuleScroll({ target: 'module', id, group, token: ++moduleScrollSequence.current, behavior: options.behavior || 'smooth', markViewed: templateWorkbench && options.markViewed !== false, expansionRevision: options.expandParents === false ? -1 : sidebarInteraction.current });
    if (options.ensureLoaded !== false && !modules.some(module => module.id === id)) void hydrateModules([id]);
  }, [hydrateModules, modules, templateWorkbench, userId]);
  useEffect(() => {
    if (loading || !viewRestored) return;
    const routeKey = `${userId}:${window.location.search}`;
    if (routedContentHandled.current === routeKey) return;
    const params = new URLSearchParams(window.location.search);
    const moduleId = params.get('moduleId');
    const presetId = params.get('presetId');
    if (moduleId) {
      const target = directory.find(item => item.id === moduleId);
      if (target) {
        navigateToModule(target.groupName || '未分组', moduleId, { behavior: 'auto', markViewed: false, expandParents: sidebarInteraction.current === 0 });
      } else {
        routedContentHandled.current = routeKey;
        setError('指定的图片模板不存在或当前不可用');
      }
    } else if (presetId) {
      routedContentHandled.current = routeKey;
      void openPresetLibrary();
    } else {
      routedContentHandled.current = routeKey;
      if (params.get('view') === 'covers') setCoverView(true);
    }
  }, [directory, loading, navigateToModule, routeQuery, userId, viewRestored]);
  async function createModule() {
    if (createLock.current) return;
    createLock.current = true; setCreating(true); setError('');
    createId.current ||= crypto.randomUUID();
    try {
      const workspace: StudioModule = await readResponse(await fetch('/api/image-studio/modules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: createId.current, groupName: selectedGroup || '未分组' }) }));
      setModules(current => current.some(item => item.id === workspace.id) ? current : [...current, workspace]);
      navigateToModule(workspace.groupName || '未分组', workspace.id, { ensureLoaded: false, markViewed: false }); createId.current = null;
    } catch (e) { setError(e instanceof Error ? e.message : '新建失败'); }
    finally { createLock.current = false; setCreating(false); }
  }
  async function openPresetLibrary(sourceId?: string, requestedPresetId?: string) {
    setPresetSourceId(sourceId || active || '');
    setPresetDialogOpen(true); setPresetsLoading(true); setPresetsError('');
    try { const result = await readResponse(await fetch('/api/image-studio/presets', { cache: 'no-store' }));
      const requested = requestedPresetId || new URLSearchParams(window.location.search).get('presetId');
      const sorted = [...result.presets].sort((a, b) => Number(b.id === requested) - Number(a.id === requested));
      setPresets(sorted);
      if (requested && !sorted.some(item => item.id === requested)) setPresetsError('喜欢的模板已不可用或不再共享');
    }
    catch (e) { setPresetsError(e instanceof Error ? e.message : '模板读取失败'); }
    finally { setPresetsLoading(false); }
  }
  async function managePreset(preset: StudioPreset, action: 'rename' | 'replace' | 'delete') {
    if (!preset.ownedByViewer || presetManagementLock.current || presetApplying || quickLinkingId) return;
    presetManagementLock.current = true; setPresetManaging(true); setPresetsError('');
    const send = async (extra: Record<string, unknown> = {}) => {
      await readResponse(await fetch('/api/image-studio/presets', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...extra, action, presetId: preset.id, revision: preset.revision }) }));
      if (action === 'delete') setModules(current => current.map(item => item.sourcePresetId === preset.id ? { ...item, sourcePresetCanManageSharing: false } : item));
      setQuickPresetVersion(value => value + 1);
      await openPresetLibrary(presetSourceId);
    };
    try {
      if (action === 'rename') {
        await askPresetName('模板名称', preset.name, { title: '修改名称', confirmLabel: '保存名称', maxLength: 80, onSubmit: name => send({ name }) });
      } else if (action === 'delete') {
        await confirm(`删除设置模板“${preset.name}”？只移除这份配置与快捷入口，已生成图片、资产和历史记录都保留。已套用的模块设置与历史恢复不变，不再允许新套用。`,
          { title: '删除模板', confirmLabel: '删除模板', danger: true, onSubmit: () => send() });
      } else {
        const source = presetSources.current.get(presetSourceId)?.();
        if (!source || source.blocked) throw new Error(source?.blocked || '请先选择一个已加载的模块');
        const sourceName = modules.find(item => item.id === presetSourceId)?.name || '所选模块';
        await confirm(`用“${sourceName}”当前的参数、参考图与模块上下文更新“${preset.name}”？名称与共享范围不变，旧结果与历史记录不变。`,
          { title: '更新模板', confirmLabel: '更新设置', onSubmit: () => send({ ...source.draft, name: preset.name }) });
      }
    } catch (cause) { setPresetsError(cause instanceof Error ? cause.message : '模板修改失败，请重新读取后重试'); }
    finally { presetManagementLock.current = false; setPresetManaging(false); }
  }
  async function applyPreset(preset: StudioPreset) {
    if (presetApplyLock.current || presetManagementLock.current) return;
    presetApplyLock.current = true; setPresetApplying(true); setPresetsError('');
    try {
      const created: StudioModule = await readResponse(await fetch('/api/image-studio/presets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'apply', presetId: preset.id }) }));
      setModules(current => [created, ...current.filter(item => item.id !== created.id)]); setPresetDialogOpen(false);
      navigateToModule(created.groupName || '未分组', created.id, { ensureLoaded: false, markViewed: false });
    } catch (e) { setPresetsError(e instanceof Error ? e.message : '应用模板失败'); }
    finally { presetApplyLock.current = false; setPresetApplying(false); }
  }
  async function togglePresetSharing(preset: StudioPreset) {
    if (!preset.canManageSharing || presetSharingId || presetManagementLock.current) return;
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
  async function addPresetShortcut(preset: StudioPreset) {
    if (!active || quickLinkingId || !preset.ownedByViewer || presetManagementLock.current) return;
    setQuickLinkingId(preset.id); setPresetsError('');
    try {
      await readResponse(await fetch('/api/image-studio/presets', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add-quick', moduleId: active, presetId: preset.id }) }));
      setQuickPresetVersion(current => current + 1); setPresetDialogOpen(false);
    } catch (cause) { setPresetsError(cause instanceof Error ? cause.message : '快捷模板添加失败'); }
    finally { setQuickLinkingId(null); }
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
    return Array.from(items.values()).sort((a, b) => Number(b.id === `default-${userId}`) - Number(a.id === `default-${userId}`));
  }, [directory, modules, userId]);
  const groupedModules = useMemo(() => navigation.reduce<Record<string, typeof navigation>>((groups, item) => {
    const group = item.groupName || '未分组';
    (groups[group] ||= []).push(item);
    return groups;
  }, {}), [navigation]);
  useEffect(() => {
    if (!viewRestored || !directoryReady || loading) return;
    const available = new Set(Object.keys(groupedModules));
    setExpandedGroups(current => {
      const valid = current.filter(group => available.has(group));
      return valid.length === current.length ? current : valid;
    });
  }, [viewRestored, directoryReady, loading, groupedModules]);
  const hasAnyUnread = useMemo(() => navigation.some(item => attention.unread.has(item.id)), [navigation, attention.unread]);
  const updateModuleMetadata = useCallback((id: string, name: string, groupName: string, followGroup = false) => {
    setModules(current => current.map(item => item.id === id && (item.name !== name || item.groupName !== groupName)
      ? { ...item, name, groupName } : item));
    if (followGroup) setSelectedGroup(groupName);
  }, []);
  const groups = useMemo(() => Array.from(new Set([...DEFAULT_GROUPS, ...navigation.map(item => item.groupName).filter(Boolean)])), [navigation]);
  async function selectFavorite(item: ReactionListItem) {
    if (!item.content || !item.state.available || favoriteSelecting || loading) return;
    setSelectedFavorite(item.key); setError(''); setFavoriteSelecting(true);
    try {
      const parsed = tryContentKeyParts(item.key);
      if (!parsed) throw new Error('该喜欢已不可用，请刷新喜欢清单');
      const { type, id } = parsed;
      if (type === 'image_module') {
        const installed = navigation.find(module => module.id === id);
        if (!installed) throw new Error('该模块已不可用，请刷新喜欢清单');
        navigateToModule(installed.groupName || '未分组', installed.id);
      } else if (type === 'image_template') {
        const installed = modules.find(module => module.sourcePresetId === id) || directory.find(module => module.sourcePresetId === id);
        if (installed) navigateToModule(installed.groupName || '未分组', installed.id);
        else await openPresetLibrary(undefined, id);
      } else {
        const target = new URL(item.content.href, window.location.origin);
        if (target.origin !== window.location.origin || target.pathname !== '/template-studio') throw new Error('模板入口已失效，请刷新喜欢清单');
        router.push(target.pathname + target.search);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '模板无法打开，请重试'); }
    finally { setFavoriteSelecting(false); }
  }
  const visibleModules = useMemo(() => selectedGroup ? modules.filter(item => item.groupName === selectedGroup) : modules, [modules, selectedGroup]);
  const missingGroupModules = useMemo(() => (groupedModules[selectedGroup] || []).filter(item => !modules.some(module => module.id === item.id)), [groupedModules, selectedGroup, modules]);
  useLayoutEffect(() => {
    if (!pendingModuleScroll || coverView) return;
    if (pendingModuleScroll.target === 'header') {
      const header = document.getElementById(pendingModuleScroll.id);
      if (header) {
        updateNavigationOffset();
        return scrollToWorkbenchHeader(header, pageRef.current || header, pendingModuleScroll.behavior, () => {
          setPendingModuleScroll(current => current?.token === pendingModuleScroll.token ? null : current);
        });
      } else setError('无法定位到图片生成区域，请重试');
      setPendingModuleScroll(current => current?.token === pendingModuleScroll.token ? null : current);
      return;
    }
    const targetModule = modules.find(module => module.id === pendingModuleScroll.id);
    if (!targetModule) {
      if (!loading && !hydrating) {
        setError('所选模板暂时无法读取，请重试');
        setPendingModuleScroll(current => current?.token === pendingModuleScroll.token ? null : current);
      }
      return;
    }
    const targetGroup = targetModule.groupName || '未分组';
    if (targetGroup !== pendingModuleScroll.group) {
      setSelectedGroup(targetGroup);
      if (pendingModuleScroll.expansionRevision === sidebarInteraction.current) {
        setExpandedGroups(current => Array.from(new Set([...current, targetGroup])));
        setImageGenerationExpanded(true);
      }
      setPendingModuleScroll(current => current?.token === pendingModuleScroll.token ? { ...current, group: targetGroup } : current);
      return;
    }
    if (selectedGroup !== targetGroup) return;
    const target = document.getElementById(`module-${pendingModuleScroll.id}`);
    if (!target) {
      if (!loading && !hydrating) {
        setError('模板已读取，但无法定位到对应内容，请重新读取后重试');
        setPendingModuleScroll(current => current?.token === pendingModuleScroll.token ? null : current);
      }
      return;
    }
    updateNavigationOffset();
    const header = target.querySelector<HTMLElement>('header') || target;
    return scrollToWorkbenchHeader(header, pageRef.current || target, pendingModuleScroll.behavior, () => {
      if (pendingModuleScroll.markViewed) setRequestedView({ viewerId: userId, moduleId: pendingModuleScroll.id, token: ++viewSequence.current });
      setPendingModuleScroll(current => current?.token === pendingModuleScroll.token ? null : current);
    });
  }, [pendingModuleScroll, modules, loading, hydrating, selectedGroup, coverView, userId, updateNavigationOffset]);
  useEffect(() => {
    if (!pendingModuleScroll) return;
    const token = pendingModuleScroll.token;
    const cancel = () => setPendingModuleScroll(current => current?.token === token ? null : current);
    const cancelOnKeydown = (event: KeyboardEvent) => {
      if (!['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'].includes(event.key)) return;
      if ((event.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable="true"]')) return;
      cancel();
    };
    window.addEventListener('wheel', cancel, { passive: true });
    window.addEventListener('touchmove', cancel, { passive: true });
    window.addEventListener('keydown', cancelOnKeydown);
    return () => {
      window.removeEventListener('wheel', cancel);
      window.removeEventListener('touchmove', cancel);
      window.removeEventListener('keydown', cancelOnKeydown);
    };
  }, [pendingModuleScroll]);
  useEffect(() => {
    const firstPage = (groupedModules[selectedGroup] || []).slice(0, 12);
    void hydrateModules(firstPage.filter(item => !modules.some(module => module.id === item.id)).map(item => item.id));
  }, [selectedGroup, groupedModules, modules, hydrateModules]);
  useEffect(() => {
    if (active && navigation.some(item => item.id === active) && !modules.some(item => item.id === active)) void hydrateModules([active]);
  }, [active, navigation, modules, hydrateModules]);
  const coverPages = useResultPages({ items: directoryReady ? navigation : [], storageKey: `sd2:module-covers:v1:${userId}`,
    visible: coverView, busy: loading || hydrating || !directoryReady, error: Boolean(error), hasMore: false,
    total: directoryReady ? navigation.length : null, loadMore: async () => undefined, currentId: null });
  const visibleCoverIds = coverPages.pageItems.map(item => item.id).join(',');
  useEffect(() => {
    if (!coverView || !directoryReady || error) return;
    const missing = visibleCoverIds.split(',').filter(id => id && !modules.some(module => module.id === id));
    if (missing.length) void hydrateModules(missing);
  }, [coverView, directoryReady, visibleCoverIds, modules, hydrateModules, error, coverRetry]);
  const coverPagination = <nav className={styles.pagination} style={{ flexWrap: 'wrap' }} aria-label="封面分页">
    <button type="button" aria-label="回到第一页封面" title="回到第一页封面" disabled={loading || hydrating || !directoryReady || !coverPages.start && !coverPages.restoring} onClick={coverPages.reset}><ChevronFirst size={17} /></button>
    <button type="button" aria-label="上一页封面" title="上一页封面" disabled={loading || hydrating || !directoryReady || !coverPages.start} onClick={coverPages.previous}><ChevronLeft size={17} /></button>
    <span role="status">{directoryReady ? `第 ${coverPages.page} / ${coverPages.pages} 页，共 ${navigation.length} 个封面` : '正在读取封面目录'}</span>
    <button type="button" aria-label="下一页封面" title="下一页封面" disabled={loading || hydrating || !directoryReady || !coverPages.canNext} onClick={coverPages.next}><ChevronRight size={17} /></button>
    <button type="button" aria-label="最后一页封面" title="最后一页" disabled={loading || hydrating || !directoryReady || !coverPages.canLast || coverPages.restoring} onClick={coverPages.last}><ChevronLast size={17} /></button>
  </nav>;
  useEffect(() => {
    if (!navigation.length) return;
    const availableGroups = Object.keys(groupedModules);
    setSelectedGroup(current => current && availableGroups.includes(current) ? current : availableGroups[0] || groups[0]);
  }, [groups, groupedModules, navigation.length]);
  const [groupDeleting, setGroupDeleting] = useState(false);
  const groupDeleteLock = useRef(false);
  async function deleteGroup(group: string) {
    if (DEFAULT_GROUPS.includes(group) || groupDeleteLock.current) return;
    groupDeleteLock.current = true; setGroupDeleting(true);
    try { await deleteGroupMembers(group); }
    finally { groupDeleteLock.current = false; setGroupDeleting(false); }
  }
  async function deleteGroupMembers(group: string) {
    const blocked = () => (groupedModules[group] || []).some(item => presetSources.current.get(item.id)?.().groupDeleteBlocked);
    if (blocked()) { setError('分组中有模块正在保存或处理其他操作，请完成后再删除分组'); return; }
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
    if (blocked()) { setError('分组内容已变化，请完成保存后再删除分组'); return; }
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
  const resetSidebarExpansion = () => { sidebarInteraction.current++; setExpandedGroups([]); setImageGenerationExpanded(false); setFavoritesExpanded(false); setSelectedFavorite(''); };
  const toggleImageSection = () => { sidebarInteraction.current++; setImageGenerationExpanded(current => !current); };
  const toggleModuleGroup = (group: string) => { sidebarInteraction.current++; setExpandedGroups(current => current.includes(group) ? current.filter(item => item !== group) : [...current, group]); };
  const navigateToCovers = () => {
    replaceImageModuleLocation(null, true);
    routedContentHandled.current = `${userId}:${window.location.search}`;
    setPendingModuleScroll(null); setCoverView(true);
  };
  const imageSectionOpen = imageGenerationExpanded;
  return <>{productDialog}{(<main ref={pageRef} className={`${styles.page} ${templateWorkbench ? styles.templateWorkbench : ''}`}>
    <aside className={styles.moduleRail} data-remember-scroll="image-groups" aria-label={templateWorkbench ? '模板导航' : '分组快捷栏'}>
      {templateWorkbench ? <>
        <div className={styles.moduleRailTitle}>模板工作台</div>
        <button type="button" className={styles.moduleRailMajorLink} aria-expanded={favoritesExpanded} aria-controls="template-favorites-desktop" onClick={() => setFavoritesExpanded(current => !current)}><Heart size={16} /><span>我的喜欢</span>{favoritesExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button>
        <div id="template-favorites-desktop" hidden={!favoritesExpanded}><TemplateFavoritesList data={favorites} selected={selectedFavorite} busy={favoriteSelecting || loading} onSelect={item => void selectFavorite(item)} /></div>
        <section className={styles.moduleRailMajor} aria-label="图片生成">
          <div className={styles.moduleRailMajorHeader}>
            <button type="button" className={styles.moduleRailMajorLink} aria-expanded={imageSectionOpen} aria-controls="template-image-groups" onClick={toggleImageSection}>
              <ImagePlus size={16} /><span>图片生成</span>{hasAnyUnread && <span className={styles.unreadDot} role="img" aria-label="有未读结果" />}
              {imageSectionOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </button>
          </div>
          <div id="template-image-groups" className={styles.moduleRailSubgroups} hidden={!imageSectionOpen}>
            {Object.entries(groupedModules).map(([group, items], index) => {
              const groupHasUnread = items.some(item => attention.unread.has(item.id));
              const expanded = expandedGroups.includes(group);
              const listId = `template-module-group-${index}`;
              return <div key={group} className={styles.moduleRailGroup}>
                <div className={styles.moduleRailGroupHeader}>
                  <button type="button" className={`${styles.moduleRailGroupTitle} ${!coverView && items.some(item => item.id === active) ? styles.moduleRailGroupCurrent : ''}`} aria-expanded={expanded} aria-controls={listId} disabled={!items.length}
                    onClick={() => toggleModuleGroup(group)}>
                    <span className={styles.navLabel}><span className={styles.navName} title={group}>{group}</span>{groupHasUnread && <span className={styles.unreadDot} role="img" aria-label="有未读结果" />}</span><small title={`共 ${items.length} 个模块`}>{items.length}项</small>
                    {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  </button>
                </div>
                <div id={listId} className={styles.moduleRailChildren} hidden={!expanded}>
                  {items.map(item => <button key={item.id} type="button" className={`${styles.moduleRailChild} ${!coverView && active === item.id ? styles.moduleRailActive : ''}`} aria-current={!coverView && active === item.id ? 'page' : undefined}
                    onClick={() => navigateToModule(group, item.id)}><span className={styles.navName} title={item.name}>{item.name}</span>{attention.unread.has(item.id) && <span className={styles.unreadDot} role="img" aria-label="有未读结果" />}</button>)}
                </div>
              </div>;
            })}
          </div>
          <div className={styles.moduleRailFooter}><button type="button" title="重置侧栏展开状态" aria-label="重置侧栏展开状态" onClick={resetSidebarExpansion}><RotateCcw size={15} /><span>重置展开状态</span></button></div>
        </section>
      </> : <>
        <div className={styles.moduleRailTitle}>分组快捷栏</div>
        {Object.entries(groupedModules).map(([group, items]) => <div key={group} className={styles.moduleRailGroup}>
          <button type="button" className={selectedGroup === group ? styles.moduleRailActive : ''} aria-current={selectedGroup === group ? 'page' : undefined} onClick={() => items[0] && navigateToModule(group, items[0].id, { markViewed: false })}>
            <span className={styles.navLabel}><span className={styles.navName}>{group}</span>{items.some(item => attention.unread.has(item.id)) && <span className={styles.unreadDot} role="img" aria-label="有未读结果" />}</span><small title={`共 ${items.length} 个模块`}>{items.length}项</small></button>
          <div className={styles.moduleRailChildren}>{items.map(item => <button key={item.id} type="button" className={`${styles.moduleRailChild} ${!coverView && active === item.id ? styles.moduleRailActive : ''}`} aria-current={!coverView && active === item.id ? 'page' : undefined}
            onClick={() => navigateToModule(group, item.id)}><span className={styles.navName} title={item.name}>{item.name}</span>{attention.unread.has(item.id) && <span className={styles.unreadDot} role="img" aria-label="有未读结果" />}</button>)}</div>
        </div>)}
      </>}
      <button type="button" className={coverView ? styles.moduleRailActive : ''} aria-current={coverView ? 'page' : undefined} onClick={navigateToCovers}>全部封面{navigation.some(item => attention.unread.has(item.id)) && <span className={styles.unreadDot} role="img" aria-label="有未读结果" />}<small title={`共 ${navigation.length} 个模块`}>{navigation.length}项</small></button>
    </aside>
    {templateWorkbench && <nav ref={mobileModuleNavRef} className={styles.mobileModuleNav} aria-label="图片模块导航">
      <div className={styles.mobileMajorLinks}>
        <button type="button" className={styles.mobileMajorLink} aria-expanded={imageSectionOpen} aria-controls="template-mobile-image-groups" onClick={toggleImageSection}><ImagePlus size={16} /><span>图片生成</span>{hasAnyUnread && <span className={styles.unreadDot} role="img" aria-label="有未读结果" />}{imageSectionOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</button>
        <button type="button" className={styles.mobileMajorLink} aria-expanded={favoritesExpanded} aria-controls="template-favorites-mobile" onClick={() => setFavoritesExpanded(current => !current)}><Heart size={16} /><span>我的喜欢</span>{favoritesExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button>
      </div>
      <div id="template-favorites-mobile" className={styles.mobileFavoriteList} hidden={!favoritesExpanded}><TemplateFavoritesList data={favorites} selected={selectedFavorite} busy={favoriteSelecting || loading} onSelect={item => void selectFavorite(item)} /></div>
      <div id="template-mobile-image-groups" className={styles.mobileImageGroups} hidden={!imageSectionOpen}>
      <label className={styles.mobileGroupPicker}><span>分组</span><select aria-label="选择图片分组" value={selectedGroup} onChange={event => setSelectedGroup(event.target.value)}>
        {!Object.keys(groupedModules).length && <option value="">暂无分组</option>}
        {Object.entries(groupedModules).map(([group, items]) => <option key={group} value={group}>{group} ({items.length}项){items.some(item => attention.unread.has(item.id)) ? ' · 未读' : ''}</option>)}
      </select></label>
      <button type="button" className={coverView ? styles.moduleRailActive : ''} aria-pressed={coverView} onClick={navigateToCovers}>全部封面{navigation.some(item => attention.unread.has(item.id)) && <span className={styles.unreadDot} role="img" aria-label="有未读结果" />} <small title={`共 ${navigation.length} 个模块`}>{navigation.length}项</small></button>
      <label className={styles.mobileModulePicker}><span>模块</span><select aria-label="选择图片模块" value={!coverView && groupedModules[selectedGroup]?.some(item => item.id === active) ? active : ''} onChange={event => {
        if (event.target.value) navigateToModule(selectedGroup, event.target.value);
      }}>
        <option value="">{coverView ? '选择模块返回编辑' : '选择模块'}</option>
        {(groupedModules[selectedGroup] || []).map(item => <option key={item.id} value={item.id}>{item.name}{attention.unread.has(item.id) ? ' · 未读' : ''}</option>)}
      </select></label>
      {!coverView && attention.unread.has(active) && <button type="button" title="读取当前模板的新结果" aria-label="读取当前模板的新结果" onClick={() => navigateToModule(selectedGroup, active)}><Eye size={16} /><span className={styles.unreadDot} /></button>}
      </div>
    </nav>}
    <div className={styles.content}>
    <header id="image-generation" className={`${styles.header} ${styles.generationHeader}`}><div><h1>{coverView ? (templateWorkbench ? '模块封面' : '模板封面') : '图片生成'}</h1><p className={styles.muted}>{coverView ? (templateWorkbench ? '所有模块的 3:4 封面预览' : '所有模板的 3:4 封面预览') : `当前分组：${selectedGroup || '未分组'}`}</p></div><div className={styles.counts}>
      <button type="button" onClick={() => void openPresetLibrary()}>模板库</button>
      <button type="button" onClick={() => setGlobalSettingsOpen(true)}><Settings size={17} />通用设置</button>
      <button type="button" disabled={creating || !modules.length} onClick={() => void createModule()}><Plus size={17} />{creating ? '新建中' : '新建模块'}</button></div></header>
    {error && <p role="alert" className={styles.error}>{error}<button onClick={() => { if (coverView && directoryReady) { setError(''); setCoverRetry(value => value + 1); } else void loadModules(cursor || undefined); }}>重试读取</button></p>}
    {attention.error && <p role="status" className={styles.muted}>{attention.error}<button type="button" onClick={() => {
      const target = attention.retryModuleId && directory.find(item => item.id === attention.retryModuleId);
      if (target) navigateToModule(target.groupName || '未分组', target.id); else void attention.refresh(true);
    }}>重试</button></p>}
    {coverView && <section className={styles.coverGrid} aria-label={templateWorkbench ? '模块封面' : '模板封面'}>{coverPagination}<div className={styles.coverGridInner} ref={coverPages.gridRef}>{coverPages.pageItems.map(entry => {
      const coverModule = modules.find(item => item.id === entry.id);
      if (!coverModule) return <div key={entry.id} className={`${styles.coverCard} sd2-loading-surface`} data-busy={!error} role="status"><strong>{entry.name}</strong><span>{error ? '封面未能读取，请重试' : '读取封面中'}</span></div>;
      return <button key={coverModule.id} type="button" className={styles.coverCard} onClick={() => navigateToModule(coverModule.groupName || '未分组', coverModule.id)}>
        <TemplateCoverVisual module={coverModule} />
        <span className={styles.coverDescription}><strong className={styles.navLabel} title={coverModule.name}><span className={styles.navName}>{coverModule.name}</span>{attention.unread.has(coverModule.id) && <span className={styles.unreadDot} role="img" aria-label="有未读结果" />}</strong><small>{coverModule.prompt.trim() ? coverModule.prompt.trim().slice(0, 96) : `以${coverModule.name}为主题，按当前参考图和模型设置生成图片。`}</small></span>
      </button>;
    })}</div>{coverPagination}</section>}
    <div hidden={coverView}>
    {modules.map(module => <ImageStudioBlock key={module.id} templateWorkbench={templateWorkbench} module={module} hidden={coverView || Boolean(selectedGroup && module.groupName !== selectedGroup)} onMetadataChange={updateModuleMetadata} groups={groups} onDeleteGroup={deleteGroup} groupDeleting={groupDeleting} isAdmin={isAdmin} onToggleSharing={toggleModuleSharing} sharingId={presetSharingId}
      onModuleDelete={id => { removedModuleIds.current.add(id); setModules(current => current.filter(item => item.id !== id)); setDirectory(current => current.filter(item => item.id !== id)); setActive(current => current === id ? '' : current); }}
      userId={userId} settings={settings} globalContextDraft={isAdmin ? globalEditor.draft?.context : undefined} globalSettingsDirty={globalEditor.dirty || globalEditor.saving} settingsError={globalEditor.error} active={!coverView && active === module.id && module.groupName === selectedGroup} onActivate={() => { replaceImageModuleLocation(module.id); routedContentHandled.current = `${userId}:${window.location.search}`; setActive(module.id); }}
      onManagePresets={() => void openPresetLibrary(module.id)} registerPresetSource={registerPresetSource}
      quickPresetVersion={quickPresetVersion} viewToken={requestedView.viewerId === userId && requestedView.moduleId === module.id ? requestedView.token : 0} onResultsViewed={attention.markViewed} onTemplateEntered={attention.confirmEntry} onResultsAvailable={attention.refresh}
      onModuleChange={next => { setModules(current => current.map(item => item.id === next.id ? { ...next, name: item.name, groupName: item.groupName } : item)); }}
      ratios={{ custom: customRatios, busy: ratiosBusy, error: ratiosError, onRetry: () => void syncRatios(), onCustom: syncRatios }}
      onReloadSettings={discard => { void globalEditor.controller.load(discard); }} />)}
    {(loading || hydrating) && <p role="status">正在读取模块…</p>}
    {missingGroupModules.length > 0 && <button disabled={hydrating} onClick={() => void hydrateModules(missingGroupModules.slice(0, 12).map(item => item.id))}>加载更多模块（{missingGroupModules.length}）</button>}
    {visibleModules.length > 0 && <button type="button" className={styles.newModule} disabled={creating} onClick={() => void createModule()}><Plus size={17} />新建模块</button>}
    </div>
    </div>
    <dialog ref={presetDialog} className={styles.dialog}>
      <header className={styles.header}><h2>模板库</h2><button type="button" disabled={Boolean(quickLinkingId) || presetApplying || presetManaging} aria-label="关闭模板库" onClick={() => setPresetDialogOpen(false)}><X size={20} /></button></header>
      <label className={styles.presetSource}>更新设置取自<select aria-label="选择要写入模板的模块" value={presetSourceId} disabled={presetManaging || presetApplying} onChange={event => setPresetSourceId(event.target.value)}><option value="">选择模块</option>{modules.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <button type="button" title="重新读取模板库" aria-label="重新读取模板库" disabled={presetManaging || presetApplying || Boolean(quickLinkingId) || presetsLoading} onClick={() => void openPresetLibrary(presetSourceId)}><RefreshCw size={16} /></button>
      {presetsError && <p role="alert" className={styles.error}>{presetsError}</p>}
      {presetsLoading ? <p role="status">正在读取模板…</p> : !presets.length ? <p className={styles.muted}>暂无模板</p> : <div className={styles.presetList}>{presets.map(preset => <article key={preset.id} className={styles.presetItem}>
        <div><TemplateFavoriteTitle contentKey={`image_template:${preset.id}`}><strong title={preset.name}>{preset.name}</strong></TemplateFavoriteTitle><span>{preset.groupName} · {IMAGE_STUDIO_MODEL_LABELS[preset.model as keyof typeof IMAGE_STUDIO_MODEL_LABELS] || preset.model}{!preset.ownedByViewer ? ' · 共享模板，只读' : ''}</span></div>
        <div className={styles.presetActions}>
          {preset.canManageSharing && <button type="button" role="switch" aria-checked={preset.isShared} className={styles.presetSharing} disabled={Boolean(presetSharingId) || presetManaging} onClick={() => void togglePresetSharing(preset)}>{preset.isShared ? '共享给同事' : '仅自己可见'}</button>}
          {preset.ownedByViewer && <><button type="button" title="修改模板名称" aria-label={`修改模板名称：${preset.name}`} disabled={presetManaging || presetApplying || Boolean(quickLinkingId) || Boolean(presetSharingId)} onClick={() => void managePreset(preset, 'rename')}><Pencil size={16} /></button>
            <button type="button" disabled={!presetSourceId || presetManaging || presetApplying || Boolean(quickLinkingId) || Boolean(presetSharingId)} onClick={() => void managePreset(preset, 'replace')}><Save size={16} />更新设置</button>
            <button type="button" title="删除设置模板" aria-label={`删除设置模板：${preset.name}`} disabled={presetManaging || presetApplying || Boolean(quickLinkingId) || Boolean(presetSharingId)} onClick={() => void managePreset(preset, 'delete')}><Trash2 size={16} /></button></>}
          {preset.ownedByViewer && active && <button type="button" disabled={Boolean(quickLinkingId) || presetApplying || presetManaging} onClick={() => void addPresetShortcut(preset)}>{quickLinkingId === preset.id ? '添加中…' : '加入当前模块快捷'}</button>}
          <button type="button" disabled={presetApplying || Boolean(quickLinkingId) || presetManaging} onClick={() => void applyPreset(preset)}>新建并应用</button>
        </div></article>)}</div>}
    </dialog>
    <StudioGlobalSettingsDialog open={globalSettingsOpen} onClose={() => setGlobalSettingsOpen(false)} editor={globalEditor} ownerId={userId} canEdit={isAdmin}
      ratios={{ custom: customRatios, busy: ratiosBusy, error: ratiosError, onRetry: () => void syncRatios(), onCustom: syncRatios }} />
    {!settings && globalEditor.error && <p role="alert" className={styles.error}>{globalEditor.error}<button onClick={() => void globalEditor.controller.load()}>重试读取设置</button></p>}
  </main>)}</>;
}

function ImageStudioBlock({ isAdmin, userId, module, hidden, onMetadataChange, onModuleDelete, groups, onDeleteGroup, groupDeleting, onToggleSharing, sharingId, settings, globalContextDraft, globalSettingsDirty, settingsError, active, onActivate, onModuleChange, onReloadSettings, ratios, templateWorkbench, quickPresetVersion, viewToken, onResultsViewed, onTemplateEntered, onResultsAvailable, onManagePresets, registerPresetSource }: {
  groupDeleting: boolean;
  onManagePresets: () => void;
  registerPresetSource: (id: string, read: PresetSourceReader | null) => void;
  templateWorkbench: boolean;
  quickPresetVersion: number;
  onModuleDelete: (id: string) => void;
  hidden: boolean; onMetadataChange: (id: string, name: string, groupName: string, followGroup?: boolean) => void;
  isAdmin: boolean; userId: string; module: StudioModule & { fixedReferences?: FixedStudioReference[]; contextEditable?: boolean }; groups: string[]; onDeleteGroup: (group: string) => Promise<void>; onToggleSharing: (module: StudioModule) => Promise<void>; sharingId: string | null; settings: SettingsValue | null;
  globalContextDraft?: string; globalSettingsDirty: boolean; settingsError: string; active: boolean; onActivate: () => void; onModuleChange: (module: StudioModule) => void;
  viewToken: number; onResultsViewed: (moduleId: string, versions: string[]) => Promise<void>; onResultsAvailable: () => Promise<void>;
  onTemplateEntered: (moduleId: string, snapshot: string, signal: AbortSignal) => Promise<void>;
  onReloadSettings: (discardDraft?: boolean) => void;
  ratios: RatioPreferences;
}) {
  const { confirm, prompt: askName, productDialog } = useProductDialog();
  const contextEditable = module.contextEditable !== false;
  const fixedEditable = isAdmin && module.fixedReferencesEditable !== false;
  const [skills, setSkills] = useState<SkillSummary[]>(module.skills || []);
  const [reproductionSkills, setReproductionSkills] = useState<SkillSummary[]>((module.reproductionState as { skills?: SkillSummary[] } | null)?.skills || []);
  const [styleGroups, setStyleGroups] = useState<StudioStyleSummary[]>(module.styleGroups || []);
  const [reproductionFixedCount, setReproductionFixedCount] = useState(module.reproductionState?.fixedReferenceCount || 0);
  const [reproductionStyles, setReproductionStyles] = useState<StudioStyleSummary[]>(module.reproductionState?.styleGroups || []);
  const [saveStatus, setSaveStatus] = useState('');
  const [quickPresets, setQuickPresets] = useState<QuickStudioPreset[]>([]);
  const [quickPresetsError, setQuickPresetsError] = useState('');
  const [quickPresetsLoading, setQuickPresetsLoading] = useState(false);
  const [quickPresetApplying, setQuickPresetApplying] = useState<string | null>(null);
  const [presetSaving, setPresetSaving] = useState(false);
  const quickPresetLock = useRef(false);
  const presetSaveLock = useRef(false);
  const [recoverableDraft, setRecoverableDraft] = useState<Record<string, any> | null>(null);
  const [savedAsSignature, setSavedAsSignature] = useState('');
  const [prompt, setPrompt] = useState(module.prompt);
  const evolution = (module as StudioModule & { evolution?: EvolutionCapability | null }).evolution || null;
  const [evolutionInput, setEvolutionInput] = useState<EvolutionInput>({ direction: evolution?.defaultDirection || 'increase', manual: false });
  const bodyDirection = describedEvolutionDirection(prompt);
  const evolutionConflict = evolution && evolutionInput.manual && bodyDirection && bodyDirection !== evolutionInput.direction ? '正文方向与手选方向冲突，请调整正文或方向' : '';
  const [resultView, setResultView] = useState<'images' | 'batch'>('images');
  const [count, setCount] = useState(module.count);
  const [referenceLimit, setReferenceLimit] = useState(module.referencePolicy?.primaryMax ?? Math.max(1, Math.min(MAX_REFERENCE_IMAGES, module.referenceLimit || DEFAULT_STUDIO_PRIMARY_MAX)));
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
  const [contextComposing, setContextComposing] = useState(false);
  const [savedModuleContext, setSavedModuleContext] = useState(module.context || '');
  const [moduleContextConfigured, setModuleContextConfigured] = useState(module.contextConfigured);
  const [moduleSaveError, setModuleSaveError] = useState('');
  const [unifiedDefaultsError, setUnifiedDefaultsError] = useState('');
  const [moduleSaved, setModuleSaved] = useState(JSON.stringify({ name: module.name, prompt: module.prompt, context: module.context || '', count: module.count, referenceLimit: moduleReferencePolicy(module).primaryMax, aspectRatio: module.aspectRatio || 'auto', model: module.model, quality: normalizeImageStudioQuality(module.model, module.quality), resolution: normalizeImageResolution(module.model, module.resolution || defaultImageResolution(module.model)), groupName: module.groupName || '未分组', bannerAssetId: module.banner?.id || null, referenceIds: [...module.images.filter(image => moduleReferencePolicy(module).primaryIds.includes(image.id || '')), ...module.images.filter(image => !moduleReferencePolicy(module).primaryIds.includes(image.id || ''))].map(image => image.id), reproduceFromTaskId: module.reproduceFromTaskId || null, sourcePresetId: module.sourcePresetId || null, skillIds: module.skillIds || [], styleGroupIds: module.styleGroupIds || [], referencePolicy: moduleReferencePolicy(module) }));
  const moduleSaveLock = useRef(false);
  const restoredDraftKey = useRef('');
  const autoSaveAttempt = useRef('');
  const section = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [imageSourceTarget, setImageSourceTarget] = useState<'reference' | 'auxiliary' | 'banner' | 'fixed'>('reference');
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  function openImageSource(target: 'reference' | 'auxiliary' | 'banner' | 'fixed') {
    setImageSourceTarget(target);
    setAssetPickerOpen(true);
  }
  const [uploadProgress, setUploadProgress] = useState<ReturnType<typeof studioUploadProgress> | null>(null);
  const [bannerProgress, setBannerProgress] = useState<ReturnType<typeof studioUploadProgress> | null>(null);
  const [bannerUploading, setBannerUploading] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<ImagePreviewState | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<{ id: string; text: string } | null>(null);
  const [tasks, setTasks] = useState<StudioTask[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [taskTotal, setTaskTotal] = useState<number | null>(null);
  const loadedTaskPages = useRef(1);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [tasksError, setTasksError] = useState('');
  const [taskReadAction, setTaskReadAction] = useState<'idle' | 'initial' | 'refresh' | 'more'>('initial');
  const [taskRetryCursor, setTaskRetryCursor] = useState<string | undefined>();
  const taskReadScope = `${userId}:${module.id}`;
  const taskReadScopeRef = useRef(taskReadScope);
  taskReadScopeRef.current = taskReadScope;
  const taskReadRequest = useRef<{ scope: string; controller: AbortController; action: 'initial' | 'refresh' | 'silent' | 'view' } | null>(null);
  const currentView = useRef({ token: viewToken, active }); currentView.current = { token: viewToken, active };
  const [viewedResults, setViewedResults] = useState<{ scope: string; token: number; sequence: number; versions: string[] } | null>(null);
  const resultReadSequence = useRef(0);
  const readAttemptToken = useRef(0);
  const requestedReadToken = useRef(0);
  useEffect(() => {
    if (templateWorkbench && !hidden && active && viewedResults?.scope === taskReadScope && viewedResults.token === viewToken && readAttemptToken.current !== viewedResults.sequence) {
      readAttemptToken.current = viewedResults.sequence;
      for (let offset = 0; offset < viewedResults.versions.length; offset += 24) {
        void onResultsViewed(module.id, viewedResults.versions.slice(offset, offset + 24));
      }
    }
  }, [templateWorkbench, hidden, active, viewedResults, viewToken, taskReadScope, module.id, onResultsViewed]);
  function observeResultVersion(version: string | null) {
    if (!templateWorkbench || hidden || document.hidden || !version) return;
    const token = currentView.current.token;
    const sequence = ++resultReadSequence.current;
    setViewedResults(previous => ({ scope: taskReadScope, token, sequence, versions: previous?.scope === taskReadScope
      && previous.token === token && readAttemptToken.current !== previous.sequence
      ? Array.from(new Set([...previous.versions, version])) : [version] }));
  }
  const taskReadLoaded = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [billingQuote, setBillingQuote] = useState<CachedStudioImageQuote | null>(null);
  const [quoteVisible, setQuoteVisible] = useState(true);
  useEffect(() => { const update = () => setQuoteVisible(!document.hidden); update(); document.addEventListener('visibilitychange', update); return () => document.removeEventListener('visibilitychange', update); }, []);
  const previousEstimateSignature = useRef('');
  const liveGenerationSignature = useRef('');
  const [queryingSubmission, setQueryingSubmission] = useState(false);
  const [pendingSubmission, setPendingSubmission] = useState<Record<string, unknown> | null>(null);
  const [reproduceSourceTaskId, setReproduceSourceTaskId] = useState<string | null>(module.reproduceFromTaskId || null);
  const [reproductionGlobalContext, setReproductionGlobalContext] = useState<string | null>(null);
  const [reproductionContextConfigured, setReproductionContextConfigured] = useState(false);
  const [appliedSource, setAppliedSource] = useState<{ taskId: string; label: string; signature: string; modified: boolean } | null>(null);
  const [selectedResultId, setSelectedResultId] = useState<string | null>(null);
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
  const moduleContextInput = useRef<HTMLTextAreaElement>(null);
  const changeModuleContext = (value: string) => {
    if (reproduceSourceTaskId) exitReproductionMode('模块上下文已修改，已退出历史复现模式，接下来会使用新上下文。');
    setModuleContext(value); setModuleSaveError('');
  };
  const resumeModulePreview = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const auxiliaryFileInput = useRef<HTMLInputElement>(null);
  const fixedFileInput = useRef<HTMLInputElement>(null);
  const bannerFileInput = useRef<HTMLInputElement>(null);
  const dirty = globalSettingsDirty;
  const suffix = module.id === `default-${userId}` ? userId : `${userId}:${module.id}`;
  const draftKey = `sd2-image-studio-draft:${suffix}`;
  const pendingKey = `sd2-image-studio-pending:${suffix}`;
  const effectiveGlobalContext = reproduceSourceTaskId && reproductionGlobalContext !== null ? reproductionGlobalContext : globalContextDraft;
  const referencePolicy: StudioReferencePolicy = { primaryIds: images.flatMap(image => image.id ? [image.id] : []), primaryMin, primaryMax: referenceLimit, auxiliaryMax: auxiliaryLimit, styleMax: styleLimit, referenceMax: referenceImageLimit, useFixedReferences };
  const moduleDraft = { name, prompt, context: moduleContext, count, referenceLimit, aspectRatio, model: moduleModel, quality: normalizeImageStudioQuality(moduleModel, quality), resolution: normalizeImageResolution(moduleModel, resolution), groupName, bannerAssetId: banner?.id || null, referenceIds: [...images, ...auxiliaryImages].map(image => image.id), reproduceFromTaskId: reproduceSourceTaskId || null, sourcePresetId: module.sourcePresetId || null, skillIds: skills.map(group => group.id), styleGroupIds: styleGroups.map(group => group.id), referencePolicy };
  const moduleSaveSnapshot = { ...moduleDraft };
  const moduleDirty = JSON.stringify(moduleSaveSnapshot) !== moduleSaved;
  const baseline = moduleSaved ? JSON.parse(moduleSaved) as typeof moduleDraft : moduleDraft;
  const generationInputs = { evolution: evolution ? evolutionInput : undefined, prompt, count, referenceLimit, aspectRatio, resolution: normalizeImageResolution(moduleModel, resolution), referenceIds: moduleDraft.referenceIds, model: moduleModel, quality: normalizeImageStudioQuality(moduleModel, quality), referencePolicy, context: moduleContext, fixedReferences: fixedReferencePayload(fixedReferences), skillIds: moduleDraft.skillIds, skillVersions: Object.fromEntries(skills.filter(group => group.promptVersion).map(group => [group.id, group.promptVersion!])), styleGroupIds: moduleDraft.styleGroupIds };
  const generationDraft = JSON.stringify(generationInputs);
  const actualQuoteRequired = settings?.billingReadiness?.models?.[moduleModel]?.ready === true;
  const batch = useStudioBatch({ userId, moduleId: module.id, actualQuoteRequired, quotePayload: settings ? generationPayload(undefined, '') : null, unitCredits: settings ? settings.prices?.[moduleModel] ?? null : module.prices[moduleModel] ?? null,
    draftSignature: JSON.stringify([generationDraft, effectiveGlobalContext, reproduceSourceTaskId, settings?.revision, module.revision]) });
  const contextVersion = useModuleContextVersion({ moduleId: module.id, raw: moduleContext, taskId: reproduceSourceTaskId,
    editable: contextEditable, enabled: !hidden && draftLoaded && !draftRestoring, composing: contextComposing });
  const contextUnsaved = moduleContext !== savedModuleContext || Boolean(reproduceSourceTaskId && reproduceSourceTaskId !== baseline.reproduceFromTaskId);
  function currentPresetDraft(): Record<string, unknown> {
    return {
      scope: isAdmin ? 'admin' : 'creator', groupName, prompt, context: moduleContext, model: moduleModel, quality, resolution,
      count, referenceLimit, referencePolicy, aspectRatio, bannerAssetId: banner?.id || null, referenceIds: moduleDraft.referenceIds, sourceModuleId: module.id,
      reproduceFromTaskId: reproduceSourceTaskId || undefined,
      fixedReferences: fixedEditable ? fixedReferencePayload(reproduceSourceTaskId ? reproductionReferences.slice(0, Math.max(0, reproductionFixedCount - reproductionStyles.reduce((total, group) => total + group.referenceCount, 0))) : fixedReferences) : undefined,
      skillIds: (reproduceSourceTaskId ? reproductionSkills : skills).map(group => group.id), styleGroupIds: (reproduceSourceTaskId ? reproductionStyles : styleGroups).map(group => group.id),
    };
  }
  const presetSourceReader = useRef<PresetSourceReader>(() => ({ draft: {}, blocked: '正在读取设置' }));
  presetSourceReader.current = () => ({ draft: currentPresetDraft(), blocked: !contextEditable ? '共享模板的内部配置只能由创建者更新' :
    !draftLoaded || draftRestoring || submitting || pendingSubmission || moduleSaving || presetSaving || quickPresetApplying || uploading || bannerUploading || ratioEditing ? '模块正在处理其他操作，请稍后再更新模板' : null,
    groupDeleteBlocked: !draftLoaded || draftRestoring || submitting || Boolean(pendingSubmission) || moduleSaving || moduleDeleting || presetSaving || Boolean(quickPresetApplying) || uploading || bannerUploading || automaticSnapshot !== moduleSaved });
  useEffect(() => {
    registerPresetSource(module.id, () => presetSourceReader.current());
    return () => registerPresetSource(module.id, null);
  }, [module.id, registerPresetSource]);
  const restorationSignature = JSON.stringify({ inputs: generationInputs, source: reproduceSourceTaskId, references: reproductionReferences, fixedCount: reproductionFixedCount, styles: reproductionStyles, skills: reproductionSkills, globalContext: effectiveGlobalContext });
  const sourceApplied = Boolean(appliedSource && !appliedSource.modified && appliedSource.signature === restorationSignature);
  useEffect(() => {
    if (appliedSource && !appliedSource.modified && appliedSource.signature !== restorationSignature) {
      setAppliedSource(previous => previous ? { ...previous, modified: true } : null);
    }
  }, [appliedSource, restorationSignature]);
  const defaultGenerationDraft = JSON.stringify({ evolution: evolution ? { direction: evolution.defaultDirection, manual: false } : undefined, prompt: baseline.prompt, count: baseline.count, referenceLimit: baseline.referenceLimit, aspectRatio: baseline.aspectRatio, resolution: normalizeImageResolution(baseline.model, baseline.resolution), referenceIds: baseline.referenceIds, model: baseline.model, quality: normalizeImageStudioQuality(baseline.model, baseline.quality), referencePolicy: baseline.referencePolicy, context: savedModuleContext, fixedReferences: fixedReferencePayload(savedFixedReferences), skillIds: baseline.skillIds || [], skillVersions: generationInputs.skillVersions, styleGroupIds: baseline.styleGroupIds });
  const generationChanged = generationDraft !== defaultGenerationDraft || Boolean(reproduceSourceTaskId);
  const automaticSnapshot = JSON.stringify({ ...baseline, name, groupName, bannerAssetId: banner?.id || null });
  const automaticDirty = automaticSnapshot !== moduleSaved;
  const unpersistedDraft = draftLoaded && generationChanged && persistedDraftSignature !== generationDraft;
  // Recoverable browser drafts are not lost on refresh; failed persistence still blocks exit.
  useUnsavedNavigation(dirty || automaticDirty || moduleSaving || presetSaving || Boolean(quickPresetApplying) || uploading || bannerUploading || unpersistedDraft, confirm, {
    unsaved: [automaticDirty ? '模板名称、分组或封面' : '', unpersistedDraft ? '尚未存入浏览器的图片草稿' : ''].filter(Boolean),
    busy: [moduleSaving || presetSaving ? '模板正在保存' : '', quickPresetApplying ? '快捷模板正在套用' : '', uploading ? '参考素材正在上传' : '', bannerUploading ? '封面正在上传' : ''].filter(Boolean),
    revision: automaticSnapshot + generationDraft,
  });
  const settingsDirty = moduleContext !== savedModuleContext || fixedDirty || generationDraft !== defaultGenerationDraft;
  const contextDialogSnapshot = JSON.stringify({ context: moduleContext, primaryMin, primaryMax: referenceLimit,
    auxiliaryMax: auxiliaryLimit, styleMax: styleLimit, referenceMax: referenceImageLimit, useFixedReferences,
    fixedReferences: fixedReferencePayload(fixedReferences), skillIds: skills.map(group => group.id), styleGroupIds: styleGroups.map(group => group.id),
    model: moduleModel, resolution: normalizeImageResolution(moduleModel, resolution), quality: normalizeImageStudioQuality(moduleModel, quality) });
  const contextDialogOpening = useRef('');
  const latestSettingsDraft = useRef('');
  latestSettingsDraft.current = JSON.stringify({ moduleDraft, fixedReferences: fixedReferencePayload(fixedReferences) });
  async function saveModuleSettings() {
    const submitted = latestSettingsDraft.current;
    const result = await saveModule();
    if (result !== false && latestSettingsDraft.current === submitted) moduleDialog.current?.close();
  }
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
  const sourceSharingBlocked = Boolean(module.sourcePresetId && module.sourcePresetShared === false && !module.sourcePresetOwnedByViewer);

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
    if (moduleSaveLock.current || moduleDeleteLock.current || presetSaveLock.current || quickPresetLock.current || uploading || bannerUploading) return false;
    moduleSaveLock.current = true; setModuleSaving(true); setError(''); setModuleSaveError('');
    const snapshot = { ...(manualSettings ? moduleDraft : JSON.parse(automaticSnapshot) as typeof moduleDraft), context: manualSettings ? moduleContext : savedModuleContext, reproduceFromTaskId: manualSettings ? reproduceTaskId || null : baseline.reproduceFromTaskId };
    const contextSnapshot = snapshot.context;
    const fixedSnapshot = fixedOverride || (manualSettings ? fixedReferences : savedFixedReferences);
    try {
      const result = await readResponse(await fetch('/api/image-studio/modules', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: module.id, revision: revisionOverride, ...snapshot, context: contextEditable ? contextSnapshot : undefined, fixedReferences: fixedEditable && (manualSettings || fixedOverride) ? fixedReferencePayload(fixedSnapshot) : undefined }) }));
      if (!Number.isInteger(result.revision) || result.revision <= revisionOverride) throw new Error('保存结果尚未确认，当前草稿已保留，请核对后重试');
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
    if (quickPresetLock.current || presetSaveLock.current || submitting || pendingSubmission || moduleSaving || uploading || bannerUploading || draftRestoring) return;
    if (!(await confirm(templateWorkbench ? '恢复当前模块默认参数和参考图？上次临时草稿仍可恢复。' : '恢复当前模板默认参数和参考图？上次临时草稿仍可恢复。', { title: '恢复默认', confirmLabel: '恢复默认' }))) return;
    try { const saved = JSON.parse(localStorage.getItem(draftKey) || 'null'); if (saved) setRecoverableDraft(saved); } catch {}
    blockedDraftSignature.current = null;
    setPrompt(baseline.prompt); setCount(baseline.count); setReferenceLimit(baseline.referenceLimit); setAspectRatio(baseline.aspectRatio); setModuleModel(baseline.model);
    setEvolutionInput({ direction: evolution?.defaultDirection || 'increase', manual: false });
    setQuality(baseline.quality); setResolution(baseline.resolution);
    setImages(module.images.filter(image => baseline.referencePolicy.primaryIds.includes(image.id || '')));
    setAuxiliaryImages(module.images.filter(image => !baseline.referencePolicy.primaryIds.includes(image.id || '')));
    setPrimaryMin(baseline.referencePolicy.primaryMin); setAuxiliaryLimit(baseline.referencePolicy.auxiliaryMax); setUseFixedReferences(baseline.referencePolicy.useFixedReferences);
    setStyleLimit(baseline.referencePolicy.styleMax ?? MAX_REFERENCE_IMAGES); setReferenceImageLimit(baseline.referencePolicy.referenceMax ?? MAX_REFERENCE_IMAGES);
    setFixedReferences(savedFixedReferences); setModuleContext(savedModuleContext); setStyleGroups(module.styleGroups || []); setSkills(module.skills || []); setReproductionSkills([]); setReproduceSourceTaskId(null);
    setReproductionGlobalContext(null); setAppliedSource(null);
    setModuleSaveError('');
  }

  function applyUnifiedDefaults() {
    if (!draftLoaded || draftRestoring || quickPresetLock.current || presetSaveLock.current || submitting || pendingSubmission
      || moduleSaving || moduleDeleting || uploading || bannerUploading || ratioEditing) return;
    try {
      if (!settings?.templateDefaults) throw new Error('统一默认设置尚未读取，请重新读取通用设置后再试。');
      const defaults = parseStudioTemplateDefaults(settings.templateDefaults);
      const ratioIssue = studioFourToOneIssue(defaults.aspectRatio, settings.modelFourToOne?.[defaults.model] === true);
      if (ratioIssue) throw new Error(ratioIssue);
      if (styleGroups.some(group => group.unavailable)) throw new Error('当前风格组不可用，请先处理后再套用统一默认。');
      const styles = styleGroups.reduce((total, group) => total + group.referenceCount, 0);
      const fixedCount = fixedEditable ? fixedReferences.length : module.fixedReferenceCount ?? savedFixedReferences.length;
      const ordinary = auxiliaryImages.length + (defaults.useFixedReferences ? fixedCount : 0);
      if (images.length > defaults.primaryMax || styles > defaults.styleMax || ordinary > defaults.referenceMax
        || styles + ordinary > defaults.auxiliaryMax || images.length + styles + ordinary > MAX_REFERENCE_IMAGES) {
        throw new Error('统一默认的图片上限低于当前已选素材，未套用；请先调整默认上限或自行移除素材。');
      }
      // Parameters only: retain all content and source identities. The existing draft signature invalidates quotations.
      setPrimaryMin(defaults.primaryMin); setReferenceLimit(defaults.primaryMax); setStyleLimit(defaults.styleMax);
      setReferenceImageLimit(defaults.referenceMax); setAuxiliaryLimit(defaults.auxiliaryMax); setUseFixedReferences(defaults.useFixedReferences);
      setModuleModel(defaults.model); setQuality(defaults.quality); setResolution(defaults.resolution);
      setCount(defaults.count); setAspectRatio(defaults.aspectRatio);
      if (reproduceSourceTaskId) exitReproductionMode();
      setUnifiedDefaultsError(''); setError('');
      setSaveStatus('已套用统一默认，尚未保存；正文和素材保留。');
    } catch (cause) { setUnifiedDefaultsError(cause instanceof Error ? cause.message : '统一默认未套用，请重试'); }
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
    if (presetSaveLock.current || quickPresetLock.current || moduleSaving || draftRestoring || submitting || pendingSubmission) return;
    await askName('模板名称', name, { title: '另存为模板', confirmLabel: '保存模板', maxLength: 80, onSubmit: async presetName => {
      presetSaveLock.current = true; setPresetSaving(true);
      try {
        const created = await readResponse(await fetch('/api/image-studio/presets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          ...currentPresetDraft(), name: presetName,
        }) }));
        onModuleChange({ ...module, sourcePresetId: created.id, sourcePresetShared: created.is_shared === true, sourcePresetOwnedByViewer: true, sourcePresetCanManageSharing: isAdmin });
        setSaveStatus('模板已保存'); setSavedAsSignature(generationDraft);
        void loadQuickPresets();
      } finally { presetSaveLock.current = false; setPresetSaving(false); }
    } });
  }

  const loadQuickPresets = useCallback(async () => {
    setQuickPresetsLoading(true); setQuickPresetsError('');
    try {
      const result = await readResponse(await fetch(`/api/image-studio/presets?moduleId=${encodeURIComponent(module.id)}`, { cache: 'no-store' }));
      setQuickPresets(result.presets || []);
      return result.presets as QuickStudioPreset[];
    } catch (cause) { setQuickPresetsError(cause instanceof Error ? cause.message : '快捷模板读取失败'); return null; }
    finally { setQuickPresetsLoading(false); }
  }, [module.id, userId]);
  useEffect(() => { if (active && module.saved) void loadQuickPresets(); }, [active, module.saved, quickPresetVersion, loadQuickPresets]);

  async function applyQuickPreset(preset: QuickStudioPreset) {
    if (quickPresetLock.current || presetSaveLock.current || !draftLoaded || draftRestoring || submitting || pendingSubmission || uploading || bannerUploading || moduleSaving || moduleDeleting || ratioEditing) return;
    quickPresetLock.current = true; setQuickPresetApplying(preset.id); setError('');
    const sequence = draftRestoreSequence.current;
    setDraftRestoring(true);
    try {
      const available = await loadQuickPresets();
      if (!available || sequence !== draftRestoreSequence.current) return;
      const current = available.find(item => item.id === preset.id);
      if (!current) throw new Error('这个快捷模板已不可用，请重新选择。');
      if (!current.referencesAvailable) throw new Error('快捷模板中的部分参考图已不可用，当前设置未被替换。');
      const policy = current.referencePolicy || moduleReferencePolicy({ ...module, images: current.images, referenceLimit: current.referenceLimit, referencePolicy: undefined });
      const restored = await restoreTemporaryDraft({ ...current, images: current.images.map(image => ({ id: image.id })),
        referencePolicy: policy, fixedReferences: current.fixedReferences, reproduceSourceTaskId: null });
      if (restored) { setAppliedSource(null); setReproductionGlobalContext(null); setSaveStatus(`已套用：${current.name}`); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '快捷模板套用失败'); }
    finally { quickPresetLock.current = false; setQuickPresetApplying(null); setDraftRestoring(false); }
  }

  async function restoreTemporaryDraft(saved = recoverableDraft, automatic = false) {
      const sequence = ++draftRestoreSequence.current;
      setDraftRestoring(true);
      if (saved) {
        let restoredImages: UploadedAssetPayload[] = [];
        let restoredTask: StudioTask | undefined;
        let restoredStyles: StudioStyleSummary[] | undefined;
        let restoredSkills: SkillSummary[] | undefined;
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
          if (Array.isArray(saved.skillIds)) {
            const ids = saved.skillIds.filter((id: unknown): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)).slice(0, 12);
            const all: SkillSummary[] = (await readResponse(await fetch('/api/image-studio/skills', { cache: 'no-store' }))).skills;
            restoredSkills = ids.map((id: string) => all.find(skill => skill.id === id) || { id, name: 'skills不可用', unavailable: true });
          }
          if (typeof saved.reproduceSourceTaskId === 'string') {
            if (saved.reproduceSourceTaskId.length > 120) throw new Error('历史任务编号无效，请恢复模板默认设置。');
            const history = await readResponse(await fetch(`/api/image-studio/tasks?moduleId=${encodeURIComponent(module.id)}&taskId=${encodeURIComponent(saved.reproduceSourceTaskId)}`, { cache: 'no-store' }));
            restoredTask = history.tasks?.find((task: StudioTask) => task.id === saved.reproduceSourceTaskId);
            if (!restoredTask?.snapshot?.sourceAvailable) throw new Error('这份草稿的历史来源已不可用，当前模板未被替换。');
            if (restoredTask.snapshot.contextAvailable === false) throw new Error('这条旧记录没有保存完整上下文，当前设置未被替换。');
            recoveredFixedCount = restoredTask.snapshot.fixedReferenceCount || 0;
            recoveredStyles = restoredTask.snapshot.styleGroups || [];
          }
        } catch (cause) {
          if (sequence === draftRestoreSequence.current) { blockedDraftSignature.current = generationDraft; setError(cause instanceof Error ? cause.message : '草稿参考图读取失败，请重试'); setRecoverableDraft(saved); setDraftRestoring(false); }
          return false;
        }
        if (sequence !== draftRestoreSequence.current) return false;
        if (typeof saved.prompt === 'string') setPrompt(saved.prompt.slice(0, 20000));
        if (evolution && saved.evolution && ['increase', 'decrease'].includes(saved.evolution.direction) && typeof saved.evolution.manual === 'boolean') setEvolutionInput({ direction: saved.evolution.direction, manual: saved.evolution.manual });
        if (saved.resultView === 'images' || saved.resultView === 'batch') setResultView(saved.resultView);
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
        if (restoredSkills) setSkills(restoredSkills);
        if (restoredTask) setReproductionSkills(restoredTask.snapshot?.skills || []);
        if (recoveredFixedCount !== undefined) setReproductionFixedCount(recoveredFixedCount);
        if (recoveredStyles) setReproductionStyles(recoveredStyles);
        if (Object.prototype.hasOwnProperty.call(saved, 'reproduceSourceTaskId')) {
          setReproduceSourceTaskId(typeof saved.reproduceSourceTaskId === 'string' && saved.reproduceSourceTaskId.length <= 120 ? saved.reproduceSourceTaskId : null);
          setReproductionReferences(isAdmin ? restoredTask?.snapshot?.fixedReferenceImages || [] : []);
          setReproductionGlobalContext(isAdmin && restoredTask?.snapshot?.contextAvailable ? restoredTask.snapshot.globalContext ?? '' : null);
          setReproductionContextConfigured(restoredTask?.snapshot?.contextConfigured === true);
          if (isAdmin && restoredTask?.snapshot?.contextAvailable) setModuleContext(restoredTask.snapshot.moduleContext ?? '');
        }
      }
      setRecoverableDraft(null);
      blockedDraftSignature.current = null;
      setSavedAsSignature('');
      setDraftRestoring(false);
      if (!automatic) setSaveStatus('已恢复设置');
      return true;
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
    try { localStorage.setItem(draftKey, JSON.stringify({ schemaVersion: 2, resultView, evolution: evolution ? evolutionInput : undefined, prompt, count, referenceLimit, referencePolicy, aspectRatio, resolution,
      images: [...images, ...auxiliaryImages].map(image => ({ id: image.id })), context: contextEditable ? moduleContext : undefined,
      fixedReferences: fixedEditable ? fixedReferences.map(image => ({ id: image.id, note: image.note })) : undefined,
      skillIds: skills.map(group => group.id), styleGroupIds: styleGroups.map(group => group.id), model: moduleModel, quality, reproduceSourceTaskId: reproduceSourceTaskId || null, revision: moduleRevision }));
      setPersistedDraftSignature(generationDraft); }
    catch { setError('临时草稿未能保存到浏览器，请勿刷新；当前内容仍可生成或另存为。'); }
  }, [draftLoaded, draftRestoring, recoverableDraft, draftKey, generationDraft, reproduceSourceTaskId, moduleRevision, contextEditable, fixedEditable, resultView]);

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
      || presetSaving || quickPresetApplying || draftRestoring || !name.trim() || !Number.isInteger(count) || count < 1 || count > 8 || autoSaveAttempt.current === automaticSnapshot) return;
    const timer = window.setTimeout(() => saveAutomatically.current(), 500);
    return () => window.clearTimeout(timer);
  }, [draftLoaded, automaticDirty, automaticSnapshot, moduleSaving, moduleDeleting, uploading, bannerUploading, submitting, pendingSubmission, presetSaving, quickPresetApplying, draftRestoring, name, count]);

  async function changeGroup(value: string) {
    const next = value !== '__other__' ? value : (await askName('输入新分组名称（最多 40 字）', '未命名分组', { title: '创建分组', confirmLabel: '创建分组', maxLength: 40 }))?.trim().slice(0, 40);
    if (next) { setGroupName(next); onMetadataChange(module.id, name, next, true); }
  }

  const loadTasks = useCallback(async (cursor?: string, action: 'initial' | 'refresh' | 'silent' | 'view' = 'refresh') => {
    const readPages = async (signal?: AbortSignal, entry = false) => {
      const count = cursor ? 1 : Math.min(20, loadedTaskPages.current);
      let next: string | undefined = cursor;
      let result: { tasks: StudioTask[]; nextCursor: string | null; total: number; entrySnapshot?: string } | null = null;
      let entrySnapshot: string | undefined;
      const rows: StudioTask[] = [];
      for (let read = 0; read < count; read++) {
        const query = new URLSearchParams({ moduleId: module.id });
        if (next) query.set('cursor', next);
        if (entry && read === 0 && !cursor) query.set('attention', 'entry');
        const page = await readResponse(await fetch(`/api/image-studio/tasks?${query}`, { cache: 'no-store', signal }));
        rows.push(...page.tasks);
        entrySnapshot ||= page.entrySnapshot;
        result = { ...page, entrySnapshot };
        next = page.nextCursor || undefined;
        if (!next) break;
      }
      return { ...result!, tasks: Array.from(new Map(rows.map(task => [task.id, task])).values()) };
    };
    if (templateWorkbench) {
      const scope = `${userId}:${module.id}`;
      if (action === 'initial' && taskReadLoaded.current) action = 'silent';
      if (action !== 'view' && taskReadRequest.current?.scope === scope && (taskReadRequest.current.action !== 'silent' || action === 'silent')) return;
      taskReadRequest.current?.controller.abort();
      const request = { scope, controller: new AbortController(), action };
      const requestedToken = currentView.current.token;
      taskReadRequest.current = request;
      const currentRequest = () => taskReadRequest.current === request && taskReadScopeRef.current === scope && !request.controller.signal.aborted;
      if (action !== 'silent') {
        setTaskReadAction(cursor ? 'more' : action === 'view' ? 'refresh' : action);
        setLoadingTasks(action === 'initial');
        setTasksError('');
        setTaskRetryCursor(cursor);
      }
      try {
        const result = await readPages(request.controller.signal, action === 'view');
        if (!currentRequest()) return;
        taskReadLoaded.current = true;
        setTasks(current => {
          const fresh: StudioTask[] = result.tasks.filter((task: StudioTask) => !deletedIds.current.has(task.id));
          const ids = new Set(fresh.map(task => task.id));
          const previous = current.filter(task => !ids.has(task.id) && !deletedIds.current.has(task.id));
          return cursor ? [...previous, ...fresh] : fresh;
        });
        setNextCursor(result.nextCursor); setTaskTotal(result.total);
        if (cursor) { loadedMore.current = true; loadedTaskPages.current++; }
        setTasksError('');
        void onResultsAvailable();
        if (action === 'view' && !cursor && currentView.current.active && currentView.current.token === requestedToken && typeof result.entrySnapshot === 'string') {
          await onTemplateEntered(module.id, result.entrySnapshot, request.controller.signal);
        }
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
    const scope = `${userId}:${module.id}`;
    try {
      const result = await readPages();
      if (taskReadScopeRef.current !== scope) return;
      setTasks(current => {
        const fresh: StudioTask[] = result.tasks.filter((task: StudioTask) => !deletedIds.current.has(task.id));
        const ids = new Set(fresh.map(task => task.id));
        const previous = current.filter(task => !ids.has(task.id) && !deletedIds.current.has(task.id));
        return cursor ? [...previous, ...fresh] : fresh;
      });
      setNextCursor(result.nextCursor); setTaskTotal(result.total);
      if (cursor) { loadedMore.current = true; loadedTaskPages.current++; }
      setTasksError('');
    } catch (e) { if (taskReadScopeRef.current === scope) setTasksError(e instanceof Error ? e.message : '读取记录失败'); }
    finally { if (taskReadScopeRef.current === scope) { listLock.current = false; setLoadingTasks(false); } }
  }, [module.id, userId, templateWorkbench, onResultsAvailable, onTemplateEntered]);
  useEffect(() => {
    setTasks([]); setSelected([]); setPreview(null); setNextCursor(null); setTaskTotal(null); loadedTaskPages.current = 1; setTasksError('');
    listLock.current = false;
    setViewedResults(null); requestedReadToken.current = 0; readAttemptToken.current = 0;
    setLoadingTasks(true); setTaskReadAction('initial'); loadedMore.current = false; taskReadLoaded.current = false;
    return () => {
      const request = taskReadRequest.current;
      if (request?.scope === taskReadScope) { request.controller.abort(); taskReadRequest.current = null; }
    };
  }, [taskReadScope, templateWorkbench]);
  useEffect(() => { if (visible) void loadTasks(undefined, 'initial'); }, [visible, loadTasks]);
  useEffect(() => {
    if (templateWorkbench && active && viewToken && requestedReadToken.current !== viewToken) {
      requestedReadToken.current = viewToken;
      void loadTasks(undefined, 'view');
    }
    return () => {
      const request = taskReadRequest.current;
      if (request?.action === 'view') { request.controller.abort(); taskReadRequest.current = null; setTaskReadAction('idle'); setLoadingTasks(false); }
    };
  }, [templateWorkbench, active, viewToken, loadTasks]);
  const hasPending = tasks.some(task => task.status === 'queued' || task.status === 'running');
  useImageBillingRefresh(tasks, () => loadTasks(undefined, 'silent'), visible);
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
  useEffect(() => () => { taskReadScopeRef.current = ''; }, []);

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

  function generationPayload(retryTask?: StudioTask, requestId = crypto.randomUUID()) {
    const historicalEvolution = (retryTask?.snapshot as (StudioSnapshot & { evolution?: EvolutionInput }) | undefined)?.evolution;
    return { requestId, prompt: retryTask?.prompt ?? prompt,
      moduleId: module.id, model: retryTask?.model || moduleModel, quality: retryTask?.quality || quality, reproduceFromTaskId: reproduceSourceTaskId || undefined, count: retryTask ? 1 : count, aspectRatio: retryTask?.aspectRatio || aspectRatio, resolution: retryTask?.snapshot?.resolution || resolution, revision: settings!.revision,
      referenceIds: retryTask?.referenceIds || moduleDraft.referenceIds,
      ...(historicalEvolution || evolution ? { evolution: historicalEvolution || evolutionInput } : {}),
      draft: { moduleContext: contextEditable ? moduleContext : undefined, globalContext: isAdmin ? effectiveGlobalContext : undefined,
        fixedReferences: !reproduceSourceTaskId && fixedEditable ? fixedReferencePayload(fixedReferences) : undefined,
        skillIds: reproduceSourceTaskId ? undefined : skills.map(group => group.id),
        skillVersions: reproduceSourceTaskId ? undefined : Object.fromEntries(skills.filter(group => group.promptVersion).map(group => [group.id, group.promptVersion!])),
        styleGroupIds: reproduceSourceTaskId ? undefined : styleGroups.map(group => group.id), referencePolicy } };
  }
  async function submit(retryTask?: StudioTask) {
    if (batch.mode === 'batch' && batch.pending && !retryTask) { await batch.query(); return; }
    if (pendingSubmission) { await querySubmission(); return; }
    if (!settings || submitLock.current || moduleDeleteLock.current || quickPresetLock.current || presetSaveLock.current || ratioEditing || draftRestoring) return;
    if (evolutionConflict) { setError(evolutionConflict); return; }
    if (batch.mode === 'batch' && !retryTask) {
      submitLock.current = true; setSubmitting(true);
      try { if (await batch.submit(generationPayload())) { setResultView('images'); await loadTasks(undefined, 'silent'); } }
      finally { submitLock.current = false; setSubmitting(false); }
      return;
    }
    if (!pendingSubmission && (images.length < primaryMin || images.length > referenceLimit || auxiliaryCount > auxiliaryLimit || styleImageCount > styleLimit || ordinaryReferenceCount > referenceImageLimit || effectiveReferenceCount > MAX_REFERENCE_IMAGES
      || activeFixedReferences.some(item => item.available === false) || activeStyles.some(group => group.unavailable))) {
      setError('请检查主图数量、辅助参考数量和图片可用性。'); return;
    }
    const currentPayload = generationPayload(retryTask);
    const expectedFormSignature = liveGenerationSignature.current;
    const signature = JSON.stringify([userId, Object.fromEntries(Object.entries(currentPayload).filter(([key]) => key !== 'requestId'))]);
    const reusableQuote = billingQuote?.signature === signature
      && (!billingQuote.quote.expiresAt || Date.parse(billingQuote.quote.expiresAt) > Date.now()) ? billingQuote : null;
    const payload = reusableQuote ? generationPayload(retryTask, reusableQuote.requestId) : currentPayload;
    const ratioIssue = studioFourToOneIssue(payload.aspectRatio, settings.modelFourToOne?.[payload.model] === true);
    if (ratioIssue) { setError(ratioIssue); return; }
    submitLock.current = true; setSubmitting(true); setError('');
    let confirmedQuote = reusableQuote?.quote || null;
    try {
      if (!confirmedQuote) {
        const quote = await readResponse(await fetch('/api/image-studio/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) })) as StudioImageQuote;
        if (liveGenerationSignature.current !== expectedFormSignature) throw new Error('本次参数已变化，报价未用于生成，请重新确认。');
        if (!['fixed', 'actual'].includes(quote.billingMode) || !Number.isFinite(quote.unitCredits) || quote.unitCredits < 0
          || !Number.isFinite(quote.estimatedCredits) || quote.estimatedCredits < 0
          || (quote.billingQuoteId !== null && typeof quote.billingQuoteId !== 'string')
          || !quote.expiresAt || !Number.isFinite(Date.parse(quote.expiresAt)) || Date.parse(quote.expiresAt) <= Date.now()
          || (quote.billingMode === 'actual' && !quote.billingQuoteId)) {
          throw new Error('本次报价信息不完整，尚未提交图片。');
        }
        const baseline = !actualQuoteRequired && moduleUnitCredits != null && Number.isFinite(moduleUnitCredits) && moduleUnitCredits >= 0
          ? Math.ceil(moduleUnitCredits * payload.count) : null;
        if (baseline === null || Math.ceil(quote.estimatedCredits) > baseline) {
          setBillingQuote({ signature, requestId: payload.requestId, quote });
          setError(`本次预估为 ${Math.ceil(quote.estimatedCredits)} 点数，尚未生成；请核对后再次点击。`);
          submitLock.current = false; setSubmitting(false);
          return;
        }
        confirmedQuote = quote;
        setBillingQuote({ signature, requestId: payload.requestId, quote });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '报价未确认，尚未提交图片。');
      submitLock.current = false; setSubmitting(false);
      return;
    }
    if (!confirmedQuote) { setError('本次报价未确认，尚未提交图片。'); submitLock.current = false; setSubmitting(false); return; }
    if (confirmedQuote.expiresAt && Date.parse(confirmedQuote.expiresAt) <= Date.now()) {
      setBillingQuote(null); setError('本次报价已过期，尚未提交图片；请再次点击获取新报价。');
      submitLock.current = false; setSubmitting(false); return;
    }
    try {
      const saved = JSON.stringify({ requestId: payload.requestId });
      localStorage.setItem(pendingKey, saved);
      if (localStorage.getItem(pendingKey) !== saved) throw new Error('Request identity not saved');
    } catch { setError('提交编号未能保存，尚未提交生成。请允许浏览器保存数据后再试。'); submitLock.current = false; setSubmitting(false); return; }
    let ambiguous = true;
    try {
      const submission = { ...payload, ...(confirmedQuote.billingQuoteId ? { billingQuoteId: confirmedQuote.billingQuoteId } : {}), maxEstimatedCost: Math.ceil(confirmedQuote.estimatedCredits) };
      setBillingQuote(null);
      const response = await fetch('/api/image-studio/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(submission), signal: AbortSignal.timeout(20000) });
      if (response.status >= 400 && response.status < 500) { ambiguous = false; setPendingSubmission(null); try { localStorage.removeItem(pendingKey); sessionStorage.removeItem(pendingKey); } catch {} if (response.status === 409) onReloadSettings(); await readResponse(response); }
      else {
        const value = await readResponse(response);
        if (typeof value.batchId !== 'string' || !/^[a-f0-9]{64}$/.test(value.batchId)) throw new Error('提交结果待确认，请查询这次提交。');
        watchGenerationCompletion(userId, payload.requestId, 'images', payload.count);
        setPendingSubmission(null); try { localStorage.removeItem(pendingKey); sessionStorage.removeItem(pendingKey); } catch {} await loadTasks();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '提交结果未确认');
      // Reuse the exact request ID after ambiguous transport failures.
      setPendingSubmission(ambiguous ? { requestId: payload.requestId } : null);
    } finally { submitLock.current = false; setSubmitting(false); }
  }

  function restoreDisabledReason(task: StudioTask) {
    if (!studioTaskHasDeliveredAsset(task)) return '图片尚未交付完成，不能恢复设置。';
    if (!task.snapshot) return '这条记录没有完整设置，不能套用。';
    if (task.snapshot.contextAvailable === false) return '这条旧记录没有保存完整上下文，无法完整恢复。';
    if (!active) return '请先打开此模板，再套用设置。';
    if (!draftLoaded || draftRestoring) return '草稿正在恢复，请稍后套用。';
    if (quickPresetLock.current || presetSaveLock.current) return '快捷模板正在保存或套用，请稍后。';
    if (pendingSubmission) return '上次提交尚未确认，请先核对生成记录。';
    if (submitting || submitLock.current) return '正在提交，请稍后套用。';
    if (uploading || bannerUploading || uploadLock.current) return '正在上传，请完成后套用。';
    if (moduleSaving || moduleSaveLock.current || moduleDeleting || moduleDeleteLock.current) return '模板正在保存或移除，请稍后套用。';
    if (ratioEditing) return '请先完成比例编辑，再套用设置。';
    return '';
  }

  function restoreTask(task: StudioTask): string | null {
    const reason = restoreDisabledReason(task);
    if (reason) return reason;
    const snapshot = task.snapshot!;
    const nextModel = snapshot.model || moduleModel;
    const nextCount = Math.max(1, Math.min(8, snapshot.count || 1));
    let nextRatio: string;
    try { nextRatio = normalizeStudioRatio(snapshot.aspectRatio || 'auto'); } catch { nextRatio = 'auto'; }
    const nextResolution = normalizeImageResolution(nextModel, snapshot.resolution || defaultImageResolution(nextModel));
    const nextQuality = normalizeImageStudioQuality(nextModel, typeof snapshot.quality === 'string' ? snapshot.quality : quality);
    setPrompt(snapshot.prompt || '');
    const restoredEvolution = (snapshot as StudioSnapshot & { evolution?: EvolutionInput }).evolution;
    const nextEvolution = evolution ? restoredEvolution && ['increase', 'decrease'].includes(restoredEvolution.direction) ? { direction: restoredEvolution.direction, manual: restoredEvolution.manual === true } : { direction: evolution.defaultDirection, manual: false } : undefined;
    if (nextEvolution) setEvolutionInput(nextEvolution);
    setCount(nextCount); setAspectRatio(nextRatio); setResolution(nextResolution);
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
    setReproductionStyles(snapshot.styleGroups || []); setReproductionSkills(snapshot.skills || []);
    const nextContext = isAdmin && snapshot.contextAvailable ? snapshot.moduleContext ?? '' : moduleContext;
    const nextGlobalContext = isAdmin && snapshot.contextAvailable ? snapshot.globalContext ?? '' : globalContextDraft;
    if (isAdmin && snapshot.contextAvailable) setModuleContext(nextContext);
    setReproductionGlobalContext(isAdmin && snapshot.contextAvailable ? nextGlobalContext ?? '' : null);
    setReproductionContextConfigured(snapshot.contextConfigured === true);
    if (typeof snapshot.model === 'string' && snapshot.model) setModuleModel(snapshot.model);
    if (typeof snapshot.quality === 'string') setQuality(normalizeImageStudioQuality(snapshot.model || moduleModel, snapshot.quality));
    setReproduceSourceTaskId(snapshot.sourceAvailable ? task.id : null);
    // Bind to the expected post-restore inputs, not the render before the state batch applies.
    const nextPolicy: StudioReferencePolicy = { primaryIds: transient.filter(image => image && primaryIds.includes(image.id || '')).flatMap(image => image.id ? [image.id] : []),
      primaryMin: snapshot.referencePolicy?.primaryMin ?? 0, primaryMax: snapshot.referencePolicy?.primaryMax ?? Math.max(1, transient.length),
      auxiliaryMax: snapshot.referencePolicy?.auxiliaryMax ?? MAX_REFERENCE_IMAGES, styleMax: snapshot.referencePolicy?.styleMax ?? MAX_REFERENCE_IMAGES,
      referenceMax: snapshot.referencePolicy?.referenceMax ?? MAX_REFERENCE_IMAGES, useFixedReferences: snapshot.referencePolicy?.useFixedReferences ?? true };
    const nextImages = [...transient.filter(image => image && primaryIds.includes(image.id || '')), ...transient.filter(image => image && !primaryIds.includes(image.id || ''))];
    const signature = JSON.stringify({ inputs: { ...generationInputs, evolution: nextEvolution, prompt: snapshot.prompt || '', count: nextCount, referenceLimit: nextPolicy.primaryMax,
      aspectRatio: nextRatio, resolution: nextResolution, referenceIds: nextImages.map(image => image.id), model: nextModel, quality: nextQuality, referencePolicy: nextPolicy, context: nextContext },
      source: snapshot.sourceAvailable ? task.id : null, references: snapshot.fixedReferenceImages || [],
      fixedCount: snapshot.fixedReferenceCount ?? snapshot.fixedReferenceImages?.length ?? 0, styles: snapshot.styleGroups || [], skills: snapshot.skills || [], globalContext: nextGlobalContext });
    setAppliedSource({ taskId: task.id, label: `${module.name} · ${task.ordinal}`, signature, modified: false });
    return null;
  }

  function exitReproductionMode(message = '已退出历史复现模式，接下来会使用当前模块上下文。') {
    setReproduceSourceTaskId(null);
    setReproductionGlobalContext(null);
    setError(''); setSaveStatus(message);
  }

  async function download(ids: string[]) {
    if (downloadBusy) return;
    if (ids.some(id => tasks.some(task => task.id === id && !studioTaskHasDeliveredAsset(task)))) {
      setError('图片尚未交付完成，请完成后再下载'); return;
    }
    setDownloadBusy(true); setError(''); setDownloadReady(null);
    const expected = taskReadScope;
    try {
      const query = new URLSearchParams(); ids.forEach(id => query.append('id', id));
      const url = `/api/image-studio/download?${query}`;
      const name = ids.length === 1 ? 'generated-image.png' : 'generated-images.zip';
      await handImageDownloadToBrowser(url, name, () => taskReadScopeRef.current === expected);
      if (taskReadScopeRef.current !== expected) return;
      setDownloadReady({ url, name });
      setSelected([]); setDownloadMode(false);
    } catch (e) { if (taskReadScopeRef.current === expected) setError(e instanceof Error ? e.message : '下载失败，请重试'); }
    finally { if (taskReadScopeRef.current === expected) setDownloadBusy(false); }
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
  const moduleUnitCredits = settings ? settings.prices?.[moduleModel] ?? null : module.prices[moduleModel] ?? null;
  const estimatePayload = settings ? generationPayload(undefined, '') : null;
  const estimateSignature = estimatePayload ? JSON.stringify([userId, Object.fromEntries(Object.entries(estimatePayload).filter(([key]) => key !== 'requestId'))]) : '';
  liveGenerationSignature.current = estimateSignature;
  useEffect(() => {
    if (!actualQuoteRequired || !estimateSignature || hidden || !active || !quoteVisible || !draftLoaded || draftRestoring
      || submitting || pendingSubmission || batch.mode !== 'single'
      || !Number.isInteger(count) || count < 1 || count > 8) return;
    if (billingQuote?.signature === estimateSignature && billingQuote.quote.expiresAt
      && Date.parse(billingQuote.quote.expiresAt) > Date.now()) return;
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      const requestId = crypto.randomUUID();
      const payload = { ...JSON.parse(estimateSignature)[1], requestId };
      void fetch('/api/image-studio/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]) })
        .then(readResponse).then((quote: StudioImageQuote) => {
          if (abort.signal.aborted || liveGenerationSignature.current !== estimateSignature) return;
          if (!Number.isFinite(quote.estimatedCredits) || quote.estimatedCredits < 0 || !quote.expiresAt
            || Date.parse(quote.expiresAt) <= Date.now() || quote.billingMode === 'actual' && !quote.billingQuoteId) return;
          setBillingQuote({ signature: estimateSignature, requestId, quote });
        }).catch(() => { /* Unknown pricing stays unknown; this never generates. */ });
    }, 500);
    return () => { window.clearTimeout(timer); abort.abort(); };
  }, [actualQuoteRequired, estimateSignature, hidden, active, quoteVisible, draftLoaded, draftRestoring, submitting, pendingSubmission, batch.mode, count, billingQuote]);
  const visibleQuote = billingQuote?.signature === estimateSignature
    && (!billingQuote.quote.expiresAt || Date.parse(billingQuote.quote.expiresAt) > Date.now()) ? billingQuote.quote : null;
  useEffect(() => {
    if (previousEstimateSignature.current && previousEstimateSignature.current !== estimateSignature) setBillingQuote(null);
    previousEstimateSignature.current = estimateSignature;
  }, [estimateSignature]);
  useEffect(() => {
    if (!billingQuote?.quote.expiresAt) return;
    const delay = Date.parse(billingQuote.quote.expiresAt) - Date.now();
    if (delay <= 0) { setBillingQuote(null); return; }
    const timer = window.setTimeout(() => setBillingQuote(current => current?.requestId === billingQuote.requestId ? null : current), delay);
    return () => window.clearTimeout(timer);
  }, [billingQuote]);
  const selectedProviderReady = settings?.modelReady?.[moduleModel] ?? settings?.providerReady;
  const selectedFourToOne = settings?.modelFourToOne?.[moduleModel] === true;
  const ratioIssue = studioFourToOneIssue(aspectRatio, selectedFourToOne);
  const hasContext = reproduceSourceTaskId ? reproductionContextConfigured : Boolean((isAdmin ? effectiveGlobalContext?.trim() : settings?.contextConfigured) || (contextEditable ? moduleContext.trim() : moduleContextConfigured));
  const ready = Boolean(selectedProviderReady && moduleUnitCredits !== null && settings && !settingsError);
  const generationFeedback: StudioFeedback | null = batch.mode === 'batch' && batch.pending ? batch.busy ? { message: '正在核对原批次，不会重新提交生成', tone: 'progress' } : null
    : evolutionConflict ? { message: evolutionConflict, tone: 'warning' }
    : batch.mode === 'batch' && batch.blocker ? { message: batch.blocker, tone: 'info' }
    : queryingSubmission ? { message: '正在查询这次提交，不会再次生成。', tone: 'progress' }
    : pendingSubmission ? submitting ? { message: '正在处理当前请求，请稍候再查询。', tone: 'progress' }
      : moduleDeleting ? { message: '正在删除模板，请等待操作结束后再查询。', tone: 'progress' } : null
    : sourceSharingBlocked ? { message: '该模板已停止共享，请换一个可用模板。', tone: 'error' }
    : submitting ? { message: '正在提交，请等待结果，不要重复点击。', tone: 'progress' }
    : quickPresetApplying || presetSaving ? { message: quickPresetApplying ? '正在套用快捷模板。' : '正在保存快捷模板。', tone: 'progress' }
    : uploading || bannerUploading ? { message: '图片还在上传或处理，请等待图片显示后再生成。', tone: 'progress' }
    : draftRestoring ? { message: '正在恢复上次使用的图片和设置。', tone: 'progress' }
    : ratioEditing ? { message: '图片比例尚未确认，请先完成比例设置。', tone: 'info' }
    : settingsError ? { message: `设置暂不可用：${settingsError}`, tone: 'error' }
    : !settings ? { message: '正在读取生成设置，请稍候；长时间无变化请刷新页面。', tone: 'progress' }
    : !selectedProviderReady ? { message: '当前模型的图片服务尚未就绪，请换一个模型或联系管理员检查接口。', tone: 'warning' }
    : ratioIssue ? { message: ratioIssue, tone: 'warning' }
    : moduleUnitCredits === null ? { message: '当前模型尚未设置点数，请换一个模型或联系管理员配置。', tone: 'warning' }
    : activeFixedReferences.some(item => item.available === false) ? { message: '固定参考图已不可用，请关闭、移除或更换。', tone: 'error' }
    : activeStyles.some(group => group.unavailable) ? { message: '已选风格组不可用，请移除或重新选择。', tone: 'error' }
    : batch.mode === 'batch' && batch.source === 'folder' && primaryMin > 1 ? { message: `这个模板至少需要 ${primaryMin} 张主图，素材逐图每项只有 1 张；请选择当前正文模式。`, tone: 'warning' }
    : images.length < primaryMin && !(batch.mode === 'batch' && batch.source === 'folder') ? { message: `这个模板至少需要 ${primaryMin} 张主图，当前 ${images.length} 张。`, tone: 'warning' }
    : images.length > referenceLimit ? { message: `主图最多 ${referenceLimit} 张，请移除多余主图或调整上限。`, tone: 'warning' }
    : styleImageCount > styleLimit ? { message: `风格组最多传入 ${styleLimit} 张图片，当前 ${styleImageCount} 张。请调整上限或移除风格组。`, tone: 'warning' }
    : ordinaryReferenceCount > referenceImageLimit ? { message: `参考图最多 ${referenceImageLimit} 张，当前 ${ordinaryReferenceCount} 张（含启用的模板固定图）。`, tone: 'warning' }
    : auxiliaryCount > auxiliaryLimit ? { message: `辅助参考最多 ${auxiliaryLimit} 张，当前 ${auxiliaryCount} 张（包含模板图和风格组）。`, tone: 'warning' }
    : effectiveReferenceCount > MAX_REFERENCE_IMAGES ? { message: `当前通道最多传入 ${MAX_REFERENCE_IMAGES} 张图片，已选主图 ${images.length} 张、辅助参考 ${auxiliaryCount} 张，请减少辅助参考。`, tone: 'warning' }
    : !prompt.trim() && !effectiveReferenceCount && !hasContext && !(batch.mode === 'batch' && batch.source === 'folder') ? { message: '请填写画面要求，或添加主图。', tone: 'info' }
    : batch.mode === 'single' && (!Number.isInteger(count) || count < 1 || count > 8) ? { message: '生成张数应为1到8的整数，请修改张数。', tone: 'warning' }
    : !ready ? { message: '生成条件尚未就绪，请检查模型和上下文设置。', tone: 'warning' } : null;
  const likedResults = useLikedStudioResults<StudioTask>(userId, module.id, visible && !hidden && resultView === 'images', templateWorkbench);
  useEffect(() => { if (likedResults.liked) setResultView('images'); }, [likedResults.liked, resultView]);
  useEffect(() => {
    if (!likedResults.liked || likedResults.loading) return;
    const ids = new Set(likedResults.tasks.map(task => task.id));
    setSelected(current => current.every(id => ids.has(id)) ? current : current.filter(id => ids.has(id)));
  }, [likedResults.liked, likedResults.loading, likedResults.tasks]);
  const resultTasks = likedResults.liked ? likedResults.tasks.filter(task => !deletedIds.current.has(task.id)) : tasks;
  const resultError = likedResults.liked ? likedResults.error : tasksError;
  const resultLoading = likedResults.liked ? likedResults.loading : loadingTasks;
  const resultBusy = likedResults.liked ? likedResults.loading : loadingTasks || templateWorkbench && taskReadAction !== 'idle';
  const resultCursor = likedResults.liked ? likedResults.nextCursor : nextCursor;
  const refreshResults = () => { if (likedResults.liked) likedResults.refresh(); else void loadTasks(); };
  const previewableTasks = resultTasks.filter(task => studioTaskHasDeliveredAsset(task) && Boolean(task.asset.id));
  const readNextResultPage = useCallback(async () => {
    if (likedResults.liked) await likedResults.more();
    else if (nextCursor) await loadTasks(nextCursor);
  }, [likedResults.liked, likedResults.more, loadTasks, nextCursor]);
  function chooseResultFilter(liked: boolean) { setSelected([]); setDownloadMode(false); likedResults.choose(liked); setResultView('images'); }
  const sharedResults = resultTasks.map(task => {
    const image = studioTaskHasDeliveredAsset(task) ? studioTaskPreviewState(task) : null;
    return {
      id: task.id, task, label: `生成结果 ${task.ordinal}`, status: studioTaskPhase(task), billing: task.billing,
      pending: ['queued', 'running'].includes(task.status),
      waitingThumbnail: task.snapshot?.primaryReferenceImages?.[0]?.thumbnailUrl || task.snapshot?.primaryReferenceImages?.[0]?.originalUrl || undefined,
      applied: sourceApplied && appliedSource?.taskId === task.id,
      error: task.error,
      onViewed: () => observeResultVersion(studioResultVersion(task)),
      download: image ? () => { setSelected([task.id]); setDownloadMode(true); } : undefined,
      downloadDisabled: downloadBusy,
      downloadMessage: '已选择这张图片，请确认下载',
      media: image ? {
        src: image.src, thumbnailSrc: image.thumbnailSrc, alt: image.alt, title: image.title,
        contentKey: image.contentKey, fileName: image.fileName, previewKey: task.id,
        sourceVersion: image.resultVersion || undefined,
        safeDetails: { ...image.metadata, width: image.width, height: image.height, fileSize: image.fileSize },
        comparison: image.comparison,
        comparisonCandidates: [...taskComparisonCandidates(task), ...previewableTasks.filter(other => other.batchId === task.batchId).map(other => ({ src: other.asset!.original_url, thumbnailSrc: other.asset!.thumbnail_url, alt: `生成结果 ${other.ordinal}`, contentKey: `asset:${other.asset!.id}` as const }))],
        onImageLoaded: (src: string) => { if (src === image.src) observeResultVersion(image.resultVersion || null); },
      } : undefined,
    } satisfies GeneratedImageResult & { task: StudioTask };
  });

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
    const source = asset.originalUrl.startsWith('/api/') || !asset.id ? asset.originalUrl : `/api/content-reactions/media?key=${encodeURIComponent(`asset:${asset.id}`)}&variant=preview`;
    setPreview({ contentKey: asset.id ? `asset:${asset.id}` : undefined, src: source, thumbnailSrc: asset.thumbnailUrl || undefined, alt: `参考图 ${number}`, fileName: asset.fileName, width: asset.width || undefined, height: asset.height || undefined, fileSize: asset.fileSize });
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
    let skipAfterSuccess = false;
    if (replacing && !skipMainImageReminder(userId) && !(await confirm(`确认用「${uploadFiles[0].name}」替换当前主图？上传成功前旧主图会保留；取消不会更改当前内容。`, { title: '替换主图', confirmLabel: '替换主图', checkbox: { label: '以后替换主图不再提醒', onConfirm: checked => { skipAfterSuccess = checked; } } }))) return;
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
        if (replacing && skipAfterSuccess) saveMainImageReminder(userId, true);
      }
    } catch (e) { setError(e instanceof Error ? e.message : '上传失败'); }
    finally { uploadLock.current = false; setUploading(false); setUploadProgress(null); }
  }, [userId, confirm, images.length, auxiliaryImages.length, currentReferenceCap, currentAuxiliaryCap, fixedReferences.length, activeFixedCount, submitting, pendingSubmission, fixedEditable, referenceLimit]);

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
      <TemplateFavoriteTitle className={styles.moduleTitleRow} contentKey={module.saved ? `image_module:${module.id}` : undefined}>
        {nameEditing ? <input ref={nameInput} className={styles.moduleName} aria-label="模块名称" value={name} maxLength={80} onChange={event => setName(event.target.value)} onBlur={() => setNameEditing(false)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); setNameEditing(false); } }} /> : <button type="button" className={styles.moduleNameDisplay} title={name} aria-label={`编辑模块标题：${name}`} onClick={() => setNameEditing(true)}>{name}</button>}
      </TemplateFavoriteTitle>
      <div className={styles.counts}>
        {module.sourcePresetCanManageSharing && module.sourcePresetId && <button type="button" role="switch" aria-checked={module.sourcePresetShared === true} className={`${styles.presetSharing} ${styles.moduleSharing}`} title={templateWorkbench ? '只改变原模板的共享，不会发布当前模块草稿' : undefined} disabled={sharingId === module.sourcePresetId} onClick={() => void onToggleSharing(module)}>{templateWorkbench ? (module.sourcePresetShared === true ? '原模板已共享' : '共享原模板') : (module.sourcePresetShared === true ? '共享给同事' : '仅自己可见')}</button>}
        <ModuleGroupPicker value={groupName} groups={groups} protectedGroups={DEFAULT_GROUPS} disabled={!draftLoaded || draftRestoring || moduleSaving || automaticDirty || moduleDeleting || submitting || uploading || Boolean(pendingSubmission)} deleting={groupDeleting}
          onChange={value => void changeGroup(value)} onDelete={onDeleteGroup} />
        {(moduleSaving || moduleSaveError) && <span role="status" className={styles.muted}>{moduleSaving ? '保存中' : '保存失败'}</span>}
        <span className={styles.contextEntry}><button type="button" disabled={!draftLoaded || draftRestoring} onClick={openModuleDialog}><Settings size={17} />模块上下文</button></span>
        <button type="button" className={templateWorkbench ? styles.moduleDeleteIcon : undefined} title={module.id === `default-${userId}` ? (templateWorkbench ? '默认模块需要保留' : '默认模板需要保留') : (templateWorkbench ? '删除模块' : '删除模板')} aria-label={moduleDeleting ? '正在删除模块' : `删除${templateWorkbench ? '模块' : '模板'}：${name}`} aria-busy={moduleDeleting || undefined}
          disabled={module.id === `default-${userId}` || moduleDeleting || moduleSaving || submitting || uploading || bannerUploading || Boolean(pendingSubmission)}
          onClick={() => void deleteModule()}>{moduleDeleting ? <LoaderCircle size={17} className={styles.spinner} /> : <Trash2 size={17} />}{!templateWorkbench && (moduleDeleting ? '删除中' : '删除模板')}</button>
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
        {(appliedSource || reproduceSourceTaskId) && <p role="status" className={styles.appliedSource}>
          {appliedSource ? <span title={sourceApplied ? '已套用历史设置' : '来源已修改'}>{appliedSource.label}</span> : '历史复现'}
          <span>不自动生成</span>
          {reproduceSourceTaskId && <button type="button" title="退出历史复现，恢复当前模块上下文" onClick={() => exitReproductionMode()}>退出复现</button>}
        </p>}
        <div className={templateWorkbench ? styles.materialCluster : undefined}>
        <section className={`${styles.materialSection} ${templateWorkbench ? styles.primaryMaterials : ''}`} aria-label="主图">
          {!templateWorkbench && <header className={styles.materialHeading}><h3>主图</h3>
            <select aria-label="主图数量上限" value={referenceLimit} disabled={uploading || submitting || Boolean(pendingSubmission)} onChange={event => {
              const next = Number(event.target.value);
              if (next < images.length || next < primaryMin) { setError('上限不能低于当前主图数量或最少要求，请先调整。'); return; }
              setReferenceLimit(next);
            }}>{Array.from({ length: MAX_REFERENCE_IMAGES }, (_, index) => index + 1).map(value => <option key={value} value={value}>最多 {value} 张</option>)}</select>
            <span title={`已选 ${images.length} 张主图`}><b>{images.length}张</b></span>
            <button type="button" className={styles.mainImageReminder} title="替换主图提醒设置" aria-label="替换主图提醒设置" onClick={() => void confirm('此设置仅影响替换主图提醒，不影响生成费用、变价或权限确认。', { title: '主图提醒', confirmLabel: '保存设置', checkbox: { label: '每次替换主图前提醒', checked: !skipMainImageReminder(userId) }, onSubmit: async (_value, checked) => saveMainImageReminder(userId, !checked) })}><Settings size={16} /></button>
          </header>}
          <div onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void addImages(Array.from(event.dataTransfer.files)); }}>
            <StudioReferenceGrid items={images} onChange={setImages} onPreview={previewReference} labels="primary" materialTiles compact
              onChangeRole={(image, index) => changeImageRole(image, index, false)} disabled={uploading || submitting || Boolean(pendingSubmission)}>
              <button type="button" className={styles.materialAdd} disabled={uploading || submitting || Boolean(pendingSubmission) || images.length >= currentReferenceCap && referenceLimit !== 1 || currentReferenceCap === 0}
                title={referenceLimit === 1 && images.length ? '替换主图' : images.length >= currentReferenceCap ? '已达到可用图片数量上限' : '添加主图'} onClick={() => openImageSource('reference')}><Plus size={24} /><span>{uploading ? '上传中' : currentReferenceCap === 0 ? '主图未启用' : referenceLimit === 1 && images.length ? '替换主图' : images.length >= currentReferenceCap ? '主图已满' : '添加主图'}</span></button>
            </StudioReferenceGrid>
          </div>
        </section>
        <section className={`${styles.materialSection} ${styles.styleMaterials}`} aria-label="风格组与文字 skills">
          {!templateWorkbench && <header className={styles.materialHeading}><h3>风格组</h3>
            <select aria-label="风格图片数量上限" value={styleLimit} disabled={uploading || submitting || Boolean(pendingSubmission)} onChange={event => setStyleLimit(Number(event.target.value))}>
              {Array.from({ length: MAX_REFERENCE_IMAGES + 1 }, (_, value) => <option key={value} value={value}>最多 {value} 张</option>)}
            </select><span title={`已选 ${activeStyles.length} 组风格，共 ${styleImageCount} 张图片`}><b>{activeStyles.length}组</b> · <b>{styleImageCount}张</b></span>
          </header>}
          <StudioStyleGroups userId={userId} selected={activeStyles} currentImages={auxiliaryImages} tiles maxReferences={currentStyleCap}
            disabled={uploading || submitting || Boolean(pendingSubmission)}
            onChange={next => { if (reproduceSourceTaskId) exitReproductionMode('风格组已修改，接下来使用当前模板和风格组。'); setStyleGroups(next); }} />
          <StudioSkills userId={userId} selected={reproduceSourceTaskId ? reproductionSkills : skills} disabled={uploading || submitting || Boolean(pendingSubmission)}
            onChange={next => { if (reproduceSourceTaskId) exitReproductionMode('skills已修改，接下来使用当前模板和所选文字。'); setSkills(next); }} />
        </section>
        <section className={`${styles.materialSection} ${templateWorkbench ? styles.auxiliaryMaterials : ''}`} aria-label="参考图">
          {!templateWorkbench && <header className={styles.materialHeading}><h3>参考图</h3>
            <select aria-label="参考图数量上限" value={referenceImageLimit} disabled={uploading || submitting || Boolean(pendingSubmission)} onChange={event => setReferenceImageLimit(Number(event.target.value))}>
              {Array.from({ length: MAX_REFERENCE_IMAGES + 1 }, (_, value) => <option key={value} value={value}>最多 {value} 张</option>)}
            </select><span title={`已选 ${ordinaryReferenceCount} 张参考图`}><b>{ordinaryReferenceCount}张</b></span>
          </header>}
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
                title={auxiliaryImages.length >= currentAuxiliaryCap ? '已达到可用图片数量上限' : '添加参考图'} onClick={() => openImageSource('auxiliary')}><Plus size={24} /><span>{currentAuxiliaryCap === 0 && !auxiliaryImages.length ? '参考图未启用' : auxiliaryImages.length >= currentAuxiliaryCap ? '参考图已满' : '添加参考图'}</span></button>
            </StudioReferenceGrid>
          </div>
          {(fixedReferences.length > 0 || Boolean(module.fixedReferenceCount) || reproductionFixedCount > styleImageCount) && <label className={styles.referenceToggle}><input type="checkbox" checked={useFixedReferences} disabled={uploading || submitting || Boolean(pendingSubmission)} onChange={event => setUseFixedReferences(event.target.checked)} />使用模板固定参考图</label>}
          <input ref={auxiliaryFileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={event => { void addImages(Array.from(event.target.files || []), false, true); event.target.value = ''; }} />
        </section>
        {auxiliaryCount > 0 && <div className={styles.materialFooter}>
          <button type="button" title="清空本次风格组和参考图，保留主图与文字" disabled={uploading || submitting || Boolean(pendingSubmission) || !auxiliaryCount} onClick={clearAllReferences}><X size={14} />清空参考</button>
        </div>}
        </div>
        {uploadProgress && <UploadProgressIndicator busy {...uploadProgress} />}
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={event => {
          void addImages(Array.from(event.target.files || [])); event.target.value = '';
        }} />
        <div className={styles.generationToolbar}>
          <div className={styles.generationActions}>
            <div className={styles.generationModes} role="group" aria-label="生成方式"><button type="button" aria-pressed={batch.mode === 'single'} disabled={submitting || Boolean(pendingSubmission) || Boolean(batch.pending) || batch.busy || batch.previewing} onClick={() => batch.setMode('single')}>单次</button><button type="button" aria-pressed={batch.mode === 'batch'} disabled={submitting || Boolean(pendingSubmission) || batch.busy || batch.previewing} onClick={() => batch.setMode('batch')}>批量</button></div>
            <button type="button" className={`${styles.generate} sd2-loading-surface`} data-busy={submitting || queryingSubmission || batch.busy} disabled={Boolean(generationFeedback)} title={generationFeedback?.message} aria-describedby={generationFeedback ? `generation-blocker-${module.id}` : undefined} onClick={() => void (pendingSubmission ? querySubmission() : submit())}>{queryingSubmission ? '正在查询' : submitting ? '正在提交' : pendingSubmission || batch.pending ? '查询这次提交' : batch.mode === 'batch' ? '开始批量生成' : Number.isInteger(count) && count >= 1 && count <= 8 ? `生成 ${count} 张` : '生成图片'}</button>
          </div>
          {batch.mode === 'single' && <div className={`${styles.counts} ${styles.generationQuantity}`} role="group" aria-label="单次生成张数">
            <label htmlFor={`studio-count-${module.id}`}>张数</label>
            {[1, 2, 4, 8].map(n => <button type="button" disabled={submitting || Boolean(pendingSubmission)} key={n} aria-pressed={count === n} onClick={() => setCount(n)}>{n}</button>)}
            <input id={`studio-count-${module.id}`} disabled={submitting || Boolean(pendingSubmission)} type="number" min={1} max={8} step={1} value={count} onChange={event => setCount(Number(event.target.value))} />
          </div>}
          {batch.mode === 'batch' && batch.controls}
          {batch.mode === 'single' && <p className={styles.generationEstimate}>
            {visibleQuote && Number.isFinite(visibleQuote.estimatedCredits)
              ? `合计约 ${Math.ceil(visibleQuote.estimatedCredits)} 点数`
              : !actualQuoteRequired && moduleUnitCredits != null && Number.isFinite(moduleUnitCredits) && moduleUnitCredits >= 0
                && Number.isInteger(count) && count >= 1 && count <= 8
                ? `合计约 ${Math.ceil(moduleUnitCredits * count)} 点数`
              : '费用待估算'}
          </p>}
          {generationFeedback && <p id={`generation-blocker-${module.id}`} role="status" className={styles.generationFeedback} data-tone={generationFeedback.tone}>{generationFeedback.message}</p>}
          {settingsError && <button type="button" onClick={async () => { if (!dirty || (await confirm('重新读取会替换未保存的通用设置，是否继续？', { title: '重新读取', confirmLabel: '放弃修改并读取' }))) onReloadSettings(true); }}><RefreshCw size={16} />重新读取设置</button>}
          {sourceSharingBlocked && <p role="alert" className={styles.error}>该模板已停止共享，不能新建任务；已提交任务和历史结果仍保留。</p>}
          {pendingSubmission && <p className={styles.muted}>提交结果待确认，只查询原请求，不会再次生成。<button type="button" disabled={submitting} onClick={async () => {
            if ((await confirm('上次提交可能已受理。放弃核对后，再次生成会新建任务，可能再次产生上游费用。确定放弃核对吗？', { title: '放弃核对', confirmLabel: '放弃核对' }))) { setPendingSubmission(null); try { localStorage.removeItem(pendingKey); sessionStorage.removeItem(pendingKey); } catch {} }
          }}>放弃核对</button></p>}
          {!ready && !settingsError && <p className={styles.muted}>{!selectedProviderReady ? '图片服务尚未就绪' : '请管理员完成模型积分设置'}</p>}
        </div>
        {evolution && <div className={styles.counts} role="group" aria-label="演化方向">{(['increase', 'decrease'] as const).map(direction => <button type="button" key={direction} aria-pressed={(evolutionInput.manual ? evolutionInput.direction : bodyDirection || evolution.defaultDirection) === direction} disabled={submitting || Boolean(pendingSubmission) || Boolean(batch.pending)} onClick={() => setEvolutionInput({ direction, manual: true })}>{direction === 'increase' ? '递进' : '递减'}</button>)}{evolutionInput.manual && <button type="button" title="按正文和模板默认方向" onClick={() => setEvolutionInput({ direction: evolution.defaultDirection, manual: false })}><RotateCcw size={14} /></button>}</div>}
        <label className={styles.label} htmlFor={`studio-prompt-${module.id}`}>{evolution ? '演化内容' : '补充'} {!evolution && <span>有图片时选填</span>}</label>
        <textarea id={`studio-prompt-${module.id}`} disabled={submitting || Boolean(pendingSubmission) || Boolean(batch.pending)} value={prompt} maxLength={20000} onChange={event => setPrompt(event.target.value)} placeholder={evolution ? '什么发生变化' : '补充想生成的画面'} rows={9} />
        {evolutionConflict && <p role="alert" className={styles.error}>{evolutionConflict}</p>}
        <RatioPicker value={aspectRatio} onChange={setAspectRatio} reference={effectiveReferences.find(image => Number(image.width) > 0 && Number(image.height) > 0) || null} model={moduleModel} resolution={resolution} fourToOneSupported={selectedFourToOne} onEditing={setRatioEditing} disabled={submitting || Boolean(pendingSubmission)} {...ratios} />
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
        <div className={styles.moduleQuickActions} aria-label="模板快捷设置">
          <div className={styles.quickPresetRow}>
            <button type="button" title="管理模板" aria-label="管理模板" onClick={onManagePresets}><FolderCog size={16} /></button>
            <button type="button" title="恢复默认" aria-label="恢复默认" disabled={presetSaving || Boolean(quickPresetApplying) || draftRestoring || submitting || Boolean(pendingSubmission) || moduleSaving || uploading || bannerUploading} onClick={restoreDefaults}><RefreshCw size={16} /></button>
            <div className={styles.quickPresetChoices} aria-label="已保存快捷模板">
              {quickPresets.map(preset => <button type="button" key={preset.id} title={`套用：${preset.name}`} className="sd2-loading-surface" data-busy={quickPresetApplying === preset.id}
                disabled={!draftLoaded || draftRestoring || presetSaving || Boolean(quickPresetApplying) || submitting || Boolean(pendingSubmission) || uploading || bannerUploading || moduleSaving || moduleDeleting || ratioEditing}
                onClick={() => void applyQuickPreset(preset)}>{preset.name}</button>)}
            </div>
          </div>
          <button type="button" className={`${styles.primary} sd2-loading-surface`} data-busy={moduleSaving} disabled={moduleSaving || presetSaving || Boolean(quickPresetApplying) || uploading || bannerUploading || !settingsDirty} onClick={() => void saveModule()}><Save size={16} />{templateWorkbench ? '保存设置' : '保存上下文'}</button>
          <button type="button" title={!contextEditable && !recoverableDraft ? '共享模板的内部配置只能由创建者另存；当前草稿仍可生成' : undefined} disabled={presetSaving || Boolean(quickPresetApplying) || draftRestoring || moduleSaving || uploading || bannerUploading || submitting || Boolean(pendingSubmission) || (!recoverableDraft && (!contextEditable || !generationChanged || generationDraft === savedAsSignature))} className={recoverableDraft || (contextEditable && generationChanged && generationDraft !== savedAsSignature) ? styles.saveReady : ''} onClick={() => recoverableDraft ? restoreTemporaryDraft() : void saveAsPreset()}><Save size={16} />{recoverableDraft ? '恢复上一次' : templateWorkbench ? '另存为模板' : '另存为'}</button>
        </div>
        {quickPresetsLoading && <p role="status" className={styles.muted}>正在读取快捷模板…</p>}
        {quickPresetsError && <p role="alert" className={styles.error}>{quickPresetsError}<button type="button" disabled={quickPresetsLoading} onClick={() => void loadQuickPresets()}>重试</button></p>}
        {saveStatus && <p role="status" className={styles.muted}>{saveStatus}</p>}
        {error && <p role="alert" className={styles.error}>{error}</p>}
      </section>
      <section className={styles.outputs} aria-label="生成结果">
        <header className={styles.header}><h2>生成结果</h2><div className={styles.counts}>
          {templateWorkbench && <button type="button" title={likedResults.liked ? '返回当前模板全部结果' : '只看当前模板中我喜欢的结果'} aria-label={likedResults.liked ? '返回当前模板全部结果' : '只看当前模板中我喜欢的结果'} aria-pressed={likedResults.liked} onClick={() => chooseResultFilter(!likedResults.liked)}><Heart size={16} fill={likedResults.liked ? 'currentColor' : 'none'} />喜欢</button>}
          <button type="button" aria-pressed={resultView === 'images' && !likedResults.liked} onClick={() => chooseResultFilter(false)}>图片</button><button type="button" aria-pressed={resultView === 'batch'} onClick={() => { likedResults.choose(false); setResultView('batch'); }}>批次</button>
          {!downloadMode ? <button type="button" disabled={downloadBusy} onClick={() => { setSelected([]); setDownloadMode(true); }}><Download size={16} />下载</button> : <div className={styles.downloadModeBar}><span>已选 {selected.length} 张</span><button type="button" disabled={!selected.length || downloadBusy} onClick={() => void download(selected)}>{downloadBusy ? '准备中' : '确认下载'}</button><button type="button" disabled={downloadBusy} onClick={() => { setSelected([]); setDownloadMode(false); }}>取消</button></div>}
          <button type="button" title="刷新记录" aria-label="刷新记录" className={templateWorkbench ? 'sd2-loading-surface' : undefined} data-busy={likedResults.liked ? likedResults.loading : templateWorkbench && taskReadAction === 'refresh'} disabled={resultBusy} onClick={refreshResults}><RefreshCw size={16} /></button>
        </div></header>
        {batch.id && resultView === 'images' && <BatchResults key={`${userId}:${batch.id}:delivery`} id={batch.id} userId={userId} deliveryOnly autoPack={batch.pack} />}
        {!likedResults.liked && batch.busy && batch.localPreviews.length > 0 && <div className={styles.grid} aria-label="本批准备素材">{batch.localPreviews.map((src, index) => <article key={src} className={styles.result}><div className={styles.batchInputPreview}><img src={src} alt={`本批主图 ${index + 1}`} /></div><p role="status">准备中</p></article>)}</div>}
        {resultView === 'batch' ? batch.id ? <BatchResults key={`${userId}:${batch.id}`} id={batch.id} userId={userId} autoPack={batch.pack} /> : <p>暂无选中批次，可开始批量生成或从<a href="/assets">资产库的“我的批次”</a>找回。</p> : <>
        {downloadReady && <p role="status">已交给浏览器下载。<a href={downloadReady.url} download={downloadReady.name}>再次下载</a></p>}
        <GeneratedImageResults key={likedResults.liked ? 'liked' : 'all'} items={sharedResults}
          scope={`sd2-image-studio-${likedResults.liked ? 'liked-' : ''}result-page:${taskReadScope}`}
          visible={!hidden && resultView === 'images'} loading={resultLoading} busy={resultBusy}
          error={resultError} emptyLabel={likedResults.liked ? '当前模板还没有喜欢的结果' : '暂无生成记录'}
          hasMore={Boolean(resultCursor)} total={likedResults.liked ? likedResults.total : taskTotal} loadMore={readNextResultPage}
          onRetry={() => { if (likedResults.liked) likedResults.refresh(); else void loadTasks(taskRetryCursor); }}
          selectedId={selectedResultId} onSelect={item => setSelectedResultId(item.id)}
          previewId={preview?.taskId || null} onPreviewChange={item => {
            if (item) setPreview(studioTaskPreviewState(item.task));
            else { setPreview(null); if (resumeModulePreview.current) { resumeModulePreview.current = false; moduleDialog.current?.showModal(); } }
          }}
          renderOverlay={({task}) => <>
            {downloadMode && studioTaskHasDeliveredAsset(task) && <input className={styles.select} data-result-secondary type="checkbox" aria-label={`选择第 ${task.ordinal} 张图片`} checked={selected.includes(task.id)} onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onChange={event => {
              if (event.target.checked && selected.length >= 8) { setError('每次最多下载 8 张'); return; }
              setSelected(current => event.target.checked ? [...current, task.id] : current.filter(id => id !== task.id));
            }} />}
          </>}
          renderDelete={({task}) => <button type="button" disabled={deleting || downloadBusy} title="删除生成记录" aria-label={`删除第 ${task.ordinal} 张生成记录`} onClick={() => { setDeleteError(''); setDeleteTarget(task); }}><Trash2 size={17} /></button>}
          renderMetadata={({task}) => <>          <div className={styles.resultHeading}>
            <p className={styles.prompt} title={`${name} · ${task.ordinal}`}>{name} · {task.ordinal}</p>
            <span className={styles.resultOwner} aria-label="生成者"><UserIdentityBadge user={task.owner} size="sm" className="asset-card-user" /></span>
          </div>
          <div className={styles.resultMeta}>
            <div className={styles.resultConfig}>
            <span title={IMAGE_STUDIO_MODEL_LABELS[task.model as keyof typeof IMAGE_STUDIO_MODEL_LABELS] || task.model}>{studioModelShortLabel(task.model)}</span>
            <span>·</span>
            <span title={`画质：${IMAGE_STUDIO_QUALITY_LABELS[normalizeImageStudioQuality(task.model, task.quality) as keyof typeof IMAGE_STUDIO_QUALITY_LABELS] || task.quality || '自动'}`}>{IMAGE_STUDIO_QUALITY_LABELS[normalizeImageStudioQuality(task.model, task.quality) as keyof typeof IMAGE_STUDIO_QUALITY_LABELS] || task.quality || '自动'}</span>
            <span>·</span><span className={styles.resolutionHint} tabIndex={0} aria-describedby={`studio-size-${task.id}`}>
              {task.snapshot?.resolution && /^[124]K$/i.test(task.snapshot.resolution) ? task.snapshot.resolution : '自动'}
              <span id={`studio-size-${task.id}`} role="tooltip" className={styles.resolutionTooltip}>{task.asset?.width && task.asset.height ? `${task.asset.width} × ${task.asset.height} px` : '实际尺寸暂不可用'}</span>
            </span>
            <span>·</span><span className={styles.resultContextVersion} title={task.snapshot?.moduleContextVersion ? `模块上下文版本：${task.snapshot.moduleContextVersion}` : '模块上下文版本状态'}><ContextVersionLabel code={task.snapshot?.moduleContextVersion} state={task.snapshot?.moduleContextVersionState || 'missing'} onRetry={() => void loadTasks()} /></span>
            </div>
            <RelativeTime className={styles.resultTime} value={task.createdAt} />
          </div>
</>}
          renderPrimaryActions={({task}) => task.delivery?.recoveryAvailable ? <button type="button" disabled={templateWorkbench && taskReadAction !== 'idle'} onClick={() => void loadTasks()}>{templateWorkbench ? '刷新恢复状态' : '查看原图恢复'}</button> : null}
          renderActions={({task}) => (isAdmin && task.snapshot?.sourceAvailable || studioTaskHasDeliveredAsset(task)) ? <>{isAdmin && task.snapshot?.sourceAvailable && <button type="button" className="sd2-loading-surface" data-busy={copyFeedback?.id === task.id && copyFeedback.text === '复制中…'} disabled={copyFeedback?.id === task.id && copyFeedback.text === '复制中…'} title="复制上下文" aria-label="复制上下文" onClick={() => void copyTaskContext(task)}><Copy size={15} /></button>}
            {studioTaskHasDeliveredAsset(task) && <button type="button" className={styles.restoreResult} disabled={Boolean(restoreDisabledReason(task))} title={restoreDisabledReason(task) || '恢复这张图片的完整设置，不生成图片'} aria-label="恢复设置" aria-describedby={`studio-restore-${task.id}`} onClick={event => {
              event.stopPropagation();
              void (async () => {
                if ((unpersistedDraft || moduleContext !== savedModuleContext || fixedDirty || dirty || automaticDirty) && !(await confirm('当前未保存的设置将被这张图片的历史设置替换，继续恢复？', { title: '恢复设置', confirmLabel: '恢复设置' }))) return;
                const reason = restoreTask(task); if (reason) setError(reason);
              })();
            }}><RotateCcw size={15} /><span id={`studio-restore-${task.id}`} role="tooltip" className={styles.resolutionTooltip}>恢复设置</span></button>}
</> : null}
          renderSupplement={({task}) => <>
            {copyFeedback?.id === task.id && <span className={styles.copyFeedback} role="status">{copyFeedback.text}</span>}
            {['download', 'recover'].includes(task.delivery?.phase || '') && Number(task.delivery?.expectedBytes) > 0 && task.delivery?.receivedBytes != null && <p role="status">{Math.min(100, Math.floor(task.delivery.receivedBytes / task.delivery.expectedBytes! * 100))}% 字节已接收</p>}
            {task.delivery?.checkpointRetained && task.status === 'uncertain' && <p className={styles.muted}>恢复资料暂留供协查，已退款任务不能自动领取原图。请联系管理员。</p>}
          </>}
        />
        </>}
      </section>
    </div>
    {assetPickerOpen && <UploadedImagePicker open imageOnly target="image-studio"
      initialSource={templateWorkbench ? 'template-image' : 'all'}
      title={imageSourceTarget === 'banner' ? '替换封面' : imageSourceTarget === 'fixed' ? '添加固定参考图' : imageSourceTarget === 'auxiliary' ? '添加参考图' : referenceLimit === 1 && images.length ? '替换主图' : '添加主图'}
      confirmLabel={imageSourceTarget === 'banner' ? '替换封面' : imageSourceTarget === 'fixed' ? '添加到固定参考区' : imageSourceTarget === 'auxiliary' ? '添加到参考区' : referenceLimit === 1 && images.length ? '替换主图' : '添加到主图'}
      purpose={imageSourceTarget}
      avatarTarget={imageSourceTarget==='reference'||imageSourceTarget==='auxiliary' ? {kind:'image-module',id:module.id,revision:module.revision,currentAssetIds:[...images,...auxiliaryImages].flatMap(image=>image.id?[image.id]:[]),capacity:Math.max(0,imageSourceTarget==='auxiliary'?currentAuxiliaryCap-auxiliaryImages.length:currentReferenceCap-images.length),sourceSignature:JSON.stringify([module.id,module.revision,generationDraft,imageSourceTarget,images,auxiliaryImages])} : undefined}
      onAvatarConfirm={async (_ids, assets) => {
        if (submitting || pendingSubmission || uploading || bannerUploading || draftRestoring || !draftLoaded) throw new Error('当前草稿尚未就绪，请稍后返回');
        const picked=(assets||[]).filter(a=>a.type==='image'&&a.originalUrl);
        if(picked.length!==1||_ids.length!==1)throw new Error('人物返回只允许一张图片');
        if([...images,...auxiliaryImages].some(i=>i.id===picked[0].id))return;
        const primary=imageSourceTarget==='reference';
        if(!primary&&imageSourceTarget!=='auxiliary')throw new Error('目标参考区已改变');
        if(primary?images.length>=currentReferenceCap:auxiliaryImages.length>=currentAuxiliaryCap)throw new Error('参考区已满，没有替换已有图片');
        const nextImages=primary?[...images,...picked]:images, nextAuxiliary=primary?auxiliaryImages:[...auxiliaryImages,...picked];
        const nextPolicy={...referencePolicy,primaryIds:nextImages.flatMap(i=>i.id?[i.id]:[])};
        const payload={schemaVersion:2,evolution:evolution?evolutionInput:undefined,prompt,count,referenceLimit,referencePolicy:nextPolicy,aspectRatio,resolution,images:[...nextImages,...nextAuxiliary].map(i=>({id:i.id})),context:contextEditable?moduleContext:undefined,fixedReferences:fixedEditable?fixedReferences.map(i=>({id:i.id,note:i.note})):undefined,skillIds:skills.map(g=>g.id),styleGroupIds:styleGroups.map(g=>g.id),model:moduleModel,quality,reproduceSourceTaskId:reproduceSourceTaskId||null,revision:moduleRevision};
        try{localStorage.setItem(draftKey,JSON.stringify(payload));}catch{throw new Error('人物图片尚未存入本机草稿，未完成回填，请勿关闭原页面');}
        setImages(nextImages);setAuxiliaryImages(nextAuxiliary);
      }}
      portalContainer={imageSourceTarget === 'fixed' ? moduleDialog.current : undefined}
      currentCount={imageSourceTarget === 'banner' ? 0 : imageSourceTarget === 'fixed' ? fixedReferences.length : imageSourceTarget === 'auxiliary' ? auxiliaryImages.length : images.length}
      currentAssetIds={imageSourceTarget === 'banner' ? [] : (imageSourceTarget === 'fixed' ? fixedReferences : imageSourceTarget === 'auxiliary' ? auxiliaryImages : images).flatMap(image => image.id ? [image.id] : [])}
      maxSelection={imageSourceTarget === 'banner' ? 1 : imageSourceTarget === 'fixed' ? MAX_REFERENCE_IMAGES - fixedReferences.length : imageSourceTarget === 'auxiliary' ? Math.max(0, currentAuxiliaryCap - auxiliaryImages.length) : referenceLimit === 1 && currentReferenceCap > 0 ? 1 : Math.max(0, currentReferenceCap - images.length)}
      onClose={() => setAssetPickerOpen(false)}
      onUploadFile={async (file, onProgress) => {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024) throw new Error('请使用 20MB 以内的 PNG、JPG 或 WebP 图片');
        if (submitting || pendingSubmission || uploading || bannerUploading) throw new Error('当前操作尚未结束，请稍后上传');
        if (imageSourceTarget === 'fixed' && !fixedEditable) throw new Error('当前不能编辑固定参考图');
        setUploading(true);
        try { return await uploadFileAsAsset(file, { onProgress }); }
        finally { setUploading(false); }
      }}
      onConfirm={async (_ids, assets) => {
        if (submitting || pendingSubmission || uploading || bannerUploading) throw new Error('当前操作尚未结束，请稍后选择');
        const picked = (assets || []).filter(asset => asset.type === 'image' && asset.originalUrl);
        if (!picked.length || picked.length !== _ids.length) throw new Error('图片信息不完整，请重新选择');
        if (imageSourceTarget === 'banner') {
          if (picked.length !== 1) throw new Error('请选择一张图片');
          setBanner(picked[0]);
        } else if (imageSourceTarget === 'fixed') {
          if (!fixedEditable) throw new Error('当前不能编辑固定参考图');
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
          if ((referenceLimit === 1 ? additions.length : images.length + additions.length) > currentReferenceCap) throw new Error(`本次最多选择 ${currentReferenceCap} 张主图`);
          setImages(current => referenceLimit === 1 ? additions : [...current, ...additions]);
        }
      }} />}
    <dialog ref={deleteDialog} className={styles.dialog} aria-labelledby={`delete-title-${module.id}`}>
      <h2 id={`delete-title-${module.id}`}>删除这张图片？</h2>
      <p>将从本模块的生成结果中移除，不退还已消耗积分。其他模块、参考图和已保存的副本不受影响。</p>
      {deleteError && <p role="alert" className={styles.error}>{deleteError}</p>}
      <div className={styles.resultActions}><button type="button" autoFocus disabled={deleting} onClick={() => setDeleteTarget(null)}>取消</button><button type="button" className={styles.danger} disabled={deleting} onClick={() => void deleteResult()}><Trash2 size={16} />{deleting ? '删除中' : '确认删除'}</button></div>
    </dialog>
    <dialog ref={moduleDialog} className={`${styles.dialog} ${styles.contextDialog}`} onPaste={event => {
      if (!fixedEditable || assetPickerOpen) return;
      const files = Array.from(event.clipboardData.items).filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter((file): file is File => Boolean(file));
      if (files.length) { event.preventDefault(); event.stopPropagation(); void addImages(files, true); }
    }}>
      <header className={styles.header}><h2>模块上下文</h2><button type="button" aria-label="关闭模块上下文" onClick={closeModuleDialog}><X size={20} /></button></header>
      <div className={styles.contextEditorTools}><span>模块上下文版本：<ContextVersionLabel {...contextVersion} unsaved={contextUnsaved} /></span>
        <button type="button" disabled={!settings?.templateDefaults || !draftLoaded || draftRestoring || moduleSaving || moduleDeleting || presetSaving || Boolean(quickPresetApplying) || submitting || Boolean(pendingSubmission) || uploading || bannerUploading || ratioEditing}
          onClick={applyUnifiedDefaults}><RefreshCw size={16} />套用统一默认</button>
        {contextEditable && <ContextClipboardActions value={moduleContext} textareaRef={moduleContextInput} onPaste={changeModuleContext} maxLength={20000} disabled={moduleSaving} />}
      </div>
      {unifiedDefaultsError && <p role="alert" className={styles.error}>{unifiedDefaultsError}</p>}
      {contextEditable ? <>
        <textarea ref={moduleContextInput} aria-label="模块上下文" rows={12} maxLength={20000} value={moduleContext} onCompositionStart={() => setContextComposing(true)} onCompositionEnd={event => { setContextComposing(false); changeModuleContext(event.currentTarget.value); }} onChange={event => changeModuleContext(event.target.value)} />
      </> : <p className={styles.muted}>共享模板的内部上下文由创建者维护，生成时自动使用。</p>}
      <div className={styles.referenceLimits}>
        <div className={styles.primaryRange} role="group" aria-label="主图张数范围"><span>主图</span><select aria-label="主图最少张数" value={primaryMin} disabled={submitting || Boolean(pendingSubmission)} onChange={event => setPrimaryMin(Number(event.target.value))}>
          {Array.from({ length: referenceLimit + 1 }, (_, value) => <option key={value} value={value}>{value}</option>)}
        </select><span aria-hidden="true">-</span><select aria-label="模板主图最多张数" value={referenceLimit} disabled={submitting || Boolean(pendingSubmission)} onChange={event => {
          const next = Number(event.target.value);
          if (next < primaryMin || next < images.length) { setError('主图上限不能低于最少要求或已选张数。'); return; }
          setReferenceLimit(next);
        }}>{Array.from({ length: MAX_REFERENCE_IMAGES }, (_, index) => index + 1).map(value => <option key={value} value={value}>{value}</option>)}</select><span>张</span></div>
        <label>风格上限 <select aria-label="模板风格图片最多张数" value={styleLimit} disabled={submitting || Boolean(pendingSubmission)} onChange={event => setStyleLimit(Number(event.target.value))}>
          {Array.from({ length: MAX_REFERENCE_IMAGES + 1 }, (_, value) => <option key={value} value={value}>{value} 张</option>)}
        </select></label>
        <label>参考上限 <select aria-label="模板参考图最多张数" value={referenceImageLimit} disabled={submitting || Boolean(pendingSubmission)} onChange={event => setReferenceImageLimit(Number(event.target.value))}>
          {Array.from({ length: MAX_REFERENCE_IMAGES + 1 }, (_, value) => <option key={value} value={value}>{value} 张</option>)}
        </select></label>
        <label>辅助总上限 <select aria-label="模板辅助参考总上限" value={auxiliaryLimit} disabled={submitting || Boolean(pendingSubmission)} onChange={event => setAuxiliaryLimit(Number(event.target.value))}>
          {Array.from({ length: MAX_REFERENCE_IMAGES + 1 }, (_, value) => <option key={value} value={value}>{value} 张</option>)}
        </select></label>
      </div>
      {templateWorkbench && <button type="button" title="替换主图提醒设置" onClick={() => void confirm('此设置仅影响替换主图提醒，不影响生成费用、变价或权限确认。', { title: '主图提醒', confirmLabel: '保存设置', checkbox: { label: '每次替换主图前提醒', checked: !skipMainImageReminder(userId) }, onSubmit: async (_value, checked) => saveMainImageReminder(userId, !checked) })}><Settings size={16} />主图提醒</button>}
      <div className={styles.moduleSettingsActions}>
        <button type="button" className={`${styles.primary} sd2-loading-surface`} data-busy={moduleSaving} disabled={moduleSaving || uploading || bannerUploading || !settingsDirty} onClick={() => void saveModuleSettings()}><Save size={16} />{moduleSaving ? '正在保存' : templateWorkbench ? '保存模块设置' : '保存模板设置'}</button>
      </div>
      {moduleSaveError && <p role="alert" className={styles.error}>{moduleSaveError}<button disabled={moduleSaving || uploading || bannerUploading} onClick={() => void saveModuleSettings()}>重试保存</button></p>}
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
    </dialog>
    {preview && !preview.taskId && <ZoomableImagePreview contentKey={preview.contentKey} src={preview.src} thumbnailSrc={preview.thumbnailSrc} alt={preview.alt} title={preview.title} previewKey={preview.taskId || preview.src} sourceVersion={preview.resultVersion || undefined} fileName={preview.fileName} safeDetails={{ ...preview.metadata, width: preview.width, height: preview.height, fileSize: preview.fileSize }} comparison={preview.comparison}
 onClose={() => { setPreview(null); if (resumeModulePreview.current) { resumeModulePreview.current = false; moduleDialog.current?.showModal(); } }} />}
  </section>)}</>;
}
