'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { Grid2X2 } from 'lucide-react';
import { useProductDialog } from '@/components/useProductDialog';
import { getPageExitRisk, runApprovedPageExit } from '@/lib/hooks/page-exit-guard';
import type { ContentKey } from '@/lib/content-reactions/types';
import { useAppSession } from '@/lib/context/AppSessionContext';
import styles from './MultiviewEntry.module.css';

export function MultiviewEntry({ contentKey, className }: { contentKey?: ContentKey; className?: string }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const { confirm, productDialog } = useProductDialog();
  const { user } = useAppSession();
  const [busy, setBusy] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const match = /^video_task:([a-z0-9_-]{8,80})$/i.exec(contentKey || '');
  const taskId = match?.[1] || '';
  const returnKey = user && taskId ? `sd2:multiview-return:${user.id}:${taskId}` : '';
  useEffect(() => {
    if (!returnKey || !button.current) return;
    try {
      const value = JSON.parse(sessionStorage.getItem(returnKey) || 'null');
      const current = `${pathname}${search.toString() ? `?${search}` : ''}${window.location.hash}`;
      if (!value || value.href !== current || Date.now() - value.at > 3600000 || !Number.isFinite(value.x) || !Number.isFinite(value.y)) return;
      sessionStorage.removeItem(returnKey);
      const frame = requestAnimationFrame(() => { window.scrollTo(value.x, value.y); button.current?.focus({ preventScroll: true }); });
      return () => cancelAnimationFrame(frame);
    } catch {}
  }, [pathname, returnKey, search]);
  if (!match || pathname === '/multiview') return null;
  async function open() {
    if (busy) return;
    setBusy(true);
    try {
      const risk = getPageExitRisk();
      if (risk.busy.length) { await confirm(`${risk.busy.join('、')}，请完成后再打开多角度图。`, { title: '操作进行中', confirmLabel: '返回等待' }); return; }
      if (risk.unsaved.length && !await confirm(`${risk.unsaved.join('、')}尚未保存，确定离开吗？`, { title: '离开当前页', confirmLabel: '放弃并继续' })) return;
      const returnTo = `${pathname}${search.toString() ? `?${search}` : ''}${window.location.hash}`;
      try { if (returnKey) sessionStorage.setItem(returnKey, JSON.stringify({ href: returnTo, x: window.scrollX, y: window.scrollY, at: Date.now() })); } catch {}
      runApprovedPageExit(() => window.location.assign(`/multiview?taskId=${encodeURIComponent(taskId)}&returnTo=${encodeURIComponent(returnTo)}`), risk.signature);
    } finally { setBusy(false); }
  }
  return <><button ref={button} type="button" className={`${styles.button} ${className || ''}`} disabled={busy} onPointerDown={event => event.stopPropagation()}
    onClick={event => { event.stopPropagation(); void open(); }}><Grid2X2 size={15} aria-hidden="true" />制作多角度图</button>{productDialog}</>;
}
