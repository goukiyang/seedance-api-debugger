import { useCallback, useEffect, useMemo, useState } from 'react';
import { isGeminiImageModel } from '@/lib/image-generation/resolution';
import { IMAGE_STUDIO_MODELS } from '@/lib/image-studio/model-catalog';
import type { ImageGenerationChannelDto, ImageGenerationChannelsDto, ImageGenerationModelCapabilityDto } from '@/lib/integrations/image-generation-channel';

export const ORIGINAL_IMAGE_CHANNEL_ID = 'original';

export type ImageStudioChannelModel = ImageGenerationModelCapabilityDto;

export type ImageStudioChannel = Omit<ImageGenerationChannelDto, 'models'> & {
  models: Partial<Record<string, ImageStudioChannelModel>>;
};

export type ImageStudioChannels = ImageGenerationChannelsDto & { items: ImageStudioChannel[] };

const CHANNEL_IDS = new Set(['original', 'shared', 'banana', 'fluxport']);
const ORIGINAL_FALLBACK: ImageStudioChannel = {
  id: ORIGINAL_IMAGE_CHANNEL_ID,
  label: '原接口',
  supplierName: null,
  ready: true,
  enabled: true,
  configured: true,
  disabledReason: null,
  models: {},
};

function channelId(value: unknown): value is string {
  return typeof value === 'string'
    && (CHANNEL_IDS.has(value) || /^image-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length <= 80) : undefined;
}

export function normalizeImageStudioChannels(value: unknown): ImageStudioChannels {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as { items?: unknown }).items : null;
  const items: ImageStudioChannel[] = [];
  if (Array.isArray(source)) {
    for (const raw of source) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const row = raw as Record<string, unknown>;
      if (!channelId(row.id) || typeof row.label !== 'string' || !row.label.trim() || row.label.length > 120) continue;
      const models: ImageStudioChannel['models'] = {};
      if (row.models && typeof row.models === 'object' && !Array.isArray(row.models)) {
        for (const [model, rawCapability] of Object.entries(row.models as Record<string, unknown>)) {
          if (!model || !rawCapability || typeof rawCapability !== 'object' || Array.isArray(rawCapability)) continue;
          const capability = rawCapability as Record<string, unknown>;
          const maxReferences = capability.maxReferences;
          if (!IMAGE_STUDIO_MODELS.includes(model as (typeof IMAGE_STUDIO_MODELS)[number])) continue;
          models[model] = {
            ready: capability.ready === true,
            disabledReason: typeof capability.disabledReason === 'string' && capability.disabledReason.length <= 240 ? capability.disabledReason : null,
            billingMode: capability.billingMode === 'fixed' || capability.billingMode === 'actual' ? capability.billingMode : null,
            fixedPoints: Number.isFinite(capability.fixedPoints) && Number(capability.fixedPoints) >= 0 ? Number(capability.fixedPoints) : null,
            billingSource: typeof capability.billingSource === 'string' && capability.billingSource.length <= 160 ? capability.billingSource : null,
            actualQuoteRequired: capability.actualQuoteRequired === true,
            qualities: stringList(capability.qualities) ?? null,
            resolutions: stringList(capability.resolutions) ?? null,
            ratios: stringList(capability.ratios) ?? null,
            maxReferences: Number.isSafeInteger(maxReferences) && Number(maxReferences) >= 0 ? Number(maxReferences) : null,
          };
        }
      }
      items.push({
        id: row.id,
        label: row.label.trim(),
        supplierName: typeof row.supplierName === 'string' && row.supplierName.trim() ? row.supplierName.trim().slice(0, 120) : null,
        ready: row.ready === true,
        enabled: row.enabled === true,
        configured: row.configured === true,
        disabledReason: typeof row.disabledReason === 'string' && row.disabledReason.length <= 240 ? row.disabledReason : null,
        models,
      });
    }
  }
  if (!items.some(item => item.id === ORIGINAL_IMAGE_CHANNEL_ID)) items.unshift(ORIGINAL_FALLBACK);
  return { items: items.filter((item, index) => items.findIndex(candidate => candidate.id === item.id) === index) };
}

export function imageStudioChannelCanBeSelected(channel: ImageStudioChannel | undefined) {
  return Boolean(channel && channel.enabled && channel.configured);
}

export function imageStudioChannelModel(channel: ImageStudioChannel | undefined, model: string) {
  return channel?.models[model];
}

