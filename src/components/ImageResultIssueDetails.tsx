'use client';

import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as Popper from '@radix-ui/react-popper';
import type { StudioOutputIssue } from '@/lib/image-studio/dimension-mismatch';
import { useDialogDismiss } from './useDialogDismiss';
import styles from './GeneratedImageResults.module.css';

export function ImageResultIssueDetails({ issue, notice }: { issue?: StudioOutputIssue | null; notice?: string | null }) {
  const [open, setOpen] = useState(false), id = useId();
  const trigger = useRef<HTMLButtonElement>(null), dialog = useRef<HTMLDivElement>(null);
  useDialogDismiss({ open, dialogRef: dialog, branchRefs: [trigger], onDismiss: () => setOpen(false), modal: false });
  if (!issue && !notice) return null;
  const label = issue?.kind === 'dimensions_mismatch' ? '尺寸不符' : issue?.kind === 'format_mismatch' ? '格式不符' : '规格不符';
  const format = (value: StudioOutputIssue['actual']) => `${value.format?.toUpperCase() || '格式未知'} · ${value.width && value.height ? `${value.width} × ${value.height}` : '尺寸未知'}`;
  return <Popper.Root><Popper.Anchor asChild><button ref={trigger} type="button" className={styles.issueTrigger}
    aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup="dialog"
    onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onClick={event => { event.preventDefault(); event.stopPropagation(); setOpen(value => !value); }}>{label}</button></Popper.Anchor>
    {open && createPortal(<Popper.Content side="bottom" align="start" sideOffset={6} collisionPadding={12} avoidCollisions
      className={styles.issueLayer} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
      <div ref={dialog} id={id} role="dialog" aria-label="规格差异" tabIndex={-1}>
        <strong>规格差异</strong>
        {issue ? <><dl><div><dt>实际图片</dt><dd>{format(issue.actual)}</dd></div><div><dt>本次请求</dt><dd>{format(issue.requested)}</dd></div></dl>
          {issue.originalRetained && <p>原图已保留，可继续使用</p>}</> : <p>{notice}</p>}
        <button type="button" className={styles.issueClose} onClick={() => setOpen(false)}>关闭</button>
      </div>
    </Popper.Content>, document.body)}
  </Popper.Root>;
}
