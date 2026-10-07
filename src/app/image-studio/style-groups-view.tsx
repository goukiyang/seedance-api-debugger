'use client';

import { useProductDialog } from '@/components/useProductDialog';

import { useEffect, useId, useRef, useState } from 'react';
import { Combine, ImagePlus, Layers, Pencil, Plus, Save, Trash2, X } from 'lucide-react';
import { UploadedImagePicker } from '@/components/UploadedImagePicker';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { uploadFileAsAsset, type UploadedAssetPayload } from '@/lib/http/file-upload';
import { MAX_REFERENCE_IMAGES } from '@/lib/image-studio/limits';
import { StudioReferenceGrid, type FixedStudioReference } from './reference-grid';
import styles from './studio.module.css';

export type StudioStyleSummary = { id: string; name: string; revision?: number; coverUrl: string | null; canManage: boolean;
  referenceCount: number; references?: FixedStudioReference[]; coverAssetId?: string; note?: string; unavailable?: boolean };
type Draft = { id?: string; revision?: number; name: string; coverAssetId: string; note: string; references: FixedStudioReference[] };

async function responseValue(response: Response) {
  const value = await response.json().catch(() => { throw new Error('服务暂时无法响应'); });
  if (!response.ok) throw new Error(value.error || '风格组操作失败');
  return value;
}

