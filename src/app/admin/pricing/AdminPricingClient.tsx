'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import type { SessionUser } from '@/lib/auth/session';

interface PricingRuleRecord {
  id: string;
  rule_key: string;
  name: string;
  model: string;
  resolution: string;
  is_fast: boolean;
  base_cost_per_second: number;
  internal_multiplier: number;
  final_cost_per_second: number;
  version: number;
  status: string;
  effective_at: string;
  supersedes_rule_id: string | null;
  created_at: string;
  updated_at: string;
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '10px 12px',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 8,
  background: 'rgba(255,255,255,0.06)',
  color: '#fff',
  fontSize: 14,
};

const buttonStyle: React.CSSProperties = {
  border: 'none',
  borderRadius: 8,
  padding: '10px 14px',
  background: '#6366f1',
  color: '#fff',
  fontWeight: 700,
  cursor: 'pointer',
};

function formatDate(value: string | null) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN');
}

function toDateTimeLocal(value: string | null) {
  const date = value ? new Date(value) : new Date();
  const offset = date.getTimezoneOffset();
  const normalized = new Date(date.getTime() - offset * 60_000);
  return normalized.toISOString().slice(0, 16);
}

function buildEmptyForm() {
  return {
    id: '',
    mode: 'create',
    name: '',
    model: 'dreamina-seedance-2-0-260128',
    resolution: '720p',
    is_fast: false,
    base_cost_per_second: '12',
    internal_multiplier: '1',
    status: 'active',
    effective_at: toDateTimeLocal(null),
  };
}

