'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Settings2, Sparkles } from 'lucide-react';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { ParamChip } from '@/components/ParamChip';
import type { GenerationMode, VideoRatio, VideoDuration, VideoResolution } from '@/types';
import { seedanceRatioFollowsFirstFrame, seedanceVideoDurationOptions, isSeedanceVideoDuration } from '@/lib/provider/seedance-models';
import { GENERATION_MODE_LABELS, RATIO_LABELS, RATIO_OPTIONS, RESOLUTION_OPTIONS } from '@/types';

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
  videoRedesign?: boolean;
  generationMode: GenerationMode;
  ratio: VideoRatio;
  duration: VideoDuration;
  resolution: VideoResolution;
  points?: number | null;
  canSubmit: boolean;
  isSubmitting: boolean;
  onSubmit: () => void;
  submitAccessory?: React.ReactNode;
  settingsContent?: React.ReactNode;
  settingsOpen?: boolean;
  onSettingsOpenChange?: (open: boolean) => void;
  settingsDisabled?: boolean;
  pricingStatus?: React.ReactNode;
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
  durationModel?: string | null;
  parameterModel?: string | null;
  onModelChange?: (model: string) => void;
  auxiliaryLabel?: string;
  auxiliaryOptions?: ComposerSelectOption[];
  selectedAuxiliary?: string | null;
  onAuxiliaryChange?: (value: string) => void;
}

