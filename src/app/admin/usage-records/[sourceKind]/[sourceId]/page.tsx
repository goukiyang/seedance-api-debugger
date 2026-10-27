import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { getUsageAnalyticsSnapshot } from '@/lib/admin/usage-analytics';
import { parseUsageQuery, usageQuerySearchParams } from '@/lib/admin/usage-query';
import { usageCashLedgerHref, usageRecordHref } from '@/lib/admin/usage-record-link';
import { sanitizeReturnTo } from '@/lib/navigation/return-to';
import { RelativeTime } from '@/components/RelativeTime';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import { ATTRIBUTION_LABELS, COST_LABELS, SOURCE_LABELS, STATUS_LABELS, money, originalMoney, points } from '@/components/admin-usage/format';
import { release } from '@/lib/release';
import '../../../admin-usage.css';

export const dynamic = 'force-dynamic';

export default async function UsageRecordPage(
  props: {
    params: Promise<{ sourceKind: string; sourceId: string }>;
    searchParams: Promise<{ return_to?: string; child_page?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  const user = await getSession();
  if (!user) redirect('/login?next=' + encodeURIComponent(usageRecordHref(params.sourceKind, params.sourceId)));
  if (user.role !== 'admin') redirect('/');
  if (!/^[A-Za-z0-9:_-]{1,180}$/.test(params.sourceId)) notFound();
  try { parseUsageQuery(new URLSearchParams({ range: 'all', source_kind: params.sourceKind })); } catch { notFound(); }
  const query = parseUsageQuery(new URLSearchParams({ range: 'all' }));
  const snapshot = await getUsageAnalyticsSnapshot(query);
  const record = snapshot.records.find(item => item.sourceKind === params.sourceKind && item.sourceId === params.sourceId);
  if (!record) notFound();
  const returnTo = sanitizeReturnTo(typeof searchParams.return_to === 'string' ? searchParams.return_to : '/admin');
  let sourceQuery = query;
  try {
    const origin = new URL(returnTo, 'https://sd2.youdooart.com');
    if (['/admin', '/admin/users', '/admin/projects'].includes(origin.pathname) && origin.search) {
      sourceQuery = parseUsageQuery(origin.searchParams);
    }
  } catch { /* An invalid old return filter must not hide the original record. */ }
  const dimensionHref = (dimension: 'member' | 'project', id: string) => {
    const filters = usageQuerySearchParams(sourceQuery, false);
    filters.set(dimension === 'member' ? 'owner_user_id' : 'project_id', id);
    return `/admin/${dimension === 'member' ? 'users' : 'projects'}?${filters}`;
  };
  const parents = record.parentSourceId && record.parentSourceKind ? snapshot.records.filter(item => item.sourceKind === record.parentSourceKind && item.sourceId === record.parentSourceId) : [];
  const children = snapshot.records.filter(item => item.parentSourceKind === record.sourceKind && item.parentSourceId === record.sourceId && item.sourceId !== record.sourceId);
  const rawPage = Number(searchParams.child_page || 1);
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? Math.min(rawPage, Math.max(1, Math.ceil(children.length / 30))) : 1;
  const childHref = (next: number) => `${usageRecordHref(record.sourceKind, record.sourceId)}?${new URLSearchParams({ return_to: returnTo, child_page: String(next) })}`;
  return <main className="admin-usage-page">
    <header className="au-page-head"><div><p className="au-eyebrow">管理中心 · 原记录</p><h1>{SOURCE_LABELS[record.sourceKind] || record.sourceKind}</h1></div><div className="au-actions"><Link className="au-link" href={returnTo}>返回分析</Link><Link className="au-version au-quiet-link" href="/account">SD2 v{release.version}</Link></div></header>
    <div className="au-read-meta">截至 <RelativeTime value={snapshot.report.dataAsOf} /></div>
    <section className="au-section au-record-details" style={{ maxWidth: 'none' }}><dl>
      <div><dt>原记录编号</dt><dd>{record.sourceKind} · {record.sourceId}</dd></div>
      <div><dt>消费归属成员</dt><dd>{record.ownerUserId ? <Link className="au-link" href={dimensionHref('member', record.ownerUserId)}><UserIdentityBadge user={{ id: record.ownerUserId, name: record.ownerLabel }} /></Link> : record.ownerLabel}</dd></div>
      <div><dt>原使用项目</dt><dd><Link className="au-link" href={dimensionHref('project', record.projectId || 'unassigned')}>{record.projectLabel}</Link></dd></div>
      <div><dt>归属依据</dt><dd>{ATTRIBUTION_LABELS[record.attribution]} · {record.attributionDetail}</dd></div>
      <div><dt>当前管理成员 / 项目</dt><dd>{record.currentOwnerUserId || '未记录'} / {record.currentProjectId || '未归属或未记录'}</dd></div>
      <div><dt>操作者 / 付费主体</dt><dd>{record.actorUserId || '未记录'} / {record.billingSubject || '未记录'}</dd></div>
      <div><dt>模型 / 供应商 / 规格</dt><dd>{record.model || '未记录'} / {record.provider || '未记录'} / {record.resolution || '未记录'}</dd></div>
      <div><dt>执行 / 结果文件</dt><dd>{STATUS_LABELS[record.status] || record.status} / {record.resultReady === null ? '文件状态未接入' : record.resultReady ? '文件已登记' : '文件未就绪'}</dd></div>
      <div><dt>供应商成本</dt><dd>{COST_LABELS[record.costStatus]} · {originalMoney(record.confirmedCost)}{record.confirmedCostCnyMicros !== null ? `（展示折算 ${money(record.confirmedCostCnyMicros)}）` : ''}</dd></div>
      <div><dt>点数</dt><dd>已实扣 {points(record.chargedPoints)} · 仍预留 {points(record.reservedPoints)} · 已释放预留 {points(record.releasedPoints)} · 已退还实扣 {points(record.refundedPoints)}</dd></div>
      <div><dt>原账务凭据</dt><dd>{record.ledgerIds.length ? record.ledgerIds.map(id => {
        const href = usageCashLedgerHref(id);
        return href ? <Link className="au-link" key={id} href={href}>{id} </Link> : <span key={id}>{id} </span>;
      }) : '暂无可关联账单'}</dd></div>
      <div><dt>首次发生 / 更新</dt><dd><RelativeTime value={record.occurredAt} /> / <RelativeTime value={record.updatedAt} /></dd></div>
      {record.parentSourceId && <div><dt>原父级记录</dt><dd>{parents.length ? parents.map(parent => <Link className="au-link" key={parent.sourceKind + parent.sourceId} href={`${usageRecordHref(parent.sourceKind, parent.sourceId)}?return_to=${encodeURIComponent(returnTo)}`}>{SOURCE_LABELS[parent.sourceKind]} · {parent.sourceId}</Link>) : record.parentSourceId}</dd></div>}
      {record.href && !record.href.startsWith('/admin/usage-records/') && <div><dt>业务原入口</dt><dd><Link className="au-link" href={record.href}>查看原任务</Link></dd></div>}
    </dl></section>
    <section className="au-section"><div className="au-section-head"><h2>关联子记录</h2><span className="au-muted">共 {children.length} 条</span></div>
      <div className="au-table-scroll"><table className="au-table"><thead><tr><th>来源</th><th>原记录</th><th>首次发生</th><th>执行状态</th><th>费用状态</th></tr></thead><tbody>{children.slice((page - 1) * 30, page * 30).map(child => <tr key={child.sourceKind + child.sourceId}><td>{SOURCE_LABELS[child.sourceKind]}</td><td><Link className="au-link" href={`${usageRecordHref(child.sourceKind, child.sourceId)}?return_to=${encodeURIComponent(returnTo)}`}>{child.sourceId}</Link></td><td><RelativeTime value={child.occurredAt} /></td><td>{STATUS_LABELS[child.status] || child.status}</td><td>{COST_LABELS[child.costStatus]}</td></tr>)}{!children.length && <tr><td colSpan={5}>暂无本站已存关联子记录</td></tr>}</tbody></table></div>
      {children.length > 30 && <nav className="au-actions" aria-label="关联记录分页">{page > 1 && <Link className="au-link" href={childHref(page - 1)}>上一页</Link>}<span>{page} / {Math.ceil(children.length / 30)}</span>{page * 30 < children.length && <Link className="au-link" href={childHref(page + 1)}>下一页</Link>}</nav>}
    </section>
  </main>;
}
