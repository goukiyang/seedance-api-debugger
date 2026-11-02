'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { worksRead } from '@/lib/works/client';
import styles from './Works.module.css';

type FilterItem = { id: string; name: string };
type FilterPage = { viewerId: string; items: FilterItem[]; nextCursor: string | null };
export function WorkFilterPicker({ viewerId, kind, value, label, onSelect }: {
  viewerId: string; kind: 'authors' | 'projects'; value?: string; label?: string; onSelect: (id?: string, name?: string) => void;
}) {
  const noun = kind === 'authors' ? '作者' : '项目', id = useId();
  const [open, setOpen] = useState(false), [search, setSearch] = useState(''), [term, setTerm] = useState(''), [items, setItems] = useState<FilterItem[]>([]), [cursor, setCursor] = useState<string | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false), [retry, setRetry] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), epoch = useRef(0), locked = useRef(false), request = useRef<AbortController | null>(null), failedCursor = useRef<string | null>(null);
  useDialogDismiss({ open, dialogRef: panel, branchRefs: [trigger], initialFocusRef: input, modal: false, onDismiss: () => setOpen(false) });
  const load = useCallback(async (after: string | null, token: number) => {
    if (locked.current) return; locked.current = true; setLoading(true); setError(''); failedCursor.current = after;
    const controller = new AbortController(); request.current = controller;
    const params = new URLSearchParams({ kind, q: term, limit: '20' }); if (after) params.set('after', after);
    try {
      const data = await worksRead<FilterPage>(`/api/works/filters?${params}`, viewerId, controller.signal);
      if (controller.signal.aborted || token !== epoch.current) return;
      setItems(old => after ? [...old, ...data.items.filter(item => !old.some(previous => previous.id === item.id))].slice(-100) : data.items); setCursor(data.nextCursor);
    } catch (cause) { if (!controller.signal.aborted && token === epoch.current) setError(cause instanceof Error ? cause.message : `${noun}读取未完成`); }
    finally { if (token === epoch.current) { locked.current = false; setLoading(false); } }
  }, [kind, noun, term, viewerId]);
  useEffect(() => {
    const token = ++epoch.current; request.current?.abort(); locked.current = false;
    if (open) { setItems([]); setCursor(null); void load(null, token); }
    return () => { epoch.current++; request.current?.abort(); };
  }, [open, load, retry]);
  return <div className={styles.filterPicker}>
    <button ref={trigger} type="button" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(current => !current)}>{value ? label || `已选${noun}` : `全部${noun}`}<ChevronDown size={14} /></button>
    {open && <div ref={panel} id={id} className={styles.filterPanel} role="dialog" aria-label={`筛选${noun}`}>
      <form className={styles.filterSearch} onSubmit={event => { event.preventDefault(); const next = search.trim(); if (next === term) setRetry(current => current + 1); else setTerm(next); }}><Search size={15} /><input ref={input} type="search" aria-label={`搜索${noun}名称`} placeholder={`搜索${noun}`} value={search} maxLength={80} onChange={event => setSearch(event.target.value)} /><button type="submit">查找</button></form>
      <div className={styles.filterOptions} role="listbox" aria-label={`${noun}选项`}><button type="button" role="option" aria-selected={!value} onClick={() => { onSelect(); setOpen(false); }}>全部{noun}</button>{items.map(item => <button key={item.id} type="button" role="option" aria-selected={item.id === value} onClick={() => { onSelect(item.id, item.name); setOpen(false); }}>{item.name}</button>)}</div>
      {loading && <p className={styles.muted} role="status">正在读取{noun}…</p>}
      {!loading && !error && !items.length && <p className={styles.muted}>没有匹配的{noun}。</p>}
      {error && <div className={styles.readError} role="status"><p>{error}</p><button type="button" disabled={loading} onClick={() => void load(failedCursor.current, epoch.current)}>原处重试</button></div>}
      {cursor && !error && <button type="button" disabled={loading} onClick={() => void load(cursor, epoch.current)}>更多{noun}</button>}
    </div>}
  </div>;
}
