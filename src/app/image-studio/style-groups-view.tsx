'use client';

import { useProductDialog } from '@/components/useProductDialog';

import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from 'react';
import { Combine, Copy, Layers, MoreHorizontal, Pencil, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react';
import { UploadedImagePicker } from '@/components/UploadedImagePicker';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { usePageExitRisk } from '@/lib/hooks/page-exit-guard';
import { uploadFileAsAsset, type UploadedAssetPayload } from '@/lib/http/file-upload';
import { MAX_REFERENCE_IMAGES } from '@/lib/image-studio/limits';
import { StudioReferenceGrid, type FixedStudioReference } from './reference-grid';
import styles from './studio.module.css';

export type StudioStyleSummary = { id: string; name: string; revision?: number; coverUrl: string | null; canManage: boolean;
  referenceCount: number; references?: FixedStudioReference[]; coverAssetId?: string; note?: string; unavailable?: boolean;
  canReadContent?: boolean; canCopy?: boolean; historical?: boolean; sourceTaskId?: string; contentState?: 'complete' | 'partial' | 'restricted'; shared?: boolean; disabled?: boolean; ownerId?: string };
type Draft = { id?: string; revision?: number; name: string; coverAssetId: string; note: string; references: FixedStudioReference[]; shared?: boolean; disabled?: boolean; copyFrom?: { id: string; taskId?: string; revision?: number } };
type Pending = { requestId: string; kind: 'save' | 'delete' | 'draft'; use?: boolean; group?: StudioStyleSummary };
const draftText = (value: Draft) => JSON.stringify({ id: value.id, revision: value.revision, name: value.name, coverAssetId: value.coverAssetId,
  note: value.note, shared: value.shared !== false, disabled: value.disabled === true, copyFrom: value.copyFrom,
  references: value.references.map(reference => ({ id: reference.id, note: reference.note })) });

async function responseValue(response: Response) {
  const value = await response.json().catch(() => { throw new Error('服务暂时无法响应'); });
  if (!response.ok) throw Object.assign(new Error(value.error || '风格组操作失败'), { status: response.status });
  return value;
}

export type StudioStyleGroupsHandle = { open: () => void; edit: (group?: StudioStyleSummary, copy?: boolean) => void };
export const StudioStyleGroups = forwardRef<StudioStyleGroupsHandle, {
  userId: string; selected: StudioStyleSummary[]; onChange: (groups: StudioStyleSummary[]) => void;
  currentImages: UploadedAssetPayload[]; disabled?: boolean; tiles?: boolean; maxReferences?: number;
  managementOnly?: boolean; onUpdated?: (group: StudioStyleSummary, use?: boolean) => void; onClose?: () => void;
}>(function StudioStyleGroups({ userId, selected, onChange, currentImages, disabled, tiles = false, maxReferences = MAX_REFERENCE_IMAGES, managementOnly = false, onUpdated, onClose }, ref) {
  const { confirm, prompt, productDialog } = useProductDialog();
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<StudioStyleSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [savedDraft, setSavedDraft] = useState('');
  const [mergeIds, setMergeIds] = useState<string[]>([]);
  const [picker, setPicker] = useState(false);
  const [preview, setPreview] = useState<UploadedAssetPayload | null>(null);
  const [uploading, setUploading] = useState(false);
  const [readingEditor, setReadingEditor] = useState(false), [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<StudioStyleSummary | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const draftId = useRef(''), draftRevision = useRef(0), durable = useRef(''), editSequence = useRef(0);
  const storageKey = `sd2:style-editor:v2:${userId}`;
  const noteFieldId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const editor = useRef<HTMLDialogElement>(null);
  const uploadLock = useRef(false);
  const request = useRef(0);
  const alive = useRef(true), actor = useRef(userId); actor.current = userId;
  const dirty = draft !== null && draftText(draft) !== savedDraft;
  usePageExitRisk({ unsaved: dirty && draft && draftText(draft) !== durable.current ? ['风格组编辑'] : [],
    busy: pending ? ['正在核对原风格组操作'] : [], revision: draft ? draftText(draft) : '' });

  useEffect(() => { if (open && !draft && (!preview || managementOnly)) dialog.current?.showModal(); else dialog.current?.close(); }, [open, draft, preview, managementOnly]);
  useEffect(() => { if (draft && (!preview || managementOnly)) editor.current?.showModal(); else editor.current?.close(); }, [Boolean(draft), preview, managementOnly]);
  useEffect(() => () => { request.current += 1; }, [userId]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (!open) onClose?.(); }, [open, onClose]);
  const remember = (value: Pending | null, target = draftId.current, groupId = draft?.id) => {
    try { localStorage.setItem(storageKey, JSON.stringify({ draftId: target, groupId, pending: value })); setPending(value); return true; }
    catch { setError('无法保留原操作编号，尚未发送；当前输入保留'); return false; }
  };
  useEffect(() => {
    if (!draft || busy || pending || conflict || draftText(draft) === durable.current) return;
    const owner = userId, value = draft, serialized = draftText(value), generation = editSequence.current;
    const timer = setTimeout(() => {
      const operation: Pending = { requestId: crypto.randomUUID(), kind: 'draft' };
      if (!remember(operation)) return;
      setBusy(true);
      void fetchDraft(value, operation.requestId).then(responseValue).then(result => {
        if (!alive.current || actor.current !== owner || generation !== editSequence.current) return;
        draftRevision.current = result.draft.revision; durable.current = serialized; remember(null);
      }).catch(cause => {
        if (!alive.current || actor.current !== owner || generation !== editSequence.current) return;
        if (cause.status >= 400 && cause.status < 500) { remember(null); setConflict(cause.status === 409); }
        setError(cause.message || '草稿结果待确认，请核对原操作');
      }).finally(() => { if (alive.current && actor.current === owner && generation === editSequence.current) setBusy(false); });
    }, 700);
    return () => clearTimeout(timer);
    // Draft payload stays on the authenticated server; browser storage keeps only ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, busy, pending, conflict, userId]);
  function fetchDraft(value: Draft, requestId: string) {
    return fetch('/api/image-studio/style-groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'draft', draftId: draftId.current, expectedRevision: draftRevision.current, requestId, value: JSON.parse(draftText(value)) }) });
  }

  async function load(next?: string) {
    const current = ++request.current;
    setLoading(true); setError('');
    try {
      const result = await responseValue(await fetch(`/api/image-studio/style-groups${next ? `?cursor=${encodeURIComponent(next)}` : ''}`, { cache: 'no-store' }));
      if (request.current !== current) return;
      setGroups(existing => next ? [...existing.filter(group => !result.groups.some((item: StudioStyleSummary) => item.id === group.id)), ...result.groups] : result.groups);
      setCursor(result.nextCursor);
      if (!next) setMergeIds([]);
    } catch (cause) { if (current === request.current) setError(cause instanceof Error ? cause.message : '读取失败'); }
    finally { if (current === request.current) setLoading(false); }
  }
  const closeEditor = async () => {
    if (busy || uploading || picker || pending) { if (pending) setError('请先核对原操作，当前输入保留'); return; }
    if (dirty && draft && draftText(draft) !== durable.current && !(await confirm('这次修改尚未可靠保存，关闭会丢失修改。', { title: '尚未保存', confirmLabel: '关闭' }))) return;
    editSequence.current++;
    setDraft(null); setLatest(null); setError('');
  };
  const closeManager = () => {
    if (busy || draft) return;
    editSequence.current++; setReadingEditor(false); setOpen(false);
  };
  useDialogDismiss({ open: open && !preview, dialogRef: dialog, nativeDialog: true, onDismiss: closeManager });
  useDialogDismiss({ open: Boolean(draft) && !preview, dialogRef: editor, nativeDialog: true, onDismiss: closeEditor });
  async function edit(group?: StudioStyleSummary, copy = false) {
    if (managementOnly && disabled) return;
    const generation = ++editSequence.current, owner = userId;
    setReadingEditor(true); setError(''); setConflict(false); setLatest(null);
    try {
      if (group && !(copy && group.historical)) {
        const result = await responseValue(await fetch(`/api/image-studio/style-groups?page=1&keys=${encodeURIComponent(group.id)}`, { cache: 'no-store' }));
        group = result.groups.find((item: StudioStyleSummary) => item.id === group!.id);
        if (!group?.canManage || !Array.isArray(group.references) || typeof group.note !== 'string' || !Number.isSafeInteger(group.revision)) throw new Error('完整内容未读取成功或已失权，未打开空稿');
      }
      if (copy && (!group?.canCopy || !group.references?.length)) throw new Error('没有完整内容或复制权限，不能另存');
      if (!alive.current || actor.current !== owner || generation !== editSequence.current) return;
      const refs = group ? group.references! : currentImages.map(image => ({ ...image, note: '', available: true }));
      const next: Draft = { ...(group && !copy ? { id: group.id, revision: group.revision } : {}), name: group ? copy ? `${group.name.slice(0, 77)} 副本` : group.name : '',
        coverAssetId: group?.coverAssetId || refs[0]?.id || '', note: group?.note || '', references: refs, shared: copy ? false : group?.shared !== false, disabled: copy ? false : group?.disabled === true,
        ...(copy && group ? { copyFrom: { id: group.id, revision: group.revision, ...(group.sourceTaskId ? { taskId: group.sourceTaskId } : {}) } } : {}) };
      let retained: { draftId?: string; groupId?: string; pending?: Pending } = {};
      try { retained = JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { /* Start a new editor. */ }
      draftId.current = !copy && retained.groupId === next.id && retained.draftId ? retained.draftId : group && !copy ? group.id : crypto.randomUUID();
      const result = await responseValue(await fetch(`/api/image-studio/style-groups?mode=draft&id=${draftId.current}`, { cache: 'no-store' }));
      if (!alive.current || actor.current !== owner || generation !== editSequence.current) return;
      const restored = result.draft?.value as Draft | undefined;
      draftRevision.current = result.draft?.revision || 0;
      const hasChanges = restored && draftText(restored) !== draftText(next);
      const value = hasChanges ? restored : next;
      setConflict(Boolean(hasChanges && restored.id && restored.revision !== next.revision));
      setDraft(value); setSavedDraft(draftText(next)); durable.current = draftText(value);
      remember(retained.draftId === draftId.current ? retained.pending || null : null, draftId.current, next.id);
    } catch (cause) { if (generation === editSequence.current && actor.current === owner) setError(cause instanceof Error ? cause.message : '完整内容读取失败，未打开空稿'); }
    finally { if (generation === editSequence.current && actor.current === owner) setReadingEditor(false); }
  }
  function reflect(group: StudioStyleSummary, use = false) {
    setGroups(existing => existing.some(item => item.id === group.id) ? existing.map(item => item.id === group.id ? group : item) : [group, ...existing]);
    if (use) onChange(selected.some(item => item.id === group.id) ? selected.map(item => item.id === group.id ? group : item) : [...selected, group]);
    onUpdated?.(group, use);
  }
  async function save(use = false) {
    if (!draft || busy || pending || conflict || uploading || managementOnly && disabled) return;
    const owner = userId;
    const operation: Pending = { requestId: crypto.randomUUID(), kind: 'save', use };
    if (!remember(operation)) return;
    setBusy(true); setError('');
    try {
      const group = await responseValue(await fetch('/api/image-studio/style-groups', { method: draft.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...draft, requestId: operation.requestId, draftId: draftId.current, draftRevision: draftRevision.current, references: draft.references.map(ref => ({ assetId: ref.id, note: ref.note || '' })) }) }));
      if (!alive.current || actor.current !== owner) return;
      reflect(group, use); remember(null); localStorage.removeItem(storageKey); setDraft(null);
      if (managementOnly) setOpen(false);
    } catch (cause) { if (alive.current && actor.current === owner) {
      const status = (cause as { status?: number }).status;
      if (status && status >= 400 && status < 500) { remember(null); setConflict(status === 409); }
      setError(cause instanceof Error ? cause.message : '保存结果待确认，请核对原操作');
    } }
    finally { if (alive.current && actor.current === owner) setBusy(false); }
  }
  async function remove(group: StudioStyleSummary) {
    if (managementOnly && disabled) return;
    const owner = userId;
    if (busy || pending || !(await confirm(`删除风格组“${group.name}”？原始图片、历史和已受理任务保留；当前引用将变为不可用。`, { title: '删除风格组', confirmLabel: '删除风格组', danger: true }))) return;
    if (!alive.current || actor.current !== owner) return;
    setBusy(true); setError('');
    const operation: Pending = { requestId: crypto.randomUUID(), kind: 'delete', group: { id: group.id, name: group.name, revision: group.revision, referenceCount: group.referenceCount, coverUrl: null, canManage: false } };
    if (!remember(operation)) { setBusy(false); return; }
    try {
      await responseValue(await fetch('/api/image-studio/style-groups', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: group.id, revision: group.revision, requestId: operation.requestId }) }));
      if (!alive.current || actor.current !== owner) return;
      setGroups(existing => existing.filter(item => item.id !== group.id));
      setMergeIds(existing => existing.filter(id => id !== group.id));
      remember(null);
      if (selected.some(item => item.id === group.id)) onChange(selected.map(item => item.id === group.id ? { ...item, unavailable: true, canManage: false } : item));
      onUpdated?.({ ...group, unavailable: true, canManage: false });
    } catch (cause) { if (alive.current && actor.current === owner) { if ((cause as { status?: number }).status! < 500) remember(null); setError(cause instanceof Error ? cause.message : '删除结果待确认'); } }
    finally { if (alive.current && actor.current === owner) setBusy(false); }
  }
  async function merge() {
    if (managementOnly && disabled) return;
    const owner = userId;
    const name = await prompt('合并后的风格组名称（原组会保留）', '合并风格', { title: '合并风格组', confirmLabel: '合并风格组', maxLength: 80 });
    if (!name?.trim() || busy || !alive.current || actor.current !== owner) return;
    setBusy(true); setError('');
    try {
      const group = await responseValue(await fetch('/api/image-studio/style-groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim(), references: [], mergeIds }) }));
      if (!alive.current || actor.current !== owner) return;
      reflect(group); setMergeIds([]); edit(group);
    } catch (cause) { if (alive.current && actor.current === owner) setError(cause instanceof Error ? cause.message : '合并失败'); }
    finally { if (alive.current && actor.current === owner) setBusy(false); }
  }
  async function queryPending() {
    if (!pending || busy) return;
    const operation = pending, owner = userId;
    setBusy(true); setError('');
    try {
      const value = await responseValue(await fetch(`/api/image-studio/style-groups?mode=status&requestId=${operation.requestId}`, { cache: 'no-store' }));
      if (!alive.current || actor.current !== owner) return;
      if (value.state === 'unknown') { setError('原操作结果仍待确认，请继续核对，未重复发送'); return; }
      if (value.state === 'saved') {
        reflect(value.result, operation.use); setDraft(null); localStorage.removeItem(storageKey);
      } else if (value.state === 'deleted') {
        const id = value.result.id;
        setGroups(items => items.filter(item => item.id !== id));
        onChange(selected.map(item => item.id === id ? { ...item, unavailable: true, canManage: false } : item));
        if (operation.group) onUpdated?.({ ...operation.group, unavailable: true, canManage: false });
      } else if (value.state === 'draft') {
        draftRevision.current = value.result.revision; durable.current = draftText(value.result.value);
      } else if (value.state === 'conflict') {
        setConflict(true); setError('原操作未覆盖已有新版本，当前草稿保留，可查看当前原组或另存副本');
      }
      remember(null);
    } catch (cause) { if (alive.current && actor.current === owner) setError(cause instanceof Error ? cause.message : '原操作尚未确认'); }
    finally { if (alive.current && actor.current === owner) setBusy(false); }
  }
  function copyDraft() {
    if (!draft || pending || busy) return;
    const next: Draft = { ...draft, id: undefined, revision: undefined, shared: false, disabled: false,
      ...(draft.id ? { copyFrom: { id: draft.id, revision: draft.revision } } : {}) };
    draftId.current = crypto.randomUUID(); draftRevision.current = 0; durable.current = ''; setDraft(next); setConflict(false); remember(null, draftId.current, undefined);
  }
  async function upload(files: File[]) {
    if (!draft || uploadLock.current || uploading || busy || !files.length) return;
    if (draft.references.length + files.length > MAX_REFERENCE_IMAGES) { setError(`最多 ${MAX_REFERENCE_IMAGES} 张图片`); return; }
    uploadLock.current = true; setUploading(true); setError('');
    const owner = userId;
    const added: FixedStudioReference[] = [];
    try {
      for (const file of files) {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024) throw new Error('请使用 20MB 以内的 JPG、PNG 或 WebP 图片');
        const asset = await uploadFileAsAsset(file);
        if (!alive.current || actor.current !== owner) return;
        if (!asset.id || !asset.originalUrl) throw new Error('上传结果不完整，请重试');
        added.push({ ...asset, note: '', available: true });
      }
    } catch (cause) { if (alive.current && actor.current === owner) setError(cause instanceof Error ? cause.message : '上传失败'); }
    finally {
      if (alive.current && actor.current === owner) {
        if (added.length) setDraft(current => current ? { ...current, coverAssetId: current.coverAssetId || added[0].id || '', references: [...current.references, ...added] } : current);
        uploadLock.current = false; setUploading(false);
      }
    }
  }
  function changeReferences(references: FixedStudioReference[]) {
    setDraft(current => current ? { ...current, references, coverAssetId: references.some(ref => ref.id === current.coverAssetId) ? current.coverAssetId : references[0]?.id || '' } : current);
  }
  const selectedCount = selected.reduce((total, group) => total + group.referenceCount, 0);
  const openSelector = () => {
    setOpen(true); void load();
    try {
      const retained = JSON.parse(localStorage.getItem(storageKey) || '{}');
      setPending(retained.pending || null);
      if (retained.draftId && retained.pending?.kind !== 'delete') void edit(retained.groupId ? { id: retained.groupId } as StudioStyleSummary : undefined);
    } catch { /* Optional editor recovery must not prevent catalog access. */ }
  };
  useImperativeHandle(ref, () => ({ open: openSelector, edit: (group, copy) => { setOpen(true); void edit(group, copy); void load(); } }));
  return <>{productDialog}{(<div className={managementOnly ? undefined : tiles ? styles.styleGroupsTiles : styles.styleGroups}>
    {!managementOnly && <>
    {!tiles && <div className={styles.header}><strong>风格组</strong><button type="button" disabled={disabled} onClick={openSelector}><Layers size={16} />选择风格组</button></div>}
    {tiles ? <div className={styles.materialGrid}>{selected.map(group => <div key={group.id} className={styles.styleTile}>
      <button type="button" className={styles.styleTilePreview} disabled={disabled} onClick={openSelector} aria-label={`查看风格组${group.name}`} title={`${group.name} · ${group.referenceCount} 张${group.unavailable ? ' · 不可用' : ''}`}>
        <Layers size={24} aria-hidden="true" />{group.coverUrl && <img src={group.coverUrl} alt={`${group.name}封面`} onError={event => { event.currentTarget.hidden = true; }} />}
        <span className={styles.styleTileName}>{group.unavailable ? '风格组不可用' : group.name}</span>
      </button>
      <button type="button" className={styles.materialRemove} title="移除风格组" aria-label={`移除${group.name}`} disabled={disabled} onClick={() => onChange(selected.filter(item => item.id !== group.id))}><X size={14} /></button>
    </div>)}<button type="button" className={styles.materialAdd} disabled={disabled} title={maxReferences === 0 ? '本次风格图片额度已用完，可进入管理调整' : selectedCount >= maxReferences ? '风格图片已满，可进入管理替换' : '选择风格组'} onClick={openSelector}><Plus size={24} /><span>{maxReferences === 0 ? '管理风格组' : selectedCount >= maxReferences ? '替换风格组' : '选择风格组'}</span></button></div> : selected.length > 0 && <div className={styles.styleSelection}>{selected.map(group => <div key={group.id} className={styles.styleSelected}>
      {group.coverUrl && <img src={group.coverUrl} alt={`${group.name}封面`} />}
      <span>{group.name}</span><button type="button" title="移除风格组" aria-label={`移除${group.name}`} disabled={disabled} onClick={() => onChange(selected.filter(item => item.id !== group.id))}><X size={14} /></button>
    </div>)}</div>}
    </>}
    <dialog ref={dialog} className={`${styles.dialog} ${styles.styleDialog}`} aria-label={managementOnly ? '管理风格组' : '风格组'}>
      <header className={styles.header}><h2>{managementOnly ? '管理风格组' : '风格组'}</h2><button type="button" disabled={busy || Boolean(draft)} aria-label="关闭风格组" onClick={closeManager}><X size={20} /></button></header>
      <div className={styles.counts}><button type="button" disabled={busy || readingEditor || Boolean(pending)} onClick={() => void edit()}><Plus size={16} />新建</button>
        {mergeIds.length > 0 && <button type="button" disabled={busy || mergeIds.length < 2} onClick={() => void merge()}><Combine size={16} />合并 {mergeIds.length} 组</button>}
      </div>
      {(loading || readingEditor) && <p role="status">{readingEditor ? '正在读取完整内容…' : '正在读取风格组…'}</p>}
      {pending && <button type="button" disabled={busy} onClick={() => void queryPending()}><RefreshCw size={16} />核对原操作</button>}
      {!loading && !groups.length && !error && <p className={styles.muted}>暂无风格组</p>}
      {!draft && error && <p role="status" className={styles.muted}>{error}<button type="button" onClick={() => void load()}>重新读取</button></p>}
      <div className={styles.styleGrid}>{groups.map(group => {
        const used = selected.some(item => item.id === group.id);
        const exceedsLimit = !used && (selectedCount + group.referenceCount > maxReferences || selected.length >= MAX_REFERENCE_IMAGES);
        const selectionDisabled = Boolean(managementOnly || disabled || busy || exceedsLimit);
        const toggleSelection = () => {
          if (!selectionDisabled) onChange(used ? selected.filter(item => item.id !== group.id) : [...selected, group]);
        };
        return <article key={group.id} className={styles.styleCard} data-selected={used || undefined} data-disabled={selectionDisabled || undefined}
          title={exceedsLimit ? `可选风格图片上限 ${maxReferences} 张，已选 ${selectedCount} 张` : undefined}
          onClick={event => { if (!(event.target as Element).closest('button, input, label')) toggleSelection(); }}>
          <button type="button" className={styles.styleSelect} disabled={selectionDisabled} aria-pressed={used} aria-label={`${used ? '取消选用' : '选用'}风格组${group.name}`}
            onClick={event => { event.stopPropagation(); toggleSelection(); }}>
            <span className={styles.styleCover}>{group.coverUrl && <img src={group.coverUrl} alt={`${group.name}封面`} loading="lazy" />}</span>
            <strong title={group.name}>{group.name}</strong>
          </button>
          {group.canManage && <details className={styles.styleManagement} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}><summary aria-label={`管理${group.name}`} title="管理风格组"><MoreHorizontal size={18} /></summary><div className={styles.styleActions}>
            <button type="button" disabled={busy || readingEditor || Boolean(pending) || managementOnly && disabled} title="编辑当前原组" aria-label={`编辑${group.name}`} onClick={() => void edit(group)}><Pencil size={16} /></button>
              <button type="button" disabled={busy || readingEditor || Boolean(pending)} title="另存私人副本" aria-label={`另存${group.name}副本`} onClick={() => void edit(group, true)}><Copy size={16} /></button>
              <button type="button" disabled={busy} title="删除风格组" aria-label={`删除${group.name}`} onClick={() => void remove(group)}><Trash2 size={16} /></button>
              <input type="checkbox" aria-label={`选择${group.name}用于合并`} checked={mergeIds.includes(group.id)} disabled={busy} onChange={event => setMergeIds(current => event.target.checked ? [...current, group.id] : current.filter(id => id !== group.id))} />
          </div></details>}
        </article>;
      })}</div>
      {cursor && <button type="button" disabled={loading} onClick={() => void load(cursor)}>加载更多</button>}
    </dialog>
    <dialog ref={editor} className={`${styles.dialog} ${styles.styleDialog}`} aria-label="编辑风格组" onPaste={event => {
        if (picker || event.defaultPrevented) return;
        const files = Array.from(event.clipboardData.items).filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter((file): file is File => Boolean(file));
        if (files.length) { event.preventDefault(); event.stopPropagation(); void upload(files); }
      }}>
      <header className={styles.header}><h2>{draft?.id ? '编辑风格组' : '新建风格组'}</h2><button type="button" aria-label="关闭风格组编辑" disabled={busy || uploading} onClick={closeEditor}><X size={20} /></button></header>
      {draft && <>
        <label className={styles.label}>名称<input autoFocus maxLength={80} disabled={busy} value={draft.name} onChange={event => setDraft(current => current ? { ...current, name: event.target.value } : current)} /></label>
        <label className={styles.label} htmlFor={noteFieldId}>整体备注 <span>选填 · {draft.note.length}/8000</span></label>
        <textarea id={noteFieldId} aria-label="风格组整体备注" rows={5} maxLength={8000} disabled={busy} value={draft.note}
          placeholder="补充这组风格的整体说明" onChange={event => setDraft(current => current ? { ...current, note: event.target.value } : current)} />
        <label className={styles.label}><span><input type="checkbox" checked={draft.shared !== false} disabled={busy || Boolean(draft.copyFrom)} onChange={event => setDraft(value => value ? { ...value, shared: event.target.checked } : value)} />共享给同事</span></label>
        {draft.id && <label className={styles.label}><span><input type="checkbox" checked={draft.disabled === true} disabled={busy} onChange={event => setDraft(value => value ? { ...value, disabled: event.target.checked } : value)} />停用</span></label>}
        <label className={styles.label}>封面<select value={draft.coverAssetId} disabled={busy} onChange={event => setDraft(current => current ? { ...current, coverAssetId: event.target.value } : current)}>
          {!draft.references.length && <option value="">请先添加图片</option>}{draft.references.map((ref, index) => <option key={`${ref.id}-${index}`} value={ref.id}>风格 {index + 1}</option>)}
        </select></label>
        <div onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void upload(Array.from(event.dataTransfer.files)); }}>
          <StudioReferenceGrid items={draft.references} onChange={changeReferences} onPreview={image => setPreview(image)} compact labels="style" notes disabled={busy || uploading} />
        </div>
        <div className={styles.counts}><button type="button" disabled={busy || uploading || draft.references.length >= MAX_REFERENCE_IMAGES} onClick={() => setPicker(true)}><Plus size={16} />从资产库选择</button></div>
        {uploading && <p role="status">正在上传图片…</p>}
        {error && <p role="status" className={styles.muted}>{error}</p>}
        {conflict && <p role="status">原组或草稿已有更新，当前修改保留。<button type="button" onClick={copyDraft}><Copy size={16} />另存私人副本</button>{draft.id && <button type="button" onClick={async () => {
          const generation = editSequence.current;
          try {
            const result = await responseValue(await fetch(`/api/image-studio/style-groups?page=1&keys=${draft.id}`, { cache: 'no-store' }));
            const value = result.groups.find((group: StudioStyleSummary) => group.id === draft.id);
            if (!value?.canReadContent) throw new Error('当前原组无法完整读取，草稿保持不变');
            if (generation === editSequence.current) setLatest(value);
          } catch (cause) { if (generation === editSequence.current) setError(cause instanceof Error ? cause.message : '读取失败'); }
        }}>查看最新版</button>}</p>}
        {latest && <details open><summary>当前已保存版本 · {latest.revision}</summary><strong>{latest.name}</strong><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{latest.note || '未填写整体备注'}</pre><StudioReferenceGrid items={latest.references || []} onChange={() => {}} onPreview={image => setPreview(image)} compact labels="style" disabled renderDetails={reference => <p>{reference.note || '未填写逐图备注'}</p>} /></details>}
        <div className={styles.resultActions}>{pending ? <button type="button" disabled={busy} onClick={() => void queryPending()}><RefreshCw size={16} />核对原操作</button> : <>
          <button type="button" disabled={busy || conflict || uploading || !draft.name.trim() || !draft.references.length} onClick={() => void save()}><Save size={16} />保存</button>
          <button type="button" className={styles.primary} disabled={busy || conflict || uploading || !draft.name.trim() || !draft.references.length || draft.disabled || selected.filter(item => item.id !== draft.id).reduce((sum, item) => sum + item.referenceCount, 0) + draft.references.length > maxReferences} onClick={() => void save(true)}><Save size={16} />保存并选用</button>
        </>}</div>
      </>}
      {preview?.originalUrl && <ZoomableImagePreview src={preview.originalUrl} thumbnailSrc={preview.thumbnailUrl || undefined} alt="风格参考图" title="风格参考图" previewKey={preview.id} onClose={() => setPreview(null)} />}
    </dialog>
    {picker && draft && <UploadedImagePicker open imageOnly portalContainer={editor.current} title="添加风格参考图" confirmLabel="添加到风格组" purpose="style-group" contextKey={`${userId}:style-group:${draft.id || noteFieldId}`}
      currentCount={draft.references.length} currentAssetIds={draft.references.flatMap(ref => ref.id ? [ref.id] : [])} maxSelection={MAX_REFERENCE_IMAGES - draft.references.length}
      onClose={() => setPicker(false)} onUploadFile={async (file, onProgress) => {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024) throw new Error('请使用 20MB 以内的 PNG、JPG 或 WebP 图片');
        setUploading(true); try { return await uploadFileAsAsset(file, { onProgress }); } finally { setUploading(false); }
      }}
      onConfirm={async (_ids, assets) => {
        const refs = (assets || []).filter(asset => asset.type === 'image').map(asset => ({ ...asset, note: '', available: true }));
        if (refs.length !== _ids.length || draft.references.length + refs.length > MAX_REFERENCE_IMAGES) throw new Error('选择图片数量无效');
        changeReferences([...draft.references, ...refs]);
      }} />}
  </div>)}</>;
});
