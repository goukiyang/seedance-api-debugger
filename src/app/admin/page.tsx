import Link from 'next/link';
import { redirect } from 'next/navigation';
import PageBanner from '@/components/PageBanner';
import AdminGenerationDashboardClient from './AdminGenerationDashboardClient';
import { getSession } from '@/lib/auth/session';
import { formatCurrencyAmountWithFixedCny } from '@/lib/costs/currency';
import { getGenerationDashboardData } from '@/lib/admin/generation-dashboard';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

const BALANCE_STALE_HOURS = 24;
const BALANCE_STALE_MS = BALANCE_STALE_HOURS * 60 * 60 * 1000;

function formatProviderBalance(snapshot: {
  amount_decimal: string | null;
  currency: string | null;
  quota_amount: number | null;
  quota_unit: string | null;
} | null) {
  if (!snapshot) return '未录入';
  if (snapshot.amount_decimal && snapshot.currency) {
    return formatCurrencyAmountWithFixedCny(Number(snapshot.amount_decimal), snapshot.currency);
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

export default async function AdminPage() {
  const user = await getSession();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/generate');

  const [dashboard, latestProviderBalance] = await Promise.all([
    getGenerationDashboardData({ range: 'month' }),
    prisma.providerAccountSnapshot.findFirst({
      where: { provider_name: 'seedance' },
      orderBy: { fetched_at: 'desc' },
    }),
  ]);

  const balanceState = balanceHealth(latestProviderBalance);
  const providerBalanceSyncEnabled = Boolean(process.env.SEEDANCE_BALANCE_ENDPOINT?.trim());
  const quickLinks = [
    { title: '计费与成本', desc: '余额快照、官方扣费、成本待办和账本自检', href: '/admin/costs' },
    { title: '产出留存', desc: '检查预览、隐藏/恢复和任务归属追溯', href: '/admin/outputs' },
    { title: '用户与点数', desc: '账号、长期点数、每日配额和批量发放', href: '/admin/users' },
    { title: '点数流水', desc: '按用户、任务、类型和时间范围追溯点数账本', href: '/admin/points' },
    { title: '项目管理', desc: '项目归属、成员、邀请和成本归集边界', href: '/admin/projects' },
    { title: '接口配置', desc: 'Codex API 与外部集成状态', href: '/admin/integrations' },
    { title: '反馈管理', desc: '查看、归档和导出用户反馈', href: '/admin/feedback' },
  ];

  return (
    <div className="admin-overview-page">
      <PageBanner
        eyebrow="管理员后台"
        title="视频生成成本与产能驾驶舱"
        description="先看生成量、官方成本、清晰度消耗和异常待办，再进入产出、成本、项目和用户明细处理。"
        actions={(
          <>
            <Link className="btn btn-secondary" href="/admin/outputs">
              查看产出明细
            </Link>
            <Link className="btn btn-primary" href="/admin/costs">
              处理成本异常
            </Link>
          </>
        )}
      />

      <AdminGenerationDashboardClient
        initialDashboard={dashboard}
        providerBalance={{
          amount: formatProviderBalance(latestProviderBalance),
          label: balanceState.label,
          detail: balanceState.detail,
          source: latestProviderBalance ? sourceLabel(latestProviderBalance.source) : '-',
          sync: providerBalanceSyncEnabled ? '已配置' : '手动优先',
          tone: balanceState.tone,
        }}
        quickLinks={quickLinks}
      />
    </div>
  );
}
