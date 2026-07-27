/**
 * POST /api/assets/upload-proxy
 * 浏览器直传 R2 被 CORS 拦截时，使用本站后端按同一上传票据中转写入 R2。
 */

import { Readable } from 'stream';
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { proxyDirectUploadToStorage } from '@/lib/assets/direct-upload';

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

export async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    if (!request.body) return NextResponse.json({ error: '缺少上传文件内容，请重新上传。' }, { status: 400 });

    const uploadResult = await proxyDirectUploadToStorage({
      ownerId: user.id,
      uploadToken: readRequiredHeader(request, 'x-upload-token', '上传票据'),
      hash: readRequiredHeader(request, 'x-file-hash', '文件校验信息'),
      width: readOptionalNumberHeader(request, 'x-image-width'),
      height: readOptionalNumberHeader(request, 'x-image-height'),
      durationSeconds: readOptionalNumberHeader(request, 'x-media-duration'),
      contentLength: readOptionalNumberHeader(request, 'content-length'),
      body: Readable.fromWeb(request.body as any),
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
    const message = error instanceof Error ? error.message : '服务端中转上传失败';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
