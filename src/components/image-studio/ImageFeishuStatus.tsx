'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as Popper from '@radix-ui/react-popper';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { Send, Check, CircleAlert, LoaderCircle, X } from 'lucide-react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import { videoFeishuErrorText } from '@/lib/video/feishu-errors';
import styles from './ImageFeishuStatus.module.css';

export type ImageFeishuView = { version: 1; state: string; canCancel: boolean; canRetry: boolean; imageSent: boolean;
  explanationSent: boolean; mode: 'image' | 'link' | null; reason?: string | null; original?: OriginalView | null };
type OriginalView = { version: 2; state: string; canSend: boolean; canCancel: boolean; canRetry: boolean; originalSent: boolean;
  mode: 'image' | 'file' | null; fileSize: number | null; maxBytes: number; source: 'automatic' | 'manual' | null; reason: string | null };
type Feedback = { id: number; kind: 'pending' | 'success' | 'error' | 'unknown' | 'neutral'; text: string };
const pendingStates = new Set(['pending','preparing','uploading','sending','sent_navigation_pending']);
const labels: Record<string, string> = { not_requested: '发送原图到飞书', pending: '原图发送中', preparing: '原图发送中', uploading: '原图发送中',
  sending: '原图发送中', sent: '原图已发送', cancelled: '原图发送已取消', failed: '原图发送未完成', unknown: '原图发送待核对', sent_navigation_pending: '原图已发送，入口待发送', sent_navigation_unknown: '原图已发送，入口待核对', sent_navigation_failed: '原图已发送，入口未完成' };
const automaticLabels: Record<string, string> = { not_requested: '未选择生成通知', pending: '等待图片就绪', preparing: '正在准备图片通知', uploading: '正在上传通知图片', sending: '正在发送图片通知', sent_image: '图片通知已发送', sent_link: '这次通知没有附图', image_sent_explanation_pending: '通知图片已发送，说明待发送', cancelled: '生成通知已取消', failed: '生成通知未完成', unknown: '生成通知结果待核对' };
const reasons: Record<string, string> = { image_original_too_large: '原图超过30MB，请下载原图后在飞书中发送。', binding_unavailable: '请先核对本人的飞书绑定。',
  binding_changed: '飞书绑定已变化，本次发送已停止。', generation_not_completed: '原图尚未就绪。', original_changed: '原图已变化，本次发送已停止。',
  automatic_original_pending: '这张原图已有发送记录，正在核对状态。', image_upload_unknown: '暂未确认上传结果，请查看发送状态。',
  navigation_receipt_unknown: '原图已发送，入口是否已发送暂待核对。', navigation_message_rejected: '原图已发送，入口暂未发送成功。', navigation_message_window_ended: '原图已发送，本次入口发送已停止。',
  message_receipt_unknown: '暂未确认是否送达，请查看发送状态。', image_upload_rejected: '飞书没有接受这次上传。',
  image_original_unavailable: '原图暂不可读取，请稍后核对。', preparation_attempts_ended: '暂未完成发送准备，请查看是否可以重试。',
  legacy_file_name_unavailable: '旧附件发送已经开始，不能自动改名或再次上传，请沿原图入口下载。',
  notification_accepting_disabled: '当前暂不能发起新的原图发送，已有记录仍可查看。', message_rejected: '飞书没有接受这次发送，原图仍可正常下载。' };
