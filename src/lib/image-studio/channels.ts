import { useCallback, useEffect, useMemo, useState } from 'react';
import { isGeminiImageModel } from '@/lib/image-generation/resolution';
import { IMAGE_STUDIO_MODELS } from '@/lib/image-studio/model-catalog';
import { isStandardStudioRatio, normalizeStudioRatio } from './ratios';
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
            ...(model === 'gemini-3-pro-image-preview' && capability.allowsUnconfirmedParameters === true
              ? { allowsUnconfirmedParameters: true } : {}),
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
  const defaults = value && typeof value === 'object' ? (value as { defaultRoutes?: unknown }).defaultRoutes : null;
  const routes = defaults && typeof defaults === 'object' ? defaults as { revision?: unknown; models?: unknown } : null;
  const models: Partial<Record<(typeof IMAGE_STUDIO_MODELS)[number], string>> = {};
  if (routes?.models && typeof routes.models === 'object' && !Array.isArray(routes.models)) {
    for (const model of IMAGE_STUDIO_MODELS) {
      const id = (routes.models as Record<string, unknown>)[model];
      if (channelId(id) && id !== ORIGINAL_IMAGE_CHANNEL_ID) models[model] = id;
    }
  }
  return { items: items.filter((item, index) => items.findIndex(candidate => candidate.id === item.id) === index),
    ...(routes && Number.isSafeInteger(routes.revision) && Number(routes.revision) >= 0
      ? { defaultRoutes: { revision: Number(routes.revision), models } } : {}) };
}

export function imageStudioDefaultChannelId(channels: ImageStudioChannels, model: string) {
  return channels.defaultRoutes?.models[model as (typeof IMAGE_STUDIO_MODELS)[number]]
    || (isGeminiImageModel(model) ? 'banana' : 'shared');
}

export function imageStudioUsesLegacyRoute(channels: ImageStudioChannels, model: string, selectedId: string) {
  return selectedId === ORIGINAL_IMAGE_CHANNEL_ID
    && !channels.defaultRoutes?.models[model as (typeof IMAGE_STUDIO_MODELS)[number]];
}

export function imageStudioEffectiveChannelId(channels: ImageStudioChannels, model: string, selectedId: string) {
  return selectedId === ORIGINAL_IMAGE_CHANNEL_ID && !imageStudioUsesLegacyRoute(channels, model, selectedId)
    ? imageStudioDefaultChannelId(channels, model) : selectedId;
}

export function imageStudioChannelCanBeSelected(channel: ImageStudioChannel | undefined) {
  return Boolean(channel && channel.enabled && channel.configured);
}

export function imageStudioChannelModel(channel: ImageStudioChannel | undefined, model: string) {
  return channel?.models[model];
}

