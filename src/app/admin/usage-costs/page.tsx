import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { getUsageAnalyticsSnapshot } from '@/lib/admin/usage-analytics';
import { parseUsageQuery, usageQuerySearchParams, UsageQueryError } from '@/lib/admin/usage-query';
import { RelativeTime } from '@/components/RelativeTime';
import { originalMoney } from '@/components/admin-usage/format';
import { actualRangeLabel } from '@/components/admin-usage/query';
import '../admin-usage.css';

export const dynamic = 'force-dynamic';

export default async function UnlinkedUsageCostsPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const user = await getSession();
  if (!user) redirect('/login?next=%2Fadmin');
  if (user.role !== 'admin') redirect('/');
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (Array.isArray(value)) value.forEach(item => params.append(key, item));
    else if (value !== undefined) params.set(key, value);
  }
  let query;
  try { query = parseUsageQuery(params); } catch (error) {
    if (!(error instanceof UsageQueryError)) throw error;
    return <main className="admin-usage-page"><h1>未关联费用</h1><p role="status">{error.message}</p><Link className="au-link" href="/admin">返回使用分析</Link></main>;
  }
  const snapshot = await getUsageAnalyticsSnapshot(query);
  const rows = snapshot.cashEvents.filter(event => !event.sourceKey).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id));
  const pages = Math.max(1, Math.ceil(rows.length / query.page_size)), page = Math.min(query.page, pages);
  const current = usageQuerySearchParams(query, true);
  const href = (next: number) => { const target = new URLSearchParams(current); target.set('page', String(next)); return `/admin/usage-costs?${target}`; };
  return <main className="admin-usage-page">
    <header className="au-page-head"><div><p className="au-eyebrow">管理中心 · 使用分析</p><h1>未关联费用</h1></div><Link className="au-link" href={`/admin?${current}`}>返回当前分析</Link></header>
    <div className="au-read-meta"><span>{actualRangeLabel(query)} · {query.time_zone}</span><span>截至 <RelativeTime value={snapshot.report.dataAsOf} /></span></div>
    <section className="au-section"><h2>已确认原币金额</h2><p>{originalMoney(snapshot.report.unlinkedCosts.confirmedCost)}</p><p className="au-muted">共 {rows.length} 条原费用事件，未并入任务群总额。账务归属不代表原任务消费成员；缺失和冲突未补造。完整使用明细导出保留这些原事件。</p></section>
    <section className="au-section"><div className="au-table-scroll"><table className="au-table"><thead><tr><th>账务发生</th><th>原费用事件</th><th>类型 / 依据</th><th>原币金额</th><th>供应商 / 原收费编号</th><th>账务归属</th></tr></thead><tbody>
      {rows.slice((page - 1) * query.page_size, page * query.page_size).map(event => <tr key={event.id}><td><RelativeTime value={event.occurredAt} /></td><td><Link className="au-link" href={`/admin/costs?keyword=${encodeURIComponent(event.id)}`}>{event.id}</Link><p className="au-muted">{event.detail}</p></td><td>{event.eventType} · {event.status === 'confirmed' ? '已确认' : event.status === 'conflict' ? '冲突待核' : '待核'}{!event.cashEvidence && <p className="au-muted">非新增现金证明</p>}</td><td>{event.amountMicros !== null && event.currency ? originalMoney([{ currency: event.currency, amountMicros: event.amountMicros }]) : '金额未记录'}</td><td>{event.provider || '未记录'} / {event.proofId || '未记录'}</td><td>成员 {event.ledgerUserId || '未记录'}<br />项目 {event.ledgerProjectId || '未记录'}</td></tr>)}
      {!rows.length && <tr><td colSpan={6}>当前条件没有未关联费用；未接入不等于没有费用。</td></tr>}
    </tbody></table></div><nav className="au-actions" aria-label="未关联费用分页">{page > 1 && <Link className="au-link" href={href(page - 1)}>上一页</Link>}<span>{page} / {pages}</span>{page < pages && <Link className="au-link" href={href(page + 1)}>下一页</Link>}</nav></section>
  </main>;
}