export function StudioStyleGroups({ userId, selected, onChange, currentImages, disabled, tiles = false, maxReferences = MAX_REFERENCE_IMAGES }: {
  userId: string; selected: StudioStyleSummary[]; onChange: (groups: StudioStyleSummary[]) => void;
  currentImages: UploadedAssetPayload[]; disabled?: boolean; tiles?: boolean; maxReferences?: number;
}) {
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
  const noteFieldId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const editor = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const uploadLock = useRef(false);
  const request = useRef(0);
  const dirty = draft !== null && JSON.stringify(draft) !== savedDraft;

  useEffect(() => { if (open && !preview) dialog.current?.showModal(); else dialog.current?.close(); }, [open, preview]);
  useEffect(() => { if (draft && !preview) editor.current?.showModal(); else editor.current?.close(); }, [Boolean(draft), preview]);
  useEffect(() => () => { request.current += 1; }, [userId]);

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
    if (busy || uploading || picker || (dirty && !(await confirm('风格组尚未保存，放弃这次修改？', { title: '放弃修改', confirmLabel: '放弃修改' })))) return;
    setDraft(null); setError('');
  };
  useDialogDismiss({ open: open && !preview, dialogRef: dialog, nativeDialog: true, onDismiss: () => { if (!busy && !draft) setOpen(false); } });
  useDialogDismiss({ open: Boolean(draft) && !preview, dialogRef: editor, nativeDialog: true, onDismiss: closeEditor });
  function edit(group?: StudioStyleSummary) {
    if (group && !group.canManage) return;
    const refs = group ? group.references || [] : currentImages.map(image => ({ ...image, note: '', available: true }));
    const next: Draft = { ...(group ? { id: group.id, revision: group.revision } : {}), name: group?.name || '',
      coverAssetId: group?.coverAssetId || refs[0]?.id || '', note: group?.note || '', references: refs };
    setDraft(next); setSavedDraft(JSON.stringify(next)); setError('');
  }
  function reflect(group: StudioStyleSummary) {
    setGroups(existing => existing.some(item => item.id === group.id) ? existing.map(item => item.id === group.id ? group : item) : [group, ...existing]);
    if (selected.some(item => item.id === group.id)) onChange(selected.map(item => item.id === group.id ? group : item));
  }
  async function save() {
    if (!draft || busy || uploading) return;
    setBusy(true); setError('');
    try {
      const group = await responseValue(await fetch('/api/image-studio/style-groups', { method: draft.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...draft, references: draft.references.map(ref => ({ assetId: ref.id, note: ref.note || '' })) }) }));
      reflect(group); setDraft(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败'); }
    finally { setBusy(false); }
  }
  async function remove(group: StudioStyleSummary) {
    if (busy || !(await confirm(`删除风格组“${group.name}”？原始图片和生成记录保留，已选择该组的模板需要重新选择。`, { title: '删除风格组', confirmLabel: '删除风格组', danger: true }))) return;
    setBusy(true); setError('');
    try {
      await responseValue(await fetch('/api/image-studio/style-groups', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: group.id, revision: group.revision }) }));
      setGroups(existing => existing.filter(item => item.id !== group.id));
      setMergeIds(existing => existing.filter(id => id !== group.id));
      if (selected.some(item => item.id === group.id)) onChange(selected.filter(item => item.id !== group.id));
    } catch (cause) { setError(cause instanceof Error ? cause.message : '删除失败'); }
    finally { setBusy(false); }
  }
  async function merge() {
    const name = await prompt('合并后的风格组名称（原组会保留）', '合并风格', { title: '合并风格组', confirmLabel: '合并风格组', maxLength: 80 });
    if (!name?.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const group = await responseValue(await fetch('/api/image-studio/style-groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim(), references: [], mergeIds }) }));
      reflect(group); setMergeIds([]); edit(group);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '合并失败'); }
    finally { setBusy(false); }
  }
  async function upload(files: File[]) {
    if (!draft || uploadLock.current || uploading || busy || !files.length) return;
    if (draft.references.length + files.length > MAX_REFERENCE_IMAGES) { setError(`最多 ${MAX_REFERENCE_IMAGES} 张图片`); return; }
    uploadLock.current = true; setUploading(true); setError('');
    const added: FixedStudioReference[] = [];
    try {
      for (const file of files) {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024) throw new Error('请使用 20MB 以内的 JPG、PNG 或 WebP 图片');
        const asset = await uploadFileAsAsset(file);
        if (!asset.id || !asset.originalUrl) throw new Error('上传结果不完整，请重试');
        added.push({ ...asset, note: '', available: true });
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '上传失败'); }
    finally {
      if (added.length) setDraft(current => current ? { ...current, coverAssetId: current.coverAssetId || added[0].id || '', references: [...current.references, ...added] } : current);
      uploadLock.current = false; setUploading(false);
    }
  }
  function changeReferences(references: FixedStudioReference[]) {
    setDraft(current => current ? { ...current, references, coverAssetId: references.some(ref => ref.id === current.coverAssetId) ? current.coverAssetId : references[0]?.id || '' } : current);
  }
  const selectedCount = selected.reduce((total, group) => total + group.referenceCount, 0);
  const openSelector = () => { setOpen(true); void load(); };
  return <>{productDialog}{(<div className={tiles ? styles.styleGroupsTiles : styles.styleGroups}>
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
    <dialog ref={dialog} className={`${styles.dialog} ${styles.styleDialog}`} aria-label="风格组">
      <header className={styles.header}><h2>风格组</h2><button type="button" disabled={busy} aria-label="关闭风格组" onClick={() => setOpen(false)}><X size={20} /></button></header>
      <div className={styles.counts}><button type="button" disabled={busy} onClick={() => edit()}><Plus size={16} />新建</button>
        {mergeIds.length > 0 && <button type="button" disabled={busy || mergeIds.length < 2} onClick={() => void merge()}><Combine size={16} />合并 {mergeIds.length} 组</button>}
      </div>
      {loading && <p role="status">正在读取风格组…</p>}
      {!loading && !groups.length && !error && <p className={styles.muted}>暂无风格组</p>}
      {!draft && error && <p role="alert" className={styles.error}>{error}<button type="button" onClick={() => void load()}>重新读取</button></p>}
      <div className={styles.styleGrid}>{groups.map(group => {
        const used = selected.some(item => item.id === group.id);
        const exceedsLimit = !used && (selectedCount + group.referenceCount > maxReferences || selected.length >= MAX_REFERENCE_IMAGES);
        const selectionDisabled = Boolean(disabled || busy || exceedsLimit);
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
          {group.canManage && <div className={styles.styleActions} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
            <button type="button" disabled={busy} title="编辑风格组" aria-label={`编辑${group.name}`} onClick={() => edit(group)}><Pencil size={16} /></button>
              <button type="button" disabled={busy} title="删除风格组" aria-label={`删除${group.name}`} onClick={() => void remove(group)}><Trash2 size={16} /></button>
              <input type="checkbox" aria-label={`选择${group.name}用于合并`} checked={mergeIds.includes(group.id)} disabled={busy} onChange={event => setMergeIds(current => event.target.checked ? [...current, group.id] : current.filter(id => id !== group.id))} />
          </div>}
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
        <label className={styles.label}>封面<select value={draft.coverAssetId} disabled={busy} onChange={event => setDraft(current => current ? { ...current, coverAssetId: event.target.value } : current)}>
          {!draft.references.length && <option value="">请先添加图片</option>}{draft.references.map((ref, index) => <option key={`${ref.id}-${index}`} value={ref.id}>风格 {index + 1}</option>)}
        </select></label>
        <div onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void upload(Array.from(event.dataTransfer.files)); }}>
          <StudioReferenceGrid items={draft.references} onChange={changeReferences} onPreview={image => setPreview(image)} compact labels="style" notes disabled={busy || uploading} />
        </div>
        <div className={styles.counts}><button type="button" disabled={busy || uploading || draft.references.length >= MAX_REFERENCE_IMAGES} onClick={() => input.current?.click()}><ImagePlus size={16} />上传图片</button>
          <button type="button" disabled={busy || uploading || draft.references.length >= MAX_REFERENCE_IMAGES} onClick={() => setPicker(true)}><Plus size={16} />从资产库选择</button></div>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={event => { void upload(Array.from(event.target.files || [])); event.target.value = ''; }} />
        {uploading && <p role="status">正在上传图片…</p>}
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <div className={styles.resultActions}><button type="button" className={styles.primary} disabled={busy || uploading || !draft.name.trim() || !draft.references.length || !dirty} onClick={() => void save()}><Save size={16} />{busy ? '正在保存' : '保存风格组'}</button></div>
      </>}
    </dialog>
    {picker && draft && <UploadedImagePicker open imageOnly portalContainer={editor.current} title="添加风格参考图" confirmLabel="添加到风格组" purpose="style-group"
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
    {preview?.originalUrl && <ZoomableImagePreview src={preview.originalUrl} alt="风格参考图" title="风格参考图" previewKey={preview.id} onClose={() => setPreview(null)} />}
  </div>)}</>;
}
