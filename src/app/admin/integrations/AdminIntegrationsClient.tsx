'use client';

import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import PageBanner from '@/components/PageBanner';
import { useProductDialog } from '@/components/useProductDialog';
import { useSettingsPageSubmit } from '@/lib/hooks/use-settings-page-submit';
import { RelativeTime } from '@/components/RelativeTime';
import { LoadingSkeleton } from '@/components/LoadingState';
import BananaImageChannel from './BananaImageChannel';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import { displayUserSubtitle } from '@/lib/users/display';
import { VOLCENGINE_IP_MODEL_OPTIONS } from '@/lib/integrations/volcengine-ip-models';
import {
  IMAGE_STUDIO_MODELS,
  IMAGE_STUDIO_MODEL_LABELS,
  IMAGE_STUDIO_MODEL_QUALITY_OPTIONS,
  IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS,
  type ImageStudioModel,
} from '@/lib/image-studio/model-catalog';
import { STUDIO_RATIOS } from '@/lib/image-studio/ratios';
import { useAppSession } from '@/lib/context/AppSessionContext';

type UserSelectorType = 'id' | 'email' | 'username';

type CodexConfig = {
  enabled: boolean;
  ready: boolean;
  source_label: string;
  user_selector: {
    type: UserSelectorType;
    value: string;
  };
  token_configured: boolean;
  token_preview: string | null;
  linked_user: {
    id: string;
    name: string;
    username: string;
    email: string;
    avatar_url?: string | null;
    account_type?: string | null;
    role: string;
    status: string;
  } | null;
};

type MuskConfig = {
  enabled: boolean;
  ready: boolean;
  base_url: string;
  default_model: string;
  api_key_configured: boolean;
};

type ImageGenerationProvider = 'musk' | 'ai_media_vip' | 'seedream';

type ImageGenerationConfig = {
  enabled: boolean;
  ready: boolean;
  provider: ImageGenerationProvider;
  base_url: string;
  default_model: string;
  api_key_configured: boolean;
  timeout_ms: number;
  max_outputs_per_request: number;
  default_ratio: string;
  default_size: '1K' | '2K';
  output_format: 'png' | 'jpeg';
  response_format: 'url' | 'b64_json';
  watermark: boolean;
  supports_text_to_image: boolean;
  supports_image_to_image: boolean;
  supports_async_task: boolean;
};

type ManagedImageModel = {
  enabled: boolean;
  protocol?: 'gemini_native' | 'openai_images';
  upstreamModel?: string | null;
  baseUrl?: string | null;
  apiKeyConfigured?: boolean;
  apiKeyOverrideConfigured?: boolean;
  ready: boolean;
  disabledReason: string | null;
  billingMode: 'fixed' | 'actual' | null;
  fixedPoints: number | null;
  billingSource: string | null;
  actualQuoteRequired: boolean;
  qualities: string[] | null;
  resolutions: string[] | null;
  ratios: string[] | null;
  maxReferences: number | null;
};

type ManagedImageChannel = {
  id: string;
  label: string;
  supplierName: string;
  supplierKind: 'fluxport' | 'musk' | 'other';
  protocol: 'gemini_native' | 'openai_images' | 'mixed';
  baseUrl: string;
  enabled: boolean;
  deleted: boolean;
  configRevision: string | null;
  apiKeyConfigured: boolean;
  models: Partial<Record<ImageStudioModel, ManagedImageModel>>;
};

type ImageGenerationChannelDto = {
  id: string;
  label: string;
  supplierName: string;
  enabled: boolean;
  configured: boolean;
  ready: boolean;
  disabledReason: string | null;
  deleted?: boolean;
  models: Partial<Record<ImageStudioModel, {
    ready: boolean;
    disabledReason: string | null;
    qualities?: string[] | null;
    resolutions?: string[] | null;
    ratios?: string[] | null;
    maxReferences?: number | null;
    billingMode?: 'fixed' | 'actual' | null;
    fixedPoints?: number | null;
    actualQuoteRequired?: boolean;
  }>>;
};

type ImageGenerationDefaultRoutes = {
  revision: number;
  models: Partial<Record<ImageStudioModel, string>>;
};

type StoredImageRoutePreference = {
  version: 1;
  model: ImageStudioModel;
  channelId: string | null;
};

type ChannelCapabilityDraft = {
  enabled: boolean;
  protocol: 'gemini_native' | 'openai_images';
  upstreamModel: string;
  baseUrl: string;
  apiKey: string;
  clearApiKey: boolean;
  clearOverrides?: boolean;
  qualities: string;
  resolutions: string;
  ratios: string;
  maxReferences: string;
  billingMode: '' | 'fixed' | 'actual';
  fixedPoints: string;
};

type ManagedChannelDraft = {
  id?: string;
  expectedRevision?: string | null;
  editingModel?: ImageStudioModel;
  label: string;
  supplierName: string;
  supplierKind: 'musk' | 'other' | 'fluxport';
  protocol: 'gemini_native' | 'openai_images' | 'mixed';
  baseUrl: string;
  enabled: boolean;
  apiKey: string;
  clearApiKey: boolean;
  models: Record<ImageStudioModel, ChannelCapabilityDraft>;
};

type VolcengineIpConfig = {
  enabled: boolean;
  ready: boolean;
  provider: 'volcengine_ip';
  base_url: string;
  create_task_path: string;
  default_model: string;
  model: string;
  api_key_configured: boolean;
  model_configured: boolean;
  missing: Array<'api_key' | 'model'>;
};

type AiMediaKitConfig = {
  enabled: boolean;
  ready: boolean;
  provider: 'aimediakit_enhance_video';
  base_url: string;
  enhance_video_path: string;
  task_status_path: string;
  request_upload_path: string;
  api_key_configured: boolean;
  missing: Array<'api_key'>;
};

type H3Config = {
  enabled: boolean;
  ready: boolean;
  configured: boolean;
  admin_queue_ready: boolean;
  provider: 'h3_video';
  base_url: string;
  health_path: string;
  presets_path: string;
  generate_path: string;
  default_preset_id: 'lightx2v_4step_turbo' | 'larry_v4_6step' | 'larry_v4_8step';
  default_lora_id: 'lightx2v_turbo_lora' | 'larry_v4_turbo_lora';
  preset_options: Array<{
    id: 'lightx2v_4step_turbo' | 'larry_v4_6step' | 'larry_v4_8step';
    label: string;
    detail: string;
  }>;
  lora_options: Array<{
    id: 'lightx2v_turbo_lora' | 'larry_v4_turbo_lora';
    label: string;
    detail: string;
  }>;
  api_token_configured: boolean;
  admin_token_configured: boolean;
  health: {
    api: string | null;
    worker: string | null;
    comfyui: string | null;
    worker_url: string | null;
    preset_count: number | null;
    checked_at: string | null;
  } | null;
  missing: Array<'api_token' | 'preset'>;
};

type SubmitState = {
  type: 'success' | 'error';
  message: string;
} | null;

type MuskTestState = {
  type: 'success' | 'error';
  message: string;
  model?: string;
  latency_ms?: number;
  tested_at?: string;
} | null;

type H3TestState = {
  type: 'success' | 'error';
  message: string;
  tested_at?: string;
  health_api?: string;
  worker?: string;
  comfyui?: string;
} | null;

const EMPTY_CONFIG: CodexConfig = {
  enabled: false,
  ready: false,
  source_label: 'Codex API',
  user_selector: {
    type: 'email',
    value: 'admin@local.test',
  },
  token_configured: false,
  token_preview: null,
  linked_user: null,
};

const EMPTY_MUSK_CONFIG: MuskConfig = {
  enabled: false,
  ready: false,
  base_url: 'https://api.muskapis.com/',
  default_model: 'gpt-5.5',
  api_key_configured: false,
};

const EMPTY_IMAGE_GENERATION_CONFIG: ImageGenerationConfig = {
  enabled: false,
  ready: false,
  provider: 'musk',
  base_url: 'https://api.muskapis.com/',
  default_model: 'gemini-3.1-flash-image-preview',
  api_key_configured: false,
  timeout_ms: 90000,
  max_outputs_per_request: 1,
  default_ratio: '16:9',
  default_size: '2K',
  output_format: 'png',
  response_format: 'url',
  watermark: false,
  supports_text_to_image: true,
  supports_image_to_image: true,
  supports_async_task: false,
};

const IMAGE_CHANNEL_OPTIONS: Array<{
  provider: ImageGenerationProvider;
  label: string;
  baseUrl: string;
  model: string;
}> = [
  { provider: 'musk', label: 'MuskAPI', baseUrl: 'https://api.muskapis.com/', model: 'gemini-3.1-flash-image-preview' },
  { provider: 'ai_media_vip', label: 'AI Media VIP', baseUrl: 'https://api.ai-media.vip/v1/', model: 'gemini-3.1-flash-image-preview' },
  { provider: 'seedream', label: 'Seedream 5.0 Pro（兼容旧资产接口）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seedream-5-0-pro-260628' },
];

const IMAGE_MODEL_OPTIONS: Array<{
  model: string;
  label: string;
  summary: string;
  tags: string[];
  maxOutputs: number;
  supportsAsyncTask: boolean;
  defaultSize: '1K' | '2K';
}> = [
  { model: IMAGE_STUDIO_MODELS[0], label: IMAGE_STUDIO_MODEL_LABELS[IMAGE_STUDIO_MODELS[0]], summary: '快速草图与通用参考图。', tags: ['文生图', '图生图'], maxOutputs: 8, supportsAsyncTask: false, defaultSize: '2K' },
  { model: IMAGE_STUDIO_MODELS[1], label: IMAGE_STUDIO_MODEL_LABELS[IMAGE_STUDIO_MODELS[1]], summary: '质量优先的专业参考图。', tags: ['文生图', '图生图'], maxOutputs: 8, supportsAsyncTask: false, defaultSize: '2K' },
  { model: IMAGE_STUDIO_MODELS[2], label: IMAGE_STUDIO_MODEL_LABELS[IMAGE_STUDIO_MODELS[2]], summary: 'GPT Image 2 通用图像生成。', tags: ['文生图', '图生图'], maxOutputs: 8, supportsAsyncTask: false, defaultSize: '2K' },
  { model: IMAGE_STUDIO_MODELS[3], label: IMAGE_STUDIO_MODEL_LABELS[IMAGE_STUDIO_MODELS[3]], summary: 'Flare 风格图像生成。', tags: ['文生图', '图生图'], maxOutputs: 8, supportsAsyncTask: false, defaultSize: '2K' },
  { model: IMAGE_STUDIO_MODELS[4], label: IMAGE_STUDIO_MODEL_LABELS[IMAGE_STUDIO_MODELS[4]], summary: 'Sunburst 风格图像生成。', tags: ['文生图', '图生图'], maxOutputs: 8, supportsAsyncTask: false, defaultSize: '2K' },
  { model: 'doubao-seedream-5-0-pro-260628', label: 'Seedream 5.0 Pro', summary: '兼容旧版资产生成与多参考图。', tags: ['最多 10 张参考图', '单张输出'], maxOutputs: 1, supportsAsyncTask: false, defaultSize: '2K' },
];

const IMAGE_API_ENDPOINT_OPTIONS = [
  { label: 'MuskAPI', value: 'https://api.muskapis.com/' },
  { label: 'AI Media VIP', value: 'https://api.ai-media.vip/v1/' },
] as const;

const IMAGE_ROUTE_PREFERENCE_STORAGE_KEY = 'sd2-admin-image-route-selection-v1';

function isImageStudioModel(value: unknown): value is ImageStudioModel {
  return typeof value === 'string' && (IMAGE_STUDIO_MODELS as readonly string[]).includes(value);
}

function parseImageGenerationDefaultRoutes(value: unknown): ImageGenerationDefaultRoutes | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as { revision?: unknown; models?: unknown };
  if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0 || !input.models || typeof input.models !== 'object') return null;
  const models: Partial<Record<ImageStudioModel, string>> = {};
  for (const model of IMAGE_STUDIO_MODELS) {
    const channelId = (input.models as Record<string, unknown>)[model];
    if (typeof channelId === 'string' && channelId.length > 0 && channelId !== 'original') models[model] = channelId;
  }
  return { revision: Number(input.revision), models };
}

function parseImageGenerationChannelOptions(value: unknown): ImageGenerationChannelDto[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const channel = item as Partial<ImageGenerationChannelDto>;
    if (typeof channel.id !== 'string' || channel.id === 'original' || typeof channel.label !== 'string'
      || typeof channel.supplierName !== 'string' || typeof channel.enabled !== 'boolean'
      || typeof channel.configured !== 'boolean' || typeof channel.ready !== 'boolean'
      || !channel.models || typeof channel.models !== 'object') return [];
    return [{
      id: channel.id,
      label: channel.label,
      supplierName: channel.supplierName,
      enabled: channel.enabled,
      configured: channel.configured,
      ready: channel.ready,
      disabledReason: typeof channel.disabledReason === 'string' ? channel.disabledReason : null,
      deleted: channel.deleted === true,
      models: channel.models,
    }];
  });
}

function originalImageChannelIdForModel(model: ImageStudioModel) {
  return model.startsWith('gemini-') ? 'banana' : 'shared';
}

function imageChannelStatus(channel: ImageGenerationChannelDto | undefined, model: ImageStudioModel) {
  if (!channel) return '配置不存在，不能用于新任务';
  if (channel.deleted) return channel.disabledReason || '已归档，不能用于新任务';
  if (!channel.enabled) return channel.disabledReason || '已停用，不能用于新任务';
  if (!channel.configured) return channel.disabledReason || '待配置，不能用于新任务';
  if (!channel.ready) return channel.disabledReason || '通道未就绪，不能用于新任务';
  const capability = channel.models[model];
  if (!capability) return '未配置此型号，不能用于新任务';
  if (!capability.ready) return capability.disabledReason || channel.disabledReason || '型号配置未就绪，不能用于新任务';
  return '型号配置已就绪';
}

const EMPTY_VOLCENGINE_IP_CONFIG: VolcengineIpConfig = {
  enabled: false,
  ready: false,
  provider: 'volcengine_ip',
  base_url: 'https://ark.cn-beijing.volces.com/api/v3',
  create_task_path: '/contents/generations/tasks',
  default_model: '',
  model: '',
  api_key_configured: false,
  model_configured: false,
  missing: ['api_key', 'model'],
};

const EMPTY_AIMEDIAKIT_CONFIG: AiMediaKitConfig = {
  enabled: false,
  ready: false,
  provider: 'aimediakit_enhance_video',
  base_url: 'https://mediakit.cn-beijing.volces.com',
  enhance_video_path: '/api/v1/tools/enhance-video',
  task_status_path: '/api/v1/tasks/{task_id}',
  request_upload_path: '/api/v1/tools-sync/request-media-upload-url',
  api_key_configured: false,
  missing: ['api_key'],
};

const EMPTY_H3_CONFIG: H3Config = {
  enabled: false,
  ready: false,
  configured: false,
  admin_queue_ready: false,
  provider: 'h3_video',
  base_url: 'http://127.0.0.1:8893',
  health_path: '/health',
  presets_path: '/api/h3/presets',
  generate_path: '/api/h3/generate',
  default_preset_id: 'lightx2v_4step_turbo',
  default_lora_id: 'lightx2v_turbo_lora',
  preset_options: [
    { id: 'lightx2v_4step_turbo', label: '推荐', detail: '默认 · 速度优先，显存风险更低' },
    { id: 'larry_v4_6step', label: '质量增强', detail: '质量更好但更慢，720P 长秒数有显存风险' },
    { id: 'larry_v4_8step', label: '画质优先', detail: '更多步数，更慢，适合谨慎测试' },
  ],
  lora_options: [
    { id: 'lightx2v_turbo_lora', label: 'LightX2V 快速 LoRA', detail: '默认 · 4-step turbo，显存压力更低，适合先跑通' },
    { id: 'larry_v4_turbo_lora', label: 'Larry 高质量 LoRA', detail: '画质优先，15 秒 16:9 场景显存风险更高' },
  ],
  api_token_configured: false,
  admin_token_configured: false,
  health: null,
  missing: ['api_token'],
};

function normalizeH3Config(value: unknown): H3Config {
  const input = value && typeof value === 'object' ? value as Partial<H3Config> : {};
  return {
    ...EMPTY_H3_CONFIG,
    ...input,
    preset_options: Array.isArray(input.preset_options) && input.preset_options.length > 0
      ? input.preset_options
      : EMPTY_H3_CONFIG.preset_options,
    lora_options: Array.isArray(input.lora_options) && input.lora_options.length > 0
      ? input.lora_options
      : EMPTY_H3_CONFIG.lora_options,
    default_lora_id: input.default_lora_id || EMPTY_H3_CONFIG.default_lora_id,
  };
}

