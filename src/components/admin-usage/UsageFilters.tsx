'use client';
import { ProjectSelector } from '@/components/ProjectSelector';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Filter, RotateCcw, X } from 'lucide-react';
import type { UsageReport } from '@/lib/admin/usage-types';
import { ATTRIBUTION_LABELS, COST_LABELS, KIND_LABELS, RESULT_LABELS, RETENTION_LABELS, SOURCE_LABELS, STATUS_LABELS } from './format';
import { actualRangeLabel, defaultUsageSearch, usageHref, type QueryPatch, type UsageView } from './query';

type Props = {
  search: string; view: UsageView; report: UsageReport | null; busy: boolean; stale: boolean;
  update: (patch: QueryPatch) => void; reset: () => void;
  onCatalogChange: () => void;
  advancedOpen: boolean; onAdvanced: (open: boolean) => void;
};
const RANGES = [['month', '月'], ['quarter', '季度'], ['half', '半年'], ['year', '年'], ['recent6m', '最近6个日历月'], ['all', '全部'], ['custom', '自定义'], ['7d', '最近7天'], ['30d', '最近30天']];
const FILTER_NAMES: Record<string, string> = { owner_user_id: '成员', project_id: '项目', kind: '业务', source_kind: '来源', result_ready: '结果文件', model: '模型', provider: '供应商', status: '执行', cost_status: '费用', attribution: '归属', resolution: '分辨率', keyword: '记录搜索', retention_status: '留存' };

