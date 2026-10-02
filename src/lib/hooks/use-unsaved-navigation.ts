'use client';

import { useEffect, useId } from 'react';

type ConfirmNavigation = (message: string, options: { title: string; confirmLabel: string }) => Promise<boolean>;
const pending = new Map<string, ConfirmNavigation>();
let approved = false;
let deciding = false;
function resetApproval() { approved = false; deciding = false; }

function beforeUnload(event: BeforeUnloadEvent) {
  if (!pending.size || approved) return;
  event.preventDefault();
  event.returnValue = '';
}

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
    if (!await confirm('仍有设置未保存或文件正在上传，确定离开吗？', { title: '离开页面', confirmLabel: '放弃并离开' })) return;
    // Only this explicit decision permits the captured destination to load.
    approved = true;
    window.location.assign(href);
  } finally { deciding = false; }
}

export function useUnsavedNavigation(unsaved: boolean, confirm: ConfirmNavigation) {
  const id = useId();
  useEffect(() => {
    if (!unsaved) return;
    if (!pending.size) {
      document.addEventListener('click', navigate, true);
      window.addEventListener('beforeunload', beforeUnload);
      window.addEventListener('pageshow', resetApproval);
    }
    pending.set(id, confirm);
    return () => {
      pending.delete(id);
      if (!pending.size) {
        document.removeEventListener('click', navigate, true);
        window.removeEventListener('beforeunload', beforeUnload);
        window.removeEventListener('pageshow', resetApproval);
        resetApproval();
      }
    };
  }, [id, unsaved, confirm]);
}
