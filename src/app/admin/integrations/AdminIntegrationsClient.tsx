'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import PageBanner from '@/components/PageBanner';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import { displayUserSubtitle } from '@/lib/users/display';

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

type ImageGenerationConfig = {
  enabled: boolean;
  ready: boolean;
  provider: 'musk';
  base_url: string;
  default_model: string;
  api_key_configured: boolean;
  timeout_ms: number;
  max_outputs_per_request: number;
  default_ratio: string;
  supports_text_to_image: boolean;
  supports_image_to_image: boolean;
  supports_async_task: boolean;
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
  supports_text_to_image: true,
  supports_image_to_image: true,
  supports_async_task: false,
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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [muskSaving, setMuskSaving] = useState(false);
  const [muskTesting, setMuskTesting] = useState(false);
  const [imageSaving, setImageSaving] = useState(false);
  const [token, setToken] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [muskApiKey, setMuskApiKey] = useState('');
  const [clearMuskApiKey, setClearMuskApiKey] = useState(false);
  const [imageApiKey, setImageApiKey] = useState('');
  const [clearImageApiKey, setClearImageApiKey] = useState(false);
  const [submitState, setSubmitState] = useState<SubmitState>(null);
  const [muskTestState, setMuskTestState] = useState<MuskTestState>(null);

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

  const loadConfig = async () => {
    try {
      const [codexRes, muskRes, imageRes] = await Promise.all([
        fetch('/api/admin/integrations/codex', { cache: 'no-store' }),
        fetch('/api/admin/integrations/musk', { cache: 'no-store' }),
        fetch('/api/admin/integrations/image-generation', { cache: 'no-store' }),
      ]);
      const [codexData, muskData, imageData] = await Promise.all([
        codexRes.json(),
        muskRes.json(),
        imageRes.json(),
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
      setConfig(codexData.config || EMPTY_CONFIG);
      setMuskConfig(muskData.config || EMPTY_MUSK_CONFIG);
      setImageConfig(imageData.config || EMPTY_IMAGE_GENERATION_CONFIG);
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
          description="统一维护 Musk API、图形生成 API、Codex API 和外部工具调用 sd2 的后端配置。"
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
        description="在这里维护 Musk API、图形生成 API、Codex API 和外部工具调用配置，生成任务才能进入同一套扣费与后台留痕。"
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
          <span className="stat-sub">{imageConfig.provider} · {imageConfig.default_model || 'gemini-3.1-flash-image-preview'}</span>
        </div>
      </div>

      {submitState && (
        <div className={`alert ${submitState.type === 'success' ? 'alert-success' : 'alert-error'} mt-4`}>
          {submitState.message}
        </div>
      )}

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
            <h2 className="section-title mb-0">图形生成 API</h2>
            <p className="text-gray text-sm mt-2">
              保存文生图、图生图和首尾帧草图服务配置；普通生成页和无线画布后续都从这里读取。
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
          <div className="form-group">
            <label className="form-label" htmlFor="image-provider">Provider</label>
            <select
              id="image-provider"
              className="input"
              value={imageConfig.provider}
              onChange={(event) => setImageConfig((prev) => ({ ...prev, provider: event.target.value as 'musk' }))}
            >
              <option value="musk">Musk APIs / Gemini Image</option>
            </select>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="image-base-url">API 地址</label>
            <input
              id="image-base-url"
              className="input"
              value={imageConfig.base_url}
              onChange={(event) => setImageConfig((prev) => ({ ...prev, base_url: event.target.value }))}
              placeholder="https://api.muskapis.com/"
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
              placeholder="gemini-3.1-flash-image-preview"
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
              max={8}
              value={imageConfig.max_outputs_per_request}
              onChange={(event) => setImageConfig((prev) => ({
                ...prev,
                max_outputs_per_request: Number(event.target.value) || EMPTY_IMAGE_GENERATION_CONFIG.max_outputs_per_request,
              }))}
            />
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
        </div>

        <div className="codex-config-status">
          <div>
            <span className="info-label">当前状态</span>
            <strong>{imageStatusText}</strong>
          </div>
          <div>
            <span className="info-label">Provider</span>
            <strong>{imageConfig.provider}</strong>
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
                imageConfig.supports_async_task ? '异步任务' : null,
              ].filter(Boolean).join(' / ') || '-'}
            </strong>
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
