'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import type { WorkspaceAssetItem, UploadStatus, FrameRole } from '@/types';
import { UploadProgressIndicator } from '@/components/UploadProgressIndicator';
import { ReferenceThumb } from '@/components/ReferenceThumb';
import { AddReferenceCard } from '@/components/AddReferenceCard';
import type { UploadProgressHandler, UploadProgressSnapshot } from '@/lib/http/file-upload';
import {
  SEEDANCE_REFERENCE_AUDIO_LIMIT,
  SEEDANCE_REFERENCE_IMAGE_LIMIT,
  SEEDANCE_REFERENCE_VIDEO_LIMIT,
  isReferenceMediaTooSmall,
  referenceMediaTooSmallMessage,
} from '@/lib/provider/reference-media-policy';

interface Props {
  assets: WorkspaceAssetItem[];
  uploadStatuses: Record<string, UploadStatus>;
  onUpload: (file: File, onProgress?: UploadProgressHandler) => Promise<void>;
  onRemove: (assetId: string) => Promise<void>;
  onReorder: (newOrder: Array<{ assetId: string; sortOrder: number }>) => Promise<void>;
  onReplace: (assetId: string, file: File, onProgress?: UploadProgressHandler) => Promise<void>;
  onPreview: (url: string, type?: WorkspaceAssetItem['type']) => void;
  onOpenHistory?: () => void;
  generationMode?: string;
  loading?: boolean;
}

type ReferenceUploadProgress = {
  label: string;
  detail: string;
  percent?: number;
};

function buildUploadProgress(
  file: File,
  fileIndex: number,
  fileCount: number,
  progress: UploadProgressSnapshot,
): ReferenceUploadProgress {
  const filePrefix = fileCount > 1 ? `${fileIndex + 1}/${fileCount} ` : '';
  return {
    label: `${filePrefix}${progress.label}`,
    detail: file.name,
    ...(progress.percent != null ? { percent: progress.percent } : {}),
  };
}

function getFrameRole(asset: WorkspaceAssetItem, idx: number, assets: WorkspaceAssetItem[], mode?: string): FrameRole {
  if (asset.type !== 'image') return null;
  if (asset.role === 'first_frame') return 'first_frame';
  if (asset.role === 'last_frame') return 'last_frame';
  if (mode === 'first_last_frame') {
    if (idx === 0) return 'first_frame';
    if (idx === assets.length - 1) return 'last_frame';
  }
  return null;
}

function getItemKey(asset: WorkspaceAssetItem): string {
  return asset.id || asset.assetId;
}

function clampIndex(index: number, max: number): number {
  return Math.max(0, Math.min(index, max));
}

function moveAssetToInsertIndex(
  items: WorkspaceAssetItem[],
  sourceKey: string,
  rawInsertIndex: number
): WorkspaceAssetItem[] {
  const sourceIdx = items.findIndex((item) => getItemKey(item) === sourceKey);
  if (sourceIdx < 0) return items;

  const next = [...items];
  const [source] = next.splice(sourceIdx, 1);
  const insertIndex = clampIndex(
    rawInsertIndex > sourceIdx ? rawInsertIndex - 1 : rawInsertIndex,
    next.length
  );

  next.splice(insertIndex, 0, source);
  return next;
}

function dragHasFiles(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes('Files');
}

