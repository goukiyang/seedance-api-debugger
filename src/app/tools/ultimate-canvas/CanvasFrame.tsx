'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import CanvasReactions from '@/components/content-reactions/CanvasReactions';
import { invalidateReaction, installChannel } from '@/components/content-reactions/ContentReactions';
import MediaPreview from '@/components/MediaPreview';
import { useProductDialog } from '@/components/useProductDialog';
import type { ContentKey } from '@/lib/content-reactions/types';
import { ResourceLibraryPicker } from '@/components/ResourceLibraryPicker';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { uploadFileAsAsset, UploadNotAcceptedError } from '@/lib/http/file-upload';
import { readJsonResponse } from '@/lib/http/json-response';
import type { PickerItem } from '@/lib/assets/picker-types';
import { PromptMentionPopover, type PromptMentionCandidate } from '@/components/PromptMentionPopover';
import { detectMentionAtCursor, replaceMentionRange } from '@/lib/prompt/mention';
import { cancelPageExit, getPageExitRisk, registerPageExitRisk, runApprovedPageExit, type PageExitRisk } from '@/lib/hooks/page-exit-guard';

type CanvasMediaPreview = {
  contentKey: ContentKey;
  src: string;
  type: 'image' | 'video' | 'audio';
  title: string;
};
type ReferenceRequest = { requestId: string; userId: string; nodeId: string; documentId: string | null;
  projectId: string | null; cardId: string | null; capacity: number; currentReferenceImageIds: string[]; currentAssetIds: string[] };
type ReferenceChild = Window & { UltimateCanvasReferenceContextMatches?: (requestId: string) => boolean;
  UltimateCanvasMentionContextMatches?: (requestId: string) => boolean;
  UltimateCanvasUploadContextMatches?: (requestId: string) => boolean };
type MentionRequest = { requestId: string; prompt: string; cursor: number; candidates: PromptMentionCandidate[]; left: number; top: number };
type UploadRequest = { requestId: string; userId: string; documentId: string; projectId: string; cardId: string;
  files: Array<{ file: File; nodeId: string }> };
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);

async function uploadCanvasOriginal(file: File, context: Omit<UploadRequest, 'files'>,
  matches: () => boolean, onProgress?: NonNullable<Parameters<typeof uploadFileAsAsset>[1]>['onProgress']) {
  let markerKey = '';
  try {
    const asset = await uploadFileAsAsset(file, { preserveUnknown: true, fallbackToRaw: false, onProgress,
      beforeUpload: async identity => {
        if (!matches()) throw new Error('画布或账号已变化，未开始上传');
        markerKey = `sd2_canvas_upload:${context.userId}:${context.projectId}:${context.cardId}:${context.documentId}:${identity.hash}`;
        if (localStorage.getItem(markerKey)) {
          const query = new URLSearchParams({ canvas_document_id: context.documentId, project_id: context.projectId,
            video_card_id: context.cardId, hash: identity.hash, file_size: String(identity.fileSize), mime_type: identity.mimeType });
          const response = await fetch(`/api/tools/ultimate-canvas/upload?${query}`, { credentials: 'same-origin' });
          const result = await readJsonResponse<{ found?: boolean; asset?: { id?: string }; error?: string }>(response);
          if (!matches()) throw new Error('画布或账号已变化，未关联素材');
          if (!response.ok || !result.found || !validId(result.asset?.id)) throw new Error(result.error || '原上传结果仍未知，未重新上传；请稍后查询原请求');
          return result.asset!;
        }
        localStorage.setItem(markerKey, JSON.stringify({ requestId: context.requestId, ...identity }));
        return null;
      } });
    if (!matches()) throw new Error('画布或账号已变化，原素材保留，未写回旧画布');
    if (!validId(asset.id)) throw new Error('原上传尚未返回素材编号，未关联');
    return { asset, markerKey };
  } catch (error) {
    if (error instanceof UploadNotAcceptedError && markerKey) localStorage.removeItem(markerKey);
    throw error;
  }
}

