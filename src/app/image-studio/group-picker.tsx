'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Plus, Trash2 } from 'lucide-react';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import styles from './studio.module.css';

// React Aria GridList's separate row actions, hover and focus-within pattern (Apache-2.0).
export function ModuleGroupPicker({ value, groups, protectedGroups, disabled, deleting, onChange, onDelete }: {
  value: string; groups: string[]; protectedGroups: string[]; disabled: boolean; deleting: boolean;
  onChange: (group: string) => void; onDelete: (group: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  useDialogDismiss({ open, dialogRef: panel, branchRefs: [trigger], modal: false, onDismiss: close });
  useEffect(() => { if (disabled || deleting) close(); }, [disabled, deleting]);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('[data-group-select]') || []);
      (buttons.find(button => button.dataset.groupSelect === value) || buttons[0])?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, value]);
  return <div className={styles.moduleGroupControl}>
    <span>分组</span><button ref={trigger} type="button" disabled={disabled || deleting} aria-label={`模块分组：${value}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(current => !current)} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); } }}><span>{value}</span><ChevronDown size={15} /></button>
    {open && <div ref={panel} id={id} role="dialog" aria-label="选择或管理模块分组" className={styles.groupPopover} onKeyDown={event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-group-select]:not(:disabled)'));
      const row = (event.target as HTMLElement).closest('[data-group-row]');
      const current = buttons.findIndex(button => row?.contains(button));
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      event.preventDefault(); buttons[index]?.focus();
    }}>
      {Array.from(new Set([...groups, value])).map(group => <div className={styles.groupRow} key={group} data-group-row>
        <button type="button" data-group-select={group} aria-pressed={value === group} disabled={disabled || deleting} onClick={() => { close(); onChange(group); }}><span>{group}</span>{value === group && <Check size={15} />}</button>
        {!protectedGroups.includes(group) && <button type="button" className={styles.groupDelete} disabled={disabled || deleting} aria-label={`删除分组：${group}`} title={`删除分组：${group}`} onClick={event => { event.stopPropagation(); close(); void onDelete(group); }}><Trash2 size={16} /></button>}
      </div>)}
      <div data-group-row><button type="button" data-group-select="__other__" disabled={disabled || deleting} onClick={() => { close(); onChange('__other__'); }}><Plus size={16} />其他分组</button></div>
    </div>}
  </div>;
}
