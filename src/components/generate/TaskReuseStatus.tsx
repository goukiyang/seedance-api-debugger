'use client';

import { useEffect, useRef, useState } from 'react';
import { Undo2 } from 'lucide-react';
import styles from './reuse-feedback.module.css';

export type ReuseUndoAction = { run: () => void; hasLaterEdits: boolean };
export function TaskReuseStatus({ identity, undo }: { identity: string; undo: ReuseUndoAction | null }) {
  const [visible, setVisible] = useState(true), root = useRef<HTMLDivElement>(null), expired = useRef(false);
  useEffect(() => {
    setVisible(true); expired.current = false;
    const timer = setTimeout(() => { expired.current = true; if (!root.current?.contains(document.activeElement)) setVisible(false); }, 5000);
    return () => clearTimeout(timer);
  }, [identity]);
  if (!visible) return null;
  return <div ref={root} className={styles.success} role="status" onBlur={event => { if (expired.current && !event.currentTarget.contains(event.relatedTarget as Node | null)) setVisible(false); }}>
    <span>已复用</span>{undo && <><button type="button" onClick={undo.run}><Undo2 size={14} />撤销</button>{undo.hasLaterEdits && <span>当前修改将保留，可返回</span>}</>}
  </div>;
}
