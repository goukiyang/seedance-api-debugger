import { multiviewPreviewFrameRect, type MultiviewPreviewManifest } from '@/lib/video/multiview-preview-contract';

/** A small display-only JPEG. Exact frames and exports never consume this Blob. */
export function encodeMultiviewPreviewFrame(atlas: ImageBitmap, manifest: MultiviewPreviewManifest, frame: number): Promise<Blob> {
  const rect = multiviewPreviewFrameRect(manifest, frame);
  if (!rect || atlas.width !== manifest.columns * manifest.cellWidth || atlas.height !== manifest.rows * manifest.cellHeight) {
    return Promise.reject(new Error('预览帧位置不匹配，请重新读取'));
  }
  const canvas = document.createElement('canvas');
  canvas.width = rect.width; canvas.height = rect.height;
  const context = canvas.getContext('2d');
  if (!context) return Promise.reject(new Error('此浏览器暂不能准备快速预览'));
  context.drawImage(atlas, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    canvas.width = 0; canvas.height = 0;
    if (blob?.size && blob.type === 'image/jpeg') resolve(blob);
    else reject(new Error('这一帧快速预览未就绪'));
  }, 'image/jpeg', .72));
}
