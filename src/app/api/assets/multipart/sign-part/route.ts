/**
 * POST /api/assets/multipart/sign-part
 * 为单个 multipart part 生成短期 PUT 地址。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { assertUploadOwner, verifiedUploadFailure, VerifiedUploadError } from '@/lib/assets/verified-upload';
import { signMultipartUploadPart } from '@/lib/assets/direct-upload';
import { recordAssetUploadLog } from '@/lib/assets/upload-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type MultipartSignPartBody = {
  ownerId?: string;
  uploadToken?: string;
  partNumber?: number;
};

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  let userId: string | null = null;
  let partNumber: number | null = null;
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    userId = user.id;
    assertUploadOwner(request.headers.get('x-upload-owner-id'), user.id);

    const body = await request.json() as MultipartSignPartBody;
    assertUploadOwner(body.ownerId, user.id);
    if (typeof body.uploadToken !== 'string' || !body.uploadToken.trim()) {
      return NextResponse.json({ error: '缺少上传票据，请重新上传。' }, { status: 400 });
    }
    partNumber = Number(body.partNumber);
    const ticket = await signMultipartUploadPart({
      ownerId: user.id,
      uploadToken: body.uploadToken,
      partNumber,
    });

    await recordAssetUploadLog({
      operatorId: user.id,
      stage: 'multipart_sign_part',
      status: 'succeeded',
      durationMs: Date.now() - startedAt,
      uploadMode: 'multipart',
      partNumber,
    });
    return NextResponse.json(ticket);
  } catch (error) {
    if (error instanceof VerifiedUploadError) return NextResponse.json(verifiedUploadFailure(error), { status: error.status });
    const message = error instanceof Error ? error.message : '分块上传签名失败';
    if (userId) {
      await recordAssetUploadLog({
        operatorId: userId,
        stage: 'multipart_sign_part',
        status: 'failed',
        durationMs: Date.now() - startedAt,
        errorCode: 'multipart_sign_part_failed',
        errorMessage: message,
        uploadMode: 'multipart',
        partNumber,
      });
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
