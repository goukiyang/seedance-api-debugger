'use client';

import React, { useEffect, useState } from 'react';
import type { WorkspaceAssetItem, UploadStatus, FrameRole } from '@/types';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';
import type { ContentKey } from '@/lib/content-reactions/types';

interface Props {
  asset: WorkspaceAssetItem;
  index: number;
  uploadStatus?: UploadStatus;
  frameRole?: FrameRole;
  onRemove: (assetId: string) => void;
  onReplace: (assetId: string) => void;
  onPreview: (src: string, type?: WorkspaceAssetItem['type'], title?: string, poster?: string, contentKey?: ContentKey) => void;
}

export function ReferenceThumb({ asset, index, uploadStatus = 'uploaded', frameRole, onRemove, onReplace, onPreview }: Props) {
  const protectedSource = asset.type === 'image' && uploadStatus === 'uploaded'
    ? asset.referenceImageId ? `/api/reference-images/${encodeURIComponent(asset.referenceImageId)}/content`
      : asset.assetId ? `/api/content-reactions/media?key=${encodeURIComponent(`asset:${asset.assetId}`)}` : null
    : null;
  const src = protectedSource ? `${protectedSource}${protectedSource.includes('?') ? '&' : '?'}variant=thumbnail` : asset.thumbnailUrl || asset.originalUrl;
  const contentKey: ContentKey | undefined = asset.referenceImageId
    ? `reference_image:${asset.referenceImageId}`
    : asset.assetId ? `asset:${asset.assetId}` : undefined;
  const previewSrc = asset.referenceImageId
    ? `/api/reference-images/${encodeURIComponent(asset.referenceImageId)}/content?variant=preview`
    : asset.assetId
      ? `/api/content-reactions/media?key=${encodeURIComponent(`asset:${asset.assetId}`)}&variant=preview`
      : '';
  const fallbackSrc = !protectedSource && asset.thumbnailUrl && asset.originalUrl && asset.thumbnailUrl !== asset.originalUrl
    ? asset.originalUrl
    : null;
  const isUploading = uploadStatus === 'uploading';
  const isFailed = uploadStatus === 'failed';
  const [imageSrc, setImageSrc] = useState(src);
  const [imageStatus, setImageStatus] = useState<'loading' | 'ready' | 'failed'>(src ? 'loading' : 'failed');
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [videoFailed, setVideoFailed] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const isImage = asset.type === 'image';
  const isVideo = asset.type === 'video';
  const isAudio = asset.type === 'audio';
  const canZoomPreview = asset.type === 'image' && Boolean(previewSrc);
  const mediaLabel = isVideo ? '视频' : isAudio ? '音频' : '素材';

  useEffect(() => {
    setImageSrc(src);
    setImageStatus(src ? 'loading' : 'failed');
    setRetryAttempt(0);
    setVideoFailed(false);
  }, [src]);

  return (
    <div className="ref-thumb">
      {/* 图片 */}
      <button
        type="button"
        className="ref-thumb-img-btn"
        aria-busy={isImage && imageStatus === 'loading'}
        aria-label={isImage && imageStatus === 'failed' ? `图${index + 1}预览暂不可用，重试` : undefined}
        onClick={() => {
          if (isImage && imageStatus === 'failed' && src) {
            const nextAttempt = retryAttempt + 1;
            setRetryAttempt(nextAttempt);
            setImageSrc(`${src}${src.includes('?') ? '&' : '?'}read-retry=${nextAttempt}`);
            setImageStatus('loading');
            return;
          }
          if (isImage && !imageSrc) return;
          if (canZoomPreview) {
            setPreviewOpen(true);
            return;
          }
          if (previewSrc && contentKey) onPreview(previewSrc, asset.type, asset.fileName || `素材 ${index + 1}`, asset.thumbnailUrl || undefined, contentKey);
        }}
      >
        {isImage && imageSrc && imageStatus !== 'failed' ? (
          <img
            src={imageSrc}
            alt={`图${index + 1}`}
            className="ref-thumb-img"
            style={{ objectFit: 'contain' }}
            loading="lazy"
            draggable={false}
            onDragStart={(e) => e.preventDefault()}
            onLoad={() => setImageStatus('ready')}
            onError={() => {
              if (fallbackSrc && imageSrc !== fallbackSrc) {
                setImageSrc(fallbackSrc);
                setImageStatus('loading');
                return;
              }
              setImageStatus('failed');
            }}
          />
        ) : isVideo && asset.thumbnailUrl && asset.thumbnailUrl !== asset.originalUrl && !videoFailed ? (
          <img src={asset.thumbnailUrl} alt={`视频${index + 1}`} className="ref-thumb-video" loading="lazy" onError={() => setVideoFailed(true)} />
        ) : isAudio ? (
          <div className="ref-thumb-media-placeholder">
            <span>音频</span>
          </div>
        ) : (
          <div className="ref-thumb-placeholder" />
        )}
        {isImage && imageStatus === 'loading' && (
          <span className="ref-thumb-upload-overlay" role="status" style={{ color: 'white', fontSize: 10 }}>读取中</span>
        )}
        {isImage && imageStatus === 'failed' && (
          <span className="ref-thumb-fail-overlay" role="alert" style={{ color: 'white', fontSize: 9, lineHeight: 1.2, padding: 3 }}>
            预览暂不可用，重试
          </span>
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
      {previewOpen && canZoomPreview && contentKey && (
        <ZoomableImagePreview
          src={previewSrc}
          thumbnailSrc={src || undefined}
          alt={`图${index + 1}`}
          fileName={asset.fileName || `图${index + 1}`}
          contentKey={contentKey}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </div>
  );
}
