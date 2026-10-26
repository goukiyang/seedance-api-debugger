import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { assertUploadOwner, VerifiedUploadError } from '@/lib/assets/verified-upload';
import { keepUploadSimilarityPair, uploadSimilarityCandidates } from '@/lib/assets/upload-similarity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
function failure(error: unknown) {
  return error instanceof VerifiedUploadError ? NextResponse.json({ error: error.code, message: error.message }, { status: error.status })
    : NextResponse.json({ error: 'SIMILARITY_UNAVAILABLE', message: '相似图片检查暂不可用，已上传图片保留' }, { status: 503 });
}
export async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    assertUploadOwner(request.headers.get('x-upload-owner-id'), user.id);
    const assetId = request.nextUrl.searchParams.get('assetId');
    if (!validId(assetId)) return NextResponse.json({ error: '素材编号无效' }, { status: 400 });
    return NextResponse.json(await uploadSimilarityCandidates(user.id, assetId, request.nextUrl.searchParams.get('cursor') || undefined));
  } catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    if (Number(request.headers.get('content-length') || 0) > 8192) return NextResponse.json({ error: '请求过大' }, { status: 413 });
    const body = await request.json();
    assertUploadOwner(request.headers.get('x-upload-owner-id'), user.id);
    assertUploadOwner(body.ownerId, user.id);
    if (body.action !== 'keep_both' || !validId(body.assetId) || !validId(body.candidateAssetId)
      || ![body.sourceVersion, body.candidateSourceVersion, body.algorithmVersion].every(value => typeof value === 'string' && value.length > 0 && value.length <= 512)) {
      return NextResponse.json({ error: '相似图片决定无效' }, { status: 400 });
    }
    return NextResponse.json(await keepUploadSimilarityPair(user.id, body));
  } catch (error) { return failure(error); }
}
