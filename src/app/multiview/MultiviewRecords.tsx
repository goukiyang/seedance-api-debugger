'use client';
/* eslint-disable @next/next/no-img-element */
import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Search, X } from 'lucide-react';
import { ProductActionMenu } from '@/components/ProductActionMenu';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { RelativeTime } from '@/components/RelativeTime';
import UserIdentityBadge from '@/components/UserIdentityBadge';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import type { MultiviewRecord } from '@/lib/video/multiview-records.server';
import type { MultiviewWorkDto } from '@/lib/video/multiview-work-contract';
import styles from './multiview-generations.module.css';
import toolStyles from './multiview.module.css';
import { MultiviewWorks } from './MultiviewWorks';
import { readMultiviewWorkBinding } from './multiview-work-client';
import { createRecordCoverReader, type RecordCoverState } from './multiview-record-cover';

type RecordAction = 'rename' | 'branch' | 'remove' | 'restore' | 'retry' | 'share';
type Props = { owner: string; authority: string; active?: boolean; onTask: (id: string) => void; onWork: (id: string, taskId: string) => void; onManage: (id: string) => void; onDraft: () => void;
  onUseReference?: (work: MultiviewWorkDto, role: string) => void };
const labels: Record<string, string> = { pending: '等待生成', queued: '准备中', waiting_source: '等待原视频', running: '生成中', processing: '生成中', rendering: '准备拼图', succeeded: '已完成', success: '已完成', ready: '已完成', failed: '未完成', unconfirmed: '状态待确认' };
function RecordCard({ item, owner, enabled, readCover, onLayoutChange, onUnauthorized, onRefresh, onTask, onWork, onManage }: Pick<Props, 'owner' | 'onTask' | 'onWork'> & { item: MultiviewRecord; enabled: boolean; readCover: ReturnType<typeof createRecordCoverReader>; onLayoutChange: () => void; onUnauthorized: () => void; onRefresh: () => void; onManage: (id: string, action?: RecordAction) => void }) {
  const [works, setWorks] = useState<MultiviewWorkDto[]>([]), [selected, setSelected] = useState(item.workId || '');
  const [cursor, setCursor] = useState<string | null>(null), [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [cover, setCover] = useState<RecordCoverState>({ phase: 'loading' }), [coverAttempt, setCoverAttempt] = useState(0), [nearby, setNearby] = useState(false);
  const article = useRef<HTMLElement>(null);
  const coverLease = useRef<RecordCoverState | null>(null);
  const active = useRef(true), loading = useRef(false);
  const chosen = useRef(false);
  const workRequest = useRef<AbortController | null>(null);
  useEffect(() => { active.current = enabled; return () => { active.current = false; workRequest.current?.abort(); }; }, [enabled]);
  useEffect(() => {
    if (!enabled || !article.current) return;
    if (typeof IntersectionObserver === 'undefined') { setNearby(true); return; }
    const observer = new IntersectionObserver(entries => setNearby(entries.some(entry => entry.isIntersecting)), { rootMargin: '300px' });
    observer.observe(article.current); return () => observer.disconnect();
  }, [enabled]);
  useEffect(() => {
    if (!enabled || !nearby || isClientSessionBlocked()) return;
    const controller = new AbortController(); let acquired: RecordCoverState | undefined;
    onLayoutChange(); setCover({ phase: 'loading' });
    void readCover(item, owner, controller.signal).then(next => {
      acquired = next;
      if (controller.signal.aborted || !active.current || isClientSessionBlocked()) { acquired.release?.(); acquired = undefined; return; }
      coverLease.current = next;
      onLayoutChange(); setCover(next);
      if (next.phase === 'signed-out') onUnauthorized();
    }).catch(() => { if (!controller.signal.aborted && active.current) setCover({ phase: 'retryable' }); });
    return () => { controller.abort(); acquired?.release?.(); if (coverLease.current === acquired) coverLease.current = null; };
  }, [item, owner, enabled, nearby, readCover, coverAttempt, onLayoutChange, onUnauthorized]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const controller = new AbortController();
    try {
      const binding = readMultiviewWorkBinding(localStorage, owner, item.taskId, item.sourceId);
      if (binding && binding.workId !== item.workId && !item.removed) {
        void fetch(`/api/video/multiview/works/${encodeURIComponent(binding.workId)}`, { cache: 'no-store', headers: { 'x-app-session-user': owner }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) })
          .then(async response => response.ok ? response.json() : null).then(data => {
            const work = data?.work;
            if (!cancelled && active.current && !chosen.current && !isClientSessionBlocked() && work?.id === binding.workId && work.sourceTaskId === item.taskId
              && (work.sourceId || null) === item.sourceId && !work.removed) { setWorks(old => [work, ...old.filter(value => value.id !== work.id)]); setSelected(work.id); }
          }).catch(() => {});
      }
    } catch { /* A broken optional choice never blocks the server-proven record. */ }
    return () => { cancelled = true; controller.abort(); };
  }, [owner, item.id, item.workId, item.coverUrl, item.removed, item.sourceId, item.taskId, enabled]);
  const load = async (append = false) => {
    if (!enabled || loading.current || isClientSessionBlocked()) return;
    loading.current = true; setBusy(true); setError('');
    const controller = new AbortController(); workRequest.current = controller;
    try {
      const params = new URLSearchParams(item.sourceId ? { sourceId: item.sourceId } : { taskId: item.taskId });
      if (item.removed) params.set('removed', '1');
      if (append && cursor) params.set('cursor', cursor);
      const response = await fetch(`/api/video/multiview/works?${params}`, { cache: 'no-store', headers: { 'x-app-session-user': owner }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
      const data = await response.json();
      if (!active.current || isClientSessionBlocked()) return;
      if (!response.ok || !Array.isArray(data.works)) throw new Error(data.error || '方案暂不可读取');
      setWorks(old => {
        const retained = append ? old : old.filter(work => work.id === selected && !data.works.some((value: MultiviewWorkDto) => value.id === work.id));
        return [...retained, ...data.works.filter((work: MultiviewWorkDto) => !retained.some(value => value.id === work.id))];
      });
      setCursor(data.nextCursor); setLoaded(true);
    } catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : '方案暂不可读取'); }
    finally { loading.current = false; if (active.current) setBusy(false); }
  };
  const hasMedia = enabled && coverLease.current === cover && cover.phase === 'ready' && cover.url;
  const phase = enabled ? cover.phase : 'signed-out';
  const compact = !hasMedia && phase !== 'loading';
  return <article ref={article} data-record-id={item.id} className={`${styles.card} ${compact ? styles.textRow : ''}`}>
    {!compact && <div className={styles.media}>{hasMedia ? <img src={cover.url} alt={cover.kind === 'input' ? '参考封面' : cover.kind === 'result' ? '已保存成品' : '原视频画面'} onError={() => { onLayoutChange(); coverLease.current?.release?.(); coverLease.current = null; setCover({ phase: 'retryable' }); }} /> : <span role="status">正在读取封面…</span>}
      {hasMedia && cover.kind === 'input' && <span className={styles.coverLabel}>参考封面</span>}</div>}
    <div className={styles.body}>
      <div className={styles.titleRow}><strong>{item.title}</strong></div>
      <div className={styles.creator}>{item.creator ? <UserIdentityBadge user={item.creator} size="sm" /> : <span>作者信息不可用</span>}<RelativeTime value={item.createdAt} /></div>
      <p>{item.sourceId ? '独立副本' : item.projectTitle || ''}{(item.sourceId || item.projectTitle) && ' · '}{labels[item.status] || '状态待确认'}</p>
      {hasMedia && (cover.retryable || cover.refresh) && <p><button type="button" onClick={() => { if (cover.refresh) onRefresh(); else setCoverAttempt(value => value + 1); }}>重试成品封面</button></p>}
      {compact && <p role="status">{phase === 'retryable' ? '封面暂不可读取' : phase === 'refresh' ? '封面版本已变化' : phase === 'signed-out' ? '登录状态需重新确认' : phase === 'denied' ? '暂无可查看封面' : '暂无可用媒体'}
        {phase !== 'missing' && phase !== 'signed-out' && <button type="button" onClick={() => { onLayoutChange(); if (phase === 'refresh') onRefresh(); else setCoverAttempt(value => value + 1); }}>{phase === 'refresh' ? '刷新封面' : '重试封面'}</button>}
      </p>}
      {item.schemeCount > 0 && <details className={styles.schemes}><summary>方案{item.schemeCount > 1 ? ` · ${item.schemeCount}` : ''}</summary><div className={styles.actions}>
        <select aria-label="选择保存方案" value={selected} onFocus={() => { if (!loaded) void load(); }} onChange={event => { chosen.current = true; setSelected(event.target.value); }}>
          {!works.some(work => work.id === item.workId) && item.workId && <option value={item.workId}>{item.title}</option>}
          {works.map(work => <option key={work.id} value={work.id}>{work.title}</option>)}
        </select>
        <ProductActionMenu label="方案操作" disabled={!selected} actions={[
          { id: 'view', label: '查看方案', onSelect: () => onManage(selected) },
          { id: 'rename', label: '修改名称', disabled: item.removed, onSelect: () => onManage(selected, 'rename') },
          { id: 'branch', label: '另存为', disabled: item.removed, onSelect: () => onManage(selected, 'branch') },
          { id: 'share', label: '分享', disabled: item.removed, onSelect: () => onManage(selected, 'share') },
          { id: 'retry', label: '重新准备拼图', disabled: item.removed || !(works.find(work => work.id === selected)?.status === 'failed' || item.status === 'failed'), onSelect: () => onManage(selected, 'retry') },
          { id: 'remove', label: item.removed ? '恢复方案' : '移出方案', onSelect: () => onManage(selected, item.removed ? 'restore' : 'remove') },
        ]} />
        {cursor && <button type="button" disabled={busy} onClick={() => void load(true)}>更多方案</button>}
      </div></details>}
      {error && <p role="status">{error}<button type="button" onClick={() => void load()}>重试</button></p>}
      <div className={styles.actions}><button type="button" className={styles.continue} onClick={() => item.removed && selected ? onManage(selected) : selected ? onWork(selected, item.taskId) : onTask(item.taskId)}>{item.removed ? '查看与恢复' : '继续制作'}</button></div>
    </div>
  </article>;
}
export function MultiviewRecords(props: Props) {
  const { owner, authority, active = true } = props;
  const identity = `${owner}:${authority}`, identityRef = useRef(identity); identityRef.current = identity;
  const [items, setItems] = useState<MultiviewRecord[]>([]), [cursor, setCursor] = useState<string | null>(null), [total, setTotal] = useState(0);
  const [projects, setProjects] = useState<Array<{ id: string; title: string }>>([]);
  const [q, setQ] = useState(''), [projectId, setProjectId] = useState(''), [removed, setRemoved] = useState(false);
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [hydrated, setHydrated] = useState('');
  const [manage, setManage] = useState<{ id: string; action?: RecordAction } | null>(null);
  const [coverUnauthorized, setCoverUnauthorized] = useState(false);
  const library = useRef<HTMLElement>(null), request = useRef<AbortController | null>(null);
  const anchorStorageKey = useRef('');
  const readCover = useRef(createRecordCoverReader()).current;
  const anchor = useRef<{ id: string; offset: number } | null>(null), pages = useRef(1);
  const rememberAnchor = useCallback(() => {
    const rows = Array.from(library.current?.querySelectorAll<HTMLElement>('[data-record-id]') || []);
    const row = rows.find(value => value.getBoundingClientRect().bottom > 0);
    if (row) {
      anchor.current = { id: row.dataset.recordId!, offset: row.getBoundingClientRect().top };
      try { sessionStorage.setItem(anchorStorageKey.current, JSON.stringify({ ...anchor.current, pages: pages.current })); } catch { /* The mounted list still retains its anchor. */ }
    }
  }, []);
  const restoreAnchor = useCallback(() => {
    const saved = anchor.current;
    if (!saved) return;
    const row = Array.from(library.current?.querySelectorAll<HTMLElement>('[data-record-id]') || []).find(value => value.dataset.recordId === saved.id);
    if (row) window.scrollBy(0, row.getBoundingClientRect().top - saved.offset);
  }, []);
  const beforeLayout = useCallback(() => { rememberAnchor(); requestAnimationFrame(restoreAnchor); }, [rememberAnchor, restoreAnchor]);
  const stopCoverReads = useCallback(() => setCoverUnauthorized(true), []);
  const management = useRef<HTMLElement>(null), backdrop = useRef<HTMLDivElement>(null);
  useDialogDismiss({ open: Boolean(manage), dialogRef: management, dismissSurfaceRef: backdrop, onDismiss: () => setManage(null) });
  const sequence = useRef(0);
  const key = `sd2:multiview-records:v1:${owner}`;
  useEffect(() => {
    sequence.current++; setItems([]); setCursor(null); setError(''); setManage(null); setCoverUnauthorized(false); anchor.current = null; pages.current = 1;
    try { const saved = JSON.parse(localStorage.getItem(key) || '{}'); setQ(typeof saved.q === 'string' ? saved.q.slice(0, 120) : ''); setProjectId(typeof saved.projectId === 'string' ? saved.projectId : ''); setRemoved(saved.removed === true); }
    catch { setQ(''); setProjectId(''); setRemoved(false); }
    setHydrated(identity);
    return () => { sequence.current++; request.current?.abort(); };
  }, [identity, key]);
  const load = useCallback(async (append = false) => {
    if (!active || !owner || hydrated !== identity || isClientSessionBlocked()) return;
    const captured = identity, seq = ++sequence.current;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    rememberAnchor();
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ q, projectId, removed: removed ? '1' : '0' });
      if (append && cursor) params.set('cursor', cursor);
      let data: { items: MultiviewRecord[]; total: number; nextCursor: string | null; projects: Array<{ id: string; title: string }> };
      const collected: MultiviewRecord[] = [];
      let pageCount = append ? 1 : pages.current;
      for (let page = 0; page < pageCount; page++) {
        const response = await fetch(`/api/video/multiview/records?${params}`, { cache: 'no-store', headers: { 'x-app-session-user': owner }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
        const value = await response.json();
        if (!response.ok || !Array.isArray(value.items)) throw new Error(value.error || '记录暂不可读取');
        if (!Number.isSafeInteger(value.total) || value.total < 0) throw new Error('记录数量暂时无法确认');
        pageCount = Math.min(pageCount, Math.max(1, Math.ceil(value.total / 24)));
        data = value; collected.push(...value.items);
        if (!value.nextCursor) break;
        params.set('cursor', value.nextCursor);
      }
      if (seq !== sequence.current || captured !== identityRef.current || isClientSessionBlocked()) return;
      setItems(previous => append ? [...previous, ...collected.filter(item => !previous.some(old => old.id === item.id))] : collected);
      if (append) pages.current++;
      setTotal(data!.total); setCursor(data!.nextCursor); setProjects(data!.projects); setCoverUnauthorized(false);
      requestAnimationFrame(restoreAnchor);
    } catch (cause) { if (seq === sequence.current && captured === identityRef.current) setError(cause instanceof Error ? cause.message : '记录暂不可读取'); }
    finally { if (seq === sequence.current) setLoading(false); }
  }, [owner, hydrated, identity, q, projectId, removed, cursor, active, rememberAnchor, restoreAnchor]);
  useEffect(() => {
    if (active) { requestAnimationFrame(restoreAnchor); return; }
    sequence.current++; request.current?.abort(); setLoading(false); setManage(null);
  }, [active, restoreAnchor]);
  const filter = JSON.stringify([q, projectId, removed]), previousFilter = useRef(filter);
  anchorStorageKey.current = `sd2:multiview-record-anchor:v1:${JSON.stringify([identity, q, projectId, removed])}`;
  useEffect(() => {
    if (hydrated !== identity || !active) return;
    if (previousFilter.current !== filter) { previousFilter.current = filter; pages.current = 1; anchor.current = null; sequence.current++; request.current?.abort(); setItems([]); setCursor(null); }
    if (!anchor.current) {
      try {
        const value = JSON.parse(sessionStorage.getItem(anchorStorageKey.current) || 'null');
        if (typeof value?.id === 'string' && value.id.length <= 150 && Number.isFinite(value.offset) && Number.isSafeInteger(value.pages) && value.pages > 0) { anchor.current = { id: value.id, offset: value.offset }; pages.current = value.pages; }
      } catch { /* Invalid optional navigation state never changes the record directory. */ }
    }
    try { localStorage.setItem(key, JSON.stringify({ q, projectId, removed })); } catch { /* Browsing remains available without local preferences. */ }
    const timer = setTimeout(() => void load(), 250); return () => clearTimeout(timer);
    // A cursor update must not reload the first page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, identity, key, q, projectId, removed, active, filter]);
  if (!owner || hydrated !== identity) return <p>正在读取记录…</p>;
  return <section ref={library} hidden={!active} className={styles.library} aria-label="3D多视图记录">
    <header className={styles.header}><div className={styles.actions}>
      <label><Search size={15} /><input aria-label="搜索记录" placeholder="搜索记录" maxLength={120} value={q} onChange={event => setQ(event.target.value)} /></label>
      <select aria-label="筛选项目" value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">全部项目</option>{projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</select>
      <label><input type="checkbox" checked={removed} onChange={event => setRemoved(event.target.checked)} />已移出</label>
      <span>{total} 条</span></div><button type="button" disabled={loading} onClick={() => void load()} aria-label="刷新记录" title="刷新"><RefreshCw size={16} /></button></header>
    {error && <p role="status">{error}</p>}
    <div className={styles.grid}>{items.map(item => <RecordCard key={`${identity}:${removed}:${item.id}`} item={item} {...props} enabled={active && !coverUnauthorized} readCover={readCover} onLayoutChange={beforeLayout} onUnauthorized={stopCoverReads}
      onRefresh={() => void load()} onTask={id => { rememberAnchor(); props.onTask(id); }} onWork={(id, taskId) => { rememberAnchor(); props.onWork(id, taskId); }} onManage={(id, action) => { rememberAnchor(); setManage({ id, action }); }} />)}</div>
    {loading && <p role="status">正在读取…</p>}
    {!loading && !items.length && !error && <div className={styles.empty}>暂无记录<button type="button" onClick={props.onDraft}>返回工作台</button></div>}
    {cursor && <div className={styles.more}><button type="button" disabled={loading} onClick={() => void load(true)}>加载更多</button></div>}
    {manage && <div ref={backdrop} className={toolStyles.toolsBackdrop}><section ref={management} className={toolStyles.tools} role="dialog" aria-modal="true" aria-label="管理方案">
      <header className={toolStyles.toolsHeader}><h3>方案</h3><button type="button" aria-label="关闭方案" title="关闭" onClick={() => { setManage(null); void load(); }}><X size={18} /></button></header>
      <MultiviewWorks key={`${identity}:${manage.id}:${manage.action || ''}`} owner={owner} authority={authority} initialWorkId={manage.id} initialAction={manage.action} detailOnly
        onClose={() => { setManage(null); void load(); }} onNew={props.onDraft}
        onEdit={work => props.onWork(work.id, work.sourceTaskId)} onUseReference={props.onUseReference} />
    </section></div>}
  </section>;
}
