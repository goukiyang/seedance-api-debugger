'use client';

import { useEffect, useRef, useState } from 'react';
import CanvasReactions from '@/components/content-reactions/CanvasReactions';
import MediaPreview from '@/components/MediaPreview';
import type { ContentKey } from '@/lib/content-reactions/types';

type CanvasMediaPreview = {
  contentKey: ContentKey;
  src: string;
  type: 'image' | 'video' | 'audio';
  title: string;
};

export default function CanvasFrame({ documentId }: { documentId?: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const initialDocumentId = useRef(documentId);
  const dirty = useRef(false);
  const previewRequest = useRef(0);
  const [preview, setPreview] = useState<CanvasMediaPreview | null>(null);
  useEffect(() => {
    let internalUrlSync = false;
    let alive = true;
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
      if (event.data?.type === 'sd2-canvas-preview-request') {
        const contentKey = event.data.contentKey;
        if (typeof contentKey !== 'string' || !/^(asset|reference_image|video_task):[a-zA-Z0-9_-]+$/.test(contentKey)) return;

        const requestedContentKey = contentKey as ContentKey;
        const requestId = ++previewRequest.current;
        setPreview(null);
        void (async () => {
          const response = await fetch(`/api/content-reactions/content?key=${encodeURIComponent(requestedContentKey)}`, {
            cache: 'no-store',
            credentials: 'same-origin',
          });
          const payload = await response.json().catch(() => null);
          const content = payload?.content;
          const resolvedContentKey = content?.key;
          const isExpectedKey = resolvedContentKey === requestedContentKey
            || (requestedContentKey.startsWith('reference_image:')
              && typeof resolvedContentKey === 'string'
              && /^asset:[a-zA-Z0-9_-]+$/.test(resolvedContentKey));
          if (!response.ok || !isExpectedKey) throw new Error('unavailable');
          if (!['image', 'video', 'audio'].includes(content.category) || typeof content.previewUrl !== 'string') {
            throw new Error('unavailable');
          }

          const previewUrl = new URL(content.previewUrl, window.location.origin);
          const canonicalContentKey = resolvedContentKey as ContentKey;
          const [contentType, contentId] = canonicalContentKey.split(':');
          if (contentType === 'video_task' && content.category !== 'video') throw new Error('unavailable');
          const isTaskPreview = contentType === 'video_task'
            && previewUrl.origin === window.location.origin
            && previewUrl.pathname === `/api/video/play/${encodeURIComponent(contentId)}`
            && !previewUrl.search
            && !previewUrl.hash;
          const previewParams = Array.from(previewUrl.searchParams.keys());
          const isContentMediaPreview = contentType !== 'video_task'
            && previewUrl.origin === window.location.origin
            && previewUrl.pathname === '/api/content-reactions/media'
            && previewUrl.searchParams.get('key') === canonicalContentKey
            && previewUrl.searchParams.get('variant') === 'preview'
            && previewParams.length === 2
            && !previewUrl.hash;
          if (!isTaskPreview && !isContentMediaPreview) throw new Error('unavailable');
          if (!alive || requestId !== previewRequest.current) return;

          setPreview({
            contentKey: canonicalContentKey,
            src: `${previewUrl.pathname}${previewUrl.search}`,
            type: content.category,
            title: typeof content.title === 'string' ? content.title : '画布媒体',
          });
        })().catch(() => {
          if (!alive || requestId !== previewRequest.current) return;
          frame.current?.contentWindow?.postMessage({
            type: 'sd2-canvas-preview-error',
            contentKey,
          }, window.location.origin);
        });
        return;
      }
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
      alive = false;
      previewRequest.current += 1;
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
  return <>
    <iframe ref={frame} title="无线画布" src={`/tools/ultimate-canvas/index.html${initialDocumentId.current ? `?document_id=${encodeURIComponent(initialDocumentId.current)}` : ''}`} className="ultimate-canvas-frame" referrerPolicy="no-referrer" allow="fullscreen" />
    <CanvasReactions frame={frame} />
    {preview && (
      <MediaPreview
        src={preview.src}
        type={preview.type}
        title={preview.title}
        contentKey={preview.contentKey}
        previewKey={preview.contentKey}
        onClose={() => setPreview(null)}
      />
    )}
  </>;
}
