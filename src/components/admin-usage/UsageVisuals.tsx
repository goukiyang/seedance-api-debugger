'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ArrowRight, Folder, Info, Users } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import PaginationControls from '@/components/PaginationControls';
import { RelativeTime } from '@/components/RelativeTime';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import { adminExceptionLinks } from '@/lib/navigation';
import type { UsageDistribution, UsagePage, UsageReport, UsageSummary } from '@/lib/admin/usage-types';
import { originalMoney, points, summaryCost } from './format';
import { usageHref, type QueryPatch, type UsageView } from './query';

export function UsageStats({ report, open, onToggle }: { report: UsageReport; open: boolean; onToggle: (open: boolean) => void }) {
  const summary = report.summary;
  return <>
    <dl className="au-stats" aria-label="全量使用统计">
      <div><dt>已确认供应商成本</dt><dd>{summaryCost(summary)}</dd></div>
      <div><dt>使用次数</dt><dd>{summary.usageCount.toLocaleString('zh-CN')}<small>次</small></dd></div>
      <div><dt>有效产出</dt><dd>{summary.outputCount.toLocaleString('zh-CN')}<small>个</small></dd></div>
      <div><dt>已实扣点数</dt><dd>{points(summary.chargedPoints)}<small>点</small></dd></div>
      <div><dt>仍预留点数</dt><dd>{points(summary.reservedPoints)}<small>点</small></dd></div>
      <div><dt>费用待核</dt><dd>{summary.pendingCount.toLocaleString('zh-CN')}<small>笔</small></dd></div>
    </dl>
    <details className="au-calculation" open={open} onToggle={event => onToggle(event.currentTarget.open)}>
      <summary><Info size={14} />统计与费用口径</summary>
      <div className="au-explanation">
        <p>按原任务首次发生时间选取同一批记录，费用与点数截至本次读取。图片、视频和独立文字调用按叶子任务计次，流程 {summary.flowCount.toLocaleString('zh-CN')} 次单列，父批次与子任务不重复相加。</p>
        <p>供应商真实成本、平台点数和当前余额分别计算。已释放预留 {points(summary.releasedPoints)} 点，已退还实扣 {points(summary.refundedPoints)} 点；未知不当作零。</p>
        <p>原币金额：{originalMoney(summary.confirmedCost)}。USD/CNY 展示汇率 {report.exchangeRate.USD_CNY}（{report.exchangeRate.source}）；其它币种单列，不按当前费率反推历史成本。</p>
        <p>活跃成员 {summary.activeMemberCount} 人，涉及项目 {summary.projectCount} 个。消费归属成员与操作者、付费主体分别记录；历史归属依据可在原记录中查看。</p>
      </div>
    </details>
  </>;
}

