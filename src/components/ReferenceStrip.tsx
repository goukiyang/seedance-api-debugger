'use client';

import React, { useState, useCallback, useRef } from 'react';
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
  onPreview: (url: string) => void;
  generationMode?: string;
  loading?: boolean;
  onAssetPickerOpen?: () => void;
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

export function ReferenceStrip({
  assets,
  uploadStatuses,
  onUpload,
  onRemove,
  onReorder,
  onPreview,
  generationMode,
  loading = false,
  onAssetPickerOpen,
}: Props) {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ============================================================================
  // Drag & Drop
  // ============================================================================

  const handleDragStart = useCallback((e: React.DragEvent, asset: WorkspaceAssetItem) => {
    setDraggedId(asset.assetId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', asset.assetId);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, assetId: string) => {
    e.preventDefault();
    if (assetId !== draggedId) {
      setDragOverId(assetId);
    }
  }, [draggedId]);

  const handleDragLeave = useCallback(() => {
    setDragOverId(null);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    setDraggedId(null);
    setDragOverId(null);

    const sourceId = e.dataTransfer.getData('text/plain');
    if (!sourceId || sourceId === targetId) return;

    const sourceIdx = assets.findIndex((a) => a.assetId === sourceId);
    const targetIdx = assets.findIndex((a) => a.assetId === targetId);
    if (sourceIdx === -1 || targetIdx === -1) return;

    const newAssets = [...assets];
    const [removed] = newAssets.splice(sourceIdx, 1);
    newAssets.splice(targetIdx, 0, removed);

    await onReorder(newAssets.map((a, i) => ({ assetId: a.assetId, sortOrder: i })));
  }, [assets, onReorder]);

  const handleDragEnd = useCallback(() => {
    setDraggedId(null);
    setDragOverId(null);
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

  const displayAssets = assets.slice(0, MAX_REFS);
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

      {/* 拖放区：缩略图 + 添加卡片 */}
      <div
        className="ref-strip-dropzone"
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
        onDrop={handleDropZone}
      >
        {displayAssets.map((asset, idx) => {
          const uploadStatus = uploadStatuses[asset.assetId] ?? 'uploaded';
          const frameRole = getFrameRole(asset, idx, assets, generationMode);
          const isDragging = draggedId === asset.assetId;
          const isDragOver = dragOverId === asset.assetId;

          return (
            <div
              key={asset.assetId}
              draggable
              onDragStart={(e) => handleDragStart(e, asset)}
              onDragOver={(e) => handleDragOver(e, asset.assetId)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, asset.assetId)}
              onDragEnd={handleDragEnd}
              className={[
                'ref-thumb-wrap',
                isDragging ? 'ref-thumb-dragging' : '',
                isDragOver ? 'ref-thumb-drag-over' : '',
              ].filter(Boolean).join(' ')}
            >
              <ReferenceThumb
                asset={asset}
                index={idx}
                uploadStatus={uploadStatus}
                frameRole={frameRole}
                onRemove={onRemove}
                onPreview={onPreview}
              />
            </div>
          );
        })}

        {assets.length < MAX_REFS && (
          <AddReferenceCard
            onClick={handleAddClick}
            disabled={uploading || loading}
            onSecondaryClick={onAssetPickerOpen}
            secondaryLabel="从资产库选择"
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
