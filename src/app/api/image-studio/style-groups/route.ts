import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { deleteStudioStyleGroup, getStudioStyleGroup, listStudioStyleGroups, listStudioStyleGroupsPage, parseStudioStyleIds, saveStudioStyleGroup, StudioStyleError, studioStyleDTO, studioStyleOperationStatus, studioStyleDraft } from '@/lib/image-studio/style-groups';

export const dynamic = 'force-dynamic';
function failure(error: unknown) {
  if (error instanceof StudioStyleError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof SyntaxError) return NextResponse.json({ error: '风格组内容无效' }, { status: 400 });
  return NextResponse.json({ error: '风格组操作未确认，请重试' }, { status: 503 });
}
export async function GET(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  try {
    if (request.nextUrl.searchParams.get('mode') === 'status') return NextResponse.json(await studioStyleOperationStatus(user, request.nextUrl.searchParams.get('requestId')), { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
    if (request.nextUrl.searchParams.get('mode') === 'draft') return NextResponse.json({ draft: await studioStyleDraft(user, request.nextUrl.searchParams.get('id')) }, { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
    const selectedIds = request.nextUrl.searchParams.get('ids');
    if (selectedIds !== null) {
      const ids = parseStudioStyleIds(selectedIds ? selectedIds.split(',') : []);
      const groups = await Promise.all(ids.map(async id => {
        try { return await studioStyleDTO(user, await getStudioStyleGroup(user, id)); }
        catch (error) {
          if (error instanceof StudioStyleError && (error.status === 404 || error.status === 409)) {
            return { id, name: '风格组不可用', referenceCount: 0, canManage: false, coverUrl: null, unavailable: true };
          }
          throw error;
        }
      }));
      return NextResponse.json({ groups, nextCursor: null }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const params = request.nextUrl.searchParams;
    if (params.get('page') === '1') return NextResponse.json(await listStudioStyleGroupsPage(user, {
      cursor: params.get('cursor') || undefined, query: params.get('query') || undefined,
      scope: params.get('scope') || undefined,
      ...(params.has('keys') ? { keys: params.get('keys')?.split(',').filter(Boolean) || [] } : {}),
    }), { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
    return NextResponse.json(await listStudioStyleGroups(user, params.get('cursor') || undefined), { headers: { 'Cache-Control': 'no-store' } });
  }
  catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StudioStyleError('风格组内容无效');
    if (body.action === 'draft') return NextResponse.json({ draft: await studioStyleDraft(user, body.draftId, body) });
    const result = await saveStudioStyleGroup(user, body);
    if (result.operationState === 'conflict') return NextResponse.json({ error: '风格组已有新版本，当前草稿保留', operation: result }, { status: 409 });
    return NextResponse.json(result);
  } catch (error) { return failure(error); }
}
export const PUT = POST;
export async function DELETE(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  try {
    const body = await request.json();
    const result = await deleteStudioStyleGroup(user, String(body?.id || ''), body?.revision, body?.requestId);
    if (result.state === 'conflict') return NextResponse.json({ error: '风格组已有新版本，未删除', operation: result }, { status: 409 });
    return NextResponse.json({ deleted: true });
  } catch (error) { return failure(error); }
}
