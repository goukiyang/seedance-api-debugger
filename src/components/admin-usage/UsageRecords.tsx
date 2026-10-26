'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import PaginationControls from '@/components/PaginationControls';
import { RelativeTime } from '@/components/RelativeTime';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import { sanitizeReturnTo, taskDetailHref } from '@/lib/navigation/return-to';
import type { UsageFact, UsagePage } from '@/lib/admin/usage-types';
import { usageCashLedgerHref } from '@/lib/admin/usage-record-link';
import { ATTRIBUTION_LABELS, COST_LABELS, KIND_LABELS, RETENTION_LABELS, SOURCE_LABELS, STATUS_LABELS, money, originalMoney, points } from './format';
import { usageHref, type QueryPatch, type UsageView } from './query';

function originalHref(record: UsageFact, returnTo: string): string | null {
  if (!record.href || !record.href.startsWith('/') || record.href.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(record.href)) return null;
  if (/^\/tasks\/[^/?#]+(?:[?#]|$)/.test(record.href) && record.sourceKind === 'video_task') return taskDetailHref(record.sourceId, returnTo);
  const url = new URL(record.href, 'https://sd2.invalid');
  url.searchParams.set('return_to', sanitizeReturnTo(returnTo));
  return `${url.pathname}${url.search}${url.hash}`;
}

function RecordDetails({ record, href, expanded, toggle }: { record: UsageFact; href: string | null; expanded: boolean; toggle: (open: boolean) => void }) {
  return <details className="au-record-details" open={expanded} onToggle={event => toggle(event.currentTarget.open)}>
    <summary>详情</summary>
    <dl>
      <div><dt>原记录</dt><dd>{SOURCE_LABELS[record.sourceKind] || '来源待确认'} · {record.sourceId}</dd></div>
      {record.parentSourceId && <div><dt>所属任务群</dt><dd>{record.parentSourceId}</dd></div>}
      <div><dt>归属依据</dt><dd>{ATTRIBUTION_LABELS[record.attribution] || record.attribution} · {record.attributionDetail}</dd></div>
      <div><dt>消费归属成员</dt><dd>{record.ownerUserId ? <UserIdentityBadge user={{ id: record.ownerUserId, name: record.ownerLabel }} size="sm" /> : record.ownerLabel}{record.ownerUserId ? `（${record.ownerUserId}）` : ''}</dd></div>
      <div><dt>操作者 / 付费主体</dt><dd>{record.actorUserId || '未记录'} / {record.billingSubject || '未记录'}</dd></div>
      <div><dt>原使用项目 / 当前管理项目</dt><dd>{record.projectLabel} / {record.currentProjectId || '未归属或未记录'}</dd></div>
      {record.currentOwnerUserId !== record.ownerUserId && <div><dt>当前管理成员</dt><dd>{record.currentOwnerUserId || '未记录'}</dd></div>}
      <div><dt>业务 / 模型 / 规格</dt><dd>{KIND_LABELS[record.kind] || record.kind} / {record.model || '未记录'} / {record.resolution || '未记录'}</dd></div>
      <div><dt>供应商</dt><dd>{record.provider || '未记录'}</dd></div>
      <div><dt>执行 / 结果文件</dt><dd>{STATUS_LABELS[record.status] || record.status} / {record.resultReady === null ? '文件状态未知' : record.resultReady ? '文件已就绪' : '文件未就绪'}{record.retentionStatus ? ` · ${RETENTION_LABELS[record.retentionStatus] || record.retentionStatus}` : ''}</dd></div>
      <div><dt>确认供应商费用</dt><dd>{COST_LABELS[record.costStatus] || record.costStatus} · {originalMoney(record.confirmedCost)}{record.confirmedCostCnyMicros !== null ? `（展示折算 ${money(record.confirmedCostCnyMicros)}）` : ''}</dd></div>
      <div><dt>点数</dt><dd>已实扣 {points(record.chargedPoints)} / 仍预留 {points(record.reservedPoints)} / 已释放预留 {points(record.releasedPoints)} / 已退还实扣 {points(record.refundedPoints)}</dd></div>
      <div><dt>账务凭据</dt><dd>{record.ledgerIds.length ? record.ledgerIds.map(id => {
        const href = usageCashLedgerHref(id);
        return href ? <Link className="au-link" key={id} href={href}>{id} </Link> : <span key={id}>{id} </span>;
      }) : '暂无可关联账单'} · <Link href="/admin/costs" className="au-link">成本与账务</Link></dd></div>
      <div><dt>首次发生 / 更新</dt><dd><RelativeTime value={record.occurredAt} /> / <RelativeTime value={record.updatedAt} /></dd></div>
      {href && <div><dt>原入口</dt><dd><Link className="au-link" href={href}>查看原任务<ExternalLink size={13} /></Link></dd></div>}
    </dl>
  </details>;
}

export default function UsageRecords({ page, search, view, busy, update, expanded, toggleExpanded }: {
  page: UsagePage<UsageFact>; search: string; view: UsageView; busy: boolean;
  update: (patch: QueryPatch, options?: { pages?: boolean }) => void;
  expanded: string[]; toggleExpanded: (id: string, open: boolean) => void;
}) {
  const value = new URLSearchParams(search).get('keyword') || '';
  const [keyword, setKeyword] = useState(value);
  useEffect(() => { setKeyword(value); }, [value]);
  const returnTo = sanitizeReturnTo(usageHref(view, search));
  return <section id="usage-records" className="au-section au-records" aria-labelledby="au-records-title" data-usage-anchor="records">
    <div className="au-section-head"><div><h2 id="au-records-title">使用明细</h2><p className="au-muted">共 {page.total.toLocaleString('zh-CN')} 条，金额与次数为完整范围统计。</p></div><div className="au-record-controls"><label><span className="au-sr-only">记录排序</span><select className="input" value={new URLSearchParams(search).get('sort') || 'newest'} onChange={event => update({ sort: event.target.value })}><option value="newest">最新在前</option><option value="oldest">最早在前</option><option value="cost">成本最高在前</option><option value="usage">使用次数</option><option value="name">按名称</option></select></label><form className="au-record-search" onSubmit={event => { event.preventDefault(); update({ keyword }); }}><input className="input" type="search" maxLength={120} aria-label="搜索原任务或记录" placeholder="搜索原任务或记录" value={keyword} onChange={event => setKeyword(event.target.value)} /><button type="submit" className="btn btn-secondary">查找</button></form></div></div>
    <div className="au-table-scroll"><table className="au-table au-record-table"><thead><tr><th>首次发生</th><th>成员 / 项目</th><th>业务 / 模型</th><th className="au-numeric">已确认成本</th><th className="au-numeric">已实扣点数</th><th>执行状态</th><th>原记录</th></tr></thead><tbody>
      {page.rows.map(record => {
        const key = `${record.sourceKind}:${record.sourceId}`;
        const href = originalHref(record, returnTo);
        return <tr key={key} data-usage-anchor={key}>
          <td><RelativeTime value={record.occurredAt} /></td>
          <td><div className="au-cell-stack">{record.ownerUserId ? <Link className="au-name-link" href={usageHref('members', search, { owner_user_id: record.ownerUserId, records_page: 1, page: 1 })}><UserIdentityBadge user={{ id: record.ownerUserId, name: record.ownerLabel }} size="sm" /></Link> : <span>{record.ownerLabel}</span>}{record.projectId ? <Link className="au-quiet-link" href={usageHref('projects', search, { project_id: record.projectId, records_page: 1, page: 1 })}>{record.projectLabel}</Link> : <small>{record.projectLabel}</small>}</div></td>
          <td><div className="au-cell-stack"><span>{KIND_LABELS[record.kind] || record.kind}{!record.leaf ? '（流程分组）' : ''}</span><small>{SOURCE_LABELS[record.sourceKind] || '来源待确认'}</small><small>{record.model || '型号未记录'}</small></div></td>
          <td className="au-numeric"><div className="au-cell-stack"><span>{record.confirmedCostCnyMicros !== null ? money(record.confirmedCostCnyMicros) : record.confirmedCost.length ? originalMoney(record.confirmedCost) : COST_LABELS[record.costStatus] || '待核'}</span><small>{COST_LABELS[record.costStatus]}</small></div></td>
          <td className="au-numeric"><div className="au-cell-stack"><span>{points(record.chargedPoints)}</span><small>预留 {points(record.reservedPoints)}</small></div></td>
          <td><span className={`au-state${['succeeded', 'success', 'completed'].includes(record.status) ? ' is-complete' : ''}`}>{STATUS_LABELS[record.status] || record.status}</span></td>
          <td><RecordDetails record={record} href={href} expanded={expanded.includes(key)} toggle={open => toggleExpanded(key, open)} /></td>
        </tr>;
      })}
      {!page.rows.length && <tr><td colSpan={7} className="au-empty">当前条件没有匹配的使用记录。可移除筛选；未接入来源见覆盖说明。</td></tr>}
    </tbody></table></div>
    <PaginationControls page={page.page} pageSize={page.pageSize} total={page.total} totalPages={Math.max(1, Math.ceil(page.total / page.pageSize))} label="使用记录" busy={busy} onPageChange={next => update({ records_page: next, page: next }, { pages: false })} />
  </section>;
}
