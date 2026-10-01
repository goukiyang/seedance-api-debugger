import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { deleteStudioStyleGroup, listStudioStyleGroups, saveStudioStyleGroup, StudioStyleError } from '@/lib/image-studio/style-groups';

export const dynamic = 'force-dynamic';
function failure(error: unknown) {
  if (error instanceof StudioStyleError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof SyntaxError) return NextResponse.json({ error: '风格组内容无效' }, { status: 400 });
  return NextResponse.json({ error: '风格组操作未确认，请重试' }, { status: 503 });
}
export async function GET(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  try { return NextResponse.json(await listStudioStyleGroups(user, request.nextUrl.searchParams.get('cursor') || undefined), { headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StudioStyleError('风格组内容无效');
    return NextResponse.json(await saveStudioStyleGroup(user, body));
  } catch (error) { return failure(error); }
}
export const PUT = POST;
export async function DELETE(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  try {
    const body = await request.json();
    await deleteStudioStyleGroup(user, String(body?.id || ''), body?.revision);
    return NextResponse.json({ deleted: true });
  } catch (error) { return failure(error); }
}
