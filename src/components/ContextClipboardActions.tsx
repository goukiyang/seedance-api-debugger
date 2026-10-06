'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { ClipboardPaste, Copy } from 'lucide-react';
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
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function copy() {
    if (working.current || disabled || !canCopy || !value) return;
    working.current = true; setBusy(true); setMessage('');
    try { await navigator.clipboard.writeText(value); if (mounted.current) setMessage('已复制'); }
    catch { if (mounted.current) setMessage('复制失败，请重试'); }
    finally { working.current = false; if (mounted.current) setBusy(false); }
  }

  async function paste(button: HTMLButtonElement) {
    const input = textareaRef.current;
    if (working.current || disabled || !input || input.disabled || input.readOnly) return;
    working.current = true; setBusy(true); setMessage('');
    try {
      const text = await navigator.clipboard.readText();
      if (!mounted.current || input !== textareaRef.current || !input.getClientRects().length) return;
      if (latest.current.disabled || input.disabled || input.readOnly) return;
      if (latest.current.value !== value || input.value !== value) { setMessage('内容已变化，请重新粘贴'); return; }
      if (!text) { setMessage('剪贴板中没有文本'); return; }
      const next = text;
      if (next.length > latest.current.maxLength) { setMessage(`上下文最多 ${latest.current.maxLength} 字，未替换`); return; }
      if (next === value) setMessage('内容未变化');
      else { latest.current.onPaste(next); setMessage('已替换全文'); }
      requestAnimationFrame(() => {
        if (!mounted.current || latest.current.disabled || input.disabled || input.readOnly || !input.getClientRects().length || input !== textareaRef.current || input.value !== next) return;
        if (document.activeElement !== button && document.activeElement !== input) return;
        input.focus({ preventScroll: true });
        input.setSelectionRange(next.length, next.length);
      });
    } catch { if (mounted.current) setMessage('无法读取剪贴板，请在输入框内粘贴'); }
    finally { working.current = false; if (mounted.current) setBusy(false); }
  }

  return <div className={styles.bar} aria-busy={busy}>
    {message && <span className={styles.message} role="status">{message}</span>}
    <div className={styles.actions}>
      {canCopy && <button type="button" className={styles.button} title="复制上下文全文" aria-label="复制上下文全文" disabled={disabled || busy || !value} onClick={() => void copy()}><Copy size={15} />复制</button>}
      <button type="button" className={styles.button} title="粘贴并替换全文" aria-label="粘贴并替换上下文全文" disabled={disabled || busy} onClick={event => void paste(event.currentTarget)}><ClipboardPaste size={15} />粘贴并替换全文</button>
    </div>
  </div>;
}
