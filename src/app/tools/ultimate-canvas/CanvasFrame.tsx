'use client';

import { useEffect, useRef } from 'react';

export default function CanvasFrame({ documentId }: { documentId?: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const initialDocumentId = useRef(documentId);
  const dirty = useRef(false);
  useEffect(() => {
    let internalUrlSync = false;
    let lastLocation = { url: location.href, state: window.history.state };
    let approvedUrl: string | null = null;
    const hasChanges = () => {
      try {
        const child = frame.current?.contentWindow as (Window & { UltimateCanvasHasUnsavedChanges?: () => boolean }) | null;
        return child?.UltimateCanvasHasUnsavedChanges?.() ?? dirty.current;
      } catch { return dirty.current; }
    };
    const clearApproval = () => { approvedUrl = null; };
    const confirmLeave = (destination: string) => {
      if (!hasChanges()) return true;
      if (approvedUrl === destination) return true;
      if (!window.confirm('画布仍有未保存内容或正在处理的操作。确定离开吗？')) return false;
      approvedUrl = destination;
      return true;
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === 'sd2-canvas-dirty' && typeof event.data.dirty === 'boolean') {
        dirty.current = event.data.dirty;
        return;
      }
      if (event.data?.type !== 'sd2-canvas-document' || typeof event.data.documentId !== 'string') return;
      const url = new URL(window.location.href);
      url.searchParams.set('document_id', event.data.documentId);
      internalUrlSync = true;
      try {
        window.history.replaceState(window.history.state, '', url);
        lastLocation = { url: url.href, state: window.history.state };
      } finally { internalUrlSync = false; }
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (approvedUrl) { clearApproval(); return; }
      if (hasChanges()) { event.preventDefault(); event.returnValue = ''; }
    };
    const onClick = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute('download')
        || (anchor.target && anchor.target !== '_self') || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      const destination = new URL(anchor.href, window.location.href);
      if (destination.pathname === location.pathname && destination.search === location.search) return;
      clearApproval();
      if (!confirmLeave(destination.href)) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    // Chromium's navigation event also covers back/forward and programmatic SPA navigation.
    type NavigationEvent = Event & { canIntercept: boolean; destination: { url: string }; hashChange: boolean };
    const navigation = (window as Window & { navigation?: EventTarget }).navigation;
    const onNavigate = (event: Event) => {
      const next = event as NavigationEvent;
      if (internalUrlSync || !event.cancelable || next.hashChange || next.destination.url === location.href) return;
      if (!confirmLeave(next.destination.url)) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    const onPopState = (event: PopStateEvent) => {
      if (navigation) return;
      clearApproval();
      if (!confirmLeave(location.href)) {
        event.stopImmediatePropagation();
        internalUrlSync = true;
        try { window.history.pushState(lastLocation.state, '', lastLocation.url); }
        finally { internalUrlSync = false; }
      } else lastLocation = { url: location.href, state: window.history.state };
    };
    window.addEventListener('message', onMessage);
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    document.addEventListener('pointerdown', clearApproval, true);
    document.addEventListener('keydown', clearApproval, true);
    window.addEventListener('popstate', onPopState, true);
    navigation?.addEventListener('navigate', onNavigate);
    navigation?.addEventListener('navigateerror', clearApproval);
    navigation?.addEventListener('navigatesuccess', clearApproval);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('pointerdown', clearApproval, true);
      document.removeEventListener('keydown', clearApproval, true);
      window.removeEventListener('popstate', onPopState, true);
      navigation?.removeEventListener('navigate', onNavigate);
      navigation?.removeEventListener('navigateerror', clearApproval);
      navigation?.removeEventListener('navigatesuccess', clearApproval);
    };
  }, []);
  return <iframe ref={frame} title="无线画布" src={`/tools/ultimate-canvas/index.html${initialDocumentId.current ? `?document_id=${encodeURIComponent(initialDocumentId.current)}` : ''}`} className="ultimate-canvas-frame" referrerPolicy="no-referrer" allow="fullscreen" />;
}
