'use client';

import { useRef, useState, type ReactNode } from 'react';
import { GripVertical, X } from 'lucide-react';
import type { UploadedAssetPayload } from '@/lib/http/file-upload';
import styles from './studio.module.css';

export type FixedStudioReference = UploadedAssetPayload & { note: string; available?: boolean };

export function StudioReferenceGrid<T extends UploadedAssetPayload>({ items, onChange, onPreview, disabled, offset = 0, notes, children }: {
  items: T[]; onChange: (items: T[]) => void; onPreview: (item: T, number: number) => void;
  disabled?: boolean; offset?: number; notes?: boolean; children?: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; index: number; x: number; y: number; moved: boolean; target: number } | null>(null);
  const suppressClick = useRef(false);
  const [targetIndex, setTargetIndex] = useState<number | null>(null);
  const [sourceIndex, setSourceIndex] = useState<number | null>(null);
  const move = (from: number, to: number) => {
    if (disabled || from === to || to < 0 || to >= items.length) return;
    const next = [...items];
    next.splice(to, 0, next.splice(from, 1)[0]);
    onChange(next);
  };
  const reset = () => { drag.current = null; setTargetIndex(null); setSourceIndex(null); };
  return <div ref={root} className={styles.references}>
    {items.map((item, index) => <div key={`${item.id}-${index}`} data-reference-index={index}
      className={`${styles.referenceItem} ${targetIndex === index ? styles.referenceDropTarget : ''}`}
      data-dragging={sourceIndex === index || undefined}
      onPointerDown={event => {
        if (disabled || event.button !== 0 || !(event.target instanceof Element)) return;
        const grip = event.target.closest('[data-sort-grip]');
        if (event.target.closest('textarea,input,select,a,[data-reference-remove]') || (event.pointerType !== 'mouse' && !grip)) return;
        suppressClick.current = false;
        drag.current = { pointer: event.pointerId, index, x: event.clientX, y: event.clientY, moved: false, target: index };
      }}
      onPointerMove={event => {
        const state = drag.current;
        if (!state || state.pointer !== event.pointerId) return;
        if (!state.moved && Math.hypot(event.clientX - state.x, event.clientY - state.y) < 5) return;
        event.preventDefault();
        if (!state.moved) { event.currentTarget.setPointerCapture(event.pointerId); state.moved = true; setSourceIndex(state.index); }
        const nodes = root.current?.querySelectorAll<HTMLElement>('[data-reference-index]') || [];
        let closest = state.index; let distance = Infinity;
        nodes.forEach(node => {
          const rect = node.getBoundingClientRect();
          const d = Math.hypot(event.clientX - (rect.left + rect.width / 2), event.clientY - (rect.top + rect.height / 2));
          if (d < distance) { distance = d; closest = Number(node.dataset.referenceIndex); }
        });
        state.target = closest; setTargetIndex(closest);
      }}
      onPointerUp={event => {
        const state = drag.current;
        if (!state || state.pointer !== event.pointerId) return;
        if (state.moved) { suppressClick.current = true; move(state.index, state.target); window.setTimeout(() => { suppressClick.current = false; }, 0); }
        reset();
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={reset} onLostPointerCapture={reset}
      onClickCapture={event => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; } }}>
      <div className={styles.reference}>
        <button type="button" className={styles.preview} disabled={!item.originalUrl} aria-label={`预览图 ${offset + index + 1}`} onClick={() => onPreview(item, offset + index + 1)}>
          {item.thumbnailUrl ? <img decoding="async" draggable={false} src={item.thumbnailUrl} alt={`图 ${offset + index + 1}`} /> : <span>图片已不可用</span>}
        </button>
        <span className={styles.referenceNumber}>图 {offset + index + 1}</span>
        <button type="button" data-sort-grip className={styles.referenceGrip} disabled={disabled} aria-label={`移动图 ${offset + index + 1}`} title="拖动排序；方向键移动"
          onKeyDown={event => { if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key)) { event.preventDefault(); move(index, index + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1)); } }}><GripVertical size={16} /></button>
        <button type="button" data-reference-remove className={styles.remove} disabled={disabled} onClick={() => onChange(items.filter((_, i) => i !== index))} title="移除参考图" aria-label={`移除图 ${offset + index + 1}`}><X size={16} /></button>
      </div>
      {notes && <label className={styles.referenceNote}>图 {offset + index + 1} 备注
        <textarea rows={2} maxLength={2000} disabled={disabled} value={(item as unknown as FixedStudioReference).note || ''}
          onChange={event => onChange(items.map((value, i) => i === index ? { ...value, note: event.target.value } : value))} />
      </label>}
    </div>)}
    {children}
  </div>;
}
