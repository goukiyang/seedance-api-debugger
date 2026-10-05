'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Copy, Download, ExternalLink, Image as ImageIcon, Music, X, Undo2, RefreshCw, RotateCcw } from 'lucide-react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { useRememberedScroll } from '@/lib/hooks/use-remembered-scroll';
import MediaPreview from '@/components/MediaPreview';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import ContentReactions, { writeReaction } from './ContentReactions';
import TemplateFavoriteTitle from './TemplateFavoriteTitle';
import type { ContentCategory, ContentKey, ContentSummary, ReactionAction, ReactionListItem, ReactionListResponse, ReactionState } from '@/lib/content-reactions/types';
import styles from './reactions.module.css';

const categories: Array<[ContentCategory | 'all', string]> = [['all', '全部'], ['image', '图片'], ['video', '视频'], ['audio', '音频'], ['template', '模板'], ['prompt', '提示词']];
const noCounts = { all: 0, image: 0, video: 0, audio: 0, template: 0, prompt: 0 };
const MAX_RESTORED_ITEMS = 240;
export const reactionEntryStorageKey = (userId: string) => `sd2-reaction-entry:${encodeURIComponent(userId)}`;
const reactionPreviewStorageKey = (scope: string) => `reaction-preview:${scope}`;
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

function isPreviewableContent(content: ContentSummary | null | undefined): content is ContentSummary & { previewUrl: string } {
  return Boolean(content?.previewUrl && ['image', 'video', 'audio'].includes(content.category));
}

function isPreviewableItem(item: ReactionListItem | undefined): item is ReactionListItem & { content: ContentSummary } {
  return isPreviewableContent(item?.content);
}

function CollectionThumbnail({ content, preferPreviewImage }: { content: ContentSummary; preferPreviewImage?: boolean }) {
  const thumbnailUrl = preferPreviewImage && content.category === 'image'
    ? content.previewUrl || content.thumbnailUrl
    : content.thumbnailUrl;
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [thumbnailUrl]);
  if (failed) return <span>预览暂不可用，收藏仍保留</span>;
  if (thumbnailUrl) return <img src={thumbnailUrl} loading="lazy" alt={content.title} onError={() => setFailed(true)} />;
  return content.category === 'audio' ? <Music size={30} /> : <ImageIcon size={30} />;
}

