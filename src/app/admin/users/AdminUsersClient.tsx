'use client';

import { useEffect, useMemo, useState } from 'react';
import type { SessionUser } from '@/lib/auth/session';
import {
  FEATURE_PROFILE_OPTIONS,
  USER_PROFILE_OPTIONS,
  getDefaultFeatureProfileId,
  getFeatureProfileLabel,
  getUserProfileLabel,
  normalizeUserProfile,
  type AccountType,
} from '@/lib/users/profiles';

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
  account_type: string;
  user_profile: string;
  feature_profile_id: string | null;
  status: string;
  expires_at: string | null;
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

interface EditUserForm {
  name: string;
  username: string;
  email: string;
  role: 'admin' | 'user';
  account_type: 'internal' | 'external';
  user_profile: string;
  feature_profile_id: string;
  status: string;
  expires_at: string;
  reason: string;
}

const USER_STATUS_OPTIONS = [
  { value: 'active', label: '启用', description: '可以登录和使用平台。' },
  { value: 'disabled', label: '禁用', description: '临时封停，历史数据保留。' },
  { value: 'pending', label: '待开通', description: '账号保留，但暂不允许登录。' },
  { value: 'expired', label: '已过期', description: '协作到期，不允许继续登录。' },
];

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

const panelStyle: React.CSSProperties = {
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 8,
  padding: 16,
};

function formatNumber(value: number | undefined) {
  return Number(value || 0).toFixed(0);
}

function formatDate(value: string | null) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN');
}

function accountTypeLabel(value: string) {
  return value === 'external' ? '外部' : '内部';
}

function statusLabel(value: string) {
  if (value === 'active') return '启用';
  if (value === 'disabled') return '禁用';
  if (value === 'pending') return '待开通';
  if (value === 'expired') return '已过期';
  if (value === 'deleted') return '已删除';
  return value;
}

function resolveAccountType(value: string): AccountType {
  return value === 'external' ? 'external' : 'internal';
}