export function ReferenceStrip({
  assets,
  uploadStatuses,
  onUpload,
  onRemove,
  onReorder,
  onReplace,
  onPreview,
  onOpenHistory,
  generationMode,
  loading = false,
}: Props) {
  const [orderedAssets, setOrderedAssets] = useState<WorkspaceAssetItem[]>(assets);
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const [dragInsertIndex, setDragInsertIndex] = useState<number | null>(null);
  const [dropReplaceKey, setDropReplaceKey] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<ReferenceUploadProgress | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const replaceTargetAssetIdRef = useRef<string | null>(null);
  const dropzoneRef = useRef<HTMLDivElement>(null);
  const orderedAssetsRef = useRef<WorkspaceAssetItem[]>(assets);
  const pointerDragRef = useRef<{
    sourceKey: string;
    startX: number;
    startY: number;
    moved: boolean;
    originalAssets: WorkspaceAssetItem[];
  } | null>(null);
  const suppressClickRef = useRef(false);

  useEffect(() => {
    orderedAssetsRef.current = orderedAssets;
  }, [orderedAssets]);

  useEffect(() => {
    if (pointerDragRef.current) return;
    setOrderedAssets(assets);
    orderedAssetsRef.current = assets;
  }, [assets]);

  // ============================================================================
  // Drag & Drop
  // ============================================================================

  const getInsertIndexAtPoint = useCallback((clientX: number) => {
    const items = Array.from(
      dropzoneRef.current?.querySelectorAll<HTMLElement>('[data-ref-item-key]') ?? []
    );
    if (items.length === 0) return 0;

    for (let idx = 0; idx < items.length; idx += 1) {
      const item = items[idx];
      const rect = item.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      if (clientX < centerX) return idx;
    }

    return items.length;
  }, []);

  const resetPointerDrag = useCallback(() => {
    pointerDragRef.current = null;
    setDraggedKey(null);
    setDragInsertIndex(null);
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent, asset: WorkspaceAssetItem) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.ref-thumb-remove, .ref-thumb-replace')) return;
    if (uploading || loading) return;

    const sourceKey = getItemKey(asset);
    pointerDragRef.current = {
      sourceKey,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      originalAssets: orderedAssetsRef.current,
    };
    suppressClickRef.current = false;
  }, [loading, uploading]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const drag = pointerDragRef.current;
    if (!drag) return;

    const deltaX = Math.abs(e.clientX - drag.startX);
    const deltaY = Math.abs(e.clientY - drag.startY);
    if (deltaX < 4 && deltaY < 4) return;

    if (!drag.moved) {
      drag.moved = true;
      suppressClickRef.current = true;
      setDraggedKey(drag.sourceKey);
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.setPointerCapture(e.pointerId);
      }
    }
    const insertIndex = getInsertIndexAtPoint(e.clientX);
    const nextOrder = moveAssetToInsertIndex(
      orderedAssetsRef.current,
      drag.sourceKey,
      insertIndex
    );

    orderedAssetsRef.current = nextOrder;
    setOrderedAssets(nextOrder);
    setDragInsertIndex(insertIndex);
  }, [getInsertIndexAtPoint]);

  const handlePointerUp = useCallback(async (e: React.PointerEvent) => {
    const drag = pointerDragRef.current;
    if (!drag) return;

    const finalOrder = orderedAssetsRef.current;

    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }

    resetPointerDrag();

    if (drag.moved) {
      suppressClickRef.current = true;
      const changed = finalOrder.some((asset, index) => {
        return getItemKey(asset) !== getItemKey(drag.originalAssets[index]);
      });

      if (changed) {
        await onReorder(finalOrder.map((asset, index) => ({
          assetId: asset.assetId,
          sortOrder: index,
        })));
      }
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }
  }, [onReorder, resetPointerDrag]);

  const handlePointerCancel = useCallback((e: React.PointerEvent) => {
    resetPointerDrag();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, [resetPointerDrag]);

  const handleClickCapture = useCallback((e: React.MouseEvent) => {
    if (!suppressClickRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    suppressClickRef.current = false;
  }, []);

  // ============================================================================
  // File Upload
  // ============================================================================

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    setUploadProgress(null);
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setUploadProgress({
          label: files.length > 1 ? `${i + 1}/${files.length} 准备上传` : '准备上传',
          detail: file.name,
        });
        await onUpload(file, (progress) => {
          setUploadProgress(buildUploadProgress(file, i, files.length, progress));
        });
      }
    } finally {
      setUploading(false);
      setUploadProgress(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [onUpload]);

  const replaceAssetWithFile = useCallback(async (assetId: string, file: File) => {
    setUploading(true);
    setUploadProgress({
      label: '准备替换',
      detail: file.name,
    });
    try {
      await onReplace(assetId, file, (progress) => {
        setUploadProgress(buildUploadProgress(file, 0, 1, progress));
      });
    } finally {
      setUploading(false);
      setUploadProgress(null);
      setDropReplaceKey(null);
    }
  }, [onReplace]);

  const handleReplaceFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const targetAssetId = replaceTargetAssetIdRef.current;
    replaceTargetAssetIdRef.current = null;
    if (!file || !targetAssetId) return;
    try {
      await replaceAssetWithFile(targetAssetId, file);
    } finally {
      if (replaceInputRef.current) replaceInputRef.current.value = '';
    }
  }, [replaceAssetWithFile]);

  const handleReplaceClick = useCallback((assetId: string) => {
    if (uploading || loading) return;
    replaceTargetAssetIdRef.current = assetId;
    replaceInputRef.current?.click();
  }, [loading, uploading]);

  const handleAddClick = useCallback(() => {
    if (onOpenHistory) {
      onOpenHistory();
      return;
    }
    fileInputRef.current?.click();
  }, [onOpenHistory]);

  const handleDropZone = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files).filter(
      (f) => f.type.startsWith('image/') || f.type.startsWith('video/') || f.type.startsWith('audio/')
    );
    if (files.length === 0) return;
    setUploading(true);
    setUploadProgress(null);
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setUploadProgress({
          label: files.length > 1 ? `${i + 1}/${files.length} 准备上传` : '准备上传',
          detail: file.name,
        });
        await onUpload(file, (progress) => {
          setUploadProgress(buildUploadProgress(file, i, files.length, progress));
        });
      }
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  }, [onUpload]);

  const handleReplaceDrop = useCallback(async (e: React.DragEvent, asset: WorkspaceAssetItem) => {
    const files = Array.from(e.dataTransfer.files).filter(
      (f) => f.type.startsWith('image/') || f.type.startsWith('video/') || f.type.startsWith('audio/')
    );
    if (files.length === 0) return;

    e.preventDefault();
    e.stopPropagation();
    await replaceAssetWithFile(asset.assetId, files[0]);
  }, [replaceAssetWithFile]);

  const displayAssets = orderedAssets;
  const referenceCounts = orderedAssets.reduce(
    (counts, asset) => {
      if (asset.type === 'video') counts.video += 1;
      else if (asset.type === 'audio') counts.audio += 1;
      else counts.image += 1;
      return counts;
    },
    { image: 0, video: 0, audio: 0 },
  );

  // ============================================================================
  // Render
  // ============================================================================

  return (
    <div className="ref-strip">
      {/* 隐藏 file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*,audio/*"
        multiple
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
      <input
        ref={replaceInputRef}
        type="file"
        accept="image/*,video/*,audio/*"
        style={{ display: 'none' }}
        onChange={handleReplaceFileChange}
      />

      {/* 拖放区：缩略图 + 添加卡片 */}
      <div
        ref={dropzoneRef}
        className="ref-strip-dropzone"
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
        onDrop={handleDropZone}
      >
        {displayAssets.map((asset, idx) => {
          const itemKey = getItemKey(asset);
          const uploadStatus = uploadStatuses[asset.assetId] ?? 'uploaded';
          const frameRole = getFrameRole(asset, idx, orderedAssets, generationMode);
          const isDragging = draggedKey === itemKey;
          const isInsertBefore = dragInsertIndex === idx && !isDragging;
          const isInsertAfter = dragInsertIndex === displayAssets.length && idx === displayAssets.length - 1;
          const isLowResolution = (asset.type === 'image' || asset.type === 'video')
            && isReferenceMediaTooSmall(asset.width, asset.height);
          const lowResolutionTitle = isLowResolution
            ? referenceMediaTooSmallMessage({
                kind: asset.type as 'image' | 'video',
                name: asset.fileName,
                width: asset.width,
                height: asset.height,
                index: idx,
              })
            : undefined;

          return (
            <div
              key={itemKey}
              data-ref-item-key={itemKey}
              onPointerDown={(e) => handlePointerDown(e, asset)}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
              onDragEnter={(e) => {
                if (dragHasFiles(e.dataTransfer)) setDropReplaceKey(itemKey);
              }}
              onDragOver={(e) => {
                if (!dragHasFiles(e.dataTransfer)) return;
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = 'copy';
                setDropReplaceKey(itemKey);
              }}
              onDragLeave={() => {
                setDropReplaceKey((current) => current === itemKey ? null : current);
              }}
              onDrop={(e) => void handleReplaceDrop(e, asset)}
              onClickCapture={handleClickCapture}
              onDragStart={(e) => e.preventDefault()}
              className={[
                'ref-thumb-wrap',
                isDragging ? 'ref-thumb-dragging' : '',
                isInsertBefore ? 'ref-thumb-insert-before' : '',
                isInsertAfter ? 'ref-thumb-insert-after' : '',
                dropReplaceKey === itemKey ? 'ref-thumb-replace-target' : '',
                isLowResolution ? 'ref-thumb-low-resolution' : '',
              ].filter(Boolean).join(' ')}
              title={lowResolutionTitle}
            >
              <ReferenceThumb
                asset={asset}
                index={idx}
                uploadStatus={uploadStatus}
                frameRole={frameRole}
                onRemove={onRemove}
                onReplace={handleReplaceClick}
                onPreview={onPreview}
              />
              {isLowResolution && <span className="ref-thumb-warning-badge">低清</span>}
            </div>
          );
        })}

        <AddReferenceCard
          onClick={handleAddClick}
          disabled={uploading || loading}
        />
      </div>

      {/* 上传中状态 */}
      {(uploading || loading) && (
        <span className="ref-strip-uploading">
          {uploadProgress ? (
            <UploadProgressIndicator
              label={uploadProgress.label}
              detail={uploadProgress.detail}
              percent={uploadProgress.percent}
              variant="dark"
              className="ref-strip-upload-progress"
            />
          ) : (
            <span className="loading" style={{ width: 12, height: 12, borderWidth: 1.5 }} />
          )}
        </span>
      )}

      {/* 图号说明 */}
      <span className="ref-strip-count">
        {assets.length === 0
          ? `参考图最多 ${SEEDANCE_REFERENCE_IMAGE_LIMIT} 张，视频/音频各最多 ${SEEDANCE_REFERENCE_VIDEO_LIMIT}/${SEEDANCE_REFERENCE_AUDIO_LIMIT} 个`
          : `图 ${referenceCounts.image}/${SEEDANCE_REFERENCE_IMAGE_LIMIT} · 视频 ${referenceCounts.video}/${SEEDANCE_REFERENCE_VIDEO_LIMIT} · 音频 ${referenceCounts.audio}/${SEEDANCE_REFERENCE_AUDIO_LIMIT}`}
      </span>
    </div>
  );
}
