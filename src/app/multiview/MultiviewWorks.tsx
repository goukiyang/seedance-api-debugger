'use client';
/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { RefreshCw, Search } from 'lucide-react';
import { RelativeTime } from '@/components/RelativeTime';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import type { MultiviewWorkDto, MultiviewWorkList, MultiviewWorkMutationResult, MultiviewWorkReceipt } from '@/lib/video/multiview-work-contract';
import { MultiviewWorkViewer } from './MultiviewWorkViewer';
import { clearMultiviewWorkFiles, multiviewWorkFile, workFileUrl } from './multiview-work-client';
import styles from './multiview-works.module.css';

type Pending = { mutationId: string; workId: string; action: 'save' | 'branch' | 'remove' | 'restore' };
type LibraryPreferences = { projectId: string; q: string; removed: boolean; selected: string; y: number };
type Props = { owner: string; authority: string; initialWorkId?: string; onEdit: (work: MultiviewWorkDto) => void; onNew: () => void };
type ListResult = MultiviewWorkList & { projects: Array<{ id: string; title: string }> };
const base = '/api/video/multiview/works';
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
function readPending(key: string): Pending | null {
  if (localStorage.length > 8192) throw new Error('本机原操作尚未查全，请保留页面核对');
  const pointer = sessionStorage.getItem(`${key}:pointer`);
  const candidates = pointer ? [`${key}:op:${pointer}`] : Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    .filter((value): value is string => Boolean(value?.startsWith(`${key}:op:`)));
  for (const record of candidates) {
    const raw = localStorage.getItem(record);
    if (!raw || raw.length > 1000) throw new Error('本机原操作无法确认');
    const value = JSON.parse(raw) as Pending;
    if (!/^[a-f0-9-]{36}$/i.test(value.mutationId) || record !== `${key}:op:${value.mutationId}`
      || !validId(value.workId) || !['save', 'branch', 'remove', 'restore'].includes(value.action)) throw new Error('本机原操作无法确认');
    return value;
  }
  return null;
}
function matchedReceipt(value: unknown, original: Pending): value is MultiviewWorkReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as MultiviewWorkReceipt;
  return receipt.state === 'committed' && receipt.mutationId === original.mutationId && receipt.action === original.action
    && validId(receipt.workId) && (original.action === 'branch' || receipt.workId === original.workId)
    && Number.isSafeInteger(receipt.revision) && receipt.revision >= 1 && Number.isSafeInteger(receipt.draftRevision) && receipt.draftRevision >= 0;
}
function readPreferences(key: string): LibraryPreferences {
  const empty = { projectId: '', q: '', removed: false, selected: '', y: 0 };
  try {
    const raw = localStorage.getItem(key);
    if (!raw || raw.length > 1500) return empty;
    const value = JSON.parse(raw);
    return { projectId: validId(value.projectId) ? value.projectId : '', q: typeof value.q === 'string' ? value.q.slice(0, 120) : '',
      removed: value.removed === true, selected: validId(value.selected) ? value.selected : '', y: Number.isFinite(value.y) ? Math.max(0, Math.min(100000, value.y)) : 0 };
  } catch { return empty; }
}
const messageFor = (status: number) => status === 409 ? '作品已在别处更新，本次修改未覆盖服务器内容。请重新核对后继续。'
  : status === 401 || status === 403 ? '当前账号暂不能读取此作品，请核对登录和原视频权限。'
    : status === 404 ? '作品或原视频暂不可读取，请返回作品库重新核对。' : '作品读取未完成，请重试；原作品和本机修改保持不变。';

