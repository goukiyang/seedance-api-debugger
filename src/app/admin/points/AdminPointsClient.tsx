'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import PageBanner from '@/components/PageBanner';
import PaginationControls from '@/components/PaginationControls';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import { displayUserSubtitle } from '@/lib/users/display';

interface PointsStats {
  user_count: number;
  total_balance: number;
  total_frozen: number;
  monthly_used: number;
  total_used: number;
  ledger_today: number;
}

interface PointsInitialFilters {
  user_id?: string;
  task_id?: string;
  type?: string;
  q?: string;
  date_from?: string;
  date_to?: string;
}

interface LedgerUser {
  id: string;
  name: string | null;
  username: string | null;
  email?: string | null;
  avatar_url?: string | null;
  account_type?: string | null;
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
  related_task_id: string | null;
  operator_id: string | null;
  reason: string | null;
  metadata_json: string | null;
  created_at: string;
  user?: LedgerUser | null;
}

interface PaginationState {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

const LEDGER_PAGE_SIZE = 50;

function formatNumber(value: number | null | undefined) {
  return Number(value || 0).toFixed(0);
}

function formatDate(value: string | null | undefined) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN');
}

function ledgerTypeLabel(type: string) {
  const labels: Record<string, string> = {
    admin_grant: '管理员发放',
    admin_deduct: '管理员扣减',
    system_adjust: '系统修正',
    task_freeze: '任务冻结',
    task_success_deduct: '成功扣除',
    task_failed_refund: '失败返还',
    manual_refund: '手动退款',
    periodic_grant: '周期发放',
    new_user_initial_grant: '新用户初始',
    daily_quota_grant: '每日额度发放',
    daily_quota_expire: '每日额度过期',
    expired_refund_closed: '过期返还关闭',
  };
  return labels[type] || type;
}

function amountClass(amount: number) {
  if (amount > 0) return 'text-green';
  if (amount < 0) return 'text-red';
  return 'text-gray';
}

function userSubtitle(user: LedgerUser | null | undefined) {
  if (!user) return '';
  return displayUserSubtitle(user) || user.email || '';
}

function recordUser(record: Pick<LedgerRecord, 'user' | 'user_id'>) {
  return record.user || { id: record.user_id, name: null, username: null };
}

function buildLedgerQuery(filters: PointsInitialFilters, page: number) {
  const params = new URLSearchParams();
  params.set('page', String(page));
  params.set('page_size', String(LEDGER_PAGE_SIZE));

  Object.entries(filters).forEach(([key, value]) => {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (normalized) params.set(key, normalized);
  });

  return params;
}

function metadataSummary(value: string | null) {
  if (!value) return '-';
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed?.allocations)) {
      return `${parsed.allocations.length} 条冻结分配`;
    }
    if (parsed && typeof parsed === 'object') {
      return Object.keys(parsed).slice(0, 4).join(' / ') || '-';
    }
  } catch {
    return '原始 metadata';
  }
  return '原始 metadata';
}

