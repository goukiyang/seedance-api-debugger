import type { UploadReceipt } from '@/lib/assets/verified-upload';
import type { UploadSimilarityStatus } from '@/lib/assets/upload-similarity';
import type { mediaProjection } from './outlet';

export type BrowserMedia = NonNullable<Awaited<ReturnType<typeof mediaProjection>>>;
export type CompletedUploadAsset = {
  id: string;
  originalUrl?: string | null;
  thumbnailUrl?: string | null;
  width?: number | null;
  height?: number | null;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  hash?: string | null;
  reused?: boolean;
  storageProvider?: string;
  isPubliclyReachable?: boolean;
  warning?: string;
  upload?: UploadReceipt;
  similarity?: UploadSimilarityStatus;
};

// Response-only projection. Never pass this object to receipt persistence.
export function browserUploadAsset(asset: CompletedUploadAsset, media: BrowserMedia | null) {
  return {
    id: asset.id, originalUrl: media?.originalUrl || media?.previewUrl || null,
    thumbnailUrl: media?.thumbnailUrl || null, width: asset.width, height: asset.height,
    fileName: asset.fileName, fileSize: asset.fileSize, mimeType: asset.mimeType, hash: asset.hash,
    reused: asset.reused, storageProvider: asset.storageProvider, warning: asset.warning,
    upload: asset.upload, similarity: asset.similarity,
    isPubliclyReachable: false, media, mediaUnavailable: !media,
  };
}