export function imageStudioChannelModels(channelOrChannels: ImageStudioChannel | ImageStudioChannels, legacyModels: readonly string[]) {
  const channels = 'items' in channelOrChannels ? channelOrChannels.items : [channelOrChannels];
  const models = new Set<string>();
  for (const channel of channels) {
    if (channel.id === ORIGINAL_IMAGE_CHANNEL_ID) {
      for (const model of legacyModels) models.add(model);
      continue;
    }
    for (const model of Object.keys(channel.models)) models.add(model);
  }
  return legacyModels.filter(model => models.has(model));
}

export function imageStudioChannelOptionsForModel(
  channels: ImageStudioChannels,
  model: string,
  selectedChannelId: string,
  legacyReady?: boolean,
) {
  const readyOptions = channels.items.filter(channel => imageStudioChannelReadyForModel(channel, model,
    channel.id === ORIGINAL_IMAGE_CHANNEL_ID ? legacyReady : undefined));
  const selected = channels.items.find(channel => channel.id === selectedChannelId);
  if (selected && !readyOptions.some(channel => channel.id === selected.id)) readyOptions.unshift(selected);

  const originalRouteId = isGeminiImageModel(model) ? 'banana' : 'shared';
  const route = channels.items.find(channel => channel.id === originalRouteId);
  const originalVisible = readyOptions.some(channel => channel.id === ORIGINAL_IMAGE_CHANNEL_ID);
  const routeVisible = readyOptions.some(channel => channel.id === originalRouteId);
  const routeReady = imageStudioChannelReadyForModel(route, model);
  if (originalVisible && routeVisible) {
    const preserveOriginal = selectedChannelId === ORIGINAL_IMAGE_CHANNEL_ID;
    const duplicateId = preserveOriginal ? originalRouteId : routeReady ? ORIGINAL_IMAGE_CHANNEL_ID : null;
    if (duplicateId) {
      const duplicateIndex = readyOptions.findIndex(channel => channel.id === duplicateId);
      if (duplicateIndex >= 0) readyOptions.splice(duplicateIndex, 1);
    }
  }

  if (route && originalVisible) {
    const originalIndex = readyOptions.findIndex(channel => channel.id === ORIGINAL_IMAGE_CHANNEL_ID);
    readyOptions[originalIndex] = {
      ...readyOptions[originalIndex],
      label: `${route.label}（原默认）`,
      supplierName: route.supplierName,
    };
  }

  return readyOptions;
}

export function imageStudioChannelIssue(channel: ImageStudioChannel | undefined, model: string, values: {
  legacyReady?: boolean;
  quality?: string;
  resolution?: string;
  ratio?: string;
  referenceCount?: number;
}) {
  if (!channel || !channel.configured || !channel.enabled) {
    return channel?.disabledReason || `${channel?.label || '所选生图通道'}未配置或已停用，请联系管理员。`;
  }
  if (channel.id === ORIGINAL_IMAGE_CHANNEL_ID) {
    return values.legacyReady === false ? '当前模型的原接口尚未就绪，请联系管理员检查接口。' : null;
  }
  if (!channel.ready) return channel.disabledReason || `${channel.label}暂未就绪，请联系管理员。`;
  const capability = imageStudioChannelModel(channel, model);
  if (channel.id === ORIGINAL_IMAGE_CHANNEL_ID && !capability) {
    return values.legacyReady === false ? '当前模型的原接口尚未就绪，请联系管理员检查接口。' : null;
  }
  if (!capability || !capability.ready) return '当前生图通道不支持所选模型或暂未就绪；请手动选择可用通道或模型，其他参数未更改。';
  if (!capability.billingMode) return '当前生图通道的计费方式尚未确认，暂不能生成；请联系管理员检查配置。';
  if (capability.billingMode === 'fixed' && capability.fixedPoints == null
    && channel.id !== 'original' && channel.id !== 'shared' && channel.id !== 'banana') {
    return '当前生图通道的固定点数尚未配置，暂不能生成；请联系管理员检查配置。';
  }
  if (capability.qualities && values.quality !== undefined && !capability.qualities.includes(values.quality)) {
    return '当前生图通道不支持所选图片质量，请手动调整后再生成。';
  }
  if (capability.resolutions && values.resolution !== undefined && !capability.resolutions.includes(values.resolution)) {
    return '当前生图通道不支持所选分辨率，请手动调整后再生成。';
  }
  if (capability.ratios && values.ratio !== undefined && !capability.ratios.includes(values.ratio)) {
    return '当前生图通道不支持所选比例，请手动调整后再生成。';
  }
  if (channel.id !== ORIGINAL_IMAGE_CHANNEL_ID && (!capability.qualities || !capability.resolutions || !capability.ratios || capability.maxReferences == null)) {
    return '当前生图通道的图片参数支持范围尚未确认，暂不能生成；请联系管理员补全配置。';
  }
  if (Number.isSafeInteger(capability.maxReferences) && values.referenceCount !== undefined
    && values.referenceCount > capability.maxReferences!) {
    return `当前生图通道最多使用 ${capability.maxReferences} 张参考图，请减少后再生成。`;
  }
  return values.legacyReady === false && channel.id === ORIGINAL_IMAGE_CHANNEL_ID
    ? '当前模型的原接口尚未就绪，请联系管理员检查接口。' : null;
}

