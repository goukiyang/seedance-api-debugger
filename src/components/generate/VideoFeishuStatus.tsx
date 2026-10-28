'use client';

import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import { videoFeishuErrorText } from '@/lib/video/feishu-errors';
import styles from './video-feishu.module.css';

type Status = { version: 1; state: string; canCancel: boolean; videoSent: boolean; explanationSent: boolean; mode: 'video' | 'link' | null };
const labels: Record<string, string> = { pending: '等待成品与飞书发送', preparing: '正在准备飞书发送', uploading: '正在上传视频到飞书',
  sending: '正在发送到本人飞书', sent_video: '视频与说明已发送到本人飞书', sent_link: '成品链接已发送到本人飞书',
  video_sent_explanation_pending: '视频已发送，说明待发送', cancelled: '已取消本次飞书发送', failed: '飞书发送未完成', unknown: '飞书发送结果待核对' };
export function VideoFeishuStatus({ owner, taskId }: { owner: string; taskId: string }) {
  const session = useAppSession(), scope = `${owner}:${taskId}`;
  const current = useRef({ scope, ready: false }), alive = useRef(true), lock = useRef(false), sequence = useRef(0);
  current.current = { scope, ready: session.hasLoadedUser && !session.userLoadError && !session.sessionChanged && session.user?.id === owner };
  const [value, setValue] = useState<Status | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [uncertainCancel, setUncertainCancel] = useState(false);
  const valid = () => alive.current && current.current.scope === scope && current.current.ready && !isClientSessionBlocked();
  async function run(cancel = false) {
    if (!valid() || lock.current) return;
    const seq = ++sequence.current; lock.current = true; setBusy(true); setError('');
    if (cancel) setUncertainCancel(true);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/feishu`, { method: cancel ? 'POST' : 'GET', cache: 'no-store',
        headers: { 'x-app-session-user': owner, ...(cancel ? { 'Content-Type': 'application/json' } : {}) },
        ...(cancel ? { body: JSON.stringify({ version: 1, action: 'cancel' }) } : {}), signal: AbortSignal.timeout(15_000) });
      const data = await response.json();
      if (!valid() || seq !== sequence.current) return;
      if (response.status === 403 || response.status === 404 || response.status === 401) { setValue(null); return; }
      if (!response.ok) throw new Error(videoFeishuErrorText(data.error));
      if (data.version !== 1 || data.state !== 'not_requested' && !Object.hasOwn(labels, data.state)
        || ['canCancel', 'videoSent', 'explanationSent'].some(key => typeof data[key] !== 'boolean')
        || ![null, 'video', 'link'].includes(data.mode)) throw new Error('飞书发送记录暂不可核对');
      setValue(data); setUncertainCancel(false);
    } catch (cause) { if (valid() && seq === sequence.current) setError(cause instanceof Error ? cause.message : '飞书发送记录暂不可核对'); }
    finally { if (valid() && seq === sequence.current) { lock.current = false; setBusy(false); } }
  }
  useEffect(() => {
    alive.current = true; sequence.current++; lock.current = false; setValue(null); setError(''); setUncertainCancel(false);
    if (current.current.ready) void run();
    return () => { alive.current = false; sequence.current++; };
    // A task-local read never opts in or starts a delivery.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, session.hasLoadedUser, session.user?.id, session.sessionChanged, session.userLoadError]);
  if (!current.current.ready || !value && !error || value?.state === 'not_requested' && !error) return null;
  const label = value && (value.videoSent && value.state === 'failed' ? '视频已发送，说明未完成'
    : value.videoSent && value.state === 'unknown' ? '视频已发送，说明结果待核对' : labels[value.state]);
  return <div className={styles.status} role="status" aria-busy={busy}>
    <span>{label || '飞书发送记录暂不可核对'}</span><button type="button" title="核对飞书发送状态" aria-label="核对飞书发送状态" disabled={busy} onClick={() => void run()}><RefreshCw size={14} /></button>
    {value?.canCancel && !uncertainCancel && <button type="button" disabled={busy} onClick={() => void run(true)}>取消本次发送</button>}
    {error && <span>{error}{uncertainCancel ? '；取消结果未确认，请先核对状态' : ''}</span>}
  </div>;
}
