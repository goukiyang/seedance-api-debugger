'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';
import { useDialogDismiss } from './useDialogDismiss';
import styles from './ProductActionMenu.module.css';

export type ProductMenuAction = { id: string; label: string; icon?: ReactNode; disabled?: boolean; danger?: boolean; onSelect: (anchor: HTMLElement) => void };
export function ProductActionMenu({ label, actions, disabled, children, onOpenChange, portalTarget }: {
  label: string; actions: ProductMenuAction[]; disabled?: boolean; children?: ReactNode; onOpenChange?: (open: boolean) => void; portalTarget?: HTMLElement | null;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const onOpen = useRef(onOpenChange); onOpen.current = onOpenChange;
  useEffect(() => { onOpen.current?.(open); }, [open]);
  useDialogDismiss({ open, dialogRef: menu, layerSurfaceRef: portalTarget ? menu : undefined, branchRefs: [trigger], modal: false, onDismiss: () => setOpen(false) });
  useEffect(() => {
    if (!open) return;
    const place = () => {
      if (!trigger.current || !menu.current) return;
      const rect = trigger.current.getBoundingClientRect(), panel = menu.current.getBoundingClientRect();
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
      const right = left + (viewport?.width || innerWidth), bottom = top + (viewport?.height || innerHeight);
      setPosition({ left: Math.max(left + 8, Math.min(rect.right - panel.width, right - panel.width - 8)),
        top: rect.bottom + panel.height + 6 <= bottom - 8 ? rect.bottom + 6 : Math.max(top + 8, rect.top - panel.height - 6) });
    };
    place();
    const raf = requestAnimationFrame(() => menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus());
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); window.visualViewport?.removeEventListener('resize', place); };
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  return <>
    <button type="button" ref={trigger} title={label} aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      disabled={disabled} onClick={() => { setPosition(null); setOpen(value => !value); }}
      onKeyDown={event => { if (event.key === 'ArrowDown' && !disabled) { event.preventDefault(); setPosition(null); setOpen(true); } }}>{children || <MoreHorizontal size={16} />}</button>
    {open && createPortal(<div ref={menu} id={id} role="menu" aria-label={label} className={styles.menu}
      style={position || { left: 0, top: 0, visibility: 'hidden' }} onKeyDown={event => {
        if (event.key === 'Tab') { setOpen(false); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []);
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }}>
      {actions.map(action => <button key={action.id} type="button" role="menuitem" disabled={action.disabled} data-danger={action.danger || undefined}
        onClick={() => { setOpen(false); if (trigger.current) action.onSelect(trigger.current); }}>{action.icon}<span>{action.label}</span></button>)}
    </div>, portalTarget || document.body)}
  </>;
}
