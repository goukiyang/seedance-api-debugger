/**
 * POST /api/assets/upload-ticket
 * 为浏览器直传 R2 生成短期上传票据。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { createDirectUploadTicket } from '@/lib/assets/direct-upload';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type UploadTicketBody = {
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
};

export async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const body = await request.json() as UploadTicketBody;
    const fileName = typeof body.fileName === 'string' ? body.fileName : 'upload.bin';
    const mimeType = typeof body.mimeType === 'string' ? body.mimeType : '';
    const fileSize = Number(body.fileSize);
    if (!Number.isFinite(fileSize) || fileSize < 0) {
      return NextResponse.json({ error: '文件大小无效，请重新选择文件。' }, { status: 400 });
    }

    const ticket = await createDirectUploadTicket({
      ownerId: user.id,
      fileName,
      mimeType,
      fileSize,
    });

    return NextResponse.json(ticket);
  } catch (error) {
    const message = error instanceof Error ? error.message : '上传票据创建失败';
    const status = message.includes('不支持的文件类型') || message.includes('过大') ? 400 : 503;
    return NextResponse.json({ error: message }, { status });
  }
}
