import Link from 'next/link';
import { redirect } from 'next/navigation';
import AdminUsageClient from '@/components/admin-usage/AdminUsageClient';
import AdminGenerationDashboardClient from './AdminGenerationDashboardClient';
import { getSession } from '@/lib/auth/session';
import { formatCurrencyAmountWithFixedCny } from '@/lib/costs/currency';
import { getGenerationDashboardData } from '@/lib/admin/generation-dashboard';
import { prisma } from '@/lib/prisma';
import { adminExceptionLinks, adminNavGroups } from '@/lib/navigation';

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
    getGenerationDashboardData({ range: 'all' }),
    prisma.providerAccountSnapshot.findFirst({
      where: { provider_name: 'seedance' },
      orderBy: { fetched_at: 'desc' },
    }),
  ]);

  const balanceState = balanceHealth(latestProviderBalance);
  const providerBalanceSyncEnabled = Boolean(process.env.SEEDANCE_BALANCE_ENDPOINT?.trim());
  const quickLinks = adminNavGroups.map(group => ({ title: group.title, desc: '',
    links: group.items.map(item => ({ title: item.label, desc: '', href: item.href })),
  }));
  const supportLinks = [
    { label: '视频生成失败', href: adminExceptionLinks.videoFailed },
    { label: '图片生成失败', href: adminExceptionLinks.imageFailed },
    { label: '视频费用待核', href: adminExceptionLinks.videoCostPending },
    { label: '视频费用冲突', href: adminExceptionLinks.videoCostConflict },
    { label: '图片费用待核', href: adminExceptionLinks.imageCostPending },
    { label: '图片费用冲突', href: adminExceptionLinks.imageCostConflict },
    { label: '账本费用待核', href: adminExceptionLinks.ledgerCostPending },
    { label: '账本费用冲突', href: adminExceptionLinks.ledgerCostConflict },
    { label: '视频文件未就绪', href: adminExceptionLinks.videoResultNotReady },
    { label: '图片文件未就绪', href: adminExceptionLinks.imageResultNotReady },
    { label: '视频当前无项目', href: adminExceptionLinks.videoUnassigned },
  ];

  return (
    <AdminUsageClient key={user.id} viewerId={user.id} view="overview" support={(
      <>
      <div className="au-legacy-scope"><h2>按来源查看专项记录</h2><nav aria-label="专项异常入口">{supportLinks.map(item => <Link className="au-link" key={item.href} href={item.href}>{item.label}</Link>)}</nav></div>
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
      </>
    )} />
  );
}