export default function CanvasFrame({ documentId, focusNodeId }: { documentId?: string; focusNodeId?: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const initialDocumentId = useRef(documentId);
  const initialFocusNodeId = useRef(validId(focusNodeId) ? focusNodeId : undefined);
  const dirty = useRef(false);
  const previewRequest = useRef(0);
  const [preview, setPreview] = useState<CanvasMediaPreview | null>(null);
  const [styleGalleryOpen, setStyleGalleryOpen] = useState(false);
  const { user, refreshCredits } = useAppSession();
  const userId = useRef(user?.id); userId.current = user?.id;
  const [mention, setMention] = useState<MentionRequest | null>(null);
  const mentionRef = useRef(mention); mentionRef.current = mention;
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionIndexRef = useRef(mentionIndex); mentionIndexRef.current = mentionIndex;
  const uploads = useRef(new Set<string>());
  const closeMention = useCallback(() => {
    const request = mentionRef.current;
    if (request) frame.current?.contentWindow?.postMessage({ type: 'sd2-canvas-mention-cancel', requestId: request.requestId }, location.origin);
    mentionRef.current = null; setMention(null);
  }, []);
  const selectMention = useCallback((candidate: PromptMentionCandidate) => {
    const request = mentionRef.current;
    if (!request || !(frame.current?.contentWindow as ReferenceChild | null)?.UltimateCanvasMentionContextMatches?.(request.requestId)) { closeMention(); return; }
    if (candidate.type === 'source') {
      frame.current?.contentWindow?.postMessage({ type: 'sd2-canvas-mention-library', requestId: request.requestId }, location.origin);
      closeMention(); return;
    }
    if (candidate.type !== 'image' || !validId(candidate.referenceImageId)) return;
    const range = detectMentionAtCursor(request.prompt, request.cursor);
    if (!range) { closeMention(); return; }
    const replacement = replaceMentionRange(request.prompt, range, candidate.token);
    frame.current?.contentWindow?.postMessage({ type: 'sd2-canvas-mention-apply', requestId: request.requestId,
      referenceImageId: candidate.referenceImageId, token: candidate.token, prompt: replacement.next, cursor: replacement.cursor }, location.origin);
    mentionRef.current = null; setMention(null);
  }, [closeMention]);
  const runUploads = useCallback(async (request: UploadRequest) => {
    if (uploads.current.has(request.requestId)) return;
    uploads.current.add(request.requestId);
    const matches = () => request.userId === userId.current
      && Boolean((frame.current?.contentWindow as ReferenceChild | null)?.UltimateCanvasUploadContextMatches?.(request.requestId));
    const send = (value: object) => frame.current?.contentWindow?.postMessage({ type: 'sd2-canvas-upload-receipt', requestId: request.requestId, ...value }, location.origin);
    for (const entry of request.files) {
      if (!matches()) {
        send({ nodeId: entry.nodeId, success: false, error: '画布或账号已变化，未写回旧画布；原素材保留' });
        break;
      }
      let markerKey = '';
      let assetId: string | undefined;
      try {
        const original = await uploadCanvasOriginal(entry.file, request, matches,
          progress => { if (matches()) send({ nodeId: entry.nodeId, progress }); });
        const asset = original.asset; markerKey = original.markerKey;
        assetId = asset.id;
        if (!matches()) throw new Error('画布或账号已变化，原素材保留，未写回旧画布');
        const response = await fetch('/api/tools/ultimate-canvas/upload', { method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request_id: request.requestId, asset_id: asset.id,
            project_id: request.projectId, video_card_id: request.cardId, canvas_document_id: request.documentId, canvas_node_id: entry.nodeId }) });
        const result = await readJsonResponse<{ success?: boolean; error?: string }>(response);
        if (!response.ok || !result.success) throw new Error(result.error || '原件已上传，关联尚未确认；重试只恢复关联');
        if (!matches()) throw new Error('画布或账号已变化，未写回旧画布');
        send({ nodeId: entry.nodeId, success: true, result });
        if (markerKey) localStorage.removeItem(markerKey);
      } catch (error) {
        send({ nodeId: entry.nodeId, success: false, ...(matches() ? { assetId } : {}),
          error: !matches() ? '画布或账号已变化，未写回旧画布；原素材保留'
            : error instanceof Error ? error.message : '上传尚未确认，原文件未重传' });
      }
    }
    if (matches()) send({ finished: true });
    uploads.current.delete(request.requestId);
  }, []);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!(event.target as Element)?.closest?.('.prompt-mention-popover')) closeMention(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && mentionRef.current) { event.preventDefault(); closeMention(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [closeMention]);
  useEffect(() => { closeMention(); }, [user?.id, closeMention]);
  // Empty canvases still receive confirmed changes from other tabs.
  useEffect(() => { if (user?.id) installChannel(); }, [user?.id]);
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
    currentReferenceRequest.current = null; setReferenceRequest(null);
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
      const value = event.data;
      if (value?.type === 'sd2-canvas-billing-settled') {
        if (value.userId === userId.current) void refreshCredits({ force: true });
        return;
      }
      if (value?.type === 'sd2-canvas-upload-request') {
        if (!validId(value.requestId) || value.userId !== userId.current || ![value.documentId, value.projectId, value.cardId].every(validId)
          || !Array.isArray(value.files) || value.files.length !== 1
          || !value.files.every((entry: { file?: unknown; nodeId?: unknown }) => entry.file instanceof File && validId(entry.nodeId))
          || !(frame.current?.contentWindow as ReferenceChild | null)?.UltimateCanvasUploadContextMatches?.(value.requestId)) return;
        void runUploads(value); return;
      }
      if (value?.type === 'sd2-canvas-mention-request') {
        if (!validId(value.requestId) || value.userId !== userId.current || !validId(value.nodeId)
          || ![value.documentId, value.projectId, value.cardId].every(id => id === null || validId(id))
          || typeof value.prompt !== 'string' || value.prompt.length > 30000
          || !Number.isInteger(value.cursor) || !detectMentionAtCursor(value.prompt, value.cursor)
          || !Array.isArray(value.candidates) || value.candidates.length > 80
          || !(frame.current?.contentWindow as ReferenceChild | null)?.UltimateCanvasMentionContextMatches?.(value.requestId)) { closeMention(); return; }
        const range = detectMentionAtCursor(value.prompt, value.cursor)!;
        const candidates: PromptMentionCandidate[] = value.candidates.filter((item: { referenceImageId?: unknown; token?: unknown; title?: unknown }) =>
          validId(item.referenceImageId) && typeof item.token === 'string' && /^@图[1-9]\d*$/.test(item.token) && typeof item.title === 'string')
          .filter((item: { title: string; token: string }) => !range.query || `${item.title} ${item.token}`.toLowerCase().includes(range.query.toLowerCase()))
          .map((item: { referenceImageId: string; token: string; title: string }) => ({ id: item.referenceImageId, type: 'image' as const,
            referenceImageId: item.referenceImageId, token: item.token, label: item.token, title: item.title.slice(0, 240),
            thumbnailUrl: `/api/reference-images/${encodeURIComponent(item.referenceImageId)}/content?variant=thumbnail` }));
        candidates.push({ id: 'canvas-album', type: 'source', source: 'album', label: '素材库' });
        const rect = frame.current?.getBoundingClientRect();
        const request: MentionRequest = { requestId: value.requestId, prompt: value.prompt, cursor: value.cursor, candidates,
          left: Math.max(8, Math.min(window.innerWidth - 328, (rect?.left || 0) + (Number(value.left) || 0))),
          top: Math.max(8, Math.min(window.innerHeight - 300, (rect?.top || 0) + (Number(value.top) || 0))) };
        mentionRef.current = request; setMention(request); setMentionIndex(0); return;
      }
      if (value?.type === 'sd2-canvas-mention-key' && value.requestId === mentionRef.current?.requestId) {
        const current = mentionRef.current;
        if (value.key === 'Escape') closeMention();
        else if (current && value.key === 'Enter') selectMention(current.candidates[mentionIndexRef.current]);
        else if (current && ['ArrowDown', 'ArrowUp'].includes(value.key)) setMentionIndex(index => (index + (value.key === 'ArrowDown' ? 1 : -1) + current.candidates.length) % current.candidates.length);
        return;
      }
      if (value?.type === 'sd2-canvas-mention-invalidated') { closeMention(); return; }
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
  }, [confirm, closeReferencePicker, closeMention, selectMention, runUploads, refreshCredits]);
  return <>
    <iframe ref={frame} title="无限画布" src={`/tools/ultimate-canvas/index.html${initialDocumentId.current ? `?document_id=${encodeURIComponent(initialDocumentId.current)}` : ''}${initialFocusNodeId.current ? `${initialDocumentId.current ? '&' : '?'}focus_node=${encodeURIComponent(initialFocusNodeId.current)}` : ''}`} className="ultimate-canvas-frame" referrerPolicy="no-referrer" allow="fullscreen"
      onLoad={() => { setStyleGalleryOpen(false); closeReferencePicker(); closeMention(); }}
      style={styleGalleryOpen ? { position: 'fixed', inset: 0, width: '100vw', height: '100dvh', zIndex: 10000, borderRadius: 0 } : undefined} />
    <CanvasReactions frame={frame} />
    {mention && <div onPointerDown={event => event.stopPropagation()} style={{ position: 'fixed', left: mention.left, top: mention.top,
      width: 320, maxWidth: 'calc(100vw - 16px)', zIndex: 10005 }}>
      <PromptMentionPopover candidates={mention.candidates} activeIndex={mentionIndex}
        onActiveIndexChange={setMentionIndex} onSelect={selectMention} />
    </div>}
    {referenceRequest && referenceRequest.userId === user?.id && <ResourceLibraryPicker key={referenceRequest.requestId}
      open imageOnly target="workspace" title="添加参考图" confirmLabel="添加到参考区"
      purpose={`canvas-reference:${referenceRequest.documentId || 'unsaved'}:${referenceRequest.nodeId}`}
      maxSelection={referenceRequest.capacity} currentCount={referenceRequest.currentReferenceImageIds.length}
      currentAssetIds={referenceRequest.currentAssetIds} currentReferenceImageIds={referenceRequest.currentReferenceImageIds}
      onClose={closeReferencePicker}
      onUploadFile={async (file, onProgress) => {
        if (!referenceContextMatches(referenceRequest) || !referenceRequest.documentId || !referenceRequest.projectId || !referenceRequest.cardId) throw new Error('参考目标已改变，请重新打开');
        const original = await uploadCanvasOriginal(file, { ...referenceRequest, documentId: referenceRequest.documentId,
          projectId: referenceRequest.projectId, cardId: referenceRequest.cardId }, () => referenceContextMatches(referenceRequest), onProgress);
        return original.asset;
      }}
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