export default function AdminPricingClient({ currentUser }: { currentUser: SessionUser }) {
  const [rules, setRules] = useState<PricingRuleRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(buildEmptyForm());

  const versioning = form.mode === 'version' && Boolean(form.id);
  const calculatedFinal = useMemo(() => {
    const base = Number(form.base_cost_per_second || 0);
    const multiplier = Number(form.internal_multiplier || 0);
    if (!Number.isFinite(base) || !Number.isFinite(multiplier)) return 0;
    return Math.round(base * multiplier * 10000) / 10000;
  }, [form.base_cost_per_second, form.internal_multiplier]);

  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/pricing-rules', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '无法加载计费规则');
      setRules(data.rules || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const resetForm = () => {
    setForm(buildEmptyForm());
  };

  const startVersion = (rule: PricingRuleRecord) => {
    setForm({
      id: rule.id,
      mode: 'version',
      name: rule.name,
      model: rule.model,
      resolution: rule.resolution,
      is_fast: rule.is_fast,
      base_cost_per_second: String(rule.base_cost_per_second),
      internal_multiplier: String(rule.internal_multiplier),
      status: 'active',
      effective_at: toDateTimeLocal(null),
    });
    setMessage('');
    setError('');
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setMessage('');
    setError('');

    try {
      const url = versioning ? `/api/admin/pricing-rules/${form.id}` : '/api/admin/pricing-rules';
      const method = versioning ? 'PATCH' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          model: form.model,
          resolution: form.resolution,
          is_fast: form.is_fast,
          base_cost_per_second: Number(form.base_cost_per_second),
          internal_multiplier: Number(form.internal_multiplier),
          status: form.status,
          effective_at: new Date(form.effective_at).toISOString(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '保存失败');
      setMessage(versioning ? '已创建新版本计费规则' : '计费规则已创建');
      resetForm();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const disableRule = async (rule: PricingRuleRecord) => {
    const ok = window.confirm(`确认停用规则「${rule.name} v${rule.version}」？`);
    if (!ok) return;
    setMessage('');
    setError('');
    const res = await fetch(`/api/admin/pricing-rules/${rule.id}/disable`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || '停用失败');
      return;
    }
    if (form.id === rule.id) resetForm();
    setMessage('计费规则已停用');
    await refresh();
  };

  return (
    <main style={{ minHeight: '100vh', background: '#0f0f13', color: '#fff', padding: 24 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 24 }}>
        <div>
          <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 13 }}>管理员后台</div>
          <h1 style={{ margin: '4px 0 8px', fontSize: 28 }}>计费规则管理</h1>
          <div style={{ color: 'rgba(255,255,255,0.6)', maxWidth: 760 }}>
            新建或停用规则，编辑时通过新版本生效，旧任务继续保留创建当时的 pricing snapshot。
          </div>
        </div>
        <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13, textAlign: 'right' }}>
          <div>{currentUser.name} · {currentUser.email}</div>
          <div style={{ marginTop: 8, display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <Link href="/admin/tasks" style={{ ...buttonStyle, textDecoration: 'none' }}>任务</Link>
            <Link href="/admin/users" style={{ ...buttonStyle, textDecoration: 'none' }}>用户</Link>
            <Link href="/admin/resources" style={{ ...buttonStyle, textDecoration: 'none', background: '#334155' }}>资源</Link>
          </div>
        </div>
      </header>

      {(message || error) && (
        <div style={{
          marginBottom: 16,
          padding: '10px 12px',
          borderRadius: 8,
          color: error ? '#ff8a8a' : '#86efac',
          background: error ? 'rgba(255,80,80,0.1)' : 'rgba(80,255,140,0.1)',
          border: error ? '1px solid rgba(255,80,80,0.25)' : '1px solid rgba(80,255,140,0.25)',
        }}>
          {error || message}
        </div>
      )}

      <section style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.35fr) minmax(360px, 0.95fr)', gap: 16 }}>
        <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ padding: 16, borderBottom: '1px solid rgba(255,255,255,0.08)', fontWeight: 700 }}>
            规则列表
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.55)' }}>
                <tr>
                  <th style={{ textAlign: 'left', padding: 12 }}>规则</th>
                  <th style={{ textAlign: 'left', padding: 12 }}>模型</th>
                  <th style={{ textAlign: 'left', padding: 12 }}>分辨率</th>
                  <th style={{ textAlign: 'right', padding: 12 }}>基础/秒</th>
                  <th style={{ textAlign: 'right', padding: 12 }}>倍率</th>
                  <th style={{ textAlign: 'right', padding: 12 }}>最终/秒</th>
                  <th style={{ textAlign: 'left', padding: 12 }}>生效时间</th>
                  <th style={{ textAlign: 'left', padding: 12 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule.id} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                    <td style={{ padding: 12, minWidth: 200 }}>
                      <div style={{ fontWeight: 700 }}>{rule.name}</div>
                      <div style={{ color: 'rgba(255,255,255,0.45)' }}>v{rule.version} · {rule.status}</div>
                    </td>
                    <td style={{ padding: 12 }}>{rule.model}</td>
                    <td style={{ padding: 12 }}>
                      {rule.resolution}
                      {rule.is_fast ? ' · fast' : ''}
                    </td>
                    <td style={{ padding: 12, textAlign: 'right' }}>{rule.base_cost_per_second}</td>
                    <td style={{ padding: 12, textAlign: 'right' }}>{rule.internal_multiplier}</td>
                    <td style={{ padding: 12, textAlign: 'right' }}>{rule.final_cost_per_second}</td>
                    <td style={{ padding: 12 }}>
                      <div>{formatDate(rule.effective_at)}</div>
                      <div style={{ color: 'rgba(255,255,255,0.45)' }}>更新 {formatDate(rule.updated_at)}</div>
                    </td>
                    <td style={{ padding: 12 }}>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button style={{ ...buttonStyle, padding: '7px 10px' }} onClick={() => startVersion(rule)}>新版本</button>
                        <button
                          style={{ ...buttonStyle, padding: '7px 10px', background: '#ef4444' }}
                          onClick={() => disableRule(rule)}
                          disabled={rule.status === 'disabled'}
                        >
                          停用
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!loading && rules.length === 0 && (
                  <tr><td colSpan={8} style={{ padding: 24, color: 'rgba(255,255,255,0.45)' }}>暂无计费规则，系统会先使用默认服务端回退规则</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <form onSubmit={submit} style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: 16, display: 'grid', gap: 12, alignSelf: 'start' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontWeight: 700 }}>{versioning ? '创建规则新版本' : '创建计费规则'}</div>
            {versioning && (
              <button type="button" style={{ ...buttonStyle, background: '#334155' }} onClick={resetForm}>取消</button>
            )}
          </div>

          <input style={inputStyle} placeholder="规则名" value={form.name} onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))} />
          <input style={inputStyle} placeholder="模型标识" value={form.model} onChange={(e) => setForm((prev) => ({ ...prev, model: e.target.value }))} />
          <select style={inputStyle} value={form.resolution} onChange={(e) => setForm((prev) => ({ ...prev, resolution: e.target.value }))}>
            <option value="480p">480p</option>
            <option value="720p">720p</option>
          </select>
          <label style={{ ...inputStyle, display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={form.is_fast} onChange={(e) => setForm((prev) => ({ ...prev, is_fast: e.target.checked }))} />
            fast 模式
          </label>
          <input style={inputStyle} type="number" min="0" step="0.0001" placeholder="基础点数 / 秒" value={form.base_cost_per_second} onChange={(e) => setForm((prev) => ({ ...prev, base_cost_per_second: e.target.value }))} />
          <input style={inputStyle} type="number" min="0" step="0.0001" placeholder="内部倍率" value={form.internal_multiplier} onChange={(e) => setForm((prev) => ({ ...prev, internal_multiplier: e.target.value }))} />
          <div style={{ ...inputStyle, color: 'rgba(255,255,255,0.82)' }}>
            最终点数 / 秒: {calculatedFinal}
          </div>
          <input style={inputStyle} type="datetime-local" value={form.effective_at} onChange={(e) => setForm((prev) => ({ ...prev, effective_at: e.target.value }))} />
          <select style={inputStyle} value={form.status} onChange={(e) => setForm((prev) => ({ ...prev, status: e.target.value }))}>
            <option value="active">active</option>
            <option value="disabled">disabled</option>
          </select>

          <button style={buttonStyle} type="submit" disabled={saving}>
            {saving ? '保存中...' : versioning ? '创建新版本' : '创建规则'}
          </button>
        </form>
      </section>
    </main>
  );
}
