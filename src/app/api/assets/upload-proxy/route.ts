import { route as apiRoute } from '@/lib/http/route';
/**
 * POST /api/assets/upload-proxy
 * 使用本站后端按同一上传票据中转写入 R2。
 */

import { Readable } from 'stream';
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { assertUploadOwner, verifiedUploadFailure, VerifiedUploadError } from '@/lib/assets/verified-upload';
import { directUploadRequestId, proxyDirectUploadToStorage } from '@/lib/assets/direct-upload';
import { directUploadFailure } from '@/lib/assets/direct-upload-error';
import { getSiteUploadKind } from '@/lib/assets/site-upload';
import { recordAssetUploadLog } from '@/lib/assets/upload-log';
import { browserUploadResponse } from '@/lib/media/browser-projection.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

function readRequiredHeader(request: NextRequest, name: string, label: string) {
  const value = request.headers.get(name)?.trim();
  if (!value) throw new Error(`缺少${label}，请重新上传。`);
  return value;
}

function readOptionalNumberHeader(request: NextRequest, name: string) {
  const value = request.headers.get(name);
  if (value == null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export const POST = apiRoute({ access: 'user', rateLimit: false }, async function POST(request: NextRequest) {
  const startedAt = Date.now();
  let userId: string | null = null;
  let originalRequestId: string | null = null;
  const mimeType = request.headers.get('content-type') || null;
  const fileSize = readOptionalNumberHeader(request, 'content-length');
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    userId = user.id;
    assertUploadOwner(request.headers.get('x-upload-owner-id'), user.id);
    if (!request.body) return NextResponse.json({ error: '缺少上传文件内容，请重新上传。' }, { status: 400 });
    const uploadToken = readRequiredHeader(request, 'x-upload-token', '上传票据');
    originalRequestId = directUploadRequestId(uploadToken, user.id);

    const uploadResult = await proxyDirectUploadToStorage({
      ownerId: user.id,
      uploadToken,
      hash: readRequiredHeader(request, 'x-file-hash', '文件校验信息'),
      width: readOptionalNumberHeader(request, 'x-media-width') ?? readOptionalNumberHeader(request, 'x-image-width'),
      height: readOptionalNumberHeader(request, 'x-media-height') ?? readOptionalNumberHeader(request, 'x-image-height'),
      durationSeconds: readOptionalNumberHeader(request, 'x-media-duration'),
      contentLength: fileSize,
      body: Readable.fromWeb(request.body as any),
    });

    await recordAssetUploadLog({
      operatorId: user.id,
      stage: 'proxy',
      status: uploadResult.reused ? 'reused' : 'succeeded',
      assetId: uploadResult.assetId,
      fileName: uploadResult.fileName,
      mimeType: uploadResult.mimeType,
      fileSize: uploadResult.fileSize,
      durationMs: Date.now() - startedAt,
      reused: uploadResult.reused,
      storageProvider: uploadResult.storageProvider,
      uploadMode: 'proxy',
      fallbackPath: 'proxy',
      skippedProxy: false,
      fileKind: getSiteUploadKind(uploadResult.mimeType),
      requestId: originalRequestId,
    });
    return NextResponse.json(await browserUploadResponse(user, {
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
        upload: uploadResult.upload,
        similarity: uploadResult.similarity,
      },
    }), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    const diagnostic = directUploadFailure(error, 'proxy');
    const verified = error instanceof VerifiedUploadError ? verifiedUploadFailure(error) : null;
    if (userId) {
      await recordAssetUploadLog({
        operatorId: userId,
        stage: 'proxy',
        status: 'failed',
        mimeType,
        fileSize,
        durationMs: Date.now() - startedAt,
        errorCode: verified?.code || diagnostic.code,
        errorMessage: verified?.error || diagnostic.error,
        errorName: diagnostic.errorName, causeCode: diagnostic.causeCode,
        errorStage: 'proxy', recovery: diagnostic.recovery, requestId: originalRequestId,
        uploadMode: 'proxy',
        fallbackPath: 'proxy',
        skippedProxy: false,
        fileKind: mimeType ? getSiteUploadKind(mimeType) : null,
      });
    }
    return NextResponse.json(verified ? { ...verified, errorStage: 'proxy', recovery: 'query' } : diagnostic,
      { status: error instanceof VerifiedUploadError ? error.status : 503 });
  }
});