export function ComposerActionBar({
  videoRedesign = false,
  generationMode,
  ratio,
  duration,
  resolution,
  points = 45,
  canSubmit,
  isSubmitting,
  onSubmit,
  submitAccessory,
  settingsContent,
  settingsOpen = false,
  onSettingsOpenChange,
  settingsDisabled = false,
  pricingStatus,
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
  durationModel = selectedModel,
  parameterModel = selectedModel,
  onModelChange,
  auxiliaryLabel = '',
  auxiliaryOptions = [],
  selectedAuxiliary = null,
  onAuxiliaryChange,
}: Props) {
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const settingsPanel = useRef<HTMLDivElement>(null);
  const settingsId = useId();
  const [settingsPosition, setSettingsPosition] = useState<React.CSSProperties | null>(null);
  useDialogDismiss({ open: videoRedesign && settingsOpen, dialogRef: settingsPanel, layerSurfaceRef: settingsPanel,
    branchRefs: [settingsTrigger], modal: false, onDismiss: () => onSettingsOpenChange?.(false) });
  useEffect(() => {
    if (!videoRedesign || !settingsOpen) { setSettingsPosition(null); return; }
    const place = () => {
      if (!settingsTrigger.current || !settingsPanel.current) return;
      const anchor = settingsTrigger.current.getBoundingClientRect(), viewport = window.visualViewport;
      const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
      const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
      const panelWidth = Math.min(420, width - 16), maxHeight = Math.min(560, height - 16);
      const panelHeight = Math.min(settingsPanel.current.scrollHeight, maxHeight);
      setSettingsPosition({ width: panelWidth, maxHeight,
        left: Math.max(left + 8, Math.min(anchor.left, left + width - panelWidth - 8)),
        top: anchor.bottom + panelHeight + 6 <= top + height - 8 ? anchor.bottom + 6 : Math.max(top + 8, anchor.top - panelHeight - 6) });
    };
    place();
    const focusFrame = requestAnimationFrame(() => settingsPanel.current?.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), button:not(:disabled)')?.focus());
    const observer = new ResizeObserver(place);
    if (settingsPanel.current) observer.observe(settingsPanel.current);
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place); window.visualViewport?.addEventListener('scroll', place);
    return () => { cancelAnimationFrame(focusFrame); observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place); window.visualViewport?.removeEventListener('scroll', place); };
  }, [videoRedesign, settingsOpen]);
  useEffect(() => { if (videoRedesign && settingsDisabled) onSettingsOpenChange?.(false); }, [videoRedesign, settingsDisabled, onSettingsOpenChange]);
  const hasProviderOptions = providerOptions.length > 1;
  const selectedProviderOption = providerOptions.find((option) => option.id === selectedProvider)
    || providerOptions.find((option) => !option.disabled)
    || providerOptions[0]
    || null;
  const effectiveProviderLabel = selectedProviderOption?.label || providerLabel;
  const hasModelOptions = modelOptions.length > 0;
  const selectedModelOption = modelOptions.find((option) => option.id === selectedModel) || (!selectedModel ? modelOptions[0] : null) || null;
  const effectiveModelLabel = selectedModelOption?.label || (selectedModel ? '当前型号不可用' : modelLabel);
  const hasAuxiliaryOptions = auxiliaryOptions.length > 0;
  const selectedAuxiliaryOption = auxiliaryOptions.find((option) => option.id === selectedAuxiliary)
    || auxiliaryOptions.find((option) => !option.disabled)
    || auxiliaryOptions[0]
    || null;
  const effectiveAuxiliaryLabel = selectedAuxiliaryOption?.label || auxiliaryLabel;
  const [showProviderMenu, setShowProviderMenu] = useState(false);
  const [showModeMenu, setShowModeMenu] = useState(false);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const modelAnchor = useRef<HTMLDivElement>(null), modelPanel = useRef<HTMLDivElement>(null);
  const [modelPosition, setModelPosition] = useState<React.CSSProperties | null>(null);
  const closeModelMenu = () => { setShowModelMenu(false); requestAnimationFrame(() => modelAnchor.current?.querySelector('button')?.focus()); };
  useDialogDismiss({ open: showModelMenu, dialogRef: modelPanel, layerSurfaceRef: modelPanel, branchRefs: [modelAnchor], modal: false, onDismiss: closeModelMenu });
  useEffect(() => {
    if (!showModelMenu) { setModelPosition(null); return; }
    const place = () => {
      if (!modelAnchor.current || !modelPanel.current) return;
      const anchor = modelAnchor.current.getBoundingClientRect(), viewport = window.visualViewport;
      const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0, width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
      const panelWidth = Math.min(360, width - 16), below = top + height - anchor.bottom - 14, above = anchor.top - top - 14;
      const maxHeight = Math.min(420, Math.max(below, above)), panelHeight = Math.min(modelPanel.current.scrollHeight, maxHeight);
      setModelPosition({ position: 'fixed', bottom: 'auto', zIndex: 2147000000, width: panelWidth, maxHeight, overflowY: 'auto',
        left: Math.max(left + 8, Math.min(anchor.left, left + width - panelWidth - 8)),
        top: below >= panelHeight ? anchor.bottom + 6 : Math.max(top + 8, anchor.top - panelHeight - 6) });
    };
    place();
    const frame = requestAnimationFrame(() => (modelPanel.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]:not(:disabled)') || modelPanel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus());
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true); window.visualViewport?.addEventListener('resize', place);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); window.visualViewport?.removeEventListener('resize', place); };
  }, [showModelMenu]);
  const [showAuxiliaryMenu, setShowAuxiliaryMenu] = useState(false);
  const [showRatioMenu, setShowRatioMenu] = useState(false);
  const [showDurationMenu, setShowDurationMenu] = useState(false);
  const followsFirstFrame = seedanceRatioFollowsFirstFrame(parameterModel, generationMode);
  const durationOptions = seedanceVideoDurationOptions(durationModel);
  const durationValid = isSeedanceVideoDuration(duration, durationModel);
  const ratioLocked = lockedRatio || followsFirstFrame;
  const ratioLabel = followsFirstFrame ? '跟随首帧' : ratio;
  const [showResolutionMenu, setShowResolutionMenu] = useState(false);
  const shouldShowProviderStatus = Boolean(providerStatus && providerStatus.visible !== false);

  const chips = (
    <div className="composer-chips">
        {/* 视频生成标签 */}
        {!videoRedesign && <ParamChip label="视频生成" active />}

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

        {/* 模型标签 */}
        <div className="composer-chip-wrap" ref={modelAnchor} onKeyDown={event => {
          if (event.target === modelAnchor.current?.querySelector('button') && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setShowModelMenu(true); }
        }}>
          <ParamChip
            label={effectiveModelLabel}
            dropdown={hasModelOptions}
            onClick={hasModelOptions ? () => setShowModelMenu(!showModelMenu) : undefined}
          />
          {showModelMenu && hasModelOptions && typeof document !== 'undefined' && createPortal(
              <div ref={modelPanel} className="composer-chip-dropdown composer-model-options" role="menu" aria-label="生成型号" style={{ ...modelPosition, visibility: modelPosition ? 'visible' : 'hidden' }} onKeyDown={event => {
                if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const items = Array.from(modelPanel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []);
                const index = items.indexOf(document.activeElement as HTMLButtonElement);
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
                items[next]?.focus();
              }}>
                {modelOptions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={`composer-chip-dropdown-item ${option.id === selectedModelOption?.id ? 'active' : ''}`}
                    role="menuitemradio"
                    aria-checked={option.id === selectedModel}
                    disabled={option.disabled}
                    onClick={() => {
                      if (option.disabled) return;
                      onModelChange?.(option.id);
                      closeModelMenu();
                    }}
                    title={option.disabledReason || option.label}
                  >
                    <span>{option.label}</span>
                    <small>{option.disabledReason || option.detail}</small>
                  </button>
                ))}
              </div>, document.body)}
        </div>

        {hasAuxiliaryOptions && (
          <div className="composer-chip-wrap">
            <ParamChip
              label={effectiveAuxiliaryLabel}
              dropdown
              onClick={() => setShowAuxiliaryMenu(!showAuxiliaryMenu)}
            />
            {showAuxiliaryMenu && (
              <>
                <div className="composer-chip-dropdown-backdrop" onClick={() => setShowAuxiliaryMenu(false)} />
                <div className="composer-chip-dropdown composer-model-options">
                  {auxiliaryOptions.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className={`composer-chip-dropdown-item ${option.id === selectedAuxiliaryOption?.id ? 'active' : ''}`}
                      disabled={option.disabled}
                      onClick={() => {
                        if (option.disabled) return;
                        onAuxiliaryChange?.(option.id);
                        setShowAuxiliaryMenu(false);
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
                {providerStatus.actionBusy ? '刷新中' : providerStatus.actionLabel || '刷新'}
              </button>
            )}
          </span>
        )}

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
            label={ratioLabel}
            dropdown={!ratioLocked}
            disabled={ratioLocked}
            title={followsFirstFrame ? 'Seedance 2.5 首尾帧的画面比例由首帧决定；需要固定比例时，请先调整首帧图片。' : lockedRatio ? lockReason : undefined}
            onClick={ratioLocked ? undefined : () => setShowRatioMenu(!showRatioMenu)}
          />
          {showRatioMenu && !ratioLocked && (
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
            label={`${duration}s${durationValid ? '' : ' · 不支持'}`}
            dropdown={!lockedDuration}
            disabled={lockedDuration}
            title={lockedDuration ? lockReason : undefined}
            onClick={lockedDuration ? undefined : () => setShowDurationMenu(!showDurationMenu)}
          />
          {showDurationMenu && !lockedDuration && (
            <>
              <div className="composer-chip-dropdown-backdrop" onClick={() => setShowDurationMenu(false)} />
              <div className="composer-chip-dropdown" style={{ maxHeight: 'min(320px, 50vh)', overflowY: 'auto' }}>
                {durationOptions.map((d) => (
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
      {videoRedesign && settingsContent && <button ref={settingsTrigger} type="button" className="composer-chip video-settings-trigger"
        title="设置" aria-label="设置" aria-haspopup="dialog" aria-controls={settingsOpen ? settingsId : undefined} aria-expanded={settingsOpen}
        disabled={settingsDisabled} onClick={() => { setSettingsPosition(null); onSettingsOpenChange?.(!settingsOpen); }}><Settings2 size={16} /><span>设置</span></button>}
    </div>
  );

  return (
    <div className={`composer-action-bar ${compactControls ? 'is-compact' : ''}`}>
      {compactControls ? (
        <details className="composer-advanced-params">
          <summary>
            <span>生成参数</span>
            <strong>
              {effectiveModelLabel}
              {hasAuxiliaryOptions && effectiveAuxiliaryLabel ? ` · ${effectiveAuxiliaryLabel}` : ''}
              {' · '}
              {GENERATION_MODE_LABELS[generationMode]} · {ratioLabel} · {duration}s · {resolution}
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

      {/* 右侧：提交按钮与费用 */}
      <div className="composer-action-right">
        {videoRedesign && submitAccessory ? <div className="video-submit-accessory">{submitAccessory}</div> : submitAccessory}
        <button
          type="button"
          className="composer-submit-btn"
          disabled={!canSubmit || !durationValid || isSubmitting}
          onClick={onSubmit}
          aria-label="生成视频"
        >
          {isSubmitting ? (
            <span className="loading" style={{ width: 20, height: 20, borderWidth: 2 }} />
          ) : videoRedesign ? <><Sparkles size={19} aria-hidden="true" /><span>生成</span></> : (
            <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path d="M12 19V5M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>

        <div className="composer-points">
          {videoRedesign && pricingStatus ? pricingStatus : points === null ? '费用待估算' : `合计约 ${points} 点数`}
        </div>
      </div>
      {videoRedesign && settingsOpen && settingsContent && createPortal(<div ref={settingsPanel} id={settingsId} role="dialog" aria-label="视频生成设置"
        className="video-composer-settings-popover" style={settingsPosition || { left: 0, top: 0, visibility: 'hidden' }}>{settingsContent}</div>, document.body)}
    </div>
  );
}
