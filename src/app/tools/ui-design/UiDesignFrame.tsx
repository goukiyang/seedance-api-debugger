'use client';
import { useEffect, useRef, useState } from 'react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { ResourceLibraryPicker } from '@/components/ResourceLibraryPicker';
import { uploadFileAsAsset } from '@/lib/http/file-upload';
import type { PickerItem } from '@/lib/assets/picker-types';
export default function UiDesignFrame({ userId }: { userId: string }) {
  const { user } = useAppSession(), frame = useRef<HTMLIFrameElement>(null);
  const [selection, setSelection] = useState<{ requestId: string; workspaceId: string; capacity: number } | null>(null);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== frame.current?.contentWindow || event.data?.type !== 'sd2:ui-design:pick' || event.data.accountId !== userId || user?.id !== userId) return;
      const input = event.data;
      if (!/^[a-zA-Z0-9-]{16,100}$/.test(input.requestId) || !/^[a-zA-Z0-9-]{16,100}$/.test(input.workspaceId)) return;
      setSelection({ requestId: input.requestId, workspaceId: input.workspaceId, capacity: Math.min(5, Math.max(0, Number(input.capacity) || 0)) });
    };
    window.addEventListener('message', receive); return () => window.removeEventListener('message', receive);
  }, [userId, user?.id]);
  async function apply(items: PickerItem[]) {
    if (!selection || user?.id !== userId) return false;
    const references = [];
    for (const item of items) {
      const response = await fetch('/api/tools/ui-design/media', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-UI-Design-Account': userId }, body: JSON.stringify({ assetId: item.assetId, referenceImageId: item.referenceImageId }) });
      const value = await response.json(); if (!response.ok) throw new Error(value.error || '素材使用权限未确认');
      references.push({ assetId: value.assetId, referenceImageId: value.referenceImageId, label: item.fileName,
        dataUrl: value.url || item.thumbnailUrl, kind: 'image' });
    }
    if (user?.id !== userId) return false;
    frame.current?.contentWindow?.postMessage({ type: 'sd2:ui-design:picked', accountId: userId, ...selection, references }, location.origin);
    setSelection(null); return true;
  }
  if (user && user.id !== userId) return <p role="alert">账号已变化，请重新打开 UI 界面设计。</p>;
  return <>
    <iframe ref={frame} key={userId} title="UI 界面设计" src="/api/tools/ui-design/runtime/index.html"
      style={{ width: '100%', height: 'calc(100dvh - 56px)', border: 0, display: 'block' }}
      sandbox="allow-scripts allow-same-origin allow-downloads allow-forms allow-popups" />
    {selection && user?.id === userId && <ResourceLibraryPicker open imageOnly target="workspace" title="添加设计风格参考"
      contextKey={`${userId}:ui-design:${selection.workspaceId}`} purpose="ui-design-reference" maxSelection={selection.capacity}
      currentCount={0} currentAssetIds={[]} onClose={() => setSelection(null)}
      onUploadFile={async (file, onProgress) => await uploadFileAsAsset(file, { onProgress })}
      onConfirm={async () => false} onConfirmSelection={apply} />}
  </>;
}
