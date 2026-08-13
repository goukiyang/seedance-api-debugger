import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { getCostLedgerAuditSummary } from '@/lib/costs/audit';
import PageBanner from '@/components/PageBanner';
import { TaskVideoThumbnail } from '@/components/TaskVideoThumbnail';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import {
  formatAmountMicrosWithFixedCny,
  formatAmountMinorWithFixedCny,
  formatCurrencyAmountWithFixedCny,
  usdToCnyRateText,
} from '@/lib/costs/currency';
import { taskDetailHref } from '@/lib/navigation/return-to';
import OfficialChargeForm from './OfficialChargeForm';
import OfficialChargeImportForm from './OfficialChargeImportForm';
import ProviderBalancePanel from './ProviderBalancePanel';

export const dynamic = 'force-dynamic';

const COST_SOURCE_FILTERS = [
  { value: 'all', label: '全部来源', hint: '所有网页、外部 API 和无线画布任务' },
  { value: 'ultimate_canvas', label: '无线画布', hint: '只看新无线画布产生的任务成本' },
  { value: 'web', label: '普通网页', hint: '普通生成页和站内页面任务' },
  { value: 'codex_api', label: '外部 API', hint: '外部接入接口创建的任务' },
] as const;

type CostSourceFilter = typeof COST_SOURCE_FILTERS[number]['value'];

type TaskSourceFields = {
  source_type?: string | null;
  source_label?: string | null;
  source_metadata_json?: string | null;
};

type SourceInfo = {
  key: 'ultimate_canvas' | 'codex_api' | 'web' | 'unknown';
  label: string;
};

function formatAmountMinor(amount: number | null | undefined, currency?: string | null) {
  return formatAmountMinorWithFixedCny(amount, currency);
}

function formatAmountMicros(amount: number | null | undefined, currency?: string | null) {
  return formatAmountMicrosWithFixedCny(amount, currency);
}

function formatCostAmount(item: {
  amount_micros?: number | null;
  amount_minor?: number | null;
  currency?: string | null;
}) {
  if (item.amount_micros !== null && item.amount_micros !== undefined) {
    return formatAmountMicros(item.amount_micros, item.currency);
  }
  return formatAmountMinor(item.amount_minor, item.currency);
}

function costStatusLabel(status: string) {
  if (status === 'estimated_by_rule') return '规则预估';
  if (status === 'provisional_settled') return '临时结算';
  if (status === 'official_confirmed') return '官方确认';
  if (status === 'reconciled') return '已对账';
  if (status === 'failed_no_charge') return '失败未收费';
  if (status === 'unknown') return '待确认';
  if (status === 'disputed') return '异常';
  return '未记录';
}

function taskOwnerUser(task: {
  owner?: { id?: string; name: string | null; username: string | null; email?: string | null; avatar_url?: string | null; account_type?: string | null } | null;
  user?: { id?: string; name: string | null; username: string | null; email?: string | null; avatar_url?: string | null; account_type?: string | null } | null;
}) {
  return task.owner || task.user || null;
}

function formatCurrencyTotals(totals: Array<{ currency: string; amount_minor: number; amount_micros?: number }>) {
  if (totals.length === 0) return '待官方确认';
  return totals.map((item) => formatCostAmount(item)).join(' · ');
}

function sumCostRowsByCurrency(rows: Array<{ amount_minor: number | null; amount_micros: number | null; currency: string | null }>) {
  const totals = new Map<string, { currency: string; amount_minor: number; amount_micros: number }>();
  rows.forEach((row) => {
    if (row.amount_micros === null && row.amount_minor === null) return;
    const currency = row.currency || 'UNKNOWN';
    const amountMicros = row.amount_micros ?? (row.amount_minor as number) * 10_000;
    const existing = totals.get(currency) || { currency, amount_minor: 0, amount_micros: 0 };
    existing.amount_micros += amountMicros;
    existing.amount_minor += Math.round(amountMicros / 10_000);
    totals.set(currency, existing);
  });
  return Array.from(totals.values()).sort((a, b) => a.currency.localeCompare(b.currency));
}