function selectorLabel(type: UserSelectorType) {
  if (type === 'id') return '用户 ID';
  if (type === 'username') return '用户名';
  return '邮箱';
}

function linkedUserSubtitle(config: CodexConfig) {
  if (!config.linked_user) return '未匹配到用户';
  const user = config.linked_user;
  return `${displayUserSubtitle(user) || user.id.slice(0, 8)} · ${user.status}`;
}

function emptyChannelCapabilityDraft(): ChannelCapabilityDraft {
  return { enabled: false, protocol: 'openai_images', upstreamModel: '', baseUrl: '', apiKey: '', clearApiKey: false,
    qualities: '', resolutions: '', ratios: '', maxReferences: '', billingMode: '', fixedPoints: '' };
}

function emptyManagedChannelDraft(): ManagedChannelDraft {
  return {
    label: '', supplierName: '', supplierKind: 'other', protocol: 'openai_images', baseUrl: '',
    enabled: false, apiKey: '', clearApiKey: false,
    models: Object.fromEntries(IMAGE_STUDIO_MODELS.map(model => [model, emptyChannelCapabilityDraft()])) as Record<ImageStudioModel, ChannelCapabilityDraft>,
  };
}

function managedDraftModels(draft: ManagedChannelDraft) {
  return IMAGE_STUDIO_MODELS.filter(model => Boolean(draft.models[model]));
}

function managedDraftCapabilityMissingFields(capability: ChannelCapabilityDraft) {
  if (!capability.enabled) return [];
  const missing: string[] = [];
  if (!capability.qualities.trim()) missing.push('质量选项');
  if (!capability.resolutions.trim()) missing.push('分辨率');
  if (!capability.ratios.trim()) missing.push('图片比例');
  if (!capability.maxReferences.trim()) missing.push('参考图上限');
  if (!capability.billingMode) missing.push('计费方式');
  if (capability.billingMode === 'fixed' && !capability.fixedPoints.trim()) missing.push('每张点数');
  return missing;
}

function managedChannelCapabilityMissingFields(capability: ManagedImageModel | undefined) {
  if (!capability?.enabled) return [];
  const missing: string[] = [];
  if (!capability.qualities?.length) missing.push('质量选项');
  if (!capability.resolutions?.length) missing.push('分辨率');
  if (!capability.ratios?.length) missing.push('图片比例');
  if (capability.maxReferences === null) missing.push('参考图上限');
  if (!capability.billingMode) missing.push('计费方式');
  if (capability.billingMode === 'fixed' && capability.fixedPoints === null) missing.push('每张点数');
  if (capability.billingMode === 'actual' && !capability.actualQuoteRequired) missing.push('同一 Key 的账单证明');
  return missing;
}

function isManagedImageChannel(value: unknown): value is ManagedImageChannel {
  return Boolean(value && typeof value === 'object'
    && typeof (value as ManagedImageChannel).id === 'string'
    && typeof (value as ManagedImageChannel).enabled === 'boolean'
    && typeof (value as ManagedImageChannel).deleted === 'boolean'
    && (value as ManagedImageChannel).models && typeof (value as ManagedImageChannel).models === 'object');
}

function withManagedChannelReceipt(channels: ManagedImageChannel[], saved: ManagedImageChannel) {
  const index = channels.findIndex(channel => channel.id === saved.id);
  if (index < 0) return [...channels, saved];
  return channels.map(channel => channel.id === saved.id ? saved : channel);
}

function managedChannelReadyModels(channel: ManagedImageChannel) {
  return IMAGE_STUDIO_MODELS.filter(model => channel.models[model]?.ready).map(model => IMAGE_STUDIO_MODEL_LABELS[model]);
}

function managedChannelPendingModels(channel: ManagedImageChannel) {
  return IMAGE_STUDIO_MODELS.flatMap(model => {
    const capability = channel.models[model];
    if (!capability?.enabled || capability.ready) return [];
    const missing = managedChannelCapabilityMissingFields(capability);
    const reason = missing.length ? missing.join('、') : capability.disabledReason || '尚未就绪';
    return [`${IMAGE_STUDIO_MODEL_LABELS[model]}（${reason}）`];
  });
}

function managedChannelSaveMessage(channel: ManagedImageChannel, action: 'save' | 'update' | 'archive' | 'restore') {
  if (action === 'archive') return '配置已归档，已受理任务仍保留原修订。';
  if (action === 'restore') return '配置已恢复；恢复后仍处于停用状态。';
  const readyModels = managedChannelReadyModels(channel);
  const pendingModels = managedChannelPendingModels(channel);
  const pendingDetail = pendingModels.length ? `待补：${pendingModels.join('；')}。` : '';
  if (channel.enabled) {
    return readyModels.length
      ? `配置已保存并启用。当前可用于新任务的型号：${readyModels.join('、')}。${pendingDetail}`
      : `配置已保存并启用；当前没有就绪型号，暂不能用于新任务。${pendingDetail || '请按型号逐项补齐规格和计费信息。'}`;
  }
  return '配置已保存，当前通道处于停用状态。';
}

function managedChannelDraftFrom(channel: ManagedImageChannel): ManagedChannelDraft {
  return {
    id: channel.id,
    expectedRevision: channel.configRevision,
    label: channel.label,
    supplierName: channel.supplierName,
    supplierKind: channel.supplierKind,
    protocol: channel.protocol,
    baseUrl: channel.baseUrl,
    enabled: channel.enabled,
    apiKey: '',
    clearApiKey: false,
    models: Object.fromEntries(IMAGE_STUDIO_MODELS.map(model => {
      const capability = channel.models[model];
      return [model, {
        enabled: capability?.enabled === true,
        protocol: capability?.protocol || (channel.supplierKind === 'fluxport' && model.startsWith('gemini-')
          ? 'gemini_native' : channel.protocol === 'gemini_native' ? 'gemini_native' : 'openai_images'),
        upstreamModel: capability?.upstreamModel || '',
        baseUrl: capability?.baseUrl || '',
        apiKey: '',
        clearApiKey: false,
        qualities: capability?.qualities?.join(', ') || '',
        resolutions: capability?.resolutions?.join(', ') || '',
        ratios: capability?.ratios?.join(', ') || '',
        maxReferences: capability?.maxReferences === null || capability?.maxReferences === undefined ? '' : String(capability.maxReferences),
        billingMode: capability?.billingMode || '',
        fixedPoints: capability?.fixedPoints === null || capability?.fixedPoints === undefined ? '' : String(capability.fixedPoints),
      } satisfies ChannelCapabilityDraft];
    })) as Record<ImageStudioModel, ChannelCapabilityDraft>,
  };
}