export function imageStudioChannelUnitCredits(
  capability: ImageStudioChannelModel | undefined,
  legacyRoute: boolean,
  effectiveChannelId: string,
  legacyPrice: number | null | undefined,
) {
  const price = legacyRoute ? legacyPrice : capability?.billingMode === 'fixed'
    ? capability.fixedPoints ?? (['shared', 'banana'].includes(effectiveChannelId) ? legacyPrice : null)
    : null;
  return typeof price === 'number' && Number.isFinite(price) && price >= 0 ? price : null;
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

  const originalRouteId = imageStudioDefaultChannelId(channels, model);
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
      label: `后台默认 · ${route.label}`,
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
  legacyRoute?: boolean;
}) {
  if (!channel || !channel.configured || !channel.enabled) {
    return channel?.disabledReason || `${channel?.label || '所选生图通道'}未配置或已停用，请联系管理员。`;
  }
  if (channel.id === ORIGINAL_IMAGE_CHANNEL_ID && values.legacyRoute !== false) {
    return values.legacyReady === false ? '当前模型的原接口尚未就绪，请联系管理员检查接口。' : null;
  }
  const capability = imageStudioChannelModel(channel, model);
  const allowsUnconfirmedParameters = model === 'gemini-3-pro-image-preview' && capability?.allowsUnconfirmedParameters === true;
  if (channel.id === ORIGINAL_IMAGE_CHANNEL_ID && !capability && values.legacyRoute !== false) {
    return values.legacyReady === false ? '当前模型的原接口尚未就绪，请联系管理员检查接口。' : null;
  }
  if (capability) {
    const missing = [
      !allowsUnconfirmedParameters && !capability.qualities?.length ? '图片质量' : null,
      !allowsUnconfirmedParameters && !capability.resolutions?.length ? '分辨率' : null,
      !allowsUnconfirmedParameters && capability.maxReferences == null ? '参考图上限' : null,
      !capability.billingMode ? '计费方式' : null,
      capability.billingMode === 'fixed' && capability.fixedPoints == null
        && !['shared', 'banana'].includes(channel.id) ? '固定点数' : null,
    ].filter(Boolean);
    if (missing.length) return `${model} 的当前供应商尚未确认${missing.join('、')}。当前选择和素材已保留，请管理员补齐该型号配置。`;
  }
  if (!channel.ready) return channel.disabledReason || `${channel.label}暂未就绪，请联系管理员。`;
  if (!capability || !capability.ready) return capability?.disabledReason || '当前供应商的所选型号尚未就绪；当前选择和素材已保留，请联系管理员检查配置。';
  if (!capability.billingMode) return '当前生图通道的计费方式尚未确认，暂不能生成；请联系管理员检查配置。';
  if (capability.billingMode === 'fixed' && capability.fixedPoints == null
    && channel.id !== 'shared' && channel.id !== 'banana') {
    return '当前生图通道的固定点数尚未配置，暂不能生成；请联系管理员检查配置。';
  }
  if (capability.qualities && (!capability.qualities.length || values.quality !== undefined && !capability.qualities.includes(values.quality))) {
    return '当前生图通道不支持所选图片质量，请手动调整后再生成。';
  }
  if (capability.resolutions && (!capability.resolutions.length || values.resolution !== undefined && !capability.resolutions.includes(values.resolution))) {
    return '当前生图通道不支持所选分辨率，请手动调整后再生成。';
  }
  if (values.ratio !== undefined && !isStandardStudioRatio(values.ratio) && !capability.ratios?.some(value => {
    try { return normalizeStudioRatio(value) === normalizeStudioRatio(values.ratio); } catch { return false; }
  })) {
    return '当前生图通道不支持所选比例，请手动调整后再生成。';
  }
  if (!allowsUnconfirmedParameters && (!capability.qualities || !capability.resolutions || capability.maxReferences == null)) {
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
  if (channel.id === ORIGINAL_IMAGE_CHANNEL_ID) return legacyReady !== false && channel.models[model]?.ready !== false;
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
    const id = saved;
    if (unavailable) message = `${selected?.label || '上次选择的生图通道'}已不可用，请手动选择供应商或使用后台默认；未自动改换供应商。`;
    setSelection({ scope, id, ready: true, message });
  }, [scope, channels, sourceReady]);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== scope || !sourceReady) return;
      const requested = event.newValue && channelId(event.newValue) ? event.newValue : ORIGINAL_IMAGE_CHANNEL_ID;
      const selected = channels.items.find(item => item.id === requested);
      const unavailable = requested !== ORIGINAL_IMAGE_CHANNEL_ID && !imageStudioChannelCanBeSelected(selected);
      setSelection({ scope, id: requested, ready: true,
        message: unavailable ? `${selected?.label || '上次选择的生图通道'}已不可用，请手动选择供应商或使用后台默认；未自动改换供应商。` : '' });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [scope, channels, sourceReady]);
  const id = selection.scope === scope ? selection.id : ORIGINAL_IMAGE_CHANNEL_ID;
  const channel = channels.items.find(item => item.id === id);
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
