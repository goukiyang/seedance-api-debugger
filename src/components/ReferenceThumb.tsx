'use client';

import React, { useEffect, useState } from 'react';
import type { WorkspaceAssetItem, UploadStatus, FrameRole } from '@/types';

interface Props {
  asset: WorkspaceAssetItem;
  index: number;
  uploadStatus?: UploadStatus;
  frameRole?: FrameRole;
  onRemove: (assetId: string) => void;
  onReplace: (assetId: string) => void;
  onPreview: (url: string) => void;
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
        onClick={() => imageSrc && !imageFailed && onPreview(imageSrc)}
      >
        {imageSrc && !imageFailed ? (
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
      <div className="ref-thumb-label">图{index + 1}</div>

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
    </div>
  );
}
