'use client';
/* eslint-disable @next/next/no-img-element */
import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Search, X } from 'lucide-react';
import { ProductActionMenu } from '@/components/ProductActionMenu';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { RelativeTime } from '@/components/RelativeTime';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import type { MultiviewRecord } from '@/lib/video/multiview-records.server';
import type { MultiviewWorkDto } from '@/lib/video/multiview-work-contract';
import styles from './multiview-generations.module.css';
import toolStyles from './multiview.module.css';
import { MultiviewWorks } from './MultiviewWorks';
import { readMultiviewWorkBinding } from './multiview-work-client';
import { loadMultiviewRecordProjects, readMultiviewRecordPage, MultiviewRecordReadError } from './multiview-record-pages';

type RecordAction = 'rename' | 'branch' | 'remove' | 'restore' | 'retry' | 'share';
type Props = { owner: string; authority: string; onTask: (id: string) => void; onWork: (id: string, taskId: string) => void; onManage: (id: string) => void; onDraft: () => void;
  onUseReference?: (work: MultiviewWorkDto, role: string) => void };
const labels: Record<string, string> = { pending: '等待生成', queued: '准备中', waiting_source: '等待原视频', running: '生成中', processing: '生成中', rendering: '准备拼图', succeeded: '已完成', success: '已完成', ready: '已完成', failed: '未完成', unconfirmed: '状态待确认' };
function RecordCard({ item, owner, onTask, onWork, onManage }: Pick<Props, 'owner' | 'onTask' | 'onWork'> & { item: MultiviewRecord; onManage: (id: string, action?: RecordAction) => void }) {
  const [works, setWorks] = useState<MultiviewWorkDto[]>([]), [selected, setSelected] = useState(item.workId || '');
  const [cursor, setCursor] = useState<string | null>(null), [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [coverFailed, setCoverFailed] = useState(false);
  const active = useRef(true), loading = useRef(false);
  const chosen = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    setCoverFailed(false);
    let cancelled = false;
    try {
      const binding = readMultiviewWorkBinding(localStorage, owner, item.taskId, item.sourceId);
      if (binding && binding.workId !== item.workId && !item.removed) {
        void fetch(`/api/video/multiview/works/${encodeURIComponent(binding.workId)}`, { cache: 'no-store', headers: { 'x-app-session-user': owner }, signal: AbortSignal.timeout(30000) })
          .then(async response => response.ok ? response.json() : null).then(data => {
            const work = data?.work;
            if (!cancelled && active.current && !chosen.current && !isClientSessionBlocked() && work?.id === binding.workId && work.sourceTaskId === item.taskId
              && (work.sourceId || null) === item.sourceId && !work.removed) { setWorks(old => [work, ...old.filter(value => value.id !== work.id)]); setSelected(work.id); }
          }).catch(() => {});
      }
    } catch { /* A broken optional choice never blocks the server-proven record. */ }
    return () => { cancelled = true; };
  }, [owner, item.id, item.workId, item.coverUrl, item.removed]);
  const load = async (append = false) => {
    if (loading.current || isClientSessionBlocked()) return;
    loading.current = true; setBusy(true); setError('');
    try {
      const params = new URLSearchParams(item.sourceId ? { sourceId: item.sourceId } : { taskId: item.taskId });
      if (item.removed) params.set('removed', '1');
      if (append && cursor) params.set('cursor', cursor);
      const response = await fetch(`/api/video/multiview/works?${params}`, { cache: 'no-store', headers: { 'x-app-session-user': owner }, signal: AbortSignal.timeout(30000) });
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
  return <article className={styles.card}>
    <div className={styles.media}>{item.coverUrl && !coverFailed ? <img src={item.coverUrl} loading="lazy" alt="原视频第0帧" onError={() => setCoverFailed(true)} /> : <span>{labels[item.status] || '暂无可用首帧'}</span>}</div>
    <div className={styles.body}>
      <div className={styles.titleRow}><strong>{item.title}</strong><RelativeTime value={item.createdAt} /></div>
      <p>{item.sourceId ? '独立副本' : item.projectTitle || '3D多视图'} · {labels[item.status] || '状态待确认'}</p>
      {item.schemeCount > 0 && <div className={styles.actions}>
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
      </div>}
      {error && <p role="status">{error}<button type="button" onClick={() => void load()}>重试</button></p>}
      <div className={styles.actions}><button type="button" onClick={() => item.removed && selected ? onManage(selected) : selected ? onWork(selected, item.taskId) : onTask(item.taskId)}>{item.removed ? '查看与恢复' : '继续制作'}</button><span>{item.schemeCount} 个方案</span></div>
    </div>
  </article>;
}
export function MultiviewRecords(props: Props) {
  const { owner, authority } = props;
  const identity = `${owner}:${authority}`;
  const [items, setItems] = useState<MultiviewRecord[]>([]), [cursor, setCursor] = useState<string | null>(null), [total, setTotal] = useState(0);
  const [projects, setProjects] = useState<Array<{ id: string; title: string }>>([]);
  const [projectScope, setProjectScope] = useState(''), [projectError, setProjectError] = useState(''), [projectsLoading, setProjectsLoading] = useState(false);
  const [q, setQ] = useState(''), [projectId, setProjectId] = useState(''), [removed, setRemoved] = useState(false);
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [hydrated, setHydrated] = useState('');
  const [manage, setManage] = useState<{ id: string; action?: RecordAction } | null>(null);
  const management = useRef<HTMLElement>(null), backdrop = useRef<HTMLDivElement>(null);
  useDialogDismiss({ open: Boolean(manage), dialogRef: management, dismissSurfaceRef: backdrop, onDismiss: () => setManage(null) });
  const sequence = useRef(0);
  const projectSequence = useRef(0), recordRequest = useRef<AbortController | null>(null), projectRequest = useRef<AbortController | null>(null);
  const [loadedScope, setLoadedScope] = useState(''), [retryAppend, setRetryAppend] = useState(false);
  const recordScope = JSON.stringify([identity, q, projectId, removed]), directoryScope = JSON.stringify([identity, removed]);
  const recordScopeRef = useRef(recordScope), directoryScopeRef = useRef(directoryScope);
  recordScopeRef.current = recordScope; directoryScopeRef.current = directoryScope;
  const shownItems = loadedScope === recordScope ? items : [];
  const key = `sd2:multiview-records:v1:${owner}`;
  useEffect(() => {
    sequence.current++; projectSequence.current++; recordRequest.current?.abort(); projectRequest.current?.abort();
    recordRequest.current = null; projectRequest.current = null;
    setItems([]); setCursor(null); setError(''); setManage(null); setLoadedScope(''); setTotal(0);
    setProjects([]); setProjectScope(''); setProjectError('');
    try { const saved = JSON.parse(localStorage.getItem(key) || '{}'); setQ(typeof saved.q === 'string' ? saved.q.slice(0, 120) : ''); setProjectId(typeof saved.projectId === 'string' ? saved.projectId : ''); setRemoved(saved.removed === true); }
    catch { setQ(''); setProjectId(''); setRemoved(false); }
    setHydrated(identity);
    return () => { sequence.current++; projectSequence.current++; recordRequest.current?.abort(); projectRequest.current?.abort(); };
  }, [identity, key]);
  const loadProjects = useCallback(async () => {
    if (!owner || hydrated !== identity || isClientSessionBlocked()) return;
    const captured = directoryScope, seq = ++projectSequence.current;
    projectRequest.current?.abort(); const controller = new AbortController(); projectRequest.current = controller;
    const current = () => seq === projectSequence.current && captured === directoryScopeRef.current && !controller.signal.aborted && !isClientSessionBlocked();
    setProjectsLoading(true); setProjectError('');
    try {
      const complete = await loadMultiviewRecordProjects({ owner, removed, fetch, signal: controller.signal, current });
      if (!current()) return;
      setProjects(complete); setProjectScope(captured);
      setProjectId(previous => !previous || complete.some(project => project.id === previous) ? previous : '');
    } catch (cause) {
      if (seq === projectSequence.current && captured === directoryScopeRef.current && !isClientSessionBlocked()) setProjectError(cause instanceof MultiviewRecordReadError ? cause.message : '项目目录暂不可读取，请重试。');
    } finally {
      if (seq === projectSequence.current) { projectRequest.current = null; setProjectsLoading(false); }
    }
  }, [owner, hydrated, identity, directoryScope, removed]);
  useEffect(() => { if (hydrated === identity) void loadProjects(); return () => { projectSequence.current++; projectRequest.current?.abort(); }; }, [hydrated, identity, loadProjects]);
  const load = useCallback(async (append = false) => {
    if (!owner || hydrated !== identity || isClientSessionBlocked() || projectId && projectScope !== directoryScope) return;
    if (append && (recordRequest.current || loadedScope !== recordScope || !cursor)) return;
    const captured = recordScope, seq = ++sequence.current;
    recordRequest.current?.abort(); const controller = new AbortController(); recordRequest.current = controller;
    const current = () => seq === sequence.current && captured === recordScopeRef.current && !controller.signal.aborted && !isClientSessionBlocked();
    const timeout = setTimeout(() => controller.abort(), 30000);
    setLoading(true); setError(''); setRetryAppend(append);
    try {
      const params = new URLSearchParams({ q, projectId, removed: removed ? '1' : '0' });
      if (append && cursor) params.set('cursor', cursor);
      const response = await fetch(`/api/video/multiview/records?${params}`, { cache: 'no-store', headers: { 'x-app-session-user': owner }, signal: controller.signal });
      const data = await readMultiviewRecordPage(response);
      if (!current()) return;
      setItems(previous => append ? [...previous, ...data.items.filter((item: MultiviewRecord) => !previous.some(old => old.id === item.id))] : data.items);
      setTotal(data.total); setCursor(data.nextCursor); setLoadedScope(captured);
    } catch (cause) {
      if (seq !== sequence.current || captured !== recordScopeRef.current || isClientSessionBlocked()) return;
      if (cause instanceof MultiviewRecordReadError && [400, 401, 403, 409].includes(cause.status)) {
        setItems([]); setCursor(null); setLoadedScope(''); setRetryAppend(false); setTotal(0);
      }
      setError(cause instanceof MultiviewRecordReadError ? cause.message : '记录暂不可读取，请重试。');
    } finally { clearTimeout(timeout); if (seq === sequence.current) { recordRequest.current = null; setLoading(false); } }
  }, [owner, hydrated, identity, q, projectId, removed, cursor, projectScope, directoryScope, loadedScope, recordScope]);
  useEffect(() => {
    if (hydrated !== identity) return;
    try { localStorage.setItem(key, JSON.stringify({ q, projectId, removed })); } catch { /* Browsing remains available without local preferences. */ }
    const timer = setTimeout(() => void load(), 250); return () => clearTimeout(timer);
    // A cursor update must not reload the first page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, identity, key, q, projectId, removed, projectScope]);
  if (!owner || hydrated !== identity) return <p>正在读取记录…</p>;
  return <section className={styles.library} aria-label="3D多视图记录">
    <header className={styles.header}><div className={styles.actions}>
      <label><Search size={15} /><input aria-label="搜索记录" placeholder="搜索记录" maxLength={120} value={q} onChange={event => setQ(event.target.value)} /></label>
      <select aria-label="筛选项目" disabled={projectsLoading || projectScope !== directoryScope} value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">全部项目</option>
        {projectScope !== directoryScope && projectId && <option value={projectId}>正在读取项目…</option>}
        {(projectScope === directoryScope ? projects : []).map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</select>
      <label><input type="checkbox" checked={removed} onChange={event => setRemoved(event.target.checked)} />已移出</label>
      <span>{loadedScope === recordScope ? total : 0} 条</span></div><button type="button" disabled={loading || projectsLoading} onClick={() => { void load(); void loadProjects(); }} aria-label="刷新记录" title="刷新"><RefreshCw size={16} /></button></header>
    {projectError && <p role="status">{projectError}<button type="button" disabled={projectsLoading} onClick={() => void loadProjects()}>重试</button></p>}
    {error && <p role="status">{error}<button type="button" disabled={loading} onClick={() => void load(retryAppend)}>重试</button></p>}
    <div className={styles.grid}>{shownItems.map(item => <RecordCard key={`${identity}:${removed}:${item.id}`} item={item} {...props} onManage={(id, action) => setManage({ id, action })} />)}</div>
    {loading && <p role="status">正在读取…</p>}
    {!loading && loadedScope === recordScope && !shownItems.length && !error && <div className={styles.empty}>暂无记录<button type="button" onClick={props.onDraft}>返回工作台</button></div>}
    {loadedScope === recordScope && cursor && !error && <div className={styles.more}><button type="button" disabled={loading} onClick={() => void load(true)}>加载更多</button></div>}
    {manage && <div ref={backdrop} className={toolStyles.toolsBackdrop}><section ref={management} className={toolStyles.tools} role="dialog" aria-modal="true" aria-label="管理方案">
      <header className={toolStyles.toolsHeader}><h3>方案</h3><button type="button" aria-label="关闭方案" title="关闭" onClick={() => { setManage(null); void load(); void loadProjects(); }}><X size={18} /></button></header>
      <MultiviewWorks key={`${identity}:${manage.id}:${manage.action || ''}`} owner={owner} authority={authority} initialWorkId={manage.id} initialAction={manage.action} detailOnly
        onClose={() => { setManage(null); void load(); void loadProjects(); }} onNew={props.onDraft}
        onEdit={work => props.onWork(work.id, work.sourceTaskId)} onUseReference={props.onUseReference} />
    </section></div>}
  </section>;
}
