'use client';

import { useEffect, useMemo, useState } from 'react';
import type { SessionUser } from '@/lib/auth/session';

interface CreditAccount {
  balance: number;
  frozen_credits: number;
  monthly_used?: number;
  total_used?: number;
}

interface AdminUser {
  id: string;
  name: string;
  username: string;
  email: string;
  role: string;
  status: string;
  created_at: string;
  last_login_at: string | null;
  credit_account: CreditAccount | null;
}

interface LedgerRecord {
  id: string;
  user_id: string;
  type: string;
  amount: number;
  balance_before: number;
  balance_after: number;
  frozen_before: number | null;
  frozen_after: number | null;
  reason: string | null;
  created_at: string;
  user?: {
    name: string;
    username: string;
  };
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

function formatNumber(value: number | undefined) {
  return Number(value || 0).toFixed(0);
}

function formatDate(value: string | null) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN');
}

export default function AdminUsersClient({ currentUser }: { currentUser: SessionUser }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [ledger, setLedger] = useState<LedgerRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const [newUser, setNewUser] = useState({
    name: '',
    username: '',
    email: '',
    password: '',
    role: 'user',
    initial_credits: '0',
    reason: '创建用户初始点数',
  });

  const [creditForm, setCreditForm] = useState({
    user_id: '',
    type: 'grant',
    amount: '',
    reason: '',
  });

  const selectedUser = useMemo(
    () => users.find((user) => user.id === creditForm.user_id),
    [creditForm.user_id, users],
  );

  const loadUsers = async () => {
    const res = await fetch('/api/admin/users', { cache: 'no-store' });
    if (!res.ok) throw new Error('无法加载用户列表');
    const data = await res.json();
    setUsers(data.users || []);
  };

  const loadLedger = async () => {
    const res = await fetch('/api/admin/credits/ledger?page_size=50', { cache: 'no-store' });
    if (!res.ok) throw new Error('无法加载点数流水');
    const data = await res.json();
    setLedger(data.records || []);
  };

  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      await Promise.all([loadUsers(), loadLedger()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const createUser = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setMessage('');
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...newUser,
        initial_credits: Number(newUser.initial_credits || 0),
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || '创建用户失败');
      return;
    }
    setMessage('用户已创建');
    setNewUser({
      name: '',
      username: '',
      email: '',
      password: '',
      role: 'user',
      initial_credits: '0',
      reason: '创建用户初始点数',
    });
    await refresh();
  };

  const adjustCredits = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setMessage('');
    if (!selectedUser) {
      setError('请选择用户');
      return;
    }
    const amount = Number(creditForm.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('请输入正确的点数');
      return;
    }
    const ok = window.confirm(`确认对 ${selectedUser.name} 执行点数操作？`);
    if (!ok) return;

    const res = await fetch('/api/admin/credits/adjust', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...creditForm,
        amount,
        confirm: true,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || '点数操作失败');
      return;
    }
    setMessage('点数操作已完成');
    setCreditForm({ user_id: '', type: 'grant', amount: '', reason: '' });
    await refresh();
  };

  const toggleUser = async (user: AdminUser) => {
    const action = user.status === 'active' ? 'disable' : 'enable';
    const label = action === 'disable' ? '禁用' : '启用';
    const ok = window.confirm(`确认${label}用户 ${user.name}？`);
    if (!ok) return;
    setError('');
    setMessage('');
    const res = await fetch(`/api/admin/users/${user.id}/${action}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || `${label}失败`);
      return;
    }
    setMessage(`用户已${label}`);
    await refresh();
  };

  return (
    <main style={{ minHeight: '100vh', background: '#0f0f13', color: '#fff', padding: 24 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 13 }}>管理员后台</div>
          <h1 style={{ margin: '4px 0 0', fontSize: 26 }}>用户与点数管理</h1>
        </div>
        <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13 }}>
          {currentUser.name} · {currentUser.email}
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

      <section style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(320px, 0.8fr)', gap: 16, marginBottom: 16 }}>
        <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ padding: 16, borderBottom: '1px solid rgba(255,255,255,0.08)', fontWeight: 700 }}>
            用户列表
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.55)' }}>
                <tr>
                  <th style={{ textAlign: 'left', padding: 12 }}>用户</th>
                  <th style={{ textAlign: 'left', padding: 12 }}>角色</th>
                  <th style={{ textAlign: 'left', padding: 12 }}>状态</th>
                  <th style={{ textAlign: 'right', padding: 12 }}>余额</th>
                  <th style={{ textAlign: 'right', padding: 12 }}>冻结</th>
                  <th style={{ textAlign: 'right', padding: 12 }}>可用</th>
                  <th style={{ textAlign: 'left', padding: 12 }}>最近登录</th>
                  <th style={{ textAlign: 'left', padding: 12 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => {
                  const balance = user.credit_account?.balance || 0;
                  const frozen = user.credit_account?.frozen_credits || 0;
                  return (
                    <tr key={user.id} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                      <td style={{ padding: 12 }}>
                        <div style={{ fontWeight: 700 }}>{user.name}</div>
                        <div style={{ color: 'rgba(255,255,255,0.45)' }}>{user.username} · {user.email}</div>
                      </td>
                      <td style={{ padding: 12 }}>{user.role}</td>
                      <td style={{ padding: 12 }}>{user.status === 'active' ? '启用' : '禁用'}</td>
                      <td style={{ padding: 12, textAlign: 'right' }}>{formatNumber(balance)}</td>
                      <td style={{ padding: 12, textAlign: 'right' }}>{formatNumber(frozen)}</td>
                      <td style={{ padding: 12, textAlign: 'right' }}>{formatNumber(balance - frozen)}</td>
                      <td style={{ padding: 12 }}>{formatDate(user.last_login_at)}</td>
                      <td style={{ padding: 12 }}>
                        <button
                          style={{ ...buttonStyle, background: user.status === 'active' ? '#ef4444' : '#22c55e', padding: '7px 10px' }}
                          onClick={() => toggleUser(user)}
                        >
                          {user.status === 'active' ? '禁用' : '启用'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {!loading && users.length === 0 && (
                  <tr><td colSpan={8} style={{ padding: 24, color: 'rgba(255,255,255,0.45)' }}>暂无用户</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ display: 'grid', gap: 16 }}>
          <form onSubmit={createUser} style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: 16 }}>
            <div style={{ fontWeight: 700, marginBottom: 12 }}>创建用户</div>
            <div style={{ display: 'grid', gap: 10 }}>
              <input style={inputStyle} placeholder="姓名" value={newUser.name} onChange={(e) => setNewUser({ ...newUser, name: e.target.value })} />
              <input style={inputStyle} placeholder="账号" value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} />
              <input style={inputStyle} placeholder="邮箱" value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} />
              <input style={inputStyle} type="password" placeholder="初始密码" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} />
              <select style={inputStyle} value={newUser.role} onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}>
                <option value="user">普通用户</option>
                <option value="admin">管理员</option>
              </select>
              <input style={inputStyle} type="number" min="0" placeholder="初始点数" value={newUser.initial_credits} onChange={(e) => setNewUser({ ...newUser, initial_credits: e.target.value })} />
              <input style={inputStyle} placeholder="原因" value={newUser.reason} onChange={(e) => setNewUser({ ...newUser, reason: e.target.value })} />
              <button style={buttonStyle} type="submit">创建用户</button>
            </div>
          </form>

          <form onSubmit={adjustCredits} style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: 16 }}>
            <div style={{ fontWeight: 700, marginBottom: 12 }}>点数操作</div>
            <div style={{ display: 'grid', gap: 10 }}>
              <select style={inputStyle} value={creditForm.user_id} onChange={(e) => setCreditForm({ ...creditForm, user_id: e.target.value })}>
                <option value="">选择用户</option>
                {users.map((user) => <option key={user.id} value={user.id}>{user.name} ({user.username})</option>)}
              </select>
              <select style={inputStyle} value={creditForm.type} onChange={(e) => setCreditForm({ ...creditForm, type: e.target.value })}>
                <option value="grant">发放</option>
                <option value="deduct">扣减</option>
                <option value="adjust">修正</option>
              </select>
              <input style={inputStyle} type="number" min="0" placeholder="点数" value={creditForm.amount} onChange={(e) => setCreditForm({ ...creditForm, amount: e.target.value })} />
              <input style={inputStyle} placeholder="原因，必填" value={creditForm.reason} onChange={(e) => setCreditForm({ ...creditForm, reason: e.target.value })} />
              <button style={buttonStyle} type="submit">确认点数操作</button>
            </div>
          </form>
        </div>
      </section>

      <section style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ padding: 16, borderBottom: '1px solid rgba(255,255,255,0.08)', fontWeight: 700 }}>
          点数流水
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead style={{ background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.55)' }}>
              <tr>
                <th style={{ textAlign: 'left', padding: 12 }}>时间</th>
                <th style={{ textAlign: 'left', padding: 12 }}>用户</th>
                <th style={{ textAlign: 'left', padding: 12 }}>类型</th>
                <th style={{ textAlign: 'right', padding: 12 }}>变动</th>
                <th style={{ textAlign: 'right', padding: 12 }}>余额变化</th>
                <th style={{ textAlign: 'right', padding: 12 }}>冻结变化</th>
                <th style={{ textAlign: 'left', padding: 12 }}>原因</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((item) => (
                <tr key={item.id} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <td style={{ padding: 12 }}>{formatDate(item.created_at)}</td>
                  <td style={{ padding: 12 }}>{item.user?.name || item.user_id}</td>
                  <td style={{ padding: 12 }}>{item.type}</td>
                  <td style={{ padding: 12, textAlign: 'right' }}>{item.amount > 0 ? '+' : ''}{formatNumber(item.amount)}</td>
                  <td style={{ padding: 12, textAlign: 'right' }}>{formatNumber(item.balance_before)} → {formatNumber(item.balance_after)}</td>
                  <td style={{ padding: 12, textAlign: 'right' }}>{formatNumber(item.frozen_before || 0)} → {formatNumber(item.frozen_after || 0)}</td>
                  <td style={{ padding: 12 }}>{item.reason || '-'}</td>
                </tr>
              ))}
              {!loading && ledger.length === 0 && (
                <tr><td colSpan={7} style={{ padding: 24, color: 'rgba(255,255,255,0.45)' }}>暂无流水</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
