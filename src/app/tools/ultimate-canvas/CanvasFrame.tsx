'use client';

import { useEffect, useRef, useState } from 'react';
import CanvasReactions from '@/components/content-reactions/CanvasReactions';
import MediaPreview from '@/components/MediaPreview';
import { useProductDialog } from '@/components/useProductDialog';
import type { ContentKey } from '@/lib/content-reactions/types';
import { cancelPageExit, getPageExitRisk, registerPageExitRisk, runApprovedPageExit, type PageExitRisk } from '@/lib/hooks/page-exit-guard';

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
  const [styleGalleryOpen, setStyleGalleryOpen] = useState(false);
  const { confirm, productDialog } = useProductDialog();
  useEffect(() => {
    let internalUrlSync = false;
    let alive = true;
    let lastLocation = { url: location.href, state: window.history.state };
    let approvedUrl: string | null = null;
    let approvedSignature: string | null = null;
    let approvalTimer: ReturnType<typeof setTimeout> | undefined;
    const hasChanges = () => {
      try {
        const child = frame.current?.contentWindow as (Window & { UltimateCanvasHasUnsavedChanges?: () => boolean }) | null;
        return child?.UltimateCanvasHasUnsavedChanges?.() ?? dirty.current;
      } catch { return dirty.current; }
    };
    const unregisterRisk = registerPageExitRisk('ultimate-canvas', () => {
      try {
        const child = frame.current?.contentWindow as (Window & { UltimateCanvasGetExitRisk?: () => PageExitRisk }) | null;
        return child?.UltimateCanvasGetExitRisk?.() ?? { unsaved: hasChanges() ? ['画布内容'] : [], busy: [] };
      } catch { return { unsaved: hasChanges() ? ['画布内容'] : [], busy: [] }; }
    });
    const clearApproval = () => { approvedUrl = null; approvedSignature = null; clearTimeout(approvalTimer); cancelPageExit(); };
    const leave = (destination: string) => {
      if (!alive || !approvedSignature) return;
      if (!runApprovedPageExit(() => location.assign(destination), approvedSignature)) clearApproval();
    };
    let deciding = false;
    const requestLeave = async (destination: string) => {
      if (approvedUrl === destination) return true;
      if (deciding) return false;
      deciding = true;
      try {
        const risk = getPageExitRisk();
        if (risk.busy.length) {
          await confirm(`${risk.busy.join('、')}，请完成后再离开。`, { title: '操作进行中', confirmLabel: '返回等待' });
          return false;
        }
        if (risk.unsaved.length && (!await confirm(`${risk.unsaved.join('、')}尚未保存，确定放弃并离开吗？`, { title: '离开画布', confirmLabel: '放弃并离开', danger: true }) || !alive)) return false;
        if (getPageExitRisk().signature !== risk.signature) return false;
        approvedUrl = destination;
        approvedSignature = risk.signature;
        approvalTimer = setTimeout(clearApproval, 500);
        return true;
      } finally { deciding = false; }
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow) return;
      if (['sd2-canvas-style-gallery', 'sd2-canvas-modal'].includes(event.data?.type) && typeof event.data.open === 'boolean') {
        setStyleGalleryOpen(event.data.open);
        return;
      }
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
    const onClick = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute('download')
        || (anchor.target && anchor.target !== '_self') || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      const destination = new URL(anchor.href, window.location.href);
      if (destination.pathname === location.pathname && destination.search === location.search) return;
      clearApproval();
      if (hasChanges()) {
        event.preventDefault(); event.stopImmediatePropagation();
        void requestLeave(destination.href).then(approved => { if (approved) leave(destination.href); });
      }
    };
    // Chromium's navigation event also covers back/forward and programmatic SPA navigation.
    type NavigationEvent = Event & { canIntercept: boolean; destination: { url: string }; hashChange: boolean };
    const navigation = (window as Window & { navigation?: EventTarget }).navigation;
    const onNavigate = (event: Event) => {
      const next = event as NavigationEvent;
      if (internalUrlSync || !event.cancelable || next.hashChange || next.destination.url === location.href) return;
      if (hasChanges() && approvedUrl !== next.destination.url) {
        event.preventDefault(); event.stopImmediatePropagation();
        void requestLeave(next.destination.url).then(approved => { if (approved) leave(next.destination.url); });
      }
    };
    const onPopState = (event: PopStateEvent) => {
      if (navigation) return;
      clearApproval();
      if (hasChanges()) {
        const destination = location.href;
        event.stopImmediatePropagation();
        internalUrlSync = true;
        try { window.history.pushState(lastLocation.state, '', lastLocation.url); }
        finally { internalUrlSync = false; }
        void requestLeave(destination).then(approved => { if (approved) leave(destination); });
      } else lastLocation = { url: location.href, state: window.history.state };
    };
    window.addEventListener('message', onMessage);
    document.addEventListener('click', onClick, true);
    document.addEventListener('pointerdown', clearApproval, true);
    document.addEventListener('keydown', clearApproval, true);
    document.addEventListener('input', clearApproval, true);
    window.addEventListener('pageshow', clearApproval);
    window.addEventListener('popstate', onPopState, true);
    navigation?.addEventListener('navigate', onNavigate);
    navigation?.addEventListener('navigateerror', clearApproval);
    navigation?.addEventListener('navigatesuccess', clearApproval);
    return () => {
      alive = false;
      previewRequest.current += 1;
      window.removeEventListener('message', onMessage);
      unregisterRisk();
      clearApproval();
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('pointerdown', clearApproval, true);
      document.removeEventListener('keydown', clearApproval, true);
      document.removeEventListener('input', clearApproval, true);
      window.removeEventListener('pageshow', clearApproval);
      window.removeEventListener('popstate', onPopState, true);
      navigation?.removeEventListener('navigate', onNavigate);
      navigation?.removeEventListener('navigateerror', clearApproval);
      navigation?.removeEventListener('navigatesuccess', clearApproval);
    };
  }, [confirm]);
  return <>
    <iframe ref={frame} title="无线画布" src={`/tools/ultimate-canvas/index.html${initialDocumentId.current ? `?document_id=${encodeURIComponent(initialDocumentId.current)}` : ''}`} className="ultimate-canvas-frame" referrerPolicy="no-referrer" allow="fullscreen"
      onLoad={() => setStyleGalleryOpen(false)}
      style={styleGalleryOpen ? { position: 'fixed', inset: 0, width: '100vw', height: '100dvh', zIndex: 10000, borderRadius: 0 } : undefined} />
    <CanvasReactions frame={frame} />
    {productDialog}
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
