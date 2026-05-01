'use client';

/**
 * ReferenceMaterialPanel — 即梦风格参考素材工作台组件
 * P0-1 增强版：
 * - 使用统一 ThumbnailCard 组件（60×90px，2:3 比例）
 * - 拖拽排序、图号标注、上传、删除、预览
 * - 上传状态指示（上传中 / 上传失败）
 * - 操作菜单：预览 / 替换 / 删除 / 设为首帧 / 设为尾帧
 * - 自动推断 frame 角色
 */

import { useState, useCallback, useRef } from 'react';
import { ThumbnailCard } from '@/components/ThumbnailCard';
import type { WorkspaceAssetItem, UploadStatus, FrameRole } from '@/types';

interface Props {
  assets: WorkspaceAssetItem[];
  onReorder: (newOrder: Array<{ assetId: string; sortOrder: number }>) => Promise<void>;
  onRemove: (assetId: string) => Promise<void>;
  onUpload: (file: File) => Promise<void>;
  loading?: boolean;
  // P0-1: 上传状态映射
  uploadStatuses?: Record<string, UploadStatus>;
  // P0-1: 替换素材
  onReplace?: (assetId: string, file: File) => Promise<void>;
  // P0-1: 设置 frame 角色
  onSetFrameRole?: (assetId: string, role: FrameRole) => Promise<void>;
  /** 当前生成模式，用于推断 frame 角色 */
  generationMode?: string;
}

