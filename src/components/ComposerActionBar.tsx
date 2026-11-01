'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as Popper from '@radix-ui/react-popper';
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

type ComposerMenuOption = {
  id: string;
  label: string;
  detail?: string;
  disabled?: boolean;
  title?: string;
};

function ComposerOptionMenu({ label, triggerLabel, open, onOpenChange, options, selectedId, detailed = false, onSelect }: {
  label: string;
  triggerLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: ComposerMenuOption[];
  selectedId: string | null;
  detailed?: boolean;
  onSelect: (id: string) => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useDialogDismiss({
    open,
    dialogRef: panel,
    layerSurfaceRef: panel,
    branchRefs: [trigger],
    modal: false,
    onDismiss: () => onOpenChange(false),
  });
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      (panel.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]:not(:disabled)')
        || panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  return <Popper.Root>
    <Popper.Anchor asChild>
      <button ref={trigger} type="button" className="composer-chip" aria-haspopup="menu" aria-expanded={open} aria-controls={id}
        onClick={() => onOpenChange(!open)} onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          onOpenChange(true);
        }}>
        {triggerLabel}<span className="composer-chip-arrow" aria-hidden="true">▼</span>
      </button>
    </Popper.Anchor>
    {open && createPortal(<Popper.Content side="top" align="start" sideOffset={8} collisionPadding={8} avoidCollisions
      sticky="always" hideWhenDetached ref={panel} id={id} role="menu" aria-label={label}
      className={`composer-chip-dropdown ${detailed ? 'composer-model-options' : ''}`} onKeyDown={(event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const items = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []);
        if (!items.length) return;
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : (Math.max(index, 0) + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }}>
      {options.map(option => <button key={option.id} type="button" role="menuitemradio" aria-checked={option.id === selectedId}
        className={`composer-chip-dropdown-item ${option.id === selectedId ? 'active' : ''}`} disabled={option.disabled}
        title={option.title} onClick={() => { if (!option.disabled) { onSelect(option.id); onOpenChange(false); } }}>
        <span>{option.label}</span>{option.detail && <small>{option.detail}</small>}
      </button>)}
    </Popper.Content>, document.body)}
  </Popper.Root>;
}

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
            <ComposerOptionMenu label="生成引擎" triggerLabel={effectiveProviderLabel} open={showProviderMenu}
              onOpenChange={setShowProviderMenu} selectedId={selectedProviderOption?.id || null} detailed
              options={providerOptions.map(option => ({ ...option, detail: option.disabledReason || option.detail, title: option.disabledReason || option.id }))}
              onSelect={id => onProviderChange?.(id)} />
          </div>
        )}

        {/* 模型标签 */}
        <div className="composer-chip-wrap">
          {hasModelOptions ? <ComposerOptionMenu label="生成型号" triggerLabel={effectiveModelLabel} open={showModelMenu}
            onOpenChange={setShowModelMenu} selectedId={selectedModelOption?.id || null} detailed
            options={modelOptions.map(option => ({ ...option, detail: option.disabledReason || option.detail, title: option.disabledReason || option.label }))}
            onSelect={id => onModelChange?.(id)} /> : <ParamChip label={effectiveModelLabel} />}
        </div>

        {hasAuxiliaryOptions && (
          <div className="composer-chip-wrap">
            <ComposerOptionMenu label="辅助模型" triggerLabel={effectiveAuxiliaryLabel} open={showAuxiliaryMenu}
              onOpenChange={setShowAuxiliaryMenu} selectedId={selectedAuxiliaryOption?.id || null} detailed
              options={auxiliaryOptions.map(option => ({ ...option, detail: option.disabledReason || option.detail, title: option.disabledReason || option.id }))}
              onSelect={id => onAuxiliaryChange?.(id)} />
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
          <ComposerOptionMenu label="生成模式" triggerLabel={GENERATION_MODE_LABELS[generationMode]} open={showModeMenu}
            onOpenChange={setShowModeMenu} selectedId={generationMode}
            options={(Object.keys(GENERATION_MODE_LABELS) as GenerationMode[]).map(id => ({ id, label: GENERATION_MODE_LABELS[id] }))}
            onSelect={id => onModeChange(id as GenerationMode)} />
        </div>

        {/* 比例选择 */}
        <div className="composer-chip-wrap">
          {ratioLocked ? <ParamChip label={ratioLabel} disabled
            title={followsFirstFrame ? 'Seedance 2.5 首尾帧的画面比例由首帧决定；需要固定比例时，请先调整首帧图片。' : lockReason} />
            : <ComposerOptionMenu label="视频比例" triggerLabel={ratioLabel} open={showRatioMenu} onOpenChange={setShowRatioMenu}
              selectedId={ratio} options={RATIO_OPTIONS.map(id => ({ id, label: RATIO_LABELS[id] }))}
              onSelect={id => onRatioChange(id as VideoRatio)} />}
        </div>

        {/* 时长选择 */}
        <div className="composer-chip-wrap">
          {lockedDuration ? <ParamChip label={`${duration}s${durationValid ? '' : ' · 不支持'}`} disabled title={lockReason} />
            : <ComposerOptionMenu label="视频时长" triggerLabel={`${duration}s${durationValid ? '' : ' · 不支持'}`} open={showDurationMenu}
              onOpenChange={setShowDurationMenu} selectedId={String(duration)}
              options={durationOptions.map(value => ({ id: String(value), label: `${value} 秒` }))}
              onSelect={id => onDurationChange(Number(id) as VideoDuration)} />}
        </div>

        {/* 分辨率选择 */}
        <div className="composer-chip-wrap">
          {lockedResolution ? <ParamChip label={resolution} disabled title={lockReason} />
            : <ComposerOptionMenu label="视频分辨率" triggerLabel={resolution} open={showResolutionMenu}
              onOpenChange={setShowResolutionMenu} selectedId={resolution}
              options={RESOLUTION_OPTIONS.map(id => ({ id, label: id }))}
              onSelect={id => onResolutionChange(id as VideoResolution)} />}
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