function formatDateInput(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function buildEditUserForm(user: AdminUser): EditUserForm {
  return {
    name: user.name,
    username: user.username,
    email: user.email,
    role: user.role === 'admin' ? 'admin' : 'user',
    account_type: user.account_type === 'external' ? 'external' : 'internal',
    user_profile: user.user_profile || 'other',
    feature_profile_id: user.feature_profile_id || 'standard_internal',
    status: user.status || 'active',
    expires_at: formatDateInput(user.expires_at),
    reason: '账户属性调整',
  };
}

export default function AdminUsersClient({ currentUser }: { currentUser: SessionUser }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [ledger, setLedger] = useState<LedgerRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const [filters, setFilters] = useState({
    search: '',
    account_type: 'all',
    user_profile: 'all',
    feature_profile_id: 'all',
    status: 'all',
  });

  const [newUser, setNewUser] = useState({
    name: '',
    username: '',
    email: '',
    password: '',
    role: 'user',
    account_type: 'internal',
    user_profile: 'other',
    feature_profile_id: 'auto',
    initial_credits: '0',
    reason: '创建用户初始点数',
  });

  const [creditForm, setCreditForm] = useState({
    user_id: '',
    type: 'grant',
    amount: '',
    reason: '',
  });

  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [bulkGrantForm, setBulkGrantForm] = useState({
    amount: '',
    reason: '批量点数发放',
  });
  const [bulkProfileForm, setBulkProfileForm] = useState({
    user_profile: 'other',
    feature_profile_id: 'auto',
    reason: '用户类型调整',
  });
  const [mergeForm, setMergeForm] = useState({
    target_user_id: '',
    reason: '重复账号数据合并',
  });
  const [editingUserId, setEditingUserId] = useState('');
  const [editUserForm, setEditUserForm] = useState<EditUserForm | null>(null);

  const filteredUsers = useMemo(() => {
    const keyword = filters.search.trim().toLowerCase();
    return users.filter((user) => {
      if (filters.account_type !== 'all' && user.account_type !== filters.account_type) return false;
      if (filters.user_profile !== 'all' && (user.user_profile || 'other') !== filters.user_profile) return false;
      if (filters.feature_profile_id !== 'all' && (user.feature_profile_id || 'standard_internal') !== filters.feature_profile_id) return false;
      if (filters.status !== 'all' && user.status !== filters.status) return false;
      if (!keyword) return true;
      return [user.name, user.username, user.email].some((value) => value.toLowerCase().includes(keyword));
    });
  }, [filters, users]);

  const selectedUser = useMemo(
    () => users.find((user) => user.id === creditForm.user_id),
    [creditForm.user_id, users],
  );
  const selectedUsers = useMemo(() => {
    const selected = new Set(selectedUserIds);
    return users.filter((user) => selected.has(user.id));
  }, [selectedUserIds, users]);
  const mergeTargetUser = useMemo(
    () => users.find((user) => user.id === mergeForm.target_user_id) || null,
    [mergeForm.target_user_id, users],
  );
  const mergeSourceUsers = useMemo(
    () => selectedUsers.filter((user) => user.id !== mergeForm.target_user_id),
    [mergeForm.target_user_id, selectedUsers],
  );
  const mergeAdminSources = useMemo(
    () => mergeSourceUsers.filter((user) => user.role === 'admin'),
    [mergeSourceUsers],
  );
  const mergeCreditPreview = useMemo(() => ({
    balance: mergeSourceUsers.reduce((total, user) => total + (user.credit_account?.balance || 0), 0),
    frozen: mergeSourceUsers.reduce((total, user) => total + (user.credit_account?.frozen_credits || 0), 0),
  }), [mergeSourceUsers]);
  const editingUser = useMemo(
    () => users.find((user) => user.id === editingUserId) || null,
    [editingUserId, users],
  );
  const filteredUserIds = useMemo(() => filteredUsers.map((user) => user.id), [filteredUsers]);
  const allFilteredSelected = filteredUserIds.length > 0 && filteredUserIds.every((id) => selectedUserIds.includes(id));
  const suggestedBulkFeatureProfileId = getDefaultFeatureProfileId('internal', normalizeUserProfile(bulkProfileForm.user_profile));
  const suggestedNewUserFeatureProfileId = getDefaultFeatureProfileId(
    resolveAccountType(newUser.account_type),
    normalizeUserProfile(newUser.user_profile),
  );
  const suggestedEditUserFeatureProfileId = editUserForm
    ? getDefaultFeatureProfileId(
      editUserForm.account_type,
      normalizeUserProfile(editUserForm.user_profile),
    )
    : 'standard_internal';

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
        feature_profile_id: newUser.feature_profile_id === 'auto' ? undefined : newUser.feature_profile_id,
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
      account_type: 'internal',
      user_profile: 'other',
      feature_profile_id: 'auto',
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

  const toggleUserSelection = (userId: string) => {
    setSelectedUserIds((current) => (
      current.includes(userId)
        ? current.filter((id) => id !== userId)
        : [...current, userId]
    ));
  };

  const toggleFilteredSelection = () => {
    setSelectedUserIds((current) => {
      const filteredSet = new Set(filteredUserIds);
      if (allFilteredSelected) return current.filter((id) => !filteredSet.has(id));
      return Array.from(new Set([...current, ...filteredUserIds]));
    });
  };

  const selectOnlyUser = (userId: string) => {
    setSelectedUserIds([userId]);
    setCreditForm((current) => ({ ...current, user_id: userId, type: 'grant' }));
  };

  const bulkGrantCredits = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setMessage('');

    const amount = Number(bulkGrantForm.amount);
    const reason = bulkGrantForm.reason.trim();

    if (selectedUserIds.length === 0) {
      setError('请选择至少一个用户');
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('请输入正确的发放点数');
      return;
    }
    if (!reason) {
      setError('请输入发放原因');
      return;
    }

    const previewNames = selectedUsers.slice(0, 3).map((user) => user.name || user.username).join('、');
    const moreText = selectedUsers.length > 3 ? ` 等 ${selectedUsers.length} 人` : '';
    const ok = window.confirm(`确认给 ${previewNames}${moreText} 每人发放 ${amount} 点？总计 ${amount * selectedUserIds.length} 点。`);
    if (!ok) return;

    const res = await fetch('/api/admin/credits/bulk-grant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_ids: selectedUserIds,
        amount,
        reason,
        confirm: true,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || '批量发放失败');
      return;
    }

    setMessage(`已给 ${data.count || selectedUserIds.length} 个用户每人发放 ${amount} 点`);
    setSelectedUserIds([]);
    setBulkGrantForm({ amount: '', reason: '批量点数发放' });
    await refresh();
  };

  const bulkUpdateProfiles = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setMessage('');

    const reason = bulkProfileForm.reason.trim();
    if (selectedUserIds.length === 0) {
      setError('请选择至少一个用户');
      return;
    }
    if (!reason) {
      setError('请输入修改原因');
      return;
    }

    const featureProfileText = bulkProfileForm.feature_profile_id === 'auto'
      ? `自动建议：${getFeatureProfileLabel(suggestedBulkFeatureProfileId)}`
      : getFeatureProfileLabel(bulkProfileForm.feature_profile_id);
    const ok = window.confirm(`确认修改 ${selectedUserIds.length} 个用户？\n用户类型：${getUserProfileLabel(bulkProfileForm.user_profile)}\n能力档案：${featureProfileText}`);
    if (!ok) return;

    const res = await fetch('/api/admin/users/bulk-profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_ids: selectedUserIds,
        user_profile: bulkProfileForm.user_profile,
        feature_profile_id: bulkProfileForm.feature_profile_id === 'auto' ? undefined : bulkProfileForm.feature_profile_id,
        reason,
        confirm: true,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || '批量修改失败');
      return;
    }

    setMessage(`已修改 ${data.count || selectedUserIds.length} 个用户的类型`);
    setSelectedUserIds([]);
    await refresh();
  };

  const mergeUsers = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setMessage('');

    const reason = mergeForm.reason.trim();
    if (!mergeTargetUser) {
      setError('请选择保留账号');
      return;
    }
    if (mergeTargetUser.status !== 'active') {
      setError('保留账号必须是启用状态');
      return;
    }
    if (mergeSourceUsers.length === 0) {
      setError('请选择至少一个被合并账号');
      return;
    }
    if (mergeAdminSources.length > 0) {
      setError(`管理员账号不能作为被合并账号：${mergeAdminSources.map((user) => user.username).join('、')}`);
      return;
    }
    if (!reason) {
      setError('请输入合并原因');
      return;
    }

    const sourceNames = mergeSourceUsers.slice(0, 4).map((user) => user.name || user.username).join('、');
    const moreText = mergeSourceUsers.length > 4 ? ` 等 ${mergeSourceUsers.length} 个账号` : '';
    const confirmText = [
      `确认把 ${sourceNames}${moreText} 合并到 ${mergeTargetUser.name || mergeTargetUser.username}？`,
      '源账号会软删除并无法登录，业务数据会迁移到保留账号。',
      '点数会以合并汇总流水转入保留账号，源账号原始流水保留用于审计。',
      `原因：${reason}`,
    ].join('\n');
    if (!window.confirm(confirmText)) return;

    const res = await fetch('/api/admin/users/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_user_id: mergeTargetUser.id,
        source_user_ids: mergeSourceUsers.map((user) => user.id),
        reason,
        confirm: true,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || '账号合并失败');
      return;
    }

    setMessage(`已合并 ${data.source_count || mergeSourceUsers.length} 个账号，迁移任务 ${data.counts?.video_tasks || 0} 条`);
    setSelectedUserIds([]);
    setMergeForm({ target_user_id: mergeTargetUser.id, reason: '重复账号数据合并' });
    await refresh();
  };

  const openEditUser = (user: AdminUser) => {
    setEditingUserId(user.id);
    setEditUserForm(buildEditUserForm(user));
    setError('');
    setMessage('');
  };

  const updateEditUserForm = (patch: Partial<EditUserForm>) => {
    setEditUserForm((current) => {
      if (!current) return current;
      const next = { ...current, ...patch };
      if (patch.account_type === 'external') {
        next.role = 'user';
        next.user_profile = 'other';
        next.feature_profile_id = 'external_limited';
      }
      if (patch.user_profile !== undefined && next.account_type === 'internal') {
        next.feature_profile_id = 'auto';
      }
      return next;
    });
  };

  const saveEditedUser = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setMessage('');

    if (!editingUser || !editUserForm) {
      setError('请选择要编辑的用户');
      return;
    }

    const reason = editUserForm.reason.trim();
    if (!reason) {
      setError('请输入修改原因');
      return;
    }
    const needsCompanyEmail = editUserForm.account_type === 'internal'
      && (
        editingUser.account_type !== 'internal'
        || editUserForm.email.toLowerCase() !== editingUser.email.toLowerCase()
        || (editUserForm.role === 'admin' && editingUser.role !== 'admin')
      );
    if (needsCompanyEmail && !editUserForm.email.toLowerCase().endsWith('@youdoogo.com')) {
      setError('内部账号必须使用 @youdoogo.com 公司邮箱');
      return;
    }

    const sensitiveChanges = [
      editingUser.role !== editUserForm.role ? `系统身份：${editingUser.role === 'admin' ? '管理员' : '普通用户'} → ${editUserForm.role === 'admin' ? '管理员' : '普通用户'}` : '',
      editingUser.status !== editUserForm.status ? `状态：${statusLabel(editingUser.status)} → ${statusLabel(editUserForm.status)}` : '',
      editingUser.account_type !== editUserForm.account_type ? `账号来源：${accountTypeLabel(editingUser.account_type)} → ${accountTypeLabel(editUserForm.account_type)}` : '',
    ].filter(Boolean);
    const confirmText = sensitiveChanges.length > 0
      ? `确认保存 ${editingUser.name || editingUser.username} 的账户属性？\n${sensitiveChanges.join('\n')}\n\n原因：${reason}`
      : `确认保存 ${editingUser.name || editingUser.username} 的账户属性？\n原因：${reason}`;
    if (!window.confirm(confirmText)) return;

    const res = await fetch(`/api/admin/users/${editingUser.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: editUserForm.name,
        username: editUserForm.username,
        email: editUserForm.email,
        role: editUserForm.role,
        account_type: editUserForm.account_type,
        user_profile: editUserForm.user_profile,
        feature_profile_id: editUserForm.feature_profile_id === 'auto' ? undefined : editUserForm.feature_profile_id,
        status: editUserForm.status,
        expires_at: editUserForm.expires_at || null,
        reason,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || '保存用户属性失败');
      return;
    }

    setMessage('用户属性已更新');
    await refresh();
    setEditingUserId(data.user?.id || editingUser.id);
    setEditUserForm(buildEditUserForm({
      ...editingUser,
      ...data.user,
      credit_account: editingUser.credit_account,
      last_login_at: editingUser.last_login_at,
    }));
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

  const deleteUser = async (user: AdminUser) => {
    if (user.id === currentUser.id) {
      setError('不能删除当前登录账号');
      setMessage('');
      return;
    }

    const ok = window.confirm(`确认删除用户 ${user.name || user.username}？该操作会隐藏账号并阻止登录，但不会删除历史任务和点数流水。`);
    if (!ok) return;

    setError('');
    setMessage('');

    const res = await fetch(`/api/admin/users/${user.id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || '删除用户失败');
      return;
    }

    setMessage('用户已删除');
    setSelectedUserIds((current) => current.filter((id) => id !== user.id));
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

      <section style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.3fr) minmax(340px, 0.7fr)', gap: 16, marginBottom: 16 }}>
        <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ padding: 16, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 12 }}>
              <div>
                <div style={{ fontWeight: 700 }}>用户列表</div>
                <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 12, marginTop: 4 }}>
                  筛选结果 {filteredUsers.length} 人 · 已选 {selectedUserIds.length} 人
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" style={{ ...buttonStyle, background: '#334155' }} onClick={toggleFilteredSelection}>
                  {allFilteredSelected ? '取消筛选结果' : '全选筛选结果'}
                </button>
                <button type="button" style={{ ...buttonStyle, background: '#334155' }} onClick={() => setSelectedUserIds([])}>
                  清空选择
                </button>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1.4fr repeat(4, minmax(120px, 1fr))', gap: 8 }}>
              <input
                style={inputStyle}
                placeholder="搜索姓名 / 账号 / 邮箱"
                value={filters.search}
                onChange={(event) => setFilters({ ...filters, search: event.target.value })}
              />
              <select style={inputStyle} value={filters.account_type} onChange={(event) => setFilters({ ...filters, account_type: event.target.value })}>
                <option value="all">全部来源</option>
                <option value="internal">内部账号</option>
                <option value="external">外部账号</option>
              </select>
              <select style={inputStyle} value={filters.user_profile} onChange={(event) => setFilters({ ...filters, user_profile: event.target.value })}>
                <option value="all">全部用户类型</option>
                {USER_PROFILE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <select style={inputStyle} value={filters.feature_profile_id} onChange={(event) => setFilters({ ...filters, feature_profile_id: event.target.value })}>
                <option value="all">全部能力档案</option>
                {FEATURE_PROFILE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <select style={inputStyle} value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}>
                <option value="all">全部状态</option>
                <option value="active">启用</option>
                <option value="disabled">禁用</option>
                <option value="pending">待开通</option>
                <option value="expired">已过期</option>
              </select>
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.55)' }}>
                <tr>
                  <th style={{ textAlign: 'left', padding: 12, width: 44 }}>
                    <input
                      type="checkbox"
                      checked={allFilteredSelected}
                      onChange={toggleFilteredSelection}
                      aria-label="选择筛选结果用户"
                    />
                  </th>
                  <th style={{ textAlign: 'left', padding: 12 }}>用户</th>
                  <th style={{ textAlign: 'left', padding: 12 }}>类型 / 能力</th>
                  <th style={{ textAlign: 'right', padding: 12 }}>点数</th>
                  <th style={{ textAlign: 'left', padding: 12 }}>状态</th>
                  <th style={{ textAlign: 'left', padding: 12 }}>最近登录</th>
                  <th style={{ textAlign: 'left', padding: 12 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.map((user) => {
                  const balance = user.credit_account?.balance || 0;
                  const frozen = user.credit_account?.frozen_credits || 0;
                  return (
                    <tr key={user.id} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                      <td style={{ padding: 12 }}>
                        <input
                          type="checkbox"
                          checked={selectedUserIds.includes(user.id)}
                          onChange={() => toggleUserSelection(user.id)}
                          aria-label={`选择 ${user.name || user.username}`}
                        />
                      </td>
                      <td style={{ padding: 12, minWidth: 220 }}>
                        <div style={{ fontWeight: 700 }}>{user.name}</div>
                        <div style={{ color: 'rgba(255,255,255,0.45)' }}>{user.username} · {user.email}</div>
                        <div style={{ color: 'rgba(255,255,255,0.38)', fontSize: 12, marginTop: 4 }}>
                          {accountTypeLabel(user.account_type)} · {user.role === 'admin' ? '管理员' : '普通用户'}
                        </div>
                      </td>
                      <td style={{ padding: 12, minWidth: 180 }}>
                        <div>{getUserProfileLabel(user.user_profile)}</div>
                        <div style={{ color: 'rgba(255,255,255,0.45)', marginTop: 4 }}>
                          {getFeatureProfileLabel(user.feature_profile_id)}
                        </div>
                      </td>
                      <td style={{ padding: 12, textAlign: 'right', minWidth: 130 }}>
                        <div>可用 {formatNumber(balance - frozen)}</div>
                        <div style={{ color: 'rgba(255,255,255,0.45)', marginTop: 4 }}>
                          余额 {formatNumber(balance)} / 冻结 {formatNumber(frozen)}
                        </div>
                      </td>
                      <td style={{ padding: 12 }}>{statusLabel(user.status)}</td>
                      <td style={{ padding: 12 }}>{formatDate(user.last_login_at)}</td>
                      <td style={{ padding: 12, minWidth: 250 }}>
                        <button
                          type="button"
                          style={{ ...buttonStyle, background: editingUserId === user.id ? '#2563eb' : '#475569', padding: '7px 10px', marginRight: 8 }}
                          onClick={() => openEditUser(user)}
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          style={{ ...buttonStyle, background: '#334155', padding: '7px 10px', marginRight: 8 }}
                          onClick={() => selectOnlyUser(user.id)}
                        >
                          只选
                        </button>
                        <button
                          type="button"
                          style={{ ...buttonStyle, background: user.status === 'active' ? '#ef4444' : '#22c55e', padding: '7px 10px' }}
                          onClick={() => toggleUser(user)}
                        >
                          {user.status === 'active' ? '禁用' : '启用'}
                        </button>
                        <button
                          type="button"
                          style={{
                            ...buttonStyle,
                            background: user.id === currentUser.id ? '#334155' : '#7f1d1d',
                            padding: '7px 10px',
                            marginLeft: 8,
                            cursor: user.id === currentUser.id ? 'not-allowed' : 'pointer',
                          }}
                          onClick={() => deleteUser(user)}
                          disabled={user.id === currentUser.id}
                        >
                          删除
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {!loading && filteredUsers.length === 0 && (
                  <tr><td colSpan={7} style={{ padding: 24, color: 'rgba(255,255,255,0.45)' }}>暂无匹配用户</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ display: 'grid', gap: 16 }}>
          {editingUser && editUserForm ? (
            <form onSubmit={saveEditedUser} style={{ ...panelStyle, borderColor: 'rgba(34,197,94,0.28)', background: 'rgba(15,23,42,0.72)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 14 }}>
                <div>
                  <div style={{ fontWeight: 800 }}>账户属性</div>
                  <div style={{ color: 'rgba(255,255,255,0.48)', fontSize: 12, marginTop: 4 }}>
                    {editingUser.username} · {editingUser.email}
                  </div>
                </div>
                <button
                  type="button"
                  style={{ ...buttonStyle, background: '#334155', padding: '7px 10px' }}
                  onClick={() => {
                    setEditingUserId('');
                    setEditUserForm(null);
                  }}
                >
                  关闭
                </button>
              </div>

              <div style={{ display: 'grid', gap: 10 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <input
                    style={inputStyle}
                    placeholder="用户名"
                    value={editUserForm.name}
                    onChange={(event) => updateEditUserForm({ name: event.target.value })}
                  />
                  <input
                    style={inputStyle}
                    placeholder="账号"
                    value={editUserForm.username}
                    onChange={(event) => updateEditUserForm({ username: event.target.value })}
                  />
                </div>
                <input
                  style={inputStyle}
                  placeholder="邮箱"
                  value={editUserForm.email}
                  onChange={(event) => updateEditUserForm({ email: event.target.value })}
                />

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <select
                    style={inputStyle}
                    value={editUserForm.account_type}
                    onChange={(event) => updateEditUserForm({ account_type: resolveAccountType(event.target.value) })}
                  >
                    <option value="internal">内部账号</option>
                    <option value="external">外部账号，预留</option>
                  </select>
                  <select
                    style={inputStyle}
                    value={editUserForm.role}
                    onChange={(event) => updateEditUserForm({ role: event.target.value === 'admin' ? 'admin' : 'user' })}
                    disabled={editUserForm.account_type === 'external'}
                  >
                    <option value="user">普通用户</option>
                    <option value="admin">管理员</option>
                  </select>
                </div>

                <div style={{
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 8,
                  padding: 10,
                  background: editUserForm.role === 'admin' ? 'rgba(245,158,11,0.12)' : 'rgba(255,255,255,0.035)',
                }}>
                  <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.56)', marginBottom: 4 }}>管理员身份</div>
                  <div style={{ fontSize: 13, lineHeight: 1.6 }}>
                    {editUserForm.role === 'admin'
                      ? '可进入后台、管理用户、发放点数并查看成本数据。'
                      : '只能使用用户端功能，不能进入管理员后台。'}
                  </div>
                  {editUserForm.account_type === 'external' && (
                    <div style={{ color: '#fca5a5', fontSize: 12, marginTop: 6 }}>
                      外部账号不能设为管理员，保存时会保持普通用户。
                    </div>
                  )}
                </div>

                <select
                  style={inputStyle}
                  value={editUserForm.user_profile}
                  onChange={(event) => updateEditUserForm({ user_profile: event.target.value })}
                  disabled={editUserForm.account_type === 'external'}
                >
                  {USER_PROFILE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                <select
                  style={inputStyle}
                  value={editUserForm.feature_profile_id}
                  onChange={(event) => updateEditUserForm({ feature_profile_id: event.target.value })}
                  disabled={editUserForm.account_type === 'external'}
                >
                  <option value="auto">自动建议：{getFeatureProfileLabel(suggestedEditUserFeatureProfileId)}</option>
                  {FEATURE_PROFILE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <select
                    style={inputStyle}
                    value={editUserForm.status}
                    onChange={(event) => updateEditUserForm({ status: event.target.value })}
                  >
                    {USER_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                  <input
                    style={inputStyle}
                    type="date"
                    value={editUserForm.expires_at}
                    onChange={(event) => updateEditUserForm({ expires_at: event.target.value })}
                  />
                </div>

                <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: 10 }}>
                  <div style={{ color: 'rgba(255,255,255,0.56)', fontSize: 12, marginBottom: 6 }}>影响预览</div>
                  <div style={{ display: 'grid', gap: 4, color: 'rgba(255,255,255,0.72)', fontSize: 12 }}>
                    <div>来源：{accountTypeLabel(editUserForm.account_type)}</div>
                    <div>系统身份：{editUserForm.role === 'admin' ? '管理员' : '普通用户'}</div>
                    <div>组织分类：{getUserProfileLabel(editUserForm.user_profile)}</div>
                    <div>能力档案：{getFeatureProfileLabel(editUserForm.feature_profile_id === 'auto' ? suggestedEditUserFeatureProfileId : editUserForm.feature_profile_id)}</div>
                    <div>状态：{statusLabel(editUserForm.status)}{editUserForm.expires_at ? `，到期 ${editUserForm.expires_at}` : '，长期有效'}</div>
                    <div style={{ color: 'rgba(255,255,255,0.45)', marginTop: 2 }}>账户属性不会自动改点数，点数仍走流水。</div>
                  </div>
                </div>

                <input
                  style={inputStyle}
                  placeholder="修改原因，必填"
                  value={editUserForm.reason}
                  onChange={(event) => updateEditUserForm({ reason: event.target.value })}
                />
                <button type="submit" style={{ ...buttonStyle, background: '#16a34a' }}>
                  保存账户属性
                </button>
              </div>
            </form>
          ) : (
            <div style={{ ...panelStyle, color: 'rgba(255,255,255,0.58)' }}>
              <div style={{ fontWeight: 700, color: '#fff', marginBottom: 8 }}>账户属性</div>
              <div style={{ fontSize: 13, lineHeight: 1.7 }}>
                从左侧用户列表点击“编辑”，可设置账号来源、组织分类、能力档案、管理员身份、状态和过期时间。
              </div>
            </div>
          )}

          <form onSubmit={bulkUpdateProfiles} style={{ ...panelStyle, borderColor: 'rgba(59,130,246,0.35)', background: 'rgba(59,130,246,0.08)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontWeight: 700 }}>批量修改用户类型</div>
              <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12 }}>已选 {selectedUserIds.length} 人</div>
            </div>
            <div style={{ display: 'grid', gap: 10 }}>
              <select
                style={inputStyle}
                value={bulkProfileForm.user_profile}
                onChange={(event) => setBulkProfileForm({ ...bulkProfileForm, user_profile: event.target.value, feature_profile_id: 'auto' })}
              >
                {USER_PROFILE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <select
                style={inputStyle}
                value={bulkProfileForm.feature_profile_id}
                onChange={(event) => setBulkProfileForm({ ...bulkProfileForm, feature_profile_id: event.target.value })}
              >
                <option value="auto">自动建议：{getFeatureProfileLabel(suggestedBulkFeatureProfileId)}</option>
                {FEATURE_PROFILE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <input
                style={inputStyle}
                placeholder="修改原因，必填"
                value={bulkProfileForm.reason}
                onChange={(event) => setBulkProfileForm({ ...bulkProfileForm, reason: event.target.value })}
              />
              <div style={{ color: 'rgba(255,255,255,0.48)', fontSize: 12, lineHeight: 1.6 }}>
                勾选一个用户就是单人修改；外部账号会强制使用“外部受限”档案。
              </div>
              <button
                style={{
                  ...buttonStyle,
                  background: selectedUserIds.length > 0 ? '#2563eb' : '#334155',
                  cursor: selectedUserIds.length > 0 ? 'pointer' : 'not-allowed',
                }}
                type="submit"
                disabled={selectedUserIds.length === 0}
              >
                修改已选用户
              </button>
            </div>
          </form>

          <form onSubmit={mergeUsers} style={{ ...panelStyle, borderColor: 'rgba(245,158,11,0.35)', background: 'rgba(245,158,11,0.08)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontWeight: 700 }}>合并重复账号</div>
              <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12 }}>
                源账号 {mergeSourceUsers.length} 个
              </div>
            </div>
            <div style={{ display: 'grid', gap: 10 }}>
              <select
                style={inputStyle}
                value={mergeForm.target_user_id}
                onChange={(event) => setMergeForm({ ...mergeForm, target_user_id: event.target.value })}
              >
                <option value="">选择最终保留账号</option>
                {users
                  .filter((user) => user.status === 'active')
                  .map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name} ({user.username}){user.role === 'admin' ? ' · 管理员' : ''}
                    </option>
                  ))}
              </select>

              <div style={{
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 8,
                padding: 10,
                color: 'rgba(255,255,255,0.72)',
                fontSize: 12,
                lineHeight: 1.7,
              }}>
                <div>先在左侧勾选要被合并的账号，再选择最终保留账号。</div>
                <div>源账号会软删除，任务、项目、图集、成本归属会转到保留账号。</div>
                <div>点数转入：余额 {formatNumber(mergeCreditPreview.balance)} 点，冻结 {formatNumber(mergeCreditPreview.frozen)} 点。</div>
                <div style={{ color: '#fbbf24' }}>管理员账号不能作为源账号，只能作为保留账号。</div>
                {mergeAdminSources.length > 0 && (
                  <div style={{ color: '#fca5a5', marginTop: 4 }}>
                    当前已选包含管理员：{mergeAdminSources.map((user) => user.username).join('、')}
                  </div>
                )}
              </div>

              <input
                style={inputStyle}
                placeholder="合并原因，必填"
                value={mergeForm.reason}
                onChange={(event) => setMergeForm({ ...mergeForm, reason: event.target.value })}
              />
              <button
                style={{
                  ...buttonStyle,
                  background: mergeTargetUser && mergeSourceUsers.length > 0 && mergeAdminSources.length === 0 ? '#d97706' : '#334155',
                  cursor: mergeTargetUser && mergeSourceUsers.length > 0 && mergeAdminSources.length === 0 ? 'pointer' : 'not-allowed',
                }}
                type="submit"
                disabled={!mergeTargetUser || mergeSourceUsers.length === 0 || mergeAdminSources.length > 0}
              >
                合并到保留账号
              </button>
            </div>
          </form>

          <form onSubmit={bulkGrantCredits} style={{ ...panelStyle, borderColor: 'rgba(99,102,241,0.35)', background: 'rgba(99,102,241,0.08)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontWeight: 700 }}>一键发放点数</div>
              <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12 }}>已选 {selectedUserIds.length} 人</div>
            </div>
            <div style={{ display: 'grid', gap: 10 }}>
              <input
                style={inputStyle}
                type="number"
                min="0"
                placeholder="每人发放点数"
                value={bulkGrantForm.amount}
                onChange={(e) => setBulkGrantForm({ ...bulkGrantForm, amount: e.target.value })}
              />
              <input
                style={inputStyle}
                placeholder="发放原因，必填"
                value={bulkGrantForm.reason}
                onChange={(e) => setBulkGrantForm({ ...bulkGrantForm, reason: e.target.value })}
              />
              <div style={{ color: 'rgba(255,255,255,0.48)', fontSize: 12, lineHeight: 1.6 }}>
                可先按用户类型筛选，再全选筛选结果发放；禁用用户可入账，但启用前不能登录使用。
              </div>
              <button
                style={{
                  ...buttonStyle,
                  background: selectedUserIds.length > 0 ? '#6366f1' : '#334155',
                  cursor: selectedUserIds.length > 0 ? 'pointer' : 'not-allowed',
                }}
                type="submit"
                disabled={selectedUserIds.length === 0}
              >
                给已选用户发放
              </button>
            </div>
          </form>

          <form onSubmit={createUser} style={panelStyle}>
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
              <select
                style={inputStyle}
                value={newUser.account_type}
                onChange={(e) => setNewUser({
                  ...newUser,
                  account_type: e.target.value,
                  user_profile: e.target.value === 'external' ? 'other' : newUser.user_profile,
                  feature_profile_id: 'auto',
                })}
              >
                <option value="internal">内部账号</option>
                <option value="external">外部账号，预留</option>
              </select>
              <select
                style={inputStyle}
                value={newUser.user_profile}
                onChange={(e) => setNewUser({ ...newUser, user_profile: e.target.value, feature_profile_id: 'auto' })}
                disabled={newUser.account_type === 'external'}
              >
                {USER_PROFILE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <select style={inputStyle} value={newUser.feature_profile_id} onChange={(e) => setNewUser({ ...newUser, feature_profile_id: e.target.value })}>
                <option value="auto">自动建议：{getFeatureProfileLabel(suggestedNewUserFeatureProfileId)}</option>
                {FEATURE_PROFILE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <input style={inputStyle} type="number" min="0" placeholder="初始点数" value={newUser.initial_credits} onChange={(e) => setNewUser({ ...newUser, initial_credits: e.target.value })} />
              <input style={inputStyle} placeholder="原因" value={newUser.reason} onChange={(e) => setNewUser({ ...newUser, reason: e.target.value })} />
              <button style={buttonStyle} type="submit">创建用户</button>
            </div>
          </form>

          <form onSubmit={adjustCredits} style={panelStyle}>
            <div style={{ fontWeight: 700, marginBottom: 12 }}>单人点数操作</div>
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
