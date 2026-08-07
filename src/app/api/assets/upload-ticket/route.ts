/**
 * POST /api/assets/upload-ticket
 * 为浏览器直传 R2 生成短期上传票据。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { createDirectUploadTicket } from '@/lib/assets/direct-upload';
import { getSiteUploadKind } from '@/lib/assets/site-upload';
import { recordAssetUploadLog } from '@/lib/assets/upload-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type UploadTicketBody = {
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  hash?: string;
  width?: number | null;
  height?: number | null;
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

    const body = await request.json() as UploadTicketBody;
    fileName = typeof body.fileName === 'string' ? body.fileName : 'upload.bin';
    mimeType = typeof body.mimeType === 'string' ? body.mimeType : '';
    const hash = typeof body.hash === 'string' ? body.hash : '';
    fileSize = Number(body.fileSize);
    if (!Number.isFinite(fileSize) || fileSize < 0) {
      await recordAssetUploadLog({
        operatorId: user.id,
        stage: 'ticket',
        status: 'failed',
        fileName,
        mimeType,
        fileSize,
        durationMs: Date.now() - startedAt,
        errorCode: 'invalid_file_size',
        errorMessage: '文件大小无效',
        fileKind: getSiteUploadKind(mimeType),
      });
      return NextResponse.json({ error: '文件大小无效，请重新选择文件。' }, { status: 400 });
    }

    const ticket = await createDirectUploadTicket({
      ownerId: user.id,
      fileName,
      mimeType,
      fileSize,
      hash,
      width: body.width,
      height: body.height,
    });

    await recordAssetUploadLog({
      operatorId: user.id,
      stage: 'ticket',
      status: ticket.directUploadAvailable ? 'succeeded' : ('reused' in ticket && ticket.reused ? 'reused' : 'unavailable'),
      assetId: 'asset' in ticket ? ticket.asset?.id : null,
      fileName,
      mimeType,
      fileSize,
      durationMs: Date.now() - startedAt,
      reused: 'reused' in ticket ? ticket.reused === true : false,
      storageProvider: 'storageProvider' in ticket ? ticket.storageProvider : null,
      uploadMode: ticket.directUploadAvailable ? 'single' : ('uploadToken' in ticket ? 'proxy' : null),
      fallbackPath: ticket.directUploadAvailable ? 'browser-put' : ('reused' in ticket && ticket.reused ? 'reuse' : ('uploadToken' in ticket ? 'proxy' : 'raw')),
      skippedProxy: false,
      fileKind: getSiteUploadKind(mimeType),
    });
    return NextResponse.json(ticket);
  } catch (error) {
    const message = error instanceof Error ? error.message : '上传票据创建失败';
    if (userId) {
      await recordAssetUploadLog({
        operatorId: userId,
        stage: 'ticket',
        status: 'failed',
        fileName,
        mimeType,
        fileSize,
        durationMs: Date.now() - startedAt,
        errorCode: 'ticket_failed',
        errorMessage: message,
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
}
