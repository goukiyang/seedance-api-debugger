'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import CanvasReactions from '@/components/content-reactions/CanvasReactions';
import { invalidateReaction } from '@/components/content-reactions/ContentReactions';
import MediaPreview from '@/components/MediaPreview';
import { useProductDialog } from '@/components/useProductDialog';
import type { ContentKey } from '@/lib/content-reactions/types';
import { ResourceLibraryPicker } from '@/components/ResourceLibraryPicker';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { uploadFileAsAsset } from '@/lib/http/file-upload';
import { readJsonResponse } from '@/lib/http/json-response';
import type { PickerItem } from '@/lib/assets/picker-types';
import { cancelPageExit, getPageExitRisk, registerPageExitRisk, runApprovedPageExit, type PageExitRisk } from '@/lib/hooks/page-exit-guard';

type CanvasMediaPreview = {
  contentKey: ContentKey;
  src: string;
  type: 'image' | 'video' | 'audio';
  title: string;
};
type ReferenceRequest = { requestId: string; userId: string; nodeId: string; documentId: string | null;
  projectId: string | null; cardId: string | null; capacity: number; currentReferenceImageIds: string[]; currentAssetIds: string[] };
type ReferenceChild = Window & { UltimateCanvasReferenceContextMatches?: (requestId: string) => boolean };
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);

