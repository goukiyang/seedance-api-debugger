'use client';

import { useEffect, useId } from 'react';

const pending = new Set<string>();
let approved = false;

function beforeUnload(event: BeforeUnloadEvent) {
  if (!pending.size || approved) return;
  event.preventDefault();
  event.returnValue = '';
}

function navigate(event: MouseEvent) {
  if (!pending.size || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (!(link instanceof HTMLAnchorElement) || (link.target && link.target !== '_self') || link.hasAttribute('download')) return;
  if (!['http:', 'https:'].includes(link.protocol)) return;
  if (link.href === window.location.href || (link.hash && link.pathname === window.location.pathname && link.search === window.location.search)) return;
  if (!window.confirm('仍有设置未保存或文件正在上传，确定离开吗？')) {
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }
  // A hard navigation must not ask again through beforeunload in the same click.
  approved = true;
  window.setTimeout(() => { approved = false; }, 0);
}

export function useUnsavedNavigation(unsaved: boolean) {
  const id = useId();
  useEffect(() => {
    if (!unsaved) return;
    if (!pending.size) {
      document.addEventListener('click', navigate, true);
      window.addEventListener('beforeunload', beforeUnload);
    }
    pending.add(id);
    return () => {
      pending.delete(id);
      if (!pending.size) {
        document.removeEventListener('click', navigate, true);
        window.removeEventListener('beforeunload', beforeUnload);
        approved = false;
      }
    };
  }, [id, unsaved]);
}
