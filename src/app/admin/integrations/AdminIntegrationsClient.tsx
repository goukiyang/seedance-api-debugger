'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import PageBanner from '@/components/PageBanner';
import { displayUserName, displayUserSubtitle } from '@/lib/users/display';

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
    role: string;
    status: string;
  } | null;
};

type SubmitState = {
  type: 'success' | 'error';
  message: string;
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

function selectorLabel(type: UserSelectorType) {
  if (type === 'id') return '用户 ID';
  if (type === 'username') return '用户名';
  return '邮箱';
}

function linkedUserText(config: CodexConfig) {
  if (!config.linked_user) return '未匹配到用户';
  const user = config.linked_user;
  return `${displayUserName(user)} · ${displayUserSubtitle(user) || user.id.slice(0, 8)} · ${user.status}`;
}

export default function AdminIntegrationsClient() {
  const [config, setConfig] = useState<CodexConfig>(EMPTY_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [token, setToken] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [submitState, setSubmitState] = useState<SubmitState>(null);

  const statusText = useMemo(() => {
    if (config.ready) return '已启用，可被 Codex 调用';
    if (!config.enabled) return '未启用';
    if (!config.token_configured) return '缺少 token';
    if (!config.linked_user) return '绑定用户无效';
    return '配置未就绪';
  }, [config]);

  const loadConfig = async () => {
    try {
      const res = await fetch('/api/admin/integrations/codex', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) {
        setSubmitState({ type: 'error', message: data.error || '读取配置失败' });
        return;
      }
      setConfig(data.config || EMPTY_CONFIG);
    } catch (error) {
      setSubmitState({ type: 'error', message: error instanceof Error ? error.message : '读取配置失败' });
    } finally {
      setLoading(false);
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
          title="接口配置"
          description="统一维护外部工具调用 sd2 的后端配置。"
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
        title="接口配置"
        description="Codex 这类外部工具必须从这里启用、绑定用户和记录来源，生成任务才会进入同一套扣费与后台留痕。"
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
          <strong className="stat-value">{config.linked_user?.username || '-'}</strong>
          <span className="stat-sub">{linkedUserText(config)}</span>
        </div>
      </div>

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
            <strong>{linkedUserText(config)}</strong>
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

        {submitState && (
          <div className={`alert ${submitState.type === 'success' ? 'alert-success' : 'alert-error'} mt-4`}>
            {submitState.message}
          </div>
        )}
      </form>
    </div>
  );
}