export function imageStudioChannelReadyForModel(channel: ImageStudioChannel | undefined, model: string, legacyReady?: boolean) {
  if (!channel || !channel.enabled || !channel.configured) return false;
  if (channel.id === ORIGINAL_IMAGE_CHANNEL_ID) return legacyReady !== false;
  if (!channel.ready) return false;
  const capability = imageStudioChannelModel(channel, model);
  return Boolean(capability?.ready && capability.billingMode && (capability.billingMode !== 'fixed'
    || capability.fixedPoints != null || ['shared', 'banana'].includes(channel.id)));
}

export function useImageStudioChannel(userId: string, feature: string, rawChannels: unknown, sourceReady: boolean) {
  const scope = `sd2:image-channel:v1:${feature}:${encodeURIComponent(userId)}`;
  const channels = useMemo(() => normalizeImageStudioChannels(rawChannels), [rawChannels]);
  const [selection, setSelection] = useState<{ scope: string; id: string; ready: boolean; message: string }>(
    { scope: '', id: ORIGINAL_IMAGE_CHANNEL_ID, ready: false, message: '' },
  );
  useEffect(() => {
    if (!sourceReady) return;
    let saved = ORIGINAL_IMAGE_CHANNEL_ID;
    let message = '';
    try {
      const value = localStorage.getItem(scope);
      if (value && channelId(value)) saved = value;
    } catch { message = '浏览器未允许保存通道偏好；当前选择仅在本次页面打开期间保留。'; }
    const selected = channels.items.find(item => item.id === saved);
    const unavailable = saved !== ORIGINAL_IMAGE_CHANNEL_ID && !imageStudioChannelCanBeSelected(selected);
    const id = unavailable ? ORIGINAL_IMAGE_CHANNEL_ID : saved;
    if (unavailable) message = `${selected?.label || '上次选择的生图通道'}已不可用，已恢复原接口；没有自动生成。`;
    if (id !== saved) {
      try { localStorage.setItem(scope, id); } catch { /* The visible fallback remains safe if storage is unavailable. */ }
    }
    setSelection({ scope, id, ready: true, message });
  }, [scope, channels, sourceReady]);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== scope || !sourceReady) return;
      const requested = event.newValue && channelId(event.newValue) ? event.newValue : ORIGINAL_IMAGE_CHANNEL_ID;
      const selected = channels.items.find(item => item.id === requested);
      const unavailable = requested !== ORIGINAL_IMAGE_CHANNEL_ID && !imageStudioChannelCanBeSelected(selected);
      setSelection({ scope, id: unavailable ? ORIGINAL_IMAGE_CHANNEL_ID : requested, ready: true,
        message: unavailable ? `${selected?.label || '上次选择的生图通道'}已不可用，已恢复原接口；没有自动生成。` : '' });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [scope, channels, sourceReady]);
  const id = selection.scope === scope ? selection.id : ORIGINAL_IMAGE_CHANNEL_ID;
  const channel = channels.items.find(item => item.id === id) || channels.items[0] || ORIGINAL_FALLBACK;
  const select = useCallback((nextId: string) => {
    const next = channels.items.find(item => item.id === nextId);
    if (!sourceReady || !imageStudioChannelCanBeSelected(next)) return;
    setSelection({ scope, id: nextId, ready: true, message: '' });
    try {
      localStorage.setItem(scope, nextId);
    } catch {
      setSelection({ scope, id: nextId, ready: true, message: '浏览器未允许保存通道偏好；当前选择仅在本次页面打开期间保留。' });
    }
  }, [channels, scope, sourceReady]);
  return { channels, channel, channelId: id, ready: sourceReady && selection.scope === scope && selection.ready,
    message: selection.scope === scope ? selection.message : '', select };
}