export default function CanvasFrame({ documentId }: { documentId?: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const initialDocumentId = useRef(documentId);
  const dirty = useRef(false);
  const previewRequest = useRef(0);
  const [preview, setPreview] = useState<CanvasMediaPreview | null>(null);
  const [styleGalleryOpen, setStyleGalleryOpen] = useState(false);
  const { user } = useAppSession();
  const userId = useRef(user?.id); userId.current = user?.id;
  const [referenceRequest, setReferenceRequest] = useState<ReferenceRequest | null>(null);
  const currentReferenceRequest = useRef(referenceRequest); currentReferenceRequest.current = referenceRequest;
  const referenceReceipt = useRef<{ requestId: string; resolve: () => void; reject: (error: Error) => void } | null>(null);
  const referenceContextMatches = useCallback((request: ReferenceRequest) => request.userId === userId.current
    && currentReferenceRequest.current?.requestId === request.requestId
    && Boolean((frame.current?.contentWindow as ReferenceChild | null)?.UltimateCanvasReferenceContextMatches?.(request.requestId)), []);
  const closeReferencePicker = useCallback(() => {
    const request = currentReferenceRequest.current;
    if (request) frame.current?.contentWindow?.postMessage({ type: 'sd2-canvas-reference-cancel', requestId: request.requestId }, location.origin);
    referenceReceipt.current?.reject(new Error('参考图添加已取消，原输入保持不变'));
    referenceReceipt.current = null; currentReferenceRequest.current = null; setReferenceRequest(null);
  }, []);
  useEffect(() => { closeReferencePicker(); }, [user?.id, closeReferencePicker]);
  const applyReferences = async (items: PickerItem[]) => {
    const request = currentReferenceRequest.current;
    const check = () => { if (!request || !referenceContextMatches(request)) throw new Error('画布、节点或账号已变化，未覆盖原输入，请重新打开参考图'); };
    check();
    if (!request || !items.length || items.length > request.capacity || items.some(item => item.type !== 'image')) throw new Error('所选参考图数量或类型无效');
    const references: Array<{ referenceImageId: string; assetId: string | null; title: string; width: number | null; height: number | null }> = [];
    for (const item of items) {
      check();
      let referenceImageId = item.referenceImageId;
      if (!referenceImageId) {
        if (!validId(item.assetId)) throw new Error('原图片编号不可用，请重新选择');
        const response = await fetch('/api/workspace/assets', { method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'x-tab-id': `ultimate-canvas:${request.projectId || request.documentId || request.userId}:${request.cardId || request.nodeId}` },
          body: JSON.stringify({ assetId: item.assetId, role: 'reference_image' }) });
        const data = await readJsonResponse<{ success?: boolean; referenceImageId?: string; message?: string; error?: string }>(response);
        check();
        if (!response.ok || !data.success || !validId(data.referenceImageId)) throw new Error(data.message || data.error || '原图片尚未关联为参考图，原输入保持不变');
        referenceImageId = data.referenceImageId;
      }
      if (!validId(referenceImageId)) throw new Error('原图片参考编号不可用');
      references.push({ referenceImageId, assetId: validId(item.assetId) ? item.assetId : null,
        title: item.fileName.slice(0, 240), width: item.width, height: item.height });
    }
    check();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { referenceReceipt.current = null; reject(new Error('画布尚未确认添加，请重新读取参考区，勿重复提交')); }, 15000);
      referenceReceipt.current = { requestId: request.requestId,
        resolve: () => { clearTimeout(timer); resolve(); }, reject: error => { clearTimeout(timer); reject(error); } };
      frame.current?.contentWindow?.postMessage({ type: 'sd2-canvas-reference-apply', requestId: request.requestId, references }, location.origin);
    });
  };
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
      if (event.data?.type === 'sd2-canvas-reactions-changed') {
        if (typeof event.data !== 'object' || Array.isArray(event.data)) return;
        const { key, userId: owner } = event.data;
        if (owner === userId.current && typeof owner === 'string' && typeof key === 'string' && /^image_template:[a-zA-Z0-9_-]+$/.test(key)) invalidateReaction(owner, key as ContentKey);
        return;
      }
      if (event.data?.type === 'sd2-canvas-reference-request') {
        const value = event.data;
        if (!validId(value.requestId) || value.userId !== userId.current || !validId(value.nodeId)
          || ![value.documentId, value.projectId, value.cardId].every(id => id === null || validId(id))
          || !Number.isSafeInteger(value.capacity) || value.capacity < 1 || value.capacity > 80
          || !Array.isArray(value.currentReferenceImageIds) || value.currentReferenceImageIds.length > 80
          || !value.currentReferenceImageIds.every(validId)
          || !Array.isArray(value.currentAssetIds) || value.currentAssetIds.length > 80 || !value.currentAssetIds.every(validId)) return;
        if (!(frame.current?.contentWindow as ReferenceChild | null)?.UltimateCanvasReferenceContextMatches?.(value.requestId)) return;
        const request: ReferenceRequest = { requestId: value.requestId, userId: value.userId, nodeId: value.nodeId,
          documentId: value.documentId, projectId: value.projectId, cardId: value.cardId,
          capacity: value.capacity, currentReferenceImageIds: value.currentReferenceImageIds, currentAssetIds: value.currentAssetIds };
        referenceReceipt.current?.reject(new Error('参考目标已改变，未覆盖原输入'));
        referenceReceipt.current = null; currentReferenceRequest.current = request; setReferenceRequest(request);
        return;
      }
      if (event.data?.type === 'sd2-canvas-reference-receipt' && event.data.requestId === referenceReceipt.current?.requestId) {
        if (event.data.success === true) referenceReceipt.current?.resolve();
        else referenceReceipt.current?.reject(new Error('参考目标已变化或不可用，原输入保持不变，请重新选择'));
        referenceReceipt.current = null; return;
      }
      if (event.data?.type === 'sd2-canvas-reference-invalidated' && event.data.requestId === currentReferenceRequest.current?.requestId) {
        closeReferencePicker(); return;
      }
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
    const relayReaction = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (typeof userId.current === 'string' && detail?.userId === userId.current && typeof detail.key === 'string' && /^image_template:[a-zA-Z0-9_-]+$/.test(detail.key)) {
        frame.current?.contentWindow?.postMessage({ type: 'sd2-canvas-reactions-invalidated', userId: userId.current, key: detail.key }, window.location.origin);
      }
    };
    window.addEventListener('sd2-reactions-changed', relayReaction);
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
      referenceReceipt.current?.reject(new Error('画布已关闭，原输入保持不变'));
      referenceReceipt.current = null;
      previewRequest.current += 1;
      window.removeEventListener('message', onMessage);
      window.removeEventListener('sd2-reactions-changed', relayReaction);
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
  }, [confirm, closeReferencePicker]);
  return <>
    <iframe ref={frame} title="无线画布" src={`/tools/ultimate-canvas/index.html${initialDocumentId.current ? `?document_id=${encodeURIComponent(initialDocumentId.current)}` : ''}`} className="ultimate-canvas-frame" referrerPolicy="no-referrer" allow="fullscreen"
      onLoad={() => { setStyleGalleryOpen(false); closeReferencePicker(); }}
      style={styleGalleryOpen ? { position: 'fixed', inset: 0, width: '100vw', height: '100dvh', zIndex: 10000, borderRadius: 0 } : undefined} />
    <CanvasReactions frame={frame} />
    {referenceRequest && referenceRequest.userId === user?.id && <ResourceLibraryPicker key={referenceRequest.requestId}
      open imageOnly target="workspace" title="添加参考图" confirmLabel="添加到参考区"
      purpose={`canvas-reference:${referenceRequest.documentId || 'unsaved'}:${referenceRequest.nodeId}`}
      maxSelection={referenceRequest.capacity} currentCount={referenceRequest.currentReferenceImageIds.length}
      currentAssetIds={referenceRequest.currentAssetIds} currentReferenceImageIds={referenceRequest.currentReferenceImageIds}
      onClose={closeReferencePicker}
      onUploadFile={async (file, onProgress) => { if (!referenceContextMatches(referenceRequest)) throw new Error('参考目标已改变，请重新打开'); return uploadFileAsAsset(file, { onProgress }); }}
      onConfirm={async () => false} onConfirmSelection={applyReferences} />}
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
