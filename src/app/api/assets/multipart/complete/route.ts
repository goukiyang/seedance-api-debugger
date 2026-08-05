/**
 * POST /api/assets/multipart/complete
 * 完成 R2 multipart 合并并登记 Asset。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { completeMultipartUpload } from '@/lib/assets/direct-upload';
import { recordAssetUploadLog } from '@/lib/assets/upload-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type MultipartCompleteBody = {
  uploadToken?: string;
  hash?: string;
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
  parts?: Array<{ partNumber?: number; eTag?: string }>;
};

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  let userId: string | null = null;
  let partCount: number | null = null;
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    userId = user.id;

    const body = await request.json() as MultipartCompleteBody;
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
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '分块上传完成失败';
    if (userId) {
      await recordAssetUploadLog({
        operatorId: userId,
        stage: 'multipart_complete',
        status: 'failed',
        durationMs: Date.now() - startedAt,
        errorCode: 'multipart_complete_failed',
        errorMessage: message,
        uploadMode: 'multipart',
        totalParts: partCount,
      });
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
