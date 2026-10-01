'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { GripVertical, MessageSquare, Save, X } from 'lucide-react';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import type { UploadedAssetPayload } from '@/lib/http/file-upload';
import styles from './studio.module.css';

export type FixedStudioReference = UploadedAssetPayload & { note: string; available?: boolean };

export function StudioReferenceGrid<T extends UploadedAssetPayload>({ items, onChange, onPreview, disabled, offset = 0, notes, children, compact, labels = 'image', onSaveNote }: {
  items: T[]; onChange: (items: T[]) => void; onPreview: (item: T, number: number) => void;
  disabled?: boolean; offset?: number; notes?: boolean; children?: ReactNode; compact?: boolean; labels?: 'image' | 'template' | 'style'; onSaveNote?: (items: T[]) => Promise<boolean>;
}) {
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; index: number; x: number; y: number; moved: boolean; target: number } | null>(null);
  const suppressClick = useRef(false);
  const [targetIndex, setTargetIndex] = useState<number | null>(null);
  const [sourceIndex, setSourceIndex] = useState<number | null>(null);
  const [noteIndex, setNoteIndex] = useState<number | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteError, setNoteError] = useState('');
  const noteDialog = useRef<HTMLDialogElement>(null);
  const label = (index: number) => labels === 'template' ? `模板${String.fromCharCode(65 + index)}` : `${labels === 'style' ? '风格' : '图'} ${offset + index + 1}`;
  const originalNote = noteIndex === null ? '' : (items[noteIndex] as unknown as FixedStudioReference)?.note || '';
  const closeNote = () => {
    if (noteBusy || (noteDraft !== originalNote && !window.confirm('备注尚未保存，放弃这次修改？'))) return;
    setNoteIndex(null);
  };
  useEffect(() => { if (noteIndex === null) noteDialog.current?.close(); else noteDialog.current?.showModal(); }, [noteIndex]);
  useDialogDismiss({ open: noteIndex !== null, dialogRef: noteDialog, nativeDialog: true, onDismiss: closeNote });
  async function saveNote() {
    if (noteIndex === null || disabled || noteBusy) return;
    setNoteBusy(true); setNoteError('');
    try {
      const next = items.map((item, index) => index === noteIndex ? { ...item, note: noteDraft } : item);
      if (onSaveNote) { if (!await onSaveNote(next)) { setNoteError('备注未保存，请重试'); return; } }
      else onChange(next);
      setNoteIndex(null);
    } catch { setNoteError('备注未保存，请重试'); }
    finally { setNoteBusy(false); }
  }
  const move = (from: number, to: number) => {
    if (disabled || from === to || to < 0 || to >= items.length) return;
    const next = [...items];
    next.splice(to, 0, next.splice(from, 1)[0]);
    onChange(next);
  };
  const reset = () => { drag.current = null; setTargetIndex(null); setSourceIndex(null); };
  return <><div ref={root} className={`${styles.references} ${compact ? styles.referencesCompact : ''}`}>
    {items.map((item, index) => <div key={`${item.id}-${index}`} data-reference-index={index}
      className={`${styles.referenceItem} ${targetIndex === index ? styles.referenceDropTarget : ''}`}
      data-dragging={sourceIndex === index || undefined}
      onPointerDown={event => {
        if (disabled || event.button !== 0 || !(event.target instanceof Element)) return;
        const grip = event.target.closest('[data-sort-grip]');
        if (event.target.closest('textarea,input,select,a,[data-reference-remove],[data-reference-note]') || (event.pointerType !== 'mouse' && !grip)) return;
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
        <button type="button" className={styles.preview} disabled={!item.originalUrl} aria-label={`预览${label(index)}`} onClick={() => onPreview(item, offset + index + 1)}>
          {item.thumbnailUrl ? <img decoding="async" draggable={false} src={item.thumbnailUrl} alt={label(index)} /> : <span>图片已不可用</span>}
        </button>
        <span className={styles.referenceNumber}>{label(index)}</span>
        <button type="button" data-sort-grip className={styles.referenceGrip} disabled={disabled} aria-label={`移动${label(index)}`} title="移动参考图"
          onKeyDown={event => { if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key)) { event.preventDefault(); move(index, index + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1)); } }}><GripVertical size={16} /></button>
        <button type="button" data-reference-remove className={styles.remove} disabled={disabled} onClick={() => onChange(items.filter((_, i) => i !== index))} title="移除参考图" aria-label={`移除${label(index)}`}><X size={16} /></button>
      </div>
      {notes && <button type="button" data-reference-note className={styles.referenceNoteButton} title={`${label(index)}备注`} aria-label={`${label(index)}备注`}
        onClick={() => { setNoteDraft((item as unknown as FixedStudioReference).note || ''); setNoteError(''); setNoteIndex(index); }}>
        <MessageSquare size={14} />{(item as unknown as FixedStudioReference).note ? '已备注' : '备注'}
      </button>}
    </div>)}
    {children}
  </div>
    <dialog ref={noteDialog} className={`${styles.dialog} ${styles.noteDialog}`} aria-label="参考图备注">
      <header className={styles.header}><h3>{noteIndex === null ? '备注' : `${label(noteIndex)}备注`}</h3><button type="button" aria-label="关闭备注" disabled={noteBusy} onClick={closeNote}><X size={18} /></button></header>
      <textarea aria-label="参考图备注内容" rows={5} maxLength={2000} readOnly={disabled} disabled={noteBusy} value={noteDraft} onChange={event => setNoteDraft(event.target.value)} />
      {noteError && <p role="alert" className={styles.error}>{noteError}</p>}
      {!disabled && <button type="button" disabled={noteBusy || noteDraft === originalNote} onClick={() => void saveNote()}><Save size={16} />{noteBusy ? '正在保存' : onSaveNote ? '保存备注' : '应用备注'}</button>}
    </dialog>
  </>;
}
