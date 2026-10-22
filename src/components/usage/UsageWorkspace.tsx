'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Download, ExternalLink, Film, ImageIcon, Play, RefreshCw, RotateCcw } from 'lucide-react';
import type { UsageCashDTO, UsageCategorySummary, UsagePointsDTO, UsageRecordDTO, UsageReportDTO, UsageType } from '@/lib/usage/dto';
import { RelativeTime } from '@/components/RelativeTime';
import MediaPreview from '@/components/MediaPreview';
import PaginationControls from '@/components/PaginationControls';
import { useUsageWorkspace, usageQueryParams } from './useUsageWorkspace';
import { useUsageViewState } from './useUsageViewState';
import styles from './UsageWorkspace.module.css';
import { Bar, BarChart, CartesianGrid, Legend, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { seedanceVideoModelLabel } from '@/lib/provider/seedance-models';

export function formatUsageMoney(value: string | null, prefix = '¥') {
  if (value === null || !/^-?\d+$/.test(value)) return '待核';
  const raw = BigInt(value); const negative = raw < BigInt(0); const absolute = negative ? -raw : raw;
  const cents = (absolute + BigInt(5000)) / BigInt(10000);
  return `${negative ? '-' : ''}${prefix}${(cents / BigInt(100)).toLocaleString('zh-CN')}.${String(cents % BigInt(100)).padStart(2, '0')}`;
}
const count = (value: number | null) => value === null ? '待确认' : value.toLocaleString('zh-CN');
const point = (value: string | null) => value === null ? '待核' : `${value} 点`;
const labels: Record<UsageType, string> = { video: '视频', image: '图片', other: '其他业务' };
const statusText = (status: string) => ({ succeeded: '已完成', completed: '已完成', failed: '未完成', cancelled: '已取消', running: '处理中', processing: '处理中', pending: '待处理', queued: '排队中', submitted: '已提交', unknown: '提交结果待确认', awaiting_reconciliation: '费用待核' } as Record<string, string>)[status] || status;
const cashState = (cash: UsageCashDTO) => ({ confirmed: '已确认', partial: '部分已确认', pending: '费用待核', conflict: '费用有冲突', unavailable: '费用未覆盖' })[cash.state];

function safeHref(value: string | null | undefined, image = false) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value, 'https://local.invalid');
    if (url.origin !== 'https://local.invalid' || /^\/(?:api\/)?admin(?:\/|$)/.test(url.pathname) || image && /^\/tasks(?:\/|$)/.test(url.pathname)) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return null; }
}

function CashDetails({ cash, points }: { cash: UsageCashDTO; points: UsagePointsDTO }) {
  return <details className={styles.breakdown}>
    <summary>金额与点数明细</summary>
    <dl>
      <dt>确认收费</dt><dd>{formatUsageMoney(cash.chargeCnyMicros)}</dd>
      <dt>确认退款</dt><dd>{formatUsageMoney(cash.refundCnyMicros)}</dd>
      <dt>确认净额</dt><dd>{formatUsageMoney(cash.netCnyMicros)}</dd>
      <dt>原币收费</dt><dd>{cash.chargeOriginal.map((v) => formatUsageMoney(v.amountMicros, `${v.currency} `)).join(' / ') || '待核'}</dd>
      <dt>原币退款</dt><dd>{cash.refundOriginal.map((v) => formatUsageMoney(v.amountMicros, `${v.currency} `)).join(' / ') || '待核'}</dd>
      <dt>原币净额</dt><dd>{cash.netOriginal.map((v) => formatUsageMoney(v.amountMicros, `${v.currency} `)).join(' / ') || '待核'}</dd>
      <dt>金额依据</dt><dd>{cash.basis === 'CNY' ? '原始人民币金额' : cash.basis === 'UNAVAILABLE' ? '尚无可确认依据' : '人民币折算，1 USD = 7 CNY；非银行实扣'}</dd>
      <dt>实扣点数</dt><dd>{point(points.charged)}</dd>
      <dt>扣后返还</dt><dd>{point(points.refunded)}</dd>
      <dt>净扣点数</dt><dd>{point(points.net)}</dd>
      <dt>预留 / 冻结</dt><dd>{point(points.reserved)}</dd>
      <dt>释放冻结</dt><dd>{point(points.released)}</dd>
      <dt>个人承担净扣</dt><dd>{point(points.personal.net)}</dd>
      <dt>项目承担净扣</dt><dd>{point(points.project.net)}</dd>
      <dt>承担方待分类</dt><dd>{point(points.unclassified.net)}</dd>
    </dl>
  </details>;
}

