'use client';

import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { canRestoreResultMenuFocus, createResultMenuGesture, isResultMenuOpen, resultMenuKeyboardPoint } from './result-image-context-menu-interaction';
import styles from './ResultImageContextMenu.module.css';

export type ResultImageContextMenuItem = {
  id: string;
  label: string;
  group: 'view' | 'continue' | 'manage' | 'danger';
  icon?: ReactNode;
  disabled?: boolean;
  description?: string;
  onSelect: () => void;
  transferFocus?: boolean;
};

export type ResultImageContextMenuProps = {
  identity: string;
  active?: boolean;
  items: ResultImageContextMenuItem[];
  children: ReactElement;
  onOpenChange?: (open: boolean) => void;
};

const groupOrder = ['view', 'continue', 'manage', 'danger'] as const;

export function ResultImageContextMenu({ identity, active = true, items, children, onOpenChange }: ResultImageContextMenuProps) {
  const [openingIdentity, setOpeningIdentity] = useState<string | null>(null);
  const enabled = active && items.length > 0;
  const open = isResultMenuOpen(openingIdentity, identity, enabled);
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const gesture = useRef(createResultMenuGesture());
  const latest = useRef({ identity, enabled, onOpenChange });
  latest.current = { identity, enabled, onOpenChange };
  const openRef = useRef(false);
  const focusIdentity = useRef<string | null>(null);
  const transferFocus = useRef(false);
  const outsideCleanup = useRef<(() => void) | null>(null);
  const descriptionPrefix = useId();

  function changeOpen(next: boolean) {
    if (next && !latest.current.enabled) return;
    if (next) {
      focusIdentity.current = latest.current.identity;
      transferFocus.current = false;
      gesture.current.menuOpened();
    }
    openRef.current = next;
    setOpeningIdentity(next ? latest.current.identity : null);
    latest.current.onOpenChange?.(next);
  }

  function cancelPendingLongPress() {
    const pointer = gesture.current.cancelPending();
    const trigger = triggerRef.current;
    if (!pointer || !trigger) return;
    // Deliver the same cancellation Radix receives for a native touch scroll.
    // There is deliberately no second long-press timer in this wrapper.
    const view = trigger.ownerDocument.defaultView;
    if (view?.PointerEvent) trigger.dispatchEvent(new view.PointerEvent('pointercancel', {
      bubbles: true, pointerId: pointer.pointerId, pointerType: pointer.pointerType,
    }));
  }

  useLayoutEffect(() => {
    cancelPendingLongPress();
    gesture.current.reset();
    if (openRef.current) {
      transferFocus.current = true;
      changeOpen(false);
    }
    // Only a scope/availability change invalidates the open object's commands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, enabled]);

  useEffect(() => {
    const doc = triggerRef.current?.ownerDocument;
    if (!doc || !enabled) return;
    function onScroll(event: Event) {
      if (event.target instanceof Node && contentRef.current?.contains(event.target)) return;
      cancelPendingLongPress();
      if (openRef.current) changeOpen(false);
    }
    doc.addEventListener('scroll', onScroll, true);
    return () => doc.removeEventListener('scroll', onScroll, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  useEffect(() => () => {
    outsideCleanup.current?.();
    if (openRef.current) latest.current.onOpenChange?.(false);
  }, []);

  function swallowDismissalClick(original: PointerEvent) {
    outsideCleanup.current?.();
    const doc = original.target instanceof Node ? original.target.ownerDocument : triggerRef.current?.ownerDocument;
    const view = doc?.defaultView;
    if (!doc || !view) return;
    const dismissedGesture = createResultMenuGesture();
    dismissedGesture.pointerDown({
      pointerId: original.pointerId, pointerType: original.pointerType, button: original.button,
      ctrlKey: true, clientX: original.clientX, clientY: original.clientY, timeStamp: original.timeStamp,
    });
    dismissedGesture.menuOpened();
    function cleanup() {
      doc?.removeEventListener('click', onClick, true);
      doc?.removeEventListener('pointerdown', cleanup, true);
      doc?.removeEventListener('pointerup', onUp, true);
      view?.clearTimeout(expiry);
      if (outsideCleanup.current === cleanup) outsideCleanup.current = null;
    }
    function onUp(event: PointerEvent) { dismissedGesture.pointerUp(event); }
    function onClick(event: MouseEvent) {
      const native = event as PointerEvent;
      if (dismissedGesture.consumeClick({ button: event.button, detail: event.detail,
        clientX: event.clientX, clientY: event.clientY, timeStamp: event.timeStamp,
        pointerId: native.pointerType ? native.pointerId : undefined, pointerType: native.pointerType,
      })) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      cleanup();
    }
    const expiry = view.setTimeout(cleanup, 1500);
    doc.addEventListener('click', onClick, true);
    doc.addEventListener('pointerdown', cleanup, true);
    doc.addEventListener('pointerup', onUp, true);
    outsideCleanup.current = cleanup;
  }

  const groups = groupOrder.map(group => ({ group, entries: items.filter(item => item.group === group) })).filter(group => group.entries.length);

  return <ContextMenu.Root open={open} onOpenChange={changeOpen} modal>
    <ContextMenu.Trigger asChild ref={triggerRef} disabled={!enabled}
      onPointerDownCapture={event => {
        if (!enabled || event.defaultPrevented) return;
        gesture.current.pointerDown(event);
        if (event.pointerType === 'mouse' && event.button === 0 && event.ctrlKey) {
          const trigger = event.currentTarget;
          const view = trigger.ownerDocument.defaultView;
          if (!view) return;
          event.preventDefault(); event.stopPropagation();
          trigger.dispatchEvent(new view.MouseEvent('contextmenu', {
            bubbles: true, cancelable: true, button: 2, ctrlKey: true, clientX: event.clientX, clientY: event.clientY,
          }));
        }
      }}
      onPointerMoveCapture={() => gesture.current.cancelPending()}
      onPointerUpCapture={event => gesture.current.pointerUp(event)}
      onPointerCancelCapture={() => gesture.current.cancelPending()}
      onContextMenu={event => { if (enabled) event.stopPropagation(); }}
      onKeyDown={event => {
        if (!enabled || event.defaultPrevented || (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey))) return;
        event.preventDefault(); event.stopPropagation();
        const trigger = event.currentTarget;
        const view = trigger.ownerDocument.defaultView;
        if (!view) return;
        trigger.dispatchEvent(new view.MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, button: 2, ...resultMenuKeyboardPoint(trigger.getBoundingClientRect()),
        }));
      }}
      onClickCapture={event => {
        const native = event.nativeEvent as PointerEvent;
        if (gesture.current.consumeClick({ button: event.button, detail: event.detail,
          clientX: event.clientX, clientY: event.clientY, timeStamp: event.timeStamp,
          pointerId: native.pointerType ? native.pointerId : undefined, pointerType: native.pointerType,
        })) { event.preventDefault(); event.stopPropagation(); }
      }}
      onDoubleClickCapture={event => {
        // Some platforms still emit dblclick after a consumed Control-click.
        if (gesture.current.consumeDoubleClick(event)) { event.preventDefault(); event.stopPropagation(); }
      }}>
      {children}
    </ContextMenu.Trigger>
    <ContextMenu.Portal>
      <ContextMenu.Content ref={contentRef} className={styles.content} collisionPadding={8} loop
        aria-label="图片操作"
        onEscapeKeyDown={event => event.stopPropagation()}
        onPointerDownOutside={event => {
          const original = event.detail.originalEvent;
          original.preventDefault();
          swallowDismissalClick(original);
        }}
        onCloseAutoFocus={event => {
          event.preventDefault();
          const trigger = triggerRef.current;
          if (trigger && canRestoreResultMenuFocus({
            openingIdentity: focusIdentity.current, currentIdentity: latest.current.identity,
            active: latest.current.enabled, connected: trigger.isConnected,
            transferFocus: transferFocus.current, open: openRef.current,
          })) trigger.focus({ preventScroll: true });
        }}>
        {groups.map(({ group, entries }, index) => <Fragment key={group}>
          {index > 0 && <ContextMenu.Separator className={styles.separator} />}
          <ContextMenu.Group>
            {entries.map(item => {
              const descriptionId = `${descriptionPrefix}-${item.id}`;
              return <ContextMenu.Item key={item.id} className={styles.item} disabled={item.disabled}
                data-danger={group === 'danger' || undefined} textValue={item.label}
                aria-describedby={item.description ? descriptionId : undefined}
                onSelect={event => {
                  event.preventDefault();
                  if (!openRef.current || !latest.current.enabled || focusIdentity.current !== latest.current.identity || item.disabled) return;
                  transferFocus.current = Boolean(item.transferFocus);
                  // Close before invoking the original command, in the same user
                  // event so synchronous window.open keeps its activation.
                  flushSync(() => changeOpen(false));
                  item.onSelect();
                }}>
                {item.icon && <span className={styles.icon} aria-hidden="true">{item.icon}</span>}
                <span className={styles.text}><span className={styles.label}>{item.label}</span>
                  {item.description && <span id={descriptionId} className={styles.description}>{item.description}</span>}
                </span>
              </ContextMenu.Item>;
            })}
          </ContextMenu.Group>
        </Fragment>)}
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>;
}
