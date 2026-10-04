'use client';

import { useEffect, useRef, useState } from 'react';
import { Copy, RefreshCw } from 'lucide-react';
import styles from './studio.module.css';

export function ContextVersionLabel({ code, state = 'loading', unsaved = false, onRetry }: {
  code?: string | null; state?: string; unsaved?: boolean; onRetry?: () => void;
}) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  useEffect(() => { sequence.current += 1; setMessage(''); setBusy(false); }, [code]);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(''), 2500);
    return () => clearTimeout(timer);
  }, [message]);
  async function copy() {
    if (!code || busy) return;
    const request = sequence.current;
    setBusy(true);
    try { await navigator.clipboard.writeText(code); if (request === sequence.current) setMessage('已复制'); }
    catch { if (request === sequence.current) setMessage('复制失败，请重试'); }
    finally { if (request === sequence.current) setBusy(false); }
  }
  return <span className={styles.contextVersion}>
    {code ? <button type="button" className={styles.contextCode} title="模块上下文版本，点击复制" aria-label={`复制模块上下文版本 ${code}`} disabled={busy}
      onClick={event => { event.stopPropagation(); void copy(); }} onDoubleClick={event => event.stopPropagation()}><span>{code}</span><Copy size={12} /></button>
      : <span className={styles.contextCode} title="模块上下文版本">{state === 'missing' ? '未记录' : state === 'error' ? '读取失败' : '读取中'}</span>}
    {unsaved && <small>未保存</small>}
    {state === 'error' && onRetry && <button type="button" title="重试读取模块上下文版本" aria-label="重试读取模块上下文版本" onClick={event => { event.stopPropagation(); onRetry(); }}><RefreshCw size={12} /></button>}
    {message && <small role="status">{message}</small>}
  </span>;
}

export function useModuleContextVersion({ moduleId, raw, taskId, editable, enabled, composing }: {
  moduleId: string; raw: string; taskId: string | null; editable: boolean; enabled: boolean; composing: boolean;
}) {
  const identity = JSON.stringify({ moduleId, raw: editable && !taskId ? raw : undefined, taskId, editable });
  const latest = useRef(identity);
  latest.current = identity;
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ identity: string; code: string | null; state: string } | null>(null);
  useEffect(() => {
    if (!enabled || composing) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch('/api/image-studio/context-version', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ moduleId, ...(taskId ? { taskId } : editable ? { context: raw } : {}) }), signal: controller.signal });
        const value = await response.json();
        if (!response.ok) throw new Error();
        if (!controller.signal.aborted && latest.current === identity) setResult({ identity, code: value.code, state: value.state });
      } catch { if (!controller.signal.aborted && latest.current === identity) setResult({ identity, code: null, state: 'error' }); }
    }, 450);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [identity, moduleId, raw, taskId, editable, enabled, composing, retry]);
  return { code: !composing && result?.identity === identity ? result.code : null,
    state: !composing && result?.identity === identity ? result.state : 'loading', onRetry: () => setRetry(value => value + 1) };
}
