'use client';

import { Fragment, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, rectSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, RotateCcw } from 'lucide-react';
import styles from './studio.module.css';

type Pane = 'materials' | 'preview' | 'editor';
type Layout = { order: Pane[]; materials: number; editor: number };
const names = { materials: '素材与历史', preview: '当前采用', editor: '候选与制作' };
const defaults: Layout = { order: ['materials', 'preview', 'editor'], materials: 176, editor: 340 };
const limits = { materials: [140, 360], preview: [320, Infinity], editor: [280, 640] } as const;

function PaneFrame({ id, compact, children }: { id: Pane; compact: boolean; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id });
  return <section ref={setNodeRef} className={styles.workspacePane} data-pane={id} data-dragging={isDragging || undefined}
    style={{ transform: CSS.Transform.toString(transform && { ...transform, y: compact ? transform.y : 0 }), transition }}>
    <header className={styles.workspacePaneHeading}>
      <button type="button" ref={setActivatorNodeRef} {...attributes} {...listeners} className={styles.paneDragHandle}
        aria-label={`移动${names[id]}`} title="拖动换位；键盘按空格开始，方向键移动，空格放下，Esc取消"><GripVertical size={16} /></button>
      <span>{names[id]}</span>
    </header>
    <div className={styles.workspacePaneBody}>{children}</div>
  </section>;
}

export function CharacterLabLayout({ ownerId, panels }: { ownerId: string; panels: Record<Pane, ReactNode> }) {
  const storageKey = `sd2:character-lab:layout:v1:${ownerId}`;
  const [layout, setLayout] = useState<Layout>(defaults);
  const [available, setAvailable] = useState(0);
  const [dragging, setDragging] = useState(false);
  const root = useRef<HTMLDivElement>(null), current = useRef(layout);
  const resizing = useRef<{ x: number; left: Pane; right: Pane; sizes: Record<Pane, number>; before: Layout } | null>(null);
  const contextId = useId();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  current.current = layout;
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
      if (saved && Array.isArray(saved.order) && saved.order.length === 3 && new Set(saved.order).size === 3
        && saved.order.every((id: string) => Object.hasOwn(names, id))
        && Number.isFinite(saved.materials) && saved.materials >= 140 && saved.materials <= 360
        && Number.isFinite(saved.editor) && saved.editor >= 280 && saved.editor <= 640) setLayout(saved);
      else {
        const oldWidth = Number(localStorage.getItem(`sd2:character-lab:editor-width:v1:${ownerId}`));
        setLayout({ ...defaults, editor: oldWidth >= 280 && oldWidth <= 560 ? oldWidth : 340 });
      }
    } catch { /* Optional layout preferences never replace the saved role draft. */ }
  }, [ownerId, storageKey]);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setAvailable(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  function update(next: Layout, persist: boolean) {
    current.current = next; setLayout(next);
    if (persist) try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Layout remains usable without local storage. */ }
  }
  const compact = available > 0 && available < 960;
  const room = Math.max(available - 24, 740);
  const materials = Math.min(layout.materials, room - 600);
  const editor = Math.min(layout.editor, room - materials - 320);
  const sizes = { materials, editor, preview: room - materials - editor };
  function resize(left: Pane, right: Pane, delta: number, original = sizes, before = current.current, persist = false) {
    const minimum = Math.max(limits[left][0] - original[left], original[right] - limits[right][1]);
    const maximum = Math.min(limits[left][1] - original[left], original[right] - limits[right][0]);
    const amount = Math.round(Math.max(minimum, Math.min(maximum, delta)));
    const next = { ...before };
    if (left !== 'preview') next[left] = original[left] + amount;
    if (right !== 'preview') next[right] = original[right] - amount;
    update(next, persist);
  }
  return <div className={styles.workspaceLayout}>
    <div className={styles.workspaceLayoutTools}><button type="button" onClick={() => update(defaults, true)}><RotateCcw size={13} />恢复布局</button></div>
    <DndContext id={contextId} sensors={sensors} collisionDetection={closestCenter}
      accessibility={{ screenReaderInstructions: { draggable: '按空格开始移动面板，方向键选择位置，再按空格放下，按Esc取消。' }, announcements: {
        onDragStart: ({ active }) => `开始移动${names[active.id as Pane]}`,
        onDragOver: ({ active, over }) => over ? `${names[active.id as Pane]}移至${names[over.id as Pane]}的位置` : undefined,
        onDragEnd: ({ active, over }) => over ? `${names[active.id as Pane]}已放下` : '已取消移动',
        onDragCancel: () => '已取消移动',
      } }}
      onDragStart={() => setDragging(true)} onDragCancel={() => setDragging(false)} onDragEnd={({ active, over }) => {
        setDragging(false);
        if (over && active.id !== over.id) update({ ...current.current, order: arrayMove(current.current.order, current.current.order.indexOf(active.id as Pane), current.current.order.indexOf(over.id as Pane)) }, true);
      }}>
      <SortableContext items={layout.order} strategy={rectSortingStrategy}>
        <div ref={root} className={styles.workspaceColumns} data-compact={compact || undefined} data-dragging={dragging || undefined}
          style={{ gridTemplateColumns: layout.order.map(id => id === 'preview' ? 'minmax(320px, 1fr)' : `${sizes[id]}px`).join(' 12px ') } as CSSProperties}>
          {layout.order.map((id, index) => <Fragment key={id}>
            <PaneFrame id={id} compact={compact}>{panels[id]}</PaneFrame>
            {index < 2 && <div className={styles.workspaceSeparator} role="separator" tabIndex={compact ? -1 : 0}
              aria-label={`调整${names[id]}与${names[layout.order[index + 1]]}宽度`} aria-orientation="vertical"
              aria-valuemin={limits[id][0]} aria-valuemax={Math.min(limits[id][1], sizes[id] + sizes[layout.order[index + 1]] - limits[layout.order[index + 1]][0])}
              aria-valuenow={Math.round(sizes[id])} aria-valuetext={`${names[id]} ${Math.round(sizes[id])}像素`}
              title="拖动调整两栏宽度；方向键微调，双击恢复默认宽度"
              onPointerDown={event => {
                if (event.button !== 0) return;
                event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
                resizing.current = { x: event.clientX, left: id, right: layout.order[index + 1], sizes, before: current.current };
              }}
              onPointerMove={event => { const start = resizing.current; if (start && event.currentTarget.hasPointerCapture(event.pointerId)) resize(start.left, start.right, event.clientX - start.x, start.sizes, start.before); }}
              onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { event.currentTarget.releasePointerCapture(event.pointerId); resizing.current = null; update(current.current, true); } }}
              onPointerCancel={() => { const start = resizing.current; resizing.current = null; if (start) update(start.before, false); }}
              onDoubleClick={() => update({ ...current.current, materials: defaults.materials, editor: defaults.editor }, true)}
              onKeyDown={event => {
                if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                  event.preventDefault();
                  resize(id, layout.order[index + 1], event.key === 'Home' ? -Infinity : event.key === 'End' ? Infinity : event.key === 'ArrowLeft' ? -20 : 20, sizes, current.current, true);
                }
              }}><GripVertical size={14} /></div>}
          </Fragment>)}
        </div>
      </SortableContext>
    </DndContext>
  </div>;
}
