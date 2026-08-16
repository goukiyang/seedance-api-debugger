'use client';

import React, { useState } from 'react';
import { ParamChip } from '@/components/ParamChip';
import type { GenerationMode, VideoRatio, VideoDuration, VideoResolution } from '@/types';
import { GENERATION_MODE_LABELS, RATIO_LABELS, RATIO_OPTIONS, DURATION_OPTIONS, RESOLUTION_OPTIONS } from '@/types';

export type ComposerSelectOption = {
  id: string;
  label: string;
  detail: string;
  disabled?: boolean;
  disabledReason?: string;
};

export type ComposerProviderStatusTone = 'ready' | 'busy' | 'warning' | 'error' | 'muted';

export type ComposerProviderStatus = {
  label: string;
  tone: ComposerProviderStatusTone;
  title: string;
  dots?: Array<{
    label: string;
    tone: ComposerProviderStatusTone;
    title?: string;
  }>;
  href?: string;
  hrefLabel?: string;
  actionLabel?: string;
  actionTitle?: string;
  actionBusy?: boolean;
  onAction?: () => void;
  visible?: boolean;
};

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
  compactControls?: boolean;
  providerLabel?: string;
  providerOptions?: ComposerSelectOption[];
  selectedProvider?: string | null;
  onProviderChange?: (provider: string) => void;
  providerStatus?: ComposerProviderStatus | null;
  modelLabel?: string;
  modelOptions?: ComposerSelectOption[];
  selectedModel?: string | null;
  onModelChange?: (model: string) => void;
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
  compactControls = false,
  providerLabel = 'Seedance 视频',
  providerOptions = [],
  selectedProvider = null,
  onProviderChange,
  providerStatus = null,
  modelLabel = 'Seedance 2.0',
  modelOptions = [],
  selectedModel = null,
  onModelChange,
}: Props) {
  const hasProviderOptions = providerOptions.length > 1;
  const selectedProviderOption = providerOptions.find((option) => option.id === selectedProvider)
    || providerOptions.find((option) => !option.disabled)
    || providerOptions[0]
    || null;
  const effectiveProviderLabel = selectedProviderOption?.label || providerLabel;
  const hasModelOptions = modelOptions.length > 0;
  const selectedModelOption = modelOptions.find((option) => option.id === selectedModel) || modelOptions[0] || null;
  const effectiveModelLabel = selectedModelOption?.label || modelLabel;
  const [showProviderMenu, setShowProviderMenu] = useState(false);
  const [showModeMenu, setShowModeMenu] = useState(false);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showRatioMenu, setShowRatioMenu] = useState(false);
  const [showDurationMenu, setShowDurationMenu] = useState(false);
  const [showResolutionMenu, setShowResolutionMenu] = useState(false);
  const shouldShowProviderStatus = Boolean(providerStatus && providerStatus.visible !== false);

  const chips = (
    <div className="composer-chips">
        {/* 视频生成标签 */}
        <ParamChip label="视频生成" active />

        {/* 生成引擎：只有多引擎并列时才显示，避免和模型下拉重复 */}
        {hasProviderOptions && (
          <div className="composer-chip-wrap">
            <ParamChip
              label={effectiveProviderLabel}
              dropdown
              onClick={() => setShowProviderMenu(!showProviderMenu)}
            />
            {showProviderMenu && (
              <>
                <div className="composer-chip-dropdown-backdrop" onClick={() => setShowProviderMenu(false)} />
                <div className="composer-chip-dropdown composer-model-options">
                  {providerOptions.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className={`composer-chip-dropdown-item ${option.id === selectedProviderOption?.id ? 'active' : ''}`}
                      disabled={option.disabled}
                      onClick={() => {
                        if (option.disabled) return;
                        onProviderChange?.(option.id);
                        setShowProviderMenu(false);
                      }}
                      title={option.disabledReason || option.id}
                    >
                      <span>{option.label}</span>
                      <small>{option.disabledReason || option.detail}</small>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {shouldShowProviderStatus && providerStatus && (
          <span
            className={`composer-provider-status composer-provider-status-${providerStatus.tone}`}
            role="status"
            aria-label={providerStatus.title}
            tabIndex={providerStatus.onAction ? undefined : 0}
            title={providerStatus.title}
          >
            <span className="composer-provider-status-dots" aria-hidden="true">
              {(providerStatus.dots || []).map((item) => (
                <span
                  key={item.label}
                  className={`composer-provider-status-dot composer-provider-status-dot-${item.tone}`}
                  title={item.title || item.label}
                />
              ))}
            </span>
            <span className="composer-provider-status-label">{providerStatus.label}</span>
            {providerStatus.href && (
              <a className="composer-provider-status-link" href={providerStatus.href}>
                {providerStatus.hrefLabel || '设置'}
              </a>
            )}
            {providerStatus.onAction && (
              <button
                className="composer-provider-status-action"
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  providerStatus.onAction?.();
                }}
                disabled={providerStatus.actionBusy}
                title={providerStatus.actionTitle || providerStatus.actionLabel}
              >
                {providerStatus.actionBusy ? '检查中' : providerStatus.actionLabel || '检查状态'}
              </button>
            )}
          </span>
        )}

        {/* 模型标签 */}
        <div className="composer-chip-wrap">
          <ParamChip
            label={effectiveModelLabel}
            dropdown={hasModelOptions}
            onClick={hasModelOptions ? () => setShowModelMenu(!showModelMenu) : undefined}
          />
          {showModelMenu && hasModelOptions && (
            <>
              <div className="composer-chip-dropdown-backdrop" onClick={() => setShowModelMenu(false)} />
              <div className="composer-chip-dropdown composer-model-options">
                {modelOptions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={`composer-chip-dropdown-item ${option.id === selectedModelOption?.id ? 'active' : ''}`}
                    onClick={() => {
                      onModelChange?.(option.id);
                      setShowModelMenu(false);
                    }}
                    title={option.id}
                  >
                    <span>{option.label}</span>
                    <small>{option.detail}</small>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

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
  );

  return (
    <div className={`composer-action-bar ${compactControls ? 'is-compact' : ''}`}>
      {compactControls ? (
        <details className="composer-advanced-params">
          <summary>
            <span>生成参数</span>
            <strong>
              {effectiveModelLabel} · {GENERATION_MODE_LABELS[generationMode]} · {ratio} · {duration}s · {resolution}
              {shouldShowProviderStatus && providerStatus && (
                <em
                  className={`composer-provider-status-summary composer-provider-status-summary-${providerStatus.tone}`}
                  title={providerStatus.title}
                >
                  {providerStatus.label}
                </em>
              )}
            </strong>
          </summary>
          {chips}
        </details>
      ) : chips}

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
