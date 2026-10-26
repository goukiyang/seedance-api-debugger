import type { ReactNode } from 'react';
import styles from './TaskNotice.module.css';

/** Choose by consequence, not by an error variable, HTTP code or provider copy. */
export function TaskNotice({ kind, className, children }: {
  kind: 'status' | 'recoverable' | 'danger'; className?: string; children: ReactNode;
}) {
  return <p role={kind === 'status' ? 'status' : 'alert'} data-task-notice={kind}
    className={`${styles.notice}${className ? ` ${className}` : ''}`}>{children}</p>;
}