export function MultiviewWorks({ owner, authority, initialWorkId = '', onEdit, onNew }: Props) {
  const router = useRouter(), query = useSearchParams();
  const identity = `${owner}:${authority}`;
  const identityRef = useRef(identity); identityRef.current = identity;
  const activeIdentity = useRef('');
  const [loadedIdentity, setLoadedIdentity] = useState('');
  const [preferences, setPreferences] = useState<LibraryPreferences>({ projectId: '', q: '', removed: false, selected: '', y: 0 });
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<MultiviewWorkDto[]>([]);
  const [projects, setProjects] = useState<ListResult['projects']>([]);
  const [total, setTotal] = useState(0);
  const [listReady, setListReady] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [work, setWork] = useState<MultiviewWorkDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [checking, setChecking] = useState(false);
  const listEpoch = useRef(0), detailEpoch = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  const pendingRef = useRef(pending); pendingRef.current = pending;
  const workRef = useRef(work); workRef.current = work;
  const preferenceRef = useRef(preferences); preferenceRef.current = preferences;
  const preferenceKey = `sd2:multiview:works-library:v1:${owner}`;
  const mutationKey = `sd2:multiview:works-management:v1:${owner}`;
  const alive = useCallback((captured: string) => identityRef.current === captured && activeIdentity.current === captured && !isClientSessionBlocked(), []);
  const savePreferences = useCallback((next: LibraryPreferences) => {
    setPreferences(next);
    try { localStorage.setItem(preferenceKey, JSON.stringify(next)); }
    catch { setNotice('浏览位置本次无法记住，服务器作品保持不变'); }
  }, [preferenceKey]);
  const request = useCallback(async (url: string, init?: RequestInit) => {
    const abort = new AbortController(); controllers.current.add(abort);
    const headers = new Headers(init?.headers); headers.set('x-app-session-user', owner);
    try { return await fetch(url, { ...init, credentials: 'same-origin', cache: 'no-store', signal: abort.signal,
      headers }); }
    finally { controllers.current.delete(abort); }
  }, [owner]);
  useEffect(() => {
    const captured = identity;
    activeIdentity.current = captured;
    controllers.current.forEach(controller => controller.abort()); clearMultiviewWorkFiles();
    listEpoch.current++; detailEpoch.current++;
    setItems([]); setWork(null); setProjects([]); setCursor(null); setNotice(''); setLoading(false); setChecking(false); setListReady(false);
    const saved = readPreferences(preferenceKey); setPreferences(saved); setSearch(saved.q); setLoadedIdentity(captured);
    let restored: Pending | null = null;
    try {
      restored = readPending(mutationKey);
    } catch { setNotice('本机操作记录暂无法读取，请先核对作品再继续管理'); }
    pendingRef.current = restored; setPending(restored);
    return () => { if (activeIdentity.current === captured) activeIdentity.current = ''; controllers.current.forEach(controller => controller.abort()); clearMultiviewWorkFiles(); };
  }, [identity, preferenceKey, mutationKey]);
  const fetchList = useCallback(async (append = false) => {
    if (!owner || loadedIdentity !== identity || isClientSessionBlocked()) return;
    const captured = identity, epoch = ++listEpoch.current;
    const params = new URLSearchParams();
    if (preferences.projectId) params.set('projectId', preferences.projectId);
    if (preferences.q) params.set('q', preferences.q);
    if (preferences.removed) params.set('removed', '1');
    if (append && cursor) params.set('cursor', cursor);
    setLoading(true);
    try {
      const response = await request(`${base}?${params}`);
      if (!alive(captured) || epoch !== listEpoch.current) return;
      if (!response.ok) { if ([401, 403].includes(response.status)) { setItems([]); setWork(null); clearMultiviewWorkFiles(); } throw new Error(messageFor(response.status)); }
      const data = await response.json() as ListResult;
      if (!alive(captured) || epoch !== listEpoch.current) return;
      setItems(previous => append ? [...previous, ...data.works.filter(item => !previous.some(old => old.id === item.id))] : data.works);
      setProjects(data.projects); setTotal(data.total); setCursor(data.nextCursor); setListReady(true);
      return data.works;
    } catch (error) { if (alive(captured) && epoch === listEpoch.current) setNotice(error instanceof Error ? error.message : messageFor(503)); }
    finally { if (alive(captured) && epoch === listEpoch.current) setLoading(false); }
  }, [owner, loadedIdentity, identity, preferences.projectId, preferences.q, preferences.removed, cursor, request, alive]);
  const fetchDetail = useCallback(async (id: string, report = false) => {
    const captured = identity, epoch = ++detailEpoch.current, previous = workRef.current?.id === id ? workRef.current.revision : null;
    if (!validId(id)) return;
    try {
      const response = await request(`${base}/${encodeURIComponent(id)}`);
      if (!alive(captured) || epoch !== detailEpoch.current) return;
      if (!response.ok) { setWork(null); clearMultiviewWorkFiles(); throw new Error(messageFor(response.status)); }
      const data = await response.json() as { work: MultiviewWorkDto };
      if (alive(captured) && epoch === detailEpoch.current) {
        setWork(data.work);
        // A manual recheck that changes nothing must still say it ran.
        if (report) setNotice(previous === data.work.revision ? '已重新核对，作品与服务器一致。' : '已重新核对，已更新为服务器上的最新内容。');
      }
    } catch (error) { if (alive(captured) && epoch === detailEpoch.current) setNotice(error instanceof Error ? error.message : messageFor(503)); }
  }, [identity, alive, request]);
  useEffect(() => { if (loadedIdentity === identity) void fetchList();
  // Cursor changes must not reload the first page after every appended page.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedIdentity, identity, preferences.projectId, preferences.q, preferences.removed]);
  useEffect(() => {
    if (loadedIdentity !== identity) return;
    const id = initialWorkId || preferences.selected;
    if (id) { setWork(null); void fetchDetail(id); }
    else setWork(null);
  // Opening a card is controlled by the URL; filter changes do not replace the current work.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedIdentity, identity, initialWorkId]);
  useEffect(() => {
    if (loadedIdentity !== identity || !work || !['queued', 'rendering', 'waiting_source'].includes(work.status)) return;
    let tries = 0;
    const timer = setInterval(() => {
      if (++tries > 60) { clearInterval(timer); return; }
      if (!document.hidden) void fetchDetail(work.id);
    }, 5000);
    return () => clearInterval(timer);
  }, [loadedIdentity, identity, work?.id, work?.status, fetchDetail]);
  useEffect(() => {
    if (loadedIdentity !== identity) return;
    const timer = setTimeout(() => { if (search !== preferences.q) savePreferences({ ...preferenceRef.current, q: search.slice(0, 120), selected: '', y: 0 }); }, 350);
    return () => clearTimeout(timer);
  }, [search, preferences.q, loadedIdentity, identity, savePreferences]);
  const navigate = (id: string) => {
    const params = new URLSearchParams(query.toString()); params.set('view', 'works'); params.delete('taskId');
    if (id) params.set('workId', id); else params.delete('workId');
    savePreferences({ ...preferenceRef.current, selected: id, y: id ? window.scrollY : preferenceRef.current.y });
    if (id) { setWork(null); void fetchDetail(id); }
    else { detailEpoch.current++; setWork(null); }
    router.replace(`/multiview?${params}`, { scroll: false });
  };
  const clearPending = () => {
    const original = pendingRef.current;
    pendingRef.current = null; setPending(null);
    try {
      if (original) localStorage.removeItem(`${mutationKey}:op:${original.mutationId}`);
      if (sessionStorage.getItem(`${mutationKey}:pointer`) === original?.mutationId) sessionStorage.removeItem(`${mutationKey}:pointer`);
    } catch { /* A committed receipt is safe to query again on reopening. */ }
  };
  const checkMutation = async () => {
    const original = pendingRef.current, captured = identity;
    if (!original || checking) return;
    setChecking(true);
    try {
      const response = await request(`${base}/mutations/${encodeURIComponent(original.mutationId)}`);
      if (!alive(captured) || pendingRef.current?.mutationId !== original.mutationId) return;
      if (!response.ok) throw new Error(messageFor(response.status));
      const receipt: unknown = await response.json();
      if (!alive(captured) || pendingRef.current?.mutationId !== original.mutationId) return;
      if (!matchedReceipt(receipt, original)) { setNotice('保存结果仍待确认，请稍后再核对原操作；不会重复保存或新建'); return; }
      const stillViewing = workRef.current?.id === original.workId;
      clearPending(); setNotice('原操作已确认完成');
      if (stillViewing) { if (original.action === 'branch') navigate(receipt.workId); else await fetchDetail(receipt.workId); }
      void fetchList();
    } catch { if (alive(captured)) setNotice('暂无法确认保存结果，请保留当前内容并再次核对原操作'); }
    finally { if (alive(captured)) setChecking(false); }
  };
  const mutate = async (action: Pending['action'], title?: string) => {
    const target = workRef.current, captured = identity;
    if (!target || pendingRef.current || checking || !alive(captured)) return;
    if ((action === 'save' || action === 'branch') && !target.recipe) return;
    const original: Pending = { mutationId: crypto.randomUUID(), workId: target.id, action };
    try {
      const unresolved = readPending(mutationKey);
      if (unresolved) { pendingRef.current = unresolved; setPending(unresolved); setNotice('仍有原操作待确认，请先核对，不会重复保存或新建'); return; }
      const record = `${mutationKey}:op:${original.mutationId}`, value = JSON.stringify(original);
      localStorage.setItem(record, value); sessionStorage.setItem(`${mutationKey}:pointer`, original.mutationId);
      if (localStorage.getItem(record) !== value || sessionStorage.getItem(`${mutationKey}:pointer`) !== original.mutationId) throw new Error('not_retained');
    }
    catch { setNotice('无法保留本次保存回执，请先恢复本机存储；作品与输入保持不变'); return; }
    pendingRef.current = original; setPending(original); setNotice('正在保存…');
    const payload = { mutationId: original.mutationId, action, baseRevision: target.revision, ...(action === 'save' || action === 'branch' ? { recipe: target.recipe, title: title || target.title } : {}),
      ...(action === 'branch' ? { branchKey: original.mutationId } : {}) };
    try {
      const response = await request(`${base}/${encodeURIComponent(target.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      if (!alive(captured) || pendingRef.current?.mutationId !== original.mutationId) return;
      const data = await response.json() as MultiviewWorkMutationResult & { notCommitted?: boolean };
      if (!alive(captured) || pendingRef.current?.mutationId !== original.mutationId) return;
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && data.notCommitted === true) { clearPending(); throw new Error(messageFor(response.status)); }
        throw new Error('保存结果待确认，请核对原操作；当前作品与输入保持不变');
      }
      if (!matchedReceipt(data.receipt, original) || !data.work || data.work.id !== data.receipt.workId) throw new Error('保存结果待确认，请核对原操作；当前作品与输入保持不变');
      const stillViewing = workRef.current?.id === target.id;
      clearPending(); if (stillViewing) setWork(data.work);
      setNotice(data.work.revision !== data.receipt.revision ? '原操作已确认，服务器另有更新；当前输入保留，请重新核对作品。'
        : action === 'remove' ? '已移出，可在“已移出”恢复' : action === 'restore' ? '已恢复到作品库' : action === 'branch' ? '已另存一版，正在准备拼图'
        : target.status === 'failed' ? '选帧已保存，正在重新准备拼图；不会重新生成或扣费' : '作品名称已保存');
      void fetchList(); if (action === 'branch' && stillViewing) navigate(data.work.id);
    } catch (error) { if (alive(captured)) setNotice(error instanceof Error ? error.message : '保存结果待确认，请核对原操作'); }
  };
  const rename = useCallback((title: string) => { void mutate('save', title); }, [identity, work?.id, work?.revision, pending, checking]);
  if (loadedIdentity !== identity || !owner) return <p className={styles.notice}>正在读取当前账号作品…</p>;
  const selectedIndex = work ? items.findIndex(item => item.id === work.id) : -1;
  return <div className={styles.library}>
    {pending && <div className={styles.notice} role="status">保存结果待确认，不会重复操作。<button type="button" className={styles.button} disabled={checking} onClick={() => void checkMutation()}>{checking ? '正在核对…' : '核对原操作'}</button></div>}
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    {work ? <MultiviewWorkViewer key={`${identity}:${work.id}`} owner={owner} authority={authority} work={work} busy={Boolean(pending) || checking} onBack={() => {
      const y = preferenceRef.current.y; navigate(''); requestAnimationFrame(() => window.scrollTo({ top: y }));
    }} onPrevious={selectedIndex > 0 ? () => navigate(items[selectedIndex - 1].id) : undefined}
      onNext={selectedIndex >= 0 && selectedIndex + 1 < items.length ? () => navigate(items[selectedIndex + 1].id) : cursor ? () => {
        const captured = identity, id = work.id;
        void fetchList(true).then(next => { if (alive(captured) && workRef.current?.id === id && next?.[0]) navigate(next[0].id); });
      } : undefined}
      onEdit={onEdit} onRename={rename} onBranch={() => void mutate('branch')} onRemove={() => void mutate(work.removed ? 'restore' : 'remove')}
      onRefresh={() => { setNotice(''); setChecking(true); void fetchDetail(work.id, true).finally(() => setChecking(false)); }} onRetry={() => void mutate('save', work.title)} /> : <>
      <div className={styles.filters}>
        <label>项目<select value={preferences.projectId} onChange={event => savePreferences({ ...preferences, projectId: event.target.value, selected: '', y: 0 })}>
          <option value="">全部项目</option>{projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label>
        <label className={styles.search}><Search size={16} /><input aria-label="搜索作品" placeholder="搜索作品" maxLength={120} value={search} onChange={event => setSearch(event.target.value)} /></label>
        <label><input type="checkbox" checked={preferences.removed} onChange={event => savePreferences({ ...preferences, removed: event.target.checked, selected: '', y: 0 })} />已移出</label>
        <button type="button" className={styles.button} disabled={loading} onClick={() => void fetchList()}><RefreshCw size={16} />刷新</button>
        <button type="button" className={styles.button} onClick={() => { savePreferences({ projectId: '', q: '', removed: false, selected: '', y: 0 }); setSearch(''); }}>重置浏览设置</button>
        <span className={styles.meta}>{listReady ? `共${total}件 · 已显示${items.length}件` : '正在读取作品'}</span>
      </div>
      {!items.length && listReady && !loading ? <div className={styles.empty}><p>{notice ? '作品暂未读取完成，请重试' : preferences.q || preferences.projectId || preferences.removed ? '当前条件下没有作品' : '还没有保存的3D多视图作品'}</p>
        <button type="button" className={styles.primary} onClick={onNew}>回工作台，生成或选择已有视频</button></div> : <div className={styles.grid}>
        {items.map(item => { const image = multiviewWorkFile(item, 'thumbnail'); return <article className={styles.card} key={item.id} data-work-id={item.id}>
          <button type="button" className={styles.cardImage} onClick={() => navigate(item.id)} aria-label={`浏览${item.title}`}>
            {image ? <img src={workFileUrl(item.id, image)} loading="lazy" alt={item.title} /> : <span>{item.status === 'failed' ? '拼图准备未完成' : '正在准备拼图'}</span>}
          </button><div className={styles.cardCaption}><button type="button" className={styles.title} onClick={() => navigate(item.id)}>{item.title}</button>
            <span className={styles.meta}>{item.ready?.frameCount || item.recipe?.slots.length || 0}张 · {item.projectTitle || '未关联项目'}</span>
            <span className={styles.meta}><RelativeTime value={item.updatedAt} />{item.ready?.revision !== item.draftRevision && ' · 正在准备更新'}</span></div>
        </article>; })}
      </div>}
      {(loading || !listReady && !notice) && <p role="status" className={styles.notice}>正在读取作品…</p>}
      {cursor && <button type="button" className={styles.button} disabled={loading} onClick={() => void fetchList(true)}>加载更多作品</button>}
    </>}
  </div>;
}
