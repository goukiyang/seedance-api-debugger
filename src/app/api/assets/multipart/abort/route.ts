import { route as apiRoute } from '@/lib/http/route';
/**
 * POST /api/assets/multipart/abort
 * 放弃 R2 multipart 上传并清理对象存储未完成分片。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { assertUploadOwner, verifiedUploadFailure, VerifiedUploadError } from '@/lib/assets/verified-upload';
import { abortMultipartUpload } from '@/lib/assets/direct-upload';
import { recordAssetUploadLog } from '@/lib/assets/upload-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type MultipartAbortBody = {
  ownerId?: string;
  uploadToken?: string;
};

export const POST = apiRoute({ access: 'user', rateLimit: false }, async function POST(request: NextRequest) {
  const startedAt = Date.now();
  let userId: string | null = null;
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    userId = user.id;
    assertUploadOwner(request.headers.get('x-upload-owner-id'), user.id);

    const body = await request.json() as MultipartAbortBody;
    assertUploadOwner(body.ownerId, user.id);
    if (typeof body.uploadToken !== 'string' || !body.uploadToken.trim()) {
      return NextResponse.json({ error: '缺少上传票据，请重新上传。' }, { status: 400 });
    }

    await abortMultipartUpload({
      ownerId: user.id,
      uploadToken: body.uploadToken,
    });

    await recordAssetUploadLog({
      operatorId: user.id,
      stage: 'multipart_abort',
      status: 'succeeded',
      durationMs: Date.now() - startedAt,
      uploadMode: 'multipart',
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof VerifiedUploadError) return NextResponse.json(verifiedUploadFailure(error), { status: error.status });
    const message = error instanceof Error ? error.message : '分块上传取消失败';
    if (userId) {
      await recordAssetUploadLog({
        operatorId: userId,
        stage: 'multipart_abort',
        status: 'failed',
        durationMs: Date.now() - startedAt,
        errorCode: 'multipart_abort_failed',
        errorMessage: message,
        uploadMode: 'multipart',
      });
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }
});
