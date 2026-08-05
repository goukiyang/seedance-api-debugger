/**
 * POST /api/assets/multipart/start
 * 初始化大文件 R2 multipart 上传，不接收文件体。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { createMultipartUploadTicket } from '@/lib/assets/direct-upload';
import { recordAssetUploadLog } from '@/lib/assets/upload-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type MultipartStartBody = {
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  hash?: string;
};

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  let userId: string | null = null;
  let fileName = 'upload.bin';
  let mimeType = '';
  let fileSize: number | null = null;
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    userId = user.id;

    const body = await request.json() as MultipartStartBody;
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
      });
      return NextResponse.json({ error: '文件大小无效，请重新选择文件。' }, { status: 400 });
    }

    const ticket = await createMultipartUploadTicket({
      ownerId: user.id,
      fileName,
      mimeType,
      fileSize,
      hash,
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
      totalParts: 'partCount' in ticket ? ticket.partCount : null,
    });
    return NextResponse.json(ticket);
  } catch (error) {
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
      });
    }
    const status = (
      message.includes('不支持的文件类型') ||
      message.includes('过大') ||
      message.includes('文件校验信息无效')
    ) ? 400 : 503;
    return NextResponse.json({ error: message }, { status });
  }
}
