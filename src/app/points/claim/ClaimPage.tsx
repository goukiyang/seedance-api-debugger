'use client';

import Link from 'next/link';
import { Check, Gift, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { claimCampaignState, claimDate, type ClaimCampaignList, type CreditClaimReceipt } from '@/lib/credits/claim-types';
import styles from './claim.module.css';

const labels = { available: '领取积分', claimed: '已领取', upcoming: '尚未开始', ended: '领取已结束', paused: '活动已暂停' };
export default function ClaimPage({ actorId, campaignId }: { actorId: string; campaignId: string }) {
  const { user, credits, refreshCredits, hasLoadedUser } = useAppSession();
  const [data, setData] = useState<ClaimCampaignList | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [now, setNow] = useState(Date.now());
  const offset = useRef(0);
  const requestBusy = useRef(false);
  const loadingRef = useRef(false);
  const currentActor = useRef(user?.id);
  currentActor.current = user?.id;
  const load = useCallback(async (cursor?: string) => {
    if (loadingRef.current) return;
    loadingRef.current = true; setLoading(true);
    try {
      const params = new URLSearchParams();
      if (campaignId) params.set('campaign', campaignId);
      if (cursor) params.set('cursor', cursor);
      const response = await fetch(`/api/me/credit-claims?${params}`, { cache: 'no-store', headers: { 'x-app-session-user': actorId }, signal: AbortSignal.timeout(15000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '领取活动加载失败');
      if (currentActor.current !== actorId) return;
      offset.current = Date.parse(result.serverTime) - Date.now();
      setNow(Date.now() + offset.current);
      setData(previous => cursor && previous ? { ...result, campaigns: [...previous.campaigns, ...result.campaigns].filter((item, index, rows) => rows.findIndex(c => c.id === item.id) === index) } : result);
      setError('');
    } catch (err) { setError(err instanceof Error ? err.message : '加载失败，请重试'); }
    finally { loadingRef.current = false; setLoading(false); }
  }, [actorId, campaignId]);
  useEffect(() => { if (user?.id === actorId) void load(); }, [user?.id, actorId, load]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() + offset.current), 1000);
    const refresh = () => { if (document.visibilityState === 'visible' && !requestBusy.current) void load(); };
    window.addEventListener('focus', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [load]);
  async function claim(id: string, revision: number) {
    if (requestBusy.current || user?.id !== actorId) return;
    requestBusy.current = true; setBusy(id); setError(''); setNotice('');
    try {
      const response = await fetch('/api/me/credit-claims', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-app-session-user': actorId },
        body: JSON.stringify({ campaignId: id, expectedRevision: revision }), signal: AbortSignal.timeout(15000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '未能确认到账，请刷新核对');
      if (currentActor.current !== actorId) return;
      const receipt = result.receipt as CreditClaimReceipt;
      setData(previous => previous ? { ...previous, campaigns: previous.campaigns.map(c => c.id === id ? { ...c, receipt } : c) } : previous);
      setNotice(`${result.alreadyClaimed ? '此前已领取' : '领取成功'}，${receipt.amount} 积分已到账`);
      await refreshCredits({ force: true });
    } catch (err) { if (currentActor.current === actorId) setError(`${err instanceof Error ? err.message : '未能确认到账'}。可刷新核对，重复领取不会重复到账。`); }
    finally { requestBusy.current = false; setBusy(''); }
  }
  if (hasLoadedUser && user?.id !== actorId) return <p role="alert">账号已变化，请刷新页面。</p>;
  return <div className={styles.page}>
    <header className={styles.header}><div><h1>领取积分</h1><p>可用积分 <strong>{credits?.available ?? '--'}</strong></p></div>
      <button className="btn btn-secondary" title="刷新领取状态" aria-label="刷新领取状态" disabled={loading || !!busy} onClick={() => { void load(); void refreshCredits({ force: true }); }}><RefreshCw size={17} /></button></header>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {notice && <p role="status" className={styles.success}>{notice}</p>}
    {!data && <p role="status">{loading ? '正在加载领取活动...' : error ? '请刷新重试' : '正在确认账号...'}</p>}
    {data && !data.campaigns.length && <div className={styles.empty}><Gift size={30} /><h2>暂无可领取的积分</h2><p>没有进行中的领取活动，或当前账号不在领取范围内。</p>{campaignId && <Link href="/points/claim">查看全部活动</Link>}</div>}
    <div className={styles.grid}>{data?.campaigns.map(c => {
      const state = claimCampaignState(c, c.receipt, now);
      return <article key={c.id} className={styles.campaign}>
        <div className={styles.row}><h2>{c.name}</h2><span className={styles.state}>{labels[state]}</span></div>
        <div className={styles.amount}>{c.receipt?.amount ?? c.amount}<span>积分</span></div>
        <p className={styles.window}>领取时间 (北京时间)<br />{claimDate(c.startsAt)}<br />至 {claimDate(c.endsAt)}</p>
        <p className={styles.muted}>{c.receipt ? `${claimDate(c.receipt.claimedAt)} 已到账` : '每个账号限领一次，到账后计入长期余额。'}</p>
        <button type="button" className="btn btn-primary" disabled={state !== 'available' || !!busy || loading} onClick={() => void claim(c.id, c.revision)}>
          {state === 'claimed' ? <Check size={17} /> : <Gift size={17} />}{busy === c.id ? '正在确认到账...' : labels[state]}</button>
      </article>;
    })}</div>
    {data?.nextCursor && <button className="btn btn-secondary" disabled={loading || !!busy} onClick={() => void load(data.nextCursor!)}>{loading ? '加载中...' : '更多活动'}</button>}
    <footer className={styles.footer}><Link href="/usage">查看我的用量</Link>{user?.role === 'admin' && <Link href="/admin/points/claims">管理领取活动</Link>}</footer>
  </div>;
}
