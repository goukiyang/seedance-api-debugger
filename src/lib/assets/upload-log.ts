import path from 'path';
import { prisma } from '@/lib/prisma';

type UploadStage =
  | 'ticket'
  | 'storage_put'
  | 'proxy'
  | 'complete'
  | 'raw'
  | 'multipart_start'
  | 'multipart_sign_part'
  | 'multipart_complete'
  | 'multipart_abort'
  | 'mount';

type UploadStatus = 'started' | 'succeeded' | 'failed' | 'unavailable' | 'reused';

type RecordAssetUploadLogParams = {
  operatorId: string;
  stage: UploadStage;
  status: UploadStatus;
  assetId?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
  durationMs?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  reused?: boolean | null;
  storageProvider?: string | null;
  uploadMode?: 'single' | 'multipart' | 'proxy' | 'raw' | null;
  partNumber?: number | null;
  totalParts?: number | null;
};

function cleanText(value: string | null | undefined, maxLength = 180) {
  if (!value) return null;
  const withoutSensitiveFragments = value
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/token[=:]\S+/gi, 'token=[redacted]')
    .replace(/X-Amz-[A-Za-z-]+=\S+/g, 'X-Amz=[redacted]');
  return withoutSensitiveFragments.slice(0, maxLength);
}

function cleanFileName(value: string | null | undefined) {
  if (!value) return null;
  return cleanText(path.basename(value), 120);
}

function normalizeNumber(value: number | null | undefined) {
  return Number.isFinite(value) && value != null ? Math.max(0, Math.floor(value)) : null;
}

export async function recordAssetUploadLog(params: RecordAssetUploadLogParams) {
  try {
    const detail = {
      stage: params.stage,
      status: params.status,
      fileName: cleanFileName(params.fileName),
      mimeType: cleanText(params.mimeType, 80),
      fileSize: normalizeNumber(params.fileSize),
      durationMs: normalizeNumber(params.durationMs),
      assetId: cleanText(params.assetId, 80),
      reused: params.reused === true,
      storageProvider: cleanText(params.storageProvider, 40),
      uploadMode: cleanText(params.uploadMode, 40),
      partNumber: normalizeNumber(params.partNumber),
      totalParts: normalizeNumber(params.totalParts),
      errorCode: cleanText(params.errorCode, 80),
      errorMessage: cleanText(params.errorMessage),
    };

    await prisma.operationLog.create({
      data: {
        operator_id: params.operatorId,
        action: `asset_upload_${params.stage}_${params.status}`,
        target_type: 'AssetUpload',
        target_id: params.assetId || null,
        detail: JSON.stringify(detail),
      },
    });
  } catch (error) {
    console.warn('[AssetUploadLog] write failed:', error);
  }
}