function auditStatusText(count: number) {
  return count === 0 ? '正常' : `${count} 条`;
}

function providerBalanceSnapshotDto(snapshot: {
  id: string;
  provider_name: string;
  provider_account_id: string | null;
  balance_kind: string;
  amount_decimal: string | null;
  amount_minor: number | null;
  currency: string | null;
  quota_amount: number | null;
  quota_unit: string | null;
  source: string;
  status: string;
  note: string | null;
  error_message: string | null;
  fetched_at: Date;
  created_at: Date;
}) {
  return {
    ...snapshot,
    fetched_at: snapshot.fetched_at.toISOString(),
    created_at: snapshot.created_at.toISOString(),
  };
}

function formatProviderBalanceAmount(snapshot: ReturnType<typeof providerBalanceSnapshotDto> | null) {
  if (!snapshot) return '未录入';
  if (snapshot.amount_decimal && snapshot.currency) {
    return formatCurrencyAmountWithFixedCny(Number(snapshot.amount_decimal), snapshot.currency);
  }
  if (snapshot.quota_amount !== null && snapshot.quota_amount !== undefined) {
    return `${snapshot.quota_amount} ${snapshot.quota_unit || 'quota'}`;
  }
  return '未识别';
}

function providerBalanceHint(snapshot: ReturnType<typeof providerBalanceSnapshotDto> | null, syncEnabled: boolean) {
  if (!snapshot) return syncEnabled ? '可从供应商拉取或手动固化' : '下方手动录入余额后会显示在这里';
  if (snapshot.status === 'failed') return '最近一次拉取失败，请检查余额接口';
  const source = snapshot.source === 'manual' ? '手动记录' : '供应商接口';
  return `${source} · ${new Date(snapshot.fetched_at).toLocaleString('zh-CN')}`;
}

function budgetRiskLabel(committedRatio: number, budgetCredits: number) {
  if (budgetCredits <= 0) return '未设置';
  if (committedRatio >= 1) return '已用尽';
  if (committedRatio >= 0.9) return '高风险';
  if (committedRatio >= 0.7) return '需关注';
  return '正常';
}

function formatPoint(value: number | null | undefined) {
  const amount = Number(value || 0);
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}