export default function AdminIntegrationsClient() {
  const { confirm, productDialog } = useProductDialog();
  const { user: currentUser, hasLoadedUser, refreshUser } = useAppSession();
  const [config, setConfig] = useState<CodexConfig>(EMPTY_CONFIG);
  const [muskConfig, setMuskConfig] = useState<MuskConfig>(EMPTY_MUSK_CONFIG);
  const [imageConfig, setImageConfig] = useState<ImageGenerationConfig>(EMPTY_IMAGE_GENERATION_CONFIG);
  const [managedImageChannels, setManagedImageChannels] = useState<ManagedImageChannel[]>([]);
  const [imageChannels, setImageChannels] = useState<ImageGenerationChannelDto[] | null>(null);
  const [imageDefaultRoutes, setImageDefaultRoutes] = useState<ImageGenerationDefaultRoutes | null>(null);
  const [imageRouteDrafts, setImageRouteDrafts] = useState<Partial<Record<ImageStudioModel, string | null>>>({});
  const [selectedRouteModel, setSelectedRouteModel] = useState<ImageStudioModel>(IMAGE_STUDIO_MODELS[0]);
  const [routePreferenceUserId, setRoutePreferenceUserId] = useState<string | null>(null);
  const [routePreferenceNotice, setRoutePreferenceNotice] = useState('');
  const [routeSaving, setRouteSaving] = useState(false);
  const [routeReading, setRouteReading] = useState(false);
  const [routeOutcomeUnknown, setRouteOutcomeUnknown] = useState(false);
  const [routeOutcomeMessage, setRouteOutcomeMessage] = useState('');
  const [channelManagementOpen, setChannelManagementOpen] = useState(false);
  const [managedChannelDraft, setManagedChannelDraft] = useState<ManagedChannelDraft | null>(null);
  const [fluxportFlareFixedPointsPreset, setFluxportFlareFixedPointsPreset] = useState<number | null>(null);
  const [managedChannelOutcomeUnknown, setManagedChannelOutcomeUnknown] = useState(false);
  const [managedChannelReReadSucceeded, setManagedChannelReReadSucceeded] = useState(false);
  const [managedChannelOutcomeMessage, setManagedChannelOutcomeMessage] = useState('');
  const [volcengineConfig, setVolcengineConfig] = useState<VolcengineIpConfig>(EMPTY_VOLCENGINE_IP_CONFIG);
  const [aiMediaKitConfig, setAiMediaKitConfig] = useState<AiMediaKitConfig>(EMPTY_AIMEDIAKIT_CONFIG);
  const [h3Config, setH3Config] = useState<H3Config>(EMPTY_H3_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [muskSaving, setMuskSaving] = useState(false);
  const [muskTesting, setMuskTesting] = useState(false);
  const [imageSaving, setImageSaving] = useState(false);
  const [managedChannelSaving, setManagedChannelSaving] = useState(false);
  const [volcengineSaving, setVolcengineSaving] = useState(false);
  const [aiMediaKitSaving, setAiMediaKitSaving] = useState(false);
  const [h3Saving, setH3Saving] = useState(false);
  const [h3Testing, setH3Testing] = useState(false);
  const [token, setToken] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [muskApiKey, setMuskApiKey] = useState('');
  const [clearMuskApiKey, setClearMuskApiKey] = useState(false);
  const [imageApiKey, setImageApiKey] = useState('');
  const [clearImageApiKey, setClearImageApiKey] = useState(false);
  const [volcengineApiKey, setVolcengineApiKey] = useState('');
  const [clearVolcengineApiKey, setClearVolcengineApiKey] = useState(false);
  const [aiMediaKitApiKey, setAiMediaKitApiKey] = useState('');
  const [clearAiMediaKitApiKey, setClearAiMediaKitApiKey] = useState(false);
  const [h3ApiToken, setH3ApiToken] = useState('');
  const [h3AdminToken, setH3AdminToken] = useState('');
  const [clearH3ApiToken, setClearH3ApiToken] = useState(false);
  const [clearH3AdminToken, setClearH3AdminToken] = useState(false);
  const [submitState, setSubmitState] = useState<SubmitState>(null);
  const [muskTestState, setMuskTestState] = useState<MuskTestState>(null);
  const [h3TestState, setH3TestState] = useState<H3TestState>(null);
  const [h3QueueOpen, setH3QueueOpen] = useState(false);
  const [h3QueueLoading, setH3QueueLoading] = useState(false);
  const [h3QueueState, setH3QueueState] = useState<unknown>(null);
  const [h3QueueAction, setH3QueueAction] = useState<'pause' | 'resume' | 'cancel' | 'stop' | 'move'>('pause');
  const [h3QueueJobId, setH3QueueJobId] = useState('');
  const [h3QueueDirection, setH3QueueDirection] = useState<'top' | 'up' | 'down' | 'bottom'>('top');
  const [h3QueueReason, setH3QueueReason] = useState('');
  const [h3QueueMessage, setH3QueueMessage] = useState<SubmitState>(null);
  const [bananaDirty, setBananaDirty] = useState(false);
  const imageConfigBaseline = useRef('');
  const managedChannelDraftBaseline = useRef('');
  const routePreferenceHydratedUserId = useRef<string | null>(null);
  const currentUserIdRef = useRef<string | null>(currentUser?.id ?? null);
  currentUserIdRef.current = currentUser?.id ?? null;
  const routeRequestSequence = useRef(0);
  const previousRouteAccountId = useRef<string | null>(currentUser?.id ?? null);
  const routePreferencesReady = !imageDefaultRoutes || imageChannels === null || !hasLoadedUser || (currentUser?.id
    ? routePreferenceUserId === currentUser.id
    : routePreferenceUserId === 'anonymous');
  const routeDraftSnapshot = Object.fromEntries(IMAGE_STUDIO_MODELS.map(model => [
    `imageRoute:${model}`,
    imageRouteDrafts[model] ?? null,
  ]));
  const settingsSubmit = useSettingsPageSubmit({
    codex: { config, entered: Boolean(token), clearToken },
    musk: { config: muskConfig, entered: Boolean(muskApiKey), clearMuskApiKey },
    image: { config: imageConfig, entered: Boolean(imageApiKey), clearImageApiKey },
    managedChannel: { config: managedChannelDraft, entered: Boolean(managedChannelDraft?.apiKey.trim()), clearApiKey: managedChannelDraft?.clearApiKey },
    volcengine: { config: volcengineConfig, entered: Boolean(volcengineApiKey), clearVolcengineApiKey },
    mediakit: { config: aiMediaKitConfig, entered: Boolean(aiMediaKitApiKey), clearAiMediaKitApiKey },
    h3: { config: h3Config, apiEntered: Boolean(h3ApiToken), adminEntered: Boolean(h3AdminToken), clearH3ApiToken, clearH3AdminToken },
    banana: bananaDirty,
    ...routeDraftSnapshot,
  }, !loading, '/admin', confirm, muskTesting || h3Testing || h3QueueLoading || managedChannelSaving || routeSaving || routeReading);

  useEffect(() => {
    if (!hasLoadedUser) void refreshUser();
  }, [hasLoadedUser, refreshUser]);

  useEffect(() => {
    const userId = currentUser?.id ?? null;
    if (previousRouteAccountId.current === userId) return;
    previousRouteAccountId.current = userId;
    routeRequestSequence.current += 1;
    setRouteSaving(false);
    setRouteReading(false);
    setRouteOutcomeUnknown(false);
    setRouteOutcomeMessage('');
  }, [currentUser?.id]);

  useEffect(() => {
    if (!imageDefaultRoutes || imageChannels === null || !hasLoadedUser) return;
    const userId = currentUser?.id;
    if (!userId) {
      if (routePreferenceHydratedUserId.current !== 'anonymous') {
        setSelectedRouteModel(IMAGE_STUDIO_MODELS[0]);
        setImageRouteDrafts(Object.fromEntries(IMAGE_STUDIO_MODELS.map(model => [model, imageDefaultRoutes.models[model] ?? null])) as Partial<Record<ImageStudioModel, string | null>>);
      }
      routePreferenceHydratedUserId.current = 'anonymous';
      setRoutePreferenceUserId('anonymous');
      return;
    }
    if (routePreferenceHydratedUserId.current === userId) {
      setRoutePreferenceUserId(userId);
      return;
    }

    let stored: StoredImageRoutePreference | null = null;
    try {
      const raw = window.localStorage.getItem(`${IMAGE_ROUTE_PREFERENCE_STORAGE_KEY}:${userId}`);
      const parsed = raw ? JSON.parse(raw) as Partial<StoredImageRoutePreference> : null;
      if (parsed?.version === 1 && isImageStudioModel(parsed.model)
        && (parsed.channelId === null || typeof parsed.channelId === 'string')) {
        stored = { version: 1, model: parsed.model, channelId: parsed.channelId };
      }
    } catch {
      setRoutePreferenceNotice('本机无法读取上次模型与供应商选择，本次仍可正常设置。');
    }

    const channelExistsForModel = stored?.channelId === null || Boolean(stored && imageChannels.some(channel =>
      channel.id === stored!.channelId));
    const validPreference = stored && channelExistsForModel ? stored : null;
    setSelectedRouteModel(validPreference?.model || IMAGE_STUDIO_MODELS[0]);
    const nextDrafts = Object.fromEntries(IMAGE_STUDIO_MODELS.map(model => [model, imageDefaultRoutes.models[model] ?? null])) as Partial<Record<ImageStudioModel, string | null>>;
    if (validPreference) nextDrafts[validPreference.model] = validPreference.channelId;
    setImageRouteDrafts(nextDrafts);
    routePreferenceHydratedUserId.current = userId;
    setRoutePreferenceUserId(userId);
  }, [currentUser?.id, hasLoadedUser, imageChannels, imageDefaultRoutes]);

  useEffect(() => {
    const userId = currentUser?.id;
    if (!userId || routePreferenceUserId !== userId || !imageDefaultRoutes || imageChannels === null) return;
    try {
      const preference: StoredImageRoutePreference = {
        version: 1,
        model: selectedRouteModel,
        channelId: imageRouteDrafts[selectedRouteModel] ?? null,
      };
      window.localStorage.setItem(`${IMAGE_ROUTE_PREFERENCE_STORAGE_KEY}:${userId}`, JSON.stringify(preference));
      setRoutePreferenceNotice('');
    } catch {
      setRoutePreferenceNotice('本机无法记住上次模型与供应商选择，本次设置仍保留在当前页面。');
    }
  }, [currentUser?.id, imageChannels, imageDefaultRoutes, imageRouteDrafts, routePreferenceUserId, selectedRouteModel]);

  const statusText = useMemo(() => {
    if (config.ready) return '已启用，可被 Codex 调用';
    if (!config.enabled) return '未启用';
    if (!config.token_configured) return '缺少 token';
    if (!config.linked_user) return '绑定用户无效';
    return '配置未就绪';
  }, [config]);

  const muskStatusText = useMemo(() => {
    if (muskConfig.ready) return '已启用';
    if (!muskConfig.enabled) return '未启用';
    if (!muskConfig.base_url) return '缺少 API 地址';
    if (!muskConfig.default_model) return '缺少默认模型';
    if (!muskConfig.api_key_configured) return '缺少 API Key';
    return '配置未就绪';
  }, [muskConfig]);

  const imageStatusText = useMemo(() => {
    if (imageConfig.ready) return '已启用';
    if (!imageConfig.enabled) return '未启用';
    if (!imageConfig.base_url) return '缺少 API 地址';
    if (!imageConfig.default_model) return '缺少默认模型';
    if (!imageConfig.api_key_configured) return '缺少 API Key';
    return '配置未就绪';
  }, [imageConfig]);

  const selectedImageModel = useMemo(
    () => IMAGE_MODEL_OPTIONS.find((option) => option.model === imageConfig.default_model) || IMAGE_MODEL_OPTIONS[0],
    [imageConfig.default_model],
  );
  const selectedImageChannel = useMemo(
    () => IMAGE_CHANNEL_OPTIONS.find((option) => option.provider === imageConfig.provider) || IMAGE_CHANNEL_OPTIONS[0],
    [imageConfig.provider],
  );
  const isSeedreamImageModel = imageConfig.provider === 'seedream';
  const imageRouteServerChoice = imageDefaultRoutes?.models[selectedRouteModel] ?? null;
  const imageRouteCurrentChoice = imageRouteDrafts[selectedRouteModel] ?? null;
  const imageRouteCurrentChannelId = imageRouteCurrentChoice ?? originalImageChannelIdForModel(selectedRouteModel);
  const imageRouteCurrentChannel = imageChannels?.find(channel => channel.id === imageRouteCurrentChannelId);
  const imageRouteDefaultActualChannel = imageChannels?.find(channel => channel.id === originalImageChannelIdForModel(selectedRouteModel));
  const sharedSupplierName = IMAGE_CHANNEL_OPTIONS.find(option => option.provider === imageConfig.provider)?.label
    || imageRouteCurrentChannel?.supplierName
    || '共享图形 API';
  const selectedManagedImageChannel = managedImageChannels.find(channel => channel.id === imageRouteCurrentChannelId);
  const selectedManagedModelCapability = selectedManagedImageChannel?.models[selectedRouteModel];
  const imageRouteHasChanges = imageRouteCurrentChoice !== imageRouteServerChoice;

  const volcengineStatusText = useMemo(() => {
    if (volcengineConfig.ready) return '已启用';
    if (!volcengineConfig.enabled) return '未启用';
    if (!volcengineConfig.base_url) return '缺少 API 地址';
    if (!volcengineConfig.default_model) return '缺少 Model ID';
    if (!volcengineConfig.api_key_configured) return '缺少 API Key';
    return '配置未就绪';
  }, [volcengineConfig]);

  const aiMediaKitStatusText = useMemo(() => {
    if (aiMediaKitConfig.ready) return '已启用';
    if (!aiMediaKitConfig.enabled) return '未启用';
    if (!aiMediaKitConfig.base_url) return '缺少 API 地址';
    if (!aiMediaKitConfig.api_key_configured) return '缺少 API Key';
    return '配置未就绪';
  }, [aiMediaKitConfig]);

  const h3StatusText = useMemo(() => {
    if (h3Config.ready) return '已启用';
    if (!h3Config.enabled) return '未启用';
    if (!h3Config.base_url) return '缺少 API 地址';
    if (!h3Config.api_token_configured) return '缺少用户 token';
    if (!h3Config.configured) return '配置未就绪';
    if (!h3Config.health) return '待测试连接';
    return '健康检查未通过';
  }, [h3Config]);

  const managedDraftModelsForSummary = managedChannelDraft
    ? managedDraftModels(managedChannelDraft).filter(model => model === selectedRouteModel)
    : [];
  const managedDraftSelectedCount = managedChannelDraft
    ? managedDraftModelsForSummary.filter(model => managedChannelDraft.models[model].enabled).length
    : 0;
  const managedDraftIncompleteModels = managedChannelDraft
    ? managedDraftModelsForSummary.flatMap(model => {
      const missing = managedDraftCapabilityMissingFields(managedChannelDraft.models[model]);
      return missing.length ? [`${IMAGE_STUDIO_MODEL_LABELS[model]}（${missing.join('、')}）`] : [];
    })
    : [];
  const managedDraftUsesActualBilling = managedChannelDraft
    ? managedDraftModelsForSummary.some(model => managedChannelDraft.models[model].enabled && managedChannelDraft.models[model].billingMode === 'actual')
    : false;

  const markManagedChannelOutcomeUnknown = (message: string) => {
    setManagedChannelOutcomeUnknown(true);
    setManagedChannelReReadSucceeded(false);
    setManagedChannelOutcomeMessage(message);
    setSubmitState({ type: 'error', message });
  };

  const loadConfig = async () => {
    try {
      const [codexRes, muskRes, imageRes, volcengineRes, aiMediaKitRes, h3Res] = await Promise.all([
        fetch('/api/admin/integrations/codex', { cache: 'no-store' }),
        fetch('/api/admin/integrations/musk', { cache: 'no-store' }),
        fetch('/api/admin/integrations/image-generation', { cache: 'no-store' }),
        fetch('/api/admin/integrations/volcengine-ip', { cache: 'no-store' }),
        fetch('/api/admin/integrations/aimediakit', { cache: 'no-store' }),
        fetch('/api/admin/integrations/h3', { cache: 'no-store' }),
      ]);
      const [codexData, muskData, imageData, volcengineData, aiMediaKitData, h3Data] = await Promise.all([
        codexRes.json(),
        muskRes.json(),
        imageRes.json(),
        volcengineRes.json(),
        aiMediaKitRes.json(),
        h3Res.json(),
      ]);

      if (!codexRes.ok) {
        setSubmitState({ type: 'error', message: codexData.error || '读取 Codex 配置失败' });
        return;
      }
      if (!muskRes.ok) {
        setSubmitState({ type: 'error', message: muskData.error || '读取 Musk API 配置失败' });
        return;
      }
      if (!imageRes.ok) {
        setSubmitState({ type: 'error', message: imageData.error || '读取图形生成 API 配置失败' });
        return;
      }
      if (!volcengineRes.ok) {
        setSubmitState({ type: 'error', message: volcengineData.error || '读取火山 IP 生成配置失败' });
        return;
      }
      if (!aiMediaKitRes.ok) {
        setSubmitState({ type: 'error', message: aiMediaKitData.error || '读取 AI MediaKit 配置失败' });
        return;
      }
      if (!h3Res.ok) {
        setSubmitState({ type: 'error', message: h3Data.error || '读取 H3 配置失败' });
        return;
      }
      setConfig(codexData.config || EMPTY_CONFIG);
      setMuskConfig(muskData.config || EMPTY_MUSK_CONFIG);
      const loadedImageConfig = imageData.config || EMPTY_IMAGE_GENERATION_CONFIG;
      setImageConfig(loadedImageConfig);
      imageConfigBaseline.current = JSON.stringify(loadedImageConfig);
      setManagedImageChannels(Array.isArray(imageData.channels) ? imageData.channels : []);
      const imageChannelsData = imageData.imageChannels && typeof imageData.imageChannels === 'object'
        ? imageData.imageChannels as { items?: unknown; defaultRoutes?: unknown }
        : null;
      const loadedImageRoutes = parseImageGenerationDefaultRoutes(imageData.defaultRoutes ?? imageChannelsData?.defaultRoutes);
      const loadedImageChannelOptions = parseImageGenerationChannelOptions(imageChannelsData?.items);
      setImageDefaultRoutes(loadedImageRoutes);
      setImageChannels(loadedImageChannelOptions);
      if (loadedImageRoutes) {
        setImageRouteDrafts(Object.fromEntries(IMAGE_STUDIO_MODELS.map(model => [
          model,
          loadedImageRoutes.models[model] ?? null,
        ])) as Partial<Record<ImageStudioModel, string | null>>);
      }
      const flareFixedPoints = imageData.managedChannelPresets?.fluxportFlareFixedPoints;
      setFluxportFlareFixedPointsPreset(Number.isSafeInteger(flareFixedPoints) && flareFixedPoints >= 0 ? flareFixedPoints : null);
      setVolcengineConfig(volcengineData.config || EMPTY_VOLCENGINE_IP_CONFIG);
      setAiMediaKitConfig(aiMediaKitData.config || EMPTY_AIMEDIAKIT_CONFIG);
      setH3Config(normalizeH3Config(h3Data.config));
    } catch (error) {
      setSubmitState({ type: 'error', message: error instanceof Error ? error.message : '读取配置失败' });
    } finally {
      setLoading(false);
    }
  };

  const readImageRouteConfig = async () => {
    const response = await fetch('/api/admin/integrations/image-generation', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '重新读取图片供应商配置失败');
    const imageChannelsData = data.imageChannels && typeof data.imageChannels === 'object'
      ? data.imageChannels as { items?: unknown; defaultRoutes?: unknown }
      : null;
    const routes = parseImageGenerationDefaultRoutes(data.defaultRoutes ?? imageChannelsData?.defaultRoutes);
    if (!routes) throw new Error('没有收到可核对的图片默认供应商配置');
    return {
      routes,
      channels: parseImageGenerationChannelOptions(imageChannelsData?.items),
      managedChannels: Array.isArray(data.channels) ? data.channels.filter(isManagedImageChannel) : null,
      data,
    };
  };

  const applyImageRouteRead = (
    routes: ImageGenerationDefaultRoutes,
    channels: ImageGenerationChannelDto[] | null,
    preserveDraftModel?: ImageStudioModel,
  ) => {
    const previousRoutes = imageDefaultRoutes;
    setImageDefaultRoutes(routes);
    if (channels) setImageChannels(channels);
    setImageRouteDrafts(current => Object.fromEntries(IMAGE_STUDIO_MODELS.map(model => {
      const previousDraft = current[model] ?? null;
      const previousDefault = previousRoutes?.models[model] ?? null;
      const keepDraft = model === preserveDraftModel || previousDraft !== previousDefault;
      return [model, keepDraft ? previousDraft : routes.models[model] ?? null];
    })) as Partial<Record<ImageStudioModel, string | null>>);
  };

  const reReadImageRouteAfterUnknown = async () => {
    const requestId = ++routeRequestSequence.current;
    const requestUserId = currentUserIdRef.current;
    const requestIsCurrent = () => routeRequestSequence.current === requestId && currentUserIdRef.current === requestUserId;
    setRouteReading(true);
    try {
      const result = await readImageRouteConfig();
      if (!requestIsCurrent()) return;
      const observedChoice = result.routes.models[selectedRouteModel] ?? null;
      const requestedChoice = imageRouteDrafts[selectedRouteModel] ?? null;
      applyImageRouteRead(result.routes, result.channels, selectedRouteModel);
      if (result.managedChannels) setManagedImageChannels(result.managedChannels);
      setRouteOutcomeUnknown(false);
      setRouteOutcomeMessage('');
      if (observedChoice === requestedChoice) {
        setImageRouteDrafts(current => ({ ...current, [selectedRouteModel]: observedChoice }));
        setSubmitState({ type: 'success', message: '已从后台配置核对到该模型的默认供应商已更新。' });
      } else {
        setSubmitState({ type: 'error', message: '已重新读取：后台默认供应商未变，当前选择仍保留为未保存草稿，可核对后再保存。' });
      }
    } catch (error) {
      if (requestIsCurrent()) setRouteOutcomeMessage(error instanceof Error ? error.message : '重新读取失败，保存结果仍未确认。');
    } finally {
      if (requestIsCurrent()) setRouteReading(false);
    }
  };

  const saveImageDefaultRoute = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!routePreferencesReady || !imageDefaultRoutes || !imageChannels || routeOutcomeUnknown || !settingsSubmit.start()) return;
    let saved = false;
    let requestSent = false;
    setRouteSaving(true);
    setRouteOutcomeMessage('');
    setSubmitState(null);
    const channelId = imageRouteCurrentChoice;
    const model = selectedRouteModel;
    const requestId = ++routeRequestSequence.current;
    const requestUserId = currentUserIdRef.current;
    const requestIsCurrent = () => routeRequestSequence.current === requestId && currentUserIdRef.current === requestUserId;
    try {
      requestSent = true;
      const response = await fetch('/api/admin/integrations/image-generation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel_action: 'set-model-default',
          model,
          channelId,
          expectedRevision: imageDefaultRoutes.revision,
        }),
      });
      const data = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!requestIsCurrent()) return;
      const returnedRoutes = parseImageGenerationDefaultRoutes(data?.defaultRoutes);
      if (!response.ok) {
        if (response.status >= 500) {
          setRouteOutcomeUnknown(true);
          setRouteOutcomeMessage(`${typeof data?.error === 'string' ? data.error : '保存请求未确认完成'}。请重新读取后台结果；读取确认前不能重复提交。`);
        } else if (response.status === 409) {
          setRouteOutcomeMessage('后台默认设置已被更新。正在重新读取最新版本；当前选择会保留。');
          try {
            const result = await readImageRouteConfig();
            if (!requestIsCurrent()) return;
            applyImageRouteRead(result.routes, result.channels, model);
            if (result.managedChannels) setManagedImageChannels(result.managedChannels);
            setRouteOutcomeMessage('已读取最新版本。当前选择仍保留为草稿，可核对后再保存。');
          } catch {
            if (requestIsCurrent()) setRouteOutcomeMessage('后台默认设置已被更新，但最新版本暂时无法读取。当前选择已保留；请先重新读取后再保存。');
          }
        } else {
          setRouteOutcomeMessage(typeof data?.error === 'string' ? data.error : '保存默认供应商失败；当前选择仍保留。');
        }
        return;
      }
      if (!returnedRoutes || data?.ok !== true) {
        setRouteOutcomeUnknown(true);
        setRouteOutcomeMessage('请求已返回，但没有收到可核对的保存结果。请重新读取后台结果；读取确认前不能重复提交。');
        return;
      }
      applyImageRouteRead(returnedRoutes, imageChannels);
      setImageRouteDrafts(current => ({ ...current, [model]: returnedRoutes.models[model] ?? null }));
      setRouteOutcomeUnknown(false);
      setRouteOutcomeMessage('');
      setSubmitState({ type: 'success', message: '已保存。今后未主动另选供应商的新任务将使用此默认；用户主动选择仍优先。' });
      saved = true;
    } catch (error) {
      if (!requestIsCurrent()) return;
      if (requestSent) {
        setRouteOutcomeUnknown(true);
        setRouteOutcomeMessage(`${error instanceof Error ? error.message : '网络或响应异常'}。保存结果暂未确认；请重新读取后台结果，不要重复提交。`);
      } else {
        setRouteOutcomeMessage(error instanceof Error ? error.message : '保存默认供应商失败；当前选择仍保留。');
      }
    } finally {
      const requestStillCurrent = requestIsCurrent();
      if (requestStillCurrent) setRouteSaving(false);
      settingsSubmit.finish(`imageRoute:${model}`, requestStillCurrent && saved);
    }
  };

  const saveMuskConfig = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!settingsSubmit.start()) return;
    let saved = false;
    setMuskSaving(true);
    setSubmitState(null);
    setMuskTestState(null);

    try {
      const res = await fetch('/api/admin/integrations/musk', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: muskConfig.enabled,
          base_url: muskConfig.base_url,
          default_model: muskConfig.default_model,
          api_key: muskApiKey,
          clear_api_key: clearMuskApiKey,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.config) {
        setSubmitState({ type: 'error', message: data.error || data.message || '保存失败' });
        return;
      }
      setMuskConfig(data.config || muskConfig);
      setMuskApiKey('');
      setClearMuskApiKey(false);
      setSubmitState({ type: 'success', message: 'Musk API 配置已保存到后台配置。' });
      saved = true;
    } catch (error) {
      setSubmitState({ type: 'error', message: error instanceof Error ? error.message : '保存失败' });
    } finally {
      setMuskSaving(false);
      settingsSubmit.finish('musk', saved);
    }
  };

  const testMuskConfig = async () => {
    setMuskTesting(true);
    setSubmitState(null);
    setMuskTestState(null);

    try {
      const res = await fetch('/api/admin/integrations/musk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (!res.ok) {
        setMuskTestState({
          type: 'error',
          message: data.error || data.message || 'Musk API 测试失败',
        });
        return;
      }
      setMuskConfig(data.config || muskConfig);
      setMuskTestState({
        type: 'success',
        message: 'Musk API 连通性测试通过。',
        model: data.test?.model || muskConfig.default_model,
        latency_ms: data.test?.latency_ms,
        tested_at: data.test?.tested_at,
      });
    } catch (error) {
      setMuskTestState({
        type: 'error',
        message: error instanceof Error ? error.message : 'Musk API 测试失败',
      });
    } finally {
      setMuskTesting(false);
    }
  };

  const saveImageConfig = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!settingsSubmit.start()) return;
    let saved = false;
    setImageSaving(true);
    setSubmitState(null);

    try {
      const res = await fetch('/api/admin/integrations/image-generation', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: imageConfig.enabled,
          provider: imageConfig.provider,
          base_url: imageConfig.base_url,
          default_model: imageConfig.default_model,
          api_key: imageApiKey,
          clear_api_key: clearImageApiKey,
          timeout_ms: imageConfig.timeout_ms,
          max_outputs_per_request: imageConfig.max_outputs_per_request,
          default_ratio: imageConfig.default_ratio,
          default_size: imageConfig.default_size,
          output_format: imageConfig.output_format,
          response_format: imageConfig.response_format,
          watermark: imageConfig.watermark,
          supports_text_to_image: imageConfig.supports_text_to_image,
          supports_image_to_image: imageConfig.supports_image_to_image,
          supports_async_task: imageConfig.supports_async_task,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.config) {
        setSubmitState({ type: 'error', message: data.error || data.message || '保存失败' });
        return;
      }
      setImageConfig(data.config || imageConfig);
      imageConfigBaseline.current = JSON.stringify(data.config || imageConfig);
      setImageApiKey('');
      setClearImageApiKey(false);
      setSubmitState({ type: 'success', message: '图形生成 API 配置已保存到后台配置。' });
      saved = true;
    } catch (error) {
      setSubmitState({ type: 'error', message: error instanceof Error ? error.message : '保存失败' });
    } finally {
      setImageSaving(false);
      settingsSubmit.finish('image', saved);
    }
  };

  const refreshManagedImageChannels = async () => {
    const response = await fetch('/api/admin/integrations/image-generation', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !Array.isArray(data.channels)) throw new Error(data.error || '读取图片供应商配置失败');
    setManagedImageChannels(data.channels);
    const imageChannelsData = data.imageChannels && typeof data.imageChannels === 'object'
      ? data.imageChannels as { items?: unknown; defaultRoutes?: unknown }
      : null;
    const routes = parseImageGenerationDefaultRoutes(data.defaultRoutes ?? imageChannelsData?.defaultRoutes);
    if (routes) applyImageRouteRead(routes, parseImageGenerationChannelOptions(imageChannelsData?.items) ?? imageChannels);
    const flareFixedPoints = data.managedChannelPresets?.fluxportFlareFixedPoints;
    setFluxportFlareFixedPointsPreset(Number.isSafeInteger(flareFixedPoints) && flareFixedPoints >= 0 ? flareFixedPoints : null);
  };

  const openManagedChannelDraft = (draft: ManagedChannelDraft) => {
    const editingDraft = { ...draft, editingModel: selectedRouteModel };
    managedChannelDraftBaseline.current = JSON.stringify(editingDraft);
    setManagedChannelDraft(editingDraft);
    setChannelManagementOpen(true);
  };

  const managedChannelDraftIsDirty = () => Boolean(managedChannelDraft)
    && JSON.stringify(managedChannelDraft) !== managedChannelDraftBaseline.current;

  const discardCurrentSupplierDraft = () => {
    if (imageRouteCurrentChannelId === 'shared') {
      try {
        if (imageConfigBaseline.current) setImageConfig(JSON.parse(imageConfigBaseline.current) as ImageGenerationConfig);
      } catch {
        // The baseline is created from this page's own parsed API response.
      }
      setImageApiKey('');
      setClearImageApiKey(false);
    }
    if (imageRouteCurrentChannelId === 'banana') setBananaDirty(false);
    if (managedChannelDraft) {
      managedChannelDraftBaseline.current = '';
      setManagedChannelDraft(null);
    }
  };

  const canSwitchImageRouteView = async (nextChannelId: string) => {
    if (nextChannelId === imageRouteCurrentChannelId) return true;
    const sharedDirty = imageRouteCurrentChannelId === 'shared'
      && (Boolean(imageApiKey.trim()) || clearImageApiKey || Boolean(imageConfigBaseline.current && JSON.stringify(imageConfig) !== imageConfigBaseline.current));
    const bananaIsDirty = imageRouteCurrentChannelId === 'banana' && bananaDirty;
    const managedIsDirty = managedChannelDraftIsDirty();
    if (!sharedDirty && !bananaIsDirty && !managedIsDirty) {
      if (managedChannelDraft) {
        managedChannelDraftBaseline.current = '';
        setManagedChannelDraft(null);
      }
      return true;
    }
    const confirmed = await confirm('切换到另一供应商会放弃当前未保存的供应商配置。其他后台设置不会改动。要继续吗？', {
      title: '放弃修改', confirmLabel: '放弃并切换', danger: true,
    });
    if (!confirmed) return false;
    discardCurrentSupplierDraft();
    return true;
  };

  const selectImageRouteModel = async (nextModel: ImageStudioModel) => {
    if (!isImageStudioModel(nextModel)) return;
    const nextChoice = imageRouteDrafts[nextModel] ?? null;
    const nextChannelId = nextChoice ?? originalImageChannelIdForModel(nextModel);
    if (!await canSwitchImageRouteView(nextChannelId)) return;
    setSelectedRouteModel(nextModel);
    setRouteOutcomeMessage('');
  };

  const selectImageRouteChannel = async (value: string) => {
    const nextChoice = value === '' ? null : value;
    if (nextChoice === 'original') return;
    const nextChannelId = nextChoice ?? originalImageChannelIdForModel(selectedRouteModel);
    if (!await canSwitchImageRouteView(nextChannelId)) return;
    setImageRouteDrafts(current => ({ ...current, [selectedRouteModel]: nextChoice }));
    setRouteOutcomeMessage('');
  };

  const applyFluxportFlareDraftPreset = () => {
    const fixedPoints = fluxportFlareFixedPointsPreset;
    if (fixedPoints === null) return;
    setManagedChannelDraft(current => {
      if (!current || current.supplierKind !== 'fluxport') return current;
      return {
        ...current,
        models: {
          ...current.models,
          'gpt-image-2.5-flare': {
            ...current.models['gpt-image-2.5-flare'],
            enabled: true,
            qualities: 'auto',
            resolutions: '1K',
            ratios: '1:1',
            maxReferences: '0',
            billingMode: 'fixed',
            fixedPoints: String(fixedPoints),
          },
        },
      };
    });
  };

  const reReadManagedChannelsAfterUnknown = async () => {
    try {
      await refreshManagedImageChannels();
      setManagedChannelReReadSucceeded(true);
      setManagedChannelOutcomeMessage('配置列表已重新读取。请核对本次新增或修改是否已出现；若已出现，请取消当前草稿或编辑已有配置，不要重复新增。');
    } catch {
      setManagedChannelReReadSucceeded(false);
      setManagedChannelOutcomeMessage('重新读取失败，保存结果仍未确认。请稍后重读配置列表，不要直接重复提交。');
    }
  };

  const saveManagedImageChannel = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!managedChannelDraft || !settingsSubmit.start()) return;
    let saved = false;
    let requestSent = false;
    setManagedChannelSaving(true);
    setSubmitState(null);
    try {
      const models = Object.fromEntries(IMAGE_STUDIO_MODELS.map(model => {
        const capability = managedChannelDraft.models[model];
        const splitList = (value: string) => value.trim()
          ? Array.from(new Set(value.split(',').map(item => item.trim()).filter(Boolean)))
          : null;
        return [model, {
          enabled: capability.enabled,
          protocol: capability.protocol,
          upstreamModel: capability.upstreamModel,
          baseUrl: capability.baseUrl,
          apiKey: capability.apiKey,
          clearApiKey: capability.clearApiKey,
          qualities: splitList(capability.qualities),
          resolutions: splitList(capability.resolutions),
          ratios: splitList(capability.ratios),
          maxReferences: capability.maxReferences.trim() === '' ? null : Number(capability.maxReferences),
          billingMode: capability.billingMode || null,
          fixedPoints: capability.fixedPoints.trim() === '' ? null : Number(capability.fixedPoints),
        }];
      }));
      const channel = {
        ...(managedChannelDraft.id ? { id: managedChannelDraft.id, expectedRevision: managedChannelDraft.expectedRevision } : {}),
        label: managedChannelDraft.label,
        supplierName: managedChannelDraft.supplierName,
        supplierKind: managedChannelDraft.supplierKind,
        protocol: managedChannelDraft.protocol,
        baseUrl: managedChannelDraft.baseUrl,
        enabled: managedChannelDraft.enabled,
        apiKey: managedChannelDraft.apiKey,
        clearApiKey: managedChannelDraft.clearApiKey,
        models,
      };
      requestSent = true;
      const response = await fetch('/api/admin/integrations/image-generation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(managedChannelDraft.id === 'shared' || managedChannelDraft.id === 'banana'
          ? { channel_action: 'update-legacy-model-api', channel: {
            id: managedChannelDraft.id, expectedRevision: managedChannelDraft.expectedRevision,
            model: managedChannelDraft.editingModel || selectedRouteModel,
            modelApi: { protocol: models[managedChannelDraft.editingModel || selectedRouteModel].protocol,
              upstreamModel: models[managedChannelDraft.editingModel || selectedRouteModel].upstreamModel,
              baseUrl: models[managedChannelDraft.editingModel || selectedRouteModel].baseUrl,
              apiKey: models[managedChannelDraft.editingModel || selectedRouteModel].apiKey,
              clearApiKey: models[managedChannelDraft.editingModel || selectedRouteModel].clearApiKey,
              clearOverrides: managedChannelDraft.models[managedChannelDraft.editingModel || selectedRouteModel].clearOverrides === true },
          } }
          : { channel_action: managedChannelDraft.id ? 'update' : 'create', channel }),
      });
      const data = await response.json().catch(() => null) as Record<string, unknown> | null;
      const errorMessage = typeof data?.error === 'string' ? data.error : '保存图片供应商配置失败';
      if (!response.ok) {
        if (response.status >= 500) {
          markManagedChannelOutcomeUnknown(`${errorMessage}；保存结果暂未确认。请重新读取配置列表，核对后再继续，不要直接重复提交。`);
        } else {
          setSubmitState({ type: 'error', message: errorMessage });
        }
        return;
      }
      if (!isManagedImageChannel(data?.channel)) {
        markManagedChannelOutcomeUnknown('请求已完成，但没有收到可核对的保存结果。请重新读取配置列表后再继续，不要直接重复提交。');
        return;
      }
      const savedChannel = data.channel;
      setManagedImageChannels(current => withManagedChannelReceipt(current, savedChannel));
      managedChannelDraftBaseline.current = '';
      setManagedChannelDraft(null);
      setManagedChannelOutcomeUnknown(false);
      setManagedChannelReReadSucceeded(false);
      setManagedChannelOutcomeMessage('');
      saved = true;
      let refreshWarning = '';
      try {
        await refreshManagedImageChannels();
      } catch {
        refreshWarning = '；供应商列表暂未刷新，可重新读取配置';
      }
      setSubmitState({ type: 'success', message: managedChannelSaveMessage(savedChannel, managedChannelDraft.id ? 'update' : 'save') + refreshWarning });
    } catch (error) {
      if (requestSent) {
        markManagedChannelOutcomeUnknown('网络或响应异常，保存结果暂未确认。请重新读取配置列表，核对后再继续，不要直接重复提交。');
      } else {
        setSubmitState({ type: 'error', message: error instanceof Error ? error.message : '保存图片供应商配置失败' });
      }
    } finally {
      setManagedChannelSaving(false);
      settingsSubmit.finish('managedChannel', saved);
    }
  };

  const runManagedChannelAction = async (channel: ManagedImageChannel, action: 'update' | 'archive' | 'restore', enabled?: boolean) => {
    if (!settingsSubmit.start()) return;
    let saved = false;
    let requestSent = false;
    setManagedChannelSaving(true);
    setSubmitState(null);
    try {
      const method = action === 'archive' ? 'DELETE' : 'POST';
      const body = action === 'update'
        ? { channel_action: action, channel: { ...channel, expectedRevision: channel.configRevision, enabled } }
        : { channel_action: action, channel: { id: channel.id, expectedRevision: channel.configRevision } };
      requestSent = true;
      const response = await fetch('/api/admin/integrations/image-generation', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => null) as Record<string, unknown> | null;
      const errorMessage = typeof data?.error === 'string' ? data.error : '更新图片供应商状态失败';
      if (!response.ok) {
        if (response.status >= 500) {
          markManagedChannelOutcomeUnknown(`${errorMessage}；操作结果暂未确认。请重新读取配置列表，核对后再继续，不要直接重复操作。`);
        } else {
          setSubmitState({ type: 'error', message: errorMessage });
        }
        return;
      }
      if (!isManagedImageChannel(data?.channel)) {
        markManagedChannelOutcomeUnknown('请求已完成，但没有收到可核对的操作结果。请重新读取配置列表后再继续，不要重复操作。');
        return;
      }
      const savedChannel = data.channel;
      setManagedImageChannels(current => withManagedChannelReceipt(current, savedChannel));
      setManagedChannelOutcomeUnknown(false);
      setManagedChannelReReadSucceeded(false);
      setManagedChannelOutcomeMessage('');
      saved = true;
      let refreshWarning = '';
      try {
        await refreshManagedImageChannels();
      } catch {
        refreshWarning = '；供应商列表暂未刷新，可重新读取配置';
      }
      setSubmitState({ type: 'success', message: managedChannelSaveMessage(savedChannel, action) + refreshWarning });
    } catch (error) {
      if (requestSent) {
        markManagedChannelOutcomeUnknown('网络或响应异常，操作结果暂未确认。请重新读取配置列表，核对后再继续，不要直接重复操作。');
      } else {
        setSubmitState({ type: 'error', message: error instanceof Error ? error.message : '更新图片供应商状态失败' });
      }
    } finally {
      setManagedChannelSaving(false);
      settingsSubmit.finish('managedChannel', saved);
    }
  };

  const applyImageChannel = (provider: ImageGenerationProvider) => {
    const channel = IMAGE_CHANNEL_OPTIONS.find((item) => item.provider === provider) || IMAGE_CHANNEL_OPTIONS[0];
    setImageConfig((prev) => ({
      ...prev,
      provider: channel.provider,
      base_url: channel.baseUrl,
      ...(channel.provider === 'seedream' ? {
        default_model: channel.model,
        max_outputs_per_request: 1,
      } : prev.provider === 'seedream' ? {
        default_model: channel.model,
        max_outputs_per_request: 8,
      } : {}),
    }));
  };

  const saveVolcengineConfig = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!settingsSubmit.start()) return;
    let saved = false;
    setVolcengineSaving(true);
    setSubmitState(null);

    try {
      const res = await fetch('/api/admin/integrations/volcengine-ip', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: volcengineConfig.enabled,
          base_url: volcengineConfig.base_url,
          default_model: volcengineConfig.default_model,
          api_key: volcengineApiKey,
          clear_api_key: clearVolcengineApiKey,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.config) {
        setSubmitState({ type: 'error', message: data.error || data.message || '保存失败' });
        return;
      }
      setVolcengineConfig(data.config || volcengineConfig);
      setVolcengineApiKey('');
      setClearVolcengineApiKey(false);
      setSubmitState({ type: 'success', message: '火山 IP 生成 API 配置已保存到后台配置。' });
      saved = true;
    } catch (error) {
      setSubmitState({ type: 'error', message: error instanceof Error ? error.message : '保存失败' });
    } finally {
      setVolcengineSaving(false);
      settingsSubmit.finish('volcengine', saved);
    }
  };

  const saveAiMediaKitConfig = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!settingsSubmit.start()) return;
    let saved = false;
    setAiMediaKitSaving(true);
    setSubmitState(null);

    try {
      const res = await fetch('/api/admin/integrations/aimediakit', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: aiMediaKitConfig.enabled,
          base_url: aiMediaKitConfig.base_url,
          api_key: aiMediaKitApiKey,
          clear_api_key: clearAiMediaKitApiKey,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.config) {
        setSubmitState({ type: 'error', message: data.error || data.message || '保存失败' });
        return;
      }
      setAiMediaKitConfig(data.config || aiMediaKitConfig);
      setAiMediaKitApiKey('');
      setClearAiMediaKitApiKey(false);
      setSubmitState({ type: 'success', message: 'AI MediaKit 视频超分 API 配置已保存到后台配置。' });
      saved = true;
    } catch (error) {
      setSubmitState({ type: 'error', message: error instanceof Error ? error.message : '保存失败' });
    } finally {
      setAiMediaKitSaving(false);
      settingsSubmit.finish('mediakit', saved);
    }
  };

  const saveH3Config = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!settingsSubmit.start()) return;
    let saved = false;
    setH3Saving(true);
    setSubmitState(null);
    setH3TestState(null);

    try {
      const res = await fetch('/api/admin/integrations/h3', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: h3Config.enabled,
          base_url: h3Config.base_url,
          default_preset_id: h3Config.default_preset_id,
          default_lora_id: h3Config.default_lora_id,
          api_token: h3ApiToken,
          admin_token: h3AdminToken,
          clear_api_token: clearH3ApiToken,
          clear_admin_token: clearH3AdminToken,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.config) {
        setSubmitState({ type: 'error', message: data.error || data.message || '保存失败' });
        return;
      }
      setH3Config(normalizeH3Config(data.config || h3Config));
      setH3ApiToken('');
      setH3AdminToken('');
      setClearH3ApiToken(false);
      setClearH3AdminToken(false);
      setSubmitState({ type: 'success', message: 'H3 本地生成服务配置已保存。' });
      saved = true;
    } catch (error) {
      setSubmitState({ type: 'error', message: error instanceof Error ? error.message : '保存失败' });
    } finally {
      setH3Saving(false);
      settingsSubmit.finish('h3', saved);
    }
  };

  const testH3Config = async () => {
    setH3Testing(true);
    setSubmitState(null);
    setH3TestState(null);

    try {
      const res = await fetch('/api/admin/integrations/h3', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (!res.ok) {
        setH3TestState({
          type: 'error',
          message: data.error || data.message || 'H3 连接测试失败',
        });
        return;
      }
      const health = data.test?.health || {};
      setH3Config(normalizeH3Config(data.config || h3Config));
      setH3TestState({
        type: 'success',
        message: 'H3 连接测试通过。',
        tested_at: data.test?.tested_at,
        health_api: typeof health.api === 'string' ? health.api : undefined,
        worker: typeof health.worker?.worker === 'string' ? health.worker.worker : undefined,
        comfyui: typeof health.worker?.comfyui === 'string' ? health.worker.comfyui : undefined,
      });
    } catch (error) {
      setH3TestState({
        type: 'error',
        message: error instanceof Error ? error.message : 'H3 连接测试失败',
      });
    } finally {
      setH3Testing(false);
    }
  };

  const loadH3Queue = async () => {
    setH3QueueLoading(true);
    setH3QueueMessage(null);
    try {
      const res = await fetch('/api/admin/integrations/h3/queue', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) {
        setH3QueueMessage({ type: 'error', message: data.error || data.message || '读取 H3 队列失败' });
        return;
      }
      setH3QueueState(data.queue || null);
      setH3QueueMessage({ type: 'success', message: 'H3 队列状态已刷新。' });
    } catch (error) {
      setH3QueueMessage({ type: 'error', message: error instanceof Error ? error.message : '读取 H3 队列失败' });
    } finally {
      setH3QueueLoading(false);
    }
  };

  const submitH3QueueAction = async () => {
    setH3QueueMessage(null);
    const needsJobId = h3QueueAction === 'cancel' || h3QueueAction === 'stop' || h3QueueAction === 'move';
    const trimmedJobId = h3QueueJobId.trim();
    if (needsJobId && !trimmedJobId) {
      setH3QueueMessage({ type: 'error', message: '请先填写 H3 job_id。' });
      return;
    }
    if ((h3QueueAction === 'cancel' || h3QueueAction === 'stop')
      && !await confirm(`确认执行 H3 ${h3QueueAction === 'cancel' ? '取消排队任务' : '停止运行任务'}？`, { title: '确认停止', confirmLabel: '确认', danger: true })) {
      return;
    }
    setH3QueueLoading(true);
    try {
      const res = await fetch('/api/admin/integrations/h3/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: h3QueueAction,
          job_id: trimmedJobId || undefined,
          direction: h3QueueAction === 'move' ? h3QueueDirection : undefined,
          reason: h3QueueReason.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setH3QueueMessage({ type: 'error', message: data.error || data.message || 'H3 队列操作失败' });
        return;
      }
      setH3QueueMessage({ type: 'success', message: 'H3 队列操作已提交，并已写入操作日志。' });
      await loadH3Queue();
    } catch (error) {
      setH3QueueMessage({ type: 'error', message: error instanceof Error ? error.message : 'H3 队列操作失败' });
    } finally {
      setH3QueueLoading(false);
    }
  };

  useEffect(() => {
    loadConfig();
  }, []);

  const saveConfig = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!settingsSubmit.start()) return;
    let saved = false;
    setSaving(true);
    setSubmitState(null);

    try {
      const res = await fetch('/api/admin/integrations/codex', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: config.enabled,
          source_label: config.source_label,
          user_selector: config.user_selector,
          token,
          clear_token: clearToken,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.config) {
        setSubmitState({ type: 'error', message: data.error || data.message || '保存失败' });
        return;
      }
      setConfig(data.config || config);
      setToken('');
      setClearToken(false);
      setSubmitState({ type: 'success', message: 'Codex 接口配置已保存到后台配置。' });
      saved = true;
    } catch (error) {
      setSubmitState({ type: 'error', message: error instanceof Error ? error.message : '保存失败' });
    } finally {
      setSaving(false);
      settingsSubmit.finish('codex', saved);
    }
  };

  const updateSelector = (patch: Partial<CodexConfig['user_selector']>) => {
    setConfig((prev) => ({
      ...prev,
      user_selector: {
        ...prev.user_selector,
        ...patch,
      },
    }));
  };

  if (loading) {
    return (
      <div>
        <PageBanner
          eyebrow="管理后台"
          title="API 设置"
          description="统一维护火山 IP 生成、AI MediaKit 超分、Musk API、图形生成 API、Codex API 和外部工具调用 sd2 的后端配置。"
        />
        <div className="card">
          <LoadingSkeleton label="正在读取配置" />
        </div>
      </div>
    );
  }

  return (
    <fieldset disabled={settingsSubmit.busy} className="admin-integrations-page" style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
      {productDialog}
      {settingsSubmit.notice && <p role="status">{settingsSubmit.notice}</p>}
      <PageBanner
        eyebrow="管理后台"
        title="API 设置"
        description="在这里维护火山 IP 生成、AI MediaKit 超分、Musk API、图形生成 API、Codex API 和外部工具调用配置，生成任务才能进入同一套扣费与后台留痕。"
      />

      <div className="stats-grid">
        <div className="stat-card">
          <span className="stat-label">Codex 接口</span>
          <strong className="stat-value">{statusText}</strong>
          <span className="stat-sub">{config.ready ? '鉴权、用户和 token 均已就绪' : '保存配置后再走接口自测'}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">来源标识</span>
          <strong className="stat-value">{config.source_label || '-'}</strong>
          <span className="stat-sub">会写入任务、成本导出和产出留存。</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">扣费用户</span>
          <strong className="stat-value">
            {config.linked_user ? (
              <UserIdentityBadge user={config.linked_user} size="sm" subtitle={linkedUserSubtitle(config)} />
            ) : '-'}
          </strong>
          <span className="stat-sub">{config.linked_user ? '生成任务会归属并扣费到该用户' : linkedUserSubtitle(config)}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Musk API</span>
          <strong className="stat-value">{muskStatusText}</strong>
          <span className="stat-sub">{muskConfig.default_model || 'gpt-5.5'} · {muskConfig.base_url || '未配置地址'}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">图形生成 API</span>
          <strong className="stat-value">{imageStatusText}</strong>
          <span className="stat-sub">{selectedImageModel.label} · {imageConfig.default_model || selectedImageModel.model}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">火山 IP 生成</span>
          <strong className="stat-value">{volcengineStatusText}</strong>
          <span className="stat-sub">
            {volcengineConfig.default_model || '未设置 Model ID'} · {volcengineConfig.api_key_configured ? 'API Key 已设置' : 'API Key 未设置'}
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-label">AI MediaKit 超分</span>
          <strong className="stat-value">{aiMediaKitStatusText}</strong>
          <span className="stat-sub">{aiMediaKitConfig.base_url || '未设置 API 地址'} · {aiMediaKitConfig.api_key_configured ? 'API Key 已设置' : 'API Key 未设置'}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">H3 本地生成服务</span>
          <strong className="stat-value">{h3StatusText}</strong>
          <span className="stat-sub">
            {h3Config.default_preset_id} · {h3Config.default_lora_id} · {h3Config.api_token_configured ? '用户 token 已设置' : '用户 token 未设置'}
          </span>
        </div>
      </div>

      {managedChannelOutcomeUnknown ? (
        <div className="alert alert-error mt-4">
          {managedChannelOutcomeMessage}
          <div className="codex-config-actions mt-2">
            <button className="btn btn-secondary" type="button" disabled={managedChannelSaving} onClick={() => void reReadManagedChannelsAfterUnknown()}>
              重新读取配置
            </button>
            {managedChannelReReadSucceeded && (
              <button className="btn btn-secondary" type="button" disabled={managedChannelSaving} onClick={() => {
                setManagedChannelOutcomeUnknown(false);
                setManagedChannelReReadSucceeded(false);
                setManagedChannelOutcomeMessage('');
                setSubmitState({ type: 'success', message: '已读取当前配置列表。请按列表核对结果后再继续；如本次修改已出现，请编辑已有配置，不要重复新增。' });
              }}>
                已核对，继续操作
              </button>
            )}
          </div>
        </div>
      ) : submitState && (
        <div className={`alert ${submitState.type === 'success' ? 'alert-success' : 'alert-error'} mt-4`}>
          {submitState.message}
        </div>
      )}

      <form id="h3-video" className="card codex-config-form" onSubmit={saveH3Config}>
        <div className="codex-config-head">
          <div>
            <h2 className="section-title mb-0">H3 本地生成服务</h2>
            <p className="text-gray text-sm mt-2">
              保存 H3 API 网关地址、用户 token 和管理员 token。普通生成只走服务端转发，不把 token 暴露给浏览器。
            </p>
          </div>
          <label className="toggle-switch" aria-label="启用 H3 本地生成服务">
            <input
              type="checkbox"
              checked={h3Config.enabled}
              onChange={(event) => setH3Config((prev) => ({ ...prev, enabled: event.target.checked }))}
            />
            <span className="toggle-slider"></span>
          </label>
        </div>

        <div className="codex-config-grid">
          <div className="form-group">
            <label className="form-label" htmlFor="h3-base-url">API 地址</label>
            <input
              id="h3-base-url"
              className="input"
              value={h3Config.base_url}
              onChange={(event) => setH3Config((prev) => ({ ...prev, base_url: event.target.value }))}
              placeholder="https://h3-api.example.com"
              autoComplete="off"
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="h3-default-preset">默认预设</label>
            <select
              id="h3-default-preset"
              className="input"
              value={h3Config.default_preset_id}
              onChange={(event) => setH3Config((prev) => ({
                ...prev,
                default_preset_id: event.target.value as H3Config['default_preset_id'],
              }))}
            >
              {h3Config.preset_options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label} · {option.detail}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="h3-default-lora">默认 LoRA</label>
            <select
              id="h3-default-lora"
              className="input"
              value={h3Config.default_lora_id}
              onChange={(event) => setH3Config((prev) => ({
                ...prev,
                default_lora_id: event.target.value as H3Config['default_lora_id'],
              }))}
            >
              {h3Config.lora_options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label} · {option.detail}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="h3-api-token">用户 token</label>
            <input
              id="h3-api-token"
              className="input"
              type="password"
              value={h3ApiToken}
              onChange={(event) => {
                setH3ApiToken(event.target.value);
                if (event.target.value.trim()) setClearH3ApiToken(false);
              }}
              placeholder={h3Config.api_token_configured ? '当前已设置，留空不变' : '输入 H3_API_TOKEN'}
              autoComplete="new-password"
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="h3-admin-token">管理员 token</label>
            <input
              id="h3-admin-token"
              className="input"
              type="password"
              value={h3AdminToken}
              onChange={(event) => {
                setH3AdminToken(event.target.value);
                if (event.target.value.trim()) setClearH3AdminToken(false);
              }}
              placeholder={h3Config.admin_token_configured ? '当前已设置，留空不变' : '输入 H3_ADMIN_TOKEN'}
              autoComplete="new-password"
            />
          </div>
        </div>

        <div className="codex-config-status">
          <div>
            <span className="info-label">当前状态</span>
            <strong>{h3StatusText}</strong>
          </div>
          <div>
            <span className="info-label">健康检查</span>
            <strong>
              {h3Config.health
                ? `API ${h3Config.health.api || '-'} · Worker ${h3Config.health.worker || '-'} · ComfyUI ${h3Config.health.comfyui || '-'}`
                : h3Config.health_path}
            </strong>
          </div>
          <div>
            <span className="info-label">最近测试</span>
            <strong>{h3Config.health?.checked_at ? <RelativeTime value={h3Config.health.checked_at} /> : '未测试'}</strong>
          </div>
          <div>
            <span className="info-label">提交任务</span>
            <strong>{h3Config.generate_path}</strong>
          </div>
          <div>
            <span className="info-label">队列管理</span>
            <strong>{h3Config.admin_queue_ready ? '已可用' : '未就绪'}</strong>
          </div>
          <div>
            <span className="info-label">用户 token</span>
            <strong>{h3Config.api_token_configured ? '已设置' : '未设置'}</strong>
          </div>
          <div>
            <span className="info-label">管理员 token</span>
            <strong>{h3Config.admin_token_configured ? '已设置' : '未设置'}</strong>
          </div>
        </div>

        <details
          className="h3-queue-panel"
          open={h3QueueOpen}
          onToggle={(event) => setH3QueueOpen(event.currentTarget.open)}
        >
          <summary>
            <div>
              <strong>H3 队列管理</strong>
              <span>{h3Config.admin_queue_ready ? '可读取队列并执行管理员操作' : '需要健康检查通过并配置管理员 token'}</span>
            </div>
          </summary>
          <div className="h3-queue-body">
            <div className="h3-queue-toolbar">
              <button
                className="btn btn-secondary"
                type="button"
                onClick={loadH3Queue}
                disabled={h3QueueLoading || !h3Config.admin_queue_ready}
              >
                {h3QueueLoading ? '正在刷新' : '刷新队列'}
              </button>
              {!h3Config.admin_queue_ready && (
                <span className="text-gray text-sm">队列操作只在 H3 健康检查通过且管理员 token 就绪后开放。</span>
              )}
            </div>

            {h3QueueMessage && (
              <div className={`codex-config-test-result ${h3QueueMessage.type === 'success' ? 'is-success' : 'is-error'}`}>
                <strong>{h3QueueMessage.message}</strong>
              </div>
            )}

            <div className="h3-queue-action-grid">
              <label className="form-group">
                <span className="form-label">动作</span>
                <select
                  className="input"
                  value={h3QueueAction}
                  onChange={(event) => setH3QueueAction(event.target.value as typeof h3QueueAction)}
                  disabled={!h3Config.admin_queue_ready}
                >
                  <option value="pause">暂停新任务启动</option>
                  <option value="resume">恢复队列</option>
                  <option value="cancel">取消排队任务</option>
                  <option value="stop">停止运行任务</option>
                  <option value="move">调整排队顺序</option>
                </select>
              </label>
              <label className="form-group">
                <span className="form-label">job_id</span>
                <input
                  className="input"
                  value={h3QueueJobId}
                  onChange={(event) => setH3QueueJobId(event.target.value)}
                  placeholder="cancel / stop / move 时填写"
                  disabled={!h3Config.admin_queue_ready || h3QueueAction === 'pause' || h3QueueAction === 'resume'}
                  autoComplete="off"
                />
              </label>
              <label className="form-group">
                <span className="form-label">移动方向</span>
                <select
                  className="input"
                  value={h3QueueDirection}
                  onChange={(event) => setH3QueueDirection(event.target.value as typeof h3QueueDirection)}
                  disabled={!h3Config.admin_queue_ready || h3QueueAction !== 'move'}
                >
                  <option value="top">置顶</option>
                  <option value="up">上移</option>
                  <option value="down">下移</option>
                  <option value="bottom">置底</option>
                </select>
              </label>
              <label className="form-group">
                <span className="form-label">原因</span>
                <input
                  className="input"
                  value={h3QueueReason}
                  onChange={(event) => setH3QueueReason(event.target.value)}
                  placeholder="会写入操作日志"
                  disabled={!h3Config.admin_queue_ready}
                  maxLength={240}
                />
              </label>
              <button
                className="btn btn-primary"
                type="button"
                onClick={submitH3QueueAction}
                disabled={h3QueueLoading || !h3Config.admin_queue_ready}
              >
                执行队列操作
              </button>
            </div>

            <pre className="h3-queue-json">
              {h3QueueState ? JSON.stringify(h3QueueState, null, 2) : '暂未读取队列。'}
            </pre>
          </div>
        </details>

        <div className="codex-config-actions">
          <label className="codex-clear-token">
            <input
              type="checkbox"
              checked={clearH3ApiToken}
              disabled={!h3Config.api_token_configured || Boolean(h3ApiToken.trim())}
              onChange={(event) => setClearH3ApiToken(event.target.checked)}
            />
            清除当前用户 token
          </label>
          <label className="codex-clear-token">
            <input
              type="checkbox"
              checked={clearH3AdminToken}
              disabled={!h3Config.admin_token_configured || Boolean(h3AdminToken.trim())}
              onChange={(event) => setClearH3AdminToken(event.target.checked)}
            />
            清除当前管理员 token
          </label>
          <button
            className="btn btn-secondary"
            type="button"
            onClick={testH3Config}
            disabled={h3Testing || h3Saving || !h3Config.base_url}
          >
            {h3Testing ? '正在测试' : '测试连接'}
          </button>
          <button className="btn btn-primary sd2-loading-surface" data-busy={h3Saving} type="submit" disabled={h3Saving}>
            {h3Saving ? '正在保存' : '保存 H3 本地生成服务'}
          </button>
        </div>

        {h3TestState && (
          <div className={`codex-config-test-result ${h3TestState.type === 'success' ? 'is-success' : 'is-error'}`}>
            <strong>{h3TestState.message}</strong>
            {h3TestState.type === 'success' && (
              <span>
                API {h3TestState.health_api || '-'} · Worker {h3TestState.worker || '-'} · ComfyUI {h3TestState.comfyui || '-'}
                {h3TestState.tested_at && <> · <RelativeTime value={h3TestState.tested_at} /></>}
              </span>
            )}
            {h3TestState.type === 'error' && <span>请确认 H3 API 公网地址、用户 token 和工作站服务状态。</span>}
          </div>
        )}
      </form>

      <form id="aimediakit-enhance-video" className="card codex-config-form" onSubmit={saveAiMediaKitConfig}>
        <div className="codex-config-head">
          <div>
            <h2 className="section-title mb-0">AI MediaKit 视频超分 API</h2>
            <p className="text-gray text-sm mt-2">
              保存视频超分/画质增强所需的 AI MediaKit API Key。API Key 只提交到服务端保存，页面和接口不会回显明文。
            </p>
          </div>
          <label className="toggle-switch" aria-label="启用 AI MediaKit 视频超分 API">
            <input
              type="checkbox"
              checked={aiMediaKitConfig.enabled}
              onChange={(event) => setAiMediaKitConfig((prev) => ({ ...prev, enabled: event.target.checked }))}
            />
            <span className="toggle-slider"></span>
          </label>
        </div>

        <div className="codex-config-grid">
          <div className="form-group">
            <label className="form-label" htmlFor="aimediakit-base-url">API 地址</label>
            <input
              id="aimediakit-base-url"
              className="input"
              value={aiMediaKitConfig.base_url}
              onChange={(event) => setAiMediaKitConfig((prev) => ({ ...prev, base_url: event.target.value }))}
              placeholder="https://mediakit.cn-beijing.volces.com"
              autoComplete="off"
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="aimediakit-api-key">API Key</label>
            <input
              id="aimediakit-api-key"
              className="input"
              type="password"
              value={aiMediaKitApiKey}
              onChange={(event) => {
                setAiMediaKitApiKey(event.target.value);
                if (event.target.value.trim()) setClearAiMediaKitApiKey(false);
              }}
              placeholder={aiMediaKitConfig.api_key_configured ? '当前已设置，留空不变' : '输入 AI MediaKit API Key'}
              autoComplete="new-password"
            />
          </div>
        </div>

        <div className="codex-config-status">
          <div>
            <span className="info-label">当前状态</span>
            <strong>{aiMediaKitStatusText}</strong>
          </div>
          <div>
            <span className="info-label">提交任务</span>
            <strong>{aiMediaKitConfig.enhance_video_path}</strong>
          </div>
          <div>
            <span className="info-label">查询任务</span>
            <strong>{aiMediaKitConfig.task_status_path}</strong>
          </div>
          <div>
            <span className="info-label">本地上传</span>
            <strong>{aiMediaKitConfig.request_upload_path}</strong>
          </div>
          <div>
            <span className="info-label">API Key</span>
            <strong>{aiMediaKitConfig.api_key_configured ? '已设置' : '未设置'}</strong>
          </div>
        </div>

        <div className="codex-config-actions">
          <label className="codex-clear-token">
            <input
              type="checkbox"
              checked={clearAiMediaKitApiKey}
              disabled={!aiMediaKitConfig.api_key_configured || Boolean(aiMediaKitApiKey.trim())}
              onChange={(event) => setClearAiMediaKitApiKey(event.target.checked)}
            />
            清除当前 API Key
          </label>
          <button className="btn btn-primary sd2-loading-surface" data-busy={aiMediaKitSaving} type="submit" disabled={aiMediaKitSaving}>
            {aiMediaKitSaving ? '正在保存' : '保存 AI MediaKit 视频超分 API'}
          </button>
        </div>
      </form>

      <form id="volcengine-ip" className="card codex-config-form" onSubmit={saveVolcengineConfig}>
        <div className="codex-config-head">
          <div>
            <h2 className="section-title mb-0">火山 IP 生成 API</h2>
            <p className="text-gray text-sm mt-2">
              保存火山 Ark 视频生成密钥和 Model ID。API Key 只会提交到服务端保存，页面和接口不会回显明文。
            </p>
          </div>
          <label className="toggle-switch" aria-label="启用火山 IP 生成 API">
            <input
              type="checkbox"
              checked={volcengineConfig.enabled}
              onChange={(event) => setVolcengineConfig((prev) => ({ ...prev, enabled: event.target.checked }))}
            />
            <span className="toggle-slider"></span>
          </label>
        </div>

        <div className="codex-config-grid">
          <div className="form-group">
            <label className="form-label" htmlFor="volcengine-base-url">API 地址</label>
            <input
              id="volcengine-base-url"
              className="input"
              value={volcengineConfig.base_url}
              onChange={(event) => setVolcengineConfig((prev) => ({ ...prev, base_url: event.target.value }))}
              placeholder="https://ark.cn-beijing.volces.com/api/v3"
              autoComplete="off"
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="volcengine-model">Model ID</label>
            <input
              id="volcengine-model"
              className="input"
              list="volcengine-model-options"
              value={volcengineConfig.default_model}
              onChange={(event) => setVolcengineConfig((prev) => ({ ...prev, default_model: event.target.value }))}
              placeholder="按火山控制台已开通模型填写"
              autoComplete="off"
              maxLength={120}
              required
            />
            <datalist id="volcengine-model-options">
              {VOLCENGINE_IP_MODEL_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </datalist>
            <div className="volcengine-model-presets" aria-label="火山 IP 模型预设">
              {VOLCENGINE_IP_MODEL_OPTIONS.map((option) => {
                const active = volcengineConfig.default_model === option.id;
                return (
                  <button
                    key={option.id}
                    className={`volcengine-model-preset${active ? ' is-active' : ''}`}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setVolcengineConfig((prev) => ({ ...prev, default_model: option.id }))}
                  >
                    <span>{option.label}</span>
                    <small>{option.detail}</small>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="volcengine-api-key">API Key</label>
            <input
              id="volcengine-api-key"
              className="input"
              type="password"
              value={volcengineApiKey}
              onChange={(event) => {
                setVolcengineApiKey(event.target.value);
                if (event.target.value.trim()) setClearVolcengineApiKey(false);
              }}
              placeholder={volcengineConfig.api_key_configured ? '当前已设置，留空不变' : '输入火山 API Key'}
              autoComplete="new-password"
            />
          </div>
        </div>

        <div className="codex-config-status">
          <div>
            <span className="info-label">当前状态</span>
            <strong>{volcengineStatusText}</strong>
          </div>
          <div>
            <span className="info-label">Base URL</span>
            <strong>{volcengineConfig.base_url || '-'}</strong>
          </div>
          <div>
            <span className="info-label">创建任务路径</span>
            <strong>{volcengineConfig.create_task_path}</strong>
          </div>
          <div>
            <span className="info-label">Model ID</span>
            <strong>{volcengineConfig.default_model || '-'}</strong>
          </div>
          <div>
            <span className="info-label">API Key</span>
            <strong>{volcengineConfig.api_key_configured ? '已设置' : '未设置'}</strong>
          </div>
        </div>

        <div className="codex-config-actions">
          <label className="codex-clear-token">
            <input
              type="checkbox"
              checked={clearVolcengineApiKey}
              disabled={!volcengineConfig.api_key_configured || Boolean(volcengineApiKey.trim())}
              onChange={(event) => setClearVolcengineApiKey(event.target.checked)}
            />
            清除当前 API Key
          </label>
          <button className="btn btn-primary sd2-loading-surface" data-busy={volcengineSaving} type="submit" disabled={volcengineSaving}>
            {volcengineSaving ? '正在保存' : '保存火山 IP 生成 API'}
          </button>
        </div>
      </form>

      <form className="card codex-config-form" onSubmit={saveMuskConfig}>
        <div className="codex-config-head">
          <div>
            <h2 className="section-title mb-0">Musk API</h2>
            <p className="text-gray text-sm mt-2">
              保存外部 LLM 服务地址和默认模型，后续模板配置 Agent、模块生成 Agent 可从这里读取。
            </p>
          </div>
          <label className="toggle-switch" aria-label="启用 Musk API">
            <input
              type="checkbox"
              checked={muskConfig.enabled}
              onChange={(event) => setMuskConfig((prev) => ({ ...prev, enabled: event.target.checked }))}
            />
            <span className="toggle-slider"></span>
          </label>
        </div>

        <div className="codex-config-grid">
          <div className="form-group">
            <label className="form-label" htmlFor="musk-base-url">API 地址</label>
            <input
              id="musk-base-url"
              className="input"
              value={muskConfig.base_url}
              onChange={(event) => setMuskConfig((prev) => ({ ...prev, base_url: event.target.value }))}
              placeholder="https://api.muskapis.com/"
              autoComplete="off"
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="musk-default-model">默认模型</label>
            <input
              id="musk-default-model"
              className="input"
              value={muskConfig.default_model}
              onChange={(event) => setMuskConfig((prev) => ({ ...prev, default_model: event.target.value }))}
              placeholder="gpt-5.5"
              autoComplete="off"
              maxLength={80}
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="musk-api-key">API Key</label>
            <input
              id="musk-api-key"
              className="input"
              type="password"
              value={muskApiKey}
              onChange={(event) => {
                setMuskApiKey(event.target.value);
                if (event.target.value.trim()) setClearMuskApiKey(false);
              }}
              placeholder={muskConfig.api_key_configured ? '当前已设置，留空不变' : '输入 Musk API Key'}
              autoComplete="new-password"
            />
          </div>
        </div>

        <div className="codex-config-status">
          <div>
            <span className="info-label">当前状态</span>
            <strong>{muskStatusText}</strong>
          </div>
          <div>
            <span className="info-label">API 地址</span>
            <strong>{muskConfig.base_url || '-'}</strong>
          </div>
          <div>
            <span className="info-label">默认模型</span>
            <strong>{muskConfig.default_model || '-'}</strong>
          </div>
          <div>
            <span className="info-label">API Key</span>
            <strong>{muskConfig.api_key_configured ? '已设置' : '未设置'}</strong>
          </div>
        </div>

        <div className="codex-config-actions">
          <label className="codex-clear-token">
            <input
              type="checkbox"
              checked={clearMuskApiKey}
              disabled={!muskConfig.api_key_configured || Boolean(muskApiKey.trim())}
              onChange={(event) => setClearMuskApiKey(event.target.checked)}
            />
            清除当前 API Key
          </label>
          <button
            className="btn btn-secondary"
            type="button"
            onClick={testMuskConfig}
            disabled={muskTesting || muskSaving || !muskConfig.ready}
          >
            {muskTesting ? '正在测试' : '测试连接'}
          </button>
          <button className="btn btn-primary sd2-loading-surface" data-busy={muskSaving} type="submit" disabled={muskSaving}>
            {muskSaving ? '正在保存' : '保存 Musk API'}
          </button>
        </div>

        {muskTestState && (
          <div className={`codex-config-test-result ${muskTestState.type === 'success' ? 'is-success' : 'is-error'}`}>
            <strong>{muskTestState.message}</strong>
            {muskTestState.type === 'success' && (
              <span>
                {muskTestState.model || muskConfig.default_model}
                {typeof muskTestState.latency_ms === 'number' ? ` · ${muskTestState.latency_ms}ms` : ''}
                {muskTestState.tested_at && <> · <RelativeTime value={muskTestState.tested_at} /></>}
              </span>
            )}
            {muskTestState.type === 'error' && <span>请先确认地址、模型和 API Key 已保存。</span>}
          </div>
        )}
      </form>

      <form className="card codex-config-form" onSubmit={saveImageDefaultRoute}>
        <div className="codex-config-head">
          <div>
            <h2 className="section-title mb-0">图片默认供应商</h2>
            <p className="text-gray text-sm mt-2">
              为所选型号设置默认供应商，仅影响之后未主动另选供应商的新任务；用户主动选择仍优先。保存这里不会启用通道、写入 Key 或修改供应商配置。
            </p>
          </div>
        </div>
        <div className="codex-config-grid">
          <div className="form-group">
            <label className="form-label" htmlFor="image-route-model">图片模型</label>
            <select id="image-route-model" className="input" value={selectedRouteModel}
              disabled={!routePreferencesReady || routeSaving || routeReading || routeOutcomeUnknown}
              onChange={event => void selectImageRouteModel(event.target.value as ImageStudioModel)}>
              {IMAGE_STUDIO_MODELS.map(model => <option key={model} value={model}>{IMAGE_STUDIO_MODEL_LABELS[model]}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="image-route-channel">默认供应商</label>
            <select id="image-route-channel" className="input" value={imageRouteCurrentChoice ?? ''}
              disabled={!routePreferencesReady || routeSaving || routeReading || routeOutcomeUnknown || imageChannels === null}
              onChange={event => void selectImageRouteChannel(event.target.value)}>
              <option value="">原默认（实际：{imageRouteDefaultActualChannel?.supplierName
                || (originalImageChannelIdForModel(selectedRouteModel) === 'banana' ? 'Banana' : sharedSupplierName)}）</option>
              {imageChannels?.map(channel => (
                <option key={channel.id} value={channel.id}>
                  {channel.id === 'shared'
                    ? `${sharedSupplierName}（共享图形 API）`
                    : channel.id === 'banana'
                      ? 'Banana 专用通道'
                      : `${channel.supplierName} · ${channel.label}`}
                  {' · '}{imageChannelStatus(channel, selectedRouteModel)}
                </option>
              ))}
              {imageRouteCurrentChoice && !imageChannels?.some(channel => channel.id === imageRouteCurrentChoice) && (
                <option value={imageRouteCurrentChoice} disabled>当前配置不存在（不能生成）</option>
              )}
            </select>
            <small className="text-gray">
              当前：{imageRouteCurrentChannelId === 'shared'
                ? `${sharedSupplierName}（共享图形 API）`
                : imageRouteCurrentChannelId === 'banana'
                  ? 'Banana 专用通道'
                  : imageRouteCurrentChannel?.supplierName || imageRouteCurrentChannel?.label || '配置不存在'}
              {' · '}{imageChannels === null ? '通道信息未读取，暂不能确认可用状态' : imageChannelStatus(imageRouteCurrentChannel, selectedRouteModel)}
            </small>
          </div>
        </div>
        {routePreferenceNotice && <p className="text-gray text-sm" role="status">{routePreferenceNotice}</p>}
        {!imageDefaultRoutes || imageChannels === null ? (
          <p className="text-gray text-sm" role="status">尚未读取到默认供应商信息；当前不能修改路由。其他接口配置仍可单独保存。</p>
        ) : null}
        {routeOutcomeUnknown && (
          <div className="alert alert-error mt-3" role="alert">
            {routeOutcomeMessage || '保存结果暂未确认。'}
            <div className="codex-config-actions mt-2">
              <button className="btn btn-secondary" type="button" disabled={routeSaving || routeReading} onClick={() => void reReadImageRouteAfterUnknown()}>
                {routeReading ? '正在重新读取' : '重新读取后台结果'}
              </button>
            </div>
          </div>
        )}
        {!routeOutcomeUnknown && routeOutcomeMessage && <p className="text-gray text-sm" role="status">{routeOutcomeMessage}</p>}
        <div className="codex-config-actions">
          <button className="btn btn-primary sd2-loading-surface" type="submit" disabled={!imageDefaultRoutes || !imageChannels || !routePreferencesReady || !imageRouteHasChanges || routeSaving || routeOutcomeUnknown} data-busy={routeSaving}>
            {routeSaving ? '正在保存' : '保存该型号默认供应商'}
          </button>
        </div>
      </form>

      {imageRouteCurrentChannelId === 'banana' && (
        <BananaImageChannel onDirtyChange={setBananaDirty} onSaveStart={settingsSubmit.start} onSaveFinish={saved => settingsSubmit.finish('banana', saved)} />
      )}

      {imageRouteCurrentChannelId === 'shared' && <form className="card codex-config-form" onSubmit={saveImageConfig}>
        <div className="codex-config-head">
          <div>
            <h2 className="section-title mb-0">共享图形 API 配置</h2>
            <p className="text-gray text-sm mt-2">
              这里只编辑共享图形 API 本身；上方默认供应商单独保存，用户主动选择供应商仍优先。
            </p>
          </div>
          <label className="toggle-switch" aria-label="启用图形生成 API">
            <input
              type="checkbox"
              checked={imageConfig.enabled}
              onChange={(event) => setImageConfig((prev) => ({ ...prev, enabled: event.target.checked }))}
            />
            <span className="toggle-slider"></span>
          </label>
        </div>

        <div className="codex-config-grid">
          <details className="form-group">
            <summary style={{ cursor: 'pointer' }}>
              <strong>共享 API 协议配置（影响该通道）</strong>
              <span className="text-gray"> · 当前供应商：{sharedSupplierName}</span>
            </summary>
            <p className="text-gray text-sm mt-2">更改并保存后，只更新“共享图形 API”配置，不会改上方各型号的默认供应商选择。</p>
            <label className="form-label mt-2" htmlFor="image-channel">共享 API 实际供应商</label>
            <select
              id="image-channel"
              className="input"
              value={imageConfig.provider}
              onChange={(event) => applyImageChannel(event.target.value as ImageGenerationProvider)}
            >
              {IMAGE_CHANNEL_OPTIONS.map((option) => <option key={option.provider} value={option.provider}>{option.label}</option>)}
            </select>
            <label className="form-label mt-2" htmlFor="image-api-endpoint">常用 API 地址</label>
            <select
              id="image-api-endpoint"
              className="input"
              value={IMAGE_API_ENDPOINT_OPTIONS.some((option) => option.value === imageConfig.base_url) ? imageConfig.base_url : ''}
              onChange={(event) => {
                const channel = IMAGE_CHANNEL_OPTIONS.find(option => option.baseUrl === event.target.value);
                if (channel) applyImageChannel(channel.provider);
              }}
            >
              <option value="">自定义地址</option>
              {IMAGE_API_ENDPOINT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </details>

          <div className="form-group">
            <label className="form-label" htmlFor="image-base-url">API 地址</label>
            <input
              id="image-base-url"
              className="input"
              value={imageConfig.base_url}
              onChange={(event) => setImageConfig((prev) => ({ ...prev, base_url: event.target.value }))}
              placeholder={selectedImageChannel.baseUrl}
              autoComplete="off"
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="image-model-id">共享 API 上游模型 ID</label>
            <input
              id="image-model-id"
              className="input"
              value={imageConfig.default_model}
              onChange={(event) => setImageConfig((prev) => ({ ...prev, default_model: event.target.value }))}
              placeholder={selectedImageModel.model}
              autoComplete="off"
              maxLength={80}
              required
            />
            <small className="text-gray">这是共享 API 的上游参数，不是上方全站默认路由的图片型号。</small>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="image-api-key">API Key</label>
            <input
              id="image-api-key"
              className="input"
              type="password"
              value={imageApiKey}
              onChange={(event) => {
                setImageApiKey(event.target.value);
                if (event.target.value.trim()) setClearImageApiKey(false);
              }}
              placeholder={imageConfig.api_key_configured ? '当前已设置，留空不变' : '输入图形生成 API Key'}
              autoComplete="new-password"
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="image-timeout">超时时间 ms</label>
            <input
              id="image-timeout"
              className="input"
              type="number"
              min={5000}
              max={300000}
              step={1000}
              value={imageConfig.timeout_ms}
              onChange={(event) => setImageConfig((prev) => ({
                ...prev,
                timeout_ms: Number(event.target.value) || EMPTY_IMAGE_GENERATION_CONFIG.timeout_ms,
              }))}
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="image-max-outputs">单次最大张数</label>
            <input
              id="image-max-outputs"
              className="input"
              type="number"
              min={1}
              max={isSeedreamImageModel ? 1 : 8}
              value={imageConfig.max_outputs_per_request}
              disabled={isSeedreamImageModel}
              onChange={(event) => setImageConfig((prev) => ({
                ...prev,
                max_outputs_per_request: Number(event.target.value) || EMPTY_IMAGE_GENERATION_CONFIG.max_outputs_per_request,
              }))}
            />
            {isSeedreamImageModel && (
              <small id="seedream-reference-limit" className="text-gray">
                Seedream 5.0 Pro 最多 10 张参考图，单张输出。
              </small>
            )}
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="image-default-ratio">默认比例</label>
            <input
              id="image-default-ratio"
              className="input"
              value={imageConfig.default_ratio}
              onChange={(event) => setImageConfig((prev) => ({ ...prev, default_ratio: event.target.value }))}
              placeholder="16:9"
              maxLength={20}
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="image-default-size">分辨率档位</label>
            <select
              id="image-default-size"
              className="input"
              value={imageConfig.default_size}
              onChange={(event) => setImageConfig((prev) => ({
                ...prev,
                default_size: event.target.value as ImageGenerationConfig['default_size'],
              }))}
            >
              <option value="1K">速度优先 1K</option>
              <option value="2K">质量优先 2K</option>
            </select>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="image-output-format">输出格式</label>
            <select
              id="image-output-format"
              className="input"
              value={imageConfig.output_format}
              onChange={(event) => setImageConfig((prev) => ({
                ...prev,
                output_format: event.target.value as ImageGenerationConfig['output_format'],
              }))}
            >
              <option value="png">PNG，参考图和首尾帧优先</option>
              <option value="jpeg">JPEG，文件更小</option>
            </select>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="image-response-format">返回格式</label>
            <select
              id="image-response-format"
              className="input"
              value={imageConfig.response_format}
              onChange={(event) => setImageConfig((prev) => ({
                ...prev,
                response_format: event.target.value as ImageGenerationConfig['response_format'],
              }))}
            >
              <option value="url">URL，生成后立即下载入库</option>
              <option value="b64_json">Base64，直接入库</option>
            </select>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="image-watermark">水印</label>
            <label className="codex-clear-token image-watermark-toggle">
              <input
                id="image-watermark"
                type="checkbox"
                checked={imageConfig.watermark}
                onChange={(event) => setImageConfig((prev) => ({ ...prev, watermark: event.target.checked }))}
              />
              输出图片带水印
            </label>
          </div>
        </div>

        <div className="codex-config-status">
          <div>
            <span className="info-label">当前状态</span>
            <strong>{imageStatusText}</strong>
          </div>
          <div>
            <span className="info-label">图片模型</span>
            <strong>{selectedImageModel.label}</strong>
          </div>
          <div>
            <span className="info-label">默认模型</span>
            <strong>{imageConfig.default_model || '-'}</strong>
          </div>
          <div>
            <span className="info-label">能力</span>
            <strong>
              {[
                imageConfig.supports_text_to_image ? '文生图' : null,
                imageConfig.supports_image_to_image ? '图生图' : null,
                isSeedreamImageModel ? '多参考图' : null,
                isSeedreamImageModel ? '1K/2K' : null,
                isSeedreamImageModel ? '单张输出' : null,
                imageConfig.supports_async_task ? '异步任务' : null,
              ].filter(Boolean).join(' / ') || '-'}
            </strong>
          </div>
          <div>
            <span className="info-label">输出</span>
            <strong>{imageConfig.default_size} · {imageConfig.output_format.toUpperCase()} · {imageConfig.response_format}</strong>
          </div>
          <div>
            <span className="info-label">API Key</span>
            <strong>{imageConfig.api_key_configured ? '已设置' : '未设置'}</strong>
          </div>
        </div>

        <div className="codex-config-actions">
          <label className="codex-clear-token">
            <input
              type="checkbox"
              checked={clearImageApiKey}
              disabled={!imageConfig.api_key_configured || Boolean(imageApiKey.trim())}
              onChange={(event) => setClearImageApiKey(event.target.checked)}
            />
            清除当前 API Key
          </label>
          <button className="btn btn-primary sd2-loading-surface" data-busy={imageSaving} type="submit" disabled={imageSaving}>
            {imageSaving ? '正在保存' : '保存图形生成 API'}
          </button>
        </div>
      </form>}

      {(
        <section className="card codex-config-form" aria-labelledby="selected-image-channel-title">
          <div className="codex-config-head">
            <div>
              <h2 id="selected-image-channel-title" className="section-title mb-0">当前供应商配置</h2>
              <p className="text-gray text-sm mt-2 mb-0">
                {selectedManagedImageChannel?.supplierName || imageRouteCurrentChannel?.supplierName || '供应商'}
                {selectedManagedImageChannel?.label || imageRouteCurrentChannel?.label ? ` · ${selectedManagedImageChannel?.label || imageRouteCurrentChannel?.label}` : ''}
              </p>
            </div>
            {selectedManagedImageChannel && (
              <button className="btn btn-secondary" type="button" disabled={managedChannelSaving || managedChannelOutcomeUnknown}
                onClick={() => openManagedChannelDraft(managedChannelDraftFrom(selectedManagedImageChannel))}>
                编辑当前配置
              </button>
            )}
          </div>
          <div className="codex-config-status">
            <div><span className="info-label">用于此型号</span><strong>{imageChannels === null ? '通道信息未读取，暂不能确认' : imageChannelStatus(imageRouteCurrentChannel, selectedRouteModel)}</strong></div>
            <div><span className="info-label">通道状态</span><strong>{selectedManagedImageChannel?.deleted ? '已归档' : selectedManagedImageChannel?.enabled ? '已启用' : selectedManagedImageChannel ? '已停用' : '配置不存在'}</strong></div>
            <div><span className="info-label">此型号 API Key</span><strong>{selectedManagedModelCapability?.apiKeyConfigured ? selectedManagedModelCapability.apiKeyOverrideConfigured ? '独立密钥已设置' : '继承供应商密钥' : selectedManagedImageChannel?.apiKeyConfigured ? '继承供应商密钥' : '未设置'}</strong></div>
            <div><span className="info-label">供应商型号名称</span><strong>{selectedManagedModelCapability?.upstreamModel || selectedRouteModel}</strong></div>
            <div><span className="info-label">此型号 API 地址</span><strong>{selectedManagedModelCapability?.baseUrl || selectedManagedImageChannel?.baseUrl || '未设置'}</strong></div>
            <div><span className="info-label">{IMAGE_STUDIO_MODEL_LABELS[selectedRouteModel]}规格/计费</span><strong>{selectedManagedModelCapability
              ? `${selectedManagedModelCapability.qualities?.join(' / ') || '质量未知'} · ${selectedManagedModelCapability.resolutions?.join(' / ') || '分辨率未知'} · ${selectedManagedModelCapability.ratios?.join(' / ') || '比例未知'} · ${selectedManagedModelCapability.billingMode === 'fixed' ? `固定 ${selectedManagedModelCapability.fixedPoints ?? '未知'} 点/张` : selectedManagedModelCapability.billingMode === 'actual' ? '按实际账单' : '计费待确认'}`
              : '未配置此型号'}</strong></div>
          </div>
          {!selectedManagedImageChannel && <p className="text-gray text-sm mt-2 mb-0">供应商状态详情未读取到；此选择不会因此被标为可用。</p>}
        </section>
      )}

      <details className="card codex-config-form" open={channelManagementOpen} onToggle={event => setChannelManagementOpen(event.currentTarget.open)}>
        <summary style={{ cursor: 'pointer' }}>
          <strong>管理供应商配置</strong>
          <span className="text-gray"> · 新增、编辑、停用、归档或恢复；此处不决定各型号默认供应商</span>
        </summary>
        <div className="codex-config-head mt-3">
          <p className="text-gray text-sm mt-0 mb-0">
            每个供应商的 Key、协议和型号能力单独保存。未配置或未核实的通道仍可被选作默认，但会明确显示不能用于新任务。
          </p>
          <button
            className="btn btn-primary"
            type="button"
            disabled={managedChannelSaving || managedChannelOutcomeUnknown}
            onClick={() => openManagedChannelDraft(emptyManagedChannelDraft())}
          >
            新增供应商
          </button>
        </div>

        <div className="mt-3" role="list" aria-label="已保存供应商配置">
          {managedImageChannels.filter(channel => channel.id !== 'shared' && channel.id !== 'banana').map(channel => (
            <div key={channel.id} role="listitem" className="codex-config-actions" style={{ justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border-color, #d8dee8)', padding: '12px 0' }}>
              <div>
                <strong>{channel.label}</strong>
                <p className="text-gray text-sm mt-1 mb-0">
                  {channel.supplierName} · {channel.deleted ? '已归档' : channel.enabled ? '已启用' : '已停用'} · API Key {channel.apiKeyConfigured ? '已设置' : '未设置'} · 就绪型号 {managedChannelReadyModels(channel).join('、') || '暂无'}
                </p>
              </div>
              <div className="codex-config-actions">
                <button className="btn btn-secondary" type="button" disabled={managedChannelSaving || managedChannelOutcomeUnknown}
                  onClick={() => openManagedChannelDraft(managedChannelDraftFrom(channel))}>编辑</button>
                {channel.deleted ? (
                  <button className="btn btn-secondary" type="button" disabled={managedChannelSaving || managedChannelOutcomeUnknown} onClick={() => void runManagedChannelAction(channel, 'restore')}>
                    恢复（保持停用）
                  </button>
                ) : (
                  <>
                    <button className="btn btn-secondary" type="button" disabled={managedChannelSaving || managedChannelOutcomeUnknown}
                      onClick={() => void runManagedChannelAction(channel, 'update', !channel.enabled)}>
                      {channel.enabled ? '停用' : '启用'}
                    </button>
                    <button className="btn btn-secondary" type="button" disabled={managedChannelSaving || managedChannelOutcomeUnknown || channel.id === 'fluxport'}
                      onClick={async () => {
                        if (await confirm(`归档“${channel.label}”？已受理的任务仍会保留原配置，归档后不能新建任务。`, { title: '归档配置', confirmLabel: '归档', danger: true })) {
                          await runManagedChannelAction(channel, 'archive');
                        }
                      }}>
                      归档
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
          {!managedImageChannels.some(channel => channel.id !== 'shared' && channel.id !== 'banana') && <p className="text-gray text-sm">暂无额外供应商配置。</p>}
        </div>

        {managedChannelDraft && (
          <form className="codex-config-form mt-3" onSubmit={saveManagedImageChannel}>
            <div className="codex-config-head">
              <div>
                <h3 className="section-title mb-0">{managedChannelDraft.id ? '编辑供应商配置' : '新增供应商配置'}</h3>
                <p className="text-gray text-sm mt-2">
                  {managedChannelDraft.id === 'shared' || managedChannelDraft.id === 'banana'
                    ? '这里只保存当前型号的 API 配置，不改变共用设置、启停、规格和点数。新任务固定保存时的配置，原任务不变。'
                    : '启用只保存通道状态；每个型号仍需单独补齐规格与计费，才能用于新任务。按实际账单计费还需核实同一 API Key 与型号的账单证明。'}
                </p>
              </div>
              {managedChannelDraft.id !== 'shared' && managedChannelDraft.id !== 'banana' && <label className="toggle-switch" aria-label="启用该图片供应商">
                <input
                  type="checkbox"
                  checked={managedChannelDraft.enabled}
                  onChange={event => setManagedChannelDraft(current => current ? { ...current, enabled: event.target.checked } : current)}
                />
                <span className="toggle-slider"></span>
              </label>}
            </div>

            <p className="text-gray text-sm mt-2">
              {managedDraftSelectedCount === 0
                ? '当前未勾选型号。通道可以单独启用，但没有就绪型号前不能用于新任务。'
                : `当前勾选 ${managedDraftSelectedCount} 个型号。`}
              {managedDraftIncompleteModels.length > 0
                ? ` 待补：${managedDraftIncompleteModels.join('；')}。`
                : managedDraftSelectedCount > 0 ? ' 已填写草稿字段不代表供应商接口或账单已核实。' : ''}
              {managedDraftUsesActualBilling ? ' 按实际账单的型号还需核对同一 Key 的账单证明。' : ''}
            </p>

            {managedChannelDraft.id !== 'shared' && managedChannelDraft.id !== 'banana' && <div className="codex-config-grid">
              <div className="form-group">
                <label className="form-label" htmlFor="managed-image-label">配置名称</label>
                <input id="managed-image-label" className="input" required maxLength={120} value={managedChannelDraft.label}
                  onChange={event => setManagedChannelDraft(current => current ? { ...current, label: event.target.value } : current)} />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="managed-image-supplier">供应商真实名称</label>
                <input id="managed-image-supplier" className="input" required maxLength={120} value={managedChannelDraft.supplierName}
                  disabled={managedChannelDraft.supplierKind === 'fluxport'}
                  onChange={event => setManagedChannelDraft(current => current ? { ...current, supplierName: event.target.value } : current)} />
              </div>
              {!managedChannelDraft.id && (
                <div className="form-group">
                  <label className="form-label" htmlFor="managed-image-supplier-kind">供应商类型</label>
                  <select id="managed-image-supplier-kind" className="input" value={managedChannelDraft.supplierKind}
                    onChange={event => setManagedChannelDraft(current => current ? { ...current, supplierKind: event.target.value as 'musk' | 'other' } : current)}>
                    <option value="other">其他兼容供应商</option>
                    <option value="musk">Musk</option>
                  </select>
                </div>
              )}
              <div className="form-group">
                <label className="form-label" htmlFor="managed-image-base-url">供应商共用 API 地址</label>
                <input id="managed-image-base-url" className="input" type="url" required maxLength={2048}
                  value={managedChannelDraft.baseUrl || (managedChannelDraft.supplierKind === 'fluxport' ? 'https://api.uselg.top' : '')}
                  disabled={managedChannelDraft.supplierKind === 'fluxport'}
                  onChange={event => setManagedChannelDraft(current => current ? { ...current, baseUrl: event.target.value } : current)}
                  placeholder="https://api.example.com/v1" autoComplete="url" />
                <small className="text-gray">仅允许安全的 HTTPS 公网 API 地址。</small>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="managed-image-api-key">供应商共用 API Key</label>
                <input id="managed-image-api-key" className="input" type="password" value={managedChannelDraft.apiKey}
                  onChange={event => setManagedChannelDraft(current => current ? { ...current, apiKey: event.target.value, clearApiKey: event.target.value ? false : current.clearApiKey } : current)}
                  placeholder={managedChannelDraft.id ? '当前已设置，留空不变' : '输入 API Key'} autoComplete="new-password" />
                {managedChannelDraft.id && (
                  <label className="codex-clear-token mt-2">
                    <input type="checkbox" checked={managedChannelDraft.clearApiKey} disabled={!managedImageChannels.find(item => item.id === managedChannelDraft.id)?.apiKeyConfigured || Boolean(managedChannelDraft.apiKey)}
                      onChange={event => setManagedChannelDraft(current => current ? { ...current, clearApiKey: event.target.checked } : current)} />
                    清除当前 API Key
                  </label>
                )}
              </div>
            </div>}
            <div className="form-group mt-3">
              <strong>{managedChannelDraft.id === 'shared' || managedChannelDraft.id === 'banana' ? '当前型号 API 配置' : '型号能力与计费'}</strong>
              {managedChannelDraft.id !== 'shared' && managedChannelDraft.id !== 'banana' && <p className="text-gray text-sm mt-1">所有能力都需按供应商资料逐项确认；列表留空或数量未知时保持不可用。固定点数填 0 表示明确免费，不代表未知价格。</p>}
            </div>
            <div className="codex-config-grid">
              {IMAGE_STUDIO_MODELS.filter(model => model === (managedChannelDraft.editingModel || selectedRouteModel))
                .map(model => {
                  const capability = managedChannelDraft.models[model];
                  const missingFields = managedDraftCapabilityMissingFields(capability);
                  const prefix = `managed-${model}`;
                  const updateCapability = (patch: Partial<ChannelCapabilityDraft>) => setManagedChannelDraft(current => current ? {
                    ...current,
                    models: { ...current.models, [model]: { ...current.models[model], ...patch } },
                  } : current);
                  return (
                    <details key={model} open className="form-group" style={{ border: '1px solid var(--border-color, #d8dee8)', borderRadius: 10, padding: 12 }}>
                      <summary style={{ cursor: 'pointer' }}>
                        <strong>{IMAGE_STUDIO_MODEL_LABELS[model]}</strong>
                        <span className="text-gray">
                          {' · '}{!capability.enabled ? '未勾选' : missingFields.length ? `待补：${missingFields.join('、')}` : '字段已填，待服务端核验'}
                        </span>
                      </summary>
                      {model === 'gpt-image-2.5-flare' && managedChannelDraft.supplierKind === 'fluxport' && (
                        <div className="form-group mt-2">
                          {fluxportFlareFixedPointsPreset !== null ? (
                            <>
                              <button className="btn btn-secondary" type="button" disabled={managedChannelSaving || managedChannelOutcomeUnknown} onClick={applyFluxportFlareDraftPreset}>
                                基础文生图示例 + 沿用本站 Flare 点数（{fluxportFlareFixedPointsPreset} 点/张）
                              </button>
                              <small className="text-gray d-block mt-1">
                                只填入本次草稿：auto、1K、正方形、不用参考图；不立即保存。供应商实际账单和接口可用性仍待核实。
                              </small>
                            </>
                          ) : (
                            <p className="text-gray text-sm mb-0">当前没有可复用的本站 Flare 固定点数，不会预填点数；请按后台价格配置核对。</p>
                          )}
                        </div>
                      )}
                      <label className="codex-clear-token mt-2">
                        <input type="checkbox" checked={capability.enabled} disabled={managedChannelDraft.id === 'shared' || managedChannelDraft.id === 'banana'} onChange={event => updateCapability({ enabled: event.target.checked })} />
                        已确认该型号可用
                      </label>
                      <p className="text-gray text-sm mt-2">以下只影响此供应商的当前型号，新任务使用保存后的配置；已有任务保留原配置。保存配置不会改变上方默认供应商选择。</p>
                      <label className="form-label mt-2" htmlFor={`${prefix}-protocol`}>此型号请求协议</label>
                      <select id={`${prefix}-protocol`} className="input" value={capability.protocol}
                        onChange={event => updateCapability({ protocol: event.target.value as ChannelCapabilityDraft['protocol'] })}>
                        <option value="gemini_native">Gemini 原生生图</option>
                        <option value="openai_images">OpenAI 兼容生图</option>
                      </select>
                      <label className="form-label mt-2" htmlFor={`${prefix}-upstream-model`}>供应商型号名称</label>
                      <input id={`${prefix}-upstream-model`} className="input" maxLength={200} value={capability.upstreamModel}
                        onChange={event => updateCapability({ upstreamModel: event.target.value })} placeholder={`留空使用 ${model}`} />
                      <label className="form-label mt-2" htmlFor={`${prefix}-base-url`}>此型号 API 地址</label>
                      <input id={`${prefix}-base-url`} className="input" type="url" maxLength={2048} value={capability.baseUrl}
                        onChange={event => updateCapability({ baseUrl: event.target.value })} placeholder="留空继承供应商共用地址" />
                      <label className="form-label mt-2" htmlFor={`${prefix}-api-key`}>此型号独立 API Key</label>
                      <input id={`${prefix}-api-key`} className="input" type="password" maxLength={500} autoComplete="new-password" value={capability.apiKey}
                        onChange={event => updateCapability({ apiKey: event.target.value, clearApiKey: false })}
                        placeholder={managedImageChannels.find(item => item.id === managedChannelDraft.id)?.models[model]?.apiKeyOverrideConfigured
                          ? '独立密钥已设置，留空保留' : '未设置时继承供应商共用密钥'} />
                      <label className="codex-clear-token mt-2">
                        <input type="checkbox" checked={capability.clearApiKey}
                          disabled={!managedImageChannels.find(item => item.id === managedChannelDraft.id)?.models[model]?.apiKeyOverrideConfigured || Boolean(capability.apiKey)}
                          onChange={event => updateCapability({ clearApiKey: event.target.checked })} />
                        清除此型号独立密钥，改为继承供应商共用密钥
                      </label>
                      {(managedChannelDraft.id === 'shared' || managedChannelDraft.id === 'banana') && <label className="codex-clear-token mt-2">
                        <input type="checkbox" checked={capability.clearOverrides === true} onChange={event => updateCapability({ clearOverrides: event.target.checked })} />
                        保存时清除此型号全部独立 API 配置，恢复原共用接口
                      </label>}
                      {managedChannelDraft.id !== 'shared' && managedChannelDraft.id !== 'banana' && <>
                      <label className="form-label mt-2" htmlFor={`${prefix}-quality`}>质量选项</label>
                      <input id={`${prefix}-quality`} className="input" value={capability.qualities} onChange={event => updateCapability({ qualities: event.target.value })}
                        placeholder={IMAGE_STUDIO_MODEL_QUALITY_OPTIONS[model].join(', ')} />
                      <label className="form-label mt-2" htmlFor={`${prefix}-resolution`}>分辨率</label>
                      <input id={`${prefix}-resolution`} className="input" value={capability.resolutions} onChange={event => updateCapability({ resolutions: event.target.value })}
                        placeholder={IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS[model].join(', ')} />
                      <label className="form-label mt-2" htmlFor={`${prefix}-ratio`}>比例</label>
                      <input id={`${prefix}-ratio`} className="input" value={capability.ratios} onChange={event => updateCapability({ ratios: event.target.value })}
                        placeholder={STUDIO_RATIOS.join(', ')} />
                      <label className="form-label mt-2" htmlFor={`${prefix}-references`}>参考图上限</label>
                      <input id={`${prefix}-references`} className="input" type="number" min={0} max={10} step={1} value={capability.maxReferences}
                        onChange={event => updateCapability({ maxReferences: event.target.value })} placeholder="留空表示未知" />
                      <label className="form-label mt-2" htmlFor={`${prefix}-billing`}>计费方式</label>
                      <select id={`${prefix}-billing`} className="input" value={capability.billingMode} onChange={event => updateCapability({ billingMode: event.target.value as ChannelCapabilityDraft['billingMode'] })}>
                        <option value="">未确认（不可用）</option>
                        <option value="fixed">固定点数</option>
                        <option value="actual" disabled={managedChannelDraft.supplierKind !== 'musk'}>按实际账单（仅 Musk 同范围证明就绪时）</option>
                      </select>
                      {capability.billingMode === 'fixed' && <>
                        <label className="form-label mt-2" htmlFor={`${prefix}-points`}>每张点数</label>
                        <input id={`${prefix}-points`} className="input" type="number" min={0} step={1} value={capability.fixedPoints}
                          onChange={event => updateCapability({ fixedPoints: event.target.value })} placeholder="0 表示明确免费" />
                      </>}
                      {capability.billingMode === 'actual' && (
                        <small className="text-gray d-block mt-2">提交时会按同一 API Key 和该型号核对账单证明；未就绪前不能用于新任务。</small>
                      )}
                      </>}
                    </details>
                  );
                })}
            </div>

            <div className="codex-config-actions">
              <button className="btn btn-secondary" type="button" disabled={managedChannelSaving} onClick={async () => {
                if (await confirm('放弃当前未保存的图片供应商修改？', { title: '放弃修改', confirmLabel: '放弃', danger: true })) {
                  managedChannelDraftBaseline.current = '';
                  setManagedChannelDraft(null);
                }
              }}>取消</button>
            <button className="btn btn-primary sd2-loading-surface" type="submit" disabled={managedChannelSaving || managedChannelOutcomeUnknown} data-busy={managedChannelSaving}>
                {managedChannelSaving ? '正在保存' : managedChannelDraft.id === 'shared' || managedChannelDraft.id === 'banana' ? '保存此型号 API 配置' : '保存供应商配置'}
              </button>
            </div>
          </form>
        )}
      </details>

      <form className="card codex-config-form" onSubmit={saveConfig}>
        <div className="codex-config-head">
          <div>
            <h2 className="section-title mb-0">Codex 视频接口</h2>
            <p className="text-gray text-sm mt-2">
              token 只保存哈希，页面不会回显明文。留空表示沿用当前 token。
            </p>
          </div>
          <label className="toggle-switch" aria-label="启用 Codex 视频接口">
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(event) => setConfig((prev) => ({ ...prev, enabled: event.target.checked }))}
            />
            <span className="toggle-slider"></span>
          </label>
        </div>

        <div className="codex-config-grid">
          <div className="form-group">
            <label className="form-label" htmlFor="codex-source-label">后台来源名称</label>
            <input
              id="codex-source-label"
              className="input"
              value={config.source_label}
              onChange={(event) => setConfig((prev) => ({ ...prev, source_label: event.target.value }))}
              placeholder="Codex API"
              maxLength={80}
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="codex-user-selector-type">绑定用户方式</label>
            <select
              id="codex-user-selector-type"
              className="input"
              value={config.user_selector.type}
              onChange={(event) => updateSelector({ type: event.target.value as UserSelectorType })}
            >
              <option value="email">邮箱</option>
              <option value="username">用户名</option>
              <option value="id">用户 ID</option>
            </select>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="codex-user-selector-value">
              {selectorLabel(config.user_selector.type)}
            </label>
            <input
              id="codex-user-selector-value"
              className="input"
              value={config.user_selector.value}
              onChange={(event) => updateSelector({ value: event.target.value })}
              placeholder={config.user_selector.type === 'email' ? 'admin@local.test' : '输入绑定用户'}
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="codex-token">接口 token</label>
            <input
              id="codex-token"
              className="input"
              type="password"
              value={token}
              onChange={(event) => {
                setToken(event.target.value);
                if (event.target.value.trim()) setClearToken(false);
              }}
              placeholder={config.token_configured ? `当前 ${config.token_preview || '已设置'}，留空不变` : '输入长随机 token'}
              autoComplete="new-password"
            />
          </div>
        </div>

        <div className="codex-config-status">
          <div>
            <span className="info-label">当前状态</span>
            <strong>{statusText}</strong>
          </div>
          <div>
            <span className="info-label">Token</span>
            <strong>{config.token_configured ? (config.token_preview || '已设置') : '未设置'}</strong>
          </div>
          <div>
            <span className="info-label">绑定用户</span>
            <strong>
              {config.linked_user ? (
                <UserIdentityBadge user={config.linked_user} size="sm" subtitle={linkedUserSubtitle(config)} />
              ) : linkedUserSubtitle(config)}
            </strong>
          </div>
        </div>

        <div className="codex-config-actions">
          <label className="codex-clear-token">
            <input
              type="checkbox"
              checked={clearToken}
              disabled={!config.token_configured || Boolean(token.trim())}
              onChange={(event) => setClearToken(event.target.checked)}
            />
            清除当前 token
          </label>
          <button className="btn btn-primary sd2-loading-surface" data-busy={saving} type="submit" disabled={saving}>
            {saving ? '正在保存' : '保存配置'}
          </button>
        </div>

      </form>
    </fieldset>
  );
}
