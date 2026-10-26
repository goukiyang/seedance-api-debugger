'use client';

import { UploadedImagePicker } from '@/components/UploadedImagePicker';
import { uploadFileToHistory } from '@/lib/http/file-upload';
import type { PickerItem } from '@/lib/assets/picker-types';
import type { TemplateContextCardBoundImage } from '@/lib/templates/workbench';

type Props = {
  open: boolean;
  currentImage: TemplateContextCardBoundImage | null;
  onClose: () => void;
  onSelect: (image: TemplateContextCardBoundImage) => void;
};

// Uses the shared file finder/uploader (project rule, 2026-10-25); only maps the pick to a bound image.
export function TemplateBoundImagePicker({ open, currentImage, onClose, onSelect }: Props) {
  if (!open) return null;
  const choose = async (items: PickerItem[]) => {
    const item = items[0];
    if (items.length !== 1 || item.type !== 'image' || !item.assetId && !item.referenceImageId) return { success: false, message: '请选择一张图片' };
    try {
      onSelect(item.referenceImageId
        ? { source: 'reference_album', id: item.referenceImageId, reference_image_id: item.referenceImageId, asset_id: item.assetId || null,
            label: item.fileName, url: item.originalUrl, thumbnail_url: item.thumbnailUrl }
        : { source: 'upload_history', id: item.assetId!, reference_image_id: null, asset_id: item.assetId!,
            label: item.fileName, url: item.originalUrl, thumbnail_url: item.thumbnailUrl });
    } catch (cause) { return { success: false, message: cause instanceof Error ? cause.message : '绑定失败，请重试' }; }
    onClose();
    return { success: true };
  };
  return <UploadedImagePicker open imageOnly target="image-studio" purpose="template-card" title="选择绑定图片" confirmLabel="绑定这张图"
    contextKey="template-card-bound-image" maxSelection={1} currentCount={0}
    currentAssetIds={currentImage?.asset_id ? [currentImage.asset_id] : []} currentReferenceImageIds={currentImage?.reference_image_id ? [currentImage.reference_image_id] : []}
    onClose={onClose} onUploadFile={(file, onProgress) => uploadFileToHistory(file, { onProgress })}
    onConfirm={async () => ({ success: false, message: '请选择一张图片' })} onConfirmSelection={choose} />;
}
