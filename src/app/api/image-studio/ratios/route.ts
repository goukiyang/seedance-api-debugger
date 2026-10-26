import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { changeStudioRatio, listStudioRatios } from '@/lib/image-studio/ratio-preferences';
import { normalizeStudioRatio } from '@/lib/image-studio/ratios';

export const dynamic = 'force-dynamic';
export async function GET() {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  try { return NextResponse.json({ ratios: await listStudioRatios(user.id) }, { headers: { 'Cache-Control': 'no-store' } }); }
  catch { return NextResponse.json({ error: '比例读取失败，请重试' }, { status: 503 }); }
}
async function change(request: NextRequest, remove: boolean) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  let ratio: string;
  try { ratio = normalizeStudioRatio((await request.json()).ratio); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : '比例无效' }, { status: 400 }); }
  try { return NextResponse.json({ ratios: await changeStudioRatio(user.id, ratio, remove) }); }
  catch (error) {
    const message = error instanceof Error ? error.message : '';
    const expected = message.startsWith('最多保存') || message === '常用比例不能删除';
    return NextResponse.json({ error: expected ? message : '比例未保存，请重试' }, { status: expected ? 400 : 503 });
  }
}
export const POST = (request: NextRequest) => change(request, false);
export const DELETE = (request: NextRequest) => change(request, true);
