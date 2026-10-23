'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import * as Popper from '@radix-ui/react-popper';
import { useDialogDismiss } from './useDialogDismiss';
import styles from './GeneratedImageResults.module.css';

export type ImageResultOperation = {
  operationId: string; scope: string; itemId: string; action: string;
  phase: 'busy' | 'success' | 'error'; message: string;
};

/** One result's transient UI. Only confirmed success expires. */
export function ImageResultOperationFeedback({ feedback, anchorRef, onDismiss, onRetry }: {
  feedback: ImageResultOperation; anchorRef: RefObject<HTMLElement | null>;
  onDismiss: (operationId: string) => void; onRetry?: () => void;
}) {
  const [details, setDetails] = useState(false), [paused, setPaused] = useState(false);
  const layerRef = useRef<HTMLDivElement>(null);
  useDialogDismiss({ open: details, dialogRef: layerRef, onDismiss: () => setDetails(false), modal: false });
  const remaining = useRef(3000), latestDismiss = useRef(onDismiss);
  latestDismiss.current = onDismiss;
  useEffect(() => { setDetails(false); remaining.current = 3000; }, [feedback.operationId, feedback.phase]);
  useEffect(() => {
    if (feedback.phase !== 'success') return;
    let timer: ReturnType<typeof setTimeout> | undefined, started = 0;
    const stop = () => { if (timer) { clearTimeout(timer); timer = undefined; remaining.current = Math.max(0, remaining.current - (performance.now() - started)); } };
    const update = () => {
      stop();
      if (!paused && !document.hidden && document.hasFocus()) {
        started = performance.now(); timer = setTimeout(() => latestDismiss.current(feedback.operationId), remaining.current);
      }
    };
    update(); window.addEventListener('focus', update); window.addEventListener('blur', stop); document.addEventListener('visibilitychange', update);
    return () => { stop(); window.removeEventListener('focus', update); window.removeEventListener('blur', stop); document.removeEventListener('visibilitychange', update); };
  }, [feedback.operationId, feedback.phase, paused]);
  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => { if (!entries[0]?.isIntersecting) latestDismiss.current(feedback.operationId); });
    observer.observe(anchor); return () => observer.disconnect();
  }, [anchorRef, feedback.operationId]);
  if (!anchorRef.current) return null;
  return <Popper.Root><Popper.Anchor virtualRef={anchorRef} />{createPortal(<Popper.Content ref={layerRef} side="bottom" align="end" sideOffset={5}
    collisionPadding={12} sticky="always" hideWhenDetached className={styles.operationFeedback}
    onPointerEnter={() => setPaused(true)} onPointerLeave={() => setPaused(false)} onFocusCapture={() => setPaused(true)}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false); }}
    onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    <span role="status" aria-live="polite" aria-atomic="true">{feedback.phase === 'error' ? `${feedback.action}未完成` : feedback.message}</span>
    {feedback.phase === 'error' && <><button type="button" aria-expanded={details} onClick={() => setDetails(value => !value)}>{details ? '收起' : '查看'}</button>
      {details && <div className={styles.operationDetail}><p>{feedback.message}</p>{onRetry && <button type="button" onClick={onRetry}>重试{feedback.action}</button>}</div>}</>}
  </Popper.Content>, document.body)}</Popper.Root>;
}
