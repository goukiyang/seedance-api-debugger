'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import styles from './ProductDialog.module.css';

type Options = { title?: string; confirmLabel?: string; danger?: boolean; maxLength?: number };
type Request = Options & { message: string; value?: string; anchor: HTMLElement | null };

function ProductDialog({ request, onResolve }: { request: Request; onResolve: (value: string | null) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [value, setValue] = useState(request.value || '');
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const naming = request.value !== undefined;
  useDialogDismiss({ open: true, dialogRef: dialog, nativeDialog: true, initialFocusRef: naming ? input : cancel, onDismiss: () => onResolve(null) });
  useEffect(() => {
    dialog.current?.showModal();
    (naming ? input.current : cancel.current)?.focus({ preventScroll: true });
    const place = () => {
      const panel = dialog.current;
      if (!naming || !request.anchor?.isConnected || window.innerWidth < 640 || !panel) { setPosition(null); return; }
      const rect = request.anchor.getBoundingClientRect();
      const width = panel.offsetWidth, height = panel.offsetHeight, gap = 8, margin = 16;
      if (rect.bottom < margin || rect.top > window.innerHeight - margin || height > window.innerHeight - 2 * margin) { setPosition(null); return; }
      const top = rect.bottom + gap + height <= window.innerHeight - margin ? rect.bottom + gap : rect.top - gap - height;
      setPosition({ left: Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin)), top: Math.max(margin, Math.min(top, window.innerHeight - height - margin)) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [naming, request.anchor]);
  return createPortal(<dialog ref={dialog} className={styles.dialog} data-anchored={Boolean(position)}
    style={position ? { left: position.left, top: position.top, margin: 0 } : undefined}
    aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
    <form onSubmit={event => { event.preventDefault(); if (!naming || value.trim()) onResolve(naming ? value.trim() : 'yes'); }}>
      <header className={styles.header}><h2 id={titleId}>{request.title || (naming ? '命名' : '确认操作')}</h2>
        <button type="button" className={styles.close} onClick={() => onResolve(null)} aria-label="关闭" title="关闭"><X size={18} /></button></header>
      <p id={descriptionId} className={styles.message}>{request.message}</p>
      {naming && <input ref={input} className={styles.input} aria-label={request.message} maxLength={request.maxLength || 120} value={value} onChange={event => setValue(event.target.value)} />}
      <footer className={styles.actions}>
        <button ref={cancel} type="button" className={styles.secondary} onClick={() => onResolve(null)}>取消</button>
        <button type="submit" className={request.danger ? styles.danger : styles.primary} disabled={naming && !value.trim()}>{request.confirmLabel || (naming ? '保存名称' : '继续')}</button>
      </footer>
    </form>
  </dialog>, document.body);
}

export function useProductDialog() {
  const [request, setRequest] = useState<Request | null>(null);
  const resolver = useRef<((value: string | null) => void) | null>(null);
  const resolve = useCallback((value: string | null) => {
    const pending = resolver.current;
    resolver.current = null;
    setRequest(null);
    pending?.(value);
  }, []);
  useEffect(() => () => { resolver.current?.(null); resolver.current = null; }, []);
  const ask = useCallback((message: string, options: Options, value?: string) => {
    // A repeated trigger never replaces or affirms an already open decision.
    if (resolver.current) return Promise.resolve(null);
    return new Promise<string | null>(done => {
      resolver.current = done;
      setRequest({ ...options, message, value, anchor: document.activeElement instanceof HTMLElement ? document.activeElement : null });
    });
  }, []);
  const confirm = useCallback(async (message: string, options: Options = {}) => (await ask(message, options)) !== null, [ask]);
  const prompt = useCallback((message: string, value = '', options: Options = {}) => ask(message, options, value), [ask]);
  return { confirm, prompt, productDialog: request ? <ProductDialog request={request} onResolve={resolve} /> : null };
}