function firstSearchParam(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

function normalizeSourceFilter(value: string | string[] | undefined): CostSourceFilter {
  const raw = firstSearchParam(value).trim();
  return COST_SOURCE_FILTERS.some((item) => item.value === raw) ? raw as CostSourceFilter : 'all';
}

function sourceFilterHref(source: CostSourceFilter) {
  return source === 'all' ? '/admin/costs' : `/admin/costs?source=${source}`;
}

function sourcePointsHref(source: CostSourceFilter) {
  return source === 'all' ? '/admin/points' : `/admin/points?source=${source}`;
}

function selectedSourceFilterLabel(source: CostSourceFilter) {
  return COST_SOURCE_FILTERS.find((item) => item.value === source)?.label || '全部来源';
}

function parseSourceMetadata(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function taskSourceInfo(task: TaskSourceFields | null | undefined): SourceInfo {
  if (!task) return { key: 'unknown', label: '-' };

  const metadata = parseSourceMetadata(task.source_metadata_json);
  const source = typeof metadata?.source === 'string' ? metadata.source : '';
  const sourceLabel = typeof metadata?.source_label === 'string' ? metadata.source_label : '';

  if (source === 'ultimate_canvas' || task.source_label === '无线画布') {
    return { key: 'ultimate_canvas', label: sourceLabel || task.source_label || '无线画布' };
  }
  if (task.source_type === 'codex_api') {
    return { key: 'codex_api', label: task.source_label || '外部 API' };
  }
  if (task.source_type === 'web') {
    return { key: 'web', label: task.source_label || '普通网页' };
  }
  return { key: 'unknown', label: task.source_label || task.source_type || '-' };
}

function SourceBadge({ source }: { source: SourceInfo }) {
  return (
    <span className={`admin-points-source-badge source-${source.key}`}>
      {source.label}
    </span>
  );
}

function ultimateCanvasTaskWhere(): Prisma.VideoTaskWhereInput {
  return {
    OR: [
      { source_label: '无线画布' },
      { source_metadata_json: { contains: '"source":"ultimate_canvas"' } },
      { source_metadata_json: { contains: '"source": "ultimate_canvas"' } },
    ],
  };
}

function videoTaskSourceWhere(source: CostSourceFilter): Prisma.VideoTaskWhereInput | null {
  if (source === 'all') return null;
  if (source === 'ultimate_canvas') return ultimateCanvasTaskWhere();
  if (source === 'codex_api') return { source_type: 'codex_api' };
  return {
    AND: [
      { source_type: 'web' },
      { NOT: ultimateCanvasTaskWhere() },
    ],
  };
}

function costLedgerSourceWhere(source: CostSourceFilter): Prisma.CostLedgerWhereInput | null {
  const taskWhere = videoTaskSourceWhere(source);
  return taskWhere ? { task: { is: taskWhere } } : null;
}

function combineVideoTaskWhere(
  ...whereList: Array<Prisma.VideoTaskWhereInput | null | undefined>
): Prisma.VideoTaskWhereInput {
  const filters = whereList.filter(Boolean) as Prisma.VideoTaskWhereInput[];
  if (filters.length === 0) return {};
  if (filters.length === 1) return filters[0];
  return { AND: filters };
}

function combineCostLedgerWhere(
  ...whereList: Array<Prisma.CostLedgerWhereInput | null | undefined>
): Prisma.CostLedgerWhereInput {
  const filters = whereList.filter(Boolean) as Prisma.CostLedgerWhereInput[];
  if (filters.length === 0) return {};
  if (filters.length === 1) return filters[0];
  return { AND: filters };
}

export default async function AdminCostsPage({
  searchParams,
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const user = await getSession();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/generate');

  const sourceFilter = normalizeSourceFilter(searchParams?.source);
  const taskSourceFilter = videoTaskSourceWhere(sourceFilter);
  const ledgerSourceFilter = costLedgerSourceWhere(sourceFilter);
  const recentIssueBaseWhere: Prisma.VideoTaskWhereInput = {
    OR: [
      {
        local_status: { in: ['succeeded', 'failed', 'cancelled'] },
        provider_cost_status: { notIn: ['official_confirmed', 'reconciled', 'failed_no_charge'] },
      },
      { provider_cost_status: { in: ['unknown', 'disputed'] } },
      { project_id: null },
    ],
  };
  const recentIssueWhere = combineVideoTaskWhere(recentIssueBaseWhere, taskSourceFilter);
  const recentLedgerWhere = combineCostLedgerWhere(ledgerSourceFilter);

  const [
    taskCount,
    terminalTaskCount,
    officialPendingCount,
    unknownCostCount,
    failedPossibleChargeCount,
    unallocatedCount,
    officialCostRows,
    recentIssues,
    failedRequests,
    auditSummary,
    providerBalanceSnapshots,
    publicProjectBudgets,
    sourceTaskCount,
    sourceLedgerCount,
    sourceRecentLedgers,
  ] = await Promise.all([
    prisma.videoTask.count(),
    prisma.videoTask.count({ where: { local_status: { in: ['succeeded', 'failed', 'cancelled'] } } }),
    prisma.videoTask.count({
      where: {
        local_status: { in: ['succeeded', 'failed', 'cancelled'] },
        provider_cost_status: { notIn: ['official_confirmed', 'reconciled', 'failed_no_charge'] },
      },
    }),
    prisma.videoTask.count({ where: { provider_cost_status: { in: ['unknown', 'disputed'] } } }),
    prisma.videoTask.count({
      where: {
        local_status: { in: ['failed', 'cancelled'] },
        provider_task_id: { not: null },
        provider_cost_status: { not: 'failed_no_charge' },
      },
    }),
    prisma.costAllocation.count({ where: { allocation_type: 'unallocated' } }),
    prisma.costLedger.findMany({
      where: {
        event_type: { in: ['official_charge', 'adjustment', 'reversal'] },
        OR: [
          { amount_minor: { not: null } },
          { amount_micros: { not: null } },
        ],
      },
      select: { amount_minor: true, amount_micros: true, currency: true },
    }),
    prisma.videoTask.findMany({
      where: recentIssueWhere,
      orderBy: { created_at: 'desc' },
      take: 20,
      select: {
        id: true,
        prompt: true,
        source_type: true,
        source_label: true,
        source_metadata_json: true,
        provider: true,
	        generation_mode: true,
	        local_status: true,
	        public_video_url: true,
	        result_video_url: true,
	        result_last_frame_url: true,
	        local_video_path: true,
	        estimated_cost: true,
        actual_cost: true,
        provider_task_id: true,
        provider_cost_status: true,
        provider_official_amount_minor: true,
        provider_official_amount_micros: true,
        provider_cost_currency: true,
        created_at: true,
        project: { select: { id: true, name: true } },
        owner: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
        user: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
      },
    }),
    prisma.providerApiRequest.findMany({
      where: { status: 'failed' },
      orderBy: { created_at: 'desc' },
      take: 10,
      select: {
        id: true,
        task_id: true,
        provider_name: true,
        endpoint: true,
        error_message: true,
        created_at: true,
        project: { select: { id: true, name: true } },
      },
    }),
    getCostLedgerAuditSummary(),
    prisma.providerAccountSnapshot.findMany({
      where: { provider_name: 'seedance' },
      orderBy: { fetched_at: 'desc' },
      take: 10,
    }),
    prisma.project.findMany({
      where: { type: 'public', status: { not: 'deleted' } },
      orderBy: { updated_at: 'desc' },
      take: 50,
      select: {
        id: true,
        name: true,
        status: true,
        owner: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
        budget_account: true,
        _count: { select: { tasks: true, video_cards: true } },
      },
    }),
    prisma.videoTask.count({ where: taskSourceFilter || {} }),
    prisma.costLedger.count({ where: recentLedgerWhere }),
    prisma.costLedger.findMany({
      where: recentLedgerWhere,
      orderBy: [{ occurred_at: 'desc' }, { created_at: 'desc' }],
      take: 20,
      select: {
        id: true,
        task_id: true,
        project_id: true,
        event_type: true,
        amount_minor: true,
        amount_micros: true,
        currency: true,
        confidence: true,
        cost_source: true,
        occurred_at: true,
        project: { select: { name: true } },
        task: {
          select: {
            prompt: true,
            source_type: true,
            source_label: true,
            source_metadata_json: true,
          },
        },
      },
    }),
  ]);
  const officialCostTotals = sumCostRowsByCurrency(officialCostRows);
  const providerBalanceViews = providerBalanceSnapshots.map(providerBalanceSnapshotDto);
  const latestProviderBalance = providerBalanceViews[0] || null;
  const providerBalanceSyncEnabled = Boolean(process.env.SEEDANCE_BALANCE_ENDPOINT?.trim());

  const auditChecks = [
    {
      label: '有金额账本缺少分摊',
      count: auditSummary.amount_ledgers_without_allocation_count,
      detail: '任何已经有真实金额的总账行，都应该能归属到项目、用户、任务或未归属池。',
    },
    {
      label: '终态任务缺少成本账本',
      count: auditSummary.terminal_tasks_without_cost_ledger_count,
      detail: '成功、失败或取消后的任务，应至少有一条成本结算或失败成本状态账本。',
    },
    {
      label: '官方确认任务缺少官方账本',
      count: auditSummary.official_confirmed_tasks_without_charge_ledger_count,
      detail: '任务状态显示官方确认时，必须能追溯到 official_charge 账本行。',
    },
    {
      label: 'Provider 接受但无官方任务 ID',
      count: auditSummary.accepted_requests_without_provider_task_count,
      detail: '外部请求已 accepted 却没有 provider_task_id，后续对账会很难匹配。',
    },
    {
      label: 'Provider 请求长时间 pending',
      count: auditSummary.stale_pending_provider_request_count,
      detail: '超过 30 分钟仍 pending 的请求需要确认是否超时、失败或漏更新。',
    },
    {
      label: '重复 provider_task_id',
      count: auditSummary.duplicate_provider_task_ids.length,
      detail: '同一个官方任务 ID 不应同时挂到多个内部任务，除非明确是历史脏数据。',
    },
  ];

  return (
    <div>
      <PageBanner
        eyebrow="管理员后台"
        title="计费与成本复盘"
        description="余额看供应商账户是否还能继续生成，成本看任务、项目和官方扣费能否闭环对账。"
        actions={(
          <>
            <Link className="btn btn-secondary" href="/admin">
              返回后台总览
            </Link>
            <Link className="btn btn-secondary" href="/admin/points">
              点数账本
            </Link>
            <Link className="btn btn-secondary" href="/api/admin/costs/export">
              导出总账 CSV
            </Link>
          </>
        )}
      />

      <div className="card">
        <div className="flex items-center justify-between mb-4" style={{ gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h2 className="section-title mb-0">来源筛选</h2>
            <p className="text-gray text-sm mt-2">当前成本页按任务来源查看待处理队列和最近总账，方便核对无线画布、外部 API 和普通网页是否进入同一套账本。</p>
          </div>
          <Link className="btn btn-secondary" href={sourcePointsHref(sourceFilter)}>
            查看同来源点数流水
          </Link>
        </div>
        <div className="outputs-filter-row" aria-label="成本来源筛选">
          {COST_SOURCE_FILTERS.map((item) => (
            <Link
              key={item.value}
              className={`outputs-filter-chip${sourceFilter === item.value ? ' is-active' : ''}`}
              href={sourceFilterHref(item.value)}
              title={item.hint}
              style={{ alignItems: 'center', display: 'inline-flex', textDecoration: 'none' }}
            >
              {item.label}
            </Link>
          ))}
        </div>
        <p className="form-hint mt-4">
          当前：{selectedSourceFilterLabel(sourceFilter)} · 任务 {sourceTaskCount} · 成本账本 {sourceLedgerCount}
        </p>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <span className="stat-label">任务总数</span>
          <strong className="stat-value">{taskCount}</strong>
          <span className="stat-sub">已结束 {terminalTaskCount}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">官方成本</span>
          <strong className="stat-value">{formatCurrencyTotals(officialCostTotals)}</strong>
          <span className="stat-sub">USD 折人民币按 {usdToCnyRateText()}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">供应商余额</span>
          <strong className="stat-value">{formatProviderBalanceAmount(latestProviderBalance)}</strong>
          <span className="stat-sub">{providerBalanceHint(latestProviderBalance, providerBalanceSyncEnabled)}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">待确认成本</span>
          <strong className="stat-value">{officialPendingCount}</strong>
          <span className="stat-sub">任务已结束但未官方确认</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">异常待办</span>
          <strong className="stat-value">{unknownCostCount + failedPossibleChargeCount + unallocatedCount}</strong>
          <span className="stat-sub">未归属 {unallocatedCount} · 失败待判 {failedPossibleChargeCount}</span>
        </div>
      </div>

      <ProviderBalancePanel
        latest={latestProviderBalance}
        snapshots={providerBalanceViews}
        syncEnabled={providerBalanceSyncEnabled}
      />

      <div className="card" id="public-project-budgets">
        <div className="flex items-center justify-between mb-4" style={{ gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h2 className="section-title mb-0">公共项目预算</h2>
            <p className="text-gray text-sm mt-2">公共项目生成会优先冻结项目预算池，成功后实扣，失败或取消后释放。</p>
          </div>
          <span className="text-gray text-sm">{publicProjectBudgets.length} 个公共项目</span>
        </div>
        {publicProjectBudgets.length === 0 ? (
          <p className="text-gray">暂无公共项目。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>项目</th>
                <th>负责人</th>
                <th>预算</th>
                <th>已用</th>
                <th>冻结</th>
                <th>剩余</th>
                <th>风险</th>
                <th>任务 / 视频卡</th>
              </tr>
            </thead>
            <tbody>
              {publicProjectBudgets.map((project) => {
                const account = project.budget_account;
                const budgetCredits = account?.budget_credits || 0;
                const usedCredits = account?.used_credits || 0;
                const frozenCredits = account?.frozen_credits || 0;
                const availableCredits = Math.max(0, budgetCredits - usedCredits - frozenCredits);
                const committedRatio = budgetCredits > 0 ? (usedCredits + frozenCredits) / budgetCredits : 0;
                return (
                  <tr key={project.id}>
                    <td><Link className="link" href={`/projects/${project.id}`}>{project.name}</Link></td>
                    <td><UserIdentityBadge user={project.owner} size="sm" /></td>
                    <td>{formatPoint(budgetCredits)}</td>
                    <td>{formatPoint(usedCredits)}</td>
                    <td>{formatPoint(frozenCredits)}</td>
                    <td>{formatPoint(availableCredits)}</td>
                    <td>{budgetRiskLabel(committedRatio, budgetCredits)}</td>
                    <td>{project._count.tasks} / {project._count.video_cards}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="card" id="audit-checks">
        <div className="flex items-center justify-between mb-4" style={{ gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h2 className="section-title mb-0">账本自检</h2>
            <p className="text-gray text-sm mt-2">用于确认总账、分摊、任务状态和 Provider 请求之间没有断链。</p>
          </div>
          <span className={auditSummary.issue_count === 0 ? 'text-green' : 'text-red'}>
            {auditSummary.issue_count === 0 ? '自检通过' : `发现 ${auditSummary.issue_count} 项待处理`}
          </span>
        </div>

        <div className="stats-grid">
          <div className="stat-card">
            <span className="stat-label">总账 / 分摊</span>
            <strong className="stat-value">{auditSummary.ledger_count}</strong>
            <span className="stat-sub">分摊行 {auditSummary.allocation_count}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">官方入账</span>
            <strong className="stat-value">{auditSummary.official_charge_count}</strong>
            <span className="stat-sub">{formatCurrencyTotals(auditSummary.official_ledger_totals)}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">官方分摊</span>
            <strong className="stat-value">{formatCurrencyTotals(auditSummary.official_allocation_totals)}</strong>
            <span className="stat-sub">按 official_charge 的分摊行统计</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">成本状态</span>
            <strong className="stat-value">{auditSummary.provider_cost_status_counts.length}</strong>
            <span className="stat-sub">
              {auditSummary.provider_cost_status_counts.slice(0, 3).map((item) => `${costStatusLabel(item.status)} ${item.count}`).join(' · ') || '暂无任务'}
            </span>
          </div>
        </div>

        <table className="table">
          <thead>
            <tr>
              <th>检查项</th>
              <th>结果</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            {auditChecks.map((check) => (
              <tr key={check.label}>
                <td>{check.label}</td>
                <td className={check.count === 0 ? 'text-green' : 'text-red'}>{auditStatusText(check.count)}</td>
                <td className="text-gray">{check.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {auditSummary.duplicate_provider_task_ids.length > 0 && (
          <p className="form-hint mt-4">
            重复官方任务 ID：{auditSummary.duplicate_provider_task_ids.map((item) => `${item.provider_task_id} × ${item.count}`).join('；')}
          </p>
        )}
      </div>

      <OfficialChargeForm
        pendingTasks={recentIssues.map((task) => ({
          id: task.id,
          prompt: task.prompt || task.id,
          provider_task_id: task.provider_task_id,
        }))}
      />

      <OfficialChargeImportForm />

      <div className="card" id="pending-costs">
        <h2 className="section-title">待处理队列</h2>
        {recentIssues.length === 0 ? (
          <p className="text-gray">当前没有成本待办。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
	                <th>截图</th>
	                <th>任务</th>
                <th>来源</th>
                <th>项目</th>
                <th>创建者</th>
                <th>状态</th>
                <th>点数</th>
                <th>成本状态</th>
                <th>官方成本</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {recentIssues.map((task) => (
	                <tr key={task.id}>
	                  <td>
	                    <TaskVideoThumbnail
	                      taskId={task.id}
	                      publicVideoUrl={task.public_video_url}
	                      localVideoPath={task.local_video_path}
	                      resultVideoUrl={task.result_video_url}
	                      resultLastFrameUrl={task.result_last_frame_url}
	                      status={task.local_status}
	                      provider={task.provider}
	                      generationMode={task.generation_mode}
	                      href={taskDetailHref(task.id, '/admin/costs')}
	                      size="compact"
	                    />
	                  </td>
	                  <td className="truncate" style={{ maxWidth: 300 }} title={task.prompt}>
	                    <Link className="link" href={taskDetailHref(task.id, '/admin/costs')}>{task.prompt || task.id}</Link>
	                  </td>
                  <td><SourceBadge source={taskSourceInfo(task)} /></td>
                  <td>
                    {task.project ? (
                      <Link className="link" href={`/projects/${task.project.id}`}>{task.project.name}</Link>
                    ) : (
                      <span className="text-red">未归属</span>
                    )}
                  </td>
                  <td><UserIdentityBadge user={taskOwnerUser(task)} size="sm" /></td>
                  <td>{task.local_status}</td>
                  <td>{task.actual_cost ?? task.estimated_cost ?? '-'}</td>
                  <td>{costStatusLabel(task.provider_cost_status)}</td>
                  <td>{formatCostAmount({
                    amount_micros: task.provider_official_amount_micros,
                    amount_minor: task.provider_official_amount_minor,
                    currency: task.provider_cost_currency,
                  })}</td>
                  <td><Link className="link" href={taskDetailHref(task.id, '/admin/costs')}>详情</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card" id="provider-errors">
        <h2 className="section-title">Provider 请求异常</h2>
        {failedRequests.length === 0 ? (
          <p className="text-gray">暂无失败的外部请求记录。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>时间</th>
                <th>Provider</th>
                <th>项目</th>
                <th>任务</th>
                <th>错误</th>
              </tr>
            </thead>
            <tbody>
              {failedRequests.map((request) => (
                <tr key={request.id}>
                  <td>{new Date(request.created_at).toLocaleString('zh-CN')}</td>
                  <td>{request.provider_name}</td>
                  <td>{request.project ? <Link className="link" href={`/projects/${request.project.id}`}>{request.project.name}</Link> : '-'}</td>
                  <td>{request.task_id ? <Link className="link" href={taskDetailHref(request.task_id, '/admin/costs')}>{request.task_id.slice(0, 10)}...</Link> : '-'}</td>
                  <td className="truncate" style={{ maxWidth: 360 }} title={request.error_message || ''}>{request.error_message || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-4" style={{ gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h2 className="section-title mb-0">最近总账</h2>
            <p className="text-gray text-sm mt-2">按上方来源筛选后的成本账本；“无线画布”会直接从关联任务的来源 metadata 中识别。</p>
          </div>
          <span className="text-gray text-sm">{selectedSourceFilterLabel(sourceFilter)}</span>
        </div>
        {sourceRecentLedgers.length === 0 ? (
          <p className="text-gray">暂无总账记录。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>时间</th>
                <th>事件</th>
                <th>来源</th>
                <th>项目</th>
                <th>任务</th>
                <th>金额</th>
                <th>置信度</th>
              </tr>
            </thead>
            <tbody>
              {sourceRecentLedgers.map((ledger) => (
                <tr key={ledger.id}>
                  <td>{new Date(ledger.occurred_at).toLocaleString('zh-CN')}</td>
                  <td>{ledger.event_type}</td>
                  <td><SourceBadge source={taskSourceInfo(ledger.task)} /></td>
                  <td>{ledger.project ? <Link className="link" href={`/projects/${ledger.project_id}`}>{ledger.project.name}</Link> : '-'}</td>
                  <td className="truncate" style={{ maxWidth: 320 }}>
                    {ledger.task_id ? <Link className="link" href={taskDetailHref(ledger.task_id, '/admin/costs')}>{ledger.task?.prompt || ledger.task_id}</Link> : '-'}
                  </td>
                  <td>{formatCostAmount(ledger)}</td>
                  <td>{ledger.confidence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
