'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import styles from './ResourceLibraryPicker.module.css';

type AlbumOption = { value: string; label: string; group: string; count?: number };
export function ResourceLibraryAlbumFilter({ options, value, onChange }: {
  options: AlbumOption[]; value: string; onChange: (value: string) => void;
}) {
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false), [search, setSearch] = useState('');
  const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  useDialogDismiss({ open, dialogRef: panel, layerSurfaceRef: panel, branchRefs: [trigger], initialFocusRef: input, modal: false, onDismiss: () => setOpen(false) });
  useEffect(() => {
    if (!open) return;
    const place = () => {
      if (!trigger.current || !panel.current) return;
      const anchor = trigger.current.getBoundingClientRect(), viewport = window.visualViewport;
      const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
      const right = left + (viewport?.width || innerWidth), bottom = top + (viewport?.height || innerHeight);
      const width = Math.min(360, right - left - 20), maxHeight = Math.min(380, bottom - top - 20), height = Math.min(panel.current.scrollHeight, maxHeight);
      setPosition({ left: Math.max(left + 10, Math.min(anchor.left, right - width - 10)), top: anchor.bottom + height + 6 <= bottom - 10 ? anchor.bottom + 6 : Math.max(top + 10, anchor.top - height - 6), width, maxHeight });
    };
    place();
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true); window.visualViewport?.addEventListener('resize', place);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); window.visualViewport?.removeEventListener('resize', place); };
  }, [open, options.length, search]);
  const selected = options.find(option => option.value === value);
  const term = search.trim().toLocaleLowerCase();
  const visible = options.filter(option => !term || `${option.label} ${option.group}`.toLocaleLowerCase().includes(term));
  return <div className={styles.albumPicker}>
    <button ref={trigger} type="button" className={styles.albumTrigger} aria-label="筛选图集或项目" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      title={selected?.label} onClick={() => { setSearch(''); setPosition(null); setOpen(previous => !previous); }} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setSearch(''); setOpen(true); } }}>
      <span>{selected?.label || '所选图集暂不可用'}</span><ChevronDown size={15} />
    </button>
    {open && <div ref={panel} id={id} role="dialog" aria-label="筛选图集或项目" className={styles.albumPanel} style={position || { left: 0, top: 0, visibility: 'hidden' }}
      onKeyDown={event => {
        if (event.target instanceof HTMLInputElement || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const choices = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button[data-album-choice]') || []), index = choices.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
        choices[next]?.focus();
      }}>
      <label className={styles.albumSearch}><Search size={16} /><input ref={input} type="search" aria-label="搜索图集或项目" placeholder="搜索图集或项目" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <div className={styles.albumOptions}>{visible.map((option, index) => <div key={option.value}>
        {option.group && option.group !== visible[index - 1]?.group && <div className={styles.albumGroup}>{option.group}</div>}
        <button type="button" data-album-choice aria-pressed={value === option.value} onClick={() => { onChange(option.value); setOpen(false); }}>
          <span>{option.label}</span>{option.count !== undefined && <small>{option.count}</small>}{value === option.value && <Check size={15} />}
        </button>
      </div>)}{!visible.length && <p className={styles.albumEmpty}>没有匹配的图集或项目</p>}</div>
    </div>}
  </div>;
}
