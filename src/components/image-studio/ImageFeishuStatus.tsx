'use client';

import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import { videoFeishuErrorText } from '@/lib/video/feishu-errors';
import styles from '@/components/generate/video-feishu.module.css';

export type ImageFeishuView = { version: 1; state: string; canCancel: boolean; canRetry: boolean; imageSent: boolean;
  explanationSent: boolean; mode: 'image' | 'link' | null; reason?: string | null };
const labels: Record<string, string> = { pending: '等待图片就绪', preparing: '正在准备飞书图片', uploading: '正在上传图片到飞书',
  sending: '正在发送', sent_image: '已发送图片', sent_link: '仅发送查看链接', image_sent_explanation_pending: '图片已发送，说明待发送',
  cancelled: '已取消本次飞书发送', failed: '发送未完成', unknown: '发送结果待确认' };

export function ImageFeishuStatus({ owner, taskId, initial, onChanged }: { owner: string; taskId: string;
  initial?: ImageFeishuView | null; onChanged?: () => void }) {
  const session = useAppSession(), scope = `${owner}:${taskId}`;
  const current = useRef({ scope, ready: false });
  const sequence = useRef(0), lock = useRef(false), alive = useRef(true);
  const [value, setValue] = useState(initial || null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [mutationUnknown, setMutationUnknown] = useState(false);
  const signature = JSON.stringify(initial || null);
  const ready = session.hasLoadedUser && !session.sessionChanged && !session.userLoadError && session.user?.id === owner;
  current.current = { scope, ready };
  useEffect(() => { alive.current = true; sequence.current++; lock.current = false; setValue(initial || null);
    setError(''); setMutationUnknown(false); setBusy(false);
    return () => { alive.current = false; sequence.current++; };
    // The server projection refreshes a result; it never starts delivery from the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, signature]);
  const valid = () => alive.current && current.current.scope === scope && current.current.ready && !isClientSessionBlocked();
  async function run(action?: 'cancel' | 'retry') {
    if (!valid() || lock.current) return;
    const seq = ++sequence.current; lock.current = true; setBusy(true); setError('');
    if (action) setMutationUnknown(true);
    try {
      const response = await fetch(`/api/image-studio/tasks/${encodeURIComponent(taskId)}/feishu`, { method: action ? 'POST' : 'GET', cache: 'no-store',
        headers: { 'x-app-session-user': owner, ...(action ? { 'Content-Type': 'application/json' } : {}) },
        ...(action ? { body: JSON.stringify({ version: 1, action }) } : {}), signal: AbortSignal.timeout(15_000) });
      const data = await response.json();
      if (!valid() || seq !== sequence.current) return;
      if ([401,403,404].includes(response.status)) { setValue(null); return; }
      if (!response.ok) throw new Error(videoFeishuErrorText(data.error));
      if (data.version !== 1 || data.state !== 'not_requested' && !Object.hasOwn(labels, data.state)
        || ['canCancel','canRetry','imageSent','explanationSent'].some(key => typeof data[key] !== 'boolean')
        || ![null,'image','link'].includes(data.mode)) throw new Error('发送记录暂不可核对');
      setValue(data); setMutationUnknown(false); onChanged?.();
    } catch (cause) { if (valid() && seq === sequence.current) setError(cause instanceof Error ? cause.message : '发送记录暂不可核对'); }
    finally { if (valid() && seq === sequence.current) { lock.current = false; setBusy(false); } }
  }
  if (!ready || !value && !error || value?.state === 'not_requested' && !error) return null;
  const label = value?.imageSent && value.state === 'failed' ? '图片已发送，说明未完成'
    : value?.imageSent && value.state === 'unknown' ? '图片已发送，说明结果待确认' : labels[value?.state || ''];
  return <div className={styles.status} role="status" aria-busy={busy}>
    <span>{label || '发送记录待核对'}</span>
    <button type="button" title="核对飞书发送状态" aria-label="核对飞书发送状态" disabled={busy} onClick={() => void run()}><RefreshCw size={14}/></button>
    {value?.canCancel && !mutationUnknown && <button type="button" disabled={busy} onClick={() => void run('cancel')}>取消本次发送</button>}
    {value?.canRetry && !mutationUnknown && <button type="button" disabled={busy} onClick={() => void run('retry')}>继续本次发送</button>}
    {error && <span>{error}{mutationUnknown ? '；操作结果待确认，请先核对状态' : ''}</span>}
  </div>;
}
