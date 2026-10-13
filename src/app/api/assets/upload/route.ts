/**
 * POST /api/assets/upload
 * 上传单个文件（图片/视频/音频）
 * - 优先使用公网上传（R2/TOS），返回公网 HTTPS URL
 * - 回退本地存储（development / 未配置公网存储时）
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { assertUploadOwner, uploadDigest, uploadIdentity, uploadRequestId, readVerifiedUploadReceipt, releaseVerifiedUpload, verifiedUploadFailure, VerifiedUploadError } from '@/lib/assets/verified-upload';
import {
  getSiteUploadKind,
  isLocalPublicUploadUrl,
  sameOriginPublicUrlForLocalUpload,
  uploadSiteAsset,
  validateSiteUploadInput,
  validateSiteUploadMetadata,
} from '@/lib/assets/site-upload';
import { recordAssetUploadLog } from '@/lib/assets/upload-log';
import { requestHd } from '@/lib/media/hd-derivatives';
import { isPubliclyReachableUrl } from '@/lib/assets/public-storage';
import { uploadSimilarityStatus } from '@/lib/assets/upload-similarity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

const MULTIPART_COMPAT_MAX_SIZE_BYTES = 8 * 1024 * 1024;

// Read the original committed receipt only. Absence can also mean the original
// request is still running, so it must never be reported as not accepted.
export async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    assertUploadOwner(request.headers.get('x-upload-owner-id'), user.id);
    await uploadIdentity(user.id);
    const query = request.nextUrl.searchParams;
    const requestId = uploadRequestId(query.get('requestId'));
    const hash = query.get('hash') || '';
    const fileSize = Number(query.get('fileSize'));
    const mimeType = (query.get('mimeType') || '').split(';')[0].trim().toLowerCase();
    if (!requestId || !/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(fileSize) || fileSize <= 0
      || validateSiteUploadMetadata({ mimeType, fileSize })) throw new VerifiedUploadError('UPLOAD_IDENTITY_INVALID', '原上传文件身份无法确认', 400);
    const found = await readVerifiedUploadReceipt(user.id, requestId, uploadDigest(JSON.stringify([hash, fileSize, mimeType])));
    if (!found) throw new VerifiedUploadError('UPLOAD_RESULT_UNKNOWN', '原上传结果尚未确认，请稍后查询；未重新发送文件');
    try {
      const asset = found.asset;
      const originalUrl = sameOriginPublicUrlForLocalUpload(asset.original_url) || asset.original_url;
      const thumbnailUrl = asset.thumbnail_url ? sameOriginPublicUrlForLocalUpload(asset.thumbnail_url) || asset.thumbnail_url : null;
      const similarity = await uploadSimilarityStatus(user.id, asset.id).catch(() => ({ state: 'unavailable' as const, coverage: 'new_uploads_only' as const }));
      return NextResponse.json({ success: true, asset: { id: asset.id, originalUrl, thumbnailUrl,
        width: asset.width, height: asset.height, fileName: asset.file_name, fileSize: asset.file_size, mimeType: asset.mime_type,
        hash: asset.hash, reused: found.reused, similarity, isPubliclyReachable: isPubliclyReachableUrl(originalUrl),
        storageProvider: isLocalPublicUploadUrl(asset.original_url) ? 'local-public' : undefined,
        ...(!isPubliclyReachableUrl(originalUrl) ? { warning: '文件已保存；当前站点未配置可供外部服务访问的原文件地址。' } : {}),
        upload: { requestId, verified: true, assetDisposition: found.reused ? 'reused' : 'new',
          sourceVersion: found.proof.sourceVersion || found.proof.version } } }, { headers: { 'Cache-Control': 'private, no-store' } });
    } finally { await releaseVerifiedUpload(found.proof); }
  } catch (error) {
    if (error instanceof VerifiedUploadError) return NextResponse.json(verifiedUploadFailure(error), { status: error.status });
    return NextResponse.json({ error: '原上传结果暂时无法核对，请稍后查询；未重新发送文件' }, { status: 503 });
  }
}

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
async function readBoundedBody(request: NextRequest, expected: number) {
  if (!request.body) throw new VerifiedUploadError('UPLOAD_BODY_MISSING', '没有收到上传文件', 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > expected) throw new VerifiedUploadError('UPLOAD_SIZE_MISMATCH', '实际文件大小与声明不一致', 400);
      chunks.push(part.value);
    }
    if (size !== expected) throw new VerifiedUploadError('UPLOAD_SIZE_MISMATCH', '文件没有完整上传', 400);
    return Buffer.concat(chunks, size);
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

async function readUploadPayload(request: NextRequest): Promise<
  | { payload: UploadPayload; response?: never }
  | { payload?: never; response: NextResponse }
> {
  const contentTypeHeader = request.headers.get('content-type') || '';
  const contentType = contentTypeHeader.split(';')[0]?.trim().toLowerCase() || '';

  if (contentTypeHeader.toLowerCase().includes('multipart/form-data')) {
    const multipartContentLength = parseContentLength(request.headers.get('content-length'));
    if (multipartContentLength == null) {
      return {
        response: NextResponse.json(
          { error: '当前旧版表单上传缺少文件大小信息，请刷新页面后使用新版上传链路。' },
          { status: 411 },
        ),
      };
    }
    if (multipartContentLength != null && multipartContentLength > MULTIPART_COMPAT_MAX_SIZE_BYTES) {
      return {
        response: NextResponse.json(
          { error: '当前上传入口只兼容 8MB 以内旧版表单上传，请刷新页面后使用新版上传链路。' },
          { status: 413 },
        ),
      };
    }
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

  const buffer = await readBoundedBody(request, declaredSize!);
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
  const startedAt = Date.now();
  let userId: string | null = null;
  let fileName: string | null = decodeFileName(request.headers.get('x-file-name'));
  let mimeType: string | null = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || null;
  let fileSize: number | null = parseContentLength(request.headers.get('x-file-size') || request.headers.get('content-length'));
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    userId = user.id;
    assertUploadOwner(request.headers.get('x-upload-owner-id'), user.id);
    await uploadIdentity(user.id);
    const requestId = uploadRequestId(request.headers.get('x-upload-request-id'));

    const upload = await readUploadPayload(request);
    if (upload.response) return upload.response;

    ({ fileName, mimeType, fileSize } = upload.payload);
    const { buffer } = upload.payload;
    const uploadResult = await uploadSiteAsset(buffer, fileName, mimeType, fileSize, user.id, null, requestId);
    if (mimeType.startsWith('image/')) void requestHd(uploadResult.originalUrl, 0).catch(() => {});

    await recordAssetUploadLog({
      operatorId: user.id,
      stage: 'raw',
      status: uploadResult.reused ? 'reused' : 'succeeded',
      assetId: uploadResult.assetId,
      fileName,
      mimeType,
      fileSize,
      durationMs: Date.now() - startedAt,
      reused: uploadResult.reused,
      storageProvider: uploadResult.storageProvider,
      uploadMode: 'raw',
      fallbackPath: uploadResult.storageProvider === 'local-public' ? 'local-public' : 'raw',
      skippedProxy: true,
      fileKind: getSiteUploadKind(uploadResult.mimeType),
    });
    return NextResponse.json({
      success: true,
      upload: uploadResult.upload,
      similarity: uploadResult.similarity,
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
        upload: uploadResult.upload,
        similarity: uploadResult.similarity,
      },
    });
  } catch (error) {
    if (error instanceof VerifiedUploadError) return NextResponse.json(verifiedUploadFailure(error), { status: error.status });
    console.error('[Upload] Error:', error);
    if (userId) {
      await recordAssetUploadLog({
        operatorId: userId,
        stage: 'raw',
        status: 'failed',
        fileName,
        mimeType,
        fileSize,
        durationMs: Date.now() - startedAt,
        errorCode: 'raw_failed',
        errorMessage: error instanceof Error ? error.message : 'Upload failed',
        uploadMode: 'raw',
        fallbackPath: 'raw',
        skippedProxy: true,
        fileKind: mimeType ? getSiteUploadKind(mimeType) : null,
      });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 }
    );
  }
}
