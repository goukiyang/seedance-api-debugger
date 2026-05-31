import Link from 'next/link';
import { redirect } from 'next/navigation';
import PageBanner from '@/components/PageBanner';
import { getSession } from '@/lib/auth/session';
import { formatAmountMicrosWithCny, formatAmountMinorWithCny } from '@/lib/costs/currency';
import { getCostLedgerAuditSummary } from '@/lib/costs/audit';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

const BALANCE_STALE_HOURS = 24;
const BALANCE_STALE_MS = BALANCE_STALE_HOURS * 60 * 60 * 1000;

function formatCostAmount(item: {
  amount_micros?: number | null;
  amount_minor?: number | null;
  currency?: string | null;
}) {
  if (item.amount_micros !== null && item.amount_micros !== undefined) {
    return formatAmountMicrosWithCny(item.amount_micros, item.currency);
  }
  return formatAmountMinorWithCny(item.amount_minor, item.currency);
}

function formatCurrencyTotals(rows: Array<{ currency: string | null; amount_minor: number | null; amount_micros: number | null }>) {
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

  const values = Array.from(totals.values()).sort((a, b) => a.currency.localeCompare(b.currency));
  return values.length ? values.map((item) => formatCostAmount(item)).join(' · ') : '暂无官方金额';
}

function formatProviderBalance(snapshot: {
  amount_decimal: string | null;
  currency: string | null;
  quota_amount: number | null;
  quota_unit: string | null;
} | null) {
  if (!snapshot) return '未录入';
  if (snapshot.amount_decimal && snapshot.currency) {
    return formatAmountMinorWithCny(Math.round(Number(snapshot.amount_decimal) * 100), snapshot.currency);
  }
  if (snapshot.quota_amount !== null && snapshot.quota_amount !== undefined) {
    return `${snapshot.quota_amount} ${snapshot.quota_unit || 'quota'}`;
  }
  return '未识别';
}

function sourceLabel(source?: string | null) {
  if (source === 'manual') return '手动录入';
  if (source === 'provider_api') return '供应商接口';
  return '未知来源';
}

function balanceHealth(snapshot: {
  status: string;
  fetched_at: Date;
  source: string;
  error_message: string | null;
} | null) {
  if (!snapshot) {
    return {
      tone: 'warning',
      label: '未建立快照',
      detail: '先从平台后台确认余额，再在计费与成本页固化一条快照。',
    };
  }

  if (snapshot.status === 'failed') {
    return {
      tone: 'danger',
      label: '同步失败',
      detail: snapshot.error_message || '最近一次余额同步失败，需要检查接口或改用手动录入。',
    };
  }

  // 余额是运营风险信号，超过一天没有更新时不再当作实时余额展示。
  const ageMs = Date.now() - snapshot.fetched_at.getTime();
  if (ageMs > BALANCE_STALE_MS) {
    return {
      tone: 'warning',
      label: '需要更新',
      detail: `最近快照已超过 ${BALANCE_STALE_HOURS} 小时，只能作为历史参考。`,
    };
  }

  return {
    tone: 'ok',
    label: '可用',
    detail: `${sourceLabel(snapshot.source)} · ${snapshot.fetched_at.toLocaleString('zh-CN')}`,
  };
}

function taskStatusLabel(status: string) {
  if (status === 'succeeded') return '成功';
  if (status === 'failed') return '失败';
  if (status === 'cancelled') return '取消';
  if (status === 'running') return '运行中';
  if (status === 'submitted') return '已提交';
  if (status === 'queued') return '排队';
  if (status === 'draft') return '草稿';
  return status;
}

