'use client';
import { useEffect, useRef, useState } from 'react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { pendingWorkOperations, queryWorkOperation, worksMutate, worksRead, WorksClientError } from '@/lib/works/client';
import { workAudienceLabels } from '@/lib/works/types';
import styles from './Works.module.css';

type Audience = 'team' | 'project' | 'private' | null;
type Projection = { viewerId: string; projectId: string; audience: Audience; projectType?: string; expectedUpdatedAt: string; canManage: boolean };
export function ProjectWorkAudience({ projectId, initialAudience, ownerId, projectType, compact = false }: { projectId: string; initialAudience?: Audience; ownerId?: string; projectType?: string; compact?: boolean }) {
  const { user, sessionChanged } = useAppSession(), viewerId = user?.id || '';
  const [current, setCurrent] = useState<Projection | null>(null), [chosen, setChosen] = useState<Audience>(initialAudience ?? null), [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [retry, setRetry] = useState(0), [unknown, setUnknown] = useState(false);
  const [requested, setRequested] = useState(false);
  const epoch = useRef(0), lock = useRef(false), draft = useRef(false);
  useEffect(() => {
    if (!viewerId || !projectId || sessionChanged) return;
    setUnknown(pendingWorkOperations(viewerId).some(item => item.key === `project-audience:${projectId}`));
    if (compact && initialAudience !== undefined && !requested) return;
    const token = ++epoch.current; setCurrent(null); setEditing(requested); setNotice(''); draft.current = false;
    setUnknown(pendingWorkOperations(viewerId).some(item => item.key === `project-audience:${projectId}`));
    void worksRead<Projection>(`/api/works/project-audience?projectId=${encodeURIComponent(projectId)}`, viewerId).then(data => { if (token === epoch.current) { setCurrent(data); setChosen(data.audience); } }).catch(cause => { if (token === epoch.current && (!compact || requested)) setNotice(cause instanceof Error ? cause.message : '范围暂未读取'); });
    return () => { epoch.current++; };
  }, [projectId, viewerId, sessionChanged, retry, compact, initialAudience, requested]);
  async function save(reconcile = false) {
    if (lock.current || !viewerId || sessionChanged || !reconcile && !current) return;
    lock.current = true; setBusy(true); setNotice(''); const token = epoch.current;
    try {
      const pending = pendingWorkOperations(viewerId).find(item => item.key === `project-audience:${projectId}`);
      const result = reconcile && pending ? await queryWorkOperation(viewerId, pending) : await worksMutate(viewerId, `project-audience:${projectId}`, '/api/works/project-audience', { projectId, audience: chosen, expectedUpdatedAt: current!.expectedUpdatedAt });
      if (token !== epoch.current) return;
      setCurrent(old => ({ ...old, ...result } as Projection)); setChosen(result.audience as Audience); setEditing(false); draft.current = false; setNotice('作品范围已保存');
    } catch (cause) {
      if (token !== epoch.current) return;
      setNotice(cause instanceof Error ? cause.message : '范围尚未保存');
      if (cause instanceof WorksClientError && cause.status === 409) { try { const fresh = await worksRead<Projection>(`/api/works/project-audience?projectId=${encodeURIComponent(projectId)}`, viewerId); if (token === epoch.current) { setCurrent(fresh); if (!draft.current) setChosen(fresh.audience); } } catch { /* Keep the submitted choice for a deliberate retry. */ } }
    } finally { lock.current = false; if (token === epoch.current) { setBusy(false); setUnknown(pendingWorkOperations(viewerId).some(item => item.key === `project-audience:${projectId}`)); } }
  }
  if (!viewerId || sessionChanged) return null;
  const audience = current ? current.audience : initialAudience ?? null;
  const type = current?.projectType || projectType;
  return <span className={styles.audience}>
    {(current || initialAudience !== undefined) && <span>新成品：{workAudienceLabels[audience || 'source']}</span>}
    {!current && compact && initialAudience !== undefined && ownerId === viewerId && projectType === 'team' && <button type="button" onClick={() => setRequested(true)}>设置范围</button>}
    {current?.canManage && !editing && <button type="button" disabled={busy || unknown} onClick={() => { setEditing(true); setChosen(current.audience); }}>设置范围</button>}
    {editing && current && <><select aria-label="项目新成品可见范围" value={chosen || 'source'} disabled={busy || unknown} onChange={event => { draft.current = true; setChosen(event.target.value === 'source' ? null : event.target.value as Audience); }}><option value="source" disabled={type === 'personal'}>保留原有范围</option><option value="team" disabled={type === 'personal'}>全体同事可看成品</option><option value="project" disabled={type === 'personal'}>仅项目组</option><option value="private">仅本人</option></select><button type="button" disabled={busy || unknown || chosen === current.audience} onClick={() => void save()}>保存</button><button type="button" disabled={busy} onClick={() => setEditing(false)}>取消</button><span style={{width: '100%'}}>扩大只影响之后的新成品；收紧会限制已有广场分享</span></>}
    {unknown && <button type="button" disabled={busy} onClick={() => void save(true)}>核对原范围保存</button>}
    {notice && <span role="status">{notice}{!current && <button type="button" onClick={() => setRetry(value => value + 1)}>重试读取</button>}</span>}
  </span>;
}
