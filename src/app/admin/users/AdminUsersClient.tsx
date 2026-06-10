'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import PageBanner from '@/components/PageBanner';
import PaginationControls from '@/components/PaginationControls';
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
import { displayUserName, displayUserSubtitle } from '@/lib/users/display';

interface CreditAccount {
  balance: number;
  frozen_credits: number;
  monthly_used?: number;
  total_used?: number;
}

interface CreditQuota {
  daily_total: number;
  daily_remaining: number;
  daily_frozen: number;
  daily_expires_at: string | null;
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
  feishu_user_id?: string | null;
  feishu_open_id?: string | null;
  feishu_union_id?: string | null;
  expires_at: string | null;
  created_at: string;
  last_login_at: string | null;
  credit_account: CreditAccount | null;
  credit_quota?: CreditQuota | null;
}

interface CreditPolicy {
  initial_grant: {
    enabled: boolean;
    internal_default: number;
    external_default: number;
    apply_to_self_register: boolean;
    apply_to_feishu_auto_create: boolean;
    apply_to_admin_create_default: boolean;
  };
  daily_quota: {
    enabled: boolean;
    timezone: 'Asia/Shanghai';
    internal_default: number;
    external_default: number;
    profile_overrides: Record<string, number>;
    valid_hours: number;
    clear_unused_on_expire: boolean;
  };
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

type QuickView = 'all' | 'active' | 'admins' | 'feishu' | 'credit_alert' | 'quota_low' | 'inactive';
type AdminToolPanel = 'summary' | 'edit' | 'credit' | 'bulk_grant' | 'bulk_profile' | 'merge' | 'create' | 'policy';

const USER_STATUS_OPTIONS = [
  { value: 'active', label: '启用', description: '可以登录和使用平台。' },
  { value: 'disabled', label: '禁用', description: '临时封停，历史数据保留。' },
  { value: 'pending', label: '待开通', description: '账号保留，但暂不允许登录。' },
  { value: 'expired', label: '已过期', description: '协作到期，不允许继续登录。' },
];

const QUICK_VIEW_OPTIONS: Array<{ value: QuickView; label: string }> = [
  { value: 'all', label: '全部用户' },
  { value: 'active', label: '可登录' },
  { value: 'admins', label: '管理员' },
  { value: 'feishu', label: '飞书绑定' },
  { value: 'credit_alert', label: '点数异常' },
  { value: 'quota_low', label: '今日额度不足' },
  { value: 'inactive', label: '待处理状态' },
];

const ADMIN_TOOL_OPTIONS: Array<{ value: AdminToolPanel; label: string }> = [
  { value: 'summary', label: '用户概览' },
  { value: 'credit', label: '单人点数' },
  { value: 'bulk_grant', label: '批量发放' },
  { value: 'bulk_profile', label: '批量类型' },
  { value: 'merge', label: '账号合并' },
  { value: 'create', label: '创建用户' },
  { value: 'policy', label: '点数策略' },
];

const USERS_PAGE_SIZE = 20;
const LEDGER_PAGE_SIZE = 50;

const CREDIT_POLICY_DEFAULT: CreditPolicy = {
  initial_grant: {
    enabled: true,
    internal_default: 0,
    external_default: 0,
    apply_to_self_register: true,
    apply_to_feishu_auto_create: true,
    apply_to_admin_create_default: true,
  },
  daily_quota: {
    enabled: false,
    timezone: 'Asia/Shanghai',
    internal_default: 0,
    external_default: 0,
    profile_overrides: {
      core_video: 0,
      core_animation: 0,
      core_design: 0,
      noncore_planning: 0,
      noncore_ops: 0,
      noncore_pm: 0,
      other: 0,
    },
    valid_hours: 24,
    clear_unused_on_expire: true,
  },
};

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

function hasFeishuBinding(user: AdminUser | null | undefined) {
  return Boolean(user?.feishu_user_id || user?.feishu_open_id || user?.feishu_union_id);
}

function getUserWallet(user: AdminUser) {
  const balance = user.credit_account?.balance || 0;
  const frozen = user.credit_account?.frozen_credits || 0;
  const dailyRemaining = user.credit_quota?.daily_remaining || 0;
  const dailyFrozen = user.credit_quota?.daily_frozen || 0;
  const dailyTotal = user.credit_quota?.daily_total || 0;
  const longAvailable = Math.max(0, balance - frozen);

  return {
    balance,
    frozen,
    dailyRemaining,
    dailyFrozen,
    dailyTotal,
    longAvailable,
    totalAvailable: longAvailable + dailyRemaining,
    totalFrozen: frozen + dailyFrozen,
  };
}

function isExpired(user: AdminUser) {
  if (!user.expires_at) return false;
  const expiresAt = new Date(user.expires_at).getTime();
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function canLogin(user: AdminUser) {
  return user.status === 'active' && !isExpired(user);
}

function getUserRiskTags(user: AdminUser) {
  const wallet = getUserWallet(user);
  const risks: string[] = [];
  if (user.status !== 'active') risks.push(statusLabel(user.status));
  if (isExpired(user)) risks.push('已过期');
  if (wallet.totalAvailable <= 0 && user.role !== 'admin') risks.push('点数不足');
  if (wallet.totalFrozen > 0) risks.push('有冻结点数');
  if (!hasFeishuBinding(user)) risks.push('无飞书');
  return risks;
}

function matchesQuickView(user: AdminUser, view: QuickView) {
  const wallet = getUserWallet(user);
  if (view === 'active') return canLogin(user);
  if (view === 'admins') return user.role === 'admin';
  if (view === 'feishu') return hasFeishuBinding(user);
  if (view === 'credit_alert') return wallet.totalAvailable <= 0 || wallet.totalFrozen > 0;
  if (view === 'quota_low') return wallet.dailyTotal > 0 && wallet.dailyRemaining <= 0;
  if (view === 'inactive') return user.status !== 'active' || isExpired(user);
  return true;
}

function selectedUserNames(users: AdminUser[]) {
  const names = users.slice(0, 3).map((user) => displayUserName(user)).join('、');
  return users.length > 3 ? `${names} 等 ${users.length} 人` : names || '未选择用户';
}

function adminUserOptionLabel(user: AdminUser) {
  const subtitle = displayUserSubtitle(user);
  return subtitle ? `${displayUserName(user)} (${subtitle})` : displayUserName(user);
}

function formatDateInput(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function numberOrZero(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function normalizeCreditPolicy(value: unknown): CreditPolicy {
  const policy = value && typeof value === 'object' ? value as Partial<CreditPolicy> : {};
  const initial = (policy.initial_grant || {}) as Partial<CreditPolicy['initial_grant']>;
  const daily = (policy.daily_quota || {}) as Partial<CreditPolicy['daily_quota']>;
  const overrides = daily.profile_overrides && typeof daily.profile_overrides === 'object'
    ? daily.profile_overrides
    : {};

  return {
    initial_grant: {
      enabled: initial.enabled !== false,
      internal_default: numberOrZero(initial.internal_default),
      external_default: numberOrZero(initial.external_default),
      apply_to_self_register: initial.apply_to_self_register !== false,
      apply_to_feishu_auto_create: initial.apply_to_feishu_auto_create !== false,
      apply_to_admin_create_default: initial.apply_to_admin_create_default !== false,
    },
    daily_quota: {
      enabled: daily.enabled === true,
      timezone: 'Asia/Shanghai',
      internal_default: numberOrZero(daily.internal_default),
      external_default: numberOrZero(daily.external_default),
      profile_overrides: {
        ...CREDIT_POLICY_DEFAULT.daily_quota.profile_overrides,
        ...Object.fromEntries(Object.entries(overrides).map(([key, amount]) => [key, numberOrZero(amount)])),
      },
      valid_hours: Math.min(168, Math.max(1, Number(daily.valid_hours) || 24)),
      clear_unused_on_expire: daily.clear_unused_on_expire !== false,
    },
  };
}

function estimateInitialGrant(policy: CreditPolicy, role: string, accountType: string) {
  if (!policy.initial_grant.enabled || role === 'admin' || !policy.initial_grant.apply_to_admin_create_default) return 0;
  return accountType === 'external'
    ? policy.initial_grant.external_default
    : policy.initial_grant.internal_default;
}

function estimateDailyQuota(policy: CreditPolicy, user: Pick<AdminUser, 'role' | 'account_type' | 'user_profile'> | {
  role: string;
  account_type: string;
  user_profile: string;
}) {
  if (!policy.daily_quota.enabled || user.role === 'admin') return 0;
  if (user.account_type === 'external') return policy.daily_quota.external_default;
  const override = policy.daily_quota.profile_overrides[user.user_profile || 'other'];
  return override && override > 0 ? override : policy.daily_quota.internal_default;
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
  const [creditPolicy, setCreditPolicy] = useState<CreditPolicy>(CREDIT_POLICY_DEFAULT);
  const [policySaving, setPolicySaving] = useState(false);
  const [userPage, setUserPage] = useState(1);
  const [quickView, setQuickView] = useState<QuickView>('all');
  const [focusedUserId, setFocusedUserId] = useState('');
  const [activeTool, setActiveTool] = useState<AdminToolPanel>('summary');

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
      if (!matchesQuickView(user, quickView)) return false;
      if (filters.account_type !== 'all' && user.account_type !== filters.account_type) return false;
      if (filters.user_profile !== 'all' && (user.user_profile || 'other') !== filters.user_profile) return false;
      if (filters.feature_profile_id !== 'all' && (user.feature_profile_id || 'standard_internal') !== filters.feature_profile_id) return false;
      if (filters.status !== 'all' && user.status !== filters.status) return false;
      if (!keyword) return true;
      return [user.name, user.username, user.email].some((value) => value.toLowerCase().includes(keyword));
    });
  }, [filters, quickView, users]);
  const userTotalPages = Math.max(1, Math.ceil(filteredUsers.length / USERS_PAGE_SIZE));
  const currentUserPage = Math.min(userPage, userTotalPages);
  const pagedUsers = filteredUsers.slice(
    (currentUserPage - 1) * USERS_PAGE_SIZE,
    currentUserPage * USERS_PAGE_SIZE,
  );

