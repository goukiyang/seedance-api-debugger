import { route as apiRoute } from '@/lib/http/route';
/**
 * POST /api/assets/multipart/complete
 * 完成 R2 multipart 合并并登记 Asset。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { assertUploadOwner, uploadRequestId, verifiedUploadFailure, VerifiedUploadError } from '@/lib/assets/verified-upload';
import { completeMultipartUpload } from '@/lib/assets/direct-upload';
import { recordAssetUploadLog } from '@/lib/assets/upload-log';
import { browserUploadResponse } from '@/lib/media/browser-projection.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type MultipartCompleteBody = {
  ownerId?: string;
  requestId?: string;
  uploadToken?: string;
  hash?: string;
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
  parts?: Array<{ partNumber?: number; eTag?: string }>;
};

export const POST = apiRoute({ access: 'user', rateLimit: false }, async function POST(request: NextRequest) {
  const startedAt = Date.now();
  let userId: string | null = null;
  let partCount: number | null = null;
  let originalRequestId: string | null = null;
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    userId = user.id;
    assertUploadOwner(request.headers.get('x-upload-owner-id'), user.id);

    const body = await request.json() as MultipartCompleteBody;
    assertUploadOwner(body.ownerId, user.id);
    originalRequestId = uploadRequestId(body.requestId) || null;
    if (typeof body.uploadToken !== 'string' || !body.uploadToken.trim()) {
      return NextResponse.json({ error: '缺少上传票据，请重新上传。' }, { status: 400 });
    }
    if (typeof body.hash !== 'string' || !body.hash.trim()) {
      return NextResponse.json({ error: '缺少文件校验信息，请重新上传。' }, { status: 400 });
    }
    partCount = Array.isArray(body.parts) ? body.parts.length : null;
    const uploadResult = await completeMultipartUpload({
      ownerId: user.id,
      uploadToken: body.uploadToken,
      hash: body.hash,
      width: body.width,
      height: body.height,
      durationSeconds: body.durationSeconds,
      parts: (body.parts || []).map((part) => ({
        partNumber: Number(part.partNumber),
        eTag: typeof part.eTag === 'string' ? part.eTag : '',
      })),
    });

    await recordAssetUploadLog({
      operatorId: user.id,
      stage: 'multipart_complete',
      status: uploadResult.reused ? 'reused' : 'succeeded',
      assetId: uploadResult.assetId,
      fileName: uploadResult.fileName,
      mimeType: uploadResult.mimeType,
      fileSize: uploadResult.fileSize,
      durationMs: Date.now() - startedAt,
      reused: uploadResult.reused,
      storageProvider: uploadResult.storageProvider,
      uploadMode: 'multipart',
      totalParts: partCount,
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
    if (error instanceof VerifiedUploadError) {
      if (userId) await recordAssetUploadLog({ operatorId: userId, stage: 'multipart_complete', status: 'failed',
        durationMs: Date.now() - startedAt, errorCode: error.code, errorMessage: error.message,
        errorStage: 'multipart_complete', requestId: originalRequestId, uploadMode: 'multipart', totalParts: partCount });
      return NextResponse.json({ ...verifiedUploadFailure(error), errorStage: 'multipart_complete' }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : '分块上传完成失败';
    if (userId) {
      await recordAssetUploadLog({
        operatorId: userId,
        stage: 'multipart_complete',
        status: 'failed',
        durationMs: Date.now() - startedAt,
        errorCode: 'multipart_complete_failed',
        errorMessage: message,
        errorStage: 'multipart_complete',
        requestId: originalRequestId,
        uploadMode: 'multipart',
        totalParts: partCount,
      });
    }
    return NextResponse.json({ error: '上传登记暂不可用，原上传结果待确认；请核对原上传', code: 'UPLOAD_RESULT_UNKNOWN', errorStage: 'multipart_complete' }, { status: 400 });
  }
});
