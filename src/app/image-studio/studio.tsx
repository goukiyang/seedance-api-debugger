'use client';
import { LoadingSkeleton, LoadingStatus } from '@/components/LoadingState';

import { useProductDialog } from '@/components/useProductDialog';
import { saveMainImageReminder, skipMainImageReminder } from './main-image-reminder';
import { ContextClipboardActions } from '@/components/ContextClipboardActions';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Heart, ChevronFirst, ChevronLast, ChevronLeft, ChevronDown, ChevronRight, Copy, ClipboardList, Download, Eye, ImagePlus, Settings, X, RefreshCw, RotateCcw, LoaderCircle, Plus, Save, Trash2, Pencil, FolderCog } from 'lucide-react';
import { useResultPages } from '@/components/useResultPages';
import { ModuleGallery } from './ModuleGallery';
import { deriveModuleGallery, type GalleryScope, type GallerySort } from './module-gallery-state';
import { useModuleGalleryState } from './useModuleGalleryState';
import { ContextVersionLabel, useModuleContextVersion } from './context-version-label';
import { createUploadBatch, uniqueUploadFiles, uploadFileAsAsset, type UploadedAssetPayload, type UploadProgressSnapshot } from '@/lib/http/file-upload';
import { UploadProgressIndicator } from '@/components/UploadProgressIndicator';
import { UploadedImagePicker } from '@/components/UploadedImagePicker';
import { UploadSimilarityReview } from '@/components/UploadSimilarityReview';
import { SessionPreviewImage } from '@/components/SessionPreviewImage';
import { useRememberedScroll } from '@/lib/hooks/use-remembered-scroll';
import { scrollToWorkbenchHeader } from '@/lib/navigation/scroll-to-workbench-header';
import { replaceImageModuleLocation } from '@/lib/navigation/image-module-location';
import { GeneratedImageResults, ResultImageContextMenuHint, type GeneratedImageResult } from '@/components/GeneratedImageResults';
import { TaskNotice } from '@/components/TaskNotice';
import type { ResultImageContextMenuItem } from '@/components/ResultImageContextMenu';
import { StudioResultPinButton, StudioResultPinnedIndicator } from './result-pin-button';
import { STUDIO_RESULT_FEED, type StudioResultFeedExtras, type SharedStudioPinnedImage } from '@/lib/image-studio/result-pin-types';
import { useLikedStudioResults } from './liked-results';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { RelativeTime } from '@/components/RelativeTime';
import { useUnsavedNavigation } from '@/lib/hooks/use-unsaved-navigation';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';

import { ModuleGroupPicker } from './group-picker';
import { hasSharedDefaults, useSharedStudio } from './use-shared-studio';
import type { SharedStudioFixedReferenceRepair, SharedStudioIntent, SharedStudioLiveDTO, SharedStudioStateProjection, SharedStudioReasonCode, SharedStudioCapabilities } from '@/lib/image-studio/shared-types';
import { useSharingCommand } from './use-sharing-command';
import { useStudioDeletion } from './use-studio-deletion';
import type { StudioDeletionTarget, StudioOpenCommandStatus } from '@/lib/image-studio/shared-types';
import { claimSharedOpen, clearSharedOpen } from './shared-open-state';
import { useStudioNavigationMemory } from './use-studio-navigation-memory';
import { StudioLifecycleHistory } from './StudioLifecycleHistory';
import { StudioRepairFields } from './StudioRepairFields';
import { claimFixedReferenceSave, clearFixedReferenceSave, fixedReferenceReceiptMatches, fixedReferenceSaveKey,
  fixedReferenceSaveRejected, readFixedReferenceSave, type FixedReferenceSavePending } from './fixed-reference-save-state';
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
import { ModuleCoverEditor } from '@/components/ModuleCoverEditor';
import type { ModuleCoverDTO } from '@/lib/image-studio/module-cover-types';
import UserIdentityBadge from '@/components/UserIdentityBadge';

import TemplateFavoriteTitle from '@/components/content-reactions/TemplateFavoriteTitle';

import { studioResultVersion } from '@/lib/image-studio/result-attention';
import { useResultAttention } from './use-result-attention';
import { SortableStudioList } from './sortable-studio-list';
import { orderStudioItems, studioOrderKey, useStudioOrder, useStudioNavigationVisibility } from './use-studio-order';
import styles from './studio.module.css';
import { StudioReferenceGrid, type FixedStudioReference } from './reference-grid';
import { RatioPicker } from './ratio-picker';
import { useStudioSettings } from './use-studio-settings';
import { StudioGlobalSettingsDialog } from './global-settings-dialog';
import type { ResolutionDelta } from '@/lib/image-studio/resolution-apply-types';
import type { SkillSummary } from './skills-view';
import type { StudioStyleSummary } from './style-groups-view';
import { StudioStyleSkillSelector, type StudioStyleSkillSelectorHandle } from './style-skill-selector';
import type { SettingsValue } from './settings-controller';
import { parseStudioTemplateDefaults } from '@/lib/image-studio/template-defaults';
import { normalizeStudioRatio, resolveStudioAspectRatio } from '@/lib/image-studio/ratios';
import { useStudioBatch } from './use-studio-batch';
import { BatchResults } from './batch-results';
import { watchGenerationCompletion } from '@/components/GenerationCompletion';
import { handImageDownloadToBrowser } from '@/lib/media/native-download';
import { describedEvolutionDirection, type EvolutionCapability, type EvolutionInput } from '@/lib/image-studio/evolution';
import { DEFAULT_STUDIO_PRIMARY_MAX, MAX_REFERENCE_IMAGES } from '@/lib/image-studio/limits';
import type { ImageBillingView } from '@/lib/image-studio/billing-contract';
import type { ImageGenerationChannelSnapshot } from '@/lib/integrations/image-generation-channel';
import { useImageBillingRefresh } from '@/lib/hooks/use-image-billing-refresh';
import type { StudioReferencePolicy } from '@/lib/image-studio/reference-policy';
import { imageStudioChannelIssue, imageStudioChannelModel, imageStudioChannelModels, imageStudioChannelReadyForModel, imageStudioChannelUnitCredits, imageStudioUsesLegacyRoute, imageStudioEffectiveChannelId, useImageStudioChannel } from '@/lib/image-studio/channels';
import { ImageGenerationChannelSelect } from '@/components/ImageGenerationChannelSelect';
import { IMAGE_STUDIO_MODELS, IMAGE_STUDIO_NEW_REQUEST_MODELS, imageStudioModelForNewSelection, IMAGE_STUDIO_MODEL_LABELS, IMAGE_STUDIO_MODEL_SHORT_LABELS, IMAGE_STUDIO_MODEL_QUALITY_OPTIONS, IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS, IMAGE_STUDIO_QUALITY_LABELS, defaultImageResolution, defaultImageStudioQuality, normalizeImageResolution, normalizeImageStudioQuality, type ImageResolution } from '@/lib/image-studio/model-catalog';

type StudioSnapshot = { imageChannelLabel?: string | null; imageSupplierName?: string | null; referencePolicy?: StudioReferencePolicy; primaryReferenceImages?: UploadedAssetPayload[]; auxiliaryReferenceImages?: UploadedAssetPayload[]; prompt: string; model: string; quality?: string; resolution?: string | null; count: number; aspectRatio: string; resolvedAspectRatio?: string; aspectRatioSource?: string; outputSize?: string | null; resolvedOutputSize?: string | null; globalContext?: string; moduleContext?: string; unitCredits?: number | null; sourceAvailable?: boolean; contextAvailable?: boolean; contextConfigured?: boolean; referenceImages: UploadedAssetPayload[]; fixedReferenceImages?: FixedStudioReference[]; transientReferenceImages?: UploadedAssetPayload[]; fixedReferenceCount?: number; styleGroupIds?: string[]; styleGroups?: StudioStyleSummary[]; skills?: SkillSummary[]; skillIds?: string[] };
type StudioTask = { id: string; batchId: string; ordinal: number; owner?: { id: string; name: string; avatar_url: string | null } | null; prompt: string; model: string; quality?: string; status: string; error?: string; unitCredits: number; billing?: ImageBillingView | null; referenceIds: string[]; aspectRatio: string; outputSize?: string; createdAt: string; finishedAt?: string | null; snapshot?: StudioSnapshot & { moduleContextVersion?: string | null; moduleContextVersionState?: string }; delivery?: { phase: string; acceptedAt?: number; waitingStatus?: 'pending' | 'retrying' | 'unconfirmed'; receivedBytes?: number; expectedBytes?: number; generationDetailSuperseded?: boolean; recoveryAvailable: boolean; checkpointRetained: boolean; requestId?: string; upstreamRequestId?: string; validation?: { originalFormat: string; storedFormat: string; width: number; height: number; requestedSize?: string } }; asset: { id?: string; original_url: string; thumbnail_url?: string; width?: number; height?: number; file_size?: number } | null };
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
type StudioModule = { sharingPreference?: { enabled: boolean; revision: number; requestId?: string } | null; canChooseSharing?: boolean; fixedCover?: ModuleCoverDTO | null; coverEditable?: boolean; sharedLive?: SharedStudioView | null; templateImages?: UploadedAssetPayload[]; templateReferenceIds?: string[]; templatePrompt?: string; personalPrompt?: string; fixedReferences?: FixedStudioReference[]; contextEditable?: boolean; referencePolicy?: StudioReferencePolicy; id: string; name: string; prompt: string; context?: string; contextConfigured: boolean; count: number; referenceLimit: number; aspectRatio: string; resolution: ImageResolution; model: string; quality: string; groupName: string; banner: UploadedAssetPayload | null; cover?: { resultUrl: string; thumbnailUrl?: string | null; referenceUrl?: string | null } | null; prices: Record<string, number | null>; unitCredits: number | null; reproduceFromTaskId: string | null; sourcePresetId?: string | null; sourcePresetShared?: boolean | null; sourcePresetOwnedByViewer?: boolean; sourcePresetCanManageSharing?: boolean; images: UploadedAssetPayload[]; revision: number; saved: boolean; createdAt: string; fixedReferenceCount?: number; fixedReferencesEditable?: boolean; styleGroupIds?: string[]; styleGroups?: StudioStyleSummary[]; skills?: SkillSummary[]; skillIds?: string[]; reproductionState?: { fixedReferenceCount: number; styleGroups: StudioStyleSummary[] } | null };
type StudioPreset = { id: string; name: string; revision: string; deletion?: StudioDeletionTarget; moduleContextVersion?: string | null; scope: 'admin' | 'creator'; isShared: boolean; canManageSharing?: boolean; ownedByViewer?: boolean; groupName: string; model: string; quality: string; resolution: ImageResolution; count: number; referenceLimit: number; aspectRatio: string; images: UploadedAssetPayload[]; banner: UploadedAssetPayload | null; contextConfigured: boolean; createdAt: string };
type QuickStudioPreset = StudioPreset & { prompt: string; context: string; personalOverrides?: PersonalStudioOverrides; personalImages?: UploadedAssetPayload[]; referencesAvailable: boolean; referencePolicy?: StudioReferencePolicy; fixedReferences?: FixedStudioReference[]; styleGroupIds: string[]; skillIds?: string[] };
type PresetSource = { draft: Record<string, unknown>; blocked: string | null; groupDeleteBlocked?: boolean; moduleDeletionBlocked?: string | null };
type PresetSourceReader = () => PresetSource;
type StudioFeedback = { message: string; tone: 'progress' | 'info' | 'success' | 'warning' | 'error' };
type StudioImageQuote = { billingMode: 'fixed' | 'actual'; billingQuoteId: string | null; unitCredits: number; estimatedCredits: number; expiresAt?: string; imageChannel?: ImageGenerationChannelSnapshot };
type CachedStudioImageQuote = { signature: string; requestId: string; quote: StudioImageQuote };
type ImagePreviewState = { contentKey?: `asset:${string}`; sourceRole?: ImageComparisonSource['role']; taskId?: string; resultVersion?: string | null; src: string; thumbnailSrc?: string; alt: string; title?: string; fileName?: string; width?: number; height?: number; fileSize?: number; metadata?: ImagePreviewMetadata; comparison?: ImageComparisonSource };
type ResultInputMain = { taskId: string; state: 'ready' | 'none' | 'unknown' | 'unavailable'; images: UploadedAssetPayload[]; snapshotToken: string };
type ResultInputChoice = ResultInputMain & { scope: string; viewToken: number; generationSignature: string; sequence: number; selectedIds: string[] };
type RatioPreferences = { custom: string[]; busy: boolean; error: string; onRetry: () => void; onCustom: (ratio: string, remove: boolean) => Promise<boolean> };
type ModuleScrollRequest = { target: 'module' | 'header'; id: string; group: string; token: number; behavior: ScrollBehavior; markViewed: boolean; recordUse?: boolean; expansionRevision?: number };
type ModuleNavigationOptions = { ensureLoaded?: boolean; markViewed?: boolean; behavior?: ScrollBehavior; expandParents?: boolean; recordUse?: boolean; forCoverEditor?: boolean; explicitSelection?: boolean };
type PersonalStudioOverrides = Partial<Pick<StudioModule, 'prompt' | 'model' | 'quality' | 'resolution' | 'count' | 'aspectRatio'>>;
type SharedStudioView = SharedStudioLiveDTO;
type StudioNavigationEntry = Pick<StudioModule, 'id' | 'name' | 'groupName' | 'sourcePresetId' | 'sourcePresetShared'> & { deletion?: StudioDeletionTarget; sharedLive?: Pick<SharedStudioView, 'intent' | 'mode' | 'available' | 'sourceRevision' | 'reasonCode' | 'capabilities'> | null; objectKind?: SharedStudioStateProjection['objectKind']; canManageGroup?: boolean; coverEditable?: boolean; presetId?: string; banner?: UploadedAssetPayload | null; fixedCover?: ModuleCoverDTO | null; shared?: boolean };
function galleryEntryKey(entry: { id: string; presetId?: string; sharedLive?: { intent: SharedStudioIntent } | null }) {
  const presetId = entry.presetId || entry.sharedLive?.intent.presetId;
  return presetId ? `preset:${presetId}` : `module:${entry.id}`;
}
function canManageStudioGroupEntry(item: StudioNavigationEntry) {
  if (item.sharedLive?.mode === 'live') return false;
  if (typeof item.canManageGroup === 'boolean') return item.canManageGroup;
  return !item.sharedLive && !item.presetId;
}
// An unavailable ordinary DTO is not an editable empty definition. Only the
// server's dedicated, author-authorized repair read may initialize these fields.
function studioRepairModule(module: StudioModule): StudioModule {
  const repair = module.sharedLive?.repairDefinition;
  if (!repair || module.sharedLive?.mode !== 'publisher' || module.sharedLive.capabilities?.editDefinition.allowed !== true) return module;
  const image = (item: typeof repair.templateReferences[number]): UploadedAssetPayload => item.image ? { ...item.image } : { id: item.id };
  const overrides = new Set(module.sharedLive.overriddenFields);
  return { ...module, name: repair.name, groupName: repair.groupName, templatePrompt: repair.templatePrompt, context: repair.context,
    contextConfigured: Boolean(repair.context.trim()),
    model: overrides.has('model') ? module.model : repair.defaults.model,
    quality: overrides.has('quality') ? module.quality : repair.defaults.quality,
    resolution: overrides.has('resolution') ? module.resolution : repair.defaults.resolution,
    count: overrides.has('count') ? module.count : repair.defaults.count,
    aspectRatio: overrides.has('aspectRatio') ? module.aspectRatio : repair.defaults.aspectRatio,
    referenceLimit: repair.defaults.referenceLimit,
    referencePolicy: { ...repair.defaults.referencePolicy, primaryIds: module.referencePolicy?.primaryIds || [] },
    banner: repair.banner ? image(repair.banner) : null,
    templateImages: repair.templateReferences.map(image), templateReferenceIds: repair.templateReferences.map(item => item.id),
    fixedReferences: repair.fixedReferences.map(item => ({ ...image(item), note: item.note || '', available: item.status === 'valid' })),
    fixedReferenceCount: repair.fixedReferences.length,
    styleGroupIds: repair.styleGroups.map(item => item.id), styleGroups: repair.styleGroups.map((item, index) => ({ id: item.id,
      name: item.name || `待处理风格 ${index + 1}`, revision: item.revision, coverUrl: null, canManage: false, referenceCount: 0, unavailable: item.status !== 'valid' })),
    skillIds: repair.skillIds, skills: repair.skillGroups.map((item, index) => ({ id: item.id, name: item.name || `待处理提示词组 ${index + 1}`,
      revision: item.revision, unavailable: item.status !== 'valid' })),
    sharedLive: { ...module.sharedLive, defaults: repair.defaults },
  };
}
const models = IMAGE_STUDIO_MODELS;
const fixedReferencePayload = (items: FixedStudioReference[]) => items.map(item => ({ assetId: item.id, note: item.note || '' }));
const DEFAULT_GROUPS = ['未分组', '常用', '角色', '场景', '海报'];
const PERSONAL_OVERRIDE_FIELDS = ['prompt', 'model', 'quality', 'resolution', 'count', 'aspectRatio'] as const;
function storedPersonalOverrides(value: unknown): PersonalStudioOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  return Object.fromEntries(PERSONAL_OVERRIDE_FIELDS.flatMap<[keyof PersonalStudioOverrides, string | number]>(field => {
    const candidate = source[field];
    if (field === 'count') return Number.isInteger(candidate) && Number(candidate) >= 1 && Number(candidate) <= 8 ? [[field, Number(candidate)]] : [];
    return typeof candidate === 'string' && candidate.length <= (field === 'prompt' ? 20000 : 120) ? [[field, candidate]] : [];
  })) as PersonalStudioOverrides;
}
function moduleReferencePolicy(module: StudioModule): StudioReferencePolicy {
  const policy = module.referencePolicy;
  return { primaryIds: policy?.primaryIds ?? module.images.flatMap(image => image.id ? [image.id] : []),
    primaryMin: policy?.primaryMin ?? 0, primaryMax: policy?.primaryMax ?? (module.referenceLimit || DEFAULT_STUDIO_PRIMARY_MAX),
    auxiliaryMax: policy?.auxiliaryMax ?? MAX_REFERENCE_IMAGES, styleMax: policy?.styleMax ?? MAX_REFERENCE_IMAGES,
    referenceMax: policy?.referenceMax ?? MAX_REFERENCE_IMAGES, useFixedReferences: policy?.useFixedReferences ?? true };
}
async function readResponse(response: Response) {
  const value = await response.json().catch(() => { throw new Error('服务暂时无法响应，请重试'); });
  if (!response.ok) throw Object.assign(new Error(value.error || '请求失败，请重试'), { status: response.status, commandOutcome: value.commandOutcome, openCommandOutcome: value.openCommandOutcome });
  return value;
}

function FixedCoverVisual({ cover, name, onReadError }: { cover: ModuleCoverDTO; name: string; onReadError?: () => void }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [cover.thumbnailUrl]);
  return <span className={styles.coverVisual} data-cover-source="固定封面">
    {cover.available && cover.thumbnailUrl && !failed ? <img decoding="async" src={cover.thumbnailUrl} loading="lazy" alt={`${name}封面`} onError={() => { setFailed(true); onReadError?.(); }} /> : <span>封面暂不可用</span>}
  </span>;
}

function TemplateCoverVisual({ module, onReadError }: { module: StudioModule; onReadError?: () => void }) {
  const [failed, setFailed] = useState(false);
  const resultUrl = module.cover?.thumbnailUrl || module.banner?.thumbnailUrl || module.images[0]?.thumbnailUrl || '';
  const referenceUrl = module.cover?.referenceUrl || '';
  useEffect(() => setFailed(false), [resultUrl, referenceUrl]);
  if (module.fixedCover) return <FixedCoverVisual cover={module.fixedCover} name={module.name} onReadError={onReadError} />;
  if (module.cover?.referenceUrl && !failed) {
    return <span className={styles.coverVisual} data-cover-source="前后对比">
      <span className={styles.coverComparisonPane}><img decoding="async" src={referenceUrl} loading="lazy" alt="生成前参考图" onError={() => { setFailed(true); onReadError?.(); }} /><small>参考图</small></span>
      <span className={styles.coverComparisonPane}><img decoding="async" src={resultUrl} loading="lazy" alt="生成结果" onError={() => { setFailed(true); onReadError?.(); }} /><small>生成结果</small></span>
    </span>;
  }
  return <span className={styles.coverVisual} data-cover-source={resultUrl && !failed ? (module.cover?.resultUrl ? '代表生成图' : '模板素材') : '占位'}>
    {resultUrl && !failed ? <img decoding="async" src={module.cover?.thumbnailUrl || resultUrl} loading="lazy" alt={`${module.name}封面`} onError={() => { setFailed(true); onReadError?.(); }} /> : <span>暂无代表图</span>}
  </span>;
}

function singleReferenceComparison(task: StudioTask) {
  const references = task.snapshot?.primaryReferenceImages ?? task.snapshot?.transientReferenceImages ?? task.snapshot?.referenceImages ?? [];
  const reference = references[0];
  const src = reference?.originalUrl || reference?.thumbnailUrl;
  return src ? { src, role: 'original' as const, thumbnailSrc: reference.thumbnailUrl || src, alt: '主图 1', fileName: reference.fileName || undefined, width: reference.width || undefined, height: reference.height || undefined, fileSize: reference.fileSize, ...(reference.id ? { contentKey: `asset:${reference.id}` as const } : {}) } : undefined;
}

function taskComparisonCandidates(task?: StudioTask): ImageComparisonSource[] {
  const snapshot = task?.snapshot;
  const references = [...(snapshot?.primaryReferenceImages ?? snapshot?.transientReferenceImages ?? snapshot?.referenceImages ?? []),
    ...(snapshot?.auxiliaryReferenceImages || []), ...(snapshot?.fixedReferenceImages || [])];
  return references.flatMap((image, index) => image.originalUrl ? [{ src: image.originalUrl, role: 'reference' as const, thumbnailSrc: image.thumbnailUrl || undefined, alt: `参考图 ${index + 1}`, width: image.width || undefined, height: image.height || undefined, fileSize: image.fileSize, ...(image.id ? { contentKey: `asset:${image.id}` as const } : {}) }] : []);
}

