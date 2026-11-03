'use client';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Bookmark, Plus, RefreshCw, Search, SlidersHorizontal, X } from 'lucide-react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { prepareWorkImage, type PreparedWorkImage } from '@/lib/works/image-preview';
import { AssetPlaybackCoordinator } from '@/lib/media/asset-playback';
import { parseWorksQuery, pendingWorkOperations, queryWorkOperation, worksMutate, worksQueryString, worksRead, WorksClientError, type PendingWorkOperation } from '@/lib/works/client';
import type { WorkCard, WorkPage, WorkQuery } from '@/lib/works/types';
import { WorksMasonry, visibleWorkAnchor } from './WorksMasonry';
import { savedWorkView, savedWorkUrl, saveWorkView, type SavedWorkView, type WorkRestore } from '@/lib/works/view-state';
import { WorkFilterPicker } from './WorkFilterPicker';
import { WorkDetail } from './WorkDetail';
import { ClassifyWork, CollectionManager, useWorkCollections } from './WorkCollections';
import { AddWorkPicker } from './AddWorkPicker';
import type { WorkOperate } from './WorkActions';
import styles from './Works.module.css';

export default function WorksWorkspace() {
  const session = useAppSession();
  if (session.sessionChanged) return <div className="container" role="status">账号已变化，原账号的待核对操作已保留。<button type="button" className="btn btn-secondary" onClick={() => window.location.reload()}>刷新后继续</button></div>;
  if (!session.hasLoadedUser || session.loadingUser) return <div className={styles.page}><div className={styles.skeleton} role="status">正在读取账号…</div></div>;
  if (!session.user) return <div className="container" role="status">{session.userLoadError || '请先登录后查看作品。'}<button type="button" onClick={() => void session.refreshUser({ force: true })}>重试读取账号</button></div>;
  if (!session.user.works_preview) return <div className="container" role="status">此页面暂不可用。</div>;
  return <AccountWorks key={session.user.id} viewerId={session.user.id} account={`${session.user.id}:${session.user.role || ''}:${session.user.account_type || ''}`} />;
}
function AccountWorks({ viewerId, account }: { viewerId: string; account: string }) {
  const router = useRouter(), searchParams = useSearchParams(), paramsKey = searchParams.toString();
  const query = useMemo(() => parseWorksQuery(new URLSearchParams(paramsKey)), [paramsKey]), queryKey = worksQueryString(query).toString(), workId = searchParams.get('work') || '';
  const [ready, setReady] = useState(false), [pages, setPages] = useState<WorkPage[]>([]), [loading, setLoading] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [methodHref, setMethodHref] = useState(''), [failedDirection, setFailedDirection] = useState<'initial' | 'before' | 'after'>('initial');
  const [refresh, setRefresh] = useState(0), [detailRevision, setDetailRevision] = useState(0), [collectionRevision, setCollectionRevision] = useState(0), [classify, setClassify] = useState<WorkCard | null>(null), [adding, setAdding] = useState(false), [search, setSearch] = useState(query.q || ''), [busy, setBusy] = useState<string[]>([]), [pending, setPending] = useState<PendingWorkOperation[]>([]), [restore, setRestore] = useState<WorkRestore | null>(null), [filtersOpen, setFiltersOpen] = useState(false), [filterNames, setFilterNames] = useState<Record<string, string>>({});
  const epoch = useRef(0), alive = useRef(true), loadBusy = useRef(false), pagesRef = useRef(pages), queryRef = useRef(queryKey), loadedQueryRef = useRef(queryKey), resetWindow = useRef(false), restoringList = useRef(false), operationLocks = useRef(new Set<string>()), detailOpenedHere = useRef(false), pendingDetailBack = useRef(false), navigationEpoch = useRef(0), restoreGeneration = useRef(0), workIdRef = useRef(workId), previousWorkId = useRef<string | null>(null), sentinel = useRef<HTMLDivElement>(null), autoAttempt = useRef(''), autoMore = useRef<() => void>(() => {});
  pagesRef.current = pages; queryRef.current = queryKey; workIdRef.current = workId;
  const playback = useMemo(() => new AssetPlaybackCoordinator(), []), directory = useWorkCollections(viewerId, collectionRevision);
  const imagePreparation = useRef<PreparedWorkImage>();
  useEffect(() => () => { imagePreparation.current?.handle.release(); imagePreparation.current = undefined; }, [account]);
  const items = useMemo(() => pages.flatMap(page => page.items).filter((work, index, all) => all.findIndex(other => other.id === work.id) === index).filter(work => {
    if (query.scope === 'managed') return true;
    if (work.withdrawn || !work.discoverable && query.scope !== 'favorites' && !query.collection || (query.scope === 'hidden' ? !work.personal.hidden : work.personal.hidden)) return false;
    if (query.scope === 'favorites' && !work.personal.favorited) return false;
    return !query.collection || work.collectionIds.includes(query.collection);
  }), [pages, query.scope, query.collection]);
  const busyKeys = [...busy, ...pending.map(item => item.key)];
  useEffect(() => {
    const navigate = (event: Event) => { navigationEpoch.current++; if (event.type === 'popstate') resetWindow.current = false; };
    window.addEventListener('wheel', navigate, { passive: true, capture: true });
    window.addEventListener('touchstart', navigate, { passive: true, capture: true });
    window.addEventListener('pointerdown', navigate, true); window.addEventListener('keydown', navigate, true); window.addEventListener('popstate', navigate);
    return () => { window.removeEventListener('wheel', navigate, true); window.removeEventListener('touchstart', navigate, true); window.removeEventListener('pointerdown', navigate, true); window.removeEventListener('keydown', navigate, true); window.removeEventListener('popstate', navigate); };
  }, []);
  useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current++; playback.stopAll('account'); }; }, [playback]);
  useEffect(() => {
    setPending(pendingWorkOperations(viewerId)); const saved = savedWorkView(viewerId);
    if (!paramsKey && saved) router.replace(savedWorkUrl(saved), { scroll: false });
    setReady(true);
    // URL changes after initial recovery are authoritative.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerId]);
  useEffect(() => setSearch(query.q || ''), [query.q]);
  const remember = useCallback(() => {
    const current = pagesRef.current; if (!current.length || restoringList.current && !workIdRef.current) return;
    const query: SavedWorkView['query'] = parseWorksQuery(new URLSearchParams(loadedQueryRef.current));
    if (queryRef.current === loadedQueryRef.current && workIdRef.current) query.work = workIdRef.current;
    const previous = savedWorkView(viewerId, loadedQueryRef.current);
    // A detail page has its own scroll; it must never overwrite the list position.
    saveWorkView(viewerId, { query, window: current[0].window, anchor: workIdRef.current ? previous?.anchor || null : visibleWorkAnchor() });
  }, [viewerId]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const save = () => { if (timer) clearTimeout(timer); timer = setTimeout(remember, 200); };
    window.addEventListener('scroll', save, { passive: true }); window.addEventListener('pagehide', remember);
    return () => { if (timer) clearTimeout(timer); window.removeEventListener('scroll', save); window.removeEventListener('pagehide', remember); remember(); };
  }, [remember]);
  const load = useCallback(async (direction: 'initial' | 'before' | 'after', token = epoch.current) => {
    if (loadBusy.current) return; loadBusy.current = true; setLoading(true); setError(''); setFailedDirection(direction);
    const navigation = navigationEpoch.current, current = pagesRef.current, params = new URLSearchParams(queryKey), saved = savedWorkView(viewerId, queryKey), sameSaved = !resetWindow.current && Boolean(saved);
    if (direction === 'initial' && sameSaved && saved) { params.set('window', saved.window); if (saved.anchor?.id) params.set('anchor', saved.anchor.id); }
    if (direction !== 'initial' && current.length) { params.set('window', current[0].window); const cursor = direction === 'before' ? current[0].previousCursor : current[current.length - 1].nextCursor; if (cursor) params.set(direction, cursor); }
    const anchor = direction === 'initial' ? sameSaved ? saved?.anchor || null : null : visibleWorkAnchor();
    try {
      const data = await worksRead<WorkPage>(`/api/works?${params}`, viewerId); if (!alive.current || token !== epoch.current || queryRef.current !== queryKey) return;
      loadedQueryRef.current = queryKey;
      setPages(old => direction === 'initial' ? [data] : direction === 'after' ? [...old, data].slice(-6) : [data, ...old].slice(0, 6));
      const position = direction === 'initial' ? anchor : visibleWorkAnchor();
      restoringList.current = Boolean(!data.anchorUnavailable && position && navigation === navigationEpoch.current);
      setRestore(!data.anchorUnavailable && position && navigation === navigationEpoch.current ? { ...position, navigationEpoch: navigation, generation: ++restoreGeneration.current } : null);
      if (data.anchorUnavailable) setNotice('原位置当前不可访问，已显示附近可读作品。'); resetWindow.current = false;
    } catch (cause) { if (alive.current && token === epoch.current) setError(cause instanceof WorksClientError && [401, 403].includes(cause.status) ? '当前账号暂时无法访问作品广场，请确认登录或权限。' : cause instanceof Error ? cause.message : '作品读取未完成'); }
    finally { if (alive.current && token === epoch.current) { loadBusy.current = false; setLoading(false); } }
  }, [queryKey, viewerId]);
  useEffect(() => { if (!ready) return; const token = ++epoch.current; loadBusy.current = false; pagesRef.current = []; setPages([]); setNotice(''); playback.stopAll('filter'); void load('initial', token); }, [ready, load, refresh, playback]);
  function updateQuery(patch: Partial<WorkQuery>) {
    navigationEpoch.current++; remember(); resetWindow.current = true; setRestore(null); setClassify(null); const next = { ...query, ...patch };
    for (const key of Object.keys(next) as Array<keyof WorkQuery>) if (!next[key] || next[key] === 'all') delete next[key];
    const params = worksQueryString(next); if (!params.size) params.set('scope', 'all'); router.push(`/works?${params}`, { scroll: false }); window.scrollTo({ top: 0 });
  }
  useLayoutEffect(() => {
    if (imagePreparation.current && imagePreparation.current.workId !== workId) {
      imagePreparation.current.handle.release(); imagePreparation.current = undefined;
    }
    if (previousWorkId.current === workId) return;
    const wasDetail = Boolean(previousWorkId.current); previousWorkId.current = workId;
    const state = window.history.state || {}, marker = state.__sd2WorksPage;
    // Each router entry remembers whether Back has a known works-page destination.
    // Direct links and restored last views keep a safe list fallback, including after reload.
    const canBack = Boolean(workId && (pendingDetailBack.current || marker?.viewerId === viewerId && marker.workId === workId && marker.canBack === true));
    pendingDetailBack.current = false; detailOpenedHere.current = canBack;
    window.history.replaceState({ ...state, __sd2WorksPage: { viewerId, workId, canBack } }, '');
    if (workId) { window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior }); return; }
    if (wasDetail) {
      const anchor = savedWorkView(viewerId, queryKey)?.anchor;
      restoringList.current = Boolean(anchor);
      setRestore(anchor ? { ...anchor, navigationEpoch: navigationEpoch.current, generation: ++restoreGeneration.current } : null);
      if (!anchor) window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
    }
  }, [workId, queryKey, viewerId]);
  function open(work: WorkCard) {
    if (work.id === workId) return;
    navigationEpoch.current++; remember(); pendingDetailBack.current = true;
    if (!workId) {
      const saved = savedWorkView(viewerId, queryKey);
      if (saved?.anchor) saveWorkView(viewerId, { ...saved, anchor: { ...saved.anchor, focusId: work.id, focusAction: document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>('[data-work-action]')?.dataset.workAction || 'preview' : 'preview' } });
    }
    playback.stopAll('page');
    imagePreparation.current?.handle.release();
    imagePreparation.current = prepareWorkImage(account, work);
    const params = new URLSearchParams(searchParams); params.set('work', work.id); router.push(`/works?${params}`, { scroll: false });
  }
  function close() { navigationEpoch.current++; if (detailOpenedHere.current) { router.back(); return; } const params = new URLSearchParams(searchParams); params.delete('work'); if (!params.size) params.set('scope', 'all'); router.replace(`/works?${params}`, { scroll: false }); }
  function returnToList() { navigationEpoch.current++; remember(); const params = new URLSearchParams(searchParams); params.delete('work'); if (!params.size) params.set('scope', 'all'); router.push(`/works?${params}`, { scroll: false }); }
  const updateWork = useCallback((work: WorkCard) => { setPages(old => old.map(page => ({ ...page, items: page.items.map(item => item.id === work.id ? work : item) }))); setClassify(old => old?.id === work.id ? work : old); }, []);
  const applyResult = useCallback(async (result: Record<string, unknown>, key: string) => {
    if (!alive.current) return;
    if (key.startsWith('method:') && typeof result.href === 'string' && result.href.startsWith('/') && !result.href.startsWith('//')) setMethodHref(result.href);
    const idForPatch = typeof result.workId === 'string' ? result.workId : '';
    if (idForPatch) setPages(old => old.map(page => ({ ...page, items: page.items.map(work => {
      if (work.id !== idForPatch) return work;
      const liked = typeof result.liked === 'boolean' ? result.liked : work.personal.liked;
      const next = { ...work, personal: { ...work.personal, liked, favorited: typeof result.favorited === 'boolean' ? result.favorited : work.personal.favorited, hidden: typeof result.hidden === 'boolean' ? result.hidden : work.personal.hidden, version: typeof result.stateVersion === 'number' ? result.stateVersion : work.personal.version }, likeCount: Math.max(0, work.likeCount + Number(liked) - Number(work.personal.liked)) };
      if (Array.isArray(result.collectionIds)) next.collectionIds = result.collectionIds as string[];
      if (typeof result.collectionId === 'string' && typeof result.active === 'boolean') next.collectionIds = result.active ? Array.from(new Set([...work.collectionIds, result.collectionId])) : work.collectionIds.filter(id => id !== result.collectionId);
      if (typeof result.discoverable === 'boolean') next.discoverable = result.discoverable;
      if (typeof result.withdrawn === 'boolean') next.withdrawn = result.withdrawn;
      if (typeof result.revision === 'number') next.revision = result.revision;
      return next;
    }) })));
    if (result.kind === 'collection-delete') {
      const params = new URLSearchParams(queryRef.current);
      if (params.get('collection') === result.collectionId) { params.delete('collection'); resetWindow.current = true; router.replace(`/works?${params}`, { scroll: false }); }
    }
    setCollectionRevision(value => value + 1); setDetailRevision(value => value + 1);
    const id = typeof result.workId === 'string' ? result.workId : key.startsWith('work:') ? key.slice(5) : '';
    if (id) { try { const data = await worksRead<{ viewerId: string; work: WorkCard }>(`/api/works/${encodeURIComponent(id)}`, viewerId); if (alive.current) updateWork(data.work); } catch { if (alive.current) setNotice('操作已保存，作品信息暂未更新，可重新读取。'); } }
  }, [viewerId, updateWork, router]);
  const operate: WorkOperate = useCallback(async (key, url, body, method = 'POST') => {
    if (operationLocks.current.has(key)) return null; operationLocks.current.add(key); setBusy(old => [...old, key]); setNotice(''); setMethodHref('');
    try { const result = await worksMutate(viewerId, key, url, body, method); if (!alive.current) return null; await applyResult(result, key); setNotice(url.endsWith('/publish') ? '已加入我的作品，点击刷新查看新作品。' : url.endsWith('/reference') ? '已加入生成工作区' : '已保存'); return result; }
    catch (cause) { if (alive.current) { setNotice(cause instanceof Error ? cause.message : '操作未完成'); if (cause instanceof WorksClientError && cause.status === 409 && (key.startsWith('work:') || key.startsWith('method:'))) { setDetailRevision(value => value + 1); void worksRead<{ viewerId: string; work: WorkCard }>(`/api/works/${encodeURIComponent(key.slice(key.indexOf(':') + 1))}`, viewerId).then(data => { if (alive.current) updateWork(data.work); }).catch(() => {}); } } return null; }
    finally { operationLocks.current.delete(key); if (alive.current) { setBusy(old => old.filter(item => item !== key)); setPending(pendingWorkOperations(viewerId)); } }
  }, [viewerId, applyResult, updateWork]);
  async function reconcile(operation: PendingWorkOperation) {
    if (operationLocks.current.has(operation.key)) return; operationLocks.current.add(operation.key); setBusy(old => [...old, operation.key]);
    try { const result = await queryWorkOperation(viewerId, operation); if (alive.current) { await applyResult(result, operation.key); setNotice('原操作已确认保存'); } }
    catch (cause) { if (alive.current) setNotice(cause instanceof Error ? cause.message : '原操作尚未确认'); }
    finally { operationLocks.current.delete(operation.key); if (alive.current) { setBusy(old => old.filter(item => item !== operation.key)); setPending(pendingWorkOperations(viewerId)); } }
  }
  useEffect(() => { if (ready && pagesRef.current.length && loadedQueryRef.current === queryKey) remember(); }, [workId, queryKey, ready, remember]);
  const onRestored = useCallback((generation: number) => { restoringList.current = false; setRestore(old => old?.generation === generation ? null : old); }, []), first = pages[0], last = pages[pages.length - 1], hasFilters = Boolean(query.q || query.author || query.project || query.collection);
  autoMore.current = () => {
    if (!ready || loading || error || workId || classify || adding || loadBusy.current) return;
    const current = pagesRef.current, last = current[current.length - 1]; if (!last?.nextCursor) return;
    const attempt = `${epoch.current}:${last.window}:${last.nextCursor}`; if (autoAttempt.current === attempt) return;
    autoAttempt.current = attempt; void load('after');
  };
  const hasNext = Boolean(last?.nextCursor);
  useEffect(() => {
    const target = sentinel.current; if (!ready || !hasNext || !target) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) autoMore.current(); }, { rootMargin: '500px 0px' });
    observer.observe(target); return () => observer.disconnect();
  }, [ready, hasNext, queryKey, refresh, workId]);
  const filterLabel = (key: 'author' | 'project') => {
    const match = items.find(work => key === 'author' ? work.author.id === query.author : work.project?.id === query.project);
    return (key === 'author' ? match?.author.name : match?.project?.name) || filterNames[`${key}:${query[key]}`];
  };
  function chooseFilter(key: 'author' | 'project', id?: string, name?: string) {
    const match = items.find(work => key === 'author' ? work.author.id === id : work.project?.id === id);
    const label = name || (key === 'author' ? match?.author.name : match?.project?.name);
    if (id && label) setFilterNames(old => Object.fromEntries([...Object.entries(old), [`${key}:${id}`, label]].slice(-100)));
    updateQuery({ [key]: id });
  }
  return <div className={styles.page}>
    {!workId && <>
    <header className={styles.heading}><h1>作品广场</h1><div><button type="button" disabled={loading} onClick={() => { navigationEpoch.current++; remember(); resetWindow.current = true; window.scrollTo({ top: 0 }); setRefresh(value => value + 1); }}><RefreshCw size={16} />刷新</button><button type="button" className={styles.primary} onClick={() => setAdding(true)}><Plus size={17} />添加作品</button></div></header>
    <nav className={styles.scopes} aria-label="作品范围">{([['all', '全部作品'], ['mine', '我的作品'], ['favorites', '我的收藏'], ['hidden', '我隐藏的作品'], ['managed', '作品管理']] as const).map(([scope, label]) => <button key={scope} type="button" aria-pressed={(query.scope || 'all') === scope} onClick={() => updateQuery({ scope, collection: undefined })}>{scope === 'favorites' && <Bookmark size={15} />}{label}</button>)}</nav>
    <div className={styles.toolbar}><form onSubmit={event => { event.preventDefault(); updateQuery({ q: search.trim() || undefined }); }} className={styles.search}><Search size={17} /><input type="search" value={search} maxLength={120} aria-label="搜索作品标题" placeholder="搜索作品标题" onChange={event => setSearch(event.target.value)} /><button type="submit">搜索</button></form><div className={styles.types} role="group" aria-label="作品类型">{([['all', '全部'], ['image', '图片'], ['video', '视频']] as const).map(([medium, label]) => <button key={medium} type="button" aria-pressed={(query.medium || 'all') === medium} onClick={() => updateQuery({ medium })}>{label}</button>)}</div><button type="button" className={styles.filterTrigger} aria-expanded={filtersOpen} onClick={() => setFiltersOpen(value => !value)}><SlidersHorizontal size={17} />筛选</button></div>
    <div className={styles.filterHelp} data-open={filtersOpen || undefined}>
      <WorkFilterPicker viewerId={viewerId} kind="authors" value={query.author} label={filterLabel('author')} onSelect={(id, name) => chooseFilter('author', id, name)} />
      <WorkFilterPicker viewerId={viewerId} kind="projects" value={query.project} label={filterLabel('project')} onSelect={(id, name) => chooseFilter('project', id, name)} />
    </div>
    {hasFilters && <div className={styles.chips} aria-label="当前筛选">{query.q && <button type="button" onClick={() => updateQuery({ q: undefined })}>标题：{query.q}<X size={14} /></button>}{(['author', 'project'] as const).map(key => query[key] && <button key={key} type="button" onClick={() => updateQuery({ [key]: undefined })}>{filterLabel(key) ? `${key === 'author' ? '作者' : '项目'}：${filterLabel(key)}` : key === 'author' ? '已选作者' : '已选项目'}<X size={14} /></button>)}{query.collection && <button type="button" onClick={() => updateQuery({ collection: undefined })}>{directory.collections.find(item => item.id === query.collection)?.name || '已选集合'}<X size={14} /></button>}<button type="button" onClick={() => updateQuery({ q: undefined, author: undefined, project: undefined, collection: undefined })}>清除筛选</button></div>}
    </>}
    {notice && <div className={styles.notice} role="status"><span>{notice}{methodHref && <a href={methodHref} className={styles.textAction}>打开本人模板草稿</a>}</span><button type="button" aria-label="关闭提示" onClick={() => { setNotice(''); setMethodHref(''); }}><X size={15} /></button></div>}
    {pending.length > 0 && <div className={styles.pending} role="status"><p>有 {pending.length} 项提交结果待确认，原操作编号已保留。</p>{pending.map(operation => <button key={operation.requestId} type="button" title={operation.requestId} disabled={busy.includes(operation.key)} onClick={() => void reconcile(operation)}>核对原操作 {operation.requestId.slice(0, 8)}</button>)}</div>}
    {!workId && <div className={styles.workspace}>{query.scope === 'favorites' && <CollectionManager directory={directory} selected={query.collection} onSelect={collection => updateQuery({ collection })} operate={operate} busy={busy.length > 0 || pending.some(item => item.key.startsWith('collection:'))} />}
      <section className={styles.feed} aria-label="作品内容">{first?.previousCursor && <div className={styles.pageControl}><button type="button" disabled={loading} onClick={() => void load('before')}>读取前面的作品</button></div>}
        {error && failedDirection !== 'after' && <div className={styles.readError} role="status"><p>{error}</p><button type="button" disabled={loading} onClick={() => void load(failedDirection)}>重试读取</button></div>}
        {items.length > 0 ? <WorksMasonry items={items} playback={playback} contextKey={`${viewerId}:${queryKey}`} detailOpen={Boolean(workId || classify || adding)} busyKeys={busyKeys} operate={operate} onClassify={setClassify} onOpen={open} onFilter={(key, id) => chooseFilter(key, id)} restore={restore} navigationEpoch={navigationEpoch} onRestored={onRestored} /> : loading ? <div className={styles.skeletonGrid} role="status" aria-label="正在读取作品">{Array.from({ length: 6 }, (_, i) => <div key={i} className={styles.skeleton} />)}</div> : !error && <div className={styles.empty}><h2>{hasFilters ? '没有匹配的作品' : query.scope === 'favorites' ? '先收藏喜欢的作品' : query.scope === 'hidden' ? '没有对你隐藏的作品' : query.scope === 'managed' ? '没有可管理的作品分享' : '这里还没有作品'}</h2><p>{hasFilters ? '试试清除筛选，或换一个标题关键词。' : query.scope === 'favorites' ? '先收藏到全部收藏，之后可按需归类。' : query.scope === 'hidden' ? '隐藏的作品可在这里恢复显示。' : '已有成品会按原有权限显示，也可以明确加入本人上传的作品。'}</p><div>{hasFilters ? <button type="button" onClick={() => updateQuery({ q: undefined, author: undefined, project: undefined, collection: undefined })}>清除筛选</button> : <><button type="button" onClick={() => updateQuery({ scope: 'mine' })}>我的作品</button><button type="button" className={styles.primary} onClick={() => setAdding(true)}>添加作品</button></>}</div></div>}
        {error && failedDirection === 'after' && <div className={styles.readError} role="status"><p>{error}</p><button type="button" disabled={loading} onClick={() => void load('after')}>在这里重试</button></div>}
        <div ref={sentinel} className={styles.sentinel} aria-hidden="true" />
        {last?.nextCursor && <div className={styles.pageControl}><button type="button" disabled={loading} onClick={() => void load('after')}>{loading ? '正在读取…' : '更多作品'}</button></div>}{loading && items.length > 0 && <p className={styles.muted} role="status">正在读取作品…</p>}
      </section>
    </div>}
    {workId && <WorkDetail key={workId} id={workId} viewerId={viewerId} preparation={imagePreparation.current} revision={detailRevision} playback={playback} onClose={close} onList={returnToList} onOpen={open} onWork={updateWork} onFilter={(key, id) => chooseFilter(key, id)} onClassify={setClassify} busy={busyKeys.includes(`work:${workId}`) || busyKeys.includes(`method:${workId}`) || busyKeys.some(key => key.startsWith(`preview:${workId}:`))} operate={operate} />}
    {classify && <ClassifyWork work={classify} directory={directory} operate={operate} busy={busyKeys.includes(`work:${classify.id}`) || busyKeys.includes('collection:create')} onClose={() => setClassify(null)} />}
    {adding && <AddWorkPicker viewerId={viewerId} operate={operate} onClose={() => setAdding(false)} />}
  </div>;
}
