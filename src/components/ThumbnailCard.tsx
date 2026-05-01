/**
 * ThumbnailCard — 统一缩略图卡片组件
 * P0-1 增强版：
 * - 固定 60×90px（2:3 比例），溢出隐藏
 * - object-fit: cover 填充，object-position: center
 * - 支持 image / video / audio 三种类型
 * - 图号标签 + 删除按钮浮层
 * - 上传状态指示器（上传中 / 上传失败）
 * - Frame 角色标签（首帧 / 尾帧）
 * - 操作菜单：预览 / 替换 / 删除 / 设为首帧 / 设为尾帧
 */

'use client';

import React, { useState, useRef } from 'react';
import type { UploadStatus, FrameRole } from '@/types';

interface ThumbnailCardProps {
  /** 缩略图 URL，优先使用 thumbnailUrl，其次 originalUrl */
  thumbnailUrl?: string | null;
  originalUrl?: string | null;
  fileName?: string;
  type?: 'image' | 'video' | 'audio';
  index: number;
  role?: string | null;
  isDragging?: boolean;
  isDragOver?: boolean;
  /** P0-1: 上传状态 */
  uploadStatus?: UploadStatus;
  /** P0-1: Frame 角色 */
  frameRole?: FrameRole;
  /** 预览 */
  onPreview?: () => void;
  /** 删除 */
  onRemove?: () => void;
  /** P0-1: 替换文件 */
  onReplace?: () => void;
  /** P0-1: 设为首帧 */
  onSetFirst?: () => void;
  /** P0-1: 设为尾帧 */
  onSetLast?: () => void;
}

export function ThumbnailCard({
  thumbnailUrl,
  originalUrl,
  fileName = '',
  type = 'image',
  index,
  role,
  isDragging = false,
  isDragOver = false,
  uploadStatus = 'uploaded',
  frameRole,
  onPreview,
  onRemove,
  onReplace,
  onSetFirst,
  onSetLast,
}: ThumbnailCardProps) {
  const src = thumbnailUrl || originalUrl || '';
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const isUploading = uploadStatus === 'uploading';
  const isFailed = uploadStatus === 'failed';

  return (
    <div
      className={[
        'thumbnail-card',
        isDragging ? 'is-dragging' : '',
        isDragOver ? 'is-drag-over' : '',
        isUploading ? 'is-uploading' : '',
        isFailed ? 'is-failed' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* 图片内容层 */}
      {type === 'image' && src && (
        <img
          src={src}
          alt={fileName}
          className="thumbnail-image"
          loading="lazy"
        />
      )}

      {type === 'video' && (
        <div className="thumbnail-video-thumb">
          {src ? (
            <img
              src={src}
              alt={fileName}
              className="thumbnail-image opacity-60"
              loading="lazy"
            />
          ) : (
            <div className="thumbnail-image-placeholder bg-gray-800" />
          )}
          {/* 播放图标 */}
          <div className="thumbnail-video-icon">
            <svg fill="currentColor" viewBox="0 0 20 20">
              <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" />
            </svg>
          </div>
        </div>
      )}

      {type === 'audio' && (
        <div className="thumbnail-audio-thumb">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z" />
          </svg>
          <span className="thumbnail-audio-name">{fileName}</span>
        </div>
      )}

      {/* P0-1: 上传中遮罩 */}
      {isUploading && (
        <div className="thumbnail-upload-overlay">
          <span className="loading" />
        </div>
      )}

      {/* P0-1: 上传失败遮罩 */}
      {isFailed && (
        <div className="thumbnail-fail-overlay">
          <span className="thumbnail-fail-icon">!</span>
        </div>
      )}

      {/* 遮罩层（用于 hover / 点击预览） */}
      <div className="thumbnail-overlay" onClick={onPreview}>
        <svg className="thumbnail-preview-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
        </svg>
      </div>

      {/* 图号标签 */}
      <div className="thumbnail-label">图{index + 1}</div>

      {/* 角色标签 */}
      {role && <div className="thumbnail-role">{role}</div>}

      {/* P0-1: Frame 角色标签 */}
      {frameRole === 'first_frame' && <div className="thumbnail-frame-badge thumbnail-frame-first">首帧</div>}
      {frameRole === 'last_frame' && <div className="thumbnail-frame-badge thumbnail-frame-last">尾帧</div>}

      {/* P0-1: 操作菜单按钮 */}
      <div className="thumbnail-menu-wrap" ref={menuRef}>
        <button
          className="thumbnail-menu-btn"
          onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
          title="更多操作"
          type="button"
        >
          <svg fill="currentColor" viewBox="0 0 20 20" width="12" height="12">
            <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
          </svg>
        </button>

        {menuOpen && (
          <>
            <div
              className="thumbnail-menu-backdrop"
              onClick={() => setMenuOpen(false)}
            />
            <div className="thumbnail-menu">
              <button
                className="thumbnail-menu-item"
                onClick={(e) => { e.stopPropagation(); onPreview?.(); setMenuOpen(false); }}
                type="button"
              >
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" width="14" height="14">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
                预览
              </button>
              <button
                className="thumbnail-menu-item"
                onClick={(e) => { e.stopPropagation(); onReplace?.(); setMenuOpen(false); }}
                type="button"
              >
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" width="14" height="14">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                替换
              </button>
              {frameRole !== 'first_frame' && (
                <button
                  className="thumbnail-menu-item"
                  onClick={(e) => { e.stopPropagation(); onSetFirst?.(); setMenuOpen(false); }}
                  type="button"
                >
                  <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" width="14" height="14">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
                  </svg>
                  设为首帧
                </button>
              )}
              {frameRole !== 'last_frame' && (
                <button
                  className="thumbnail-menu-item"
                  onClick={(e) => { e.stopPropagation(); onSetLast?.(); setMenuOpen(false); }}
                  type="button"
                >
                  <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" width="14" height="14">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                  </svg>
                  设为尾帧
                </button>
              )}
              <div className="thumbnail-menu-divider" />
              <button
                className="thumbnail-menu-item thumbnail-menu-item-danger"
                onClick={(e) => { e.stopPropagation(); onRemove?.(); setMenuOpen(false); }}
                type="button"
              >
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" width="14" height="14">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                删除
              </button>
            </div>
          </>
        )}
      </div>

      {/* 删除按钮（保留简单版） */}
      {onRemove && !menuOpen && (
        <button
          className="thumbnail-remove"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          title="移除"
          type="button"
        >
          ×
        </button>
      )}
    </div>
  );
}