  const selectedUser = useMemo(
    () => users.find((user) => user.id === creditForm.user_id),
    [creditForm.user_id, users],
  );
  const selectedUsers = useMemo(() => {
    const selected = new Set(selectedUserIds);
    return users.filter((user) => selected.has(user.id));
  }, [selectedUserIds, users]);
  const focusedUser = useMemo(
    () => users.find((user) => user.id === focusedUserId) || selectedUsers[0] || null,
    [focusedUserId, selectedUsers, users],
  );
  const focusedWallet = focusedUser ? getUserWallet(focusedUser) : null;
  const focusedRisks = focusedUser ? getUserRiskTags(focusedUser) : [];
  const focusedLedger = useMemo(() => (
    focusedUser
      ? ledger.filter((record) => record.user_id === focusedUser.id).slice(0, 5)
      : ledger.slice(0, 5)
  ), [focusedUser, ledger]);
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
  const selectedSummary = useMemo(() => {
    const wallets = selectedUsers.map(getUserWallet);
    return {
      admins: selectedUsers.filter((user) => user.role === 'admin').length,
      external: selectedUsers.filter((user) => user.account_type === 'external').length,
      available: wallets.reduce((total, wallet) => total + wallet.totalAvailable, 0),
      frozen: wallets.reduce((total, wallet) => total + wallet.totalFrozen, 0),
    };
  }, [selectedUsers]);
  const editingUser = useMemo(
    () => users.find((user) => user.id === editingUserId) || null,
    [editingUserId, users],
  );
  const filteredUserIds = useMemo(() => filteredUsers.map((user) => user.id), [filteredUsers]);
  const allFilteredSelected = filteredUserIds.length > 0 && filteredUserIds.every((id) => selectedUserIds.includes(id));
  const workspaceStats = useMemo(() => {
    const wallets = users.map(getUserWallet);
    return {
      users: users.length,
      active: users.filter(canLogin).length,
      admins: users.filter((user) => user.role === 'admin').length,
      balance: wallets.reduce((total, wallet) => total + wallet.balance, 0),
      frozen: wallets.reduce((total, wallet) => total + wallet.totalFrozen, 0),
      dailyRemaining: wallets.reduce((total, wallet) => total + wallet.dailyRemaining, 0),
    };
  }, [users]);
  const quickViewCounts = useMemo<Record<QuickView, number>>(() => ({
    all: users.length,
    active: users.filter((user) => matchesQuickView(user, 'active')).length,
    admins: users.filter((user) => matchesQuickView(user, 'admins')).length,
    feishu: users.filter((user) => matchesQuickView(user, 'feishu')).length,
    credit_alert: users.filter((user) => matchesQuickView(user, 'credit_alert')).length,
    quota_low: users.filter((user) => matchesQuickView(user, 'quota_low')).length,
    inactive: users.filter((user) => matchesQuickView(user, 'inactive')).length,
  }), [users]);
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
  const suggestedNewUserInitialCredits = useMemo(
    () => estimateInitialGrant(creditPolicy, newUser.role, newUser.account_type),
    [creditPolicy, newUser.account_type, newUser.role],
  );
  const suggestedNewUserDailyQuota = useMemo(
    () => estimateDailyQuota(creditPolicy, {
      role: newUser.role,
      account_type: newUser.account_type,
      user_profile: newUser.user_profile,
    }),
    [creditPolicy, newUser.account_type, newUser.role, newUser.user_profile],
  );

