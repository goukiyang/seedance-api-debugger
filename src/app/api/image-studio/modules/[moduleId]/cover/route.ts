import { route as apiRoute } from '@/lib/http/route';
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { ModuleCoverError, readModuleCoverEditor, readModuleCoverRequest, readModuleCoverSnapshotRequest, saveModuleCover } from '@/lib/image-studio/module-cover';
import type { ModuleCoverSelection } from '@/lib/image-studio/module-cover-types';
import { StudioSharingError } from '@/lib/image-studio/shared-contract';
import { studioResultOrigin } from '@/lib/image-studio/result-origin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
function failure(error: unknown) {
  if (error instanceof ModuleCoverError || error instanceof StudioSharingError) return NextResponse.json({ error: error.message }, { status: error.status, headers });
  return NextResponse.json({ error: '封面保存或读取未确认，请核对本次保存结果；输入仍保留' }, { status: 503, headers });
}
export const GET = apiRoute({ access: 'user', rateLimit: false }, async function GET(request: NextRequest, props: { params: Promise<{ moduleId: string }> }) {
  const params = await props.params;
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
    const originOf = request.nextUrl.searchParams.get('originOf');
    if (originOf !== null) {
      // Validate the selected result and target before disclosing any frozen input.
      const selected = await readModuleCoverEditor(user, params.moduleId, [originOf]);
      const source = selected.sources[0];
      if (!source) throw new ModuleCoverError('未能确认选中的封面图片', 409);
      const origin = await studioResultOrigin(user.id, originOf);
      let originSource: ModuleCoverSelection['originSource'] = null;
      let originState: ModuleCoverSelection['originState'] = origin.state;
      if (origin.state === 'ready') {
        try {
          const input = await readModuleCoverEditor(user, params.moduleId, [origin.assetId]);
          originSource = input.sources[0] || null;
          if (!originSource) originState = 'unavailable';
        } catch (error) {
          if (!(error instanceof ModuleCoverError)) throw error;
          originState = 'unavailable';
        }
      }
      return NextResponse.json({ source, originSource, originState,
        originAssetId: originState === 'ready' ? originSource?.assetId || null : null } satisfies ModuleCoverSelection, { headers });
    }
    const sourceIds = request.nextUrl.searchParams.get('sourceAssetIds');
    return NextResponse.json(await readModuleCoverEditor(user, params.moduleId, sourceIds === null ? undefined : sourceIds.split(',')), { headers });
  } catch (error) { return failure(error); }
});
export const PUT = apiRoute({ access: 'user', rateLimit: false }, async function PUT(request: NextRequest, props: { params: Promise<{ moduleId: string }> }) {
  const params = await props.params;
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401, headers });
  try {
    if (Number(request.headers.get('content-length') || 0) > 12000) throw new ModuleCoverError('封面设置过大');
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body) || JSON.stringify(body).length > 12000) throw new ModuleCoverError('封面设置无效');
    const result = await saveModuleCover(user, params.moduleId, body);
    return NextResponse.json(result, { status: result.status === 'pending' ? 202 : 200, headers });
  } catch (error) { return error instanceof SyntaxError ? NextResponse.json({ error: '封面设置无效' }, { status: 400, headers }) : failure(error); }
});
