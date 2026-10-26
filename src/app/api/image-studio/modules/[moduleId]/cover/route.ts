import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { ModuleCoverError, readModuleCoverEditor, readModuleCoverRequest, readModuleCoverSnapshotRequest, saveModuleCover } from '@/lib/image-studio/module-cover';
import { StudioSharingError } from '@/lib/image-studio/shared-contract';
import { studioResultOriginAsset } from '@/lib/image-studio/result-origin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
function failure(error: unknown) {
  if (error instanceof ModuleCoverError || error instanceof StudioSharingError) return NextResponse.json({ error: error.message }, { status: error.status, headers });
  return NextResponse.json({ error: '封面保存或读取未确认，请核对本次保存结果；输入仍保留' }, { status: 503, headers });
}
export async function GET(request: NextRequest, { params }: { params: { moduleId: string } }) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401, headers });
  try {
    const requestId = request.nextUrl.searchParams.get('requestId');
    const intent = request.nextUrl.searchParams.get('intent');
    if (intent !== null && intent !== 'shared-snapshot') throw new ModuleCoverError('封面查询类型无效');
    if (intent === 'shared-snapshot') {
      if (!requestId) throw new ModuleCoverError('请保留原保存请求编号');
      return NextResponse.json(await readModuleCoverSnapshotRequest(user, params.moduleId, requestId), { headers });
    }
    if (requestId !== null) return NextResponse.json(await readModuleCoverRequest(user, params.moduleId, requestId), { headers });
    // The direct input image of the user's own generation that produced this result (for 左右/上下 covers).
    const originOf = request.nextUrl.searchParams.get('originOf');
    if (originOf !== null) return NextResponse.json({ originAssetId: await studioResultOriginAsset(user.id, originOf) }, { headers });
    const sourceIds = request.nextUrl.searchParams.get('sourceAssetIds');
    return NextResponse.json(await readModuleCoverEditor(user, params.moduleId, sourceIds === null ? undefined : sourceIds.split(',')), { headers });
  } catch (error) { return failure(error); }
}
export async function PUT(request: NextRequest, { params }: { params: { moduleId: string } }) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401, headers });
  try {
    if (Number(request.headers.get('content-length') || 0) > 12000) throw new ModuleCoverError('封面设置过大');
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body) || JSON.stringify(body).length > 12000) throw new ModuleCoverError('封面设置无效');
    const result = await saveModuleCover(user, params.moduleId, body);
    return NextResponse.json(result, { status: result.status === 'pending' ? 202 : 200, headers });
  } catch (error) { return error instanceof SyntaxError ? NextResponse.json({ error: '封面设置无效' }, { status: 400, headers }) : failure(error); }
}
