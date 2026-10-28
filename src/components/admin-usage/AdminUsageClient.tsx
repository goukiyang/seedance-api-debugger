'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Download, RefreshCw, Settings } from 'lucide-react';
import { LoadingSkeleton } from '@/components/LoadingState';
import { RelativeTime } from '@/components/RelativeTime';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import { useAdminUsageState } from '@/hooks/useAdminUsageState';
import type { UsageDistribution, UsageReport, UsageSummary } from '@/lib/admin/usage-types';
import { release } from '@/lib/release';
import UsageFilters from './UsageFilters';
import UsageRecords from './UsageRecords';
import { EntireProjectLink, UsageAttention, UsageCoverageDetails, UsageDirectory, UsageDistributionTable, UsageStats, UsageTrend } from './UsageVisuals';
import { actualRangeLabel, usageHref, type UsageView } from './query';
import { points, summaryCost } from './format';
import '../../app/admin/admin-usage.css';

type Props = {
  viewerId: string; view: UsageView;
  support?: ReactNode;
  management?: (selectedId: string | null) => ReactNode;
};
type ReadResult = { account: string; search: string; report: UsageReport };

function isUsageReport(value: unknown): value is UsageReport {
  if (!value || typeof value !== 'object') return false;
  const report = value as Partial<UsageReport>;
  return !!report.query && !!report.summary && typeof report.dataAsOf === 'string'
    && typeof report.reportFingerprint === 'string' && Array.isArray(report.records?.rows)
    && Array.isArray(report.members?.rows) && Array.isArray(report.projects?.rows)
    && Array.isArray(report.memberDirectory?.rows) && Array.isArray(report.projectDirectory?.rows)
    && Array.isArray(report.trend) && Array.isArray(report.coverage) && Array.isArray(report.exceptions);
}
function exportFileName(header: string | null, type: string) {
  const raw = header?.match(/filename\*=UTF-8''([^;]+)/i)?.[1] || header?.match(/filename="?([^";]+)"?/i)?.[1];
  try {
    const name = raw ? decodeURIComponent(raw) : '';
    if (/^[a-zA-Z0-9_. ()-]{1,150}\.csv$/.test(name)) return name;
  } catch { /* Use the neutral filename below. */ }
  return `usage-${type}.csv`;
}

function exportSummary(headers: Headers): UsageSummary | null {
  const raw = headers.get('X-Usage-Summary');
  if (!raw || raw.length > 20_000) return null;
  try {
    const json = headers.get('X-Usage-Summary-Encoding') === 'base64url-json'
      ? new TextDecoder().decode(Uint8Array.from(atob(raw.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0)))
      : decodeURIComponent(raw);
    const value = JSON.parse(json) as Partial<UsageSummary>;
    if (!Number.isSafeInteger(value.usageCount) || !Array.isArray(value.confirmedCost)
      || !(value.confirmedCostCnyMicros === null || typeof value.confirmedCostCnyMicros === 'string')
      || !(value.chargedPoints === null || typeof value.chargedPoints === 'string')) return null;
    return value as UsageSummary;
  } catch { return null; }
}

