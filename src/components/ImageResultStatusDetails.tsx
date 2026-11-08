'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import * as Popper from '@radix-ui/react-popper';
import { CircleAlert, Info, MoreHorizontal } from 'lucide-react';
import { useDialogDismiss } from './useDialogDismiss';
import styles from './GeneratedImageResults.module.css';

export function ImageResultStatusDetails({ detail, children, reason = false, active, scopeKey, label: requestedLabel, heading, moreActions }: {
  detail?: string; children?: ReactNode; reason?: boolean; active: boolean; scopeKey: string;
  label?: string; heading?: string; moreActions?: ReactNode;
}) {
  const [openScope, setOpenScope] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'busy' | 'success' | 'error'>('idle');
  const [detailsSelected, setDetailsSelected] = useState(false);
  const [portalHost, setPortalHost] = useState<Element | null>(null);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const copyRun = useRef(0);
  const context = useRef({ active, scopeKey, detail });
  context.current = { active, scopeKey, detail };
  const open = active && openScope === scopeKey;
  const structured = children !== undefined && children !== null;
  const moreMenu = moreActions !== undefined;
  const label = requestedLabel || (reason ? '查看原因' : '查看详情');
  const title = heading || (reason ? '原因说明' : '详细说明');

  function close() {
    copyRun.current += 1;
    setOpenScope(null);
    setCopyState('idle');
    setDetailsSelected(false);
  }

  useEffect(() => {
    copyRun.current += 1;
    setOpenScope(null);
    setCopyState('idle');
    setDetailsSelected(false);
    return () => { copyRun.current += 1; };
  }, [active, detail, scopeKey]);

  useEffect(() => {
    if (moreMenu) setPortalHost(trigger.current?.closest('dialog[open]') || document.body);
  }, [moreMenu, scopeKey]);

  useEffect(() => {
    if (!open || !moreMenu) return;
    const frame = requestAnimationFrame(() => dialog.current?.querySelector<HTMLButtonElement>(detailsSelected ? '[data-detail-close]' : '[role="menuitem"]:not(:disabled)')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, moreMenu, detailsSelected]);

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
      <button ref={trigger} type="button" className={moreMenu ? styles.moreTrigger : styles.issueTrigger} aria-expanded={open}
        aria-controls={open ? id : undefined} aria-haspopup={moreMenu && !detailsSelected ? 'menu' : 'dialog'} disabled={!active}
        aria-label={moreMenu ? '图片更多操作' : label} data-reason={reason || undefined}
        data-result-details={structured || undefined} title={moreMenu ? '图片更多操作' : label}
        onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
        onKeyDown={event => { event.stopPropagation(); if (moreMenu && event.key === 'ArrowDown') { event.preventDefault(); setOpenScope(scopeKey); } }}
        onClick={event => { event.preventDefault(); event.stopPropagation(); if (open) close(); else { setCopyState('idle'); setOpenScope(scopeKey); } }}>
        {moreMenu ? <MoreHorizontal size={18} aria-hidden="true" /> : reason ? <CircleAlert size={18} aria-hidden="true" /> : structured ? <Info size={17} aria-hidden="true" /> : label}
      </button>
    </Popper.Anchor>
    {(moreMenu ? portalHost : open) && createPortal(<Popper.Content side="bottom" align="end" sideOffset={6} collisionPadding={12}
      avoidCollisions sticky="always" hideWhenDetached className={styles.issueLayer} data-structured={structured && (!moreMenu || detailsSelected) || undefined}
      style={!open ? { display: 'none' } : undefined}
      onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}>
      <div ref={dialog} id={id} role={moreMenu && !detailsSelected ? 'menu' : 'dialog'} aria-label={moreMenu && !detailsSelected ? '图片更多操作' : title} tabIndex={-1}
        onKeyDown={event => {
          if (!moreMenu || detailsSelected) return;
          if (event.key === 'Tab') { close(); return; }
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') || []);
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }}>
        {moreMenu && <div className={styles.moreOptions} hidden={detailsSelected}>
          <button type="button" role="menuitem" onClick={() => setDetailsSelected(true)}><Info size={16} aria-hidden="true" />详细信息</button>
          {moreActions}
        </div>}
        <div hidden={moreMenu && !detailsSelected}>
        <strong>{title}</strong>
        {detail && <p className={styles.statusDetailText}>{detail}</p>}
        {open && (!moreMenu || detailsSelected) && children}
        <div className={styles.statusDetailActions}>
          {detail && <button type="button" className={styles.issueClose} disabled={copyState === 'busy'} onClick={() => void copyDetail()}>
            {copyState === 'busy' ? '复制中' : structured ? '复制说明' : '复制完整详情'}
          </button>}
          <button type="button" className={styles.issueClose} data-detail-close onClick={close}>关闭</button>
        </div>
        {copyState === 'success' && <span className={styles.statusCopyFeedback} role="status">已复制</span>}
        {copyState === 'error' && <span className={styles.statusCopyFeedback} role="status">复制失败，请手动选择文字</span>}
        </div>
      </div>
    </Popper.Content>, portalHost || trigger.current?.closest('dialog[open]') || document.body)}
  </Popper.Root>;
}