export default async function AdminPage() {
  const user = await getSession();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/generate');

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [
    providerBalanceSnapshots,
    monthOfficialRows,
    pendingCostCount,
    failedRequestCount,
    newFeedbackCount,
    activeUserCount,
    recentTasks,
    auditSummary,
  ] = await Promise.all([
    prisma.providerAccountSnapshot.findMany({
      where: { provider_name: 'seedance' },
      orderBy: { fetched_at: 'desc' },
      take: 4,
    }),
    prisma.costLedger.findMany({
      where: {
        event_type: { in: ['official_charge', 'adjustment', 'reversal'] },
        occurred_at: { gte: monthStart },
        OR: [
          { amount_minor: { not: null } },
          { amount_micros: { not: null } },
        ],
      },
      select: { amount_minor: true, amount_micros: true, currency: true },
    }),
    prisma.videoTask.count({
      where: {
        local_status: { in: ['succeeded', 'failed', 'cancelled'] },
        provider_cost_status: { notIn: ['official_confirmed', 'reconciled', 'failed_no_charge'] },
      },
    }),
    prisma.providerApiRequest.count({ where: { status: 'failed' } }),
    prisma.feedback.count({ where: { status: 'new' } }),
    prisma.user.count({ where: { status: 'active' } }),
    prisma.videoTask.findMany({
      orderBy: { created_at: 'desc' },
      take: 6,
      select: {
        id: true,
        prompt: true,
        local_status: true,
        provider_cost_status: true,
        provider_official_amount_minor: true,
        provider_official_amount_micros: true,
        provider_cost_currency: true,
        created_at: true,
        project: { select: { id: true, name: true } },
        owner: { select: { name: true, username: true } },
        user: { select: { name: true, username: true } },
      },
    }),
    getCostLedgerAuditSummary(),
  ]);

  const latestProviderBalance = providerBalanceSnapshots[0] || null;
  const balanceState = balanceHealth(latestProviderBalance);
  const providerBalanceSyncEnabled = Boolean(process.env.SEEDANCE_BALANCE_ENDPOINT?.trim());

  const overviewCards = [
    {
      label: '本月官方金额',
      value: formatCurrencyTotals(monthOfficialRows),
      detail: '来自 official_charge、adjustment、reversal 账本',
      href: '/admin/costs',
    },
    {
      label: '待确认成本',
      value: String(pendingCostCount),
      detail: '终态任务仍未官方确认或对账',
      href: '/admin/costs',
    },
    {
      label: '账本自检',
      value: auditSummary.issue_count === 0 ? '正常' : `${auditSummary.issue_count} 项`,
      detail: '总账、分摊、Provider 请求链路',
      href: '/admin/costs',
    },
    {
      label: '接口失败',
      value: String(failedRequestCount),
      detail: 'Provider 请求失败记录',
      href: '/admin/costs',
    },
    {
      label: '新反馈',
      value: String(newFeedbackCount),
      detail: '等待管理员处理的用户反馈',
      href: '/admin/feedback',
    },
    {
      label: '活跃账号',
      value: String(activeUserCount),
      detail: '当前 active 状态用户',
      href: '/admin/users',
    },
  ];

  const quickLinks = [
    { title: '计费与成本', desc: '余额快照、官方扣费、成本待办和账本自检', href: '/admin/costs' },
    { title: '用户与点数', desc: '账号、长期点数、每日配额和批量发放', href: '/admin/users' },
    { title: '项目管理', desc: '项目归属、成员、邀请和成本归集边界', href: '/admin/projects' },
    { title: '产出留存', desc: '检查被删除或隐藏的视频产出', href: '/admin/outputs' },
    { title: '接口配置', desc: 'Codex API 与外部集成状态', href: '/admin/integrations' },
    { title: '反馈管理', desc: '查看、归档和导出用户反馈', href: '/admin/feedback' },
  ];

  return (
    <div className="admin-overview-page">
      <PageBanner
        eyebrow="管理员后台"
        title="后台总览"
        description="先判断供应商余额和计费链路是否可用，再进入用户、项目和反馈管理。"
        actions={(
          <Link className="btn btn-primary" href="/admin/costs">
            查看计费与成本
          </Link>
        )}
      />

      <section className={`admin-balance-strip admin-balance-strip-${balanceState.tone}`}>
        <div className="admin-balance-primary">
          <span className="admin-overview-kicker">Seedance 供应商余额</span>
          <strong>{formatProviderBalance(latestProviderBalance)}</strong>
          <p>{balanceState.detail}</p>
        </div>
        <div className="admin-balance-meta">
          <div>
            <span>状态</span>
            <strong>{balanceState.label}</strong>
          </div>
          <div>
            <span>来源</span>
            <strong>{latestProviderBalance ? sourceLabel(latestProviderBalance.source) : '-'}</strong>
          </div>
          <div>
            <span>同步</span>
            <strong>{providerBalanceSyncEnabled ? '已配置' : '手动优先'}</strong>
          </div>
        </div>
        <Link className="btn btn-secondary" href="/admin/costs">
          更新余额
        </Link>
      </section>

      <div className="stats-grid admin-overview-stats">
        {overviewCards.map((card) => (
          <Link className="stat-card admin-overview-stat-card" href={card.href} key={card.label}>
            <span className="stat-label">{card.label}</span>
            <strong className="stat-value">{card.value}</strong>
            <span className="stat-sub">{card.detail}</span>
          </Link>
        ))}
      </div>

      <div className="admin-overview-grid">
        <section className="card admin-overview-panel">
          <div className="admin-overview-panel-head">
            <div>
              <h2 className="section-title mb-0">管理入口</h2>
              <p className="text-gray text-sm mt-2">按后台问题的处理顺序进入对应页面。</p>
            </div>
          </div>
          <div className="admin-quick-links">
            {quickLinks.map((link) => (
              <Link href={link.href} className="admin-quick-link" key={link.href}>
                <strong>{link.title}</strong>
                <span>{link.desc}</span>
              </Link>
            ))}
          </div>
        </section>

        <section className="card admin-overview-panel">
          <div className="admin-overview-panel-head">
            <div>
              <h2 className="section-title mb-0">最近任务</h2>
              <p className="text-gray text-sm mt-2">用于快速发现成本状态和项目归属异常。</p>
            </div>
            <Link className="link" href="/admin/costs">查看待办</Link>
          </div>
          {recentTasks.length === 0 ? (
            <p className="text-gray">暂无任务记录。</p>
          ) : (
            <div className="admin-recent-task-list">
              {recentTasks.map((task) => {
                const ownerName = task.owner?.name || task.owner?.username || task.user?.name || task.user?.username || '-';
                return (
                  <Link className="admin-recent-task" href={`/tasks/${task.id}`} key={task.id}>
                    <div>
                      <strong>{task.prompt || task.id}</strong>
                      <span>{ownerName} · {task.project?.name || '未归属项目'} · {task.created_at.toLocaleString('zh-CN')}</span>
                    </div>
                    <div className="admin-recent-task-meta">
                      <span>{taskStatusLabel(task.local_status)}</span>
                      <span>{task.provider_cost_status}</span>
                      <span>{formatCostAmount({
                        amount_micros: task.provider_official_amount_micros,
                        amount_minor: task.provider_official_amount_minor,
                        currency: task.provider_cost_currency,
                      })}</span>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
