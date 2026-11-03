'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Plus, X } from 'lucide-react';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { worksRead } from '@/lib/works/client';
import type { WorkCard, WorkCollectionDTO, WorkCollectionPage } from '@/lib/works/types';
import type { WorkOperate } from './WorkActions';
import styles from './Works.module.css';

export function useWorkCollections(viewerId: string, revision: number) {
  const [collections, setCollections] = useState<WorkCollectionDTO[]>([]), [cursor, setCursor] = useState<string | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false), [retry, setRetry] = useState(0);
  const epoch = useRef(0), loadingRef = useRef(false);
  useEffect(() => {
    const token = ++epoch.current; setLoading(true); loadingRef.current = true; setError('');
    void worksRead<WorkCollectionPage>('/api/works/collections?limit=30', viewerId).then(data => { if (token === epoch.current) { setCollections(data.collections); setCursor(data.nextCursor); } }).catch(cause => { if (token === epoch.current) setError(cause instanceof Error ? cause.message : '集合读取未完成'); }).finally(() => { if (token === epoch.current) { setLoading(false); loadingRef.current = false; } });
    return () => { epoch.current++; };
  }, [viewerId, revision, retry]);
  async function more() {
    if (!cursor || loadingRef.current) return;
    const token = epoch.current; loadingRef.current = true; setLoading(true); setError('');
    try { const data = await worksRead<WorkCollectionPage>(`/api/works/collections?limit=30&cursor=${encodeURIComponent(cursor)}`, viewerId); if (token === epoch.current) { setCollections(old => [...old, ...data.collections.filter(item => !old.some(previous => previous.id === item.id))]); setCursor(data.nextCursor); } }
    catch (cause) { if (token === epoch.current) setError(cause instanceof Error ? cause.message : '集合读取未完成'); }
    finally { if (token === epoch.current) { loadingRef.current = false; setLoading(false); } }
  }
  return { collections, cursor, error, loading, more, retry: () => setRetry(value => value + 1) };
}
export type CollectionDirectory = ReturnType<typeof useWorkCollections>;
export function CollectionManager({ directory, selected, onSelect, operate, busy }: { directory: CollectionDirectory; selected?: string; onSelect: (id?: string) => void; operate: WorkOperate; busy: boolean }) {
  const [creating, setCreating] = useState(false), [name, setName] = useState(''), [editing, setEditing] = useState<WorkCollectionDTO | null>(null);
  async function save() {
    if (!name.trim()) return;
    const collection = editing;
    const result = await operate(collection ? `collection:${collection.id}` : 'collection:create', collection ? `/api/works/collections/${collection.id}` : '/api/works/collections', { name: name.trim(), expectedRevision: collection?.revision || 0 }, collection ? 'PATCH' : 'POST');
    if (result) { setCreating(false); setEditing(null); setName(''); }
  }
  return <aside className={styles.collectionPanel} aria-label="我的收藏集合"><div className={styles.panelHeading}><h2>我的集合</h2><button type="button" aria-label="新建集合" disabled={busy} onClick={() => { setCreating(true); setEditing(null); setName(''); }}><Plus size={17} /></button></div>
    <button type="button" className={styles.collectionChoice} aria-pressed={!selected} onClick={() => onSelect()}>全部收藏</button>
    {directory.collections.map(collection => <div key={collection.id} className={styles.collectionRow}><button type="button" className={styles.collectionChoice} aria-pressed={selected === collection.id} onClick={() => onSelect(collection.id)}>{collection.name}</button><details><summary aria-label={`管理集合：${collection.name}`}>···</summary><div><button type="button" disabled={busy} onClick={() => { setEditing(collection); setCreating(true); setName(collection.name); }}>改名</button><button type="button" disabled={busy} onClick={() => void operate(`collection:${collection.id}`, `/api/works/collections/${collection.id}`, { expectedRevision: collection.revision }, 'DELETE')}>删除集合</button><small>收藏的作品会保留</small></div></details></div>)}
    {creating && <form className={styles.inlineForm} onSubmit={event => { event.preventDefault(); void save(); }}><input aria-label={editing ? '集合新名称' : '集合名称'} value={name} maxLength={60} autoFocus onChange={event => setName(event.target.value)} /><button type="submit" disabled={busy || !name.trim()}>保存</button><button type="button" onClick={() => setCreating(false)}>取消</button></form>}
    {directory.error && <p role="status">{directory.error}<button type="button" onClick={directory.retry}>重试读取</button></p>}
    {directory.loading && <p className={styles.muted}>正在读取集合…</p>}
    {directory.cursor && <button type="button" disabled={directory.loading} onClick={() => void directory.more()}>更多集合</button>}
    {!directory.loading && !directory.error && !directory.collections.length && <p className={styles.muted}>先收藏喜欢的作品，再按需创建集合。</p>}
  </aside>;
}
export function ClassifyWork({ work, directory, operate, busy, onClose }: { work: WorkCard; directory: CollectionDirectory; operate: WorkOperate; busy: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null), surface = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
  const [creating, setCreating] = useState(false), [name, setName] = useState('');
  useDialogDismiss({ open: true, dialogRef: dialog, dismissSurfaceRef: surface, onDismiss: onClose });
  return createPortal(<div ref={surface} className={styles.backdrop}><div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="work-classify-title" className={styles.smallDialog}><header className={styles.detailHeader}><h2 id="work-classify-title">归类到我的集合</h2><button type="button" onClick={onClose} aria-label="关闭归类"><X size={20} /></button></header><div className={styles.dialogBody}>
    <p className={styles.muted}>已保留在全部收藏中，移出集合不会取消收藏。</p>
    <div className={styles.collectionList}>{directory.collections.map(collection => { const active = work.collectionIds.includes(collection.id); return <button key={collection.id} type="button" aria-pressed={active} disabled={busy} onClick={() => void operate(`work:${work.id}`, `/api/works/collections/${collection.id}/membership`, active ? { workId: work.id, expectedRevision: collection.revision } : { workId: work.id, expectedRevision: collection.revision, expectedStateVersion: work.personal.version, expectedMediaVersion: work.mediaVersion }, active ? 'DELETE' : 'POST')}><span>{collection.name}</span>{active && <Check size={17} />}</button>; })}</div>
    {directory.error && <p role="status">{directory.error}<button type="button" onClick={directory.retry}>重试</button></p>}
    {directory.cursor && <button type="button" disabled={directory.loading} onClick={() => void directory.more()}>更多集合</button>}
    {!creating ? <button type="button" disabled={busy} onClick={() => { setCreating(true); requestAnimationFrame(() => input.current?.focus()); }}><Plus size={16} />新建集合</button> : <form className={styles.inlineForm} onSubmit={async event => { event.preventDefault(); if (!name.trim()) return; const result = await operate('collection:create', '/api/works/collections', { name: name.trim(), expectedRevision: 0 }); if (result) { setName(''); setCreating(false); } }}><input ref={input} aria-label="集合名称" maxLength={60} value={name} onChange={event => setName(event.target.value)} /><button type="submit" disabled={busy || !name.trim()}>创建</button></form>}
  </div></div></div>, document.body);
}