function recordTarget(record: UsageRecordDTO) {
  const href = safeHref(record.originalHref, record.type === 'image');
  if (!href) return null;
  const url = new URL(href, 'https://local.invalid');
  if (typeof window !== 'undefined') url.searchParams.set('return_to', `${window.location.pathname}${window.location.search}#usage-${encodeURIComponent(record.id)}`);
  return `${url.pathname}${url.search}${url.hash}`;
}

function ProjectUsageRow({ record, onNavigate }: { record: UsageRecordDTO; onNavigate: (id: string) => void }) {
  const href = recordTarget(record);
  return <tr id={`usage-${record.id}`}>
    <td data-label="时间"><RelativeTime value={record.occurredAt} /></td>
    <td data-label="类型 / 模型">{labels[record.type]}<br /><span className={styles.muted}>{record.model ? seedanceVideoModelLabel(record.model) : '型号待确认'}</span></td>
    <td data-label="生成状态">{statusText(record.status)}</td>
    <td data-label="确认人民币"><strong>{formatUsageMoney(record.cash.netCnyMicros)}</strong><br /><span className={styles.muted}>{cashState(record.cash)}</span></td>
    <td data-label="净扣点数">{point(record.points.net)}</td>
    <td data-label="原记录">{href ? <Link className="link" href={href} onClick={() => onNavigate(record.id)}>查看原记录</Link> : <span className={styles.muted}>暂无可用入口</span>}<CashDetails cash={record.cash} points={record.points} /></td>
  </tr>;
}

function Category({ type, value }: { type: 'video' | 'image'; value: UsageCategorySummary }) {
  return <section className={styles.category} aria-label={`${labels[type]}用量`}>
    <h2>{type === 'video' ? <Film size={18} /> : <ImageIcon size={18} />}{labels[type]}</h2>
    <div className={styles.money}>{value.cash.netCnyMicros === null ? '实际费用待核' : `已确认 ${formatUsageMoney(value.cash.netCnyMicros)}`}</div>
    <p>{type === 'image' ? `请求 ${count(value.requestCount)} 次 · 产出 ${count(value.outputCount)} 张 · 可用 ${count(value.availableCount)} 张`
      : `任务 ${count(value.taskCount)} 个 · 成功 ${count(value.successfulCount)} 个 · 可用 ${count(value.availableCount)} 个`}</p>
    <p className={styles.muted}>{cashState(value.cash)}{value.cash.basis === 'USD_CNY_DISPLAY' || value.cash.basis === 'MIXED_CNY_USD' ? ' · 含人民币折算' : ''} · 净扣 {point(value.points.net)}</p>
    {(value.pendingCount !== 0 || value.conflictCount !== 0) && <p className={styles.muted}>待核 {count(value.pendingCount)} · 冲突 {count(value.conflictCount)}</p>}
    <CashDetails cash={value.cash} points={value.points} />
  </section>;
}

