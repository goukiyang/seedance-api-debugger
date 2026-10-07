'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import type { ReactionListItem, ReactionListResponse } from '@/lib/content-reactions/types';
import styles from './studio.module.css';

export function useTemplateFavorites(userId: string, open: boolean) {
  const { user, hasLoadedUser } = useAppSession();
  const [items, setItems] = useState<ReactionListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [loaded, setLoaded] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const sequence = useRef(0), controller = useRef<AbortController | null>(null);
  const allowed = hasLoadedUser && user?.id === userId;
  const load = useCallback(async (next?: string) => {
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    const serial = ++sequence.current;
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ action: 'like', category: 'template', limit: '24' });
      if (next) params.set('cursor', next);
      const response = await fetch(`/api/content-reactions?${params}`, { cache: 'no-store', signal: request.signal });
      const data: ReactionListResponse & { error?: string } = await response.json();
      if (!response.ok) throw new Error(data.error || '喜欢模板读取失败，请重试');
      if (request.signal.aborted || serial !== sequence.current) return;
      setItems(current => next ? [...current, ...data.items.filter(item => !current.some(old => old.key === item.key))] : data.items);
      setCursor(data.nextCursor); setLoaded(true);
    } catch (cause) {
      if (!request.signal.aborted && serial === sequence.current) setError(cause instanceof Error ? cause.message : '喜欢模板读取失败，请重试');
    } finally { if (serial === sequence.current) setLoading(false); }
  }, []);
  useEffect(() => {
    setItems([]); setCursor(null); setLoaded(false); setError('');
    return () => { sequence.current++; controller.current?.abort(); };
  }, [userId, allowed]);
  useEffect(() => {
    if (!open || !allowed) return;
    void load();
    return () => { sequence.current++; controller.current?.abort(); };
  }, [open, allowed, userId, load, epoch]);
  useEffect(() => {
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ userId?: string }>).detail;
      if (detail?.userId === userId) setEpoch(value => value + 1);
    };
    window.addEventListener('sd2-reactions-changed', refresh);
    return () => window.removeEventListener('sd2-reactions-changed', refresh);
  }, [userId]);
  return { items: allowed ? items : [], cursor, loading: loading || !hasLoadedUser, error, loaded, allowed,
    refresh: () => setEpoch(value => value + 1), more: () => { if (allowed && cursor && !loading) void load(cursor); } };
}

export function TemplateFavoritesList({ data, selected, busy, onSelect }: {
  data: ReturnType<typeof useTemplateFavorites>; selected: string; busy: boolean; onSelect: (item: ReactionListItem) => void;
}) {
  return <div className={styles.favoriteList} aria-label="喜欢的模板" aria-busy={data.loading || busy}>
    {data.loading && <p role="status">正在读取喜欢模板</p>}
    {!data.loading && !data.allowed && <p role="status">请登录当前账号后查看喜欢模板</p>}
    {data.error && <p role="alert">{data.error}<button type="button" title="重试读取喜欢模板" aria-label="重试读取喜欢模板" disabled={data.loading} onClick={data.refresh}><RefreshCw size={15} /></button></p>}
    {data.items.map(item => <button key={item.key} type="button" className={styles.favoriteItem} disabled={busy || !item.content || !item.state.available}
      aria-pressed={selected === item.key} title={item.content?.title || '模板已不可用'} onClick={() => onSelect(item)}>
      <span>{item.content?.title || '模板已不可用'}</span><small>{item.key.startsWith('image_') ? '图片' : '视频'}</small>
    </button>)}
    {data.allowed && data.loaded && !data.loading && !data.error && !data.items.length && <p role="status">还没有喜欢的模板</p>}
    {data.cursor && <button type="button" disabled={data.loading || busy} onClick={data.more}>加载更多</button>}
  </div>;
}
