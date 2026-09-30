'use client';
import ContentReactions from '@/components/content-reactions/ContentReactions';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { createPortal } from 'react-dom';
import { Eye } from 'lucide-react';
import { UploadProgressIndicator } from '@/components/UploadProgressIndicator';
import MediaPreview from '@/components/MediaPreview';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';
import { UploadedImagePickerAlbums } from '@/components/UploadedImagePickerAlbums';
import { readJsonResponse } from '@/lib/http/json-response';
import type { UploadProgressHandler, UploadProgressSnapshot } from '@/lib/http/file-upload';
import type { AssetType } from '@/types';

interface UploadedAssetItem {
  id: string;
  type: AssetType;
  originalUrl: string;
  thumbnailUrl: string | null;
  fileName: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  fileSize: number;
  createdAt: string;
}

/** Picker selections carry Asset.id values; they are never ReferenceImage.id values. */
export type UploadedAssetSelection = {
  id: string;
  type: AssetType;
  originalUrl?: string;
  thumbnailUrl?: string | null;
  fileName?: string;
  width?: number | null;
  height?: number | null;
};

interface Props {
  imageOnly?: boolean;
  selectionOnly?: boolean;
  maxSelection?: number;
  open: boolean;
  currentCount: number;
  currentAssetIds: string[];
  /** Mount inside an existing native dialog so the picker stays in its top layer. */
  portalContainer?: Element | null;
  onClose: () => void;
  onUploadFile: (file: File, onProgress?: UploadProgressHandler) => Promise<string>;
  onConfirm: (assetIds: string[], assets?: UploadedAssetSelection[]) => Promise<void>;
}

type HistoryListResponse = {
  assets?: UploadedAssetItem[];
  pagination?: {
    page?: number;
    has_more?: boolean;
  };
  error?: string;
  message?: string;
};

type ApiMessageResponse = {
  error?: string;
  message?: string;
};

type PickerUploadProgress = {
  label: string;
  detail: string;
  percent?: number;
};

type PendingPickerAttach = {
  assetIds: string[];
  assets: UploadedAssetSelection[];
  detail: string;
};

const PAGE_SIZE = 40;
const HISTORY_INVALID_JSON_MESSAGE = '历史素材服务返回了页面内容，请刷新后重试；如果仍出现，请重新登录。';

function UploadedAssetThumbnail({ item }: { item: UploadedAssetItem }) {
  const [failed, setFailed] = useState(false);
  const src = item.type === 'image'
    ? item.thumbnailUrl || item.originalUrl
    : item.thumbnailUrl && item.thumbnailUrl !== item.originalUrl ? item.thumbnailUrl : null;
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) return <span className="uploaded-picker-media-placeholder">{item.type === 'image' ? '预览不可用' : `${assetTypeLabel(item.type)} · 暂无封面`}</span>;
  return <img src={src} alt={item.fileName} loading="lazy" onError={() => setFailed(true)} />;
}

function isSupportedReferenceFile(file: File) {
  return file.type.startsWith('image/') || file.type.startsWith('video/') || file.type.startsWith('audio/');
}

function assetTypeFromFile(file: File): AssetType {
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return 'image';
}

