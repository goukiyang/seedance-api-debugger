'use client';

import type { ImageStudioChannels } from '@/lib/image-studio/channels';

export function ImageGenerationChannelSelect({
  channels,
  value,
  onChange,
  disabled = false,
  id,
  className,
}: {
  channels: ImageStudioChannels;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
}) {
  return <select id={id} className={className} aria-label="生图通道" value={value} disabled={disabled}
    onChange={event => onChange(event.target.value)}>
    {channels.items.map(channel => {
      const unavailable = !channel.configured || !channel.enabled;
      const baseLabel = channel.supplierName && channel.supplierName !== channel.label
        ? `${channel.supplierName} · ${channel.label}` : channel.label;
      const label = !channel.configured ? `${baseLabel}（未配置）`
        : !channel.enabled ? `${baseLabel}（已停用）`
          : !channel.ready ? `${baseLabel}（暂未就绪）` : baseLabel;
      return <option key={channel.id} value={channel.id} disabled={unavailable}
        title={channel.disabledReason || undefined}>{label}</option>;
    })}
  </select>;
}
