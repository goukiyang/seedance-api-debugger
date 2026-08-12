/* eslint-disable @next/next/no-img-element */
'use client';

import Link from 'next/link';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { CheckSquare, Download, Eye, FolderInput, FolderPlus, ImagePlus, RefreshCcw, Search, Sparkles, Upload, X } from 'lucide-react';
import {
  BULK_VIDEO_DOWNLOAD_CLIENT_LIMIT,
  downloadBulkVideoZip,
} from '@/lib/video/download-client';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import { UploadProgressIndicator } from '@/components/UploadProgressIndicator';
import { calculateEnhanceVideoEstimatedCostClient } from '@/lib/pricing-client';
import { taskDetailHref } from '@/lib/navigation/return-to';
import { uploadFileAsAsset, type UploadProgressSnapshot } from '@/lib/http/file-upload';
import {
  createAssetLibraryCacheKey,
  readAssetLibraryCache,
  writeAssetLibraryCache,
} from '@/lib/assets/library-cache';

type AssetScope = 'history' | 'project' | 'user';
type AssetView = AssetScope | 'enhance';
type AssetType = 'all' | 'video' | 'image' | 'audio' | 'reference';
type AssetStatus = 'all' | 'succeeded' | 'running' | 'submitted' | 'failed' | 'cancelled' | 'hidden';
type AssetSort = 'created_desc' | 'created_asc' | 'completed_desc' | 'project' | 'user' | 'duration';
type AssetGroup = 'date' | 'project' | 'user';
type AssetCardSize = 'standard' | 'compact';
type AssetBulkTarget = 'video_project' | 'album';
type AssetLibraryItemId = `video_task:${string}` | `asset:${string}` | `reference_image:${string}`;
type EnhanceResolution = '720p' | '1080p' | '2k' | '4k';
type EnhanceFps = 'none' | '30' | '60';
type VideoDeliveryStageKey = 'generating' | 'preparing' | 'ready' | 'failed' | 'unavailable';

type VideoDeliveryStage = {
  key: VideoDeliveryStageKey;
  label: string;
  stableDownloadReady: boolean;
  previewAvailable: boolean;
};

type SessionUser = {
  id: string;
  role: 'admin' | 'user';
  name?: string | null;
  username?: string | null;
  email?: string | null;
};

type ProjectItem = {
  id: string;
  name: string;
  type: string;
  status: string;
  can_manage_project?: boolean;
  can_manage_assets?: boolean;
};

type UserItem = {
  id: string;
  name: string;
  username: string;
  email: string;
  status: string;
};

type VideoCardItem = {
  id: string;
  title: string;
  status: string;
  project_id: string;
};

type ReferenceAlbumItem = {
  id: string;
  name: string;
  album_type: string;
  project_id: string | null;
  image_count: number;
  status?: string;
  permissions?: { edit?: boolean };
  project?: { id: string; name: string } | null;
};

type AssetLibraryItem = {
  id: AssetLibraryItemId;
  kind: 'video' | 'image' | 'audio';
  source: 'video_task' | 'asset' | 'reference_image';
  taskId: string | null;
  assetId: string | null;
  referenceImageId: string | null;
  title: string;
  prompt: string | null;
  thumbnailUrl: string | null;
  previewUrl: string | null;
  downloadUrl: string | null;
  fileSize: number | null;
  duration: number | null;
  ratio: string | null;
  resolution: string | null;
  provider: string | null;
  generationMode: string | null;
  videoCardId: string | null;
  isEnhanceTask: boolean;
  canEnhanceVideo: boolean;
  enhanceSourceTaskId: string | null;
  status: string;
  retentionStatus: string | null;
  createdAt: string;
  completedAt: string | null;
  deliveryCompletedAt: string | null;
  project: { id: string; name: string; type?: string | null; status?: string | null } | null;
  owner: {
    id: string;
    name?: string | null;
    username?: string | null;
    email?: string | null;
    avatar_url?: string | null;
    account_type?: string | null;
    displayName: string;
    subtitle: string;
  } | null;
  downloadable: boolean;
  movable: boolean;
  deliveryStage?: VideoDeliveryStage | null;
  stableDownloadReady?: boolean;
  previewAvailable?: boolean;
};

type Pagination = {
  page: number;
  limit: number;
  total: number;
  total_pages: number;
  has_more: boolean;
};

type AssetLibraryUploadProgress = {
  label: string;
  detail: string;
  percent?: number;
};

type MarqueeState = {
  active: boolean;
  append: boolean;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  previewIds: AssetLibraryItemId[];
};

const assetViewTabs: Array<{ id: AssetView; label: string; adminOnly?: boolean; tone?: 'enhance' }> = [
  { id: 'history', label: '生产历史' },
  { id: 'project', label: '按项目' },
  { id: 'user', label: '按用户查看', adminOnly: true },
  { id: 'enhance', label: '视频超分', tone: 'enhance' },
];

const typeTabs: Array<{ id: AssetType; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'video', label: '视频' },
  { id: 'image', label: '图片' },
  { id: 'audio', label: '音频' },
  { id: 'reference', label: '参考素材' },
];

const statusOptions: Array<{ id: AssetStatus; label: string; adminOnly?: boolean }> = [
  { id: 'all', label: '全部状态（含失败）' },
  { id: 'succeeded', label: '已完成' },
  { id: 'running', label: '生成中' },
  { id: 'submitted', label: '排队中' },
  { id: 'failed', label: '失败' },
  { id: 'cancelled', label: '已取消' },
  { id: 'hidden', label: '已隐藏/已删除', adminOnly: true },
];

const sortOptions: Array<{ id: AssetSort; label: string; adminOnly?: boolean }> = [
  { id: 'created_desc', label: '最近生成' },
  { id: 'created_asc', label: '最早生成' },
  { id: 'completed_desc', label: '最近完成' },
  { id: 'project', label: '项目名称' },
  { id: 'user', label: '用户名称', adminOnly: true },
  { id: 'duration', label: '时长' },
];

const groupOptions: Array<{ id: AssetGroup; label: string; adminOnly?: boolean }> = [
  { id: 'date', label: '按时间' },
  { id: 'project', label: '按项目' },
  { id: 'user', label: '按用户', adminOnly: true },
];

const cardSizeOptions: Array<{ id: AssetCardSize; label: string; title: string }> = [
  { id: 'standard', label: '大', title: '大尺寸资产卡片' },
  { id: 'compact', label: '小', title: '小尺寸资产卡片' },
];

const ASSET_CARD_SIZE_STORAGE_KEY = 'asset_library_card_size';
const ASSET_SHOW_UPLOADS_STORAGE_KEY = 'asset_library_show_uploaded_assets';
const ASSET_BULK_TARGET_STORAGE_KEY = 'asset_library_bulk_target';
const ASSET_BULK_ALBUM_STORAGE_KEY = 'asset_library_bulk_album_id';
const WORKSPACE_TAB_ID_KEY = 'workspace_tab_id';

function isAssetType(value: string | null): value is AssetType {
  return value === 'all' || value === 'video' || value === 'image' || value === 'audio' || value === 'reference';
}

function isAssetCardSize(value: string | null): value is AssetCardSize {
  return value === 'standard' || value === 'compact';
}

function isAssetBulkTarget(value: string | null): value is AssetBulkTarget {
  return value === 'video_project' || value === 'album';
}

function readSavedAssetCardSize(): AssetCardSize {
  if (typeof window === 'undefined') return 'standard';
  try {
    const value = window.localStorage.getItem(ASSET_CARD_SIZE_STORAGE_KEY);
    return isAssetCardSize(value) ? value : 'standard';
  } catch {
    return 'standard';
  }
}

