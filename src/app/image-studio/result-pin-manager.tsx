'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MoreHorizontal, RefreshCw } from 'lucide-react';
import { RelativeTime } from '@/components/RelativeTime';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import type { StudioPinState } from '@/lib/image-studio/result-pin-types';
import { StudioResultPinButton } from './result-pin-button';
import styles from './result-pin-manager.module.css';

export function StudioResultPinManager({ userId, moduleId, onSaved }: { userId: string; moduleId: string; onSaved: () => void }) {
  const root = useRef<HTMLDetailsElement>(null), request = useRef<AbortController | null>(null);
  const scope = `${userId}:${moduleId}`, current = useRef(scope); current.current = scope;
  const [open, setOpen] = useState(false), [state, setState] = useState<StudioPinState | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const refresh = useCallback(async () => {
    if (isClientSessionBlocked()) return;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setError('');
    try {
      const response = await fetch(`/api/image-studio/result-pins?moduleId=${encodeURIComponent(moduleId)}`, {
        cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || '置顶管理读取失败，请重试');
      if (value.viewerId !== userId || !Array.isArray(value.state?.ownPins)) throw new Error('置顶管理暂不可用，请刷新页面');
      if (!controller.signal.aborted && current.current === scope && !isClientSessionBlocked()) setState(value.state);
    } catch (cause) {
      if (!controller.signal.aborted && current.current === scope) setError(cause instanceof Error ? cause.message : '置顶管理读取失败');
    } finally { if (request.current === controller) { request.current = null; setLoading(false); } }
  }, [scope, userId, moduleId]);
  useEffect(() => { setState(null); setError(''); if (root.current) root.current.open = false; return () => request.current?.abort(); }, [scope]);
  useEffect(() => {
    if (!open) return;
    void refresh();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && root.current) root.current.open = false; };
    document.addEventListener('pointerdown', outside);
    return () => { document.removeEventListener('pointerdown', outside); request.current?.abort(); };
  }, [open, refresh]);
  return <details ref={root} className={styles.root} onToggle={event => setOpen(event.currentTarget.open)}
    onKeyDown={event => { if (event.key === 'Escape' && root.current) { event.stopPropagation(); root.current.open = false; root.current.querySelector('summary')?.focus(); } }}>
    <summary aria-label="结果更多操作" title="管理我的置顶"><MoreHorizontal size={18} /></summary>
    {open && <section className={styles.panel} aria-label="我的置顶" aria-busy={loading}>
      <header><strong>我的置顶</strong><button type="button" aria-label="刷新我的置顶" disabled={loading} onClick={() => void refresh()}><RefreshCw size={16} /></button></header>
      {error && <p role="status">{error}</p>}
      {!state && loading && <p role="status">正在读取置顶记录</p>}
      {state?.ownPins?.map(pin => <article key={pin.assetId}>
        {pin.thumbnailUrl ? <img src={pin.thumbnailUrl} alt="本人置顶图片" loading="lazy" /> : <span className={styles.placeholder}>暂不可预览</span>}
        <div><span>{pin.availability === 'available' ? '已置顶' : '已置顶 · 暂不可共享'}</span><RelativeTime value={pin.pinnedAt} />
          {pin.reason && <small>{pin.reason}</small>}</div>
        <StudioResultPinButton showLabel userId={userId} moduleId={moduleId} taskId={pin.taskId} assetId={pin.assetId}
          state={state} onSaved={() => { void refresh(); onSaved(); }} />
      </article>)}
      {state?.ownPins?.length === 0 && <p>当前模板没有本人置顶。</p>}
    </section>}
  </details>;
}
