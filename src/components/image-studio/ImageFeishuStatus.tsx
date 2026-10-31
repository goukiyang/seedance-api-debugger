'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as Popper from '@radix-ui/react-popper';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { Send, X } from 'lucide-react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { isClientSessionBlocked } from '@/lib/auth/client-session-boundary';
import { videoFeishuErrorText } from '@/lib/video/feishu-errors';
import styles from './ImageFeishuStatus.module.css';

// Legacy projections are accepted as input; opening the action always reads the independent original receipt.
export type ImageFeishuView = { version: 1; state: string; canCancel: boolean; canRetry: boolean; imageSent: boolean;
  explanationSent: boolean; mode: 'image' | 'link' | null; reason?: string | null; original?: OriginalView | null };
type OriginalView = { version: 2; state: string; canSend: boolean; canCancel: boolean; canRetry: boolean; originalSent: boolean;
  mode: 'image' | 'file' | null; fileSize: number | null; maxBytes: number; source: 'automatic' | 'manual' | null; reason: string | null };
const labels: Record<string, string> = { not_requested: '原图发送到飞书', pending: '原图待发送', preparing: '正在准备原图', uploading: '原图上传中',
  sending: '原图发送中', sent: '原图已发送', cancelled: '原图发送已取消', failed: '原图发送未完成', unknown: '原图发送待核对' };
const automaticLabels: Record<string, string> = { not_requested: '未选择生成通知', pending: '等待图片就绪', preparing: '正在准备图片通知', uploading: '正在上传通知图片', sending: '正在发送图片通知', sent_image: '图片通知已发送', sent_link: '仅发送查看链接', image_sent_explanation_pending: '通知图片已发送，说明待发送', cancelled: '生成通知已取消', failed: '生成通知未完成', unknown: '生成通知结果待核对' };
const reasons: Record<string, string> = { image_original_too_large: '原图超过当前30MB发送上限，请沿原入口下载。', binding_unavailable: '请先核对本人的飞书绑定。',
  binding_changed: '飞书绑定已变化，本次发送已停止。', generation_not_completed: '原图尚未就绪。', original_changed: '原图已变化，本次发送已停止。',
  automatic_original_pending: '生成时选择的原图发送仍在处理中或待核对，不会重复发送。', image_upload_unknown: '上传结果待核对，不会再次上传或改发链接。',
  message_receipt_unknown: '消息回执待核对，不会另发一条消息。', image_upload_rejected: '飞书未接受本次上传，可在记录允许时继续。',
  notification_accepting_disabled: '当前暂不接受新的原图发送，已有记录仍可核对。', message_rejected: '飞书未接受本次消息，原图仍可正常下载。' };
