'use client';

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

type ElementRef<T extends HTMLElement = HTMLElement> = RefObject<T>;

export type DialogDismissOptions<T extends HTMLElement = HTMLElement> = {
  open: boolean;
  dialogRef: ElementRef<T>;
  /** Exact backdrop target for modal layers; omit for non-modal outside dismissal. */
  dismissSurfaceRef?: ElementRef;
  /** External controls/popovers that belong to a non-modal layer. */
  branchRefs?: readonly ElementRef[];
  initialFocusRef?: ElementRef;
  onDismiss: () => void;
  dismissOnOutside?: boolean;
  dismissOnEscape?: boolean;
  modal?: boolean;
  nativeDialog?: boolean;
  restoreFocus?: boolean;
  isDismissTarget?: (target: EventTarget | null, event?: Event) => boolean;
};

type LayerRecord = {
  dialogRef: ElementRef;
  surfaceRef?: ElementRef;
  optionsRef: { current: DialogDismissOptions };
  restoreTarget: HTMLElement | null;
  addedTabIndex: boolean;
  previousZIndex: string;
  assignedSurface: HTMLElement | null;
  cancelListener?: (event: Event) => void;
};

const layers: LayerRecord[] = [];
const Z_INDEX_BASE = 2_147_000_000;
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled)',
  'textarea:not(:disabled)',
  'select:not(:disabled)',
  'summary',
  'video[controls]',
  'audio[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

let listening = false;
let pendingPointer: { layer: LayerRecord; pointerId: number; x: number; y: number; outside: boolean } | null = null;
const clearPendingPointer = () => { pendingPointer = null; };

function eventTargetNode(target: EventTarget | null): Node | null {
  return target && typeof (target as Node).nodeType === 'number' ? target as Node : null;
}

function branchContains(layer: LayerRecord, target: Node | null) {
  if (!target) return false;
  return (layer.optionsRef.current.branchRefs || []).some((ref) => ref.current?.contains(target));
}

function activeNativeDialog(): HTMLDialogElement | null {
  const dialogs = Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]')).filter((dialog) => {
    try {
      return dialog.matches(':modal');
    } catch {
      return false;
    }
  });
  if (!dialogs.length) return null;

  const active = document.activeElement;
  const containingActive = dialogs.filter((dialog) => active && (dialog === active || dialog.contains(active)));
  if (containingActive.length) {
    return containingActive.reduce((inner, dialog) => (inner.contains(dialog) ? dialog : inner));
  }
  return dialogs[dialogs.length - 1];
}

function getTopLayer(): LayerRecord | null {
  const nativeDialog = activeNativeDialog();
  if (nativeDialog) {
    const descendants = layers.filter((layer) => {
      if (layer.optionsRef.current.nativeDialog) return false;
      const dialog = layer.dialogRef.current;
      const surface = layer.surfaceRef?.current;
      return Boolean((dialog && nativeDialog.contains(dialog)) || (surface && nativeDialog.contains(surface)));
    });
    if (descendants.length) return descendants[descendants.length - 1];
    return layers.find((layer) => layer.dialogRef.current === nativeDialog) || null;
  }
  return layers[layers.length - 1] || null;
}

function isInsideLayer(layer: LayerRecord, target: EventTarget | null) {
  const node = eventTargetNode(target);
  const dialog = layer.dialogRef.current;
  return Boolean((node && dialog?.contains(node)) || branchContains(layer, node));
}

function isDismissTarget(layer: LayerRecord, target: EventTarget | null, event?: Event) {
  const options = layer.optionsRef.current;
  if (options.nativeDialog && layer.dialogRef.current instanceof HTMLDialogElement) {
    const dialog = layer.dialogRef.current;
    const pointer = event as PointerEvent | undefined;
    if (!dialog.open || target !== dialog || !pointer) return false;
    const bounds = dialog.getBoundingClientRect();
    const outsideBounds = pointer.clientX < bounds.left || pointer.clientX > bounds.right
      || pointer.clientY < bounds.top || pointer.clientY > bounds.bottom;
    return outsideBounds && (!options.isDismissTarget || options.isDismissTarget(target, event));
  }
  if (options.isDismissTarget) return options.isDismissTarget(target, event);
  const surface = layer.surfaceRef?.current;
  if (surface) return target === surface;
  return !isInsideLayer(layer, target);
}