export default function AdminUsageClient({ viewerId, view, support, management }: Props) {
  const state = useAdminUsageState(viewerId, view);
  const { search, update, expanded, toggleExpanded, restoreLayout } = state;
  const [result, setResult] = useState<ReadResult | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [readStatus, setReadStatus] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  const [exportType, setExportType] = useState<'summary' | 'records'>('summary');
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState('');
  const [exportCutoff, setExportCutoff] = useState<string | null>(null);
  const [exportedSummary, setExportedSummary] = useState<UsageSummary | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [selectedLabel, setSelectedLabel] = useState<{ account: string; id: string; label: string } | null>(null);
  const [supportVisited, setSupportVisited] = useState(false);
  const epoch = useRef(0);
  const current = useRef({ viewerId, search });
  current.current = { viewerId, search };
  const exportController = useRef<AbortController | null>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const pendingDetailFocus = useRef(false);
  const directoryScroll = useRef(0);
  const recordAnchorSearch = useRef<string | null>(null);
  const report = result?.account === viewerId ? result.report : null;
  const currentReport = result?.account === viewerId && result.search === search;
  const params = new URLSearchParams(search || '');
  const selectedId = params.get(view === 'members' ? 'owner_user_id' : 'project_id');
  const isUnassigned = selectedId === 'unassigned';
  const displaySelectedId = report?.query[view === 'members' ? 'owner_user_id' : 'project_id'] || null;
  const selectedRow = view === 'overview' ? null : view === 'members' ? report?.selectedMember : report?.selectedProject;
  const selectedName = selectedRow?.label || (selectedLabel?.account === viewerId && selectedLabel.id === displaySelectedId ? selectedLabel.label : null)
    || (displaySelectedId === 'unassigned' ? view === 'members' ? '成员未归属' : '未归属项目' : displaySelectedId ? `${view === 'members' ? '成员' : '项目'} · ${displaySelectedId}` : view === 'members' ? '全部成员' : '全部项目');
  const supportId = view === 'members' ? 'account-management' : view === 'projects' ? 'project-management' : 'legacy-support';
  const supportTitle = view === 'members' ? '账号与额度' : view === 'projects' ? '项目管理' : '视频统计、余额与管理入口';
  useEffect(() => { if (expanded.includes(supportId)) setSupportVisited(true); }, [expanded, supportId]);

  useEffect(() => {
    if (search === null) return;
    const controller = new AbortController();
    const requestEpoch = ++epoch.current;
    setBusy(true); setError(''); setReadStatus(null);
    async function load() {
      try {
        const response = await fetch(`/api/admin/usage-analytics?${search}`, { cache: 'no-store', signal: controller.signal, credentials: 'same-origin' });
        if (controller.signal.aborted || requestEpoch !== epoch.current || current.current.viewerId !== viewerId || current.current.search !== search) return;
        if (!response.ok) {
          setReadStatus(response.status);
          if (response.status === 401 || response.status === 403) setResult(null);
          const payload = await response.json().catch(() => null) as { error?: unknown } | null;
          throw new Error(typeof payload?.error === 'string' ? payload.error : response.status === 400 ? '筛选条件无效，请核对或重置分析范围。' : response.status === 401 || response.status === 403 ? '当前登录状态或权限不能读取管理报表。' : '使用分析暂时未读到，请重试本次读取。');
        }
        const payload: unknown = await response.json();
        if (!isUsageReport(payload)) throw new Error('报表返回格式暂不匹配，请稍后重新读取。');
        if (controller.signal.aborted || requestEpoch !== epoch.current || current.current.viewerId !== viewerId || current.current.search !== search) return;
        setResult({ account: viewerId, search: search!, report: payload });
        state.rememberValidScope(search!);
        setExportMessage(message => message.replace('正在同步当前分析。', '当前分析已同步。'));
      } catch (failure) {
        if (!controller.signal.aborted && requestEpoch === epoch.current && current.current.viewerId === viewerId && current.current.search === search) {
          setError(failure instanceof Error ? failure.message : '报表未读到，请重试。');
          setExportMessage(message => message.replace('正在同步当前分析。', '当前分析尚未同步，可重新读取。'));
        }
      } finally {
        if (!controller.signal.aborted && requestEpoch === epoch.current) setBusy(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [search, viewerId, reload, state.rememberValidScope]);

  useEffect(() => {
    if (!report || !currentReport || busy) return;
    if (window.location.hash === '#usage-records' && recordAnchorSearch.current !== search) {
      recordAnchorSearch.current = search;
      toggleExpanded('mobile-list', false); toggleExpanded('mobile-detail', true); setMobileDetail(true);
      const frame = requestAnimationFrame(() => document.getElementById('usage-records')?.scrollIntoView({ block: 'start', behavior: 'auto' }));
      return () => cancelAnimationFrame(frame);
    }
    return restoreLayout();
  }, [report, currentReport, busy, restoreLayout, search, toggleExpanded]);
  useEffect(() => {
    setMobileDetail(!expanded.includes('mobile-list') && (!!selectedId || expanded.includes('mobile-detail')));
  }, [selectedId, isUnassigned, expanded]);
  useEffect(() => {
    if (!pendingDetailFocus.current || busy || !currentReport) return;
    const frame = requestAnimationFrame(() => {
      pendingDetailFocus.current = false;
      detailHeading.current?.focus({ preventScroll: true });
      if (window.matchMedia('(max-width: 850px)').matches) detailHeading.current?.scrollIntoView({ block: 'start', behavior: 'auto' });
    });
    return () => cancelAnimationFrame(frame);
  }, [busy, currentReport]);
  useEffect(() => {
    exportController.current?.abort(); setExporting(false); setExportMessage(''); setExportCutoff(null); setExportedSummary(null);
    return () => exportController.current?.abort();
  }, [search, viewerId]);

  const download = useCallback(async () => {
    if (!search || exporting) return;
    const controller = new AbortController(); exportController.current = controller;
    setExporting(true); setExportMessage('正在准备完整范围的导出…');
    try {
      const query = new URLSearchParams(search); query.set('type', exportType);
      const response = await fetch(`/api/admin/usage-analytics/export?${query}`, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? '当前权限不能导出报表，请重新确认登录。' : '导出未完成，可重试同一范围。');
      if (!response.headers.get('content-type')?.toLowerCase().includes('text/csv')) throw new Error('未收到可用的 CSV 文件，请稍后重试导出。');
      const blob = await response.blob();
      if (controller.signal.aborted || current.current.viewerId !== viewerId || current.current.search !== search) return;
      const cutoff = response.headers.get('X-Usage-Data-As-Of') || response.headers.get('X-Data-As-Of');
      const validCutoff = cutoff && Number.isFinite(Date.parse(cutoff)) ? cutoff : null;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = exportFileName(response.headers.get('content-disposition'), exportType);
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      // Revocation on the next idle turn lets the browser take ownership first.
      requestAnimationFrame(() => URL.revokeObjectURL(url));
      setExportCutoff(validCutoff);
      setExportedSummary(exportSummary(response.headers));
      setExportMessage(`完整${exportType === 'summary' ? '汇总' : '明细'}已交给浏览器下载${validCutoff ? '，正在同步当前分析。' : '，导出截至时间未返回，请以 CSV 内时间为准。'}`);
      state.preserveLayout();
      setReload(value => value + 1);
    } catch (failure) {
      if (!controller.signal.aborted) setExportMessage(failure instanceof Error ? failure.message : '导出未完成，可重试。');
    } finally { if (!controller.signal.aborted) setExporting(false); }
  }, [exportType, exporting, search, viewerId, state.preserveLayout]);

  function selectRow(row: UsageDistribution) {
    directoryScroll.current = window.scrollY;
    pendingDetailFocus.current = true;
    setSelectedLabel({ account: viewerId, id: row.id || 'unassigned', label: row.label });
    update({ [view === 'members' ? 'owner_user_id' : 'project_id']: row.id || 'unassigned',
      [view === 'members' ? 'members_page' : 'projects_page']: view === 'members' ? report?.memberDirectory.page : report?.projectDirectory.page,
      [view === 'members' ? 'projects_page' : 'members_page']: 1, records_page: 1, page: 1 }, { pages: false });
    toggleExpanded('mobile-list', false); toggleExpanded('mobile-detail', true);
    setMobileDetail(true);
    if (currentReport && selectedId === (row.id || 'unassigned')) requestAnimationFrame(() => {
      pendingDetailFocus.current = false;
      detailHeading.current?.focus({ preventScroll: true });
      if (window.matchMedia('(max-width: 850px)').matches) detailHeading.current?.scrollIntoView({ block: 'start', behavior: 'auto' });
    });
  }
  function openSupport() {
    toggleExpanded(supportId, true); setSupportVisited(true);
    requestAnimationFrame(() => {
      const element = document.getElementById(supportId);
      element?.scrollIntoView({ block: 'start', behavior: 'auto' });
      element?.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true });
    });
  }

  return <div className={`admin-usage-page au-view-${view}${mobileDetail ? ' au-show-detail' : ''}`}>
    <header className="au-page-head"><div><p className="au-eyebrow">管理中心</p><h1>使用与费用</h1></div><div className="au-page-tools"><Link className="au-version au-quiet-link" href="/account">SD2 v{release.version}</Link>{(support || management) && readStatus !== 401 && readStatus !== 403 && <button className="au-text-button" type="button" onClick={openSupport}><Settings size={14} />{view === 'overview' ? '管理入口' : supportTitle}</button>}<div className="au-export">
      <label><span className="au-sr-only">导出内容</span><select className="input" value={exportType} onChange={event => setExportType(event.target.value as 'summary' | 'records')}><option value="summary">完整汇总 CSV</option><option value="records">完整明细 CSV</option></select></label>
      <button className="btn btn-secondary" type="button" onClick={download} disabled={!search || exporting || readStatus === 400 || readStatus === 401 || readStatus === 403}><Download size={15} />{exporting ? '导出中…' : '导出当前范围'}</button>
    </div></div></header>
    <nav className="au-tabs" aria-label="使用分析视图">{(['overview', 'members', 'projects'] as UsageView[]).map(item => <Link key={item} href={usageHref(item, search || '')} aria-current={view === item ? 'page' : undefined}>{item === 'overview' ? '总览' : item === 'members' ? '成员' : '项目'}</Link>)}</nav>
    {search !== null && <UsageFilters onCatalogChange={() => setReload(value => value + 1)} search={search} view={view} report={report} busy={busy} stale={!currentReport} update={update} reset={state.reset} advancedOpen={expanded.includes('filters')} onAdvanced={open => toggleExpanded('filters', open)} />}
    <div className="au-read-meta" role="status" aria-live="polite"><span>{busy ? report ? '正在更新，以下为上次读取结果。' : '正在读取使用记录…' : error ? report ? '本次读取未完成，以下仍为上次结果。' : '本次读取未完成。' : report ? <>数据更新于 <RelativeTime value={report.dataAsOf} /></> : '尚未取得报表。'}</span><button className="au-text-button" type="button" onClick={() => { state.preserveLayout(); setReload(value => value + 1); }} disabled={busy || search === null}><RefreshCw size={14} />重新读取</button></div>
    {error && <div className="au-read-error" role="status"><p>{error}</p><div className="au-actions"><button className="btn btn-secondary" type="button" onClick={() => setReload(value => value + 1)} disabled={busy}>重试读取</button>{readStatus === 400 && <button className="au-text-button" type="button" onClick={state.reset}>重置分析范围</button>}{(readStatus === 401 || readStatus === 403) && <Link className="au-link" href="/login">前往登录</Link>}</div></div>}
    {(exportMessage || exportCutoff) && <div className="au-export-status" role="status"><span>{exportMessage}</span>{exportCutoff && <span>本次导出截至 <RelativeTime value={exportCutoff} /></span>}{exportedSummary && <span>文件汇总：{exportedSummary.usageCount.toLocaleString('zh-CN')} 次使用 · 已确认成本 {summaryCost(exportedSummary)} · 已实扣 {points(exportedSummary.chargedPoints)} 点</span>}</div>}
    {!report && !error && <div className="au-initial-loading"><LoadingSkeleton label="正在读取全量使用分析" /></div>}
    {report && search !== null && <div className={`au-report${!currentReport ? ' au-report-stale' : ''}`} aria-busy={busy} onClickCapture={event => { if (!currentReport) { event.preventDefault(); event.stopPropagation(); } }} onKeyDownCapture={event => { if (!currentReport && ['Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); } }}>
      {view === 'overview' ? <>
        <UsageStats report={report} open={expanded.includes('calculation')} onToggle={open => toggleExpanded('calculation', open)} /><UsageAttention report={report} /><UsageTrend report={report} search={search} update={update} dataOpen={expanded.includes('trend-data')} onDataToggle={open => toggleExpanded('trend-data', open)} />
        <div className="au-distributions"><UsageDistributionTable type="projects" page={report.projects} search={search} compact /><UsageDistributionTable type="members" page={report.members} search={search} compact /></div>
        <UsageRecords page={report.records} search={search} view={view} busy={busy} update={update} expanded={expanded} toggleExpanded={toggleExpanded} />
      </> : <div className="au-master-detail">
        <div className="au-master-pane"><UsageDirectory type={view} report={report} search={search} selectedId={selectedId} busy={busy} update={update} onSelect={selectRow} onAll={() => { directoryScroll.current = window.scrollY; pendingDetailFocus.current = true; update({ [view === 'members' ? 'owner_user_id' : 'project_id']: null }); toggleExpanded('mobile-list', false); toggleExpanded('mobile-detail', true); setMobileDetail(true); }} /></div>
        <div className="au-detail-pane"><button className="au-text-button au-mobile-back" type="button" onClick={() => { setMobileDetail(false); toggleExpanded('mobile-list', true); toggleExpanded('mobile-detail', false); requestAnimationFrame(() => { document.querySelector<HTMLButtonElement>('.au-directory [aria-current="true"]')?.focus({ preventScroll: true }); window.scrollTo({ top: directoryScroll.current, behavior: 'auto' }); }); }}><ArrowLeft size={16} />返回{view === 'members' ? '成员' : '项目'}列表</button>
          <div className="au-detail-heading"><div><p className="au-eyebrow">{view === 'members' ? '消费归属成员' : '项目使用'}</p><h2 ref={detailHeading} tabIndex={-1}>{view === 'members' && displaySelectedId && displaySelectedId !== 'unassigned' ? <UserIdentityBadge user={{ id: displaySelectedId, name: selectedName }} /> : selectedName}</h2><p className="au-muted">{actualRangeLabel(report.query)}</p></div><div className="au-actions"><EntireProjectLink search={search} />{management && <button className="au-text-button" type="button" onClick={openSupport}>{supportTitle}</button>}</div></div>
          <UsageStats report={report} open={expanded.includes('calculation')} onToggle={open => toggleExpanded('calculation', open)} /><UsageAttention report={report} />
          <UsageTrend report={report} search={search} update={update} dataOpen={expanded.includes('trend-data')} onDataToggle={open => toggleExpanded('trend-data', open)} />
          <UsageDistributionTable type={view === 'members' ? 'projects' : 'members'} page={view === 'members' ? report.projects : report.members} search={search} compact />
          <UsageRecords page={report.records} search={search} view={view} busy={busy} update={update} expanded={expanded} toggleExpanded={toggleExpanded} />
        </div>
      </div>}
      <UsageCoverageDetails report={report} open={expanded.includes('coverage')} onToggle={open => toggleExpanded('coverage', open)} />
    </div>}
    {(support || management) && readStatus !== 401 && readStatus !== 403 && <details id={supportId} className="au-support" open={expanded.includes(supportId)} onToggle={event => { toggleExpanded(supportId, event.currentTarget.open); if (event.currentTarget.open) setSupportVisited(true); }}><summary>{supportTitle}</summary>{supportVisited && <div className="au-support-body">{management ? management(selectedId) : support}</div>}</details>}
  </div>;
}
