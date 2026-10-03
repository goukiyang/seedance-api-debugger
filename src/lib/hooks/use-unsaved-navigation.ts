'use client';

import { useEffect, useId } from 'react';
import { cancelPageExit, getPageExitRisk, runApprovedPageExit, usePageExitRisk } from './page-exit-guard';

type ConfirmNavigation = (message: string, options: { title: string; confirmLabel: string }) => Promise<boolean>;
const pending = new Map<string, ConfirmNavigation>();
let deciding = false;

async function navigate(event: MouseEvent) {
  if (!pending.size || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (!(link instanceof HTMLAnchorElement) || (link.target && link.target !== '_self') || link.hasAttribute('download')) return;
  if (!['http:', 'https:'].includes(link.protocol)) return;
  if (link.href === window.location.href || (link.hash && link.pathname === window.location.pathname && link.search === window.location.search)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (deciding) return;
  const href = link.href;
  const confirm = Array.from(pending.values()).pop();
  if (!confirm) return;
  deciding = true;
  try {
    const risk = getPageExitRisk();
    if (risk.busy.length) {
      await confirm(`${risk.busy.join('、')}，请完成后再离开。`, { title: '操作进行中', confirmLabel: '返回等待' });
      return;
    }
    if (risk.unsaved.length && !await confirm(`${risk.unsaved.join('、')}尚未保存，确定放弃并离开吗？`, { title: '离开页面', confirmLabel: '放弃并离开' })) return;
    runApprovedPageExit(() => window.location.assign(href), risk.signature);
  } finally { deciding = false; }
}

export function useUnsavedNavigation(unsaved: boolean, confirm: ConfirmNavigation, details?: { unsaved: string[]; busy: string[]; revision?: string }) {
  const id = useId();
  usePageExitRisk(details || { unsaved: unsaved ? ['当前设置'] : [], busy: [] });
  useEffect(() => {
    if (!unsaved) return;
    if (!pending.size) {
      document.addEventListener('click', navigate, true);
    }
    pending.set(id, confirm);
    return () => {
      pending.delete(id);
      if (!pending.size) {
        document.removeEventListener('click', navigate, true);
        cancelPageExit();
      }
    };
  }, [id, unsaved, confirm]);
}
