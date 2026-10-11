'use client';

import type { ImageStudioChannels } from '@/lib/image-studio/channels';
import { imageStudioChannelOptionsForModel, imageStudioChannelReadyForModel } from '@/lib/image-studio/channels';

export function ImageGenerationChannelSelect({
  channels,
  value,
  onChange,
  disabled = false,
  id,
  className,
  model,
  legacyReady,
}: {
  channels: ImageStudioChannels;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  model?: string;
  legacyReady?: boolean;
}) {
  const options = model
    ? imageStudioChannelOptionsForModel(channels, model, value, legacyReady)
    : channels.items;
  return <select id={id} className={className} aria-label={model ? '图片供应商' : '生图通道'} value={value} disabled={disabled}
    onChange={event => onChange(event.target.value)}>
    {options.map(channel => {
      const modelReady = !model || imageStudioChannelReadyForModel(channel, model,
        channel.id === 'original' ? legacyReady : undefined);
      const unavailable = !channel.configured || !channel.enabled || !modelReady;
      const baseLabel = channel.supplierName && channel.supplierName !== channel.label
        ? `${channel.supplierName} · ${channel.label}` : channel.label;
      const label = !channel.configured ? `${baseLabel}（未配置）`
        : !channel.enabled ? `${baseLabel}（已停用）`
          : !modelReady ? `${baseLabel}（当前模型不可用）`
            : !model && !channel.ready ? `${baseLabel}（暂未就绪）` : baseLabel;
      return <option key={channel.id} value={channel.id} disabled={unavailable}
        title={channel.disabledReason || (model && !modelReady
          ? '当前模型在此供应商不可用，请手动选择其他供应商；现有图片参数未更改。' : undefined)}>{label}</option>;
    })}
  </select>;
}