function focusableElements(layer: LayerRecord) {
  const dialog = layer.dialogRef.current;
  if (!dialog) return [];
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => (
    !element.hasAttribute('data-dialog-dismiss-surface')
    && element.getClientRects().length > 0
    && window.getComputedStyle(element).visibility !== 'hidden'
  ));
}

function focusLayer(layer: LayerRecord, preferInitial = false) {
  const dialog = layer.dialogRef.current;
  if (!dialog) return;
  const initial = layer.optionsRef.current.initialFocusRef?.current;
  if (initial?.isConnected && (dialog.contains(initial) || branchContains(layer, initial))) {
    initial.focus({ preventScroll: true });
    return;
  }
  const focusables = focusableElements(layer);
  if (!preferInitial && dialog.contains(document.activeElement)) return;
  if (focusables.length) {
    focusables[0].focus({ preventScroll: true });
    return;
  }
  dialog.focus({ preventScroll: true });
}

function syncLayerOrder() {
  layers.forEach((layer, index) => {
    const surface = layer.surfaceRef?.current;
    if (!surface || layer.optionsRef.current.modal === false) return;
    if (layer.assignedSurface !== surface) {
      if (layer.assignedSurface) layer.assignedSurface.style.zIndex = layer.previousZIndex;
      layer.assignedSurface = surface;
      layer.previousZIndex = surface.style.zIndex;
    }
    surface.style.zIndex = String(Z_INDEX_BASE + index);
  });
}

function handlePointerDown(event: PointerEvent) {
  const layer = getTopLayer();
  if (!layer || layer.optionsRef.current.dismissOnOutside === false) {
    pendingPointer = null;
    return;
  }
  if (event.pointerType !== 'touch' && event.button !== 0) {
    pendingPointer = null;
    return;
  }
  pendingPointer = {
    layer,
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    outside: isDismissTarget(layer, event.target, event),
  };
}

function handlePointerUp(event: PointerEvent) {
  const pending = pendingPointer;
  pendingPointer = null;
  if (!pending || !pending.outside || pending.pointerId !== event.pointerId) return;
  if (getTopLayer() !== pending.layer || !isDismissTarget(pending.layer, event.target, event)) return;
  if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 5) return;
  if (!event.defaultPrevented) pending.layer.optionsRef.current.onDismiss();
}

function handleKeyDown(event: KeyboardEvent) {
  const layer = getTopLayer();
  if (event.key === 'Escape') {
    if (!layer) {
      if (activeNativeDialog()) event.stopImmediatePropagation();
      return;
    }
    if (layer.optionsRef.current.nativeDialog) {
      event.stopImmediatePropagation();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (layer.optionsRef.current.dismissOnEscape !== false) layer.optionsRef.current.onDismiss();
    return;
  }
  if (event.key !== 'Tab' || !layer || layer.optionsRef.current.modal === false) return;

  const focusables = focusableElements(layer);
  if (!focusables.length) {
    event.preventDefault();
    event.stopImmediatePropagation();
    layer.dialogRef.current?.focus({ preventScroll: true });
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !isInsideLayer(layer, active))) {
    event.preventDefault();
    event.stopImmediatePropagation();
    last.focus({ preventScroll: true });
  } else if (!event.shiftKey && (active === last || !isInsideLayer(layer, active))) {
    event.preventDefault();
    event.stopImmediatePropagation();
    first.focus({ preventScroll: true });
  }
}

function handleFocusIn(event: FocusEvent) {
  const layer = getTopLayer();
  if (layer && layer.optionsRef.current.modal !== false && !isInsideLayer(layer, event.target)) focusLayer(layer, true);
}

function attachGlobalListeners() {
  if (listening) return;
  listening = true;
  window.addEventListener('pointerdown', handlePointerDown, true);
  window.addEventListener('pointerup', handlePointerUp, true);
  window.addEventListener('pointercancel', clearPendingPointer, true);
  window.addEventListener('keydown', handleKeyDown, true);
  window.addEventListener('focusin', handleFocusIn, true);
}

function detachGlobalListeners() {
  if (!listening || layers.length) return;
  listening = false;
  window.removeEventListener('pointerdown', handlePointerDown, true);
  window.removeEventListener('pointerup', handlePointerUp, true);
  window.removeEventListener('pointercancel', clearPendingPointer, true);
  window.removeEventListener('keydown', handleKeyDown, true);
  window.removeEventListener('focusin', handleFocusIn, true);
  pendingPointer = null;
}