function readSavedShowUploadedAssets() {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(ASSET_SHOW_UPLOADS_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function readSavedAssetBulkTarget(): AssetBulkTarget {
  if (typeof window === 'undefined') return 'video_project';
  try {
    const value = window.localStorage.getItem(ASSET_BULK_TARGET_STORAGE_KEY);
    return isAssetBulkTarget(value) ? value : 'video_project';
  } catch {
    return 'video_project';
  }
}

function readSavedTargetAlbumId() {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(ASSET_BULK_ALBUM_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function formatAssetUploadBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function assetUploadTypeLabel(file: File | null) {
  if (!file) return '素材';
  if (file.type.startsWith('video/')) return '视频';
  if (file.type.startsWith('audio/')) return '音频';
  if (file.type.startsWith('image/')) return '图片';
  return '素材';
}

function assetLibraryTypeFromFile(file: File): AssetType {
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  if (file.type.startsWith('image/')) return 'image';
  return 'all';
}

function buildAssetLibraryUploadProgress(file: File, progress: UploadProgressSnapshot): AssetLibraryUploadProgress {
  const sizeText = formatAssetUploadBytes(file.size);
  const loadedText = progress.loadedBytes != null ? formatAssetUploadBytes(progress.loadedBytes) : '';
  const detailParts = [
    file.name,
    loadedText && sizeText ? `${loadedText} / ${sizeText}` : sizeText,
  ].filter(Boolean);
  return {
    label: progress.label,
    detail: detailParts.join(' · '),
    ...(progress.percent != null ? { percent: progress.percent } : {}),
  };
}

function getOrCreateWorkspaceTabId() {
  if (typeof window === 'undefined') return 'default';
  let tabId = window.sessionStorage.getItem(WORKSPACE_TAB_ID_KEY);
  if (!tabId) {
    tabId = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    window.sessionStorage.setItem(WORKSPACE_TAB_ID_KEY, tabId);
  }
  return tabId;
}

function statusLabel(status: string) {
  if (status === 'succeeded') return '已完成';
  if (status === 'running') return '生成中';
  if (status === 'submitted') return '排队中';
  if (status === 'failed') return '失败';
  if (status === 'cancelled') return '已取消';
  if (status === 'active') return '可用';
  if (status === 'hidden') return '已隐藏';
  if (status === 'deleted') return '已删除';
  return status || '未知';
}

function mediaFallbackLabel(item: Pick<AssetLibraryItem, 'kind' | 'source' | 'status'>) {
  if (item.kind === 'video' && item.source === 'asset') return '视频素材';
  if (item.kind === 'video' && item.status === 'succeeded') return '暂无截图';
  if (item.kind === 'image' && item.source === 'asset') return '图片素材';
  return statusLabel(item.status);
}

function formatDuration(seconds: number | null) {
  if (!seconds || seconds <= 0) return '';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatResolution(value: string | null) {
  const normalized = value?.trim();
  if (!normalized) return '';
  return normalized.toUpperCase();
}

function formatAssetSpec(item: Pick<AssetLibraryItem, 'kind' | 'resolution' | 'duration' | 'ratio' | 'fileSize'>) {
  const parts = [
    formatResolution(item.resolution),
    item.duration ? `${item.duration}s` : null,
    item.ratio,
  ].filter(Boolean);
  if (item.kind === 'audio') {
    parts.push(formatAssetUploadBytes(item.fileSize || 0) || '音频素材');
  }
  return parts.join(' · ');
}

function isFastPathAssetVideo(item: AssetLibraryItem) {
  return item.kind === 'video'
    && item.source === 'video_task'
    && (item.provider || 'seedance') === 'seedance'
    && item.generationMode !== 'enhance_video';
}

function shouldShowDeliveryStage(item: AssetLibraryItem) {
  return isFastPathAssetVideo(item)
    && Boolean(item.deliveryStage)
    && item.deliveryStage?.key !== 'unavailable';
}

function deliveryStageClassName(stage: VideoDeliveryStage | null | undefined) {
  if (!stage) return 'asset-card-delivery-stage';
  if (stage.key === 'ready') return 'asset-card-delivery-stage is-ready';
  if (stage.key === 'failed') return 'asset-card-delivery-stage is-failed';
  if (stage.key === 'preparing') return 'asset-card-delivery-stage is-preparing';
  return 'asset-card-delivery-stage';
}

function aspectRatioFromDimensions(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return `${Math.round(width)} / ${Math.round(height)}`;
}

function parseStoredAspectRatio(value: string | null) {
  const normalized = value?.trim();
  if (!normalized) return null;
  const pair = normalized.match(/^(\d+(?:\.\d+)?)\s*(?::|\/|x|X|×)\s*(\d+(?:\.\d+)?)$/);
  if (pair) return aspectRatioFromDimensions(Number(pair[1]), Number(pair[2]));
  const decimal = Number(normalized);
  if (Number.isFinite(decimal) && decimal > 0) return `${decimal} / 1`;
  return null;
}

function parseResolutionAspectRatio(value: string | null) {
  const normalized = value?.trim();
  if (!normalized) return null;
  const pair = normalized.match(/(\d{2,5})\s*(?:x|X|×)\s*(\d{2,5})/);
  return pair ? aspectRatioFromDimensions(Number(pair[1]), Number(pair[2])) : null;
}

function getAssetPreviewAspectRatio(item: Pick<AssetLibraryItem, 'ratio' | 'resolution'>) {
  return parseStoredAspectRatio(item.ratio) || parseResolutionAspectRatio(item.resolution);
}

function isPortraitAspectRatio(value: string | null) {
  const pair = value?.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  return pair ? Number(pair[1]) < Number(pair[2]) : false;
}

function formatDateTime(value: string | null) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function timestampMs(value: string | null) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function formatElapsedTime(milliseconds: number) {
  const totalSeconds = Math.max(1, Math.round(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}小时${minutes}分${seconds}秒`;
  if (minutes > 0) return `${minutes}分${seconds}秒`;
  return `${seconds}秒`;
}

function elapsedBetween(start: string | null, end: string | null) {
  const startMs = timestampMs(start);
  const endMs = timestampMs(end);
  if (startMs === null || endMs === null || endMs < startMs) return null;
  return formatElapsedTime(endMs - startMs);
}

function deliveryStatsTooltip(item: AssetLibraryItem) {
  const readyAt = item.deliveryCompletedAt || (item.stableDownloadReady ? item.completedAt : null);
  const submitToComplete = elapsedBetween(item.createdAt, item.completedAt);
  const submitToReady = elapsedBetween(item.createdAt, readyAt);
  const completedToReady = elapsedBetween(item.completedAt, readyAt);
  const lines = [];
  if (submitToComplete) lines.push(`提交到生成完成：${submitToComplete}`);
  if (completedToReady) lines.push(`生成完成到可下载：${completedToReady}`);
  if (submitToReady) lines.push(`提交到可下载：${submitToReady}`);
  if (lines.length === 0) lines.push('暂无完整生成时长统计');
  return lines.join('\n');
}

function dateGroupLabel(value: string) {
  const date = new Date(value);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startOfToday - startOfDate) / 86_400_000);
  if (dayDiff === 0) return '今天';
  if (dayDiff === 1) return '昨天';
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function itemGroupLabel(item: AssetLibraryItem, groupBy: AssetGroup) {
  if (groupBy === 'project') return item.project?.name || '未归属项目';
  if (groupBy === 'user') return item.owner?.displayName || '未知用户';
  return dateGroupLabel(item.createdAt);
}

function itemGroupKey(item: AssetLibraryItem, groupBy: AssetGroup) {
  if (groupBy === 'project') return item.project?.id || 'unassigned';
  if (groupBy === 'user') return item.owner?.id || 'unknown';
  const date = new Date(item.createdAt);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function shortText(value: string | null | undefined, fallback = '未命名资产', length = 80) {
  const text = value?.trim() || fallback;
  return text.length > length ? `${text.slice(0, length)}...` : text;
}

function intersects(a: DOMRect, b: DOMRect) {
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
}

function rectFromPoints(a: { x: number; y: number }, b: { x: number; y: number }) {
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  return {
    left,
    top,
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

function isReusableImageItem(item: AssetLibraryItem) {
  return (item.source === 'asset' && item.kind === 'image' && Boolean(item.assetId))
    || (item.source === 'reference_image' && Boolean(item.referenceImageId));
}

function cacheSafeAssetUrl(value: string | null) {
  if (!value) return null;
  return value.startsWith('/') ? value : null;
}

function toCacheSafeOwner(owner: AssetLibraryItem['owner']): AssetLibraryItem['owner'] {
  if (!owner) return null;
  return {
    id: owner.id,
    name: owner.displayName,
    username: null,
    email: null,
    avatar_url: cacheSafeAssetUrl(owner.avatar_url || null),
    account_type: null,
    displayName: owner.displayName,
    subtitle: '',
  };
}

function toCacheSafeAssetItem(item: AssetLibraryItem): AssetLibraryItem {
  return {
    ...item,
    prompt: null,
    owner: toCacheSafeOwner(item.owner),
    thumbnailUrl: cacheSafeAssetUrl(item.thumbnailUrl),
    previewUrl: cacheSafeAssetUrl(item.previewUrl),
    downloadUrl: cacheSafeAssetUrl(item.downloadUrl),
  };
}

function AssetsPageContent() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [assetView, setAssetView] = useState<AssetView>('history');
  const [type, setType] = useState<AssetType>('video');
  const [status, setStatus] = useState<AssetStatus>('succeeded');
  const [sort, setSort] = useState<AssetSort>('created_desc');
  const [groupBy, setGroupBy] = useState<AssetGroup>('date');
  const [cardSize, setCardSize] = useState<AssetCardSize>(() => readSavedAssetCardSize());
  const [showUploadedAssets, setShowUploadedAssets] = useState(() => readSavedShowUploadedAssets());
  const [projectId, setProjectId] = useState('');
  const [ownerUserId, setOwnerUserId] = useState('');
  const [keyword, setKeyword] = useState('');
  const [keywordDraft, setKeywordDraft] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<AssetLibraryItem[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [users, setUsers] = useState<UserItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncingAssets, setSyncingAssets] = useState(false);
  const [showingCachedAssets, setShowingCachedAssets] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [selectedIds, setSelectedIds] = useState<AssetLibraryItemId[]>([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [anchorId, setAnchorId] = useState<AssetLibraryItemId | null>(null);
  const [activeItem, setActiveItem] = useState<AssetLibraryItem | null>(null);
  const [detailMediaAspectRatio, setDetailMediaAspectRatio] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<MarqueeState | null>(null);
  const [movePanelOpen, setMovePanelOpen] = useState(false);
  const [bulkTarget, setBulkTarget] = useState<AssetBulkTarget>(() => readSavedAssetBulkTarget());
  const [moveProjectId, setMoveProjectId] = useState('');
  const [moveVideoCardId, setMoveVideoCardId] = useState('');
  const [videoCards, setVideoCards] = useState<VideoCardItem[]>([]);
  const [referenceAlbums, setReferenceAlbums] = useState<ReferenceAlbumItem[]>([]);
  const [targetAlbumId, setTargetAlbumId] = useState(() => readSavedTargetAlbumId());
  const [moving, setMoving] = useState(false);
  const [bulkDownloading, setBulkDownloading] = useState(false);
  const [aiMediaKitReady, setAiMediaKitReady] = useState<boolean | null>(null);
  const [enhanceMenuItemId, setEnhanceMenuItemId] = useState<AssetLibraryItemId | null>(null);
  const [enhanceResolution, setEnhanceResolution] = useState<EnhanceResolution>('1080p');
  const [enhanceFps, setEnhanceFps] = useState<EnhanceFps>('none');
  const [enhanceSubmittingId, setEnhanceSubmittingId] = useState<AssetLibraryItemId | null>(null);
  const [preparingDownloadTaskId, setPreparingDownloadTaskId] = useState<string | null>(null);
  const [assetUploadFile, setAssetUploadFile] = useState<File | null>(null);
  const [assetUploading, setAssetUploading] = useState(false);
  const [assetUploadProgress, setAssetUploadProgress] = useState<AssetLibraryUploadProgress | null>(null);

  const cardRefs = useRef(new Map<AssetLibraryItemId, HTMLDivElement>());
  const touchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const assetUploadInputRef = useRef<HTMLInputElement | null>(null);

  const isAdmin = user?.role === 'admin';
  const isEnhanceView = assetView === 'enhance';
  const scope: AssetScope = isEnhanceView ? 'history' : assetView;
  const requestType: AssetType = isEnhanceView ? 'video' : type;
  const enhanceFilter = isEnhanceView ? 'all' : 'none';
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const previewSet = useMemo(() => new Set(marquee?.previewIds || []), [marquee?.previewIds]);
  const selectedItems = useMemo(
    () => items.filter((item) => selectedSet.has(item.id)),
    [items, selectedSet],
  );
  const downloadableTaskIds = selectedItems
    .filter((item) => item.source === 'video_task' && item.taskId && item.downloadable)
    .map((item) => item.taskId as string);
  const movableItemIds = selectedItems.filter((item) => item.movable).map((item) => item.id);
  const reusableImageItems = selectedItems.filter(isReusableImageItem);
  const reusableAssetIds = reusableImageItems
    .filter((item) => item.source === 'asset' && item.assetId)
    .map((item) => item.assetId as string);
  const reusableReferenceImageIds = reusableImageItems
    .filter((item) => item.source === 'reference_image' && item.referenceImageId)
    .map((item) => item.referenceImageId as string);
  const manageableProjects = projects.filter((project) => project.can_manage_project);
  const activePreviewAspectRatio = activeItem
    ? activeItem.kind === 'audio' ? '16 / 6' : detailMediaAspectRatio || getAssetPreviewAspectRatio(activeItem) || '16 / 10'
    : '16 / 10';
  const activePreviewIsPortrait = isPortraitAspectRatio(activePreviewAspectRatio);

  const groupedItems = useMemo(() => {
    const groups = new Map<string, { key: string; label: string; owner: AssetLibraryItem['owner']; items: AssetLibraryItem[] }>();
    items.forEach((item) => {
      const key = itemGroupKey(item, groupBy);
      const label = itemGroupLabel(item, groupBy);
      const current = groups.get(key);
      if (current) current.items.push(item);
      else groups.set(key, { key, label, owner: groupBy === 'user' ? item.owner : null, items: [item] });
    });
    return Array.from(groups.values());
  }, [items, groupBy]);

  const clearSelection = () => {
    setSelectedIds([]);
    setAnchorId(null);
    setMovePanelOpen(false);
  };

  const toggleSelectionMode = () => {
    if (selectionMode) {
      clearSelection();
      setMarquee(null);
      setSelectionMode(false);
      return;
    }
    setSelectionMode(true);
  };

  const resetForFilterChange = () => {
    setPage(1);
    setActiveItem(null);
    clearSelection();
  };

  useEffect(() => {
    let cancelled = false;
    const requestedType = new URLSearchParams(window.location.search).get('type');
    if (isAssetType(requestedType)) setType(requestedType);

    fetch('/api/auth/me', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled) {
          if (!data.user) {
            window.location.href = '/login';
            return;
          }
          setUser(data.user);
        }
      })
      .catch(() => {
        if (!cancelled) setError('登录状态加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    fetch('/api/config', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled) setAiMediaKitReady(data.aimediakit_enhance_video?.ready === true);
      })
      .catch(() => {
        if (!cancelled) setAiMediaKitReady(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    if (!user) return;
    if (scope !== 'project' && !(movePanelOpen && bulkTarget === 'video_project')) return;
    let cancelled = false;
    const projectUrl = user.role === 'admin'
      ? '/api/projects?include_archived=true&include_all=true'
      : '/api/projects?include_archived=true';
    fetch(projectUrl, { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled) setProjects(data.projects || []);
      })
      .catch(() => {
        if (!cancelled) setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, [user, scope, movePanelOpen, bulkTarget]);

  useEffect(() => {
    if (!user || user.role !== 'admin' || scope !== 'user') return;
    let cancelled = false;
    fetch('/api/admin/users', { cache: 'no-store' })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        if (!cancelled && data) setUsers(data.users || []);
      })
      .catch(() => {
        if (!cancelled) setUsers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [user, scope]);

  useEffect(() => {
    if (!user || !movePanelOpen || bulkTarget !== 'album') return;
    let cancelled = false;
    fetch('/api/reference-albums?scope=all', { cache: 'no-store' })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        if (cancelled) return;
        const editableAlbums = ((data?.albums || []) as ReferenceAlbumItem[])
          .filter((album) => album.permissions?.edit && album.status !== 'deleted');
        setReferenceAlbums(editableAlbums);
        setTargetAlbumId((current) => (
          current && editableAlbums.some((album) => album.id === current)
            ? current
            : editableAlbums[0]?.id || ''
        ));
      })
      .catch(() => {
        if (!cancelled) setReferenceAlbums([]);
      });
    return () => {
      cancelled = true;
    };
  }, [user, movePanelOpen, bulkTarget]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const normalizedKeyword = keyword.trim();
    const cacheKey = createAssetLibraryCacheKey({
      view: assetView,
      userId: user.id,
      role: user.role,
      scope,
      type: requestType,
      enhance: enhanceFilter,
      includeUploads: showUploadedAssets,
      status,
      sort,
      groupBy,
      projectId,
      ownerUserId,
      keyword: normalizedKeyword,
      page,
    });
    setError('');
    setShowingCachedAssets(false);
    setSyncingAssets(true);
    setLoading(true);
    const params = new URLSearchParams({
      scope,
      type: requestType,
      status,
      sort,
      group_by: groupBy,
      page: String(page),
      limit: '60',
    });
    params.set('include_uploads', showUploadedAssets ? 'true' : 'false');
    if (enhanceFilter !== 'none') params.set('enhance', enhanceFilter);
    if (scope === 'project' && projectId) params.set('project_id', projectId);
    if (scope === 'user' && ownerUserId) params.set('owner_user_id', ownerUserId);
    if (normalizedKeyword) params.set('keyword', normalizedKeyword);

    void (async () => {
      let showedCache = false;
      let cached: { items: AssetLibraryItem[]; pagination: Pagination | null } | null = null;
      try {
        cached = await readAssetLibraryCache<AssetLibraryItem, Pagination>(cacheKey);
      } catch {
        cached = null;
      }
      if (cancelled) return;
      if (cached) {
        showedCache = true;
        const cachedItems = cached.items || [];
        setItems(cachedItems);
        setPagination(cached.pagination || null);
        setSelectedIds((current) => current.filter((id) => cachedItems.some((item) => item.id === id)));
        setShowingCachedAssets(true);
        setLoading(false);
      }

      try {
        const response = await fetch(`/api/assets/library?${params.toString()}`, { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || data.message || '资产加载失败');
        if (!cancelled) {
          const nextItems = (data.items || []) as AssetLibraryItem[];
          const nextPagination = (data.pagination || null) as Pagination | null;
          setItems(nextItems);
          setPagination(nextPagination);
          setSelectedIds((current) => current.filter((id) => nextItems.some((item) => item.id === id)));
          setShowingCachedAssets(false);
          void writeAssetLibraryCache<AssetLibraryItem, Pagination>({
            key: cacheKey,
            userId: user.id,
            payload: {
              items: nextItems.map(toCacheSafeAssetItem),
              pagination: nextPagination,
            },
          });
        }
      } catch (err) {
        if (!cancelled) {
          if (showedCache) {
            setError('最新资产同步失败，当前显示上次加载内容，可稍后重试。');
          } else {
            setItems([]);
            setPagination(null);
            setError(err instanceof Error ? err.message : '资产加载失败');
          }
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          setSyncingAssets(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, assetView, scope, requestType, enhanceFilter, showUploadedAssets, status, sort, groupBy, projectId, ownerUserId, keyword, page, reloadToken]);

  useEffect(() => {
    setDetailMediaAspectRatio(null);
  }, [activeItem?.id]);

  useEffect(() => {
    if (!moveProjectId) {
      setVideoCards([]);
      setMoveVideoCardId('');
      return;
    }
    let cancelled = false;
    fetch(`/api/projects/${moveProjectId}/video-cards`, { cache: 'no-store' })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        if (!cancelled) {
          const cards = (data?.video_cards || []).filter((card: VideoCardItem) => card.status !== 'sealed' && card.status !== 'archived');
          setVideoCards(cards);
          setMoveVideoCardId(cards[0]?.id || '');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setVideoCards([]);
          setMoveVideoCardId('');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [moveProjectId]);

  const setCardRef = (id: AssetLibraryItemId) => (node: HTMLDivElement | null) => {
    if (node) cardRefs.current.set(id, node);
    else cardRefs.current.delete(id);
  };

  const setSelection = (ids: AssetLibraryItemId[], nextAnchor?: AssetLibraryItemId | null) => {
    setSelectedIds(Array.from(new Set(ids)));
    if (nextAnchor !== undefined) setAnchorId(nextAnchor);
  };

  const toggleItem = (id: AssetLibraryItemId) => {
    setSelectedIds((current) => current.includes(id)
      ? current.filter((item) => item !== id)
      : [...current, id]);
    setAnchorId(id);
  };

  const selectRange = (id: AssetLibraryItemId) => {
    const flatIds = items.map((item) => item.id);
    const currentIndex = flatIds.indexOf(id);
    const anchorIndex = anchorId ? flatIds.indexOf(anchorId) : -1;
    if (currentIndex < 0 || anchorIndex < 0) {
      setSelection([id], id);
      return;
    }
    const start = Math.min(anchorIndex, currentIndex);
    const end = Math.max(anchorIndex, currentIndex);
    setSelection(Array.from(new Set([...selectedIds, ...flatIds.slice(start, end + 1)])), anchorId);
  };

  const handleCardClick = (event: React.MouseEvent, item: AssetLibraryItem) => {
    if (selectionMode || event.shiftKey || event.metaKey || event.ctrlKey) {
      if (!selectionMode) setSelectionMode(true);
      if (event.shiftKey) {
        selectRange(item.id);
      } else {
        toggleItem(item.id);
      }
      return;
    }
    setActiveItem(item);
  };

  const handleCardKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, item: AssetLibraryItem) => {
    if (event.target !== event.currentTarget) return;
    if (selectionMode && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      toggleItem(item.id);
      return;
    }
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    setActiveItem(item);
  };

  const handleSelectView = (nextView: AssetView) => {
    setAssetView(nextView);
    if (nextView !== 'project') setProjectId('');
    if (nextView !== 'user') setOwnerUserId('');
    if (nextView === 'enhance') {
      setType('video');
      setStatus('succeeded');
      setGroupBy('date');
    }
    setEnhanceMenuItemId(null);
    resetForFilterChange();
  };

  const currentAssetReturnTo = () => {
    if (typeof window === 'undefined') return '/assets?type=video';
    return `${window.location.pathname}${window.location.search || ''}`;
  };

  const enhanceEstimatedCost = (item: AssetLibraryItem) => {
    if (!item.duration) return null;
    return calculateEnhanceVideoEstimatedCostClient({
      duration: item.duration,
      resolution: enhanceResolution,
      toolVersion: 'standard',
      fps: enhanceFps === 'none' ? null : Number(enhanceFps),
    });
  };

  const enhanceDisabledReason = (item: AssetLibraryItem) => {
    if (aiMediaKitReady === null) return '正在检查配置';
    if (!aiMediaKitReady) return 'AI MediaKit 未就绪';
    if (!item.canEnhanceVideo) return '当前视频不可超分';
    if (!item.taskId) return '缺少源任务';
    if (!item.videoCardId) return '缺少视频卡';
    if (!item.duration) return '缺少时长';
    return '';
  };

  const createEnhanceTask = async (item: AssetLibraryItem) => {
    const disabledReason = enhanceDisabledReason(item);
    if (disabledReason || !item.taskId || enhanceSubmittingId) {
      if (disabledReason) setError(disabledReason);
      return;
    }
    setEnhanceSubmittingId(item.id);
    setError('');
    setMessage('');
    try {
      const selectedFps = enhanceFps === 'none' ? null : Number(enhanceFps);
      const response = await fetch('/api/tasks/enhance-video/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_task_id: item.taskId,
          video_card_id: item.videoCardId,
          tool_version: 'standard',
          scene: 'aigc',
          resolution: enhanceResolution,
          fps: selectedFps || undefined,
          duration: item.duration,
          idempotency_key: [
            'asset-enhance',
            item.taskId,
            enhanceResolution,
            selectedFps || 'source_fps',
          ].join(':'),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || data.error || '创建超分任务失败');
      }
      setMessage('已创建超分任务，正在打开对比页');
      setEnhanceMenuItemId(null);
      window.location.href = taskDetailHref(data.id, currentAssetReturnTo());
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建超分任务失败');
    } finally {
      setEnhanceSubmittingId(null);
    }
  };

  const beginTouchSelect = (item: AssetLibraryItem) => {
    if (!selectionMode) return;
    if (selectedIds.length > 0) return;
    if (touchTimer.current) clearTimeout(touchTimer.current);
    touchTimer.current = setTimeout(() => {
      setSelection([item.id], item.id);
    }, 420);
  };

  const clearTouchTimer = () => {
    if (touchTimer.current) {
      clearTimeout(touchTimer.current);
      touchTimer.current = null;
    }
  };

  const detectMarqueeIds = (startX: number, startY: number, currentX: number, currentY: number) => {
    const selectionRect = new DOMRect(
      Math.min(startX, currentX),
      Math.min(startY, currentY),
      Math.abs(currentX - startX),
      Math.abs(currentY - startY),
    );
    if (selectionRect.width < 4 && selectionRect.height < 4) return [];
    return items
      .filter((item) => {
        const node = cardRefs.current.get(item.id);
        return node ? intersects(selectionRect, node.getBoundingClientRect()) : false;
      })
      .map((item) => item.id);
  };

  const handleGridPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!selectionMode) return;
    if (event.button !== 0 || event.pointerType === 'touch') return;
    const target = event.target as HTMLElement;
    if (target.closest('[data-asset-card],button,a,input,select,textarea')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setMarquee({
      active: true,
      append: event.metaKey || event.ctrlKey,
      startX: event.clientX,
      startY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
      previewIds: [],
    });
  };

  const handleGridPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!marquee?.active) return;
    const previewIds = detectMarqueeIds(marquee.startX, marquee.startY, event.clientX, event.clientY);
    setMarquee({ ...marquee, currentX: event.clientX, currentY: event.clientY, previewIds });
  };

  const handleGridPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!marquee?.active) return;
    const previewIds = marquee.previewIds;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (previewIds.length > 0) {
      setSelection(marquee.append ? [...selectedIds, ...previewIds] : previewIds, previewIds[previewIds.length - 1]);
    } else if (!marquee.append && Math.abs(marquee.currentX - marquee.startX) + Math.abs(marquee.currentY - marquee.startY) > 8) {
      clearSelection();
    }
    setMarquee(null);
  };

  const downloadTaskIds = async (taskIds: string[]) => {
    if (taskIds.length === 0) {
      setError('当前选择里没有可下载的视频');
      return;
    }
    if (taskIds.length > BULK_VIDEO_DOWNLOAD_CLIENT_LIMIT) {
      setError(`第一版最多一次打包 ${BULK_VIDEO_DOWNLOAD_CLIENT_LIMIT} 个视频`);
      return;
    }
    setBulkDownloading(true);
    setError('');
    setMessage('');
    try {
      const result = await downloadBulkVideoZip({ taskIds });
      setMessage(`已开始下载视频包：${result.success} 个成功${result.failed ? `，${result.failed} 个失败见 manifest` : ''}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '批量下载失败');
    } finally {
      setBulkDownloading(false);
    }
  };

  const prepareStableDownload = async (taskId: string) => {
    setPreparingDownloadTaskId(taskId);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/video/download/${taskId}`, {
        method: 'POST',
        cache: 'no-store',
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 202) {
        setMessage(data.message || '视频已生成，正在准备稳定下载文件。');
        return;
      }
      if (!response.ok || data.success === false) {
        throw new Error(data.message || data.error || '稳定下载准备失败');
      }
      if (data.public_video_url) {
        setMessage('稳定下载已就绪，可以下载视频。');
        void reloadItems();
        return;
      }
      setMessage(data.message || '下载准备请求已提交。');
      void reloadItems();
    } catch (err) {
      setError(err instanceof Error ? err.message : '稳定下载准备失败');
    } finally {
      setPreparingDownloadTaskId(null);
    }
  };

  const handleDownload = async () => {
    await downloadTaskIds(downloadableTaskIds);
  };

  const downloadSingleVideo = (item: AssetLibraryItem) => {
    if (!item.taskId) {
      setError('当前资产缺少可下载的视频任务');
      return;
    }
    const anchor = document.createElement('a');
    anchor.href = `/api/video/download/${item.taskId}`;
    anchor.download = `seedance-${item.taskId}.mp4`;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setMessage('已开始下载视频。');
  };

  const rememberBulkTarget = (target: AssetBulkTarget) => {
    setBulkTarget(target);
    try {
      window.localStorage.setItem(ASSET_BULK_TARGET_STORAGE_KEY, target);
    } catch {
      // 偏好保存失败不影响当次操作。
    }
  };

  const updateTargetAlbum = (albumId: string) => {
    setTargetAlbumId(albumId);
    try {
      window.localStorage.setItem(ASSET_BULK_ALBUM_STORAGE_KEY, albumId);
    } catch {
      // 偏好保存失败不影响当次操作。
    }
  };

  const handleAddImagesToWorkspace = async () => {
    if (reusableImageItems.length === 0) {
      setError('当前选择里没有可加入工作区的图片或参考素材');
      return;
    }
    setMoving(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/workspace/assets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tab-id': getOrCreateWorkspaceTabId(),
        },
        body: JSON.stringify({
          assetIds: reusableAssetIds,
          referenceImageIds: reusableReferenceImageIds,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || '加入工作区失败');
      setMessage(`已加入生成工作区：${data.workspaceAssetIds?.length || reusableImageItems.length} 张参考图`);
      clearSelection();
    } catch (err) {
      setError(err instanceof Error ? err.message : '加入工作区失败');
    } finally {
      setMoving(false);
    }
  };

  const handleAddImagesToAlbum = async () => {
    if (reusableImageItems.length === 0) {
      setError('当前选择里没有可加入图集的图片或参考素材');
      return;
    }
    if (!targetAlbumId) {
      setError('请选择目标图集');
      return;
    }
    setMoving(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/reference-albums/${targetAlbumId}/images`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assetIds: reusableAssetIds,
          referenceImageIds: reusableReferenceImageIds,
          source_type: 'copied',
          metadata_json: { source: 'asset_library_bulk_add' },
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || '加入图集失败');
      setMessage(`已加入图集：${data.images?.length || reusableImageItems.length} 张图片`);
      clearSelection();
      setReloadToken((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加入图集失败');
    } finally {
      setMoving(false);
    }
  };

  const handleBulkMove = async () => {
    if (movableItemIds.length === 0) {
      setError('当前选择里没有可移动的视频任务');
      return;
    }
    if (!moveProjectId || !moveVideoCardId) {
      setError('请选择目标项目和视频卡');
      return;
    }
    setMoving(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/assets/library/bulk-move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          item_ids: movableItemIds,
          target_project_id: moveProjectId,
          target_video_card_id: moveVideoCardId,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || '批量移动失败');
      setMessage(`批量移动完成：移动 ${data.moved || 0} 个，跳过 ${data.unchanged || 0} 个，失败 ${data.failed || 0} 个`);
      clearSelection();
      setPage(1);
      setReloadToken((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : '批量移动失败');
    } finally {
      setMoving(false);
    }
  };

  const reloadItems = () => {
    setReloadToken((value) => value + 1);
  };

  const updateCardSize = (value: AssetCardSize) => {
    setCardSize(value);
    try {
      window.localStorage.setItem(ASSET_CARD_SIZE_STORAGE_KEY, value);
    } catch {
      // localStorage 可能被浏览器隐私设置禁用，不影响本次页面内切换。
    }
  };

  const updateShowUploadedAssets = (value: boolean) => {
    setShowUploadedAssets(value);
    if (!value) {
      setAssetUploadFile(null);
      setAssetUploadProgress(null);
      if (assetUploadInputRef.current) assetUploadInputRef.current.value = '';
    }
    try {
      window.localStorage.setItem(ASSET_SHOW_UPLOADS_STORAGE_KEY, value ? 'true' : 'false');
    } catch {
      // 偏好保存失败不影响当次开关状态。
    }
    resetForFilterChange();
  };

  const handleAssetUploadFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] || null;
    setAssetUploadFile(file);
    setAssetUploadProgress(null);
    setError('');
    setMessage(file ? `已选择${assetUploadTypeLabel(file)}：${file.name}` : '');
  };

  const handleAssetUpload = async () => {
    if (!assetUploadFile) {
      assetUploadInputRef.current?.click();
      return;
    }
    setAssetUploading(true);
    setError('');
    setMessage('');
    setAssetUploadProgress({
      label: '准备上传',
      detail: `${assetUploadFile.name} · ${formatAssetUploadBytes(assetUploadFile.size)}`,
    });
    try {
      const selectedFile = assetUploadFile;
      const uploadedAsset = await uploadFileAsAsset(selectedFile, {
        invalidJsonMessage: '素材上传服务返回了页面内容，请刷新后重试；如果仍出现，请重新登录。',
        onProgress: (progress) => {
          setAssetUploadProgress(buildAssetLibraryUploadProgress(selectedFile, progress));
        },
      });
      const nextType = assetLibraryTypeFromFile(selectedFile);
      setAssetView('history');
      setType(nextType);
      setStatus('succeeded');
      updateShowUploadedAssets(true);
      setPage(1);
      setKeyword('');
      setKeywordDraft('');
      clearSelection();
      setMessage(`${assetUploadTypeLabel(selectedFile)}上传成功，正在刷新资产列表。${uploadedAsset.reused ? '已复用相同素材。' : ''}`);
      setAssetUploadFile(null);
      setAssetUploadProgress({
        label: uploadedAsset.reused ? '已复用相同素材' : '上传完成',
        detail: uploadedAsset.fileName || selectedFile.name,
        percent: 100,
      });
      if (assetUploadInputRef.current) assetUploadInputRef.current.value = '';
      setReloadToken((value) => value + 1);
    } catch (err) {
      setAssetUploadProgress(null);
      setError(err instanceof Error ? err.message : '素材上传失败，请重新选择后重试');
    } finally {
      setAssetUploading(false);
    }
  };

  const marqueeRect = marquee
    ? rectFromPoints({ x: marquee.startX, y: marquee.startY }, { x: marquee.currentX, y: marquee.currentY })
    : null;

  return (
    <div className="asset-library-page">
      <header className="asset-library-header">
        <div>
          <div className="asset-library-eyebrow">Asset Library</div>
          <h1>资产管理</h1>
          <p>按生产历史、项目和用户查看视频资产，支持框选、多选、批量下载、加入工作区、加入图集和移动视频。</p>
        </div>
        <div className="asset-library-header-actions">
          <button className="asset-library-icon-button" type="button" onClick={reloadItems} aria-label="刷新资产">
            <RefreshCcw size={16} />
          </button>
          <button
            className={`asset-library-secondary-link asset-library-select-toggle ${selectionMode ? 'active' : ''}`}
            type="button"
            aria-pressed={selectionMode}
            onClick={toggleSelectionMode}
          >
            <CheckSquare size={15} />
            {selectionMode ? '退出选择' : '选择'}
          </button>
          <Link className="asset-library-secondary-link" href="/tasks">任务列表</Link>
        </div>
      </header>

      <section className="asset-library-tabs" aria-label="资产分类">
        {assetViewTabs.filter((tab) => !tab.adminOnly || isAdmin).map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`${assetView === tab.id ? 'active' : ''} ${tab.tone === 'enhance' ? 'asset-library-tab-enhance' : ''}`.trim()}
            onClick={() => handleSelectView(tab.id)}
          >
            {tab.tone === 'enhance' && <Sparkles size={13} aria-hidden="true" />}
            {tab.label}
          </button>
        ))}
      </section>

      <section className="asset-library-filter-bar">
        {isEnhanceView ? (
          <div className="asset-library-view-chip">
            <Sparkles size={14} aria-hidden="true" />
            视频超分
          </div>
        ) : (
          <div className="asset-library-type-tabs">
            {typeTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={type === tab.id ? 'active' : ''}
                onClick={() => {
                  setType(tab.id);
                  resetForFilterChange();
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}

        {!isEnhanceView && (
          <button
            type="button"
            className={`asset-library-source-toggle ${showUploadedAssets ? 'active' : ''}`}
            aria-pressed={showUploadedAssets}
            title="打开后显示自己上传的图片、视频和音频素材"
            onClick={() => updateShowUploadedAssets(!showUploadedAssets)}
          >
            <Upload size={14} aria-hidden="true" />
            <span>上传素材</span>
          </button>
        )}

        <form
          className="asset-library-search"
          onSubmit={(event) => {
            event.preventDefault();
            setKeyword(keywordDraft.trim());
            resetForFilterChange();
          }}
        >
          <Search size={15} />
          <input
            value={keywordDraft}
            onChange={(event) => setKeywordDraft(event.target.value)}
            placeholder="搜索 prompt、任务、项目或用户"
          />
        </form>

        <div className="asset-library-size-toggle" role="group" aria-label="资产卡片尺寸">
          <span>尺寸</span>
          {cardSizeOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              className={cardSize === option.id ? 'active' : ''}
              title={option.title}
              aria-pressed={cardSize === option.id}
              onClick={() => updateCardSize(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <select
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as AssetStatus);
            resetForFilterChange();
          }}
        >
          {statusOptions.filter((option) => !option.adminOnly || isAdmin).map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>

        {scope === 'project' && (
          <select
            value={projectId}
            onChange={(event) => {
              setProjectId(event.target.value);
              resetForFilterChange();
            }}
          >
            <option value="">全部项目</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
        )}

        {scope === 'user' && isAdmin && (
          <select
            value={ownerUserId}
            onChange={(event) => {
              setOwnerUserId(event.target.value);
              resetForFilterChange();
            }}
          >
            <option value="">全部用户</option>
            {users.map((item) => (
              <option key={item.id} value={item.id}>{item.name || item.email || item.username}</option>
            ))}
          </select>
        )}

        <select
          value={groupBy}
          onChange={(event) => {
            setGroupBy(event.target.value as AssetGroup);
            clearSelection();
          }}
        >
          {groupOptions.filter((option) => !option.adminOnly || isAdmin).map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>

        <select
          value={sort}
          onChange={(event) => {
            setSort(event.target.value as AssetSort);
            resetForFilterChange();
          }}
        >
          {sortOptions.filter((option) => !option.adminOnly || isAdmin).map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>
      </section>

      {showUploadedAssets && (
        <section className="asset-library-upload-panel" aria-label="上传素材到资产库">
          <input
            ref={assetUploadInputRef}
            type="file"
            accept="image/*,video/*,audio/*"
            className="asset-library-upload-input"
            onChange={handleAssetUploadFileChange}
          />
          <div className="asset-library-upload-copy">
            <strong>上传素材</strong>
            <span>
              {assetUploadFile
                ? `${assetUploadTypeLabel(assetUploadFile)} · ${assetUploadFile.name} · ${formatAssetUploadBytes(assetUploadFile.size)}`
                : '支持图片、视频、音频上传；音频最大 15MB。生成前会按当前模型规则检查时长、格式和分辨率。'}
            </span>
          </div>
          {assetUploadProgress && (
            <UploadProgressIndicator
              label={assetUploadProgress.label}
              detail={assetUploadProgress.detail}
              percent={assetUploadProgress.percent}
              variant="dark"
              className="asset-library-upload-progress"
            />
          )}
          <div className="asset-library-upload-actions">
            <button type="button" onClick={() => assetUploadInputRef.current?.click()} disabled={assetUploading}>
              选择文件
            </button>
            <button type="button" className="primary" onClick={handleAssetUpload} disabled={assetUploading}>
              <Upload size={15} aria-hidden="true" />
              {assetUploading ? '上传中...' : assetUploadFile ? '开始上传' : '上传素材'}
            </button>
          </div>
        </section>
      )}

      {(message || error) && (
        <div className={`asset-library-notice ${error ? 'error' : 'success'}`}>
          <span>{error || message}</span>
          <button type="button" onClick={() => { setError(''); setMessage(''); }} aria-label="关闭提示">
            <X size={14} />
          </button>
        </div>
      )}

      {syncingAssets && showingCachedAssets && !error && (
        <div className="asset-library-sync-note" aria-live="polite">
          正在同步最新资产，当前先显示上次加载内容。
        </div>
      )}

      {selectedIds.length > 0 && (
        <section className="asset-library-bulkbar">
          <div>
            <strong>已选 {selectedIds.length} 个</strong>
            <span>
              可下载 {downloadableTaskIds.length} 个，可移动视频 {movableItemIds.length} 个，可加入参考 {reusableImageItems.length} 个，涉及项目 {new Set(selectedItems.map((item) => item.project?.id || 'unassigned')).size} 个
              {isAdmin ? `，涉及用户 ${new Set(selectedItems.map((item) => item.owner?.id || 'unknown')).size} 位` : ''}
            </span>
          </div>
          <div className="asset-library-bulkbar-actions">
            <button type="button" onClick={clearSelection}>取消选择</button>
            <button type="button" onClick={handleDownload} disabled={bulkDownloading || downloadableTaskIds.length === 0}>
              <Download size={15} />
              下载视频（{downloadableTaskIds.length}/{selectedIds.length}）
            </button>
            <button type="button" onClick={handleAddImagesToWorkspace} disabled={moving || reusableImageItems.length === 0}>
              <ImagePlus size={15} />
              加入工作区（{reusableImageItems.length}/{selectedIds.length}）
            </button>
            <button
              type="button"
              onClick={() => {
                rememberBulkTarget('album');
                setMovePanelOpen((value) => bulkTarget === 'album' ? !value : true);
              }}
              disabled={reusableImageItems.length === 0}
            >
              <FolderPlus size={15} />
              加入图集
            </button>
            <button
              type="button"
              onClick={() => {
                rememberBulkTarget('video_project');
                setMovePanelOpen((value) => bulkTarget === 'video_project' ? !value : true);
              }}
              disabled={movableItemIds.length === 0}
            >
              <FolderInput size={15} />
              移动视频
            </button>
          </div>
        </section>
      )}

      {movePanelOpen && selectedIds.length > 0 && bulkTarget === 'video_project' && (
        <section className="asset-library-move-panel">
          <div>
            <strong>移动视频任务</strong>
            <span>需要选择目标项目和该项目下的视频卡。</span>
          </div>
          <select value={moveProjectId} onChange={(event) => setMoveProjectId(event.target.value)}>
            <option value="">选择目标项目</option>
            {manageableProjects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
          <select value={moveVideoCardId} onChange={(event) => setMoveVideoCardId(event.target.value)} disabled={!moveProjectId || videoCards.length === 0}>
            <option value="">选择目标视频卡</option>
            {videoCards.map((card) => (
              <option key={card.id} value={card.id}>{card.title}</option>
            ))}
          </select>
          <button type="button" onClick={handleBulkMove} disabled={moving || !moveProjectId || !moveVideoCardId}>
            {moving ? '移动中...' : '确认移动'}
          </button>
        </section>
      )}

      {movePanelOpen && selectedIds.length > 0 && bulkTarget === 'album' && (
        <section className="asset-library-move-panel asset-library-album-panel">
          <div>
            <strong>加入参考图集</strong>
            <span>只复制图片引用，不删除原资产；仅显示你可编辑的图集。</span>
          </div>
          {referenceAlbums.length > 0 ? (
            <div className="asset-library-target-list" role="listbox" aria-label="选择目标图集">
              {referenceAlbums.map((album) => {
                const active = targetAlbumId === album.id;
                return (
                  <button
                    key={album.id}
                    type="button"
                    className={active ? 'active' : ''}
                    aria-selected={active}
                    role="option"
                    onClick={() => updateTargetAlbum(album.id)}
                  >
                    <strong>{album.name}</strong>
                    <span>{album.project?.name || (album.album_type === 'personal' ? '个人图集' : '可编辑图集')} · {album.image_count} 张</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <span>暂无可编辑图集，请先到参考图集创建或取得编辑权限。</span>
          )}
          <button type="button" onClick={handleAddImagesToAlbum} disabled={moving || reusableImageItems.length === 0 || !targetAlbumId}>
            {moving ? '加入中...' : '确认加入图集'}
          </button>
        </section>
      )}

      <main
        className={`asset-library-content ${selectionMode ? 'is-selecting' : ''}`}
        onPointerDown={handleGridPointerDown}
        onPointerMove={handleGridPointerMove}
        onPointerUp={handleGridPointerUp}
      >
        {loading && (
          <div className="asset-library-empty">
            <h2>正在加载资产</h2>
            <p>正在读取可见视频、项目和权限信息。</p>
          </div>
        )}

        {!loading && items.length === 0 && (
          <div className="asset-library-empty">
            <h2>暂无资产</h2>
            <p>{isEnhanceView ? '当前没有可超分视频或超分结果，完成视频生成后会自动出现在这里。' : '调整筛选条件，或先到生成页创建视频。'}</p>
            <Link href="/generate">去生成视频</Link>
          </div>
        )}

        {!loading && groupedItems.map((group) => (
          <section key={group.key} className="asset-library-group">
            <h2>
              {groupBy === 'user' ? (
                <UserIdentityBadge
                  user={group.owner}
                  size="sm"
                  subtitle={group.owner?.subtitle || null}
                  className="asset-library-group-owner"
                />
              ) : (
                group.label
              )}
            </h2>
            <div className={`asset-library-grid asset-library-grid-${cardSize}`}>
              {group.items.map((item) => {
                const selected = selectedSet.has(item.id);
                const previewed = previewSet.has(item.id);
                const duration = formatDuration(item.duration);
                const specText = formatAssetSpec(item);
                const enhanceMenuOpen = enhanceMenuItemId === item.id;
                const enhanceReason = enhanceMenuOpen ? enhanceDisabledReason(item) : '';
                const estimatedEnhanceCost = enhanceMenuOpen ? enhanceEstimatedCost(item) : null;
                const enhanceStateLabel = item.isEnhanceTask ? '超分结果' : '';
                return (
                  <div
                    key={item.id}
                    ref={setCardRef(item.id)}
                    data-asset-card="true"
                    role="button"
                    tabIndex={0}
                    className={`asset-card asset-card-${cardSize} ${selectionMode ? 'selection-mode' : ''} ${selected ? 'selected' : ''} ${previewed ? 'preview-selected' : ''} ${item.isEnhanceTask ? 'asset-card-enhance-result' : ''} ${enhanceMenuOpen ? 'enhance-menu-open' : ''}`}
                    onClick={(event) => handleCardClick(event, item)}
                    onKeyDown={(event) => handleCardKeyDown(event, item)}
                    onPointerDown={(event) => {
                      if (event.pointerType === 'touch') beginTouchSelect(item);
                    }}
                    onPointerUp={clearTouchTimer}
                    onPointerCancel={clearTouchTimer}
                  >
                    {(selectionMode || selected) && (
                      <button
                        type="button"
                        className="asset-card-check"
                        aria-label={selected ? '取消选择资产' : '选择资产'}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleItem(item.id);
                        }}
                      >
                        {selected ? '✓' : ''}
                      </button>
                    )}
                    <span className="asset-card-media">
                      {item.kind === 'audio' ? (
                        <span className="asset-card-audio-placeholder">
                          <span>音频</span>
                          <small>{item.fileSize ? formatAssetUploadBytes(item.fileSize) : '参考音频'}</small>
                        </span>
                      ) : item.thumbnailUrl ? (
                        <img src={item.thumbnailUrl} alt={item.title} loading="lazy" />
                      ) : (
                        <span className="asset-card-empty">{mediaFallbackLabel(item)}</span>
                      )}
                      {enhanceStateLabel && (
                        <span className="asset-card-badge asset-card-badge-enhance">
                          <Sparkles size={12} aria-hidden="true" />
                          {enhanceStateLabel}
                        </span>
                      )}
                      {duration && <span className="asset-card-duration">{duration}</span>}
                      <span className="asset-card-hover">
                        <button
                          type="button"
                          className="asset-card-hover-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setActiveItem(item);
                          }}
                        >
                          <Eye size={16} aria-hidden="true" />
                          查看
                        </button>
                      </span>
                    </span>
                    <div className="asset-card-meta">
                      <div className="asset-card-title-row">
                        <strong>{shortText(item.title, '未命名资产', 34)}</strong>
                        {item.canEnhanceVideo && (
                          <div
                            className="asset-card-enhance-shell"
                            onClick={(event) => event.stopPropagation()}
                            onPointerDown={(event) => event.stopPropagation()}
                          >
                            <button
                              type="button"
                              className="asset-card-enhance-trigger"
                              onClick={() => {
                                setEnhanceMenuItemId((current) => current === item.id ? null : item.id);
                              }}
                            >
                              <Sparkles size={14} aria-hidden="true" />
                              <span>超分</span>
                            </button>
                            {enhanceMenuOpen && (
                              <div className="asset-card-enhance-menu">
                                <label>
                                  <span>分辨率</span>
                                  <select
                                    value={enhanceResolution}
                                    onChange={(event) => setEnhanceResolution(event.target.value as EnhanceResolution)}
                                  >
                                    <option value="720p">720p</option>
                                    <option value="1080p">1080p</option>
                                    <option value="2k">2K</option>
                                    <option value="4k">4K</option>
                                  </select>
                                </label>
                                <label>
                                  <span>帧率</span>
                                  <select
                                    value={enhanceFps}
                                    onChange={(event) => setEnhanceFps(event.target.value as EnhanceFps)}
                                  >
                                    <option value="none">不插帧</option>
                                    <option value="30">30 fps</option>
                                    <option value="60">60 fps</option>
                                  </select>
                                </label>
                                <span className="asset-card-enhance-cost">
                                  预估冻结 {estimatedEnhanceCost === null ? '-' : `${estimatedEnhanceCost} 点`}
                                </span>
                                {enhanceReason && <span className="asset-card-enhance-warning">{enhanceReason}</span>}
                                <button
                                  type="button"
                                  onClick={() => void createEnhanceTask(item)}
                                  disabled={Boolean(enhanceReason) || enhanceSubmittingId === item.id}
                                >
                                  {enhanceSubmittingId === item.id ? '创建中...' : '开始超分'}
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                        {shouldShowDeliveryStage(item) && item.deliveryStage?.key === 'ready' && item.taskId && (
                          <button
                            type="button"
                            className="asset-card-download-action"
                            data-tooltip={deliveryStatsTooltip(item)}
                            aria-label={`${shortText(item.title, '视频', 24)} 下载；${deliveryStatsTooltip(item).replace(/\n/g, '；')}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              downloadSingleVideo(item);
                            }}
                          >
                            <Download size={12} aria-hidden="true" />
                            <span>下载</span>
                          </button>
                        )}
                      </div>
                      {enhanceStateLabel && (
                        <span className="asset-card-enhance-note is-result">
                          AI MediaKit 超分结果
                        </span>
                      )}
                      {shouldShowDeliveryStage(item) && item.deliveryStage?.key !== 'ready' && (
                        <span className={deliveryStageClassName(item.deliveryStage)}>
                          {item.deliveryStage?.label}
                        </span>
                      )}
                      {specText && <span className="asset-card-spec">{specText}</span>}
                      <span>{item.project?.name || '未归属项目'} · {formatDateTime(item.createdAt)}</span>
                      {isAdmin && item.owner && (
                        <UserIdentityBadge
                          user={item.owner}
                          size="sm"
                          className="asset-card-user"
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))}

        {pagination && pagination.total_pages > 1 && (
          <div className="asset-library-pagination">
            <span>第 {pagination.page} / {pagination.total_pages} 页，共 {pagination.total} 个资产</span>
            <div>
              <button type="button" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
                上一页
              </button>
              <button type="button" disabled={!pagination.has_more} onClick={() => setPage((value) => value + 1)}>
                下一页
              </button>
            </div>
          </div>
        )}
      </main>

      {marqueeRect && (
        <div
          className="asset-library-marquee"
          style={{
            left: marqueeRect.left,
            top: marqueeRect.top,
            width: marqueeRect.width,
            height: marqueeRect.height,
          }}
        />
      )}

      {activeItem && (
        <aside className="asset-detail-drawer" aria-label="资产详情">
          <div className="asset-detail-header">
            <div>
              <span>{activeItem.isEnhanceTask ? '超分视频资产' : activeItem.kind === 'video' ? '视频资产' : activeItem.kind === 'audio' ? '音频资产' : '图片资产'}</span>
              <h2>{shortText(activeItem.title, '资产详情', 42)}</h2>
            </div>
            <button type="button" onClick={() => setActiveItem(null)} aria-label="关闭详情">
              <X size={18} />
            </button>
          </div>
          <div
            className={`asset-detail-preview asset-detail-preview-${activeItem.kind} ${activePreviewIsPortrait ? 'is-portrait' : ''}`}
          >
            {activeItem.isEnhanceTask && (
              <span className="asset-detail-preview-badge">
                <Sparkles size={12} aria-hidden="true" />
                超分
              </span>
            )}
            {activeItem.kind === 'video' && activeItem.previewUrl ? (
              <video
                src={activeItem.previewUrl}
                controls
                preload="metadata"
                poster={activeItem.thumbnailUrl || undefined}
                onLoadedMetadata={(event) => {
                  const ratio = aspectRatioFromDimensions(
                    event.currentTarget.videoWidth,
                    event.currentTarget.videoHeight,
                  );
                  if (ratio) setDetailMediaAspectRatio(ratio);
                }}
              />
            ) : activeItem.kind === 'audio' && activeItem.previewUrl ? (
              <div className="asset-detail-audio-player">
                <span>音频素材</span>
                <audio src={activeItem.previewUrl} controls preload="metadata" />
              </div>
            ) : activeItem.thumbnailUrl ? (
              <img
                src={activeItem.thumbnailUrl}
                alt={activeItem.title}
                onLoad={(event) => {
                  const ratio = aspectRatioFromDimensions(
                    event.currentTarget.naturalWidth,
                    event.currentTarget.naturalHeight,
                  );
                  if (ratio) setDetailMediaAspectRatio(ratio);
                }}
              />
            ) : (
              <div>{mediaFallbackLabel(activeItem)}</div>
            )}
          </div>
          <dl className="asset-detail-list">
            <div>
              <dt>状态</dt>
              <dd>{statusLabel(activeItem.status)}</dd>
            </div>
            {shouldShowDeliveryStage(activeItem) && (
              <div>
                <dt>稳定下载</dt>
                <dd>{activeItem.deliveryStage?.label || '-'}</dd>
              </div>
            )}
            <div>
              <dt>项目</dt>
              <dd>{activeItem.project?.name || '未归属项目'}</dd>
            </div>
            {isAdmin && (
              <div>
                <dt>用户</dt>
                <dd>
                  <UserIdentityBadge
                    user={activeItem.owner}
                    size="sm"
                    subtitle={activeItem.owner?.subtitle || null}
                    className="asset-detail-user"
                  />
                </dd>
              </div>
            )}
            <div>
              <dt>规格</dt>
              <dd>{formatAssetSpec(activeItem) || '-'}</dd>
            </div>
            <div>
              <dt>创建时间</dt>
              <dd>{formatDateTime(activeItem.createdAt)}</dd>
            </div>
            <div>
              <dt>完成时间</dt>
              <dd>{formatDateTime(activeItem.completedAt)}</dd>
            </div>
          </dl>
          {activeItem.prompt && (
            <div className="asset-detail-prompt">
              <span>Prompt</span>
              <p>{activeItem.prompt}</p>
            </div>
          )}
          <div className="asset-detail-actions">
            {activeItem.taskId && (
              <Link href={`/tasks/${activeItem.taskId}`}>打开任务详情</Link>
            )}
            {activeItem.taskId && activeItem.kind === 'video' && isFastPathAssetVideo(activeItem) && !activeItem.stableDownloadReady && activeItem.previewAvailable && (
              <button
                type="button"
                onClick={() => void prepareStableDownload(activeItem.taskId as string)}
                disabled={preparingDownloadTaskId === activeItem.taskId}
              >
                {preparingDownloadTaskId === activeItem.taskId ? '提交中...' : activeItem.deliveryStage?.key === 'failed' ? '重试稳定下载' : '准备稳定下载'}
              </button>
            )}
            {activeItem.downloadable && (!isFastPathAssetVideo(activeItem) || activeItem.stableDownloadReady) && (
              <button type="button" onClick={() => {
                if (activeItem.taskId) void downloadTaskIds([activeItem.taskId]);
              }}>
                下载视频
              </button>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}

export default function AssetsPage() {
  return (
    <Suspense fallback={<div className="asset-library-page" aria-busy="true">资产管理加载中...</div>}>
      <AssetsPageContent />
    </Suspense>
  );
}
