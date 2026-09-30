'use client';

import { useEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import ContentReactions from './ContentReactions';
import type { ContentKey } from '@/lib/content-reactions/types';

type CanvasData = { assetId?: string; asset_id?: string; referenceImageId?: string; reference_image_id?: string; taskId?: string; status?: string; generationStatus?: string; assetIds?: string[]; assets?: CanvasData[]; generationResult?: CanvasData };
type CanvasWindow = Window & { canvasEngine?: { nodes: Map<string, { data?: CanvasData }> } };
type Mount = { element: HTMLElement; key: ContentKey; index: number };
function keysFor(data: CanvasData): ContentKey[] {
  const keys = new Set<ContentKey>();
  const add = (value: CanvasData) => {
    if (value.taskId && (value.status === 'succeeded' || value.generationStatus === 'succeeded')) keys.add(`video_task:${value.taskId}`);
    if (value.assetId || value.asset_id) keys.add(`asset:${value.assetId || value.asset_id}`);
    else if (value.referenceImageId || value.reference_image_id) keys.add(`reference_image:${value.referenceImageId || value.reference_image_id}`);
    for (const id of value.assetIds || []) if (id) keys.add(`asset:${id}`);
  };
  add(data);
  if (data.generationResult) { add(data.generationResult); for (const asset of data.generationResult.assets || []) add(asset); }
  for (const asset of data.assets || []) add(asset);
  return Array.from(keys).filter(key => /^[a-z_]+:[a-zA-Z0-9_-]+$/.test(key));
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
          const data = child.canvasEngine?.nodes.get(node.dataset.nodeId || '')?.data;
          const keys = data ? keysFor(data) : [];
          let host = node.querySelector<HTMLElement>(':scope > .sd2-reaction-mount');
          if (!keys.length) { host?.remove(); continue; }
          if (!host) { host = doc.createElement('div'); host.className = 'sd2-reaction-mount'; node.append(host); }
          keys.forEach((key, index) => result.push({ element: host!, key, index: keys.length > 1 ? index + 1 : 0 }));
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
  return <>{mounts.map(mount => createPortal(<span>{mount.index > 0 && <small>内容 {mount.index} </small>}<ContentReactions contentKey={mount.key} /></span>, mount.element, mount.key))}</>;
}
