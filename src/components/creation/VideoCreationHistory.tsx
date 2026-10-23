'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { RelativeTime } from '@/components/RelativeTime';
import { authorizeTaskReuseHref } from '@/lib/navigation/task-reuse';
import styles from './creation.module.css';
type Version = { id: string; project_id: string | null; local_status: string; model: string; created_at: string;
  derivation_kind: string | null; parentTaskId: string | null; parentUnavailable: boolean; play_url?: string | null; stable_download_ready?: boolean };
type Delivery = { canManage: boolean; rootTaskId: string; revision: number; selection: null | { selected_task_id: string | null; state: string; revision: number; owner_id: string };
  legacyCard?: { id: string; status: string } | null; operation?: { state: string } | null };
export default function VideoCreationHistory({ taskId, ownerId, projectId, videoCardId, reuseHref }: { taskId: string; ownerId: string; projectId?: string | null; videoCardId?: string | null; reuseHref?: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false), [items, setItems] = useState<Version[]>([]), [delivery, setDelivery] = useState<Delivery | null>(null);
  const [cursor, setCursor] = useState<string | null>(null), [total, setTotal] = useState(0), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [sameBatch, setSameBatch] = useState<Version[]>([]);
  const [comparison, setComparison] = useState<string[]>([]), [reason, setReason] = useState('');
  const scope = `${ownerId}:${taskId}`, current = useRef(scope); current.current = scope;
  const storageKey = `sd2-delivery-operation-v2:${scope}`;
  const [pending, setPending] = useState<{ request_id: string; body: Record<string, unknown> } | null>(null);
  const read = useCallback(async (next?: string | null) => {
    const captured = current.current; setBusy(true); setMessage('');
    try {
      const [versionsResponse, deliveryResponse] = await Promise.all([
        fetch(`/api/tasks/${taskId}/versions${next ? `?cursor=${encodeURIComponent(next)}` : ''}`, { cache: 'no-store' }),
        fetch(`/api/tasks/${taskId}/delivery`, { cache: 'no-store' })]);
      const versions = await versionsResponse.json(), state = await deliveryResponse.json();
      if (captured !== current.current) return;
      if (!versionsResponse.ok || !deliveryResponse.ok) throw new Error(versions.error || state.error || '版本与交付暂时无法读取');
      setItems(old => next ? [...old, ...versions.items.filter((item: Version) => !old.some(row => row.id === item.id))] : versions.items);
      setSameBatch(versions.sameBatchItems || []); setTotal(versions.total); setCursor(versions.nextCursor); setDelivery(state);
    } catch (cause) { if (captured === current.current) setMessage(cause instanceof Error ? cause.message : '暂时无法确认'); }
    finally { if (captured === current.current) setBusy(false); }
  }, [taskId]);
  useEffect(() => { setItems([]); setDelivery(null); setOpen(false); setComparison([]); setPending(null); try { const saved = sessionStorage.getItem(storageKey); if (saved) setPending(JSON.parse(saved)); } catch { setMessage('原交付操作记录暂时无法读取，请保留本机数据'); } }, [scope, storageKey]);
  const query = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/tasks/${taskId}/delivery?request_id=${encodeURIComponent(pending.request_id)}`, { cache: 'no-store' });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || '原操作暂时无法确认');
      setDelivery(data);
      if (data.operation?.state) { sessionStorage.removeItem(storageKey); setPending(null); setMessage(data.operation.state === 'closed' ? '本次操作已结束' : '已读取原交付操作'); }
      else setMessage('原操作仍待确认，只查询，不会再次提交。');
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : '原操作待确认'); }
    finally { setBusy(false); }
  };
  const mutate = async (action: string, selected?: string) => {
    if (!delivery || pending) return;
    const operation = { request_id: crypto.randomUUID(), body: { action, expected_revision: delivery.revision,
      ...(selected ? { selected_task_id: selected } : {}), ...(action === 'reopen-request' ? { reason } : {}) } };
    try { sessionStorage.setItem(storageKey, JSON.stringify(operation)); } catch { setMessage('操作号未能安全保存，尚未发送'); return; }
    setPending(operation); setBusy(true);
    try {
      const response = await fetch(`/api/tasks/${taskId}/delivery${action === 'reopen-request' ? '/reopen-request' : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...operation.body, request_id: operation.request_id }) });
      const data = await response.json();
      if (!response.ok) { if (response.status < 500) { sessionStorage.removeItem(storageKey); setPending(null); } throw new Error(data.error || '原操作结果待确认'); }
      if (!data.operation?.state) throw new Error('原操作回执待确认，请查询原号');
      sessionStorage.removeItem(storageKey); setPending(null); setMessage(action === 'reopen-request' ? '重开申请已提交，批准后不会自动生成' : '交付操作已保存'); await read();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : '原操作待确认'); }
    finally { setBusy(false); }
  };
  const endOperation = async () => {
    if (!pending || pending.body.action === 'reopen-request') return;
    setBusy(true);
    try { const response = await fetch(`/api/tasks/${taskId}/delivery/operations/${pending.request_id}/close`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pending.body) }); const data = await response.json(); if (!response.ok || !data.operation?.state) throw new Error(data.error || '原操作尚不能结束'); sessionStorage.removeItem(storageKey); setPending(null); await read(); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : '暂时无法确认'); } finally { setBusy(false); }
  };
  const continueCreation = () => {
    if (!reuseHref) return;
    const url = new URL(reuseHref, location.origin); url.searchParams.set('continuation_task_id', taskId);
    if (projectId) url.searchParams.set('project_id', projectId);
    if (videoCardId) url.searchParams.set('video_card_id', videoCardId);
    const href = authorizeTaskReuseHref(`${url.pathname}${url.search}`, ownerId);
    if (href) router.push(href); else setMessage('浏览器未能保存本次继续操作，请重试');
  };
  return <details className={styles.panel} open={open} onToggle={event => { const next = event.currentTarget.open; setOpen(next); if (next && !delivery && !busy) void read(); }}>
    <summary>版本与交付</summary>
    {busy && <p role="status">正在核对原记录</p>}
    {message && <p role="status">{message}</p>}
    {pending && <div className={styles.actions}><button className="btn btn-secondary" type="button" disabled={busy} onClick={() => void query()}>查询原操作</button>{pending.body.action !== 'reopen-request' && <button className={styles.textAction} type="button" disabled={busy} onClick={() => void endOperation()}>核对并结束本次操作</button>}</div>}
    <div className={styles.actions}>{reuseHref && <button type="button" className="btn btn-secondary" disabled={delivery?.selection?.state === 'locked'} onClick={continueCreation}>继续调整原链</button>}<button type="button" className={styles.textAction} disabled={busy} onClick={() => void read()}>重新读取</button></div>
    <p>{delivery?.selection?.state === 'locked' ? '本条创作链已锁定，继续调整和更换交付需要先申请重开。' : '选择交付成品后仍可继续调整；锁定只影响这条版本链。'}{delivery && !delivery.canManage && ' 交付由原作者或项目负责人管理。'}</p>
    {delivery?.legacyCard && !['draft','active','reviewing'].includes(delivery.legacyCard.status) && <p>原视频卡当前为 {delivery.legacyCard.status}，原卡锁定仍有效。 <a href={`/approvals?type=video_card_reopen&project_id=${encodeURIComponent(projectId || '')}&video_card_id=${encodeURIComponent(delivery.legacyCard.id)}`}>申请重开原视频卡</a></p>}
    <div className={styles.versions}>{items.map(item => <div className={styles.version} key={item.id}>
      <Link href={`/tasks/${item.id}?return_to=${encodeURIComponent(`/tasks/${taskId}`)}`}>{item.id}</Link><button className={styles.textAction} type="button" onClick={() => void navigator.clipboard.writeText(item.id)}>复制编号</button>
      <span>{item.derivation_kind === 'enhance' ? '画质加工' : item.derivation_kind === 'draft_upgrade' ? 'Draft升级' : item.parentTaskId ? '继续调整' : '独立结果'} · {item.local_status}</span><RelativeTime value={item.created_at} />
      {item.parentUnavailable && <span>部分来源不可用</span>}{delivery?.selection?.selected_task_id === item.id && <strong>当前交付</strong>}
      {item.play_url && <label><input type="checkbox" checked={comparison.includes(item.id)} disabled={!comparison.includes(item.id) && comparison.length >= 2} onChange={event => setComparison(old => event.target.checked ? [...old, item.id].slice(-2) : old.filter(id => id !== item.id))} />比较</label>}
      {delivery?.canManage && delivery.selection?.state !== 'locked' && item.stable_download_ready && <button className="btn btn-secondary" type="button" disabled={busy || !!pending} onClick={() => void mutate('select', item.id)}>选为交付</button>}
    </div>)}</div>
    {sameBatch.length > 0 && <details><summary>同批结果</summary>{sameBatch.map(item => <p key={item.id}><Link href={`/tasks/${item.id}`}>{item.id}</Link> · {item.local_status}</p>)}<p>同批结果分别受理，不代表迭代顺序。</p></details>}
    {cursor && <button className="btn btn-secondary" disabled={busy} type="button" onClick={() => void read(cursor)}>加载更多版本（已显示{items.length}/{total}）</button>}
    {comparison.length > 0 && <div className={styles.compare}>{comparison.map(id => <video key={id} controls preload="metadata" src={items.find(item => item.id === id)?.play_url || undefined} />)}</div>}
    {delivery?.canManage && delivery.selection?.state !== 'locked' && delivery.selection?.selected_task_id && <div className={styles.actions}><button type="button" className="btn btn-secondary" disabled={busy || !!pending} onClick={() => void mutate('clear')}>清除交付选择</button><button type="button" className="btn btn-secondary" disabled={busy || !!pending} onClick={() => void mutate('lock')}>锁定交付</button></div>}
    {delivery?.selection?.state === 'locked' && <div><label>重开原因<input className="input" value={reason} onChange={event => setReason(event.target.value)} /></label><button type="button" className="btn btn-secondary" disabled={busy || !!pending || !reason.trim()} onClick={() => void mutate('reopen-request')}>申请重开</button> <a href="/approvals">查看审批</a></div>}
  </details>;
}
