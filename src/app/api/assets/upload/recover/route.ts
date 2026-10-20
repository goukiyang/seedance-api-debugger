import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { assertUploadOwner, uploadIdentity, VerifiedUploadError, verifiedUploadFailure } from '@/lib/assets/verified-upload';
import { rawUploadIdentity, recoverRetiredRawUpload } from '@/lib/assets/raw-upload-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    assertUploadOwner(request.headers.get('x-upload-owner-id'), user.id);
    await uploadIdentity(user.id);
    if (Number(request.headers.get('content-length')) > 4096) return NextResponse.json({ error: '恢复信息过大' }, { status: 413 });
    const input = await request.json();
    const identity = rawUploadIdentity(user.id, input);
    return NextResponse.json(await recoverRetiredRawUpload(identity, input.recoveryToken), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof VerifiedUploadError) return NextResponse.json(verifiedUploadFailure(error), { status: error.status });
    return NextResponse.json({ error: '原上传尚不能安全恢复，已保留原记录，请稍后核对', code: 'UPLOAD_RESULT_UNKNOWN' }, { status: 503 });
  }
}
