'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import type { WorkspaceAssetItem, UploadStatus, FrameRole } from '@/types';
import { ReferenceThumb } from '@/components/ReferenceThumb';
import { AddReferenceCard } from '@/components/AddReferenceCard';

const MAX_REFS = 9;

interface Props {
  assets: WorkspaceAssetItem[];
  uploadStatuses: Record<string, UploadStatus>;
  onUpload: (file: File) => Promise<void>;
  onRemove: (assetId: string) => Promise<void>;
  onReorder: (newOrder: Array<{ assetId: string; sortOrder: number }>) => Promise<void>;
  onReplace: (assetId: string, file: File) => Promise<void>;
  onPreview: (url: string) => void;
  generationMode?: string;
  loading?: boolean;
}

function getFrameRole(asset: WorkspaceAssetItem, idx: number, assets: WorkspaceAssetItem[], mode?: string): FrameRole {
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
  generationMode,
  loading = false,
}: Props) {
  const [orderedAssets, setOrderedAssets] = useState<WorkspaceAssetItem[]>(assets);
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const [dragInsertIndex, setDragInsertIndex] = useState<number | null>(null);
  const [dropReplaceKey, setDropReplaceKey] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
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
    setDraggedKey(sourceKey);
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [loading, uploading]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const drag = pointerDragRef.current;
    if (!drag) return;

    const deltaX = Math.abs(e.clientX - drag.startX);
    const deltaY = Math.abs(e.clientY - drag.startY);
    if (deltaX < 4 && deltaY < 4) return;

    drag.moved = true;
    suppressClickRef.current = true;
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
    try {
      for (let i = 0; i < files.length; i++) {
        await onUpload(files[i]);
      }
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [onUpload]);

  const replaceAssetWithFile = useCallback(async (assetId: string, file: File) => {
    setUploading(true);
    try {
      await onReplace(assetId, file);
    } finally {
      setUploading(false);
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
    fileInputRef.current?.click();
  }, []);

  const handleDropZone = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files).filter(
      (f) => f.type.startsWith('image/') || f.type.startsWith('video/') || f.type.startsWith('audio/')
    );
    if (files.length === 0) return;
    setUploading(true);
    try {
      for (const file of files) {
        await onUpload(file);
      }
    } finally {
      setUploading(false);
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

  const displayAssets = orderedAssets.slice(0, MAX_REFS);
  const hasMore = assets.length > MAX_REFS;

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
              ].filter(Boolean).join(' ')}
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
            </div>
          );
        })}

        {assets.length < MAX_REFS && (
          <AddReferenceCard
            onClick={handleAddClick}
            disabled={uploading || loading}
          />
        )}
      </div>

      {/* 上传中状态 */}
      {(uploading || loading) && (
        <span className="ref-strip-uploading">
          <span className="loading" style={{ width: 12, height: 12, borderWidth: 1.5 }} />
        </span>
      )}

      {/* 超出提示 */}
      {hasMore && (
        <span className="ref-strip-more">+{assets.length - MAX_REFS} 张</span>
      )}

      {/* 图号说明 */}
      <span className="ref-strip-count">
        {assets.length === 0 ? '最多 9 张' : `${assets.length}/${MAX_REFS} 张`}
      </span>
    </div>
  );
}
