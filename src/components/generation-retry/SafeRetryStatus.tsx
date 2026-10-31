'use client';
import { useEffect, useState } from 'react';
import { OctagonX } from 'lucide-react';
import type { publicRetry } from '@/lib/generation-retry/store';
type View = NonNullable<ReturnType<typeof publicRetry>>;
const states: Record<string, string> = { prepared: '等待发送', sent: '已发送', accepted: '已受理', free_failed: '明确失败且不收费', succeeded: '成功', failed: '失败，费用沿原合同', unknown: '原请求待核对' };
export default function SafeRetryStatus({ kind, id, initial, onChanged }: { kind: 'image' | 'video'; id: string; initial?: View | null; onChanged?: () => void }) {
  const [value, setValue] = useState<View | null>(initial || null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const read = async () => {
      const response = await fetch(`/api/generation-retry/${kind}/${id}`, { cache: 'no-store' });
      if (response.status === 404 && timer) clearInterval(timer);
      if (response.ok) { const result = await response.json(); if (live) setValue(result.retry);
        if (['succeeded', 'failed'].includes(result.retry?.state) && timer) clearInterval(timer); }
    };
    if (!initial) void read().catch(() => {});
    timer = setInterval(() => void read().catch(() => {}), 10000);
    return () => { live = false; clearInterval(timer); };
  }, [kind, id, initial]);
  if (!value) return null;
  return <div>
    {value.state === 'wait' && <p role="status">自动重试 {value.retries + 1}/3，等待发送</p>}
    {value.state === 'unknown' && <p role="status">原请求待核对</p>}
    {value.retries > 0 && value.state === 'active' && <p role="status">自动重试 {value.retries}/3</p>}
    {value.canStop && <button type="button" className="btn btn-secondary" disabled={busy} title="停止后续重试" onClick={async () => {
      setBusy(true); setError('');
      try {
        const response = await fetch(`/api/generation-retry/${kind}/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stop' }) });
        const result = await response.json(); if (!response.ok) throw new Error(result.error);
        setValue(result.retry); onChanged?.();
      } catch (cause) { setError(cause instanceof Error ? cause.message : '停止尚未确认'); }
      finally { setBusy(false); }
    }}><OctagonX size={15} />停止后续重试</button>}
    {value.stopped && <p role="status">后续重试已停止</p>}
    {error && <p role="alert">{error}</p>}
    <details><summary>尝试记录（{value.attempts.length}/4）</summary>
      {value.attempts.map(a => <p key={a.ordinal}>第 {a.ordinal + 1} 次：{states[a.state] || a.state}{a.code ? ` / ${a.code}` : ''}</p>)}
    </details>
  </div>;
}