export function ContentPreview({ content, close, onPrevious, onNext, hasNavigation, navigationMessage, onRetryNavigation }: {
  content: ContentSummary;
  close: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  hasNavigation?: boolean;
  navigationMessage?: string;
  onRetryNavigation?: () => void;
}) {
  if (!content.previewUrl || !['image', 'video', 'audio'].includes(content.category)) return null;
  return <MediaPreview
    src={content.previewUrl}
    type={content.category as 'image' | 'video' | 'audio'}
    title={content.title}
    poster={content.thumbnailUrl || undefined}
    contentKey={content.key}
    previewKey={content.key}
    details={<ContentReactions contentKey={content.key} />}
    notice={navigationMessage ? <div role="status">{navigationMessage}{onRetryNavigation && <button type="button" onClick={onRetryNavigation}>继续查找</button>}</div> : undefined}
    hasNavigation={hasNavigation}
    onPrevious={onPrevious}
    onNext={onNext}
    onClose={close}
  />;
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

export default function ContentCollections({ action, mediaClassName, preferPreviewImageThumbnails = false }: { action: ReactionAction; mediaClassName?: string; preferPreviewImageThumbnails?: boolean }) {
  const { user } = useAppSession();
  const params = useSearchParams();
  const category = params.get('category');
  const query = params.get('q');
  const content = params.get('content');
  if (!user) return null;
  return <AccountCollections key={JSON.stringify([user.id, action, category, query, content])} userId={user.id} action={action} urlCategory={category} urlQuery={query} hasContent={content !== null} mediaClassName={mediaClassName} preferPreviewImageThumbnails={preferPreviewImageThumbnails} />;
}

function AccountCollections({ action, userId, urlCategory, urlQuery, hasContent, mediaClassName, preferPreviewImageThumbnails }: { action: ReactionAction; userId: string; urlCategory: string | null; urlQuery: string | null; hasContent: boolean; mediaClassName?: string; preferPreviewImageThumbnails: boolean }) {
  const router = useRouter();
  const [category, setCategory] = useState<ContentCategory | 'all'>('all');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [items, setItems] = useState<ReactionListItem[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [counts, setCounts] = useState(noCounts);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadedIdentity, setLoadedIdentity] = useState('');
  const [resetRevision, setResetRevision] = useState(0);
  const [storageWarning, setStorageWarning] = useState('');
  const [error, setError] = useState('');
  const [previewNavigationMessage, setPreviewNavigationMessage] = useState('');
  const [previewNavigationRetryable, setPreviewNavigationRetryable] = useState(false);
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState<ContentSummary | null>(null);
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const [undo, setUndo] = useState<{ item: ReactionListItem; state: ReactionState } | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const sequence = useRef(0);
  const previewNavigationSequence = useRef(0);
  const lock = useRef(false);
  const cursorRef = useRef<string | null>(null);
  const previewRestoreAttempted = useRef(false);
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
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; lifetime.current++; sequence.current++; previewNavigationSequence.current++; lock.current = false; }; }, []);
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
    if (!mounted.current || !preferencesReady || (next && lock.current)) return [] as ReactionListItem[];
    const serial = ++sequence.current;
    lock.current = true; setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ action, category, q: search, limit: '24' });
      if (next) params.set('cursor', next);
      const response = await fetch(`/api/content-reactions?${params}`, { cache: 'no-store' });
      const data: ReactionListResponse & { error?: string } = await response.json();
      if (!response.ok) throw new Error(data.error || '列表读取失败');
      if (serial !== sequence.current || currentIdentity.current !== identity) return [] as ReactionListItem[];
      const incoming = next ? data.items.filter(item => !itemsRef.current.some(existing => existing.key === item.key)) : data.items;
      setItems(current => next ? [...current, ...data.items.filter(item => !current.some(existing => existing.key === item.key))] : data.items);
      setCounts(data.counts); setTotal(data.total); cursorRef.current = data.nextCursor; setCursor(data.nextCursor); setLoaded(true); setLoadedIdentity(identity);
      return incoming;
    } catch (e) { if (serial === sequence.current && currentIdentity.current === identity) setError(e instanceof Error ? e.message : '列表读取失败'); return [] as ReactionListItem[]; }
    finally { if (serial === sequence.current && currentIdentity.current === identity) { lock.current = false; setLoading(false); } }
  }, [action, category, search, identity, preferencesReady]);
  useEffect(() => {
    setItems([]); setLoaded(false); setLoadedIdentity(''); cursorRef.current = null; setCursor(null); setUndo(null); setCounts(noCounts); setTotal(0); setMessage(''); setError('');
    targetCount.current = explicitPosition.current || resetRevision ? 24 : readRememberedCount(`reaction-count:${identity}`);
    restorePagesLeft.current = 9;
    void load();
    return () => { lifetime.current++; sequence.current++; lock.current = false; };
  }, [identity, load, resetRevision]);
  useEffect(() => {
    if (!preferencesReady || previewRestoreAttempted.current) return;
    previewRestoreAttempted.current = true;
    if (explicitPosition.current || hasContent) return;
    let savedKey: string | null = null;
    const storageKey = reactionPreviewStorageKey(scope);
    try { savedKey = localStorage.getItem(storageKey); } catch {}
    if (!savedKey || savedKey.length > 512) return;
    const request = ++previewNavigationSequence.current;
    void readContent(savedKey as ContentKey).then(data => {
      if (request !== previewNavigationSequence.current || currentIdentity.current !== identity || interacted.current || previewRef.current) return;
      if (isPreviewableContent(data.content)) {
        setPreview(data.content);
      } else {
        try { if (localStorage.getItem(storageKey) === savedKey) localStorage.removeItem(storageKey); } catch {}
      }
    }).catch(error => {
      if (request !== previewNavigationSequence.current || currentIdentity.current !== identity) return;
      const status = (error as { status?: number }).status;
      if ([401, 403, 404].includes(status || 0)) {
        try { if (localStorage.getItem(storageKey) === savedKey) localStorage.removeItem(storageKey); } catch {}
      } else {
        setError('上次打开的媒体暂时无法核验，列表仍可正常使用。');
      }
    });
  }, [hasContent, identity, preferencesReady, scope]);
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
  const revalidatePreview = useCallback(async () => {
    const active = previewRef.current;
    if (!active) return;
    try {
      const data = await readContent(active.key);
      if (currentIdentity.current === identity && previewRef.current?.key === active.key) setPreview(data.content);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (currentIdentity.current === identity && previewRef.current?.key === active.key && [401, 403, 404].includes(status || 0)) {
        previewNavigationSequence.current++;
        setPreview(null);
        try { if (localStorage.getItem(reactionPreviewStorageKey(scope)) === active.key) localStorage.removeItem(reactionPreviewStorageKey(scope)); } catch {}
      } else if (currentIdentity.current === identity && previewRef.current?.key === active.key) {
        setError('预览权限暂未确认，内容仍保持打开；可以稍后刷新重试。');
      }
    }
  }, [identity, scope]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => { if (document.visibilityState === 'visible') { targetCount.current = Math.min(MAX_RESTORED_ITEMS, Math.max(24, targetCount.current, loadedCount.current)); restorePagesLeft.current = 9; void load(); void revalidatePreview(); } };
    const changed = (event: Event) => {
      if ((event as CustomEvent).detail?.userId !== userId) return;
      clearTimeout(timer); timer = setTimeout(refresh, 200);
    };
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    window.addEventListener('sd2-reactions-changed', changed);
    return () => { clearTimeout(timer); window.removeEventListener('sd2-reactions-changed', changed); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [load, revalidatePreview, userId]);
  function currentOperation() {
    const revision = lifetime.current;
    return () => mounted.current && revision === lifetime.current && currentIdentity.current === identity;
  }
  async function open(item: ReactionListItem, copy = false, navigation?: { sequence: number; fromKey: ContentKey }): Promise<'opened' | 'unavailable' | 'failed' | 'stale'> {
    const requestSequence = navigation?.sequence ?? ++previewNavigationSequence.current;
    const current = currentOperation();
    const navigationIsCurrent = () => previewNavigationSequence.current === requestSequence
      && (!navigation || previewRef.current?.key === navigation.fromKey);
    try {
      const data = await readContent(item.key);
      if (!current() || !navigationIsCurrent()) return 'stale';
      if (copy && data.prompt) { await navigator.clipboard.writeText(data.prompt); if (current() && navigationIsCurrent()) setMessage('已复制文案'); return 'opened'; }
      else if (isPreviewableContent(data.content)) {
        setPreviewNavigationMessage('');
        setPreviewNavigationRetryable(false);
        setPreview(data.content);
        try { localStorage.setItem(reactionPreviewStorageKey(scope), item.key); } catch { setStorageWarning('预览可正常使用，但浏览器未允许记住上次打开的媒体。'); }
        return 'opened';
      }
      else if (navigation) {
        setItems(currentItems => currentItems.map(row => row.key === item.key ? { ...row, content: null, state: { ...row.state, available: false, likeCount: null } } : row));
        return 'unavailable';
      } else { router.push(data.content.href); return 'opened'; }
    } catch (e) {
      if (!current() || !navigationIsCurrent()) return 'stale';
      const status = (e as { status?: number }).status;
      if (status === 404 || (navigation && status === 403)) {
        setItems(current => current.map(row => row.key === item.key ? { ...row, content: null, state: { ...row.state, available: false, likeCount: null } } : row));
        if (navigation) return 'unavailable';
      }
      setError(e instanceof Error ? e.message : '内容暂不可用');
      if (navigation) {
        setPreviewNavigationMessage('目标媒体暂时无法核验，当前预览保持打开；可以重试。');
        setPreviewNavigationRetryable(true);
        return 'failed';
      }
      return 'failed';
    }
    return 'unavailable';
  }
  async function navigatePreview(direction: -1 | 1) {
    const active = previewRef.current;
    if (!active) return;
    const request = ++previewNavigationSequence.current;
    setPreviewNavigationMessage('');
    setPreviewNavigationRetryable(false);
    const navigation = { sequence: request, fromKey: active.key };
    const isCurrent = () => previewNavigationSequence.current === request && previewRef.current?.key === active.key;
    const currentItems = itemsRef.current;
    const index = currentItems.findIndex(item => item.key === active.key);
    if (index < 0) return;
    const tryCandidates = async (candidates: ReactionListItem[]) => {
      for (const candidate of candidates) {
        if (!isPreviewableItem(candidate) || !isCurrent()) continue;
        const result = await open(candidate, false, navigation);
        if (!isCurrent() || result === 'stale') return 'stale';
        if (result === 'opened' || result === 'failed') return result;
      }
      return 'empty';
    };
    if (direction < 0) {
      const result = await tryCandidates(currentItems.slice(0, index).reverse());
      if (result === 'failed' || result === 'stale') return;
      return;
    }
    const loadedResult = await tryCandidates(currentItems.slice(index + 1));
    if (loadedResult === 'opened' || loadedResult === 'failed' || loadedResult === 'stale') return;
    let nextCursor = cursorRef.current;
    let pagesScanned = 0;
    while (nextCursor && isCurrent() && pagesScanned < 3) {
      const requestedCursor = nextCursor;
      setPreviewNavigationMessage('正在读取后续内容…');
      const nextItems = await load(requestedCursor);
      if (!isCurrent()) return;
      pagesScanned += 1;
      const result = await tryCandidates(nextItems);
      if (result === 'opened' || result === 'failed' || result === 'stale') return;
      nextCursor = cursorRef.current;
      if (nextCursor === requestedCursor) {
        setPreviewNavigationMessage('下一批内容读取失败，当前预览保持打开；可以重试加载后继续。');
        setPreviewNavigationRetryable(true);
        setError('下一批内容读取失败，当前预览保持打开；可以重试加载后继续。');
        return;
      }
    }
    if (isCurrent()) {
      const canContinue = cursorRef.current !== null;
      setPreviewNavigationMessage(canContinue
        ? `已检查 ${pagesScanned} 页，暂未找到可预览媒体；可继续查找。`
        : '后续没有可预览的图片、视频或音频。');
      setPreviewNavigationRetryable(canContinue);
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
    previewNavigationSequence.current++;
    resetScroll();
    let cleared = true;
    for (const name of ['sessionStorage', 'localStorage'] as const) {
      try {
        const storage = window[name];
        const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
        keys.forEach(key => {
          if (key && (key === `reaction-filters:${scope}` || key.startsWith(`reaction-count:${scope}:`) || key.startsWith(`sd2-scroll:reactions:${scope}:`) || key === reactionEntryStorageKey(userId) || key === reactionPreviewStorageKey(scope))) storage.removeItem(key);
        });
      } catch { cleared = false; }
    }
    try { localStorage.setItem(`reaction-filters:${scope}`, JSON.stringify({ version: 1, category: 'all', query: '' })); } catch { cleared = false; }
    setCategory('all'); setQuery(''); setSearch(''); setUndo(null); setPreview(null); previewRef.current = null; setPreviewNavigationMessage(''); setPreviewNavigationRetryable(false); setResetRevision(value => value + 1);
    const location = new URL(window.location.href);
    location.searchParams.delete('category'); location.searchParams.delete('q');
    window.history.replaceState(window.history.state, '', location);
    setStorageWarning(cleared ? '' : '筛选已重置，但浏览器未允许清除全部保存记录。');
  }
  if (!preferencesReady) return <p role="status">正在读取…</p>;
  return <section aria-label={action === 'favorite' ? '我的收藏' : '我赞过的'}>
    <div className={styles.toolbar}><div className={styles.tabs}>{categories.map(([id, label]) => <button key={id} type="button" aria-pressed={category === id} onClick={() => setCategory(id)}>{label} {counts[id]}</button>)}</div><input type="search" aria-label="搜索收藏内容" placeholder="搜索内容" maxLength={160} value={query} onChange={event => setQuery(event.target.value)} /><span className={styles.muted}>{action === 'favorite' ? '最近收藏' : '最近点赞'} · {total} 项</span><button className={styles.command} type="button" aria-label="刷新列表" title="刷新列表" disabled={loading} onClick={() => { void load(); void revalidatePreview(); }}><RefreshCw size={16} /></button><button className={styles.command} type="button" aria-label="重置筛选和浏览位置（保留收藏）" title="重置筛选和浏览位置（保留收藏）" onClick={resetPreferences}><RotateCcw size={16} /></button></div>
    {error && <p role="alert">{error}<button className={styles.command} type="button" onClick={() => void load(cursor || undefined)}>重试</button></p>}
    {storageWarning && <p role="status">{storageWarning}</p>}
    {message && <p role="status">{message}</p>}
    <div className={styles.grid}>{items.map((item, index) => <article className={styles.card} key={item.key} data-remember-scroll-anchor={index < MAX_RESTORED_ITEMS ? item.key : undefined}>
      <div className="media-reaction-cover" data-reaction-surface>
        <button className={`${styles.media} ${mediaClassName || ''}`.trim()} type="button" disabled={!item.content} onClick={() => void open(item)} aria-label={item.content ? `打开${item.content.title}` : '内容已不可用'}>{item.content ? <CollectionThumbnail content={item.content} preferPreviewImage={preferPreviewImageThumbnails} /> : '内容已不可用'}</button>
        {['image', 'video', 'audio'].includes(item.category) && <ContentReactions contentKey={item.key} initialState={item.state} overlay onChange={(state, act, active) => changed(item, state, act, active)} />}
      </div>
      <div className={styles.body}>{item.category === 'template' && action === 'favorite' ? <TemplateFavoriteTitle contentKey={item.key} initialState={item.state} onChange={(state, act, active) => changed(item, state, act, active)}><h3 className={styles.title} title={item.content?.title || '内容已不可用'}>{item.content?.title || '内容已不可用'}</h3></TemplateFavoriteTitle> : <h3 className={styles.title}>{item.content?.title || '内容已不可用'}</h3>}{item.content?.owner && <UserIdentityBadge size="sm" user={item.content.owner} />}
        {item.content?.versionLabel && <span className={styles.muted}>版本：{item.content.versionLabel}</span>}
        <div className={styles.actions}>{!['image', 'video', 'audio'].includes(item.category) && !(item.category === 'template' && action === 'favorite') && <ContentReactions contentKey={item.key} initialState={item.state} onChange={(state, act, active) => changed(item, state, act, active)} />}
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
    {preview && (() => {
      const index = items.findIndex(item => item.key === preview.key);
      const canPrevious = index > 0 && items.slice(0, index).some(isPreviewableItem);
      const canNext = index >= 0 && (items.slice(index + 1).some(isPreviewableItem) || Boolean(cursor));
      const closePreview = () => {
        previewNavigationSequence.current++;
        setPreview(null);
        previewRef.current = null;
        setPreviewNavigationMessage('');
        setPreviewNavigationRetryable(false);
        try { localStorage.removeItem(reactionPreviewStorageKey(scope)); } catch {}
      };
      return <ContentPreview
        content={preview}
        close={closePreview}
        hasNavigation={canPrevious || canNext}
        onPrevious={canPrevious ? () => void navigatePreview(-1) : undefined}
        onNext={canNext ? () => void navigatePreview(1) : undefined}
        navigationMessage={previewNavigationMessage}
        onRetryNavigation={previewNavigationRetryable ? () => void navigatePreview(1) : undefined}
      />;
    })()}
  </section>;
}