function SelectOptions({ value, values, empty }: { value: string; values: Array<[string, string]>; empty?: string }) {
  return <>
    {empty && <option value="">{empty}</option>}
    {value && !values.some(([id]) => id === value) && <option value={value}>{value}（请核对）</option>}
    {values.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
  </>;
}

export default function UsageFilters({ search, view, report, busy, stale, update, reset, advancedOpen, onAdvanced, onCatalogChange }: Props) {
  const params = new URLSearchParams(search);
  const [draft, setDraft] = useState(() => Object.fromEntries(params));
  useEffect(() => { setDraft(Object.fromEntries(new URLSearchParams(search))); }, [search]);
  const period = draft.range || 'month';
  const edit = (key: string, value: string) => setDraft(current => ({ ...current, [key]: value }));
  const applyPeriod = () => {
    const defaults = defaultUsageSearch();
    const month = Number(draft.month ?? report?.query.month ?? defaults.get('month'));
    update({ range: period, year: ['month', 'quarter', 'half', 'year'].includes(period) ? draft.year ?? report?.query.year ?? defaults.get('year') : null,
      month: period === 'month' ? draft.month ?? report?.query.month ?? defaults.get('month') : null,
      quarter: period === 'quarter' ? draft.quarter ?? report?.query.quarter ?? String(Math.ceil(month / 3)) : null,
      half: period === 'half' ? draft.half ?? report?.query.half ?? (month <= 6 ? '1' : '2') : null,
      date_from: period === 'custom' ? draft.date_from : null, date_to: period === 'custom' ? draft.date_to : null });
  };
  const ownerOptions: Array<[string, string]> = (report?.members.rows || []).filter(row => row.id !== null).map(row => [row.id!, row.label]);
  const projectOptions: Array<[string, string]> = (report?.projects.rows || []).filter(row => row.id !== null).map(row => [row.id!, row.label]);
  const tagged = Object.keys(FILTER_NAMES).filter(key => params.has(key));

  return <section className="au-filters" aria-label="使用分析范围">
    <div className="au-filter-main">
      <form className="au-period" onSubmit={event => { event.preventDefault(); applyPeriod(); }}>
        <label><span>时间范围</span><select className="input" value={period} onChange={event => { const defaults = defaultUsageSearch(); setDraft(current => ({ year: defaults.get('year')!, month: defaults.get('month')!, quarter: String(Math.ceil(Number(defaults.get('month')) / 3)), half: Number(defaults.get('month')) <= 6 ? '1' : '2', ...current, range: event.target.value })); }}><SelectOptions value={period} values={RANGES as Array<[string, string]>} /></select></label>
        {['month', 'quarter', 'half', 'year'].includes(period) && <label className="au-year"><span>年份</span><input className="input" type="number" min="1" max="9998" required value={draft.year ?? report?.query.year ?? ''} onChange={event => edit('year', event.target.value)} placeholder="年份" /></label>}
        {period === 'month' && <label><span>月份</span><select className="input" required value={draft.month ?? String(report?.query.month ?? '')} onChange={event => edit('month', event.target.value)}><option value="" disabled>请选择</option><SelectOptions value={draft.month ?? String(report?.query.month ?? '')} values={Array.from({ length: 12 }, (_, i) => [String(i + 1), `${i + 1}月`])} /></select></label>}
        {period === 'quarter' && <label><span>自然季度</span><select className="input" required value={draft.quarter ?? String(report?.query.quarter ?? '')} onChange={event => edit('quarter', event.target.value)}><option value="" disabled>请选择</option><SelectOptions value={draft.quarter ?? String(report?.query.quarter ?? '')} values={Array.from({ length: 4 }, (_, i) => [String(i + 1), `第${i + 1}季度`])} /></select></label>}
        {period === 'half' && <label><span>半年</span><select className="input" required value={draft.half ?? String(report?.query.half ?? '')} onChange={event => edit('half', event.target.value)}><option value="" disabled>请选择</option><SelectOptions value={draft.half ?? String(report?.query.half ?? '')} values={[["1", '上半年'], ["2", '下半年']]} /></select></label>}
        {period === 'custom' && <>
          <label><span>开始日期</span><input className="input" type="date" required value={draft.date_from || ''} onChange={event => edit('date_from', event.target.value)} /></label>
          <label><span>结束日期</span><input className="input" type="date" required value={draft.date_to || ''} onChange={event => edit('date_to', event.target.value)} /></label>
        </>}
        <button className="btn btn-secondary" type="submit">应用时间</button>
      </form>
      <div className="au-common-filters">
        <label><span>业务类型</span><select className="input" value={params.get('kind') || ''} onChange={event => update({ kind: event.target.value })}><SelectOptions value={params.get('kind') || ''} values={Object.entries(KIND_LABELS)} empty="全部业务" /></select></label>
        {view !== 'members' && <label><span>消费归属成员</span><select className="input" value={params.get('owner_user_id') || ''} onChange={event => update({ owner_user_id: event.target.value })}><SelectOptions value={params.get('owner_user_id') || ''} values={ownerOptions} empty="全部成员" /></select><Link className="au-quiet-link" href={usageHref('members', search)}>查找全部成员</Link></label>}
        {view !== 'projects' && <label><span>项目</span><ProjectSelector onCatalogChange={onCatalogChange}  className="input" value={params.get('project_id') || ''} onChange={event => update({ project_id: event.target.value })}><SelectOptions value={params.get('project_id') || ''} values={projectOptions} empty="全部项目" /></ProjectSelector><Link className="au-quiet-link" href={usageHref('projects', search)}>查找全部项目</Link></label>}
      </div>
    </div>
    <div className="au-filter-meta">
      <span>{report ? `${stale ? '上次读取范围：' : ''}${actualRangeLabel(report.query)}` : '实际起止以读取结果为准'} <span className="au-muted">· {report && stale ? report.query.time_zone : params.get('time_zone')}</span></span>
      <div className="au-actions"><button className="au-text-button" type="button" aria-expanded={advancedOpen} aria-controls="au-advanced-filters" onClick={() => onAdvanced(!advancedOpen)}><Filter size={14} />更多筛选</button><button className="au-text-button" type="button" onClick={reset}><RotateCcw size={14} />重置分析范围</button></div>
    </div>
    {advancedOpen && <div id="au-advanced-filters" className="au-advanced">
      <label><span>业务来源</span><select className="input" value={params.get('source_kind') || ''} onChange={event => update({ source_kind: event.target.value })}><SelectOptions value={params.get('source_kind') || ''} values={Object.entries(SOURCE_LABELS)} empty="全部来源" /></select></label>
      <label><span>结果文件</span><select className="input" value={params.get('result_ready') || ''} onChange={event => update({ result_ready: event.target.value })}><SelectOptions value={params.get('result_ready') || ''} values={Object.entries(RESULT_LABELS)} empty="全部文件状态" /></select></label>
      {(['model', 'provider', 'status'] as const).map(key => {
        const values = report?.options[key === 'model' ? 'models' : key === 'provider' ? 'providers' : 'statuses'] || [];
        return <label key={key}><span>{FILTER_NAMES[key]}</span><select className="input" value={params.get(key) || ''} onChange={event => update({ [key]: event.target.value })}><SelectOptions value={params.get(key) || ''} values={values.map(value => [value, key === 'status' ? STATUS_LABELS[value] || value : value])} empty="全部" /></select></label>;
      })}
      <label><span>费用状态</span><select className="input" value={params.get('cost_status') || ''} onChange={event => update({ cost_status: event.target.value })}><SelectOptions value={params.get('cost_status') || ''} values={Object.entries(COST_LABELS)} empty="全部" /></select></label>
      <label><span>归属依据</span><select className="input" value={params.get('attribution') || ''} onChange={event => update({ attribution: event.target.value })}><SelectOptions value={params.get('attribution') || ''} values={Object.entries(ATTRIBUTION_LABELS)} empty="全部" /></select></label>
      <label><span>留存状态</span><select className="input" value={params.get('retention_status') || ''} onChange={event => update({ retention_status: event.target.value })}><SelectOptions value={params.get('retention_status') || ''} values={Object.entries(RETENTION_LABELS)} empty="全部" /></select></label>
      <form className="au-inline-form" onSubmit={event => { event.preventDefault(); update({ resolution: draft.resolution }); }}><label><span>分辨率</span><input className="input" value={draft.resolution || ''} onChange={event => edit('resolution', event.target.value)} placeholder="原规格" /></label><button className="btn btn-secondary" type="submit">应用</button></form>
      <form className="au-inline-form" onSubmit={event => { event.preventDefault(); update({ time_zone: draft.time_zone }); }}><label><span>统计时区</span><input className="input" required value={draft.time_zone || ''} onChange={event => edit('time_zone', event.target.value)} placeholder="IANA 时区" /></label><button className="btn btn-secondary" type="submit">应用</button></form>
      <label><span>每页数量</span><select className="input" value={params.get('page_size') || '30'} onChange={event => update({ page_size: event.target.value })}><SelectOptions value={params.get('page_size') || '30'} values={['20', '30', '50', '100'].map(value => [value, `${value}条`])} /></select></label>
    </div>}
    {tagged.length > 0 && <div className="au-filter-tags" aria-label="当前条件">{tagged.map(key => {
      const raw = params.get(key)!;
      const labels: Record<string, Record<string, string>> = { kind: KIND_LABELS, source_kind: SOURCE_LABELS, result_ready: RESULT_LABELS, retention_status: RETENTION_LABELS, cost_status: COST_LABELS, attribution: ATTRIBUTION_LABELS, status: STATUS_LABELS };
      const label = key === 'owner_user_id' ? ownerOptions.find(([id]) => id === raw)?.[1] || (raw === 'unassigned' ? '成员未归属' : raw) : key === 'project_id' ? projectOptions.find(([id]) => id === raw)?.[1] || (raw === 'unassigned' ? '未归属项目' : raw) : labels[key]?.[raw] || raw;
      return <button key={key} className="au-filter-tag" type="button" onClick={() => update({ [key]: null })} aria-label={`移除${FILTER_NAMES[key]}：${label}`}>{FILTER_NAMES[key]}：{label}<X size={13} /></button>;
    })}</div>}
    {busy && report && <span className="au-sr-only" role="status">正在更新，以下仍为上次读取结果。</span>}
  </section>;
}
