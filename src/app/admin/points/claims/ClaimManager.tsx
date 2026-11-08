'use client';

import Link from 'next/link';
import { Copy, Plus, RefreshCw, Save } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useProductDialog } from '@/components/useProductDialog';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { usePageExitRisk } from '@/lib/hooks/page-exit-guard';
import { claimAudienceLabels, claimDate, type ClaimCampaign, type ClaimCampaignConfig, type ClaimCampaignList, type ClaimCampaignSave } from '@/lib/credits/claim-types';
import styles from './claims.module.css';

type Draft = Omit<ClaimCampaignConfig, 'amount'> & { amount: string };
const blank = (): Draft => ({ name: '', amount: '', startsAt: '', endsAt: '', enabled: false, audience: 'all' });
const localTime = (iso: string) => new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 16);
const toUtc = (local: string) => new Date(`${local}:00+08:00`).toISOString();

export default function ClaimManager({ actorId }: { actorId: string }) {
  const { user, hasLoadedUser } = useAppSession();
  const { confirm, productDialog } = useProductDialog();
  const [data, setData] = useState<ClaimCampaignList | null>(null);
  const [selected, setSelected] = useState<Pick<ClaimCampaign, 'id' | 'revision'> | null>(null);
  const [draft, setDraft] = useState<Draft>(blank);
  const [pending, setPending] = useState<ClaimCampaignSave | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const busyRef = useRef(false);
  const loadRef = useRef(false);
  const savedDraft = useRef(JSON.stringify(blank()));
  const currentActor = useRef(user?.id);
  currentActor.current = user?.id;
  const storageKey = `sd2-credit-claim-save:${actorId}`;
  const headers = { 'x-app-session-user': actorId };
  const select = (campaign: ClaimCampaign | null) => {
    setSelected(campaign);
    const next = campaign ? { ...campaign, amount: String(campaign.amount), startsAt: localTime(campaign.startsAt), endsAt: localTime(campaign.endsAt) } : blank();
    savedDraft.current = JSON.stringify(next);
    setDraft(next);
    setError(''); setNotice('');
  };
  const dirty = JSON.stringify(draft) !== savedDraft.current;
  usePageExitRisk({ unsaved: dirty && !pending ? ['领取活动设置'] : [], busy: busy ? ['正在保存或核对领取设置'] : [] });
  async function choose(campaign: ClaimCampaign | null) {
    if (dirty && !await confirm('当前领取设置尚未保存，切换后会丢弃本次修改。', { title: '切换活动', confirmLabel: '丢弃并切换' })) return;
    select(campaign);
  }
  const load = useCallback(async (cursor?: string) => {
    if (loadRef.current) return;
    loadRef.current = true; setLoading(true);
    try {
      const response = await fetch(`/api/admin/credits/claims${cursor ? `?cursor=${cursor}` : ''}`, { headers: { 'x-app-session-user': actorId }, cache: 'no-store', signal: AbortSignal.timeout(15000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '活动加载失败');
      if (currentActor.current !== actorId) return;
      setData(previous => cursor && previous ? { ...result, campaigns: [...previous.campaigns, ...result.campaigns].filter((c, i, rows) => rows.findIndex(item => item.id === c.id) === i) } : result);
    } catch (err) { setError(err instanceof Error ? err.message : '活动加载失败'); }
    finally { loadRef.current = false; setLoading(false); }
  }, [actorId]);
  useEffect(() => {
    if (user?.id !== actorId) return;
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const operation = JSON.parse(stored) as ClaimCampaignSave;
        setPending(operation);
        setSelected(operation.expectedRevision ? { id: operation.id, revision: operation.expectedRevision } : null);
        setDraft({ ...operation.config, amount: String(operation.config.amount), startsAt: localTime(operation.config.startsAt), endsAt: localTime(operation.config.endsAt) });
      }
      setReady(true);
    } catch { setError('本机保存回执无法读取，请不要重复新建活动。'); }
    void load();
  }, [actorId, user?.id, storageKey, load]);

  async function complete(campaign: ClaimCampaign) {
    localStorage.removeItem(storageKey);
    setPending(null); select(campaign);
    setNotice(campaign.enabled ? '设置已保存，领取按所设时间开放。' : '设置已保存，活动未开放。');
    await load();
  }
  async function send(operation: ClaimCampaignSave) {
    const response = await fetch('/api/admin/credits/claims', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(operation), signal: AbortSignal.timeout(15000) });
    const result = await response.json();
    if (currentActor.current !== actorId) return;
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) { localStorage.removeItem(storageKey); setPending(null); if (response.status === 409) await load(); }
      throw new Error(result.error || '保存结果待确认');
    }
    await complete(result.campaign);
  }
  async function save() {
    if (busyRef.current || pending || !ready || user?.id !== actorId) return;
    busyRef.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const config: ClaimCampaignConfig = { name: draft.name.trim(), amount: Number(draft.amount), startsAt: toUtc(draft.startsAt), endsAt: toUtc(draft.endsAt), enabled: draft.enabled, audience: draft.audience };
      if (config.enabled && !await confirm(`${config.name}：每个${claimAudienceLabels[config.audience]}可领取 ${config.amount} 积分一次。领取截止于 ${claimDate(config.endsAt)} (北京时间)。已到账积分不变。`, { title: '确认开放领取', confirmLabel: '保存并开放' })) return;
      const operation = { id: selected?.id || crypto.randomUUID(), expectedRevision: selected?.revision || 0, operationId: crypto.randomUUID(), config };
      // Persist before sending so a lost response can be reconciled with the same operation.
      localStorage.setItem(storageKey, JSON.stringify(operation));
      setPending(operation);
      await send(operation);
    } catch (err) { setError(err instanceof Error ? err.message : '保存结果待确认，请核对本次保存'); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function reconcile(retry = false) {
    if (!pending || busyRef.current || user?.id !== actorId) return;
    busyRef.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch(`/api/admin/credits/claims?operation=${pending.operationId}`, { headers, cache: 'no-store', signal: AbortSignal.timeout(15000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '暂时无法核对，请稍后再试');
      if (currentActor.current !== actorId) return;
      if (result.found) await complete(result.campaign);
      else if (retry) await send(pending);
      else setNotice('尚未查到本次保存，可重试同一次保存，不会重复创建。');
    } catch (err) { setError(err instanceof Error ? err.message : '核对失败，请重试'); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function copy(id: string) {
    try { await navigator.clipboard.writeText(`${window.location.origin}/points/claim?campaign=${id}`); setNotice('领取链接已复制'); }
    catch { setError('未能复制链接，可在领取页面复制浏览器地址。'); }
  }
  const locked = busy || !!pending || !ready;
  const selectedRow = data?.campaigns.find(c => c.id === selected?.id);
  if (hasLoadedUser && user?.id !== actorId) return <p role="alert">账号已变化，请刷新页面。</p>;
  return <div className={styles.page}>
    <header className={styles.header}><h1>积分领取</h1><Link href="/points/claim">打开领取页</Link></header>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    {pending && <section className={styles.pending}><strong>本次保存结果待确认</strong><p>{pending.config.name} / {pending.config.amount} 积分</p>
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void reconcile()}><RefreshCw size={16} />核对结果</button>
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void reconcile(true)}>重试本次保存</button></section>}
    <div className={styles.layout}>
      <section className={styles.list} aria-label="领取活动列表"><div className={styles.subheader}><h2>领取活动</h2><div>
        <button type="button" className="btn btn-secondary" disabled={locked} title="新建领取活动" onClick={() => void choose(null)}><Plus size={16} />新建</button>
        <button type="button" className="btn btn-secondary" disabled={loading || busy} title="刷新列表" aria-label="刷新列表" onClick={() => void load()}><RefreshCw size={16} /></button></div></div>
        {!data && <p role="status">{loading ? '正在加载活动...' : '请刷新列表'}</p>}
        {data && !data.campaigns.length && <p className={styles.muted}>暂无活动</p>}
        {data?.campaigns.map(c => <button type="button" disabled={locked} key={c.id} className={styles.listItem} aria-pressed={selected?.id === c.id} onClick={() => void choose(c)}>
          <strong>{c.name}</strong><span>{c.amount} 积分 / {c.enabled ? '已开启' : '未开放'}</span><small>已领取 {c.claimedCount ?? 0} 人</small></button>)}
        {data?.nextCursor && <button type="button" className="btn btn-secondary" disabled={loading || busy} onClick={() => void load(data.nextCursor!)}>更多活动</button>}
      </section>
      <form className={styles.form} onSubmit={event => { event.preventDefault(); void save(); }}>
        <h2>{selected ? '编辑活动' : '新建活动'}</h2>
        <fieldset disabled={locked}>
          <label>活动名称<input className="input" required maxLength={60} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
          <label>每人领取积分<input className="input" type="number" required min="0.01" max="1000000" step="0.01" inputMode="decimal" value={draft.amount} onChange={e => setDraft({ ...draft, amount: e.target.value })} /></label>
          <div className={styles.times}><label>开始时间 (北京时间)<input className="input" type="datetime-local" required value={draft.startsAt} onChange={e => setDraft({ ...draft, startsAt: e.target.value })} /></label>
            <label>结束时间 (北京时间)<input className="input" type="datetime-local" required min={draft.startsAt || undefined} value={draft.endsAt} onChange={e => setDraft({ ...draft, endsAt: e.target.value })} /></label></div>
          <label>适用账号<select className="input" value={draft.audience} onChange={e => setDraft({ ...draft, audience: e.target.value as Draft['audience'] })}>{Object.entries(claimAudienceLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <label className={styles.toggle}><input type="checkbox" role="switch" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} /><span className={styles.switch} aria-hidden="true" />开放领取</label>
        </fieldset>
        <p className={styles.muted}>每个账号限领一次。领取截止后不再开放领取，已到账积分不清零。</p>
        {selected && <p className={styles.muted}>已领取 {selectedRow?.claimedCount ?? '--'} 人。修改仅影响未领取者；重新开启不会重置领取记录。</p>}
        <div className={styles.actions}><button type="submit" className="btn btn-primary" disabled={locked}><Save size={17} />{busy ? '正在处理...' : '保存设置'}</button>
          {selected && <><button type="button" className="btn btn-secondary" title="复制领取链接" disabled={busy} onClick={() => void copy(selected.id)}><Copy size={16} />复制链接</button><Link href={`/points/claim?campaign=${selected.id}`}>查看领取页</Link></>}</div>
        {selectedRow && selectedRow.revision !== selected?.revision && <p className={styles.error}>设置已有新版本，当前输入保留。<button type="button" disabled={locked} onClick={() => select(selectedRow)}>读取最新设置</button></p>}
      </form>
    </div>{productDialog}
  </div>;
}