export default function AdminPointsClient({
  stats,
  initialFilters,
}: {
  stats: PointsStats;
  initialFilters: PointsInitialFilters;
}) {
  const [filters, setFilters] = useState<PointsInitialFilters>(initialFilters);
  const [appliedFilters, setAppliedFilters] = useState<PointsInitialFilters>(initialFilters);
  const [records, setRecords] = useState<LedgerRecord[]>([]);
  const [pagination, setPagination] = useState<PaginationState | null>(null);
  const [selectedRecord, setSelectedRecord] = useState<LedgerRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const activeFilterCount = useMemo(
    () => Object.values(appliedFilters).filter((value) => typeof value === 'string' && value.trim().length > 0).length,
    [appliedFilters],
  );

  const loadLedger = useCallback(async (page = 1) => {
    setLoading(true);
    setError('');
    try {
      const query = buildLedgerQuery(appliedFilters, page);
      const res = await fetch(`/api/admin/credits/ledger?${query.toString()}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '无法加载点数流水');
      const pageSize = Number(data.page_size || LEDGER_PAGE_SIZE);
      const total = Number(data.total || 0);
      const nextRecords = data.records || [];
      setRecords(nextRecords);
      setPagination({
        page: Number(data.page || page),
        page_size: pageSize,
        total,
        total_pages: Math.max(1, Math.ceil(total / pageSize)),
      });
      setSelectedRecord((current) => {
        if (current && nextRecords.some((record: LedgerRecord) => record.id === current.id)) return current;
        return nextRecords[0] || null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载点数流水失败');
    } finally {
      setLoading(false);
    }
  }, [appliedFilters]);

  useEffect(() => {
    void loadLedger(1);
  }, [loadLedger]);

  const applyFilters = () => {
    setAppliedFilters(filters);
  };

  const clearFilters = () => {
    const emptyFilters: PointsInitialFilters = {};
    setFilters(emptyFilters);
    setAppliedFilters(emptyFilters);
  };

  return (
    <div className="admin-points-page">
      <PageBanner
        eyebrow="管理员后台"
        title="点数与额度流水"
        description="把用户点数、任务冻结、扣除、返还和后续项目额度流水集中到一个二级页；用户管理页只保留最近摘要和操作入口。"
        actions={(
          <>
            <Link className="btn btn-secondary" href="/admin/users">用户与点数</Link>
            <Link className="btn btn-secondary" href="/admin/costs">计费与成本</Link>
          </>
        )}
      />

      <div className="stats-grid">
        <div className="stat-card">
          <span className="stat-label">用户账户</span>
          <strong className="stat-value">{formatNumber(stats.user_count)}</strong>
          <span className="stat-sub">已有点数账户</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">长期余额</span>
          <strong className="stat-value">{formatNumber(stats.total_balance)}</strong>
          <span className="stat-sub">全站用户点数余额</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">冻结点数</span>
          <strong className="stat-value">{formatNumber(stats.total_frozen)}</strong>
          <span className="stat-sub">任务未终态前占用</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">本月已用</span>
          <strong className="stat-value">{formatNumber(stats.monthly_used)}</strong>
          <span className="stat-sub">用户账户累计</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">今日流水</span>
          <strong className="stat-value">{formatNumber(stats.ledger_today)}</strong>
          <span className="stat-sub">按创建时间统计</span>
        </div>
      </div>

      <section className="card">
        <div className="admin-points-filter-head">
          <div>
            <h2 className="section-title mb-0">筛选流水</h2>
            <p className="text-gray text-sm mt-2">支持从用户页、项目页、任务详情和成本页带参数跳转；当前生效筛选 {activeFilterCount} 项。</p>
          </div>
          <button className="btn btn-secondary" type="button" onClick={clearFilters}>清空</button>
        </div>

        <div className="admin-points-filter-grid">
          <label>
            关键词
            <input
              value={filters.q || ''}
              onChange={(event) => setFilters((current) => ({ ...current, q: event.target.value }))}
              placeholder="用户、原因、流水 ID"
            />
          </label>
          <label>
            用户 ID
            <input
              value={filters.user_id || ''}
              onChange={(event) => setFilters((current) => ({ ...current, user_id: event.target.value }))}
              placeholder="user_id"
            />
          </label>
          <label>
            任务 ID
            <input
              value={filters.task_id || ''}
              onChange={(event) => setFilters((current) => ({ ...current, task_id: event.target.value }))}
              placeholder="task_id"
            />
          </label>
          <label>
            类型
            <select
              value={filters.type || ''}
              onChange={(event) => setFilters((current) => ({ ...current, type: event.target.value }))}
            >
              <option value="">全部类型</option>
              <option value="task_freeze">任务冻结</option>
              <option value="task_success_deduct">成功扣除</option>
              <option value="task_failed_refund">失败返还</option>
              <option value="admin_grant">管理员发放</option>
              <option value="admin_deduct">管理员扣减</option>
              <option value="system_adjust">系统修正</option>
              <option value="new_user_initial_grant">新用户初始</option>
              <option value="daily_quota_grant">每日额度发放</option>
              <option value="expired_refund_closed">过期返还关闭</option>
            </select>
          </label>
          <label>
            开始日期
            <input
              type="date"
              value={filters.date_from || ''}
              onChange={(event) => setFilters((current) => ({ ...current, date_from: event.target.value }))}
            />
          </label>
          <label>
            结束日期
            <input
              type="date"
              value={filters.date_to || ''}
              onChange={(event) => setFilters((current) => ({ ...current, date_to: event.target.value }))}
            />
          </label>
        </div>

        <div className="admin-points-filter-actions">
          <button className="btn btn-primary" type="button" onClick={applyFilters}>应用筛选</button>
          <Link className="btn btn-secondary" href="/admin/points">打开无筛选页</Link>
        </div>
      </section>

      {error && <p className="text-red">{error}</p>}

      <section className="admin-points-layout">
        <div className="card admin-points-ledger-card">
          <div className="flex items-center justify-between mb-4" style={{ gap: 12, flexWrap: 'wrap' }}>
            <div>
              <h2 className="section-title mb-0">流水明细</h2>
              <p className="text-gray text-sm mt-2">{loading ? '加载中...' : `共 ${pagination?.total || 0} 条记录`}</p>
            </div>
          </div>

          <div className="admin-points-table-wrap">
            <table className="table admin-points-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>主体</th>
                  <th>类型</th>
                  <th>变动</th>
                  <th>余额变化</th>
                  <th>冻结变化</th>
                  <th>任务</th>
                  <th>原因</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr
                    key={record.id}
                    className={selectedRecord?.id === record.id ? 'is-selected' : ''}
                    onClick={() => setSelectedRecord(record)}
                  >
                    <td>{formatDate(record.created_at)}</td>
                    <td>
                      <div className="admin-points-subject-cell">
                        <UserIdentityBadge
                          user={recordUser(record)}
                          size="sm"
                          subtitle={userSubtitle(record.user) || record.user_id}
                        />
                      </div>
                    </td>
                    <td>{ledgerTypeLabel(record.type)}</td>
                    <td className={amountClass(record.amount)}>{record.amount > 0 ? '+' : ''}{formatNumber(record.amount)}</td>
                    <td>{formatNumber(record.balance_before)}{' -> '}{formatNumber(record.balance_after)}</td>
                    <td>{formatNumber(record.frozen_before)}{' -> '}{formatNumber(record.frozen_after)}</td>
                    <td>
                      {record.related_task_id ? (
                        <Link className="link" href={`/tasks/${record.related_task_id}?return_to=/admin/points`}>
                          {record.related_task_id.slice(0, 10)}...
                        </Link>
                      ) : '-'}
                    </td>
                    <td className="truncate" style={{ maxWidth: 260 }} title={record.reason || ''}>{record.reason || '-'}</td>
                  </tr>
                ))}
                {!loading && records.length === 0 && (
                  <tr><td colSpan={8} className="text-gray">没有匹配的点数流水。</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {pagination && (
            <PaginationControls
              page={pagination.page}
              totalPages={pagination.total_pages}
              total={pagination.total}
              pageSize={pagination.page_size}
              label="流水"
              onPageChange={(nextPage) => loadLedger(nextPage)}
            />
          )}
        </div>

        <aside className="card admin-points-detail-card">
          <h2 className="section-title">流水详情</h2>
          {selectedRecord ? (
            <div className="admin-points-detail-list">
              <div><span>流水 ID</span><strong title={selectedRecord.id}>{selectedRecord.id}</strong></div>
              <div><span>主体类型</span><strong>用户点数</strong></div>
              <div>
                <span>用户</span>
                <strong>
                  <UserIdentityBadge
                    user={recordUser(selectedRecord)}
                    size="sm"
                    subtitle={userSubtitle(selectedRecord.user) || selectedRecord.user_id}
                  />
                </strong>
              </div>
              <div><span>类型</span><strong>{ledgerTypeLabel(selectedRecord.type)}</strong></div>
              <div><span>变动</span><strong className={amountClass(selectedRecord.amount)}>{selectedRecord.amount > 0 ? '+' : ''}{formatNumber(selectedRecord.amount)}</strong></div>
              <div><span>任务</span><strong>{selectedRecord.related_task_id || '-'}</strong></div>
              <div><span>操作人</span><strong>{selectedRecord.operator_id || '-'}</strong></div>
              <div><span>原因</span><strong>{selectedRecord.reason || '-'}</strong></div>
              <div><span>metadata</span><strong>{metadataSummary(selectedRecord.metadata_json)}</strong></div>
            </div>
          ) : (
            <p className="text-gray">选择一条流水查看详情。</p>
          )}
        </aside>
      </section>
    </div>
  );
}