export function CompactUsageSummary({ report, error }: { report: Pick<UsageReportDTO, 'query' | 'summary' | 'restricted'> | null; error?: string | null }) {
  if (!report) return <p className={styles.muted}>{error || '本月本人用量读取中…'} <Link className="link" href="/usage">我的用量</Link></p>;
  return <div className={styles.compactSummary} aria-label="本月本人用量">
    <span className={styles.muted}>{report.query.month} · 本人全部项目</span>
    {(['video', 'image'] as const).map((type) => {
      const value = report.summary[type];
      const query = usageQueryParams({ ...report.query, project_id: null, member_owner_id: null, type, page: 1 });
      return <Link key={type} href={`/usage?${query}`}><strong>{labels[type]} {value.cash.netCnyMicros === null ? '实际费用待核' : `已确认 ${formatUsageMoney(value.cash.netCnyMicros)}`}</strong>
        {' · '}{type === 'image' ? `产出 ${count(value.outputCount)} 张` : `成功 ${count(value.successfulCount)} 个`}
        {value.cash.state !== 'confirmed' ? ` · ${cashState(value.cash)}` : ''}</Link>;
    })}
    {report.restricted && <span className={styles.muted}>部分来源受限</span>}
  </div>;
}

function UsageRecord({ record, onPreview, onNavigate }: { record: UsageRecordDTO; onPreview: (record: UsageRecordDTO) => void; onNavigate: (id: string) => void }) {
  const image = record.type === 'image';
  const download = safeHref(record.media?.downloadUrl);
  const preview = image ? safeHref(record.media?.imageUrl, true) : record.type === 'video' ? safeHref(record.media?.videoUrl) : null;
  const thumbnail = safeHref(record.media?.thumbnailUrl, image);
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [thumbnail]);
  const target = recordTarget(record);
  const poster = thumbnail && !broken ? <img src={thumbnail} alt={`${record.model || labels[record.type]}结果`} loading="lazy" onError={() => setBroken(true)} />
    : <span className={styles.muted}>{image ? '暂无可读图片' : '暂无可读缩略图'}</span>;
  return <article id={`usage-${record.id}`} className={image ? styles.imageRecord : styles.record}>
    {preview ? <button className={`${styles.poster} ${styles.posterButton}`} type="button" onClick={() => onPreview(record)} aria-label={image ? '查看图片' : '播放视频'} title={image ? '查看图片' : '播放视频'}>
      {poster}{!image && <Play size={22} className={styles.playIcon} aria-hidden="true" />}
    </button> : <div className={styles.poster}>{poster}</div>}
    <div>
      <h3>{record.model ? seedanceVideoModelLabel(record.model) : labels[record.type]} · {statusText(record.status)}</h3>
      <div className={styles.scopeLine}>{record.project.label} · <RelativeTime value={record.occurredAt} /></div>
      <p><strong>{record.cash.netCnyMicros === null ? '实际费用待核' : `已确认 ${formatUsageMoney(record.cash.netCnyMicros)}`}</strong> <span className={styles.muted}>{cashState(record.cash)}</span></p>
      <p className={styles.muted}>{image ? `原请求 ${count(record.requestCount)} 次 · 产出 ${count(record.outputCount)} 张 · 可用 ${count(record.availableCount)} 张` : `任务 ${count(record.taskCount)} · 可用 ${count(record.availableCount)}`} · 净扣 {point(record.points.net)}</p>
      <CashDetails cash={record.cash} points={record.points} />
    </div>
    <div className={styles.actions}>
      {preview && <button className="btn btn-secondary" type="button" onClick={() => onPreview(record)}>{image ? <ImageIcon size={15} /> : <Play size={15} />}{image ? '查看图片' : '播放视频'}</button>}
      {download && <a className="btn btn-secondary" href={download}><Download size={15} />下载</a>}
      {record.type === 'video' && !download && <span className={styles.muted}>{preview ? '稳定下载尚未就绪' : '视频暂不可播放或下载'}</span>}
      {target && <Link className="btn btn-secondary" href={target} onClick={() => onNavigate(record.id)}><ExternalLink size={15} />{image ? '原图片结果' : '查看原任务'}</Link>}
      {!target && !preview && <span className={styles.muted}>当前没有可用的原结果入口</span>}
    </div>
  </article>;
}

