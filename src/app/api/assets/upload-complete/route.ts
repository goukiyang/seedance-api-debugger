/**
 * POST /api/assets/upload-complete
 * 浏览器直传 R2 完成后，校验对象并登记到用户上传历史。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { completeDirectUpload } from '@/lib/assets/direct-upload';
import { getSiteUploadKind } from '@/lib/assets/site-upload';
import { recordAssetUploadLog } from '@/lib/assets/upload-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type UploadCompleteBody = {
  uploadToken?: string;
  hash?: string;
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
};

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  let userId: string | null = null;
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    userId = user.id;

    const body = await request.json() as UploadCompleteBody;
    if (typeof body.uploadToken !== 'string' || !body.uploadToken.trim()) {
      return NextResponse.json({ error: '缺少上传票据，请重新上传。' }, { status: 400 });
    }
    if (typeof body.hash !== 'string' || !body.hash.trim()) {
      return NextResponse.json({ error: '缺少文件校验信息，请重新上传。' }, { status: 400 });
    }

    const uploadResult = await completeDirectUpload({
      ownerId: user.id,
      uploadToken: body.uploadToken,
      hash: body.hash,
      width: body.width,
      height: body.height,
      durationSeconds: body.durationSeconds,
    });

    await recordAssetUploadLog({
      operatorId: user.id,
      stage: 'complete',
      status: uploadResult.reused ? 'reused' : 'succeeded',
      assetId: uploadResult.assetId,
      fileName: uploadResult.fileName,
      mimeType: uploadResult.mimeType,
      fileSize: uploadResult.fileSize,
      durationMs: Date.now() - startedAt,
      reused: uploadResult.reused,
      storageProvider: uploadResult.storageProvider,
      uploadMode: 'single',
      fallbackPath: 'browser-put',
      skippedProxy: true,
      fileKind: getSiteUploadKind(uploadResult.mimeType),
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
    const message = error instanceof Error ? error.message : '上传完成登记失败';
    if (userId) {
      await recordAssetUploadLog({
        operatorId: userId,
        stage: 'complete',
        status: 'failed',
        durationMs: Date.now() - startedAt,
        errorCode: 'complete_failed',
        errorMessage: message,
        uploadMode: 'single',
        fallbackPath: 'browser-put',
        skippedProxy: true,
      });
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
