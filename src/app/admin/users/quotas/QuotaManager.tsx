'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Archive, Copy, Pause, Play, Plus, RefreshCw, Save } from 'lucide-react';
import PageBanner from '@/components/PageBanner';
import { useProductDialog } from '@/components/useProductDialog';
import { LoadingSkeleton, LoadingStatus } from '@/components/LoadingState';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import { USER_PROFILE_OPTIONS } from '@/lib/users/profiles';
import { quotaWindow, type QuotaConfig, type QuotaRule } from '@/lib/credits/periodic-types';
import type { quotaAdminView } from '@/lib/credits/periodic';
import styles from './quotas.module.css';

type View = Awaited<ReturnType<typeof quotaAdminView>>;
type BatchResult = {
  processed: number;
  granted: number;
  skipped: number;
  failed: number;
  failures: { user_id: string; reason: string }[];
  cursor: string | null;
  scope?: string;
};
const statuses = { draft: '未启用', active: '已启用', paused: '已暂停', archived: '已归档' };
const units = { hour: '小时', day: '天', week: '周', month: '个月' };
const accountScopes = { internal: '内部账号', external: '外部账号', all: '内部与外部账号' };
function date(value: string | Date | null | undefined) {
  return value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '暂无';
}
function sameQuotaSettings(a: QuotaConfig, b: QuotaConfig) {
  return JSON.stringify({ ...a, anchor: '' }) === JSON.stringify({ ...b, anchor: '' });
}
function audience(config: QuotaConfig) {
  const profiles = USER_PROFILE_OPTIONS.filter(profile => config.profiles.includes(profile.value)).map(profile => profile.label);
  const selected = [profiles.length ? profiles.join('、') : '', config.user_ids.length ? `指定成员 ${config.user_ids.length} 人` : '']
    .filter(Boolean).join(' 或 ');
  return `${accountScopes[config.account_type]}；${selected || '未选择成员'}；排除 ${config.exclude_ids.length} 人`;
}
function blank(): QuotaConfig {
  const tomorrow = new Date(Date.now() + 86400000 + 8 * 3600000);
  tomorrow.setUTCHours(0, 0, 0, 0);
  return { name: '', amount: 100, account_type: 'internal', profiles: [], user_ids: [], exclude_ids: [],
    unit: 'day', every: 1, anchor: new Date(tomorrow.getTime() - 8 * 3600000).toISOString(), max_members: 100 };
}
function localTime(value: string) {
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? new Date(d.getTime() + 8 * 3600000).toISOString().slice(0, 16) : '';
}
export default function QuotaManager() {
  const { confirm, productDialog } = useProductDialog();
  const [data, setData] = useState<View | null>(null);
  const [id, setId] = useState('');
  const [form, setForm] = useState<QuotaConfig | null>(null);
  const [tab, setTab] = useState<'settings' | 'members' | 'history'>('settings');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<BatchResult | null>(null);
  const [savedConfig, setSavedConfig] = useState<QuotaConfig | null>(null);
  const request = useRef<Record<string, unknown> | null>(null);
  const sequence = useRef(0);
  const selected = data?.rules.find(rule => rule.id === id);
  const dirty = !!form && JSON.stringify(form) !== JSON.stringify(savedConfig);
  const hasUnpublishedDraft = !!selected?.revisions.length && !sameQuotaSettings(selected.draft, selected.revisions.at(-1)!.config);
  const pendingRevision = selected?.revisions.find(revision => new Date(revision.effective_at).getTime() > Date.now());
  const publishAt = selected?.revisions.length ? selected.publish_at : form?.anchor;
  const load = useCallback(async () => {
    const seq = ++sequence.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), q: appliedSearch });
      if (id && tab !== 'settings') params.set('id', id);
      const response = await fetch(`/api/admin/credits/periodic?${params}`, { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '读取失败');
      if (seq === sequence.current) {
        setData(result);
        setLoadError('');
        const currentRule = result.rules.find((rule: QuotaRule) => rule.id === id);
        if (currentRule) setSavedConfig(currentRule.draft);
        return result as View;
      }
      return null;
    } catch (e) {
      if (seq === sequence.current) setLoadError(e instanceof Error ? e.message : '读取失败');
      return null;
    }
    finally { if (seq === sequence.current) setLoading(false); }
  }, [id, tab, page, appliedSearch]);
  useEffect(() => { void load(); return () => { sequence.current++; }; }, [load]);
  useEffect(() => {
    const handle = (event: BeforeUnloadEvent) => { if (dirty || request.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', handle);
    return () => window.removeEventListener('beforeunload', handle);
  }, [dirty]);

  async function choose(rule?: QuotaRule, duplicate = false) {
    if (busy || request.current) return;
    if (dirty && !await confirm('放弃尚未保存的草稿修改？')) return;
    const empty = blank();
    const next = rule ? { ...rule.draft, ...(duplicate ? { name: `${rule.draft.name} 副本`, anchor: empty.anchor } : {}) } : empty;
    setId(duplicate ? '' : rule?.id || '');
    setForm(next);
    setSavedConfig(duplicate ? empty : rule?.draft || empty);
    setTab('settings'); setPage(1); setSearch(''); setAppliedSearch(''); setCursor(null); setRunResult(null);
    setLoadError(''); setActionError(''); setNotice('');
  }
  async function discardChanges() {
    if (!form || !dirty || blocked) return;
    if (!await confirm('放弃尚未保存的修改？')) return;
    setForm(savedConfig);
    setActionError(''); setNotice('已放弃未保存的修改');
  }
  function patch(values: Partial<QuotaConfig>) { setForm(current => current ? { ...current, ...values } : current); }
  function toggle(key: 'profiles' | 'user_ids' | 'exclude_ids', value: string) {
    if (!form) return;
    patch({ [key]: form[key].includes(value) ? form[key].filter(item => item !== value) : [...form[key], value] });
  }
  async function mutate(action: string, retry = false) {
    if (!data || busy || (!retry && request.current)) return;
    if (action !== 'save' && dirty) {
      setActionError('有未保存的草稿修改，请先保存或放弃后再执行此操作。');
      return;
    }
    if (action !== 'save' && !retry && !await confirm(action === 'publish'
      ? `发布“${form?.name}”？每人每期 ${form?.amount} 点，最多 ${form?.max_members} 人，总额度上限 ${(form?.amount || 0) * (form?.max_members || 0)} 点。适用名单：${form ? audience(form) : '暂无'}。${form?.amount === 0 ? '当前为 0 点，不会发放点数。' : ''}预计 ${date(publishAt)} 开始生效。发布时会检查成员重叠与人数上限；不影响长期点数，已有旧额度的成员顺延到旧额度结束后的周期。`
      : action === 'run' ? '仅补齐本期尚未领取的成员，不重复发点；重试结果只统计本次检查。继续？'
        : action === 'pause' ? '暂停后不再续发额度；已发额度不会清零，仍按原有效期到期。'
          : action === 'archive' ? '归档后不能恢复，也不再续发；已发额度不会清零，仍按原有效期到期，历史记录保留。继续？'
            : '恢复周期续发，不重新发放已领取额度。若成员与其他启用规则重叠，恢复会被拒绝，需先调整名单。继续？', { title: '确认额度操作', confirmLabel: action === 'archive' ? '归档' : '确认', danger: action === 'archive' })) return;
    const config = action === 'save' && form ? { ...form, name: form.name.trim() } : undefined;
    const body = retry ? request.current! : { action, id: id || undefined, config,
      expected_version: data.version, confirm: true, request_id: crypto.randomUUID(), ...(action === 'run' ? { cursor } : {}) };
    request.current = body;
    setBusy(true); setActionError(''); setNotice('');
    let responseStatus = 0;
    try {
      const response = await fetch('/api/admin/credits/periodic', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      responseStatus = response.status;
      const result = await response.json();
      if (!response.ok) {
        if (response.status < 500) request.current = null;
        throw new Error(result.error || '操作失败');
      }
      request.current = null;
      if (body.action === 'save') {
        setId(result.id);
        setPage(1);
        setSavedConfig(config || null);
        setForm(config || null);
        setNotice('草稿已保存，尚未发布生效');
        const refreshed = await load();
        const savedRule = refreshed?.rules.find(rule => rule.id === result.id);
        if (savedRule) { setSavedConfig(savedRule.draft); setForm(savedRule.draft); }
        else setNotice('草稿已保存，尚未发布生效；最新列表暂未读取，请重新读取核对。');
      } else if (body.action === 'run') {
        const batch = result as BatchResult;
        setCursor(batch.cursor);
        setRunResult(batch);
        setNotice(`本批检查 ${batch.processed} 人，发放 ${batch.granted} 人，跳过 ${batch.skipped} 人，未完成 ${batch.failed} 人${batch.cursor ? '；还有下一批' : ''}`);
        if (!await load()) setNotice(current => `${current}；执行结果已返回，但记录列表未刷新，请重新读取。`);
      } else {
        const stateNotice = body.action === 'publish' ? `已发布，将于 ${date(publishAt)} 开始生效`
          : body.action === 'pause' ? '已暂停，不再续发；已发额度仍按原有效期到期'
            : body.action === 'archive' ? '已归档，不再续发；已发额度未清空，仍按原有效期到期'
              : body.action === 'resume' ? '已恢复周期续发，不会重新发放已领取额度' : '规则状态已更新';
        setNotice(stateNotice);
        if (!await load()) setNotice(current => `${current}；列表暂未刷新，请重新读取核对。`);
      }
    } catch (e) {
      if (responseStatus === 409) {
        const refreshed = await load();
        setActionError(refreshed
          ? '规则版本已被其他操作更新，已读取最新版本；本地草稿保留，请核对后再保存或操作。'
          : '规则版本已被其他操作更新，但最新状态暂未读取成功；本地草稿保留，请重新读取后再处理。');
      } else {
        const reason = e instanceof Error && e.message !== 'Failed to fetch' ? e.message : '网络连接中断';
        setActionError(request.current
          ? `${reason}。操作结果尚未确认，其他操作已锁定；请重试原操作，系统会发送相同请求。`
          : reason);
      }
    }
    finally { setBusy(false); }
  }
  let previews: string[] = [];
  if (form && Number.isInteger(form.every) && form.every > 0 && Number.isFinite(new Date(form.anchor).getTime())) {
    const preserveCalendar = !!selected?.revisions.length && form.unit === selected.effective_config.unit && form.every === selected.effective_config.every;
    const previewConfig = { ...form, anchor: preserveCalendar ? selected!.effective_config.anchor : publishAt || form.anchor };
    let at = new Date(publishAt || form.anchor);
    for (let i = 0; i < 3; i++) { previews.push(date(at)); at = quotaWindow(previewConfig, at).end; }
  }
  const worker = data?.worker as { at?: string } | null;
  const stopped = !worker?.at || Date.now() - new Date(worker.at).getTime() > 5 * 60000;
  const blocked = busy || !!request.current;
  const archived = selected?.status === 'archived';
  return <div className={styles.root}>
    {productDialog}
    <PageBanner title="周期额度" backHref="/admin/users" backLabel="用户管理" actions={<>
      <Link className="btn btn-secondary" href="/admin/points">点数流水</Link>
      <button className="btn btn-primary" onClick={() => choose()} disabled={blocked}><Plus size={16} />新建规则</button></>} />
    <div className={styles.toolbar}><span className={stopped ? styles.warning : styles.muted}>{stopped ? '自动刷新进程未就绪或最近未响应' : `自动刷新进程最近有响应 · ${date(worker?.at)}`}</span>
      <button className="btn btn-secondary" title="重新读取规则" aria-label="重新读取规则" disabled={loading || busy} onClick={() => void load()}><RefreshCw size={16} /></button></div>
    {loadError && <div className={styles.error} role="alert">读取失败：{loadError}</div>}
    {actionError && <div className={styles.error} role="alert">{actionError}{request.current && <button className="btn btn-secondary" onClick={() => void mutate(String(request.current?.action), true)} disabled={busy}>重试原操作</button>}</div>}
    {request.current && !actionError && <div className={styles.error} role="alert">操作结果尚未确认，其他操作已锁定。可以安全重试原操作。<button className="btn btn-secondary" onClick={() => void mutate(String(request.current?.action), true)} disabled={busy}>重试原操作</button></div>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    {busy && <LoadingStatus>{request.current?.action === 'save' ? '正在保存草稿' : '正在执行已确认的操作，请等待结果'}</LoadingStatus>}
    <div className={styles.layout}>
      <aside className={styles.list} aria-label="额度规则">
        {loading && (data ? <LoadingStatus>正在更新额度规则</LoadingStatus> : <LoadingSkeleton label="正在读取额度规则" />)}
        {data?.rules.length === 0 && <p className={styles.muted}>暂无额度规则</p>}
        {data?.rules.map(rule => {
          const published = rule.revisions.length > 0;
          const pendingDraft = published && !sameQuotaSettings(rule.draft, rule.revisions.at(-1)!.config);
          return <button key={rule.id} className={`${styles.rule} ${id === rule.id ? styles.active : ''}`} disabled={blocked} onClick={() => choose(rule)}>
          <strong>{published ? rule.effective_config.name : rule.draft.name}</strong><span>{statuses[rule.status]} · {published ? `已发布条件匹配 ${rule.members} 人` : '尚未发布'}</span>
          <span>{published ? `已发布：${rule.effective_config.amount}点 / 每${rule.effective_config.every}${units[rule.effective_config.unit]}` : `草稿：${rule.draft.amount}点 / 每${rule.draft.every}${units[rule.draft.unit]}（未生效）`}</span>
          {pendingDraft && <small>另有未发布草稿：{rule.draft.name}</small>}
          {rule.status === 'active' && <small>下次 {date(rule.next_refresh)}</small>}
        </button>;
        })}
      </aside>
      <main className={styles.main}>
        {!form ? <p className={styles.muted}>请选择额度规则</p> : <>
          <div className={styles.toolbar}><h2>{form.name || '新建规则'}</h2><span>{selected ? statuses[selected.status] : '未保存'}</span>
            {selected && <button className="btn btn-secondary" onClick={() => choose(selected, true)} disabled={blocked}><Copy size={16} />复制为草稿</button>}</div>
          <nav className={styles.tabs}>{(['settings', 'members', 'history'] as const).map(value => <button key={value} type="button" disabled={!id && value !== 'settings'} aria-current={tab === value ? 'page' : undefined} onClick={() => { setTab(value); setPage(1); setAppliedSearch(''); setSearch(''); }}>{value === 'settings' ? '设置' : value === 'members' ? '适用成员' : '执行记录'}</button>)}</nav>
          {dirty && <div className={styles.draftWarning} role="status">当前有未保存修改。先保存或放弃，才能发布、暂停、恢复、归档或补齐额度。<button className="btn btn-secondary" disabled={blocked} onClick={discardChanges}>放弃修改</button></div>}
          {hasUnpublishedDraft && <p className={styles.muted}>当前额度仍按已发布配置处理；已保存的草稿尚未发布。</p>}
          {pendingRevision && <p className={styles.muted}>版本 {pendingRevision.version} 已发布，将于 {date(pendingRevision.effective_at)} 生效；生效前不能再次发布。</p>}
          {selected && <p className={styles.muted}>{selected.status === 'archived' ? '该规则已归档，不再续发；已发额度不会清零，仍按原有效期到期。' : '暂停或归档会停止后续续发；已发额度不会清零，仍按原有效期到期。'}</p>}
          {tab === 'settings' && <>
            <fieldset disabled={blocked || archived} className={styles.fields}>
              <label>规则名称<input value={form.name} maxLength={60} onChange={e => patch({ name: e.target.value })} /></label>
              <label>每人每期点数<input type="number" min="0" max="1000000" step="1" value={form.amount} onChange={e => patch({ amount: Number(e.target.value) })} /></label>
              <label>每隔<div className={styles.inline}><input type="number" min="1" max="366" value={form.every} onChange={e => patch({ every: Number(e.target.value) })} /><select value={form.unit} onChange={e => patch({ unit: e.target.value as QuotaConfig['unit'] })}>{Object.entries(units).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div></label>
              <label>{selected?.revisions.length ? '首次时间（已发布规则修改从下周期生效）' : '首次刷新时间（北京时间）'}<input type="datetime-local" value={localTime(form.anchor)} disabled={!!selected?.revisions.length} onChange={e => { if (e.target.value) patch({ anchor: new Date(`${e.target.value}:00+08:00`).toISOString() }); }} /></label>
              <label>账号范围<select value={form.account_type} onChange={e => patch({ account_type: e.target.value as QuotaConfig['account_type'] })}><option value="internal">内部账号</option><option value="external">外部账号</option><option value="all">内部与外部</option></select></label>
              <label>每期最多发放人数<input type="number" min="1" max="10000" value={form.max_members} onChange={e => patch({ max_members: Number(e.target.value) })} /></label>
              <div className={styles.wide}><h3>岗位角色</h3><div className={styles.checks}>{USER_PROFILE_OPTIONS.map(profile => <label key={profile.value}><input type="checkbox" checked={form.profiles.includes(profile.value)} onChange={() => toggle('profiles', profile.value)} />{profile.label}</label>)}</div></div>
            </fieldset>
            <div className={styles.summary}>
              <div>每人每期 {form.amount} 点{form.amount === 0 ? '（0 点不会发放额度）' : ''}；最多 {form.max_members} 人，总额上限 {form.amount * form.max_members} 点</div>
              <div>适用名单：{audience(form)}</div>
              <div>预计生效：{date(publishAt)}。发布时检查成员重叠与人数上限，冲突或超限时不会发布。</div>
              <div>不结转 · 不覆盖长期点数 · 新成员默认下周期生效 · 管理员不领取</div>
              {previews.length > 0 && <div>后续安排：{previews.join(' / ')}</div>}
            </div>
            <p className={styles.muted}>保存草稿只保存设置，不发放或改变已生效额度；发布后才按计划时间生效。</p>
            <h3>指定或排除成员</h3>
            <form className={`${styles.toolbar} ${styles.searchForm}`} onSubmit={e => { e.preventDefault(); setAppliedSearch(search); setPage(1); }}><input placeholder="搜索姓名或账号" aria-label="搜索成员" value={search} onChange={e => setSearch(e.target.value)} /><button className="btn btn-secondary">搜索</button><span>指定{form.user_ids.length}人 · 排除{form.exclude_ids.length}人</span></form>
            <div className={styles.table}><table><thead><tr><th>成员</th><th>指定加入</th><th>排除</th></tr></thead><tbody>{data?.people.map(person => <tr key={person.id}><td><UserIdentityBadge user={person} size="sm" /></td><td><input aria-label={`指定${person.name}`} type="checkbox" disabled={blocked || archived} checked={form.user_ids.includes(person.id)} onChange={() => toggle('user_ids', person.id)} /></td><td><input aria-label={`排除${person.name}`} type="checkbox" disabled={blocked || archived} checked={form.exclude_ids.includes(person.id)} onChange={() => toggle('exclude_ids', person.id)} /></td></tr>)}</tbody></table></div>
            <div className={styles.toolbar}><button className="btn btn-secondary" disabled={page <= 1 || loading} onClick={() => setPage(p => p - 1)}>上一页</button><span>{page} / {Math.max(1, Math.ceil((data?.total || 0) / 40))}</span><button className="btn btn-secondary" disabled={page * 40 >= (data?.total || 0) || loading} onClick={() => setPage(p => p + 1)}>下一页</button></div>
            <div className={styles.actions}><button className="btn btn-primary" disabled={blocked || !dirty || archived} onClick={() => void mutate('save')}><Save size={16} />保存草稿</button>
              <button className="btn btn-secondary" disabled={blocked || dirty || !id || archived || !!pendingRevision} onClick={() => void mutate('publish')}><Play size={16} />发布生效</button>
              {selected?.status === 'active' && <button className="btn btn-secondary" disabled={blocked || dirty} onClick={() => void mutate('pause')}><Pause size={16} />暂停</button>}
              {selected?.status === 'paused' && <button className="btn btn-secondary" disabled={blocked || dirty} onClick={() => void mutate('resume')}><Play size={16} />恢复</button>}
              {selected && selected.status !== 'archived' && <button className="btn btn-secondary" disabled={blocked || dirty} onClick={() => void mutate('archive')}><Archive size={16} />归档</button>}</div>
            {selected?.revisions.length ? <p className={styles.muted}>最近发布：{date(selected.revisions.at(-1)?.effective_at)} 生效；版本 {selected.revisions.at(-1)?.version}。未发布草稿不会影响点数。</p> : null}
          </>}
          {tab === 'members' && <><p>{selected?.revisions.length ? `已发布配置当前匹配 ${data?.total || 0} 人` : `规则尚未发布，以下按已保存草稿匹配 ${data?.total || 0} 人`}；最终发放时会复核账号、冲突与人数上限。</p><div className={styles.table}><table><thead><tr><th>成员</th><th>点数记录</th></tr></thead><tbody>{data?.people.map(person => <tr key={person.id}><td><UserIdentityBadge user={person} /></td><td><Link href={`/admin/points?user_id=${person.id}`}>查看流水</Link></td></tr>)}</tbody></table></div><div className={styles.toolbar}><button className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>上一页</button><span>第{page}页</span><button className="btn btn-secondary" disabled={page * 40 >= (data?.total || 0)} onClick={() => setPage(p => p + 1)}>下一页</button></div></>}
          {tab === 'history' && <><div className={styles.toolbar}><button className="btn btn-secondary" disabled={blocked || dirty || selected?.status !== 'active'} onClick={() => void mutate('run')}><RefreshCw size={16} />{cursor ? '继续补齐下一批' : '补齐本期漏发'}</button><Link href={`/admin/points?q=${encodeURIComponent(`periodic:${id}`)}`}>查看额度流水</Link></div>
            {runResult && <div className={runResult.failed ? styles.partial : styles.runResult} role="status"><p>本批检查 {runResult.processed} 人，发放 {runResult.granted} 人，跳过 {runResult.skipped} 人，未完成 {runResult.failed} 人{runResult.scope === 'all' ? '；范围为全站' : ''}。</p>{runResult.failures.map((failure, index) => <p key={`${failure.user_id}-${index}`}><Link href={`/admin/points?user_id=${failure.user_id}`}>查看成员流水</Link>：{failure.reason}</p>)}</div>}
            <div className={styles.table}><table><thead><tr><th>时间</th><th>操作</th><th>结果</th></tr></thead><tbody>{data?.logs.map(log => {
              const detail = log.detail as { scope?: string; granted?: number; failed?: number; skipped?: number; rule?: QuotaRule; failures?: { user_id: string; reason: string }[] };
              const names: Record<string, string> = { periodic_quota_save: '保存草稿', periodic_quota_publish: '发布规则', periodic_quota_pause: '暂停', periodic_quota_resume: '恢复', periodic_quota_archive: '归档', periodic_quota_batch: '补齐额度' };
              return <tr key={log.id}><td>{date(log.created_at)}</td><td>{detail.scope === 'all' ? '全站自动刷新' : names[log.action] || '规则更新'}</td><td>{detail.granted !== undefined ? `发放${detail.granted}人 / 跳过${detail.skipped}人 / 未完成${detail.failed}人` : '已记录'}{detail.failures?.map((failure, i) => <p key={i}><Link href={`/admin/points?user_id=${failure.user_id}`}>查看成员流水</Link>：{failure.reason}</p>)}</td></tr>;
            })}</tbody></table></div>{data?.logs.length === 0 && <p className={styles.muted}>暂无执行记录</p>}</>}
        </>}
      </main>
    </div>
  </div>;
}