  const loadUsers = async () => {
    const res = await fetch('/api/admin/users', { cache: 'no-store' });
    if (!res.ok) throw new Error('无法加载用户列表');
    const data = await res.json();
    setUsers(data.users || []);
  };

  const loadLedger = async () => {
    const res = await fetch(`/api/admin/credits/ledger?page=1&page_size=${LEDGER_PAGE_SIZE}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('无法加载点数流水');
    const data = await res.json();
    setLedger(data.records || []);
  };

  const loadPolicy = async () => {
    const res = await fetch('/api/admin/credits/policy', { cache: 'no-store' });
    if (!res.ok) throw new Error('无法加载点数策略');
    const data = await res.json();
    setCreditPolicy(normalizeCreditPolicy(data.policy));
  };

  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      await Promise.all([loadUsers(), loadLedger(), loadPolicy()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    setUserPage(1);
  }, [filters, quickView]);

  const updateInitialPolicy = (patch: Partial<CreditPolicy['initial_grant']>) => {
    setCreditPolicy((current) => ({
      ...current,
      initial_grant: { ...current.initial_grant, ...patch },
    }));
  };

  const updateDailyPolicy = (patch: Partial<CreditPolicy['daily_quota']>) => {
    setCreditPolicy((current) => ({
      ...current,
      daily_quota: { ...current.daily_quota, ...patch },
    }));
  };

  const updateDailyOverride = (profile: string, amount: number) => {
    setCreditPolicy((current) => ({
      ...current,
      daily_quota: {
        ...current.daily_quota,
        profile_overrides: {
          ...current.daily_quota.profile_overrides,
          [profile]: numberOrZero(amount),
        },
      },
    }));
  };

  const saveCreditPolicy = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setMessage('');
    setPolicySaving(true);
    try {
      const res = await fetch('/api/admin/credits/policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(creditPolicy),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || '保存点数策略失败');
        return;
      }
      setCreditPolicy(normalizeCreditPolicy(data.policy));
      setMessage('点数策略已保存');
      await refresh();
    } finally {
      setPolicySaving(false);
    }
  };

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
      initial_credits: String(estimateInitialGrant(creditPolicy, 'user', 'internal')),
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
    if (!Number.isFinite(amount) || amount < 0 || (creditForm.type !== 'adjust' && amount <= 0)) {
      setError('请输入正确的点数');
      return;
    }
    const operationLabel = creditForm.type === 'grant'
      ? `发放 ${amount} 点`
      : creditForm.type === 'deduct'
        ? `扣减 ${amount} 点长期余额`
        : `把长期余额修正为 ${amount} 点`;
    const ok = window.confirm(`确认对 ${selectedUser.name} ${operationLabel}？`);
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
    setFocusedUserId(userId);
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
    setFocusedUserId(userId);
    setActiveTool('credit');
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

    const previewNames = selectedUsers.slice(0, 3).map((user) => displayUserName(user)).join('、');
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
      setError(`管理员账号不能作为被合并账号：${mergeAdminSources.map((user) => displayUserName(user)).join('、')}`);
      return;
    }
    if (!reason) {
      setError('请输入合并原因');
      return;
    }

    const sourceNames = mergeSourceUsers.slice(0, 4).map((user) => displayUserName(user)).join('、');
    const moreText = mergeSourceUsers.length > 4 ? ` 等 ${mergeSourceUsers.length} 个账号` : '';
    const confirmText = [
      `确认把 ${sourceNames}${moreText} 合并到 ${displayUserName(mergeTargetUser)}？`,
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
    setFocusedUserId(user.id);
    setActiveTool('edit');
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
      if (patch.account_type === 'internal' && current.account_type === 'external') {
        next.feature_profile_id = 'auto';
      }
      if (patch.role === 'admin') {
        next.role = 'admin';
        if (next.account_type === 'external') {
          next.account_type = 'internal';
          next.feature_profile_id = 'auto';
        }
      }
      if (patch.user_profile !== undefined && next.account_type === 'internal') {
        next.feature_profile_id = 'auto';
      }
      return next;
    });
  };

  const updateEditAccountType = (value: string) => {
    const accountType = resolveAccountType(value);
    if (accountType === 'external' && editUserForm?.role === 'admin') {
      setError('管理员必须是内部账号；请先把系统身份改为普通用户再切换外部账号');
      setMessage('');
      return;
    }
    updateEditUserForm({ account_type: accountType });
  };

  const updateEditRole = (value: string) => {
    const role = value === 'admin' ? 'admin' : 'user';
    if (role === 'admin' && editUserForm?.account_type === 'external') {
      setError('');
      setMessage('管理员必须是内部账号，已自动切换账号来源为内部账号');
    }
    updateEditUserForm({ role });
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

    const updatedUser = {
      ...editingUser,
      ...data.user,
      credit_account: editingUser.credit_account,
      credit_quota: editingUser.credit_quota,
      last_login_at: editingUser.last_login_at,
    };

    setUsers((current) => current.map((user) => (
      user.id === updatedUser.id
        ? {
          ...user,
          ...updatedUser,
          credit_account: user.credit_account,
          credit_quota: user.credit_quota,
          last_login_at: user.last_login_at,
        }
        : user
    )));
    setEditingUserId(updatedUser.id);
    setEditUserForm(buildEditUserForm(updatedUser));
    setMessage('用户属性已更新');

    try {
      await loadUsers();
    } catch (err) {
      const refreshMessage = err instanceof Error ? err.message : '请手动刷新页面';
      setMessage(`用户属性已更新；列表刷新失败：${refreshMessage}`);
    }
  };

  const toggleUser = async (user: AdminUser) => {
    const action = user.status === 'active' ? 'disable' : 'enable';
    const label = action === 'disable' ? '禁用' : '启用';
    const ok = window.confirm(`确认${label}用户 ${displayUserName(user)}？`);
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

    const ok = window.confirm(`确认删除用户 ${displayUserName(user)}？该操作会隐藏账号并阻止登录，但不会删除历史任务和点数流水。`);
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
    <main className="admin-users-page admin-users-workbench-page">
      <PageBanner
        tone="dark"
        eyebrow="管理员后台"
        title="用户与点数工作台"
        description="/admin/points 已归并到本页；先定位用户和钱包状态，再进入创建、策略、批量、合并等低频操作。"
        actions={(
          <div className="admin-users-operator">
            {currentUser.name} · {currentUser.email}
          </div>
        )}
      />

      {(message || error) && (
        <div className={`admin-users-alert ${error ? 'admin-users-alert-error' : 'admin-users-alert-success'}`}>
          {error || message}
        </div>
      )}

      <section className="admin-users-stats-grid" aria-label="用户与点数概览">
        <div>
          <span>总用户</span>
          <strong>{formatNumber(workspaceStats.users)}</strong>
        </div>
        <div>
          <span>可登录</span>
          <strong>{formatNumber(workspaceStats.active)}</strong>
        </div>
        <div>
          <span>管理员</span>
          <strong>{formatNumber(workspaceStats.admins)}</strong>
        </div>
        <div>
          <span>长期余额</span>
          <strong>{formatNumber(workspaceStats.balance)}</strong>
        </div>
        <div>
          <span>冻结点数</span>
          <strong>{formatNumber(workspaceStats.frozen)}</strong>
        </div>
        <div>
          <span>今日额度剩余</span>
          <strong>{formatNumber(workspaceStats.dailyRemaining)}</strong>
        </div>
      </section>

      <section className="admin-users-filter-panel" aria-label="用户筛选">
        <div className="admin-users-search-row">
          <input
            style={inputStyle}
            placeholder="搜索姓名 / 账号 / 邮箱"
            value={filters.search}
            onChange={(event) => setFilters({ ...filters, search: event.target.value })}
          />
          <button type="button" className="admin-users-button admin-users-button-secondary" onClick={refresh} disabled={loading}>
            {loading ? '刷新中' : '刷新'}
          </button>
          <button type="button" className="admin-users-button admin-users-button-primary" onClick={() => setActiveTool('create')}>
            创建用户
          </button>
        </div>
        <div className="admin-users-quick-views">
          {QUICK_VIEW_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`admin-users-chip ${quickView === option.value ? 'is-active' : ''}`}
              onClick={() => setQuickView(option.value)}
            >
              {option.label}
              <span>{quickViewCounts[option.value]}</span>
            </button>
          ))}
        </div>
        <div className="admin-users-advanced-filters">
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
      </section>

      {selectedUserIds.length > 0 && (
        <section className="admin-users-selection-bar" aria-label="批量操作">
          <div>
            <strong>已选 {selectedUserIds.length} 人</strong>
            <span>
              {selectedUserNames(selectedUsers)} · 管理员 {selectedSummary.admins} · 外部 {selectedSummary.external} · 可用 {formatNumber(selectedSummary.available)} · 冻结 {formatNumber(selectedSummary.frozen)}
            </span>
          </div>
          <div className="admin-users-selection-actions">
            <button type="button" className="admin-users-button admin-users-button-secondary" onClick={toggleFilteredSelection}>
              {allFilteredSelected ? '取消筛选结果' : '全选筛选结果'}
            </button>
            <button type="button" className="admin-users-button admin-users-button-secondary" onClick={() => setSelectedUserIds([])}>
              清空选择
            </button>
            <button type="button" className="admin-users-button admin-users-button-primary" onClick={() => setActiveTool('bulk_grant')}>
              批量发放
            </button>
            <button type="button" className="admin-users-button admin-users-button-secondary" onClick={() => setActiveTool('bulk_profile')}>
              批量类型
            </button>
            <button type="button" className="admin-users-button admin-users-button-warning" onClick={() => setActiveTool('merge')}>
              账号合并
            </button>
          </div>
        </section>
      )}

      <section className="admin-users-workbench">
        <div className="admin-users-main-panel">
          <div className="admin-users-panel-head">
            <div>
              <h2>用户列表</h2>
              <p>筛选结果 {filteredUsers.length} 人 · 当前页 {currentUserPage}/{userTotalPages}</p>
            </div>
            <div className="admin-users-list-actions">
              <button type="button" className="admin-users-button admin-users-button-secondary" onClick={toggleFilteredSelection}>
                {allFilteredSelected ? '取消全选' : '全选结果'}
              </button>
              <button type="button" className="admin-users-button admin-users-button-secondary" onClick={() => setActiveTool('policy')}>
                点数策略
              </button>
            </div>
          </div>

          <div className="admin-users-table-wrap">
            <table className="admin-users-table">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      checked={allFilteredSelected}
                      onChange={toggleFilteredSelection}
                      aria-label="选择筛选结果用户"
                    />
                  </th>
                  <th>用户</th>
                  <th>权限</th>
                  <th>类型</th>
                  <th>点数</th>
                  <th>活跃</th>
                  <th>风险</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {pagedUsers.map((user) => {
                  const wallet = getUserWallet(user);
                  const risks = getUserRiskTags(user);
                  const isFocused = focusedUser?.id === user.id;

                  return (
                    <tr
                      key={user.id}
                      className={isFocused ? 'is-focused' : ''}
                      onClick={() => setFocusedUserId(user.id)}
                    >
                      <td onClick={(event) => event.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedUserIds.includes(user.id)}
                          onChange={() => toggleUserSelection(user.id)}
                          aria-label={`选择 ${displayUserName(user)}`}
                        />
                      </td>
                      <td className="admin-users-cell-user">
                        <strong>{displayUserName(user)}</strong>
                        <span>{displayUserSubtitle(user) || `ID ${user.id.slice(0, 8)}`}</span>
                        <small>{hasFeishuBinding(user) ? '已绑定飞书' : '未绑定飞书'}</small>
                      </td>
                      <td>
                        <div className="admin-users-tag-stack">
                          <span className={`admin-users-status-chip ${canLogin(user) ? 'is-good' : 'is-muted'}`}>{statusLabel(user.status)}</span>
                          <span>{accountTypeLabel(user.account_type)} · {user.role === 'admin' ? '管理员' : '普通用户'}</span>
                        </div>
                      </td>
                      <td>
                        <div className="admin-users-muted-stack">
                          <span>{getUserProfileLabel(user.user_profile)}</span>
                          <small>{getFeatureProfileLabel(user.feature_profile_id)}</small>
                        </div>
                      </td>
                      <td className="admin-users-cell-number">
                        <strong>可用 {formatNumber(wallet.totalAvailable)}</strong>
                        <span>长期 {formatNumber(wallet.balance)} / 冻结 {formatNumber(wallet.totalFrozen)}</span>
                        {wallet.dailyTotal > 0 && <small>今日 {formatNumber(wallet.dailyRemaining)} / {formatNumber(wallet.dailyTotal)}</small>}
                      </td>
                      <td>
                        <div className="admin-users-muted-stack">
                          <span>{formatDate(user.last_login_at)}</span>
                          <small>创建 {formatDate(user.created_at)}</small>
                        </div>
                      </td>
                      <td>
                        <div className="admin-users-risk-list">
                          {risks.slice(0, 3).map((risk) => <span key={risk}>{risk}</span>)}
                          {risks.length === 0 && <span className="is-quiet">正常</span>}
                        </div>
                      </td>
                      <td onClick={(event) => event.stopPropagation()}>
                        <div className="admin-users-row-actions">
                          <button type="button" className="admin-users-text-button" onClick={() => openEditUser(user)}>
                            编辑
                          </button>
                          <button type="button" className="admin-users-text-button" onClick={() => selectOnlyUser(user.id)}>
                            点数
                          </button>
                          <button type="button" className="admin-users-text-button" onClick={() => toggleUser(user)}>
                            {user.status === 'active' ? '禁用' : '启用'}
                          </button>
                          <button
                            type="button"
                            className="admin-users-text-button is-danger"
                            onClick={() => deleteUser(user)}
                            disabled={user.id === currentUser.id}
                          >
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {!loading && filteredUsers.length === 0 && (
                  <tr>
                    <td colSpan={8} className="admin-users-empty">暂无匹配用户</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <PaginationControls
            page={currentUserPage}
            totalPages={userTotalPages}
            total={filteredUsers.length}
            pageSize={USERS_PAGE_SIZE}
            label="用户"
            onPageChange={setUserPage}
          />
        </div>

        <aside className="admin-users-side-panel">
          <section className="admin-users-decision-card">
            <div className="admin-users-side-head">
              <div>
                <span>当前处理对象</span>
                <h2>{focusedUser ? focusedUser.name : '未选择用户'}</h2>
              </div>
              {focusedUser && <span className="admin-users-status-chip">{statusLabel(focusedUser.status)}</span>}
            </div>

            {focusedUser && focusedWallet ? (
              <>
                <div className="admin-users-decision-summary">
                  <div>
                    <span>可登录</span>
                    <strong>{canLogin(focusedUser) ? '是' : '否'}</strong>
                  </div>
                  <div>
                    <span>系统身份</span>
                    <strong>{focusedUser.role === 'admin' ? '管理员' : '普通用户'}</strong>
                  </div>
                  <div>
                    <span>总可用</span>
                    <strong>{formatNumber(focusedWallet.totalAvailable)}</strong>
                  </div>
                  <div>
                    <span>总冻结</span>
                    <strong>{formatNumber(focusedWallet.totalFrozen)}</strong>
                  </div>
                </div>
                <div className="admin-users-wallet-card">
                  <div>
                    <span>长期余额</span>
                    <strong>{formatNumber(focusedWallet.balance)}</strong>
                  </div>
                  <div>
                    <span>长期冻结</span>
                    <strong>{formatNumber(focusedWallet.frozen)}</strong>
                  </div>
                  <div>
                    <span>今日剩余</span>
                    <strong>{formatNumber(focusedWallet.dailyRemaining)}</strong>
                  </div>
                  <div>
                    <span>今日总额</span>
                    <strong>{formatNumber(focusedWallet.dailyTotal)}</strong>
                  </div>
                </div>
                <div className="admin-users-risk-panel">
                  <span>风险提示</span>
                  <div>
                    {focusedRisks.length > 0
                      ? focusedRisks.map((risk) => <strong key={risk}>{risk}</strong>)
                      : <strong>当前没有显著风险</strong>}
                  </div>
                </div>
                <div className="admin-users-primary-actions">
                  <button
                    type="button"
                    className="admin-users-button admin-users-button-primary"
                    onClick={() => {
                      setCreditForm((current) => ({ ...current, user_id: focusedUser.id, type: 'grant' }));
                      setActiveTool('credit');
                    }}
                  >
                    发放点数
                  </button>
                  <button type="button" className="admin-users-button admin-users-button-secondary" onClick={() => openEditUser(focusedUser)}>
                    编辑账户
                  </button>
                  <button type="button" className="admin-users-button admin-users-button-secondary" onClick={() => toggleUser(focusedUser)}>
                    {focusedUser.status === 'active' ? '禁用账号' : '启用账号'}
                  </button>
                </div>
                <div className="admin-users-mini-ledger">
                  <div className="admin-users-section-title">最近流水</div>
                  {focusedLedger.length > 0 ? focusedLedger.map((item) => (
                    <div key={item.id} className="admin-users-mini-ledger-row">
                      <span>{item.type}</span>
                      <strong>{item.amount > 0 ? '+' : ''}{formatNumber(item.amount)}</strong>
                      <small>{formatDate(item.created_at)}</small>
                    </div>
                  )) : (
                    <p>暂无该用户最近流水。</p>
                  )}
                  <Link className="link" href={`/admin/points?user_id=${focusedUser.id}`}>
                    查看完整流水
                  </Link>
                </div>
              </>
            ) : (
              <div className="admin-users-empty-side">
                从左侧列表点选用户，右侧会显示登录状态、钱包、风险和下一步操作。
              </div>
            )}
          </section>

          <nav className="admin-users-tool-nav" aria-label="管理工具">
            {ADMIN_TOOL_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={activeTool === option.value ? 'is-active' : ''}
                onClick={() => setActiveTool(option.value)}
              >
                {option.label}
              </button>
            ))}
          </nav>

          {activeTool === 'summary' && (
            <section className="admin-users-tool-panel">
              <div className="admin-users-section-title">工具入口归位</div>
              <p>首屏只保留用户定位、钱包判断和推荐动作。创建用户、点数策略、批量发放、账号合并等低频功能已收进工具栏。</p>
              <div className="admin-users-tool-map">
                <span>单人处理：选中用户后发放点数、编辑账户、启用或禁用。</span>
                <span>批量处理：勾选用户后批量发放、批量类型、账号合并。</span>
                <span>低频配置：点数策略和创建用户独立进入。</span>
              </div>
            </section>
          )}

          {activeTool === 'policy' && (
            <form onSubmit={saveCreditPolicy} className="admin-users-tool-panel">
              <div className="admin-users-panel-title-row">
                <div>
                  <h3>点数策略</h3>
                  <p>管理新用户初始点数和每日固定额度。</p>
                </div>
                <button type="submit" className="admin-users-button admin-users-button-primary" disabled={policySaving}>
                  {policySaving ? '保存中' : '保存策略'}
                </button>
              </div>

              <div className="admin-users-form-grid">
                <section className="admin-users-form-block">
                  <label className="admin-users-check-label">
                    <input
                      type="checkbox"
                      checked={creditPolicy.initial_grant.enabled}
                      onChange={(event) => updateInitialPolicy({ enabled: event.target.checked })}
                    />
                    新用户初始点数
                  </label>
                  <div className="admin-users-two-col">
                    <input
                      style={inputStyle}
                      type="number"
                      min="0"
                      placeholder="内部新用户默认点数"
                      value={creditPolicy.initial_grant.internal_default}
                      onChange={(event) => updateInitialPolicy({ internal_default: numberOrZero(event.target.value) })}
                    />
                    <input
                      style={inputStyle}
                      type="number"
                      min="0"
                      placeholder="外部新用户默认点数"
                      value={creditPolicy.initial_grant.external_default}
                      onChange={(event) => updateInitialPolicy({ external_default: numberOrZero(event.target.value) })}
                    />
                  </div>
                  <div className="admin-users-checkbox-stack">
                    <label><input type="checkbox" checked={creditPolicy.initial_grant.apply_to_self_register} onChange={(event) => updateInitialPolicy({ apply_to_self_register: event.target.checked })} /> 注册用户自动发放</label>
                    <label><input type="checkbox" checked={creditPolicy.initial_grant.apply_to_feishu_auto_create} onChange={(event) => updateInitialPolicy({ apply_to_feishu_auto_create: event.target.checked })} /> 飞书首次登录自动发放</label>
                    <label><input type="checkbox" checked={creditPolicy.initial_grant.apply_to_admin_create_default} onChange={(event) => updateInitialPolicy({ apply_to_admin_create_default: event.target.checked })} /> 管理员创建用户默认套用</label>
                  </div>
                </section>

                <section className="admin-users-form-block">
                  <label className="admin-users-check-label">
                    <input
                      type="checkbox"
                      checked={creditPolicy.daily_quota.enabled}
                      onChange={(event) => updateDailyPolicy({ enabled: event.target.checked })}
                    />
                    每日固定额度
                  </label>
                  <div className="admin-users-three-col">
                    <input
                      style={inputStyle}
                      type="number"
                      min="0"
                      placeholder="内部默认"
                      value={creditPolicy.daily_quota.internal_default}
                      onChange={(event) => updateDailyPolicy({ internal_default: numberOrZero(event.target.value) })}
                    />
                    <input
                      style={inputStyle}
                      type="number"
                      min="0"
                      placeholder="外部默认"
                      value={creditPolicy.daily_quota.external_default}
                      onChange={(event) => updateDailyPolicy({ external_default: numberOrZero(event.target.value) })}
                    />
                    <input
                      style={inputStyle}
                      type="number"
                      min="1"
                      max="168"
                      placeholder="有效小时"
                      value={creditPolicy.daily_quota.valid_hours}
                      onChange={(event) => updateDailyPolicy({ valid_hours: Math.min(168, Math.max(1, Number(event.target.value) || 24)) })}
                    />
                  </div>
                  <p className="admin-users-hint">每日额度按上海时间懒发放；过期未使用清零，已冻结额度等任务结算后关闭或返还。</p>
                  <div className="admin-users-policy-grid">
                    {USER_PROFILE_OPTIONS.map((option) => (
                      <label key={option.value}>
                        {option.label}
                        <input
                          style={inputStyle}
                          type="number"
                          min="0"
                          value={creditPolicy.daily_quota.profile_overrides[option.value] || 0}
                          onChange={(event) => updateDailyOverride(option.value, Number(event.target.value))}
                        />
                      </label>
                    ))}
                  </div>
                </section>
              </div>
            </form>
          )}

          {activeTool === 'edit' && (
            editingUser && editUserForm ? (
              <form onSubmit={saveEditedUser} className="admin-users-tool-panel">
                <div className="admin-users-panel-title-row">
                  <div>
                    <h3>账户属性</h3>
                    <p>{editingUser.username} · {editingUser.email}</p>
                  </div>
                  <button
                    type="button"
                    className="admin-users-button admin-users-button-secondary"
                    onClick={() => {
                      setEditingUserId('');
                      setEditUserForm(null);
                    }}
                  >
                    关闭
                  </button>
                </div>

                <div className="admin-users-form-grid">
                  <div className="admin-users-two-col">
                    <input style={inputStyle} placeholder="用户名" value={editUserForm.name} onChange={(event) => updateEditUserForm({ name: event.target.value })} />
                    <input style={inputStyle} placeholder="账号" value={editUserForm.username} onChange={(event) => updateEditUserForm({ username: event.target.value })} />
                  </div>
                  <input style={inputStyle} placeholder="邮箱" value={editUserForm.email} onChange={(event) => updateEditUserForm({ email: event.target.value })} />
                  <div className="admin-users-two-col">
                    <select style={inputStyle} value={editUserForm.account_type} onChange={(event) => updateEditAccountType(event.target.value)}>
                      <option value="internal">内部账号</option>
                      <option value="external" disabled={editUserForm.role === 'admin'}>外部账号，预留</option>
                    </select>
                    <select style={inputStyle} value={editUserForm.role} onChange={(event) => updateEditRole(event.target.value)}>
                      <option value="user">普通用户</option>
                      <option value="admin">管理员</option>
                    </select>
                  </div>

                  <div className={`admin-users-impact-box ${editUserForm.role === 'admin' ? 'is-admin' : ''}`}>
                    <span>管理员身份</span>
                    <p>{editUserForm.role === 'admin' ? '可进入后台、管理用户、发放点数并查看成本数据。' : '只能使用用户端功能，不能进入管理员后台。'}</p>
                    {editUserForm.account_type === 'external' && <small>外部账号只能作为普通用户保留；如需设为管理员，请先切换为内部账号。</small>}
                    {hasFeishuBinding(editingUser) && <small>已绑定飞书，设为管理员时后端会按内部账号兜底处理。</small>}
                  </div>

                  <select style={inputStyle} value={editUserForm.user_profile} onChange={(event) => updateEditUserForm({ user_profile: event.target.value })} disabled={editUserForm.account_type === 'external'}>
                    {USER_PROFILE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                  <select style={inputStyle} value={editUserForm.feature_profile_id} onChange={(event) => updateEditUserForm({ feature_profile_id: event.target.value })} disabled={editUserForm.account_type === 'external'}>
                    <option value="auto">自动建议：{getFeatureProfileLabel(suggestedEditUserFeatureProfileId)}</option>
                    {FEATURE_PROFILE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>

                  <div className="admin-users-two-col">
                    <select style={inputStyle} value={editUserForm.status} onChange={(event) => updateEditUserForm({ status: event.target.value })}>
                      {USER_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                    <input style={inputStyle} type="date" value={editUserForm.expires_at} onChange={(event) => updateEditUserForm({ expires_at: event.target.value })} />
                  </div>

                  <div className="admin-users-impact-box">
                    <span>影响预览</span>
                    <p>来源：{accountTypeLabel(editUserForm.account_type)} · 系统身份：{editUserForm.role === 'admin' ? '管理员' : '普通用户'}</p>
                    <p>组织分类：{getUserProfileLabel(editUserForm.user_profile)} · 能力档案：{getFeatureProfileLabel(editUserForm.feature_profile_id === 'auto' ? suggestedEditUserFeatureProfileId : editUserForm.feature_profile_id)}</p>
                    <p>状态：{statusLabel(editUserForm.status)}{editUserForm.expires_at ? `，到期 ${editUserForm.expires_at}` : '，长期有效'}</p>
                    <small>账户属性不会自动改点数，点数仍走流水。</small>
                  </div>

                  <input style={inputStyle} placeholder="修改原因，必填" value={editUserForm.reason} onChange={(event) => updateEditUserForm({ reason: event.target.value })} />
                  <button type="submit" className="admin-users-button admin-users-button-primary">保存账户属性</button>
                </div>
              </form>
            ) : (
              <section className="admin-users-tool-panel">
                <h3>账户属性</h3>
                <p>从左侧用户列表点击“编辑”，可设置账号来源、组织分类、能力档案、管理员身份、状态和过期时间。</p>
              </section>
            )
          )}

          {activeTool === 'bulk_profile' && (
            <form onSubmit={bulkUpdateProfiles} className="admin-users-tool-panel">
              <div className="admin-users-panel-title-row">
                <div>
                  <h3>批量修改用户类型</h3>
                  <p>已选 {selectedUserIds.length} 人，外部账号会强制使用外部受限档案。</p>
                </div>
              </div>
              <div className="admin-users-form-grid">
                <select style={inputStyle} value={bulkProfileForm.user_profile} onChange={(event) => setBulkProfileForm({ ...bulkProfileForm, user_profile: event.target.value, feature_profile_id: 'auto' })}>
                  {USER_PROFILE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                <select style={inputStyle} value={bulkProfileForm.feature_profile_id} onChange={(event) => setBulkProfileForm({ ...bulkProfileForm, feature_profile_id: event.target.value })}>
                  <option value="auto">自动建议：{getFeatureProfileLabel(suggestedBulkFeatureProfileId)}</option>
                  {FEATURE_PROFILE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                <input style={inputStyle} placeholder="修改原因，必填" value={bulkProfileForm.reason} onChange={(event) => setBulkProfileForm({ ...bulkProfileForm, reason: event.target.value })} />
                <button className="admin-users-button admin-users-button-primary" type="submit" disabled={selectedUserIds.length === 0}>修改已选用户</button>
              </div>
            </form>
          )}

          {activeTool === 'merge' && (
            <form onSubmit={mergeUsers} className="admin-users-tool-panel">
              <div className="admin-users-panel-title-row">
                <div>
                  <h3>合并重复账号</h3>
                  <p>源账号 {mergeSourceUsers.length} 个；管理员账号不能作为源账号。</p>
                </div>
              </div>
              <div className="admin-users-form-grid">
                <div className="admin-users-step-box">
                  <strong>1. 选择保留账号</strong>
                  <select style={inputStyle} value={mergeForm.target_user_id} onChange={(event) => setMergeForm({ ...mergeForm, target_user_id: event.target.value })}>
                    <option value="">选择最终保留账号</option>
                    {users
                      .filter((user) => user.status === 'active')
                      .map((user) => (
                        <option key={user.id} value={user.id}>
                          {adminUserOptionLabel(user)}{user.role === 'admin' ? ' · 管理员' : ''}
                        </option>
                      ))}
                  </select>
                </div>
                <div className="admin-users-step-box">
                  <strong>2. 检查源账号和影响范围</strong>
                  <p>源账号会软删除；任务、项目、图集、成本、反馈、资产、飞书身份会迁移到保留账号。</p>
                  <p>点数转入：余额 {formatNumber(mergeCreditPreview.balance)} 点，冻结 {formatNumber(mergeCreditPreview.frozen)} 点。</p>
                  {mergeAdminSources.length > 0 && <p className="is-danger">当前已选包含管理员：{mergeAdminSources.map((user) => displayUserName(user)).join('、')}</p>}
                </div>
                <input style={inputStyle} placeholder="合并原因，必填" value={mergeForm.reason} onChange={(event) => setMergeForm({ ...mergeForm, reason: event.target.value })} />
                <button
                  className="admin-users-button admin-users-button-warning"
                  type="submit"
                  disabled={!mergeTargetUser || mergeSourceUsers.length === 0 || mergeAdminSources.length > 0}
                >
                  合并到保留账号
                </button>
              </div>
            </form>
          )}

          {activeTool === 'bulk_grant' && (
            <form onSubmit={bulkGrantCredits} className="admin-users-tool-panel">
              <div className="admin-users-panel-title-row">
                <div>
                  <h3>批量发放点数</h3>
                  <p>已选 {selectedUserIds.length} 人；禁用用户可入账，但启用前不能登录使用。</p>
                </div>
              </div>
              <div className="admin-users-form-grid">
                <input style={inputStyle} type="number" min="0" placeholder="每人发放点数" value={bulkGrantForm.amount} onChange={(e) => setBulkGrantForm({ ...bulkGrantForm, amount: e.target.value })} />
                <input style={inputStyle} placeholder="发放原因，必填" value={bulkGrantForm.reason} onChange={(e) => setBulkGrantForm({ ...bulkGrantForm, reason: e.target.value })} />
                <div className="admin-users-impact-box">
                  <span>发放预览</span>
                  <p>{selectedUserNames(selectedUsers)} · 每人 {bulkGrantForm.amount || 0} 点 · 总计 {formatNumber((Number(bulkGrantForm.amount) || 0) * selectedUserIds.length)} 点</p>
                </div>
                <button className="admin-users-button admin-users-button-primary" type="submit" disabled={selectedUserIds.length === 0}>给已选用户发放</button>
              </div>
            </form>
          )}

          {activeTool === 'create' && (
            <form onSubmit={createUser} className="admin-users-tool-panel">
              <div className="admin-users-panel-title-row">
                <div>
                  <h3>创建用户</h3>
                  <p>创建后会自动建立点数账户和个人默认项目。</p>
                </div>
              </div>
              <div className="admin-users-form-grid">
                <div className="admin-users-two-col">
                  <input style={inputStyle} placeholder="姓名" value={newUser.name} onChange={(e) => setNewUser({ ...newUser, name: e.target.value })} />
                  <input style={inputStyle} placeholder="账号" value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} />
                </div>
                <input style={inputStyle} placeholder="邮箱" value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} />
                <input style={inputStyle} type="password" placeholder="初始密码" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} />
                <div className="admin-users-two-col">
                  <select
                    style={inputStyle}
                    value={newUser.role}
                    onChange={(e) => setNewUser({
                      ...newUser,
                      role: e.target.value,
                      account_type: e.target.value === 'admin' ? 'internal' : newUser.account_type,
                      feature_profile_id: e.target.value === 'admin' && newUser.account_type === 'external' ? 'auto' : newUser.feature_profile_id,
                    })}
                  >
                    <option value="user">普通用户</option>
                    <option value="admin">管理员</option>
                  </select>
                  <select
                    style={inputStyle}
                    value={newUser.account_type}
                    onChange={(e) => setNewUser({
                      ...newUser,
                      account_type: e.target.value,
                      role: e.target.value === 'external' ? 'user' : newUser.role,
                      user_profile: e.target.value === 'external' ? 'other' : newUser.user_profile,
                      feature_profile_id: 'auto',
                    })}
                  >
                    <option value="internal">内部账号</option>
                    <option value="external">外部账号，预留</option>
                  </select>
                </div>
                <select style={inputStyle} value={newUser.user_profile} onChange={(e) => setNewUser({ ...newUser, user_profile: e.target.value, feature_profile_id: 'auto' })} disabled={newUser.account_type === 'external'}>
                  {USER_PROFILE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                <select style={inputStyle} value={newUser.feature_profile_id} onChange={(e) => setNewUser({ ...newUser, feature_profile_id: e.target.value })}>
                  <option value="auto">自动建议：{getFeatureProfileLabel(suggestedNewUserFeatureProfileId)}</option>
                  {FEATURE_PROFILE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                <div className="admin-users-two-col">
                  <input style={inputStyle} type="number" min="0" placeholder="初始点数" value={newUser.initial_credits} onChange={(e) => setNewUser({ ...newUser, initial_credits: e.target.value })} />
                  <button type="button" className="admin-users-button admin-users-button-secondary" onClick={() => setNewUser({ ...newUser, initial_credits: String(suggestedNewUserInitialCredits) })}>
                    套用策略
                  </button>
                </div>
                <div className="admin-users-impact-box">
                  <span>创建预览</span>
                  <p>策略建议初始 {formatNumber(suggestedNewUserInitialCredits)} 点，每日额度 {formatNumber(suggestedNewUserDailyQuota)} 点。</p>
                  <small>管理员必须是内部账号；外部账号会使用外部受限档案。</small>
                </div>
                <input style={inputStyle} placeholder="原因" value={newUser.reason} onChange={(e) => setNewUser({ ...newUser, reason: e.target.value })} />
                <button className="admin-users-button admin-users-button-primary" type="submit">创建用户</button>
              </div>
            </form>
          )}

          {activeTool === 'credit' && (
            <form onSubmit={adjustCredits} className="admin-users-tool-panel">
              <div className="admin-users-panel-title-row">
                <div>
                  <h3>单人点数操作</h3>
                  <p>只影响长期余额；每日固定额度由策略自动发放和过期清零。</p>
                </div>
              </div>
              <div className="admin-users-form-grid">
                <select style={inputStyle} value={creditForm.user_id} onChange={(e) => setCreditForm({ ...creditForm, user_id: e.target.value })}>
                  <option value="">选择用户</option>
                  {users.map((user) => <option key={user.id} value={user.id}>{adminUserOptionLabel(user)}</option>)}
                </select>
                <select style={inputStyle} value={creditForm.type} onChange={(e) => setCreditForm({ ...creditForm, type: e.target.value })}>
                  <option value="grant">发放</option>
                  <option value="deduct">扣减</option>
                  <option value="adjust">修正为</option>
                </select>
                <input
                  style={inputStyle}
                  type="number"
                  min="0"
                  placeholder={creditForm.type === 'grant' ? '发放点数' : creditForm.type === 'deduct' ? '扣减点数' : '修正后的长期余额'}
                  value={creditForm.amount}
                  onChange={(e) => setCreditForm({ ...creditForm, amount: e.target.value })}
                />
                {selectedUser && (
                  <div className="admin-users-impact-box">
                    <span>操作预览</span>
                    <p>当前长期余额 {formatNumber(selectedUser.credit_account?.balance || 0)}，长期冻结 {formatNumber(selectedUser.credit_account?.frozen_credits || 0)}。</p>
                    <small>扣减不能超过长期可用余额；修正不能低于冻结点数。</small>
                  </div>
                )}
                <input style={inputStyle} placeholder="原因，必填" value={creditForm.reason} onChange={(e) => setCreditForm({ ...creditForm, reason: e.target.value })} />
                <button className="admin-users-button admin-users-button-primary" type="submit">确认点数操作</button>
              </div>
            </form>
          )}
        </aside>
      </section>

      <section className="admin-users-ledger-panel">
        <div className="admin-users-panel-head">
          <div>
            <h2>点数流水</h2>
            <p>完整流水、筛选、任务追溯和后续项目额度账本已经收口到二级页面。当前页只保留选中用户的最近摘要。</p>
          </div>
          <Link className="admin-users-button admin-users-button-primary" href="/admin/points">
            打开点数与额度流水
          </Link>
        </div>
        <div className="admin-users-ledger-redirect">
          <div>
            <strong>主入口：/admin/points</strong>
            <p>适合按用户、任务、流水类型、关键词和时间范围查账；后续项目代付上线后，项目额度流水也放在同一个账本二级页。</p>
          </div>
          <div>
            <strong>当前页职责</strong>
            <p>用户列表、批量发放、单人点数操作、点数策略和选中用户最近摘要。</p>
          </div>
        </div>
      </section>
    </main>
  );
}
