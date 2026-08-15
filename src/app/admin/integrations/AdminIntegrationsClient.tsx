'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import PageBanner from '@/components/PageBanner';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import { displayUserSubtitle } from '@/lib/users/display';
import { VOLCENGINE_IP_MODEL_OPTIONS } from '@/lib/integrations/volcengine-ip-models';

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

type ImageGenerationProvider = 'musk' | 'seedream';

type ImageGenerationConfig = {
  enabled: boolean;
  ready: boolean;
  provider: 'musk' | 'seedream';
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
  admin_queue_ready: boolean;
  provider: 'h3_video';
  base_url: string;
  health_path: string;
  presets_path: string;
  generate_path: string;
  default_preset_id: 'larry_v4_6step' | 'larry_v4_8step' | 'lightx2v_4step_turbo';
  preset_options: Array<{
    id: 'larry_v4_6step' | 'larry_v4_8step' | 'lightx2v_4step_turbo';
    label: string;
    detail: string;
  }>;
  api_token_configured: boolean;
  admin_token_configured: boolean;
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
  default_model: 'gpt-5.4',
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

const IMAGE_MODEL_OPTIONS: Array<{
  provider: ImageGenerationProvider;
  label: string;
  model: string;
  baseUrl: string;
  summary: string;
  tags: string[];
  maxOutputs: number;
  supportsAsyncTask: boolean;
  defaultSize: '1K' | '2K';
}> = [
  {
    provider: 'musk',
    label: 'Gemini Image (Musk)',
    model: 'gemini-3.1-flash-image-preview',
    baseUrl: 'https://api.muskapis.com/',
    summary: '通用草图、普通参考图和兼容旧配置。',
    tags: ['文生图', '图生图', '通用草图'],
    maxOutputs: 8,
    supportsAsyncTask: false,
    defaultSize: '2K',
  },
  {
    provider: 'seedream',
    label: 'Seedream 5.0 Pro',
    model: 'doubao-seedream-5-0-pro-260628',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    summary: '适合高质量参考图、首帧、尾帧和多参考图生图。',
    tags: ['高质量参考图', '最多 10 张参考图', '1K/2K', '单张输出'],
    maxOutputs: 1,
    supportsAsyncTask: false,
    defaultSize: '2K',
  },
];

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
  admin_queue_ready: false,
  provider: 'h3_video',
  base_url: 'http://127.0.0.1:8893',
  health_path: '/health',
  presets_path: '/api/h3/presets',
  generate_path: '/api/h3/generate',
  default_preset_id: 'larry_v4_6step',
  preset_options: [
    { id: 'larry_v4_6step', label: '推荐', detail: '默认质量和速度平衡' },
    { id: 'larry_v4_8step', label: '画质优先', detail: '更多步数，细节更稳' },
    { id: 'lightx2v_4step_turbo', label: '快速预览', detail: '速度优先，用于草稿' },
  ],
  api_token_configured: false,
  admin_token_configured: false,
  missing: ['api_token'],
};

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