type Metric = 'cost' | 'usage' | 'points';
const METRIC_LABELS: Record<Metric, string> = { cost: '已确认成本', usage: '使用次数', points: '已实扣点数' };
function metricText(summary: UsageSummary, metric: Metric) {
  return metric === 'cost' ? summaryCost(summary) : metric === 'points' ? `${points(summary.chargedPoints)} 点` : `${summary.usageCount.toLocaleString('zh-CN')} 次`;
}
function chartValue(summary: UsageSummary, metric: Metric) {
  if (metric === 'usage') return summary.usageCount;
  const text = metric === 'cost' ? summary.confirmedCostCnyMicros : summary.chargedPoints;
  if (text === null) return null;
  if (!/^-?\d+(\.\d+)?$/.test(text) || BigInt(text.split('.')[0]) > BigInt(Number.MAX_SAFE_INTEGER) || BigInt(text.split('.')[0]) < -BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const value = Number(text) / (metric === 'cost' ? 1_000_000 : 1);
  return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : null;
}

export function UsageTrend({ report, search, update, dataOpen, onDataToggle }: { report: UsageReport; search: string; update: (patch: QueryPatch) => void; dataOpen: boolean; onDataToggle: (open: boolean) => void }) {
  const [metric, setMetric] = useState<Metric>('cost');
  const grain = new URLSearchParams(search).get('grain') || 'day';
  const data = useMemo(() => report.trend.map(row => ({ bucket: row.bucket, value: chartValue(row.summary, metric), exact: metricText(row.summary, metric) })), [report.trend, metric]);
  const hasValues = data.some(row => row.value !== null);
  return <section className="au-section au-trend" aria-labelledby="au-trend-title" data-usage-anchor="trend">
    <div className="au-section-head"><h2 id="au-trend-title">使用趋势</h2><div className="au-chart-controls">
      <label><span className="au-sr-only">趋势指标</span><select className="input" value={metric} onChange={event => setMetric(event.target.value as Metric)}>{Object.entries(METRIC_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label><span className="au-sr-only">趋势粒度</span><select className="input" value={grain} onChange={event => update({ grain: event.target.value })}>{!['day', 'week', 'month'].includes(grain) && <option value={grain}>{grain}（请核对）</option>}<option value="day">按日</option><option value="week">按周</option><option value="month">按月</option></select></label>
    </div></div>
    {!data.length ? <p className="au-empty">这个范围还没有可展示的使用记录。</p> : !hasValues ? <p className="au-empty">这个范围的{METRIC_LABELS[metric]}尚不能确认，请在明细中查看待核或未接入的来源。</p> : <div className="au-chart" role="img" aria-label={`${METRIC_LABELS[metric]}趋势，准确数值可在下方趋势数据中读取`}>
      <ResponsiveContainer width="100%" height={250} minWidth={0}><BarChart data={data} margin={{ top: 15, right: 12, left: 4, bottom: 6 }} accessibilityLayer>
        <CartesianGrid vertical={false} stroke="var(--au-line)" />
        <XAxis dataKey="bucket" tickLine={false} axisLine={false} minTickGap={30} tick={{ fill: 'var(--au-muted)', fontSize: 12 }} />
        <YAxis tickLine={false} axisLine={false} width={64} tick={{ fill: 'var(--au-muted)', fontSize: 12 }} tickFormatter={(value: number) => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value)} />
        <Tooltip cursor={{ fill: 'var(--au-soft)' }} content={({ active, payload }) => active && payload?.[0] ? <div className="au-chart-tooltip"><span>{payload[0].payload.bucket}</span><strong>{payload[0].payload.exact}</strong></div> : null} />
        <Bar dataKey="value" name={METRIC_LABELS[metric]} fill="var(--au-accent)" maxBarSize={44} radius={[3, 3, 0, 0]} />
      </BarChart></ResponsiveContainer>
    </div>}
    {data.length > 0 && <details className="au-chart-data" open={dataOpen} onToggle={event => onDataToggle(event.currentTarget.open)}><summary>查看趋势数据</summary><div className="au-table-scroll"><table className="au-table"><thead><tr><th>统计周期（{report.query.time_zone}）</th><th>{METRIC_LABELS[metric]}</th></tr></thead><tbody>{data.map(row => <tr key={row.bucket}><td>{row.bucket}</td><td>{row.exact}</td></tr>)}</tbody></table></div></details>}
  </section>;
}

function distributionPatch(type: 'members' | 'projects', id: string | null): QueryPatch {
  return { [type === 'members' ? 'owner_user_id' : 'project_id']: id || 'unassigned', records_page: 1, page: 1 };
}

export function UsageDistributionTable({ type, page, search, compact = false }: { type: 'members' | 'projects'; page: UsagePage<UsageDistribution>; search: string; compact?: boolean }) {
  const title = type === 'members' ? '成员使用情况' : '项目使用情况';
  const rows = compact ? page.rows.slice(0, 5) : page.rows;
  return <section className="au-section" data-usage-anchor={`${type}-distribution`}>
    <div className="au-section-head"><h2>{title}</h2><Link className="au-link" href={usageHref(type, search, { [`${type}_page`]: 1 })}>查看全部{type === 'members' ? '成员' : '项目'}<ArrowRight size={14} /></Link></div>
    <div className="au-table-scroll"><table className="au-table"><thead><tr><th>{type === 'members' ? '成员' : '项目'}</th><th className="au-numeric">使用次数</th><th className="au-numeric">已确认成本</th><th className="au-numeric">已实扣点数</th><th>待核</th><th><span className="au-sr-only">操作</span></th></tr></thead><tbody>
      {rows.map(row => <tr key={row.id ?? 'unassigned'} data-usage-anchor={`${type}:${row.id || 'unassigned'}`}><td><Link className="au-name-link" href={usageHref(type, search, distributionPatch(type, row.id))}>{type === 'members' && row.id ? <UserIdentityBadge user={{ id: row.id, name: row.label }} size="sm" /> : row.label}</Link></td><td className="au-numeric">{row.summary.usageCount.toLocaleString('zh-CN')}</td><td className="au-numeric">{summaryCost(row.summary)}</td><td className="au-numeric">{points(row.summary.chargedPoints)}</td><td>{row.summary.pendingCount}</td><td><Link className="au-link" href={usageHref(type, search, distributionPatch(type, row.id))}>查看<ArrowRight size={13} /></Link></td></tr>)}
      {!rows.length && <tr><td colSpan={6} className="au-empty">这个范围没有{type === 'members' ? '成员' : '项目'}使用记录。未覆盖的来源请查看覆盖说明。</td></tr>}
    </tbody></table></div>
    <p className="au-table-foot">共 {page.total.toLocaleString('zh-CN')} {type === 'members' ? '位成员' : '个项目分组'}{compact && page.total > rows.length ? `，展示本页前 ${rows.length} 项` : ''}，统计不受当前分页影响。</p>
  </section>;
}

export function UsageDirectory({ type, report, search, selectedId, busy, update, onSelect, onAll }: {
  type: 'members' | 'projects'; report: UsageReport; search: string; selectedId: string | null; busy: boolean;
  update: (patch: QueryPatch, options?: { pages?: boolean }) => void;
  onSelect: (row: UsageDistribution) => void;
  onAll: () => void;
}) {
  const params = new URLSearchParams(search);
  const searchKey = `${type}_search`;
  const [keyword, setKeyword] = useState(params.get(searchKey) || '');
  // Back/forward and links own the search field as well as the list.
  const currentSearch = params.get(searchKey) || '';
  const [seenSearch, setSeenSearch] = useState(currentSearch);
  if (seenSearch !== currentSearch) { setSeenSearch(currentSearch); setKeyword(currentSearch); }
  const page = type === 'members' ? report.memberDirectory : report.projectDirectory;
  return <aside className="au-directory" aria-label={type === 'members' ? '成员目录' : '项目目录'} data-usage-anchor="directory">
    <div className="au-directory-head"><h2>{type === 'members' ? '成员' : '项目'}</h2><span className="au-muted">共 {page.total} {type === 'members' ? '人' : '组'}</span></div>
    <form className="au-directory-search" onSubmit={event => { event.preventDefault(); update({ [searchKey]: keyword, [`${type}_page`]: 1 }, { pages: false }); }}><input className="input" type="search" maxLength={120} aria-label={type === 'members' ? '搜索成员姓名' : '搜索项目名称'} value={keyword} onChange={event => setKeyword(event.target.value)} placeholder={type === 'members' ? '搜索成员' : '搜索项目'} /><button className="btn btn-secondary" type="submit">查找</button>{currentSearch && <button className="au-text-button" type="button" onClick={() => update({ [searchKey]: null, [`${type}_page`]: 1 }, { pages: false })}>清除</button>}</form>
    <label className="au-directory-sort"><span>排序</span><select className="input" value={params.get(`${type}_sort`) || params.get('sort') || 'newest'} onChange={event => update({ [`${type}_sort`]: event.target.value, [`${type}_page`]: 1 }, { pages: false })}><option value="usage">按使用次数</option><option value="cost">按已确认成本</option><option value="name">按名称</option><option value="newest">最近使用</option><option value="oldest">最早使用</option></select></label>
    <button type="button" className={`au-directory-all${!selectedId ? ' is-selected' : ''}`} aria-current={!selectedId ? 'true' : undefined} onClick={onAll} disabled={busy}><Users size={16} />全部{type === 'members' ? '成员' : '项目'}</button>
    <ul className="au-directory-list">{page.rows.map(row => <li key={row.id || 'unassigned'}><button type="button" aria-current={selectedId === (row.id || 'unassigned') ? 'true' : undefined} className={`au-directory-item${selectedId === (row.id || 'unassigned') ? ' is-selected' : ''}`} onClick={() => onSelect(row)} disabled={busy}>
      {type === 'members' && row.id ? <UserIdentityBadge user={{ id: row.id, name: row.label }} size="sm" avatarOnly /> : <span className="au-avatar" aria-hidden="true">{type === 'projects' ? <Folder size={17} /> : <Users size={17} />}</span>}<span className="au-directory-name"><strong>{row.label}</strong><small>{row.summary.usageCount.toLocaleString('zh-CN')} 次使用 · {row.summary.pendingCount} 笔待核</small></span><span className="au-directory-cost">{summaryCost(row.summary)}</span>
    </button></li>)}</ul>
    {!page.rows.length && <p className="au-empty">没有匹配的{type === 'members' ? '成员' : '项目'}，可清除搜索或调整范围。</p>}
    <PaginationControls page={page.page} pageSize={page.pageSize} total={page.total} totalPages={Math.max(1, Math.ceil(page.total / page.pageSize))} label={type === 'members' ? '成员' : '项目'} busy={busy} onPageChange={next => update({ [`${type}_page`]: next }, { pages: false })} />
  </aside>;
}

export function UsageCoverageDetails({ report, open, onToggle }: { report: UsageReport; open: boolean; onToggle: (open: boolean) => void }) {
  const incomplete = report.coverage.filter(item => item.status !== 'complete');
  return <details className="au-section au-coverage" open={open} onToggle={event => onToggle(event.currentTarget.open)}><summary><Info size={15} />来源覆盖{incomplete.length ? ` · ${incomplete.length} 类来源部分接入或未接入` : '与历史依据'}</summary><div className="au-table-scroll"><table className="au-table"><thead><tr><th>来源</th><th>覆盖情况</th><th>记录</th><th>说明</th></tr></thead><tbody>{report.coverage.map(item => <tr key={item.source}><td>{item.label}</td><td>{item.status === 'complete' ? '已接入' : item.status === 'partial' ? '部分接入' : '未接入'}</td><td>{item.total}（原归属 {item.frozen} / 历史 {item.legacy}）</td><td>{item.detail}</td></tr>)}</tbody></table></div><p className="au-muted">未接入不等于没有使用。历史缺失与归属冲突保留原记录，不按当前成员、价格或模板作者补算。</p><p className="au-muted">本次读取：<RelativeTime value={report.dataAsOf} /></p></details>;
}

export function UsageAttention({ report }: { report: UsageReport }) {
  const items = report.exceptions.filter(item => item.count > 0);
  return <section className="au-attention" aria-label="需处理事项">
    <strong>需处理</strong>{items.length ? items.map(item => <Link key={item.key} className="au-attention-link" href={`${item.href.split('#')[0]}#usage-records`}>{item.label}<span>{item.count}</span><ArrowRight size={13} /></Link>) : <span className="au-muted">本次已接入记录暂无待处理事项。</span>}
    {report.unlinkedCosts.count > 0 && <span className="au-muted">另有未关联费用 {report.unlinkedCosts.count} 笔 · <Link className="au-link" href={report.unlinkedCosts.href}>查看未关联费用<ArrowRight size={13} /></Link></span>}
    <Link className="au-quiet-link" href={adminExceptionLinks.feedback}>反馈管理</Link>
  </section>;
}

export function EntireProjectLink({ search }: { search: string }) {
  const params = new URLSearchParams(search);
  return params.get('owner_user_id') && params.get('project_id') ? <Link className="au-link" href={usageHref('projects', search, { owner_user_id: null, members_page: 1, projects_page: 1, records_page: 1, page: 1 })}>查看整个项目<ArrowRight size={14} /></Link> : null;
}

export function selectedDistributionHref(view: UsageView, search: string, row: UsageDistribution) {
  return usageHref(view, search, distributionPatch(view === 'members' ? 'members' : 'projects', row.id));
}
