/** Call only after the parent task's current ownership/visibility check. */
export function historicalImageSupplier(snapshotJson: string | null | undefined) {
  try {
    const value = JSON.parse(snapshotJson || '{}');
    const channel = value?.imageChannel;
    if (!channel || typeof channel.channelId !== 'string' || typeof channel.configRevision !== 'string') return {};
    const text = (item: unknown) => typeof item === 'string' && item.trim() && item.length <= 120 ? item : undefined;
    const imageChannelLabel = text(value.imageChannelLabel);
    const imageSupplierName = text(value.imageSupplierName);
    return { ...(imageChannelLabel ? { imageChannelLabel } : {}), ...(imageSupplierName ? { imageSupplierName } : {}) };
  } catch { return {}; }
}