function studioTaskPreviewState(task: StudioTask): ImagePreviewState {
  const snapshot = task.snapshot;
  const model = studioModelShortLabel(task.model);
  const quality = IMAGE_STUDIO_QUALITY_LABELS[normalizeImageStudioQuality(task.model, task.quality) as keyof typeof IMAGE_STUDIO_QUALITY_LABELS] || task.quality || '自动';
  return {
    taskId: task.id,
    sourceRole: 'generated',
    resultVersion: studioResultVersion(task),
    contentKey: task.asset?.id ? `asset:${task.asset.id}` : undefined,
    src: task.asset?.original_url || '',
    thumbnailSrc: task.asset?.thumbnail_url,
    alt: `生成结果 ${task.ordinal}`,
    title: `生成结果 ${task.ordinal}`,
    width: task.asset?.width, height: task.asset?.height, fileSize: task.asset?.file_size,
    metadata: { model, quality,
      supplier: [snapshot?.imageSupplierName, snapshot?.imageChannelLabel].filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).join(' · ') || undefined,
      ratio: snapshot?.resolvedAspectRatio || task.aspectRatio || 'auto', resolution: snapshot?.resolution || '自动', time: task.createdAt },
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

type ImageStudioProps = { isAdmin: boolean; userId: string; templateWorkbench?: boolean; favoritesRequest?: number };
export default function ImageStudio(props: ImageStudioProps) {
  return <ImageStudioWorkspace key={props.userId} {...props} />;
}
function ImageStudioWorkspace({ isAdmin, userId, templateWorkbench = false, favoritesRequest = 0 }: ImageStudioProps) {
  const router = useRouter();
  const routeQuery = useSearchParams()?.toString() || '';
  const hiddenHistoryTarget = useRef<string | null>(new URLSearchParams(routeQuery).get('moduleId'));
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
  const modulesOwner = useRef(userId);
  const moduleAccount = useRef(userId);
  if (moduleAccount.current !== userId) { moduleAccount.current = userId; modulesOwner.current = ''; }
  const resolutionDirty = useRef(new Set<string>());
  const [resolutionDeltas, setResolutionDeltas] = useState<Record<string, ResolutionDelta>>({});
  const registerResolutionDirty = useCallback((id: string, dirty: boolean) => {
    if (dirty) resolutionDirty.current.add(id); else resolutionDirty.current.delete(id);
  }, []);
  const applyResolutionDeltas = useCallback((deltas: ResolutionDelta[]) => {
    setResolutionDeltas(previous => ({ ...previous, ...Object.fromEntries(deltas.map(delta => [delta.id, delta])) }));
    const byId = new Map(deltas.map(delta => [delta.id, delta]));
    setModules(current => current.map(module => {
      const delta = byId.get(module.id);
      return delta && module.revision === delta.beforeRevision && !resolutionDirty.current.has(module.id)
        ? { ...module, resolution: delta.resolution as ImageResolution, revision: delta.revision } : module;
    }));
  }, []);
  useEffect(() => { resolutionDirty.current.clear(); setResolutionDeltas({}); }, [userId]);
  const [directory, setDirectory] = useState<StudioNavigationEntry[]>([]);
  const [removedDefaultGroups, setRemovedDefaultGroups] = useState<string[]>([]);
  const [directoryReady, setDirectoryReady] = useState(false);
  const studioOrder = useStudioOrder(userId);
  const navigationMemory = useStudioNavigationMemory({ userId });
  const navigationVisibility = useStudioNavigationVisibility(userId, templateWorkbench);
  const hiddenNavigationIds = useMemo(() => new Set(navigationVisibility.hiddenModuleIds), [navigationVisibility.hiddenModuleIds]);
  const removedModuleIds = useRef(new Set<string>());
  const [deletedSourcePresetIds, setDeletedSourcePresetIds] = useState<string[]>([]);
  const moduleReadScope = useRef({ owner: userId, generation: 0 });
  if (moduleReadScope.current.owner !== userId) moduleReadScope.current = { owner: userId, generation: moduleReadScope.current.generation + 1 };
  const hydratingIds = useRef(new Set<string>());
  const [hydrating, setHydrating] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [active, setActive] = useState('');
  const [coverView, setCoverView] = useState(false);
  const gallery = useModuleGalleryState(userId);
  const [galleryCoverModuleId, setGalleryCoverModuleId] = useState<string | null>(null);
  const [galleryReadErrors, setGalleryReadErrors] = useState<Set<string>>(new Set());
  const [galleryOwnedPresets, setGalleryOwnedPresets] = useState<{ owner: string; revision: string; ids: string[] }>({ owner: '', revision: '', ids: [] });
  const [galleryOwnershipError, setGalleryOwnershipError] = useState('');
  useEffect(() => { setGalleryReadErrors(new Set()); setGalleryCoverModuleId(null); }, [userId]);
  const [sharedOpening, setSharedOpening] = useState(false);
  const sharedOpenLock = useRef(false);
  const sharedOpenSequence = useRef(0);
  const receiveSharedDefinition = useCallback((next: StudioModule) => {
    const normalized = studioRepairModule(next);
    setModules(current => current.map(item => item.id === next.id && item.sharedLive?.intent.presetId === next.sharedLive?.intent.presetId ? normalized : item));
  }, []);
  const invalidateSharedDefinition = useCallback((presetId: string | null, reason: string, reasonCode?: SharedStudioReasonCode, capabilities?: SharedStudioCapabilities) => {
    if (reasonCode === 'read-unavailable' || reasonCode === 'state-conflict') return;
    setModules(current => current.map(item => !item.sharedLive || presetId && item.sharedLive.intent.presetId !== presetId ? item : {
      ...item, banner: null, context: undefined, templatePrompt: undefined, contextConfigured: false,
      fixedCover: item.fixedCover ? { ...item.fixedCover, available: false, imageUrl: null, thumbnailUrl: null, unavailableReason: reason } : null,
      templateImages: [], templateReferenceIds: [], fixedReferences: [], fixedReferenceCount: 0, styleGroups: [], styleGroupIds: [], skills: [], skillIds: [], reproductionState: null,
      sharedLive: { ...item.sharedLive, available: false, unavailableReason: reason, reasonCode, capabilities, defaults: undefined, repairDefinition: undefined },
    }));
  }, []);
  const shared = useSharedStudio({ userId, activeModule: modules.find(item => item.id === active), onDefinition: receiveSharedDefinition, onUnavailable: invalidateSharedDefinition, completeCatalog: coverView });
  const deletionCommands = useRef<Array<{ actorId: string; objectKind: 'workspace' | 'source'; id: string }>>([]);
  const deletion = useStudioDeletion({ userId,
    blocked: target => {
      const affected = target.objectKind === 'workspace' ? [target.id]
        : Array.from(new Set([...modules, ...directory].filter(item => item.sourcePresetId === target.id || item.sharedLive?.intent.presetId === target.id).map(item => item.id)));
      const sourceId = target.objectKind === 'source' ? target.id : [...modules, ...directory].find(item => item.id === target.id)?.sourcePresetId;
      const related = deletionCommands.current.find(command => command.actorId === userId
        && !(command.objectKind === target.objectKind && command.id === target.id)
        && (command.objectKind === 'source' ? command.id === sourceId : affected.includes(command.id)));
      if (related) return '同一模板的原删除仍待确认，请先核对原删除结果';
      try {
        const prefix = `sd2:studio-delete:v1:${encodeURIComponent(userId)}:`;
        if (sourceId && target.objectKind === 'workspace' && localStorage.getItem(`${prefix}source:${encodeURIComponent(sourceId)}`)) return '原模板删除仍待确认，请先核对原请求';
        if (target.objectKind === 'source' && affected.some(id => localStorage.getItem(`${prefix}workspace:${encodeURIComponent(id)}`))) return '工作区删除仍待确认，请先核对原请求';
      } catch { return '本机删除记录未能读取，未继续删除'; }
      for (const id of affected) {
        try {
          const suffix = id === `default-${userId}` ? userId : `${userId}:${id}`;
          if (localStorage.getItem(`sd2-image-studio-pending:${suffix}`) || sessionStorage.getItem(`sd2-image-studio-pending:${suffix}`)) return '生成请求仍待确认，请先核对原生成，再删除工作区';
          if (readFixedReferenceSave(userId, id)) return '修复保存仍待确认，请先核对原保存，再删除工作区';
        } catch { return '本机待确认记录未能读取，未继续删除'; }
        const reason = presetSources.current.get(id)?.().moduleDeletionBlocked;
        if (reason) return reason;
      }
      return sharedOpenLock.current || presetManagementLock.current ? '模板正在处理其他操作，请稍后删除' : null;
    },
    onSettled: ({ receipt, current }) => {
      // Historical proof confirms only the original command; later restoration remains visible.
      const currentlyRestored = receipt.objectKind === 'source' && current && 'archived' in current && current.exists && !current.archived;
      if (receipt.objectKind === 'workspace' && current?.exists) {
        setError('原删除回执已确认，但工作区目前有后续变化，请重新读取后继续');
      } else if (receipt.objectKind === 'workspace') {
        removedModuleIds.current.add(receipt.id);
        setModules(items => items.filter(item => item.id !== receipt.id));
        setDirectory(items => items.filter(item => item.id !== receipt.id));
        if (receipt.sourcePresetId) setDeletedSourcePresetIds(items => Array.from(new Set([...items, receipt.sourcePresetId!])));
        if (active === receipt.id) { setActive(''); setCoverView(true); replaceImageModuleLocation(null, true); }
      } else if (!currentlyRestored) {
        setDeletedSourcePresetIds(items => Array.from(new Set([...items, receipt.id])));
        setDirectory(items => items.filter(item => item.presetId !== receipt.id));
        if (active === `shared:${receipt.id}` || modules.some(item => item.id === active && (item.sourcePresetId === receipt.id || item.sharedLive?.intent.presetId === receipt.id))) {
          setCoverView(true); replaceImageModuleLocation(null, true);
        }
      }
      shared.refresh(); void loadModules(); void refreshPresetCatalogs();
    },
  });
  deletionCommands.current = deletion.pending;
  useEffect(() => {
    if (modulesOwner.current !== userId) return;
    modules.forEach(item => {
      if (!item.sharedLive) return;
      navigationMemory.remember({ account: userId, moduleId: item.id, presetId: item.sharedLive.intent.presetId,
        name: item.name, groupName: item.groupName, sourceRevision: item.sharedLive.sourceRevision || '' },
      { authorized: true, available: item.sharedLive.available, repair: Boolean(item.sharedLive.repairDefinition && item.sharedLive.capabilities?.editDefinition.allowed) });
    });
  }, [modules, userId, navigationMemory.remember]);
  const attention = useResultAttention(userId, templateWorkbench);
  const [requestedView, setRequestedView] = useState({ viewerId: userId, moduleId: '', token: 0 });
  const viewSequence = useRef(0);
  const [selectedGroup, setSelectedGroup] = useState('');
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
  const orderDialog = useRef<HTMLDialogElement>(null);
  useDialogDismiss({ open: true, dialogRef: orderDialog, nativeDialog: true, onDismiss: () => orderDialog.current?.close() });
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
  const imageChannel = useImageStudioChannel(userId, 'image-studio', settings?.imageChannels, Boolean(settings));
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false);
  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const [presets, setPresets] = useState<StudioPreset[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(false);
  const [presetsError, setPresetsError] = useState('');
  const presetDialog = useRef<HTMLDialogElement>(null);
  const presetApplyLock = useRef(false);
  const [presetApplying, setPresetApplying] = useState(false);
  const sharing = useSharingCommand({ userId, onSettled: (presetId, current) => {
    if (current) {
      setPresets(items => items.map(item => item.id === presetId ? { ...item, isShared: current.isShared, revision: current.sourceRevision } : item));
      setModules(items => items.map(item => item.sourcePresetId === presetId ? { ...item, sourcePresetShared: current.isShared } : item));
    }
    shared.refresh();
    void refreshPresetCatalogs().catch(cause => setPresetsError(cause instanceof Error ? cause.message : '共享事实已更新，目录暂时无法读取'));
  } });
  const presetSharingId = sharing.busyId;
  const [lifecycleHistory, setLifecycleHistory] = useState<{ presetId: string; name: string; anchor?: HTMLElement } | null>(null);
  useEffect(() => setLifecycleHistory(null), [userId]);
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
    sharedOpenSequence.current++; sharedOpenLock.current = false; setSharedOpening(false);
    setModules([]); setDirectory([]); setRemovedDefaultGroups([]); setDirectoryReady(false); setCursor(null); setActive('');
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
      if (Array.isArray(data.removedDefaultGroups)) setRemovedDefaultGroups(data.removedDefaultGroups);
      if (Array.isArray(data.deletedSourcePresetIds)) setDeletedSourcePresetIds(data.deletedSourcePresetIds);
      modulesOwner.current = userId;
      setModules(current => {
        const ids = new Set(current.map(item => item.id));
        return [...current, ...data.modules.filter((item: StudioModule) => !ids.has(item.id) && !removedModuleIds.current.has(item.id)).map(studioRepairModule)]
          .sort((a, b) => Number(b.id === `default-${userId}`) - Number(a.id === `default-${userId}`)
            || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id.localeCompare(b.id));
      });
      setCursor(data.nextCursor); setActive(current => current || data.modules[0]?.id || '');
    } catch (e) { if (moduleReadScope.current === scope) setError(e instanceof Error ? e.message : '模块读取失败'); }
    finally { if (moduleReadScope.current === scope) { listLock.current = false; setLoading(false); } }
  }, [userId]);
  useEffect(() => { void loadModules(); }, [loadModules]);
  const hydrateModules = useCallback(async (ids: string[]) => {
    const requested = ids.filter(id => !id.startsWith('shared:') && !hydratingIds.current.has(id)).slice(0, 12);
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
        return [...current, ...data.modules.filter((item: StudioModule) => !existing.has(item.id) && !removedModuleIds.current.has(item.id)).map(studioRepairModule)];
      });
      setError('');
    } catch (cause) { if (moduleReadScope.current === scope) setError(cause instanceof Error ? cause.message : '模块读取失败，请重试'); }
    finally { if (moduleReadScope.current === scope) { requested.forEach(id => hydratingIds.current.delete(id)); setHydrating(hydratingIds.current.size > 0); } }
  }, [userId]);
  const navigateToModule = useCallback((group: string, id: string, options: ModuleNavigationOptions = {}) => {
    if (navigationVisibility.ready) hiddenHistoryTarget.current = hiddenNavigationIds.has(id) ? id : null;
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
    setPendingModuleScroll({ target: 'module', id, group, token: ++moduleScrollSequence.current, behavior: options.behavior || 'smooth', markViewed: templateWorkbench && options.markViewed !== false, recordUse: options.recordUse !== false, expansionRevision: options.expandParents === false ? -1 : sidebarInteraction.current });
    if (options.ensureLoaded !== false && !modules.some(module => module.id === id)) void hydrateModules([id]);
  }, [hydrateModules, modules, templateWorkbench, userId, navigationVisibility.ready, hiddenNavigationIds]);
  async function openSharedPreset(presetId: string, options: ModuleNavigationOptions = {}) {
    const installed = modules.find(item => item.sharedLive?.intent.presetId === presetId);
    if (installed) {
      if (options.forCoverEditor) {
        if (installed.coverEditable !== true) { setError('当前模板封面不可编辑，请重新读取权限'); return false; }
        setGalleryCoverModuleId(installed.id);
      } else {
        const metadata = installed.sharedLive?.available === false ? navigationMemory.get({ moduleId: installed.id, presetId, name: installed.name, groupName: installed.groupName }) : installed;
        navigateToModule(metadata.groupName || '未分组', installed.id, options);
      }
      return true;
    }
    if (options.explicitSelection !== true) {
      const existing = directory.find(item => item.sharedLive?.intent.presetId === presetId && !item.id.startsWith('shared:'));
      if (existing) { navigateToModule(existing.groupName || '未分组', existing.id, options); return true; }
    }
    if (sharedOpenLock.current) return;
    const scope = moduleReadScope.current;
    const sequence = ++sharedOpenSequence.current;
    sharedOpenLock.current = true; setSharedOpening(true); setError('');
    try {
      const original = await claimSharedOpen(userId, presetId, options.explicitSelection === true);
      if (!original) throw new Error('工作区未保存或已删除，请在模板库主动选用；自动恢复不会创建工作区');
      if (moduleReadScope.current !== scope || sequence !== sharedOpenSequence.current || isClientSessionBlocked()) {
        if (!original.retained) await clearSharedOpen(userId, presetId, original.requestId);
        return false;
      }
      const { requestId } = original;
      let opened: StudioModule;
      if (original.retained) {
        const result: StudioOpenCommandStatus = await readResponse(await fetch(`/api/image-studio/modules?mode=open-status&presetId=${encodeURIComponent(presetId)}&requestId=${encodeURIComponent(requestId)}`, { cache: 'no-store' }));
        if (moduleReadScope.current !== scope || sequence !== sharedOpenSequence.current || isClientSessionBlocked()) return false;
        if (result.status === 'retired') {
          const proof = result.retiredOpen;
          if (proof.version !== 1 || proof.status !== 'workspace-deleted' || proof.actorId !== userId || proof.presetId !== presetId
            || proof.requestId !== requestId || typeof proof.moduleId !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(proof.moduleId)) throw new Error('原打开与删除记录尚未完整确认，请继续核对原请求');
          await clearSharedOpen(userId, presetId, requestId);
          if (moduleReadScope.current !== scope || sequence !== sharedOpenSequence.current || isClientSessionBlocked()) return false;
          throw new Error('旧工作区已删除，请再次主动选用；本次没有创建新工作区');
        }
        if (result.status !== 'opened' || result.version !== 1 || result.actorId !== userId || result.presetId !== presetId
          || result.requestId !== requestId || typeof result.moduleId !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(result.moduleId)) throw new Error('暂未查到原打开回执，结果仍待确认；不会重新提交');
        const data = await readResponse(await fetch(`/api/image-studio/modules?ids=${encodeURIComponent(result.moduleId)}`, { cache: 'no-store' }));
        opened = data.modules?.find((item: StudioModule) => item.id === result.moduleId);
        if (!opened) throw new Error('原工作区目前未能读取，请继续核对原请求');
      } else {
        try {
          opened = await readResponse(await fetch('/api/image-studio/modules', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'open-shared', presetId, requestId, explicitSelection: options.explicitSelection === true }), signal: AbortSignal.timeout(20000) }));
        } catch (cause) {
          const proof = (cause as { openCommandOutcome?: { status?: string; actorId?: string; presetId?: string; requestId?: string } })?.openCommandOutcome;
          if (proof?.status === 'not-applied' && proof.actorId === userId && proof.presetId === presetId && proof.requestId === requestId) {
            await clearSharedOpen(userId, presetId, requestId);
            if (moduleReadScope.current !== scope || sequence !== sharedOpenSequence.current || isClientSessionBlocked()) return false;
          }
          throw cause;
        }
      }
      if (moduleReadScope.current !== scope || sequence !== sharedOpenSequence.current || isClientSessionBlocked()) return false;
      if (!opened.sharedLive || opened.sharedLive.intent.presetId !== presetId) throw new Error('模板打开结果尚未确认，请重试原操作');
      await clearSharedOpen(userId, presetId, requestId);
      if (moduleReadScope.current !== scope || sequence !== sharedOpenSequence.current || isClientSessionBlocked()) return false;
      setDeletedSourcePresetIds(current => current.filter(id => id !== presetId));
      setModules(current => [...current.filter(item => item.id !== opened.id), opened]);
      if (options.forCoverEditor) {
        if (opened.coverEditable !== true) throw new Error('当前模板封面不可编辑，请重新读取权限');
        setGalleryCoverModuleId(opened.id);
      } else navigateToModule(opened.groupName || '未分组', opened.id, { ...options, ensureLoaded: false });
      shared.refresh();
      return true;
    } catch (cause) {
      if (moduleReadScope.current === scope && sequence === sharedOpenSequence.current) {
        setError(cause instanceof Error ? cause.message : '模板尚未打开，请重试原操作'); shared.refresh();
      }
      return false;
    } finally {
      if (moduleReadScope.current === scope && sequence === sharedOpenSequence.current) { sharedOpenLock.current = false; setSharedOpening(false); }
    }
  }
  function navigateToEntry(entry: StudioNavigationEntry, options: ModuleNavigationOptions = {}) {
    if (!entry.id.startsWith('shared:')) navigateToModule(entry.groupName || '未分组', entry.id, options);
    else if (entry.presetId) void openSharedPreset(entry.presetId, options);
  }
  async function openPresetTarget(presetId: string, options: ModuleNavigationOptions = {}) {
    if (shared.items.some(item => item.presetId === presetId && item.available)
      || modules.some(item => item.sharedLive?.intent.presetId === presetId)) return openSharedPreset(presetId, options);
    const scope = moduleReadScope.current;
    try {
      const data = await readResponse(await fetch('/api/image-studio/presets', { cache: 'no-store' }));
      if (moduleReadScope.current !== scope) return false;
      const preset: StudioPreset | undefined = data.presets.find((item: StudioPreset) => item.id === presetId);
      if (!preset) throw new Error('指定模板已不可用或不再共享');
      if (preset.isShared) return openSharedPreset(presetId, options);
      const installed = modules.find(item => !item.sharedLive && item.sourcePresetId === presetId && item.sourcePresetShared === false);
      if (installed) { navigateToModule(installed.groupName || '未分组', installed.id, options); return true; }
      setPresetSourceId(active || ''); setPresets([preset, ...data.presets.filter((item: StudioPreset) => item.id !== presetId)]);
      setPresetsError(''); setPresetDialogOpen(true);
      return true;
    } catch (cause) {
      if (moduleReadScope.current === scope) setError(cause instanceof Error ? cause.message : '模板尚未读取，请重试');
      return false;
    }
  }
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
        navigateToModule(target.groupName || '未分组', moduleId, { behavior: 'auto', markViewed: false, recordUse: false, expandParents: sidebarInteraction.current === 0 });
      } else {
        routedContentHandled.current = routeKey;
        setError('指定的图片模板不存在或当前不可用');
      }
    } else if (presetId) {
      routedContentHandled.current = routeKey;
      void openPresetTarget(presetId, { behavior: 'auto', markViewed: false, recordUse: false, expandParents: sidebarInteraction.current === 0 });
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
      const workspace: StudioModule = await readResponse(await fetch('/api/image-studio/modules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: createId.current, groupName: selectedGroup || '未分组', sharingDefault: true }) }));
      setModules(current => current.some(item => item.id === workspace.id) ? current : [...current, workspace]);
      setRemovedDefaultGroups(current => current.filter(group => group !== workspace.groupName));
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
  async function refreshPresetCatalogs() {
    const scope = moduleReadScope.current;
    if (scope.owner !== userId) return;
    const data = await readResponse(await fetch('/api/image-studio/modules', { cache: 'no-store' }));
    const library = await readResponse(await fetch('/api/image-studio/presets', { cache: 'no-store' }));
    if (moduleReadScope.current !== scope) return;
    if (!Array.isArray(data.directory) || !Array.isArray(library.presets)) throw new Error('模板已保存，目录尚未完整读取，请重试读取');
    setDirectory(data.directory.filter((item: StudioNavigationEntry) => !removedModuleIds.current.has(item.id)));
    setDirectoryReady(true);
    if (Array.isArray(data.deletedSourcePresetIds)) setDeletedSourcePresetIds(data.deletedSourcePresetIds);
    setPresets(library.presets);
    setQuickPresetVersion(value => value + 1);
    shared.refresh();
  }
  async function managePreset(preset: StudioPreset, action: 'rename' | 'replace' | 'delete') {
    if (!preset.ownedByViewer || presetManagementLock.current || presetApplying || quickLinkingId) return;
    if (action === 'delete') {
      const target = (preset as StudioPreset & { deletion?: StudioDeletionTarget }).deletion;
      if (!target) { setPresetsError('删除权限尚未读取，请重新读取模板库'); return; }
      await deletion.request(target, preset.name, document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
      return;
    }
    presetManagementLock.current = true; setPresetManaging(true); setPresetsError('');
    const send = async (extra: Record<string, unknown> = {}) => {
      await readResponse(await fetch('/api/image-studio/presets', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...extra, action, presetId: preset.id, revision: preset.revision, entryPoint: 'template-library' }) }));
      setQuickPresetVersion(value => value + 1);
      shared.refresh();
      await openPresetLibrary(presetSourceId);
    };
    try {
      if (action === 'rename') {
        await askPresetName('模板名称', preset.name, { title: '修改名称', confirmLabel: '保存名称', maxLength: 80, onSubmit: name => send({ name }) });
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
    if (preset.isShared) {
      if (await openSharedPreset(preset.id, { markViewed: false, explicitSelection: true })) setPresetDialogOpen(false);
      return;
    }
    if (presetApplyLock.current || presetManagementLock.current) return;
    presetApplyLock.current = true; setPresetApplying(true); setPresetsError('');
    try {
      const created: StudioModule = await readResponse(await fetch('/api/image-studio/presets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'apply', presetId: preset.id }) }));
      setModules(current => [created, ...current.filter(item => item.id !== created.id)]); setPresetDialogOpen(false);
      navigateToModule(created.groupName || '未分组', created.id, { ensureLoaded: false, markViewed: false });
    } catch (e) { setPresetsError(e instanceof Error ? e.message : '应用模板失败'); }
    finally { presetApplyLock.current = false; setPresetApplying(false); }
  }
  async function requestPresetSharing(presetId: string, isShared: boolean, revision: string | null | undefined,
    entryPoint: 'template-library' | 'workbench', anchor?: HTMLElement) {
    if (sharing.pending[presetId]) {
      const result = await sharing.query(presetId);
      if (result.status !== 'completed') throw new Error(result.error || '共享结果待确认，请继续查询原操作；不会重新提交');
      return;
    }
    if (!revision) throw new Error('模板版本尚未读到，请重新读取后修改共享范围');
    const submit = async () => {
      const result = await sharing.submit({ presetId, isShared, revision, entryPoint });
      if (result.status !== 'completed') throw new Error(result.error || '共享结果待确认，请查询原操作');
    };
    if (!isShared) {
      await confirm('同事将不能再用此模板开始新生成；已提交任务继续，本人输入和历史保留。',
        { title: '停止共享', confirmLabel: '停止共享', anchor, onSubmit: submit });
    } else await submit();
  }
  async function togglePresetSharing(preset: StudioPreset, anchor?: HTMLElement) {
    if (!preset.canManageSharing || presetSharingId || presetManagementLock.current) return;
    setPresetsError('');
    try {
      await requestPresetSharing(preset.id, !preset.isShared, preset.revision, 'template-library', anchor);
    } catch (e) {
      setPresetsError(e instanceof Error ? e.message : '共享状态保存失败，请重试');
    }
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

  async function toggleModuleSharing(module: StudioModule, anchor?: HTMLElement) {
    if (!module.sourcePresetCanManageSharing || !module.sourcePresetId || presetSharingId) return;
    setError('');
    try {
      await requestPresetSharing(module.sourcePresetId, module.sourcePresetShared !== true,
        module.sharedLive?.sourceRevision, 'workbench', anchor);
    } catch (e) {
      setError(e instanceof Error ? e.message : '共享状态保存失败，请重试');
    }
  }
  const naturalNavigation = useMemo(() => {
    const items = new Map<string, StudioNavigationEntry>();
    const liveModules = new Map<string, StudioNavigationEntry>();
    const known = new Map<string, StudioNavigationEntry>(directory.filter(item => !item.id.startsWith('shared:')).map(item => [item.id, item]));
    modules.forEach(item => known.set(item.id, { ...known.get(item.id), ...item,
      deletion: known.get(item.id)?.deletion || (item as StudioModule & { deletion?: StudioDeletionTarget }).deletion,
      canManageGroup: known.get(item.id)?.canManageGroup ?? (!item.sharedLive || item.sharedLive.mode === 'publisher' && item.sourcePresetCanManageSharing === true) }));
    known.forEach(item => {
      if (item.sharedLive) {
        const previous = liveModules.get(item.sharedLive.intent.presetId);
        if (previous) items.delete(previous.id);
        liveModules.set(item.sharedLive.intent.presetId, item);
        if (!item.sharedLive.available) {
          const metadata = navigationMemory.get({ moduleId: item.id, presetId: item.sharedLive.intent.presetId, name: item.name, groupName: item.groupName });
          items.set(item.id, { ...item, ...metadata, shared: false, fixedCover: item.fixedCover ? { ...item.fixedCover, available: false, thumbnailUrl: null, imageUrl: null } : null });
        }
        else items.set(item.id, { ...item, presetId: item.sharedLive.intent.presetId, shared: item.sourcePresetShared === true });
      }
      else items.set(item.id, { ...item, shared: item.sourcePresetShared === true });
    });
    const knownSources = new Set(Array.from(known.values()).flatMap(item => item.sourcePresetId ? [item.sourcePresetId] : []));
    shared.items.filter(item => item.available && !deletedSourcePresetIds.includes(item.presetId)
      && (liveModules.has(item.presetId) || !knownSources.has(item.presetId))).forEach(item => {
      const binding = liveModules.get(item.presetId);
      items.set(binding?.id || `shared:${item.presetId}`, { ...binding, id: binding?.id || `shared:${item.presetId}`, presetId: item.presetId,
      name: item.name, groupName: item.groupName, banner: item.banner, fixedCover: item.fixedCover, deletion: binding?.deletion || item.deletion, coverEditable: item.coverEditable === true, shared: item.isShared === true });
    });
    return Array.from(items.values()).sort((a, b) => Number(b.id === `default-${userId}`) - Number(a.id === `default-${userId}`));
  }, [directory, modules, userId, shared.items, navigationMemory.get, deletedSourcePresetIds]);
  const navigation = useMemo(() => {
    const naturalGroups = Array.from(new Set(naturalNavigation.map(item => item.groupName || '未分组')));
    return orderStudioItems(naturalGroups, studioOrder.groups, group => group).flatMap(group =>
      orderStudioItems(naturalNavigation.filter(item => (item.groupName || '未分组') === group), studioOrder.entries, studioOrderKey));
  }, [naturalNavigation, studioOrder.groups, studioOrder.entries]);
  const groupedModules = useMemo(() => navigation.reduce<Record<string, typeof navigation>>((groups, item) => {
    const group = item.groupName || '未分组';
    (groups[group] ||= []).push(item);
    return groups;
  }, {}), [navigation]);
  const sidebarNavigation = useMemo(() => navigationVisibility.ready
    ? navigation.filter(item => !hiddenNavigationIds.has(item.id)) : [], [navigation, navigationVisibility.ready, hiddenNavigationIds]);
  const sidebarGroupedModules = useMemo(() => sidebarNavigation.reduce<Record<string, typeof navigation>>((groups, item) => {
    (groups[item.groupName || '未分组'] ||= []).push(item);
    return groups;
  }, {}), [sidebarNavigation]);
  const hiddenNavigation = useMemo(() => navigation.filter(item => hiddenNavigationIds.has(item.id)), [navigation, hiddenNavigationIds]);
  useEffect(() => {
    if (navigationVisibility.ready && hiddenHistoryTarget.current && !hiddenNavigationIds.has(hiddenHistoryTarget.current)) hiddenHistoryTarget.current = null;
    // Let an explicit route finish selecting its target before considering a cached selection.
    const linkedModuleId = new URLSearchParams(window.location.search).get('moduleId');
    if (linkedModuleId && linkedModuleId !== active) return;
    if (!templateWorkbench || !navigationVisibility.ready || !viewRestored || !directoryReady || loading || !hiddenNavigationIds.has(active)
      || hiddenHistoryTarget.current === active || pendingModuleScroll) return;
    const fallback = sidebarNavigation[0];
    setRequestedView({ viewerId: userId, moduleId: '', token: 0 });
    setActive(fallback?.id || ''); setSelectedGroup(fallback?.groupName || '未分组');
    setCoverView(!fallback); replaceImageModuleLocation(fallback?.id || null, !fallback);
    routedContentHandled.current = `${userId}:${window.location.search}`;
  }, [templateWorkbench, navigationVisibility.ready, viewRestored, directoryReady, loading, hiddenNavigationIds, active, sidebarNavigation, pendingModuleScroll, userId]);
  const orderedModules = useMemo(() => {
    const metadata = new Map(navigation.map(item => [item.id, item]));
    return orderStudioItems(modules.map(module => {
      const entry = metadata.get(module.id);
      return module.sharedLive?.available === false && !module.sharedLive.repairDefinition && entry
        ? { ...module, name: entry.name, groupName: entry.groupName } : module;
    }), navigation.map(item => item.id), item => item.id);
  }, [modules, navigation]);
  const reorderNavigation = (ids: string[]) => {
    const moved = new Set(ids);
    const completeOrder = Array.from(new Set([...studioOrder.entries, ...navigation.map(studioOrderKey)]));
    let offset = 0;
    // Replace only the moved, currently known slots. Unloaded entries retain
    // their position instead of being pushed to the end on every drag.
    studioOrder.save({ groups: studioOrder.groups, entries: completeOrder.map(id => moved.has(id) ? ids[offset++] : id) });
  };
  const reorderGroups = (ids: string[]) => {
    const moved = new Set(ids), completeOrder = Array.from(new Set([...studioOrder.groups, ...Object.keys(groupedModules)]));
    let offset = 0;
    studioOrder.save({ entries: studioOrder.entries, groups: completeOrder.map(group => moved.has(group) ? ids[offset++] : group) });
  };
  useEffect(() => {
    if (!viewRestored || !directoryReady || loading) return;
    const available = new Set(Object.keys(groupedModules));
    setExpandedGroups(current => {
      const valid = current.filter(group => available.has(group));
      return valid.length === current.length ? current : valid;
    });
  }, [viewRestored, directoryReady, loading, groupedModules]);
  const hasAnyUnread = useMemo(() => sidebarNavigation.some(item => attention.unread.has(item.id)), [sidebarNavigation, attention.unread]);
  const updateModuleMetadata = useCallback((id: string, name: string, groupName: string, followGroup = false) => {
    setModules(current => current.map(item => item.id === id && !item.sharedLive && (item.name !== name || item.groupName !== groupName)
      ? { ...item, name, groupName } : item));
    if (followGroup) setSelectedGroup(groupName);
  }, []);
  const groups = useMemo(() => Array.from(new Set([...DEFAULT_GROUPS.filter(group => !removedDefaultGroups.includes(group)), ...navigation.map(item => item.groupName).filter(Boolean)])), [navigation, removedDefaultGroups]);
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
        const target = new URL(item.content.href, window.location.origin);
        const sourceId = target.origin === window.location.origin && target.pathname === '/template-studio' ? target.searchParams.get('presetId') : null;
        if (sourceId) await openPresetTarget(sourceId, { explicitSelection: true });
        else throw new Error('该旧模板的共享来源尚未就绪，请刷新喜欢清单');
      } else {
        const target = new URL(item.content.href, window.location.origin);
        if (target.origin !== window.location.origin || target.pathname !== '/template-studio') throw new Error('模板入口已失效，请刷新喜欢清单');
        router.push(target.pathname + target.search);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '模板无法打开，请重试'); }
    finally { setFavoriteSelecting(false); }
  }
  const visibleModules = useMemo(() => selectedGroup ? modules.filter(item => item.groupName === selectedGroup) : modules, [modules, selectedGroup]);
  const missingGroupModules = useMemo(() => (groupedModules[selectedGroup] || []).filter(item => !item.presetId && !modules.some(module => module.id === item.id)), [groupedModules, selectedGroup, modules]);
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
      if (pendingModuleScroll.recordUse) gallery.markOpened(galleryEntryKey(targetModule));
      if (pendingModuleScroll.markViewed) setRequestedView({ viewerId: userId, moduleId: pendingModuleScroll.id, token: ++viewSequence.current });
      setPendingModuleScroll(current => current?.token === pendingModuleScroll.token ? null : current);
    });
  }, [pendingModuleScroll, modules, loading, hydrating, selectedGroup, coverView, userId, updateNavigationOffset, gallery.markOpened]);
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
    if (coverView) return;
    const firstPage = (groupedModules[selectedGroup] || []).filter(item => !item.presetId).slice(0, 12);
    void hydrateModules(firstPage.filter(item => !modules.some(module => module.id === item.id)).map(item => item.id));
  }, [selectedGroup, groupedModules, modules, hydrateModules, coverView]);
  useEffect(() => {
    if (!coverView && active && navigation.some(item => item.id === active) && !modules.some(item => item.id === active)) void hydrateModules([active]);
  }, [active, navigation, modules, hydrateModules, coverView]);
  useEffect(() => {
    if (!coverView || gallery.scope !== 'mine' || !shared.catalogReady
      || galleryOwnedPresets.owner === userId && galleryOwnedPresets.revision === shared.catalogRevision) return;
    const scope = moduleReadScope.current, abort = new AbortController();
    setGalleryOwnershipError('');
    // The existing library DTO supplies ownership; edit permission is not ownership.
    // Read this metadata only for the My filter, without hydrating images or definitions into modules.
    void fetch('/api/image-studio/presets', { cache: 'no-store', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]) })
      .then(readResponse).then(data => {
        if (abort.signal.aborted || moduleReadScope.current !== scope) return;
        if (!Array.isArray(data.presets)) throw new Error('模块归属未能读取');
        setGalleryOwnedPresets({ owner: userId, revision: shared.catalogRevision,
          ids: data.presets.filter((item: StudioPreset) => item.ownedByViewer === true && typeof item.id === 'string').map((item: StudioPreset) => item.id) });
      }).catch(() => { if (!abort.signal.aborted && moduleReadScope.current === scope) setGalleryOwnershipError('模块归属未能读取，请重试；已读取的模块仍可打开。'); });
    return () => abort.abort();
  }, [coverView, gallery.scope, shared.catalogReady, shared.catalogRevision, userId, coverRetry, galleryOwnedPresets.owner, galleryOwnedPresets.revision]);
  const galleryOwnershipReady = gallery.scope !== 'mine' || galleryOwnedPresets.owner === userId && galleryOwnedPresets.revision === shared.catalogRevision;
  const galleryCatalog = useMemo(() => navigation.map(entry => ({ ...entry, key: galleryEntryKey(entry),
    groupName: entry.groupName || '未分组', shared: entry.shared === true,
    mine: entry.sharedLive?.mode === 'publisher' || !entry.sharedLive && !entry.presetId
      || galleryOwnedPresets.owner === userId && Boolean(entry.presetId && galleryOwnedPresets.ids.includes(entry.presetId)) })), [navigation, galleryOwnedPresets, userId]);
  const galleryDirectoryReady = directoryReady && shared.catalogReady && !shared.error && galleryOwnershipReady && (gallery.scope !== 'mine' || !galleryOwnershipError);
  const galleryDerived = useMemo(() => deriveModuleGallery(galleryCatalog, { query: gallery.query,
    scope: gallery.scope, sort: gallery.sort, lastOpened: gallery.lastOpened }),
  [galleryCatalog, gallery.query, gallery.scope, gallery.sort, gallery.lastOpened]);
  const coverPages = useResultPages({ items: directoryReady && gallery.ready ? galleryDerived.filteredEntries : [], storageKey: `sd2:module-covers:v1:${userId}`,
    visible: coverView, busy: loading || hydrating || !galleryDirectoryReady || !gallery.ready, error: Boolean(error || shared.error), hasMore: false,
    total: galleryDirectoryReady ? galleryDerived.filteredTotal : null, loadMore: async () => undefined, currentId: null });
  const resetCoverScroll = useRememberedScroll(`image-studio:${userId}${coverView ? ':covers' : ''}`,
    viewRestored && directoryReady && (!coverView || gallery.ready && galleryDirectoryReady && !coverPages.restoring && !hydrating) && !loading,
    { localFallback: true, skipRestore: !coverView && typeof window !== 'undefined' && Boolean(new URLSearchParams(window.location.search).get('moduleId') || new URLSearchParams(window.location.search).get('presetId')) });
  const changeGalleryQuery = (value: string) => { gallery.setQuery(value); coverPages.reset(); resetCoverScroll(); };
  const changeGalleryScope = (value: GalleryScope) => { gallery.setScope(value); coverPages.reset(); resetCoverScroll(); };
  const changeGallerySort = (value: GallerySort) => { gallery.setSort(value); coverPages.reset(); resetCoverScroll(); };
  const resetGallery = () => { gallery.reset(); coverPages.reset(); resetCoverScroll(); };
  const visibleCoverIds = coverPages.pageItems.map(item => item.id).join(',');
  useEffect(() => {
    if (!coverView || !directoryReady || error) return;
    const missing = visibleCoverIds.split(',').filter(id => id && !id.startsWith('shared:') && !modules.some(module => module.id === id));
    if (missing.length) void hydrateModules(missing);
  }, [coverView, directoryReady, visibleCoverIds, modules, hydrateModules, error, coverRetry]);
  const coverPagination = <nav className={styles.pagination} style={{ flexWrap: 'wrap' }} aria-label="封面分页">
    <button type="button" aria-label="回到第一页封面" title="回到第一页封面" disabled={loading || hydrating || !galleryDirectoryReady || !coverPages.start && !coverPages.restoring} onClick={coverPages.reset}><ChevronFirst size={17} /></button>
    <button type="button" aria-label="上一页封面" title="上一页封面" disabled={loading || hydrating || !galleryDirectoryReady || !coverPages.start} onClick={coverPages.previous}><ChevronLeft size={17} /></button>
    <span role="status">{galleryDirectoryReady ? `第 ${coverPages.page} / ${coverPages.pages} 页，共 ${galleryDerived.filteredTotal} 个封面` : loading || shared.loading ? '正在读取封面目录' : error || shared.error ? '封面目录读取失败' : '封面目录尚未完整读取'}</span>
    <button type="button" aria-label="下一页封面" title="下一页封面" disabled={loading || hydrating || !galleryDirectoryReady || !coverPages.canNext} onClick={coverPages.next}><ChevronRight size={17} /></button>
    <button type="button" aria-label="最后一页封面" title="最后一页" disabled={loading || hydrating || !galleryDirectoryReady || !coverPages.canLast || coverPages.restoring} onClick={coverPages.last}><ChevronLast size={17} /></button>
  </nav>;
  const galleryCoverModule = modules.find(item => item.id === galleryCoverModuleId && item.coverEditable === true);
  useEffect(() => {
    if (!galleryCoverModuleId || loading || hydrating) return;
    if (!modules.some(item => item.id === galleryCoverModuleId && item.coverEditable === true)) {
      setGalleryCoverModuleId(null); setError('封面设置未能读取或权限已变化，请重新读取后重试');
    }
  }, [galleryCoverModuleId, modules, loading, hydrating]);
  const editGalleryCover = (entry: StudioNavigationEntry) => {
    if (entry.coverEditable !== true || sharedOpening) return;
    if (entry.presetId) { void openSharedPreset(entry.presetId, { forCoverEditor: true, recordUse: false, explicitSelection: true }); return; }
    setGalleryCoverModuleId(entry.id);
    if (!modules.some(item => item.id === entry.id)) void hydrateModules([entry.id]);
  };
  useEffect(() => {
    if (!navigation.length) return;
    const availableGroups = Object.keys(groupedModules);
    const activeModule = orderedModules.find(item => item.id === active);
    if (!coverView && activeModule?.sharedLive) { setSelectedGroup(activeModule.groupName || '未分组'); return; }
    setSelectedGroup(current => current && availableGroups.includes(current) ? current : availableGroups[0] || groups[0]);
  }, [groups, groupedModules, navigation.length, active, orderedModules, coverView]);
  const [groupDeleting, setGroupDeleting] = useState(false);
  const groupDeleteLock = useRef(false);
  const groupDeleteRequests = useRef(new Map<string, { requestId: string; expectedMembers: Array<{ id: string; revision: number }> }>());
  async function deleteGroup(group: string) {
    if (group === '未分组' || groupDeleteLock.current) return;
    groupDeleteLock.current = true; setGroupDeleting(true);
    try { await deleteGroupMembers(group); }
    finally { groupDeleteLock.current = false; setGroupDeleting(false); }
  }
  async function deleteGroupMembers(group: string) {
    const manageable = (item: StudioModule) => !item.sharedLive || item.sharedLive.mode === 'publisher' && item.sourcePresetCanManageSharing === true;
    const blocked = () => modules.filter(item => item.groupName === group && manageable(item))
      .some(item => presetSources.current.get(item.id)?.().groupDeleteBlocked);
    if (blocked()) { setError('分组中有模块正在保存或处理其他操作，请完成后再删除分组'); return; }
    // Read unloaded members too; deleting a group must not omit later pages.
    const targets = [...modules.filter(item => item.groupName === group && manageable(item))];
    const unloaded = directory.filter(item => item.groupName === group && canManageStudioGroupEntry(item) && !modules.some(module => module.id === item.id));
    try {
      for (let offset = 0; offset < unloaded.length; offset += 12) {
        const ids = unloaded.slice(offset, offset + 12).map(item => item.id);
        const data = await readResponse(await fetch(`/api/image-studio/modules?ids=${encodeURIComponent(ids.join(','))}`, { cache: 'no-store' }));
        targets.push(...data.modules.filter(manageable));
      }
    } catch { setError('分组内容未能完整读取，请重试'); return; }
    if (!targets.length && !DEFAULT_GROUPS.includes(group) && !groupDeleteRequests.current.has(group)) { setError('此分组只有他人的共享模板，不能修改原件分组'); return; }
    if (!(await confirm(`删除分组“${group}”？本人可管理模板会移到“未分组”，图片、生成结果和他人的共享原件不变。`, { title: '删除分组', confirmLabel: '删除分组', danger: true }))) return;
    if (blocked()) { setError('分组内容已变化，请完成保存后再删除分组'); return; }
    const request = groupDeleteRequests.current.get(group) || { requestId: crypto.randomUUID(), expectedMembers: targets.map(item => ({ id: item.id, revision: item.revision })).sort((a, b) => a.id.localeCompare(b.id)) };
    groupDeleteRequests.current.set(group, request);
    try {
      const result = await readResponse(await fetch('/api/image-studio/modules', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        action: 'delete-group', groupName: group, ...request,
      }) }));
      const replacements: StudioModule[] = Array.isArray(result.modules) ? result.modules : [];
      if (!Array.isArray(result.modules)) {
        for (let offset = 0; offset < request.expectedMembers.length; offset += 12) {
          const ids = request.expectedMembers.slice(offset, offset + 12).map(item => item.id);
          const data = await readResponse(await fetch(`/api/image-studio/modules?ids=${encodeURIComponent(ids.join(','))}`, { cache: 'no-store' }));
          replacements.push(...data.modules);
        }
      }
      const replacementById = new Map(replacements.map(item => [item.id, item]));
      setModules(current => current.map(item => {
        const next = replacementById.get(item.id);
        return next && next.revision >= item.revision ? next : item;
      }));
      setDirectory(current => current.map(item => replacementById.has(item.id) ? { ...item, groupName: replacementById.get(item.id)!.groupName } : item));
      if (Array.isArray(result.removedDefaultGroups)) setRemovedDefaultGroups(result.removedDefaultGroups);
      else if (DEFAULT_GROUPS.includes(group)) setRemovedDefaultGroups(current => Array.from(new Set([...current, group])));
      setSelectedGroup('未分组');
      shared.refresh();
      groupDeleteRequests.current.delete(group);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除分组失败，请重试');
      void loadModules();
      if ([400, 403, 404, 409].includes(Number((cause as { status?: number })?.status))) groupDeleteRequests.current.delete(group);
    }
  }
  const resetSidebarExpansion = () => { sidebarInteraction.current++; setExpandedGroups([]); setImageGenerationExpanded(false); setFavoritesExpanded(false); setSelectedFavorite(''); };
  const renderNavigationDelete = (item: StudioNavigationEntry) => {
    const target = item.deletion;
    if (!target || target.actorId !== userId || !target.allowed) return null;
    const pending = deletion.pending.some(command => command.objectKind === target.objectKind && command.id === target.id);
    return <button type="button" className={styles.moduleRailDelete} data-pending={pending || undefined}
      disabled={Boolean(deletion.busyId) || sharedOpening} title={pending ? '核对原删除结果' : target.objectKind === 'workspace' ? '删除个人工作区，保留原模板及历史' : '删除本人原模板'}
      aria-label={pending ? `核对原删除：${item.name}` : `删除${target.objectKind === 'workspace' ? '个人工作区' : '本人原模板'}：${item.name}`}
      onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); void deletion.request(target, item.name, event.currentTarget); }}>
      {pending ? <RefreshCw size={15} /> : <Trash2 size={15} />}
    </button>;
  };
  const toggleImageSection = () => { sidebarInteraction.current++; setImageGenerationExpanded(current => !current); };
  const toggleModuleGroup = (group: string) => { sidebarInteraction.current++; setExpandedGroups(current => current.includes(group) ? current.filter(item => item !== group) : [...current, group]); };
  const navigateToCovers = () => {
    replaceImageModuleLocation(null, true);
    routedContentHandled.current = `${userId}:${window.location.search}`;
    setPendingModuleScroll(null); setCoverView(true);
  };
  const imageSectionOpen = imageGenerationExpanded;
  return <>{productDialog}{deletion.productDialog}{(<main ref={pageRef} className={`${styles.page} ${templateWorkbench ? styles.templateWorkbench : ''}`}>
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
            <SortableStudioList items={Object.entries(sidebarGroupedModules)} identify={entry => entry[0]} label={entry => entry[0]}
              disabled={!studioOrder.ready || !directoryReady || sharedOpening || loading || groupDeleting}
              onReorder={reorderGroups}
              render={([group, items], groupHandle) => {
              const groupHasUnread = items.some(item => attention.unread.has(item.id));
              const expanded = expandedGroups.includes(group);
              const listId = `template-module-group-${encodeURIComponent(group)}`;
              return <div key={group} className={styles.moduleRailGroup}>
                <div className={styles.moduleRailGroupHeader}>
                  <button type="button" className={`${styles.moduleRailGroupTitle} ${!coverView && items.some(item => item.id === active) ? styles.moduleRailGroupCurrent : ''}`} aria-expanded={expanded} aria-controls={listId} disabled={!items.length}
                    onClick={() => toggleModuleGroup(group)}>
                    <span className={styles.navLabel}><span className={styles.navName} title={group}>{group}</span>{groupHasUnread && <span className={styles.unreadDot} role="img" aria-label="有未读结果" />}</span><small title={`共 ${items.length} 个模块`}>{items.length}项</small>
                    {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  </button>
                  {groupHandle}
                </div>
                <div id={listId} className={styles.moduleRailChildren} hidden={!expanded}>
                  <SortableStudioList items={items} identify={studioOrderKey} label={item => item.name}
                    disabled={!studioOrder.ready || sharedOpening || loading || groupDeleting} onReorder={reorderNavigation}
                    render={(item, handle) => <div className={styles.moduleRailSortableRow}>
                      <button type="button" className={`${styles.moduleRailChild} ${!coverView && active === item.id ? styles.moduleRailActive : ''}`} aria-current={!coverView && active === item.id ? 'page' : undefined}
                        disabled={sharedOpening} onClick={() => navigateToEntry(item, { explicitSelection: true })}><span className={styles.navName} title={item.name}>{item.name}</span>{item.sharedLive?.available === false ? <small className={styles.sharedOrigin}>仅历史</small> : item.shared ? <small className={styles.sharedOrigin}>共享</small> : item.objectKind === 'legacy-copy' ? <small className={styles.sharedOrigin}>个人副本</small> : null}{attention.unread.has(item.id) && <span className={styles.unreadDot} role="img" aria-label="有未读结果" />}</button>{handle}{renderNavigationDelete(item)}
                    </div>} />
                </div>
              </div>;
            }} />
          </div>
          <div className={styles.moduleRailFooter}><button type="button" title="重置侧栏展开状态" aria-label="重置侧栏展开状态" onClick={resetSidebarExpansion}><RotateCcw size={15} /><span>重置展开状态</span></button>
            <button type="button" disabled={!navigationVisibility.ready || !directoryReady || loading} onClick={() => orderDialog.current?.showModal()}>调整顺序</button>
            <button type="button" title="恢复本机默认排序，不修改共享模板" disabled={!studioOrder.ready} onClick={studioOrder.reset}><RotateCcw size={15} /><span>重置本机排序</span></button>
            <button type="button" title="只清本账号本机的旧模板名称记忆，不删模板、隐藏设置或历史" disabled={!navigationMemory.ready} onClick={navigationMemory.reset}>重置导航记忆</button>
            {studioOrder.error && <p role="status">{studioOrder.error}</p>}
            {navigationMemory.error && <p role="status">{navigationMemory.error}</p>}
            {!navigationVisibility.ready && <p role="status">{navigationVisibility.loading ? '正在读取侧栏设置…' : '侧栏设置尚未读取'}</p>}
            {navigationVisibility.error && <p role="status">{navigationVisibility.error}<button type="button" disabled={navigationVisibility.loading} onClick={() => void navigationVisibility.reload()}>重新读取</button></p>}
          </div>
        </section>
      </> : <>
        <div className={styles.moduleRailTitle}>分组快捷栏</div>
        {Object.entries(groupedModules).map(([group, items]) => <div key={group} className={styles.moduleRailGroup}>
          <button type="button" className={selectedGroup === group ? styles.moduleRailActive : ''} aria-current={selectedGroup === group ? 'page' : undefined} onClick={() => items[0] && navigateToEntry(items[0], { markViewed: false })}>
            <span className={styles.navLabel}><span className={styles.navName}>{group}</span>{items.some(item => attention.unread.has(item.id)) && <span className={styles.unreadDot} role="img" aria-label="有未读结果" />}</span><small title={`共 ${items.length} 个模块`}>{items.length}项</small></button>
          <div className={styles.moduleRailChildren}>{items.map(item => <button key={item.id} type="button" className={`${styles.moduleRailChild} ${!coverView && active === item.id ? styles.moduleRailActive : ''}`} aria-current={!coverView && active === item.id ? 'page' : undefined}
            disabled={sharedOpening} onClick={() => navigateToEntry(item)}><span className={styles.navName} title={item.name}>{item.name}</span>{item.shared && <small className={styles.sharedOrigin}>共享</small>}{attention.unread.has(item.id) && <span className={styles.unreadDot} role="img" aria-label="有未读结果" />}</button>)}</div>
        </div>)}
      </>}
      {shared.hasMore && <button type="button" disabled={shared.loading} onClick={shared.loadMore}>{shared.loading ? '读取中' : '更多共享模板'}</button>}
      <button type="button" className={coverView ? styles.moduleRailActive : ''} aria-current={coverView ? 'page' : undefined} onClick={navigateToCovers}>全部封面{navigation.some(item => attention.unread.has(item.id)) && <span className={styles.unreadDot} role="img" aria-label="有未读结果" />}<small title={`共 ${navigation.length} 个模块`}>{navigation.length}项</small></button>
    </aside>
    {templateWorkbench && <nav ref={mobileModuleNavRef} className={styles.mobileModuleNav} aria-label="图片模块导航">
      <div className={styles.mobileMajorLinks}>
        <button type="button" className={styles.mobileMajorLink} aria-expanded={imageSectionOpen} aria-controls="template-mobile-image-groups" onClick={toggleImageSection}><ImagePlus size={16} /><span>图片生成</span>{hasAnyUnread && <span className={styles.unreadDot} role="img" aria-label="有未读结果" />}{imageSectionOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</button>
        <button type="button" className={styles.mobileMajorLink} aria-expanded={favoritesExpanded} aria-controls="template-favorites-mobile" onClick={() => setFavoritesExpanded(current => !current)}><Heart size={16} /><span>我的喜欢</span>{favoritesExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button>
      </div>
      <div id="template-favorites-mobile" className={styles.mobileFavoriteList} hidden={!favoritesExpanded}><TemplateFavoritesList data={favorites} selected={selectedFavorite} busy={favoriteSelecting || loading} onSelect={item => void selectFavorite(item)} /></div>
      <div id="template-mobile-image-groups" className={styles.mobileImageGroups} hidden={!imageSectionOpen}>
      <label className={styles.mobileGroupPicker}><span>分组</span><select aria-label="选择图片分组" value={sidebarGroupedModules[selectedGroup] ? selectedGroup : ''} onChange={event => setSelectedGroup(event.target.value)}>
        {!sidebarGroupedModules[selectedGroup] && <option value="">{navigationVisibility.ready ? '选择分组' : '正在读取侧栏…'}</option>}
        {Object.entries(sidebarGroupedModules).map(([group, items]) => <option key={group} value={group}>{group} ({items.length}项){items.some(item => attention.unread.has(item.id)) ? ' · 未读' : ''}</option>)}
      </select></label>
      <button type="button" className={coverView ? styles.moduleRailActive : ''} aria-pressed={coverView} onClick={navigateToCovers}>全部封面{navigation.some(item => attention.unread.has(item.id)) && <span className={styles.unreadDot} role="img" aria-label="有未读结果" />} <small title={`共 ${navigation.length} 个模块`}>{navigation.length}项</small></button>
      <label className={styles.mobileModulePicker}><span>模块</span><select aria-label="选择图片模块" value={!coverView && sidebarGroupedModules[selectedGroup]?.some(item => item.id === active) ? active : ''} onChange={event => {
        const entry = navigation.find(item => item.id === event.target.value);
        if (entry) navigateToEntry(entry, { explicitSelection: true });
      }}>
        <option value="">{coverView ? '选择模块返回编辑' : '选择模块'}</option>
        {(sidebarGroupedModules[selectedGroup] || []).map(item => <option key={item.id} value={item.id}>{item.name}{item.sharedLive?.available === false ? ' · 仅历史' : item.shared ? ' · 共享' : item.objectKind === 'legacy-copy' ? ' · 个人副本' : ''}{attention.unread.has(item.id) ? ' · 未读' : ''}</option>)}
      </select></label>
      {navigation.find(item => item.id === active) && renderNavigationDelete(navigation.find(item => item.id === active)!)}
      {!coverView && attention.unread.has(active) && <button type="button" title="读取当前模板的新结果" aria-label="读取当前模板的新结果" onClick={() => navigateToModule(selectedGroup, active)}><Eye size={16} /><span className={styles.unreadDot} /></button>}
      {shared.hasMore && <button type="button" disabled={shared.loading} onClick={shared.loadMore}>{shared.loading ? '读取中' : '更多共享模板'}</button>}
      <button type="button" disabled={!navigationVisibility.ready || !studioOrder.ready || !directoryReady || sharedOpening || loading || groupDeleting} onClick={() => orderDialog.current?.showModal()}>调整顺序</button>
      {navigationVisibility.error && <p role="status">{navigationVisibility.error}<button type="button" disabled={navigationVisibility.loading} onClick={() => void navigationVisibility.reload()}>重新读取</button></p>}
      </div>
    </nav>}
    {templateWorkbench && <dialog ref={orderDialog} className={styles.dialog} aria-labelledby="studio-order-title">
      <header className={styles.header}><h2 id="studio-order-title">调整顺序</h2><button type="button" onClick={() => orderDialog.current?.close()} aria-label="关闭排序"><X size={18} /></button></header>
      <p className={styles.muted}>拖动右侧手柄，触屏请长按。仅在本账号的这个浏览器保存，不改变同事的顺序。</p>
      <SortableStudioList items={Object.keys(sidebarGroupedModules)} identify={group => group} label={group => group}
        disabled={!studioOrder.ready || sharedOpening || loading || groupDeleting} onReorder={reorderGroups}
        render={(group, handle) => <section className={styles.orderDialogGroup}>
          <div className={styles.moduleRailSortableRow}><button type="button" onClick={() => setSelectedGroup(group)}>{group}</button>{handle}</div>
          {selectedGroup === group && <SortableStudioList items={sidebarGroupedModules[group]} identify={studioOrderKey} label={item => item.name}
            disabled={!studioOrder.ready || sharedOpening || loading || groupDeleting} onReorder={reorderNavigation}
            render={(item, itemHandle) => <div className={styles.moduleRailSortableRow}><button type="button">{item.name}</button>{itemHandle}</div>} />}
        </section>} />
      {studioOrder.error && <p role="alert" className={styles.error}>{studioOrder.error}</p>}
      <button type="button" onClick={studioOrder.reset}>恢复默认顺序</button>
      {hiddenNavigation.length > 0 && <section aria-label="已从侧栏移除"><h3>已从侧栏移除</h3><p className={styles.muted}>模块和历史仍保留。恢复后重新出现在侧栏。</p>
        {hiddenNavigation.map(item => <div className={styles.moduleRailSortableRow} key={item.id}><span className={styles.navName}>{item.name}</span><button type="button" disabled={Boolean(navigationVisibility.restoring)} onClick={() => void navigationVisibility.restore(item.id)}>{navigationVisibility.restoring === item.id ? '正在恢复' : '恢复入口'}</button></div>)}
        {navigationVisibility.error && <p role="status" className={styles.error}>{navigationVisibility.error}</p>}
      </section>}
    </dialog>}
    <div className={styles.content}>
    {!coverView && <header id="image-generation" className={`${styles.header} ${styles.generationHeader}`}><div><h1>图片生成</h1><p className={styles.muted}>{`当前分组：${selectedGroup || '未分组'}`}</p></div><div className={styles.counts}>
      <button type="button" onClick={() => void openPresetLibrary()}>模板库</button>
      <button type="button" onClick={() => setGlobalSettingsOpen(true)}><Settings size={17} />通用设置</button>
      <button type="button" disabled={creating || !modules.length} onClick={() => void createModule()}><Plus size={17} />{creating ? '新建中' : '新建模块'}</button></div></header>}
    {error && <p role="alert" className={styles.error}>{error}<button onClick={() => { if (coverView && directoryReady) { setError(''); setCoverRetry(value => value + 1); } else void loadModules(cursor || undefined); }}>重试读取</button></p>}
    {deletion.error && <p role="status" className={styles.muted}>{deletion.error}<button type="button" disabled={loading || Boolean(deletion.busyId)} onClick={() => void loadModules()}>重新读取工作区</button></p>}
    {deletion.pending.length > 0 && <section className={styles.deletionPending} aria-label="删除结果待确认">
      <p>有 {deletion.pending.length} 项删除结果待确认，不会重新发送删除。</p>
      {deletion.pending.map((command, index) => <button key={command.requestId} type="button" disabled={Boolean(deletion.busyId)}
        onClick={() => void deletion.check(command)}>核对第 {index + 1} 项{command.objectKind === 'workspace' ? '工作区' : '原模板'}删除</button>)}
    </section>}
    {shared.error && <p role="status" className={styles.muted}>{shared.error}</p>}
    {coverView && gallery.scope === 'mine' && galleryOwnershipError && <p role="status" className={styles.error}>{galleryOwnershipError}</p>}
    {sharedOpening && <p role="status" className={styles.muted}>正在打开模板，本人输入和历史保留</p>}
    {attention.error && <p role="status" className={styles.muted}>{attention.error}<button type="button" onClick={() => {
      const target = attention.retryModuleId && directory.find(item => item.id === attention.retryModuleId);
      if (target) navigateToModule(target.groupName || '未分组', target.id); else void attention.refresh(true);
    }}>重试</button></p>}
    {coverView && <ModuleGallery title={templateWorkbench ? '模块封面' : '模板封面'}
      total={galleryDirectoryReady ? galleryDerived.total : null} filteredTotal={galleryDirectoryReady ? galleryDerived.filteredTotal : null}
      query={gallery.query} onQueryChange={changeGalleryQuery} scope={gallery.scope} onScopeChange={changeGalleryScope}
      sort={gallery.sort} onSortChange={changeGallerySort} onReset={resetGallery} gridRef={coverPages.gridRef} pagination={coverPagination}
      loading={loading || shared.loading || !gallery.ready || !galleryOwnershipReady && !galleryOwnershipError} error={Boolean(error || shared.error || gallery.scope === 'mine' && galleryOwnershipError || galleryReadErrors.size)} opening={sharedOpening || Boolean(galleryCoverModuleId && !galleryCoverModule)}
      onRetry={() => { setGalleryReadErrors(new Set()); setGalleryOwnershipError(''); shared.refresh(); if (directoryReady) { setError(''); setCoverRetry(value => value + 1); } else void loadModules(); }}
      headerActions={<div className={styles.counts}>
        <button type="button" onClick={() => void openPresetLibrary()}>模板库</button>
        <button type="button" onClick={() => setGlobalSettingsOpen(true)}><Settings size={17} />通用设置</button>
        <button type="button" disabled={creating || !modules.length} onClick={() => void createModule()}><Plus size={17} />{creating ? '新建中' : '新建模块'}</button>
      </div>}
      items={coverPages.pageItems.map(entry => {
      const coverModule = modules.find(item => item.id === entry.id);
      const onReadError = () => setGalleryReadErrors(current => new Set(Array.from(current).concat(entry.key)));
      return { key: entry.key, id: entry.id, name: entry.name, groupName: entry.groupName, mine: entry.mine, shared: entry.shared,
        lastOpenedAt: gallery.lastOpened[entry.key], unread: attention.unread.has(entry.id),
        loading: !entry.presetId && !coverModule && !error, error: galleryReadErrors.has(entry.key) || !entry.presetId && !coverModule && Boolean(error),
        visual: coverModule ? <TemplateCoverVisual key={coverRetry} module={coverModule} onReadError={onReadError} /> : entry.fixedCover
          ? <FixedCoverVisual key={coverRetry} cover={entry.fixedCover} name={entry.name} onReadError={onReadError} /> : <span className={styles.coverVisual} data-cover-source="模板素材">
            {entry.banner?.thumbnailUrl ? <img decoding="async" src={entry.banner.thumbnailUrl} loading="lazy" alt={`${entry.name}封面`} onError={onReadError} /> : <span>暂无代表图</span>}</span>,
        canEditCover: entry.coverEditable === true, onOpen: () => navigateToEntry(entry, { explicitSelection: true }), onEditCover: () => editGalleryCover(entry) };
    })} />}
    <div hidden={coverView}>
    {orderedModules.map(module => <ImageStudioBlock key={`${userId}:${module.id}`} templateWorkbench={templateWorkbench} module={module} hidden={coverView || Boolean(selectedGroup && module.groupName !== selectedGroup)} onSharedRefresh={shared.refresh} onMetadataChange={updateModuleMetadata} groups={groups} protectedGroups={['未分组', ...groups.filter(group => !DEFAULT_GROUPS.includes(group) && !(groupedModules[group] || []).some(canManageStudioGroupEntry))]} onDeleteGroup={deleteGroup} groupDeleting={groupDeleting} isAdmin={isAdmin} onToggleSharing={toggleModuleSharing} sharingId={presetSharingId}
      sharingPending={Boolean(module.sourcePresetId && sharing.pending[module.sourcePresetId])}
      sharingMessage={module.sourcePresetId ? sharing.pending[module.sourcePresetId]?.error : undefined}
      onQuerySharing={async () => { if (module.sourcePresetId) { const result = await sharing.query(module.sourcePresetId); if (result.status !== 'completed') setError(result.error || '共享结果仍待确认'); } }}
      onLifecycleHistory={anchor => { if (module.sourcePresetId) setLifecycleHistory({ presetId: module.sourcePresetId, name: module.name, anchor }); }}
      onModuleDelete={(item, anchor) => { const entry = directory.find(value => value.id === item.id);
        const target = entry?.deletion || (item as StudioModule & { deletion?: StudioDeletionTarget }).deletion;
        if (!target) { setError('删除权限尚未读取，请重新读取工作区'); return Promise.resolve(); }
        return deletion.request(target, entry?.name || item.name, anchor); }}
      moduleDeletionPending={deletion.busyId === `workspace:${module.id}` || deletion.pending.some(command => command.objectKind === 'workspace' ? command.id === module.id : command.id === module.sourcePresetId || command.id === module.sharedLive?.intent.presetId)}
      userId={userId} settings={settings} imageChannels={imageChannel.channels} imageChannelId={templateWorkbench ? 'original' : imageChannel.channelId} imageChannelReady={templateWorkbench ? Boolean(settings) : imageChannel.ready} imageChannelMessage={templateWorkbench ? '' : imageChannel.message} onImageChannelChange={imageChannel.select} globalSettingsSaving={globalEditor.saving} settingsError={globalEditor.error} active={!coverView && active === module.id && module.groupName === selectedGroup} onActivate={() => { replaceImageModuleLocation(module.id); routedContentHandled.current = `${userId}:${window.location.search}`; setActive(module.id); }}
      onManagePresets={() => void openPresetLibrary(module.id)} onPresetSaved={refreshPresetCatalogs} registerPresetSource={registerPresetSource}
      registerResolutionDirty={registerResolutionDirty} resolutionDelta={resolutionDeltas[module.id]}
      quickPresetVersion={quickPresetVersion} viewToken={requestedView.viewerId === userId && requestedView.moduleId === module.id ? requestedView.token : 0} onResultsViewed={attention.markViewed} onTemplateEntered={attention.confirmEntry} onResultsAvailable={attention.refresh}
      onGenerationAccepted={() => gallery.markOpened(galleryEntryKey(module))}
      onModuleChange={next => { setModules(current => current.map(item => item.id === next.id ? next.sharedLive ? studioRepairModule(next) : { ...next, name: item.name, groupName: item.groupName } : item)); setRemovedDefaultGroups(current => current.filter(group => group !== next.groupName)); shared.refresh(); }}
      ratios={{ custom: customRatios, busy: ratiosBusy, error: ratiosError, onRetry: () => void syncRatios(), onCustom: syncRatios }}
      onReloadSettings={discard => { void globalEditor.controller.load(discard); }} />)}
    {(loading || hydrating) && <p role="status">正在读取模块…</p>}
    {missingGroupModules.length > 0 && <button disabled={hydrating} onClick={() => void hydrateModules(missingGroupModules.slice(0, 12).map(item => item.id))}>加载更多模块（{missingGroupModules.length}）</button>}
    {visibleModules.length > 0 && <button type="button" className={styles.newModule} disabled={creating} onClick={() => void createModule()}><Plus size={17} />新建模块</button>}
    </div>
    </div>
    {galleryCoverModule && <ModuleCoverEditor key={`${userId}:${galleryCoverModule.id}`} userId={userId} moduleId={galleryCoverModule.id} moduleName={galleryCoverModule.name}
      onClose={() => setGalleryCoverModuleId(null)} onSaved={cover => {
        setModules(current => current.map(item => item.id === galleryCoverModule.id ? { ...item, fixedCover: cover } : item));
        setDirectory(current => current.map(item => item.id === galleryCoverModule.id ? { ...item, fixedCover: cover } : item));
        shared.refresh();
      }} />}
    <dialog ref={presetDialog} className={styles.dialog}>
      <header className={styles.header}><h2>模板库</h2><button type="button" disabled={Boolean(quickLinkingId) || presetApplying || presetManaging} aria-label="关闭模板库" onClick={() => setPresetDialogOpen(false)}><X size={20} /></button></header>
      <label className={styles.presetSource}>更新设置取自<select aria-label="选择要写入模板的模块" value={presetSourceId} disabled={presetManaging || presetApplying} onChange={event => setPresetSourceId(event.target.value)}><option value="">选择模块</option>{modules.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <button type="button" title="重新读取模板库" aria-label="重新读取模板库" disabled={presetManaging || presetApplying || Boolean(quickLinkingId) || presetsLoading} onClick={() => void openPresetLibrary(presetSourceId)}><RefreshCw size={16} /></button>
      {presetsError && <p role="alert" className={styles.error}>{presetsError}</p>}
      {presetsLoading ? <p role="status">正在读取模板…</p> : !presets.length ? <p className={styles.muted}>暂无模板</p> : <div className={styles.presetList}>{presets.map(preset => <article key={preset.id} className={styles.presetItem}>
        <div><TemplateFavoriteTitle contentKey={`image_template:${preset.id}`}><strong title={preset.name}>{preset.name}</strong></TemplateFavoriteTitle><span>{preset.groupName} · {IMAGE_STUDIO_MODEL_LABELS[preset.model as keyof typeof IMAGE_STUDIO_MODEL_LABELS] || preset.model}{!preset.ownedByViewer ? ' · 共享模板，只读' : ''}</span></div>
        <div className={styles.presetActions}>
          {preset.canManageSharing && <button type="button" role={sharing.pending[preset.id] ? undefined : 'switch'} aria-checked={sharing.pending[preset.id] ? undefined : preset.isShared} className={styles.presetSharing} disabled={Boolean(presetSharingId) || presetManaging} onClick={event => void togglePresetSharing(preset, event.currentTarget)}>{sharing.pending[preset.id] ? '查询共享结果' : preset.isShared ? '共享给同事' : '仅自己可见'}</button>}
          {preset.ownedByViewer && <><button type="button" title="修改模板名称" aria-label={`修改模板名称：${preset.name}`} disabled={presetManaging || presetApplying || Boolean(quickLinkingId) || Boolean(presetSharingId)} onClick={() => void managePreset(preset, 'rename')}><Pencil size={16} /></button>
            {!preset.isShared && <button type="button" disabled={!presetSourceId || presetManaging || presetApplying || Boolean(quickLinkingId) || Boolean(presetSharingId)} onClick={() => void managePreset(preset, 'replace')}><Save size={16} />更新设置</button>}
            <button type="button" title="删除设置模板" aria-label={`删除设置模板：${preset.name}`} disabled={presetManaging || presetApplying || Boolean(quickLinkingId) || Boolean(presetSharingId) || Boolean(sharing.pending[preset.id])} onClick={() => void managePreset(preset, 'delete')}><Trash2 size={16} /></button>
            <button type="button" onClick={event => setLifecycleHistory({ presetId: preset.id, name: preset.name, anchor: event.currentTarget })}>变更记录</button></>}
          {preset.ownedByViewer && active && <button type="button" disabled={Boolean(quickLinkingId) || presetApplying || presetManaging} onClick={() => void addPresetShortcut(preset)}>{quickLinkingId === preset.id ? '添加中…' : '加入当前模块快捷'}</button>}
          <button type="button" disabled={presetApplying || sharedOpening || Boolean(quickLinkingId) || presetManaging} onClick={() => void applyPreset(preset)}>{preset.isShared ? '打开模板' : '新建并应用'}</button>
        </div>{sharing.pending[preset.id] && <p role="status" className={styles.muted}>{sharing.pending[preset.id].error || '共享结果待确认，只查询原请求，不会重新提交。'}</p>}</article>)}</div>}
    </dialog>
    {lifecycleHistory && <StudioLifecycleHistory key={`${userId}:${lifecycleHistory.presetId}`} userId={userId} presetId={lifecycleHistory.presetId} name={lifecycleHistory.name} anchor={lifecycleHistory.anchor} onClose={() => setLifecycleHistory(null)} />}
    <StudioGlobalSettingsDialog open={globalSettingsOpen} onClose={() => setGlobalSettingsOpen(false)} editor={globalEditor} ownerId={userId} canEdit={isAdmin}
      getExcluded={() => modules.filter(module => (module.saved || module.id === `default-${userId}`) && resolutionDirty.current.has(module.id)).map(module => module.id)} onDeltas={applyResolutionDeltas}
      ratios={{ custom: customRatios, busy: ratiosBusy, error: ratiosError, onRetry: () => void syncRatios(), onCustom: syncRatios }} />
    {!settings && globalEditor.error && <p role="alert" className={styles.error}>{globalEditor.error}<button onClick={() => void globalEditor.controller.load()}>重试读取设置</button></p>}
  </main>)}</>;
}

function ImageStudioBlock({ isAdmin, userId, module, hidden, onSharedRefresh, onMetadataChange, onModuleDelete, moduleDeletionPending, groups, protectedGroups, onDeleteGroup, groupDeleting, onToggleSharing, sharingId, sharingPending, sharingMessage, onQuerySharing, onLifecycleHistory, settings, imageChannels, imageChannelId, imageChannelReady, imageChannelMessage, onImageChannelChange, globalSettingsSaving, settingsError, active, onActivate, onModuleChange, onReloadSettings, ratios, templateWorkbench, quickPresetVersion, viewToken, onResultsViewed, onTemplateEntered, onResultsAvailable, onGenerationAccepted, onManagePresets, onPresetSaved, registerPresetSource, registerResolutionDirty, resolutionDelta }: {
  onSharedRefresh: () => void;
  protectedGroups: string[];
  groupDeleting: boolean;
  onManagePresets: () => void;
  onPresetSaved: () => Promise<void>;
  registerPresetSource: (id: string, read: PresetSourceReader | null) => void;
  registerResolutionDirty: (id: string, dirty: boolean) => void; resolutionDelta?: ResolutionDelta;
  templateWorkbench: boolean;
  quickPresetVersion: number;
  onModuleDelete: (module: StudioModule, anchor?: HTMLElement) => Promise<void>;
  moduleDeletionPending: boolean;
  hidden: boolean; onMetadataChange: (id: string, name: string, groupName: string, followGroup?: boolean) => void;
  isAdmin: boolean; userId: string; module: StudioModule & { fixedReferences?: FixedStudioReference[]; contextEditable?: boolean }; groups: string[]; onDeleteGroup: (group: string) => Promise<void>; onToggleSharing: (module: StudioModule, anchor?: HTMLElement) => Promise<void>; sharingId: string | null; sharingPending: boolean; sharingMessage?: string; onQuerySharing: () => Promise<void>; onLifecycleHistory: (anchor: HTMLElement) => void; settings: SettingsValue | null;
  imageChannels: ReturnType<typeof useImageStudioChannel>['channels']; imageChannelId: string; imageChannelReady: boolean; imageChannelMessage: string; onImageChannelChange: (value: string) => void;
  globalSettingsSaving: boolean; settingsError: string; active: boolean; onActivate: () => void; onModuleChange: (module: StudioModule) => void;
  viewToken: number; onResultsViewed: (moduleId: string, versions: string[]) => Promise<void>; onResultsAvailable: () => Promise<void>;
  onTemplateEntered: (moduleId: string, snapshot: string, signal: AbortSignal) => Promise<void>;
  onGenerationAccepted: () => void;
  onReloadSettings: (discardDraft?: boolean) => void;
  ratios: RatioPreferences;
}) {
  const { confirm, prompt: askName, productDialog } = useProductDialog();
  const styleSkillSelector = useRef<StudioStyleSkillSelectorHandle>(null);
  const { sessionChanged } = useAppSession();
  const sharedLive = module.sharedLive;
  const sharedReady = !sharedLive || sharedLive.available && hasSharedDefaults(sharedLive.defaults) && sharedLive.capabilities?.generate.allowed !== false;
  const repairDefinition = sharedLive?.repairDefinition;
  const definitionEditable = !sharedLive || (sharedLive.capabilities ? sharedLive.capabilities.editDefinition.allowed : sharedLive.mode === 'publisher' && sharedReady);
  const definitionReady = !sharedLive || definitionEditable && (sharedReady || Boolean(repairDefinition));
  const contextEditable = definitionEditable && module.contextEditable !== false && definitionReady;
  const fixedEditable = definitionEditable && isAdmin && module.fixedReferencesEditable !== false && definitionReady;
  const fixedRepairAllowed = !isAdmin && definitionReady && repairDefinition?.fixedReferenceRepairAllowed === true;
  const [personalOverrides, setPersonalOverrides] = useState<PersonalStudioOverrides>(() => storedPersonalOverrides(Object.fromEntries(
    (sharedLive?.overriddenFields || []).map(field => [field, field === 'prompt' ? module.personalPrompt ?? module.prompt : module[field]]))));
  const personalOverridesRef = useRef(personalOverrides); personalOverridesRef.current = personalOverrides;
  const savedPersonalOverrides = useRef(JSON.stringify(personalOverrides));
  const [resetFields, setResetFields] = useState<Array<keyof PersonalStudioOverrides>>([]);
  const resetFieldsRef = useRef(resetFields); resetFieldsRef.current = resetFields;
  function markPersonalOverride<K extends keyof PersonalStudioOverrides>(field: K, value: PersonalStudioOverrides[K]) {
    if (sharedLive) {
      const next = { ...personalOverridesRef.current, [field]: value };
      personalOverridesRef.current = next; setPersonalOverrides(next);
      resetFieldsRef.current = resetFieldsRef.current.filter(item => item !== field);
      setResetFields(resetFieldsRef.current);
    }
  }
  const [templatePrompt, setTemplatePrompt] = useState(module.templatePrompt || '');
  const savedTemplatePrompt = useRef(module.templatePrompt || '');
  const definitionBaseline = useRef(module);
  const appliedSharedToken = useRef('');
  const [skills, setSkills] = useState<SkillSummary[]>(module.reproduceFromTaskId
    ? (module.reproductionState as { skills?: SkillSummary[] } | null)?.skills || module.skills || [] : module.skills || []);
  const [reproductionSkills, setReproductionSkills] = useState<SkillSummary[]>((module.reproductionState as { skills?: SkillSummary[] } | null)?.skills || []);
  const [styleGroups, setStyleGroups] = useState<StudioStyleSummary[]>(module.reproduceFromTaskId
    ? module.reproductionState?.styleGroups || module.styleGroups || [] : module.styleGroups || []);
  const [reproductionFixedCount, setReproductionFixedCount] = useState(module.reproductionState?.fixedReferenceCount || 0);
  const [reproductionStyles, setReproductionStyles] = useState<StudioStyleSummary[]>(module.reproductionState?.styleGroups || []);
  const [saveStatus, setSaveStatus] = useState('');
  const [sharingPreferenceSaving, setSharingPreferenceSaving] = useState(false);
  const sharingPreferenceRequest = useRef<{ id: string; revision: number; isShared: boolean; requestId: string } | null>(null);
  const unpublishedSharing = !sharedLive && module.sharingPreference?.enabled === true;
  const [quickPresets, setQuickPresets] = useState<QuickStudioPreset[]>([]);
  const [quickPresetsError, setQuickPresetsError] = useState('');
  const [quickPresetsLoading, setQuickPresetsLoading] = useState(false);
  const quickPresetScopeKey = `${userId}:${module.id}:${sharedLive?.intent.definitionToken || ''}:${sharedLive?.available !== false}`;
  const quickPresetReadScope = useRef(quickPresetScopeKey); quickPresetReadScope.current = quickPresetScopeKey;
  const quickPresetReadSequence = useRef(0);
  const [quickPresetApplying, setQuickPresetApplying] = useState<string | null>(null);
  const [presetSaving, setPresetSaving] = useState(false);
  const quickPresetLock = useRef(false);
  const presetSaveLock = useRef(false);
  const presetCreateRequest = useRef<{ requestId: string; payload: Record<string, unknown> & { name: string; isShared: boolean }; generationSignature: string; result?: { id: string; publisherModuleId?: string } } | null>(null);
  const [recoverableDraft, setRecoverableDraft] = useState<Record<string, any> | null>(null);
  const [savedAsSignature, setSavedAsSignature] = useState('');
  const [prompt, setPromptValue] = useState(module.personalPrompt ?? (sharedLive ? personalOverrides.prompt || '' : module.prompt));
  function setPrompt(value: string) { setPromptValue(value); markPersonalOverride('prompt', value); }
  const evolution = (module as StudioModule & { evolution?: EvolutionCapability | null }).evolution || null;
  const [evolutionInput, setEvolutionInput] = useState<EvolutionInput>({ direction: evolution?.defaultDirection || 'increase', manual: false });
  const bodyDirection = describedEvolutionDirection(prompt);
  const evolutionConflict = evolution && evolutionInput.manual && bodyDirection && bodyDirection !== evolutionInput.direction ? '正文方向与手选方向冲突，请调整正文或方向' : '';
  const [resultView, setResultView] = useState<'images' | 'batch'>('images');
  const [resultPaginationSlot, setResultPaginationSlot] = useState<HTMLDivElement | null>(null);
  const [count, setCountValue] = useState(module.count);
  function setCount(value: number) { setCountValue(value); markPersonalOverride('count', value); }
  const [referenceLimit, setReferenceLimit] = useState(module.referencePolicy?.primaryMax ?? Math.max(1, Math.min(MAX_REFERENCE_IMAGES, module.referenceLimit || DEFAULT_STUDIO_PRIMARY_MAX)));
  const [primaryMin, setPrimaryMin] = useState(module.referencePolicy?.primaryMin ?? 0);
  const [auxiliaryLimit, setAuxiliaryLimit] = useState(module.referencePolicy?.auxiliaryMax ?? MAX_REFERENCE_IMAGES);
  const [styleLimit, setStyleLimit] = useState(module.referencePolicy?.styleMax ?? MAX_REFERENCE_IMAGES);
  const [referenceImageLimit, setReferenceImageLimit] = useState(module.referencePolicy?.referenceMax ?? MAX_REFERENCE_IMAGES);
  const [useFixedReferences, setUseFixedReferences] = useState(module.referencePolicy?.useFixedReferences ?? true);
  const [aspectRatio, setAspectRatioValue] = useState(module.aspectRatio || 'auto');
  function setAspectRatio(value: string) { setAspectRatioValue(value); markPersonalOverride('aspectRatio', value); }
  const [moduleModel, setModuleModelValue] = useState(module.model);
  const preserveSelectedBananaParameters = moduleModel === 'gemini-nano-banana-2.1';
  function setModuleModel(value: string) { setModuleModelValue(value); markPersonalOverride('model', value); }
  const [resolution, setResolutionValue] = useState<ImageResolution>(module.model === 'gemini-nano-banana-2.1'
    ? module.resolution || defaultImageResolution(module.model) : normalizeImageResolution(module.model, module.resolution || defaultImageResolution(module.model)));
  function setResolution(value: ImageResolution) { setResolutionValue(value); markPersonalOverride('resolution', value); }
  const [quality, setQualityValue] = useState(module.quality || defaultImageStudioQuality(module.model));
  function setQuality(value: string) { setQualityValue(value); markPersonalOverride('quality', value); }
  const [groupName, setGroupName] = useState(module.groupName || '未分组');
  const [banner, setBanner] = useState<UploadedAssetPayload | null>(module.banner || null);
  const [coverEditorOpen, setCoverEditorOpen] = useState(false);
  const [ratioEditing, setRatioEditing] = useState(false);
  const [images, setImages] = useState<UploadedAssetPayload[]>(module.images.filter(image => !module.referencePolicy || module.referencePolicy.primaryIds.includes(image.id || '')));
  const [auxiliaryImages, setAuxiliaryImages] = useState<UploadedAssetPayload[]>(module.referencePolicy ? module.images.filter(image => !module.referencePolicy!.primaryIds.includes(image.id || '')) : []);
  const [templateImages, setTemplateImages] = useState<UploadedAssetPayload[]>(module.templateImages || []);
  const savedTemplateImageIds = useRef(JSON.stringify(module.templateReferenceIds || []));
  const templateImageIds = templateImages.flatMap(image => image.id ? [image.id] : []);
  const [name, setName] = useState(module.name);
  const [nameEditing, setNameEditing] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const [moduleRevision, setModuleRevision] = useState(module.revision);
  const revisionRef = useRef(module.revision);
  const [moduleSaving, setModuleSaving] = useState(false);
  const [localModuleDeleting, setModuleDeleting] = useState(false);
  const moduleDeleting = localModuleDeleting || moduleDeletionPending;
  const moduleDeleteLock = useRef(false);
  moduleDeleteLock.current = moduleDeleting;
  const [fixedReferences, setFixedReferences] = useState<FixedStudioReference[]>(module.fixedReferences || []);
  const [savedFixedReferences, setSavedFixedReferences] = useState<FixedStudioReference[]>(module.fixedReferences || []);
  const [fixedReferenceRepairs, setFixedReferenceRepairs] = useState<SharedStudioFixedReferenceRepair[]>([]);
  const [pendingFixedSave, setPendingFixedSave] = useState<FixedReferenceSavePending | null>(null);
  const pendingFixedSaveRef = useRef<FixedReferenceSavePending | null>(null);
  const [fixedSaveStorageError, setFixedSaveStorageError] = useState('');
  const [checkingFixedSave, setCheckingFixedSave] = useState(false);
  const fixedSaveScopeKey = `${userId}:${module.id}:${sessionChanged}`;
  const fixedSaveScope = useRef({ key: fixedSaveScopeKey, active: false });
  if (fixedSaveScope.current.key !== fixedSaveScopeKey) fixedSaveScope.current = { key: fixedSaveScopeKey, active: false };
  const fixedSaveUnknown = Boolean(pendingFixedSave || fixedSaveStorageError);
  useEffect(() => {
    const current = fixedSaveScope.current;
    current.active = true;
    moduleSaveLock.current = false; setModuleSaving(false);
    pendingFixedSaveRef.current = null; setPendingFixedSave(null); setFixedSaveStorageError(''); setCheckingFixedSave(false);
    const read = () => {
      if (fixedSaveScope.current !== current || !current.active || sessionChanged || isClientSessionBlocked()) return;
      try {
        const command = readFixedReferenceSave(userId, module.id);
        // Removing local storage in another tab is not an original receipt.
        if (!command) return;
        if (pendingFixedSaveRef.current && pendingFixedSaveRef.current.requestId !== command.requestId) {
          setFixedSaveStorageError('原修复保存记录已变化，请保留草稿并核对'); return;
        }
        pendingFixedSaveRef.current = command; setPendingFixedSave(command);
      } catch { setFixedSaveStorageError('原修复保存记录暂无法读取，本模板保存暂未提交，请保留草稿'); }
    };
    read();
    const receive = (event: StorageEvent) => { if (event.key === fixedReferenceSaveKey(userId, module.id)) read(); };
    window.addEventListener('storage', receive);
    return () => { current.active = false; window.removeEventListener('storage', receive); };
  }, [userId, module.id, sessionChanged, fixedSaveScopeKey]);
  const unresolvedFixedRepairs = fixedRepairAllowed && Boolean(repairDefinition?.fixedReferences.some((item, sourceIndex) => item.repairable
    && !fixedReferenceRepairs.some(change => change.sourceIndex === sourceIndex && change.originalAssetId === item.id)));
  const definitionSaveBlocked = fixedSaveUnknown || definitionEditable && sharedLive?.capabilities?.saveDefinition.allowed === false || unresolvedFixedRepairs;
  const definitionSaveReason = fixedSaveUnknown ? fixedSaveStorageError || '原修复保存结果待确认，请先核对原保存；当前编辑保留'
    : unresolvedFixedRepairs ? '请先移除或替换全部失效固定参考，再保存；正常项和当前编辑保留'
    : definitionSaveBlocked ? sharedLive?.capabilities?.saveDefinition.reason || '模板定义暂不能保存，当前编辑保留' : '';
  const [reproductionReferences, setReproductionReferences] = useState<FixedStudioReference[]>([]);
  const fixedDirty = fixedReferenceRepairs.length > 0 || JSON.stringify(fixedReferencePayload(fixedReferences)) !== JSON.stringify(fixedReferencePayload(savedFixedReferences));
  const [moduleContext, setModuleContext] = useState(module.context || '');
  const [contextComposing, setContextComposing] = useState(false);
  const [savedModuleContext, setSavedModuleContext] = useState(module.context || '');
  const [moduleSaveError, setModuleSaveError] = useState('');
  const [definitionConflict, setDefinitionConflict] = useState(false);
  const [unifiedDefaultsError, setUnifiedDefaultsError] = useState('');
  const [moduleSaved, setModuleSaved] = useState(JSON.stringify({ name: module.name, prompt, context: module.context || '', count: module.count, referenceLimit: moduleReferencePolicy(module).primaryMax, aspectRatio: module.aspectRatio || 'auto', model: module.model, quality: normalizeImageStudioQuality(module.model, module.quality), resolution: normalizeImageResolution(module.model, module.resolution || defaultImageResolution(module.model)), groupName: module.groupName || '未分组', bannerAssetId: module.banner?.id || null, referenceIds: [...module.images.filter(image => moduleReferencePolicy(module).primaryIds.includes(image.id || '')), ...module.images.filter(image => !moduleReferencePolicy(module).primaryIds.includes(image.id || ''))].map(image => image.id), reproduceFromTaskId: module.reproduceFromTaskId || null, sourcePresetId: module.sourcePresetId || null, skillIds: module.skillIds || [], styleGroupIds: module.styleGroupIds || [], referencePolicy: moduleReferencePolicy(module) }));
  const moduleSaveLock = useRef(false);
  const moduleSaveRequest = useRef<{ signature: string; requestId: string; unknown?: boolean } | null>(null);
  const restoredDraftKey = useRef('');
  const autoSaveAttempt = useRef('');
  const section = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadedSummary, setUploadedSummary] = useState<UploadedAssetPayload[]>([]);
  const [uploadSummaryTarget, setUploadSummaryTarget] = useState<'primary' | 'auxiliary' | 'fixed' | 'template' | 'banner'>('primary');
  useEffect(() => setUploadedSummary([]), [userId, module.id]);
  const [imageSourceTarget, setImageSourceTarget] = useState<'reference' | 'auxiliary' | 'banner' | 'fixed' | 'fixed-repair' | 'template'>('reference');
  const [fixedRepairTarget, setFixedRepairTarget] = useState<{ sourceIndex: number; originalAssetId: string; definitionToken: string } | null>(null);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  function openImageSource(target: 'reference' | 'auxiliary' | 'banner' | 'fixed' | 'template') {
    setImageSourceTarget(target);
    setAssetPickerOpen(true);
  }
  const [uploadProgress, setUploadProgress] = useState<ReturnType<typeof studioUploadProgress> | null>(null);
  const [bannerProgress, setBannerProgress] = useState<ReturnType<typeof studioUploadProgress> | null>(null);
  const [bannerUploading, setBannerUploading] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<ImagePreviewState | null>(null);
  const sharedReferencePreviewId = useRef<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<{ id: string; text: string } | null>(null);
  const [tasks, setTasks] = useState<StudioTask[]>([]);
  const [resultFeed, setResultFeed] = useState<StudioResultFeedExtras | null>(null);
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
    if (!sessionChanged && !isClientSessionBlocked() && templateWorkbench && !hidden && active && viewedResults?.scope === taskReadScope && viewedResults.token === viewToken && readAttemptToken.current !== viewedResults.sequence) {
      readAttemptToken.current = viewedResults.sequence;
      for (let offset = 0; offset < viewedResults.versions.length; offset += 24) {
        if (isClientSessionBlocked()) break;
        void onResultsViewed(module.id, viewedResults.versions.slice(offset, offset + 24));
      }
    }
  }, [sessionChanged, templateWorkbench, hidden, active, viewedResults, viewToken, taskReadScope, module.id, onResultsViewed]);
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
  const [submissionRecoveryScope, setSubmissionRecoveryScope] = useState('');
  const [reproduceSourceTaskId, setReproduceSourceTaskId] = useState<string | null>(sharedLive ? null : module.reproduceFromTaskId || null);
  const [reproductionGlobalContext, setReproductionGlobalContext] = useState<string | null>(null);
  const [reproductionContextConfigured, setReproductionContextConfigured] = useState(false);
  const [reproductionReferencePolicy, setReproductionReferencePolicy] = useState<StudioReferencePolicy | null>(module.reproduceFromTaskId ? moduleReferencePolicy(module) : null);
  const [appliedSource, setAppliedSource] = useState<{ taskId: string; label: string; signature: string; modified: boolean } | null>(null);
  const [selectedResultId, setSelectedResultId] = useState<string | null>(null);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [draftRestoring, setDraftRestoring] = useState(false);
  const [inputMainChoice, setInputMainChoice] = useState<ResultInputChoice | null>(null);
  const [inputMainError, setInputMainError] = useState('');
  const [inputMainBusy, setInputMainBusy] = useState(false);
  const inputMainSequence = useRef(0);
  const inputMainDialog = useRef<HTMLDialogElement>(null);
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
  const deleteCancel = useRef<HTMLButtonElement>(null);
  const deleteAnchor = useRef<HTMLElement | null>(null);
  const [downloadReady, setDownloadReady] = useState<{ url: string; name: string } | null>(null);
  const submitLock = useRef(false);
  const listLock = useRef(false);
  const loadedMore = useRef(false);
  const uploadLock = useRef(false);
  const moduleDialog = useRef<HTMLDialogElement>(null);
  const moduleContextInput = useRef<HTMLTextAreaElement>(null);
  const changeModuleContext = (value: string) => {
    setModuleContext(value); setModuleSaveError('');
  };
  const resumeModulePreview = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const auxiliaryFileInput = useRef<HTMLInputElement>(null);
  const fixedFileInput = useRef<HTMLInputElement>(null);
  const bannerFileInput = useRef<HTMLInputElement>(null);
  const suffix = module.id === `default-${userId}` ? userId : `${userId}:${module.id}`;
  const draftKey = `sd2-image-studio-draft:${suffix}`;
  const pendingKey = `sd2-image-studio-pending:${suffix}`;
  const effectiveGlobalContext = reproduceSourceTaskId && reproductionGlobalContext !== null ? reproductionGlobalContext : settings?.context;
  const referencePolicy: StudioReferencePolicy = { primaryIds: images.flatMap(image => image.id ? [image.id] : []), primaryMin, primaryMax: referenceLimit, auxiliaryMax: auxiliaryLimit, styleMax: styleLimit, referenceMax: referenceImageLimit, useFixedReferences };
  const moduleDraft = { name, prompt, context: moduleContext, count, referenceLimit, aspectRatio, model: moduleModel, quality: preserveSelectedBananaParameters ? quality : normalizeImageStudioQuality(moduleModel, quality), resolution: preserveSelectedBananaParameters ? resolution : normalizeImageResolution(moduleModel, resolution), groupName, bannerAssetId: banner?.id || null, referenceIds: [...images, ...auxiliaryImages].map(image => image.id), reproduceFromTaskId: reproduceSourceTaskId || null, sourcePresetId: module.sourcePresetId || null, skillIds: skills.map(group => group.id), styleGroupIds: styleGroups.map(group => group.id), referencePolicy };
  const moduleSaveSnapshot = { ...moduleDraft };
  const moduleDirty = JSON.stringify(moduleSaveSnapshot) !== moduleSaved;
  const baseline = moduleSaved ? JSON.parse(moduleSaved) as typeof moduleDraft : moduleDraft;
  const selectedChannel = imageChannels.items.find(item => item.id === imageChannelId);
  const selectedChannelModel = imageStudioChannelModel(selectedChannel, moduleModel);
  const allowsUnconfirmedParameters = (moduleModel === 'gemini-3-pro-image-preview' || moduleModel === 'gemini-nano-banana-2.1') && selectedChannelModel?.allowsUnconfirmedParameters === true;
  const qualitySupportUnconfirmed = allowsUnconfirmedParameters && selectedChannelModel?.qualities == null;
  const resolutionSupportUnconfirmed = allowsUnconfirmedParameters && selectedChannelModel?.resolutions == null;
  const legacyImageRoute = imageStudioUsesLegacyRoute(imageChannels, moduleModel, imageChannelId);
  const effectiveImageChannelId = imageStudioEffectiveChannelId(imageChannels, moduleModel, imageChannelId);
  const channelModels = imageStudioChannelModels(imageChannels, IMAGE_STUDIO_NEW_REQUEST_MODELS);
  const modelChoices = channelModels.includes(moduleModel) ? channelModels : [moduleModel, ...channelModels];
  function selectModuleModel(value: string, resetParameters = false) {
    if (!draftLoaded || draftRestoring || submissionRecoveryScope !== pendingKey || !batch.recoveryKnown || submitting || pendingSubmission || batch.pending) return;
    const next = imageStudioModelForNewSelection(value);
    const replacesLegacyBanana = moduleModel === 'gemini-3.1-flash-image-preview' && next === 'gemini-nano-banana-2.1';
    setModuleModel(next);
    if (resetParameters && !replacesLegacyBanana) {
      setQuality(defaultImageStudioQuality(next)); setResolution(defaultImageResolution(next));
    }
  }
  const qualityChoices = selectedChannelModel?.qualities ?? (legacyImageRoute || qualitySupportUnconfirmed
    ? IMAGE_STUDIO_MODEL_QUALITY_OPTIONS[moduleModel as keyof typeof IMAGE_STUDIO_MODEL_QUALITY_OPTIONS] || [] : []);
  const resolutionChoices = selectedChannelModel?.resolutions ?? (legacyImageRoute || resolutionSupportUnconfirmed
    ? IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS[moduleModel as keyof typeof IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS] || [] : []);
  const generationInputs = { sharedLive: sharedLive?.intent, personalOverrides: sharedLive ? personalOverrides : undefined, evolution: evolution ? evolutionInput : undefined, prompt, count, referenceLimit, aspectRatio, resolution: legacyImageRoute && !preserveSelectedBananaParameters ? normalizeImageResolution(moduleModel, resolution) : resolution, referenceIds: moduleDraft.referenceIds, model: moduleModel, quality: legacyImageRoute && !preserveSelectedBananaParameters ? normalizeImageStudioQuality(moduleModel, quality) : quality, channelId: imageChannelId, referencePolicy, context: moduleContext, fixedReferences: fixedReferencePayload(fixedReferences), skillIds: moduleDraft.skillIds, skillVersions: Object.fromEntries(skills.filter(group => group.promptVersion).map(group => [group.id, group.promptVersion!])), styleGroupIds: moduleDraft.styleGroupIds };
  const generationDraft = JSON.stringify(generationInputs);
  // `module` is the server-confirmed definition. Editor fields and browser drafts
  // stay separate; even a publisher's unfinished edits are not generation inputs.
  const effectiveGenerationDefinition = module;
  const savedGenerationPolicy = sharedLive?.defaults?.referencePolicy || moduleReferencePolicy(effectiveGenerationDefinition);
  const generationReferencePolicy: StudioReferencePolicy = {
    ...(reproduceSourceTaskId ? reproductionReferencePolicy || savedGenerationPolicy : savedGenerationPolicy),
    primaryIds: images.flatMap(image => image.id ? [image.id] : []),
  };
  const generationStyles = reproduceSourceTaskId ? reproductionStyles : effectiveGenerationDefinition.styleGroups || [];
  const generationSkills = reproduceSourceTaskId ? reproductionSkills : effectiveGenerationDefinition.skills || [];
  const generationTemplateImages = reproduceSourceTaskId ? [] : effectiveGenerationDefinition.templateImages || [];
  const generationTemplateCount = generationReferencePolicy.useFixedReferences ? (reproduceSourceTaskId
    ? Math.max(0, reproductionFixedCount - reproductionStyles.reduce((total, group) => total + group.referenceCount, 0))
    : effectiveGenerationDefinition.fixedReferenceCount ?? effectiveGenerationDefinition.fixedReferences?.length ?? 0) : 0;
  const generationFixedReferences = reproduceSourceTaskId
    ? reproductionReferences.filter((_, index) => generationReferencePolicy.useFixedReferences || index >= Math.max(0,
      reproductionFixedCount - reproductionStyles.reduce((total, group) => total + group.referenceCount, 0)))
    : generationReferencePolicy.useFixedReferences ? effectiveGenerationDefinition.fixedReferences || [] : [];
  const generationStyleImageCount = generationStyles.reduce((total, group) => total + group.referenceCount, 0);
  const generationFixedCount = generationTemplateCount + generationStyleImageCount;
  const generationOrdinaryReferenceCount = generationTemplateCount + generationTemplateImages.length + auxiliaryImages.length;
  const generationAuxiliaryCount = generationFixedCount + generationTemplateImages.length + auxiliaryImages.length;
  const generationReferenceCount = generationAuxiliaryCount + images.length;
  const generationReferenceIds = [...images, ...auxiliaryImages, ...(!sharedLive ? generationTemplateImages : [])].map(image => image.id);
  const generationReferences = [...images, ...auxiliaryImages, ...generationTemplateImages, ...generationFixedReferences];
  const generationDefinitionSignature = JSON.stringify({
    sharedLive: sharedLive?.intent, context: reproduceSourceTaskId ? undefined : effectiveGenerationDefinition.context,
    contextConfigured: reproduceSourceTaskId ? reproductionContextConfigured : effectiveGenerationDefinition.contextConfigured,
    templatePrompt: reproduceSourceTaskId ? undefined : effectiveGenerationDefinition.templatePrompt, templateReferenceIds: generationTemplateImages.map(image => image.id),
    fixedReferences: fixedReferencePayload(generationFixedReferences), fixedCount: generationTemplateCount,
    styles: generationStyles.map(group => [group.id, group.revision, group.referenceCount, group.unavailable]),
    skills: generationSkills.map(skill => [skill.id, skill.promptVersion, skill.unavailable]),
    referencePolicy: generationReferencePolicy, reproduceSourceTaskId, globalContext: effectiveGlobalContext,
  });
  function effectiveSignature(payload: ReturnType<typeof generationPayload>, channelId: string) {
    return JSON.stringify([userId, Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'requestId')),
      channelId, imageChannelId === 'original' ? imageChannels.defaultRoutes?.revision : undefined, generationDefinitionSignature]);
  }
  const effectiveGenerationSignature = settings ? effectiveSignature(generationPayload(undefined, ''), effectiveImageChannelId) : '';
  liveGenerationSignature.current = effectiveGenerationSignature;
  const actualQuoteRequired = legacyImageRoute ? settings?.billingReadiness?.models?.[moduleModel]?.ready === true
    : selectedChannelModel?.actualQuoteRequired === true || selectedChannelModel?.billingMode === 'actual';
  const moduleUnitCredits = imageStudioChannelUnitCredits(selectedChannelModel, legacyImageRoute, effectiveImageChannelId,
    settings ? settings.prices?.[moduleModel] : module.prices[moduleModel]);
  const definitionChanges = sharedLive?.mode === 'publisher' ? [
    moduleContext !== savedModuleContext ? '上下文' : '', fixedDirty ? '固定参考' : '',
    JSON.stringify(templateImageIds) !== savedTemplateImageIds.current ? '模板参考图' : '',
    templatePrompt !== savedTemplatePrompt.current ? '模板提示词' : '', name !== baseline.name ? '名称' : '',
    groupName !== baseline.groupName ? '分组' : '', (banner?.id || null) !== baseline.bannerAssetId ? '封面' : '',
    JSON.stringify({ ...referencePolicy, primaryIds: [] }) !== JSON.stringify({ ...baseline.referencePolicy, primaryIds: [] }) ? '参考图规则' : '',
    JSON.stringify(moduleDraft.styleGroupIds) !== JSON.stringify(baseline.styleGroupIds) ? '风格' : '',
    JSON.stringify(moduleDraft.skillIds) !== JSON.stringify(baseline.skillIds) ? '提示词组' : '',
  ].filter(Boolean) : [];
  const authorDefinitionDirty = definitionChanges.length > 0;
  const batch = useStudioBatch({ userId, moduleId: module.id, actualQuoteRequired, sharedLive: sharedLive?.intent, sourceAvailable: sharedReady, onSourceChanged: onSharedRefresh, quotePayload: settings ? generationPayload(undefined, '') : null, unitCredits: moduleUnitCredits, effectiveChannelId: effectiveImageChannelId,
    draftSignature: effectiveGenerationSignature });
  const contextVersion = useModuleContextVersion({ moduleId: module.id, raw: effectiveGenerationDefinition.context || '', taskId: reproduceSourceTaskId,
    editable: contextEditable, enabled: !hidden && draftLoaded && !draftRestoring, composing: contextComposing });
  function currentPresetDraft(): Record<string, unknown> {
    return {
      scope: isAdmin ? 'admin' : 'creator', groupName, prompt: sharedLive ? templatePrompt : prompt, context: moduleContext, model: moduleModel, quality, resolution,
      count, referenceLimit, referencePolicy: { ...referencePolicy, primaryIds: [] }, aspectRatio, bannerAssetId: banner?.id || null,
      referenceIds: sharedLive ? templateImageIds : auxiliaryImages.flatMap(image => image.id ? [image.id] : []), sourceModuleId: module.id,
      moduleRevision: revisionRef.current, expectedDefinitionToken: definitionBaseline.current.sharedLive?.intent.definitionToken,
      ...(sharedLive ? { personalOverrides: personalOverridesRef.current,
        personalReferenceIds: auxiliaryImages.flatMap(image => image.id ? [image.id] : []) } : {}),
      reproduceFromTaskId: reproduceSourceTaskId || undefined,
      fixedReferences: fixedEditable ? fixedReferencePayload(reproduceSourceTaskId ? reproductionReferences.slice(0, Math.max(0, reproductionFixedCount - reproductionStyles.reduce((total, group) => total + group.referenceCount, 0))) : fixedReferences) : undefined,
      skillIds: (reproduceSourceTaskId ? reproductionSkills : skills).map(group => group.id), styleGroupIds: (reproduceSourceTaskId ? reproductionStyles : styleGroups).map(group => group.id),
    };
  }
  const presetSourceReader = useRef<PresetSourceReader>(() => ({ draft: {}, blocked: '正在读取设置' }));
  presetSourceReader.current = () => ({ draft: currentPresetDraft(), blocked: !contextEditable ? '共享模板的内部配置只能由创建者更新' :
    !draftLoaded || draftRestoring || submitting || pendingSubmission || moduleSaving || presetSaving || quickPresetApplying || uploading || bannerUploading || ratioEditing ? '模块正在处理其他操作，请稍后再更新模板' : null,
    groupDeleteBlocked: !draftLoaded || draftRestoring || submitting || Boolean(pendingSubmission) || moduleSaving || moduleDeleting || presetSaving || Boolean(quickPresetApplying) || uploading || bannerUploading || automaticSnapshot !== moduleSaved,
    moduleDeletionBlocked: !draftLoaded || draftRestoring || submitting || pendingSubmission || moduleSaving || presetSaving || quickPresetApplying || uploading || bannerUploading || pendingFixedSaveRef.current || fixedSaveStorageError || sharingPending || moduleSaveRequest.current?.unknown || presetCreateRequest.current
      ? '生成、素材或保存仍在处理或待确认，请先核对原操作后再删除' : null });
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
  const savedOverrides: PersonalStudioOverrides = sharedLive ? JSON.parse(savedPersonalOverrides.current) : {};
  const savedModel = savedOverrides.model ?? baseline.model;
  const savedResolution = savedOverrides.resolution ?? baseline.resolution;
  const savedQuality = savedOverrides.quality ?? baseline.quality;
  const defaultGenerationDraft = JSON.stringify({ sharedLive: sharedLive?.intent, personalOverrides: sharedLive ? savedOverrides : undefined, evolution: evolution ? { direction: evolution.defaultDirection, manual: false } : undefined, prompt: sharedLive ? savedOverrides.prompt ?? '' : baseline.prompt,
    count: savedOverrides.count ?? baseline.count, referenceLimit: baseline.referenceLimit, aspectRatio: savedOverrides.aspectRatio ?? baseline.aspectRatio,
    resolution: legacyImageRoute ? normalizeImageResolution(savedModel, savedResolution) : savedResolution, referenceIds: baseline.referenceIds, model: savedModel,
    quality: legacyImageRoute ? normalizeImageStudioQuality(savedModel, savedQuality) : savedQuality, channelId: 'original', referencePolicy: baseline.referencePolicy, context: savedModuleContext, fixedReferences: fixedReferencePayload(savedFixedReferences), skillIds: baseline.skillIds || [], skillVersions: generationInputs.skillVersions, styleGroupIds: baseline.styleGroupIds });
  const generationChanged = generationDraft !== defaultGenerationDraft || Boolean(reproduceSourceTaskId);
  const automaticSnapshot = JSON.stringify({ ...baseline, name, groupName, bannerAssetId: banner?.id || null });
  const automaticDirty = definitionEditable && automaticSnapshot !== moduleSaved;
  const resolutionProtected = moduleDirty || automaticDirty || fixedDirty || !draftLoaded || draftRestoring || submitting || Boolean(pendingSubmission)
    || moduleSaving || moduleDeleting || presetSaving || Boolean(quickPresetApplying) || uploading || bannerUploading || Boolean(reproduceSourceTaskId);
  const resolutionDraftExcluded = moduleDirty || automaticDirty || fixedDirty || !draftLoaded || draftRestoring || Boolean(recoverableDraft);
  useLayoutEffect(() => {
    registerResolutionDirty(module.id, resolutionDraftExcluded);
    return () => registerResolutionDirty(module.id, false);
  }, [module.id, resolutionDraftExcluded, registerResolutionDirty]);
  useEffect(() => {
    if (!resolutionDelta || resolutionDelta.revision <= revisionRef.current) return;
    setBillingQuote(null);
    if (resolutionProtected || revisionRef.current !== resolutionDelta.beforeRevision) {
      setModuleSaveError('此模板的已保存分辨率已在批量操作中变化。当前草稿未覆盖；请先核对再保存。');
      return;
    }
    revisionRef.current = resolutionDelta.revision;
    setModuleRevision(resolutionDelta.revision);
    setResolution(resolutionDelta.resolution as ImageResolution);
    setModuleSaved(previous => JSON.stringify({ ...JSON.parse(previous), resolution: resolutionDelta.resolution }));
    setSaveStatus('已同步新的分辨率，其它参数未改变');
  }, [resolutionDelta, resolutionProtected]);
  useUnsavedNavigation(globalSettingsSaving || moduleSaving || presetSaving || Boolean(quickPresetApplying) || uploading || bannerUploading, confirm, {
    unsaved: [],
    busy: [globalSettingsSaving ? '通用设置正在保存' : '', moduleSaving || presetSaving ? '模板正在保存' : '', quickPresetApplying ? '快捷模板正在套用' : '', uploading ? '参考素材正在上传' : '', bannerUploading ? '封面正在上传' : ''].filter(Boolean),
    revision: automaticSnapshot + generationDraft + templatePrompt,
  });
  const settingsDirty = moduleContext !== savedModuleContext || fixedDirty || generationDraft !== defaultGenerationDraft
    || Boolean(sharedLive && (automaticDirty || authorDefinitionDirty || resetFields.length || templatePrompt !== savedTemplatePrompt.current || JSON.stringify(personalOverrides) !== savedPersonalOverrides.current));
  const contextDialogSnapshot = JSON.stringify({ templatePrompt, templateImageIds, context: moduleContext, primaryMin, primaryMax: referenceLimit,
    auxiliaryMax: auxiliaryLimit, styleMax: styleLimit, referenceMax: referenceImageLimit, useFixedReferences,
    fixedReferences: fixedReferencePayload(fixedReferences), skillIds: skills.map(group => group.id), styleGroupIds: styleGroups.map(group => group.id),
    model: moduleModel, resolution: moduleDraft.resolution, quality: moduleDraft.quality });
  const latestSettingsDraft = useRef('');
  latestSettingsDraft.current = JSON.stringify({ moduleDraft, contextDialogSnapshot, personalOverrides, name, groupName, bannerAssetId: banner?.id || null });
  async function saveModuleSettings() {
    const submitted = latestSettingsDraft.current;
    const result = await saveModule();
    if (result !== false && latestSettingsDraft.current === submitted) moduleDialog.current?.close();
  }
  function openModuleDialog() {
    if (!draftLoaded || draftRestoring) return;
    moduleDialog.current?.showModal();
  }
  async function closeModuleDialog() {
    if (moduleSaving || uploading || bannerUploading) return;
    moduleDialog.current?.close();
  }
  useDialogDismiss({ open: true, dialogRef: moduleDialog, nativeDialog: true, onDismiss: closeModuleDialog });
  useDialogDismiss({ open: Boolean(deleteTarget), dialogRef: deleteDialog, nativeDialog: true, initialFocusRef: deleteCancel, onDismiss: () => { if (!deleting) setDeleteTarget(null); } });
  const closeInputMainChoice = () => { inputMainSequence.current++; setInputMainChoice(null); setInputMainError(''); };
  useDialogDismiss({ open: Boolean(inputMainChoice), dialogRef: inputMainDialog, nativeDialog: true, onDismiss: closeInputMainChoice });
  useEffect(() => { if (inputMainChoice) inputMainDialog.current?.showModal(); else inputMainDialog.current?.close(); }, [Boolean(inputMainChoice)]);
  useEffect(() => { inputMainSequence.current++; setInputMainChoice(null); setInputMainError(''); }, [taskReadScope, viewToken, active, hidden]);
  const activeStyles = styleGroups;
  const activeTemplateCount = useFixedReferences ? (fixedEditable ? fixedReferences.length : reproduceSourceTaskId
    ? Math.max(0, reproductionFixedCount - reproductionStyles.reduce((total, group) => total + group.referenceCount, 0))
    : module.fixedReferenceCount ?? savedFixedReferences.length) : 0;
  const activeFixedReferences = useFixedReferences ? fixedReferences : [];
  const activeFixedCount = activeTemplateCount + activeStyles.reduce((total, group) => total + group.referenceCount, 0);
  const auxiliaryCount = activeFixedCount + templateImages.length + auxiliaryImages.length;
  const styleImageCount = activeStyles.reduce((total, group) => total + group.referenceCount, 0);
  const ordinaryReferenceCount = activeTemplateCount + templateImages.length + auxiliaryImages.length;
  const currentReferenceCap = Math.min(generationReferencePolicy.primaryMax, Math.max(0, MAX_REFERENCE_IMAGES - generationAuxiliaryCount));
  const currentAuxiliaryCap = Math.max(0, Math.min((generationReferencePolicy.referenceMax ?? MAX_REFERENCE_IMAGES) - generationTemplateCount,
    generationReferencePolicy.auxiliaryMax - generationFixedCount, MAX_REFERENCE_IMAGES - images.length - generationFixedCount) - generationTemplateImages.length);
  const currentTemplateCap = Math.max(0, Math.min(referenceImageLimit - activeTemplateCount, auxiliaryLimit - activeFixedCount, MAX_REFERENCE_IMAGES - images.length - activeFixedCount) - auxiliaryImages.length);
  const currentStyleCap = Math.max(0, Math.min(styleLimit, auxiliaryLimit - ordinaryReferenceCount, MAX_REFERENCE_IMAGES - images.length - ordinaryReferenceCount));
  const sourceSharingBlocked = sharedLive ? !sharedReady : Boolean(module.sourcePresetId && module.sourcePresetShared === false && !module.sourcePresetOwnedByViewer);

  useLayoutEffect(() => {
    if (!sharedLive || !draftLoaded || draftRestoring) return;
    const token = `${sharedLive.intent.definitionToken}:${module.revision}:${sharedLive.available}:${sharedReady}`;
    if (appliedSharedToken.current === token) return;
    const previous = definitionBaseline.current;
    const authorDirty = authorDefinitionDirty;
    const changed = Boolean(appliedSharedToken.current && previous.sharedLive?.intent.definitionToken !== sharedLive.intent.definitionToken);
    appliedSharedToken.current = token;
    setBillingQuote(null);
    if (!sharedLive.available && !repairDefinition || !hasSharedDefaults(sharedLive.defaults)) {
      if (sharedReferencePreviewId.current) { setPreview(null); sharedReferencePreviewId.current = null; }
      setTemplateImages([]); savedTemplateImageIds.current = '[]';
      setTemplatePrompt(''); setModuleContext(''); setSavedModuleContext('');
      setFixedReferences([]); setSavedFixedReferences([]); setStyleGroups([]); setSkills([]); setBanner(null); setName(module.name); setGroupName(module.groupName || '未分组');
      setReproductionReferences([]); setReproductionStyles([]); setReproductionSkills([]); setReproductionFixedCount(0); setReproductionGlobalContext(null);
      setQuickPresets([]);
      setModuleSaved(current => JSON.stringify({ ...JSON.parse(current), context: '', name: module.name, groupName: module.groupName || '未分组', bannerAssetId: null, skillIds: [], styleGroupIds: [] }));
      definitionBaseline.current = module;
      setTasks(current => current.map(task => task.snapshot ? { ...task, snapshot: { ...task.snapshot,
        sourceAvailable: false, contextAvailable: false, moduleContext: undefined, globalContext: undefined,
        fixedReferenceImages: [], styleGroups: [], skills: [] } } : task));
      return;
    }
    const defaults = sharedLive.defaults;
    if (sharedReferencePreviewId.current && !(module.templateReferenceIds || []).includes(sharedReferencePreviewId.current)) {
      setPreview(null); sharedReferencePreviewId.current = null;
    }
    const overrides = personalOverridesRef.current;
    const nextModel = overrides.model ?? defaults.model ?? module.model;
    if (!Object.prototype.hasOwnProperty.call(overrides, 'model')) setModuleModelValue(nextModel);
    if (!Object.prototype.hasOwnProperty.call(overrides, 'count')) setCountValue(defaults.count ?? module.count);
    if (!Object.prototype.hasOwnProperty.call(overrides, 'quality')) setQualityValue(defaults.quality ?? module.quality);
    if (!Object.prototype.hasOwnProperty.call(overrides, 'resolution')) setResolutionValue(defaults.resolution ?? module.resolution);
    if (!Object.prototype.hasOwnProperty.call(overrides, 'aspectRatio')) setAspectRatioValue(defaults.aspectRatio ?? module.aspectRatio);
    // Personal prompt, primary images, temporary references and result selection never come from the source.
    if (authorDirty) {
      if (repairDefinition) {
        const invalidTemplates = new Set(repairDefinition.templateReferences.filter(item => item.status !== 'valid').map(item => item.id));
        const invalidFixed = new Set(repairDefinition.fixedReferences.filter(item => item.status !== 'valid').map(item => item.id));
        const invalidStyles = new Set(repairDefinition.styleGroups.filter(item => item.status !== 'valid').map(item => item.id));
        const invalidSkills = new Set(repairDefinition.skillGroups.filter(item => item.status !== 'valid').map(item => item.id));
        setTemplateImages(items => items.map(item => item.id && invalidTemplates.has(item.id) ? { id: item.id } : item));
        setFixedReferences(items => items.map(item => item.id && invalidFixed.has(item.id) ? { id: item.id, note: '', available: false } : item));
        setStyleGroups(items => items.map((item, index) => invalidStyles.has(item.id) ? { id: item.id, name: `待处理风格 ${index + 1}`, coverUrl: null, canManage: false, referenceCount: 0, unavailable: true } : item));
        setSkills(items => items.map((item, index) => invalidSkills.has(item.id) ? { id: item.id, name: `待处理提示词组 ${index + 1}`, unavailable: true } : item));
        const badBanner = repairDefinition.banner && repairDefinition.banner.status !== 'valid' ? repairDefinition.banner : null;
        if (badBanner) setBanner(item => item && item.id === badBanner.id ? { id: item.id } : item);
        const invalidMedia = new Set([...Array.from(invalidTemplates), ...Array.from(invalidFixed), ...(repairDefinition.banner && repairDefinition.banner.status !== 'valid' ? [repairDefinition.banner.id] : [])]);
        if (preview?.contentKey?.startsWith('asset:') && invalidMedia.has(preview.contentKey.slice(6))) setPreview(null);
      }
      if (changed) { setDefinitionConflict(true); setModuleSaveError('模板已在另一处保存，当前编辑保留；请核对后再保存，不会自动覆盖。'); }
      return;
    }
    definitionBaseline.current = module;
    setDefinitionConflict(false);
    revisionRef.current = module.revision; setModuleRevision(module.revision);
    setName(module.name); setGroupName(module.groupName || '未分组'); setBanner(module.banner || null);
    const nextPrompt = module.templatePrompt || '';
    setTemplatePrompt(nextPrompt); savedTemplatePrompt.current = nextPrompt;
    setModuleContext(module.context || ''); setSavedModuleContext(module.context || '');
    setFixedReferences(module.fixedReferences || []); setSavedFixedReferences(module.fixedReferences || []);
    setTemplateImages(module.templateImages || []); savedTemplateImageIds.current = JSON.stringify(module.templateReferenceIds || []);
    setStyleGroups(module.styleGroups || []); setSkills(module.skills || []);
    const policy = defaults.referencePolicy || moduleReferencePolicy(module);
    setPrimaryMin(policy.primaryMin); setReferenceLimit(policy.primaryMax); setAuxiliaryLimit(policy.auxiliaryMax);
    setStyleLimit(policy.styleMax ?? MAX_REFERENCE_IMAGES); setReferenceImageLimit(policy.referenceMax ?? MAX_REFERENCE_IMAGES); setUseFixedReferences(policy.useFixedReferences);
    setModuleSaved(current => JSON.stringify({ ...JSON.parse(current), name: module.name, groupName: module.groupName || '未分组',
      bannerAssetId: module.banner?.id || null, context: module.context || '', model: nextModel, count: defaults.count ?? module.count,
      quality: defaults.quality ?? module.quality, resolution: defaults.resolution ?? module.resolution, aspectRatio: defaults.aspectRatio ?? module.aspectRatio,
      referenceLimit: policy.primaryMax, referencePolicy: { ...policy, primaryIds: images.flatMap(image => image.id ? [image.id] : []) },
      skillIds: module.skillIds || [], styleGroupIds: module.styleGroupIds || [] }));
    if (changed) setSaveStatus('模板已更新，请确认本次生成');
  }, [module, sharedLive, sharedReady, draftLoaded, draftRestoring]);

  useEffect(() => {
    // Group removal updates modules in the parent without remounting editors.
    if (sharedLive || resolutionDelta?.revision === module.revision) return;
    if (module.revision <= revisionRef.current) return;
    revisionRef.current = module.revision;
    setModuleRevision(module.revision);
    setGroupName(module.groupName || '未分组');
    setModuleSaved(current => current ? JSON.stringify({ ...JSON.parse(current), groupName: module.groupName || '未分组' }) : current);
  }, [module.revision, module.groupName, resolutionDelta]);

  useEffect(() => {
    const panel = deleteDialog.current;
    if (!panel) return;
    if (!deleteTarget) { panel.close(); return; }
    panel.showModal();
    if (!templateWorkbench) return;
    // Match the existing product-dialog placement while keeping this delete contract.
    const place = () => {
      const viewport = window.visualViewport;
      const margin = 16, gap = 8;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const left = (viewport?.offsetLeft ?? 0) + margin;
      const top = (viewport?.offsetTop ?? 0) + margin;
      const right = left + width - margin * 2;
      const bottom = top + height - margin * 2;
      panel.style.width = `${Math.min(300, Math.max(0, width - margin * 2))}px`;
      panel.style.maxHeight = `${Math.max(0, height - margin * 2)}px`;
      const w = panel.offsetWidth, h = panel.offsetHeight;
      const clampX = (x: number) => Math.max(left, Math.min(x, right - w));
      const clampY = (y: number) => Math.max(top, Math.min(y, bottom - h));
      const rect = deleteAnchor.current?.isConnected ? deleteAnchor.current.getBoundingClientRect() : null;
      // A cramped viewport or a removed/offscreen card uses the compact center fallback.
      let x = left + (right - left - w) / 2, y = top + (bottom - top - h) / 2;
      if (rect && rect.width > 0 && rect.height > 0 && rect.bottom > top && rect.top < bottom && rect.right > left && rect.left < right) {
        if (rect.bottom + gap + h <= bottom) { x = clampX(rect.left); y = rect.bottom + gap; }
        else if (rect.top - gap - h >= top) { x = clampX(rect.left); y = rect.top - gap - h; }
        else if (rect.right + gap + w <= right) { x = rect.right + gap; y = clampY(rect.top); }
        else if (rect.left - gap - w >= left) { x = rect.left - gap - w; y = clampY(rect.top); }
      }
      Object.assign(panel.style, { left: `${x}px`, top: `${y}px`, right: 'auto', bottom: 'auto', margin: '0' });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    if (deleteAnchor.current?.isConnected) observer.observe(deleteAnchor.current);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
      observer.disconnect();
      panel.style.cssText = '';
    };
  }, [deleteTarget, templateWorkbench]);
  useEffect(() => { if (nameEditing) nameInput.current?.focus(); }, [nameEditing]);

  useEffect(() => {
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { rootMargin: '200px' });
    if (section.current) observer.observe(section.current);
    return () => observer.disconnect();
  }, []);

  async function saveModule(reproduceTaskId = reproduceSourceTaskId, revisionOverride = revisionRef.current, manualSettings = true, fixedOverride?: FixedStudioReference[]) {
    if (isClientSessionBlocked()) return false;
    // Re-read the original object's persistent lock even if repair instructions
    // were undone or the latest projection no longer offers repair capability.
    if (manualSettings) {
      try {
        const original = pendingFixedSaveRef.current || readFixedReferenceSave(userId, module.id);
        if (original) { pendingFixedSaveRef.current = original; setPendingFixedSave(original);
          setModuleSaveError('原修复保存结果待确认，请先核对原保存，不会换号重发'); return false; }
      } catch { setFixedSaveStorageError('本机修复保存记录无法读取，本次尚未提交'); return false; }
    }
    if (manualSettings && definitionSaveBlocked) { setModuleSaveError(definitionSaveReason); return false; }
    if (!sharedReady && !(manualSettings && definitionReady && sharedLive?.capabilities?.saveDefinition.allowed)) { setModuleSaveError('模板暂不可用，本人草稿和历史保留'); return false; }
    if (moduleSaveLock.current || moduleDeleteLock.current || presetSaveLock.current || quickPresetLock.current || uploading || bannerUploading) return false;
    moduleSaveLock.current = true; setModuleSaving(true); setError(''); setModuleSaveError('');
    const snapshot = { ...(manualSettings ? moduleDraft : JSON.parse(automaticSnapshot) as typeof moduleDraft), context: manualSettings ? moduleContext : savedModuleContext, reproduceFromTaskId: manualSettings ? reproduceTaskId || null : baseline.reproduceFromTaskId };
    const contextSnapshot = snapshot.context;
    const fixedSnapshot = fixedOverride || (manualSettings ? fixedReferences : savedFixedReferences);
    const publishNew = Boolean(unpublishedSharing && manualSettings);
    const saveDefinition = Boolean(sharedLive && definitionEditable && manualSettings) || publishNew;
    const submittedOverrides: PersonalStudioOverrides = publishNew
      ? { prompt, model: moduleModel, quality, resolution, count, aspectRatio }
      : { ...personalOverridesRef.current };
    const submittedResets = [...resetFieldsRef.current];
    const submittedTemplateIds = [...templateImageIds];
    const savePayload: Record<string, unknown> = sharedLive || publishNew ? {
      id: module.id, revision: revisionOverride, saveIntent: saveDefinition ? 'definition' : 'personal', personalOverrides: submittedOverrides, entryPoint: 'workbench',
      resetFields: submittedResets,
      ...(saveDefinition ? { ...snapshot, prompt: templatePrompt, templatePrompt, sharedLive: definitionBaseline.current.sharedLive?.intent,
        ...(publishNew ? { isShared: true, sharingPreferenceRevision: module.sharingPreference?.revision } : {}),
        referenceIds: publishNew ? [] : submittedTemplateIds, referencePolicy: { ...referencePolicy, primaryIds: [] },
        personalReferenceIds: snapshot.referenceIds, personalReferencePolicy: referencePolicy,
        reproduceFromTaskId: reproduceTaskId || undefined,
        context: contextEditable ? contextSnapshot : undefined, fixedReferences: fixedEditable ? fixedReferencePayload(fixedSnapshot) : undefined }
        : { referenceIds: snapshot.referenceIds, referencePolicy }),
    } : { id: module.id, revision: revisionOverride, ...snapshot, context: contextEditable ? contextSnapshot : undefined, fixedReferences: fixedEditable && (manualSettings || fixedOverride) ? fixedReferencePayload(fixedSnapshot) : undefined };
    if (saveDefinition && fixedRepairAllowed && fixedReferenceRepairs.length) savePayload.fixedReferenceRepairs = fixedReferenceRepairs;
    if (repairDefinition && saveDefinition) {
      // Missing reads are not user removals: absent fields preserve stored values.
      // Explicit edits (including []) remain in the request and are validated as
      // a complete resulting definition by the server's original resolver.
      const saved = definitionBaseline.current;
      const unchanged: Record<string, unknown> = { name: saved.name, groupName: saved.groupName,
        prompt: saved.templatePrompt, templatePrompt: saved.templatePrompt, context: saved.context,
        model: saved.model, quality: saved.quality, resolution: saved.resolution, count: saved.count, aspectRatio: saved.aspectRatio,
        referenceLimit: saved.referenceLimit, referenceIds: saved.templateReferenceIds || [],
        referencePolicy: { ...moduleReferencePolicy(saved), primaryIds: [] },
        fixedReferences: fixedReferencePayload(saved.fixedReferences || []), styleGroupIds: saved.styleGroupIds || [],
        skillIds: saved.skillIds || [], bannerAssetId: saved.banner?.id || null,
        reproduceFromTaskId: saved.reproduceFromTaskId || undefined };
      const badFixed = new Set(repairDefinition.fixedReferences.filter(item => item.status !== 'valid').map(item => item.id));
      const comparable = (field: string, value: unknown) => field === 'fixedReferences' && Array.isArray(value)
        ? value.map(item => badFixed.has(item.assetId) ? { assetId: item.assetId } : item) : value;
      for (const [field, value] of Object.entries(unchanged)) if (JSON.stringify(comparable(field, savePayload[field])) === JSON.stringify(comparable(field, value))) delete savePayload[field];
    }
    const signature = JSON.stringify(savePayload);
    const request: NonNullable<typeof moduleSaveRequest.current> = moduleSaveRequest.current?.signature === signature ? moduleSaveRequest.current : { signature, requestId: crypto.randomUUID() };
    moduleSaveRequest.current = request;
    const currentSaveScope = fixedSaveScope.current;
    const validSaveScope = () => fixedSaveScope.current === currentSaveScope && currentSaveScope.active && !sessionChanged && !isClientSessionBlocked();
    let repairSave: FixedReferenceSavePending | null = null;
    let postStarted = false;
    try {
      if (isClientSessionBlocked()) return false;
      if (saveDefinition && fixedRepairAllowed && fixedReferenceRepairs.length) {
        const intent = definitionBaseline.current.sharedLive?.intent;
        if (!intent?.presetId || !intent.definitionToken || !validSaveScope()) throw new Error('原模板版本尚未确认，本次尚未提交');
        repairSave = await claimFixedReferenceSave({ version: 1, actorId: userId, moduleId: module.id, presetId: intent.presetId,
          requestId: request.requestId, expectedRevision: revisionOverride, definitionToken: intent.definitionToken });
        if (!validSaveScope()) { await clearFixedReferenceSave(repairSave); return false; }
        pendingFixedSaveRef.current = repairSave; setPendingFixedSave(repairSave);
      }
      postStarted = true;
      const result = await readResponse(await fetch('/api/image-studio/modules', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...savePayload, ...(sharedLive || publishNew ? { requestId: request.requestId } : {}) }) }));
      if (!validSaveScope()) return false;
      if (repairSave && (result.commandReceipt?.requestId !== repairSave.requestId
        || !fixedReferenceReceiptMatches({ status: 'completed', receipt: result.commandReceipt }, repairSave))) throw new Error('原修复保存回执尚未确认，请核对原保存');
      if (!Number.isInteger(result.revision) || result.revision <= revisionOverride
        || publishNew && (result.sharedLive?.mode !== 'publisher' || result.sourcePresetShared !== true || result.sourcePresetId !== `module-source:${module.id}`)) throw new Error('保存结果尚未确认，当前草稿已保留，请核对后重试');
      if (repairSave) { await clearFixedReferenceSave(repairSave); if (!validSaveScope()) return false;
        pendingFixedSaveRef.current = null; setPendingFixedSave(null); }
      revisionRef.current = result.revision;
      setModuleRevision(result.revision); setModuleSaved(JSON.stringify({ ...snapshot, context: contextSnapshot }));
      setSavedModuleContext(contextSnapshot);
      setSavedFixedReferences(result.fixedReferences || fixedSnapshot);
      if (saveDefinition) setFixedReferenceRepairs([]);
      if (sharedLive || publishNew) {
        if (publishNew) { personalOverridesRef.current = submittedOverrides; setPersonalOverrides(submittedOverrides); }
        savedPersonalOverrides.current = JSON.stringify(submittedOverrides);
        resetFieldsRef.current = resetFieldsRef.current.filter(field => !submittedResets.includes(field));
        setResetFields(resetFieldsRef.current);
      }
      if (saveDefinition) { savedTemplatePrompt.current = templatePrompt; savedTemplateImageIds.current = JSON.stringify(submittedTemplateIds); definitionBaseline.current = studioRepairModule(result); }
      if (fixedOverride) setFixedReferences(result.fixedReferences || fixedOverride);
      else if (manualSettings) setFixedReferences(current => JSON.stringify(fixedReferencePayload(current)) === JSON.stringify(fixedReferencePayload(fixedSnapshot)) ? result.fixedReferences || fixedSnapshot : current);
      onModuleChange(result);
      if (publishNew) { onSharedRefresh(); setSaveStatus('模板已共享给同事，本次描述、主图和临时参考仅自己可见'); }
      moduleSaveRequest.current = null;
      return result.revision as number;
    } catch (e) {
      if (!validSaveScope()) return false;
      const outcome = (e as { commandOutcome?: { status?: string; actorId?: string; moduleId?: string; requestId?: string } })?.commandOutcome;
      request.unknown = postStarted && !(outcome?.status === 'not-applied' && outcome.actorId === userId && outcome.moduleId === module.id && outcome.requestId === request.requestId);
      if (!repairSave && saveDefinition && fixedRepairAllowed && fixedReferenceRepairs.length) {
        try { const original = readFixedReferenceSave(userId, module.id);
          if (original) { pendingFixedSaveRef.current = original; setPendingFixedSave(original); } }
        catch { setFixedSaveStorageError('本机修复保存记录无法读取，本次尚未提交'); }
      }
      if (repairSave && (!postStarted || fixedReferenceSaveRejected(e, repairSave))) {
        try { await clearFixedReferenceSave(repairSave); if (!validSaveScope()) return false;
          pendingFixedSaveRef.current = null; setPendingFixedSave(null); moduleSaveRequest.current = null; }
        catch { if (!validSaveScope()) return false; setFixedSaveStorageError('保存结果已确认，但本机记录未清理，请核对原保存'); }
      }
      const message = e instanceof Error ? e.message : '保存失败'; setError(message); setModuleSaveError(message);
      if (saveDefinition && Number((e as { status?: number })?.status) === 409) setDefinitionConflict(true);
      if (sharedLive && [401, 403, 404, 409].includes(Number((e as { status?: number })?.status))) onSharedRefresh();
      return false;
    }
    finally { if (validSaveScope()) { moduleSaveLock.current = false; setModuleSaving(false); } }
  }

  async function queryFixedReferenceSave() {
    const current = fixedSaveScope.current;
    const valid = () => fixedSaveScope.current === current && current.active && !sessionChanged && !isClientSessionBlocked();
    if (!valid() || checkingFixedSave || moduleSaveLock.current) return;
    setCheckingFixedSave(true);
    try {
      const command = pendingFixedSaveRef.current || readFixedReferenceSave(userId, module.id);
      if (!command) throw new Error('原保存记录暂无法确认，请保留草稿并核对本机存储');
      pendingFixedSaveRef.current = command; setPendingFixedSave(command);
      const result = await readResponse(await fetch(`/api/image-studio/presets?mode=command-status&requestId=${encodeURIComponent(command.requestId)}`,
        { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) }));
      if (!valid()) return;
      if (!fixedReferenceReceiptMatches(result, command)) throw new Error(result.status === 'not-found'
        ? '尚未查到原保存回执，结果仍待确认；不会重新提交' : '原保存回执尚未确认，请继续核对原保存');
      await clearFixedReferenceSave(command); if (!valid()) return;
      pendingFixedSaveRef.current = null; setPendingFixedSave(null); setFixedSaveStorageError('');
      moduleSaveRequest.current = null; setDefinitionConflict(true); setModuleSaveError('原修复保存已确认。当前编辑保留，请核对最新模板后再保存');
      setSaveStatus('原修复保存已确认，当前草稿未自动覆盖或提交');
      // Refresh current facts separately; do not adopt receipt/current as the
      // current editor's baseline or consume a successor revision silently.
      onSharedRefresh();
    } catch (cause) {
      if (valid()) setModuleSaveError(cause instanceof Error ? cause.message : '原保存结果仍待确认，请继续核对');
    } finally { if (valid()) setCheckingFixedSave(false); }
  }

  async function changeModuleSharing(anchor?: HTMLElement) {
    if (moduleSaveLock.current || moduleDeleteLock.current || uploading || bannerUploading || submitting || pendingSubmission || presetSaveLock.current) return;
    if (module.sourcePresetCanManageSharing && module.sourcePresetId) {
      await onToggleSharing(module, anchor);
      return;
    }
    if (!module.canChooseSharing || sharedLive) return;
    const request = sharingPreferenceRequest.current ||= { id: module.id, revision: revisionRef.current,
      isShared: !module.sharingPreference?.enabled, requestId: crypto.randomUUID() };
    moduleSaveLock.current = true; setSharingPreferenceSaving(true); setError('');
    try {
      const result: StudioModule = await readResponse(await fetch('/api/image-studio/modules', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-sharing-preference', ...request, entryPoint: 'workbench' }) }));
      if (result.sharingPreference?.requestId !== request.requestId || result.sharingPreference.enabled !== request.isShared) throw new Error('共享选择尚未确认，请重试原操作；当前内容保留');
      revisionRef.current = result.revision; setModuleRevision(result.revision);
      onModuleChange(result); sharingPreferenceRequest.current = null;
      setSaveStatus(request.isShared ? '已选择共享，保存模板后生效' : '已设为仅自己可见，内容保持不变');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '共享选择保存未确认，请重试原操作');
    } finally { moduleSaveLock.current = false; setSharingPreferenceSaving(false); }
  }

  async function restoreDefaults() {
    if (quickPresetLock.current || presetSaveLock.current || submitting || pendingSubmission || moduleSaving || uploading || bannerUploading || draftRestoring) return;
    if (!(await confirm(sharedLive ? '恢复共享模板当前已保存的设置？本人主图保留，当前草稿仍可恢复。' : templateWorkbench ? '恢复当前模块默认参数和参考图？上次临时草稿仍可恢复。' : '恢复当前模板默认参数和参考图？上次临时草稿仍可恢复。', { title: '恢复默认', confirmLabel: '恢复默认' }))) return;
    try { const saved = JSON.parse(localStorage.getItem(draftKey) || 'null'); if (saved) setRecoverableDraft(saved); } catch {}
    blockedDraftSignature.current = null;
    if (sharedLive) {
      if (!sharedLive.available || !hasSharedDefaults(sharedLive.defaults)) { setError('模板暂不可用，本人草稿和历史保留'); return; }
      const defaults = sharedLive.defaults;
      personalOverridesRef.current = {}; setPersonalOverrides({});
      resetFieldsRef.current = [...PERSONAL_OVERRIDE_FIELDS]; setResetFields(resetFieldsRef.current);
      setPromptValue(''); setModuleModelValue(defaults.model || module.model); setCountValue(defaults.count ?? module.count);
      setQualityValue(defaults.quality || module.quality); setResolutionValue(defaults.resolution || module.resolution);
      setAspectRatioValue(defaults.aspectRatio || module.aspectRatio);
      const policy = defaults.referencePolicy || moduleReferencePolicy(module);
      if (sharedLive.mode === 'publisher') {
        definitionBaseline.current = module; savedTemplatePrompt.current = module.templatePrompt || '';
        setTemplatePrompt(module.templatePrompt || ''); setModuleContext(module.context || ''); setSavedModuleContext(module.context || '');
        setName(module.name); setGroupName(module.groupName || '未分组'); setBanner(module.banner || null);
        setFixedReferences(module.fixedReferences || []); setSavedFixedReferences(module.fixedReferences || []);
        setTemplateImages(module.templateImages || []); savedTemplateImageIds.current = JSON.stringify(module.templateReferenceIds || []);
        setStyleGroups(module.styleGroups || []); setSkills(module.skills || []);
        revisionRef.current = module.revision; setModuleRevision(module.revision);
        setModuleSaved(current => JSON.stringify({ ...JSON.parse(current), name: module.name, groupName: module.groupName || '未分组',
          bannerAssetId: module.banner?.id || null, context: module.context || '', skillIds: module.skillIds || [], styleGroupIds: module.styleGroupIds || [], referencePolicy: { ...policy, primaryIds: referencePolicy.primaryIds },
          referenceLimit: policy.primaryMax, model: defaults.model || module.model, quality: defaults.quality || module.quality,
          resolution: defaults.resolution || module.resolution, count: defaults.count ?? module.count, aspectRatio: defaults.aspectRatio || module.aspectRatio }));
        setModuleSaveError('');
      }
      setPrimaryMin(policy.primaryMin); setReferenceLimit(policy.primaryMax); setAuxiliaryLimit(policy.auxiliaryMax);
      setStyleLimit(policy.styleMax ?? MAX_REFERENCE_IMAGES); setReferenceImageLimit(policy.referenceMax ?? MAX_REFERENCE_IMAGES); setUseFixedReferences(policy.useFixedReferences);
      setSaveStatus('已恢复当前模板默认参数，主图保留');
      return;
    }
    setPrompt(baseline.prompt); setCount(baseline.count); setReferenceLimit(baseline.referenceLimit); setAspectRatio(baseline.aspectRatio); setModuleModel(baseline.model);
    setEvolutionInput({ direction: evolution?.defaultDirection || 'increase', manual: false });
    setQuality(baseline.quality); setResolution(baseline.resolution);
    setImages(module.images.filter(image => baseline.referencePolicy.primaryIds.includes(image.id || '')));
    setAuxiliaryImages(module.images.filter(image => !baseline.referencePolicy.primaryIds.includes(image.id || '')));
    setPrimaryMin(baseline.referencePolicy.primaryMin); setAuxiliaryLimit(baseline.referencePolicy.auxiliaryMax); setUseFixedReferences(baseline.referencePolicy.useFixedReferences);
    setStyleLimit(baseline.referencePolicy.styleMax ?? MAX_REFERENCE_IMAGES); setReferenceImageLimit(baseline.referencePolicy.referenceMax ?? MAX_REFERENCE_IMAGES);
    setFixedReferences(savedFixedReferences); setModuleContext(savedModuleContext); setStyleGroups(module.styleGroups || []); setSkills(module.skills || []); setReproductionSkills([]); setReproduceSourceTaskId(null); setReproductionReferencePolicy(null);
    setReproductionGlobalContext(null); setAppliedSource(null);
    setModuleSaveError('');
  }

  function applyUnifiedDefaults() {
    if (!draftLoaded || draftRestoring || quickPresetLock.current || presetSaveLock.current || submitting || pendingSubmission
      || moduleSaving || moduleDeleting || uploading || bannerUploading || ratioEditing) return;
    try {
      if (!settings?.templateDefaults) throw new Error('统一默认设置尚未读取，请重新读取通用设置后再试。');
      const defaults = parseStudioTemplateDefaults(settings.templateDefaults);
      if (styleGroups.some(group => group.unavailable)) throw new Error('当前风格组不可用，请先处理后再套用统一默认。');
      const styles = styleGroups.reduce((total, group) => total + group.referenceCount, 0);
      const fixedCount = fixedEditable ? fixedReferences.length : module.fixedReferenceCount ?? savedFixedReferences.length;
      const rules = definitionEditable ? defaults : referencePolicy;
      const ordinary = templateImages.length + auxiliaryImages.length + (rules.useFixedReferences ? fixedCount : 0);
      if (images.length > rules.primaryMax || styles > (rules.styleMax ?? MAX_REFERENCE_IMAGES) || ordinary > (rules.referenceMax ?? MAX_REFERENCE_IMAGES)
        || styles + ordinary > rules.auxiliaryMax || images.length + styles + ordinary > MAX_REFERENCE_IMAGES) {
        throw new Error('统一默认的图片上限低于当前已选素材，未套用；请先调整默认上限或自行移除素材。');
      }
      // Parameters only: retain all content and source identities. The existing draft signature invalidates quotations.
      if (definitionEditable) {
        setPrimaryMin(defaults.primaryMin); setReferenceLimit(defaults.primaryMax); setStyleLimit(defaults.styleMax);
        setReferenceImageLimit(defaults.referenceMax); setAuxiliaryLimit(defaults.auxiliaryMax); setUseFixedReferences(defaults.useFixedReferences);
      }
      setModuleModel(defaults.model); setQuality(defaults.quality); setResolution(defaults.resolution);
      setCount(defaults.count); setAspectRatio(defaults.aspectRatio);
      if (reproduceSourceTaskId) exitReproductionMode();
      setUnifiedDefaultsError(''); setError('');
      setSaveStatus('已套用统一默认，正文和素材保留。');
    } catch (cause) { setUnifiedDefaultsError(cause instanceof Error ? cause.message : '统一默认未套用，请重试'); }
  }

  async function deleteModule(anchor?: HTMLElement) {
    if (moduleDeleteLock.current || moduleSaveLock.current || submitting || uploading || bannerUploading) return;
    moduleDeleteLock.current = true; setModuleDeleting(true); setError('');
    try {
      await onModuleDelete(module, anchor);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '删除失败，请重试'); }
    finally { moduleDeleteLock.current = false; setModuleDeleting(false); }
  }

  async function saveAsPreset() {
    if (!contextEditable) { setError('共享模板的内部上下文由创建者维护，不能另存内部配置；本次参数仍可直接生成。'); return; }
    if (presetSaveLock.current || quickPresetLock.current || moduleSaving || draftRestoring || submitting || pendingSubmission) return;
    await askName('模板名称（共享不包含本次描述、主图和临时参考）', presetCreateRequest.current?.payload.name || name, { title: '另存为模板', confirmLabel: '保存模板', maxLength: 80,
      checkbox: { label: '共享给同事', checked: presetCreateRequest.current?.payload.isShared ?? module.sharingPreference?.enabled ?? (sharedLive ? module.sourcePresetShared === true : true) }, onSubmit: async (presetName, isShared) => {
      if (presetSaveLock.current) return;
      if (presetCreateRequest.current && (presetCreateRequest.current.payload.name !== presetName || presetCreateRequest.current.payload.isShared !== (isShared === true))) {
        throw new Error('上次保存尚未确认，请先按原名称和共享范围重试，不会重复另存');
      }
      if (!sharedLive && !module.saved && !presetCreateRequest.current) {
        if (await saveModule() === false) throw new Error('自己的模块尚未保存，快捷设置未另存；当前输入保留。');
      }
      presetSaveLock.current = true; setPresetSaving(true);
      const draft = currentPresetDraft();
      const sharedDraft = { ...draft, prompt: templatePrompt, templatePrompt,
        referenceIds: sharedLive ? templateImageIds : [],
        personalOverrides: sharedLive ? undefined : { prompt, model: moduleModel, quality, resolution, count, aspectRatio },
        personalReferenceIds: sharedLive ? undefined : moduleDraft.referenceIds,
        personalReferencePolicy: sharedLive ? undefined : referencePolicy };
      const request: NonNullable<typeof presetCreateRequest.current> = presetCreateRequest.current ||= { requestId: crypto.randomUUID(),
        payload: { ...(isShared === true ? sharedDraft : draft), name: presetName, isShared: isShared === true,
          ...(isShared === true ? {} : { saveIntent: 'personal-quick' }) }, generationSignature: generationDraft };
      try {
        const created = request.result || await readResponse(await fetch('/api/image-studio/presets', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...request.payload, requestId: request.requestId }) }));
        if (typeof created.id !== 'string' || !created.id || request.payload.isShared && (typeof created.publisherModuleId !== 'string' || !created.publisherModuleId)) {
          throw new Error('保存结果尚未完整确认，请重试原保存，不会新建另一份模板');
        }
        request.result = created;
        if (request.payload.isShared && created.publisherModuleId === module.id) {
          const data = await readResponse(await fetch(`/api/image-studio/modules?ids=${encodeURIComponent(module.id)}`, { cache: 'no-store' }));
          const binding: StudioModule | undefined = data.modules?.find((item: StudioModule) => item.id === module.id);
          if (binding?.sharedLive?.mode === 'publisher' && binding.sharedLive.intent.presetId === created.id) onModuleChange(binding);
          else throw new Error('模板已保存，共享工作区尚未读取，请核对原模板，不要重复另存');
        } else if (!request.payload.isShared && !sharedLive) {
          const data = await readResponse(await fetch(`/api/image-studio/modules?ids=${encodeURIComponent(module.id)}`, { cache: 'no-store' }));
          const saved: StudioModule | undefined = data.modules?.find((item: StudioModule) => item.id === module.id);
          if (!saved?.saved || saved.sourcePresetId !== created.id || saved.sharingPreference?.enabled !== false) throw new Error('快捷模板已保存，关闭共享的状态尚未确认；请按原保存继续核对，不会重复新建');
          onModuleChange(saved);
        }
        await onPresetSaved();
        presetCreateRequest.current = null;
        setSaveStatus('模板已保存'); setSavedAsSignature(request.generationSignature);
        void loadQuickPresets();
      } catch (cause) {
        if (!request.result && [400, 401, 403, 404, 409].includes(Number((cause as { status?: number })?.status))) presetCreateRequest.current = null;
        throw cause;
      } finally { presetSaveLock.current = false; setPresetSaving(false); }
    } });
  }

  const loadQuickPresets = useCallback(async () => {
    if (sharedLive?.available === false) { setQuickPresets([]); setQuickPresetsLoading(false); return null; }
    const sequence = ++quickPresetReadSequence.current;
    const current = () => quickPresetReadScope.current === quickPresetScopeKey && sequence === quickPresetReadSequence.current;
    setQuickPresetsLoading(true); setQuickPresetsError('');
    try {
      const result = await readResponse(await fetch(`/api/image-studio/presets?moduleId=${encodeURIComponent(module.id)}`, { cache: 'no-store' }));
      if (!current()) return null;
      setQuickPresets(result.presets || []);
      return result.presets as QuickStudioPreset[];
    } catch (cause) { if (current()) setQuickPresetsError(cause instanceof Error ? cause.message : '快捷模板读取失败'); return null; }
    finally { if (current()) setQuickPresetsLoading(false); }
  }, [module.id, userId, quickPresetScopeKey, sharedLive?.available]);
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
      if ((current as QuickStudioPreset & { personalReferencesAvailable?: boolean }).personalReferencesAvailable === false) throw new Error('快捷设置的临时参考已不可用，当前设置未被替换。');
      const policy = current.referencePolicy || moduleReferencePolicy({ ...module, images: current.images, referenceLimit: current.referenceLimit, referencePolicy: undefined });
      const quickPersonal = { prompt: current.personalOverrides ? current.personalOverrides.prompt ?? '' : prompt,
        model: current.model, quality: current.quality, resolution: current.resolution, count: current.count, aspectRatio: current.aspectRatio,
        ...current.personalOverrides };
      const restored = await restoreTemporaryDraft({ ...current,
        ...(sharedLive ? { ...quickPersonal, personalOverrides: quickPersonal } : {}),
        ...(sharedLive?.mode === 'publisher' ? { authorDefinition: { templatePrompt: current.prompt, context: current.context,
          templateReferenceIds: current.images.filter(image => !policy.primaryIds.includes(image.id || '')).map(image => image.id),
          fixedReferences: current.fixedReferences, styleGroupIds: current.styleGroupIds, skillIds: current.skillIds || [] } } : {}),
        images: (sharedLive ? current.personalImages || [] : current.images.filter(image => !policy.primaryIds.includes(image.id || ''))).map(image => ({ id: image.id })),
        referencePolicy: { ...policy, primaryIds: [] }, fixedReferences: current.fixedReferences, reproduceSourceTaskId: null }, false, true);
      if (restored) { setAppliedSource(null); setReproductionGlobalContext(null); setSaveStatus(`已套用：${current.name}`); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '快捷模板套用失败'); }
    finally { quickPresetLock.current = false; setQuickPresetApplying(null); setDraftRestoring(false); }
  }

  async function restoreTemporaryDraft(saved = recoverableDraft, automatic = false, preservePrimary = false) {
      const sequence = ++draftRestoreSequence.current;
      setDraftRestoring(true);
      if (saved) {
        const authorDraft = sharedLive?.mode === 'publisher' && definitionReady && saved.authorDefinition && typeof saved.authorDefinition === 'object' ? saved.authorDefinition : null;
        let restoredTemplateImages: UploadedAssetPayload[] | undefined;
        let restoredImages: UploadedAssetPayload[] = [];
        let restoredTask: StudioTask | undefined;
        let restoredStyles: StudioStyleSummary[] | undefined;
        let restoredSkills: SkillSummary[] | undefined;
        let restoredFixed: FixedStudioReference[] | undefined;
        let restoredFixedRepairs: SharedStudioFixedReferenceRepair[] | undefined;
        let recoveredFixedCount: number | undefined;
        let recoveredStyles: StudioStyleSummary[] | undefined;
        const validIds = (value: unknown): string[] => Array.isArray(value) ? value.flatMap((item: unknown) => {
          const id = typeof item === 'string' ? item : item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined;
          return typeof id === 'string' && id.length > 0 && id.length <= 100 ? [id] : [];
        }).slice(0, MAX_REFERENCE_IMAGES) : [];
        try {
          if (authorDraft?.fixedReferenceRepairs !== undefined) {
            if (!fixedRepairAllowed || !repairDefinition || !Array.isArray(authorDraft.fixedReferenceRepairs)
              || authorDraft.fixedReferenceRepairs.length > repairDefinition.fixedReferences.length
              || authorDraft.expectedIntent?.definitionToken !== repairDefinition.definitionToken) {
              throw new Error('固定参考修复草稿的来源已变化，原草稿保留，请先核对当前模板');
            }
            const seen = new Set<number>();
            restoredFixedRepairs = authorDraft.fixedReferenceRepairs.map((raw: unknown) => {
              if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('固定参考修复草稿无法读取');
              const item = raw as Record<string, unknown>;
              const sourceIndex = Number(item.sourceIndex);
              const source = repairDefinition.fixedReferences[sourceIndex];
              if (!Number.isInteger(item.sourceIndex) || !source?.repairable || seen.has(sourceIndex) || source.id !== item.originalAssetId
                || item.replacementAssetId !== null && (typeof item.replacementAssetId !== 'string' || !item.replacementAssetId || item.replacementAssetId.length > 100)) {
                throw new Error('固定参考修复草稿与原槽位不匹配，当前模板未被替换');
              }
              seen.add(sourceIndex);
              return { sourceIndex, originalAssetId: source.id, replacementAssetId: item.replacementAssetId as string | null };
            });
          }
          const ids = validIds(saved.images);
          const fixedInput = authorDraft?.fixedReferences ?? saved.fixedReferences;
          const fixedIds = (!sharedLive || authorDraft) && fixedEditable ? validIds(fixedInput) : [];
          const bannerId = typeof authorDraft?.bannerAssetId === 'string' ? authorDraft.bannerAssetId : null;
          const knownFixed = new Map((module.fixedReferences || []).map(image => [image.id, image]));
          const sourceIds = authorDraft && Array.isArray(authorDraft.templateReferenceIds) ? validIds(authorDraft.templateReferenceIds) : undefined;
          const knownSource = new Map((module.templateImages || []).map(image => [image.id, image]));
          const repairReplacementIds = (restoredFixedRepairs || []).flatMap(item => item.replacementAssetId ? [item.replacementAssetId] : []);
          const lookupIds = Array.from(new Set([...ids, ...repairReplacementIds, ...(sourceIds || []).filter(id => !knownSource.has(id)), ...fixedIds.filter(id => !knownFixed.has(id)), ...(bannerId && module.banner?.id !== bannerId ? [bannerId] : [])]));
          let available: UploadedAssetPayload[] = [];
          if (lookupIds.length) {
            const result = await readResponse(await fetch(`/api/assets/history?assetIds=${encodeURIComponent(lookupIds.join(','))}`, { cache: 'no-store' }));
            available = result.assets || [];
            restoredImages = ids.flatMap(id => available.filter(image => image.id === id));
            if (restoredImages.length !== ids.length) throw new Error('上次草稿中的部分图片已不可用，当前模板未被替换。');
          }
          if (repairReplacementIds.some(id => !available.some(asset => asset.id === id && asset.originalUrl))) throw new Error('修复草稿中的替换图片已不可用，原草稿保留');
          if (sourceIds) restoredTemplateImages = sourceIds.map(id => {
            const asset = knownSource.get(id) || available.find(image => image.id === id);
            if (!asset) throw new Error('模板编辑中的参考图已不可用，编辑草稿保留');
            return asset;
          });
          if ((!sharedLive || authorDraft) && fixedEditable && Array.isArray(fixedInput)) restoredFixed = fixedIds.map(id => {
            const asset = knownFixed.get(id) || available.find(image => image.id === id);
            if (!asset) throw new Error('草稿中的固定参考图已不可用，当前模板未被替换。');
            const original = fixedInput.find((item: { id?: string }) => item.id === id);
            return { ...asset, note: typeof original?.note === 'string' ? original.note.slice(0, 2000) : '', available: true };
          });
          const styleInput = authorDraft?.styleGroupIds ?? saved.styleGroupIds;
          if ((!sharedLive || authorDraft) && Array.isArray(styleInput)) {
            const styleIds = styleInput.filter((id: unknown): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)).slice(0, MAX_REFERENCE_IMAGES);
            const invalid = new Set(repairDefinition?.styleGroups.filter(item => item.status !== 'valid').map(item => item.id));
            const readableIds = styleIds.filter(id => !invalid.has(id));
            const exact: StudioStyleSummary[] = readableIds.length ? (await readResponse(await fetch(`/api/image-studio/style-groups?ids=${encodeURIComponent(readableIds.join(','))}`, { cache: 'no-store' }))).groups : [];
            restoredStyles = styleIds.map((id, index) => exact.find(item => item.id === id) || { id, name: `待处理风格 ${index + 1}`, coverUrl: null, canManage: false, referenceCount: 0, unavailable: true });
          }
          const skillInput = authorDraft?.skillIds ?? saved.skillIds;
          if ((!sharedLive || authorDraft) && Array.isArray(skillInput)) {
            const ids = skillInput.filter((id: unknown): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)).slice(0, 12);
            const invalid = new Set(repairDefinition?.skillGroups.filter(item => item.status !== 'valid').map(item => item.id));
            const readableIds = ids.filter((id: string) => !invalid.has(id));
            const exact: SkillSummary[] = readableIds.length ? (await readResponse(await fetch(`/api/image-studio/skills?ids=${encodeURIComponent(readableIds.join(','))}`, { cache: 'no-store' }))).skills : [];
            restoredSkills = ids.map((id: string) => exact.find(skill => skill.id === id) || { id, name: '提示词组不可用', unavailable: true });
          }
          if (authorDraft && bannerId) {
            const restored = module.banner?.id === bannerId ? module.banner : available.find(image => image.id === bannerId);
            if (!restored) throw new Error('模板编辑中的封面已不可用，编辑草稿保留');
            authorDraft.restoredBanner = restored;
          }
          if (!sharedLive && typeof saved.reproduceSourceTaskId === 'string') {
            if (saved.reproduceSourceTaskId.length > 120) throw new Error('历史任务编号无效，请恢复模板默认设置。');
            const history = await readResponse(await fetch(`/api/image-studio/tasks?moduleId=${encodeURIComponent(module.id)}&taskId=${encodeURIComponent(saved.reproduceSourceTaskId)}`, { cache: 'no-store' }));
            restoredTask = history.tasks?.find((task: StudioTask) => task.id === saved.reproduceSourceTaskId);
            if (!restoredTask?.snapshot?.sourceAvailable) throw new Error('这份草稿的历史来源已不可用，当前模板未被替换。');
            if (restoredTask.snapshot.contextAvailable === false) throw new Error('这条旧记录没有保存完整上下文，当前设置未被替换。');
            recoveredFixedCount = restoredTask.snapshot.fixedReferenceCount || 0;
            recoveredStyles = restoredTask.snapshot.styleGroups || [];
          }
        } catch (cause) {
          if (sequence === draftRestoreSequence.current) { blockedDraftSignature.current = generationDraft; setError(cause instanceof Error ? cause.message : '草稿参考图读取失败，请重试'); if (!preservePrimary) setRecoverableDraft(saved); setDraftRestoring(false); }
          return false;
        }
        if (sequence !== draftRestoreSequence.current) return false;
        const restoredOverrides = sharedLive ? storedPersonalOverrides(saved.personalOverrides && typeof saved.personalOverrides === 'object'
          ? saved.personalOverrides : saved) : null;
        const structuredPersonalDraft = Boolean(sharedLive && saved.personalOverrides && typeof saved.personalOverrides === 'object');
        const restores = (field: keyof PersonalStudioOverrides) => !sharedLive || !automatic && !structuredPersonalDraft || Object.prototype.hasOwnProperty.call(restoredOverrides, field);
        if (typeof saved.prompt === 'string' && restores('prompt')) setPrompt(saved.prompt.slice(0, 20000));
        if (evolution && saved.evolution && ['increase', 'decrease'].includes(saved.evolution.direction) && typeof saved.evolution.manual === 'boolean') setEvolutionInput({ direction: saved.evolution.direction, manual: saved.evolution.manual });
        if (saved.resultView === 'images' || saved.resultView === 'batch') setResultView(saved.resultView);
        if (Number.isInteger(saved.count) && saved.count >= 1 && saved.count <= 8 && restores('count')) setCount(saved.count);
        if (!sharedLive && Number.isInteger(saved.referenceLimit) && saved.referenceLimit >= 1 && saved.referenceLimit <= MAX_REFERENCE_IMAGES) setReferenceLimit(saved.referenceLimit);
        if (typeof saved.model === 'string' && models.includes(saved.model as typeof models[number]) && restores('model')) setModuleModel(saved.model);
        if (typeof saved.resolution === 'string' && restores('resolution')) setResolution(saved.model === 'gemini-nano-banana-2.1'
          ? saved.resolution as ImageResolution : normalizeImageResolution(typeof saved.model === 'string' ? saved.model : module.model, saved.resolution));
        if (typeof saved.quality === 'string' && restores('quality')) setQuality(saved.quality);
        if (typeof saved.aspectRatio === 'string' && restores('aspectRatio')) { try { setAspectRatio(normalizeStudioRatio(saved.aspectRatio)); } catch {} }
        const policy = saved.referencePolicy;
        const primaryIds = policy && Array.isArray(policy.primaryIds) ? validIds(policy.primaryIds) : restoredImages.flatMap(image => image.id ? [image.id] : []);
        if (!preservePrimary) setImages(restoredImages.filter(image => primaryIds.includes(image.id || '')));
        setAuxiliaryImages(restoredImages.filter(image => !primaryIds.includes(image.id || '') && (!preservePrimary || !images.some(primary => primary.id === image.id))));
        if ((!sharedLive || authorDraft) && policy && Number.isInteger(policy.primaryMax) && policy.primaryMax >= 1 && policy.primaryMax <= MAX_REFERENCE_IMAGES) {
          setReferenceLimit(policy.primaryMax);
          if (Number.isInteger(policy.primaryMin) && policy.primaryMin >= 0 && policy.primaryMin <= policy.primaryMax) setPrimaryMin(policy.primaryMin);
        }
        if ((!sharedLive || authorDraft) && policy && Number.isInteger(policy.auxiliaryMax) && policy.auxiliaryMax >= 0 && policy.auxiliaryMax <= MAX_REFERENCE_IMAGES) setAuxiliaryLimit(policy.auxiliaryMax);
        if ((!sharedLive || authorDraft) && policy && Number.isInteger(policy.styleMax) && policy.styleMax >= 0 && policy.styleMax <= MAX_REFERENCE_IMAGES) setStyleLimit(policy.styleMax);
        if ((!sharedLive || authorDraft) && policy && Number.isInteger(policy.referenceMax) && policy.referenceMax >= 0 && policy.referenceMax <= MAX_REFERENCE_IMAGES) setReferenceImageLimit(policy.referenceMax);
        if ((!sharedLive || authorDraft) && policy && typeof policy.useFixedReferences === 'boolean') setUseFixedReferences(policy.useFixedReferences);
        if (!sharedLive && contextEditable && typeof saved.context === 'string') setModuleContext(saved.context.slice(0, 20000));
        if (!sharedLive && restoredFixed) setFixedReferences(restoredFixed);
        if (!sharedLive && restoredStyles) setStyleGroups(restoredStyles);
        if (!sharedLive && restoredSkills) setSkills(restoredSkills);
        if (sharedLive && (automatic || structuredPersonalDraft) && restoredOverrides) { personalOverridesRef.current = restoredOverrides; setPersonalOverrides(restoredOverrides); }
        if (sharedLive && Array.isArray(saved.resetFields)) {
          resetFieldsRef.current = PERSONAL_OVERRIDE_FIELDS.filter(field => saved.resetFields.includes(field) && !Object.prototype.hasOwnProperty.call(personalOverridesRef.current, field));
          setResetFields(resetFieldsRef.current);
          if (sharedLive.available && hasSharedDefaults(sharedLive.defaults)) {
            const defaults = sharedLive.defaults;
            if (resetFieldsRef.current.includes('prompt')) setPromptValue('');
            if (resetFieldsRef.current.includes('model')) setModuleModelValue(defaults.model);
            if (resetFieldsRef.current.includes('quality')) setQualityValue(defaults.quality);
            if (resetFieldsRef.current.includes('resolution')) setResolutionValue(defaults.resolution);
            if (resetFieldsRef.current.includes('count')) setCountValue(defaults.count);
            if (resetFieldsRef.current.includes('aspectRatio')) setAspectRatioValue(defaults.aspectRatio);
          }
        }
        if (authorDraft && sharedLive && contextEditable) {
          if (restoredFixedRepairs) setFixedReferenceRepairs(restoredFixedRepairs);
          if (typeof authorDraft.templatePrompt === 'string') setTemplatePrompt(authorDraft.templatePrompt.slice(0, 20000));
          if (typeof authorDraft.context === 'string') setModuleContext(authorDraft.context.slice(0, 20000));
          if (typeof authorDraft.name === 'string' && authorDraft.name.trim()) setName(authorDraft.name.slice(0, 80));
          if (typeof authorDraft.groupName === 'string' && authorDraft.groupName.trim()) setGroupName(authorDraft.groupName.slice(0, 40));
          if (authorDraft.bannerAssetId === null) setBanner(null); else if (authorDraft.restoredBanner) setBanner(authorDraft.restoredBanner);
          if (restoredFixed) setFixedReferences(restoredFixed);
          if (restoredTemplateImages) setTemplateImages(restoredTemplateImages);
          if (restoredStyles) setStyleGroups(restoredStyles);
          if (restoredSkills) setSkills(restoredSkills);
          if (authorDraft.expectedIntent?.protocol === 'shared-live-v1' && authorDraft.expectedIntent?.presetId === sharedLive.intent.presetId
            && typeof authorDraft.expectedIntent.definitionToken === 'string') {
            definitionBaseline.current = { ...module, sharedLive: { ...sharedLive, intent: authorDraft.expectedIntent } };
            if (Number.isInteger(authorDraft.revision)) { revisionRef.current = authorDraft.revision; setModuleRevision(authorDraft.revision); }
            if (authorDraft.expectedIntent.definitionToken !== sharedLive.intent.definitionToken) { setDefinitionConflict(true); setModuleSaveError('模板已在另一处保存，当前编辑保留；请核对后再保存。'); }
          }
        }
        if (restoredTask) setReproductionSkills(restoredTask.snapshot?.skills || []);
        if (recoveredFixedCount !== undefined) setReproductionFixedCount(recoveredFixedCount);
        if (recoveredStyles) setReproductionStyles(recoveredStyles);
        if (sharedLive) { setReproduceSourceTaskId(null); setReproductionReferencePolicy(null); setReproductionGlobalContext(null); setReproductionReferences([]); setReproductionStyles([]); setReproductionSkills([]); setReproductionFixedCount(0); }
        else if (Object.prototype.hasOwnProperty.call(saved, 'reproduceSourceTaskId')) {
          setReproduceSourceTaskId(typeof saved.reproduceSourceTaskId === 'string' && saved.reproduceSourceTaskId.length <= 120 ? saved.reproduceSourceTaskId : null);
          setReproductionReferencePolicy(restoredTask?.snapshot?.referencePolicy || null);
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
    } catch { setDraftLoaded(true); /* A damaged local draft must not block the page. */ }
    try {
      const pending = JSON.parse(localStorage.getItem(pendingKey) ?? sessionStorage.getItem(pendingKey) ?? 'null');
      if (pending && typeof pending.requestId === 'string' && /^[a-zA-Z0-9-]{16,80}$/.test(pending.requestId)) {
        const identity = { requestId: pending.requestId };
        setPendingSubmission(identity);
        localStorage.setItem(pendingKey, JSON.stringify(identity)); sessionStorage.removeItem(pendingKey);
        setSubmissionRecoveryScope(pendingKey);
      } else if (pending === null) setSubmissionRecoveryScope(pendingKey);
    } catch { /* An unreadable request record is not proof that no submission is pending. */ }
  }, [draftKey, pendingKey, module.saved, module.revision, module.model, isAdmin]);
  useEffect(() => {
    if (moduleModel !== 'gemini-3.1-flash-image-preview' || !draftLoaded || draftRestoring
      || submissionRecoveryScope !== pendingKey || !batch.recoveryKnown || pendingSubmission || queryingSubmission
      || submitting || submitLock.current || batch.pending || batch.busy || batch.previewing
      || moduleSaving || moduleDeleting || moduleSaveRequest.current?.unknown || fixedSaveUnknown
      || presetSaving || quickPresetApplying || presetCreateRequest.current || sharingPending
      || uploading || bannerUploading || sessionChanged || isClientSessionBlocked()) return;
    // Only the next unsubmitted choice changes; frozen requests and restored parameters remain intact.
    setModuleModel(imageStudioModelForNewSelection(moduleModel));
  }, [moduleModel, draftLoaded, draftRestoring, submissionRecoveryScope, pendingKey, batch.recoveryKnown,
    pendingSubmission, queryingSubmission, submitting, batch.pending, batch.busy, batch.previewing, moduleSaving,
    moduleDeleting, fixedSaveUnknown, presetSaving, quickPresetApplying, sharingPending, uploading, bannerUploading, sessionChanged]);
  function temporaryDraftPayload(nextImages = images, nextAuxiliary = auxiliaryImages, nextPolicy = referencePolicy) {
    return { schemaVersion: sharedLive ? 3 : 2, ...(sharedLive ? { personalOverrides, resetFields } : {}),
      ...(authorDefinitionDirty ? { authorDefinition: { templatePrompt, context: moduleContext, name, groupName, bannerAssetId: banner?.id || null,
        templateReferenceIds: templateImageIds,
        fixedReferences: fixedEditable ? fixedReferences.map(image => ({ id: image.id, note: image.note })) : undefined,
        fixedReferenceRepairs: fixedRepairAllowed ? fixedReferenceRepairs : undefined,
        styleGroupIds: styleGroups.map(group => group.id), skillIds: skills.map(group => group.id),
        expectedIntent: definitionBaseline.current.sharedLive?.intent, revision: revisionRef.current } } : {}),
      resultView, evolution: evolution ? evolutionInput : undefined, prompt, count, referenceLimit, referencePolicy: nextPolicy, aspectRatio, resolution,
      images: [...nextImages, ...nextAuxiliary].map(image => ({ id: image.id })), context: !sharedLive && contextEditable ? moduleContext : undefined,
      fixedReferences: !sharedLive && fixedEditable ? fixedReferences.map(image => ({ id: image.id, note: image.note })) : undefined,
      skillIds: sharedLive ? undefined : skills.map(group => group.id), styleGroupIds: sharedLive ? undefined : styleGroups.map(group => group.id), model: moduleModel, quality, reproduceSourceTaskId: reproduceSourceTaskId || null, revision: moduleRevision };
  }
  useEffect(() => {
    if (!draftLoaded || draftRestoring || (recoverableDraft && blockedDraftSignature.current === generationDraft)) return;
    try { localStorage.setItem(draftKey, JSON.stringify(temporaryDraftPayload())); }
    catch { /* Ordinary browser drafts are best-effort and never block generation. */ }
  }, [draftLoaded, draftRestoring, recoverableDraft, draftKey, generationDraft, reproduceSourceTaskId, moduleRevision, contextEditable, fixedEditable, fixedRepairAllowed, fixedReferenceRepairs, resultView, authorDefinitionDirty, templatePrompt, templateImages, resetFields, name, groupName, banner]);

  useEffect(() => () => { draftRestoreSequence.current += 1; }, []);

  useEffect(() => {
    if (draftLoaded && !sharedLive) onMetadataChange(module.id, name, groupName);
  }, [draftLoaded, module.id, name, groupName, onMetadataChange]);

  const saveAutomatically = useRef(() => {});
  saveAutomatically.current = () => {
    if (sessionChanged || isClientSessionBlocked() || moduleDeleteLock.current) return;
    autoSaveAttempt.current = automaticSnapshot;
    void saveModule(reproduceSourceTaskId, revisionRef.current, false);
  };
  useEffect(() => {
    if (sessionChanged || isClientSessionBlocked() || sharedLive || !draftLoaded || !automaticDirty || moduleSaving || moduleDeleting || uploading || bannerUploading || submitting || pendingSubmission
      || presetSaving || quickPresetApplying || draftRestoring || !name.trim() || !Number.isInteger(count) || count < 1 || count > 8 || autoSaveAttempt.current === automaticSnapshot) return;
    const timer = window.setTimeout(() => saveAutomatically.current(), 500);
    return () => window.clearTimeout(timer);
  }, [sessionChanged, draftLoaded, automaticDirty, automaticSnapshot, moduleSaving, moduleDeleting, uploading, bannerUploading, submitting, pendingSubmission, presetSaving, quickPresetApplying, draftRestoring, name, count]);

  async function changeGroup(value: string) {
    const next = value !== '__other__' ? value : (await askName('输入新分组名称（最多 40 字）', '未命名分组', { title: '创建分组', confirmLabel: '创建分组', maxLength: 40 }))?.trim().slice(0, 40);
    if (next) { setGroupName(next); onMetadataChange(module.id, name, next, true); }
  }

  const loadTasks = useCallback(async (cursor?: string, action: 'initial' | 'refresh' | 'silent' | 'view' = 'refresh') => {
    if (isClientSessionBlocked()) return;
    const readPages = async (signal?: AbortSignal, entry = false) => {
      const count = cursor ? 1 : Math.min(20, loadedTaskPages.current);
      let next: string | undefined = cursor;
      let result: { tasks: StudioTask[]; nextCursor: string | null; total: number; entrySnapshot?: string } & Partial<StudioResultFeedExtras> | null = null;
      let entrySnapshot: string | undefined;
      const rows: StudioTask[] = [];
      const sharedPins: SharedStudioPinnedImage[] = [], resultOrder: string[] = [];
      for (let read = 0; read < count; read++) {
        const query = new URLSearchParams({ moduleId: module.id });
        if (templateWorkbench) query.set('feed', STUDIO_RESULT_FEED);
        if (next) query.set('cursor', next);
        if (entry && read === 0 && !cursor) query.set('attention', 'entry');
        const deadline = AbortSignal.timeout(20000);
        const page = await readResponse(await fetch(`/api/image-studio/tasks?${query}`, { cache: 'no-store', signal: signal ? AbortSignal.any([signal, deadline]) : deadline }));
        if (templateWorkbench && (page.protocol !== STUDIO_RESULT_FEED || page.viewerId !== userId || !Array.isArray(page.sharedPins) || !Array.isArray(page.resultOrder) || !page.pinState)) throw new Error('置顶目录协议尚未就绪，请刷新页面');
        rows.push(...page.tasks);
        sharedPins.push(...page.sharedPins || []); resultOrder.push(...page.resultOrder || []);
        entrySnapshot ||= page.entrySnapshot;
        result = { ...page, entrySnapshot };
        next = page.nextCursor || undefined;
        if (!next) break;
      }
      return { ...result!, sharedPins, resultOrder, tasks: Array.from(new Map(rows.map(task => [task.id, task])).values()) };
    };
    if (templateWorkbench) {
      const scope = `${userId}:${module.id}`;
      if (action === 'initial' && taskReadLoaded.current) action = 'silent';
      if (action !== 'view' && taskReadRequest.current?.scope === scope && (taskReadRequest.current.action !== 'silent' || action === 'silent')) return;
      taskReadRequest.current?.controller.abort();
      const request = { scope, controller: new AbortController(), action };
      const requestedToken = currentView.current.token;
      taskReadRequest.current = request;
      const currentRequest = () => !isClientSessionBlocked() && taskReadRequest.current === request && taskReadScopeRef.current === scope && !request.controller.signal.aborted;
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
        setResultFeed(previous => ({ protocol: STUDIO_RESULT_FEED, viewerId: userId, pinState: result.pinState!,
          sharedPins: Array.from(new Map([...(cursor ? previous?.sharedPins || [] : []), ...result.sharedPins].map(pin => [pin.id, pin])).values()),
          resultOrder: Array.from(new Set([...(cursor ? previous?.resultOrder || [] : []), ...result.resultOrder])) }));
        if (cursor) { loadedMore.current = true; loadedTaskPages.current++; }
        setTasksError('');
        void onResultsAvailable();
        if (!isClientSessionBlocked() && action === 'view' && !cursor && currentView.current.active && currentView.current.token === requestedToken && typeof result.entrySnapshot === 'string') {
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
    setTasks([]); setResultFeed(null); setSelected([]); setPreview(null); setNextCursor(null); setTaskTotal(null); loadedTaskPages.current = 1; setTasksError('');
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
    window.addEventListener('focus', refresh);
    window.addEventListener('sd2-studio-pins-changed', refresh);
    return () => { document.removeEventListener('visibilitychange', refresh); window.removeEventListener('focus', refresh); window.removeEventListener('sd2-studio-pins-changed', refresh); };
  }, [loadTasks, visible]);
  useEffect(() => () => { taskReadScopeRef.current = ''; }, []);

  async function querySubmission() {
    if (isClientSessionBlocked() || !pendingSubmission || submitLock.current || moduleDeleteLock.current) return;
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
    return { requestId, ...(sharedLive ? { sharedLive: sharedLive.intent, personalOverrides: personalOverridesRef.current } : {}), prompt: retryTask?.prompt ?? prompt,
      moduleId: module.id, model: retryTask?.model || moduleModel, quality: retryTask?.quality || quality, reproduceFromTaskId: !sharedLive ? reproduceSourceTaskId || undefined : undefined, count: retryTask ? 1 : count, aspectRatio: retryTask?.aspectRatio || aspectRatio, resolution: retryTask?.snapshot?.resolution || resolution, revision: settings!.revision, channelId: imageChannelId,
      referenceIds: retryTask?.referenceIds || generationReferenceIds,
      ...(historicalEvolution || evolution ? { evolution: historicalEvolution || evolutionInput } : {}),
      draft: { moduleContext: !sharedLive && !reproduceSourceTaskId && contextEditable ? effectiveGenerationDefinition.context || '' : undefined,
        globalContext: !sharedLive && !reproduceSourceTaskId && isAdmin ? effectiveGlobalContext : undefined,
        fixedReferences: !sharedLive && !reproduceSourceTaskId && fixedEditable ? fixedReferencePayload(effectiveGenerationDefinition.fixedReferences || []) : undefined,
        skillIds: sharedLive || reproduceSourceTaskId ? undefined : generationSkills.map(group => group.id),
        skillVersions: sharedLive || reproduceSourceTaskId ? undefined : Object.fromEntries(generationSkills.filter(group => group.promptVersion).map(group => [group.id, group.promptVersion!])),
        styleGroupIds: sharedLive || reproduceSourceTaskId ? undefined : generationStyles.map(group => group.id), referencePolicy: generationReferencePolicy } };
  }
  async function submit(retryTask?: StudioTask) {
    if (batch.mode === 'batch' && batch.pending && !retryTask) { await batch.query(); return; }
    if (pendingSubmission) { await querySubmission(); return; }
    if (sourceSharingBlocked) { setError('模板已不可用，不能新建任务；本人输入和历史保留。'); return; }
    if (isClientSessionBlocked() || !settings || submitLock.current || moduleDeleteLock.current || moduleSaveLock.current || globalSettingsSaving || uploadLock.current || uploading || bannerUploading || quickPresetLock.current || presetSaveLock.current || ratioEditing || draftRestoring) return;
    if (evolutionConflict) { setError(evolutionConflict); return; }
    if (batch.mode === 'batch' && !retryTask) {
      submitLock.current = true; setSubmitting(true);
      try { if (await batch.submit(generationPayload())) { onGenerationAccepted(); setResultView('images'); await loadTasks(undefined, 'silent'); } }
      finally { submitLock.current = false; setSubmitting(false); }
      return;
    }
    if (!pendingSubmission && (images.length < generationReferencePolicy.primaryMin || images.length > generationReferencePolicy.primaryMax
      || generationAuxiliaryCount > generationReferencePolicy.auxiliaryMax || generationStyleImageCount > (generationReferencePolicy.styleMax ?? MAX_REFERENCE_IMAGES)
      || generationOrdinaryReferenceCount > (generationReferencePolicy.referenceMax ?? MAX_REFERENCE_IMAGES) || generationReferenceCount > MAX_REFERENCE_IMAGES
      || generationFixedReferences.some(item => item.available === false) || generationStyles.some(group => group.unavailable) || generationSkills.some(group => group.unavailable))) {
      setError('请检查主图数量、辅助参考数量和图片可用性。'); return;
    }
    const currentPayload = generationPayload(retryTask);
    const requestLegacyRoute = imageStudioUsesLegacyRoute(imageChannels, currentPayload.model, imageChannelId);
    const requestChannelId = imageStudioEffectiveChannelId(imageChannels, currentPayload.model, imageChannelId);
    const expectedFormSignature = liveGenerationSignature.current;
    const signature = effectiveSignature(currentPayload, requestChannelId);
    const reusableQuote = billingQuote?.signature === signature
      && (!billingQuote.quote.expiresAt || Date.parse(billingQuote.quote.expiresAt) > Date.now()) ? billingQuote : null;
    const payload = reusableQuote ? generationPayload(retryTask, reusableQuote.requestId) : currentPayload;
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
        if (!requestLegacyRoute && (quote.imageChannel?.channelId !== requestChannelId
          || typeof quote.imageChannel.configRevision !== 'string' || !quote.imageChannel.configRevision)) {
          throw new Error('生图通道配置已变化，报价未能绑定到当前通道；尚未提交图片，请重新确认。');
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
      if (sharedLive && [401, 403, 404, 409].includes(Number((cause as { status?: number })?.status))) onSharedRefresh();
      submitLock.current = false; setSubmitting(false);
      return;
    }
    if (isClientSessionBlocked()) { submitLock.current = false; setSubmitting(false); return; }
    if (!confirmedQuote) { setError('本次报价未确认，尚未提交图片。'); submitLock.current = false; setSubmitting(false); return; }
    if (!requestLegacyRoute && (confirmedQuote.imageChannel?.channelId !== requestChannelId
      || typeof confirmedQuote.imageChannel.configRevision !== 'string' || !confirmedQuote.imageChannel.configRevision)) {
      setBillingQuote(null); setError('生图通道配置已变化，当前报价未用于生成；请重新获取报价。');
      submitLock.current = false; setSubmitting(false); return;
    }
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
      const submission = { ...payload, ...(confirmedQuote.imageChannel ? { imageChannel: confirmedQuote.imageChannel } : {}), ...(confirmedQuote.billingQuoteId ? { billingQuoteId: confirmedQuote.billingQuoteId } : {}), maxEstimatedCost: Math.ceil(confirmedQuote.estimatedCredits) };
      setBillingQuote(null);
      const response = await fetch('/api/image-studio/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(submission), signal: AbortSignal.timeout(20000) });
      if (response.status >= 400 && response.status < 500) { ambiguous = false; setPendingSubmission(null); try { localStorage.removeItem(pendingKey); sessionStorage.removeItem(pendingKey); } catch {} if (response.status === 409) { onReloadSettings(); if (sharedLive) onSharedRefresh(); } await readResponse(response); }
      else {
        const value = await readResponse(response);
        if (typeof value.batchId !== 'string' || !/^[a-f0-9]{64}$/.test(value.batchId)) throw new Error('提交结果待确认，请查询这次提交。');
        onGenerationAccepted();
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
    const sharedPersonalPrompt = (snapshot as StudioSnapshot & { personalPrompt?: string }).personalPrompt;
    if (!sharedLive) setPrompt(snapshot.prompt || '');
    else if (typeof sharedPersonalPrompt === 'string') setPrompt(sharedPersonalPrompt);
    const restoredEvolution = (snapshot as StudioSnapshot & { evolution?: EvolutionInput }).evolution;
    const nextEvolution = evolution ? restoredEvolution && ['increase', 'decrease'].includes(restoredEvolution.direction) ? { direction: restoredEvolution.direction, manual: restoredEvolution.manual === true } : { direction: evolution.defaultDirection, manual: false } : undefined;
    if (nextEvolution) setEvolutionInput(nextEvolution);
    setCount(nextCount); setAspectRatio(nextRatio); setResolution(nextResolution);
    const transient = snapshot.transientReferenceImages || snapshot.referenceImages;
    const primaryIds = snapshot.referencePolicy?.primaryIds || transient.flatMap(image => image.id ? [image.id] : []);
    const nextAuxiliary = transient.filter(image => image && !primaryIds.includes(image.id || '') && !images.some(primary => primary.id === image.id));
    setAuxiliaryImages(nextAuxiliary);
    if (sharedLive) {
      // A shared workspace always generates from its saved definition. Historical
      // task identity is not a draft-definition override or a permission grant.
      setModuleModel(nextModel); setQuality(nextQuality);
      setReproduceSourceTaskId(null); setReproductionReferencePolicy(null); setReproductionGlobalContext(null); setReproductionReferences([]);
      setReproductionStyles([]); setReproductionSkills([]); setReproductionFixedCount(0); setAppliedSource(null);
      if (contextEditable) {
        const historicalTemplatePrompt = (snapshot as StudioSnapshot & { templatePrompt?: string }).templatePrompt;
        if (typeof historicalTemplatePrompt === 'string') setTemplatePrompt(historicalTemplatePrompt);
        if (isAdmin && snapshot.contextAvailable) setModuleContext(snapshot.moduleContext ?? '');
        setStyleGroups(snapshot.styleGroups || []); setSkills(snapshot.skills || []);
        if (fixedEditable) setFixedReferences((snapshot.fixedReferenceImages || []).slice(0,
          Math.max(0, (snapshot.fixedReferenceCount ?? snapshot.fixedReferenceImages?.length ?? 0)
            - (snapshot.styleGroups || []).reduce((total, group) => total + group.referenceCount, 0))));
        if (snapshot.referencePolicy) {
          setReferenceLimit(snapshot.referencePolicy.primaryMax); setPrimaryMin(snapshot.referencePolicy.primaryMin);
          setAuxiliaryLimit(snapshot.referencePolicy.auxiliaryMax); setStyleLimit(snapshot.referencePolicy.styleMax ?? MAX_REFERENCE_IMAGES);
          setReferenceImageLimit(snapshot.referencePolicy.referenceMax ?? MAX_REFERENCE_IMAGES); setUseFixedReferences(snapshot.referencePolicy.useFixedReferences);
        }
      }
      setSaveStatus((contextEditable ? '已恢复本次参数与可编辑设置，主图保留'
        : '已恢复本次参数和临时参考，主图及共享模板内容保留')
        + (typeof sharedPersonalPrompt !== 'string' ? '；旧记录未单独保存个人描述，当前描述保留' : ''));
      return null;
    }
    setReferenceLimit(snapshot.referencePolicy?.primaryMax ?? Math.max(1, transient.length));
    setPrimaryMin(snapshot.referencePolicy?.primaryMin ?? 0); setAuxiliaryLimit(snapshot.referencePolicy?.auxiliaryMax ?? MAX_REFERENCE_IMAGES);
    setStyleLimit(snapshot.referencePolicy?.styleMax ?? MAX_REFERENCE_IMAGES); setReferenceImageLimit(snapshot.referencePolicy?.referenceMax ?? MAX_REFERENCE_IMAGES);
    setUseFixedReferences(snapshot.referencePolicy?.useFixedReferences ?? true);
    setReproductionReferences(snapshot.fixedReferenceImages || []);
    setReproductionFixedCount(snapshot.fixedReferenceCount ?? snapshot.fixedReferenceImages?.length ?? 0);
    setReproductionStyles(snapshot.styleGroups || []); setReproductionSkills(snapshot.skills || []);
    const nextStyles = snapshot.styleGroups || [], nextSkills = snapshot.skills || [];
    const nextFixed = fixedEditable ? (snapshot.fixedReferenceImages || []).slice(0,
      Math.max(0, (snapshot.fixedReferenceCount ?? snapshot.fixedReferenceImages?.length ?? 0)
        - nextStyles.reduce((total, group) => total + group.referenceCount, 0))) : fixedReferences;
    setStyleGroups(nextStyles); setSkills(nextSkills);
    if (fixedEditable) setFixedReferences(nextFixed);
    const nextContext = isAdmin && snapshot.contextAvailable ? snapshot.moduleContext ?? '' : moduleContext;
    const nextGlobalContext = isAdmin && snapshot.contextAvailable ? snapshot.globalContext ?? '' : settings?.context;
    if (isAdmin && snapshot.contextAvailable) setModuleContext(nextContext);
    setReproductionGlobalContext(isAdmin && snapshot.contextAvailable ? nextGlobalContext ?? '' : null);
    setReproductionContextConfigured(snapshot.contextConfigured === true);
    if (typeof snapshot.model === 'string' && snapshot.model) setModuleModel(snapshot.model);
    if (typeof snapshot.quality === 'string') setQuality(normalizeImageStudioQuality(snapshot.model || moduleModel, snapshot.quality));
    setReproduceSourceTaskId(snapshot.sourceAvailable ? task.id : null);
    // Bind to the expected post-restore inputs, not the render before the state batch applies.
    const nextPolicy: StudioReferencePolicy = { primaryIds: images.flatMap(image => image.id ? [image.id] : []),
      primaryMin: snapshot.referencePolicy?.primaryMin ?? 0, primaryMax: snapshot.referencePolicy?.primaryMax ?? Math.max(1, transient.length),
      auxiliaryMax: snapshot.referencePolicy?.auxiliaryMax ?? MAX_REFERENCE_IMAGES, styleMax: snapshot.referencePolicy?.styleMax ?? MAX_REFERENCE_IMAGES,
      referenceMax: snapshot.referencePolicy?.referenceMax ?? MAX_REFERENCE_IMAGES, useFixedReferences: snapshot.referencePolicy?.useFixedReferences ?? true };
    setReproductionReferencePolicy(snapshot.sourceAvailable ? nextPolicy : null);
    const nextImages = [...images, ...nextAuxiliary];
    const signature = JSON.stringify({ inputs: { ...generationInputs, evolution: nextEvolution, prompt: snapshot.prompt || '', count: nextCount, referenceLimit: nextPolicy.primaryMax,
      aspectRatio: nextRatio, resolution: nextResolution, referenceIds: nextImages.map(image => image.id), model: nextModel, quality: nextQuality, referencePolicy: nextPolicy, context: nextContext,
      fixedReferences: fixedReferencePayload(nextFixed), skillIds: nextSkills.map(group => group.id),
      skillVersions: Object.fromEntries(nextSkills.filter(group => group.promptVersion).map(group => [group.id, group.promptVersion!])), styleGroupIds: nextStyles.map(group => group.id) },
      source: snapshot.sourceAvailable ? task.id : null, references: snapshot.fixedReferenceImages || [],
      fixedCount: snapshot.fixedReferenceCount ?? snapshot.fixedReferenceImages?.length ?? 0, styles: snapshot.styleGroups || [], skills: snapshot.skills || [], globalContext: nextGlobalContext });
    setAppliedSource({ taskId: task.id, label: `${module.name} · ${task.ordinal}`, signature, modified: false });
    setSaveStatus('已恢复设置，当前主图保持不变');
    return null;
  }

  async function readResultInputMain(taskId: string): Promise<ResultInputMain> {
    const result = await readResponse(await fetch(`/api/image-studio/tasks/${encodeURIComponent(taskId)}/input-main`,
      { cache: 'no-store', signal: AbortSignal.timeout(15000) }));
    if (result.taskId !== taskId || !['ready', 'none', 'unknown', 'unavailable'].includes(result.state)
      || !Array.isArray(result.images) || typeof result.snapshotToken !== 'string') throw new Error('这次生成的输入来源未能确认，当前主图保留');
    if (result.state !== 'ready') throw new Error(result.state === 'none' ? '这次生成没有输入主图，当前主图保留'
      : result.state === 'unavailable' ? '这次生成的输入主图已不可用或无权读取，当前主图保留'
        : '旧记录未明确保存输入主图角色，不能猜测或改用生成图；当前主图保留');
    if (!result.images.length || result.images.length > MAX_REFERENCE_IMAGES || result.images.some((image: UploadedAssetPayload) => !image?.id || !image.originalUrl)
      || new Set(result.images.map((image: UploadedAssetPayload) => image.id)).size !== result.images.length) throw new Error('输入主图记录不完整，当前主图保留');
    return result as ResultInputMain;
  }
  async function verifyAndApplyInputMain(inputs: UploadedAssetPayload[], current: () => boolean) {
    if (!inputs.length || inputs.length > currentReferenceCap) throw new Error(`当前最多可取回 ${currentReferenceCap} 张主图，请调整选择或参考数量；当前主图保留`);
    await Promise.all(inputs.map(async asset => {
      const response = await fetch(`/api/content-reactions/media?key=${encodeURIComponent(`asset:${asset.id!}`)}&variant=original`,
        { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw new Error('输入主图原件读取失败，当前主图保留');
    }));
    if (!current()) return false;
    const selected = new Set(inputs.map(asset => asset.id));
    setImages(inputs); setAuxiliaryImages(previous => previous.filter(image => !selected.has(image.id)));
    setSaveStatus(`已取回这次生成的 ${inputs.length} 张输入主图，未生成图片`);
    return true;
  }
  async function replaceMainFromResult(taskId: string | undefined) {
    if (!taskId || !active || !draftLoaded || draftRestoring || submitting || pendingSubmission
      || uploadLock.current || quickPresetLock.current || presetSaveLock.current || moduleSaving || moduleDeleting
      || uploading || bannerUploading || ratioEditing) return;
    if (currentReferenceCap < 1) { setError('辅助参考已占满可用数量，请先减少参考图，当前主图未替换。'); return; }
    const expectedScope = taskReadScope, expectedView = currentView.current.token;
    const signature = liveGenerationSignature.current, sequence = ++inputMainSequence.current;
    const current = () => taskReadScopeRef.current === expectedScope && currentView.current.active
      && currentView.current.token === expectedView && liveGenerationSignature.current === signature && inputMainSequence.current === sequence;
    uploadLock.current = true; setUploading(true); setError(''); setInputMainError(''); setSaveStatus('正在核对这次生成的输入主图');
    try {
      const result = await readResultInputMain(taskId);
      if (!current()) return;
      if (result.images.length > 1) {
        setInputMainChoice({ ...result, scope: expectedScope, viewToken: expectedView, generationSignature: signature, sequence, selectedIds: [] });
        setSaveStatus('这次生成用了多张主图，请选择要取回的输入图片');
      } else await verifyAndApplyInputMain(result.images, current);
    } catch (cause) {
      if (current()) { setError(cause instanceof Error ? cause.message : '输入主图未取回，当前主图保留。'); setSaveStatus(''); }
    } finally {
      uploadLock.current = false;
      if (taskReadScopeRef.current === expectedScope) { setUploading(false); if (!current()) setSaveStatus(''); }
    }
  }
  async function applyInputMainChoice() {
    const choice = inputMainChoice;
    if (!choice || inputMainBusy || uploadLock.current || !choice.selectedIds.length || submitting || pendingSubmission) return;
    const current = () => inputMainSequence.current === choice.sequence && taskReadScopeRef.current === choice.scope
      && currentView.current.active && currentView.current.token === choice.viewToken && liveGenerationSignature.current === choice.generationSignature;
    if (!current()) { setInputMainError('当前页面或输入已变化，请关闭后重新双击；当前主图保留'); return; }
    uploadLock.current = true; setInputMainBusy(true); setUploading(true); setInputMainError('');
    try {
      const fresh = await readResultInputMain(choice.taskId);
      if (fresh.snapshotToken !== choice.snapshotToken || fresh.images.map(image => image.id).join(',') !== choice.images.map(image => image.id).join(',')) throw new Error('这次生成的输入来源已变化，请关闭后重新读取；当前主图保留');
      if (!current()) return;
      const selected = fresh.images.filter(image => choice.selectedIds.includes(image.id!));
      if (selected.length !== choice.selectedIds.length) throw new Error('所选输入未能确认，当前主图保留');
      if (await verifyAndApplyInputMain(selected, current)) setInputMainChoice(null);
    } catch (cause) { if (current()) setInputMainError(cause instanceof Error ? cause.message : '输入主图未取回，当前选择保留'); }
    finally { uploadLock.current = false; if (taskReadScopeRef.current === choice.scope) { setInputMainBusy(false); setUploading(false); } }
  }

  function exitReproductionMode(message = '已退出历史复现模式，接下来使用已保存的模板内容。') {
    setReproduceSourceTaskId(null);
    setReproductionReferencePolicy(null);
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
  function requestResultDelete(task: StudioTask, trigger?: HTMLElement) {
    if (templateWorkbench) {
      const card = Array.from(section.current?.querySelectorAll<HTMLElement>('[data-result-id]') || [])
        .find(element => element.dataset.resultId === task.id);
      deleteAnchor.current = trigger || card || null;
      // Menu items unmount on selection; restore focus to their actual result cover.
      (trigger || card?.querySelector<HTMLElement>('[data-result-cover], [data-result-choice]'))?.focus({ preventScroll: true });
    }
    setDeleteError(''); setDeleteTarget(task);
  }
  function canDeleteResult(item: GeneratedImageResult & { task?: StudioTask }) {
    return Boolean(item.task && !item.viewOnly && !item.media?.previewOnly
      && (!item.task.owner || item.task.owner.id === userId));
  }
  async function restoreResultSettings(task: StudioTask) {
    const reason = restoreTask(task); if (reason) setError(reason);
  }
  const estimateSignature = effectiveGenerationSignature;
  useEffect(() => {
    if (sessionChanged || isClientSessionBlocked() || sourceSharingBlocked || !actualQuoteRequired || !estimateSignature || hidden || !active || !quoteVisible || !draftLoaded || draftRestoring
      || submitting || pendingSubmission || batch.mode !== 'single'
      || !Number.isInteger(count) || count < 1 || count > 8) return;
    if (billingQuote?.signature === estimateSignature && billingQuote.quote.expiresAt
      && Date.parse(billingQuote.quote.expiresAt) > Date.now()) return;
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      if (isClientSessionBlocked()) return;
      const requestId = crypto.randomUUID();
      const payload = { ...JSON.parse(estimateSignature)[1], requestId };
      void fetch('/api/image-studio/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]) })
        .then(readResponse).then((quote: StudioImageQuote) => {
          if (isClientSessionBlocked() || abort.signal.aborted || liveGenerationSignature.current !== estimateSignature) return;
          if (!Number.isFinite(quote.estimatedCredits) || quote.estimatedCredits < 0 || !quote.expiresAt
            || Date.parse(quote.expiresAt) <= Date.now() || quote.billingMode === 'actual' && !quote.billingQuoteId) return;
          setBillingQuote({ signature: estimateSignature, requestId, quote });
        }).catch(cause => { if (!abort.signal.aborted && sharedLive && [401, 403, 404, 409].includes(Number(cause?.status))) onSharedRefresh(); });
    }, 500);
    return () => { window.clearTimeout(timer); abort.abort(); };
  }, [sessionChanged, sourceSharingBlocked, actualQuoteRequired, estimateSignature, hidden, active, quoteVisible, draftLoaded, draftRestoring, submitting, pendingSubmission, batch.mode, count, billingQuote, onSharedRefresh]);
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
  const selectedProviderReady = imageStudioChannelReadyForModel(selectedChannel, moduleModel, settings?.modelReady?.[moduleModel] ?? settings?.providerReady);
  const channelIssue = !imageChannelReady ? '正在读取生图通道，请稍候。' : imageStudioChannelIssue(selectedChannel, moduleModel, {
    legacyReady: settings?.modelReady?.[moduleModel] ?? settings?.providerReady,
    legacyRoute: legacyImageRoute,
    quality: generationInputs.quality, resolution: generationInputs.resolution,
    ratio: aspectRatio, referenceCount: generationReferenceCount,
  });
  const hasContext = reproduceSourceTaskId ? reproductionContextConfigured : Boolean((isAdmin ? effectiveGlobalContext?.trim() : settings?.contextConfigured)
    || effectiveGenerationDefinition.contextConfigured || effectiveGenerationDefinition.context?.trim()
    || effectiveGenerationDefinition.templatePrompt?.trim() || generationSkills.length);
  const ready = Boolean(selectedProviderReady && (actualQuoteRequired || moduleUnitCredits !== null) && settings && !settingsError);
  const generationFeedback: StudioFeedback | null = batch.mode === 'batch' && batch.pending ? batch.busy ? { message: '正在核对原批次，不会重新提交生成', tone: 'progress' } : null
    : evolutionConflict ? { message: evolutionConflict, tone: 'warning' }
    : batch.mode === 'batch' && batch.blocker ? { message: batch.blocker, tone: 'info' }
    : queryingSubmission ? { message: '正在查询这次提交，不会再次生成。', tone: 'progress' }
    : pendingSubmission ? submitting ? { message: '正在处理当前请求，请稍候再查询。', tone: 'progress' }
      : moduleDeleting ? { message: '正在删除模板，请等待操作结束后再查询。', tone: 'progress' } : null
    : sourceSharingBlocked ? { message: '该模板暂不可用，请刷新模板或换一个可用模板。', tone: 'info' }
    : submitting ? { message: '正在提交，请等待结果，不要重复点击。', tone: 'progress' }
    : moduleSaving || globalSettingsSaving ? { message: '正在保存设置，请等待操作结束。', tone: 'progress' }
    : quickPresetApplying || presetSaving ? { message: quickPresetApplying ? '正在套用快捷模板。' : '正在保存快捷模板。', tone: 'progress' }
    : uploading || bannerUploading ? { message: '图片还在上传或处理，请等待图片显示后再生成。', tone: 'progress' }
    : draftRestoring ? { message: '正在恢复上次使用的图片和设置。', tone: 'progress' }
    : ratioEditing ? { message: '图片比例尚未确认，请先完成比例设置。', tone: 'info' }
    : settingsError ? { message: `设置暂不可用：${settingsError}`, tone: 'info' }
    : !settings ? { message: '正在读取生成设置，请稍候；长时间无变化请刷新页面。', tone: 'progress' }
    : channelIssue ? { message: channelIssue, tone: imageChannelMessage ? 'info' : 'warning' }
    : !selectedProviderReady ? { message: '当前模型的图片服务尚未就绪，请换一个模型或联系管理员检查接口。', tone: 'warning' }
    : !actualQuoteRequired && moduleUnitCredits === null ? { message: '当前模型尚未设置点数，请换一个模型或联系管理员配置。', tone: 'warning' }
    : generationFixedReferences.some(item => item.available === false) ? { message: '已保存模板的固定参考图不可用，请在设置中处理。', tone: 'info' }
    : generationStyles.some(group => group.unavailable) ? { message: '已保存模板的风格组不可用，请在设置中处理。', tone: 'info' }
    : generationSkills.some(group => group.unavailable) ? { message: '已保存模板的提示词组不可用，请在设置中处理。', tone: 'info' }
    : batch.mode === 'batch' && batch.source === 'folder' && generationReferencePolicy.primaryMin > 1 ? { message: `这个模板至少需要 ${generationReferencePolicy.primaryMin} 张主图，素材逐图每项只有 1 张；请选择当前正文模式。`, tone: 'warning' }
    : images.length < generationReferencePolicy.primaryMin && !(batch.mode === 'batch' && batch.source === 'folder') ? { message: `这个模板至少需要 ${generationReferencePolicy.primaryMin} 张主图，当前 ${images.length} 张。`, tone: 'warning' }
    : images.length > generationReferencePolicy.primaryMax ? { message: `主图最多 ${generationReferencePolicy.primaryMax} 张，请移除多余主图。`, tone: 'warning' }
    : generationStyleImageCount > (generationReferencePolicy.styleMax ?? MAX_REFERENCE_IMAGES) ? { message: `风格组最多传入 ${generationReferencePolicy.styleMax ?? MAX_REFERENCE_IMAGES} 张图片，当前 ${generationStyleImageCount} 张。`, tone: 'warning' }
    : generationOrdinaryReferenceCount > (generationReferencePolicy.referenceMax ?? MAX_REFERENCE_IMAGES) ? { message: `参考图最多 ${generationReferencePolicy.referenceMax ?? MAX_REFERENCE_IMAGES} 张，当前 ${generationOrdinaryReferenceCount} 张（含启用的模板固定图）。`, tone: 'warning' }
    : generationAuxiliaryCount > generationReferencePolicy.auxiliaryMax ? { message: `辅助参考最多 ${generationReferencePolicy.auxiliaryMax} 张，当前 ${generationAuxiliaryCount} 张（包含模板图和风格组）。`, tone: 'warning' }
    : generationReferenceCount > MAX_REFERENCE_IMAGES ? { message: `当前通道最多传入 ${MAX_REFERENCE_IMAGES} 张图片，已选主图 ${images.length} 张、辅助参考 ${generationAuxiliaryCount} 张，请减少辅助参考。`, tone: 'warning' }
    : !prompt.trim() && !generationReferenceCount && !hasContext && !(batch.mode === 'batch' && batch.source === 'folder') ? { message: '请填写画面要求，或添加主图。', tone: 'info' }
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
  const visibleFeed = likedResults.liked ? likedResults.feed : resultFeed;
  type StudioResultItem = GeneratedImageResult & { task?: StudioTask; sharedPin?: SharedStudioPinnedImage };
  const ownResults: StudioResultItem[] = resultTasks.map(task => {
    const image = studioTaskHasDeliveredAsset(task) ? studioTaskPreviewState(task) : null;
    const pending = ['queued', 'running'].includes(task.status);
    return {
      id: task.id, task, label: `生成结果 ${task.ordinal}`, status: studioTaskPhase(task), billing: task.billing,
      pending,
      generationWait: { taskKey: task.id, acceptedAt: task.delivery?.acceptedAt, createdAt: task.createdAt,
        status: task.status, phase: task.delivery?.phase, waitingStatus: task.delivery?.waitingStatus, label: studioTaskPhase(task),
        resultReady: Boolean(image), progress: Number(task.delivery?.expectedBytes) > 0 && task.delivery?.receivedBytes != null
          ? task.delivery.receivedBytes / task.delivery.expectedBytes! * 100 : undefined,
        connectionIssue: Boolean(resultError), connectionDetail: resultError, detail: task.error,
        generationDetailSuperseded: task.delivery?.generationDetailSuperseded, recoveryAvailable: task.delivery?.recoveryAvailable },
      waitingThumbnail: task.snapshot?.primaryReferenceImages?.[0]?.thumbnailUrl || task.snapshot?.primaryReferenceImages?.[0]?.originalUrl || undefined,
      applied: sourceApplied && appliedSource?.taskId === task.id,
      error: task.error,
      onViewed: () => observeResultVersion(studioResultVersion(task)),
      download: image ? () => { setSelected([task.id]); setDownloadMode(true); } : undefined,
      downloadDisabled: downloadBusy,
      downloadTemporarilyBusy: downloadBusy,
      downloadMessage: '已选择这张图片，请确认下载',
      media: image ? {
        src: image.src, sourceRole: image.sourceRole, thumbnailSrc: image.thumbnailSrc, alt: image.alt, title: image.title,
        contentKey: image.contentKey, fileName: image.fileName, previewKey: task.id,
        // Unread observation IDs are not image-file versions. The reader validates
        // the original response's real version and keeps its cache permission checks.
        safeDetails: { ...image.metadata, width: image.width, height: image.height, fileSize: image.fileSize },
        comparison: image.comparison,
        comparisonCandidates: [...taskComparisonCandidates(task), ...previewableTasks.filter(other => other.batchId === task.batchId).map(other => ({ src: other.asset!.original_url, role: 'generated' as const, thumbnailSrc: other.asset!.thumbnail_url, alt: `生成结果 ${other.ordinal}`, contentKey: `asset:${other.asset!.id}` as const }))],
        onImageLoaded: (src: string) => { if (src === image.src) observeResultVersion(image.resultVersion || null); },
      } : undefined,
    } satisfies GeneratedImageResult & { task: StudioTask };
  });
  const pinnedResults: StudioResultItem[] = (templateWorkbench ? visibleFeed?.sharedPins || [] : []).map(pin => ({
    id: pin.id, sharedPin: pin, label: '模板置顶图片', status: '已置顶', viewOnly: true,
    media: { src: pin.previewUrl, thumbnailSrc: pin.thumbnailUrl, alt: '模板置顶图片', title: '模板置顶图片',
      contentKey: `asset:${pin.assetId}`, imageSharing: false, previewOnly: true, previewKey: pin.id,
      safeDetails: { width: pin.width || undefined, height: pin.height || undefined, time: pin.createdAt } },
  }));
  const resultById = new Map([...ownResults, ...pinnedResults].map(item => [item.id, item]));
  const sharedResults = templateWorkbench && visibleFeed
    ? visibleFeed.resultOrder.flatMap(id => resultById.has(id) ? [resultById.get(id)!] : [])
    : ownResults;

  function changeFixedReferences(next: FixedStudioReference[]) {
    if (!fixedEditable) return;
    setFixedReferences(next); setModuleSaveError('');
  }
  function changeFixedRepair(sourceIndex: number, replacementAssetId: string | null | undefined) {
    const source = repairDefinition?.fixedReferences[sourceIndex];
    if (!fixedRepairAllowed || !source?.repairable || moduleSaving || uploading || submitting || pendingSubmission) return;
    setFixedReferenceRepairs(current => [...current.filter(item => item.sourceIndex !== sourceIndex),
      ...(replacementAssetId === undefined ? [] : [{ sourceIndex, originalAssetId: source.id, replacementAssetId }])]);
    setModuleSaveError('');
  }
  function openFixedRepair(sourceIndex: number) {
    const source = repairDefinition?.fixedReferences[sourceIndex];
    if (!fixedRepairAllowed || !source?.repairable || !repairDefinition) return;
    setFixedRepairTarget({ sourceIndex, originalAssetId: source.id, definitionToken: repairDefinition.definitionToken });
    setImageSourceTarget('fixed-repair'); setAssetPickerOpen(true);
  }
  function clearAllReferences() {
    if (uploading || submitting || pendingSubmission) return;
    setAuxiliaryImages([]);
    if (!sharedLive) { setStyleGroups([]); setUseFixedReferences(false); }
    setRecoverableDraft(null);
    setError('本次临时参考已清空，主图和已保存模板参考保留。');
  }
  function changeImageRole(image: UploadedAssetPayload, index: number, toPrimary: boolean) {
    if (toPrimary) {
      if (images.length >= generationReferencePolicy.primaryMax) { setError('主图已达到数量上限。'); return; }
      setAuxiliaryImages(current => current.filter((_, position) => position !== index));
      setImages(current => [...current, image]);
    } else {
      if (auxiliaryImages.length >= currentAuxiliaryCap) { setError('参考图已达到数量上限。'); return; }
      setImages(current => current.filter((_, position) => position !== index));
      setAuxiliaryImages(current => [...current, image]);
    }
  }
  function previewReference(asset: UploadedAssetPayload, number: number, sharedReference = false) {
    if (!asset.originalUrl) return;
    sharedReferencePreviewId.current = sharedReference ? asset.id || null : null;
    if (moduleDialog.current?.open) { resumeModulePreview.current = true; moduleDialog.current.close(); }
    const source = asset.originalUrl.startsWith('/api/') || !asset.id ? asset.originalUrl : `/api/content-reactions/media?key=${encodeURIComponent(`asset:${asset.id}`)}&variant=preview`;
    setPreview({ contentKey: asset.id ? `asset:${asset.id}` : undefined, src: source, thumbnailSrc: asset.thumbnailUrl || undefined, alt: `参考图 ${number}`, fileName: asset.fileName, width: asset.width || undefined, height: asset.height || undefined, fileSize: asset.fileSize });
  }
  const uploadTargets = useRef({ images, auxiliaryImages, fixedReferences, banner });
  uploadTargets.current = { images, auxiliaryImages, fixedReferences, banner };
  const addImages = useCallback(async (files: File[], fixed = false, auxiliary = false) => {
    if (uploadLock.current || submitting || pendingSubmission || !files.length) return;
    if (fixed && !fixedEditable) return;
    if (files.some(file => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024)) {
      setError('请使用 20MB 以内的 PNG、JPG 或 WebP 图片'); return;
    }
    const expectedScope = taskReadScope, expectedView = currentView.current.token, signature = liveGenerationSignature.current;
    const targetSignature = JSON.stringify(uploadTargets.current);
    const current = () => taskReadScopeRef.current === expectedScope && currentView.current.active && currentView.current.token === expectedView
      && liveGenerationSignature.current === signature && JSON.stringify(uploadTargets.current) === targetSignature;
    uploadLock.current = true; setUploading(true); setError('');
    const completed: UploadedAssetPayload[] = [];
    const cap = fixed ? MAX_REFERENCE_IMAGES : auxiliary ? currentAuxiliaryCap : currentReferenceCap;
    const initial = fixed ? fixedReferences : auxiliary ? auxiliaryImages : images;
    const replacing = !fixed && !auxiliary && generationReferencePolicy.primaryMax === 1 && initial.length > 0;
    let skipAfterSuccess = false, duplicates = 0, uploadError = '', applySelection = true;
    try {
      const unique = await uniqueUploadFiles(files);
      if (!current()) return;
      const uploadFiles = unique.files; duplicates = unique.duplicates;
      const singleMain = !fixed && !auxiliary && generationReferencePolicy.primaryMax === 1;
      if (singleMain && uploadFiles.length > 1) throw new Error('主图上限为 1 张，请一次只选择一张不同的图片。');
      const uploadBatch = createUploadBatch(userId);
      for (let index = 0; index < uploadFiles.length; index++) {
        if (!current()) return;
        const file = uploadFiles[index];
        const asset = await uploadFileAsAsset(file, { ownerId: userId, batch: uploadBatch, onProgress: progress => {
          if (current()) setUploadProgress(studioUploadProgress(file, index, uploadFiles.length, progress));
        } });
        if (!current()) return;
        if (!asset.id || !asset.originalUrl) throw new Error('上传结果不完整，请重试');
        if (!completed.some(item => item.id === asset.id)) completed.push(asset);
      }
      if (replacing && completed[0]?.id !== initial[0]?.id && !skipMainImageReminder(userId)) {
        applySelection = await confirm(`确认用「${uploadFiles[0].name}」替换当前主图？取消会保留原主图，已上传图片仍可从素材库选用。`, { title: '替换主图', confirmLabel: '替换主图', checkbox: { label: '以后替换主图不再提醒', onConfirm: checked => { skipAfterSuccess = checked; } } });
      }
    } catch (e) { uploadError = e instanceof Error ? e.message : '上传失败'; }
    finally {
      if (current() && applySelection) {
        const additions = completed.filter(asset => !initial.some(item => item.id === asset.id));
        const nextCount = replacing && completed.length ? 1 : initial.length + additions.length;
        if (additions.length && nextCount > cap) {
          uploadError = `${fixed ? `固定参考图最多 ${MAX_REFERENCE_IMAGES} 张` : auxiliary ? `本次可选辅助参考最多 ${cap} 张，模板和风格组已占 ${generationFixedCount} 张` : `本次可选主图最多 ${cap} 张`}。原选择未变，已上传图片保留在素材库。`;
        } else if (completed.length) {
          if (fixed && additions.length) setFixedReferences([...fixedReferences, ...additions.map(asset => ({ ...asset, note: '', available: true }))]);
          else if (auxiliary && additions.length) setAuxiliaryImages([...auxiliaryImages, ...additions]);
          else if (!fixed && !auxiliary && (replacing || additions.length)) setImages(replacing ? [completed[0]] : [...images, ...additions]);
          if (replacing && skipAfterSuccess) saveMainImageReminder(userId, true);
          setUploadSummaryTarget(fixed ? 'fixed' : auxiliary ? 'auxiliary' : 'primary'); setUploadedSummary(completed);
          if (duplicates || !additions.length) setSaveStatus('相同文件已复用，当前参考区不会重复加入。');
        }
        if (uploadError) setError(uploadError);
      }
      uploadLock.current = false;
      if (taskReadScopeRef.current === expectedScope) { setUploading(false); setUploadProgress(null); }
    }
  }, [userId, taskReadScope, confirm, images, auxiliaryImages, currentReferenceCap, currentAuxiliaryCap, fixedReferences, generationFixedCount, submitting, pendingSubmission, fixedEditable, generationReferencePolicy.primaryMax]);

  async function chooseSimilarExisting(candidate: UploadedAssetPayload, uploaded: UploadedAssetPayload) {
    if (!candidate.id || !uploaded.id || !active || uploadLock.current || uploading || bannerUploading || submitting || pendingSubmission
      || moduleSaving || moduleDeleting || draftRestoring || presetSaving || quickPresetApplying) throw new Error('当前操作尚未结束，请稍后重新选择');
    const target = uploadSummaryTarget;
    if (target === 'fixed' && !fixedEditable || target === 'template' && !definitionReady) throw new Error('当前模板内容不可修改，两张图片仍保留');
    const currentImages = target === 'banner' ? banner ? [banner] : [] : target === 'fixed' ? fixedReferences
      : target === 'template' ? templateImages : target === 'auxiliary' ? auxiliaryImages : images;
    if (!currentImages.some(image => image.id === uploaded.id)) throw new Error('本次上传的用途已变化，请从素材库重新选择；两张图片仍保留');
    if (target !== 'banner' && [...images, ...auxiliaryImages, ...fixedReferences, ...templateImages].some(image => image.id === candidate.id)) {
      throw new Error('已有图片已在当前主图或参考区，无需重复加入；两张图片仍保留');
    }
    const expectedScope = taskReadScope, expectedView = currentView.current.token, signature = liveGenerationSignature.current;
    const current = () => taskReadScopeRef.current === expectedScope && currentView.current.active && currentView.current.token === expectedView
      && liveGenerationSignature.current === signature;
    uploadLock.current = true; setUploading(true);
    try {
      const response = await fetch(`/api/content-reactions/media?key=${encodeURIComponent(`asset:${candidate.id}`)}&variant=original`,
        { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw new Error('已有图片的原件暂不可用，当前选择保持不变');
      if (!current()) throw new Error('页面内容已变化，未覆盖当前选择；两张图片仍保留');
      if (target === 'banner') setBanner(candidate);
      else if (target === 'fixed') changeFixedReferences(fixedReferences.map(image => image.id === uploaded.id ? { ...candidate, note: image.note, available: true } : image));
      else if (target === 'template') setTemplateImages(templateImages.map(image => image.id === uploaded.id ? candidate : image));
      else if (target === 'auxiliary') setAuxiliaryImages(auxiliaryImages.map(image => image.id === uploaded.id ? candidate : image));
      else setImages(images.map(image => image.id === uploaded.id ? candidate : image));
      setSaveStatus(target === 'fixed' || target === 'template' || target === 'banner' ? '已选用已有图片，模板内容仍需保存；两张原件保留' : '下次生成将使用已有图片；两张原件及已提交任务保留');
    } finally {
      uploadLock.current = false;
      if (taskReadScopeRef.current === expectedScope) setUploading(false);
    }
  }

  async function uploadBanner(file: File) {
    if (bannerUploading || submitting || pendingSubmission) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024) {
      setError('banner 请使用 20MB 以内的 PNG、JPG 或 WebP 图片'); return;
    }
    const expectedScope = taskReadScope, expectedView = currentView.current.token, signature = liveGenerationSignature.current;
    const targetSignature = JSON.stringify(uploadTargets.current);
    const current = () => taskReadScopeRef.current === expectedScope && currentView.current.active && currentView.current.token === expectedView
      && liveGenerationSignature.current === signature && JSON.stringify(uploadTargets.current) === targetSignature;
    setBannerUploading(true); setError('');
    try {
      const asset = await uploadFileAsAsset(file, { ownerId: userId, onProgress: progress => { if (current()) setBannerProgress(studioUploadProgress(file, 0, 1, progress)); } });
      if (!current()) return;
      if (!asset.id || !asset.originalUrl) throw new Error('banner 上传结果不完整，请重试');
      setBanner(asset);
      setUploadSummaryTarget('banner'); setUploadedSummary([asset]);
    } catch (e) { if (current()) setError(e instanceof Error ? e.message : 'banner 上传失败'); }
    finally { if (taskReadScopeRef.current === expectedScope) { setBannerUploading(false); setBannerProgress(null); } }
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
      <TemplateFavoriteTitle className={styles.moduleTitleRow} contentKey={sharedLive?.available ? `image_template:${sharedLive.intent.presetId}` : module.saved && !sharedLive ? `image_module:${module.id}` : undefined}>
        {!definitionReady ? <strong className={styles.moduleNameDisplay}>{name}</strong> : nameEditing ? <input ref={nameInput} className={styles.moduleName} aria-label="模块名称" value={name} maxLength={80} onChange={event => setName(event.target.value)} onBlur={() => setNameEditing(false)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); setNameEditing(false); } }} /> : <button type="button" className={styles.moduleNameDisplay} title={name} aria-label={`编辑模块标题：${name}`} onClick={() => setNameEditing(true)}>{name}</button>}
        {sharedLive && (!sharedLive.available || module.sourcePresetShared === true) && <small className={styles.sharedOrigin}>{sharedLive.available ? '共享模板' : '历史保留'}</small>}
      </TemplateFavoriteTitle>
      <div className={styles.counts}>
        {(module.sourcePresetCanManageSharing && module.sourcePresetId || module.canChooseSharing) && <span className={styles.moduleSharingChoice}>
          <label className={`toggle-switch ${styles.moduleShareSwitch}`} title={unpublishedSharing ? '保存模板后共享给同事' : '共享给同事'}>
            <input type="checkbox" role="switch" aria-label="共享给同事" checked={module.sourcePresetShared === true || unpublishedSharing}
              disabled={sharingPending || !draftLoaded || draftRestoring || moduleSaving || sharingPreferenceSaving || Boolean(module.sourcePresetId && sharingId === module.sourcePresetId) || uploading || bannerUploading || submitting || Boolean(pendingSubmission)} onChange={event => void changeModuleSharing(event.currentTarget)} />
            <span className="toggle-slider" />
          </label>
          <span>{sharingPreferenceSaving ? '保存中' : unpublishedSharing ? '默认共享，保存后生效' : module.sourcePresetShared === true ? '共享给同事' : '仅自己可见'}</span>
        </span>}
        {sharingPending && <button type="button" disabled={Boolean(sharingId)} onClick={() => void onQuerySharing()}>查询共享结果</button>}
        {module.sourcePresetId && (module.sourcePresetOwnedByViewer || sharedLive?.mode === 'publisher') && <button type="button" onClick={event => onLifecycleHistory(event.currentTarget)}>变更记录</button>}
        <ModuleGroupPicker value={groupName} groups={groups} protectedGroups={protectedGroups} disabled={!definitionReady || !draftLoaded || draftRestoring || moduleSaving || !sharedLive && automaticDirty || moduleDeleting || submitting || uploading || Boolean(pendingSubmission)} deleting={groupDeleting}
          onChange={value => void changeGroup(value)} onDelete={onDeleteGroup} />
        {(moduleSaving || moduleSaveError) && <span role="status" className={styles.muted}>{moduleSaving ? '保存中' : '保存失败'}</span>}
        <span className={styles.contextEntry}><button type="button" disabled={!draftLoaded || draftRestoring} onClick={openModuleDialog}><Settings size={17} />模块上下文</button></span>
        {(module.coverEditable || !module.saved && !sharedLive) && <button type="button" disabled={!draftLoaded || draftRestoring || moduleSaving || moduleDeleting || bannerUploading} onClick={() => void (async () => {
          if (!module.saved && !await saveModule(reproduceSourceTaskId, revisionRef.current, false)) return;
          setCoverEditorOpen(true);
        })()}><ImagePlus size={17} />设置封面</button>}
        <button type="button" className={templateWorkbench ? styles.moduleDeleteIcon : undefined} title={module.id === `default-${userId}` ? (templateWorkbench ? '默认模块需要保留' : '默认模板需要保留') : (templateWorkbench ? '删除模块' : '删除模板')} aria-label={moduleDeleting ? '正在删除模块' : `删除${templateWorkbench ? '模块' : '模板'}：${name}`} aria-busy={moduleDeleting || undefined}
          disabled={module.id === `default-${userId}` || moduleDeleting || moduleSaving || submitting || uploading || bannerUploading || Boolean(pendingSubmission)}
          onClick={event => void deleteModule(event.currentTarget)}>{moduleDeleting ? <LoaderCircle size={17} className={styles.spinner} /> : <Trash2 size={17} />}{!templateWorkbench && (moduleDeleting ? '删除中' : '删除模板')}</button>
      </div>
    </header>
    <div className={`${styles.moduleBanner} ${banner?.originalUrl ? styles.moduleBannerHasImage : ''}`}>
      {banner?.originalUrl ? <>
        {/* 固定 banner 高度并完整等比显示图片，不裁切。 */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img decoding="async" className={styles.moduleBannerImage} src={banner.thumbnailUrl || undefined} alt={templateWorkbench ? '模块横幅' : '模块横幅'} />
        <span className={styles.bannerLabel}>{templateWorkbench ? '模块横幅' : '模块横幅'}</span>
        {definitionReady && <><button type="button" className={styles.bannerReplace} disabled={bannerUploading || submitting} onClick={() => openImageSource('banner')}>{bannerUploading ? '上传中' : '更换图片'}</button>
        <button type="button" className={styles.bannerRemove} disabled={bannerUploading || submitting} onClick={() => setBanner(null)} aria-label={templateWorkbench ? '移除模块横幅' : '移除模块横幅'}><X size={16} /></button></>}
      </> : definitionReady ? <button type="button" className={styles.bannerEmpty} disabled={bannerUploading || submitting} onClick={() => openImageSource('banner')}><ImagePlus size={20} />{bannerUploading ? '上传中' : templateWorkbench ? '添加模块横幅' : '添加模块横幅'}</button> : <span className={styles.bannerEmpty}>暂无横幅</span>}
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
            <select aria-label="主图数量上限" value={referenceLimit} disabled={!definitionReady || uploading || submitting || Boolean(pendingSubmission)} onChange={event => {
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
              <button type="button" className={styles.materialAdd} disabled={uploading || submitting || Boolean(pendingSubmission) || images.length >= currentReferenceCap && generationReferencePolicy.primaryMax !== 1 || currentReferenceCap === 0}
                title={generationReferencePolicy.primaryMax === 1 && images.length ? '替换主图' : images.length >= currentReferenceCap ? '已达到可用图片数量上限' : '添加主图'} onClick={() => openImageSource('reference')}><Plus size={24} /><span>{uploading ? '上传中' : currentReferenceCap === 0 ? '主图未启用' : generationReferencePolicy.primaryMax === 1 && images.length ? '替换主图' : images.length >= currentReferenceCap ? '主图已满' : '添加主图'}</span></button>
            </StudioReferenceGrid>
          </div>
        </section>
        <section className={`${styles.materialSection} ${styles.styleMaterials}`} aria-label="风格与提示词">
          {!templateWorkbench && <header className={styles.materialHeading}><h3>风格组</h3>
            <select aria-label="风格图片数量上限" value={styleLimit} disabled={uploading || submitting || Boolean(pendingSubmission)} onChange={event => setStyleLimit(Number(event.target.value))}>
              {Array.from({ length: MAX_REFERENCE_IMAGES + 1 }, (_, value) => <option key={value} value={value}>最多 {value} 张</option>)}
            </select><span title={`已选 ${activeStyles.length} 组风格，共 ${styleImageCount} 张图片`}><b>{activeStyles.length}组</b> · <b>{styleImageCount}张</b></span>
          </header>}
          <StudioStyleSkillSelector ref={styleSkillSelector} userId={userId} scope={module.id}
            selectedStyles={activeStyles} selectedSkills={skills}
            currentImages={auxiliaryImages} maxReferences={currentStyleCap}
            disabled={!definitionReady || uploading || submitting || Boolean(pendingSubmission)}
            onStylesChange={setStyleGroups}
            onSkillsChange={setSkills} />
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
              {templateImages.map((image, index) => <div className={styles.styleTile} key={`shared-${image.id}-${index}`}>
                <button type="button" className={styles.styleTilePreview} disabled={!image.originalUrl} onClick={() => previewReference(image, index + 1, true)} aria-label={`预览共享参考图${index + 1}`}>
                  <ImagePlus size={24} />{image.thumbnailUrl && <img src={image.thumbnailUrl} alt={`共享参考图${index + 1}`} />}
                  <span className={styles.styleTileName}>共享参考{index + 1}</span>
                </button>
              </div>)}
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
          {(fixedReferences.length > 0 || Boolean(module.fixedReferenceCount) || reproductionFixedCount > styleImageCount) && <label className={styles.referenceToggle}><input type="checkbox" checked={useFixedReferences} disabled={!definitionReady || uploading || submitting || Boolean(pendingSubmission)} onChange={event => setUseFixedReferences(event.target.checked)} />使用模板固定参考图</label>}
          <input ref={auxiliaryFileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={event => { void addImages(Array.from(event.target.files || []), false, true); event.target.value = ''; }} />
        </section>
        {auxiliaryCount > 0 && <div className={styles.materialFooter}>
          <button type="button" title="清空本次风格组和参考图，保留主图与文字" disabled={uploading || submitting || Boolean(pendingSubmission) || !auxiliaryCount} onClick={clearAllReferences}><X size={14} />清空参考</button>
        </div>}
        </div>
        {uploadProgress && <UploadProgressIndicator busy {...uploadProgress} />}
        {!!uploadedSummary.length && <UploadSimilarityReview ownerId={userId} assets={uploadedSummary}
          chooseExistingTarget={asset => {
            if (uploadSummaryTarget === 'banner') return '当前封面';
            const list = uploadSummaryTarget === 'fixed' ? fixedReferences : uploadSummaryTarget === 'template' ? templateImages : uploadSummaryTarget === 'auxiliary' ? auxiliaryImages : images;
            const index = list.findIndex(image => image.id === asset.id);
            const kind = uploadSummaryTarget === 'fixed' ? '固定参考图' : uploadSummaryTarget === 'template' ? '共享参考图' : uploadSummaryTarget === 'auxiliary' ? '辅助参考图' : '主图';
            return index < 0 ? `${kind}（原选择已变化）` : `${kind} ${index + 1}`;
          }}
          onChooseExisting={chooseSimilarExisting} onDismiss={() => setUploadedSummary([])} />}
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
              : !legacyImageRoute && !selectedChannelModel?.billingMode ? '费用未配置' : '费用待估算'}
          </p>}
          {generationFeedback && <p id={`generation-blocker-${module.id}`} role="status" className={styles.generationFeedback} data-tone={generationFeedback.tone}>{generationFeedback.message}</p>}
          {settingsError && <button type="button" onClick={() => onReloadSettings(true)}><RefreshCw size={16} />重新读取设置</button>}
          {sourceSharingBlocked && <TaskNotice kind="recoverable">{sharedLive?.unavailableReason || '模板已不可用，不能新建任务；本人输入、已提交任务和历史结果仍保留。'} <button type="button" onClick={() => { setResultView('images'); document.getElementById(`studio-results-${module.id}`)?.scrollIntoView({ block: 'start' }); }}>查看本人历史</button>{definitionReady && repairDefinition && <button type="button" onClick={openModuleDialog}>修复模板</button>}</TaskNotice>}
          {sharingPending && <p role="status" className={styles.muted}>{sharingMessage || '共享结果待确认，只查询原请求，不会重新提交。'}</p>}
          {pendingSubmission && <p className={styles.muted}>提交结果待确认，只查询原请求，不会再次生成。<button type="button" disabled={submitting} onClick={async () => {
            if ((await confirm('上次提交可能已受理。放弃核对后，再次生成会新建任务，可能再次产生上游费用。确定放弃核对吗？', { title: '放弃核对', confirmLabel: '放弃核对' }))) { setPendingSubmission(null); try { localStorage.removeItem(pendingKey); sessionStorage.removeItem(pendingKey); } catch {} }
          }}>放弃核对</button></p>}
          {!ready && !settingsError && !channelIssue && <p className={styles.muted}>{!selectedProviderReady ? '图片服务尚未就绪' : '请管理员完成模型积分设置'}</p>}
        </div>
        {evolution && <div className={styles.counts} role="group" aria-label="演化方向">{(['increase', 'decrease'] as const).map(direction => <button type="button" key={direction} aria-pressed={(evolutionInput.manual ? evolutionInput.direction : bodyDirection || evolution.defaultDirection) === direction} disabled={submitting || Boolean(pendingSubmission) || Boolean(batch.pending)} onClick={() => setEvolutionInput({ direction, manual: true })}>{direction === 'increase' ? '递进' : '递减'}</button>)}{evolutionInput.manual && <button type="button" title="按正文和模板默认方向" onClick={() => setEvolutionInput({ direction: evolution.defaultDirection, manual: false })}><RotateCcw size={14} /></button>}</div>}
        <label className={styles.label} htmlFor={`studio-prompt-${module.id}`}>{evolution ? '演化内容' : '补充'} {!evolution && <span>有图片时选填</span>}</label>
        <textarea id={`studio-prompt-${module.id}`} disabled={submitting || Boolean(pendingSubmission) || Boolean(batch.pending)} value={prompt} maxLength={20000} onChange={event => setPrompt(event.target.value)} placeholder={evolution ? '什么发生变化' : '补充想生成的画面'} rows={9} />
        {evolutionConflict && <TaskNotice kind="recoverable">{evolutionConflict}</TaskNotice>}
        <RatioPicker value={aspectRatio} onChange={setAspectRatio} reference={generationReferences.find(image => Number(image.width) > 0 && Number(image.height) > 0) || null} model={moduleModel} resolution={resolution} onEditing={setRatioEditing} disabled={submitting || Boolean(pendingSubmission)} {...ratios} />
        <div className={`${styles.modelQualityRow} ${templateWorkbench ? styles.templateModelQualityRow : ''}`}>
          <label className={styles.compactField} htmlFor={`studio-model-${module.id}`}><strong>生成模型</strong>
            <select id={`studio-model-${module.id}`} title={templateWorkbench ? `${IMAGE_STUDIO_MODEL_LABELS[moduleModel as keyof typeof IMAGE_STUDIO_MODEL_LABELS] || moduleModel}${imageChannelReady && !imageStudioChannelReadyForModel(selectedChannel, moduleModel, settings?.modelReady?.[moduleModel] ?? settings?.providerReady) ? '（未就绪）' : ''}` : undefined} disabled={!draftLoaded || draftRestoring || submissionRecoveryScope !== pendingKey || !batch.recoveryKnown || submitting || Boolean(pendingSubmission) || Boolean(batch.pending)} value={moduleModel} onChange={event => selectModuleModel(event.target.value)}>
              {modelChoices.map(model => <option key={model} value={model} disabled={model === 'gemini-3.1-flash-image-preview'}>{IMAGE_STUDIO_MODEL_LABELS[model as keyof typeof IMAGE_STUDIO_MODEL_LABELS] || model}{imageChannelReady && !imageStudioChannelReadyForModel(selectedChannel, model, settings?.modelReady?.[model] ?? settings?.providerReady) ? '（未就绪）' : ''}</option>)}
            </select>
          </label>
          {!templateWorkbench && <label className={styles.compactField} htmlFor={`studio-channel-${module.id}`}><strong>供应商</strong>
            <ImageGenerationChannelSelect id={`studio-channel-${module.id}`} channels={imageChannels} value={imageChannelId} disabled={submitting || Boolean(pendingSubmission) || Boolean(batch.pending)} onChange={onImageChannelChange} model={moduleModel} legacyReady={settings?.modelReady?.[moduleModel] ?? settings?.providerReady} />
          </label>}
          <label className={styles.compactField} htmlFor={`studio-quality-${module.id}`}><strong>图片质量</strong>
            <select id={`studio-quality-${module.id}`} title={templateWorkbench ? `${IMAGE_STUDIO_QUALITY_LABELS[quality as keyof typeof IMAGE_STUDIO_QUALITY_LABELS] || quality}${!qualitySupportUnconfirmed && !qualityChoices.includes(quality) ? qualityChoices.length ? '（当前供应商不支持）' : '（支持范围待确认）' : ''}` : undefined} disabled={submitting || Boolean(pendingSubmission)} value={quality} onChange={event => setQuality(event.target.value)}>
              {!qualityChoices.includes(quality) && <option value={quality} disabled={!qualitySupportUnconfirmed}>{IMAGE_STUDIO_QUALITY_LABELS[quality as keyof typeof IMAGE_STUDIO_QUALITY_LABELS] || quality}{!qualitySupportUnconfirmed ? qualityChoices.length ? '（当前供应商不支持）' : '（支持范围待确认）' : ''}</option>}
              {qualityChoices.map(option => <option key={option} value={option}>{IMAGE_STUDIO_QUALITY_LABELS[option as keyof typeof IMAGE_STUDIO_QUALITY_LABELS] || option}</option>)}
            </select>
          </label>
          <label className={styles.compactField} htmlFor={`studio-resolution-${module.id}`}><strong>分辨率</strong>
            <select id={`studio-resolution-${module.id}`} title={templateWorkbench ? `${resolution}${!resolutionSupportUnconfirmed && !resolutionChoices.includes(resolution) ? resolutionChoices.length ? '（当前供应商不支持）' : '（支持范围待确认）' : ''}` : undefined} disabled={submitting || Boolean(pendingSubmission)} value={resolution} onChange={event => setResolution(event.target.value as ImageResolution)}>
              {!resolutionChoices.includes(resolution) && <option value={resolution} disabled={!resolutionSupportUnconfirmed}>{resolution}{!resolutionSupportUnconfirmed ? resolutionChoices.length ? '（当前供应商不支持）' : '（支持范围待确认）' : ''}</option>}
              {resolutionChoices.map(option => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
        </div>
        {!allowsUnconfirmedParameters && qualityChoices.length > 0 && !qualityChoices.some(option => option !== 'auto') && <p className={styles.muted}>当前供应商只配置了模型默认质量。</p>}
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
          <button type="button" className={`${styles.primary} sd2-loading-surface`} data-busy={moduleSaving} title={definitionSaveReason || undefined} disabled={definitionSaveBlocked || !sharedReady && !definitionReady || moduleSaving || sharingPreferenceSaving || presetSaving || Boolean(quickPresetApplying) || uploading || bannerUploading || !settingsDirty && !unpublishedSharing} onClick={() => void saveModule()}><Save size={16} />{sharedLive ? definitionEditable ? '保存共享模板' : '保存本次设置' : unpublishedSharing ? '保存并共享模板' : templateWorkbench ? '保存设置' : '保存上下文'}</button>
          <button type="button" title={!contextEditable && !recoverableDraft ? '共享模板的内部配置只能由创建者另存；当前草稿仍可生成' : undefined} disabled={presetSaving || Boolean(quickPresetApplying) || draftRestoring || moduleSaving || uploading || bannerUploading || submitting || Boolean(pendingSubmission) || (!recoverableDraft && (!contextEditable || !generationChanged && !authorDefinitionDirty || !authorDefinitionDirty && generationDraft === savedAsSignature))} className={recoverableDraft || (contextEditable && (generationChanged || authorDefinitionDirty) && generationDraft !== savedAsSignature) ? styles.saveReady : ''} onClick={() => recoverableDraft ? restoreTemporaryDraft() : void saveAsPreset()}><Save size={16} />{recoverableDraft ? '恢复上一次' : templateWorkbench ? '另存为模板' : '另存为'}</button>
        </div>
        {quickPresetsLoading && <p role="status" className={styles.muted}>正在读取快捷模板…</p>}
        {quickPresetsError && <p role="alert" className={styles.error}>{quickPresetsError}<button type="button" disabled={quickPresetsLoading} onClick={() => void loadQuickPresets()}>重试</button></p>}
        {saveStatus && <p role="status" className={styles.muted}>{saveStatus}</p>}
        {definitionSaveReason && <p role="status" className={styles.muted}>{definitionSaveReason}</p>}
        {fixedSaveUnknown && <p role="status" className={styles.muted}><button type="button" disabled={checkingFixedSave || moduleSaving || sessionChanged}
          onClick={() => void queryFixedReferenceSave()}>{checkingFixedSave ? '正在核对原保存' : '核对原保存'}</button></p>}
        {error && <TaskNotice kind="recoverable">{error}</TaskNotice>}
      </section>
      <section id={`studio-results-${module.id}`} className={styles.outputs} aria-label="生成结果">
        <header className={`${styles.header}${templateWorkbench ? ` ${styles.resultHeader}` : ''}`}><h2>生成结果{templateWorkbench && resultView === 'images' && <ResultImageContextMenuHint />}</h2>
          {templateWorkbench && resultView === 'images' && <div className={styles.resultPaginationSlot} ref={setResultPaginationSlot} />}
          <div className={styles.counts}>
          {templateWorkbench && <button type="button" title={likedResults.liked ? '返回当前模板全部结果' : '只看当前模板中我喜欢的结果'} aria-label={likedResults.liked ? '返回当前模板全部结果' : '只看当前模板中我喜欢的结果'} aria-pressed={likedResults.liked} onClick={() => chooseResultFilter(!likedResults.liked)}><Heart size={16} fill={likedResults.liked ? 'currentColor' : 'none'} />喜欢</button>}
          <button type="button" aria-pressed={resultView === 'images' && !likedResults.liked} onClick={() => chooseResultFilter(false)}>图片</button><button type="button" aria-pressed={resultView === 'batch'} onClick={() => { likedResults.choose(false); setResultView('batch'); }}>批次</button>
          {!downloadMode ? <button type="button" disabled={downloadBusy} onClick={() => { setSelected([]); setDownloadMode(true); }}><Download size={16} />下载</button> : <div className={styles.downloadModeBar}><span>已选 {selected.length} 张</span><button type="button" disabled={!selected.length || downloadBusy} onClick={() => void download(selected)}>{downloadBusy ? '准备中' : '确认下载'}</button><button type="button" disabled={downloadBusy} onClick={() => { setSelected([]); setDownloadMode(false); }}>取消</button></div>}
          <button type="button" title="刷新记录" aria-label="刷新记录" className={templateWorkbench ? 'sd2-loading-surface' : undefined} data-busy={likedResults.liked ? likedResults.loading : templateWorkbench && taskReadAction === 'refresh'} disabled={resultBusy} onClick={refreshResults}><RefreshCw size={16} /></button>
        </div></header>
        {batch.id && resultView === 'images' && <BatchResults key={`${userId}:${batch.id}:delivery`} id={batch.id} userId={userId} deliveryOnly autoPack={batch.pack} onSourceChanged={onSharedRefresh} />}
        {!likedResults.liked && batch.busy && batch.localPreviews.length > 0 && <div className={styles.grid} aria-label="本批准备素材">{batch.localPreviews.map((src, index) => <article key={src} className={styles.result}><div className={styles.batchInputPreview}><img src={src} alt={`本批主图 ${index + 1}`} /></div><p role="status">准备中</p></article>)}</div>}
        {resultView === 'batch' ? batch.id ? <BatchResults key={`${userId}:${batch.id}`} id={batch.id} userId={userId} autoPack={batch.pack} visible={visible && active && !hidden} onSourceChanged={onSharedRefresh} onQuickUse={taskId => void replaceMainFromResult(taskId)} /> : <p>暂无选中批次，可开始批量生成或从<a href="/assets">资产库的“我的批次”</a>找回。</p> : <>
        {downloadReady && <p role="status">已交给浏览器下载。<a href={downloadReady.url} download={downloadReady.name}>再次下载</a></p>}
        <GeneratedImageResults key={likedResults.liked ? 'liked' : 'all'} items={sharedResults}
          contextActionsEnabled={templateWorkbench}
          contextActions={item => {
            const task = item.task;
            if (!task || !canDeleteResult(item)) return [];
            const actions: ResultImageContextMenuItem[] = [];
            if (studioTaskHasDeliveredAsset(task)) actions.push({ id: 'restore', label: '恢复这张图的设置', group: 'continue', icon: <RotateCcw size={15} />,
              disabled: Boolean(restoreDisabledReason(task)), description: restoreDisabledReason(task) || '保留当前主图，不生成图片',
              transferFocus: true, onSelect: () => void restoreResultSettings(task) });
            if (isAdmin && task.snapshot?.sourceAvailable) actions.push({ id: 'context', label: '复制文字上下文', group: 'manage', icon: <ClipboardList size={15} />,
              disabled: copyFeedback?.id === task.id && copyFeedback.text === '复制中…',
              description: copyFeedback?.id === task.id && copyFeedback.text === '复制中…' ? '正在复制，请稍后' : undefined,
              onSelect: () => void copyTaskContext(task) });
            actions.push({ id: 'delete', label: '删除生成记录', group: 'danger', icon: <Trash2 size={15} />, disabled: deleting || downloadBusy,
              description: deleting ? '正在删除，请稍后' : downloadBusy ? '正在准备下载，请稍后' : undefined,
              transferFocus: true, onSelect: () => requestResultDelete(task) });
            return actions;
          }}
          onQuickUse={item => { if (item.task) void replaceMainFromResult(item.task.id); }}
          renderReactionAction={templateWorkbench ? item => item.task?.asset?.id
            ? <StudioResultPinButton userId={userId} moduleId={module.id} taskId={item.task.id} assetId={item.task.asset.id} state={visibleFeed?.pinState || null} onSaved={refreshResults} />
            : item.sharedPin ? <StudioResultPinnedIndicator /> : null : undefined}
          paginationSlot={templateWorkbench ? resultPaginationSlot : undefined}
          scope={`sd2-image-studio-${likedResults.liked ? 'liked-' : ''}result-page:${taskReadScope}`}
          visible={visible && active && !hidden && resultView === 'images'} loading={resultLoading} busy={resultBusy}
          error={resultError} emptyLabel={likedResults.liked ? '当前模板还没有喜欢的结果' : '暂无生成记录'}
          hasMore={Boolean(resultCursor)} total={likedResults.liked ? likedResults.total : taskTotal} loadMore={readNextResultPage}
          onRetry={() => { if (likedResults.liked) likedResults.refresh(); else void loadTasks(taskRetryCursor); }}
          selectedId={selectedResultId} onSelect={item => setSelectedResultId(item.id)}
          previewId={preview?.taskId || null} onPreviewChange={item => {
            if (item?.task) setPreview(studioTaskPreviewState(item.task));
            else if (item?.sharedPin && item.media) setPreview({ taskId: item.id, src: item.media.src, thumbnailSrc: item.media.thumbnailSrc, alt: item.label });
            else { setPreview(null); if (resumeModulePreview.current) { resumeModulePreview.current = false; moduleDialog.current?.showModal(); } }
          }}
          renderOverlay={({task}) => task ? <>
            {downloadMode && studioTaskHasDeliveredAsset(task) && <input className={styles.select} data-result-secondary type="checkbox" aria-label={`选择第 ${task.ordinal} 张图片`} checked={selected.includes(task.id)} onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onChange={event => {
              if (event.target.checked && selected.length >= 8) { setError('每次最多下载 8 张'); return; }
              setSelected(current => event.target.checked ? [...current, task.id] : current.filter(id => id !== task.id));
            }} />}
          </> : null}
          coverDeleteWithContextActions={templateWorkbench}
          renderDelete={item => item.task && canDeleteResult(item) ? <button type="button" disabled={deleting || downloadBusy} title="删除生成记录" aria-label={`删除第 ${item.task.ordinal} 张生成记录`} onClick={event => { event.stopPropagation(); requestResultDelete(item.task!, event.currentTarget); }}><Trash2 size={17} /></button> : null}
          renderMetadata={({task, sharedPin}) => task ? <>          <div className={styles.resultHeading}>
            <p className={styles.prompt} title={templateWorkbench ? name : `${name} · ${task.ordinal}`}>{templateWorkbench ? name : `${name} · ${task.ordinal}`}</p>
            {templateWorkbench && task.asset?.id && visibleFeed?.pinState.assetIds.includes(task.asset.id) && <span className={styles.muted}>已置顶</span>}
            <span className={styles.resultOwner} aria-label="生成者"><UserIdentityBadge user={task.owner} size="sm" className="asset-card-user" /></span>
          </div>
          <div className={styles.resultMeta}>
            <div className={styles.resultConfig}>
            <span title={IMAGE_STUDIO_MODEL_LABELS[task.model as keyof typeof IMAGE_STUDIO_MODEL_LABELS] || task.model}>{studioModelShortLabel(task.model)}</span>
            {!templateWorkbench && <>
              {(() => { const source = [task.snapshot?.imageSupplierName, task.snapshot?.imageChannelLabel].filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).join(' · '); return source ? <><span>·</span><span title="生成时供应商">{source}</span></> : null; })()}
              <span>·</span>
              <span title={`画质：${IMAGE_STUDIO_QUALITY_LABELS[normalizeImageStudioQuality(task.model, task.quality) as keyof typeof IMAGE_STUDIO_QUALITY_LABELS] || task.quality || '自动'}`}>{IMAGE_STUDIO_QUALITY_LABELS[normalizeImageStudioQuality(task.model, task.quality) as keyof typeof IMAGE_STUDIO_QUALITY_LABELS] || task.quality || '自动'}</span>
            </>}
            <span>·</span><span className={styles.resolutionHint} tabIndex={0} aria-describedby={`studio-size-${task.id}`}>
              {task.snapshot?.resolution && /^[124]K$/i.test(task.snapshot.resolution) ? task.snapshot.resolution : '自动'}
              <span id={`studio-size-${task.id}`} role="tooltip" className={styles.resolutionTooltip}>{task.asset?.width && task.asset.height ? `${task.asset.width} × ${task.asset.height} px` : '实际尺寸暂不可用'}</span>
            </span>
            <span>·</span><span className={styles.resultContextVersion} title={task.snapshot?.moduleContextVersion ? `模块上下文版本：${task.snapshot.moduleContextVersion}` : '模块上下文版本状态'}><ContextVersionLabel code={task.snapshot?.moduleContextVersion} state={task.snapshot?.moduleContextVersionState || 'missing'} onRetry={() => void loadTasks()} /></span>
            </div>
            <RelativeTime className={styles.resultTime} value={task.createdAt} />
          </div>
</> : sharedPin ? <><div className={styles.resultHeading}><p className={styles.prompt}>{name} · 置顶图片</p><span className={styles.resultOwner}>{sharedPin.owner?.name || '模板使用者'}</span></div>
            <div className={styles.resultMeta}><span className={styles.muted}>查看与点赞</span><RelativeTime className={styles.resultTime} value={sharedPin.createdAt} /></div></> : null}
          renderPrimaryActions={({task}, waitDisplay) => !task ? null : task.status === 'queued' && task.snapshot?.imageChannelLabel ? <button type="button" disabled={submitting} onClick={() => void (async () => {
            if (!await confirm('只取消尚未向供应商请求的排队任务并释放原预留；已受理或结果未知的任务不会取消。', { title: '取消排队', confirmLabel: '取消排队' })) return;
            try {
              const response = await fetch('/api/image-studio/tasks', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'cancel', id: task.id }) });
              const result = await response.json();
              if (!response.ok) throw new Error(result.error || '取消未确认，请刷新原任务');
              await loadTasks();
            } catch (cause) { setError(cause instanceof Error ? cause.message : '取消未确认，请刷新原任务'); }
          })()}>取消未受理排队</button> : (waitDisplay?.showRecovery ?? task.delivery?.recoveryAvailable) ? <button type="button" disabled={templateWorkbench && taskReadAction !== 'idle'} onClick={() => void loadTasks()}>{templateWorkbench ? '刷新恢复状态' : '查看原图恢复'}</button> : null}
          renderActions={({task}) => task && (isAdmin && task.snapshot?.sourceAvailable || studioTaskHasDeliveredAsset(task)) ? <>{isAdmin && task.snapshot?.sourceAvailable && <button type="button" className="sd2-loading-surface" data-busy={copyFeedback?.id === task.id && copyFeedback.text === '复制中…'} disabled={copyFeedback?.id === task.id && copyFeedback.text === '复制中…'} title="复制文字上下文" aria-label="复制文字上下文" onClick={() => void copyTaskContext(task)}><ClipboardList size={15} /></button>}
            {studioTaskHasDeliveredAsset(task) && <button type="button" className={styles.restoreResult} disabled={Boolean(restoreDisabledReason(task))} title={restoreDisabledReason(task) || '恢复设置和风格组，保留当前主图，不生成图片'} aria-label="恢复设置，保留主图" aria-describedby={`studio-restore-${task.id}`} onClick={event => {
              event.stopPropagation();
              void restoreResultSettings(task);
            }}><RotateCcw size={15} /><span id={`studio-restore-${task.id}`} role="tooltip" className={styles.resolutionTooltip}>恢复设置</span></button>}
</> : null}
          renderSupplement={({task}) => task ? <>
            {copyFeedback?.id === task.id && <span className={styles.copyFeedback} role="status">{copyFeedback.text}</span>}
            {['download', 'recover'].includes(task.delivery?.phase || '') && Number(task.delivery?.expectedBytes) > 0 && task.delivery?.receivedBytes != null && <p role="status">{Math.min(100, Math.floor(task.delivery.receivedBytes / task.delivery.expectedBytes! * 100))}% 字节已接收</p>}
            {task.delivery?.checkpointRetained && task.status === 'uncertain' && <p className={styles.muted}>恢复资料暂留供协查，已退款任务不能自动领取原图。请联系管理员。</p>}
          </> : null}
        />
        </>}
      </section>
    </div>
    {assetPickerOpen && <UploadedImagePicker open imageOnly target="image-studio"
      initialSource={templateWorkbench ? 'template-image' : 'all'}
      title={imageSourceTarget === 'fixed-repair' ? '替换失效固定参考' : imageSourceTarget === 'template' ? '添加共享参考图' : imageSourceTarget === 'banner' ? '替换横幅' : imageSourceTarget === 'fixed' ? '添加固定参考图' : imageSourceTarget === 'auxiliary' ? '添加参考图' : generationReferencePolicy.primaryMax === 1 && images.length ? '替换主图' : '添加主图'}
      confirmLabel={imageSourceTarget === 'fixed-repair' ? '用此图替换失效项' : imageSourceTarget === 'template' ? '加入共享模板' : imageSourceTarget === 'banner' ? '替换横幅' : imageSourceTarget === 'fixed' ? '添加到固定参考区' : imageSourceTarget === 'auxiliary' ? '添加到参考区' : generationReferencePolicy.primaryMax === 1 && images.length ? '替换主图' : '添加到主图'}
      purpose={imageSourceTarget === 'fixed-repair' ? 'fixed' : imageSourceTarget === 'template' ? 'auxiliary' : imageSourceTarget}
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
        const payload=temporaryDraftPayload(nextImages,nextAuxiliary,nextPolicy);
        try{localStorage.setItem(draftKey,JSON.stringify(payload));}catch{throw new Error('人物图片尚未存入本机草稿，未完成回填，请勿关闭原页面');}
        setImages(nextImages);setAuxiliaryImages(nextAuxiliary);
      }}
      portalContainer={imageSourceTarget === 'fixed' || imageSourceTarget === 'fixed-repair' || imageSourceTarget === 'template' ? moduleDialog.current : undefined}
      currentCount={imageSourceTarget === 'fixed-repair' ? 0 : imageSourceTarget === 'template' ? templateImages.length : imageSourceTarget === 'banner' ? 0 : imageSourceTarget === 'fixed' ? fixedReferences.length : imageSourceTarget === 'auxiliary' ? auxiliaryImages.length : images.length}
      currentAssetIds={imageSourceTarget === 'banner' || imageSourceTarget === 'fixed-repair' ? [] : (imageSourceTarget === 'template' ? templateImages : imageSourceTarget === 'fixed' ? fixedReferences : imageSourceTarget === 'auxiliary' ? auxiliaryImages : images).flatMap(image => image.id ? [image.id] : [])}
      maxSelection={imageSourceTarget === 'fixed-repair' ? 1 : imageSourceTarget === 'template' ? Math.max(0, currentTemplateCap - templateImages.length) : imageSourceTarget === 'banner' ? 1 : imageSourceTarget === 'fixed' ? MAX_REFERENCE_IMAGES - fixedReferences.length : imageSourceTarget === 'auxiliary' ? Math.max(0, currentAuxiliaryCap - auxiliaryImages.length) : generationReferencePolicy.primaryMax === 1 && currentReferenceCap > 0 ? 1 : Math.max(0, currentReferenceCap - images.length)}
      onClose={() => setAssetPickerOpen(false)}
      onUploadedAssetsConfirmed={assets => { setUploadSummaryTarget(imageSourceTarget === 'fixed-repair' ? 'fixed' : imageSourceTarget === 'reference' ? 'primary' : imageSourceTarget); setUploadedSummary(assets); }}
      onUploadFile={async (file, onProgress) => {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024) throw new Error('请使用 20MB 以内的 PNG、JPG 或 WebP 图片');
        if (submitting || pendingSubmission || uploading || bannerUploading) throw new Error('当前操作尚未结束，请稍后上传');
        if (imageSourceTarget === 'fixed' && !fixedEditable) throw new Error('当前不能编辑固定参考图');
        if (imageSourceTarget === 'fixed-repair' && !fixedRepairAllowed) throw new Error('失效固定参考修复权限已变化');
        if (imageSourceTarget === 'template' && !definitionReady) throw new Error('当前不能编辑共享参考图');
        setUploading(true);
        try { return await uploadFileAsAsset(file, { ownerId: userId, onProgress }); }
        finally { setUploading(false); }
      }}
      onConfirm={async (_ids, assets) => {
        if (submitting || pendingSubmission || uploading || bannerUploading) throw new Error('当前操作尚未结束，请稍后选择');
        const picked = (assets || []).filter(asset => asset.type === 'image' && asset.originalUrl);
        if (!picked.length || picked.length !== _ids.length) throw new Error('图片信息不完整，请重新选择');
        if (imageSourceTarget === 'fixed-repair') {
          const source = fixedRepairTarget && repairDefinition?.fixedReferences[fixedRepairTarget.sourceIndex];
          if (!fixedRepairAllowed || !fixedRepairTarget || !source?.repairable || source.id !== fixedRepairTarget.originalAssetId
            || repairDefinition?.definitionToken !== fixedRepairTarget.definitionToken || picked.length !== 1 || !picked[0].id
            || picked[0].id !== _ids[0]) throw new Error('修复来源已变化，请重新选择；当前草稿保留');
          changeFixedRepair(fixedRepairTarget.sourceIndex, picked[0].id);
        } else if (imageSourceTarget === 'template') {
          if (!definitionReady) throw new Error('当前不能编辑共享参考图');
          const additions = picked.filter(asset => !templateImages.some(image => image.id === asset.id));
          if (templateImages.length + additions.length > currentTemplateCap) throw new Error(`共享参考图最多 ${currentTemplateCap} 张`);
          setTemplateImages(current => [...current, ...additions]);
        } else if (imageSourceTarget === 'banner') {
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
          if ((generationReferencePolicy.primaryMax === 1 ? additions.length : images.length + additions.length) > currentReferenceCap) throw new Error(`本次最多选择 ${currentReferenceCap} 张主图`);
          setImages(current => generationReferencePolicy.primaryMax === 1 ? additions : [...current, ...additions]);
        }
      }} />}
    <dialog ref={inputMainDialog} className={styles.dialog} aria-labelledby={`input-main-title-${module.id}`}>
      <header className={styles.header}><h2 id={`input-main-title-${module.id}`}>取回输入主图</h2><button type="button" aria-label="取消取回输入主图" onClick={closeInputMainChoice}><X size={20} /></button></header>
      <p>这次生成用了多张主图。请选择要取回的图片；确认前不会改变当前主图，也不会生成图片。</p>
      <div className={styles.inputMainGrid}>
        {inputMainChoice?.images.map((asset, index) => {
          const selected = inputMainChoice.selectedIds.includes(asset.id!);
          return <label key={asset.id} className={styles.inputMainOption} data-selected={selected}>
            <SessionPreviewImage src={asset.originalUrl!} thumbnail={asset.thumbnailUrl} alt={`这次生成的输入主图 ${index + 1}`} />
            <span><input type="checkbox" checked={selected} disabled={inputMainBusy || (!selected && inputMainChoice.selectedIds.length >= currentReferenceCap)}
              onChange={event => { const checked = event.target.checked; setInputMainChoice(current => current && ({ ...current, selectedIds: checked ? [...current.selectedIds, asset.id!] : current.selectedIds.filter(id => id !== asset.id) })); setInputMainError(''); }} />输入主图 {index + 1}</span>
          </label>;
        })}
      </div>
      <p className={styles.muted}>已选 {inputMainChoice?.selectedIds.length || 0} 张，当前最多 {currentReferenceCap} 张。取回的是本次直接输入的原件，不是生成结果。</p>
      {inputMainError && <p role="alert" className={styles.error}>{inputMainError}</p>}
      <div className={styles.presetActions}><button type="button" onClick={closeInputMainChoice}>取消</button><button type="button" className={styles.primary} disabled={inputMainBusy || !inputMainChoice?.selectedIds.length || inputMainChoice.selectedIds.length > currentReferenceCap} onClick={() => void applyInputMainChoice()}>{inputMainBusy ? '正在核对原件' : '取回所选主图'}</button></div>
    </dialog>
    <dialog ref={deleteDialog} className={`${styles.dialog}${templateWorkbench ? ` ${styles.resultDeleteDialog}` : ''}`} aria-labelledby={`delete-title-${module.id}`}>
      <h2 id={`delete-title-${module.id}`}>删除这张图片？</h2>
      {!templateWorkbench && <p>将从本模块的生成结果中移除，不退还已消耗积分。其他模块、参考图和已保存的副本不受影响。</p>}
      {deleteError && <p role="alert" className={styles.error}>{deleteError}</p>}
      <div className={templateWorkbench ? styles.resultDeleteActions : styles.resultActions}><button ref={deleteCancel} type="button" autoFocus disabled={deleting} onClick={() => setDeleteTarget(null)}>取消</button><button type="button" className={styles.danger} disabled={deleting} onClick={() => void deleteResult()}><Trash2 size={16} />{deleting ? '删除中' : templateWorkbench ? '删除' : '确认删除'}</button></div>
    </dialog>
    <dialog ref={moduleDialog} className={`${styles.dialog} ${styles.contextDialog}`} onPaste={event => {
      if (!fixedEditable || assetPickerOpen) return;
      const files = Array.from(event.clipboardData.items).filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter((file): file is File => Boolean(file));
      if (files.length) { event.preventDefault(); event.stopPropagation(); void addImages(files, true); }
    }}>
      <header className={styles.header}><h2>{repairDefinition ? '修复模板' : '模块上下文'}</h2><button type="button" aria-label="关闭模块上下文" onClick={closeModuleDialog}><X size={20} /></button></header>
      <div className={styles.contextEditorTools}><span>模块上下文版本：<ContextVersionLabel {...contextVersion} /></span>
        <button type="button" disabled={!settings?.templateDefaults || !draftLoaded || draftRestoring || moduleSaving || moduleDeleting || presetSaving || Boolean(quickPresetApplying) || submitting || Boolean(pendingSubmission) || uploading || bannerUploading || ratioEditing}
          onClick={applyUnifiedDefaults}><RefreshCw size={16} />套用统一默认</button>
        {contextEditable && <ContextClipboardActions value={moduleContext} textareaRef={moduleContextInput} onPaste={changeModuleContext} maxLength={20000} disabled={moduleSaving} />}
      </div>
      {unifiedDefaultsError && <p role="alert" className={styles.error}>{unifiedDefaultsError}</p>}
      {repairDefinition && definitionReady && <StudioRepairFields repair={repairDefinition} templatePrompt={templatePrompt} onTemplatePrompt={setTemplatePrompt}
        templateImages={templateImages} onTemplateImages={setTemplateImages} fixedReferences={fixedReferences} onFixedReferences={changeFixedReferences}
        styleGroups={styleGroups} onStyleGroups={setStyleGroups} skills={skills} onSkills={setSkills} banner={banner} onBanner={setBanner}
        fixedEditable={fixedEditable} disabled={moduleSaving || uploading || bannerUploading || submitting || Boolean(pendingSubmission)}
        fixedRepairs={fixedReferenceRepairs} onRepairFixed={changeFixedRepair} onReplaceFixed={openFixedRepair}
        onAddTemplate={() => openImageSource('template')} onReplaceBanner={() => openImageSource('banner')}
        onPreview={(image, number) => previewReference(image, number, true)} />}
      {/* 隐藏旧模板说明和共享参考编辑区，历史值及已保存生成合同继续保留。 */}
      {contextEditable ? <>
        <textarea ref={moduleContextInput} aria-label="模块上下文" rows={12} maxLength={20000} value={moduleContext} onCompositionStart={() => setContextComposing(true)} onCompositionEnd={event => { setContextComposing(false); changeModuleContext(event.currentTarget.value); }} onChange={event => changeModuleContext(event.target.value)} />
      </> : <p className={styles.muted}>共享模板的内部上下文由创建者维护，生成时自动使用。</p>}
      <fieldset className={styles.referenceLimits} disabled={!definitionReady}>
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
      </fieldset>
      {templateWorkbench && <button type="button" title="替换主图提醒设置" onClick={() => void confirm('此设置仅影响替换主图提醒，不影响生成费用、变价或权限确认。', { title: '主图提醒', confirmLabel: '保存设置', checkbox: { label: '每次替换主图前提醒', checked: !skipMainImageReminder(userId) }, onSubmit: async (_value, checked) => saveMainImageReminder(userId, !checked) })}><Settings size={16} />主图提醒</button>}
      <div className={styles.moduleSettingsActions}>
        <button type="button" className={`${styles.primary} sd2-loading-surface`} data-busy={moduleSaving} title={definitionSaveReason || undefined} disabled={definitionSaveBlocked || !sharedReady && !definitionReady || moduleSaving || sharingPreferenceSaving || uploading || bannerUploading || !settingsDirty && !unpublishedSharing} onClick={() => void saveModuleSettings()}><Save size={16} />{moduleSaving ? '正在保存' : sharedLive ? definitionEditable ? '保存共享模板' : '保存本次设置' : unpublishedSharing ? '保存并共享模板' : templateWorkbench ? '保存模块设置' : '保存模板设置'}</button>
      </div>
      {definitionSaveReason && <p role="status" className={styles.muted}>{definitionSaveReason}</p>}
      {fixedSaveUnknown && <p role="status" className={styles.muted}><button type="button" disabled={checkingFixedSave || moduleSaving || sessionChanged}
        onClick={() => void queryFixedReferenceSave()}>{checkingFixedSave ? '正在核对原保存' : '核对原保存'}</button></p>}
      {moduleSaveError && <p role="alert" className={styles.error}>{moduleSaveError}{fixedSaveUnknown ? null : definitionConflict && definitionReady ? <button type="button" disabled={moduleSaving || uploading || bannerUploading} onClick={() => void (async () => {
        if (!await confirm('当前编辑会保留。请核对最新模板后再继续；确认后只采用最新版本作为保存依据，不会立即保存或生成。', { title: '核对更新', confirmLabel: '已核对，继续编辑' })) return;
        definitionBaseline.current = studioRepairModule(module); revisionRef.current = module.revision; setModuleRevision(module.revision);
        setDefinitionConflict(false); setModuleSaveError('');
      })()}>核对最新版本</button> : <button type="button" disabled={definitionSaveBlocked || moduleSaving || uploading || bannerUploading} onClick={() => void saveModuleSettings()}>重试保存</button>}</p>}
      <div className={styles.imageSectionHeading}><label className={styles.referenceToggle}><input type="checkbox" checked={useFixedReferences} disabled={!definitionReady || submitting || Boolean(pendingSubmission)} onChange={event => setUseFixedReferences(event.target.checked)} />使用模板固定参考图</label>
        <button type="button" disabled={uploading || submitting || Boolean(pendingSubmission) || !auxiliaryCount} onClick={clearAllReferences}><X size={15} />一键清空参考</button></div>
      {isAdmin && <><label className={styles.label}>固定模板图 <span>{fixedReferences.length}/{MAX_REFERENCE_IMAGES}</span></label>
      <div onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void addImages(Array.from(event.dataTransfer.files), true); }}>
        <StudioReferenceGrid items={fixedReferences} onChange={changeFixedReferences} onPreview={previewReference} compact labels="template" notes
          disabled={!fixedEditable || uploading || moduleSaving || submitting || Boolean(pendingSubmission)}>
          {fixedEditable && fixedReferences.length < MAX_REFERENCE_IMAGES && <button type="button" className={styles.add} disabled={uploading || moduleSaving || submitting || Boolean(pendingSubmission)} onClick={() => openImageSource('fixed')}><ImagePlus size={20} />添加图片</button>}
        </StudioReferenceGrid>
      </div>
      <input ref={fixedFileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={event => { void addImages(Array.from(event.target.files || []), true); event.target.value = ''; }} /></>}
      <button type="button" disabled={!definitionReady || uploading || submitting || Boolean(pendingSubmission)}
        onClick={() => styleSkillSelector.current?.open('styles')}>选择风格与提示词</button>
      {uploadProgress && <UploadProgressIndicator busy {...uploadProgress} />}
      {error && <p role="status" className={styles.error}>{error}</p>}
      <div className={styles.modelQualityRow}>
        <label className={styles.compactField} htmlFor={`studio-module-model-${module.id}`}><strong>模块模型</strong>
          <select id={`studio-module-model-${module.id}`} value={moduleModel} disabled={!draftLoaded || draftRestoring || submissionRecoveryScope !== pendingKey || !batch.recoveryKnown || submitting || Boolean(pendingSubmission) || Boolean(batch.pending)} onChange={event => selectModuleModel(event.target.value, true)}>
            {moduleModel === 'gemini-3.1-flash-image-preview' && <option value={moduleModel} disabled>{IMAGE_STUDIO_MODEL_LABELS[moduleModel]}</option>}
            {IMAGE_STUDIO_NEW_REQUEST_MODELS.map(model => <option key={model} value={model}>{IMAGE_STUDIO_MODEL_LABELS[model]}</option>)}
          </select>
        </label>
        <label className={styles.compactField} htmlFor={`studio-module-resolution-${module.id}`}><strong>模块分辨率</strong>
          <select id={`studio-module-resolution-${module.id}`} value={moduleDraft.resolution} onChange={event => setResolution(normalizeImageResolution(moduleModel, event.target.value))}>
            {preserveSelectedBananaParameters && !(IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS[moduleModel as keyof typeof IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS] || []).includes(resolution) && <option value={resolution} disabled>{resolution}（当前模型不支持）</option>}
            {(IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS[moduleModel as keyof typeof IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS] || ['1K', '2K']).map(option => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <label className={styles.compactField} htmlFor={`studio-module-quality-${module.id}`}><strong>图片质量</strong>
          <select id={`studio-module-quality-${module.id}`} value={moduleDraft.quality} onChange={event => setQuality(event.target.value)}>
            {preserveSelectedBananaParameters && !((IMAGE_STUDIO_MODEL_QUALITY_OPTIONS[moduleModel as keyof typeof IMAGE_STUDIO_MODEL_QUALITY_OPTIONS] || []) as readonly string[]).includes(quality) && <option value={quality} disabled>{IMAGE_STUDIO_QUALITY_LABELS[quality as keyof typeof IMAGE_STUDIO_QUALITY_LABELS] || quality}（当前模型不支持）</option>}
            {(IMAGE_STUDIO_MODEL_QUALITY_OPTIONS[moduleModel as keyof typeof IMAGE_STUDIO_MODEL_QUALITY_OPTIONS] || ['auto']).map(option => <option key={option} value={option}>{IMAGE_STUDIO_QUALITY_LABELS[option]}</option>)}
          </select>
        </label>
      </div>
    </dialog>
    {coverEditorOpen && <ModuleCoverEditor key={`${userId}:${module.id}`} userId={userId} moduleId={module.id} moduleName={name} onClose={() => setCoverEditorOpen(false)} onSaved={fixedCover => { onModuleChange({ ...module, fixedCover }); onSharedRefresh(); }} />}
    {preview && !preview.taskId && <ZoomableImagePreview contentKey={preview.contentKey} src={preview.src} sourceRole={preview.sourceRole} thumbnailSrc={preview.thumbnailSrc} alt={preview.alt} title={preview.title} previewKey={preview.taskId || preview.src} fileName={preview.fileName} safeDetails={{ ...preview.metadata, width: preview.width, height: preview.height, fileSize: preview.fileSize }} comparison={preview.comparison}
 onClose={() => { setPreview(null); if (resumeModulePreview.current) { resumeModulePreview.current = false; moduleDialog.current?.showModal(); } }} />}
  </section>)}</>;
}
