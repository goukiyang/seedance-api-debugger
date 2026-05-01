'use client';

/**
 * StickySubmitBar — 底部固定提交栏
 * P0-6: 始终可见的参数摘要 + 提交按钮
 * - 显示当前模型、模式、比例、时长、分辨率
 * - 显示预计消耗点数
 * - 提交按钮状态联动
 */

import React from 'react';
import type { GenerationMode, VideoRatio, VideoResolution, VideoDuration } from '@/types';
import { GENERATION_MODE_LABELS, RATIO_LABELS } from '@/types';

interface Props {
  generationMode: GenerationMode;
  ratio: VideoRatio;
  duration: VideoDuration;
  resolution: VideoResolution;
  model?: string;
  /** 是否可以提交（由 PreSubmissionChecker 决定） */
  canSubmit: boolean;
  submitting?: boolean;
  onSubmit?: () => void;
  /** 预计消耗点数 */
  estimatedPoints?: number;
}

export function StickySubmitBar({
  generationMode,
  ratio,
  duration,
  resolution,
  model = 'Seedance 2.0',
  canSubmit,
  submitting = false,
  onSubmit,
  estimatedPoints = 0,
}: Props) {
  return (
    <div className="sticky-submit-bar">
      <div className="sticky-submit-summary">
        <span className="sticky-submit-chip sticky-submit-chip-primary">{model}</span>
        <span className="sticky-submit-chip">{GENERATION_MODE_LABELS[generationMode]}</span>
        <span className="sticky-submit-chip">{RATIO_LABELS[ratio]}</span>
        <span className="sticky-submit-chip">{duration}秒</span>
        <span className="sticky-submit-chip">{resolution}</span>
        {estimatedPoints > 0 && (
          <span className="sticky-submit-chip sticky-submit-chip-points">{estimatedPoints} 点</span>
        )}
      </div>
      <button
        type="button"
        className="sticky-submit-btn"
        disabled={!canSubmit || submitting}
        onClick={onSubmit}
      >
        {submitting ? (
          <>
            <span className="loading" style={{ marginRight: 8, width: 16, height: 16 }}></span>
            提交中...
          </>
        ) : (
          <>
            🚀 提交任务
          </>
        )}
      </button>
    </div>
  );
}
