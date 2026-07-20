/**
 * POST /api/assets/upload-complete
 * 浏览器直传 R2 完成后，校验对象并登记到用户上传历史。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { completeDirectUpload } from '@/lib/assets/direct-upload';

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
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

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
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
