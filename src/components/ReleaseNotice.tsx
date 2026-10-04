'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { createPortal } from 'react-dom';
import { release, newerRelease } from '@/lib/release';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { cancelPageExit, getPageExitRisk, refreshPage } from '@/lib/hooks/page-exit-guard';
import styles from './CreditRequestDialog.module.css';

export default function ReleaseNotice() {
  const laterKey=`sd2:release:later:video-api-debugger:${release.channel}`;
  const { user } = useAppSession();
  const pathname = usePathname();
  const dialog = useRef<HTMLDialogElement>(null);
  const [target, setTarget] = useState<typeof release | null>(null);
  const [message, setMessage] = useState('');
  const [checking, setChecking] = useState(false);
  const [risk, setRisk] = useState<ReturnType<typeof getPageExitRisk> | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const returnButton = useRef<HTMLButtonElement>(null);
  const refreshLock = useRef(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>();
  const inFlight = useRef(false);
  const check = useCallback(async (manual = false) => {
    if (inFlight.current) return;
    inFlight.current = true; setChecking(true);
    try {
      const response = await fetch('/api/release', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error('unavailable');
      const data = await response.json();
      if (data.channel !== release.channel || !/^\d+\.\d+\.\d+$/.test(data.version)) throw new Error('unknown');
      let dismissed = false;
      try { dismissed = localStorage.getItem(laterKey) === data.version || localStorage.getItem('sd2:release:later') === data.version; } catch { /* Storage may be unavailable. */ }
      if (newerRelease(data.version, release.version)) {
        if (manual || !dismissed) setTarget(data);
        setMessage(`可更新至 v${data.version}`);
      } else if (data.version === release.version) {
        setMessage('当前已是最新版本');
        try { localStorage.removeItem(laterKey);localStorage.removeItem('sd2:release:later'); } catch { /* Optional persistence. */ }
      } else setMessage('暂无法确认更新，请稍后重试');
    } catch { if (manual) setMessage('检查失败，请重试'); }
    finally { inFlight.current = false; setChecking(false); }
  }, [laterKey]);
  useEffect(() => {
    const checkVisible = () => { if (document.visibilityState === 'visible') void check(); };
    checkVisible(); const timer = setInterval(checkVisible, 300000);
    window.addEventListener('focus', checkVisible);
    document.addEventListener('visibilitychange', checkVisible);
    return () => { clearInterval(timer); window.removeEventListener('focus', checkVisible); document.removeEventListener('visibilitychange', checkVisible); };
  }, [check]);
  useEffect(() => { if (target) dialog.current?.showModal(); }, [target]);
  const later = () => { cancelPageExit(); try { if (target) localStorage.setItem(laterKey, target.version); } catch { /* Optional persistence. */ } setTarget(null); setRisk(null); setRefreshError(''); };
  useEffect(() => {
    if (!target || !risk) return;
    const timer = setInterval(() => {
      const next = getPageExitRisk();
      setRisk(previous => previous?.signature === next.signature ? previous : next);
    }, 250);
    return () => clearInterval(timer);
  }, [target, Boolean(risk)]);
  useEffect(() => { if (risk?.unsaved.length) returnButton.current?.focus({ preventScroll: true }); }, [Boolean(risk?.unsaved.length)]);
  useEffect(() => () => { clearTimeout(refreshTimer.current); cancelPageExit(); }, []);
  const update = () => {
    if (refreshLock.current) return;
    const next = getPageExitRisk();
    setRefreshError('');
    if (next.busy.length || (next.unsaved.length && (!risk || risk.signature !== next.signature))) {
      setRisk(next);
      return;
    }
    refreshLock.current = true;
    setRefreshing(true);
    if (!refreshPage(risk?.signature)) {
      refreshLock.current = false; setRefreshing(false); setRisk(getPageExitRisk());
      setRefreshError('内容状态已变化，请重新确认。');
      return;
    }
    refreshTimer.current = setTimeout(() => {
      cancelPageExit(); refreshLock.current = false; setRefreshing(false);
      setRefreshError('页面未完成刷新，可以重试。'); setRisk(getPageExitRisk());
    }, 1500);
  };
  useDialogDismiss({ open: Boolean(target), dialogRef: dialog, nativeDialog: true, onDismiss: later, initialFocusRef: returnButton });
  return <>
    {pathname === '/account' && <footer style={{ padding: '16px 24px', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
      <span>SD2 v{release.version}</span><button className="btn btn-secondary" disabled={checking} onClick={() => void check(true)}>{checking ? '检查中…' : '检查更新'}</button><span role="status">{message}</span>
    </footer>}
    {target && createPortal(<dialog ref={dialog} className={styles.dialog} aria-labelledby="release-title">
      <header className={styles.header}><h2 id="release-title" style={{ fontWeight: 700, fontSize: 20 }}>{risk?.busy.length ? '操作进行中' : risk?.unsaved.length ? '未保存内容' : '发现新版本'}</h2></header>
      <div className={styles.body}><p>v{target.version}</p>
        {user?.account_type === 'internal' && target.summary && <p>{target.summary}</p>}
        {risk?.busy.length ? <p role="status">{risk.busy.join('、')}。完成后再刷新，不会中断当前操作。</p>
          : risk?.unsaved.length ? <p>{risk.unsaved.join('、')}尚未保存，刷新会丢失这些修改。</p>
          : <p>新版本已就绪，可刷新后使用。</p>}
        {refreshError && <p role="alert" className={styles.error}>{refreshError}</p>}
        <div className={styles.actions}><button className="btn btn-primary" disabled={refreshing || Boolean(risk?.busy.length)} onClick={update}>
          {refreshing ? '刷新中…' : risk?.unsaved.length ? '放弃修改并刷新' : '立即刷新'}
        </button><button ref={returnButton} className="btn btn-secondary" onClick={later}>{risk?.unsaved.length && !risk.busy.length ? '返回编辑' : '稍后'}</button></div>
      </div>
    </dialog>, document.body)}
  </>;
}
