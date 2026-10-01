'use client';

import { useEffect, useRef, useState } from 'react';
import { Share2, RefreshCw } from 'lucide-react';
import type { ContentKey } from '@/lib/content-reactions/types';
import styles from './reactions.module.css';

type ShareState = { canShare: boolean; shared: boolean; href?: string };

export default function ImageShareButton({ contentKey, userId, disabled }: { contentKey: ContentKey; userId: string; disabled: boolean }) {
  const [state, setState] = useState<ShareState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [attempt, setAttempt] = useState(0);
  const lock = useRef(false);
  const sequence = useRef(0);
  const identity = `${userId}:${contentKey}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const eligible = contentKey.startsWith('asset:') || contentKey.startsWith('reference_image:');

  useEffect(() => {
    setState(null); setError(''); setFeedback('');
    if (!eligible) return;
    const controller = new AbortController();
    const load = () => {
      if (lock.current) return;
      const requestId = ++sequence.current;
      void fetch(`/api/image-shares?key=${encodeURIComponent(contentKey)}`, { cache: 'no-store', signal: controller.signal })
        .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error || '分享状态读取失败'); return data as ShareState; })
        .then(data => { if (!controller.signal.aborted && requestId === sequence.current) { setState(data); setError(''); } })
        .catch(reason => { if (!controller.signal.aborted && requestId === sequence.current) setError(reason instanceof Error ? reason.message : '分享状态读取失败'); });
    };
    load();
    window.addEventListener('sd2-image-shares-changed', load);
    window.addEventListener('focus', load);
    return () => { controller.abort(); window.removeEventListener('sd2-image-shares-changed', load); window.removeEventListener('focus', load); };
  }, [contentKey, userId, eligible, attempt]);

  if (!eligible || state?.canShare === false) return null;
  async function toggle() {
    if (!state || lock.current) return;
    const active = !state.shared;
    if (active && !window.confirm('分享后，所有已登录的站内用户都能在公共图集看到这张图片。不会分享提示词或参考图。确定分享吗？')) return;
    lock.current = true; sequence.current += 1; setBusy(true); setError(''); setFeedback('');
    try {
      const response = await fetch('/api/image-shares', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: contentKey, active }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '分享失败，请重试');
      if (currentIdentity.current === identity) { setState(data); setFeedback(active ? '已分享给站内用户' : '已取消分享'); }
      window.dispatchEvent(new Event('sd2-image-shares-changed'));
    } catch (reason) {
      if (currentIdentity.current === identity) setError(reason instanceof Error ? reason.message : '分享失败，请重试');
    } finally { lock.current = false; if (currentIdentity.current === identity) setBusy(false); }
  }
  return <>
    <button type="button" title={state?.shared ? '取消站内分享' : '分享给站内用户'} aria-label={state?.shared ? '取消站内分享' : '分享给站内用户'} aria-pressed={state?.shared || false} disabled={disabled || busy || !state} onClick={() => void toggle()}><Share2 size={16} /></button>
    {busy && <span className={styles.busy} role="status">保存中</span>}
    {feedback && <span className={styles.muted} role="status">{feedback}{state?.shared && state.href && <> · <a href={state.href}>查看</a></>}</span>}
    {error && <span className={styles.error} role="status">{error}<button type="button" title="重新读取分享状态" aria-label="重新读取分享状态" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={14} /></button></span>}
  </>;
}
