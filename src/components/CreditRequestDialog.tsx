'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, RefreshCw, X } from 'lucide-react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { canRequestCredits, CREDIT_GRANT_AMOUNTS } from '@/lib/credits/request-rules';
import UserIdentityBadge from './UserIdentityBadge';
import styles from './CreditRequestDialog.module.css';

type RequestRow = {
  id: string; user_id: string; approver_id: string; status: string; purpose: string; amount: number | null;
  decision_reason: string | null; created_at: string;
  requester: { name: string; avatar_url: string | null };
  deliveries: { kind: string; status: string; error_code: string | null }[];
};
type RequestData = { enabled: boolean; canApprove: boolean; requests: RequestRow[]; pendingRequest: RequestRow | null; pendingCount: number; nextCursor: string | null };
const statusLabels: Record<string, string> = { pending: '待审批', approved: '已到账', rejected: '未通过', withdrawn: '已撤回' };

export default function CreditRequestDialog({ autoOpen = false }: { autoOpen?: boolean }) {
  const { user, credits, refreshCredits } = useAppSession();
  const [open, setOpen] = useState(autoOpen);
  const [view, setView] = useState<'summary' | 'apply'>('summary');
  const [data, setData] = useState<RequestData | null>(null);
  const [purpose, setPurpose] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [confirmation, setConfirmation] = useState<{ requestId: string; confirmationNonce: string; amount: number; available: number } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const epoch = useRef(0);
  const loadingRef = useRef(false);
  const load = useCallback(async (cursor?: string, replace = false) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    const current = epoch.current;
    setLoading(true);
    try {
      const response = await fetch(`/api/me/credit-requests${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '申请记录加载失败');
      if (current === epoch.current) {
        setData((previous) => {
          if (!previous || replace) return result;
          const rows: RequestRow[] = cursor ? [...previous.requests, ...result.requests] : [...result.requests, ...previous.requests];
          const unique = rows.filter((item, index) => rows.findIndex((row) => row.id === item.id) === index);
          return { ...result, requests: unique, nextCursor: cursor ? result.nextCursor : previous.nextCursor };
        });
        setError('');
        await refreshCredits({ force: true });
      }
    } catch (err) {
      if (current === epoch.current) setError(err instanceof Error ? err.message : '加载失败，请重试');
    } finally { loadingRef.current = false; if (current === epoch.current) setLoading(false); }
  }, [refreshCredits]);

  useEffect(() => { epoch.current++; setData(null); setPurpose(''); setConfirmation(null); setError(''); setNotice(''); setBusy(false); }, [user?.id]);
  const hasPending = Boolean(data?.pendingCount);
  useEffect(() => {
    if ((!open && !hasPending) || !user) return;
    if (open) dialog.current?.showModal();
    void load();
    const refresh = () => { if (document.visibilityState === 'visible') void load(); };
    const interval = setInterval(refresh, 15000);
    window.addEventListener('focus', refresh);
    return () => { clearInterval(interval); window.removeEventListener('focus', refresh); };
  }, [open, hasPending, user, load]);
  useEffect(() => {
    if (!user) return;
    const refresh = () => { if (document.visibilityState === 'visible') void refreshCredits({ force: true }); };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [user, refreshCredits]);

  const close = () => { if (busy) return; setOpen(false); setView('summary'); setConfirmation(null); dialog.current?.close(); };
  async function act(body: Record<string, unknown>) {
    if (busy) return;
    const current = epoch.current;
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/me/credit-requests', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      const result = await response.json();
      if (current !== epoch.current) return;
      if (!response.ok) throw new Error(result.error || '操作未完成');
      if (body.action === 'prepare' && result.confirmationNonce) {
        setConfirmation({ requestId: String(body.requestId), confirmationNonce: result.confirmationNonce, amount: result.amount, available: result.available });
      } else {
        setConfirmation(null); setView('summary');
        if (body.action === 'submit') setPurpose('');
        setNotice(result.message || '申请已保存，等待审批');
      }
      await load(undefined, true);
    } catch (err) { if (current === epoch.current) setError(err instanceof Error ? err.message : '未拿到结果，请刷新申请记录后重试'); }
    finally { if (current === epoch.current) setBusy(false); }
  }
  const pending = data?.pendingRequest;
  const visibleRequests = pending && !data?.requests.some((item) => item.id === pending.id)
    ? [pending, ...(data?.requests || [])] : (data?.requests || []);
  const eligible = data?.enabled && credits && canRequestCredits(credits.available) && !pending;
  if (!user) return null;
  return <>
    <button type="button" className="composer-topbar-credit" onClick={() => setOpen(true)} aria-haspopup="dialog" title="查看积分与申请记录">
      可用 {credits ? Math.floor(credits.available) : '—'}
    </button>
    {open && createPortal(<dialog ref={dialog} className={styles.dialog} aria-labelledby="credit-request-title" onCancel={(event) => { event.preventDefault(); close(); }}>
      <header className={styles.header}>
        {(view === 'apply' || confirmation) && <button type="button" aria-label="返回积分" title="返回积分" disabled={busy} onClick={() => { setView('summary'); setConfirmation(null); }}><ArrowLeft size={18} /></button>}
        <h2 id="credit-request-title">{confirmation ? '确认发放' : view === 'apply' ? '申请积分' : '我的积分'}</h2>
        <button type="button" aria-label="关闭" title="关闭" disabled={busy} onClick={close}><X size={20} /></button>
      </header>
      <div className={styles.body}>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {confirmation ? <>
          <p>当前可用 {confirmation.available} 点，本次增加 <strong>{confirmation.amount} 点</strong>个人长期积分。</p>
          <button className="btn btn-primary" disabled={busy} onClick={() => void act({ action: 'confirm', ...confirmation })}>{busy ? '处理中…' : '确认发放'}</button>
        </> : view === 'apply' ? <form onSubmit={(event) => { event.preventDefault(); void act({ action: 'submit', purpose }); }}>
          <p>当前可用 {credits?.available ?? '—'} 点。发放额度由管理员审批。</p>
          <label htmlFor="credit-purpose">用途</label>
          <textarea id="credit-purpose" value={purpose} maxLength={300} required rows={4} onChange={(event) => setPurpose(event.target.value)} disabled={busy} />
          <div className={styles.actions}><button type="submit" className="btn btn-primary" disabled={busy || !eligible || !purpose.trim()}>{busy ? '提交中…' : '提交申请'}</button></div>
        </form> : <>
          <div className={styles.balance}><span>可用 <strong>{credits?.available ?? '—'}</strong> 点</span><span>冻结 {credits?.frozen_credits ?? '—'} 点</span>
            <button type="button" title="刷新积分和记录" aria-label="刷新积分和记录" disabled={loading || busy} onClick={() => void load()}><RefreshCw size={16} /></button></div>
          <div className={styles.actions}><button type="button" className="btn btn-primary" disabled={!eligible || busy || loading} onClick={() => { setView('apply'); setNotice(''); }}>申请积分</button>
            <span>{!data ? '正在确认申请状态…' : !data.enabled ? '申请暂未开放，请联系管理员' : pending ? '已有一条申请待审批' : !credits ? '积分加载失败，请刷新重试' : !canRequestCredits(credits.available) ? '少于 500 点时可申请' : '由管理员审批发放'}</span></div>
          <h3>{data?.canApprove ? '申请与审批' : '申请记录'}</h3>
          {data?.canApprove && data.pendingCount > 0 && <p>待审批 {data.pendingCount} 条</p>}
          {data && !data.requests.length && <p>暂无申请记录</p>}
          <ul className={styles.list}>{visibleRequests.map((item) => <li key={item.id}>
            <div className={styles.row}><UserIdentityBadge user={item.requester} size="sm" /><strong>{statusLabels[item.status] || item.status}{item.amount ? ` ${item.amount} 点` : ''}</strong></div>
            <p>{item.purpose}</p>
            <small>{new Date(item.created_at).toLocaleString('zh-CN')}{item.decision_reason ? ` · ${item.decision_reason}` : ''}</small>
            {item.deliveries.some((delivery) => delivery.status === 'retry') && <p className={styles.error}>飞书通知暂未送达，系统会重试。申请状态不受影响。</p>}
            {item.status === 'pending' && <div className={styles.actions}>
              {item.user_id === user.id && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => { if (window.confirm('确认撤回这条积分申请？')) void act({ action: 'withdraw', requestId: item.id }); }}>撤回申请</button>}
              {data?.canApprove && data.enabled && item.approver_id === user.id && <>
                {CREDIT_GRANT_AMOUNTS.map((amount) => <button type="button" key={amount} className="btn btn-secondary" disabled={busy} onClick={() => void act({ action: 'prepare', requestId: item.id, amount })}>发放 {amount}</button>)}
                <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => { const reason = window.prompt('请填写不予发放的原因'); if (reason?.trim()) void act({ action: 'reject', requestId: item.id, reason }); }}>不予发放</button>
              </>}
            </div>}
          </li>)}</ul>
          {data?.nextCursor && <button type="button" className="btn btn-secondary" disabled={loading || busy} onClick={() => void load(data.nextCursor!)}>{loading ? '加载中…' : '加载更多'}</button>}
        </>}
      </div>
    </dialog>, document.body)}
  </>;
}