export default function AdminIntegrationsClient() {
  const [config, setConfig] = useState<CodexConfig>(EMPTY_CONFIG);
  const [muskConfig, setMuskConfig] = useState<MuskConfig>(EMPTY_MUSK_CONFIG);
  const [imageConfig, setImageConfig] = useState<ImageGenerationConfig>(EMPTY_IMAGE_GENERATION_CONFIG);
  const [volcengineConfig, setVolcengineConfig] = useState<VolcengineIpConfig>(EMPTY_VOLCENGINE_IP_CONFIG);
  const [aiMediaKitConfig, setAiMediaKitConfig] = useState<AiMediaKitConfig>(EMPTY_AIMEDIAKIT_CONFIG);
  const [h3Config, setH3Config] = useState<H3Config>(EMPTY_H3_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [muskSaving, setMuskSaving] = useState(false);
  const [muskTesting, setMuskTesting] = useState(false);
  const [imageSaving, setImageSaving] = useState(false);
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
    () => IMAGE_MODEL_OPTIONS.find((option) => option.provider === imageConfig.provider) || IMAGE_MODEL_OPTIONS[0],
    [imageConfig.provider],
  );
  const isSeedreamImageModel = imageConfig.provider === 'seedream';

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
    return '配置未就绪';
  }, [h3Config]);

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
      setImageConfig(imageData.config || EMPTY_IMAGE_GENERATION_CONFIG);
      setVolcengineConfig(volcengineData.config || EMPTY_VOLCENGINE_IP_CONFIG);
      setAiMediaKitConfig(aiMediaKitData.config || EMPTY_AIMEDIAKIT_CONFIG);
      setH3Config(h3Data.config || EMPTY_H3_CONFIG);
    } catch (error) {
      setSubmitState({ type: 'error', message: error instanceof Error ? error.message : '读取配置失败' });
    } finally {
      setLoading(false);
    }
  };

  const saveMuskConfig = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
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
      if (!res.ok) {
        setSubmitState({ type: 'error', message: data.error || data.message || '保存失败' });
        return;
      }
      setMuskConfig(data.config || muskConfig);
      setMuskApiKey('');
      setClearMuskApiKey(false);
      setSubmitState({ type: 'success', message: 'Musk API 配置已保存到后台配置。' });
    } catch (error) {
      setSubmitState({ type: 'error', message: error instanceof Error ? error.message : '保存失败' });
    } finally {
      setMuskSaving(false);
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
      if (!res.ok) {
        setSubmitState({ type: 'error', message: data.error || data.message || '保存失败' });
        return;
      }
      setImageConfig(data.config || imageConfig);
      setImageApiKey('');
      setClearImageApiKey(false);
      setSubmitState({ type: 'success', message: '图形生成 API 配置已保存到后台配置。' });
    } catch (error) {
      setSubmitState({ type: 'error', message: error instanceof Error ? error.message : '保存失败' });
    } finally {
      setImageSaving(false);
    }
  };

  const applyImageModel = (provider: ImageGenerationProvider) => {
    const option = IMAGE_MODEL_OPTIONS.find((item) => item.provider === provider) || IMAGE_MODEL_OPTIONS[0];
    setImageConfig((prev) => ({
      ...prev,
      provider: option.provider,
      base_url: option.baseUrl,
      default_model: option.model,
      max_outputs_per_request: option.maxOutputs,
      default_size: option.defaultSize,
      output_format: prev.output_format || 'png',
      response_format: prev.response_format || 'url',
      watermark: option.provider === 'seedream' ? false : prev.watermark,
      supports_text_to_image: true,
      supports_image_to_image: true,
      supports_async_task: option.supportsAsyncTask,
    }));
  };

  const saveVolcengineConfig = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
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
      if (!res.ok) {
        setSubmitState({ type: 'error', message: data.error || data.message || '保存失败' });
        return;
      }
      setVolcengineConfig(data.config || volcengineConfig);
      setVolcengineApiKey('');
      setClearVolcengineApiKey(false);
      setSubmitState({ type: 'success', message: '火山 IP 生成 API 配置已保存到后台配置。' });
    } catch (error) {
      setSubmitState({ type: 'error', message: error instanceof Error ? error.message : '保存失败' });
    } finally {
      setVolcengineSaving(false);
    }
  };

  const saveAiMediaKitConfig = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
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
      if (!res.ok) {
        setSubmitState({ type: 'error', message: data.error || data.message || '保存失败' });
        return;
      }
      setAiMediaKitConfig(data.config || aiMediaKitConfig);
      setAiMediaKitApiKey('');
      setClearAiMediaKitApiKey(false);
      setSubmitState({ type: 'success', message: 'AI MediaKit 视频超分 API 配置已保存到后台配置。' });
    } catch (error) {
      setSubmitState({ type: 'error', message: error instanceof Error ? error.message : '保存失败' });
    } finally {
      setAiMediaKitSaving(false);
    }
  };

  const saveH3Config = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
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
          api_token: h3ApiToken,
          admin_token: h3AdminToken,
          clear_api_token: clearH3ApiToken,
          clear_admin_token: clearH3AdminToken,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSubmitState({ type: 'error', message: data.error || data.message || '保存失败' });
        return;
      }
      setH3Config(data.config || h3Config);
      setH3ApiToken('');
      setH3AdminToken('');
      setClearH3ApiToken(false);
      setClearH3AdminToken(false);
      setSubmitState({ type: 'success', message: 'H3 本地生成服务配置已保存。' });
    } catch (error) {
      setSubmitState({ type: 'error', message: error instanceof Error ? error.message : '保存失败' });
    } finally {
      setH3Saving(false);
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
      setH3Config(data.config || h3Config);
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
      && !window.confirm(`确认执行 H3 ${h3QueueAction === 'cancel' ? '取消排队任务' : '停止运行任务'}？`)) {
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
      if (!res.ok) {
        setSubmitState({ type: 'error', message: data.error || data.message || '保存失败' });
        return;
      }
      setConfig(data.config || config);
      setToken('');
      setClearToken(false);
      setSubmitState({ type: 'success', message: 'Codex 接口配置已保存到后台配置。' });
    } catch (error) {
      setSubmitState({ type: 'error', message: error instanceof Error ? error.message : '保存失败' });
    } finally {
      setSaving(false);
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
          <p className="text-gray">正在读取配置...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-integrations-page">
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
          <span className="stat-sub">{muskConfig.default_model || 'gpt-5.4'} · {muskConfig.base_url || '未配置地址'}</span>
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
            {h3Config.default_preset_id} · {h3Config.api_token_configured ? '用户 token 已设置' : '用户 token 未设置'}
          </span>
        </div>
      </div>

      {submitState && (
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
            <strong>{h3Config.health_path}</strong>
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
              <span>{h3Config.admin_queue_ready ? '可读取队列并执行管理员操作' : '需要先配置管理员 token'}</span>
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
                <span className="text-gray text-sm">队列操作只在 H3 API 地址、用户 token 和管理员 token 都就绪后开放。</span>
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
          <button className="btn btn-primary" type="submit" disabled={h3Saving}>
            {h3Saving ? '正在保存' : '保存 H3 本地生成服务'}
          </button>
        </div>

        {h3TestState && (
          <div className={`codex-config-test-result ${h3TestState.type === 'success' ? 'is-success' : 'is-error'}`}>
            <strong>{h3TestState.message}</strong>
            {h3TestState.type === 'success' && (
              <span>
                API {h3TestState.health_api || '-'} · Worker {h3TestState.worker || '-'} · ComfyUI {h3TestState.comfyui || '-'}
                {h3TestState.tested_at ? ` · ${new Date(h3TestState.tested_at).toLocaleString('zh-CN')}` : ''}
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
          <button className="btn btn-primary" type="submit" disabled={aiMediaKitSaving}>
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
          <button className="btn btn-primary" type="submit" disabled={volcengineSaving}>
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
              placeholder="gpt-5.4"
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
          <button className="btn btn-primary" type="submit" disabled={muskSaving}>
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
                {muskTestState.tested_at ? ` · ${new Date(muskTestState.tested_at).toLocaleString('zh-CN')}` : ''}
              </span>
            )}
            {muskTestState.type === 'error' && <span>请先确认地址、模型和 API Key 已保存。</span>}
          </div>
        )}
      </form>

      <form className="card codex-config-form" onSubmit={saveImageConfig}>
        <div className="codex-config-head">
          <div>
            <h2 className="section-title mb-0">图片模型配置</h2>
            <p className="text-gray text-sm mt-2">
              保存文生图、图生图和首尾帧草图模型；普通生成页和无线画布后续都从这里读取。
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
          <div className="form-group image-model-field">
            <label className="form-label" htmlFor="image-provider">图片模型</label>
            <select
              id="image-provider"
              className="input"
              value={imageConfig.provider}
              onChange={(event) => applyImageModel(event.target.value as ImageGenerationProvider)}
            >
              {IMAGE_MODEL_OPTIONS.map((option) => (
                <option key={option.provider} value={option.provider}>
                  {option.label}
                </option>
              ))}
            </select>
            <div className="image-model-options" aria-label="图片模型能力">
              {IMAGE_MODEL_OPTIONS.map((option) => {
                const active = imageConfig.provider === option.provider;
                return (
                  <button
                    key={option.provider}
                    className={`image-model-option${active ? ' is-active' : ''}`}
                    type="button"
                    aria-pressed={active}
                    onClick={() => applyImageModel(option.provider)}
                  >
                    <span>{option.label}</span>
                    <small>{option.summary}</small>
                    <em>{option.tags.join(' / ')}</em>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="image-base-url">API 地址</label>
            <input
              id="image-base-url"
              className="input"
              value={imageConfig.base_url}
              onChange={(event) => setImageConfig((prev) => ({ ...prev, base_url: event.target.value }))}
              placeholder={selectedImageModel.baseUrl}
              autoComplete="off"
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="image-default-model">默认模型</label>
            <input
              id="image-default-model"
              className="input"
              value={imageConfig.default_model}
              onChange={(event) => setImageConfig((prev) => ({ ...prev, default_model: event.target.value }))}
              placeholder={selectedImageModel.model}
              autoComplete="off"
              maxLength={80}
              required
            />
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
          <button className="btn btn-primary" type="submit" disabled={imageSaving}>
            {imageSaving ? '正在保存' : '保存图形生成 API'}
          </button>
        </div>
      </form>

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
          <button className="btn btn-primary" type="submit" disabled={saving}>
            {saving ? '正在保存' : '保存配置'}
          </button>
        </div>

      </form>
    </div>
  );
}
