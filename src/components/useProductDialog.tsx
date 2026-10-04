'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import styles from './ProductDialog.module.css';

type Options = { title?: string; confirmLabel?: string; danger?: boolean; maxLength?: number | null; allowEmpty?: boolean; multiline?: boolean; anchor?: HTMLElement | null; onSubmit?: (value: string) => Promise<void> };
type Request = Options & { message: string; value?: string; anchor: HTMLElement | null };

function ProductDialog({ request, onResolve }: { request: Request; onResolve: (value: string | null) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [value, setValue] = useState(request.value || '');
  const busy = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dismiss = () => { if (!busy.current) onResolve(null); };
  const [position, setPosition] = useState<{ left: number; top: number; anchored: boolean } | null>(null);
  const naming = request.value !== undefined;
  const maxLength = request.maxLength === undefined ? 120 : request.maxLength;
  const valid = !naming || ((request.allowEmpty || Boolean(value.trim())) && (maxLength === null || value.trim().length <= maxLength));
  useDialogDismiss({ open: true, dialogRef: dialog, nativeDialog: true, initialFocusRef: naming ? input : cancel, onDismiss: dismiss });
  async function submit() {
    if (!valid || busy.current) return;
    const result = naming ? value.trim() : 'yes';
    if (!request.onSubmit) { onResolve(result); return; }
    busy.current = true; setSaving(true); setError('');
    try { await request.onSubmit(result); onResolve(result); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败，请重试'); }
    finally { busy.current = false; setSaving(false); }
  }
  useEffect(() => {
    dialog.current?.showModal();
    (naming ? input.current : cancel.current)?.focus({ preventScroll: true });
    const place = () => {
      const panel = dialog.current;
      if (!panel) return;
      const viewport = window.visualViewport;
      const gap = 8, margin = 16;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const leftEdge = (viewport?.offsetLeft ?? 0) + margin;
      const topEdge = (viewport?.offsetTop ?? 0) + margin;
      const rightEdge = leftEdge + viewportWidth - 2 * margin;
      const bottomEdge = topEdge + viewportHeight - 2 * margin;
      panel.style.setProperty('--product-dialog-width', `${Math.min(440, Math.max(0, viewportWidth - 2 * margin))}px`);
      panel.style.setProperty('--product-dialog-height', `${Math.max(0, viewportHeight - 2 * margin)}px`);
      const width = panel.offsetWidth, height = panel.offsetHeight;
      const clampLeft = (left: number) => Math.max(leftEdge, Math.min(left, rightEdge - width));
      const clampTop = (top: number) => Math.max(topEdge, Math.min(top, bottomEdge - height));
      const rect = request.anchor?.isConnected ? request.anchor.getBoundingClientRect() : null;
      let next = { left: leftEdge + (rightEdge - leftEdge - width) / 2, top: topEdge + (bottomEdge - topEdge - height) / 2, anchored: false };
      if (rect && rect.width > 0 && rect.height > 0 && rect.bottom > topEdge && rect.top < bottomEdge && rect.right > leftEdge && rect.left < rightEdge) {
        // Flip around the control before falling back to the visible viewport center.
        if (rect.bottom + gap + height <= bottomEdge) next = { left: clampLeft(rect.left), top: rect.bottom + gap, anchored: true };
        else if (rect.top - gap - height >= topEdge) next = { left: clampLeft(rect.left), top: rect.top - gap - height, anchored: true };
        else if (rect.right + gap + width <= rightEdge) next = { left: rect.right + gap, top: clampTop(rect.top), anchored: true };
        else if (rect.left - gap - width >= leftEdge) next = { left: rect.left - gap - width, top: clampTop(rect.top), anchored: true };
      }
      setPosition(previous => previous?.left === next.left && previous.top === next.top && previous.anchored === next.anchored ? previous : next);
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    const observer = new ResizeObserver(place);
    if (dialog.current) observer.observe(dialog.current);
    if (request.anchor?.isConnected) observer.observe(request.anchor);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
      observer.disconnect();
    };
  }, [naming, request.anchor]);
  return createPortal(<dialog ref={dialog} className={styles.dialog} data-anchored={Boolean(position?.anchored)}
    style={position ? { left: position.left, top: position.top, right: 'auto', bottom: 'auto', margin: 0 } : undefined}
    aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
    <form onSubmit={event => { event.preventDefault(); void submit(); }} aria-busy={saving}>
      <header className={styles.header}><h2 id={titleId}>{request.title || (naming ? '命名' : '确认操作')}</h2>
        <button type="button" className={styles.close} disabled={saving} onClick={dismiss} aria-label="关闭" title="关闭"><X size={18} /></button></header>
      <p id={descriptionId} className={styles.message}>{request.message}</p>
      {naming && (request.multiline
        ? <textarea ref={input as React.RefObject<HTMLTextAreaElement>} disabled={saving} className={styles.input} aria-label={request.message} rows={4} value={value} onChange={event => setValue(event.target.value)} />
        : <input ref={input as React.RefObject<HTMLInputElement>} disabled={saving} className={styles.input} aria-label={request.message} value={value} onChange={event => setValue(event.target.value)} />)}
      {naming && maxLength !== null && value.trim().length > maxLength && <p role="alert" className={styles.message}>最多 {maxLength} 字，请缩短后再提交。</p>}
      {error && <p role="alert" className={styles.message}>{error}</p>}
      <footer className={styles.actions}>
        <button ref={cancel} type="button" disabled={saving} className={styles.secondary} onClick={dismiss}>取消</button>
        <button type="submit" className={request.danger ? styles.danger : styles.primary} disabled={!valid || saving}>{saving ? '保存中…' : request.confirmLabel || (naming ? '保存名称' : '继续')}</button>
      </footer>
    </form>
  </dialog>, document.body);
}

export function useProductDialog() {
  const [request, setRequest] = useState<Request | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const resolver = useRef<((value: string | null) => void) | null>(null);
  const resolve = useCallback((value: string | null) => {
    const pending = resolver.current;
    resolver.current = null;
    setRequest(null);
    pending?.(value);
  }, []);
  useEffect(() => () => { resolver.current?.(null); resolver.current = null; }, []);
  useEffect(() => {
    let clearTrigger: ReturnType<typeof setTimeout> | undefined;
    const rememberTrigger = (event: MouseEvent) => {
      const element = event.target instanceof Element ? event.target.closest<HTMLElement>('button, [role="button"], a[href], input[type="submit"], summary') : null;
      trigger.current = element;
      // Only use this click for its own action, never an unrelated later request.
      clearTimeout(clearTrigger);
      clearTrigger = setTimeout(() => { if (trigger.current === element) trigger.current = null; }, 0);
    };
    document.addEventListener('click', rememberTrigger, true);
    return () => { document.removeEventListener('click', rememberTrigger, true); clearTimeout(clearTrigger); };
  }, []);
  const ask = useCallback((message: string, options: Options, value?: string) => {
    // A repeated trigger never replaces or affirms an already open decision.
    if (resolver.current) return Promise.resolve(null);
    return new Promise<string | null>(done => {
      resolver.current = done;
      const focused = document.activeElement instanceof HTMLElement
        ? document.activeElement.closest<HTMLElement>('button, [role="button"], a[href], input, textarea, select, summary') : null;
      setRequest({ ...options, message, value, anchor: options.anchor !== undefined ? options.anchor : trigger.current || focused });
    });
  }, []);
  const confirm = useCallback(async (message: string, options: Options = {}) => (await ask(message, options)) !== null, [ask]);
  const prompt = useCallback((message: string, value = '', options: Options = {}) => ask(message, options, value), [ask]);
  return { confirm, prompt, productDialog: request ? <ProductDialog request={request} onResolve={resolve} /> : null };
}