export default function ReferenceMaterialPanel({
  assets,
  onReorder,
  onRemove,
  onUpload,
  loading = false,
  uploadStatuses = {},
  onReplace,
  onSetFrameRole,
  generationMode,
}: Props) {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const replacingIdRef = useRef<string | null>(null);
  /** 隐藏的拖拽预览 img，用于 setDragImage 控制 ghost 尺寸 */
  const dragPreviewRef = useRef<HTMLImageElement>(null);

  // ============================================================================
  // Frame 角色推断：首尾帧模式时自动推断首帧/尾帧
  // ============================================================================
  const getFrameRole = useCallback((asset: WorkspaceAssetItem, idx: number): FrameRole => {
    if (asset.role === 'first_frame') return 'first_frame';
    if (asset.role === 'last_frame') return 'last_frame';
    if (generationMode === 'first_last_frame') {
      if (idx === 0) return 'first_frame';
      if (idx === assets.length - 1) return 'last_frame';
    }
    return null;
  }, [generationMode, assets.length]);

  // ============================================================================
  // Drag & Drop Handlers
  // ============================================================================

  const handleDragStart = useCallback((e: React.DragEvent, assetId: string, imgUrl: string) => {
    setDraggedId(assetId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', assetId);

    // 关键修复：使用隐藏的缩略图 img 元素作为拖拽 ghost，
    // 让浏览器渲染 CSS 尺寸 (60×90) 而非原图自然尺寸
    if (dragPreviewRef.current && imgUrl) {
      dragPreviewRef.current.src = imgUrl;
    // 使用 (30, 45) 是 60×90 的中心点偏移，让 ghost 居中于鼠标
    e.dataTransfer.setDragImage(dragPreviewRef.current, 30, 45);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, assetId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
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

  // ============================================================================
  // Replace (P0-1)
  // ============================================================================

  const handleReplaceClick = useCallback((assetId: string) => {
    replacingIdRef.current = assetId;
    replaceInputRef.current?.click();
  }, []);

  const handleReplaceFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !replacingIdRef.current || !onReplace) return;
    await onReplace(replacingIdRef.current, files[0]);
    replacingIdRef.current = null;
    if (replaceInputRef.current) replaceInputRef.current.value = '';
  }, [onReplace]);

  // ============================================================================
  // Render
  // ============================================================================

  return (
    <>
      {/* 隐藏的拖拽预览 img：固定 60×90px 尺寸，用于 setDragImage */}
      <img
        ref={dragPreviewRef}
        alt=""
        className="fixed pointer-events-none -translate-x-full -translate-y-full"
        style={{ width: 60, height: 90, objectFit: 'cover', objectPosition: 'center' }}
        aria-hidden="true"
      />

      {/* P0-1: 替换文件 input（隐藏） */}
      <input
        ref={replaceInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleReplaceFileChange}
      />

      {/* 上传区：input 放在外面避免冒泡导致重复弹窗 */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*,audio/*"
        multiple
        className="hidden"
        onChange={handleFileChange}
      />
      <div
        className="border-2 border-dashed border-gray-300 rounded-lg px-3 py-2 mb-4 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors"
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
        onDrop={handleDropZone}
        onClick={() => fileInputRef.current?.click()}
      >
        {uploading || loading ? (
          <div className="text-gray-500 text-xs">
            <span className="loading" style={{ marginRight: 4 }}></span>
            {uploading ? '上传中...' : '加载中...'}
          </div>
        ) : (
          <div className="text-gray-500 text-xs">
            <span className="text-blue-500 font-medium">+ 添加素材</span>
            <span className="text-gray-400 ml-2">拖拽或点击上传</span>
          </div>
        )}
      </div>

      {/* 素材网格：统一 ThumbnailCard 60×90px */}
      {assets.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {assets.map((asset, idx) => {
            const uploadStatus = uploadStatuses[asset.assetId] ?? 'uploaded';
            const frameRole = getFrameRole(asset, idx);

            return (
              <div
                key={asset.assetId}
                draggable
                onDragStart={(e) => handleDragStart(e, asset.assetId, asset.thumbnailUrl || asset.originalUrl)}
                onDragOver={(e) => handleDragOver(e, asset.assetId)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, asset.assetId)}
                onDragEnd={handleDragEnd}
                className="flex-shrink-0"
              >
                <ThumbnailCard
                  thumbnailUrl={asset.thumbnailUrl}
                  originalUrl={asset.originalUrl}
                  fileName={asset.fileName}
                  type={asset.type as 'image' | 'video' | 'audio'}
                  index={idx}
                  role={asset.role}
                  isDragging={draggedId === asset.assetId}
                  isDragOver={dragOverId === asset.assetId}
                  uploadStatus={uploadStatus}
                  frameRole={frameRole}
                  onPreview={() => setPreviewUrl(asset.originalUrl)}
                  onRemove={() => onRemove(asset.assetId)}
                  onReplace={() => handleReplaceClick(asset.assetId)}
                  onSetFirst={() => onSetFrameRole?.(asset.assetId, 'first_frame')}
                  onSetLast={() => onSetFrameRole?.(asset.assetId, 'last_frame')}
                />
              </div>
            );
          })}
        </div>
      ) : (
        !loading && (
          <div className="text-center py-8 text-gray-400 text-sm">
            <div className="text-3xl mb-2">🖼️</div>
            <div>暂无参考素材</div>
            <div className="text-xs mt-1">上传图片或拖拽文件到上方区域</div>
          </div>
        )
      )}

      {/* 素材信息 */}
      {assets.length > 0 && (
        <div className="mt-3 text-xs text-gray-500">
          共 {assets.length} 个素材
          <span className="ml-2">
            · 拖拽可调整顺序（决定 图1/图2/图3 映射）
          </span>
        </div>
      )}

      {/* 预览弹窗 */}
      {previewUrl && (
        <div
          className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
          onClick={() => setPreviewUrl(null)}
        >
          <div className="relative max-w-4xl max-h-full" onClick={(e) => e.stopPropagation()}>
            <button
              className="absolute -top-8 right-0 text-white text-2xl hover:text-gray-300"
              onClick={() => setPreviewUrl(null)}
            >
              ×
            </button>
            {previewUrl.match(/\.(mp4|mov|webm)/i) ? (
              <video
                src={previewUrl}
                controls
                autoPlay
                className="max-w-full max-h-[80vh] rounded"
              />
            ) : (
              <img
                src={previewUrl}
                alt="Preview"
                className="max-w-full max-h-[80vh] object-contain rounded"
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}
