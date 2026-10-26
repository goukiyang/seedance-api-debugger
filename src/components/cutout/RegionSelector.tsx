'use client';

import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, PointerEvent as ReactPointerEvent } from 'react';
import { Image as ImageIcon, Trash2 } from 'lucide-react';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';
import type { Box } from '@/lib/cutout/types';
import styles from './editors.module.css';

type Props = {
  imageUrl: string;
  width: number;
  height: number;
  value: Box | null;
  onChange: (box: Box | null) => void;
  disabled?: boolean;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getPoint(event: ReactPointerEvent<SVGSVGElement>, width: number, height: number) {
  const rect = event.currentTarget.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    x: clamp(Math.round(((event.clientX - rect.left) / rect.width) * width), 0, width),
    y: clamp(Math.round(((event.clientY - rect.top) / rect.height) * height), 0, height),
  };
}

function NumberField({
  label,
  value,
  min,
  max,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (draft.trim() && Number.isFinite(parsed)) onCommit(clamp(Math.round(parsed), min, max));
    else setDraft(String(value));
  };
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={draft}
        disabled={disabled}
        onChange={(event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
      />
    </label>
  );
}

export default function RegionSelector({ imageUrl, width, height, value, onChange, disabled = false }: Props) {
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const valueRef = useRef(value);
  const [draft, setDraft] = useState<Box | null>(value);
  const [dragging, setDragging] = useState<Box | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  valueRef.current = value;

  useEffect(() => setDraft(value), [value]);

  const begin = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (disabled) return;
    const point = getPoint(event, width, height);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    startRef.current = point;
    setDragging({ x: point.x, y: point.y, w: 0, h: 0 });
  };

  const move = (event: ReactPointerEvent<SVGSVGElement>) => {
    const start = startRef.current;
    if (!start) return;
    const point = getPoint(event, width, height);
    if (!point) return;
    setDragging({
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      w: Math.abs(point.x - start.x),
      h: Math.abs(point.y - start.y),
    });
  };

  const finish = (event: ReactPointerEvent<SVGSVGElement>) => {
    const start = startRef.current;
    const end = getPoint(event, width, height);
    startRef.current = null;
    setDragging(null);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* pointer capture can end before pointerup */ }
    if (!start || !end || disabled) return;
    const w = Math.abs(end.x - start.x);
    const h = Math.abs(end.y - start.y);
    if (w < 2 || h < 2) return;
    const next = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), w, h };
    setDraft(next);
    onChange(next);
  };

  const cancel = (event: ReactPointerEvent<SVGSVGElement>) => {
    startRef.current = null;
    setDragging(null);
    setDraft(valueRef.current);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* pointer capture can end before pointercancel */ }
  };

  const adjust = (field: keyof Box, nextValue: number) => {
    const current = draft;
    if (!current) return;
    const next = { ...current, [field]: nextValue };
    next.w = clamp(Math.round(next.w), 1, width);
    next.h = clamp(Math.round(next.h), 1, height);
    next.x = clamp(Math.round(next.x), 0, width - next.w);
    next.y = clamp(Math.round(next.y), 0, height - next.h);
    setDraft(next);
    onChange(next);
  };

  const clear = () => {
    startRef.current = null;
    setDraft(null);
    onChange(null);
  };

  const preview = previewOpen && imageUrl
    ? <ZoomableImagePreview src={imageUrl} alt="拆分区域大图预览" onClose={() => setPreviewOpen(false)} />
    : null;

  return (
    <>
      <section className={styles.editor} aria-label="拆分区域选择器">
        <header className={styles.editorHeader}>
          <div>
            <h3>选择拆分区域</h3>
            <p>{width} × {height} px</p>
          </div>
          <div className={styles.toolbar}>
            <button type="button" className={styles.iconButton} title="放大预览" aria-label="放大预览" onClick={() => setPreviewOpen(true)} disabled={!imageUrl}><ImageIcon size={16} /></button>
            <button type="button" className={styles.iconButton} title="清除选区" aria-label="清除选区" onClick={clear} disabled={disabled || !draft}><Trash2 size={16} /></button>
          </div>
        </header>

        <div className={styles.regionLayout}>
          <div className={styles.imageColumn}>
            <div
              className={styles.imageStage}
              onDoubleClick={() => setPreviewOpen(true)}
            >
              <img src={imageUrl} alt="待框选的原图" draggable={false} className={styles.stageImage} />
              <svg
                className={`${styles.overlay} ${styles.drawCursor}`}
                viewBox={`0 0 ${width} ${height}`}
                preserveAspectRatio="none"
                aria-label="拆分范围框选区域"
                onPointerDown={begin}
                onPointerMove={move}
                onPointerUp={finish}
                onPointerCancel={cancel}
              >
                {draft && <rect className={styles.regionBox} x={draft.x} y={draft.y} width={draft.w} height={draft.h} vectorEffect="non-scaling-stroke" pointerEvents="none" />}
                {dragging && <rect className={styles.drawingBox} x={dragging.x} y={dragging.y} width={dragging.w} height={dragging.h} vectorEffect="non-scaling-stroke" pointerEvents="none" />}
              </svg>
            </div>
            <div className={styles.imageCaption}>
              <span>{draft ? `选区 ${draft.w} × ${draft.h} px` : '尚未选择区域'}</span>
              <span>原图坐标</span>
            </div>
          </div>

          <div className={styles.regionFields} aria-label="区域坐标">
            <strong>区域坐标</strong>
            {draft ? (
              <>
                <div className={styles.numberGrid}>
                  <NumberField label="X" value={draft.x} min={0} max={Math.max(0, width - draft.w)} disabled={disabled} onCommit={(next) => adjust('x', next)} />
                  <NumberField label="Y" value={draft.y} min={0} max={Math.max(0, height - draft.h)} disabled={disabled} onCommit={(next) => adjust('y', next)} />
                  <NumberField label="宽" value={draft.w} min={1} max={width} disabled={disabled} onCommit={(next) => adjust('w', next)} />
                  <NumberField label="高" value={draft.h} min={1} max={height} disabled={disabled} onCommit={(next) => adjust('h', next)} />
                </div>
              </>
            ) : <p className={styles.emptyHint}>尚未选择区域</p>}
          </div>
        </div>
      </section>
      {preview}
    </>
  );
}
