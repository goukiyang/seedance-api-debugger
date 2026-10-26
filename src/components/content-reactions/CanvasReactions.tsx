'use client';

import { useEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import ContentReactions from './ContentReactions';
import type { ContentKey } from '@/lib/content-reactions/types';

type CanvasData = { assetId?: string; asset_id?: string; referenceImageId?: string; reference_image_id?: string; taskId?: string; generationStatus?: string; selectedVideoResult?: { taskId?: string; playUrl?: string }; originalUrl?: string; imageUrl?: string; previewImage?: string; videoPreviewUrl?: string; generationResult?: { original_url?: string; originalUrl?: string; image_url?: string; imageUrl?: string; play_url?: string; playUrl?: string; result_video_url?: string; resultVideoUrl?: string } };
type CanvasWindow = Window & { canvasEngine?: { nodes: Map<string, { type?: string; data?: CanvasData }> } };
type Mount = { element: HTMLElement; key: ContentKey; nodeId: string };
function keyFor(type: string | undefined, data: CanvasData): ContentKey | null {
  const result = data.generationResult;
  let key: ContentKey | null = null;
  if (type === 'image' && (data.originalUrl || data.imageUrl || data.previewImage || result?.original_url || result?.originalUrl || result?.image_url || result?.imageUrl)) {
    if (data.assetId || data.asset_id) key = `asset:${data.assetId || data.asset_id}`;
    else if (data.referenceImageId || data.reference_image_id) key = `reference_image:${data.referenceImageId || data.reference_image_id}`;
  } else if (type === 'video') {
    const selected = data.selectedVideoResult;
    if (selected?.taskId && selected.playUrl) key = `video_task:${selected.taskId}`;
    else if (!selected && data.taskId && data.generationStatus === 'succeeded' && (data.videoPreviewUrl || result?.play_url || result?.playUrl || result?.result_video_url || result?.resultVideoUrl)) key = `video_task:${data.taskId}`;
    else if (!selected && data.assetId && data.videoPreviewUrl) key = `asset:${data.assetId}`;
  }
  return key && /^(asset|reference_image|video_task):[a-zA-Z0-9_-]+$/.test(key) ? key : null;
}

export default function CanvasReactions({ frame }: { frame: RefObject<HTMLIFrameElement> }) {
  const [mounts, setMounts] = useState<Mount[]>([]);
  useEffect(() => {
    const iframe = frame.current;
    if (!iframe) return;
    let cleanDocument = () => {};
    const connect = () => {
      cleanDocument();
      const child = iframe.contentWindow as CanvasWindow | null;
      const doc = iframe.contentDocument;
      if (!child || !doc) return;
      const style = doc.createElement('style');
      style.textContent = '.sd2-reaction-mount{display:flex;flex-wrap:wrap;gap:6px;padding:5px 10px;position:relative;z-index:3}.sd2-reaction-mount [data-content-reactions]{display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap}.sd2-reaction-mount button{display:inline-flex;align-items:center;justify-content:center;gap:4px;min-width:30px;height:30px;border:1px solid #485454;border-radius:5px;background:#152020;color:#cddcdb;cursor:pointer}.sd2-reaction-mount button[aria-pressed=true]{color:#f3bb64}.sd2-reaction-mount button:disabled{opacity:.45}.sd2-reaction-mount small{font-size:11px;color:#aabbbb}';
      doc.head.append(style);
      let scheduled = 0;
      let stopped = false;
      const scan = () => {
        if (stopped) return;
        const result: Mount[] = [];
        for (const node of Array.from(doc.querySelectorAll<HTMLElement>('.canvas-node[data-node-id]'))) {
          const nodeId = node.dataset.nodeId || '';
          const item = child.canvasEngine?.nodes.get(nodeId);
          const key = item?.data ? keyFor(item.type, item.data) : null;
          let host = node.querySelector<HTMLElement>(':scope > .sd2-reaction-mount');
          if (!key) { host?.remove(); continue; }
          if (!host) { host = doc.createElement('div'); host.className = 'sd2-reaction-mount'; node.append(host); }
          result.push({ element: host, key, nodeId });
        }
        setMounts(current => current.length === result.length && current.every((item, index) => item.element === result[index].element && item.key === result[index].key) ? current : result);
      };
      const schedule = () => { cancelAnimationFrame(scheduled); scheduled = requestAnimationFrame(scan); };
      const observer = new MutationObserver(records => {
        if (records.some(record => !(record.target.nodeType === 1 && (record.target as Element).closest('.sd2-reaction-mount')))) schedule();
      });
      observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-status'] });
      const timer = window.setInterval(scan, 3000);
      scan();
      cleanDocument = () => { stopped = true; observer.disconnect(); cancelAnimationFrame(scheduled); clearInterval(timer); style.remove(); setMounts([]); };
    };
    iframe.addEventListener('load', connect);
    if (iframe.contentDocument?.readyState === 'complete') connect();
    return () => { iframe.removeEventListener('load', connect); cleanDocument(); };
  }, [frame]);
  return <>{mounts.map(mount => createPortal(<ContentReactions contentKey={mount.key} />, mount.element, `${mount.nodeId}:${mount.key}`))}</>;
}
