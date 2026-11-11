'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Check, ChevronDown, Copy, Image as ImageIcon, Plus, RefreshCw, Upload, UsersRound, X } from 'lucide-react';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { uploadFileToHistory, type UploadProgressSnapshot } from '@/lib/http/file-upload';
import { subscribeUploadSession, uploadSession } from '@/lib/http/upload-session';
import type { CharacterAssetDTO } from '@/lib/character-assets/types';
import { normalizeArkAssetId } from '@/lib/character-assets/inputs';
import './character-assets.css';

type CharacterForm = {
  name: string; assetId: string; groupId: string; projectName: string; notes: string;
  thumbnailReferenceImageId: string; revision?: number;
};
type ThumbnailOption = { id: string; name: string; thumbnailUrl: string | null };
type ThumbnailUpload = {
  owner: string; epoch: number; operation: number; file: File; assetId?: string;
  referenceImageId?: string; thumbnailUrl?: string;
  phase: 'uploading' | 'registering' | 'preparing' | 'ready' | 'failed';
  progress?: UploadProgressSnapshot; error?: string; options: ThumbnailOption[];
};
function CharacterThumbnail({ src, emptyLabel = '未设置缩略图' }: { src: string | null | undefined; emptyLabel?: string }) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  return src && failedSource !== src
    ? <img src={src} alt="" loading="lazy" onError={() => setFailedSource(src)} />
    : <span className="character-assets-image-placeholder"><ImageIcon size={24} aria-hidden="true" /><span>{src ? '缩略图暂不可用' : emptyLabel}</span></span>;
}

const emptyForm = (): CharacterForm => ({ name: '', assetId: '', groupId: '', projectName: '', notes: '', thumbnailReferenceImageId: '' });
const formFor = (asset: CharacterAssetDTO): CharacterForm => ({ name: asset.name, assetId: asset.assetId,
  groupId: asset.groupId || '', projectName: asset.projectName || '', notes: asset.notes || '',
  thumbnailReferenceImageId: asset.thumbnailReferenceImageId || '', revision: asset.revision });

