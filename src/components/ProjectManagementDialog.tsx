'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import { readJsonResponse } from '@/lib/http/json-response';
import { projectStatusExpectation, useProjectCreateOperation, type ProjectCreateResult } from '@/lib/projects/client-operations';
import { publishProjectCatalogChange, readProjectSelectorCatalog } from '@/lib/projects/selector-client';
import ProjectActionConfirmModal from './ProjectActionConfirmModal';
import ProjectCreateOperationNotice from './ProjectCreateOperationNotice';
import { useDialogDismiss } from './useDialogDismiss';
import styles from './ProjectSelector.module.css';

export type ProjectManagementRequest = { mode: 'create' | 'edit' | 'delete' | 'archive'; projectId?: string };
type Detail = { id: string; name: string; description: string | null; type: string; status: string;
  status_version: { status: string; updated_at: string } };
type View = { project: Detail; permission: { can_manage_project: boolean; can_delete: boolean; can_archive: boolean } };
type Pending = { ownerId: string; projectId: string; mode: 'edit' | 'delete' | 'archive'; expected_status: string; expected_updated_at: string; name: string; description: string };
export function ProjectManagementDialog({ request, onClose, portalTarget }: {
  request: ProjectManagementRequest; onClose: () => void; portalTarget?: HTMLElement | null;
}) {
  const { user, sessionChanged } = useAppSession();
  const ownerId = user?.id || '', owner = useRef(ownerId); owner.current = ownerId;
  const current = () => Boolean(ownerId && owner.current === ownerId && !sessionChanged && !isClientSessionBlocked());
  const createOperation = useProjectCreateOperation(ownerId, 'project-selector');
  const [view, setView] = useState<View | null>(null), [loading, setLoading] = useState(request.mode !== 'create');
  const [name, setName] = useState(''), [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [canCreate, setCanCreate] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const storageKey = ownerId && request.projectId ? `sd2:project-selector-mutation:v1:${ownerId}:${request.projectId}` : '';
  const submitting = useRef(false), panel = useRef<HTMLDivElement>(null), overlay = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
  const guardedClose = () => { if (!submitting.current && !createOperation.busy) onClose(); };
  useDialogDismiss({ open: !((request.mode === 'delete' && view?.permission.can_delete || request.mode === 'archive' && view?.permission.can_archive) && !pending && !error), dialogRef: panel, dismissSurfaceRef: overlay,
    initialFocusRef: input, onDismiss: guardedClose, dismissOnOutside: !busy && !createOperation.busy, dismissOnEscape: !busy && !createOperation.busy });
  async function readDetail() {
    const response = await fetch(`/api/projects/${encodeURIComponent(request.projectId || '')}?view=selector`, {
      cache: 'no-store', headers: { 'x-app-session-user': ownerId }, signal: AbortSignal.timeout(15000),
    });
    const value = await readJsonResponse<View & { error?: string }>(response);
    if (!response.ok || value.project?.id !== request.projectId || !value.project.status_version || !value.permission) throw new Error(value.error || '项目资料暂未确认，当前输入保留。');
    return value;
  }
  useEffect(() => {
    let cancelled = false;
    if (!ownerId) return;
    if (request.mode === 'create') {
      void readProjectSelectorCatalog(ownerId).then(value => { if (!cancelled && current()) setCanCreate(value.capabilities.can_create_team_project === true && value.capabilities.create_operation_version === 1); }).catch(cause => { if (!cancelled && current()) setError(cause.message); });
    } else {
      let restored: Pending | null = null;
      try {
        const raw = localStorage.getItem(storageKey);
        if (raw) {
          restored = JSON.parse(raw) as Pending;
          if (restored.ownerId !== ownerId || restored.projectId !== request.projectId || !['edit','delete','archive'].includes(restored.mode)
            || typeof restored.name !== 'string' || typeof restored.description !== 'string' || typeof restored.expected_updated_at !== 'string') throw new Error('原项目操作记录暂时无法确认，请保留当前输入。');
          setPending(restored); setName(restored.name); setDescription(restored.description);
        }
      } catch (cause) { setError(cause instanceof Error ? cause.message : '原操作记录暂不可读取。'); setLoading(false); return; }
      void readDetail().then(value => {
        if (cancelled || !current()) return; setView(value);
        if (!restored) { setName(value.project.name); setDescription(value.project.description || ''); }
      }).catch(cause => { if (!cancelled && current()) setError(cause.message); }).finally(() => { if (!cancelled && current()) setLoading(false); });
    }
    return () => { cancelled = true; };
    // The frozen dialog request owns its original input and actor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerId, request.projectId, request.mode, storageKey]);
  useEffect(() => { if (createOperation.pending && !name) { setName(createOperation.pending.input.name); setDescription(createOperation.pending.input.description || ''); } }, [createOperation.pending, name]);
  async function created(result: ProjectCreateResult) {
    if (!current() || result.operation.state !== 'accepted' || !result.project) return;
    publishProjectCatalogChange({ ownerId, kind: 'created', projectId: result.project.id }); onClose();
  }
  async function create() {
    if (!current() || !canCreate || !name.trim() || submitting.current) return;
    submitting.current = true; setError('');
    try { await created(await createOperation.create({ name, description })); }
    catch { /* The existing hook keeps the original request, input and unknown receipt. */ }
    finally { submitting.current = false; }
  }
  function clearPending() { if (storageKey) localStorage.removeItem(storageKey); setPending(null); }
  async function mutate() {
    if (!current() || !view || pending || submitting.current || !view.permission.can_manage_project) return;
    if (request.mode === 'delete' && (!view.permission.can_delete || ['personal','system'].includes(view.project.type))) return;
    if (request.mode === 'archive' && !view.permission.can_archive) return;
    if (request.mode === 'edit' && (view.project.status !== 'active' || !name.trim())) return;
    const frozen: Pending = { ownerId, projectId: view.project.id, mode: request.mode as 'edit' | 'delete' | 'archive',
      ...projectStatusExpectation(view.project), name: name.trim(), description: description.trim() };
    try { localStorage.setItem(storageKey, JSON.stringify(frozen)); }
    catch { setError('原操作暂不能安全保留，尚未提交；当前输入保留。'); return; }
    submitting.current = true; setPending(frozen); setBusy(true); setError('');
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(frozen.projectId)}`, { method: frozen.mode === 'delete' ? 'DELETE' : 'PATCH',
        cache: 'no-store', headers: { 'Content-Type': 'application/json', 'x-app-session-user': ownerId }, signal: AbortSignal.timeout(30000),
        body: JSON.stringify({ expected_status: frozen.expected_status, expected_updated_at: frozen.expected_updated_at,
          ...(frozen.mode === 'edit' ? { name: frozen.name, description: frozen.description } : frozen.mode === 'archive' ? { action: 'archive' } : {}) }),
      });
      const value = await readJsonResponse<{ project?: Detail; error?: string; message?: string }>(response);
      if (!current()) return;
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && typeof value.error === 'string') { clearPending(); throw new Error(value.error); }
        throw new Error('原操作结果待确认，请先查询；不会自动重发。');
      }
      if (value.project?.id !== frozen.projectId || !value.project.status_version) throw new Error('原操作结果待确认，请先查询；不会自动重发。');
      clearPending(); publishProjectCatalogChange({ ownerId, kind: frozen.mode === 'delete' ? 'deleted' : 'updated', projectId: frozen.projectId }); onClose();
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : '原操作结果待确认，请查询原结果。'); }
    finally { submitting.current = false; if (current()) setBusy(false); }
  }
  async function check() {
    if (!current() || busy || submitting.current) return;
    setBusy(true); setError('');
    try {
      const latest = await readDetail(); if (!current()) return; setView(latest);
      if (pending) {
        if (pending.mode === 'edit' && latest.project.name === pending.name && (latest.project.description || '') === pending.description || pending.mode === 'archive' && latest.project.status === 'archived') {
          clearPending(); publishProjectCatalogChange({ ownerId, kind: 'checked', projectId: latest.project.id });
          setError('当前项目资料与本次输入一致，原请求未重发。');
        } else setError('已读到最新项目，原操作结果仍待确认；当前输入和原请求保留。');
      } else setError('已核对最新项目状态，当前输入保留。');
    } catch (cause) { if (current()) setError(pending ? '原操作结果仍待确认，或项目已不可访问；没有再次提交，当前输入保留。' : cause instanceof Error ? cause.message : '项目暂不可读取。'); }
    finally { if (current()) setBusy(false); }
  }
  if (!ownerId || owner.current !== ownerId || sessionChanged) return null;
  const host = portalTarget || document.body;
  if ((request.mode === 'delete' && view?.permission.can_delete || request.mode === 'archive' && view?.permission.can_archive) && view && !pending && !error) return createPortal(<ProjectActionConfirmModal action={request.mode === 'archive' ? 'archive' : 'delete'}
    projectName={view.project.name} meta={request.mode === 'archive' ? '保留项目历史、任务和素材' : '仅可删除没有内容和历史引用的空项目'} busy={busy} onCancel={guardedClose} onConfirm={()=>void mutate()} />, host);
  const title = request.mode === 'create' ? '新建项目' : request.mode === 'delete' ? '删除项目' : request.mode === 'archive' ? '归档项目' : '编辑项目';
  return createPortal(<div ref={overlay} className="modal-overlay" role="dialog" aria-modal="true" aria-label={title}>
    <div ref={panel} className={`modal-panel ${styles.dialog}`}><div className="modal-header"><h2>{title}</h2><button type="button" className="modal-close" disabled={busy || createOperation.busy} onClick={guardedClose} aria-label="关闭">×</button></div>
      {loading ? <p role="status">正在读取项目…</p> : ['delete','archive'].includes(request.mode) ? <p>{pending ? busy ? '正在处理原操作…' : '原操作结果待确认，不会再次提交。' : !view ? '项目暂不可访问。' : ['personal','system'].includes(view.project.type) ? '默认或系统项目不能执行此操作。' : request.mode === 'archive' ? '当前项目状态或权限不允许归档。' : '项目已有内容、历史记录或当前无删除权限，不能删除。'}</p> : <>
        <label>项目名称<input ref={input} className="input" value={name} maxLength={80} disabled={busy || Boolean(pending) || Boolean(createOperation.pending)} onChange={event=>setName(event.target.value)} /></label>
        <label>说明<textarea className="input" value={description} maxLength={2000} disabled={busy || Boolean(pending) || Boolean(createOperation.pending)} onChange={event=>setDescription(event.target.value)} /></label>
      </>}
      {request.mode === 'create' && <ProjectCreateOperationNotice operation={createOperation} onResolved={created} />}
      {pending && <p className={styles.notice} role="status">原{pending.mode === 'delete' ? '删除' : '保存'}结果待确认，只查询原结果；其它项目仍可正常选择。</p>}
      {error && <p className={styles.notice} role="status">{error}</p>}
      <div className={styles.actions}><button type="button" className="btn btn-secondary" disabled={busy || createOperation.busy} onClick={guardedClose}>关闭</button>
        {request.mode !== 'create' && <button type="button" className="btn btn-secondary" disabled={busy || loading} onClick={()=>void check()}>{pending ? '查询原结果' : '核对最新'}</button>}
        {request.mode === 'create' && <button type="button" className="btn btn-primary" disabled={!canCreate || !createOperation.ready || createOperation.busy || Boolean(createOperation.pending) || !name.trim()} onClick={()=>void create()}>{createOperation.busy ? '正在创建…' : '创建项目'}</button>}
        {request.mode === 'edit' && !pending && <button type="button" className="btn btn-primary" disabled={busy || loading || !view?.permission.can_manage_project || view.project.status !== 'active' || !name.trim() || name.trim() === view.project.name && description.trim() === (view.project.description || '')} onClick={()=>void mutate()}>{busy ? '正在保存…' : '保存'}</button>}
      </div>
    </div>
  </div>, host);
}
