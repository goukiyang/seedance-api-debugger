import { route as apiRoute } from '@/lib/http/route';
/**
 * POST /api/assets/multipart/start
 * 初始化大文件 R2 multipart 上传，不接收文件体。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { assertUploadOwner, uploadRequestId, verifiedUploadFailure, VerifiedUploadError } from '@/lib/assets/verified-upload';
import { createMultipartUploadTicket } from '@/lib/assets/direct-upload';
import { getSiteUploadKind } from '@/lib/assets/site-upload';
import { recordAssetUploadLog } from '@/lib/assets/upload-log';
import { browserUploadResponse } from '@/lib/media/browser-projection.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type MultipartStartBody = {
  ownerId?: string;
  requestId?: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  hash?: string;
  width?: number | null;
  height?: number | null;
};

export const POST = apiRoute({ access: 'user', rateLimit: false }, async function POST(request: NextRequest) {
  const startedAt = Date.now();
  let userId: string | null = null;
  let fileName = 'upload.bin';
  let mimeType = '';
  let fileSize: number | null = null;
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    userId = user.id;
    assertUploadOwner(request.headers.get('x-upload-owner-id'), user.id);

    const body = await request.json() as MultipartStartBody;
    assertUploadOwner(body.ownerId, user.id);
    const requestId = uploadRequestId(body.requestId);
    fileName = typeof body.fileName === 'string' ? body.fileName : 'upload.bin';
    mimeType = typeof body.mimeType === 'string' ? body.mimeType : '';
    const hash = typeof body.hash === 'string' ? body.hash : '';
    fileSize = Number(body.fileSize);
    if (!Number.isFinite(fileSize) || fileSize < 0) {
      await recordAssetUploadLog({
        operatorId: user.id,
        stage: 'multipart_start',
        status: 'failed',
        fileName,
        mimeType,
        fileSize,
        durationMs: Date.now() - startedAt,
        errorCode: 'invalid_file_size',
        errorMessage: '文件大小无效',
        uploadMode: 'multipart',
        fallbackPath: 'multipart',
        skippedProxy: true,
        fileKind: getSiteUploadKind(mimeType),
      });
      return NextResponse.json({ error: '文件大小无效，请重新选择文件。' }, { status: 400 });
    }

    const ticket = await createMultipartUploadTicket({
      ownerId: user.id,
      requestId,
      fileName,
      mimeType,
      fileSize,
      hash,
      width: body.width,
      height: body.height,
    });

    await recordAssetUploadLog({
      operatorId: user.id,
      stage: 'multipart_start',
      status: ticket.directUploadAvailable ? 'succeeded' : ('reused' in ticket && ticket.reused ? 'reused' : 'unavailable'),
      assetId: 'asset' in ticket ? ticket.asset?.id : null,
      fileName,
      mimeType,
      fileSize,
      durationMs: Date.now() - startedAt,
      reused: 'reused' in ticket ? ticket.reused === true : false,
      storageProvider: 'storageProvider' in ticket ? ticket.storageProvider : null,
      uploadMode: 'multipart',
      fallbackPath: 'multipart',
      skippedProxy: true,
      fileKind: getSiteUploadKind(mimeType),
      totalParts: 'partCount' in ticket ? ticket.partCount : null,
    });
    return NextResponse.json(await browserUploadResponse(user, ticket), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof VerifiedUploadError) return NextResponse.json(verifiedUploadFailure(error), { status: error.status });
    const message = error instanceof Error ? error.message : '分块上传初始化失败';
    if (userId) {
      await recordAssetUploadLog({
        operatorId: userId,
        stage: 'multipart_start',
        status: 'failed',
        fileName,
        mimeType,
        fileSize,
        durationMs: Date.now() - startedAt,
        errorCode: 'multipart_start_failed',
        errorMessage: message,
        uploadMode: 'multipart',
        fallbackPath: 'multipart',
        skippedProxy: true,
        fileKind: getSiteUploadKind(mimeType),
      });
    }
    const status = (
      message.includes('不支持的文件类型') ||
      message.includes('过大') ||
      message.includes('文件校验信息无效')
    ) ? 400 : 503;
    return NextResponse.json({ error: message }, { status });
  }
});