export function useCharacterAssetDirectory(ownerId: string | null, enabled: boolean) {
  const [state, setState] = useState<{ owner: string | null; assets: CharacterAssetDTO[]; ready: boolean; error: string | null; loading: boolean }>(
    { owner: null, assets: [], ready: false, error: null, loading: false });
  const ownerRef = useRef(ownerId); ownerRef.current = ownerId;
  const readRevision = useRef(0);
  const request = useCallback(async (path = '', method = 'GET', body?: object, signal?: AbortSignal) => {
    const session = uploadSession();
    if (!ownerId || session.ownerId !== ownerId) throw new Error('账号尚未确认，请稍候重试。');
    const response = await fetch(`/api/character-assets${path}`, { method, cache: 'no-store', signal,
      headers: { 'Content-Type': 'application/json', 'x-app-session-user': ownerId }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (ownerRef.current !== ownerId || uploadSession().epoch !== session.epoch || uploadSession().ownerId !== ownerId) throw new Error('账号已变化，未应用角色目录结果。');
    if (!response.ok) throw new Error(`${data.error || '角色资产操作失败'}${response.status === 409 ? '。输入已保留，请重读记录后核对。' : ''}`);
    return data;
  }, [ownerId]);
  const refresh = useCallback(async () => {
    if (!ownerId || !enabled) return;
    const revision = ++readRevision.current;
    setState(current => ({ ...current, owner: ownerId, loading: true, error: null }));
    try {
      const data = await request('?includeDeleted=1');
      if (!Array.isArray(data.assets)) throw new Error('角色目录返回内容无法读取。');
      if (readRevision.current !== revision) return;
      setState({ owner: ownerId, assets: data.assets, ready: true, error: null, loading: false });
    } catch (cause) {
      if (ownerRef.current === ownerId && readRevision.current === revision) setState(current => ({ ...current, owner: ownerId,
        loading: false, error: cause instanceof Error ? cause.message : '角色目录暂不可用' }));
    }
  }, [ownerId, enabled, request]);
  useEffect(() => {
    setState({ owner: ownerId, assets: [], ready: false, error: null, loading: false });
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [ownerId, refresh]);
  return { assets: state.owner === ownerId ? state.assets : [], ready: state.owner === ownerId && state.ready,
    error: state.owner === ownerId ? state.error : null, loading: state.owner === ownerId && state.loading, refresh, request };
}

type Props = {
  ownerId: string | null;
  directory: ReturnType<typeof useCharacterAssetDirectory>;
  selectedIds: string[];
  disabled?: boolean;
  capacity: number;
  isIp: boolean;
  switchChoices: Array<{ id: string; label: string; disabled?: boolean; disabledReason?: string }>;
  thumbnails: ThumbnailOption[];
  onJoin: (asset: CharacterAssetDTO, targetChoice?: string) => void;
};

export function CharacterAssetPanel({ ownerId, directory, selectedIds, disabled, capacity, isIp, switchChoices, thumbnails, onJoin }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<CharacterForm>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [targetChoice, setTargetChoice] = useState('');
  const [position, setPosition] = useState({ left: 12, top: 60, maxHeight: 600 });
  const [thumbnailUploads, setThumbnailUploads] = useState<Record<string, ThumbnailUpload>>({});
  const thumbnailUploadsRef = useRef<Record<string, ThumbnailUpload>>({});
  const uploadOperation = useRef(0);
  const editorRevision = useRef(0);
  const editingRef = useRef(editing); editingRef.current = editing;
  const openRef = useRef(open); openRef.current = open;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadPickRef = useRef<{ owner: string; epoch: number; target: string; revision: number } | null>(null);
  const draftKey = ownerId && editing ? `sd2:character-form:v1:${JSON.stringify([ownerId, editing])}` : null;
  const ownerRef = useRef(ownerId); ownerRef.current = ownerId;
  useEffect(() => {
    editorRevision.current++; thumbnailUploadsRef.current = {}; setThumbnailUploads({});
    setOpen(false); setEditing(null); setForm(emptyForm()); setError(null); setNotice(null);
  }, [ownerId]);
  useEffect(() => {
    const unsubscribe = subscribeUploadSession(() => {
      editorRevision.current++; thumbnailUploadsRef.current = {}; setThumbnailUploads({});
    });
    return () => { unsubscribe(); editorRevision.current++; thumbnailUploadsRef.current = {}; };
  }, []);
  const close = useCallback(() => { editorRevision.current++; openRef.current = false; setOpen(false); }, []);
  useDialogDismiss({ open, dialogRef: panelRef, branchRefs: [triggerRef], layerSurfaceRef: panelRef,
    initialFocusRef: searchRef, modal: false, onDismiss: close });
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(460, window.innerWidth - 24);
      const height = Math.min(panelRef.current?.scrollHeight || 600, window.innerHeight - 24);
      const below = window.innerHeight - rect.bottom - 20;
      const top = below >= Math.min(height, 320) ? rect.bottom + 8 : Math.max(12, rect.top - height - 8);
      setPosition({ left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)), top,
        maxHeight: Math.max(0, window.innerHeight - top - 12) });
    };
    place();
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, editing, directory.assets.length]);
  useEffect(() => { if (open) panelRef.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true }); }, [open, editing]);
  useEffect(() => {
    if (!draftKey) return;
    try { localStorage.setItem(draftKey, JSON.stringify(form)); }
    catch { setError('本次编辑暂时无法记住，请保留面板。'); }
  }, [draftKey, form]);

  const beginEdit = (asset?: CharacterAssetDTO) => {
    const id = asset?.id || 'new', key = ownerId ? `sd2:character-form:v1:${JSON.stringify([ownerId, id])}` : '';
    let next = asset ? formFor(asset) : emptyForm();
    try {
      const saved = key && JSON.parse(localStorage.getItem(key) || 'null');
      if (saved && ['name', 'assetId', 'groupId', 'projectName', 'notes', 'thumbnailReferenceImageId'].every(field => typeof saved[field] === 'string')) next = saved;
    } catch { /* The current server record remains editable if local optional data is unavailable. */ }
    editorRevision.current++; editingRef.current = id;
    setForm(next); setEditing(id); setError(null); setNotice(null);
  };
  const thumbnailUpload = editing ? thumbnailUploads[editing] : undefined;
  const uploadingThumbnail = Boolean(thumbnailUpload && !['ready', 'failed'].includes(thumbnailUpload.phase));
  const returnToList = () => { if (busy || uploadingThumbnail) return; editorRevision.current++; editingRef.current = null; setEditing(null); };
  const prepareThumbnail = async (file?: File) => {
    const target = editingRef.current, owner = ownerId, session = uploadSession();
    if (!target || !owner || session.ownerId !== owner || busy) return;
    const previous = thumbnailUploadsRef.current[target];
    if (previous && !['ready', 'failed'].includes(previous.phase)) return;
    const source = file || previous?.file;
    if (!source) return;
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'].includes(source.type) || source.size <= 0 || source.size > 30 * 1024 * 1024) {
      setError('请选择非空且不超过 30MB 的 JPEG、PNG、GIF、WebP 或 BMP 图片。'); return;
    }
    const operation = ++uploadOperation.current, revision = editorRevision.current;
    let pending: ThumbnailUpload = file
      ? { owner, epoch: session.epoch, operation, file: source, phase: 'uploading', options: previous?.options || [] }
      : { ...previous!, operation, phase: previous?.assetId ? 'registering' : 'uploading', progress: undefined, error: undefined };
    const current = () => ownerRef.current === owner && uploadSession().ownerId === owner && uploadSession().epoch === session.epoch
      && thumbnailUploadsRef.current[target]?.operation === operation;
    const update = () => { thumbnailUploadsRef.current = { ...thumbnailUploadsRef.current, [target]: pending }; setThumbnailUploads(thumbnailUploadsRef.current); };
    update(); setError(null);
    try {
      if (!pending.assetId) {
        const uploaded = await uploadFileToHistory(source, { ownerId: owner, onProgress: progress => {
          if (!current()) return; pending = { ...pending, progress }; update();
        } });
        if (!current()) return;
        if (!uploaded.id) throw new Error('上传编号尚未确认，请继续核对原上传。');
        pending = { ...pending, assetId: uploaded.id, phase: 'registering', progress: undefined }; update();
      }
      if (!pending.referenceImageId || !pending.thumbnailUrl) {
        const registered = await directory.request('/thumbnail', 'POST', { assetId: pending.assetId }, AbortSignal.timeout(60_000));
        if (!current()) return;
        if (registered.assetId !== pending.assetId || typeof registered.referenceImageId !== 'string'
          || registered.thumbnailUrl !== `/api/reference-images/${encodeURIComponent(registered.referenceImageId)}/content?variant=thumbnail`) {
          throw new Error('缩略图登记结果无法确认，请重试准备缩略图。');
        }
        pending = { ...pending, referenceImageId: registered.referenceImageId, thumbnailUrl: registered.thumbnailUrl };
      }
      pending = { ...pending, phase: 'preparing' }; update();
      const image = new Image(); image.src = pending.thumbnailUrl!;
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(() => { image.src = ''; reject(new Error('缩略图读取超时')); }, 30_000);
          image.decode().then(() => { window.clearTimeout(timer); resolve(); }, cause => { window.clearTimeout(timer); reject(cause); });
        });
      }
      catch { throw new Error('缩略图暂时无法读取，原封面和上传素材已保留，请重试。'); }
      if (!current()) return;
      const referenceImageId = pending.referenceImageId!, thumbnailUrl = pending.thumbnailUrl!;
      pending = { ...pending, phase: 'ready', options: [{ id: referenceImageId, name: source.name, thumbnailUrl },
        ...pending.options.filter(item => item.id !== referenceImageId)] }; update();
      if (openRef.current && editingRef.current === target && editorRevision.current === revision) {
        setForm(value => ({ ...value, thumbnailReferenceImageId: referenceImageId }));
      }
    } catch (cause) {
      if (current()) {
        const message = cause instanceof Error && ['TimeoutError', 'AbortError'].includes(cause.name)
          ? '缩略图登记暂未确认，上传素材和输入已保留，请重试准备缩略图。'
          : cause instanceof Error ? cause.message : '缩略图暂未准备成功，输入已保留。';
        pending = { ...pending, phase: 'failed', error: message }; update();
      }
    }
  };
  const mutate = async (path: string, method: string, body: object, message: string) => {
    const owner = ownerId;
    setBusy(true); setError(null);
    try {
      const result = await directory.request(path, method, body);
      if (ownerRef.current !== owner) return null;
      await directory.refresh(); setNotice(message); return result.asset as CharacterAssetDTO;
    } catch (cause) { if (ownerRef.current === owner) setError(cause instanceof Error ? cause.message : '操作失败，输入已保留'); return null; }
    finally { if (ownerRef.current === owner) setBusy(false); }
  };
  const save = async () => {
    if (busy || uploadingThumbnail) return;
    let assetId: string;
    try { assetId = normalizeArkAssetId(form.assetId); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Asset ID 无效'); return; }
    if (!form.name.trim()) { setError('请填写角色名称。'); return; }
    const saved = await mutate(editing === 'new' ? '' : `/${encodeURIComponent(editing || '')}`, editing === 'new' ? 'POST' : 'PATCH', {
      ...form, name: form.name.trim(), assetId, groupId: form.groupId.trim() || null,
      projectName: form.projectName.trim() || null, notes: form.notes.trim() || null,
      thumbnailReferenceImageId: form.thumbnailReferenceImageId || null,
    }, '角色登记已保存');
    if (saved) {
      if (draftKey) { try { localStorage.removeItem(draftKey); } catch { /* Saved record is authoritative. */ } }
      if (editing) {
        const pending = thumbnailUploadsRef.current[editing], remaining = { ...thumbnailUploadsRef.current };
        delete remaining[editing];
        if (pending?.phase === 'failed') remaining[saved.id] = pending;
        thumbnailUploadsRef.current = remaining; setThumbnailUploads(remaining);
      }
      editorRevision.current++; editingRef.current = null; setEditing(null);
    }
  };
  const items = directory.assets.filter(asset => `${asset.name} ${asset.assetId}`.toLowerCase().includes(query.trim().toLowerCase()));
  const activeChoice = switchChoices.find(choice => choice.id === targetChoice);
  const currentRecord = directory.assets.find(asset => asset.id === editing);
  const availableThumbnails = [...(thumbnailUpload?.options || []), ...thumbnails.filter(item => !thumbnailUpload?.options.some(option => option.id === item.id))];
  const thumbnailOptions = form.thumbnailReferenceImageId && !availableThumbnails.some(item => item.id === form.thumbnailReferenceImageId)
    ? [{ id: form.thumbnailReferenceImageId, name: '当前缩略图', thumbnailUrl: currentRecord?.thumbnailReferenceImageId === form.thumbnailReferenceImageId
      ? currentRecord.thumbnailUrl : `/api/reference-images/${encodeURIComponent(form.thumbnailReferenceImageId)}/content?variant=thumbnail` }, ...availableThumbnails]
    : availableThumbnails;
  return <>
    <button type="button" ref={triggerRef} className="character-assets-trigger" aria-haspopup="dialog" aria-expanded={open}
      disabled={!ownerId} onClick={() => { if (open) close(); else { openRef.current = true; setOpen(true); void directory.refresh(); } }}><UsersRound size={15} />角色资产<ChevronDown size={12} aria-hidden="true" /></button>
    {open && createPortal(<div ref={panelRef} className="character-assets-panel" role="dialog" aria-label="角色资产" tabIndex={-1}
      style={{ left: position.left, top: position.top, maxHeight: position.maxHeight }}>
      <header><div>{editing && <button type="button" className="btn-icon" aria-label="返回角色列表" disabled={busy || uploadingThumbnail} onClick={returnToList}><ArrowLeft size={16} /></button>}
        <strong>{editing ? editing === 'new' ? '新增角色' : '编辑角色' : '角色资产'}</strong></div>
        <button type="button" className="btn-icon" aria-label="关闭角色资产" onClick={close}><X size={17} /></button></header>
      {editing ? <form onSubmit={event => { event.preventDefault(); void save(); }} className="character-assets-form">
        <label>角色名称<input value={form.name} maxLength={120} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} required /></label>
        <label>Asset ID<input value={form.assetId} maxLength={264} onChange={event => setForm(current => ({ ...current, assetId: event.target.value }))} placeholder="asset-… 或 asset://asset-…" required /></label>
        <fieldset className="character-assets-thumbnail-picker" disabled={busy || uploadingThumbnail}>
          <legend>缩略图</legend>
          <div className="character-assets-thumbnail-upload">
            <input ref={uploadInputRef} type="file" hidden accept="image/jpeg,image/png,image/gif,image/webp,image/bmp"
              onChange={event => {
                const file = event.target.files?.[0], picked = uploadPickRef.current, session = uploadSession();
                event.target.value = ''; uploadPickRef.current = null;
                if (file && picked && ownerRef.current === picked.owner && session.ownerId === picked.owner && session.epoch === picked.epoch
                  && editingRef.current === picked.target && editorRevision.current === picked.revision && openRef.current) void prepareThumbnail(file);
              }} />
            <button type="button" className="btn-secondary" disabled={thumbnailUpload?.phase === 'failed' && !thumbnailUpload.assetId} onClick={() => {
              const session = uploadSession();
              if (!ownerId || session.ownerId !== ownerId || !editing) return;
              uploadPickRef.current = { owner: ownerId, epoch: session.epoch, target: editing, revision: editorRevision.current };
              uploadInputRef.current?.click();
            }}><Upload size={14} />{form.thumbnailReferenceImageId ? '上传 / 更换图片' : '上传图片'}</button>
            <small>JPEG / PNG / GIF / WebP / BMP，30MB 以内</small>
          </div>
          {thumbnailUpload && <div className="character-assets-thumbnail-upload-status" role={thumbnailUpload.phase === 'failed' ? 'alert' : 'status'}>
            <span className="character-assets-upload-name">{thumbnailUpload.file.name}</span>
            <span>{thumbnailUpload.phase === 'failed' ? thumbnailUpload.error : thumbnailUpload.phase === 'registering' ? '正在登记缩略图…'
              : thumbnailUpload.phase === 'preparing' ? '正在准备缩略图…' : thumbnailUpload.phase === 'ready'
                ? form.thumbnailReferenceImageId === thumbnailUpload.referenceImageId ? '缩略图已就绪，保存登记后生效。' : '缩略图已就绪，请按图选择。'
              : `${thumbnailUpload.progress?.label || '正在准备上传…'}${thumbnailUpload.progress?.percent != null ? ` ${thumbnailUpload.progress.percent}%` : ''}`}</span>
            {thumbnailUpload.phase === 'uploading' && <progress aria-label="图片上传进度" max={100} value={thumbnailUpload.progress?.percent} />}
            {thumbnailUpload.phase === 'failed' && <button type="button" className="btn-secondary" onClick={() => void prepareThumbnail()}>{thumbnailUpload.assetId ? '重试准备缩略图' : '继续核对原上传'}</button>}
          </div>}
          <div className="character-assets-thumbnail-options">
            <button type="button" className="character-assets-thumbnail-option" aria-pressed={!form.thumbnailReferenceImageId}
              onClick={() => setForm(current => ({ ...current, thumbnailReferenceImageId: '' }))}>
              <span className="character-assets-image"><CharacterThumbnail src={null} emptyLabel="无缩略图" /></span><span>不设置</span>
            </button>
            {thumbnailOptions.map(item => <button key={item.id} type="button" className="character-assets-thumbnail-option"
              aria-pressed={form.thumbnailReferenceImageId === item.id} aria-label={`选择${item.name}作为缩略图`}
              onClick={() => setForm(current => ({ ...current, thumbnailReferenceImageId: item.id }))}>
              <span className="character-assets-image"><CharacterThumbnail key={item.id} src={item.thumbnailUrl} emptyLabel="暂无缩略图" /></span>
              <span>{item.name}</span>{form.thumbnailReferenceImageId === item.id && <Check className="character-assets-selected-check" size={15} aria-hidden="true" />}
            </button>)}
          </div>
          <small>也可从本次站内图片按图选择。上传图片留在本人素材历史，保存登记后仅作识别封面。</small>
        </fieldset>
        <details><summary>分组、项目与备注</summary><label>Group ID<input value={form.groupId} maxLength={264} onChange={event => setForm(current => ({ ...current, groupId: event.target.value }))} /></label>
          <label>Ark ProjectName<input value={form.projectName} maxLength={120} onChange={event => setForm(current => ({ ...current, projectName: event.target.value }))} placeholder="未知可留空" /></label>
          <label>备注<textarea value={form.notes} maxLength={2000} onChange={event => setForm(current => ({ ...current, notes: event.target.value }))} rows={3} /></label></details>
        {currentRecord && form.revision !== currentRecord.revision && <p className="character-assets-error">记录已有新版本，本次输入已保留。<button type="button" disabled={busy || uploadingThumbnail} onClick={() => setForm(formFor(currentRecord))}>重读记录</button></p>}
        {(error || directory.error) && <p className="character-assets-error" role="alert">{error || directory.error}
          {currentRecord && <button type="button" onClick={() => { void directory.refresh(); }}>刷新记录</button>}</p>}
        <footer><button type="button" className="btn-secondary" disabled={busy || uploadingThumbnail} onClick={returnToList}>返回</button><button type="submit" className="btn-primary" disabled={busy || uploadingThumbnail || Boolean(currentRecord && form.revision !== currentRecord.revision)}>{busy ? '正在保存…' : '保存登记'}</button></footer>
      </form> : <>
        <div className="character-assets-search"><input ref={searchRef} aria-label="搜索角色名称或 Asset ID" placeholder="搜索名称或 Asset ID" value={query} onChange={event => setQuery(event.target.value)} />
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => beginEdit()}><Plus size={14} />新增</button>
          <button type="button" className="btn-icon" aria-label="刷新角色目录" disabled={directory.loading} onClick={() => void directory.refresh()}><RefreshCw size={15} /></button></div>
        {!isIp && <div className="character-assets-route"><label>使用线路<select aria-label="使用角色的 IP 模型" value={targetChoice} onChange={event => setTargetChoice(event.target.value)}><option value="">选择 IP 型号</option>{switchChoices.map(choice => <option key={choice.id} value={choice.id} disabled={choice.disabled}>{choice.label}{choice.disabled ? '（不可用）' : ''}</option>)}</select></label></div>}
        {(error || directory.error) && <p className="character-assets-error" role="alert">{error || directory.error}</p>}
        {notice && <p className="character-assets-notice" role="status">{notice}</p>}
        {!directory.ready && directory.loading ? <p className="character-assets-empty">正在读取角色目录…</p> : !directory.ready ? <p className="character-assets-empty">目录尚未读取成功，请刷新重试。</p> : !items.length ? <p className="character-assets-empty">{query ? '没有匹配的角色' : '登记已有 Asset ID，之后可直接加入本次。'}</p> : <ul className="character-assets-list">{items.map(asset => {
          const selected = selectedIds.includes(asset.id);
          const joinDisabled = busy || disabled || Boolean(asset.deletedAt) || !asset.enabled || (!selected && capacity <= 0)
            || (selected && isIp) || !isIp && (!activeChoice || activeChoice.disabled);
          const joinLabel = asset.deletedAt ? '已删除' : !asset.enabled ? '已停用' : selected && isIp ? '已加入' : isIp ? '加入本次' : '切换 IP 线路并使用';
          const joinReason = asset.deletedAt ? '恢复记录后再选择' : !asset.enabled ? '启用记录后再选择'
            : !selected && capacity <= 0 ? '图片与角色已达到当前型号参考上限' : !isIp && !activeChoice ? '先明确选择 IP 型号' : activeChoice?.disabledReason;
          return <li key={asset.id}>
            <button type="button" className="character-assets-choice" aria-pressed={selected} aria-label={`${asset.name}：${joinLabel}`}
              disabled={joinDisabled} title={joinReason} onClick={() => { onJoin(asset, isIp ? undefined : targetChoice); if (isIp) setOpen(false); }}>
              <span className="character-assets-image"><CharacterThumbnail key={asset.id} src={asset.thumbnailUrl} />
                {selected && <span className="character-assets-selected-check"><Check size={15} aria-hidden="true" /></span>}
              </span>
              <strong>{asset.name}</strong><span className="character-assets-choice-action">{joinLabel}</span>
            </button>
            {!asset.deletedAt && <button type="button" className="character-assets-cover-action" disabled={busy} onClick={() => beginEdit(asset)}>{asset.thumbnailUrl ? '更换缩略图' : '设置缩略图'}</button>}
            <details className="character-assets-meta"><summary>管理</summary><div className="character-assets-id"><code>{asset.assetId}</code><button type="button" className="btn-icon" aria-label={`复制 ${asset.name} 的 Asset ID`} onClick={() => { void navigator.clipboard.writeText(asset.assetId).then(() => setNotice('Asset ID 已复制'), () => setError('复制失败，请手动选择 ID 复制。')); }}><Copy size={13} /></button></div>
              <small>上游状态未核验{asset.groupId ? ` · ${asset.groupId}` : ''}{asset.projectName ? ` · ${asset.projectName}` : ''}</small>{asset.notes && <p>{asset.notes}</p>}
              <div className="character-assets-management">{asset.deletedAt
                ? <button type="button" disabled={busy} onClick={() => void mutate(`/${encodeURIComponent(asset.id)}`, 'PATCH', { revision: asset.revision, restore: true }, '记录已恢复，请重新选择所需版本')}>恢复记录</button>
                : <><button type="button" disabled={busy} onClick={() => beginEdit(asset)}>编辑</button><button type="button" disabled={busy} onClick={() => void mutate(`/${encodeURIComponent(asset.id)}`, 'PATCH', { revision: asset.revision, enabled: !asset.enabled }, asset.enabled ? '记录已停用' : '记录已启用')}>{asset.enabled ? '停用' : '启用'}</button>
                  <button type="button" disabled={busy} onClick={() => void mutate(`/${encodeURIComponent(asset.id)}`, 'DELETE', { revision: asset.revision }, '记录已删除，可在列表中恢复')}>删除记录</button></>}
              </div>
            </details>
          </li>;
        })}</ul>}
      </>}
    </div>, document.body)}
  </>;
}
