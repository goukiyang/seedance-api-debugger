'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { UploadProgressIndicator } from '@/components/UploadProgressIndicator';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';
import { readJsonResponse } from '@/lib/http/json-response';
import type { UploadProgressHandler, UploadProgressSnapshot } from '@/lib/http/file-upload';
import type { AssetType } from '@/types';

interface UploadedAssetItem {
  id: string;
  type: AssetType;
  originalUrl: string;
  thumbnailUrl: string;
  fileName: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  fileSize: number;
  createdAt: string;
}

export type UploadedAssetSelection = {
  id: string;
  type: AssetType;
};

interface Props {
  open: boolean;
  currentCount: number;
  currentAssetIds: string[];
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
const MAX_REFS = 9;
const HISTORY_INVALID_JSON_MESSAGE = '历史素材服务返回了页面内容，请刷新后重试；如果仍出现，请重新登录。';

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
  open,
  currentCount,
  currentAssetIds,
  onClose,
  onUploadFile,
  onConfirm,
}: Props) {
  const [items, setItems] = useState<UploadedAssetItem[]>([]);
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<PickerUploadProgress | null>(null);
  const [deletingAssetId, setDeletingAssetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewAsset, setPreviewAsset] = useState<UploadedAssetItem | null>(null);
  const [pendingAttach, setPendingAttach] = useState<PendingPickerAttach | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const currentAssetIdSet = useMemo(() => new Set(currentAssetIds), [currentAssetIds]);
  const remaining = Math.max(0, MAX_REFS - currentCount);

  const loadPage = useCallback(async (targetPage: number, mode: 'replace' | 'append' = 'replace') => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        type: 'all',
        page: String(targetPage),
        limit: String(PAGE_SIZE),
      });
      const res = await fetch(`/api/assets/history?${params.toString()}`, { cache: 'no-store' });
      const data = await readJsonResponse<HistoryListResponse>(res, {
        invalidJsonMessage: HISTORY_INVALID_JSON_MESSAGE,
      });
      if (!res.ok) throw new Error(data.error || data.message || '历史素材读取失败');
      const nextItems: UploadedAssetItem[] = data.assets || [];
      setItems((current) => {
        if (mode === 'replace') return nextItems;
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...nextItems.filter((item) => !seen.has(item.id))];
      });
      setPage(data.pagination?.page || targetPage);
      setHasMore(Boolean(data.pagination?.has_more));
    } catch (err) {
      setError(err instanceof Error ? err.message : '历史素材读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setSelectedAssetIds([]);
    setPreviewAsset(null);
    setUploadProgress(null);
    setPendingAttach(null);
    void loadPage(1, 'replace');
  }, [loadPage, open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (previewAsset) {
        event.stopImmediatePropagation();
        setPreviewAsset(null);
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open, previewAsset]);

  if (!open) return null;

  const toggleAsset = (assetId: string) => {
    if (currentAssetIdSet.has(assetId)) return;
    setSelectedAssetIds((current) => {
      if (current.includes(assetId)) return current.filter((id) => id !== assetId);
      if (current.length >= remaining) return current;
      return [...current, assetId];
    });
  };

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const attachUploadedAssets = async (pending: PendingPickerAttach) => {
    const assetIds = pending.assetIds.filter((id) => !currentAssetIdSet.has(id)).slice(0, remaining);
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
    if (remaining <= 0) {
      setError(`单次生成最多选择 ${MAX_REFS} 个参考素材，当前已达上限。`);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    if (files.length > remaining) {
      setError(`当前还可新增 ${remaining} 个参考素材，请减少选择数量后重试。`);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
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
      const attachableIds = uploadedAssetIds.filter((id) => !currentAssetIdSet.has(id)).slice(0, remaining);
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
    try {
      const itemById = new Map(items.map((item) => [item.id, item]));
      const selectedAssets = selectedAssetIds
        .map((id) => itemById.get(id))
        .filter((item): item is UploadedAssetItem => Boolean(item))
        .map((item) => ({ id: item.id, type: item.type }));
      await onConfirm(selectedAssetIds, selectedAssets);
      setSelectedAssetIds([]);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '加入参考素材失败');
    } finally {
      setLoading(false);
    }
  };

  return (
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
            <h3>添加参考素材</h3>
            <p>选择历史素材或上传图片、视频、音频加入当前参考区，最多 9 个。</p>
          </div>
          <button type="button" className="uploaded-picker-close" onClick={onClose}>x</button>
        </div>

        {error && <div className="uploaded-picker-error">{error}</div>}
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
          {loading && items.length === 0 ? (
            <div className="uploaded-picker-empty">读取中...</div>
          ) : items.length === 0 ? (
            <div className="uploaded-picker-empty">
              <strong>还没有历史素材</strong>
              <span>点击下方“上传本地素材”添加第一份参考。</span>
            </div>
          ) : (
            <div className="uploaded-picker-grid">
              {items.map((item) => {
                const selected = selectedAssetIds.includes(item.id);
                const inWorkspace = currentAssetIdSet.has(item.id);
                const disabledByLimit = !selected && !inWorkspace && selectedAssetIds.length >= remaining;
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
                          toggleAsset(item.id);
                        }}
                        disabled={item.type !== 'image' && (inWorkspace || disabledByLimit)}
                        title={previewTitle}
                        aria-label={`${previewTitle}${item.fileName}`}
                      >
                        {item.type === 'video' ? (
                          <video src={item.originalUrl} muted playsInline preload="metadata" />
                        ) : item.type === 'audio' ? (
                          <span className="uploaded-picker-media-placeholder">音频</span>
                        ) : (
                          <img src={item.thumbnailUrl} alt={item.fileName} />
                        )}
                      </button>
                      <button
                        type="button"
                        className="uploaded-picker-card-state"
                        onClick={() => toggleAsset(item.id)}
                        disabled={inWorkspace || disabledByLimit}
                      >
                        {inWorkspace ? '已在参考区' : selected ? '已选择' : '选择'}
                      </button>
                    </div>
                    <div className="uploaded-picker-card-meta">
                      <strong title={item.fileName}>{item.fileName}</strong>
                      <span>{assetTypeLabel(item.type)} · {dimensions} · {formatBytes(item.fileSize)} · {formatDate(item.createdAt)}</span>
                    </div>
                    <button
                      type="button"
                      className="uploaded-picker-delete"
                      onClick={() => { void handleDelete(item); }}
                      disabled={deletingAssetId === item.id}
                    >
                      删除
                    </button>
                  </article>
                );
              })}
            </div>
          )}
        </div>

        <div className="uploaded-picker-footer">
          <span>已选 {selectedAssetIds.length} 个，当前还可新增 {remaining} 个</span>
          <div className="uploaded-picker-actions">
            {hasMore && (
              <button
                type="button"
                className="uploaded-picker-more"
                onClick={() => { void loadPage(page + 1, 'append'); }}
                disabled={loading}
              >
                加载更多
              </button>
            )}
            <button type="button" className="uploaded-picker-upload" onClick={handleUploadClick} disabled={uploading}>
              {uploading ? '上传中...' : '上传本地素材'}
            </button>
            <button type="button" className="uploaded-picker-cancel" onClick={onClose}>取消</button>
            <button
              type="button"
              className="uploaded-picker-confirm"
              onClick={() => { void handleConfirm(); }}
              disabled={selectedAssetIds.length === 0 || loading || uploading}
            >
              加入参考区
            </button>
          </div>
        </div>
        {previewAsset?.type === 'image' && (
          <ZoomableImagePreview
            src={previewAsset.originalUrl || previewAsset.thumbnailUrl}
            alt={previewAsset.fileName}
            fileName={previewAsset.fileName}
            onClose={() => setPreviewAsset(null)}
          />
        )}
      </div>
    </div>
  );
}