function Trend({ report, view }: { report: UsageReportDTO; view: ReturnType<typeof useUsageViewState> }) {
  const { metric } = view.value;
  if (!report.trend) return null;
  const amount = (value: UsageCategorySummary) => metric === 'cash' ? value.cash.netCnyMicros === null ? null : Number(value.cash.netCnyMicros) / 1e6 : value.points.net === null ? null : Number(value.points.net);
  const data = report.trend.items.map((item) => ({ month: item.month,
    video: Number.isFinite(amount(item.video)) ? amount(item.video) : null,
    image: Number.isFinite(amount(item.image)) ? amount(item.image) : null,
  }));
  return <details className={styles.trend} open={view.value.trendOpen} onToggle={(event) => { if (view.ready && view.value.trendOpen !== event.currentTarget.open) view.update({ trendOpen: event.currentTarget.open }); }}>
    <summary>{report.trend.range.label}</summary>
    <div className={styles.actions} aria-label="趋势单位">
      <button className="btn btn-secondary" type="button" aria-pressed={metric === 'cash'} onClick={() => view.update({ metric: 'cash' })}>人民币</button>
      <button className="btn btn-secondary" type="button" aria-pressed={metric === 'points'} onClick={() => view.update({ metric: 'points' })}>点数</button>
    </div>
    <div className={styles.trendChart} aria-label={`近六个月${metric === 'cash' ? '人民币' : '点数'}用量`}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <BarChart data={data} accessibilityLayer margin={{ top: 20, right: 12, bottom: 0, left: 10 }}>
          <CartesianGrid vertical={false} stroke="var(--border-color)" />
          <XAxis dataKey="month" tick={{ fill: 'var(--text-secondary)', fontSize: 12 }} />
          <YAxis domain={['auto', 'auto']} tick={{ fill: 'var(--text-secondary)', fontSize: 12 }} width={60} />
          <Tooltip contentStyle={{ background: 'var(--bg-panel)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }} />
          <Legend /><ReferenceLine y={0} stroke="var(--text-secondary)" />
          <Bar dataKey="video" name={metric === 'cash' ? '视频（元）' : '视频（点）'} fill="#57a9da" minPointSize={value => value === 0 ? 2 : 0} isAnimationActive={false} />
          <Bar dataKey="image" name={metric === 'cash' ? '图片（元）' : '图片（点）'} fill="#62b49b" minPointSize={value => value === 0 ? 2 : 0} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
    <details className={styles.trendValues}><summary>查看每月数值</summary><table className="table"><thead><tr><th>月份</th><th>视频</th><th>图片</th></tr></thead><tbody>
      {report.trend.items.map((item) => <tr key={item.month}><th scope="row">{item.month}</th>{(['video', 'image'] as const).map((type) => <td key={type}>{metric === 'cash' ? formatUsageMoney(item[type].cash.netCnyMicros) : point(item[type].points.net)}</td>)}</tr>)}
    </tbody></table></details>
  </details>;
}

export default function UsageWorkspace({ ownerId, projectId }: { ownerId: string; projectId?: string }) {
  const usage = useUsageWorkspace(ownerId, projectId);
  const view = useUsageViewState(usage.identity);
  const { query, report, current, busy, error, update } = usage;
  const [keyword, setKeyword] = useState('');
  const [preview, setPreview] = useState<UsageRecordDTO | null>(null);
  const [exportError, setExportError] = useState('');
  const [exportAsOf, setExportAsOf] = useState('');
  const [exporting, setExporting] = useState(false);
  const [members, setMembers] = useState<Array<{ id: string; label: string }>>([]);
  const [memberError, setMemberError] = useState('');
  const active = useRef(usage.identity); active.current = usage.identity;
  const anchorRestored = useRef('');
  useEffect(() => { setKeyword(query?.keyword || ''); }, [query?.keyword]);
  useEffect(() => { setPreview(null); }, [usage.request]);
  useEffect(() => { if (!report) setPreview(null); }, [report]);
  useEffect(() => { setPreview(null); setExportError(''); setExportAsOf(''); setExporting(false); setMembers([]); setMemberError(''); anchorRestored.current = ''; }, [usage.identity]);
  useEffect(() => {
    if (!projectId || !ownerId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}?section=members`, { cache: 'no-store', signal: controller.signal, headers: { 'x-app-session-user': ownerId } });
        const data = await response.json();
        if (controller.signal.aborted) return;
        if (!response.ok || data.viewer_id !== ownerId || data.project?.id !== projectId) throw new Error('成员范围暂时无法读取');
        setMembers((data.project.members || []).map((member: { user_id: string; user: { name?: string; username?: string } }) => ({ id: member.user_id, label: member.user?.name || member.user?.username || '项目成员' })));
      } catch (cause) { if (!controller.signal.aborted) setMemberError(cause instanceof Error ? cause.message : '成员范围暂时无法读取'); }
    })();
    return () => controller.abort();
  }, [ownerId, projectId]);
  useEffect(() => {
    if (!current || !report || !view.ready) return;
    const key = `sd2:usage-anchor:${usage.identity}`;
    let anchor = '';
    try { anchor = window.location.hash ? decodeURIComponent(window.location.hash.slice(1)) : localStorage.getItem(key) || ''; } catch { return; }
    if (!anchor || anchorRestored.current === anchor) return;
    const target = document.getElementById(anchor);
    if (target && report.records.items.some((r) => `usage-${r.id}` === anchor)) {
      const group = target.closest('details');
      if (group) group.open = true;
      target.scrollIntoView({ block: 'center' }); anchorRestored.current = anchor;
    }
  }, [current, report, usage.identity, view.ready]);
  if (!query) return <p role="status" className={styles.muted}>正在确认当前账号与用量范围…</p>;

  const onNavigate = (id: string) => { try { localStorage.setItem(`sd2:usage-anchor:${usage.identity}`, `usage-${id}`); } catch { /* Navigation still works without storage. */ } };
  const exportCsv = async () => {
    if (exporting || !current) return;
    const identity = usage.identity;
    setExporting(true); setExportError('');
    try {
      const response = await fetch(`${usage.endpoint}/export?${usage.request}`, { cache: 'no-store', headers: { 'x-app-session-user': ownerId } });
      if (!response.ok || !response.headers.get('content-type')?.includes('text/csv')) throw new Error('导出未成功，请重新核对当前范围后重试。');
      const blob = await response.blob();
      if (active.current !== identity) return;
      setExportAsOf(response.headers.get('X-Usage-As-Of') || '');
      const url = URL.createObjectURL(blob); const link = document.createElement('a');
      link.href = url; link.download = `usage-${query.month}-${query.type}.csv`; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { if (active.current === identity) setExportError(cause instanceof Error ? cause.message : '导出失败'); }
    finally { if (active.current === identity) setExporting(false); }
  };
  const groups = new Map<string, UsageRecordDTO[]>();
  if (report?.query.type === 'image') for (const record of report.records.items) {
    const key = record.groupId || record.id;
    groups.set(key, [...(groups.get(key) || []), record]);
  }
  return <div className={styles.workspace} aria-busy={busy}>
    <div className={styles.toolbar}>
      <label>月份<input className="input" type="month" value={query.month} onChange={(e) => { if (e.target.value) update({ month: e.target.value }); }} /></label>
      <label>时区<select className="input" value={query.time_zone} onChange={(e) => update({ time_zone: e.target.value })}>
        {Array.from(new Set([query.time_zone, Intl.DateTimeFormat().resolvedOptions().timeZone, 'Asia/Shanghai', 'America/Los_Angeles', 'UTC'])).filter(Boolean).map((zone) => <option key={zone} value={zone}>{zone}</option>)}
      </select></label>
      {!projectId && <label>项目<select className="input" value={query.project_id || ''} onChange={(e) => update({ project_id: e.target.value || null })}>
        <option value="">全部可读项目</option><option value="unassigned">未归属项目</option>
        {query.project_id && query.project_id !== 'unassigned' && !report?.projects.some((p) => p.id === query.project_id) && <option value={query.project_id}>所选项目（待核对）</option>}
        {report?.projects.filter((p) => p.id).map((p) => <option key={p.id} value={p.id!}>{p.label}</option>)}
      </select></label>}
      {projectId && <label>成员<select className="input" value={query.member_owner_id || ''} onChange={(e) => update({ member_owner_id: e.target.value || null })}>
        <option value="">全部可读成员</option><option value={ownerId}>仅本人</option>
        {query.member_owner_id && query.member_owner_id !== ownerId && !members.some((m) => m.id === query.member_owner_id) && <option value={query.member_owner_id}>所选成员（待核对）</option>}
        {members.filter((m) => m.id !== ownerId).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select></label>}
      <button className="btn btn-secondary" title="重置用量筛选" aria-label="重置用量筛选" type="button" onClick={() => update({}, true)}><RotateCcw size={16} /></button>
      <button className="btn btn-secondary" title="重新读取用量" aria-label="重新读取用量" type="button" disabled={busy} onClick={usage.reload}><RefreshCw size={16} /></button>
    </div>
    <div className={styles.scopeLine}>{projectId ? '本项目可读已确认小计' : '本人任务的已确认实际消耗'} · {query.month}发起 · {query.time_zone}
      {projectId && <Link className="link" href={`/usage?${usageQueryParams({ ...query, member_owner_id: null, page: 1 })}`}>查看本人用量</Link>}
    </div>
    {memberError && <p role="status" className={styles.muted}>{memberError}，未扩大成员范围。</p>}
    {error && <div className={styles.message} role="alert">{error}<button className="btn btn-secondary" onClick={usage.reload} disabled={busy}>重新读取</button></div>}
    {usage.storageUnavailable && <p className={styles.muted}>本次筛选无法保存在浏览器中，仍可正常查看。</p>}
    {report && <>
      {(!current || busy) && <p className={styles.muted} role="status">正在更新，以下保留上次读取的 {report.query.month} 范围。</p>}
      <div className={styles.summary}><Category type="video" value={report.summary.video} /><Category type="image" value={report.summary.image} /></div>
      {(report.restricted || report.coverage.some((c) => c.status !== 'complete')) && <details className={styles.coverage}>
        <summary>{report.restricted ? '部分来源受限，当前小计不代表全部成员完整费用' : '存在待核或未覆盖来源'}</summary>
        <ul>{report.coverage.map((c) => <li key={c.source}><strong>{c.label}</strong>：{c.detail}</li>)}</ul>
      </details>}
      <Trend report={report} view={view} />
    </>}
    {!report && busy && <p role="status" className={styles.muted}>正在读取用量…</p>}
    <div className={styles.tabs} aria-label="用量明细类型">{(['video', 'image', 'other'] as const).map((type) => <button type="button" key={type} aria-pressed={query.type === type} onClick={() => update({ type })}>{labels[type]}</button>)}</div>
    <form className={styles.toolbar} onSubmit={(e) => { e.preventDefault(); update({ keyword: keyword.trim() || null }); }}>
      <label className={styles.search}>搜索<input className="input" type="search" maxLength={120} value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="搜索描述、模型或任务编号" /></label>
      <button className="btn btn-secondary" type="submit">搜索</button>
      <label>状态<select className="input" value={query.status || ''} onChange={(e) => update({ status: e.target.value || null })}>
        <option value="">全部状态</option><option value="succeeded">已完成</option><option value="running">处理中</option><option value="queued">排队中</option><option value="failed">未完成</option><option value="cancelled">已取消</option><option value="unknown">提交结果待确认</option>
        {query.status && !['succeeded','running','queued','failed','cancelled','unknown'].includes(query.status) && <option value={query.status}>{statusText(query.status)}</option>}
      </select></label>
      <label>排序<select className="input" value={query.sort} onChange={(e) => update({ sort: e.target.value as 'newest' | 'oldest' | 'cost' })}><option value="newest">最近发起</option><option value="oldest">最早发起</option><option value="cost">确认消耗从高到低</option></select></label>
      <label>每页<select className="input" value={query.limit} onChange={(e) => update({ limit: Number(e.target.value) })}>{[12,20,50].includes(query.limit) ? null : <option value={query.limit}>{query.limit}</option>}<option value="12">12</option><option value="20">20</option><option value="50">50</option></select></label>
      <button className="btn btn-secondary" type="button" disabled={!current || busy || exporting} onClick={() => void exportCsv()}><Download size={16} />{exporting ? '正在导出…' : '导出全部匹配明细'}</button>
    </form>
    {exportError && <p role="alert" className={styles.muted}>{exportError}</p>}
    {exportAsOf && <p role="status" className={styles.muted}>已交给浏览器下载，导出截至 <RelativeTime value={exportAsOf} />。</p>}
    {report && <>
      <div className={styles.scopeLine}>{labels[report.query.type]} · 共 {report.records.total} 条 · 截至 <RelativeTime value={report.asOf} /></div>
      {report.records.updated && <p role="status" className={styles.muted}>记录已更新，已显示有效页。</p>}
      {report.query.type === 'other' && <p>{report.summary.other.cash.netCnyMicros === null ? '其他业务实际费用待核' : `其他业务已确认 ${formatUsageMoney(report.summary.other.cash.netCnyMicros)}`} · 运行 {count(report.summary.other.taskCount)} 次</p>}
      {report.records.items.length === 0 ? <p className={styles.muted}>当前范围没有可读记录。{report.restricted ? '部分来源受限。' : ''}</p>
        : projectId ? <div className={styles.projectTable}><table className="table"><thead><tr><th>时间</th><th>类型 / 模型</th><th>生成状态</th><th>确认人民币</th><th>净扣点数</th><th>原记录与明细</th></tr></thead><tbody>{report.records.items.map((record) => <ProjectUsageRow key={record.id} record={record} onNavigate={onNavigate} />)}</tbody></table></div>
        : report.query.type === 'image' ? <div className={styles.records}>{Array.from(groups, ([id, records]) => <details className={styles.group} key={id} open={view.value.groups[id] ?? records.length === 1} onToggle={(event) => { const open = event.currentTarget.open; if (view.ready && open !== (view.value.groups[id] ?? records.length === 1)) view.update({ groups: { ...view.value.groups, [id]: open } }); }}>
          <summary>{records[0].groupId ? '原批次' : '原请求'} · 当前页 {records.length} 条图片记录 · <span className={styles.muted}>费用保留原请求口径</span></summary>
          <div className={styles.imageGrid}>{records.map((record) => <UsageRecord key={record.id} record={record} onPreview={setPreview} onNavigate={onNavigate} />)}</div>
        </details>)}</div> : <div className={report.query.type === 'video' ? styles.videoGrid : styles.records}>{report.records.items.map((record) => <UsageRecord key={record.id} record={record} onPreview={setPreview} onNavigate={onNavigate} />)}</div>}
      <PaginationControls page={report.records.page} totalPages={Math.max(1, Math.ceil(report.records.total / report.records.pageSize))} total={report.records.total} pageSize={report.records.pageSize} label="用量记录" busy={busy || !current} onPageChange={(page) => update({ page })} />
    </>}
    {preview?.type === 'image' && safeHref(preview.media?.imageUrl, true) && <MediaPreview src={safeHref(preview.media?.imageUrl, true)!} type="image" title={preview.model || '原图片结果'} previewKey={`usage-image:${preview.imageTaskId || preview.id}`} onClose={() => setPreview(null)} />}
    {preview?.type === 'video' && safeHref(preview.media?.videoUrl) && <MediaPreview src={safeHref(preview.media?.videoUrl)!} type="video" title={preview.model || '原视频结果'}
      poster={safeHref(preview.media?.thumbnailUrl) || undefined} previewKey={preview.id}
      contentKey={preview.sourceKind === 'video_task' && preview.id.startsWith('video_task:') ? `video_task:${preview.id.slice('video_task:'.length)}` : undefined}
      onClose={() => setPreview(null)} />}
  </div>;
}
