'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Copy, Download, ExternalLink, Image as ImageIcon, Music, X, Undo2, RefreshCw, RotateCcw } from 'lucide-react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { useRememberedScroll } from '@/lib/hooks/use-remembered-scroll';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import ContentReactions, { writeReaction } from './ContentReactions';
import type { ContentCategory, ContentKey, ContentSummary, ReactionAction, ReactionListItem, ReactionListResponse, ReactionState } from '@/lib/content-reactions/types';
import styles from './reactions.module.css';

const categories: Array<[ContentCategory | 'all', string]> = [['all', '全部'], ['image', '图片'], ['video', '视频'], ['audio', '音频'], ['template', '模板'], ['prompt', '提示词']];
const noCounts = { all: 0, image: 0, video: 0, audio: 0, template: 0, prompt: 0 };
const MAX_RESTORED_ITEMS = 240;
export const reactionEntryStorageKey = (userId: string) => `sd2-reaction-entry:${encodeURIComponent(userId)}`;
function readRememberedCount(key: string) {
  for (const name of ['sessionStorage', 'localStorage'] as const) {
    try {
      const saved = JSON.parse(window[name].getItem(key) || 'null');
      if (saved?.version === 1 && Number.isInteger(saved.count) && saved.count >= 0 && saved.count <= MAX_RESTORED_ITEMS) return Math.max(24, saved.count);
    } catch {}
  }
  return 24;
}
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
  const { user } = useAppSession();
  const params = useSearchParams();
  const key = params.get('content');
  if (!user || !key) return null;
  return <AccountContentLookup key={JSON.stringify([user.id, key])} contentKey={key} />;
}

