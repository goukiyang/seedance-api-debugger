import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
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
  ]);

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">成本复盘</h1>
        <p className="page-description">先看待确认和异常，再回到项目复盘。官方实际扣费接入后会进入这里对账。</p>
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
    </div>
  );
}
