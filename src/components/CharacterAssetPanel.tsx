'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Check, Copy, Image as ImageIcon, Plus, RefreshCw, UsersRound, X } from 'lucide-react';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { uploadSession } from '@/lib/http/upload-session';
import type { CharacterAssetDTO } from '@/lib/character-assets/types';
import { normalizeArkAssetId } from '@/lib/character-assets/inputs';
import './character-assets.css';

type CharacterForm = {
  name: string; assetId: string; groupId: string; projectName: string; notes: string;
  thumbnailReferenceImageId: string; revision?: number;
};
const emptyForm = (): CharacterForm => ({ name: '', assetId: '', groupId: '', projectName: '', notes: '', thumbnailReferenceImageId: '' });
const formFor = (asset: CharacterAssetDTO): CharacterForm => ({ name: asset.name, assetId: asset.assetId,
  groupId: asset.groupId || '', projectName: asset.projectName || '', notes: asset.notes || '',
  thumbnailReferenceImageId: asset.thumbnailReferenceImageId || '', revision: asset.revision });

export function useCharacterAssetDirectory(ownerId: string | null, enabled: boolean) {
  const [state, setState] = useState<{ owner: string | null; assets: CharacterAssetDTO[]; ready: boolean; error: string | null; loading: boolean }>(
    { owner: null, assets: [], ready: false, error: null, loading: false });
  const ownerRef = useRef(ownerId); ownerRef.current = ownerId;
  const readRevision = useRef(0);
  const request = useCallback(async (path = '', method = 'GET', body?: object) => {
    const session = uploadSession();
    if (!ownerId || session.ownerId !== ownerId) throw new Error('账号尚未确认，请稍候重试。');
    const response = await fetch(`/api/character-assets${path}`, { method, cache: 'no-store',
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
  thumbnails: Array<{ id: string; name: string }>;
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const draftKey = ownerId && editing ? `sd2:character-form:v1:${JSON.stringify([ownerId, editing])}` : null;
  const ownerRef = useRef(ownerId); ownerRef.current = ownerId;
  useEffect(() => { setOpen(false); setEditing(null); setForm(emptyForm()); setError(null); setNotice(null); }, [ownerId]);
  const close = useCallback(() => setOpen(false), []);
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
    setForm(next); setEditing(id); setError(null); setNotice(null);
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
    let assetId: string;
    try { assetId = normalizeArkAssetId(form.assetId); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Asset ID 无效'); return; }
    if (!form.name.trim()) { setError('请填写角色名称。'); return; }
    const saved = await mutate(editing === 'new' ? '' : `/${encodeURIComponent(editing || '')}`, editing === 'new' ? 'POST' : 'PATCH', {
      ...form, name: form.name.trim(), assetId, groupId: form.groupId.trim() || null,
      projectName: form.projectName.trim() || null, notes: form.notes.trim() || null,
      thumbnailReferenceImageId: form.thumbnailReferenceImageId || null,
    }, '角色登记已保存');
    if (saved) { if (draftKey) { try { localStorage.removeItem(draftKey); } catch { /* Saved record is authoritative. */ } } setEditing(null); }
  };
  const items = directory.assets.filter(asset => `${asset.name} ${asset.assetId}`.toLowerCase().includes(query.trim().toLowerCase()));
  const activeChoice = switchChoices.find(choice => choice.id === targetChoice);
  const currentRecord = directory.assets.find(asset => asset.id === editing);
  return <>
    <button type="button" ref={triggerRef} className="character-assets-trigger" aria-haspopup="dialog" aria-expanded={open}
      disabled={!ownerId} onClick={() => { setOpen(current => !current); if (!open) void directory.refresh(); }}><UsersRound size={15} />角色资产</button>
    {open && createPortal(<div ref={panelRef} className="character-assets-panel" role="dialog" aria-label="角色资产" tabIndex={-1}
      style={{ left: position.left, top: position.top, maxHeight: position.maxHeight }}>
      <header><div>{editing && <button type="button" className="btn-icon" aria-label="返回角色列表" disabled={busy} onClick={() => setEditing(null)}><ArrowLeft size={16} /></button>}
        <strong>{editing ? editing === 'new' ? '新增角色' : '编辑角色' : '角色资产'}</strong></div>
        <button type="button" className="btn-icon" aria-label="关闭角色资产" onClick={close}><X size={17} /></button></header>
      {editing ? <form onSubmit={event => { event.preventDefault(); void save(); }} className="character-assets-form">
        <label>角色名称<input value={form.name} maxLength={120} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} required /></label>
        <label>Asset ID<input value={form.assetId} maxLength={264} onChange={event => setForm(current => ({ ...current, assetId: event.target.value }))} placeholder="asset-… 或 asset://asset-…" required /></label>
        <label>缩略图<select value={form.thumbnailReferenceImageId} onChange={event => setForm(current => ({ ...current, thumbnailReferenceImageId: event.target.value }))}>
          <option value="">无缩略图</option>{form.thumbnailReferenceImageId && !thumbnails.some(item => item.id === form.thumbnailReferenceImageId)
            && <option value={form.thumbnailReferenceImageId}>保留当前缩略图</option>}
          {thumbnails.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><small>可选本次素材中的站内图片，仅作识别封面。</small></label>
        <details><summary>分组、项目与备注</summary><label>Group ID<input value={form.groupId} maxLength={264} onChange={event => setForm(current => ({ ...current, groupId: event.target.value }))} /></label>
          <label>Ark ProjectName<input value={form.projectName} maxLength={120} onChange={event => setForm(current => ({ ...current, projectName: event.target.value }))} placeholder="未知可留空" /></label>
          <label>备注<textarea value={form.notes} maxLength={2000} onChange={event => setForm(current => ({ ...current, notes: event.target.value }))} rows={3} /></label></details>
        {currentRecord && form.revision !== currentRecord.revision && <p className="character-assets-error">记录已有新版本，本次输入已保留。<button type="button" onClick={() => setForm(formFor(currentRecord))}>重读记录</button></p>}
        {(error || directory.error) && <p className="character-assets-error" role="alert">{error || directory.error}
          {currentRecord && <button type="button" onClick={() => { void directory.refresh(); }}>刷新记录</button>}</p>}
        <footer><button type="button" className="btn-secondary" disabled={busy} onClick={() => setEditing(null)}>返回</button><button type="submit" className="btn-primary" disabled={busy || Boolean(currentRecord && form.revision !== currentRecord.revision)}>{busy ? '正在保存…' : '保存登记'}</button></footer>
      </form> : <>
        <div className="character-assets-search"><input ref={searchRef} aria-label="搜索角色名称或 Asset ID" placeholder="搜索名称或 Asset ID" value={query} onChange={event => setQuery(event.target.value)} />
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => beginEdit()}><Plus size={14} />新增</button>
          <button type="button" className="btn-icon" aria-label="刷新角色目录" disabled={directory.loading} onClick={() => void directory.refresh()}><RefreshCw size={15} /></button></div>
        {!isIp && <div className="character-assets-route"><label>使用线路<select aria-label="使用角色的 IP 模型" value={targetChoice} onChange={event => setTargetChoice(event.target.value)}><option value="">选择 IP 型号</option>{switchChoices.map(choice => <option key={choice.id} value={choice.id} disabled={choice.disabled}>{choice.label}{choice.disabled ? '（不可用）' : ''}</option>)}</select></label></div>}
        {(error || directory.error) && <p className="character-assets-error" role="alert">{error || directory.error}</p>}
        {notice && <p className="character-assets-notice" role="status">{notice}</p>}
        {!directory.ready && directory.loading ? <p className="character-assets-empty">正在读取角色目录…</p> : !directory.ready ? <p className="character-assets-empty">目录尚未读取成功，请刷新重试。</p> : !items.length ? <p className="character-assets-empty">{query ? '没有匹配的角色' : '登记已有 Asset ID，之后可直接加入本次。'}</p> : <ul className="character-assets-list">{items.map(asset => {
          const selected = selectedIds.includes(asset.id);
          return <li key={asset.id}><div className="character-assets-row"><div className="character-assets-avatar">{asset.thumbnailUrl ? <img src={asset.thumbnailUrl} alt="" /> : <ImageIcon size={22} />}</div>
            <div className="character-assets-name"><strong>{asset.name}</strong><small>{asset.deletedAt ? '已删除' : !asset.enabled ? '已停用' : '未核验'}</small></div>
            {asset.deletedAt ? <button type="button" className="btn-secondary" disabled={busy} onClick={() => void mutate(`/${encodeURIComponent(asset.id)}`, 'PATCH', { revision: asset.revision, restore: true }, '记录已恢复，请重新选择所需版本')}>恢复</button>
              : <button type="button" className="btn-secondary" disabled={disabled || !asset.enabled || (!selected && capacity <= 0) || (selected && isIp) || !isIp && (!activeChoice || activeChoice.disabled)}
                title={!selected && capacity <= 0 ? '图片与角色已达到当前型号参考上限' : !isIp && !activeChoice ? '先明确选择 IP 型号' : activeChoice?.disabledReason}
                onClick={() => { onJoin(asset, isIp ? undefined : targetChoice); if (isIp) setOpen(false); }}>{selected && isIp ? <><Check size={13} />已加入</> : isIp ? '加入本次' : '切换 IP 线路并使用'}</button>}
          </div><details className="character-assets-meta"><summary>详情与管理</summary><div className="character-assets-id"><code>{asset.assetId}</code><button type="button" className="btn-icon" aria-label={`复制 ${asset.name} 的 Asset ID`} onClick={() => { void navigator.clipboard.writeText(asset.assetId).then(() => setNotice('Asset ID 已复制'), () => setError('复制失败，请手动选择 ID 复制。')); }}><Copy size={13} /></button></div>
            <small>上游状态未核验{asset.groupId ? ` · ${asset.groupId}` : ''}{asset.projectName ? ` · ${asset.projectName}` : ''}</small>{asset.notes && <p>{asset.notes}</p>}
            {!asset.deletedAt && <div className="character-assets-management"><button type="button" disabled={busy} onClick={() => beginEdit(asset)}>编辑</button><button type="button" disabled={busy} onClick={() => void mutate(`/${encodeURIComponent(asset.id)}`, 'PATCH', { revision: asset.revision, enabled: !asset.enabled }, asset.enabled ? '记录已停用' : '记录已启用')}>{asset.enabled ? '停用' : '启用'}</button>
              <button type="button" disabled={busy} onClick={() => void mutate(`/${encodeURIComponent(asset.id)}`, 'DELETE', { revision: asset.revision }, '记录已删除，可在列表中恢复')}>删除记录</button></div>}</details></li>;
        })}</ul>}
      </>}
    </div>, document.body)}
  </>;
}
