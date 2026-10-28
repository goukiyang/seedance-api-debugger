'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Check, ImagePlus, RefreshCw, Send, X } from 'lucide-react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import { RelativeTime } from '@/components/RelativeTime';
import { LoadingSkeleton } from '@/components/LoadingState';
import { ResourceLibraryPicker } from '@/components/ResourceLibraryPicker';
import { uploadFileAsAsset } from '@/lib/http/file-upload';
import { ZoomableImagePreview } from '@/components/ZoomableImagePreview';
import styles from './feedback-flow.module.css';

type View = { revision: number; currentRound: number; receivedAt: number | null;
  feedback: { content: string; created_at: string; image_urls_json: string | null };
  round: null | { number: number; summary: string; publishedAt: number; operationId?: string;
    review: null | { operationId: string; result: 'passed' | 'needs_work'; note: string; imageUrls: string[]; at: number };
    delivery: { status: string; error: string | null } } };
type Body = { operationId: string; revision?: number; summary?: string; round?: number; result?: 'passed' | 'needs_work'; note?: string; uploadedAssetIds?: string[]; imageUrls?: string[] };
type Draft = { summary: string; note: string; result: 'passed' | 'needs_work'; assets: Array<{ id: string; url: string; originalUrl: string }> };
const empty: Draft = { summary: '', note: '', result: 'passed', assets: [] };
function deliveryLabel(status: string, error: string | null) {
  if (status === 'sent') return '回测通知已发送';
  if (status === 'pending') return '回测通知待发送';
  if (error?.includes('unknown')) return '通知结果待核对';
  if (error === 'feedback_retest_already_reviewed') return '本人已回测，无需再次通知';
  if (error === 'feedback_retest_superseded') return '已有新的修复轮次，本轮未再通知';
  if (error === 'feedback_author_unbound') return '未绑定飞书，可在本站回测';
  if (error === 'feedback_author_missing') return '原反馈无提交账号，无法通知';
  return '通知未送达，修复记录已保留';
}
function images(raw: string | null) {
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; }
}
export function FeedbackLifecyclePanel({ owner, feedbackId, admin = false, initialRound }: { owner: string; feedbackId: string; admin?: boolean; initialRound?: number }) {
  const session = useAppSession();
  const [round, setRound] = useState(initialRound);
  const scope = `${owner}:${feedbackId}:${admin ? 'admin' : `author:${round ?? 'latest'}`}`;
  const key = `sd2:feedback-action:v1:${scope}`;
  const identity = useRef({ scope, ready: false });
  identity.current = { scope, ready: session.hasLoadedUser && !session.userLoadError && !session.sessionChanged && session.user?.id === owner };
  const live = useRef(true), sequence = useRef(0), request = useRef<AbortController | null>(null), lock = useRef(false);
  const [view, setView] = useState<View | null>(null);
  const [draft, setDraft] = useState<Draft>(empty), [pending, setPending] = useState<Body | null>(null);
  const [hydrated, setHydrated] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [picker, setPicker] = useState(false), [preview, setPreview] = useState<string | null>(null);
  const endpoint = admin ? `/api/admin/feedback/${encodeURIComponent(feedbackId)}` : `/api/feedback/${encodeURIComponent(feedbackId)}`;
  const usable = () => live.current && identity.current.scope === scope && identity.current.ready && !isClientSessionBlocked();
  const remember = (next: Draft, operation: Body | null) => localStorage.setItem(key, JSON.stringify({ version: 1, draft: next, pending: operation }));
  function edit(next: Draft) {
    setDraft(next);
    try { remember(next, pending); } catch { setError('本机暂时无法保存草稿，请保留页面'); }
  }
  async function refresh() {
    if (!usable()) return;
    const seq = ++sequence.current;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setBusy(true); setError('');
    try {
      const query = new URLSearchParams(admin ? { lifecycle: '1' } : {});
      if (round !== undefined) query.set('round', String(round));
      const response = await fetch(`${endpoint}?${query}`, { cache: 'no-store', headers: { 'x-app-session-user': owner }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) });
      const data = await response.json();
      if (!usable() || seq !== sequence.current) return;
      if (!response.ok) throw new Error(data.error || '记录暂不可读取');
      if (!admin && round === undefined && data.currentRound > 0) { setRound(data.currentRound); return; }
      setView(data);
    } catch (cause) { if (usable() && seq === sequence.current) setError(cause instanceof Error ? cause.message : '记录暂不可读取'); }
    finally { if (usable() && seq === sequence.current) setBusy(false); }
  }
  useEffect(() => {
    live.current = true;
    setView(null); setDraft(empty); setPending(null); setPicker(false); setPreview(null);
    try {
      const saved = JSON.parse(localStorage.getItem(key) || 'null');
      if (saved?.version === 1 && typeof saved.draft?.summary === 'string' && typeof saved.draft?.note === 'string'
        && ['passed', 'needs_work'].includes(saved.draft.result) && Array.isArray(saved.draft.assets)) {
        setDraft({ summary: saved.draft.summary.slice(0, 400), note: saved.draft.note.slice(0, 2000), result: saved.draft.result,
          assets: saved.draft.assets.filter((v: { id?: unknown; url?: unknown; originalUrl?: unknown }) => typeof v?.id === 'string' && typeof v.url === 'string' && typeof v.originalUrl === 'string').slice(0, 128) });
        if (saved.pending && typeof saved.pending.operationId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(saved.pending.operationId)) setPending(saved.pending);
      }
    } catch { setError('旧草稿暂不可读取，请保留原页面'); }
    setHydrated(scope);
    return () => { live.current = false; sequence.current++; request.current?.abort(); };
  }, [key, scope]);
  useEffect(() => { if (hydrated === scope && identity.current.ready) void refresh();
    // Only identity confirmation and an explicit round change initiate a read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, scope, round, session.hasLoadedUser, session.user?.id, session.sessionChanged, session.userLoadError]);
  async function submit() {
    if (!usable() || lock.current || !view || hydrated !== scope) return;
    const body: Body = pending || (admin ? { operationId: crypto.randomUUID(), revision: view.revision, summary: draft.summary.trim() }
      : { operationId: crypto.randomUUID(), round: view.round?.number, result: draft.result, note: draft.note.trim(), uploadedAssetIds: draft.assets.map(v => v.id), imageUrls: draft.assets.map(v => v.originalUrl) });
    if (!pending && admin && !body.summary) { setError('请填写公开修复说明'); return; }
    try { remember(draft, body); } catch { setError('原操作暂时无法保存到本机，尚未提交，请稍后重试'); return; }
    setPending(body); lock.current = true; setBusy(true); setError('');
    try {
      const response = await fetch(endpoint, { method: admin ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json', 'x-app-session-user': owner },
        body: JSON.stringify(admin ? { action: 'mark_fixed', ...body } : body), signal: AbortSignal.timeout(30_000) });
      const data = await response.json();
      if (!usable()) return;
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) { remember(draft, null); setPending(null); }
        if (response.status === 409) await refresh();
        if (response.status === 401 || response.status === 403 || response.status === 404) setView(null);
        throw new Error(data.error || '处理结果待核对');
      }
      remember(empty, null); setPending(null); setDraft(empty);
      await refresh();
    } catch (cause) { if (usable()) setError(cause instanceof Error ? cause.message : '结果待核对，请继续核对原操作'); }
    finally { lock.current = false; if (usable()) setBusy(false); }
  }
  if (!identity.current.ready || hydrated !== scope) return <p role="status">正在核对登录状态…</p>;
  const selected = view?.round, editable = !admin && selected && !selected.review && selected.number === view?.currentRound;
  const picture = (url: string, i: number) => <button type="button" key={`${url}:${i}`} onClick={() => setPreview(url)} title={`查看截图${i + 1}`}><img src={url} loading="lazy" decoding="async" alt={`反馈截图${i + 1}`} /></button>;
  return <section className={styles.flow} aria-label="反馈处理与回测" aria-busy={busy}>
    <header className={styles.toolbar}><h3>{admin ? '修复与回测' : '我的反馈'}</h3><button type="button" title="重新读取" aria-label="重新读取反馈处理记录" disabled={busy} onClick={() => void refresh()}><RefreshCw size={16} /></button></header>
    {!view && busy && <LoadingSkeleton label="正在读取处理记录" />}
    {!admin && view && <><p className={styles.body}>{view.feedback.content}</p><RelativeTime value={view.feedback.created_at} /><div className={styles.images}>{images(view.feedback.image_urls_json).map(picture)}</div></>}
    {view && <p className={styles.meta}>{view.receivedAt ? <>已收到 · <RelativeTime value={new Date(view.receivedAt).toISOString()} /></> : '尚未收到接收确认'}</p>}
    {view && view.currentRound > 0 && <label className={styles.round}>修复轮次<select disabled={busy || Boolean(pending)} value={selected?.number || view.currentRound} onChange={event => setRound(Number(event.target.value))}>
      {Array.from({ length: view.currentRound }, (_, i) => view.currentRound - i).map(n => <option key={n} value={n}>第{n}轮</option>)}</select></label>}
    {selected ? <div><p className={styles.body}>{selected.summary}</p><p className={styles.meta}><RelativeTime value={new Date(selected.publishedAt).toISOString()} /> · {deliveryLabel(selected.delivery.status, selected.delivery.error)}</p>
      {selected.review ? <><strong>{selected.review.result === 'passed' ? '本人回测通过' : '本人回测仍有问题'}</strong>{selected.review.note && <p className={styles.body}>{selected.review.note}</p>}<div className={styles.images}>{selected.review.imageUrls.map(picture)}</div></> : <p className={styles.meta}>等待原提交人回测</p>}</div> : view && <p className={styles.meta}>尚无修复记录</p>}
    {error && <p role="alert" className={styles.message}>{error}</p>}{pending && <p role="status">原操作待核对，内容已保留。</p>}
    {admin && view && <div className={styles.form}><label>公开修复说明<textarea rows={3} maxLength={400} value={draft.summary} disabled={busy || Boolean(pending)} onChange={e => edit({ ...draft, summary: e.target.value })} /></label>
      <button type="button" className={styles.primary} disabled={busy || !pending && !draft.summary.trim()} onClick={() => void submit()}><Send size={16} />{busy ? '正在核对…' : pending ? '继续核对原修复操作' : '标记已修复并通知回测'}</button></div>}
    {(editable || !admin && pending) && <div className={styles.form}><div className={styles.choices} role="group" aria-label="本人回测结论">
      <button type="button" aria-pressed={draft.result === 'passed'} disabled={busy || Boolean(pending)} onClick={() => edit({ ...draft, result: 'passed' })}><Check size={16} />通过</button>
      <button type="button" aria-pressed={draft.result === 'needs_work'} disabled={busy || Boolean(pending)} onClick={() => edit({ ...draft, result: 'needs_work' })}>仍有问题</button></div>
      <label>补充说明<textarea rows={3} maxLength={2000} value={draft.note} disabled={busy || Boolean(pending)} onChange={e => edit({ ...draft, note: e.target.value })} /></label>
      <div className={styles.images}>{draft.assets.map(item => <div key={item.id}>{picture(item.url, 0)}<button type="button" title="移除截图" aria-label="移除截图" disabled={busy || Boolean(pending)} onClick={() => edit({ ...draft, assets: draft.assets.filter(v => v.id !== item.id) })}><X size={14} /></button></div>)}</div>
      <div className={styles.toolbar}><button type="button" disabled={busy || Boolean(pending) || draft.assets.length >= 128} onClick={() => setPicker(true)}><ImagePlus size={16} />添加截图</button>
        <button type="button" className={styles.primary} disabled={busy} onClick={() => void submit()}><Send size={16} />{busy ? '正在提交…' : pending ? '继续核对原回测' : '提交回测'}</button></div></div>}
    {!admin && <p><Link href="/feedback">返回我的反馈</Link></p>}
    {picker && !pending && <ResourceLibraryPicker open imageOnly target="assets" title="添加回测截图" confirmLabel="添加截图" purpose="feedback-retest" contextKey={`${scope}:${selected?.number || 0}`}
      currentCount={draft.assets.length} currentAssetIds={draft.assets.map(v => v.id)} maxSelection={128} onClose={() => setPicker(false)}
      onUploadFile={(file, onProgress) => uploadFileAsAsset(file, { onProgress, ownerId: owner })}
      onConfirm={async () => ({ success: false, message: '请选择图片' })} onConfirmSelection={async items => {
        if (!usable()) return { success: false, message: '登录状态已变化' };
        if (items.some(item => !item.assetId || item.type !== 'image')) return { success: false, message: '请选择本人已上传的图片' };
        const next = [...draft.assets, ...items.filter(item => !draft.assets.some(v => v.id === item.assetId)).map(item => ({ id: item.assetId!, originalUrl: item.originalUrl, url: item.previewUrl || item.thumbnailUrl || item.originalUrl }))];
        if (next.length > 128) return { success: false, message: '最多添加128张截图' };
        edit({ ...draft, assets: next }); setPicker(false); return { success: true };
      }} />}
    {preview && <ZoomableImagePreview src={preview} alt="反馈截图" imageSharing={false} previewKey={`${scope}:${preview}`} onClose={() => setPreview(null)} />}
  </section>;
}
