'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { createPortal } from 'react-dom';
import { release, newerRelease } from '@/lib/release';
import styles from './CreditRequestDialog.module.css';

export default function ReleaseNotice() {
  const pathname = usePathname();
  const dialog = useRef<HTMLDialogElement>(null);
  const [target, setTarget] = useState<typeof release | null>(null);
  const [message, setMessage] = useState('');
  const [checking, setChecking] = useState(false);
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
      try { dismissed = localStorage.getItem('sd2:release:later') === data.version; } catch { /* Storage may be unavailable. */ }
      if (newerRelease(data.version, release.version)) {
        if (manual || !dismissed) setTarget(data);
        setMessage(`可更新至 v${data.version}`);
      } else if (data.version === release.version) {
        setMessage('当前已是最新版本');
        try { localStorage.removeItem('sd2:release:later'); } catch { /* Optional persistence. */ }
      } else setMessage('暂无法确认更新，请稍后重试');
    } catch { if (manual) setMessage('检查失败，请重试'); }
    finally { inFlight.current = false; setChecking(false); }
  }, []);
  useEffect(() => {
    const checkVisible = () => { if (document.visibilityState === 'visible') void check(); };
    checkVisible(); const timer = setInterval(checkVisible, 300000);
    window.addEventListener('focus', checkVisible);
    return () => { clearInterval(timer); window.removeEventListener('focus', checkVisible); };
  }, [check]);
  useEffect(() => { if (target) dialog.current?.showModal(); }, [target]);
  const later = () => { try { if (target) localStorage.setItem('sd2:release:later', target.version); } catch { /* Optional persistence. */ } setTarget(null); };
  return <>
    {pathname === '/account' && <footer style={{ padding: '16px 24px', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
      <span>SD2 v{release.version}</span><button className="btn btn-secondary" disabled={checking} onClick={() => void check(true)}>{checking ? '检查中…' : '检查更新'}</button><span role="status">{message}</span>
    </footer>}
    {target && createPortal(<dialog ref={dialog} className={styles.dialog} onCancel={(e) => { e.preventDefault(); later(); }} aria-labelledby="release-title">
      <header className={styles.header}><h2 id="release-title" style={{ fontWeight: 700 }}>发现新版本</h2></header>
      <div className={styles.body}><p>v{target.version}</p><p>{target.summary}</p>
        <p>刷新前请保存当前未提交的内容。</p>
        <div className={styles.actions}><button className="btn btn-primary" onClick={() => { if (window.confirm('刷新会关闭当前页面，未提交的内容可能丢失。确认已保存并刷新？')) window.location.reload(); }}>立即刷新</button><button className="btn btn-secondary" onClick={later}>稍后</button></div>
      </div>
    </dialog>, document.body)}
  </>;
}
