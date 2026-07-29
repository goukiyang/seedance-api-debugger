'use client';

import React, { useEffect, useState } from 'react';
import type { WorkspaceAssetItem, UploadStatus, FrameRole } from '@/types';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';

interface Props {
  asset: WorkspaceAssetItem;
  index: number;
  uploadStatus?: UploadStatus;
  frameRole?: FrameRole;
  onRemove: (assetId: string) => void;
  onReplace: (assetId: string) => void;
  onPreview: (url: string, type?: WorkspaceAssetItem['type']) => void;
}

export function ReferenceThumb({ asset, index, uploadStatus = 'uploaded', frameRole, onRemove, onReplace, onPreview }: Props) {
  const src = asset.thumbnailUrl || asset.originalUrl;
  const fallbackSrc = asset.thumbnailUrl && asset.originalUrl && asset.thumbnailUrl !== asset.originalUrl
    ? asset.originalUrl
    : null;
  const isUploading = uploadStatus === 'uploading';
  const isFailed = uploadStatus === 'failed';
  const [imageSrc, setImageSrc] = useState(src);
  const [imageFailed, setImageFailed] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const isImage = asset.type === 'image';
  const isVideo = asset.type === 'video';
  const isAudio = asset.type === 'audio';
  const canZoomPreview = asset.type === 'image' && Boolean(asset.originalUrl || imageSrc);
  const mediaLabel = isVideo ? '视频' : isAudio ? '音频' : '素材';

  useEffect(() => {
    setImageSrc(src);
    setImageFailed(false);
  }, [src]);

  return (
    <div className="ref-thumb">
      {/* 图片 */}
      <button
        type="button"
        className="ref-thumb-img-btn"
        onClick={() => {
          if (!imageSrc || imageFailed) return;
          if (canZoomPreview) {
            setPreviewOpen(true);
            return;
          }
          onPreview(imageSrc, asset.type);
        }}
      >
        {isImage && imageSrc && !imageFailed ? (
          <img
            src={imageSrc}
            alt={`图${index + 1}`}
            className="ref-thumb-img"
            loading="lazy"
            draggable={false}
            onDragStart={(e) => e.preventDefault()}
            onError={() => {
              if (fallbackSrc && imageSrc !== fallbackSrc) {
                setImageSrc(fallbackSrc);
                return;
              }
              setImageFailed(true);
            }}
          />
        ) : isVideo && asset.originalUrl ? (
          <video
            src={asset.originalUrl}
            className="ref-thumb-video"
            muted
            playsInline
            preload="metadata"
          />
        ) : isAudio ? (
          <div className="ref-thumb-media-placeholder">
            <span>音频</span>
          </div>
        ) : (
          <div className="ref-thumb-placeholder" />
        )}
      </button>

      {/* 上传中遮罩 */}
      {isUploading && (
        <div className="ref-thumb-upload-overlay">
          <span className="loading" />
        </div>
      )}

      {/* 上传失败遮罩 */}
      {isFailed && (
        <div className="ref-thumb-fail-overlay">
          <span className="ref-thumb-fail-icon">!</span>
        </div>
      )}

      {/* 图号标签 */}
      <div className="ref-thumb-label">{isImage ? '图' : mediaLabel}{index + 1}</div>

      {/* Frame 角色标签 */}
      {frameRole === 'first_frame' && (
        <div className="ref-thumb-role-first">首帧</div>
      )}
      {frameRole === 'last_frame' && (
        <div className="ref-thumb-role-last">尾帧</div>
      )}

      {/* 删除按钮 */}
      <button
        type="button"
        className="ref-thumb-replace"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onReplace(asset.assetId);
        }}
        title="替换"
        aria-label={`替换图${index + 1}`}
      >
        ↺
      </button>
      <button
        type="button"
        className="ref-thumb-remove"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onRemove(asset.assetId);
        }}
        title="移除"
        aria-label={`移除图${index + 1}`}
      >
        ×
      </button>
      {previewOpen && canZoomPreview && (
        <ZoomableImagePreview
          src={asset.originalUrl || imageSrc}
          alt={`图${index + 1}`}
          fileName={asset.fileName || `图${index + 1}`}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </div>
  );
}
