'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Download, Film, Play, RefreshCw } from 'lucide-react';
import { RelativeTime } from '@/components/RelativeTime';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import { seedanceVideoModelLabel } from '@/lib/provider/seedance-models';
import { mergeMultiviewVideoResults, multiviewSettledPoints, multiviewVideoNeedsRefresh, multiviewVideoResultLabel,
  multiviewVideoStatusLabels, type MultiviewVideoResult } from './multiview-video-results';
import styles from './multiview-video-results.module.css';

type Props = {
  owner: string; authority: string; active: boolean; currentTaskId?: string | null; pendingLabel?: string;
};
type Page = { items: MultiviewVideoResult[]; nextCursor: string | null; error?: string };
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const points = (item: MultiviewVideoResult) => {
  const value = multiviewSettledPoints(item);
  return value === null ? '实扣待结算' : `已扣 ${value.toFixed(2)} 点`;
};

export function MultiviewVideoResults({ owner, authority, active, currentTaskId, pendingLabel }: Props) {
  const identity = `${owner}:${authority}`;
  const live = useRef({ identity, active }); live.current = { identity, active };
  const controllers = useRef(new Set<AbortController>());
  const listSequence = useRef(0), detailSequence = useRef(0), currentSequence = useRef(0);
  const currentBinding = useRef('');
  const [loadedIdentity, setLoadedIdentity] = useState('');
  const [items, setItems] = useState<MultiviewVideoResult[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [current, setCurrent] = useState<MultiviewVideoResult | null>(null);
  const [selected, setSelected] = useState<MultiviewVideoResult | null>(null);
  const [loading, setLoading] = useState(false), [detailLoading, setDetailLoading] = useState(false);
  const [notice, setNotice] = useState(''), [detailError, setDetailError] = useState('');
  const [currentError, setCurrentError] = useState('');
  const [playRequest, setPlayRequest] = useState(''), [mediaError, setMediaError] = useState('');
  const player = useRef<HTMLVideoElement>(null);
  const selectionKey = `sd2:multiview-video-result:v1:${owner}`;
  const alive = useCallback(() => live.current.identity === identity && live.current.active && !isClientSessionBlocked(), [identity]);
  const focusedId = selectedId || currentTaskId || items[0]?.id || '';
  const focusedRef = useRef(focusedId); focusedRef.current = focusedId;

  const read = useCallback(async (query: URLSearchParams): Promise<Page> => {
    const controller = new AbortController(); controllers.current.add(controller);
    try {
      const response = await fetch(`/api/multiview/generations?${query}`, { cache: 'no-store', credentials: 'same-origin',
        headers: { 'x-app-session-user': owner }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
      const value = await response.json() as Page;
      if (!response.ok) throw Object.assign(new Error(value.error || '视频记录暂时无法读取。'), { status: response.status });
      if (!Array.isArray(value.items)) throw new Error('视频记录暂时无法读取。');
      return { ...value, items: value.items.filter(item => validId(item.id) && Object.hasOwn(multiviewVideoStatusLabels, item.status)) };
    } finally { controllers.current.delete(controller); }
  }, [owner]);

  const rejectAccess = useCallback((error: unknown) => {
    if (![401, 403, 409].includes((error as { status?: number })?.status || 0)) return;
    controllers.current.forEach(controller => controller.abort());
    listSequence.current++; detailSequence.current++; currentSequence.current++;
    player.current?.pause(); setItems([]); setCurrent(null); setSelected(null); setPlayRequest(''); setCursor(null);
    setLoading(false); setDetailLoading(false);
  }, []);

  const loadList = useCallback(async (after: string | null = null) => {
    if (!alive() || !owner) return;
    const sequence = ++listSequence.current;
    setLoading(true); setNotice('');
    try {
      const value = await read(new URLSearchParams(after ? { cursor: after } : {}));
      if (!alive() || sequence !== listSequence.current) return;
      setItems(previous => after ? mergeMultiviewVideoResults(previous, value.items) : value.items);
      setCursor(value.nextCursor);
    } catch (error) {
      if (alive() && sequence === listSequence.current) { rejectAccess(error); setNotice(error instanceof Error ? error.message : '视频记录暂时无法读取。'); }
    } finally { if (alive() && sequence === listSequence.current) setLoading(false); }
  }, [alive, owner, read, rejectAccess]);

  const loadTask = useCallback(async (id: string, asCurrent: boolean) => {
    if (!alive() || !validId(id)) return;
    const sequenceRef = asCurrent ? currentSequence : detailSequence;
    const sequence = ++sequenceRef.current;
    if (asCurrent) setCurrentError(''); else { setDetailLoading(true); setDetailError(''); }
    try {
      const value = await read(new URLSearchParams({ taskId: id }));
      if (!alive() || sequence !== sequenceRef.current) return;
      const item = value.items.find(item => item.id === id) || null;
      if (asCurrent) setCurrent(item);
      if (!asCurrent || focusedRef.current === id) setSelected(item);
      if (item) setItems(previous => mergeMultiviewVideoResults(previous, [item]));
      else {
        setItems(previous => previous.filter(item => item.id !== id));
        if (asCurrent) setCurrentError('本次视频记录暂不可用，请刷新状态。');
        else setDetailError('该视频记录已不可用，请选择其他视频。');
      }
    } catch (error) {
      if (alive() && sequence === sequenceRef.current) {
        rejectAccess(error);
        const message = error instanceof Error ? error.message : '视频状态暂时无法更新。';
        if (asCurrent) setCurrentError(message); else setDetailError(message);
      }
    } finally { if (alive() && sequence === sequenceRef.current && !asCurrent) setDetailLoading(false); }
  }, [alive, read, rejectAccess]);

  useEffect(() => {
    controllers.current.forEach(controller => controller.abort());
    listSequence.current++; detailSequence.current++; currentSequence.current++;
    setItems([]); setCursor(null); setCurrent(null); setSelected(null); setSelectedId('');
    setNotice(''); setDetailError(''); setCurrentError(''); setMediaError(''); setPlayRequest(''); setLoadedIdentity(identity);
    if (!currentTaskId) {
      try { const saved = sessionStorage.getItem(selectionKey); if (validId(saved)) setSelectedId(saved); } catch { /* Playback does not require browser storage. */ }
    }
    return () => { controllers.current.forEach(controller => controller.abort()); listSequence.current++; detailSequence.current++; currentSequence.current++; };
  // The current task has its own effect; a new task must not reset loaded history.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, selectionKey]);
  useEffect(() => {
    if (loadedIdentity === identity && active) void loadList();
    if (!active) { controllers.current.forEach(controller => controller.abort()); player.current?.pause(); }
  }, [active, identity, loadedIdentity, loadList]);
  useEffect(() => {
    currentSequence.current++; setCurrent(null); setCurrentError('');
    if (!currentTaskId || !active || loadedIdentity !== identity) return;
    const binding = `${identity}:${currentTaskId}`;
    if (currentBinding.current !== binding) { currentBinding.current = binding; setSelectedId(currentTaskId); setPlayRequest(''); }
    void loadTask(currentTaskId, true);
  }, [currentTaskId, active, loadedIdentity, identity, loadTask]);
  useEffect(() => {
    detailSequence.current++; setSelected(null); setMediaError('');
    if (focusedId && active && loadedIdentity === identity) void loadTask(focusedId, false);
  }, [focusedId, active, loadedIdentity, identity, loadTask]);
  useEffect(() => {
    if (!active || !currentTaskId || !current || !multiviewVideoNeedsRefresh(current)) return;
    const timer = setTimeout(() => { if (!document.hidden) void loadTask(currentTaskId, true); }, 8000);
    return () => clearTimeout(timer);
  }, [active, currentTaskId, current, loadTask]);
  useEffect(() => {
    if (!active || !selected || selected.id === currentTaskId || !multiviewVideoNeedsRefresh(selected)) return;
    const timer = setTimeout(() => { if (!document.hidden) void loadTask(selected.id, false); }, 8000);
    return () => clearTimeout(timer);
  }, [active, selected, currentTaskId, loadTask]);
  useEffect(() => {
    const resume = () => { if (!document.hidden && alive()) { if (currentTaskId) void loadTask(currentTaskId, true); if (focusedId) void loadTask(focusedId, false); } };
    document.addEventListener('visibilitychange', resume);
    return () => document.removeEventListener('visibilitychange', resume);
  }, [alive, currentTaskId, focusedId, loadTask]);
  useEffect(() => {
    if (!active || !selected?.playUrl || playRequest !== selected.id || !player.current) return;
    void player.current.play().catch(() => setMediaError('视频已打开，请点击播放。'));
  }, [active, selected?.id, selected?.playUrl, playRequest]);

  const choose = (id: string) => {
    player.current?.pause(); setSelectedId(id); setPlayRequest(id); setMediaError('');
    try { sessionStorage.setItem(selectionKey, id); } catch { /* The selected video remains usable in memory. */ }
    if (id === selected?.id) void player.current?.play().catch(() => setMediaError('视频已打开，请点击播放。'));
  };
  const refresh = () => { void loadList(); if (currentTaskId) void loadTask(currentTaskId, true); if (focusedId) void loadTask(focusedId, false); };
  if (!active || !owner || loadedIdentity !== identity) return null;
  return <section className={styles.results} aria-label="视频结果与历史视频">
    <header className={styles.header}><h2>视频结果</h2>
      <div className={styles.current} role="status">{pendingLabel || currentError || (current ? <><span>本次任务 · {multiviewVideoResultLabel(current)}</span><strong>{points(current)}</strong></> : currentTaskId ? '正在读取本次任务…' : null)}
        {currentTaskId && focusedId !== currentTaskId && <button type="button" onClick={() => choose(currentTaskId)}>查看本次结果</button>}
      </div><button type="button" disabled={loading} aria-label="刷新视频状态与历史" title="刷新视频状态与历史" onClick={refresh}><RefreshCw size={16} /></button>
    </header>
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    <div className={styles.layout}>
      <div className={styles.result}>
        {selected ? <>
          <div className={styles.resultMeta}><strong>{selected.title || '3D多视图视频'}</strong><span>{pendingLabel ? '上次视频' : selected.id === currentTaskId ? '本次视频' : '历史视频'} · {multiviewVideoResultLabel(selected)}</span><strong>{points(selected)}</strong></div>
          {selected.playUrl ? <video key={`${identity}:${selected.id}`} ref={player} src={selected.playUrl} controls playsInline preload="metadata"
            aria-label="当前选择的视频" onError={() => setMediaError('视频暂时无法播放，请刷新状态后重试。')} onPlaying={() => setMediaError('')} />
            : <div className={styles.placeholder}><Film size={28} /><span>{multiviewVideoResultLabel(selected)}</span></div>}
          <div className={styles.resultFooter}><span>{[selected.model && seedanceVideoModelLabel(selected.model), selected.duration !== null ? `${selected.duration}秒` : null, selected.resolution].filter(Boolean).join(' · ')}</span>
            {selected.downloadUrl && <a href={selected.downloadUrl} download><Download size={15} />下载视频</a>}
            <button type="button" title="复制完整视频编号" aria-label="复制完整视频编号" onClick={() => void navigator.clipboard.writeText(selected.id).then(() => setMediaError('已复制视频编号。')).catch(() => setMediaError('复制未完成，请重试。'))}><Copy size={15} /></button>
          </div>
          {selected.error && <p className={styles.notice} role="status">{selected.error.message}</p>}
        </> : <div className={styles.placeholder}><Film size={28} /><span>{detailLoading || loading ? '正在读取视频…' : pendingLabel || (focusedId ? '视频暂不可用' : '暂无生成视频')}</span></div>}
        {(detailError || mediaError) && <p className={styles.notice} role="status">{detailError || mediaError} <button type="button" onClick={refresh}>重新读取</button></p>}
      </div>
      <aside className={styles.history} aria-label="历史视频"><h3>历史视频</h3>
        <div className={styles.historyList}>{items.map(item => <article key={item.id} className={styles.historyItem} data-selected={item.id === focusedId || undefined}>
          <button type="button" className={styles.selectVideo} aria-pressed={item.id === focusedId} onClick={() => choose(item.id)} aria-label={`${item.playUrl ? '播放' : '查看'}${item.title || '3D多视图视频'}`}>
            <span className={styles.thumbnail}>{item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" loading="lazy" /> : <Film size={22} />}{item.playUrl && <Play className={styles.playIcon} size={18} />}</span>
            <span className={styles.recordText}><strong>{item.title || '3D多视图视频'}</strong><span>{multiviewVideoResultLabel(item)}</span><span>{points(item)}</span></span>
          </button>
          {item.createdAt && <div className={styles.time}><RelativeTime value={item.createdAt} /></div>}
        </article>)}</div>
        {!items.length && !loading && !notice && <p className={styles.notice}>暂无历史视频</p>}
        {loading && <p className={styles.notice} role="status">正在读取记录…</p>}
        {cursor && <button type="button" className={styles.more} disabled={loading} onClick={() => void loadList(cursor)}>加载更多</button>}
      </aside>
    </div>
  </section>;
}