function assetTypeLabel(type: AssetType) {
  if (type === 'video') return '视频';
  if (type === 'audio') return '音频';
  return '图片';
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

function buildPickerUploadProgress(
  file: File,
  fileIndex: number,
  fileCount: number,
  progress: UploadProgressSnapshot,
): PickerUploadProgress {
  const filePrefix = fileCount > 1 ? `${fileIndex + 1}/${fileCount} ` : '';
  return {
    label: `${filePrefix}${progress.label}`,
    detail: file.name,
    ...(progress.percent != null ? { percent: progress.percent } : {}),
  };
}

export function UploadedImagePicker({
  imageOnly = false,
  selectionOnly = false,
  maxSelection,
  open,
  currentCount,
  currentAssetIds,
  portalContainer,
  onClose,
  onUploadFile,
  onConfirm,
}: Props) {
  const [items, setItems] = useState<UploadedAssetItem[]>([]);
  const [source, setSource] = useState<'all' | 'generated' | 'uploaded' | 'albums'>('all');
  const loadSequence = useRef(0);
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
  const [selectedAssetsById, setSelectedAssetsById] = useState<Record<string, UploadedAssetSelection>>({});
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<PickerUploadProgress | null>(null);
  const [deletingAssetId, setDeletingAssetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewAsset, setPreviewAsset] = useState<UploadedAssetItem | null>(null);
  const [pendingAttach, setPendingAttach] = useState<PendingPickerAttach | null>(null);
  const [confirmFailed, setConfirmFailed] = useState(false);
  const [nativeDialogContainer, setNativeDialogContainer] = useState<Element | null>(null);
  const [portalResolutionComplete, setPortalResolutionComplete] = useState(false);
  const previewReturnDialog = useRef<HTMLDialogElement | null>(null);
  const openRef = useRef(open);
  const fileInputRef = useRef<HTMLInputElement>(null);
  openRef.current = open;

  const currentAssetIdSet = useMemo(() => new Set(currentAssetIds), [currentAssetIds]);
  const selectedAssets = useMemo(
    () => selectedAssetIds.map((id) => selectedAssetsById[id]).filter((asset): asset is UploadedAssetSelection => Boolean(asset)),
    [selectedAssetIds, selectedAssetsById],
  );
  void currentCount;

  const loadPage = useCallback(async (targetPage: number, mode: 'replace' | 'append' = 'replace') => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        type: imageOnly ? 'image' : 'all',
        source: imageOnly && source !== 'albums' ? source : 'all',
        page: String(targetPage),
        limit: String(PAGE_SIZE),
      });
      const res = await fetch(`/api/assets/history?${params.toString()}`, { cache: 'no-store' });
      const data = await readJsonResponse<HistoryListResponse>(res, {
        invalidJsonMessage: HISTORY_INVALID_JSON_MESSAGE,
      });
      if (!res.ok) throw new Error(data.error || data.message || '历史素材读取失败');
      if (sequence !== loadSequence.current) return;
      const nextItems: UploadedAssetItem[] = data.assets || [];
      setItems((current) => {
        if (mode === 'replace') return nextItems;
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...nextItems.filter((item) => !seen.has(item.id))];
      });
      setPage(data.pagination?.page || targetPage);
      setHasMore(Boolean(data.pagination?.has_more));
    } catch (err) {
      if (sequence !== loadSequence.current) return;
      setError(err instanceof Error ? err.message : '历史素材读取失败');
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [imageOnly, source]);

  useEffect(() => {
    if (!open) {
      setPortalResolutionComplete(false);
      setNativeDialogContainer(null);
      return;
    }
    if (portalContainer) {
      setNativeDialogContainer(null);
      setPortalResolutionComplete(true);
      return;
    }
    const openDialogs = Array.from(document.querySelectorAll('dialog[open]'));
    const modalDialog = openDialogs.find((dialog) => {
      try {
        return dialog.matches(':modal');
      } catch {
        return false;
      }
    });
    setNativeDialogContainer(modalDialog || null);
    setPortalResolutionComplete(true);
  }, [open, portalContainer]);

  useEffect(() => {
    if (!open) return;
    setSelectedAssetIds([]);
    setSelectedAssetsById({});
    setPreviewAsset(null);
    setUploadProgress(null);
    setPendingAttach(null);
    setConfirmFailed(false);
    setItems([]);
    return () => { loadSequence.current++; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (source === 'albums') {
      loadSequence.current++;
      setLoading(false);
      return;
    }
    void loadPage(1, 'replace');
    return () => { loadSequence.current++; };
  }, [loadPage, open, source]);

  useEffect(() => {
    if (!open) return;
    const portalRoot = portalContainer || nativeDialogContainer;
    const dialog = portalRoot instanceof HTMLDialogElement ? portalRoot : portalRoot?.closest('dialog');
    if (dialog) {
      const handleDialogKeyDown = (event: KeyboardEvent) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        if (previewAsset) setPreviewAsset(null);
        else onClose();
      };
      const handleDialogCancel = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        if (previewAsset) {
          setPreviewAsset(null);
          return;
        }
        onClose();
      };
      dialog.addEventListener('keydown', handleDialogKeyDown, true);
      dialog.addEventListener('cancel', handleDialogCancel, true);
      return () => {
        dialog.removeEventListener('keydown', handleDialogKeyDown, true);
        dialog.removeEventListener('cancel', handleDialogCancel, true);
      };
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (previewAsset) {
        setPreviewAsset(null);
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [nativeDialogContainer, onClose, open, portalContainer, previewAsset]);

  useEffect(() => {
    const portalRoot = portalContainer || nativeDialogContainer;
    const dialog = portalRoot instanceof HTMLDialogElement ? portalRoot : portalRoot?.closest('dialog');
    if (previewAsset) {
      if (dialog?.open && dialog.matches(':modal')) {
        previewReturnDialog.current = dialog;
        dialog.close();
      }
      return;
    }
    const dialogToRestore = previewReturnDialog.current;
    if (dialogToRestore) {
      previewReturnDialog.current = null;
      if (openRef.current && dialogToRestore.isConnected && !dialogToRestore.open) dialogToRestore.showModal();
    }
  }, [nativeDialogContainer, open, portalContainer, previewAsset]);

  if (!open) return null;

  const toggleAsset = (assetId: string, asset?: UploadedAssetSelection) => {
    if (currentAssetIdSet.has(assetId)) return;
    const isSelected = selectedAssetIds.includes(assetId);
    if (!isSelected && maxSelection !== undefined && selectedAssetIds.length >= maxSelection) {
      setError(`最多还能选择 ${maxSelection} 张图片`); return;
    }
    setSelectedAssetIds((current) => {
      if (current.includes(assetId)) return current.filter((id) => id !== assetId);
      return [...current, assetId];
    });
    setSelectedAssetsById((current) => {
      const next = { ...current };
      if (isSelected) delete next[assetId];
      else if (asset) next[assetId] = asset;
      return next;
    });
    setConfirmFailed(false);
    setError(null);
  };

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const attachUploadedAssets = async (pending: PendingPickerAttach) => {
    const assetIds = pending.assetIds.filter((id) => !currentAssetIdSet.has(id));
    if (assetIds.length === 0) {
      setPendingAttach(null);
      await loadPage(1, 'replace');
      return;
    }
    const selectionById = new Map(pending.assets.map((item) => [item.id, item]));
    const assets = assetIds
      .map((id) => selectionById.get(id))
      .filter((item): item is UploadedAssetSelection => Boolean(item));
    setUploadProgress({
      label: '正在加入参考区',
      detail: pending.detail,
    });
    await onConfirm(assetIds, assets);
    setPendingAttach(null);
    setSelectedAssetIds([]);
    setSelectedAssetsById({});
    onClose();
  };

  const retryPendingAttach = async () => {
    if (!pendingAttach) return;
    setUploading(true);
    setError(null);
    try {
      await attachUploadedAssets(pendingAttach);
    } catch (err) {
      setError(err instanceof Error ? `素材已上传成功，但加入参考区仍失败：${err.message}` : '素材已上传成功，但加入参考区仍失败。');
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  };

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const pickedFiles = Array.from(event.target.files || []);
    const files = pickedFiles.filter(isSupportedReferenceFile);
    if (pickedFiles.length > 0 && files.length === 0) {
      setError('当前只支持上传图片、视频或音频素材，请重新选择文件。');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    if (files.length === 0) return;
    setUploading(true);
    setUploadProgress(null);
    setPendingAttach(null);
    setError(null);
    let pendingUploadedAttach: PendingPickerAttach | null = null;
    try {
      const uploadedAssetIds: string[] = [];
      const uploadedSelections: UploadedAssetSelection[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setUploadProgress({
          label: files.length > 1 ? `${i + 1}/${files.length} 准备上传` : '准备上传',
          detail: file.name,
        });
        const assetId = await onUploadFile(file, (progress) => {
          setUploadProgress(buildPickerUploadProgress(file, i, files.length, progress));
        });
        uploadedAssetIds.push(assetId);
        uploadedSelections.push({ id: assetId, type: assetTypeFromFile(file) });
      }
      const attachableIds = uploadedAssetIds.filter((id) => !currentAssetIdSet.has(id));
      if (attachableIds.length > 0) {
        const selectionById = new Map(uploadedSelections.map((item) => [item.id, item]));
        const attachableSelections = attachableIds
          .map((id) => selectionById.get(id))
          .filter((item): item is UploadedAssetSelection => Boolean(item));
        pendingUploadedAttach = {
          assetIds: attachableIds,
          assets: attachableSelections,
          detail: files.length > 1 ? `${attachableIds.length} 个素材` : files[0].name,
        };
        await attachUploadedAssets(pendingUploadedAttach);
      } else {
        await loadPage(1, 'replace');
      }
    } catch (err) {
      if (pendingUploadedAttach) {
        setPendingAttach(pendingUploadedAttach);
        setError(err instanceof Error ? `素材已上传成功，但加入参考区失败：${err.message}` : '素材已上传成功，但加入参考区失败。');
      } else {
        setError(err instanceof Error ? err.message : '素材上传失败');
      }
    } finally {
      setUploading(false);
      setUploadProgress(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDelete = async (asset: UploadedAssetItem) => {
    if (asset.type !== 'image' || deletingAssetId === asset.id) return;
    const stillInWorkspace = currentAssetIdSet.has(asset.id);
    const confirmed = window.confirm(
      stillInWorkspace
        ? `从历史素材中隐藏「${asset.fileName}」？当前参考区里的这份素材会保留。`
        : `从历史素材中隐藏「${asset.fileName}」？已生成任务和图集引用不会被删除。`,
    );
    if (!confirmed) return;

    setDeletingAssetId(asset.id);
    setError(null);
    try {
      const res = await fetch(`/api/assets/history/${asset.id}`, { method: 'DELETE' });
      const data = await readJsonResponse<ApiMessageResponse>(res, {
        invalidJsonMessage: '删除历史素材时服务返回了页面内容，请刷新后重试；如果仍出现，请重新登录。',
      });
      if (!res.ok) throw new Error(data.error || data.message || '删除历史素材失败');
      setItems((current) => current.filter((item) => item.id !== asset.id));
      setSelectedAssetIds((current) => current.filter((id) => id !== asset.id));
      setSelectedAssetsById((current) => {
        const next = { ...current };
        delete next[asset.id];
        return next;
      });
      setConfirmFailed(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除历史素材失败');
    } finally {
      setDeletingAssetId(null);
    }
  };

  const handleConfirm = async () => {
    if (selectedAssetIds.length === 0) return;
    setLoading(true);
    setError(null);
    setConfirmFailed(false);
    try {
      const selectedAssets = selectedAssetIds
        .map((id) => selectedAssetsById[id])
        .filter((item): item is UploadedAssetSelection => Boolean(item));
      if (selectedAssets.length !== selectedAssetIds.length) throw new Error('图片信息暂时不可用，请重新选择后重试。');
      await onConfirm(selectedAssetIds, selectedAssets);
      setSelectedAssetIds([]);
      setSelectedAssetsById({});
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '加入参考素材失败');
      setConfirmFailed(true);
    } finally {
      setLoading(false);
    }
  };

  const pickerContent = (
    <div className="uploaded-picker-backdrop" onClick={onClose}>
      <div className="uploaded-picker" onClick={(event) => event.stopPropagation()}>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*,audio/*"
          multiple
          className="uploaded-picker-file-input"
          onChange={(event) => { void handleFileChange(event); }}
        />

        <div className="uploaded-picker-header">
          <div>
            <h3>{imageOnly ? '选择图片' : '添加参考素材'}</h3>
            {!imageOnly && <p>选择历史素材或上传图片、视频、音频加入当前参考区；生成前会按当前模型规则检查数量和素材参数。</p>}
          </div>
          <button type="button" className="uploaded-picker-close" onClick={onClose}>x</button>
        </div>

        {error && <div className="uploaded-picker-error">{error}</div>}
        {imageOnly && <div className="uploaded-picker-actions" role="tablist" aria-label="图片来源">
          {([['all', '全部'], ['generated', '已生成'], ['uploaded', '已上传'], ['albums', '我的图集']] as const).map(([value, label]) => <button key={value} className={source === value ? 'uploaded-picker-confirm' : 'uploaded-picker-cancel'} type="button" role="tab" aria-selected={source === value} disabled={uploading} onClick={() => setSource(value)}>{label}</button>)}
        </div>}
        {pendingAttach && (
          <div className="uploaded-picker-attach-retry">
            <span>素材已上传成功，可直接重试加入当前参考区。</span>
            <button type="button" onClick={() => { void retryPendingAttach(); }} disabled={uploading || loading}>
              重试加入
            </button>
          </div>
        )}
        {uploadProgress && (
          <UploadProgressIndicator
            label={uploadProgress.label}
            detail={uploadProgress.detail}
            percent={uploadProgress.percent}
            variant="light"
            className="uploaded-picker-progress"
          />
        )}

        <div className="uploaded-picker-body">
          {imageOnly && source === 'albums' ? (
            <UploadedImagePickerAlbums
              selectedAssetIds={selectedAssetIds}
              selectedAssets={selectedAssets}
              currentAssetIds={currentAssetIds}
              maxSelection={maxSelection}
              onToggleAsset={(asset) => toggleAsset(asset.id, asset)}
            />
          ) : loading && items.length === 0 ? (
            <div className="uploaded-picker-empty">读取中...</div>
          ) : items.length === 0 ? (
            <div className="uploaded-picker-empty">
              <strong>还没有历史素材</strong>
              {!selectionOnly && <span>点击下方“上传本地素材”添加第一份参考。</span>}
            </div>
          ) : (
            <div className="uploaded-picker-grid">
              {items.map((item) => {
                const selected = selectedAssetIds.includes(item.id);
                const inWorkspace = currentAssetIdSet.has(item.id);
                const dimensions = item.width && item.height ? `${item.width}x${item.height}` : '未知尺寸';
                const previewTitle = item.type === 'image' ? '放大查看' : `选择${assetTypeLabel(item.type)}素材`;
                return (
                  <article
                    key={item.id}
                    className={[
                      'uploaded-picker-card',
                      selected ? 'selected' : '',
                      inWorkspace ? 'in-workspace' : '',
                    ].filter(Boolean).join(' ')}
                  >
                    <div className="uploaded-picker-card-main">
                      <button
                        type="button"
                        className={[
                          'uploaded-picker-preview-button',
                          item.type === 'image' ? 'zoomable' : '',
                        ].filter(Boolean).join(' ')}
                        onClick={() => {
                          if (item.type === 'image') {
                            setPreviewAsset(item);
                            return;
                          }
                          toggleAsset(item.id, { id: item.id, type: item.type, originalUrl: item.originalUrl, thumbnailUrl: item.thumbnailUrl ?? undefined, fileName: item.fileName, width: item.width, height: item.height });
                        }}
                        disabled={item.type !== 'image' && inWorkspace}
                        title={previewTitle}
                        aria-label={`${previewTitle}${item.fileName}`}
                      >
                        <UploadedAssetThumbnail item={item} />
                      </button>
                      <button
                        type="button"
                        title={`预览${assetTypeLabel(item.type)}`}
                        aria-label={`预览${item.fileName}`}
                        disabled={item.type !== 'image' && !item.originalUrl}
                        onClick={() => setPreviewAsset(item)}
                        style={{ alignItems: 'center', background: 'rgba(17, 24, 39, .76)', border: 0, borderRadius: 4, color: 'white', cursor: 'pointer', display: 'inline-flex', padding: 6, position: 'absolute', right: 8, top: 8 }}
                      ><Eye size={16} /></button>
                      <button
                        type="button"
                        className="uploaded-picker-card-state"
                        onClick={() => toggleAsset(item.id, { id: item.id, type: item.type, originalUrl: item.originalUrl, thumbnailUrl: item.thumbnailUrl ?? undefined, fileName: item.fileName, width: item.width, height: item.height })}
                        disabled={inWorkspace}
                      >
                        {inWorkspace ? '已在参考区' : selected ? '已选择' : '选择'}
                      </button>
                    </div>
                    <div className="uploaded-picker-card-meta">
                      <ContentReactions contentKey={`asset:${item.id}`} />
                      <strong title={item.fileName}>{item.fileName}</strong>
                      <span>{assetTypeLabel(item.type)} · {dimensions} · {formatBytes(item.fileSize)} · {formatDate(item.createdAt)}</span>
                    </div>
                    {item.type === 'image' && !selectionOnly && (
                      <button
                        type="button"
                        className="uploaded-picker-delete"
                        onClick={() => { void handleDelete(item); }}
                        disabled={deletingAssetId === item.id}
                      >
                        删除
                      </button>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </div>

        <div className="uploaded-picker-footer">
          <span>{imageOnly ? `已选 ${selectedAssetIds.length} 张${maxSelection !== undefined ? `，最多 ${maxSelection} 张` : ''}` : `已选 ${selectedAssetIds.length} 个；生成前会检查图片、视频、音频各自上限`}</span>
          <div className="uploaded-picker-actions">
            {hasMore && source !== 'albums' && (
              <button
                type="button"
                className="uploaded-picker-more"
                onClick={() => { void loadPage(page + 1, 'append'); }}
                disabled={loading}
              >
                加载更多
              </button>
            )}
            {!selectionOnly && <button type="button" className="uploaded-picker-upload" onClick={handleUploadClick} disabled={uploading}>
              {uploading ? '上传中...' : '上传本地素材'}
            </button>}
            <button type="button" className="uploaded-picker-cancel" onClick={onClose}>取消</button>
            <button
              type="button"
              className="uploaded-picker-confirm"
              onClick={() => { void handleConfirm(); }}
              disabled={selectedAssetIds.length === 0 || loading || uploading}
            >
              {imageOnly ? confirmFailed ? '重试使用所选图片' : '使用所选图片' : '加入参考区'}
            </button>
          </div>
        </div>
        {previewAsset?.type === 'image' && (
          <ZoomableImagePreview
            contentKey={`asset:${previewAsset.id}`}
            src={`/api/content-reactions/media?key=${encodeURIComponent(`asset:${previewAsset.id}`)}&variant=preview`}
            alt={previewAsset.fileName}
            fileName={previewAsset.fileName}
            onClose={() => setPreviewAsset(null)}
        />
        )}
        {previewAsset && previewAsset.type !== 'image' && <MediaPreview
          src={`/api/content-reactions/media?key=${encodeURIComponent(`asset:${previewAsset.id}`)}&variant=preview`}
          type={previewAsset.type}
          title={previewAsset.fileName}
          poster={previewAsset.thumbnailUrl && previewAsset.thumbnailUrl !== previewAsset.originalUrl ? previewAsset.thumbnailUrl : undefined}
          contentKey={`asset:${previewAsset.id}`}
          previewKey={previewAsset.id}
          details={<div><span>{assetTypeLabel(previewAsset.type)}</span><span>{formatBytes(previewAsset.fileSize)}</span></div>}
          onClose={() => setPreviewAsset(null)}
        />}
      </div>
    </div>
  );

  if (!open) return null;
  if (!portalContainer && !portalResolutionComplete) return null;
  const target = portalContainer || nativeDialogContainer;
  return target ? createPortal(pickerContent, target) : pickerContent;
}
