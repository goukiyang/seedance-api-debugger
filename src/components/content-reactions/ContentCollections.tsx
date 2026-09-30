'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Copy, Download, ExternalLink, Image as ImageIcon, Music, X, Undo2, RefreshCw } from 'lucide-react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { useRememberedScroll } from '@/lib/hooks/use-remembered-scroll';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import ContentReactions, { writeReaction } from './ContentReactions';
import type { ContentCategory, ContentKey, ContentSummary, ReactionAction, ReactionListItem, ReactionListResponse, ReactionState } from '@/lib/content-reactions/types';
import styles from './reactions.module.css';

const categories: Array<[ContentCategory | 'all', string]> = [['all', '全部'], ['image', '图片'], ['video', '视频'], ['audio', '音频'], ['template', '模板'], ['prompt', '提示词']];
const noCounts = { all: 0, image: 0, video: 0, audio: 0, template: 0, prompt: 0 };
async function readContent(key: ContentKey) {
  const response = await fetch(`/api/content-reactions/content?key=${encodeURIComponent(key)}`, { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || '内容读取失败'), { status: response.status });
  return data as { content: ContentSummary; prompt?: string };
}

function CollectionThumbnail({ content }: { content: ContentSummary }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [content.thumbnailUrl]);
  if (failed) return <span>预览暂不可用，收藏仍保留</span>;
  if (content.thumbnailUrl) return <img src={content.thumbnailUrl} loading="lazy" alt={content.title} onError={() => setFailed(true)} />;
  return content.category === 'audio' ? <Music size={30} /> : <ImageIcon size={30} />;
}

export function ContentPreview({ content, close }: { content: ContentSummary; close: () => void }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [close]);
  if (content.category === 'image' && content.previewUrl) return <ZoomableImagePreview src={content.previewUrl} alt={content.title} contentKey={content.key} onClose={close} />;
  return <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="媒体预览" onClick={event => { if (event.target === event.currentTarget) close(); }}><div className={styles.preview}>
    <div className={styles.actions}><button autoFocus type="button" className={styles.command} onClick={close} title="关闭" aria-label="关闭"><X size={18} /></button><ContentReactions contentKey={content.key} /></div>
    {failed ? <p role="status">媒体暂时无法访问，请稍后重试。收藏仍保留。</p> : content.category === 'video' ? <video src={content.previewUrl || undefined} controls autoPlay onError={() => setFailed(true)} /> : content.category === 'audio' ? <audio src={content.previewUrl || undefined} controls autoPlay onError={() => setFailed(true)} /> : <p>{content.title}</p>}
  </div></div>;
}

