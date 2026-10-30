'use client';

import { useRef, type ReactNode } from 'react';
import { DndContext, KeyboardSensor, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy, type SortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import styles from './sortable-studio-list.module.css';

type RenderItem<T> = (item: T, handle: ReactNode) => ReactNode;

function SortableRow<T>({ id, item, disabled, label, render }: {
  id: string; item: T; disabled: boolean; label: string; render: RenderItem<T>;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  return <div ref={setNodeRef} className={styles.item} data-dragging={isDragging || undefined}
    style={{ transform: CSS.Transform.toString(transform), transition }}>
    {render(item, <button type="button" ref={setActivatorNodeRef} className={styles.handle}
      {...attributes} {...listeners} data-sort-handle={id}
      onMouseDown={event => { event.stopPropagation(); if (event.button === 0) listeners?.onMouseDown?.(event); }}
      onTouchStart={event => { event.stopPropagation(); listeners?.onTouchStart?.(event); }}
      onKeyDown={event => { listeners?.onKeyDown?.(event); }}
      disabled={disabled} aria-label={`调整${label}顺序`} title="拖动调整；触屏长按，键盘空格开始，方向键调整，Esc取消">
      <GripVertical size={14} />
    </button>)}
  </div>;
}

/** Only handles activate sorting; navigation buttons keep ordinary click/scroll behavior. */
export function SortableStudioList<T>({ items, identify, label, disabled = false, onReorder, render, strategy = verticalListSortingStrategy, revisionKey = '',
  keyboardInstructions = '在排序按钮上按空格开始，使用上下方向键调整，再按空格完成；按Esc取消。' }: {
  items: T[]; identify: (item: T) => string; label: (item: T) => string; disabled?: boolean;
  strategy?: SortingStrategy; keyboardInstructions?: string;
  revisionKey?: string;
  onReorder: (ids: string[]) => void; render: RenderItem<T>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const startedIds = useRef<string[]>([]);
  const startedRevision = useRef('');
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 350, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = items.map(identify);
  const name = (id: string | number) => { const item = items.find(entry => identify(entry) === id); return item ? label(item) : '模板'; };
  return <div ref={host} style={{ display: 'contents' }}><DndContext sensors={sensors} collisionDetection={closestCenter}
    onDragStart={() => { startedIds.current = ids; startedRevision.current = revisionKey; }}
    accessibility={{ screenReaderInstructions: { draggable: keyboardInstructions }, announcements: {
      onDragStart: ({ active }) => `开始调整${name(active.id)}顺序。`,
      onDragOver: ({ active, over }) => over ? `${name(active.id)}将移到第${ids.indexOf(String(over.id)) + 1}位。` : undefined,
      onDragEnd: ({ active, over }) => over ? `${name(active.id)}排序调整结束。` : '已取消调整。',
      onDragCancel: () => '已取消调整，原顺序不变。',
    } }}
    onDragEnd={({ active, over, activatorEvent }) => {
      if (activatorEvent.type === 'keydown') requestAnimationFrame(() => {
        Array.from(host.current?.querySelectorAll<HTMLButtonElement>('[data-sort-handle]') || [])
          .find(button => button.dataset.sortHandle === String(active.id))?.focus({ preventScroll: true });
      });
      if (disabled || !over || active.id === over.id || startedRevision.current !== revisionKey || JSON.stringify(startedIds.current) !== JSON.stringify(ids)) return;
      const from = ids.indexOf(String(active.id)), to = ids.indexOf(String(over.id));
      if (from >= 0 && to >= 0) onReorder(arrayMove(ids, from, to));
    }}>
    <SortableContext items={ids} strategy={strategy}>
      {items.map(item => <SortableRow key={identify(item)} id={identify(item)} item={item} disabled={disabled}
        label={label(item)} render={render} />)}
    </SortableContext>
  </DndContext></div>;
}