export function ImageFeishuStatus({ owner, taskId, initial, onChanged, presentationLabel }: { owner: string; taskId: string;
  initial?: ImageFeishuView | null; onChanged?: () => void; presentationLabel?: string }) {
  const session = useAppSession(), scope = `${owner}:${taskId}`, id = useId();
  const ready = session.hasLoadedUser && !session.sessionChanged && !session.userLoadError && session.user?.id === owner;
  const current = useRef({ scope, ready }), sequence = useRef(0), lock = useRef(false), alive = useRef(true);
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), feedbackPanel = useRef<HTMLDivElement>(null);
  const mutationGuards = useRef({ original: false, automatic: false }), interaction = useRef(''), dismissed = useRef(false), feedbackId = useRef(0), presented = useRef('');
  const [value, setValue] = useState<OriginalView | null>(initial?.original || null), [automatic, setAutomatic] = useState<ImageFeishuView | null>(initial || null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [autoError, setAutoError] = useState('');
  const [mutationUnknown, setMutationUnknown] = useState(false), [autoMutationUnknown, setAutoMutationUnknown] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false), [recordsOpen, setRecordsOpen] = useState(false), [feedback, setFeedback] = useState<Feedback | null>(null), [paused, setPaused] = useState(false);
  const [observation, setObservation] = useState<{ scope: string; until: number } | null>(null);
  const observationCurrent = useRef(observation); observationCurrent.current = observation;
  const successClock = useRef({ id: 0, remaining: 3000 }); current.current = { scope, ready };
  const present = useCallback((data: OriginalView, repeated = false) => {
    if (interaction.current !== scope || dismissed.current) return;
    const state = data.state === 'sent' && !data.originalSent ? 'unknown' : data.state;
    const key = `${state}:${data.reason || ''}`; if (presented.current === key) return; presented.current = key;
    const result: Omit<Feedback, 'id'> = state.startsWith('sent_navigation_') ? { kind: state === 'sent_navigation_pending' ? 'pending' : state === 'sent_navigation_unknown' ? 'unknown' : 'error', text: labels[state] } : state === 'sent' ? { kind: 'success', text: repeated ? '这张原图已发送' : '已发送到飞书' }
      : pendingStates.has(state) ? { kind: 'pending', text: data.mode === 'file' ? '正在发送原图附件…' : '发送中…' }
        : state === 'unknown' ? { kind: 'unknown', text: '暂未确认是否送达' }
          : state === 'cancelled' ? { kind: 'neutral', text: '已取消发送' }
            : { kind: 'error', text: data.state === 'not_requested' && data.reason ? reasons[data.reason] || '当前无法发送，请查看详情。' : '发送未完成' };
    setFeedback({ id: ++feedbackId.current, ...result });
  }, [scope]);
  useEffect(() => {
    alive.current = true; sequence.current++; lock.current = false; mutationGuards.current = { original: false, automatic: false };
    interaction.current = ''; dismissed.current = false; presented.current = ''; setValue(initial?.original || null); setAutomatic(initial || null);
    setError(''); setAutoError(''); setMutationUnknown(false); setAutoMutationUnknown(false); setBusy(false); setDetailsOpen(false); setRecordsOpen(false); setFeedback(null); setObservation(null); setPaused(false);
    return () => { alive.current = false; sequence.current++; };
    // Reset only when the account/output scope changes; refreshed records are merged below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);
  useEffect(() => {
    if (!lock.current && !mutationGuards.current.original && initial?.original) {
      setValue(initial.original); present(initial.original);
      if (!pendingStates.has(initial.original.state)) setObservation(null);
    }
  }, [initial?.original, present]);
  useEffect(() => { if (!lock.current && !mutationGuards.current.automatic) setAutomatic(initial || null); }, [initial]);
  useDialogDismiss({ open: detailsOpen, dialogRef: panel, branchRefs: [trigger], modal: false, onDismiss: () => setDetailsOpen(false) });
  useEffect(() => {
    if (!feedback || detailsOpen) return;
    const close = (event: PointerEvent) => { const target = event.target as Node; if (!feedbackPanel.current?.contains(target) && !trigger.current?.contains(target)) { dismissed.current = true; setFeedback(null); } };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { dismissed.current = true; setFeedback(null); } };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [feedback, detailsOpen]);
  useEffect(() => {
    if (feedback?.kind !== 'success' || detailsOpen || paused) return;
    if (successClock.current.id !== feedback.id) successClock.current = { id: feedback.id, remaining: 3000 };
    const started = Date.now(), timer = setTimeout(() => setFeedback(null), successClock.current.remaining);
    return () => { clearTimeout(timer); successClock.current.remaining = Math.max(0, successClock.current.remaining - (Date.now() - started)); };
  }, [feedback, detailsOpen, paused]);
  const valid = () => alive.current && current.current.scope === scope && current.current.ready && !isClientSessionBlocked();
  async function run(action?: 'send' | 'cancel' | 'retry', sendIfFresh = false, signal?: AbortSignal): Promise<OriginalView | null> {
    if (!valid() || lock.current || action && mutationUnknown) return null;
    const seq = ++sequence.current; lock.current = true; setBusy(true); setError('');
    const requestOriginal = async (nextAction?: 'send' | 'cancel' | 'retry'): Promise<OriginalView | null> => {
      if (nextAction) { mutationGuards.current.original = true; setMutationUnknown(true); }
      const response = await fetch(`/api/image-studio/tasks/${encodeURIComponent(taskId)}/feishu?intent=original`, { method: nextAction ? 'POST' : 'GET', cache: 'no-store',
        headers: { 'x-app-session-user': owner, ...(nextAction ? { 'Content-Type': 'application/json' } : {}) },
        ...(nextAction ? { body: JSON.stringify({ version: 2, intent: 'original', action: nextAction }) } : {}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
      const data = await response.json(); if (!valid() || seq !== sequence.current || signal?.aborted) return null;
      if (!response.ok) throw new Error(reasons[data.error] || videoFeishuErrorText(data.error));
      if (data.version !== 2 || !Object.hasOwn(labels, data.state) || ['canSend','canCancel','canRetry','originalSent'].some(key => typeof data[key] !== 'boolean')
        || ![null,'image','file'].includes(data.mode)) throw new Error('暂时无法查看发送状态');
      return data;
    };
    try {
      let data = await requestOriginal(action); if (!data) return null; setValue(data);
      if (!action && sendIfFresh && data.state === 'not_requested' && data.canSend && !mutationGuards.current.original) {
        if (!valid() || seq !== sequence.current) return null;
        data = await requestOriginal('send'); if (!data) return null; setValue(data);
      }
      if (mutationGuards.current.original && data.state === 'not_requested') {
        setError('暂未确认是否送达，请查看发送状态。');
        if (!dismissed.current) setFeedback({ id: ++feedbackId.current, kind: 'unknown', text: '暂未确认是否送达' });
      } else { mutationGuards.current.original = false; setMutationUnknown(false); present(data, sendIfFresh); }
      if (pendingStates.has(data.state) && (sendIfFresh || action) && document.visibilityState !== 'hidden') setObservation({ scope, until: Date.now() + 60_000 });
      else if (!pendingStates.has(data.state)) setObservation(null);
      if (!signal || !pendingStates.has(data.state)) onChanged?.(); return data;
    } catch (cause) {
      if (valid() && seq === sequence.current && !signal?.aborted) {
        const message = cause instanceof Error ? cause.message : '暂时无法查看发送状态'; setError(message);
        if (!dismissed.current) setFeedback({ id: ++feedbackId.current, kind: mutationGuards.current.original ? 'unknown' : 'error', text: value?.originalSent ? '原图已发送，入口待核对' : mutationGuards.current.original ? '暂未确认是否送达' : message });
      }
      return null;
    } finally { if (valid() && seq === sequence.current) { lock.current = false; setBusy(false); } }
  }
  const poll = useRef<((signal: AbortSignal) => Promise<OriginalView | null>) | null>(null); poll.current = signal => run(undefined, false, signal);
  useEffect(() => {
    if (!observation || observation.scope !== scope || !ready) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { controller.abort(); if (timer) clearTimeout(timer); if (deadline) clearTimeout(deadline); setObservation(null); };
    const observe = async () => {
      if (controller.signal.aborted || !observationCurrent.current || Date.now() >= observation.until || document.visibilityState === 'hidden') { stop(); return; }
      await poll.current?.(controller.signal);
      if (!controller.signal.aborted && observationCurrent.current && Date.now() < observation.until) timer = setTimeout(observe, 2000);
      else stop();
    };
    const visibility = () => { if (document.visibilityState === 'hidden') stop(); };
    if (document.visibilityState === 'hidden') { stop(); return; }
    deadline = setTimeout(stop, Math.max(0, observation.until - Date.now()));
    timer = setTimeout(observe, 2000); document.addEventListener('visibilitychange', visibility);
    return () => { controller.abort(); if (timer) clearTimeout(timer); if (deadline) clearTimeout(deadline); document.removeEventListener('visibilitychange', visibility); };
  }, [observation, ready, scope]);
  async function runAutomatic(action?: 'cancel' | 'retry') {
    if (!valid() || lock.current || action && autoMutationUnknown) return;
    const seq = ++sequence.current; lock.current = true; setBusy(true); setAutoError('');
    if (action) { mutationGuards.current.automatic = true; setAutoMutationUnknown(true); }
    try {
      const response = await fetch(`/api/image-studio/tasks/${encodeURIComponent(taskId)}/feishu`, { method: action ? 'POST' : 'GET', cache: 'no-store',
        headers: { 'x-app-session-user': owner, ...(action ? { 'Content-Type': 'application/json' } : {}) }, ...(action ? { body: JSON.stringify({ version: 1, action }) } : {}), signal: AbortSignal.timeout(15_000) });
      const data = await response.json(); if (!valid() || seq !== sequence.current) return;
      if (!response.ok) throw new Error(videoFeishuErrorText(data.error));
      if (data.version !== 1 || !Object.hasOwn(automaticLabels, data.state) || ['canCancel','canRetry','imageSent','explanationSent'].some(key => typeof data[key] !== 'boolean') || ![null,'image','link'].includes(data.mode)) throw new Error('暂时无法查看通知记录');
      setAutomatic(data);
      if (mutationGuards.current.automatic && data.state === 'not_requested') setAutoError('通知操作尚未确认，请查看这条通知记录。');
      else { mutationGuards.current.automatic = false; setAutoMutationUnknown(false); }
      onChanged?.();
    } catch (cause) { if (valid() && seq === sequence.current) setAutoError(cause instanceof Error ? cause.message : '暂时无法查看通知记录'); }
    finally { if (valid() && seq === sequence.current) { lock.current = false; setBusy(false); } }
  }
  if (!ready) return null;
  const state = mutationUnknown || error ? value?.originalSent ? 'sent_navigation_unknown' : 'unknown' : value?.state === 'sent' && !value.originalSent ? 'unknown' : value?.state || 'not_requested';
  const label = presentationLabel ? state === 'not_requested' ? `发送${presentationLabel}到飞书` : `${presentationLabel} · ${labels[state]}` : labels[state];
  const sending = busy || pendingStates.has(state), Icon = sending ? LoaderCircle : state === 'sent' ? Check : ['failed','unknown','sent_navigation_failed','sent_navigation_unknown'].includes(state) ? CircleAlert : Send;
  const openDetails = () => { setPaused(false); setDetailsOpen(true); };
  return <Popper.Root><div className={styles.root}>
    <Popper.Anchor asChild><button ref={trigger} type="button" className={styles.trigger} data-state={state} aria-busy={sending} aria-label={label} title={label} aria-describedby={feedback ? `${id}-feedback` : undefined}
      onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onKeyDown={event => { event.stopPropagation(); if (event.key === 'ArrowDown' && feedback) { event.preventDefault(); openDetails(); } }}
      onClick={event => { event.preventDefault(); event.stopPropagation(); if (lock.current) return; interaction.current = scope; dismissed.current = false; presented.current = ''; setDetailsOpen(false); setRecordsOpen(false); setFeedback({ id: ++feedbackId.current, kind: 'pending', text: '正在准备发送…' }); void run(undefined, true); }}>
      <Icon size={17.5} aria-hidden="true"/><span className={styles.label} aria-hidden="true">{label}</span>
    </button></Popper.Anchor>
    {(detailsOpen || feedback) && createPortal(<Popper.Content side="top" align="end" sideOffset={6} collisionPadding={12} avoidCollisions sticky="always" hideWhenDetached
      className={detailsOpen ? styles.details : styles.feedback} data-kind={feedback?.kind}
      onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocusCapture={() => setPaused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setPaused(false); }}>
      {detailsOpen ? <div ref={panel} id={id} role="dialog" tabIndex={-1} aria-label={`发送${presentationLabel || '原图'}到飞书`} aria-busy={busy}>
        <div className={styles.heading}><strong>{label}</strong><button type="button" aria-label="关闭发送详情" onClick={() => setDetailsOpen(false)}><X size={14}/></button></div>
        {value?.reason || error ? <p role={error ? 'alert' : undefined}>{error || reasons[value?.reason || ''] || '当前发送未完成，请稍后查看状态。'}</p> : <p>{state === 'sent' ? '这张原图已发送到本人飞书。' : pendingStates.has(state) ? '正在发送，请稍等。' : '发送完整原图到本人飞书。'}</p>}
        <p className={styles.secondary}>{value?.mode === 'file' ? '原图附件' : value?.mode === 'image' ? '原图图片' : '附件上限30MB'}{value?.fileSize ? ` · ${(value.fileSize / 1_000_000).toFixed(1)}MB` : ''}{value?.mode ? ' · 上限30MB' : ''}</p>
        <div className={styles.actions}>
          {value?.canCancel && !mutationUnknown && <button type="button" disabled={busy} onClick={() => void run('cancel')}>取消发送</button>}
          {value?.canRetry && !mutationUnknown && <button type="button" disabled={busy} onClick={() => void run('retry')}>{value.originalSent ? '重试入口' : '重试发送'}</button>}
          <button type="button" disabled={busy} onClick={() => void run()}>查看发送状态</button>
          <button type="button" aria-expanded={recordsOpen} onClick={() => { setRecordsOpen(!recordsOpen); if (!recordsOpen) void runAutomatic(); }}>通知记录</button>
        </div>
        {recordsOpen && <section className={styles.automatic} aria-label="生成时的飞书通知">
          <p>{autoMutationUnknown ? '通知操作结果尚未确认。' : automaticLabels[automatic?.state || 'not_requested']}</p>
          {autoError && <p role="alert">{autoError}</p>}
          {automatic?.reason && <p>{reasons[automatic.reason] || '这条通知暂未完成。'}</p>}
          <div className={styles.actions}>
            {automatic?.canCancel && !autoMutationUnknown && <button type="button" disabled={busy} onClick={() => void runAutomatic('cancel')}>取消通知</button>}
            {automatic?.canRetry && !autoMutationUnknown && <button type="button" disabled={busy} onClick={() => void runAutomatic('retry')}>继续通知</button>}
            <button type="button" disabled={busy} onClick={() => void runAutomatic()}>查看通知状态</button>
          </div>
        </section>}
      </div> : <div ref={feedbackPanel} id={`${id}-feedback`} className={styles.feedbackBody} role="status" aria-live="polite">
        <span>{presentationLabel ? `${presentationLabel} · ${feedback?.text}` : feedback?.text}</span><button type="button" onClick={openDetails}>{feedback?.kind === 'unknown' ? '查看状态' : feedback?.kind === 'error' ? '查看' : '详情'}</button>
        <button type="button" className={styles.dismiss} aria-label="收起发送提示" onClick={() => { dismissed.current = true; setFeedback(null); }}><X size={12}/></button>
      </div>}
    </Popper.Content>, trigger.current?.closest('dialog[open]') || document.body)}
  </div></Popper.Root>;
}
