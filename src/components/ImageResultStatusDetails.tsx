'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import * as Popper from '@radix-ui/react-popper';
import { CircleAlert, Info } from 'lucide-react';
import { useDialogDismiss } from './useDialogDismiss';
import styles from './GeneratedImageResults.module.css';

export function ImageResultStatusDetails({ detail, children, reason = false, active, scopeKey, label: requestedLabel, heading }: {
  detail?: string; children?: ReactNode; reason?: boolean; active: boolean; scopeKey: string;
  label?: string; heading?: string;
}) {
  const [openScope, setOpenScope] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'busy' | 'success' | 'error'>('idle');
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const copyRun = useRef(0);
  const context = useRef({ active, scopeKey, detail });
  context.current = { active, scopeKey, detail };
  const open = active && openScope === scopeKey;
  const structured = children !== undefined && children !== null;
  const label = requestedLabel || (reason ? '查看原因' : '查看详情');
  const title = heading || (reason ? '原因说明' : '详细说明');

  function close() {
    copyRun.current += 1;
    setOpenScope(null);
    setCopyState('idle');
  }

  useEffect(() => {
    copyRun.current += 1;
    setOpenScope(null);
    setCopyState('idle');
    return () => { copyRun.current += 1; };
  }, [active, detail, scopeKey]);

  useDialogDismiss({
    open: open && active,
    dialogRef: dialog,
    branchRefs: [trigger],
    modal: false,
    onDismiss: close,
  });

  async function copyDetail() {
    if (!detail) return;
    const run = ++copyRun.current;
    const original = { scopeKey, detail };
    setCopyState('busy');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(detail);
      if (run === copyRun.current && context.current.active && context.current.scopeKey === original.scopeKey
        && context.current.detail === original.detail) setCopyState('success');
    } catch {
      if (run === copyRun.current && context.current.active && context.current.scopeKey === original.scopeKey
        && context.current.detail === original.detail) setCopyState('error');
    }
  }

  return <Popper.Root>
    <Popper.Anchor asChild>
      <button ref={trigger} type="button" className={styles.issueTrigger} aria-expanded={open}
        aria-controls={open ? id : undefined} aria-haspopup="dialog" disabled={!active}
        aria-label={label} data-reason={reason || undefined}
        data-result-details={structured || undefined} title={label}
        onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
        onKeyDown={event => event.stopPropagation()}
        onClick={event => { event.preventDefault(); event.stopPropagation(); if (open) close(); else { setCopyState('idle'); setOpenScope(scopeKey); } }}>
        {reason ? <CircleAlert size={18} aria-hidden="true" /> : structured ? <Info size={17} aria-hidden="true" /> : label}
      </button>
    </Popper.Anchor>
    {open && createPortal(<Popper.Content side="bottom" align="end" sideOffset={6} collisionPadding={12}
      avoidCollisions sticky="always" hideWhenDetached className={styles.issueLayer} data-structured={structured || undefined}
      onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}>
      <div ref={dialog} id={id} role="dialog" aria-label={title} tabIndex={-1}>
        <strong>{title}</strong>
        {detail && <p className={styles.statusDetailText}>{detail}</p>}
        {children}
        <div className={styles.statusDetailActions}>
          {detail && <button type="button" className={styles.issueClose} disabled={copyState === 'busy'} onClick={() => void copyDetail()}>
            {copyState === 'busy' ? '复制中' : structured ? '复制说明' : '复制完整详情'}
          </button>}
          <button type="button" className={styles.issueClose} onClick={close}>关闭</button>
        </div>
        {copyState === 'success' && <span className={styles.statusCopyFeedback} role="status">已复制</span>}
        {copyState === 'error' && <span className={styles.statusCopyFeedback} role="status">复制失败，请手动选择文字</span>}
      </div>
    </Popper.Content>, trigger.current?.closest('dialog[open]') || document.body)}
  </Popper.Root>;
}
