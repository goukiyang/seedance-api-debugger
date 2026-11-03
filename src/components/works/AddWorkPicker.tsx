'use client';

import { useState } from 'react';
import { ResourceLibraryPicker } from '@/components/ResourceLibraryPicker';
import { uploadFileToHistory } from '@/lib/http/file-upload';
import type { PickerItem } from '@/lib/assets/picker-types';
import type { WorkOperate } from './WorkActions';

export function AddWorkPicker({ viewerId, operate, onClose }: { viewerId: string; operate: WorkOperate; onClose: () => void }) {
  const [submitting, setSubmitting] = useState(false);
  async function publish(items: PickerItem[]) {
    if (submitting) return { success: false, message: '正在核对本次添加' };
    if (items.length !== 1 || !items[0].assetId || items[0].source !== 'uploaded') return { success: false, message: '请选择一个本人上传的图片或视频；共享素材和生成参考不会自动发布。' };
    setSubmitting(true);
    try {
      const result = await operate(`publish:${items[0].assetId}`, '/api/works/publish', { assetId: items[0].assetId });
      if (!result) return { success: false, message: '添加尚未确认，请在广场核对原操作。' };
      onClose(); return { success: true };
    } finally { setSubmitting(false); }
  }
  return <ResourceLibraryPicker open target="assets" title="添加本人作品" confirmLabel="明确加入我的作品" purpose="works-publish" contextKey={`works-publish:${viewerId}`} maxSelection={1} acceptedTypes={['image', 'video']} currentCount={0} currentAssetIds={[]} onClose={onClose}
    onUploadFile={(file, onProgress) => uploadFileToHistory(file, { ownerId: viewerId, onProgress, preserveUnknown: true })}
    onConfirm={async () => ({ success: false, message: '请选择本人上传素材后添加' })} onConfirmSelection={publish} />;
}
