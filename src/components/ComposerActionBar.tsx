'use client';

import React, { useState } from 'react';
import { ParamChip } from '@/components/ParamChip';
import type { GenerationMode, VideoRatio, VideoDuration, VideoResolution } from '@/types';
import { GENERATION_MODE_LABELS, RATIO_LABELS, RATIO_OPTIONS, DURATION_OPTIONS, RESOLUTION_OPTIONS } from '@/types';

interface Props {
  generationMode: GenerationMode;
  ratio: VideoRatio;
  duration: VideoDuration;
  resolution: VideoResolution;
  points?: number;
  canSubmit: boolean;
  isSubmitting: boolean;
  onSubmit: () => void;
  onModeChange: (m: GenerationMode) => void;
  onRatioChange: (r: VideoRatio) => void;
  onDurationChange: (d: VideoDuration) => void;
  onResolutionChange: (r: VideoResolution) => void;
  lockedRatio?: boolean;
  lockedDuration?: boolean;
  lockedResolution?: boolean;
  lockReason?: string;
}

export function ComposerActionBar({
  generationMode,
  ratio,
  duration,
  resolution,
  points = 45,
  canSubmit,
  isSubmitting,
  onSubmit,
  onModeChange,
  onRatioChange,
  onDurationChange,
  onResolutionChange,
  lockedRatio = false,
  lockedDuration = false,
  lockedResolution = false,
  lockReason = '此参数来自视频卡交付规格',
}: Props) {
  const [showModeMenu, setShowModeMenu] = useState(false);
  const [showRatioMenu, setShowRatioMenu] = useState(false);
  const [showDurationMenu, setShowDurationMenu] = useState(false);
  const [showResolutionMenu, setShowResolutionMenu] = useState(false);

  return (
    <div className="composer-action-bar">
      {/* 参数 Chips */}
      <div className="composer-chips">
        {/* 视频生成标签 */}
        <ParamChip label="视频生成" active />

        {/* 模型标签 */}
        <ParamChip label="Seedance 2.0" />

        {/* 模式选择 */}
        <div className="composer-chip-wrap">
          <ParamChip
            label={GENERATION_MODE_LABELS[generationMode]}
            dropdown
            onClick={() => setShowModeMenu(!showModeMenu)}
          />
          {showModeMenu && (
            <>
              <div className="composer-chip-dropdown-backdrop" onClick={() => setShowModeMenu(false)} />
              <div className="composer-chip-dropdown">
                {(Object.keys(GENERATION_MODE_LABELS) as GenerationMode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`composer-chip-dropdown-item ${m === generationMode ? 'active' : ''}`}
                    onClick={() => { onModeChange(m); setShowModeMenu(false); }}
                  >
                    {GENERATION_MODE_LABELS[m]}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* 比例选择 */}
        <div className="composer-chip-wrap">
          <ParamChip
            label={ratio}
            dropdown={!lockedRatio}
            disabled={lockedRatio}
            title={lockedRatio ? lockReason : undefined}
            onClick={lockedRatio ? undefined : () => setShowRatioMenu(!showRatioMenu)}
          />
          {showRatioMenu && !lockedRatio && (
            <>
              <div className="composer-chip-dropdown-backdrop" onClick={() => setShowRatioMenu(false)} />
              <div className="composer-chip-dropdown">
                {RATIO_OPTIONS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    className={`composer-chip-dropdown-item ${r === ratio ? 'active' : ''}`}
                    onClick={() => { onRatioChange(r); setShowRatioMenu(false); }}
                  >
                    {RATIO_LABELS[r]}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* 时长选择 */}
        <div className="composer-chip-wrap">
          <ParamChip
            label={`${duration}s`}
            dropdown={!lockedDuration}
            disabled={lockedDuration}
            title={lockedDuration ? lockReason : undefined}
            onClick={lockedDuration ? undefined : () => setShowDurationMenu(!showDurationMenu)}
          />
          {showDurationMenu && !lockedDuration && (
            <>
              <div className="composer-chip-dropdown-backdrop" onClick={() => setShowDurationMenu(false)} />
              <div className="composer-chip-dropdown">
                {DURATION_OPTIONS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    className={`composer-chip-dropdown-item ${d === duration ? 'active' : ''}`}
                    onClick={() => { onDurationChange(d); setShowDurationMenu(false); }}
                  >
                    {d} 秒
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* 分辨率选择 */}
        <div className="composer-chip-wrap">
          <ParamChip
            label={resolution}
            dropdown={!lockedResolution}
            disabled={lockedResolution}
            title={lockedResolution ? lockReason : undefined}
            onClick={lockedResolution ? undefined : () => setShowResolutionMenu(!showResolutionMenu)}
          />
          {showResolutionMenu && !lockedResolution && (
            <>
              <div className="composer-chip-dropdown-backdrop" onClick={() => setShowResolutionMenu(false)} />
              <div className="composer-chip-dropdown">
                {RESOLUTION_OPTIONS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    className={`composer-chip-dropdown-item ${r === resolution ? 'active' : ''}`}
                    onClick={() => { onResolutionChange(r); setShowResolutionMenu(false); }}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* 右侧：点数 + 提交按钮 */}
      <div className="composer-action-right">
        <div className="composer-points">✦ {points}</div>

        <button
          type="button"
          className="composer-submit-btn"
          disabled={!canSubmit || isSubmitting}
          onClick={onSubmit}
        >
          {isSubmitting ? (
            <span className="loading" style={{ width: 20, height: 20, borderWidth: 2 }} />
          ) : (
            <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path d="M12 19V5M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
