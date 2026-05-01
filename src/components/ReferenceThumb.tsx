'use client';

import React, { useState } from 'react';
import type { WorkspaceAssetItem, UploadStatus, FrameRole } from '@/types';

interface Props {
  asset: WorkspaceAssetItem;
  index: number;
  uploadStatus?: UploadStatus;
  frameRole?: FrameRole;
  onRemove: (assetId: string) => void;
  onPreview: (url: string) => void;
}

export function ReferenceThumb({ asset, index, uploadStatus = 'uploaded', frameRole, onRemove, onPreview }: Props) {
  const src = asset.thumbnailUrl || asset.originalUrl;
  const isUploading = uploadStatus === 'uploading';
  const isFailed = uploadStatus === 'failed';
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="ref-thumb">
      {/* 图片 */}
      <button
        type="button"
        className="ref-thumb-img-btn"
        onClick={() => src && onPreview(src)}
      >
        {src ? (
          <img
            src={src}
            alt={`图${index + 1}`}
            className="ref-thumb-img"
            loading="lazy"
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
        className="ref-thumb-remove"
        onClick={() => onRemove(asset.assetId)}
        title="移除"
      >
        ×
      </button>
    </div>
  );
}