function AccountContentLookup({ contentKey }: { contentKey: string }) {
  const [content, setContent] = useState<ContentSummary | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void readContent(contentKey as ContentKey).then(data => { if (active) setContent(data.content); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [contentKey]);
  return <>{error && <p role="alert">{error}</p>}{content && <ContentPreview content={content} close={() => setContent(null)} />}</>;
}

export default function ContentCollections({ action }: { action: ReactionAction }) {
  const { user } = useAppSession();
  const params = useSearchParams();
  const category = params.get('category');
  const query = params.get('q');
  const content = params.get('content');
  if (!user) return null;
  return <AccountCollections key={JSON.stringify([user.id, action, category, query, content])} userId={user.id} action={action} urlCategory={category} urlQuery={query} hasContent={content !== null} />;
}

function AccountCollections({ action, userId, urlCategory, urlQuery, hasContent }: { action: ReactionAction; userId: string; urlCategory: string | null; urlQuery: string | null; hasContent: boolean }) {
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
  const [loadedIdentity, setLoadedIdentity] = useState('');
  const [resetRevision, setResetRevision] = useState(0);
  const [storageWarning, setStorageWarning] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState<ContentSummary | null>(null);
  const [undo, setUndo] = useState<{ item: ReactionListItem; state: ReactionState } | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const sequence = useRef(0);
  const lock = useRef(false);
  const targetCount = useRef(24);
  const loadedCount = useRef(0);
  const lifetime = useRef(0);
  const mounted = useRef(true);
  const restorePagesLeft = useRef(9);
  const interacted = useRef(false);
  const explicitPosition = useRef(false);
  loadedCount.current = items.length;
  const scope = `${encodeURIComponent(userId)}:${action}`;
  const identity = `${scope}:${JSON.stringify([category, search])}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; lifetime.current++; sequence.current++; lock.current = false; }; }, []);
  useEffect(() => {
    const stop = () => { interacted.current = true; };
    const key = (event: KeyboardEvent) => { if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) stop(); };
    window.addEventListener('wheel', stop, { passive: true }); window.addEventListener('touchstart', stop, { passive: true });
    window.addEventListener('pointerdown', stop); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('wheel', stop); window.removeEventListener('touchstart', stop); window.removeEventListener('pointerdown', stop); window.removeEventListener('keydown', key); };
  }, []);
  useEffect(() => {
    let savedCategory: ContentCategory | 'all' = 'all';
    let savedQuery = '';
    try {
      const saved = JSON.parse(localStorage.getItem(`reaction-filters:${scope}`) || 'null');
      if (saved?.version === 1) {
        if (categories.some(([id]) => id === saved.category)) savedCategory = saved.category;
        if (typeof saved.query === 'string' && saved.query.length <= 160) savedQuery = saved.query;
      }
    } catch {}
    explicitPosition.current = urlCategory !== null || urlQuery !== null || hasContent || Boolean(window.location.hash);
    if (explicitPosition.current) { savedCategory = 'all'; savedQuery = ''; }
    if (categories.some(([id]) => id === urlCategory)) savedCategory = urlCategory as ContentCategory | 'all';
    if (urlQuery !== null) savedQuery = urlQuery.slice(0, 160);
    setCategory(savedCategory); setQuery(savedQuery); setSearch(savedQuery.trim());
    setPreferencesReady(true);
  }, [scope, urlCategory, urlQuery, hasContent]);
  useEffect(() => {
    if (!preferencesReady) return;
    try { localStorage.setItem(`reaction-filters:${scope}`, JSON.stringify({ version: 1, category, query })); }
    catch { setStorageWarning('浏览器未允许保存设置，本次仍可正常使用。'); }
  }, [preferencesReady, scope, category, query]);
  const restorationComplete = items.length >= targetCount.current || !cursor || (restorePagesLeft.current === 0 && !loading);
  const resetScroll = useRememberedScroll(`reactions:${identity}`, loaded && loadedIdentity === identity && restorationComplete, { localFallback: true, skipRestore: explicitPosition.current || interacted.current });
  useEffect(() => { if (!preferencesReady) return; const timer = setTimeout(() => setSearch(query.trim()), 250); return () => clearTimeout(timer); }, [query, preferencesReady]);
  const load = useCallback(async (next?: string) => {
    if (!mounted.current || !preferencesReady || (next && lock.current)) return;
    const serial = ++sequence.current;
    lock.current = true; setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ action, category, q: search, limit: '24' });
      if (next) params.set('cursor', next);
      const response = await fetch(`/api/content-reactions?${params}`, { cache: 'no-store' });
      const data: ReactionListResponse & { error?: string } = await response.json();
      if (!response.ok) throw new Error(data.error || '列表读取失败');
      if (serial !== sequence.current || currentIdentity.current !== identity) return;
      setItems(current => next ? [...current, ...data.items.filter(item => !current.some(existing => existing.key === item.key))] : data.items);
      setCounts(data.counts); setTotal(data.total); setCursor(data.nextCursor); setLoaded(true); setLoadedIdentity(identity);
    } catch (e) { if (serial === sequence.current && currentIdentity.current === identity) setError(e instanceof Error ? e.message : '列表读取失败'); }
    finally { if (serial === sequence.current && currentIdentity.current === identity) { lock.current = false; setLoading(false); } }
  }, [action, category, search, identity, preferencesReady]);
  useEffect(() => {
    setItems([]); setLoaded(false); setLoadedIdentity(''); setCursor(null); setUndo(null); setPreview(null); setCounts(noCounts); setTotal(0); setMessage(''); setError('');
    targetCount.current = explicitPosition.current || resetRevision ? 24 : readRememberedCount(`reaction-count:${identity}`);
    restorePagesLeft.current = 9;
    void load();
    return () => { lifetime.current++; sequence.current++; lock.current = false; };
  }, [identity, load, resetRevision]);
  useEffect(() => {
    if (!loaded || loadedIdentity !== identity || loading || error) return;
    if (cursor && items.length < targetCount.current && restorePagesLeft.current > 0) { restorePagesLeft.current--; void load(cursor); return; }
    const value = JSON.stringify({ version: 1, count: Math.min(MAX_RESTORED_ITEMS, items.length) });
    for (const name of ['sessionStorage', 'localStorage'] as const) {
      try { window[name].setItem(`reaction-count:${identity}`, value); } catch {}
    }
  }, [cursor, error, identity, items.length, load, loaded, loadedIdentity, loading]);
  useEffect(() => {
    const element = sentinel.current;
    if (!element || !cursor || loading || error || loadedIdentity !== identity || !restorationComplete) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void load(cursor); }, { rootMargin: '350px' });
    observer.observe(element); return () => observer.disconnect();
  }, [cursor, loading, error, load, loadedIdentity, identity, items.length, restorationComplete]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => { if (document.visibilityState === 'visible') { targetCount.current = Math.min(MAX_RESTORED_ITEMS, Math.max(24, targetCount.current, loadedCount.current)); restorePagesLeft.current = 9; setPreview(null); void load(); } };
    const changed = (event: Event) => {
      if ((event as CustomEvent).detail?.userId !== userId) return;
      clearTimeout(timer); timer = setTimeout(refresh, 200);
    };
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    window.addEventListener('sd2-reactions-changed', changed);
    return () => { clearTimeout(timer); window.removeEventListener('sd2-reactions-changed', changed); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [load, userId]);
  function currentOperation() {
    const revision = lifetime.current;
    return () => mounted.current && revision === lifetime.current && currentIdentity.current === identity;
  }
  async function open(item: ReactionListItem, copy = false) {
    const current = currentOperation();
    try {
      const data = await readContent(item.key);
      if (!current()) return;
      if (copy && data.prompt) { await navigator.clipboard.writeText(data.prompt); if (current()) setMessage('已复制文案'); }
      else if (data.content.previewUrl) setPreview(data.content);
      else router.push(data.content.href);
    } catch (e) {
      if (!current()) return;
      if ((e as { status?: number }).status === 404) {
        setItems(current => current.map(row => row.key === item.key ? { ...row, content: null, state: { ...row.state, available: false, likeCount: null } } : row));
      }
      setError(e instanceof Error ? e.message : '内容暂不可用');
    }
  }
  async function sendMediaToGeneration(item: ReactionListItem) {
    const current = currentOperation();
    try {
      const data = await readContent(item.key);
      if (!current()) return;
      if (!data.content.reuse) throw new Error('目前无权使用此素材');
      let tabId = sessionStorage.getItem('workspace_tab_id');
      if (!tabId) { tabId = crypto.randomUUID(); sessionStorage.setItem('workspace_tab_id', tabId); }
      const response = await fetch('/api/workspace/assets', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-tab-id': tabId }, body: JSON.stringify(data.content.reuse) });
      const result = await response.json();
      if (!current()) return;
      if (!response.ok) throw new Error(result.error || '素材使用失败');
      router.push('/generate');
    } catch (e) { if (current()) setError(e instanceof Error ? e.message : '操作失败'); }
  }
  function changed(item: ReactionListItem, state: ReactionState, changedAction: ReactionAction, active: boolean) {
    if (!mounted.current || currentIdentity.current !== identity) return;
    if (changedAction === action && !active) {
      setUndo({ item, state }); setItems(current => current.filter(row => row.key !== item.key));
      setTotal(current => Math.max(0, current - 1)); setCounts(current => ({ ...current, all: Math.max(0, current.all - 1), [item.category]: Math.max(0, current[item.category] - 1) }));
    }
  }
  function resetPreferences() {
    lifetime.current++; sequence.current++; lock.current = false;
    resetScroll();
    let cleared = true;
    for (const name of ['sessionStorage', 'localStorage'] as const) {
      try {
        const storage = window[name];
        const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
        keys.forEach(key => {
          if (key && (key === `reaction-filters:${scope}` || key.startsWith(`reaction-count:${scope}:`) || key.startsWith(`sd2-scroll:reactions:${scope}:`) || key === reactionEntryStorageKey(userId))) storage.removeItem(key);
        });
      } catch { cleared = false; }
    }
    try { localStorage.setItem(`reaction-filters:${scope}`, JSON.stringify({ version: 1, category: 'all', query: '' })); } catch { cleared = false; }
    setCategory('all'); setQuery(''); setSearch(''); setPreview(null); setUndo(null); setResetRevision(value => value + 1);
    const location = new URL(window.location.href);
    location.searchParams.delete('category'); location.searchParams.delete('q');
    window.history.replaceState(window.history.state, '', location);
    setStorageWarning(cleared ? '' : '筛选已重置，但浏览器未允许清除全部保存记录。');
  }
  if (!preferencesReady) return <p role="status">正在读取…</p>;
  return <section aria-label={action === 'favorite' ? '我的收藏' : '我赞过的'}>
    <div className={styles.toolbar}><div className={styles.tabs}>{categories.map(([id, label]) => <button key={id} type="button" aria-pressed={category === id} onClick={() => setCategory(id)}>{label} {counts[id]}</button>)}</div><input type="search" aria-label="搜索收藏内容" placeholder="搜索内容" maxLength={160} value={query} onChange={event => setQuery(event.target.value)} /><span className={styles.muted}>{action === 'favorite' ? '最近收藏' : '最近点赞'} · {total} 项</span><button className={styles.command} type="button" aria-label="刷新列表" title="刷新列表" disabled={loading} onClick={() => void load()}><RefreshCw size={16} /></button><button className={styles.command} type="button" aria-label="重置筛选和浏览位置（保留收藏）" title="重置筛选和浏览位置（保留收藏）" onClick={resetPreferences}><RotateCcw size={16} /></button></div>
    {error && <p role="alert">{error}<button className={styles.command} type="button" onClick={() => void load(cursor || undefined)}>重试</button></p>}
    {storageWarning && <p role="status">{storageWarning}</p>}
    {message && <p role="status">{message}</p>}
    <div className={styles.grid}>{items.map((item, index) => <article className={styles.card} key={item.key} data-remember-scroll-anchor={index < MAX_RESTORED_ITEMS ? item.key : undefined}>
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
    {undo && <div className={styles.undo} role="status">已取消{action === 'favorite' ? '收藏' : '点赞'}<button className={styles.command} type="button" onClick={async () => { const current = currentOperation(); try {
      const response = await fetch('/api/content-reactions/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: [undo.item.key] }) });
      const data = await response.json();
      if (!current()) return;
      if (!response.ok) throw new Error(data.error || '撤销失败');
      await writeReaction(userId, undo.item.key, action, true, data.states[undo.item.key]); if (!current()) return; setUndo(null); void load(); } catch (e) { if (current()) setError(e instanceof Error ? e.message : '撤销失败'); } }}><Undo2 size={15} /> 撤销</button><button className={styles.command} type="button" aria-label="关闭撤销提示" onClick={() => setUndo(null)}><X size={14} /></button></div>}
    {preview && <ContentPreview content={preview} close={() => setPreview(null)} />}
  </section>;
}
