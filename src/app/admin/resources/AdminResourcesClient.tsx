'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import type { SessionUser } from '@/lib/auth/session';

interface UserOption {
  id: string;
  name: string;
  username: string;
  email: string;
  role: string;
}

interface ResourceRecord {
  id: string;
  name: string;
  resource_type: string;
  preview_url: string | null;
  description: string | null;
  visibility_scope: string;
  status: string;
  disabled_at: string | null;
  created_at: string;
  updated_at: string;
  scoped_users: Array<{
    user_id: string;
    user: {
      id: string;
      name: string;
      username: string;
      email: string;
      status: string;
    };
  }>;
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

function buildEmptyForm() {
  return {
    id: '',
    name: '',
    resource_type: 'image',
    preview_url: '',
    description: '',
    visibility_scope: 'private',
    status: 'active',
    specific_user_ids: [] as string[],
  };
}

export default function AdminResourcesClient({ currentUser }: { currentUser: SessionUser }) {
  const [resources, setResources] = useState<ResourceRecord[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(buildEmptyForm());

  const editing = Boolean(form.id);

  const selectedUsers = useMemo(
    () => users.filter((user) => form.specific_user_ids.includes(user.id)),
    [form.specific_user_ids, users],
  );

  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/resources', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '无法加载资源配置');
      setResources(data.resources || []);
      setUsers(data.users || []);
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

  const startEdit = (resource: ResourceRecord) => {
    setForm({
      id: resource.id,
      name: resource.name,
      resource_type: resource.resource_type,
      preview_url: resource.preview_url || '',
      description: resource.description || '',
      visibility_scope: resource.visibility_scope,
      status: resource.status,
      specific_user_ids: resource.scoped_users.map((item) => item.user_id),
    });
    setMessage('');
    setError('');
  };

  const toggleSpecificUser = (userId: string) => {
    setForm((prev) => ({
      ...prev,
      specific_user_ids: prev.specific_user_ids.includes(userId)
        ? prev.specific_user_ids.filter((id) => id !== userId)
        : [...prev.specific_user_ids, userId],
    }));
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setMessage('');
    setError('');

    try {
      const url = editing ? `/api/admin/resources/${form.id}` : '/api/admin/resources';
      const method = editing ? 'PATCH' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          resource_type: form.resource_type,
          preview_url: form.preview_url.trim() || null,
          description: form.description.trim() || null,
          visibility_scope: form.visibility_scope,
          status: form.status,
          specific_user_ids: form.visibility_scope === 'specific_users' ? form.specific_user_ids : [],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '保存失败');
      setMessage(editing ? '资源已更新' : '资源已创建');
      resetForm();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const disableResource = async (resource: ResourceRecord) => {
    const ok = window.confirm(`确认下线资源「${resource.name}」？`);
    if (!ok) return;

    setMessage('');
    setError('');
    const res = await fetch(`/api/admin/resources/${resource.id}/disable`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || '下线失败');
      return;
    }
    if (form.id === resource.id) resetForm();
    setMessage('资源已下线');
    await refresh();
  };

  return (
    <main style={{ minHeight: '100vh', background: '#0f0f13', color: '#fff', padding: 24 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 24 }}>
        <div>
          <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 13 }}>管理员后台</div>
          <h1 style={{ margin: '4px 0 8px', fontSize: 28 }}>资源管理</h1>
          <div style={{ color: 'rgba(255,255,255,0.6)', maxWidth: 760 }}>
            管理共享资源记录、可见范围与上下线状态。当前版本先保证后台数据与权限约束完整，终端用户资源库入口仍待后续阶段接入。
          </div>
        </div>
        <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13, textAlign: 'right' }}>
          <div>{currentUser.name} · {currentUser.email}</div>
          <div style={{ marginTop: 8, display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <Link href="/admin/tasks" style={{ ...buttonStyle, textDecoration: 'none' }}>任务</Link>
            <Link href="/admin/users" style={{ ...buttonStyle, textDecoration: 'none' }}>用户</Link>
            <Link href="/admin/pricing" style={{ ...buttonStyle, textDecoration: 'none', background: '#334155' }}>计费规则</Link>
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
            资源列表
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.55)' }}>
                <tr>
                  <th style={{ textAlign: 'left', padding: 12 }}>资源</th>
                  <th style={{ textAlign: 'left', padding: 12 }}>类型</th>
                  <th style={{ textAlign: 'left', padding: 12 }}>可见范围</th>
                  <th style={{ textAlign: 'left', padding: 12 }}>状态</th>
                  <th style={{ textAlign: 'left', padding: 12 }}>更新时间</th>
                  <th style={{ textAlign: 'left', padding: 12 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {resources.map((resource) => (
                  <tr key={resource.id} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                    <td style={{ padding: 12, minWidth: 260 }}>
                      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                        <div style={{
                          width: 64,
                          height: 64,
                          borderRadius: 8,
                          overflow: 'hidden',
                          background: 'rgba(255,255,255,0.06)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: 'rgba(255,255,255,0.45)',
                          flexShrink: 0,
                        }}>
                          {resource.preview_url ? (
                            <img src={resource.preview_url} alt={resource.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                          ) : '无预览'}
                        </div>
                        <div>
                          <div style={{ fontWeight: 700 }}>{resource.name}</div>
                          <div style={{ color: 'rgba(255,255,255,0.45)', marginTop: 4 }}>
                            {resource.description || '暂无描述'}
                          </div>
                          {resource.scoped_users.length > 0 && (
                            <div style={{ color: 'rgba(255,255,255,0.55)', marginTop: 6 }}>
                              指定用户: {resource.scoped_users.map((item) => item.user.name).join(', ')}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: 12 }}>{resource.resource_type}</td>
                    <td style={{ padding: 12 }}>{resource.visibility_scope}</td>
                    <td style={{ padding: 12 }}>{resource.status === 'active' ? '启用' : '已下线'}</td>
                    <td style={{ padding: 12 }}>
                      <div>{formatDate(resource.updated_at)}</div>
                      <div style={{ color: 'rgba(255,255,255,0.45)' }}>创建 {formatDate(resource.created_at)}</div>
                    </td>
                    <td style={{ padding: 12 }}>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button style={{ ...buttonStyle, padding: '7px 10px' }} onClick={() => startEdit(resource)}>编辑</button>
                        <button
                          style={{ ...buttonStyle, padding: '7px 10px', background: '#ef4444' }}
                          onClick={() => disableResource(resource)}
                          disabled={resource.status === 'disabled'}
                        >
                          下线
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!loading && resources.length === 0 && (
                  <tr><td colSpan={6} style={{ padding: 24, color: 'rgba(255,255,255,0.45)' }}>暂无资源记录</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <form onSubmit={submit} style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: 16, display: 'grid', gap: 12, alignSelf: 'start' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontWeight: 700 }}>{editing ? '编辑资源' : '创建资源'}</div>
            {editing && (
              <button type="button" style={{ ...buttonStyle, background: '#334155' }} onClick={resetForm}>取消编辑</button>
            )}
          </div>

          <input style={inputStyle} placeholder="资源名称" value={form.name} onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))} />
          <input style={inputStyle} placeholder="资源类型，如 image / prompt / template" value={form.resource_type} onChange={(e) => setForm((prev) => ({ ...prev, resource_type: e.target.value }))} />
          <input style={inputStyle} placeholder="预览图 URL（可选）" value={form.preview_url} onChange={(e) => setForm((prev) => ({ ...prev, preview_url: e.target.value }))} />
          <textarea
            style={{ ...inputStyle, minHeight: 92, resize: 'vertical' }}
            placeholder="描述（可选）"
            value={form.description}
            onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
          />

          <select style={inputStyle} value={form.visibility_scope} onChange={(e) => setForm((prev) => ({ ...prev, visibility_scope: e.target.value, specific_user_ids: e.target.value === 'specific_users' ? prev.specific_user_ids : [] }))}>
            <option value="private">private</option>
            <option value="specific_users">specific_users</option>
            <option value="all_users">all_users</option>
            <option value="admin_only">admin_only</option>
          </select>

          {form.visibility_scope === 'specific_users' && (
            <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: 12 }}>
              <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', marginBottom: 10 }}>指定可见用户</div>
              <div style={{ display: 'grid', gap: 8, maxHeight: 220, overflowY: 'auto' }}>
                {users.map((user) => (
                  <label key={user.id} style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 13 }}>
                    <input type="checkbox" checked={form.specific_user_ids.includes(user.id)} onChange={() => toggleSpecificUser(user.id)} />
                    <span>{user.name} ({user.username})</span>
                  </label>
                ))}
              </div>
              {selectedUsers.length > 0 && (
                <div style={{ color: 'rgba(255,255,255,0.45)', marginTop: 10 }}>
                  已选: {selectedUsers.map((user) => user.name).join(', ')}
                </div>
              )}
            </div>
          )}

          <select style={inputStyle} value={form.status} onChange={(e) => setForm((prev) => ({ ...prev, status: e.target.value }))}>
            <option value="active">active</option>
            <option value="disabled">disabled</option>
          </select>

          <button style={buttonStyle} type="submit" disabled={saving}>
            {saving ? '保存中...' : editing ? '保存资源' : '创建资源'}
          </button>
        </form>
      </section>
    </main>
  );
}
