'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { ClipboardPaste, Copy } from 'lucide-react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import styles from './ContextClipboardActions.module.css';

type Props = {
  value: string;
  textareaRef: RefObject<HTMLTextAreaElement>;
  onPaste(value: string): void;
  maxLength: number;
  disabled?: boolean;
  canCopy?: boolean;
};

export function ContextClipboardActions(props: Props) {
  const { value, textareaRef, disabled = false, canCopy = true } = props;
  const latest = useRef(props);
  latest.current = props;
  const mounted = useRef(true);
  const working = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const { user } = useAppSession();
  const owner = user?.id || '';
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const probeSequence = useRef(0);
  const readPermission = useRef<PermissionStatus | null>(null);
  const [readable, setReadable] = useState(false);
  useEffect(() => {
    const invalidate = () => { probeSequence.current++; setReadable(false); };
    invalidate();
    window.addEventListener('blur', invalidate);
    document.addEventListener('visibilitychange', invalidate);
    navigator.clipboard?.addEventListener('clipboardchange', invalidate);
    const dialog = textareaRef.current?.closest('dialog');
    dialog?.addEventListener('close', invalidate);
    return () => { invalidate(); readPermission.current && (readPermission.current.onchange = null); window.removeEventListener('blur', invalidate); document.removeEventListener('visibilitychange', invalidate); navigator.clipboard?.removeEventListener('clipboardchange', invalidate); dialog?.removeEventListener('close', invalidate); };
  }, [owner, textareaRef]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  // Only a paste-intent interaction (or our explicit copy) may probe an already granted read.
  // Unknown permissions never trigger a read/prompt; no clipboard body is cached.
  async function checkReadable() {
    const input = textareaRef.current;
    if (working.current || latest.current.disabled || !input?.getClientRects().length || document.hidden || !document.hasFocus()) return;
    const sequence = ++probeSequence.current;
    const valid = () => mounted.current && currentOwner.current === owner && probeSequence.current === sequence && !latest.current.disabled && !document.hidden && document.hasFocus() && input === textareaRef.current && Boolean(input.getClientRects().length);
    try {
      const permission = await navigator.permissions.query({ name: 'clipboard-read' as PermissionName });
      if (!valid() || permission.state !== 'granted') { if (valid()) setReadable(false); return; }
      if (readPermission.current) readPermission.current.onchange = null;
      readPermission.current = permission;
      permission.onchange = () => { probeSequence.current++; if (mounted.current) setReadable(false); };
      const text = await navigator.clipboard.readText();
      if (valid()) setReadable(Boolean(text.trim()) && text.length <= latest.current.maxLength);
    } catch { if (valid()) setReadable(false); }
  }

  async function copy() {
    if (working.current || disabled || !canCopy || !value) return;
    working.current = true; setBusy(true); setMessage('');
    try { await navigator.clipboard.writeText(value); if (mounted.current && currentOwner.current === owner) setMessage('已复制'); }
    catch { if (mounted.current && currentOwner.current === owner) setMessage('复制失败，请重试'); }
    finally { working.current = false; if (mounted.current) { setBusy(false); void checkReadable(); } }
  }

  async function paste(button: HTMLButtonElement) {
    const input = textareaRef.current;
    if (working.current || disabled || !input || input.disabled || input.readOnly) return;
    working.current = true; setBusy(true); setMessage('');
    const sequence = ++probeSequence.current;
    const canReport = () => mounted.current && currentOwner.current === owner && input === textareaRef.current && Boolean(input.getClientRects().length) && !latest.current.disabled;
    try {
      const text = await navigator.clipboard.readText();
      if (currentOwner.current !== owner || sequence !== probeSequence.current) { if (canReport()) setMessage('读取已中断，请重新粘贴'); return; }
      if (!mounted.current || input !== textareaRef.current || !input.getClientRects().length) return;
      if (latest.current.disabled || input.disabled || input.readOnly) return;
      if (latest.current.value !== value || input.value !== value) { setMessage('内容已变化，请重新粘贴'); return; }
      setReadable(Boolean(text.trim()) && text.length <= latest.current.maxLength);
      if (!text.trim()) { setMessage('剪贴板中没有可用文本'); return; }
      const next = text;
      if (next.length > latest.current.maxLength) { setMessage(`上下文最多 ${latest.current.maxLength} 字，未替换`); return; }
      if (next === value) setMessage('内容未变化');
      else { latest.current.onPaste(next); setMessage('已替换全文'); }
      requestAnimationFrame(() => {
        if (!mounted.current || currentOwner.current !== owner || sequence !== probeSequence.current || latest.current.disabled || input.disabled || input.readOnly || !input.getClientRects().length || input !== textareaRef.current || input.value !== next) return;
        if (document.activeElement !== button && document.activeElement !== input) return;
        input.focus({ preventScroll: true });
        input.setSelectionRange(next.length, next.length);
      });
    } catch { if (canReport()) { setReadable(false); setMessage('无法读取剪贴板，请在输入框内粘贴'); } }
    finally { working.current = false; if (mounted.current) setBusy(false); }
  }

  return <div className={styles.bar} aria-busy={busy}>
    {message && <span className={styles.message} role="status">{message}</span>}
    <div className={styles.actions}>
      {canCopy && <button type="button" className={styles.button} title="复制上下文全文" aria-label="复制上下文全文" disabled={disabled || busy || !value} onClick={() => void copy()}><Copy size={15} />复制</button>}
      <button type="button" className={styles.button} data-readable={readable && !disabled || undefined} title={readable ? '有可用文本，粘贴并替换全文' : '点击读取剪贴板并替换全文'} aria-label="粘贴并替换上下文全文" disabled={disabled || busy} onPointerEnter={() => void checkReadable()} onFocus={() => void checkReadable()} onClick={event => void paste(event.currentTarget)}><ClipboardPaste size={15} />粘贴并替换全文</button>
    </div>
  </div>;
}
