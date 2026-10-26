'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { SlidersHorizontal, X } from 'lucide-react';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import styles from '@/app/projects/Projects.module.css';

export default function ProjectFilters({ children, active = false }: { children: ReactNode; active?: boolean }) {
  const [mobile, setMobile] = useState(false);
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const media = window.matchMedia('(max-width: 640px)');
    const change = () => { setMobile(media.matches); setOpen(false); };
    change(); media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useDialogDismiss({ open: mobile && open, dialogRef, dismissSurfaceRef: surfaceRef, onDismiss: () => setOpen(false) });
  if (!mobile) return <div className={styles.filterOptions}>{children}</div>;
  return <>
    <button className="btn btn-secondary" type="button" aria-label={active ? '筛选（已选条件）' : '筛选'} title="筛选" aria-expanded={open} onClick={() => setOpen(true)}>
      <SlidersHorizontal size={18} /><span className={styles.filterLabel}>{active ? '已筛选' : '筛选'}</span>
    </button>
    {open && createPortal(<div className="modal-overlay" ref={surfaceRef}>
      <div className="modal-panel" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef}>
        <div className="modal-header"><h2 id={titleId}>筛选</h2><button type="button" className="btn btn-secondary" title="关闭" aria-label="关闭筛选" onClick={() => setOpen(false)}><X size={18} /></button></div>
        <div className={styles.filterOptions}>{children}</div>
      </div>
    </div>, document.body)}
  </>;
}
