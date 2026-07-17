/**
 * POST /api/assets/upload
 * 上传单个文件（图片/视频/音频）
 * - 优先使用公网上传（R2/TOS），返回公网 HTTPS URL
 * - 回退本地存储（development / 未配置公网存储时）
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  uploadSiteAsset,
  validateSiteUploadBuffer,
  validateSiteUploadInput,
  validateSiteUploadMetadata,
} from '@/lib/assets/site-upload';

export const runtime = 'nodejs';
export const maxDuration = 60;

type UploadPayload = {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  fileSize: number;
};

function decodeFileName(value: string | null) {
  if (!value) return 'upload.bin';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseContentLength(value: string | null) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function readUploadPayload(request: NextRequest): Promise<
  | { payload: UploadPayload; response?: never }
  | { payload?: never; response: NextResponse }
> {
  const contentTypeHeader = request.headers.get('content-type') || '';
  const contentType = contentTypeHeader.split(';')[0]?.trim().toLowerCase() || '';

  if (contentTypeHeader.toLowerCase().includes('multipart/form-data')) {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return { response: NextResponse.json({ error: 'No file provided' }, { status: 400 }) };
    }

    const validationError = validateSiteUploadInput(file);
    if (validationError) return { response: NextResponse.json({ error: validationError }, { status: 400 }) };

    const buffer = Buffer.from(await file.arrayBuffer());
    return {
      payload: {
        buffer,
        fileName: file.name,
        mimeType: file.type,
        fileSize: file.size,
      },
    };
  }

  const fileName = decodeFileName(request.headers.get('x-file-name'));
  const declaredSize = parseContentLength(
    request.headers.get('x-file-size') || request.headers.get('content-length'),
  );

  const metadataError = validateSiteUploadMetadata({
    mimeType: contentType,
    fileSize: declaredSize ?? 0,
  });
  if (metadataError) {
    return { response: NextResponse.json({ error: metadataError }, { status: 400 }) };
  }

  const buffer = Buffer.from(await request.arrayBuffer());
  const actualValidationError = validateSiteUploadMetadata({
    mimeType: contentType,
    fileSize: buffer.byteLength,
  });
  if (actualValidationError) {
    return { response: NextResponse.json({ error: actualValidationError }, { status: 400 }) };
  }

  return {
    payload: {
      buffer,
      fileName,
      mimeType: contentType,
      fileSize: buffer.byteLength,
    },
  };
}

export async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const upload = await readUploadPayload(request);
    if (upload.response) return upload.response;

    const { buffer, fileName, mimeType, fileSize } = upload.payload;
    const mediaValidationError = await validateSiteUploadBuffer(buffer, fileName, mimeType);
    if (mediaValidationError) return NextResponse.json({ error: mediaValidationError }, { status: 400 });

    const uploadResult = await uploadSiteAsset(buffer, fileName, mimeType, fileSize, user.id);

    return NextResponse.json({
      success: true,
      asset: {
        id: uploadResult.assetId,
        originalUrl: uploadResult.originalUrl,
        thumbnailUrl: uploadResult.thumbnailUrl,
        width: uploadResult.width,
        height: uploadResult.height,
        fileName: uploadResult.fileName,
        fileSize: uploadResult.fileSize,
        mimeType: uploadResult.mimeType,
        hash: uploadResult.hash,
        reused: uploadResult.reused,
        isPubliclyReachable: uploadResult.isPubliclyReachable,
        storageProvider: uploadResult.storageProvider,
        warning: uploadResult.publicUploadWarning,
      },
    });
  } catch (error) {
    console.error('[Upload] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 }
    );
  }
}
