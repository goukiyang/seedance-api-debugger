'use client';
import { useEffect, useRef, useState } from 'react';
import { Copy, Send, X } from 'lucide-react';
import type { MultiviewWorkDto } from '@/lib/video/multiview-work-contract';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import { useMultiviewShareOperation } from './useMultiviewShareOperation';
import styles from './multiview-share.module.css';
type Grant = { id: string; revision: number; revoked_at: string | null; recipients: Array<{ user_id: string; name: string; revoked_at: string | null }> };
export function MultiviewShareDialog({ owner, work, onClose, blockedReason = '', recovery }: { owner: string; work: MultiviewWorkDto; onClose: () => void; blockedReason?: string; recovery?: { label: string; run: () => void; disabled?: boolean } }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [q, setQ] = useState(''), [people, setPeople] = useState<Array<{ id: string; name: string }>>([]), [next, setNext] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]), [error, setError] = useState(''), [message, setMessage] = useState(''), [href, setHref] = useState('');
  const [management, setManagement] = useState(false), [grants, setGrants] = useState<Grant[]>([]);
  const [grantNext, setGrantNext] = useState<string | null>(null);
  const peopleRequest = useRef(0), grantRequest = useRef(0);
  const identity = `${owner}:${work.id}`, live = useRef(identity); live.current = identity;
  async function readGrants(after = '') {
    const sequence = ++grantRequest.current;
    const response = await fetch(`/api/video/multiview/shares?workId=${encodeURIComponent(work.id)}&after=${encodeURIComponent(after)}`, { cache: 'no-store', headers: { 'x-app-session-user': owner }, signal: AbortSignal.timeout(30000) });
    const data = await response.json();
    if (live.current !== identity || sequence !== grantRequest.current || isClientSessionBlocked()) return;
    if (!response.ok) throw new Error(data.error || '分享记录暂不可读取');
    setGrants(old => after ? [...old, ...(data.shares || []).filter((grant: Grant) => !old.some(value => value.id === grant.id))] : data.shares || []); setGrantNext(data.next);
  }
  const operation = useMultiviewShareOperation(owner, `work:${work.id}`, receipt => {
    if (receipt.href && receipt.action === 'copy') {
      const url = new URL(receipt.href, window.location.origin).href; setHref(url);
      const copy = navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject(new Error('Clipboard unavailable'));
      void copy.then(() => { if (live.current === identity) setMessage('授权链接已复制，未发送通知。'); }, () => { if (live.current === identity) setMessage('未能写入剪贴板，可选中下方链接复制。'); });
    } else setMessage(receipt.action === 'send' ? '已发送站内通知。' : '分享权限已更新。');
    if (management) void readGrants().catch(cause => setError(cause.message));
  });
  useEffect(() => { dialog.current?.showModal(); return () => { live.current = ''; }; }, []);
  async function loadPeople(after?: string) {
    const sequence = ++peopleRequest.current;
    const params = new URLSearchParams({ q }); if (after) params.set('after', after);
    try {
      const response = await fetch(`/api/video/multiview/shares/recipients?${params}`, { cache: 'no-store', headers: { 'x-app-session-user': owner }, signal: AbortSignal.timeout(30000) });
      const data = await response.json();
      if (live.current !== identity || sequence !== peopleRequest.current || isClientSessionBlocked()) return;
      if (!response.ok || !Array.isArray(data.items)) throw new Error(data.error || '同事列表暂不可读取');
      setPeople(old => after ? [...old, ...data.items.filter((person: { id: string }) => !old.some(value => value.id === person.id))] : data.items); setNext(data.next); setError('');
    } catch (cause) { if (live.current === identity && sequence === peopleRequest.current) setError(cause instanceof Error ? cause.message : '同事列表暂不可读取'); }
  }
  useEffect(() => { const timer = setTimeout(() => void loadPeople(), 200); return () => clearTimeout(timer); }, [q, identity]);
  const send = (action: 'copy' | 'send') => {
    if (blockedReason) return;
    setMessage(''); setHref('');
    void operation.send({ action, workId: work.id, revision: work.draftRevision, recipients: selected });
  };
  return <dialog ref={dialog} className={styles.dialog} onCancel={event => { event.preventDefault(); if (!operation.busy) onClose(); }}>
    <header><h2>分享方案</h2><button type="button" aria-label="关闭" title="关闭" disabled={operation.busy} onClick={onClose}><X size={18} /></button></header>
    <p>{work.title}</p>
    {blockedReason && <p role="status">{blockedReason}{recovery && <button type="button" disabled={recovery.disabled} onClick={recovery.run}>{recovery.label}</button>}</p>}
    <input type="search" aria-label="查找同事" placeholder="查找同事" value={q} onChange={event => { peopleRequest.current++; setNext(null); setQ(event.target.value); }} />
    <div className={styles.people}>{people.map(person => <label key={person.id}><input type="checkbox" checked={selected.includes(person.id)} disabled={operation.busy || Boolean(operation.pending) || !selected.includes(person.id) && selected.length >= 50}
      onChange={event => setSelected(old => event.target.checked ? [...old, person.id] : old.filter(id => id !== person.id))} />{person.name}</label>)}{next && <button type="button" onClick={() => void loadPeople(next)}>更多同事</button>}</div>
    <p>{selected.length ? `已选 ${selected.length} 人` : '请选择同事'}</p>
    <footer><button type="button" disabled={Boolean(blockedReason) || !selected.length || operation.busy || Boolean(operation.pending)} onClick={() => send('copy')}><Copy size={16} />复制授权链接</button><button type="button" className={styles.primary} disabled={Boolean(blockedReason) || !selected.length || operation.busy || Boolean(operation.pending)} onClick={() => send('send')}><Send size={16} />发送给同事</button></footer>
    {href && <input aria-label="授权链接" readOnly value={href} onFocus={event => event.currentTarget.select()} />}
    {(error || operation.error || message) && <p role="status">{error || operation.error || message}</p>}
    {operation.pending && <div className={styles.actions}><button type="button" disabled={operation.busy} onClick={() => void operation.query()}>查询原操作</button>{operation.canResume && <button type="button" disabled={operation.busy} onClick={() => void operation.resume()}>恢复原操作</button>}</div>}
    <details open={management} onToggle={event => { setManagement(event.currentTarget.open); if (event.currentTarget.open) void readGrants().catch(cause => setError(cause.message)); }}><summary>管理已分享</summary>
      {grants.map(grant => <div key={grant.id} className={styles.grant}><span>方案修订 {grant.revision} · {grant.revoked_at ? '已停止' : `${grant.recipients.filter(person => !person.revoked_at).length} 人可访问`}</span>
        {!grant.revoked_at && <button type="button" disabled={operation.busy || Boolean(operation.pending)} onClick={() => void operation.send({ action: 'revoke', shareId: grant.id })}>停止分享</button>}
        {!grant.revoked_at && grant.recipients.filter(person => !person.revoked_at).map(person => <button key={person.user_id} type="button" disabled={operation.busy || Boolean(operation.pending)} onClick={() => void operation.send({ action: 'revoke', shareId: grant.id, recipientId: person.user_id })}>撤销 {person.name}</button>)}
      </div>)}
      {grantNext && <button type="button" onClick={() => void readGrants(grantNext).catch(cause => setError(cause.message))}>更多分享</button>}
    </details>
  </dialog>;
}