export function ContentLookup() {
  const [content, setContent] = useState<ContentSummary | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const key = new URLSearchParams(window.location.search).get('content');
    if (!key) return;
    let active = true;
    void readContent(key as ContentKey).then(data => { if (active) setContent(data.content); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, []);
  return <>{error && <p role="alert">{error}</p>}{content && <ContentPreview content={content} close={() => setContent(null)} />}</>;
}

export default function ContentCollections({ action }: { action: ReactionAction }) {
  const { user } = useAppSession();
  const router = useRouter();
  const [category, setCategory] = useState<ContentCategory | 'all'>('all');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [items, setItems] = useState<ReactionListItem[]>([]);
  const [counts, setCounts] = useState(noCounts);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState<ContentSummary | null>(null);
  const [undo, setUndo] = useState<{ item: ReactionListItem; state: ReactionState } | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const sequence = useRef(0);
  const lock = useRef(false);
  const targetCount = useRef(24);
  const loadedCount = useRef(0);
  loadedCount.current = items.length;
  const identity = `${user?.id}:${action}:${category}:${search}`;
  useEffect(() => {
    if (!user?.id) return;
    try {
      const saved = JSON.parse(sessionStorage.getItem(`reaction-filters:${user.id}:${action}`) || 'null');
      if (saved && categories.some(([id]) => id === saved.category)) setCategory(saved.category);
      if (typeof saved?.query === 'string') { setQuery(saved.query.slice(0, 160)); setSearch(saved.query.trim().slice(0, 160)); }
    } catch {}
    setPreferencesReady(true);
  }, [user?.id, action]);
  useEffect(() => {
    if (!preferencesReady || !user?.id) return;
    try { sessionStorage.setItem(`reaction-filters:${user.id}:${action}`, JSON.stringify({ category, query })); } catch {}
  }, [preferencesReady, user?.id, action, category, query]);
  useRememberedScroll(`reactions:${identity}`, loaded);
  useEffect(() => { const timer = setTimeout(() => setSearch(query.trim()), 250); return () => clearTimeout(timer); }, [query]);
  const load = useCallback(async (next?: string) => {
    if (!user || !preferencesReady || (next && lock.current)) return;
    const serial = ++sequence.current;
    lock.current = true; setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ action, category, q: search, limit: '24' });
      if (next) params.set('cursor', next);
      const response = await fetch(`/api/content-reactions?${params}`, { cache: 'no-store' });
      const data: ReactionListResponse & { error?: string } = await response.json();
      if (!response.ok) throw new Error(data.error || '列表读取失败');
      if (serial !== sequence.current) return;
      setItems(current => next ? [...current, ...data.items.filter(item => !current.some(existing => existing.key === item.key))] : data.items);
      setCounts(data.counts); setTotal(data.total); setCursor(data.nextCursor); setLoaded(true);
    } catch (e) { if (serial === sequence.current) setError(e instanceof Error ? e.message : '列表读取失败'); }
    finally { if (serial === sequence.current) { lock.current = false; setLoading(false); } }
  }, [action, category, search, user, preferencesReady]);
  useEffect(() => {
    setItems([]); setLoaded(false); setCursor(null); setUndo(null); setPreview(null);
    try { targetCount.current = Math.min(240, Math.max(24, Number(sessionStorage.getItem(`reaction-count:${identity}`)) || 24)); } catch { targetCount.current = 24; }
    void load();
    return () => { sequence.current++; lock.current = false; };
  }, [identity, load]);
  useEffect(() => {
    if (!loaded || loading || error) return;
    if (cursor && items.length < targetCount.current) { void load(cursor); return; }
    try { sessionStorage.setItem(`reaction-count:${identity}`, String(items.length)); } catch {}
  }, [cursor, error, identity, items.length, load, loaded, loading]);
  useEffect(() => {
    const element = sentinel.current;
    if (!element || !cursor || loading || error) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void load(cursor); }, { rootMargin: '350px' });
    observer.observe(element); return () => observer.disconnect();
  }, [cursor, loading, error, load]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => { if (document.visibilityState === 'visible') { targetCount.current = Math.max(24, loadedCount.current); setPreview(null); void load(); } };
    const changed = (event: Event) => {
      if ((event as CustomEvent).detail?.userId !== user?.id) return;
      clearTimeout(timer); timer = setTimeout(refresh, 200);
    };
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    window.addEventListener('sd2-reactions-changed', changed);
    return () => { clearTimeout(timer); window.removeEventListener('sd2-reactions-changed', changed); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [load, user?.id]);
  async function open(item: ReactionListItem, copy = false) {
    try {
      const data = await readContent(item.key);
      if (copy && data.prompt) { await navigator.clipboard.writeText(data.prompt); setMessage('已复制文案'); }
      else if (data.content.previewUrl) setPreview(data.content);
      else router.push(data.content.href);
    } catch (e) {
      if ((e as { status?: number }).status === 404) {
        setItems(current => current.map(row => row.key === item.key ? { ...row, content: null, state: { ...row.state, available: false, likeCount: null } } : row));
      }
      setError(e instanceof Error ? e.message : '内容暂不可用');
    }
  }
  async function sendMediaToGeneration(item: ReactionListItem) {
    try {
      const data = await readContent(item.key);
      if (!data.content.reuse) throw new Error('目前无权使用此素材');
      let tabId = sessionStorage.getItem('workspace_tab_id');
      if (!tabId) { tabId = crypto.randomUUID(); sessionStorage.setItem('workspace_tab_id', tabId); }
      const response = await fetch('/api/workspace/assets', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-tab-id': tabId }, body: JSON.stringify(data.content.reuse) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '素材使用失败');
      router.push('/generate');
    } catch (e) { setError(e instanceof Error ? e.message : '操作失败'); }
  }
  function changed(item: ReactionListItem, state: ReactionState, changedAction: ReactionAction, active: boolean) {
    if (changedAction === action && !active) {
      setUndo({ item, state }); setItems(current => current.filter(row => row.key !== item.key));
      setTotal(current => Math.max(0, current - 1)); setCounts(current => ({ ...current, all: Math.max(0, current.all - 1), [item.category]: Math.max(0, current[item.category] - 1) }));
    }
  }
  return <section aria-label={action === 'favorite' ? '我的收藏' : '我赞过的'}>
    <div className={styles.toolbar}><div className={styles.tabs}>{categories.map(([id, label]) => <button key={id} type="button" aria-pressed={category === id} onClick={() => setCategory(id)}>{label} {counts[id]}</button>)}</div><input type="search" aria-label="搜索收藏内容" placeholder="搜索内容" value={query} onChange={event => setQuery(event.target.value)} /><span className={styles.muted}>{action === 'favorite' ? '最近收藏' : '最近点赞'} · {total} 项</span><button className={styles.command} type="button" aria-label="刷新列表" title="刷新列表" disabled={loading} onClick={() => void load()}><RefreshCw size={16} /></button></div>
    {error && <p role="alert">{error}<button className={styles.command} type="button" onClick={() => void load(cursor || undefined)}>重试</button></p>}
    {message && <p role="status">{message}</p>}
    <div className={styles.grid}>{items.map(item => <article className={styles.card} key={item.key}>
      <button className={styles.media} type="button" disabled={!item.content} onClick={() => void open(item)} aria-label={item.content ? `打开${item.content.title}` : '内容已不可用'}>{item.content ? <CollectionThumbnail content={item.content} /> : '内容已不可用'}</button>
      <div className={styles.body}><h3 className={styles.title}>{item.content?.title || '内容已不可用'}</h3>{item.content?.owner && <UserIdentityBadge size="sm" user={item.content.owner} />}
        {item.content?.versionLabel && <span className={styles.muted}>版本：{item.content.versionLabel}</span>}
        <div className={styles.actions}><ContentReactions contentKey={item.key} initialState={item.state} onChange={(state, act, active) => changed(item, state, act, active)} />
          {item.content && <button className={styles.command} type="button" onClick={() => void open(item)}><ExternalLink size={15} /> {item.content.actionLabel}</button>}
          {item.content?.downloadUrl && <a className={styles.command} title="下载" aria-label="下载" href={item.content.downloadUrl}><Download size={16} /></a>}
          {item.content && item.category === 'prompt' && <button className={styles.command} title="复制文案" aria-label="复制文案" type="button" onClick={() => void open(item, true)}><Copy size={16} /></button>}
          {item.content?.reuse && <button className={styles.command} type="button" onClick={() => void sendMediaToGeneration(item)}>带到生成</button>}
        </div>
      </div>
    </article>)}</div>
    {!loading && loaded && !items.length && !error && <p className={styles.status}>暂无符合条件的内容</p>}
    <div ref={sentinel} className={styles.status}>{loading ? '正在读取…' : cursor ? <button className={styles.command} type="button" onClick={() => void load(cursor)}>加载更多</button> : loaded && items.length ? '已显示全部' : null}</div>
    {undo && <div className={styles.undo} role="status">已取消{action === 'favorite' ? '收藏' : '点赞'}<button className={styles.command} type="button" onClick={async () => { if (!user) return; try {
      const response = await fetch('/api/content-reactions/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: [undo.item.key] }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '撤销失败');
      await writeReaction(user.id, undo.item.key, action, true, data.states[undo.item.key]); setUndo(null); void load(); } catch (e) { setError(e instanceof Error ? e.message : '撤销失败'); } }}><Undo2 size={15} /> 撤销</button><button className={styles.command} type="button" aria-label="关闭撤销提示" onClick={() => setUndo(null)}><X size={14} /></button></div>}
    {preview && <ContentPreview content={preview} close={() => setPreview(null)} />}
  </section>;
}
