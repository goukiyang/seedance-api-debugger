'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import type { VideoFeishuChoice } from '@/lib/video/feishu-contract';
import { videoFeishuErrorText } from '@/lib/video/feishu-errors';

type Preference = { version: 1; enabled: boolean; revision: number; available: boolean };
function preference(value: unknown): Preference {
  const v = value as Preference;
  if (v?.version !== 1 || typeof v.enabled !== 'boolean' || !Number.isSafeInteger(v.revision) || v.revision < 0 || typeof v.available !== 'boolean') throw new Error('飞书设置暂不可核对');
  return v;
}
export function useVideoFeishu(owner: string, active: boolean) {
  const scope = active ? owner : '';
  const current = useRef(scope); current.current = scope;
  const sequence = useRef(0), alive = useRef(true), lock = useRef(false);
  const [saved, setSaved] = useState<{ owner: string; value: Preference } | null>(null);
  const [desired, setDesired] = useState<boolean | null>(null), desiredRef = useRef<boolean | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const valid = (captured: string) => alive.current && Boolean(captured) && current.current === captured && !isClientSessionBlocked();
  const read = useCallback(async () => {
    const captured = scope, seq = ++sequence.current;
    if (!valid(captured) || lock.current) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/user/video-feishu', { cache: 'no-store', headers: { 'x-app-session-user': captured }, signal: AbortSignal.timeout(15_000) });
      const data = await response.json();
      if (!valid(captured) || seq !== sequence.current) return;
      if (!response.ok) throw new Error(videoFeishuErrorText(data.error));
      const next = preference(data);
      setSaved({ owner: captured, value: next });
      if (desiredRef.current === next.enabled) { desiredRef.current = null; setDesired(null); }
      else if (desiredRef.current !== null) setError('本次选择尚未保存');
    } catch (cause) { if (valid(captured) && seq === sequence.current) setError(cause instanceof Error ? cause.message : '飞书设置暂不可读取'); }
    finally { if (valid(captured) && seq === sequence.current) setBusy(false); }
    // The mutable desired choice never causes a second automatic read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);
  useEffect(() => {
    alive.current = true; sequence.current++; lock.current = false;
    desiredRef.current = null; setDesired(null); setSaved(null); setError(''); setBusy(false);
    if (scope) void read();
    return () => { alive.current = false; sequence.current++; };
  }, [scope, read]);
  async function change(enabled: boolean) {
    const captured = scope, value = saved?.owner === captured ? saved.value : null;
    if (!valid(captured) || lock.current || !value || enabled && !value.available) return;
    // An unconfirmed opt-out must immediately remove consent from new submissions.
    desiredRef.current = enabled; setDesired(enabled); setError(''); setBusy(true); lock.current = true;
    const seq = ++sequence.current;
    try {
      const response = await fetch('/api/user/video-feishu', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-app-session-user': captured },
        body: JSON.stringify({ version: 1, enabled, revision: value.revision }), signal: AbortSignal.timeout(15_000) });
      const data = await response.json();
      if (!valid(captured) || seq !== sequence.current) return;
      if (!response.ok) throw new Error(videoFeishuErrorText(data.error));
      const next = preference(data); setSaved({ owner: captured, value: next });
      if (next.enabled !== enabled) throw new Error('本次选择尚未保存');
      desiredRef.current = null; setDesired(null);
    } catch (cause) { if (valid(captured) && seq === sequence.current) setError(cause instanceof Error ? cause.message : '飞书设置未确认，请重新读取'); }
    finally { if (valid(captured) && seq === sequence.current) { lock.current = false; setBusy(false); } }
  }
  const value = saved?.owner === scope && scope ? saved.value : null;
  const choice: VideoFeishuChoice | undefined = value?.enabled && value.available && desired === null && !busy && !error && !isClientSessionBlocked()
    ? { version: 1, enabled: true, preferenceRevision: value.revision } : undefined;
  return { ready: Boolean(value), available: value?.available ?? false, enabled: desired !== null ? false : value?.enabled ?? false,
    busy, error, unsaved: desired !== null, choice, read, change, retry: () => desiredRef.current === null ? read() : change(desiredRef.current) };
}