export function ImageFeishuStatus({ owner, taskId, initial, onChanged }: { owner: string; taskId: string;
  initial?: ImageFeishuView | null; onChanged?: () => void }) {
  const session = useAppSession(), scope = `${owner}:${taskId}`;
  const current = useRef({ scope, ready: false }), sequence = useRef(0), lock = useRef(false), alive = useRef(true), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const [value, setValue] = useState<OriginalView | null>(initial?.original || null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [open, setOpen] = useState(false);
  const [mutationUnknown, setMutationUnknown] = useState(false);
  const [automatic, setAutomatic] = useState<ImageFeishuView | null>(initial || null), [autoMutationUnknown, setAutoMutationUnknown] = useState(false), [autoError, setAutoError] = useState('');
  const mutationGuards = useRef({ original: false, automatic: false });
  const ready = session.hasLoadedUser && !session.sessionChanged && !session.userLoadError && session.user?.id === owner;
  current.current = { scope, ready };
  useEffect(() => { alive.current = true; sequence.current++; lock.current = false; setValue(initial?.original || null); setAutomatic(initial || null); setError(''); setAutoError(''); setMutationUnknown(false); setAutoMutationUnknown(false); mutationGuards.current = { original: false, automatic: false }; setBusy(false); setOpen(false);
    return () => { alive.current = false; sequence.current++; };
  }, [scope]);
  useDialogDismiss({ open, dialogRef: panel, branchRefs: [trigger], modal: false, onDismiss: () => setOpen(false) });
  useEffect(() => { if (!lock.current && !mutationGuards.current.original && initial?.original) setValue(initial.original); }, [initial?.original]);
  useEffect(() => { if (!lock.current && !mutationGuards.current.automatic) setAutomatic(initial || null); }, [initial]);
  const valid = () => alive.current && current.current.scope === scope && current.current.ready && !isClientSessionBlocked();
  async function run(action?: 'send' | 'cancel' | 'retry', sendIfFresh = false) {
    if (!valid() || lock.current || action && mutationUnknown) return;
    const seq = ++sequence.current; lock.current = true; setBusy(true); setError('');
    const requestOriginal = async (nextAction?: 'send' | 'cancel' | 'retry'): Promise<OriginalView | null> => {
      if (nextAction) { mutationGuards.current.original = true; setMutationUnknown(true); }
      const response = await fetch(`/api/image-studio/tasks/${encodeURIComponent(taskId)}/feishu?intent=original`, { method: nextAction ? 'POST' : 'GET', cache: 'no-store',
        headers: { 'x-app-session-user': owner, ...(nextAction ? { 'Content-Type': 'application/json' } : {}) },
        ...(nextAction ? { body: JSON.stringify({ version: 2, intent: 'original', action: nextAction }) } : {}), signal: AbortSignal.timeout(15_000) });
      const data = await response.json(); if (!valid() || seq !== sequence.current) return null;
      if ([401,403,404].includes(response.status)) { setValue(null); throw new Error(videoFeishuErrorText(data.error)); }
      if (!response.ok) throw new Error(reasons[data.error] || videoFeishuErrorText(data.error));
      if (data.version !== 2 || !Object.hasOwn(labels, data.state) || ['canSend','canCancel','canRetry','originalSent'].some(key => typeof data[key] !== 'boolean')
        || ![null,'image','file'].includes(data.mode)) throw new Error('原图发送记录暂不可核对');
      return data;
    };
    try {
      let data = await requestOriginal(action); if (!data) return;
      setValue(data);
      // Keep one lock across the fresh read and the first explicit send.
      if (!action && sendIfFresh && data.state === 'not_requested' && data.canSend && !mutationGuards.current.original) {
        if (!valid() || seq !== sequence.current) return;
        data = await requestOriginal('send'); if (!data) return; setValue(data);
      }
      if (mutationGuards.current.original && data.state === 'not_requested') setError('尚未查到本次原图操作，请继续核对原记录。');
      else { mutationGuards.current.original = false; setMutationUnknown(false); }
      onChanged?.();
    } catch (cause) { if (valid() && seq === sequence.current) setError(cause instanceof Error ? cause.message : '原图发送记录暂不可核对'); }
    finally { if (valid() && seq === sequence.current) { lock.current = false; setBusy(false); } }
  }
  async function runAutomatic(action?: 'cancel' | 'retry') {
    if (!valid() || lock.current || action && autoMutationUnknown) return;
    const seq = ++sequence.current; lock.current = true; setBusy(true); setAutoError('');
    if (action) { mutationGuards.current.automatic = true; setAutoMutationUnknown(true); }
    try {
      const response = await fetch(`/api/image-studio/tasks/${encodeURIComponent(taskId)}/feishu`, { method: action ? 'POST' : 'GET', cache: 'no-store',
        headers: { 'x-app-session-user': owner, ...(action ? { 'Content-Type': 'application/json' } : {}) },
        ...(action ? { body: JSON.stringify({ version: 1, action }) } : {}), signal: AbortSignal.timeout(15_000) });
      const data = await response.json(); if (!valid() || seq !== sequence.current) return;
      if (!response.ok) throw new Error(videoFeishuErrorText(data.error));
      if (data.version !== 1 || !Object.hasOwn(automaticLabels, data.state) || ['canCancel','canRetry','imageSent','explanationSent'].some(key => typeof data[key] !== 'boolean')
        || ![null,'image','link'].includes(data.mode)) throw new Error('生成通知记录暂不可核对');
      setAutomatic(data);
      if (mutationGuards.current.automatic && data.state === 'not_requested') setAutoError('尚未查到本次通知操作，请继续核对原记录。');
      else { mutationGuards.current.automatic = false; setAutoMutationUnknown(false); }
      onChanged?.();
    } catch (cause) { if (valid() && seq === sequence.current) setAutoError(cause instanceof Error ? cause.message : '生成通知记录暂不可核对'); }
    finally { if (valid() && seq === sequence.current) { lock.current = false; setBusy(false); } }
  }
  if (!ready) return null;
  const initialWarning = ['failed','unknown'].includes(automatic?.state || '');
  const label = mutationUnknown || error ? '原图发送待核对' : autoMutationUnknown || autoError ? '飞书通知待核对' : initialWarning ? automatic?.state === 'unknown' ? '飞书通知待核对' : '飞书通知未完成' : labels[value?.state || 'not_requested'];
  return <Popper.Root><div className={styles.root}>
    <Popper.Anchor asChild><button ref={trigger} type="button" className={styles.trigger} data-state={error || autoError || autoMutationUnknown || initialWarning ? 'failed' : busy ? 'sending' : value?.state} aria-busy={busy} aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup="dialog" aria-label={label} title={label}
      onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
      onClick={event => { event.preventDefault(); event.stopPropagation(); if (lock.current) return; setOpen(!open); if (!open) void (async () => { await run(undefined, true); await runAutomatic(); })(); }}><Send size={17.5} aria-hidden="true"/><span className={styles.label} aria-hidden="true">{label}</span></button></Popper.Anchor>
    {open && createPortal(<Popper.Content side="top" align="end" sideOffset={6} collisionPadding={12} avoidCollisions sticky="always" hideWhenDetached
      className={styles.details} onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
      <div ref={panel} id={id} role="dialog" tabIndex={-1} aria-label="原图发送到飞书" aria-busy={busy}>
      <div className={styles.heading}><strong>{label}</strong><button type="button" aria-label="关闭发送详情" onClick={() => setOpen(false)}><X size={14}/></button></div>
      <p>{value?.mode === 'file' ? '完整原图文件附件，显示名称仅“原图”。' : value?.mode === 'image' ? '原字节图片卡片，完整显示原图。' : '支持的图片原字节发送；大图作为完整原图文件附件发送。'}</p>
      <p>最多30MB，不缩小、不转码。站内原件和下载保持不变。{value?.fileSize ? ` 当前原图 ${(value.fileSize / 1_000_000).toFixed(1)}MB。` : ''}</p>
      {value?.reason && <p>{reasons[value.reason] || '本次发送未完成，请保留原记录核对。'}</p>}
      {error && <p role="alert">{error}{mutationUnknown ? ' 操作结果待确认，请先核对原记录。' : ''}</p>}
      <div className={styles.actions}>
        {value?.canCancel && !mutationUnknown && <button type="button" disabled={busy} onClick={() => void run('cancel')}>取消本次发送</button>}
        {value?.canRetry && !mutationUnknown && <button type="button" disabled={busy} onClick={() => void run('retry')}>继续本次发送</button>}
        <button type="button" disabled={busy} onClick={() => void run()}>{busy ? '正在核对' : '核对发送状态'}</button>
      </div>
      {(automatic?.state !== 'not_requested' && automatic || autoError || autoMutationUnknown) && <section className={styles.automatic} aria-label="生成时的飞书通知">
        <strong>生成时的飞书通知</strong>
        <p>{autoMutationUnknown ? '通知操作结果待确认，请核对原通知记录。' : automaticLabels[automatic?.state || ''] || '通知记录待核对'}</p>
        {automatic?.reason && <p>{reasons[automatic.reason] || '请保留原通知记录，按实际状态核对。'}</p>}
        {automatic?.state === 'sent_link' && <p>原通知只发送了链接，未发送原图。</p>}
        {autoError && <p role="alert">{autoError}</p>}
        <div className={styles.actions}>
          {automatic?.canCancel && !autoMutationUnknown && <button type="button" disabled={busy} onClick={() => void runAutomatic('cancel')}>取消生成通知</button>}
          {automatic?.canRetry && !autoMutationUnknown && <button type="button" disabled={busy} onClick={() => void runAutomatic('retry')}>继续生成通知</button>}
          <button type="button" disabled={busy} onClick={() => void runAutomatic()}>核对生成通知</button>
        </div>
      </section>}
    </div></Popper.Content>, trigger.current?.closest('dialog[open]') || document.body)}
  </div></Popper.Root>;
}
