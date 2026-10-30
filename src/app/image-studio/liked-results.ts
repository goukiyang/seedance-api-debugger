'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ContentKey } from '@/lib/content-reactions/types';
import { STUDIO_RESULT_FEED, type StudioResultFeedExtras, type SharedStudioPinnedImage } from '@/lib/image-studio/result-pin-types';

export function useLikedStudioResults<T extends { id: string; asset?: { id?: string } | null }>(userId: string, moduleId: string, visible: boolean, enabled: boolean, visibleIds?: { current: string[] }) {
  const scope = `${userId}:${moduleId}`;
  const preference = `sd2-image-studio-result-filter:${scope}`;
  const [filter, setFilter] = useState({ scope: '', liked: false });
  const [data, setData] = useState<{ scope: string; tasks: T[]; nextCursor: string | null; total: number | null; error: string; loading: boolean; feed?: StudioResultFeedExtras }>({ scope, tasks: [], nextCursor: null, total: null, error: '', loading: false });
  const liked = enabled && filter.scope === scope && filter.liked;
  const current = useRef({ scope, liked, visible });
  current.current = { scope, liked, visible };
  const request = useRef<AbortController | null>(null);
  const pageReads = useRef(1);
  const loaded = useRef(false);
  const removed = useRef(new Set<string>());
  useEffect(() => {
    let saved = false;
    try { saved = localStorage.getItem(preference) === 'liked'; } catch { /* Optional preference. */ }
    setFilter({ scope, liked: saved });
    setData({ scope, tasks: [], nextCursor: null, total: null, error: '', loading: false });
    loaded.current = false; pageReads.current = 1; removed.current.clear();
    return () => { request.current?.abort(); request.current = null; };
  }, [scope, preference]);
  const choose = (next: boolean) => {
    request.current?.abort(); request.current = null;
    setFilter({ scope, liked: next });
    try { localStorage.setItem(preference, next ? 'liked' : 'all'); } catch { /* Optional preference. */ }
  };
  const read = useCallback(async (cursor?: string) => {
    if (!current.current.liked || !current.current.visible || current.current.scope !== scope) return;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const valid = () => !controller.signal.aborted && request.current === controller && current.current.scope === scope && current.current.liked;
    setData(previous => ({ ...previous, scope, loading: true, error: '' }));
    try {
      const pages = 1;
      let next: string | null = cursor || null;
      const tasks: T[] = [];
      const sharedPins: SharedStudioPinnedImage[] = [], resultOrder: string[] = [];
      let feed: StudioResultFeedExtras | undefined;
      let total: number | null = null;
      for (let page = 0; page < pages; page++) {
        const query = new URLSearchParams({ moduleId, liked: '1', feed: STUDIO_RESULT_FEED, projection: 'studio-task-summary-v1' });
        if (next) query.set('cursor', next);
        const response = await fetch(`/api/image-studio/tasks?${query}`, { cache: 'no-store', signal: controller.signal });
        const result = await response.json();
        if (!response.ok || !Array.isArray(result.tasks)) throw new Error(result.error || '喜欢结果读取失败，请重试');
        if (result.viewerId !== userId) throw new Error('账号已变化，请重新打开当前模板');
        if (result.protocol !== STUDIO_RESULT_FEED || !Array.isArray(result.sharedPins) || !Array.isArray(result.resultOrder) || !result.pinState) throw new Error('置顶目录协议尚未就绪，请刷新页面');
        if (!valid()) return;
        tasks.push(...result.tasks);
        sharedPins.push(...result.sharedPins); resultOrder.push(...result.resultOrder); feed = result;
        total = Number.isSafeInteger(result.total) && result.total >= 0 ? result.total : null;
        next = typeof result.nextCursor === 'string' ? result.nextCursor : null;
        if (!next) break;
      }
      const checkedIds = !cursor ? (visibleIds?.current || []).slice(0, 24) : [];
      let exactTasks: T[] = [];
      if (checkedIds.length) {
        const query = new URLSearchParams({ moduleId, liked: '1', projection: 'studio-task-summary-v1' });
        checkedIds.forEach(id => query.append('id', id));
        const response = await fetch(`/api/image-studio/tasks?${query}`, { cache: 'no-store', signal: controller.signal });
        const result = await response.json();
        if (!response.ok || result.viewerId !== userId || result.projection !== 'studio-task-summary-v1') throw new Error(result.error || '喜欢结果读取失败，请重试');
        exactTasks = result.tasks;
      }
      if (!valid()) return;
      loaded.current = true;
      if (cursor) pageReads.current++;
      setData(previous => {
        const exact = new Map(exactTasks.map(task => [task.id, task]));
        const retained = previous.tasks.filter(task => !checkedIds.includes(task.id) || exact.has(task.id)).map(task => exact.get(task.id) || task);
        const combined = cursor ? [...previous.tasks, ...tasks] : [...tasks, ...retained.filter(task => !tasks.some(fresh => fresh.id === task.id))];
        const combinedPins = cursor || pageReads.current > 1 ? [...(previous.feed?.sharedPins || []), ...sharedPins] : sharedPins;
        const combinedOrder = cursor ? [...(previous.feed?.resultOrder || []), ...resultOrder] : [...resultOrder, ...(previous.feed?.resultOrder || [])];
        return { scope, tasks: Array.from(new Map(combined.filter(task => !removed.current.has(task.asset?.id || '')).map(task => [task.id, task])).values()),
          feed: feed && { ...feed, sharedPins: Array.from(new Map(combinedPins.filter(pin => !removed.current.has(pin.assetId)
            && (feed!.eligiblePinAssetIds || feed!.pinState.assetIds).includes(pin.assetId)).map(pin => [pin.id, pin])).values()), resultOrder: Array.from(new Set(combinedOrder)) },
          nextCursor: !cursor && pageReads.current > 1 ? previous.nextCursor : next, total, error: '', loading: false };
      });
    } catch (error) {
      if (valid()) setData(previous => ({ ...previous, error: error instanceof Error ? error.message : '喜欢结果读取失败，请重试', loading: false }));
    } finally { if (request.current === controller) request.current = null; }
  }, [moduleId, scope, userId, visibleIds]);
  useEffect(() => {
    if (liked && visible) void read();
    else { request.current?.abort(); request.current = null; setData(previous => ({ ...previous, loading: false })); }
  }, [liked, visible, read]);
  useEffect(() => {
    if (!liked || !visible) return;
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ userId?: string; key?: ContentKey; active?: boolean }>).detail;
      if (detail?.userId !== userId || !detail.key?.startsWith('asset:')) return;
      const asset = detail.key.slice(6);
      if (detail.active === false) {
        removed.current.add(asset);
        setData(previous => ({ ...previous, tasks: previous.tasks.filter(task => task.asset?.id !== asset),
          feed: previous.feed && { ...previous.feed, sharedPins: previous.feed.sharedPins.filter(pin => pin.assetId !== asset) } }));
      } else removed.current.delete(asset);
      void read();
    };
    const refresh = () => { if (!document.hidden) { removed.current.clear(); void read(); } };
    window.addEventListener('sd2-reactions-changed', changed);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('sd2-studio-pins-changed', refresh);
    const timer = window.setInterval(refresh, 15000);
    return () => { window.clearInterval(timer); window.removeEventListener('sd2-studio-pins-changed', refresh); window.removeEventListener('sd2-reactions-changed', changed); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [liked, read, userId, visible]);
  const scoped = data.scope === scope ? data : { tasks: [] as T[], feed: undefined, nextCursor: null, total: null, error: '', loading: true };
  return { ...scoped, liked, choose, refresh: () => { removed.current.clear(); void read(); }, more: () => read(scoped.nextCursor || undefined), loading: scoped.loading || liked && !loaded.current && !scoped.error };
}
