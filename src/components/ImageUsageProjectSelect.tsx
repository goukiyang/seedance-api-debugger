'use client';
import { ProjectSelector } from './ProjectSelector';

import { useEffect, useId, useRef, useState } from 'react';
import { X, RefreshCw } from 'lucide-react';

const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value);

export function useImageUsageProject(ownerId: string, workspace: string) {
  const key = `sd2:image-usage-project:v1:${ownerId}:${workspace}`;
  const [state, setState] = useState({ key: '', projectId: null as string | null, ready: false });
  const [storageIssue, setStorageIssue] = useState('');
  useEffect(() => {
    let projectId: string | null = null;
    try { const saved = localStorage.getItem(key); if (validId(saved)) projectId = saved; }
    catch { setStorageIssue('本次项目选择无法记住'); }
    setState({ key, projectId, ready: true });
  }, [key]);
  const ready = state.key === key && state.ready;
  return { projectId: ready ? state.projectId : null, ready, storageIssue,
    setProjectId: (projectId: string | null) => {
      if (projectId !== null && !validId(projectId)) return;
      setState({ key, projectId, ready: true });
      try { if (projectId) localStorage.setItem(key, projectId); else localStorage.removeItem(key); setStorageIssue(''); }
      catch { setStorageIssue('本次项目选择无法记住'); }
    } };
}

type Project = { id: string; name: string; can_generate?: boolean };
export function ImageUsageProjectSelect({ ownerId, value, onChange, disabled, storageIssue }: {
  ownerId: string; value: string | null; onChange: (id: string | null) => void; disabled?: boolean; storageIssue?: string;
}) {
  const id = useId();
  const [state, setState] = useState({ owner: '', projects: [] as Project[], loading: true, error: '' });
  const [revision, setRevision] = useState(0);
  const epoch = useRef(0);
  useEffect(() => {
    const sequence = ++epoch.current;
    const controller = new AbortController();
    setState({ owner: ownerId, projects: [], loading: true, error: '' });
    void fetch('/api/projects?lite=true&include_all=true', { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        const data = await response.json();
        if (!response.ok || !Array.isArray(data.projects)) throw new Error('项目暂未读到，请重试');
        if (controller.signal.aborted || sequence !== epoch.current) return;
        setState({ owner: ownerId, projects: data.projects.filter((p: Project) => validId(p.id) && p.can_generate === true), loading: false, error: '' });
      }).catch(() => {
        if (!controller.signal.aborted && sequence === epoch.current) setState({ owner: ownerId, projects: [], loading: false, error: '项目暂未读到，当前选择保留' });
      });
    return () => controller.abort();
  }, [ownerId, revision]);
  const projects = state.owner === ownerId ? state.projects : [];
  const selected = projects.find(project => project.id === value);
  const unavailable = value && !state.loading && !state.error && !selected;
  return <div style={{ minWidth: 0, marginBlock: 8 }}>
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <label htmlFor={id}>项目</label>
      <ProjectSelector onCatalogChange={() => setRevision(value => value + 1)} id={id} value={value || ''} disabled={disabled || state.loading || state.owner !== ownerId}
        style={{ minWidth: 120, maxWidth: '100%', flex: '1 1 160px' }} onChange={event => onChange(event.target.value || null)}>
        <option value="">未归属</option>
        {value && !selected && <option value={value}>{state.loading ? '正在核对原项目' : state.error ? '原项目待核对' : '原项目不可用，请重新选择'}</option>}
        {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
      </ProjectSelector>
      {value && <button type="button" aria-label="清除项目选择" title="清除项目选择" disabled={disabled} onClick={() => onChange(null)}><X size={15} /></button>}
      {state.error && <button type="button" aria-label="重新读取项目" title="重新读取项目" onClick={() => setRevision(n => n + 1)}><RefreshCw size={15} /></button>}
    </div>
    {(unavailable || state.error || storageIssue) && <small role="status">{unavailable ? '原项目已不可用，输入保留；请选择项目或清除归属' : state.error || storageIssue}</small>}
  </div>;
}
