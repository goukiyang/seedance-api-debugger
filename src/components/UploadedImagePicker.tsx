'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { UploadProgressIndicator } from '@/components/UploadProgressIndicator';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';
import { readJsonResponse } from '@/lib/http/json-response';
import type { UploadProgressHandler, UploadProgressSnapshot } from '@/lib/http/file-upload';

interface UploadedImageItem {
  id: string;
  originalUrl: string;
  thumbnailUrl: string;
  fileName: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  fileSize: number;
  createdAt: string;
}

interface Props {
  open: boolean;
  currentCount: number;
  currentAssetIds: string[];
  onClose: () => void;
  onUploadFile: (file: File, onProgress?: UploadProgressHandler) => Promise<string>;
  onConfirm: (assetIds: string[]) => Promise<void>;
}

type HistoryListResponse = {
  assets?: UploadedImageItem[];
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

const PAGE_SIZE = 40;
const MAX_REFS = 9;
const HISTORY_INVALID_JSON_MESSAGE = '历史图片服务返回了页面内容，请刷新后重试；如果仍出现，请重新登录。';

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
  const [items, setItems] = useState<UploadedImageItem[]>([]);
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<PickerUploadProgress | null>(null);
  const [deletingAssetId, setDeletingAssetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewAsset, setPreviewAsset] = useState<UploadedImageItem | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const currentAssetIdSet = useMemo(() => new Set(currentAssetIds), [currentAssetIds]);
  const remaining = Math.max(0, MAX_REFS - currentCount);

  const loadPage = useCallback(async (targetPage: number, mode: 'replace' | 'append' = 'replace') => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        page: String(targetPage),
        limit: String(PAGE_SIZE),
      });
      const res = await fetch(`/api/assets/history?${params.toString()}`, { cache: 'no-store' });
      const data = await readJsonResponse<HistoryListResponse>(res, {
        invalidJsonMessage: HISTORY_INVALID_JSON_MESSAGE,
      });
      if (!res.ok) throw new Error(data.error || data.message || '历史图片读取失败');
      const nextItems: UploadedImageItem[] = data.assets || [];
      setItems((current) => {
        if (mode === 'replace') return nextItems;
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...nextItems.filter((item) => !seen.has(item.id))];
      });
      setPage(data.pagination?.page || targetPage);
      setHasMore(Boolean(data.pagination?.has_more));
    } catch (err) {
      setError(err instanceof Error ? err.message : '历史图片读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setSelectedAssetIds([]);
    setPreviewAsset(null);
    setUploadProgress(null);
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

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []).filter((file) => file.type.startsWith('image/'));
    if (files.length === 0) return;
    setUploading(true);
    setUploadProgress(null);
    setError(null);
    try {
      const uploadedAssetIds: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setUploadProgress({
          label: files.length > 1 ? `${i + 1}/${files.length} 准备上传` : '准备上传',
          detail: file.name,
        });
        uploadedAssetIds.push(await onUploadFile(file, (progress) => {
          setUploadProgress(buildPickerUploadProgress(file, i, files.length, progress));
        }));
      }
      await loadPage(1, 'replace');
      setSelectedAssetIds((current) => {
        const seen = new Set(current);
        const next = [...current];
        for (const id of uploadedAssetIds) {
          if (seen.has(id) || currentAssetIdSet.has(id) || next.length >= remaining) continue;
          seen.add(id);
          next.push(id);
        }
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : '图片上传失败');
    } finally {
      setUploading(false);
      setUploadProgress(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDelete = async (asset: UploadedImageItem) => {
    const stillInWorkspace = currentAssetIdSet.has(asset.id);
    const confirmed = window.confirm(
      stillInWorkspace
        ? `从历史图片中隐藏「${asset.fileName}」？当前参考图条里的这张图会保留。`
        : `从历史图片中隐藏「${asset.fileName}」？已生成任务和图集引用不会被删除。`,
    );
    if (!confirmed) return;

    setDeletingAssetId(asset.id);
    setError(null);
    try {
      const res = await fetch(`/api/assets/history/${asset.id}`, { method: 'DELETE' });
      const data = await readJsonResponse<ApiMessageResponse>(res, {
        invalidJsonMessage: '删除历史图片时服务返回了页面内容，请刷新后重试；如果仍出现，请重新登录。',
      });
      if (!res.ok) throw new Error(data.error || data.message || '删除历史图片失败');
      setItems((current) => current.filter((item) => item.id !== asset.id));
      setSelectedAssetIds((current) => current.filter((id) => id !== asset.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除历史图片失败');
    } finally {
      setDeletingAssetId(null);
    }
  };

  const handleConfirm = async () => {
    if (selectedAssetIds.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      await onConfirm(selectedAssetIds);
      setSelectedAssetIds([]);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '加入参考图失败');
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
          accept="image/*"
          multiple
          className="uploaded-picker-file-input"
          onChange={(event) => { void handleFileChange(event); }}
        />

        <div className="uploaded-picker-header">
          <div>
            <h3>上传历史图片</h3>
            <p>选择曾经上传过的图片加入当前参考图，最多 9 张。</p>
          </div>
          <button type="button" className="uploaded-picker-close" onClick={onClose}>x</button>
        </div>

        {error && <div className="uploaded-picker-error">{error}</div>}
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
              <strong>还没有上传过图片</strong>
              <span>点击下方“上传新图片”添加第一张参考图。</span>
            </div>
          ) : (
            <div className="uploaded-picker-grid">
              {items.map((item) => {
                const selected = selectedAssetIds.includes(item.id);
                const inWorkspace = currentAssetIdSet.has(item.id);
                const disabledByLimit = !selected && !inWorkspace && selectedAssetIds.length >= remaining;
                const dimensions = item.width && item.height ? `${item.width}x${item.height}` : '未知尺寸';
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
                        className="uploaded-picker-preview-button"
                        onClick={() => setPreviewAsset(item)}
                        title="放大查看"
                        aria-label={`放大查看${item.fileName}`}
                      >
                        <img src={item.thumbnailUrl} alt={item.fileName} />
                      </button>
                      <button
                        type="button"
                        className="uploaded-picker-card-state"
                        onClick={() => toggleAsset(item.id)}
                        disabled={inWorkspace || disabledByLimit}
                      >
                        {inWorkspace ? '已在参考图' : selected ? '已选择' : '选择'}
                      </button>
                    </div>
                    <div className="uploaded-picker-card-meta">
                      <strong title={item.fileName}>{item.fileName}</strong>
                      <span>{dimensions} · {formatBytes(item.fileSize)} · {formatDate(item.createdAt)}</span>
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
          <span>已选 {selectedAssetIds.length} 张，当前还可新增 {remaining} 张</span>
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
              {uploading ? '上传中...' : '上传新图片'}
            </button>
            <button type="button" className="uploaded-picker-cancel" onClick={onClose}>取消</button>
            <button
              type="button"
              className="uploaded-picker-confirm"
              onClick={() => { void handleConfirm(); }}
              disabled={selectedAssetIds.length === 0 || loading || uploading}
            >
              加入参考图
            </button>
          </div>
        </div>
        {previewAsset && (
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