function registerLayer(layer: LayerRecord, restoreTarget?: HTMLElement | null) {
  const dialog = layer.dialogRef.current;
  if (!dialog) return () => undefined;
  layer.restoreTarget = restoreTarget === undefined
    ? document.activeElement instanceof HTMLElement ? document.activeElement : null
    : restoreTarget;
  if (!dialog.hasAttribute('tabindex')) {
    dialog.setAttribute('tabindex', '-1');
    layer.addedTabIndex = true;
  }
  layers.push(layer);
  attachGlobalListeners();
  syncLayerOrder();

  if (layer.optionsRef.current.nativeDialog && dialog instanceof HTMLDialogElement) {
    layer.cancelListener = (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (getTopLayer() === layer && layer.optionsRef.current.dismissOnEscape !== false) {
        layer.optionsRef.current.onDismiss();
      }
    };
    dialog.addEventListener('cancel', layer.cancelListener, true);
  }

  if (layer.optionsRef.current.modal !== false) {
    window.requestAnimationFrame(() => {
      if (getTopLayer() === layer) focusLayer(layer);
    });
  }

  return () => {
    const index = layers.indexOf(layer);
    if (index >= 0) layers.splice(index, 1);
    if (dialog instanceof HTMLDialogElement && layer.cancelListener) dialog.removeEventListener('cancel', layer.cancelListener, true);
    if (layer.assignedSurface) layer.assignedSurface.style.zIndex = layer.previousZIndex;
    if (layer.addedTabIndex) dialog.removeAttribute('tabindex');
    syncLayerOrder();
    detachGlobalListeners();

    if (layer.optionsRef.current.restoreFocus !== false && layer.restoreTarget?.isConnected) {
      window.requestAnimationFrame(() => {
        const top = getTopLayer();
        if (top && top.optionsRef.current.modal !== false && !isInsideLayer(top, layer.restoreTarget)) {
          focusLayer(top, true);
          return;
        }
        layer.restoreTarget?.focus({ preventScroll: true });
      });
    }
  };
}

export function useDialogDismiss<T extends HTMLElement = HTMLElement>(options: DialogDismissOptions<T>) {
  const latestOptions = useRef<DialogDismissOptions>(options);
  latestOptions.current = options;

  useEffect(() => {
    if (!options.open) return undefined;
    let cleanup: (() => void) | null = null;
    const dialog = options.dialogRef.current;
    let restoreTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const rememberRestoreTarget = (event: Event) => {
      const target = eventTargetNode(event.target);
      if (target && dialog?.contains(target)) return;
      if (document.activeElement instanceof HTMLElement && !dialog?.contains(document.activeElement)) {
        restoreTarget = document.activeElement;
      }
    };
    if (options.nativeDialog) {
      window.addEventListener('pointerdown', rememberRestoreTarget, true);
      window.addEventListener('focusin', rememberRestoreTarget, true);
    }
    const syncNativeDialog = () => {
      const currentDialog = options.dialogRef.current;
      const active = options.nativeDialog
        ? currentDialog instanceof HTMLDialogElement && currentDialog.open
        : Boolean(currentDialog);
      if (active && !cleanup) {
        const layer: LayerRecord = {
          dialogRef: options.dialogRef as ElementRef,
          surfaceRef: options.dismissSurfaceRef,
          optionsRef: latestOptions as { current: DialogDismissOptions },
          restoreTarget: null,
          addedTabIndex: false,
          previousZIndex: '',
          assignedSurface: null,
        };
        cleanup = registerLayer(layer, options.nativeDialog ? restoreTarget : undefined);
      } else if (!active && cleanup) {
        cleanup();
        cleanup = null;
      }
    };

    syncNativeDialog();
    const observer = options.nativeDialog && dialog
      ? new MutationObserver(syncNativeDialog)
      : null;
    observer?.observe(dialog!, { attributes: true, attributeFilter: ['open'] });
    return () => {
      observer?.disconnect();
      cleanup?.();
      if (options.nativeDialog) {
        window.removeEventListener('pointerdown', rememberRestoreTarget, true);
        window.removeEventListener('focusin', rememberRestoreTarget, true);
      }
    };
  }, [options.open, options.dialogRef, options.dismissSurfaceRef, options.nativeDialog]);
}

export function isTopmostDialogLayer(element: HTMLElement | null) {
  if (!element) return false;
  const top = getTopLayer();
  return top?.dialogRef.current === element || top?.surfaceRef?.current === element;
}
