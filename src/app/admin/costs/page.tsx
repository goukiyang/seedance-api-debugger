import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { getCostLedgerAuditSummary } from '@/lib/costs/audit';
import OfficialChargeForm from './OfficialChargeForm';
import OfficialChargeImportForm from './OfficialChargeImportForm';

export const dynamic = 'force-dynamic';

function formatAmountMinor(amount: number | null | undefined, currency?: string | null) {
  if (amount === null || amount === undefined) return '待官方确认';
  const value = amount / 100;
  if (currency === 'USD') return `$${value.toFixed(2)}`;
  return `¥${value.toFixed(2)}`;
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

function taskOwnerLabel(task: {
  owner?: { name: string; username: string } | null;
  user?: { name: string; username: string } | null;
}) {
  return task.owner?.name || task.owner?.username || task.user?.name || task.user?.username || '-';
}

function formatCurrencyTotals(totals: Array<{ currency: string; amount_minor: number }>) {
  if (totals.length === 0) return '待官方确认';
  return totals.map((item) => formatAmountMinor(item.amount_minor, item.currency)).join(' · ');
}

function auditStatusText(count: number) {
  return count === 0 ? '正常' : `${count} 条`;
}

export default async function AdminCostsPage() {
  const user = await getSession();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/generate');

  const [
    taskCount,
    terminalTaskCount,
    officialPendingCount,
    unknownCostCount,
    failedPossibleChargeCount,
    unallocatedCount,
    officialCostTotals,
    recentIssues,
    failedRequests,
    auditSummary,
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
    prisma.costLedger.aggregate({
      where: {
        event_type: { in: ['official_charge', 'adjustment', 'reversal'] },
        amount_minor: { not: null },
      },
      _sum: { amount_minor: true },
    }),
    prisma.videoTask.findMany({
      where: {
        OR: [
          {
            local_status: { in: ['succeeded', 'failed', 'cancelled'] },
            provider_cost_status: { notIn: ['official_confirmed', 'reconciled', 'failed_no_charge'] },
          },
          { provider_cost_status: { in: ['unknown', 'disputed'] } },
          { project_id: null },
        ],
      },
      orderBy: { created_at: 'desc' },
      take: 20,
      select: {
        id: true,
        prompt: true,
        local_status: true,
        estimated_cost: true,
        actual_cost: true,
        provider_task_id: true,
        provider_cost_status: true,
        provider_official_amount_minor: true,
        provider_cost_currency: true,
        created_at: true,
        project: { select: { id: true, name: true } },
        owner: { select: { name: true, username: true } },
        user: { select: { name: true, username: true } },
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
  ]);

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
      <div className="page-header">
        <div className="flex items-center justify-between" style={{ gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h1 className="page-title">成本复盘</h1>
            <p className="page-description">先看待确认和异常，再回到项目复盘。官方实际扣费接入后会进入这里对账。</p>
          </div>
          <Link className="btn btn-secondary" href="/api/admin/costs/export">
            导出总账 CSV
          </Link>
        </div>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <span className="stat-label">任务总数</span>
          <strong className="stat-value">{taskCount}</strong>
          <span className="stat-sub">已结束 {terminalTaskCount}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">官方成本</span>
          <strong className="stat-value">{formatAmountMinor(officialCostTotals._sum.amount_minor, 'CNY')}</strong>
          <span className="stat-sub">未接官方扣费时显示待确认</span>
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

      <div className="card">
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

      <div className="card">
        <h2 className="section-title">待处理队列</h2>
        {recentIssues.length === 0 ? (
          <p className="text-gray">当前没有成本待办。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>任务</th>
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
                  <td className="truncate" style={{ maxWidth: 300 }} title={task.prompt}>
                    {task.prompt || task.id}
                  </td>
                  <td>
                    {task.project ? (
                      <Link className="link" href={`/projects/${task.project.id}`}>{task.project.name}</Link>
                    ) : (
                      <span className="text-red">未归属</span>
                    )}
                  </td>
                  <td>{taskOwnerLabel(task)}</td>
                  <td>{task.local_status}</td>
                  <td>{task.actual_cost ?? task.estimated_cost ?? '-'}</td>
                  <td>{costStatusLabel(task.provider_cost_status)}</td>
                  <td>{formatAmountMinor(task.provider_official_amount_minor, task.provider_cost_currency)}</td>
                  <td><Link className="link" href={`/tasks/${task.id}`}>详情</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
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
                  <td>{request.task_id ? <Link className="link" href={`/tasks/${request.task_id}`}>{request.task_id.slice(0, 10)}...</Link> : '-'}</td>
                  <td className="truncate" style={{ maxWidth: 360 }} title={request.error_message || ''}>{request.error_message || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2 className="section-title">最近总账</h2>
        {auditSummary.recent_ledgers.length === 0 ? (
          <p className="text-gray">暂无总账记录。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>时间</th>
                <th>事件</th>
                <th>项目</th>
                <th>任务</th>
                <th>金额</th>
                <th>置信度</th>
              </tr>
            </thead>
            <tbody>
              {auditSummary.recent_ledgers.map((ledger) => (
                <tr key={ledger.id}>
                  <td>{new Date(ledger.occurred_at).toLocaleString('zh-CN')}</td>
                  <td>{ledger.event_type}</td>
                  <td>{ledger.project ? <Link className="link" href={`/projects/${ledger.project_id}`}>{ledger.project.name}</Link> : '-'}</td>
                  <td className="truncate" style={{ maxWidth: 320 }}>
                    {ledger.task_id ? <Link className="link" href={`/tasks/${ledger.task_id}`}>{ledger.task?.prompt || ledger.task_id}</Link> : '-'}
                  </td>
                  <td>{formatAmountMinor(ledger.amount_minor, ledger.currency)}</td>
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
